#!/usr/bin/env node

/**
 * test-reviewer-guard-zero-findings.js — Tests for the reviewer-gate guard that
 * fires when reviewer returns !passed with zero critical findings.
 *
 * Guard fires in three distinct cases:
 *   1. Stub response (isStub:true)  → SDK/network/credits diagnostic
 *   2. Warnings-only                → warning-count diagnostic
 *   3. Empty findings, no stub      → no-actionable diagnostic
 *
 * The guard does NOT fire when:
 *   4. Critical findings are present → enters analyzer/retry path
 *   5. Reviewer passes              → guard block skipped entirely
 *
 * Multi-attempt scenario:
 *   6. First reviewer returns critical findings (remediation runs),
 *      second reviewer returns stub → "Hard Stop" thrown, counter persisted.
 *
 * Pattern: Object.create(Pipeline.prototype) + makePipelineStub() from
 * test-status-bar-integration.js. All dependencies are stubbed at the
 * instance level; no constructor is invoked.
 *
 * Run: node test/test-reviewer-guard-zero-findings.js
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import assert from 'assert';

import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { ProgressTracker } from '../src/orchestrator/core/progress-tracker.js';
import { InfrastructureError } from '../src/orchestrator/infra/session-manager.js';

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

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Minimal StatusBar mock — records calls, exposes .agents Map used by the
 * milestone elapsed-ticker inside _executeMilestone.
 */
function makeMockStatusBar() {
  const calls  = [];
  const agents = new Map();
  return {
    calls,
    agents,
    updateAgent:     (name, state) => {
      calls.push({ method: 'updateAgent', name, state });
      if (state === null) agents.delete(name);
      else                agents.set(name, state);
    },
    updateProgress:  (...args) => calls.push({ method: 'updateProgress', args }),
    updateMilestone: (...args) => calls.push({ method: 'updateMilestone', args }),
    setPhase:        (name)    => calls.push({ method: 'setPhase', name }),
    onLog:           (msg)     => calls.push({ method: 'onLog', message: String(msg) }),
    promptWillStart: ()        => {},
    promptDidEnd:    ()        => {},
    hide:            ()        => {},
    show:            ()        => {},
    teardown:        ()        => {},
    destroy:         ()        => {},
  };
}

/**
 * Builds a minimal Pipeline stub via Object.create(Pipeline.prototype).
 * Defaults match the test-status-bar-integration.js pattern, with
 * noReview:false so the reviewer gate is active.
 */
function makePipelineStub(overrides = {}) {
  const stub = Object.create(Pipeline.prototype);

  // Core I/O stubs
  stub.onLog     = () => {};
  stub.onConfirm = async () => true;

  // Filesystem defaults (overridden per-test via overrides.harnessDir)
  stub.harnessDir   = '/fake-harness';
  stub.projectRoot  = '/fake-project';

  // Progress tracker (delegated API)
  stub.progress = new ProgressTracker(stub.harnessDir, null);

  // Reviewer gate ENABLED for all tests in this suite
  stub.noReview   = false;
  stub.skipReview = false;

  // Misc pipeline state
  stub._mode              = undefined;
  stub._cachedImportGraph = '';

  // StatusBar (real mock for calls introspection)
  stub.statusBar = makeMockStatusBar();

  // Token tracker
  stub.tokenTracker = {
    getTotalUsage:  () => ({ totalCostUsd: 0, sessionCount: 0 }),
    getUsageByType: () => ({ totalCostUsd: 0, sessionCount: 0 }),
  };

  // Interval handle slots
  stub._msElapsedInterval = null;
  stub._msStartTime       = null;

  // Signal-handler stubs (required by run()'s finally block)
  stub._signalHandlers = {
    SIGINT:            () => {},
    SIGTERM:           () => {},
    exit:              () => {},
    uncaughtException: () => {},
  };

  // Prototype methods called inside _executeMilestone that need stubs
  stub._formatBanner              = (prefix, id, desc) => [`${prefix} ${id}: ${desc}`];
  stub._writeVerificationSummary  = () => {};

  // The scheduler (parallel) path is the only execution path — stub it to a
  // no-op so missions don't execute (we only test the reviewer gate section
  // in this suite).
  stub._executeMilestoneParallel  = async () => {};

  // Apply caller overrides last
  Object.assign(stub, overrides);
  return stub;
}

/**
 * Creates a temporary harness directory tree with the subdirectories and
 * state.json that _executeMilestone reads/writes.
 */
