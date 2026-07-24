/**
 * test-scheduler-replace-task.js — Unit tests for Scheduler.replaceTask and
 * its helper methods (_findDependents, _validateTargetFilesSubset, _validateAcyclicity).
 *
 * The actual replaceTask implementation reads _tasksById and _pending from the
 * scheduler instance (not from a context parameter), so tests set those instance
 * properties directly following the pattern established in test-circuit-breaker-replan.js.
 *
 * Tests:
 *  1. Basic replacement: single failed task, no dependents → 1 invalidated, N inserted.
 *  2. Transitive invalidation: A → B → C chain, A fails → B and C invalidated.
 *  3. Dependency rewiring: A fails, replaced by [A1, A2] → a surviving task's dep on A
 *     is rewritten to A2 (last replacement).
 *  4. targetFiles subset violation: replacement task references a file outside original → throws.
 *  5. Acyclicity violation: replacement task creates a cycle → throws.
 *  6. Replan cap exceeded: more than MAX_REPLAN_ATTEMPTS calls for same original → throws.
 *  7. Replan cap tracks original ID: X-rp-001 failing charges against X's cap.
 *  8. Return value shape: { invalidated, inserted } contain correct IDs.
 *  9. Integration with ready queue: after replaceTask, _pickAssignableTask returns
 *     the replacement task.
 *
 * Run: node test/test-scheduler-replace-task.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Scheduler } from '../src/orchestrator/core/scheduler.js';

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
 * Create a temp harness dir with a minimal global state.json + per-mission
 * state files. Tasks default to 'pending' unless overridden in `preStatus`.
 * Copied verbatim from test-scheduler.js so tests run in isolation.
 */
function createSchedHarness(tasks, { preStatus = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-rp-test-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });

  const byMission = new Map();
  for (const task of tasks) {
    if (!byMission.has(task.missionId)) byMission.set(task.missionId, []);
    byMission.get(task.missionId).push(task);
  }

  const milestones = { '001': { id: '001', status: 'in_progress', missions: {} } };

  for (const [missionId, missionTasks] of byMission.entries()) {
    milestones['001'].missions[missionId] = {
      id: missionId,
      status: 'in_progress',
      stateFile: `.harness/state/mission-${missionId}.json`,
    };
    const bySubMission = new Map();
    for (const t of missionTasks) {
      if (!bySubMission.has(t.subMissionId)) bySubMission.set(t.subMissionId, []);
      bySubMission.get(t.subMissionId).push(t);
    }
    const subMissions = {};
    for (const [smId, smTasks] of bySubMission.entries()) {
      const taskMap = {};
      for (const t of smTasks) {
        taskMap[t.id] = {
          id: t.id,
          description: t.description || 'test',
          status: preStatus[t.id] || 'pending',
          retryCount: 0,
        };
      }
      subMissions[smId] = { id: smId, status: 'in_progress', tasks: taskMap };
    }
    fs.writeFileSync(
      path.join(dir, 'state', `mission-${missionId}.json`),
      JSON.stringify({
        id: missionId,
        missionId,
        description: 'test mission',
        status: 'in_progress',
        subMissions,
      }, null, 2)
    );
  }

  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones,
    }, null, 2)
  );

  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a mock runTask callback that records task execution order and marks
 * tasks complete via the real state machine. Copied from test-scheduler.js
 * for use in the integration test (test 9).
 */
function makeMockRunTask({ harnessDir, delay = 5, failTaskIds = new Set() }) {
  const trace = {
    startOrder: [],
    runningAtStart: [],
    completeOrder: [],
  };
  const running = new Set();

  async function mockRunTask(task) {
    trace.startOrder.push(task.id);
    trace.runningAtStart.push({
      taskId: task.id,
      concurrentlyRunning: new Set(running),
    });
    running.add(task.id);

    if (failTaskIds.has(task.id)) {
      running.delete(task.id);
      throw new Error(`mock failure: ${task.id}`);
    }

    await new Promise((r) => setTimeout(r, delay));

    const { transitionTask } = await import('../src/orchestrator/core/state-machine.js');
    const { readTaskStatus } = await import('../src/orchestrator/core/state.js');
    const status = readTaskStatus(harnessDir, task.id);
    if (status === 'pending') {
      await transitionTask(harnessDir, task.id, 'in_progress');
    }
    const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.writeFileSync(sidecarPath, JSON.stringify({ verified: true }));
    await transitionTask(harnessDir, task.id, 'awaiting_verification');
    await transitionTask(harnessDir, task.id, 'verified', { caller: 'verification' });
    await transitionTask(harnessDir, task.id, 'complete');

    running.delete(task.id);
    trace.completeOrder.push(task.id);
  }

  return { mockRunTask, trace };
}

