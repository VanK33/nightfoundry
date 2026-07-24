import fs from 'fs';
import path from 'path';
import { activeHarnessDir } from '../../orchestrator/core/run-context.js';

/**
 * Pure derivation of the two side-rail decision flags — pendingDecision and
 * error — from a defensively-shaped plain object. No filesystem access here;
 * callers (e.g. the /api/siderail aggregation handler) are responsible for
 * gathering the relevant queue/state facts into this shape first. Keeping the
 * mapping in one pure function lets tests enumerate every case directly.
 *
 * Mapping:
 *   - queueStatus === 'parked', OR a truthy `gate`/`awaitingDecision` marker
 *     → pendingDecision: true
 *   - queueStatus === 'halted-review' or 'halted-analyzer', OR a truthy
 *     `error` marker → error: true
 *   - any other/absent status and no markers → both false
 *
 * The two flags are independent — both, either, or neither may be true for a
 * given input.
 *
 * @param {{
 *   queueStatus?: string,
 *   gate?: boolean,
 *   awaitingDecision?: boolean,
 *   error?: boolean,
 * }} [input] - defensively-shaped plain object; missing/undefined fields are
 *   treated as "no signal" rather than throwing.
 * @returns {{ pendingDecision: boolean, error: boolean }}
 */
export function deriveDecisionState(input) {
  const safe = input && typeof input === 'object' ? input : {};
  const { queueStatus } = safe;

  const pendingDecision =
    queueStatus === 'parked' || Boolean(safe.gate) || Boolean(safe.awaitingDecision);

  const error =
    queueStatus === 'halted-review' ||
    queueStatus === 'halted-analyzer' ||
    Boolean(safe.error);

  return { pendingDecision, error };
}

/**
 * Creates an Express-style handler for GET /api/siderail — aggregates
 * harnessDir/state.json + harnessDir/state/mission-<id>.json (same
 * milestones→missions→subMissions→tasks tree-walk as api/state.js and
 * api/archives.js) plus archivesDir/*&#47;manifest.json timing data into the
 * five side-rail display facts: progress counts, the current in-progress
 * task's lineage, a pendingDecision flag, an error flag, and a timing
 * summary. Never throws — every file read is wrapped in try/catch with a
 * safe fallback, mirroring the defensive pattern in api/state.js.
 *
 * @param {{ projectRoot: string, archivesDir: string }} options
 * @returns {(req: object, res: object) => void}
 */
