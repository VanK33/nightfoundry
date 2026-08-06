/**
 * planner.js — Decomposition via Claude sessions.
 *
 * Spawns planner sessions with --json-schema to get structured output.
 * The orchestrator parses the JSON and writes state files.
 *
 * Public API:
 *   planGlobal(goal, projectRoot, opts?) → { milestones: [...], assumptions: [...] }  Phase 3a (BFS)
 *   verifyAssumptions(assumptions, projectRoot) → [{ assumption, status, evidence }]  Phase 3a steps 5-6
 *   planMission(missionId, projectRoot, context?) → { subMissions: [...] }            Phase 3b (lazy DFS)
 *   remediateScenarios(missionId, projectRoot, context?) → { newTasks, outOfScope }   Phase 3b-2.5
 *   remediateReviewFindings(milestoneId, findings, projectRoot) → { newTasks }         Post-review remediation
 *   remediateRegressionFailure(milestoneId, findings, projectRoot) → { newTasks }     Post-regression remediation
 *   replanTask(failedTask, analyzerReport, missionContext) → { replacementTasks }     Failed-task re-plan
 *   reExtractAssumptions(specPath, projectRoot) → [{text, specSection, phase}[]]     Re-extract assumptions from spec
 */
import fs from 'fs';
import path from 'path';
import config from '../infra/config.js';
import { assumptionRemediationSchema, reviewRemediationSchema, regressionRemediationSchema, taskReplanSchema } from './_schemas.js';
import { extractRejectedPhrases } from '../core/scope-parser.js';
import { isTestTask } from '../core/state.js';
import { buildMissionSystemPrompt, buildMissionUserPrompt, buildReplanSystemPrompt, buildPlanLintCorrectionPrompt, PROMPT_SECTION_TASK_SPECIFICITY, PROMPT_SECTION_SYMBOL_ANCHOR, PROMPT_SECTION_LITERAL_PATHS, PROMPT_SECTION_PRESERVE_PATH_ANCHOR, PROMPT_SECTION_NO_READONLY_TASKS } from './planner-prompts.js';
import { InfrastructureError } from '../infra/session-manager.js';
import { buildDeclaredSet, lintPlanScope, lintGlobalPlanScope, checkScopeMappingConsistency } from '../gates/plan-scope-lint.js';
import { lintPlanStructure, lintTaskCheckShapes, warnCrossMissionDuplicates } from '../gates/plan-structure-lint.js';

/**
 * Bounded number of ADDITIONAL retries of the assumption-verification
 * session when it fails with a retryable InfrastructureError (transport /
 * network / rate-limit / 5xx). A retryable infra failure means "the check
 * did not run", not "the model could not decide" — so we re-spawn the
 * session up to this many extra times before giving up and re-throwing.
 */
const MAX_INFRA_RETRIES = 2;

/**
 * Schema for Phase 3b mission decomposition output.
 * Extracted so the reusable session can reference it at construction time.
 *
 * Context enrichment (Phase I item 2): tasks may carry optional
 * `patternReferences` and `dataSchemas` arrays the planner populated
 * during its bounded adjacent-file exploration. Both arrays are
 * optional — empty or missing arrays produce back-compat executor
 * behavior (no prompt changes).
 */
const missionDecompositionSchema = {
  type: 'object',
  properties: {
    subMissions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          ordering: { type: 'string', enum: ['sequential', 'parallel'] },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                description: { type: 'string' },
                targetFiles: { type: 'array', items: { type: 'string' } },
                dependencies: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      taskId: { type: 'string' },
                      type: { type: 'string', enum: ['hard', 'soft'] },
                    },
                    required: ['taskId', 'type'],
                  },
                },
                testCases: {
                  type: 'array',
                  items: { type: 'string' },
                },
                tracesScenario: {
                  type: 'array',
                  items: { type: 'string' },
                },
                // Context enrichment — pattern references (peer files,
                // caller-side consumers). See design doc for the
                // three-category adjacency heuristic.
                patternReferences: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string' },
                      excerpt: { type: 'string' },
                      category: {
                        type: 'string',
                        enum: ['peer', 'imported-type', 'caller-side'],
                      },
                      reason: { type: 'string' },
                    },
                    required: ['path', 'excerpt', 'category', 'reason'],
                  },
                },
                // Context enrichment — data schemas (type/interface/DTO
                // definitions the task will import or consume).
                dataSchemas: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string' },
                      name: { type: 'string' },
                      shape: { type: 'string' },
                      reason: { type: 'string' },
                    },
                    required: ['path', 'name', 'shape', 'reason'],
                  },
                },
              },
              required: ['id', 'description', 'targetFiles'],
            },
          },
        },
        required: ['id', 'description', 'tasks'],
      },
    },
  },
  required: ['subMissions'],
};

class Planner {
  constructor(sessionManager, logger, tokenTracker) {
    this.sessionManager = sessionManager;
    this.tokenTracker = tokenTracker;
    this.logger = logger;
    // Reusable session for Phase 3b mission decomposition. Lazily
    // created on first planMission call. Closed via
    // closeReusableSession() which pipeline.js calls at the end of
    // run() and resume().
    this._reusableSession = null;
    this._reusableSessionLog = null;
    // Inputs the reusable session was first spawned with. On
    // subsequent _ensureReusableSession calls, we assert that the
    // new inputs match — otherwise we'd silently operate with stale
    // cwd or a stale system prompt. See _ensureReusableSession.
    this._reusableSessionInputs = null;
    // Rotation state for the reusable planner session. _sessionContextTokens
    // and _sessionMissionCount track the current session's accumulated
    // context usage; they are reset elsewhere (not by closeReusableSession
    // and not by _recordRotationEvent). _reusableSessionSeq is monotonic
    // for the lifetime of this Planner instance — it is never reset.
    // _rotationEvents is an internal ledger drained via
    // drainRotationEvents().
    this._sessionContextTokens = 0;
    this._sessionMissionCount = 0;
    this._reusableSessionSeq = 1;
    this._rotationEvents = [];
  }

  /**
   * Record a session-rotation event onto the internal ledger and emit a
   * human-readable line via logger.warn so it's visible in the terminal.
   * Does not mutate rotation counters — callers are responsible for that.
   */
  _recordRotationEvent(type, fields = {}) {
    const { sessionName, missionId, contextTokens, missionCount } = fields;
    this._rotationEvents.push({ type, sessionName, missionId, contextTokens, missionCount });
    this.logger.warn(
      `[planner] rotation event: ${type} missionId=${missionId} contextTokens=${contextTokens} missionCount=${missionCount}`
    );
  }

  /**
   * Return the accumulated rotation events and clear the internal ledger.
   */
  drainRotationEvents() {
    const events = this._rotationEvents;
    this._rotationEvents = [];
    return events;
  }

  /**
   * Close the reusable planner session if one exists. Safe to call
   * unconditionally — it's a no-op if no session is open. Pipeline.js
   * MUST call this in a finally block around run() and resume() so we
   * don't leak SDK subprocesses.
   */
  async closeReusableSession() {
    if (this._reusableSession) {
      try {
        await this._reusableSession.close();
      } catch {
        // swallow — session may have already errored
      }
      this._reusableSession = null;
    }
    if (this._reusableSessionLog) {
      try {
        this._reusableSessionLog.close();
      } catch {}
      this._reusableSessionLog = null;
    }
    this._reusableSessionInputs = null;
  }

  /**
   * Lazily create the reusable planner session on first use.
   * Subsequent planMission calls within the same Pipeline.run() or
   * Pipeline.resume() invocation reuse it. (Both run() and resume()
   * wrap their execution in a try/finally that calls
   * closeReusableSession(), so the session lifecycle is bounded by
   * either entry point.)
   *
   * Asserts that subsequent calls use the SAME projectRoot and maxTasks
   * as the session was spawned with. Without this assertion, a reused
   * session would silently operate with the wrong cwd (tool reads
   * against the wrong files) or the wrong system prompt constraint
   * (maxTasks limit baked in at construction time), producing subtly
   * incorrect plans with no error signal.
   *
   * The current sole caller (pipeline.js) always uses the same
   * projectRoot and maxTasks within a run, so this assertion never
   * fires in production today. It exists as a defensive guard for
   * future callers that might innocently vary inputs (per-mission
   * maxTasks tuning, multi-repo support, test harnesses, etc).
   *
   * (Bug caught in Copilot review, 2026-04-09.)
   */
  _ensureReusableSession(projectRoot, maxTasks) {
    if (this._reusableSession) {
      // Invariant check: the existing session was spawned with
      // specific inputs baked into its cwd and system prompt. If the
      // caller is asking for a different projectRoot or maxTasks, we
      // CANNOT safely reuse — fail loudly instead of silently
      // producing wrong output.
      const prev = this._reusableSessionInputs;
      if (prev && prev.projectRoot !== projectRoot) {
        throw new Error(
          `Planner._ensureReusableSession: projectRoot mismatch. ` +
          `Existing reusable session was spawned with cwd=${prev.projectRoot}, ` +
          `but called again with projectRoot=${projectRoot}. ` +
          `Session reuse requires consistent inputs across planMission calls. ` +
          `Call closeReusableSession() first.`
        );
      }
      if (prev && prev.maxTasks !== maxTasks) {
        throw new Error(
          `Planner._ensureReusableSession: maxTasks mismatch. ` +
          `Existing reusable session was spawned with maxTasks=${prev.maxTasks} baked into its system prompt, ` +
          `but called again with maxTasks=${maxTasks}. ` +
          `Session reuse requires consistent inputs across planMission calls. ` +
          `Call closeReusableSession() first.`
        );
      }
      return this._reusableSession;
    }

    // Derive the session name from the monotonic sequence counter so
    // rotated sessions get distinct, identifiable names. Use the SAME
    // derived name for both the session log and spawnReusable's name
    // option, and expose it on the instance so rotation-event rows can
    // reference it.
    const sessionName = this._reusableSessionSeq === 1
      ? 'planner-reusable'
      : `planner-reusable-${this._reusableSessionSeq}`;
    this._reusableSessionName = sessionName;

    // Open the log file first so that if spawnReusable succeeds, the
    // logger is ready to attach immediately. BUT if spawnReusable
    // throws synchronously, we must close the log file and reset
    // state, otherwise the log handle leaks until process exit.
    // (Bug caught in Copilot review, 2026-04-09.)
    this._reusableSessionLog = this.logger.createSessionLog(sessionName);

    const systemPrompt = buildMissionSystemPrompt(maxTasks);

    // Budget: allow for many turns in a single session. Rather than
    // guessing a per-turn budget, give the reusable session a generous
    // ceiling (10x the single-turn budget). If a real dogfood ever
    // hits this ceiling, we reconsider.
    const reusableBudget = config.budgets.planner * 10;

    try {
      this._reusableSession = this.sessionManager.spawnReusable({
        name: sessionName,
        systemPrompt,
        model: config.execution.plannerModel,
        tools: config.tools.planner,
        jsonSchema: missionDecompositionSchema,
        maxBudget: reusableBudget,
        cwd: projectRoot,
      });

      this.logger.attachToSession(this._reusableSession.handle, this._reusableSessionLog, {
        role: 'planner',
        phase: '3b-reusable',
      });

      // Record the inputs so subsequent calls can assert they match.
      this._reusableSessionInputs = { projectRoot, maxTasks };
    } catch (err) {
      // Clean up the log file and reset state so a retry path (or the
      // try/finally in pipeline.run()'s closeReusableSession) doesn't
      // hit a half-constructed reusable session.
      try { this._reusableSessionLog?.close(); } catch {}
      this._reusableSessionLog = null;
      this._reusableSession = null;
      this._reusableSessionInputs = null;
      throw err;
    }

    return this._reusableSession;
  }

