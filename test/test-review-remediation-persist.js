/**
 * test-review-remediation-persist.js — pins the persist-first reviewer-gate
 * remediation contract (design-review-remediation-persist.md, invariants I1-I4).
 *
 * Context: the reviewer-gate remediation block in Pipeline._executeMilestone
 * (src/orchestrator/core/pipeline.js) used to interleave, per findings group,
 * [generate fix tasks → merge into mission state → execute], advancing the
 * persisted review-retry counter only AFTER the whole loop. A silent process
 * death between generate and the counter write left NO on-disk record that
 * remediation had been planned, so a subsequent `resume` re-ran the reviewer,
 * hit the same finding, and the analyzer's anti-repeat rule escalated to
 * `human` — with no machine path to convergence.
 *
 * The persist-first change restructures the loop into: Phase 1 generate all,
 * Phase 2 merge all then increment the counter, Phase 3 execute. This file
 * pins the resulting contract:
 *
 *   I1 persist-before-execute — merged tasks AND the incremented counter are on
 *      disk BEFORE any remediation-task executor spawns. Pinned by stubbing
 *      _executeAndVerifyTask to THROW on first call (simulated death) and
 *      asserting on-disk state at that instant.
 *   I2 resume self-healing — a pending remediation task persisted into a
 *      complete mission of a non-terminal milestone gets an execution channel
 *      via the completed-missions DAG (_buildTaskDAG), so re-entry executes it
 *      and reaches the reviewer. Pinned at the DAG level (+ a drive of
 *      _executeMilestone with the DAG channel emulated).
 *   I3 cap preserved — with the persisted counter already at maxRetries, a
 *      reviewer FAIL routes to the retry-cap CircuitBreakerError WITHOUT
 *      spawning a remediation planner.
 *   I4 untouched paths — reviewer pass → no remediation writes; analyzer
 *      `human` → no merge / no counter change; empty newTasks → counter
 *      incremented then no-fix-tasks CircuitBreakerError with NOTHING merged
 *      from any group (all-or-nothing).
 *
 * Two-agents split: this file is authored WITHOUT reading the implementation
 * diff. Tests derive from the design doc + pre-existing code. Some tests encode
 * the NEW contract and will legitimately FAIL against pre-change code — each
 * such test says so in its assertion messages and in the per-test header below.
 *
 * Run: node test/test-review-remediation-persist.js
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
//
// Modeled on test/test-pipeline-reviewer-gate.js's createIntegrationHarness /
// makePipeline / installMocks idiom: a temp project root with a .harness dir,
// a global state.json whose milestone is `in_progress` and whose mission(s)
// are `complete`, per-mission state file(s) with pre-completed task(s), and
// PASSED verification sidecars so the Phase-5 audit does not throw.

const HARNESS_SUBDIRS = ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis'];

function completeTask(taskId, targetFiles) {
  return {
    id: taskId,
    description: `task ${taskId}`,
    status: 'complete',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    targetFiles,
    dependencies: [],
    testCases: [],
    tracesScenario: [],
    patternReferences: [],
    dataSchemas: [],
    verifyFile: `.harness/verify/task-${taskId}.json`,
    progressFile: `.harness/progress/task-${taskId}.json`,
    verificationFile: `.harness/verification/task-${taskId}.json`,
    retryCount: 0,
  };
}

function writeTaskSidecars(harnessDir, taskId, targetFiles) {
  fs.writeFileSync(
    path.join(harnessDir, 'progress', `task-${taskId}.json`),
    JSON.stringify({ taskId, status: 'COMPLETE', affectedFiles: targetFiles.map(p => ({ path: p })), summary: 'done', testsSummary: '' })
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-${taskId}.json`),
    JSON.stringify({ taskId, verified: true, report: 'fake', result: 'PASSED', hardChecks: [], taskScopeChecks: [], notes: null })
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles, hardChecks: [], testCases: [] })
  );
}

/**
 * Single-mission harness: milestone `001` (in_progress), mission `001-001`
 * (complete) with one complete task `001-001-001-001` → src/foo.js.
 *
 * If opts.pendingRemTaskId is set, ALSO seed a *pending* remediation task in
 * the same sub-mission (simulating state persisted just before a process
 * death) — used by the I2 resume tests. No PASSED sidecar is seeded for a
 * pending task (it has not been verified yet).
 */
