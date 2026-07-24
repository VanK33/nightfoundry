/**
 * test-brainstorm-telemetry.js — AC3 for brainstormer understanding-playback
 * digest.
 *
 * Per-turn brainstorm history records elicitation telemetry on the initialize
 * turn: counts of questions asked, answers collected, assumptions surfaced, and
 * the assessed complexity tier. The pre-existing history fields (turn, ts, mode,
 * input, specHash) remain.
 *
 * Pinned contract:
 *   - runElicitation returns { answers, correction, assessedComplexity }.
 *   - The initialize-turn appendHistory entry gains questionCount, answerCount,
 *     assumptionCount, complexityTier.
 *   - assumptionCount comes from the digest's assumptions list; complexityTier
 *     from the elicitation's assessedComplexity; questionCount from the number
 *     of questions asked; answerCount from the number of answers collected.
 *
 * Tests are authored from the spec's acceptance criteria + the pinned interface
 * contract, NOT reverse-engineered from the implementation.
 *
 * Run: node test/test-brainstorm-telemetry.js
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { PassThrough } from 'node:stream';

import { brainstorm } from '../src/cli/commands/brainstorm.js';

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

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-telemetry-')); }
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

const STUB_SPEC = {
  goal: 'stub',
  target_files: ['x'],
  acceptance_criteria: [{ description: 'd', verification: { kind: 'command', command: 'node x', targetFile: 'x' } }],
};

// proposeQuestions asks 2 questions and reports a 'medium' complexity tier;
// initialize emits a digest with 3 assumptions. The CLI weaves answers, then
// records the initialize-turn telemetry.
const QUESTIONS = [
  { id: 'q1', question: 'Per-second or per-minute cap?', premise: 'docs not found', category: 'ambiguity', importance: 9 },
  { id: 'q2', question: 'Queue or reject bursts?', premise: 'unspecified', category: 'boundary', importance: 8 },
];
const DIGEST = {
  scopeOut: ['out-of-scope thing'],
  assumptions: ['assumption one', 'assumption two', 'assumption three'],
  risks: ['a risk'],
};
const ASSESSED_COMPLEXITY = 'medium';

function telemetryFactory() {
  return {
    proposeQuestions(_userInput, _opts = {}) {
      return Promise.resolve({
        restatement: { paraphrase: 'A paraphrase.', evidence: ['src/foo.js'], unknowns: ['something'] },
        questions: QUESTIONS,
        assessedComplexity: ASSESSED_COMPLEXITY,
      });
    },
    initialize(_userInput, _opts = {}) {
      return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub', digest: DIGEST });
    },
    revise(_currentSpec, _feedback, _mode) {
      return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub', digest: DIGEST });
    },
  };
}

/** Read and parse history.jsonl; return all entries in order. */
function readHistory(dir) {
  const raw = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8');
  const lines = raw.trim().split('\n').filter((l) => l.trim());
  assert.ok(lines.length >= 1, 'history.jsonl must have at least one entry');
  return lines.map((l) => JSON.parse(l));
}

/** Read and parse history.jsonl; return the first (initialize) entry. */
function readInitializeEntry(dir) {
  const init = readHistory(dir).find((e) => e.mode === 'initialize');
  assert.ok(init, 'history must contain an initialize entry');
  return init;
}

/** Read and parse history.jsonl; return the last revise (regenerate/edit) entry. */
function readLastReviseEntry(dir) {
  const revises = readHistory(dir).filter((e) => e.mode === 'regenerate' || e.mode === 'edit');
  assert.ok(revises.length >= 1, 'history must contain at least one revise entry');
  return revises[revises.length - 1];
}

// ── AC3: initialize history entry carries the telemetry counts + tier ────────

test('AC3: initialize history entry records questionCount, answerCount, assumptionCount, complexityTier', async () => {
  const d = tempDir();
  try {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // 'y' confirms the frame; two answers for the two questions; 'a' accepts.
    inputStream.write('y\nanswer one\nanswer two\na\n');

    const result = await brainstorm(d, ['Add a rate limiter'], {}, {
      brainstormerFactory: telemetryFactory,
      input: inputStream,
      output: outputStream,
    });

    const init = readInitializeEntry(result.dir);

    assert.strictEqual(init.questionCount, QUESTIONS.length, 'questionCount must equal the number of questions asked (2)');
    assert.strictEqual(init.answerCount, 2, 'answerCount must equal the number of answers collected (2)');
    assert.strictEqual(init.assumptionCount, DIGEST.assumptions.length, 'assumptionCount must equal the digest assumptions count (3)');
    assert.strictEqual(init.complexityTier, ASSESSED_COMPLEXITY, "complexityTier must equal the elicitation's assessedComplexity ('medium')");
  } finally {
    cleanup(d);
  }
});

