/**
 * test-regression-remediation-integration.js — Integration tests for the
 * milestone-regression remediation loop inside Pipeline._executeMilestone().
 *
 * After the reviewer gate passes, the milestone-level regression runs.  On
 * failure the autonomous remediation loop kicks in:
 *   1. analyzeFailure({ failureType: 'regression' })
 *   2. If recommendation === 'human'  → throw (no _gateConfirm)
 *   3. If recommendation === 'retry'  → planner.remediateRegressionFailure → execute → re-verify
 *   4. Loop up to MAX iterations; after exhaustion → _gateConfirm('regression-failed')
 *
 * Covers:
 *   TC1 — regression hard-fails → analyzer.analyzeFailure called with failureType 'regression'
 *   TC2 — analyzer 'human' recommendation → Error thrown, _gateConfirm NOT called
 *   TC3 — regression fails 2x then passes on iter 3 → pipeline completes, no _gateConfirm
 *   TC4 — regression fails all 3 iterations → _gateConfirm('regression-failed') fallback fires
 *   TC5 — planner.remediateRegressionFailure returns empty newTasks → _gateConfirm called
 *
 * Run: node test/test-regression-remediation-integration.js
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

// ── Fixture helpers ──────────────────────────────────────────────────

/**
 * Create a temp project root with a .harness subdirectory and a single
 * pre-completed mission (so the scheduler path approves no missions and
 * proceeds directly to the reviewer gate → milestone regression path).
 *
 * Returns { projectRoot, harnessDir, milestoneId, missionId, taskId }.
 */
function createIntegrationHarness({
  milestoneId = '001',
  missionId = '001-001',
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-regression-remediation-'));
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

  return { projectRoot, harnessDir, milestoneId, missionId, taskId };
}

function cleanup(projectRoot) {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * Instantiate a Pipeline. Missions are pre-completed in the fixtures, so the
 * scheduler path (_executeMilestoneParallel) short-circuits with no approved
 * missions and control reaches the shared regression-remediation section
 * without real dispatch.
 *
 * Returns { pipeline, logs }.
 */
function makePipeline(projectRoot, extraOpts = {}) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    ...extraOpts,
  });

  return { pipeline, logs };
}

/**
 * Install mock agents on a pipeline instance and return a trace object.
 *
 * The trace object tracks:
 *   trace.analyzeFailureCalls        — number of analyzer.analyzeFailure invocations
 *   trace.analyzeFailureTypes        — array of failureType values passed to analyzeFailure
 *   trace.gateConfirmCalls           — array of site strings passed to _gateConfirm
 *   trace.verifyMilestoneCalls       — number of regression-milestone-* verifyRegression calls
 *   trace.plannerCalls               — number of planner.remediateRegressionFailure calls
 *
 * Options:
 *   analyzerRecommendation     — what analyzer.analyzeFailure returns ('retry' | 'human')
 *   plannerNewTasks            — array returned by planner.remediateRegressionFailure
 *   regressionPassOnIteration  — verifyMilestone returns verified=true on this iteration
 *                                (1 = always pass, 4+ = always fail within a 3-iter loop)
 */