export function createSiderailHandler({ projectRoot, archivesDir }) {
  return function siderailHandler(_req, res) {
    const harnessDir = activeHarnessDir(projectRoot);
    const stateFilePath = path.join(harnessDir, 'state.json');

    let state;
    try {
      if (!fs.existsSync(stateFilePath)) {
        return res.json({ active: false });
      }
      state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    } catch {
      return res.json({ active: false });
    }

    if (!state || typeof state !== 'object') {
      return res.json({ active: false });
    }

    const active = state.globalStatus === 'active';

    // ── Tree-walk: milestones → missions → state/mission-<id>.json →
    // subMissions → tasks. Mirrors api/state.js and api/archives.js. ─────────
    let tasksTotal = 0;
    let tasksComplete = 0;
    let milestonesTotal = 0;
    let milestonesComplete = 0;
    let current = null;

    const milestonesMap = state.milestones ?? {};
    for (const milestone of Object.values(milestonesMap)) {
      milestonesTotal++;
      if (milestone.status === 'complete') milestonesComplete++;

      const missionsMap = milestone.missions ?? {};
      for (const mission of Object.values(missionsMap)) {
        const missionFilePath = path.join(harnessDir, 'state', `mission-${mission.id}.json`);
        let missionState = null;
        try {
          missionState = JSON.parse(fs.readFileSync(missionFilePath, 'utf8'));
        } catch {
          missionState = null;
        }
        if (!missionState || typeof missionState !== 'object') continue;

        const subMissionsMap = missionState.subMissions ?? {};
        for (const sm of Object.values(subMissionsMap)) {
          const tasksMap = sm.tasks ?? {};
          for (const task of Object.values(tasksMap)) {
            tasksTotal++;
            if (task.status === 'verified') tasksComplete++;
            if (task.status === 'in_progress' && current === null) {
              current = {
                taskId: task.id,
                description: task.description,
                missionId: mission.id,
                milestoneId: milestone.id,
              };
            }
          }
        }
      }
    }

    // ── Timing ────────────────────────────────────────────────────────────
    const startedAtRaw = state.startedAt ?? state.projectMeta?.createdAt ?? null;
    const startedAtMs = startedAtRaw ? Date.parse(startedAtRaw) : NaN;
    const elapsedMs = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : 0;
    const remainingTasks = tasksTotal - tasksComplete;
    const avgTaskDurationMs = computeAvgTaskDurationMs(archivesDir);

    // ── pendingDecision / error — sourced from whatever queue/gate markers
    // the state file exposes, fed through the pure deriveDecisionState
    // mapping so the derivation stays enumerable/testable in one place. ─────
    const signals = {
      queueStatus: state.queueStatus ?? state.projectMeta?.queueStatus ?? undefined,
      gate: Boolean(state.gate ?? state.projectMeta?.gate),
      awaitingDecision: Boolean(state.awaitingDecision ?? state.projectMeta?.awaitingDecision),
      error: Boolean(state.error ?? state.projectMeta?.error),
    };
    const { pendingDecision, error } = deriveDecisionState(signals);

    return res.json({
      active,
      progress: { tasksComplete, tasksTotal, milestonesComplete, milestonesTotal },
      current,
      pendingDecision,
      error,
      timing: { elapsedMs, remainingTasks, avgTaskDurationMs },
    });
  };
}

/**
 * Defensively computes the average per-task duration (ms) across all
 * archives in archivesDir, using each archive's manifest.json startedAt/
 * archivedAt timestamps divided by that archive's own task count (found via
 * the same state.json → state/mission-<id>.json tree-walk used for the live
 * run). Archives lacking parseable timestamps or a resolvable task count are
 * skipped rather than allowed to throw or skew the average. Returns 0 when
 * archivesDir is absent/unreadable or no archive yields usable timing data.
 *
 * @param {string} archivesDir
 * @returns {number}
 */
function computeAvgTaskDurationMs(archivesDir) {
  let dirents;
  try {
    dirents = fs.readdirSync(archivesDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let totalDurationMs = 0;
  let totalTaskCount = 0;

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const archiveDir = path.join(archivesDir, dirent.name);

    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8'));
    } catch {
      manifest = null;
    }
    if (!manifest || typeof manifest !== 'object') continue;

    const startMs = manifest.startedAt ? Date.parse(manifest.startedAt) : NaN;
    const endMs = manifest.archivedAt ? Date.parse(manifest.archivedAt) : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;

    let archiveState = null;
    try {
      archiveState = JSON.parse(fs.readFileSync(path.join(archiveDir, 'state.json'), 'utf8'));
    } catch {
      archiveState = null;
    }
    if (!archiveState || typeof archiveState !== 'object') continue;

    let archiveTaskCount = 0;
    const archiveMilestonesMap = archiveState.milestones ?? {};
    for (const milestone of Object.values(archiveMilestonesMap)) {
      const missionsMap = milestone.missions ?? {};
      for (const mission of Object.values(missionsMap)) {
        let missionState = null;
        try {
          missionState = JSON.parse(
            fs.readFileSync(path.join(archiveDir, 'state', `mission-${mission.id}.json`), 'utf8')
          );
        } catch {
          missionState = null;
        }
        if (!missionState || typeof missionState !== 'object') continue;
        for (const sm of Object.values(missionState.subMissions ?? {})) {
          archiveTaskCount += Object.keys(sm.tasks ?? {}).length;
        }
      }
    }

    if (archiveTaskCount > 0) {
      totalDurationMs += endMs - startMs;
      totalTaskCount += archiveTaskCount;
    }
  }

  return totalTaskCount > 0 ? totalDurationMs / totalTaskCount : 0;
}

export default deriveDecisionState;
