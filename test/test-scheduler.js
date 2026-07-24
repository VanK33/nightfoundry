/**
 * test-scheduler.js — Unit tests for src/orchestrator/core/scheduler.js.
 *
 * Validates the ready-queue scheduler in isolation, with a mock runTask
 * callback. No real executor / verifier / SDK. Focus:
 *
 *   - Empty DAG completes immediately
 *   - Independent tasks run with correct parallelism up to maxConcurrent
 *   - Dependent tasks wait for their predecessors
 *   - File conflicts serialize correctly
 *   - Combined deps + file conflicts
 *   - Resume path skips pre-terminal tasks
 *   - Stall detection (unmet dependencies)
 *   - Error propagation with in-flight drain
 *   - onProgress event stream contract
 *
 * Run: node test/test-scheduler.js
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

// ── Fixture helpers ──────────────────────────────────────────────────

/**
 * Create a temp harness dir with a minimal global state.json + mission
 * state file. Takes a map of task-status overrides for the resume
 * path; defaults every task to "pending".
 */
function createSchedHarness(tasks, { preStatus = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });

  // Group tasks by mission ID for per-mission file layout.
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
    // Group tasks by sub-mission
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
 * Build a mock runTask callback that:
 *   - Records the order in which tasks start (via an array)
 *   - Records the set of concurrently-running task IDs at each start
 *   - After an optional delay, marks the task as "complete" on disk
 *     via the state machine (real transitions under the mutex so the
 *     scheduler's dep check can see the terminal state)
 *   - Returns void
 *
 * The resulting traces let tests assert ordering and parallelism
 * without reaching into the scheduler's internals.
 */
function makeMockRunTask({ harnessDir, delay = 5, failTaskIds = new Set() }) {
  const trace = {
    startOrder: [],       // task IDs in the order they started
    runningAtStart: [],   // array of {taskId, concurrentlyRunning}
    completeOrder: [],    // task IDs in the order their runTask returned
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

    // Simulate work
    await new Promise((r) => setTimeout(r, delay));

    // Real state-machine transitions so the scheduler's dep check sees
    // terminal state. We import lazily to avoid circular dependency
    // risks if someone reorganizes the test file layout.
    const { transitionTask } = await import('../src/orchestrator/core/state-machine.js');
    const status = (await import('../src/orchestrator/core/state.js')).readTaskStatus(harnessDir, task.id);
    if (status === 'pending') {
      await transitionTask(harnessDir, task.id, 'in_progress');
    }
    // Fake the verification gate: write a sidecar so transitionTask to verified is legal
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

// ── Tests ────────────────────────────────────────────────────────────

async function run() {

await test('empty DAG completes immediately', async () => {
  const dir = createSchedHarness([]);
  try {
    let ran = false;
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 4,
      runTask: async () => { ran = true; },
    });
    await scheduler.runMilestone('001', []);
    assert.strictEqual(ran, false, 'runTask should never be called for empty DAG');
  } finally { cleanup(dir); }
});

await test('single task runs and completes', async () => {
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const { mockRunTask, trace } = makeMockRunTask({ harnessDir: dir });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 4,
      runTask: mockRunTask,
    });
    await scheduler.runMilestone('001', tasks);
    assert.deepStrictEqual(trace.startOrder, ['001-001-001-001']);
    assert.deepStrictEqual(trace.completeOrder, ['001-001-001-001']);
  } finally { cleanup(dir); }
});

await test('independent tasks run in parallel up to maxConcurrent', async () => {
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['b.js'] },
    { id: '001-001-001-003', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['c.js'] },
    { id: '001-001-001-004', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['d.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const { mockRunTask, trace } = makeMockRunTask({ harnessDir: dir, delay: 20 });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 3,
      runTask: mockRunTask,
    });
    await scheduler.runMilestone('001', tasks);

    // First three should start while no one else has completed, so each
    // sees 0, 1, 2 concurrent workers already running when it starts.
    const firstThree = trace.runningAtStart.slice(0, 3);
    const concurrentCounts = firstThree.map((e) => e.concurrentlyRunning.size);
    assert.deepStrictEqual(concurrentCounts, [0, 1, 2], `expected first 3 to hit maxConcurrent=3, got ${concurrentCounts}`);

    // All four must eventually run
    assert.strictEqual(trace.startOrder.length, 4, 'all 4 tasks should have started');
    assert.strictEqual(trace.completeOrder.length, 4, 'all 4 tasks should have completed');
  } finally { cleanup(dir); }
});

