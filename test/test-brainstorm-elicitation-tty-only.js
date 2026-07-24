/**
 * test-brainstorm-elicitation-tty-only.js — AC4 for brainstormer frame-first
 * elicitation.
 *
 *   - TTY path: collected answers are woven into the draft — initialize() is
 *     called with an `answers` array (an array of { question, answer }).
 *   - Non-TTY / batch path: NO restatement and NO questions fire. proposeQuestions
 *     is NOT called, and initialize() is called with NO answers — byte-identical
 *     legacy one-shot behavior.
 *
 * Tests are authored from the spec's acceptance criteria + the pinned interface
 * contract, NOT reverse-engineered from the implementation.
 *
 * Run: node test/test-brainstorm-elicitation-tty-only.js
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

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-elicit-')); }
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

const STUB_SPEC = {
  goal: 'stub',
  target_files: ['x'],
  acceptance_criteria: [{ description: 'd', verification: { kind: 'command', command: 'node x', targetFile: 'x' } }],
};

/**
 * A spy brainstormer factory that records every initialize() call's opts (so we
 * can assert whether `answers` were passed) and every proposeQuestions() call.
 * proposeQuestions returns a restatement + a single question by default.
 */
function spyFactory({ questions } = {}) {
  const initializeCalls = [];
  const proposeCalls = [];
  function factory() {
    return {
      proposeQuestions(userInput, opts = {}) {
        proposeCalls.push({ userInput, opts });
        return Promise.resolve({
          restatement: { paraphrase: 'A paraphrase of the ask.', evidence: ['src/foo.js'], unknowns: ['unknown'] },
          questions: questions ?? [
            { id: 'q1', question: 'Clarify the scope?', premise: 'scope is fuzzy', category: 'ambiguity', importance: 9 },
          ],
          assessedComplexity: 'moderate',
        });
      },
      initialize(userInput, opts = {}) {
        initializeCalls.push({ userInput, opts });
        return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub' });
      },
      revise(_currentSpec, _feedback, _mode) {
        return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub' });
      },
    };
  }
  return { factory, initializeCalls, proposeCalls };
}

// ── AC4 (TTY): answers are woven into the draft via initialize(opts.answers) ──────

test('AC4 (TTY): collected answers reach initialize() as an answers array', async () => {
  const d = tempDir();
  try {
    const { factory, initializeCalls, proposeCalls } = spyFactory();

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // Elicitation: 'y' confirms the frame; 'the user answer' answers the lone
    // question. Then 'a' accepts the resulting draft and exits the menu loop.
    inputStream.write('y\nthe user answer\na\n');

    await brainstorm(d, ['Add a feature'], {}, {
      brainstormerFactory: factory,
      input: inputStream,
      output: outputStream,
    });

    // proposeQuestions must have fired on the TTY new-brainstorm path.
    assert.ok(proposeCalls.length >= 1, 'proposeQuestions must be called on the TTY path');

    // initialize must have received an answers array carrying the user's answer.
    assert.ok(initializeCalls.length >= 1, 'initialize must be called to draft the spec');
    const initOpts = initializeCalls[0].opts ?? {};
    assert.ok(Array.isArray(initOpts.answers), 'initialize opts.answers must be an array on the TTY path');
    assert.ok(initOpts.answers.length >= 1, 'initialize opts.answers must carry the collected answer(s)');
    const wovenAnswer = JSON.stringify(initOpts.answers);
    assert.ok(wovenAnswer.includes('the user answer'), 'the collected answer text must be woven into initialize()');
  } finally {
    cleanup(d);
  }
});

// ── AC4 (non-TTY): no restatement, no questions, initialize gets no answers ───────

test('AC4 (non-TTY): batch mode never calls proposeQuestions and initialize gets no answers', async () => {
  const d = tempDir();
  try {
    const { factory, initializeCalls, proposeCalls } = spyFactory();

    const output = new PassThrough();

    await brainstorm(d, ['Add a feature'], { 'no-tty': true }, {
      brainstormerFactory: factory,
      output,
    });

    // The whole elicitation phase must be absent in batch mode.
    assert.strictEqual(proposeCalls.length, 0, 'proposeQuestions must NOT be called in non-TTY/batch mode');

    // initialize is still called (one-shot draft), but with no answers channel —
    // byte-identical to the legacy batch path.
    assert.ok(initializeCalls.length >= 1, 'initialize must still be called for the one-shot draft');
    const initOpts = initializeCalls[0].opts ?? {};
    assert.ok(
      initOpts.answers === undefined || (Array.isArray(initOpts.answers) && initOpts.answers.length === 0),
      'non-TTY initialize must receive no answers (legacy one-shot behavior)',
    );
  } finally {
    cleanup(d);
  }
});

// ── AC4: resume (TTY) does NOT trigger the elicitation phase ──────────────────────

test('AC4: TTY resume of an existing draft does NOT fire proposeQuestions', async () => {
  const d = tempDir();
  try {
    const { factory, proposeCalls } = spyFactory();

    // Pre-create an in-progress draft so resume loads an existing spec
    // (currentSpec !== null), which must skip the elicitation phase.
    const slug = 'existing-draft';
    const dir = path.join(d, '.harness', 'brainstorm', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ slug, createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), status: 'in-progress' }, null, 2),
    );
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(STUB_SPEC, null, 2));
    fs.writeFileSync(path.join(dir, 'spec.md'), '# existing');

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // Straight to accept — there is already a spec, so no elicitation should run.
    inputStream.write('a\n');

    await brainstorm(d, [], { resume: slug }, {
      brainstormerFactory: factory,
      input: inputStream,
      output: outputStream,
    });

    assert.strictEqual(proposeCalls.length, 0, 'resume path must NOT trigger the elicitation/question phase');
  } finally {
    cleanup(d);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────────

Promise.all(allTests).then(() => {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
});
