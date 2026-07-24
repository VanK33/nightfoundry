/**
 * test-brainstorm-round-cap-transparency.js — AC3 for brainstormer adaptive
 * multi-round elicitation.
 *
 * Each round's question count is bounded INDEPENDENTLY by style.maxQuestions (a
 * per-round cap, NOT a shared cross-round budget). Capping lives in ONE home:
 * each propose method (proposeQuestions for round 1, proposeFollowups for the
 * follow-up rounds) caps its own ranked list AND returns the count it dropped
 * (omittedCount). When omittedCount > 0 for a round, the CLI surfaces a
 * disclosure of the form "asked top N; M omitted" for that round (rendered from
 * omittedCount, never re-capped as the load-bearing path). When omittedCount is
 * 0, no disclosure is shown.
 *
 * Tests are authored from the spec's acceptance criteria, NOT reverse-engineered
 * from the implementation. The disclosure wording is matched on its stable parts
 * ("asked top N" + "<M> ... omitted"), tolerating the spec's two phrasings
 * ("M omitted" / "M lower-priority omitted").
 *
 * Run: node test/test-brainstorm-round-cap-transparency.js
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

const USER_INPUT = 'Add a feature whose clarifying questions exceed the cap';

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
        restatement: { paraphrase: 'P', evidence: ['src/a.js'], unknowns: ['u'] },
        questions: round1.questions ?? [],
        assessedComplexity: round1.assessedComplexity ?? 'small',
        omittedCount: round1.omittedCount ?? 0,
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

function countAsked(reader) {
  return reader.prompts.filter((p) => p.trim() === '>').length;
}

/** Lines that look like a cap-truncation disclosure. */
function disclosureLines(out) {
  return out.split('\n').filter((l) => /asked top/i.test(l) && /omitted/i.test(l));
}

/** Assert a disclosure line surfaces "asked top <n>" together with "<m> ... omitted". */
function assertDisclosure(out, n, m, msg) {
  const lines = disclosureLines(out);
  const ok = lines.some((l) => new RegExp(`top\\s+${n}\\b`).test(l) && new RegExp(`\\b${m}\\b`).test(l));
  assert.ok(ok, `${msg} (wanted "asked top ${n}; ${m} ... omitted"; saw: ${JSON.stringify(lines)})`);
}

const STYLE = { maxQuestions: 3, maxRounds: 2 };

// ── AC3: round 1 truncation surfaces a disclosure from omittedCount ─────────────

test('AC3: a truncated round 1 surfaces "asked top N; M omitted" from omittedCount', async () => {
  const output = new PassThrough();
  const out = capture(output);
  // proposeQuestions already capped to 3 and dropped 2 (omittedCount:2). small
  // complexity → no follow-up loop, isolating the round-1 disclosure.
  const stub = makeStub({ round1: { questions: q(3, 'R1'), assessedComplexity: 'small', omittedCount: 2 } });
  const reader = makeReader(['y', 'a', 'a', 'a']);

  await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output });

  assertDisclosure(out(), 3, 2, 'round 1 must disclose its truncation');
});

// ── AC3: a truncated follow-up round surfaces its own disclosure ────────────────

test('AC3: a truncated follow-up round surfaces "asked top N; M omitted" from its omittedCount', async () => {
  const output = new PassThrough();
  const out = capture(output);
  const stub = makeStub({
    round1: { questions: q(1, 'R1'), assessedComplexity: 'large', omittedCount: 0 }, // no round-1 disclosure
    followups: [
      { done: false, integrationNote: 'n', questions: q(3, 'F'), omittedCount: 4 },
      { done: true, integrationNote: 'd', questions: [], omittedCount: 0 },
    ],
  });
  const reader = makeReader(['y', 'a', 'a', 'a', 'a']);

  await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output });

  assertDisclosure(out(), 3, 4, 'the follow-up round must disclose its truncation');
  // Round 1 had omittedCount 0 → exactly one disclosure line overall.
  assert.strictEqual(disclosureLines(out()).length, 1, 'only the truncated round (the follow-up) must disclose');
});

// ── AC3: per-round cap is INDEPENDENT, not a shared cross-round budget ───────────

test('AC3: each round is capped independently (per-round cap, not a shared budget)', async () => {
  const output = new PassThrough();
  const out = capture(output);
  // maxQuestions 3. Round 1 asks 3, the follow-up round also asks 3 → 6 total.
  // A shared cross-round budget of 3 would have starved the follow-up round.
  const stub = makeStub({
    round1: { questions: q(3, 'R1'), assessedComplexity: 'large', omittedCount: 1 },
    followups: [
      { done: false, integrationNote: 'n', questions: q(3, 'F'), omittedCount: 1 },
      { done: true, integrationNote: 'd', questions: [], omittedCount: 0 },
    ],
  });
  const reader = makeReader(['y', 'a', 'a', 'a', 'a', 'a', 'a']);

  await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output });

  assert.strictEqual(countAsked(reader), 6, 'both rounds must ask their full per-round cap of 3 (6 total) — not a shared budget');
  // Both rounds truncated → two disclosure lines.
  assert.strictEqual(disclosureLines(out()).length, 2, 'both truncated rounds must each disclose');
});

// ── AC3: no disclosure when nothing was omitted (omittedCount 0) ────────────────

test('AC3: a round with omittedCount 0 surfaces no disclosure', async () => {
  const output = new PassThrough();
  const out = capture(output);
  const stub = makeStub({ round1: { questions: q(2, 'R1'), assessedComplexity: 'small', omittedCount: 0 } });
  const reader = makeReader(['y', 'a', 'a']);

  await runElicitation({ brainstormer: stub, userInput: USER_INPUT, style: STYLE, reader, output });

  assert.strictEqual(disclosureLines(out()).length, 0, 'no truncation (omittedCount 0) must produce no disclosure');
});

// ── Summary ─────────────────────────────────────────────────────────────────────

Promise.all(allTests).then(() => {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
});
