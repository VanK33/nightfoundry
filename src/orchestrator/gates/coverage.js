/**
 * coverage.js — Scenario coverage check (Phase 3b-2.5).
 *
 * Pure JS. Extracts scenarios from the spec markdown, collects covered
 * IDs from the mission state's task annotations, diffs them, and
 * dispatches the remediation planner if gaps are found.
 *
 * Replaces the shell-based check-scenario-coverage.sh dispatch.
 *
 * Public API:
 *   checkMilestoneCoverage({ harnessDir, projectRoot, missionIds,
 *                            planner, onLog, onConfirm, autoMode })
 *   checkTaskIdCollision(harnessDir, taskId, onLog)
 *   mergeRemediationTasks({ harnessDir, missionId, newTasks,
 *                           missionDecomp })
 */
import fs from 'fs';
import path from 'path';
import { askYesNo } from '../../cli/prompt.js';
import {
  extractScenariosFromSpec,
  extractCoveredScenarios,
  diffCoverage,
} from '../core/scenario-parser.js';
import { withMissionFileLock } from '../core/state-machine.js';
import { HaltError } from '../core/halt-error.js';
import { TaskIdCollisionError } from '../core/task-id-collision-error.js';

/**
 * Check whether `taskId` already exists in any sub-mission across all
 * mission state files found in `harnessDir/state`. Throws
 * `TaskIdCollisionError` if a duplicate is detected.
 *
 * @param {string} harnessDir  - absolute path to the .harness directory
 * @param {string} taskId      - the task id to check for collision
 * @param {Function|null} onLog - optional log emitter
 */
export function checkTaskIdCollision(harnessDir, taskId, onLog) {
  const stateDir = path.join(harnessDir, 'state');
  if (!fs.existsSync(stateDir)) return;

  const files = fs.readdirSync(stateDir).filter((f) => /^mission-.+\.json$/.test(f));

  for (const file of files) {
    const filePath = path.join(stateDir, file);
    let missionState;
    try {
      missionState = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      // Skip unreadable or malformed state files.
      continue;
    }

    const subMissions = missionState.subMissions || {};
    for (const [smId, sm] of Object.entries(subMissions)) {
      const tasks = sm.tasks || {};
      if (Object.prototype.hasOwnProperty.call(tasks, taskId)) {
        const missionId = missionState.missionId || file.replace(/^mission-/, '').replace(/\.json$/, '');
        const locationString = `mission:${missionId}/subMission:${smId}`;
        onLog?.(`[id-collision] Task id '${taskId}' already exists at '${locationString}'.`);
        throw new TaskIdCollisionError(taskId, locationString);
      }
    }
  }
}

/** Pattern for a valid 4-segment task id: NNN-NNN-NNN-NNN */
const ID_PATTERN = /^\d{3}(-\d{3}){3}$/;

/**
 * Normalize a task's id to the 4-segment format if it doesn't already match.
 * Rewrites to `${task.subMissionId}-NNN` choosing the lowest sequence number
 * that doesn't collide with existingIds (already in state) or batchIds
 * (assigned earlier in this batch).  Mutates task.id in place.
 * Emits a log line via logFn when a rewrite occurs.
 *
 * @param {object} task
 * @param {Set<string>} existingIds  task ids already present in the target sub-mission
 * @param {Set<string>} batchIds     task ids already assigned in the current batch
 * @param {Function|null} logFn
 * @param {string|undefined} harnessDir  optional path to .harness dir for cross-mission collision check
 */
function normalizeTaskId(task, existingIds, batchIds, logFn, harnessDir) {
  if (ID_PATTERN.test(task.id)) {
    // Format is valid — but still check for collision before accepting as-is.
    let collides = existingIds.has(task.id) || batchIds.has(task.id);
    let collisionLocation = null;
    if (!collides && harnessDir) {
      try {
        checkTaskIdCollision(harnessDir, task.id, null);
      } catch (err) {
        if (err instanceof TaskIdCollisionError) {
          collides = true;
          collisionLocation = err.existingLocation;
        } else throw err;
      }
    }
    const prefixMatches = task.id.startsWith(`${task.subMissionId}-`);
    // Quadrant 1: !collides && prefixMatches → accept as-is.
    if (!collides && prefixMatches) {
      batchIds.add(task.id);
      return;
    }
    // Quadrant 2: collides && !prefixMatches → cross-namespace collision, surface it.
    if (collides && !prefixMatches) {
      throw new TaskIdCollisionError(task.id, collisionLocation || `subMission:${task.subMissionId}`);
    }
    // Quadrant 3: !collides && !prefixMatches → orphan re-parent, fall through to rename loop.
    if (!collides && !prefixMatches) {
      const emit = logFn || ((msg) => console.log(msg));
      emit(`[id-normalize] Orphan re-parent: '${task.id}' prefix does not match subMissionId '${task.subMissionId}'`);
    }
    // Quadrant 4: collides && prefixMatches → benign same-namespace collision, fall through to rename loop.
  }
  const oldId = task.id;
  let seq = 1;
  let candidate;
  let crossMissionCollision;
  do {
    crossMissionCollision = false;
    candidate = `${task.subMissionId}-${String(seq).padStart(3, '0')}`;
    seq++;
    if (harnessDir) {
      try {
        checkTaskIdCollision(harnessDir, candidate, null);
      } catch (err) {
        if (err instanceof TaskIdCollisionError) {
          crossMissionCollision = true;
        } else {
          throw err;
        }
      }
    }
  } while (existingIds.has(candidate) || batchIds.has(candidate) || crossMissionCollision);
  task.id = candidate;
  batchIds.add(candidate);
  const emit = logFn || ((msg) => console.log(msg));
  emit(`[id-normalize] Rewrote task id '${oldId}' → '${task.id}'`);
}

