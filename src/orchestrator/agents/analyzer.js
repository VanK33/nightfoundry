/**
 * analyzer.js — Dispatches analyzer agent on gate failures (circuit breaker).
 *
 * Advisory only: returns an impact analysis with a structured
 * recommendation (retry / re_plan / human). The orchestrator surfaces
 * the analysis, the user decides.
 *
 * The session uses a jsonSchema (agents/_schemas.js → analyzerSchema)
 * so the recommendation is a validated enum, not a regex-matched prose
 * line. This closes the bug class where bug 5 lived (arrow regex
 * drifting with the prompt language).
 *
 * Output is written to .harness/analysis/{event-id}.json as the source
 * of truth.
 *
 * Public API:
 *   analyzeFailure({ taskId, taskDescription, failureType, retryCount,
 *                    allowedRecommendations? }, projectRoot)
 *     → { eventId, recommendation, report, affectedTasks, structured }
 *
 *   extractAnalysis(sdkResult, eventId, harnessDir)  // pure, unit-testable
 *   isRepeatVerdict(prev, curr)                      // pure repeat comparator
 *   readAnalysisHistory(harnessDir, taskId)          // fail-soft history read
 *   recordHistoryOutcome(harnessDir, taskId, eventId, outcome)  // pipeline-only
 */
import fs from 'fs';
import path from 'path';
import config from '../infra/config.js';
import { analyzerSchema, extractStructured, validateStructured } from './_schemas.js';
import { canonicalTaskId } from '../core/scheduler.js';
import { activeHarnessDir } from '../core/run-context.js';
import { captureTrackedSnapshot, auditTrackedDeletions } from '../infra/read-only-audit.js';
import { appendWarnings } from '../core/warnings-ledger.js';

// ── Analysis history (de-amnesia) ────────────────────────────────────────
//
// Per-task verdict history lives in analysis/history-<canonicalTaskId>.json,
// next to the per-event gate-failure-*.json sidecars (which keep being
// written unchanged). Keying by canonicalTaskId() means -rp-N replacement
// tasks inherit the original task's history — a replanned task repeating
// the failure must be visible; pseudo-ids (regression-*, reviewer-*) pass
// through canonicalization unchanged.
//
// The file is a TOP-LEVEL JSON ARRAY by design — this is load-bearing:
// archive.js detectHaltInfo blanket-scans ALL analysis/*.json with a flat
// Object.values() pass for halt patterns ('Circuit breaker:' string prefix,
// type === 'circuit-breaker'). A top-level array yields only object entries
// to that flat scan, so nested entry strings (model-written rootCause text,
// outcome notes) can never match. Do NOT wrap the array in an object.
//
// All history I/O is fail-soft: a missing/corrupt file reads as [], write
// failures only warn — the analysis itself is never blocked by history
// problems.

/** Absolute path of the history file for a task (canonicalized key). */
export function historyFilePath(harnessDir, taskId) {
  return path.join(harnessDir, 'analysis', `history-${canonicalTaskId(taskId)}.json`);
}

/**
 * Read a task's analysis history. Fail-soft: missing, corrupt, or
 * non-array content reads as [].
 *
 * @returns {Array<{eventId, ts, failureType, recommendation, affectedTaskIds, rootCause, outcome}>}
 */
export function readAnalysisHistory(harnessDir, taskId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(historyFilePath(harnessDir, taskId), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Append one history entry (fail-soft — a write failure only warns). */
function appendAnalysisHistory(harnessDir, taskId, entry, warn = console.warn) {
  try {
    const history = readAnalysisHistory(harnessDir, taskId);
    history.push(entry);
    const filePath = historyFilePath(harnessDir, taskId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
  } catch (err) {
    warn(`[analyzer] history append failed for ${taskId}: ${err.message}`);
  }
}

/**
 * Back-fill the `outcome` field of one history entry (matched by eventId).
 * The PIPELINE is the only caller — it alone knows what happened after the
 * verdict (re_plan consumed, breaker thrown). Fail-soft: a missing file or
 * entry is a no-op.
 */
export function recordHistoryOutcome(harnessDir, taskId, eventId, outcome, warn = console.warn) {
  try {
    const filePath = historyFilePath(harnessDir, taskId);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) return;
    const entry = parsed.find((e) => e && e.eventId === eventId);
    if (!entry) return;
    entry.outcome = outcome;
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2));
  } catch (err) {
    warn(`[analyzer] history outcome back-fill failed for ${taskId}: ${err.message}`);
  }
}

