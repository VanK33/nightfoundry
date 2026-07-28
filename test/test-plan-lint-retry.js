#!/usr/bin/env node
/**
 * test-plan-lint-retry.js — Spec coverage for the plan-lint feedback-retry
 * loop + lint-rule signature granularity (queue/plan-lint-feedback-retry.spec).
 *
 * Written from the spec pair (spec.md + spec.json) as independent TDD tests:
 * they are EXPECTED to fail until the implementation lands. Existing-behavior
 * cases (TC12, TC16, TC18, TC20 and the message-text halves of TC1-TC10) hold
 * against current code.
 *
 * AC1 — structured lint errors (both lint modules):
 *   TC1  — lintTaskCheckShapes T1 leg: ruleId 'T1', violations[] collects every
 *          T1 violation ({ruleId, taskId, offending}), message byte-identical.
 *   TC2  — lintTaskCheckShapes T2 leg: ruleId 'T2', collect-all, message
 *          byte-identical.
 *   TC3  — scan order preserved: a plan violating T2 and T1 throws T2 (today's
 *          per-testCase T2-before-T1 order); violations[] lists ONLY the
 *          throwing rule's violations.
 *   TC4  — lintPlanScope excursion leg: ruleId 'scope-excursion', collect-all
 *          across tasks, offending = the emitted target path verbatim.
 *   TC5  — lintPlanScope coverage leg: ruleId 'uncovered-token', message
 *          byte-identical, violations[] element shape.
 *   TC6  — excursion pass completes before coverage pass: a plan violating
 *          both throws 'scope-excursion'.
 *   TC7  — lintGlobalPlanScope leg: ruleId 'global-uncovered-token',
 *          taskId null, message byte-identical.
 *   TC8  — lintPlanStructure L1: ruleId 'structure-cap-missions', taskId null.
 *   TC9  — lintPlanStructure L2: ruleId 'structure-cap-milestones', taskId null.
 *   TC10 — lintPlanStructure L3: ruleId 'declared-duplicate', collect-all over
 *          duplicated paths, offending = duplicated path verbatim, taskId null.
 *   TC11 — PlanLintError is exported from plan-structure-lint.js and thrown by
 *          BOTH modules (fields ruleId + violations; still an Error).
 *   TC12 — sanity (passes today): clean inputs make all four lint entry points
 *          return without throwing.
 *
 * AC2 — bounded corrective-turn retry in _planMissionReusable (planner session
 * stubbed following the test-planner-reuse.js pattern — a fake session object
 * with a scripted sendPrompt, pre-populated on planner._reusableSession):
 *   TC13 — retryable violation (scope-excursion) then clean plan → resolves
 *          with the second plan, EXACTLY two planner turns, corrective prompt
 *          lists ruleId/taskId/offending verbatim, both turns run through
 *          recordSession + writeSessionSummary, [plan-lint-retry] line(s)
 *          emitted via this.logger.warn.
 *   TC14 — violation then a second violation of ANY rule → rethrows the second
 *          error (ruleId 'T2'), exactly two turns.
 *   TC15 — uncovered-token violation → rethrows, exactly ONE turn (never
 *          retried).
 *   TC16 — existing behavior (passes today): a ruleId-less validation error
 *          (path-anchor violation) propagates unchanged after one turn.
 *
 * AC3 — ledger signature granularity:
 *   TC17 — lintErrorClass maps a ruleId-bearing error (duck-typed, not
 *          instanceof) to 'plan-lint:<ruleId>' and a plain error to its name.
 *   TC18 — hashSignature produces distinct hashes for signatures differing
 *          only in those errorClass values (passes today).
 *
 * AC4 — failed-plan candidates emit derives signature.errorClass via
 * lintErrorClass (real Pipeline.batchResume against a temp git repo, following
 * the test-candidate-emit.js pattern):
 *   TC19 — a planPhase-tagged error carrying ruleId 'T1' lands the entry
 *          'failed-plan' with exactly one candidates.jsonl line whose
 *          signature.errorClass is 'plan-lint:T1'.
 *   TC20 — a planPhase-tagged plain Error still records errorClass 'Error'
 *          (passes today).
 *
 * Run: node test/test-plan-lint-retry.js
 */
import assert from 'assert';
import fs from 'fs';
import * as structureLint from '../src/orchestrator/gates/plan-structure-lint.js';
import * as scopeLint from '../src/orchestrator/gates/plan-scope-lint.js';
import * as ledger from '../src/orchestrator/core/candidates-ledger.js';
import { Planner } from '../src/orchestrator/agents/planner.js';
import { readQueueEntry } from '../src/orchestrator/core/state.js';
import {
  makeGitRoot,
  cleanup,
  makePlan,
  createQueueEntry,
  makeRealBatchPipeline,
} from './helpers/batch-fixtures.js';

