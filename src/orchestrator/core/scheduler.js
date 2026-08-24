/**
 * scheduler.js — Ready-queue scheduler for parallel task execution.
 *
 * Phase I items 4+5. Drives parallel task execution via a single
 * worker-pool scheduler that operates on the whole milestone's task
 * DAG, invoked from pipeline._executeMilestoneParallel.
 *
 * Algorithm:
 *
 *   1. Maintain a `pending` set of task IDs and a `workers` map from
 *      task ID to an in-flight promise.
 *   2. While either set is non-empty:
 *      a. Greedily assign as many pending tasks as slots allow, where
 *         "assignable" means: all hard dependencies are in a terminal
 *         state (complete/invalidated), AND the task's targetFiles do
 *         not overlap with any currently-running task's targetFiles.
 *      b. If no task is assignable and there are no workers running,
 *         first re-scan the task index for tasks whose fresh on-disk
 *         status is 'needs_revalidation' and re-enqueue any not already
 *         rescued in this milestone run; only if that scan yields
 *         nothing new do we have a genuine deadlock — throw.
 *      c. Wait for any worker to complete. When it does, drop it from
 *         the workers map and re-enter the loop.
 *
 * Concurrency safety depends on the step 2-4 mutex layer:
 *   - Every transitionX call inside runTask acquires the per-mission
 *     or global-state mutex; worker threads cannot race through the
 *     state machine.
 *   - TokenTracker.recordSession and Logger.writeSessionSummary serialize
 *     through their instance-local mutexes.
 *   - Snapshots rely on the scheduler's conflict check: tasks with
 *     overlapping targetFiles are NEVER concurrent, so snapshotFiles /
 *     restoreSnapshot cannot be racing on the same source file.
 *
 * Out of scope for this module:
 *   - Cross-milestone scheduling (milestone boundaries remain serial).
 *   - Dynamic maxConcurrent adjustment.
 *   - Work-stealing, speculative execution, ETA estimation.
 *   - The dashboard module (step 8) — this module emits progress
 *     events via an optional `onProgress` callback; the dashboard
 *     consumes them separately.
 *   - Sub-file conflict detection (Phase IV).
 *
 * Public API:
 *   class Scheduler {
 *     constructor({
 *       harnessDir, projectRoot, maxConcurrent,
 *       runTask,      // async (task) => void — lifts from pipeline
 *       onLog,        // optional, sync logging sink
 *       onProgress,   // optional, fires on every task state change
 *       statusBar,    // optional, accepted for back-compat but not stored
 *       tokenTracker, // optional, TokenTracker instance for session recording
 *     })
 *
 *     async runMilestone(milestoneId, taskDAG, opts = {})
 *       // taskDAG is a flat array of task objects; each carries
 *       // { id, missionId, subMissionId, targetFiles, dependencies,
 *       //   ... + all other task fields passed through to runTask }
 *       // opts.signal — optional AbortSignal; when aborted, the scheduler
 *       //   stops assigning new work and drains any in-flight workers.
 *
 *     async replaceTask(failedTaskId, replacementTasks)
 *       // Core DAG surgery method. Invalidates ONLY the failed task (its
 *       // transitive dependents are preserved, not invalidated), inserts
 *       // replacement tasks, and rewires any downstream dependency that
 *       // pointed at the failed task to the last replacement task.
 *       // Operates on this._tasksById and this._pending.
 *       // Returns { invalidated: [...ids], inserted: [...ids] }.
 *   }
 */
import fs from 'fs';
import path from 'path';
import { cascadeComplete, transitionTask } from './state-machine.js';
import { readTaskStatus, readState, writeJsonAtomic, writeVerifyJson, appendInvalidationRecord } from './state.js';
import { InfrastructureError } from '../infra/session-manager.js';
import { normalizeTargetFile } from './path-utils.js';
import { scopeSpecHardChecks, findOrphanedSpecHardChecks } from '../agents/planner.js';

/**
 * The replan cap's canonical key: strips all trailing replan-generation
 * suffixes (`-rp-NNN`, possibly stacked across generations) from a task id,
 * yielding the original task id the replan counter is keyed on.
 *
 * @param {string} id - Task id, possibly carrying one or more -rp-N suffixes.
 * @returns {string} The canonical (original) task id.
 */
export function canonicalTaskId(id) {
  return id.replace(/(-rp-\d+)+$/, '');
}

/**
 * Check whether a task's hard dependencies are satisfied by disk state.
 * A dependency is considered satisfied if its status on disk is
 * complete or invalidated. Pending, in_progress, failed, and blocked
 * are NOT satisfied. Reads each hard dependency's status from disk via
 * readTaskStatus.
 *
 * @param {string} harnessDir - Absolute path to the harness directory (state root).
 * @param {object} task - Task object whose `dependencies` array is checked.
 * @returns {boolean} True if every hard dependency is complete or invalidated on disk.
 */
function areDepsSatisfied(harnessDir, task) {
  const hardDeps = (task.dependencies || []).filter((d) => d.type === 'hard');
  for (const dep of hardDeps) {
    const status = readTaskStatus(harnessDir, dep.taskId);
    if (status !== 'complete' && status !== 'invalidated') {
      return false;
    }
  }
  return true;
}

/**
 * Check whether a task's targetFiles conflict with the union of files
 * currently locked by running tasks. Pure set-intersection on normalized
 * string paths; no glob expansion. If the planner starts emitting globs we
 * will revisit (see design doc §3.3.2).
 *
 * @param {object} task - Task object whose `targetFiles` array is checked.
 * @param {Set<string>} runningFiles - Set of normalized absolute file paths currently locked by in-flight tasks.
 * @param {string} projectRoot - Absolute path to the project root, used to normalize task.targetFiles for comparison.
 * @returns {boolean} True if any of task's targetFiles intersects runningFiles.
 */
function hasFileConflict(task, runningFiles, projectRoot) {
  for (const file of task.targetFiles || []) {
    if (runningFiles.has(normalizeTargetFile(projectRoot, file))) return true;
  }
  return false;
}

export class Scheduler {
  // ── Circuit-breaker constants ────────────────────────────────────────
  static INFRA_ERROR_THRESHOLD = 3;
  static INFRA_WINDOW_MS = 60000;
  static BACKOFF_SCHEDULE = [30000, 60000, 120000];

  // ── Replan constants ─────────────────────────────────────────────────
  static MAX_REPLAN_ATTEMPTS = 2;

  // ── Slow-failure infra cap ───────────────────────────────────────────
  // The sliding-window circuit breaker (INFRA_ERROR_THRESHOLD in
  // INFRA_WINDOW_MS) only trips on FAST failure bursts. A slow systemic
  // failure — e.g. an SDK transport that hangs ~14 minutes per attempt and
  // then times out — lands one infra error per window, never trips the
  // circuit, and re-enqueues the same task forever (observed live: 5 hours
  // of unattended retry). Consecutive infra errors on the SAME task are the
  // signature of an environment problem, not a transient blip: cap them.
  static MAX_TASK_INFRA_STREAK = 3;

