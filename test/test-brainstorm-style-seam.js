/**
 * test-brainstorm-style-seam.js — AC3 for brainstormer frame-first elicitation.
 *
 * The number of questions asked is bounded by `style.maxQuestions`:
 *   - the stub returns MORE questions than the cap; only `maxQuestions` are asked,
 *   - the cap value originates from the `config.elicitation` default (maxQuestions),
 *   - and it is overridable purely via the style seam (changing style.maxQuestions
 *     changes the count with no other change),
 *   - the agent's core prompt contains NO hardcoded question-count literal.
 *
 * Tests are authored from the spec's acceptance criteria + the pinned interface
 * contract, NOT reverse-engineered from the implementation.
 *
 * Run: node test/test-brainstorm-style-seam.js
 */
import assert from 'node:assert';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';

import config from '../src/orchestrator/infra/config.js';
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

const USER_INPUT = 'Add a feature with many dimensions';

function makeRecordingReader(answers) {
  const queue = [...answers];
  return {
    askedQuestions: [],
    ask(question) {
      this.askedQuestions.push(question);
      return Promise.resolve(queue.shift() ?? '');
    },
    close() {},
  };
}

/**
 * Returns a proposeQuestions stub that ALWAYS returns `n` questions, each with a
 * distinct, greppable question string. The implementation is responsible for
 * truncating to style.maxQuestions; this stub does NOT pre-truncate so the test
 * can prove the cap is applied by the elicitation seam.
 */
function makeProposeReturning(n) {
  const questions = [];
  for (let i = 0; i < n; i++) {
    questions.push({
      id: `q${i}`,
      question: `QUESTION_MARKER_${i}?`,
      premise: `premise ${i}`,
      category: 'ambiguity',
      importance: n - i, // already importance-descending
    });
  }
  function proposeQuestions(_userInput, _opts = {}) {
    return Promise.resolve({
      restatement: { paraphrase: 'paraphrased', evidence: ['src/foo.js'], unknowns: ['u'] },
      questions,
      assessedComplexity: 'complex',
    });
  }
  return proposeQuestions;
}

// Each clarifying question is collected via exactly one bare answer prompt
// ('> '); the question text itself is rendered to output, not the ask prompt.
// Counting the bare answer prompts therefore counts how many questions were
// asked (the frame-confirm 'Choice:' prompt and any n/p sub-prompts are not
// bare '>' so they are not counted).
function countAsked(reader) {
  return reader.askedQuestions.filter((p) => p.trim() === '>').length;
}

// ── AC3: config.elicitation default exists and provides maxQuestions ─────────────

test('AC3: config.elicitation default provides a numeric maxQuestions', () => {
  assert.ok(config.elicitation && typeof config.elicitation === 'object', 'config.elicitation must exist');
  assert.strictEqual(typeof config.elicitation.maxQuestions, 'number', 'config.elicitation.maxQuestions must be a number');
  assert.ok(config.elicitation.maxQuestions > 0, 'config.elicitation.maxQuestions must be positive');
});

// ── AC3: count is bounded by style.maxQuestions (stub returns more than the cap) ─

test('AC3: when the stub returns more questions than the cap, only style.maxQuestions are asked', async () => {
  const cap = 3;
  const output = new PassThrough();
  // 'y' to confirm frame + an answer for each of the capped questions.
  const reader = makeRecordingReader(['y', 'a', 'a', 'a', 'a', 'a', 'a', 'a']);

  await runElicitation({
    brainstormer: { proposeQuestions: makeProposeReturning(10) }, // 10 > cap
    userInput: USER_INPUT,
    style: { maxQuestions: cap },
    reader,
    output,
  });

  const asked = countAsked(reader);
  assert.strictEqual(asked, cap, `exactly ${cap} questions must be asked when ${cap} < returned count; got ${asked}`);
});

// ── AC3: the cap is overridable purely via the style seam ────────────────────────

test('AC3: changing only style.maxQuestions changes the number of questions asked', async () => {
  // Same stub (returns 10), two different style caps → two different counts.
  const out1 = new PassThrough();
  const reader1 = makeRecordingReader(['y', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a']);
  await runElicitation({
    brainstormer: { proposeQuestions: makeProposeReturning(10) },
    userInput: USER_INPUT,
    style: { maxQuestions: 2 },
    reader: reader1,
    output: out1,
  });

  const out2 = new PassThrough();
  const reader2 = makeRecordingReader(['y', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a', 'a']);
  await runElicitation({
    brainstormer: { proposeQuestions: makeProposeReturning(10) },
    userInput: USER_INPUT,
    style: { maxQuestions: 4 },
    reader: reader2,
    output: out2,
  });

  assert.strictEqual(countAsked(reader1), 2, 'style.maxQuestions=2 must ask 2 questions');
  assert.strictEqual(countAsked(reader2), 4, 'style.maxQuestions=4 must ask 4 questions');
});

// ── AC3: fewer returned than the cap → all are asked (cap is a ceiling, not a floor) ─

test('AC3: when fewer questions are returned than the cap, all returned questions are asked', async () => {
  const output = new PassThrough();
  const reader = makeRecordingReader(['y', 'a', 'a']);
  await runElicitation({
    brainstormer: { proposeQuestions: makeProposeReturning(2) }, // 2 < cap 5
    userInput: USER_INPUT,
    style: { maxQuestions: 5 },
    reader,
    output,
  });
  assert.strictEqual(countAsked(reader), 2, 'maxQuestions is a ceiling; fewer returned means all are asked');
});

// ── AC3: the agent core prompt contains no hardcoded question-count literal ──────

test('AC3: the agent core/system prompt contains no hardcoded question-count literal', () => {
  // Read the brainstormer source and isolate the system prompt constant. The
  // spec forbids welding a question cap (a literal count) into the agent's core
  // prompt text — the personalization value must come from the style seam.
  const src = fs.readFileSync(
    new URL('../src/orchestrator/agents/brainstormer.js', import.meta.url),
    'utf8',
  );

  // Pull out the BRAINSTORMER_SYSTEM_PROMPT template-literal body if present.
  const m = src.match(/BRAINSTORMER_SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`/);
  const systemPrompt = m ? m[1] : src;

  // No phrasing like "ask 5 questions" / "at most 3 questions" / "5 clarifying
  // questions" — i.e. a digit adjacent to the word "question(s)" (either order).
  const countNearQuestion = /\b\d+\b[^\n.]{0,40}\bquestions?\b|\bquestions?\b[^\n.]{0,40}\b\d+\b/i;
  assert.ok(
    !countNearQuestion.test(systemPrompt),
    `agent core prompt must not hardcode a question-count literal; matched: ${JSON.stringify((systemPrompt.match(countNearQuestion) || [])[0])}`,
  );
});

// ── Summary ─────────────────────────────────────────────────────────────────────

Promise.all(allTests).then(() => {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
});
