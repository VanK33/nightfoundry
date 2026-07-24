/**
 * test-milestone-cascade.js — Tests for milestone cascade / pipeline Phase 5 behavior.
 *
 * Verifies:
 *   1. cascadeComplete always returns milestone:'skipped' (Phase 5 handles milestone)
 *   2. Pipeline Phase 5 calls transitionMilestone unconditionally after regression passes
 *   3. Resume re-enters _executeMilestone after regression failure
 *   4. Resume re-enters _executeMilestone after reviewer failure
 *   5. task→sub-mission→mission cascade unbroken while milestone stays skipped
 *
 * Run: node test/test-milestone-cascade.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import config from '../src/orchestrator/infra/config.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import {
  cascadeComplete,
  getMilestoneStatus,
  getMissionStatus,
  getSubMissionStatus,
} from '../src/orchestrator/core/state-machine.js';

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

// ── Fixture helpers (state-machine pattern, reused from test-state-machine.js) ──

function createHarnessDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-cascade-test-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'verification'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeGlobalState(harnessDir, milestones) {
  const state = {
    projectMeta: {
      prdPath: '',
      createdAt: new Date().toISOString(),
      currentPhase: 'executing',
    },
    globalStatus: 'active',
    milestones,
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));
}

function writeMissionState(harnessDir, missionId, state) {
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify(state, null, 2)
  );
}

/**
 * Single-mission, single-sub-mission, single-task fixture.
 */
function simpleFixture(harnessDir, { taskStatus = 'pending', subMissionStatus = 'pending', missionStatus = 'in_progress' } = {}) {
  writeGlobalState(harnessDir, {
    '001': {
      id: '001',
      status: 'in_progress',
      missions: {
        '001-001': {
          id: '001-001',
          status: missionStatus,
          stateFile: '.harness/state/mission-001-001.json',
        },
      },
    },
  });
  writeMissionState(harnessDir, '001-001', {
    id: '001-001',
    missionId: '001-001',
    description: 'test mission',
    status: missionStatus,
    subMissions: {
      '001-001-001': {
        id: '001-001-001',
        description: 'test sub-mission',
        status: subMissionStatus,
        tasks: {
          '001-001-001-001': {
            id: '001-001-001-001',
            description: 'test task',
            status: taskStatus,
            retryCount: 0,
          },
        },
      },
    },
  });
}

// ── Fixture helpers (pipeline pattern, reused from test-scheduler-resume.js) ──

/**
 * Create a temp project root with a .harness subdirectory and the given mission
 * layout. preStatus is a map of taskId/missionId/etc → status seed values.
 */
function createResumeHarness({ milestoneId = '001', missions, preStatus = {} }) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-cascade-pipe-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const missionEntries = {};
  for (const mission of missions) {
    missionEntries[mission.id] = {
      id: mission.id,
      description: `mission ${mission.id}`,
      status: preStatus[mission.id] || 'pending',
      stateFile: `.harness/state/mission-${mission.id}.json`,
      planFile: `.harness/plan/mission-${mission.id}.md`,
    };

    const tasks = {};
    for (const task of mission.tasks) {
      const taskStatus = preStatus[task.id] || 'pending';
      tasks[task.id] = {
        id: task.id,
        description: task.description || `task ${task.id}`,
        status: taskStatus,
        createdAt: new Date().toISOString(),
        startedAt: taskStatus !== 'pending' ? new Date().toISOString() : null,
        completedAt: (taskStatus === 'complete' || taskStatus === 'invalidated') ? new Date().toISOString() : null,
        targetFiles: task.targetFiles || [],
        dependencies: task.dependencies || [],
        testCases: [],
        tracesScenario: [],
        patternReferences: [],
        dataSchemas: [],
        verifyFile: `.harness/verify/task-${task.id}.json`,
        progressFile: `.harness/progress/task-${task.id}.json`,
        verificationFile: `.harness/verification/task-${task.id}.json`,
        retryCount: 0,
      };

      // Source files for snapshot support
      for (const f of task.targetFiles || []) {
        const full = path.join(projectRoot, f);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (!fs.existsSync(full)) fs.writeFileSync(full, `// ${f}\n`);
      }

      // verify.json stub
      fs.writeFileSync(
        path.join(harnessDir, 'verify', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, targetFiles: task.targetFiles || [], hardChecks: [], testCases: [] })
      );

      // Pre-seeded verification sidecar for complete/verified tasks.
      // result:'PASSED' mirrors a real verified sidecar — the Phase-5 audit
      // reads parsed.result === 'PASSED' for every complete task.
      if (taskStatus === 'verified' || taskStatus === 'complete') {
        fs.writeFileSync(
          path.join(harnessDir, 'verification', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', report: 'pre-seeded' })
        );
      }
    }

    const subMissionId = `${mission.id}-001`;
    const missionState = {
      id: mission.id,
      missionId: mission.id,
      description: `mission ${mission.id}`,
      status: preStatus[`mission:${mission.id}`] || 'pending',
      subMissions: {
        [subMissionId]: {
          id: subMissionId,
          description: 'sm',
          status: preStatus[`sm:${subMissionId}`] || 'pending',
          tasks,
        },
      },
    };
    fs.writeFileSync(
      path.join(harnessDir, 'state', `mission-${mission.id}.json`),
      JSON.stringify(missionState, null, 2)
    );
  }

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
        status: preStatus[`ms:${milestoneId}`] || 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: missionEntries,
      },
    },
  };

  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  return { projectRoot, harnessDir };
}

