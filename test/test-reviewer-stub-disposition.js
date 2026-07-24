#!/usr/bin/env node

delete process.env.CC_ORCH_ACTIVE_RUN;

/**
 * test-reviewer-stub-disposition.js — Reviewer stub-disposition tests across
 * TWO stubbing layers:
 *
 *   LEG-1 (reviewer.js's internal retry-on-stub) — a mock sessionManager
 *   whose spawn returns a thenable Object.assign(Promise.resolve({handle,
 *   result}), {handle}) scripted per call index (mirrors makeMockSetup in
 *   test-verifier-escalation.js), plus mock logger and a tokenTracker.
 *   recordSession spy, driving the REAL Reviewer.reviewMilestone from
 *   src/orchestrator/agents/reviewer.js. When attempt 1 yields a stub verdict
 *   (no structured_output), reviewMilestone re-spawns exactly once, named
 *   `reviewer-<msId>-retry`, using config.execution.reviewerModel.
 *
 *   LEG-2 (pipeline.js's gate classification) — a pipeline fixture built via
 *   Object.create(Pipeline.prototype) with a makeTmpHarness-style temp
 *   .harness tree and a FAKE reviewer.reviewMilestone returning scripted
 *   verdicts (mirrors makePipelineStub in test-reviewer-guard-zero-findings.js
 *   — NO spawn spy at this layer), driving stub._executeMilestone.
 *
 * Cases:
 *   (a) LEG-1: attempt-1 stub, retry returns valid non-stub PASSED verdict
 *       → reviewMilestone returns passed:true; two spawns; second named
 *       reviewer-<msId>-retry with config.execution.reviewerModel.
 *   (b) attempt-1 stub, retry returns non-stub FAILED with critical findings
 *       → the retry verdict is the gate result (LEG-1), and a fake reviewer
 *       returning that verdict routes into analyzer.analyzeFailure /
 *       remediation — not the zero-findings guard (LEG-2).
 *   (c) BOTH attempts stub → LEG-1: exactly two spawns (never a third),
 *       structured.isStub === true; LEG-2: disposition of a stub verdict
 *       throws InfrastructureError (retryable:true, category:'unknown'),
 *       explicitly NOT a plain Error and NOT CircuitBreakerError.
 *   (d) LEG-1: retry spawn THROWS (failSpawnAt:1) → reviewMilestone resolves
 *       without throwing, returning attempt-1's stub verdict, no
 *       unhandledRejection; LEG-2: disposition of that stub verdict still
 *       throws InfrastructureError.
 *   (e) LEG-1: non-stub FAILED verdict with critical findings on attempt 1
 *       → single spawn (no retry), verdict returned as-is.
 *   (f) LEG-2: non-stub warnings-only verdict → _executeMilestone throws a
 *       CircuitBreakerError-shaped error ('warnings only' / 'Circuit
 *       breaker'), NOT InfrastructureError.
 *   (g) LEG-1 ledger: tokenTracker.recordSession spy captures exactly two
 *       calls under distinct names, each carrying its OWN spawn's handle
 *       metadata (distinct per-spawn handles prove no conflation).
 *
 * No Claude auth, no live sessions.
 *
 * Run: node test/test-reviewer-stub-disposition.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

import config from '../src/orchestrator/infra/config.js';
import { Reviewer } from '../src/orchestrator/agents/reviewer.js';
import { InfrastructureError } from '../src/orchestrator/infra/session-manager.js';
import { CircuitBreakerError } from '../src/orchestrator/core/circuit-breaker-error.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { ProgressTracker } from '../src/orchestrator/core/progress-tracker.js';

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

// ── LEG-1 fixtures — mock sessionManager driving the REAL Reviewer ─────────

function passedOutput() {
  return { result: 'PASSED', findings: [] };
}

function failedCriticalOutput() {
  return {
    result: 'FAILED',
    findings: [
      { severity: 'critical', category: 'functional', file: 'src/foo.js', description: 'critical composition bug' },
    ],
  };
}

/**
 * Builds a mock sessionManager whose spawn returns a thenable resolving to
 * { handle, result }, scripted per call index. `undefined` output entry →
 * omit structured_output (stub path); otherwise wrap the entry as the SDK
 * result's structured_output. A DISTINCT handle per spawn (distinct
 * _toolCallCount / systemPromptTokens) proves which session's metadata a
 * ledger record was built from. `failSpawnAt` returns a thenable that
 * REJECTS (not a real Promise) so there is no dangling unhandledRejection.
 * Mirrors makeMockSetup in test-verifier-escalation.js.
 */
