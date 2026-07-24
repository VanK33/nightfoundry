/**
 * test-verification-audit-gate.js — Phase-5 verification-audit gate wiring.
 *
 * Drives the REAL Pipeline._executeMilestone(msId, msState) against seeded
 * fixtures with the heavy steps stubbed to no-ops so control reaches the
 * Phase-5 verification audit (gates/audit.js → auditVerification). The audit
 * itself is NEVER stubbed.
 *
 * Behavior under test (the warn→throw change): _executeMilestone, after the
 * reviewer gate + milestone regression and BEFORE transitioning the milestone
 * to 'complete', runs auditVerification and THROWS VerificationAuditError when
 * the audit reports any anomaly. In production every complete leaf task has a
 * PASSED verification sidecar (state machine: verified→complete requires it),
 * so the throw fires only on genuine inconsistency.
 *
 * Cases:
 *   TC1 — complete task whose sidecar has result:'FAILED' → rejects
 *         instanceof VerificationAuditError; milestone NOT 'complete'
 *   TC2 — complete task with NO sidecar on disk → rejects
 *         instanceof VerificationAuditError; milestone NOT 'complete'
 *   TC3 — clean milestone, every complete task has a result:'PASSED' sidecar →
 *         NO throw; milestone transitions to 'complete'
 *   TC4 — thrown error carries .milestoneId, .anomalies (array), name set
 *
 * Harness mirrors test-pipeline-reviewer-gate.js (sidecar/mission fixtures) and
 * the instance-stubbing pattern of test-resume.js / test-spec-criteria-drain.js:
 * _executeMilestoneParallel, reviewer, _missionRegression, verifier.verifyRegression,
 * analyzer and _collectMilestoneContext are stubbed on the INSTANCE so all
 * complete missions are skipped and the only Phase-5 work that runs for real is
 * the verification audit + the milestone transition.
 *
 * Run: node test/test-verification-audit-gate.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { VerificationAuditError } from '../src/orchestrator/core/verification-audit-error.js';

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

/** Settle-timeout guard: a regression that hangs must fail, not wedge the runner. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`settle-timeout after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const WIRING_TIMEOUT_MS = 90_000;

// ── Fixture ──────────────────────────────────────────────────────────────────
//
// One milestone '001' (in_progress) with one complete mission '001-001' whose
// single sub-mission carries one complete task '001-001-001-001'. The sidecar
// for that task is written by the caller (varied per case) so we control what
// the Phase-5 audit sees.

function createIntegrationHarness({ milestoneId = '001', missionId = '001-001' } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verif-audit-gate-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const subMissionId = `${missionId}-001`;
  const taskId = `${subMissionId}-001`;

  // Progress sidecar for the completed task (read by _collectMilestoneContext,
  // which we stub, but harmless to write for fixture realism).
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

  // verify.json for the task.
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: ['src/foo.js'], hardChecks: [], testCases: [] })
  );

  const srcDir = path.join(projectRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'foo.js'), '// src/foo.js\n');

  // Per-mission state file — mission + sub-mission + task all 'complete'.
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

  // Global state.json — milestone in_progress, mission complete.
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

  return { projectRoot, harnessDir, milestoneId, missionId, subMissionId, taskId };
}

function cleanup(projectRoot) {
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeVerificationSidecar(harnessDir, taskId, payload) {
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-${taskId}.json`),
    JSON.stringify(payload, null, 2)
  );
}

/**
 * Build a Pipeline and stub every heavy step on the INSTANCE so _executeMilestone
 * sails past mission execution + reviewer gate + milestone regression and the
 * Phase-5 verification audit is the only consequential thing that runs.
 * Returns { pipeline, logs }.
 */
function makePipeline(projectRoot) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: (msg) => logs.push(String(msg)),
    onConfirm: async () => true,
  });

  // Missions are pre-completed in the fixture → no-op the scheduler executor so
  // control reaches the shared reviewer-gate / Phase-5 section directly.
  pipeline._executeMilestoneParallel = async () => {};

  // Reviewer PASS with no findings → reviewer gate proceeds.
  pipeline.reviewer = {
    reviewMilestone: async () => ({
      passed: true,
      findings: [],
      structured: { result: 'PASSED', findings: [], notes: '' },
      reportPath: '',
    }),
  };

  // Milestone regression seam (verifyMilestone calls verifier.verifyRegression) → PASS.
  pipeline.verifier = {
    verifyRegression: async () => ({ verified: true, report: 'ok', structured: { verified: true } }),
  };
  pipeline._missionRegression = async () => {};

  pipeline.analyzer = {
    analyzeFailure: async () => ({ eventId: 'fake', recommendation: 'human', affectedTasks: [] }),
  };

  // Avoid the expensive import-graph walk on a bare tmp dir.
  pipeline._collectMilestoneContext = () => ({
    modifiedFiles: [],
    taskDescriptions: [],
    importGraph: '',
    specScopeFiles: [],
    exceededFiles: [],
  });

  return { pipeline, logs };
}

