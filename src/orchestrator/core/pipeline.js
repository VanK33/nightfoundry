/**
 * pipeline.js — Pure JS dispatch loop. The heart of nightfoundry.
 *
 * Coordinates all phases: init → preflight → plan → execute → verify → gate.
 * No AI makes decisions here — all logic is deterministic JavaScript.
 *
 * State writes go through state-machine.js (enforces I3/I4/I5/I17).
 * Bootstrap and preflight are pure-JS modules. No shell-script dispatch.
 *
 * Public API:
 *   new Pipeline(projectRoot, opts?)
 *     opts.onLog, opts.onConfirm
 *   run(goal, opts?)   — full pipeline
 *   resume()           — resume from .harness/ state
 */
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { execSync, execFileSync } from 'child_process';
import config from '../infra/config.js';
import { SessionManager, InfrastructureError, WallClockExceededError } from '../infra/session-manager.js';
import { Logger } from '../infra/logger.js';
import { TokenTracker } from '../infra/token-tracker.js';
import { Planner, parseSpecHardChecks, parseSpecFileChecks, parseSpecTargetFiles, isMilestoneOnlyCheck, scopeSpecHardChecks, findUnassignedSpecHardChecks, validateTaskDependencies, enrichTestTaskTargetFiles, isCheckableCriterion } from '../agents/planner.js';
import { Executor } from '../agents/executor.js';
import { Verifier } from '../agents/verifier.js';
import { Analyzer, isRepeatVerdict, readAnalysisHistory, recordHistoryOutcome } from '../agents/analyzer.js';
import { Reviewer, isCleanPass } from '../agents/reviewer.js';
import {
  readState, readTaskStatus, stateToDecomp, writeGlobalPlan,
  writeMissionState, writeVerifyJson, isMissionAlreadyStarted, writeQueueEntry,
  listQueue, readQueueEntry, removeQueueEntry, buildFileToMissionMap,
  assertNoStubVerifierSidecar, writeParkScene, readParkScene,
  updateQueueEntryStatus, writeJsonAtomic,
  writeGateFlags, readGateFlags,
  resolveHarnessFileRef,
} from './state.js';
import {
  transitionTask, transitionSubMission, transitionMission,
  transitionMilestone, cascadeComplete, resolveVerificationSidecar,
} from './state-machine.js';
import { bootstrap } from './bootstrap.js';
import { ensureGitExcludes } from './git-excludes.js';
import { formatBanner } from './banner.js';
import { preflight as runPreflight } from './preflight.js';
import { snapshotFiles, restoreSnapshot, cleanupSnapshots, readAffectedFiles, assertChangesLanded } from './snapshots.js';
import { createParkSnapshot } from './park-snapshot.js';
import { appendCandidate, lintErrorClass } from './candidates-ledger.js';
import { assertNoReentrantLiveRun } from './reentrancy-guard.js';
import { sweepOrphanRunDirs } from './harness-reaper.js';
import {
  harnessRoot,
  activeHarnessDir,
  generateRunId,
  runHarnessDir,
  claimActiveRun,
  readActiveRunPointer,
  clearActiveRunPointer,
} from './run-context.js';
// Defect #15: batchResume + resume must invoke archive() after the review gate.
// The archive function lives in cli/commands/archive.js (architectural smell: CLI
// command file with core logic; refactor candidate). Importing here closes the
// missing-call-site gap. No circular dep — archive.js does not import pipeline.js.
import { archive, TestGateError, runFinalTestGate } from '../../cli/commands/archive.js';
import { auditVerification } from '../gates/audit.js';
import { checkMilestoneCoverage, mergeRemediationTasks } from '../gates/coverage.js';
import { verifyMission, verifyMilestone } from '../gates/regression.js';
import { shouldDowngradeRegressionFail } from '../gates/regression-verdict-filter.js';
import { extractScopeItems } from '../core/scope-parser.js';
import { checkScopeCoverageByMapping } from '../gates/scope-coverage.js';
import { runHardChecks, runMilestoneOnlyChecks, runFileCheckCriteria } from '../gates/hard-checks.js';
import { checkTestRegistration } from '../gates/test-registration.js';
import { IncompleteScopeError } from '../core/incomplete-scope-error.js';
import { VerificationAuditError } from '../core/verification-audit-error.js';
import { appendWarnings, appendUncertainAssumptions } from './warnings-ledger.js';
import { SpecCriterionError } from '../core/spec-criterion-error.js';
import { UncheckableSpecError } from '../core/uncheckable-spec-error.js';
import { Scheduler, canonicalTaskId } from './scheduler.js';
import { Dashboard } from '../infra/dashboard.js';
import { wrapLine, getTerminalWidth } from '../infra/wrap.js';
import { StatusBar } from '../infra/status-bar.js';
import { buildImportGraph, formatGraphForPrompt } from './import-graph.js';
import { askAssumptionFix, askYesNo, askMenu } from '../../cli/prompt.js';
import { HaltError, UserInterruptError } from './halt-error.js';
import { CircuitBreakerError } from './circuit-breaker-error.js';
import { PendingTasksAtMilestoneAdvance } from './pending-tasks-error.js';
import { deriveSpecJsonPath } from './spec-paths.js';
import { readSpecTargetFiles, readSpecConstraints, readSpecAcceptanceCriteria, readSpecGoal, readSpecPlanStructure, buildVerifierSpecContext } from './spec-text.js';
import { ProgressTracker } from './progress-tracker.js';
import { normalizeUncertains, persistUncertainsToState, extractSpecSection, getSpecTargetFiles, applySpecEdit } from './assumption-data.js';
import { runTestRegistrationGate, recordGateOverride, applyHardCheckGate, formatBannerLines, writeVerificationSummary, parseVerificationSidecar, logVerifierPassCounts, writeElapsedToSidecar } from './verification-helpers.js';
import { enumerateSymbolConsumers, readChangedSymbols } from '../gates/blast-radius.js';
import { expandCoupledTargets } from './coupled-files.js';

// Re-export for external importers/tests that reference deriveSpecJsonPath
// from pipeline.js (the function now lives in spec-paths.js, a pure module
// shared with archive.js without creating a pipeline↔archive cycle).
export { deriveSpecJsonPath };

// Pure formatter for zero-delta (phantom-write / NO-OP) diagnostic logging.
// Exported as a testable seam; the emitted sentinel token is produced
// exclusively by calling this function so it appears exactly once in the file.
export function formatZeroDeltaLog(taskId, unchangedFiles) {
  return `[zero-delta-task] task=${taskId} unchanged=${JSON.stringify(unchangedFiles)}`;
}

// The exact HaltError sites raised by _gateMenu inside _reviewGate. In batch
// mode a halt from one of these sites is a pending human review decision, not
// an execution failure — batchResume records it as 'halted-review' with a
// minimal park scene. Any other HaltError site keeps the generic
// failed-execution handling.
const REVIEW_GATE_HALT_SITES = Object.freeze(['review-gate', 'review-gate-file-diff']);

/**
 * Apply spec.json hardChecks to per-task verifier scope.
 *
 * Calls validateTaskDependencies (which validates each task dependency against
 * the current plan and earlier-mission ids), then scopes the acceptance
 * hardChecks to each task's targetFiles via scopeSpecHardChecks, then assigns
 * scoped checks only to tasks that do NOT already carry hardChecks.
 *
 * Runs per-mission under lazy DFS, so it only sees the just-planned mission's
 * tasks — it ONLY assigns, never judges. A path-bearing check matching no task
 * here may simply belong to a later, not-yet-planned mission. Orphan judgment
 * happens ONCE, at the last milestone's drain point, in
 * `Pipeline#_assertSpecHardCheckCoverage` against the union of ALL persisted
 * assignments.
 *
 * @param {object} missionDecomp - mission decomposition with subMissions[].tasks[]
 * @param {string} projectRoot - absolute path to project root
 * @param {string} harnessDir - absolute path to .harness directory
 */
function applySpecHardChecks(missionDecomp, projectRoot, harnessDir) {
  const state = readState(harnessDir);
  const prdPath = state.projectMeta?.prdPath;
  const specJsonPath = deriveSpecJsonPath(prdPath, projectRoot);
  if (!fs.existsSync(specJsonPath)) return;
  const parsedChecks = parseSpecHardChecks(specJsonPath);
  // Spec-declared deliverables, fed to scopeSpecHardChecks so a path-bearing
  // check referencing no declared target_file classifies milestone-only
  // (e.g. a suite-runner command) instead of being scoped/orphaned.
  const declaredSpecTargetFiles = parseSpecTargetFiles(specJsonPath);
  const coupledRules = config.scope?.coupledFiles ?? [];
  const specTargetFiles = expandCoupledTargets(declaredSpecTargetFiles, coupledRules);
  // Backward cross-mission deps: collect every task id already persisted by
  // earlier missions (lazy DFS order) so validateTaskDependencies's dep validation
  // does not falsely kill a plan referencing them (W1-F7). Same fail-soft walk
  // shape as _assertSpecHardCheckCoverage.
  const knownExternalTaskIds = new Set();
  const stateDir = path.join(harnessDir, 'state');
  let missionFiles = [];
  try {
    missionFiles = fs.readdirSync(stateDir).filter((f) => /^mission-.*\.json$/.test(f));
  } catch {
    missionFiles = [];
  }
  for (const file of missionFiles) {
    let msj;
    try {
      msj = JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8'));
    } catch {
      continue; // skip corrupt state files
    }
    for (const sm of Object.values(msj.subMissions || {})) {
      for (const tid of Object.keys(sm.tasks || {})) {
        knownExternalTaskIds.add(tid);
      }
    }
  }
  validateTaskDependencies(missionDecomp, knownExternalTaskIds);
  const allTasks = missionDecomp.subMissions.flatMap((sm) => sm.tasks);
  const scopedChecks = scopeSpecHardChecks(parsedChecks, allTasks, specTargetFiles, projectRoot);
  for (const task of allTasks) {
    if ((task.hardChecks || []).length > 0) continue; // defensive: don't overwrite hardChecks a task already carries (nothing pre-populates them now that same-file splitting is retired)
    const checks = scopedChecks.get(task.id) || [];
    if (checks.length > 0) task.hardChecks = checks;
  }
}

class Pipeline {
  constructor(projectRoot, opts = {}) {
    // Always keep the original project root so we can copy back after success.
    this.mainProjectRoot = projectRoot;
    this.projectRoot = projectRoot;
    this.harnessDir = activeHarnessDir(projectRoot);

    // Injection seam for archive() so batchResume's spec-boundary commit and
    // forensic-archive path can be exercised end-to-end in tests without the
    // real Summarizer. Production passes nothing and uses the real archive().
    this._archive = opts.archive || archive;
    this._runFinalTestGate = opts.runFinalTestGate || runFinalTestGate;

    this.sessionManager = new SessionManager();
    this.logger = new Logger(this.harnessDir);
    this.tokenTracker = new TokenTracker(this.harnessDir);
    this.sessionManager.setTokenTracker(this.tokenTracker);

    this.planner = new Planner(this.sessionManager, this.logger, this.tokenTracker);
    this.executor = new Executor(this.sessionManager, this.logger, this.tokenTracker);
    this.verifier = new Verifier(this.sessionManager, this.logger, this.tokenTracker);
    this.analyzer = new Analyzer(this.sessionManager, this.logger, this.tokenTracker);
    this.reviewer = new Reviewer(this.sessionManager, this.logger, this.tokenTracker);

    this.progress = new ProgressTracker(this.harnessDir, this.logger);

    // Milestone elapsed timer state.
    this._msElapsedInterval = null;
    this._msStartTime = null;
    this._currentMsId = null;
    this._currentMsState = null;
    this._agentElapsedInterval = null;

    // Tracks the runId of the queue entry currently being processed by
    // batchResume (set at the top of each per-entry iteration, before any
    // park-eligible gate runs), so _parkEntry can stamp park.json with the
    // runId of the run that was parked. Left null outside batchResume.
    this._activeEntryRunId = null;

    const userOnLog = opts.onLog || console.log;
    const userOnConfirm = opts.onConfirm || (() => true);
    const userOnMenu = opts.onMenu || null;
    this.dryRun = opts.dryRun || false;
    this.noReview = opts.noReview || false;
    this._allowIncompleteScope = opts.allowIncompleteScope || false;
    this.skipReview = opts.skipReview || false;
    this.autoFromHere = false;
    const { statusBar: statusBarOpt } = opts;

    // StatusBar: TTY-aware persistent status line for single-task progress.
    // Disabled when opts.statusBar === false or stdout is not a TTY.
    // Constructed before Dashboard so Dashboard can receive the statusBar ref.
    const statusBarEnabled = Boolean(process.stdout.isTTY) && statusBarOpt !== false;
    this.statusBar = new StatusBar({
      output: process.stdout,
      enabled: statusBarEnabled,
    });

    // AbortController for cooperative cancellation on SIGINT/SIGTERM.
    // Scheduler and SessionManager observe this signal to stop in-flight work
    // gracefully instead of calling process.exit() directly.
    this._cancelController = new AbortController();
    this.sessionManager.signal = this._cancelController.signal;

    // Wrap user-supplied prompt closures so they automatically receive
    // { statusBar: this.statusBar } as the trailing opts argument. This lets
    // pipeline.js call this.onConfirm(question) / this.onMenu(question, options)
    // unchanged while plumbing statusBar through to prompt.js's askYesNo /
    // askMenu lifecycle hooks (promptWillStart / onLog transcript / promptDidEnd).
    // User closures should accept (question, opts) / (question, options, opts)
    // and forward opts to the underlying ask helpers.
    this.onConfirm = (question) => userOnConfirm(question, { statusBar: this.statusBar });
    this.onMenu = userOnMenu
      ? (question, options) => userOnMenu(question, options, { statusBar: this.statusBar })
      : null;

    // Register process signal handlers so the StatusBar terminal state
    // is always cleaned up — even on Ctrl-C, SIGTERM, or uncaught
    // exceptions. Store references on _signalHandlers so they can be
    // removed in finally blocks to prevent listener leaks across
    // multiple Pipeline instances (e.g. in tests).
    this._signalHandlers = {
      SIGINT: () => {
        this.statusBar.teardown();
        this._cancelController.abort();
      },
      SIGTERM: () => {
        this.statusBar.teardown();
        this._cancelController.abort();
      },
      exit: () => {
        this.statusBar.teardown(); // idempotent — safe if already called
      },
      uncaughtException: (err) => {
        this.statusBar.teardown();
        throw err; // re-throw to preserve Node's default crash behaviour
      },
    };
    process.on('SIGINT', this._signalHandlers.SIGINT);
    process.on('SIGTERM', this._signalHandlers.SIGTERM);
    process.on('exit', this._signalHandlers.exit);
    process.once('uncaughtException', this._signalHandlers.uncaughtException);

    // Phase I items 4+5: dashboard for parallel execution progress.
    // The dashboard is a TTY-aware renderer that owns the persistent
    // status line during scheduler runs. Between milestones (outside an
    // active parallel milestone) it is a passthrough to `sink` — so
    // routing onLog through it is always safe.
    // Pass statusBar ref (or null) so Dashboard can coordinate with
    // StatusBar when both are active.
    this.dashboard = new Dashboard({
      output: process.stdout,
      sink: userOnLog,
      statusBar: statusBarEnabled ? this.statusBar : null,
    });

    // All pipeline log output flows through the dashboard. During the
    // scheduler window the dashboard is active and log lines are
    // emitted above the persistent status line; between milestones it
    // falls through to sink (userOnLog).
    this.onLog = (msg) => this.dashboard.log(msg);
    this.logger.setOnLog(this.onLog);

    // Phase I items 4+5: scheduler for parallel task execution. Wired
    // with a runTask callback that delegates to the existing
    // _executeAndVerifyTask method — pipeline retains task lifecycle
    // knowledge, scheduler handles ordering + concurrency. The
    // scheduler drives every milestone (see _executeMilestoneParallel).
    this.scheduler = this._buildScheduler();
  }

  // Builds the Scheduler instance used to drive parallel task execution.
  // Extracted from the constructor so it can be re-invoked (e.g. after the
  // harness directory is repointed) while reading harnessDir/projectRoot/
  // tokenTracker off `this` at call time.
  _buildScheduler() {
    return new Scheduler({
      harnessDir: this.harnessDir,
      projectRoot: this.projectRoot,
      maxConcurrent: config.execution.maxConcurrentSessions,
      runTask: async (task) => {
        await this._executeAndVerifyTask(task.missionId, task.subMissionId, task);
      },
      onLog: (msg) => this.dashboard.log(msg),
      onProgress: (evt) => this.dashboard.onProgress(evt),
      tokenTracker: this.tokenTracker,
      signal: this._cancelController.signal,
    });
  }

  // Repoints the pipeline at a different harness directory (e.g. when a
  // run's harness is relocated mid-flight) and rebuilds every capture that
  // was frozen against the old harnessDir in the constructor, so all
  // subsequent reads/writes target the new directory.
  _repointHarness(runHarnessDir) {
    this.harnessDir = runHarnessDir;

    const prevLogger = this.logger;
    const prevTokenTracker = this.tokenTracker;

    this.logger = new Logger(this.harnessDir);
    this.logger.setOnLog(this.onLog);

    this.tokenTracker = new TokenTracker(this.harnessDir);
    this.sessionManager.setTokenTracker(this.tokenTracker);

    // Rewire the agents' construction-time logger/tokenTracker captures onto
    // the rebuilt instances. Without this, every session an agent starts
    // after a repoint keeps logging (createSessionLog/attachToSession) and
    // recording usage (recordSession) into the harness dir that was current
    // at Pipeline CONSTRUCTION — observed live 2026-07-14: an entire batch's
    // 34 sessions ($29.27) landed in the flat .harness/logs while the
    // archive's token-usage.json recorded only the summarizer ($0.19).
    // Per-field identity guard: only a capture that still IS the pipeline's
    // previous instance is replaced — an agent (or logger/tracker) injected
    // by a caller after construction is a deliberate collaborator override
    // and must survive the repoint untouched.
    // Residual: a session already open at repoint time (e.g. the planner's
    // reusable session) keeps its existing log handle; only sessions created
    // after the repoint bind to the new dir.
    for (const agent of [this.planner, this.executor, this.verifier, this.analyzer, this.reviewer]) {
      if (!agent) continue;
      if (agent.logger === prevLogger) agent.logger = this.logger;
      if (agent.tokenTracker === prevTokenTracker) agent.tokenTracker = this.tokenTracker;
    }

    this.progress = new ProgressTracker(this.harnessDir, this.logger);

    // Repoint = new spec context: bust the four per-spec getter caches so a
    // pre-repoint read (e.g. _scopeCoverageGate's blast-radius filter running
    // against the pre-bootstrap harnessDir) is never served post-repoint.
    this._specTargetFilesCache = this._specConstraintsCache = this._specAcceptanceCriteriaCache = this._specGoalCache = undefined;
    this._specPlanStructureCache = undefined;

    this.scheduler = this._buildScheduler();
  }

  // ── Private gate helpers ──

  async _scopeCoverageGate(globalPlan, opts = {}) {
    // Reset the blast-radius stash unconditionally at the top of every gate
    // run so a prior run's uncovered-consumers list never leaks forward.
    this._uncoveredConsumers = [];

    // Reads the PLAN OBJECT only — never re-extract from markdown, never read
    // state.json. scopeItems/scopeMapping are fields carried on the plan
    // (attached by run()/dryRunValidate(), round-tripped via the queue for
    // batchResume, rehydrated from persisted state by resume()).
    // Tri-state, in order:

    // 1. Key absent → LEGACY → fail-closed (escapable via _allowIncompleteScope).
    if (globalPlan.scopeItems === undefined) {
      if (this._allowIncompleteScope) {
        this.onLog('Scope coverage: legacy run (scope set not persisted) — proceeding under --allow-incomplete-scope.');
        return;
      }
      throw new IncompleteScopeError(['<legacy run: scope set not persisted; re-run planning or pass --allow-incomplete-scope>']);
    }

    // 2. Present & empty → GOAL-ONLY → skip.
    if (globalPlan.scopeItems.length === 0) {
      this.onLog('Scope coverage: goal-only run (no scope items extracted), skipping.');
      return;
    }

    // 3. Non-empty → mapping check against the plan's own mission ids.
    const validMissionIds = new Set(
      (globalPlan.milestones || []).flatMap((ms) => ms.missions || []).map((m) => m.id)
    );
    const result = checkScopeCoverageByMapping(
      globalPlan.scopeItems,
      globalPlan.scopeMapping || [],
      validMissionIds
    );
    if (result.uncovered.length > 0) {
      if (this._allowIncompleteScope) {
        this.onLog(`Scope coverage warning: the following scope items are not covered by any mission:\n${result.uncovered.map((label) => `  - ${label}`).join('\n')}`);
        return;
      }
      throw new IncompleteScopeError(result.uncovered);
    }
    this.onLog(`Scope coverage: all ${globalPlan.scopeItems.length} item(s) covered.`);

    // Advisory blast-radius check: never throws, never parks. Reads the
    // changed symbols persisted on the spec.json sidecar (if any) and warns
    // (log + one ledger entry) when a symbol's textual consumers fall
    // outside the mission's declared target_files. this._uncoveredConsumers
    // was already reset to [] at the top of this method, so a fully-covered
    // remainder (or an empty changed-symbols set) leaves it [].
    let changedSymbols;
    try {
      let prdPath;
      try {
        prdPath = readState(this.harnessDir).projectMeta?.prdPath;
      } catch {
        prdPath = undefined;
      }
      const specJsonPath = deriveSpecJsonPath(prdPath, this.projectRoot);
      changedSymbols = readChangedSymbols(specJsonPath);
    } catch {
      changedSymbols = [];
    }
    // Not-applicable path: no changed symbols recorded → zero further reads,
    // writes, logs, or this-accesses.
    if (changedSymbols.length === 0) return;

    try {
      const consumersByFile = enumerateSymbolConsumers(changedSymbols, this.projectRoot);
      const specTargetFilesSet = new Set(
        this._getSpecTargetFiles().map((f) => this._normalizePath(f))
      );
      const uncoveredConsumers = Object.keys(consumersByFile).filter(
        (file) => !specTargetFilesSet.has(this._normalizePath(file))
      );

      if (uncoveredConsumers.length > 0) {
        this.onLog(`Blast-radius warning: the following files textually consume changed symbols but are outside the spec's target_files:\n${uncoveredConsumers.map((f) => `  - ${f}`).join('\n')}`);
        appendWarnings(this.projectRoot, [{
          severity: 'warning',
          category: 'blast-radius',
          description: `Changed symbols have consumers outside the spec's target_files: ${uncoveredConsumers.join(', ')}`,
        }]);
        this._uncoveredConsumers = uncoveredConsumers;
      }
    } catch (err) {
      this.onLog(`  [WARN] blast-radius advisory check failed (run continues): ${err.message}`);
    }
  }

  /**
   * Decides whether to release the active-run pointer after a failure that
   * occurred somewhere in the planning window (claim → bootstrap →
   * preflight → planGlobal, before any milestone has been committed to
   * state.json). Only the invocation that itself claimed the pointer via
   * claimActiveRun(kind:'run') owns it and may release it here — the
   * opts.preclaimedRun path never owns the pointer, so it always leaves it
   * in place.
   *
   * Even when this invocation owns the claim, the pointer is only cleared
   * while the persisted state still has zero milestones — i.e. the failure
   * happened before any milestone existed. Once milestones exist the
   * pointer must be left in place so resume() can find the run.
   *
   * Deliberately does NOT use isUnresumableState: that predicate returns
   * false when state.json is entirely absent, which would leak the pointer
   * on failures that happen before bootstrap ever writes state.json.
   *
   * Best-effort throughout: any failure reading/parsing state.json, or
   * clearing the pointer, is swallowed here — this must never mask the
   * original error that triggered the call.
   */
  _releaseActiveRunPointerOnPlanningFailure(claimedInThisInvocation) {
    if (!claimedInThisInvocation) return;

    let shouldRelease = false;
    try {
      const state = readState(this.harnessDir);
      const milestoneCount = Object.keys(state?.milestones || {}).length;
      shouldRelease = milestoneCount === 0;
    } catch {
      // state.json absent, unreadable, or malformed — treat as "release".
      shouldRelease = true;
    }

    if (!shouldRelease) return;

    try {
      const pointer = readActiveRunPointer(this.projectRoot);
      const pointerRunId = (pointer && typeof pointer.runId === 'string') ? pointer.runId : 'unknown';
      clearActiveRunPointer(this.projectRoot);
      this.onLog(`Released active-run pointer for run ${pointerRunId} after planning failure.`);
    } catch {
      // best-effort — pointer cleanup must never mask the triggering error.
    }
  }

  // ── Public API ──

  async run(goal, opts = {}) {
    assertNoReentrantLiveRun(this.projectRoot);
    this._runStartSessionCount = this.tokenTracker.getTotalUsage().sessionCount;

    // Derive a run id + slug (mirrors dryRunValidate's slug derivation
    // below) and atomically claim the active-run pointer BEFORE
    // bootstrapping, so two concurrent run() invocations against the same
    // project root cannot stomp each other's per-run harness state.
    //
    // When the caller already holds a claimed active-run pointer (e.g. the
    // CLI claimed it earlier in the same process to avoid a race between
    // claim and run()), opts.preclaimedRun carries that pointer's
    // {runId, slug, kind}. We only honor it — skipping claimActiveRun
    // entirely — when the on-disk active-run pointer still matches the
    // supplied runId; otherwise (stale/foreign/no pointer) we fall through
    // to the pre-existing derive-slug/claim path below unchanged.
    // Tracks whether THIS invocation's own claimActiveRun(kind:'run') call
    // succeeded — only that owning invocation may release the pointer on a
    // planning-window failure (see _releaseActiveRunPointerOnPlanningFailure).
    // Stays false on the opts.preclaimedRun path, where the caller owns the
    // pointer.
    let claimedInThisInvocation = false;

    const preclaimedRun = opts.preclaimedRun;
    const _onDiskPointer = preclaimedRun ? readActiveRunPointer(this.projectRoot) : null;
    const _preclaimedMatches = !!(
      preclaimedRun &&
      _onDiskPointer &&
      typeof _onDiskPointer.runId === 'string' &&
      _onDiskPointer.runId === preclaimedRun.runId
    );

    try {
      if (_preclaimedMatches) {
        const runId = preclaimedRun.runId;
        this.onLog('Initializing harness...');
        bootstrap(this.projectRoot, { runId, prdPath: opts.prdPath });
        this._repointHarness(runHarnessDir(this.projectRoot, runId));
        this.onLog(`Harness initialized at ${this.harnessDir}`);
      } else {
        const specFilename = opts.prdPath ? path.basename(opts.prdPath) : 'spec';
        const slug = specFilename.replace(/\.[^.]+$/, '');
        const runId = generateRunId(slug);
        const claimed = claimActiveRun(this.projectRoot, { runId, slug, kind: 'run' });
        if (claimed) {
          claimedInThisInvocation = true;
          sweepOrphanRunDirs(this.projectRoot, { log: (m) => this.onLog(m) });
          this.onLog('Initializing harness...');
          // bootstrap() is NOT individually try/catch'd here — it's covered by
          // the single outer try/catch (added below, wrapping this entire
          // if/else through the end of the planning window) that invokes
          // _releaseActiveRunPointerOnPlanningFailure exactly once on any
          // throw before the error propagates.
          bootstrap(this.projectRoot, { runId, prdPath: opts.prdPath });
          this._repointHarness(runHarnessDir(this.projectRoot, runId));
          this.onLog(`Harness initialized at ${this.harnessDir}`);
        } else {
          // Another run already holds the active-run pointer. Classify its
          // disposition via the existing overwrite-protection check: a
          // completed-unarchived or halted-after-all-milestones-done run
          // throws there (its existing complete/all-done throw semantics
          // propagate unchanged, satisfying the "route to
          // _checkOverwriteProtection" requirement); anything else — the
          // claim owner is still bootstrapping, still actively working through
          // milestones, or resumably paused with pending work — does NOT
          // throw there, meaning the pointer denotes a still-active run, so we
          // refuse outright and return without bootstrapping.
          const pointer = readActiveRunPointer(this.projectRoot);
          const pointerRunId = (pointer && typeof pointer.runId === 'string') ? pointer.runId : null;
          const pointerDir = pointerRunId ? runHarnessDir(this.projectRoot, pointerRunId) : this.harnessDir;

          this._checkOverwriteProtection(pointerDir);

          this.onLog(
            `Refusing to start a new run: the active-run pointer at ${pointerDir} is already held` +
            (pointerRunId ? ` by run ${pointerRunId}` : '') +
            `. If it is still progressing or resumable, run \`cc-orch resume\`; ` +
            `if it is wedged and should be discarded, run \`cc-orch clean\`.`
          );
          return;
        }
      }

      this._anchorPrdPath(opts);

      // w4-state-resume-persistence Fix #2: persist the --allow-incomplete-scope
      // disposition granted at run entry so a later bare `cc-orch resume` honors
      // what this run legitimately allowed (gate warned, plan approved, money
      // spent) instead of hard-failing with IncompleteScopeError.
      if (this._allowIncompleteScope) {
        writeGateFlags(this.harnessDir, { allowIncompleteScope: true });
      }

      this._runPreflight();
      this._startAgentTicker();

      try {
        // Phase 3a: Global decomposition
        this.onLog('Planning: decomposing goal into milestones and missions...');
        const learningPath = path.join(harnessRoot(this.projectRoot), 'learning', 'patterns.md');
        const learningData = fs.existsSync(learningPath) ? fs.readFileSync(learningPath, 'utf8') : undefined;

        // Phase I items 4+5: build the project's import graph and inject
        // it into the planner's context so planGlobal can decompose by
        // runtime dependency (call-graph topology) rather than by
        // file-tree proximity (directory grouping). Auto-generated from
        // source on every run — never stale.
        const importGraph = formatGraphForPrompt(buildImportGraph(this.projectRoot));
        this._cachedImportGraph = importGraph;

        // Extract the authoritative scope-item set ONCE, before planning. The
        // ids are position-derived and stay authoritative for the life of the
        // run (no re-extraction anywhere); the planner declares the mapping
        // against them, the gate verifies completeness against the plan object.
        const specMarkdown = (opts.prdPath && fs.existsSync(opts.prdPath)) ? fs.readFileSync(opts.prdPath, 'utf8') : '';
        const scopeItems = extractScopeItems(specMarkdown);

        const _planGlobalStart = Date.now();
        this.statusBar.updateAgent('planner', { role: 'planner', status: 'active', startedAt: _planGlobalStart, cost: this.tokenTracker.getUsageByType('planner').totalCostUsd });
        this.statusBar.setPhase('planning global');
        let globalPlan;
        try {
          globalPlan = await this.planner.planGlobal(goal, this.projectRoot, {
            prdPath: opts.prdPath,
            learningData,
            importGraph,
            mode: opts.mode,
            specTargetFiles: this._getSpecTargetFiles(),
            specAcceptanceCriteria: this._getSpecAcceptanceCriteria(),
            specScopeItems: scopeItems,
            specConstraints: this._getSpecConstraints(),
            specPlanStructure: this._getSpecPlanStructure(),
          });
        } finally {
          this.statusBar.updateAgent('planner', null);
        }
        this.onLog(`  planGlobal completed in ${this._formatElapsed(Date.now() - _planGlobalStart)}`);

        // Attach the authoritative scope set + normalise the planner's mapping
        // onto the in-memory plan object BEFORE the gate and writeGlobalPlan.
        globalPlan.scopeItems = scopeItems;
        if (!Array.isArray(globalPlan.scopeMapping)) globalPlan.scopeMapping = [];

        // Small-task mode: enforce plan complexity limits.
        this._mode = opts.mode;
        if (opts.mode === 'small-task') {
          this._skipCoverageGate = true;
          // w4-state-resume-persistence Fix #2: persist the skipCoverageGate
          // disposition at the point run() grants it (small-task mode), so a
          // bare resume of a small-task run does not re-impose the coverage gate
          // the original invocation legitimately skipped.
          writeGateFlags(this.harnessDir, { skipCoverageGate: true });
          const numMilestones = globalPlan.milestones.length;
          const numMissions = globalPlan.milestones.reduce((sum, ms) => sum + ms.missions.length, 0);
          if (numMilestones > config.smallTask.maxMilestones || numMissions > config.smallTask.maxMissions) {
            this.onLog('Task is too complex for small-task mode. Write a full spec instead.');
            return;
          }
        }

        // Phase 3a steps 5-6: Verify assumptions + remediation
        if (globalPlan.assumptions?.length) {
          const remResult = await this._remediateAssumptions(globalPlan, { prdPath: opts.prdPath ?? null, mode: opts.auto ? 'autonomous' : 'interactive' });
          if (!remResult.passed) return;
        }

        if (!this._skipCoverageGate) {
          await this._scopeCoverageGate(globalPlan, opts);
          this._detectUncheckableSpec(opts);
        }

        writeGlobalPlan(this.harnessDir, globalPlan);

        this.onLog('\n=== Proposed Plan ===');
        for (const ms of globalPlan.milestones) {
          this.onLog(this._formatBanner('Milestone', ms.id, ms.description, { indent: '  ' }).join('\n'));
          for (const mi of ms.missions) {
            this.onLog(this._formatBanner('Mission', mi.id, mi.description, { indent: '    ' }).join('\n'));
          }
        }

        if (this.autoFromHere) {
          // auto-approve mode active — skip plan-confirm prompt and proceed
        } else if (this.onMenu) {
          const choice = await this.onMenu('Proceed with this plan?', [
            { key: 'y', label: 'Yes' },
            { key: 'n', label: 'No' },
            { key: 'a', label: 'Yes, and auto-approve from here' },
          ]);
          if (choice === 'n') {
            this.onLog('Plan rejected by user. Stopping.');
            return;
          }
          if (choice === 'a') {
            this.autoFromHere = true;
          }
        }

        await this._executeAllMilestones(globalPlan);

        if (this._cancelController.signal.aborted) {
          this.onLog('Pipeline cancelled — skipping review gate');
          return;
        }

        await this._reviewGate({ ...opts, autoAccept: this.autoFromHere });

        // Fix 1: run() never archives, so archive()'s full-suite gate never fires on this
        // path. Run it here (no archive, no bump) so `cc-orch run` fails closed when the whole
        // suite is red. Auto-skips when the target has no test:all script.
        this._runFinalTestGate(this.projectRoot, {});

        try {
          const completeState = readState(this.harnessDir);
          completeState.globalStatus = 'complete';
          writeJsonAtomic(path.join(this.harnessDir, 'state.json'), completeState);
        } catch { /* best-effort marker */ }
      } finally {
        // Release the reusable planner session. Safe no-op if no session
        // was opened. MUST be in a finally block so the SDK subprocess is
        // released even if the pipeline throws.
        await this.planner.closeReusableSession();
        if (this._msElapsedInterval !== null) {
          clearInterval(this._msElapsedInterval);
          this._msElapsedInterval = null;
        }
        this._stopAgentTicker();
        // Remove signal handlers to prevent listener leaks across
        // multiple Pipeline instances (e.g. in tests).
        process.removeListener('SIGINT', this._signalHandlers.SIGINT);
        process.removeListener('SIGTERM', this._signalHandlers.SIGTERM);
        process.removeListener('exit', this._signalHandlers.exit);
        process.removeListener('uncaughtException', this._signalHandlers.uncaughtException);
        this.statusBar.destroy();
      }
      return { runStartSessionCount: this._runStartSessionCount };
    } catch (err) {
      this._releaseActiveRunPointerOnPlanningFailure(claimedInThisInvocation);
      throw err;
    }
  }

