/**
 * test-concurrency-writers.js — Integration regression test for the
 * Phase I items 4+5 mutex layer.
 *
 * Hammers every mutex-wrapped writer with N concurrent callers and
 * asserts no data loss, no unhandled errors, no state corruption.
 * This is the Rule 3 integration test that validates the step 2-4
 * mutex work BEFORE the scheduler code (step 6+) starts running
 * anything in parallel for real. See:
 *
 *   docs/audit/phase-1-concurrency-writer-audit.md  (findings)
 *   docs/design/phase-1-parallel-execution.md §7    (test plan)
 *
 * Run: node test/test-concurrency-writers.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  transitionTask,
  transitionMission,
  transitionMilestone,
  withMissionFileLock,
  getTaskStatus,
  getMissionStatus,
} from '../src/orchestrator/core/state-machine.js';
import { TokenTracker } from '../src/orchestrator/infra/token-tracker.js';
import { Logger } from '../src/orchestrator/infra/logger.js';

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
 * Create a temp harness dir with a global state.json + mission state
 * file containing `taskCount` tasks under sub-mission `001-001-001`,
 * all in `pending` status. Returns the harness dir path.
 *
 * This is the "hammer target": all tasks in pending means we can
 * concurrently transition them to `in_progress` (an unguarded
 * transition) without tripping the verified gate or the complete gate.
 */
function createHammerHarness(taskCount, missionCount = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrency-writers-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'verification'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });

  // Build global state.json with one milestone containing `missionCount` missions.
  const milestones = {
    '001': {
      id: '001',
      description: 'concurrency test milestone',
      status: 'in_progress',
      missions: {},
    },
  };

  for (let m = 1; m <= missionCount; m++) {
    const miId = `001-${String(m).padStart(3, '0')}`;
    milestones['001'].missions[miId] = {
      id: miId,
      status: 'pending',
      stateFile: `.harness/state/mission-${miId}.json`,
    };

    // Write the per-mission state file with `taskCount` pending tasks.
    const tasks = {};
    for (let i = 1; i <= taskCount; i++) {
      const taskId = `${miId}-001-${String(i).padStart(3, '0')}`;
      tasks[taskId] = {
        id: taskId,
        description: `test task ${i}`,
        status: 'pending',
        retryCount: 0,
      };
    }

    fs.writeFileSync(
      path.join(dir, 'state', `mission-${miId}.json`),
      JSON.stringify({
        id: miId,
        missionId: miId,
        description: 'test mission',
        status: 'pending',
        subMissions: {
          [`${miId}-001`]: {
            id: `${miId}-001`,
            description: 'sm',
            status: 'pending',
            tasks,
          },
        },
      }, null, 2)
    );
  }

  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      projectMeta: {
        prdPath: '',
        createdAt: new Date().toISOString(),
        currentPhase: 'executing',
      },
      globalStatus: 'active',
      milestones,
    }, null, 2)
  );

  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readMissionState(dir, missionId) {
  return JSON.parse(
    fs.readFileSync(path.join(dir, 'state', `mission-${missionId}.json`), 'utf8')
  );
}

function readGlobalState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
}

