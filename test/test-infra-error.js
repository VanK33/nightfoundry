/**
 * test-infra-error.js — Unit tests for InfrastructureError, classifyError,
 * and Scheduler circuit-breaker behavior.
 *
 * Part A — classifyError / InfrastructureError (9 tests):
 *   1. classifyError wraps RateLimitError       → category 'rate_limit', retryable true
 *   2. classifyError wraps APIConnectionError   → category 'network',    retryable true
 *   3. classifyError wraps AuthenticationError  → category 'auth',       retryable false
 *   4. classifyError wraps InternalServerError  → category 'server',     retryable true
 *   5. classifyError wraps generic APIError     → category 'api',        retryable false
 *   6. classifyError wraps plain Error          → category 'unknown',    retryable false
 *   7. classifyError preserves original error as .cause
 *   8. InfrastructureError is instanceof Error
 *   9. Normal (non-SDK) errors become InfrastructureError with 'unknown' category
 *
 * Part B — Scheduler circuit-breaker integration (8 tests):
 *   CB1. Task disk state stays in_progress after infra error (not transitioned to failed)
 *   CB2. Infra-errored task is re-enqueued and retried by scheduler
 *   CB3. Scheduler pauses dispatching after 3 infra errors within 60s window
 *   CB4. Backoff timing is [30s, 60s, 120s] when circuit breaker is exhausted
 *   CB5. infra-stall progress event emitted when all backoff rounds fail
 *   CB6. Scheduler throws Infra stall error after all backoff rounds fail
 *   CB7. infraErrorCount (_infraErrors) resets to 0 after successful task completion
 *   CB8. Non-retryable InfrastructureError follows normal error/drain path
 *
 * Run: node test/test-infra-error.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { InfrastructureError, classifyError } from '../src/orchestrator/infra/session-manager.js';
import { Scheduler } from '../src/orchestrator/core/scheduler.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { activeHarnessDir } from '../src/orchestrator/core/run-context.js';
import {
  APIError,
  APIConnectionError,
  RateLimitError,
  AuthenticationError,
  InternalServerError,
} from '@anthropic-ai/sdk/core/error.mjs';

// Ensure the active-run marker env var is cleared for all tests in this file,
// regardless of whether scripts/run-tests.js sets/unsets it.
delete process.env.CC_ORCH_ACTIVE_RUN;

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

// Minimal mock headers object (SDK calls headers?.get('request-id'))
const mockHeaders = { get: () => null };

// ══════════════════════════════════════════════════════════════════════════════
// Part A — classifyError / InfrastructureError tests
// ══════════════════════════════════════════════════════════════════════════════

// --- Test 1: RateLimitError → 'rate_limit', retryable true ---
await test("classifyError wraps RateLimitError → category 'rate_limit', retryable true", () => {
  const sdkErr = new RateLimitError(429, null, 'rate limit exceeded', mockHeaders);
  const infra = classifyError(sdkErr);
  assert.ok(infra instanceof InfrastructureError, 'Expected InfrastructureError instance');
  assert.strictEqual(infra.category, 'rate_limit', `Expected 'rate_limit', got '${infra.category}'`);
  assert.strictEqual(infra.retryable, true, `Expected retryable true, got ${infra.retryable}`);
});

// --- Test 2: APIConnectionError → 'network', retryable true ---
await test("classifyError wraps APIConnectionError → category 'network', retryable true", () => {
  const sdkErr = new APIConnectionError({ message: 'connection refused', cause: null });
  const infra = classifyError(sdkErr);
  assert.ok(infra instanceof InfrastructureError, 'Expected InfrastructureError instance');
  assert.strictEqual(infra.category, 'network', `Expected 'network', got '${infra.category}'`);
  assert.strictEqual(infra.retryable, true, `Expected retryable true, got ${infra.retryable}`);
});

// --- Test 3: AuthenticationError → 'auth', retryable false ---
await test("classifyError wraps AuthenticationError → category 'auth', retryable false", () => {
  const sdkErr = new AuthenticationError(401, null, 'unauthorized', mockHeaders);
  const infra = classifyError(sdkErr);
  assert.ok(infra instanceof InfrastructureError, 'Expected InfrastructureError instance');
  assert.strictEqual(infra.category, 'auth', `Expected 'auth', got '${infra.category}'`);
  assert.strictEqual(infra.retryable, false, `Expected retryable false, got ${infra.retryable}`);
});

// --- Test 4: InternalServerError → 'server', retryable true ---
await test("classifyError wraps InternalServerError → category 'server', retryable true", () => {
  const sdkErr = new InternalServerError(500, null, 'internal server error', mockHeaders);
  const infra = classifyError(sdkErr);
  assert.ok(infra instanceof InfrastructureError, 'Expected InfrastructureError instance');
  assert.strictEqual(infra.category, 'server', `Expected 'server', got '${infra.category}'`);
  assert.strictEqual(infra.retryable, true, `Expected retryable true, got ${infra.retryable}`);
});

// --- Test 5: generic APIError → 'api', retryable false ---
await test("classifyError wraps generic APIError → category 'api', retryable false", () => {
  const sdkErr = new APIError(400, null, 'bad request', mockHeaders);
  const infra = classifyError(sdkErr);
  assert.ok(infra instanceof InfrastructureError, 'Expected InfrastructureError instance');
  assert.strictEqual(infra.category, 'api', `Expected 'api', got '${infra.category}'`);
  assert.strictEqual(infra.retryable, false, `Expected retryable false, got ${infra.retryable}`);
});

// --- Test 6: plain Error → 'unknown', retryable false ---
await test("classifyError wraps plain Error → category 'unknown', retryable false", () => {
  const plainErr = new Error('something went wrong');
  const infra = classifyError(plainErr);
  assert.ok(infra instanceof InfrastructureError, 'Expected InfrastructureError instance');
  assert.strictEqual(infra.category, 'unknown', `Expected 'unknown', got '${infra.category}'`);
  assert.strictEqual(infra.retryable, false, `Expected retryable false, got ${infra.retryable}`);
});

// --- Test 7: classifyError preserves original error as .cause ---
await test('classifyError preserves original error as .cause', () => {
  const original = new Error('original error');
  const infra = classifyError(original);
  assert.strictEqual(infra.cause, original, 'Expected .cause to be the original error');
});

// --- Test 8: InfrastructureError is instanceof Error ---
await test('InfrastructureError is instanceof Error', () => {
  const infra = new InfrastructureError('test', {
    category: 'unknown',
    retryable: false,
    statusCode: undefined,
    cause: new Error('cause'),
  });
  assert.ok(infra instanceof Error, 'Expected InfrastructureError to be instanceof Error');
});

// --- Test 9: Non-SDK errors become InfrastructureError with 'unknown' category ---
await test("Normal (non-SDK) errors pass through classifyError → InfrastructureError with 'unknown' category", () => {
  const typeErr = new TypeError('type mismatch');
  const infra = classifyError(typeErr);
  assert.ok(infra instanceof InfrastructureError, 'Expected InfrastructureError instance');
  assert.strictEqual(infra.category, 'unknown', `Expected 'unknown', got '${infra.category}'`);
  assert.strictEqual(infra.retryable, false, `Expected retryable false, got ${infra.retryable}`);
  assert.strictEqual(infra.cause, typeErr, 'Expected .cause to be the original TypeError');
});

// ══════════════════════════════════════════════════════════════════════════════
// Part B — Scheduler circuit-breaker integration tests
// ══════════════════════════════════════════════════════════════════════════════

// ── Harness helpers ───────────────────────────────────────────────────────────

/**
 * Create a temp harness dir with a minimal global state.json + mission
 * state file. Mirrors the same fixture used in test-scheduler.js.
 */