/**
 * isRepeatVerdict(prev, curr) — pure repeat comparator.
 *
 * True only when the two verdicts have the same recommendation AND the same
 * affectedTasks taskId set (order-insensitive, ids only — reasons/actions
 * are ignored). Accepts history entries ({recommendation, affectedTaskIds})
 * and analysis results ({recommendation, affectedTasks}); affected lists may
 * hold id strings or {taskId} objects. Any missing side is false — the
 * detector never fires on a first round.
 */
export function isRepeatVerdict(prev, curr) {
  if (!prev || !curr) return false;
  if (!prev.recommendation || !curr.recommendation) return false;
  if (prev.recommendation !== curr.recommendation) return false;

  const idsOf = (verdict) => {
    const list = Array.isArray(verdict.affectedTaskIds) ? verdict.affectedTaskIds
      : Array.isArray(verdict.affectedTasks) ? verdict.affectedTasks
      : [];
    return new Set(
      list
        .map((t) => (typeof t === 'string' ? t : t?.taskId))
        .filter((id) => typeof id === 'string')
    );
  };

  const prevIds = idsOf(prev);
  const currIds = idsOf(curr);
  if (prevIds.size !== currIds.size) return false;
  for (const id of prevIds) {
    if (!currIds.has(id)) return false;
  }
  return true;
}

/**
 * Pure extraction + persistence. Writes the JSON sidecar as a side
 * effect so callers don't have to.
 *
 * Return shape: matches the previous analyzer API —
 *   {
 *     eventId,
 *     recommendation,     // 'retry' | 're_plan' | 'human'
 *     report,             // pretty-printed JSON (for failure messages)
 *     affectedTasks,      // string[] — task IDs (4-segment, optional -rp-N), filtered to
 *                         //   action === 'needs_revalidation'; analyzer LLM occasionally
 *                         //   emits mission-shaped IDs like "001-001 (mission)" — those are
 *                         //   dropped here with a stderr warning rather than passed to the
 *                         //   pipeline consumer, where readTaskStatus would throw
 *     structured          // full structured object, for consumers that want detail
 *   }
 */
export function extractAnalysis(sdkResult, eventId, harnessDir, opts = {}) {
  const warn = opts.warn ?? console.warn;
  const sidecarPath = path.join(harnessDir, 'analysis', `${eventId}.json`);
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });

  const structured = extractStructured(sdkResult, { warn });

  if (structured) {
    const validation = validateStructured(structured, opts.schema ?? analyzerSchema);
    if (!validation.ok) {
      warn(
        `[analyzer] event ${eventId}: structured_output validation failed — ${validation.errors.join('; ')}`
      );
      fs.writeFileSync(sidecarPath, JSON.stringify(structured, null, 2));
      // Conservative default: human. We have a shape but can't trust it.
      return {
        eventId,
        recommendation: 'human',
        report: JSON.stringify(structured, null, 2),
        affectedTasks: [],
        structured,
      };
    }

    fs.writeFileSync(sidecarPath, JSON.stringify(structured, null, 2));

    const isTaskShapedId = (id) => {
      if (typeof id !== 'string') return false;
      const canonical = id.replace(/-rp-\d+$/, '');
      return canonical.split('-').length === 4;
    };
    const needsRevalAll = (structured.affectedTasks || [])
      .filter((t) => t.action === 'needs_revalidation')
      .map((t) => t.taskId);
    const needsReval = needsRevalAll.filter(isTaskShapedId);
    const droppedIds = needsRevalAll.filter((id) => !isTaskShapedId(id));
    if (droppedIds.length > 0) {
      warn(
        `[analyzer] Dropped ${droppedIds.length} non-task-shaped taskId(s) from affectedTasks: ${droppedIds.join(', ')}`
      );
    }

    return {
      eventId,
      recommendation: structured.recommendation,
      report: JSON.stringify(structured, null, 2),
      affectedTasks: needsReval,
      structured,
    };
  }

  // No structured_output — write a minimal sidecar and default to human.
  const minimal = { recommendation: 'human', affectedTasks: [] };
  fs.writeFileSync(sidecarPath, JSON.stringify(minimal, null, 2));

  return {
    eventId,
    recommendation: 'human',
    affectedTasks: [],
    structured: null,
  };
}

