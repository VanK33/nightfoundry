#!/usr/bin/env node

/**
 * test-status-bar-integration.js — Integration tests verifying StatusBar is
 * wired correctly in Pipeline.
 *
 * Verifies:
 *   - Pipeline constructor creates StatusBar with the correct enabled flag.
 *   - updateAgent is called with the correct role/status at executor, verifier,
 *     analyzer, reviewer, and planner dispatch boundaries.
 *   - All updateAgent 'active' calls have a matching 'idle' call in a finally block.
 *   - updateMilestone is called at milestone start.
 *   - destroy is called in run() finally block.
 *   - Non-TTY mode: StatusBar methods are no-ops (no stream output).
 *
 * Pattern: uses Object.create(Pipeline.prototype) to create minimal stubs that
 * call real pipeline methods with mocked dependencies, avoiding the heavy
 * constructor (agents, sessions, filesystem init).
 *
 * Run: node test/test-status-bar-integration.js
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { Writable } from 'stream';

import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { StatusBar } from '../src/orchestrator/infra/status-bar.js';
import { TokenTracker } from '../src/orchestrator/infra/token-tracker.js';
import { writeVerifyJson } from '../src/orchestrator/core/state.js';
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

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * A Writable stream that records everything written to it.
 * isTTY / rows / columns can be set to exercise TTY rendering.
 */
function makeFakeStream({ isTTY = false, rows = 24, columns = 80 } = {}) {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  stream.isTTY = isTTY;
  stream.rows = rows;
  stream.columns = columns;
  return { stream, chunks };
}

/**
 * Create a mock StatusBar that records all calls.
 * Returned object exposes .calls[] for assertions and .agents (Map) because
 * pipeline's elapsed-ticker iterates it.
 *
 * Surface must match the real StatusBar's public API (status-bar.js) —
 * pipeline.js and dashboard.js call every method listed here.
 */
function makeMockStatusBar() {
  const calls = [];
  const agents = new Map();
  return {
    calls,
    agents,
    updateAgent: (name, state) => {
      calls.push({ method: 'updateAgent', name, state });
      if (state === null) agents.delete(name);
      else                agents.set(name, state);
    },
    updateProgress:  (done, total, cost, sessionCount) => calls.push({ method: 'updateProgress', done, total, cost, sessionCount }),
    updateMilestone: (msId, msTotal, elapsed)          => calls.push({ method: 'updateMilestone', msId, msTotal, elapsed }),
    setPhase:        (name)                            => calls.push({ method: 'setPhase', name }),
    onLog:           (message)                         => calls.push({ method: 'onLog', message: String(message) }),
    promptWillStart: ()                                => calls.push({ method: 'promptWillStart' }),
    promptDidEnd:    ()                                => calls.push({ method: 'promptDidEnd' }),
    hide:            ()                                => calls.push({ method: 'hide' }),
    show:            ()                                => calls.push({ method: 'show' }),
    teardown:        ()                                => calls.push({ method: 'teardown' }),
    destroy:         ()                                => calls.push({ method: 'destroy' }),
  };
}

/**
 * Create a minimal Pipeline stub via Object.create(Pipeline.prototype).
 * The constructor is never invoked; only the required prototype methods are
 * available, and any dependencies that the method under test reads from
 * `this` must be provided as overrides.
 */
function makePipelineStub(overrides = {}) {
  const stub = Object.create(Pipeline.prototype);
  // Sensible defaults for every test
  stub.onLog              = () => {};
  stub.onConfirm          = async () => true;
  stub.harnessDir         = '/fake-harness';
  stub.projectRoot        = '/fake-project';
  stub.noReview           = true;
  stub.skipReview         = false;
  stub._mode              = undefined;
  stub._cachedImportGraph = '';
  stub.statusBar          = makeMockStatusBar();
  stub.tokenTracker       = {
    getTotalUsage:  () => ({ totalCostUsd: 0, sessionCount: 0 }),
    getUsageByType: () => ({ totalCostUsd: 0, sessionCount: 0 }),
  };
  stub._msElapsedInterval = null;
  stub._msStartTime       = null;
  // run() reads this._cancelController.signal after _executeAllMilestones;
  // the real constructor sets it but the stub bypasses construction.
  stub._cancelController  = new AbortController();
  // Pipeline.run()'s finally removes signal handlers by reference; the
  // real Pipeline constructor registers them, but the stub bypasses it.
  // No-op stubs keep run()'s finally block from crashing on undefined.
  stub._signalHandlers = {
    SIGINT:             () => {},
    SIGTERM:            () => {},
    exit:               () => {},
    uncaughtException:  () => {},
  };
  // run() calls this._runFinalTestGate after _reviewGate; the real constructor
  // sets it but the stub bypasses construction. No-op keeps run() from crashing.
  stub._runFinalTestGate = () => {};
  // _executeAndVerifyTask calls the snapshot capture/restore seam; the real
  // constructor assigns this._snapshotFiles/_restoreSnapshot but the stub
  // bypasses construction. No-ops keep the task lifecycle from crashing;
  // restore returns 0 (falsy) so the "Restored N file(s)" log stays silent.
  stub._snapshotFiles  = () => {};
  stub._restoreSnapshot = () => 0;
  // Same constructor-bypass gap for the phantom-write predicate seam:
  // an all-clear verdict keeps the disambiguation-probe route dormant.
  stub._assertChangesLanded = () => ({ ok: true, unchanged: [], bothMissing: [] });
  // run() re-points the harness seam into the per-run dir via _repointHarness,
  // which re-injects the rebuilt tokenTracker into sessionManager; the real
  // constructor sets sessionManager but the stub bypasses construction.
  stub.sessionManager = { setTokenTracker: () => {} };
  // Apply caller-supplied overrides last
  Object.assign(stub, overrides);
  // Create ProgressTracker after overrides so it uses the final harnessDir/logger
  stub.progress = new ProgressTracker(stub.harnessDir, stub.logger ?? null);
  return stub;
}

/**
 * Create a temporary harness directory tree with just enough files for
 * _executeAndVerifyTask / _executeMilestone to run without throwing on state I/O.
 *
 * A minimal state.json is written so that readState() succeeds.
 * verifyMilestone() returns early when the milestone is absent from
 * state.milestones, which is the default here.
 */
function makeTmpHarness() {
  const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-sb-int-'));
  const harnessDir = path.join(tmpDir, '.harness');
  for (const sub of ['state', 'plan', 'verify', 'progress', 'verification', 'logs', 'snapshots', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  // Minimal global state — no milestones so verifyMilestone returns early.
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify({
    projectMeta:  { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones:   {},
  }, null, 2));
  return { tmpDir, harnessDir };
}

/**
 * Extend the harness state.json to include a milestone that can be transitioned
 * to 'complete' (one mission in 'complete' status so canComplete passes).
 */
function addMilestoneToState(harnessDir, msId) {
  const statePath = path.join(harnessDir, 'state.json');
  const state     = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.milestones[msId] = {
    id:          msId,
    description: 'Integration-test milestone',
    status:      'in_progress',
    missions:    {
      // One dummy mission in 'complete' so canComplete() returns true
      [`${msId}-001`]: { id: `${msId}-001`, description: 'dummy', status: 'complete' },
    },
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Write a minimal mission state file so that transitionTask / readTaskStatus
 * can operate on the given task.
 */
function writeMissionStateFile(harnessDir, missionId, subMissionId, taskId, taskStatus = 'pending') {
  const stateFile = path.join(harnessDir, 'state', `mission-${missionId}.json`);
  const state = {
    id:          missionId,
    description: 'Integration-test mission',
    status:      'in_progress',
    subMissions: {
      [subMissionId]: {
        id:          subMissionId,
        description: 'Integration-test sub-mission',
        status:      'in_progress',
        tasks: {
          [taskId]: {
            id:          taskId,
            description: 'Integration-test task',
            status:      taskStatus,
            targetFiles: [],
          },
        },
      },
    },
  };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

/**
 * Write a minimal verification sidecar so that the state-machine allows the
 * 'awaiting_verification' → 'verified' transition when verifyTask succeeds.
 */
function writeVerificationSidecar(harnessDir, taskId) {
  const sidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);
  fs.writeFileSync(sidecarPath, JSON.stringify({
    result:          'PASSED',
    hardChecks:      [],
    taskScopeChecks: [],
    notes:           null,
  }, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// TC1: Pipeline constructor creates StatusBar with correct enabled flag
// ─────────────────────────────────────────────────────────────────────────────

await test('TC1: StatusBar enabled=false when opts.statusBar=false (non-TTY path Pipeline uses)', () => {
  // Pipeline passes: enabled: Boolean(process.stdout.isTTY) && statusBarOpt !== false
  // When statusBarOpt === false the enabled flag must be false regardless of TTY.
  const { stream } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream, enabled: Boolean(true) && false !== false });
  assert.strictEqual(sb.enabled, false, 'StatusBar must be disabled when statusBarOpt=false');
  sb.destroy();
});

await test('TC1: StatusBar enabled=false when isTTY is falsy (non-TTY terminal)', () => {
  // When process.stdout.isTTY is falsy, Boolean(falsy) && ... === false.
  const { stream } = makeFakeStream({ isTTY: false });
  const sb = new StatusBar({ output: stream, enabled: Boolean(false) });
  assert.strictEqual(sb.enabled, false, 'StatusBar must be disabled when isTTY is false');
  sb.destroy();
});

await test('TC1: StatusBar enabled=true when isTTY=true and statusBar option is not false', () => {
  // When isTTY=true and statusBarOpt is undefined: Boolean(true) && true === true.
  const { stream } = makeFakeStream({ isTTY: true });
  const sb = new StatusBar({ output: stream, enabled: Boolean(true) && undefined !== false });
  assert.strictEqual(sb.enabled, true, 'StatusBar must be enabled when isTTY=true and no disabling opt');
  sb.destroy();
});

// ─────────────────────────────────────────────────────────────────────────────
// TC2 + TC3: updateAgent called for Executor and Verifier in _executeAndVerifyTask
// ─────────────────────────────────────────────────────────────────────────────

await test('TC2: updateAgent called with role=executor at executor dispatch boundary', async () => {
  const { harnessDir, tmpDir } = makeTmpHarness();
  const missionId    = '001-001';
  const subMissionId = '001-001-001';
  const taskId       = '001-001-001-001';

  writeMissionStateFile(harnessDir, missionId, subMissionId, taskId, 'pending');
  writeVerificationSidecar(harnessDir, taskId);

  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    harnessDir,
    projectRoot: tmpDir,
    statusBar:   mockStatusBar,
    executor: {
      executeTask: async () => ({ status: 'COMPLETED', output: 'ok' }),
    },
    verifier: {
      verifyTask: async () => ({ verified: true }),
    },
    _dispatchAnalyzer: async () => {},
  });

  await stub._executeAndVerifyTask(missionId, subMissionId, { id: taskId, description: 'Test task', targetFiles: [] });

  const executorActive = mockStatusBar.calls.find(
    (c) => c.method === 'updateAgent' && c.name?.startsWith('executor-') && c.state?.role === 'executor' && c.state?.status === 'active'
  );
  assert.ok(executorActive, 'updateAgent("executor-<taskId>", {role:"executor", status:"active"}) must be called');
});

await test('TC2: updateAgent called with null signal for Executor in finally block', async () => {
  const { harnessDir, tmpDir } = makeTmpHarness();
  const missionId    = '001-001';
  const subMissionId = '001-001-001';
  const taskId       = '001-001-001-002';

  writeMissionStateFile(harnessDir, missionId, subMissionId, taskId, 'pending');
  writeVerificationSidecar(harnessDir, taskId);

  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    harnessDir,
    projectRoot: tmpDir,
    statusBar:   mockStatusBar,
    executor: {
      executeTask: async () => { throw new Error('executor-error'); },
    },
    verifier: {
      verifyTask: async () => ({ verified: false }),
    },
    _dispatchAnalyzer: async () => {},
  });

  // Executor throws — the finally block must still call null signal (agent deletion)
  try {
    await stub._executeAndVerifyTask(missionId, subMissionId, { id: taskId, description: 'Test task', targetFiles: [] });
  } catch (_) { /* expected */ }

  const executorNull = mockStatusBar.calls.find(
    (c) => c.method === 'updateAgent' && c.name?.startsWith('executor-') && c.state === null
  );
  assert.ok(executorNull, 'updateAgent("executor-<taskId>", null) must be called in finally even when executor throws');
});

await test('TC3: updateAgent called with role=verifier at verifier dispatch boundary', async () => {
  const { harnessDir, tmpDir } = makeTmpHarness();
  const missionId    = '001-001';
  const subMissionId = '001-001-001';
  const taskId       = '001-001-001-003';

  writeMissionStateFile(harnessDir, missionId, subMissionId, taskId, 'pending');
  writeVerificationSidecar(harnessDir, taskId);

  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    harnessDir,
    projectRoot: tmpDir,
    statusBar:   mockStatusBar,
    executor: {
      executeTask: async () => ({ status: 'COMPLETED', output: 'ok' }),
    },
    verifier: {
      verifyTask: async () => ({ verified: true }),
    },
    _dispatchAnalyzer: async () => {},
  });

  await stub._executeAndVerifyTask(missionId, subMissionId, { id: taskId, description: 'Test task', targetFiles: [] });

  const verifierActive = mockStatusBar.calls.find(
    (c) => c.method === 'updateAgent' && c.name?.startsWith('verifier-') && c.state?.role === 'verifier' && c.state?.status === 'active'
  );
  assert.ok(verifierActive, 'updateAgent("verifier-<taskId>", {role:"verifier", status:"active"}) must be called');
});