function createSingleMissionHarness({ pendingRemTaskId = null } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-persist-'));
  const harnessDir = path.join(projectRoot, '.harness');
  for (const sub of HARNESS_SUBDIRS) fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });

  const milestoneId = '001';
  const missionId   = '001-001';
  const subMissionId = '001-001-001';
  const taskId      = '001-001-001-001';

  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'foo.js'), '// src/foo.js\n');

  writeTaskSidecars(harnessDir, taskId, ['src/foo.js']);

  const tasks = { [taskId]: completeTask(taskId, ['src/foo.js']) };
  if (pendingRemTaskId) {
    // A pending remediation task, as mergeRemediationTasks would have written
    // it (status 'pending', sidecar-path fields), plus its stub verify file.
    tasks[pendingRemTaskId] = {
      id: pendingRemTaskId,
      description: `remediation fix ${pendingRemTaskId}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      targetFiles: ['src/foo.js'],
      dependencies: [],
      testCases: [],
      tracesScenario: [],
      patternReferences: [],
      dataSchemas: [],
      verifyFile: `verify/task-${pendingRemTaskId}.json`,
      progressFile: `progress/task-${pendingRemTaskId}.json`,
      verificationFile: `verification/task-${pendingRemTaskId}.json`,
      retryCount: 0,
    };
    fs.writeFileSync(
      path.join(harnessDir, 'verify', `task-${pendingRemTaskId}.json`),
      JSON.stringify({ taskId: pendingRemTaskId, targetFiles: ['src/foo.js'], hardChecks: [], testCases: [] }, null, 2)
    );
  }

  const missionState = {
    id: missionId,
    missionId,
    description: `mission ${missionId}`,
    status: 'complete',
    subMissions: { [subMissionId]: { id: subMissionId, description: 'sub-mission', status: 'complete', tasks } },
  };
  fs.writeFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), JSON.stringify(missionState, null, 2));
  seedPassedSidecars(harnessDir, missionState);

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

/**
 * Two-mission harness: milestone `001` (in_progress) with missions
 * `001-001` (task → src/foo.js) and `001-002` (task → src/bar.js), both
 * complete. buildFileToMissionMap keys off task.targetFiles, so a finding on
 * src/foo.js maps to mission 001-001 and one on src/bar.js to mission 001-002
 * — giving two distinct findings groups for the all-or-nothing test.
 */
function createTwoMissionHarness() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-persist-2m-'));
  const harnessDir = path.join(projectRoot, '.harness');
  for (const sub of HARNESS_SUBDIRS) fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });

  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'foo.js'), '// src/foo.js\n');
  fs.writeFileSync(path.join(projectRoot, 'src', 'bar.js'), '// src/bar.js\n');

  const milestoneId = '001';
  const missions = [
    { missionId: '001-001', sm: '001-001-001', taskId: '001-001-001-001', file: 'src/foo.js' },
    { missionId: '001-002', sm: '001-002-001', taskId: '001-002-001-001', file: 'src/bar.js' },
  ];

  const globalMissions = {};
  for (const m of missions) {
    writeTaskSidecars(harnessDir, m.taskId, [m.file]);
    const missionState = {
      id: m.missionId,
      missionId: m.missionId,
      description: `mission ${m.missionId}`,
      status: 'complete',
      subMissions: { [m.sm]: { id: m.sm, description: 'sub-mission', status: 'complete', tasks: { [m.taskId]: completeTask(m.taskId, [m.file]) } } },
    };
    fs.writeFileSync(path.join(harnessDir, 'state', `mission-${m.missionId}.json`), JSON.stringify(missionState, null, 2));
    seedPassedSidecars(harnessDir, missionState);
    globalMissions[m.missionId] = {
      id: m.missionId,
      description: `mission ${m.missionId}`,
      status: 'complete',
      stateFile: `.harness/state/mission-${m.missionId}.json`,
      planFile: `.harness/plan/mission-${m.missionId}.md`,
    };
  }

  const globalState = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId,
        description: `milestone ${milestoneId}`,
        status: 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: globalMissions,
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  return { projectRoot, harnessDir, milestoneId, missions };
}

function cleanup(projectRoot) {
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makePipeline(projectRoot, extraOpts = {}) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, { onLog: (m) => logs.push(m), onConfirm: async () => true, ...extraOpts });
  return { pipeline, logs };
}

/**
 * Shared reviewer-gate mocks (mirrors test-pipeline-reviewer-gate.js
 * installMocks). Stubs the executor/verifier/analyzer/reviewer, no-ops the
 * scheduler pass (_executeMilestoneParallel) so pre-completed missions skip
 * straight to the reviewer gate, and stubs _collectMilestoneContext to avoid
 * an import-graph walk on a bare tmpdir.
 *
 * Returns a trace whose counters the individual tests assert on.
 */
function installMocks(pipeline, { reviewerResults, analyzerRecommendation = 'human' }) {
  const trace = { reviewMilestoneCalls: 0, analyzeFailureCalls: 0, verifyRegressionCalls: 0 };
  // reviewerResults: array consumed one-per-call (initial, re-review, ...).
  const results = Array.isArray(reviewerResults) ? reviewerResults.slice() : [reviewerResults];

  pipeline.executor = { executeTask: async (task) => ({ status: 'COMPLETE', affectedFiles: task.targetFiles || [] }) };

  pipeline.verifier = {
    verifyRegression: async (task) => {
      if (task.id && task.id.startsWith('regression-milestone-')) trace.verifyRegressionCalls++;
      return { verified: true, report: 'mock regression verifier', structured: { verified: true } };
    },
  };

  pipeline.analyzer = {
    analyzeFailure: async () => {
      trace.analyzeFailureCalls++;
      return { eventId: 'mock-event-001', recommendation: analyzerRecommendation, affectedTasks: [] };
    },
  };

  pipeline.reviewer = {
    reviewMilestone: async () => {
      const r = results[Math.min(trace.reviewMilestoneCalls, results.length - 1)];
      trace.reviewMilestoneCalls++;
      return r;
    },
  };

  pipeline._collectMilestoneContext = () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' });
  pipeline._executeMilestoneParallel = async () => {};

  return trace;
}

function failedResult(findings) {
  return { passed: false, findings, structured: { result: 'FAILED', findings, notes: '' }, reportPath: '' };
}
function passedResult() {
  return { passed: true, findings: [], structured: { result: 'PASSED', findings: [], notes: '' }, reportPath: '' };
}
const critical = (file, description) => ({ severity: 'critical', category: 'call-chain', file, description, relatedFiles: [] });

function reviewRetryFileOf(harnessDir, milestoneId) {
  return path.join(harnessDir, 'analysis', `review-retry-${milestoneId}.json`);
}
function readCounter(harnessDir, milestoneId) {
  const f = reviewRetryFileOf(harnessDir, milestoneId);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')).count;
}
function readMissionState(harnessDir, missionId) {
  return JSON.parse(fs.readFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), 'utf8'));
}
// Count every task across a mission's sub-missions, and count only pending ones.
function taskCounts(harnessDir, missionId) {
  const st = readMissionState(harnessDir, missionId);
  let total = 0, pending = 0;
  const pendingIds = [];
  for (const sm of Object.values(st.subMissions || {})) {
    for (const t of Object.values(sm.tasks || {})) {
      total++;
      if (t.status === 'pending') { pending++; pendingIds.push(t.id); }
    }
  }
  return { total, pending, pendingIds };
}

// ── Tests ────────────────────────────────────────────────────────────

async function run() {

// ─────────────────────────────────────────────────────────────────────
// I1 — persist-before-execute
//
// NEW-CONTRACT TEST (expected to FAIL against pre-change HEAD, for the RIGHT
// reason): pre-change code advances the persisted counter only AFTER the whole
// execution loop, so at the instant the first executor spawns the counter is
// still un-incremented. The merged task + verify stub already precede execute
// in HEAD (per-group merge before per-group execute), so those sub-assertions
// pass against HEAD; the counter sub-assertion is the one that encodes the new
// ordering and fails against HEAD.
// ─────────────────────────────────────────────────────────────────────

await test('I1: persist-before-execute — merged task + verify stub + incremented counter are on disk BEFORE any executor spawns [NEW CONTRACT: counter check fails vs HEAD]', async () => {
  const { projectRoot, harnessDir, milestoneId, missionId, subMissionId } = createSingleMissionHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    installMocks(pipeline, { reviewerResults: [failedResult([critical('src/foo.js', 'fix needed')])], analyzerRecommendation: 'retry' });

    const remTaskId = '001-001-001-002';
    pipeline.planner = {
      remediateReviewFindings: async () => ({
        newTasks: [{ id: remTaskId, subMissionId, description: 'fix critical finding', targetFiles: ['src/foo.js'] }],
      }),
    };

    // Simulated process death: the FIRST executor spawn throws. Snapshot the
    // on-disk state at that instant — this is exactly "before execute".
    let snapshot = null;
    pipeline._executeAndVerifyTask = async () => {
      if (!snapshot) {
        const { pending, pendingIds } = taskCounts(harnessDir, missionId);
        snapshot = {
          pendingCount: pending,
          pendingIds,
          verifyStubExists: fs.existsSync(path.join(harnessDir, 'verify', `task-${remTaskId}.json`)),
          counter: readCounter(harnessDir, milestoneId),
        };
      }
      throw new Error('simulated process death during remediation-task execution');
    };

    const msState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8')).milestones[milestoneId];

    let threw = false;
    try { await pipeline._executeMilestone(milestoneId, msState); } catch { threw = true; }

    assert.ok(threw, 'expected _executeMilestone to propagate the simulated death');
    assert.ok(snapshot, 'expected the executor stub to have been reached (a remediation task must have been scheduled for execution)');

    // (a) merged remediation task present on disk before execute — holds vs HEAD too.
    assert.ok(snapshot.pendingCount >= 1, `expected >=1 pending remediation task merged before execute; got ${snapshot.pendingCount}`);
    // (b) stub verify.json present on disk before execute — holds vs HEAD too.
    assert.ok(snapshot.verifyStubExists, 'expected verify/task-<id>.json stub written before execute');
    // (c) counter incremented BEFORE execute — the persist-first contract.
    //     Pre-change HEAD leaves this null (counter advanced only after the loop),
    //     so this assertion legitimately FAILS against HEAD.
    assert.strictEqual(
      snapshot.counter, 1,
      `persist-first contract: review-retry counter must be incremented to 1 BEFORE any executor spawns; ` +
      `got ${snapshot.counter} (null/absent means the counter was advanced only after execution — the pre-change ordering this change fixes)`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ─────────────────────────────────────────────────────────────────────
// I2 — resume self-healing (DAG channel)
//
// HEAD-SEMANTICS pin: the completed-missions DAG channel already exists and is
// the mechanism the design reuses. These verify that a remediation task
// persisted into a complete mission of a non-terminal milestone (post-death
// state) gets an execution channel and, on re-entry, is executed before the
// reviewer runs.
// ─────────────────────────────────────────────────────────────────────

await test('I2a: _buildTaskDAG over a completed mission includes its persisted pending remediation task as an executable node', async () => {
  const remTaskId = '001-001-001-002';
  const { projectRoot, harnessDir, missionId } = createSingleMissionHarness({ pendingRemTaskId: remTaskId });
  const { pipeline } = makePipeline(projectRoot);

  try {
    const dag = pipeline._buildTaskDAG([missionId]);
    const ids = dag.map(t => t.id);
    assert.ok(ids.includes(remTaskId), `expected DAG to include the persisted pending remediation task ${remTaskId} (execution channel for completed-mission remediation). Got: [${ids.join(', ')}]`);
    // The already-complete original task is also a node; the scheduler skips
    // terminal tasks at dispatch, so co-presence is expected and harmless.
    assert.ok(ids.includes('001-001-001-001'), 'expected the original completed task to also be a DAG node');
  } finally {
    cleanup(projectRoot);
  }
});

await test('I2b: re-entering _executeMilestone executes the persisted pending remediation task via the DAG channel, then reaches a passing reviewer (no throw)', async () => {
  const remTaskId = '001-001-001-002';
  const { projectRoot, harnessDir, milestoneId, missionId } = createSingleMissionHarness({ pendingRemTaskId: remTaskId });
  const { pipeline } = makePipeline(projectRoot);

  try {
    // Reviewer passes on re-entry (the persisted fix having landed) — the
    // self-healing convergence the design describes.
    const trace = installMocks(pipeline, { reviewerResults: [passedResult()], analyzerRecommendation: 'retry' });

    const executed = [];
    // Mirror _executeAndVerifyTask: drive the task to a terminal state and seed
    // a PASSED sidecar so the milestone-advance invariant + Phase-5 audit pass.
    pipeline._executeAndVerifyTask = async (mId, smId, task) => {
      executed.push(task.id);
      const stateFile = path.join(harnessDir, 'state', `mission-${mId}.json`);
      const ms = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const t = ms.subMissions[smId]?.tasks[task.id];
      if (t) { t.status = 'complete'; fs.writeFileSync(stateFile, JSON.stringify(ms, null, 2)); seedPassedSidecars(harnessDir, ms); }
    };

    // Emulate the real completed-missions DAG channel that _executeMilestoneParallel
    // runs on resume: build the DAG (which is the mechanism under test — reuse the
    // pipeline's own _buildTaskDAG), then execute every node still pending on disk.
    pipeline._executeMilestoneParallel = async (msId) => {
      const dag = pipeline._buildTaskDAG([missionId]);
      for (const node of dag) {
        const st = readMissionState(harnessDir, node.missionId);
        const sm = st.subMissions[node.subMissionId];
        const task = sm?.tasks?.[node.id];
        if (task && task.status === 'pending') {
          await pipeline._executeAndVerifyTask(node.missionId, node.subMissionId, task);
        }
      }
    };

    const msState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8')).milestones[milestoneId];
    await pipeline._executeMilestone(milestoneId, msState);

    assert.ok(executed.includes(remTaskId), `expected the persisted pending remediation task ${remTaskId} to be executed on re-entry; executed: [${executed.join(', ')}]`);
    assert.strictEqual(taskCounts(harnessDir, missionId).pending, 0, 'expected no pending tasks left after self-healing execution');
    assert.ok(trace.reviewMilestoneCalls >= 1, 'expected the reviewer to run after the persisted task executed (convergence path reached)');
    // Reviewer passed → this is an untouched path: no remediation counter write.
    assert.strictEqual(readCounter(harnessDir, milestoneId), null, 'expected no review-retry counter write when the re-entry reviewer passes');
  } finally {
    cleanup(projectRoot);
  }
});

// ─────────────────────────────────────────────────────────────────────
// I3 — cap preserved
//
// HEAD-SEMANTICS pin (guards that persist-first did not move/break the cap):
// with the persisted counter already at maxRetries, a reviewer FAIL must route
// to the retry-cap CircuitBreakerError WITHOUT ever spawning a remediation
// planner, and must not advance the counter past the cap.
// ─────────────────────────────────────────────────────────────────────

await test('I3: persisted counter == maxRetries → reviewer FAIL hits retry-cap CircuitBreaker, planner NEVER spawned, counter unchanged', async () => {
  const { projectRoot, harnessDir, milestoneId } = createSingleMissionHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    const maxRetries = config.maxRetries ?? 2;
    fs.writeFileSync(reviewRetryFileOf(harnessDir, milestoneId), JSON.stringify({ count: maxRetries }));

    installMocks(pipeline, { reviewerResults: [failedResult([critical('src/foo.js', 'persistent issue')])], analyzerRecommendation: 'retry' });

    let plannerCalls = 0;
    pipeline.planner = { remediateReviewFindings: async () => { plannerCalls++; return { newTasks: [] }; } };

    const msState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8')).milestones[milestoneId];

    let err = null;
    try { await pipeline._executeMilestone(milestoneId, msState); } catch (e) { err = e; }

    assert.ok(err, 'expected a throw when the retry cap is exhausted');
    assert.ok(/exhausted|cap/.test(err.message), `expected "exhausted"/"cap" in the cap error; got: ${err.message}`);
    assert.ok(err.message.toLowerCase().includes('human'), `expected "human" in the cap error; got: ${err.message}`);
    assert.strictEqual(plannerCalls, 0, `expected remediation planner NEVER spawned once the cap is hit; got ${plannerCalls} call(s)`);
    assert.strictEqual(readCounter(harnessDir, milestoneId), maxRetries, `expected the persisted counter to stay at the cap (${maxRetries}); got ${readCounter(harnessDir, milestoneId)}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ─────────────────────────────────────────────────────────────────────
// I4 — untouched paths
// ─────────────────────────────────────────────────────────────────────

await test('I4a: reviewer PASS → no remediation writes (no review-retry counter, no new tasks merged)', async () => {
  const { projectRoot, harnessDir, milestoneId, missionId } = createSingleMissionHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    installMocks(pipeline, { reviewerResults: [passedResult()] });
    let plannerCalls = 0;
    pipeline.planner = { remediateReviewFindings: async () => { plannerCalls++; return { newTasks: [] }; } };

    const before = taskCounts(harnessDir, missionId).total;
    const msState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8')).milestones[milestoneId];
    await pipeline._executeMilestone(milestoneId, msState);

    assert.strictEqual(readCounter(harnessDir, milestoneId), null, 'expected NO review-retry counter file when the reviewer passes');
    assert.strictEqual(plannerCalls, 0, 'expected the remediation planner NOT spawned on a reviewer pass');
    assert.strictEqual(taskCounts(harnessDir, missionId).total, before, 'expected no tasks merged on a reviewer pass');
  } finally {
    cleanup(projectRoot);
  }
});

await test('I4b: analyzer recommends `human` → throws, NO merge, NO counter change, planner NEVER spawned', async () => {
  const { projectRoot, harnessDir, milestoneId, missionId } = createSingleMissionHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    installMocks(pipeline, { reviewerResults: [failedResult([critical('src/foo.js', 'needs human')])], analyzerRecommendation: 'human' });
    let plannerCalls = 0;
    pipeline.planner = { remediateReviewFindings: async () => { plannerCalls++; return { newTasks: [{ id: '001-001-001-002', subMissionId: '001-001-001', description: 'x', targetFiles: [] }] }; } };

    const before = taskCounts(harnessDir, missionId).total;
    const msState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8')).milestones[milestoneId];

    let err = null;
    try { await pipeline._executeMilestone(milestoneId, msState); } catch (e) { err = e; }

    assert.ok(err, 'expected a throw when the analyzer recommends human');
    assert.ok(err.message.toLowerCase().includes('human'), `expected "human" in the error; got: ${err.message}`);
    assert.strictEqual(plannerCalls, 0, 'expected the remediation planner NOT spawned on a `human` recommendation');
    assert.strictEqual(readCounter(harnessDir, milestoneId), null, 'expected NO counter change on a `human` recommendation');
    assert.strictEqual(taskCounts(harnessDir, missionId).total, before, 'expected NO tasks merged on a `human` recommendation');
  } finally {
    cleanup(projectRoot);
  }
});

