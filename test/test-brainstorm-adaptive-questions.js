/**
 * test-brainstorm-adaptive-questions.js — AC2 for brainstormer frame-first
 * elicitation.
 *
 * After frame confirmation, the brainstormer asks clarifying questions:
 *   - ONE AT A TIME (each question is its own prompt to the reader),
 *   - ordered by importance DESCENDING,
 *   - each rendered WITH the premise/assumption that motivates it,
 *   - and a trivial request (0–1 questions) asks few/zero.
 *
 * Tests are authored from the spec's acceptance criteria + the pinned interface
 * contract, NOT reverse-engineered from the implementation.
 *
 * Run: node test/test-brainstorm-adaptive-questions.js
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

const STYLE = { maxQuestions: 5 };
const USER_INPUT = 'Add a feature';

/**
 * Records each ask() prompt so we can assert one-at-a-time prompting and
 * per-question premise rendering. Each ask() resolves to the next queued line.
 */
function makeRecordingReader(answers) {
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

/**
 * proposeQuestions stub returning a fixed restatement plus the given questions.
 */
function makePropose(questions) {
  function proposeQuestions(_userInput, _opts = {}) {
    return Promise.resolve({
      restatement: {
        paraphrase: 'A paraphrased understanding of the request.',
        evidence: ['src/foo.js'],
        unknowns: ['unknown one'],
      },
      questions,
      assessedComplexity: 'moderate',
    });
  }
  return proposeQuestions;
}

// ── AC2: ordered by importance descending ───────────────────────────────────────

test('AC2: questions are asked ordered by importance descending', async () => {
  // Deliberately unsorted input — the contract says proposeQuestions returns
  // them sorted, but the elicitation render must surface highest-importance
  // first regardless. We feed a sorted-by-contract list and assert the order in
  // which they are PROMPTED matches importance DESC.
  const questions = [
    { id: 'qA', question: 'Highest importance question?', premise: 'premise-A', category: 'ambiguity', importance: 9 },
    { id: 'qB', question: 'Middle importance question?', premise: 'premise-B', category: 'boundary', importance: 5 },
    { id: 'qC', question: 'Lowest importance question?', premise: 'premise-C', category: 'non-goal', importance: 1 },
  ];

  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c.toString()));

  // 'y' confirms frame; then three answers, one per question.
  const reader = makeRecordingReader(['y', 'a1', 'a2', 'a3']);

  await runElicitation({
    brainstormer: { proposeQuestions: makePropose(questions) },
    userInput: USER_INPUT,
    style: STYLE,
    reader,
    output,
  });

  const out = chunks.join('');
  const idxA = out.indexOf('Highest importance question?');
  const idxB = out.indexOf('Middle importance question?');
  const idxC = out.indexOf('Lowest importance question?');

  assert.ok(idxA !== -1 && idxB !== -1 && idxC !== -1, 'all three questions must be rendered');
  assert.ok(idxA < idxB, 'highest-importance question must be asked before the middle one');
  assert.ok(idxB < idxC, 'middle-importance question must be asked before the lowest one');
});

// ── AC2: one at a time (distinct prompts per question) ───────────────────────────

test('AC2: questions are asked ONE AT A TIME (a separate prompt per question)', async () => {
  const questions = [
    { id: 'q1', question: 'First question text?', premise: 'p1', category: 'ambiguity', importance: 9 },
    { id: 'q2', question: 'Second question text?', premise: 'p2', category: 'boundary', importance: 5 },
  ];

  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c.toString()));
  const reader = makeRecordingReader(['y', 'ans1', 'ans2']);

  await runElicitation({
    brainstormer: { proposeQuestions: makePropose(questions) },
    userInput: USER_INPUT,
    style: STYLE,
    reader,
    output,
  });

  const out = chunks.join('');
  // Each question's text is rendered exactly once — not batched into a single
  // combined render.
  assert.strictEqual((out.match(/First question text\?/g) || []).length, 1, 'first question must be rendered exactly once');
  assert.strictEqual((out.match(/Second question text\?/g) || []).length, 1, 'second question must be rendered exactly once');
  // One ask() per question: the question text is rendered to output and the
  // answer collected via a bare prompt, so there is exactly one bare answer
  // prompt per question — proving one-at-a-time rather than a single combined ask.
  const answerPrompts = reader.prompts.filter((p) => p.trim() === '>');
  assert.strictEqual(answerPrompts.length, questions.length, 'each question must be asked on its own turn (one bare answer prompt per question)');
});

// ── AC2: each question rendered WITH its premise ─────────────────────────────────

test('AC2: each question is presented with the premise/assumption motivating it', async () => {
  const questions = [
    { id: 'q1', question: 'What is the cap unit?', premise: 'PREMISE-FIRST: vendor docs not in repo', category: 'ambiguity', importance: 9 },
    { id: 'q2', question: 'Queue or reject bursts?', premise: 'PREMISE-SECOND: burst policy undefined', category: 'failure-scenario', importance: 5 },
  ];

  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c.toString()));

  const reader = makeRecordingReader(['y', 'ans1', 'ans2']);

  await runElicitation({
    brainstormer: { proposeQuestions: makePropose(questions) },
    userInput: USER_INPUT,
    style: STYLE,
    reader,
    output,
  });

  const out = chunks.join('');
  assert.ok(out.includes('PREMISE-FIRST: vendor docs not in repo'), 'first question must render its premise');
  assert.ok(out.includes('PREMISE-SECOND: burst policy undefined'), 'second question must render its premise');
});

// ── AC2: trivial request → few/zero questions ───────────────────────────────────

test('AC2: a trivial request (zero questions) asks no clarifying questions', async () => {
  const output = new PassThrough();
  const reader = makeRecordingReader(['y']); // only the frame confirmation

  const result = await runElicitation({
    brainstormer: { proposeQuestions: makePropose([]) },
    userInput: 'rename a variable',
    style: STYLE,
    reader,
    output,
  });

  // No clarifying-question prompts beyond the frame confirmation.
  // After 'y', there must be no further ask() consuming a question answer.
  const answers = result?.answers ?? [];
  assert.strictEqual(answers.length, 0, 'a zero-question trivial request must collect no answers');
});

test('AC2: a trivial request with a single question asks exactly one', async () => {
  const questions = [
    { id: 'q1', question: 'Only one thing to clarify?', premise: 'p', category: 'ambiguity', importance: 7 },
  ];
  const output = new PassThrough();
  const reader = makeRecordingReader(['y', 'the answer']);

  const result = await runElicitation({
    brainstormer: { proposeQuestions: makePropose(questions) },
    userInput: 'small ask',
    style: STYLE,
    reader,
    output,
  });

  const answers = result?.answers ?? [];
  assert.strictEqual(answers.length, 1, 'a single-question request must collect exactly one answer');
});

// ── Summary ─────────────────────────────────────────────────────────────────────

Promise.all(allTests).then(() => {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
});
