/**
 * test-blocked-direct-analyzer.js — Regression tests for the BLOCKED direct-
 * analyzer routing change.
 *
 * An executor BLOCKED result is a reasoned refusal ("this task cannot be done
 * as instructed"). Retrying it is provably useless: retry context is built
 * ONLY from the verification sidecar, and a BLOCKED task never reaches the
 * verifier, so every retry re-sends the identical instruction. BLOCKED now
 * joins WallClockExceededError and phantom-write+verifier-FAIL as a
 * deterministic, non-retryable failure that dispatches the analyzer directly.
 *
 * Tests (config.maxRetries left at its default 3):
 *  TC1. A BLOCKED executor stub is called EXACTLY once (no retry chain).
 *  TC2. The analyzer is dispatched exactly once with failureType 'execution'.
 *  TC3. The task's persisted status is 'failed' after the run.
 *  TC4. The before-snapshot restore ran (target file content restored to
 *       baseline after the executor's blocked write).
 *
 * Harness mirrors createPipelineHarness + the BLOCKED-stub pattern in
 * test-replan-cap-retry-budget.js and test-snapshots-integration.js.
 *
 * Run: node test/test-blocked-direct-analyzer.js
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

const BASELINE_CONTENT = '// foo\n';
const BLOCKED_WRITE_CONTENT = 'blocked-attempt-content';

/**
 * Create a minimal temp project + .harness dir suitable for driving
 * Pipeline._executeAndVerifyTask (mirrors createPipelineHarness in
 * test-replan-cap-retry-budget.js).
 */
function createPipelineHarness({
  taskId = '001-001-001-001',
  missionId = '001-001',
  status = 'pending',
  retryCount = 0,
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-direct-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const subMissionId = `${missionId}-001`;
  const missionState = {
    id: missionId, missionId, description: 'test mission', status: 'in_progress',
    subMissions: {
      [subMissionId]: {
        id: subMissionId, status: 'in_progress',
        tasks: {
          [taskId]: {
            id: taskId, description: 'test task', status,
            retryCount, targetFiles: ['src/foo.js'], dependencies: [],
          },
        },
      },
    },
  };

  fs.writeFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), JSON.stringify(missionState, null, 2));

  const globalState = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      '001': {
        id: '001', description: 'milestone', status: 'in_progress',
        missions: { [missionId]: { id: missionId, description: 'test', status: 'in_progress', stateFile: `.harness/state/mission-${missionId}.json` } },
      },
    },
  };

  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  const srcFile = path.join(projectRoot, 'src', 'foo.js');
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.writeFileSync(srcFile, BASELINE_CONTENT);

  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: ['src/foo.js'], hardChecks: [], testCases: [] })
  );

  return { projectRoot, harnessDir, subMissionId };
}

/**
 * Build a Pipeline whose executor writes to the target file then reports
 * BLOCKED, and whose _dispatchAnalyzer is a capturing stub.
 */
function makeBlockedPipeline(projectRoot) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
  });

  let execCalls = 0;
  pipeline.executor = {
    executeTask: async (_task, projRoot) => {
      execCalls++;
      fs.writeFileSync(path.join(projRoot, 'src', 'foo.js'), BLOCKED_WRITE_CONTENT);
      return { status: 'BLOCKED' };
    },
  };

  const analyzerCalls = [];
  pipeline._dispatchAnalyzer = async (task, failureType, retryCount) => {
    analyzerCalls.push({ taskId: task.id, failureType, retryCount });
  };

  return { pipeline, logs, getExecCalls: () => execCalls, analyzerCalls };
}

function makeTask(subMissionId) {
  return {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId,
    description: 'test task',
    targetFiles: ['src/foo.js'],
    dependencies: [],
  };
}

async function run() {

// ── TC1 + TC2: BLOCKED is non-retryable and dispatches the analyzer once ─────
await test('TC1/TC2 BLOCKED executor runs exactly once (no retry chain) and analyzer is dispatched once with failureType execution', async () => {
  const { projectRoot, subMissionId } = createPipelineHarness();
  try {
    const { pipeline, getExecCalls, analyzerCalls } = makeBlockedPipeline(projectRoot);

    // config.maxRetries is at its default (3): a retry chain would call the
    // executor 4 times. Exactly one call proves BLOCKED short-circuits it.
    assert.strictEqual(config.maxRetries, 3,
      `fixture precondition: config.maxRetries default expected 3, got ${config.maxRetries}`);

    await pipeline._executeAndVerifyTask('001-001', subMissionId, makeTask(subMissionId), 0);

    assert.strictEqual(getExecCalls(), 1,
      `BLOCKED executor must run EXACTLY once (no retry chain), got: ${getExecCalls()}`);
    assert.strictEqual(analyzerCalls.length, 1,
      `analyzer must be dispatched exactly once, got ${analyzerCalls.length} call(s)`);
    assert.strictEqual(analyzerCalls[0].failureType, 'execution',
      `analyzer must be dispatched for the execution failure, got: "${analyzerCalls[0].failureType}"`);
  } finally { fs.rmSync(projectRoot, { recursive: true, force: true }); }
});

// ── TC3: persisted status is 'failed' after the run ──────────────────────────
await test('TC3 task persisted status is failed after a BLOCKED run', async () => {
  const { projectRoot, harnessDir, subMissionId } = createPipelineHarness();
  try {
    const { pipeline } = makeBlockedPipeline(projectRoot);

    await pipeline._executeAndVerifyTask('001-001', subMissionId, makeTask(subMissionId), 0);

    const ms = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state', 'mission-001-001.json'), 'utf8'));
    const taskState = ms.subMissions[subMissionId].tasks['001-001-001-001'];
    assert.strictEqual(taskState.status, 'failed',
      `expected task status 'failed', got '${taskState.status}'`);
  } finally { fs.rmSync(projectRoot, { recursive: true, force: true }); }
});

// ── TC4: before-snapshot restore ran (target file reverted to baseline) ──────
await test('TC4 before-snapshot restore reverts the target file to baseline after a blocked write', async () => {
  const { projectRoot, subMissionId } = createPipelineHarness();
  try {
    const { pipeline } = makeBlockedPipeline(projectRoot);

    await pipeline._executeAndVerifyTask('001-001', subMissionId, makeTask(subMissionId), 0);

    const restored = fs.readFileSync(path.join(projectRoot, 'src', 'foo.js'), 'utf8');
    assert.strictEqual(restored, BASELINE_CONTENT,
      `expected target file restored to baseline "${BASELINE_CONTENT}", got "${restored}"`);
  } finally { fs.rmSync(projectRoot, { recursive: true, force: true }); }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
