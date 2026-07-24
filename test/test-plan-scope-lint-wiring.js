#!/usr/bin/env node
/**
 * test-plan-scope-lint-wiring.js — Integration tests proving the plan-scope
 * lint (gates/plan-scope-lint.js) is correctly wired into Planner and
 * Pipeline, with NO live SDK calls (planner sessions are stubbed).
 *
 * Test cases:
 *   TC1 — planner.planMission() throws when a task's targetFile is outside
 *         the declared set derived from context.specTargetFiles +
 *         context.specAcceptanceCriteria (a hard scope excursion).
 *   TC2 — planner.remediateReviewFindings()/remediateRegressionFailure() run
 *         lintPlanScope on newTasks AFTER path-anchor validation: an
 *         excursion that path-anchor validation does not flag (no
 *         case/suffix relation to a declared path) is still caught by the
 *         lint, proving the lint executes as a distinct, later check.
 *   TC3 — the pipeline's planMission emit point (_planAndApproveMission)
 *         threads specAcceptanceCriteria (from _getSpecAcceptanceCriteria())
 *         and scopeMapping into the opts passed to planner.planMission.
 *   TC4 — the pipeline's replan/remediation emit points
 *         (_dispatchAnalyzer → planner.replanTask,
 *          _executeMilestone's regression-remediation loop →
 *          planner.remediateRegressionFailure) thread specAcceptanceCriteria
 *         into the opts passed to the planner.
 *
 * Run: node test/test-plan-scope-lint-wiring.js
 */

// This suite's TC3 fixture bootstraps a run-scoped harness via makeRun
// (helpers/make-run.js), which itself clears CC_ORCH_ACTIVE_RUN before its
// own process.env-sensitive imports. Mirrored here (per
// test-state-resume-persistence.js's convention) so this file is
// re-entrancy-neutral regardless of launch context.
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Planner } from '../src/orchestrator/agents/planner.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { makeRun } from './helpers/make-run.js';

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

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Remove the process signal listeners the Pipeline constructor registers, so
 * repeated Pipeline construction across tests does not pile up listeners
 * past Node's MaxListeners warning threshold.
 */
