/**
 * test-pipeline-reviewer-gate.js — Integration test for the reviewer gate
 * inside Pipeline._executeMilestone().
 *
 * The reviewer gate runs after all missions complete, before milestone
 * regression (verifyMilestone). On FAILED with any severity:'critical'
 * finding the pipeline skips regression and routes to analyzer.analyzeFailure.
 * Warnings do not block — PASSED with warning-only findings proceeds normally.
 *
 * Covers:
 *   TC1 — Reviewer PASSED with no findings → verifyMilestone called
 *   TC2 — Reviewer FAILED with critical finding → regression skipped, analyzer called
 *   TC3 — Reviewer PASSED with warnings only → verifyMilestone called
 *   TC4 — Critical finding file/description logged via onLog
 *   TC5 — Analyzer recommends human → pipeline throws
 *   TC6 — noReview=true skips reviewer gate entirely
 *   TC7 — _collectMilestoneContext returns deduplicated modifiedFiles
 *
 * Run: node test/test-pipeline-reviewer-gate.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import config from '../src/orchestrator/infra/config.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { seedPassedSidecars } from './helpers/seed-passed-sidecars.js';

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
 * Create a temp project root with a .harness subdirectory, a minimal
 * global state.json (milestone in_progress, single mission complete),
 * and a per-mission state file with one pre-completed task.
 *
 * Returns { projectRoot, harnessDir, milestoneId, missionId, taskId }.
 */
function createIntegrationHarness({
  milestoneId = '001',
  missionId = '001-001',
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-reviewer-gate-'));
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

  // Production reality: every complete leaf task carries a PASSED verification
  // sidecar so the Phase-5 audit does not throw. This fixture already wrote a
  // PASSED sidecar above; the helper is idempotent (skips existing sidecars) and
  // backstops any complete task that lacks one.
  seedPassedSidecars(harnessDir, missionState);

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
 * Instantiate a Pipeline. _executeMilestone runs the scheduler path
 * (_executeMilestoneParallel), which installMocks no-ops so that all
 * complete missions are skipped and control reaches the reviewer gate
 * directly.
 *
 * Returns { pipeline, logs, restore }.
 */
function makePipeline(projectRoot, extraOpts = {}) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    ...extraOpts,
  });

  const restore = () => {};

  return { pipeline, logs, restore };
}

/**
 * Install mock agents on a pipeline instance and return a trace object.
 *
 * Tracked:
 *   trace.verifyMilestoneCalls — incremented each time verifier.verifyRegression is
 *     called with a task id starting with 'regression-milestone-'
 *   trace.analyzeFailureCalls  — incremented each time analyzer.analyzeFailure
 *     is called
 *
 * Also stubs:
 *   pipeline.reviewer.reviewMilestone   — returns reviewerResult
 *   pipeline.executor.executeTask       — no-op (missions pre-completed)
 *   pipeline._collectMilestoneContext   — returns empty context (avoids
 *     expensive import graph scan on a bare tmpdir)
 */
function installMocks(pipeline, { reviewerResult, analyzerRecommendation = 'human' }) {
  const trace = {
    verifyMilestoneCalls: 0,
    analyzeFailureCalls: 0,
  };

  // No-op executor — missions are pre-completed, should never be called.
  pipeline.executor = {
    executeTask: async (task) => ({
      status: 'COMPLETE',
      affectedFiles: task.targetFiles || [],
    }),
  };

  // Mock verifier — tracks whether verifyMilestone triggered a regression call.
  pipeline.verifier = {
    verifyRegression: async (task) => {
      if (task.id && task.id.startsWith('regression-milestone-')) {
        trace.verifyMilestoneCalls++;
      }
      // Write verification sidecar so state machine doesn't complain.
      return { verified: true, report: 'mock regression verifier', structured: { verified: true } };
    },
  };

  // Mock analyzer — tracks analyzeFailure calls.
  pipeline.analyzer = {
    analyzeFailure: async (_opts, _projectRoot) => {
      trace.analyzeFailureCalls++;
      return {
        eventId: 'mock-event-001',
        recommendation: analyzerRecommendation,
        affectedTasks: [],
      };
    },
  };

  // Mock reviewer — returns the provided result.
  pipeline.reviewer = {
    reviewMilestone: async () => reviewerResult,
  };

  // Avoid expensive import-graph walk on a bare tmp directory.
  pipeline._collectMilestoneContext = () => ({
    modifiedFiles: [],
    taskDescriptions: [],
    importGraph: '',
  });

  // Missions are pre-completed in the harness, so no-op the scheduler
  // executor; control reaches the shared reviewer-gate section directly.
  pipeline._executeMilestoneParallel = async () => {};

  return trace;
}

// ── Tests ────────────────────────────────────────────────────────────