const { lintPlanStructure, lintTaskCheckShapes } = structureLint;
const { buildDeclaredSet, lintPlanScope, lintGlobalPlanScope } = scopeLint;
const { hashSignature, candidatesLedgerPath } = ledger;
// New exports under test (may not exist yet — TDD). Accessed via the namespace
// objects so their absence fails individual TCs instead of crashing the module
// load with an ESM link error.
const PlanLintError = structureLint.PlanLintError;
const lintErrorClass = ledger.lintErrorClass;

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

/** Run fn, return the error it threw; fail the test if it did not throw. */
function mustThrow(fn, label) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail(`${label}: expected the call to throw, but it returned`);
}

/**
 * Spec-pinned violations[] element shape: exactly { ruleId, taskId, offending }
 * with the designated ruleId.
 */
function assertViolationShape(v, ruleId, label) {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v),
    `${label}: violations[] element must be a plain object, got ${JSON.stringify(v)}`);
  assert.deepStrictEqual(Object.keys(v).sort(), ['offending', 'ruleId', 'taskId'],
    `${label}: violations[] element shape must be exactly { ruleId, taskId, offending }. Got keys: ${JSON.stringify(Object.keys(v).sort())}`);
  assert.strictEqual(v.ruleId, ruleId,
    `${label}: violations[] element ruleId must be '${ruleId}', got '${v.ruleId}'`);
}

/** Common structured-error assertions: designated ruleId + violations[] array. */
function assertStructuredLintError(err, ruleId, label) {
  assert.ok(err instanceof Error, `${label}: thrown value must be an Error`);
  assert.strictEqual(err.ruleId, ruleId,
    `${label}: err.ruleId must be '${ruleId}', got '${err.ruleId}'`);
  assert.ok(Array.isArray(err.violations),
    `${label}: err.violations must be an array, got ${typeof err.violations}`);
  assert.ok(err.violations.length >= 1,
    `${label}: err.violations must list at least one violation`);
  for (const v of err.violations) assertViolationShape(v, ruleId, label);
}

// ── AC1 fixtures ──────────────────────────────────────────────────────────────

const T1_CASE_A = 'src/foreign.js remains unchanged after the refactor';
const T1_CASE_B = 'src/extra.js is untouched';
const T2_CASE_A = 'no test files are shipped with this change';
const T2_CASE_B = 'only src/a.js is modified';

function makeT1Plan() {
  return {
    subMissions: [{
      id: 'sm1',
      tasks: [
        { id: 't1', description: 'first task', targetFiles: ['src/own.js'], testCases: [T1_CASE_A] },
        { id: 't2', description: 'second task', targetFiles: ['src/own2.js'], testCases: [T1_CASE_B] },
      ],
    }],
  };
}

function makeT2Plan() {
  return {
    subMissions: [{
      id: 'sm1',
      tasks: [
        { id: 't1', description: 'first task', targetFiles: ['src/own.js'], testCases: [T2_CASE_A] },
        { id: 't2', description: 'second task', targetFiles: ['src/own2.js'], testCases: [T2_CASE_B] },
      ],
    }],
  };
}

// ── TC1 ───────────────────────────────────────────────────────────────────────

await test('TC1: T1 leg throws ruleId T1 with collect-all violations and unchanged message', () => {
  const err = mustThrow(() => lintTaskCheckShapes(makeT1Plan()), 'TC1');
  assert.strictEqual(err.message,
    `[plan-structure-lint] task "t1" testCase "${T1_CASE_A}" asserts a ` +
    'modification-status predicate (T1) referencing a file outside its own targetFiles',
    `TC1: T1 message must stay byte-identical. Got: ${err.message}`);
  assertStructuredLintError(err, 'T1', 'TC1');
  assert.strictEqual(err.violations.length, 2,
    `TC1: violations[] must collect BOTH T1 violations in the plan, got ${err.violations.length}`);
  assert.strictEqual(err.violations[0].taskId, 't1', 'TC1: first violation taskId');
  assert.strictEqual(err.violations[0].offending, T1_CASE_A,
    'TC1: first violation offending must be the violating testCase text verbatim');
  assert.strictEqual(err.violations[1].taskId, 't2', 'TC1: second violation taskId');
  assert.strictEqual(err.violations[1].offending, T1_CASE_B,
    'TC1: second violation offending must be the violating testCase text verbatim');
});

// ── TC2 ───────────────────────────────────────────────────────────────────────

