/**
 * test-ui-routing.js — UI command routing tests for cc-orch.
 *
 * Run: node test/test-ui-routing.js
 *
 * Covers:
 *   TC1 — parseArgs(['ui','--port','4040']) returns { positional: ['ui'], flags: { port: '4040' } }
 *   TC2 — parseArgs(['ui']) returns { positional: ['ui'], flags: {} }
 *   TC3 — KNOWN_COMMANDS.includes('ui') is true
 *   TC4 — `node src/cli/index.js help` stdout contains 'nightfoundry ui [--port N]'
 */
import assert from 'assert';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parseArgs } from '../src/cli/index.js';
import { KNOWN_COMMANDS } from '../src/cli/suggest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ---------------------------------------------------------------------------
// TC1 — parseArgs(['ui','--port','4040']) returns { positional: ['ui'], flags: { port: '4040' } }
// ---------------------------------------------------------------------------
test('TC1: parseArgs([\'ui\',\'--port\',\'4040\']) returns correct shape', () => {
  const result = parseArgs(['ui', '--port', '4040']);
  assert.deepStrictEqual(
    result,
    { positional: ['ui'], flags: { port: '4040' } },
    `Expected { positional: ['ui'], flags: { port: '4040' } }, got: ${JSON.stringify(result)}`
  );
});

// ---------------------------------------------------------------------------
// TC2 — parseArgs(['ui']) returns { positional: ['ui'], flags: {} }
// ---------------------------------------------------------------------------
test('TC2: parseArgs([\'ui\']) returns correct shape with empty flags', () => {
  const result = parseArgs(['ui']);
  assert.deepStrictEqual(
    result,
    { positional: ['ui'], flags: {} },
    `Expected { positional: ['ui'], flags: {} }, got: ${JSON.stringify(result)}`
  );
});

// ---------------------------------------------------------------------------
// TC3 — KNOWN_COMMANDS.includes('ui') is true
// ---------------------------------------------------------------------------
test("TC3: KNOWN_COMMANDS.includes('ui') is true", () => {
  assert.ok(
    KNOWN_COMMANDS.includes('ui'),
    `Expected KNOWN_COMMANDS to include 'ui', got: ${JSON.stringify(KNOWN_COMMANDS)}`
  );
});

// ---------------------------------------------------------------------------
// TC4 — `node src/cli/index.js help` stdout contains 'nightfoundry ui [--port N]'
// ---------------------------------------------------------------------------
test("TC4: `node src/cli/index.js help` stdout contains 'nightfoundry ui [--port N]'", () => {
  const cliPath = path.resolve(__dirname, '../src/cli/index.js');
  const stdout = execFileSync(process.execPath, [cliPath, 'help'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.ok(
    stdout.includes('nightfoundry ui [--port N]'),
    `Expected help output to contain 'nightfoundry ui [--port N]', got:\n${stdout.trim()}`
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
