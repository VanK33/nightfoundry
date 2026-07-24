/**
 * test-brainstorm-frame-first.js — AC1 for brainstormer frame-first elicitation.
 *
 * On a new TTY brainstorm, BEFORE any spec is drafted, the brainstormer must
 * present an intent restatement that:
 *   (a) paraphrases the request in its own words — NOT a verbatim echo,
 *   (b) cites repo evidence (file references) for claims about existing code,
 *   (c) explicitly lists what it could not determine / had to guess, and
 *   (d) offers confirm / reject-and-restate / partially-correct affordances,
 *       AND the `n` (reject-and-restate) path can reject the framing entirely —
 *       it re-runs proposeQuestions with the user's corrected intent rather
 *       than proceeding straight to the draft.
 *
 * Tests are authored from the spec's acceptance criteria + the pinned interface
 * contract, NOT reverse-engineered from the implementation.
 *
 * Run: node test/test-brainstorm-frame-first.js
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * A buffered line reader compatible with the one the CLI builds internally:
 * `ask(question)` writes the prompt to output and resolves to the next queued
 * line. Lines pushed before ask() is registered are buffered (mirrors the real
 * createLineReader semantics used in test-brainstorm-cli.js).
 */
function makeReader(lines, output) {
  const queue = [...lines];
  return {
    ask(question) {
      if (output) output.write(question);
      return Promise.resolve(queue.shift() ?? '');
    },
    close() {},
  };
}

const USER_INPUT = 'Add a rate limiter to the HTTP client so we stop hammering the vendor API';

/**
 * A proposeQuestions stub whose restatement is deliberately a paraphrase
 * (distinct from USER_INPUT), with concrete repo-evidence file references and
 * an explicit unknowns list. Records every call's userInput.
 */
function makeProposeStub({ paraphrase, evidence, unknowns, questions } = {}) {
  const calls = [];
  function proposeQuestions(userInput, opts = {}) {
    calls.push({ userInput, opts });
    return Promise.resolve({
      restatement: {
        paraphrase: paraphrase ?? 'You want client-side throttling so outbound calls stay under the vendor cap.',
        evidence: evidence ?? ['src/http/client.js', 'src/http/index.js'],
        unknowns: unknowns ?? ['Whether the cap is per-second or per-minute', 'Whether bursts should be queued or rejected'],
      },
      questions: questions ?? [
        { id: 'q1', question: 'Per-second or per-minute cap?', premise: 'The vendor docs were not found in-repo.', category: 'ambiguity', importance: 9 },
      ],
      assessedComplexity: 'moderate',
    });
  }
  return { proposeQuestions, calls };
}

const STYLE = { maxQuestions: 5 };

// ── AC1(a): paraphrase, not a verbatim echo ─────────────────────────────────────

test('AC1(a): restatement paraphrase is rendered and is NOT a verbatim echo of the user input', async () => {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c.toString()));

  const paraphrase = 'You want client-side throttling so outbound calls stay under the vendor cap.';
  const { proposeQuestions } = makeProposeStub({ paraphrase });

  // 'y' confirms the frame, then a single empty answer for the lone question.
  const reader = makeReader(['y', ''], output);

  await runElicitation({
    brainstormer: { proposeQuestions },
    userInput: USER_INPUT,
    style: STYLE,
    reader,
    output,
  });

  const out = chunks.join('');
  assert.ok(out.includes(paraphrase), 'rendered output must show the paraphrase');
  // The paraphrase must differ from the raw input — the spec forbids a verbatim echo.
  assert.notStrictEqual(paraphrase, USER_INPUT, 'paraphrase must not equal the raw user input');
  // The raw user input must not be echoed back verbatim as the restatement.
  assert.ok(!out.includes(USER_INPUT), 'output must NOT echo the user input verbatim as the restatement');
});

// ── AC1(b): repo evidence is shown ──────────────────────────────────────────────

test('AC1(b): restatement shows repo evidence (file references)', async () => {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c.toString()));

  const evidence = ['src/http/client.js', 'src/http/index.js'];
  const { proposeQuestions } = makeProposeStub({ evidence });
  const reader = makeReader(['y', ''], output);

  await runElicitation({
    brainstormer: { proposeQuestions },
    userInput: USER_INPUT,
    style: STYLE,
    reader,
    output,
  });

  const out = chunks.join('');
  for (const ev of evidence) {
    assert.ok(out.includes(ev), `output must cite repo evidence "${ev}"`);
  }
});