await test('I4c-single: empty newTasks → counter incremented (0→1) then no-fix-tasks CircuitBreaker, NOTHING merged', async () => {
  const { projectRoot, harnessDir, milestoneId, missionId } = createSingleMissionHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    installMocks(pipeline, { reviewerResults: [failedResult([critical('src/foo.js', 'no fix available')])], analyzerRecommendation: 'retry' });
    pipeline.planner = { remediateReviewFindings: async () => ({ newTasks: [] }) };

    const before = taskCounts(harnessDir, missionId).total;
    const msState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8')).milestones[milestoneId];

    let err = null;
    try { await pipeline._executeMilestone(milestoneId, msState); } catch (e) { err = e; }

    assert.ok(err, 'expected a throw when remediation yields no fix tasks');
    assert.ok(/no fix tasks|remediation produced no fix/i.test(err.message), `expected the no-fix-tasks message; got: ${err.message}`);
    assert.strictEqual(readCounter(harnessDir, milestoneId), 1, `expected the counter incremented 0→1 on the empty-newTasks arm; got ${readCounter(harnessDir, milestoneId)}`);
    assert.strictEqual(taskCounts(harnessDir, missionId).total, before, 'expected NOTHING merged on the empty-newTasks arm');
  } finally {
    cleanup(projectRoot);
  }
});

