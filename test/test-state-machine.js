/**
 * test-state-machine.js — Standalone unit tests for state-machine.js.
 *
 * No Claude auth, no SDK. Pure fs + assertions on temp directories.
 * Run: node test/test-state-machine.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import {
  TASK_TRANSITIONS,
  canComplete,
  transitionTask,
  transitionSubMission,
  transitionMission,
  transitionMilestone,
  cascadeComplete,
  getTaskStatus,
  getSubMissionStatus,
  getMissionStatus,
  getMilestoneStatus,
  resolveVerificationSidecar,
} from '../src/orchestrator/core/state-machine.js';

let passCount = 0;
let failCount = 0;

// Phase I items 4+5: state-machine transitions are now async (they
// acquire mutexes internally). The test helper is async so test bodies
// can `await transitionX(...)` uniformly. `await` on a non-promise is a
// no-op, so sync test bodies still work unchanged.
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// assertThrows is async-aware: it awaits fn() so both sync throws and
// rejected promises are caught uniformly. Call sites that previously
// passed `() => transitionX(...)` still work because the arrow returns
// the promise from transitionX and `await` inside assertThrows rejects
// on error.
async function assertThrows(fn, pattern, msg) {
  let thrown;
  try { await fn(); } catch (e) { thrown = e; }
  if (!thrown) throw new Error(msg || 'Expected function to throw');
  if (pattern && !pattern.test(thrown.message)) {
    throw new Error(`${msg || 'Throw pattern mismatch'}. Got: ${thrown.message}`);
  }
}

// ---------- Fixture helpers ----------

function createHarnessDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-machine-test-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'verification'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeGlobalState(harnessDir, milestones) {
  const state = {
    projectMeta: {
      prdPath: '',
      createdAt: new Date().toISOString(),
      currentPhase: 'executing',
    },
    globalStatus: 'active',
    milestones,
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));
}

function writeMissionState(harnessDir, missionId, state) {
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify(state, null, 2)
  );
}

function writeVerificationReport(harnessDir, taskId) {
  // Source of truth: JSON sidecar (new contract as of hard-contracts work).
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-${taskId}.json`),
    JSON.stringify({
      result: 'PASSED',
      hardChecks: [],
      taskScopeChecks: [],
      notes: 'test fixture',
    })
  );
}

// Builds a minimal single-mission fixture with one sub-mission and one task.
function simpleFixture(harnessDir, { taskStatus = 'pending', subMissionStatus = 'pending', missionStatus = 'in_progress' } = {}) {
  writeGlobalState(harnessDir, {
    '001': {
      id: '001',
      status: 'in_progress',
      missions: {
        '001-001': {
          id: '001-001',
          status: missionStatus,
          stateFile: '.harness/state/mission-001-001.json',
        },
      },
    },
  });
  writeMissionState(harnessDir, '001-001', {
    id: '001-001',
    missionId: '001-001',
    description: 'test mission',
    status: missionStatus,
    subMissions: {
      '001-001-001': {
        id: '001-001-001',
        description: 'test sub-mission',
        status: subMissionStatus,
        tasks: {
          '001-001-001-001': {
            id: '001-001-001-001',
            description: 'test task',
            status: taskStatus,
            retryCount: 0,
          },
        },
      },
    },
  });
}

// Phase I items 4+5: tests are async to support the now-async state
// machine transitions. Wrapping in an async run() function gives us
// top-level `await test(...)` semantics without relying on the Node
// top-level-await flag. Each test still runs sequentially.
async function run() {

// ---------- canComplete helper ----------

await test('canComplete: empty/null children returns false', async () => {
  assert.equal(canComplete({}), false);
  assert.equal(canComplete(null), false);
  assert.equal(canComplete(undefined), false);
});

await test('canComplete: all terminal returns true', async () => {
  assert.equal(canComplete({ a: { status: 'complete' }, b: { status: 'invalidated' } }), true);
});

await test('canComplete: any non-terminal returns false', async () => {
  assert.equal(canComplete({ a: { status: 'complete' }, b: { status: 'pending' } }), false);
  assert.equal(canComplete({ a: { status: 'in_progress' } }), false);
  assert.equal(canComplete({ a: { status: 'verified' } }), false);
});

// ---------- TASK_TRANSITIONS ----------

await test('TASK_TRANSITIONS: enumerates expected targets', async () => {
  assert.deepEqual(TASK_TRANSITIONS.pending, ['in_progress', 'blocked', 'invalidated']);
  assert.deepEqual(TASK_TRANSITIONS.awaiting_verification, ['verified', 'failed', 'invalidated']);
  assert.deepEqual(TASK_TRANSITIONS.verified, ['complete', 'invalidated']);
  assert.deepEqual(TASK_TRANSITIONS.invalidated, []);
});

await test('TASK_TRANSITIONS: is frozen', async () => {
  assert.ok(Object.isFrozen(TASK_TRANSITIONS));
});

// ---------- transitionTask: legal and illegal ----------

await test('transitionTask: pending → in_progress succeeds and stamps startedAt', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir);
    await transitionTask(dir, '001-001-001-001', 'in_progress');
    assert.equal(getTaskStatus(dir, '001-001-001-001'), 'in_progress');

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'mission-001-001.json'), 'utf8'));
    const task = state.subMissions['001-001-001'].tasks['001-001-001-001'];
    assert.ok(task.startedAt, 'startedAt should be set');
  } finally { cleanup(dir); }
});

await test('transitionTask: pending → complete (illegal) throws', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir);
    await assertThrows(
      () => transitionTask(dir, '001-001-001-001', 'complete'),
      /Illegal task transition: pending/
    );
  } finally { cleanup(dir); }
});

await test('transitionTask: in_progress → awaiting_verification succeeds', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, { taskStatus: 'in_progress' });
    await transitionTask(dir, '001-001-001-001', 'awaiting_verification');
    assert.equal(getTaskStatus(dir, '001-001-001-001'), 'awaiting_verification');
  } finally { cleanup(dir); }
});

await test('transitionTask: failed increments retryCount', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, { taskStatus: 'in_progress' });
    await transitionTask(dir, '001-001-001-001', 'failed');
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'mission-001-001.json'), 'utf8'));
    assert.equal(state.subMissions['001-001-001'].tasks['001-001-001-001'].retryCount, 1);
  } finally { cleanup(dir); }
});

await test('transitionTask: non-existent task throws', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir);
    await assertThrows(
      () => transitionTask(dir, '001-001-001-999', 'in_progress'),
      /Task not found/
    );
  } finally { cleanup(dir); }
});

// ---------- verified gate (I3, I17) ----------

await test('transitionTask: verified without caller throws', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, { taskStatus: 'awaiting_verification' });
    writeVerificationReport(dir, '001-001-001-001');
    await assertThrows(
      () => transitionTask(dir, '001-001-001-001', 'verified'),
      /requires caller: 'verification'/
    );
  } finally { cleanup(dir); }
});

await test('transitionTask: verified with wrong caller throws', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, { taskStatus: 'awaiting_verification' });
    writeVerificationReport(dir, '001-001-001-001');
    await assertThrows(
      () => transitionTask(dir, '001-001-001-001', 'verified', { caller: 'pipeline' }),
      /requires caller: 'verification'/
    );
  } finally { cleanup(dir); }
});

await test('transitionTask: verified without sidecar throws', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, { taskStatus: 'awaiting_verification' });
    // No JSON sidecar written
    await assertThrows(
      () => transitionTask(dir, '001-001-001-001', 'verified', { caller: 'verification' }),
      /requires verification sidecar/
    );
  } finally { cleanup(dir); }
});

await test('transitionTask: verified with caller AND report succeeds', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, { taskStatus: 'awaiting_verification' });
    writeVerificationReport(dir, '001-001-001-001');
    await transitionTask(dir, '001-001-001-001', 'verified', { caller: 'verification' });
    assert.equal(getTaskStatus(dir, '001-001-001-001'), 'verified');
  } finally { cleanup(dir); }
});

await test('transitionTask: verified → complete succeeds (no caller needed for this transition)', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, { taskStatus: 'verified' });
    await transitionTask(dir, '001-001-001-001', 'complete');
    assert.equal(getTaskStatus(dir, '001-001-001-001'), 'complete');
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'mission-001-001.json'), 'utf8'));
    assert.ok(state.subMissions['001-001-001'].tasks['001-001-001-001'].completedAt, 'completedAt should be set');
  } finally { cleanup(dir); }
});

await test('transitionTask: pending → invalidated succeeds and stamps completedAt', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir);
    await transitionTask(dir, '001-001-001-001', 'invalidated');
    assert.equal(getTaskStatus(dir, '001-001-001-001'), 'invalidated');

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'mission-001-001.json'), 'utf8'));
    const task = state.subMissions['001-001-001'].tasks['001-001-001-001'];
    assert.ok(task.completedAt, 'completedAt should be set');
  } finally { cleanup(dir); }
});

await test('transitionTask: in_progress → invalidated succeeds', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, { taskStatus: 'in_progress' });
    await transitionTask(dir, '001-001-001-001', 'invalidated');
    assert.equal(getTaskStatus(dir, '001-001-001-001'), 'invalidated');
  } finally { cleanup(dir); }
});

await test('transitionTask: complete → invalidated succeeds', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, { taskStatus: 'complete' });
    await transitionTask(dir, '001-001-001-001', 'invalidated');
    assert.equal(getTaskStatus(dir, '001-001-001-001'), 'invalidated');
  } finally { cleanup(dir); }
});

await test('transitionTask: invalidated → in_progress (illegal) throws', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, { taskStatus: 'invalidated' });
    await assertThrows(
      () => transitionTask(dir, '001-001-001-001', 'in_progress'),
      /Illegal task transition: invalidated/
    );
  } finally { cleanup(dir); }
});

await test('transitionTask: invalidated → invalidated (illegal) throws', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, { taskStatus: 'invalidated' });
    await assertThrows(
      () => transitionTask(dir, '001-001-001-001', 'invalidated'),
      /Illegal task transition: invalidated/
    );
  } finally { cleanup(dir); }
});

// ---------- transitionSubMission complete gate (I5) ----------

await test('transitionSubMission: complete with incomplete tasks throws', async () => {
  const dir = createHarnessDir();
  try {
    writeMissionState(dir, '001-001', {
      id: '001-001',
      missionId: '001-001',
      status: 'in_progress',
      subMissions: {
        '001-001-001': {
          id: '001-001-001',
          status: 'in_progress',
          tasks: {
            '001-001-001-001': { id: '001-001-001-001', status: 'complete' },
            '001-001-001-002': { id: '001-001-001-002', status: 'in_progress' },
          },
        },
      },
    });
    await assertThrows(
      () => transitionSubMission(dir, '001-001', '001-001-001', 'complete'),
      /tasks not terminal/
    );
  } finally { cleanup(dir); }
});

await test('transitionSubMission: complete with all terminal tasks succeeds', async () => {
  const dir = createHarnessDir();
  try {
    writeMissionState(dir, '001-001', {
      id: '001-001',
      missionId: '001-001',
      status: 'in_progress',
      subMissions: {
        '001-001-001': {
          id: '001-001-001',
          status: 'in_progress',
          tasks: {
            '001-001-001-001': { id: '001-001-001-001', status: 'complete' },
            '001-001-001-002': { id: '001-001-001-002', status: 'invalidated' },
          },
        },
      },
    });
    await transitionSubMission(dir, '001-001', '001-001-001', 'complete');
    assert.equal(getSubMissionStatus(dir, '001-001', '001-001-001'), 'complete');
  } finally { cleanup(dir); }
});

await test('transitionSubMission: in_progress → invalidated succeeds', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, { subMissionStatus: 'in_progress' });
    await transitionSubMission(dir, '001-001', '001-001-001', 'invalidated');
    assert.equal(getSubMissionStatus(dir, '001-001', '001-001-001'), 'invalidated');
  } finally { cleanup(dir); }
});

await test('transitionSubMission: invalidated → in_progress (illegal) throws', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, { subMissionStatus: 'invalidated' });
    await assertThrows(
      () => transitionSubMission(dir, '001-001', '001-001-001', 'in_progress'),
      /Illegal.*transition: invalidated/
    );
  } finally { cleanup(dir); }
});

await test('transitionSubMission: non-existent sub-mission throws', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir);
    await assertThrows(
      () => transitionSubMission(dir, '001-001', '001-001-999', 'in_progress'),
      /Sub-mission not found/
    );
  } finally { cleanup(dir); }
});

// ---------- transitionMission dual-write + complete gate ----------

await test('transitionMission: dual-writes mission state file and global state.json', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, {
      taskStatus: 'complete',
      subMissionStatus: 'complete',
      missionStatus: 'in_progress',
    });
    await transitionMission(dir, '001-001', 'complete');

    const mission = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'mission-001-001.json'), 'utf8'));
    const global = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.equal(mission.status, 'complete');
    assert.equal(global.milestones['001'].missions['001-001'].status, 'complete');
  } finally { cleanup(dir); }
});

await test('transitionMission: complete with incomplete sub-missions throws', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, {
      taskStatus: 'in_progress',
      subMissionStatus: 'in_progress',
      missionStatus: 'in_progress',
    });
    await assertThrows(
      () => transitionMission(dir, '001-001', 'complete'),
      /sub-missions not terminal/
    );
  } finally { cleanup(dir); }
});

await test('transitionMission: mission missing from global state.json throws', async () => {
  const dir = createHarnessDir();
  try {
    writeGlobalState(dir, {
      '001': {
        id: '001',
        status: 'in_progress',
        missions: {},  // no 001-001 entry
      },
    });
    writeMissionState(dir, '001-001', {
      id: '001-001',
      missionId: '001-001',
      status: 'in_progress',
      subMissions: {},
    });
    await assertThrows(
      () => transitionMission(dir, '001-001', 'blocked'),
      /not found in global state.json/
    );
  } finally { cleanup(dir); }
});

// ---------- transitionMilestone complete gate ----------

await test('transitionMilestone: complete with incomplete mission throws', async () => {
  const dir = createHarnessDir();
  try {
    writeGlobalState(dir, {
      '001': {
        id: '001',
        status: 'in_progress',
        missions: {
          '001-001': { id: '001-001', status: 'complete', stateFile: '.harness/state/mission-001-001.json' },
          '001-002': { id: '001-002', status: 'in_progress', stateFile: '.harness/state/mission-001-002.json' },
        },
      },
    });
    await assertThrows(
      () => transitionMilestone(dir, '001', 'complete'),
      /missions not terminal/
    );
  } finally { cleanup(dir); }
});

await test('transitionMilestone: complete with all terminal missions succeeds', async () => {
  const dir = createHarnessDir();
  try {
    writeGlobalState(dir, {
      '001': {
        id: '001',
        status: 'in_progress',
        missions: {
          '001-001': { id: '001-001', status: 'complete', stateFile: '.harness/state/mission-001-001.json' },
          '001-002': { id: '001-002', status: 'invalidated', stateFile: '.harness/state/mission-001-002.json' },
        },
      },
    });
    await transitionMilestone(dir, '001', 'complete');
    assert.equal(getMilestoneStatus(dir, '001'), 'complete');
  } finally { cleanup(dir); }
});

await test('transitionMilestone: non-existent milestone throws', async () => {
  const dir = createHarnessDir();
  try {
    writeGlobalState(dir, {});
    await assertThrows(
      () => transitionMilestone(dir, '999', 'in_progress'),
      /Milestone not found/
    );
  } finally { cleanup(dir); }
});

// ---------- cascadeComplete ----------

await test('cascadeComplete: cascades sub-mission → mission → milestone when all terminal', async () => {
  const dir = createHarnessDir();
  try {
    // Single-mission, single-sub-mission, single-task fixture where the
    // task is already complete — cascade reaches mission but milestone
    // cascade is removed entirely, so milestone stays in_progress.
    simpleFixture(dir, {
      taskStatus: 'complete',
      subMissionStatus: 'in_progress',
      missionStatus: 'in_progress',
    });
    const result = await cascadeComplete(dir, { missionId: '001-001', subMissionId: '001-001-001' });
    assert.equal(result.subMission, 'cascaded');
    assert.equal(result.mission, 'cascaded');
    assert.equal(result.milestone, 'skipped');
    assert.equal(getSubMissionStatus(dir, '001-001', '001-001-001'), 'complete');
    assert.equal(getMissionStatus(dir, '001-001'), 'complete');
    assert.equal(getMilestoneStatus(dir, '001'), 'in_progress');
  } finally { cleanup(dir); }
});

await test('cascadeComplete: milestone cascade removed entirely — milestone always skipped (not just gated by incomplete missions)', async () => {
  const dir = createHarnessDir();
  try {
    writeGlobalState(dir, {
      '001': {
        id: '001',
        status: 'in_progress',
        missions: {
          '001-001': { id: '001-001', status: 'in_progress', stateFile: '.harness/state/mission-001-001.json' },
          '001-002': { id: '001-002', status: 'in_progress', stateFile: '.harness/state/mission-001-002.json' },
        },
      },
    });
    writeMissionState(dir, '001-001', {
      id: '001-001',
      missionId: '001-001',
      status: 'in_progress',
      subMissions: {
        '001-001-001': {
          id: '001-001-001',
          status: 'in_progress',
          tasks: {
            '001-001-001-001': { id: '001-001-001-001', status: 'complete', retryCount: 0 },
          },
        },
      },
    });
    const result = await cascadeComplete(dir, { missionId: '001-001', subMissionId: '001-001-001' });
    assert.equal(result.subMission, 'cascaded');
    assert.equal(result.mission, 'cascaded');
    assert.equal(result.milestone, 'skipped');
    assert.equal(getMilestoneStatus(dir, '001'), 'in_progress');
  } finally { cleanup(dir); }
});

await test('cascadeComplete: stops at sub-mission when mission has other incomplete sub-missions', async () => {
  const dir = createHarnessDir();
  try {
    writeGlobalState(dir, {
      '001': {
        id: '001',
        status: 'in_progress',
        missions: {
          '001-001': { id: '001-001', status: 'in_progress', stateFile: '.harness/state/mission-001-001.json' },
        },
      },
    });
    writeMissionState(dir, '001-001', {
      id: '001-001',
      missionId: '001-001',
      status: 'in_progress',
      subMissions: {
        '001-001-001': {
          id: '001-001-001',
          status: 'in_progress',
          tasks: {
            '001-001-001-001': { id: '001-001-001-001', status: 'complete', retryCount: 0 },
          },
        },
        '001-001-002': {
          id: '001-001-002',
          status: 'in_progress',
          tasks: {
            '001-001-002-001': { id: '001-001-002-001', status: 'pending', retryCount: 0 },
          },
        },
      },
    });
    const result = await cascadeComplete(dir, { missionId: '001-001', subMissionId: '001-001-001' });
    assert.equal(result.subMission, 'cascaded');
    assert.equal(result.mission, 'skipped');
    assert.equal(getMissionStatus(dir, '001-001'), 'in_progress');
  } finally { cleanup(dir); }
});

await test('cascadeComplete: sub-mission not ready returns all skipped', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, {
      taskStatus: 'in_progress',
      subMissionStatus: 'in_progress',
      missionStatus: 'in_progress',
    });
    const result = await cascadeComplete(dir, { missionId: '001-001', subMissionId: '001-001-001' });
    assert.equal(result.subMission, 'skipped');
    assert.equal(result.mission, 'skipped');
    assert.equal(result.milestone, 'skipped');
    assert.equal(getSubMissionStatus(dir, '001-001', '001-001-001'), 'in_progress');
  } finally { cleanup(dir); }
});

await test('cascadeComplete: all-invalidated children cascades sub-mission to complete', async () => {
  const dir = createHarnessDir();
  try {
    simpleFixture(dir, {
      taskStatus: 'invalidated',
      subMissionStatus: 'in_progress',
      missionStatus: 'in_progress',
    });
    const result = await cascadeComplete(dir, { missionId: '001-001', subMissionId: '001-001-001' });
    assert.equal(result.subMission, 'cascaded');
    assert.equal(getSubMissionStatus(dir, '001-001', '001-001-001'), 'complete');
  } finally { cleanup(dir); }
});

// ---------- Readers on empty state ----------

await test('getTaskStatus: missing mission file returns null', async () => {
  const dir = createHarnessDir();
  try {
    assert.equal(getTaskStatus(dir, '001-001-001-001'), null);
  } finally { cleanup(dir); }
});

await test('getMilestoneStatus: missing global state returns null', async () => {
  const dir = createHarnessDir();
  try {
    assert.equal(getMilestoneStatus(dir, '001'), null);
  } finally { cleanup(dir); }
});

// ---------- resolveVerificationSidecar ----------

await test('resolveVerificationSidecar: is exported from state-machine.js', async () => {
  assert.equal(typeof resolveVerificationSidecar, 'function');
});

await test('resolveVerificationSidecar: returns { path, format:"task" } when task-{id}.json exists', async () => {
  const dir = createHarnessDir();
  try {
    const taskId = '001-001-001-001';
    writeVerificationReport(dir, taskId);
    const result = resolveVerificationSidecar(dir, taskId);
    assert.ok(result, 'should return a result object');
    assert.equal(result.format, 'task');
    assert.ok(result.path.endsWith(`task-${taskId}.json`), `path should end with task-${taskId}.json, got: ${result.path}`);
  } finally { cleanup(dir); }
});

await test('resolveVerificationSidecar: returns null when neither sidecar exists', async () => {
  const dir = createHarnessDir();
  try {
    const result = resolveVerificationSidecar(dir, '001-001-001-001');
    assert.equal(result, null);
  } finally { cleanup(dir); }
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

} // end of async function run()

run();