/**
 * Build a minimal Scheduler instance with a no-op runTask and preset DAG state.
 * The actual replaceTask reads _tasksById and _pending from instance properties,
 * so we set them here (pattern from test-circuit-breaker-replan.js).
 */
function makeScheduler(harnessDir, tasks) {
  const scheduler = new Scheduler({
    harnessDir,
    projectRoot: harnessDir,
    maxConcurrent: 4,
    runTask: async () => {},
  });
  scheduler._tasksById = new Map(tasks.map((t) => [t.id, t]));
  scheduler._pending = new Set(tasks.map((t) => t.id));
  scheduler._runningFiles = new Set();
  return scheduler;
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {

// ── Test 1: Basic replacement ──────────────────────────────────────────────
await test('basic replacement: single failed task with no dependents → 1 invalidated, N inserted', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js', 'src/b.js'],
    dependencies: [],
    description: 'Task A',
  };
  const dir = createSchedHarness([taskA]);
  try {
    const scheduler = makeScheduler(dir, [taskA]);

    const replacements = [
      {
        id: '001-001-001-001-rp-001',
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['src/a.js'],
        dependencies: [],
        description: 'Replacement 1',
      },
      {
        id: '001-001-001-001-rp-002',
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['src/b.js'],
        dependencies: [],
        description: 'Replacement 2',
      },
    ];

    const result = await scheduler.replaceTask(taskA.id, replacements);

    assert.deepStrictEqual(result.invalidated, [taskA.id], 'invalidated should contain only the failed task');
    assert.deepStrictEqual(result.inserted, ['001-001-001-001-rp-001', '001-001-001-001-rp-002'],
      'inserted should contain both replacement task IDs');

    assert.ok(!scheduler._pending.has(taskA.id), 'original task should be removed from pending');
    assert.ok(scheduler._pending.has('001-001-001-001-rp-001'), 'replacement 1 should be in pending');
    assert.ok(scheduler._pending.has('001-001-001-001-rp-002'), 'replacement 2 should be in pending');
  } finally { cleanup(dir); }
});

// ── Test 2: Preserve+rewire ────────────────────────────────────────────────
await test('preserve+rewire: A → B → C chain, A fails → only A invalidated, B and C preserved and rewired', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A',
  };
  const taskB = {
    id: '001-001-001-002',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/b.js'],
    dependencies: [{ type: 'hard', taskId: '001-001-001-001' }],
    description: 'Task B (depends on A)',
  };
  const taskC = {
    id: '001-001-001-003',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/c.js'],
    dependencies: [{ type: 'hard', taskId: '001-001-001-002' }],
    description: 'Task C (depends on B)',
  };

  const dir = createSchedHarness([taskA, taskB, taskC]);
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB, taskC]);

    const replacements = [
      {
        id: '001-001-001-001-rp-001',
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['src/a.js'],
        dependencies: [],
        description: 'Replacement for A',
      },
    ];

    const result = await scheduler.replaceTask(taskA.id, replacements);

    assert.deepStrictEqual(result.invalidated, [taskA.id]);

    assert.strictEqual(result.inserted.length, 1, 'should insert 1 replacement');
    assert.ok(result.inserted.includes('001-001-001-001-rp-001'), 'replacement should be inserted');

    // B and C remain in the DAG and pending (preserved and rewired)
    assert.ok(scheduler._tasksById.has(taskB.id), 'B remains in _tasksById');
    assert.ok(scheduler._tasksById.has(taskC.id), 'C remains in _tasksById');
    assert.ok(scheduler._pending.has(taskB.id), 'B remains in _pending');
    assert.ok(scheduler._pending.has(taskC.id), 'C remains in _pending');

    // B's dep is rewired from A to the last replacement
    assert.strictEqual(scheduler._tasksById.get(taskB.id).dependencies[0].taskId, '001-001-001-001-rp-001',
      "B's dependency should be rewired from A to '001-001-001-001-rp-001'");
    // C's dep on B is unchanged
    assert.strictEqual(scheduler._tasksById.get(taskC.id).dependencies[0].taskId, taskB.id,
      "C's dependency on B should remain unchanged");

    // readTaskStatus for B and C should be 'pending' not 'invalidated'
    const { readTaskStatus } = await import('../src/orchestrator/core/state.js');
    assert.strictEqual(readTaskStatus(dir, taskB.id), 'pending', 'B status should be pending not invalidated');
    assert.strictEqual(readTaskStatus(dir, taskC.id), 'pending', 'C status should be pending not invalidated');
  } finally { cleanup(dir); }
});

