#!/usr/bin/env node

/**
 * test-is-stub-propagation.js — Tests for isStub propagation through the
 * verifier → verifyMission → verifyMilestone → _missionRegression pipeline.
 *
 * TC1: extractVerdict with null sdkResult returns isStub: true
 * TC2: verifyMission propagates isStub: true from verifier result
 * TC3: verifyMilestone writes stub banner to disk report, returns isStub: true
 * TC4a: _missionRegression throws 'no structured_output' on first-call stub
 * TC4b: _missionRegression throws 'after remediation' on second-call stub
 * TC5: genuine FAILED (isStub:false) does not throw an isStub error
 *
 * Pattern: Object.create(Pipeline.prototype) + makePipelineStub() from
 * test-reviewer-guard-zero-findings.js. All dependencies are stubbed at the
 * instance level; no constructor is invoked.
 *
 * Run: node test/test-is-stub-propagation.js
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import assert from 'assert';

import { Pipeline }                        from '../src/orchestrator/core/pipeline.js';
import { ProgressTracker }                 from '../src/orchestrator/core/progress-tracker.js';
import { extractVerdict } from '../src/orchestrator/agents/verifier.js';
import { verifyMission, verifyMilestone }  from '../src/orchestrator/gates/regression.js';
import { assertNoStubVerifierSidecar } from '../src/orchestrator/core/state.js';

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
 * Defaults match the reviewer-guard pattern; override per-test as needed.
 */
function makePipelineStub(overrides = {}) {
  const stub = Object.create(Pipeline.prototype);

  stub.onLog     = () => {};
  stub.onConfirm = async () => true;

  stub.harnessDir   = '/fake-harness';
  stub.projectRoot  = '/fake-project';

  stub.progress = new ProgressTracker(stub.harnessDir, null);

  stub.noReview   = false;
  stub.skipReview = false;

  stub._mode              = undefined;
  stub._cachedImportGraph = '';

  stub.statusBar = makeMockStatusBar();

  stub.tokenTracker = {
    getTotalUsage:  () => ({ totalCostUsd: 0, sessionCount: 0 }),
    getUsageByType: () => ({ totalCostUsd: 0, sessionCount: 0 }),
  };

  stub._msElapsedInterval = null;
  stub._msStartTime       = null;

  stub._signalHandlers = {
    SIGINT:            () => {},
    SIGTERM:           () => {},
    exit:              () => {},
    uncaughtException: () => {},
  };

  stub._formatBanner              = (prefix, id, desc) => [`${prefix} ${id}: ${desc}`];
  stub._writeVerificationSummary  = () => {};
  stub._executeMilestoneParallel  = async () => {};

  Object.assign(stub, overrides);
  return stub;
}

/**
 * Creates a temporary harness directory tree with the subdirectories and
 * state.json that the regression functions read/write.
 */
function makeTmpHarness() {
  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-isp-'));
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
 * Writes a mission state file to harnessDir/state/mission-{missionId}.json.
 * Includes one completed task in sub-mission {missionId}-001.
 */
function writeMissionStateFile(harnessDir, missionId) {
  const subMissionId = `${missionId}-001`;
  const taskId       = `${subMissionId}-001`;
  const state = {
    id:          missionId,
    description: 'Test mission',
    status:      'in_progress',
    subMissions: {
      [subMissionId]: {
        id:          subMissionId,
        description: 'Test sub-mission',
        status:      'in_progress',
        tasks: {
          [taskId]: {
            id:               taskId,
            description:      'Test task',
            status:           'complete',
            targetFiles:      [],
            testCases:        [],
            tracesScenario:   [],
            patternReferences: [],
            dataSchemas:      [],
          },
        },
      },
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify(state, null, 2)
  );
  return { subMissionId, taskId };
}

/**
 * Writes a state.json with a milestone entry so verifyMilestone can find it.
 */
function writeMilestoneState(harnessDir, milestoneId, missionId) {
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify({
    projectMeta:  { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id:          milestoneId,
        description: 'Test milestone',
        status:      'in_progress',
        missions: {
          [missionId]: { id: missionId, description: 'Test mission', status: 'complete' },
        },
      },
    },
  }, null, 2));
}

