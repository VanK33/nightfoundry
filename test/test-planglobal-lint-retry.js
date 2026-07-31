#!/usr/bin/env node
/**
 * test-planglobal-lint-retry.js — Self-contained regression coverage for the
 * bounded plan-lint corrective-turn retry loop inside Planner.planGlobal
 * (task 001-001-001-003).
 *
 * planGlobal spawns a call-local reusable session (via
 * sessionManager.spawnReusable — NOT planner._reusableSession, which is
 * reserved for Phase 3b mission decomposition and is never pre-populated
 * here) and, on a retryable structural lint-rule rejection
 * ('structure-cap-missions' / 'structure-cap-milestones' /
 * 'declared-duplicate'; T1/T2 are unreachable at this call site because a
 * planGlobal-time plan carries no subMissions/tasks for lintTaskCheckShapes
 * to scan), sends exactly ONE corrective turn to the SAME session before
 * re-validating. A non-retryable ruleId (e.g. 'global-uncovered-token') or a
 * second violation of any rule propagates untouched. The call-local session
 * is always closed in planGlobal's finally block, on both the success and
 * the failure exit.
 *
 * Fake harness: sessionManager = { spawnReusable: () => fakeSession } is the
 * ONLY method exposed, so no code path here can reach a real SDK spawn.
 * fakeSession records every prompt, exposes turnCount/handle, counts
 * close() calls, and returns scripted SDK-shaped results
 * ({ type:'result', structured_output, usage, total_cost_usd }) from
 * sendPrompt.
 *
 * This file asserts ONLY planGlobal's own retry/propagation/close behavior
 * (cases a-d below) — no "X unchanged" / "existing tests still pass"
 * (T1/T2-shaped) assertions, and no "other tests still pass" claims.
 *
 * Run: node test/test-planglobal-lint-retry.js
 */
import assert from 'assert';
import { Planner } from '../src/orchestrator/agents/planner.js';

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

// ── Fake session/planner harness ──────────────────────────────────────────

/**
 * A scripted session: prompts[] records every sendPrompt() call verbatim,
 * turnCount tracks turns taken, closeCount tracks close() invocations, and
 * sendPrompt() returns the next plan from `plans` wrapped in an SDK-shaped
 * result. Exhausting `plans` (an unscripted extra turn) throws loudly rather
 * than silently returning undefined.
 */