await test('TC2: T2 leg throws ruleId T2 with collect-all violations and unchanged message', () => {
  const err = mustThrow(() => lintTaskCheckShapes(makeT2Plan()), 'TC2');
  assert.strictEqual(err.message,
    `[plan-structure-lint] task "t1" testCase "${T2_CASE_A}" asserts a ` +
    'literal tree-state shape (T2), which is out of scope for a task-level check',
    `TC2: T2 message must stay byte-identical. Got: ${err.message}`);
  assertStructuredLintError(err, 'T2', 'TC2');
  assert.strictEqual(err.violations.length, 2,
    `TC2: violations[] must collect BOTH T2 violations in the plan, got ${err.violations.length}`);
  assert.strictEqual(err.violations[0].taskId, 't1', 'TC2: first violation taskId');
  assert.strictEqual(err.violations[0].offending, T2_CASE_A,
    'TC2: first violation offending must be the violating testCase text verbatim');
  assert.strictEqual(err.violations[1].taskId, 't2', 'TC2: second violation taskId');
  assert.strictEqual(err.violations[1].offending, T2_CASE_B,
    'TC2: second violation offending must be the violating testCase text verbatim');
});

// ── TC3 ───────────────────────────────────────────────────────────────────────
// Today's scan order decides the throwing rule (per-testCase T2-before-T1) and
// violations[] collects only the THROWING rule's violations.

await test('TC3: mixed T2+T1 plan throws T2 (scan order) listing only T2 violations', () => {
  const plan = {
    subMissions: [{
      id: 'sm1',
      tasks: [
        { id: 't1', description: 'first task', targetFiles: ['src/own.js'], testCases: [T2_CASE_A] },
        { id: 't2', description: 'second task', targetFiles: ['src/own2.js'], testCases: [T1_CASE_B] },
      ],
    }],
  };
  const err = mustThrow(() => lintTaskCheckShapes(plan), 'TC3');
  assertStructuredLintError(err, 'T2', 'TC3');
  assert.strictEqual(err.violations.length, 1,
    `TC3: violations[] must list only the throwing rule's (T2) violations, got ${err.violations.length}`);
  assert.strictEqual(err.violations[0].offending, T2_CASE_A, 'TC3: T2 offending text');
  assert.strictEqual(err.message,
    `[plan-structure-lint] task "t1" testCase "${T2_CASE_A}" asserts a ` +
    'literal tree-state shape (T2), which is out of scope for a task-level check',
    'TC3: message must be the first T2 violation\'s current text');
});

// ── TC4 ───────────────────────────────────────────────────────────────────────

await test('TC4: scope-excursion leg throws ruleId scope-excursion with collect-all violations', () => {
  const plan = {
    subMissions: [{
      id: 'sm1',
      tasks: [
        { id: 't1', description: 'first task', targetFiles: ['src/evil1.js'], testCases: ['node src/evil1.js exits 0'] },
        { id: 't2', description: 'second task', targetFiles: ['src/evil2.js'], testCases: ['node src/evil2.js exits 0'] },
      ],
    }],
  };
  const declared = new Set(['src/good.js']);
  const err = mustThrow(() => lintPlanScope(plan, declared, {}), 'TC4');
  assert.strictEqual(err.message,
    '[plan-scope-lint] scope excursion: task "t1" targets "src/evil1.js" ' +
    'which is outside the spec-declared scope set',
    `TC4: excursion message must stay byte-identical. Got: ${err.message}`);
  assertStructuredLintError(err, 'scope-excursion', 'TC4');
  assert.strictEqual(err.violations.length, 2,
    `TC4: violations[] must collect BOTH excursions, got ${err.violations.length}`);
  assert.strictEqual(err.violations[0].taskId, 't1', 'TC4: first violation taskId');
  assert.strictEqual(err.violations[0].offending, 'src/evil1.js',
    'TC4: first violation offending must be the emitted target path verbatim');
  assert.strictEqual(err.violations[1].taskId, 't2', 'TC4: second violation taskId');
  assert.strictEqual(err.violations[1].offending, 'src/evil2.js',
    'TC4: second violation offending must be the emitted target path verbatim');
});

// ── TC5 ───────────────────────────────────────────────────────────────────────

const UNCOVERED_SPEC_TARGETS = ['src/good.js', 'src/other.js'];
const UNCOVERED_CRITERIA = [{
  description: 'covered-and-uncovered command',
  verification: { kind: 'command', command: 'node src/good.js src/other.js' },
}];

function makeUncoveredTokenPlan() {
  return {
    subMissions: [{
      id: 'sm1',
      tasks: [
        { id: 't1', description: 'first task', targetFiles: ['src/good.js'], testCases: ['node src/good.js exits 0'] },
      ],
    }],
  };
}

