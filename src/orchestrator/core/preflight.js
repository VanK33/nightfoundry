/**
 * preflight.js — Structural integrity validation for .harness/.
 *
 * Replaces preflight-check.sh from the original harness-orchestrator skill.
 * Runs after bootstrap and on resume. Catches corruption, hand-editing
 * mistakes, and invariant violations that the state machine cannot detect
 * at transition time.
 *
 * Enforces:
 *   I7  — milestone key format \d{3}
 *   I8  — mission key format \d{3}-\d{3}
 *   I9  — sub-mission key format \d{3}-\d{3}-\d{3}
 *   I10 — task key format \d{3}-\d{3}-\d{3}-\d{3}
 *   I11 — field is `description`, not `title` (warning only, per S2)
 *   I12 — each mission's stateFile must exist on disk
 *
 * Does NOT enforce:
 *   - Task-level file references (verifyFile/progressFile/verificationFile)
 *     — these are created lazily during execution.
 *   - Dependency graph (planner's responsibility at plan time).
 *   - Target-file existence on disk (executor creates them).
 *
 * Public API:
 *   preflight(harnessDir, config?) → { ok, errors, warnings }
 *     config.projectRoot (optional) — when supplied, SHARED_SUBDIRS
 *     (learning/, dry-run/, brainstorm/) are checked under
 *     harnessRoot(config.projectRoot) instead of harnessDir, so a per-run
 *     harnessDir (.harness/run-{id}/) validates correctly against the
 *     flat shared root. When omitted, harnessDir is used for both checks
 *     (legacy flat-layout bootstrap, where harnessDir already contains
 *     every subdir).
 *
 * Does not throw — caller decides policy based on errors/warnings.
 */
import fs from 'fs';
import path from 'path';
import { PER_RUN_SUBDIRS, SHARED_SUBDIRS } from './bootstrap.js';
import { harnessRoot } from './run-context.js';
import { resolveHarnessFileRef } from './state.js';

const MILESTONE_ID = /^\d{3}$/;
const MISSION_ID = /^\d{3}-\d{3}$/;
const SUB_MISSION_ID = /^\d{3}-\d{3}-\d{3}$/;
const TASK_ID = /^\d{3}-\d{3}-\d{3}-\d{3}(-rp-\d+)*$/;

const VALID_GLOBAL_STATUS = new Set(['active', 'complete', 'paused']);

const VALID_NODE_STATUS = new Set([
  'pending',
  'in_progress',
  'awaiting_verification',
  'verified',
  'complete',
  'failed',
  'blocked',
  'invalidated',
  'needs_revalidation',
]);

