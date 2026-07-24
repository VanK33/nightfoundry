/**
 * test-cycle-rollback-pending.js — Regression tests for the acyclicity-rollback
 * pending-membership restore in Scheduler.replaceTask (spec:
 * cycle-rollback-pending-restore.spec.md).
 *
 * Contract under test: when the post-rewire acyclicity check fails, the
 * rollback restores the in-memory DAG to its EXACT pre-rewire state —
 * rewired dependents get their original dependencies back AND their _pending
 * membership restored exactly (a dependent that was pending before the call
 * stays pending; one that was not pending is not pending after). Replacement
 * tasks are evicted from both _tasksById and _pending. The cycle error still
 * throws. Durable mutations on the FAILED task (its on-disk 'invalidated'
 * status, the replan counter) survive by design and are NOT asserted as rolled
 * back.
 *
 * re-pin: w4-state-resume-persistence — Fix #4 rider now ALSO removes the
 * rolled-back REPLACEMENTS' step-8b on-disk artifacts (their mission-state task
 * entries + verify sidecars) during the acyclicity rollback, so they can no
 * longer influence the coverage drain or a later resume. (These tests assert
 * only in-memory eviction + the failed/dependent on-disk status, never the
 * replacement's artifacts, so they stay green either way.)
 *
 * Tests:
 *  TC1. Stranding killed: cycle fixture with B pending → throws /cycle/i AND
 *       B is still in _pending afterwards (THE regression), B's deps restored
 *       to [A], R absent from _tasksById and _pending, A restored in _tasksById.
 *  TC2. Was-not-pending branch: B artificially removed from _pending before
 *       the call → after the rollback B is NOT in _pending (step 9's genuine
 *       add is undone).
 *  TC3. Persist→re-read wedge proof: after the failed call, B's on-disk status
 *       is still 'pending' (schedulable-in-principle) while A's is
 *       'invalidated' (documented durable mutation).
 *  TC4. Success path untouched: non-cyclic replacement → replaceTask succeeds,
 *       B pending and rewired, replacement in _tasksById and _pending.
 *
 * Run: node test/test-cycle-rollback-pending.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Scheduler } from '../src/orchestrator/core/scheduler.js';
import { readTaskStatus } from '../src/orchestrator/core/state.js';

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
 * Replicated from test-scheduler-replace-task.js so tests run in isolation.
 */
function createSchedHarness(tasks, { preStatus = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cycle-rb-test-'));
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
 * Build a minimal Scheduler instance with a no-op runTask and preset DAG state.
 * replaceTask reads _tasksById and _pending from instance properties, so we
 * set them here (pattern from test-scheduler-replace-task.js).
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

/**
 * Cycle fixture (mirrors existing Test 13 in test-scheduler-replace-task.js):
 *   A (no deps), B depends on A, replacement R depends on B.
 *   replaceTask(A, [R]) rewires B → R while R → B, producing the R→B→R cycle.
 * Returns fresh task objects each call (tests mutate them).
 */
function makeCycleFixture() {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A (will be replaced)',
  };
  const taskB = {
    id: '001-001-001-002',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/b.js'],
    dependencies: [{ type: 'hard', taskId: '001-001-001-001' }],
    description: 'Task B (depends on A)',
  };
  const repR = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [{ type: 'hard', taskId: '001-001-001-002' }],  // R depends on B
    description: 'Replacement R (creates cycle through B)',
  };
  return { taskA, taskB, repR };
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {

// ── TC1: Stranding killed — rollback keeps a pre-pending dependent pending ──
await test('TC1 stranding killed: cycle rollback keeps pending dependent in _pending, restores deps, evicts replacement', async () => {
  const { taskA, taskB, repR } = makeCycleFixture();
  const dir = createSchedHarness([taskA, taskB]);
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB]);

    // Pre-condition: B is in _pending before the call (production reality —
    // a dependent of a failed task was never dispatched).
    assert.ok(scheduler._pending.has(taskB.id), 'pre-condition: B is in _pending before replaceTask');

    let threw = null;
    try {
      await scheduler.replaceTask(taskA.id, [repR]);
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, 'replaceTask should throw due to cycle detection');
    assert.ok(/cycle/i.test(threw.message),
      `error message should mention cycle, got: ${threw.message}`);

    // THE regression assertion: B was in _pending before the call, so the
    // rollback must leave it in _pending (pre-fix the unconditional
    // pending.delete evicts it and strands B).
    assert.ok(scheduler._pending.has(taskB.id),
      'B must still be in _pending after the rollback (was pending before the call)');

    // B's dependencies restored to exactly [A].
    const bAfter = scheduler._tasksById.get(taskB.id);
    assert.ok(bAfter, 'B should still be in _tasksById after rollback');
    assert.strictEqual(bAfter.dependencies.length, 1,
      'B should have exactly 1 dependency after rollback');
    assert.strictEqual(bAfter.dependencies[0].taskId, taskA.id,
      `B's dep should be restored to A (${taskA.id}), got: ${bAfter.dependencies[0].taskId}`);

    // Replacement R evicted from BOTH _tasksById and _pending.
    assert.ok(!scheduler._tasksById.has(repR.id),
      'replacement R must be rolled back out of _tasksById');
    assert.ok(!scheduler._pending.has(repR.id),
      'replacement R must be rolled back out of _pending');

    // A restored in _tasksById (in-memory DAG back to pre-rewire contents).
    assert.ok(scheduler._tasksById.has(taskA.id),
      'A must be restored in _tasksById after rollback');
  } finally { cleanup(dir); }
});