await test('dependent task waits for predecessor', async () => {
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'], dependencies: [] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['b.js'], dependencies: [{ type: 'hard', taskId: '001-001-001-001' }] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const { mockRunTask, trace } = makeMockRunTask({ harnessDir: dir, delay: 10 });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 4,
      runTask: mockRunTask,
    });
    await scheduler.runMilestone('001', tasks);

    // Task 2 must start AFTER task 1 completes.
    const t1Complete = trace.completeOrder.indexOf('001-001-001-001');
    assert.strictEqual(trace.startOrder[0], '001-001-001-001');
    // Task 2 should start second
    assert.strictEqual(trace.startOrder[1], '001-001-001-002');
    // At the moment task 2 starts, task 1 must not be in the running set
    const t2StartEntry = trace.runningAtStart.find((e) => e.taskId === '001-001-001-002');
    assert.ok(!t2StartEntry.concurrentlyRunning.has('001-001-001-001'),
      'task 2 must not start while task 1 is still running');
  } finally { cleanup(dir); }
});

await test('file conflict serializes overlapping tasks', async () => {
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['shared.js'] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['shared.js'] },
    { id: '001-001-001-003', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['other.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const { mockRunTask, trace } = makeMockRunTask({ harnessDir: dir, delay: 20 });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 4,
      runTask: mockRunTask,
    });
    await scheduler.runMilestone('001', tasks);

    // Tasks 1 and 2 conflict on shared.js. Task 3 conflicts with neither.
    // So tasks 1 and 3 start concurrently, task 2 waits until task 1 frees shared.js.
    assert.strictEqual(trace.startOrder.length, 3, 'all 3 tasks should run');

    // Check that task 2's start does NOT overlap task 1's run.
    const t2StartEntry = trace.runningAtStart.find((e) => e.taskId === '001-001-001-002');
    assert.ok(!t2StartEntry.concurrentlyRunning.has('001-001-001-001'),
      'task 2 (shared.js) must not overlap task 1 (shared.js)');
  } finally { cleanup(dir); }
});

await test('resume path skips pre-terminal tasks', async () => {
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['b.js'] },
    { id: '001-001-001-003', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['c.js'] },
  ];
  // Task 1 is already complete on disk — scheduler should skip it
  const dir = createSchedHarness(tasks, { preStatus: { '001-001-001-001': 'complete' } });
  try {
    const { mockRunTask, trace } = makeMockRunTask({ harnessDir: dir });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 4,
      runTask: mockRunTask,
    });
    await scheduler.runMilestone('001', tasks);

    assert.ok(!trace.startOrder.includes('001-001-001-001'), 'pre-terminal task should not be re-run');
    assert.ok(trace.startOrder.includes('001-001-001-002'));
    assert.ok(trace.startOrder.includes('001-001-001-003'));
  } finally { cleanup(dir); }
});

await test('stall detection: unmet dependency on missing task throws', async () => {
  const tasks = [
    {
      id: '001-001-001-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['a.js'],
      dependencies: [{ type: 'hard', taskId: '001-001-001-999' }],  // does not exist
    },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const { mockRunTask } = makeMockRunTask({ harnessDir: dir });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 4,
      runTask: mockRunTask,
    });

    let threw = null;
    try {
      await scheduler.runMilestone('001', tasks);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'scheduler should throw on stall');
    assert.ok(/Scheduler stall/.test(threw.message), `error should mention stall, got: ${threw.message}`);
  } finally { cleanup(dir); }
});

