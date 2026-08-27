/**
 * verifier.js — Dispatches verifier agent sessions.
 *
 * The verifier agent runs independently of the executor. It inspects the
 * code changes, compares against the task's verify.json (hardChecks +
 * testCases) and any available standards file, and returns a structured
 * verdict via the Agent SDK's jsonSchema contract (see
 * agents/_schemas.js → verifierSchema).
 *
 * The structured output is written to
 * .harness/verification/task-{id}.json as the source of truth. JS-side
 * consumers (pipeline.js, audit.js, regression.js) read the JSON
 * directly — no more prose `**Result:** PASSED` regex matching.
 *
 * Verifier agents do NOT modify state directly. The hard guarantee is
 * state-machine.js's caller gate on the `verified` transition; the tool
 * scope excludes Edit/Write but INCLUDES Bash, whose write ability (sed -i,
 * redirection) is constrained by prompt rules only — not enforced.
 *
 * Public API:
 *   verifyTask(task, projectRoot, context?)
 *     → { verified: boolean, report: string, reportPath: string, structured }
 *
 *   extractVerdict(sdkResult, taskId, harnessDir)  // pure, unit-testable
 *     → { verified, structured, report, reportPath }
 */
import fs from 'fs';
import path from 'path';
import config from '../infra/config.js';
import { verifierSchema, regressionVerifierSchema, verifierContextSchema, extractStructured, validateStructured } from './_schemas.js';
import { SidecarReuseError } from '../core/sidecar-reuse-error.js';
import { activeHarnessDir, harnessRoot } from '../core/run-context.js';
import { captureTrackedSnapshot, auditTrackedDeletions } from '../infra/read-only-audit.js';
import { appendWarnings } from '../core/warnings-ledger.js';

/**
 * Decide whether a single taskScopeCheck is a "whole-suite" check — i.e. the
 * AI self-generated a check that runs the project's full test suite (or smoke
 * test) rather than a task-scoped command.
 *
 * Detection is a SUBSTRING (contains) test on the AI's free-form text: a check
 * is whole-suite iff its `description` OR `evidence` CONTAINS the configured
 * `config.execution.testAllCommand` (the distinctive whole-suite command, e.g.
 * `npm run test:all`). This is deliberately NOT the exact-match
 * `isWholeSuiteCommand(command, config)` used elsewhere — that helper compares a
 * structured `command` field for equality, whereas a taskScopeCheck's
 * `description`/`evidence` embed the literal command inside prose ("ran `npm run
 * test:all`, 3 suites red"), so equality never matches and a contains-test is
 * required.
 *
 * The short `config.execution.testCommand` ('npm test') is deliberately NOT
 * matched: as a bare substring it false-positives on per-task / negated prose
 * that merely contains 'npm test' ('npm test:unit failed', 'npm test-integration
 * is red', 'npm testHarness wrapper broke', 'npm test was NOT run'). Matching
 * only the distinctive testAllCommand rejects all of those by construction while
 * a genuine whole-suite reference still matches.
 *
 * Config is sourced (not hardcoded): a project with a non-default
 * testAllCommand is honored. Defensive: a null/undefined check, missing config,
 * or missing config.execution → false; an empty/blank/missing testAllCommand →
 * false so an unset command can never match every check.
 *
 * @param {{description?: string, evidence?: string}} check - one taskScopeCheck
 * @param {object} cfg - orchestrator config (uses cfg.execution.testAllCommand)
 * @returns {boolean}
 */
export function taskScopeCheckIsWholeSuite(check, cfg) {
  if (!check || typeof check !== 'object') return false;
  if (!cfg || !cfg.execution) return false;
  const { testAllCommand } = cfg.execution;
  if (typeof testAllCommand !== 'string' || testAllCommand.trim().length === 0) return false;
  const haystack = `${check.description || ''}\n${check.evidence || ''}`;
  return haystack.includes(testAllCommand);
}

/**
 * Extract a verdict from an SDK result. Pure function — no session I/O.
 * Writes the JSON sidecar as a side effect so callers don't have to.
 *
 * Return shape stays backwards-compatible with the previous verifier:
 *   { verified, structured, report, reportPath }
 * where `report` is a pretty-printed JSON string (consumed by
 * regression.js for failure messages) and `reportPath` is the .json
 * sidecar path.
 *
 * Invariants:
 *   back_reference_check is preserved verbatim in the returned structured
 *   object when the SDK supplies it, and never synthesized when absent
 *   (stub objects omit the field entirely).
 */
