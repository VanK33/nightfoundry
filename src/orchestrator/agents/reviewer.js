/**
 * reviewer.js — Dispatches reviewer agent sessions for milestone-level review.
 *
 * The reviewer runs after all tasks in a milestone are verified. It reads
 * the modified files as a whole, traces call chains across module boundaries,
 * checks cross-module contracts, and returns a structured verdict via the
 * Agent SDK's jsonSchema contract (see agents/_schemas.js → reviewerSchema).
 *
 * Key difference from verifier: the verifier checks individual task
 * correctness; the reviewer checks compositional correctness — "do these
 * pieces fit together correctly as a milestone?" It assumes each task is
 * individually correct and focuses on integration.
 *
 * The structured output is written to
 * .harness/verification/review-milestone-{id}.json as the source of truth.
 *
 * Reviewer agents do NOT modify files. The tool scope excludes Edit/Write
 * but INCLUDES Bash, whose write ability (sed -i, redirection) is
 * constrained by prompt rules only — not enforced.
 *
 * Public API:
 *   reviewMilestone(milestoneId, modifiedFiles, taskDescriptions, importGraph, projectRoot, harnessDir, scopeContext)
 *     scopeContext (optional, default {}):
 *       specGoal        {string}   — excerpt from the spec's goal section (truncated to 2048 chars in prompt)
 *       specScopeFiles  {string[]} — declared targetFiles across all tasks in the milestone
 *       exceededFiles   {string[]} — files modified but not in any task's declared targetFiles (JS-detected)
 *       uncoveredConsumers {string[]} — files that textually consume changed symbols but fall outside the spec's target_files (advisory blast-radius check)
 *     → { passed: boolean, findings, structured, reportPath }
 *
 *   extractReviewVerdict(sdkResult, milestoneId, harnessDir)  // writes sidecar as side effect
 *     → { passed, findings, structured, reportPath }
 */
import fs from 'fs';
import path from 'path';
import config from '../infra/config.js';
import { reviewerSchema, extractStructured, validateStructured } from './_schemas.js';

/**
 * isCleanPass(structured) — the single-sourced "clean pass" predicate.
 *
 * Returns true iff the structured verdict's result is 'PASSED' AND no finding
 * carries severity 'critical'. Missing / non-array `findings` is tolerated and
 * treated as no findings (matching the legacy `findings.some(...)` semantics,
 * which operated on the parsed array).
 *
 * This is the SINGLE source of truth for "is this milestone review a clean
 * pass?" — consumed by both extractReviewVerdict()'s pass computation below and
 * by the pipeline's batch review gate (pipeline._reviewGate). The two must
 * never drift, so neither side keeps a local copy.
 *
 * @param {object|null|undefined} structured - the reviewer verdict object
 * @returns {boolean}
 */
export function isCleanPass(structured) {
  const findings = Array.isArray(structured?.findings) ? structured.findings : [];
  const hasCritical = findings.some(f => f.severity === 'critical');
  return structured?.result === 'PASSED' && !hasCritical;
}

/**
 * Extract a review verdict from an SDK result. Writes JSON sidecar as side effect.
 * Writes the JSON sidecar as a side effect so callers don't have to.
 *
 * Return shape:
 *   { passed: boolean, findings: array, structured: object, reportPath: string }
 *
 * passed is false if:
 *   - result is 'FAILED', OR
 *   - any finding has severity 'critical'
 */
