/**
 * executor.js — Dispatches executor agent sessions for individual tasks.
 *
 * Each session receives only its task info, writes code + tests via
 * Edit/Write tools, and returns a structured progress report as the
 * session's jsonSchema output (see agents/_schemas.js → executorSchema).
 *
 * The structured output is written to .harness/progress/task-{id}.json
 * as the source of truth. snapshots.readAffectedFiles reads this JSON
 * directly — no more `## 修改的文件` 中文 regex parsing (same bug
 * class as dogfood bug 5).
 *
 * Public API:
 *   executeTask(task, projectRoot, context?)
 *     → { status: 'COMPLETED'|'BLOCKED', progressContent, structured }
 *
 *   extractProgress(sdkResult, taskId, harnessDir)  // pure, unit-testable
 *   buildExecutorPrompt(task, context)              // pure, unit-testable
 */
import fs from 'fs';
import path from 'path';
import config from '../infra/config.js';
import { executorSchema, extractStructured, validateStructured } from './_schemas.js';
import { SidecarReuseError } from '../core/sidecar-reuse-error.js';
import { activeHarnessDir } from '../core/run-context.js';

/**
 * Build the executor's user prompt from a task + context.
 *
 * Pure function (no I/O, no side effects). Extracted so the context
 * enrichment work (Phase I item 2) can be unit-tested without
 * spawning an executor session.
 *
 * Back-compat: if task.patternReferences and task.dataSchemas are
 * empty or missing, the produced prompt is byte-identical to the
 * pre-enrichment prompt (no extra sections appended).
 *
 * @param {object} task - Task with id, description, targetFiles, testCases,
 *                        patternReferences?, dataSchemas?
 * @param {object} context - Optional context (verifyJsonContent, additionalContext)
 * @returns {string} The user prompt
 */
export function buildExecutorPrompt(task, context = {}) {
  let prompt = `Task ${task.id}: ${task.description}

Target files: ${(task.targetFiles || []).join(', ')}

${task.testCases ? `Test cases to cover:\n${task.testCases.map((tc, i) => `${i + 1}. ${tc}`).join('\n')}` : ''}

${context.verifyJsonContent ? `verify.json contents:\n\`\`\`json\n${context.verifyJsonContent}\n\`\`\`` : ''}

${context.additionalContext || ''}`;

  // Context enrichment sections — only appended if the planner
  // populated the new fields. Empty/missing arrays produce no output,
  // matching pre-enrichment behavior exactly.
  if (task.patternReferences && task.patternReferences.length > 0) {
    prompt += `\n\n## Pattern references

Follow the style of these examples from the same codebase. Each reference has a category (peer / imported-type / caller-side) indicating its relevance.

`;
    for (const ref of task.patternReferences) {
      prompt += `### ${ref.path} (${ref.category})\n${ref.reason}\n\`\`\`\n${ref.excerpt}\n\`\`\`\n\n`;
    }
  }

  if (task.dataSchemas && task.dataSchemas.length > 0) {
    prompt += `\n## Data schemas

Match the shapes of these types/schemas. Do NOT invent alternative shapes; use the exact field names and types from the declarations below.

`;
    for (const schema of task.dataSchemas) {
      prompt += `### ${schema.name} (from ${schema.path})\n${schema.reason}\n\`\`\`\n${schema.shape}\n\`\`\`\n\n`;
    }
  }

  if (context.previousFailures && context.previousFailures.length > 0) {
    prompt += `\n## Previous attempt failed verification\n\n`;
    for (const failure of context.previousFailures) {
      prompt += `- **${failure.description}** (${failure.kind}): ${failure.evidence}\n`;
    }
    prompt += `\nAddress each finding in this attempt.`;
  }

  prompt += `

Implement the task using Edit/Write tools, then return your progress
report as the session's structured output matching the session's attached
JSON schema exactly (status, summary, affectedFiles, testsSummary, and —
required when status is BLOCKED — blockReason).

Rules:
- status=COMPLETED only if every test case is covered and the code compiles/runs
- Only modify files listed in targetFiles
- affectedFiles MUST list every file you modified (including test files)
- If anything is ambiguous or code doesn't match expectations: STOP and return status=BLOCKED with a clear blockReason
- Do NOT write a progress markdown file — the orchestrator persists your structured output
- Do NOT update state.json — the orchestrator handles that
- Do NOT run verification — the orchestrator dispatches a verifier after you`;

  return prompt;
}

/**
 * Pure extraction + persistence. Writes the JSON sidecar as a side
 * effect so callers don't have to.
 *
 * Return shape:
 *   {
 *     status: 'COMPLETED'|'BLOCKED',
 *     progressContent: string,   // pretty-printed JSON (back-compat w/ callers)
 *     structured: object,        // full parsed object
 *     affectedFiles: [{path, reason}]  // convenience for snapshots/readAffectedFiles
 *   }
 */