export function extractVerdict(sdkResult, taskId, harnessDir, opts = {}) {
  const { firstWrite = false } = opts;
  const warn = opts.warn ?? console.warn;
  const log = opts.log ?? console.log;
  const cfg = opts.config ?? config;
  const sidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  if (firstWrite && fs.existsSync(sidecarPath)) { throw new SidecarReuseError(taskId, sidecarPath); }

  const structured = extractStructured(sdkResult, { warn });

  if (structured) {
    const validation = validateStructured(structured, verifierSchema);
    if (!validation.ok) {
      warn(
        `[verifier] task ${taskId}: structured_output validation failed — ${validation.errors.join('; ')}`
      );
      // Validation failure is conservative: treat as FAILED. A schema-invalid
      // verdict is unverifiable, so it MUST NOT carry result:'PASSED' to any
      // downstream consumer — structuredVerdictPassed / the regression soft-pass
      // key on structured.result and would otherwise resurrect a rejected
      // verdict as a pass (false-green). Force result to 'FAILED' on a shallow
      // copy (never mutate the shared model object) and persist THAT, so the
      // on-disk sidecar SoT, the returned verdict, and `verified` all agree.
      // The rest of the model output is preserved for human debugging.
      const failedStructured = { ...structured, result: 'FAILED' };
      fs.writeFileSync(sidecarPath, JSON.stringify(failedStructured, null, 2));
      return {
        verified: false,
        structured: failedStructured,
        report: JSON.stringify(failedStructured, null, 2),
        reportPath: sidecarPath,
        // Schema-malformation is a small-model formatting failure; the caller
        // uses this flag to escalate to a stronger model once before the
        // fail-close stands.
        schemaInvalid: true,
      };
    }

    let verified = structured.result === 'PASSED';

    // Output-side enforcement: whole-suite taskScopeChecks must not, by
    // themselves, fail a task. The AI verifier sometimes self-generates a
    // taskScopeCheck that runs the project's full suite (e.g. `npm run
    // test:all`); when a sibling mission hasn't run yet that suite is RED, and
    // the AI marks the check FAIL and the verdict FAILED. But whole-suite-green
    // is a FINAL-gate concern (runFinalTestGate runs it once at the end), not a
    // per-task one. So: if the verdict is FAILED but EVERY FAIL-status
    // taskScopeCheck is whole-suite (zero non-whole-suite FAIL taskScopeChecks),
    // rescue to PASSED, deferring the whole-suite signal to the integration
    // gate. Any non-whole-suite FAIL taskScopeCheck keeps the task FAILED — we
    // do not over-rescue. The deterministic hardCheck gate is a separate path
    // (pipeline.js _applyHardCheckGate) and is untouched here.
    //
    // SCOPE: the rescue fires only when opts.deferWholeSuite === true. The
    // mission/milestone regression gates feed synthetic `regression-*` task ids
    // through this same extractVerdict, and there running the full suite IS the
    // gate's job — deferring its whole-suite FAIL would defeat the gate — so the
    // caller passes deferWholeSuite=false for regression-* ids.
    //
    // CONSISTENCY: when the rescue fires it ALSO rewrites the persisted sidecar's
    // result to 'PASSED' (below) so the on-disk SoT, the returned `verified`, the
    // post-hoc auditVerification gate (which HALTs on a COMPLETE task whose
    // sidecar result !== 'PASSED'), and _writeVerificationSummary all agree. The
    // deferral is recorded (deferredWholeSuiteChecks + a notes line) so the flip
    // is auditable, not silent.
    if (!verified && structured.result === 'FAILED' && opts.deferWholeSuite === true) {
      // A failed hardCheck must NEVER be rescued — only whole-suite taskScopeCheck
      // failures are deferred. The deterministic _applyHardCheckGate re-runs
      // verify.json hardChecks, but it is a no-op when verify.json declares none,
      // so the AI's self-reported hardCheck failures must be honored here too.
      const hardChecks = Array.isArray(structured.hardChecks) ? structured.hardChecks : [];
      const hardCheckFails = hardChecks.filter((c) => c && c.status === 'FAIL');
      const taskScopeChecks = Array.isArray(structured.taskScopeChecks) ? structured.taskScopeChecks : [];
      const failChecks = taskScopeChecks.filter((c) => c && c.status === 'FAIL');
      const wholeSuiteFails = failChecks.filter((c) => taskScopeCheckIsWholeSuite(c, cfg));
      // Single partition: rescue iff there is at least one whole-suite FAIL and
      // EVERY FAIL-status taskScopeCheck is whole-suite. wholeSuiteFails.length
      // === failChecks.length expresses "no non-whole-suite FAIL" without a
      // second filter pass; combined with > 0 it requires at least one fail.
      if (hardCheckFails.length === 0 && wholeSuiteFails.length > 0 && wholeSuiteFails.length === failChecks.length) {
        verified = true;
        // Rewrite the persisted result so the sidecar agrees with the returned
        // verdict and survives the post-hoc auditVerification gate.
        structured.result = 'PASSED';
        // Auditable record of the deferral — not a silent flip.
        structured.deferredWholeSuiteChecks = wholeSuiteFails;
        const deferralNote = `[verifier] ${wholeSuiteFails.length} whole-suite taskScopeCheck(s) FAILED — deferred to the final integration gate (runFinalTestGate); task PASSED.`;
        structured.notes = structured.notes
          ? `${structured.notes}\n${deferralNote}`
          : deferralNote;
        log(
          `[verifier] task ${taskId}: ${wholeSuiteFails.length} whole-suite taskScopeCheck(s) `
          + `failed — deferred to the final integration gate; task PASSED`
        );
      }
    }

    fs.writeFileSync(sidecarPath, JSON.stringify(structured, null, 2));
    return {
      verified,
      structured,
      report: JSON.stringify(structured, null, 2),
      reportPath: sidecarPath,
    };
  }

  // No structured_output received from SDK — conservative FAILED.
  warn(
    `[verifier] task ${taskId}: no structured_output received from SDK — returning FAILED`
  );

  const stub = {
    result: 'FAILED',
    hardChecks: [],
    taskScopeChecks: [],
    notes: '[stub] No structured_output from verifier session.',
    isStub: true,
  };
  fs.writeFileSync(sidecarPath, JSON.stringify(stub, null, 2));

  return {
    verified: false,
    isStub: true,
    structured: stub,
    report: JSON.stringify(stub, null, 2),
    reportPath: sidecarPath,
  };
}

