/**
 * test-scheduler-reval-dispatch.js — Scheduler + pipeline integration tests
 * for needs_revalidation tasks in the parallel path.
 *
 * TC1: needs_revalidation + verifier PASS → complete, executor not called
 * TC2: needs_revalidation + verifier FAIL → re-executes → complete
 * TC3: mixed statuses (complete, needs_revalidation, pending) all reach terminal
 *
 * Run: node test/test-scheduler-reval-dispatch.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import config from '../src/orchestrator/infra/config.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';

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
 * status via `preStatus`.
 */
function createResumeHarness({
  milestoneId = '001',
  missions,
  preStatus = {},
}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-reval-'));
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

      // Pre-seed verification sidecar for already-complete tasks.
      // result:'PASSED' mirrors a real verified sidecar — the Phase-5 audit
      // reads parsed.result === 'PASSED' for every complete task.
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

/**
 * Install fake executor/verifier/analyzer on pipeline.
 * verifierFn: optional custom verifyTask implementation — if provided, overrides default.
 */
function installFakes(pipeline, { failTaskIds = new Set(), delay = 5, verifierFn = null } = {}) {
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

  if (verifierFn) {
    pipeline.verifier = {
      verifyTask: async (task, projectRoot, opts) => {
        trace.verifierCalls.push(task.id);
        return verifierFn(task, projectRoot, opts, pipeline);
      },
    };
    // verifyRegression: the regression gates now call the dedicated method;
    // the mock reuses the same implementation (same id-sniff branches apply).
    pipeline.verifier.verifyRegression = pipeline.verifier.verifyTask;
  } else {
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
  }

  pipeline.analyzer = {
    analyzeFailure: async () => ({ eventId: 'fake', recommendation: 'human', affectedTasks: [] }),
  };

  // Stub reviewer for tests exercising _executeMilestone end-to-end. Returns a
  // uniform PASS verdict so milestone reviewer gate proceeds without invoking
  // the real SDK.
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

// ── TC1: needs_revalidation + verifier PASS → complete, executor not called ──

await test('TC1: needs_revalidation task dispatched and verifier-PASS completes', async () => {
  const missionId = '001-001';
  const taskId = '001-001-001-001';
  const missions = [{
    id: missionId,
    tasks: [
      { id: taskId, targetFiles: ['src/a.js'] },
    ],
  }];
  const preStatus = {
    [taskId]: 'needs_revalidation',
    [`mission:${missionId}`]: 'in_progress',
    [`sm:${missionId}-001`]: 'in_progress',
  };

  const { projectRoot, harnessDir } = createResumeHarness({ missions, preStatus });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    // Seed after-snapshot so restoreSnapshot('after') has something to restore
    const afterDir = path.join(harnessDir, 'snapshots', taskId, 'after');
    fs.mkdirSync(path.join(afterDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(afterDir, 'src', 'a.js'), '// modified content\n');

    // Verifier always passes and writes a valid sidecar
    const trace = installFakes(pipeline, {
      verifierFn: (task, _projRoot, _opts, pipe) => {
        // result:'PASSED' mirrors a real verifier so the Phase-5 audit accepts
        // this complete task.
        fs.writeFileSync(
          path.join(pipe.harnessDir, 'verification', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', report: 'pass' })
        );
        return { verified: true, report: 'pass', structured: { verified: true, report: 'pass' } };
      },
    });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState.milestones['001']);

    // Executor should NOT have been called (revalidation path skips executor)
    assert.strictEqual(trace.executorCalls.length, 0,
      `executor should not be called on needs_revalidation PASS, but got: ${trace.executorCalls}`);

    // Verifier SHOULD have been called
    assert.ok(trace.verifierCalls.includes(taskId),
      `verifier should be called for ${taskId}`);

    // Final status should be 'complete'
    const taskState = readTaskState(harnessDir, missionId, `${missionId}-001`, taskId);
    assert.strictEqual(taskState.status, 'complete',
      `expected 'complete', got '${taskState.status}'`);
  } finally { restore(); cleanup(projectRoot); }
});

// ── TC2: needs_revalidation + verifier FAIL → re-executes → complete ─────────

await test('TC2: needs_revalidation task dispatched and verifier-FAIL re-executes', async () => {
  const missionId = '001-001';
  const taskId = '001-001-001-001';
  const missions = [{
    id: missionId,
    tasks: [
      { id: taskId, targetFiles: ['src/b.js'] },
    ],
  }];
  const preStatus = {
    [taskId]: 'needs_revalidation',
    [`mission:${missionId}`]: 'in_progress',
    [`sm:${missionId}-001`]: 'in_progress',
  };

  const { projectRoot, harnessDir } = createResumeHarness({ missions, preStatus });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    // Seed before-snapshot (needed for restoreSnapshot('before') on re-execution)
    const beforeDir = path.join(harnessDir, 'snapshots', taskId, 'before');
    fs.mkdirSync(path.join(beforeDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(beforeDir, 'src', 'b.js'), '// baseline content\n');

    // Verifier: fail on first call, pass on second call
    let callCount = 0;
    const trace = installFakes(pipeline, {
      verifierFn: (task, _projRoot, _opts, pipe) => {
        callCount++;
        if (callCount === 1) {
          // First call: verification fails — no sidecar needed
          return { verified: false, report: 'fail on first try' };
        }
        // Second call: verification passes — write sidecar with result:'PASSED'
        // so the Phase-5 audit accepts this complete task.
        fs.writeFileSync(
          path.join(pipe.harnessDir, 'verification', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', report: 're-exec pass' })
        );
        return { verified: true, report: 're-exec pass', structured: { verified: true, report: 're-exec pass' } };
      },
    });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState.milestones['001']);

    // Executor SHOULD have been called during re-execution
    assert.ok(trace.executorCalls.includes(taskId),
      `executor should be called on re-execution path, but executorCalls=${JSON.stringify(trace.executorCalls)}`);

    // Verifier should have been called at least twice (once for reval, once for re-exec)
    assert.ok(trace.verifierCalls.filter((id) => id === taskId).length >= 2,
      `verifier should be called at least twice, but verifierCalls=${JSON.stringify(trace.verifierCalls)}`);

    // Final status should be 'complete'
    const taskState = readTaskState(harnessDir, missionId, `${missionId}-001`, taskId);
    assert.strictEqual(taskState.status, 'complete',
      `expected 'complete', got '${taskState.status}'`);
  } finally { restore(); cleanup(projectRoot); }
});

// ── TC3: mixed statuses (complete, needs_revalidation, pending) all reach terminal ─

await test('TC3: scheduler does not crash on needs_revalidation status — all 3 reach terminal', async () => {
  const missionId = '001-001';
  const taskId1 = '001-001-001-001';  // complete (pre-terminal)
  const taskId2 = '001-001-001-002';  // needs_revalidation
  const taskId3 = '001-001-001-003';  // pending
  const missions = [{
    id: missionId,
    tasks: [
      { id: taskId1, targetFiles: ['src/c1.js'] },
      { id: taskId2, targetFiles: ['src/c2.js'] },
      { id: taskId3, targetFiles: ['src/c3.js'] },
    ],
  }];
  const preStatus = {
    [taskId1]: 'complete',
    [taskId2]: 'needs_revalidation',
    // taskId3 is pending (default)
    [`mission:${missionId}`]: 'in_progress',
    [`sm:${missionId}-001`]: 'in_progress',
  };

  const { projectRoot, harnessDir } = createResumeHarness({ missions, preStatus });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    // Seed after-snapshot for the needs_revalidation task
    const afterDir = path.join(harnessDir, 'snapshots', taskId2, 'after');
    fs.mkdirSync(path.join(afterDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(afterDir, 'src', 'c2.js'), '// modified c2\n');

    // Standard verifier that passes and writes sidecars
    const trace = installFakes(pipeline, {
      verifierFn: (task, _projRoot, _opts, pipe) => {
        // result:'PASSED' mirrors a real verifier so the Phase-5 audit accepts
        // this complete task.
        fs.writeFileSync(
          path.join(pipe.harnessDir, 'verification', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', report: 'pass' })
        );
        return { verified: true, report: 'pass', structured: { verified: true, report: 'pass' } };
      },
    });

    // Should complete without throwing
    let error = null;
    try {
      const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
      await pipeline._executeMilestone('001', globalState.milestones['001']);
    } catch (e) {
      error = e;
    }

    assert.strictEqual(error, null,
      `scheduler should not throw, but got: ${error?.message}`);

    // taskId1 was pre-complete — should remain complete
    const t1 = readTaskState(harnessDir, missionId, `${missionId}-001`, taskId1);
    assert.strictEqual(t1.status, 'complete', `${taskId1} should be complete, got ${t1.status}`);

    // taskId2 (needs_revalidation) should reach complete
    const t2 = readTaskState(harnessDir, missionId, `${missionId}-001`, taskId2);
    assert.strictEqual(t2.status, 'complete', `${taskId2} should be complete, got ${t2.status}`);

    // taskId3 (pending) should reach complete
    const t3 = readTaskState(harnessDir, missionId, `${missionId}-001`, taskId3);
    assert.strictEqual(t3.status, 'complete', `${taskId3} should be complete, got ${t3.status}`);

    // Executor should NOT have been called for the pre-complete task (taskId1)
    assert.ok(!trace.executorCalls.includes(taskId1),
      `pre-complete task ${taskId1} should not be re-executed`);
  } finally { restore(); cleanup(projectRoot); }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
