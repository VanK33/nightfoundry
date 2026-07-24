/**
 * test-infra-slow-failure-cap.js — Black-box tests for the Scheduler's
 * per-task consecutive-infra-error cap ("slow-failure cap").
 *
 * Context: the sliding-window circuit breaker (3 infra errors within 60s →
 * trip → backoff/probe) cannot see SLOW failures — errors spaced wider than
 * the window each count as 1 and the task is re-enqueued forever. The
 * slow-failure cap closes that gap: when the SAME task accumulates 3
 * consecutive infra errors without the fast-burst window tripping, the
 * scheduler throws an InfrastructureError instead of re-enqueuing a 4th time.
 *
 * Cases:
 *   SF1. Slow-failure cap: 3 consecutive infra errors on the same task, each
 *        spaced > 60s (window never trips) → runMilestone rejects with an
 *        InfrastructureError naming the task id and a consecutive/slow-failure
 *        indication; task attempted exactly 3 times.
 *   SF2. Streak reset on success: 2 spaced infra errors then success → no
 *        throw, milestone completes, 3 attempts. Then the same task is reset
 *        to pending on disk and re-run through the SAME scheduler: a single
 *        infra error must count as streak 1 (re-enqueue + succeed), proving
 *        the earlier success cleared the counter.
 *   SF3. Fast-burst path unchanged (guard): 3 rapid infra errors within the
 *        window trip the sliding-window circuit and enter backoff; with the
 *        mock failing forever the final error is the backoff-exhausted
 *        "Infra stall" variant, NOT the slow-failure-cap variant.
 *   SF4. Non-infra failure breaks the streak: 2 spaced infra errors then a
 *        NON-infra error on the same task → normal error/drain path; the
 *        thrown error carries no slow-failure-cap message.
 *
 * Test isolation: fs.mkdtemp fixtures only; never touches this repo's
 * .harness/, queue/, or archives/; no subprocesses.
 *
 * Run: node test/test-infra-slow-failure-cap.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { InfrastructureError } from '../src/orchestrator/infra/session-manager.js';
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

// ── Harness helpers (mirrors test-infra-error.js / test-scheduler.js) ─────────

/**
 * Write the mission state file(s) + global state.json for the given tasks
 * into `dir`. Extracted so tests can re-arm a harness (reset tasks back to
 * pending) between two runMilestone calls on the same scheduler.
 */
function writeSchedState(dir, tasks, { preStatus = {} } = {}) {
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
}

