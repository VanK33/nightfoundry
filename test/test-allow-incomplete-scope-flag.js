/**
 * test-allow-incomplete-scope-flag.js — Unit tests for --allow-incomplete-scope CLI flag.
 *
 * Tests flag parsing and propagation via parseArgs from src/cli/index.js.
 * Run: node test/test-allow-incomplete-scope-flag.js
 */
import assert from 'assert';
import { parseArgs } from '../src/cli/index.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

// TC1: parseArgs(['--allow-incomplete-scope']) sets flags['allow-incomplete-scope'] to true
test('TC1: --allow-incomplete-scope flag sets flags[allow-incomplete-scope] to true', () => {
  const { flags, positional } = parseArgs(['--allow-incomplete-scope']);
  assert.strictEqual(flags['allow-incomplete-scope'], true);
  assert.deepEqual(positional, []);
});

// TC2: parseArgs([]) does not set flags['allow-incomplete-scope']
test('TC2: parseArgs([]) does not set flags[allow-incomplete-scope]', () => {
  const { flags } = parseArgs([]);
  assert.strictEqual(flags['allow-incomplete-scope'], undefined);
});

// TC3: flag and positional args coexist correctly
test('TC3: --allow-incomplete-scope with run and spec.md keeps positional args and sets flag', () => {
  const { flags, positional } = parseArgs(['--allow-incomplete-scope', 'run', 'spec.md']);
  assert.strictEqual(flags['allow-incomplete-scope'], true);
  assert.deepEqual(positional, ['run', 'spec.md']);
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