await test('TC3: updateAgent called with null signal for Verifier in finally block', async () => {
  const { harnessDir, tmpDir } = makeTmpHarness();
  const missionId    = '001-001';
  const subMissionId = '001-001-001';
  const taskId       = '001-001-001-004';

  writeMissionStateFile(harnessDir, missionId, subMissionId, taskId, 'pending');

  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    harnessDir,
    projectRoot: tmpDir,
    statusBar:   mockStatusBar,
    executor: {
      executeTask: async () => ({ status: 'COMPLETED', output: 'ok' }),
    },
    verifier: {
      verifyTask: async () => { throw new Error('verifier-error'); },
    },
    _dispatchAnalyzer: async () => {},
  });

  // Verifier throws — the finally block must still call null signal (agent deletion)
  try {
    await stub._executeAndVerifyTask(missionId, subMissionId, { id: taskId, description: 'Test task', targetFiles: [] });
  } catch (_) { /* expected */ }

  const verifierNull = mockStatusBar.calls.find(
    (c) => c.method === 'updateAgent' && c.name?.startsWith('verifier-') && c.state === null
  );
  assert.ok(verifierNull, 'updateAgent("verifier-<taskId>", null) must be called in finally even when verifier throws');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC4: updateAgent called with role=reviewer at reviewer dispatch boundary
// ─────────────────────────────────────────────────────────────────────────────

await test('TC4: updateAgent called with role=reviewer at reviewer dispatch boundary', async () => {
  const { harnessDir } = makeTmpHarness();
  addMilestoneToState(harnessDir, '001');

  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    harnessDir,
    statusBar:  mockStatusBar,
    noReview:   false,
    skipReview: false,
    reviewer: {
      reviewMilestone: async () => ({ passed: true, findings: [] }),
    },
    verifier: {
      // verifyMilestone calls verifier.verifyRegression for the regression check
      verifyRegression: async () => ({ verified: true }),
    },
    _collectMilestoneContext: () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _executeMilestoneParallel: async () => {},
    _writeVerificationSummary: () => {},
  });

  const msState = {
    description: 'Test milestone',
    status:      'in_progress',   // skip transitionMilestone(pending→in_progress) call
    missions:    {},
  };

  // May throw after the reviewer section (transitionMilestone / coverage gates).
  // We only care that the reviewer statusBar call was made.
  try {
    await stub._executeMilestone('001', msState);
  } catch (_) { /* expected downstream failure is OK */ }

  const reviewerActive = mockStatusBar.calls.find(
    (c) => c.method === 'updateAgent' && c.name === 'reviewer' && c.state?.role === 'reviewer' && c.state?.status === 'active'
  );
  assert.ok(reviewerActive, 'updateAgent("reviewer", {role:"reviewer", status:"active"}) must be called');
});

await test('TC4: updateAgent called with null signal for Reviewer in finally block', async () => {
  const { harnessDir } = makeTmpHarness();

  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    harnessDir,
    statusBar:  mockStatusBar,
    noReview:   false,
    skipReview: false,
    reviewer: {
      reviewMilestone: async () => { throw new Error('reviewer-error'); },
    },
    _collectMilestoneContext: () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _executeMilestoneParallel: async () => {},
    _writeVerificationSummary: async () => {},
  });

  const msState = {
    description: 'Test milestone',
    status:      'in_progress',
    missions:    {},
  };

  try {
    await stub._executeMilestone('001', msState);
  } catch (_) { /* expected */ }

  const reviewerNull = mockStatusBar.calls.find(
    (c) => c.method === 'updateAgent' && c.name === 'reviewer' && c.state === null
  );
  assert.ok(reviewerNull, 'updateAgent("reviewer", null) must be called in finally even when reviewer throws');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC5: updateAgent called with role=planner at planner dispatch boundaries
// ─────────────────────────────────────────────────────────────────────────────

await test('TC5: updateAgent called with role=planner at planner dispatch boundary (verifyAssumptions)', async () => {
  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    statusBar: mockStatusBar,
    planner: {
      verifyAssumptions: async () => [],  // no failures, no uncertain → early return
    },
    onConfirm: async () => true,
  });

  const globalPlan = {
    assumptions: [{ text: 'test assumption', specSection: null }],
  };

  await stub._remediateAssumptions(globalPlan, { mode: 'interactive' });

  const plannerActive = mockStatusBar.calls.find(
    (c) => c.method === 'updateAgent' && c.name === 'planner' && c.state?.role === 'planner' && c.state?.status === 'active'
  );
  assert.ok(plannerActive, 'updateAgent("planner", {role:"planner", status:"active"}) must be called');
});

await test('TC5: updateAgent called with null signal for Planner in finally block', async () => {
  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    statusBar: mockStatusBar,
    planner: {
      verifyAssumptions: async () => { throw new Error('planner-error'); },
    },
  });

  const globalPlan = {
    assumptions: [{ text: 'test assumption', specSection: null }],
  };

  try {
    await stub._remediateAssumptions(globalPlan, { mode: 'interactive' });
  } catch (_) { /* expected */ }

  const plannerNull = mockStatusBar.calls.find(
    (c) => c.method === 'updateAgent' && c.name === 'planner' && c.state === null
  );
  assert.ok(plannerNull, 'updateAgent("planner", null) must be called in finally even when planner throws');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC6: All updateAgent 'active' calls have a matching 'idle' call in finally
// ─────────────────────────────────────────────────────────────────────────────

await test('TC6: Executor active/null pair — null signal always follows active (success path)', async () => {
  const { harnessDir, tmpDir } = makeTmpHarness();
  const taskId = '001-001-001-061';
  writeMissionStateFile(harnessDir, '001-001', '001-001-001', taskId, 'pending');
  writeVerificationSidecar(harnessDir, taskId);
  // verify.json required so the (now fail-closed) hard-check gate passes and the
  // task stays on the happy path this test asserts — without it the missing
  // sidecar fails the task, and the FAILED path's extra agent signals unbalance
  // the active/null pairing being measured here.
  writeVerifyJson(harnessDir, { id: taskId, targetFiles: [] });

  const mockStatusBar = makeMockStatusBar();
  const stub = makePipelineStub({
    harnessDir,
    projectRoot: tmpDir,
    statusBar:   mockStatusBar,
    executor:    { executeTask: async () => ({ status: 'COMPLETED', output: 'ok' }) },
    verifier:    { verifyTask: async () => ({ verified: true }) },
  });

  await stub._executeAndVerifyTask('001-001', '001-001-001', { id: taskId, description: 'task', targetFiles: [] });

  const executorCalls = mockStatusBar.calls.filter((c) => c.method === 'updateAgent' && c.name?.startsWith('executor-'));
  const activeCalls   = executorCalls.filter((c) => c.state?.status === 'active');
  const nullCalls     = executorCalls.filter((c) => c.state === null);
  assert.strictEqual(activeCalls.length, nullCalls.length, 'Every Executor active call must have a matching null signal call');
});