async function run() {

await test('TC1: reviewer PASSED with no findings → verifyMilestone IS called (regression proceeds)', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    const reviewerResult = {
      passed: true,
      findings: [],
      structured: { result: 'PASSED', findings: [], notes: '' },
      reportPath: '',
    };

    const trace = installMocks(pipeline, { reviewerResult });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    await pipeline._executeMilestone(milestoneId, msState);

    assert.strictEqual(
      trace.verifyMilestoneCalls,
      1,
      `Expected verifyMilestone called once; got ${trace.verifyMilestoneCalls}`
    );
    assert.strictEqual(
      trace.analyzeFailureCalls,
      0,
      `Expected analyzeFailure NOT called; got ${trace.analyzeFailureCalls}`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('TC2: reviewer FAILED with critical finding → verifyMilestone NOT called, analyzeFailure IS called', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    const criticalFinding = {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/foo.js',
      description: 'unused function: fooHelper is never called',
      relatedFiles: [],
    };

    const reviewerResult = {
      passed: false,
      findings: [criticalFinding],
      structured: { result: 'FAILED', findings: [criticalFinding], notes: '' },
      reportPath: '',
    };

    const trace = installMocks(pipeline, { reviewerResult });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    // Pipeline throws after calling analyzeFailure on reviewer failure.
    let threw = false;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch {
      threw = true;
    }

    assert.ok(threw, 'Expected _executeMilestone to throw when reviewer FAILED with critical finding');

    assert.strictEqual(
      trace.verifyMilestoneCalls,
      0,
      `Expected verifyMilestone NOT called; got ${trace.verifyMilestoneCalls}`
    );
    assert.strictEqual(
      trace.analyzeFailureCalls,
      1,
      `Expected analyzeFailure called once; got ${trace.analyzeFailureCalls}`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('TC3: reviewer PASSED with warning-only findings → verifyMilestone IS called (warnings do not block)', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    const warningFinding = {
      severity: 'warning',
      category: 'integration',
      file: 'src/bar.js',
      description: 'minor issue: consider extracting helper',
      relatedFiles: [],
    };

    const reviewerResult = {
      passed: true,
      findings: [warningFinding],
      structured: { result: 'PASSED', findings: [warningFinding], notes: 'one warning logged' },
      reportPath: '',
    };

    const trace = installMocks(pipeline, { reviewerResult });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    await pipeline._executeMilestone(milestoneId, msState);

    assert.strictEqual(
      trace.verifyMilestoneCalls,
      1,
      `Expected verifyMilestone called once (warnings do not block); got ${trace.verifyMilestoneCalls}`
    );
    assert.strictEqual(
      trace.analyzeFailureCalls,
      0,
      `Expected analyzeFailure NOT called for warning-only findings; got ${trace.analyzeFailureCalls}`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('TC4: critical finding file and description are logged via onLog', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, logs, restore } = makePipeline(projectRoot);

  try {
    const criticalFinding = {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/foo.js',
      description: 'unused function: fooHelper is never called',
      relatedFiles: [],
    };

    const reviewerResult = {
      passed: false,
      findings: [criticalFinding],
      structured: { result: 'FAILED', findings: [criticalFinding], notes: '' },
      reportPath: '',
    };

    installMocks(pipeline, { reviewerResult });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    // Catch expected throw.
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch { /* expected */ }

    // The pipeline logs each critical finding as:
    //   `    [critical] ${finding.file}: ${finding.description}`
    const allLogs = logs.join('\n');
    assert.ok(
      allLogs.includes(criticalFinding.file),
      `Expected critical finding file "${criticalFinding.file}" in logs.\nLogs:\n${allLogs}`
    );
    assert.ok(
      allLogs.includes(criticalFinding.description),
      `Expected critical finding description "${criticalFinding.description}" in logs.\nLogs:\n${allLogs}`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('TC5: analyzer recommendation human after reviewer failure → pipeline throws with human intervention message', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    const criticalFinding = {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/foo.js',
      description: 'critical issue that requires human review',
      relatedFiles: [],
    };

    const reviewerResult = {
      passed: false,
      findings: [criticalFinding],
      structured: { result: 'FAILED', findings: [criticalFinding], notes: '' },
      reportPath: '',
    };

    // Explicitly set analyzerRecommendation to 'human'
    installMocks(pipeline, { reviewerResult, analyzerRecommendation: 'human' });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let thrownError = null;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError, 'Expected pipeline to throw when analyzer recommends human intervention');
    assert.ok(
      thrownError.message.toLowerCase().includes('human'),
      `Expected "human" in thrown error message. Got: ${thrownError.message}`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('TC6: noReview=true skips reviewer gate entirely', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  // Pass noReview: true to the Pipeline constructor
  const { pipeline, restore } = makePipeline(projectRoot, { noReview: true });

  try {
    let reviewerCalled = false;
    const reviewerResult = {
      passed: false,
      findings: [{ severity: 'critical', file: 'src/foo.js', description: 'would-be critical' }],
      structured: { result: 'FAILED', findings: [], notes: '' },
      reportPath: '',
    };

    installMocks(pipeline, { reviewerResult });

    // Override reviewer to track if it was called
    pipeline.reviewer = {
      reviewMilestone: async () => {
        reviewerCalled = true;
        return reviewerResult;
      },
    };

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    // Should NOT throw because reviewer is skipped and regression succeeds with mock verifier
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch { /* regression may throw, but not the reviewer */ }

    assert.ok(!reviewerCalled, 'reviewer.reviewMilestone should NOT be called when noReview=true');
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('TC7: _collectMilestoneContext returns deduplicated modifiedFiles from progress sidecars', async () => {
  // Build a harness where global state.json has missions with inline subMissions
  // so _collectMilestoneContext can find tasks and read their progress sidecars.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-collect-ctx-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  // Also create src/ so buildImportGraph doesn't error
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'bar.js'), '// bar.js\n');

  const milestoneId = '001';
  const missionId   = '001-001';
  const smId        = '001-001-001';
  const task1Id     = '001-001-001-001';
  const task2Id     = '001-001-001-002';

  // Progress sidecars: task1 and task2 both reference src/shared.js (duplicate)
  // plus each has a unique file.
  fs.writeFileSync(
    path.join(harnessDir, 'progress', `task-${task1Id}.json`),
    JSON.stringify({
      taskId: task1Id,
      status: 'COMPLETE',
      affectedFiles: [{ path: 'src/shared.js' }, { path: 'src/unique-a.js' }],
      summary: 'task 1 done',
      testsSummary: '',
    })
  );
  fs.writeFileSync(
    path.join(harnessDir, 'progress', `task-${task2Id}.json`),
    JSON.stringify({
      taskId: task2Id,
      status: 'COMPLETE',
      affectedFiles: [{ path: 'src/shared.js' }, { path: 'src/unique-b.js' }],
      summary: 'task 2 done',
      testsSummary: '',
    })
  );

  // Global state.json — missions must have inline subMissions so
  // _collectMilestoneContext can find the tasks.
  const globalState = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId,
        description: 'milestone 001',
        status: 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: {
          [missionId]: {
            id: missionId,
            description: 'mission 001-001',
            status: 'complete',
            stateFile: `.harness/state/mission-${missionId}.json`,
            planFile: `.harness/plan/mission-${missionId}.md`,
            // Inline subMissions so _collectMilestoneContext can find tasks
            subMissions: {
              [smId]: {
                id: smId,
                description: 'sub-mission',
                status: 'complete',
                tasks: {
                  [task1Id]: {
                    id: task1Id,
                    description: 'task 1',
                    status: 'complete',
                    targetFiles: ['src/shared.js', 'src/unique-a.js'],
                  },
                  [task2Id]: {
                    id: task2Id,
                    description: 'task 2',
                    status: 'complete',
                    targetFiles: ['src/shared.js', 'src/unique-b.js'],
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  // Write per-mission state file — _collectMilestoneContext reads from these, not state.json
  const missionState = globalState.milestones[milestoneId].missions[missionId].subMissions
    ? { subMissions: globalState.milestones[milestoneId].missions[missionId].subMissions }
    : { subMissions: {} };
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify(missionState, null, 2)
  );

  const pipeline = new Pipeline(projectRoot, {
    onLog: () => {},
    onConfirm: async () => true,
  });

  try {
    const ctx = pipeline._collectMilestoneContext(milestoneId);

    // src/shared.js appears in both task1 and task2 sidecars — must be deduplicated
    const sharedCount = ctx.modifiedFiles.filter(f => f === 'src/shared.js').length;
    assert.strictEqual(
      sharedCount,
      1,
      `Expected src/shared.js to appear exactly once (dedup); got ${sharedCount}. Files: ${ctx.modifiedFiles.join(', ')}`
    );

    // All three unique files should be present
    for (const expected of ['src/shared.js', 'src/unique-a.js', 'src/unique-b.js']) {
      assert.ok(
        ctx.modifiedFiles.includes(expected),
        `Expected "${expected}" in modifiedFiles. Got: ${ctx.modifiedFiles.join(', ')}`
      );
    }

    assert.strictEqual(ctx.modifiedFiles.length, 3, `Expected 3 deduplicated files; got ${ctx.modifiedFiles.length}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ── Retry path tests ─────────────────────────────────────────────────

await test('TC-retry-1: healthy remediation — analyzer returns retry, planner returns fix tasks, re-review passes → no throw', async () => {
  const { projectRoot, harnessDir, milestoneId, missionId, taskId } = createIntegrationHarness();
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    const criticalFinding = {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/foo.js',
      description: 'fix needed',
      relatedFiles: [],
    };

    const failedReviewerResult = {
      passed: false,
      findings: [criticalFinding],
      structured: { result: 'FAILED', findings: [criticalFinding], notes: '' },
      reportPath: '',
    };

    const passedReviewerResult = {
      passed: true,
      findings: [],
      structured: { result: 'PASSED', findings: [], notes: '' },
      reportPath: '',
    };

    const trace = {
      remediateReviewFindingsCalls: 0,
      reviewMilestoneCalls: 0,
      executeAndVerifyTaskCalls: [],
    };

    // Install base mocks (executor, verifier, analyzer, _collectMilestoneContext)
    installMocks(pipeline, { reviewerResult: failedReviewerResult, analyzerRecommendation: 'retry' });

    // Override reviewer to fail on first call and pass on second
    pipeline.reviewer = {
      reviewMilestone: async () => {
        trace.reviewMilestoneCalls++;
        return trace.reviewMilestoneCalls === 1 ? failedReviewerResult : passedReviewerResult;
      },
    };

    // Mock planner with remediateReviewFindings — return the existing task so
    // mergeRemediationTasks sets it to 'pending' and the decomp loop finds it.
    const subMissionId = `${missionId}-001`;
    pipeline.planner = {
      remediateReviewFindings: async (_msId, _findings, _root) => {
        trace.remediateReviewFindingsCalls++;
        return {
          newTasks: [{
            id: taskId,
            subMissionId,
            description: 'fix critical finding',
            targetFiles: [],
          }],
        };
      },
    };

    // Spy on _executeAndVerifyTask to track fix-task execution. Mirror the real
    // method by transitioning the remediation task to a terminal state in mission
    // state — otherwise the milestone-advance invariant (assertNoNonTerminalTasks,
    // added in 0466cf0) sees the freshly-merged 'pending' fix task and throws.
    pipeline._executeAndVerifyTask = async (mId, smId, task) => {
      trace.executeAndVerifyTaskCalls.push(task.id);
      const stateFile = path.join(harnessDir, 'state', `mission-${mId}.json`);
      const ms = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const t = ms.subMissions[smId]?.tasks[task.id];
      if (t) {
        t.status = 'complete';
        fs.writeFileSync(stateFile, JSON.stringify(ms, null, 2));
        // A real _executeAndVerifyTask runs the verifier, which writes a PASSED
        // sidecar before the task reaches 'complete'. Seed one for the merged
        // remediation fix task so the Phase-5 audit does not throw on it.
        seedPassedSidecars(harnessDir, ms);
      }
    };

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    // Should complete without throwing — re-review passes
    await pipeline._executeMilestone(milestoneId, msState);

    assert.strictEqual(
      trace.remediateReviewFindingsCalls,
      1,
      `Expected planner.remediateReviewFindings called once; got ${trace.remediateReviewFindingsCalls}`
    );
    assert.ok(
      trace.executeAndVerifyTaskCalls.length > 0,
      `Expected fix tasks to be executed via _executeAndVerifyTask; got 0 calls`
    );
    assert.strictEqual(
      trace.reviewMilestoneCalls,
      2,
      `Expected reviewer.reviewMilestone called twice (initial fail + re-review pass); got ${trace.reviewMilestoneCalls}`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('TC-retry-2: retry cap exhaustion — throws explicit escalation error with descriptive message', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    const criticalFinding = {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/foo.js',
      description: 'persistent issue requiring human intervention',
      relatedFiles: [],
    };

    const failedReviewerResult = {
      passed: false,
      findings: [criticalFinding],
      structured: { result: 'FAILED', findings: [criticalFinding], notes: '' },
      reportPath: '',
    };

    // Pre-seed retry counter to the cap so the next attempt is rejected
    const reviewRetryFile = path.join(harnessDir, 'analysis', `review-retry-${milestoneId}.json`);
    const maxRetries = config.maxRetries ?? 2;
    fs.writeFileSync(reviewRetryFile, JSON.stringify({ count: maxRetries }));

    installMocks(pipeline, { reviewerResult: failedReviewerResult, analyzerRecommendation: 'retry' });

    // Planner mock (should not be reached — cap check fires first)
    pipeline.planner = {
      remediateReviewFindings: async () => ({ newTasks: [] }),
    };

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let thrownError = null;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError, 'Expected pipeline to throw when retry cap is exhausted');

    // Verify the error message is descriptive (cap exhaustion + human intervention)
    const msg = thrownError.message;
    assert.ok(
      msg.includes('exhausted') || msg.includes('cap'),
      `Expected "exhausted" or "cap" in escalation error. Got: ${msg}`
    );
    assert.ok(
      msg.toLowerCase().includes('human'),
      `Expected "human" in escalation error message. Got: ${msg}`
    );

    // Verify the persisted counter is still at the cap (not beyond it)
    const persistedState = JSON.parse(fs.readFileSync(reviewRetryFile, 'utf8'));
    assert.strictEqual(
      persistedState.count,
      maxRetries,
      `Expected persisted retry counter to equal the cap (${maxRetries}); got ${persistedState.count}`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('TC-retry-3: empty newTasks increments persisted counter before throwing', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    const criticalFinding = {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/foo.js',
      description: 'unresolvable — planner returns no fix tasks',
      relatedFiles: [],
    };

    const failedReviewerResult = {
      passed: false,
      findings: [criticalFinding],
      structured: { result: 'FAILED', findings: [criticalFinding], notes: '' },
      reportPath: '',
    };

    installMocks(pipeline, { reviewerResult: failedReviewerResult, analyzerRecommendation: 'retry' });

    // Planner returns empty newTasks — should increment counter before throwing
    pipeline.planner = {
      remediateReviewFindings: async () => ({ newTasks: [] }),
    };

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let thrownError = null;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError, 'Expected pipeline to throw when remediation produces no fix tasks');

    // Verify counter file was written (counter was NOT left at 0)
    const reviewRetryFile = path.join(harnessDir, 'analysis', `review-retry-${milestoneId}.json`);
    assert.ok(
      fs.existsSync(reviewRetryFile),
      `Expected retry counter file to exist at ${reviewRetryFile} after empty-newTasks path`
    );

    const persistedState = JSON.parse(fs.readFileSync(reviewRetryFile, 'utf8'));
    assert.ok(
      persistedState.count > 0,
      `Expected retry counter to be incremented (> 0); got ${persistedState.count}`
    );
    assert.strictEqual(
      persistedState.count,
      1,
      `Expected retry counter to be 1 (incremented from 0 → 1); got ${persistedState.count}`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

// ── Guard path tests ─────────────────────────────────────────────────

await test('TC-guard-1: reviewer FAILED with isStub:true and empty findings → throws SDK/network/credit diagnostic, counter NOT incremented', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    const stubReviewerResult = {
      passed: false,
      findings: [],
      structured: { result: 'FAILED', findings: [], notes: '', isStub: true },
      reportPath: '',
    };

    installMocks(pipeline, { reviewerResult: stubReviewerResult, analyzerRecommendation: 'retry' });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let thrownError = null;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError, 'Expected pipeline to throw when reviewer returns a stub response');

    const msg = thrownError.message;
    const hasDiagnostic =
      msg.includes('SDK') ||
      msg.toLowerCase().includes('network') ||
      msg.toLowerCase().includes('credit');
    assert.ok(
      hasDiagnostic,
      `Expected "SDK", "network", or "credit" in thrown error message. Got: ${msg}`
    );

    // Retry counter file must NOT be created (counter not incremented)
    const reviewRetryFile = path.join(harnessDir, 'analysis', `review-retry-${milestoneId}.json`);
    assert.ok(
      !fs.existsSync(reviewRetryFile),
      `Expected retry counter file NOT to exist (stub path must not increment counter); file found at ${reviewRetryFile}`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('TC-guard-2: reviewer FAILED with one warning finding (no criticals, no isStub) → throws with "1 warning" in message, counter NOT incremented', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    const warningFinding = {
      severity: 'warning',
      category: 'style',
      file: 'src/foo.js',
      description: 'consider extracting this helper function',
      relatedFiles: [],
    };

    const warningOnlyFailedResult = {
      passed: false,
      findings: [warningFinding],
      structured: { result: 'FAILED', findings: [warningFinding], notes: '' },
      reportPath: '',
    };

    installMocks(pipeline, { reviewerResult: warningOnlyFailedResult, analyzerRecommendation: 'retry' });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let thrownError = null;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError, 'Expected pipeline to throw when reviewer FAILED with warnings-only findings');

    const msg = thrownError.message;
    assert.ok(
      msg.includes('1 warning'),
      `Expected "1 warning" in thrown error message. Got: ${msg}`
    );

    // Retry counter file must NOT be created (counter not incremented)
    const reviewRetryFile = path.join(harnessDir, 'analysis', `review-retry-${milestoneId}.json`);
    assert.ok(
      !fs.existsSync(reviewRetryFile),
      `Expected retry counter file NOT to exist (warnings-only path must not increment counter); file found at ${reviewRetryFile}`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('TC-guard-3: reviewer FAILED with empty findings and no isStub → throws "no actionable" diagnostic, counter NOT incremented', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    const emptyJudgmentResult = {
      passed: false,
      findings: [],
      structured: { result: 'FAILED', findings: [], notes: '' },
      reportPath: '',
    };

    installMocks(pipeline, { reviewerResult: emptyJudgmentResult, analyzerRecommendation: 'retry' });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let thrownError = null;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError, 'Expected pipeline to throw when reviewer FAILED with empty findings and no isStub');

    const msg = thrownError.message;
    assert.ok(
      msg.includes('no actionable') || msg.includes('actionable'),
      `Expected "no actionable" or "actionable" in thrown error message. Got: ${msg}`
    );

    // Retry counter file must NOT be created (counter not incremented)
    const reviewRetryFile = path.join(harnessDir, 'analysis', `review-retry-${milestoneId}.json`);
    assert.ok(
      !fs.existsSync(reviewRetryFile),
      `Expected retry counter file NOT to exist (empty-findings path must not increment counter); file found at ${reviewRetryFile}`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

// ── Scope / exceededFiles tests ──────────────────────────────────────

/**
 * Build a minimal harness for _collectMilestoneContext scope tests.
 *
 * Structure:
 *   milestone '001'
 *     └─ mission '001-001'  (stateFile → .harness/state/mission-001-001.json)
 *          ├─ subMission '001-001-001'
 *          │    ├─ task '001-001-001-001'  (targetFiles: sm1task1TargetFiles)
 *          │    └─ task '001-001-001-002'  (targetFiles: sm1task2TargetFiles)
 *          └─ subMission '001-001-002'
 *               ├─ task '001-001-002-001'  (targetFiles: sm2task1TargetFiles)
 *               └─ task '001-001-002-002'  (targetFiles: sm2task2TargetFiles)
 *
 * Progress sidecars are written with the provided affectedFiles arrays.
 */
function createScopeHarness({
  sm1task1TargetFiles = [],
  sm1task2TargetFiles = [],
  sm2task1TargetFiles = [],
  sm2task2TargetFiles = [],
  sm1task1AffectedFiles = [],
  sm1task2AffectedFiles = [],
  sm2task1AffectedFiles = [],
  sm2task2AffectedFiles = [],
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-scope-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'placeholder.js'), '// placeholder\n');

  const milestoneId = '001';
  const missionId   = '001-001';
  const sm1Id       = '001-001-001';
  const sm2Id       = '001-001-002';
  const t1Id        = '001-001-001-001';
  const t2Id        = '001-001-001-002';
  const t3Id        = '001-001-002-001';
  const t4Id        = '001-001-002-002';

  // Progress sidecars — only write if affectedFiles provided
  const writeSidecar = (taskId, affectedFiles) => {
    fs.writeFileSync(
      path.join(harnessDir, 'progress', `task-${taskId}.json`),
      JSON.stringify({
        taskId,
        status: 'COMPLETE',
        affectedFiles: affectedFiles.map(p => ({ path: p })),
        summary: 'done',
        testsSummary: '',
      })
    );
  };
  writeSidecar(t1Id, sm1task1AffectedFiles);
  writeSidecar(t2Id, sm1task2AffectedFiles);
  writeSidecar(t3Id, sm2task1AffectedFiles);
  writeSidecar(t4Id, sm2task2AffectedFiles);

  // Per-mission state file (this is what _collectMilestoneContext reads)
  const missionState = {
    subMissions: {
      [sm1Id]: {
        id: sm1Id,
        description: 'sub-mission 1',
        status: 'complete',
        tasks: {
          [t1Id]: {
            id: t1Id,
            description: 'task 1',
            status: 'complete',
            targetFiles: sm1task1TargetFiles,
          },
          [t2Id]: {
            id: t2Id,
            description: 'task 2',
            status: 'complete',
            targetFiles: sm1task2TargetFiles,
          },
        },
      },
      [sm2Id]: {
        id: sm2Id,
        description: 'sub-mission 2',
        status: 'complete',
        tasks: {
          [t3Id]: {
            id: t3Id,
            description: 'task 3',
            status: 'complete',
            targetFiles: sm2task1TargetFiles,
          },
          [t4Id]: {
            id: t4Id,
            description: 'task 4',
            status: 'complete',
            targetFiles: sm2task2TargetFiles,
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
  const globalState = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId,
        description: 'milestone 001',
        status: 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: {
          [missionId]: {
            id: missionId,
            description: 'mission 001-001',
            status: 'complete',
            stateFile: `.harness/state/mission-${missionId}.json`,
            planFile: `.harness/plan/mission-${missionId}.md`,
          },
        },
      },
    },
  };

  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  return { projectRoot, harnessDir, milestoneId };
}

await test('TC-scope-1: _collectMilestoneContext returns specScopeFiles as deduped union of targetFiles across 4 tasks', async () => {
  const { projectRoot, milestoneId } = createScopeHarness({
    // Sub-mission 1: task1 and task2 share src/b.js
    sm1task1TargetFiles: ['src/a.js', 'src/b.js'],
    sm1task2TargetFiles: ['src/b.js', 'src/c.js'],
    // Sub-mission 2: task3 and task4 also reference already-scoped files
    sm2task1TargetFiles: ['src/a.js'],
    sm2task2TargetFiles: ['src/c.js'],
    // All tasks affect only their targetFiles (no exceeded)
    sm1task1AffectedFiles: ['src/a.js'],
    sm1task2AffectedFiles: ['src/b.js'],
    sm2task1AffectedFiles: ['src/c.js'],
    sm2task2AffectedFiles: [],
  });

  const pipeline = new Pipeline(projectRoot, { onLog: () => {}, onConfirm: async () => true });
  // Skip expensive import-graph scan
  pipeline._cachedImportGraph = '';

  try {
    const ctx = pipeline._collectMilestoneContext(milestoneId);

    assert.ok(Array.isArray(ctx.specScopeFiles), 'specScopeFiles should be an array');

    // Exactly 3 distinct files after dedup
    assert.strictEqual(
      ctx.specScopeFiles.length,
      3,
      `Expected 3 specScopeFiles after dedup; got ${ctx.specScopeFiles.length}. Files: ${ctx.specScopeFiles.join(', ')}`
    );

    // All three expected files must be present
    for (const f of ['src/a.js', 'src/b.js', 'src/c.js']) {
      assert.ok(
        ctx.specScopeFiles.includes(f),
        `Expected "${f}" in specScopeFiles. Got: ${ctx.specScopeFiles.join(', ')}`
      );
    }

    // src/b.js must appear exactly once (dedup verified)
    const bCount = ctx.specScopeFiles.filter(f => f === 'src/b.js').length;
    assert.strictEqual(
      bCount,
      1,
      `Expected src/b.js to appear exactly once in specScopeFiles (dedup); got ${bCount}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC-scope-2: exceededFiles is empty when all modifiedFiles are within specScopeFiles', async () => {
  const { projectRoot, milestoneId } = createScopeHarness({
    sm1task1TargetFiles: ['src/a.js', 'src/b.js'],
    sm1task2TargetFiles: ['src/b.js', 'src/c.js'],
    sm2task1TargetFiles: ['src/a.js'],
    sm2task2TargetFiles: ['src/c.js'],
    // All affected files are within targetFiles — no exceeded
    sm1task1AffectedFiles: ['src/a.js'],
    sm1task2AffectedFiles: ['src/b.js', 'src/c.js'],
    sm2task1AffectedFiles: ['src/a.js'],
    sm2task2AffectedFiles: ['src/c.js'],
  });

  const pipeline = new Pipeline(projectRoot, { onLog: () => {}, onConfirm: async () => true });
  pipeline._cachedImportGraph = '';

  try {
    const ctx = pipeline._collectMilestoneContext(milestoneId);

    assert.ok(Array.isArray(ctx.exceededFiles), 'exceededFiles should be an array');
    assert.strictEqual(
      ctx.exceededFiles.length,
      0,
      `Expected exceededFiles to be empty when all modifiedFiles ⊆ specScopeFiles; got [${ctx.exceededFiles.join(', ')}]`
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC-scope-3: exceededFiles contains src/extra.js when progress sidecar has a file outside targetFiles', async () => {
  const { projectRoot, milestoneId } = createScopeHarness({
    sm1task1TargetFiles: ['src/a.js', 'src/b.js'],
    sm1task2TargetFiles: ['src/b.js', 'src/c.js'],
    sm2task1TargetFiles: ['src/a.js'],
    sm2task2TargetFiles: ['src/c.js'],
    // task1 affected src/extra.js which is NOT in any targetFiles
    sm1task1AffectedFiles: ['src/a.js', 'src/extra.js'],
    sm1task2AffectedFiles: ['src/b.js'],
    sm2task1AffectedFiles: [],
    sm2task2AffectedFiles: [],
  });

  const pipeline = new Pipeline(projectRoot, { onLog: () => {}, onConfirm: async () => true });
  pipeline._cachedImportGraph = '';

  try {
    const ctx = pipeline._collectMilestoneContext(milestoneId);

    assert.ok(Array.isArray(ctx.exceededFiles), 'exceededFiles should be an array');
    assert.ok(
      ctx.exceededFiles.includes('src/extra.js'),
      `Expected 'src/extra.js' in exceededFiles. Got: [${ctx.exceededFiles.join(', ')}]`
    );
    // Sanity: files within scope should NOT appear in exceededFiles
    for (const inScope of ['src/a.js', 'src/b.js']) {
      assert.ok(
        !ctx.exceededFiles.includes(inScope),
        `Expected '${inScope}' NOT in exceededFiles (it's within targetFiles). Got: [${ctx.exceededFiles.join(', ')}]`
      );
    }
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC-scope-4: path normalization — ./src/foo.js in targetFiles matches src/foo.js in progress sidecar (not in exceededFiles)', async () => {
  const { projectRoot, milestoneId } = createScopeHarness({
    // targetFiles uses the ./src/foo.js prefix form
    sm1task1TargetFiles: ['./src/foo.js'],
    sm1task2TargetFiles: [],
    sm2task1TargetFiles: [],
    sm2task2TargetFiles: [],
    // Progress sidecar uses the bare src/foo.js form
    sm1task1AffectedFiles: ['src/foo.js'],
    sm1task2AffectedFiles: [],
    sm2task1AffectedFiles: [],
    sm2task2AffectedFiles: [],
  });

  const pipeline = new Pipeline(projectRoot, { onLog: () => {}, onConfirm: async () => true });
  pipeline._cachedImportGraph = '';

  try {
    const ctx = pipeline._collectMilestoneContext(milestoneId);

    // specScopeFiles should contain the normalized form (without ./)
    assert.ok(
      ctx.specScopeFiles.includes('src/foo.js'),
      `Expected normalized 'src/foo.js' in specScopeFiles. Got: [${ctx.specScopeFiles.join(', ')}]`
    );

    // src/foo.js from the sidecar must NOT appear in exceededFiles because ./src/foo.js normalizes to src/foo.js
    assert.ok(
      !ctx.exceededFiles.includes('src/foo.js'),
      `Expected 'src/foo.js' NOT in exceededFiles (./src/foo.js should normalize to match). Got: [${ctx.exceededFiles.join(', ')}]`
    );

    assert.strictEqual(
      ctx.exceededFiles.length,
      0,
      `Expected exceededFiles to be empty after path normalization; got [${ctx.exceededFiles.join(', ')}]`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── Pipeline-level edge case tests ──────────────────────────────────

await test('TC-empty-target: _collectMilestoneContext returns specScopeFiles=[] and exceededFiles===modifiedFiles when all tasks have empty targetFiles', async () => {
  // Fixture: 1 mission, 1 sub-mission, 1 task with targetFiles: []
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-empty-target-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'placeholder.js'), '// placeholder\n');

  const milestoneId = '001';
  const missionId   = '001-001';
  const smId        = '001-001-001';
  const taskId      = '001-001-001-001';

  // Progress sidecar with modified files — task touched src/modified.js
  fs.writeFileSync(
    path.join(harnessDir, 'progress', `task-${taskId}.json`),
    JSON.stringify({
      taskId,
      status: 'COMPLETE',
      affectedFiles: [{ path: 'src/modified.js' }, { path: 'src/other.js' }],
      summary: 'done',
      testsSummary: '',
    })
  );

  // Per-mission state: task has targetFiles: [] (empty)
  const missionState = {
    subMissions: {
      [smId]: {
        id: smId,
        description: 'sub-mission 1',
        status: 'complete',
        tasks: {
          [taskId]: {
            id: taskId,
            description: 'task with empty targetFiles',
            status: 'complete',
            targetFiles: [],
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
  const globalState = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId,
        description: 'milestone 001',
        status: 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: {
          [missionId]: {
            id: missionId,
            description: 'mission 001-001',
            status: 'complete',
            stateFile: `.harness/state/mission-${missionId}.json`,
            planFile: `.harness/plan/mission-${missionId}.md`,
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  const pipeline = new Pipeline(projectRoot, { onLog: () => {}, onConfirm: async () => true });
  pipeline._cachedImportGraph = '';

  try {
    const ctx = pipeline._collectMilestoneContext(milestoneId);

    // specScopeFiles must be empty — no task declared any targetFiles
    assert.ok(Array.isArray(ctx.specScopeFiles), 'specScopeFiles should be an array');
    assert.strictEqual(
      ctx.specScopeFiles.length,
      0,
      `Expected specScopeFiles to be [] when all tasks have empty targetFiles; got [${ctx.specScopeFiles.join(', ')}]`
    );

    // exceededFiles must equal modifiedFiles — every modified file exceeds scope when no target declared
    assert.ok(Array.isArray(ctx.exceededFiles), 'exceededFiles should be an array');
    assert.deepStrictEqual(
      ctx.exceededFiles.slice().sort(),
      ctx.modifiedFiles.slice().sort(),
      `Expected exceededFiles to equal modifiedFiles when specScopeFiles is empty.\n` +
      `exceededFiles: [${ctx.exceededFiles.join(', ')}]\n` +
      `modifiedFiles: [${ctx.modifiedFiles.join(', ')}]`
    );
    assert.ok(
      ctx.modifiedFiles.length > 0,
      'Sanity: modifiedFiles should be non-empty (progress sidecar has affected files)'
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC-missing-spec: scopeContext.specGoal === \'\' when prdPath points to non-existent file', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    // Update state.json so prdPath points to a non-existent file
    const stateJsonPath = path.join(harnessDir, 'state.json');
    const globalState = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
    globalState.projectMeta.prdPath = '/tmp/does-not-exist-spec.md';
    fs.writeFileSync(stateJsonPath, JSON.stringify(globalState, null, 2));

    const reviewerResult = {
      passed: true,
      findings: [],
      structured: { result: 'PASSED', findings: [], notes: '' },
      reportPath: '',
    };

    // installMocks sets up base mocks including _collectMilestoneContext stub
    installMocks(pipeline, { reviewerResult });

    // Override reviewer to capture the 7th scopeContext argument
    let capturedScopeContext = null;
    pipeline.reviewer = {
      reviewMilestone: async (_msId, _modFiles, _taskDescs, _importGraph, _root, _harnessDir, scopeContext) => {
        capturedScopeContext = scopeContext;
        return reviewerResult;
      },
    };

    const msState = globalState.milestones[milestoneId];
    await pipeline._executeMilestone(milestoneId, msState);

    assert.ok(capturedScopeContext !== null, 'Expected reviewer.reviewMilestone to be called with a scopeContext');
    assert.strictEqual(
      capturedScopeContext.specGoal,
      '',
      `Expected scopeContext.specGoal to be '' when prdPath points to non-existent file; got: "${capturedScopeContext.specGoal}"`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('TC-criteria-flow: spec.json with acceptance_criteria → reviewer receives them in scopeContext', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    // Write a sibling spec.json carrying acceptance_criteria + goal, and point
    // projectMeta.prdPath at the sibling .md so deriveSpecJsonPath resolves to it.
    const specMdPath = path.join(projectRoot, 'feature-spec.md');
    const specJsonPath = path.join(projectRoot, 'feature-spec.json');
    fs.writeFileSync(specMdPath, '# Feature spec\n');
    // The file-check criterion below is now actually enforced by the spec
    // criteria drain (spec-criteria-drain) at the last milestone — the
    // fixture must satisfy it or _executeMilestone throws SpecCriterionError.
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Docs\n');
    const criteria = [
      {
        description: 'The endpoint returns 200 for valid input.',
        verification: { kind: 'command', command: 'node test/test-endpoint.js', targetFile: 'test/test-endpoint.js' },
      },
      {
        description: 'The config flag is documented.',
        verification: { kind: 'file-check', targetFile: 'README.md' },
      },
    ];
    fs.writeFileSync(specJsonPath, JSON.stringify({
      goal: 'Add the new endpoint with documentation.',
      acceptance_criteria: criteria,
    }, null, 2));

    const stateJsonPath = path.join(harnessDir, 'state.json');
    const globalState = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
    globalState.projectMeta.prdPath = specMdPath;
    fs.writeFileSync(stateJsonPath, JSON.stringify(globalState, null, 2));

    const reviewerResult = {
      passed: true,
      findings: [],
      structured: { result: 'PASSED', findings: [], notes: '' },
      reportPath: '',
    };

    installMocks(pipeline, { reviewerResult });

    // Capture the scopeContext the gate hands to reviewMilestone (7th arg).
    let capturedScopeContext = null;
    pipeline.reviewer = {
      reviewMilestone: async (_msId, _modFiles, _taskDescs, _importGraph, _root, _harnessDir, scopeContext) => {
        capturedScopeContext = scopeContext;
        return reviewerResult;
      },
    };

    const msState = globalState.milestones[milestoneId];
    await pipeline._executeMilestone(milestoneId, msState);

    assert.ok(capturedScopeContext !== null, 'Expected reviewer.reviewMilestone to be called with a scopeContext');
    assert.ok(
      Array.isArray(capturedScopeContext.acceptanceCriteria),
      'Expected scopeContext.acceptanceCriteria to be an array'
    );
    assert.strictEqual(
      capturedScopeContext.acceptanceCriteria.length,
      criteria.length,
      `Expected ${criteria.length} acceptanceCriteria to flow into scopeContext; got ${capturedScopeContext.acceptanceCriteria.length}`
    );
    assert.deepStrictEqual(
      capturedScopeContext.acceptanceCriteria,
      criteria,
      'Expected scopeContext.acceptanceCriteria to match the spec.json acceptance_criteria verbatim'
    );
    assert.strictEqual(
      capturedScopeContext.specGoal,
      'Add the new endpoint with documentation.',
      `Expected scopeContext.specGoal to come from spec.json.goal; got: "${capturedScopeContext.specGoal}"`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('TC-criteria-failsoft: no spec.json → scopeContext.acceptanceCriteria=[] and gate behaves unchanged', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    // The default harness has prdPath:'' and no spec.json → readers fail-soft.
    const reviewerResult = {
      passed: true,
      findings: [],
      structured: { result: 'PASSED', findings: [], notes: '' },
      reportPath: '',
    };

    const trace = installMocks(pipeline, { reviewerResult });

    // Capture scopeContext while still proceeding to regression via the mock.
    let capturedScopeContext = null;
    pipeline.reviewer = {
      reviewMilestone: async (_msId, _modFiles, _taskDescs, _importGraph, _root, _harnessDir, scopeContext) => {
        capturedScopeContext = scopeContext;
        return reviewerResult;
      },
    };

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    // Must not throw — fail-soft means the gate runs exactly as before.
    await pipeline._executeMilestone(milestoneId, msState);

    assert.ok(capturedScopeContext !== null, 'Expected reviewer.reviewMilestone to be called with a scopeContext');
    assert.ok(
      Array.isArray(capturedScopeContext.acceptanceCriteria),
      'Expected scopeContext.acceptanceCriteria to be an array even with no spec.json'
    );
    assert.strictEqual(
      capturedScopeContext.acceptanceCriteria.length,
      0,
      `Expected scopeContext.acceptanceCriteria=[] with no spec.json (fail-soft); got ${capturedScopeContext.acceptanceCriteria.length}`
    );

    // No regression: PASSED reviewer with no criteria still proceeds to regression.
    assert.strictEqual(
      trace.verifyMilestoneCalls,
      1,
      `Expected verifyMilestone called once (fail-soft, unchanged behavior); got ${trace.verifyMilestoneCalls}`
    );
    assert.strictEqual(
      trace.analyzeFailureCalls,
      0,
      `Expected analyzeFailure NOT called on PASSED no-criteria path; got ${trace.analyzeFailureCalls}`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('TC-no-remediation: analyzer.analyzeFailure NOT called when reviewResult.passed===true with exceeded_scope verdict', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    // passed: true with exceeded_scope — advisory-only, must not enter remediation path
    const reviewerResult = {
      passed: true,
      findings: [],
      structured: {
        result: 'PASSED',
        findings: [],
        notes: 'scope advisory',
        scopeCompliance: {
          verdict: 'exceeded_scope',
          evidence: 'executor touched files outside targetFiles',
          exceededFiles: ['src/extra.js'],
        },
      },
      reportPath: '',
    };

    const trace = installMocks(pipeline, { reviewerResult });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    // Should NOT throw — passed: true means reviewer gate is satisfied
    await pipeline._executeMilestone(milestoneId, msState);

    // analyzeFailure must NOT have been called (exceeded_scope is advisory-only)
    assert.strictEqual(
      trace.analyzeFailureCalls,
      0,
      `Expected analyzer.analyzeFailure NOT called when passed=true with exceeded_scope; got ${trace.analyzeFailureCalls} calls`
    );

    // No review-retry counter file should exist
    const reviewRetryFile = path.join(harnessDir, 'analysis', `review-retry-${milestoneId}.json`);
    assert.ok(
      !fs.existsSync(reviewRetryFile),
      `Expected no review-retry-${milestoneId}.json to exist (exceeded_scope with passed=true is advisory-only); file found at ${reviewRetryFile}`
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