function teardownPipeline(pipeline) {
  const handlers = pipeline._signalHandlers || {};
  if (handlers.SIGINT) process.removeListener('SIGINT', handlers.SIGINT);
  if (handlers.SIGTERM) process.removeListener('SIGTERM', handlers.SIGTERM);
  if (handlers.exit) process.removeListener('exit', handlers.exit);
  if (handlers.uncaughtException) process.removeListener('uncaughtException', handlers.uncaughtException);
  if (typeof pipeline.destroy === 'function') pipeline.destroy();
}

function readMilestoneStatus(harnessDir, milestoneId) {
  const state = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
  return state.milestones[milestoneId].status;
}

// ── Tests ──────────────────────────────────────────────────────────────────

await test('TC1: complete task with a FAILED sidecar → _executeMilestone rejects with VerificationAuditError; milestone NOT complete', async () => {
  const env = createIntegrationHarness();
  // Complete task on disk, but its verification sidecar says FAILED.
  writeVerificationSidecar(env.harnessDir, env.taskId, {
    taskId: env.taskId,
    result: 'FAILED',
    verified: false,
    report: 'mock failure',
  });

  const { pipeline } = makePipeline(env.projectRoot);
  try {
    let thrown = null;
    try {
      await withTimeout(
        pipeline._executeMilestone(env.milestoneId, JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state.json'), 'utf8')).milestones[env.milestoneId]),
        WIRING_TIMEOUT_MS, 'TC1 _executeMilestone'
      );
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'expected _executeMilestone to reject when a complete task has a FAILED sidecar');
    assert.ok(thrown instanceof VerificationAuditError,
      `expected VerificationAuditError, got ${thrown && thrown.name}: ${thrown && thrown.message}`);
    assert.notStrictEqual(readMilestoneStatus(env.harnessDir, env.milestoneId), 'complete',
      'milestone must NOT transition to complete when the audit throws');
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.projectRoot);
  }
});

await test('TC2: complete task with NO sidecar on disk → _executeMilestone rejects with VerificationAuditError; milestone NOT complete', async () => {
  const env = createIntegrationHarness();
  // Intentionally write NO verification sidecar for the complete task.
  assert.ok(
    !fs.existsSync(path.join(env.harnessDir, 'verification', `task-${env.taskId}.json`)),
    'precondition: the complete task must have no verification sidecar'
  );

  const { pipeline } = makePipeline(env.projectRoot);
  try {
    let thrown = null;
    try {
      await withTimeout(
        pipeline._executeMilestone(env.milestoneId, JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state.json'), 'utf8')).milestones[env.milestoneId]),
        WIRING_TIMEOUT_MS, 'TC2 _executeMilestone'
      );
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'expected _executeMilestone to reject when a complete task has no sidecar on disk');
    assert.ok(thrown instanceof VerificationAuditError,
      `expected VerificationAuditError, got ${thrown && thrown.name}: ${thrown && thrown.message}`);
    assert.notStrictEqual(readMilestoneStatus(env.harnessDir, env.milestoneId), 'complete',
      'milestone must NOT transition to complete when the audit throws');
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.projectRoot);
  }
});

await test('TC3: clean milestone — every complete task has a PASSED sidecar → NO throw; milestone transitions to complete', async () => {
  const env = createIntegrationHarness();
  // Production-realistic: the complete task carries a PASSED sidecar.
  writeVerificationSidecar(env.harnessDir, env.taskId, {
    taskId: env.taskId,
    result: 'PASSED',
    verified: true,
    report: 'ok',
    hardChecks: [],
    taskScopeChecks: [],
    notes: null,
  });

  const { pipeline } = makePipeline(env.projectRoot);
  try {
    let thrown = null;
    try {
      await withTimeout(
        pipeline._executeMilestone(env.milestoneId, JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state.json'), 'utf8')).milestones[env.milestoneId]),
        WIRING_TIMEOUT_MS, 'TC3 _executeMilestone'
      );
    } catch (err) {
      thrown = err;
    }
    assert.ok(!thrown,
      `expected no throw on a clean milestone, got ${thrown && thrown.name}: ${thrown && thrown.message}`);
    assert.strictEqual(readMilestoneStatus(env.harnessDir, env.milestoneId), 'complete',
      'milestone must transition to complete when every complete task has a PASSED sidecar');
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.projectRoot);
  }
});