  /**
   * Construct a Scheduler for a single milestone's task DAG. Validates its
   * required options and initializes the circuit-breaker, infra-streak, and
   * replan-attempt tracking state used by runMilestone/replaceTask.
   *
   * Non-obvious side effect: on construction, this reads state.json (via
   * readState) to hydrate this._replanAttempts from any previously-persisted
   * `scheduler.replanAttempts` map — this is what makes the replan cap
   * survive a process resume. If state.json is missing, unreadable, or
   * corrupt, hydration fails soft and this._replanAttempts starts empty.
   *
   * @param {object} options
   * @param {string} options.harnessDir - Absolute path to the harness directory (state root). Required.
   * @param {string} options.projectRoot - Absolute path to the project root, used to normalize targetFiles for conflict checks.
   * @param {number} options.maxConcurrent - Maximum number of tasks to run concurrently. Required; must be >= 1.
   * @param {Function} options.runTask - async (task) => void — invoked once per dispatched task; lifted from pipeline. Required.
   * @param {Function} [options.onLog] - Optional sync logging sink; defaults to a no-op.
   * @param {Function} [options.onProgress] - Optional callback fired on every task/milestone state change; defaults to a no-op.
   * @param {*} [options.statusBar] - Optional, accepted for backwards compatibility but intentionally not stored.
   * @param {object} [options.tokenTracker] - Optional TokenTracker instance for session recording; defaults to null.
   * @throws {Error} if harnessDir is falsy.
   * @throws {Error} if runTask is missing or not a function.
   * @throws {Error} if maxConcurrent is not a number >= 1.
   */
  constructor({
    harnessDir,
    projectRoot,
    maxConcurrent,
    runTask,
    onLog = () => {},
    onProgress = () => {},
    statusBar = null,
    tokenTracker = null,
  }) {
    if (!harnessDir) throw new Error('Scheduler: harnessDir is required');
    if (!runTask || typeof runTask !== 'function') {
      throw new Error('Scheduler: runTask callback is required');
    }
    if (typeof maxConcurrent !== 'number' || maxConcurrent < 1) {
      throw new Error(`Scheduler: maxConcurrent must be >= 1, got ${maxConcurrent}`);
    }

    this.harnessDir = harnessDir;
    this.projectRoot = projectRoot;
    this.maxConcurrent = maxConcurrent;
    this.runTask = runTask;
    this.onLog = onLog;
    this.onProgress = onProgress;
    // statusBar param accepted for backwards compatibility but intentionally not stored;
    // progress updates are written by pipeline._executeAndVerifyTask after task completion.
    this.tokenTracker = tokenTracker || null;

    // Circuit-breaker state
    this._infraErrors = [];   // timestamped ring: [{timestamp, err}, ...]
    this._circuitOpen = false;

    // Consecutive infra-error count per task (slow-failure cap); reset on
    // any non-infra completion of that task.
    this._taskInfraStreak = new Map();

    // Replan attempt tracking: canonical task id (see canonicalTaskId) →
    // number of replan attempts so far
    this._replanAttempts = new Map();
    // Hydrate _replanAttempts from persisted state.json (resume path)
    try {
      const state = readState(this.harnessDir);
      const persisted = state?.scheduler?.replanAttempts;
      if (persisted && typeof persisted === 'object') {
        for (const [canonicalId, attempts] of Object.entries(persisted)) {
          if (typeof attempts === 'number' && isFinite(attempts)) {
            this._replanAttempts.set(canonicalId, attempts);
          } else {
            this.onLog(`[Scheduler] Warning: skipping non-finite replanAttempts entry for task ${canonicalId}: ${JSON.stringify(attempts)}`);
          }
        }
      }
    } catch (err) {
      // state.json missing, unreadable, or corrupt — start fresh
      this._replanAttempts = new Map();
      if (err.code !== 'ENOENT') {
        // Missing state.json is the normal fresh/pre-claim case — stay silent.
        // Any other error (unreadable/corrupt state.json) still warns.
        this.onLog(`[Scheduler] Warning: could not hydrate replanAttempts from state.json: ${err.message}`);
      }
    }
  }