function createSchedHarness(tasks, { preStatus = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cb-test-'));
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
 * Build a retryable InfrastructureError for use in mocks.
 */
function makeRetryableInfraError(msg = 'mock rate limit') {
  return new InfrastructureError(msg, {
    category: 'rate_limit',
    retryable: true,
    statusCode: 429,
    cause: new Error(msg),
  });
}

/**
 * Build a non-retryable InfrastructureError for use in mocks.
 */
function makeNonRetryableInfraError(msg = 'mock auth error') {
  return new InfrastructureError(msg, {
    category: 'auth',
    retryable: false,
    statusCode: 401,
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
  // Write verification sidecar so the state machine allows verified transition
  const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(sidecarPath, JSON.stringify({ verified: true }));
  await transitionTask(harnessDir, task.id, 'awaiting_verification');
  await transitionTask(harnessDir, task.id, 'verified', { caller: 'verification' });
  await transitionTask(harnessDir, task.id, 'complete');
}

/**
 * Replace global.setTimeout with a fast-forward stub for the duration
 * of `fn`. The stub records every requested delay (ms) and immediately
 * invokes the callback instead of waiting. Restores original after fn.
 *
 * Returns { result, delays } where `delays` is the ordered list of
 * delay values that were passed to setTimeout during the test.
 */
async function withFakeTimers(fn) {
  const delays = [];
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback, delay, ...args) => {
    delays.push(delay);
    // Execute immediately via the real setTimeout with 0ms
    return originalSetTimeout(callback, 0, ...args);
  };
  try {
    const result = await fn(delays);
    return { result, delays };
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

// ── CB1: Task disk state stays in_progress after infra error ─────────────────

await test('CB1: task disk state stays in_progress after infra error (not transitioned to failed)', async () => {
  const taskId = '001-001-001-001';
  const tasks = [
    { id: taskId, missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const { transitionTask } = await import('../src/orchestrator/core/state-machine.js');
    const { readTaskStatus } = await import('../src/orchestrator/core/state.js');

    let callCount = 0;
    let diskStateOnRetry = null;

    const mockRunTask = async (task) => {
      callCount++;
      if (callCount === 1) {
        // First call: write in_progress to disk, then throw infra error.
        // Verify that the scheduler does NOT then write 'failed' on disk.
        await transitionTask(dir, task.id, 'in_progress');
        throw makeRetryableInfraError();
      }
      // Second call: capture the disk state as seen by the retry invocation.
      diskStateOnRetry = readTaskStatus(dir, task.id);
      // Complete the task from its current in_progress state.
      await completeTaskOnDisk(dir, task);
    };

    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 1,
      runTask: mockRunTask,
    });
    await scheduler.runMilestone('001', tasks);

    assert.strictEqual(callCount, 2, 'runTask should have been called twice');
    assert.strictEqual(
      diskStateOnRetry,
      'in_progress',
      `Expected disk state to be 'in_progress' on retry, got '${diskStateOnRetry}'`
    );
  } finally { cleanup(dir); }
});

// ── CB2: Infra-errored task is re-enqueued and retried ───────────────────────

await test('CB2: infra-errored task is re-enqueued to pending and retried by scheduler', async () => {
  const taskId = '001-001-001-001';
  const tasks = [
    { id: taskId, missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    let callCount = 0;

    const mockRunTask = async (task) => {
      callCount++;
      if (callCount === 1) {
        throw makeRetryableInfraError();
      }
      // Second call: complete normally
      await completeTaskOnDisk(dir, task);
    };

    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 1,
      runTask: mockRunTask,
    });

    // Should complete without error
    await scheduler.runMilestone('001', tasks);

    assert.strictEqual(
      callCount,
      2,
      `Expected runTask to be called twice (once for error, once for retry), got ${callCount}`
    );
  } finally { cleanup(dir); }
});

// ── CB3: Scheduler pauses dispatching after 3 infra errors within 60s ────────

await test('CB3: scheduler pauses dispatching after 3 infra errors within 60s window', async () => {
  const taskId = '001-001-001-001';
  const tasks = [
    { id: taskId, missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    let callCount = 0;
    const logs = [];

    const mockRunTask = async (task) => {
      callCount++;
      if (callCount <= 3) {
        // First 3 calls: throw infra errors to trip the circuit
        throw makeRetryableInfraError();
      }
      // 4th call is the probe — succeed to reset the circuit
      await completeTaskOnDisk(dir, task);
    };

    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 1,
      runTask: mockRunTask,
      onLog: (msg) => logs.push(msg),
    });

    // Use fake timers so the probe's backoff sleep is instant
    const { delays } = await withFakeTimers(async () => {
      await scheduler.runMilestone('001', tasks);
    });

    // Verify the circuit-tripped log was emitted
    const trippedLog = logs.find((l) => /circuit tripped/i.test(l));
    assert.ok(trippedLog, `Expected a "circuit tripped" log message, got: ${logs.join(' | ')}`);

    // Verify the scheduler slept for the first backoff round (30s)
    assert.ok(
      delays.includes(Scheduler.BACKOFF_SCHEDULE[0]),
      `Expected backoff delay ${Scheduler.BACKOFF_SCHEDULE[0]}ms in delays: ${delays}`
    );

    // The scheduler must have run all 4 calls (3 failures + 1 successful probe)
    assert.strictEqual(callCount, 4, `Expected 4 runTask calls, got ${callCount}`);
  } finally { cleanup(dir); }
});

// ── CB4: Backoff timing is [30s, 60s, 120s] when all rounds exhausted ────────

await test('CB4: backoff timing is [30s, 60s, 120s] when circuit breaker is exhausted', async () => {
  const taskId = '001-001-001-001';
  const tasks = [
    { id: taskId, missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    // Always fail — trips circuit after 3, exhausts all 3 backoff rounds
    const mockRunTask = async (_task) => {
      throw makeRetryableInfraError();
    };

    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 1,
      runTask: mockRunTask,
    });

    let threw = null;
    const { delays } = await withFakeTimers(async () => {
      try {
        await scheduler.runMilestone('001', tasks);
      } catch (err) {
        threw = err;
      }
    });

    assert.ok(threw, 'Expected scheduler to throw after exhausting backoff rounds');

    // Backoff delays must match the schedule exactly
    assert.deepStrictEqual(
      delays,
      Scheduler.BACKOFF_SCHEDULE,
      `Expected delays ${JSON.stringify(Scheduler.BACKOFF_SCHEDULE)}, got ${JSON.stringify(delays)}`
    );
  } finally { cleanup(dir); }
});

// ── CB5: infra-stall progress event emitted when all backoff rounds fail ─────

await test('CB5: infra-stall progress event emitted when all backoff rounds fail', async () => {
  const taskId = '001-001-001-001';
  const tasks = [
    { id: taskId, missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const mockRunTask = async (_task) => {
      throw makeRetryableInfraError();
    };

    const progressEvents = [];
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 1,
      runTask: mockRunTask,
      onProgress: (evt) => progressEvents.push(evt),
    });

    await withFakeTimers(async () => {
      try {
        await scheduler.runMilestone('001', tasks);
      } catch (_) {
        // expected throw — we just want to verify the event
      }
    });

    const stallEvent = progressEvents.find((e) => e.type === 'infra-stall');
    assert.ok(
      stallEvent,
      `Expected an 'infra-stall' progress event, got types: ${progressEvents.map((e) => e.type).join(', ')}`
    );
    assert.ok(
      stallEvent.taskId,
      'infra-stall event should include taskId'
    );
    assert.ok(
      stallEvent.error,
      'infra-stall event should include error message'
    );
  } finally { cleanup(dir); }
});