// ── Test 3: Dependency rewiring ─────────────────────────────────────────────
//
// Exercises the rewiring code path: when A is replaced by [A1, A2], a surviving
// task B whose dep points to A should have its dep rewritten to A2 (last replacement).
// B is preserved (not invalidated) and remains in _pending.
await test('dependency rewiring: surviving task dep on failedTaskId is rewritten to last replacement', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js', 'src/b.js'],
    dependencies: [],
    description: 'Task A (will be replaced)',
  };

  const taskB = {
    id: '001-001-001-002',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/c.js'],
    dependencies: [{ type: 'hard', taskId: '001-001-001-001' }],
    description: 'Task B (dep on A — should be rewired)',
  };

  // Both tasks are in the state file and in the in-memory DAG.
  const dir = createSchedHarness([taskA, taskB]);
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB]);

    const repA1 = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'Replacement A1',
    };
    const repA2 = {
      id: '001-001-001-001-rp-002',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/b.js'],
      dependencies: [],
      description: 'Replacement A2',
    };

    const result = await scheduler.replaceTask(taskA.id, [repA1, repA2]);

    // Only A should be invalidated; B is preserved and rewired.
    assert.strictEqual(result.invalidated.length, 1, 'only A should be in invalidated');
    assert.strictEqual(result.invalidated[0], taskA.id, 'invalidated[0] should be taskA.id');

    assert.deepStrictEqual(result.inserted, [repA1.id, repA2.id], 'both replacements should be inserted');

    // The rewiring step must have updated B's dep from A to A2 (the last replacement).
    const bAfter = scheduler._tasksById.get(taskB.id);
    assert.ok(bAfter, 'B should still be in _tasksById');
    assert.strictEqual(bAfter.dependencies.length, 1, 'B should still have 1 dependency');
    assert.strictEqual(bAfter.dependencies[0].taskId, repA2.id,
      `B's dep should be rewired from A to A2 (${repA2.id}), got: ${bAfter.dependencies[0].taskId}`);

    // B remains in _pending after rewire
    assert.ok(scheduler._pending.has(taskB.id), 'B remains in _pending after rewire');
  } finally { cleanup(dir); }
});

// ── Test 4: targetFiles subset violation ────────────────────────────────────
await test('targetFiles subset violation: replacement task has file outside original → throws', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A',
  };
  const dir = createSchedHarness([taskA]);
  try {
    const scheduler = makeScheduler(dir, [taskA]);

    const badReplacement = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/b.js'],   // 'src/b.js' is NOT in A's targetFiles
      dependencies: [],
      description: 'Bad replacement (illegal file)',
    };

    let threw = null;
    try {
      await scheduler.replaceTask(taskA.id, [badReplacement]);
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, 'replaceTask should throw on targetFiles subset violation');
    assert.ok(
      /targetFiles|subset/i.test(threw.message),
      `error message should mention targetFiles/subset, got: ${threw.message}`
    );
  } finally { cleanup(dir); }
});