// Fake SDK result for TokenTracker.recordSession
function fakeResultEvent(cost = 0.01) {
  return {
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 10,
    },
    total_cost_usd: cost,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

async function run() {

// ─────────────────────────────────────────────────────────────────────
// 1. 20 concurrent transitionTask calls on the same mission
//
// Before step 2 this test would silently lose updates or throw
// "Concurrent modification detected" from the mtime guard. With the
// per-mission-file mutex all 20 transitions serialize and every task
// ends up in `in_progress`.
// ─────────────────────────────────────────────────────────────────────

await test('20 concurrent transitionTask calls on same mission all complete', async () => {
  const N = 20;
  const dir = createHammerHarness(N);
  try {
    const taskIds = Array.from({ length: N }, (_, i) =>
      `001-001-001-${String(i + 1).padStart(3, '0')}`
    );

    // Fire all 20 transitions at once
    await Promise.all(
      taskIds.map((id) => transitionTask(dir, id, 'in_progress'))
    );

    // Every task should now be in_progress
    for (const id of taskIds) {
      const status = getTaskStatus(dir, id);
      assert.strictEqual(status, 'in_progress', `task ${id} should be in_progress, got ${status}`);
    }

    // Mission state file must be valid JSON with all 20 tasks
    const state = readMissionState(dir, '001-001');
    const taskKeys = Object.keys(state.subMissions['001-001-001'].tasks);
    assert.strictEqual(taskKeys.length, N, `mission state should have all ${N} tasks`);
  } finally { cleanup(dir); }
});

// ─────────────────────────────────────────────────────────────────────
// 2. Transitions on different missions run concurrently (no serialization)
//
// The mutex is keyed on mission file path, so transitions on different
// mission files should not contend. 5 missions × 5 tasks = 25 concurrent
// transitions; all 25 should complete.
// ─────────────────────────────────────────────────────────────────────

await test('concurrent transitions across different missions do not contend', async () => {
  const tasksPerMission = 5;
  const missionCount = 5;
  const dir = createHammerHarness(tasksPerMission, missionCount);
  try {
    const allTaskIds = [];
    for (let m = 1; m <= missionCount; m++) {
      const miId = `001-${String(m).padStart(3, '0')}`;
      for (let i = 1; i <= tasksPerMission; i++) {
        allTaskIds.push(`${miId}-001-${String(i).padStart(3, '0')}`);
      }
    }

    await Promise.all(
      allTaskIds.map((id) => transitionTask(dir, id, 'in_progress'))
    );

    for (const id of allTaskIds) {
      assert.strictEqual(getTaskStatus(dir, id), 'in_progress', `task ${id}`);
    }
  } finally { cleanup(dir); }
});

// ─────────────────────────────────────────────────────────────────────
// 3. transitionMission dual-write under concurrency
//
// transitionMission acquires BOTH the global-state mutex and the
// mission-file mutex (fixed order). Under concurrent calls to transition
// multiple missions to `blocked`, the dual writes must all land and
// both files must agree on the final status.
// ─────────────────────────────────────────────────────────────────────

await test('concurrent transitionMission dual-writes stay consistent', async () => {
  const missionCount = 5;
  const dir = createHammerHarness(1, missionCount);
  try {
    const missionIds = Array.from({ length: missionCount }, (_, i) =>
      `001-${String(i + 1).padStart(3, '0')}`
    );

    await Promise.all(
      missionIds.map((id) => transitionMission(dir, id, 'blocked'))
    );

    // Global state.json must reflect all 5 missions as blocked
    const global = readGlobalState(dir);
    for (const id of missionIds) {
      assert.strictEqual(
        global.milestones['001'].missions[id].status,
        'blocked',
        `global state should show ${id} as blocked`
      );
    }

    // Each per-mission file must also reflect blocked
    for (const id of missionIds) {
      assert.strictEqual(getMissionStatus(dir, id), 'blocked', `mission file ${id}`);
    }
  } finally { cleanup(dir); }
});

// ─────────────────────────────────────────────────────────────────────
// 4. 20 concurrent TokenTracker.recordSession — no data loss
//
// Before step 3 this test would silently lose entries because
// recordSession was sync with no mutex. Now each call serializes
// through _writeMutex and every one of the 20 sessions ends up in the
// saved file.
// ─────────────────────────────────────────────────────────────────────

await test('20 concurrent TokenTracker.recordSession calls land all entries', async () => {
  const dir = createHammerHarness(1);
  try {
    const tracker = new TokenTracker(dir);
    const N = 20;

    const calls = [];
    for (let i = 0; i < N; i++) {
      calls.push(
        tracker.recordSession(`session-${i}`, 'executor', fakeResultEvent(0.01 + i * 0.001), {
          taskId: `task-${i}`,
        })
      );
    }

    await Promise.all(calls);

    // Reload from disk and check every session is present
    const fresh = new TokenTracker(dir);
    assert.strictEqual(fresh._sessions.length, N, `expected ${N} sessions, got ${fresh._sessions.length}`);

    // Each session name should appear exactly once
    const names = new Set(fresh._sessions.map((s) => s.name));
    assert.strictEqual(names.size, N, `expected ${N} unique session names, got ${names.size}`);
    for (let i = 0; i < N; i++) {
      assert.ok(names.has(`session-${i}`), `missing session-${i}`);
    }
  } finally { cleanup(dir); }
});

// ─────────────────────────────────────────────────────────────────────
// 5. 20 concurrent Logger.writeSessionSummary — no data loss
//
// Before step 4 this test would silently lose entries because
// writeSessionSummary was sync with no mutex. Now each call serializes
// through _summaryMutex and every one of the 20 summaries is appended.
// ─────────────────────────────────────────────────────────────────────

await test('20 concurrent Logger.writeSessionSummary calls append all entries', async () => {
  const dir = createHammerHarness(1);
  try {
    const logger = new Logger(dir);
    const N = 20;

    const calls = [];
    for (let i = 0; i < N; i++) {
      calls.push(
        logger.writeSessionSummary(`session-${i}`, {
          inputTokens: 100 + i,
          outputTokens: 50,
          totalCost: 0.01,
        }, { role: 'executor', taskId: `task-${i}` })
      );
    }

    await Promise.all(calls);

    // Read the summary file back and verify all N entries present
    const summaryPath = path.join(dir, 'logs', 'session-summary.json');
    const summaries = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    assert.strictEqual(summaries.length, N, `expected ${N} summaries, got ${summaries.length}`);

    const names = new Set(summaries.map((s) => s.name));
    assert.strictEqual(names.size, N, `expected ${N} unique names, got ${names.size}`);
  } finally { cleanup(dir); }
});

// ─────────────────────────────────────────────────────────────────────
// 6. Mixed workload: transitionTask + recordSession + writeSessionSummary
//
// The realistic parallelism pattern: a scheduler worker completes a
// task, the state-machine transitions fire, the TokenTracker and Logger
// record the session. All three writers serialize independently (they
// target different files), so a burst of 10 "fake worker completions"
// should have every transition landed and every record persisted.
// ─────────────────────────────────────────────────────────────────────

await test('mixed workload: 10 fake worker completions all land', async () => {
  const N = 10;
  const dir = createHammerHarness(N);
  try {
    const tracker = new TokenTracker(dir);
    const logger = new Logger(dir);

    const workers = [];
    for (let i = 1; i <= N; i++) {
      const taskId = `001-001-001-${String(i).padStart(3, '0')}`;
      workers.push((async () => {
        // Simulate a worker: transition + recordSession + writeSessionSummary
        await transitionTask(dir, taskId, 'in_progress');
        await tracker.recordSession(`exec-${taskId}`, 'executor', fakeResultEvent(0.02), {
          taskId,
        });
        await logger.writeSessionSummary(`exec-${taskId}`, {
          inputTokens: 200,
          outputTokens: 100,
          totalCost: 0.02,
        }, { role: 'executor', taskId });
      })());
    }

    await Promise.all(workers);

    // All tasks should be in_progress
    for (let i = 1; i <= N; i++) {
      const taskId = `001-001-001-${String(i).padStart(3, '0')}`;
      assert.strictEqual(getTaskStatus(dir, taskId), 'in_progress');
    }

    // All N sessions in TokenTracker
    const freshTracker = new TokenTracker(dir);
    assert.strictEqual(freshTracker._sessions.length, N, 'token tracker session count');

    // All N summaries in Logger
    const summaries = JSON.parse(
      fs.readFileSync(path.join(dir, 'logs', 'session-summary.json'), 'utf8')
    );
    assert.strictEqual(summaries.length, N, 'logger summary count');
  } finally { cleanup(dir); }
});

// ─────────────────────────────────────────────────────────────────────
// 7. withMissionFileLock serializes with state-machine transitions
//
// gates/coverage.js mergeRemediationTasks uses withMissionFileLock to
// share the same mutex as the state-machine. This test interleaves a
// state-machine transitionTask and a manual withMissionFileLock
// critical section on the same mission, verifying they serialize (no
// mid-write reads, no lost updates).
// ─────────────────────────────────────────────────────────────────────

await test('withMissionFileLock serializes with transitionTask on same mission', async () => {
  const dir = createHammerHarness(10);
  try {
    const ops = [];
    // 10 transitionTask calls
    for (let i = 1; i <= 10; i++) {
      const taskId = `001-001-001-${String(i).padStart(3, '0')}`;
      ops.push(transitionTask(dir, taskId, 'in_progress'));
    }
    // 5 "direct" withMissionFileLock writes that mutate the mission file
    for (let i = 0; i < 5; i++) {
      ops.push(
        withMissionFileLock(dir, '001-001', async () => {
          const stateFile = path.join(dir, 'state', 'mission-001-001.json');
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          state.description = `updated-${i}`;
          fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        })
      );
    }

    await Promise.all(ops);

    // All 10 tasks should be in_progress AND the description should be
    // one of updated-0..updated-4 (whichever lock ran last).
    const state = readMissionState(dir, '001-001');
    for (let i = 1; i <= 10; i++) {
      const taskId = `001-001-001-${String(i).padStart(3, '0')}`;
      assert.strictEqual(
        state.subMissions['001-001-001'].tasks[taskId].status,
        'in_progress'
      );
    }
    assert.ok(
      /^updated-[0-4]$/.test(state.description),
      `description should be one of updated-0..4, got ${state.description}`
    );
  } finally { cleanup(dir); }
});

// ─────────────────────────────────────────────────────────────────────
// 8. Concurrent transitionMilestone: global-state mutex serializes
//
// Multiple milestone transitions on the same state.json must serialize.
// Five milestones × one transition each → all five land.
// ─────────────────────────────────────────────────────────────────────

await test('concurrent transitionMilestone on multiple milestones all land', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrency-milestone-'));
  try {
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    const milestones = {};
    for (let m = 1; m <= 5; m++) {
      const msId = String(m).padStart(3, '0');
      milestones[msId] = {
        id: msId,
        status: 'pending',
        missions: {},
      };
    }
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
        globalStatus: 'active',
        milestones,
      }, null, 2)
    );

    await Promise.all(
      ['001', '002', '003', '004', '005'].map((msId) =>
        transitionMilestone(dir, msId, 'blocked')
      )
    );

    const global = readGlobalState(dir);
    for (const msId of ['001', '002', '003', '004', '005']) {
      assert.strictEqual(global.milestones[msId].status, 'blocked');
    }
  } finally { cleanup(dir); }
});