  async planGlobal(goal, projectRoot, opts = {}) {
    const systemPrompt = `You are a software architect decomposing a development goal into milestones and missions.

Rules:
- Decompose into Milestones (high-level deliverables) and Missions (concrete work packages within each milestone)
- Do NOT decompose further into sub-missions or tasks — that happens later (lazy DFS)
- Each mission should be a coherent unit of work (e.g., "implement X module", "add Y integration")
- Use "description" field (never "title")
- Milestone IDs: three-digit strings ("001", "002", ...)
- Mission IDs: milestone-seq ("001-001", "001-002", ...)
- Every mission MUST include a targetFiles array naming the project-root-relative files that mission will create or modify, including any test files it writes; across all missions combined, targetFiles must cover every file the spec identifies as a target and every file referenced by a verification command attached to a spec criterion
- List any assumptions about existing code/APIs that need verification; for each assumption, tag it with the spec section heading it relates to (use the exact heading text, or "general" if none applies). Use exactly one of two assumption types:
  - **invariant** — assumption that must hold before work begins (present-tense, e.g. 'File X exports function Y')
  - **post-fix** — assumption about what the code will look like after the mission applies its changes (future-tense, e.g. 'After this mission, module Z will accept parameter W')

  Good assumption: "src/utils/config-loader.js exports parseConfig" (invariant, present-tense)
  Bad assumption:  "The schema should probably have a revised field" (vague, no phase, no tense discipline)

  Functional identity vs scenery (CRITICAL): spec authors often include precision scenery — exact line numbers, file lengths, verbatim quotes of current code — to help the executor anchor. When EXTRACTING an invariant from such a spec sentence, extract the FUNCTIONAL IDENTITY behind the precision, NOT the literal coordinate. The verifier later checks identity, not coordinates.
   - Spec mentions "file X is about 350 lines" → emit invariant about file X's existence and content category, not its line count.
   - Spec mentions "the function at line 616 of foo.js" → emit invariant about the function being exported by foo.js, not its line offset.
   - Spec quotes "EXPECTED array has 22 entries" → emit invariant about EXPECTED's presence and the literal item names that must appear, not the array length.
   - Spec quotes a verbatim slice of an existing prompt string → emit invariant about the prompt containing a clause about that topic, not the literal string match.
   The principle: the planner LIFTS the load-bearing identity out of the precision scenery so a small drift in coordinates does not trip the verifier.
   Also: when a spec acceptance criterion describes a POST-FIX expectation ("the full test suite is green after the change", "the field is present in the schema"), DO NOT extract it as an invariant — that is a post-fix expectation, not a pre-state fact. Either skip it (the milestone regression covers it later) or emit it as a 'post-fix' assumption that defers.

## Milestone strategy — CRITICAL for execution performance

Milestones are **serial checkpoints** in the execution engine. Within a milestone, missions and their tasks run in PARALLEL (up to ${config.execution.maxConcurrentSessions} concurrent sessions). Between milestones, execution stops, results are reviewed, and a new planning phase begins sequentially. **Each unnecessary milestone boundary adds 5-15 minutes of serial planning overhead with zero parallelism benefit.**

Therefore:
1. **Prefer FEWER, LARGER milestones.** Put all related work into ONE milestone unless there is a genuine reason to checkpoint.
2. **Create a second milestone ONLY when** later work genuinely needs to observe the output of earlier work before it can be planned. If all tasks are independent file edits, deletions, or additions with no cross-task data dependency, that is ONE milestone.
3. **Do NOT group by module category** (e.g., "agent modules" in milestone 1, "core modules" in milestone 2). Group by **execution dependency**: can the work in milestone 2 be planned without seeing the results of milestone 1? If yes, they belong in the same milestone.
4. **Default to 1 milestone** for simple specs (feature additions, deletions, refactors, test updates) unless the spec explicitly describes phased delivery.

## Mission decomposition — use runtime dependency, not file proximity

When deciding what belongs in the same mission, reason about the **runtime call graph**, not the file-system directory tree:
- Files that share a runtime data contract (one writes a file/sidecar that another reads) belong in the SAME mission or in missions with explicit hard dependencies.
- Files that happen to be in the same directory but have no runtime relationship can be in SEPARATE parallel missions.
- A module's imports (visible in the import graph below, if provided) show which files are connected. Connected files should generally be in the same milestone; independent clusters can run in parallel.

${opts.importGraph ? `## Project import graph (auto-generated)\n\nThis shows which source files import from which. Use it to identify connected clusters vs independent modules.\n\n${opts.importGraph}\n` : ''}
${opts.learningData ? `Historical decomposition patterns for calibration:\n${opts.learningData}` : ''}${opts.mode === 'small-task' ? '\nYou are decomposing a single focused task. Keep it tight — one milestone, minimal missions. Do not invent scope beyond the stated goal.' : ''}`;

    const targetFilesBlock =
      Array.isArray(opts.specTargetFiles) && opts.specTargetFiles.length > 0
        ? `\n## Declared target files\n${opts.specTargetFiles.map(f => `- ${f}`).join('\n')}\n`
        : '';

    const acceptanceCriteriaBlock =
      Array.isArray(opts.specAcceptanceCriteria) && opts.specAcceptanceCriteria.length > 0
        ? `\n## Acceptance criteria\n${opts.specAcceptanceCriteria.filter((c, i) => {
            if (c && typeof c === 'object' && !Array.isArray(c) && typeof c.description === 'string') {
              return true;
            }
            const msg = `Skipping non-object/missing-description acceptance criterion at index ${i}`;
            if (opts.onLog) opts.onLog(msg); else console.warn(msg);
            return false;
          }).map(c => {
            const verifyLine =
              c.verification && c.verification.kind === 'command'
                ? `\n  Verify: ${c.verification.command}`
                : '';
            return `- ${c.description}${verifyLine}`;
          }).join('\n')}\n`
        : '';

    const scopeItemsBlock =
      Array.isArray(opts.specScopeItems) && opts.specScopeItems.length > 0
        ? `\n## Declared scope items\n${opts.specScopeItems.map(s => `- ${s.id}: ${s.label}`).join('\n')}\n` +
          `\nEVERY scope id above MUST be mapped to at least one mission id you emit, via the top-level \`scopeMapping\` array (one entry per scope id, each with \`scopeItemId\` and a non-empty \`missionIds\`). A scope id with no mission, or a mission id that is not in your plan, fails the coverage gate.\n`
        : '';

    const constraintLines = Array.isArray(opts.specConstraints)
      ? opts.specConstraints.filter(c => typeof c === 'string')
      : [];
    const constraintsBlock =
      constraintLines.length > 0
        ? `\n## Spec constraints (binding)\nThese constraints are BINDING on the plan: they constrain the milestone/mission structure and every mission's scope. Carry any constraint that concerns test files, test-surface boundaries, or milestone structure INTO the description of every mission it affects, so downstream mission planning sees it.\n${constraintLines.map(c => `- ${c}`).join('\n')}\n`
        : '';

    const prompt = `Goal: ${goal}

${opts.prdPath ? `PRD file: ${opts.prdPath}` : ''}
${targetFilesBlock}${acceptanceCriteriaBlock}${scopeItemsBlock}${constraintsBlock}
Decompose this into milestones and missions. Output structured JSON.`;

    const schema = {
      type: 'object',
      properties: {
        milestones: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', pattern: '^\\d{3}$' },
              description: { type: 'string' },
              missions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', pattern: '^\\d{3}-\\d{3}$' },
                    description: { type: 'string' },
                    targetFiles: { type: 'array', items: { type: 'string' }, minItems: 1 },
                  },
                  required: ['id', 'description', 'targetFiles'],
                },
              },
            },
            required: ['id', 'description', 'missions'],
          },
        },
        assumptions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              specSection: { type: 'string' },
              phase: { type: 'string', enum: ['invariant', 'post-fix'] },
            },
            required: ['text', 'specSection'],
          },
        },
        scopeMapping: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              scopeItemId: { type: 'string' },
              missionIds: {
                type: 'array',
                items: { type: 'string' },
                minItems: 1,
              },
            },
            required: ['scopeItemId', 'missionIds'],
          },
        },
      },
      required: ['milestones'],
    };

    const log = this.logger.createSessionLog('planner-global');
    // Call-local reusable session (NOT this._reusableSession — that field is
    // reserved for the Phase 3b mission-decomposition session managed via
    // _ensureReusableSession()/closeReusableSession()). spawnReusable's
    // maxBudget is a single cumulative ceiling across every sendPrompt()
    // turn on the session, not a per-turn budget, so it's set to twice the
    // single-turn planner budget even though today we only send one turn.
    let session;

    try {
      session = this.sessionManager.spawnReusable({
        name: 'planner-global',
        systemPrompt,
        model: config.execution.plannerModel,
        tools: config.tools.planner,
        jsonSchema: schema,
        maxBudget: config.budgets.planner * 2,
        cwd: projectRoot,
      });

      this.logger.attachToSession(session.handle, log, { role: 'planner', phase: '3a' });

      // Bounded corrective-turn loop: at most ONE extra turn is spent on
      // this SAME call-local session when the full validation chain below
      // rejects the plan for a retryable structural/scope rule. Retry
      // state lives only in this local counter — no persisted state, no
      // instance field — and the loop always exits after at most two
      // sendPrompt() turns.
      const retryableLintRuleIds = new Set([
        'structure-cap-missions',
        'structure-cap-milestones',
        'declared-duplicate',
        'T1',
        'T2',
      ]);
      let lintRetriesUsed = 0;
      let userPrompt = prompt;
      let plan;

      for (;;) {
        if (lintRetriesUsed === 0) {
          // First turn: accounting unchanged from the pre-retry-loop
          // behavior — 'planner-global' name, phase '3a', summary derived
          // from the shared per-call log file.
          const result = await session.sendPrompt(userPrompt);
          plan = this._extractJson(result);

          const summary = this.logger.getSessionSummary(log.logPath);
          await this.logger.writeSessionSummary('planner-global', summary, { role: 'planner', phase: '3a' });
          await this.tokenTracker?.recordSession('planner-global', 'planner', result, {
            phase: '3a',
            systemPromptTokens: session.handle.systemPromptTokens,
            toolCallCount: session.handle._toolCallCount,
          });
        } else {
          // Corrective turn: accounted separately under a distinct name
          // (e.g. 'planner-global-turn2'). The shared log file mixes
          // events from every turn on this reusable session, so the
          // summary's token/cost/duration fields are derived from the SDK
          // result event directly instead of getSessionSummary(log.logPath).
          const turnIdx = session.turnCount + 1;
          const turnName = `planner-global-turn${turnIdx}`;
          const turnStartedAt = new Date().toISOString();
          const turnStartMs = Date.now();

          const result = await session.sendPrompt(userPrompt);

          const turnFinishedAt = new Date().toISOString();
          const turnDurationMs = Date.now() - turnStartMs;

          await this.tokenTracker?.recordSession(turnName, 'planner', result, {
            phase: '3a',
            reused: true,
            turnIdx,
            systemPromptTokens: session.handle.systemPromptTokens,
            toolCallCount: session.handle._toolCallCount,
          });

          const usage = result?.usage || {};
          const perTurnSummary = {
            events: null, // not reliably attributable per-turn in a shared log
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            cacheCreation: usage.cache_creation_input_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            totalCost: result?.total_cost_usd || 0,
            toolCalls: null, // same as events — not per-turn attributable
            durationMs: turnDurationMs,
            startedAt: turnStartedAt,
            finishedAt: turnFinishedAt,
          };
          await this.logger.writeSessionSummary(turnName, perTurnSummary, {
            role: 'planner',
            phase: '3a',
            reused: true,
            turnIdx,
          });

          plan = this._extractJson(result);
        }

        // Parse + validate after the turn is accounted (an _extractJson
        // failure above propagates immediately and is never caught by the
        // retry logic below — it never spends a corrective turn).
        try {
          if (opts.mode === 'small-task' && Array.isArray(plan.milestones) && plan.milestones.length > config.smallTask.maxMilestones) {
            this.logger.warn(`[planner] small-task mode: planner returned ${plan.milestones.length} milestones, truncating to ${config.smallTask.maxMilestones}`);
            plan.milestones = plan.milestones.slice(0, config.smallTask.maxMilestones);
          }

          // planGlobal-time pure-omission catcher (the 165 class per-mission
          // lintPlanScope cannot see across missions). Requires each
          // non-milestone-only acceptance command's path tokens to be covered
          // by at least one mission's declared targetFiles across the plan.
          // No-op when missions declare no targetFiles (schema is optional
          // there) or when the spec ships no ACs.
          lintGlobalPlanScope(
            plan,
            Array.isArray(opts.specTargetFiles) ? opts.specTargetFiles : [],
            Array.isArray(opts.specAcceptanceCriteria) ? opts.specAcceptanceCriteria : [],
            { projectRoot },
          );

          // plan-structure-lint: mission/milestone leg counts + same-milestone
          // declared-duplicate targetFiles (L1/L2/L3), plus tree-purity check
          // shapes on any tasks the global plan already carries. Both throw a
          // plain Error prefixed '[plan-structure-lint]' on violation.
          lintPlanStructure(plan, opts.specPlanStructure, { projectRoot });
          lintTaskCheckShapes(plan, { projectRoot });
        } catch (err) {
          const retryable = typeof err?.ruleId === 'string' && retryableLintRuleIds.has(err.ruleId);
          if (retryable && lintRetriesUsed < 1) {
            lintRetriesUsed++;
            const violationCount = Array.isArray(err.violations) ? err.violations.length : 0;
            this.logger.warn(
              `[plan-lint-retry] planGlobal: plan rejected by lint rule ${err.ruleId} ` +
              `(${violationCount} violation(s)); sending one corrective turn to the planner session`,
            );
            userPrompt = buildPlanLintCorrectionPrompt(Array.isArray(err.violations) ? err.violations : []);
            continue;
          }
          // Second violation of any rule, a non-retryable rule id (e.g.
          // 'global-uncovered-token'), or an error without a ruleId:
          // propagate unchanged.
          throw err;
        }

        break;
      }

      return plan;
    } finally {
      if (session) {
        try {
          await session.close();
        } catch {
          // swallow — session may have already errored
        }
      }
      log.close();
    }
  }

  /**
   * Phase 3a steps 5-6: Verify planner assumptions against the codebase.
   *
   * Spawns a dedicated verification session with Read/Glob/Grep tools.
   * Each assumption is checked and classified as verified/failed/uncertain.
   *
   * @param {{text: string, specSection: string}[]} assumptions - Natural language assumptions from planGlobal (may also be plain strings for backward compat)
   * @param {string} projectRoot
   * @returns {Promise<Array<{assumption: string, status: string, evidence: string}>>}
   */
  async verifyAssumptions(assumptions, projectRoot) {
    if (!assumptions || assumptions.length === 0) return [];

    // Partition assumptions into current (invariant/untagged) and deferred (post-fix)
    const currentItems = [];
    const currentIndices = [];
    const deferredItems = [];
    const deferredIndices = [];
    assumptions.forEach((a, i) => {
      const phase = typeof a === 'string' ? undefined : a.phase;
      if (phase === 'post-fix') {
        deferredItems.push(a);
        deferredIndices.push(i);
      } else {
        currentItems.push(a);
        currentIndices.push(i);
      }
    });

    // Build synthetic deferred results for post-fix items
    const deferredResults = deferredItems.map((a) => ({
      assumption: a,
      status: 'deferred',
      evidence: 'Post-fix assumption — deferred until after execution',
    }));

    // If all assumptions are deferred, skip the spawn entirely
    if (currentItems.length === 0) {
      return deferredResults;
    }

    const prompt = `Verify each of the following assumptions about this codebase.
For each one, search the code (use Glob to find files, Grep to search content, Read to inspect)
and classify as:
- "verified" — confirmed by code evidence
- "failed" — contradicted by code evidence (explain what you found instead)
- "uncertain" — could not confirm or deny (explain what you checked)

Identity vs scenery (CRITICAL): assumptions may include precision scenery (line numbers, exact file lengths, exact array counts, verbatim quotes of current code). Classify based on FUNCTIONAL IDENTITY, not on literal coordinates:
- If the assumption asserts "function X is at line 616" and X exists in the file but at a different line → mark "verified" with evidence noting the line drift. Line-number mismatch ALONE is NOT a failed assumption.
- If the assumption asserts "file X is about 350 lines" and the file exists but is 314 lines → mark "verified" with evidence noting the length drift. Approximate length is not load-bearing.
- If the assumption asserts "EXPECTED has 22 entries" and EXPECTED exists with N≠22 entries → mark "verified" with evidence noting the count drift (unless the assumption was about a specific item name; that is a real identity claim).
- Reserve "failed" for genuine functional contradictions: file or symbol absent, declared field of an object missing, type/shape genuinely mismatched, declared semantic clause not present in the prompt text at all.
- If you cannot execute code (e.g. cannot run the project's test suite to verify it passes), do NOT mark "failed" — that is "uncertain". But also avoid marking pre-state assumptions about test-suite-currently-passing; those are post-fix expectations that should defer.

Assumptions to verify:
${currentItems.map((a, i) => `${i + 1}. ${typeof a === 'string' ? a : a.text}`).join('\n')}

Return structured JSON with your findings.`;

    const schema = {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              assumption: { type: 'string' },
              status: { type: 'string', enum: ['verified', 'failed', 'uncertain', 'deferred'] },
              evidence: { type: 'string' },
            },
            required: ['assumption', 'status', 'evidence'],
          },
        },
      },
      required: ['results'],
    };

    const log = this.logger.createSessionLog('assumption-verifier');

    // Inner attempt: spawn + await + parse + merge. Identical to the
    // original success-path body. A genuine model `uncertain` verdict
    // returned by a SUCCESSFUL session flows through here untouched.
    const attemptVerification = async () => {
      const spawnPromise = this.sessionManager.spawn({
        name: 'assumption-verifier',
        prompt,
        systemPrompt: 'You are a codebase inspector. Your ONLY job is to verify assumptions about the codebase by reading and searching code. Be thorough — check multiple locations. Report exactly what you find.',
        model: config.execution.plannerModel,
        tools: config.tools.planner,
        jsonSchema: schema,
        maxBudget: config.budgets.planner,
        cwd: projectRoot,
      });

      this.logger.attachToSession(spawnPromise.handle, log, {
        role: 'assumption-verifier',
        phase: '3a-verify',
      });

      const { handle, result } = await spawnPromise;
      const parsed = this._extractJson(result);

      const summary = this.logger.getSessionSummary(log.logPath);
      await this.logger.writeSessionSummary('assumption-verifier', summary, {
        role: 'assumption-verifier',
        phase: '3a-verify',
      });
      await this.tokenTracker?.recordSession('assumption-verifier', 'planner', result, {
        phase: '3a-verify',
        systemPromptTokens: handle.systemPromptTokens,
        toolCallCount: handle._toolCallCount,
      });

      // Map verifier results back to currentItems, then merge deferred results
      const currentResults = (parsed.results || []).map((result, index) => ({ ...result, assumption: currentItems[index] }));
      // Merge: fill an array in original order
      const merged = new Array(assumptions.length);
      currentResults.forEach((r, i) => { merged[currentIndices[i]] = r; });
      deferredResults.forEach((r, i) => { merged[deferredIndices[i]] = r; });
      return merged.filter(Boolean);
    };

    try {
      // Bounded retry: re-spawn the verification session on a RETRYABLE
      // InfrastructureError ("the check did not run"). A non-retryable
      // infra error, or exhausting retries, re-throws so the run halts
      // resumably — it must NEVER be mapped to `uncertain`. Any other
      // (non-InfrastructureError) throw keeps the original map-to-uncertain
      // fallback unchanged.
      for (let attempt = 0; attempt <= MAX_INFRA_RETRIES; attempt++) {
        try {
          return await attemptVerification();
        } catch (err) {
          if (err instanceof InfrastructureError) {
            if (err.retryable && attempt < MAX_INFRA_RETRIES) {
              this.logger.warn(`[planner] assumption-verifier hit retryable infrastructure error (attempt ${attempt + 1}/${MAX_INFRA_RETRIES + 1}), retrying: ${err.message}`);
              continue;
            }
            // Non-retryable, or retries exhausted: re-throw so the run
            // halts resumably. Do NOT map to uncertain, do NOT swallow.
            throw err;
          }
          // Non-InfrastructureError: keep the existing map-to-uncertain fallback.
          const uncertainResults = currentItems.map((a) => ({
            assumption: a,
            status: 'uncertain',
            evidence: `Verification session failed: ${err.message}`,
          }));
          const merged = new Array(assumptions.length);
          uncertainResults.forEach((r, i) => { merged[currentIndices[i]] = r; });
          deferredResults.forEach((r, i) => { merged[deferredIndices[i]] = r; });
          return merged.filter(Boolean);
        }
      }
    } finally {
      log.close();
    }
  }

  async planMission(missionId, projectRoot, context = {}) {
    const maxTasks = context.mode === 'small-task'
      ? config.smallTask.maxTasksPerMission
      : (context.maxTasksPerSubMission || config.execution.maxTasksPerSubMission);

    return this._planMissionReusable(missionId, projectRoot, context, maxTasks);
  }

  /**
   * Reusable-session path: use (or lazily create) a long-lived SDK
   * session that handles all planMission calls within this run. Each
   * call sends a new user prompt to the existing session; the SDK's
   * prompt cache stays warm across turns.
   *
   * Session/log/cache behavior:
   *   - All turns share ONE log file (planner-reusable.jsonl) and ONE
   *     SessionHandle. Per-turn metadata is recorded via
   *     tokenTracker.recordSession() with a turn-specific name.
   *   - The SDK result for this turn is routed back via the reusable
   *     session's sendPrompt promise (see ReusableSession).
   *   - If the underlying SDK session errors mid-run, subsequent
   *     planMission calls will throw. The caller (pipeline.js) should
   *     handle this by retrying. For now, we propagate the error.
   *
   * Expected payoff: documented in docs/audit/phase-1-overhead-audit.md.
   * Hypothesis: 30-70% reduction in planner cacheCreation tokens
   * across a multi-mission run. Validation requires a live dogfood.
   */
  async _planMissionReusable(missionId, projectRoot, context, maxTasks) {
    // Mission-boundary rotation check: this MUST run before
    // _ensureReusableSession() so a rotation decision (and the resulting
    // close/reopen) can only ever happen at a mission boundary, never
    // mid-decomposition (e.g. mid-turn or mid-retry). If a reusable
    // session is currently open and either the mission-count threshold or
    // the token-based force-new threshold has been crossed, close the
    // existing session and bump the sequence counter so the subsequent
    // _ensureReusableSession() call below lazily reopens a fresh one.
    // On a first-ever call (no open session, zero counters) this is a
    // guaranteed no-op: no rotation, no warn/alarm events.
    if (this._reusableSession) {
      const sessionName = this._reusableSessionName;
      const contextTokens = this._sessionContextTokens;
      const missionCount = this._sessionMissionCount;

      const forceNew = Boolean(this.tokenTracker?.shouldForceNewSession?.(contextTokens));
      const missionCountExceeded = missionCount >= config.tokens.rotationMissionCount;

      // warn and alarm are evaluated independently of the rotation
      // decision (alarm can co-occur with a rotation), except that warn
      // is explicitly suppressed once shouldForceNewSession is true — a
      // warn-alone must never rotate, but once we're already in
      // force-new territory the warn signal is superseded by the
      // rotation/alarm signal.
      if (this.tokenTracker?.shouldWarn?.(contextTokens) && !forceNew) {
        this._recordRotationEvent('warn', { sessionName, missionId, contextTokens, missionCount });
      }
      if (this.tokenTracker?.shouldAlarm?.(contextTokens)) {
        this._recordRotationEvent('alarm', { sessionName, missionId, contextTokens, missionCount });
      }

      if (missionCountExceeded || forceNew) {
        await this.closeReusableSession();
        this._reusableSessionSeq += 1;
        this._sessionContextTokens = 0;
        this._sessionMissionCount = 0;

        this._recordRotationEvent('rotated', { sessionName, missionId, contextTokens, missionCount });
      }
    }

    const session = this._ensureReusableSession(projectRoot, maxTasks);

    // Prior-mission digest injection: only the FIRST turn of a freshly
    // opened reusable session may carry the digest block. Freshness is
    // captured HERE, before this call's first sendPrompt, so that later
    // missions reusing the same open session (turnCount > 0 by then) never
    // see it, and the corrective lint-retry prompt built further below
    // (which replaces userPrompt wholesale) never sees it either. The
    // digest is expected to arrive pre-rendered by the caller (mission
    // ids, task ids, targetFiles) — this is a pure string prepend, no
    // model call, no reformatting.
    const isFreshSession = session.turnCount === 0;
    const priorMissionDigest = context.priorMissionDigest;
    const hasDigest = typeof priorMissionDigest === 'string' && priorMissionDigest.trim().length > 0;

    // Bounded plan-lint feedback retry: at most ONE corrective turn per
    // invocation, tracked in this LOCAL counter (no persisted state).
    // Retryable rule ids are the planner-fixable violations reachable at
    // this call site; classification is duck-typed on err.ruleId presence
    // and membership — never instanceof.
    const retryableLintRuleIds = new Set(['T1', 'T2', 'scope-excursion']);
    let lintRetriesUsed = 0;
    const missionUserPrompt = buildMissionUserPrompt(missionId, context.missionPlan, context.specConstraints);
    let userPrompt = (isFreshSession && hasDigest)
      ? `Previously planned missions (binding context):\n${priorMissionDigest}\n\n${missionUserPrompt}`
      : missionUserPrompt;
    let plan;

    for (;;) {
      // Each turn records itself as a separate tokenTracker entry so
      // per-mission cost attribution still works. The per-turn metadata
      // carries the missionId and a turn index. A corrective retry turn
      // goes through this SAME block — same session, same accounting.
      const turnIdx = session.turnCount + 1;
      const turnName = `planner-mission-${missionId}-turn${turnIdx}`;

      // Track per-turn wall time so session-summary.json has a
      // durationMs field that the overhead analyzer can consume.
      const turnStartedAt = new Date().toISOString();
      const turnStartMs = Date.now();

      const result = await session.sendPrompt(userPrompt);

      const turnFinishedAt = new Date().toISOString();
      const turnDurationMs = Date.now() - turnStartMs;

      // Rotation accounting: _sessionContextTokens tracks the conversation-
      // prefix size of the MOST RECENT turn only. It is REPLACED (not
      // accumulated) on every turn so repeated turns with identical usage
      // don't inflate the figure across the loop.
      {
        const rotationUsage = result?.usage || {};
        this._sessionContextTokens = (rotationUsage.input_tokens || 0)
          + (rotationUsage.cache_read_input_tokens || 0)
          + (rotationUsage.cache_creation_input_tokens || 0);
      }

      // Account the turn BEFORE any parsing/validation that could throw. The
      // session-manager discards the reusable handle-name in-flight estimate at
      // the turn boundary, so if recordSession ran only after the validators
      // below, a validator failure would drop the turn's real token spend from
      // usage entirely. recordSession + the per-turn summary depend only on the
      // SDK result, not the parsed plan, so they run first.
      await this.tokenTracker?.recordSession(turnName, 'planner', result, {
        phase: '3b',
        missionId,
        reused: true,
        turnIdx,
        systemPromptTokens: session.handle.systemPromptTokens,
        toolCallCount: session.handle._toolCallCount,
      });

      // Also write a per-turn entry to session-summary.json. Without
      // this, scripts/analyze-overhead.js cannot see reusable-session
      // turns — the analyzer reads session-summary.json, and the
      // validation workflow (compare planner cacheCreation across runs)
      // depends on having per-turn entries. The non-reusable session
      // helpers (e.g. planGlobal) call writeSessionSummary() via
      // getSessionSummary() which reads the log file; for reusable turns
      // we derive the summary fields from the SDK result event directly,
      // since the shared log file mixes events from all turns and can't
      // be split per-turn reliably. (Bug caught in Copilot review, 2026-04-09.)
      const usage = result?.usage || {};
      const perTurnSummary = {
        events: null, // not reliably attributable per-turn in a shared log
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheCreation: usage.cache_creation_input_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
        totalCost: result?.total_cost_usd || 0,
        toolCalls: null, // same as events — not per-turn attributable
        durationMs: turnDurationMs,
        startedAt: turnStartedAt,
        finishedAt: turnFinishedAt,
      };
      await this.logger.writeSessionSummary(turnName, perTurnSummary, {
        role: 'planner',
        phase: '3b',
        missionId,
        reused: true,
        turnIdx,
      });

      // Parse + validate after the turn is accounted (these may throw).
      // The retry structure wraps ONLY the validation chain below — an
      // _extractJson failure never triggers a lint retry.
      plan = this._extractJson(result);
      try {
        _validatePathAnchorPreservation(plan, context.specTargetFiles || [], projectRoot);
        const declaredSet = buildDeclaredSet(context.specTargetFiles || [], context.specAcceptanceCriteria || []);
        if (declaredSet.size > 0) {
          lintPlanScope(plan, declaredSet, {
            projectRoot,
            specTargetFiles: context.specTargetFiles || [],
            specAcceptanceCriteria: context.specAcceptanceCriteria || [],
          });
        }
        // plan-structure-lint: run UNCONDITIONALLY (independent of declaredSet),
        // covering mission/milestone leg counts + same-milestone duplicate
        // targetFiles (no-op here since a mission plan carries no milestones)
        // and tree-purity check shapes on this mission's own tasks. Both throw
        // a PlanLintError prefixed '[plan-structure-lint]' on violation.
        lintPlanStructure(plan, context.specPlanStructure, { projectRoot });
        lintTaskCheckShapes(plan, { projectRoot });
      } catch (err) {
        const retryable = typeof err?.ruleId === 'string' && retryableLintRuleIds.has(err.ruleId);
        if (retryable && lintRetriesUsed < 1) {
          lintRetriesUsed++;
          const violationCount = Array.isArray(err.violations) ? err.violations.length : 0;
          this.logger.warn(
            `[plan-lint-retry] mission ${missionId}: plan rejected by lint rule ${err.ruleId} ` +
            `(${violationCount} violation(s)); sending one corrective turn to the planner session`,
          );
          userPrompt = buildPlanLintCorrectionPrompt(Array.isArray(err.violations) ? err.violations : []);
          continue;
        }
        // Second violation of any rule, a non-retryable rule id, or an
        // error without a ruleId: propagate unchanged. Record the
        // corrective turn's outcome when one was spent.
        if (lintRetriesUsed > 0) {
          const rejectedBy = typeof err?.ruleId === 'string' ? `lint rule ${err.ruleId}` : (err?.name || 'Error');
          this.logger.warn(
            `[plan-lint-retry] mission ${missionId}: corrective turn REJECTED by ${rejectedBy}; failing the plan`,
          );
        }
        throw err;
      }
      if (lintRetriesUsed > 0) {
        this.logger.warn(`[plan-lint-retry] mission ${missionId}: corrective turn ACCEPTED; plan passes the validation chain`);
      }
      break;
    }

    // WARN-level: same-milestone sibling missions' already-planned task
    // targetFiles that collide with this mission's own — never throws;
    // surfaced through the same scopeWarnings channel as scope-mapping
    // consistency warnings.
    const crossMissionWarnings = warnCrossMissionDuplicates(
      plan,
      context.siblingMissionTaskTargets || {},
      { projectRoot, missionId },
    );
    this._surfaceScopeMappingWarnings(plan, crossMissionWarnings, 'planMission');
    const scopeMappingWarnings = checkScopeMappingConsistency(plan, context.scopeMapping || [], {
      scopeItems: context.scopeItems || [],
      currentMissionId: missionId,
      projectRoot,
    });
    const filteredScopeMappingWarnings = Array.isArray(scopeMappingWarnings)
      ? scopeMappingWarnings.filter((w) => !(w && typeof w.description === 'string'
        && w.description.includes('references unknown missionId')))
      : scopeMappingWarnings;
    this._surfaceScopeMappingWarnings(plan, filteredScopeMappingWarnings, 'planMission');
    this._warnIfVagueDescriptions(plan, 'planMission');
    const rejectedPhrases = extractRejectedPhrases(context?.specConstraints || []);
    this._warnIfRejectedBehavior(plan, rejectedPhrases, 'planMission');
    this._enforceSequentialOrdering(plan);

    // Increment exactly once per successful planMission turn: the plan has
    // passed the full validation chain (including any corrective lint-retry
    // turn) and we are about to return it. An invocation that throws out of
    // the validation chain above never reaches this line.
    this._sessionMissionCount += 1;

    return plan;
  }

  /**
   * Remediate uncovered scenarios by spawning a secondary planner session.
   * Returns additional tasks to cover the gaps, or out-of-scope justifications.
   *
   * @param {string} missionId
   * @param {string} projectRoot
   * @param {object} context
   * @param {string[]} context.uncoveredScenarios - Lines like "S3: user logs out"
   * @param {string} context.missionPlan - Mission plan content
   * @returns {Promise<{newTasks: Array, outOfScope: Array}>}
   */
  async remediateScenarios(missionId, projectRoot, context = {}) {
    const prompt = `Mission ${missionId} has uncovered spec scenarios that no task traces to.

Uncovered scenarios:
${context.uncoveredScenarios.map((s) => `  - ${s}`).join('\n')}

${context.missionPlan ? `Mission plan:\n${context.missionPlan}` : ''}

For each uncovered scenario, either:
1. Propose a new task to cover it (with id, description, targetFiles, tracesScenario)
2. Mark it as out-of-scope with justification

New task IDs should continue from existing tasks in mission ${missionId}.
Each task's subMissionId must name an EXISTING sub-mission of this mission — never invent a new sub-mission id. Task ids follow the pattern {subMissionId}-{seq}.`;

    const schema = {
      type: 'object',
      properties: {
        newTasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              subMissionId: { type: 'string' },
              description: { type: 'string' },
              targetFiles: { type: 'array', items: { type: 'string' } },
              tracesScenario: { type: 'array', items: { type: 'string' } },
              testCases: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'subMissionId', 'description', 'targetFiles', 'tracesScenario'],
          },
        },
        outOfScope: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              scenarioId: { type: 'string' },
              justification: { type: 'string' },
            },
            required: ['scenarioId', 'justification'],
          },
        },
      },
      required: ['newTasks', 'outOfScope'],
    };

    const log = this.logger.createSessionLog(`planner-remediate-${missionId}`);

    try {
      const spawnPromise = this.sessionManager.spawn({
        name: `planner-remediate-${missionId}`,
        prompt,
        systemPrompt: 'You are a software architect fixing scenario coverage gaps in a task decomposition. Explore the codebase to understand what tasks are needed.',
        model: config.execution.plannerModel,
        tools: config.tools.planner,
        jsonSchema: schema,
        maxBudget: config.budgets.planner,
        cwd: projectRoot,
      });

      this.logger.attachToSession(spawnPromise.handle, log, {
        role: 'planner',
        phase: '3b-remediate',
        missionId,
      });

      const { handle, result } = await spawnPromise;
      await this.tokenTracker?.recordSession(`planner-remediate-${missionId}`, 'planner', result, {
        phase: '3b-remediate',
        missionId,
        systemPromptTokens: handle.systemPromptTokens,
        toolCallCount: handle._toolCallCount,
      });
      const plan = this._extractJson(result);
      // plan-structure-lint: no-op on L1/L2/L3 (this plan carries no
      // milestones/missions) but still lints this remediation's newTasks[]
      // for tree-purity check shapes. Throws a plain Error prefixed
      // '[plan-structure-lint]' on violation.
      lintPlanStructure(plan, context.specPlanStructure, { projectRoot });
      lintTaskCheckShapes(plan, { projectRoot });
      return plan;
    } finally {
      log.close();
    }
  }

  /**
   * Remediate a single invalid planner assumption by spawning a short-lived
   * planner session. Returns the revised task description and the minimal
   * spec edit needed to prevent the assumption from resurfacing.
   *
   * @param {string} assumption - The assumption text that was found invalid
   * @param {string} evidence   - Evidence from the verifier that invalidated it
   * @param {string} specExcerpt - Relevant excerpt from the spec document
   * @returns {Promise<{revisedAssumptions: Array<{text: string, phase: 'invariant'|'post-fix', specSection?: string}>, specEdit: {section: string, old: string, new: string}}>}
   */
  async remediateAssumption(assumption, evidence, specExcerpt) {
    const prompt = `A planner assumption has been found invalid by the verifier.

Assumption:
${assumption}

Verifier evidence:
${evidence}

Spec excerpt:
${specExcerpt}

Return a \`revisedAssumptions\` array where each entry is a corrected assumption object with explicit \`text\` and \`phase\` fields ('invariant' or 'post-fix').

Tense discipline rules:
- invariant assumptions use present-tense ('exports', 'accepts') — facts that are true before and after the fix
- post-fix assumptions use future-tense ('will export', 'will accept') — facts that become true only after the fix is applied
- NEVER mix tenses within a single \`text\` value; if the original conflated both, split into two entries

Bad example (single vague revised string — do NOT do this):
{ "revised": "The module handles config correctly." }

Good example (properly split revisedAssumptions array with phase tags — do this):
{
  "revisedAssumptions": [
    { "text": "The module accepts a config object.", "phase": "invariant" },
    { "text": "The module will export a validated config shape.", "phase": "post-fix" }
  ]
}

Also propose the minimal spec edit needed so this assumption does not resurface in future planning runs.

Do not reference line numbers, line ranges, or column offsets in rewritten spec text or assumption text. Describe semantics, not positions (e.g. write 'the function that exports config' instead of 'the function at line 42'). References like 'line 10', 'lines 5-20', or 'column 8' become stale after any edit and must never appear in spec edits or revisedAssumptions entries.`;

    const log = this.logger.createSessionLog('planner-remediate-assumption');

    try {
      const spawnPromise = this.sessionManager.spawn({
        name: 'planner-remediate-assumption',
        prompt,
        systemPrompt: 'You are a software architect fixing a single invalid planner assumption flagged by the verifier. Fix ONLY what the verifier flagged — do not broaden the scope, do not propose unrelated changes. Return a `revisedAssumptions` array (each entry tagged with phase) and the minimal spec edit.',
        model: config.execution.plannerModel,
        tools: config.tools.planner,
        jsonSchema: assumptionRemediationSchema,
        maxBudget: config.budgets.planner,
      });

      this.logger.attachToSession(spawnPromise.handle, log, {
        role: 'planner',
        phase: 'remediate-assumption',
      });

      const { handle, result } = await spawnPromise;
      await this.tokenTracker?.recordSession('planner-remediate-assumption', 'planner', result, {
        phase: 'remediate-assumption',
        systemPromptTokens: handle.systemPromptTokens,
        toolCallCount: handle._toolCallCount,
      });
      return this._extractJson(result);
    } finally {
      log.close();
    }
  }

  /**
   * Re-extract assumptions from a spec file by spawning a focused planner session.
   * Returns {text, specSection, phase}[] matching planGlobal's assumptions array item schema.
   *
   * Use this when assumptions need to be freshly derived from an updated spec (e.g.
   * after spec edits during remediation, or when resuming from a checkpoint that
   * lacks an assumptions array).
   *
   * @param {string} specPath     - Absolute path to the spec file to read
   * @param {string} projectRoot  - Root directory of the project
   * @returns {Promise<Array<{text: string, specSection: string, phase: 'invariant'|'post-fix'}>>}
   */
  async reExtractAssumptions(specPath, projectRoot) {
    const prompt = `Read the spec file at ${specPath} and extract all planner assumptions it implies.

For each assumption you identify, return an object with:
  - text: the assumption text (present-tense for invariant, future-tense for post-fix)
  - specSection: the exact heading text of the spec section the assumption relates to (use "general" if none)
  - phase: "invariant" (must hold before work begins) or "post-fix" (true only after implementation)

Tense discipline:
  - invariant: present-tense (e.g. "File X exports function Y")
  - post-fix: future-tense (e.g. "After this mission, module Z will accept parameter W")

If the spec implies no verifiable assumptions, return an empty array.

Return structured JSON matching the session's jsonSchema.`;

    const schema = {
      type: 'object',
      properties: {
        assumptions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              specSection: { type: 'string' },
              phase: { type: 'string', enum: ['invariant', 'post-fix'] },
            },
            required: ['text', 'specSection'],
          },
        },
      },
      required: ['assumptions'],
    };

    const log = this.logger.createSessionLog('planner-reextract-assumptions');

    try {
      const spawnPromise = this.sessionManager.spawn({
        name: 'planner-reextract-assumptions',
        prompt,
        systemPrompt: 'You are a software architect extracting verifiable assumptions from a spec file. Read the spec thoroughly and identify every assumption about existing code, APIs, or system state that needs to be checked before work begins. Tag each assumption with its phase (invariant or post-fix) and the spec section it relates to.',
        model: config.execution.plannerModel,
        tools: config.tools.planner,
        jsonSchema: schema,
        maxBudget: config.budgets.planner,
        cwd: projectRoot,
      });

      this.logger.attachToSession(spawnPromise.handle, log, {
        role: 'planner',
        phase: 'reextract-assumptions',
      });

      const { handle, result } = await spawnPromise;
      const parsed = this._extractJson(result);

      const summary = this.logger.getSessionSummary(log.logPath);
      await this.logger.writeSessionSummary('planner-reextract-assumptions', summary, {
        role: 'planner',
        phase: 'reextract-assumptions',
      });
      await this.tokenTracker?.recordSession('planner-reextract-assumptions', 'planner', result, {
        phase: 'reextract-assumptions',
        systemPromptTokens: handle.systemPromptTokens,
        toolCallCount: handle._toolCallCount,
      });

      return Array.isArray(parsed.assumptions) ? parsed.assumptions : [];
    } finally {
      log.close();
    }
  }

  /**
   * Remediate critical findings from a reviewer session by spawning a short-lived
   * planner session scoped ONLY to the flagged files. Returns new tasks to address
   * the findings.
   *
   * @param {string} milestoneId - The milestone ID the findings belong to
   * @param {Array<{file: string, description: string}>} findings - Critical findings from the reviewer
   * @param {string} projectRoot - Root directory of the project
   * @returns {Promise<{newTasks: Array}>}
   */
  async remediateReviewFindings(milestoneId, findings, projectRoot, opts = {}) {
    // A finding's true fix location may live in one of its relatedFiles
    // rather than the primary file — widen the allowed-files list with
    // them, or a correct fix would be unproposable under the hard scope.
    const flaggedFiles = [...new Set(findings.flatMap((f) => [
      f.file,
      ...(Array.isArray(f.relatedFiles) ? f.relatedFiles : []),
    ]))];

    const prompt = `Milestone ${milestoneId} has critical review findings that require new tasks.

Critical findings:
${findings.map((f) => `  - File: ${f.file}\n${Array.isArray(f.relatedFiles) && f.relatedFiles.length > 0 ? `    Related files: ${f.relatedFiles.join(', ')}\n` : ''}    Description: ${f.description}`).join('\n')}

For each finding, propose a new task (with id, description, targetFiles) to address it.
New task IDs should continue from existing tasks in milestone ${milestoneId}.
Each task's subMissionId must name an EXISTING sub-mission of this mission — never invent a new sub-mission id. Task ids follow the pattern {subMissionId}-{seq}.`;

    const log = this.logger.createSessionLog(`planner-review-remediate-${milestoneId}`);

    try {
      const spawnPromise = this.sessionManager.spawn({
        name: `planner-review-remediate-${milestoneId}`,
        prompt,
        systemPrompt: `You are a software architect creating tasks to fix critical review findings. Scope your analysis ONLY to the flagged files and their listed related files: ${flaggedFiles.join(', ')}. Do not propose changes to other files.`,
        model: config.execution.plannerModel,
        tools: config.tools.planner,
        jsonSchema: reviewRemediationSchema,
        maxBudget: config.budgets.planner,
        cwd: projectRoot,
      });

      this.logger.attachToSession(spawnPromise.handle, log, {
        role: 'planner',
        phase: 'review-remediate',
        milestoneId,
      });

      const { handle, result } = await spawnPromise;
      await this.tokenTracker?.recordSession(
        `planner-review-remediate-${milestoneId}`,
        'planner',
        result,
        {
          phase: 'review-remediate',
          milestoneId,
          systemPromptTokens: handle.systemPromptTokens,
          toolCallCount: handle._toolCallCount,
        },
      );

      let remPlan;
      try {
        remPlan = this._extractJson(result);
      } catch (err) {
        this.logger.warn(
          `[planner] remediateReviewFindings(${milestoneId}): failed to extract structured output — ` +
          `returning empty newTasks. Cause: ${err.message}`,
        );
        return { newTasks: [] };
      }

      const specTargetFiles = Array.isArray(opts.specTargetFiles) ? opts.specTargetFiles : [];
      _validatePathAnchorPreservation(remPlan, specTargetFiles, projectRoot);
      const specAcceptanceCriteria = Array.isArray(opts.specAcceptanceCriteria) ? opts.specAcceptanceCriteria : [];
      const declaredSet = buildDeclaredSet(specTargetFiles, specAcceptanceCriteria);
      if (declaredSet.size > 0) {
        lintPlanScope(remPlan, declaredSet, {
          projectRoot,
          specTargetFiles,
          specAcceptanceCriteria,
        });
      }
      const scopeMapping = Array.isArray(opts.scopeMapping) ? opts.scopeMapping : [];
      const scopeMappingWarnings = checkScopeMappingConsistency(remPlan, scopeMapping);
      this._surfaceScopeMappingWarnings(remPlan, scopeMappingWarnings, `remediateReviewFindings(${milestoneId})`);

      // Normalise: if the SDK returned a valid object but without the
      // expected newTasks key (schema mismatch), wrap it so the
      // pipeline's empty-newTasks guard catches it cleanly rather than
      // hitting a TypeError on remPlan.newTasks?.length.
      if (!remPlan || typeof remPlan !== 'object' || !Array.isArray(remPlan.newTasks)) {
        this.logger.warn(
          `[planner] remediateReviewFindings(${milestoneId}): structured output missing newTasks array — ` +
          `returning empty newTasks. Got: ${JSON.stringify(remPlan)}`,
        );
        return { newTasks: [] };
      }

      return remPlan;
    } finally {
      log.close();
    }
  }

  /**
   * Remediate critical findings from a regression report by spawning a short-lived
   * planner session scoped ONLY to the flagged files. Returns new tasks to address
   * the findings.
   *
   * @param {string} milestoneId - The milestone ID the findings belong to
   * @param {Array<{file: string, description: string}>} findings - Findings from the regression report
   * @param {string} projectRoot - Root directory of the project
   * @returns {Promise<{newTasks: Array}>}
   */
  async remediateRegressionFailure(milestoneId, findings, projectRoot, opts = {}) {
    // Same relatedFiles widening as remediateReviewFindings (twin builder,
    // kept symmetric) — though regression findings currently never carry
    // relatedFiles (the markdown-report fallback synthesizes bare
    // {file, description} entries).
    const flaggedFiles = [...new Set(findings.flatMap((f) => [
      f.file,
      ...(Array.isArray(f.relatedFiles) ? f.relatedFiles : []),
    ]))];

    const prompt = `Milestone ${milestoneId} has critical regression report findings that require new tasks.

Critical findings:
${findings.map((f) => `  - File: ${f.file}\n${Array.isArray(f.relatedFiles) && f.relatedFiles.length > 0 ? `    Related files: ${f.relatedFiles.join(', ')}\n` : ''}    Description: ${f.description}`).join('\n')}

For each finding, propose a new task (with id, description, targetFiles) to address it.
New task IDs should continue from existing tasks in milestone ${milestoneId}.
Each task's subMissionId must name an EXISTING sub-mission of this mission — never invent a new sub-mission id. Task ids follow the pattern {subMissionId}-{seq}.`;

    // The regression report is markdown; when its JSON.parse fallback
    // synthesizes findings the only "file" is the literal 'unknown' — a
    // hard scope naming a nonexistent filename would misdirect the
    // planner. In that case (or with no flagged files at all) drop the
    // hard-scope clause and instruct the planner to identify the real
    // files from the findings text, bounded by the milestone's declared
    // targetFiles when the call site provided them.
    const hasUsableFlaggedFiles = flaggedFiles.some((f) => f && f !== 'unknown');
    const milestoneTargetFiles = Array.isArray(opts.milestoneTargetFiles) ? opts.milestoneTargetFiles : [];
    const scopeClause = hasUsableFlaggedFiles
      ? `Scope your analysis ONLY to the flagged files and their listed related files: ${flaggedFiles.join(', ')}. Do not propose changes to other files.`
      : `The findings do not identify concrete files — identify the correct files from the findings text. Scope changes to files this milestone's tasks declared${milestoneTargetFiles.length > 0 ? `: ${milestoneTargetFiles.join(', ')}` : ''}. Do not propose changes to other files.`;

    const log = this.logger.createSessionLog(`planner-regression-remediate-${milestoneId}`);

    try {
      const spawnPromise = this.sessionManager.spawn({
        name: `planner-regression-remediate-${milestoneId}`,
        prompt,
        systemPrompt: `You are a software architect creating tasks to fix critical regression report findings. ${scopeClause}`,
        model: config.execution.plannerModel,
        tools: config.tools.planner,
        jsonSchema: regressionRemediationSchema,
        maxBudget: config.budgets.planner,
        cwd: projectRoot,
      });

      this.logger.attachToSession(spawnPromise.handle, log, {
        role: 'planner',
        phase: 'regression-remediate',
        milestoneId,
      });

      const { handle, result } = await spawnPromise;
      await this.tokenTracker?.recordSession(
        `planner-regression-remediate-${milestoneId}`,
        'planner',
        result,
        {
          phase: 'regression-remediate',
          milestoneId,
          systemPromptTokens: handle.systemPromptTokens,
          toolCallCount: handle._toolCallCount,
        },
      );

      let remPlan;
      try {
        remPlan = this._extractJson(result);
      } catch (err) {
        this.logger.warn(
          `[planner] remediateRegressionFailure(${milestoneId}): failed to extract structured output — ` +
          `returning empty newTasks. Cause: ${err.message}`,
        );
        return { newTasks: [] };
      }

      const specTargetFiles = Array.isArray(opts.specTargetFiles) ? opts.specTargetFiles : [];
      _validatePathAnchorPreservation(remPlan, specTargetFiles, projectRoot);
      const specAcceptanceCriteria = Array.isArray(opts.specAcceptanceCriteria) ? opts.specAcceptanceCriteria : [];
      const declaredSet = buildDeclaredSet(specTargetFiles, specAcceptanceCriteria);
      if (declaredSet.size > 0) {
        lintPlanScope(remPlan, declaredSet, {
          projectRoot,
          specTargetFiles,
          specAcceptanceCriteria,
        });
      }
      const scopeMapping = Array.isArray(opts.scopeMapping) ? opts.scopeMapping : [];
      const scopeMappingWarnings = checkScopeMappingConsistency(remPlan, scopeMapping);
      this._surfaceScopeMappingWarnings(remPlan, scopeMappingWarnings, `remediateRegressionFailure(${milestoneId})`);

      // Normalise: if the SDK returned a valid object but without the
      // expected newTasks key (schema mismatch), wrap it so the
      // pipeline's empty-newTasks guard catches it cleanly rather than
      // hitting a TypeError on remPlan.newTasks?.length.
      if (!remPlan || typeof remPlan !== 'object' || !Array.isArray(remPlan.newTasks)) {
        this.logger.warn(
          `[planner] remediateRegressionFailure(${milestoneId}): structured output missing newTasks array — ` +
          `returning empty newTasks. Got: ${JSON.stringify(remPlan)}`,
        );
        return { newTasks: [] };
      }

      return remPlan;
    } finally {
      log.close();
    }
  }

  /**
   * Produce replacement tasks for a failed task.
   *
   * Called by the pipeline's re-plan gate when the analyzer recommends
   * `re_plan`. Always uses a one-shot spawn — replanTask needs
   * taskReplanSchema, which differs from the reusable session's
   * missionDecompositionSchema, so it does not share the reusable
   * planMission session.
   *
   * @param {{ id: string, description: string, targetFiles: string[] }} failedTask
   * @param {{ rootCause: string, evidence: string }} analyzerReport
   * @param {string} missionContext - Mission plan text for additional context
   * @returns {Promise<{ replacementTasks: Array }>}
   */
  async replanTask(failedTask, analyzerReport, missionContext, opts = {}) {
    const prompt = `Task ${failedTask.id} has failed and requires replacement tasks.

Failed task ID: ${failedTask.id}
Failed task description: ${failedTask.description}
Failed task targetFiles: ${Array.isArray(failedTask.targetFiles) ? failedTask.targetFiles.join(', ') : failedTask.targetFiles}

Analyzer root cause: ${analyzerReport.rootCause}
Analyzer evidence: ${analyzerReport.evidence || '(none provided)'}

Mission context:
${missionContext}

Produce replacement tasks that address the root cause. Use the ID convention {original-id}-rp-001 for the first replacement.`;

    const sessionName = `planner-replan-${failedTask.id}`;

    // Always use one-shot spawn — replanTask needs taskReplanSchema which
    // differs from the reusable session's missionDecompositionSchema.
    // The reusable session is scoped to planMission (Phase 3b) calls only.
    const log = this.logger.createSessionLog(sessionName);

    try {
      const spawnPromise = this.sessionManager.spawn({
        name: sessionName,
        prompt,
        systemPrompt: buildReplanSystemPrompt(),
        model: config.execution.plannerModel,
        tools: config.tools.planner,
        jsonSchema: taskReplanSchema,
        maxBudget: config.budgets.planner,
      });

      this.logger.attachToSession(spawnPromise.handle, log, {
        role: 'planner',
        phase: 'replan',
        failedTaskId: failedTask.id,
      });

      const { handle, result } = await spawnPromise;
      await this.tokenTracker?.recordSession(sessionName, 'planner', result, {
        phase: 'replan',
        failedTaskId: failedTask.id,
        systemPromptTokens: handle.systemPromptTokens,
        toolCallCount: handle._toolCallCount,
      });
      const replanResult = this._extractJson(result);
      const specTargetFiles = Array.isArray(opts.specTargetFiles) ? opts.specTargetFiles : [];
      _validatePathAnchorPreservation(replanResult, specTargetFiles);
      const specAcceptanceCriteria = Array.isArray(opts.specAcceptanceCriteria) ? opts.specAcceptanceCriteria : [];
      const declaredSet = buildDeclaredSet(specTargetFiles, specAcceptanceCriteria);
      if (declaredSet.size > 0) {
        lintPlanScope(replanResult, declaredSet, {
          projectRoot: opts.projectRoot,
          specTargetFiles,
          specAcceptanceCriteria,
        });
      }
      const scopeMapping = Array.isArray(opts.scopeMapping) ? opts.scopeMapping : [];
      const scopeMappingWarnings = checkScopeMappingConsistency(replanResult, scopeMapping);
      this._surfaceScopeMappingWarnings(replanResult, scopeMappingWarnings, `replanTask(${failedTask.id})`);
      return replanResult;
    } finally {
      log.close();
    }
  }

  /**
   * Surfaces the advisory warnings returned by checkScopeMappingConsistency
   * (malformed entries, duplicate scopeItemIds, unresolved missionIds,
   * file-vs-mission consistency). Logs them AND attaches them to
   * `plan.scopeWarnings` so the pipeline's ledger writers
   * (`_recordScopeMappingWarnings`) can persist them. Never throws —
   * mirrors `_warnIfRejectedBehavior`'s no-throw contract.
   *
   * @param {object} plan - The planner-emitted plan; scopeWarnings is
   *   appended in place so callers see it on the returned plan object.
   * @param {Array<{severity: string, category: string, description: string}>} warnings
   * @param {string} callerLabel - Label for the warn message context
   */
  _surfaceScopeMappingWarnings(plan, warnings, callerLabel) {
    try {
      const list = Array.isArray(warnings) ? warnings.filter(
        (w) => w && typeof w.description === 'string',
      ) : [];
      for (const warning of list) {
        this.logger.warn(`[planner] ${callerLabel}: scope-mapping-consistency: ${warning.description}`);
      }
      if (plan && typeof plan === 'object' && list.length > 0) {
        plan.scopeWarnings = (Array.isArray(plan.scopeWarnings) ? plan.scopeWarnings : []).concat(list);
      }
    } catch {
      // silently swallow
    }
  }

  /**
   * Warn if any task description looks like it references a file:line
   * location (e.g. "foo.js:42"). Such descriptions are usually vague
   * "Cover: X, Y, Z" lists that leaked a source reference rather than
   * stating a concrete deliverable.
   *
   * Does NOT throw — any error during iteration is silently swallowed.
   *
   * @param {object} plan        - Planner output (subMissions or tasks)
   * @param {string} callerLabel - Label for the warn message context
   */
  _warnIfVagueDescriptions(plan, callerLabel) {
    try {
      const tasks = plan?.subMissions?.flatMap((sm) => sm.tasks ?? []) ?? plan?.tasks ?? [];
      for (const task of tasks) {
        if (task?.description && /\.[a-z]{1,5}:\d+/i.test(task.description)) {
          const truncated = task.description.slice(0, 80);
          this.logger.warn(`[planner] ${callerLabel}: task ${task.id} description looks vague: "${truncated}"`);
        }
      }
    } catch {
      // silently swallow
    }
  }

  /**
   * Warn when a task description appears to perform a rejected behavior from
   * the mission's DO-NOT list. Uses a negation-window guard: if any matched
   * content token sits within 6 word-positions of a negation marker the
   * phrase is skipped (the task is explicitly rejecting the behavior).
   *
   * Does NOT throw — any error during iteration is silently swallowed.
   *
   * @param {object}   plan           - Planner output (subMissions / replacementTasks / newTasks)
   * @param {Array<{phrase: string, tokens: Set<string>}>} rejectedPhrases - DO-NOT phrases with token sets
   * @param {string}   callerLabel    - Label for the warn message context
   */
  _warnIfRejectedBehavior(plan, rejectedPhrases, callerLabel) {
    try {
      // Build unified task list from all three plan shapes
      const allTasks = [];
      if (Array.isArray(plan?.subMissions)) {
        for (const sm of plan.subMissions) {
          if (Array.isArray(sm?.tasks)) {
            for (const task of sm.tasks) allTasks.push(task);
          }
        }
      }
      if (Array.isArray(plan?.replacementTasks)) {
        for (const task of plan.replacementTasks) allTasks.push(task);
      }
      if (Array.isArray(plan?.newTasks)) {
        for (const task of plan.newTasks) allTasks.push(task);
      }

      if (!Array.isArray(rejectedPhrases) || rejectedPhrases.length === 0) return;

      // Single-word negation markers (case-insensitive via pre-lowercased desc).
      // Tokenisation splits on \W+ (see below), so an apostrophe always breaks a
      // contraction into separate tokens ("don't" → ["don", "t"]); a token like
      // "n't" can never be produced and was dead by construction — removed.
      const NEGATION_SINGLE = new Set(['not', 'avoid', 'without', 'unlike', 'rejected']);
      // Multi-word negation markers as adjacent token pairs
      const NEGATION_MULTI = [
        ['instead', 'of'],
        ['rather', 'than'],
        ['differs', 'from'],
      ];

      let count = 0;

      for (const task of allTasks) {
        if (typeof task?.description !== 'string') continue;

        // (a) lowercase the description
        const desc = task.description.toLowerCase();

        // Tokenise desc on \W+ for position-based checks
        const words = desc.split(/\W+/).filter((w) => w.length > 0);

        // Build set of word-positions occupied by negation markers
        const negationPositions = new Set();
        for (let i = 0; i < words.length; i++) {
          if (NEGATION_SINGLE.has(words[i])) {
            negationPositions.add(i);
          }
          for (const [first, second] of NEGATION_MULTI) {
            if (words[i] === first && words[i + 1] === second) {
              negationPositions.add(i);
              break;
            }
          }
        }

        for (const { phrase, tokens } of rejectedPhrases) {
          if (!(tokens instanceof Set) || tokens.size === 0) continue;

          // (b) verify EVERY token in tokens appears as \b<token>\b match in desc
          const matchedTokenPositions = [];
          let allMatch = true;

          for (const token of tokens) {
            const re = new RegExp(`\\b${token}\\b`);
            if (!re.test(desc)) {
              allMatch = false;
              break;
            }
            // Collect word-positions of this token in the word array
            for (let i = 0; i < words.length; i++) {
              if (words[i] === token) matchedTokenPositions.push(i);
            }
          }

          if (!allMatch) continue;

          // (c) skip when any matched token sits within 6 word-positions of a negation marker
          let nearNegation = false;
          for (const pos of matchedTokenPositions) {
            for (const negPos of negationPositions) {
              if (Math.abs(pos - negPos) <= 6) {
                nearNegation = true;
                break;
              }
            }
            if (nearNegation) break;
          }

          if (nearNegation) continue;

          // (d) log per-task warning and increment counter
          count++;
          this.logger.warn(
            `[planner] ${callerLabel}: task ${task.id} appears to perform rejected behavior "${phrase}"`,
          );
        }
      }

      if (count > 0) {
        this.logger.warn(
          `[planner] ${callerLabel}: ${count} task(s) flagged as possibly performing rejected behaviors`,
        );
      }
    } catch {
      // silently swallow
    }
  }

  /**
   * For each sub-mission with ordering === 'sequential', synthesize a hard-
   * dependency chain so that task[n] depends on task[n-1]. Already-present
   * deps are not duplicated (idempotent). Any error is silently swallowed.
   *
   * @param {object} plan - Planner output (subMissions array)
   */
  _enforceSequentialOrdering(plan) {
    try {
      const subMissions = plan?.subMissions ?? [];
      for (const sm of subMissions) {
        if (sm?.ordering !== 'sequential') continue;
        const tasks = sm?.tasks ?? [];
        for (let n = 1; n < tasks.length; n++) {
          const prevId = tasks[n - 1]?.id;
          const task = tasks[n];
          if (!prevId || !task) continue;
          if (!Array.isArray(task.dependencies)) {
            task.dependencies = [];
          }
          const alreadyHasDep = task.dependencies.some(
            (d) => d?.taskId === prevId && d?.type === 'hard',
          );
          if (!alreadyHasDep) {
            task.dependencies.push({ taskId: prevId, type: 'hard' });
          }
        }
      }
    } catch {
      // silently swallow
    }
  }

  /**
   * Extract JSON from a claude result event.
   *
   * The Agent SDK, when given a jsonSchema, returns the parsed object at
   * result.structured_output. The `result` field holds the model's prose
   * explanation alongside it. We prefer structured_output; the other
   * paths are fallbacks for older SDK shapes / non-schema calls.
   */
  _extractJson(result) {
    if (!result) throw new Error('Planner session returned no result');

    // Primary: SDK structured output (from jsonSchema)
    if (result.structured_output && typeof result.structured_output === 'object') {
      return result.structured_output;
    }

    // Fallback: result.result as JSON string
    if (typeof result.result === 'string') {
      try { return JSON.parse(result.result); } catch {}
      // Also try to pull a ```json code block out of the prose.
      const match = result.result.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
      if (match) {
        try { return JSON.parse(match[1]); } catch {}
      }
    }

    // Fallback: result.result already an object
    if (typeof result.result === 'object' && result.result !== null) {
      return result.result;
    }

    // Fallback: content blocks (non-schema assistant message)
    const message = result.message || result;
    const content = message.content || [];
    for (const block of (Array.isArray(content) ? content : [])) {
      if (block.type === 'text') {
        try { return JSON.parse(block.text); } catch {}
        const match = block.text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
        if (match) {
          try { return JSON.parse(match[1]); } catch {}
        }
      }
    }

    throw new Error('Could not extract structured plan from planner output');
  }
}