// ── Test 5: Acyclicity violation ────────────────────────────────────────────
await test('acyclicity violation: replacement task creates a cycle → throws', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A (will be replaced)',
  };
  const dir = createSchedHarness([taskA]);
  try {
    const scheduler = makeScheduler(dir, [taskA]);

    // R1 depends on itself — a self-loop that the acyclicity check must catch.
    const cyclicReplacement = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [{ type: 'hard', taskId: '001-001-001-001-rp-001' }],
      description: 'Cyclic replacement (self-loop)',
    };

    let threw = null;
    try {
      await scheduler.replaceTask(taskA.id, [cyclicReplacement]);
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, 'replaceTask should throw on acyclicity violation');
    assert.ok(
      /cycle/i.test(threw.message),
      `error message should mention cycle, got: ${threw.message}`
    );

    // After rollback, the cyclic replacement task should have been removed from _tasksById.
    assert.ok(
      !scheduler._tasksById.has('001-001-001-001-rp-001'),
      'cyclic replacement should be rolled back from _tasksById'
    );
  } finally { cleanup(dir); }
});

// ── Test 6: Replan cap exceeded ─────────────────────────────────────────────
await test('replan cap exceeded: MAX_REPLAN_ATTEMPTS+1 calls for same original → last call throws', async () => {
  const MAX = Scheduler.MAX_REPLAN_ATTEMPTS;

  // Include the first replacement in the state file so its transitionTask
  // (pending → invalidated) in the second replaceTask call can succeed.
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A (original)',
  };
  const taskRp1 = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Replacement 1 (also in state file)',
  };

  const dir = createSchedHarness([taskA, taskRp1]);
  try {
    // Start with only taskA active in the in-memory DAG.
    const scheduler = makeScheduler(dir, [taskA]);

    // ── Call 1: replace A with rp-001 (attempt 1 of MAX) ────────────────
    const rp1 = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'Replacement 1',
    };
    await scheduler.replaceTask(taskA.id, [rp1]);
    assert.strictEqual(scheduler._replanAttempts.get('001-001-001-001'), 1,
      'after first replaceTask, replanAttempts should be 1');

    // ── Call 2: replace rp-001 with rp-002 (attempt 2 of MAX) ────────────
    // rp-001 is now in _tasksById (inserted by call 1).
    // Its disk state is still 'pending' (from the harness), so the transition succeeds.
    const rp2 = {
      id: '001-001-001-001-rp-002',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'Replacement 2',
    };

    if (MAX >= 2) {
      await scheduler.replaceTask(rp1.id, [rp2]);
      assert.strictEqual(scheduler._replanAttempts.get('001-001-001-001'), 2,
        'after second replaceTask, replanAttempts should be 2');
    }

    // ── Call MAX+1: should throw cap exceeded ─────────────────────────────
    // The failing task for this call is rp2 if MAX>=2, rp1 if MAX===1.
    // Either way the original ID resolves to '001-001-001-001'.
    const lastActiveRpId = MAX >= 2 ? rp2.id : rp1.id;
    const rp3 = {
      id: '001-001-001-001-rp-003',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'Replacement 3 (should be blocked by cap)',
    };

    let threw = null;
    try {
      await scheduler.replaceTask(lastActiveRpId, [rp3]);
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, 'should throw when replan cap is exceeded');
    assert.ok(
      /replan cap/i.test(threw.message),
      `error should mention replan cap, got: ${threw.message}`
    );
  } finally { cleanup(dir); }
});