await test('I4c-multi: all-or-nothing — group1 returns a fix task, group2 returns empty → NOTHING merged from EITHER group, counter incremented, no-fix-tasks throw [NEW CONTRACT: fails vs HEAD]', async () => {
  const { projectRoot, harnessDir, milestoneId, missions } = createTwoMissionHarness();
  const { pipeline } = makePipeline(projectRoot);
  const [mA, mB] = missions; // 001-001 (src/foo.js), 001-002 (src/bar.js)

  try {
    // Two critical findings, foo first so group 001-001 is processed before 001-002.
    installMocks(pipeline, {
      reviewerResults: [failedResult([critical(mA.file, 'fixable'), critical(mB.file, 'unfixable')])],
      analyzerRecommendation: 'retry',
    });

    // Planner: fix task for the foo group, empty for the bar group. Keyed off the
    // finding file since remediateReviewFindings receives the per-group findings.
    const remTaskId = '001-001-001-002';
    let plannerCalls = 0;
    pipeline.planner = {
      remediateReviewFindings: async (_msId, findings) => {
        plannerCalls++;
        const files = findings.map(f => f.file);
        if (files.includes(mA.file)) return { newTasks: [{ id: remTaskId, subMissionId: mA.sm, description: 'fix foo', targetFiles: [mA.file] }] };
        return { newTasks: [] };
      },
    };
    // Present so HEAD (which would execute the merged foo task before hitting the
    // empty bar group) does not spawn a real session; harmless for the new contract
    // (never called, since nothing is executed before the all-groups empty check).
    pipeline._executeAndVerifyTask = async (mId, smId, task) => {
      const stateFile = path.join(harnessDir, 'state', `mission-${mId}.json`);
      const ms = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const t = ms.subMissions[smId]?.tasks[task.id];
      if (t) { t.status = 'complete'; fs.writeFileSync(stateFile, JSON.stringify(ms, null, 2)); seedPassedSidecars(harnessDir, ms); }
    };

    const beforeA = taskCounts(harnessDir, mA.missionId).total;
    const beforeB = taskCounts(harnessDir, mB.missionId).total;
    const msState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8')).milestones[milestoneId];

    let err = null;
    try { await pipeline._executeMilestone(milestoneId, msState); } catch (e) { err = e; }

    assert.ok(err, 'expected a throw when any group yields no fix tasks');
    assert.ok(/no fix tasks|remediation produced no fix/i.test(err.message), `expected the no-fix-tasks message; got: ${err.message}`);
    assert.strictEqual(readCounter(harnessDir, milestoneId), 1, `expected the counter incremented to 1; got ${readCounter(harnessDir, milestoneId)}`);
    assert.ok(plannerCalls >= 1, 'expected the remediation planner spawned for at least the first group');

    // ALL-OR-NOTHING (the new contract): the fixable group's task must NOT have
    // been merged even though its group produced a fix task, because a later group
    // came back empty. Pre-change HEAD merges (and executes) group 001-001 before
    // it reaches the empty group 001-002, so mission 001-001 gains a task there —
    // making this assertion legitimately FAIL against HEAD.
    assert.strictEqual(
      taskCounts(harnessDir, mA.missionId).total, beforeA,
      `all-or-nothing: expected NO task merged into mission ${mA.missionId} when a sibling group returned empty; ` +
      `found ${taskCounts(harnessDir, mA.missionId).total} task(s) vs ${beforeA} before (pre-change HEAD merges+executes the earlier group before the later empty group throws)`
    );
    assert.strictEqual(taskCounts(harnessDir, mB.missionId).total, beforeB, `expected mission ${mB.missionId} unchanged`);
    assert.ok(!fs.existsSync(path.join(harnessDir, 'verify', `task-${remTaskId}.json`)), 'all-or-nothing: expected NO stub verify.json written for the un-merged fix task');
  } finally {
    cleanup(projectRoot);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
}

run();