/**
 * Validates that every task targetFile matching the spec's authoritative
 * target_files list is preserved exactly — case-sensitive, with no
 * suffix/prefix rewriting. If a planner-emitted path is a case-variant or a
 * suffix/prefix variation of a spec-declared path, this function THROWS
 * (`[planner] path anchor violation: ...`) so the caller halts the plan
 * rather than silently shipping a rewritten path. It does NOT correct the
 * path in place — silent mutation is the rejected Option-D behaviour.
 *
 * Handles all three plan shapes:
 *   - subMissions[].tasks[].targetFiles  (planMission output)
 *   - replacementTasks[].targetFiles     (replanTask output)
 *   - newTasks[].targetFiles             (review/regression remediation output)
 *
 * @param {object}      plan            - Planner output object
 * @param {string[]}    specTargetFiles - Authoritative target_files from the spec
 * @param {string|null} [projectRoot]   - Optional absolute project root. When provided,
 *   a suffix/case match is allowed if both the emitted path and the spec path resolve
 *   (via `path.resolve(projectRoot, p)`) to the same absolute file path — i.e. the
 *   prose short-name unambiguously identifies the same file. If they resolve to
 *   different files, the violation is still thrown.
 */
/**
 * Resolves the spec target_file (if any) that an emitted task path
 * ambiguously refers to, using the same decision order as the inline
 * check formerly in `_validatePathAnchorPreservation`:
 *   1. Exact-set membership (`specExact`) → no match (null), not a violation.
 *   2. Case-insensitive lookup via `specLowerMap`.
 *   3. Suffix/prefix match: `emittedLower` ends with `'/' + specLower`, or
 *      `specLower` ends with `'/' + emittedLower`.
 *   4. When `projectRoot` is non-null and a candidate spec path was found in
 *      steps 2–3, resolve both `emitted` and the candidate spec path against
 *      `projectRoot`; if they resolve to the same absolute file, the match is
 *      unambiguous and treated as no-match (null) rather than a violation.
 *
 * Pure function — does not throw; callers decide what to do with a non-null
 * result (e.g. `_validatePathAnchorPreservation` throws).
 *
 * @param {string} emitted - The task-emitted target file path
 * @param {Set<string>} specExact - Exact set of spec target_files
 * @param {Map<string,string>} specLowerMap - lowercase path → original spec path
 * @param {string|null} projectRoot - Absolute project root, or null to skip
 *   the same-absolute-file disambiguation
 * @returns {string|null} The matching (violating) spec path, or null
 */