class Verifier {
  constructor(sessionManager, logger, tokenTracker) {
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.tokenTracker = tokenTracker;
  }

  /**
   * Verify a single task's executor output against verify.json, standards, and spec.
   *
   * @param {object} task - The task descriptor (id, description, targetFiles, …).
   * @param {string} projectRoot - Absolute path to the project root.
   * @param {object} [context={}] - Caller-supplied verification context.
   * @param {string} context.specPath - Required. Absolute path to the spec file that
   *   motivated this task. The verifier MUST consult the spec to produce a
   *   meaningful back_reference_check. Design principle: callers control outputs,
   *   not inputs — the verifier must never silently degrade when specPath is
   *   missing ('control outputs, not inputs' anchor). If specPath is absent or
   *   the file does not exist, verifyTask throws rather than soft-falling back.
   * @param {string} [context.standardsPath] - Optional override for the standards file.
   * @param {string} [context.purpose] - Optional human-readable purpose label.
   * @param {boolean} [context.firstWrite] - If true, throw SidecarReuseError when the
   *   verification sidecar already exists.
   * @param {boolean} [context.redundancyProbe] - If true, indicates this verification
   *   run is a redundancy probe.
   * @param {string[]} [context.foreignPendingFiles] - Optional list of file paths that
   *   belong to sibling missions that have not completed yet. When a non-empty array of
   *   strings is given, a FOREIGN-PENDING-FILES section is added to the prompt telling
   *   the verifier not to run those files and that a failing result from them is not
   *   grounds for failure. Any other value (missing, non-array, non-string entries) is
   *   ignored fail-soft and yields no such section.
   * @returns {Promise<{ verified: boolean, report: string, reportPath: string, structured: object }>}
   * @throws {Error} If context.specPath is missing, empty, or the file does not exist.
   */
  async verifyTask(task, projectRoot, context = {}) {
    // Read-only deletion-guard window: a single before/after snapshot spans
    // BOTH the primary spawn and (when it fires) the escalation spawn inside
    // _runVerificationSession, since they share one delegated call below.
    // verifyRegression and _runVerificationSession itself stay unwired —
    // only this method opens an audit window. Every step here is fail-soft
    // by construction (see _auditReadOnlyDeletions): it can never cause
    // verifyTask to throw/reject, and it never touches the verdict.
    let snapshot = null;
    try {
      snapshot = captureTrackedSnapshot(projectRoot);
    } catch {
      // captureTrackedSnapshot is documented fail-soft (never throws), but
      // this catch is a defensive backstop so a future change there can
      // never turn into a verifyTask rejection.
    }

    try {
      return await this._runVerificationSession(task, projectRoot, context, {
        jsonSchema: verifierSchema,
        deferWholeSuite: true,
        allowEscalation: true,
        includeFindingsPrompt: false,
        runSpecReadAudit: true,
        redundancyProbe: Boolean(context.redundancyProbe),
      });
    } finally {
      // Runs exactly once, after the delegated call settles (success OR
      // throw) — a `finally` block always runs and never suppresses or
      // replaces the original outcome.
      this._auditReadOnlyDeletions(task, projectRoot, snapshot);
    }
  }