function makePipeline(projectRoot, { maxConcurrent = 3 } = {}) {
  const origMax = config.execution.maxConcurrentSessions;
  config.execution.maxConcurrentSessions = maxConcurrent;

  const pipeline = new Pipeline(projectRoot, {
    onLog: () => {},
    onConfirm: async () => true,
  });
  pipeline._missionRegression = async () => {};  // stub out mission regression

  const restore = () => {
    config.execution.maxConcurrentSessions = origMax;
  };

  return { pipeline, restore };
}

function installFakes(pipeline, { failTaskIds = new Set(), delay = 5 } = {}) {
  const trace = {
    executorCalls: [],
    verifierCalls: [],
  };

  pipeline.executor = {
    executeTask: async (task, _projectRoot, _opts) => {
      trace.executorCalls.push(task.id);
      if (failTaskIds.has(task.id)) {
        fs.writeFileSync(
          path.join(pipeline.harnessDir, 'progress', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, status: 'BLOCKED', affectedFiles: [], blockers: ['fail'] })
        );
        return { status: 'BLOCKED', affectedFiles: [], blockers: ['fail'] };
      }
      await new Promise((r) => setTimeout(r, delay));
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'progress', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, status: 'COMPLETE', affectedFiles: task.targetFiles || [] })
      );
      return { status: 'COMPLETE', affectedFiles: task.targetFiles || [] };
    },
  };

  pipeline.verifier = {
    verifyTask: async (task, _projectRoot, _opts) => {
      trace.verifierCalls.push(task.id);
      // result:'PASSED' mirrors a real verifier — the Phase-5 audit reads
      // parsed.result === 'PASSED' for every complete task.
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'verification', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', report: 'fake' })
      );
      return { verified: true, report: 'fake', structured: { verified: true, report: 'fake' } };
    },
    verifyRegression: async (task, _projectRoot, _opts) => {
      trace.verifierCalls.push(task.id);
      // result:'PASSED' mirrors a real verifier — the Phase-5 audit reads
      // parsed.result === 'PASSED' for every complete task.
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'verification', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', report: 'fake' })
      );
      return { verified: true, report: 'fake', structured: { verified: true, report: 'fake' } };
    },
  };

  pipeline.analyzer = {
    analyzeFailure: async () => ({ eventId: 'fake', recommendation: 'human', affectedTasks: [] }),
  };

  return trace;
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {

// ── Test 1: cascadeComplete returns milestone:'skipped' always ───────────────

await test('1. cascadeComplete: milestone is always skipped even when all missions terminal', async () => {
  const dir = createHarnessDir();
  try {
    // Single-mission fixture with all tasks complete — the cascade can
    // complete the sub-mission and mission, but milestone must be skipped
    // because milestone completion is exclusively handled by Phase 5.
    simpleFixture(dir, {
      taskStatus: 'complete',
      subMissionStatus: 'in_progress',
      missionStatus: 'in_progress',
    });

    const result = await cascadeComplete(dir, { missionId: '001-001', subMissionId: '001-001-001' });

    assert.strictEqual(result.milestone, 'skipped',
      'cascadeComplete must always return milestone:skipped');
    assert.strictEqual(getMilestoneStatus(dir, '001'), 'in_progress',
      'milestone should stay in_progress (not cascaded to complete)');

    // Sub-mission and mission should cascade normally
    assert.strictEqual(result.subMission, 'cascaded');
    assert.strictEqual(result.mission, 'cascaded');
    assert.strictEqual(getMissionStatus(dir, '001-001'), 'complete');
    assert.strictEqual(getSubMissionStatus(dir, '001-001', '001-001-001'), 'complete');
  } finally { cleanup(dir); }
});

// ── Test 2: Pipeline Phase 5 calls transitionMilestone after regression passes ──

await test('2. pipeline Phase 5 calls transitionMilestone unconditionally after regression passes', async () => {
  // All missions already complete → _executeMilestoneParallel exits early.
  // Reviewer is skipped. Regression check (fake verifier) passes.
  // Phase 5 must call transitionMilestone → milestone becomes 'complete'.
  const missions = [{
    id: '001-001',
    tasks: [
      { id: '001-001-001-001', targetFiles: ['src/a.js'] },
    ],
  }];
  const preStatus = {
    '001-001-001-001': 'complete',   // task already done
    '001-001': 'complete',           // mission entry in global state
    'mission:001-001': 'complete',   // mission state file
    'sm:001-001-001': 'complete',    // sub-mission in mission state
    'ms:001': 'in_progress',         // milestone is in_progress (awaiting Phase 5)
  };
  const { projectRoot, harnessDir } = createResumeHarness({ missions, preStatus });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    installFakes(pipeline);
    pipeline.skipReview = true;  // bypass reviewer gate — regression is the focus

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState.milestones['001']);

    const finalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    assert.strictEqual(finalState.milestones['001'].status, 'complete',
      'milestone should be complete after Phase 5 runs transitionMilestone');
  } finally { restore(); cleanup(projectRoot); }
});