await test('TC5: uncovered-token leg throws ruleId uncovered-token with unchanged message', () => {
  const declared = buildDeclaredSet(UNCOVERED_SPEC_TARGETS, UNCOVERED_CRITERIA);
  const err = mustThrow(() => lintPlanScope(makeUncoveredTokenPlan(), declared, {
    specTargetFiles: UNCOVERED_SPEC_TARGETS,
    specAcceptanceCriteria: UNCOVERED_CRITERIA,
  }), 'TC5');
  assert.strictEqual(err.message,
    '[plan-scope-lint] scoped acceptance command "node src/good.js src/other.js" references ' +
    '"src/other.js" not covered by any task\'s targetFiles',
    `TC5: coverage message must stay byte-identical. Got: ${err.message}`);
  assertStructuredLintError(err, 'uncovered-token', 'TC5');
  assert.ok(err.violations[0].offending.includes('src/other.js'),
    `TC5: offending must carry the uncovered token verbatim. Got: ${err.violations[0].offending}`);
});

// ── TC6 ───────────────────────────────────────────────────────────────────────
// The excursion pass completes before the coverage pass — a plan with both
// violation classes throws scope-excursion.

await test('TC6: plan with excursion AND coverage miss throws scope-excursion (pass order)', () => {
  const plan = {
    subMissions: [{
      id: 'sm1',
      tasks: [
        {
          id: 't1',
          description: 'first task',
          targetFiles: ['src/good.js', 'src/evil.js'],
          testCases: ['node src/good.js exits 0'],
        },
      ],
    }],
  };
  const declared = buildDeclaredSet(UNCOVERED_SPEC_TARGETS, UNCOVERED_CRITERIA);
  const err = mustThrow(() => lintPlanScope(plan, declared, {
    specTargetFiles: UNCOVERED_SPEC_TARGETS,
    specAcceptanceCriteria: UNCOVERED_CRITERIA,
  }), 'TC6');
  assertStructuredLintError(err, 'scope-excursion', 'TC6');
  assert.strictEqual(err.violations[0].offending, 'src/evil.js', 'TC6: excursion offending path');
});

// ── TC7 ───────────────────────────────────────────────────────────────────────

await test('TC7: lintGlobalPlanScope leg throws ruleId global-uncovered-token, taskId null', () => {
  const globalPlan = {
    missions: [{ id: 'm1', targetFiles: ['src/good.js'] }],
  };
  const specTargets = ['src/good.js', 'src/absent.js'];
  const criteria = [{
    description: 'orphan command',
    verification: { kind: 'command', command: 'node src/absent.js' },
  }];
  const err = mustThrow(() => lintGlobalPlanScope(globalPlan, specTargets, criteria, {}), 'TC7');
  assert.strictEqual(err.message,
    '[plan-scope-lint] acceptance command "node src/absent.js" is not covered by any mission\'s targetFiles',
    `TC7: global coverage message must stay byte-identical. Got: ${err.message}`);
  assertStructuredLintError(err, 'global-uncovered-token', 'TC7');
  assert.strictEqual(err.violations[0].taskId, null,
    'TC7: taskId must be null at planGlobal (no tasks exist)');
});

// ── TC8 ───────────────────────────────────────────────────────────────────────

await test('TC8: L1 mission-cap leg throws ruleId structure-cap-missions, taskId null', () => {
  const globalPlan = {
    missions: [
      { id: 'm1', targetFiles: [] },
      { id: 'm2', targetFiles: [] },
    ],
  };
  const err = mustThrow(() => lintPlanStructure(globalPlan, { max_missions: 1 }), 'TC8');
  assert.strictEqual(err.message,
    '[plan-structure-lint] mission count 2 exceeds spec-declared max_missions 1',
    `TC8: L1 message must stay byte-identical. Got: ${err.message}`);
  assertStructuredLintError(err, 'structure-cap-missions', 'TC8');
  assert.strictEqual(err.violations[0].taskId, null, 'TC8: taskId must be null (no task applies)');
});

// ── TC9 ───────────────────────────────────────────────────────────────────────

await test('TC9: L2 milestone-cap leg throws ruleId structure-cap-milestones, taskId null', () => {
  const globalPlan = {
    milestones: [{ missions: [] }, { missions: [] }],
  };
  const err = mustThrow(() => lintPlanStructure(globalPlan, { max_milestones: 1 }), 'TC9');
  assert.strictEqual(err.message,
    '[plan-structure-lint] milestone count 2 exceeds spec-declared max_milestones 1',
    `TC9: L2 message must stay byte-identical. Got: ${err.message}`);
  assertStructuredLintError(err, 'structure-cap-milestones', 'TC9');
  assert.strictEqual(err.violations[0].taskId, null, 'TC9: taskId must be null (no task applies)');
});