  /**
   * Fail-soft read-only deletion audit: compares `snapshot` (captured before
   * the verification session ran) against the tree's current state, restores
   * any tracked file that vanished (unless it belongs to a still-in-flight
   * mission's declared targetFiles, in which case it is report-only), and —
   * when the resulting report is non-empty — logs loudly and appends exactly
   * one ledger entry naming this incident.
   *
   * Never throws: every fallible step (the audit call itself, the loud warn,
   * and the ledger append) is individually guarded, and the whole method is
   * wrapped in a final backstop try/catch, so a broken logger.warn or a
   * failing appendWarnings can never turn into a verifyTask rejection.
   *
   * @param {object} task
   * @param {string} projectRoot
   * @param {*} snapshot - result of `captureTrackedSnapshot(projectRoot)`, or
   *   null if that capture itself failed.
   */
  _auditReadOnlyDeletions(task, projectRoot, snapshot) {
    try {
      let report;
      try {
        report = auditTrackedDeletions(projectRoot, snapshot, { onLog: (msg) => this.logger.warn(msg) });
      } catch (err) {
        try { this.logger.warn(`[verifier] task ${task.id}: read-only deletion audit failed: ${err.message}`); } catch { /* fail-soft */ }
        return;
      }

      const deleted = Array.isArray(report && report.deleted) ? report.deleted : [];
      if (deleted.length === 0) return;

      const restored = Array.isArray(report.restored) ? report.restored : [];
      const reportOnly = Array.isArray(report.reportOnly) ? report.reportOnly : [];
      const restoredPaths = restored.map((r) => (r && typeof r.path === 'string') ? r.path : String(r));

      const description = `[verifier] task ${task.id}: read-only audit detected tracked-file deletion(s) during verification — restored: [${restoredPaths.join(', ')}], report-only (in-flight targetFiles, left as-is): [${reportOnly.join(', ')}]`;

      try {
        this.logger.warn(`[verifier] READ-ONLY AUDIT ALERT — ${description}`);
      } catch { /* fail-soft: a throwing logger must never abort the audit */ }

      try {
        appendWarnings(projectRoot, [{
          severity: 'warning',
          category: 'read-only-audit-deletion',
          description,
        }]);
      } catch (err) {
        try { this.logger.warn(`[verifier] task ${task.id}: failed to append read-only-audit ledger entry: ${err.message}`); } catch { /* fail-soft */ }
      }
    } catch {
      // Absolute backstop: the read-only audit must never affect verifyTask's
      // outcome (return value or thrown/rejected error).
    }
  }

  /**
   * Verify a regression-gate task (mission/milestone regression check — see
   * gates/regression.js verifyMission/verifyMilestone).
   *
   * Carries the regression-specific facts as inherent CONFIG rather than
   * sniffing `task.id.startsWith('regression-')`:
   *   - whole-suite verdict deferral is OFF (running the full suite IS this
   *     gate's job — deferring its whole-suite FAIL would defeat the gate)
   *   - escalation to a stronger model on a schema-invalid/stub verdict is ON
   *     (flipped 2026-07-14: the original "conservative fail-close is cheaper
   *     than a costly full re-run" rationale was empirically inverted — a
   *     systematic small-model schema flub at this gate produced a FALSE
   *     regression FAILED on a green milestone, and the fail-close bought an
   *     analyzer + remediation-planner + executor churn plus a breaker halt,
   *     all costlier than the single stronger-model re-run)
   *   - jsonSchema is regressionVerifierSchema (findings-extended) so the
   *     remediation path receives structured {file, description} entries
   *   - the regression-findings prompt paragraph is always included so the AI
   *     populates the `findings` array
   *   - the spec-read audit is skipped (as it was for regression-* ids before)
   *
   * @param {object} task - The synthetic regression task descriptor.
   * @param {string} projectRoot - Absolute path to the project root.
   * @param {object} [context={}] - Caller-supplied verification context.
   * @returns {Promise<{ verified: boolean, report: string, reportPath: string, structured: object }>}
   */
  async verifyRegression(task, projectRoot, context = {}) {
    return this._runVerificationSession(task, projectRoot, context, {
      jsonSchema: regressionVerifierSchema,
      deferWholeSuite: false,
      allowEscalation: true,
      includeFindingsPrompt: true,
      runSpecReadAudit: false,
      redundancyProbe: false,
    });
  }