function resolveSpecPathAnchor(emitted, specExact, specLowerMap, projectRoot) {
  // Exact match → nothing to do
  if (specExact.has(emitted)) return null;

  // Try case-insensitive exact match first
  const emittedLower = emitted.toLowerCase();
  let specPath = specLowerMap.get(emittedLower) || null;

  // Try suffix/prefix match: spec path is a suffix of emitted or vice versa
  if (!specPath) {
    for (const [specLower, specOrig] of specLowerMap) {
      if (
        emittedLower.endsWith('/' + specLower) ||
        specLower.endsWith('/' + emittedLower)
      ) {
        specPath = specOrig;
        break;
      }
    }
  }

  if (specPath) {
    // When projectRoot is provided, check if both paths resolve to the same
    // absolute file — if so, the short-name is unambiguous and not a violation.
    if (projectRoot !== null) {
      const resolvedEmitted = path.resolve(projectRoot, emitted);
      const resolvedSpec    = path.resolve(projectRoot, specPath);
      if (resolvedEmitted === resolvedSpec) return null;
    }
    return specPath;
  }

  return null;
}

function _validatePathAnchorPreservation(plan, specTargetFiles, projectRoot = null) {
  if (!plan || !Array.isArray(specTargetFiles) || specTargetFiles.length === 0) return;

  // Build exact-match set and case-insensitive lookup map
  const specExact = new Set(specTargetFiles);
  const specLowerMap = new Map(); // lowercase path → original spec path
  for (const sp of specTargetFiles) {
    specLowerMap.set(sp.toLowerCase(), sp);
  }

  // Collect all task arrays from all known plan shapes
  const allTaskArrays = [];
  if (Array.isArray(plan.subMissions)) {
    for (const sm of plan.subMissions) {
      if (Array.isArray(sm?.tasks)) allTaskArrays.push(sm.tasks);
    }
  }
  if (Array.isArray(plan.replacementTasks)) allTaskArrays.push(plan.replacementTasks);
  if (Array.isArray(plan.newTasks)) allTaskArrays.push(plan.newTasks);

  for (const tasks of allTaskArrays) {
    for (const task of tasks) {
      if (!Array.isArray(task?.targetFiles)) continue;
      for (let i = 0; i < task.targetFiles.length; i++) {
        const emitted = task.targetFiles[i];
        if (typeof emitted !== 'string') continue;

        const specPath = resolveSpecPathAnchor(emitted, specExact, specLowerMap, projectRoot);

        if (specPath) {
          throw new Error(
            `[planner] path anchor violation: task "${task.id || '?'}" emitted "${emitted}" ` +
            `but spec declares "${specPath}"`,
          );
        }
      }
    }
  }
}