// ── Test 7: Replan cap tracks original ID ──────────────────────────────────
await test('replan cap tracks original ID: X-rp-001 failing charges against X', async () => {
  const taskX = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/x.js'],
    dependencies: [],
    description: 'Task X',
  };
  const taskXRp1 = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/x.js'],
    dependencies: [],
    description: 'X replacement 1',
  };

  // Both X and X-rp-001 need state file entries (X-rp-001 will be transitioned
  // to 'invalidated' in the second replaceTask call).
  const dir = createSchedHarness([taskX, taskXRp1]);
  try {
    // Start with only taskX active in the in-memory DAG.
    const scheduler = makeScheduler(dir, [taskX]);

    // ── Call 1: replace X with X-rp-001 ────────────────────────────────
    const rp1 = { ...taskXRp1 };
    await scheduler.replaceTask(taskX.id, [rp1]);

    // Verify cap is charged against the ORIGINAL ID 'X' (001-001-001-001).
    assert.strictEqual(
      scheduler._replanAttempts.get('001-001-001-001'), 1,
      'after replacing X, _replanAttempts["X"] should be 1'
    );
    assert.ok(
      !scheduler._replanAttempts.has('001-001-001-001-rp-001'),
      'replanAttempts should NOT have an entry for the rp-001 ID itself'
    );

    // ── Call 2: replace X-rp-001 (which now "fails") ───────────────────
    // X-rp-001 disk state is 'pending' (from harness). Its in-memory entry
    // was inserted by call 1. Replacing it should charge against X.
    const rp2 = {
      id: '001-001-001-001-rp-002',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/x.js'],
      dependencies: [],
      description: 'X replacement 2',
    };

    let call2Threw = null;
    try {
      await scheduler.replaceTask(rp1.id, [rp2]);
    } catch (err) {
      call2Threw = err;
    }

    if (Scheduler.MAX_REPLAN_ATTEMPTS >= 2) {
      // Second call should succeed (MAX=2 allows 2 attempts, we've only done 1).
      assert.ok(!call2Threw, `second replaceTask on X-rp-001 should succeed, got: ${call2Threw?.message}`);
      assert.strictEqual(
        scheduler._replanAttempts.get('001-001-001-001'), 2,
        'after replacing X-rp-001, _replanAttempts["X"] should be 2'
      );
    } else {
      // If MAX===1, second call should throw cap exceeded.
      assert.ok(call2Threw, 'second call should throw when MAX_REPLAN_ATTEMPTS is 1');
      assert.ok(/replan cap/i.test(call2Threw.message), 'should throw replan cap error');
    }

    // In all cases, the attempt counter tracks under the original ID only.
    const attempts = scheduler._replanAttempts.get('001-001-001-001');
    assert.ok(typeof attempts === 'number' && attempts > 0,
      `_replanAttempts["X"] should be a positive number, got ${attempts}`);
    assert.ok(
      !scheduler._replanAttempts.has('001-001-001-001-rp-001'),
      'replanAttempts must NOT have an entry for the rp suffix ID'
    );
  } finally { cleanup(dir); }
});

// ── Test 8: Return value shape ──────────────────────────────────────────────
await test('return value shape: { invalidated, inserted } contain correct IDs', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A',
  };
  const taskB = {
    id: '001-001-001-002',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/b.js'],
    dependencies: [{ type: 'hard', taskId: '001-001-001-001' }],
    description: 'Task B (depends on A)',
  };

  const dir = createSchedHarness([taskA, taskB]);
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB]);

    const rp1 = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'Replacement 1',
    };
    const rp2 = {
      id: '001-001-001-001-rp-002',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [{ type: 'hard', taskId: '001-001-001-001-rp-001' }],
      description: 'Replacement 2',
    };

    const result = await scheduler.replaceTask(taskA.id, [rp1, rp2]);

    // Shape checks.
    assert.ok(typeof result === 'object' && result !== null, 'result must be an object');
    assert.ok(Array.isArray(result.invalidated), 'result.invalidated must be an array');
    assert.ok(Array.isArray(result.inserted), 'result.inserted must be an array');

    // Content checks.
    assert.ok(result.invalidated.includes(taskA.id), 'invalidated must include A');
    // Per the new spec: only the failed task (A) is invalidated; B is preserved via rewire.
    assert.ok(!result.invalidated.includes(taskB.id), 'invalidated must NOT include B (B is preserved and rewired, not invalidated)');
    assert.ok(result.inserted.includes(rp1.id), 'inserted must include rp1');
    assert.ok(result.inserted.includes(rp2.id), 'inserted must include rp2');

    // Order: inserted order should match the order replacement tasks were provided.
    assert.strictEqual(result.inserted[0], rp1.id, 'first inserted should be rp1');
    assert.strictEqual(result.inserted[1], rp2.id, 'second inserted should be rp2');

    // B is preserved (not invalidated): it must still be in _pending.
    assert.ok(scheduler._pending.has(taskB.id),
      'B should still be in _pending (preserved and rewired, not invalidated)');

    // B's dependency on A must be rewired to the last replacement (rp2).
    const bAfter = scheduler._tasksById.get(taskB.id);
    assert.ok(bAfter, 'B should still be in _tasksById');
    assert.strictEqual(
      bAfter.dependencies[0].taskId, rp2.id,
      `B's dep should be rewired to last replacement (${rp2.id}), got: ${bAfter.dependencies[0].taskId}`
    );
  } finally { cleanup(dir); }
});