function installMocks(pipeline, {
  analyzerRecommendation = 'retry',
  plannerNewTasks = [],
  regressionPassOnIteration = 4,
} = {}) {
  const trace = {
    analyzeFailureCalls: 0,
    analyzeFailureTypes: [],
    gateConfirmCalls: [],
    verifyMilestoneCalls: 0,
    plannerCalls: 0,
  };

  // No-op executor — missions are pre-completed, should never be called.
  pipeline.executor = {
    executeTask: async (task) => ({
      status: 'COMPLETE',
      affectedFiles: task.targetFiles || [],
    }),
  };

  // Milestone regression verifier — returns verified=false until regressionPassOnIteration.
  let milestoneRegressionCallCount = 0;
  pipeline.verifier = {
    verifyRegression: async (task) => {
      if (task.id && task.id.startsWith('regression-milestone-')) {
        trace.verifyMilestoneCalls++;
        milestoneRegressionCallCount++;
        if (milestoneRegressionCallCount >= regressionPassOnIteration) {
          return {
            verified: true,
            report: 'PASSED — milestone regression resolved',
            structured: { result: 'PASSED', verified: true },
          };
        }
        return {
          verified: false,
          report: 'FAILED — milestone regression check failed',
          structured: { result: 'FAILED', verified: false },
        };
      }
      // All other tasks (e.g., mission regression) always pass.
      return {
        verified: true,
        report: 'PASSED',
        structured: { result: 'PASSED', verified: true },
      };
    },
  };

  // Mock analyzer — tracks calls and records failureType for each invocation.
  // Each call returns a DISTINCT verdict (unique eventId + per-call affected
  // task) so the repeat-escalation detector — which breaks the remediation
  // loop early on consecutive identical (recommendation, affectedTasks)
  // verdicts, by design — does not trip in cases that exercise the full
  // iteration cap. Early-break behavior has its own coverage in
  // test/test-analyzer-closure.js.
  pipeline.analyzer = {
    analyzeFailure: async (opts, _projectRoot) => {
      trace.analyzeFailureCalls++;
      trace.analyzeFailureTypes.push(opts.failureType ?? null);
      return {
        eventId: `mock-event-regression-${trace.analyzeFailureCalls}`,
        recommendation: analyzerRecommendation,
        affectedTasks: [{ taskId: `mock-affected-${trace.analyzeFailureCalls}`, reason: 'distinct per call', action: 'safe_to_keep' }],
      };
    },
  };

  // Mock reviewer — always passes so we reach the milestone regression path.
  pipeline.reviewer = {
    reviewMilestone: async () => ({
      passed: true,
      findings: [],
      structured: { result: 'PASSED', findings: [], notes: '' },
      reportPath: '',
    }),
  };

  // Mock planner — tracks remediateRegressionFailure calls.
  pipeline.planner = {
    remediateRegressionFailure: async (_milestoneId, _findings, _projectRoot) => {
      trace.plannerCalls++;
      return { newTasks: plannerNewTasks };
    },
  };

  // Avoid expensive import-graph walk on a bare tmp directory.
  pipeline._collectMilestoneContext = () => ({
    modifiedFiles: [],
    taskDescriptions: [],
    importGraph: '',
    specScopeFiles: [],
    exceededFiles: [],
  });

  // Wrap _gateConfirm to track which sites are invoked.
  const origGateConfirm = pipeline._gateConfirm.bind(pipeline);
  pipeline._gateConfirm = async (site, question, opts) => {
    trace.gateConfirmCalls.push(site);
    return origGateConfirm(site, question, opts);
  };

  return trace;
}

// ── Tests ────────────────────────────────────────────────────────────