// ─────────────────────────────────────────────────────────────────────
// 9. Stress: 100 sequential transitions under the mutex complete cleanly
//
// Not a concurrency test per se, but confirms the mutex doesn't leak
// state across sequential acquires. If release-per-acquisition has a
// bug, 100 sequential calls would surface it faster than 20 concurrent
// ones.
// ─────────────────────────────────────────────────────────────────────

await test('100 sequential transitionTask acquires release cleanly', async () => {
  const N = 100;
  const dir = createHammerHarness(N);
  try {
    for (let i = 1; i <= N; i++) {
      const taskId = `001-001-001-${String(i).padStart(3, '0')}`;
      await transitionTask(dir, taskId, 'in_progress');
    }

    for (let i = 1; i <= N; i++) {
      const taskId = `001-001-001-${String(i).padStart(3, '0')}`;
      assert.strictEqual(getTaskStatus(dir, taskId), 'in_progress');
    }
  } finally { cleanup(dir); }
});

// ─────────────────────────────────────────────────────────────────────
// 10. No unhandled rejections during concurrent load
//
// Catches a class of bug where a mutex-wrapped function throws after
// release() has been called (or before). Node's unhandled rejection
// tracker would fire and crash the test process.
// ─────────────────────────────────────────────────────────────────────

await test('no unhandled rejections during mixed concurrent load', async () => {
  const dir = createHammerHarness(20);
  try {
    const tracker = new TokenTracker(dir);
    const logger = new Logger(dir);

    let unhandled = null;
    const handler = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', handler);

    try {
      const ops = [];
      for (let i = 1; i <= 20; i++) {
        const taskId = `001-001-001-${String(i).padStart(3, '0')}`;
        ops.push(transitionTask(dir, taskId, 'in_progress'));
        ops.push(tracker.recordSession(`exec-${i}`, 'executor', fakeResultEvent(0.01)));
        ops.push(logger.writeSessionSummary(`exec-${i}`, { inputTokens: 100, outputTokens: 50, totalCost: 0.01 }));
      }
      await Promise.all(ops);

      // Give the event loop one more tick to surface any late rejections
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off('unhandledRejection', handler);
    }

    assert.strictEqual(unhandled, null, `unexpected unhandled rejection: ${unhandled}`);
  } finally { cleanup(dir); }
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
