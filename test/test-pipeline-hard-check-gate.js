/**
 * test-pipeline-hard-check-gate.js — Pipeline integration tests for the
 * hardCheck gate wiring (Defect-closure: verify.json hardChecks run before
 * marking a task verified+complete).
 *
 * Tests exercise _executeAndVerifyTask with real runHardChecks execution so
 * that the gate's pass/fail branching is fully covered end-to-end.
 *
 * TC-HCG-1: hardCheckGate passed → task transitions to verified+complete
 *   write verify.json with passing hardCheck { name:'ok', command:'true' },
 *   stub executor (edits file), stub verifier (verified:true),
 *   assert task.status === 'complete'.
 *
 * TC-HCG-2: hardCheckGate failed → task transitions to failed, retry dispatched
 *   write verify.json with failing hardCheck { name:'fail', command:'false' },
 *   stub executor + verifier (verified:true),
 *   assert task.status === 'failed' and logs contain 'hard-check gate FAILED'.
 *
 * TC-HCG-3: verify.json missing → gate skipped, task proceeds to verified
 *   delete verify.json after env setup so runHardChecks throws,
 *   stub executor + verifier (verified:true),
 *   assert task.status === 'complete' and logs contain 'hard-check gate skipped'.
 *
 * TC-HCG-4: hardCheckGate null (catch path) → verified path proceeds normally
 *   write malformed (non-JSON) verify.json so runHardChecks throws on parse,
 *   stub executor + verifier (verified:true),
 *   assert task.status === 'complete' (catch path lets verified flow through).
 *
 * Run: node test/test-pipeline-hard-check-gate.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeMissionState } from '../src/orchestrator/core/state.js';

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

/**
 * Build a minimal harness directory with one task ready for
 * _executeAndVerifyTask. Creates state.json, the mission state file,
 * and writes a verify.json sidecar so runHardChecks has a valid input.
 *
 * @param {string} taskId
 * @param {Array} hardChecks  - hardCheck entries to embed in verify.json
 */
function createPipelineEnv(taskId = '001-002-001-001', hardChecks = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcg-pipeline-test-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(harnessDir, 'logs', 'token-usage.json'),
    JSON.stringify({ sessions: [], totals: {} })
  );

  const parts = taskId.split('-');
  const missionId = `${parts[0]}-${parts[1]}`;
  const subMissionId = `${parts[0]}-${parts[1]}-${parts[2]}`;
  const milestoneId = parts[0];

  const state = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId,
        description: 'test milestone',
        status: 'pending',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: {
          [missionId]: {
            id: missionId,
            description: 'test mission',
            status: 'pending',
            stateFile: `.harness/state/mission-${missionId}.json`,
            planFile: `.harness/plan/mission-${missionId}.md`,
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  writeMissionState(harnessDir, missionId, 'test mission', {
    subMissions: [{
      id: subMissionId,
      description: 'test sm',
      tasks: [{
        id: taskId,
        description: 'test task for hard-check gate',
        targetFiles: ['src/foo.js'],
        dependencies: [],
        testCases: [],
      }],
    }],
  });

  // Write verify.json sidecar with the provided hardChecks
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: ['src/foo.js'], hardChecks, testCases: [] })
  );

  // Create the targetFile so before-snapshot can capture it
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/foo.js'), 'original content');

  return { root, harnessDir, taskId, missionId, subMissionId, milestoneId };
}

/**
 * Build a Pipeline instance with stubbed executor + verifier + analyzer.
 *
 * Executor stub: writes progress sidecar + edits src/foo.js with unique
 *   content each call so phantom-write guard never fires.
 * Verifier stub: writes verification sidecar + returns verifyResult.
 * Analyzer stub: returns 'retry' recommendation (non-blocking).
 * _dispatchAnalyzer stub: no-op (prevents circuit-breaker throw).
 *
 * @param {string} projectRoot
 * @param {{ execResult: object, verifyResult: object }} options
 * @returns {{ pipeline: Pipeline, logs: string[] }}
 */