// ── TC2: Was-not-pending branch — step 9's genuine add is undone ────────────
await test('TC2 was-not-pending dependent: rollback leaves it out of _pending (genuine step-9 add undone)', async () => {
  const { taskA, taskB, repR } = makeCycleFixture();
  const dir = createSchedHarness([taskA, taskB]);
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB]);

    // Synthetic non-pending dependent: remove B from _pending before the call.
    scheduler._pending.delete(taskB.id);
    assert.ok(!scheduler._pending.has(taskB.id), 'pre-condition: B is NOT in _pending before replaceTask');

    let threw = null;
    try {
      await scheduler.replaceTask(taskA.id, [repR]);
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, 'replaceTask should throw due to cycle detection');
    assert.ok(/cycle/i.test(threw.message),
      `error message should mention cycle, got: ${threw.message}`);

    // B was NOT pending before the call, so step 9's pending.add(B) was a
    // genuine add — the rollback must undo it (exact pre-step-9 restore).
    assert.ok(!scheduler._pending.has(taskB.id),
      'B must NOT be in _pending after the rollback (was not pending before the call)');
  } finally { cleanup(dir); }
});

// ── TC3: Persist→re-read wedge proof at the production boundary ─────────────
await test('TC3 wedge proof: after failed replaceTask, B on-disk pending + in _pending; A on-disk invalidated (durable)', async () => {
  const { taskA, taskB, repR } = makeCycleFixture();
  const dir = createSchedHarness([taskA, taskB]);
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB]);

    let threw = null;
    try {
      await scheduler.replaceTask(taskA.id, [repR]);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'replaceTask should throw due to cycle detection');
    assert.ok(/cycle/i.test(threw.message),
      `error message should mention cycle, got: ${threw.message}`);

    // Loop-level wedge proof: B remains schedulable-in-principle — in-memory
    // pending AND on-disk 'pending' (persist→re-read via readTaskStatus).
    assert.ok(scheduler._pending.has(taskB.id),
      'B must still be in _pending after the rollback');
    assert.strictEqual(readTaskStatus(dir, taskB.id), 'pending',
      "B's on-disk status must still be 'pending' after the failed replaceTask");

    // Documented durable mutation: A's disk invalidation survives the rollback.
    assert.strictEqual(readTaskStatus(dir, taskA.id), 'invalidated',
      "A's on-disk status must be 'invalidated' (durable mutation, by design)");
  } finally { cleanup(dir); }
});

// ── TC4: Success path untouched ──────────────────────────────────────────────
await test('TC4 success path untouched: non-cyclic replaceTask rewires dependent and keeps it pending', async () => {
  const { taskA, taskB } = makeCycleFixture();
  // R2 does NOT create a cycle: no deps, targetFiles within sub-mission scope.
  const repR2 = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Replacement R2 (no cycle)',
  };
  const dir = createSchedHarness([taskA, taskB]);
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB]);

    const result = await scheduler.replaceTask(taskA.id, [repR2]);

    assert.deepStrictEqual(result.invalidated, [taskA.id],
      'invalidated should contain only the failed task');
    assert.deepStrictEqual(result.inserted, [repR2.id],
      'inserted should contain the replacement');

    // B stays pending and is rewired to the replacement.
    assert.ok(scheduler._pending.has(taskB.id), 'B remains in _pending after successful replaceTask');
    const bAfter = scheduler._tasksById.get(taskB.id);
    assert.ok(bAfter, 'B should still be in _tasksById');
    assert.strictEqual(bAfter.dependencies.length, 1, 'B should still have exactly 1 dependency');
    assert.strictEqual(bAfter.dependencies[0].taskId, repR2.id,
      `B's dep should be rewired to the replacement (${repR2.id}), got: ${bAfter.dependencies[0].taskId}`);

    // Replacement is live in both the DAG and pending set.
    assert.ok(scheduler._tasksById.has(repR2.id), 'replacement should be in _tasksById');
    assert.ok(scheduler._pending.has(repR2.id), 'replacement should be in _pending');
  } finally { cleanup(dir); }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