// ── Test 3: Resume re-enters _executeMilestone after regression failure ───────

await test('3. resume re-enters _executeMilestone for in_progress milestone after regression failure', async () => {
  // Simulates: first run crashes during milestone regression (verifier returns
  // FAIL → pipeline throws in non-TTY mode). On resume, regression passes and
  // Phase 5 completes the milestone.
  const missions = [{
    id: '001-001',
    tasks: [
      { id: '001-001-001-001', targetFiles: ['src/a.js'] },
    ],
  }];
  const preStatus = {
    '001-001-001-001': 'complete',
    '001-001': 'complete',
    'mission:001-001': 'complete',
    'sm:001-001-001': 'complete',
    'ms:001': 'in_progress',
  };
  const { projectRoot, harnessDir } = createResumeHarness({ missions, preStatus });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    installFakes(pipeline);
    pipeline.skipReview = true;
    // Override the default mock onConfirm (returns true) so the regression-failed
    // gate sees a "user declined" answer, hitting the throw path. Pre-§247 the
    // throw came from a per-site TTY guard; post-§247 the gate delegates to
    // onConfirm and the test must answer "no" to exercise the same behaviour.
    pipeline.onConfirm = async () => false;

    // Override verifier: fail on first call, pass on subsequent calls.
    let regressionCallCount = 0;
    const baseVerifyTask = pipeline.verifier.verifyRegression.bind(pipeline.verifier);
    pipeline.verifier = {
      verifyRegression: async (task, projectRoot_, opts) => {
        regressionCallCount++;
        if (regressionCallCount === 1) {
          // Write regression report to satisfy the pipeline's fs.writeFileSync call
          const reportPath = path.join(pipeline.harnessDir, 'verification', `regression-milestone-001.md`);
          fs.mkdirSync(path.dirname(reportPath), { recursive: true });
          fs.writeFileSync(reportPath, '# Regression FAILED\n');
          return { verified: false, report: 'FAILED — first call', structured: { verified: false } };
        }
        return baseVerifyTask(task, projectRoot_, opts);
      },
    };

    // First pass: regression fails → pipeline throws (non-TTY path)
    let err1 = null;
    try {
      const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
      await pipeline._executeMilestone('001', globalState.milestones['001']);
    } catch (e) { err1 = e; }
    assert.ok(err1, 'first _executeMilestone should throw when regression fails');
    assert.ok(/regression failed/i.test(err1.message),
      `expected regression error, got: ${err1.message}`);

    // Milestone should still be in_progress — not promoted to complete
    const midState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    assert.strictEqual(midState.milestones['001'].status, 'in_progress',
      'milestone must stay in_progress after regression failure');

    // Second pass (resume): regression passes → Phase 5 → milestone complete
    const globalState2 = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState2.milestones['001']);

    const finalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    assert.strictEqual(finalState.milestones['001'].status, 'complete',
      'milestone should be complete after resume with passing regression');
  } finally { restore(); cleanup(projectRoot); }
});