function makeTmpHarness() {
  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-rg-'));
  const harnessDir = path.join(tmpDir, '.harness');
  for (const sub of ['state', 'plan', 'verify', 'progress', 'verification', 'logs', 'snapshots', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify({
    projectMeta:  { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones:   {},
  }, null, 2));
  return { tmpDir, harnessDir };
}

/**
 * Writes a minimal mission state file to the harness so that the remediation
 * path in TC6 can read mission-{missionId}.json without crashing.
 *
 * Returns the subMissionId of the single sub-mission created.
 */
function writeMissionStateFile(harnessDir, missionId) {
  const subMissionId = `${missionId}-001`;
  const state = {
    id:          missionId,
    description: 'Test mission',
    status:      'in_progress',
    subMissions: {
      [subMissionId]: {
        id:          subMissionId,
        description: 'Test sub-mission',
        status:      'in_progress',
        tasks:       {},
      },
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify(state, null, 2)
  );
  return subMissionId;
}

// Shared baseline msState — no missions so the scheduler/loop is a no-op
const baseMsState = {
  description: 'Test milestone',
  status:      'in_progress',   // skip transitionMilestone(pending→in_progress) call
  missions:    {},
};

// ─────────────────────────────────────────────────────────────────────────────
// TC1: stub-path — isStub:true with zero findings → SDK/network/credit error
// ─────────────────────────────────────────────────────────────────────────────

await test('TC1: stub-path throws SDK/network/credit diagnostic, counter not incremented', async () => {
  const { harnessDir } = makeTmpHarness();
  const reviewRetryFile = path.join(harnessDir, 'analysis', 'review-retry-001.json');

  // Retry-once lives INSIDE the real Reviewer (reviewMilestone re-spawns its
  // own session); the pipeline gate therefore makes exactly ONE
  // reviewMilestone call for a stub verdict — counted here.
  let reviewCalls = 0;
  const stub = makePipelineStub({
    harnessDir,
    reviewer: {
      reviewMilestone: async () => {
        reviewCalls++;
        return {
          passed:     false,
          findings:   [],
          structured: { result: 'FAILED', findings: [], isStub: true },
        };
      },
    },
    _collectMilestoneContext: () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _renderReviewerDigest:    () => {},
    analyzer: {
      analyzeFailure: async () => ({ recommendation: 'retry', eventId: 'ev1' }),
    },
  });

  let thrown = null;
  try {
    await stub._executeMilestone('001', baseMsState);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'TC1: expected an error to be thrown');
  assert.strictEqual(reviewCalls, 1, 'TC1: pipeline gate makes exactly ONE reviewMilestone call for a stub (retry-once lives inside the Reviewer)');
  assert.ok(
    thrown instanceof InfrastructureError && thrown.name === 'InfrastructureError',
    `TC1: stub verdict must throw InfrastructureError, got ${thrown.name}`
  );
  assert.strictEqual(thrown.retryable, true, 'TC1: the stub InfrastructureError must be retryable');
  assert.ok(
    !(thrown.name === 'CircuitBreakerError') && !String(thrown.message).startsWith('Circuit breaker'),
    'TC1: stub verdict must NOT be classified as a CircuitBreakerError-shaped failure'
  );
  const msg = thrown.message.toLowerCase();
  assert.ok(
    msg.includes('sdk') || msg.includes('network') || msg.includes('credit'),
    `TC1: error message should contain 'sdk', 'network', or 'credit'. Got: ${thrown.message}`
  );
  assert.ok(
    !fs.existsSync(reviewRetryFile),
    'TC1: retry counter file must NOT exist — guard throws before counter is persisted'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TC2: warnings-only — findings contain only warnings → warning-count error
// ─────────────────────────────────────────────────────────────────────────────

await test('TC2: warnings-only throws with warning count, counter not incremented', async () => {
  const { harnessDir } = makeTmpHarness();
  const reviewRetryFile = path.join(harnessDir, 'analysis', 'review-retry-001.json');

  const stub = makePipelineStub({
    harnessDir,
    reviewer: {
      reviewMilestone: async () => ({
        passed:     false,
        findings:   [{ severity: 'warning', message: 'style issue', file: 'src/foo.js' }],
        structured: { result: 'FAILED', findings: [{ severity: 'warning' }] },
        // no isStub property
      }),
    },
    _collectMilestoneContext: () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _renderReviewerDigest:    () => {},
    analyzer: {
      analyzeFailure: async () => ({ recommendation: 'retry', eventId: 'ev1' }),
    },
  });

  let thrown = null;
  try {
    await stub._executeMilestone('001', baseMsState);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'TC2: expected an error to be thrown');
  // Pipeline error message: "...1 warning(s) present..."
  assert.ok(
    thrown.message.includes('1') || thrown.message.toLowerCase().includes('warning'),
    `TC2: error message should mention warning count or 'warning'. Got: ${thrown.message}`
  );
  assert.ok(
    !fs.existsSync(reviewRetryFile),
    'TC2: retry counter file must NOT exist — guard throws before counter is persisted'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TC3: empty-findings, no isStub → "no actionable" diagnostic
// ─────────────────────────────────────────────────────────────────────────────

await test('TC3: empty-findings no-stub throws no-actionable diagnostic, counter not incremented', async () => {
  const { harnessDir } = makeTmpHarness();
  const reviewRetryFile = path.join(harnessDir, 'analysis', 'review-retry-001.json');

  const stub = makePipelineStub({
    harnessDir,
    reviewer: {
      reviewMilestone: async () => ({
        passed:     false,
        findings:   [],
        structured: { result: 'FAILED', findings: [] },
        // no isStub property
      }),
    },
    _collectMilestoneContext: () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _renderReviewerDigest:    () => {},
    analyzer: {
      analyzeFailure: async () => ({ recommendation: 'retry', eventId: 'ev1' }),
    },
  });

  let thrown = null;
  try {
    await stub._executeMilestone('001', baseMsState);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'TC3: expected an error to be thrown');
  assert.ok(
    thrown.message.toLowerCase().includes('no actionable') ||
    thrown.message.toLowerCase().includes('actionable'),
    `TC3: error message should contain 'no actionable'. Got: ${thrown.message}`
  );
  assert.ok(
    !fs.existsSync(reviewRetryFile),
    'TC3: retry counter file must NOT exist — guard throws before counter is persisted'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TC4: critical findings present → guard does not fire, enters analyzer path
// ─────────────────────────────────────────────────────────────────────────────

await test('TC4: critical findings present → guard does not fire, enters analyzer/retry path', async () => {
  const { harnessDir } = makeTmpHarness();
  const reviewRetryFile = path.join(harnessDir, 'analysis', 'review-retry-001.json');

  const stub = makePipelineStub({
    harnessDir,
    reviewer: {
      reviewMilestone: async () => ({
        passed:     false,
        findings:   [{ severity: 'critical', message: 'critical bug', file: 'src/foo.js' }],
        structured: { result: 'FAILED' },
      }),
    },
    _collectMilestoneContext: () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _renderReviewerDigest:    () => {},
    analyzer: {
      // 'human' recommendation throws at the analyzer-path, NOT from the guard
      analyzeFailure: async () => ({ recommendation: 'human', eventId: 'ev1' }),
    },
  });

  let thrown = null;
  try {
    await stub._executeMilestone('001', baseMsState);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'TC4: expected an error to be thrown');

  // The guard error messages contain these distinctive fragments —
  // the analyzer "human" path uses different wording.
  const msg = thrown.message.toLowerCase();
  assert.ok(
    !msg.includes('stub response'),
    `TC4: error must NOT be the isStub guard message. Got: ${thrown.message}`
  );
  assert.ok(
    !msg.includes('no actionable'),
    `TC4: error must NOT be the no-actionable guard message. Got: ${thrown.message}`
  );
  // Verify it IS the analyzer/human path
  assert.ok(
    msg.includes('human intervention') || msg.includes('analyzer'),
    `TC4: error should be from the analyzer 'human' path. Got: ${thrown.message}`
  );
  assert.ok(
    !fs.existsSync(reviewRetryFile),
    'TC4: retry counter file must NOT exist — human escalation throws before counter is persisted'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TC5: reviewer passes → _executeMilestone does NOT throw from guard
// ─────────────────────────────────────────────────────────────────────────────

await test('TC5: reviewer passes → _executeMilestone does NOT throw from guard', async () => {
  const { harnessDir } = makeTmpHarness();

  const stub = makePipelineStub({
    harnessDir,
    reviewer: {
      reviewMilestone: async () => ({ passed: true, findings: [] }),
    },
    _collectMilestoneContext: () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _renderReviewerDigest:    () => {},
    // verifier needed in case verifyMilestone's regression check calls verifyRegression
    verifier: { verifyRegression: async () => ({ verified: true }) },
    analyzer: {
      analyzeFailure: async () => ({ recommendation: 'retry', eventId: 'ev1' }),
    },
  });

  let thrown = null;
  try {
    await stub._executeMilestone('001', baseMsState);
  } catch (err) {
    thrown = err;
  }

  // If an error was thrown it must NOT be from the reviewer guard
  if (thrown) {
    const msg = thrown.message.toLowerCase();
    assert.ok(
      !msg.includes('stub response'),
      `TC5: error must not be the isStub guard. Got: ${thrown.message}`
    );
    assert.ok(
      !msg.includes('no actionable'),
      `TC5: error must not be the no-actionable guard. Got: ${thrown.message}`
    );
    assert.ok(
      !(msg.includes('sdk') && msg.includes('credit')),
      `TC5: error must not be the SDK/credit guard. Got: ${thrown.message}`
    );
  }
  // If no error thrown at all, the pipeline completed — also valid.
  // Either way, the guard never fired.
});

// ─────────────────────────────────────────────────────────────────────────────
// TC6: multi-attempt — attempt 2 (post-remediation re-review) stubs
//
// Flow:
//   1st reviewer → critical findings → remediation runs → counter persisted
//   2nd reviewer → stub result (isStub:true) → InfrastructureError (the
//   re-review stub is the same SDK/transport failure shape as TC1's
//   first-attempt stub — infra-pending, not a merit hard stop)
//
// Assertions: InfrastructureError (retryable) thrown, counter file EXISTS,
// reviewer called twice.
// ─────────────────────────────────────────────────────────────────────────────

await test('TC6: multi-attempt where attempt 2 triggers guard with stub diagnostic', async () => {
  const { harnessDir } = makeTmpHarness();
  const reviewRetryFile = path.join(harnessDir, 'analysis', 'review-retry-001.json');

  const missionId    = '001-001';
  const subMissionId = writeMissionStateFile(harnessDir, missionId);

  let reviewCallCount = 0;
  const reviewResults = [
    // Attempt 1: critical findings → remediation loop runs
    {
      passed:     false,
      findings:   [{ severity: 'critical', message: 'critical bug', file: 'src/foo.js' }],
      structured: { result: 'FAILED' },
    },
    // Attempt 2 (re-review after remediation): stub response, zero findings
    {
      passed:     false,
      findings:   [],
      structured: { result: 'FAILED', isStub: true },
    },
  ];

  const stub = makePipelineStub({
    harnessDir,
    reviewer: {
      reviewMilestone: async () => {
        const result = reviewResults[reviewCallCount] ?? reviewResults[reviewResults.length - 1];
        reviewCallCount++;
        return result;
      },
    },
    _collectMilestoneContext: () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _renderReviewerDigest:    () => {},
    analyzer: {
      analyzeFailure: async () => ({ recommendation: 'retry', eventId: 'ev1' }),
    },
    planner: {
      // Returns one remediation task so the fix loop runs (task is then stubbed out)
      remediateReviewFindings: async () => ({
        newTasks: [{
          id:               `${subMissionId}-001`,
          subMissionId,
          description:      'Fix critical finding',
          targetFiles:      [],
          testCases:        [],
          tracesScenario:   [],
          patternReferences: [],
          dataSchemas:      [],
        }],
      }),
    },
    // Stub task execution so we don't need a full executor/verifier setup
    _executeAndVerifyTask: async () => {},
  });

  // msState must include the mission so that allMissionIds is non-empty
  // (fallbackMissionId needs to resolve to a real mission for findingsByMission)
  const msState = {
    description: 'Test milestone',
    status:      'in_progress',
    missions: {
      [missionId]: { id: missionId, description: 'Test mission', status: 'in_progress' },
    },
  };

  let thrown = null;
  try {
    await stub._executeMilestone('001', msState);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'TC6: expected an error to be thrown after the second reviewer attempt');
  assert.ok(
    thrown instanceof InfrastructureError && thrown.name === 'InfrastructureError',
    `TC6: a stub re-review verdict must throw InfrastructureError, got ${thrown.name}`
  );
  assert.strictEqual(thrown.retryable, true, 'TC6: the re-review stub InfrastructureError must be retryable');
  assert.ok(
    !(thrown.name === 'CircuitBreakerError') && !String(thrown.message).startsWith('Circuit breaker'),
    'TC6: the re-review stub verdict must NOT be classified as a CircuitBreakerError-shaped failure'
  );
  const tc6msg = thrown.message.toLowerCase();
  assert.ok(
    tc6msg.includes('sdk') || tc6msg.includes('network') || tc6msg.includes('credit'),
    `TC6: error message should contain 'sdk', 'network', or 'credit'. Got: ${thrown.message}`
  );

  // Counter file MUST exist — it was persisted by persistReviewRetryCount(1)
  // at line ~1224 of pipeline.js, BEFORE the second reviewer call.
  assert.ok(
    fs.existsSync(reviewRetryFile),
    'TC6: retry counter file must EXIST — was persisted before the second reviewer call'
  );

  // Reviewer must have been called twice (first attempt + re-review attempt)
  assert.strictEqual(
    reviewCallCount,
    2,
    `TC6: reviewer.reviewMilestone must be called exactly twice; got ${reviewCallCount}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