function createSchedHarness(tasks, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-slowcap-test-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  writeSchedState(dir, tasks, opts);
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeRetryableInfraError(msg = 'mock rate limit') {
  return new InfrastructureError(msg, {
    category: 'rate_limit',
    retryable: true,
    statusCode: 429,
    cause: new Error(msg),
  });
}

/**
 * Complete a task on disk via the real state machine, starting from
 * whatever state it is currently in (pending or in_progress).
 */
async function completeTaskOnDisk(harnessDir, task) {
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
}

/**
 * Stub Date.now with a controllable fake clock for the duration of `fn`.
 * `fn` receives an `advance(ms)` function that moves the clock forward.
 * The sliding-window circuit breaker is time-based, so advancing > 60s
 * between failures ages earlier errors out of the window (slow-failure
 * regime: the fast-burst circuit never trips).
 */
async function withFakeNow(fn) {
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  const advance = (ms) => { t += ms; };
  try {
    return await fn(advance);
  } finally {
    Date.now = realNow;
  }
}

/**
 * Replace global.setTimeout with a fast-forward stub for the duration of
 * `fn` (same pattern as test-infra-error.js): records each requested delay
 * and fires the callback immediately, keeping backoff rounds instant.
 */
async function withFakeTimers(fn) {
  const delays = [];
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback, delay, ...args) => {
    delays.push(delay);
    return originalSetTimeout(callback, 0, ...args);
  };
  try {
    const result = await fn(delays);
    return { result, delays };
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

const WINDOW_EXCEED_MS = 61_000; // > the 60s sliding window

// Matches the slow-failure-cap error text: "consecutive", "slow-failure",
// "slow failure", or "slow-failure cap" phrasing all count.
const SLOW_CAP_RE = /consecutive|slow[- ]failure/i;

// ── SF1: slow-failure cap throws after 3 spaced consecutive infra errors ─────

await test('SF1: 3 consecutive infra errors spaced outside the 60s window → InfrastructureError naming task id + consecutive/slow-failure; exactly 3 attempts', async () => {
  const taskId = '001-001-001-001';
  const tasks = [
    { id: taskId, missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    let callCount = 0;

    let threw = null;
    await withFakeNow(async (advance) => {
      const mockRunTask = async (_task) => {
        callCount++;
        // Space every failure > 60s apart so earlier errors age out of the
        // sliding window — the fast-burst circuit must never trip; only the
        // per-task consecutive streak accumulates.
        advance(WINDOW_EXCEED_MS);
        throw makeRetryableInfraError(`mock rate limit #${callCount}`);
      };

      const scheduler = new Scheduler({
        harnessDir: dir,
        projectRoot: dir,
        maxConcurrent: 1,
        runTask: mockRunTask,
      });

      try {
        await scheduler.runMilestone('001', tasks);
      } catch (err) {
        threw = err;
      }
    });

    assert.ok(threw, 'Expected runMilestone to reject via the slow-failure cap');
    assert.ok(
      threw instanceof InfrastructureError,
      `Expected an InfrastructureError, got ${threw.constructor?.name}: "${threw.message}"`
    );
    assert.ok(
      threw.message.includes(taskId),
      `Expected error message to include task id '${taskId}', got: "${threw.message}"`
    );
    assert.ok(
      SLOW_CAP_RE.test(threw.message),
      `Expected error message to indicate consecutive/slow-failure cap, got: "${threw.message}"`
    );
    assert.strictEqual(
      callCount,
      3,
      `Expected the task to be attempted exactly 3 times (no 4th re-enqueue), got ${callCount}`
    );
  } finally { cleanup(dir); }
});

// ── SF2: success resets the per-task streak ──────────────────────────────────

await test('SF2: 2 spaced infra errors then success → no throw (3 attempts); after reset-to-pending a later single infra error counts as streak 1, not 3', async () => {
  const taskId = '001-001-001-001';
  const tasks = [
    { id: taskId, missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    let callCount = 0;
    let phase = 1;

    await withFakeNow(async (advance) => {
      const mockRunTask = async (task) => {
        callCount++;
        advance(WINDOW_EXCEED_MS); // stay in the slow-failure regime throughout
        if (phase === 1) {
          if (callCount <= 2) {
            // Streak reaches 2 — one below the cap of 3.
            throw makeRetryableInfraError(`phase1 failure #${callCount}`);
          }
          // 3rd attempt: succeed. This must clear the consecutive streak.
          await completeTaskOnDisk(dir, task);
          return;
        }
        // Phase 2 (same scheduler instance, task re-armed to pending on disk):
        if (callCount === 4) {
          // If the streak were NOT reset by the phase-1 success, this single
          // failure would be consecutive error #3 and the cap would throw.
          throw makeRetryableInfraError('phase2 single failure');
        }
        await completeTaskOnDisk(dir, task);
      };

      const scheduler = new Scheduler({
        harnessDir: dir,
        projectRoot: dir,
        maxConcurrent: 1,
        runTask: mockRunTask,
      });

      // Phase 1: fail, fail, succeed — must NOT trip the slow-failure cap.
      await scheduler.runMilestone('001', tasks);
      assert.strictEqual(
        callCount,
        3,
        `Phase 1: expected exactly 3 attempts (2 failures + 1 success), got ${callCount}`
      );

      // Phase 2: re-arm the same task on disk and re-run through the SAME
      // scheduler instance so any in-memory streak state carries over.
      phase = 2;
      writeSchedState(dir, tasks);
      await scheduler.runMilestone('001', tasks);
    });

    // Phase 2 completed without a slow-cap throw: 1 failure (streak 1 after
    // the reset) + 1 success.
    assert.strictEqual(
      callCount,
      5,
      `Expected 5 total attempts (3 in phase 1, 2 in phase 2), got ${callCount}`
    );
  } finally { cleanup(dir); }
});

// ── SF3: fast-burst path unchanged (guard) ───────────────────────────────────

await test('SF3: 3 rapid infra errors trip the sliding-window circuit → backoff path; final error is the "Infra stall" variant, not the slow-failure cap', async () => {
  const taskId = '001-001-001-001';
  const tasks = [
    { id: taskId, missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    let callCount = 0;
    const logs = [];

    // Always fail, with NO clock manipulation: all errors land inside the
    // 60s window, so the fast-burst circuit trips first and backoff runs.
    const mockRunTask = async (_task) => {
      callCount++;
      throw makeRetryableInfraError();
    };

    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 1,
      runTask: mockRunTask,
      onLog: (msg) => logs.push(msg),
    });

    let threw = null;
    const { delays } = await withFakeTimers(async () => {
      try {
        await scheduler.runMilestone('001', tasks);
      } catch (err) {
        threw = err;
      }
    });

    // The circuit tripped (fast-burst behavior preserved)…
    const trippedLog = logs.find((l) => /circuit tripped/i.test(l));
    assert.ok(trippedLog, `Expected a "circuit tripped" log message, got: ${logs.join(' | ')}`);

    // …and the scheduler entered backoff with the standard schedule.
    assert.deepStrictEqual(
      delays,
      Scheduler.BACKOFF_SCHEDULE,
      `Expected backoff delays ${JSON.stringify(Scheduler.BACKOFF_SCHEDULE)}, got ${JSON.stringify(delays)}`
    );

    // The final error is the backoff-exhausted variant, NOT the slow cap.
    assert.ok(threw, 'Expected scheduler to throw after exhausting backoff rounds');
    assert.ok(
      /Infra stall/i.test(threw.message),
      `Expected the backoff-exhausted "Infra stall" error, got: "${threw.message}"`
    );
    assert.ok(
      !SLOW_CAP_RE.test(threw.message),
      `Fast-burst path must not surface the slow-failure-cap message, got: "${threw.message}"`
    );
    // The task kept failing consecutively well past 3 attempts, yet the slow
    // cap never fired because the window tripped first.
    assert.ok(
      callCount > 3,
      `Expected more than 3 attempts on the backoff/probe path, got ${callCount}`
    );
  } finally { cleanup(dir); }
});

// ── SF4: non-infra failure breaks the streak ─────────────────────────────────

await test('SF4: 2 spaced infra errors then a NON-infra error → normal error path, no slow-failure-cap message', async () => {
  const taskId = '001-001-001-001';
  const tasks = [
    { id: taskId, missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    let callCount = 0;
    const progressEvents = [];

    let threw = null;
    await withFakeNow(async (advance) => {
      const mockRunTask = async (_task) => {
        callCount++;
        advance(WINDOW_EXCEED_MS); // slow-failure regime: window never trips
        if (callCount <= 2) {
          throw makeRetryableInfraError(`spaced infra failure #${callCount}`);
        }
        // 3rd attempt: an ordinary (non-infrastructure) task failure.
        throw new Error('ordinary task failure: tests did not pass');
      };

      const scheduler = new Scheduler({
        harnessDir: dir,
        projectRoot: dir,
        maxConcurrent: 1,
        runTask: mockRunTask,
        onProgress: (evt) => progressEvents.push(evt),
      });

      try {
        await scheduler.runMilestone('001', tasks);
      } catch (err) {
        threw = err;
      }
    });

    // The run fails through the normal error path…
    assert.ok(threw, 'Expected runMilestone to fail via the normal error path');
    // …with NO slow-failure-cap framing anywhere in the error…
    assert.ok(
      !SLOW_CAP_RE.test(threw.message),
      `Non-infra failure must not surface the slow-failure-cap message, got: "${threw.message}"`
    );
    assert.ok(
      !/Infra stall/i.test(threw.message),
      `Non-infra failure must not surface the Infra-stall message, got: "${threw.message}"`
    );
    // …and the task was attempted exactly 3 times (2 infra retries + the
    // non-infra failure, which is terminal on the normal drain path).
    assert.strictEqual(
      callCount,
      3,
      `Expected exactly 3 attempts (2 infra + 1 non-infra terminal), got ${callCount}`
    );
    // Normal drain path emits task-fail for the non-infra failure.
    const failEvent = progressEvents.find((e) => e.type === 'task-fail');
    assert.ok(
      failEvent,
      `Expected a 'task-fail' progress event, got types: ${progressEvents.map((e) => e.type).join(', ')}`
    );
    assert.strictEqual(failEvent.taskId, taskId, 'task-fail event should reference the failing task');
  } finally { cleanup(dir); }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