/**
 * Returns true iff every id in `uncovered` is addressed by the remediation:
 * either listed in `remediation.outOfScope[].scenarioId` or spread across
 * `remediation.newTasks[].tracesScenario` (only when that field is an array).
 * Vacuously true when `uncovered` is empty.
 *
 * @param {string[]} uncovered   - scenario ids not yet covered
 * @param {object|null|undefined} remediation - planner response object
 * @returns {boolean}
 */
export function remediationClosesCoverage(uncovered, remediation) {
  const addressed = new Set();
  if (Array.isArray(remediation?.outOfScope)) {
    for (const oos of remediation.outOfScope) {
      addressed.add(oos.scenarioId);
    }
  }
  if (Array.isArray(remediation?.newTasks)) {
    for (const task of remediation.newTasks) {
      if (Array.isArray(task.tracesScenario)) {
        for (const id of task.tracesScenario) {
          addressed.add(id);
        }
      }
    }
  }
  return uncovered.every((id) => addressed.has(id));
}

/**
 * Milestone-level scenario coverage check. Called ONCE after all
 * missions in a milestone are planned (Phase A of the parallel path)
 * instead of N times per mission. Aggregates tracesScenario across
 * all missions' tasks before diffing against the spec — so cross-
 * cutting scenarios that are covered by DIFFERENT missions are
 * correctly identified as "covered" and don't trigger remediation.
 *
 * This eliminates the per-mission remediation waste observed in
 * dogfoods 5 and 6: each mission spawned a $0.40 remediation planner
 * that marked 5-6 scenarios as "out of scope" (owned by sibling
 * missions). With milestone-level checking, the remediation fires
 * 0 times (if all scenarios are covered collectively) or 1 time
 * (if there are genuine gaps), saving $2-3 per dogfood.
 */
export async function checkMilestoneCoverage({
  harnessDir, projectRoot, missionIds, planner, onLog, onConfirm, autoMode,
}) {
  const stateJson = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
  const specPath = stateJson.projectMeta.prdPath;

  if (!specPath || !fs.existsSync(path.resolve(projectRoot, specPath))) {
    return;
  }

  const resolvedSpecPath = path.resolve(projectRoot, specPath);
  const specMarkdown = fs.readFileSync(resolvedSpecPath, 'utf8');
  const specScenarios = extractScenariosFromSpec(specMarkdown);

  if (specScenarios.length === 0) {
    onLog(`  Milestone scenario coverage: spec declares no scenarios, skipping.`);
    return;
  }

  // Aggregate coverage across ALL missions in the milestone.
  const aggregateCovered = new Set();
  for (const missionId of missionIds) {
    const missionStateFile = path.join(harnessDir, 'state', `mission-${missionId}.json`);
    if (!fs.existsSync(missionStateFile)) continue;
    const missionState = JSON.parse(fs.readFileSync(missionStateFile, 'utf8'));
    const missionCovered = extractCoveredScenarios(missionState);
    for (const id of missionCovered) aggregateCovered.add(id);
  }

  const { uncovered } = diffCoverage(specScenarios, aggregateCovered);

  if (uncovered.length === 0) {
    onLog(`  Milestone scenario coverage: all ${specScenarios.length} scenarios covered across ${missionIds.length} missions.`);
    return;
  }

  onLog(`  Milestone scenario coverage: ${uncovered.length} uncovered scenario(s) after checking all ${missionIds.length} missions:`);
  for (const id of uncovered) {
    onLog(`    - ${id}`);
  }

  // Spawn ONE remediation planner for the whole milestone. Assign
  // new tasks to the first mission (the planner can override via
  // subMissionId if it wants a different target).
  const targetMissionId = missionIds[0];
  const planPath = path.join(harnessDir, 'plan', `mission-${targetMissionId}.md`);
  const missionPlan = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : '';

  onLog(`  Spawning remediation planner for milestone-level gaps...`);
  const remediation = await planner.remediateScenarios(targetMissionId, projectRoot, {
    uncoveredScenarios: uncovered,
    missionPlan,
  });

  if (remediation.outOfScope?.length) {
    onLog(`  Out-of-scope scenarios:`);
    for (const oos of remediation.outOfScope) {
      onLog(`    ${oos.scenarioId}: ${oos.justification}`);
    }
  }

  if (remediation.newTasks?.length) {
    onLog(`  Adding ${remediation.newTasks.length} new task(s) for uncovered scenarios...`);
    const missionStateFile = path.join(harnessDir, 'state', `mission-${targetMissionId}.json`);
    const missionState = JSON.parse(fs.readFileSync(missionStateFile, 'utf8'));
    const { stateToDecomp } = await import('../core/state.js');
    const missionDecomp = stateToDecomp(missionState);
    await mergeRemediationTasks({ harnessDir, missionId: targetMissionId, newTasks: remediation.newTasks, missionDecomp });
  }

  if (!remediationClosesCoverage(uncovered, remediation)) {
    onLog(`  Milestone scenario coverage: some gaps remain after remediation.`);
    const question = 'Some spec scenarios are still uncovered. Proceed anyway?';
    let proceed;
    if (autoMode) {
      if (process.stdout.isTTY) {
        proceed = await askYesNo(question);
      } else {
        throw new HaltError('coverage-checkMilestoneCoverage', 'non-TTY cannot prompt for milestone coverage confirmation');
      }
    } else {
      proceed = await onConfirm(question);
    }
    if (!proceed) {
      throw new Error('Milestone scenario coverage check failed. User declined to proceed.');
    }
  }
}

