/**
 * state-machine.js — Single source of truth for harness status transitions.
 *
 * Every state write in cc-orch MUST go through this module. Replaces the
 * update-*-status.sh + complete-verification.sh enforcement from the
 * original harness-orchestrator skill.
 *
 * Enforces:
 *   I3  — only callers passing { caller: 'verification' } can set `verified`,
 *         and only when the verification report file exists on disk.
 *   I4  — all transitions are validated against TASK_TRANSITIONS.
 *   I5  — parent nodes can only transition to `complete` when every child
 *         is in a terminal state (complete or invalidated).
 *   I17 — `verified` requires the verification report file on disk.
 *
 * Pure JS, no AI, no shell.
 *
 * Public API (all async as of Phase I items 4+5):
 *   TASK_TRANSITIONS                                         (frozen map)
 *   canComplete(children)                                    → boolean
 *   transitionTask(harnessDir, taskId, newStatus, opts)      → Promise<void>
 *   transitionSubMission(harnessDir, missionId, subMissionId, newStatus, opts)
 *                                                            → Promise<void>
 *   transitionMission(harnessDir, missionId, newStatus, opts)→ Promise<void>
 *   transitionMilestone(harnessDir, milestoneId, newStatus, opts)
 *                                                            → Promise<void>
 *   cascadeComplete(harnessDir, { missionId, subMissionId }) → Promise<result>
 *   withMissionFileLock(harnessDir, missionId, fn)           → Promise<any>
 *   getTaskStatus(harnessDir, taskId)                        (sync read)
 *   getSubMissionStatus(harnessDir, missionId, subMissionId) (sync read)
 *   getMissionStatus(harnessDir, missionId)                  (sync read)
 *   getMilestoneStatus(harnessDir, milestoneId)              (sync read)
 *
 * Concurrency model (Phase I items 4+5): the four `transitionX` functions
 * now serialize through async mutexes so the scheduler's worker pool can
 * safely invoke them concurrently across tasks. Two mutex scopes:
 *
 *   1. Per-mission-file mutex (`missionFileMutexes.for(path)`). Protects
 *      writes to `state/mission-{id}.json`. Used by transitionTask,
 *      transitionSubMission, the mission-file half of transitionMission,
 *      AND coverage.mergeRemediationTasks via the exported
 *      `withMissionFileLock` helper. Concurrent transitions on different
 *      missions run in parallel; transitions on the same mission serialize.
 *
 *   2. Global-state mutex (singleton). Protects writes to `state.json`.
 *      Used by transitionMilestone and the global-state half of
 *      transitionMission.
 *
 * Fixed lock order: when transitionMission acquires both, it takes the
 * global-state mutex FIRST, then the mission-file mutex. Any future code
 * that wants to acquire both must follow the same order to avoid deadlock.
 *
 * Why async mutexes (not sync): JavaScript is single-threaded, but each
 * transition does file I/O (readFileSync → mutate → writeFileSync). The
 * bug we are preventing is an `await` gap in the caller — the scheduler
 * calls transitionTask, awaits it, then calls transitionTask again; under
 * parallelism two such chains can interleave between a read and a write
 * of the same file. The mutex forces them to serialize. The underlying
 * file I/O is still sync (`readFileSync`/`writeFileSync`) — the mutex
 * only serializes the composite load-modify-write sequence.
 *
 * Pre-parallelism defense: `_writeJsonAtomic` retains its mtime guard as
 * a last-line detector. Under the mutex it should never fire; if it does,
 * something has bypassed the mutex and we want to know loudly.
 *
 * Dual-write note: transitionMission updates both the per-mission state
 * file and the global state.json. Both writes are validated and atomic,
 * and are now both guarded by their respective mutexes. The pair is still
 * not transactional at the filesystem level — if the second write fails
 * mid-operation (very rare for local JSON writes), state could be
 * inconsistent between the two files. Accepted risk; same as pre-mutex.
 */
import fs from 'fs';
import path from 'path';
import { createMutex, createMutexRegistry } from '../infra/mutex.js';

// ---------- Module-level mutex state ----------
//
// Shared across all transition calls in the process. Lazily populated on
// first access to each distinct mission file path; global-state mutex is
// a single instance.

const missionFileMutexes = createMutexRegistry();
const globalStateMutex = createMutex();

/**
 * Task-level transitions — tasks pass through verification phases
 * (awaiting_verification → verified → complete).
 */