await test('TC4: thrown error carries .milestoneId, .anomalies (array), and name VerificationAuditError', async () => {
  const env = createIntegrationHarness();
  writeVerificationSidecar(env.harnessDir, env.taskId, {
    taskId: env.taskId,
    result: 'FAILED',
    verified: false,
    report: 'mock failure',
  });

  const { pipeline } = makePipeline(env.projectRoot);
  try {
    let thrown = null;
    try {
      await withTimeout(
        pipeline._executeMilestone(env.milestoneId, JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state.json'), 'utf8')).milestones[env.milestoneId]),
        WIRING_TIMEOUT_MS, 'TC4 _executeMilestone'
      );
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'expected _executeMilestone to reject');
    assert.ok(thrown instanceof VerificationAuditError,
      `expected VerificationAuditError, got ${thrown && thrown.name}`);
    assert.strictEqual(thrown.name, 'VerificationAuditError',
      `expected .name === 'VerificationAuditError', got ${thrown.name}`);
    assert.strictEqual(thrown.milestoneId, env.milestoneId,
      `expected .milestoneId === '${env.milestoneId}', got ${JSON.stringify(thrown.milestoneId)}`);
    assert.ok(Array.isArray(thrown.anomalies),
      `expected .anomalies to be an array, got ${typeof thrown.anomalies}`);
    assert.ok(thrown.anomalies.length >= 1,
      `expected at least one anomaly for the FAILED task, got ${thrown.anomalies.length}`);
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.projectRoot);
  }
});

await test('TC5: mission state file deleted before _executeMilestone → rejects with VerificationAuditError; anomaly taskId mission:<missionId>; milestone NOT complete', async () => {
  const env = createIntegrationHarness();
  // Seed a PASSED sidecar so the task-level audit is clean.
  writeVerificationSidecar(env.harnessDir, env.taskId, {
    taskId: env.taskId,
    result: 'PASSED',
    verified: true,
    report: 'ok',
    hardChecks: [],
    taskScopeChecks: [],
    notes: null,
  });

  // Delete the mission state file to simulate the absent-file anomaly.
  const missionStateFilePath = path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`);
  assert.ok(fs.existsSync(missionStateFilePath), 'precondition: mission state file must exist before deletion');
  fs.rmSync(missionStateFilePath);
  assert.ok(!fs.existsSync(missionStateFilePath), 'precondition: mission state file must be absent after deletion');

  const { pipeline } = makePipeline(env.projectRoot);
  try {
    let thrown = null;
    try {
      await withTimeout(
        pipeline._executeMilestone(env.milestoneId, JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state.json'), 'utf8')).milestones[env.milestoneId]),
        WIRING_TIMEOUT_MS, 'TC5 _executeMilestone'
      );
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'expected _executeMilestone to reject when mission state file is missing');
    assert.ok(thrown instanceof VerificationAuditError,
      `expected VerificationAuditError, got ${thrown && thrown.name}: ${thrown && thrown.message}`);

    // Anomaly for the missing mission state file must be present.
    const expectedTaskId = `mission:${env.missionId}`;
    assert.ok(Array.isArray(thrown.anomalies), `expected .anomalies to be an array, got ${typeof thrown.anomalies}`);
    const matchingAnomaly = thrown.anomalies.find(
      (a) => a.taskId === expectedTaskId && /mission state file missing on disk/i.test(a.issue)
    );
    assert.ok(
      matchingAnomaly,
      `expected an anomaly with taskId '${expectedTaskId}' and issue matching /mission state file missing on disk/, got: ${JSON.stringify(thrown.anomalies)}`
    );

    // Milestone must NOT have transitioned to complete.
    assert.notStrictEqual(readMilestoneStatus(env.harnessDir, env.milestoneId), 'complete',
      'milestone must NOT transition to complete when the audit throws due to missing mission state file');
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.projectRoot);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
