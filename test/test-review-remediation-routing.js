/**
 * test-review-remediation-routing.js — Integration tests for per-mission
 * review-remediation routing in Pipeline._executeMilestone().
 *
 * When the reviewer gate fails, criticalFindings are grouped by the missionId
 * that owns each finding's file (via buildFileToMissionMap). Each mission group
 * then triggers a separate planner.remediateReviewFindings call and a separate
 * mergeRemediationTasks call. This file verifies correct routing across all
 * branching paths.
 *
 * Fixtures are built using writeMissionState (ARCHITECTURE.md Rule 6).
 *
 * Covers:
 *   TC1 — single-mission milestone: all findings route to that mission (backward compat)
 *   TC2 — two missions with findings on different files: remediateReviewFindings
 *          called once per mission with correct findings subset
 *   TC3 — ambiguous ownership: file in targetFiles of two missions triggers
 *          console.warn and picks sort()[0] tiebreaker
 *   TC4 — finding.file not in any mission targetFiles: routes via sort()[0] fallback
 *   TC5 — empty criticalFindings (reviewer passes): no remediation calls, short-circuit preserved
 *   TC6 — subMissionId fallback: mergeRemediationTasks with a task whose
 *          subMissionId doesn't exist in state triggers onLog warning with
 *          task.id, missionId, and fallback subMissionId
 *
 * Run: node test/test-review-remediation-routing.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeMissionState } from '../src/orchestrator/core/state.js';
import { mergeRemediationTasks } from '../src/orchestrator/gates/coverage.js';
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

// ── Shared harness directories ────────────────────────────────────────

function makeHarnessDir(prefix) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const harnessDir = path.join(projectRoot, '.harness');
  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  return { projectRoot, harnessDir };
}

// ── Fixture helpers ──────────────────────────────────────────────────

/**
 * Write progress / verification / verify sidecars for a single pre-completed task.
 */
