/**
 * test-pipeline-wall-clock.js — Unit tests for WallClockExceededError routing in Pipeline.
 *
 * Tests cover:
 *   TC1. executor WallClockExceededError routes to _dispatchAnalyzer with failureType 'execution'
 *   TC2. verifier WallClockExceededError routes to _dispatchAnalyzer with failureType 'verification'
 *   TC3. InfrastructureError still re-throws from executor catch block
 *   TC4. WallClockExceededError is not instanceof InfrastructureError
 *
 * Run: node test/test-pipeline-wall-clock.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { WallClockExceededError, InfrastructureError } from '../src/orchestrator/infra/session-manager.js';

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

function createMinimalHarness() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-clock-unit-'));
  const harnessDir = path.join(projectRoot, '.harness');

  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'snapshots'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'analysis'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'plan'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'verify'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'progress'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });

  const state = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {},
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  // Write the mission state file that transitionTask reads.
  // readTaskStatus reads state/mission-{missionId}.json (not a per-task file).
  // The task starts at 'in_progress' so that the transition to
  // 'awaiting_verification' is valid (in_progress → awaiting_verification).
  const taskId = '001-001-001-001';
  const missionStateFile = path.join(harnessDir, 'state', 'mission-001-001.json');
  const missionState = {
    id: '001-001',
    subMissions: {
      '001-001-001': {
        id: '001-001-001',
        tasks: {
          [taskId]: {
            id: taskId,
            description: 'Test task',
            status: 'in_progress',
            targetFiles: ['src/a.js'],
            dependencies: [],
          },
        },
      },
    },
  };
  fs.writeFileSync(missionStateFile, JSON.stringify(missionState, null, 2));

  return { projectRoot, harnessDir };
}

function makePipeline(projectRoot) {
  const pipeline = new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    onLog: () => {},
    onConfirm: async () => true,
    noReview: true,
    skipReview: true,
  });
  return pipeline;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// A minimal task object used across all tests
const baseTask = {
  id: '001-001-001-001',
  missionId: '001-001',
  subMissionId: '001-001-001',
  description: 'Test task',
  targetFiles: ['src/a.js'],
};

// ── TC1: executor WallClockExceededError routes to _dispatchAnalyzer ──────────

await test('TC1: executor WallClockExceededError routes to _dispatchAnalyzer with failureType execution', async () => {
  const { projectRoot } = createMinimalHarness();
  try {
    const pipeline = makePipeline(projectRoot);

    // Mock executor to throw WallClockExceededError
    pipeline.executor = {
      executeTask: async () => {
        throw new WallClockExceededError('timeout');
      },
    };

    // Capture _dispatchAnalyzer calls
    const dispatchCalls = [];
    pipeline._dispatchAnalyzer = async (task, failureType, retryCount) => {
      dispatchCalls.push({ task, failureType, retryCount });
    };

    // Mock statusBar to avoid undefined errors
    pipeline.statusBar = {
      updateAgent: () => {},
      teardown: () => {},
    };

    // Mock tokenTracker
    pipeline.tokenTracker = {
      getUsageByType: () => ({ totalCostUsd: 0 }),
    };

    // Should NOT throw
    let threw = false;
    try {
      await pipeline._executeAndVerifyTask(baseTask.missionId, baseTask.subMissionId, baseTask);
    } catch (_) {
      threw = true;
    }

    assert.ok(!threw, '_executeAndVerifyTask should NOT throw when WallClockExceededError is caught');
    assert.equal(dispatchCalls.length, 1, '_dispatchAnalyzer should have been called once');
    assert.equal(dispatchCalls[0].failureType, 'execution', 'failureType should be "execution"');
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC2: verifier WallClockExceededError routes to _dispatchAnalyzer ──────────

await test('TC2: verifier WallClockExceededError routes to _dispatchAnalyzer with failureType verification', async () => {
  const { projectRoot } = createMinimalHarness();
  try {
    const pipeline = makePipeline(projectRoot);

    // Mock executor to succeed — use a non-'COMPLETED' status string to avoid
    // the phantom-write assertChangesLanded guard which compares on-disk
    // checksums (the production guard is gated on the exact word 'COMPLETED').
    pipeline.executor = {
      executeTask: async () => ({ status: 'DONE', affectedFiles: [] }),
    };

    // Mock verifier to throw WallClockExceededError
    pipeline.verifier = {
      verifyTask: async () => {
        throw new WallClockExceededError('timeout');
      },
    };

    // Capture _dispatchAnalyzer calls
    const dispatchCalls = [];
    pipeline._dispatchAnalyzer = async (task, failureType, retryCount) => {
      dispatchCalls.push({ task, failureType, retryCount });
    };

    // Mock statusBar
    pipeline.statusBar = {
      updateAgent: () => {},
      teardown: () => {},
    };

    // Mock tokenTracker
    pipeline.tokenTracker = {
      getUsageByType: () => ({ totalCostUsd: 0 }),
    };

    // Should NOT throw
    let threw = false;
    try {
      await pipeline._executeAndVerifyTask(baseTask.missionId, baseTask.subMissionId, baseTask);
    } catch (_) {
      threw = true;
    }

    assert.ok(!threw, '_executeAndVerifyTask should NOT throw when verifier WallClockExceededError is caught');
    assert.equal(dispatchCalls.length, 1, '_dispatchAnalyzer should have been called once');
    assert.equal(dispatchCalls[0].failureType, 'verification', 'failureType should be "verification"');
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC3: InfrastructureError still re-throws from executor catch ──────────────

await test('TC3: InfrastructureError still re-throws from executor catch block', async () => {
  const { projectRoot } = createMinimalHarness();
  try {
    const pipeline = makePipeline(projectRoot);

    const infraErr = new InfrastructureError('network failure', {
      category: 'network',
      retryable: true,
      statusCode: 503,
      cause: null,
    });

    // Mock executor to throw InfrastructureError
    pipeline.executor = {
      executeTask: async () => {
        throw infraErr;
      },
    };

    // Mock statusBar
    pipeline.statusBar = {
      updateAgent: () => {},
      teardown: () => {},
    };

    // Mock tokenTracker
    pipeline.tokenTracker = {
      getUsageByType: () => ({ totalCostUsd: 0 }),
    };

    let caughtErr = null;
    try {
      await pipeline._executeAndVerifyTask(baseTask.missionId, baseTask.subMissionId, baseTask);
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr !== null, '_executeAndVerifyTask should throw for InfrastructureError');
    assert.ok(caughtErr instanceof InfrastructureError, 'thrown error should be an InfrastructureError');
    assert.equal(caughtErr.message, 'network failure');
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC4: WallClockExceededError is not instanceof InfrastructureError ─────────

await test('TC4: WallClockExceededError is not instanceof InfrastructureError', async () => {
  const err = new WallClockExceededError('x');
  assert.ok(!(err instanceof InfrastructureError), 'WallClockExceededError should NOT be instanceof InfrastructureError');
  assert.equal(err.name, 'WallClockExceededError', 'name should be WallClockExceededError');
  assert.equal(err.message, 'x');
});

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