// ── Test 9: Integration with ready queue ────────────────────────────────────
await test('integration with ready queue: after replaceTask, replacement is pickable by _pickAssignableTask', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A (will be replaced)',
  };

  const dir = createSchedHarness([taskA]);
  try {
    const scheduler = makeScheduler(dir, [taskA]);

    const replacement = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],   // no deps → immediately assignable
      description: 'Replacement (no deps)',
    };

    await scheduler.replaceTask(taskA.id, [replacement]);

    // After replaceTask the replacement must be in both the live DAG and pending set.
    assert.ok(scheduler._pending.has(replacement.id), 'replacement should be in _pending after replaceTask');
    assert.ok(scheduler._tasksById.has(replacement.id), 'replacement should be in _tasksById after replaceTask');

    // The replacement has no deps (areDepsSatisfied = true) and no targetFile
    // conflicts (runningFiles is empty). _pickAssignableTask should return it.
    const workers = new Map();    // no in-flight workers
    const picked = scheduler._pickAssignableTask(
      scheduler._pending, scheduler._tasksById, workers, scheduler._runningFiles
    );

    assert.ok(picked !== null, '_pickAssignableTask should return a task (not null)');
    assert.strictEqual(picked.id, replacement.id,
      `_pickAssignableTask should return the replacement task, got: ${picked?.id}`);
  } finally { cleanup(dir); }
});

// ── Test 10: validate-then-mutate — disk state untouched on subset violation ──
//
// Validates the validate-then-mutate contract introduced by moving step 7
// (targetFiles subset check) before steps 5–6 (disk invalidation).
// When _validateTargetFilesSubset throws the failed task's on-disk status
// MUST remain 'pending' (i.e. it must NOT have been transitioned to
// 'invalidated' before the throw).
await test('validate-then-mutate: disk status stays pending when subset validation fails before invalidation', async () => {
  const { readTaskStatus } = await import('../src/orchestrator/core/state.js');

  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A',
  };
  const dir = createSchedHarness([taskA]);
  try {
    const scheduler = makeScheduler(dir, [taskA]);

    // A replacement task that references a file NOT in the sub-mission scope.
    // This will cause _validateTargetFilesSubset to throw BEFORE any disk
    // mutation occurs.
    const badReplacement = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/OUTSIDE.js'],   // not in taskA.targetFiles
      dependencies: [],
      description: 'Bad replacement (file outside sub-mission scope)',
    };

    // Confirm disk state before the call.
    const statusBefore = readTaskStatus(dir, taskA.id);
    assert.strictEqual(statusBefore, 'pending',
      `pre-condition: task A disk status should be 'pending', got '${statusBefore}'`);

    let threw = null;
    try {
      await scheduler.replaceTask(taskA.id, [badReplacement]);
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, 'replaceTask should throw on targetFiles subset violation');
    assert.ok(/targetFiles|subset/i.test(threw.message),
      `error message should mention targetFiles/subset, got: ${threw.message}`);

    // KEY ASSERTION: disk status must still be 'pending' — the invalidation
    // step must NOT have run before the validation failure.
    const statusAfter = readTaskStatus(dir, taskA.id);
    assert.strictEqual(statusAfter, 'pending',
      `after subset-validation failure, task A disk status must still be 'pending', got '${statusAfter}'`);

    // Also verify in-memory pending set is unchanged.
    assert.ok(scheduler._pending.has(taskA.id),
      'task A should still be in _pending after failed replaceTask');
  } finally { cleanup(dir); }
});