// ── AC3: pre-existing history fields remain intact ───────────────────────────

test('AC3: pre-existing history fields (turn, ts, mode, input, specHash) remain', async () => {
  const d = tempDir();
  try {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    inputStream.write('y\nanswer one\nanswer two\na\n');

    const result = await brainstorm(d, ['Add a rate limiter'], {}, {
      brainstormerFactory: telemetryFactory,
      input: inputStream,
      output: outputStream,
    });

    const init = readInitializeEntry(result.dir);

    assert.strictEqual(init.turn, 1, 'turn must be 1 for the initialize turn');
    assert.strictEqual(typeof init.ts, 'string', 'ts must be a string timestamp');
    assert.strictEqual(init.mode, 'initialize', 'mode must be initialize');
    assert.strictEqual(init.input, 'Add a rate limiter', 'input must be the verbatim user request');
    assert.ok(typeof init.specHash === 'string' && init.specHash.startsWith('sha256:'), 'specHash must remain a sha256: hash');
  } finally {
    cleanup(d);
  }
});

// ── AC3: counts reflect a DIFFERENT elicitation shape (no hardcoding) ────────

test('AC3: telemetry counts track the actual elicitation (1 question, 1 answer, 0 assumptions, small tier)', async () => {
  const d = tempDir();
  try {
    function altFactory() {
      return {
        proposeQuestions(_userInput, _opts = {}) {
          return Promise.resolve({
            restatement: { paraphrase: 'P.', evidence: ['src/foo.js'], unknowns: ['x'] },
            questions: [
              { id: 'q1', question: 'Only one question?', premise: 'p', category: 'ambiguity', importance: 9 },
            ],
            assessedComplexity: 'small',
          });
        },
        initialize(_userInput, _opts = {}) {
          // digest with an EMPTY assumptions list → assumptionCount 0.
          return Promise.resolve({
            spec: STUB_SPEC,
            specMd: '# stub',
            digest: { scopeOut: [], assumptions: [], risks: [] },
          });
        },
        revise(_c, _f, _m) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub', digest: { scopeOut: [], assumptions: [], risks: [] } });
        },
      };
    }

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    inputStream.write('y\nthe only answer\na\n');

    const result = await brainstorm(d, ['Tiny change'], {}, {
      brainstormerFactory: altFactory,
      input: inputStream,
      output: outputStream,
    });

    const init = readInitializeEntry(result.dir);

    assert.strictEqual(init.questionCount, 1, 'questionCount must equal 1');
    assert.strictEqual(init.answerCount, 1, 'answerCount must equal 1');
    assert.strictEqual(init.assumptionCount, 0, 'assumptionCount must equal 0 for an empty assumptions list');
    assert.strictEqual(init.complexityTier, 'small', "complexityTier must equal 'small'");
  } finally {
    cleanup(d);
  }
});

// ── FIX #6: questionCount = number of questions ASKED (post-cap), sourced ─────
//          independently of answerCount. Stub 3 questions under the default cap
//          (5) → questionCount 3. The asked-count comes from the elicitation's
//          question list, not from the answers array.

test('FIX#6: questionCount equals the number of questions asked post-cap (3 asked, cap 5 → 3)', async () => {
  const d = tempDir();
  try {
    function threeQuestionFactory() {
      return {
        proposeQuestions(_userInput, _opts = {}) {
          return Promise.resolve({
            restatement: { paraphrase: 'P.', evidence: ['src/foo.js'], unknowns: ['x'] },
            questions: [
              { id: 'q1', question: 'Q1?', premise: 'p1', category: 'ambiguity', importance: 9 },
              { id: 'q2', question: 'Q2?', premise: 'p2', category: 'boundary', importance: 8 },
              { id: 'q3', question: 'Q3?', premise: 'p3', category: 'ambiguity', importance: 7 },
            ],
            assessedComplexity: 'medium',
          });
        },
        initialize(_userInput, _opts = {}) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub', digest: DIGEST });
        },
        revise(_c, _f, _m) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub', digest: DIGEST });
        },
      };
    }

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // 'y' confirms; one answer per asked question (3); 'a' accepts.
    inputStream.write('y\na1\na2\na3\na\n');

    const result = await brainstorm(d, ['Add a thing'], {}, {
      brainstormerFactory: threeQuestionFactory,
      input: inputStream,
      output: outputStream,
    });

    const init = readInitializeEntry(result.dir);
    // questionCount tracks the number of questions ASKED (post-cap), which is the
    // length of the elicitation question list (3) — under the default cap of 5.
    assert.strictEqual(init.questionCount, 3, 'questionCount must equal the 3 questions asked');
    // answerCount tracks answers collected (one per asked question).
    assert.strictEqual(init.answerCount, 3, 'answerCount must equal the 3 answers collected');
  } finally {
    cleanup(d);
  }
});