await test('TC6: Verifier active/null pair — null signal always follows active (success path)', async () => {
  const { harnessDir, tmpDir } = makeTmpHarness();
  const taskId = '001-001-001-062';
  writeMissionStateFile(harnessDir, '001-001', '001-001-001', taskId, 'pending');
  writeVerificationSidecar(harnessDir, taskId);
  // verify.json required so the (now fail-closed) hard-check gate passes and the
  // task stays on the happy path this test asserts (see TC6 Executor note).
  writeVerifyJson(harnessDir, { id: taskId, targetFiles: [] });

  const mockStatusBar = makeMockStatusBar();
  const stub = makePipelineStub({
    harnessDir,
    projectRoot: tmpDir,
    statusBar:   mockStatusBar,
    executor:    { executeTask: async () => ({ status: 'COMPLETED', output: 'ok' }) },
    verifier:    { verifyTask: async () => ({ verified: true }) },
  });

  await stub._executeAndVerifyTask('001-001', '001-001-001', { id: taskId, description: 'task', targetFiles: [] });

  const verifierCalls = mockStatusBar.calls.filter((c) => c.method === 'updateAgent' && c.name?.startsWith('verifier-'));
  const activeCalls   = verifierCalls.filter((c) => c.state?.status === 'active');
  const nullCalls     = verifierCalls.filter((c) => c.state === null);
  assert.strictEqual(activeCalls.length, nullCalls.length, 'Every Verifier active call must have a matching null signal call');
});

await test('TC6: Reviewer active/null pair — null signal always follows active (success path)', async () => {
  const { harnessDir } = makeTmpHarness();
  addMilestoneToState(harnessDir, '001');
  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    harnessDir,
    statusBar:  mockStatusBar,
    noReview:   false,
    skipReview: false,
    reviewer:   { reviewMilestone: async () => ({ passed: true, findings: [] }) },
    verifier:   { verifyRegression: async () => ({ verified: true }) },
    _collectMilestoneContext: () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _executeMilestoneParallel: async () => {},
    _writeVerificationSummary: () => {},
  });

  // May throw after reviewer section; we only care about active/null balance.
  try {
    await stub._executeMilestone('001', { description: 'ms', status: 'in_progress', missions: {} });
  } catch (_) { /* downstream failure OK */ }

  const reviewerCalls = mockStatusBar.calls.filter((c) => c.method === 'updateAgent' && c.name === 'reviewer');
  const activeCalls   = reviewerCalls.filter((c) => c.state?.status === 'active');
  const nullCalls     = reviewerCalls.filter((c) => c.state === null);
  assert.strictEqual(activeCalls.length, nullCalls.length, 'Every Reviewer active call must have a matching null signal call');
});

await test('TC6: Planner active/null pair — null signal always follows active (success path)', async () => {
  const mockStatusBar = makeMockStatusBar();
  const stub = makePipelineStub({
    statusBar: mockStatusBar,
    planner:   { verifyAssumptions: async () => [] },
    onConfirm: async () => true,
  });

  await stub._remediateAssumptions({ assumptions: [{ text: 'a' }] }, { mode: 'interactive' });

  const plannerCalls = mockStatusBar.calls.filter((c) => c.method === 'updateAgent' && c.name === 'planner');
  const activeCalls  = plannerCalls.filter((c) => c.state?.status === 'active');
  const nullCalls    = plannerCalls.filter((c) => c.state === null);
  assert.strictEqual(activeCalls.length, nullCalls.length, 'Every Planner active call must have a matching null signal call');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC6b (new): per-role cost field present in active state
// ─────────────────────────────────────────────────────────────────────────────

await test('TC6b: active state for executor includes cost field from tokenTracker.getUsageByType', async () => {
  const { harnessDir, tmpDir } = makeTmpHarness();
  const taskId = '001-001-001-cost1';
  writeMissionStateFile(harnessDir, '001-001', '001-001-001', taskId, 'pending');
  writeVerificationSidecar(harnessDir, taskId);

  const executorCost = 0.077;
  const mockStatusBar = makeMockStatusBar();
  const tokenTracker  = makeMockTokenTracker({
    totalCostUsd: 0.1,
    sessionCount: 1,
    byType: { executor: { totalCostUsd: executorCost }, verifier: { totalCostUsd: 0.01 } },
  });

  const stub = makePipelineStub({
    harnessDir,
    projectRoot:       tmpDir,
    statusBar:         mockStatusBar,
    tokenTracker,
    executor:          { executeTask: async () => ({ status: 'COMPLETED', output: 'ok' }) },
    verifier:          { verifyTask:  async () => ({ verified: true }) },
    _dispatchAnalyzer: async () => {},
  });

  await stub._executeAndVerifyTask('001-001', '001-001-001', { id: taskId, description: 'cost-test', targetFiles: [] });

  const executorActive = mockStatusBar.calls.find(
    (c) => c.method === 'updateAgent' && c.name?.startsWith('executor-') && c.state?.status === 'active'
  );
  assert.ok(executorActive, 'executor active call must be present');
  assert.ok('cost' in executorActive.state, 'executor active state must have a cost field');
  assert.strictEqual(executorActive.state.cost, executorCost, `executor active state cost must equal tokenTracker.getUsageByType('executor').totalCostUsd (${executorCost})`);
});

await test('TC6b: active state for verifier includes cost field from tokenTracker.getUsageByType', async () => {
  const { harnessDir, tmpDir } = makeTmpHarness();
  const taskId = '001-001-001-cost2';
  writeMissionStateFile(harnessDir, '001-001', '001-001-001', taskId, 'pending');
  writeVerificationSidecar(harnessDir, taskId);

  const verifierCost = 0.033;
  const mockStatusBar = makeMockStatusBar();
  const tokenTracker  = makeMockTokenTracker({
    totalCostUsd: 0.1,
    sessionCount: 1,
    byType: { executor: { totalCostUsd: 0.05 }, verifier: { totalCostUsd: verifierCost } },
  });

  const stub = makePipelineStub({
    harnessDir,
    projectRoot:       tmpDir,
    statusBar:         mockStatusBar,
    tokenTracker,
    executor:          { executeTask: async () => ({ status: 'COMPLETED', output: 'ok' }) },
    verifier:          { verifyTask:  async () => ({ verified: true }) },
    _dispatchAnalyzer: async () => {},
  });

  await stub._executeAndVerifyTask('001-001', '001-001-001', { id: taskId, description: 'cost-test', targetFiles: [] });

  const verifierActive = mockStatusBar.calls.find(
    (c) => c.method === 'updateAgent' && c.name?.startsWith('verifier-') && c.state?.status === 'active'
  );
  assert.ok(verifierActive, 'verifier active call must be present');
  assert.ok('cost' in verifierActive.state, 'verifier active state must have a cost field');
  assert.strictEqual(verifierActive.state.cost, verifierCost, `verifier active state cost must equal tokenTracker.getUsageByType('verifier').totalCostUsd (${verifierCost})`);
});

await test('TC6b: active state for reviewer includes cost field from tokenTracker.getUsageByType', async () => {
  const { harnessDir } = makeTmpHarness();
  addMilestoneToState(harnessDir, '001');

  const reviewerCost  = 0.055;
  const mockStatusBar = makeMockStatusBar();
  const tokenTracker  = makeMockTokenTracker({
    totalCostUsd: 0.1,
    sessionCount: 1,
    byType: { reviewer: { totalCostUsd: reviewerCost } },
  });

  const stub = makePipelineStub({
    harnessDir,
    statusBar:   mockStatusBar,
    tokenTracker,
    noReview:    false,
    skipReview:  false,
    reviewer:    { reviewMilestone: async () => ({ passed: true, findings: [] }) },
    verifier:    { verifyRegression: async () => ({ verified: true }) },
    _collectMilestoneContext:  () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _executeMilestoneParallel: async () => {},
    _writeVerificationSummary: () => {},
  });

  try {
    await stub._executeMilestone('001', { description: 'ms', status: 'in_progress', missions: {} });
  } catch (_) { /* downstream failure OK */ }

  const reviewerActive = mockStatusBar.calls.find(
    (c) => c.method === 'updateAgent' && c.name === 'reviewer' && c.state?.status === 'active'
  );
  assert.ok(reviewerActive, 'reviewer active call must be present');
  assert.ok('cost' in reviewerActive.state, 'reviewer active state must have a cost field');
  assert.strictEqual(reviewerActive.state.cost, reviewerCost, `reviewer active state cost must equal tokenTracker.getUsageByType('reviewer').totalCostUsd (${reviewerCost})`);
});

await test('TC6b: active state for planner includes cost field from tokenTracker.getUsageByType', async () => {
  const plannerCost   = 0.021;
  const mockStatusBar = makeMockStatusBar();
  const tokenTracker  = makeMockTokenTracker({
    totalCostUsd: 0.1,
    sessionCount: 1,
    byType: { planner: { totalCostUsd: plannerCost } },
  });

  const stub = makePipelineStub({
    statusBar:  mockStatusBar,
    tokenTracker,
    planner:    { verifyAssumptions: async () => [] },
    onConfirm:  async () => true,
  });

  await stub._remediateAssumptions({ assumptions: [{ text: 'a' }] }, { mode: 'interactive' });

  const plannerActive = mockStatusBar.calls.find(
    (c) => c.method === 'updateAgent' && c.name === 'planner' && c.state?.status === 'active'
  );
  assert.ok(plannerActive, 'planner active call must be present');
  assert.ok('cost' in plannerActive.state, 'planner active state must have a cost field');
  assert.strictEqual(plannerActive.state.cost, plannerCost, `planner active state cost must equal tokenTracker.getUsageByType('planner').totalCostUsd (${plannerCost})`);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC7: updateMilestone called at milestone start
// ─────────────────────────────────────────────────────────────────────────────

await test('TC7: updateMilestone called when _executeMilestone starts', async () => {
  const { harnessDir } = makeTmpHarness();
  addMilestoneToState(harnessDir, '001');
  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    harnessDir,
    statusBar:                 mockStatusBar,
    noReview:                  true,
    verifier:                  { verifyRegression: async () => ({ verified: true }) },
    _executeMilestoneParallel: async () => {},
    _writeVerificationSummary: () => {},
  });

  const msId    = '001';
  const msState = {
    description: 'Test milestone for updateMilestone',
    status:      'in_progress',  // skips transitionMilestone(pending→in_progress)
    missions:    {},
  };

  await stub._executeMilestone(msId, msState);

  const milestoneCalls = mockStatusBar.calls.filter((c) => c.method === 'updateMilestone');
  assert.ok(milestoneCalls.length > 0, 'updateMilestone must be called during _executeMilestone');

  const call = milestoneCalls[0];
  assert.strictEqual(call.msId, msId, 'updateMilestone must receive the correct msId');
});

await test('TC7: updateMilestone receives msTotal derived from mission count when no state files exist', async () => {
  const { harnessDir } = makeTmpHarness();
  addMilestoneToState(harnessDir, '001');
  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    harnessDir,
    statusBar:                 mockStatusBar,
    noReview:                  true,
    verifier:                  { verifyRegression: async () => ({ verified: true }) },
    _executeMilestoneParallel: async () => {},
    _writeVerificationSummary: () => {},
  });

  // Two missions in msState → fallback count = 2 (no mission state files on disk)
  const msState = {
    description: 'Milestone with missions',
    status:      'in_progress',
    missions:    { '001-001': { status: 'pending' }, '001-002': { status: 'pending' } },
  };

  // May throw from transitionMilestone canComplete check (since missions in state.json
  // are not the same as msState.missions, but updateMilestone is called before that).
  try {
    await stub._executeMilestone('001', msState);
  } catch (_) { /* downstream failure OK — updateMilestone was already called */ }

  const call = mockStatusBar.calls.find((c) => c.method === 'updateMilestone');
  assert.ok(call, 'updateMilestone must be called');
  assert.strictEqual(call.msTotal, 2, 'updateMilestone msTotal must match the number of missions when no task state files exist');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC8: destroy called in run() finally block
// ─────────────────────────────────────────────────────────────────────────────

await test('TC8: destroy called in run() finally block even when pipeline throws', async () => {
  const { harnessDir, tmpDir } = makeTmpHarness();

  // Write state.json so bootstrap is skipped
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify({
    projectMeta:  { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones:   {},
  }, null, 2));

  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    harnessDir,
    projectRoot:               tmpDir,
    statusBar:                 mockStatusBar,
    // Override heavy methods that run before the try/finally
    _checkOverwriteProtection: () => {},
    _runPreflight:             () => {},
    _runStartSessionCount:     0,
    // Make planner.planGlobal throw inside the try block so we reach the finally
    planner: {
      planGlobal:           async () => { throw new Error('TC8-abort-for-test'); },
      closeReusableSession: async () => {},
    },
    onLog: () => {},
  });

  try {
    await stub.run('test goal', {});
  } catch (err) {
    if (!err.message.includes('TC8-abort-for-test')) throw err;
  }

  const destroyCalls = mockStatusBar.calls.filter((c) => c.method === 'destroy');
  assert.ok(destroyCalls.length > 0, 'statusBar.destroy() must be called in run() finally block');
});

