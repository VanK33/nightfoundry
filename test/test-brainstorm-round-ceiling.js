/**
 * test-brainstorm-round-ceiling.js — AC2 for brainstormer adaptive multi-round
 * elicitation.
 *
 * The follow-up round ceiling is:
 *   effectiveCeiling = maxRounds === 0 ? 0 : min(map[assessedComplexity], maxRounds)
 * over the FIXED per-complexity map { trivial:0, small:0, medium:1, large:2 },
 * derived from the round-1 assessedComplexity and LOCKED there (not re-derived
 * per round). With the default maxRounds:2: trivial/small run 0 follow-up rounds,
 * medium at most 1, large at most 2. An agent done===true verdict can end the
 * loop before the ceiling. Lowering maxRounds throttles tiers above the cap
 * (maxRounds:1 caps large to 1); maxRounds:0 disables follow-ups entirely.
 *
 * Two layers are exercised:
 *   (a) the pure helper resolveRoundCeiling(assessedComplexity, style) directly,
 *   (b) the ceiling's effect on runElicitation (the load-bearing usage), via the
 *       returned roundCount (TOTAL rounds incl. round 1).
 *
 * Tests are authored from the spec's acceptance criteria, NOT reverse-engineered
 * from the implementation.
 *
 * Run: node test/test-brainstorm-round-ceiling.js
 */
import assert from 'node:assert';
import { PassThrough } from 'node:stream';

import { runElicitation } from '../src/cli/commands/brainstorm.js';

let passCount = 0;
let failCount = 0;
const allTests = [];

function test(name, fn) {
  const p = (async () => {
    try {
      await fn();
      console.log(`PASS  ${name}`);
      passCount++;
    } catch (err) {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
      failCount++;
    }
  })();
  allTests.push(p);
  return p;
}

const USER_INPUT = 'Build a thing of varying complexity';

/**
 * The pure ceiling helper has "one unit-testable home" (per the spec) but its
 * module is an implementation choice — it could be exported from the agent file
 * (brainstormer.js, alongside resolveMaxQuestions) or the CLI (brainstorm.js).
 * Resolve it from either so a correct implementation is not failed on location.
 */
async function loadResolveRoundCeiling() {
  const candidates = [
    '../src/orchestrator/agents/brainstormer.js',
    '../src/cli/commands/brainstorm.js',
  ];
  for (const c of candidates) {
    try {
      const mod = await import(c);
      if (typeof mod.resolveRoundCeiling === 'function') return mod.resolveRoundCeiling;
    } catch { /* ignore — try next candidate */ }
  }
  return null;
}

function q(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `${prefix}-${i}`, question: `${prefix}_Q${i}?`, premise: `p ${i}`, category: 'ambiguity', importance: n - i });
  }
  return out;
}

function makeStub({ round1 = {}, followups = [] } = {}) {
  const followupCalls = [];
  let fi = 0;
  return {
    followupCalls,
    proposeQuestions(_userInput, _opts = {}) {
      return Promise.resolve({
        restatement: { paraphrase: 'P', evidence: ['src/a.js'], unknowns: ['u'] },
        questions: round1.questions ?? q(1, 'R1'),
        assessedComplexity: round1.assessedComplexity ?? 'large',
        omittedCount: 0,
      });
    },
    proposeFollowups(_userInput, _restatement, _priorQA, _opts = {}) {
      followupCalls.push(1);
      const resp = typeof followups === 'function' ? followups(fi) : followups[fi];
      fi++;
      if (!resp) return Promise.resolve({ done: true, integrationNote: 'auto', questions: [], omittedCount: 0 });
      return Promise.resolve(resp);
    },
  };
}

function makeReader(answers) {
  const queue = [...answers];
  return { ask() { return Promise.resolve(queue.shift() ?? 'a'); }, close() {} };
}

const ALWAYS_MORE = (i) => ({ done: false, integrationNote: `n${i}`, questions: q(1, `F${i}`), omittedCount: 0 });

async function runWith({ complexity, style, followups }) {
  const output = new PassThrough();
  output.on('data', () => {});
  const stub = makeStub({ round1: { questions: q(1, 'R1'), assessedComplexity: complexity }, followups });
  const reader = makeReader(['y', 'a', 'a', 'a', 'a', 'a', 'a', 'a']);
  const res = await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style, reader, output });
  return { res, stub };
}

// ── AC2 (a): the pure helper holds the fixed map + applies the maxRounds cap ─────

test('AC2: resolveRoundCeiling maps complexity over {trivial:0, small:0, medium:1, large:2} with maxRounds:2', async () => {
  const fn = await loadResolveRoundCeiling();
  assert.ok(fn, 'resolveRoundCeiling must be exported (from brainstormer.js or brainstorm.js)');
  assert.strictEqual(fn('trivial', { maxRounds: 2 }), 0, 'trivial → 0');
  assert.strictEqual(fn('small', { maxRounds: 2 }), 0, 'small → 0');
  assert.strictEqual(fn('medium', { maxRounds: 2 }), 1, 'medium → 1');
  assert.strictEqual(fn('large', { maxRounds: 2 }), 2, 'large → 2');
});