/**
 * Common code/test file extensions recognized as path-like tokens.
 * Used by extractPathTokens and parseSpecHardChecks.
 */
const _PATH_LIKE_EXTENSIONS = new Set([
  '.js', '.ts', '.py', '.md', '.json', '.tsx', '.jsx', '.mjs', '.cjs',
  '.sh', '.yaml', '.yml', '.toml', '.env',
]);

/**
 * Shell-syntax punctuation stripped from BOTH ends of each whitespace-token
 * (repeatedly, until stable) before the path test. Interior characters are
 * untouched. Note: shell-syntax punctuation around tokens (e.g.
 * `bash -c "...path"` quoting) used to leak into the extracted tokens and
 * caused the Wave-1 false-orphan drain kill — a trailing-quote token like
 * `src/orchestrator/core/pipeline.js"` matches no targetFile, so the check
 * was never assigned and the drain flagged it as an orphan.
 */
const _TOKEN_EDGE_PUNCTUATION = new Set([
  '"', "'", '`', '(', ')', '[', ']', '{', '}', ';', ',', '<', '>', '|', '&', '!', '$',
]);

/**
 * Strips shell-syntax punctuation from both ends of a token, repeatedly
 * until stable. Interior characters are untouched.
 *
 * @param {string} token - Whitespace-token to clean
 * @returns {string} Cleaned token (may be empty)
 */