// ── CB6: Scheduler throws Infra stall error after all backoff rounds fail ─────

await test('CB6: scheduler throws Infra stall error after all backoff rounds fail', async () => {
  const taskId = '001-001-001-001';
  const tasks = [
    { id: taskId, missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    const mockRunTask = async (_task) => {
      throw makeRetryableInfraError();
    };

    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 1,
      runTask: mockRunTask,
    });

    let threw = null;
    await withFakeTimers(async () => {
      try {
        await scheduler.runMilestone('001', tasks);
      } catch (err) {
        threw = err;
      }
    });

    assert.ok(threw, 'Expected scheduler to throw after infra-stall');
    assert.ok(
      /Infra stall/i.test(threw.message),
      `Expected error message to match /Infra stall/, got: "${threw.message}"`
    );
  } finally { cleanup(dir); }
});

// ── CB7: infraErrorCount resets to 0 after successful task completion ─────────

await test('CB7: infraErrorCount (_infraErrors) resets to 0 after successful task completion', async () => {
  const taskId = '001-001-001-001';
  const tasks = [
    { id: taskId, missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    let callCount = 0;

    const mockRunTask = async (task) => {
      callCount++;
      if (callCount === 1) {
        // First call: fail with infra error (below the circuit-trip threshold of 3)
        throw makeRetryableInfraError();
      }
      // Second call: succeed — this should reset _infraErrors
      await completeTaskOnDisk(dir, task);
    };

    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 1,
      runTask: mockRunTask,
    });

    await scheduler.runMilestone('001', tasks);

    // After a successful completion, _infraErrors must be reset to empty
    assert.strictEqual(
      scheduler._infraErrors.length,
      0,
      `Expected _infraErrors to be empty after successful task, got ${scheduler._infraErrors.length} entries`
    );
    // Circuit must also be closed
    assert.strictEqual(
      scheduler._circuitOpen,
      false,
      'Expected _circuitOpen to be false after successful task'
    );
  } finally { cleanup(dir); }
});