function writeSidecars(harnessDir, taskId, targetFiles) {
  fs.writeFileSync(
    path.join(harnessDir, 'progress', `task-${taskId}.json`),
    JSON.stringify({
      taskId,
      status: 'COMPLETE',
      affectedFiles: targetFiles.map(f => ({ path: f })),
      summary: 'task completed',
      testsSummary: 'all tests passed',
    })
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-${taskId}.json`),
    JSON.stringify({
      taskId,
      verified: true,
      report: 'fake verifier report',
      result: 'PASSED',
      hardChecks: [],
      taskScopeChecks: [],
      notes: null,
    })
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles, hardChecks: [], testCases: [] })
  );
}

/**
 * Patch a mission state file written by writeMissionState (which sets status
 * 'pending') to 'complete' so the pipeline skips past task execution.
 */
function markMissionComplete(harnessDir, missionId) {
  const statePath = path.join(harnessDir, 'state', `mission-${missionId}.json`);
  const mState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  mState.status = 'complete';
  for (const sm of Object.values(mState.subMissions)) {
    sm.status = 'complete';
    for (const task of Object.values(sm.tasks || {})) {
      task.status = 'complete';
      task.startedAt = task.startedAt ?? new Date().toISOString();
      task.completedAt = task.completedAt ?? new Date().toISOString();
    }
  }
  fs.writeFileSync(statePath, JSON.stringify(mState, null, 2));
}

/**
 * Write the global state.json with a single milestone containing the given
 * missions (each marked 'complete').
 */
function writeGlobalState(harnessDir, milestoneId, missionEntries) {
  const missions = {};
  for (const { missionId } of missionEntries) {
    missions[missionId] = {
      id: missionId,
      description: `mission ${missionId}`,
      status: 'complete',
      stateFile: `.harness/state/mission-${missionId}.json`,
      planFile: `.harness/plan/mission-${missionId}.md`,
    };
  }
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones: {
        [milestoneId]: {
          id: milestoneId,
          description: `milestone ${milestoneId}`,
          status: 'in_progress',
          planFile: `.harness/plan/milestone-${milestoneId}.md`,
          missions,
        },
      },
    }, null, 2)
  );
}

/**
 * Create a temp project root with a .harness subdirectory, a single mission
 * owning src/foo.js, and global state.json with that mission complete.
 *
 * Fixtures are built using writeMissionState (ARCHITECTURE.md Rule 6).
 */
function createSingleMissionHarness({ milestoneId = '001', missionId = '001-001' } = {}) {
  const { projectRoot, harnessDir } = makeHarnessDir('review-rem-routing-single-');

  const subMissionId = `${missionId}-001`;
  const taskId = `${missionId}-001-001`;

  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'foo.js'), '// foo.js\n');

  // Rule 6: use writeMissionState to create the fixture
  writeMissionState(harnessDir, missionId, `mission ${missionId}`, {
    subMissions: [{
      id: subMissionId,
      description: 'sub-mission',
      tasks: [{
        id: taskId,
        description: `task ${taskId}`,
        targetFiles: ['src/foo.js'],
        dependencies: [],
        testCases: [],
        tracesScenario: [],
        patternReferences: [],
        dataSchemas: [],
      }],
    }],
  });

  markMissionComplete(harnessDir, missionId);
  writeSidecars(harnessDir, taskId, ['src/foo.js']);
  writeGlobalState(harnessDir, milestoneId, [{ missionId }]);

  return { projectRoot, harnessDir, milestoneId, missionId, subMissionId, taskId };
}

/**
 * Create a temp project root with two missions owning different files:
 *   Mission A (001-001): owns src/foo.js
 *   Mission B (001-002): owns src/bar.js
 *
 * Fixtures are built using writeMissionState (ARCHITECTURE.md Rule 6).
 */
function createTwoMissionHarness({ milestoneId = '001' } = {}) {
  const { projectRoot, harnessDir } = makeHarnessDir('review-rem-routing-two-');

  const missionAId    = '001-001';
  const missionBId    = '001-002';
  const subMissionAId = '001-001-001';
  const subMissionBId = '001-002-001';
  const taskAId       = '001-001-001-001';
  const taskBId       = '001-002-001-001';

  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'foo.js'), '// foo.js\n');
  fs.writeFileSync(path.join(projectRoot, 'src', 'bar.js'), '// bar.js\n');

  // Rule 6: use writeMissionState for both mission fixtures
  writeMissionState(harnessDir, missionAId, `mission ${missionAId}`, {
    subMissions: [{
      id: subMissionAId,
      description: 'sub-mission A',
      tasks: [{
        id: taskAId,
        description: `task ${taskAId}`,
        targetFiles: ['src/foo.js'],
        dependencies: [], testCases: [], tracesScenario: [], patternReferences: [], dataSchemas: [],
      }],
    }],
  });

  writeMissionState(harnessDir, missionBId, `mission ${missionBId}`, {
    subMissions: [{
      id: subMissionBId,
      description: 'sub-mission B',
      tasks: [{
        id: taskBId,
        description: `task ${taskBId}`,
        targetFiles: ['src/bar.js'],
        dependencies: [], testCases: [], tracesScenario: [], patternReferences: [], dataSchemas: [],
      }],
    }],
  });

  markMissionComplete(harnessDir, missionAId);
  markMissionComplete(harnessDir, missionBId);
  writeSidecars(harnessDir, taskAId, ['src/foo.js']);
  writeSidecars(harnessDir, taskBId, ['src/bar.js']);
  writeGlobalState(harnessDir, milestoneId, [{ missionId: missionAId }, { missionId: missionBId }]);

  return {
    projectRoot, harnessDir, milestoneId,
    missionAId, missionBId,
    subMissionAId, subMissionBId,
    taskAId, taskBId,
  };
}

/**
 * Create a temp project root where BOTH missions claim src/shared.js in their
 * targetFiles — to exercise the ambiguous ownership path in buildFileToMissionMap.
 *
 * Fixtures are built using writeMissionState (ARCHITECTURE.md Rule 6).
 */
function createAmbiguousHarness({ milestoneId = '001' } = {}) {
  const { projectRoot, harnessDir } = makeHarnessDir('review-rem-routing-ambiguous-');

  const missionAId    = '001-001';
  const missionBId    = '001-002';
  const subMissionAId = '001-001-001';
  const subMissionBId = '001-002-001';
  const taskAId       = '001-001-001-001';
  const taskBId       = '001-002-001-001';

  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'shared.js'), '// shared.js\n');

  // Both missions claim src/shared.js — triggers ambiguous ownership warning
  // Rule 6: use writeMissionState for both mission fixtures
  writeMissionState(harnessDir, missionAId, `mission ${missionAId}`, {
    subMissions: [{
      id: subMissionAId,
      description: 'sub-mission A',
      tasks: [{
        id: taskAId,
        description: `task ${taskAId}`,
        targetFiles: ['src/shared.js'],
        dependencies: [], testCases: [], tracesScenario: [], patternReferences: [], dataSchemas: [],
      }],
    }],
  });

  writeMissionState(harnessDir, missionBId, `mission ${missionBId}`, {
    subMissions: [{
      id: subMissionBId,
      description: 'sub-mission B',
      tasks: [{
        id: taskBId,
        description: `task ${taskBId}`,
        targetFiles: ['src/shared.js'],
        dependencies: [], testCases: [], tracesScenario: [], patternReferences: [], dataSchemas: [],
      }],
    }],
  });

  markMissionComplete(harnessDir, missionAId);
  markMissionComplete(harnessDir, missionBId);
  writeSidecars(harnessDir, taskAId, ['src/shared.js']);
  writeSidecars(harnessDir, taskBId, ['src/shared.js']);
  writeGlobalState(harnessDir, milestoneId, [{ missionId: missionAId }, { missionId: missionBId }]);

  return {
    projectRoot, harnessDir, milestoneId,
    missionAId, missionBId,
    subMissionAId, subMissionBId,
    taskAId, taskBId,
  };
}

function cleanup(projectRoot) {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * Instantiate a Pipeline. Missions are pre-completed in the fixtures, so the
 * scheduler path (_executeMilestoneParallel) short-circuits with no approved
 * missions and control reaches the shared reviewer-gate / review-remediation
 * routing section without real dispatch.
 * Returns { pipeline, logs }.
 */
function makePipeline(projectRoot, extraOpts = {}) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    ...extraOpts,
  });

  return { pipeline, logs };
}

/**
 * Install base mocks on a pipeline instance.
 *
 * The reviewer mock returns reviewerResultFirst on the first call and
 * reviewerResultSecond (or reviewerResultFirst if not provided) on subsequent calls.
 * The analyzer mock returns recommendation: analyzerRecommendation (default 'retry').
 * _executeAndVerifyTask is replaced with a no-op to prevent real task execution.
 * The caller is responsible for installing pipeline.planner.
 *
 * Returns a trace object tracking analyzeFailureCalls and reviewerCallCount.
 */
function installBaseMocks(pipeline, {
  reviewerResultFirst,
  reviewerResultSecond,
  analyzerRecommendation = 'retry',
} = {}) {
  const trace = {
    analyzeFailureCalls: 0,
    reviewerCallCount: 0,
  };

  pipeline.executor = {
    executeTask: async (task) => ({
      status: 'COMPLETE',
      affectedFiles: task.targetFiles || [],
    }),
  };

  pipeline.verifier = {
    verifyTask: async () => ({
      verified: true,
      report: 'mock regression verifier',
      structured: { verified: true },
    }),
  };
  // verifyRegression: the regression gates now call the dedicated method;
  // the mock reuses the same implementation (same id-sniff branches apply).
  pipeline.verifier.verifyRegression = pipeline.verifier.verifyTask;

  pipeline.analyzer = {
    analyzeFailure: async () => {
      trace.analyzeFailureCalls++;
      return {
        eventId: 'mock-event-001',
        recommendation: analyzerRecommendation,
        affectedTasks: [],
      };
    },
  };

  pipeline.reviewer = {
    reviewMilestone: async () => {
      trace.reviewerCallCount++;
      if (trace.reviewerCallCount === 1) return reviewerResultFirst;
      return reviewerResultSecond ?? reviewerResultFirst;
    },
  };

  pipeline._collectMilestoneContext = () => ({
    modifiedFiles: [],
    taskDescriptions: [],
    importGraph: '',
  });

  // _executeMilestone now calls assertNoNonTerminalTasks before advancing
  // (commit 0466cf0), so a pure no-op leaves merged remediation tasks at
  // 'pending' and blocks advancement. Mark the executed task terminal in its
  // mission state file to model successful execution.
  pipeline._executeAndVerifyTask = async (missionId, subMissionId, task) => {
    const statePath = path.join(pipeline.harnessDir, 'state', `mission-${missionId}.json`);
    const mState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const t = mState.subMissions[subMissionId]?.tasks?.[task.id];
    if (t) {
      t.status = 'complete';
      fs.writeFileSync(statePath, JSON.stringify(mState, null, 2));
      // Production reality: a real _executeAndVerifyTask runs the verifier, which
      // writes a PASSED verification sidecar before the task reaches 'complete'.
      // Seed one for the freshly-completed remediation fix task so the Phase-5
      // audit does not throw VerificationAuditError on it.
      seedPassedSidecars(pipeline.harnessDir, mState);
    }
  };

  return trace;
}

// ── Tests ────────────────────────────────────────────────────────────

async function run() {

await test('TC1: single-mission milestone → all findings route to that mission (backward compatible)', async () => {
  const {
    projectRoot, harnessDir, milestoneId, missionId, subMissionId,
  } = createSingleMissionHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    const finding1 = {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/foo.js',
      description: 'issue A in foo',
      relatedFiles: [],
    };
    const finding2 = {
      severity: 'critical',
      category: 'integration',
      file: 'src/foo.js',
      description: 'issue B in foo',
      relatedFiles: [],
    };

    const failedResult = {
      passed: false,
      findings: [finding1, finding2],
      structured: { result: 'FAILED', findings: [finding1, finding2], notes: '' },
      reportPath: '',
    };
    const passedResult = {
      passed: true,
      findings: [],
      structured: { result: 'PASSED', findings: [], notes: '' },
      reportPath: '',
    };

    const remediateCalls = [];

    installBaseMocks(pipeline, {
      reviewerResultFirst: failedResult,
      reviewerResultSecond: passedResult,
    });

    pipeline.planner = {
      remediateReviewFindings: async (_msId, findings) => {
        remediateCalls.push({ findings: [...findings] });
        return {
          newTasks: [{
            id: '001-001-001-099',
            subMissionId,
            description: 'fix all findings in single mission',
            targetFiles: ['src/foo.js'],
          }],
        };
      },
    };

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    await pipeline._executeMilestone(milestoneId, msState);

    assert.strictEqual(
      remediateCalls.length,
      1,
      `Expected remediateReviewFindings called once (single mission); got ${remediateCalls.length}`
    );

    assert.strictEqual(
      remediateCalls[0].findings.length,
      2,
      `Expected both findings routed to single mission; got ${remediateCalls[0].findings.length}`
    );

    assert.ok(
      remediateCalls[0].findings.some(f => f.description === 'issue A in foo'),
      'Expected finding A included in single-mission remediation call'
    );
    assert.ok(
      remediateCalls[0].findings.some(f => f.description === 'issue B in foo'),
      'Expected finding B included in single-mission remediation call'
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC2: multi-mission milestone → findings split by file ownership, remediateReviewFindings called once per mission', async () => {
  const {
    projectRoot, harnessDir, milestoneId,
    missionAId, missionBId,
    subMissionAId, subMissionBId,
  } = createTwoMissionHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    const findingA = {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/foo.js',
      description: 'issue in foo owned by mission A',
      relatedFiles: [],
    };
    const findingB = {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/bar.js',
      description: 'issue in bar owned by mission B',
      relatedFiles: [],
    };

    const failedResult = {
      passed: false,
      findings: [findingA, findingB],
      structured: { result: 'FAILED', findings: [findingA, findingB], notes: '' },
      reportPath: '',
    };
    const passedResult = {
      passed: true,
      findings: [],
      structured: { result: 'PASSED', findings: [], notes: '' },
      reportPath: '',
    };

    // Track each remediateReviewFindings call: which mission (inferred from finding file)
    // and which findings were passed.
    const remediateCalls = [];

    installBaseMocks(pipeline, {
      reviewerResultFirst: failedResult,
      reviewerResultSecond: passedResult,
    });

    pipeline.planner = {
      remediateReviewFindings: async (_msId, findings) => {
        const inferredMissionId = findings[0].file === 'src/foo.js' ? missionAId : missionBId;
        remediateCalls.push({ inferredMissionId, findings: [...findings] });

        const subMissionId = inferredMissionId === missionAId ? subMissionAId : subMissionBId;
        const fixTaskId    = inferredMissionId === missionAId ? '001-001-001-099' : '001-002-001-099';
        return {
          newTasks: [{
            id: fixTaskId,
            subMissionId,
            description: `fix finding in ${inferredMissionId}`,
            targetFiles: findings.map(f => f.file),
          }],
        };
      },
    };

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    await pipeline._executeMilestone(milestoneId, msState);

    assert.strictEqual(
      remediateCalls.length,
      2,
      `Expected remediateReviewFindings called twice (once per mission); got ${remediateCalls.length}`
    );

    const callForA = remediateCalls.find(c => c.inferredMissionId === missionAId);
    const callForB = remediateCalls.find(c => c.inferredMissionId === missionBId);

    assert.ok(callForA, `Expected a remediateReviewFindings call routed to mission ${missionAId}`);
    assert.ok(callForB, `Expected a remediateReviewFindings call routed to mission ${missionBId}`);

    assert.strictEqual(
      callForA.findings.length, 1,
      `Expected exactly 1 finding routed to mission A; got ${callForA.findings.length}`
    );
    assert.strictEqual(
      callForA.findings[0].file, 'src/foo.js',
      `Expected foo.js finding routed to mission A; got ${callForA.findings[0].file}`
    );

    assert.strictEqual(
      callForB.findings.length, 1,
      `Expected exactly 1 finding routed to mission B; got ${callForB.findings.length}`
    );
    assert.strictEqual(
      callForB.findings[0].file, 'src/bar.js',
      `Expected bar.js finding routed to mission B; got ${callForB.findings[0].file}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC3: ambiguous ownership — file in 2 missions triggers console.warn, routes to sort()[0] mission', async () => {
  const {
    projectRoot, harnessDir, milestoneId,
    missionAId, missionBId,
    subMissionAId,
  } = createAmbiguousHarness();
  const { pipeline } = makePipeline(projectRoot);

  // Capture console.warn to verify the ambiguous-ownership warning is emitted.
  const consoleWarns = [];
  const origWarn = console.warn;
  console.warn = (...args) => consoleWarns.push(args.join(' '));

  try {
    const ambiguousFinding = {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/shared.js',
      description: 'issue in shared.js — claimed by both missions',
      relatedFiles: [],
    };

    const failedResult = {
      passed: false,
      findings: [ambiguousFinding],
      structured: { result: 'FAILED', findings: [ambiguousFinding], notes: '' },
      reportPath: '',
    };
    const passedResult = {
      passed: true,
      findings: [],
      structured: { result: 'PASSED', findings: [], notes: '' },
      reportPath: '',
    };

    const remediateCalls = [];

    installBaseMocks(pipeline, {
      reviewerResultFirst: failedResult,
      reviewerResultSecond: passedResult,
    });

    pipeline.planner = {
      remediateReviewFindings: async (_msId, findings) => {
        remediateCalls.push({ findings: [...findings] });
        // Fallback routes to sort(['001-001','001-002'])[0] = '001-001' (missionAId).
        return {
          newTasks: [{
            id: '001-001-001-099',
            subMissionId: subMissionAId,
            description: 'fix ambiguous-file finding via sort()[0] mission',
            targetFiles: ['src/shared.js'],
          }],
        };
      },
    };

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    await pipeline._executeMilestone(milestoneId, msState);

    // Exactly one remediation call — ambiguous file resolves to a single mission via sort()[0].
    assert.strictEqual(
      remediateCalls.length,
      1,
      `Expected remediateReviewFindings called once (ambiguous → sort()[0]); got ${remediateCalls.length}`
    );

    assert.strictEqual(
      remediateCalls[0].findings[0].file,
      'src/shared.js',
      `Expected the ambiguous finding in the remediation call`
    );

    // buildFileToMissionMap must have emitted a console.warn about multiple missions claiming src/shared.js.
    const warnMsg = consoleWarns.join('\n');
    assert.ok(
      consoleWarns.some(w => w.includes('src/shared.js') && (w.includes('multiple') || w.includes(missionAId))),
      `Expected console.warn about ambiguous ownership of src/shared.js. Got warnings:\n${warnMsg}`
    );

    // sort(['001-001', '001-002'])[0] = '001-001' (missionAId) — verify the fix task
    // was merged into missionA (the tiebreaker mission).
    const missionAState = JSON.parse(
      fs.readFileSync(path.join(harnessDir, 'state', `mission-${missionAId}.json`), 'utf8')
    );
    const missionATaskIds = Object.values(missionAState.subMissions)
      .flatMap(sm => Object.keys(sm.tasks));

    assert.ok(
      missionATaskIds.some(id => id.startsWith('001-001-001-')),
      `Expected fix task merged into mission ${missionAId} (sort()[0] tiebreaker); found: ${missionATaskIds.join(', ')}`
    );

    // Mission B should be untouched — ambiguous file routed to A only.
    const missionBState = JSON.parse(
      fs.readFileSync(path.join(harnessDir, 'state', `mission-${missionBId}.json`), 'utf8')
    );
    const missionBTaskIds = Object.values(missionBState.subMissions)
      .flatMap(sm => Object.keys(sm.tasks));

    assert.strictEqual(
      missionBTaskIds.length,
      1,
      `Expected mission ${missionBId} to remain unchanged (1 task); got ${missionBTaskIds.length} tasks: ${missionBTaskIds.join(', ')}`
    );
  } finally {
    console.warn = origWarn;
    cleanup(projectRoot);
  }
});

