/**
 * test-menu-prompt.js — Unit tests for src/cli/prompt.js askMenu().
 *
 * Covers valid key selection, re-prompt on invalid input, case
 * insensitivity, and maxRetries default behavior (first option key).
 *
 * Run: node test/test-menu-prompt.js
 */
import assert from 'assert';
import { Readable, Writable } from 'stream';
import { askMenu, askAssumptionFix } from '../src/cli/prompt.js';

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

function makeIo(lines) {
  const input = Readable.from(lines.map((l) => l + '\n'));
  const chunks = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { input, output, chunks };
}

const OPTIONS = [
  { key: 'a', label: 'Alpha' },
  { key: 'b', label: 'Beta' },
  { key: 'c', label: 'Gamma' },
  { key: 'd', label: 'Delta' },
];

async function run() {
  // TC1: Valid key 'a' resolves to 'a'
  await test(`valid key 'a' → 'a'`, async () => {
    const { input, output } = makeIo(['a']);
    const result = await askMenu('choose: ', OPTIONS, { input, output });
    assert.strictEqual(result, 'a');
  });

  // TC2: Valid key 'd' resolves to 'd'
  await test(`valid key 'd' → 'd'`, async () => {
    const { input, output } = makeIo(['d']);
    const result = await askMenu('choose: ', OPTIONS, { input, output });
    assert.strictEqual(result, 'd');
  });

  // TC3: Invalid key re-prompts then accepts valid key
  await test(`invalid key re-prompts, then accepts valid key 'b'`, async () => {
    const { input, output, chunks } = makeIo(['z', 'b']);
    const result = await askMenu('choose: ', OPTIONS, { input, output });
    assert.strictEqual(result, 'b', 'Should resolve to valid key after re-prompt');
    const out = chunks.join('');
    assert.ok(out.includes('got "z"'), `Expected re-prompt message for 'z', got:\n${out}`);
  });

  // TC4: Case insensitive: 'A' resolves to 'a'
  await test(`case insensitive: 'A' → 'a'`, async () => {
    const { input, output } = makeIo(['A']);
    const result = await askMenu('choose: ', OPTIONS, { input, output });
    assert.strictEqual(result, 'a');
  });

  // TC5: Exhausted retries defaults to first option key ('a')
  await test(`exhausted retries → defaults to first option key 'a'`, async () => {
    const { input, output, chunks } = makeIo(['x', 'y', 'z', 'q']);
    const result = await askMenu('choose: ', OPTIONS, { input, output, maxRetries: 3 });
    assert.strictEqual(result, 'a', 'Should default to first option key after max retries');
    const out = chunks.join('');
    assert.ok(
      out.includes('defaulting to "a"'),
      `Expected default notice with first key 'a', got:\n${out}`,
    );
  });

  // TC6: askMenu with OPTIONS → chunks contain 'a = Alpha' and 'b = Beta' lines
  await test(`askMenu with OPTIONS renders option lines in output`, async () => {
    const { input, output, chunks } = makeIo(['a']);
    await askMenu('choose: ', OPTIONS, { input, output });
    const out = chunks.join('');
    assert.ok(out.includes('a = Alpha'), `Expected 'a = Alpha' in output, got:\n${out}`);
    assert.ok(out.includes('b = Beta'), `Expected 'b = Beta' in output, got:\n${out}`);
    assert.ok(out.includes('c = Gamma'), `Expected 'c = Gamma' in output, got:\n${out}`);
    assert.ok(out.includes('d = Delta'), `Expected 'd = Delta' in output, got:\n${out}`);
  });

  // TC7: askMenu with empty options (free-text mode) → chunks do NOT contain option lines
  await test(`askMenu with empty options (free-text) emits no option lines`, async () => {
    const { input, output, chunks } = makeIo(['some free text']);
    const result = await askMenu('enter text: ', [], { input, output });
    assert.strictEqual(result, 'some free text', 'Should return the free-text input');
    const out = chunks.join('');
    assert.ok(!out.includes(' = '), `Expected no option lines (no ' = ') in free-text output, got:\n${out}`);
  });

  // TC8: askMenu with invalid-then-valid input → option lines appear in output (user saw them before retry)
  await test(`askMenu with invalid-then-valid input → option lines present in full output`, async () => {
    const { input, output, chunks } = makeIo(['z', 'b']);
    const result = await askMenu('choose: ', OPTIONS, { input, output });
    assert.strictEqual(result, 'b', 'Should resolve to valid key after re-prompt');
    const out = chunks.join('');
    // Option lines must appear in the collected output so the user saw their choices
    assert.ok(out.includes('a = Alpha'), `Expected 'a = Alpha' in output after re-prompt flow, got:\n${out}`);
    assert.ok(out.includes('b = Beta'), `Expected 'b = Beta' in output after re-prompt flow, got:\n${out}`);
  });

  // TC9: plan-approval menu options (y/n/a) appear as rendered lines in stdout
  await test(`TC9: plan-approval askMenu renders y/n/a option lines`, async () => {
    const PLAN_OPTIONS = [
      { key: 'y', label: 'Yes' },
      { key: 'n', label: 'No' },
      { key: 'a', label: 'Yes, and auto-approve from here' },
    ];
    const { input, output, chunks } = makeIo(['y']);
    const result = await askMenu('Proceed with this plan?', PLAN_OPTIONS, { input, output });
    assert.strictEqual(result, 'y', 'Should resolve to "y"');
    const out = chunks.join('');
    assert.ok(out.includes('y = Yes'), `Expected 'y = Yes' in output, got:\n${out}`);
    assert.ok(out.includes('n = No'), `Expected 'n = No' in output, got:\n${out}`);
    assert.ok(
      out.includes('a = Yes, and auto-approve from here'),
      `Expected 'a = Yes, and auto-approve from here' in output, got:\n${out}`,
    );
  });

  // TC10: askAssumptionFix outputs 'a = accept all' exactly once (no double-rendering)
  await test(`TC10: askAssumptionFix outputs 'a = accept all' exactly once`, async () => {
    const assumption = 'The build passes all unit tests.';
    const evidence = 'Test suite reported 2 failures.';
    const remediation = {
      revisedAssumptions: [{ text: 'The build passes at least smoke tests.', phase: 'pre' }],
      specEdit: {
        section: 'assumptions',
        oldText: 'The build passes all unit tests.',
        newText: 'The build passes at least smoke tests.',
      },
    };
    const { input, output, chunks } = makeIo(['a']);
    const result = await askAssumptionFix(assumption, evidence, remediation, { input, output });
    assert.strictEqual(result.choice, 'a', 'Should resolve to choice "a"');
    const out = chunks.join('');
    // Count occurrences of 'a = accept all'
    const occurrences = (out.match(/a = accept all/g) || []).length;
    assert.strictEqual(
      occurrences,
      1,
      `Expected 'a = accept all' to appear exactly once, but found ${occurrences} times.\nOutput:\n${out}`,
    );
  });

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

run();
