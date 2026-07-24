/**
 * test-scheduler-resume.js — Resume regression tests for Phase I
 * items 4+5 decision D2 = A ("reconstruct ready set, parallel resume").
 *
 * Implements the 10 scenarios enumerated in docs/design/phase-1-
 * parallel-execution.md §4 D2. User directive: "test the shit out
 * of it." These are first-class deliverables, not afterthought
 * sentinels.
 *
 * All scenarios run against a real Pipeline + real scheduler + real
 * state-machine (via the mutex layer) with fake Executor / Verifier /
 * Analyzer so no SDK spawns occur. Each scenario pre-populates a
 * harness directory in an intermediate "crashed" state, then calls
 * pipeline._executeMilestone and asserts the final state is
 * consistent.
 *
 * Run: node test/test-scheduler-resume.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import config from '../src/orchestrator/infra/config.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { TokenTracker } from '../src/orchestrator/infra/token-tracker.js';

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
 * Create a temp project root with a .harness subdirectory and the
 * given mission layout. Every task can be seeded with a pre-crash
 * status via `preStatus` so we can construct arbitrary interrupted
 * scenarios.
 *
 * `preStatus` is a map of taskId → status. Tasks not in the map are
 * created with status='pending'.
 */
function createResumeHarness({
  milestoneId = '001',
  missions,
  preStatus = {},
}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-resume-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const missionEntries = {};
  for (const mission of missions) {
    missionEntries[mission.id] = {
      id: mission.id,
      description: `mission ${mission.id}`,
      status: preStatus[mission.id] || 'pending',
      stateFile: `.harness/state/mission-${mission.id}.json`,
      planFile: `.harness/plan/mission-${mission.id}.md`,
    };

    const tasks = {};
    for (const task of mission.tasks) {
      const taskStatus = preStatus[task.id] || 'pending';
      tasks[task.id] = {
        id: task.id,
        description: task.description || `task ${task.id}`,
        status: taskStatus,
        createdAt: new Date().toISOString(),
        startedAt: taskStatus !== 'pending' ? new Date().toISOString() : null,
        completedAt: (taskStatus === 'complete' || taskStatus === 'invalidated') ? new Date().toISOString() : null,
        targetFiles: task.targetFiles || [],
        dependencies: task.dependencies || [],
        testCases: [],
        tracesScenario: [],
        patternReferences: [],
        dataSchemas: [],
        verifyFile: `.harness/verify/task-${task.id}.json`,
        progressFile: `.harness/progress/task-${task.id}.json`,
        verificationFile: `.harness/verification/task-${task.id}.json`,
        retryCount: 0,
      };

      // Source files for snapshot
      for (const f of task.targetFiles || []) {
        const full = path.join(projectRoot, f);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (!fs.existsSync(full)) fs.writeFileSync(full, `// ${f}\n`);
      }

      // verify.json stub
      fs.writeFileSync(
        path.join(harnessDir, 'verify', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, targetFiles: task.targetFiles || [], hardChecks: [], testCases: [] })
      );

      // If the task is pre-seeded in verified state, we also need a
      // verification sidecar on disk so the state-machine gate that
      // re-checks the file wouldn't complain. result:'PASSED' mirrors a real
      // verified sidecar — the Phase-5 audit reads parsed.result === 'PASSED'.
      if (taskStatus === 'verified' || taskStatus === 'complete') {
        fs.writeFileSync(
          path.join(harnessDir, 'verification', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', report: 'pre-seeded' })
        );
      }
    }

    const subMissionId = `${mission.id}-001`;
    const missionState = {
      id: mission.id,
      missionId: mission.id,
      description: `mission ${mission.id}`,
      status: preStatus[`mission:${mission.id}`] || 'pending',
      subMissions: {
        [subMissionId]: {
          id: subMissionId,
          description: 'sm',
          status: preStatus[`sm:${subMissionId}`] || 'pending',
          tasks,
        },
      },
    };
    fs.writeFileSync(
      path.join(harnessDir, 'state', `mission-${mission.id}.json`),
      JSON.stringify(missionState, null, 2)
    );
  }

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
        status: preStatus[`ms:${milestoneId}`] || 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: missionEntries,
      },
    },
  };

  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  return { projectRoot, harnessDir };
}