export const TASK_TRANSITIONS = Object.freeze({
  pending: ['in_progress', 'blocked', 'invalidated'],
  in_progress: ['awaiting_verification', 'failed', 'blocked', 'invalidated'],
  awaiting_verification: ['verified', 'failed', 'invalidated'],
  verified: ['complete', 'invalidated'],
  complete: ['needs_revalidation', 'invalidated'],
  failed: ['in_progress', 'invalidated', 'blocked'],
  blocked: ['pending', 'in_progress', 'invalidated'],
  needs_revalidation: ['awaiting_verification', 'invalidated'],
  invalidated: [],
});

/**
 * Parent-level transitions — sub-missions, missions, and milestones skip
 * verification phases and go directly from in_progress → complete once all
 * children are terminal. They never pass through awaiting_verification or
 * verified. needs_revalidation → in_progress for re-execution.
 */
export const PARENT_TRANSITIONS = Object.freeze({
  pending: ['in_progress', 'blocked', 'invalidated'],
  in_progress: ['complete', 'failed', 'blocked', 'invalidated'],
  complete: ['needs_revalidation', 'invalidated'],
  failed: ['in_progress', 'invalidated', 'blocked'],
  blocked: ['pending', 'in_progress', 'invalidated'],
  needs_revalidation: ['in_progress', 'invalidated'],
  invalidated: [],
});

const TERMINAL_OK = new Set(['complete', 'invalidated']);

// ---------- Validation helpers ----------

function assertTransition(table, from, to, level) {
  if (!(from in table)) {
    throw new Error(`Unknown source status for ${level}: ${from}`);
  }
  if (!table[from].includes(to)) {
    throw new Error(`Illegal ${level} transition: ${from} → ${to}`);
  }
}

/**
 * True iff `children` is a non-empty object and every child's status is
 * `complete` or `invalidated`.
 */
export function canComplete(children) {
  if (!children || typeof children !== 'object') return false;
  const entries = Object.values(children);
  if (entries.length === 0) return false;
  return entries.every((c) => TERMINAL_OK.has(c.status));
}

// ---------- ID parsing ----------

function missionIdFromTaskId(taskId) {
  const parts = taskId.split('-');
  if (parts.length < 4) throw new Error(`Malformed task id: ${taskId}`);
  return `${parts[0]}-${parts[1]}`;
}

function subMissionIdFromTaskId(taskId) {
  const parts = taskId.split('-');
  if (parts.length < 4) throw new Error(`Malformed task id: ${taskId}`);
  return `${parts[0]}-${parts[1]}-${parts[2]}`;
}

function milestoneIdFromMissionId(missionId) {
  const parts = missionId.split('-');
  if (parts.length < 2) throw new Error(`Malformed mission id: ${missionId}`);
  return parts[0];
}

// ---------- File path helpers ----------

function missionStateFile(harnessDir, missionId) {
  return path.join(harnessDir, 'state', `mission-${missionId}.json`);
}

function globalStateFile(harnessDir) {
  return path.join(harnessDir, 'state.json');
}

/**
 * Resolve the task-level verification sidecar for a task.
 *
 * Returns { path: string, format: 'task' } if the task-level sidecar is
 * found on disk, or null if it does not exist.
 */
export function resolveVerificationSidecar(harnessDir, taskId) {
  const taskSidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);
  if (fs.existsSync(taskSidecarPath)) {
    return { path: taskSidecarPath, format: 'task' };
  }
  return null;
}

function verificationSidecarPath(harnessDir, taskId) {
  const resolved = resolveVerificationSidecar(harnessDir, taskId);
  if (resolved) {
    return resolved.path;
  }
  // Fall back to the task-level path for backwards compatibility.
  return path.join(harnessDir, 'verification', `task-${taskId}.json`);
}

// ---------- Atomic read/write with defensive mtime guard ----------