function makeScriptedSession(plans) {
  const prompts = [];
  let call = 0;
  let turnCount = 0;
  let closeCount = 0;
  return {
    prompts,
    get turnCount() { return turnCount; },
    get closeCount() { return closeCount; },
    handle: { systemPromptTokens: 0, _toolCallCount: 0 },
    sendPrompt: async (prompt) => {
      prompts.push(String(prompt));
      turnCount++;
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
    close: async () => { closeCount++; },
  };
}

/**
 * Wraps a fake session in a stubbed Planner. The session manager exposes
 * ONLY spawnReusable — no other method exists, so any code path that tried
 * a real SDK spawn would throw TypeError immediately (see TC5).
 */
function makeStubbedPlanner(session) {
  const warns = [];
  const summaries = [];
  const recorded = [];
  const fakeLogger = {
    createSessionLog: () => ({ logPath: '/tmp/fake-planglobal-lint-retry.jsonl', write: () => {}, close: () => {} }),
    attachToSession: () => {},
    getSessionSummary: () => ({ fromLogFile: true }),
    writeSessionSummary: async (name, summary, meta) => { summaries.push({ name, summary, meta }); },
    warn: (msg) => { warns.push(String(msg)); },
  };
  const fakeSessionManager = { spawnReusable: () => session };
  const fakeTokenTracker = {
    recordSession: async (name, role, result, meta) => { recorded.push({ name, role, result, meta }); },
  };
  const planner = new Planner(fakeSessionManager, fakeLogger, fakeTokenTracker);
  return { planner, warns, summaries, recorded, fakeSessionManager };
}

// ── Plan fixtures ──────────────────────────────────────────────────────────
// planGlobal-time plans carry milestones[].missions[] only — never
// subMissions/tasks — so lintTaskCheckShapes (T1/T2) never sees anything to
// scan at this call site; only lintGlobalPlanScope and lintPlanStructure
// (L1/L2/L3) can reject a planGlobal-time plan.

/** Two missions in the same milestone declaring the SAME targetFile → declared-duplicate (L3, retryable). */
function makeDuplicatePlan(dupPath) {
  return {
    milestones: [{
      id: '001',
      description: 'Milestone one',
      missions: [
        { id: '001-001', description: 'Mission one', targetFiles: [dupPath] },
        { id: '001-002', description: 'Mission two', targetFiles: [dupPath] },
      ],
    }],
    assumptions: [],
    scopeMapping: [],
  };
}

/** A single mission with a distinct targetFile — passes every lint leg (with no opts.specAcceptanceCriteria). */
function cleanPlan() {
  return {
    milestones: [{
      id: '001',
      description: 'Milestone one',
      missions: [
        { id: '001-001', description: 'Mission one', targetFiles: ['src/good.js'] },
      ],
    }],
    assumptions: [],
    scopeMapping: [],
  };
}

/** A single mission whose targetFiles do NOT cover an acceptance-criterion command's referenced file. */
function makeUncoveredPlan() {
  return {
    milestones: [{
      id: '001',
      description: 'Milestone one',
      missions: [
        { id: '001-001', description: 'Mission one', targetFiles: ['src/file001.js'] },
      ],
    }],
    assumptions: [],
    scopeMapping: [],
  };
}

const UNCOVERED_OPTS = {
  specAcceptanceCriteria: [
    { description: 'other file passes', verification: { kind: 'command', command: 'node src/uncovered-target.js' } },
  ],
};

// ── TC1: case (a) — retryable structural violation then compliant plan ────

await test('TC1 (case a): declared-duplicate violation then compliant plan resolves in exactly two turns', async () => {
  const violating = makeDuplicatePlan('src/dupe.js');
  const clean = cleanPlan();
  const session = makeScriptedSession([violating, clean]);
  const { planner } = makeStubbedPlanner(session);

  const plan = await planner.planGlobal('goal text', '/fake/root');

  assert.strictEqual(plan, clean, 'TC1: planGlobal must resolve with the compliant (second) plan');
  assert.strictEqual(session.prompts.length, 2,
    `TC1: exactly TWO prompts must be sent on the same session, got ${session.prompts.length}`);
  assert.ok(session.prompts[1].includes('src/dupe.js'),
    `TC1: the second prompt must carry the offending text verbatim (src/dupe.js). Got: ${session.prompts[1]}`);
  assert.ok(session.prompts[1].includes('declared-duplicate'),
    `TC1: the second prompt must name the violated ruleId (declared-duplicate). Got: ${session.prompts[1]}`);
});

// ── TC2: case (b) — global-uncovered-token propagates with zero retries ───

await test('TC2 (case b): global-uncovered-token violation propagates after exactly one prompt', async () => {
  const session = makeScriptedSession([makeUncoveredPlan()]);
  const { planner } = makeStubbedPlanner(session);

  let thrown = null;
  try {
    await planner.planGlobal('goal text', '/fake/root', UNCOVERED_OPTS);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'TC2: the global-uncovered-token violation must propagate');
  assert.strictEqual(thrown.ruleId, 'global-uncovered-token',
    `TC2: expected err.ruleId 'global-uncovered-token', got '${thrown.ruleId}'`);
  assert.strictEqual(session.prompts.length, 1,
    `TC2: exactly ONE prompt expected (never retried), got ${session.prompts.length}`);
});

// ── TC3: case (c) — corrective turn still violates → second error propagates ──

await test('TC3 (case c): a still-violating corrective plan propagates the second error after exactly two prompts', async () => {
  const violating = makeDuplicatePlan('src/dupe.js');
  const stillBad = makeDuplicatePlan('src/dupe2.js'); // still declared-duplicate; retry budget already spent
  const session = makeScriptedSession([violating, stillBad]);
  const { planner } = makeStubbedPlanner(session);

  let thrown = null;
  try {
    await planner.planGlobal('goal text', '/fake/root');
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'TC3: the second violation must propagate');
  assert.strictEqual(thrown.ruleId, 'declared-duplicate',
    `TC3: expected the second violation's ruleId 'declared-duplicate', got '${thrown.ruleId}'`);
  assert.strictEqual(session.prompts.length, 2,
    `TC3: exactly TWO prompts expected (retry budget is one), got ${session.prompts.length}`);
});

// ── TC4: case (d) — the call-local session is closed on both exits ────────

await test('TC4 (case d): fakeSession.closeCount is 1 after both the success path and the failure path', async () => {
  // Success path, shaped like case (a).
  const violatingA = makeDuplicatePlan('src/dupe3.js');
  const cleanA = cleanPlan();
  const sessionA = makeScriptedSession([violatingA, cleanA]);
  const { planner: plannerA } = makeStubbedPlanner(sessionA);

  await plannerA.planGlobal('goal text', '/fake/root');
  assert.strictEqual(sessionA.closeCount, 1,
    `TC4: session.close() must be called exactly once on the success path, got ${sessionA.closeCount}`);

  // Failure path, shaped like case (b).
  const sessionB = makeScriptedSession([makeUncoveredPlan()]);
  const { planner: plannerB } = makeStubbedPlanner(sessionB);

  let thrown = null;
  try {
    await plannerB.planGlobal('goal text', '/fake/root', UNCOVERED_OPTS);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'TC4: the failure path must still throw');
  assert.strictEqual(sessionB.closeCount, 1,
    `TC4: session.close() must be called exactly once on the failure path, got ${sessionB.closeCount}`);
});

// ── TC5: the fake sessionManager exposes only spawnReusable ───────────────

await test('TC5: the fake sessionManager exposes only spawnReusable — no real SDK spawn path is reachable', () => {
  const session = makeScriptedSession([cleanPlan()]);
  const { fakeSessionManager } = makeStubbedPlanner(session);

  assert.deepStrictEqual(Object.keys(fakeSessionManager), ['spawnReusable'],
    `TC5: fakeSessionManager must expose EXACTLY spawnReusable, got keys: ${JSON.stringify(Object.keys(fakeSessionManager))}`);
  assert.strictEqual(typeof fakeSessionManager.spawn, 'undefined',
    'TC5: fakeSessionManager.spawn must not exist');
  assert.throws(() => fakeSessionManager.spawn(),
    /is not a function/,
    'TC5: invoking any real-SDK spawn method must throw TypeError, proving that path is unreachable here');
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