export function extractReviewVerdict(sdkResult, milestoneId, harnessDir, opts = {}) {
  const warn = opts.warn ?? console.warn;
  const sidecarPath = path.join(harnessDir, 'verification', `review-milestone-${milestoneId}.json`);
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });

  const structured = extractStructured(sdkResult, { warn });

  if (structured) {
    const validation = validateStructured(structured, reviewerSchema);
    if (!validation.ok) {
      warn(
        `[reviewer] milestone ${milestoneId}: structured_output validation failed — ${validation.errors.join('; ')}`
      );
      // Validation failure is conservative: treat as not passed, but persist
      // what we got so a human can debug.
      fs.writeFileSync(sidecarPath, JSON.stringify(structured, null, 2));
      const findings = Array.isArray(structured.findings) ? structured.findings : [];
      return {
        passed: false,
        findings,
        structured,
        reportPath: sidecarPath,
      };
    }

    fs.writeFileSync(sidecarPath, JSON.stringify(structured, null, 2));

    const findings = structured.findings || [];
    // Single-sourced predicate: the gate imports this same function, so the
    // reviewer's own pass computation and the gate can never drift.
    const passed = isCleanPass(structured);

    return {
      passed,
      findings,
      structured,
      reportPath: sidecarPath,
    };
  }

  // No structured_output received from SDK — conservative FAILED stub.
  warn(
    `[reviewer] milestone ${milestoneId}: no structured_output received from SDK — returning FAILED`
  );

  const stub = {
    result: 'FAILED',
    findings: [],
    notes: '[stub] No structured_output from reviewer session.',
    isStub: true,
  };
  fs.writeFileSync(sidecarPath, JSON.stringify(stub, null, 2));

  return {
    passed: false,
    findings: [],
    structured: stub,
    reportPath: sidecarPath,
  };
}

class Reviewer {
  constructor(sessionManager, logger, tokenTracker) {
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.tokenTracker = tokenTracker;
  }

