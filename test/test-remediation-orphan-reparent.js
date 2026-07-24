/**
 * test-remediation-orphan-reparent.js — Tests for orphan task id re-parenting
 * in mergeRemediationTasks.
 *
 * Test cases:
 *   TC-ORPH-1: orphan re-parent — valid-format id whose prefix diverges from
 *              subMissionId is rewritten to subMissionId-001
 *   TC-ORPH-2: orphan re-parent avoids sequence collision in destination —
 *              skips occupied slot 001 and assigns 002
 *   TC-ORPH-3: correct-prefix acceptance regression — matching prefix + no
 *              collision accepted as-is
 *   TC-ORPH-4: cross-sub-mission collision throw regression — diverging prefix
 *              + collision throws TaskIdCollisionError
 *
 * Run: node test/test-remediation-orphan-reparent.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { mergeRemediationTasks } from '../src/orchestrator/gates/coverage.js';
import { TaskIdCollisionError } from '../src/orchestrator/core/task-id-collision-error.js';

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
 * Create a minimal harness dir with two missions (001-001, 001-002),
 * each containing one sub-mission (001-001-001 and 001-002-001 respectively).
 *
 * Returns { harnessDir }
 */
function createMultiMissionEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-reparent-test-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'verify'), { recursive: true });
  fs.mkdirSync(path.join(root, 'progress'), { recursive: true });
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });

  // Global state (no prdPath so coverage spec-check is skipped)
  fs.writeFileSync(
    path.join(root, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones: {},
    }, null, 2)
  );

  // Mission 001-001 with sub-mission 001-001-001
  fs.writeFileSync(
    path.join(root, 'state', 'mission-001-001.json'),
    JSON.stringify({
      id: '001-001',
      missionId: '001-001',
      description: 'mission one',
      status: 'in_progress',
      subMissions: {
        '001-001-001': {
          id: '001-001-001',
          description: 'sub-mission one-one',
          status: 'in_progress',
          tasks: {},
        },
      },
    }, null, 2)
  );

  // Mission 001-002 with sub-mission 001-002-001
  fs.writeFileSync(
    path.join(root, 'state', 'mission-001-002.json'),
    JSON.stringify({
      id: '001-002',
      missionId: '001-002',
      description: 'mission two',
      status: 'in_progress',
      subMissions: {
        '001-002-001': {
          id: '001-002-001',
          description: 'sub-mission two-one',
          status: 'in_progress',
          tasks: {},
        },
      },
    }, null, 2)
  );

  return { harnessDir: root };
}

/** Minimal missionDecomp stub for a given subMissionId. */
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

// TC-ORPH-1: orphan re-parent — valid-format id whose prefix diverges from subMissionId is rewritten
await test('TC-ORPH-1: orphan re-parent — valid-format id whose prefix diverges from subMissionId is rewritten', async () => {
  const { harnessDir } = createMultiMissionEnv();
  try {
    // Mission 001-002 with empty sub-mission 001-002-001 (already set up by createMultiMissionEnv).
    // Call mergeRemediationTasks with a task id whose prefix (001-001-001) diverges from
    // the declared subMissionId (001-002-001).
    await mergeRemediationTasks({
      harnessDir,
      missionId: '001-002',
      newTasks: [{
        id: '001-001-001-005',
        subMissionId: '001-002-001',
        description: 'orphan task with diverging prefix',
        targetFiles: [],
        testCases: [],
      }],
      missionDecomp: makeDecomp('001-002-001'),
    });

    const state = readMissionState(harnessDir, '001-002');
    const tasks = state.subMissions['001-002-001'].tasks;

    assert.ok(
      tasks['001-002-001-001'] !== undefined,
      `expected re-parented task '001-002-001-001' to exist in state.subMissions['001-002-001'].tasks, ` +
      `got keys: ${JSON.stringify(Object.keys(tasks))}`
    );
    assert.ok(
      tasks['001-001-001-005'] === undefined,
      `expected original orphan id '001-001-001-005' NOT to exist in state after re-parenting`
    );
  } finally {
    cleanup(harnessDir);
  }
});