await test('error in runTask propagates after in-flight workers drain', async () => {
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['b.js'] },
    { id: '001-001-001-003', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['c.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const { mockRunTask } = makeMockRunTask({
      harnessDir: dir,
      delay: 10,
      failTaskIds: new Set(['001-001-001-002']),
    });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 3,
      runTask: mockRunTask,
    });

    let threw = null;
    try {
      await scheduler.runMilestone('001', tasks);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'scheduler should propagate the error');
    assert.ok(/mock failure: 001-001-001-002/.test(threw.message), `error should be the mock failure, got: ${threw.message}`);
  } finally { cleanup(dir); }
});

await test('stall-message-content: halt error names failing task, reason, pending IDs; no misleading "unmet dependencies"', async () => {
  // Setup: 4 independent tasks, no shared files, no deps. maxConcurrent=1
  // serializes them, so the failure on task A halts dispatch of B/C/D — they
  // remain in `pending` when the assignment loop's `!firstError` gate blocks
  // them and the stall throw fires. This exercises the new "Milestone halted"
  // message path. Spec: 2026-04-26-scheduler-stall-error-message.md.
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'], description: 'task A — fails' },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['b.js'], description: 'task B' },
    { id: '001-001-001-003', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['c.js'], description: 'task C' },
    { id: '001-001-001-004', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['d.js'], description: 'task D' },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const { mockRunTask } = makeMockRunTask({
      harnessDir: dir,
      delay: 5,
      failTaskIds: new Set(['001-001-001-001']),
    });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 1,
      runTask: mockRunTask,
    });

    let threw = null;
    try {
      await scheduler.runMilestone('001', tasks);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'scheduler should throw on halt');

    // Spec assertions (per 2026-04-26-scheduler-stall-error-message.md Testing § A):
    // 1. Names the failing task ID
    assert.ok(threw.message.includes('001-001-001-001'),
      `should name failing task ID, got: ${threw.message}`);
    // 2. Includes the underlying error's text (substring match)
    assert.ok(threw.message.includes('mock failure'),
      `should include underlying error message, got: ${threw.message}`);
    // 3. Lists at least one pending task ID
    assert.ok(/001-001-001-00[234]/.test(threw.message),
      `should list pending task IDs, got: ${threw.message}`);
    // 4. Does NOT include misleading framing
    assert.ok(!threw.message.includes('unmet dependencies'),
      `should NOT include 'unmet dependencies' framing, got: ${threw.message}`);
    // 5. Plain Error, not a custom subclass — catches accidental drift toward
    //    structured-error class
    assert.strictEqual(threw.constructor, Error,
      `should be plain Error class, got: ${threw.constructor.name}`);
  } finally { cleanup(dir); }
});

await test('onProgress emits milestone-start, task-start, task-complete, milestone-complete', async () => {
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const events = [];
    const { mockRunTask } = makeMockRunTask({ harnessDir: dir });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 1,
      runTask: mockRunTask,
      onProgress: (evt) => events.push(evt),
    });
    await scheduler.runMilestone('001', tasks);

    const types = events.map((e) => e.type);
    assert.deepStrictEqual(
      types,
      ['milestone-start', 'task-start', 'task-complete', 'milestone-complete'],
      `progress events out of order: ${types.join(', ')}`
    );
  } finally { cleanup(dir); }
});

await test('cross-mission parallelism: tasks from different missions run concurrently', async () => {
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
    { id: '001-002-001-001', missionId: '001-002', subMissionId: '001-002-001', targetFiles: ['b.js'] },
    { id: '001-003-001-001', missionId: '001-003', subMissionId: '001-003-001', targetFiles: ['c.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const { mockRunTask, trace } = makeMockRunTask({ harnessDir: dir, delay: 20 });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 5,
      runTask: mockRunTask,
    });
    await scheduler.runMilestone('001', tasks);

    // All three missions' tasks should run in parallel
    const counts = trace.runningAtStart.map((e) => e.concurrentlyRunning.size);
    assert.deepStrictEqual(counts, [0, 1, 2], `expected cross-mission parallelism, got ${counts}`);
  } finally { cleanup(dir); }
});

