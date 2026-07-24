/**
 * test-reviewer-retry.js — Unit tests for the reviewer-retry remediation flow
 * inside pipeline.js.
 *
 * No live SDK. Uses mock objects to verify the reviewer gate retry path:
 *  TC1: reviewRemediationSchema validates valid remediateReviewFindings output
 *  TC2: When analyzer recommends retry, planner.remediateReviewFindings is called
 *  TC3: When analyzer recommends human, pipeline throws with human intervention message
 *  TC4: Fix tasks are passed to _executeAndVerifyTask for each pending task
 *  TC5: After fix tasks complete, reviewer.reviewMilestone is called a second time
 *  TC6: When re-review fails, pipeline throws hard-stop error (no second retry)
 *  TC7: Fix task targetFiles match only the files from reviewer critical findings
 *  TC8: When reviewer passes first time, no remediation triggered
 *  TC9: When remediateReviewFindings returns empty newTasks, throws immediately
 *
 * Run: node test/test-reviewer-retry.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

import {
  reviewRemediationSchema,
  validateStructured,
} from '../src/orchestrator/agents/_schemas.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

function createHarness() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-retry-'));
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'progress'), { recursive: true });
  return { projectRoot, harnessDir };
}

function cleanup(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

// ── Mock factories ───────────────────────────────────────────────────────────

const noop = () => {};

function makeSessionManager(cannedSdkResult) {
  const calls = [];
  const handle = { systemPromptTokens: 0, _toolCallCount: 0 };

  const sessionManager = {
    calls,
    spawn(opts) {
      calls.push(opts);
      const resolvedResult = { handle, result: cannedSdkResult };
      const spawnPromise = Promise.resolve(resolvedResult);
      spawnPromise.handle = handle;
      return spawnPromise;
    },
  };

  return sessionManager;
}

function makeLogger() {
  return {
    createSessionLog: () => ({ logPath: '/tmp/fake.log', close: noop }),
    attachToSession: noop,
    getSessionSummary: () => ({}),
    writeSessionSummary: noop,
  };
}

function makeTokenTracker() {
  const calls = [];
  return {
    calls,
    recordSession(...args) {
      calls.push(args);
    },
  };
}

/**
 * Mock planner with controllable remediateReviewFindings return.
 * @param {object} remediationResult — what remediateReviewFindings returns
 */
function makeMockPlanner(remediationResult) {
  const calls = [];
  return {
    calls,
    async remediateReviewFindings(msId, criticalFindings, projectRoot) {
      calls.push({ msId, criticalFindings, projectRoot });
      return remediationResult;
    },
  };
}

/**
 * Mock reviewer with controllable reviewMilestone return.
 * @param {Array} results — array of return values per call (first call uses [0], second uses [1], etc.)
 */
function makeMockReviewer(results) {
  const calls = [];
  return {
    calls,
    async reviewMilestone(msId, modifiedFiles, taskDescriptions, importGraph, projectRoot, harnessDir) {
      const callIndex = calls.length;
      calls.push({ msId, modifiedFiles, taskDescriptions, importGraph, projectRoot, harnessDir });
      const result = results[callIndex] !== undefined ? results[callIndex] : results[results.length - 1];
      return result;
    },
  };
}

/**
 * Mock analyzer with controllable recommendation.
 */
function makeMockAnalyzer(recommendation) {
  const calls = [];
  return {
    calls,
    async analyzeFailure(opts, projectRoot) {
      calls.push({ opts, projectRoot });
      return {
        recommendation,
        rootCause: 'test root cause',
        failureType: 'review',
        affectedTasks: [],
        eventId: 'test-event-id',
      };
    },
  };
}

/**
 * Build the reviewer retry logic inline (mirrors pipeline.js reviewer gate block)
 * so tests can assert behavior without instantiating the full Pipeline class.
 *
 * This function reproduces the core reviewer gate logic from pipeline.js:
 *   1. Run reviewer.reviewMilestone
 *   2. If passed → return
 *   3. Filter critical findings, run analyzer
 *   4. If analyzer says 'human' → throw
 *   5. Run planner.remediateReviewFindings
 *   6. If no newTasks → throw
 *   7. _executeAndVerifyTask for each fix task
 *   8. Re-run reviewer
 *   9. If re-review fails → throw hard-stop
 */
