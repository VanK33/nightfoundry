/**
 * test-archive-final-test-gate.js — the archive() final test gate.
 *
 * A successful archive must not persist a spec whose full test suite fails.
 *   TC1: failing test:all → archive() rejects, refuses to archive
 *   TC2: --skip-test-gate → gate is not run (operator override)
 *   TC3: --include-failed → gate is not run (forensic archive, not a release)
 *   TC4: no test:all script in target → gate is not run (external project)
 *
 * The gate's runner is injected via deps.runFullTestSuite so these tests do
 * not actually spawn the suite.
 *
 * Run: node test/test-archive-final-test-gate.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { archive } from '../src/cli/commands/archive.js';

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

function makeProject({ withTestAll = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-gate-'));
  const pkg = { name: 'tmp', scripts: withTestAll ? { 'test:all': 'node scripts/run-tests.js' } : {} };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
  return dir;
}

// TC1: failing test:all → archive() refuses to archive
await test('TC1: failing test:all makes archive() refuse to archive', async () => {
  const dir = makeProject();
  let called = false;
  const spy = () => { called = true; return { exitCode: 1, output: 'FAIL  test/test-x.js' }; };
  let threw = null;
  try {
    await archive(dir, 'spec', { auto: true }, { runFullTestSuite: spy });
  } catch (err) {
    threw = err;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(called, 'Expected the gate to run the full test suite');
  assert.ok(
    threw && /Final test gate failed/.test(threw.message),
    `Expected a final-test-gate rejection, got: ${threw && threw.message}`,
  );
});

// TC2: --skip-test-gate skips the gate entirely
await test('TC2: --skip-test-gate skips the gate', async () => {
  const dir = makeProject();
  let called = false;
  const spy = () => { called = true; return { exitCode: 1, output: '' }; };
  try {
    await archive(dir, 'spec', { auto: true, 'skip-test-gate': true }, { runFullTestSuite: spy });
  } catch {
    // archive may fail later on the empty .harness — irrelevant to this assertion
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(called, false, 'Expected the gate to be skipped with --skip-test-gate');
});

// TC3: --include-failed (forensic) skips the gate
await test('TC3: --include-failed skips the gate (forensic archive)', async () => {
  const dir = makeProject();
  let called = false;
  const spy = () => { called = true; return { exitCode: 1, output: '' }; };
  try {
    await archive(dir, 'spec', { 'include-failed': true }, { runFullTestSuite: spy });
  } catch {
    // forensic path may bail on no haltInfo — irrelevant to this assertion
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(called, false, 'Expected the gate to be skipped with --include-failed');
});

// TC4: no test:all script in target → gate not run
await test('TC4: no test:all script skips the gate (external project)', async () => {
  const dir = makeProject({ withTestAll: false });
  let called = false;
  const spy = () => { called = true; return { exitCode: 1, output: '' }; };
  try {
    await archive(dir, 'spec', { auto: true }, { runFullTestSuite: spy });
  } catch {
    // archive may fail later — irrelevant to this assertion
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(called, false, 'Expected the gate skipped when no test:all script exists');
});

console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