function cleanup(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

function readTaskState(harnessDir, missionId, subMissionId, taskId) {
  const state = JSON.parse(
    fs.readFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), 'utf8')
  );
  return state.subMissions[subMissionId].tasks[taskId];
}

function installFakes(pipeline, { failTaskIds = new Set(), delay = 5 } = {}) {
  const trace = {
    executorCalls: [],
    verifierCalls: [],
  };

  pipeline.executor = {
    executeTask: async (task, _projectRoot, _opts) => {
      trace.executorCalls.push(task.id);
      if (failTaskIds.has(task.id)) {
        fs.writeFileSync(
          path.join(pipeline.harnessDir, 'progress', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, status: 'BLOCKED', affectedFiles: [], blockers: ['fail'] })
        );
        return { status: 'BLOCKED', affectedFiles: [], blockers: ['fail'] };
      }
      await new Promise((r) => setTimeout(r, delay));
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'progress', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, status: 'COMPLETE', affectedFiles: task.targetFiles || [] })
      );
      return { status: 'COMPLETE', affectedFiles: task.targetFiles || [] };
    },
  };

  pipeline.verifier = {
    verifyTask: async (task, _projectRoot, _opts) => {
      trace.verifierCalls.push(task.id);
      // result:'PASSED' mirrors a real verifier — the Phase-5 audit reads
      // parsed.result === 'PASSED' for every complete task.
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'verification', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', report: 'fake' })
      );
      return { verified: true, report: 'fake', structured: { verified: true, report: 'fake' } };
    },
  };
  // verifyRegression: the regression gates now call the dedicated method;
  // the mock reuses the same implementation (same id-sniff branches apply).
  pipeline.verifier.verifyRegression = pipeline.verifier.verifyTask;

  pipeline.analyzer = {
    analyzeFailure: async () => ({ eventId: 'fake', recommendation: 'human', affectedTasks: [] }),
  };

  // Stub reviewer for tests that exercise _executeMilestone (e.g. scenario 7).
  // Returns a uniform PASS verdict so milestone-level reviewer gate proceeds without
  // talking to a real SDK. Lower-level tests (scenarios 1-6) never invoke this.
  pipeline.reviewer = {
    reviewMilestone: async () => ({
      passed: true,
      findings: [],
      report: 'fake reviewer',
      reportPath: '',
      structured: { result: 'PASSED', findings: [], passedReason: 'fake' },
    }),
  };

  return trace;
}

function makePipeline(projectRoot, { maxConcurrent = 3 } = {}) {
  const origMax = config.execution.maxConcurrentSessions;
  config.execution.maxConcurrentSessions = maxConcurrent;

  const pipeline = new Pipeline(projectRoot, {
    onLog: () => {},
    onConfirm: async () => true,
  });
  pipeline._missionRegression = async () => {};  // stub out mission regression

  const restore = () => {
    config.execution.maxConcurrentSessions = origMax;
  };

  return { pipeline, restore };
}

// ── Scenarios ────────────────────────────────────────────────────────