  /**
   * Shared session-run body for verifyTask and verifyRegression. `opts` carries
   * the caller's regression-vs-real-task facts as inherent config:
   *   - opts.jsonSchema           — schema attached to the spawn
   *   - opts.deferWholeSuite      — passed through to extractVerdict
   *   - opts.allowEscalation      — whether the second stronger-model spawn runs
   *   - opts.includeFindingsPrompt — whether the findings prompt paragraph is included
   *   - opts.runSpecReadAudit     — whether the spec-read audit patch runs
   *   - opts.redundancyProbe      — whether this verification run is a redundancy probe
   *
   * @throws {Error} If context.specPath is missing, empty, or the file does not exist.
   */
  async _runVerificationSession(task, projectRoot, context, opts) {
    if (!context.specPath || typeof context.specPath !== 'string' || context.specPath.length === 0) {
      throw new Error('verifyTask: context.specPath is required and must be a non-empty string');
    }

    const harnessDir = activeHarnessDir(projectRoot);
    const verifyJsonPath = path.join(harnessDir, 'verify', `task-${task.id}.json`);
    const standardsPath = context.standardsPath
      || path.join(harnessRoot(projectRoot), 'standards-core.md');

    const hasStandards = fs.existsSync(standardsPath);

    const specPath = context.specPath;
    if (!specPath || !fs.existsSync(specPath)) {
      throw new Error('verifyTask: specPath file does not exist: ' + specPath);
    }
    // specPath existence is guaranteed past this point — the prompt below
    // never needs a "no spec" branch.

    // Compact, task-relevant spec context injected by the pipeline (the spec.json
    // goal + the acceptance_criteria relevant to THIS task). When non-empty, a
    // "Spec back-reference" block is inserted into the prompt and the back-
    // reference step compares against THESE criteria (full spec at specPath as a
    // fallback). When empty (generic infra tasks), the prompt is byte-identical
    // to today — no block, original back-reference instruction.
    const specGoal = typeof context.specGoal === 'string' ? context.specGoal : '';
    const relevantCriteria = Array.isArray(context.relevantCriteria) ? context.relevantCriteria : [];
    const hasInjectedSpecContext = relevantCriteria.length > 0;

    const specBackReferenceBlock = hasInjectedSpecContext
      ? `\nSpec back-reference (relevant to this task):
Goal: ${specGoal}
Relevant acceptance criteria:
${relevantCriteria.map(c => `- ${c.description}`).join('\n')}\n`
      : '';

    // Foreign-pending-files: paths belonging to sibling missions that have not
    // completed yet (e.g. a shared file this task references but does not own).
    // Normalized fail-soft: only an array yields entries, and only non-empty
    // string entries survive — any other value (missing key, non-array, etc.)
    // yields an empty list and the block below is the empty string, keeping the
    // prompt byte-identical to today for every current caller (none pass this key).
    const foreignPendingFiles = Array.isArray(context.foreignPendingFiles)
      ? context.foreignPendingFiles.filter((f) => typeof f === 'string' && f.length > 0)
      : [];

    const foreignPendingFilesBlock = foreignPendingFiles.length === 0
      ? ''
      : `\nFOREIGN-PENDING-FILES:
The following paths belong to missions that have NOT completed yet. Do NOT run them, and a failing/red result from them is NOT grounds for failure:
${foreignPendingFiles.map((f) => `- ${f}`).join('\n')}\n`;

    // Rules-list companion line for the block above — conditional on the same
    // normalized list so an empty/absent/non-array foreignPendingFiles produces
    // a prompt with no 'FOREIGN-PENDING-FILES' substring anywhere (byte-identical
    // to today for every current caller).
    const foreignPendingFilesRuleLine = foreignPendingFiles.length === 0
      ? ''
      : '\n- Files named in the FOREIGN-PENDING-FILES section must not be run, and a failing result from them is not grounds for failure.';

    const prompt = `Verify task ${task.id}.

Verify file: ${verifyJsonPath}
${hasStandards ? `Standards: ${standardsPath}` : 'No standards file — skip soft verification.'}
Spec: ${specPath}
Task-scope: { description: "${task.description}", targetFiles: [${(task.targetFiles || []).map(f => `"${f}"`).join(', ')}], purpose: "${context.purpose || task.description}" }
${specBackReferenceBlock}${foreignPendingFilesBlock}
Steps:
1. Read the verify.json file — note the hardChecks and testCases.
2. Run each hardCheck command in ${projectRoot} and confirm it passes.
3. Inspect the files in targetFiles and confirm they match the task description.
4. Check that test cases from verify.json are covered by real tests.
5. ${hasStandards ? `Check the changed code against the standards at ${standardsPath}.` : 'Skip soft verification (no standards file).'}
6. ${hasInjectedSpecContext ? `Compare what this task actually did against the relevant acceptance criteria listed above (the full spec at ${specPath} is available as a fallback if you need more).` : `Read the spec at ${specPath} and compare what this task actually did against the spec section that motivated it.`}
7. Populate back_reference_check with spec_consulted (boolean), plan_consulted (boolean), and deviations (array, possibly empty) of {kind, description, evidence}. The kind enum is: spec_mismatch | plan_contradiction | missing_constraint | undefined_composition.
8. Return your verdict as the session's structured output.
${opts.includeFindingsPrompt ? `
Regression findings (this is a regression gate task): additionally populate the \`findings\` array in the structured output. For each FAILING check, attribute the failure to the concrete file(s) responsible and emit { file, description, evidence, relatedFiles }. If a failure cannot be attributed to a specific file, emit the finding with file "unknown" and describe in the description what should be searched for. If nothing fails, return an empty findings array. Name only files that actually exist in the project — never invent a path. Exception: if a REQUIRED file is MISSING, the finding SHOULD name that file's intended path — naming the expected path of a required-but-absent file is evidence, not invention.
` : ''}${opts.redundancyProbe ? `
Redundancy probe (this is a redundancy probe run): additionally populate the \`redundancyCitations\` array in the structured output with one { claim, file, pattern } entry per deliverable of this task, citing where each deliverable already exists. \`claim\` is a short statement of what the deliverable is. \`file\` MUST be a project-root-relative path to the file where that deliverable already exists. \`pattern\` MUST be literal text quoted verbatim from that file — copy the exact characters that appear in the file; \`pattern\` is NEVER a regular expression.
` : ''}

Your session has a JSON schema attached — return the final verdict as the session's structured output matching that schema exactly.

Rules:
- result must be "PASSED" only if every hardCheck and taskScopeCheck passes
${/* NOTE: the whole-suite prompt rule below is a non-load-bearing token
   optimization — it merely asks the AI not to self-run the full suite. Real
   enforcement that a whole-suite FAIL cannot fail a per-task verdict lives in
   the verdict override (extractVerdict above) plus the final test gate
   (runFinalTestGate); this rule only nudges the prompt and is safe to ignore. */''}- Whole-suite / full test-suite commands (the project's test / test:all command) are run once by the final integration gate after the whole run completes. Do NOT run them yourself and do NOT add them as a taskScopeCheck or fail this task on them — sibling missions may not have run yet.
- Any acceptance criterion whose target file is listed in the prompt's pending-deliverables block (the PENDING-DELIVERABLES section, when present in the purpose/context) must NOT be judged at this gate — its absence is expected and is not grounds for failure.${foreignPendingFilesRuleLine}
- Judge PASS/FAIL ONLY against the declared hardChecks, the listed acceptance criteria, and (for milestone regression) the stated milestone goal. Do NOT run extra investigative commands such as git (git status / git log / git ls-files), and do NOT invent acceptance criteria of your own. The project's git commit for this work happens AFTER verification, so uncommitted/untracked files (git status '??') are EXPECTED at this step and are NEVER grounds for failure.
- Do NOT author a hardCheck or taskScopeCheck that asserts modification status or tree cleanliness — for example, an "only X was modified" assertion, a "no other files changed" assertion, or a git-status/git-diff cleanliness check. Tree state (which files are modified, staged, or untracked) is outside this verification's scope and cannot be verified in this session. Judge only the content and behavior of the mission's own files.
- If hardChecks fail, set result to "FAILED" immediately; standardsChecks may be empty
- If no standards file exists, leave standardsChecks as []
- back_reference_check is REQUIRED — if you did not consult the spec or plan, set spec_consulted / plan_consulted to false explicitly. Honest non-consultation is allowed; omitting the field is not.
- Do NOT write any files — your output is the structured verdict only
- Do NOT modify state files or business code`;

    const systemPrompt = `You are a Harness Verifier. Your ONLY job is to verify the executor's output and return a structured verdict.

Rules:
- Re-run hard verification independently (do NOT trust executor's self-report)
- Check code against standards if a standards file exists
- Return your verdict as a structured JSON object matching the session's jsonSchema
- Do NOT write or modify business code
- Do NOT write report files — the orchestrator persists the structured output
- Do NOT update state.json or any harness state file
- If hard verification fails, mark FAILED immediately (skip soft verification)
- Be objective: non-compliance is non-compliance, report it`;

    const log = this.logger.createSessionLog(`verifier-${task.id}`);
    // The escalation path (below) runs a second verifier session on a stronger
    // model under its own log/name; sessionName + sessionLog track which session
    // the end-of-function ledger entry describes, and escLog is closed in finally.
    let escLog = null;
    let sessionName = `verifier-${task.id}`;
    let sessionLog = log;
    // Set when escalation fails: attempt 1 was already recorded inline, so the
    // end-of-function ledger write must not run again.
    let skipEndRecord = false;

    try {
      const spawnPromise = this.sessionManager.spawn({
        name: `verifier-${task.id}`,
        prompt,
        systemPrompt,
        model: config.execution.verifierModel,
        agent: 'verifier',
        tools: config.tools.verifier,
        // Structural halves of the prompt's git prohibition (verified
        // 2026-08-20): history/status reads invite the HEAD-as-baseline
        // false-FAILED; removal is never a judging role's business.
        denyGitReadsBash: true,
        denyFileRemovalBash: true,
        // Mirrors the prompt's FOREIGN-PENDING-FILES section (see
        // foreignPendingFiles above): the normalized list is forwarded so the
        // spawn can enforce it at the tool layer too, and the deny flag is only
        // truthy when that list is non-empty — an absent/empty list keeps
        // today's behavior byte-identical for every current caller.
        foreignPendingFiles,
        denyForeignPendingBash: foreignPendingFiles.length > 0,
        // regression-gate callers (verifyRegression) carry the findings-extended
        // schema so the remediation path receives structured {file, description}
        // entries. The escalation spawn below re-uses the same opts.jsonSchema,
        // so an escalated regression verdict keeps the findings-extended shape.
        jsonSchema: opts.jsonSchema,
        maxBudget: config.budgets.verifier,
        cwd: projectRoot,
      });

      this.logger.attachToSession(spawnPromise.handle, log, {
        role: 'verifier',
        taskId: task.id,
      });

      let { handle, result: sdkResult } = await spawnPromise;

      // The whole-suite verdict deferral is a PER-TASK rescue. Regression-gate
      // callers (verifyRegression) ARE the mission/milestone regression gate
      // itself — running the full suite IS that gate's job — so the rescue must
      // NOT fire for them. verifyTask defers (opts.deferWholeSuite === true);
      // verifyRegression doesn't (opts.deferWholeSuite === false).
      const deferWholeSuite = opts.deferWholeSuite;

      let verdict = extractVerdict(sdkResult, task.id, harnessDir, { warn: (msg) => this.logger.warn(msg), log: (msg) => this.logger.warn(msg), config, firstWrite: context.firstWrite, deferWholeSuite });

      // A schema-invalid or empty (no structured_output) verdict is a small-model
      // formatting failure, not a real verification failure. Escalate to a
      // stronger model exactly once — for regression-gate callers too (enabled
      // 2026-07-14: a systematic schema flub at the gate previously fail-closed
      // into a false regression FAILED and a remediation-churn + breaker halt,
      // costlier than this single re-run). The sidecar already exists from
      // attempt 1, so firstWrite is false on retry; if the escalated verdict is
      // still bad, the fail-close stands.
      const shouldEscalate = opts.allowEscalation
        && (verdict.schemaInvalid === true || verdict.isStub === true);
      if (shouldEscalate) {
        // Record attempt 1's session before the escalation reuses the ledger, so
        // the first model's tokens/cost are neither dropped nor conflated with
        // the escalated session's.
        const firstSummary = this.logger.getSessionSummary(log.logPath);
        await this.logger.writeSessionSummary(`verifier-${task.id}`, firstSummary, {
          role: 'verifier',
          taskId: task.id,
          verified: verdict.verified,
        });
        await this.tokenTracker?.recordSession(`verifier-${task.id}`, 'verifier', sdkResult, {
          taskId: task.id,
          verified: verdict.verified,
          systemPromptTokens: handle.systemPromptTokens,
          toolCallCount: handle._toolCallCount,
        });

        const reason = verdict.isStub === true ? 'no structured output' : 'schema-invalid verdict';
        this.logger.warn(`[verifier] task ${task.id}: ${reason} — escalating to ${config.execution.verifierEscalationModel}`);

        // Only the spawn+await is fallible-and-recoverable: a spawn failure
        // (budget/transport/auth) degrades to attempt 1's already-recorded
        // fail-closed verdict. extractVerdict on the escalated result runs
        // OUTSIDE this try so a write error there propagates like the primary
        // path rather than being silently swallowed into a FAILED verdict; and
        // handle/sdkResult are reassigned only on a clean escalation, so the
        // spec-read audit below always describes the session it records.
        const escalationName = `verifier-${task.id}-escalated`;
        let escalated = null;
        try {
          escLog = this.logger.createSessionLog(escalationName);
          const escalationPromise = this.sessionManager.spawn({
            name: escalationName,
            prompt,
            systemPrompt,
            model: config.execution.verifierEscalationModel,
            agent: 'verifier',
            tools: config.tools.verifier,
            // Same structural denies as attempt 1 (see there).
            denyGitReadsBash: true,
            denyFileRemovalBash: true,
            // Same foreign-pending-files forwarding as attempt 1 (see there).
            foreignPendingFiles,
            denyForeignPendingBash: foreignPendingFiles.length > 0,
            // Same schema as attempt 1: per-task callers escalate under plain
            // verifierSchema, regression-gate callers under the findings-
            // extended regressionVerifierSchema the remediation path needs.
            jsonSchema: opts.jsonSchema,
            maxBudget: config.budgets.verifier,
            cwd: projectRoot,
          });
          this.logger.attachToSession(escalationPromise.handle, escLog, {
            role: 'verifier',
            taskId: task.id,
          });
          escalated = await escalationPromise;
        } catch (escErr) {
          // Spawn failed. Keep attempt 1's already-recorded fail-closed verdict
          // rather than aborting the run. The escalated session's in-flight usage
          // estimate is reconciled by session-manager when that spawn settles.
          this.logger.warn(`[verifier] task ${task.id}: escalation failed (${escErr.message}) — keeping attempt-1 verdict`);
          skipEndRecord = true;
        }
        if (escalated) {
          handle = escalated.handle;
          sdkResult = escalated.result;
          verdict = extractVerdict(sdkResult, task.id, harnessDir, { warn: (msg) => this.logger.warn(msg), log: (msg) => this.logger.warn(msg), config, firstWrite: false, deferWholeSuite });
          sessionName = escalationName;
          sessionLog = escLog;
        }
      }

      // Spec-read audit: record whether the verifier session actually read the spec file.
      const didReadSpec = Array.from(handle._readFiles || []).map(f => path.resolve(f)).includes(path.resolve(specPath));
      if (verdict.isStub === true || !opts.runSpecReadAudit) {
        // Gated: stub result or regression-gate caller — skip audit, return verdict as-is.
      } else {
        const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
        const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
        // spec_consulted reflects ONLY whether the session actually Read the
        // spec file — deliberately NOT OR'd with injection (47e0f0a: an
        // injected-but-not-read session has not verified against the full
        // spec, and the old OR made the audit field untrustworthy). Injection
        // is reported separately as spec_injected. Nothing gates on either.
        const specInjected = Array.isArray(context.relevantCriteria) && context.relevantCriteria.length > 0;
        const spec_consulted = didReadSpec;
        sidecar.specReadAudit = { didReadSpec, specPath };
        if (sidecar.back_reference_check && typeof sidecar.back_reference_check === 'object') {
          sidecar.back_reference_check.spec_consulted = spec_consulted;
          sidecar.back_reference_check.spec_injected = specInjected;
        }
        fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
        // Mirror the audit patch onto the in-memory verdict returned to the
        // pipeline so memory and the on-disk sidecar agree on spec_consulted
        // (the same value just written above) and carry the specReadAudit.
        // Without this, callers of the return value would see a different
        // spec_consulted than the disk SoT (latent divergence).
        if (verdict.structured && typeof verdict.structured === 'object') {
          verdict.structured.specReadAudit = { didReadSpec, specPath };
          if (verdict.structured.back_reference_check
              && typeof verdict.structured.back_reference_check === 'object') {
            verdict.structured.back_reference_check.spec_consulted = spec_consulted;
            verdict.structured.back_reference_check.spec_injected = specInjected;
          }
        }
        if (!spec_consulted) {
          this.logger.warn(`[verifier] task ${task.id}: specPath ${specPath} not read by verifier session${specInjected ? ' (compact spec context WAS injected into the prompt — expected on the injection path)' : ''}`);
        }
      }

      if (!skipEndRecord) {
        const summary = this.logger.getSessionSummary(sessionLog.logPath);
        await this.logger.writeSessionSummary(sessionName, summary, {
          role: 'verifier',
          taskId: task.id,
          verified: verdict.verified,
        });
        await this.tokenTracker?.recordSession(sessionName, 'verifier', sdkResult, {
          taskId: task.id,
          verified: verdict.verified,
          systemPromptTokens: handle.systemPromptTokens,
          toolCallCount: handle._toolCallCount,
        });
      }

      return verdict;
    } finally {
      log.close();
      if (escLog) escLog.close();
    }
  }
}

export { Verifier };
