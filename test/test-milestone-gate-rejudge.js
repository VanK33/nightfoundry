/**
 * test-milestone-gate-rejudge.js — Milestone gates (Phase A.5 coverage +
 * Phase C mission regression) fire over approved ∪ completed missions.
 *
 * Spec: milestone-gate-rejudge.spec.md / .json
 *
 * Contract under test (post-fix `_executeMilestoneParallel`):
 *   - gateMissionIds = approvedMissionIds ∪ missions of the milestone whose
 *     status is 'complete' in a FRESH read of .harness/state.json, sorted.
 *   - Phase A.5 (checkMilestoneCoverage), the Phase B task DAG, and Phase C
 *     (per-mission _missionRegression) all run over gateMissionIds.
 *   - Zero approved AND zero completed → early return with the existing
 *     'No missions approved for execution in milestone' log, no gates fire,
 *     scheduler not invoked.
 *   - A _missionRegression throw during a zero-approved re-judge propagates
 *     out (resume re-halts at the original gate).
 *   - Missions with status 'invalidated' (or any non-complete status) do NOT
 *     enter the gate set via the union.
 *
 * Cases:
 *   TC1 zero-approved re-judge (all missions complete; real coverage gate
 *       aggregates over 2 missions; regression for both in order; DAG both)
 *   TC2 partial resume (one complete + one approved → gate set covers both)
 *   TC3 fresh-run equivalence (no completed → gate set == approved)
 *   TC4 declined-everything (zero approved, zero complete → early return,
 *       no gates, scheduler not invoked)
 *   TC5 halt reproduction (regression throw during zero-approved re-judge
 *       rejects out of _executeMilestoneParallel)
 *   TC6 invalidated exclusion (invalidated mission not in the gate set)
 *
 * Run: node test/test-milestone-gate-rejudge.js
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

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SPEC_WITH_SCENARIOS = [
  '# Fixture spec (with scenarios)',
  '',
  '## Testing',
  '',
  '### Scenarios',
  '',
  '- S1: gates re-judge covers mission one',
  '- S2: gates re-judge covers mission two',
  '',
].join('\n');

const SPEC_NO_SCENARIOS = [
  '# Fixture spec (scenario-free)',
  '',
  'No scenario section here — coverage gate logs the skip line and returns.',
  '',
].join('\n');

/**
 * Create a temp project root with a .harness layout for milestone '001'.
 *
 * missions: array of
 *   { id, msStatus, taskStatus, tracesScenario }
 * where msStatus is the mission status written BOTH to state.json (the fresh
 * read the union derives from) and to the mission state file; taskStatus is
 * the on-disk status of the mission's single task (default = msStatus when
 * 'complete'/'invalidated', else 'pending' unless overridden).
 */