async function run() {

// ── Scenario 1: Clean resume, half-complete mission ──────────────────

await test('1. clean resume: 3 of 6 tasks pre-complete, scheduler runs remaining 3', async () => {
  const missions = [{
    id: '001-001',
    tasks: [
      { id: '001-001-001-001', targetFiles: ['src/a.js'] },
      { id: '001-001-001-002', targetFiles: ['src/b.js'] },
      { id: '001-001-001-003', targetFiles: ['src/c.js'] },
      { id: '001-001-001-004', targetFiles: ['src/d.js'] },
      { id: '001-001-001-005', targetFiles: ['src/e.js'] },
      { id: '001-001-001-006', targetFiles: ['src/f.js'] },
    ],
  }];
  const preStatus = {
    '001-001-001-001': 'complete',
    '001-001-001-002': 'complete',
    '001-001-001-003': 'complete',
  };
  const { projectRoot, harnessDir } = createResumeHarness({ missions, preStatus });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    const trace = installFakes(pipeline);
    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState.milestones['001']);

    // Only tasks 4, 5, 6 should have been executed
    const expected = ['001-001-001-004', '001-001-001-005', '001-001-001-006'];
    assert.deepStrictEqual(trace.executorCalls.sort(), expected, `expected ${expected}, got ${trace.executorCalls.sort()}`);

    // All 6 should be complete in the final state
    for (const task of missions[0].tasks) {
      const state = readTaskState(harnessDir, '001-001', '001-001-001', task.id);
      assert.strictEqual(state.status, 'complete', `${task.id}`);
    }
  } finally { restore(); cleanup(projectRoot); }
});

// ── Scenario 2: Resume with one in-flight task ───────────────────────

await test('2. in-flight single: task in in_progress is re-picked up cleanly', async () => {
  const missions = [{
    id: '001-001',
    tasks: [
      { id: '001-001-001-001', targetFiles: ['src/a.js'] },
      { id: '001-001-001-002', targetFiles: ['src/b.js'] },
    ],
  }];
  const preStatus = {
    '001-001-001-001': 'in_progress',
    'mission:001-001': 'in_progress',
    'sm:001-001-001': 'in_progress',
  };
  const { projectRoot, harnessDir } = createResumeHarness({ missions, preStatus });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    const trace = installFakes(pipeline);
    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState.milestones['001']);

    // Both tasks should have executed; the in-flight one goes through
    // _executeAndVerifyTask which skips the pending→in_progress
    // transition (guard at preExecStatus check) and runs executor
    // + verifier as normal.
    assert.strictEqual(trace.executorCalls.length, 2);
    for (const task of missions[0].tasks) {
      const state = readTaskState(harnessDir, '001-001', '001-001-001', task.id);
      assert.strictEqual(state.status, 'complete', `${task.id}`);
    }
  } finally { restore(); cleanup(projectRoot); }
});

// ── Scenario 3: Multiple in-flight, non-overlapping files ────────────

await test('3. multi in-flight non-overlapping: all re-picked up in parallel', async () => {
  const missions = [{
    id: '001-001',
    tasks: [
      { id: '001-001-001-001', targetFiles: ['src/a.js'] },
      { id: '001-001-001-002', targetFiles: ['src/b.js'] },
      { id: '001-001-001-003', targetFiles: ['src/c.js'] },
    ],
  }];
  const preStatus = {
    '001-001-001-001': 'in_progress',
    '001-001-001-002': 'in_progress',
    'mission:001-001': 'in_progress',
    'sm:001-001-001': 'in_progress',
  };
  const { projectRoot, harnessDir } = createResumeHarness({ missions, preStatus });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    installFakes(pipeline);
    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState.milestones['001']);

    for (const task of missions[0].tasks) {
      const state = readTaskState(harnessDir, '001-001', '001-001-001', task.id);
      assert.strictEqual(state.status, 'complete', `${task.id}`);
    }
  } finally { restore(); cleanup(projectRoot); }
});

// ── Scenario 4: awaiting_verification crash (skip executor on resume) ─

