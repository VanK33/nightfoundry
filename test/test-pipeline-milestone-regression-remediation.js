/**
 * test-pipeline-milestone-regression-remediation.js
 *
 * Unit/integration tests for the milestone regression remediation loop
 * inside Pipeline._executeMilestone().
 *
 * The loop runs after all missions and the optional reviewer gate complete.
 * When verifyMilestone returns passed=false the pipeline iterates remediation
 * steps, breaking early if the analyzer repeats its previous verdict, then
 * falls back to _gateConfirm when the loop exits without a passing verify.
 *
 * Covers:
 *   TC1 — regression.passed===false triggers analyzer.analyzeFailure with failureType='regression'
 *   TC2 — analyzer recommendation 'human' throws Error without entering planner
 *   TC3 — planner returns newTasks → mergeRemediationTasks called → pending tasks executed → verifyMilestone re-run
 *   TC4 — loop exits on verifyMilestone pass after remediation (iteration 1)
 *   TC5 — loop breaks early when analyzer repeats its verdict → falls back to _gateConfirm('regression-failed')
 *   TC6 — onLog receives '[milestone-regression-remediation iter 1/3]' marker with analyzer verdict and fix-task count
 *
 * Run: node test/test-pipeline-milestone-regression-remediation.js
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

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Create a temp project root with .harness structure, minimal global state.json
 * (milestone in_progress, single mission complete), and per-mission state file.
 */