  /**
   * Emit "This Run" cost summary using the in-memory tokenTracker.
   *
   * Must be called BEFORE archive() teardown moves logs/token-usage.json
   * into archives/{seq}/. The CLI's post-pipeline printUsage call reads
   * from disk; if it runs after archive teardown, sessionCount goes
   * negative (baseline was captured before archive, current is post-wipe).
   * The in-memory tracker still has all sessions at this point.
   */

  /**
   * Gate-confirm helper for categorised confirmation prompts.
   * @param {string} site       - unique site identifier (e.g. 'queue-spec-approve')
   * @param {string} question   - human-readable prompt text
   * @param {object} opts       - { safeDefault: boolean, category: string }
   * @returns {Promise<boolean>}
   */
  async _gateConfirm(site, question, opts = {}) {
    const { category } = opts;

    // ── Category A: auto-approve without prompting ─────────────────────────
    if (this.autoFromHere && category === 'A') {
      this.onLog(`[auto] ${site} auto-approved`);
      return opts.safeDefault ?? true;
    }

    // ── Category B / C: halt — require explicit human decision ─────────────
    if (this.autoFromHere && (category === 'B' || category === 'C')) {
      if (!process.stdout.isTTY) {
        throw new HaltError(site, 'non-TTY cannot prompt for category-B/C confirmation');
      }

      // TTY: bypass the wrapped onConfirm and call askYesNo directly so the
      // user is forced to make an explicit real decision.
      const result = await askYesNo(question, { statusBar: this.statusBar });

      if (result) {
        // halt-y: user chose to override the failure.  Re-confirm whether
        // auto mode should continue for subsequent gates.
        const continueAuto = await askYesNo('Continue in auto mode? [y/n]', { statusBar: this.statusBar });
        if (!continueAuto) {
          this.autoFromHere = false;
        }
      }

      return result;
    }

    // ── Non-auto mode (or unrecognised category): delegate to onConfirm ────
    return this.onConfirm(question);
  }

  /**
   * _gateMenu(site, question, options, opts?) — Per-category menu gate.
   *
   * Category is inferred from options:
   *   options non-null → Category B (fixed-choice menu)
   *   options null     → Category C (free-text input)
   *
   * When autoFromHere=false: delegates to this.onMenu(question, options, opts).
   *
   * When autoFromHere=true:
   *   - TTY:     calls askMenu(question, options, { statusBar, ...streams }) and returns result.
   *   - non-TTY: throws HaltError(site, reason) — exit-77 semantics.
   *
   * @param {string}      site     - unique site identifier
   * @param {string}      question - human-readable prompt text
   * @param {Array|null}  options  - choices array (Category B) or null (Category C)
   * @param {object}      opts     - { reason: string, ... }
   * @returns {Promise<string>}
   */
  async _gateMenu(site, question, options, opts = {}) {
    const { reason } = opts;

    // Non-auto mode: delegate to the normal menu closure unchanged.
    if (!this.autoFromHere) {
      return this.onMenu(question, options, opts);
    }

    // autoFromHere=true — must gate on TTY availability.
    if (!process.stdin.isTTY) {
      throw new HaltError(site, reason);
    }

    // TTY path: call askMenu in appropriate mode.
    // Category C (options===null): free-text input.
    // Category B (options array): fixed-choice menu.
    return await askMenu(question, options ?? null, { statusBar: this.statusBar, ...(this._streams || {}) });
  }

  _emitRunCostSummary() {
    const baseline = this._runStartSessionCount;
    if (baseline === undefined || baseline === null) return;
    const runTotals = this.tokenTracker.getUsageSince(baseline);
    // Use the same accessor as the baseline-capture site (resume() at line 407)
    // so in-flight sessions, if any, are counted symmetrically. Direct
    // _sessions.length access would diverge by the in-flight delta.
    const runSessionCount = this.tokenTracker.getTotalUsage().sessionCount - baseline;
    this.onLog('\n--- This Run ---');
    this.onLog(`  Sessions: ${runSessionCount}`);
    this.onLog(`  Input tokens: ${runTotals.inputTokens.toLocaleString()}`);
    this.onLog(`  Output tokens: ${runTotals.outputTokens.toLocaleString()}`);
    this.onLog(`  Total cost: $${runTotals.totalCostUsd}`);
  }

  /**
   * dryRunValidate(goal, opts) — Validate a spec without executing it.
   *
   * Runs bootstrap → preflight → planGlobal → verifyAssumptions (with
   * interactive remediation) → user approval → writes queue entry.
   *
   * On approval, derives a slug from opts.prdPath (e.g. 'spec-foo.md' → 'spec-foo'),
   * copies the spec to queue/{slug}/spec.md, writes plan.json,
   * validated-at.json, and status ('pending').
   *
   * Returns early — never calls writeMissionState or writeGlobalPlan.
   */
  async dryRunValidate(goal, opts = {}) {
    assertNoReentrantLiveRun(this.projectRoot);
    // ── 1. Bootstrap into a per-run scratch harness (no active-run claim) ──
    // dryRunValidate never competes for the active-run pointer — it only
    // needs a throwaway harness dir to plan against. Derive a runId + slug
    // (mirrors run()'s derivation, but without claimActiveRun) and bootstrap
    // straight into that run's scratch harness dir. The scratch dir is
    // self-cleaned after a successful queue write (see §6c below); on
    // failure it is deliberately left in place for inspection and the
    // original error propagates unmasked.
    const _runIdSpecFilename = opts.prdPath ? path.basename(opts.prdPath) : 'spec';
    const _runIdSlug = _runIdSpecFilename.replace(/\.[^.]+$/, '');
    const runId = generateRunId(_runIdSlug);
    const scratchHarnessDir = runHarnessDir(this.projectRoot, runId);

    this.onLog('Initializing harness...');
    bootstrap(this.projectRoot, { runId, prdPath: opts.prdPath });
    fs.writeFileSync(path.join(scratchHarnessDir, 'dry-run.marker'), '');
    this._repointHarness(scratchHarnessDir);
    this.onLog(`Harness initialized at ${this.harnessDir}`);

    this._anchorPrdPath(opts);

    // w4-state-resume-persistence Fix #2: persist the --allow-incomplete-scope
    // disposition granted at dryRunValidate entry (symmetric with run()).
    if (this._allowIncompleteScope) {
      writeGateFlags(this.harnessDir, { allowIncompleteScope: true });
    }

    // ── 2. Preflight ──────────────────────────────────────────────────────
    this._runPreflight();
    this._startAgentTicker();

    try {
      // ── 2a. Missing-prdPath gate (fail honestly at validate time) ──────
      // w4-state-resume-persistence Fix #3 rider: a dryRunValidate invoked
      // without a prdPath currently passes the uncheckable gate at validate
      // time but is guaranteed to fail at execute time. Fail it here instead.
      //
      // The guard MUST use strict-equality `=== undefined`, NOT `!opts.prdPath`:
      // goal-only mode deliberately passes `prdPath: null` as an explicit
      // "spec-text-instead-of-path" signal, and `!null === true` would
      // mis-reject it. Only `undefined` means "the caller forgot to pass
      // prdPath" — the genuine failure case.
      if (opts.prdPath === undefined) {
        throw new Error(
          'dryRunValidate requires a prdPath (spec file path). The caller passed no prdPath; ' +
          'this entry would pass validation but fail at execute time. ' +
          '(Goal-only mode must pass prdPath: null explicitly.)'
        );
      }

      // ── 2a'. Non-.md spec-input gate (kill the spec.json-theft vector) ──
      // w4-batch-failure-input-boundary Fix #3: a truthy non-.md prdPath makes
      // deriveSpecJsonPath fall back to <projectRoot>/spec.json — the §6 copy/
      // unlink block below would then COPY an unrelated root spec.json into the
      // queue entry AND UNLINK it from the project root. Reject it here at the
      // queue boundary with an honest error naming the requirement. Goal-only
      // mode (prdPath === null) is exempt: it carries no path, so there is no
      // sibling to derive and no file to steal.
      if (opts.prdPath !== null && !String(opts.prdPath).endsWith('.md')) {
        throw new Error(
          `Spec input must be a .md file (got: ${opts.prdPath}). ` +
          'A non-.md spec input would attach an unrelated project-root spec.json to the ' +
          'queue entry and unlink it from the root. Provide a Markdown spec whose sibling ' +
          'spec.json carries the verification criteria.'
        );
      }

      // ── 2b. Uncheckable-spec gate (fail closed before any LLM spend) ──
      // Deliberately OUTSIDE the structured-return contract: the typed
      // UncheckableSpecError throw is a pinned public contract
      // (test-queue-spec-json.js TC4a; the batch loop catches it by type at
      // its own call site) and it already surfaces as a loud CLI failure —
      // it never had the silent-success problem the { queued } return was
      // built to fix. Only the silent-return legs below use { queued: false }.
      if (!this._skipCoverageGate) {
        this._detectUncheckableSpec(opts);
      }

      // ── 3. planGlobal ─────────────────────────────────────────────────
      this.onLog('Planning: decomposing goal into milestones and missions...');
      const learningPath = path.join(harnessRoot(this.projectRoot), 'learning', 'patterns.md');
      const learningData = fs.existsSync(learningPath) ? fs.readFileSync(learningPath, 'utf8') : undefined;
      const importGraph = formatGraphForPrompt(buildImportGraph(this.projectRoot));

      // Extract the authoritative scope-item set ONCE, before planning — same
      // as run(). Attached below so the fields round-trip into the queue entry.
      const specMarkdown = (opts.prdPath && fs.existsSync(opts.prdPath)) ? fs.readFileSync(opts.prdPath, 'utf8') : '';
      const scopeItems = extractScopeItems(specMarkdown);

      const _planGlobalStart = Date.now();
      this.statusBar.updateAgent('planner', { role: 'planner', status: 'active', startedAt: _planGlobalStart, cost: this.tokenTracker.getUsageByType('planner').totalCostUsd });
      this.statusBar.setPhase('planning global');
      let globalPlan;
      try {
        globalPlan = await this.planner.planGlobal(goal, this.projectRoot, {
          prdPath: opts.prdPath,
          learningData,
          importGraph,
          mode: opts.mode,
          specTargetFiles: this._getSpecTargetFiles(),
          specAcceptanceCriteria: this._getSpecAcceptanceCriteria(),
          specScopeItems: scopeItems,
          specConstraints: this._getSpecConstraints(),
          specPlanStructure: this._getSpecPlanStructure(),
        });
      } finally {
        this.statusBar.updateAgent('planner', null);
      }
      this.onLog(`  planGlobal completed in ${this._formatElapsed(Date.now() - _planGlobalStart)}`);

      // Attach scope set + normalise mapping BEFORE writeQueueEntry below, so
      // scopeItems/scopeMapping round-trip into the queue entry's plan.json and
      // batchResume gates them.
      globalPlan.scopeItems = scopeItems;
      if (!Array.isArray(globalPlan.scopeMapping)) globalPlan.scopeMapping = [];

      // ── 4. verifyAssumptions with interactive remediation ─────────────
      const verifiedAssumptions = [];
      if (globalPlan.assumptions?.length) {
        const remResult = await this._remediateAssumptions(globalPlan, { prdPath: opts.prdPath ?? null, mode: opts.auto ? 'autonomous' : 'interactive' });
        if (!remResult.passed) {
          // _remediateAssumptions returns { passed: false, anyEditsApplied } for
          // two distinct legs: (a) spec edits were applied but assumptions still
          // failed after round-2 re-verification ("assumption-escalation"), or
          // (b) no edits were applied and the user declined the "Proceed
          // anyway?" prompt ("declined proceed-anyway"). No typed throw here —
          // additive structured return only.
          return {
            queued: false,
            reason: remResult.anyEditsApplied
              ? 'assumption escalation: assumptions still failed after spec remediation'
              : 'declined proceed-anyway: user chose not to proceed with failed assumptions',
          };
        }
      }

      // ── 5. Display proposed plan and prompt user to approve ───────────
      this.onLog('\n=== Proposed Plan ===');
      for (const ms of globalPlan.milestones) {
        this.onLog(this._formatBanner('Milestone', ms.id, ms.description, { indent: '  ' }).join('\n'));
        for (const mi of ms.missions) {
          this.onLog(this._formatBanner('Mission', mi.id, mi.description, { indent: '    ' }).join('\n'));
        }
      }

      if (!await this._gateConfirm('queue-spec-approve', 'Approve and queue this spec?', { safeDefault: true, category: 'A' })) {
        this.onLog('Plan rejected by user. Stopping.');
        return { queued: false, reason: 'plan rejected by user' };
      }

      // ── 6. Derive slug and write queue entry ──────────────────────────
      const specPath = opts.prdPath ?? null;
      const specFilename = specPath ? path.basename(specPath) : 'spec';
      // e.g. 'spec-foo.md' → 'spec-foo', 'spec.md' → 'spec'
      const slug = specFilename.replace(/\.[^.]+$/, '');

      const specContent = specPath && fs.existsSync(specPath)
        ? fs.readFileSync(specPath, 'utf8')
        : goal;

      const validatedAt = new Date().toISOString();

      // Carry the spec.json sibling into the queue entry so the spec.json
      // gate chain (hard checks, drain, verifier injection, reviewer) stays
      // live for queued specs. Read content BEFORE the 6b unlink below.
      const specJsonSourcePath = specPath ? deriveSpecJsonPath(specPath, this.projectRoot) : null;
      // w4-batch-failure-input-boundary Fix #3 (defense in depth): only treat the
      // derived json as the spec's own when it is a TRUE SIBLING — same directory
      // as the spec. For a .md spec, deriveSpecJsonPath returns the sibling .json,
      // so this always holds. Should the non-.md path restriction above ever
      // loosen, a non-sibling fallback (e.g. <projectRoot>/spec.json for a spec
      // that does NOT live at the root) is NOT this spec's json — never copy it
      // into the queue entry, never unlink it from its canonical location.
      const specJsonIsTrueSibling =
        !!specPath && !!specJsonSourcePath &&
        path.dirname(path.resolve(specJsonSourcePath)) === path.dirname(path.resolve(specPath));
      const specJsonContent = specJsonIsTrueSibling && fs.existsSync(specJsonSourcePath)
        ? fs.readFileSync(specJsonSourcePath, 'utf8')
        : undefined;

      // w4-state-resume-persistence Fix #3: slug reuse must not leak the
      // previous entry's spec.json. writeQueueEntry is deliberately
      // non-destructive when specJson is undefined (it leaves any existing
      // spec.json in place). When the NEW entry carries no spec.json (a bare
      // .md re-queue), an old spec.json from a prior failed attempt at the same
      // slug would survive and make the batch gate verify the OLD criteria for
      // the NEW spec (false-green vector). Remove it here so the queue contract
      // "a bare-.md entry must not contain spec.json" holds.
      if (specJsonContent === undefined) {
        const staleQueueJson = path.join(this.projectRoot, 'queue', slug, 'spec.json');
        if (fs.existsSync(staleQueueJson)) {
          fs.unlinkSync(staleQueueJson);
          this.onLog(`Removed stale queue spec.json from prior entry at slug '${slug}'.`);
        }
      }

      // Recreation park.json cleanup: a fresh validate at this slug always
      // starts a brand-new entry. writeQueueEntry resets status to 'pending'
      // but (like spec.json above) never touches park.json — a scene left
      // over from a PRIOR halted-analyzer/parked disposition at the same
      // slug would otherwise survive into the recreated entry as a zombie
      // record. Remove it here, same tier as the stale spec.json cleanup.
      const staleParkJson = path.join(this.projectRoot, 'queue', slug, 'park.json');
      if (fs.existsSync(staleParkJson)) {
        fs.unlinkSync(staleParkJson);
        this.onLog(`Removed stale queue park.json from prior entry at slug '${slug}'.`);
      }

      writeQueueEntry(this.projectRoot, slug, {
        spec: specContent,
        plan: globalPlan,
        validatedAt,
        assumptionResults: verifiedAssumptions,
        specJson: specJsonContent,
        status: 'pending',
      });

      // ── 6b. Remove original spec file (now copied into queue) ─────────
      const queueCopyPath = path.resolve(path.join(this.projectRoot, 'queue', slug, 'spec.md'));
      if (
        specPath &&
        path.resolve(specPath) !== queueCopyPath &&
        path.resolve(specPath).startsWith(path.resolve(this.projectRoot) + path.sep)
      ) {
        fs.unlinkSync(specPath);
        this.onLog(`Original spec removed: ${specPath}`);
      }

      // Remove the original spec.json sibling under exactly the same guards
      // as the .md above (content was read before this unlink).
      // w4-batch-failure-input-boundary Fix #3 (defense in depth): also gate on
      // specJsonIsTrueSibling so a non-sibling fallback (e.g. <projectRoot>/
      // spec.json) is NEVER unlinked — it is not this spec's json.
      const queueJsonCopyPath = path.resolve(path.join(this.projectRoot, 'queue', slug, 'spec.json'));
      if (
        specJsonIsTrueSibling &&
        specJsonSourcePath &&
        path.resolve(specJsonSourcePath) !== queueJsonCopyPath &&
        path.resolve(specJsonSourcePath).startsWith(path.resolve(this.projectRoot) + path.sep) &&
        fs.existsSync(specJsonSourcePath)
      ) {
        fs.unlinkSync(specJsonSourcePath);
        this.onLog(`Original spec.json removed: ${specJsonSourcePath}`);
      }

      // ── 6c. Update state.json prdPath to queue copy ───────────────────
      const stateData = readState(this.harnessDir);
      if (!stateData.projectMeta) stateData.projectMeta = {};
      stateData.projectMeta.prdPath = path.join(this.projectRoot, 'queue', slug, 'spec.md');
      fs.writeFileSync(
        path.join(this.harnessDir, 'state.json'),
        JSON.stringify(stateData, null, 2),
      );

      // ── 6d. Self-clean the per-run scratch harness dir ─────────────────
      // The queue entry (§6) and state.json update (§6c) have both landed
      // successfully at this point, so the scratch harness this run
      // bootstrapped into is no longer needed. Remove it best-effort: any
      // cleanup error is swallowed here rather than rethrown, so it can
      // never mask the success path or clobber a later error.
      try {
        fs.rmSync(scratchHarnessDir, { recursive: true, force: true });
      } catch { /* best-effort scratch cleanup; never masks success */ }

      // ── 7. Log and return early ───────────────────────────────────────
      this.onLog(`Spec validated and queued: queue/${slug}/`);
      return { queued: true };
    } finally {
      await this.planner.closeReusableSession();
      this._stopAgentTicker();
    }
  }

