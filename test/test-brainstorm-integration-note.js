/**
 * test-brainstorm-integration-note.js — AC4 for brainstormer adaptive
 * multi-round elicitation.
 *
 * Each follow-up round opens with:
 *   (a) a one-line round header `Follow-up round k of up to N` (k = the
 *       follow-up round index, N = the effective ceiling), and
 *   (b) a one-line INFORMATIONAL integration restatement of the agent's updated
 *       understanding given prior answers (the proposeFollowups integrationNote),
 * presented with NO confirm/reject affordance — the user corrects via the next
 * round's answers, not via a y/n/p prompt. The reject/confirm escape hatch stays
 * a round-1-only, pre-question affair.
 *
 * Tests are authored from the spec's acceptance criteria, NOT reverse-engineered
 * from the implementation. The header string is treated as the contract per the
 * spec's quoted wording.
 *
 * Run: node test/test-brainstorm-integration-note.js
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

const USER_INPUT = 'Add a multi-round feature with follow-up rounds';

function q(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `${prefix}-${i}`, question: `${prefix}_Q${i}?`, premise: `p ${i}`, category: 'ambiguity', importance: n - i });
  }
  return out;
}

function makeStub({ round1 = {}, followups = [] } = {}) {
  let fi = 0;
  return {
    proposeQuestions(_userInput, _opts = {}) {
      return Promise.resolve({
        restatement: { paraphrase: 'PARAPHRASE_MARK', evidence: ['src/a.js'], unknowns: ['u'] },
        questions: round1.questions ?? q(1, 'R1'),
        assessedComplexity: round1.assessedComplexity ?? 'large',
        omittedCount: 0,
      });
    },
    proposeFollowups(_userInput, _restatement, _priorQA, _opts = {}) {
      const resp = typeof followups === 'function' ? followups(fi) : followups[fi];
      fi++;
      if (!resp) return Promise.resolve({ done: true, integrationNote: 'auto', questions: [], omittedCount: 0 });
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
      return Promise.resolve(queue.shift() ?? 'a');
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

// ── AC4: each follow-up round opens with the "Follow-up round k of up to N" header ─

test('AC4: each follow-up round opens with a "Follow-up round k of up to N" header', async () => {
  const output = new PassThrough();
  const out = capture(output);
  // large + maxRounds:2 → ceiling N = 2; two follow-up rounds run.
  const stub = makeStub({
    round1: { questions: q(1, 'R1'), assessedComplexity: 'large' },
    followups: [
      { done: false, integrationNote: 'NOTE-ONE', questions: q(1, 'F1'), omittedCount: 0 },
      { done: false, integrationNote: 'NOTE-TWO', questions: q(1, 'F2'), omittedCount: 0 },
      { done: true, integrationNote: 'done', questions: [], omittedCount: 0 },
    ],
  });
  const reader = makeReader(['y', 'r1', 'f1', 'f2']);

  await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output });

  const text = out();
  // k progression (unambiguous): the two follow-up rounds are numbered 1 then 2.
  assert.ok(/Follow-up round 1 of up to/.test(text), 'the first follow-up round must show "Follow-up round 1 of up to ..."');
  assert.ok(/Follow-up round 2 of up to/.test(text), 'the second follow-up round must show "Follow-up round 2 of up to ..."');
  // N = the effective ceiling (2 for large + maxRounds:2).
  assert.ok(text.includes('Follow-up round 1 of up to 2'), 'the header N must be the effective ceiling (2)');
});

// ── AC4: each follow-up round renders its informational integration restatement ──

test('AC4: each follow-up round renders the agent integration restatement (integrationNote)', async () => {
  const output = new PassThrough();
  const out = capture(output);
  const stub = makeStub({
    round1: { questions: q(1, 'R1'), assessedComplexity: 'large' },
    followups: [
      { done: false, integrationNote: 'INTEGRATION_NOTE_ALPHA', questions: q(1, 'F1'), omittedCount: 0 },
      { done: false, integrationNote: 'INTEGRATION_NOTE_BETA', questions: q(1, 'F2'), omittedCount: 0 },
      { done: true, integrationNote: 'done', questions: [], omittedCount: 0 },
    ],
  });
  const reader = makeReader(['y', 'r1', 'f1', 'f2']);

  await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output });

  const text = out();
  assert.ok(text.includes('INTEGRATION_NOTE_ALPHA'), 'the first follow-up round must render its integration restatement');
  assert.ok(text.includes('INTEGRATION_NOTE_BETA'), 'the second follow-up round must render its integration restatement');
});

// ── AC4: the integration restatement carries NO confirm/reject affordance ────────

test('AC4: follow-up rounds present NO confirm/reject affordance (the y/n/p escape hatch is round-1 only)', async () => {
  const output = new PassThrough();
  const out = capture(output);
  const stub = makeStub({
    round1: { questions: q(1, 'R1'), assessedComplexity: 'large' },
    followups: [
      { done: false, integrationNote: 'NOTE-ONE', questions: q(1, 'F1'), omittedCount: 0 },
      { done: false, integrationNote: 'NOTE-TWO', questions: q(1, 'F2'), omittedCount: 0 },
      { done: true, integrationNote: 'done', questions: [], omittedCount: 0 },
    ],
  });
  const reader = makeReader(['y', 'r1', 'f1', 'f2']);

  await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output });

  const text = out();
  // The frame-first confirm/reject legend must appear EXACTLY ONCE (round 1's
  // pre-question framing). Two follow-up rounds adding affordances would push
  // these counts above 1.
  assert.strictEqual(
    (text.match(/Is this understanding correct\?/g) || []).length,
    1,
    'the confirm/reject legend must render exactly once (round-1 framing only)',
  );
  assert.strictEqual(
    (text.match(/let me restate what I actually want/g) || []).length,
    1,
    'the reject-and-restate affordance must render exactly once (round-1 framing only)',
  );
  // The only confirm "Choice:" prompt during elicitation is the round-1 frame.
  const choicePrompts = reader.prompts.filter((p) => /Choice:/i.test(p));
  assert.strictEqual(choicePrompts.length, 1, 'follow-up rounds must NOT prompt a confirm/reject "Choice:" (round-1 frame only)');
});

// ── Summary ─────────────────────────────────────────────────────────────────────

Promise.all(allTests).then(() => {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
});