// ── Test 11: Regression — successful replaceTask still works after reorder ───
//
// Ensures the validate-before-mutate reorder introduced no regression: a valid
// replacement still invalidates the failed task on disk and inserts
// the replacement into the in-memory DAG and pending set.
await test('regression: successful replaceTask invalidates failed task on disk and inserts replacements', async () => {
  const { readTaskStatus } = await import('../src/orchestrator/core/state.js');

  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A (will be validly replaced)',
  };
  const dir = createSchedHarness([taskA]);
  try {
    const scheduler = makeScheduler(dir, [taskA]);

    const replacement = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],   // legal: within the sub-mission scope
      dependencies: [],
      description: 'Valid replacement',
    };

    const result = await scheduler.replaceTask(taskA.id, [replacement]);

    // Return value shape.
    assert.deepStrictEqual(result.invalidated, [taskA.id],
      'invalidated should contain the failed task ID');
    assert.deepStrictEqual(result.inserted, [replacement.id],
      'inserted should contain the replacement task ID');

    // Disk state: original task must now be 'invalidated'.
    const diskStatus = readTaskStatus(dir, taskA.id);
    assert.strictEqual(diskStatus, 'invalidated',
      `task A disk status should be 'invalidated' after successful replaceTask, got '${diskStatus}'`);

    // In-memory: original removed from pending, replacement added.
    assert.ok(!scheduler._pending.has(taskA.id),
      'original task should be removed from _pending');
    assert.ok(scheduler._pending.has(replacement.id),
      'replacement task should be added to _pending');
    assert.ok(scheduler._tasksById.has(replacement.id),
      'replacement task should be in _tasksById');
  } finally { cleanup(dir); }
});

// ── Test 12: Dedup duplicate replacements ─────────────────────────────────
//
// When two replacement tasks share the same (description, sorted targetFiles)
// key they are considered duplicates. Only the first occurrence is kept; the
// rest are dropped. Any dependency in a kept replacement that references a
// dropped ID is rewritten to the kept duplicate's ID.
await test('dedup: duplicate replacements by (description, sorted targetFiles) are collapsed', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js', 'src/b.js'],
    dependencies: [],
    description: 'Task A (will be replaced)',
  };
  const dir = createSchedHarness([taskA]);
  try {
    const scheduler = makeScheduler(dir, [taskA]);

    // rep1 and rep2 share the same description + sorted targetFiles → duplicates.
    // rep2 will be dropped; rep3 depends on rep2 so its dep must be rewritten to rep1.
    const rep1 = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'Dup desc',
    };
    const rep2 = {
      id: '001-001-001-001-rp-002',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],   // same targetFiles as rep1
      dependencies: [],
      description: 'Dup desc',    // same description as rep1 → duplicate, will be dropped
    };
    const rep3 = {
      id: '001-001-001-001-rp-003',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/b.js'],
      dependencies: [{ type: 'hard', taskId: '001-001-001-001-rp-002' }],  // points to dropped rep2
      description: 'Unique desc',
    };

    const result = await scheduler.replaceTask(taskA.id, [rep1, rep2, rep3]);

    // Only 2 of the 3 should be inserted: rep1 (kept) and rep3 (unique).
    assert.strictEqual(result.inserted.length, 2,
      `dedup should collapse to 2 unique replacements, got ${result.inserted.length}: ${JSON.stringify(result.inserted)}`);
    assert.ok(result.inserted.includes(rep1.id), 'rep1 (first of the duplicate pair) should be kept');
    assert.ok(result.inserted.includes(rep3.id), 'rep3 (unique) should be kept');
    assert.ok(!result.inserted.includes(rep2.id), 'rep2 (duplicate) should be dropped');

    // Dropped ID must not appear in the live DAG.
    assert.ok(!scheduler._tasksById.has(rep2.id),
      'dropped duplicate (rep2) should not be in _tasksById');

    // rep3's dependency on the dropped rep2 must be rewritten to the kept rep1.
    const rep3After = scheduler._tasksById.get(rep3.id);
    assert.ok(rep3After, 'rep3 should be in _tasksById');
    assert.strictEqual(rep3After.dependencies.length, 1, 'rep3 should still have exactly 1 dependency');
    assert.strictEqual(
      rep3After.dependencies[0].taskId, rep1.id,
      `rep3's dep on dropped rep2 should be rewritten to kept rep1 (${rep1.id}), got: ${rep3After.dependencies[0].taskId}`
    );
  } finally { cleanup(dir); }
});

