/**
 * test-wholesuite-scope-recognition.js — Tests for the live-hole shape of
 * isWholeSuiteCommand / isMilestoneOnlyCheck: a configured whole-suite
 * command (e.g. `npm run test:all`) that resolves — via a project's
 * package.json — to a runner-script body (e.g. `node scripts/run-tests.js`)
 * must be recognized as whole-suite / milestone-only under that resolved
 * body too, not just under its literal `npm ...` form. Also pins the
 * regression, fail-soft, inert-gate, scoping-integration, single-level-
 * resolution, and drain-integration behavior around that recognition.
 *
 * Covers:
 *   (a) LIVE HOLE SHAPE — a fixture package.json whose test:all script body
 *       is exactly the runner command; both isWholeSuiteCommand and
 *       isMilestoneOnlyCheck classify it true.
 *   (b) REGRESSION PINS — the literal configured forms stay true with and
 *       without projectRoot; the two-arg call (no projectRoot) on the
 *       direct-runner form stays false (byte-identical to today).
 *   (c) FAIL-SOFT — a missing package.json and an invalid-JSON package.json
 *       both yield false, and never throw.
 *   (d) INERT-GATE PIN — a per-file test command whose path token happens
 *       to match a spec target file still classifies per-task, not
 *       milestone-only.
 *   (e) SCOPING INTEGRATION — scopeSpecHardChecks attaches the live-shape
 *       check to no task.
 *   (f) SINGLE-LEVEL — resolution does not recurse into a script body that
 *       is itself an `npm run <name>` form.
 *   (g) DRAIN INTEGRATION — runMilestoneOnlyChecks retains and actually
 *       executes the live-shape check (progress log + passing execution).
 *
 * Run: node test/test-wholesuite-scope-recognition.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { isWholeSuiteCommand, isMilestoneOnlyCheck, scopeSpecHardChecks } from '../src/orchestrator/agents/planner.js';
import { runMilestoneOnlyChecks } from '../src/orchestrator/gates/hard-checks.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// ── Fixture helpers ──────────────────────────────────────────────────────

function mkTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wholesuite-scope-recognition-'));
}

function writePackageJson(root, scripts) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }, null, 2));
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// Matches infra/config.js's execution.{testCommand,testAllCommand} defaults —
// isMilestoneOnlyCheck reads the module-level config internally, so fixture
// package.json script keys must be 'test' / 'test:all' to line up with it.
const CONFIG = {
  execution: { testCommand: 'npm test', testAllCommand: 'npm run test:all' },
};

// ── (a) LIVE HOLE SHAPE ──────────────────────────────────────────────────

await test('(a) LIVE HOLE SHAPE: isWholeSuiteCommand + isMilestoneOnlyCheck recognize the command resolved from package.json test:all', () => {
  const root = mkTempRoot();
  try {
    writePackageJson(root, { 'test:all': 'node scripts/run-tests.js' });

    assert.strictEqual(
      isWholeSuiteCommand('node scripts/run-tests.js', CONFIG, root),
      true,
      'isWholeSuiteCommand should resolve testAllCommand (npm run test:all) to its package.json script body and match it',
    );
    assert.strictEqual(
      isMilestoneOnlyCheck({ name: 'suite', command: 'node scripts/run-tests.js' }, ['scripts/run-tests.js'], root),
      true,
      'isMilestoneOnlyCheck should classify the resolved whole-suite command as milestone-only, even though its path token matches a spec target_file',
    );
  } finally {
    cleanup(root);
  }
});

// ── (b) REGRESSION PINS ──────────────────────────────────────────────────

await test('(b) REGRESSION PINS: configured forms stay true with/without projectRoot; two-arg direct-runner form stays false', () => {
  const root = mkTempRoot();
  try {
    // WITHOUT projectRoot.
    assert.strictEqual(isWholeSuiteCommand('npm test', CONFIG), true, "'npm test' without projectRoot should be true");
    assert.strictEqual(isWholeSuiteCommand('npm run test:all', CONFIG), true, "'npm run test:all' without projectRoot should be true");

    // WITH projectRoot (root has no package.json — irrelevant, the direct
    // literal match short-circuits before any resolution is attempted).
    assert.strictEqual(isWholeSuiteCommand('npm test', CONFIG, root), true, "'npm test' with projectRoot should be true");
    assert.strictEqual(isWholeSuiteCommand('npm run test:all', CONFIG, root), true, "'npm run test:all' with projectRoot should be true");

    // Two-arg call (no projectRoot) on the direct-runner form: byte-identical
    // to today's behavior — false, because projectRoot resolution is never
    // attempted without a projectRoot argument.
    assert.strictEqual(
      isWholeSuiteCommand('node scripts/run-tests.js', CONFIG),
      false,
      'two-arg isWholeSuiteCommand on the direct-runner form must stay false (no projectRoot to resolve against)',
    );
  } finally {
    cleanup(root);
  }
});

// ── (c) FAIL-SOFT ─────────────────────────────────────────────────────────

await test('(c) FAIL-SOFT: missing package.json and invalid-JSON package.json both yield false, never throw', () => {
  const rootMissing = mkTempRoot();
  const rootInvalid = mkTempRoot();
  try {
    fs.writeFileSync(path.join(rootInvalid, 'package.json'), '{ this is not valid json ');

    let resultMissing;
    let resultInvalid;
    assert.doesNotThrow(() => {
      resultMissing = isWholeSuiteCommand('node scripts/run-tests.js', CONFIG, rootMissing);
    }, 'a projectRoot with no package.json must not throw');
    assert.doesNotThrow(() => {
      resultInvalid = isWholeSuiteCommand('node scripts/run-tests.js', CONFIG, rootInvalid);
    }, 'a projectRoot with an invalid-JSON package.json must not throw');

    assert.strictEqual(resultMissing, false, 'missing package.json should yield false');
    assert.strictEqual(resultInvalid, false, 'invalid-JSON package.json should yield false');
  } finally {
    cleanup(rootMissing);
    cleanup(rootInvalid);
  }
});

// ── (d) INERT-GATE PIN ────────────────────────────────────────────────────

await test('(d) INERT-GATE PIN: a per-file test command whose path token matches a spec target file still classifies per-task', () => {
  const root = mkTempRoot();
  try {
    assert.strictEqual(
      isMilestoneOnlyCheck({ name: 'per-file', command: 'node test/test-foo.js' }, ['test/test-foo.js'], root),
      false,
      'a per-file command whose token matches a spec target_file must keep per-task classification, not become milestone-only',
    );
  } finally {
    cleanup(root);
  }
});

// ── (e) SCOPING INTEGRATION ───────────────────────────────────────────────

await test('(e) SCOPING INTEGRATION: scopeSpecHardChecks attaches the live-shape check to no task', () => {
  const root = mkTempRoot();
  try {
    writePackageJson(root, { 'test:all': 'node scripts/run-tests.js' });

    const checks = [{ name: 'suite', command: 'node scripts/run-tests.js' }];
    const tasks = [{ id: 't1', targetFiles: ['scripts/run-tests.js'] }];
    const specTargetFiles = ['scripts/run-tests.js'];

    const result = scopeSpecHardChecks(checks, tasks, specTargetFiles, root);
    assert.ok(result instanceof Map, 'expected a Map');
    const t1Checks = result.get('t1') || [];
    assert.strictEqual(
      t1Checks.length,
      0,
      `expected the live-shape check attached to no task, got: ${JSON.stringify(t1Checks)}`,
    );
  } finally {
    cleanup(root);
  }
});

// ── (f) SINGLE-LEVEL ──────────────────────────────────────────────────────

await test('(f) SINGLE-LEVEL: resolution does not recurse into a script body that is itself an npm-run form', () => {
  const root = mkTempRoot();
  try {
    writePackageJson(root, {
      'test:all': 'npm run something-else',
      'something-else': 'node inner.js',
    });

    assert.strictEqual(
      isWholeSuiteCommand('node inner.js', CONFIG, root),
      false,
      'the inner script body (one resolution level further) must NOT be reached — resolution is single-level only',
    );
    assert.strictEqual(
      isWholeSuiteCommand('npm run something-else', CONFIG, root),
      true,
      'the directly-resolved script body (single level) must match',
    );
  } finally {
    cleanup(root);
  }
});

// ── (g) DRAIN INTEGRATION ─────────────────────────────────────────────────

await test('(g) DRAIN INTEGRATION: runMilestoneOnlyChecks retains and executes the live-shape cheap check', () => {
  const root = mkTempRoot();
  try {
    writePackageJson(root, { 'test:all': 'node -e "process.exit(0)"' });

    const logs = [];
    const result = runMilestoneOnlyChecks(
      [{ name: 'cheap', command: 'node -e "process.exit(0)"' }],
      root,
      { onLog: (msg) => logs.push(msg), specTargetFiles: ['scripts/run-tests.js'] },
    );

    assert.ok(
      logs.some((l) => l.includes('cheap')),
      `expected a per-check progress line mentioning "cheap"; got: ${JSON.stringify(logs)}`,
    );
    assert.strictEqual(result.passed, true, `expected passed=true, got failures=${JSON.stringify(result.failures)}`);
    assert.strictEqual(result.failures.length, 0, 'expected zero failures');
  } finally {
    cleanup(root);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exitCode = 1;
