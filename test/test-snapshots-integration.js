/**
 * test-snapshots-integration.js — Integration tests for snapshot lifecycle
 * during task execution and verification.
 *
 * Tests the Verification-FAILED path through _executeAndVerifyTask:
 *   TC1. last-failed/ snapshot exists after circuit breaker
 *   TC2. last-failed/ snapshot contains final attempt content (not baseline)
 *   TC3. before/ snapshot exists with baseline content
 *   TC4. after/ snapshot does NOT exist
 *   TC5. project file restored to baseline content after rollback
 *
 * Run: node test/test-snapshots-integration.js
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

// ── Snapshot assertion helpers ────────────────────────────────────────────────

function assertSnapshotExists(harnessDir, taskId, phase, file) {
  const snapshotPath = path.join(harnessDir, 'snapshots', taskId, phase, file);
  assert.ok(
    fs.existsSync(snapshotPath),
    `Expected snapshot to exist at ${snapshotPath}`
  );
}

function assertSnapshotContent(harnessDir, taskId, phase, file, expectedContent) {
  const snapshotPath = path.join(harnessDir, 'snapshots', taskId, phase, file);
  assert.ok(
    fs.existsSync(snapshotPath),
    `Expected snapshot to exist at ${snapshotPath}`
  );
  const actual = fs.readFileSync(snapshotPath, 'utf8');
  assert.strictEqual(
    actual,
    expectedContent,
    `Snapshot ${phase}/${file}: expected "${expectedContent}", got "${actual}"`
  );
}

function assertNoSnapshot(harnessDir, taskId, phase) {
  const snapshotDir = path.join(harnessDir, 'snapshots', taskId, phase);
  assert.ok(
    !fs.existsSync(snapshotDir),
    `Expected snapshot dir to NOT exist at ${snapshotDir}`
  );
}

// ── Harness helpers ───────────────────────────────────────────────────────────

/**
 * Create a minimal .harness directory suitable for Pipeline snapshot tests.
 * Mirrors the pattern from test-infra-error.js (createPipelineHarness).
 */
