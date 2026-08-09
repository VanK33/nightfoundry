/**
 * verification-helpers.js — Stateless verification-gate helpers extracted
 * from pipeline.js's Pipeline methods.
 *
 * Every function here is a pure/explicit-parameter translation of the
 * corresponding Pipeline._X method: all `this.X` dependencies become
 * leading parameters, and there is no module-level state.
 */
import fs from 'fs';
import path from 'path';
import { writeJsonAtomic, resolveHarnessFileRef } from './state.js';
import { resolveVerificationSidecar } from './state-machine.js';
import { readAffectedFiles } from './snapshots.js';
import { checkTestRegistration } from '../gates/test-registration.js';
import { runHardChecks } from '../gates/hard-checks.js';
import { formatBanner } from './banner.js';
import { normalizeTargetFile } from './path-utils.js';

/**
 * Read the flat exemption list from <projectRoot>/scripts/test-exemptions.json
 * and return the set of exempted candidate files normalised to absolute paths.
 * Fail-soft: any missing file, unreadable file, invalid JSON, non-array
 * top-level value, or malformed entry yields an empty set — this must never
 * throw out of runTestRegistrationGate.
 * @param {string} projectRoot
 * @returns {Set<string>}
 */
function readTestExemptionSet(projectRoot) {
  const exemptSet = new Set();
  try {
    const exemptionsPath = path.join(projectRoot, 'scripts', 'test-exemptions.json');
    if (!fs.existsSync(exemptionsPath)) return exemptSet;
    const parsed = JSON.parse(fs.readFileSync(exemptionsPath, 'utf8'));
    if (!Array.isArray(parsed)) return exemptSet;
    for (const entry of parsed) {
      if (entry && typeof entry.file === 'string' && entry.file.length > 0) {
        exemptSet.add(normalizeTargetFile(projectRoot, entry.file));
      }
    }
  } catch {
    return new Set();
  }
  return exemptSet;
}

/**
 * Run the test-registration gate for a single task.
 * Computes the file set as the union of task.targetFiles and readAffectedFiles,
 * removes any candidates listed in scripts/test-exemptions.json, then delegates
 * to checkTestRegistration.
 * @param {object} task
 * @param {string} harnessDir
 * @param {string} projectRoot
 * @param {function} onLog
 * @returns {{ passed: boolean, violations: string[] }}
 */
