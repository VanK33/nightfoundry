/**
 * test-regression-runner-signal.js — Signal / overflow classification contract
 * for the regression test-command runners.
 *
 * Contract under test (src/orchestrator/gates/regression.js):
 *   - runTestCommand(projectRoot)    spawns config.execution.testCommand
 *   - runFullTestSuite(projectRoot)  spawns config.execution.testAllCommand
 *   Both return { exitCode, output, signal }.
 *
 * TC1: a child killed by SIGKILL (raised against its own pid) → runTestCommand
 *      returns exitCode -1, signal 'SIGKILL', and output names 'SIGKILL'.
 * TC2: the same SIGKILL-raising one-liner, routed through testAllCommand →
 *      runFullTestSuite returns exitCode -1, signal 'SIGKILL', output names
 *      'SIGKILL'.
 * TC3: a genuine `process.exit(3)` (no signal involved) → both runners return
 *      exitCode 3 and signal null.
 * TC4: a child writing more than the 16 MiB maxBuffer ceiling to stdout →
 *      runFullTestSuite returns exitCode 1, signal null, and output containing
 *      'maxBuffer exceeded' — proving the overflow branch outranks the signal
 *      branch (Node kills an overflowing child with SIGTERM, yet this must
 *      NOT be reported as a signal-kill).
 *
 * Hermetic: never imports or reaches the real SDK. Only drives the two real
 * runners (real child processes via execSync) by saving, overriding, and
 * restoring config.execution.testCommand / config.execution.testAllCommand
 * in-process, always restoring in a finally.
 *
 * Run: node test/test-regression-runner-signal.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import config from '../src/orchestrator/infra/config.js';
import { runTestCommand, runFullTestSuite } from '../src/orchestrator/gates/regression.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failCount++;
    }
  );
}

// ── Harness helpers ──────────────────────────────────────────────────────────

/** Creates an empty temp fixture dir. */
function createFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'regression-runner-signal-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Temporarily overrides config.execution.<key> in-process, runs fn, and
 * restores the original value (deleting the key if it was originally absent)
 * in finally. Never stubs the execSync wrappers themselves — only the
 * trigger condition (the configured command string).
 */
function withConfigOverride(key, value, fn) {
  const hadKey = Object.prototype.hasOwnProperty.call(config.execution, key);
  const original = config.execution[key];
  const restore = () => {
    if (hadKey) {
      config.execution[key] = original;
    } else {
      delete config.execution[key];
    }
  };
  config.execution[key] = value;
  let result;
  try {
    result = fn();
  } finally {
    restore();
  }
  return result;
}

// A node -e one-liner that SIGKILLs its own process. No exit code follows —
// the process is terminated by the signal before it can return one.
const SIGKILL_SELF_COMMAND = `node -e "process.kill(process.pid, 'SIGKILL')"`;

// A node -e one-liner that exits 3 cleanly — no signal involved.
const EXIT_3_COMMAND = `node -e "process.exit(3)"`;

// 16 MiB maxBuffer ceiling (RUN_TEST_ALL_MAX_BUFFER in regression.js). Write
// comfortably past it in a single stdout write so execSync's maxBuffer guard
// trips regardless of pipe chunking.
const OVERFLOW_BYTES = 17 * 1024 * 1024;
const OVERFLOW_COMMAND = `node -e "process.stdout.write(Buffer.alloc(${OVERFLOW_BYTES}, 'a'))"`;

// ── Tests ────────────────────────────────────────────────────────────────────

await test("TC1: runTestCommand on a SIGKILL-ed child → exitCode -1, signal 'SIGKILL', output names SIGKILL", () => {
  const fixture = createFixtureDir();
  try {
    const r = withConfigOverride('testCommand', SIGKILL_SELF_COMMAND, () =>
      runTestCommand(fixture)
    );
    assert.strictEqual(r.exitCode, -1, 'SIGKILL-terminated child must map to exitCode -1');
    assert.strictEqual(r.signal, 'SIGKILL', "signal field must be 'SIGKILL'");
    assert.ok(
      typeof r.output === 'string' && r.output.includes('SIGKILL'),
      `output must name SIGKILL, got: ${String(r.output).slice(0, 200)}`
    );
  } finally {
    cleanup(fixture);
  }
});

await test("TC2: runFullTestSuite on a SIGKILL-ed child → exitCode -1, signal 'SIGKILL', output names SIGKILL", () => {
  const fixture = createFixtureDir();
  try {
    const r = withConfigOverride('testAllCommand', SIGKILL_SELF_COMMAND, () =>
      runFullTestSuite(fixture)
    );
    assert.strictEqual(r.exitCode, -1, 'SIGKILL-terminated child must map to exitCode -1');
    assert.strictEqual(r.signal, 'SIGKILL', "signal field must be 'SIGKILL'");
    assert.ok(
      typeof r.output === 'string' && r.output.includes('SIGKILL'),
      `output must name SIGKILL, got: ${String(r.output).slice(0, 200)}`
    );
  } finally {
    cleanup(fixture);
  }
});

await test('TC3: genuine exit 3 (no signal) → exitCode 3 and signal null for both runners', () => {
  const fixture = createFixtureDir();
  try {
    const smoke = withConfigOverride('testCommand', EXIT_3_COMMAND, () =>
      runTestCommand(fixture)
    );
    assert.strictEqual(smoke.exitCode, 3, 'runTestCommand: genuine exit 3 must propagate as exitCode 3');
    assert.strictEqual(smoke.signal, null, 'runTestCommand: no signal involved — signal must be null');

    const full = withConfigOverride('testAllCommand', EXIT_3_COMMAND, () =>
      runFullTestSuite(fixture)
    );
    assert.strictEqual(full.exitCode, 3, 'runFullTestSuite: genuine exit 3 must propagate as exitCode 3');
    assert.strictEqual(full.signal, null, 'runFullTestSuite: no signal involved — signal must be null');
  } finally {
    cleanup(fixture);
  }
});

await test("TC4: >16 MiB stdout → runFullTestSuite returns exitCode 1, signal null, output contains 'maxBuffer exceeded'", () => {
  const fixture = createFixtureDir();
  try {
    const r = withConfigOverride('testAllCommand', OVERFLOW_COMMAND, () =>
      runFullTestSuite(fixture)
    );
    assert.strictEqual(r.exitCode, 1, 'maxBuffer overflow must map to exitCode 1');
    assert.strictEqual(
      r.signal,
      null,
      'maxBuffer overflow must NOT be reported as a signal-kill even though the child is SIGTERM-ed internally'
    );
    assert.ok(
      typeof r.output === 'string' && r.output.includes('maxBuffer exceeded'),
      `output must contain 'maxBuffer exceeded', got: ${String(r.output).slice(0, 200)}`
    );
  } finally {
    cleanup(fixture);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