  async resume() {
    assertNoReentrantLiveRun(this.projectRoot);
    this._runStartSessionCount = this.tokenTracker.getTotalUsage().sessionCount;

    if (!fs.existsSync(path.join(this.harnessDir, 'state.json'))) {
      throw new Error('No .harness/state.json found. Run init first.');
    }

    this._runPreflight();
    this._startAgentTicker();

    try {
      const state = readState(this.harnessDir);
      this.onLog(`Resuming. Global status: ${state.globalStatus}, phase: ${state.projectMeta.currentPhase}`);

      // w4-state-resume-persistence Fix #2: read back the persisted gate
      // dispositions as DEFAULTS. An explicit CLI flag still wins (constructor
      // already set the live flag to true), so only fill the gap when the live
      // flag is still false. state.json is guaranteed present here (the guard
      // above threw otherwise).
      {
        const persisted = readGateFlags(this.harnessDir);
        if (!this._allowIncompleteScope && persisted.allowIncompleteScope) {
          this._allowIncompleteScope = true;
          this.onLog('Resume: honoring persisted --allow-incomplete-scope disposition from the original run.');
        }
        if (!this._skipCoverageGate && persisted.skipCoverageGate) {
          this._skipCoverageGate = true;
          this.onLog('Resume: honoring persisted skip-coverage-gate disposition (small-task run).');
        }
      }

      if (!this._skipCoverageGate) {
        const globalPlan = {
          milestones: Object.values(state.milestones).map((ms) => ({
            ...ms,
            missions: Object.values(ms.missions || {}),
          })),
        };
        // Rehydrate the scope set from persisted state by KEY PRESENCE (not
        // truthiness): attach scopeItems ONLY when the key is present, so an
        // absent key stays undefined → legacy fail-closed; a present `[]` →
        // goal-only skip. scopeMapping defaults to [].
        if (Object.prototype.hasOwnProperty.call(state.projectMeta || {}, 'scopeItems')) {
          globalPlan.scopeItems = state.projectMeta.scopeItems;
        }
        globalPlan.scopeMapping = state.projectMeta?.scopeMapping || [];
        await this._scopeCoverageGate(globalPlan, { prdPath: state.projectMeta?.prdPath });
        this._detectUncheckableSpec({ prdPath: state.projectMeta?.prdPath });
      }

      try {
        for (const msId of Object.keys(state.milestones).sort()) {
          const ms = state.milestones[msId];
          if (ms.status === 'complete' || ms.status === 'invalidated') continue;
          await this._executeMilestone(msId, ms);
        }
      } catch (err) {
        if (err instanceof SpecCriterionError) {
          // The last milestone's spec-criteria drain failed on resume. Unlike
          // batchResume (which reverts and re-queues), a single resume() has
          // nowhere to re-queue to, so the WIP is left in place on disk — NO
          // git revert. Print the failing criteria (same shape as the
          // batchResume criteria-failures.txt lines) with a fix-and-re-run
          // hint, persist a best-effort globalStatus marker so a later
          // `cc-orch resume` recognizes the drain as the pending step, then
          // terminate with a message only (no stack trace).
          // Infra leg: the spec-criteria suite was KILLED BY TIMEOUT, not
          // failed on its merits — taken ONLY when every recorded failure
          // carries timedOut === true (a non-empty, all-timeout failures
          // array). Names no failing criterion (there isn't one — the suite
          // never finished), and points the user at re-running once things
          // are quiet rather than at fixing a criterion. WIP stays in place
          // (no revert, same as the non-timeout landing below).
          const resumeCritFailures = err.failures || [];
          if (resumeCritFailures.length > 0 && resumeCritFailures.every((f) => f.timedOut === true)) {
            console.error('\nSpec acceptance criteria suite TIMED OUT during resume — not a criterion failure.');
            console.error('Re-run `cc-orch resume` when the system is quiet.');

            try {
              const pendingState = readState(this.harnessDir);
              pendingState.globalStatus = 'paused';
              writeJsonAtomic(path.join(this.harnessDir, 'state.json'), pendingState);
            } catch { /* best-effort marker */ }

            process.exit(1);
          }

          console.error('\nSpec acceptance criteria failed during resume:');
          for (const failure of err.failures || []) {
            if (failure.targetFile) {
              console.error(`  - ${failure.name}: ${failure.targetFile}`);
            } else if (failure.command !== undefined) {
              console.error(`  - ${failure.name}: exitCode=${failure.exitCode} command=${failure.command}`);
            } else {
              console.error(`  - ${failure.name}`);
            }
          }
          console.error('\nFix the failing criteria above, then re-run `cc-orch resume`.');

          try {
            const pendingState = readState(this.harnessDir);
            pendingState.globalStatus = 'paused';
            writeJsonAtomic(path.join(this.harnessDir, 'state.json'), pendingState);
          } catch { /* best-effort marker */ }

          // Best-effort brainstorm-candidate ledger emit (fail-soft — mirrors
          // _parkEntry's try/catch-warn-never-throw pattern). Must never alter
          // the exit below. Merit-failure sub-arm ONLY — the all-timedOut
          // infra sub-arm above must not emit.
          try {
            const resumeSlug = readActiveRunPointer(this.projectRoot)?.slug ?? null;
            appendCandidate(this.projectRoot, {
              slug: resumeSlug,
              signature: {
                phase: 'failed-criteria',
                errorClass: 'SpecCriterionError',
                analyzerRecommendation: null,
                taskState: null,
              },
              summary: 'Spec acceptance criteria failed during resume',
              evidence: {
                archiveId: null,
                stashRef: null,
                analyzerSidecar: null,
              },
            }, { onWarn: (msg) => this.onLog(`  ${msg}`) });
          } catch (ledgerErr) {
            this.onLog(`  Failed to append candidate to candidates.jsonl: ${ledgerErr.message}`);
          }

          process.exit(1);
        }
        throw err;
      }

      if (this._cancelController.signal.aborted) {
        this.onLog('Pipeline cancelled — skipping review gate');
        return;
      }

      await this._reviewGate({ autoAccept: this.autoFromHere });

      // Emit the "This Run" cost summary BEFORE archive teardown wipes
      // .harness/logs/token-usage.json. The CLI's post-pipeline printUsage
      // call reads from disk and would otherwise see an empty file (sessions
      // count goes negative because the baseline was captured before archive).
      this._emitRunCostSummary();

      // Capture the resumed run's slug from the on-disk active-run pointer
      // BEFORE archive() runs — archive() clears the pointer as part of its
      // teardown, so this is the last point at which it is readable. A plain
      // single-spec resume() has no pointer slug tied to a queue/<slug>/
      // entry (or the entry no longer exists), in which case the removal +
      // commit-mirror below are both no-ops and this leg stays byte-identical
      // to before.
      const resumedPointer = readActiveRunPointer(this.projectRoot);
      const resumedSlug = resumedPointer?.slug ?? null;

      // Defect #15 fix: call archive() to persist the run to archives/{seq}/.
      // Single-spec resume() previously relied on the user to manually run
      // `cc-orch archive` after the pipeline completed. That's a hidden
      // human-in-the-loop step that contradicts the autonomous-completion
      // design intent. The archive() invocation here matches batchResume's
      // contract — every successful pipeline run produces an archive on disk.
      // Auto-mode (--auto) is implied because resume() is non-interactive
      // post-review-gate; no further prompts should appear.
      const archiveDir = await this._archive(this.projectRoot, null, { auto: true });

      // Batch-originated run: this resumed run has a queue/<slug>/ entry
      // (e.g. left pending by a prior batch interrupt/park-then-requeue
      // flow that landed on a plain `cc-orch resume` instead of
      // `--batch`). Mirror batchResume's post-archive queue-removal + commit
      // step (see batchResume's archive leg above) so the entry is cleaned
      // up and the deliverables land in a spec-boundary commit exactly as
      // they would have under `--batch`. A plain single run has no
      // queue/<slug>/ entry, so this whole block is a no-op for it.
      if (resumedSlug && fs.existsSync(path.join(this.projectRoot, 'queue', resumedSlug))) {
        removeQueueEntry(this.projectRoot, resumedSlug);

        // Stage deliverables and create a spec-boundary commit.
        // queue/ is gitignored, so a plain `git add -A` already excludes it.
        try {
          execSync('git add -A', { cwd: this.projectRoot, stdio: 'pipe' });
          let headline = resumedSlug;
          try {
            const manifestPath = path.join(archiveDir, 'manifest.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            headline = manifest.headline || resumedSlug;
          } catch (_e) {
            // manifest unreadable — fall back to resumedSlug
          }
          const message = headline || resumedSlug;
          execSync('git commit -m ' + JSON.stringify(message), { cwd: this.projectRoot, stdio: 'pipe' });
        } catch (commitErr) {
          // git commit exits non-zero when there is nothing staged (or the
          // project root is not a git repository) — log and continue.
          this.onLog(`  No deliverables to commit for '${resumedSlug}'`);
        }
      }
    } finally {
      // Same rationale as run() — release reusable planner session.
      await this.planner.closeReusableSession();
      if (this._msElapsedInterval !== null) {
        clearInterval(this._msElapsedInterval);
        this._msElapsedInterval = null;
      }
      this._stopAgentTicker();
      // Remove signal handlers to prevent listener leaks.
      process.removeListener('SIGINT', this._signalHandlers.SIGINT);
      process.removeListener('SIGTERM', this._signalHandlers.SIGTERM);
      process.removeListener('exit', this._signalHandlers.exit);
      process.removeListener('uncaughtException', this._signalHandlers.uncaughtException);
      this.statusBar.destroy();
    }
    return { runStartSessionCount: this._runStartSessionCount };
  }

  /**
   * batchResume() — Process all pending queue entries in creation-time order.
   *
   * Precondition (clean working tree):
   *   Requires the git working tree to be clean before processing any entries.
   *   If `git status --porcelain` returns a non-empty string, the batch is
   *   refused and `{ archived: 0, failed: 0 }` is returned immediately.
   *   Note: `ensureGitExcludes` maintains cc-orch's own artifacts (.harness/,
   *   queue/, and root-level spec files) as rooted patterns in
   *   `.git/info/exclude`, so they never appear in the porcelain output —
   *   no additional filtering is required.
   *
   * For each pending entry:
   *   1. Consumes any park resolution left by `cc-orch park resolve`:
   *      waive → skip assumption verification once (consumedAt marks it spent)
   *      and restore postFixAssumptions from the scene's round-1 deferred
   *      entries; requeue → re-extract assumptions from the queue spec.md.
   *   2. Re-verifies assumptions (round 1) via verifyAssumptions.
   *   3. If any fail, attempts autonomous remediation, then re-verifies (round 2).
   *   4. The FINAL verification round decides parking: any uncertain in a
   *      final round 1 (no failures → no round 2), or any failed/uncertain in
   *      round 2 → _parkEntry (park.json scene + status 'parked').
   *      'failed-validation' remains only for genuine validation failures
   *      (e.g. UncheckableSpecError).
   *   5. If passes → bootstrap state, run _executeAllMilestones + _reviewGate,
   *      then removeQueueEntry.
   *
   * Prints summary: 'Batch complete. N archived, M failed.' (', K parked'
   * appended only when K > 0 — the bare form is a stable log contract).
   * Returns { archived, failed, parked }.
   */
  async batchResume(opts = {}) {
    let porcelain = '';
    let isGitRepo = true;
    try {
      ensureGitExcludes(this.projectRoot);
      porcelain = execSync('git status --porcelain', { stdio: ['pipe', 'pipe', 'pipe'], cwd: this.projectRoot, encoding: 'utf8' }).trim();
    } catch (gitErr) {
      // Not a git repository (or git unavailable): skip the clean-tree guard.
      // batchResume is exercised in non-git temp dirs by some existing tests,
      // and a non-repo has no working tree to protect — treat as "no guard".
      this.onLog('Clean-tree guard skipped: project root is not a git repository.');
      porcelain = '';
      isGitRepo = false;
    }
    if (porcelain.length > 0) {
      this.onLog('Batch refused: working tree is not clean. Commit or stash changes before running cc-orch resume --batch. (cc-orch\'s own artifacts — .harness/, queue/, and root-level spec files — are auto-excluded from git; the changes above are outside that set.)');
      return { archived: 0, failed: 0, parked: 0 };
    }

    sweepOrphanRunDirs(this.projectRoot, { log: (m) => this.onLog(m) });

    const entries = listQueue(this.projectRoot);
    // An entry interrupted mid-batch keeps its `pending` status (its WIP was
    // snapshotted to refs/interrupt/<slug> by _snapshotInterruptedEntry, leaving a
    // clean tree that passed the guard above), so it is picked up here and
    // reruns from scratch via bootstrap(force) below. No per-entry cleanup.
    const pending = entries.filter((e) => e.status === 'pending');

    if (pending.length === 0) {
      this.onLog('Queue is empty. Nothing to execute.');
      return { archived: 0, failed: 0, parked: 0 };
    }

    let archiveCount = 0;
    let failCount = 0;
    let parkCount = 0;

    this._startAgentTicker();
    try {
      // w4-state-resume-persistence Fix #2: read back the persisted gate
      // dispositions as DEFAULTS (explicit CLI flags still win — only fill
      // the gap when the live flag is still false). batchResume runs BEFORE
      // the per-entry bootstrap() below in many shapes (no state.json on disk
      // yet), so the state-read MUST be guarded by an existence check and
      // treat absence as {} (empty defaults) — copying the guard verbatim
      // from resume() (the `if (!fs.existsSync(path.join(this.harnessDir,
      // 'state.json')))` block there). An unguarded readGateFlags() throws
      // ENOENT and breaks test-queue-spec-json.js / test-batch-failure-crash-
      // safety.js. "Same pattern" does NOT license dropping the existence
      // check.
      if (fs.existsSync(path.join(this.harnessDir, 'state.json'))) {
        const persisted = readGateFlags(this.harnessDir);
        if (!this._allowIncompleteScope && persisted.allowIncompleteScope) {
          this._allowIncompleteScope = true;
          this.onLog('  Batch: honoring persisted --allow-incomplete-scope disposition.');
        }
        if (!this._skipCoverageGate && persisted.skipCoverageGate) {
          this._skipCoverageGate = true;
          this.onLog('  Batch: honoring persisted skip-coverage-gate disposition.');
        }
      }

      // Invariant: autoFromHere is intentionally NOT reset between queue
      // iterations. Once the user opts in to autonomous execution, that flag
      // persists for all remaining entries in this batch run so that
      // assumption remediation (and any other interactive gates) continue to
      // auto-accept without re-prompting.
      for (const entry of pending) {
        if (this._cancelController.signal.aborted) {
          // An interrupt that landed AFTER the previous entry's post-execution
          // abort check (e.g. during its review gate, archive, or spec-boundary
          // commit) is deliberately absorbed by letting that entry finish —
          // its work was executed and verified, so discarding it would waste a
          // completed delivery. The abort takes effect HERE instead: before
          // this entry spends anything (gates, bootstrap, LLM sessions). The
          // tree is clean (the previous entry committed at its spec boundary),
          // so no snapshot is needed; this entry stays `pending`.
          this.onLog('Pipeline cancelled — batch stopped before next entry');
          break;
        }
        this.onLog(`\nProcessing queue entry: ${entry.slug}`);
        const specPath = path.join(this.projectRoot, 'queue', entry.slug, 'spec.md');

        // Derive this entry's runId up front (before any park-eligible gate
        // runs) so every park leg for this entry — including the
        // assumption-gate park below, which fires before bootstrap/claim —
        // can stamp park.json with a stable runId identifying the run that
        // was parked. Reused verbatim by the claimActiveRun/bootstrap call
        // further down instead of being regenerated.
        const entryRunId = generateRunId(entry.slug);
        this._activeEntryRunId = entryRunId;

        // Per-entry harness-anchoring invariant: each entry anchors its
        // harness to its own per-run dir at loop top, before any per-entry
        // gate or spend runs, so park legs, gate reads, and cost tracking
        // for THIS entry never read/write against the previous entry's
        // per-run harness dir.
        this._repointHarness(runHarnessDir(this.projectRoot, entryRunId));

        const usageBaseline = { totalCost: this.tokenTracker.getTotalUsage().totalCostUsd, totalSessions: this.tokenTracker.getTotalUsage().sessionCount };

        // This run's genuine `uncertain` assumptions for THIS entry (advisory —
        // they no longer park). The ledger append happens at the assumption gate
        // immediately; the state write is deferred to AFTER bootstrap (which
        // wipes state.json), so it survives to archive time.
        let entryUncertains = [];

        // Cache hygiene: the four per-spec getter caches are keyed to a single
        // spec — reset them so entry N's spec.json content never bleeds into
        // entry N+1.
        this._specTargetFilesCache = undefined;
        this._specConstraintsCache = undefined;
        this._specAcceptanceCriteriaCache = undefined;
        this._specGoalCache = undefined;
        this._specPlanStructureCache = undefined;

        // Uncheckable-spec gate: fires BEFORE round-1 assumption verification
        // so no LLM spend occurs on an uncheckable entry. UncheckableSpecError
        // is a VALIDATION failure (failed-validation + continue) — it must NOT
        // route through the failed-execution catch (no forensic archive, no
        // git reset, no commit). Other errors rethrow.
        if (!this._skipCoverageGate) {
          try {
            this._detectUncheckableSpec({ prdPath: specPath });
          } catch (gateErr) {
            if (gateErr instanceof UncheckableSpecError) {
              writeQueueEntry(this.projectRoot, entry.slug, {
                spec: entry.spec,
                plan: entry.plan,
                validatedAt: entry.validatedAt,
                assumptionResults: entry.assumptionResults,
                specJson: entry.specJson,
                status: 'failed-validation',
              });
              this.onLog(`  Entry '${entry.slug}' is uncheckable (no parseable spec.json) — marked failed-validation.`);
              // Best-effort brainstorm-candidate ledger emit (fail-soft — mirrors
              // createParkSnapshot's try/catch-warn-never-throw pattern). Must never
              // alter the failCount/continue flow below.
              try {
                appendCandidate(this.projectRoot, {
                  slug: entry.slug,
                  signature: {
                    phase: 'failed-validation',
                    errorClass: gateErr.constructor.name,
                    analyzerRecommendation: null,
                    taskState: null,
                  },
                  summary: `Entry '${entry.slug}' failed validation (uncheckable spec)`,
                  evidence: {
                    archiveId: null,
                    stashRef: null,
                    analyzerSidecar: null,
                  },
                }, { onWarn: (msg) => this.onLog(`  ${msg}`) });
              } catch (ledgerErr) {
                this.onLog(`  Failed to append candidate to candidates.jsonl for '${entry.slug}': ${ledgerErr.message}`);
              }
              failCount++;
              continue;
            }
            throw gateErr;
          }
        }

        const plan = entry.plan;

        // ── Park-resolution consumption ──────────────────────────────────
        // A previously parked entry that a human resolved back to 'pending'
        // carries instructions in its scene:
        //   waive   (unconsumed) → accept the uncertainty: skip assumption
        //           verification this pass only (consumedAt is the spent
        //           marker) and restore the round-1 deferred post-fix
        //           assumptions from the scene so they are not silently
        //           dropped along with the skipped rounds;
        //   requeue → the human edited the spec: re-extract assumptions from
        //           the queue copy so round 1 verifies fresh content.
        const priorScene = readParkScene(this.projectRoot, entry.slug);
        const priorResolution = priorScene?.resolution ?? null;
        let waived = false;
        if (priorResolution?.action === 'waive' && !priorResolution.consumedAt) {
          waived = true;
          plan.postFixAssumptions = (priorScene.round1 ?? [])
            .filter((a) => a.status === 'deferred')
            .map((d) => d.assumption);
          priorResolution.consumedAt = new Date().toISOString();
          writeParkScene(this.projectRoot, entry.slug, priorScene);
          this.onLog(`  Park resolution 'waive' consumed — skipping assumption verification (${plan.postFixAssumptions.length} deferred post-fix assumption(s) restored from scene).`);
        } else if (priorResolution?.action === 'requeue' && fs.existsSync(specPath)) {
          const reExtracted = await this.planner.reExtractAssumptions(specPath, this.projectRoot);
          plan.assumptions = reExtracted;
          this.onLog(`  Park resolution 'requeue' — re-extracted ${reExtracted.length} assumptions from queue spec.md`);
        }

        if (!waived && plan.assumptions?.length) {
          // ── Round 1: verify assumptions ──────────────────────────────────
          this.onLog(`  Verifying ${plan.assumptions.length} assumptions (round 1)...`);
          this.statusBar.setPhase('verifying assumptions (round 1)');
          const round1 = await this.planner.verifyAssumptions(plan.assumptions, this.projectRoot);
          const failed1 = round1.filter((a) => a.status === 'failed');
          const deferred1 = round1.filter((a) => a.status === 'deferred');
          const uncertain1 = round1.filter((a) => a.status === 'uncertain');

          if (deferred1.length > 0) {
            this.onLog(`  [DEFER] ${deferred1.length} post-fix assumption(s) deferred until after execution`);
          }
          plan.postFixAssumptions = deferred1.map((d) => d.assumption);

          if (failed1.length === 0) {
            // Round 1 is the FINAL round when there are no failures (no
            // remediation, no round 2). An `uncertain` verdict is advisory —
            // it no longer parks the entry. Record each uncertain to the
            // warnings ledger (durable) and stage it for the this-run state
            // write (deferred to after bootstrap), then fall through to
            // execution. No classify, no auto-waive scene, no park, no continue.
            if (uncertain1.length > 0) {
              this.onLog(`  ${uncertain1.length} uncertain assumption(s) — recorded (advisory); continuing.`);
              appendUncertainAssumptions(this.projectRoot, uncertain1);
              entryUncertains = this._normalizeUncertains(uncertain1);
            }
          } else {
            this.onLog(`  ${failed1.length} assumption(s) failed. Attempting autonomous remediation...`);

            // ── Autonomous remediation ──────────────────────────────────────
            // Edits stay auto-accepted; each applied edit is recorded so a
            // round-2 park can show the human what already changed.
            const appliedSpecEdits = [];
            for (const a of failed1) {
              const assumptionText = a.assumption?.text ?? a.assumption;
              const specSection = a.assumption?.specSection ?? null;
              const evidence = a.evidence ?? '';

              if (!specSection) {
                this.onLog(`  [batchResume] No specSection for assumption — skipping: "${assumptionText}"`);
                continue;
              }

              const specExcerpt = this._extractSpecSection(specPath, specSection);
              if (!specExcerpt) {
                this.onLog(`  [batchResume] Section "${specSection}" not found in spec — skipping.`);
                continue;
              }

              let proposedFix;
              try {
                proposedFix = await this.planner.remediateAssumption(assumptionText, evidence, specExcerpt);
              } catch (err) {
                this.onLog(`  [batchResume] remediateAssumption failed: ${err.message} — skipping.`);
                continue;
              }

              const old = proposedFix.specEdit?.old ?? '';
              const nw = proposedFix.specEdit?.new ?? '';

              // Auto-accept all planner-proposed fixes.
              const applied = this._applySpecEdit(specPath, old, nw, {
                subsystem: 'batchResume',
                section: proposedFix.specEdit?.section ?? specSection,
                summary: `assumption: "${assumptionText}"`,
              });
              if (applied) {
                this.onLog(`  [batchResume] [auto] Spec updated for assumption: "${assumptionText}"`);
                appliedSpecEdits.push({
                  assumption: assumptionText,
                  section: proposedFix.specEdit?.section ?? specSection,
                  old,
                  new: nw,
                });
              }

              // Update the assumptions in the cached plan so round 2
              // re-verifies the corrected, phase-tagged versions. Replace
              // the original failed entry with N revised entries (each
              // {text, phase, specSection}) at the original index.
              if (proposedFix.revisedAssumptions?.length) {
                const idx = plan.assumptions.findIndex((pa) =>
                  (pa?.text ?? pa) === assumptionText
                );
                if (idx !== -1) {
                  const original = plan.assumptions[idx];
                  const fallbackSpecSection = (typeof original === 'object' ? original.specSection : null) ?? specSection ?? '';
                  const mapped = proposedFix.revisedAssumptions.map((revised) => ({
                    text: revised.text,
                    phase: revised.phase,
                    specSection: revised.specSection ?? fallbackSpecSection,
                  }));
                  plan.assumptions.splice(idx, 1, ...mapped);
                }
              }
            }

            // ── Round 2: re-verify after remediation ──────────────────────
            // Re-read spec and re-extract assumptions so round-2 verify uses
            // fresh content rather than the stale spliced array.
            if (specPath && fs.existsSync(specPath)) {
              const reExtracted = await this.planner.reExtractAssumptions(specPath, this.projectRoot);
              plan.assumptions = reExtracted;
              this.onLog(`Re-extracted ${reExtracted.length} assumptions from edited spec`);
            }

            this.onLog(`  Re-verifying assumptions (round 2)...`);
            this.statusBar.setPhase('verifying assumptions (round 2)');
            const round2 = await this.planner.verifyAssumptions(plan.assumptions, this.projectRoot);
            const failed2 = round2.filter((a) => a.status === 'failed');
            const uncertain2 = round2.filter((a) => a.status === 'uncertain');

            // Round 2 is the final round. A `failed` verdict after remediation
            // remains a needs-a-human stop and parks exactly as before (failed
            // = confidently-wrong, still blocking). An `uncertain` verdict is
            // advisory — it no longer parks: record it (ledger + this-run
            // state) and fall through to execution.
            if (failed2.length > 0) {
              this.onLog(`  ${failed2.length} failed / ${uncertain2.length} uncertain assumption(s) after remediation — parking for a human.`);
              this._parkEntry(entry, {
                site: 'assumption-gate',
                parkedAt: new Date().toISOString(),
                round1,
                round2,
                appliedSpecEdits,
                questions: [...failed2, ...uncertain2].map((a) => a.assumption?.text ?? a.assumption),
              });
              parkCount++;
              continue;
            } else if (uncertain2.length > 0) {
              this.onLog(`  ${uncertain2.length} uncertain assumption(s) after remediation — recorded (advisory); continuing.`);
              appendUncertainAssumptions(this.projectRoot, uncertain2);
              entryUncertains = this._normalizeUncertains(uncertain2);
            }
          }
        }
        // Waived, no assumptions to verify, or all verified — proceed.

        try {
          if (!this._skipCoverageGate) {
            await this._scopeCoverageGate(plan, { prdPath: specPath });
          }

          // ── Bootstrap and run full pipeline ──────────────────────────────
          // Defect #15 fix: pass specPath so state.projectMeta.prdPath is set;
          // archive() reads from there to find the spec content. Without this,
          // the spec path defaults to empty and the archive flow can't operate.
          //
          // Each queue entry gets its own fresh per-run harness dir (mirrors
          // run()'s runId derivation + active-run-pointer claim below): a
          // fresh runId was generated for this entry at the top of the loop
          // (so any earlier park leg can stamp the same id), the active-run
          // pointer is claimed (kind 'batch') BEFORE bootstrapping so two
          // concurrent batches can't stomp each other's per-run harness
          // state, then bootstrap(force:true) always creates a clean
          // state.json for this run id, and this.harnessDir is repointed to
          // it before writeGlobalPlan so the plan lands in the correct run
          // directory. batchResume processes entries strictly sequentially
          // within a single logical batch — unlike run()'s cross-process
          // contention guard, there is no concurrent second claimant to
          // defend against here, and the pointer left behind by the
          // PREVIOUS entry (which this same loop owns) would otherwise make
          // claimActiveRun() return false for entry N+1, silently leaving
          // the pointer aimed at the stale prior run. Clear it immediately
          // before claiming so every entry's claim succeeds and the pointer
          // always reflects the entry currently executing.
          clearActiveRunPointer(this.projectRoot);
          claimActiveRun(this.projectRoot, { runId: entryRunId, slug: entry.slug, kind: 'batch' });
          bootstrap(this.projectRoot, { runId: entryRunId, force: true, prdPath: specPath });
          this._repointHarness(runHarnessDir(this.projectRoot, entryRunId));
          writeGlobalPlan(this.harnessDir, plan);

          // This-run source of truth: write THIS entry's uncertains into the
          // fresh state bootstrap just created (read-modify-write), so the
          // review gate and the archive can read state.uncertainAssumptions.
          // Deferred to here because bootstrap above wipes/recreates state.json.
          if (entryUncertains.length > 0) {
            this._persistUncertainsToState(entryUncertains);
          }

          if (this._cancelController.signal.aborted) {
            // Pre-execution abort. Normally clean (bootstrap writes only the
            // artifacts auto-excluded via .git/info/exclude by ensureGitExcludes),
            // BUT edge cases in this window can still leave the tree dirty →
            // snapshot (null-guarded no-op when clean) so the next batch's
            // clean-tree guard is not deadlocked.
            this.onLog('Pipeline cancelled — skipping entry');
            this._snapshotInterruptedEntry(entry.slug, isGitRepo);
            break;
          }

          await this._executeAllMilestones(plan);
          if (this._cancelController.signal.aborted) {
            // Post-execution abort — the entry's deliverables are written, so the
            // tree is dirty. Snapshot the WIP into refs/interrupt/<slug> and leave
            // the tree clean; the entry stays `pending` and reruns from scratch next
            // batch. The helper emits its own conditional snapshot log (only when a
            // ref was actually created) — no unconditional announcement here.
            this._snapshotInterruptedEntry(entry.slug, isGitRepo);
            break;
          }
          await this._reviewGate({ autoAccept: true });

          // Note: per-spec "This Run" cost display is intentionally NOT emitted
          // in batch mode — _runStartSessionCount is set once for the whole
          // batch (in resume() before this method, if applicable) and would not
          // produce a meaningful per-spec count here. If per-spec cost display
          // is wanted, capture a per-iteration baseline before _executeAllMilestones
          // and call _emitRunCostSummary() before archive() below. Phase III item.

          // Defect #15 fix: call archive() to actually persist the run as
          // archives/{seq}/ — bumps version, prepends CHANGELOG, copies state +
          // spec into the archive directory, generates report.html (if spec 1's
          // run-report feature has shipped), then cleans .harness/. Without this
          // call, the previous "archived successfully" log message was a lie:
          // the queue entry was removed, the harness wiped on the next iteration,
          // but no archive ever persisted to disk.
          const archiveDir = await this._archive(this.projectRoot, entry.slug, { auto: true, usageBaseline });
          if (!archiveDir) {
            throw new Error(
              `archive() returned undefined for queue entry '${entry.slug}'. ` +
              `Aborting batch — manual cleanup required (state may be inconsistent).`
            );
          }

          removeQueueEntry(this.projectRoot, entry.slug);

          // Stage deliverables and create a spec-boundary commit.
          // queue/ is gitignored, so a plain `git add -A` already excludes it.
          // (An explicit ":(exclude)queue" pathspec fails with exit 1: git
          // refuses an exclude magic that names an already-ignored path.)
          try {
            execSync('git add -A', { cwd: this.projectRoot, stdio: 'pipe' });
            let headline = entry.slug;
            try {
              const manifestPath = path.join(archiveDir, 'manifest.json');
              const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              headline = manifest.headline || entry.slug;
            } catch (_e) {
              // manifest unreadable — fall back to entry.slug
            }
            const message = headline || entry.slug;
            execSync('git commit -m ' + JSON.stringify(message), { cwd: this.projectRoot, stdio: 'pipe' });
          } catch (commitErr) {
            // git commit exits non-zero when there is nothing staged — log and continue.
            this.onLog(`  No deliverables to commit for '${entry.slug}'`);
          }

          this.onLog(`  Entry '${entry.slug}' archived to ${path.relative(this.projectRoot, archiveDir)}.`);
          archiveCount++;
        } catch (err) {
          // Ctrl-C at an interactive prompt is the user asking out of the
          // batch, not an execution failure. Recognized FIRST — before the
          // failed-plan leg, InfrastructureError, TestGateError,
          // SpecCriterionError, the circuit-breaker arm, and the generic
          // failed-execution arm — so it is never recorded as any failure
          // class: no status write, no failCount, no forensic archive, no
          // revert. Rethrow; the outer finally still runs. The second trigger
          // covers a SIGINT that lands while an LLM session is in flight — a
          // planner session during planMission, or a gate verifier/analyzer
          // session: the process-level SIGINT handler calls
          // this._cancelController.abort() (~:250) and kills the child process
          // group, so the session rejects with an AbortError (planMission call
          // sites tag it with err.planPhase) or an arbitrary session error
          // that carries no UserInterruptError type. The aborted signal is the
          // authoritative interrupt marker, so it is checked here alongside the
          // typed interrupt, ahead of every other classification.
          if (err instanceof UserInterruptError || this._cancelController.signal.aborted) {
            // Ctrl-C at an interactive gate prompt (TTY batch). The tree holds the
            // entry's mid-task WIP — snapshot it into refs/interrupt/<slug> and leave
            // the tree clean BEFORE rethrowing, so the next batch's clean-tree
            // guard passes and the still-`pending` entry reruns from scratch.
            this._snapshotInterruptedEntry(entry.slug, isGitRepo);
            this.onLog(`  Batch interrupted by user at entry '${entry.slug}' — aborting; entry status unchanged.`);
            throw err;
          }
          if (err instanceof InfrastructureError) throw err;
          // FAILED-PLAN LEG: a plan-phase error (tagged err.planPhase === true
          // ONLY at its origin — the planMission/plan-validation call sites in
          // _planAndApproveMission, which run BEFORE the scheduler dispatches
          // any task) with a clean working tree means nothing has been
          // written to the tree for this entry yet — there is no execution
          // halt to preserve (no forensic archive), nothing to revert, and no
          // .harness state to tear down. Positioned here, ahead of the
          // forensic-archive/revert code below, so those steps never run on
          // this leg. Fail-safe AND typed: an untagged error, a dirty tree, OR
          // a failing/throwing `git status` all fall through to today's
          // generic failed-execution arm byte-identically (mirrors
          // _assertBatchTreeClean's porcelain probe pattern).
          if (err.planPhase === true) {
            let planTreeClean = false;
            try {
              const planPorcelain = execSync('git status --porcelain', { cwd: this.projectRoot, encoding: 'utf8', stdio: 'pipe' }).trim();
              planTreeClean = planPorcelain.length === 0;
            } catch (probeErr) {
              // A failing/throwing git status is NOT-clean for this leg's
              // purposes — fail-safe fall-through to the generic arm.
              planTreeClean = false;
            }
            if (planTreeClean) {
              try {
                const planFailurePath = path.join(this.projectRoot, 'queue', entry.slug, 'plan-failure.txt');
                fs.writeFileSync(planFailurePath, `${err.message}\n${err.stack || ''}\n`);
              } catch (writeErr) {
                this.onLog(`  Failed to write plan-failure detail for '${entry.slug}': ${writeErr.message}`);
              }
              updateQueueEntryStatus(this.projectRoot, entry.slug, 'failed-plan');
              // Best-effort brainstorm-candidate ledger emit (fail-soft — mirrors
              // createParkSnapshot's try/catch-warn-never-throw pattern). Must never
              // alter the status/continue flow above.
              try {
                appendCandidate(this.projectRoot, {
                  slug: entry.slug,
                  signature: {
                    phase: 'failed-plan',
                    // Granular lint signature: plan-lint:<ruleId> for
                    // ruleId-bearing lint errors, the error's name
                    // otherwise. ONLY this failed-plan emit uses
                    // lintErrorClass; every other emit keeps deriving
                    // errorClass as before.
                    errorClass: lintErrorClass(err),
                    analyzerRecommendation: null,
                    taskState: null,
                  },
                  summary: `Entry '${entry.slug}' failed during planning`,
                  evidence: {
                    archiveId: null,
                    stashRef: null,
                    analyzerSidecar: null,
                  },
                }, { onWarn: (msg) => this.onLog(`  ${msg}`) });
              } catch (ledgerErr) {
                this.onLog(`  Failed to append candidate to candidates.jsonl for '${entry.slug}': ${ledgerErr.message}`);
              }
              this.onLog(`  Entry '${entry.slug}' failed during planning — see queue/${entry.slug}/plan-failure.txt (recovery: fix the spec, then reset the entry to 'pending' to retry, or remove it from the queue).`);
              failCount++;
              if (isGitRepo) this._assertBatchTreeClean(entry.slug);
              continue;
            }
          }
          if (err instanceof TestGateError) {
            // Infra leg: the full test:all suite was KILLED BY TIMEOUT, not
            // failed on its merits (runFinalTestGate sets timedOut === true
            // when runFullTestSuite exits -1). A timeout says nothing about
            // whether the suite would pass or fail — treat it as an
            // infrastructure problem, not a test-gate failure: no snapshot,
            // no revert, no failed-test-gate status. Leave the entry pending
            // and exit via the InfrastructureError path so the run can be
            // retried once the environment recovers.
            if (err.timedOut === true) {
              this.onLog(`  Entry '${entry.slug}': the full test suite (\`${config.execution.testAllCommand}\`) TIMED OUT — not a test failure. Leaving entry pending.`);
              throw new InfrastructureError(
                `Final test gate timed out for '${entry.slug}': ${err.message}`,
                { category: 'timeout', retryable: true, statusCode: undefined, cause: err },
              );
            }
            // The spec's milestones all completed, but the full test:all suite
            // failed at archive time. Revert the (still-uncommitted) changes for
            // batch isolation and re-queue as failed-test-gate — distinct from a
            // mid-run execution failure and truthfully labeled. NO forensic
            // archive: there is no halt to preserve, only a red suite. (Single-
            // run instead leaves the work in place for a human to fix the test
            // and re-archive; batch must keep the tree clean for the next spec.)
            let testGateParkSnapshot = null;
            if (isGitRepo) {
              try {
                testGateParkSnapshot = createParkSnapshot(entry.slug, this.projectRoot, 'refs/test-gate/');
                if (testGateParkSnapshot) {
                  this.onLog(`  Preserved pre-revert work for '${entry.slug}' as ${testGateParkSnapshot.stashRef}`);
                }
              } catch (parkErr) {
                this.onLog(`  ERROR: failed to snapshot work for '${entry.slug}' before test-gate revert: ${parkErr.message}`);
              }
            }
            // Unconditional raw-error capture: unlike the [FAIL]/Total:
            // extraction below (which only writes when it finds marker
            // lines), this always persists the full TestGateError so a
            // failure with zero [FAIL] lines in its tail is still on
            // record. Fail-soft, mirrors the hole-10 error.txt write shape.
            // Runs regardless of isGitRepo so non-git roots still get
            // diagnostics on disk.
            try {
              const errorPath = path.join(this.projectRoot, 'queue', entry.slug, 'test-gate-error.txt');
              fs.writeFileSync(errorPath, `${err.message}\n${err.stack || ''}\n`);
            } catch (writeErr) {
              this.onLog(`  Failed to write test-gate-error.txt for '${entry.slug}': ${writeErr.message}`);
            }
            this.onLog(`  Entry '${entry.slug}' test-gate error: ${err.message.split('\n')[0]}`);
            // Best-effort extraction of the failing-test identity from the
            // TestGateError message tail: every per-test FAIL marker line
            // plus the summary Total line. Persisted to
            // queue/<slug>/test-gate-failures.txt so a human (or a future
            // remediation pass) can see exactly what failed without
            // re-running the suite. Fail-soft: any error here must NOT
            // block the revert / status update / continue flow below.
            try {
              const tailMarker = '--- tail of test output ---\n';
              const tailIdx = err.message.indexOf(tailMarker);
              const tail = tailIdx !== -1 ? err.message.slice(tailIdx + tailMarker.length) : err.message;
              const tailLines = tail.split('\n');
              const failLines = tailLines.filter((line) => /\[FAIL\]/.test(line));
              const totalLines = tailLines.filter((line) => /^\s*Total:/.test(line));
              const extractedLines = [...failLines, ...totalLines];
              if (extractedLines.length > 0) {
                const failuresPath = path.join(this.projectRoot, 'queue', entry.slug, 'test-gate-failures.txt');
                fs.writeFileSync(failuresPath, extractedLines.join('\n') + '\n');
              }
              for (const line of failLines) {
                this.onLog(line);
              }
            } catch (extractErr) {
              this.onLog(`  Failed to extract test-gate failure detail for '${entry.slug}': ${extractErr.message}`);
            }
            if (isGitRepo) {
              try {
                execSync('git reset --hard HEAD', { cwd: this.projectRoot, stdio: 'pipe' });
                execSync('git clean -fd -e queue', { cwd: this.projectRoot, stdio: 'pipe' });
              } catch (revertErr) {
                this.onLog(`  Revert after test-gate failure had trouble: ${revertErr.message}`);
              }
            }
            // Status-only: remediation may have edited the on-disk queue
            // spec.md before execution started — rewriting the entry from
            // the in-memory batch-start copy would clobber it.
            updateQueueEntryStatus(this.projectRoot, entry.slug, 'failed-test-gate');
            // Best-effort brainstorm-candidate ledger emit (fail-soft — mirrors
            // createParkSnapshot's try/catch-warn-never-throw pattern). Must never
            // alter the revert/status/continue flow above.
            try {
              appendCandidate(this.projectRoot, {
                slug: entry.slug,
                signature: {
                  phase: 'failed-test-gate',
                  errorClass: err.constructor.name,
                  analyzerRecommendation: null,
                  taskState: null,
                },
                summary: `Entry '${entry.slug}' failed the final test gate`,
                evidence: {
                  archiveId: null,
                  stashRef: testGateParkSnapshot?.stashRef ?? null,
                  analyzerSidecar: null,
                },
              }, { onWarn: (msg) => this.onLog(`  ${msg}`) });
            } catch (ledgerErr) {
              this.onLog(`  Failed to append candidate to candidates.jsonl for '${entry.slug}': ${ledgerErr.message}`);
            }
            failCount++;
            this.onLog(`  Entry '${entry.slug}' failed the final test gate (\`${config.execution.testAllCommand}\`) — reverted and re-queued as failed-test-gate.`);
            if (isGitRepo) this._assertBatchTreeClean(entry.slug);
            continue;
          }
          if (err instanceof SpecCriterionError) {
            // Infra leg: the spec-criteria suite was KILLED BY TIMEOUT, not
            // failed on its merits — taken ONLY when every recorded failure
            // carries timedOut === true (a non-empty, all-timeout failures
            // array). A timeout says nothing about whether the criteria
            // would pass or fail — treat it as an infrastructure problem,
            // not a criteria failure: no snapshot, no revert, no
            // criteria-failures.txt, no failed-criteria status. Leave the
            // entry pending and exit via the InfrastructureError path so the
            // run can be retried once the environment recovers.
            const critFailures = err.failures || [];
            if (critFailures.length > 0 && critFailures.every((f) => f.timedOut === true)) {
              this.onLog(`  Entry '${entry.slug}': the spec acceptance criteria suite TIMED OUT — not a criterion failure. Leaving entry pending.`);
              throw new InfrastructureError(
                `Spec-criteria drain timed out for '${entry.slug}': ${err.message}`,
                { category: 'timeout', retryable: true, statusCode: undefined, cause: err },
              );
            }
            // A milestone completed execution but failed one or more spec
            // acceptance criteria (file-check or command-check). Revert the
            // (still-uncommitted) changes for batch isolation and re-queue as
            // failed-criteria — distinct from a mid-run execution failure and
            // truthfully labeled. NO forensic archive: there is no halt to
            // preserve, only failed criteria.
            let criteriaParkSnapshot = null;
            if (isGitRepo) {
              try {
                criteriaParkSnapshot = createParkSnapshot(entry.slug, this.projectRoot, 'refs/test-gate/');
                if (criteriaParkSnapshot) {
                  this.onLog(`  Preserved pre-revert work for '${entry.slug}' as ${criteriaParkSnapshot.stashRef}`);
                }
              } catch (parkErr) {
                this.onLog(`  ERROR: failed to snapshot work for '${entry.slug}' before criteria-failure revert: ${parkErr.message}`);
              }
              // Persist the failing criteria to
              // queue/<slug>/criteria-failures.txt so a human (or a future
              // remediation pass) can see exactly what failed without
              // re-running the milestone. Fail-soft: any error here must NOT
              // block the revert / status update / continue flow below.
              try {
                const failureLines = (err.failures || []).map((failure) => {
                  if (failure.targetFile) {
                    return `${failure.name}: ${failure.targetFile}`;
                  }
                  if (failure.command !== undefined) {
                    return `${failure.name}: exitCode=${failure.exitCode} command=${failure.command}`;
                  }
                  return `${failure.name}`;
                });
                const failuresPath = path.join(this.projectRoot, 'queue', entry.slug, 'criteria-failures.txt');
                fs.writeFileSync(failuresPath, failureLines.join('\n') + '\n');
                for (const line of failureLines) {
                  this.onLog(line);
                }
              } catch (extractErr) {
                this.onLog(`  Failed to extract criteria-failure detail for '${entry.slug}': ${extractErr.message}`);
              }
              try {
                execSync('git reset --hard HEAD', { cwd: this.projectRoot, stdio: 'pipe' });
                execSync('git clean -fd -e queue', { cwd: this.projectRoot, stdio: 'pipe' });
              } catch (revertErr) {
                this.onLog(`  Revert after criteria failure had trouble: ${revertErr.message}`);
              }
            }
            // Status-only: remediation may have edited the on-disk queue
            // spec.md before execution started — rewriting the entry from
            // the in-memory batch-start copy would clobber it.
            updateQueueEntryStatus(this.projectRoot, entry.slug, 'failed-criteria');
            // Best-effort brainstorm-candidate ledger emit (fail-soft — mirrors
            // createParkSnapshot's try/catch-warn-never-throw pattern). Must never
            // alter the revert/status/continue flow above.
            try {
              appendCandidate(this.projectRoot, {
                slug: entry.slug,
                signature: {
                  phase: 'failed-criteria',
                  errorClass: 'SpecCriterionError',
                  analyzerRecommendation: null,
                  taskState: null,
                },
                summary: `Entry '${entry.slug}' failed spec acceptance criteria`,
                evidence: {
                  archiveId: null,
                  stashRef: criteriaParkSnapshot?.stashRef ?? null,
                  analyzerSidecar: null,
                },
              }, { onWarn: (msg) => this.onLog(`  ${msg}`) });
            } catch (ledgerErr) {
              this.onLog(`  Failed to append candidate to candidates.jsonl for '${entry.slug}': ${ledgerErr.message}`);
            }
            failCount++;
            this.onLog(`  Entry '${entry.slug}' failed spec acceptance criteria — reverted and re-queued as failed-criteria.`);
            if (isGitRepo) this._assertBatchTreeClean(entry.slug);
            continue;
          }
          const isReviewHalt = err instanceof HaltError && REVIEW_GATE_HALT_SITES.includes(err.site);
          // w4-batch-failure-input-boundary Fix #2: resolve the
          // CircuitBreakerError from `err` directly OR from `err.cause`. In
          // production every task runs under the scheduler; when a breaker fires
          // while any other task is still pending (the common case), the
          // scheduler's stall wrap rethrows with the original CircuitBreakerError
          // attached as `cause` (the throw itself is a plain Error). Resolving
          // from err.cause is what makes the halted-analyzer routing reachable in
          // the realistic multi-task case — not just when the breaker fired on
          // the last remaining task.
          const breakerErr = err instanceof CircuitBreakerError
            ? err
            : (err?.cause instanceof CircuitBreakerError ? err.cause : null);
          // An analyzer circuit-breaker that escalated to a human (explicit
          // 'human' recommendation, or the repeat detector tightening any
          // verdict) is a pending human decision, not an execution failure.
          // Non-human CircuitBreakerErrors keep the failed-execution path. The
          // EXISTING compound condition is applied to the RESOLVED error.
          const isAnalyzerHumanHalt = breakerErr !== null &&
            (breakerErr.recommendation === 'human' || breakerErr.escalatedByRepeat === true);
          // P2 park diff preservation: the resolvable-park legs (halted-review /
          // halted-analyzer — the latter also covers the mission/milestone
          // regression human-halt, which arrives as a 'human' CircuitBreakerError)
          // PRESERVE the verified work-in-progress instead of discarding it with
          // `git reset --hard`. On these legs the destructive revert below is
          // replaced by a gc-safe stash snapshot; true-failure paths
          // (failed-execution / failed-test-gate) keep their revert unchanged.
          const isResolvablePark = isReviewHalt || isAnalyzerHumanHalt;
          // Holds { stashRef, stashSha, baseSha } from a successful snapshot
          // (null when the tree was already clean, or on a non-park leg) to flow
          // into the park scene write below.
          let parkSnapshot = null;
          // Capture the analyzer's per-event sidecar NOW — the forensic
          // archive below resets .harness/, and the park scene needs the
          // rootCause/evidence from it. Fail-soft: an unreadable sidecar
          // degrades the scene to the error message.
          let analyzerSidecar = null;
          if (isAnalyzerHumanHalt && breakerErr.eventId) {
            try {
              analyzerSidecar = JSON.parse(fs.readFileSync(
                path.join(this.harnessDir, 'analysis', `${breakerErr.eventId}.json`), 'utf8'
              ));
            } catch { /* fail-soft */ }
          }
          this.onLog(`  Entry '${entry.slug}' execution failed: ${err.message}`);
          // Best-effort forensic archive of the failed run. preserve is
          // unconditional for batch entries: with preserve=false,
          // copySpecToArchive MOVES queue/<slug>/spec.md and spec.json into
          // the failed archive, gutting the entry — halted-review entries
          // must stay resolvable (park show / resolve --requeue; live
          // defect, archive failed-108), and failed-execution entries must
          // keep `queue list` readable (pre-P1 the failure-path full
          // rewrite incidentally restored the moved files; the status-only
          // write removed that accident). The forensic archive itself still
          // runs: its harness-state reset is load-bearing for the next entry.
          // ERROR.TXT: capture the directory path returned by the forensic
          // archive call and, ONLY on the generic failed-execution arm (not
          // the halted-review / halted-analyzer disposition arms, which stay
          // byte-identical), write err.message + err.stack into it —
          // fail-soft (write failures are logged and swallowed; no
          // archive.js change). Written BEFORE the park-commit/revert logic
          // below so the file is captured by that commit (or excluded from
          // the clean along with the rest of archives/) instead of being
          // left behind as an untracked file.
          let failedArchiveDir = null;
          // Capture the active-run pointer BEFORE the forensic archive: the
          // archive's harness-state reset clears it, but the park / failed-
          // execution dispositions reached from this catch are non-terminal
          // (queue list / park show / status / continue all still need to
          // resolve an active run) — unlike the successful-completion archive
          // path above, which intentionally leaves the pointer cleared.
          const preArchivePointer = readActiveRunPointer(this.projectRoot);
          try {
            failedArchiveDir = await this._archive(this.projectRoot, entry.slug, { 'include-failed': true, preserve: true });
          } catch (archiveErr) {
            this.onLog(`  Failed to archive failed run for '${entry.slug}': ${archiveErr.message}`);
          }
          // Re-claim the active-run pointer so it's non-null after this
          // disposition. Fail-soft: any error here must never block the
          // park/status/continue flow below.
          try {
            const restoreRunId = preArchivePointer?.runId ?? entryRunId;
            const restoreSlug = preArchivePointer?.slug ?? entry.slug;
            const restoreKind = preArchivePointer?.kind ?? 'batch';
            claimActiveRun(this.projectRoot, { runId: restoreRunId, slug: restoreSlug, kind: restoreKind });
          } catch (reclaimErr) {
            this.onLog(`  Failed to restore active-run pointer for '${entry.slug}': ${reclaimErr.message}`);
          }
          if (failedArchiveDir && !isResolvablePark) {
            try {
              fs.writeFileSync(path.join(failedArchiveDir, 'error.txt'), `${err.message}\n${err.stack || ''}\n`);
            } catch (writeErr) {
              this.onLog(`  Failed to write error.txt for '${entry.slug}': ${writeErr.message}`);
            }
          }
          if (isGitRepo) {
            // The park commit is structurally dead when archives/ is
            // gitignored (git add archives/ can never work) — probe with
            // check-ignore and skip add+commit with a log when ignored.
            let archivesIgnored = false;
            try {
              // Trailing slash matters: a directory-only .gitignore pattern
              // ("archives/") does not match the bare name when the directory
              // does not exist yet (e.g. the forensic archive produced
              // nothing in a fresh repo); "archives/" matches either way.
              execSync('git check-ignore -q archives/', { cwd: this.projectRoot, stdio: 'pipe' });
              archivesIgnored = true;
            } catch {
              // Non-zero exit: not ignored (or git oddity) → proceed with
              // the existing park-commit behavior.
            }
            if (archivesIgnored) {
              this.onLog(`  Park commit skipped for '${entry.slug}': archives/ is gitignored in this repository.`);
            } else {
              // w4-batch-failure-input-boundary Fix #1(b): distinguish the
              // BENIGN nothing-to-commit case from a REAL park-commit failure.
              // Benign covers BOTH no-evidence sub-cases (swallow silently, as
              // before):
              //   - `git commit` exits non-zero because nothing is staged
              //     ("nothing to commit") — forensic archive produced files that
              //     somehow staged nothing; and
              //   - `git add archives/` fails with "pathspec 'archives/' did not
              //     match any files" — the forensic archive produced NOTHING, so
              //     archives/ is empty/absent (the common case when the forensic
              //     archive itself threw).
              // A REAL failure (no git identity, failing hook, etc.) is logged
              // LOUDLY with the git error so the human knows the park commit did
              // not land — and the just-created archive is preserved by the
              // `-e archives` clean below. Batch continuation is unchanged either
              // way.
              try {
                execSync('git add archives/', { cwd: this.projectRoot, stdio: 'pipe' });
                execSync('git commit -m ' + JSON.stringify(`Park failed spec ${entry.slug} (execution failure)`), { cwd: this.projectRoot, stdio: 'pipe' });
              } catch (parkErr) {
                const gitOut = `${parkErr.stdout || ''}${parkErr.stderr || ''}${parkErr.message || ''}`;
                const benign =
                  /nothing to commit|nothing added to commit|no changes added to commit/i.test(gitOut) ||
                  /pathspec .*archives.* did not match/i.test(gitOut);
                if (benign) {
                  // No forensic evidence to commit — silent, as before.
                  this.onLog(`  No park-commit changes for '${entry.slug}' — continuing with revert.`);
                } else {
                  // Real commit failure: the just-created forensic archive must
                  // NOT be lost by the revert below — Fix #1(a) excludes it from
                  // the clean. Log loudly with the git error.
                  const gitErrText = (parkErr.stderr || parkErr.stdout || parkErr.message || '').toString().trim();
                  this.onLog(`  Park commit failed for '${entry.slug}': ${gitErrText} — forensic archive preserved (excluded from clean); continuing with revert.`);
                }
              }
            }
            try {
              // w4-batch-failure-input-boundary Fix #1(a): the forensic archive
              // must survive the failure-path revert. Two steps are BOTH needed
              // when the park commit failed for a real reason after `git add
              // archives/` already staged the archive:
              //   1. `git reset --hard HEAD` reverts BOTH index and working tree
              //      to HEAD — it DELETES a staged-but-uncommitted archives/ tree.
              //      Unstage archives/ FIRST (git reset HEAD -- archives/) so the
              //      hard reset no longer sees it as a staged change and leaves
              //      the files on disk as untracked.
              //   2. `git clean` then excludes archives/ (-e archives) so the
              //      now-untracked forensic archive is not deleted either.
              // (When archives/ was never staged — the benign no-evidence case —
              // the unstage is a harmless no-op.)
              try {
                execSync('git reset -q HEAD -- archives/', { cwd: this.projectRoot, stdio: 'pipe' });
              } catch { /* nothing staged under archives/ — harmless */ }
              if (isResolvablePark) {
                // P2: PRESERVE the verified WIP (tracked + untracked) into a
                // gc-safe stash object anchored under refs/park/<slug>, leaving
                // the tree CLEAN for the next entry — the preservation-version
                // of the reset. The forensic archive's archives/ tree was just
                // committed (or skipped/ignored) above, so it is out of the WIP
                // the snapshot captures. A clean tree yields a null snapshot and
                // a scene without snapshot fields.
                parkSnapshot = createParkSnapshot(entry.slug, this.projectRoot);
                if (parkSnapshot) {
                  this.onLog(`  Preserved work-in-progress for '${entry.slug}' as ${parkSnapshot.stashRef} — inspect with: cc-orch park show ${entry.slug}`);
                }
              } else {
                execSync('git reset --hard HEAD', { cwd: this.projectRoot, stdio: 'pipe' });
                execSync('git clean -fd -e queue -e archives', { cwd: this.projectRoot, stdio: 'pipe' });
              }
            } catch (revertErr) {
              this.onLog(`  Revert after execution failure had trouble: ${revertErr.message}`);
            }
          }
          // A HaltError from the review gate is a pending human decision,
          // not an execution failure — record it honestly as 'halted-review'
          // with a minimal scene. P2: the verified WIP was PRESERVED above
          // (parkSnapshot, when the tree was dirty) rather than discarded, so a
          // later `park resolve --requeue` re-attaches it instead of forcing a
          // full re-validation + re-execution. Classification matches ONLY the
          // _reviewGate sites; any other HaltError keeps failed-execution.
          if (isReviewHalt) {
            this._parkEntry(entry, {
              site: 'review-gate',
              parkedAt: new Date().toISOString(),
              // Analyzer disposition telemetry: a review-gate halt is a human
              // decision with no analyzer eventId. recommendation carries the
              // sentinel 'review-human' so a resolve here is mine-able as a
              // distinct (non-analyzer-event) human signal.
              recommendation: 'review-human',
              eventId: null,
              round1: [],
              round2: [],
              appliedSpecEdits: [],
              questions: [err.reason],
              ...(parkSnapshot ?? {}),
            }, { status: 'halted-review' });
          } else if (isAnalyzerHumanHalt) {
            // The analyzer asked for a human — park with a minimal scene
            // (same scene-before-status + read-existing-then-append
            // discipline via _parkEntry). P2: the work was PRESERVED above
            // (parkSnapshot, when the tree was dirty), so a later requeue
            // re-attaches it rather than redoing it from scratch.
            const questions = [];
            if (typeof analyzerSidecar?.rootCause === 'string' && analyzerSidecar.rootCause) {
              questions.push(`Root cause: ${analyzerSidecar.rootCause}`);
            }
            if (typeof analyzerSidecar?.evidence === 'string' && analyzerSidecar.evidence) {
              questions.push(`Evidence: ${analyzerSidecar.evidence}`);
            }
            if (questions.length === 0) questions.push(err.message);
            // w4-batch-failure-input-boundary Fix #2: pull the typed fields from
            // the RESOLVED CircuitBreakerError (breakerErr), which may have
            // arrived via err.cause through the scheduler stall wrap — err itself
            // is then the plain wrapping Error with no eventId/taskId.
            questions.push(
              `Analysis event: ${breakerErr.eventId ?? '(no analysis sidecar)'} ` +
              `(task ${breakerErr.taskId}${breakerErr.escalatedByRepeat ? ', escalated by repeat verdict' : ''})`
            );
            this._parkEntry(entry, {
              site: 'analyzer-human',
              parkedAt: new Date().toISOString(),
              // Analyzer disposition telemetry: carry the analyzer's signal as
              // first-class scene fields so a later `park resolve` can record a
              // mine-able disposition. recommendation is 'escalatedByRepeat'
              // when the repeat detector tightened any verdict into a halt,
              // otherwise the analyzer's own recommendation ('human').
              recommendation: breakerErr.escalatedByRepeat === true
                ? 'escalatedByRepeat'
                : breakerErr.recommendation,
              eventId: breakerErr.eventId ?? null,
              round1: [],
              round2: [],
              appliedSpecEdits: [],
              questions,
              ...(parkSnapshot ?? {}),
            }, { status: 'halted-analyzer' });
          } else {
            // Status-only: same no-stale-clobber discipline as the
            // failed-test-gate path above.
            updateQueueEntryStatus(this.projectRoot, entry.slug, 'failed-execution');
            // Best-effort brainstorm-candidate ledger emit (fail-soft — mirrors
            // createParkSnapshot's try/catch-warn-never-throw pattern). Must never
            // alter the status flow above.
            try {
              appendCandidate(this.projectRoot, {
                slug: entry.slug,
                signature: {
                  phase: 'failed-execution',
                  errorClass: err.constructor.name,
                  analyzerRecommendation: null,
                  taskState: null,
                },
                summary: `Entry '${entry.slug}' marked failed-execution`,
                evidence: {
                  archiveId: failedArchiveDir ?? null,
                  stashRef: parkSnapshot?.stashRef ?? null,
                  analyzerSidecar: null,
                },
              }, { onWarn: (msg) => this.onLog(`  ${msg}`) });
            } catch (ledgerErr) {
              this.onLog(`  Failed to append candidate to candidates.jsonl for '${entry.slug}': ${ledgerErr.message}`);
            }
            this.onLog(`  Entry '${entry.slug}' marked failed-execution.`);
          }
          failCount++;
          if (isGitRepo) this._assertBatchTreeClean(entry.slug);
        }
      }
    } finally {
      // GUARDED CLOSE: a close() failure here must not mask whatever error
      // (if any) is already propagating out of the try above — e.g. a
      // deliberate InfrastructureError rethrow. try/catch only ever catches
      // close()'s OWN throw; it cannot swallow the outer propagating error,
      // since a finally block's own trailing statements never intercept an
      // in-flight throw/return from the try/catch it wraps.
      try {
        await this.planner.closeReusableSession();
      } catch (closeErr) {
        this.onLog(`  Failed to close reusable session: ${closeErr.message}`);
      }
      sweepOrphanRunDirs(this.projectRoot, { log: (m) => this.onLog(m) });
      if (this._msElapsedInterval !== null) {
        clearInterval(this._msElapsedInterval);
        this._msElapsedInterval = null;
      }
      this._stopAgentTicker();
      // Remove signal handlers to prevent listener leaks.
      process.removeListener('SIGINT', this._signalHandlers.SIGINT);
      process.removeListener('SIGTERM', this._signalHandlers.SIGTERM);
      process.removeListener('exit', this._signalHandlers.exit);
      process.removeListener('uncaughtException', this._signalHandlers.uncaughtException);
      this.statusBar.destroy();
    }

    // The bare 'N archived, M failed.' form is a stable log contract —
    // parked entries are appended only when present.
    const parkedSuffix = parkCount > 0 ? `, ${parkCount} parked` : '';
    this.onLog(`Batch complete. ${archiveCount} archived, ${failCount} failed${parkedSuffix}.`);
    return { archived: archiveCount, failed: failCount, parked: parkCount };
  }

  /**
   * _parkEntry(entry, scene, opts?) — Park a queue entry for a human.
   *
   * Writes queue/<slug>/park.json FIRST, then flips the status file — the
   * status is the commit point. A crash between the two writes leaves a
   * 'pending' entry with an unconsumed scene, which the next batch pass
   * harmlessly re-validates and re-parks.
   *
   * Re-park history: an existing scene's resolution is appended to the new
   * scene's previousResolutions (a null resolution — e.g. a crash-window
   * re-park — is skipped, not appended). The pipeline owns
   * previousResolutions; the CLI owns resolution — the two never write the
   * same field.
   *
   * No-stale-clobber: the status flip is status-only (updateQueueEntryStatus)
   * so a spec remediated earlier in this pass survives parking untouched —
   * the in-memory entry.spec captured at batch start is never persisted, and
   * the spec.md/spec.json mtimes stay meaningful for the park CLI's
   * divergence warning (which compares them against parkedAt).
   *
   * @param {object} entry - queue entry (only .slug is used; files stay on disk)
   * @param {object} scene - scene WITHOUT previousResolutions/resolution
   * @param {{ status?: string, runId?: string }} [opts] - status: 'parked'
   *   (default), 'halted-review', or 'halted-analyzer'. runId: the runId of
   *   the run being parked; defaults to this._activeEntryRunId (set by
   *   batchResume at the top of each per-entry iteration).
   */
  _parkEntry(entry, scene, { status = 'parked', runId = this._activeEntryRunId } = {}) {
    const existing = readParkScene(this.projectRoot, entry.slug);
    const previousResolutions = [...(existing?.previousResolutions ?? [])];
    if (existing?.resolution != null) previousResolutions.push(existing.resolution);
    writeParkScene(this.projectRoot, entry.slug, { ...scene, runId, previousResolutions, resolution: null });

    updateQueueEntryStatus(this.projectRoot, entry.slug, status);
    this.onLog(`  Entry '${entry.slug}' marked ${status} (site: ${scene.site}) — inspect with: cc-orch park show ${entry.slug}`);

    // Best-effort brainstorm-candidate ledger emit (fail-soft — mirrors
    // createParkSnapshot's try/catch-warn-never-throw pattern). Must never
    // alter park/halt routing above.
    try {
      appendCandidate(this.projectRoot, {
        slug: entry.slug,
        signature: {
          phase: status,
          errorClass: null,
          analyzerRecommendation: scene.recommendation ?? null,
          taskState: null,
        },
        summary: `Entry '${entry.slug}' marked ${status} (site: ${scene.site})`,
        evidence: {
          archiveId: null,
          stashRef: scene.stashRef ?? null,
          analyzerSidecar: scene.eventId ?? null,
        },
      }, { onWarn: (msg) => this.onLog(`  ${msg}`) });
    } catch (ledgerErr) {
      this.onLog(`  Failed to append candidate to candidates.jsonl for '${entry.slug}': ${ledgerErr.message}`);
    }
  }

  /**
   * _persistHaltAftermath(evidence) — Single-run halt-aftermath persistence.
   *
   * Invoked immediately BEFORE every human-recommendation / repeat-escalation
   * CircuitBreakerError throw. Marks the run 'paused' (the only legal status
   * for this) and records additive halt evidence at
   * state.projectMeta.haltRecord so a human — or a later resume — can see
   * WHY and WHERE the run stopped. The original CircuitBreakerError still
   * rethrows byte-identical from the call site; this helper never masks it.
   *
   * Single-run ONLY: batchResume sets this._activeEntryRunId for the
   * duration of each per-entry iteration, and the pre-existing batch
   * aftermath (per-entry _parkEntry / previousResolutions accumulation) is a
   * separate mechanism that must stay byte-untouched. The no-op guard below
   * is deliberately the first line.
   *
   * Queue-linked leg: only fires when state.projectMeta.prdPath resolves to
   * exactly <projectRoot>/queue/<slug>/spec.md AND that queue entry still
   * exists on disk — writeParkScene() mkdir's its entry dir, so existence is
   * checked FIRST here to guarantee a zombie entry is never created. When it
   * fires, the scene mirrors _parkEntry's shape (site, previousResolutions,
   * resolution: null) plus singlePath: true and stashRef: null, and the
   * entry's status flips to 'halted-analyzer'.
   *
   * Fail-soft: any failure while gathering/writing evidence is swallowed and
   * logged (single onLog line) — it must never mask the caller's throw.
   *
   * @param {{ kind: string, site: string, eventId?: string|null }} evidence
   */
  _persistHaltAftermath(evidence) {
    if (this._activeEntryRunId !== null) return;
    try {
      const state = readState(this.harnessDir);
      state.globalStatus = 'paused';
      const runId = readActiveRunPointer(this.projectRoot)?.runId ?? null;
      const at = new Date().toISOString();
      if (!state.projectMeta) state.projectMeta = {};
      state.projectMeta.haltRecord = {
        kind: evidence.kind,
        site: evidence.site,
        eventId: evidence.eventId ?? null,
        runId,
        at,
      };
      writeJsonAtomic(path.join(this.harnessDir, 'state.json'), state);

      const prdPath = state.projectMeta.prdPath;
      if (prdPath) {
        const queueDir = path.join(this.projectRoot, 'queue');
        const rel = path.relative(queueDir, path.resolve(prdPath));
        const relParts = rel.split(path.sep);
        const isQueueSpec = !rel.startsWith('..') && !path.isAbsolute(rel)
          && relParts.length === 2 && relParts[1] === 'spec.md';
        if (isQueueSpec) {
          const slug = relParts[0];
          const entryDir = path.join(queueDir, slug);
          if (fs.existsSync(entryDir)) {
            const existing = readParkScene(this.projectRoot, slug);
            const previousResolutions = [...(existing?.previousResolutions ?? [])];
            if (existing?.resolution != null) previousResolutions.push(existing.resolution);
            writeParkScene(this.projectRoot, slug, {
              site: evidence.site,
              parkedAt: at,
              kind: evidence.kind,
              eventId: evidence.eventId ?? null,
              runId,
              singlePath: true,
              stashRef: null,
              previousResolutions,
              resolution: null,
            });
            updateQueueEntryStatus(this.projectRoot, slug, 'halted-analyzer');

            // Best-effort brainstorm-candidate ledger emit (fail-soft — mirrors
            // _parkEntry's try/catch-warn-never-throw pattern). Must never alter
            // the halt persistence above.
            try {
              appendCandidate(this.projectRoot, {
                slug,
                signature: {
                  phase: 'halted-analyzer',
                  errorClass: 'CircuitBreakerError',
                  analyzerRecommendation: evidence.kind ?? null,
                  taskState: null,
                },
                summary: `Entry '${slug}' marked halted-analyzer (site: ${evidence.site})`,
                evidence: {
                  archiveId: null,
                  stashRef: null,
                  analyzerSidecar: evidence.eventId ?? null,
                },
              }, { onWarn: (msg) => this.onLog(`  ${msg}`) });
            } catch (ledgerErr) {
              this.onLog(`  Failed to append candidate to candidates.jsonl for '${slug}': ${ledgerErr.message}`);
            }
          }
        }
      }
    } catch (err) {
      this.onLog(`  [halt-aftermath] failed to persist halt evidence (site: ${evidence?.site}): ${err.message}`);
    }
  }

  /**
   * _snapshotInterruptedEntry(slug) — At a batch interrupt (Ctrl-C mid-entry),
   * capture the interrupted entry's whole-tree WIP into a gc-safe stash ref
   * (refs/interrupt/<slug>) and leave the working tree CLEAN, WITHOUT reattaching.
   *
   * This ref is BEST-EFFORT insurance, NOT a guaranteed-recoverable park: the
   * update-ref has no old-value guard, so a same-slug re-interrupt overwrites it;
   * and the entry reruns from scratch on the next batch anyway (regenerating the
   * WIP), so the ref exists mainly to unblock the clean-tree guard and to let a
   * human peek at what was in flight — it is not a park.json-backed scene the
   * resolve flow reattaches.
   *
   * Why this exists: the clean-tree guard runs only ONCE at batch start. An
   * interrupt is the ONLY park trigger that fires mid-task, so it leaves the
   * tree dirty with the entry's half-written deliverables. If we left it dirty,
   * the next `cc-orch resume --batch` would be refused by that guard — a
   * deadlock. Snapshotting clears the tree non-destructively (everything is
   * preserved in the ref, nothing classified, no "whose dirt" decision) so the
   * guard passes; the entry stays `pending` and reruns from scratch next batch.
   *
   * createParkSnapshot (not `git reset --hard`): reset would destroy any user
   * hand-edits in the tree. The whole-tree stash preserves them in the ref.
   *
   * null-guard: createParkSnapshot returns null on an already-clean tree (the
   * 1254 first-bootstrap window is usually clean) → no-op; the entry still
   * reruns from scratch.
   *
   * try/catch: a rare git error (e.g. unmerged paths / merge-in-progress) can
   * make the snapshot throw. We re-probe the ACTUAL tree state and branch the
   * message honestly rather than overselling a graceful recovery:
   *   - still dirty (threw at `git stash push -u` itself) → the one residual
   *     case that needs a manual `git stash`/commit before the next batch.
   *   - clean (threw after the stash push already reset the tree) → the WIP is
   *     safe in stash@{0}; benign, just logged.
   * NO bare-stash fallback (a bare retry of the same failing op fails
   * identically). NO reattach.
   *
   * @param {string} slug - Queue entry slug (names the ref + the messages).
   * @param {boolean} isGitRepo - Whether the project root is a git repo (batch
   *   already probed this at start). A non-git batch skips the clean-tree guard,
   *   so there is no ref to pin and no dirty tree to clear — spawning git here
   *   would only throw and mislead with a bogus "STILL DIRTY" warning.
   */
  _snapshotInterruptedEntry(slug, isGitRepo) {
    if (!isGitRepo) {
      // Non-git project: no snapshot ref, no clean-tree guard. Still tell the
      // user the entry survived the interrupt and how to continue.
      this.onLog(
        `  Entry '${slug}' interrupted — it stays pending and reruns on the next ` +
        '`cc-orch resume --batch`.'
      );
      return;
    }
    try {
      const snap = createParkSnapshot(slug, this.projectRoot, 'refs/interrupt/');
      if (snap === null) {
        // Tree already clean — nothing to preserve. Say so (no ref was created,
        // so we must NOT name one) and point at the resume path; otherwise a
        // clean-tree post-exec interrupt would break the loop with zero output.
        this.onLog(
          `  Entry '${slug}' interrupted on a clean tree — it stays pending and ` +
          'reruns on the next `cc-orch resume --batch`.'
        );
        return;
      }
      this.onLog(
        `  Work for entry '${slug}' snapshotted (best-effort) to ${snap.stashRef}; ` +
        "the entry will re-run from scratch on the next `cc-orch resume --batch`."
      );
    } catch (snapErr) {
      let porcelain;
      try {
        porcelain = execSync('git status --porcelain', { cwd: this.projectRoot, encoding: 'utf8', stdio: 'pipe' }).trim();
      } catch {
        // Even the re-probe failed — assume the worst (still dirty) and be honest.
        porcelain = 'unknown';
      }
      if (porcelain.length === 0) {
        // The stash push already reset the tree before the failure → WIP is in
        // stash@{0}, recoverable; the tree is clean so the next batch is not blocked.
        this.onLog(
          `  Snapshot of entry '${slug}' hit a git error (${snapErr.message}) but the tree is now CLEAN — ` +
          'the work-in-progress is recoverable from stash@{0}.'
        );
      } else {
        // The stash push itself failed → the tree is STILL dirty. Honest residual:
        // the next batch's clean-tree guard will refuse until this is cleared by hand.
        this.onLog(
          `  Snapshot of entry '${slug}' failed (${snapErr.message}) and the working tree is STILL DIRTY. ` +
          'The work-in-progress is intact but needs a manual `git stash` or commit before the next ' +
          '`cc-orch resume --batch` (the clean-tree guard will otherwise refuse it).'
        );
      }
    }
  }

  /**
   * _assertBatchTreeClean(slug) — Verify the working tree is clean after a
   * batch failure-path revert.
   *
   * Why this exists: the clean-tree guard runs only ONCE at batch start. The
   * failure-path reverts (git reset --hard + git clean) are best-effort and
   * can themselves fail; if the loop then continues on a dirty tree, every
   * subsequent queue entry executes on top of the previous entry's leftover
   * changes — silently contaminating the rest of the batch. This check makes
   * that condition abort loudly instead.
   *
   * Runs `git status --porcelain` in this.projectRoot. Non-empty output →
   * throws a plain Error (propagates out of batchResume; the aborting entry
   * has already been marked failed on disk by the caller).
   *
   * w4-batch-failure-input-boundary Fix #1 rider: this method is only ever
   * reached when the repo was confirmed git at batch start (every call site
   * gates on `isGitRepo === true`). A git probe that throws HERE therefore is
   * not "no git repo" — it is git breaking mid-batch in a repo we already know
   * to be git. Self-disabling the guard in that state silently re-enables the
   * very contamination this guard exists to catch. Fail closed: a probe failure
   * aborts the batch loudly rather than skipping verification.
   *
   * Instance method (not inline execSync) so tests can stub it to drive the
   * abort flow and unit-test it directly.
   *
   * @param {string} slug - Queue entry slug, named in the abort message.
   */
  _assertBatchTreeClean(slug) {
    let porcelain;
    try {
      porcelain = execSync('git status --porcelain', { cwd: this.projectRoot, encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch (probeErr) {
      // Confirmed-git-at-batch-start (caller gates on isGitRepo) → fail closed.
      throw new Error(
        `Tree-cleanliness probe failed for entry '${slug}' (already marked failed) in a repository ` +
        `confirmed git at batch start: ${probeErr.message}. ` +
        'Aborting the batch — cannot verify the working tree is clean for the remaining entries.'
      );
    }
    // w4-batch-failure-input-boundary Fix #1(a): in a tracked-archives project a
    // forensic archive that survived a REAL park-commit failure stays on disk as
    // untracked content under archives/ (the failure-path revert deliberately
    // preserves it — `git clean -e archives`). That is INTENDED evidence, not
    // contamination from the failed entry's work, so it must not trip this guard.
    // Exclude archives/ paths from the contamination check while still aborting
    // on any OTHER leftover (modified source, etc.). Porcelain lines are
    // "XY <path>" (untracked dirs collapse to "?? archives/").
    const dirtyLines = porcelain
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .filter((line) => {
        // Porcelain v1: 2 status chars + a space + the path (the leading space
        // of e.g. " M file" is significant, so slice from index 3, not trim).
        // For renames ("R  old -> new") the survivor is the destination.
        let pathPart = line.slice(3).replace(/^"|"$/g, '');
        const arrowIdx = pathPart.indexOf(' -> ');
        if (arrowIdx !== -1) pathPart = pathPart.slice(arrowIdx + 4).replace(/^"|"$/g, '');
        return !(pathPart === 'archives/' || pathPart === 'archives' || pathPart.startsWith('archives/'));
      });
    if (dirtyLines.length > 0) {
      throw new Error(
        `Working tree is still dirty after the failure-path revert for entry '${slug}' (already marked failed). ` +
        'Aborting the batch to protect remaining entries from a contaminated working tree.'
      );
    }
  }

  // ── Review gate ──

  /**
   * _reviewGate() — Present a diff-review menu after all milestones complete.
   *
   * Skipped when opts.noReview, opts.skipReview, this.noReview, or
   * this.skipReview are set.  Also skipped when no onMenu callback is
   * registered (logs a warning and returns normally so callers without an
   * interactive terminal are unaffected).
   *
   * Menu options:
   *   a — accept: return normally (archive proceeds)
   *   d — show full `git diff HEAD`, re-prompt
   *   f — prompt for filename, show `git diff HEAD -- <file>`, re-prompt
   *   r — reject: throw so no archive is written
   */
  async _reviewGate(opts = {}) {
    // Honor all skip flags.
    if (opts.noReview || opts.skipReview || this.noReview || this.skipReview) {
      this.onLog('[review-gate] Skipping review gate (noReview/skipReview is set).');
      return;
    }

    if (!this.onMenu) {
      this.onLog('[review-gate] No onMenu callback registered — skipping review gate.');
      return;
    }

    // Auto-accept branch (W5). Fires under --auto (opts.autoAccept).
    // Evaluated AFTER the skip-flag and onMenu checks and BEFORE the menu loop.
    //
    // Fail-closed: auto-accept fires only when EVERY milestone of the run has a
    // sidecar that exists, parses, and satisfies the single-sourced clean-pass
    // predicate (PASSED, zero critical findings). Any failing condition for ANY
    // milestone logs WHY and falls through to the existing menu flow below.
    if (opts.autoAccept) {
      const state = readState(this.harnessDir);
      const msIds = Object.keys(state.milestones || {}).sort();

      let allClean = true;
      const declineReasons = [];
      // Per-milestone non-critical (warning/info) finding counts, for the loud
      // accept line. Only populated on the all-clean path.
      const nonCriticalCounts = [];

      if (msIds.length === 0) {
        allClean = false;
        declineReasons.push('no milestones found in state');
      }

      for (const msId of msIds) {
        const sidecarPath = path.join(
          this.harnessDir,
          'verification',
          `review-milestone-${msId}.json`
        );

        if (!fs.existsSync(sidecarPath)) {
          allClean = false;
          declineReasons.push(`milestone ${msId}: sidecar missing (${sidecarPath})`);
          continue;
        }

        let structured;
        try {
          structured = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
        } catch (e) {
          allClean = false;
          declineReasons.push(`milestone ${msId}: sidecar unreadable/unparseable (${e.message})`);
          continue;
        }

        if (!isCleanPass(structured)) {
          allClean = false;
          const result = structured && structured.result;
          const findings = Array.isArray(structured?.findings) ? structured.findings : [];
          const criticalCount = findings.filter(f => f.severity === 'critical').length;
          if (result !== 'PASSED') {
            declineReasons.push(`milestone ${msId}: result is ${JSON.stringify(result)} (not PASSED)`);
          } else {
            declineReasons.push(`milestone ${msId}: ${criticalCount} critical finding(s) despite PASSED`);
          }
          continue;
        }

        // Clean: count non-critical findings for the accept-line summary.
        const findings = Array.isArray(structured.findings) ? structured.findings : [];
        nonCriticalCounts.push(findings.filter(f => f.severity !== 'critical').length);
      }

      if (allClean) {
        const total = msIds.length;
        const warningsTotal = nonCriticalCounts.reduce((a, b) => a + b, 0);
        this.onLog(
          `[review-gate] auto-accept: ${total}/${total} milestone review(s) PASSED, ` +
          `0 critical (${warningsTotal} warnings → ledger)`
        );
        return;
      }

      // Fail-closed: fall through to the existing menu flow below.
      this.onLog(
        `[review-gate] auto-accept declined (fail-closed) — ${declineReasons.join('; ')}. ` +
        `Falling through to review menu.`
      );
    }

    // Step 1: run git diff --stat HEAD for a summary.
    let diffStat = '';
    try {
      diffStat = execSync('git diff --stat HEAD', { stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.projectRoot,
        encoding: 'utf8',
      }).trim();
    } catch {
      diffStat = '(git diff --stat failed — not a git repo or no commits)';
    }

    // Also list untracked (new, not-yet-added) files — pure display, no git state changes.
    let untracked = [];
    try {
      untracked = execSync('git ls-files --others --exclude-standard', { stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.projectRoot,
        encoding: 'utf8',
      }).trim().split('\n').filter(Boolean);
    } catch {
      untracked = [];
    }

    // Step 2: log the summary.
    this.onLog('\n=== Review Gate: Diff Summary ===');
    this.onLog(diffStat || '(no tracked changes)');   // MUST stay at headerIdx+1
    if (untracked.length) {
      this.onLog(`\nNew untracked files (${untracked.length}):`);
      for (const f of untracked) this.onLog(`  + ${f}`);
    }
    this.onLog('');

    // Surface THIS run's uncertain assumptions (advisory; recorded, never
    // parked) in the accept/reject context. Human-present path only — every
    // skip / auto-accept / no-onMenu branch returned above, so reaching here
    // means a human is at the menu. Pure display, no blocking step. Read from
    // the Change-5 source of truth (state.uncertainAssumptions).
    try {
      const reviewState = readState(this.harnessDir);
      const uncertains = reviewState?.uncertainAssumptions ?? [];
      if (uncertains.length > 0) {
        this.onLog(`Uncertain assumptions this run (${uncertains.length}) — advisory, recorded to the warnings ledger:`);
        for (const u of uncertains) {
          const section = u.specSection ? ` [${u.specSection}]` : '';
          this.onLog(`  ? ${u.text}${section}`);
        }
        this.onLog('');
      }
    } catch { /* best-effort surfacing — state unreadable is non-fatal */ }

    // Step 3+4: present menu and handle choices in a loop.
    while (true) {
      const choice = await this._gateMenu(
        'review-gate',
        'Review changes: [a]ccept  [d]iff  [f]ile diff  [r]eject',
        [
          { key: 'a', label: 'accept' },
          { key: 'd', label: 'show full diff' },
          { key: 'f', label: 'file diff' },
          { key: 'r', label: 'reject' },
        ],
        { reason: 'Review-gate accept/reject decision must be made by a human under auto mode.' }
      );

      if (choice === 'a') {
        // Accept — return normally; archive proceeds.
        this.onLog('[review-gate] Changes accepted.');
        return;

      } else if (choice === 'd') {
        // Show full diff, then re-prompt.
        let fullDiff = '';
        try {
          fullDiff = execSync('git diff HEAD', { stdio: ['pipe', 'pipe', 'pipe'],
            cwd: this.projectRoot,
            encoding: 'utf8',
          }).trim();
        } catch {
          fullDiff = '(git diff HEAD failed)';
        }
        // Append untracked files' content via `git diff --no-index` (display only).
        let untrackedDiff = '';
        for (const f of untracked) {
          let out = '';
          try {
            out = execFileSync('git', ['diff', '--no-index', '--', '/dev/null', f], {
              cwd: this.projectRoot,
              encoding: 'utf8',
            });
          } catch (e) {
            // `git diff --no-index` exits 1 when there IS a diff; text is on stdout.
            out = e.stdout || '';
          }
          if (out) untrackedDiff += (untrackedDiff ? '\n' : '') + out.trim();
        }
        const combinedDiff = [fullDiff, untrackedDiff].filter(Boolean).join('\n');
        this.onLog('\n=== Full Diff ===');
        this.onLog(combinedDiff || '(no changes)');
        this.onLog('');

      } else if (choice === 'f') {
        // Prompt for a filename, show file diff, re-prompt.
        const filename = await this._gateMenu(
          'review-gate-file-diff',
          'Enter filename for diff (relative to repo root): ',
          null,
          { reason: 'Free-text filename input cannot be safely auto-defaulted.' }
        );
        let fileDiff = '';
        try {
          fileDiff = execSync(`git diff HEAD -- ${filename}`, { stdio: ['pipe', 'pipe', 'pipe'],
            cwd: this.projectRoot,
            encoding: 'utf8',
          }).trim();
        } catch {
          fileDiff = `(git diff HEAD -- ${filename} failed)`;
        }
        // If tracked diff is empty, the file may be untracked — show its content.
        if (!fileDiff) {
          try {
            fileDiff = execFileSync('git', ['diff', '--no-index', '--', '/dev/null', filename], {
              cwd: this.projectRoot,
              encoding: 'utf8',
            }).trim();
          } catch (e) {
            // exit 1 when there IS a diff; text is on stdout.
            fileDiff = (e.stdout || '').trim();
          }
        }
        this.onLog(`\n=== Diff: ${filename} ===`);
        this.onLog(fileDiff || '(no changes)');
        this.onLog('');

      } else if (choice === 'r') {
        // Reject — throw so no archive is written.
        this.onLog('[review-gate] Changes rejected.');
        // Fix 2: persist a rejected marker so a later `cc-orch archive` treats this run as a
        // non-clean delivery (skips bump / CHANGELOG / RUNS), even though every milestone is
        // `complete` on disk.
        try {
          const rejectedState = readState(this.harnessDir);
          rejectedState.globalStatus = 'rejected';
          writeJsonAtomic(path.join(this.harnessDir, 'state.json'), rejectedState);
        } catch { /* best-effort marker — archive still gates on terminality */ }
        const err = new Error('Pipeline run rejected at review gate.');
        err.status = 'rejected';
        throw err;

      } else {
        // Unknown option — re-prompt.
        this.onLog(`[review-gate] Unknown option "${choice}". Choose a, d, f, or r.`);
      }
    }
  }

  // ── Overwrite protection ──

  /**
   * Guard against accidentally overwriting a finished harness run.
   *
   * Rules:
   *  1. No state.json → fresh run, proceed.
   *  2. globalStatus === 'complete' → throw (project fully done).
   *  3. All milestones are 'complete' or 'invalidated' → throw (nothing left to resume).
   *  4. Otherwise → at least one milestone is pending/in_progress, proceed (resume).
   */
  _checkOverwriteProtection(harnessDir) {
    const stateFile = path.join(harnessDir, 'state.json');
    if (!fs.existsSync(stateFile)) return; // fresh run — proceed

    const state = readState(harnessDir);

    // Fully-complete project
    if (state.globalStatus === 'complete') {
      throw new Error(
        `The harness at ${harnessDir} has already completed (globalStatus=complete).\n` +
        `To start fresh, archive the existing run with \`cc-orch archive\` or use a new project directory.`
      );
    }

    // All milestones finished — nothing left to resume
    const milestones = Object.values(state.milestones || {});
    if (milestones.length > 0) {
      const allDone = milestones.every(
        (ms) => ms.status === 'complete' || ms.status === 'invalidated'
      );
      if (allDone) {
        throw new Error(
          `All milestones in ${harnessDir} are already complete or invalidated.\n` +
          `To start fresh, archive the existing run with \`cc-orch archive\` or use a new project directory.`
        );
      }
    }

    // At least one milestone is pending or in_progress → resume case, proceed
  }

  // ── Preflight helper ──

  _runPreflight() {
    const result = runPreflight(this.harnessDir, { projectRoot: this.projectRoot });
    for (const w of result.warnings) this.onLog(`  [WARN] ${w}`);
    if (!result.ok) {
      throw new Error(`Preflight failed:\n  ${result.errors.join('\n  ')}`);
    }
  }

  // ── Dry-run helpers ──

  // ── Milestone / Mission / Sub-mission execution ──

  /**
   * Collect context for a milestone: modifiedFiles (deduplicated), taskDescriptions, importGraph.
   * Reads progress JSON sidecars for each task to gather affectedFiles.
   */
  _normalizePath(f) {
    return path.normalize(f).replace(/^\.[/\\]/, '');
  }

  _collectMilestoneContext(msId) {
    const state = readState(this.harnessDir);
    const msState = state.milestones[msId];

    const modifiedFilesSet = new Set();
    const specScopeFilesSet = new Set();
    const taskDescriptions = [];

    if (msState) {
      for (const [miId, mission] of Object.entries(msState.missions || {})) {
        // Tasks live in per-mission state files, not inlined in state.json.
        const missionStatePath = mission.stateFile
          ? resolveHarnessFileRef(this.harnessDir, mission.stateFile)
          : path.join(this.harnessDir, 'state', `mission-${miId}.json`);
        if (fs.existsSync(missionStatePath)) {
          try {
            const missionState = JSON.parse(fs.readFileSync(missionStatePath, 'utf8'));
            for (const [, sm] of Object.entries(missionState.subMissions || {})) {
              for (const [, task] of Object.entries(sm.tasks || {})) {
                taskDescriptions.push(`Task ${task.id}: ${task.description}`);
                for (const f of (task.targetFiles ?? [])) {
                  specScopeFilesSet.add(this._normalizePath(f));
                }
                const affected = readAffectedFiles(this.harnessDir, task.id);
                for (const f of affected) {
                  modifiedFilesSet.add(this._normalizePath(f));
                }
              }
            }
          } catch {
            // Corrupt mission state — skip
          }
        }
      }
    }

    const modifiedFiles = Array.from(modifiedFilesSet);
    const specScopeFiles = Array.from(specScopeFilesSet);
    const exceededFiles = modifiedFiles.filter(f => !specScopeFilesSet.has(this._normalizePath(f)));

    // Cache import graph on the instance — buildImportGraph scans the
    // whole src/ tree, no need to rebuild per milestone.
    if (!this._cachedImportGraph) {
      this._cachedImportGraph = formatGraphForPrompt(buildImportGraph(this.projectRoot));
    }

    return { modifiedFiles, taskDescriptions, importGraph: this._cachedImportGraph, specScopeFiles, exceededFiles };
  }

  /**
   * Recursively lists all files under `dir` as paths relative to `dir`
   * (posix-joined via path.join, mirroring the walkDir helper in
   * snapshots.js — kept private here since that one isn't exported).
   *
   * @param {string} dir
   * @param {string} [prefix]
   * @returns {string[]}
   */
  _walkSnapshotDir(dir, prefix = '') {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        results.push(...this._walkSnapshotDir(path.join(dir, entry.name), rel));
      } else {
        results.push(rel);
      }
    }
    return results;
  }

  /**
   * Computes per-file restoreSnapshot overrides for `task`/`phase`: for each
   * file captured under this task's own .harness/snapshots/<task.id>/<phase>/
   * dir, finds the sibling task — within the current run's mission-state
   * tree, walked exactly like _collectMilestoneContext (readState →
   * milestones → missions → mission-<id>.json → subMissions → tasks) — with
   * the LATEST completedAt whose OWN after/ snapshot has a copy of that file,
   * and points the restore at that copy instead of the (possibly stale) copy
   * captured under task.id/phase.
   *
   * Only tasks with status === 'complete' compete; an 'invalidated' task
   * NEVER wins, regardless of completedAt. A candidate missing completedAt,
   * or missing the after/<file> copy on disk, contributes no override for
   * that file. Ties on completedAt resolve deterministically by task-id
   * ordering (lexicographically greater id wins).
   *
   * For an 'after'-phase restore, the requesting task itself is included as
   * a competitor using its own completedAt from mission state — and it
   * competes even when its transient status is 'needs_revalidation' (as it
   * always is at the sole production 'after'-phase call site), since its
   * completedAt from the original completion is preserved by
   * transitionTask and reflects its latest completed attestation. Only the
   * requesting task is exempted from the 'status !== complete' disqualifier;
   * sibling candidates still NEVER win unless their own status is
   * 'complete'. If the requesting task is itself the latest (by completedAt,
   * tie-broken by task id), no override is emitted for that file — the
   * restoreSnapshot default (the requesting task's own after/ copy) already
   * wins. For a 'before'-phase restore the requesting task never competes
   * against itself.
   *
   * Fails soft to {} on ANY error (corrupt/unreadable state, malformed
   * mission state, etc.) — this helper NEVER throws.
   *
   * @param {{id: string}} task
   * @param {'before'|'after'} phase
   * @returns {Object<string,string>} snapshot-relative path → absolute path of the winning sibling's after-snapshot copy
   */
  _computeRestoreOverrides(task, phase) {
    const overrides = {};
    try {
      const requestingSnapshotDir = path.join(this.harnessDir, 'snapshots', task.id, phase);
      if (!fs.existsSync(requestingSnapshotDir)) return overrides;
      const files = this._walkSnapshotDir(requestingSnapshotDir);
      if (files.length === 0) return overrides;

      const candidates = [];
      const state = readState(this.harnessDir);
      for (const msState of Object.values(state?.milestones || {})) {
        for (const [miId, mission] of Object.entries(msState.missions || {})) {
          const missionStatePath = mission.stateFile
            ? resolveHarnessFileRef(this.harnessDir, mission.stateFile)
            : path.join(this.harnessDir, 'state', `mission-${miId}.json`);
          if (!fs.existsSync(missionStatePath)) continue;
          try {
            const missionState = JSON.parse(fs.readFileSync(missionStatePath, 'utf8'));
            for (const [, sm] of Object.entries(missionState.subMissions || {})) {
              for (const [, t] of Object.entries(sm.tasks || {})) {
                // The requesting task only competes for an 'after'-phase
                // restore (revalidation); otherwise it's excluded so a
                // 'before'-phase restore can never "override" from itself.
                if (t.id === task.id && phase !== 'after') continue;
                candidates.push({ id: t.id, status: t.status, completedAt: t.completedAt });
              }
            }
          } catch {
            // Corrupt mission state — skip this mission's candidates.
          }
        }
      }

      for (const relPath of files) {
        let winner = null;
        for (const c of candidates) {
          // The requesting task itself (only for an 'after'-phase restore)
          // is exempt from the 'complete' status requirement: its
          // completedAt from the original completion is preserved even
          // while its transient status is 'needs_revalidation', and it
          // must be able to act as the comparison floor. Sibling
          // candidates ('invalidated', 'pending', 'needs_revalidation',
          // etc.) still NEVER win.
          const isSelfAfter = phase === 'after' && c.id === task.id;
          if (!isSelfAfter && c.status !== 'complete') continue; // 'invalidated' NEVER wins
          if (!c.completedAt) continue;
          const afterFile = path.join(this.harnessDir, 'snapshots', c.id, 'after', relPath);
          if (!fs.existsSync(afterFile)) continue;
          if (
            !winner ||
            c.completedAt > winner.completedAt ||
            (c.completedAt === winner.completedAt && c.id > winner.id)
          ) {
            winner = c;
          }
        }
        if (winner && winner.id !== task.id) {
          overrides[relPath] = path.join(this.harnessDir, 'snapshots', winner.id, 'after', relPath);
        }
      }
    } catch {
      return {};
    }
    return overrides;
  }

  /**
   * Fail-closed scope collector for shouldDowngradeRegressionFail (see
   * regression-verdict-filter.js). Given a list of mission ids, walks each
   * mission's state file (`harnessDir/state/mission-<id>.json`) and returns:
   *   - pendingTargetFiles: targetFiles declared by tasks with status
   *     'pending'
   *   - completedAffectedFiles: affectedFiles reported in the progress
   *     sidecar (readAffectedFiles) of tasks with status 'complete'
   *
   * On ANY read/parse failure (missing/corrupt mission state file, etc.)
   * this returns empty arrays for BOTH sets — fail-closed, per the calling
   * gate's absolute-fail-closed requirement.
   *
   * @param {string[]} missionIds
   * @returns {{ pendingTargetFiles: string[], completedAffectedFiles: string[] }}
   */
  _collectRegressionFilterScope(missionIds) {
    const pendingTargetFiles = new Set();
    const completedAffectedFiles = new Set();
    try {
      for (const miId of (missionIds || [])) {
        const missionStatePath = path.join(this.harnessDir, 'state', `mission-${miId}.json`);
        if (!fs.existsSync(missionStatePath)) continue;
        const missionState = JSON.parse(fs.readFileSync(missionStatePath, 'utf8'));
        for (const [, sm] of Object.entries(missionState.subMissions || {})) {
          for (const [, task] of Object.entries(sm.tasks || {})) {
            if (task.status === 'pending') {
              for (const f of (task.targetFiles ?? [])) pendingTargetFiles.add(f);
            } else if (task.status === 'complete') {
              for (const f of readAffectedFiles(this.harnessDir, task.id)) completedAffectedFiles.add(f);
            }
          }
        }
      }
    } catch {
      // Fail-closed: any read/parse failure anywhere in the walk yields
      // empty sets for both, never a partial result.
      return { pendingTargetFiles: [], completedAffectedFiles: [] };
    }
    return {
      pendingTargetFiles: Array.from(pendingTargetFiles),
      completedAffectedFiles: Array.from(completedAffectedFiles),
    };
  }

  async _executeAllMilestones(globalPlan) {
    for (const ms of globalPlan.milestones) {
      const state = readState(this.harnessDir);
      const msState = state.milestones[ms.id];
      if (!msState || msState.status === 'complete') continue;
      await this._executeMilestone(ms.id, msState);
    }
  }

  async _executeMilestone(msId, msState) {
    const _msBannerLines = this._formatBanner('Milestone', msId, msState.description, { suffix: ' ===' });
    _msBannerLines[0] = '=== ' + _msBannerLines[0];
    this.onLog('\n' + _msBannerLines.join('\n'));
    if (msState.status === 'pending') {
      await transitionMilestone(this.harnessDir, msId, 'in_progress');
    }

    // Notify StatusBar of milestone start with approximate task total.
    // Invalidate any stale cache from a previous milestone run.
    this.progress.resetForMilestone(msId, msState);

    // Clear any previous milestone elapsed timer before starting a new one.
    if (this._msElapsedInterval !== null) {
      clearInterval(this._msElapsedInterval);
      this._msElapsedInterval = null;
    }
    this._msStartTime = Date.now();
    this._currentMsId = msId;
    this._currentMsState = msState;
    this.statusBar.updateMilestone(msId, this.progress.total, 0);
    this.statusBar.setPhase(null);
    /**
     * 1 Hz elapsed ticker — contract:
     *   elapsed = floor((Date.now() - startedAt) / 1000), emitted at ≥1 Hz,
     *   debounced inside StatusBar via _scheduleRender(); pauses while
     *   statusBar._promptActive (prompt-pause buffering from mission 001-001 is
     *   honored automatically because both updateMilestone and updateAgent only
     *   call _scheduleRender(), never _render() directly).
     *
     * Every call site that sets status:'active' MUST pass startedAt so the
     * per-agent branch below can derive agentElapsed without skipping the agent.
     * Known call sites: lines ~190, ~893, ~1830, ~1871, ~1947, ~2056, ~2097,
     * ~2167 — all confirmed to include startedAt.
     */
    this._msElapsedInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this._msStartTime) / 1000);
      this.statusBar.updateMilestone(msId, this.progress.total, elapsed);
      // Tick elapsed for each active agent that has a startedAt epoch.
      for (const [name, state] of this.statusBar.agents) {
        if (!state || state.startedAt == null) continue;
        const agentElapsed = Math.floor((Date.now() - state.startedAt) / 1000);
        this.statusBar.updateAgent(name, { ...state, elapsed: agentElapsed });
      }
    }, 1000);

    try {
    await this._executeMilestoneParallel(msId, msState);

    if (this._cancelController?.signal?.aborted) return;

    assertNoNonTerminalTasks(this.harnessDir, msId, msState, this.onLog);

    // ── Reviewer gate ────────────────────────────────────────────────
    if (!this.noReview && !this.skipReview) {
      const { modifiedFiles, taskDescriptions, importGraph, specScopeFiles, exceededFiles } = this._collectMilestoneContext(msId);
      const specGoal = this._getSpecGoal();
      const scopeContext = { specGoal, specScopeFiles, exceededFiles, acceptanceCriteria: this._getSpecAcceptanceCriteria(), uncoveredConsumers: this._uncoveredConsumers || [] };
      const _reviewStart = Date.now();
      this.statusBar.updateAgent('reviewer', { role: 'reviewer', msId, status: 'active', startedAt: _reviewStart, cost: this.tokenTracker.getUsageByType('reviewer').totalCostUsd });
      let reviewResult;
      try {
        reviewResult = await this.reviewer.reviewMilestone(
          msId, modifiedFiles, taskDescriptions, importGraph,
          this.projectRoot, this.harnessDir, scopeContext
        );
      } finally {
        this.statusBar.updateAgent('reviewer', null);
      }

      if (!reviewResult.passed) {
        const criticalFindings = (reviewResult.findings || []).filter(f => f.severity === 'critical');
        const warningFindings = (reviewResult.findings || []).filter(f => f.severity === 'warning');

        this._renderReviewerDigest(msId, reviewResult);

        /**
         * Reviewer-gate retry contract:
         *   - reviewRetryCount persists across retries via .harness/analysis/review-retry-<msId>.json.
         *   - Silent exit is impossible: every code path either succeeds, throws, or escalates.
         *   - Only recommendation === 'retry' enters the remediation path; all other values throw explicitly.
         *   - On cap exhaustion an explicit escalation error is thrown (non-zero exit guidance).
         *   - Empty newTasks increments the counter before throwing so it counts as a failed attempt.
         */

        // Load persisted retry counter for this milestone's reviewer gate.
        const reviewRetryFile = path.join(this.harnessDir, 'analysis', `review-retry-${msId}.json`);
        let reviewRetryCount = 0;
        try {
          if (fs.existsSync(reviewRetryFile)) {
            reviewRetryCount = JSON.parse(fs.readFileSync(reviewRetryFile, 'utf8')).count ?? 0;
          }
        } catch { /* ignore — treat as first attempt */ }

        const persistReviewRetryCount = (n) => {
          fs.mkdirSync(path.dirname(reviewRetryFile), { recursive: true });
          fs.writeFileSync(reviewRetryFile, JSON.stringify({ count: n }));
        };

        const reviewSidecar = path.join(this.harnessDir, 'verification', `review-milestone-${msId}.json`);
        const reviewAnalysis = await this.analyzer.analyzeFailure({
          taskId: `reviewer-${msId}`,
          taskDescription: `Milestone ${msId} reviewer gate failure`,
          failureType: 'review',
          retryCount: reviewRetryCount,
          sidecarPath: reviewSidecar,
        }, this.projectRoot);

        this.onLog(`  Analyzer recommendation: ${reviewAnalysis.recommendation}`);

        if (reviewAnalysis.recommendation === 'human') {
          this._persistHaltAftermath({ kind: 'reviewer-gate', site: 'reviewer-gate-human', eventId: reviewAnalysis.eventId });
          throw new CircuitBreakerError(
            `Circuit breaker: Milestone ${msId} reviewer gate failed. ` +
            `Analyzer recommends human intervention. ` +
            `See .harness/analysis/${reviewAnalysis.eventId}.json`,
            { taskId: `reviewer-ms-${msId}`, recommendation: 'human', eventId: reviewAnalysis.eventId }
          );
        }

        // Guard: 'retry' and 're_plan' both enter the per-mission remediation path.
        // At reviewer-gate scope the synthetic taskId is `reviewer-${msId}` — there is
        // no real task to re-decompose, so re_plan and retry both reduce to "generate
        // fix tasks from criticalFindings + re-run reviewer." Bounded by reviewMaxRetries.
        if (reviewAnalysis.recommendation !== 'retry' && reviewAnalysis.recommendation !== 're_plan') {
          this._persistHaltAftermath({ kind: 'reviewer-gate', site: 'reviewer-gate-unexpected-recommendation', eventId: reviewAnalysis.eventId });
          throw new CircuitBreakerError(
            `Circuit breaker: Milestone ${msId} reviewer gate failed. ` +
            `Unexpected analyzer recommendation '${reviewAnalysis.recommendation}' — escalating. ` +
            `See .harness/analysis/${reviewAnalysis.eventId}.json`,
            { taskId: `reviewer-ms-${msId}`, recommendation: 'human', eventId: reviewAnalysis.eventId }
          );
        }
        if (reviewAnalysis.recommendation === 're_plan') {
          this.onLog(`  Treating reviewer-gate 're_plan' as remediation retry (per-mission fix tasks)`);
        }

        // Cap check: refuse remediation if retries are exhausted.
        const reviewMaxRetries = config.maxRetries ?? 2;
        if (reviewRetryCount >= reviewMaxRetries) {
          this._persistHaltAftermath({ kind: 'reviewer-gate', site: 'reviewer-gate-retry-cap-exhausted', eventId: reviewAnalysis.eventId });
          throw new CircuitBreakerError(
            `Circuit breaker: Milestone ${msId} reviewer gate failed and retry cap (${reviewMaxRetries}) is exhausted. ` +
            `Human intervention required. ` +
            `See .harness/analysis/${reviewAnalysis.eventId}.json`,
            { taskId: `reviewer-ms-${msId}`, recommendation: 'human', eventId: reviewAnalysis.eventId }
          );
        }

        // Retry loop: remediate review findings per-mission using file→mission reverse map
        const fileToMissionMap = buildFileToMissionMap(this.harnessDir);

        // Group criticalFindings by the missionId responsible for each file.
        const allMissionIds = Object.keys(msState.missions).sort();
        const fallbackMissionId = allMissionIds[0];
        const findingsByMission = new Map();
        for (const finding of criticalFindings) {
          const missionId = fileToMissionMap.get(finding.file) ?? fallbackMissionId;
          if (!findingsByMission.has(missionId)) {
            findingsByMission.set(missionId, []);
          }
          findingsByMission.get(missionId).push(finding);
        }

        // If no findings could be mapped, fall back to all findings under the first mission.
        if (findingsByMission.size === 0 && criticalFindings.length > 0) {
          findingsByMission.set(fallbackMissionId, criticalFindings);
        }

        // Guard: no critical findings — reviewer returned !passed with zero actionable issues.
        // This indicates either a stub response (SDK/network/credits problem) or a warnings-only
        // result that should not enter the remediation retry loop.
        if (criticalFindings.length === 0) {
          // A stub verdict here gets the same treatment as the post-remediation
          // re-review arm below (see the reReviewResult.structured?.isStub check):
          // regardless of which reviewer invocation (first-attempt or re-review)
          // produced it, a stub response is an SDK/transport failure, not a merit
          // failure, so both arms classify it as InfrastructureError (retryable)
          // rather than a CircuitBreakerError hard stop.
          if (reviewResult.structured?.isStub === true) {
            throw new InfrastructureError(
              `Milestone ${msId} reviewer gate: reviewer returned a stub response (no findings). ` +
              `This typically indicates a Claude SDK error, network failure, or exhausted credits. ` +
              `Resolve the underlying Claude SDK / network / credits issue and re-run.`,
              { category: 'unknown', retryable: true }
            );
          } else {
            this._persistHaltAftermath({ kind: 'reviewer-gate', site: 'reviewer-gate-no-critical-findings', eventId: reviewAnalysis.eventId });
            throw new CircuitBreakerError(
              `Circuit breaker: Milestone ${msId} reviewer gate failed with warnings only — no actionable (critical) findings. ` +
              `${warningFindings.length} warning(s) present. ` +
              `Remediation requires at least one critical finding; human review recommended.`,
              { taskId: `reviewer-ms-${msId}`, recommendation: 'human' }
            );
          }
        }

        // Persist-first remediation: plan every group, then persist all merges AND the
        // advanced retry counter BEFORE spawning any executor. A process death between
        // planning and merging must not lose the plan — resume re-enters _executeMilestone,
        // whose completed-mission DAG channel executes the persisted pending tasks and drives
        // the flow back to the reviewer gate, with the counter already advanced (bounding the
        // loop exactly as if the process had lived).

        // Phase 1 — generate all plans (no merges yet).
        let totalRemTasks = 0;
        const remediationGroups = [];
        for (const [targetMissionId, missionFindings] of findingsByMission) {
          const remPlan = await this.planner.remediateReviewFindings(msId, missionFindings, this.projectRoot, { specTargetFiles: this._getSpecTargetFiles(), specAcceptanceCriteria: this._getSpecAcceptanceCriteria() });
          this._recordScopeMappingWarnings(msId, remPlan.scopeWarnings);

          if (!remPlan.newTasks?.length) {
            // All-or-nothing: any group with no fix tasks aborts the whole attempt without
            // merging any group. Count as a failed retry attempt before throwing.
            persistReviewRetryCount(reviewRetryCount + 1);
            this._persistHaltAftermath({ kind: 'reviewer-gate', site: 'reviewer-gate-no-fix-tasks', eventId: reviewAnalysis.eventId });
            throw new CircuitBreakerError(
              `Circuit breaker: Milestone ${msId} reviewer gate failed and remediation produced no fix tasks. ` +
              `Analyzer recommendation: ${reviewAnalysis.recommendation}. ` +
              `See .harness/analysis/${reviewAnalysis.eventId}.json`,
              { taskId: `reviewer-ms-${msId}`, recommendation: 'human', eventId: reviewAnalysis.eventId }
            );
          }

          totalRemTasks += remPlan.newTasks.length;
          remediationGroups.push({ targetMissionId, newTasks: remPlan.newTasks });
        }

        // Phase 2 — merge all groups, then advance the counter, before any execution.
        for (const { targetMissionId, newTasks } of remediationGroups) {
          this.onLog(`  Adding ${newTasks.length} remediation task(s) for mission ${targetMissionId} (milestone ${msId})...`);

          const missionStateFile = path.join(this.harnessDir, 'state', `mission-${targetMissionId}.json`);
          const existing = JSON.parse(fs.readFileSync(missionStateFile, 'utf8'));
          const decomp = stateToDecomp(existing);

          await mergeRemediationTasks({
            harnessDir: this.harnessDir,
            missionId: targetMissionId,
            newTasks,
            missionDecomp: decomp,
          });
        }

        // Advance and persist the retry counter now — after all merges land, before execution.
        persistReviewRetryCount(reviewRetryCount + 1);

        // Phase 3 — execute pending fix tasks for each group.
        for (const { targetMissionId } of remediationGroups) {
          const missionStateFile = path.join(this.harnessDir, 'state', `mission-${targetMissionId}.json`);
          // Re-read state after merge so pending tasks are visible.
          const freshState = JSON.parse(fs.readFileSync(missionStateFile, 'utf8'));
          const freshDecomp = stateToDecomp(freshState);

          for (const sm of freshDecomp.subMissions) {
            for (const task of sm.tasks) {
              const status = readTaskStatus(this.harnessDir, task.id);
              if (status === 'pending') {
                await this._executeAndVerifyTask(targetMissionId, sm.id, task);
              }
            }
          }
        }

        // Re-run reviewer with fresh context
        const { modifiedFiles: remModFiles, taskDescriptions: remTaskDesc, importGraph: remImportGraph, specScopeFiles: remScopeFiles, exceededFiles: remExceededFiles } = this._collectMilestoneContext(msId);
        const remSpecGoal = this._getSpecGoal();
        const remScopeContext = { specGoal: remSpecGoal, specScopeFiles: remScopeFiles, exceededFiles: remExceededFiles, acceptanceCriteria: this._getSpecAcceptanceCriteria(), uncoveredConsumers: this._uncoveredConsumers || [] };
        const _reReviewStart = Date.now();
        this.statusBar.updateAgent('reviewer', { role: 'reviewer', msId, status: 'active', startedAt: _reReviewStart, cost: this.tokenTracker.getUsageByType('reviewer').totalCostUsd });
        let reReviewResult;
        try {
          reReviewResult = await this.reviewer.reviewMilestone(
            msId, remModFiles, remTaskDesc, remImportGraph,
            this.projectRoot, this.harnessDir, remScopeContext
          );
        } finally {
          this.statusBar.updateAgent('reviewer', null);
        }

        if (!reReviewResult.passed) {
          // A stub re-review verdict is the same SDK/transport failure shape
          // as the first-attempt arm above (see the reviewResult.structured?.isStub
          // check near the top of the reviewer gate) — both reviewer invocations
          // receive identical stub treatment: a stub verdict is an SDK/transport
          // failure regardless of which reviewer call produced it, so this arm
          // stays InfrastructureError (retryable) and must NOT be reverted to
          // CircuitBreakerError. It already survived the reviewer-layer one-shot
          // retry inside reviewMilestone, so classify it infra here so the entry
          // stays pending, instead of a merit-failure hard stop on a milestone
          // whose remediation may well have landed.
          if (reReviewResult.structured?.isStub === true) {
            throw new InfrastructureError(
              `Milestone ${msId} reviewer gate: post-remediation re-review returned a stub response (no findings). ` +
              `This typically indicates a Claude SDK error, network failure, or exhausted credits. ` +
              `Resolve the underlying Claude SDK / network / credits issue and re-run.`,
              { category: 'unknown', retryable: true }
            );
          }
          this._persistHaltAftermath({ kind: 'reviewer-gate', site: 'reviewer-gate-post-remediation-failed', eventId: reviewAnalysis.eventId });
          throw new CircuitBreakerError(
            `Circuit breaker: Milestone ${msId} reviewer gate failed after remediation. Hard stop — human intervention required. ` +
            `See .harness/verification/review-milestone-${msId}.json`,
            { taskId: `reviewer-ms-${msId}`, recommendation: 'human' }
          );
        }

        this._renderReviewerDigest(msId, reReviewResult);
      }

      this._renderReviewerDigest(msId, reviewResult);
    }

    assertNoNonTerminalTasks(this.harnessDir, msId, msState, this.onLog);

    // Spec-criteria drain — LAST milestone only: deterministically execute
    // milestone-only command criteria and verify file-check criteria before
    // the LLM milestone regression gate (deterministic gates precede LLM
    // judgment). Throws SpecCriterionError on any failure.
    if (this._isLastMilestone(msId)) {
      this._runSpecCriteriaDrain();
    }

    // Milestone regression (user gate)
    const state = readState(this.harnessDir);
    const specPath = state.projectMeta.prdPath;

    let regression = await verifyMilestone({
      milestoneId: msId,
      milestoneDesc: msState.description,
      specPath,
      verifier: this.verifier,
      projectRoot: this.projectRoot,
      harnessDir: this.harnessDir,
      onLog: this.onLog,
    });

    if (!regression.passed) {
      // regression-sequencing-override: same fail-closed filter as the
      // mission site. assertNoNonTerminalTasks (just above) guarantees
      // every task belonging to THIS milestone's own missions is already
      // terminal by the time we reach this gate, so a still-FAIL verdict
      // attributable to pending scope can only be explained by tasks
      // belonging to OTHER (not-yet-reached) milestones — hence the scope
      // is collected across ALL missions in the global state, same as the
      // mission site. Runs ONLY on a still-FAIL result, before the
      // remediation loop below. On a qualifying downgrade the ENTIRE
      // remediation loop (including the allMissionIds[0] fallback that can
      // inject stomping fix tasks into an arbitrary mission) is skipped and
      // the gate is treated as PASSED.
      let msAllMissionIds = [];
      try {
        const globalStateForScope = readState(this.harnessDir);
        for (const ms of Object.values(globalStateForScope.milestones || {})) {
          for (const miId of Object.keys(ms.missions || {})) msAllMissionIds.push(miId);
        }
      } catch {
        msAllMissionIds = [];
      }
      const msFilterScope = this._collectRegressionFilterScope(msAllMissionIds);
      const msDowngrade = shouldDowngradeRegressionFail({
        structured: regression.structured,
        pendingTargetFiles: msFilterScope.pendingTargetFiles,
        projectRoot: this.projectRoot,
        completedAffectedFiles: msFilterScope.completedAffectedFiles,
      });

      if (msDowngrade.downgrade) {
        this.onLog(`  [regression-sequencing-override] Milestone ${msId} regression FAIL downgraded: ${msDowngrade.reason}`);
        appendWarnings(this.projectRoot, [{
          milestone: msId,
          severity: 'warning',
          category: 'regression-sequencing-override',
          description: `Milestone ${msId} regression FAIL downgraded (regression-sequencing-override): ${msDowngrade.reason}`,
        }]);
        recordGateOverride(this.harnessDir, `regression-ms-${msId}`, 'regression-sequencing-override', msDowngrade.reason);
      } else {
      this.onLog(`\n  Milestone ${msId} did not pass regression.`);
      this.onLog(`  Report: ${regression.reportPath}`);

      const MS_REGRESSION_MAX_ITERS = 3;
      let regressionPassed = false;
      let prevRegressionAnalysis = null;

      for (let iterIndex = 0; iterIndex < MS_REGRESSION_MAX_ITERS; iterIndex++) {
        // (1) Log iteration marker
        this.onLog(`[milestone-regression-remediation iter ${iterIndex + 1}/${MS_REGRESSION_MAX_ITERS}]`);

        // (2) Invoke analyzer
        const regressionAnalysis = await this.analyzer.analyzeFailure({
          taskId: `regression-ms-${msId}`,
          taskDescription: `Milestone ${msId} regression failure`,
          failureType: 'regression',
          retryCount: iterIndex,
          sidecarPath: regression.reportPath,
        }, this.projectRoot);

        // (3) On recommendation==='human' throw immediately
        if (regressionAnalysis.recommendation === 'human') {
          // w4-batch-failure-input-boundary Fix #2 rider: back-fill the outcome
          // on the regression pseudo-task (regression-ms-<id>) history entry at
          // the same site task entries get theirs — the analyzeFailure call above
          // wrote the entry but never recorded its terminal outcome.
          recordHistoryOutcome(
            this.harnessDir, `regression-ms-${msId}`, regressionAnalysis.eventId,
            'escalated: human intervention recommended',
            (msg) => this.onLog(`    ${msg}`)
          );
          this._persistHaltAftermath({ kind: 'milestone-regression', site: 'milestone-regression-human', eventId: regressionAnalysis.eventId });
          throw new CircuitBreakerError(
            `Circuit breaker: Milestone ${msId} regression failed. Analyzer recommends human intervention. ` +
            `See .harness/analysis/${regressionAnalysis.eventId}.json`,
            { taskId: `regression-ms-${msId}`, recommendation: 'human', eventId: regressionAnalysis.eventId }
          );
        }

        // Repeat detector: consecutive iterations producing the same verdict
        // (recommendation + affectedTasks id set) mean another remediation
        // round would burn budget on the same answer — break immediately to
        // the existing regression-failed gate below (MS_REGRESSION_MAX_ITERS
        // stays as the floor for distinct verdicts).
        if (prevRegressionAnalysis && isRepeatVerdict(prevRegressionAnalysis, regressionAnalysis)) {
          this.onLog(`  Analyzer REPEATED its previous verdict (rec=${regressionAnalysis.recommendation}, same affected-task set) — breaking to the regression-failed gate early.`);
          // w4-batch-failure-input-boundary Fix #2 rider: back-fill the outcome
          // on the regression pseudo-task history entry at this terminal break,
          // same as task entries get theirs at their terminal sites.
          recordHistoryOutcome(
            this.harnessDir, `regression-ms-${msId}`, regressionAnalysis.eventId,
            `repeat verdict — broke to regression-failed gate (rec=${regressionAnalysis.recommendation})`,
            (msg) => this.onLog(`    ${msg}`)
          );
          break;
        }
        prevRegressionAnalysis = regressionAnalysis;

        // (4) Extract findings [{file, description}]: prefer the structured
        // JSON companion verifyMilestone now emits; fall back to parsing the
        // report, then to the synthetic 'unknown' finding (the degradation
        // path when the verifier attributed nothing to a file).
        let findings = [];
        if (regression.findingsPath) {
          try {
            const parsed = JSON.parse(fs.readFileSync(regression.findingsPath, 'utf8'));
            if (Array.isArray(parsed.findings) && parsed.findings.length > 0) {
              findings = parsed.findings;
            }
          } catch {
            // missing/corrupt companion — fall through to the report path
          }
        }
        if (findings.length === 0) {
          try {
            const reportContent = fs.readFileSync(regression.reportPath, 'utf8');
            const parsed = JSON.parse(reportContent);
            findings = Array.isArray(parsed.findings) ? parsed.findings : [];
          } catch {
            // Report is markdown — no findings extractable here
          }
          if (findings.length === 0) {
            findings = [{
              file: 'unknown',
              description: regression.report
                ? regression.report.slice(0, 2000)
                : `Milestone ${msId} regression failed. See ${regression.reportPath}`,
            }];
          }
        }

        // (5) Call planner.remediateRegressionFailure
        // milestoneTargetFiles: the union of targetFiles declared by this
        // milestone's mission tasks — gives the remediation prompt a real
        // scope when the findings carry no usable filenames (the
        // markdown-report fallback above synthesizes file:'unknown').
        const milestoneTargetFiles = [...new Set(
          Object.keys(msState.missions).flatMap((missionId) => {
            try {
              const ms = JSON.parse(fs.readFileSync(
                path.join(this.harnessDir, 'state', `mission-${missionId}.json`), 'utf8'
              ));
              return Object.values(ms.subMissions || {}).flatMap((sm) =>
                Object.values(sm.tasks || {}).flatMap((t) => t.targetFiles || []));
            } catch {
              return [];
            }
          })
        )];
        const remPlan = await this.planner.remediateRegressionFailure(msId, findings, this.projectRoot, { specTargetFiles: this._getSpecTargetFiles(), milestoneTargetFiles, specAcceptanceCriteria: this._getSpecAcceptanceCriteria() });
        this._recordScopeMappingWarnings(msId, remPlan.scopeWarnings);
        const fixTaskCount = remPlan.newTasks?.length ?? 0;

        // Log fix-task count and analyzer verdict (TC6)
        this.onLog(`  Fix tasks: ${fixTaskCount}, analyzer verdict: ${regressionAnalysis.recommendation}`);

        if (fixTaskCount > 0) {
          // (6) Merge newTasks via mergeRemediationTasks into each affected mission
          const fileToMissionMap = buildFileToMissionMap(this.harnessDir);
          const allMissionIds = Object.keys(msState.missions).sort();
          const fallbackMissionId = allMissionIds[0];

          // Group new tasks by target mission via reverse file→mission map
          const tasksByMission = new Map();
          for (const newTask of remPlan.newTasks) {
            const targetFile = Array.isArray(newTask.targetFiles) ? newTask.targetFiles[0] : undefined;
            const targetMissionId = (targetFile && fileToMissionMap.get(targetFile)) ?? fallbackMissionId;
            if (!tasksByMission.has(targetMissionId)) tasksByMission.set(targetMissionId, []);
            tasksByMission.get(targetMissionId).push(newTask);
          }

          for (const [targetMissionId, missionTasks] of tasksByMission) {
            const missionStateFile = path.join(this.harnessDir, 'state', `mission-${targetMissionId}.json`);
            const existing = JSON.parse(fs.readFileSync(missionStateFile, 'utf8'));
            const decomp = stateToDecomp(existing);

            await mergeRemediationTasks({
              harnessDir: this.harnessDir,
              missionId: targetMissionId,
              newTasks: missionTasks,
              missionDecomp: decomp,
            });

            // Re-read state after merge so pending tasks are visible
            const freshState = JSON.parse(fs.readFileSync(missionStateFile, 'utf8'));
            const freshDecomp = stateToDecomp(freshState);

            // (7) Execute pending tasks
            for (const sm of freshDecomp.subMissions) {
              for (const task of sm.tasks) {
                const status = readTaskStatus(this.harnessDir, task.id);
                if (status === 'pending') {
                  await this._executeAndVerifyTask(targetMissionId, sm.id, task);
                }
              }
            }
          }
        }

        // (8) Re-run verifyMilestone
        const recheck = await verifyMilestone({
          milestoneId: msId,
          milestoneDesc: msState.description,
          specPath,
          verifier: this.verifier,
          projectRoot: this.projectRoot,
          harnessDir: this.harnessDir,
          onLog: this.onLog,
        });

        // (9) If passed, break out of remediation loop
        if (recheck.passed) {
          regressionPassed = true;
          this.onLog(`  Milestone ${msId} regression: resolved after remediation (iter ${iterIndex + 1}).`);
          break;
        }

        // Update regression for next iteration's sidecarPath
        regression = recheck;
      }

      // Exhaustion fallback: fall back to existing user gate after 3 iterations
      if (!regressionPassed) {
        if (!await this._gateConfirm(
          'regression-failed',
          `Milestone regression failed. Accept and proceed to Phase 5, or stop?`,
          { safeDefault: false, category: 'B' }
        )) {
          throw new Error(
            `Milestone ${msId} regression failed. User declined to proceed. ` +
            `See ${regression.reportPath}`
          );
        }
      }
      }
    }

    // Phase 5 — pure JS from here on. No complete-milestone.sh call.
    this.onLog(`\nRunning Phase 5 for milestone ${msId}...`);

    const audit = auditVerification(this.harnessDir, msId);
    if (audit.anomalies.length === 0) {
      this.onLog(`  Verification audit: ${audit.total} report(s) checked, all OK`);
    } else {
      this.onLog(`  Verification audit: ${audit.anomalies.length} anomaly(s) detected:`);
      for (const a of audit.anomalies) this.onLog(`    [WARN] ${a.taskId}: ${a.issue}`);
    }
    if (audit.anomalies.length > 0) {
      throw new VerificationAuditError(msId, audit.anomalies);
    }
    this._writeVerificationSummary(msId);

    await transitionMilestone(this.harnessDir, msId, 'complete');

    const cleaned = cleanupSnapshots(this.harnessDir, msId);
    if (cleaned > 0) this.onLog(`  Cleaned up ${cleaned} task snapshot(s)`);
    } finally {
      // Clear the milestone elapsed timer regardless of success or failure.
      if (this._msElapsedInterval !== null) {
        clearInterval(this._msElapsedInterval);
        this._msElapsedInterval = null;
      }
      this._msStartTime = null;
    }
  }

  /**
   * Last-milestone drain for the orphan spec hard-check gate.
   *
   * Judges spec hard-check coverage ONCE, against the union of ALL persisted
   * assignments — not per-mission, where lazy DFS sees only the just-planned
   * mission's tasks and falsely orphans a check whose file belongs to a later
   * mission. The assigned set is read from disk, NOT an in-memory accumulator,
   * so missions planned in a PRIOR run (skipped in Phase A on resume) still
   * count as assigned.
   *
   * Persisted reality (verified against state.js): writeMissionState does NOT
   * persist task hardChecks into mission-*.json — the per-task verify sidecars
   * (.harness/verify/task-*.json, written by writeVerifyJson) are where each
   * planned task's hardChecks live on disk. The union therefore reads BOTH
   * sources: the mission-state walk (the spec-contract shape; harmless when
   * the field is absent) and the verify sidecars (production ground truth).
   * The mission-state walk also collects the ids of invalidated tasks
   * (replaced via replaceTask), and the sidecar walk skips those tasks'
   * surviving sidecars — a check whose only home is an invalidated task's
   * sidecar will never execute and must be flagged as an orphan, not count
   * as assigned. Sidecars whose taskId appears in no mission state are NOT
   * skipped (conservative).
   *
   * Orphan candidacy follows isMilestoneOnlyCheck fed with the spec's own
   * declared target_files: a path-bearing check whose tokens reference NO
   * declared target_file (e.g. a suite-runner command) is milestone-only —
   * never an orphan; the spec-criteria drain executes it instead.
   *
   * Fail-soft: no prdPath / no spec.json / malformed json (that is
   * detectUncheckableSpec's job) / zero parsed checks → return. Orphans →
   * throw IncompleteScopeError, or warn-and-continue under
   * _allowIncompleteScope.
   */
  _assertSpecHardCheckCoverage() {
    const state = readState(this.harnessDir);
    const prdPath = state.projectMeta?.prdPath;
    if (!prdPath) return;
    const specJsonPath = deriveSpecJsonPath(prdPath, this.projectRoot);
    if (!fs.existsSync(specJsonPath)) return;
    let parsedChecks;
    let specTargetFiles;
    try {
      parsedChecks = parseSpecHardChecks(specJsonPath);
      specTargetFiles = parseSpecTargetFiles(specJsonPath);
      const coupledRules = config.scope?.coupledFiles ?? [];
      specTargetFiles = expandCoupledTargets(specTargetFiles, coupledRules);
    } catch (err) {
      this.onLog('Spec hard-check coverage drain skipped: spec.json at ' + specJsonPath + ' became unreadable post-planning (' + err.message + '); deterministic gates will not fire for this run.');
      return;
    }
    if (!parsedChecks.length) return;

    const assigned = new Set();
    // Task ids whose mission-state status is 'invalidated' (replaced via
    // replaceTask) — their surviving verify sidecars must not count as
    // assigned (see the sidecar walk below).
    const invalidationReasons = new Map();

    const stateDir = path.join(this.harnessDir, 'state');
    let missionFiles = [];
    try {
      missionFiles = fs.readdirSync(stateDir).filter((f) => /^mission-.*\.json$/.test(f));
    } catch {
      missionFiles = [];
    }
    for (const file of missionFiles) {
      let msj;
      try {
        msj = JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8'));
      } catch {
        continue; // skip corrupt state files
      }
      for (const sm of Object.values(msj.subMissions || {})) {
        for (const [tid, t] of Object.entries(sm.tasks || {})) {
          if (t && t.status === 'invalidated') invalidationReasons.set(tid, t.invalidationReason);
          for (const h of ((t && t.hardChecks) || [])) {
            if (h && typeof h.command === 'string') assigned.add(h.command);
          }
        }
      }
    }

    // Verify sidecars: the actual persisted home of per-task hardChecks
    // (state.js writeVerifyJson) — mission-*.json task entries never carry
    // them, so without this walk the assigned set would always be empty.
    const verifyDir = path.join(this.harnessDir, 'verify');
    let verifyFiles = [];
    try {
      verifyFiles = fs.readdirSync(verifyDir).filter((f) => /^task-.*\.json$/.test(f));
    } catch {
      verifyFiles = [];
    }
    for (const file of verifyFiles) {
      let vj;
      try {
        vj = JSON.parse(fs.readFileSync(path.join(verifyDir, file), 'utf8'));
      } catch {
        continue; // skip corrupt verify sidecars
      }
      // An invalidated task's surviving sidecar must not count as assigned —
      // the check will never execute there (HIGH ① false-green). Sidecars
      // whose taskId is absent from all mission states are NOT skipped
      // (conservative — cannot prove invalid).
      if (vj && typeof vj.taskId === 'string' && invalidationReasons.has(vj.taskId)) {
        const reason = invalidationReasons.get(vj.taskId);
        if (reason === 'replaced') {
          continue; // replaced tasks never run — skip
        } else if (reason === 'redundant') {
          // redundant tasks still count as coverage — do NOT skip
        } else {
          // legacy invalidated task with no invalidationReason — skip conservatively
          this.onLog(`[_assertSpecHardCheckCoverage] task ${vj.taskId}: missing invalidationReason, applying conservative skip`);
          continue;
        }
      }
      for (const h of (vj.hardChecks || [])) {
        if (h && typeof h.command === 'string') assigned.add(h.command);
      }
    }

    const orphans = findUnassignedSpecHardChecks(parsedChecks, assigned, specTargetFiles, this.projectRoot);
    if (orphans.length > 0) {
      const orphanCommands = orphans.map((c) => c.command);
      if (this._allowIncompleteScope) {
        this.onLog(`Spec hard-check coverage warning: ${orphans.length} path-bearing spec check(s) are not assigned to any task and would never run:\n${orphanCommands.map((cmd) => `  - ${cmd}`).join('\n')}`);
        return;
      }
      throw new IncompleteScopeError(orphanCommands);
    }
  }

  /**
   * True iff msId is the last milestone in the run (lexicographic sort of
   * all milestone ids, compare against the final element). Shared by the
   * orphan hard-check drain (_executeMilestoneParallel Phase-A end) and the
   * spec-criteria drain (_executeMilestone, pre-verifyMilestone) so the two
   * last-milestone detections cannot diverge.
   */
  _isLastMilestone(msId) {
    const stateNow = readState(this.harnessDir);
    const allMsIds = Object.keys(stateNow.milestones || {}).sort();
    return allMsIds.length > 0 && msId === allMsIds[allMsIds.length - 1];
  }

  /**
   * Spec-criteria execution drain — the deterministic last-milestone gate
   * for the two acceptance-criterion classes no other channel enforces:
   *
   *   1. Milestone-only command criteria (kind=command; per
   *      isMilestoneOnlyCheck: zero path tokens, OR no path token matching
   *      any spec-declared target_file — e.g. a suite-runner command like
   *      `node scripts/run-tests.js`): excluded from task scoping AND from
   *      the orphan definition, so without this drain they would never
   *      execute anywhere and the run would archive green. De-duplicated
   *      by command string before execution — spec.jsons can repeat the
   *      same command across criteria; each distinct command runs once.
   *   2. file-check criteria (kind=file-check): parseSpecHardChecks skips
   *      the kind entirely; the drain verifies each targetFile exists
   *      (existence only — no content/size semantics).
   *
   * kind=manual criteria are explicitly NOT this drain's business — the
   * reviewer + human review gate remain their verification channel.
   * Path-bearing command criteria keep their scoping/orphan channel
   * unchanged.
   *
   * Fail-soft preconditions (mirror _assertSpecHardCheckCoverage): no
   * prdPath / no spec.json sibling / malformed json (that is
   * detectUncheckableSpec's job) / zero criteria of either class → return
   * silently.
   *
   * Any recorded failure → throw SpecCriterionError. Deliberately NOT
   * gated by _allowIncompleteScope: that flag waives scope-ASSIGNMENT
   * uncertainty (a check that might still be covered elsewhere); here the
   * checks actually RAN and failed (or the required file is verifiably
   * absent), so a failure is a real delivery failure no waiver should
   * hide.
   */
  _runSpecCriteriaDrain() {
    const state = readState(this.harnessDir);
    const prdPath = state.projectMeta?.prdPath;
    if (!prdPath) return;
    const specJsonPath = deriveSpecJsonPath(prdPath, this.projectRoot);
    if (!fs.existsSync(specJsonPath)) return;
    let parsedChecks;
    let fileChecks;
    let specTargetFiles;
    try {
      parsedChecks = parseSpecHardChecks(specJsonPath);
      fileChecks = parseSpecFileChecks(specJsonPath);
      specTargetFiles = parseSpecTargetFiles(specJsonPath);
      const coupledRules = config.scope?.coupledFiles ?? [];
      specTargetFiles = expandCoupledTargets(specTargetFiles, coupledRules);
    } catch (err) {
      this.onLog('Spec-criteria drain skipped: spec.json at ' + specJsonPath + ' became unreadable post-planning (' + err.message + '); milestone-only checks and file-check criteria will not run.');
      return;
    }
    // De-duplicate by command string: each distinct command runs once.
    const seenCommands = new Set();
    const milestoneOnly = parsedChecks.filter((check) => {
      if (!isMilestoneOnlyCheck(check, specTargetFiles, this.projectRoot)) return false;
      if (seenCommands.has(check.command)) return false;
      seenCommands.add(check.command);
      return true;
    });
    if (milestoneOnly.length === 0 && fileChecks.length === 0) return;

    this.onLog(`\n  Spec-criteria drain: ${milestoneOnly.length} milestone-only check(s), ${fileChecks.length} file-check criterion(s)...`);

    const commandResult = runMilestoneOnlyChecks(milestoneOnly, this.projectRoot, { onLog: this.onLog, specTargetFiles });
    const fileResult = runFileCheckCriteria(fileChecks, this.projectRoot);
    const failures = [...commandResult.failures, ...fileResult.failures];
    if (failures.length > 0) {
      throw new SpecCriterionError(failures);
    }
  }

  /**
   * Phase I items 4+5 parallel execution path. The execution path for
   * every milestone.
   *
   * Three phases:
   *   A. Eager planning — plan every mission in the milestone one by
   *      one, prompt the user for approval on each, collect the
   *      approved mission IDs.
   *   B. Scheduler dispatch — build a flat task DAG across all
   *      approved missions and hand it to the scheduler, which runs
   *      tasks in parallel up to maxConcurrentSessions, respecting
   *      hard dependencies and file-conflict exclusion.
   *   C. Mission regressions — iterate approved missions sequentially
   *      and run _missionRegression on each. Runs after the scheduler
   *      completes because regressions may add remediation tasks via
   *      mergeRemediationTasks, which need to execute sequentially
   *      under the existing retry logic.
   *
   * Post-milestone regression + Phase 5 logic live in _executeMilestone.
   */
  async _executeMilestoneParallel(msId, msState) {
    // Phase A: eager planning for all missions in this milestone.
    const approvedMissionIds = [];
    for (const miId of Object.keys(msState.missions).sort()) {
      const mi = msState.missions[miId];
      if (mi.status === 'complete' || mi.status === 'invalidated') continue;

      const approved = await this._planAndApproveMission(miId, mi);
      if (approved) approvedMissionIds.push(miId);
    }

    // Orphan hard-check drain: at the LAST milestone's Phase-A end, every
    // planned task in the whole run is persisted, so judge spec hard-check
    // coverage once against the full assignment union. Must run BEFORE the
    // zero-approved early return — on resume, the last milestone's missions
    // may all be complete (zero approved) and the gate must still fire.
    if (!this._skipCoverageGate && this._isLastMilestone(msId)) {
      this._assertSpecHardCheckCoverage();
    }

    // Gate set = approved ∪ completed (fresh state read). Resume re-judge:
    // a run halted in Phase C (or later) leaves all missions complete and
    // zero approvable — the milestone gates (A.5 coverage, Phase C mission
    // regression) must still re-fire over those completed missions. The
    // scheduler skips tasks already terminal on disk, so building the DAG
    // over completed missions is safe and gives coverage-remediation tasks
    // an execution channel even at zero approved.
    const stateForGates = readState(this.harnessDir);
    const completedMissionIds = Object.keys(
      stateForGates.milestones?.[msId]?.missions || {}
    ).sort().filter(
      (miId) => stateForGates.milestones[msId].missions[miId].status === 'complete'
    );
    const gateMissionIds = [...new Set([...approvedMissionIds, ...completedMissionIds])].sort();

    if (gateMissionIds.length === 0) {
      this.onLog(`  No missions approved for execution in milestone ${msId}`);
      return;
    }

    if (approvedMissionIds.length === 0) {
      this.onLog(
        `  No newly approved missions in milestone ${msId} — re-running ` +
        `milestone gates over ${completedMissionIds.length} completed mission(s)`
      );
    }

    // Phase A.5: milestone-level scenario coverage check. Runs ONCE
    // across all approved missions collectively, replacing the N
    // per-mission checks that would each spawn a remediation planner.
    // Cross-cutting scenarios (e.g. "npm run test:all passes") are
    // correctly identified as "covered by mission X" without firing
    // remediation for missions Y and Z. Saves ~$2 and ~10 min per
    // dogfood vs the per-mission approach (dogfoods 5+6 data).
    if (!this._skipCoverageGate) {
      await checkMilestoneCoverage({
        harnessDir: this.harnessDir,
        projectRoot: this.projectRoot,
        missionIds: gateMissionIds,
        planner: this.planner,
        onLog: this.onLog,
        onConfirm: this.onConfirm,
        autoMode: this.autoFromHere,
      });
    }

    // Phase B: build the combined task DAG and hand to the scheduler.
    const taskDAG = this._buildTaskDAG(gateMissionIds);

    // After the DAG is built (all mission files written), refresh the
    // progress total so the status bar shows the final combined count.
    this.progress.invalidateTotal();
    this.progress.recomputeTotal(msId, msState);
    {
      const elapsed = Math.floor((Date.now() - this._msStartTime) / 1000);
      this.statusBar.updateMilestone(msId, this.progress.total, elapsed);
    }

    this.onLog(
      `  Scheduler: dispatching ${taskDAG.length} task(s) across ` +
      `${gateMissionIds.length} mission(s) ` +
      `(maxConcurrent=${config.execution.maxConcurrentSessions})`
    );

    // w4-needs-revalidation-repass: the analyzer cascade can mark a task
    // `complete → needs_revalidation` MID-run (_dispatchAnalyzer), AFTER the
    // scheduler's start-time status scan already classified it. runMilestone
    // then returns cleanly leaving that task non-terminal, and the invariant
    // below would throw a bare PendingTasksAtMilestoneAdvance → failed-execution.
    // Bounded re-pass: re-call runMilestone on the ALREADY-BUILT (status-agnostic)
    // taskDAG so its fresh start-time scan re-dispatches the needs_revalidation
    // task (verifier-only) and skips terminal tasks. Only needs_revalidation is
    // rescuable; every other non-terminal status falls through to the genuine
    // strand throw unchanged.
    const REPASS_CAP = 3;
    // Inline disk scan mirrors assertNoNonTerminalTasks' traversal: walk
    // msState.missions → state/mission-<miId>.json → subMissions[].tasks[],
    // collecting the ids whose FRESH on-disk status is needs_revalidation.
    const collectNeedsRevalidationIds = () => {
      const ids = [];
      for (const miId of Object.keys(msState.missions || {})) {
        const stateFile = path.join(this.harnessDir, 'state', `mission-${miId}.json`);
        if (!fs.existsSync(stateFile)) continue;
        let state;
        try {
          state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        } catch { continue; }
        for (const sm of Object.values(state.subMissions || {})) {
          for (const task of Object.values(sm.tasks || {})) {
            if (task.status === 'needs_revalidation') ids.push(task.id);
          }
        }
      }
      return ids;
    };

    let prevRevalSet = null;
    for (let iteration = 0; ; iteration++) {
      try {
        await this.scheduler.runMilestone(msId, taskDAG, { signal: this._cancelController.signal });
      } catch (err) {
        if (err.name === 'AbortError' || this._cancelController.signal.aborted) {
          this.onLog('Pipeline cancelled via signal — exiting cleanly');
          return;
        }

        // Unwrap one level: the scheduler may wrap the InfrastructureError
        // inside a generic Error whose cause is an InfrastructureError.
        const infraErr = (err instanceof InfrastructureError)
          ? err
          : (err.cause instanceof InfrastructureError ? err.cause : null);

        if (infraErr) {
          this.onLog(
            `  Scheduler infra-stall in milestone ${msId} ` +
            `(${infraErr.category}) — aborting parallel path, skipping regression/review`
          );
          throw infraErr;
        }

        // Non-infra scheduler errors (e.g. stall from unmet deps), and a
        // CircuitBreakerError thrown BY runMilestone (breaker / analyzer
        // repeat-detector) propagate unchanged — that is the intended
        // human-escalation path; the re-pass must NOT catch or loop on it.
        throw err;
      }

      // Abort may resolve the scheduler normally (no throw) while legitimately
      // leaving tasks non-terminal — short-circuit before the invariant check.
      if (this._cancelController.signal.aborted) {
        this.onLog('Pipeline cancelled via signal — exiting cleanly');
        return;
      }

      // Clean return: read milestone task states FRESH from disk and collect
      // the rescuable (needs_revalidation) set.
      const revalIds = collectNeedsRevalidationIds();
      if (revalIds.length === 0) break; // nothing to rescue → proceed to invariant

      const revalSet = [...revalIds].sort();
      const sameAsPrev = prevRevalSet !== null &&
        prevRevalSet.length === revalSet.length &&
        prevRevalSet.every((id, i) => id === revalSet[i]);

      // No-progress repeat (identical id set bounced back) or cap exhausted →
      // human-park throw. A CircuitBreakerError with recommendation 'human'
      // routes (batch catch ~1353) to 'halted-analyzer' PARK, NOT the
      // failed-execution path a bare PendingTasksAtMilestoneAdvance would land.
      if (sameAsPrev || iteration + 1 >= REPASS_CAP) {
        const reason = sameAsPrev
          ? `no progress (same ${revalSet.length} task(s) bounced back)`
          : `re-pass cap (${REPASS_CAP}) exhausted`;
        this.onLog(
          `  Milestone ${msId}: ${revalSet.length} task(s) still needs_revalidation ` +
          `after re-pass — ${reason}; escalating to human: ${revalSet.join(', ')}`
        );
        this._persistHaltAftermath({ kind: 'needs-revalidation', site: 'milestone-needs-revalidation-stuck', eventId: null });
        throw new CircuitBreakerError(
          `Circuit breaker: milestone ${msId} has ${revalSet.length} task(s) stuck in ` +
          `needs_revalidation after ${iteration + 1} scheduler re-pass(es) (${reason}). ` +
          `Stuck task(s): ${revalSet.join(', ')}. Escalated to human.`,
          { taskId: revalSet[0], recommendation: 'human' }
        );
      }

      // Progress is possible and budget remains → re-pass.
      prevRevalSet = revalSet;
      this.onLog(
        `  Milestone ${msId}: ${revalSet.length} task(s) marked needs_revalidation ` +
        `mid-run — re-passing scheduler (iteration ${iteration + 2}/${REPASS_CAP}): ${revalSet.join(', ')}`
      );
    }

    assertNoNonTerminalTasks(this.harnessDir, msId, msState, this.onLog);

    // Phase C: mission regressions, sequentially. Regression
    // remediation uses mergeRemediationTasks which is mutex-wrapped
    // under the step 2 mutex layer, so running regressions
    // sequentially here is safe even if the scheduler left state in
    // an interesting shape.
    for (const miId of gateMissionIds) {
      const mi = msState.missions[miId];
      const planPath = path.join(this.harnessDir, 'plan', `mission-${miId}.md`);
      const missionPlan = fs.existsSync(planPath)
        ? fs.readFileSync(planPath, 'utf8')
        : mi.description;
      await this._missionRegression(miId, missionPlan);
    }
  }

  /**
   * Plan a single mission and prompt the user for approval. The
   * scheduler path (via _executeMilestoneParallel) invokes this
   * planning/approval phase up front, independently of the scheduler-
   * driven execution phase that follows.
   *
   * Returns true if the mission was approved and should be scheduled,
   * false if the user declined. In the resume/alreadyApproved case
   * we still return true so the scheduler picks up the in-flight
   * work without re-prompting.
   */
  async _planAndApproveMission(miId, miState) {
    const _paBannerLines = this._formatBanner('Mission', miId, miState.description, { suffix: ' ---' });
    _paBannerLines[0] = '--- ' + _paBannerLines[0];
    this.onLog('\n' + _paBannerLines.join('\n'));

    const planPath = path.join(this.harnessDir, 'plan', `mission-${miId}.md`);
    const missionPlan = fs.existsSync(planPath)
      ? fs.readFileSync(planPath, 'utf8')
      : miState.description;

    const missionStateFile = path.join(this.harnessDir, 'state', `mission-${miId}.json`);
    let missionDecomp;
    let alreadyApproved = false;

    if (fs.existsSync(missionStateFile)) {
      const existing = JSON.parse(fs.readFileSync(missionStateFile, 'utf8'));
      if (existing.subMissions && Object.keys(existing.subMissions).length > 0) {
        this.onLog(`  Resuming mission ${miId} from existing state...`);
        missionDecomp = stateToDecomp(existing);
        alreadyApproved = isMissionAlreadyStarted(existing);
      }
    }

    if (!missionDecomp) {
      this.onLog(`  Planning mission ${miId} (lazy DFS)...`);
      const _planMissionStart1 = Date.now();
      this.statusBar.updateAgent('planner', { role: 'planner', status: 'active', startedAt: _planMissionStart1, cost: this.tokenTracker.getUsageByType('planner').totalCostUsd });
      this.statusBar.setPhase(`planning mission ${miId}`);
      // TAG-AND-RETHROW: this is a plan-phase call site — it runs BEFORE the
      // scheduler ever dispatches a task for this mission (Phase A of
      // _executeMilestoneParallel, ahead of Phase B's scheduler.runMilestone).
      // Any error thrown by planMission itself, or by the plan-validation
      // that immediately follows it (applySpecHardChecks), is tagged
      // err.planPhase = true and rethrown so batchResume's failed-execution
      // catch can route it to the failed-plan leg. planPhase is set ONLY
      // here — never inferred from error type or message elsewhere.

      // Fail-soft: gather already-planned task targetFiles from this
      // mission's same-milestone siblings (mission-<id>.json state files
      // written by an earlier Phase-A planMission call), keyed by sibling
      // mission id, so the planner can warn on cross-mission targetFile
      // duplication. Any read/parse failure — or a milestone with no
      // sibling state yet — degrades to {} rather than failing planning.
      let siblingMissionTaskTargets = {};
      try {
        const milestoneMissions = this._currentMsState?.missions || {};
        const targetsByMission = {};
        for (const smId of Object.keys(milestoneMissions)) {
          if (smId === miId) continue;
          const siblingStateFile = path.join(this.harnessDir, 'state', `mission-${smId}.json`);
          if (!fs.existsSync(siblingStateFile)) continue;
          const siblingState = JSON.parse(fs.readFileSync(siblingStateFile, 'utf8'));
          const targets = [];
          for (const sm of Object.values(siblingState.subMissions || {})) {
            for (const task of Object.values(sm.tasks || {})) {
              for (const tf of (task.targetFiles || [])) targets.push(tf);
            }
          }
          if (targets.length > 0) targetsByMission[smId] = targets;
        }
        siblingMissionTaskTargets = targetsByMission;
      } catch {
        siblingMissionTaskTargets = {};
      }

      try {
        try {
          missionDecomp = await this.planner.planMission(miId, this.projectRoot, {
            missionPlan,
            maxTasksPerSubMission: config.execution.maxTasksPerSubMission,
            mode: this._mode,
            specTargetFiles: this._getSpecTargetFiles(),
            specConstraints: this._getSpecConstraints(),
            specAcceptanceCriteria: this._getSpecAcceptanceCriteria(),
            scopeMapping: readState(this.harnessDir).projectMeta?.scopeMapping || [],
            scopeItems: readState(this.harnessDir).projectMeta?.scopeItems || [],
            siblingMissionTaskTargets,
          });
        } finally {
          this.statusBar.updateAgent('planner', null);
        }
        this._recordScopeMappingWarnings(miId, missionDecomp.scopeWarnings);
        this.onLog(`  planMission completed in ${this._formatElapsed(Date.now() - _planMissionStart1)}`);

        // Validate task dependencies and merge spec.json hard checks before persisting state.
        applySpecHardChecks(missionDecomp, this.projectRoot, this.harnessDir);
      } catch (planPhaseErr) {
        planPhaseErr.planPhase = true;
        throw planPhaseErr;
      }

      // Serialize concurrent run-tests.js registration: auto-declare the shared
      // test manifest in every test-creating task so hasFileConflict serializes
      // them. Runs unconditionally (NOT gated by spec.json, unlike applySpecHardChecks).
      enrichTestTaskTargetFiles(missionDecomp, this.projectRoot);

      // w4-state-resume-persistence Fix #1: write all verify sidecars FIRST,
      // then writeMissionState as the atomic commit point. A crash between
      // them leaves orphan sidecars with no mission state; on resume the
      // existing-state branch above is skipped (no mission-*.json), so this
      // decomposition block re-runs and unconditionally re-writes the
      // sidecars (writeVerifyJson always overwrites the per-task file). The
      // old order (mission state first) could wedge resume permanently: a
      // crash after writeMissionState but before the sidecar loop left a
      // mission with no hardChecks, which the resume existing-state branch
      // never backfilled, draining the same orphan coverage on every resume.
      for (const sm of missionDecomp.subMissions) {
        for (const task of sm.tasks) {
          writeVerifyJson(this.harnessDir, task);
        }
      }

      writeMissionState(this.harnessDir, miId, miState.description, missionDecomp);

      // Recompute progress total now that task files have been written
      // for this mission, so the status bar shows the updated task count.
      this.progress.invalidateTotal();
      this.progress.recomputeTotal(this._currentMsId, this._currentMsState);
      {
        const elapsed = Math.floor((Date.now() - this._msStartTime) / 1000);
        this.statusBar.updateMilestone(this._currentMsId, this.progress.total, elapsed);
      }

      // No per-mission scenario coverage check here. Coverage is
      // checked ONCE at the milestone level in _executeMilestoneParallel
      // (Phase A.5, via checkMilestoneCoverage) after all missions are
      // planned — correctly handles cross-cutting scenarios covered
      // by different missions.
    }

    this.onLog(`  Mission ${miId} sub-missions:`);
    for (const sm of missionDecomp.subMissions) {
      this.onLog(`    Sub-mission ${sm.id}: ${sm.description} (${sm.tasks.length} tasks)`);
    }

    if (alreadyApproved) {
      this.onLog(`  Mission ${miId}: resuming (already approved)`);
    } else if (!await this._gateConfirm('mission-approve-scheduler', `Proceed with mission ${miId}?`, { safeDefault: true, category: 'A' })) {
      this.onLog(`Mission ${miId} skipped by user.`);
      return false;
    }

    const currentMissionStatus = this._readMissionStatus(miId);
    if (currentMissionStatus === 'pending') {
      await transitionMission(this.harnessDir, miId, 'in_progress');
    }

    // Transition each sub-mission from pending → in_progress before
    // dispatching. The scheduler dispatches tasks flat with no per-sub-
    // mission loop, so we make this transition here so that after the
    // scheduler finishes, cascadeComplete can legally move each sub-
    // mission from in_progress → complete. Without this step the
    // cascade would silently fail the "Illegal" gate (pending →
    // complete is not an allowed transition).
    const missionStateAfter = JSON.parse(fs.readFileSync(missionStateFile, 'utf8'));
    for (const smId of Object.keys(missionStateAfter.subMissions || {})) {
      if (missionStateAfter.subMissions[smId].status === 'pending') {
        await transitionSubMission(this.harnessDir, miId, smId, 'in_progress');
      }
    }

    return true;
  }

  /**
   * Build a flat task DAG from the mission state files of the given
   * mission IDs. Every task in every sub-mission becomes an entry.
   * The scheduler operates on this flat list and doesn't need the
   * mission/sub-mission grouping for scheduling — only the downstream
   * runTask callback (which invokes _executeAndVerifyTask) needs the
   * missionId and subMissionId for state-machine transitions and
   * cascadeComplete calls.
   *
   * Task shape here mirrors the scheduler's expectations: at minimum
   * { id, missionId, subMissionId, targetFiles, dependencies }.
   * All other task fields (description, testCases, tracesScenario,
   * patternReferences, dataSchemas) are passed through unchanged.
   */
  _buildTaskDAG(missionIds) {
    const tasks = [];
    for (const miId of missionIds) {
      const stateFile = path.join(this.harnessDir, 'state', `mission-${miId}.json`);
      if (!fs.existsSync(stateFile)) continue;
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

      for (const [smId, sm] of Object.entries(state.subMissions || {})) {
        for (const [, task] of Object.entries(sm.tasks || {})) {
          tasks.push({
            id: task.id,
            missionId: miId,
            subMissionId: smId,
            description: task.description,
            targetFiles: task.targetFiles || [],
            dependencies: task.dependencies || [],
            testCases: task.testCases || [],
            tracesScenario: task.tracesScenario || [],
            patternReferences: task.patternReferences || [],
            dataSchemas: task.dataSchemas || [],
          });
        }
      }
    }
    return tasks;
  }

  /**
   * Autonomous mission regression. On failure: analyze → plan fixes → execute → re-verify.
   * Circuit breaker after one remediation attempt.
   */
  async _missionRegression(missionId, missionPlan) {
    const result = await verifyMission({
      missionId,
      missionPlan,
      verifier: this.verifier,
      projectRoot: this.projectRoot,
      harnessDir: this.harnessDir,
      onLog: this.onLog,
    });

    if (result.isStub) throw new Error('Mission ' + missionId + ' regression: verifier returned no structured_output');
    if (result.passed) return;

    // regression-sequencing-override: a FAILED verdict may be entirely
    // attributable to pending (not-yet-completed) scope elsewhere in the
    // run rather than a regression the completed work introduced. Compute
    // the fail-closed scope (empty on any read failure) across ALL missions
    // in the global state, then ask the filter whether this FAIL qualifies
    // for downgrade. This MUST run before analyzeFailure — a qualifying
    // downgrade treats the gate as PASSED and returns here.
    let missionPendingTargetFiles = [];
    let missionCompletedAffectedFiles = [];
    try {
      const globalState = readState(this.harnessDir);
      const allMissionIds = [];
      for (const ms of Object.values(globalState.milestones || {})) {
        for (const miId of Object.keys(ms.missions || {})) allMissionIds.push(miId);
      }
      const scope = this._collectRegressionFilterScope(allMissionIds);
      missionPendingTargetFiles = scope.pendingTargetFiles;
      missionCompletedAffectedFiles = scope.completedAffectedFiles;
    } catch {
      missionPendingTargetFiles = [];
      missionCompletedAffectedFiles = [];
    }

    const missionDowngrade = shouldDowngradeRegressionFail({
      structured: result.structured,
      pendingTargetFiles: missionPendingTargetFiles,
      projectRoot: this.projectRoot,
      completedAffectedFiles: missionCompletedAffectedFiles,
    });

    if (missionDowngrade.downgrade) {
      this.onLog(`  [regression-sequencing-override] Mission ${missionId} regression FAIL downgraded: ${missionDowngrade.reason}`);
      appendWarnings(this.projectRoot, [{
        milestone: missionId,
        severity: 'warning',
        category: 'regression-sequencing-override',
        description: `Mission ${missionId} regression FAIL downgraded (regression-sequencing-override): ${missionDowngrade.reason}`,
      }]);
      recordGateOverride(this.harnessDir, `regression-${missionId}`, 'regression-sequencing-override', missionDowngrade.reason);
      return;
    }

    // Autonomous fix: analyze + plan + execute
    this.onLog(`  Attempting autonomous fix for mission ${missionId}...`);

    const regressionAnalysisStart = Date.now();
    const analysis = await this.analyzer.analyzeFailure({
      taskId: `regression-${missionId}`,
      taskDescription: `Mission ${missionId} regression failure`,
      failureType: 'regression',
      retryCount: 0,
    }, this.projectRoot);
    this.onLog(`  Analyzer finished in ${this._formatElapsed(Date.now() - regressionAnalysisStart)}`);

    this.onLog(`  Analyzer recommendation: ${analysis.recommendation}`);

    if (analysis.recommendation === 'human') {
      this._persistHaltAftermath({ kind: 'mission-regression', site: 'mission-regression-human', eventId: analysis.eventId });
      throw new CircuitBreakerError(
        `Circuit breaker: Mission ${missionId} regression failed. Analyzer recommends human intervention. ` +
        `See .harness/analysis/${analysis.eventId}.json`,
        { taskId: `regression-${missionId}`, recommendation: 'human', eventId: analysis.eventId }
      );
    }

    // Plan fix tasks
    const fixPlan = await this.planner.remediateScenarios(missionId, this.projectRoot, {
      uncoveredScenarios: [`Regression failure: ${result.report.slice(0, 500)}`],
      missionPlan,
    });

    if (fixPlan.newTasks?.length) {
      this.onLog(`  Adding ${fixPlan.newTasks.length} fix task(s)...`);

      // Read existing decomp, merge fixes, execute
      const missionStateFile = path.join(this.harnessDir, 'state', `mission-${missionId}.json`);
      const existing = JSON.parse(fs.readFileSync(missionStateFile, 'utf8'));
      const decomp = stateToDecomp(existing);

      await mergeRemediationTasks({
        harnessDir: this.harnessDir,
        missionId,
        newTasks: fixPlan.newTasks,
        missionDecomp: decomp,
      });

      // Execute new tasks
      for (const sm of decomp.subMissions) {
        for (const task of sm.tasks) {
          const status = readTaskStatus(this.harnessDir, task.id);
          if (status === 'pending') {
            await this._executeAndVerifyTask(missionId, sm.id, task);
          }
        }
      }

      // Re-run regression
      const recheck = await verifyMission({
        missionId,
        missionPlan,
        verifier: this.verifier,
        projectRoot: this.projectRoot,
        harnessDir: this.harnessDir,
        onLog: this.onLog,
      });

      if (recheck.isStub) throw new Error('Mission ' + missionId + ' regression after remediation: verifier returned no structured_output');
      if (recheck.passed) {
        this.onLog(`  Mission ${missionId} regression: resolved after fix.`);
        return;
      }
    }

    this._persistHaltAftermath({ kind: 'mission-regression', site: 'mission-regression-after-remediation', eventId: analysis.eventId });
    throw new CircuitBreakerError(
      `Circuit breaker: Mission ${missionId} regression failed after remediation attempt. ` +
      `Manual intervention required.`,
      { taskId: `regression-${missionId}`, recommendation: 'human' }
    );
  }

  _readMissionStatus(missionId) {
    const stateFile = path.join(this.harnessDir, 'state', `mission-${missionId}.json`);
    if (!fs.existsSync(stateFile)) return null;
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return state.status || null;
  }

  _formatElapsed(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  _bumpProgress(taskId) {
    this.progress.markDone(taskId);
    this.progress.assertInvariant(taskId, this._currentMsId, this._currentMsState);
    const usage = this.tokenTracker.getTotalUsage();
    this.statusBar.updateProgress(this.progress.done, this.progress.total, usage.totalCostUsd, usage.sessionCount);
  }

  _captureLastFailed(task) {
    const affected = readAffectedFiles(this.harnessDir, task.id);
    const allFiles = [...new Set([...(task.targetFiles || []), ...affected])];
    snapshotFiles(this.harnessDir, this.projectRoot, task.id, 'last-failed', allFiles);
  }

  /**
   * Run the test-registration gate for a single task.
   * Computes the file set as the union of task.targetFiles and readAffectedFiles,
   * then delegates to checkTestRegistration.
   * @param {object} task
   * @returns {{ passed: boolean, violations: string[] }}
   */
  async _runTestRegistrationGate(task) {
    return runTestRegistrationGate(task, this.harnessDir, this.projectRoot, this.onLog);
  }

  /**
   * Persist a deterministic pipeline-side verification override into the
   * task's verification sidecar (verification/task-<id>.json) so the analyzer
   * can see WHY a task failed when the verifier's own verdict says PASSED.
   * Without this the override evidence lives only in memory and the run log,
   * and the analyzer — which reads the sidecars — faces contradictory signals
   * it can only escalate to human. Fail-soft: a missing/corrupt sidecar is
   * never a reason to break the main flow.
   */
  _recordGateOverride(taskId, gate, evidence) {
    recordGateOverride(this.harnessDir, taskId, gate, evidence);
  }

  async _applyHardCheckGate(task, verifyResult, label) {
    return applyHardCheckGate(task, verifyResult, label, this.harnessDir, this.projectRoot, this.onLog);
  }

  /**
   * Format a milestone or mission banner as an array of lines.
   *
   * Splits `description` at the first `. ` or `\n` into a title and a
   * word-wrapped body.  An optional `suffix` (opts.suffix) is appended to
   * the title line only.  An optional `opts.indent` (default `''`) is
   * prepended to every output line.
   *
   * @param {string} prefix       e.g. 'Milestone' or 'Mission'
   * @param {string|number} id    the milestone/mission identifier
   * @param {string} description  the full description text
   * @param {{ suffix?: string, indent?: string, maxBodyLines?: number, wrapWidth?: number }} [opts]
   *   opts.wrapWidth — explicit wrap column for body lines.  When omitted the
   *   default is terminal-aware: `getTerminalWidth({ fallback: 100 }) - 4`.
   * @returns {string[]}          array of formatted lines (no trailing newlines)
   */
  _formatBanner(prefix, id, description, opts = {}) {
    return formatBannerLines(prefix, id, description, opts);
  }

  _writeVerificationSummary(msId) {
    writeVerificationSummary(msId, this.harnessDir, this.onLog);
  }

  _parseVerificationSidecar(taskId) {
    return parseVerificationSidecar(this.harnessDir, taskId);
  }

  _logVerifierPassCounts(taskId, label) {
    logVerifierPassCounts(taskId, label, this.harnessDir, this.onLog);
  }

  _writeElapsedToSidecar(taskId, field, elapsedMs) {
    writeElapsedToSidecar(this.harnessDir, taskId, field, elapsedMs);
  }

  // ── Task execution + verification cycle ──

  /**
   * Read the persisted retryCount for a task from the on-disk mission state.
   *
   * transitionTask('failed') increments task.retryCount in mission state,
   * but without this read-back every _executeAndVerifyTask entry point
   * (scheduler dispatch, revalidation re-execution, remediation loops)
   * passed retryCount = 0, so resume/revalidation granted a fresh
   * config.maxRetries budget each time — ③ non-convergence.
   *
   * @param {string} missionId
   * @param {string} subMissionId
   * @param {string} taskId
   * @returns {number} The persisted retryCount, or 0 if the mission state
   *   file or task entry is missing/unreadable.
   */
  _readPersistedRetryCount(missionId, subMissionId, taskId) {
    try {
      const stateFile = path.join(this.harnessDir, 'state', `mission-${missionId}.json`);
      const missionState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return missionState.subMissions?.[subMissionId]?.tasks?.[taskId]?.retryCount ?? 0;
    } catch {
      return 0;
    }
  }

  async _executeAndVerifyTask(missionId, subMissionId, task, retryCount = 0, opts = {}) {
    // Retry budget is durable across resume/revalidation: clamp the
    // parameter to the persisted retryCount (lifetime per-task budget).
    // In-chain recursion stays parameter-driven; the clamp is monotone
    // (Math.max) so equal-tracking disk increments are harmless.
    {
      const persisted = this._readPersistedRetryCount(missionId, subMissionId, task.id);
      if (persisted > retryCount) {
        this.onLog(`    Task ${task.id}: adopting persisted retryCount ${persisted} (was ${retryCount}) — retry budget is durable across resume/revalidation`);
        retryCount = persisted;
      }
    }

    // Defect #17: phantom-write probe flag, hoisted to function scope so
    // the verifier-PASS / verifier-FAIL branches below can branch on it.
    // Set when the SHA-256 disk-diff guard fires (executor reported
    // COMPLETED but bytes unchanged). When true, verifier dispatch acts
    // as a no-op disambiguation probe:
    //   - Verifier PASSES → task was redundant (sibling work satisfied
    //     goal) → mark `invalidated` (NOT `verified`); preserves goal-
    //     state truth, signals planner over-decomposition for retros,
    //     auto-excludes from regression aggregation.
    //   - Verifier FAILS → executor genuinely lied → analyzer once,
    //     no retry, no _captureLastFailed (last-failed/ ≡ before/ for
    //     no-op tasks), no restoreSnapshot (nothing to restore).
    let phantomWriteProbe = false;

    // Resume case: if the task is already at awaiting_verification, the
    // executor already ran in a previous invocation (that crashed
    // downstream). Skip the executor re-dispatch — the work is on
    // disk — and go straight to verifier. This avoids a redundant
    // executor session and the illegal awaiting_verification self-loop
    // transition.
    const preExecStatus = readTaskStatus(this.harnessDir, task.id);

    // Revalidation path: task was previously verified but needs re-verification
    if (preExecStatus === 'needs_revalidation') {
      this.onLog(`    Task ${task.id}: needs revalidation`);
      const restored = restoreSnapshot(this.harnessDir, this.projectRoot, task.id, 'after', this._computeRestoreOverrides(task, 'after'));
      if (restored) this.onLog(`      Restored ${restored} file(s) from after-snapshot`);
      await transitionTask(this.harnessDir, task.id, 'awaiting_verification');

      const revalStart = Date.now();
      let verifyResult = await this.verifier.verifyTask(task, this.projectRoot, { purpose: task.description, specPath: readState(this.harnessDir)?.projectMeta?.prdPath, firstWrite: false, ...this._buildVerifierSpecContext(task) });
      this.onLog(`    Task ${task.id}: verifier finished in ${this._formatElapsed(Date.now() - revalStart)}`);
      this._writeElapsedToSidecar(task.id, 'verifierElapsedMs', Date.now() - revalStart);

      if (verifyResult.verified) {
        verifyResult = await this._applyHardCheckGate(task, verifyResult, 'revalidation');
        if (verifyResult.verified) {
          const trgResult = await this._runTestRegistrationGate(task);
          if (!trgResult.passed) {
            verifyResult = { verified: false, evidence: 'test-registration-gate: ' + trgResult.violations.join(', ') };
            this._recordGateOverride(task.id, 'test-registration-gate', verifyResult.evidence);
            this.onLog('    Task ' + task.id + ': test-registration-gate FAILED — overriding revalidation to FAILED');
          }
        }
        if (verifyResult.verified) {
          this._logVerifierPassCounts(task.id, 'revalidation PASSED');
          assertNoStubVerifierSidecar(this.harnessDir, task.id);
          await transitionTask(this.harnessDir, task.id, 'verified', { caller: 'verification' });
          await transitionTask(this.harnessDir, task.id, 'complete');
          this._bumpProgress(task.id);
          return;
        }
      }
      if (!verifyResult.verified) {
        this.onLog(`    Task ${task.id}: revalidation FAILED → re-executing`);
        await transitionTask(this.harnessDir, task.id, 'failed');
        this._captureLastFailed(task);
        restoreSnapshot(this.harnessDir, this.projectRoot, task.id, 'before', this._computeRestoreOverrides(task, 'before'));
        await this._executeAndVerifyTask(missionId, subMissionId, task, 0, opts);
        return;
      }
    }

    const skipExecutor = preExecStatus === 'awaiting_verification';

    if (skipExecutor) {
      this.onLog(`    Task ${task.id}: resuming from awaiting_verification (skipping executor re-run)`);
    } else {
      this.onLog(`    Task ${task.id}: executing...`);

      if (retryCount === 0) {
        snapshotFiles(this.harnessDir, this.projectRoot, task.id, 'before', task.targetFiles || []);
      } else {
        const restored = restoreSnapshot(this.harnessDir, this.projectRoot, task.id, 'before', this._computeRestoreOverrides(task, 'before'));
        if (restored) this.onLog(`      Restored ${restored} file(s) from before-snapshot`);
      }

      if (preExecStatus === 'pending' || preExecStatus === 'failed' || preExecStatus === 'blocked') {
        await transitionTask(this.harnessDir, task.id, 'in_progress');
      }

      const verifyJsonPath = path.join(this.harnessDir, 'verify', `task-${task.id}.json`);
      const verifyJsonContent = fs.existsSync(verifyJsonPath) ? fs.readFileSync(verifyJsonPath, 'utf8') : undefined;

      // Build previousFailures from the verification sidecar on retries
      let previousFailures;
      if (retryCount > 0) {
        const retrySidecar = this._parseVerificationSidecar(task.id);
        if (retrySidecar === null) {
          this.onLog(`    Task ${task.id}: [WARN] verification sidecar missing or malformed on retry — proceeding with empty previousFailures`);
          previousFailures = [];
        } else {
          const hc = retrySidecar.hardChecks || [];
          const sc = retrySidecar.taskScopeChecks || [];
          previousFailures = [
            ...hc.filter((c) => c.status === 'FAIL').map((c) => ({ kind: 'hardCheck', description: c.description, evidence: c.evidence })),
            ...sc.filter((c) => c.status === 'FAIL').map((c) => ({ kind: 'scopeCheck', description: c.description, evidence: c.evidence })),
          ];
        }
      }

      const execContext = { verifyJsonContent };
      execContext.firstWrite = (preExecStatus === 'pending');
      if (retryCount > 0) {
        execContext.previousFailures = previousFailures;
      }

      // Pre-create every in-root targetFile's parent directory before the
      // executor spawns. Missing parent directories are the trigger that lets
      // an executor `find`/`ls` search out to a same-named directory in an
      // UNRELATED project (see the 2026-07-21 incident) and then `Write` there.
      // Removing the missing-dir trigger complements the write-time boundary
      // guard in session-manager.js (the guard is the enforcement; this is
      // trigger removal). Best-effort per entry — a mkdir failure never fails
      // the task; out-of-root entries are skipped here and denied at the guard.
      const _projectRootAbs = path.resolve(this.projectRoot);
      for (const tf of (task.targetFiles || [])) {
        if (typeof tf !== 'string') continue;
        const abs = path.isAbsolute(tf) ? path.resolve(tf) : path.resolve(_projectRootAbs, tf);
        const inRoot = abs === _projectRootAbs || abs.startsWith(_projectRootAbs + path.sep);
        if (!inRoot) continue;
        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
        } catch (err) {
          this.onLog(`    Task ${task.id}: pre-create parent dir failed for ${tf} — ${err.message}`);
        }
      }

      const execStart = Date.now();
      this.statusBar.updateAgent('executor-'+task.id, { role: 'executor', taskId: task.id, description: task.description, status: 'active', startedAt: execStart, cost: this.tokenTracker.getUsageByType('executor').totalCostUsd });
      let execResult;
      try {
        execResult = await this.executor.executeTask(task, this.projectRoot, execContext);
      } catch (err) {
        if (err instanceof WallClockExceededError || err.name === 'WallClockExceededError') {
          this.onLog(`Task ${task.id}: wall-clock exceeded (${err.message}) — non-retryable, dispatching analyzer`);
          this._captureLastFailed(task);
          restoreSnapshot(this.harnessDir, this.projectRoot, task.id, 'before', this._computeRestoreOverrides(task, 'before'));
          await this._dispatchAnalyzer(task, 'execution', retryCount);
          return;
        }
        if (err instanceof InfrastructureError) {
          this.onLog(`    Task ${task.id}: Infrastructure error (${err.category}) — saving state and exiting`);
          throw err;
        }
        throw err;
      } finally {
        this.statusBar.updateAgent('executor-'+task.id, null);
      }
      this.onLog(`    Task ${task.id}: executor finished in ${this._formatElapsed(Date.now() - execStart)}`);
      this._writeElapsedToSidecar(task.id, 'executorElapsedMs', Date.now() - execStart);

      if (execResult.status === 'BLOCKED') {
        this.onLog(`    Task ${task.id}: BLOCKED by executor — deterministic refusal, non-retryable, dispatching analyzer`);
        await transitionTask(this.harnessDir, task.id, 'failed');
        this._captureLastFailed(task);
        restoreSnapshot(this.harnessDir, this.projectRoot, task.id, 'before', this._computeRestoreOverrides(task, 'before'));
        await this._dispatchAnalyzer(task, 'execution', retryCount);
        return;
      }

      // Phantom-write guard: executor self-attests COMPLETED via structured
      // JSON, but the {status, affectedFiles} fields are model output — not
      // observed disk writes. Compare each declared file's SHA-256 against
      // the before/ snapshot; if all are byte-identical, the COMPLETED claim
      // is unsubstantiated. Like the BLOCKED branch above, this is a
      // deterministic failure that skips the retry chain; the probe routes to
      // the verifier and, on probe-FAIL, dispatches the analyzer.
      // Defect #14 (self-attestation gap, distinct from #2's
      // evidence-preservation closure in v0.1.27).
      //
      // Gated on the exact production status word ('COMPLETED' per the
      // executor schema at executor.js:82) so non-production status strings
      // from test mocks fall through to the verifier without firing.
      const affectedFromExec = (execResult.affectedFiles || [])
        .map((f) => (typeof f === 'string' ? f : f?.path))
        .filter(Boolean);
      const filesToCheck = [...new Set([...(task.targetFiles || []), ...affectedFromExec])];
      const diff = execResult.status === 'COMPLETED'
        ? assertChangesLanded(this.harnessDir, this.projectRoot, task.id, filesToCheck)
        : { ok: true, unchanged: [] };
      if (!diff.ok) {
        // Defect #17: phantom-write is deterministic — retrying an
        // executor session against the same task description produces
        // the same SHA-256 match. Treat as a no-op disambiguation
        // probe instead of a transient failure to retry. Fall through
        // to verifier dispatch; do NOT transition to 'failed' (that
        // would block the next transitionTask('awaiting_verification')
        // since `failed → awaiting_verification` is not in the state-
        // machine transition table per state-machine.js:96).
        this.onLog(`    Task ${task.id}: NO-OP detected — declared file(s) unchanged: ${diff.unchanged.join(', ')}; routing to verifier as disambiguation probe (skipping retry — phantom-write is deterministic)`);
        this.onLog(formatZeroDeltaLog(task.id, diff.unchanged));
        phantomWriteProbe = true;
      }
    }

    // Dispatch verifier (UNCONDITIONAL, except skip the state transition
    // if we're already at awaiting_verification — the state machine
    // disallows the self-loop).
    this.onLog(`    Task ${task.id}: verifying...`);
    if (!skipExecutor) {
      await transitionTask(this.harnessDir, task.id, 'awaiting_verification');
    }

    const verifyStart = Date.now();
    this.statusBar.updateAgent('verifier-'+task.id, { role: 'verifier', taskId: task.id, description: task.description, status: 'active', startedAt: verifyStart, cost: this.tokenTracker.getUsageByType('verifier').totalCostUsd });
    let verifyResult;
    try {
      verifyResult = await this.verifier.verifyTask(task, this.projectRoot, { purpose: task.description, specPath: readState(this.harnessDir)?.projectMeta?.prdPath, firstWrite: skipExecutor ? false : (preExecStatus === 'pending'), ...this._buildVerifierSpecContext(task) });
    } catch (err) {
      if (err instanceof WallClockExceededError || err.name === 'WallClockExceededError') {
        this.onLog(`Task ${task.id}: wall-clock exceeded (${err.message}) — non-retryable, dispatching analyzer`);
        this._captureLastFailed(task);
        restoreSnapshot(this.harnessDir, this.projectRoot, task.id, 'before', this._computeRestoreOverrides(task, 'before'));
        await this._dispatchAnalyzer(task, 'verification', retryCount);
        return;
      }
      if (err instanceof InfrastructureError) {
        this.onLog(`    Task ${task.id}: Infrastructure error (${err.category}) — saving state and exiting`);
        throw err;
      }
      throw err;
    } finally {
      this.statusBar.updateAgent('verifier-'+task.id, null);
    }
    this.onLog(`    Task ${task.id}: verifier finished in ${this._formatElapsed(Date.now() - verifyStart)}`);
    this._writeElapsedToSidecar(task.id, 'verifierElapsedMs', Date.now() - verifyStart);

    if (verifyResult.verified) {
      // Defect #17: phantom-write probe-PASS branch. Verifier confirmed
      // goal state holds without executor delta — task was redundant
      // (sibling work satisfied it). Mark invalidated (per state-
      // machine.js:93 awaiting_verification → invalidated) instead of
      // verified, signaling "this task didn't contribute" to downstream
      // consumers (regression aggregation, summarizer, planner-feedback
      // retros). Skip after-snapshot — nothing was edited.
      if (phantomWriteProbe) {
        // Before-presence check: a phantom-write probe-PASS is only
        // genuinely "redundant" if every declared file already existed
        // before the executor ran (the goal was satisfied by pre-existing
        // state / sibling work). If ANY declared targetFile is both-missing
        // — absent from the before-snapshot AND absent from the current
        // working tree — it was never produced: a genuine phantom-write
        // FAILURE, not redundancy. Mislabeling it invalidated would silently
        // drop a missing artifact.
        //
        // Scoped to task.targetFiles ONLY (a fresh assertChangesLanded call,
        // NOT the union-scoped filesToCheck probe result): the executor's
        // self-reported affectedFiles are untrustworthy in the phantom-write
        // case and must not re-enter the gate (contract-not-self-report).
        const declaredDiff = assertChangesLanded(this.harnessDir, this.projectRoot, task.id, task.targetFiles || []);
        const bothMissing = declaredDiff.bothMissing;

        if (bothMissing.length > 0) {
          this.onLog(`    Task ${task.id}: phantom-write — declared file(s) never produced (absent from before-snapshot and disk): [${bothMissing.join(', ')}]; treating as FAILED, not redundant`);
          verifyResult = { verified: false, evidence: 'phantom-write: declared file(s) never produced: ' + bothMissing.join(', ') };
          this._recordGateOverride(task.id, 'phantom-write-probe', verifyResult.evidence);
          // Fall through (no return): verifyResult.verified is now false, so
          // the remaining `if (verifyResult.verified)` gates below are skipped
          // and execution reaches the "Verification failed" handling, where
          // the existing probe-FAIL branch dispatches the analyzer.
        } else {
          this.onLog(`    Task ${task.id}: REDUNDANT — sibling work satisfied goal; marking invalidated (no executor edits made, verifier confirmed goal state holds)`);
          console.warn(`[phantom-write-probe] Redundant task: ${task.id}. Possible planner over-decomposition. Verifier passed without executor delta.`);
          await transitionTask(this.harnessDir, task.id, 'invalidated', { invalidationReason: 'redundant' });

          this._bumpProgress(task.id);
          return;
        }
      }

      verifyResult = await this._applyHardCheckGate(task, verifyResult, 'verification');

      if (verifyResult.verified) {
        const testRegResult = await this._runTestRegistrationGate(task);
        if (!testRegResult.passed) {
          verifyResult = { verified: false, evidence: 'test-registration-gate: ' + testRegResult.violations.join(', ') };
          this._recordGateOverride(task.id, 'test-registration-gate', verifyResult.evidence);
          this.onLog('    Task ' + task.id + ': test-registration gate FAILED — overriding verification to FAILED');
        }
      }

      if (verifyResult.verified) {
        this._logVerifierPassCounts(task.id, 'VERIFIED');
        assertNoStubVerifierSidecar(this.harnessDir, task.id);
        await transitionTask(this.harnessDir, task.id, 'verified', { caller: 'verification' });
        await transitionTask(this.harnessDir, task.id, 'complete');

        this._bumpProgress(task.id);

        const affected = readAffectedFiles(this.harnessDir, task.id);
        const allFiles = [...new Set([...(task.targetFiles || []), ...affected])];
        snapshotFiles(this.harnessDir, this.projectRoot, task.id, 'after', allFiles);
        return;
      }
    }

    this.onLog(`    Task ${task.id}: verification FAILED`);
    await transitionTask(this.harnessDir, task.id, 'failed');

    // Defect #17: phantom-write probe-FAIL branch. Phantom-write detected
    // AND verifier disagrees with goal state — executor genuinely lied.
    // Skip retry (deterministic failure), skip _captureLastFailed
    // (last-failed/ would equal before/ since no edits), skip
    // restoreSnapshot (nothing to restore). Dispatch analyzer once with
    // failureType: 'execution' (the executor was the offender).
    if (phantomWriteProbe) {
      this.onLog(`    CIRCUIT BREAKER: Task ${task.id} — phantom-write + verifier-FAIL: executor reported COMPLETED but no work landed AND goal state not met. No retry (deterministic failure); dispatching analyzer.`);
      this._bumpProgress(task.id);
      await this._dispatchAnalyzer(task, 'execution', retryCount);
      return;
    }

    if (retryCount < config.maxRetries) {
      this.onLog(`    Re-dispatching (attempt ${retryCount + 2}/${config.maxRetries + 1})...`);
      return this._executeAndVerifyTask(missionId, subMissionId, task, retryCount + 1);
    }

    this.onLog(`    CIRCUIT BREAKER: Task ${task.id} failed verification ${config.maxRetries + 1} times.`);
    // Notify StatusBar of task failure progress (final failure — no more retries).
    this._bumpProgress(task.id);
    this._captureLastFailed(task);
    restoreSnapshot(this.harnessDir, this.projectRoot, task.id, 'before', this._computeRestoreOverrides(task, 'before'));
    await this._dispatchAnalyzer(task, 'verification', retryCount);
  }

  // ── Analyzer dispatch ──

  /**
   * SHA-256 of `filePath`'s contents, or null if the file doesn't exist or
   * can't be read (fail-soft, mirrors _fileHash in snapshots.js — kept
   * private here since that one isn't exported).
   *
   * @param {string} filePath
   * @returns {string|null}
   */
  _fileHashSafe(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Compact snapshot-evidence table for the analyzer: for each task with
   * status 'complete' in milestone `msId` that has an after/ snapshot on
   * disk, SHA-256-compares every file in that snapshot against the current
   * working tree (same hash discipline as assertChangesLanded) and labels
   * the task 'intact' (every file matches) or 'overwritten-after-completion'
   * (at least one file differs).
   *
   * Walks the mission-state tree exactly like _collectMilestoneContext
   * (readState → milestones → missions → mission-<id>.json → subMissions →
   * tasks). Fail-soft end to end: any unreadable/corrupt mission state or
   * snapshot dir contributes no row for that task (never throws); on total
   * failure (e.g. unreadable state.json) returns [].
   *
   * @param {string} msId
   * @returns {Array<{taskId: string, label: 'intact'|'overwritten-after-completion'}>}
   */
  _computeSnapshotEvidenceTable(msId) {
    const table = [];
    try {
      if (!msId) return table;
      const state = readState(this.harnessDir);
      const msState = state?.milestones?.[msId];
      if (!msState) return table;
      for (const [miId, mission] of Object.entries(msState.missions || {})) {
        const missionStatePath = mission.stateFile
          ? resolveHarnessFileRef(this.harnessDir, mission.stateFile)
          : path.join(this.harnessDir, 'state', `mission-${miId}.json`);
        if (!fs.existsSync(missionStatePath)) continue;
        try {
          const missionState = JSON.parse(fs.readFileSync(missionStatePath, 'utf8'));
          for (const [, sm] of Object.entries(missionState.subMissions || {})) {
            for (const [, t] of Object.entries(sm.tasks || {})) {
              if (t.status !== 'complete') continue;
              const afterDir = path.join(this.harnessDir, 'snapshots', t.id, 'after');
              if (!fs.existsSync(afterDir)) continue;
              try {
                const files = this._walkSnapshotDir(afterDir);
                if (files.length === 0) continue;
                let intact = true;
                for (const relPath of files) {
                  const snapHash = this._fileHashSafe(path.join(afterDir, relPath));
                  const treeHash = this._fileHashSafe(path.join(this.projectRoot, relPath));
                  if (snapHash === null || snapHash !== treeHash) {
                    intact = false;
                    break;
                  }
                }
                table.push({ taskId: t.id, label: intact ? 'intact' : 'overwritten-after-completion' });
              } catch {
                // Unreadable snapshot dir for this task — contribute no row.
              }
            }
          }
        } catch {
          // Corrupt mission state — skip this mission's tasks.
        }
      }
    } catch {
      return [];
    }
    return table;
  }

  async _dispatchAnalyzer(task, failureType, retryCount) {
    this.onLog(`    Dispatching analyzer for impact analysis...`);

    try {
      const cbAnalysisStart = Date.now();
      this.statusBar.updateAgent('analyzer-'+task.id, { role: 'analyzer', taskId: task.id, description: task.description, status: 'active', startedAt: cbAnalysisStart, cost: this.tokenTracker.getUsageByType('analyzer').totalCostUsd });
      let analysis;
      try {
        const snapshotEvidence = this._computeSnapshotEvidenceTable(this._currentMsId);
        analysis = await this.analyzer.analyzeFailure({
          taskId: task.id,
          taskDescription: task.description,
          failureType,
          retryCount,
          // The retry budget is exhausted at this site — 'retry' is not a
          // consumable verdict here, so it is excluded from the session's
          // schema enum (the other call sites keep all three verbs).
          allowedRecommendations: ['re_plan', 'human'],
          // Engine-computed evidence of which completed tasks' after/
          // snapshots still match disk. An empty table (the common case)
          // injects nothing — analyzeFailure only appends its evidence
          // section when snapshotEvidence.length > 0 — so the prompt stays
          // byte-identical to the table-less form.
          ...(snapshotEvidence.length > 0 ? { snapshotEvidence } : {}),
        }, this.projectRoot);
      } finally {
        this.statusBar.updateAgent('analyzer-'+task.id, null);
      }
      this.onLog(`    Analyzer finished in ${this._formatElapsed(Date.now() - cbAnalysisStart)}`);

      this.onLog(`    Analysis: ${analysis.eventId} — recommendation: ${analysis.recommendation}`);

      if (analysis.affectedTasks?.length) {
        this.onLog(`    Marking ${analysis.affectedTasks.length} affected task(s) for revalidation...`);
        for (const affectedId of analysis.affectedTasks) {
          const status = readTaskStatus(this.harnessDir, affectedId);
          if (status === 'complete') {
            await transitionTask(this.harnessDir, affectedId, 'needs_revalidation');
            this.onLog(`      ${affectedId}: complete → needs_revalidation`);
          }
        }
      }

      // ── Repeat detector (round 2+) ───────────────────────────────────
      // The same verdict (recommendation + affectedTasks id set) as the
      // previous round for this canonical task means acting on it again
      // would loop — escalate to human regardless of the current
      // recommendation. History read is fail-soft: no readable prior
      // entry, no check. The current round's just-appended entry is
      // excluded by eventId so the comparison is prior-vs-current.
      const verdictHistory = readAnalysisHistory(this.harnessDir, task.id);
      const priorRounds = verdictHistory.filter((h) => h?.eventId !== analysis.eventId);
      const prevRound = priorRounds[priorRounds.length - 1];
      if (prevRound && isRepeatVerdict(prevRound, analysis)) {
        this.onLog(`    CIRCUIT BREAKER: analyzer REPEATED its previous verdict for task ${task.id} (rec=${analysis.recommendation}, same affected-task set) — escalating to human.`);
        recordHistoryOutcome(
          this.harnessDir, task.id, analysis.eventId,
          `escalated: breaker thrown (rec=${analysis.recommendation})`,
          (msg) => this.onLog(`    ${msg}`)
        );
        this._persistHaltAftermath({ kind: 'task-analyzer-repeat', site: 'task-analyzer-repeat-verdict', eventId: analysis.eventId });
        throw new CircuitBreakerError(
          `Circuit breaker: task ${task.id} failed ${failureType} after ${retryCount + 1} attempts. ` +
          `Analyzer repeated its previous verdict (rec=${analysis.recommendation}) — escalated to human. ` +
          `See .harness/analysis/${analysis.eventId}.json`,
          { taskId: task.id, recommendation: analysis.recommendation, eventId: analysis.eventId, escalatedByRepeat: true }
        );
      }

      // ── re_plan branch ───────────────────────────────────────────────
      // When the analyzer recommends re-planning the task, attempt DAG
      // surgery via planner.replanTask → scheduler.replaceTask.  If the
      // cap is exceeded, replacementTasks is empty, or either call
      // throws, we fall through to the circuit-breaker throw below.
      if (analysis.recommendation === 're_plan') {
        const originalId = canonicalTaskId(task.id);
        const attempts = this.scheduler._replanAttempts.get(originalId) ?? 0;

        if (attempts < Scheduler.MAX_REPLAN_ATTEMPTS) {
          try {
            const planPath = path.join(this.harnessDir, 'plan', `mission-${task.missionId}.md`);
            const missionContext = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : '';

            const result = await this.planner.replanTask(
              { id: task.id, description: task.description, targetFiles: task.targetFiles },
              analysis.structured,
              missionContext,
              { specTargetFiles: this._getSpecTargetFiles(), specAcceptanceCriteria: this._getSpecAcceptanceCriteria() }
            );
            this._recordScopeMappingWarnings(task.missionId, result.scopeWarnings);

            if (!result.replacementTasks?.length) {
              this.onLog(`    re_plan: planner returned empty replacementTasks — escalating to human`);
              // Fall through to circuit-breaker throw below
            } else {
              await this.scheduler.replaceTask(task.id, result.replacementTasks);
              this.onLog(
                `    re_plan: replaced task ${task.id} with ` +
                `[${result.replacementTasks.map((t) => t.id).join(', ')}]`
              );
              recordHistoryOutcome(
                this.harnessDir, task.id, analysis.eventId,
                `replaced with [${result.replacementTasks.map((t) => t.id).join(', ')}]`,
                (msg) => this.onLog(`    ${msg}`)
              );
              return; // Scheduler will pick up replacement tasks — do NOT throw
            }
          } catch (replanErr) {
            this.onLog(`    re_plan: replanTask/replaceTask threw — ${replanErr.message}`);
            // Fall through to circuit-breaker throw below
          }
        }
        // Cap exceeded or replan failed: fall through to circuit-breaker throw
      }

      recordHistoryOutcome(
        this.harnessDir, task.id, analysis.eventId,
        `escalated: breaker thrown (rec=${analysis.recommendation})`,
        (msg) => this.onLog(`    ${msg}`)
      );
      this._persistHaltAftermath({ kind: 'task-analyzer', site: 'task-analyzer-escalation', eventId: analysis.eventId });
      throw new CircuitBreakerError(
        `Circuit breaker: task ${task.id} failed ${failureType} after ${retryCount + 1} attempts. ` +
        `Recommendation: ${analysis.recommendation}. ` +
        `${analysis.affectedTasks?.length || 0} task(s) marked for revalidation. ` +
        `See .harness/analysis/${analysis.eventId}.json`,
        { taskId: task.id, recommendation: analysis.recommendation, eventId: analysis.eventId }
      );
    } catch (err) {
      if (err instanceof InfrastructureError) throw err;
      if (err.message.startsWith('Circuit breaker:')) throw err;
      this.onLog(`    Analyzer failed: ${err.message}`);
      throw new CircuitBreakerError(
        `Circuit breaker: task ${task.id} failed ${failureType} after ${retryCount + 1} attempts. ` +
        `Analyzer could not complete: ${err.message}`,
        { taskId: task.id }
      );
    }
  }

  // ── Spec remediation helpers ──

  /**
   * Normalise verify-result `uncertain` objects to the compact {text, specSection}
   * shape used by the this-run source of truth (state.uncertainAssumptions) and
   * the archive manifest. A verify-result's `assumption` is either a
   * {text, specSection} object or a bare string.
   *
   * @param {Array<{ assumption?: ({text?: string, specSection?: string}|string) }>} uncertains
   * @returns {Array<{ text: string, specSection: string }>}
   */
  _normalizeUncertains(uncertains) {
    return normalizeUncertains(uncertains);
  }

  /**
   * Record this run's genuine `uncertain` assumptions WITHOUT parking. Appends
   * each to the warnings ledger (durable cross-run record) and writes the
   * compact list into the harness state as `state.uncertainAssumptions` (the
   * single this-run source of truth read by the review gate and the archive).
   *
   * Read-modify-write on state.json so an existing field is replaced rather
   * than two divergent lists accruing. No-op on the state write when state.json
   * is absent (the ledger append still happens) — the batch path defers the
   * state write to AFTER bootstrap (which wipes state) via
   * _persistUncertainsToState.
   *
   * @param {Array<object>} uncertains  verify-result objects with status 'uncertain'.
   */
  _recordUncertainAssumptions(uncertains) {
    if (!uncertains || uncertains.length === 0) return;
    appendUncertainAssumptions(this.projectRoot, uncertains);
    this._persistUncertainsToState(this._normalizeUncertains(uncertains));
  }

  /**
   * Write the compact this-run uncertain list into state.uncertainAssumptions
   * via read-modify-write (so an intervening whole-state write does not leave
   * two divergent lists). Best-effort: silently skips when state.json is absent.
   *
   * @param {Array<{ text: string, specSection: string }>} normalized
   */
  _persistUncertainsToState(normalized) {
    return persistUncertainsToState(this.harnessDir, normalized);
  }

  /**
   * _remediateAssumptions — Reusable remediation loop.
   *
   * Iterates over `failed` assumptions from a verifyAssumptions result, proposes
   * spec edits via the planner, then either:
   *   - 'interactive': prompts the user (via askAssumptionFix) to accept/edit/reject
   *   - 'autonomous':  auto-accepts all planner-proposed fixes via _applySpecEdit
   *
   * After iterating, if any edits were applied it re-runs verifyAssumptions (round 2).
   * Returns { passed: boolean, anyEditsApplied: boolean }.
   *
   * @param {object} globalPlan  The global plan (must include .assumptions).
   * @param {object} opts        Options: prdPath, mode ('interactive'|'autonomous').
   * @returns {{ passed: boolean, anyEditsApplied: boolean }}
   */
  async _remediateAssumptions(globalPlan, opts = {}) {
    const mode = opts.mode ?? 'interactive';
    const specPath = opts.prdPath ?? null;
    let anyEditsApplied = false;

    // ── Round 1: verify ──────────────────────────────────────────────────────
    this.onLog(`\nVerifying ${globalPlan.assumptions.length} assumptions against codebase...`);
    const _r1Start = Date.now();
    this.statusBar.updateAgent('planner', { role: 'planner', status: 'active', startedAt: _r1Start, cost: this.tokenTracker.getUsageByType('planner').totalCostUsd });
    let verified;
    this.statusBar.setPhase('verifying assumptions');
    try {
      verified = await this.planner.verifyAssumptions(globalPlan.assumptions, this.projectRoot);
    } finally {
      this.statusBar.updateAgent('planner', null);
    }
    this.onLog(`  verifyAssumptions completed in ${this._formatElapsed(Date.now() - _r1Start)}`);

    const failed = verified.filter((a) => a.status === 'failed');
    const uncertain = verified.filter((a) => a.status === 'uncertain');
    const deferred = verified.filter((a) => a.status === 'deferred');

    if (deferred.length > 0) {
      this.onLog(`  [DEFER] ${deferred.length} post-fix assumption(s) deferred until after execution`);
    }
    globalPlan.postFixAssumptions = deferred.map((d) => d.assumption);

    for (const a of verified) {
      const icon = a.status === 'verified' ? '[OK]' : a.status === 'failed' ? '[FAIL]' : a.status === 'deferred' ? '[DEFER]' : '[??]';
      const phaseTag = a.assumption?.phase === 'invariant' ? '[invariant]' : a.assumption?.phase === 'post-fix' ? '[post-fix]' : '';
      this.onLog(`  ${icon} ${phaseTag}${phaseTag ? ' ' : ''}${a.assumption?.text ?? a.assumption}`);
      if (a.status !== 'verified') this.onLog(`       ${a.evidence}`);
    }

    if (failed.length > 0) {
      this.onLog(`\n${failed.length} assumption(s) FAILED.`);

      // ── Remediation loop ──────────────────────────────────────────────────
      for (const assumption of failed) {
        const assumptionText = assumption.assumption?.text ?? assumption.assumption;
        const specSection = assumption.assumption?.specSection ?? null;
        const evidence = assumption.evidence ?? '';

        if (!specSection) {
          this.onLog(`  [remediation] No specSection for assumption — skipping: "${assumptionText}"`);
          continue;
        }

        const specExcerpt = specPath ? this._extractSpecSection(specPath, specSection) : null;
        if (!specExcerpt) {
          this.onLog(`  [remediation] Section "${specSection}" not found in spec — skipping.`);
          continue;
        }

        let proposedFix;
        const _remediateStart = Date.now();
        this.statusBar.updateAgent('planner', { role: 'planner', status: 'active', startedAt: _remediateStart, cost: this.tokenTracker.getUsageByType('planner').totalCostUsd });
        try {
          proposedFix = await this.planner.remediateAssumption(assumptionText, evidence, specExcerpt);
        } catch (err) {
          this.onLog(`  [remediation] remediateAssumption failed: ${err.message} — skipping.`);
          continue;
        } finally {
          this.statusBar.updateAgent('planner', null);
        }

        const proposedEdit = {
          section: proposedFix.specEdit?.section ?? specSection,
          oldText: proposedFix.specEdit?.old ?? '',
          newText: proposedFix.specEdit?.new ?? '',
        };

        // When autoFromHere is active, treat this session as autonomous even if
        // the top-level mode is 'interactive' — the user already opted-in to
        // hands-free execution from this point forward.
        const effectiveMode = (mode === 'interactive' && this.autoFromHere) ? 'autonomous' : mode;

        if (effectiveMode === 'interactive') {
          // Show proposed fix to user and await their choice.
          // proposedFix.revisedAssumptions items are {text, phase, specSection?} per schema.
          const { choice, editedText, editIndex } = await askAssumptionFix(
            assumptionText,
            evidence,
            {
              revisedAssumptions: proposedFix.revisedAssumptions || [],
              specEdit: proposedEdit,
            },
            { statusBar: this.statusBar },
          );

          if (choice === 'a') {
            const applied = this._applySpecEdit(specPath, proposedEdit.oldText, proposedEdit.newText, {
              subsystem: 'remediation',
              section: proposedEdit.section,
              summary: `accepted fix for: "${assumptionText}"`,
            });
            if (applied) {
              this.onLog(`  [remediation] Spec updated for assumption: "${assumptionText}"`);
              anyEditsApplied = true;
            }
          } else if (choice === 'e') {
            if (editIndex != null && proposedFix.revisedAssumptions?.[editIndex] != null && editedText != null) {
              proposedFix.revisedAssumptions[editIndex] = {
                ...proposedFix.revisedAssumptions[editIndex],
                text: editedText,
              };
            }
            const applied = this._applySpecEdit(specPath, proposedEdit.oldText, editedText ?? proposedEdit.newText, {
              subsystem: 'remediation',
              section: proposedEdit.section,
              summary: `user-edited fix for: "${assumptionText}"`,
            });
            if (applied) {
              this.onLog(`  [remediation] Spec updated (user-edited) for assumption: "${assumptionText}"`);
              anyEditsApplied = true;
            }
          } else {
            this.onLog(`  [remediation] Rejected fix for assumption: "${assumptionText}"`);
          }
        } else {
          // autonomous mode: auto-accept all planner-proposed fixes.
          const old = proposedEdit.oldText;
          const nw = proposedEdit.newText;
          const applied = this._applySpecEdit(specPath, old, nw, {
            subsystem: 'remediation',
            section: proposedEdit.section,
            summary: `auto-fix for: "${assumptionText}"`,
          });
          if (applied) {
            this.onLog(`  [remediation] [auto] Spec updated for assumption: "${assumptionText}"`);
            anyEditsApplied = true;
          }
        }

        // Update the assumptions in the plan so round 2 re-verifies the
        // corrected, phase-tagged versions. Replace the original failed entry
        // with N revised entries (each {text, phase, specSection}) at the
        // original index. Round-2 routing reads `phase` to dispatch invariant
        // vs post-fix items.
        if (proposedFix.revisedAssumptions?.length) {
          const idx = globalPlan.assumptions.findIndex((pa) =>
            (pa?.text ?? pa) === assumptionText
          );
          if (idx !== -1) {
            const original = globalPlan.assumptions[idx];
            const fallbackSpecSection = (typeof original === 'object' ? original.specSection : null) ?? specSection ?? '';
            const mapped = proposedFix.revisedAssumptions.map((revised) => ({
              text: revised.text,
              phase: revised.phase,
              specSection: revised.specSection ?? fallbackSpecSection,
            }));
            globalPlan.assumptions.splice(idx, 1, ...mapped);
          }
        }
      }

      // ── Post-loop: re-verify or fall back ────────────────────────────────
      if (anyEditsApplied) {
        // Re-read spec and re-extract assumptions so round-2 verify uses fresh
        // content rather than the stale spliced array.
        if (specPath && fs.existsSync(specPath)) {
          const reExtracted = await this.planner.reExtractAssumptions(specPath, this.projectRoot);
          globalPlan.assumptions = reExtracted;
          this.onLog(`Re-extracted ${reExtracted.length} assumptions from edited spec`);
        }

        this.onLog('\nRe-verifying assumptions after spec edits (round 2)...');
        const _r2Start = Date.now();
        this.statusBar.updateAgent('planner', { role: 'planner', status: 'active', startedAt: _r2Start, cost: this.tokenTracker.getUsageByType('planner').totalCostUsd });
        let verified2;
        this.statusBar.setPhase('verifying assumptions (round 2)');
        try {
          verified2 = await this.planner.verifyAssumptions(globalPlan.assumptions, this.projectRoot);
        } finally {
          this.statusBar.updateAgent('planner', null);
        }
        this.onLog(`  verifyAssumptions (round 2) completed in ${this._formatElapsed(Date.now() - _r2Start)}`);

        const failed2 = verified2.filter((a) => a.status === 'failed');
        for (const a of verified2) {
          const icon = a.status === 'verified' ? '[OK]' : a.status === 'failed' ? '[FAIL]' : a.status === 'deferred' ? '[DEFER]' : '[??]';
          const phaseTag = a.assumption?.phase === 'invariant' ? '[invariant]' : a.assumption?.phase === 'post-fix' ? '[post-fix]' : '';
          this.onLog(`  ${icon} ${phaseTag}${phaseTag ? ' ' : ''}${a.assumption?.text ?? a.assumption}`);
          if (a.status !== 'verified') this.onLog(`       ${a.evidence}`);
        }

        if (failed2.length > 0) {
          this.onLog(
            `\n[ESCALATION] ${failed2.length} assumption(s) still FAILED after spec remediation. ` +
            `Manual intervention required. Stopping.`
          );
          return { passed: false, anyEditsApplied };
        }
      } else {
        // No edits applied (all rejected) — fall back to proceed-anyway prompt
        if (!await this._gateConfirm('assumption-failed', 'Assumptions failed. Proceed anyway?', { safeDefault: false, category: 'B' })) {
          this.onLog('Stopping due to failed assumptions.');
          return { passed: false, anyEditsApplied };
        }
      }
    } else if (uncertain.length > 0) {
      // Uncertain is advisory — it no longer parks/gates/stops the run. Record
      // each uncertain to the warnings ledger (durable) and to the this-run
      // source of truth (state.uncertainAssumptions, read by the review gate +
      // archive), then continue. The deterministic downstream gates are the
      // real safety net; `failed` still blocks the confidently-wrong case.
      this.onLog(`\n${uncertain.length} assumption(s) uncertain — recorded (advisory); continuing.`);
      this._recordUncertainAssumptions(uncertain);
    }

    return { passed: true, anyEditsApplied };
  }

  /**
   * Read the spec file at specPath, split on ## headings, and return the
   * full text of the section whose heading matches sectionName.
   * Returns null if the file does not exist or the section is not found.
   *
   * @param {string} specPath     Absolute or relative path to the spec file.
   * @param {string} sectionName  The heading to look for, e.g. "## Session API".
   * @returns {string|null}
   */
  _extractSpecSection(specPath, sectionName) {
    return extractSpecSection(specPath, sectionName, this.onLog);
  }

  /**
   * _getSpecTargetFiles() — Read the spec file and extract backtick-wrapped
   * file paths, or fall back to spec.json target_files if available. The
   * declared list is then expanded with any `config.scope.coupledFiles`
   * rules (read defensively — an absent scope section or coupledFiles key
   * yields no rules and the declared list is returned unchanged).
   * Result is cached on this._specTargetFilesCache (the declared,
   * pre-expansion list); expansion is re-applied on every call.
   *
   * @returns {string[]} Array of target file paths (may be empty).
   */
  _getSpecTargetFiles() {
    const pipeline = this;
    const cache = {
      get value() { return pipeline._specTargetFilesCache; },
      set value(v) { pipeline._specTargetFilesCache = v; },
    };
    const declared = getSpecTargetFiles(this.harnessDir, this.projectRoot, cache);
    const coupledRules = config.scope?.coupledFiles ?? [];
    return expandCoupledTargets(declared, coupledRules);
  }

  /**
   * _getSpecConstraints() — Read spec.json constraints[] (json-only, no .md
   * fallback). Returns [] when the json is absent or has no constraints.
   * Result is cached on this._specConstraintsCache.
   *
   * @returns {string[]} Array of constraint strings (may be empty).
   */
  _getSpecConstraints() {
    if (this._specConstraintsCache !== undefined) return this._specConstraintsCache;
    const state = readState(this.harnessDir);
    const prdPath = state.projectMeta?.prdPath;
    this._specConstraintsCache = readSpecConstraints(prdPath, this.projectRoot);
    return this._specConstraintsCache;
  }

  /**
   * _getSpecPlanStructure() — Read spec.json plan_structure (json-only, no
   * .md fallback). Returns {} when the json is absent or has no
   * plan_structure. Result is cached on this._specPlanStructureCache, but
   * ONLY when prdPath is truthy — an absent prdPath yields an uncached {}
   * so a later call made once prdPath resolves is not served a stale empty
   * result.
   *
   * @returns {object} The spec plan_structure section (may be {}).
   */
  _getSpecPlanStructure() {
    if (this._specPlanStructureCache !== undefined) return this._specPlanStructureCache;
    const state = readState(this.harnessDir);
    const prdPath = state.projectMeta?.prdPath;
    const planStructure = readSpecPlanStructure(prdPath, this.projectRoot);
    if (prdPath) this._specPlanStructureCache = planStructure;
    return planStructure;
  }

  /**
   * _getSpecAcceptanceCriteria() — Read spec.json acceptance_criteria[] (json-
   * only, no .md fallback). Returns [] when the json is absent, has no criteria,
   * or fails to parse. Result is cached on this._specAcceptanceCriteriaCache.
   *
   * @returns {object[]} Array of acceptance-criterion objects (may be empty).
   */
  _getSpecAcceptanceCriteria() {
    if (this._specAcceptanceCriteriaCache !== undefined) return this._specAcceptanceCriteriaCache;
    const state = readState(this.harnessDir);
    const prdPath = state.projectMeta?.prdPath;
    this._specAcceptanceCriteriaCache = readSpecAcceptanceCriteria(prdPath, this.projectRoot);
    return this._specAcceptanceCriteriaCache;
  }

  /**
   * _getSpecGoal() — Read spec.json goal (json-only, no .md fallback). Returns
   * '' when the json is absent, has no goal, or fails to parse. Result is
   * cached on this._specGoalCache.
   *
   * @returns {string} The spec goal string (may be empty).
   */
  _getSpecGoal() {
    if (this._specGoalCache !== undefined) return this._specGoalCache;
    const state = readState(this.harnessDir);
    const prdPath = state.projectMeta?.prdPath;
    this._specGoalCache = readSpecGoal(prdPath, this.projectRoot);
    return this._specGoalCache;
  }

  /**
   * _buildVerifierSpecContext(task) — Compute the compact, task-relevant spec
   * context injected into the per-task verifier. Returns the spec goal plus the
   * acceptance_criteria relevant to THIS task: a criterion is relevant when its
   * `verification.command` matches one of the task's hardChecks (the task's
   * spec-derived hardChecks were mapped to it by scopeSpecHardChecks, so they
   * encode exactly the criteria that motivated it). The hardChecks are read
   * from the verify sidecar `.harness/verify/task-{id}.json` (the disk SoT —
   * scheduler-rehydrated tasks carry no in-memory hardChecks), unioned with
   * `task.hardChecks` as the in-memory fallback for direct callers. A task
   * with no spec hardChecks in either source → relevantCriteria is [].
   *
   * @param {object} task — The task being verified.
   * @returns {{specGoal: string, relevantCriteria: object[]}}
   */
  _buildVerifierSpecContext(task) {
    const ctx = buildVerifierSpecContext(this.harnessDir, task, this._getSpecAcceptanceCriteria(), config);
    return { specGoal: this._getSpecGoal(), relevantCriteria: ctx.relevantCriteria };
  }

  /**
   * _anchorPrdPath(opts) — Anchor state.projectMeta.prdPath to the invoked
   * spec BEFORE any planning or gating (W1-F1 consecutive-dry-run pollution).
   *
   * Why: dryRunValidate bootstraps ONLY when .harness/state.json is absent,
   * and the queue-copy repoint (step 6c) happens only AFTER planning — so the
   * 2nd+ consecutive dry-run ran planGlobal while state.projectMeta.prdPath
   * still pointed at the PREVIOUS spec's queue copy. The four per-spec
   * getters (_getSpecTargetFiles/_getSpecConstraints/
   * _getSpecAcceptanceCriteria/_getSpecGoal) read that stale prdPath and
   * injected the WRONG spec.json context into the planner — reproduced live
   * in the Wave-1 proving run. run() shares the same bootstrap-if-absent +
   * getter-injection shape, hence both call sites are anchored.
   *
   * No-ops when opts.prdPath is falsy (goal-only mode unchanged) or when
   * state.json does not exist (fresh bootstrap already set prdPath). Silent
   * no-op when the resolved path already matches. Otherwise: persist the
   * resolved path (same write pattern as step 6c), reset the four getter
   * caches, and log old → new.
   *
   * @param {object} opts - run opts (may carry prdPath)
   */
  _anchorPrdPath(opts = {}) {
    if (!opts.prdPath) return;
    if (!fs.existsSync(path.join(this.harnessDir, 'state.json'))) return;

    const resolved = path.resolve(opts.prdPath);
    const stateData = readState(this.harnessDir);
    if (stateData.projectMeta?.prdPath === resolved) return;

    const oldPrdPath = stateData.projectMeta?.prdPath;
    if (!stateData.projectMeta) stateData.projectMeta = {};
    stateData.projectMeta.prdPath = resolved;
    // w4-state-resume-persistence Fix #1 rider: route the anchor-path
    // state.json write through the crash-safe temp-file+rename pattern
    // (writeJsonAtomic) instead of a bare fs.writeFileSync, so a crash mid-
    // write cannot leave a truncated state.json.
    writeJsonAtomic(
      path.join(this.harnessDir, 'state.json'),
      stateData,
    );
    this._specTargetFilesCache = this._specConstraintsCache = this._specAcceptanceCriteriaCache = this._specGoalCache = undefined;
    this._specPlanStructureCache = undefined;
    this.onLog(`Anchored state prdPath: ${oldPrdPath} → ${resolved}`);
  }

  /**
   * _detectUncheckableSpec(opts) — Fail-closed guard for `.md`-spec runs whose
   * sibling spec.json is missing or unparseable. Mirrors _scopeCoverageGate's
   * prdPath resolution and _allowIncompleteScope handling.
   *
   * Out of scope (returns silently) when prdPath is falsy, not a `.md`, or not
   * on disk. When a sibling spec.json exists, it is also JSON.parse'd to confirm
   * it is checkable.
   *
   * The flag is honoured ASYMMETRICALLY, by design:
   *   - MISSING json → respects _allowIncompleteScope (warn + continue). With no
   *     json, the downstream degrades gracefully — applySpecHardChecks early-
   *     returns on the absent json and _getSpecConstraints returns [] — so a
   *     warn-and-continue is safe.
   *   - LEGACY DIALECT (json parses, acceptance_criteria is a non-empty array,
   *     and ZERO items carry a verification object — e.g. the old
   *     evidence-string dialect) → same tier as MISSING: respects
   *     _allowIncompleteScope. Downstream degrades gracefully here too
   *     (parseSpecHardChecks / parseSpecFileChecks filter on verification.kind
   *     and return [], no crash) — but every spec-level deterministic gate
   *     would be silently off, so the default is fail-closed. Mixed dialect
   *     (≥1 verification object) and all-`manual` specs pass: the former still
   *     drives some gates, the latter is an honest human-verification
   *     declaration, not a dialect mismatch. Missing/empty/non-array
   *     acceptance_criteria stays out of scope.
   *   - MALFORMED json (corrupt or empty; JSON.parse('') itself throws) → ALWAYS
   *     throws, ignoring _allowIncompleteScope. Continuing past a broken json
   *     does NOT help: parseSpecHardChecks runs an unguarded JSON.parse in a
   *     per-mission loop and would crash far away with a cryptic
   *     "Unexpected end of JSON input". _allowIncompleteScope tolerates an
   *     incomplete *scope*, not an unprocessable *file*; throwing here converts
   *     that future cryptic crash into a clean fail-closed error up front.
   *
   * @param {object} opts - run opts (may carry prdPath)
   */
  _detectUncheckableSpec(opts = {}) {
    let prdPath = opts.prdPath;
    if (!prdPath) {
      const state = readState(this.harnessDir);
      prdPath = state.projectMeta?.prdPath;
    }
    if (!prdPath || !prdPath.endsWith('.md') || !fs.existsSync(prdPath)) {
      return;
    }
    const jsonPath = deriveSpecJsonPath(prdPath, this.projectRoot);
    if (fs.existsSync(jsonPath)) {
      let spec;
      try {
        spec = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch {
        // Exists but corrupt/empty → unprocessable. Continuing would crash in
        // parseSpecHardChecks; throw a clean error now. Malformed json does NOT
        // respect _allowIncompleteScope (see JSDoc — asymmetry is intentional).
        throw new UncheckableSpecError(prdPath);
      }
      const criteria = spec.acceptance_criteria;
      const legacyDialect = Array.isArray(criteria) && criteria.length > 0
        && !criteria.some((item) => isCheckableCriterion(item));
      if (!legacyDialect) {
        return; // parseable, ≥1 verification object (or no criteria) → checkable
      }
      // Legacy dialect: parses cleanly but no criterion carries a verification
      // object, so the spec-level parsers would return [] and every
      // deterministic gate would be silently off. Same tier as missing json
      // (see JSDoc): downstream degrades gracefully, so warn-and-continue is
      // safe when incomplete scope is allowed.
      if (this._allowIncompleteScope) {
        this.onLog(`Uncheckable spec warning: '${prdPath}' has a sibling spec.json whose acceptance_criteria carry no verification objects (legacy dialect); continuing because incomplete scope is allowed.`);
        return;
      }
      throw new UncheckableSpecError(prdPath, 'legacy-dialect');
    }
    // Sibling json is missing: downstream degrades gracefully, so warn-and-
    // continue is safe when incomplete scope is allowed.
    if (this._allowIncompleteScope) {
      this.onLog(`Uncheckable spec warning: '${prdPath}' is a bare .md with no sibling spec.json; continuing because incomplete scope is allowed.`);
      return;
    }
    throw new UncheckableSpecError(prdPath);
  }

  /**
   * _startAgentTicker() — Start a 1-second interval that updates elapsed time
   * for all agents in statusBar.agents that have a startedAt property.
   *
   * No-op when statusBar.enabled is false or when already armed (idempotent).
   */
  _startAgentTicker() {
    if (!this.statusBar.enabled) return;
    if (this._agentElapsedInterval !== null) return;
    this._agentElapsedInterval = setInterval(() => {
      for (const [name, state] of this.statusBar.agents) {
        if (!state || state.startedAt == null) continue;
        const agentElapsed = Math.floor((Date.now() - state.startedAt) / 1000);
        this.statusBar.updateAgent(name, { ...state, elapsed: agentElapsed });
      }
    }, 1000);
  }

  /**
   * _stopAgentTicker() — Clear the agent elapsed interval.
   *
   * No-op if already null (idempotent).
   */
  _stopAgentTicker() {
    if (this._agentElapsedInterval === null) return;
    clearInterval(this._agentElapsedInterval);
    this._agentElapsedInterval = null;
  }

  /**
   * destroy() — Release all timers and teardown the status bar.
   *
   * Must be called on resize/teardown paths that do not go through the normal
   * run() / resume() / batchResume() finally blocks.  Safe to call multiple
   * times — all guards are null-checked before clearing.
   *
   * Specifically ensures `_msElapsedInterval` cannot leak when the pipeline is
   * discarded mid-milestone (e.g. during terminal resize teardown or in tests).
   */
  destroy() {
    if (this._msElapsedInterval !== null) {
      clearInterval(this._msElapsedInterval);
      this._msElapsedInterval = null;
    }
    this._stopAgentTicker();
    if (this.statusBar && typeof this.statusBar.destroy === 'function') {
      this.statusBar.destroy();
    }
  }

  /**
   * Read the spec file at specPath, replace the first occurrence of oldText
   * with newText, and write it back.
   *
   * Returns true if the replacement was made, false if oldText was not found
   * (and logs a warning).
   *
   * @param {string} specPath  Path to the spec file.
   * @param {string} oldText   Text to search for.
   * @param {string} newText   Replacement text.
   * @returns {boolean}
   */
  /**
   * Record reviewer warning/info findings into the persistent cross-run
   * ledger (archives/warnings.jsonl). Criticals are excluded — they have
   * their own remediation loop. Fail-soft by design: a ledger write error
   * is logged and never fails the run.
   *
   * Called ONLY from _renderReviewerDigest so the record point is
   * single-sourced: every digest call site (first review, re-review,
   * post-remediation re-review) records through this one path, and a new
   * digest call site can never silently skip recording.
   *
   * @param {string} msId
   * @param {{ findings?: Array<{ severity: string, category?: string, file?: string, description?: string }> }} reviewResult
   */
  _recordReviewerWarnings(msId, reviewResult) {
    try {
      const advisory = (reviewResult.findings || []).filter(
        (f) => f.severity === 'warning' || f.severity === 'info'
      );
      if (advisory.length === 0) return;
      appendWarnings(
        this.projectRoot,
        advisory.map((f) => ({
          milestone: msId,
          severity: f.severity,
          category: f.category,
          file: f.file,
          description: f.description,
        }))
      );
    } catch (err) {
      this.onLog(`  [WARN] warnings-ledger write failed (run continues): ${err.message}`);
    }
  }

  /**
   * Record plan-scope-mapping advisory warnings (surfaced by the planner's
   * checkScopeMappingConsistency check) into the persistent cross-run
   * ledger (archives/warnings.jsonl). Fail-soft by design: a ledger write
   * error is logged and never fails the run.
   *
   * @param {string} missionId
   * @param {Array<{ severity?: string, category?: string, description?: string }>} [warnings]
   */
  _recordScopeMappingWarnings(missionId, warnings) {
    try {
      if (!warnings || warnings.length === 0) return;
      appendWarnings(
        this.projectRoot,
        warnings.map((w) => ({
          milestone: missionId,
          severity: 'warning',
          category: w.category === 'cross-mission-duplicate' ? w.category : 'plan-scope',
          description: w.description,
        }))
      );
    } catch (err) {
      this.onLog(`  [WARN] warnings-ledger write failed (run continues): ${err.message}`);
    }
  }

  /**
   * Render a boxed digest of reviewer results via this.onLog().
   *
   * - FAILED (reviewResult.passed === false): box with all findings.
   * - PASSED with warnings: box with warning-severity findings only.
   * - Clean PASS (no findings or no warnings): single line.
   *
   * Finding descriptions are truncated to ~80 chars with '…'.
   *
   * Also records warning/info findings into the warnings ledger via
   * _recordReviewerWarnings — the digest is the single record point for
   * every reviewer findings set (including the never-archiving run() path).
   *
   * @param {string} msId
   * @param {{ passed: boolean, findings?: Array<{ severity: string, file: string, description: string }> }} reviewResult
   */
  _renderReviewerDigest(msId, reviewResult) {
    this._recordReviewerWarnings(msId, reviewResult);

    const MAX_DESC = 80;
    const truncate = (str) =>
      str && str.length > MAX_DESC ? str.slice(0, MAX_DESC) + '…' : (str || '');

    if (!reviewResult.passed) {
      // FAILED: render boxed digest for all findings
      const findings = reviewResult.findings || [];
      this.onLog(`┌─ Reviewer FAILED — milestone ${msId}`);
      for (const f of findings) {
        this.onLog(`│  [${f.severity}] ${f.file}: ${truncate(f.description)}`);
      }
      this.onLog(`└─ ${findings.length} finding(s)`);
    } else {
      // PASSED — surface warnings AND info findings (info is structured
      // advisory output added with the reviewer-enums widening; it must
      // be visible to humans reading the digest even though it does not
      // gate PASS/FAIL).
      const advisory = (reviewResult.findings || []).filter(
        (f) => f.severity === 'warning' || f.severity === 'info'
      );
      if (advisory.length > 0) {
        this.onLog(`┌─ Reviewer PASSED with findings — milestone ${msId}`);
        for (const f of advisory) {
          this.onLog(`│  [${f.severity}] ${f.file}: ${truncate(f.description)}`);
        }
        this.onLog(`└─ ${advisory.length} finding(s)`);
      } else {
        this.onLog(`Reviewer passed for milestone ${msId}.`);
      }
    }

    const scopeVerdict = reviewResult.structured?.scopeCompliance?.verdict;
    if (scopeVerdict === 'exceeded_scope') {
      this.onLog(`┌─ Scope WARN — milestone ${msId}`);
      this.onLog(`│  ` + (reviewResult.structured.scopeCompliance.evidence || ''));
      for (const file of (reviewResult.structured.scopeCompliance.exceededFiles || [])) {
        this.onLog(`│  exceeded: ` + file);
      }
      this.onLog(`└─ end scope`);
    } else if (scopeVerdict === 'insufficient_scope') {
      this.onLog(`[scope-info] milestone ${msId}: ` + (reviewResult.structured.scopeCompliance.evidence || ''));
    }
    // 'within_scope' or undefined/null: render nothing
  }

  _applySpecEdit(specPath, oldText, newText, options = {}) {
    return applySpecEdit(specPath, oldText, newText, options, this.onLog);
  }
}

const TERMINAL_STATUSES = new Set(['complete', 'invalidated', 'verified']);

/**
 * Asserts that all tasks across all missions in a milestone are in a terminal
 * status before allowing the milestone to advance.
 *
 * @param {string} harnessDir - path to the .harness directory
 * @param {string} msId - milestone ID being advanced
 * @param {object} msState - milestone state object with a `missions` map
 * @param {function} onLog - logging callback
 * @throws {PendingTasksAtMilestoneAdvance} if any non-terminal tasks are found
 */
export function assertNoNonTerminalTasks(harnessDir, msId, msState, onLog) {
  const nonTerminalIds = [];
  for (const miId of Object.keys(msState.missions || {})) {
    const stateFile = path.join(harnessDir, 'state', `mission-${miId}.json`);
    if (!fs.existsSync(stateFile)) continue;
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const sm of Object.values(state.subMissions || {})) {
      for (const task of Object.values(sm.tasks || {})) {
        if (!TERMINAL_STATUSES.has(task.status)) {
          nonTerminalIds.push(task.id);
        }
      }
    }
  }
  if (nonTerminalIds.length > 0) {
    const n = nonTerminalIds.length;
    const ids = nonTerminalIds.join(', ');
    onLog(`Invariant violation: ${n} non-terminal task(s) found before milestone ${msId} advance: ${ids}`);
    throw new PendingTasksAtMilestoneAdvance(msId, nonTerminalIds);
  }
}

export { Pipeline, HaltError, applySpecHardChecks };
