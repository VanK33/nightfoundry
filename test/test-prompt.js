/**
 * test-prompt.js — Unit tests for src/cli/prompt.js askYesNo().
 *
 * Covers the strict y/n parser fix for the dogfood 1 bug where
 * `answer.toLowerCase().startsWith('y')` treated any non-'y' input
 * as "no" — a user typed 'h' intending yes, pipeline silently
 * skipped a mission. The fix: accept only y/yes/n/no, re-prompt
 * everything else, cap at maxRetries then default false.
 *
 * Run: node test/test-prompt.js
 */
import assert from 'assert';
import { Readable, Writable } from 'stream';
import { askYesNo } from '../src/cli/prompt.js';

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

// Helper: build a fresh (input, output) pair for each call.
// readline needs a TTY-ish readable or a plain readable with line data.
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

async function run() {
  await test(`'y' → true`, async () => {
    const { input, output } = makeIo(['y']);
    const result = await askYesNo('proceed? ', { input, output });
    assert.strictEqual(result, true);
  });

  await test(`'yes' → true`, async () => {
    const { input, output } = makeIo(['yes']);
    const result = await askYesNo('proceed? ', { input, output });
    assert.strictEqual(result, true);
  });

  await test(`'YES' (uppercase) → true`, async () => {
    const { input, output } = makeIo(['YES']);
    const result = await askYesNo('proceed? ', { input, output });
    assert.strictEqual(result, true);
  });

  await test(`'Y' (uppercase) → true`, async () => {
    const { input, output } = makeIo(['Y']);
    const result = await askYesNo('proceed? ', { input, output });
    assert.strictEqual(result, true);
  });

  await test(`'n' → false`, async () => {
    const { input, output } = makeIo(['n']);
    const result = await askYesNo('proceed? ', { input, output });
    assert.strictEqual(result, false);
  });

  await test(`'no' → false`, async () => {
    const { input, output } = makeIo(['no']);
    const result = await askYesNo('proceed? ', { input, output });
    assert.strictEqual(result, false);
  });

  await test(`'NO' (uppercase) → false`, async () => {
    const { input, output } = makeIo(['NO']);
    const result = await askYesNo('proceed? ', { input, output });
    assert.strictEqual(result, false);
  });

  await test(`'h' (dogfood 1 bug regression) re-prompts, then accepts 'y'`, async () => {
    const { input, output, chunks } = makeIo(['h', 'y']);
    const result = await askYesNo('proceed? ', { input, output });
    assert.strictEqual(result, true, 'Should eventually resolve true after valid input');
    const out = chunks.join('');
    assert.ok(out.includes('got "h"'), `Expected re-prompt message for 'h', got:\n${out}`);
  });

  await test(`'garbage' re-prompts, then accepts 'no'`, async () => {
    const { input, output, chunks } = makeIo(['garbage', 'no']);
    const result = await askYesNo('proceed? ', { input, output });
    assert.strictEqual(result, false);
    const out = chunks.join('');
    assert.ok(out.includes('got "garbage"'), `Expected re-prompt message for 'garbage'`);
  });

  await test(`empty line re-prompts, then accepts 'y'`, async () => {
    const { input, output } = makeIo(['', 'y']);
    const result = await askYesNo('proceed? ', { input, output });
    assert.strictEqual(result, true);
  });

  await test(`trailing whitespace tolerated: '  yes  ' → true`, async () => {
    const { input, output } = makeIo(['  yes  ']);
    const result = await askYesNo('proceed? ', { input, output });
    assert.strictEqual(result, true);
  });

  await test(`exhausted retries → false with default-no notice`, async () => {
    const { input, output, chunks } = makeIo(['a', 'b', 'c', 'd', 'e', 'f']);
    const result = await askYesNo('proceed? ', { input, output, maxRetries: 3 });
    assert.strictEqual(result, false);
    const out = chunks.join('');
    assert.ok(out.includes('defaulting to "no"'), `Expected default-no notice, got:\n${out}`);
  });

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

run();
