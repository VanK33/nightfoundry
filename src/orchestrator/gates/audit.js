/**
 * audit.js — Phase 5 verification audit (JS-era).
 *
 * Pure JS — no AI. Belt-and-suspenders consistency check at milestone
 * completion, run alongside the in-process state-machine enforcement.
 *
 * Walks every task under the milestone and confirms:
 *   1. The verification JSON sidecar exists on disk
 *   2. The sidecar's `result` field equals "PASSED"
 *
 * Sidecar source of truth: .harness/verification/task-{id}.json
 * (written by agents/verifier.js via jsonSchema structured output).
 *
 * Catches scenarios the state machine cannot:
 *   - Hand-edited state.json
 *   - Sidecar files deleted after transition
 *   - Crashes leaving state ahead of the verification sidecar
 *
 * Public API:
 *   auditVerification(harnessDir, milestoneId)
 *     → { total, anomalies: [{ taskId, issue }] }
 */
import fs from 'fs';
import path from 'path';
import { resolveVerificationSidecar } from '../core/state-machine.js';
import { resolveHarnessFileRef } from '../core/state.js';

export function auditVerification(harnessDir, milestoneId) {
  const stateJsonPath = path.join(harnessDir, 'state.json');
  if (!fs.existsSync(stateJsonPath)) {
    return { total: 0, anomalies: [] };
  }

  const state = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
  const milestone = state.milestones?.[milestoneId];
  if (!milestone) {
    return { total: 0, anomalies: [] };
  }

  const anomalies = [];
  const auditedTasks = [];

  for (const [miId, mission] of Object.entries(milestone.missions || {})) {
    if (!mission.stateFile) continue;
    const missionFile = resolveHarnessFileRef(harnessDir, mission.stateFile);
    if (!fs.existsSync(missionFile)) {
      anomalies.push({ taskId: `mission:${miId}`, issue: 'mission state file missing on disk' });
      continue;
    }

    let missionState;
    try {
      missionState = JSON.parse(fs.readFileSync(missionFile, 'utf8'));
    } catch {
      anomalies.push({ taskId: `mission:${miId}`, issue: 'mission state file is not valid JSON' });
      continue;
    }

    for (const subMission of Object.values(missionState.subMissions || {})) {
      for (const [taskId, task] of Object.entries(subMission.tasks || {})) {
        // Only audit tasks that reached complete.
        if (task.status !== 'complete') continue;

        auditedTasks.push(taskId);

        const resolved = resolveVerificationSidecar(harnessDir, taskId);

        if (!resolved) {
          anomalies.push({ taskId, issue: 'verification sidecar missing on disk' });
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
        } catch {
          anomalies.push({ taskId, issue: 'verification sidecar is not valid JSON' });
          continue;
        }

        if (parsed.result !== 'PASSED') {
          anomalies.push({
            taskId,
            issue: `verification sidecar result is "${parsed.result}" (expected PASSED)`,
          });
        }
      }
    }
  }

  return { total: auditedTasks.length, anomalies };
}