// ── Test 4: Resume re-enters _executeMilestone after reviewer failure ─────────

await test('4. resume re-enters _executeMilestone for in_progress milestone after reviewer failure', async () => {
  // Simulates: reviewer gate fails on first run → analyzer recommends 'human'
  // → pipeline throws. On resume the reviewer passes → regression passes
  // → Phase 5 completes the milestone.
  const missions = [{
    id: '001-001',
    tasks: [
      { id: '001-001-001-001', targetFiles: ['src/a.js'] },
    ],
  }];
  const preStatus = {
    '001-001-001-001': 'complete',
    '001-001': 'complete',
    'mission:001-001': 'complete',
    'sm:001-001-001': 'complete',
    'ms:001': 'in_progress',
  };
  const { projectRoot, harnessDir } = createResumeHarness({ missions, preStatus });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    installFakes(pipeline);
    // Do NOT set pipeline.skipReview — reviewer gate must run

    // Stub reviewer: fail on first call (critical finding), pass on second
    let reviewCallCount = 0;
    pipeline.reviewer = {
      reviewMilestone: async (_msId, _modifiedFiles, _taskDescriptions, _importGraph, _projectRoot, _harnessDir) => {
        reviewCallCount++;
        if (reviewCallCount === 1) {
          return {
            passed: false,
            findings: [{ severity: 'critical', file: 'a.js', description: 'test critical finding' }],
          };
        }
        return { passed: true, findings: [] };
      },
    };

    // First pass: reviewer fails → analyzer returns 'human' → throws
    let err1 = null;
    try {
      const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
      await pipeline._executeMilestone('001', globalState.milestones['001']);
    } catch (e) { err1 = e; }
    assert.ok(err1, 'first _executeMilestone should throw when reviewer fails');
    assert.ok(/reviewer gate failed/i.test(err1.message),
      `expected reviewer gate error, got: ${err1.message}`);

    // Milestone should still be in_progress
    const midState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    assert.strictEqual(midState.milestones['001'].status, 'in_progress',
      'milestone must stay in_progress after reviewer failure');

    // Second pass (resume): reviewer passes → regression passes → Phase 5 → complete
    const globalState2 = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState2.milestones['001']);

    const finalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    assert.strictEqual(finalState.milestones['001'].status, 'complete',
      'milestone should be complete after resume with passing reviewer');
  } finally { restore(); cleanup(projectRoot); }
});

// ── Test 5: task→sub-mission→mission cascade is unbroken ─────────────────────

await test('5. task→sub-mission→mission cascade is unbroken while milestone stays skipped', async () => {
  // Multi-task fixture: 2 tasks in 1 sub-mission in 1 mission, all complete.
  // cascadeComplete should cascade sub-mission→mission correctly, and
  // milestone should remain 'skipped' (not cascaded).
  const dir = createHarnessDir();
  try {
    writeGlobalState(dir, {
      '001': {
        id: '001',
        status: 'in_progress',
        missions: {
          '001-001': {
            id: '001-001',
            status: 'in_progress',
            stateFile: '.harness/state/mission-001-001.json',
          },
        },
      },
    });
    writeMissionState(dir, '001-001', {
      id: '001-001',
      missionId: '001-001',
      description: 'multi-task mission',
      status: 'in_progress',
      subMissions: {
        '001-001-001': {
          id: '001-001-001',
          description: 'multi-task sub-mission',
          status: 'in_progress',
          tasks: {
            '001-001-001-001': { id: '001-001-001-001', description: 'task 1', status: 'complete', retryCount: 0 },
            '001-001-001-002': { id: '001-001-001-002', description: 'task 2', status: 'complete', retryCount: 0 },
          },
        },
      },
    });

    const result = await cascadeComplete(dir, { missionId: '001-001', subMissionId: '001-001-001' });

    // Sub-mission and mission should cascade correctly
    assert.strictEqual(result.subMission, 'cascaded',
      'sub-mission should cascade to complete');
    assert.strictEqual(result.mission, 'cascaded',
      'mission should cascade to complete when all sub-missions terminal');
    assert.strictEqual(result.milestone, 'skipped',
      'milestone must always be skipped by cascadeComplete');

    assert.strictEqual(getSubMissionStatus(dir, '001-001', '001-001-001'), 'complete');
    assert.strictEqual(getMissionStatus(dir, '001-001'), 'complete');
    assert.strictEqual(getMilestoneStatus(dir, '001'), 'in_progress',
      'milestone stays in_progress — Phase 5 is responsible for milestone completion');
  } finally { cleanup(dir); }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