const noopLog = () => {};

// ─────────────────────────────────────────────────────────────────────────────
// TC1: extractVerdict with null sdkResult returns isStub: true
// ─────────────────────────────────────────────────────────────────────────────

await test('TC1: extractVerdict(null) returns isStub: true', async () => {
  const { harnessDir } = makeTmpHarness();

  const result = extractVerdict(null, 'test-001', harnessDir, { warn: () => {} });

  assert.strictEqual(result.isStub, true,
    `TC1: expected isStub: true, got ${result.isStub}`);
  assert.strictEqual(result.verified, false,
    `TC1: expected verified: false, got ${result.verified}`);
  assert.ok(result.structured,
    'TC1: expected structured to be present');
  assert.ok(typeof result.report === 'string',
    'TC1: expected report to be a string');
  assert.ok(typeof result.reportPath === 'string',
    'TC1: expected reportPath to be a string');
});

// ─────────────────────────────────────────────────────────────────────────────
// TC2: verifyMission propagates isStub: true from verifier result
// ─────────────────────────────────────────────────────────────────────────────

await test('TC2: verifyMission propagates isStub: true from verifier result', async () => {
  const { harnessDir } = makeTmpHarness();
  const missionId = '001-001';
  writeMissionStateFile(harnessDir, missionId);

  const verifier = {
    verifyRegression: async () => ({ verified: false, isStub: true, report: 'stub report' }),
  };

  const result = await verifyMission({
    missionId,
    missionPlan: 'test plan',
    verifier,
    projectRoot: harnessDir,
    harnessDir,
    onLog: noopLog,
  });

  assert.strictEqual(result.isStub, true,
    `TC2: expected isStub: true in verifyMission return, got ${result.isStub}`);
  assert.strictEqual(result.passed, false,
    `TC2: expected passed: false, got ${result.passed}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC3: verifyMilestone writes stub banner to disk, returns isStub: true
// ─────────────────────────────────────────────────────────────────────────────

await test('TC3: verifyMilestone report file contains stub banner, return has isStub: true', async () => {
  const { harnessDir } = makeTmpHarness();
  const milestoneId = '001';
  const missionId   = '001-001';
  writeMilestoneState(harnessDir, milestoneId, missionId);

  const verifier = {
    verifyRegression: async () => ({ verified: false, isStub: true, report: 'stub report' }),
  };

  const result = await verifyMilestone({
    milestoneId,
    milestoneDesc: 'Test milestone',
    specPath:      null,
    verifier,
    projectRoot: harnessDir,
    harnessDir,
    onLog: noopLog,
  });

  assert.strictEqual(result.isStub, true,
    `TC3: expected isStub: true in verifyMilestone return, got ${result.isStub}`);

  // Report file on disk must contain the stub banner
  const reportPath = path.join(harnessDir, 'verification', `regression-milestone-${milestoneId}.md`);
  assert.ok(fs.existsSync(reportPath),
    `TC3: expected report file to exist at ${reportPath}`);
  const content = fs.readFileSync(reportPath, 'utf8');
  assert.ok(content.includes('⚠️ STUB VERDICT'),
    `TC3: expected report file to contain '⚠️ STUB VERDICT'. Got:\n${content.slice(0, 300)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC4a: _missionRegression throws 'no structured_output' on first-call stub
// ─────────────────────────────────────────────────────────────────────────────

await test('TC4a: _missionRegression throws "no structured_output" when first verifyMission is stub', async () => {
  const { harnessDir } = makeTmpHarness();
  const missionId = '001-001';
  writeMissionStateFile(harnessDir, missionId);

  const stub = makePipelineStub({
    harnessDir,
    projectRoot: harnessDir,
    verifier: {
      verifyRegression: async () => ({ verified: false, isStub: true, report: 'stub' }),
    },
    analyzer: {
      analyzeFailure: async () => ({ recommendation: 're_plan', eventId: 'ev1' }),
    },
    planner: {
      remediateScenarios: async () => ({ newTasks: [] }),
    },
  });

  let thrown = null;
  try {
    await stub._missionRegression(missionId, 'test mission plan');
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown,
    'TC4a: expected _missionRegression to throw');
  assert.ok(
    thrown.message.includes('no structured_output'),
    `TC4a: error message must contain 'no structured_output'. Got: ${thrown.message}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TC4b: _missionRegression throws 'after remediation' when second verifyMission is stub
// ─────────────────────────────────────────────────────────────────────────────

await test('TC4b: _missionRegression throws "after remediation" when second verifyMission is stub', async () => {
  const { harnessDir } = makeTmpHarness();
  const missionId = '001-001';
  const { subMissionId } = writeMissionStateFile(harnessDir, missionId);

  let verifyCallCount = 0;
  const stub = makePipelineStub({
    harnessDir,
    projectRoot: harnessDir,
    verifier: {
      verifyRegression: async () => {
        verifyCallCount++;
        if (verifyCallCount === 1) {
          // First call: not a stub, just failed
          return { verified: false, isStub: false, report: 'first failure' };
        }
        // Second call (re-verify after remediation): stub result
        return { verified: false, isStub: true, report: 'stub on recheck' };
      },
    },
    analyzer: {
      analyzeFailure: async () => ({ recommendation: 're_plan', eventId: 'ev1' }),
    },
    planner: {
      remediateScenarios: async () => ({
        newTasks: [{
          id:               `${subMissionId}-002`,
          subMissionId,
          description:      'Fix regression',
          targetFiles:      [],
          testCases:        [],
          tracesScenario:   [],
          patternReferences: [],
          dataSchemas:      [],
        }],
      }),
    },
    _executeAndVerifyTask: async () => {},
  });

  let thrown = null;
  try {
    await stub._missionRegression(missionId, 'test mission plan');
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown,
    'TC4b: expected _missionRegression to throw');
  assert.ok(
    thrown.message.toLowerCase().includes('after remediation'),
    `TC4b: error message must contain 'after remediation'. Got: ${thrown.message}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TC5: genuine FAILED (isStub:false) does not throw an isStub error
// ─────────────────────────────────────────────────────────────────────────────

await test('TC5: genuine FAILED (isStub:false) traverses remediation without isStub error', async () => {
  const { harnessDir } = makeTmpHarness();
  const missionId = '001-001';
  writeMissionStateFile(harnessDir, missionId);

  const stub = makePipelineStub({
    harnessDir,
    projectRoot: harnessDir,
    verifier: {
      // Always returns genuine FAILED, never isStub
      verifyRegression: async () => ({ verified: false, isStub: false, report: 'genuine failure' }),
    },
    analyzer: {
      analyzeFailure: async () => ({ recommendation: 're_plan', eventId: 'ev1' }),
    },
    planner: {
      // Empty newTasks → the remediation block is skipped → falls to
      // "regression failed after remediation attempt" throw
      remediateScenarios: async () => ({ newTasks: [] }),
    },
    _executeAndVerifyTask: async () => {},
  });

  let thrown = null;
  try {
    await stub._missionRegression(missionId, 'test mission plan');
  } catch (err) {
    thrown = err;
  }

  // The method WILL throw (regression failed), but it must NOT be an isStub error.
  if (thrown) {
    assert.ok(
      !thrown.message.includes('no structured_output'),
      `TC5: error must NOT contain 'no structured_output' (isStub guard). Got: ${thrown.message}`
    );
    assert.ok(
      !thrown.message.toLowerCase().includes('stub response'),
      `TC5: error must NOT contain 'stub response'. Got: ${thrown.message}`
    );
    // The normal remediation-failure error is expected and acceptable
    const msg = thrown.message.toLowerCase();
    assert.ok(
      msg.includes('regression failed') || msg.includes('remediation'),
      `TC5: if error was thrown it should be the remediation-failure error, not isStub. Got: ${thrown.message}`
    );
  }
  // If no error was thrown, the pipeline completed — also valid.
});

// ─────────────────────────────────────────────────────────────────────────────
// TC6: extractVerdict stub writes isStub:true to task sidecar on disk
// ─────────────────────────────────────────────────────────────────────────────

await test('TC6: extractVerdict stub writes isStub:true to task sidecar on disk', async () => {
  const { harnessDir } = makeTmpHarness();
  const taskId = 'tc6-task';

  extractVerdict({ someField: 'x' }, taskId, harnessDir, { warn: () => {} });

  const sidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);
  assert.ok(fs.existsSync(sidecarPath),
    `TC6: expected sidecar to exist at ${sidecarPath}`);
  const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  assert.strictEqual(parsed.isStub, true,
    `TC6: expected isStub: true in sidecar, got ${parsed.isStub}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC8: assertNoStubVerifierSidecar throws on stub sidecar
// ─────────────────────────────────────────────────────────────────────────────

await test('TC8: assertNoStubVerifierSidecar throws on stub sidecar', async () => {
  const { harnessDir } = makeTmpHarness();
  const taskId = 'tc8-task';
  const sidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);
  fs.writeFileSync(sidecarPath, JSON.stringify({ isStub: true, result: 'FAILED' }, null, 2));

  let thrown = null;
  try {
    assertNoStubVerifierSidecar(harnessDir, taskId);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown,
    'TC8: expected assertNoStubVerifierSidecar to throw');
  assert.ok(thrown.message.includes('tc8-task'),
    `TC8: expected error message to contain 'tc8-task'. Got: ${thrown.message}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC9: assertNoStubVerifierSidecar silent on non-stub sidecar
// ─────────────────────────────────────────────────────────────────────────────

await test('TC9: assertNoStubVerifierSidecar silent on non-stub sidecar', async () => {
  const { harnessDir } = makeTmpHarness();
  const taskId = 'tc9-task';
  const sidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);
  fs.writeFileSync(sidecarPath, JSON.stringify({ result: 'FAILED' }, null, 2));

  let thrown = null;
  try {
    const result = assertNoStubVerifierSidecar(harnessDir, taskId);
    assert.strictEqual(result, undefined,
      `TC9: expected undefined return, got ${result}`);
  } catch (err) {
    thrown = err;
  }

  assert.strictEqual(thrown, null,
    `TC9: expected no throw, but got: ${thrown && thrown.message}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC10: assertNoStubVerifierSidecar silent on missing sidecar
// ─────────────────────────────────────────────────────────────────────────────

await test('TC10: assertNoStubVerifierSidecar silent on missing sidecar', async () => {
  const { harnessDir } = makeTmpHarness();
  const taskId = 'tc10-task';

  let thrown = null;
  try {
    const result = assertNoStubVerifierSidecar(harnessDir, taskId);
    assert.strictEqual(result, undefined,
      `TC10: expected undefined return, got ${result}`);
  } catch (err) {
    thrown = err;
  }

  assert.strictEqual(thrown, null,
    `TC10: expected no throw on missing sidecar, but got: ${thrown && thrown.message}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC11: integration — stub sidecar blocks transitionTask('verified')
// ─────────────────────────────────────────────────────────────────────────────

await test('TC11: integration — stub sidecar blocks transitionTask verified', async () => {
  const { harnessDir } = makeTmpHarness();
  const missionId = '001-001';
  const { taskId } = writeMissionStateFile(harnessDir, missionId);

  // Write a stub sidecar for the task
  const sidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);
  fs.writeFileSync(sidecarPath, JSON.stringify({ isStub: true, result: 'FAILED' }, null, 2));

  // The guard should throw, confirming it would block before transitionTask('verified')
  let thrown = null;
  try {
    assertNoStubVerifierSidecar(harnessDir, taskId);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown,
    'TC11: expected assertNoStubVerifierSidecar to throw, blocking transitionTask("verified")');
  assert.ok(thrown.message.includes(taskId),
    `TC11: error message should reference taskId '${taskId}'. Got: ${thrown.message}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