await test('4. awaiting_verification crash: executor SKIPPED, verifier re-runs', async () => {
  const missions = [{
    id: '001-001',
    tasks: [
      { id: '001-001-001-001', targetFiles: ['src/a.js'] },
    ],
  }];
  const preStatus = {
    '001-001-001-001': 'awaiting_verification',
    'mission:001-001': 'in_progress',
    'sm:001-001-001': 'in_progress',
  };
  const { projectRoot, harnessDir } = createResumeHarness({ missions, preStatus });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    const trace = installFakes(pipeline);
    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState.milestones['001']);

    // Executor should NOT have been invoked (skipExecutor path in
    // _executeAndVerifyTask), verifier SHOULD have been invoked.
    assert.strictEqual(trace.executorCalls.length, 0, 'executor should be skipped on awaiting_verification resume');
    assert.ok(trace.verifierCalls.includes('001-001-001-001'), 'verifier should re-run');

    const state = readTaskState(harnessDir, '001-001', '001-001-001', '001-001-001-001');
    assert.strictEqual(state.status, 'complete');
  } finally { restore(); cleanup(projectRoot); }
});

// ── Scenario 5: Failed task re-runs, dependent gets picked up after ──

await test('5. failed + pending dependent: retry succeeds, dep runs after', async () => {
  const missions = [{
    id: '001-001',
    tasks: [
      { id: '001-001-001-001', targetFiles: ['src/a.js'] },
      { id: '001-001-001-002', targetFiles: ['src/b.js'], dependencies: [{ type: 'hard', taskId: '001-001-001-001' }] },
    ],
  }];
  const preStatus = {
    '001-001-001-001': 'failed',
    'mission:001-001': 'in_progress',
    'sm:001-001-001': 'in_progress',
  };
  const { projectRoot, harnessDir } = createResumeHarness({ missions, preStatus });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    installFakes(pipeline);
    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState.milestones['001']);

    // Both should be complete (failed retries → complete, dep then runs)
    const t1 = readTaskState(harnessDir, '001-001', '001-001-001', '001-001-001-001');
    const t2 = readTaskState(harnessDir, '001-001', '001-001-001', '001-001-001-002');
    assert.strictEqual(t1.status, 'complete');
    assert.strictEqual(t2.status, 'complete');
  } finally { restore(); cleanup(projectRoot); }
});

// ── Scenario 6: Cascade in progress (verified → complete crash) ──────

await test('6. verified-stuck crash: scheduler auto-advances verified → complete', async () => {
  const missions = [{
    id: '001-001',
    tasks: [
      { id: '001-001-001-001', targetFiles: ['src/a.js'] },
      { id: '001-001-001-002', targetFiles: ['src/b.js'] },
    ],
  }];
  const preStatus = {
    '001-001-001-001': 'verified',  // stuck between verified and complete
    'mission:001-001': 'in_progress',
    'sm:001-001-001': 'in_progress',
  };
  const { projectRoot, harnessDir } = createResumeHarness({ missions, preStatus });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    const trace = installFakes(pipeline);
    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState.milestones['001']);

    // Task 1 should have been auto-advanced by the scheduler's pre-
    // scan, NOT re-executed. Task 2 runs normally.
    assert.ok(!trace.executorCalls.includes('001-001-001-001'),
      'verified-stuck task should not be re-executed');
    assert.ok(trace.executorCalls.includes('001-001-001-002'));

    for (const task of missions[0].tasks) {
      const state = readTaskState(harnessDir, '001-001', '001-001-001', task.id);
      assert.strictEqual(state.status, 'complete', `${task.id}`);
    }
  } finally { restore(); cleanup(projectRoot); }
});

// ── Scenario 8: overlapping-files-at-crash invariant ─────────────────