function createFixture({ missions, specContent }) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-rejudge-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  fs.writeFileSync(path.join(projectRoot, 'spec-fixture.md'), specContent);

  const missionEntries = {};
  for (const mission of missions) {
    const miId = mission.id;
    missionEntries[miId] = {
      id: miId,
      description: `mission ${miId}`,
      status: mission.msStatus,
      stateFile: `.harness/state/mission-${miId}.json`,
      planFile: `.harness/plan/mission-${miId}.md`,
    };

    const smId = `${miId}-001`;
    const taskId = `${smId}-001`;
    const taskStatus = mission.taskStatus
      || ((mission.msStatus === 'complete' || mission.msStatus === 'invalidated')
        ? mission.msStatus
        : 'pending');

    const missionState = {
      id: miId,
      missionId: miId,
      description: `mission ${miId}`,
      status: mission.msStatus,
      subMissions: {
        [smId]: {
          id: smId,
          description: `sub-mission ${smId}`,
          status: taskStatus,
          tasks: {
            [taskId]: {
              id: taskId,
              description: `task ${taskId}`,
              status: taskStatus,
              targetFiles: [],
              dependencies: [],
              testCases: [],
              tracesScenario: mission.tracesScenario || [],
              patternReferences: [],
              dataSchemas: [],
              retryCount: 0,
            },
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(harnessDir, 'state', `mission-${miId}.json`),
      JSON.stringify(missionState, null, 2)
    );

    fs.writeFileSync(
      path.join(harnessDir, 'plan', `mission-${miId}.md`),
      `# Plan for mission ${miId}\n\nFixture plan content.\n`
    );
  }

  const globalState = {
    projectMeta: {
      prdPath: 'spec-fixture.md',
      createdAt: new Date().toISOString(),
      currentPhase: 'executing',
    },
    globalStatus: 'active',
    milestones: {
      '001': {
        id: '001',
        description: 'milestone 001',
        status: 'in_progress',
        planFile: '.harness/plan/milestone-001.md',
        missions: missionEntries,
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  const msState = JSON.parse(
    fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8')
  ).milestones['001'];

  return { projectRoot, harnessDir, msState };
}

function cleanup(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

/**
 * Build a Pipeline with observation seams installed:
 *   - logs[]            collected onLog lines
 *   - regressionCalls[] mission ids _missionRegression was called with
 *   - planCalls[]       mission ids _planAndApproveMission was called with
 *   - dag               captured scheduler DAG (null until scheduler invoked)
 *
 * approve: (miId) => bool controls _planAndApproveMission's verdict;
 *          pass null to make any Phase A approval attempt fail the test
 *          (used when all missions are complete/invalidated and Phase A
 *          must skip them by status).
 * regressionImpl: optional override for the _missionRegression stub body
 *          (receives miId AFTER it is recorded in regressionCalls).
 */
function makePipeline(projectRoot, { approve = null, skipCoverageGate = false, regressionImpl = null } = {}) {
  const trace = {
    logs: [],
    regressionCalls: [],
    planCalls: [],
    dag: null,
    schedulerInvocations: 0,
  };

  const pipeline = new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    onLog: (msg) => trace.logs.push(String(msg)),
    onConfirm: async () => true,
  });

  pipeline._skipCoverageGate = skipCoverageGate;
  // Orphan hard-check drain is not the subject here; neutralize it so the
  // last-milestone drain never interferes with the gate-set behavior.
  pipeline._assertSpecHardCheckCoverage = () => {};

  pipeline._planAndApproveMission = async (miId) => {
    trace.planCalls.push(miId);
    if (approve === null) {
      throw new Error(`_planAndApproveMission unexpectedly called for ${miId} — Phase A must skip complete/invalidated missions by status`);
    }
    return approve(miId);
  };

  pipeline._missionRegression = async (miId, _missionPlan) => {
    trace.regressionCalls.push(miId);
    if (regressionImpl) await regressionImpl(miId);
  };

  pipeline.scheduler.runMilestone = async (_msId, dag) => {
    trace.schedulerInvocations += 1;
    trace.dag = dag;
  };

  return { pipeline, trace };
}

function dagMissionIds(dag) {
  return [...new Set((dag || []).map((t) => t.missionId))].sort();
}

function dagTaskIds(dag) {
  return (dag || []).map((t) => t.id).sort();
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {

await test('TC1 zero-approved re-judge: real coverage gate over 2 completed missions, regression for both in order, scheduler gets both missions\' DAG', async () => {
  const { projectRoot, msState } = createFixture({
    missions: [
      { id: '001-001', msStatus: 'complete', tracesScenario: ['S1'] },
      { id: '001-002', msStatus: 'complete', tracesScenario: ['S2'] },
    ],
    specContent: SPEC_WITH_SCENARIOS,
  });
  try {
    const { pipeline, trace } = makePipeline(projectRoot, { approve: null, skipCoverageGate: false });

    await pipeline._executeMilestoneParallel('001', msState);

    const joined = trace.logs.join('\n');

    // Phase A.5 ran the REAL checkMilestoneCoverage and aggregated coverage
    // across BOTH completed missions' on-disk state files.
    assert.ok(
      joined.includes('covered across 2 missions'),
      `expected real coverage log over 2 missions, got logs:\n${joined}`
    );

    // Phase C re-judged every completed mission, in sorted order.
    assert.deepStrictEqual(
      trace.regressionCalls,
      ['001-001', '001-002'],
      `regression must run once per completed mission in order, got: ${JSON.stringify(trace.regressionCalls)}`
    );

    // Phase B: scheduler invoked with the completed missions' task DAG
    // (execution channel for coverage-remediation tasks at zero approved).
    assert.strictEqual(trace.schedulerInvocations, 1, 'scheduler must be invoked exactly once');
    assert.deepStrictEqual(dagMissionIds(trace.dag), ['001-001', '001-002']);
    assert.deepStrictEqual(dagTaskIds(trace.dag), ['001-001-001-001', '001-002-001-001']);
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC2 partial resume: one completed + one approved — gate set covers both', async () => {
  const { projectRoot, msState } = createFixture({
    missions: [
      { id: '001-001', msStatus: 'complete' },
      // Approved-this-run mission: milestone status pending so Phase A visits
      // it; tasks already terminal on disk so the post-scheduler invariant
      // holds with the scheduler stubbed out.
      { id: '001-002', msStatus: 'pending', taskStatus: 'complete' },
    ],
    specContent: SPEC_NO_SCENARIOS,
  });
  try {
    const { pipeline, trace } = makePipeline(projectRoot, {
      approve: () => true,
      skipCoverageGate: false,
    });

    await pipeline._executeMilestoneParallel('001', msState);

    // Phase A only visited the non-complete mission.
    assert.deepStrictEqual(trace.planCalls, ['001-002']);

    // Real coverage gate fired (scenario-free spec → observable skip line).
    const joined = trace.logs.join('\n');
    assert.ok(
      joined.includes('Milestone scenario coverage: spec declares no scenarios, skipping.'),
      `expected the real coverage gate to run, got logs:\n${joined}`
    );

    // Regression re-judged BOTH the prior-run-completed mission and the
    // newly approved one, in sorted order.
    assert.deepStrictEqual(trace.regressionCalls, ['001-001', '001-002']);

    // DAG spans both missions' tasks.
    assert.strictEqual(trace.schedulerInvocations, 1);
    assert.deepStrictEqual(dagMissionIds(trace.dag), ['001-001', '001-002']);
    assert.deepStrictEqual(dagTaskIds(trace.dag), ['001-001-001-001', '001-002-001-001']);
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC3 fresh-run equivalence: zero completed missions — gate set identical to approvedMissionIds', async () => {
  const { projectRoot, msState } = createFixture({
    missions: [
      // Tasks terminal on disk (post-scheduler invariant; scheduler stubbed)
      // while the mission itself is approvable.
      { id: '001-001', msStatus: 'pending', taskStatus: 'complete' },
    ],
    specContent: SPEC_NO_SCENARIOS,
  });
  try {
    const { pipeline, trace } = makePipeline(projectRoot, {
      approve: () => true,
      skipCoverageGate: true, // A.5 not the subject here
    });

    await pipeline._executeMilestoneParallel('001', msState);

    assert.deepStrictEqual(trace.planCalls, ['001-001']);
    assert.deepStrictEqual(trace.regressionCalls, ['001-001'],
      'regression must run only for the approved mission');
    assert.strictEqual(trace.schedulerInvocations, 1);
    assert.deepStrictEqual(dagMissionIds(trace.dag), ['001-001']);
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC4 declined-everything: zero approved AND zero completed — early return, no gates, scheduler not invoked', async () => {
  const { projectRoot, msState } = createFixture({
    missions: [
      { id: '001-001', msStatus: 'pending' },
      { id: '001-002', msStatus: 'pending' },
    ],
    specContent: SPEC_NO_SCENARIOS,
  });
  try {
    const { pipeline, trace } = makePipeline(projectRoot, {
      approve: () => false, // user declined everything
      skipCoverageGate: false,
    });

    await pipeline._executeMilestoneParallel('001', msState);

    const joined = trace.logs.join('\n');
    assert.ok(
      joined.includes('No missions approved for execution in milestone 001'),
      `expected the existing empty-set log, got logs:\n${joined}`
    );
    assert.deepStrictEqual(trace.regressionCalls, [], '_missionRegression must not be called');
    assert.strictEqual(trace.schedulerInvocations, 0, 'scheduler must not be invoked');
    assert.ok(
      !joined.includes('Milestone scenario coverage'),
      `checkMilestoneCoverage must not run on the empty gate set, got logs:\n${joined}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC5 halt reproduction: regression throw during zero-approved re-judge propagates out', async () => {
  const { projectRoot, msState } = createFixture({
    missions: [
      { id: '001-001', msStatus: 'complete' },
      { id: '001-002', msStatus: 'complete' },
    ],
    specContent: SPEC_NO_SCENARIOS,
  });
  try {
    const haltErr = new Error('mission 001-001 regression re-halt');
    const { pipeline, trace } = makePipeline(projectRoot, {
      approve: null, // all complete → Phase A must skip by status
      skipCoverageGate: true,
      regressionImpl: (miId) => {
        if (miId === '001-001') throw haltErr;
      },
    });

    await assert.rejects(
      () => pipeline._executeMilestoneParallel('001', msState),
      (err) => err === haltErr,
      'the regression failure must propagate out of _executeMilestoneParallel'
    );

    // Halted at the FIRST re-judged mission — the second was never reached.
    assert.deepStrictEqual(trace.regressionCalls, ['001-001']);
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC6 invalidated exclusion: invalidated mission never enters the gate set via the union', async () => {
  const { projectRoot, msState } = createFixture({
    missions: [
      { id: '001-001', msStatus: 'complete' },
      { id: '001-002', msStatus: 'invalidated' },
    ],
    specContent: SPEC_NO_SCENARIOS,
  });
  try {
    const { pipeline, trace } = makePipeline(projectRoot, {
      approve: null, // complete + invalidated → Phase A must skip both
      skipCoverageGate: true,
    });

    await pipeline._executeMilestoneParallel('001', msState);

    assert.deepStrictEqual(trace.planCalls, [], 'Phase A must skip complete/invalidated missions');
    assert.deepStrictEqual(trace.regressionCalls, ['001-001'],
      'regression must run only for the complete mission — invalidated is excluded from the union');
    assert.strictEqual(trace.schedulerInvocations, 1);
    assert.deepStrictEqual(dagMissionIds(trace.dag), ['001-001'],
      'DAG must contain only the complete mission\'s tasks');
  } finally {
    cleanup(projectRoot);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
