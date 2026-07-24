/**
 * test-circuit-breaker-human-escalation-routing.js
 *
 * Bug L84 — milestone/mission HUMAN escalations must raise a typed
 * CircuitBreakerError (recommendation 'human'), NOT a plain Error.
 *
 * Why this matters (live regression failed-135): the milestone execution path
 * must signal human-intervention escalations in a form that batchResume routes
 * to a RESOLVABLE park (queue status 'halted-analyzer'). batchResume classifies
 * an analyzer-human-halt as:
 *
 *     (err instanceof CircuitBreakerError || err.cause instanceof CircuitBreakerError)
 *     && (recommendation === 'human' || escalatedByRepeat === true)
 *
 * A PLAIN Error fails that test and falls through to the 'failed-execution'
 * path, which runs `git reset --hard` — destroying correct work and leaving an
 * unresolvable status (terminal says "human intervention", park list is empty).
 *
 * This test derives its assertions FROM THE BEHAVIORAL SPEC, not from the fix
 * implementation. It drives each escalation site with a stubbed analyzer/reviewer
 * returning a 'human' recommendation (or a failing re-review) and asserts the
 * thrown error is:
 *   - instanceof CircuitBreakerError
 *   - .recommendation === 'human'
 *   - message starts with 'Circuit breaker:'
 *
 * Covered escalation sites (per spec):
 *   TC1 — milestone REVIEWER gate, analyzer recommends 'human'        (site 1)
 *   TC2 — milestone reviewer gate FAILS after remediation (hard stop) (site 2)
 *   TC3 — milestone REGRESSION remediation, analyzer recommends 'human' (site 3)
 *   TC4 — mission REGRESSION, analyzer recommends 'human'              (site 4)
 *
 * Plus a batchResume-routing classification sanity check (TC5): the spec's
 * predicate, applied to the error these sites throw, yields 'halted-analyzer';
 * applied to a plain Error, it does NOT — i.e. the routing outcome the typed
 * error unlocks vs. the destructive failed-execution fall-through.
 *
 * How it discriminates the fix from pre-fix plain-Error behavior:
 *   Every assertion would be VIOLATED by a plain `Error`:
 *     - `err instanceof CircuitBreakerError` is false for a plain Error.
 *     - a plain Error has no `.recommendation` field (undefined !== 'human').
 *   So a build that threw plain Errors at these sites would FAIL this test; only
 *   the typed CircuitBreakerError(recommendation:'human') with the 'Circuit
 *   breaker:' prefix passes. TC5 makes the consequence explicit: the typed error
 *   routes to 'halted-analyzer' (resolvable), the plain Error does not (it would
 *   take the failed-execution + git-reset path).
 *
 * Run: node test/test-circuit-breaker-human-escalation-routing.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { CircuitBreakerError } from '../src/orchestrator/core/circuit-breaker-error.js';

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

// ── Fixture helpers (mirrors test-pipeline-milestone-regression-remediation) ──

/**
 * Temp project root with .harness structure, a global state.json (milestone
 * in_progress, one mission complete), and a per-mission state file whose single
 * task is complete. This is the minimum the milestone/mission gates need to walk
 * to the regression/reviewer escalation sites.
 */