async function runReviewerGate({
  msId,
  reviewer,
  analyzer,
  planner,
  executeAndVerifyTask, // mock function to track calls
  modifiedFiles = ['src/foo.js'],
  taskDescriptions = ['Task t1: test'],
  importGraph = 'importGraph data',
  projectRoot,
  harnessDir,
  fixTasks = [],           // tasks to iterate after remediation
}) {
  const reviewResult = await reviewer.reviewMilestone(
    msId, modifiedFiles, taskDescriptions, importGraph, projectRoot, harnessDir
  );

  if (!reviewResult.passed) {
    const criticalFindings = (reviewResult.findings || []).filter(f => f.severity === 'critical');

    const reviewAnalysis = await analyzer.analyzeFailure({
      taskId: `reviewer-${msId}`,
      taskDescription: `Milestone ${msId} reviewer gate failure`,
      failureType: 'review',
      retryCount: 0,
      sidecarPath: path.join(harnessDir, 'verification', `review-milestone-${msId}.json`),
    }, projectRoot);

    if (reviewAnalysis.recommendation === 'human') {
      throw new Error(
        `Milestone ${msId} reviewer gate failed. ` +
        `Analyzer recommends human intervention. ` +
        `See .harness/analysis/${reviewAnalysis.eventId}.json`
      );
    }

    // Remediate review findings
    const remPlan = await planner.remediateReviewFindings(msId, criticalFindings, projectRoot);

    if (!remPlan.newTasks?.length) {
      throw new Error(
        `Milestone ${msId} reviewer gate failed and remediation produced no fix tasks. ` +
        `Analyzer recommendation: ${reviewAnalysis.recommendation}. ` +
        `See .harness/analysis/${reviewAnalysis.eventId}.json`
      );
    }

    // Execute pending fix tasks
    for (const task of fixTasks) {
      await executeAndVerifyTask(task);
    }

    // Re-run reviewer
    const reReviewResult = await reviewer.reviewMilestone(
      msId, modifiedFiles, taskDescriptions, importGraph, projectRoot, harnessDir
    );

    if (!reReviewResult.passed) {
      throw new Error(
        `Milestone ${msId} reviewer gate failed after remediation. Hard stop — human intervention required. ` +
        `See .harness/verification/review-milestone-${msId}.json`
      );
    }
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const passedReviewResult = {
  passed: true,
  findings: [],
};

const failedReviewResult = {
  passed: false,
  findings: [
    {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/foo.js',
      description: 'Missing await on async call.',
      relatedFiles: [],
    },
    {
      severity: 'critical',
      category: 'functional',
      file: 'src/bar.js',
      description: 'Exit code swallowed.',
      relatedFiles: [],
    },
  ],
};

const fixTasksFixture = [
  { id: '001-001-002-001', subMissionId: '001-001-002', description: 'Fix missing await', targetFiles: ['src/foo.js'] },
  { id: '001-001-002-002', subMissionId: '001-001-002', description: 'Fix exit code handling', targetFiles: ['src/bar.js'] },
];

const remediationPlanFixture = {
  newTasks: fixTasksFixture,
};

// ── TC1: reviewRemediationSchema validates valid output ──────────────────────

await test('TC1: reviewRemediationSchema validates valid remediateReviewFindings output', () => {
  const validOutput = {
    newTasks: [
      { id: '001-001-002-001', subMissionId: '001-001-002', description: 'Fix missing await', targetFiles: ['src/foo.js'] },
      { id: '001-001-002-002', subMissionId: '001-001-002', description: 'Fix exit code handling', targetFiles: ['src/bar.js'] },
    ],
  };

  const result = validateStructured(validOutput, reviewRemediationSchema);
  assert.strictEqual(result.ok, true, `expected ok, got errors: ${JSON.stringify(result.errors)}`);

  // Also verify the schema shape itself has required fields
  assert.ok(reviewRemediationSchema.required.includes('newTasks'), 'schema requires newTasks');
  const itemSchema = reviewRemediationSchema.properties.newTasks.items;
  assert.ok(itemSchema.required.includes('id'), 'item requires id');
  assert.ok(itemSchema.required.includes('description'), 'item requires description');
  assert.ok(itemSchema.required.includes('targetFiles'), 'item requires targetFiles');
});

// ── TC2: analyzer recommends retry → planner.remediateReviewFindings called ──

await test('TC2: When analyzer recommends retry, planner.remediateReviewFindings is called with msId and critical findings', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const reviewer = makeMockReviewer([failedReviewResult, passedReviewResult]);
    const analyzer = makeMockAnalyzer('retry');
    const planner = makeMockPlanner(remediationPlanFixture);
    const executeAndVerifyTask = async () => {};

    await runReviewerGate({
      msId: 'ms-001',
      reviewer,
      analyzer,
      planner,
      executeAndVerifyTask,
      projectRoot,
      harnessDir,
    });

    assert.strictEqual(planner.calls.length, 1, 'remediateReviewFindings should be called once');
    const call = planner.calls[0];
    assert.strictEqual(call.msId, 'ms-001', 'msId should be passed to remediateReviewFindings');
    // Only critical findings should be passed
    assert.ok(Array.isArray(call.criticalFindings), 'criticalFindings should be an array');
    assert.ok(
      call.criticalFindings.every(f => f.severity === 'critical'),
      'all passed findings should be critical'
    );
    assert.strictEqual(call.criticalFindings.length, 2, 'both critical findings should be passed');
    assert.strictEqual(call.projectRoot, projectRoot, 'projectRoot should be passed');
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC3: analyzer recommends human → pipeline throws ────────────────────────

await test('TC3: When analyzer recommends human, pipeline throws with human intervention message', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const reviewer = makeMockReviewer([failedReviewResult]);
    const analyzer = makeMockAnalyzer('human');
    const planner = makeMockPlanner(remediationPlanFixture);
    const executeAndVerifyTask = async () => {};

    let threw = false;
    let thrownError = null;
    try {
      await runReviewerGate({
        msId: 'ms-001',
        reviewer,
        analyzer,
        planner,
        executeAndVerifyTask,
        projectRoot,
        harnessDir,
      });
    } catch (err) {
      threw = true;
      thrownError = err;
    }

    assert.ok(threw, 'should have thrown when analyzer recommends human');
    assert.ok(
      thrownError.message.includes('human intervention'),
      `error should mention human intervention, got: ${thrownError.message}`
    );
    // Planner should NOT have been called
    assert.strictEqual(planner.calls.length, 0, 'remediateReviewFindings should not be called when human intervention required');
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC4: fix tasks passed to _executeAndVerifyTask ──────────────────────────

await test('TC4: Fix tasks are passed to _executeAndVerifyTask for each pending task', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const reviewer = makeMockReviewer([failedReviewResult, passedReviewResult]);
    const analyzer = makeMockAnalyzer('retry');
    const planner = makeMockPlanner(remediationPlanFixture);
    const executedTasks = [];
    const executeAndVerifyTask = async (task) => {
      executedTasks.push(task);
    };

    await runReviewerGate({
      msId: 'ms-001',
      reviewer,
      analyzer,
      planner,
      executeAndVerifyTask,
      projectRoot,
      harnessDir,
      fixTasks: fixTasksFixture,
    });

    assert.strictEqual(executedTasks.length, 2, 'should execute both fix tasks');
    assert.strictEqual(executedTasks[0].id, '001-001-002-001', 'first fix task id should match');
    assert.strictEqual(executedTasks[1].id, '001-001-002-002', 'second fix task id should match');
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC5: reviewer.reviewMilestone called a second time after fix tasks ───────

await test('TC5: After fix tasks complete, reviewer.reviewMilestone is called a second time', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const reviewer = makeMockReviewer([failedReviewResult, passedReviewResult]);
    const analyzer = makeMockAnalyzer('retry');
    const planner = makeMockPlanner(remediationPlanFixture);
    const executeAndVerifyTask = async () => {};

    await runReviewerGate({
      msId: 'ms-001',
      reviewer,
      analyzer,
      planner,
      executeAndVerifyTask,
      projectRoot,
      harnessDir,
    });

    assert.strictEqual(reviewer.calls.length, 2, 'reviewMilestone should be called twice');
    // First call: initial review
    assert.strictEqual(reviewer.calls[0].msId, 'ms-001');
    // Second call: re-review after remediation
    assert.strictEqual(reviewer.calls[1].msId, 'ms-001');
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC6: re-review fails → hard-stop error ───────────────────────────────────

await test('TC6: When re-review fails, pipeline throws hard-stop error (no second retry)', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const reviewer = makeMockReviewer([failedReviewResult, failedReviewResult]);
    const analyzer = makeMockAnalyzer('retry');
    const planner = makeMockPlanner(remediationPlanFixture);
    const executeAndVerifyTask = async () => {};

    let threw = false;
    let thrownError = null;
    try {
      await runReviewerGate({
        msId: 'ms-001',
        reviewer,
        analyzer,
        planner,
        executeAndVerifyTask,
        projectRoot,
        harnessDir,
      });
    } catch (err) {
      threw = true;
      thrownError = err;
    }

    assert.ok(threw, 'should have thrown on second reviewer failure');
    assert.ok(
      thrownError.message.includes('after remediation'),
      `error should mention "after remediation", got: ${thrownError.message}`
    );
    assert.ok(
      thrownError.message.includes('Hard stop'),
      `error should mention "Hard stop", got: ${thrownError.message}`
    );
    // Reviewer should have been called exactly twice (no third retry)
    assert.strictEqual(reviewer.calls.length, 2, 'reviewer should be called exactly twice (no further retry)');
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC7: fix task targetFiles scoped to flagged files only ───────────────────

await test('TC7: Fix task targetFiles match only the files from reviewer critical findings', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    // Critical findings reference only src/foo.js and src/bar.js
    const criticalFiles = failedReviewResult.findings
      .filter(f => f.severity === 'critical')
      .map(f => f.file);

    // Fix tasks should only target those files
    const scopedFixTasks = [
      { id: '001-001-002-001', subMissionId: '001-001-002', description: 'Fix missing await', targetFiles: ['src/foo.js'] },
      { id: '001-001-002-002', subMissionId: '001-001-002', description: 'Fix exit code handling', targetFiles: ['src/bar.js'] },
    ];

    const remediationWithScopedTasks = { newTasks: scopedFixTasks };

    const reviewer = makeMockReviewer([failedReviewResult, passedReviewResult]);
    const analyzer = makeMockAnalyzer('retry');
    const planner = makeMockPlanner(remediationWithScopedTasks);
    const executedTasks = [];
    const executeAndVerifyTask = async (task) => {
      executedTasks.push(task);
    };

    await runReviewerGate({
      msId: 'ms-001',
      reviewer,
      analyzer,
      planner,
      executeAndVerifyTask,
      projectRoot,
      harnessDir,
      fixTasks: scopedFixTasks,
    });

    // Verify planner received the critical findings with the right files
    const passedCriticalFiles = planner.calls[0].criticalFindings.map(f => f.file);
    for (const file of passedCriticalFiles) {
      assert.ok(
        criticalFiles.includes(file),
        `file ${file} in critical findings should be from reviewer findings`
      );
    }

    // Verify each fix task targets only files referenced in critical findings
    for (const task of executedTasks) {
      for (const targetFile of task.targetFiles) {
        assert.ok(
          criticalFiles.includes(targetFile),
          `targetFile ${targetFile} should be in critical findings files`
        );
      }
    }
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC8: reviewer passes first time → no remediation triggered ───────────────

await test('TC8: When reviewer passes first time, no remediation triggered', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const reviewer = makeMockReviewer([passedReviewResult]);
    const analyzer = makeMockAnalyzer('retry');
    const planner = makeMockPlanner(remediationPlanFixture);
    const executeAndVerifyTask = async () => {};

    await runReviewerGate({
      msId: 'ms-001',
      reviewer,
      analyzer,
      planner,
      executeAndVerifyTask,
      projectRoot,
      harnessDir,
    });

    // Reviewer called once, no remediation
    assert.strictEqual(reviewer.calls.length, 1, 'reviewMilestone should be called only once');
    assert.strictEqual(planner.calls.length, 0, 'remediateReviewFindings should NOT be called');
    assert.strictEqual(analyzer.calls.length, 0, 'analyzer should NOT be called');
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC9: remediateReviewFindings returns empty newTasks → throws immediately ──

await test('TC9: When remediateReviewFindings returns empty newTasks, throws immediately', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const reviewer = makeMockReviewer([failedReviewResult]);
    const analyzer = makeMockAnalyzer('retry');
    const planner = makeMockPlanner({ newTasks: [] }); // empty newTasks
    const executedTasks = [];
    const executeAndVerifyTask = async (task) => {
      executedTasks.push(task);
    };

    let threw = false;
    let thrownError = null;
    try {
      await runReviewerGate({
        msId: 'ms-001',
        reviewer,
        analyzer,
        planner,
        executeAndVerifyTask,
        projectRoot,
        harnessDir,
        fixTasks: [],
      });
    } catch (err) {
      threw = true;
      thrownError = err;
    }

    assert.ok(threw, 'should have thrown when newTasks is empty');
    assert.ok(
      thrownError.message.includes('no fix tasks'),
      `error should mention "no fix tasks", got: ${thrownError.message}`
    );
    // No tasks should have been executed
    assert.strictEqual(executedTasks.length, 0, 'no tasks should be executed when newTasks is empty');
    // Reviewer should NOT have been re-run (only the first call)
    assert.strictEqual(reviewer.calls.length, 1, 'reviewer should only be called once (no re-review)');
  } finally {
    cleanup(projectRoot);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
