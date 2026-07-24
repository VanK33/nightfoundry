/**
 * test-coverage-id-normalize.js — Unit tests for the Layer 1 id-normalization
 * step added to mergeRemediationTasks in coverage.js.
 *
 * Test cases:
 *   TC-NORM-1: task with non-4-segment id is rewritten to subMissionId-001
 *   TC-NORM-2: task with valid 4-segment id is left unchanged
 *   TC-NORM-3: collision avoidance — existing task in state bumps seq to -002
 *   TC-NORM-4: batch collision — two bad-id tasks in same batch get distinct ids
 *
 * Run: node test/test-coverage-id-normalize.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { mergeRemediationTasks } from '../src/orchestrator/gates/coverage.js';

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Create a minimal harness dir with:
 *   - state.json (global, no prdPath so coverage check is skipped)
 *   - state/mission-<missionId>.json with one sub-mission containing `existingTasks`
 *
 * Returns { harnessDir, missionId, smId }
 */
function createHarness({ existingTasks = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-normalize-test-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'verify'), { recursive: true });

  const missionId = '001-001';
  const smId = `${missionId}-001`;

  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones: {},
    }, null, 2)
  );

  fs.writeFileSync(
    path.join(dir, 'state', `mission-${missionId}.json`),
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

  return { harnessDir: dir, missionId, smId };
}

/** Minimal missionDecomp stub (subMissions array). */
function makeDecomp(smId) {
  return { subMissions: [{ id: smId, tasks: [] }] };
}

/** Read saved mission state from disk. */
function readState(harnessDir, missionId) {
  return JSON.parse(
    fs.readFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), 'utf8')
  );
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Tests ────────────────────────────────────────────────────────────────────