function _stripTokenEdges(token) {
  let start = 0;
  let end = token.length;
  while (start < end && _TOKEN_EDGE_PUNCTUATION.has(token[start])) start++;
  while (end > start && _TOKEN_EDGE_PUNCTUATION.has(token[end - 1])) end--;
  return token.slice(start, end);
}

/**
 * Matches an `-e` / `--eval` / `--eval=<payload>` flag together with its
 * argument payload, purely lexically (flag recognition + quote matching —
 * no JS parsing, no evaluation). Capture group 1 is the boundary
 * (start-of-string or the whitespace immediately preceding the flag),
 * which is preserved on replacement so token separation between the
 * surrounding command pieces is not lost.
 *
 * Payload forms recognized (in order): double-quoted ("..."),
 * single-quoted ('...'), or a bare single whitespace-delimited word.
 * The `=` form (`--eval=payload`) requires the payload to immediately
 * follow `=`; the space form (`-e payload` / `--eval payload`) requires
 * at least one whitespace character before the payload.
 */
const _EVAL_FLAG_EXCISION_RE = /(^|\s)(?:-e|--eval)(?:=(?:"[^"]*"|'[^']*'|\S+)|\s+(?:"[^"]*"|'[^']*'|\S+))/g;

/**
 * Lexically excises the argument payload of every `-e` / `--eval` /
 * `--eval=<payload>` token from a shell command string, before any
 * whitespace splitting or path-token extraction runs. This is a blanket
 * excision over any leading command (node/sed/grep/etc.) — the flag's
 * argument is never treated as a path operand, since it is opaque
 * inline-script/expression content, not a filesystem path. Detection and
 * excision are purely lexical (flag recognition + quote matching); no
 * JavaScript parsing or evaluation is performed.
 *
 * @param {string} commandStr - Raw shell command string
 * @returns {string} commandStr with every -e/--eval flag+payload removed
 */
function _exciseEvalPayloads(commandStr) {
  return commandStr.replace(_EVAL_FLAG_EXCISION_RE, '$1');
}

/**
 * Scans a shell command string for path-like tokens.
 *
 * Before any splitting occurs, the argument payload of every `-e` /
 * `--eval` / `--eval=<payload>` token is lexically excised from
 * `commandStr` (see `_exciseEvalPayloads`): flag recognition plus quote
 * matching over the raw string, with no JavaScript parsing or evaluation.
 * Double-quoted, single-quoted, and bare single-word payloads are all
 * removed. This excision is blanket over any leading command
 * (node/sed/grep alike) — the flag's argument is never treated as a path
 * operand. Accepted consequence: a command whose only path-like strings
 * live inside an -e/--eval payload has zero path tokens and is therefore
 * classified as milestone-only by downstream consumers.
 *
 * After excision, each whitespace-token is cleaned of shell-syntax
 * punctuation on both ends (see _TOKEN_EDGE_PUNCTUATION); the path test
 * runs on the CLEANED token and the cleaned token is what's returned.
 * Tokens that strip to empty are dropped. A cleaned token qualifies if it
 * contains '/' (a path separator) or ends with a recognized code/test
 * file extension (.js, .ts, .py, .md, etc.).
 *
 * URL tokens (containing `://`) are always excluded.
 *
 * When `projectRoot` is a non-empty string, tokens that resolve to an
 * existing directory are also excluded: tokens ending with `/` are
 * excluded unconditionally; other tokens are stat-checked via
 * `fs.statSync(path.resolve(projectRoot, token)).isDirectory()`.
 *
 * @param {string} commandStr - Shell command string to scan
 * @param {string} [projectRoot] - Optional project root for directory exclusion
 * @returns {string[]} Extracted path-like tokens (cleaned)
 */
function extractPathTokens(commandStr, projectRoot) {
  if (!commandStr || typeof commandStr !== 'string') return [];
  const hasProjectRoot = typeof projectRoot === 'string' && projectRoot.length > 0;
  return _exciseEvalPayloads(commandStr).split(/\s+/)
    .map((token) => _stripTokenEdges(token))
    .filter((token) => {
      if (!token) return false;
      // Exclude URL schemes (e.g. http://localhost:3000/health)
      if (token.includes('://')) return false;
      // Determine if path-like
      const isPathLike = (() => {
        if (token.includes('/')) return true;
        const dotIdx = token.lastIndexOf('.');
        if (dotIdx >= 0) {
          const ext = token.slice(dotIdx).toLowerCase();
          return _PATH_LIKE_EXTENSIONS.has(ext);
        }
        return false;
      })();
      if (!isPathLike) return false;
      // Optionally exclude tokens that resolve to an existing directory
      if (hasProjectRoot) {
        if (token.endsWith('/')) return false;
        try {
          if (fs.statSync(path.resolve(projectRoot, token)).isDirectory()) return false;
        } catch (_e) {
          // stat failure → not a directory → keep token
        }
      }
      return true;
    });
}

/**
 * Reads a spec.json file (brainstormer structured output with
 * `acceptance_criteria: [{description, verification}]`) and returns hard
 * checks built from the structured `verification` field.
 *
 * Each acceptance criterion carries a required `verification` object with a
 * `kind` of `command`, `file-check`, or `manual`. Only `kind=command` yields
 * a hard check — its `verification.command` is the runnable shell command.
 * `manual` (reviewer/human) is skipped. `file-check` is also skipped here:
 * its presence enforcement lives in `parseSpecFileChecks` below, consumed
 * by the pipeline's last-milestone spec-criteria drain
 * (`_runSpecCriteriaDrain`), so this parser only consumes `kind=command`.
 *
 * @param {string} specJsonPath - Absolute path to the spec.json file
 * @returns {{name: string, command: string}[]} Extracted hard checks
 */
/**
 * Returns true when an acceptance_criteria item has a parser-extractable
 * verification: kind==='command' with a non-empty command string,
 * kind==='file-check' with a non-empty targetFile string, or kind==='manual'.
 *
 * @param {*} item - An acceptance_criteria entry
 * @returns {boolean}
 */
function isCheckableCriterion(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const v = item.verification;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (v.kind === 'command') return typeof v.command === 'string' && v.command.length > 0;
  if (v.kind === 'file-check') return typeof v.targetFile === 'string' && v.targetFile.length > 0;
  if (v.kind === 'manual') return true;
  return false;
}

function parseSpecHardChecks(specJsonPath) {
  const content = fs.readFileSync(specJsonPath, 'utf8');
  const spec = JSON.parse(content);
  const criteria = Array.isArray(spec.acceptance_criteria) ? spec.acceptance_criteria : [];
  return criteria
    .filter((item) => {
      if (!isCheckableCriterion(item)) return false;
      const v = item.verification;
      if (v.kind !== 'command') return false;
      return true;
    })
    .map((item) => ({
      name: item.description,
      command: item.verification.command,
    }));
}

/**
 * Reads a spec.json file and returns file-check criteria built from the
 * structured `verification` field — the `kind=file-check` counterpart of
 * `parseSpecHardChecks` (same shape and failure modes: throws on a missing
 * or unreadable/malformed file; returns [] when no criterion qualifies).
 *
 * Only `kind=file-check` with a non-empty string `targetFile` yields an
 * entry. Existence of each `targetFile` is enforced by the pipeline's
 * last-milestone spec-criteria drain (existence only — no content/size
 * semantics).
 *
 * @param {string} specJsonPath - Absolute path to the spec.json file
 * @returns {{name: string, targetFile: string}[]} Extracted file checks
 */
function parseSpecFileChecks(specJsonPath) {
  const content = fs.readFileSync(specJsonPath, 'utf8');
  const spec = JSON.parse(content);
  const criteria = Array.isArray(spec.acceptance_criteria) ? spec.acceptance_criteria : [];
  return criteria
    .filter((item) => {
      if (!isCheckableCriterion(item)) return false;
      const v = item.verification;
      if (v.kind !== 'file-check') return false;
      return true;
    })
    .map((item) => ({
      name: item.description,
      targetFile: item.verification.targetFile,
    }));
}

/**
 * Reads a spec.json file and returns its declared `target_files` — the
 * spec's own deliverable manifest, consumed by `isMilestoneOnlyCheck` to
 * classify path-bearing checks whose tokens reference no deliverable.
 * Same read pattern and failure modes as `parseSpecHardChecks` (throws on
 * a missing or unreadable/malformed file). Entries are filtered to
 * non-empty strings; an absent or non-array `target_files` yields [].
 *
 * Deliberately does NOT reuse spec-text.js's readSpecTargetFiles: that
 * reader has an md-prose fallback, and prose-scraped paths must never
 * feed this classifier.
 *
 * @param {string} specJsonPath - Absolute path to the spec.json file
 * @returns {string[]} Declared target_files (non-empty strings only)
 */
function parseSpecTargetFiles(specJsonPath) {
  const content = fs.readFileSync(specJsonPath, 'utf8');
  const spec = JSON.parse(content);
  const files = Array.isArray(spec.target_files) ? spec.target_files : [];
  return files.filter((f) => typeof f === 'string' && f.length > 0);
}

/**
 * True iff a path token T refers to a file F, under the 3 matching rules
 * shared by check classification (`isMilestoneOnlyCheck`) and task scoping
 * (`scopeSpecHardChecks`) — single source so the two can never diverge:
 *   - exact match: T === F
 *   - suffix match: F ends with '/' + T  (absolute path ending in the relative token)
 *   - reverse suffix match: T ends with '/' + F
 *
 * @param {string} token - Path-like token extracted from a check's command
 * @param {string} file - A declared file path (task targetFile or spec target_file)
 * @returns {boolean}
 */
function pathTokenMatchesFile(token, file) {
  if (file === token) return true;
  if (file.endsWith('/' + token)) return true;
  if (token.endsWith('/' + file)) return true;
  return false;
}

/**
 * True iff a parsed spec hard check is a "milestone-only" check — a
 * milestone-level command with no deliverable-scoped meaning. Two ways to
 * qualify:
 *   - zero path-like tokens in its command (e.g. `npm run lint`);
 *   - when `specTargetFiles` is a non-empty string array: the command HAS
 *     path tokens, but none matches any declared spec target_file (via
 *     `pathTokenMatchesFile`) — e.g. `node scripts/run-tests.js`, a suite
 *     runner whose path is infra, not a deliverable. No planner task
 *     declares such a file at scoping time, so under the zero-token-only
 *     rule the check was assigned to no task and falsely judged an orphan.
 *
 * When `specTargetFiles` is absent, not an array, or empty, classification
 * is exactly the legacy zero-token rule (bare-md and no-target_files specs
 * are byte-identical).
 *
 * Single source for the milestone-only predicate: `scopeSpecHardChecks`
 * (exclude from task scoping), `findUnassignedSpecHardChecks` (never an
 * orphan), and the pipeline's last-milestone spec-criteria drain (the
 * execution channel for these checks) all share it.
 *
 * @param {{name: string, command: string}} check - Parsed spec hard check
 * @param {string[]} [specTargetFiles] - The spec's declared target_files
 *   (parseSpecTargetFiles); omit for legacy zero-token-only classification
 * @returns {boolean}
 */
/**
 * True iff `command` is one of the project's configured whole-suite test
 * commands — the per-milestone smoke test (`config.execution.testCommand`,
 * default `npm test`) or the full-suite runner (`config.execution.testAllCommand`,
 * default `npm run test:all`). These are run once by the regression/final test
 * gates after the whole run completes, NOT per task; recognizing them by
 * configuration (rather than incidentally via the zero-path-token rule) keeps
 * them excluded even if a configured test command carries a path token.
 *
 * Defensive: a null/undefined `command`, a null/undefined `config`, or a
 * `config` missing `execution` → false. Surrounding whitespace on `command`
 * is trimmed before comparison.
 *
 * When `projectRoot` is provided, ALSO recognizes `command` as whole-suite
 * if it matches the resolved npm-script body of `testCommand` or
 * `testAllCommand` — e.g. `testCommand: 'npm test'` with a package.json
 * `scripts.test` of `'node scripts/run-tests.js'` makes `command ===
 * 'node scripts/run-tests.js'` whole-suite too. Resolution recognizes only
 * `'npm test'` (-> `scripts.test`) and `'npm run <name>'` (-> `scripts[<name>]`)
 * forms, and is single-level: a resolved script body is compared literally,
 * never re-resolved even if it is itself `'npm run x'`. Reading and parsing
 * `<projectRoot>/package.json` is fail-soft — a missing/unreadable/unparseable
 * file, absent `scripts`, absent script key, or a configured command not in
 * npm form silently contributes nothing. This function never throws.
 *
 * @param {string} command - A check's command string
 * @param {object} config - The orchestrator config (uses config.execution.{testCommand,testAllCommand})
 * @param {string} [projectRoot] - Absolute path to the project root, used to resolve npm-script forms
 * @returns {boolean}
 */
function resolveNpmScriptBody(commandStr, projectRoot) {
  if (typeof commandStr !== 'string') return undefined;
  const trimmed = commandStr.trim();
  let scriptName;
  if (trimmed === 'npm test') {
    scriptName = 'test';
  } else {
    const match = trimmed.match(/^npm run (\S+)$/);
    if (match) scriptName = match[1];
  }
  if (!scriptName) return undefined;
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    const content = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(content);
    if (!pkg || typeof pkg.scripts !== 'object' || pkg.scripts === null) return undefined;
    const body = pkg.scripts[scriptName];
    return typeof body === 'string' ? body : undefined;
  } catch {
    return undefined;
  }
}