// ── TC10 ──────────────────────────────────────────────────────────────────────

await test('TC10: L3 declared-duplicate leg throws ruleId declared-duplicate with collect-all', () => {
  const globalPlan = {
    missions: [
      { id: 'm1', targetFiles: ['src/dup.js', 'src/dup2.js'] },
      { id: 'm2', targetFiles: ['src/dup.js', 'src/dup2.js'] },
    ],
  };
  const err = mustThrow(() => lintPlanStructure(globalPlan, undefined), 'TC10');
  assert.strictEqual(err.message,
    '[plan-structure-lint] declared-duplicate targetFile: mission "m1" and ' +
    'mission "m2" in the same milestone both declare "src/dup.js"',
    `TC10: L3 message must stay byte-identical. Got: ${err.message}`);
  assertStructuredLintError(err, 'declared-duplicate', 'TC10');
  assert.strictEqual(err.violations.length, 2,
    `TC10: violations[] must collect BOTH duplicated paths, got ${err.violations.length}`);
  assert.strictEqual(err.violations[0].offending, 'src/dup.js',
    'TC10: first violation offending must be the duplicated path verbatim');
  assert.strictEqual(err.violations[1].offending, 'src/dup2.js',
    'TC10: second violation offending must be the duplicated path verbatim');
  assert.strictEqual(err.violations[0].taskId, null,
    'TC10: taskId must be null (missions are not tasks)');
});

// ── TC11 ──────────────────────────────────────────────────────────────────────

await test('TC11: PlanLintError is exported and thrown by BOTH lint modules', () => {
  assert.strictEqual(typeof PlanLintError, 'function',
    'TC11: plan-structure-lint.js must export PlanLintError');
  const structureErr = mustThrow(() => lintTaskCheckShapes(makeT1Plan()), 'TC11-structure');
  assert.ok(structureErr instanceof PlanLintError,
    'TC11: plan-structure-lint throws must be PlanLintError instances');
  assert.ok(structureErr instanceof Error, 'TC11: PlanLintError must subclass Error');
  const scopeErr = mustThrow(() => lintPlanScope({
    subMissions: [{ id: 'sm1', tasks: [{ id: 't1', targetFiles: ['src/evil.js'], testCases: [] }] }],
  }, new Set(['src/good.js']), {}), 'TC11-scope');
  assert.ok(scopeErr instanceof PlanLintError,
    'TC11: plan-scope-lint throws must be PlanLintError instances (imported from plan-structure-lint.js)');
});

// ── TC12 ──────────────────────────────────────────────────────────────────────

await test('TC12: clean inputs pass all four lint entry points without throwing', () => {
  const cleanPlan = {
    subMissions: [{
      id: 'sm1',
      tasks: [{ id: 't1', description: 'clean task', targetFiles: ['src/good.js'], testCases: ['node src/good.js exits 0'] }],
    }],
  };
  lintTaskCheckShapes(cleanPlan);
  lintPlanStructure({ missions: [{ id: 'm1', targetFiles: ['src/good.js'] }] }, { max_missions: 2, max_milestones: 1 });
  lintPlanScope(cleanPlan, new Set(['src/good.js']), {
    specTargetFiles: ['src/good.js'],
    specAcceptanceCriteria: [],
  });
  lintGlobalPlanScope(
    { missions: [{ id: 'm1', targetFiles: ['src/good.js'] }] },
    ['src/good.js'],
    [{ description: 'ok', verification: { kind: 'command', command: 'node src/good.js' } }],
    {},
  );
});

// ── AC2 — planner retry loop ─────────────────────────────────────────────────
//
// Planner session stub (test-planner-reuse.js pattern): a fake session object
// with a SCRIPTED sendPrompt (returns the next plan from a queue as the SDK
// result's structured_output, recording every prompt), a stub handle for the
// per-turn telemetry reads, pre-populated on planner._reusableSession so
// _ensureReusableSession never touches the SDK. Logger/tokenTracker are
// recorders so turn accounting and this.logger.warn output are observable.

function makeScriptedSession(plans) {
  const prompts = [];
  let call = 0;
  return {
    prompts,
    turnCount: 0,
    handle: { systemPromptTokens: 0, _toolCallCount: 0 },
    sendPrompt: async (prompt) => {
      prompts.push(String(prompt));
      const plan = plans[call++];
      if (plan === undefined) {
        throw new Error('scripted session exhausted: unexpected extra planner turn');
      }
      return {
        type: 'result',
        structured_output: plan,
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        total_cost_usd: 0.001,
      };
    },
  };
}