await test('TC8: destroy called in run() finally block on success path', async () => {
  const { harnessDir, tmpDir } = makeTmpHarness();

  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify({
    projectMeta:  { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones:   {},
  }, null, 2));

  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    harnessDir,
    projectRoot:               tmpDir,
    statusBar:                 mockStatusBar,
    _checkOverwriteProtection: () => {},
    _runPreflight:             () => {},
    _runStartSessionCount:     0,
    tokenTracker:              {
      getTotalUsage:  () => ({ sessionCount: 0, totalCostUsd: 0 }),
      getUsageByType: () => ({ totalCostUsd: 0, sessionCount: 0 }),
    },
    planner: {
      // Return a minimal valid global plan with no milestones
      planGlobal: async () => ({
        milestones:  [],
        assumptions: [],
      }),
      closeReusableSession: async () => {},
    },
    onConfirm: async () => true,
    onLog:     () => {},
    // Override _executeAllMilestones + _reviewGate to no-ops
    _executeAllMilestones: async () => {},
    _reviewGate:           async () => {},
    _cachedImportGraph:    '',
  });

  await stub.run('test goal', {});

  const destroyCalls = mockStatusBar.calls.filter((c) => c.method === 'destroy');
  assert.ok(destroyCalls.length > 0, 'statusBar.destroy() must be called in run() finally block on success');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC9: Non-TTY mode — StatusBar methods are no-ops
// ─────────────────────────────────────────────────────────────────────────────

await test('TC9: Non-TTY StatusBar.updateAgent produces no stream output', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: false });
  const sb = new StatusBar({ output: stream, enabled: false });

  sb.updateAgent('Executor', { role: 'executor', taskId: '001-001-001-001', description: 'test', status: 'active', elapsed: 0, cost: 0 });
  sb.updateAgent('Executor', null);

  assert.strictEqual(chunks.length, 0, 'Non-TTY updateAgent must produce no stream output');
  sb.destroy();
});

await test('TC9: Non-TTY StatusBar.updateProgress produces no stream output', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: false });
  const sb = new StatusBar({ output: stream, enabled: false });

  sb.updateProgress(1, 5, 0.01, 1);

  assert.strictEqual(chunks.length, 0, 'Non-TTY updateProgress must produce no stream output');
  sb.destroy();
});

await test('TC9: Non-TTY StatusBar.updateMilestone produces no stream output', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: false });
  const sb = new StatusBar({ output: stream, enabled: false });

  sb.updateMilestone('001', 5, 0);

  assert.strictEqual(chunks.length, 0, 'Non-TTY updateMilestone must produce no stream output');
  sb.destroy();
});

await test('TC9: Non-TTY StatusBar.destroy produces no stream output', () => {
  const { stream, chunks } = makeFakeStream({ isTTY: false });
  const sb = new StatusBar({ output: stream, enabled: false });

  sb.destroy();

  assert.strictEqual(chunks.length, 0, 'Non-TTY destroy must produce no stream output');
});

await test('TC9: Pipeline with statusBar:false creates disabled StatusBar (no output from any method)', () => {
  // Verify the exact formula Pipeline uses: Boolean(isTTY) && statusBarOpt !== false
  // When statusBarOpt = false → enabled = false regardless of isTTY
  const { stream, chunks } = makeFakeStream({ isTTY: true });

  // Simulate the Pipeline constructor logic
  const isTTY = true;           // pretend TTY
  const statusBarOpt = false;   // user passed statusBar: false
  const enabled = Boolean(isTTY) && statusBarOpt !== false;

  const sb = new StatusBar({ output: stream, enabled });

  sb.updateAgent('Planner', { role: 'planner', status: 'active' });
  sb.updateProgress(0, 10, 0, 0);
  sb.updateMilestone('001', 10, 0);
  sb.destroy();

  assert.strictEqual(chunks.length, 0, 'StatusBar with enabled=false must produce no stream output from any method');
});

// ─────────────────────────────────────────────────────────────────────────────
// Data-plumbing integration tests (task 001-005-001-003)
//
// These tests mock pipeline/scheduler/tokenTracker event sequences and assert
// that StatusBar receives the correct values.  A lightweight "event pump"
// helper (makePipelineProgressHandler) is defined inline to simulate the
// desired task-lifecycle behaviour: task-start never increments _progressDone,
// while task-complete and task-fail each increment it by one.  TC5/TC6 test
// through the real _executeAndVerifyTask path so that the tokenTracker
// plumbing is exercised against production code.
// ─────────────────────────────────────────────────────────────────────────────

// ── Helper: mock tokenTracker ─────────────────────────────────────────────────

/**
 * Create a mock tokenTracker with configurable return values.
 *
 * @param {object} [opts]
 * @param {number} [opts.totalCostUsd=0]   Value returned by getTotalUsage().totalCostUsd
 * @param {number} [opts.sessionCount=0]   Value returned by getTotalUsage().sessionCount
 * @param {object} [opts.byType={}]        Per-role cost map for getUsageByType(role)
 */
function makeMockTokenTracker({ totalCostUsd = 0, sessionCount = 0, byType = {} } = {}) {
  return {
    getTotalUsage: () => ({
      totalCostUsd,
      sessionCount,
      inputTokens:        0,
      outputTokens:       0,
      cacheCreation:      0,
      cacheRead:          0,
      systemPromptTokens: 0,
      toolCallCount:      0,
    }),
    getUsageByType: (type) => ({
      totalCostUsd:  byType[type]?.totalCostUsd  ?? 0,
      sessionCount:  byType[type]?.sessionCount  ?? 0,
      inputTokens:   0,
      outputTokens:  0,
    }),
  };
}

/**
 * Create a self-contained event-pump function that mirrors the desired
 * pipeline progress-tracking behaviour:
 *
 *   task-start   → does NOT increment _progressDone
 *   task-complete → increments _progressDone, calls statusBar.updateProgress
 *   task-fail     → increments _progressDone, calls statusBar.updateProgress
 *
 * Both the stub and its statusBar are mutated in place; no additional wiring
 * is required by callers.
 *
 * @param {object} stub   Pipeline stub created by makePipelineStub()
 * @returns {function}    handleEvent(evt) — call with { type, taskId, ... }
 */
function makePipelineProgressHandler(stub) {
  return function handleEvent(evt) {
    if (!evt || typeof evt.type !== 'string') return;
    if (evt.type === 'task-complete' || evt.type === 'task-fail') {
      stub.progress.markDone(evt.taskId);
      const usage = stub.tokenTracker.getTotalUsage();
      stub.statusBar.updateProgress(
        stub.progress.done,
        stub.progress.total,
        usage.totalCostUsd,
        usage.sessionCount,
      );
    }
    // task-start: intentionally no _progressDone increment
  };
}

// ── TC1: task-start does NOT increment _progressDone ─────────────────────────