function makeMockSessionManager({ outputs, failSpawnAt = -1 }) {
  const spawnSpy = { calls: [] };
  const makeHandle = (idx) => ({
    _toolCallCount: idx + 1,
    systemPromptTokens: (idx + 1) * 10,
  });
  const sessionManager = {
    spawn: (spawnOpts) => {
      const idx = spawnSpy.calls.length;
      spawnSpy.calls.push(spawnOpts);
      const handle = makeHandle(idx);
      if (idx === failSpawnAt) {
        return { handle, then: (_resolve, reject) => reject(new Error('reviewer retry spawn failed')) };
      }
      const out = outputs[idx];
      const sdkResult = out !== undefined ? { structured_output: out } : {};
      const spawnResult = { handle, result: sdkResult };
      return Object.assign(Promise.resolve(spawnResult), { handle });
    },
  };
  return { sessionManager, spawnSpy };
}

function makeMockLogger() {
  return {
    createSessionLog: (name) => ({ logPath: `/tmp/test-reviewer-stub-disposition-${name}.log`, close: () => {} }),
    attachToSession: () => {},
    warn: () => {},
    writeSessionSummary: async () => {},
    getSessionSummary: () => '',
  };
}

function makeMockTokenTracker() {
  const recordSpy = { calls: [] };
  return {
    recordSpy,
    tokenTracker: {
      recordSession: async (name, role, sdkResult, meta) => {
        recordSpy.calls.push({ name, role, meta });
      },
    },
  };
}

function tmpHarnessDirLeg1() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-stub-disposition-'));
  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  return harnessDir;
}

// ── LEG-2 fixtures — pipeline-level, FAKE reviewer.reviewMilestone ─────────
// Mirrors makePipelineStub / makeTmpHarness in test-reviewer-guard-zero-findings.js.

function makeMockStatusBar() {
  const calls = [];
  const agents = new Map();
  return {
    calls,
    agents,
    updateAgent: (name, state) => {
      calls.push({ method: 'updateAgent', name, state });
      if (state === null) agents.delete(name);
      else agents.set(name, state);
    },
    updateProgress: (...args) => calls.push({ method: 'updateProgress', args }),
    updateMilestone: (...args) => calls.push({ method: 'updateMilestone', args }),
    setPhase: (name) => calls.push({ method: 'setPhase', name }),
    onLog: (msg) => calls.push({ method: 'onLog', message: String(msg) }),
    promptWillStart: () => {},
    promptDidEnd: () => {},
    hide: () => {},
    show: () => {},
    teardown: () => {},
    destroy: () => {},
  };
}

function makePipelineStub(overrides = {}) {
  const stub = Object.create(Pipeline.prototype);

  stub.onLog = () => {};
  stub.onConfirm = async () => true;

  stub.harnessDir = '/fake-harness';
  stub.projectRoot = '/fake-project';

  stub.progress = new ProgressTracker(stub.harnessDir, null);

  stub.noReview = false;
  stub.skipReview = false;

  stub._mode = undefined;
  stub._cachedImportGraph = '';

  stub.statusBar = makeMockStatusBar();
  stub.tokenTracker = {
    getTotalUsage: () => ({ totalCostUsd: 0, sessionCount: 0 }),
    getUsageByType: () => ({ totalCostUsd: 0, sessionCount: 0 }),
  };

  stub._msElapsedInterval = null;
  stub._msStartTime = null;

  stub._signalHandlers = {
    SIGINT: () => {},
    SIGTERM: () => {},
    exit: () => {},
    uncaughtException: () => {},
  };

  stub._formatBanner = (prefix, id, desc) => [`${prefix} ${id}: ${desc}`];
  stub._writeVerificationSummary = () => {};
  stub._executeMilestoneParallel = async () => {};

  Object.assign(stub, overrides);
  return stub;
}

function makeTmpHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-rsd-'));
  const harnessDir = path.join(tmpDir, '.harness');
  for (const sub of ['state', 'plan', 'verify', 'progress', 'verification', 'logs', 'snapshots', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify({
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {},
  }, null, 2));
  return { tmpDir, harnessDir };
}

const baseMsState = {
  description: 'Test milestone',
  status: 'in_progress',
  missions: {},
};

// ═════════════════════════════════════════════════════════════════════════
// (a) LEG-1: attempt-1 stub, retry returns valid non-stub PASSED verdict
// ═════════════════════════════════════════════════════════════════════════

await test('(a) LEG-1: attempt-1 stub, retry PASSED → gate passes, two spawns, retry named + modeled correctly', async () => {
  const harnessDir = tmpHarnessDirLeg1();
  const msId = 'caseA';
  const { sessionManager, spawnSpy } = makeMockSessionManager({ outputs: [undefined, passedOutput()] });
  const logger = makeMockLogger();
  const { tokenTracker } = makeMockTokenTracker();

  const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
  const verdict = await reviewer.reviewMilestone(msId, ['src/foo.js'], ['task 1'], '', '/fake-project', harnessDir);

  assert.strictEqual(verdict.passed, true, 'gate must pass on the retry\'s valid PASSED verdict');
  assert.strictEqual(spawnSpy.calls.length, 2, `expected exactly two spawns, got ${spawnSpy.calls.length}`);
  assert.strictEqual(spawnSpy.calls[1].name, `reviewer-${msId}-retry`, `second spawn must be named reviewer-${msId}-retry, got ${spawnSpy.calls[1].name}`);
  assert.strictEqual(spawnSpy.calls[1].model, config.execution.reviewerModel, `second spawn must use config.execution.reviewerModel, got ${spawnSpy.calls[1].model}`);
  assert.strictEqual(spawnSpy.calls[0].name, `reviewer-${msId}`, 'first spawn must be named reviewer-<msId>');
});

// ═════════════════════════════════════════════════════════════════════════
// (b) attempt-1 stub, retry returns non-stub FAILED with critical findings
// ═════════════════════════════════════════════════════════════════════════

await test('(b) LEG-1: attempt-1 stub, retry FAILED-critical → retry verdict is the gate result', async () => {
  const harnessDir = tmpHarnessDirLeg1();
  const msId = 'caseB';
  const { sessionManager, spawnSpy } = makeMockSessionManager({ outputs: [undefined, failedCriticalOutput()] });
  const logger = makeMockLogger();
  const { tokenTracker } = makeMockTokenTracker();

  const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
  const verdict = await reviewer.reviewMilestone(msId, ['src/foo.js'], ['task 1'], '', '/fake-project', harnessDir);

  assert.strictEqual(spawnSpy.calls.length, 2, `expected exactly two spawns (attempt-1 stub → retry), got ${spawnSpy.calls.length}`);
  assert.strictEqual(verdict.passed, false, 'retry verdict must be the gate result (not passed)');
  assert.notStrictEqual(verdict.structured.isStub, true, 'retry verdict must NOT carry isStub:true — it is a real non-stub verdict');
  const critical = (verdict.findings || []).filter(f => f.severity === 'critical');
  assert.ok(critical.length > 0, `retry verdict must carry the critical finding(s), got findings: ${JSON.stringify(verdict.findings)}`);
});