function createPipelineHarness({
  milestoneId = '001',
  missionId = '001-001',
  subMissionId = '001-001-001',
  taskId = '001-001-001-001',
  taskStatus = 'pending',
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-snap-test-'));
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

// ══════════════════════════════════════════════════════════════════════════════
// Verification-FAILED path — circuit breaker on first failure (maxRetries=0)
// ══════════════════════════════════════════════════════════════════════════════

await test(
  'Verification-FAILED path: all 5 snapshot assertions (TC1–TC5)',
  async () => {
    const taskId = '001-001-001-001';
    const missionId = '001-001';
    const subMissionId = '001-001-001';
    const targetFile = 'a.js';
    const baselineContent = '// a.js\n';
    const attemptContent = 'attempt-1-content';

    const { projectRoot, harnessDir } = createPipelineHarness({ taskStatus: 'pending' });

    // Save original maxRetries and set to 0 so circuit breaker fires on first failure
    const originalMaxRetries = config.maxRetries;
    config.maxRetries = 0;

    try {
      const pipeline = makePipelineNoAuth(projectRoot);

      // Mock executor: write attempt content to target file, return OK
      pipeline.executor = {
        executeTask: async (_task, projRoot, _opts) => {
          fs.writeFileSync(path.join(projRoot, targetFile), attemptContent);
          return { status: 'OK' };
        },
      };

      // Mock verifier: always returns verified:false
      pipeline.verifier = {
        verifyTask: async (_task, _projRoot, _opts) => {
          return { verified: false };
        },
      };

      // Mock _dispatchAnalyzer to prevent actual AI calls
      pipeline._dispatchAnalyzer = async () => {};

      const task = {
        id: taskId,
        missionId,
        subMissionId,
        targetFiles: [targetFile],
        description: 'test task',
      };

      // Run the task — circuit breaker should trigger after one attempt
      await pipeline._executeAndVerifyTask(missionId, subMissionId, task);

      // TC1: last-failed/ snapshot exists after circuit breaker
      assertSnapshotExists(harnessDir, taskId, 'last-failed', targetFile);

      // TC2: last-failed/ snapshot contains final attempt content (not baseline)
      assertSnapshotContent(harnessDir, taskId, 'last-failed', targetFile, attemptContent);

      // TC3: before/ snapshot exists with baseline content
      assertSnapshotContent(harnessDir, taskId, 'before', targetFile, baselineContent);

      // TC4: after/ snapshot does NOT exist (verification never passed)
      assertNoSnapshot(harnessDir, taskId, 'after');

      // TC5: project file restored to baseline content after rollback
      const restoredContent = fs.readFileSync(path.join(projectRoot, targetFile), 'utf8');
      assert.strictEqual(
        restoredContent,
        baselineContent,
        `Expected project file to be restored to baseline, got "${restoredContent}"`
      );
    } finally {
      // Restore config.maxRetries so other tests are not affected
      config.maxRetries = originalMaxRetries;
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// Executor-BLOCKED path — circuit breaker on BLOCKED result (maxRetries=0)
// ══════════════════════════════════════════════════════════════════════════════

await test(
  'Executor-BLOCKED path: last-failed/ exists, before/ has baseline, after/ absent, project restored (TC1–TC4)',
  async () => {
    const taskId = '001-001-001-001';
    const missionId = '001-001';
    const subMissionId = '001-001-001';
    const targetFile = 'a.js';
    const baselineContent = '// a.js\n';
    const blockedContent = 'blocked-attempt-content';

    const { projectRoot, harnessDir } = createPipelineHarness({ taskStatus: 'pending' });

    const originalMaxRetries = config.maxRetries;
    config.maxRetries = 0;

    try {
      const pipeline = makePipelineNoAuth(projectRoot);

      // Mock executor: write content to target file, return BLOCKED
      pipeline.executor = {
        executeTask: async (_task, projRoot, _opts) => {
          fs.writeFileSync(path.join(projRoot, targetFile), blockedContent);
          return { status: 'BLOCKED' };
        },
      };

      // Mock _dispatchAnalyzer to no-op (prevent actual AI calls)
      pipeline._dispatchAnalyzer = async () => {};

      const task = {
        id: taskId,
        missionId,
        subMissionId,
        targetFiles: [targetFile],
        description: 'test task',
      };

      // Run the task — circuit breaker should trigger after one attempt
      await pipeline._executeAndVerifyTask(missionId, subMissionId, task);

      // TC1: last-failed/ snapshot exists after circuit breaker
      assertSnapshotExists(harnessDir, taskId, 'last-failed', targetFile);

      // TC2: before/ snapshot has baseline content
      assertSnapshotContent(harnessDir, taskId, 'before', targetFile, baselineContent);

      // TC3: after/ snapshot does NOT exist (executor never passed verification)
      assertNoSnapshot(harnessDir, taskId, 'after');

      // TC4: project file restored to baseline content after rollback
      const restoredContent = fs.readFileSync(path.join(projectRoot, targetFile), 'utf8');
      assert.strictEqual(
        restoredContent,
        baselineContent,
        `Expected project file to be restored to baseline, got "${restoredContent}"`
      );
    } finally {
      // Restore config.maxRetries so other tests are not affected
      config.maxRetries = originalMaxRetries;
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// Revalidation-FAILED path — verifier returns false for needs_revalidation task
// ══════════════════════════════════════════════════════════════════════════════

await test(
  'Revalidation-FAILED path: last-failed/ exists, before/ has baseline, project restored (TC5–TC7)',
  async () => {
    const taskId = '001-001-001-001';
    const missionId = '001-001';
    const subMissionId = '001-001-001';
    const targetFile = 'a.js';
    const baselineContent = '// a.js\n';
    const afterContent = '// after-snapshot-content\n';

    const { projectRoot, harnessDir } = createPipelineHarness({ taskStatus: 'needs_revalidation' });

    // maxRetries=0 so the recursive re-execute terminates at the circuit
    // breaker (executor returns BLOCKED) instead of looping.
    const originalMaxRetries = config.maxRetries;
    config.maxRetries = 0;

    try {
      // Create before/ snapshot manually with baseline content
      const beforeSnapshotDir = path.join(harnessDir, 'snapshots', taskId, 'before');
      fs.mkdirSync(beforeSnapshotDir, { recursive: true });
      fs.writeFileSync(path.join(beforeSnapshotDir, targetFile), baselineContent);

      // Create after/ snapshot manually with post-execution content. The live
      // needs_revalidation branch restores from after/ (pipeline.js: restoreSnapshot
      // 'after') BEFORE the verifier runs, then on revalidation FAIL restores from
      // before/, so both snapshots must be seeded.
      const afterSnapshotDir = path.join(harnessDir, 'snapshots', taskId, 'after');
      fs.mkdirSync(afterSnapshotDir, { recursive: true });
      fs.writeFileSync(path.join(afterSnapshotDir, targetFile), afterContent);

      const pipeline = makePipelineNoAuth(projectRoot);

      const logs = [];
      pipeline.onLog = (m) => logs.push(m);

      // Mock verifier: always returns verified:false → revalidation FAILS on the
      // first pass.
      pipeline.verifier = {
        verifyTask: async (_task, _projRoot, _opts) => {
          return { verified: false };
        },
      };

      // The revalidation-FAIL branch re-executes the task (recursive
      // _executeAndVerifyTask). We cannot no-op the method under test, so supply
      // an executor that returns BLOCKED; with maxRetries=0 the recursive second
      // pass hits the circuit breaker and terminates.
      pipeline.executor = {
        executeTask: async (_task, _projRoot, _opts) => {
          return { status: 'BLOCKED' };
        },
      };

      // No-op the analyzer the circuit breaker dispatches (prevent AI calls).
      pipeline._dispatchAnalyzer = async () => {};

      const task = {
        id: taskId,
        missionId,
        subMissionId,
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

      // The revalidation FAILED → re-executing log fired on the first pass.
      assert.ok(
        logs.some((l) => /revalidation FAILED/i.test(l)),
        `expected a 'revalidation FAILED' log, got: ${logs.slice(-8).join('\n')}`
      );

      // TC5: last-failed/ snapshot exists after revalidation failure
      assertSnapshotExists(harnessDir, taskId, 'last-failed', targetFile);

      // TC6: before/ snapshot has baseline content
      assertSnapshotContent(harnessDir, taskId, 'before', targetFile, baselineContent);

      // TC7: project file restored to baseline content after rollback
      const restoredContent = fs.readFileSync(path.join(projectRoot, targetFile), 'utf8');
      assert.strictEqual(
        restoredContent,
        baselineContent,
        `Expected project file to be restored to baseline, got "${restoredContent}"`
      );
    } finally {
      config.maxRetries = originalMaxRetries;
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