function makeStubbedPlanner(session) {
  const warns = [];
  const summaries = [];
  const recorded = [];
  const fakeLogger = {
    createSessionLog: () => ({ logPath: '/tmp/fake.jsonl', write: () => {}, close: () => {} }),
    attachToSession: () => {},
    writeSessionSummary: async (name, summary, meta) => { summaries.push({ name, summary, meta }); },
    warn: (msg) => { warns.push(String(msg)); },
  };
  const fakeSessionManager = { spawnReusable: () => session };
  const fakeTokenTracker = {
    recordSession: async (name, role, result, meta) => { recorded.push({ name, meta }); },
  };
  const planner = new Planner(fakeSessionManager, fakeLogger, fakeTokenTracker);
  planner._reusableSession = session;
  return { planner, warns, summaries, recorded };
}

function makeMissionPlan(targetFile) {
  return {
    subMissions: [{
      id: 'sm1',
      ordering: 'parallel',
      tasks: [{
        id: 't1',
        description: 'implement the change',
        targetFiles: [targetFile],
        testCases: [`node ${targetFile} exits 0`],
      }],
    }],
  };
}

// ── TC13 ──────────────────────────────────────────────────────────────────────

await test('TC13: retryable violation then clean plan converges in exactly two turns', async () => {
  const violating = makeMissionPlan('src/evil.js'); // scope excursion vs declared {src/good.js}
  const clean = makeMissionPlan('src/good.js');
  const session = makeScriptedSession([violating, clean]);
  const { planner, warns, summaries, recorded } = makeStubbedPlanner(session);

  const plan = await planner._planMissionReusable('001-001', '/fake/root', {
    missionPlan: 'mission plan text',
    specTargetFiles: ['src/good.js'],
  }, 7);

  assert.strictEqual(session.prompts.length, 2,
    `TC13: exactly TWO planner turns expected (initial + one corrective), got ${session.prompts.length}`);
  assert.strictEqual(plan.subMissions[0].tasks[0].targetFiles[0], 'src/good.js',
    'TC13: the corrected (second) plan must be the one returned');

  // The corrective message lists each violation: ruleId, task id, offending
  // text verbatim.
  const corrective = session.prompts[1];
  assert.ok(corrective.includes('scope-excursion'),
    'TC13: corrective turn prompt must name the violated ruleId (scope-excursion)');
  assert.ok(corrective.includes('src/evil.js'),
    'TC13: corrective turn prompt must carry the offending text verbatim (src/evil.js)');
  assert.ok(corrective.includes('t1'),
    'TC13: corrective turn prompt must name the violating task id (t1)');

  // Both turns run through the normal per-turn accounting.
  assert.strictEqual(recorded.length, 2,
    `TC13: recordSession must run once per turn (2 turns), got ${recorded.length}`);
  assert.strictEqual(summaries.length, 2,
    `TC13: writeSessionSummary must run once per turn (2 turns), got ${summaries.length}`);

  // [plan-lint-retry] line(s) via the planner's existing logger surface.
  const retryLines = warns.filter((w) => w.includes('[plan-lint-retry]'));
  assert.ok(retryLines.length >= 1,
    `TC13: at least one [plan-lint-retry] line must be emitted via this.logger.warn. Got warns: ${JSON.stringify(warns)}`);
});

// ── TC14 ──────────────────────────────────────────────────────────────────────

await test('TC14: violation then a second violation of any rule rethrows after exactly two turns', async () => {
  const violating = makeMissionPlan('src/evil.js'); // retryable: scope-excursion
  const stillBad = makeMissionPlan('src/good.js');
  stillBad.subMissions[0].tasks[0].testCases = [T2_CASE_A]; // second violation: T2
  const session = makeScriptedSession([violating, stillBad]);
  const { planner, warns } = makeStubbedPlanner(session);

  let thrown = null;
  try {
    await planner._planMissionReusable('001-001', '/fake/root', {
      missionPlan: 'mission plan text',
      specTargetFiles: ['src/good.js'],
    }, 7);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'TC14: the second violation must propagate');
  assert.strictEqual(thrown.ruleId, 'T2',
    `TC14: the SECOND violation's error must propagate (ruleId 'T2'), got '${thrown.ruleId}'`);
  assert.strictEqual(thrown.message,
    `[plan-structure-lint] task "t1" testCase "${T2_CASE_A}" asserts a ` +
    'literal tree-state shape (T2), which is out of scope for a task-level check',
    'TC14: the propagated message must stay byte-identical');
  assert.strictEqual(session.prompts.length, 2,
    `TC14: exactly TWO planner turns expected (retry budget is one), got ${session.prompts.length}`);
  const retryLines = warns.filter((w) => w.includes('[plan-lint-retry]'));
  assert.ok(retryLines.length >= 1,
    'TC14: the corrective turn and its outcome must be recorded via [plan-lint-retry] warn lines');
});