export function preflight(harnessDir, config = {}) {
  const errors = [];
  const warnings = [];

  // 1. .harness/ directory exists
  if (!fs.existsSync(harnessDir)) {
    errors.push(`Harness directory does not exist: ${harnessDir}`);
    return { ok: false, errors, warnings };
  }

  // 1b. sharedOnly mode: validate only the flat shared harness surface
  // (SHARED_SUBDIRS directly under harnessDir) produced by
  // ensureSharedSkeleton, skipping PER_RUN_SUBDIRS, state.json, and the
  // milestone walk entirely.
  if (config.sharedOnly) {
    for (const sub of SHARED_SUBDIRS) {
      if (!fs.existsSync(path.join(harnessDir, sub))) {
        errors.push(`Missing subdirectory: ${sub}/`);
      }
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  // 2. All expected subdirectories exist.
  //
  // Per-run harness dirs (.harness/run-{id}/, after _repointHarness()) hold
  // only PER_RUN_SUBDIRS; SHARED_SUBDIRS (learning/, dry-run/, brainstorm/)
  // live at the flat harnessRoot(projectRoot) and persist across runs. Check
  // each set against the directory that actually owns it.
  //
  // When config.projectRoot is not supplied, fall back to harnessDir itself
  // as the shared-subdir root — this keeps the legacy flat-layout (no-runId
  // bootstrap) case, where harnessDir already IS the flat harnessRoot and
  // contains every subdir, passing byte-for-byte.
  const sharedRoot = config.projectRoot ? harnessRoot(config.projectRoot) : harnessDir;

  for (const sub of PER_RUN_SUBDIRS) {
    if (!fs.existsSync(path.join(harnessDir, sub))) {
      errors.push(`Missing subdirectory: ${sub}/`);
    }
  }
  for (const sub of SHARED_SUBDIRS) {
    if (!fs.existsSync(path.join(sharedRoot, sub))) {
      errors.push(`Missing subdirectory: ${sub}/`);
    }
  }

  // 3. state.json exists and parses
  const stateJsonPath = path.join(harnessDir, 'state.json');
  if (!fs.existsSync(stateJsonPath)) {
    errors.push(`Missing state.json at ${stateJsonPath}`);
    return { ok: errors.length === 0, errors, warnings };
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
  } catch (err) {
    errors.push(`state.json is not valid JSON: ${err.message}`);
    return { ok: false, errors, warnings };
  }

  // 4. Top-level structure
  if (!state.projectMeta || typeof state.projectMeta !== 'object') {
    errors.push(`state.json missing projectMeta`);
  } else {
    if (typeof state.projectMeta.currentPhase !== 'string') {
      errors.push(`state.json.projectMeta.currentPhase must be a string`);
    }
  }

  if (state.globalStatus !== undefined && !VALID_GLOBAL_STATUS.has(state.globalStatus)) {
    errors.push(
      `state.json.globalStatus must be one of ${[...VALID_GLOBAL_STATUS].join('|')}, ` +
      `got "${state.globalStatus}"`
    );
  }

  if (!state.milestones || typeof state.milestones !== 'object') {
    errors.push(`state.json missing milestones object`);
    return { ok: false, errors, warnings };
  }

  // 5. Walk milestones → missions → sub-missions → tasks
  for (const [msKey, milestone] of Object.entries(state.milestones)) {
    // I7 / S1: milestone key format
    if (msKey.startsWith('milestone-')) {
      warnings.push(`Milestone key "${msKey}" uses non-standard "milestone-" prefix (S1)`);
    } else if (!MILESTONE_ID.test(msKey)) {
      errors.push(`Milestone key "${msKey}" does not match \\d{3} format (I7)`);
    }

    // S2 / I11: title vs description on milestone
    if (milestone.title && !milestone.description) {
      warnings.push(`Milestone ${msKey} uses "title" instead of "description" (S2)`);
    }

    // Status enum on milestone
    if (milestone.status !== undefined && !VALID_NODE_STATUS.has(milestone.status)) {
      warnings.push(`Milestone ${msKey} has unknown status "${milestone.status}" (S4)`);
    }

    if (!milestone.missions || typeof milestone.missions !== 'object') {
      continue;
    }

    for (const [miKey, mission] of Object.entries(milestone.missions)) {
      // I8: mission key format
      if (!MISSION_ID.test(miKey)) {
        errors.push(`Mission key "${miKey}" does not match \\d{3}-\\d{3} format (I8)`);
      }

      // S2 / I11: title vs description on mission
      if (mission.title && !mission.description) {
        warnings.push(`Mission ${miKey} uses "title" instead of "description" (S2)`);
      }

      // Status enum on mission
      if (mission.status !== undefined && !VALID_NODE_STATUS.has(mission.status)) {
        warnings.push(`Mission ${miKey} has unknown status "${mission.status}" (S4)`);
      }

      // I12: mission state file must exist (if path is declared)
      if (mission.stateFile) {
        const missionFilePath = resolveHarnessFileRef(harnessDir, mission.stateFile);

        if (!fs.existsSync(missionFilePath)) {
          // Soft: missing mission state file is a warning, not an error (S3).
          // The mission may not yet have been decomposed (lazy DFS).
          warnings.push(`Mission ${miKey} state file not found: ${mission.stateFile} (S3)`);
          continue;
        }

        // Parse the mission state file and validate its contents.
        let missionState;
        try {
          missionState = JSON.parse(fs.readFileSync(missionFilePath, 'utf8'));
        } catch (err) {
          errors.push(`Mission ${miKey} state file is not valid JSON: ${err.message}`);
          continue;
        }

        if (missionState.status !== undefined && !VALID_NODE_STATUS.has(missionState.status)) {
          warnings.push(
            `Mission ${miKey} state file has unknown status "${missionState.status}" (S4)`
          );
        }

        if (!missionState.subMissions || typeof missionState.subMissions !== 'object') {
          continue;
        }

        for (const [smKey, subMission] of Object.entries(missionState.subMissions)) {
          // I9: sub-mission key format
          if (!SUB_MISSION_ID.test(smKey)) {
            errors.push(
              `Sub-mission key "${smKey}" does not match \\d{3}-\\d{3}-\\d{3} format (I9)`
            );
          }

          if (subMission.title && !subMission.description) {
            warnings.push(`Sub-mission ${smKey} uses "title" instead of "description" (S2)`);
          }

          if (subMission.status !== undefined && !VALID_NODE_STATUS.has(subMission.status)) {
            warnings.push(`Sub-mission ${smKey} has unknown status "${subMission.status}" (S4)`);
          }

          if (!subMission.tasks || typeof subMission.tasks !== 'object') {
            continue;
          }

          for (const [taskKey, task] of Object.entries(subMission.tasks)) {
            // I10: task key format
            if (!TASK_ID.test(taskKey)) {
              errors.push(
                `Task key "${taskKey}" does not match \\d{3}-\\d{3}-\\d{3}-\\d{3} format (I10)`
              );
            }

            if (task.title && !task.description) {
              warnings.push(`Task ${taskKey} uses "title" instead of "description" (S2)`);
            }

            if (task.status !== undefined && !VALID_NODE_STATUS.has(task.status)) {
              warnings.push(`Task ${taskKey} has unknown status "${task.status}" (S4)`);
            }
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