// TC-NORM-1: task with non-4-segment id is rewritten to subMissionId-001
await test('TC-NORM-1: non-4-segment id rewritten to subMissionId-001', async () => {
  const { harnessDir, missionId, smId } = createHarness();
  try {
    const logs = [];
    await mergeRemediationTasks({
      harnessDir,
      missionId,
      newTasks: [{ id: 'fix-bug', subMissionId: smId, description: 'a fix', targetFiles: [], testCases: [] }],
      missionDecomp: makeDecomp(smId),
      onLog: (msg) => logs.push(msg),
    });

    const state = readState(harnessDir, missionId);
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
  const { harnessDir, missionId, smId } = createHarness();
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

    const state = readState(harnessDir, missionId);
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
  const { harnessDir, missionId } = createHarness({
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

    const state = readState(harnessDir, missionId);
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
  const { harnessDir, missionId, smId } = createHarness();
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

    const state = readState(harnessDir, missionId);
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

// TC-FALLBACK-1: task with non-existent subMissionId triggers onLog warning
//                containing task.id, missionId, and fallback subMissionId
await test('TC-FALLBACK-1: non-existent subMissionId triggers onLog warning with task.id, missionId, and fallback smId', async () => {
  const { harnessDir, missionId, smId } = createHarness();
  // Use a subMissionId that is not present in the mission state.
  const nonExistentSmId = `${missionId}-999`;
  // Use a valid 4-segment id so normalization doesn't interfere with the warning check.
  const taskId = `${smId}-007`;
  try {
    const logs = [];
    await mergeRemediationTasks({
      harnessDir,
      missionId,
      newTasks: [{ id: taskId, subMissionId: nonExistentSmId, description: 'task with bad smId', targetFiles: [], testCases: [] }],
      missionDecomp: makeDecomp(smId),
      onLog: (msg) => logs.push(msg),
    });

    // There must be at least one warning / falling-back log line.
    const warningLog = logs.find((l) => l.includes('falling back') || l.toLowerCase().includes('warning'));
    assert.ok(warningLog, 'expected a warning/fallback log line');

    // The warning must contain the original task id.
    assert.ok(warningLog.includes(taskId), `warning must include task id "${taskId}"`);

    // The warning must contain the missionId.
    assert.ok(warningLog.includes(missionId), `warning must include missionId "${missionId}"`);

    // The warning must contain the fallback subMissionId (smId = first sub-mission).
    assert.ok(warningLog.includes(smId), `warning must include fallback subMissionId "${smId}"`);
  } finally {
    cleanup(harnessDir);
  }
});

// TC-FALLBACK-2: fallback behavior is preserved — task.subMissionId is rewritten
//                to firstSmId when the original subMissionId doesn't exist.
await test('TC-FALLBACK-2: fallback rewrites task.subMissionId to firstSmId and task lands in correct sub-mission', async () => {
  const { harnessDir, missionId, smId } = createHarness();
  const nonExistentSmId = `${missionId}-999`;
  // Use a valid 4-segment id so only the subMissionId fallback is exercised.
  const taskId = `${smId}-008`;
  const task = { id: taskId, subMissionId: nonExistentSmId, description: 'task with bad smId', targetFiles: [], testCases: [] };
  try {
    const logs = [];
    await mergeRemediationTasks({
      harnessDir,
      missionId,
      newTasks: [task],
      missionDecomp: makeDecomp(smId),
      onLog: (msg) => logs.push(msg),
    });

    // task.subMissionId must have been mutated to the fallback (firstSmId).
    assert.strictEqual(task.subMissionId, smId, `task.subMissionId must be rewritten to "${smId}"`);

    // The task must also appear in the first sub-mission's tasks in persisted state.
    const state = readState(harnessDir, missionId);
    const targetSmTasks = state.subMissions[smId]?.tasks ?? {};
    assert.ok(
      Object.keys(targetSmTasks).includes(taskId),
      `task "${taskId}" must be persisted under sub-mission "${smId}"`
    );

    // The task must NOT have landed in the non-existent sub-mission.
    assert.ok(
      !state.subMissions[nonExistentSmId],
      `sub-mission "${nonExistentSmId}" must not have been created`
    );
  } finally {
    cleanup(harnessDir);
  }
});

// ── TC-PREFIX tests: prefix-aware quadrant logic ─────────────────────────────

// TC-PREFIX-1: valid-format ID whose 3-segment prefix matches task.subMissionId
//              and does not collide → accepted as-is (returns without rename)
await test('TC-PREFIX-1: matching prefix + no collision → accepted as-is', async () => {
  const { harnessDir, missionId, smId } = createHarness();
  try {
    const validId = `${smId}-007`;
    const logs = [];
    await mergeRemediationTasks({
      harnessDir,
      missionId,
      newTasks: [{ id: validId, subMissionId: smId, description: 'prefix match no collide', targetFiles: [], testCases: [] }],
      missionDecomp: makeDecomp(smId),
      onLog: (msg) => logs.push(msg),
    });

    const state = readState(harnessDir, missionId);
    const taskIds = Object.keys(state.subMissions[smId].tasks);

    assert.strictEqual(taskIds.length, 1, 'expected exactly 1 task');
    assert.strictEqual(taskIds[0], validId, `id must remain '${validId}'`);
    // No rewrite or orphan-re-parent log.
    assert.ok(
      !logs.some((l) => l.includes('[id-normalize]')),
      'expected no id-normalize log for clean accepted id'
    );
  } finally {
    cleanup(harnessDir);
  }
});

// TC-PREFIX-2: valid-format ID whose 3-segment prefix diverges from task.subMissionId
//              and does not collide → falls through to rename loop, gets rewritten
await test('TC-PREFIX-2: diverging prefix + no collision → orphan re-parent + rename', async () => {
  const { harnessDir, missionId, smId } = createHarness();
  try {
    // Use a valid 4-segment id that belongs to a *different* sub-mission prefix.
    const foreignId = '001-001-999-001';
    const logs = [];
    await mergeRemediationTasks({
      harnessDir,
      missionId,
      newTasks: [{ id: foreignId, subMissionId: smId, description: 'orphan task', targetFiles: [], testCases: [] }],
      missionDecomp: makeDecomp(smId),
      onLog: (msg) => logs.push(msg),
    });

    const state = readState(harnessDir, missionId);
    const taskIds = Object.keys(state.subMissions[smId].tasks);

    // Task must have been re-parented to smId-001.
    assert.strictEqual(taskIds.length, 1, 'expected exactly 1 task');
    assert.strictEqual(taskIds[0], `${smId}-001`, `expected '${smId}-001', got '${taskIds[0]}'`);
    assert.ok(!taskIds.includes(foreignId), 'foreign id must not appear in state');

    // An orphan re-parent log must have been emitted.
    assert.ok(
      logs.some((l) => l.includes('[id-normalize] Orphan re-parent') && l.includes(foreignId) && l.includes(smId)),
      `expected orphan re-parent log, got: ${JSON.stringify(logs)}`
    );
    // Also a rename log.
    assert.ok(
      logs.some((l) => l.includes('[id-normalize] Rewrote') && l.includes(foreignId)),
      `expected rewrite log, got: ${JSON.stringify(logs)}`
    );
  } finally {
    cleanup(harnessDir);
  }
});

// TC-PREFIX-3: valid-format ID whose 3-segment prefix diverges from task.subMissionId
//              and collides → throws TaskIdCollisionError
await test('TC-PREFIX-3: diverging prefix + collision → throws TaskIdCollisionError', async () => {
  const { harnessDir, missionId, smId } = createHarness();
  try {
    // Use a foreign id that also exists in the harness state as a cross-mission task.
    // We simulate a collision by pre-populating the state with that foreign id
    // under a different sub-mission.
    const foreignSmId = '001-001-999';
    const foreignId = `${foreignSmId}-001`;

    // Add the foreign sub-mission+task to the mission state so checkTaskIdCollision fires.
    const stateFilePath = path.join(harnessDir, 'state', `mission-${missionId}.json`);
    const stateData = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    stateData.subMissions[foreignSmId] = {
      id: foreignSmId,
      description: 'foreign sm',
      status: 'in_progress',
      tasks: {
        [foreignId]: { id: foreignId, description: 'existing foreign task', status: 'pending', retryCount: 0 },
      },
    };
    fs.writeFileSync(stateFilePath, JSON.stringify(stateData, null, 2));

    let threw = false;
    let caughtError = null;
    try {
      await mergeRemediationTasks({
        harnessDir,
        missionId,
        newTasks: [{ id: foreignId, subMissionId: smId, description: 'colliding foreign', targetFiles: [], testCases: [] }],
        missionDecomp: makeDecomp(smId),
        onLog: () => {},
      });
    } catch (err) {
      threw = true;
      caughtError = err;
    }

    assert.ok(threw, 'expected TaskIdCollisionError to be thrown');
    assert.strictEqual(caughtError?.name, 'TaskIdCollisionError', `expected TaskIdCollisionError, got ${caughtError?.name}`);
    assert.ok(caughtError?.message?.includes(foreignId), 'error message must include the colliding task id');
  } finally {
    cleanup(harnessDir);
  }
});

// TC-PREFIX-4: valid-format ID whose 3-segment prefix matches task.subMissionId
//              and collides → falls through to rename loop, gets bumped sequence
await test('TC-PREFIX-4: matching prefix + collision → benign rename to next seq', async () => {
  const { harnessDir, missionId, smId } = createHarness();
  try {
    // Pre-populate smId-001 in state so that when planner reuses smId-001 it collides.
    const existingId = `${smId}-001`;
    const stateFilePath = path.join(harnessDir, 'state', `mission-${missionId}.json`);
    const stateData = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    stateData.subMissions[smId].tasks[existingId] = {
      id: existingId,
      description: 'pre-existing',
      status: 'pending',
      retryCount: 0,
    };
    fs.writeFileSync(stateFilePath, JSON.stringify(stateData, null, 2));

    const logs = [];
    await mergeRemediationTasks({
      harnessDir,
      missionId,
      newTasks: [{ id: existingId, subMissionId: smId, description: 'same namespace collision', targetFiles: [], testCases: [] }],
      missionDecomp: makeDecomp(smId),
      onLog: (msg) => logs.push(msg),
    });

    const state = readState(harnessDir, missionId);
    const taskIds = Object.keys(state.subMissions[smId].tasks);

    // Should have 2 tasks: original -001 and bumped -002.
    assert.ok(taskIds.includes(`${smId}-002`), `expected '${smId}-002', got ${JSON.stringify(taskIds)}`);
    assert.ok(taskIds.includes(existingId), `original '${existingId}' must still exist`);
    // A rewrite log must mention -002.
    assert.ok(
      logs.some((l) => l.includes('[id-normalize] Rewrote') && l.includes(`${smId}-002`)),
      `expected rewrite log for -002, got: ${JSON.stringify(logs)}`
    );
    // No orphan re-parent log (prefix matched).
    assert.ok(
      !logs.some((l) => l.includes('[id-normalize] Orphan re-parent')),
      'must not emit orphan re-parent log for same-namespace collision'
    );
  } finally {
    cleanup(harnessDir);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