function createHarness({ milestoneId = '001', missionId = '001-001' } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-human-escalation-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const taskId = `${missionId}-001-001`;
  const subMissionId = `${missionId}-001`;

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
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-${taskId}.json`),
    JSON.stringify({
      taskId, verified: true, report: 'fake verifier report', result: 'PASSED',
      hardChecks: [], taskScopeChecks: [], notes: null,
    })
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: ['src/foo.js'], hardChecks: [], testCases: [] })
  );

  const srcDir = path.join(projectRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'foo.js'), '// src/foo.js\n');

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

  const globalState = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
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
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  return { projectRoot, harnessDir, milestoneId, missionId, taskId, subMissionId };
}

function cleanup(projectRoot) {
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makePipeline(projectRoot, extraOpts = {}) {
  const logs = [];
  const confirmCalls = [];
  const pipeline = new Pipeline(projectRoot, {
    noReview: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async (question) => { confirmCalls.push(question); return extraOpts.confirmAnswer ?? true; },
    ...extraOpts,
  });
  return { pipeline, logs, confirmCalls };
}

// Verifier whose regression-* tasks always fail (verified=false). Combined with
// `npm test` being non-zero in a bare tmpdir, verifyMilestone/verifyMission take
// the standard FAIL path (passed=false, not soft-pass, not stub).
function makeFailingVerifier() {
  return {
    verifyRegression: async () => ({
      verified: false,
      report: 'FAILED: mock regression failure',
      structured: { verified: false },
    }),
  };
}

function makeAnalyzer(recommendation) {
  return {
    analyzeFailure: async () => ({
      eventId: 'mock-event-001',
      recommendation,
      affectedTasks: [],
      rootCause: 'mock root cause',
      evidence: 'mock evidence',
    }),
  };
}

/** Assert an error matches the spec's required typed-escalation shape. */
function assertHumanCircuitBreaker(thrownError) {
  assert.ok(thrownError, 'Expected an error to be thrown');
  assert.ok(
    thrownError instanceof CircuitBreakerError,
    `Expected thrown error to be a CircuitBreakerError; got ${thrownError?.constructor?.name}: ${thrownError?.message}`
  );
  assert.strictEqual(
    thrownError.recommendation,
    'human',
    `Expected .recommendation === 'human'; got ${JSON.stringify(thrownError.recommendation)}`
  );
  assert.ok(
    typeof thrownError.message === 'string' && thrownError.message.startsWith('Circuit breaker:'),
    `Expected message to start with 'Circuit breaker:'; got: ${thrownError.message}`
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {

// TC1 — milestone REVIEWER gate, analyzer recommends 'human' (site 1)
await test('TC1: milestone reviewer gate, analyzer human -> CircuitBreakerError(human)', async () => {
  const { projectRoot, harnessDir, milestoneId } = createHarness();
  // Reviewer ENABLED (noReview:false) so the reviewer gate runs.
  const { pipeline } = makePipeline(projectRoot, { noReview: false });

  try {
    pipeline.reviewer = {
      reviewMilestone: async () => ({
        passed: false,
        findings: [{ severity: 'critical', summary: 'mock critical finding', file: 'src/foo.js' }],
      }),
    };
    pipeline.analyzer = makeAnalyzer('human');
    pipeline.verifier = makeFailingVerifier();
    pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
    // Suppress the per-mission regression gate (Phase C inside
    // _executeMilestoneParallel) so control reaches the MILESTONE reviewer gate
    // under test — otherwise the mission regression (site 4) would escalate first.
    pipeline._missionRegression = async () => {};
    pipeline._collectMilestoneContext = () => ({
      modifiedFiles: [], taskDescriptions: [], importGraph: '', specScopeFiles: [], exceededFiles: [],
    });
    pipeline._getSpecGoal = () => '';
    pipeline._getSpecAcceptanceCriteria = () => [];

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let thrownError = null;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch (err) {
      thrownError = err instanceof CircuitBreakerError ? err
        : (err?.cause instanceof CircuitBreakerError ? err.cause : err);
    }
    assertHumanCircuitBreaker(thrownError);
  } finally {
    cleanup(projectRoot);
  }
});

// TC2 — milestone reviewer gate FAILS after remediation, hard stop (site 2)
await test('TC2: reviewer gate fails after remediation -> CircuitBreakerError(human)', async () => {
  const { projectRoot, harnessDir, milestoneId, missionId } = createHarness();
  const { pipeline } = makePipeline(projectRoot, { noReview: false });

  try {
    // Reviewer FAILS on both the initial review and the re-review after
    // remediation -> the post-remediation hard-stop escalation must fire.
    pipeline.reviewer = {
      reviewMilestone: async () => ({
        passed: false,
        findings: [{ severity: 'critical', summary: 'persistent critical', file: 'src/foo.js' }],
      }),
    };
    // analyzer 'retry' -> enters per-mission remediation path (not the human
    // escalation at site 1), so control reaches the re-review hard-stop.
    pipeline.analyzer = makeAnalyzer('retry');
    pipeline.verifier = makeFailingVerifier();
    pipeline.planner = {
      // The reviewer-gate remediation path uses remediateReviewFindings and
      // requires at least one fix task so it proceeds to the re-review (which
      // also fails) -> the post-remediation hard-stop escalation fires.
      remediateReviewFindings: async (msId, findings, _root, _opts) => ({
        newTasks: [{
          id: `${missionId}-001-fix-1`,
          subMissionId: `${missionId}-001`,
          description: 'Fix reviewer finding',
          targetFiles: ['src/foo.js'],
        }],
      }),
    };
    pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
    pipeline._executeAndVerifyTask = async () => {};
    pipeline._missionRegression = async () => {};
    pipeline._collectMilestoneContext = () => ({
      modifiedFiles: [], taskDescriptions: [], importGraph: '', specScopeFiles: [], exceededFiles: [],
    });
    pipeline._getSpecGoal = () => '';
    pipeline._getSpecAcceptanceCriteria = () => [];

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let thrownError = null;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch (err) {
      thrownError = err instanceof CircuitBreakerError ? err
        : (err?.cause instanceof CircuitBreakerError ? err.cause : err);
    }
    assertHumanCircuitBreaker(thrownError);
  } finally {
    cleanup(projectRoot);
  }
});

// TC3 — milestone REGRESSION remediation, analyzer recommends 'human' (site 3)
await test('TC3: milestone regression, analyzer human -> CircuitBreakerError(human)', async () => {
  const { projectRoot, harnessDir, milestoneId } = createHarness();
  const { pipeline } = makePipeline(projectRoot); // noReview:true -> straight to regression gate

  try {
    pipeline.verifier = makeFailingVerifier();
    pipeline.analyzer = makeAnalyzer('human');
    pipeline.planner = { remediateRegressionFailure: async () => ({ newTasks: [] }) };
    pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
    pipeline._executeAndVerifyTask = async () => {};
    // Suppress the per-mission regression gate so the MILESTONE regression gate
    // (site 3) is the escalation under test, not the mission gate (site 4).
    pipeline._missionRegression = async () => {};
    pipeline._collectMilestoneContext = () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let thrownError = null;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch (err) {
      thrownError = err instanceof CircuitBreakerError ? err
        : (err?.cause instanceof CircuitBreakerError ? err.cause : err);
    }
    assertHumanCircuitBreaker(thrownError);
  } finally {
    cleanup(projectRoot);
  }
});

// TC4 — mission REGRESSION, analyzer recommends 'human' (site 4)
await test('TC4: mission regression, analyzer human -> CircuitBreakerError(human)', async () => {
  const { projectRoot, harnessDir, milestoneId, missionId } = createHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    pipeline.verifier = makeFailingVerifier();
    pipeline.analyzer = makeAnalyzer('human');
    pipeline.planner = { remediateScenarios: async () => ({ newTasks: [] }) };
    pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };

    const missionPlan = `mission ${missionId} plan body`;

    let thrownError = null;
    try {
      await pipeline._missionRegression(missionId, missionPlan);
    } catch (err) {
      thrownError = err instanceof CircuitBreakerError ? err
        : (err?.cause instanceof CircuitBreakerError ? err.cause : err);
    }
    assertHumanCircuitBreaker(thrownError);
  } finally {
    cleanup(projectRoot);
  }
});

// TC5 — batchResume routing predicate: typed error -> 'halted-analyzer';
//       plain Error -> NOT 'halted-analyzer' (the destructive fall-through).
// This is the spec's classification logic applied directly to discriminate the
// routing OUTCOME the typed error unlocks vs. what a plain Error would do.
await test('TC5: batchResume predicate routes typed human-breaker to halted-analyzer, not plain Error', async () => {
  // The classification predicate as specified for batchResume.
  const classify = (err) => {
    const breakerErr = err instanceof CircuitBreakerError
      ? err
      : (err?.cause instanceof CircuitBreakerError ? err.cause : null);
    const isAnalyzerHumanHalt = breakerErr !== null &&
      (breakerErr.recommendation === 'human' || breakerErr.escalatedByRepeat === true);
    return isAnalyzerHumanHalt ? 'halted-analyzer' : 'failed-execution';
  };

  // A human-escalation CircuitBreakerError, as the four sites throw it.
  const typed = new CircuitBreakerError(
    'Circuit breaker: Milestone 001 regression failed. Analyzer recommends human intervention.',
    { taskId: 'regression-ms-001', recommendation: 'human', eventId: 'mock-event-001' }
  );
  assert.strictEqual(
    classify(typed), 'halted-analyzer',
    'A human CircuitBreakerError must route to a RESOLVABLE halted-analyzer park'
  );

  // Same when wrapped as err.cause (scheduler stall-wrap case).
  const wrapped = new Error('Scheduler stalled');
  wrapped.cause = typed;
  assert.strictEqual(
    classify(wrapped), 'halted-analyzer',
    'A human CircuitBreakerError arriving via err.cause must still route to halted-analyzer'
  );

  // A PLAIN Error with the same message text would fall through to the
  // destructive failed-execution + git-reset path. This is exactly the pre-fix
  // behavior the fix corrects.
  const plain = new Error(
    'Circuit breaker: Milestone 001 regression failed. Analyzer recommends human intervention.'
  );
  assert.strictEqual(
    classify(plain), 'failed-execution',
    'A plain Error (pre-fix) routes to failed-execution — the destructive path L84 fixes'
  );
});

// ── Additional milestone reviewer-gate escalation sites ──────────────────────
//
// An adversarial review found four MORE human-intervention escalations on the
// SAME _executeMilestone reviewer-gate flow, all converted to
// CircuitBreakerError{recommendation:'human'} (message keeps 'Circuit breaker:').
// Each is driven end-to-end through _executeMilestone with stubbed
// reviewer/analyzer/planner; _missionRegression is suppressed so the milestone
// reviewer gate (not the per-mission regression site) is the escalation under
// test. Discrimination is identical to TC1-TC4: a plain Error would fail
// `instanceof CircuitBreakerError` and have no `.recommendation === 'human'`.
//
// NOTE: the "reviewer returned a stub response" path (SDK/network/credits) is
// DELIBERATELY a plain Error (separate infra-error concern) and is NOT covered
// here — asserting it threw CircuitBreakerError would be wrong.

/**
 * Shared reviewer-gate driver. Builds a Pipeline with the reviewer gate ENABLED,
 * stubs the dependencies the gate walks, runs _executeMilestone, and returns the
 * resolved thrown error (unwrapping a scheduler-stall err.cause if present).
 *
 * @param {object} opts
 * @param {object} opts.reviewerResult  what reviewer.reviewMilestone returns
 * @param {string} opts.recommendation  analyzer recommendation
 * @param {Array}  [opts.fixTasks]      newTasks remediateReviewFindings returns
 * @param {number} [opts.seedRetryCount] pre-seed review-retry-<msId>.json count
 */
async function driveReviewerGate({ reviewerResult, recommendation, fixTasks = [], seedRetryCount }) {
  const { projectRoot, harnessDir, milestoneId, missionId } = createHarness();
  const { pipeline } = makePipeline(projectRoot, { noReview: false });

  if (typeof seedRetryCount === 'number') {
    fs.writeFileSync(
      path.join(harnessDir, 'analysis', `review-retry-${milestoneId}.json`),
      JSON.stringify({ count: seedRetryCount })
    );
  }

  try {
    pipeline.reviewer = { reviewMilestone: async () => reviewerResult };
    pipeline.analyzer = makeAnalyzer(recommendation);
    pipeline.verifier = makeFailingVerifier();
    pipeline.planner = {
      remediateReviewFindings: async () => ({ newTasks: fixTasks }),
    };
    pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
    pipeline._executeAndVerifyTask = async () => {};
    pipeline._missionRegression = async () => {};
    pipeline._collectMilestoneContext = () => ({
      modifiedFiles: [], taskDescriptions: [], importGraph: '', specScopeFiles: [], exceededFiles: [],
    });
    pipeline._getSpecGoal = () => '';
    pipeline._getSpecAcceptanceCriteria = () => [];
    pipeline._getSpecTargetFiles = () => [];

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let thrownError = null;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch (err) {
      thrownError = err instanceof CircuitBreakerError ? err
        : (err?.cause instanceof CircuitBreakerError ? err.cause : err);
    }
    return { thrownError, missionId };
  } finally {
    cleanup(projectRoot);
  }
}

// TC6 — reviewer gate, analyzer returns an UNEXPECTED recommendation (site A).
// Not 'human'/'retry'/'re_plan' -> escalates. ('human' would hit the TC1 site
// first, so we use a value that is neither, e.g. 'abandon'.)
await test('TC6: reviewer gate, unexpected analyzer recommendation -> CircuitBreakerError(human)', async () => {
  const { thrownError } = await driveReviewerGate({
    reviewerResult: {
      passed: false,
      findings: [{ severity: 'critical', summary: 'mock critical', file: 'src/foo.js' }],
    },
    recommendation: 'abandon', // unexpected: not human/retry/re_plan
  });
  assertHumanCircuitBreaker(thrownError);
});

// TC7 — reviewer gate, remediation retry CAP exhausted (site B).
// Pre-seed the persisted review-retry counter at the cap (config.maxRetries is
// 3 -> reviewMaxRetries 3), analyzer 'retry' to pass the recommendation guard,
// so the cap check throws before any remediation.
await test('TC7: reviewer gate, retry cap exhausted -> CircuitBreakerError(human)', async () => {
  const { thrownError } = await driveReviewerGate({
    reviewerResult: {
      passed: false,
      findings: [{ severity: 'critical', summary: 'mock critical', file: 'src/foo.js' }],
    },
    recommendation: 'retry',
    seedRetryCount: 3, // >= reviewMaxRetries (config.maxRetries default 3)
  });
  assertHumanCircuitBreaker(thrownError);
});

// TC8 — reviewer gate, WARNINGS ONLY (site C).
// Reviewer !passed with zero critical findings (only warnings), not a stub ->
// human-review escalation. analyzer 'retry' + a fresh retry counter so the cap
// check passes and control reaches the criticalFindings.length === 0 branch.
await test('TC8: reviewer gate, warnings only (no critical findings) -> CircuitBreakerError(human)', async () => {
  const { thrownError } = await driveReviewerGate({
    reviewerResult: {
      passed: false,
      findings: [{ severity: 'warning', summary: 'mock warning', file: 'src/foo.js' }],
      structured: { isStub: false },
    },
    recommendation: 'retry',
  });
  assertHumanCircuitBreaker(thrownError);
});

// TC9 — reviewer gate, remediation planning produced NO fix tasks (site D).
// Reviewer !passed with a critical finding, analyzer 'retry', but
// remediateReviewFindings returns empty newTasks -> escalation.
await test('TC9: reviewer gate, remediation produced no fix tasks -> CircuitBreakerError(human)', async () => {
  const { thrownError } = await driveReviewerGate({
    reviewerResult: {
      passed: false,
      findings: [{ severity: 'critical', summary: 'mock critical', file: 'src/foo.js' }],
    },
    recommendation: 'retry',
    fixTasks: [], // planner produces nothing -> escalation
  });
  assertHumanCircuitBreaker(thrownError);
});

// TC10 — mission REGRESSION dead-end AFTER remediation (mission-side analog of
// TC2). _missionRegression: initial verifyMission fails, analyzer 'retry' (so it
// does NOT escalate at the human site), planner produces fix tasks, those run,
// but the recheck verifyMission STILL fails (not a stub) -> the
// "regression failed after remediation attempt" escalation must be a
// CircuitBreakerError{recommendation:'human'} (message keeps 'Circuit breaker:',
// no eventId). A plain Error would violate the assertions.
//
// NOTE: the sibling `recheck.isStub` throw ("verifier returned no
// structured_output") is a deliberate plain-Error infra/stub case and is NOT
// asserted here — the failing verifier returns verified:false (isStub false),
// so control reaches the post-remediation escalation, not the stub throw.
await test('TC10: mission regression fails after remediation -> CircuitBreakerError(human)', async () => {
  const { projectRoot, harnessDir, milestoneId, missionId } = createHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    // Verifier fails on BOTH the initial regression and the post-remediation
    // recheck (verified:false, not a stub).
    pipeline.verifier = makeFailingVerifier();
    // analyzer 'retry' -> passes the human-escalation guard, enters planning.
    pipeline.analyzer = makeAnalyzer('retry');
    // planner returns a fix task so the remediation block (and recheck) runs.
    pipeline.planner = {
      remediateScenarios: async () => ({
        newTasks: [{
          id: `${missionId}-001-fix-1`,
          subMissionId: `${missionId}-001`,
          description: 'Fix mission regression',
          targetFiles: ['src/foo.js'],
        }],
      }),
    };
    pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
    pipeline._executeAndVerifyTask = async () => {};

    const missionPlan = `mission ${missionId} plan body`;

    let thrownError = null;
    try {
      await pipeline._missionRegression(missionId, missionPlan);
    } catch (err) {
      thrownError = err instanceof CircuitBreakerError ? err
        : (err?.cause instanceof CircuitBreakerError ? err.cause : err);
    }
    assertHumanCircuitBreaker(thrownError);
  } finally {
    cleanup(projectRoot);
  }
});

} // run()

await run();

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