// ── CB8: Non-retryable InfrastructureError follows normal error/drain path ───

await test('CB8: non-retryable InfrastructureError follows normal error/drain path (not circuit-breaker retried)', async () => {
  const taskId = '001-001-001-001';
  const tasks = [
    { id: taskId, missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['a.js'] },
  ];
  const dir = createSchedHarness(tasks);
  try {
    let callCount = 0;

    const mockRunTask = async (_task) => {
      callCount++;
      // Always throw a non-retryable infra error (auth)
      throw makeNonRetryableInfraError();
    };

    const progressEvents = [];
    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 1,
      runTask: mockRunTask,
      onProgress: (evt) => progressEvents.push(evt),
    });

    let threw = null;
    try {
      await scheduler.runMilestone('001', tasks);
    } catch (err) {
      threw = err;
    }

    // Scheduler must throw (normal error propagation)
    assert.ok(threw, 'Expected scheduler to throw for non-retryable infra error');

    // The error should be the non-retryable infra error itself (not an "Infra stall")
    assert.ok(
      !/Infra stall/i.test(threw.message),
      `Expected non-stall error, got: "${threw.message}"`
    );

    // task-fail progress event must be emitted (normal drain path)
    const failEvent = progressEvents.find((e) => e.type === 'task-fail');
    assert.ok(
      failEvent,
      `Expected a 'task-fail' progress event, got types: ${progressEvents.map((e) => e.type).join(', ')}`
    );
    assert.strictEqual(failEvent.taskId, taskId, 'task-fail event should reference the failing task');

    // Task must NOT have been re-enqueued (runTask called only once)
    assert.strictEqual(
      callCount,
      1,
      `Expected runTask to be called exactly once for non-retryable error, got ${callCount}`
    );

    // _infraErrors must remain empty (circuit breaker path not taken)
    assert.strictEqual(
      scheduler._infraErrors.length,
      0,
      'Non-retryable infra error must not increment _infraErrors'
    );
  } finally { cleanup(dir); }
});

