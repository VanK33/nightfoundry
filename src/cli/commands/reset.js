/**
 * reset.js — `cc-orch reset <taskId>` command module.
 *
 * OFFLINE GUARANTEE: this module is deterministic and performs no
 * session/LLM/network I/O. It imports only node's fs/path builtins plus
 * '../../orchestrator/core/run-context.js' (for active-run harness dir
 * resolution), '../../orchestrator/core/scheduler.js' (for
 * canonicalTaskId), and '../../orchestrator/core/state.js' (for
 * writeJsonAtomic). It must never import
 * src/orchestrator/infra/session-manager.js or any other session/LLM/
 * network-touching module.
 *
 * This module delivers the resolution layer, the two error paths, and the
 * four reset operations for `reset`:
 *   - findTaskLocation(harnessDir, taskId) scans mission state files to
 *     find where a task id lives.
 *   - ERROR PATH A: no state/mission-*.json files at all under the
 *     resolved harness dir (no active run harness found).
 *   - ERROR PATH B: mission files exist, but none contains the task id
 *     (unknown task id).
 *   - Once resolved, four independent reset operations run, each printing
 *     exactly one per-item summary line reporting either a cleared or a
 *     not-found outcome (not-found is never an error):
 *       (a) mission state: set the task's status to 'pending' and
 *           retryCount to 0 in its state/mission-*.json file, persisted
 *           via writeJsonAtomic so the rest of the file survives intact.
 *       (b) scheduler.replanAttempts: delete the entry keyed by
 *           canonicalTaskId(taskId) from <harnessDir>/state.json (the
 *           harness ROOT state.json), rewritten atomically.
 *       (c) analysis history: delete
 *           <harnessDir>/analysis/history-<canonicalTaskId>.json.
 *       (d) snapshots: delete <harnessDir>/snapshots/<taskId>/ recursively
 *           (including its after/ subdir).
 *     A final caution line warns that reset must only be run while no run
 *     process is live.
 *
 * Exported signature:
 *   export function reset(projectRoot, taskId)
 *
 * Mirrors the refusal posture of queueRetry in src/cli/commands/queue.js:
 * an actionable console.error, `process.exitCode = 1`, and an early
 * `return` (never `process.exit`), so this can be invoked in-process and
 * asserted on directly.
 */

import fs from 'fs';
import path from 'path';
import { activeHarnessDir } from '../../orchestrator/core/run-context.js';
import { canonicalTaskId } from '../../orchestrator/core/scheduler.js';
import { writeJsonAtomic } from '../../orchestrator/core/state.js';

/**
 * Scans every `<harnessDir>/state/mission-*.json` file (sorted by filename
 * for determinism) looking for a `subMissions[<smId>].tasks[<taskId>]`
 * entry. Files that cannot be read or parsed as JSON are tolerated and
 * skipped rather than throwing.
 *
 * @param {string} harnessDir
 * @param {string} taskId
 * @returns {{ stateFile: string, subMissionId: string, task: object } | null}
 */