// TC-ORPH-2: orphan re-parent avoids sequence collision in destination
await test('TC-ORPH-2: orphan re-parent avoids sequence collision in destination', async () => {
  const { harnessDir } = createMultiMissionEnv();
  try {
    // Pre-populate sub-mission 001-002-001 with an existing task 001-002-001-001
    const mission2StatePath = path.join(harnessDir, 'state', 'mission-001-002.json');
    const mission2State = JSON.parse(fs.readFileSync(mission2StatePath, 'utf8'));
    mission2State.subMissions['001-002-001'].tasks['001-002-001-001'] = {
      id: '001-002-001-001',
      description: 'pre-existing task in sub-mission',
      status: 'pending',
      retryCount: 0,
    };
    fs.writeFileSync(mission2StatePath, JSON.stringify(mission2State, null, 2));

    // Now inject an orphan task — its diverging prefix should be rewritten;
    // slot -001 is taken so it must land on -002.
    await mergeRemediationTasks({
      harnessDir,
      missionId: '001-002',
      newTasks: [{
        id: '001-001-001-005',
        subMissionId: '001-002-001',
        description: 'orphan task that must avoid slot 001',
        targetFiles: [],
        testCases: [],
      }],
      missionDecomp: makeDecomp('001-002-001'),
    });

    const state = readMissionState(harnessDir, '001-002');
    const tasks = state.subMissions['001-002-001'].tasks;

    assert.ok(
      tasks['001-002-001-002'] !== undefined,
      `expected re-parented task '001-002-001-002' to exist (slot 001 was occupied), ` +
      `got keys: ${JSON.stringify(Object.keys(tasks))}`
    );
    assert.ok(
      tasks['001-001-001-005'] === undefined,
      `expected original orphan id '001-001-001-005' NOT to exist in state after re-parenting`
    );
    assert.ok(
      tasks['001-002-001-001'] !== undefined,
      `expected pre-existing task '001-002-001-001' to remain untouched`
    );
  } finally {
    cleanup(harnessDir);
  }
});

// TC-ORPH-3: correct-prefix acceptance regression — matching prefix + no collision accepted as-is
await test('TC-ORPH-3: correct-prefix acceptance regression — matching prefix + no collision accepted as-is', async () => {
  const { harnessDir } = createMultiMissionEnv();
  try {
    // Inject a task whose id already has the correct prefix for the destination sub-mission
    // and no collision exists — it should be stored unchanged.
    await mergeRemediationTasks({
      harnessDir,
      missionId: '001-002',
      newTasks: [{
        id: '001-002-001-001',
        subMissionId: '001-002-001',
        description: 'task with correct prefix, no collision',
        targetFiles: [],
        testCases: [],
      }],
      missionDecomp: makeDecomp('001-002-001'),
    });

    const state = readMissionState(harnessDir, '001-002');
    const tasks = state.subMissions['001-002-001'].tasks;

    assert.ok(
      tasks['001-002-001-001'] !== undefined,
      `expected task '001-002-001-001' to exist in state unchanged`
    );
    assert.strictEqual(
      tasks['001-002-001-001'].id,
      '001-002-001-001',
      `expected task.id === '001-002-001-001', got '${tasks['001-002-001-001']?.id}'`
    );
  } finally {
    cleanup(harnessDir);
  }
});

// TC-ORPH-4: cross-sub-mission collision throw regression — diverging prefix + collision throws TaskIdCollisionError
await test('TC-ORPH-4: cross-sub-mission collision throw regression — diverging prefix + collision throws TaskIdCollisionError', async () => {
  const { harnessDir } = createMultiMissionEnv();
  try {
    // Pre-populate mission 001-001 sub-mission 001-001-001 with task 001-001-001-001
    const mission1StatePath = path.join(harnessDir, 'state', 'mission-001-001.json');
    const mission1State = JSON.parse(fs.readFileSync(mission1StatePath, 'utf8'));
    mission1State.subMissions['001-001-001'].tasks['001-001-001-001'] = {
      id: '001-001-001-001',
      description: 'pre-existing task in mission one sub-mission one',
      status: 'complete',
      retryCount: 0,
    };
    fs.writeFileSync(mission1StatePath, JSON.stringify(mission1State, null, 2));

    // Attempt to inject the SAME task id into mission 001-002 with a different subMissionId.
    // The diverging prefix (001-001-001) + cross-mission collision should throw TaskIdCollisionError.
    let threw = null;
    try {
      await mergeRemediationTasks({
        harnessDir,
        missionId: '001-002',
        newTasks: [{
          id: '001-001-001-001',
          subMissionId: '001-002-001',
          description: 'task that collides across missions with diverging prefix',
          targetFiles: [],
          testCases: [],
        }],
        missionDecomp: makeDecomp('001-002-001'),
      });
    } catch (err) {
      threw = err;
    }

    assert.ok(threw !== null, 'expected mergeRemediationTasks to throw TaskIdCollisionError but it did not');
    assert.strictEqual(
      threw.name,
      'TaskIdCollisionError',
      `expected error.name === 'TaskIdCollisionError', got '${threw.name}'`
    );
    assert.strictEqual(
      threw.taskId,
      '001-001-001-001',
      `expected error.taskId === '001-001-001-001', got '${threw.taskId}'`
    );
  } finally {
    cleanup(harnessDir);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