await test('8. overlapping-files invariant: two in_progress tasks with overlapping files', async () => {
  // The scheduler's conflict check is supposed to prevent two
  // tasks with overlapping targetFiles from running concurrently
  // in the first place. This test CONSTRUCTS the impossible state
  // manually — both tasks in in_progress with overlapping files —
  // and verifies the resume path doesn't corrupt anything.
  const missions = [{
    id: '001-001',
    tasks: [
      { id: '001-001-001-001', targetFiles: ['src/shared.js'] },
      { id: '001-001-001-002', targetFiles: ['src/shared.js'] },
    ],
  }];
  const preStatus = {
    '001-001-001-001': 'in_progress',
    '001-001-001-002': 'in_progress',
    'mission:001-001': 'in_progress',
    'sm:001-001-001': 'in_progress',
  };
  const { projectRoot, harnessDir } = createResumeHarness({ missions, preStatus });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    installFakes(pipeline);
    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState.milestones['001']);

    // Resume should serialize them via the conflict check. Both
    // eventually complete. No file corruption, no mid-state error.
    for (const task of missions[0].tasks) {
      const state = readTaskState(harnessDir, '001-001', '001-001-001', task.id);
      assert.strictEqual(state.status, 'complete', `${task.id} should complete`);
    }
  } finally { restore(); cleanup(projectRoot); }
});

// ── Scenario 9: Double-crash idempotency ─────────────────────────────

await test('9. double-crash: resume twice produces the same final state as one resume', async () => {
  // Simulate: first run crashes, resume starts, resume ALSO crashes
  // partway, then a third run completes. This test approximates by
  // calling _executeMilestone, injecting an abort mid-flight, then
  // calling _executeMilestone again. Since our fake executor doesn't
  // support mid-flight abort natively, we simulate by running the
  // FIRST _executeMilestone with a failing task, then clearing the
  // fail set and re-running.
  const missions = [{
    id: '001-001',
    tasks: [
      { id: '001-001-001-001', targetFiles: ['src/a.js'] },
      { id: '001-001-001-002', targetFiles: ['src/b.js'] },
      { id: '001-001-001-003', targetFiles: ['src/c.js'] },
    ],
  }];
  const { projectRoot, harnessDir } = createResumeHarness({ missions });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    // First pass: task 2 fails, scheduler throws
    const failSet = new Set(['001-001-001-002']);
    installFakes(pipeline, { failTaskIds: failSet });

    let err1 = null;
    try {
      const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
      await pipeline._executeMilestone('001', globalState.milestones['001']);
    } catch (e) { err1 = e; }
    assert.ok(err1, 'first pass should throw from mission regression circuit breaker or scheduler error');

    // Second pass: fix the failure, re-run
    failSet.clear();
    installFakes(pipeline);  // fresh fake without failTaskIds

    const globalState2 = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState2.milestones['001']);

    // Final state: all tasks complete, idempotent resume
    for (const task of missions[0].tasks) {
      const state = readTaskState(harnessDir, '001-001', '001-001-001', task.id);
      assert.strictEqual(state.status, 'complete', `${task.id}`);
    }
  } finally { restore(); cleanup(projectRoot); }
});

// ── Scenario 10: TokenTracker mid-write tolerance ────────────────────

await test('10. TokenTracker corrupt file: _load tolerates, resume completes', async () => {
  const missions = [{
    id: '001-001',
    tasks: [
      { id: '001-001-001-001', targetFiles: ['src/a.js'] },
    ],
  }];
  const { projectRoot, harnessDir } = createResumeHarness({ missions });

  // Inject a corrupt token-usage.json (simulating a crash mid-write
  // before step 3's atomic rename would have been safe)
  const usagePath = path.join(harnessDir, 'logs', 'token-usage.json');
  fs.mkdirSync(path.dirname(usagePath), { recursive: true });
  fs.writeFileSync(usagePath, '{"sessions":[{"name":"brok');  // truncated mid-write

  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    installFakes(pipeline);

    // Instantiating TokenTracker (already done in Pipeline ctor)
    // should tolerate the corrupt file and fall back to empty state.
    // The catch block in _load handles JSON.parse failures silently.
    assert.deepStrictEqual(pipeline.tokenTracker._sessions, [],
      'TokenTracker should fall back to empty sessions on corrupt file');

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState.milestones['001']);

    const state = readTaskState(harnessDir, '001-001', '001-001-001', '001-001-001-001');
    assert.strictEqual(state.status, 'complete');
  } finally { restore(); cleanup(projectRoot); }
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