  async reviewMilestone(milestoneId, modifiedFiles, taskDescriptions, importGraph, projectRoot, harnessDir, scopeContext = {}) {
    const { specGoal = '', specScopeFiles = [], exceededFiles = [], acceptanceCriteria = [], uncoveredConsumers = [] } = scopeContext;
    const fileList = (modifiedFiles || []).map(f => `  - ${f}`).join('\n') || '  (none)';
    const taskList = (taskDescriptions || [])
      .map((desc, i) => `  ${i + 1}. ${desc}`)
      .join('\n') || '  (none)';
    const graphSummary = importGraph
      ? `\nImport graph summary:\n${importGraph}`
      : '';

    // Acceptance-criteria review section (fail-soft): only emitted when the spec
    // actually carries criteria. When acceptanceCriteria is empty the section is
    // the empty string, so the prompt is byte-identical to the no-criteria path.
    const acceptanceCriteriaSection = acceptanceCriteria.length > 0 ? `
## Acceptance Criteria Review

The spec declares the following acceptance criteria for this milestone. Judge whether the milestone's modified files + task descriptions cover each criterion. List the description of any criterion you judge NOT covered in the 'uncoveredCriteria' verdict field (leave it empty / omit it when every criterion is covered).
${acceptanceCriteria.map((c, i) => {
  const desc = (c && typeof c.description === 'string') ? c.description : '';
  let line = `  ${i + 1}. ${desc}`;
  if (c && c.verification && c.verification.kind === 'command' && c.verification.command) {
    line += `\n     (verified by: ${c.verification.command})`;
  }
  return line;
}).join('\n')}
` : '';

    // Uncovered-consumers advisory section (fail-soft): only emitted when the
    // blast-radius stash actually carries entries. When uncoveredConsumers is
    // empty the section is the empty string, so the prompt is byte-identical
    // to the no-uncovered-consumers path.
    const uncoveredConsumersSection = uncoveredConsumers.length > 0 ? `
## Uncovered Consumers Advisory

The following files textually consume symbols changed in this milestone but fall outside the spec's declared target_files. This is advisory blast-radius context, not a confirmed defect — judge whether these files should have been in scope and flag any resulting issues as findings:
${uncoveredConsumers.map(f => `  - ${f}`).join('\n')}
` : '';

    const prompt = `Review milestone ${milestoneId}.

You are performing a milestone-level composition review. Assume each task is individually correct — do NOT re-verify individual task correctness. Focus exclusively on whether the tasks fit together correctly as an integrated milestone.

Tasks completed in this milestone:
${taskList}

Modified files:
${fileList}
${graphSummary}

Review steps:
1. Trace call chains across module boundaries — verify that callers and callees agree on function signatures, return shapes, and error contracts.
2. Check cross-module contracts — verify that imports/exports are consistent, that shared types/schemas are used correctly across files.
3. Check integration seams — verify that data flowing between modules has the expected shape at each boundary.
4. Flag any compositional issues as findings with the appropriate severity ('critical' for breakage, 'warning' for risk, 'info' for noteworthy but non-problematic observations).
5. If you write about a specific issue or observation in the 'notes' prose, that issue MUST also appear as a typed entry in 'findings'. Severity 'info' is acceptable for advisory-only observations. Free-text 'notes' may continue to hold cross-cutting commentary, but every concrete observation about a specific file / contract / behavior must have a structured counterpart in 'findings'.

Tier definitions (set 'tier' on every finding). Tier is a separate axis from category — it is not a 1:1 mapping. Pick the tier that best describes the finding's IMPACT level, then pick the category that best describes its SHAPE.
- 'composition' — affects how modules fit together (typically call-chain, integration, contract-mismatch, plan-coherence findings). High-leverage; must be dispositioned before archive in future workflow.
- 'behavioral' — affects runtime behavior (typically functional, behavioral-race, position-precision, scope-expansion findings). High-leverage; must be dispositioned before archive in future workflow.
- 'cosmetic' — STRICTLY naming, style, or comment-only observations. Applied independently of category — a 'functional' finding may be 'cosmetic' tier if its impact is naming/style only. A finding that describes wrong behavior under ANY reachable configuration is NOT cosmetic: tier it 'behavioral' or 'composition' and set its severity to at least 'warning', even if no consumer triggers it today — latent is not cosmetic.

Disposition: set 'disposition' to 'pending' on every newly emitted finding (the reviewer never auto-dispositions — that is a downstream pipeline / human step). 'dispositionReason' is left empty when disposition is 'pending'. When a downstream consumer later sets disposition to a non-pending value ('accepted-with-followup' / 'fixed' / 'dismissed'), the rationale for that choice is recorded in 'dispositionReason' — but the reviewer itself does not populate either of those fields.

Category definitions (pick the one that best matches the issue you are reporting):
- 'call-chain' — caller and callee disagree on function signature, return shape, or error handling across file boundaries.
- 'integration' — imports / exports / module-boundary wiring is inconsistent or breaks at runtime.
- 'functional' — behavior of the composed system does not match the spec intent.
- 'plan-coherence' — sibling tasks in the same plan assert incompatible facts (type, shape, ordering).
- 'position-precision' — a positional ordering or location requirement (e.g. an entry must come immediately after another in a config or manifest file) is violated.
- 'behavioral-race' — timing-sensitive code that passes today but is race-prone (e.g. event setup before awaiting a 'listening' signal).
- 'scope-expansion' — executor created files or exports not declared by the spec or task scopes (potentially orphan tests, undocumented exports).
- 'contract-mismatch' — declared type or shape of a value does not match how it is consumed in another module.

Known composition-leak patterns to actively investigate. Apply these as a checklist — for each pattern, look for the named shape in the diff; if you find it, emit a typed finding with the suggested category.
- schema-consumer drift — when a schema enum is widened, hunt for hard-coded filters on the old enum values (typical loci: report renderers, pipeline gate logic, dashboards). Use category 'integration'.
- cross-file type contract — when one module reads JSON written by another, confirm both sides agree on field types. Pay special attention to fields hashed for identity. Use category 'contract-mismatch'.
- inner required missing — when the spec text declares an inner 'required' array for a nested schema object, confirm the schema actually declares it. Use category 'contract-mismatch'.
- prompt-schema bidirectional consistency — schema declares field then prompt teaches how to populate it; prompt mentions field then schema declares it. Either direction failing is a finding. Use category 'integration'.
- enum-mapping coverage — if the prompt maps enum-A values to enum-B labels (e.g. category to tier), confirm every value of enum-A has a documented mapping to enum-B, AND every enum-B value has at least one path to be emitted. Use category 'plan-coherence'.
- behavioral rule enforceability — if the prompt or spec introduces a rule of the form 'X must hold', confirm a test exists that would catch violations. A rule with only schema validation behind it is a wish, not a contract. Use category 'behavioral-race' for timing rules, 'functional' for behavior rules.
- file-written then archive-allowlist coupling — when code writes a new file under .harness/, confirm the archive module's moveHarnessToArchive allowlist includes the new path. Otherwise the file is orphaned at archive time. Use category 'integration'.
- test isolation vs integration — when a test exercises a module's own contract but no test exercises the cross-module boundary (e.g. spec mentions 'X must end up in archive directory' but no test verifies post-archive state), flag it. Use category 'integration'.

Prompt guidance:
- Assume each task individually correct, focus on composition
- Trace call chains: follow data from producer to consumer across file boundaries
- Check cross-module contracts: do callers pass what callees expect?
${(specGoal || exceededFiles.length > 0) ? `
## Scope review

Spec goal (truncated to 2048 chars):
${specGoal.slice(0, 2048)}

Declared targetFiles for this milestone:
${specScopeFiles.length > 0 ? specScopeFiles.map(f => `  - ${f}`).join('\n') : '  (none)'}

The harness detected these files were modified but are not in any task's declared targetFiles — classify each as in-spirit or scope-creep:
${exceededFiles.length > 0 ? exceededFiles.map(f => `  - ${f}`).join('\n') : '  (none)'}

Scope verdict semantics:
- "within_scope"       — all modifications are justified by the spec goal and declared targetFiles
- "exceeded_scope"     — one or more files were modified beyond what the spec warrants (scope-creep)
- "insufficient_scope" — the spec goal was not fully addressed by the declared targetFiles
` : ''}${acceptanceCriteriaSection}${uncoveredConsumersSection}
Return your verdict as the session's structured output matching the session's attached JSON schema exactly (findings entries carry severity, category, tier, disposition, file, description, relatedFiles; the verdict carries result, notes, scopeCompliance${acceptanceCriteria.length > 0 ? ', uncoveredCriteria' : ''}).

Rules:
- result must be "PASSED" only if there are no critical findings
- Set result to "FAILED" if any finding has severity "critical"
- Do NOT run the project's whole test suite (its test / full-suite command) and do NOT base a finding on a full-suite run — the suite is run once by the final integration gate after ALL milestones complete; at review time later milestones may not have executed, so a red suite here is expected and not evidence. (The session denies such commands.)
- Specific observations described in 'notes' MUST also appear as 'findings' entries with severity 'info' at minimum — never describe a concrete issue only in prose
- Every newly emitted finding MUST carry 'disposition' set to 'pending' (the reviewer does not assign final dispositions; downstream pipeline / human steps do)
- Do NOT write any files — your output is the structured verdict only
- Do NOT modify state files or business code`;

    const systemPrompt = `You are a Harness Reviewer. Your ONLY job is to review milestone-level composition and return a structured verdict.

Rules:
- Assume each task is individually correct — focus only on how they fit together
- Trace call chains across module boundaries
- Check that cross-module contracts are honoured (types, schemas, function signatures)
- Return your verdict as a structured JSON object matching the session's jsonSchema
- Do NOT write or modify any files
- Do NOT write report files — the orchestrator persists the structured output
- Do NOT update state.json or any harness state file
- Be objective: contract mismatches are findings, report them with appropriate severity`;

    const log = this.logger.createSessionLog(`reviewer-${milestoneId}`);
    // The retry path (below) re-spawns exactly once, under its own log/name,
    // when attempt 1 yields a stub verdict (no structured_output from the
    // SDK). sessionName + sessionLog track which session the end-of-function
    // ledger entry describes; retryLog is closed in finally alongside log.
    let retryLog = null;
    let sessionName = `reviewer-${milestoneId}`;
    let sessionLog = log;
    // Set when the retry spawn fails: attempt 1 was already recorded inline,
    // so the end-of-function ledger write must not run again.
    let skipEndRecord = false;

    try {
      const spawnPromise = this.sessionManager.spawn({
        name: `reviewer-${milestoneId}`,
        prompt,
        systemPrompt,
        model: config.execution.reviewerModel,
        agent: 'reviewer',
        tools: config.tools.reviewer,
        jsonSchema: reviewerSchema,
        maxBudget: config.budgets.reviewer,
        cwd: projectRoot,
        // Output-side guarantee behind the whole-suite prompt rule above: the
        // session denies Bash invocations of the project's test / full-suite
        // command. Reviewer-only — the milestone-regression verifier's
        // whole-suite run is sanctioned and does not pass this flag.
        denyWholeSuiteBash: true,
      });

      this.logger.attachToSession(spawnPromise.handle, log, {
        role: 'reviewer',
        milestoneId,
      });

      let { handle, result: sdkResult } = await spawnPromise;

      let verdict = extractReviewVerdict(sdkResult, milestoneId, harnessDir, { warn: (msg) => this.logger.warn(msg) });

      if (verdict.structured?.isStub === true) {
        // Record attempt 1's session before the retry reuses the ledger, so
        // the first session's tokens/cost are neither dropped nor conflated
        // with the retry's.
        const firstSummary = this.logger.getSessionSummary(log.logPath);
        await this.logger.writeSessionSummary(`reviewer-${milestoneId}`, firstSummary, {
          role: 'reviewer',
          milestoneId,
          passed: verdict.passed,
        });
        await this.tokenTracker?.recordSession(`reviewer-${milestoneId}`, 'reviewer', sdkResult, {
          milestoneId,
          passed: verdict.passed,
          systemPromptTokens: handle.systemPromptTokens,
          toolCallCount: handle._toolCallCount,
        });

        this.logger.warn(`[reviewer] milestone ${milestoneId}: no structured_output received from SDK — retrying once`);

        // Only the spawn+await is fallible-and-recoverable: a spawn failure
        // degrades to attempt 1's already-recorded stub verdict rather than
        // aborting the run.
        const retryName = `reviewer-${milestoneId}-retry`;
        let retried = null;
        try {
          retryLog = this.logger.createSessionLog(retryName);
          const retryPromise = this.sessionManager.spawn({
            name: retryName,
            prompt,
            systemPrompt,
            model: config.execution.reviewerModel,
            agent: 'reviewer',
            tools: config.tools.reviewer,
            jsonSchema: reviewerSchema,
            maxBudget: config.budgets.reviewer,
            cwd: projectRoot,
            denyWholeSuiteBash: true,
          });
          this.logger.attachToSession(retryPromise.handle, retryLog, {
            role: 'reviewer',
            milestoneId,
          });
          retried = await retryPromise;
        } catch (retryErr) {
          // Spawn failed. Keep attempt 1's already-recorded stub verdict
          // rather than aborting the run.
          this.logger.warn(`[reviewer] milestone ${milestoneId}: retry failed (${retryErr.message}) — keeping attempt-1 verdict`);
          skipEndRecord = true;
        }
        if (retried) {
          handle = retried.handle;
          sdkResult = retried.result;
          verdict = extractReviewVerdict(sdkResult, milestoneId, harnessDir, { warn: (msg) => this.logger.warn(msg) });
          sessionName = retryName;
          sessionLog = retryLog;
        }
      }

      if (!skipEndRecord) {
        const summary = this.logger.getSessionSummary(sessionLog.logPath);
        await this.logger.writeSessionSummary(sessionName, summary, {
          role: 'reviewer',
          milestoneId,
          passed: verdict.passed,
        });
        await this.tokenTracker?.recordSession(sessionName, 'reviewer', sdkResult, {
          milestoneId,
          passed: verdict.passed,
          systemPromptTokens: handle.systemPromptTokens,
          toolCallCount: handle._toolCallCount,
        });
      }

      return verdict;
    } finally {
      log.close();
      if (retryLog) retryLog.close();
    }
  }
}

export { Reviewer };
