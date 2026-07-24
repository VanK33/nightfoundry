/**
 * test-brainstorm-multiround-style-telemetry.js — AC5 for brainstormer adaptive
 * multi-round elicitation.
 *
 * Covers the style seam + telemetry + fast-path bundle:
 *   - maxRounds (default 2) and questionVerbosity (default 'normal') originate
 *     from config.elicitation and are threaded through the style object — no
 *     hardcoded round/verbosity literals welded into the agent's core prompt.
 *   - maxRounds:0 disables the follow-up loop (TTY stays single-round
 *     frame-first); batch / non-TTY one-shot behavior stays byte-identical
 *     (no elicitation calls at all).
 *   - the round-1 assessedComplexity is surfaced to the user once (after framing
 *     confirmation, before the first question), and a zero-question / trivial
 *     round 1 takes the informational fast-path straight to drafting.
 *   - the initialize history entry records roundCount (TOTAL rounds incl. round 1)
 *     and questionsPerRound (index 0 = round 1); questionCount / answerCount are
 *     cross-round totals.
 *
 * Tests are authored from the spec's acceptance criteria, NOT reverse-engineered
 * from the implementation.
 *
 * Run: node test/test-brainstorm-multiround-style-telemetry.js
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { PassThrough } from 'node:stream';

import config from '../src/orchestrator/infra/config.js';
import { runElicitation, brainstorm } from '../src/cli/commands/brainstorm.js';

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

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-mr-telemetry-')); }
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

const STUB_SPEC = {
  goal: 'stub',
  target_files: ['x'],
  acceptance_criteria: [{ description: 'd', verification: { kind: 'command', command: 'node x', targetFile: 'x' } }],
};
const DIGEST = { scopeOut: ['s'], assumptions: ['a1', 'a2'], risks: ['r'] };

function q(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `${prefix}-${i}`, question: `${prefix}_Q${i}?`, premise: `p ${i}`, category: 'ambiguity', importance: n - i });
  }
  return out;
}

// ── runElicitation-level stub (style + fast-path + surface tests) ───────────────

function makeStub({ round1 = {}, followups = [] } = {}) {
  const followupCalls = [];
  let fi = 0;
  return {
    followupCalls,
    proposeQuestions(_userInput, _opts = {}) {
      return Promise.resolve({
        restatement: { paraphrase: 'PARAPHRASE_MARK', evidence: ['src/a.js'], unknowns: ['u'] },
        questions: round1.questions ?? [],
        assessedComplexity: round1.assessedComplexity ?? 'large',
        omittedCount: round1.omittedCount ?? 0,
      });
    },
    proposeFollowups(_userInput, _restatement, _priorQA, opts = {}) {
      followupCalls.push({ opts });
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

function capturingReader(answers) {
  const queue = [...answers];
  const prompts = [];
  return { prompts, ask(question) { prompts.push(question); return Promise.resolve(queue.shift() ?? 'a'); }, close() {} };
}

function capture(output) {
  const chunks = [];
  output.on('data', (c) => chunks.push(c.toString()));
  return () => chunks.join('');
}

// ── full brainstorm() factory (history telemetry tests) ─────────────────────────

function multiRoundFactory({ round1Questions, complexity, followups, digest = DIGEST }) {
  const proposeCalls = [];
  const followupCalls = [];
  let fi = 0;
  const factory = () => ({
    proposeQuestions(userInput, opts = {}) {
      proposeCalls.push({ userInput, opts });
      return Promise.resolve({
        restatement: { paraphrase: 'P', evidence: ['src/foo.js'], unknowns: ['u'] },
        questions: round1Questions,
        assessedComplexity: complexity,
        omittedCount: 0,
      });
    },
    proposeFollowups(userInput, restatement, priorQA, opts = {}) {
      followupCalls.push({ userInput, restatement, priorQA, opts });
      const resp = typeof followups === 'function' ? followups(fi) : (followups ?? [])[fi];
      fi++;
      if (!resp) return Promise.resolve({ done: true, integrationNote: 'auto', questions: [], omittedCount: 0 });
      return Promise.resolve(resp);
    },
    initialize(_userInput, _opts = {}) {
      return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub', digest });
    },
    revise(_c, _f, _m) {
      return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub', digest });
    },
  });
  return { factory, proposeCalls, followupCalls };
}

function readInitializeEntry(dir) {
  const raw = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8');
  const entries = raw.trim().split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const init = entries.find((e) => e.mode === 'initialize');
  assert.ok(init, 'history must contain an initialize entry');
  return init;
}

// ── AC5: config defaults exist (maxRounds 2, questionVerbosity 'normal') ─────────

test('AC5: config.elicitation provides maxRounds:2 and questionVerbosity:"normal"', () => {
  assert.strictEqual(config.elicitation.maxRounds, 2, 'config.elicitation.maxRounds default must be 2');
  assert.strictEqual(config.elicitation.questionVerbosity, 'normal', "config.elicitation.questionVerbosity default must be 'normal'");
});

// ── AC5: personalization values are threaded through the style object ───────────

test('AC5: maxRounds + questionVerbosity are threaded to proposeFollowups via the style object', async () => {
  const output = new PassThrough();
  capture(output);
  const style = { maxQuestions: 5, maxRounds: 2, questionVerbosity: 'terse' };
  const stub = makeStub({
    round1: { questions: q(1, 'R1'), assessedComplexity: 'large' },
    followups: [
      { done: false, integrationNote: 'n', questions: q(1, 'F'), omittedCount: 0 },
      { done: true, integrationNote: 'd', questions: [], omittedCount: 0 },
    ],
  });
  const reader = makeReader(['y', 'a', 'a']);

  await runElicitation({ brainstormer: stub, userInput: 'x', style, reader, output });

  assert.ok(stub.followupCalls.length >= 1, 'proposeFollowups must be called');
  const threaded = stub.followupCalls[0].opts.style;
  assert.ok(threaded, 'proposeFollowups must receive a style object');
  assert.strictEqual(threaded.maxRounds, 2, 'maxRounds must be threaded through the style object');
  assert.strictEqual(threaded.questionVerbosity, 'terse', 'questionVerbosity must be threaded through the style object');
});

// ── AC5: no hardcoded round/verbosity literals in the agent's core prompts ───────

test('AC5: no hardcoded round-count literal is welded into any agent SYSTEM_PROMPT', () => {
  const src = fs.readFileSync(new URL('../src/orchestrator/agents/brainstormer.js', import.meta.url), 'utf8');
  // Pull every `*_SYSTEM_PROMPT = `...`` template-literal body (covers the
  // round-1 propose prompt and any new follow-up prompt regardless of name).
  const bodies = [...src.matchAll(/[A-Z][A-Z0-9_]*SYSTEM_PROMPT\s*=\s*`([\s\S]*?)`/g)].map((m) => m[1]);
  assert.ok(bodies.length >= 1, 'at least one SYSTEM_PROMPT constant must be present');
  const roundCountLiteral = /\b\d+\b[^\n.]{0,30}\brounds?\b|\brounds?\b[^\n.]{0,30}\b\d+\b/i;
  for (const body of bodies) {
    const m = body.match(roundCountLiteral);
    assert.ok(!m, `a SYSTEM_PROMPT must not hardcode a round-count literal; matched: ${JSON.stringify(m && m[0])}`);
  }
});

// ── AC5: maxRounds:0 disables the follow-up loop on the TTY path ─────────────────

test('AC5: maxRounds:0 disables the follow-up loop (TTY stays single-round)', async () => {
  const output = new PassThrough();
  capture(output);
  const stub = makeStub({
    round1: { questions: q(1, 'R1'), assessedComplexity: 'large' },
    followups: (i) => ({ done: false, integrationNote: `n${i}`, questions: q(1, `F${i}`), omittedCount: 0 }),
  });
  const reader = makeReader(['y', 'a', 'a']);

  const res = await runElicitation({ brainstormer: stub, userInput: 'x', style: { maxQuestions: 5, maxRounds: 0 }, reader, output });

  assert.strictEqual(stub.followupCalls.length, 0, 'maxRounds:0 must spawn no follow-up rounds');
  assert.strictEqual(res.roundCount, 1, 'roundCount must be 1 (round 1 only) when follow-ups are disabled');
});

// ── AC5: the round-1 assessedComplexity is surfaced after framing, before Q1 ─────

test('AC5: the round-1 assessedComplexity is surfaced ("Assessed complexity: <tier>") before the first question', async () => {
  const output = new PassThrough();
  const out = capture(output);
  const stub = makeStub({ round1: { questions: q(2, 'R1'), assessedComplexity: 'medium' }, followups: [{ done: true, integrationNote: 'd', questions: [], omittedCount: 0 }] });
  const reader = makeReader(['y', 'a', 'a']);

  await runElicitation({ brainstormer: stub, userInput: 'x', style: { maxQuestions: 5, maxRounds: 2 }, reader, output });

  const text = out();
  const idxComplexity = text.indexOf('Assessed complexity: medium');
  const idxParaphrase = text.indexOf('PARAPHRASE_MARK');
  const idxFirstQuestion = text.indexOf('R1_Q0?');
  assert.ok(idxComplexity !== -1, 'the assessed complexity line must be surfaced');
  assert.ok(idxParaphrase !== -1 && idxParaphrase < idxComplexity, 'complexity must be surfaced after the framing restatement');
  assert.ok(idxFirstQuestion !== -1 && idxComplexity < idxFirstQuestion, 'complexity must be surfaced before the first question');
});

// ── AC5: a zero-question / trivial round 1 takes the informational fast-path ─────

test('AC5: a zero-question / trivial round 1 takes the fast-path to drafting (no follow-up loop)', async () => {
  const output = new PassThrough();
  const out = capture(output);
  const stub = makeStub({ round1: { questions: [], assessedComplexity: 'trivial' }, followups: (i) => ({ done: false, integrationNote: `n${i}`, questions: q(1, `F${i}`), omittedCount: 0 }) });
  const reader = makeReader(['y']);

  const res = await runElicitation({ brainstormer: stub, userInput: 'rename a var', style: { maxQuestions: 5, maxRounds: 2 }, reader, output });

  assert.ok(/no clarifying questions needed/i.test(out()), 'the trivial fast-path informational line must be printed');
  assert.strictEqual(stub.followupCalls.length, 0, 'the trivial fast-path must skip the follow-up loop entirely');
  assert.strictEqual(res.answers.length, 0, 'a zero-question round 1 collects no answers');
  assert.strictEqual(res.roundCount, 1, 'roundCount must be 1 even for a zero-question round 1');
});

// ── AC5: history records roundCount + questionsPerRound (multi-round run) ─────────

test('AC5: the initialize history entry records roundCount and questionsPerRound across rounds', async () => {
  const d = tempDir();
  try {
    const { factory } = multiRoundFactory({
      round1Questions: q(2, 'R1'),
      complexity: 'large',
      followups: [
        { done: false, integrationNote: 'n', questions: q(3, 'F'), omittedCount: 0 },
        { done: true, integrationNote: 'd', questions: [], omittedCount: 0 },
      ],
    });

    const input = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;
    // y (confirm) + 2 round-1 answers + 3 follow-up answers + a (accept).
    input.write('y\nr1a\nr1b\nf1\nf2\nf3\na\n');

    const result = await brainstorm(d, ['Add a thing'], {}, {
      brainstormerFactory: factory,
      input,
      output: outputStream,
      style: { maxQuestions: 5, maxRounds: 2, questionVerbosity: 'normal' },
    });

    const init = readInitializeEntry(result.dir);
    assert.strictEqual(init.roundCount, 2, 'roundCount must be 2 (round 1 + one follow-up round)');
    assert.deepStrictEqual(init.questionsPerRound, [2, 3], 'questionsPerRound must be [round1=2, followup=3]');
    assert.strictEqual(init.questionCount, 5, 'questionCount must be the cross-round total (2 + 3 = 5)');
    assert.strictEqual(init.answerCount, 5, 'answerCount must be the cross-round total (5)');
  } finally {
    cleanup(d);
  }
});

// ── AC5: history records roundCount:1 + questionsPerRound:[0] for a trivial run ──

test('AC5: a trivial (zero-question) run records roundCount:1 and questionsPerRound:[0]', async () => {
  const d = tempDir();
  try {
    const { factory, followupCalls } = multiRoundFactory({
      round1Questions: [],
      complexity: 'trivial',
      followups: [],
    });

    const input = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;
    input.write('y\na\n'); // confirm frame, then accept the draft

    const result = await brainstorm(d, ['Tiny change'], {}, {
      brainstormerFactory: factory,
      input,
      output: outputStream,
      style: { maxQuestions: 5, maxRounds: 2, questionVerbosity: 'normal' },
    });

    const init = readInitializeEntry(result.dir);
    assert.strictEqual(followupCalls.length, 0, 'a trivial run must not spawn follow-up rounds');
    assert.strictEqual(init.roundCount, 1, 'roundCount must be 1 (round 1 ran, even with zero questions)');
    assert.deepStrictEqual(init.questionsPerRound, [0], 'questionsPerRound must be [0] (round 1 asked zero questions)');
    assert.strictEqual(init.questionCount, 0, 'questionCount must be 0');
    assert.strictEqual(init.answerCount, 0, 'answerCount must be 0');
  } finally {
    cleanup(d);
  }
});

// ── AC5: batch / non-TTY one-shot behavior stays byte-identical (no elicitation) ─

test('AC5: non-TTY / batch mode runs no elicitation (no proposeQuestions, no proposeFollowups)', async () => {
  const d = tempDir();
  try {
    const { factory, proposeCalls, followupCalls } = multiRoundFactory({
      round1Questions: q(1, 'R1'),
      complexity: 'large',
      followups: [{ done: false, integrationNote: 'n', questions: q(1, 'F'), omittedCount: 0 }],
    });

    const output = new PassThrough();
    await brainstorm(d, ['Add a thing'], { 'no-tty': true }, {
      brainstormerFactory: factory,
      output,
    });

    assert.strictEqual(proposeCalls.length, 0, 'batch mode must not call proposeQuestions (byte-identical one-shot path)');
    assert.strictEqual(followupCalls.length, 0, 'batch mode must not call proposeFollowups (no multi-round in non-TTY)');
  } finally {
    cleanup(d);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────────

Promise.all(allTests).then(() => {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
});