await test('task-fail event includes running count matching workers.size', async () => {
  // 3 independent tasks, maxConcurrent=3, task-002 fails immediately.
  // When the fail event fires, workers.delete(finished.id) has already run,
  // so workers.size == 2 (the two remaining in-flight tasks).
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['b.js'] },
    { id: '001-001-001-003', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['c.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const failEvents = [];
    const { mockRunTask } = makeMockRunTask({
      harnessDir: dir,
      delay: 30,
      failTaskIds: new Set(['001-001-001-002']),
    });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 3,
      runTask: mockRunTask,
      onProgress: (evt) => { if (evt.type === 'task-fail') failEvents.push(evt); },
    });

    try { await scheduler.runMilestone('001', tasks); } catch (_) { /* expected */ }

    assert.strictEqual(failEvents.length, 1, 'exactly one task-fail event should be emitted');
    const evt = failEvents[0];
    assert.strictEqual(evt.taskId, '001-001-001-002', 'task-fail event should name the failed task');
    // After workers.delete(finished.id), two workers (001, 003) are still in flight.
    assert.strictEqual(typeof evt.running, 'number', 'task-fail event must have numeric running field');
    assert.strictEqual(evt.running, 2,
      `task-fail running should be 2 (001 and 003 still in workers), got ${evt.running}`);
  } finally { cleanup(dir); }
});

await test('task-fail event includes pending count matching pending.size', async () => {
  // Same scenario: all 3 tasks dispatched at once so pending is 0 when
  // the fail event fires.
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['b.js'] },
    { id: '001-001-001-003', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['c.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const failEvents = [];
    const { mockRunTask } = makeMockRunTask({
      harnessDir: dir,
      delay: 30,
      failTaskIds: new Set(['001-001-001-002']),
    });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 3,
      runTask: mockRunTask,
      onProgress: (evt) => { if (evt.type === 'task-fail') failEvents.push(evt); },
    });

    try { await scheduler.runMilestone('001', tasks); } catch (_) { /* expected */ }

    assert.strictEqual(failEvents.length, 1, 'exactly one task-fail event should be emitted');
    const evt = failEvents[0];
    // All 3 tasks were dispatched in the first assignment pass, so pending is 0.
    assert.strictEqual(typeof evt.pending, 'number', 'task-fail event must have numeric pending field');
    assert.strictEqual(evt.pending, 0,
      `task-fail pending should be 0 (all tasks were dispatched), got ${evt.pending}`);
  } finally { cleanup(dir); }
});

await test('statusBar.updateProgress not called by scheduler (pipeline owns progress)', async () => {
  // Since pipeline now owns progress reporting, the scheduler must NOT call
  // statusBar.updateProgress directly, even when a statusBar is passed in.
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const calls = [];
    const mockStatusBar = {
      updateProgress: (...args) => calls.push(args),
    };
    const { mockRunTask } = makeMockRunTask({ harnessDir: dir });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 1,
      runTask: mockRunTask,
      statusBar: mockStatusBar,
    });
    await scheduler.runMilestone('001', tasks);

    // The scheduler must NOT call statusBar.updateProgress — pipeline owns progress.
    assert.strictEqual(calls.length, 0,
      `statusBar.updateProgress should NOT be called by the scheduler; calls were: ${JSON.stringify(calls)}`);
  } finally { cleanup(dir); }
});

await test('Scheduler constructor does not store statusBar property', async () => {
  // The scheduler no longer owns the statusBar reference — pipeline does.
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const { mockRunTask } = makeMockRunTask({ harnessDir: dir });
    const mockStatusBar = { updateProgress: () => {} };
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 1,
      runTask: mockRunTask,
      statusBar: mockStatusBar,
    });
    // Scheduler must not retain a statusBar property
    assert.ok(
      !Object.prototype.hasOwnProperty.call(scheduler, 'statusBar'),
      'Scheduler instance must NOT have a statusBar property (pipeline owns progress)'
    );
  } finally { cleanup(dir); }
});

// ── replaceTask regression tests ──────────────────────────────────