// ── FIX#4: revise turn assumptionCount — absent digest is null, present is the count ──

test('FIX#4: a revise turn with NO digest records assumptionCount: null', async () => {
  const d = tempDir();
  try {
    function noReviseDigestFactory() {
      return {
        proposeQuestions(_userInput, _opts = {}) {
          return Promise.resolve({
            restatement: { paraphrase: 'P.', evidence: ['src/foo.js'], unknowns: ['x'] },
            questions: [],
            assessedComplexity: 'small',
          });
        },
        initialize(_userInput, _opts = {}) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub', digest: DIGEST });
        },
        // The revise turn returns NO digest at all.
        revise(_c, _f, _m) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub' });
        },
      };
    }

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // 'y' confirms (no questions); 'r' + feedback regenerates (no digest); 'a' accepts.
    inputStream.write('y\nr make it better\na\n');

    const result = await brainstorm(d, ['Add a thing'], {}, {
      brainstormerFactory: noReviseDigestFactory,
      input: inputStream,
      output: outputStream,
    });

    const revise = readLastReviseEntry(result.dir);
    assert.strictEqual(
      revise.assumptionCount,
      null,
      'a revise turn with no digest must record assumptionCount: null (absent), not 0',
    );
  } finally {
    cleanup(d);
  }
});

test('FIX#4: a revise turn WITH a digest records the numeric assumptionCount', async () => {
  const d = tempDir();
  try {
    const reviseDigest = { scopeOut: ['x'], assumptions: ['a1', 'a2'], risks: ['r1'] };
    function reviseDigestFactory() {
      return {
        proposeQuestions(_userInput, _opts = {}) {
          return Promise.resolve({
            restatement: { paraphrase: 'P.', evidence: ['src/foo.js'], unknowns: ['x'] },
            questions: [],
            assessedComplexity: 'small',
          });
        },
        initialize(_userInput, _opts = {}) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub', digest: DIGEST });
        },
        revise(_c, _f, _m) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub', digest: reviseDigest });
        },
      };
    }

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    inputStream.write('y\nr make it better\na\n');

    const result = await brainstorm(d, ['Add a thing'], {}, {
      brainstormerFactory: reviseDigestFactory,
      input: inputStream,
      output: outputStream,
    });

    const revise = readLastReviseEntry(result.dir);
    assert.strictEqual(
      revise.assumptionCount,
      reviseDigest.assumptions.length,
      'a revise turn with a digest must record the numeric assumptions count (2)',
    );
  } finally {
    cleanup(d);
  }
});

// ── FIX#5: non-TTY one-shot draft history entry has telemetry-field schema parity ──

test('FIX#5: non-TTY draft history entry includes questionCount:0, answerCount:0, assumptionCount:null, complexityTier:null', async () => {
  const d = tempDir();
  try {
    function batchFactory() {
      return {
        // Non-TTY one-shot path calls initialize(args[0]) with no opts/withDigest.
        initialize(_userInput, _opts = {}) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub' });
        },
        revise(_c, _f, _m) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub' });
        },
      };
    }

    const output = new PassThrough();
    const result = await brainstorm(d, ['Add a thing'], { 'no-tty': true }, {
      brainstormerFactory: batchFactory,
      output,
    });

    const init = readInitializeEntry(result.dir);
    // Schema parity with the TTY path: the fields are PRESENT (not missing).
    assert.ok('questionCount' in init, 'non-TTY entry must carry a questionCount field');
    assert.ok('answerCount' in init, 'non-TTY entry must carry an answerCount field');
    assert.ok('assumptionCount' in init, 'non-TTY entry must carry an assumptionCount field');
    assert.ok('complexityTier' in init, 'non-TTY entry must carry a complexityTier field');
    assert.strictEqual(init.questionCount, 0, 'non-TTY draft asks no questions → questionCount 0');
    assert.strictEqual(init.answerCount, 0, 'non-TTY draft collects no answers → answerCount 0');
    assert.strictEqual(init.assumptionCount, null, 'non-TTY draft surfaces no digest → assumptionCount null');
    assert.strictEqual(init.complexityTier, null, 'non-TTY draft runs no elicitation → complexityTier null');
  } finally {
    cleanup(d);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

Promise.all(allTests).then(() => {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
});