export function findTaskLocation(harnessDir, taskId) {
  const stateDir = path.join(harnessDir, 'state');
  let names = [];
  try {
    names = fs.readdirSync(stateDir);
  } catch {
    names = [];
  }

  const missionFiles = names
    .filter((name) => /^mission-.*\.json$/.test(name))
    .sort()
    .map((name) => path.join(stateDir, name));

  for (const stateFile of missionFiles) {
    let parsed;
    try {
      const raw = fs.readFileSync(stateFile, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      continue; // unparseable/unreadable — skip, keep scanning
    }

    const subMissions = parsed && typeof parsed === 'object' ? parsed.subMissions : null;
    if (!subMissions || typeof subMissions !== 'object') continue;

    for (const subMissionId of Object.keys(subMissions)) {
      const sm = subMissions[subMissionId];
      const tasks = sm && typeof sm === 'object' ? sm.tasks : null;
      if (!tasks || typeof tasks !== 'object') continue;
      if (Object.prototype.hasOwnProperty.call(tasks, taskId)) {
        return { stateFile, subMissionId, task: tasks[taskId] };
      }
    }
  }

  return null;
}

/**
 * Lists the mission state files (sorted for determinism) under
 * `<harnessDir>/state/mission-*.json`. Returns an empty array when the
 * state directory is absent or unreadable.
 *
 * @param {string} harnessDir
 * @returns {string[]}
 */
function listMissionFiles(harnessDir) {
  const stateDir = path.join(harnessDir, 'state');
  let names = [];
  try {
    names = fs.readdirSync(stateDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^mission-.*\.json$/.test(name))
    .sort()
    .map((name) => path.join(stateDir, name));
}

/**
 * Reset item (a): mission state. Sets the located task's `status` to
 * 'pending' and `retryCount` to 0 in its `state/mission-*.json` file,
 * persisting via writeJsonAtomic so the rest of the mission file (sibling
 * tasks/sub-missions) is preserved intact. This item always "clears"
 * since `location` was already resolved by the caller (the task is known
 * to exist).
 *
 * @param {{ stateFile: string, subMissionId: string }} location
 * @param {string} taskId
 * @returns {string} one-line summary
 */
function resetMissionState(location, taskId) {
  const raw = fs.readFileSync(location.stateFile, 'utf8');
  const parsed = JSON.parse(raw);
  const task = parsed.subMissions[location.subMissionId].tasks[taskId];
  task.status = 'pending';
  task.retryCount = 0;
  writeJsonAtomic(location.stateFile, parsed);
  return `  - mission state: cleared (status set to 'pending', retryCount set to 0 in ${location.stateFile})`;
}

/**
 * Reset item (b): scheduler.replanAttempts. Deletes the entry keyed by
 * the CANONICAL task id from `<harnessDir>/state.json` (the harness ROOT
 * state.json), rewriting atomically and leaving all other keys intact.
 *
 * @param {string} harnessDir
 * @param {string} canonicalId
 * @returns {string} one-line summary
 */
function resetReplanAttempts(harnessDir, canonicalId) {
  const stateJsonPath = path.join(harnessDir, 'state.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
  } catch {
    return `  - replanAttempts: not found (no state.json at ${stateJsonPath})`;
  }

  const replanAttempts = parsed?.scheduler?.replanAttempts;
  if (!replanAttempts || typeof replanAttempts !== 'object' ||
      !Object.prototype.hasOwnProperty.call(replanAttempts, canonicalId)) {
    return `  - replanAttempts: not found (no entry for '${canonicalId}' in scheduler.replanAttempts)`;
  }

  delete replanAttempts[canonicalId];
  writeJsonAtomic(stateJsonPath, parsed);
  return `  - replanAttempts: cleared (removed scheduler.replanAttempts['${canonicalId}'] from ${stateJsonPath})`;
}

/**
 * Reset item (c): analysis history. Deletes
 * `<harnessDir>/analysis/history-<canonicalId>.json`.
 *
 * @param {string} harnessDir
 * @param {string} canonicalId
 * @returns {string} one-line summary
 */
function resetAnalysisHistory(harnessDir, canonicalId) {
  const historyPath = path.join(harnessDir, 'analysis', `history-${canonicalId}.json`);
  if (!fs.existsSync(historyPath)) {
    return `  - analysis history: not found (${historyPath})`;
  }
  fs.unlinkSync(historyPath);
  return `  - analysis history: cleared (deleted ${historyPath})`;
}

/**
 * Reset item (d): snapshots. Deletes the whole directory
 * `<harnessDir>/snapshots/<taskId>/` recursively, including its `after/`
 * subdir.
 *
 * @param {string} harnessDir
 * @param {string} taskId
 * @returns {string} one-line summary
 */
function resetSnapshots(harnessDir, taskId) {
  const snapshotDir = path.join(harnessDir, 'snapshots', taskId);
  if (!fs.existsSync(snapshotDir)) {
    return `  - snapshots: not found (${snapshotDir})`;
  }
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  return `  - snapshots: cleared (deleted ${snapshotDir})`;
}

/**
 * `cc-orch reset <taskId>` — resets a task's recorded state so it can be
 * re-attempted.
 *
 * Resolves the active harness dir via the same resolver `resume` uses
 * (activeHarnessDir from run-context.js), then:
 *   - ERROR PATH A: if there are no `state/mission-*.json` files at all
 *     under the resolved harness dir, writes a "no active run harness
 *     found"-class message to stderr naming the resolved dir, sets
 *     `process.exitCode = 1`, and returns without mutating anything.
 *   - ERROR PATH B: if mission files exist but none contains `taskId`,
 *     writes an "unknown task id" message to stderr naming the id and
 *     listing the scanned mission files, sets `process.exitCode = 1`, and
 *     returns without mutating anything.
 *   - Otherwise, resolution succeeds and four independent reset
 *     operations run (mission state, replanAttempts, analysis history,
 *     snapshots), each printing one per-item summary line, followed by a
 *     caution line. `process.exitCode` is left at its default (0) — a
 *     not-found outcome on any item is not an error.
 *
 * @param {string} projectRoot
 * @param {string} taskId
 */
export function reset(projectRoot, taskId) {
  const harnessDir = activeHarnessDir(projectRoot);

  const missionFiles = listMissionFiles(harnessDir);

  if (missionFiles.length === 0) {
    console.error(
      `No active run harness found at ${harnessDir}: no state/mission-*.json files exist. ` +
      `Run cc-orch run <spec-path> to start a run before using reset.`
    );
    process.exitCode = 1;
    return;
  }

  const location = findTaskLocation(harnessDir, taskId);

  if (location === null) {
    console.error(
      `Unknown task id '${taskId}': not found in any mission state file. Scanned:\n` +
      missionFiles.map((f) => `  - ${f}`).join('\n')
    );
    process.exitCode = 1;
    return;
  }

  // Resolution succeeded; run the four independent reset operations,
  // printing one per-item summary line each. A not-found outcome on any
  // item is not an error and does not affect process.exitCode.
  const canonicalId = canonicalTaskId(taskId);

  console.log(resetMissionState(location, taskId));
  console.log(resetReplanAttempts(harnessDir, canonicalId));
  console.log(resetAnalysisHistory(harnessDir, canonicalId));
  console.log(resetSnapshots(harnessDir, taskId));
  console.log(
    'CAUTION: cc-orch reset must only be run while no run process is live ' +
    '(no active `cc-orch run`/`cc-orch resume` process for this harness).'
  );
}