await test('replaceTask accepts replacement targeting a sibling task file in the same sub-mission', async () => {
  // Two tasks in the same sub-mission: 001 owns a.js, 002 owns b.js.
  // The replacement for 001 references b.js — a file owned by a sibling
  // in the same sub-mission. The targetFiles union check must accept this.
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['b.js'] },
  ];
  // Task 001 is 'failed' on disk so it can be transitioned → 'invalidated'.
  const dir = createSchedHarness(tasks, { preStatus: { '001-001-001-001': 'failed' } });
  try {
    const { mockRunTask } = makeMockRunTask({ harnessDir: dir });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 4,
      runTask: mockRunTask,
    });
    // Prime scheduler internal state without running the full milestone.
    scheduler._tasksById = new Map(tasks.map((t) => [t.id, t]));
    scheduler._pending = new Set(['001-001-001-002']);
    scheduler._runningFiles = new Set();

    // Replacement references 'b.js' — owned by sibling task 002.
    const replacement = {
      id: '001-001-001-001-rp-1',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['b.js'],
    };

    let threw = null;
    let result = null;
    try {
      result = await scheduler.replaceTask('001-001-001-001', [replacement]);
    } catch (err) {
      threw = err;
    }
    assert.ok(!threw, `replaceTask should accept a sibling task's file, but threw: ${threw?.message}`);
    assert.ok(result, 'replaceTask should return a result object');
    assert.ok(Array.isArray(result.invalidated), 'result.invalidated should be an array');
    assert.ok(result.invalidated.includes('001-001-001-001'), 'failed task should be in invalidated list');
    assert.ok(Array.isArray(result.inserted), 'result.inserted should be an array');
    assert.ok(result.inserted.includes('001-001-001-001-rp-1'), 'replacement task should be in inserted list');
  } finally { cleanup(dir); }
});

await test('replaceTask rejects replacement targeting a file outside the sub-mission union', async () => {
  // Two tasks in the same sub-mission: only a.js and b.js are in scope.
  // The replacement references 'outside.js' which no sub-mission task owns.
  // _validateTargetFilesSubset must throw before any disk mutation.
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['b.js'] },
  ];
  const dir = createSchedHarness(tasks, { preStatus: { '001-001-001-001': 'failed' } });
  try {
    const { mockRunTask } = makeMockRunTask({ harnessDir: dir });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 4,
      runTask: mockRunTask,
    });
    scheduler._tasksById = new Map(tasks.map((t) => [t.id, t]));
    scheduler._pending = new Set(['001-001-001-002']);
    scheduler._runningFiles = new Set();

    // Replacement references 'outside.js' — not owned by any task in this sub-mission.
    const replacement = {
      id: '001-001-001-001-rp-1',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['outside.js'],
    };

    let threw = null;
    try {
      await scheduler.replaceTask('001-001-001-001', [replacement]);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'replaceTask should throw when replacement references a file outside the sub-mission union');
    assert.ok(
      /_validateTargetFilesSubset/.test(threw.message) || /outside\.js/.test(threw.message),
      `error should identify the violation; got: ${threw.message}`
    );
  } finally { cleanup(dir); }
});

await test('replaceTask validation failure leaves original task status on disk unchanged', async () => {
  // Task 001 is 'failed' on disk. The replacement references 'outside.js'
  // which is outside the sub-mission file union, so _validateTargetFilesSubset
  // (step 5) throws BEFORE any transitionTask call (step 6).
  // After the rejection the on-disk status must still be 'failed', not
  // 'invalidated' — no orphaned invalidated state.
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['b.js'] },
  ];
  const dir = createSchedHarness(tasks, { preStatus: { '001-001-001-001': 'failed' } });
  try {
    const { mockRunTask } = makeMockRunTask({ harnessDir: dir });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 4,
      runTask: mockRunTask,
    });
    scheduler._tasksById = new Map(tasks.map((t) => [t.id, t]));
    scheduler._pending = new Set(['001-001-001-002']);
    scheduler._runningFiles = new Set();

    const replacement = {
      id: '001-001-001-001-rp-1',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['outside.js'],
    };

    let threw = null;
    try {
      await scheduler.replaceTask('001-001-001-001', [replacement]);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'replaceTask should throw for file outside sub-mission union');

    // The on-disk status of the original failed task must remain 'failed'.
    const { readTaskStatus } = await import('../src/orchestrator/core/state.js');
    const diskStatus = readTaskStatus(dir, '001-001-001-001');
    assert.strictEqual(
      diskStatus,
      'failed',
      `task should remain 'failed' on disk after a pre-mutation validation error; got '${diskStatus}'`
    );
  } finally { cleanup(dir); }
});