// ── Test 13: rewireSnapshot rollback ──────────────────────────────────────
//
// When replaceTask rewires a surviving task's dependency and the subsequent
// acyclicity check detects a cycle, the rewired dependency must be rolled back
// to its original value (the rewireSnapshot must be applied on failure).
await test('rewireSnapshot rollback: acyclicity failure restores rewired deps', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A (will be replaced)',
  };
  // B depends on A — it will be rewired to the replacement before the cycle check.
  const taskB = {
    id: '001-001-001-002',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/b.js'],
    dependencies: [{ type: 'hard', taskId: '001-001-001-001' }],
    description: 'Task B (depends on A)',
  };

  const dir = createSchedHarness([taskA, taskB]);
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB]);

    // R1 depends on B. After A is removed and B is rewired to R1 we get:
    //   R1 → B → R1  (cycle!)
    // The acyclicity check must catch this and roll back B's rewired dep.
    const rep1 = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [{ type: 'hard', taskId: '001-001-001-002' }],  // R1 depends on B
      description: 'Replacement R1 (creates cycle through B)',
    };

    let threw = null;
    try {
      await scheduler.replaceTask(taskA.id, [rep1]);
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, 'replaceTask should throw due to cycle detection');
    assert.ok(
      /cycle/i.test(threw.message),
      `error message should mention cycle, got: ${threw.message}`
    );

    // KEY ASSERTION: after rollback, B's dependency must be restored to point at
    // the original task A — NOT at the replacement R1.
    const bAfter = scheduler._tasksById.get(taskB.id);
    assert.ok(bAfter, 'B should still be in _tasksById after failed replaceTask');
    assert.strictEqual(bAfter.dependencies.length, 1,
      'B should still have exactly 1 dependency after rollback');
    assert.strictEqual(
      bAfter.dependencies[0].taskId, taskA.id,
      `B's dep should be restored to A (${taskA.id}) after rollback, got: ${bAfter.dependencies[0].taskId}`
    );
  } finally { cleanup(dir); }
});

// ── Test 14: replacement tasks get a verify.json sidecar on disk ────────────
//
// BEHAVIOR 2: after replaceTask, every replacement task that is actually
// inserted and persisted into the mission state file must have its
// .harness/verify/task-<id>.json present on disk, containing at least
// `taskId` and `targetFiles`. Asserts behavior (file existence + parse +
// fields), not implementation details.
await test('replacement tasks get a verify.json sidecar (taskId + targetFiles) on disk', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js', 'src/b.js'],
    dependencies: [],
    description: 'Task A (will be replaced)',
  };
  const dir = createSchedHarness([taskA]);
  try {
    const scheduler = makeScheduler(dir, [taskA]);

    const replacements = [
      {
        id: '001-001-001-001-rp-001',
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['src/a.js'],
        dependencies: [],
        description: 'Replacement 1',
      },
      {
        id: '001-001-001-001-rp-002',
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['src/b.js'],
        dependencies: [],
        description: 'Replacement 2',
      },
    ];

    const result = await scheduler.replaceTask(taskA.id, replacements);

    // Every inserted replacement must have a verify.json sidecar on disk.
    assert.ok(result.inserted.length >= 1, 'at least one replacement should be inserted');
    for (const insertedId of result.inserted) {
      const verifyPath = path.join(dir, 'verify', `task-${insertedId}.json`);
      assert.ok(
        fs.existsSync(verifyPath),
        `expected verify.json on disk for inserted replacement "${insertedId}" at ${verifyPath}`
      );

      const parsed = JSON.parse(fs.readFileSync(verifyPath, 'utf8'));
      assert.strictEqual(
        parsed.taskId, insertedId,
        `verify.json taskId should be "${insertedId}", got "${parsed.taskId}"`
      );
      assert.ok(
        Array.isArray(parsed.targetFiles),
        `verify.json for "${insertedId}" should have a targetFiles array`
      );
    }
  } finally { cleanup(dir); }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