// ── TC15 ──────────────────────────────────────────────────────────────────────

await test('TC15: uncovered-token violation is never retried (exactly one turn)', async () => {
  const violating = makeMissionPlan('src/good.js'); // scoped command references src/other.js → uncovered
  const session = makeScriptedSession([violating]);
  const { planner } = makeStubbedPlanner(session);

  let thrown = null;
  try {
    await planner._planMissionReusable('001-001', '/fake/root', {
      missionPlan: 'mission plan text',
      specTargetFiles: UNCOVERED_SPEC_TARGETS,
      specAcceptanceCriteria: UNCOVERED_CRITERIA,
    }, 7);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'TC15: the uncovered-token violation must propagate');
  assert.strictEqual(thrown.ruleId, 'uncovered-token',
    `TC15: expected ruleId 'uncovered-token', got '${thrown.ruleId}'`);
  assert.strictEqual(session.prompts.length, 1,
    `TC15: exactly ONE planner turn expected (zero retries for uncovered-token), got ${session.prompts.length}`);
});

// ── TC16 ──────────────────────────────────────────────────────────────────────
// Existing behavior (passes today): an error WITHOUT a ruleId — the
// path-anchor validation throw — propagates exactly as before, no retry.

await test('TC16: a ruleId-less validation error propagates unchanged after one turn', async () => {
  const caseVariant = makeMissionPlan('src/Good.js'); // case-variant of spec-declared src/good.js
  const session = makeScriptedSession([caseVariant]);
  const { planner } = makeStubbedPlanner(session);

  let thrown = null;
  try {
    await planner._planMissionReusable('001-001', '/fake/root', {
      missionPlan: 'mission plan text',
      specTargetFiles: ['src/good.js'],
    }, 7);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'TC16: the path-anchor violation must propagate');
  assert.match(thrown.message, /path anchor violation/,
    `TC16: expected the existing path-anchor error, got: ${thrown.message}`);
  assert.strictEqual(thrown.ruleId, undefined,
    'TC16: path-anchor errors carry no ruleId (out of retry scope by spec)');
  assert.strictEqual(session.prompts.length, 1,
    `TC16: exactly ONE planner turn expected (no retry without ruleId), got ${session.prompts.length}`);
});

// ── TC17 ──────────────────────────────────────────────────────────────────────

await test('TC17: lintErrorClass maps ruleId-bearing errors to plan-lint:<ruleId>, plain errors to name', () => {
  assert.strictEqual(typeof lintErrorClass, 'function',
    'TC17: candidates-ledger.js must export lintErrorClass');

  const t1Err = new Error('[plan-structure-lint] some T1 violation');
  t1Err.ruleId = 'T1'; // duck-typed — NOT a PlanLintError instance
  assert.strictEqual(lintErrorClass(t1Err), 'plan-lint:T1',
    'TC17: a {ruleId:\'T1\'}-bearing error must map to \'plan-lint:T1\' (duck-typing, not instanceof)');

  const excursionErr = new Error('[plan-scope-lint] some excursion');
  excursionErr.ruleId = 'scope-excursion';
  assert.strictEqual(lintErrorClass(excursionErr), 'plan-lint:scope-excursion',
    'TC17: ruleId is interpolated into plan-lint:<ruleId>');

  assert.strictEqual(lintErrorClass(new Error('plain')), 'Error',
    'TC17: a plain Error (no ruleId) must map to its name');
  assert.strictEqual(lintErrorClass(new TypeError('typed')), 'TypeError',
    'TC17: a ruleId-less error maps to the error\'s name, whatever it is');
});

// ── TC18 ──────────────────────────────────────────────────────────────────────

await test('TC18: hashSignature distinguishes signatures differing only in errorClass', () => {
  const base = { phase: 'failed-plan', analyzerRecommendation: null, taskState: null };
  const h1 = hashSignature({ ...base, errorClass: 'plan-lint:T1' });
  const h2 = hashSignature({ ...base, errorClass: 'plan-lint:T2' });
  const h3 = hashSignature({ ...base, errorClass: 'Error' });
  assert.notStrictEqual(h1, h2, 'TC18: plan-lint:T1 vs plan-lint:T2 must hash differently');
  assert.notStrictEqual(h1, h3, 'TC18: plan-lint:T1 vs Error must hash differently');
  assert.notStrictEqual(h2, h3, 'TC18: plan-lint:T2 vs Error must hash differently');
  assert.strictEqual(h1, hashSignature({ ...base, errorClass: 'plan-lint:T1' }),
    'TC18: equal signatures must hash identically');
});