  /**
   * Drive the ready-queue scheduling loop for `taskDAG` to a terminal
   * state: greedily dispatch tasks whose hard dependencies are satisfied
   * and whose targetFiles do not conflict with any in-flight task, up to
   * `maxConcurrent` concurrent workers, re-filling slots as workers finish.
   *
   * Returns a Promise that resolves once every task in `taskDAG` has
   * reached a terminal status (complete / invalidated) on disk, or once
   * draining completes after an unrecoverable error. Tasks that are
   * already terminal on disk at call time (resume path) are skipped —
   * they are never added to the pending set.
   *
   * Non-obvious side effects:
   *   - Auto-advances any task found in the stranded `verified` state to
   *     `complete` on disk via transitionTask before scheduling begins
   *     (the verifier passed but the pipeline crashed before the disk
   *     transition landed); this runs under the state machine's
   *     per-mission-file mutex like any other transition.
   *   - Emits onProgress events for milestone/task lifecycle changes:
   *     'milestone-start', 'task-start', 'task-complete', 'task-fail',
   *     'infra-stall', and 'milestone-complete'.
   *   - Throws on: a genuine scheduling stall (tasks pending but none
   *     assignable) or a halt after a prior task failure with tasks still
   *     pending; circuit-breaker exhaustion (all backoff/probe rounds
   *     fail); or the slow-failure infra cap (MAX_TASK_INFRA_STREAK
   *     consecutive infra errors on the same task without tripping the
   *     fast-burst circuit).
   *   - At the stall boundary (nothing running, tasks still pending, no
   *     prior task failure), the scheduler re-reads each task's status
   *     from disk and re-adds any freshly-'needs_revalidation' task to
   *     the pending set for verifier-only re-dispatch; each rescued task
   *     id is logged once at the moment it is rescued. The rescue set
   *     (which ids have already been rescued) is reset at the start of
   *     every runMilestone invocation. The rescue is bounded: a repeat
   *     stall where the re-scan finds no newly-rescuable task falls
   *     through to the unchanged 'Scheduler stall' throw below.
   *
   * @param {string} milestoneId - Identifier of the milestone being executed; passed through to onProgress events.
   * @param {object[]} taskDAG - Flat array of task objects, each carrying { id, missionId, subMissionId, targetFiles, dependencies, ... }.
   * @param {object} [opts={}]
   * @param {AbortSignal} [opts.signal] - Optional AbortSignal; when aborted, the scheduler stops assigning new work and drains in-flight workers before returning.
   * @returns {Promise<void>} Resolves when every task in taskDAG has reached a terminal state.
   * @throws {Error} on a scheduling stall — either an unmet-dependency deadlock or a halt triggered by a prior task failure. The genuine-stall throw only fires after the stall-boundary needs_revalidation rescue scan finds nothing new to re-enqueue.
   * @throws {InfrastructureError} when the circuit breaker exhausts all backoff rounds, or the slow-failure infra streak cap is hit.
   */
  async runMilestone(milestoneId, taskDAG, opts = {}) {
    const signal = opts.signal ?? null;
    // Build the index and the initial pending set. Tasks that are
    // already terminal on disk are skipped — this is the resume path.
    //
    // Crash recovery for the `verified → complete` seam: a task in
    // `verified` state means the verifier passed but the pipeline
    // crashed before transitionTask('complete') landed. We finalize
    // it here under the per-mission-file mutex so the resume path
    // doesn't get stuck trying to re-run a task whose work is already
    // verified-good on disk. Classified as pre-terminal after the
    // transition so the scheduler skips it.
    this._tasksById = new Map();
    this._pending = new Set();
    this._runningFiles = new Set();
    const tasksById = this._tasksById;
    const pending = this._pending;
    const total = taskDAG.length;
    const preTerminal = [];

    for (const task of taskDAG) {
      tasksById.set(task.id, task);
      const status = readTaskStatus(this.harnessDir, task.id);
      if (status === 'complete' || status === 'invalidated') {
        preTerminal.push(task.id);
      } else if (status === 'verified') {
        // Auto-advance stranded verified tasks. This goes through
        // the state-machine's per-mission-file mutex like every other
        // transition, so a concurrent caller (shouldn't happen during
        // startup, but defensive) is safely serialized.
        await transitionTask(this.harnessDir, task.id, 'complete');
        preTerminal.push(task.id);
      } else if (status === 'needs_revalidation') {
        this.onLog(`  Scheduler: task ${task.id} needs revalidation — dispatching for verifier-only`);
        pending.add(task.id);
      } else {
        pending.add(task.id);
      }
    }

    if (preTerminal.length > 0) {
      this.onLog(`  Scheduler: ${preTerminal.length} task(s) already terminal — resuming remainder (${pending.size} pending)`);
    } else {
      this.onLog(`  Scheduler: starting milestone ${milestoneId} with ${pending.size} task(s), maxConcurrent=${this.maxConcurrent}`);
    }

    // Emit an initial progress snapshot so dashboards can render the
    // starting state before any worker fires.
    this.onProgress({
      type: 'milestone-start',
      milestoneId,
      total: taskDAG.length,
      pending: pending.size,
      preTerminal: preTerminal.length,
    });

    // workers maps taskId → a promise that settles to {id, error?} once
    // the worker finishes. Using a map so we can look up the task for
    // each finished worker without scanning.
    const workers = new Map();

    // Running files union — updated as workers start/finish. The
    // scheduler owns this cache so the conflict check stays O(files)
    // per candidate instead of O(running × files-per-task).
    // _runningFiles was initialised to an empty Set above; alias it here.
    const runningFiles = this._runningFiles;

    // First error encountered from a worker, if any. We drain the
    // remaining workers before propagating it so we don't leave
    // orphaned in-flight SDK sessions.
    let firstError = null;

    // Captured task identity of whichever task produced firstError. Used by
    // the stall-throw site to surface accurate diagnostics ("milestone halted
    // by task X failure") instead of the misleading "unmet dependencies"
    // framing. Reset per runMilestone call (Scheduler instance is reused).
    this._firstFailedTaskId = null;
    this._firstFailedTaskDescription = null;
    // Stall-boundary rescue: task ids already re-dispatched for
    // verifier-only revalidation from a prior stall boundary within THIS
    // runMilestone call. Reset per runMilestone call (Scheduler instance
    // is reused across milestones) so a task rescued in a previous
    // milestone can be rescued again.
    this._rescuedRevalIds = new Set();

    const raceNextFinishedWorker = () => {
      // Race all current worker promises. The first to settle wins.
      return Promise.race(Array.from(workers.values()));
    };

    while (pending.size > 0 || workers.size > 0) {
      if (signal?.aborted) { this.onLog('Scheduler: abort signal received — draining workers'); break; }
      // Assignment pass: try to fill every available slot.
      let assignedThisPass = 0;
      while (workers.size < this.maxConcurrent && pending.size > 0 && !firstError && !this._circuitOpen) {
        const nextTask = this._pickAssignableTask(pending, tasksById, workers, runningFiles);
        if (!nextTask) break;  // no ready task right now

        // Remove from pending, register as worker, update running files.
        pending.delete(nextTask.id);
        for (const f of nextTask.targetFiles || []) runningFiles.add(normalizeTargetFile(this.projectRoot, f));
        assignedThisPass++;

        this.onLog(`    Scheduler: dispatching ${nextTask.id} (${workers.size + 1}/${this.maxConcurrent} slot(s) in use)`);
        this.onProgress({
          type: 'task-start',
          taskId: nextTask.id,
          missionId: nextTask.missionId,
          subMissionId: nextTask.subMissionId,
          description: nextTask.description,
          running: workers.size + 1,
          pending: pending.size,
        });
        const workerPromise = this._runOne(nextTask).then(
          () => ({ id: nextTask.id }),
          (error) => ({ id: nextTask.id, error })
        );
        workers.set(nextTask.id, workerPromise);
      }

      // Stall detection: nothing running, nothing assignable, tasks
      // still pending → we're stuck. This usually means an unmet
      // dependency (dep task is in failed/blocked state that never
      // transitions to terminal), or a file conflict that can't
      // resolve (shouldn't happen — running tasks eventually finish).
      if (workers.size === 0) {
        if (pending.size > 0) {
          const stalled = Array.from(pending);

          if (firstError) {
            // Halt path: a non-infra task failure set firstError; the
            // !firstError gate at the top of the assignment loop blocked
            // dispatch of all pending tasks (regardless of whether their
            // dependencies were satisfied). The previous message framed
            // this as "unmet dependencies" — misleading. Surface the actual
            // cause: which task failed, why, and what was blocked.
            const failedDesc = this._firstFailedTaskDescription
              ? ` ("${this._firstFailedTaskDescription}")`
              : '';
            const pendingPreview = stalled.slice(0, 10).join(', ') +
              (stalled.length > 10 ? ` (+${stalled.length - 10} more)` : '');
            // w4-batch-failure-input-boundary Fix #2: the stall throw must NOT
            // strip the type of the stalling failure. When a breaker fires while
            // any other task is still pending (the common case — dependents
            // always remain pending), the drain ends here; a fresh generic Error
            // with NO cause would land the escalation as failed-execution with no
            // park scene (the headline halted-analyzer routing only worked when
            // the breaker fired on the last remaining task). Preserve the original
            // error as `cause` so the batch catch can resolve the
            // CircuitBreakerError via err.cause. The message and the throw's
            // constructor (plain Error) are unchanged — only `cause` is added.
            throw new Error(
              `Milestone halted: task ${this._firstFailedTaskId}${failedDesc} failed: ${firstError.message}. ` +
              `${stalled.length} task(s) were pending and not dispatched: ${pendingPreview}.`,
              { cause: firstError }
            );
          }

          // Stall-boundary rescue: before concluding this is a genuine dep
          // stall, re-scan every task's CURRENT on-disk status (never the
          // preTerminal/build-time classification computed during the DAG
          // build above) for any task that has since flipped to
          // 'needs_revalidation' — e.g. a hard dependency invalidated by a
          // downstream cascade after the DAG-build scan ran. Such a task is
          // not in `pending` (it was classified pre-terminal or otherwise
          // skipped at build time) and would otherwise cause a spurious
          // stall throw even though it just needs a verifier-only rerun.
          const rescued = [];
          for (const id of tasksById.keys()) {
            if (pending.has(id) || this._rescuedRevalIds.has(id)) continue;
            const freshStatus = readTaskStatus(this.harnessDir, id);
            if (freshStatus === 'needs_revalidation') {
              rescued.push(id);
            }
          }

          if (rescued.length > 0) {
            for (const id of rescued) {
              pending.add(id);
              this._rescuedRevalIds.add(id);
              this.onLog(`    Scheduler: rescuing task ${id} at stall boundary — needs revalidation, re-dispatching for verifier-only`);
            }
            continue;
          }

          // Genuine dep stall (no prior task failure): keep original framing.
          throw new Error(
            `Scheduler stall: ${stalled.length} task(s) pending but none assignable. ` +
            `Likely unmet dependencies on a failed/blocked task. Pending: ${stalled.slice(0, 5).join(', ')}` +
            (stalled.length > 5 ? ` (+${stalled.length - 5} more)` : '')
          );
        }
        break;  // all done
      }

      // Wait for any worker to finish.
      const finished = await raceNextFinishedWorker();
      workers.delete(finished.id);

      // Release the finished task's files from runningFiles.
      const finishedTask = tasksById.get(finished.id);
      for (const f of finishedTask.targetFiles || []) runningFiles.delete(normalizeTargetFile(this.projectRoot, f));

      if (finished.error) {
        const err = finished.error;
        this.onLog(`    Scheduler: task ${finished.id} threw: ${err.message}`);

        if (this._isInfraError(err)) {
          // Retryable infrastructure error: re-enqueue the task without
          // marking it failed. The task's files were already released from
          // runningFiles above, so just put the task ID back in pending.
          const streak = (this._taskInfraStreak.get(finished.id) ?? 0) + 1;
          this._taskInfraStreak.set(finished.id, streak);
          this._recordInfraError(err);
          this.onLog(`    Scheduler: task ${finished.id} infra error (retryable) — re-enqueuing (consecutive: ${streak}/${Scheduler.MAX_TASK_INFRA_STREAK})`);
          pending.add(finished.id);

          if (this._isCircuitTripped()) {
            // Too many infra errors in the sliding window: pause new
            // assignments and attempt probe-based backoff recovery.
            this._circuitOpen = true;
            this.onLog(`    Scheduler: circuit tripped — entering backoff (${Scheduler.BACKOFF_SCHEDULE.length} rounds)`);

            let probeSucceeded = false;
            for (const delay of Scheduler.BACKOFF_SCHEDULE) {
              this.onLog(`    Scheduler: backoff — sleeping ${delay}ms before probe`);
              await new Promise((resolve) => setTimeout(resolve, delay));

              // Attempt one probe dispatch from the pending set.
              const probeTask = this._pickAssignableTask(pending, tasksById, workers, runningFiles);
              if (!probeTask) {
                this.onLog(`    Scheduler: probe — no assignable task available, continuing backoff`);
                continue;
              }

              // Dispatch the probe task inline (not tracked in workers map).
              pending.delete(probeTask.id);
              for (const f of probeTask.targetFiles || []) runningFiles.add(normalizeTargetFile(this.projectRoot, f));
              this.onLog(`    Scheduler: probe dispatching ${probeTask.id}`);

              let probeError = null;
              try {
                await this._runOne(probeTask);
              } catch (probeErr) {
                probeError = probeErr;
              }

              // Release probe task files regardless of outcome.
              for (const f of probeTask.targetFiles || []) runningFiles.delete(normalizeTargetFile(this.projectRoot, f));

              if (!probeError) {
                // Probe succeeded: reset circuit breaker and resume.
                this._resetInfraErrors();
                this._taskInfraStreak.delete(probeTask.id);
                this.onLog(`    Scheduler: probe succeeded — circuit reset, resuming normal scheduling`);
                this.onProgress({
                  type: 'task-complete',
                  taskId: probeTask.id,
                  missionId: probeTask.missionId,
                  subMissionId: probeTask.subMissionId,
                  running: workers.size,
                  pending: pending.size,
                });
                // Attempt cascade from probe task completion.
                try {
                  const cascade = await cascadeComplete(this.harnessDir, {
                    missionId: probeTask.missionId,
                    subMissionId: probeTask.subMissionId,
                  });
                  if (cascade.subMission === 'cascaded') {
                    this.onLog(`    Scheduler: sub-mission ${probeTask.subMissionId} → complete`);
                  }
                  if (cascade.mission === 'cascaded') {
                    this.onLog(`    Scheduler: mission ${probeTask.missionId} → complete`);
                  }
                } catch (cascadeErr) {
                  this.onLog(`    Scheduler: cascade after probe ${probeTask.id} threw: ${cascadeErr.message}`);
                  if (!firstError) {
                    firstError = cascadeErr;
                    this._firstFailedTaskId = probeTask.id;
                    this._firstFailedTaskDescription = (probeTask.description || '').slice(0, 80);
                  }
                }
                probeSucceeded = true;
                break;
              } else {
                // Probe failed: log and try the next backoff round.
                this.onLog(`    Scheduler: probe failed (${probeTask.id}): ${probeError.message}`);
                // Re-enqueue probe task so it can be retried later.
                pending.add(probeTask.id);
              }
            }

            if (!probeSucceeded) {
              // All backoff rounds exhausted — emit infra-stall and throw.
              this.onProgress({
                type: 'infra-stall',
                taskId: finished.id,
                error: err.message,
              });
              const stallErr = new InfrastructureError(
                `Infra stall: circuit breaker exhausted all ${Scheduler.BACKOFF_SCHEDULE.length} backoff rounds. ` +
                `Last error: ${err.message}`,
                err
              );
              throw stallErr;
            }
          } else if (streak >= Scheduler.MAX_TASK_INFRA_STREAK) {
            // Slow-failure cap: the sliding-window circuit above only trips
            // on FAST bursts (>= INFRA_ERROR_THRESHOLD within
            // INFRA_WINDOW_MS). A slow systemic failure — e.g. an SDK
            // transport hanging ~14 minutes per attempt before timing out —
            // lands one error per window, never trips the circuit, and
            // would re-enqueue the same task forever (observed live: 5
            // unattended hours). Consecutive infra errors on the SAME task
            // are the signature of a down environment, not a transient
            // blip: ride the existing resumable-halt path so state is
            // saved and the run exits until the environment recovers.
            this.onProgress({ type: 'infra-stall', taskId: finished.id, error: err.message });
            throw new InfrastructureError(
              `Infra stall: task ${finished.id} hit ${streak} consecutive infrastructure errors ` +
              `(slow-failure cap ${Scheduler.MAX_TASK_INFRA_STREAK}) without tripping the fast-burst circuit. ` +
              `The environment is likely down; resume once it recovers. Last error: ${err.message}`,
              err
            );
          }

          // Either circuit was not tripped, or it was tripped and recovered.
          // Continue the outer scheduling loop.
          continue;
        }

        // Non-retryable or non-infrastructure error: follow existing firstError path.
        // A non-infra failure means the environment answered — break the streak.
        this._taskInfraStreak.delete(finished.id);
        this.onProgress({
          type: 'task-fail',
          taskId: finished.id,
          missionId: finishedTask.missionId,
          error: err.message,
          running: workers.size,
          pending: pending.size,
        });
        // Record and drain. We don't assign new tasks after an error
        // but we do let in-flight workers finish cleanly so their state
        // is consistent on disk.
        if (!firstError) {
          firstError = err;
          this._firstFailedTaskId = finishedTask.id;
          this._firstFailedTaskDescription = (finishedTask.description || '').slice(0, 80);
        }
        continue;
      }

      this.onLog(`    Scheduler: task ${finished.id} complete`);
      this._resetInfraErrors();
      this._taskInfraStreak.delete(finished.id);
      this.onProgress({
        type: 'task-complete',
        taskId: finished.id,
        missionId: finishedTask.missionId,
        subMissionId: finishedTask.subMissionId,
        running: workers.size,
        pending: pending.size,
      });
      // Attempt cascade from the finished task's sub-mission. This is
      // idempotent (audit finding 6); two workers completing the last
      // two tasks in a sub-mission both safely attempt the cascade.
      try {
        const cascade = await cascadeComplete(this.harnessDir, {
          missionId: finishedTask.missionId,
          subMissionId: finishedTask.subMissionId,
        });
        if (cascade.subMission === 'cascaded') {
          this.onLog(`    Scheduler: sub-mission ${finishedTask.subMissionId} → complete`);
        }
        if (cascade.mission === 'cascaded') {
          this.onLog(`    Scheduler: mission ${finishedTask.missionId} → complete`);
        }

      } catch (cascadeErr) {
        // Cascade failures on non-gate issues are real errors — don't
        // swallow them. Gate-related rejections ("not terminal",
        // "Illegal") are already swallowed inside cascadeComplete.
        this.onLog(`    Scheduler: cascade after ${finished.id} threw: ${cascadeErr.message}`);
        if (!firstError) {
          firstError = cascadeErr;
          this._firstFailedTaskId = finishedTask.id;
          this._firstFailedTaskDescription = (finishedTask.description || '').slice(0, 80);
        }
      }
    }

    this.onProgress({
      type: 'milestone-complete',
      milestoneId,
      total: taskDAG.length,
      errored: firstError ? 1 : 0,
    });

    if (firstError) throw firstError;
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * Scan the pending set and return the first task whose dependencies
   * are satisfied AND whose targetFiles do not conflict with the
   * running set. Returns the first assignable task object, or null if
   * no task is assignable right now. Pure lookup: reads disk state via
   * areDepsSatisfied but does not mutate `pending`, `tasksById`,
   * `workers`, `runningFiles`, or any instance state.
   *
   * Linear scan; for our target sizes (<100 pending tasks) this is
   * cheap. If it becomes a hotspot we can index tasks by dependency
   * fan-in and only re-check the ones whose last blocker just
   * resolved.
   *
   * @param {Set<string>} pending - Set of task IDs not yet dispatched.
   * @param {Map<string,object>} tasksById - Full task index for the DAG.
   * @param {Map<string,Promise>} workers - Map of taskId → in-flight worker promise for currently-running tasks (accepted for signature symmetry with the caller's loop; not read directly in this method's body).
   * @param {Set<string>} runningFiles - Set of normalized file paths currently locked by in-flight tasks.
   * @returns {object|null} The first assignable task, or null if none is assignable right now.
   */
  _pickAssignableTask(pending, tasksById, workers, runningFiles) {
    for (const taskId of pending) {
      const task = tasksById.get(taskId);
      if (!task) continue;  // shouldn't happen — defensive

      // Dependency check: deps must all be terminal on disk. In-flight
      // workers (tracked in the caller's workers map) are NOT terminal —
      // their taskIDs are absent from disk-state complete/invalidated
      // until they finish and transitionTask → complete lands.
      if (!areDepsSatisfied(this.harnessDir, task)) continue;

      // File-conflict check against the union of files from all
      // currently-running tasks.
      if (hasFileConflict(task, runningFiles, this.projectRoot)) continue;

      return task;
    }
    return null;
  }

  /**
   * Invoke the user-supplied runTask callback for a single task and await
   * its completion. This method performs no error handling of its own: if
   * runTask rejects, the rejection propagates out of the returned promise
   * unchanged. The caller (runMilestone) wraps each call in a
   * `.then(onFulfilled, onRejected)` to convert the outcome into the
   * `{ id, error? }` settled shape before storing it in the workers map —
   * that conversion happens at the call site, not inside this method.
   *
   * @param {object} task - Task object to execute; passed through to runTask.
   * @returns {Promise<void>} Resolves when runTask completes; rejects with runTask's error if it throws.
   */
  async _runOne(task) {
    await this.runTask(task);
  }

  // ── Circuit-breaker helpers ──────────────────────────────────────────

  /**
   * Returns true iff `err` is a retryable InfrastructureError.
   * Only errors that are both infra-classified AND retryable should
   * count toward the circuit-breaker threshold. Pure predicate — no
   * side effects; does not touch _infraErrors or _circuitOpen.
   *
   * @param {Error} err
   * @returns {boolean} True iff err is an InfrastructureError with retryable === true.
   */
  _isInfraError(err) {
    return err instanceof InfrastructureError && err.retryable === true;
  }

  /**
   * Record an infra error with the current timestamp, then prune
   * entries older than INFRA_WINDOW_MS so the ring stays bounded.
   * Side effect: pushes a new `{ timestamp, err }` entry onto
   * `this._infraErrors` and then reassigns `this._infraErrors` to the
   * filtered (pruned) array. Does not return a value.
   *
   * @param {InfrastructureError} err
   * @returns {void}
   */
  _recordInfraError(err) {
    const now = Date.now();
    this._infraErrors.push({ timestamp: now, err });
    // Prune entries outside the sliding window
    const cutoff = now - Scheduler.INFRA_WINDOW_MS;
    this._infraErrors = this._infraErrors.filter((e) => e.timestamp > cutoff);
  }

  /**
   * Returns true when the number of infra errors recorded within the
   * current window meets or exceeds INFRA_ERROR_THRESHOLD.
   * Side effect: prunes stale entries from `this._infraErrors` (reassigns
   * it to the filtered array) before counting, so the window is always
   * evaluated against wall-clock time at the moment of the call.
   *
   * @returns {boolean} True iff the pruned `this._infraErrors` count is >= Scheduler.INFRA_ERROR_THRESHOLD.
   */
  _isCircuitTripped() {
    const now = Date.now();
    const cutoff = now - Scheduler.INFRA_WINDOW_MS;
    this._infraErrors = this._infraErrors.filter((e) => e.timestamp > cutoff);
    return this._infraErrors.length >= Scheduler.INFRA_ERROR_THRESHOLD;
  }

  /**
   * Reset the circuit breaker to its healthy initial state.
   * Called on every successful task completion so that transient infra
   * errors do not accumulate across an otherwise-healthy run.
   * Side effect: clears `this._infraErrors` (to an empty array) and
   * `this._circuitOpen` (to false). Does not return a value.
   *
   * @returns {void}
   */
  _resetInfraErrors() {
    this._infraErrors = [];
    this._circuitOpen = false;
  }

  // ── DAG helper methods ───────────────────────────────────────────────

  /**
   * Return the Set of all task IDs that transitively depend on `taskId`.
   * Uses BFS over the reverse dependency graph: for each task in
   * `tasksById` we check whether its `dependencies` array mentions the
   * current frontier node, then expand outward.
   *
   * @param {string} taskId        - The task whose dependents we seek.
   * @param {Map<string,object>} tasksById - Full task index for the DAG.
   * @returns {Set<string>}        - All transitive dependent task IDs (excluding taskId itself).
   */
  _findDependents(taskId, tasksById) {
    const dependents = new Set();
    const queue = [taskId];

    while (queue.length > 0) {
      const current = queue.shift();
      for (const [id, task] of tasksById) {
        if (dependents.has(id) || id === taskId) continue;
        const deps = task.dependencies || [];
        const dependsOnCurrent = deps.some((d) => d.taskId === current);
        if (dependsOnCurrent) {
          dependents.add(id);
          queue.push(id);
        }
      }
    }

    return dependents;
  }

  /**
   * Validate that every targetFile in every replacement task is contained
   * within the union of targetFiles across the entire sub-mission scope.
   * Throws if any replacement task introduces a file that was not owned
   * by any task in the sub-mission. Does not return a value — success is
   * signaled by returning normally (undefined); failure is signaled by
   * throwing rather than returning a falsy result.
   *
   * @param {object[]} replacementTasks  - Array of new task objects.
   * @param {Set<string>} subMissionFiles - Union of all targetFiles for the sub-mission.
   * @returns {void}
   * @throws {Error} if any replacement task references a file outside the sub-mission's targetFiles.
   */
  _validateTargetFilesSubset(replacementTasks, subMissionFiles) {
    for (const rt of replacementTasks) {
      for (const file of rt.targetFiles || []) {
        if (!subMissionFiles.has(file)) {
          throw new Error(
            `_validateTargetFilesSubset: replacement task "${rt.id}" references file ` +
            `"${file}" which is not in any task's targetFiles within the sub-mission.`
          );
        }
      }
    }
  }

  /**
   * Core DAG surgery method. Invalidates ONLY `failedTaskId` (its
   * transitive dependents are preserved, not invalidated), inserts
   * `replacementTasks` into the live DAG, and rewires any downstream task
   * that had a dependency on the failed task so it now depends on the
   * last replacement task.
   *
   * Non-obvious side effects (this method is not pure / in-memory only):
   *   - Persists the incremented replan counter to state.json
   *     (state.scheduler.replanAttempts) via writeJsonAtomic (step 2b).
   *   - Transitions `failedTaskId` to 'invalidated' on disk via
   *     transitionTask (step 6) — this is durable and is NOT undone by the
   *     step-10 rollback.
   *   - Persists each replacement task into its mission-<missionId>.json
   *     state file (subMissions[subMissionId].tasks[id]) via
   *     writeJsonAtomic, and writes its verify sidecar via writeVerifyJson
   *     (step 8b).
   *   - Returns { invalidated: string[], inserted: string[] } (step 11).
   *
   * Transactional invariant — validate-then-mutate contract:
   *   All pre-condition checks (targetFiles subset validation, step 5) MUST
   *   complete successfully before any disk or in-memory state is mutated
   *   (steps 6+). This guarantees that a constraint violation leaves the
   *   scheduler DAG and on-disk task state untouched, preserving
   *   recoverability without requiring rollback for pre-condition failures.
   *   Post-mutation failures (steps 6–9) cannot be fully rolled back
   *   (disk invalidations are durable); see rollback/escalation markers
   *   at the relevant sites below.
   *
   * Steps:
   *  1. Guard: throw if replan cap exceeded for the original task ID.
   *  2. Increment replan counter for the canonical (non-suffixed) ID.
   *  2b. Persist the updated replan counters to state.json
   *     (state.scheduler.replanAttempts) via writeJsonAtomic.
   *  3. Look up failedTask in tasksById; throw if not found.
   *  4. BFS over the reverse DAG to collect transitive dependents
   *     (informational only — logged, but preserved and rewired rather
   *     than invalidated).
   *  5. Validate that every replacement task's targetFiles ⊆ original
   *     sub-mission scope  ← pre-mutation; safe to throw, no side-effects.
   *  6. transitionTask → 'invalidated' for failedTaskId ONLY (transitive
   *     dependents are NOT invalidated).
   *  7. Remove only failedTaskId from `pending` (dependents are preserved
   *     in `pending` and rewired in step 9).
   *  7c. De-duplicate replacementTasks by (description, sorted
   *     targetFiles): keep the first occurrence of each unique key, drop
   *     the rest, and rewrite intra-batch dependency references from a
   *     dropped id to the kept id.
   *  7d. Normalize replacement ids that canonicalize to a different family
   *     than failedTaskId, or that collide with an existing tasksById
   *     entry or another id still standing in this batch: rename to
   *     `${failedTaskId}-rp-NNN` (collision-free) and rewrite intra-batch
   *     dependency references accordingly.
   *  7d2. Strip any replacement dependency whose taskId is neither in
   *     tasksById nor in this batch, logging a warning instead of
   *     throwing (an unsatisfiable dep would otherwise stall the
   *     scheduler).
   *  7e. Re-home the failed task's spec hardChecks (verify sidecar ∪
   *     in-memory, de-duplicated by command) onto matching replacements
   *     via scopeSpecHardChecks; un-re-homed path-bearing checks log a
   *     warning (the last-milestone drain delivers the verdict).
   *  8. Insert replacement tasks into tasksById; add to pending.
   *  8b. Persist each replacement task into its mission state file
   *     (mission-<missionId>.json, subMissions[subMissionId].tasks[id])
   *     via writeJsonAtomic, and write its verify sidecar via
   *     writeVerifyJson; skipped for tasks missing missionId/subMissionId
   *     or whose mission state file does not exist on disk.
   *  9. Rewire: tasks that previously depended on failedTaskId now depend
   *     on the last (kept) replacement task, and are re-added to pending.
   * 10. Validate acyclicity; on failure, roll back: delete the rolled-back
   *     replacements' step-8b on-disk artifacts (mission-state task
   *     entries and verify sidecars), remove the insertions from
   *     tasksById/pending, restore the invalidated task objects in
   *     tasksById (they remain invalidated on disk — this is a noted
   *     edge case), restore rewired dependents' dependencies from the
   *     pre-rewire snapshot, and restore their exact pre-step-9 pending
   *     membership — then re-throw.
   * 11. Log completion, best-effort attempt a cascadeComplete check for
   *     the sub-mission/mission (failures are logged, not thrown), and
   *     return { invalidated: [...ids], inserted: [...ids] }.
   *
   * @param {string}   failedTaskId      - ID of the task being replaced.
   * @param {object[]} replacementTasks  - New task objects to insert.
   * @returns {{ invalidated: string[], inserted: string[] }}
   */
  async replaceTask(failedTaskId, replacementTasks) {
    const tasksById = this._tasksById;
    const pending = this._pending;
    // ── Step 1: Guard — check replan cap ─────────────────────────────
    // Derive the canonical (original) task ID by stripping any -rp-NNN suffix.
    const originalId = canonicalTaskId(failedTaskId);
    const currentAttempts = this._replanAttempts.get(originalId) ?? 0;

    if (currentAttempts >= Scheduler.MAX_REPLAN_ATTEMPTS) {
      throw new Error(
        `replaceTask: replan cap exceeded for task "${originalId}" ` +
        `(${currentAttempts}/${Scheduler.MAX_REPLAN_ATTEMPTS} attempts used).`
      );
    }

    // ── Step 2: Increment replan counter ─────────────────────────────
    this._replanAttempts.set(originalId, currentAttempts + 1);
    this.onLog(
      `  Scheduler.replaceTask: replan attempt ${currentAttempts + 1}/${Scheduler.MAX_REPLAN_ATTEMPTS} ` +
      `for original task "${originalId}" (failed: "${failedTaskId}")`
    );

    // ── Step 2b: Persist replanAttempts to state.json ─────────────────
    {
      const stateJsonPath = path.join(this.harnessDir, 'state.json');
      const state = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
      state.scheduler = state.scheduler || {};
      state.scheduler.replanAttempts = Object.fromEntries(this._replanAttempts);
      writeJsonAtomic(stateJsonPath, state);
    }

    // ── Step 3: Look up failed task ───────────────────────────────────
    const failedTask = tasksById.get(failedTaskId);
    if (!failedTask) {
      throw new Error(
        `replaceTask: task "${failedTaskId}" not found in tasksById.`
      );
    }

    // ── Step 4: Find transitive dependents (informational only) ──────
    const dependentIds = this._findDependents(failedTaskId, tasksById);
    this.onLog(
      `  Scheduler.replaceTask: found ${dependentIds.size} transitive dependent(s) of "${failedTaskId}": ` +
      `[${[...dependentIds].join(', ')}] (dependents are preserved and rewired, not invalidated)`
    );

    // ── Step 5: Validate targetFiles subset constraint ────────────────
    // PRE-MUTATION — runs before any disk or in-memory state is changed so
    // that a constraint violation leaves the failed task's on-disk status
    // untouched (validate-then-mutate contract; see function-level comment).
    // Build the union of all targetFiles for every task in the same
    // sub-mission as the failed task, so replacement tasks can reference
    // any file owned by any sibling task within the sub-mission.
    const subMissionFiles = new Set();
    for (const [, task] of tasksById) {
      if (task.subMissionId === failedTask.subMissionId) {
        for (const f of task.targetFiles || []) {
          subMissionFiles.add(f);
        }
      }
    }
    try {
      this._validateTargetFilesSubset(replacementTasks, subMissionFiles);
    } catch (subsetErr) {
      this.onLog(`  Scheduler.replaceTask: targetFiles subset violation — ${subsetErr.message}`);
      throw subsetErr;
    }

    // ── Step 6: Invalidate failed task only (not transitive dependents) ─
    // POST-MUTATION START — failures from here onward cannot be fully rolled
    // back because disk transitions are durable. Callers should treat any
    // error thrown after this point as requiring manual escalation or a
    // subsequent replaceTask call to bring the DAG back to a consistent
    // state. (The acyclicity check at step 10 is the exception: it rolls
    // back the in-memory insertions, but the disk invalidations stand.)
    // w4-state-resume-persistence Fix #4 rider: a post-8b acyclicity rollback
    // now ALSO removes the rolled-back replacements' step-8b on-disk artifacts
    // (their mission-state task entries and verify sidecars), so a rolled-back
    // replacement cannot influence the coverage drain or a later resume.
    const invalidatedIds = [failedTaskId];
    // Snapshot the task objects before mutation for rollback purposes.
    const snapshotById = new Map();
    for (const id of invalidatedIds) {
      snapshotById.set(id, tasksById.get(id));
    }

    for (const id of invalidatedIds) {
      await transitionTask(this.harnessDir, id, 'invalidated', { invalidationReason: 'replaced' });
      appendInvalidationRecord(
        this.harnessDir,
        {
          taskId: id,
          reason: 'replaced',
          site: 'replaceTask',
          detail: `replaced by [${replacementTasks.map((rt) => rt.id).join(', ')}]`,
        },
        { onLog: this.onLog }
      );
      this.onLog(`  Scheduler.replaceTask: transitioned "${id}" → invalidated`);
    }

    // ── Step 7: Remove only failedTaskId from pending ─────────────────
    // Downstream dependents are preserved in pending and will be rewired
    // in step 9 to point to the last replacement task.
    pending.delete(failedTaskId);

    // ── Step 7c: De-duplicate replacement tasks ───────────────────────
    // Build a map keyed by (description, sorted targetFiles) to detect
    // tasks that are functionally identical. Keep the first occurrence of
    // each unique key; map every subsequent (dropped) ID → the kept ID so
    // that dependency references can be rewritten before insertion.
    {
      const dedupMap = new Map();      // key → first rt
      const droppedToKept = new Map(); // droppedId → keptId

      for (const rt of replacementTasks) {
        const key = JSON.stringify([rt.description, [...(rt.targetFiles || [])].sort()]);
        if (dedupMap.has(key)) {
          const kept = dedupMap.get(key);
          droppedToKept.set(rt.id, kept.id);
          this.onLog(
            `  Scheduler.replaceTask: dedup — dropping "${rt.id}" (duplicate of "${kept.id}")`
          );
        } else {
          dedupMap.set(key, rt);
        }
      }

      if (droppedToKept.size > 0) {
        // Filter to only kept entries.
        replacementTasks = replacementTasks.filter((rt) => !droppedToKept.has(rt.id));

        // Rewrite dependency references inside kept replacements so that
        // any dep that pointed at a dropped ID now points at the kept ID.
        for (const rt of replacementTasks) {
          if (!rt.dependencies) continue;
          rt.dependencies = rt.dependencies.map((d) =>
            droppedToKept.has(d.taskId)
              ? { ...d, taskId: droppedToKept.get(d.taskId) }
              : d
          );
        }
      }
    }

    // ── Step 7d: Normalize non-conforming + collision-prone replacement ids ─
    // The replan cap is keyed on canonicalTaskId(); a replacement whose
    // canonical id differs from the failed task's canonical id would
    // canonicalize to itself, start at attempts=0, and open a fresh replan
    // budget every cycle.
    //
    // w4-state-resume-persistence Fix #4: the rename is now triggered for ANY
    // replacement id that would collide with a task that already exists in the
    // DAG — not just canonical-mismatched ones. A planner echoing the failed
    // task's own id (canonical-equal but already in tasksById, since the failed
    // task is still mapped here) or a sibling's id (e.g. `X-rp-001` while
    // replanning `X-rp-002`) would otherwise overwrite an existing task in
    // tasksById and rewrite its on-disk entry back to pending — silently
    // resurrecting a completed/invalidated task and destroying its
    // status/retryCount history. The new schema (all replacement ids in the
    // `-rp-N` namespace) makes such collisions MORE likely.
    //
    // Carve-out: a canonical-equal id that does NOT collide with any existing
    // DAG task and is not duplicated within this batch — the natural next free
    // `-rp-NNN` slot for this family (e.g. `X-rp-002` for failed `X-rp-001`) —
    // is left untouched. The trigger is collision-based, not format-based, so
    // a conforming but unpadded sibling that does not collide stays as-is.
    //
    // Renamed ids become `${failedTaskId}-rp-NNN` (collision-free against
    // tasksById and ids already claimed in this batch); intra-batch dependency
    // references are rewritten (same mechanism as the dedup's droppedToKept).
    {
      const renamedToNew = new Map(); // oldId → newId
      // claimed = ids that must not be (re)used as a kept id: every existing
      // DAG task plus every replacement id still standing in this batch. As we
      // rename, we move the old id out and the new id in so a second colliding
      // replacement does not pick the same new id or re-collide with the first.
      const claimed = new Set([...tasksById.keys(), ...replacementTasks.map((rt) => rt.id)]);

      for (const rt of replacementTasks) {
        const canonicalMismatch = canonicalTaskId(rt.id) !== canonicalTaskId(failedTaskId);
        // Collides with an existing DAG task (the failed task is still mapped
        // here, so an echo of its own id is caught too).
        const collidesWithDag = tasksById.has(rt.id);
        // Collides with another replacement still standing in this batch
        // (same id, distinct task — step-7c only dedups functional duplicates).
        const collidesInBatch =
          replacementTasks.filter((other) => other.id === rt.id).length > 1;

        if (!canonicalMismatch && !collidesWithDag && !collidesInBatch) {
          continue; // conforming, collision-free natural next slot — leave it
        }

        const oldId = rt.id;
        let n = 1;
        let newId;
        do {
          newId = `${failedTaskId}-rp-${String(n).padStart(3, '0')}`;
          n += 1;
        } while (claimed.has(newId));
        renamedToNew.set(oldId, newId);
        claimed.delete(oldId);
        claimed.add(newId);
        const reason = canonicalMismatch
          ? 'rename preserves replan-cap keying'
          : 'rename avoids resurrecting an existing task (exact-id collision)';
        this.onLog(
          `  Scheduler.replaceTask: normalized replacement id "${oldId}" → "${newId}" (${reason})`
        );
        rt.id = newId;
      }

      if (renamedToNew.size > 0) {
        // Rewrite dependency references inside the batch so that any dep
        // that pointed at a renamed ID now points at the new ID.
        for (const rt of replacementTasks) {
          if (!rt.dependencies) continue;
          rt.dependencies = rt.dependencies.map((d) =>
            renamedToNew.has(d.taskId)
              ? { ...d, taskId: renamedToNew.get(d.taskId) }
              : d
          );
        }
      }
    }

    // ── Step 7d2: Strip dependencies on unknown task ids ──────────────
    // Runs AFTER dedup (7c) and id-normalization (7d) so intra-batch dep
    // references have already been rewritten to their surviving ids. A dep
    // whose taskId exists neither in the DAG nor in this batch is never
    // satisfiable: readTaskStatus returns null (or throws on a malformed
    // id) inside the scheduling loop → "Scheduler stall". Strip it with a
    // loud warning and continue — throwing here would convert a
    // recoverable stall into a hard halt.
    {
      const validIds = new Set([...tasksById.keys(), ...replacementTasks.map((rt) => rt.id)]);
      for (const rt of replacementTasks) {
        if (!Array.isArray(rt.dependencies) || rt.dependencies.length === 0) continue;
        const kept = rt.dependencies.filter((d) => {
          if (d && validIds.has(d.taskId)) return true;
          this.onLog(
            `  Scheduler.replaceTask: WARNING — stripped dependency on unknown task ` +
            `"${d?.taskId}" from replacement "${rt.id}" (no such task in the DAG or this batch)`
          );
          return false;
        });
        rt.dependencies = kept;
      }
    }

    // ── Step 7e: Re-home the failed task's spec hardChecks ────────────
    // The replan schema has no hardChecks field, so replacements would be
    // persisted with empty hardChecks while the invalidated original's
    // verify sidecar (the checks' disk home) survives — no live task would
    // ever run them. Source = union of the original's verify sidecar (disk
    // SoT, fail-soft) and the in-memory failedTask.hardChecks (fallback for
    // direct callers/tests), de-duplicated by command. Scoping reuses
    // scopeSpecHardChecks (targetFile matching). Runs BEFORE step 8b so
    // writeVerifyJson(harnessDir, rt) persists the re-homed checks into the
    // replacements' sidecars with zero persistence-layer changes.
    {
      let sidecarChecks = [];
      try {
        const vj = JSON.parse(fs.readFileSync(
          path.join(this.harnessDir, 'verify', `task-${failedTaskId}.json`),
          'utf8'
        ));
        if (Array.isArray(vj.hardChecks)) sidecarChecks = vj.hardChecks;
      } catch {
        // fail-soft: missing/corrupt sidecar → in-memory fallback only
      }

      const unionChecks = [];
      const seenCommands = new Set();
      for (const h of [...sidecarChecks, ...(failedTask.hardChecks || [])]) {
        if (!h || typeof h.command !== 'string' || seenCommands.has(h.command)) continue;
        seenCommands.add(h.command);
        unionChecks.push(h);
      }

      if (unionChecks.length > 0) {
        const scoped = scopeSpecHardChecks(unionChecks, replacementTasks);
        for (const rt of replacementTasks) {
          const checks = scoped.get(rt.id) || [];
          if (checks.length === 0) continue;
          rt.hardChecks = Array.isArray(rt.hardChecks) ? rt.hardChecks : [];
          const present = new Set(rt.hardChecks.map((h) => h && h.command));
          for (const check of checks) {
            if (present.has(check.command)) continue; // already carried — no duplicate
            rt.hardChecks.push(check);
            present.add(check.command);
          }
          this.onLog(
            `  Scheduler.replaceTask: re-homed ${checks.length} spec hardCheck(s) onto "${rt.id}"`
          );
        }

        // Path-bearing checks that scopeSpecHardChecks could assign but that
        // landed on NO replacement: loud warning, no throw — the
        // last-milestone spec-coverage drain delivers the verdict.
        const unhomed = findOrphanedSpecHardChecks(unionChecks, scoped);
        if (unhomed.length > 0) {
          this.onLog(
            `  Scheduler.replaceTask: WARNING — ${unhomed.length} spec hardCheck(s) from ` +
            `"${failedTaskId}" matched no replacement's targetFiles and were NOT re-homed; ` +
            `the last-milestone spec-coverage drain will judge them:` +
            unhomed.map((c) => `\n    - ${c.command}`).join('')
          );
        }
      }
    }

    // ── Step 8: Insert replacement tasks ─────────────────────────────
    const insertedIds = [];
    for (const rt of replacementTasks) {
      // Inherit missionId and subMissionId from the failed task.
      rt.missionId = rt.missionId || failedTask.missionId;
      rt.subMissionId = rt.subMissionId || failedTask.subMissionId;
      tasksById.set(rt.id, rt);
      pending.add(rt.id);
      insertedIds.push(rt.id);
      this.onLog(`  Scheduler.replaceTask: inserted replacement task "${rt.id}"`);
    }

    // ── Step 8b: Persist replacement tasks to mission state file ─────
    // Without this, transitionTask and readTaskStatus would throw
    // "Task not found" because the task only exists in scheduler memory.
    for (const rt of replacementTasks) {
      const missionId = rt.missionId;
      const subMissionId = rt.subMissionId;
      if (!missionId || !subMissionId) continue;
      const stateFile = path.join(this.harnessDir, 'state', `mission-${missionId}.json`);
      if (!fs.existsSync(stateFile)) continue;
      const missionState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const sm = missionState.subMissions?.[subMissionId];
      if (!sm) continue;
      sm.tasks[rt.id] = {
        id: rt.id,
        description: rt.description || '',
        status: 'pending',
        targetFiles: rt.targetFiles || [],
        dependencies: rt.dependencies || [],
        createdAt: new Date().toISOString(),
        startedAt: null,
      };
      writeJsonAtomic(stateFile, missionState);
      writeVerifyJson(this.harnessDir, rt);
      this.onLog(`  Scheduler.replaceTask: persisted "${rt.id}" to ${path.basename(stateFile)}`);
    }

    // ── Step 9: Rewire downstream dependents ─────────────────────────
    // Tasks that had a dependency on failedTaskId get that dependency
    // rewritten to point to the last replacement task. Direct dependents
    // are re-added to pending so they can be scheduled after the replacement.
    // Use the last *kept* replacement ID (insertedIds already reflects the
    // post-dedup filtered list, so the last element is the last kept entry).
    const lastReplacementId = insertedIds.length > 0 ? insertedIds[insertedIds.length - 1] : null;

    // rewireSnapshot captures each rewired task's original dependencies
    // (deep-copied) and its pre-rewire pending membership before mutation,
    // for use in acyclicity rollback.
    const rewireSnapshot = new Map();

    if (lastReplacementId) {
      for (const [id, task] of tasksById) {
        // Skip replacement tasks themselves (they don't depend on failedTaskId).
        if (insertedIds.includes(id)) continue;

        const deps = task.dependencies || [];
        const needsRewire = deps.some((d) => d.taskId === failedTaskId);
        if (needsRewire) {
          // Capture original dependencies (deep copy) and pre-rewire pending
          // membership before mutation. Dependents of a failed task are
          // typically ALREADY pending (their dep never completed, so they
          // were never dispatched), so the pending.add below is usually a
          // no-op — wasPending lets the rollback restore membership exactly.
          rewireSnapshot.set(id, { deps: deps.map((d) => ({ ...d })), wasPending: pending.has(id) });

          task.dependencies = deps.map((d) =>
            d.taskId === failedTaskId
              ? { ...d, taskId: lastReplacementId }
              : d
          );
          // Ensure the rewired task is pending so it will be scheduled after
          // the replacement completes (usually a no-op — see above).
          pending.add(id);
          this.onLog(
            `  Scheduler.replaceTask: rewired dependency in "${id}": ` +
            `"${failedTaskId}" → "${lastReplacementId}"`
          );
        }
      }
    }

    // ── Step 10: Validate acyclicity; roll back on failure ────────────
    try {
      this._validateAcyclicity(tasksById);
    } catch (cycleErr) {
      this.onLog(`  Scheduler.replaceTask: acyclicity violation — rolling back. ${cycleErr.message}`);

      // w4-state-resume-persistence Fix #4 rider: clean up the rolled-back
      // replacements' step-8b on-disk artifacts BEFORE evicting them from
      // tasksById (so we still have each task's missionId/subMissionId).
      // Without this, a rolled-back replacement's mission-state entry and
      // verify sidecar would linger on disk and could be picked up by the
      // coverage drain or a later resume even though the task no longer exists
      // in the DAG. Mirrors step-8b's existence guards exactly (the inverse
      // operation): only touch what step-8b would have written.
      for (const id of insertedIds) {
        const rt = tasksById.get(id);
        if (rt) {
          const missionId = rt.missionId;
          const subMissionId = rt.subMissionId;
          if (missionId && subMissionId) {
            const stateFile = path.join(this.harnessDir, 'state', `mission-${missionId}.json`);
            if (fs.existsSync(stateFile)) {
              const missionState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
              const sm = missionState.subMissions?.[subMissionId];
              if (sm && sm.tasks && Object.prototype.hasOwnProperty.call(sm.tasks, id)) {
                delete sm.tasks[id];
                writeJsonAtomic(stateFile, missionState);
              }
            }
          }
        }
        const sidecar = path.join(this.harnessDir, 'verify', `task-${id}.json`);
        if (fs.existsSync(sidecar)) {
          fs.unlinkSync(sidecar);
        }
      }

      // Roll back: remove replacement tasks from tasksById and pending.
      for (const id of insertedIds) {
        tasksById.delete(id);
        pending.delete(id);
      }

      // Restore invalidated task objects in tasksById (they remain
      // invalidated on disk — this is the noted edge case in the spec).
      for (const [id, task] of snapshotById) {
        if (task) tasksById.set(id, task);
      }

      // Restore rewired dependents' dependencies from rewireSnapshot and
      // restore pending membership to its exact pre-step-9 state: only
      // delete ids that step 9 actually added. Dependents of a failed task
      // are typically already pending, so an unconditional delete here
      // evicted legitimately-pending tasks, which the main loop
      // (pending ∪ workers empty → done) then silently dropped.
      for (const [id, snap] of rewireSnapshot) {
        const task = tasksById.get(id);
        if (task) task.dependencies = snap.deps;
        if (!snap.wasPending) pending.delete(id);
      }

      throw cycleErr;
    }

    this.onLog(
      `  Scheduler.replaceTask: complete — invalidated=[${invalidatedIds.join(', ')}] ` +
      `inserted=[${insertedIds.join(', ')}]`
    );

    try {
      const cascade = await cascadeComplete(this.harnessDir, {
        missionId: failedTask.missionId,
        subMissionId: failedTask.subMissionId,
      });
      if (cascade.subMission === 'cascaded') {
        this.onLog(`    Scheduler: sub-mission ${failedTask.subMissionId} → complete`);
      }
      if (cascade.mission === 'cascaded') {
        this.onLog(`    Scheduler: mission ${failedTask.missionId} → complete`);
      }
    } catch (cascadeErr) {
      this.onLog(`    Scheduler.replaceTask: cascade after replaceTask threw: ${cascadeErr.message}`);
    }

    return { invalidated: invalidatedIds, inserted: insertedIds };
  }

  /**
   * Validate that the task DAG represented by `tasksById` is acyclic.
   * Uses recursive DFS (a nested `dfs` helper invoked once per unvisited
   * node) with a `visited` set and an `inStack` set to detect back-edges.
   * Throws on the first cycle detected; does not return a value.
   *
   * @param {Map<string,object>} tasksById - Full task index for the DAG.
   * @returns {void}
   * @throws {Error} if a cycle is detected.
   */
  _validateAcyclicity(tasksById) {
    const visited = new Set();
    const inStack = new Set();

    const dfs = (taskId) => {
      if (inStack.has(taskId)) {
        throw new Error(
          `_validateAcyclicity: cycle detected involving task "${taskId}".`
        );
      }
      if (visited.has(taskId)) return;

      visited.add(taskId);
      inStack.add(taskId);

      const task = tasksById.get(taskId);
      if (task) {
        for (const dep of task.dependencies || []) {
          dfs(dep.taskId);
        }
      }

      inStack.delete(taskId);
    };

    for (const taskId of tasksById.keys()) {
      if (!visited.has(taskId)) {
        dfs(taskId);
      }
    }
  }
}
