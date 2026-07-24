/**
 * test-usage-all-cli.js — CLI argument parsing tests for --all / --last / --since flags.
 *
 * Covers:
 *   TC8  — parseArgs(['usage','--all','--last','5','--since','2026-01-01']) flags
 *   TC9  — parseArgs(['usage','--all','--json','--role','planner']) flags
 *   TC10 — USAGE constant (via `cc-orch help`) contains '--all', '--last', '--since'
 *
 * Run: node test/test-usage-all-cli.js
 */
import assert from 'assert';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parseArgs } from '../src/cli/index.js';

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

// ---------- TC8 ----------

test("TC8 parseArgs(['usage','--all','--last','5','--since','2026-01-01']) returns correct flags", () => {
  const { flags, positional } = parseArgs(['usage', '--all', '--last', '5', '--since', '2026-01-01']);

  assert.strictEqual(flags.all, true, `Expected flags.all===true, got ${flags.all}`);
  assert.strictEqual(flags.last, '5', `Expected flags.last==='5', got ${JSON.stringify(flags.last)}`);
  assert.strictEqual(flags.since, '2026-01-01', `Expected flags.since==='2026-01-01', got ${JSON.stringify(flags.since)}`);
  assert.ok(positional.includes('usage'), `Expected 'usage' in positional, got ${JSON.stringify(positional)}`);
});

// ---------- TC9 ----------

test("TC9 parseArgs(['usage','--all','--json','--role','planner']) yields flags.all && flags.json && flags.role==='planner'", () => {
  const { flags } = parseArgs(['usage', '--all', '--json', '--role', 'planner']);

  assert.ok(flags.all, `Expected flags.all to be truthy, got ${flags.all}`);
  assert.ok(flags.json, `Expected flags.json to be truthy, got ${flags.json}`);
  assert.strictEqual(flags.role, 'planner', `Expected flags.role==='planner', got ${JSON.stringify(flags.role)}`);
});

// ---------- TC10 ----------

test("TC10 USAGE help text contains '--all', '--last', and '--since'", () => {
  const cliPath = path.resolve(__dirname, '../src/cli/index.js');
  const result = spawnSync(process.execPath, [cliPath, 'help'], {
    env: { ...process.env },
    timeout: 10000,
    encoding: 'utf8',
  });

  const output = (result.stdout || '') + (result.stderr || '');

  assert.ok(
    output.includes('--all'),
    `Expected USAGE to contain '--all', got:\n${output}`
  );
  assert.ok(
    output.includes('--last'),
    `Expected USAGE to contain '--last', got:\n${output}`
  );
  assert.ok(
    output.includes('--since'),
    `Expected USAGE to contain '--since', got:\n${output}`
  );
});

// ---------- TC11 ----------

test("TC11 parseArgs(['usage','--all','--include-failed']) yields flags['include-failed']===true", () => {
  const { flags, positional } = parseArgs(['usage', '--all', '--include-failed']);

  assert.strictEqual(flags['include-failed'], true, `Expected flags['include-failed']===true, got ${flags['include-failed']}`);
  assert.ok(flags.all, `Expected flags.all to be truthy, got ${flags.all}`);
  assert.ok(positional.includes('usage'), `Expected 'usage' in positional, got ${JSON.stringify(positional)}`);
});

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