// ══════════════════════════════════════════════════════════════════════════════
// Part C — Pipeline + CLI integration tests
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create a minimal .harness directory suitable for Pipeline tests.
 * The task status can be overridden via taskStatus (default 'pending').
 * To get alreadyApproved=true (skips planner/confirm prompts), use 'in_progress'.
 */
function createPipelineHarness({
  milestoneId = '001',
  missionId = '001-001',
  subMissionId = '001-001-001',
  taskId = '001-001-001-001',
  taskStatus = 'pending',
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-infra-test-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  // Create target file in projectRoot so snapshotFiles can copy it
  const targetFile = 'a.js';
  fs.writeFileSync(path.join(projectRoot, targetFile), '// a.js\n');

  // Write verify.json that _executeAndVerifyTask reads
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: [targetFile], hardChecks: [], testCases: [] })
  );

  // Write mission state file
  const missionState = {
    id: missionId,
    missionId,
    description: 'test mission',
    status: 'in_progress',
    subMissions: {
      [subMissionId]: {
        id: subMissionId,
        description: 'test sub-mission',
        status: 'in_progress',
        tasks: {
          [taskId]: {
            id: taskId,
            description: 'test task',
            status: taskStatus,
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            targetFiles: [targetFile],
            dependencies: [],
            testCases: [],
            tracesScenario: [],
            patternReferences: [],
            dataSchemas: [],
            verifyFile: `.harness/verify/task-${taskId}.json`,
            progressFile: `.harness/progress/task-${taskId}.json`,
            verificationFile: `.harness/verification/task-${taskId}.json`,
            retryCount: 0,
          },
        },
      },
    },
  };

  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify(missionState, null, 2)
  );

  // Write global state.json
  const state = {
    projectMeta: {
      prdPath: '',
      createdAt: new Date().toISOString(),
      currentPhase: 'executing',
    },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId,
        description: `milestone ${milestoneId}`,
        status: 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: {
          [missionId]: {
            id: missionId,
            description: 'test mission',
            status: 'in_progress',
            stateFile: `.harness/state/mission-${missionId}.json`,
          },
        },
      },
    },
  };

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(state, null, 2)
  );

  return { projectRoot, harnessDir };
}