class Analyzer {
  constructor(sessionManager, logger, tokenTracker) {
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.tokenTracker = tokenTracker;
  }

  async analyzeFailure(opts, projectRoot) {
    const harnessDir = activeHarnessDir(projectRoot);
    const eventId = `gate-failure-${opts.taskId}-${Date.now()}`;
    const allowedRecommendations = opts.allowedRecommendations ?? ['retry', 're_plan', 'human'];

    // Session schema with the recommendation enum narrowed to the verbs this
    // call site can actually consume (default: all three — byte-identical
    // prompt and schema content for unchanged sites).
    const sessionSchema = {
      ...analyzerSchema,
      properties: {
        ...analyzerSchema.properties,
        recommendation: { type: 'string', enum: [...allowedRecommendations] },
      },
    };

    // Prior-verdict history for this canonical task (fail-soft: [] on any
    // read problem). Read BEFORE this round's entry is appended, so the
    // injected block only ever contains prior rounds.
    const history = readAnalysisHistory(harnessDir, opts.taskId);

    // Collect JSON sidecar paths for the analyzer to read.
    const progressJsonFile     = path.join(harnessDir, 'progress', `task-${opts.taskId}.json`);
    const verificationJsonFile = path.join(harnessDir, 'verification', `task-${opts.taskId}.json`);
    const stateJsonPath        = path.join(harnessDir, 'state.json');

    const parts = opts.taskId.split('-');
    const missionId = `${parts[0]}-${parts[1]}`;
    const missionStateFile = path.join(harnessDir, 'state', `mission-${missionId}.json`);

    const candidateFiles = [progressJsonFile, verificationJsonFile, missionStateFile];
    // Custom sidecar path (e.g., reviewer gate passes its own sidecar location)
    if (opts.sidecarPath) candidateFiles.push(opts.sidecarPath);
    const existingFiles = candidateFiles.filter((f) => fs.existsSync(f));

    // History injection: facts plus ONE behavioral rule, nothing more. With
    // no history the section is the empty string and the prompt stays
    // byte-identical to the history-less form.
    const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    const historySection = history.length === 0 ? '' : `

Prior analysis rounds for this task (oldest first):
${history.map((h, i) =>
  `round ${i + 1} | ${h.failureType} | ${h.recommendation} | [${(h.affectedTaskIds ?? []).join(', ')}] | ${oneLine(h.rootCause) || '(no root cause recorded)'} | outcome: ${h.outcome != null ? oneLine(h.outcome) : '(none recorded)'} (event: ${h.eventId})`
).join('\n')}
Rule: if the same failure shape persists after your prior recommendation was acted on, do not repeat that recommendation — escalate to human.`;

    // Snapshot-evidence injection: facts plus ONE consumption rule, nothing
    // more. With no table (absent or empty) the section is the empty string
    // and the prompt stays byte-identical to the table-less form.
    const evidenceSection = !opts.snapshotEvidence || opts.snapshotEvidence.length === 0 ? '' : `

ENGINE-COMPUTED evidence — completed-task snapshot status (taskId → status):
${opts.snapshotEvidence.map((e) => `${e.taskId} → ${e.label}`).join('\n')}
Rule: before alleging that a completed task falsely claimed completion, consult its evidence row above and/or its .harness/snapshots/<taskId>/after/ contents — work present in the after/ snapshot LANDED; if disk no longer matches that snapshot, describe it as 'landed then overwritten', never as false completion.`;

    // Per-verb rule lines: render only the allowed verbs' lines.
    const verbRuleLines = {
      retry: '- retry: if the failure looks transient (flaky test, network blip)',
      re_plan: '- re_plan: if the task is fundamentally wrong and needs re-decomposition',
      human: '- human: if the spec is ambiguous, the failure pattern is novel, or you are not confident',
    };
    const ruleLines = allowedRecommendations
      .filter((v) => verbRuleLines[v])
      .map((v) => verbRuleLines[v]);
    if (!allowedRecommendations.includes('retry')) {
      ruleLines.push('- The retry budget for this task is exhausted — retry is not available');
    }

    const prompt = `Analyze gate failure for task ${opts.taskId}.

Event ID: ${eventId}
Failure type: ${opts.failureType} (after ${opts.retryCount + 1} attempts)
Task description: ${opts.taskDescription}${historySection}${evidenceSection}

Files to read and analyze:
- State: ${stateJsonPath}
- Mission state: ${missionStateFile}
${existingFiles.map((f) => `- ${path.basename(f)}: ${f}`).join('\n')}

Steps:
1. Read the JSON sidecars to identify root cause
2. Read mission state to find completed tasks with overlapping affectedFiles/targetFiles
3. Assess which completed tasks are safe to keep vs. need revalidation
4. Recommend one of: ${allowedRecommendations.join(' / ')}

Return your analysis as the session's structured output matching the session's attached JSON schema exactly. Allowed recommendation values for THIS analysis: ${allowedRecommendations.map((v) => `"${v}"`).join(' | ')}.

Rules:
${ruleLines.join('\n')}
- Only list affected tasks that actually share files with the failed task
- Mark tasks that touched the same files as 'needs_revalidation'; unrelated completed tasks as 'safe_to_keep' (or omit)
- Enumerate every material observation beyond the primary root cause as its own secondaryFindings entry — do not bury it in prose
- Do NOT write any files — the orchestrator persists your structured output`;

    const systemPrompt = `You are a Harness Analyzer. Your ONLY job is to analyze gate failures and return a structured impact analysis.

Rules:
- Read all relevant files before analyzing — never assume
- Identify root cause from JSON sidecars
- Check file overlap between failed task and completed tasks
- Be specific about which tasks are affected and why
- Return your analysis as a structured JSON object matching the session's jsonSchema
- Do NOT write analysis files — the orchestrator persists the structured output
- Do NOT write or modify business code
- Do NOT update state.json
- The working tree holds the run's in-flight work: HEAD predates it by design, so absence from git history is NEVER evidence that work was not done — judge from the files themselves`;

    const log = this.logger.createSessionLog(`analyzer-${opts.taskId}`);

    // Read-only-audit snapshot: captured exactly once, before the single
    // spawn this invocation performs. Fail-soft: captureTrackedSnapshot is
    // documented never to throw, but this catch is a defensive backstop so
    // a future change there (or a non-git projectRoot) can never turn into
    // an analyzeFailure rejection.
    let trackedSnapshot = null;
    try {
      trackedSnapshot = captureTrackedSnapshot(projectRoot);
    } catch {
      trackedSnapshot = null;
    }

    try {
      const spawnPromise = this.sessionManager.spawn({
        name: `analyzer-${opts.taskId}`,
        prompt,
        systemPrompt,
        model: config.execution.analyzerModel,
        agent: 'analyzer',
        tools: config.tools.verifier,
        // Read-only judging role: no file removal. Git reads stay available
        // (forensic analysis may legitimately consult history).
        denyFileRemovalBash: true,
        jsonSchema: sessionSchema,
        maxBudget: config.budgets.analyzer,
        cwd: projectRoot,
      });

      this.logger.attachToSession(spawnPromise.handle, log, {
        role: 'analyzer',
        taskId: opts.taskId,
        eventId,
      });

      const { handle, result: sdkResult } = await spawnPromise;

      const analysis = extractAnalysis(sdkResult, eventId, harnessDir, { warn: (msg) => this.logger.warn(msg), schema: sessionSchema });

      // Append this round's verdict to the per-task history. The analyzer
      // owns the verdict fields; `outcome` stays null here — the pipeline
      // back-fills it once it knows what happened next.
      appendAnalysisHistory(harnessDir, opts.taskId, {
        eventId,
        ts: new Date().toISOString(),
        failureType: opts.failureType,
        recommendation: analysis.recommendation,
        affectedTaskIds: analysis.affectedTasks,
        rootCause: analysis.structured?.rootCause ?? '',
        outcome: null,
      }, (msg) => this.logger.warn(msg));

      const summary = this.logger.getSessionSummary(log.logPath);
      await this.logger.writeSessionSummary(`analyzer-${opts.taskId}`, summary, {
        role: 'analyzer',
        taskId: opts.taskId,
        eventId,
        recommendation: analysis.recommendation,
        affectedTasks: analysis.affectedTasks,
      });
      await this.tokenTracker?.recordSession(`analyzer-${opts.taskId}`, 'analyzer', sdkResult, {
        taskId: opts.taskId,
        eventId,
        recommendation: analysis.recommendation,
        systemPromptTokens: handle.systemPromptTokens,
        toolCallCount: handle._toolCallCount,
      });

      // Read-only-audit check: runs exactly once, after this invocation's
      // single spawn has settled. Fail-soft end-to-end: nothing here may
      // throw, reject, or alter the analysis already computed above —
      // including when projectRoot is a non-git directory, the snapshot is
      // unusable, the audit helper itself throws, or the logger's warn
      // throws.
      try {
        const auditReport = auditTrackedDeletions(projectRoot, trackedSnapshot, {
          onLog: (msg) => this.logger.warn(msg),
        });
        const hasAuditContent = !!auditReport && (
          (auditReport.deleted?.length ?? 0) > 0 ||
          (auditReport.restored?.length ?? 0) > 0 ||
          (auditReport.reportOnly?.length ?? 0) > 0 ||
          (auditReport.failed?.length ?? 0) > 0
        );
        if (hasAuditContent) {
          const restoredPaths = (auditReport.restored || []).map((r) => r.path);
          const reportOnlyPaths = auditReport.reportOnly || [];
          // Per-session-unique identifier (taskId + eventId): a second,
          // distinct incident for the same task must never be silently
          // swallowed by the ledger's content-hash dedup, which keys off
          // (among other fields) this description string.
          const sessionIdentifier = `${opts.taskId}:${eventId}`;
          try {
            this.logger.warn(
              `[analyzer] task ${opts.taskId}: READ-ONLY AUDIT ALERT — role 'analyzer' session ${sessionIdentifier} left tracked-file deletions on disk. ` +
              `restored paths: [${restoredPaths.join(', ')}]; report-only paths: [${reportOnlyPaths.join(', ')}]`
            );
          } catch {
            // fail-soft: a throwing logger must never abort analyzeFailure
          }
          try {
            appendWarnings(projectRoot, [{
              severity: 'warning',
              category: 'read-only-audit',
              description: `role 'analyzer' read-only audit for session ${sessionIdentifier} (task ${opts.taskId}) detected tracked-file deletions during the analyzer session — restored paths: [${restoredPaths.join(', ')}]; report-only paths: [${reportOnlyPaths.join(', ')}]`,
            }]);
          } catch {
            // fail-soft: a ledger write failure must never abort analyzeFailure
          }
        }
      } catch {
        // fail-soft: the read-only audit never invalidates, retries, or
        // alters the analysis already computed above.
      }

      return analysis;
    } finally {
      log.close();
    }
  }
}

export { Analyzer };