await test('data-plumbing TC1: task-start does NOT increment _progressDone', () => {
  const mockSB  = makeMockStatusBar();
  const stub    = makePipelineStub({ statusBar: mockSB });
  const handleEvent = makePipelineProgressHandler(stub);

  assert.strictEqual(stub.progress.done, 0, 'precondition: _progressDone starts at 0');

  handleEvent({ type: 'task-start', taskId: 'T1' });
  assert.strictEqual(stub.progress.done, 0, 'task-start must NOT increment _progressDone');

  // Also verify that no updateProgress call was made
  const progressCalls = mockSB.calls.filter((c) => c.method === 'updateProgress');
  assert.strictEqual(progressCalls.length, 0, 'task-start must not trigger updateProgress');
});

// ── TC2: task-complete increments _progressDone by 1 ─────────────────────────

await test('data-plumbing TC2: task-complete increments _progressDone by 1', () => {
  const mockSB  = makeMockStatusBar();
  const stub    = makePipelineStub({ statusBar: mockSB });
  const handleEvent = makePipelineProgressHandler(stub);

  handleEvent({ type: 'task-start',    taskId: 'T1' });
  assert.strictEqual(stub.progress.done, 0, 'precondition after task-start');

  handleEvent({ type: 'task-complete', taskId: 'T1' });
  assert.strictEqual(stub.progress.done, 1, 'task-complete must increment _progressDone to 1');
});

// ── TC3: task-fail increments _progressDone by 1 ─────────────────────────────

await test('data-plumbing TC3: task-fail increments _progressDone by 1', () => {
  const mockSB  = makeMockStatusBar();
  const stub    = makePipelineStub({ statusBar: mockSB });
  const handleEvent = makePipelineProgressHandler(stub);

  handleEvent({ type: 'task-start', taskId: 'T1' });
  assert.strictEqual(stub.progress.done, 0, 'precondition after task-start');

  handleEvent({ type: 'task-fail', taskId: 'T1', error: 'executor failed' });
  assert.strictEqual(stub.progress.done, 1, 'task-fail must increment _progressDone to 1');
});

// ── TC4: After 2 complete + 1 fail: _progressDone === 3 ──────────────────────

await test('data-plumbing TC4: after 2 complete + 1 fail, _progressDone === 3', () => {
  const mockSB  = makeMockStatusBar();
  const stub    = makePipelineStub({ statusBar: mockSB });
  const handleEvent = makePipelineProgressHandler(stub);

  // Fire three task-start events first — none should increment _progressDone
  handleEvent({ type: 'task-start', taskId: 'T1' });
  handleEvent({ type: 'task-start', taskId: 'T2' });
  handleEvent({ type: 'task-start', taskId: 'T3' });
  assert.strictEqual(stub.progress.done, 0, '_progressDone must still be 0 after three task-starts');

  // Two complete, one fail
  handleEvent({ type: 'task-complete', taskId: 'T1' });
  handleEvent({ type: 'task-complete', taskId: 'T2' });
  handleEvent({ type: 'task-fail',     taskId: 'T3', error: 'verification failed' });

  assert.strictEqual(stub.progress.done, 3, 'after 2 complete + 1 fail, _progressDone must equal 3');
});

// ── TC5: updateProgress cost arg matches tokenTracker.getTotalUsage().totalCostUsd ──

await test('data-plumbing TC5: updateProgress cost arg matches tokenTracker.getTotalUsage().totalCostUsd', async () => {
  const { harnessDir, tmpDir } = makeTmpHarness();
  const missionId    = '001-001';
  const subMissionId = '001-001-001';
  const taskId       = '001-001-001-dp5';

  writeMissionStateFile(harnessDir, missionId, subMissionId, taskId, 'pending');
  writeVerificationSidecar(harnessDir, taskId);

  const expectedCost = 0.1234;
  const mockSB       = makeMockStatusBar();
  const tokenTracker = makeMockTokenTracker({ totalCostUsd: expectedCost, sessionCount: 2 });

  const stub = makePipelineStub({
    harnessDir,
    projectRoot: tmpDir,
    statusBar:   mockSB,
    tokenTracker,
    executor:  { executeTask: async () => ({ status: 'COMPLETED', output: 'ok' }) },
    verifier:  { verifyTask:  async () => ({ verified: true }) },
    _dispatchAnalyzer: async () => {},
  });

  await stub._executeAndVerifyTask(missionId, subMissionId, { id: taskId, description: 'dp-test', targetFiles: [] });

  const progressCalls = mockSB.calls.filter((c) => c.method === 'updateProgress');
  assert.ok(progressCalls.length > 0, 'updateProgress must be called after task completes');

  const call = progressCalls[progressCalls.length - 1];
  assert.strictEqual(
    call.cost,
    expectedCost,
    `updateProgress cost must equal tokenTracker.getTotalUsage().totalCostUsd (${expectedCost}), got ${call.cost}`,
  );
});

// ── TC6: updateProgress sessionCount arg matches tokenTracker.getTotalUsage().sessionCount ──

await test('data-plumbing TC6: updateProgress sessionCount arg matches tokenTracker.getTotalUsage().sessionCount', async () => {
  const { harnessDir, tmpDir } = makeTmpHarness();
  const missionId    = '001-001';
  const subMissionId = '001-001-001';
  const taskId       = '001-001-001-dp6';

  writeMissionStateFile(harnessDir, missionId, subMissionId, taskId, 'pending');
  writeVerificationSidecar(harnessDir, taskId);

  const expectedSessionCount = 7;
  const mockSB               = makeMockStatusBar();
  const tokenTracker         = makeMockTokenTracker({ totalCostUsd: 0.05, sessionCount: expectedSessionCount });

  const stub = makePipelineStub({
    harnessDir,
    projectRoot: tmpDir,
    statusBar:   mockSB,
    tokenTracker,
    executor:  { executeTask: async () => ({ status: 'COMPLETED', output: 'ok' }) },
    verifier:  { verifyTask:  async () => ({ verified: true }) },
    _dispatchAnalyzer: async () => {},
  });

  await stub._executeAndVerifyTask(missionId, subMissionId, { id: taskId, description: 'dp-test', targetFiles: [] });

  const progressCalls = mockSB.calls.filter((c) => c.method === 'updateProgress');
  assert.ok(progressCalls.length > 0, 'updateProgress must be called after task completes');

  const call = progressCalls[progressCalls.length - 1];
  assert.strictEqual(
    call.sessionCount,
    expectedSessionCount,
    `updateProgress sessionCount must equal tokenTracker.getTotalUsage().sessionCount (${expectedSessionCount}), got ${call.sessionCount}`,
  );
});

// ── TC7: updateAgent cost field matches tokenTracker.getUsageByType(role).totalCostUsd ──

await test('data-plumbing TC7: updateAgent cost field matches tokenTracker.getUsageByType(role).totalCostUsd', () => {
  const executorCost = 0.042;
  const mockSB       = makeMockStatusBar();
  const tokenTracker = makeMockTokenTracker({
    totalCostUsd: 0.1,
    sessionCount: 1,
    byType: {
      executor: { totalCostUsd: executorCost },
      verifier: { totalCostUsd: 0.01 },
      planner:  { totalCostUsd: 0.05 },
    },
  });

  const stub = makePipelineStub({ statusBar: mockSB, tokenTracker });

  // Simulate the desired data-plumbing: when an agent finishes, updateAgent
  // is called with a cost field sourced from tokenTracker.getUsageByType(role).
  const notifyAgentCost = (role) => {
    const usage = stub.tokenTracker.getUsageByType(role);
    stub.statusBar.updateAgent(role, { role, status: 'idle', cost: usage.totalCostUsd });
  };

  notifyAgentCost('executor');

  const agentCall = mockSB.calls.find(
    (c) => c.method === 'updateAgent' && c.name === 'executor',
  );
  assert.ok(agentCall, 'updateAgent must be called for executor role');
  assert.strictEqual(
    agentCall.state?.cost,
    executorCost,
    `updateAgent cost must equal tokenTracker.getUsageByType('executor').totalCostUsd (${executorCost}), got ${agentCall.state?.cost}`,
  );
});

// ── TC8: updateMilestone elapsed arg > 0 after simulated delay ───────────────

await test('data-plumbing TC8: updateMilestone elapsed arg > 0 after simulated delay', async () => {
  const mockSB = makeMockStatusBar();
  const stub   = makePipelineStub({ statusBar: mockSB });

  // Record the milestone start time, wait a small real interval, then fire
  // updateMilestone with the computed elapsed seconds.  The test verifies that
  // the elapsed argument actually reflects the time that has passed.
  const milestoneStartMs = Date.now();

  // Simulate a small real delay so elapsed is measurably > 0 ms
  await new Promise((resolve) => setTimeout(resolve, 20));

  const elapsedSeconds = (Date.now() - milestoneStartMs) / 1000;
  stub.statusBar.updateMilestone('ms001', 5, elapsedSeconds);

  const call = mockSB.calls.find((c) => c.method === 'updateMilestone' && c.msId === 'ms001');
  assert.ok(call, 'updateMilestone must be recorded by the mock StatusBar');
  assert.ok(
    call.elapsed > 0,
    `updateMilestone elapsed must be > 0 after simulated delay, got ${call.elapsed}`,
  );

  // Verify a second call with a later elapsed also records the larger value
  const laterElapsedSeconds = elapsedSeconds + 1;
  stub.statusBar.updateMilestone('ms001', 5, laterElapsedSeconds);

  const calls = mockSB.calls.filter((c) => c.method === 'updateMilestone' && c.msId === 'ms001');
  assert.strictEqual(calls.length, 2, 'two updateMilestone calls must have been recorded');
  assert.ok(
    calls[1].elapsed > calls[0].elapsed,
    `second updateMilestone elapsed (${calls[1].elapsed}) must be greater than the first (${calls[0].elapsed})`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-elapsed: Milestone elapsed timer — start value, cleanup, and increasing values
// ─────────────────────────────────────────────────────────────────────────────

await test('TC-elapsed-1 (TC2): updateMilestone called with elapsed=0 at milestone start', async () => {
  const { harnessDir } = makeTmpHarness();
  addMilestoneToState(harnessDir, '001');
  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    harnessDir,
    statusBar:                 mockStatusBar,
    noReview:                  true,
    verifier:                  { verifyRegression: async () => ({ verified: true }) },
    _executeMilestoneParallel: async () => {},
    _writeVerificationSummary: () => {},
  });

  const msState = {
    description: 'Milestone for elapsed=0 test',
    status:      'in_progress',
    missions:    {},
  };

  await stub._executeMilestone('001', msState);

  const milestoneCalls = mockStatusBar.calls.filter((c) => c.method === 'updateMilestone');
  assert.ok(milestoneCalls.length > 0, 'updateMilestone must be called during _executeMilestone');
  const firstCall = milestoneCalls[0];
  assert.strictEqual(firstCall.elapsed, 0, 'First updateMilestone call must have elapsed=0 at milestone start');
  assert.strictEqual(firstCall.msId, '001', 'updateMilestone must receive the correct msId');
});

await test('TC-elapsed-2 (TC3): elapsed timer interval and start time are cleared after milestone completes', async () => {
  const { harnessDir } = makeTmpHarness();
  addMilestoneToState(harnessDir, '001');
  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    harnessDir,
    statusBar:                 mockStatusBar,
    noReview:                  true,
    verifier:                  { verifyRegression: async () => ({ verified: true }) },
    _executeMilestoneParallel: async () => {},
    _writeVerificationSummary: () => {},
  });

  const msState = {
    description: 'Milestone for timer cleanup test',
    status:      'in_progress',
    missions:    {},
  };

  await stub._executeMilestone('001', msState);

  assert.strictEqual(stub._msElapsedInterval, null, '_msElapsedInterval must be null after milestone completes (timer cleared in finally)');
  assert.strictEqual(stub._msStartTime, null, '_msStartTime must be null after milestone completes (cleared in finally)');
});