await test('TC4: unowned file fallback — finding.file not in any mission targetFiles triggers warning, routes to sort()[0]', async () => {
  const {
    projectRoot, harnessDir, milestoneId,
    missionAId, missionBId,
    subMissionAId,
  } = createTwoMissionHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    // This file is not owned by any mission (neither src/foo.js nor src/bar.js).
    const unownedFinding = {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/unknown.js',
      description: 'issue in file not owned by any mission',
      relatedFiles: [],
    };

    const failedResult = {
      passed: false,
      findings: [unownedFinding],
      structured: { result: 'FAILED', findings: [unownedFinding], notes: '' },
      reportPath: '',
    };
    const passedResult = {
      passed: true,
      findings: [],
      structured: { result: 'PASSED', findings: [], notes: '' },
      reportPath: '',
    };

    const remediateCalls = [];

    installBaseMocks(pipeline, {
      reviewerResultFirst: failedResult,
      reviewerResultSecond: passedResult,
    });

    pipeline.planner = {
      remediateReviewFindings: async (_msId, findings) => {
        remediateCalls.push({ findings: [...findings] });
        // Fallback routes to sort(['001-001','001-002'])[0] = '001-001' (missionAId).
        // Return a task that fits into missionA's sub-mission.
        return {
          newTasks: [{
            id: '001-001-001-099',
            subMissionId: subMissionAId,
            description: 'fix unowned-file finding via fallback',
            targetFiles: ['src/unknown.js'],
          }],
        };
      },
    };

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    await pipeline._executeMilestone(milestoneId, msState);

    // Exactly one remediation call — the unowned file falls back to a single mission.
    assert.strictEqual(
      remediateCalls.length,
      1,
      `Expected remediateReviewFindings called once (fallback to single mission); got ${remediateCalls.length}`
    );

    assert.strictEqual(
      remediateCalls[0].findings[0].file,
      'src/unknown.js',
      `Expected the unowned finding to appear in the fallback remediation call`
    );

    // Verify the fallback routes to sort()[0] of all missionIds.
    // sort(['001-001', '001-002'])[0] = '001-001' (missionAId).
    // mergeRemediationTasks with missionId='001-001' writes to mission-001-001.json.
    const missionAState = JSON.parse(
      fs.readFileSync(path.join(harnessDir, 'state', `mission-${missionAId}.json`), 'utf8')
    );
    const missionATaskIds = Object.values(missionAState.subMissions)
      .flatMap(sm => Object.keys(sm.tasks));

    assert.ok(
      missionATaskIds.some(id => id.startsWith('001-001-001-')),
      `Expected fix task merged into mission ${missionAId} (sort()[0] fallback); found tasks: ${missionATaskIds.join(', ')}`
    );

    // Mission B should be untouched — unowned file did not route there.
    const missionBState = JSON.parse(
      fs.readFileSync(path.join(harnessDir, 'state', `mission-${missionBId}.json`), 'utf8')
    );
    const missionBTaskIds = Object.values(missionBState.subMissions)
      .flatMap(sm => Object.keys(sm.tasks));

    // Mission B should only have its original task (001-002-001-001), no new fix tasks.
    assert.strictEqual(
      missionBTaskIds.length,
      1,
      `Expected mission ${missionBId} to remain unchanged (1 task); got ${missionBTaskIds.length} tasks: ${missionBTaskIds.join(', ')}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC5: empty criticalFindings (reviewer passes) → no remediation calls, short-circuit preserved', async () => {
  const {
    projectRoot, harnessDir, milestoneId,
  } = createSingleMissionHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    // Reviewer returns PASSED with no findings. The criticalFindings array is
    // empty, so the entire remediation block is never entered.
    const passedResult = {
      passed: true,
      findings: [],
      structured: { result: 'PASSED', findings: [], notes: '' },
      reportPath: '',
    };

    let remediateCalled = false;

    const trace = installBaseMocks(pipeline, {
      reviewerResultFirst: passedResult,
    });

    pipeline.planner = {
      remediateReviewFindings: async () => {
        remediateCalled = true;
        return { newTasks: [] };
      },
    };

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    await pipeline._executeMilestone(milestoneId, msState);

    assert.ok(
      !remediateCalled,
      'Expected remediateReviewFindings NOT called when reviewer passes (no critical findings)'
    );

    assert.strictEqual(
      trace.analyzeFailureCalls,
      0,
      `Expected analyzeFailure NOT called when reviewer passes; got ${trace.analyzeFailureCalls}`
    );

    assert.strictEqual(
      trace.reviewerCallCount,
      1,
      `Expected reviewer called exactly once (no re-review needed); got ${trace.reviewerCallCount}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test("TC7: analyzer recommendation 're_plan' at reviewer-gate routes through remediateReviewFindings (defect #18)", async () => {
  const {
    projectRoot, harnessDir, milestoneId, missionId, subMissionId,
  } = createSingleMissionHarness();
  const { pipeline, logs } = makePipeline(projectRoot);

  try {
    const finding = {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/foo.js',
      description: 'structural composition bug',
      relatedFiles: [],
    };

    const failedResult = {
      passed: false,
      findings: [finding],
      structured: { result: 'FAILED', findings: [finding], notes: '' },
      reportPath: '',
    };
    const passedResult = {
      passed: true,
      findings: [],
      structured: { result: 'PASSED', findings: [], notes: '' },
      reportPath: '',
    };

    const remediateCalls = [];

    installBaseMocks(pipeline, {
      reviewerResultFirst: failedResult,
      reviewerResultSecond: passedResult,
      analyzerRecommendation: 're_plan',
    });

    pipeline.planner = {
      remediateReviewFindings: async (_msId, findings) => {
        remediateCalls.push({ findings: [...findings] });
        return {
          newTasks: [{
            id: '001-001-001-099',
            subMissionId,
            description: 'fix structural composition bug',
            targetFiles: ['src/foo.js'],
          }],
        };
      },
    };

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    await pipeline._executeMilestone(milestoneId, msState);

    assert.strictEqual(
      remediateCalls.length, 1,
      `Expected remediateReviewFindings invoked under 're_plan'; got ${remediateCalls.length}`
    );
    assert.strictEqual(
      remediateCalls[0].findings[0].description, 'structural composition bug',
      'Expected the original critical finding routed to remediation'
    );
    assert.ok(
      logs.some(l => l.includes("'re_plan'") && l.includes('remediation retry')),
      `Expected log line acknowledging 're_plan' treatment. Got logs:\n${logs.join('\n')}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test("TC8: analyzer recommendation 'human' at reviewer-gate still throws (regression guard for TC7)", async () => {
  const { projectRoot, harnessDir, milestoneId } = createSingleMissionHarness();
  const { pipeline } = makePipeline(projectRoot);

  try {
    const finding = {
      severity: 'critical', category: 'call-chain',
      file: 'src/foo.js', description: 'unfixable', relatedFiles: [],
    };
    const failedResult = {
      passed: false, findings: [finding],
      structured: { result: 'FAILED', findings: [finding], notes: '' },
      reportPath: '',
    };

    installBaseMocks(pipeline, {
      reviewerResultFirst: failedResult,
      analyzerRecommendation: 'human',
    });
    pipeline.planner = { remediateReviewFindings: async () => ({ newTasks: [] }) };

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    let threw = null;
    try { await pipeline._executeMilestone(milestoneId, msState); }
    catch (err) { threw = err; }

    assert.ok(threw, 'Expected pipeline to throw on human recommendation');
    assert.ok(
      /human intervention/i.test(threw.message),
      `Expected human-intervention error. Got: ${threw.message}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC6: subMissionId fallback — mergeRemediationTasks logs warning with task.id, missionId, and fallback subMissionId', async () => {
  // This test exercises mergeRemediationTasks directly (following the pattern
  // from test-coverage-id-normalize.js) to verify the onLog warning path when
  // a task references a subMissionId that does not exist in the mission state.

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-rem-routing-sm-fallback-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'verify'), { recursive: true });

  const missionId = '001-001';
  const smId      = `${missionId}-001`;

  // Write global state.json (required by mergeRemediationTasks coverage check)
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones: {},
    }, null, 2)
  );

  // Rule 6: use writeMissionState to create the mission fixture
  writeMissionState(dir, missionId, 'test mission for subMissionId fallback', {
    subMissions: [{
      id: smId,
      description: 'valid sub-mission',
      tasks: [],
    }],
  });

  // Task references a subMissionId that does NOT exist in state.
  const nonExistentSmId = `${missionId}-999`;
  // Use a valid 4-segment id so id-normalization doesn't interfere with the warning.
  const taskId = `${smId}-007`;

  const logs = [];
  await mergeRemediationTasks({
    harnessDir: dir,
    missionId,
    newTasks: [{
      id: taskId,
      subMissionId: nonExistentSmId,
      description: 'task with bad subMissionId',
      targetFiles: [],
      testCases: [],
    }],
    missionDecomp: { subMissions: [{ id: smId, tasks: [] }] },
    onLog: (msg) => logs.push(msg),
  });

  // A warning / falling-back log line must have been emitted.
  const warningLog = logs.find(l => l.includes('falling back') || l.toLowerCase().includes('warning'));
  assert.ok(
    warningLog,
    `Expected a warning/fallback log line from mergeRemediationTasks. Got logs:\n${logs.join('\n')}`
  );

  // The warning must contain the original task id.
  assert.ok(
    warningLog.includes(taskId),
    `Warning must include task.id "${taskId}". Got: ${warningLog}`
  );

  // The warning must contain the missionId.
  assert.ok(
    warningLog.includes(missionId),
    `Warning must include missionId "${missionId}". Got: ${warningLog}`
  );

  // The warning must contain the fallback subMissionId (smId = first sub-mission in state).
  assert.ok(
    warningLog.includes(smId),
    `Warning must include fallback subMissionId "${smId}". Got: ${warningLog}`
  );

  // Cleanup
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