function teardownPipeline(pipeline) {
  const h = pipeline._signalHandlers || {};
  if (h.SIGINT) process.removeListener('SIGINT', h.SIGINT);
  if (h.SIGTERM) process.removeListener('SIGTERM', h.SIGTERM);
  if (h.exit) process.removeListener('exit', h.exit);
  if (h.uncaughtException) process.removeListener('uncaughtException', h.uncaughtException);
  if (pipeline.statusBar && typeof pipeline.statusBar.destroy === 'function') {
    try { pipeline.statusBar.destroy(); } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TC1 — planner.planMission() throws on a scope excursion
// ═══════════════════════════════════════════════════════════════════════════

const PLANTED_TASK_ID = '001-001-001-001';

/**
 * Fake sessionManager whose spawnReusable()/spawn() resolve with a plan
 * containing a single task whose targetFiles is `taskTargetFiles`.
 * planMission() unconditionally takes the reusable-session path.
 */
function makeFakeReusableSessionManager(taskTargetFiles) {
  const fakeHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
  const fakeResult = {
    structured_output: {
      subMissions: [
        {
          id: '001-001',
          tasks: [
            { id: PLANTED_TASK_ID, description: 'a planted task', targetFiles: taskTargetFiles },
          ],
        },
      ],
      milestones: [],
    },
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    total_cost_usd: 0,
  };

  const fakeReusableSession = {
    handle: fakeHandle,
    turnCount: 0,
    sendPrompt: async () => fakeResult,
  };

  return {
    spawn() {
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
    spawnReusable() {
      return fakeReusableSession;
    },
  };
}

function makeFakeLogger() {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-plan-scope-lint-wiring.jsonl',
      write: () => {},
      close: () => {},
    }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
    warn: () => {},
  };
}

await test('TC1: planMission throws on an excursion task when specTargetFiles/specAcceptanceCriteria declare the scope', async () => {
  const planner = new Planner(
    makeFakeReusableSessionManager(['src/excursion.js']),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  let threw = null;
  try {
    await planner.planMission('m1', '/tmp', {
      missionPlan: '...',
      maxTasksPerSubMission: 3,
      mode: 'auto',
      // The declared scope: only src/allowed.js is in-scope. The planted
      // task targets src/excursion.js, which has no case/suffix relation to
      // it, so buildDeclaredSet(...).size > 0 and lintPlanScope must throw.
      specTargetFiles: ['src/allowed.js'],
      specAcceptanceCriteria: [],
    });
  } catch (err) {
    threw = err;
  }

  assert.ok(threw, 'expected planMission to throw on a scope excursion, but it resolved');
  assert.ok(
    /scope excursion/.test(threw.message),
    `expected a [plan-scope-lint] "scope excursion" error, got: ${threw.message}`,
  );
  assert.ok(
    threw.message.includes(PLANTED_TASK_ID),
    `expected the error to name the offending task "${PLANTED_TASK_ID}", got: ${threw.message}`,
  );
});

await test('TC1b: planMission does NOT throw when the task targetFile is inside the declared scope', async () => {
  const planner = new Planner(
    makeFakeReusableSessionManager(['src/allowed.js']),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  const plan = await planner.planMission('m1', '/tmp', {
    missionPlan: '...',
    maxTasksPerSubMission: 3,
    mode: 'auto',
    specTargetFiles: ['src/allowed.js'],
    specAcceptanceCriteria: [],
  });

  assert.ok(plan && Array.isArray(plan.subMissions), 'expected planMission to resolve with a plan');
});

// ═══════════════════════════════════════════════════════════════════════════
// TC2 — remediateReviewFindings / remediateRegressionFailure apply
// lintPlanScope to newTasks, AFTER _validatePathAnchorPreservation.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fake logger satisfying Planner's remediation-path usage:
 *   logger.createSessionLog(name) → { close() }
 *   logger.attachToSession(handle, log, meta) → void
 *   logger.warn(msg) → void (never hit in these tests — newTasks is always
 *   present, so the "missing newTasks" fallback branch is not exercised).
 */
function makeMockLogger() {
  return {
    createSessionLog: () => ({ close: () => {} }),
    attachToSession: () => {},
    warn: () => {},
  };
}

/**
 * Fake sessionManager whose spawn() resolves with a structured_output of
 * `{ newTasks: [...] }`.
 */
function makeMockSpawnSessionManager(newTasks) {
  return {
    spawn() {
      const mockHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
      const p = Promise.resolve({
        handle: mockHandle,
        result: { structured_output: { newTasks } },
      });
      p.handle = mockHandle;
      return p;
    },
  };
}

const sampleFindings = [
  { severity: 'critical', category: 'functional', file: 'src/allowed.js', description: 'a finding' },
];

// The excursion targetFile has no case/suffix relation to 'src/allowed.js',
// so _validatePathAnchorPreservation (which only flags near-miss
// case/suffix rewrites of a declared path) does NOT throw on it — only
// lintPlanScope's declared-set membership check does. This pins the lint as
// a distinct check that runs (and fires) AFTER path-anchor validation
// returns cleanly, rather than duplicating it.
const excursionNewTasks = [
  { id: '001-002-003-001', description: 'fix it', targetFiles: ['src/excursion.js'] },
];
const remediationOpts = { specTargetFiles: ['src/allowed.js'], specAcceptanceCriteria: [] };

await test('TC2a: remediateReviewFindings applies lintPlanScope to newTasks (throws on excursion, not a path-anchor violation)', async () => {
  const planner = new Planner(
    makeMockSpawnSessionManager(excursionNewTasks),
    makeMockLogger(),
    null,
  );

  let threw = null;
  try {
    await planner.remediateReviewFindings('001-002', sampleFindings, '/tmp/project', remediationOpts);
  } catch (err) {
    threw = err;
  }

  assert.ok(threw, 'expected remediateReviewFindings to throw on a scope excursion in newTasks');
  assert.ok(
    /scope excursion/.test(threw.message),
    `expected the [plan-scope-lint] "scope excursion" error (proving the lint fired), got: ${threw.message}`,
  );
  assert.ok(
    !/path anchor violation/.test(threw.message),
    `path-anchor validation should NOT have flagged this excursion (no case/suffix relation) — ` +
    `got: ${threw.message}`,
  );
});

await test('TC2b: remediateRegressionFailure applies lintPlanScope to newTasks (throws on excursion, not a path-anchor violation)', async () => {
  const planner = new Planner(
    makeMockSpawnSessionManager(excursionNewTasks),
    makeMockLogger(),
    null,
  );

  let threw = null;
  try {
    await planner.remediateRegressionFailure('001-002', sampleFindings, '/tmp/project', remediationOpts);
  } catch (err) {
    threw = err;
  }

  assert.ok(threw, 'expected remediateRegressionFailure to throw on a scope excursion in newTasks');
  assert.ok(
    /scope excursion/.test(threw.message),
    `expected the [plan-scope-lint] "scope excursion" error (proving the lint fired), got: ${threw.message}`,
  );
  assert.ok(
    !/path anchor violation/.test(threw.message),
    `path-anchor validation should NOT have flagged this excursion (no case/suffix relation) — ` +
    `got: ${threw.message}`,
  );
});

await test('TC2c: remediateReviewFindings does NOT throw when newTasks stay inside the declared scope', async () => {
  const planner = new Planner(
    makeMockSpawnSessionManager([
      { id: '001-002-003-001', description: 'fix it', targetFiles: ['src/allowed.js'] },
    ]),
    makeMockLogger(),
    null,
  );

  const result = await planner.remediateReviewFindings('001-002', sampleFindings, '/tmp/project', remediationOpts);
  assert.ok(Array.isArray(result.newTasks) && result.newTasks.length === 1, 'expected newTasks to pass through');
});

// ═══════════════════════════════════════════════════════════════════════════
// TC3 — pipeline planMission opts include specAcceptanceCriteria + scopeMapping
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a temp project + run-scoped harness with a single in-progress
 * milestone '001' carrying one not-yet-decomposed mission '001-001' (no
 * mission state file), a sibling spec.json carrying acceptance_criteria, and
 * projectMeta.scopeMapping seeded on state.json.
 */
function createMissionPlanFixture({ scopeMapping } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-scope-lint-wiring-mission-'));
  const { harnessDir } = makeRun(projectRoot, { slug: 'plan-scope-lint-wiring-mission' });
  fs.writeFileSync(path.join(harnessDir, 'logs', 'token-usage.json'), JSON.stringify({ sessions: [], totals: {} }));

  const prdPath = path.join(projectRoot, 'spec.md');
  fs.writeFileSync(prdPath, '# Test Spec\n\nNo scenarios here.\n');

  const specAcceptanceCriteria = [
    { description: 'criterion one', verification: { kind: 'command', command: 'node test/allowed.test.js' } },
  ];
  fs.writeFileSync(
    path.join(projectRoot, 'spec.json'),
    JSON.stringify({ goal: 'wiring fixture', target_files: ['src/allowed.js'], acceptance_criteria: specAcceptanceCriteria }, null, 2),
  );

  const scopeMappingFixture = scopeMapping ?? [{ scopeItemId: 'S1', missionIds: ['001-001'] }];

  const globalState = {
    projectMeta: {
      prdPath,
      createdAt: new Date().toISOString(),
      currentPhase: 'executing',
      scopeMapping: scopeMappingFixture,
    },
    globalStatus: 'active',
    milestones: {
      '001': {
        id: '001',
        description: 'milestone 001',
        status: 'in_progress',
        missions: {
          '001-001': {
            id: '001-001',
            description: 'mission 001-001',
            status: 'pending',
            stateFile: '.harness/state/mission-001-001.json',
            planFile: '.harness/plan/mission-001-001.md',
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));
  fs.writeFileSync(path.join(harnessDir, 'plan', 'mission-001-001.md'), '# Plan for mission 001-001\n');

  return { projectRoot, harnessDir, specAcceptanceCriteria, scopeMapping: scopeMappingFixture };
}

/** A planMission decomp shape (single sub-mission, single task) inside the declared scope. */
function makeMissionDecomp(taskId = '001-001-001-001', targetFiles = ['src/allowed.js']) {
  return {
    subMissions: [
      {
        id: '001-001-001',
        description: 'sub-mission',
        tasks: [
          {
            id: taskId,
            description: 'planned task',
            targetFiles,
            dependencies: [],
            testCases: [],
            tracesScenario: [],
            patternReferences: [],
            dataSchemas: [],
          },
        ],
      },
    ],
  };
}

/**
 * Build a Pipeline ready to call _planAndApproveMission, with
 * planner.planMission replaced by a spy that records its opts argument and
 * returns the supplied decomp; gate confirm auto-accepts.
 */
function makeMissionPipeline(projectRoot, { decomp, capturedOpts }) {
  const pipeline = new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: () => {},
    onConfirm: async () => true,
  });
  pipeline._mode = undefined;
  pipeline._currentMsId = '001';
  pipeline._currentMsState = { missions: {} };
  pipeline._msStartTime = Date.now();
  pipeline.planner.planMission = async (missionId, root, opts) => {
    capturedOpts.push(opts);
    return JSON.parse(JSON.stringify(decomp));
  };
  pipeline.planner.closeReusableSession = async () => {};
  return pipeline;
}

await test('TC3: pipeline planMission opts include specAcceptanceCriteria, scopeMapping, and scopeItems (spied)', async () => {
  const { projectRoot, specAcceptanceCriteria, scopeMapping } = createMissionPlanFixture();
  const decomp = makeMissionDecomp('001-001-001-001', ['src/allowed.js']);
  const capturedOpts = [];
  const pipeline = makeMissionPipeline(projectRoot, { decomp, capturedOpts });

  try {
    await pipeline._planAndApproveMission('001-001', { description: 'mission 001-001', status: 'pending' });

    assert.strictEqual(capturedOpts.length, 1, `expected planner.planMission to be called once, got ${capturedOpts.length}`);
    const opts = capturedOpts[0];
    assert.deepStrictEqual(
      opts.specAcceptanceCriteria,
      specAcceptanceCriteria,
      `expected opts.specAcceptanceCriteria to equal _getSpecAcceptanceCriteria()'s value.\n` +
      `Expected: ${JSON.stringify(specAcceptanceCriteria)}\nGot: ${JSON.stringify(opts.specAcceptanceCriteria)}`,
    );
    assert.deepStrictEqual(
      opts.scopeMapping,
      scopeMapping,
      `expected opts.scopeMapping to equal the persisted projectMeta.scopeMapping.\n` +
      `Expected: ${JSON.stringify(scopeMapping)}\nGot: ${JSON.stringify(opts.scopeMapping)}`,
    );
    // scopeItems threading — the file-vs-mission advisory needs scope items'
    // text at the planMission emit site. The fixture leaves projectMeta.scopeItems
    // absent, so the pipeline defaults it to [] (never undefined) so
    // checkScopeMappingConsistency's opts arg is always well-formed.
    assert.ok(
      Array.isArray(opts.scopeItems),
      `expected opts.scopeItems to be an array (defaults to [] when projectMeta has none); got: ${typeof opts.scopeItems}`,
    );
  } finally {
    teardownPipeline(pipeline);
    cleanup(projectRoot);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TC5 — planner.planGlobal invokes lintGlobalPlanScope after the plan parses:
// an acceptance command whose path token no mission covers throws; a plan
// whose missions carry no targetFiles at all is a silent no-op.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fake sessionManager whose one-shot spawn resolves with the supplied
 * globalPlan-shaped structured_output — enough to drive planGlobal to
 * the lintGlobalPlanScope call site.
 */
function makeFakeGlobalSpawnSessionManager(structuredPlan) {
  return {
    spawn() {
      const fakeHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
      const p = Promise.resolve({
        handle: fakeHandle,
        result: {
          structured_output: structuredPlan,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          total_cost_usd: 0,
        },
      });
      p.handle = fakeHandle;
      return p;
    },
  };
}

await test('TC5a: planner.planGlobal throws via lintGlobalPlanScope when an AC path is covered by no mission', async () => {
  // globalPlan whose one mission declares only src/foo.js — no test/x.js.
  const globalPlan = {
    milestones: [
      {
        id: '001',
        description: 'ms 001',
        missions: [
          { id: '001-001', description: 'mission', targetFiles: ['src/foo.js'] },
        ],
      },
    ],
    assumptions: [],
  };
  const planner = new Planner(
    makeFakeGlobalSpawnSessionManager(globalPlan),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  let threw = null;
  try {
    await planner.planGlobal('goal', '/tmp', {
      specTargetFiles: ['src/foo.js', 'test/x.js'],
      specAcceptanceCriteria: [
        { description: 'the x test', verification: { kind: 'command', command: 'node test/x.js' } },
      ],
    });
  } catch (err) {
    threw = err;
  }

  assert.ok(threw, 'expected planGlobal to throw when an AC path is covered by no mission');
  assert.ok(
    /is not covered by any mission/.test(threw.message),
    `expected a lintGlobalPlanScope error, got: ${threw && threw.message}`,
  );
});

await test('TC5b: planner.planGlobal does NOT throw when no mission declares targetFiles (no-op)', async () => {
  const globalPlan = {
    milestones: [
      {
        id: '001',
        description: 'ms 001',
        missions: [
          { id: '001-001', description: 'mission' }, // no targetFiles at all
        ],
      },
    ],
    assumptions: [],
  };
  const planner = new Planner(
    makeFakeGlobalSpawnSessionManager(globalPlan),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  const plan = await planner.planGlobal('goal', '/tmp', {
    specTargetFiles: ['src/foo.js', 'test/x.js'],
    specAcceptanceCriteria: [
      { description: 'the x test', verification: { kind: 'command', command: 'node test/x.js' } },
    ],
  });
  assert.ok(plan && Array.isArray(plan.milestones), 'expected planGlobal to resolve with a plan');
});

// ═══════════════════════════════════════════════════════════════════════════
// TC4 — pipeline replan/remediation opts include specAcceptanceCriteria
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Minimal on-disk harness (no run-scoping) so the Pipeline constructor
 * doesn't crash, plus a sibling spec.json carrying acceptance_criteria.
 * Mirrors test-pipeline-replan.js's createMinimalHarness.
 */
function createMinimalHarnessWithSpec() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-scope-lint-wiring-replan-'));
  const harnessDir = path.join(projectRoot, '.harness');

  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'snapshots'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'analysis'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'plan'), { recursive: true });

  const prdPath = path.join(projectRoot, 'spec.md');
  fs.writeFileSync(prdPath, '# spec\n');
  const specAcceptanceCriteria = [
    { description: 'replan criterion', verification: { kind: 'manual', manualSteps: ['look at it'] } },
  ];
  fs.writeFileSync(
    path.join(projectRoot, 'spec.json'),
    JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: specAcceptanceCriteria }, null, 2),
  );

  const state = {
    projectMeta: { prdPath, createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {},
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  return { projectRoot, harnessDir, specAcceptanceCriteria };
}

await test('TC4a: pipeline _dispatchAnalyzer re_plan branch threads specAcceptanceCriteria into planner.replanTask opts', async () => {
  const { projectRoot, specAcceptanceCriteria } = createMinimalHarnessWithSpec();
  const pipeline = new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: () => {},
    onConfirm: async () => true,
    noReview: true,
    skipReview: true,
  });

  try {
    pipeline.analyzer = {
      analyzeFailure: async () => ({ eventId: 'evt-001', recommendation: 're_plan', affectedTasks: [], structured: null }),
    };
    pipeline.scheduler = {
      _replanAttempts: new Map(),
      replaceTask: async () => {},
    };
    const capturedOpts = [];
    pipeline.planner = {
      replanTask: async (failedTask, structured, missionContext, opts) => {
        capturedOpts.push(opts);
        return { replacementTasks: [{ id: '001-001-001-001-rp-001', description: 'fix', targetFiles: ['src/a.js'], dependencies: [] }] };
      },
    };

    const baseTask = {
      id: '001-001-001-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      description: 'Test task',
      targetFiles: ['src/a.js'],
    };

    await pipeline._dispatchAnalyzer(baseTask, 'execution', 2);

    assert.strictEqual(capturedOpts.length, 1, `expected planner.replanTask to be called once, got ${capturedOpts.length}`);
    assert.deepStrictEqual(
      capturedOpts[0].specAcceptanceCriteria,
      specAcceptanceCriteria,
      `expected replanTask's opts.specAcceptanceCriteria to equal _getSpecAcceptanceCriteria()'s value.\n` +
      `Expected: ${JSON.stringify(specAcceptanceCriteria)}\nGot: ${JSON.stringify(capturedOpts[0].specAcceptanceCriteria)}`,
    );
  } finally {
    teardownPipeline(pipeline);
    cleanup(projectRoot);
  }
});

/**
 * Create a temp project root with .harness structure, a spec.json carrying
 * acceptance_criteria, and a minimal global state.json (milestone
 * in_progress, single mission complete) + per-mission state file — enough
 * for _executeMilestoneParallel to short-circuit (no missions to approve)
 * and control to reach the shared milestone-regression-remediation section.
 * Mirrors test-pipeline-milestone-regression-remediation.js's
 * createIntegrationHarness.
 */
function createRegressionRemediationHarness({ milestoneId = '001', missionId = '001-001' } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-scope-lint-wiring-regression-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const taskId = `${missionId}-001-001`;
  const subMissionId = `${missionId}-001`;

  fs.writeFileSync(
    path.join(harnessDir, 'progress', `task-${taskId}.json`),
    JSON.stringify({ taskId, status: 'COMPLETE', affectedFiles: [{ path: 'src/foo.js' }], summary: 's', testsSummary: 't' }),
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-${taskId}.json`),
    JSON.stringify({ taskId, verified: true, report: 'ok', result: 'PASSED', hardChecks: [], taskScopeChecks: [], notes: null }),
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: ['src/foo.js'], hardChecks: [], testCases: [] }),
  );

  const srcDir = path.join(projectRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'foo.js'), '// src/foo.js\n');

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
  fs.writeFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), JSON.stringify(missionState, null, 2));

  const prdPath = path.join(projectRoot, 'spec.md');
  fs.writeFileSync(prdPath, '# spec\n');
  const specAcceptanceCriteria = [
    { description: 'regression criterion', verification: { kind: 'manual', manualSteps: ['check it'] } },
  ];
  fs.writeFileSync(
    path.join(projectRoot, 'spec.json'),
    JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: specAcceptanceCriteria }, null, 2),
  );

  const globalState = {
    projectMeta: { prdPath, createdAt: new Date().toISOString(), currentPhase: 'executing' },
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

  return { projectRoot, harnessDir, milestoneId, missionId, taskId, subMissionId, specAcceptanceCriteria };
}

/**
 * Verifier mock: verifyRegression fails `failCount` times for
 * 'regression-milestone-*' tasks, then passes.
 */
function makeVerifierMock(failCount = 1) {
  let regressionCallCount = 0;
  return {
    verifyRegression: async (task) => {
      if (task.id && task.id.startsWith('regression-milestone-')) {
        regressionCallCount++;
        if (regressionCallCount <= failCount) {
          return { verified: false, report: 'FAILED: mock regression failure', structured: { verified: false } };
        }
        return { verified: true, report: 'PASSED', structured: { verified: true } };
      }
      return { verified: true, report: 'PASSED', structured: { verified: true } };
    },
  };
}

await test('TC4b: pipeline milestone regression-remediation loop threads specAcceptanceCriteria into planner.remediateRegressionFailure opts', async () => {
  const { projectRoot, harnessDir, milestoneId, specAcceptanceCriteria } = createRegressionRemediationHarness();
  const pipeline = new Pipeline(projectRoot, {
    noReview: true,
    onLog: () => {},
    onConfirm: async () => true,
  });

  try {
    pipeline.verifier = makeVerifierMock(1);
    pipeline.analyzer = { analyzeFailure: async () => ({ eventId: 'mock-event-001', recommendation: 'retry', affectedTasks: [] }) };
    const capturedOpts = [];
    pipeline.planner = {
      remediateRegressionFailure: async (msId, findings, root, opts) => {
        capturedOpts.push(opts);
        return { newTasks: [] };
      },
    };
    pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
    pipeline._executeAndVerifyTask = async () => {};
    pipeline._collectMilestoneContext = () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    await pipeline._executeMilestone(milestoneId, msState);

    assert.strictEqual(capturedOpts.length, 1, `expected planner.remediateRegressionFailure to be called once, got ${capturedOpts.length}`);
    assert.deepStrictEqual(
      capturedOpts[0].specAcceptanceCriteria,
      specAcceptanceCriteria,
      `expected remediateRegressionFailure's opts.specAcceptanceCriteria to equal _getSpecAcceptanceCriteria()'s value.\n` +
      `Expected: ${JSON.stringify(specAcceptanceCriteria)}\nGot: ${JSON.stringify(capturedOpts[0].specAcceptanceCriteria)}`,
    );
  } finally {
    teardownPipeline(pipeline);
    cleanup(projectRoot);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