export async function runTestRegistrationGate(task, harnessDir, projectRoot, onLog) {
  const fileSet = [...new Set([...(task.targetFiles || []), ...readAffectedFiles(harnessDir, task.id)])];
  const exemptSet = readTestExemptionSet(projectRoot);
  const candidateFiles = exemptSet.size === 0
    ? fileSet
    : fileSet.filter(f => !exemptSet.has(normalizeTargetFile(projectRoot, f)));
  const result = await checkTestRegistration(candidateFiles, harnessDir, projectRoot);
  if (result.notApplicable) {
    onLog(`    Task ${task.id}: test-registration gate not applicable (no scripts/run-tests.js manifest in this project) — skipped`);
  }
  return result;
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
export function recordGateOverride(harnessDir, taskId, gate, evidence) {
  try {
    const sidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    if (!Array.isArray(sidecar.gateOverrides)) sidecar.gateOverrides = [];
    sidecar.gateOverrides.push({ gate, evidence, at: new Date().toISOString() });
    writeJsonAtomic(sidecarPath, sidecar);
  } catch {
    // sidecar absent or unreadable — the run log still carries the evidence
  }
}

export async function applyHardCheckGate(task, verifyResult, label, harnessDir, projectRoot, onLog, deps = {}) {
  let hardCheckGate = null;
  let hardCheckUnavailable = false;
  try {
    hardCheckGate = await runHardChecks(harnessDir, task.id, projectRoot, deps);
  } catch (hcErr) {
    hardCheckUnavailable = true;
    onLog('    Task ' + task.id + ': hard-check gate FAILED — verify.json missing or unreadable: ' + hcErr.message);
  }

  if (hardCheckUnavailable) {
    verifyResult = { verified: false, evidence: 'hard-check gate: verify.json missing or unreadable — cannot verify task output' };
    recordGateOverride(harnessDir, task.id, 'hard-check-gate', verifyResult.evidence);
    onLog('    Task ' + task.id + ': hard-check gate FAILED — overriding ' + label + ' to FAILED');
  } else if (hardCheckGate && !hardCheckGate.passed) {
    verifyResult = { verified: false, evidence: 'js-hardCheck mismatch', hardCheckReportPath: hardCheckGate.reportPath };
    recordGateOverride(harnessDir, task.id, 'hard-check-gate', `js-hardCheck mismatch — report: ${hardCheckGate.reportPath}`);
    onLog('    Task ' + task.id + ': hard-check gate FAILED — overriding ' + label + ' to FAILED');
  }
  return verifyResult;
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
export function formatBannerLines(prefix, id, description, opts = {}) {
  return formatBanner(prefix, id, description, opts);
}

export function writeVerificationSummary(msId, harnessDir, onLog) {
  try {
    const stateJsonPath = path.join(harnessDir, 'state.json');
    if (!fs.existsSync(stateJsonPath)) return;

    const state = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
    const milestone = state.milestones?.[msId];
    if (!milestone) return;

    const tasks = [];

    for (const mission of Object.values(milestone.missions || {})) {
      if (!mission.stateFile) continue;
      const missionFile = resolveHarnessFileRef(harnessDir, mission.stateFile);
      if (!fs.existsSync(missionFile)) continue;

      let missionState;
      try {
        missionState = JSON.parse(fs.readFileSync(missionFile, 'utf8'));
      } catch {
        continue;
      }

      for (const subMission of Object.values(missionState.subMissions || {})) {
        for (const [taskId, task] of Object.entries(subMission.tasks || {})) {
          if (task.status !== 'complete') continue;

          const sidecar = parseVerificationSidecar(harnessDir, taskId);
          tasks.push({
            taskId,
            result: sidecar?.result ?? null,
            hardChecks: sidecar?.hardChecks ?? [],
            taskScopeChecks: sidecar?.taskScopeChecks ?? [],
            notes: sidecar?.notes ?? null,
          });
        }
      }
    }

    const passed = tasks.filter(t => t.result === 'PASSED').length;
    const failed = tasks.filter(t => t.result === 'FAILED').length;

    const summary = {
      milestoneId: msId,
      timestamp: new Date().toISOString(),
      tasks,
      summary: {
        total: tasks.length,
        passed,
        failed,
      },
    };

    const verificationDir = path.join(harnessDir, 'verification');
    fs.mkdirSync(verificationDir, { recursive: true });
    fs.writeFileSync(
      path.join(verificationDir, `milestone-summary-${msId}.json`),
      JSON.stringify(summary, null, 2)
    );
  } catch (err) {
    onLog(`  [WARN] Could not write verification summary for milestone ${msId}: ${err.message}`);
  }
}

export function parseVerificationSidecar(harnessDir, taskId) {
  try {
    const resolved = resolveVerificationSidecar(harnessDir, taskId);
    if (!resolved) return null;
    const data = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
    return data;
  } catch {
    return null;
  }
}

export function logVerifierPassCounts(taskId, label, harnessDir, onLog) {
  const sidecar = parseVerificationSidecar(harnessDir, taskId);
  if (sidecar) {
    const hc = sidecar.hardChecks || [];
    const sc = sidecar.taskScopeChecks || [];
    const hcPassed = hc.filter(c => c.status === 'PASS').length;
    const scPassed = sc.filter(c => c.status === 'PASS').length;
    onLog('    Task ' + taskId + ': ' + label + ' (hardChecks: ' + hcPassed + '/' + hc.length + ' passed, scopeChecks: ' + scPassed + '/' + sc.length + ' passed)');
  } else {
    onLog('    Task ' + taskId + ': ' + label);
  }
}

export function writeElapsedToSidecar(harnessDir, taskId, field, elapsedMs) {
  try {
    const sidecarPath = path.join(harnessDir, 'progress', `task-${taskId}.json`);
    let existing = {};
    if (fs.existsSync(sidecarPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      } catch {
        existing = {};
      }
    }
    existing[field] = elapsedMs;
    fs.writeFileSync(sidecarPath, JSON.stringify(existing, null, 2));
  } catch {
    // Never crash the pipeline due to sidecar write failures
  }
}