await test('(b) LEG-2: fake reviewer returns non-stub FAILED-critical verdict → routes to analyzer/remediation, not the zero-findings guard', async () => {
  const { harnessDir } = makeTmpHarness();

  let analyzerCalls = 0;
  const stub = makePipelineStub({
    harnessDir,
    reviewer: {
      reviewMilestone: async () => ({
        passed: false,
        findings: [{ severity: 'critical', category: 'functional', file: 'src/foo.js', description: 'critical composition bug' }],
        structured: { result: 'FAILED', findings: [{ severity: 'critical' }] },
        // no isStub — a full, retried, non-stub verdict is a full citizen.
      }),
    },
    _collectMilestoneContext: () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _renderReviewerDigest: () => {},
    analyzer: {
      analyzeFailure: async () => {
        analyzerCalls++;
        return { recommendation: 'human', eventId: 'ev-caseB' };
      },
    },
  });

  let thrown = null;
  try {
    await stub._executeMilestone('001', baseMsState);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'expected an error to be thrown');
  assert.strictEqual(analyzerCalls, 1, 'analyzer.analyzeFailure must be invoked exactly once — proving the normal analyzer path engaged');
  assert.ok(thrown instanceof CircuitBreakerError, `expected the analyzer/human-path CircuitBreakerError, got ${thrown.constructor?.name}`);
  const msg = thrown.message.toLowerCase();
  assert.ok(!msg.includes('stub response'), `must NOT be the isStub guard message, got: ${thrown.message}`);
  assert.ok(!msg.includes('no actionable'), `must NOT be the no-actionable guard message, got: ${thrown.message}`);
  assert.ok(msg.includes('human intervention'), `expected the analyzer 'human' path message, got: ${thrown.message}`);
});

// ═════════════════════════════════════════════════════════════════════════
// (c) BOTH attempts stub
// ═════════════════════════════════════════════════════════════════════════

await test('(c) LEG-1: both attempts stub → exactly two spawns (never a third), returned verdict isStub:true', async () => {
  const harnessDir = tmpHarnessDirLeg1();
  const msId = 'caseC';
  const { sessionManager, spawnSpy } = makeMockSessionManager({ outputs: [undefined, undefined] });
  const logger = makeMockLogger();
  const { tokenTracker } = makeMockTokenTracker();

  const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
  const verdict = await reviewer.reviewMilestone(msId, ['src/foo.js'], ['task 1'], '', '/fake-project', harnessDir);

  assert.strictEqual(spawnSpy.calls.length, 2, `expected exactly two spawns even when both stub, got ${spawnSpy.calls.length}`);
  assert.strictEqual(verdict.structured.isStub, true, 'the returned verdict must carry isStub:true when both attempts are stubs');
  assert.strictEqual(verdict.passed, false, 'a double-stub verdict must not be passed');
});

await test('(c) LEG-2: disposition of a stub verdict throws InfrastructureError (retryable, category unknown), not a plain Error, not CircuitBreakerError', async () => {
  const { harnessDir } = makeTmpHarness();

  const stub = makePipelineStub({
    harnessDir,
    reviewer: {
      reviewMilestone: async () => ({
        passed: false,
        findings: [],
        structured: { result: 'FAILED', findings: [], isStub: true, notes: '[stub] No structured_output from reviewer session.' },
      }),
    },
    _collectMilestoneContext: () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _renderReviewerDigest: () => {},
    analyzer: {
      analyzeFailure: async () => ({ recommendation: 'retry', eventId: 'ev-caseC' }),
    },
  });

  let thrown = null;
  try {
    await stub._executeMilestone('001', baseMsState);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'expected an error to be thrown');
  assert.ok(thrown instanceof InfrastructureError, `expected InfrastructureError, got ${thrown.constructor?.name}: ${thrown.message}`);
  assert.strictEqual(thrown.name, 'InfrastructureError', `err.name must be 'InfrastructureError', got ${thrown.name}`);
  assert.strictEqual(thrown.retryable, true, `err.retryable must be true, got ${thrown.retryable}`);
  // Spec rev-1 said category 'sdk', but 'sdk' is not in the InfrastructureError
  // category vocabulary (api/auth/network/server/unknown) — the implementation's
  // 'unknown' is the vocabulary-correct value, used consistently at both arms.
  assert.strictEqual(thrown.category, 'unknown', `err.category must be 'unknown', got ${thrown.category}`);
  assert.ok(!(thrown instanceof CircuitBreakerError), 'stub disposition must NOT be a CircuitBreakerError');
});

