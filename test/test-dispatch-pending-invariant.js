/**
 * test-dispatch-pending-invariant.js
 *
 * Tests for the assertNoNonTerminalTasks invariant check in pipeline.js.
 *
 * Covers:
 *   TC-DPI-1: milestone with all-complete tasks advances normally — assertNoNonTerminalTasks does not throw
 *   TC-DPI-2: milestone with one pending task — assertNoNonTerminalTasks throws PendingTasksAtMilestoneAdvance
 *   TC-DPI-3: milestone-regression path — same invariant fires for in_progress task before regression
 *
 * Run: node test/test-dispatch-pending-invariant.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PendingTasksAtMilestoneAdvance } from '../src/orchestrator/core/pending-tasks-error.js';
import { assertNoNonTerminalTasks } from '../src/orchestrator/core/pipeline.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failCount++;
    }
  );
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Create a temp harness directory with:
 *   - state.json: milestone '001' in_progress with one mission '001-001'
 *   - state/mission-001-001.json: one sub-mission '001-001-001', one task
 *     '001-001-001-001' with configurable status
 *   - progress/verification/verify sidecars for the task
 *
 * Returns { harnessDir, projectRoot, msState }
 */
function createMilestoneEnv({ taskStatus = 'complete' } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-pending-invariant-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const milestoneId = '001';
  const missionId = '001-001';
  const subMissionId = '001-001-001';
  const taskId = '001-001-001-001';

  // Write progress sidecar
  fs.writeFileSync(
    path.join(harnessDir, 'progress', `task-${taskId}.json`),
    JSON.stringify({
      taskId,
      status: taskStatus === 'complete' ? 'COMPLETE' : taskStatus.toUpperCase(),
      affectedFiles: [{ path: 'src/foo.js' }],
      summary: 'task summary',
      testsSummary: 'tests summary',
    })
  );

  // Write verification sidecar
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-${taskId}.json`),
    JSON.stringify({
      taskId,
      verified: taskStatus === 'complete',
      report: 'verifier report',
      result: taskStatus === 'complete' ? 'PASSED' : 'PENDING',
      hardChecks: [],
      taskScopeChecks: [],
      notes: null,
    })
  );

  // Write verify.json sidecar
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({
      taskId,
      targetFiles: ['src/foo.js'],
      hardChecks: [],
      testCases: [],
    })
  );

  // Per-mission state file
  const missionState = {
    id: missionId,
    missionId,
    description: `mission ${missionId}`,
    status: taskStatus === 'complete' ? 'complete' : 'in_progress',
    subMissions: {
      [subMissionId]: {
        id: subMissionId,
        description: 'sub-mission',
        status: taskStatus === 'complete' ? 'complete' : 'in_progress',
        tasks: {
          [taskId]: {
            id: taskId,
            description: `task ${taskId}`,
            status: taskStatus,
            createdAt: new Date().toISOString(),
            startedAt: taskStatus !== 'pending' ? new Date().toISOString() : null,
            completedAt: taskStatus === 'complete' ? new Date().toISOString() : null,
            targetFiles: ['src/foo.js'],
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

  // Global state.json
  const msState = {
    id: milestoneId,
    description: `milestone ${milestoneId}`,
    status: 'in_progress',
    planFile: `.harness/plan/milestone-${milestoneId}.md`,
    missions: {
      [missionId]: {
        id: missionId,
        description: `mission ${missionId}`,
        status: taskStatus === 'complete' ? 'complete' : 'in_progress',
        stateFile: `.harness/state/mission-${missionId}.json`,
        planFile: `.harness/plan/mission-${missionId}.md`,
      },
    },
  };

  const globalState = {
    projectMeta: {
      prdPath: '',
      createdAt: new Date().toISOString(),
      currentPhase: 'executing',
    },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: msState,
    },
  };

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(globalState, null, 2)
  );

  return { harnessDir, projectRoot, msState };
}

function cleanup(projectRoot) {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ── Tests ────────────────────────────────────────────────────────────────────

const logs = [];
function onLog(msg) {
  logs.push(msg);
}

await test('TC-DPI-1: milestone with all-complete tasks advances normally — assertNoNonTerminalTasks does not throw', async () => {
  const { harnessDir, projectRoot, msState } = createMilestoneEnv({ taskStatus: 'complete' });
  try {
    let threw = false;
    try {
      await assertNoNonTerminalTasks(harnessDir, '001', msState, onLog);
    } catch (err) {
      threw = true;
      throw new assert.AssertionError({
        message: `Expected no error to be thrown, but got: ${err.message}`,
        actual: err.name,
        expected: 'no error',
      });
    }
    assert.strictEqual(threw, false, 'assertNoNonTerminalTasks should not throw for all-complete tasks');
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC-DPI-2: milestone with one pending task — assertNoNonTerminalTasks throws PendingTasksAtMilestoneAdvance', async () => {
  const { harnessDir, projectRoot, msState } = createMilestoneEnv({ taskStatus: 'pending' });
  try {
    let thrownError = null;
    try {
      await assertNoNonTerminalTasks(harnessDir, '001', msState, onLog);
    } catch (err) {
      thrownError = err;
    }
    assert.ok(thrownError !== null, 'Expected assertNoNonTerminalTasks to throw');
    assert.strictEqual(thrownError.name, 'PendingTasksAtMilestoneAdvance',
      `Expected error.name === 'PendingTasksAtMilestoneAdvance', got '${thrownError.name}'`);
    assert.strictEqual(thrownError.milestoneId, '001',
      `Expected error.milestoneId === '001', got '${thrownError.milestoneId}'`);
    assert.ok(
      Array.isArray(thrownError.pendingTaskIds),
      'Expected error.pendingTaskIds to be an array'
    );
    assert.ok(
      thrownError.pendingTaskIds.includes('001-001-001-001'),
      `Expected error.pendingTaskIds to include '001-001-001-001', got: ${JSON.stringify(thrownError.pendingTaskIds)}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC-DPI-3: milestone-regression path — same invariant fires for in_progress task before regression', async () => {
  const { harnessDir, projectRoot, msState } = createMilestoneEnv({ taskStatus: 'in_progress' });
  try {
    let thrownError = null;
    try {
      await assertNoNonTerminalTasks(harnessDir, '001', msState, onLog);
    } catch (err) {
      thrownError = err;
    }
    assert.ok(thrownError !== null, 'Expected assertNoNonTerminalTasks to throw for in_progress task');
    assert.strictEqual(thrownError.name, 'PendingTasksAtMilestoneAdvance',
      `Expected error.name === 'PendingTasksAtMilestoneAdvance', got '${thrownError.name}'`);
    assert.ok(
      Array.isArray(thrownError.pendingTaskIds),
      'Expected error.pendingTaskIds to be an array'
    );
    assert.ok(
      thrownError.pendingTaskIds.includes('001-001-001-001'),
      `Expected error.pendingTaskIds to include '001-001-001-001', got: ${JSON.stringify(thrownError.pendingTaskIds)}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
