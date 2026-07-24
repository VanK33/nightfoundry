/**
 * test-brainstorm-multi-round-loop.js — AC1 for brainstormer adaptive
 * multi-round elicitation.
 *
 * After round 1's answers on a new TTY brainstorm, the agent is asked to judge
 * follow-ups (proposeFollowups). The loop:
 *   - asks a further round when the agent reports done !== true with new
 *     questions AND the ceiling allows,
 *   - terminates on the FIRST of: done === true, zero new questions, or the
 *     round ceiling,
 *   - SHORT-CIRCUITS on done === true WITHOUT asking any questions the agent
 *     also returned,
 *   - tests done === true STRICTLY (a string "false" is truthy but is NOT a
 *     done verdict — the loop must keep going),
 *   - gracefully degrades on a follow-up-round failure (stop the loop and draft
 *     from the Q&A collected so far, without discarding answers or aborting),
 *   - while a round-1 (proposeQuestions) failure STILL throws hard.
 *
 * Tests are authored from the spec's acceptance criteria + the pinned interface
 * contract, NOT reverse-engineered from the implementation.
 *
 * Pinned contract used here:
 *   proposeFollowups(userInput, restatement, priorQA, { style })
 *     → { done: boolean, integrationNote: string, questions: [...], omittedCount }
 *   runElicitation returns { answers, ..., roundCount, questionsPerRound }
 *
 * Run: node test/test-brainstorm-multi-round-loop.js
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

const USER_INPUT = 'Add a branching multi-step workflow engine';

/** Build `n` greppable questions, importance DESC (Q0 highest). */
function q(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `${prefix}-${i}`,
      question: `${prefix}_Q${i}?`,
      premise: `premise ${prefix} ${i}`,
      category: 'ambiguity',
      importance: n - i,
    });
  }
  return out;
}

/**
 * Stub exposing proposeQuestions (round 1) + proposeFollowups (rounds 2..N).
 *   round1:    { restatement?, questions?, assessedComplexity?, omittedCount?, __throw? }
 *   followups: array of responses OR (callIndex) => response.
 *              A response is { done, integrationNote, questions, omittedCount }
 *              or { __throw: true } to reject. When the script is exhausted the
 *              stub returns a terminating done:true so a runaway loop is bounded.
 */
function makeStub({ round1 = {}, followups = [] } = {}) {
  const proposeCalls = [];
  const followupCalls = [];
  let fi = 0;
  return {
    proposeCalls,
    followupCalls,
    proposeQuestions(userInput, opts = {}) {
      proposeCalls.push({ userInput, opts });
      if (round1.__throw) return Promise.reject(new Error('round-1 boom'));
      return Promise.resolve({
        restatement: round1.restatement ?? { paraphrase: 'PARAPHRASE_MARK', evidence: ['src/a.js'], unknowns: ['u'] },
        questions: round1.questions ?? [],
        assessedComplexity: round1.assessedComplexity ?? 'large',
        omittedCount: round1.omittedCount ?? 0,
      });
    },
    proposeFollowups(userInput, restatement, priorQA, opts = {}) {
      followupCalls.push({ userInput, restatement, priorQA, opts });
      const resp = typeof followups === 'function' ? followups(fi) : followups[fi];
      fi++;
      if (!resp) return Promise.resolve({ done: true, integrationNote: 'auto-done', questions: [], omittedCount: 0 });
      if (resp.__throw) return Promise.reject(new Error('follow-up boom'));
      return Promise.resolve(resp);
    },
  };
}

function makeReader(answers) {
  const queue = [...answers];
  const prompts = [];
  return {
    prompts,
    ask(question) {
      prompts.push(question);
      return Promise.resolve(queue.shift() ?? '');
    },
    close() {},
  };
}

function capture(output) {
  const chunks = [];
  output.on('data', (c) => chunks.push(c.toString()));
  return () => chunks.join('');
}

const STYLE = { maxQuestions: 5, maxRounds: 2 };

// ── AC1: a follow-up round is asked + answered when done!==true with new Qs ─────

test('AC1: done!==true with new questions asks a further round, accumulated into answers', async () => {
  const output = new PassThrough();
  const out = capture(output);
  const stub = makeStub({
    round1: { questions: q(2, 'R1'), assessedComplexity: 'large' },
    followups: [
      { done: false, integrationNote: 'note', questions: q(2, 'R2'), omittedCount: 0 },
      { done: true, integrationNote: 'done', questions: [], omittedCount: 0 },
    ],
  });
  const reader = makeReader(['y', 'a1', 'a2', 'b1', 'b2', 'extra']);

  const res = await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output });

  assert.ok(stub.followupCalls.length >= 1, 'proposeFollowups must be called after round 1');
  assert.ok(out().includes('R2_Q0?'), 'a follow-up round 2 question must be asked (rendered)');
  assert.strictEqual(res.answers.length, 4, 'answers must accumulate round 1 (2) + follow-up round (2) = 4');
  assert.ok(res.answers.some((a) => a.question === 'R2_Q0?'), 'the follow-up question must be in the accumulated answers');
});

// ── AC1: proposeFollowups receives the round-1 restatement + accumulated priorQA ─