test('AC2: resolveRoundCeiling with maxRounds:0 disables follow-ups for every tier', async () => {
  const fn = await loadResolveRoundCeiling();
  assert.ok(fn, 'resolveRoundCeiling must be exported');
  assert.strictEqual(fn('large', { maxRounds: 0 }), 0, 'maxRounds:0 → 0 even for large');
  assert.strictEqual(fn('medium', { maxRounds: 0 }), 0, 'maxRounds:0 → 0 even for medium');
});

test('AC2: resolveRoundCeiling with maxRounds:1 throttles tiers above the cap', async () => {
  const fn = await loadResolveRoundCeiling();
  assert.ok(fn, 'resolveRoundCeiling must be exported');
  assert.strictEqual(fn('large', { maxRounds: 1 }), 1, 'maxRounds:1 caps large to 1');
  assert.strictEqual(fn('medium', { maxRounds: 1 }), 1, 'min(1,1) = 1');
  assert.strictEqual(fn('small', { maxRounds: 1 }), 0, 'small stays 0 regardless of the cap');
});

test('AC2: resolveRoundCeiling defaults maxRounds from config when style omits it', async () => {
  const fn = await loadResolveRoundCeiling();
  assert.ok(fn, 'resolveRoundCeiling must be exported');
  // The config default for maxRounds is 2, so large with no explicit maxRounds → 2.
  assert.strictEqual(fn('large', { maxQuestions: 5 }), 2, 'large defaults to the config maxRounds (2)');
});

// ── AC2 (b): the ceiling bounds how many follow-up rounds runElicitation runs ────

test('AC2: small complexity runs 0 follow-up rounds (proposeFollowups never called)', async () => {
  const { res, stub } = await runWith({ complexity: 'small', style: { maxQuestions: 5, maxRounds: 2 }, followups: ALWAYS_MORE });
  assert.strictEqual(stub.followupCalls.length, 0, 'small (ceiling 0) must not spawn any follow-up round');
  assert.strictEqual(res.roundCount, 1, 'roundCount must be 1 (round 1 only)');
});

test('AC2: medium complexity runs at most 1 follow-up round (default maxRounds:2)', async () => {
  const { res, stub } = await runWith({ complexity: 'medium', style: { maxQuestions: 5, maxRounds: 2 }, followups: ALWAYS_MORE });
  assert.strictEqual(stub.followupCalls.length, 1, 'medium (ceiling 1) must stop after one follow-up round');
  assert.strictEqual(res.roundCount, 2, 'roundCount must be 2 (round 1 + one follow-up)');
});

test('AC2: large complexity runs at most 2 follow-up rounds (default maxRounds:2)', async () => {
  const { res, stub } = await runWith({ complexity: 'large', style: { maxQuestions: 5, maxRounds: 2 }, followups: ALWAYS_MORE });
  assert.strictEqual(stub.followupCalls.length, 2, 'large (ceiling 2) must stop after two follow-up rounds');
  assert.strictEqual(res.roundCount, 3, 'roundCount must be 3 (round 1 + two follow-ups)');
});

test('AC2: an agent done===true verdict ends the loop before the ceiling', async () => {
  const { res } = await runWith({
    complexity: 'large', // ceiling 2
    style: { maxQuestions: 5, maxRounds: 2 },
    followups: [
      { done: false, integrationNote: 'n', questions: q(1, 'F0'), omittedCount: 0 },
      { done: true, integrationNote: 'd', questions: [], omittedCount: 0 },
    ],
  });
  assert.strictEqual(res.roundCount, 2, 'done on the 2nd follow-up call ends at roundCount 2 (below the ceiling of 3 total)');
});

test('AC2: lowering maxRounds to 1 caps large to a single follow-up round', async () => {
  const { res, stub } = await runWith({ complexity: 'large', style: { maxQuestions: 5, maxRounds: 1 }, followups: ALWAYS_MORE });
  assert.strictEqual(stub.followupCalls.length, 1, 'maxRounds:1 caps large to one follow-up round');
  assert.strictEqual(res.roundCount, 2, 'roundCount must be 2 (round 1 + one follow-up)');
});

test('AC2: maxRounds:0 disables the follow-up loop even for large complexity', async () => {
  const { res, stub } = await runWith({ complexity: 'large', style: { maxQuestions: 5, maxRounds: 0 }, followups: ALWAYS_MORE });
  assert.strictEqual(stub.followupCalls.length, 0, 'maxRounds:0 must disable the follow-up loop entirely');
  assert.strictEqual(res.roundCount, 1, 'roundCount must be 1 (round 1 only) when follow-ups are disabled');
});

// ── Summary ─────────────────────────────────────────────────────────────────────

Promise.all(allTests).then(() => {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
});