await test('sequential ordering synthesized deps enforce execution order A→B→C', async () => {
  // Mimics what _enforceSequentialOrdering produces: a hard dep chain A→B→C.
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'], dependencies: [] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['b.js'], dependencies: [{ type: 'hard', taskId: '001-001-001-001' }] },
    { id: '001-001-001-003', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['c.js'], dependencies: [{ type: 'hard', taskId: '001-001-001-002' }] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const { mockRunTask, trace } = makeMockRunTask({ harnessDir: dir, delay: 20 });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 4,
      runTask: mockRunTask,
    });
    await scheduler.runMilestone('001', tasks);

    // All three tasks must run
    assert.strictEqual(trace.startOrder.length, 3, 'all 3 tasks should have started');
    assert.strictEqual(trace.completeOrder.length, 3, 'all 3 tasks should have completed');

    // B must start only after A completes
    const aCompleteIdx = trace.completeOrder.indexOf('001-001-001-001');
    const bStartEntry = trace.runningAtStart.find((e) => e.taskId === '001-001-001-002');
    assert.ok(
      !bStartEntry.concurrentlyRunning.has('001-001-001-001'),
      'B must not start while A is still running'
    );
    assert.ok(aCompleteIdx >= 0, 'A must have completed');

    // C must start only after B completes
    const bCompleteIdx = trace.completeOrder.indexOf('001-001-001-002');
    const cStartEntry = trace.runningAtStart.find((e) => e.taskId === '001-001-001-003');
    assert.ok(
      !cStartEntry.concurrentlyRunning.has('001-001-001-002'),
      'C must not start while B is still running'
    );
    assert.ok(bCompleteIdx >= 0, 'B must have completed');

    // Verify strict sequential order in completeOrder: A before B before C
    assert.ok(
      aCompleteIdx < bCompleteIdx,
      `A must complete before B; completeOrder=${JSON.stringify(trace.completeOrder)}`
    );
    assert.ok(
      bCompleteIdx < trace.completeOrder.indexOf('001-001-001-003'),
      `B must complete before C; completeOrder=${JSON.stringify(trace.completeOrder)}`
    );
  } finally { cleanup(dir); }
});

// ── Signal / abort tests ─────────────────────────────────────────────

await test('TC-signal-basic: pre-aborted signal causes runMilestone to skip all tasks', async () => {
  // A signal that is already aborted when runMilestone is called should
  // cause the scheduler to bypass the assignment loop entirely, dispatching
  // zero tasks, and still emit a milestone-complete progress event.
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['b.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    let callCount = 0;
    const events = [];

    const controller = new AbortController();
    controller.abort(); // pre-abort before runMilestone

    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 4,
      runTask: async () => { callCount++; },
      onProgress: (evt) => events.push(evt),
    });

    await scheduler.runMilestone('001', tasks, { signal: controller.signal });

    assert.strictEqual(callCount, 0,
      `runTask should not be called when signal is pre-aborted; got callCount=${callCount}`);

    const milestoneComplete = events.find((e) => e.type === 'milestone-complete');
    assert.ok(milestoneComplete,
      `milestone-complete event must be emitted even when signal is pre-aborted; events: ${events.map((e) => e.type).join(', ')}`);
  } finally { cleanup(dir); }
});

await test('TC-signal-mid-flight: aborting after first task limits dispatch to at most 2 tasks', async () => {
  // 3 independent tasks, maxConcurrent=1. The mock aborts the controller
  // during the first runTask call. After the first task's worker settles,
  // the scheduler checks signal.aborted at the top of the outer loop and
  // breaks, so at most 2 tasks total are dispatched.
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['b.js'] },
    { id: '001-001-001-003', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['c.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    let callCount = 0;
    const controller = new AbortController();

    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 1,
      runTask: async (task) => {
        callCount++;
        // Abort after the first task runs so the scheduler sees signal.aborted
        // on the next outer-loop iteration before dispatching remaining tasks.
        if (callCount === 1) {
          // Do minimal work: just abort. No real state transitions needed;
          // we only care about the dispatch count, not final disk state.
          controller.abort();
        }
      },
    });

    // Does not throw — scheduler breaks out cleanly on signal.
    await scheduler.runMilestone('001', tasks, { signal: controller.signal });

    assert.ok(callCount <= 2,
      `runTask should be called at most 2 times when signal aborted mid-flight; got callCount=${callCount}`);
    assert.ok(callCount >= 1,
      `runTask should have been called at least once before abort; got callCount=${callCount}`);
  } finally { cleanup(dir); }
});