function _readJsonWithMtime(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`State file not found: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return { data, mtimeMs: stat.mtimeMs };
}

function _writeJsonAtomic(filePath, data, priorMtimeMs) {
  if (priorMtimeMs != null && fs.existsSync(filePath)) {
    const current = fs.statSync(filePath).mtimeMs;
    if (current !== priorMtimeMs) {
      throw new Error(
        `Concurrent modification detected: ${filePath} changed between read and write`
      );
    }
  }
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// ---------- Readers ----------

export function getTaskStatus(harnessDir, taskId) {
  const missionId = missionIdFromTaskId(taskId);
  const subMissionId = subMissionIdFromTaskId(taskId);
  const filePath = missionStateFile(harnessDir, missionId);
  if (!fs.existsSync(filePath)) return null;
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return state.subMissions?.[subMissionId]?.tasks?.[taskId]?.status || null;
}

export function getSubMissionStatus(harnessDir, missionId, subMissionId) {
  const filePath = missionStateFile(harnessDir, missionId);
  if (!fs.existsSync(filePath)) return null;
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return state.subMissions?.[subMissionId]?.status || null;
}

export function getMissionStatus(harnessDir, missionId) {
  const filePath = missionStateFile(harnessDir, missionId);
  if (!fs.existsSync(filePath)) return null;
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return state.status || null;
}

export function getMilestoneStatus(harnessDir, milestoneId) {
  const filePath = globalStateFile(harnessDir);
  if (!fs.existsSync(filePath)) return null;
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return state.milestones?.[milestoneId]?.status || null;
}

// ---------- Transitions ----------

/**
 * Acquire the per-mission-file mutex around an async function.
 * Public helper so callers outside this module (e.g.,
 * gates/coverage.js mergeRemediationTasks) can serialize their
 * writes to the same mission state file without needing to import
 * the private mutex registry.
 */
export async function withMissionFileLock(harnessDir, missionId, fn) {
  const filePath = missionStateFile(harnessDir, missionId);
  const release = await missionFileMutexes.for(filePath).acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function transitionTask(harnessDir, taskId, newStatus, opts = {}) {
  const missionId = missionIdFromTaskId(taskId);
  const subMissionId = subMissionIdFromTaskId(taskId);
  const filePath = missionStateFile(harnessDir, missionId);

  const release = await missionFileMutexes.for(filePath).acquire();
  try {
    const { data, mtimeMs } = _readJsonWithMtime(filePath);

    const subMission = data.subMissions?.[subMissionId];
    const task = subMission?.tasks?.[taskId];
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    assertTransition(TASK_TRANSITIONS, task.status, newStatus, 'task');

    // I3 / I17: verified gate
    if (newStatus === 'verified') {
      if (opts.caller !== 'verification') {
        throw new Error(
          `Transition to 'verified' requires caller: 'verification'. ` +
          `Got: ${opts.caller === undefined ? 'undefined' : `'${opts.caller}'`}`
        );
      }
      // Source of truth: task-level JSON sidecar written by verifier via jsonSchema.
      const resolvedSidecar = resolveVerificationSidecar(harnessDir, taskId);
      if (!resolvedSidecar) {
        const taskSidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);
        throw new Error(
          `Transition to 'verified' requires verification sidecar at ${taskSidecarPath}`
        );
      }
    }

    // Apply transition and associated timestamp/counter bookkeeping.
    task.status = newStatus;
    const now = new Date().toISOString();
    if (newStatus === 'in_progress' && !task.startedAt) {
      task.startedAt = now;
    }
    if (newStatus === 'complete' || newStatus === 'invalidated') {
      task.completedAt = now;
    }
    if (newStatus === 'invalidated' && opts.invalidationReason && typeof opts.invalidationReason === 'string' && opts.invalidationReason.length > 0) {
      task.invalidationReason = opts.invalidationReason;
    }
    if (newStatus === 'failed') {
      task.retryCount = (task.retryCount || 0) + 1;
    }

    _writeJsonAtomic(filePath, data, mtimeMs);
  } finally {
    release();
  }
}

export async function transitionSubMission(harnessDir, missionId, subMissionId, newStatus, _opts = {}) {
  const filePath = missionStateFile(harnessDir, missionId);

  const release = await missionFileMutexes.for(filePath).acquire();
  try {
    const { data, mtimeMs } = _readJsonWithMtime(filePath);

    const subMission = data.subMissions?.[subMissionId];
    if (!subMission) {
      throw new Error(`Sub-mission not found: ${subMissionId}`);
    }

    assertTransition(PARENT_TRANSITIONS, subMission.status, newStatus, 'sub-mission');

    // I5: complete gate
    if (newStatus === 'complete') {
      if (!canComplete(subMission.tasks)) {
        const incomplete = Object.entries(subMission.tasks || {})
          .filter(([, t]) => !TERMINAL_OK.has(t.status))
          .map(([id, t]) => `${id}=${t.status}`)
          .join(', ');
        throw new Error(
          `Cannot complete sub-mission ${subMissionId}: tasks not terminal: ${incomplete}`
        );
      }
    }

    subMission.status = newStatus;
    _writeJsonAtomic(filePath, data, mtimeMs);
  } finally {
    release();
  }
}

export async function transitionMission(harnessDir, missionId, newStatus, _opts = {}) {
  const missionFile = missionStateFile(harnessDir, missionId);
  const globalFile = globalStateFile(harnessDir);

  // Fixed lock order: global-state mutex FIRST, then per-mission mutex.
  // Any future code that wants to acquire both must follow this order.
  // Today no other code acquires both, so the fixed order is primarily
  // documentation and future-proofing.
  const releaseGlobal = await globalStateMutex.acquire();
  try {
    const releaseMission = await missionFileMutexes.for(missionFile).acquire();
    try {
      const mission = _readJsonWithMtime(missionFile);
      const global = _readJsonWithMtime(globalFile);

      assertTransition(PARENT_TRANSITIONS, mission.data.status, newStatus, 'mission');

      // I5: complete gate
      if (newStatus === 'complete') {
        if (!canComplete(mission.data.subMissions)) {
          const incomplete = Object.entries(mission.data.subMissions || {})
            .filter(([, sm]) => !TERMINAL_OK.has(sm.status))
            .map(([id, sm]) => `${id}=${sm.status}`)
            .join(', ');
          throw new Error(
            `Cannot complete mission ${missionId}: sub-missions not terminal: ${incomplete}`
          );
        }
      }

      // Dual-write: mission state file + global state.json.
      const milestoneId = milestoneIdFromMissionId(missionId);
      const globalMission = global.data.milestones?.[milestoneId]?.missions?.[missionId];
      if (!globalMission) {
        throw new Error(`Mission ${missionId} not found in global state.json`);
      }

      mission.data.status = newStatus;
      globalMission.status = newStatus;

      _writeJsonAtomic(missionFile, mission.data, mission.mtimeMs);
      _writeJsonAtomic(globalFile, global.data, global.mtimeMs);
    } finally {
      releaseMission();
    }
  } finally {
    releaseGlobal();
  }
}

/**
 * Cascade completion from a sub-mission up through its mission.
 * Stops at the first level whose complete-gate is not yet satisfied.
 * Pure composition of the transition functions above.
 *
 * Returns { subMission, mission, milestone } — subMission and mission
 * are each either 'cascaded' (transitioned to complete) or 'skipped'
 * (gate not yet satisfied). milestone is always 'skipped' because
 * milestone completion is handled exclusively in Phase 5.
 *
 * Concurrency: each inner transition acquires its own mutex, so a
 * cascade and a concurrent transitionTask on the same mission safely
 * serialize. Two concurrent cascades from sibling tasks may see
 * different intermediate results — worker A finishes its task and
 * calls cascadeComplete which stops at sub-mission because worker B
 * is still running; later worker B finishes and its cascade succeeds.
 * Both paths are idempotent: the "not terminal" gate check is
 * re-evaluated under the lock each time, and neither cascade writes
 * invalid state.
 */
export async function cascadeComplete(harnessDir, { missionId, subMissionId }) {
  const result = { subMission: 'skipped', mission: 'skipped', milestone: 'skipped' };

  // 1. Try sub-mission → complete
  try {
    await transitionSubMission(harnessDir, missionId, subMissionId, 'complete');
    result.subMission = 'cascaded';
  } catch (err) {
    // Gate not satisfied or already in terminal state — stop the cascade.
    if (/Illegal/.test(err.message) || /not terminal/.test(err.message)) {
      return result;
    }
    throw err;
  }

  // 2. Try mission → complete (if all sub-missions now terminal)
  try {
    await transitionMission(harnessDir, missionId, 'complete');
    result.mission = 'cascaded';
  } catch (err) {
    if (/Illegal/.test(err.message) || /not terminal/.test(err.message)) {
      return result;
    }
    throw err;
  }

  return result;
}

export async function transitionMilestone(harnessDir, milestoneId, newStatus, _opts = {}) {
  const filePath = globalStateFile(harnessDir);

  const release = await globalStateMutex.acquire();
  try {
    const { data, mtimeMs } = _readJsonWithMtime(filePath);

    const milestone = data.milestones?.[milestoneId];
    if (!milestone) {
      throw new Error(`Milestone not found: ${milestoneId}`);
    }

    assertTransition(PARENT_TRANSITIONS, milestone.status, newStatus, 'milestone');

    // I5: complete gate
    if (newStatus === 'complete') {
      if (!canComplete(milestone.missions)) {
        const incomplete = Object.entries(milestone.missions || {})
          .filter(([, m]) => !TERMINAL_OK.has(m.status))
          .map(([id, m]) => `${id}=${m.status}`)
          .join(', ');
        throw new Error(
          `Cannot complete milestone ${milestoneId}: missions not terminal: ${incomplete}`
        );
      }
    }

    milestone.status = newStatus;
    _writeJsonAtomic(filePath, data, mtimeMs);
  } finally {
    release();
  }
}
