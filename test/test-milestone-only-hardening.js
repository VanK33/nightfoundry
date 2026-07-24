/**
 * test-milestone-only-hardening.js — Tests for hardened runMilestoneOnlyChecks.
 *
 * Covers task 001-004-001-001:
 *   TC1: command producing large stdout (>1 MiB, <16 MiB) does not overflow
 *        (maxBuffer = 16 MiB prevents ERR_CHILD_PROCESS_STDIO_MAXBUFFER)
 *   TC2: timed-out command (SIGTERM) records timedOut: true in the failure object
 *        and '[timed out]' prefix in outputTail
 *   TC3: normal failing command records exitCode and outputTail correctly
 *        (timedOut: false — no regression)
 *   TC4: passing command returns passed: true with no failures
 *
 * Run: node test/test-milestone-only-hardening.js
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ms-hardening-test-'));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// ── TC1: large stdout does not cause overflow / ENOBUFS ─────────────────────
// Command produces ~2 MiB of stdout and exits 0.
// Without maxBuffer=16MiB the default 1 MiB limit would trigger
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER → exitCode = -1 → passed = false.
// With maxBuffer=16MiB the command succeeds → passed = true.
await test('TC1: command producing ~2 MiB stdout exits 0 → passed=true (maxBuffer=16MiB does not overflow)', async () => {
  const root = makeRoot();
  try {
    // Inline script: write 2 MiB to stdout and exit 0.
    // No '/' in the command, no code-extension token → milestone-only.
    const largeOutputCmd = `node -e "process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 120).toString())"`;
    const result = runMilestoneOnlyChecks(
      [{ name: 'large-stdout', command: largeOutputCmd }],
      root,
      { onLog: () => {} }
    );
    assert.strictEqual(result.passed, true,
      `expected passed=true for a 2 MiB output command that exits 0; got ${JSON.stringify(result.failures)}`);
    assert.strictEqual(result.failures.length, 0,
      `expected zero failures; got ${JSON.stringify(result.failures)}`);
  } finally {
    cleanup(root);
  }
});

// ── TC2: timed-out command records timedOut: true ────────────────────────────
// Kill the child process with SIGTERM (same signal execSync's timeout sends),
// so we can test the timedOut classification without a 600-second wait.
await test('TC2: command killed by SIGTERM records timedOut: true and [timed out] prefix in outputTail', async () => {
  const root = makeRoot();
  try {
    // The child process kills itself with SIGTERM — identical to what
    // execSync does when the timeout fires.  err.signal === 'SIGTERM'.
    const sigtermCmd = `node -e "process.kill(process.pid, 'SIGTERM')"`;
    const result = runMilestoneOnlyChecks(
      [{ name: 'sigterm-check', command: sigtermCmd }],
      root,
      { onLog: () => {} }
    );
    assert.strictEqual(result.passed, false,
      `expected passed=false for SIGTERM command; got passed=true`);
    assert.strictEqual(result.failures.length, 1,
      `expected exactly 1 failure; got ${JSON.stringify(result.failures)}`);
    const f = result.failures[0];
    assert.strictEqual(f.timedOut, true,
      `expected timedOut=true; got ${JSON.stringify(f)}`);
    assert.ok(
      typeof f.outputTail === 'string' && f.outputTail.startsWith('[timed out]'),
      `expected outputTail to start with '[timed out]'; got ${JSON.stringify(f.outputTail)}`
    );
    assert.strictEqual(f.name, 'sigterm-check');
  } finally {
    cleanup(root);
  }
});

// ── TC3: normal failing command records exitCode and outputTail (no regression)
await test('TC3: normal failing command records exitCode and outputTail correctly; timedOut: false', async () => {
  const root = makeRoot();
  try {
    const normalFailCmd = `node -e "console.error('specific-error-output'); process.exit(42)"`;
    const result = runMilestoneOnlyChecks(
      [{ name: 'normal-fail', command: normalFailCmd }],
      root,
      { onLog: () => {} }
    );
    assert.strictEqual(result.passed, false,
      `expected passed=false; got passed=true`);
    assert.strictEqual(result.failures.length, 1,
      `expected exactly 1 failure; got ${JSON.stringify(result.failures)}`);
    const f = result.failures[0];
    assert.strictEqual(f.exitCode, 42,
      `expected exitCode=42; got ${f.exitCode}`);
    assert.strictEqual(f.timedOut, false,
      `expected timedOut=false; got ${f.timedOut}`);
    assert.ok(
      typeof f.outputTail === 'string' && f.outputTail.includes('specific-error-output'),
      `expected outputTail to include 'specific-error-output'; got ${JSON.stringify(f.outputTail)}`
    );
    assert.strictEqual(f.name, 'normal-fail');
    assert.strictEqual(f.command, normalFailCmd);
  } finally {
    cleanup(root);
  }
});

// ── TC4: passing command returns passed: true ────────────────────────────────
await test('TC4: passing command returns passed: true with empty failures array', async () => {
  const root = makeRoot();
  try {
    const passingCmd = `node -e "process.exit(0)"`;
    const result = runMilestoneOnlyChecks(
      [{ name: 'passing-check', command: passingCmd }],
      root,
      { onLog: () => {} }
    );
    assert.strictEqual(result.passed, true,
      `expected passed=true; got passed=${result.passed}`);
    assert.ok(Array.isArray(result.failures),
      `expected failures to be an array`);
    assert.strictEqual(result.failures.length, 0,
      `expected zero failures; got ${JSON.stringify(result.failures)}`);
  } finally {
    cleanup(root);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