async function run() {

await test('TC1: regression hard-fail invokes analyzer.analyzeFailure with failureType \'regression\'', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    // regressionPassOnIteration=4 → verifier never passes in a 3-iter loop.
    const trace = installMocks(pipeline, {
      analyzerRecommendation: 'retry',
      plannerNewTasks: [],
      regressionPassOnIteration: 4,
    });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    // Pipeline may throw after the fallback gate — we only care about analyzeFailure.
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch { /* expected — regression fails */ }

    assert.ok(
      trace.analyzeFailureCalls >= 1,
      `Expected analyzer.analyzeFailure to be called at least once; got ${trace.analyzeFailureCalls}`
    );

    // Every analyzeFailure call for the regression path must use failureType: 'regression'.
    const regressionTypes = trace.analyzeFailureTypes.filter(t => t === 'regression');
    assert.ok(
      regressionTypes.length >= 1,
      `Expected at least one analyzeFailure call with failureType 'regression'. ` +
      `Got failureTypes: [${trace.analyzeFailureTypes.join(', ')}]`
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC2: analyzer \'human\' recommendation → Error thrown, _gateConfirm NOT called', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    // Analyzer recommends 'human' on first regression failure.
    const trace = installMocks(pipeline, {
      analyzerRecommendation: 'human',
      plannerNewTasks: [],
      regressionPassOnIteration: 4, // regression always fails
    });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let thrownError = null;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch (err) {
      thrownError = err;
    }

    assert.ok(
      thrownError !== null,
      'Expected pipeline to throw when analyzer recommends human intervention'
    );
    assert.ok(
      thrownError.message.toLowerCase().includes('human'),
      `Expected "human" in thrown error message. Got: "${thrownError.message}"`
    );

    // _gateConfirm('regression-failed') must NOT have been called.
    const regressionGateCalls = trace.gateConfirmCalls.filter(s => s === 'regression-failed');
    assert.strictEqual(
      regressionGateCalls.length,
      0,
      `Expected _gateConfirm('regression-failed') NOT called when analyzer returns 'human'; ` +
      `gateConfirmCalls: [${trace.gateConfirmCalls.join(', ')}]`
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC3: regression fails 2x then passes on iter 3 → pipeline completes, no _gateConfirm', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    // verifier returns verified=false on calls 1 and 2, verified=true on call 3.
    const trace = installMocks(pipeline, {
      analyzerRecommendation: 'retry',
      plannerNewTasks: [
        {
          id: `${milestoneId}-001-001-fix-001`,
          subMissionId: `${milestoneId}-001-001`,
          description: 'fix regression finding',
          targetFiles: [],
        },
      ],
      regressionPassOnIteration: 3, // pass on the 3rd call
    });

    // Stub _executeAndVerifyTask to avoid real task execution.
    pipeline._executeAndVerifyTask = async (_mId, _smId, _task) => {};

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let thrownError = null;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch (err) {
      thrownError = err;
    }

    assert.strictEqual(
      thrownError,
      null,
      `Expected pipeline to complete without throwing when regression passes on iteration 3. ` +
      `Thrown: "${thrownError?.message}"`
    );

    // _gateConfirm('regression-failed') must NOT have been called.
    const regressionGateCalls = trace.gateConfirmCalls.filter(s => s === 'regression-failed');
    assert.strictEqual(
      regressionGateCalls.length,
      0,
      `Expected _gateConfirm('regression-failed') NOT called when regression resolves on iter 3; ` +
      `gateConfirmCalls: [${trace.gateConfirmCalls.join(', ')}]`
    );

    // verifyMilestone must have been called at least 3 times.
    assert.ok(
      trace.verifyMilestoneCalls >= 3,
      `Expected verifyMilestone called at least 3 times; got ${trace.verifyMilestoneCalls}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC4: regression fails all 3 iterations → _gateConfirm(\'regression-failed\') fallback fires', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    // regressionPassOnIteration=5 → never passes within a 3-iter loop (1 initial + 3 rechecks = 4 total calls).
    const trace = installMocks(pipeline, {
      analyzerRecommendation: 'retry',
      plannerNewTasks: [
        {
          id: `${milestoneId}-001-001-fix-001`,
          subMissionId: `${milestoneId}-001-001`,
          description: 'fix regression (will not succeed)',
          targetFiles: [],
        },
      ],
      regressionPassOnIteration: 5, // always fails (5 > 4 total calls)
    });

    // Stub _executeAndVerifyTask to avoid real execution.
    pipeline._executeAndVerifyTask = async (_mId, _smId, _task) => {};

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    // Pipeline calls _gateConfirm('regression-failed') as fallback.
    // With onConfirm returning true the pipeline may proceed to phase 5 or throw — irrelevant.
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch { /* may throw after gate */ }

    const regressionGateCalls = trace.gateConfirmCalls.filter(s => s === 'regression-failed');
    assert.ok(
      regressionGateCalls.length >= 1,
      `Expected _gateConfirm('regression-failed') to be called as fallback after all iterations fail; ` +
      `gateConfirmCalls: [${trace.gateConfirmCalls.join(', ')}]`
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC5: planner.remediateRegressionFailure returns empty newTasks → falls back to _gateConfirm', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    // Planner returns empty newTasks — no fix tasks to execute.
    const trace = installMocks(pipeline, {
      analyzerRecommendation: 'retry',
      plannerNewTasks: [], // empty!
      regressionPassOnIteration: 5, // regression always fails (5 > 4 total calls: 1 initial + 3 rechecks)
    });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch { /* may throw */ }

    // planner.remediateRegressionFailure must have been called.
    assert.ok(
      trace.plannerCalls >= 1,
      `Expected planner.remediateRegressionFailure to be called at least once; got ${trace.plannerCalls}`
    );

    // After empty newTasks, must fall back to _gateConfirm('regression-failed').
    const regressionGateCalls = trace.gateConfirmCalls.filter(s => s === 'regression-failed');
    assert.ok(
      regressionGateCalls.length >= 1,
      `Expected _gateConfirm('regression-failed') to be called when planner returns empty newTasks; ` +
      `gateConfirmCalls: [${trace.gateConfirmCalls.join(', ')}]`
    );
  } finally {
    cleanup(projectRoot);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