export async function mergeRemediationTasks({ harnessDir, missionId, newTasks, missionDecomp, onLog }) {
  // Phase I items 4+5: serialize mission-state writes through the
  // state-machine's per-mission-file mutex. Before this, concurrent
  // callers (e.g. a scheduler worker's transitionTask and a
  // simultaneous coverage remediation pass on the same mission) could
  // race through the load-modify-write and lose updates. Reusing the
  // state-machine's mutex ensures the same file path is protected by
  // the same lock regardless of which module writes it.
  return withMissionFileLock(harnessDir, missionId, async () => {
    const stateFile = path.join(harnessDir, 'state', `mission-${missionId}.json`);
    const missionState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

    // Track ids assigned during this batch to avoid intra-batch collisions.
    const batchUsedIds = new Set();

    for (const task of newTasks) {
      const smId = task.subMissionId;
      if (!missionState.subMissions[smId]) {
        // Fall back to the first sub-mission if the remediation planner
        // picked an ID that doesn't exist.
        const firstSmId = Object.keys(missionState.subMissions).sort()[0];
        if (!firstSmId) continue;
        task.subMissionId = firstSmId;
        onLog?.(`  Warning: task ${task.id} in mission ${missionId} referenced unknown subMissionId "${smId}"; falling back to "${firstSmId}".`);
      }

      const targetSm = missionState.subMissions[task.subMissionId];
      if (!targetSm) continue;

      // --- Layer 1: id normalization ---
      // Rewrite non-conforming ids to `subMissionId-NNN` before writing
      // to state, choosing the next sequence slot that avoids collisions
      // with existing tasks in that sub-mission and earlier tasks in this
      // batch.
      normalizeTaskId(
        task,
        new Set(Object.keys(targetSm.tasks)),
        batchUsedIds,
        onLog || null,
        harnessDir,
      );
      // --- end id normalization ---

      // --- Layer 2: cross-mission collision check ---
      // Throws TaskIdCollisionError if task.id already exists in any
      // other mission's state file, preventing silent overwrites.
      checkTaskIdCollision(harnessDir, task.id, onLog || null);
      // --- end collision check ---

      targetSm.tasks[task.id] = {
        id: task.id,
        description: task.description,
        status: 'pending',
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        targetFiles: task.targetFiles || [],
        dependencies: [],
        testCases: task.testCases || [],
        tracesScenario: task.tracesScenario || [],
        // Context enrichment (Phase I item 2) — remediation tasks from
        // scenario coverage may or may not have enrichment fields.
        // Preserve them if present so this path matches writeMissionState.
        patternReferences: task.patternReferences || [],
        dataSchemas: task.dataSchemas || [],
        verifyFile: `verify/task-${task.id}.json`,
        progressFile: `progress/task-${task.id}.json`,
        verificationFile: `verification/task-${task.id}.json`,
        retryCount: 0,
      };

      // Write a stub verify.json for the new task.
      const verifyDir = path.join(harnessDir, 'verify');
      fs.mkdirSync(verifyDir, { recursive: true });
      fs.writeFileSync(
        path.join(verifyDir, `task-${task.id}.json`),
        JSON.stringify({
          taskId: task.id,
          targetFiles: task.targetFiles || [],
          hardChecks: [],
          testCases: (task.testCases || []).map((tc, i) => ({ id: `TC${i + 1}`, description: tc })),
        }, null, 2)
      );

      const decompSm = missionDecomp.subMissions.find((s) => s.id === task.subMissionId);
      if (decompSm) {
        decompSm.tasks.push(task);
      }
    }

    fs.writeFileSync(stateFile, JSON.stringify(missionState, null, 2));
  });
}