export function extractProgress(sdkResult, taskId, harnessDir, opts = {}) {
  const { firstWrite = false, warn = console.warn, projectRoot = null } = opts;
  const sidecarPath = path.join(harnessDir, 'progress', `task-${taskId}.json`);
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });

  if (firstWrite && fs.existsSync(sidecarPath)) {
    throw new SidecarReuseError(taskId, sidecarPath);
  }

  const structured = extractStructured(sdkResult, { warn });

  if (structured) {
    const validation = validateStructured(structured, executorSchema);
    if (!validation.ok) {
      warn(
        `[executor] task ${taskId}: structured_output validation failed — ${validation.errors.join('; ')}`
      );
      fs.writeFileSync(sidecarPath, JSON.stringify(structured, null, 2));
      // Conservative default: treat as BLOCKED so the orchestrator
      // retries or escalates rather than cascading a broken state.
      return {
        status: 'BLOCKED',
        progressContent: JSON.stringify(structured, null, 2),
        structured,
        affectedFiles: [],
      };
    }

    // Enrich affectedFiles with absolute paths for operator visibility. The
    // claimed `path` stays byte-identical to what the agent reported; we add
    // `absolutePath` (resolved against projectRoot) and — only when it falls
    // outside projectRoot — `outOfRoot: true`. Honest limitation: this is the
    // agent's own narrative, so a relative claim resolves under projectRoot
    // even if bytes actually landed elsewhere via Bash. Enforcement for
    // Edit/Write lives in session-manager._guardToolUse; Bash writes remain
    // a documented residual. When projectRoot is unavailable the enrichment
    // is skipped (the field is best-effort visibility, not a contract
    // consumers rely on).
    if (projectRoot && Array.isArray(structured.affectedFiles)) {
      const rootAbs = path.resolve(projectRoot);
      const outOfRootAbs = [];
      structured.affectedFiles = structured.affectedFiles.map((entry) => {
        if (!entry || typeof entry.path !== 'string') return entry;
        const absolutePath = path.resolve(rootAbs, entry.path);
        const inRoot = absolutePath === rootAbs || absolutePath.startsWith(rootAbs + path.sep);
        const enriched = { ...entry, absolutePath };
        if (!inRoot) {
          enriched.outOfRoot = true;
          outOfRootAbs.push(absolutePath);
        }
        return enriched;
      });
      if (outOfRootAbs.length > 0) {
        warn(
          `[executor] task ${taskId}: affectedFiles contains out-of-root claim(s) — ${outOfRootAbs.join(', ')}`
        );
      }
    }

    fs.writeFileSync(sidecarPath, JSON.stringify(structured, null, 2));
    return {
      status: structured.status,
      progressContent: JSON.stringify(structured, null, 2),
      structured,
      affectedFiles: structured.affectedFiles || [],
    };
  }

  // No structured_output from SDK — conservative BLOCKED default.
  const stub = {
    status: 'BLOCKED',
    summary: 'Executor session returned no structured output',
    affectedFiles: [],
    testsSummary: '',
    blockReason: 'No structured_output from SDK',
  };
  fs.writeFileSync(sidecarPath, JSON.stringify(stub, null, 2));

  return {
    status: 'BLOCKED',
    progressContent: JSON.stringify(stub, null, 2),
    structured: stub,
    affectedFiles: [],
  };
}

class Executor {
  constructor(sessionManager, logger, tokenTracker) {
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.tokenTracker = tokenTracker;
  }

  /**
   * Execute a single task in an isolated agent session.
   *
   * @param {object} task - Task descriptor (id, description, targetFiles, testCases,
   *                        patternReferences?, dataSchemas?)
   * @param {string} projectRoot - Absolute path to the project root
   * @param {object} [context={}] - Optional context passed to the executor prompt
   * @param {string} [context.verifyJsonContent] - Raw contents of verify.json
   * @param {string} [context.additionalContext] - Free-form additional context
   * @param {{ kind: string, description: string, evidence: string }[]} [context.previousFailures]
   *   - Findings from a previous failed verification attempt. Each entry has:
   *     - kind: failure category (e.g. 'test', 'lint', 'schema')
   *     - description: human-readable description of what failed
   *     - evidence: supporting detail (error message, diff, etc.)
   * @returns {Promise<{ status: string, progressContent: string, structured: object, affectedFiles: Array }>}
   */
  async executeTask(task, projectRoot, context = {}) {
    const harnessDir = activeHarnessDir(projectRoot);

    const prompt = buildExecutorPrompt(task, context);

    const systemPrompt = `You are a Harness Executor. Your ONLY job is to implement the task described below and return a structured progress report.

Rules:
- Write code and tests for the specified task
- Only modify files listed in targetFiles
- You must Read existing files before editing them. When the task declares targetFiles, the session blocks Edit/Write outside that list and blocks editing an existing file you have not Read first.
- Cover all specified test cases
- Return your progress report as a structured JSON object matching the session's jsonSchema
- If anything is ambiguous or code doesn't match expectations: STOP and report BLOCKED with a clear blockReason
- Do NOT make design decisions — implement exactly what's specified
- Do NOT write progress markdown files — the orchestrator persists the structured output
- Do NOT update state.json — the orchestrator handles that
- Do NOT run verification — the orchestrator dispatches a verifier after you`;

    const log = this.logger.createSessionLog(`executor-${task.id}`);

    try {
      const spawnPromise = this.sessionManager.spawn({
        name: `executor-${task.id}`,
        prompt,
        systemPrompt,
        model: config.execution.executorModel,
        agent: 'executor',
        tools: config.tools.executor,
        jsonSchema: executorSchema,
        maxBudget: config.budgets.executor,
        cwd: projectRoot,
        targetFiles: task.targetFiles,
        bashScope: 'Bash',
      });

      this.logger.attachToSession(spawnPromise.handle, log, {
        role: 'executor',
        taskId: task.id,
      });

      const { handle, result } = await spawnPromise;

      const progress = extractProgress(result, task.id, harnessDir, { warn: (msg) => this.logger.warn(msg), firstWrite: context.firstWrite, projectRoot });

      const summary = this.logger.getSessionSummary(log.logPath);
      await this.logger.writeSessionSummary(`executor-${task.id}`, summary, {
        role: 'executor',
        taskId: task.id,
        status: progress.status,
      });
      await this.tokenTracker?.recordSession(`executor-${task.id}`, 'executor', result, {
        taskId: task.id,
        status: progress.status,
        systemPromptTokens: handle.systemPromptTokens,
        toolCallCount: handle._toolCallCount,
      });

      return progress;
    } finally {
      log.close();
    }
  }
}

export { Executor };
