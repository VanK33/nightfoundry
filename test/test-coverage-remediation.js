/**
 * test-coverage-remediation.js — Tests for id-normalization in mergeRemediationTasks.
 *
 * Test cases:
 *   TC-NORM-1: task with non-4-segment id is rewritten to subMissionId-001
 *   TC-NORM-2: task with valid 4-segment id is left unchanged
 *   TC-NORM-3: collision avoidance — existing task in state bumps seq to -002
 *   TC-NORM-4: batch collision — two bad-id tasks in same batch get distinct ids
 *
 * Run: node test/test-coverage-remediation.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { mergeRemediationTasks } from '../src/orchestrator/gates/coverage.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failCount++;
    }
  );
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Create a minimal harness dir with:
 *   - state.json (global, no prdPath so coverage check is skipped)
 *   - state/mission-<missionId>.json with one sub-mission containing `existingTasks`
 *
 * Returns { harnessDir, missionId, smId }
 */
function createTestEnv({ existingTasks = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-remediation-test-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'verify'), { recursive: true });

  const missionId = '001-001';
  const smId = `${missionId}-001`;

  fs.writeFileSync(
    path.join(root, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones: {},
    }, null, 2)
  );

  fs.writeFileSync(
    path.join(root, 'state', `mission-${missionId}.json`),
    JSON.stringify({
      id: missionId,
      missionId,
      description: 'test mission',
      status: 'in_progress',
      subMissions: {
        [smId]: {
          id: smId,
          description: 'test sub-mission',
          status: 'in_progress',
          tasks: existingTasks,
        },
      },
    }, null, 2)
  );

  return { harnessDir: root, missionId, smId };
}

/** Minimal missionDecomp stub (subMissions array). */
function makeDecomp(smId) {
  return { subMissions: [{ id: smId, tasks: [] }] };
}

/** Read saved mission state from disk. */
function readMissionState(harnessDir, missionId) {
  return JSON.parse(
    fs.readFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), 'utf8')
  );
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// ── Tests ────────────────────────────────────────────────────────────────────

// TC-NORM-1: task with non-4-segment id is rewritten to subMissionId-001
await test('TC-NORM-1: non-4-segment id rewritten to subMissionId-001', async () => {
  const { harnessDir, missionId, smId } = createTestEnv();
  try {
    const logs = [];
    await mergeRemediationTasks({
      harnessDir,
      missionId,
      newTasks: [{ id: 'fix-bug', subMissionId: smId, description: 'a fix', targetFiles: [], testCases: [] }],
      missionDecomp: makeDecomp(smId),
      onLog: (msg) => logs.push(msg),
    });

    const state = readMissionState(harnessDir, missionId);
    const taskIds = Object.keys(state.subMissions[smId].tasks);

    // Should have exactly one task with the normalised id.
    assert.strictEqual(taskIds.length, 1, 'expected exactly 1 task');
    assert.strictEqual(taskIds[0], `${smId}-001`, `expected id '${smId}-001', got '${taskIds[0]}'`);

    const savedTask = state.subMissions[smId].tasks[`${smId}-001`];
    assert.strictEqual(savedTask.id, `${smId}-001`);
    assert.ok(savedTask.verifyFile.includes(`task-${smId}-001.json`), 'verifyFile path must use new id');
    assert.ok(savedTask.progressFile.includes(`task-${smId}-001.json`), 'progressFile path must use new id');
    assert.ok(savedTask.verificationFile.includes(`task-${smId}-001.json`), 'verificationFile path must use new id');

    // A log line must have been emitted.
    assert.ok(logs.some((l) => l.includes('fix-bug') && l.includes(`${smId}-001`)), 'expected log about rewrite');
  } finally {
    cleanup(harnessDir);
  }
});

// TC-NORM-2: task with valid 4-segment id is left unchanged
await test('TC-NORM-2: valid 4-segment id is left unchanged', async () => {
  const { harnessDir, missionId, smId } = createTestEnv();
  try {
    const validId = `${smId}-042`;
    const logs = [];
    await mergeRemediationTasks({
      harnessDir,
      missionId,
      newTasks: [{ id: validId, subMissionId: smId, description: 'a valid task', targetFiles: [], testCases: [] }],
      missionDecomp: makeDecomp(smId),
      onLog: (msg) => logs.push(msg),
    });

    const state = readMissionState(harnessDir, missionId);
    const taskIds = Object.keys(state.subMissions[smId].tasks);

    assert.strictEqual(taskIds.length, 1, 'expected exactly 1 task');
    assert.strictEqual(taskIds[0], validId, `id must remain '${validId}'`);

    // No rewrite log should have been emitted.
    assert.ok(
      !logs.some((l) => l.includes('[id-normalize]')),
      'expected no rewrite log for valid id'
    );
  } finally {
    cleanup(harnessDir);
  }
});

// TC-NORM-3: collision avoidance — subMissionId-001 already in state → gets -002
await test('TC-NORM-3: collision with existing state task → gets next seq', async () => {
  const smId = '001-001-001';
  // Pre-populate the state with subMissionId-001 already taken.
  const existingId = `${smId}-001`;
  const { harnessDir, missionId } = createTestEnv({
    existingTasks: {
      [existingId]: { id: existingId, description: 'existing', status: 'pending', retryCount: 0 },
    },
  });
  try {
    const logs = [];
    await mergeRemediationTasks({
      harnessDir,
      missionId,
      newTasks: [{ id: 'bad-id', subMissionId: smId, description: 'new task', targetFiles: [], testCases: [] }],
      missionDecomp: makeDecomp(smId),
      onLog: (msg) => logs.push(msg),
    });

    const state = readMissionState(harnessDir, missionId);
    const taskIds = Object.keys(state.subMissions[smId].tasks);

    // Should now have 2 tasks: the pre-existing one AND the new one at -002.
    assert.ok(taskIds.includes(`${smId}-002`), `expected '${smId}-002', got ${JSON.stringify(taskIds)}`);
    assert.ok(!taskIds.includes('bad-id'), 'original bad id must not appear in state');
    assert.ok(logs.some((l) => l.includes(`${smId}-002`)), 'expected log mentioning -002');
  } finally {
    cleanup(harnessDir);
  }
});

// TC-NORM-4: batch collision — two bad-id tasks in same batch get distinct ids
await test('TC-NORM-4: two bad-id tasks in same batch get distinct sequential ids', async () => {
  const { harnessDir, missionId, smId } = createTestEnv();
  try {
    const logs = [];
    await mergeRemediationTasks({
      harnessDir,
      missionId,
      newTasks: [
        { id: 'fix-bug', subMissionId: smId, description: 'first', targetFiles: [], testCases: [] },
        { id: 'add-feature', subMissionId: smId, description: 'second', targetFiles: [], testCases: [] },
      ],
      missionDecomp: makeDecomp(smId),
      onLog: (msg) => logs.push(msg),
    });

    const state = readMissionState(harnessDir, missionId);
    const taskIds = Object.keys(state.subMissions[smId].tasks).sort();

    assert.strictEqual(taskIds.length, 2, 'expected 2 tasks');
    assert.ok(taskIds.includes(`${smId}-001`), `expected '${smId}-001'`);
    assert.ok(taskIds.includes(`${smId}-002`), `expected '${smId}-002'`);
    // No duplicates.
    assert.strictEqual(new Set(taskIds).size, taskIds.length, 'task ids must be unique');
  } finally {
    cleanup(harnessDir);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