// ═════════════════════════════════════════════════════════════════════════
// (d) LEG-1: retry spawn THROWS → attempt-1 stub verdict returned, no throw
// ═════════════════════════════════════════════════════════════════════════

await test('(d) LEG-1: retry spawn throws → reviewMilestone resolves cleanly with attempt-1 stub verdict, no unhandledRejection', async () => {
  const harnessDir = tmpHarnessDirLeg1();
  const msId = 'caseD';
  const { sessionManager, spawnSpy } = makeMockSessionManager({ outputs: [undefined, passedOutput()], failSpawnAt: 1 });
  const logger = makeMockLogger();
  const { tokenTracker } = makeMockTokenTracker();

  const reviewer = new Reviewer(sessionManager, logger, tokenTracker);

  // Must NOT throw — degrades to attempt-1's stub verdict. If reviewer.js let
  // the retry spawn rejection propagate (or left a dangling unhandled
  // rejection), this await would either throw or the process would later
  // report an unhandledRejection.
  const verdict = await reviewer.reviewMilestone(msId, ['src/foo.js'], ['task 1'], '', '/fake-project', harnessDir);

  assert.strictEqual(spawnSpy.calls.length, 2, `retry must be attempted exactly once, got ${spawnSpy.calls.length}`);
  assert.strictEqual(verdict.structured.isStub, true, 'on retry-spawn failure, attempt-1\'s stub verdict must stand');
  assert.strictEqual(verdict.passed, false, 'attempt-1 stub verdict is not passed');
});

await test('(d) LEG-2: disposition of the surviving stub verdict still throws InfrastructureError', async () => {
  const { harnessDir } = makeTmpHarness();

  const stub = makePipelineStub({
    harnessDir,
    reviewer: {
      reviewMilestone: async () => ({
        passed: false,
        findings: [],
        structured: { result: 'FAILED', findings: [], isStub: true, notes: '[stub] No structured_output from reviewer session.' },
      }),
    },
    _collectMilestoneContext: () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _renderReviewerDigest: () => {},
    analyzer: {
      analyzeFailure: async () => ({ recommendation: 'retry', eventId: 'ev-caseD' }),
    },
  });

  let thrown = null;
  try {
    await stub._executeMilestone('001', baseMsState);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'expected an error to be thrown');
  assert.ok(thrown instanceof InfrastructureError, `expected InfrastructureError, got ${thrown.constructor?.name}: ${thrown.message}`);
  assert.strictEqual(thrown.retryable, true, `err.retryable must be true, got ${thrown.retryable}`);
  assert.ok(!(thrown instanceof CircuitBreakerError), 'must NOT be a CircuitBreakerError');
});

// ═════════════════════════════════════════════════════════════════════════
// (e) LEG-1: non-stub FAILED verdict with critical findings on attempt 1
// ═════════════════════════════════════════════════════════════════════════

await test('(e) LEG-1: non-stub FAILED-critical verdict on attempt 1 → single spawn, no retry, verdict returned as-is', async () => {
  const harnessDir = tmpHarnessDirLeg1();
  const msId = 'caseE';
  const { sessionManager, spawnSpy } = makeMockSessionManager({ outputs: [failedCriticalOutput()] });
  const logger = makeMockLogger();
  const { tokenTracker } = makeMockTokenTracker();

  const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
  const verdict = await reviewer.reviewMilestone(msId, ['src/foo.js'], ['task 1'], '', '/fake-project', harnessDir);

  assert.strictEqual(spawnSpy.calls.length, 1, `a non-stub attempt-1 verdict must NOT trigger a retry, got ${spawnSpy.calls.length} spawns`);
  assert.strictEqual(verdict.passed, false, 'FAILED-critical verdict must not be passed');
  assert.notStrictEqual(verdict.structured.isStub, true, 'non-stub verdict must not carry isStub:true');
  const critical = (verdict.findings || []).filter(f => f.severity === 'critical');
  assert.ok(critical.length > 0, 'critical finding must be preserved on the returned verdict');
});

// ═════════════════════════════════════════════════════════════════════════
// (f) LEG-2: non-stub warnings-only verdict — CircuitBreakerError arm unchanged
// ═════════════════════════════════════════════════════════════════════════

