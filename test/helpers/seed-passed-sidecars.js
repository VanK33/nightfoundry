/**
 * seed-passed-sidecars.js — shared test helper.
 *
 * Production reality: a leaf task only reaches status==='complete' AFTER its
 * verifier wrote a PASSED verification sidecar (state machine: verified→complete
 * requires the sidecar on disk with result:'PASSED'). The Phase-5 verification
 * audit (gates/audit.js → auditVerification) walks every complete task at
 * milestone completion and, under the warn→throw change, raises
 * VerificationAuditError if any complete task's sidecar is missing / unparseable
 * / not result:'PASSED'.
 *
 * Many synthetic fixtures mark tasks status:'complete' WITHOUT seeding a PASSED
 * sidecar (they exercise scheduler / reviewer-gate / cascade / drain wiring, not
 * task verification). This helper makes such a fixture production-realistic by
 * writing a PASSED sidecar at .harness/verification/task-{id}.json for every
 * complete task it finds in the seeded mission state object(s).
 *
 * It walks subMissions[].tasks[] (the same shape auditVerification reads via the
 * per-mission state file) and writes one sidecar per complete task. An existing
 * sidecar is left untouched so a fixture that already wrote a richer PASSED
 * sidecar is never clobbered.
 *
 * Usage — call AFTER seeding mission state and BEFORE the _executeMilestone call:
 *
 *   import { seedPassedSidecars } from './helpers/seed-passed-sidecars.js';
 *   seedPassedSidecars(harnessDir, missionStateObj);            // one mission
 *   seedPassedSidecars(harnessDir, [missionStateA, missionStateB]); // many
 *
 * The mission-state object may be the in-memory object the fixture built, or one
 * re-read from disk — only its subMissions[].tasks[] shape is used.
 */
import fs from 'fs';
import path from 'path';

/**
 * Write a PASSED verification sidecar for every complete task found in the given
 * mission state object(s).
 *
 * @param {string} harnessDir - absolute path to the .harness directory
 * @param {object|object[]} missionStates - one mission state object, or an array
 *   of them. Each must carry a subMissions map whose values carry a tasks map.
 * @param {object} [opts]
 * @param {boolean} [opts.overwrite=false] - when true, rewrite even if a sidecar
 *   already exists on disk.
 * @returns {string[]} the task ids a sidecar was written for.
 */
export function seedPassedSidecars(harnessDir, missionStates, opts = {}) {
  const { overwrite = false } = opts;
  const list = Array.isArray(missionStates) ? missionStates : [missionStates];
  const verificationDir = path.join(harnessDir, 'verification');
  fs.mkdirSync(verificationDir, { recursive: true });

  const seeded = [];
  for (const missionState of list) {
    if (!missionState || typeof missionState !== 'object') continue;
    for (const subMission of Object.values(missionState.subMissions || {})) {
      for (const [taskId, task] of Object.entries(subMission.tasks || {})) {
        if (!task || task.status !== 'complete') continue;
        const sidecarPath = path.join(verificationDir, `task-${taskId}.json`);
        if (!overwrite && fs.existsSync(sidecarPath)) continue;
        fs.writeFileSync(
          sidecarPath,
          JSON.stringify({
            taskId,
            result: 'PASSED',
            verified: true,
            report: 'test fixture PASSED sidecar',
            hardChecks: [],
            taskScopeChecks: [],
            notes: 'seeded by seed-passed-sidecars helper',
          }, null, 2)
        );
        seeded.push(taskId);
      }
    }
  }
  return seeded;
}