function makePipelineWithFakes(projectRoot, { execResult, verifyResult }) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    statusBar: false,
  });

  let execCallCount = 0;
  pipeline.executor = {
    executeTask: async (task) => {
      execCallCount++;
      // Write progress sidecar mimicking executor output
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'progress', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, status: execResult.status, affectedFiles: execResult.affectedFiles || [] })
      );
      // Actually edit src/foo.js with unique content so phantom-write guard passes
      fs.writeFileSync(
        path.join(projectRoot, 'src', 'foo.js'),
        `modified content (call ${execCallCount})`
      );
      return execResult;
    },
  };

  pipeline.verifier = {
    verifyTask: async (task) => {
      // Write verification sidecar
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'verification', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, ...verifyResult })
      );
      return verifyResult;
    },
  };

  pipeline.analyzer = {
    analyzeFailure: async () => ({ eventId: 'fake', recommendation: 'retry', affectedTasks: [] }),
  };

  // Stub _dispatchAnalyzer to prevent circuit-breaker throw
  pipeline._dispatchAnalyzer = async () => {};

  return { pipeline, logs };
}

// ── Tests ────────────────────────────────────────────────────────────────────

await test('TC-HCG-1: hardCheckGate passed → task transitions to verified+complete', async () => {
  const taskId = '001-002-001-001';
  const env = createPipelineEnv(taskId, [{ name: 'ok', command: 'true' }]);
  try {
    const { pipeline, logs } = makePipelineWithFakes(env.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: true, report: 'goal state holds' },
    });

    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: taskId,
      description: 'test task for hard-check gate',
      targetFiles: ['src/foo.js'],
      dependencies: [],
    });

    const ms = JSON.parse(
      fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8')
    );
    const task = ms.subMissions[env.subMissionId].tasks[taskId];
    assert.strictEqual(task.status, 'complete',
      `expected 'complete', got '${task.status}'. Logs:\n${logs.slice(-5).join('\n')}`);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-HCG-2: hardCheckGate failed → task transitions to failed, retry dispatched', async () => {
  const taskId = '001-002-001-002';
  const env = createPipelineEnv(taskId, [{ name: 'fail', command: 'false' }]);
  try {
    const { pipeline, logs } = makePipelineWithFakes(env.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: true, report: 'goal state holds' },
    });

    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: taskId,
      description: 'test task for hard-check gate',
      targetFiles: ['src/foo.js'],
      dependencies: [],
    });

    const ms = JSON.parse(
      fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8')
    );
    const task = ms.subMissions[env.subMissionId].tasks[taskId];
    assert.strictEqual(task.status, 'failed',
      `expected 'failed', got '${task.status}'. Logs:\n${logs.slice(-5).join('\n')}`);
    assert.ok(
      logs.some((l) => l.includes('hard-check gate FAILED')),
      `expected log 'hard-check gate FAILED'. All logs:\n${logs.join('\n')}`
    );
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-HCG-3: verify.json missing → gate fail-closed, task does NOT complete', async () => {
  // Was previously asserted as fail-OPEN (task completes, "gate skipped").
  // Post-fix BEHAVIOR 1: a missing verify.json must make the FINAL result
  // FAILED — the verifier's PASS must not pass through. Assert NOT complete.
  const taskId = '001-002-001-003';
  const env = createPipelineEnv(taskId, []);
  // Remove verify.json so runHardChecks throws → must be treated as FAILED.
  fs.rmSync(path.join(env.harnessDir, 'verify', `task-${taskId}.json`));
  try {
    const { pipeline, logs } = makePipelineWithFakes(env.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: true, report: 'goal state holds' },
    });
    pipeline._dispatchAnalyzer = async () => {};

    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: taskId,
      description: 'test task for hard-check gate',
      targetFiles: ['src/foo.js'],
      dependencies: [],
    });

    const ms = JSON.parse(
      fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8')
    );
    const task = ms.subMissions[env.subMissionId].tasks[taskId];
    assert.notStrictEqual(task.status, 'complete',
      `expected task NOT 'complete' (fail-closed on missing verify.json), got '${task.status}'. Logs:\n${logs.slice(-8).join('\n')}`);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-HCG-4: verify.json unreadable (bad JSON) → gate fail-closed, task does NOT complete', async () => {
  // Was previously asserted as fail-OPEN (catch path lets verified flow through).
  // Post-fix BEHAVIOR 1: an unreadable verify.json (runHardChecks throws on
  // parse) must make the FINAL result FAILED. Assert NOT complete.
  const taskId = '001-002-001-004';
  const env = createPipelineEnv(taskId, []);
  // Overwrite verify.json with invalid JSON to trigger a parse error in runHardChecks
  fs.writeFileSync(
    path.join(env.harnessDir, 'verify', `task-${taskId}.json`),
    'NOT VALID JSON {'
  );
  try {
    const { pipeline, logs } = makePipelineWithFakes(env.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: true, report: 'goal state holds' },
    });
    pipeline._dispatchAnalyzer = async () => {};

    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: taskId,
      description: 'test task for hard-check gate',
      targetFiles: ['src/foo.js'],
      dependencies: [],
    });

    const ms = JSON.parse(
      fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8')
    );
    const task = ms.subMissions[env.subMissionId].tasks[taskId];
    assert.notStrictEqual(task.status, 'complete',
      `expected task NOT 'complete' (fail-closed on unreadable verify.json), got '${task.status}'. Logs:\n${logs.slice(-8).join('\n')}`);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-HCG-5: verify.json missing → gate fail-closed, task FAILS (not pass-through)', async () => {
  // BEHAVIOR 1 (main path): when verify.json is missing, runHardChecks throws.
  // After the fix that throw must make the FINAL verification result FAILED —
  // the verifier's own PASS must NOT pass through. Assert the task did NOT
  // reach 'complete'.
  const taskId = '001-002-001-005';
  const env = createPipelineEnv(taskId, []);
  // Remove verify.json so runHardChecks throws → must be treated as FAILED.
  fs.rmSync(path.join(env.harnessDir, 'verify', `task-${taskId}.json`));
  try {
    const { pipeline, logs } = makePipelineWithFakes(env.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: true, report: 'goal state holds' },
    });
    // Prevent the analyzer/circuit-breaker from throwing on the FAILED path.
    pipeline._dispatchAnalyzer = async () => {};

    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: taskId,
      description: 'test task for hard-check gate',
      targetFiles: ['src/foo.js'],
      dependencies: [],
    });

    const ms = JSON.parse(
      fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8')
    );
    const task = ms.subMissions[env.subMissionId].tasks[taskId];
    // Fail-closed: missing verify.json must NOT yield a verified+complete task.
    assert.notStrictEqual(task.status, 'complete',
      `expected task NOT 'complete' (fail-closed on missing verify.json), got '${task.status}'. Logs:\n${logs.slice(-8).join('\n')}`);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-HCG-6: verify.json present + hardChecks pass → still verifies (no regression)', async () => {
  // Positive regression guard: with verify.json present and a passing
  // hardCheck, the fail-closed change must NOT break the happy path.
  const taskId = '001-002-001-006';
  const env = createPipelineEnv(taskId, [{ name: 'ok', command: 'true' }]);
  try {
    const { pipeline, logs } = makePipelineWithFakes(env.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: true, report: 'goal state holds' },
    });

    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: taskId,
      description: 'test task for hard-check gate',
      targetFiles: ['src/foo.js'],
      dependencies: [],
    });

    const ms = JSON.parse(
      fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8')
    );
    const task = ms.subMissions[env.subMissionId].tasks[taskId];
    assert.strictEqual(task.status, 'complete',
      `expected 'complete' on happy path, got '${task.status}'. Logs:\n${logs.slice(-5).join('\n')}`);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