// ── AC4 — failed-plan candidates emit ────────────────────────────────────────
// Duck-typed invocation of the pipeline's failed-plan disposition arm
// (test-candidate-emit.js pattern): the injected _executeAllMilestones throws
// a planPhase-tagged error with a clean tree, which routes to the failed-plan
// leg and its candidates.jsonl emit.

/** Read archives/candidates.jsonl as an array of parsed records ([] when absent). */
function readCandidateLines(root) {
  const p = candidatesLedgerPath(root);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  return raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

// ── TC19 ──────────────────────────────────────────────────────────────────────

await test('TC19: failed-plan emit derives signature.errorClass via lintErrorClass (plan-lint:T1)', async () => {
  const root = makeGitRoot({ prefix: 'cc-plan-lint-retry-' });
  const slug = 'lint-fail-spec';
  try {
    createQueueEntry(root, slug, { plan: makePlan() });

    const lintErr = new Error(
      '[plan-structure-lint] task "t1" testCase "x" asserts a modification-status predicate (T1) referencing a file outside its own targetFiles',
    );
    lintErr.planPhase = true;
    lintErr.ruleId = 'T1'; // duck-typed classification — presence of ruleId, not instanceof
    lintErr.violations = [{ ruleId: 'T1', taskId: 't1', offending: 'x' }];

    const { pipeline } = makeRealBatchPipeline(root, {
      archive: async () => { throw new Error('TC19: archive() must not be called on the failed-plan leg'); },
      executeAllMilestones: async () => { throw lintErr; },
    });

    const result = await pipeline.batchResume({});

    const entry = readQueueEntry(root, slug);
    assert.ok(entry !== null, 'TC19: queue entry should still exist');
    assert.strictEqual(entry.status, 'failed-plan',
      `TC19: expected status 'failed-plan', got '${entry.status}'`);
    assert.strictEqual(result.failed, 1, `TC19: expected failed:1, got ${result.failed}`);

    const lines = readCandidateLines(root);
    assert.strictEqual(lines.length, 1,
      `TC19: expected exactly one candidates.jsonl line, got ${lines.length}`);

    const record = lines[0];
    const sigKeys = Object.keys(record.signature).sort();
    assert.deepStrictEqual(sigKeys, ['analyzerRecommendation', 'errorClass', 'phase', 'taskState'],
      `TC19: signature must be the exact four-field object. Got keys: ${JSON.stringify(sigKeys)}`);
    assert.strictEqual(record.signature.phase, 'failed-plan',
      `TC19: expected signature.phase 'failed-plan', got '${record.signature.phase}'`);
    assert.strictEqual(record.signature.errorClass, 'plan-lint:T1',
      `TC19: the failed-plan emit must derive errorClass via lintErrorClass ('plan-lint:T1'), got '${record.signature.errorClass}'`);
  } finally {
    cleanup(root);
  }
});

// ── TC20 ──────────────────────────────────────────────────────────────────────

await test('TC20: failed-plan emit records errorClass Error for a ruleId-less plan error', async () => {
  const root = makeGitRoot({ prefix: 'cc-plan-lint-retry-' });
  const slug = 'plain-plan-fail-spec';
  try {
    createQueueEntry(root, slug, { plan: makePlan() });

    const plainErr = new Error('planner exploded for a non-lint reason');
    plainErr.planPhase = true;

    const { pipeline } = makeRealBatchPipeline(root, {
      archive: async () => { throw new Error('TC20: archive() must not be called on the failed-plan leg'); },
      executeAllMilestones: async () => { throw plainErr; },
    });

    const result = await pipeline.batchResume({});

    const entry = readQueueEntry(root, slug);
    assert.ok(entry !== null, 'TC20: queue entry should still exist');
    assert.strictEqual(entry.status, 'failed-plan',
      `TC20: expected status 'failed-plan', got '${entry.status}'`);
    assert.strictEqual(result.failed, 1, `TC20: expected failed:1, got ${result.failed}`);

    const lines = readCandidateLines(root);
    assert.strictEqual(lines.length, 1,
      `TC20: expected exactly one candidates.jsonl line, got ${lines.length}`);
    assert.strictEqual(lines[0].signature.errorClass, 'Error',
      `TC20: a ruleId-less error must record its name ('Error'), got '${lines[0].signature.errorClass}'`);
  } finally {
    cleanup(root);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
