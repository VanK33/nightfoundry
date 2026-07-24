/**
 * test-firstwrite-skip-executor.js — Tests for the conditional firstWrite flag
 * passed to verifier.verifyTask depending on skipExecutor logic in
 * _executeAndVerifyTask.
 *
 * TC-FW-SKIP:               task pre-seeded at awaiting_verification → skipExecutor=true
 *                            → firstWrite=false passed to verifier
 * TC-FW-NORMAL:             task at pending status → skipExecutor=false, preExecStatus==='pending'
 *                            → firstWrite=true passed to verifier
 * TC-FW-FAILED-EXEC:        failed task passes firstWrite=false to executor execContext
 * TC-FW-FAILED-VERIFY:      failed task passes firstWrite=false to verifier opts
 * TC-FW-INPROGRESS:         in_progress task passes firstWrite=false to executor execContext
 * TC-FW-PENDING-COLLISION:  pending task with pre-existing progress sidecar throws SidecarReuseError
 *
 * Run: node test/test-firstwrite-skip-executor.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
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

// ── Harness helpers ───────────────────────────────────────────────────────────

/**
 * Create a minimal .harness directory suitable for firstWrite/skipExecutor tests.
 */
function createPipelineHarness({
  milestoneId = '001',
  missionId = '001-001',
  subMissionId = '001-001-001',
  taskId = '001-001-001-001',
  taskStatus = 'pending',
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-fw-test-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  // Create target file in projectRoot
  const targetFile = 'a.js';
  fs.writeFileSync(path.join(projectRoot, targetFile), '// a.js\n');

  // Write verify.json
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

  return { projectRoot, harnessDir, taskId, missionId, subMissionId, targetFile };
}

/**
 * Create a Pipeline instance with worktree disabled and review skipped.
 */
function makePipelineNoAuth(projectRoot, { onLog = () => {} } = {}) {
  return new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    onLog,
    onConfirm: async () => true,
    noReview: true,
    skipReview: true,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// TC-FW-SKIP: awaiting_verification resume passes firstWrite=false to verifier
// ══════════════════════════════════════════════════════════════════════════════

await test(
  'TC-FW-SKIP: awaiting_verification resume passes firstWrite=false to verifier',
  async () => {
    const { projectRoot, harnessDir, taskId, missionId, subMissionId, targetFile } =
      createPipelineHarness({ taskStatus: 'awaiting_verification' });

    try {
      // Pre-seed a verification sidecar on disk (simulates previous partial run)
      fs.writeFileSync(
        path.join(harnessDir, 'verification', `task-${taskId}.json`),
        JSON.stringify({ taskId, result: 'PASSED', notes: 'pre-existing' })
      );

      const pipeline = makePipelineNoAuth(projectRoot);

      // Capture the opts passed to verifyTask
      let capturedOpts = null;
      pipeline.verifier = {
        verifyTask: async (task, _projRoot, opts) => {
          capturedOpts = opts;
          // Write verification sidecar (required for 'verified' transition)
          fs.writeFileSync(
            path.join(harnessDir, 'verification', `task-${task.id}.json`),
            JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', notes: 'mock' })
          );
          return { verified: true };
        },
      };

      const task = {
        id: taskId,
        description: 'test task',
        targetFiles: [targetFile],
        dependencies: [],
        testCases: [],
        tracesScenario: [],
        patternReferences: [],
        dataSchemas: [],
      };

      await pipeline._executeAndVerifyTask(missionId, subMissionId, task, 0);

      assert.ok(capturedOpts !== null, 'verifyTask should have been called');
      assert.strictEqual(
        capturedOpts.firstWrite,
        false,
        `expected firstWrite=false for awaiting_verification resume, got ${capturedOpts.firstWrite}`
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// TC-FW-NORMAL: normal pending execution passes firstWrite=true when preExecStatus==='pending'
// ══════════════════════════════════════════════════════════════════════════════

await test(
  'TC-FW-NORMAL: normal execution passes firstWrite=true when preExecStatus===\'pending\'',
  async () => {
    const { projectRoot, harnessDir, taskId, missionId, subMissionId, targetFile } =
      createPipelineHarness({ taskStatus: 'pending' });

    try {
      const pipeline = makePipelineNoAuth(projectRoot);

      // Mock executor to return a non-COMPLETED, non-BLOCKED status so the
      // phantom-write guard is skipped (it only fires on exact 'COMPLETED').
      // This lets execution fall through to the verifier normally.
      pipeline.executor = {
        executeTask: async (_task, _projRoot, _execCtx) => {
          return { status: 'MOCK_DONE', affectedFiles: [], summary: 'mock executor' };
        },
      };

      // Capture the opts passed to verifyTask
      let capturedOpts = null;
      pipeline.verifier = {
        verifyTask: async (task, _projRoot, opts) => {
          capturedOpts = opts;
          // Write verification sidecar (required for 'verified' transition)
          fs.writeFileSync(
            path.join(harnessDir, 'verification', `task-${task.id}.json`),
            JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', notes: 'mock' })
          );
          return { verified: true };
        },
      };

      const task = {
        id: taskId,
        description: 'test task',
        targetFiles: [targetFile],
        dependencies: [],
        testCases: [],
        tracesScenario: [],
        patternReferences: [],
        dataSchemas: [],
      };

      await pipeline._executeAndVerifyTask(missionId, subMissionId, task, 0);

      assert.ok(capturedOpts !== null, 'verifyTask should have been called');
      assert.strictEqual(
        capturedOpts.firstWrite,
        true,
        `expected firstWrite=true for pending task with preExecStatus==='pending', got ${capturedOpts.firstWrite}`
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// TC-FW-FAILED-EXEC: failed task passes firstWrite=false to executor
// ══════════════════════════════════════════════════════════════════════════════

await test(
  'TC-FW-FAILED-EXEC: failed task passes firstWrite=false to executor execContext',
  async () => {
    const { projectRoot, harnessDir, taskId, missionId, subMissionId, targetFile } =
      createPipelineHarness({ taskStatus: 'failed' });

    try {
      const pipeline = makePipelineNoAuth(projectRoot);

      let capturedExecCtx = null;
      pipeline.executor = {
        executeTask: async (_task, _projRoot, execCtx) => {
          capturedExecCtx = execCtx;
          return { status: 'MOCK_DONE', affectedFiles: [], summary: 'mock' };
        },
      };

      pipeline.verifier = {
        verifyTask: async (task, _projRoot, _opts) => {
          fs.writeFileSync(
            path.join(harnessDir, 'verification', `task-${task.id}.json`),
            JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', notes: 'mock' })
          );
          return { verified: true };
        },
      };

      const task = {
        id: taskId,
        description: 'test task',
        targetFiles: [targetFile],
        dependencies: [],
        testCases: [],
        tracesScenario: [],
        patternReferences: [],
        dataSchemas: [],
      };

      await pipeline._executeAndVerifyTask(missionId, subMissionId, task, 0);

      assert.ok(capturedExecCtx !== null, 'executeTask should have been called');
      assert.strictEqual(
        capturedExecCtx.firstWrite,
        false,
        `expected firstWrite=false for failed task, got ${capturedExecCtx.firstWrite}`
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// TC-FW-FAILED-VERIFY: failed task passes firstWrite=false to verifier
// ══════════════════════════════════════════════════════════════════════════════

await test(
  'TC-FW-FAILED-VERIFY: failed task passes firstWrite=false to verifier opts',
  async () => {
    const { projectRoot, harnessDir, taskId, missionId, subMissionId, targetFile } =
      createPipelineHarness({ taskStatus: 'failed' });

    try {
      const pipeline = makePipelineNoAuth(projectRoot);

      pipeline.executor = {
        executeTask: async (_task, _projRoot, _execCtx) => {
          return { status: 'MOCK_DONE', affectedFiles: [], summary: 'mock' };
        },
      };

      let capturedOpts = null;
      pipeline.verifier = {
        verifyTask: async (task, _projRoot, opts) => {
          capturedOpts = opts;
          fs.writeFileSync(
            path.join(harnessDir, 'verification', `task-${task.id}.json`),
            JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', notes: 'mock' })
          );
          return { verified: true };
        },
      };

      const task = {
        id: taskId,
        description: 'test task',
        targetFiles: [targetFile],
        dependencies: [],
        testCases: [],
        tracesScenario: [],
        patternReferences: [],
        dataSchemas: [],
      };

      await pipeline._executeAndVerifyTask(missionId, subMissionId, task, 0);

      assert.ok(capturedOpts !== null, 'verifyTask should have been called');
      assert.strictEqual(
        capturedOpts.firstWrite,
        false,
        `expected firstWrite=false for failed task, got ${capturedOpts.firstWrite}`
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// TC-FW-INPROGRESS: in_progress task passes firstWrite=false to executor
// ══════════════════════════════════════════════════════════════════════════════

await test(
  'TC-FW-INPROGRESS: in_progress task passes firstWrite=false to executor execContext',
  async () => {
    const { projectRoot, harnessDir, taskId, missionId, subMissionId, targetFile } =
      createPipelineHarness({ taskStatus: 'in_progress' });

    try {
      const pipeline = makePipelineNoAuth(projectRoot);

      let capturedExecCtx = null;
      pipeline.executor = {
        executeTask: async (_task, _projRoot, execCtx) => {
          capturedExecCtx = execCtx;
          return { status: 'MOCK_DONE', affectedFiles: [], summary: 'mock' };
        },
      };

      pipeline.verifier = {
        verifyTask: async (task, _projRoot, _opts) => {
          fs.writeFileSync(
            path.join(harnessDir, 'verification', `task-${task.id}.json`),
            JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', notes: 'mock' })
          );
          return { verified: true };
        },
      };

      const task = {
        id: taskId,
        description: 'test task',
        targetFiles: [targetFile],
        dependencies: [],
        testCases: [],
        tracesScenario: [],
        patternReferences: [],
        dataSchemas: [],
      };

      await pipeline._executeAndVerifyTask(missionId, subMissionId, task, 0);

      assert.ok(capturedExecCtx !== null, 'executeTask should have been called');
      assert.strictEqual(
        capturedExecCtx.firstWrite,
        false,
        `expected firstWrite=false for in_progress task, got ${capturedExecCtx.firstWrite}`
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// TC-FW-PENDING-COLLISION: pending task with pre-existing progress sidecar throws SidecarReuseError
// ══════════════════════════════════════════════════════════════════════════════

await test(
  'TC-FW-PENDING-COLLISION: pending task with pre-existing progress sidecar throws SidecarReuseError',
  async () => {
    const { projectRoot, harnessDir, taskId, missionId, subMissionId, targetFile } =
      createPipelineHarness({ taskStatus: 'pending' });

    try {
      // Pre-seed a progress sidecar (simulates task-id reuse / collision)
      fs.writeFileSync(
        path.join(harnessDir, 'progress', 'task-' + taskId + '.json'),
        JSON.stringify({ taskId, status: 'COMPLETED' })
      );

      const { SidecarReuseError } = await import('../src/orchestrator/core/sidecar-reuse-error.js');

      const pipeline = makePipelineNoAuth(projectRoot);

      pipeline.executor = {
        executeTask: async (_task, projRoot, execCtx) => {
          const { extractProgress } = await import('../src/orchestrator/agents/executor.js');
          return extractProgress({ result: [] }, _task.id, path.join(projRoot, '.harness'), { firstWrite: execCtx.firstWrite });
        },
      };

      pipeline.verifier = {
        verifyTask: async (task, _projRoot, _opts) => {
          fs.writeFileSync(
            path.join(harnessDir, 'verification', `task-${task.id}.json`),
            JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', notes: 'mock' })
          );
          return { verified: true };
        },
      };

      const task = {
        id: taskId,
        description: 'test task',
        targetFiles: [targetFile],
        dependencies: [],
        testCases: [],
        tracesScenario: [],
        patternReferences: [],
        dataSchemas: [],
      };

      let caughtErr = null;
      try {
        await pipeline._executeAndVerifyTask(missionId, subMissionId, task, 0);
      } catch (err) {
        caughtErr = err;
      }

      assert.ok(caughtErr !== null, 'expected an error to be thrown');
      assert.ok(
        caughtErr instanceof SidecarReuseError,
        `expected instanceof SidecarReuseError, got ${caughtErr?.constructor?.name}`
      );
      assert.strictEqual(
        caughtErr.name,
        'SidecarReuseError',
        `expected err.name === 'SidecarReuseError', got '${caughtErr.name}'`
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