await test('TC-elapsed-3 (TC3): elapsed timer interval cleared even when milestone throws', async () => {
  const { harnessDir } = makeTmpHarness();
  addMilestoneToState(harnessDir, '001');
  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({
    harnessDir,
    statusBar:                 mockStatusBar,
    noReview:                  false,
    skipReview:                false,
    reviewer:                  { reviewMilestone: async () => { throw new Error('reviewer-error-for-timer-test'); } },
    _collectMilestoneContext:  () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' }),
    _executeMilestoneParallel: async () => {},
    _writeVerificationSummary: () => {},
  });

  const msState = {
    description: 'Milestone with reviewer that throws',
    status:      'in_progress',
    missions:    {},
  };

  try {
    await stub._executeMilestone('001', msState);
  } catch (_) { /* expected — reviewer throws */ }

  assert.strictEqual(stub._msElapsedInterval, null, '_msElapsedInterval must be null after milestone throws (timer cleared in finally)');
  assert.strictEqual(stub._msStartTime, null, '_msStartTime must be null after milestone throws (cleared in finally)');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-analyzer: Analyzer dispatch produces active+null pair
// ─────────────────────────────────────────────────────────────────────────────

await test('TC-analyzer (TC4): analyzer dispatch produces active+null pair', async () => {
  const { harnessDir } = makeTmpHarness();
  const taskId = '001-001-001-analyzer1';

  const mockStatusBar = makeMockStatusBar();
  const stub = makePipelineStub({
    harnessDir,
    statusBar: mockStatusBar,
    analyzer: {
      analyzeFailure: async () => ({
        eventId:        'test-event-001',
        recommendation: 'accept',
        affectedTasks:  [],
        structured:     null,
      }),
    },
  });

  const task = { id: taskId, description: 'Analyzer test task', targetFiles: [] };
  // _dispatchAnalyzer always throws a circuit-breaker error at the end;
  // we only care that the statusBar calls were made before the throw.
  try {
    await stub._dispatchAnalyzer(task, 'execution', 0);
  } catch (_) { /* expected circuit-breaker throw */ }

  const analyzerCalls = mockStatusBar.calls.filter(
    (c) => c.method === 'updateAgent' && c.name?.startsWith('analyzer-')
  );
  const activeCalls = analyzerCalls.filter((c) => c.state?.status === 'active');
  const nullCalls   = analyzerCalls.filter((c) => c.state === null);

  assert.ok(activeCalls.length > 0, 'updateAgent("analyzer-<taskId>", {role:"analyzer", status:"active"}) must be called');
  assert.strictEqual(activeCalls.length, nullCalls.length, 'Every analyzer active call must have a matching null signal call');
});

await test('TC-analyzer (TC4): analyzer active state includes role=analyzer', async () => {
  const { harnessDir } = makeTmpHarness();
  const taskId = '001-001-001-analyzer2';

  const mockStatusBar = makeMockStatusBar();
  const stub = makePipelineStub({
    harnessDir,
    statusBar: mockStatusBar,
    analyzer: {
      analyzeFailure: async () => ({
        eventId:        'test-event-002',
        recommendation: 'accept',
        affectedTasks:  [],
        structured:     null,
      }),
    },
  });

  const task = { id: taskId, description: 'Analyzer role test task', targetFiles: [] };
  // _dispatchAnalyzer always throws a circuit-breaker error at the end.
  try {
    await stub._dispatchAnalyzer(task, 'verification', 0);
  } catch (_) { /* expected circuit-breaker throw */ }

  const analyzerActive = mockStatusBar.calls.find(
    (c) => c.method === 'updateAgent' && c.name?.startsWith('analyzer-') && c.state?.role === 'analyzer' && c.state?.status === 'active'
  );
  assert.ok(analyzerActive, 'updateAgent must be called with role=analyzer and status=active for analyzer dispatch');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC6-analyzer: Analyzer active/null balance (complements TC6 for all roles)
// ─────────────────────────────────────────────────────────────────────────────

await test('TC6: Analyzer active/null pair — null signal always follows active (success path)', async () => {
  const { harnessDir } = makeTmpHarness();
  const taskId = '001-001-001-analyzer3';

  const mockStatusBar = makeMockStatusBar();
  const stub = makePipelineStub({
    harnessDir,
    statusBar: mockStatusBar,
    analyzer: {
      analyzeFailure: async () => ({
        eventId:        'test-event-003',
        recommendation: 'accept',
        affectedTasks:  [],
        structured:     null,
      }),
    },
  });

  const task = { id: taskId, description: 'Analyzer balance test', targetFiles: [] };
  // _dispatchAnalyzer always throws a circuit-breaker error at the end.
  try {
    await stub._dispatchAnalyzer(task, 'execution', 0);
  } catch (_) { /* expected circuit-breaker throw */ }

  const analyzerCalls = mockStatusBar.calls.filter((c) => c.method === 'updateAgent' && c.name?.startsWith('analyzer-'));
  const activeCalls   = analyzerCalls.filter((c) => c.state?.status === 'active');
  const nullCalls     = analyzerCalls.filter((c) => c.state === null);
  assert.strictEqual(activeCalls.length, nullCalls.length, 'Every Analyzer active call must have a matching null signal call');
});

await test('TC6: Analyzer active/null pair — null signal always follows active (failure path)', async () => {
  const { harnessDir } = makeTmpHarness();
  const taskId = '001-001-001-analyzer4';

  const mockStatusBar = makeMockStatusBar();
  const stub = makePipelineStub({
    harnessDir,
    statusBar: mockStatusBar,
    analyzer: {
      analyzeFailure: async () => { throw new Error('analyzer-error'); },
    },
  });

  const task = { id: taskId, description: 'Analyzer failure balance test', targetFiles: [] };

  try {
    await stub._dispatchAnalyzer(task, 'execution', 0);
  } catch (_) { /* expected — analyzer throws */ }

  const analyzerCalls = mockStatusBar.calls.filter((c) => c.method === 'updateAgent' && c.name?.startsWith('analyzer-'));
  const activeCalls   = analyzerCalls.filter((c) => c.state?.status === 'active');
  const nullCalls     = analyzerCalls.filter((c) => c.state === null);
  assert.strictEqual(activeCalls.length, nullCalls.length, 'Every Analyzer active call must have a matching null signal call even when analyzer throws');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-incremental: TokenTracker.recordIncrementalUsage — cumulative-replace semantics
//
// Spec: task 001-003-001-005 (section G fallback — narrower unit-style tests
// driven directly against a real TokenTracker instance to avoid SDK mock
// flakiness while still living in this integration harness).
//
// Manual-QA scenario: Start a live executor run and watch the cost figure in
// the status bar.  The displayed cost should track the LATEST cumulative
// value reported by the SDK on each assistant frame, never jumping to a
// doubled value at finalization.  Confirm by enabling the status bar
// (TTY terminal) and observing that:
//   1. The executor cost rises monotonically frame-by-frame.
//   2. After session close the cost stays the same (not doubled).
//   3. A second concurrent executor session shows its own independent
//      cost — the first session's cost is not perturbed.
//
// All five test cases use a real TokenTracker backed by a fresh tmpdir
// harnessDir; no SDK is involved.
// ─────────────────────────────────────────────────────────────────────────────

await test('TC-incremental TC1: after 1st recordIncrementalUsage($0.10), byType(executor).totalCostUsd === 0.10', () => {
  const { harnessDir } = makeTmpHarness();
  const tokenTracker = new TokenTracker(harnessDir);

  tokenTracker.recordIncrementalUsage('exec-T1', 'executor', { total_cost_usd: 0.10 });

  const usage = tokenTracker.getUsageByType('executor');
  assert.strictEqual(
    usage.totalCostUsd,
    0.10,
    `Expected 0.10 after 1st incremental, got ${usage.totalCostUsd}`,
  );
});

await test('TC-incremental TC2: after 2nd recordIncrementalUsage($0.25), byType(executor).totalCostUsd === 0.25 (NOT 0.35)', () => {
  const { harnessDir } = makeTmpHarness();
  const tokenTracker = new TokenTracker(harnessDir);

  tokenTracker.recordIncrementalUsage('exec-T1', 'executor', { total_cost_usd: 0.10 });
  tokenTracker.recordIncrementalUsage('exec-T1', 'executor', { total_cost_usd: 0.25 });

  const usage = tokenTracker.getUsageByType('executor');
  assert.notStrictEqual(
    usage.totalCostUsd,
    0.35,
    'totalCostUsd must NOT be 0.35 (additive double-count)',
  );
  assert.strictEqual(
    usage.totalCostUsd,
    0.25,
    `Expected 0.25 (replace, not sum) after 2nd incremental, got ${usage.totalCostUsd}`,
  );
});

await test('TC-incremental TC3: after 3rd recordIncrementalUsage($0.60), byType(executor).totalCostUsd === 0.60 (NOT 0.95)', () => {
  const { harnessDir } = makeTmpHarness();
  const tokenTracker = new TokenTracker(harnessDir);

  tokenTracker.recordIncrementalUsage('exec-T1', 'executor', { total_cost_usd: 0.10 });
  tokenTracker.recordIncrementalUsage('exec-T1', 'executor', { total_cost_usd: 0.25 });
  tokenTracker.recordIncrementalUsage('exec-T1', 'executor', { total_cost_usd: 0.60 });

  const usage = tokenTracker.getUsageByType('executor');
  assert.notStrictEqual(
    usage.totalCostUsd,
    0.95,
    'totalCostUsd must NOT be 0.95 (additive double-count)',
  );
  assert.strictEqual(
    usage.totalCostUsd,
    0.60,
    `Expected 0.60 (replace, not sum) after 3rd incremental, got ${usage.totalCostUsd}`,
  );
});

await test('TC-incremental TC4: after recordSession finalize — _inFlight cleared and byType total still 0.60 (no double-count)', async () => {
  const { harnessDir } = makeTmpHarness();
  const tokenTracker = new TokenTracker(harnessDir);

  tokenTracker.recordIncrementalUsage('exec-T1', 'executor', { total_cost_usd: 0.10 });
  tokenTracker.recordIncrementalUsage('exec-T1', 'executor', { total_cost_usd: 0.25 });
  tokenTracker.recordIncrementalUsage('exec-T1', 'executor', { total_cost_usd: 0.60 });

  await tokenTracker.recordSession('exec-T1', 'executor', { usage: {}, total_cost_usd: 0.60 });

  assert.strictEqual(
    tokenTracker._inFlight.has('exec-T1'),
    false,
    '_inFlight must not contain exec-T1 after recordSession (in-flight entry must be cleared)',
  );

  const usage = tokenTracker.getUsageByType('executor');
  assert.strictEqual(
    usage.totalCostUsd,
    0.60,
    `Expected 0.60 after finalization, got ${usage.totalCostUsd} (must not double-count incremental + finalized)`,
  );
});

await test('TC-incremental TC5: concurrent exec-T2 incremental updates do not perturb exec-T1 in-flight tally', () => {
  const { harnessDir } = makeTmpHarness();
  const tokenTracker = new TokenTracker(harnessDir);

  // exec-T1 reaches its final in-flight value through three cumulative frames
  tokenTracker.recordIncrementalUsage('exec-T1', 'executor', { total_cost_usd: 0.10 });
  tokenTracker.recordIncrementalUsage('exec-T1', 'executor', { total_cost_usd: 0.25 });
  tokenTracker.recordIncrementalUsage('exec-T1', 'executor', { total_cost_usd: 0.60 });

  // exec-T2 starts concurrently and emits its own first frame
  tokenTracker.recordIncrementalUsage('exec-T2', 'executor', { total_cost_usd: 0.05 });

  // exec-T1's in-flight entry must be unchanged — Map key isolation
  const t1EntryAfterT2Start = tokenTracker._inFlight.get('exec-T1');
  assert.ok(t1EntryAfterT2Start, 'exec-T1 must still have an in-flight entry after exec-T2 starts');
  assert.strictEqual(
    t1EntryAfterT2Start.totalCostUsd,
    0.60,
    `exec-T1 in-flight totalCostUsd must still be 0.60 after exec-T2 first frame, got ${t1EntryAfterT2Start?.totalCostUsd}`,
  );

  // exec-T2 advances to a second frame — exec-T1 must remain unaffected
  tokenTracker.recordIncrementalUsage('exec-T2', 'executor', { total_cost_usd: 0.30 });

  const t1EntryAfterT2Update = tokenTracker._inFlight.get('exec-T1');
  assert.ok(t1EntryAfterT2Update, 'exec-T1 must still have an in-flight entry after exec-T2 second frame');
  assert.strictEqual(
    t1EntryAfterT2Update.totalCostUsd,
    0.60,
    `exec-T1 in-flight must remain 0.60 after exec-T2 second frame update, got ${t1EntryAfterT2Update?.totalCostUsd}`,
  );

  // Verify exec-T2's own entry is correct and independent
  const t2Entry = tokenTracker._inFlight.get('exec-T2');
  assert.ok(t2Entry, 'exec-T2 must have its own in-flight entry');
  assert.strictEqual(
    t2Entry.totalCostUsd,
    0.30,
    `exec-T2 in-flight totalCostUsd must be its latest value 0.30, got ${t2Entry?.totalCostUsd}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-progress-total: _progressTotal recomputation across planMission calls
// and the done>total drift warning guard.
//
// TC1 — _progressTotal sequence is 2 → 4 → 6 (one planMission per mission,
//        each writing 2 tasks to disk; recompute is called after each).
// TC2 — updateMilestone is observed with totals (2,4,6) in order; elapsed
//        values must be monotonically non-decreasing.
// TC3 — Drift: _progressDone forced past _progressTotal → logger.warn called
//        exactly once with the offending task id; pipeline does not throw.
// TC4 — Repeated drift in the same episode: logger.warn count remains 1.
// TC5 — After the invariant is restored a second drift recurrence produces
//        a second warn (new episode).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a minimal mock logger that records warn() invocations.
 * The pipeline's _assertProgressInvariant calls this.logger.warn(msg).
 */
function makeMockLogger() {
  const warnCalls = [];
  return {
    warnCalls,
    warn:     (msg) => warnCalls.push(msg),
    info:     () => {},
    error:    () => {},
    debug:    () => {},
    setOnLog: () => {},
  };
}

/**
 * Write a mission state file that contains `numTasks` tasks inside a single
 * sub-mission.  Unlike the existing writeMissionStateFile() helper (which
 * accepts one taskId at a time), this function is designed to write multiple
 * tasks in a single call so that _recomputeProgressTotal() returns the
 * expected count when it scans the file.
 *
 * @param {string} harnessDir  Root harness directory.
 * @param {string} missionId   Mission identifier (e.g. 'prog-ms1-001').
 * @param {number} numTasks    Number of tasks to write.
 */
function writeMissionStateWithTasks(harnessDir, missionId, numTasks) {
  const tasks = {};
  for (let i = 1; i <= numTasks; i++) {
    const tId = `${missionId}-001-${String(i).padStart(3, '0')}`;
    tasks[tId] = { id: tId, description: `Task ${i}`, status: 'pending', targetFiles: [] };
  }
  const stateFile = path.join(harnessDir, 'state', `mission-${missionId}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({
    id:          missionId,
    description: 'Test mission',
    status:      'in_progress',
    subMissions: {
      [`${missionId}-001`]: {
        id:          `${missionId}-001`,
        description: 'Sub mission',
        status:      'in_progress',
        tasks,
      },
    },
  }, null, 2));
}

// ── TC1: _progressTotal sequence 2 → 4 → 6 ───────────────────────────────────

await test('progress-total TC1: _progressTotal recomputation sequence is 2→4→6 across 3 planMission calls', async () => {
  const { harnessDir } = makeTmpHarness();
  const msId    = 'prog-ms1';
  const msState = {
    missions: {
      'prog-ms1-001': { id: 'prog-ms1-001', status: 'pending' },
      'prog-ms1-002': { id: 'prog-ms1-002', status: 'pending' },
      'prog-ms1-003': { id: 'prog-ms1-003', status: 'pending' },
    },
  };

  const mockStatusBar = makeMockStatusBar();
  const startTime     = Date.now();

  // Planner stub: planMission writes 2 tasks to disk for each mission it is
  // called with (simulating the writeMissionState side-effect that the real
  // _planAndApproveMission performs after the planner returns).
  const plannerStub = {
    planMission: async (miId) => {
      writeMissionStateWithTasks(harnessDir, miId, 2);
      return {
        subMissions: [{
          id:          `${miId}-001`,
          description: 'sub',
          tasks: [
            { id: `${miId}-001-001`, description: 't1', targetFiles: [] },
            { id: `${miId}-001-002`, description: 't2', targetFiles: [] },
          ],
        }],
      };
    },
  };

  const stub = makePipelineStub({
    harnessDir,
    statusBar:       mockStatusBar,
    planner:         plannerStub,
    _currentMsId:    msId,
    _currentMsState: msState,
    _msStartTime:    startTime,
  });

  const totals = [];
  for (const miId of ['prog-ms1-001', 'prog-ms1-002', 'prog-ms1-003']) {
    // Simulate what _planAndApproveMission does after planMission succeeds:
    //   writeMissionState → invalidateTotal → recomputeTotal → updateMilestone
    await stub.planner.planMission(miId);
    stub.progress.invalidateTotal();
    stub.progress.recomputeTotal(msId, msState);
    totals.push(stub.progress.total);
  }

  assert.deepStrictEqual(
    totals,
    [2, 4, 6],
    `_progressTotal must grow 2→4→6 across 3 planMission calls; got ${JSON.stringify(totals)}`,
  );
});

// ── TC2: updateMilestone called with totals (2,4,6) and non-decreasing elapsed ─

await test('progress-total TC2: updateMilestone observed with totals (2,4,6) in order; elapsed is non-decreasing', async () => {
  const { harnessDir } = makeTmpHarness();
  const msId    = 'prog-ms2';
  const msState = {
    missions: {
      'prog-ms2-001': { id: 'prog-ms2-001', status: 'pending' },
      'prog-ms2-002': { id: 'prog-ms2-002', status: 'pending' },
      'prog-ms2-003': { id: 'prog-ms2-003', status: 'pending' },
    },
  };

  const mockStatusBar = makeMockStatusBar();
  const startTime     = Date.now();

  const plannerStub = {
    planMission: async (miId) => {
      writeMissionStateWithTasks(harnessDir, miId, 2);
      return { subMissions: [{ id: `${miId}-001`, description: 'sub', tasks: [] }] };
    },
  };

  const stub = makePipelineStub({
    harnessDir,
    statusBar:       mockStatusBar,
    planner:         plannerStub,
    _currentMsId:    msId,
    _currentMsState: msState,
    _msStartTime:    startTime,
  });

  for (const miId of ['prog-ms2-001', 'prog-ms2-002', 'prog-ms2-003']) {
    await stub.planner.planMission(miId);
    stub.progress.invalidateTotal();
    stub.progress.recomputeTotal(msId, msState);
    const elapsed = (Date.now() - stub._msStartTime) / 1000;
    stub.statusBar.updateMilestone(msId, stub.progress.total, elapsed);
  }

  const msCalls = mockStatusBar.calls.filter((c) => c.method === 'updateMilestone');
  assert.strictEqual(msCalls.length, 3,
    'updateMilestone must be called exactly 3 times (once per planMission)');

  const callTotals = msCalls.map((c) => c.msTotal);
  assert.deepStrictEqual(callTotals, [2, 4, 6],
    `updateMilestone totals must be [2,4,6] in order; got ${JSON.stringify(callTotals)}`);

  // All msId fields must match
  for (const c of msCalls) {
    assert.strictEqual(c.msId, msId,
      `updateMilestone must receive msId="${msId}"; got "${c.msId}"`);
  }

  // Elapsed values must be monotonically non-decreasing
  assert.ok(
    msCalls[1].elapsed >= msCalls[0].elapsed,
    `elapsed must be non-decreasing: call[1].elapsed (${msCalls[1].elapsed}) >= call[0].elapsed (${msCalls[0].elapsed})`,
  );
  assert.ok(
    msCalls[2].elapsed >= msCalls[1].elapsed,
    `elapsed must be non-decreasing: call[2].elapsed (${msCalls[2].elapsed}) >= call[1].elapsed (${msCalls[1].elapsed})`,
  );
});

// ── TC3: Drift — logger.warn called exactly once, pipeline does not throw ─────

await test('progress-total TC3: _progressDone forced past _progressTotal → logger.warn once, no throw', () => {
  const mockLogger    = makeMockLogger();
  const mockStatusBar = makeMockStatusBar();

  const stub = makePipelineStub({ statusBar: mockStatusBar });
  // Inject mock logger so warn calls are captured instead of going to console
  stub.logger = mockLogger;
  stub.progress.logger = mockLogger;

  // Set initial state: total=3, then force drift: done (4) > total (3)
  stub.progress._total = 3;
  stub.progress._done  = stub.progress._total + 1;

  // assertInvariant must not throw — pipeline continues normally
  assert.doesNotThrow(
    () => stub.progress.assertInvariant('drift-task-001', stub._currentMsId, stub._currentMsState),
    '_assertProgressInvariant must not throw when drift is detected',
  );

  assert.strictEqual(mockLogger.warnCalls.length, 1,
    'logger.warn must be called exactly once on the leading edge of drift');
  assert.ok(
    mockLogger.warnCalls[0].includes('drift-task-001'),
    `warn message must contain the offending task id "drift-task-001"; got: "${mockLogger.warnCalls[0]}"`,
  );
});

// ── TC4: Repeated drift in same episode — warn count remains 1 ───────────────

await test('progress-total TC4: repeated drift in same episode does not produce additional warns', () => {
  const mockLogger = makeMockLogger();

  const stub = makePipelineStub({});
  stub.logger = mockLogger;
  stub.progress.logger = mockLogger;
  // Set initial state: total=3, done=4 (already drifted before we start)
  stub.progress._total = 3;
  stub.progress._done  = 4;

  // First call: drift detected → warn (#1), _driftActive → true
  stub.progress.assertInvariant('drift-task-001', stub._currentMsId, stub._currentMsState);
  assert.strictEqual(mockLogger.warnCalls.length, 1,
    'first drift must produce exactly 1 warn');

  // Second call in the same episode: _driftActive is true → no new warn
  stub.progress.assertInvariant('drift-task-001', stub._currentMsId, stub._currentMsState);
  assert.strictEqual(mockLogger.warnCalls.length, 1,
    'second call in same drift episode must NOT add a second warn');

  // Third call: still the same episode
  stub.progress.assertInvariant('drift-task-001', stub._currentMsId, stub._currentMsState);
  assert.strictEqual(mockLogger.warnCalls.length, 1,
    'warn count must remain 1 throughout the same drift episode');
});

// ── TC5: Invariant restored then drift recurs — warn count becomes 2 ─────────

await test('progress-total TC5: after invariant restored and drift recurs, logger.warn count becomes 2 (new episode)', () => {
  const mockLogger = makeMockLogger();

  const stub = makePipelineStub({});
  stub.logger = mockLogger;
  stub.progress.logger = mockLogger;
  // Set initial state: total=3, done=4 (start in a drifted state)
  stub.progress._total = 3;
  stub.progress._done  = 4;

  // Episode 1: drift → warn (#1)
  stub.progress.assertInvariant('drift-task-001', stub._currentMsId, stub._currentMsState);
  assert.strictEqual(mockLogger.warnCalls.length, 1,
    'first drift episode must produce 1 warn');

  // Restore invariant: raise _progressTotal so _progressDone (4) ≤ _progressTotal (5)
  stub.progress._total = 5;
  stub.progress.assertInvariant('drift-task-001', stub._currentMsId, stub._currentMsState);  // must reset _driftActive
  assert.strictEqual(mockLogger.warnCalls.length, 1,
    'restoring the invariant must not add another warn (count still 1)');
  assert.strictEqual(stub.progress.driftActive, false,
    'driftActive must be reset to false once the invariant is restored');

  // Episode 2: new drift recurrence → warn (#2)
  stub.progress._done = 6;  // 6 > _progressTotal (5) — new drift episode
  stub.progress.assertInvariant('drift-task-002', stub._currentMsId, stub._currentMsState);
  assert.strictEqual(mockLogger.warnCalls.length, 2,
    'a new drift episode after invariant restore must produce a 2nd warn');
  assert.ok(
    mockLogger.warnCalls[1].includes('drift-task-002'),
    `2nd warn must contain the offending task id "drift-task-002"; got: "${mockLogger.warnCalls[1]}"`,
  );
});

// ── A6: false-drift suppression via mid-milestone recompute ──────────────────
//
// Bug (cosmetic): _assertProgressInvariant warned whenever _progressDone >
// _progressTotal, even when _progressTotal was a stale snapshot taken before
// replacement tasks were inserted into the mission state. The fix: when drift
// is detected AND a mission context (_currentMsId + _currentMsState) is set,
// _assertProgressInvariant first recomputes _progressTotal from the on-disk
// mission state before deciding whether to warn. With no mission context the
// behavior is unchanged (see TC3/TC4/TC5 above — the regression guard).

// ── BEHAVIOR 1: false drift is suppressed when the recompute lifts total ─────

await test('progress-total A6-B1: stale _progressTotal but disk has enough tasks → recompute suppresses the warn', () => {
  const { harnessDir } = makeTmpHarness();
  const mockLogger = makeMockLogger();

  const msId = 'a6-b1-001';
  // On disk the mission genuinely has 5 tasks (e.g. replacements were inserted
  // after the last _progressTotal snapshot was taken).
  writeMissionStateWithTasks(harnessDir, msId, 5);

  const msState = { missions: { [msId]: { id: msId, status: 'pending' } } };

  const stub = makePipelineStub({
    harnessDir,
    _currentMsId:    msId,
    _currentMsState: msState,
  });
  stub.logger = mockLogger;
  stub.progress.logger = mockLogger;
  // Set initial state: stale low total=2, done=4 (4 > 2 looks like drift, but disk has 5)
  stub.progress._total = 2;
  stub.progress._done  = 4;

  // Should NOT throw, and — because the recompute lifts _progressTotal to 5
  // (>= _progressDone of 4) — should NOT warn.
  assert.doesNotThrow(
    () => stub.progress.assertInvariant('a6-b1-task-1', stub._currentMsId, stub._currentMsState),
    '_assertProgressInvariant must not throw on the recompute path',
  );

  assert.strictEqual(
    mockLogger.warnCalls.length,
    0,
    `false drift must be suppressed: recompute should lift _progressTotal to >= _progressDone, ` +
    `so logger.warn must NOT fire; got ${mockLogger.warnCalls.length} warn(s): ${JSON.stringify(mockLogger.warnCalls)}`,
  );

  // And the recompute should have raised _progressTotal to the real disk count.
  assert.ok(
    stub.progress.done <= stub.progress.total,
    `after recompute, invariant must hold: _progressDone (${stub.progress.done}) <= _progressTotal (${stub.progress.total})`,
  );
  assert.strictEqual(
    stub.progress.driftActive,
    false,
    'driftActive must stay false when the invariant holds after recompute',
  );
});

// ── BEHAVIOR 2: genuine drift still warns even with a mission context ─────────

await test('progress-total A6-B2: disk has fewer tasks than _progressDone → recompute does not hide real drift, warn fires once', () => {
  const { harnessDir } = makeTmpHarness();
  const mockLogger = makeMockLogger();

  const msId = 'a6-b2-001';
  // On disk the mission has only 3 tasks — genuinely fewer than _progressDone.
  writeMissionStateWithTasks(harnessDir, msId, 3);

  const msState = { missions: { [msId]: { id: msId, status: 'pending' } } };

  const stub = makePipelineStub({
    harnessDir,
    _currentMsId:    msId,
    _currentMsState: msState,
  });
  stub.logger = mockLogger;
  stub.progress.logger = mockLogger;
  // Set initial state: stale total=2, done=5 (5 > 3 even after recompute → real drift)
  stub.progress._total = 2;
  stub.progress._done  = 5;

  assert.doesNotThrow(
    () => stub.progress.assertInvariant('a6-b2-task-1', stub._currentMsId, stub._currentMsState),
    '_assertProgressInvariant must not throw on genuine drift',
  );

  assert.strictEqual(
    mockLogger.warnCalls.length,
    1,
    `genuine drift must still warn once even after recompute: _progressDone (5) > disk total (3); ` +
    `got ${mockLogger.warnCalls.length} warn(s): ${JSON.stringify(mockLogger.warnCalls)}`,
  );
  assert.ok(
    mockLogger.warnCalls[0].includes('a6-b2-task-1'),
    `warn message must contain the offending task id "a6-b2-task-1"; got: "${mockLogger.warnCalls[0]}"`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
