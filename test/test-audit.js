/**
 * test-audit.js — Unit tests for audit.js.
 *
 * No Claude auth, no SDK. Pure fs + temp directories.
 * Run: node test/test-audit.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';
import { auditVerification } from '../src/orchestrator/gates/audit.js';

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

function createProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
}

function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

function seedMilestone(harnessDir, { taskStatuses = ['complete'], writeReports = true } = {}) {
  const state = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
  state.milestones['001'] = {
    id: '001',
    description: 'ms',
    status: 'complete',
    missions: {
      '001-001': {
        id: '001-001',
        description: 'mi',
        status: 'complete',
        stateFile: '.harness/state/mission-001-001.json',
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  const tasks = {};
  taskStatuses.forEach((status, idx) => {
    const n = String(idx + 1).padStart(3, '0');
    const taskId = `001-001-001-${n}`;
    tasks[taskId] = { id: taskId, description: `task ${n}`, status };

    if (writeReports && status === 'complete') {
      // Write the JSON sidecar that the verifier produces via jsonSchema
      // structured output. This is the only path audit.js accepts after
      // dogfood 5 removed the legacy markdown fallback.
      fs.writeFileSync(
        path.join(harnessDir, 'verification', `task-${taskId}.json`),
        JSON.stringify({
          taskId,
          result: 'PASSED',
          hardChecks: [],
          taskScopeChecks: [],
          notes: 'test fixture',
        }, null, 2)
      );
    }
  });

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

// ---------- Tests ----------

test('audit: clean milestone with all reports passes with zero anomalies', () => {
  const root = createProjectRoot();
  try {
    const { harnessDir } = bootstrap(root);
    seedMilestone(harnessDir, { taskStatuses: ['complete', 'complete', 'complete'] });
    const result = auditVerification(harnessDir, '001');
    assert.equal(result.total, 3);
    assert.deepEqual(result.anomalies, []);
  } finally { cleanup(root); }
});

test('audit: missing report file raises anomaly', () => {
  const root = createProjectRoot();
  try {
    const { harnessDir } = bootstrap(root);
    seedMilestone(harnessDir, { taskStatuses: ['complete'], writeReports: false });
    const result = auditVerification(harnessDir, '001');
    assert.equal(result.total, 1);
    assert.equal(result.anomalies.length, 1);
    assert.ok(/missing on disk/.test(result.anomalies[0].issue));
  } finally { cleanup(root); }
});

test('audit: sidecar with non-PASSED result raises anomaly', () => {
  const root = createProjectRoot();
  try {
    const { harnessDir } = bootstrap(root);
    seedMilestone(harnessDir, { taskStatuses: ['complete'] });
    // Overwrite the JSON sidecar with a FAILED result.
    fs.writeFileSync(
      path.join(harnessDir, 'verification', 'task-001-001-001-001.json'),
      JSON.stringify({ taskId: '001-001-001-001', result: 'FAILED', notes: 'mock failure' })
    );
    const result = auditVerification(harnessDir, '001');
    assert.equal(result.anomalies.length, 1);
    assert.ok(/result is "FAILED"/.test(result.anomalies[0].issue));
  } finally { cleanup(root); }
});

test('audit: malformed JSON sidecar raises anomaly', () => {
  const root = createProjectRoot();
  try {
    const { harnessDir } = bootstrap(root);
    seedMilestone(harnessDir, { taskStatuses: ['complete'] });
    // Overwrite with invalid JSON
    fs.writeFileSync(
      path.join(harnessDir, 'verification', 'task-001-001-001-001.json'),
      '{ this is not valid json'
    );
    const result = auditVerification(harnessDir, '001');
    assert.equal(result.anomalies.length, 1);
    assert.ok(/not valid JSON/.test(result.anomalies[0].issue));
  } finally { cleanup(root); }
});

test('audit: non-complete tasks are skipped (not audited)', () => {
  const root = createProjectRoot();
  try {
    const { harnessDir } = bootstrap(root);
    seedMilestone(harnessDir, {
      taskStatuses: ['complete', 'pending', 'invalidated'],
    });
    // Only the first task has a report.
    const result = auditVerification(harnessDir, '001');
    assert.equal(result.total, 1, 'only the complete task is audited');
    assert.deepEqual(result.anomalies, []);
  } finally { cleanup(root); }
});

test('audit: nonexistent milestone returns empty result', () => {
  const root = createProjectRoot();
  try {
    const { harnessDir } = bootstrap(root);
    const result = auditVerification(harnessDir, '999');
    assert.deepEqual(result, { total: 0, anomalies: [] });
  } finally { cleanup(root); }
});

test('audit: missing mission state file raises anomaly', () => {
  const root = createProjectRoot();
  try {
    const { harnessDir } = bootstrap(root);
    seedMilestone(harnessDir, { taskStatuses: ['complete'] });
    // Delete the mission state file to simulate the absent-file case.
    fs.unlinkSync(path.join(harnessDir, 'state', 'mission-001-001.json'));
    const result = auditVerification(harnessDir, '001');
    const missionAnomaly = result.anomalies.find(a => a.taskId === 'mission:001-001');
    assert.ok(missionAnomaly, 'expected anomaly with taskId mission:001-001');
    assert.ok(
      /mission state file missing on disk/.test(missionAnomaly.issue),
      `expected issue to match /mission state file missing on disk/, got: ${missionAnomaly.issue}`
    );
  } finally { cleanup(root); }
});

test('audit: present mission state file yields no missing-mission anomaly', () => {
  const root = createProjectRoot();
  try {
    const { harnessDir } = bootstrap(root);
    seedMilestone(harnessDir, { taskStatuses: ['complete'] });
    const result = auditVerification(harnessDir, '001');
    const missingMissionAnomaly = result.anomalies.find(a =>
      /mission state file missing on disk/.test(a.issue)
    );
    assert.ok(
      !missingMissionAnomaly,
      'expected no anomaly matching /mission state file missing on disk/'
    );
  } finally { cleanup(root); }
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