function isWholeSuiteCommand(command, config, projectRoot) {
  if (typeof command !== 'string') return false;
  if (!config || !config.execution) return false;
  const normalized = command.trim();
  const { testCommand, testAllCommand } = config.execution;
  if (normalized === testAllCommand || normalized === testCommand) return true;
  if (!projectRoot) return false;
  try {
    for (const configuredCommand of [testCommand, testAllCommand]) {
      const resolved = resolveNpmScriptBody(configuredCommand, projectRoot);
      if (typeof resolved === 'string' && resolved.trim() === normalized) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function isMilestoneOnlyCheck(check, specTargetFiles, projectRoot) {
  if (isWholeSuiteCommand(check.command, config, projectRoot)) return true;
  const pathTokens = extractPathTokens(check.command, projectRoot);
  if (pathTokens.length === 0) return true;
  if (!Array.isArray(specTargetFiles) || specTargetFiles.length === 0) return false;
  return !pathTokens.some((token) =>
    specTargetFiles.some((tf) => pathTokenMatchesFile(token, tf)),
  );
}

/**
 * True when TWO OR MORE of the given tasks' targetFiles overlap the
 * check's path tokens — i.e. the check asserts something about a file
 * that several tasks share, so no single task owns satisfying it. Such a
 * check must run once at the spec-criteria drain (after every sharer has
 * landed), never at an individual sharer's verification: gating each
 * sharer on the file's END state fails whichever sharer verifies before
 * the sibling whose edit satisfies the check (the failed-075/failed-217
 * trap — a task can even be explicitly forbidden from the symbol its own
 * gate counts).
 *
 * Tasks with status 'invalidated' should be excluded by the CALLER when
 * counting owners from persisted state (replaced tasks never run).
 *
 * @param {{name: string, command: string}} check
 * @param {{id: string, targetFiles: string[]}[]} tasks
 * @returns {boolean}
 */
function isMultiOwnerCheck(check, tasks, projectRoot) {
  const pathTokens = extractPathTokens(check.command, projectRoot);
  if (pathTokens.length === 0) return false;
  let owners = 0;
  for (const task of tasks) {
    const targetFiles = Array.isArray(task.targetFiles) ? task.targetFiles : [];
    const hasOverlap = pathTokens.some((token) =>
      targetFiles.some((tf) => pathTokenMatchesFile(token, tf)),
    );
    if (hasOverlap && ++owners >= 2) return true;
  }
  return false;
}

/**
 * Scopes a list of hard checks to specific tasks by matching path tokens
 * extracted from each check's command against each task's targetFiles.
 *
 * Milestone-only checks (per `isMilestoneOnlyCheck`: no path-like tokens,
 * or no token matching any declared spec target_file when `specTargetFiles`
 * is provided) are excluded — they are milestone-level checks with no
 * deliverable-scoped meaning.
 *
 * Ownership rule: a check attaches to a task ONLY when that task is the
 * check's sole owner — exactly one task's targetFiles overlap the
 * command's path tokens among `tasks`, AND no entry of
 * `externalOwnerSources` overlaps them. A multi-owner check (see
 * `isMultiOwnerCheck`) attaches to NO task — the pipeline's spec-criteria
 * drain executes it after all sharers have landed. Attaching it to every
 * sharer gates tasks on an end state a sibling produces (the
 * failed-075/failed-217 trap). `externalOwnerSources` lets the caller
 * count owners OUTSIDE the current planning scope (persisted tasks of
 * earlier-planned missions, declared targetFiles of not-yet-planned
 * missions) so lazy per-mission planning cannot split ownership across
 * planning calls and re-open the trap.
 *
 * Matching rules: see `pathTokenMatchesFile` (shared with classification).
 *
 * @param {{name: string, command: string}[]} hardChecks
 * @param {{id: string, targetFiles: string[]}[]} tasks
 * @param {string[]} [specTargetFiles] - The spec's declared target_files,
 *   forwarded to `isMilestoneOnlyCheck`; omit for legacy zero-token-only
 *   classification
 * @param {{targetFiles: string[]}[]} [externalOwnerSources] - Owner
 *   candidates outside `tasks` (never attached to; only counted)
 * @returns {Map<string, {name: string, command: string}[]>} Map of taskId → scoped checks
 */
function scopeSpecHardChecks(hardChecks, tasks, specTargetFiles, projectRoot, externalOwnerSources) {
  const result = new Map();
  for (const task of tasks) {
    result.set(task.id, []);
  }
  const externals = Array.isArray(externalOwnerSources) ? externalOwnerSources : [];

  for (const check of hardChecks) {
    // Milestone-only check → exclude from all tasks; the pipeline's
    // last-milestone spec-criteria drain is its execution channel.
    if (isMilestoneOnlyCheck(check, specTargetFiles, projectRoot)) continue;
    const pathTokens = extractPathTokens(check.command, projectRoot);

    const overlaps = (targetFiles) => pathTokens.some((token) =>
      (Array.isArray(targetFiles) ? targetFiles : []).some((tf) => pathTokenMatchesFile(token, tf)),
    );
    const owners = tasks.filter((task) => overlaps(task.targetFiles));
    const hasExternalOwner = externals.some((src) => overlaps(src && src.targetFiles));
    // Sole owner (in-scope AND no external sharer) → per-task gate.
    // Multi-owner → no attachment; the spec-criteria drain is its
    // execution channel (isMultiOwnerCheck re-derives the same verdict
    // drain-side from persisted tasks).
    if (owners.length === 1 && !hasExternalOwner) {
      result.get(owners[0].id).push(check);
    }
  }

  return result;
}

/**
 * Detects path-bearing spec hard checks whose command is not in the given
 * set of assigned commands.
 *
 * Single source for the orphan definition: a check is unassigned iff it
 * (a) is NOT milestone-only (`!isMilestoneOnlyCheck(check, specTargetFiles)`,
 * i.e. has ≥1 path token AND — when `specTargetFiles` is provided — at
 * least one token matches a declared spec target_file) AND
 * (b) is NOT multi-owner among `allTasks` when that list is provided
 * (`isMultiOwnerCheck` — such checks are deliberately unattached; the
 * spec-criteria drain executes them) AND
 * (c) its `.command` is not in `assignedCommands`. Milestone-only checks
 * are NEVER returned — they are excluded via the same shared
 * `isMilestoneOnlyCheck` predicate `scopeSpecHardChecks` uses; the
 * pipeline's last-milestone spec-criteria drain executes them instead.
 *
 * @param {{name: string, command: string}[]} parsedChecks - all parsed spec hard checks
 * @param {Set<string>} assignedCommands - command strings already assigned to some task
 * @param {string[]} [specTargetFiles] - The spec's declared target_files,
 *   forwarded to `isMilestoneOnlyCheck`; omit for legacy zero-token-only
 *   classification
 * @param {{id: string, targetFiles: string[]}[]} [allTasks] - Every
 *   non-invalidated planned task; when provided, multi-owner checks are
 *   never orphans (drain-executed by design)
 * @returns {{name: string, command: string}[]} The subset of parsedChecks that are unassigned
 */
function findUnassignedSpecHardChecks(parsedChecks, assignedCommands, specTargetFiles, projectRoot, allTasks) {
  return parsedChecks.filter((check) => {
    if (isMilestoneOnlyCheck(check, specTargetFiles, projectRoot)) return false;
    if (Array.isArray(allTasks) && isMultiOwnerCheck(check, allTasks, projectRoot)) return false;
    return !assignedCommands.has(check.command);
  });
}

/**
 * Detects path-bearing spec hard checks that were assigned to no task.
 *
 * `scopeSpecHardChecks` silently drops a path-bearing check whose path tokens
 * overlap no task's targetFiles — that criterion then never becomes any task's
 * responsibility and is never verified. This pure helper finds those orphans so
 * the caller can fail the run (or warn) before execution.
 *
 * Delegates to `findUnassignedSpecHardChecks` with the set of commands
 * appearing in any value array of `scopedMap` — the orphan definition
 * (NOT milestone-only AND unassigned; milestone-only checks are NEVER
 * orphans) lives there.
 *
 * @param {{name: string, command: string}[]} parsedChecks - all parsed spec hard checks
 * @param {Map<string, {name: string, command: string}[]>} scopedMap - Map of taskId → scoped checks (as returned by scopeSpecHardChecks)
 * @param {string[]} [specTargetFiles] - The spec's declared target_files,
 *   forwarded to `isMilestoneOnlyCheck`; omit for legacy zero-token-only
 *   classification
 * @returns {{name: string, command: string}[]} The subset of parsedChecks that are orphaned
 */
function findOrphanedSpecHardChecks(parsedChecks, scopedMap, specTargetFiles, projectRoot) {
  const assignedCommands = new Set();
  for (const checks of scopedMap.values()) {
    for (const check of checks) {
      assignedCommands.add(check.command);
    }
  }
  return findUnassignedSpecHardChecks(parsedChecks, assignedCommands, specTargetFiles, projectRoot);
}

/**
 * Validates the intra-plan and cross-mission task dependencies of a planner
 * decomposition plan. For every task dependency, the referenced taskId must
 * resolve either to a task in the current plan or to a task id already
 * persisted by an earlier mission; otherwise it throws.
 *
 * Cross-mission backward dependencies (W1-F7 false kill): under lazy DFS a
 * later mission's planMission output legitimately references EARLIER missions'
 * tasks that are already persisted in the harness's mission-*.json state files
 * — the global-plan prompt explicitly sanctions cross-mission hard deps
 * ("files that share a runtime data contract belong in the SAME mission or in
 * missions with explicit hard dependencies"), and the scheduler's flat
 * per-milestone DAG resolves them. The not-found throw used to fire for ANY
 * dependency target outside the current plan, falsely killing such runs
 * (Wave-1 W1-F7, archives failed-104/105). Callers may therefore pass
 * `knownExternalTaskIds` — the set of task ids already persisted by earlier
 * missions — and a dependency resolving there passes through VERBATIM. Forward
 * references (a later, not-yet-planned mission's ids) stay rejected: under lazy
 * DFS those ids do not exist on disk yet, and the earlier mission cannot defer
 * validation. An id found in neither set throws (genuine hallucinated ids stay
 * fail-closed).
 *
 * Validation runs unconditionally for every plan (there is no spec-hardCheck
 * gate): a dangling/typo'd dep id must never slip through silently, including
 * for specs whose spec.json carries no acceptance criteria.
 *
 * @param {object} plan             - Planner decomposition plan (subMissions)
 * @param {Set<string>} [knownExternalTaskIds] - Task ids persisted by earlier
 *   missions (mission-*.json); deps resolving here pass through verbatim
 * @returns {object} The (unmutated) plan object
 */
function validateTaskDependencies(plan, knownExternalTaskIds = new Set()) {
  if (!plan || !Array.isArray(plan.subMissions)) return plan;

  const allTaskIds = new Set(
    plan.subMissions.flatMap((sm) =>
      Array.isArray(sm?.tasks) ? sm.tasks.map((t) => t.id) : [],
    ),
  );

  for (const sm of plan.subMissions) {
    if (!Array.isArray(sm?.tasks)) continue;
    for (const task of sm.tasks) {
      if (!Array.isArray(task.dependencies)) continue;
      for (const dep of task.dependencies) {
        if (!dep?.taskId) continue;
        // A dependency must resolve to a task in the current plan or to an id
        // persisted by an earlier mission (backward cross-mission deps pass
        // verbatim). An id found in neither set is a hallucinated target.
        if (!allTaskIds.has(dep.taskId) && !knownExternalTaskIds.has(dep.taskId)) {
          throw new Error(
            `Task ${task.id}: dependency target not found in plan or persisted missions (unresolved taskId: ${dep.taskId})`,
          );
        }
      }
    }
  }

  return plan;
}

/**
 * Auto-declare the shared test manifest in every test-creating task's
 * targetFiles, so the scheduler's hasFileConflict serializes concurrent
 * registrations and the lost-update race on scripts/run-tests.js cannot occur.
 *
 * Pure, existence-gated, idempotent in-place transform:
 *   - no-op when <projectRoot>/scripts/run-tests.js does not exist
 *   - for each task across all sub-missions, if it is a test-creating task
 *     (isTestTask) and does not already declare 'scripts/run-tests.js', append it
 *
 * isTestTask is `.some()`-based, so injecting the non-test path
 * 'scripts/run-tests.js' neither demotes a test-task nor promotes a non-test task.
 *
 * @param {object} missionDecomp - Planner decomposition ({ subMissions: [...] })
 * @param {string} projectRoot   - Absolute path to the target project root
 */
function enrichTestTaskTargetFiles(missionDecomp, projectRoot) {
  if (!fs.existsSync(path.join(projectRoot, 'scripts/run-tests.js'))) return;
  for (const task of missionDecomp.subMissions.flatMap((sm) => sm.tasks)) {
    if (isTestTask(task) && !task.targetFiles.includes('scripts/run-tests.js')) {
      task.targetFiles.push('scripts/run-tests.js');
    }
  }
}

export { Planner, extractPathTokens, parseSpecHardChecks, parseSpecFileChecks, parseSpecTargetFiles, pathTokenMatchesFile, isMilestoneOnlyCheck, isMultiOwnerCheck, isWholeSuiteCommand, scopeSpecHardChecks, findOrphanedSpecHardChecks, findUnassignedSpecHardChecks, validateTaskDependencies, enrichTestTaskTargetFiles, _validatePathAnchorPreservation, resolveSpecPathAnchor, _exciseEvalPayloads, PROMPT_SECTION_TASK_SPECIFICITY, PROMPT_SECTION_SYMBOL_ANCHOR, PROMPT_SECTION_LITERAL_PATHS, PROMPT_SECTION_PRESERVE_PATH_ANCHOR, PROMPT_SECTION_NO_READONLY_TASKS, isCheckableCriterion };
