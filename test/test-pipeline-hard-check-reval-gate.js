/**
 * test-pipeline-hard-check-reval-gate.js — Integration tests for the hardCheck
 * gate in the needs_revalidation branch of _executeAndVerifyTask.
 *
 * TC-HCRG-1: revalidation + hardCheck passes → task complete
 * TC-HCRG-2: revalidation + hardCheck fails → task failed, re-execution triggered
 * TC-HCRG-3: revalidation + verify.json missing → gate skipped, task completes
 *
 * Run: node test/test-pipeline-hard-check-reval-gate.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import config from '../src/orchestrator/infra/config.js';

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
 * Create a minimal .harness directory suitable for Pipeline revalidation tests.
 *
 * @param {object} opts
 * @param {string}   opts.milestoneId     - defaults to '001'
 * @param {string}   opts.missionId       - defaults to '001-001'
 * @param {string}   opts.subMissionId    - defaults to '001-001-001'
 * @param {string}   opts.taskId          - defaults to '001-001-001-001'
 * @param {string}   opts.taskStatus      - defaults to 'pending'
 * @param {boolean}  opts.writeVerifyJson - whether to write verify.json (default true)
 * @param {Array}    opts.hardChecks      - hardChecks array for verify.json (default [])
 */
function createPipelineHarness({
  milestoneId = '001',
  missionId = '001-001',
  subMissionId = '001-001-001',
  taskId = '001-001-001-001',
  taskStatus = 'pending',
  writeVerifyJson = true,
  hardChecks = [],
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-hcrg-test-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  // Create target file in projectRoot so snapshotFiles can copy it
  const targetFile = 'a.js';
  fs.writeFileSync(path.join(projectRoot, targetFile), '// a.js\n');

  // Optionally write verify.json that runHardChecks reads
  if (writeVerifyJson) {
    fs.writeFileSync(
      path.join(harnessDir, 'verify', `task-${taskId}.json`),
      JSON.stringify({ taskId, targetFiles: [targetFile], hardChecks, testCases: [] })
    );
  }

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
 * Create a Pipeline instance with worktree disabled and review skipped,
 * suitable for in-process integration tests. Accepts optional onLog callback
 * to capture log messages for assertion.
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
// TC-HCRG-1: revalidation + hardCheck passes → task complete
// ══════════════════════════════════════════════════════════════════════════════

await test(
  'TC-HCRG-1: revalidation + hardCheck passes → task complete',
  async () => {
    const { projectRoot, harnessDir, taskId, missionId, subMissionId, targetFile } =
      createPipelineHarness({
        taskStatus: 'needs_revalidation',
        hardChecks: [{ name: 'ok', command: 'true' }],
      });

    try {
      const pipeline = makePipelineNoAuth(projectRoot);

      // Mock verifier: writes verification sidecar (required for 'verified' transition)
      // and returns verified:true
      pipeline.verifier = {
        verifyTask: async (task, _projRoot, _opts) => {
          fs.writeFileSync(
            path.join(harnessDir, 'verification', `task-${task.id}.json`),
            JSON.stringify({ taskId: task.id, verified: true, report: 'ok' })
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

      // Drive the live revalidation path directly through _executeAndVerifyTask
      // on a needs_revalidation task.
      await pipeline._executeAndVerifyTask(missionId, subMissionId, task);

      // Assert task status is 'complete'
      const ms = JSON.parse(
        fs.readFileSync(
          path.join(harnessDir, 'state', `mission-${missionId}.json`),
          'utf8'
        )
      );
      const taskState = ms.subMissions[subMissionId].tasks[taskId];
      assert.strictEqual(
        taskState.status,
        'complete',
        `expected task status 'complete', got '${taskState.status}'`
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// TC-HCRG-2: revalidation + hardCheck fails → task failed, re-execution triggered
// ══════════════════════════════════════════════════════════════════════════════

await test(
  'TC-HCRG-2: revalidation + hardCheck fails → task failed, re-execution triggered',
  async () => {
    const logs = [];
    const { projectRoot, harnessDir, taskId, missionId, subMissionId, targetFile } =
      createPipelineHarness({
        taskStatus: 'needs_revalidation',
        hardChecks: [{ name: 'fail', command: 'false' }],
      });

    // maxRetries=0 so the recursive re-execute (revalidation FAIL → re-execute)
    // terminates at the circuit breaker rather than looping.
    const origMaxRetries = config.maxRetries;
    config.maxRetries = 0;
    try {
      // Create before/ snapshot so _captureLastFailed and restoreSnapshot work
      const beforeSnapshotDir = path.join(harnessDir, 'snapshots', taskId, 'before');
      fs.mkdirSync(beforeSnapshotDir, { recursive: true });
      fs.writeFileSync(path.join(beforeSnapshotDir, targetFile), '// baseline\n');

      const pipeline = makePipelineNoAuth(projectRoot, { onLog: (msg) => logs.push(msg) });

      // Mock verifier: returns verified:true (hardCheck gate will override to false)
      pipeline.verifier = {
        verifyTask: async (_task, _projRoot, _opts) => {
          return { verified: true };
        },
      };

      // The revalidation-FAIL branch re-executes the task (recursive
      // _executeAndVerifyTask). We cannot no-op the method under test, so supply
      // an executor that returns BLOCKED; with maxRetries=0 the recursive second
      // pass hits the circuit breaker and terminates.
      pipeline.executor = {
        executeTask: async (_task, _projRoot, _opts) => ({ status: 'BLOCKED' }),
      };
      // No-op the analyzer the circuit breaker dispatches (prevent AI calls).
      pipeline._dispatchAnalyzer = async () => {};

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

      // Drive the live revalidation path directly through _executeAndVerifyTask
      // on a needs_revalidation task.
      await pipeline._executeAndVerifyTask(missionId, subMissionId, task);

      // Assert task transitioned through 'failed'
      const ms = JSON.parse(
        fs.readFileSync(
          path.join(harnessDir, 'state', `mission-${missionId}.json`),
          'utf8'
        )
      );
      const taskState = ms.subMissions[subMissionId].tasks[taskId];
      assert.strictEqual(
        taskState.status,
        'failed',
        `expected task status 'failed', got '${taskState.status}'`
      );

      // Assert logs contain 'hard-check gate FAILED'
      assert.ok(
        logs.some((l) => l.includes('hard-check gate FAILED')),
        `expected a log line containing 'hard-check gate FAILED', got:\n${logs.slice(-10).join('\n')}`
      );
    } finally {
      config.maxRetries = origMaxRetries;
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// TC-HCRG-3: revalidation + verify.json missing → gate fail-closed, NOT complete
// ══════════════════════════════════════════════════════════════════════════════
//
// Was previously asserted as fail-OPEN (task completes, "gate skipped").
// Post-fix BEHAVIOR 1 (revalidation path): a missing verify.json must make the
// FINAL revalidation result FAILED — the verifier's PASS must not pass through.

await test(
  'TC-HCRG-3: revalidation + verify.json missing → gate fail-closed, task does NOT complete',
  async () => {
    const logs = [];
    const { projectRoot, harnessDir, taskId, missionId, subMissionId, targetFile } =
      createPipelineHarness({
        taskStatus: 'needs_revalidation',
        writeVerifyJson: false,
      });

    // The revalidation-FAIL branch re-executes the task recursively; cap retries
    // at 0 so the recursive pass terminates at the circuit breaker.
    const origMaxRetries = config.maxRetries;
    config.maxRetries = 0;
    try {
      // before/ snapshot so _captureLastFailed / restoreSnapshot work on the
      // FAIL → re-execute path.
      const beforeSnapshotDir = path.join(harnessDir, 'snapshots', taskId, 'before');
      fs.mkdirSync(beforeSnapshotDir, { recursive: true });
      fs.writeFileSync(path.join(beforeSnapshotDir, targetFile), '// baseline\n');

      const pipeline = makePipelineNoAuth(projectRoot, { onLog: (msg) => logs.push(msg) });

      // Mock verifier: returns verified:true (gate must override to false).
      pipeline.verifier = {
        verifyTask: async (task, _projRoot, _opts) => {
          fs.writeFileSync(
            path.join(harnessDir, 'verification', `task-${task.id}.json`),
            JSON.stringify({ taskId: task.id, verified: true, report: 'ok' })
          );
          return { verified: true };
        },
      };
      // Re-execution returns BLOCKED so the recursive pass hits the breaker.
      pipeline.executor = {
        executeTask: async (_task, _projRoot, _opts) => ({ status: 'BLOCKED' }),
      };
      pipeline._dispatchAnalyzer = async () => {};

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

      // Drive the live revalidation path directly through _executeAndVerifyTask
      // on a needs_revalidation task.
      await pipeline._executeAndVerifyTask(missionId, subMissionId, task);

      // Assert task did NOT reach 'complete' (fail-closed).
      const ms = JSON.parse(
        fs.readFileSync(
          path.join(harnessDir, 'state', `mission-${missionId}.json`),
          'utf8'
        )
      );
      const taskState = ms.subMissions[subMissionId].tasks[taskId];
      assert.notStrictEqual(
        taskState.status,
        'complete',
        `expected revalidation task NOT 'complete' (fail-closed on missing verify.json), got '${taskState.status}'`
      );
    } finally {
      config.maxRetries = origMaxRetries;
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// TC-HCRG-4: revalidation + verify.json present + hardCheck passes → complete
// ══════════════════════════════════════════════════════════════════════════════
//
// Positive regression guard for the revalidation path: with verify.json present
// and a passing hardCheck, the fail-closed change must NOT break the happy path.

await test(
  'TC-HCRG-4: revalidation + verify.json present + hardCheck passes → task complete (no regression)',
  async () => {
    const { projectRoot, harnessDir, taskId, missionId, subMissionId, targetFile } =
      createPipelineHarness({
        taskStatus: 'needs_revalidation',
        hardChecks: [{ name: 'ok', command: 'true' }],
      });

    try {
      const pipeline = makePipelineNoAuth(projectRoot);

      pipeline.verifier = {
        verifyTask: async (task, _projRoot, _opts) => {
          fs.writeFileSync(
            path.join(harnessDir, 'verification', `task-${task.id}.json`),
            JSON.stringify({ taskId: task.id, verified: true, report: 'ok' })
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

      await pipeline._executeAndVerifyTask(missionId, subMissionId, task);

      const ms = JSON.parse(
        fs.readFileSync(
          path.join(harnessDir, 'state', `mission-${missionId}.json`),
          'utf8'
        )
      );
      const taskState = ms.subMissions[subMissionId].tasks[taskId];
      assert.strictEqual(
        taskState.status,
        'complete',
        `expected revalidation task 'complete' on happy path, got '${taskState.status}'`
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