function createIntegrationHarness({
  milestoneId = '001',
  missionId = '001-001',
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-ms-regression-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const taskId = `${missionId}-001-001`;
  const subMissionId = `${missionId}-001`;

  // Write the progress sidecar for the completed task.
  fs.writeFileSync(
    path.join(harnessDir, 'progress', `task-${taskId}.json`),
    JSON.stringify({
      taskId,
      status: 'COMPLETE',
      affectedFiles: [{ path: 'src/foo.js' }],
      summary: 'task completed',
      testsSummary: 'all tests passed',
    })
  );

  // Write the verification sidecar for the completed task.
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-${taskId}.json`),
    JSON.stringify({
      taskId,
      verified: true,
      report: 'fake verifier report',
      result: 'PASSED',
      hardChecks: [],
      taskScopeChecks: [],
      notes: null,
    })
  );

  // Write the verify.json for the task.
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({
      taskId,
      targetFiles: ['src/foo.js'],
      hardChecks: [],
      testCases: [],
    })
  );

  // Create source file.
  const srcDir = path.join(projectRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'foo.js'), '// src/foo.js\n');

  // Per-mission state file — mission and all tasks are 'complete'.
  const missionState = {
    id: missionId,
    missionId,
    description: `mission ${missionId}`,
    status: 'complete',
    subMissions: {
      [subMissionId]: {
        id: subMissionId,
        description: 'sub-mission',
        status: 'complete',
        tasks: {
          [taskId]: {
            id: taskId,
            description: `task ${taskId}`,
            status: 'complete',
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
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

  // Global state.json — milestone is 'in_progress', mission is 'complete'.
  const globalState = {
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
            description: `mission ${missionId}`,
            status: 'complete',
            stateFile: `.harness/state/mission-${missionId}.json`,
            planFile: `.harness/plan/mission-${missionId}.md`,
          },
        },
      },
    },
  };

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(globalState, null, 2)
  );

  return { projectRoot, harnessDir, milestoneId, missionId, taskId, subMissionId };
}

function cleanup(projectRoot) {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * Instantiate a Pipeline with noReview=true so _executeMilestone skips the
 * reviewer gate. Missions are pre-completed in the fixtures, so the scheduler
 * path (_executeMilestoneParallel) short-circuits with no approved missions and
 * control reaches the shared milestone-regression section without real dispatch.
 */
function makePipeline(projectRoot, extraOpts = {}) {
  const logs = [];
  const confirmCalls = [];

  const pipeline = new Pipeline(projectRoot, {
    noReview: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async (question) => {
      confirmCalls.push(question);
      return extraOpts.confirmAnswer ?? true;
    },
    ...extraOpts,
  });

  return { pipeline, logs, confirmCalls };
}

/**
 * Build a stateful verifier mock.
 *
 * - First `failCount` calls to verifyRegression for 'regression-milestone-*' tasks
 *   return verified=false (regression FAIL).
 * - Subsequent calls return verified=true (regression PASS).
 *
 * Returns { verifier, getRegressionCallCount }.
 */
function makeVerifierMock(failCount = 1) {
  let regressionCallCount = 0;
  const verifier = {
    verifyRegression: async (task) => {
      if (task.id && task.id.startsWith('regression-milestone-')) {
        regressionCallCount++;
        if (regressionCallCount <= failCount) {
          // Fail: verified=false; npm test in tmpdir will also fail → passed=false
          return { verified: false, report: 'FAILED: mock regression failure', structured: { verified: false } };
        }
        // Pass
        return { verified: true, report: 'PASSED', structured: { verified: true } };
      }
      return { verified: true, report: 'PASSED', structured: { verified: true } };
    },
  };
  return { verifier, getRegressionCallCount: () => regressionCallCount };
}

/**
 * Build a mock analyzer.
 * Returns { analyzer, getAnalyzeCalls }.
 */
function makeAnalyzerMock(recommendation = 'retry') {
  const analyzeCalls = [];
  const analyzer = {
    analyzeFailure: async (opts, projectRoot) => {
      analyzeCalls.push({ opts, projectRoot });
      return {
        eventId: 'mock-event-001',
        recommendation,
        affectedTasks: [],
      };
    },
  };
  return { analyzer, getAnalyzeCalls: () => analyzeCalls };
}

/**
 * Build a mock planner.
 * Returns { planner, getPlannerCalls }.
 */
function makePlannerMock(newTasks = []) {
  const plannerCalls = [];
  const planner = {
    remediateRegressionFailure: async (milestoneId, findings, projectRoot) => {
      plannerCalls.push({ milestoneId, findings, projectRoot });
      return { newTasks };
    },
  };
  return { planner, getPlannerCalls: () => plannerCalls };
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {

// TC1: regression.passed===false triggers analyzer.analyzeFailure with failureType='regression'
await test('TC1: regression.passed===false triggers analyzer.analyzeFailure with failureType regression', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    // Verifier always fails → analyzer is called
    const { verifier } = makeVerifierMock(99);
    const { analyzer, getAnalyzeCalls } = makeAnalyzerMock('human'); // 'human' stops after first call
    const { planner } = makePlannerMock([]);

    pipeline.verifier = verifier;
    pipeline.analyzer = analyzer;
    pipeline.planner = planner;
    pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
    pipeline._collectMilestoneContext = () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let threw = false;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch {
      threw = true;
    }

    const calls = getAnalyzeCalls();
    assert.ok(calls.length >= 1, `Expected analyzeFailure to be called at least once; got ${calls.length}`);
    assert.strictEqual(
      calls[0].opts.failureType,
      'regression',
      `Expected failureType='regression', got '${calls[0].opts.failureType}'`
    );
    assert.strictEqual(
      calls[0].opts.taskId,
      `regression-ms-${milestoneId}`,
      `Expected taskId='regression-ms-${milestoneId}', got '${calls[0].opts.taskId}'`
    );
    assert.ok(threw, 'Expected _executeMilestone to throw (human recommendation)');
  } finally {
    cleanup(projectRoot);
  }
});

// TC2: analyzer recommendation 'human' throws Error without entering planner
await test('TC2: analyzer recommendation human throws Error without entering planner', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    const { verifier } = makeVerifierMock(99);
    const { analyzer } = makeAnalyzerMock('human');
    const { planner, getPlannerCalls } = makePlannerMock([]);

    pipeline.verifier = verifier;
    pipeline.analyzer = analyzer;
    pipeline.planner = planner;
    pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
    pipeline._collectMilestoneContext = () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let threw = false;
    let thrownError = null;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch (err) {
      threw = true;
      thrownError = err;
    }

    assert.ok(threw, 'Expected _executeMilestone to throw when analyzer recommends human');
    assert.ok(
      thrownError.message.includes('human intervention'),
      `Expected error message to mention human intervention, got: ${thrownError.message}`
    );

    const plannerCalls = getPlannerCalls();
    assert.strictEqual(
      plannerCalls.length,
      0,
      `Expected planner NOT called when analyzer recommends human; got ${plannerCalls.length} call(s)`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// TC3: planner returns newTasks → mergeRemediationTasks called → pending tasks executed → verifyMilestone re-run
await test('TC3: planner returns newTasks triggers mergeRemediationTasks and verifyMilestone re-run', async () => {
  const { projectRoot, harnessDir, milestoneId, missionId, subMissionId } = createIntegrationHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    // Verifier fails once, then passes on second call
    const { verifier, getRegressionCallCount } = makeVerifierMock(1);
    const { analyzer } = makeAnalyzerMock('retry');

    // Planner returns a new task referencing the existing sub-mission
    const newTaskId = `${subMissionId}-fix-1`; // Will be normalized by mergeRemediationTasks
    const newTasks = [{
      id: newTaskId,
      subMissionId,
      description: 'Fix regression issue',
      targetFiles: ['src/foo.js'],
    }];
    const { planner, getPlannerCalls } = makePlannerMock(newTasks);

    // Track _executeAndVerifyTask calls
    const executeAndVerifyCalls = [];
    pipeline._executeAndVerifyTask = async (missionId, subMissionId, task) => {
      executeAndVerifyCalls.push({ missionId, subMissionId, taskId: task.id });
    };

    pipeline.verifier = verifier;
    pipeline.analyzer = analyzer;
    pipeline.planner = planner;
    pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
    pipeline._collectMilestoneContext = () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    // Should complete without throwing (second regression call passes)
    await pipeline._executeMilestone(milestoneId, msState);

    // planner.remediateRegressionFailure was called
    assert.ok(
      getPlannerCalls().length >= 1,
      `Expected planner.remediateRegressionFailure to be called; got ${getPlannerCalls().length} call(s)`
    );

    // verifyMilestone was re-run (called twice: once fail, once pass)
    assert.ok(
      getRegressionCallCount() >= 2,
      `Expected verifyMilestone to be called at least twice; got ${getRegressionCallCount()}`
    );

    // _executeAndVerifyTask was called for the new pending task
    assert.ok(
      executeAndVerifyCalls.length >= 1,
      `Expected _executeAndVerifyTask to be called for pending tasks; got ${executeAndVerifyCalls.length} call(s)`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// TC4: loop exits on verifyMilestone pass after remediation (iteration 1)
await test('TC4: loop exits on verifyMilestone pass after remediation (iteration 1)', async () => {
  const { projectRoot, harnessDir, milestoneId, missionId, subMissionId } = createIntegrationHarness();
  const { pipeline, logs } = makePipeline(projectRoot);

  try {
    // Verifier fails once (iter 1), passes on second call → loop exits after iter 1
    const { verifier, getRegressionCallCount } = makeVerifierMock(1);
    const { analyzer } = makeAnalyzerMock('retry');
    const { planner } = makePlannerMock([]);

    pipeline._executeAndVerifyTask = async () => {};
    pipeline.verifier = verifier;
    pipeline.analyzer = analyzer;
    pipeline.planner = planner;
    pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
    pipeline._collectMilestoneContext = () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    await pipeline._executeMilestone(milestoneId, msState);

    // Only 2 regression verifier calls: 1 fail + 1 pass (iter 1)
    assert.strictEqual(
      getRegressionCallCount(),
      2,
      `Expected exactly 2 regression calls (fail + pass after iter 1); got ${getRegressionCallCount()}`
    );

    // Log contains exactly one remediation iteration marker
    const iterLogs = logs.filter(l => l.includes('[milestone-regression-remediation iter'));
    assert.strictEqual(
      iterLogs.length,
      1,
      `Expected exactly 1 remediation iteration log; got ${iterLogs.length}: ${JSON.stringify(iterLogs)}`
    );

    // Milestone resolved log
    const resolvedLog = logs.find(l => l.includes('resolved after remediation'));
    assert.ok(
      resolvedLog,
      `Expected 'resolved after remediation' log; found logs: ${JSON.stringify(logs.filter(l => l.includes('remediation')))}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// TC5: loop breaks early when analyzer repeats its verdict → falls back to _gateConfirm('regression-failed')
await test('TC5: loop breaks early on repeated analyzer verdict falls back to _gateConfirm regression-failed', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, logs, confirmCalls } = makePipeline(projectRoot, {
    confirmAnswer: true, // accept gate → no throw
  });

  try {
    // Verifier always fails
    const { verifier } = makeVerifierMock(99);
    // analyzer always returns 'retry' with empty affectedTasks → repeat verdict fires on iter 2
    const { analyzer } = makeAnalyzerMock('retry');
    const { planner } = makePlannerMock([]);

    pipeline._executeAndVerifyTask = async () => {};
    pipeline.verifier = verifier;
    pipeline.analyzer = analyzer;
    pipeline.planner = planner;
    pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
    pipeline._collectMilestoneContext = () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    // Confirm returns true → gate is accepted → no throw → function completes
    await pipeline._executeMilestone(milestoneId, msState);

    // Early break at iter 2: exactly 2 remediation iteration markers
    const iterLogs = logs.filter(l => l.includes('[milestone-regression-remediation iter'));
    assert.strictEqual(
      iterLogs.length,
      2,
      `Expected exactly 2 remediation iteration logs (early break at iter 2); got ${iterLogs.length}: ${JSON.stringify(iterLogs)}`
    );

    // Break log contains 'REPEATED its previous verdict'
    const repeatLog = logs.find(l => l.includes('REPEATED its previous verdict'));
    assert.ok(
      repeatLog,
      `Expected a log line containing 'REPEATED its previous verdict'; logs:\n${logs.join('\n')}`
    );

    // _gateConfirm was called (via onConfirm)
    assert.ok(
      confirmCalls.length >= 1,
      `Expected _gateConfirm (onConfirm) to be called after early break; got ${confirmCalls.length} call(s)`
    );

    const gateQuestion = confirmCalls.find(q => q.includes('regression'));
    assert.ok(
      gateQuestion,
      `Expected a confirm call about regression; calls: ${JSON.stringify(confirmCalls)}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// TC6: onLog receives '[milestone-regression-remediation iter 1/3]' marker with analyzer verdict and fix-task count
await test('TC6: onLog receives remediation iter marker with analyzer verdict and fix-task count', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, logs } = makePipeline(projectRoot, {
    confirmAnswer: true, // don't throw on exhaustion
  });

  try {
    // Verifier always fails to get the marker logged
    const { verifier } = makeVerifierMock(99);
    const { analyzer } = makeAnalyzerMock('retry');
    const { planner } = makePlannerMock([]); // 0 fix tasks

    pipeline._executeAndVerifyTask = async () => {};
    pipeline.verifier = verifier;
    pipeline.analyzer = analyzer;
    pipeline.planner = planner;
    pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
    pipeline._collectMilestoneContext = () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    await pipeline._executeMilestone(milestoneId, msState);

    // Check for '[milestone-regression-remediation iter 1/3]' log
    const iter1Log = logs.find(l => l.includes('[milestone-regression-remediation iter 1/3]'));
    assert.ok(
      iter1Log,
      `Expected log containing '[milestone-regression-remediation iter 1/3]'; ` +
      `logs:\n${logs.filter(l => l.includes('remediation')).join('\n')}`
    );

    // Check for analyzer verdict log line (e.g. 'Fix tasks: 0, analyzer verdict: retry')
    const verdictLog = logs.find(l => l.includes('analyzer verdict: retry'));
    assert.ok(
      verdictLog,
      `Expected log containing 'analyzer verdict: retry'; ` +
      `logs:\n${logs.filter(l => l.includes('analyzer')).join('\n')}`
    );

    // Check for fix-task count in the verdict log
    const fixTaskLog = logs.find(l => l.includes('Fix tasks: 0'));
    assert.ok(
      fixTaskLog,
      `Expected log containing 'Fix tasks: 0' (since planner returned empty); ` +
      `logs:\n${logs.filter(l => l.includes('Fix tasks')).join('\n')}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

} // run()

await run();

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
