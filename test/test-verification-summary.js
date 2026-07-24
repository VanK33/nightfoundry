/**
 * test-verification-summary.js — Unit tests for milestone verification summary logic.
 *
 * Tests the summary-writing logic extracted from pipeline.js's
 * _writeVerificationSummary method. No Claude auth, no SDK.
 *
 * Run: node test/test-verification-summary.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verification-summary-'));
}

function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

// ── Summary logic extracted for testability ─────────────────────────────────
//
// Mirrors pipeline.js _writeVerificationSummary + _parseVerificationSidecar.
// Keeping it here makes the logic unit-testable without instantiating Pipeline.

function parseVerificationSidecar(harnessDir, taskId) {
  try {
    const sidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);
    if (!fs.existsSync(sidecarPath)) return null;
    return JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeVerificationSummary(harnessDir, msId) {
  const stateJsonPath = path.join(harnessDir, 'state.json');
  if (!fs.existsSync(stateJsonPath)) return null;

  const state = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
  const milestone = state.milestones?.[msId];
  if (!milestone) return null;

  const tasks = [];

  for (const mission of Object.values(milestone.missions || {})) {
    if (!mission.stateFile) continue;
    const missionFile = path.isAbsolute(mission.stateFile)
      ? mission.stateFile
      : path.join(harnessDir, '..', mission.stateFile);
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

  return summary;
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

/**
 * Seed state.json + mission state for a set of tasks.
 * taskEntries: array of { id, result } where result is:
 *   - 'PASSED' | 'FAILED' → write sidecar with that result
 *   - null                → skip writing sidecar (simulate missing)
 */
function seedMilestone(harnessDir, taskEntries) {
  const state = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
  state.milestones['001'] = {
    id: '001',
    description: 'test milestone',
    status: 'complete',
    missions: {
      '001-001': {
        id: '001-001',
        description: 'test mission',
        status: 'complete',
        stateFile: '.harness/state/mission-001-001.json',
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  const tasks = {};
  for (const entry of taskEntries) {
    const { id, result } = entry;
    tasks[id] = { id, description: `task ${id}`, status: 'complete' };

    if (result !== null) {
      fs.writeFileSync(
        path.join(harnessDir, 'verification', `task-${id}.json`),
        JSON.stringify({
          taskId: id,
          result,
          hardChecks: [],
          taskScopeChecks: [],
          notes: 'test fixture',
        }, null, 2)
      );
    }
  }

  const missionState = {
    id: '001-001',
    missionId: '001-001',
    status: 'complete',
    subMissions: {
      '001-001-001': {
        id: '001-001-001',
        status: 'complete',
        tasks,
      },
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state', 'mission-001-001.json'),
    JSON.stringify(missionState, null, 2)
  );
}

// ── TC1: Two passing tasks ───────────────────────────────────────────────────

test('TC1: two passing tasks → summary has total:2, passed:2, failed:0', () => {
  const root = tempDir();
  try {
    const { harnessDir } = bootstrap(root);
    seedMilestone(harnessDir, [
      { id: '001-001-001-001', result: 'PASSED' },
      { id: '001-001-001-002', result: 'PASSED' },
    ]);

    const summary = writeVerificationSummary(harnessDir, '001');

    assert.ok(summary, 'summary should be returned');
    assert.equal(summary.summary.total, 2, 'total should be 2');
    assert.equal(summary.summary.passed, 2, 'passed should be 2');
    assert.equal(summary.summary.failed, 0, 'failed should be 0');

    // Also verify the file was written correctly
    const filePath = path.join(harnessDir, 'verification', 'milestone-summary-001.json');
    assert.ok(fs.existsSync(filePath), 'milestone-summary file should exist on disk');
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.summary.total, 2);
    assert.equal(written.summary.passed, 2);
    assert.equal(written.summary.failed, 0);
  } finally { cleanup(root); }
});

// ── TC2: Two passing, one failing ───────────────────────────────────────────

test('TC2: two passing + one failing → summary has total:3, passed:2, failed:1, failed task result=FAILED', () => {
  const root = tempDir();
  try {
    const { harnessDir } = bootstrap(root);
    seedMilestone(harnessDir, [
      { id: '001-001-001-001', result: 'PASSED' },
      { id: '001-001-001-002', result: 'PASSED' },
      { id: '001-001-001-003', result: 'FAILED' },
    ]);

    const summary = writeVerificationSummary(harnessDir, '001');

    assert.ok(summary, 'summary should be returned');
    assert.equal(summary.summary.total, 3, 'total should be 3');
    assert.equal(summary.summary.passed, 2, 'passed should be 2');
    assert.equal(summary.summary.failed, 1, 'failed should be 1');

    // The failed task entry should have result=FAILED
    const failedTask = summary.tasks.find(t => t.taskId === '001-001-001-003');
    assert.ok(failedTask, 'failed task should appear in summary');
    assert.equal(failedTask.result, 'FAILED', 'failed task entry should have result=FAILED');

    // Verify on disk too
    const filePath = path.join(harnessDir, 'verification', 'milestone-summary-001.json');
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.summary.total, 3);
    assert.equal(written.summary.passed, 2);
    assert.equal(written.summary.failed, 1);
    const writtenFailed = written.tasks.find(t => t.taskId === '001-001-001-003');
    assert.equal(writtenFailed.result, 'FAILED');
  } finally { cleanup(root); }
});

// ── TC3: Missing sidecar for a completed task ────────────────────────────────

test('TC3: missing sidecar → task listed with result:null, no crash', () => {
  const root = tempDir();
  try {
    const { harnessDir } = bootstrap(root);
    seedMilestone(harnessDir, [
      { id: '001-001-001-001', result: 'PASSED' },
      { id: '001-001-001-002', result: null }, // no sidecar written
    ]);

    // Should not throw
    let summary;
    assert.doesNotThrow(() => {
      summary = writeVerificationSummary(harnessDir, '001');
    }, 'writeVerificationSummary should not throw on missing sidecar');

    assert.ok(summary, 'summary should still be returned');

    // Task with missing sidecar should appear with result:null
    const missingTask = summary.tasks.find(t => t.taskId === '001-001-001-002');
    assert.ok(missingTask, 'task with missing sidecar should appear in summary');
    assert.equal(missingTask.result, null, 'result should be null for missing sidecar');

    // Summary counts: null result doesn't count as passed or failed
    assert.equal(summary.summary.total, 2, 'total includes task with missing sidecar');
    assert.equal(summary.summary.passed, 1, 'only the task with PASSED sidecar counts');
    assert.equal(summary.summary.failed, 0, 'null result does not count as failed');
  } finally { cleanup(root); }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
