/**
 * test-taskid-collision-rejection.js — Tests for cross-mission task ID collision
 * detection and sidecar reuse rejection.
 *
 * Test cases:
 *   TC-COLL-1: plain collision — inject duplicate taskId across missions throws TaskIdCollisionError
 *   TC-COLL-2: non-colliding inject succeeds — fresh-namespace ID appears in destination state
 *   TC-COLL-3: sidecar reuse rejected — pre-existing verification sidecar on firstWrite throws SidecarReuseError
 *
 * Run: node test/test-taskid-collision-rejection.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { mergeRemediationTasks } from '../src/orchestrator/gates/coverage.js';
import { TaskIdCollisionError } from '../src/orchestrator/core/task-id-collision-error.js';
import { SidecarReuseError } from '../src/orchestrator/core/sidecar-reuse-error.js';
import { extractVerdict } from '../src/orchestrator/agents/verifier.js';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collision-test-'));
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

// ── Fixtures ─────────────────────────────────────────────────────────────────

const fixturePassed = {
  structured_output: {
    result: 'PASSED',
    hardChecks: [],
    taskScopeChecks: [],
    notes: '',
  },
};

// ── Tests ────────────────────────────────────────────────────────────────────

// TC-COLL-1: plain collision — inject duplicate taskId across missions throws TaskIdCollisionError
await test('TC-COLL-1: plain collision — inject duplicate taskId across missions throws TaskIdCollisionError', async () => {
  const { harnessDir } = createMultiMissionEnv();
  try {
    // Pre-populate mission 001-001 with task 001-001-001-001 (status: 'complete')
    const mission1StatePath = path.join(harnessDir, 'state', 'mission-001-001.json');
    const mission1State = JSON.parse(fs.readFileSync(mission1StatePath, 'utf8'));
    mission1State.subMissions['001-001-001'].tasks['001-001-001-001'] = {
      id: '001-001-001-001',
      description: 'pre-existing task in mission one',
      status: 'complete',
      retryCount: 0,
    };
    fs.writeFileSync(mission1StatePath, JSON.stringify(mission1State, null, 2));

    // Write a progress sidecar for the pre-existing task
    fs.writeFileSync(
      path.join(harnessDir, 'progress', 'task-001-001-001-001.json'),
      JSON.stringify({ taskId: '001-001-001-001', status: 'complete' }, null, 2)
    );

    // Attempt to inject a task with the same id into mission 001-002
    let threw = null;
    try {
      await mergeRemediationTasks({
        harnessDir,
        missionId: '001-002',
        newTasks: [{
          id: '001-001-001-001',
          subMissionId: '001-002-001',
          description: 'duplicate id task',
          targetFiles: [],
          testCases: [],
        }],
        missionDecomp: makeDecomp('001-002-001'),
      });
    } catch (err) {
      threw = err;
    }

    assert.ok(threw !== null, 'expected mergeRemediationTasks to throw but it did not');
    assert.strictEqual(threw.name, 'TaskIdCollisionError',
      `expected error.name === 'TaskIdCollisionError', got '${threw.name}'`);
    assert.strictEqual(threw.taskId, '001-001-001-001',
      `expected error.taskId === '001-001-001-001', got '${threw.taskId}'`);
  } finally {
    cleanup(harnessDir);
  }
});

// TC-COLL-2: non-colliding inject succeeds — fresh-namespace ID appears in destination state
await test('TC-COLL-2: non-colliding inject succeeds — fresh-namespace ID appears in destination state', async () => {
  const { harnessDir } = createMultiMissionEnv();
  try {
    // Inject a task with a fresh id into mission 001-002
    await mergeRemediationTasks({
      harnessDir,
      missionId: '001-002',
      newTasks: [{
        id: '001-002-001-001',
        subMissionId: '001-002-001',
        description: 'fresh task in mission two',
        targetFiles: [],
        testCases: [],
      }],
      missionDecomp: makeDecomp('001-002-001'),
    });

    const state = readMissionState(harnessDir, '001-002');
    const task = state.subMissions['001-002-001'].tasks['001-002-001-001'];

    assert.ok(task !== undefined,
      `expected task '001-002-001-001' to exist in state.subMissions['001-002-001'].tasks`);
    assert.strictEqual(task.status, 'pending',
      `expected task.status === 'pending', got '${task.status}'`);
  } finally {
    cleanup(harnessDir);
  }
});

// TC-COLL-3: sidecar reuse rejected — pre-existing verification sidecar on firstWrite throws SidecarReuseError
await test('TC-COLL-3: sidecar reuse rejected — pre-existing verification sidecar on firstWrite throws SidecarReuseError', async () => {
  const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-reuse-test-'));
  try {
    // Create the verification directory and a pre-existing sidecar file
    fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
    fs.writeFileSync(
      path.join(harnessDir, 'verification', 'task-001-001-001-001.json'),
      JSON.stringify({ result: 'PASSED', notes: 'pre-existing sidecar' }, null, 2)
    );

    // Attempt to call extractVerdict with firstWrite: true — should throw SidecarReuseError
    let threw = null;
    try {
      extractVerdict(fixturePassed, '001-001-001-001', harnessDir, { firstWrite: true });
    } catch (err) {
      threw = err;
    }

    assert.ok(threw !== null, 'expected extractVerdict to throw but it did not');
    assert.strictEqual(threw.name, 'SidecarReuseError',
      `expected error.name === 'SidecarReuseError', got '${threw.name}'`);
    assert.ok(
      threw.sidecarPath && threw.sidecarPath.includes('verification/task-001-001-001-001.json'),
      `expected error.sidecarPath to contain 'verification/task-001-001-001-001.json', got '${threw.sidecarPath}'`
    );
  } finally {
    cleanup(harnessDir);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