test('AC1: proposeFollowups is invoked with the round-1 restatement and accumulated priorQA', async () => {
  const output = new PassThrough();
  capture(output);
  const stub = makeStub({
    round1: { questions: q(2, 'R1'), assessedComplexity: 'large' },
    followups: [{ done: true, integrationNote: 'done', questions: [], omittedCount: 0 }],
  });
  const reader = makeReader(['y', 'ans-one', 'ans-two']);

  await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output });

  assert.strictEqual(stub.followupCalls.length, 1, 'proposeFollowups must be called once');
  const call = stub.followupCalls[0];
  assert.ok(call.restatement && typeof call.restatement.paraphrase === 'string', 'the round-1 restatement object must be passed');
  assert.ok(Array.isArray(call.priorQA), 'priorQA must be an array');
  assert.strictEqual(call.priorQA.length, 2, 'priorQA must carry the 2 round-1 answers');
  assert.ok(call.priorQA.some((qa) => qa.question === 'R1_Q0?'), 'priorQA must include the round-1 Q&A');
  assert.ok(call.opts && call.opts.style, 'proposeFollowups must receive the style object');
});

// ── AC1: done === true short-circuits WITHOUT asking the returned questions ──────

test('AC1: done === true short-circuits without asking any questions it also returned', async () => {
  const output = new PassThrough();
  const out = capture(output);
  const stub = makeStub({
    round1: { questions: q(1, 'R1'), assessedComplexity: 'large' },
    // done:true alongside questions — the loop must NOT ask SC_Q0?.
    followups: [{ done: true, integrationNote: 'wrapped', questions: q(1, 'SC'), omittedCount: 0 }],
  });
  const reader = makeReader(['y', 'a1', 'should-not-be-consumed']);

  const res = await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output });

  assert.strictEqual(stub.followupCalls.length, 1, 'proposeFollowups must be called exactly once');
  assert.ok(!out().includes('SC_Q0?'), 'a done===true verdict must NOT ask the questions it returned');
  assert.strictEqual(res.answers.length, 1, 'only the round-1 answer must be collected');
});

// ── AC1: zero new questions terminates the loop ────────────────────────────────

test('AC1: a follow-up round returning zero questions terminates the loop', async () => {
  const output = new PassThrough();
  capture(output);
  const stub = makeStub({
    round1: { questions: q(1, 'R1'), assessedComplexity: 'large' },
    followups: [{ done: false, integrationNote: 'nothing-new', questions: [], omittedCount: 0 }],
  });
  const reader = makeReader(['y', 'a1', 'unused']);

  const res = await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output });

  assert.strictEqual(stub.followupCalls.length, 1, 'zero new questions must stop the loop after one follow-up call');
  assert.strictEqual(res.answers.length, 1, 'no further answers collected when the follow-up returns zero questions');
});

// ── AC1: the ceiling terminates the loop (medium → at most 1 follow-up round) ────

test('AC1: the round ceiling terminates the loop even when the agent keeps returning questions', async () => {
  const output = new PassThrough();
  capture(output);
  const stub = makeStub({
    round1: { questions: q(1, 'R1'), assessedComplexity: 'medium' }, // ceiling 1
    followups: (i) => ({ done: false, integrationNote: `n${i}`, questions: q(1, `F${i}`), omittedCount: 0 }),
  });
  const reader = makeReader(['y', 'a1', 'a2', 'a3', 'a4']);

  const res = await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output });

  assert.strictEqual(stub.followupCalls.length, 1, 'medium ceiling (1) must stop after exactly one follow-up round');
  assert.strictEqual(res.answers.length, 2, 'round 1 (1) + one follow-up round (1) = 2 answers');
});

// ── AC1: done is STRICT — a string "false" is NOT a done verdict ────────────────

test('AC1: done is tested strictly (done === true); a string "false" does NOT terminate', async () => {
  const output = new PassThrough();
  const out = capture(output);
  const stub = makeStub({
    round1: { questions: q(1, 'R1'), assessedComplexity: 'large' },
    followups: [
      // `"false"` is truthy: a truthy check would mis-terminate and skip these
      // questions. A strict `done === true` keeps going and asks them.
      { done: 'false', integrationNote: 'n', questions: q(1, 'STRICT'), omittedCount: 0 },
      { done: true, integrationNote: 'd', questions: [], omittedCount: 0 },
    ],
  });
  const reader = makeReader(['y', 'a1', 'a2', 'extra']);

  const res = await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output });

  assert.ok(out().includes('STRICT_Q0?'), 'a non-boolean done ("false") must NOT terminate — its questions must be asked');
  assert.strictEqual(res.answers.length, 2, 'round 1 (1) + the strict-continued follow-up round (1) = 2 answers');
});

// ── AC1: a follow-up failure gracefully degrades (no abort, keep collected Q&A) ──

test('AC1: a follow-up-round failure stops the loop and drafts from the Q&A so far without aborting', async () => {
  const output = new PassThrough();
  capture(output);
  const stub = makeStub({
    round1: { questions: q(2, 'R1'), assessedComplexity: 'large' },
    followups: [{ __throw: true }], // proposeFollowups rejects
  });
  const reader = makeReader(['y', 'a1', 'a2', 'unused']);

  let res;
  await assert.doesNotReject(async () => {
    res = await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output });
  }, 'a follow-up failure must NOT propagate — it degrades to drafting');

  assert.strictEqual(stub.followupCalls.length, 1, 'the failing follow-up must have been attempted exactly once');
  assert.strictEqual(res.answers.length, 2, 'the already-collected round-1 answers must be preserved (not discarded)');
});

// ── AC1: a round-1 (proposeQuestions) failure STILL throws hard ─────────────────

test('AC1: a round-1 proposeQuestions failure still throws (throw-hard contract retained)', async () => {
  const output = new PassThrough();
  capture(output);
  const stub = makeStub({ round1: { __throw: true } });
  const reader = makeReader(['y']);

  await assert.rejects(
    () => runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output }),
    'a round-1 failure must propagate (round 1 keeps its throw-hard contract)',
  );
});

// ── Summary ─────────────────────────────────────────────────────────────────────

Promise.all(allTests).then(() => {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
});