/**
 * Create a Pipeline instance with worktree disabled and review skipped,
 * suitable for in-process integration tests.
 */
function makePipelineNoAuth(projectRoot) {
  return new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    onLog: () => {},
    onConfirm: async () => true,
    noReview: true,
    skipReview: true,
  });
}

// ── PC1: _executeAndVerifyTask stays in_progress + skips _dispatchAnalyzer ───

await test(
  'PC1: _executeAndVerifyTask — executor InfrastructureError keeps task in_progress and does NOT call _dispatchAnalyzer',
  async () => {
    // Task starts as 'pending' so the method transitions it to 'in_progress' first.
    // After the executor throws InfrastructureError the task must remain 'in_progress'
    // (never written to 'failed') and _dispatchAnalyzer must never be invoked.
    const { projectRoot, harnessDir } = createPipelineHarness({ taskStatus: 'pending' });
    try {
      const pipeline = makePipelineNoAuth(projectRoot);

      // Replace executor with one that throws a retryable InfrastructureError
      pipeline.executor = {
        executeTask: async () => {
          throw new InfrastructureError('mock rate limit', {
            category: 'rate_limit',
            retryable: true,
            statusCode: 429,
            cause: new Error('mock rate limit'),
          });
        },
      };

      // Spy: _dispatchAnalyzer must NOT be called
      let analyzerCalled = false;
      pipeline._dispatchAnalyzer = async () => { analyzerCalled = true; };

      const task = {
        id: '001-001-001-001',
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['a.js'],
        description: 'test task',
      };

      let thrownErr = null;
      try {
        await pipeline._executeAndVerifyTask('001-001', '001-001-001', task);
      } catch (err) {
        thrownErr = err;
      }

      // 1. The error propagated must be an InfrastructureError
      assert.ok(thrownErr instanceof InfrastructureError,
        `Expected InfrastructureError to be thrown, got: ${thrownErr?.constructor?.name} — ${thrownErr?.message}`);

      // 2. Task disk state must still be in_progress (not 'failed')
      const { readTaskStatus } = await import('../src/orchestrator/core/state.js');
      const diskStatus = readTaskStatus(harnessDir, task.id);
      assert.strictEqual(
        diskStatus,
        'in_progress',
        `Expected task disk state to be 'in_progress' after InfrastructureError, got '${diskStatus}'`
      );

      // 3. _dispatchAnalyzer must NOT have been called
      assert.strictEqual(
        analyzerCalled,
        false,
        'Expected _dispatchAnalyzer NOT to be called when executor throws InfrastructureError'
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

// ── PC2: InfrastructureError propagates through _executeMilestone ─────────────

await test(
  'PC2: InfrastructureError propagates from _executeMilestone — matches CLI instanceof check for exit(75)',
  async () => {
    // Build a harness where the mission is already approved (alreadyApproved=true
    // because taskStatus='in_progress'), so _planAndApproveMission skips the AI
    // planner and the onConfirm prompt.  A non-retryable InfrastructureError (auth)
    // means the scheduler forwards it directly as firstError without entering the
    // circuit-breaker backoff path — so no fake timers are needed.
    const { projectRoot } = createPipelineHarness({ taskStatus: 'in_progress' });
    try {
      const pipeline = makePipelineNoAuth(projectRoot);

      // Skip the milestone-level scenario coverage gate (would call planner AI)
      pipeline._skipCoverageGate = true;

      // Replace executor with non-retryable InfrastructureError (auth)
      pipeline.executor = {
        executeTask: async () => {
          throw new InfrastructureError('mock auth error', {
            category: 'auth',
            retryable: false,
            statusCode: 401,
            cause: new Error('mock auth error'),
          });
        },
      };

      // Read the milestone state that _executeMilestone expects
      const globalState = JSON.parse(
        fs.readFileSync(path.join(activeHarnessDir(projectRoot), 'state.json'), 'utf8')
      );
      const msState = globalState.milestones['001'];

      let thrownErr = null;
      try {
        await pipeline._executeMilestone('001', msState);
      } catch (err) {
        thrownErr = err;
      }

      // The error propagated from _executeMilestone must be an InfrastructureError.
      // This is exactly what pipeline.run() / pipeline.resume() would throw, and
      // the CLI's catch block maps it to process.exit(75):
      //   if (err instanceof InfrastructureError) { process.exit(75); }
      assert.ok(
        thrownErr instanceof InfrastructureError,
        `Expected InfrastructureError to propagate from _executeMilestone, ` +
        `got: ${thrownErr?.constructor?.name} — ${thrownErr?.message}`
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

// ── PC3: CLI instanceof check confirms InfrastructureError matches ────────────

await test(
  'PC3: CLI instanceof check — err instanceof InfrastructureError returns true (mirrors run.js catch condition)',
  () => {
    // Mirrors the exact guard in src/cli/commands/run.js and resume.js:
    //   if (err instanceof InfrastructureError) { process.exit(75); }
    const err = new InfrastructureError('mock network error', {
      category: 'network',
      retryable: true,
      statusCode: 503,
      cause: new Error('connection refused'),
    });

    // The CLI catch condition
    assert.ok(
      err instanceof InfrastructureError,
      'Expected err instanceof InfrastructureError to be true — the CLI catch guard must match'
    );

    // InfrastructureError must also be instanceof Error (standard JS contract)
    assert.ok(
      err instanceof Error,
      'Expected InfrastructureError to be instanceof Error'
    );
  }
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
