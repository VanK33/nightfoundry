/**
 * test-assumption-fix-prompt.js — Unit tests for askAssumptionFix in src/cli/prompt.js.
 *
 * Covers accept/reject/edit paths, output rendering, invalid key re-prompt,
 * and case insensitivity.
 *
 * Run: node test/test-assumption-fix-prompt.js
 */
import assert from 'assert';
import { Readable, Writable } from 'stream';
import { askAssumptionFix } from '../src/cli/prompt.js';

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

const ASSUMPTION = 'The config file always exists';
const EVIDENCE = 'config.json was missing during verification run #42';
const REMEDIATION = {
  revisedAssumptions: [{ text: 'Config file is created if missing before execution', phase: 'invariant' }],
  specEdit: {
    section: 'Preconditions',
    oldText: 'Config file must exist before execution',
    newText: 'Config file is created if missing before execution',
  },
};
const REMEDIATION_2 = {
  revisedAssumptions: [
    { text: 'Config file is created if missing before execution', phase: 'invariant' },
    { text: 'Config file is validated after creation', phase: 'post-fix' },
  ],
  specEdit: {
    section: 'Preconditions',
    oldText: 'Config file must exist before execution',
    newText: 'Config file is created and validated before execution',
  },
};

async function run() {
  // TC1: 'a' input returns { choice: 'a' }
  await test(`'a' input returns { choice: 'a' }`, async () => {
    const { input, output } = makeIo(['a']);
    const result = await askAssumptionFix(ASSUMPTION, EVIDENCE, REMEDIATION, { input, output });
    assert.deepStrictEqual(result, { choice: 'a' });
  });

  // TC2: 'r' input returns { choice: 'r' }
  await test(`'r' input returns { choice: 'r' }`, async () => {
    const { input, output } = makeIo(['r']);
    const result = await askAssumptionFix(ASSUMPTION, EVIDENCE, REMEDIATION, { input, output });
    assert.deepStrictEqual(result, { choice: 'r' });
  });

  // TC3: 'e1' then free-text returns { choice: 'e', editIndex: 0, editedText: '<user text>' }
  await test(`'e1' then free-text returns { choice: 'e', editIndex: 0, editedText }`, async () => {
    const userText = 'Config file is optional and skipped if absent';
    const { input, output } = makeIo(['e1', userText]);
    const result = await askAssumptionFix(ASSUMPTION, EVIDENCE, REMEDIATION, { input, output });
    assert.strictEqual(result.choice, 'e');
    assert.strictEqual(result.editIndex, 0);
    assert.strictEqual(result.editedText, userText);
  });

  // TC4: Output stream contains assumption text, evidence, OLD text, NEW text
  await test(`output contains assumption text, evidence, OLD text, NEW text`, async () => {
    const { input, output, chunks } = makeIo(['a']);
    await askAssumptionFix(ASSUMPTION, EVIDENCE, REMEDIATION, { input, output });
    const out = chunks.join('');
    assert.ok(out.includes(ASSUMPTION), `Expected assumption text in output, got:\n${out}`);
    assert.ok(out.includes(EVIDENCE), `Expected evidence in output, got:\n${out}`);
    assert.ok(
      out.includes(REMEDIATION.specEdit.oldText),
      `Expected OLD text in output, got:\n${out}`,
    );
    assert.ok(
      out.includes(REMEDIATION.specEdit.newText),
      `Expected NEW text in output, got:\n${out}`,
    );
  });

  // TC5: Invalid key re-prompts then accepts valid key
  await test(`invalid key re-prompts then accepts valid key 'r'`, async () => {
    const { input, output, chunks } = makeIo(['z', 'r']);
    const result = await askAssumptionFix(ASSUMPTION, EVIDENCE, REMEDIATION, { input, output });
    assert.deepStrictEqual(result, { choice: 'r' });
    const out = chunks.join('');
    assert.ok(
      out.includes('got "z"'),
      `Expected re-prompt message for invalid key 'z', got:\n${out}`,
    );
  });

  // TC6: Case insensitive ('A' works like 'a')
  await test(`case insensitive: 'A' works like 'a'`, async () => {
    const { input, output } = makeIo(['A']);
    const result = await askAssumptionFix(ASSUMPTION, EVIDENCE, REMEDIATION, { input, output });
    assert.deepStrictEqual(result, { choice: 'a' });
  });

  // TC7: 2 revisedAssumptions renders numbered list with [invariant] and [post-fix] tags
  await test(`2 revisedAssumptions renders numbered list with phase tags`, async () => {
    const { input, output, chunks } = makeIo(['a']);
    await askAssumptionFix(ASSUMPTION, EVIDENCE, REMEDIATION_2, { input, output });
    const out = chunks.join('');
    assert.ok(
      out.includes('1. [invariant] Config file is created if missing before execution'),
      `Expected first assumption with [invariant] tag, got:\n${out}`,
    );
    assert.ok(
      out.includes('2. [post-fix] Config file is validated after creation'),
      `Expected second assumption with [post-fix] tag, got:\n${out}`,
    );
    assert.ok(out.includes('REVISED ASSUMPTIONS'), `Expected REVISED ASSUMPTIONS header, got:\n${out}`);
  });

  // TC8: 'e1' with 2 revisedAssumptions returns editIndex: 0
  await test(`'e1' with 2 revisedAssumptions returns editIndex: 0`, async () => {
    const userText = 'Replacement text for assumption 1';
    const { input, output } = makeIo(['e1', userText]);
    const result = await askAssumptionFix(ASSUMPTION, EVIDENCE, REMEDIATION_2, { input, output });
    assert.strictEqual(result.choice, 'e');
    assert.strictEqual(result.editIndex, 0);
    assert.strictEqual(result.editedText, userText);
  });

  // TC9: 'e2' with 2 revisedAssumptions returns editIndex: 1
  await test(`'e2' with 2 revisedAssumptions returns editIndex: 1`, async () => {
    const userText = 'Replacement text for assumption 2';
    const { input, output } = makeIo(['e2', userText]);
    const result = await askAssumptionFix(ASSUMPTION, EVIDENCE, REMEDIATION_2, { input, output });
    assert.strictEqual(result.choice, 'e');
    assert.strictEqual(result.editIndex, 1);
    assert.strictEqual(result.editedText, userText);
  });

  // TC10: 'r' rejects entire remediation regardless of item count
  await test(`'r' rejects entire remediation regardless of item count`, async () => {
    const { input, output } = makeIo(['r']);
    const result = await askAssumptionFix(ASSUMPTION, EVIDENCE, REMEDIATION_2, { input, output });
    assert.deepStrictEqual(result, { choice: 'r' });
    assert.strictEqual(result.editIndex, undefined);
  });

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

run();