// ── Atomic replan write regression test ──────────────────────────────

await test('TC-atomic-replan-writes: replaceTask persists valid JSON via writeJsonAtomic for state.json and mission-*.json', async () => {
  // After a successful replaceTask call the scheduler must have flushed
  // two files via writeJsonAtomic:
  //   1. state.json — contains scheduler.replanAttempts with the correct count
  //   2. state/mission-{missionId}.json — contains the replacement task
  //      under subMissions[subMissionId].tasks with status 'pending'
  //
  // This is a regression guard: if writeJsonAtomic produces invalid JSON
  // (e.g. due to a swap-file bug) the JSON.parse below will throw.
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['b.js'] },
  ];
  // Task 001 is 'failed' so replaceTask can transition it to 'invalidated'.
  const dir = createSchedHarness(tasks, { preStatus: { '001-001-001-001': 'failed' } });
  try {
    const { mockRunTask } = makeMockRunTask({ harnessDir: dir });
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 4,
      runTask: mockRunTask,
    });

    // Prime scheduler internal state without running the full milestone.
    scheduler._tasksById = new Map(tasks.map((t) => [t.id, t]));
    scheduler._pending = new Set(['001-001-001-002']);
    scheduler._runningFiles = new Set();

    const replacement = {
      id: '001-001-001-001-rp-1',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['a.js'],
      description: 'replacement task',
    };

    await scheduler.replaceTask('001-001-001-001', [replacement]);

    // ── Assertion 1: state.json must be valid JSON and contain replanAttempts ──
    const stateJsonPath = path.join(dir, 'state.json');
    const stateRaw = fs.readFileSync(stateJsonPath, 'utf8');
    let state;
    try {
      state = JSON.parse(stateRaw);
    } catch (parseErr) {
      throw new Error(`state.json is not valid JSON after replaceTask: ${parseErr.message}`);
    }
    assert.ok(
      state.scheduler && typeof state.scheduler.replanAttempts === 'object',
      `state.json must contain scheduler.replanAttempts; got: ${JSON.stringify(state.scheduler)}`
    );
    // The canonical task ID is '001-001-001-001' (no -rp-NNN suffix).
    const attempts = state.scheduler.replanAttempts['001-001-001-001'];
    assert.strictEqual(attempts, 1,
      `replanAttempts for '001-001-001-001' should be 1 after one replaceTask call; got ${attempts}`);

    // ── Assertion 2: mission-001-001.json must be valid JSON and contain the replacement task ──
    const missionFilePath = path.join(dir, 'state', 'mission-001-001.json');
    const missionRaw = fs.readFileSync(missionFilePath, 'utf8');
    let missionState;
    try {
      missionState = JSON.parse(missionRaw);
    } catch (parseErr) {
      throw new Error(`mission-001-001.json is not valid JSON after replaceTask: ${parseErr.message}`);
    }
    const replacementTaskOnDisk = missionState?.subMissions?.['001-001-001']?.tasks?.['001-001-001-001-rp-1'];
    assert.ok(
      replacementTaskOnDisk,
      `mission file must contain replacement task '001-001-001-001-rp-1' in subMissions['001-001-001'].tasks`
    );
    assert.strictEqual(
      replacementTaskOnDisk.status,
      'pending',
      `replacement task on disk should have status 'pending'; got '${replacementTaskOnDisk.status}'`
    );
    assert.strictEqual(
      replacementTaskOnDisk.id,
      '001-001-001-001-rp-1',
      `replacement task id on disk should match; got '${replacementTaskOnDisk.id}'`
    );
  } finally { cleanup(dir); }
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