// ── AC1(c): explicit unknowns / guesses list is shown ───────────────────────────

test('AC1(c): restatement explicitly lists unknowns / things it had to guess', async () => {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c.toString()));

  const unknowns = ['Whether the cap is per-second or per-minute', 'Whether bursts should be queued or rejected'];
  const { proposeQuestions } = makeProposeStub({ unknowns });
  const reader = makeReader(['y', ''], output);

  await runElicitation({
    brainstormer: { proposeQuestions },
    userInput: USER_INPUT,
    style: STYLE,
    reader,
    output,
  });

  const out = chunks.join('');
  for (const u of unknowns) {
    assert.ok(out.includes(u), `output must surface the unknown/guess "${u}"`);
  }
});

// ── AC1(d): confirm / reject / partially-correct affordances offered ────────────

test('AC1(d): output offers confirm / reject-and-restate / partially-correct affordances (y / n / p)', async () => {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c.toString()));

  const { proposeQuestions } = makeProposeStub();
  const reader = makeReader(['y', ''], output);

  await runElicitation({
    brainstormer: { proposeQuestions },
    userInput: USER_INPUT,
    style: STYLE,
    reader,
    output,
  });

  const out = chunks.join('');
  // The three affordances must be discoverable: confirm, reject-and-restate,
  // partially-correct, surfaced via the y / n / p keys.
  assert.ok(/\by\b/.test(out), 'output must offer the confirm (y) affordance');
  assert.ok(/\bn\b/.test(out), 'output must offer the reject-and-restate (n) affordance');
  assert.ok(/\bp\b/.test(out), 'output must offer the partially-correct (p) affordance');
});

// ── AC1(d): the `n` path can reject the framing and re-run proposeQuestions ──────

test('AC1(d): choosing `n` (reject) re-runs proposeQuestions with the corrected intent, not straight to draft', async () => {
  const output = new PassThrough();

  const { proposeQuestions, calls } = makeProposeStub();

  const corrected = 'Actually it is an outbound webhook dispatcher, not an HTTP client';
  // n → reject → prompt for corrected intent → 'y' to confirm the re-framed
  // restatement → '' answer for the lone question.
  const reader = makeReader(['n', corrected, 'y', ''], output);

  await runElicitation({
    brainstormer: { proposeQuestions },
    userInput: USER_INPUT,
    style: STYLE,
    reader,
    output,
  });

  // proposeQuestions must have been called at least twice — once for the
  // initial frame and again after the user rejected it with a correction.
  assert.ok(calls.length >= 2, `proposeQuestions must re-run after reject; got ${calls.length} call(s)`);
  // The re-run must carry the user's corrected intent via the dedicated
  // `correction` channel (opts.correction) — the authoritative re-framing input,
  // NOT concatenated into the verbatim userInput (which stays the original ask).
  const reran = calls.slice(1).some((c) => typeof c.opts?.correction === 'string' && c.opts.correction.includes(corrected));
  assert.ok(reran, 'the reject path must re-run proposeQuestions with the corrected intent via opts.correction');
});

// ── AC1(d): rejecting does NOT short-circuit to draft (no answers collected pre-confirm) ──

test('AC1(d): a frame the user never confirms does not silently proceed — reject loops back to restatement', async () => {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (c) => chunks.push(c.toString()));

  const { proposeQuestions, calls } = makeProposeStub({ paraphrase: 'First framing.' });

  // Reject once with a correction, then confirm the second framing.
  const reader = makeReader(['n', 'corrected intent here', 'y', ''], output);

  await runElicitation({
    brainstormer: { proposeQuestions },
    userInput: USER_INPUT,
    style: STYLE,
    reader,
    output,
  });

  // Two restatements must have been produced (initial + re-framed) — the reject
  // looped back to a fresh restatement rather than advancing to questions/draft.
  assert.ok(calls.length >= 2, 'reject must loop back to a fresh restatement (proposeQuestions re-run)');
});

// ── Summary ─────────────────────────────────────────────────────────────────────

Promise.all(allTests).then(() => {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
});