await test('(f) LEG-2: non-stub warnings-only verdict → CircuitBreakerError diagnostic (not InfrastructureError)', async () => {
  const { harnessDir } = makeTmpHarness();

  const stub = makePipelineStub({
    harnessDir,
    reviewer: {
      reviewMilestone: async () => ({
        passed: false,
        findings: [{ severity: 'warning', category: 'functional', file: 'src/foo.js', description: 'minor style issue' }],
        structured: { result: 'FAILED', findings: [{ severity: 'warning' }] },
        // no isStub — a real, non-stub, warnings-only verdict.
      }),
    },
    _collectMilestoneContext: () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _renderReviewerDigest: () => {},
    analyzer: {
      analyzeFailure: async () => ({ recommendation: 'retry', eventId: 'ev-caseF' }),
    },
  });

  let thrown = null;
  try {
    await stub._executeMilestone('001', baseMsState);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'expected an error to be thrown');
  assert.ok(thrown instanceof CircuitBreakerError, `expected CircuitBreakerError, got ${thrown.constructor?.name}: ${thrown.message}`);
  assert.ok(!(thrown instanceof InfrastructureError), 'warnings-only arm must NOT throw InfrastructureError');
  const msg = thrown.message;
  assert.ok(msg.includes('warnings only'), `expected 'warnings only' in message, got: ${msg}`);
  assert.ok(msg.includes('Circuit breaker'), `expected 'Circuit breaker' in message, got: ${msg}`);
});

// ═════════════════════════════════════════════════════════════════════════
// (g) LEG-1 ledger: two distinct-named recordSession calls, no conflation
// ═════════════════════════════════════════════════════════════════════════

await test('(g) LEG-1 ledger: recordSession captures both sessions under distinct names with per-attempt handle metadata', async () => {
  const harnessDir = tmpHarnessDirLeg1();
  const msId = 'caseG';
  const { sessionManager } = makeMockSessionManager({ outputs: [undefined, passedOutput()] });
  const logger = makeMockLogger();
  const { tokenTracker, recordSpy } = makeMockTokenTracker();

  const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
  await reviewer.reviewMilestone(msId, ['src/foo.js'], ['task 1'], '', '/fake-project', harnessDir);

  assert.strictEqual(recordSpy.calls.length, 2, `expected exactly two recordSession calls, got ${recordSpy.calls.length}: ${JSON.stringify(recordSpy.calls.map(c => c.name))}`);

  const attempt1 = recordSpy.calls.find(c => c.name === `reviewer-${msId}`);
  const retryRec = recordSpy.calls.find(c => c.name === `reviewer-${msId}-retry`);
  assert.ok(attempt1, `attempt-1 must be recorded as 'reviewer-${msId}', got names: ${JSON.stringify(recordSpy.calls.map(c => c.name))}`);
  assert.ok(retryRec, `retry must be recorded as 'reviewer-${msId}-retry', got names: ${JSON.stringify(recordSpy.calls.map(c => c.name))}`);

  // Distinct per-spawn handles (index 0 → toolCallCount 1 / tokens 10; index 1
  // → toolCallCount 2 / tokens 20) prove attempt-1's record carries its OWN
  // handle metadata, not the retry's — no conflation, nothing dropped.
  assert.strictEqual(attempt1.meta.toolCallCount, 1, `attempt-1 record must carry the FIRST spawn's handle metadata (toolCallCount 1), got ${attempt1.meta.toolCallCount}`);
  assert.strictEqual(attempt1.meta.systemPromptTokens, 10, `attempt-1 record must carry the FIRST spawn's systemPromptTokens (10), got ${attempt1.meta.systemPromptTokens}`);
  assert.strictEqual(retryRec.meta.toolCallCount, 2, `retry record must carry the SECOND spawn's handle metadata (toolCallCount 2), got ${retryRec.meta.toolCallCount}`);
  assert.strictEqual(retryRec.meta.systemPromptTokens, 20, `retry record must carry the SECOND spawn's systemPromptTokens (20), got ${retryRec.meta.systemPromptTokens}`);
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
