/**
 * test-configurable-test-commands.js — Configurable regression/archive test commands.
 *
 * Spec: configurable-test-commands.spec.md
 * Contract under test:
 *   - config.execution.testCommand    defaults to 'npm test'         (smoke gate, runTestCommand)
 *   - config.execution.testAllCommand defaults to 'npm run test:all' (archive final gate, runFullTestSuite)
 *   - Both runners return { exitCode, output }, spawn the configured command with
 *     cwd = projectRoot, propagate non-zero exit codes, capture stdout+stderr in
 *     output, and map the timeout path to exitCode -1.
 *
 * TC1:  defaults are byte-identical to the pre-fix literals ('npm test' / 'npm run test:all')
 * TC2a: testCommand override is executed (marker file written in fixture cwd, exitCode 0)
 * TC2b: testCommand override exiting 3 → exitCode 3 propagated
 * TC3a: testAllCommand override is executed (marker file, exitCode 0)
 * TC3b: testAllCommand override exiting 3 → exitCode 3 propagated
 * TC4:  external-portability — fixture dir with NO package.json + override → { exitCode: 0 }
 *       for both runners (pre-fix 'npm test' / 'npm run test:all' would error there)
 * TC5a: error contract — override writing to stderr and exiting 2 → output contains the
 *       stderr text, exitCode === 2
 * TC5b: timeout-path contract — exitCode -1. We do NOT wait the real 120s/600s timeouts.
 *       Instead the override self-kills with SIGTERM: empirically (probed on this host),
 *       execSync on a real timeout throws { code: 'ETIMEDOUT', signal: 'SIGTERM',
 *       status: null } and on a self-SIGTERM child throws { signal: 'SIGTERM',
 *       status: null } — both satisfy the err.signal === 'SIGTERM' branch the spec's
 *       -1 mapping keys on. Caveat: if the implementation instead keyed solely on
 *       err.code === 'ETIMEDOUT', this case would not reach that branch; the spec
 *       contract names the SIGTERM/no-status shape, so we assert -1 here.
 * TC6a: archive final gate (spec criterion 7) — with testAllCommand overridden away
 *       from the default, the gate RUNS (deps.runFullTestSuite spy IS called) even
 *       when package.json has no test:all script — no silently-skipped gate on
 *       external projects
 * TC6b: archive final gate — with the default command and no test:all script, the
 *       gate is skipped (spy NOT called) — existing behavior preserved
 *
 * Tests mutate config.execution in-process and restore it in finally (spec constraint);
 * the execSync wrappers themselves are never stubbed.
 *
 * Run: node test/test-configurable-test-commands.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import config from '../src/orchestrator/infra/config.js';
import { runTestCommand, runFullTestSuite } from '../src/orchestrator/gates/regression.js';
import { archive } from '../src/cli/commands/archive.js';

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

const DEFAULT_TEST_COMMAND = 'npm test';
const DEFAULT_TEST_ALL_COMMAND = 'npm run test:all';

/** Creates an empty temp fixture dir (no package.json unless the test adds one). */
function createFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'configurable-test-commands-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Temporarily overrides config.execution.<key> in-process, runs fn, and restores
 * the original value (deleting the key if it was originally absent) in finally.
 * Never stubs the execSync wrappers themselves — only the trigger condition.
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
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === 'function') {
    // Async callback: restore only after the promise settles, so the override
    // stays in effect across await points inside fn.
    return result.then(
      (v) => { restore(); return v; },
      (err) => { restore(); throw err; }
    );
  }
  restore();
  return result;
}

/** Command that writes a marker file relative to cwd (proving both override use and cwd=projectRoot). */
function markerCommand(markerName) {
  return `node -e "require('fs').writeFileSync('${markerName}', 'ran')"`;
}

/**
 * Minimal archive() fixture (mirrors test-archive-final-test-gate.js):
 * a temp project with a package.json that has NO test:all script + an empty
 * .harness dir. The gate runner is injected via deps.runFullTestSuite.
 */
function makeArchiveFixtureWithoutTestAll() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'configurable-test-commands-archive-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'tmp', scripts: {} })
  );
  fs.mkdirSync(path.join(dir, '.harness'), { recursive: true });
  return dir;
}

// ── Tests ────────────────────────────────────────────────────────────────────

await test("TC1: defaults — config.execution.testCommand === 'npm test', testAllCommand === 'npm run test:all'", () => {
  assert.strictEqual(
    config.execution.testCommand,
    DEFAULT_TEST_COMMAND,
    `testCommand default must be exactly '${DEFAULT_TEST_COMMAND}'`
  );
  assert.strictEqual(
    config.execution.testAllCommand,
    DEFAULT_TEST_ALL_COMMAND,
    `testAllCommand default must be exactly '${DEFAULT_TEST_ALL_COMMAND}'`
  );
});

await test('TC2a: testCommand override honored — marker file written in fixture, exitCode 0', () => {
  const fixture = createFixtureDir();
  try {
    const r = withConfigOverride('testCommand', markerCommand('tc2a-marker.txt'), () =>
      runTestCommand(fixture)
    );
    assert.strictEqual(r.exitCode, 0, 'override exiting 0 must yield exitCode 0');
    assert.ok(
      Object.prototype.hasOwnProperty.call(r, 'output'),
      'result must have output property'
    );
    assert.ok(
      fs.existsSync(path.join(fixture, 'tc2a-marker.txt')),
      'override command must have run with cwd = projectRoot (marker file missing)'
    );
  } finally {
    cleanup(fixture);
  }
});

await test('TC2b: testCommand override exiting 3 → exitCode 3 propagated', () => {
  const fixture = createFixtureDir();
  try {
    const r = withConfigOverride('testCommand', 'node -e "process.exit(3)"', () =>
      runTestCommand(fixture)
    );
    assert.strictEqual(r.exitCode, 3, 'non-zero exit code must be propagated as-is');
    assert.ok(
      Object.prototype.hasOwnProperty.call(r, 'output'),
      'result must have output property'
    );
  } finally {
    cleanup(fixture);
  }
});

await test('TC3a: testAllCommand override honored — marker file written in fixture, exitCode 0', () => {
  const fixture = createFixtureDir();
  try {
    const r = withConfigOverride('testAllCommand', markerCommand('tc3a-marker.txt'), () =>
      runFullTestSuite(fixture)
    );
    assert.strictEqual(r.exitCode, 0, 'override exiting 0 must yield exitCode 0');
    assert.ok(
      Object.prototype.hasOwnProperty.call(r, 'output'),
      'result must have output property'
    );
    assert.ok(
      fs.existsSync(path.join(fixture, 'tc3a-marker.txt')),
      'override command must have run with cwd = projectRoot (marker file missing)'
    );
  } finally {
    cleanup(fixture);
  }
});

await test('TC3b: testAllCommand override exiting 3 → exitCode 3 propagated', () => {
  const fixture = createFixtureDir();
  try {
    const r = withConfigOverride('testAllCommand', 'node -e "process.exit(3)"', () =>
      runFullTestSuite(fixture)
    );
    assert.strictEqual(r.exitCode, 3, 'non-zero exit code must be propagated as-is');
  } finally {
    cleanup(fixture);
  }
});

await test('TC4: external-portability — fixture with NO package.json + override → { exitCode: 0 } for both runners', () => {
  const fixture = createFixtureDir();
  try {
    assert.ok(
      !fs.existsSync(path.join(fixture, 'package.json')),
      'fixture precondition: must not contain package.json'
    );
    // Pre-fix, the hard-coded 'npm test' / 'npm run test:all' error out in a dir
    // without package.json; with the override the gate must work.
    const smoke = withConfigOverride('testCommand', 'node -e "process.exit(0)"', () =>
      runTestCommand(fixture)
    );
    assert.strictEqual(smoke.exitCode, 0, 'runTestCommand must succeed in a non-npm dir with an override');

    const full = withConfigOverride('testAllCommand', 'node -e "process.exit(0)"', () =>
      runFullTestSuite(fixture)
    );
    assert.strictEqual(full.exitCode, 0, 'runFullTestSuite must succeed in a non-npm dir with an override');
  } finally {
    cleanup(fixture);
  }
});

await test('TC5a: error contract — stderr text captured in output, non-zero exitCode propagated', () => {
  const fixture = createFixtureDir();
  try {
    const cmd = 'node -e "console.error(\'CTC_STDERR_MARKER\'); process.exit(2)"';
    const r = withConfigOverride('testCommand', cmd, () => runTestCommand(fixture));
    assert.strictEqual(r.exitCode, 2, 'exitCode must be 2');
    assert.ok(
      typeof r.output === 'string' && r.output.includes('CTC_STDERR_MARKER'),
      `output must contain the stderr text, got: ${String(r.output).slice(0, 200)}`
    );
  } finally {
    cleanup(fixture);
  }
});

await test('TC5b: timeout-path contract — SIGTERM-killed command (no exit status) maps to exitCode -1', () => {
  // See header comment: a real timeout is not waited for (120s/600s). The child
  // self-SIGTERMs, producing the same { signal: 'SIGTERM', status: null } error
  // shape execSync throws on timeout, exercising the spec's -1 mapping branch.
  const fixture = createFixtureDir();
  try {
    const cmd = 'node -e "process.kill(process.pid, \'SIGTERM\')"';
    const r = withConfigOverride('testCommand', cmd, () => runTestCommand(fixture));
    assert.strictEqual(r.exitCode, -1, 'signal-terminated (timeout-shaped) run must map to exitCode -1');
    assert.ok(
      Object.prototype.hasOwnProperty.call(r, 'output'),
      'result must have output property'
    );
  } finally {
    cleanup(fixture);
  }
});

await test('TC6a: archive gate runs with overridden testAllCommand despite missing test:all script', async () => {
  const dir = makeArchiveFixtureWithoutTestAll();
  try {
    let called = false;
    // Spy returns a failing result so archive() halts right at the gate — the
    // only assertion here is that the gate RAN despite the missing test:all
    // script, because the explicit override declares the command runnable.
    const spy = () => { called = true; return { exitCode: 1, output: '' }; };
    await withConfigOverride('testAllCommand', 'node -e "process.exit(0)"', async () => {
      try {
        await archive(dir, 'spec', { auto: true }, { runFullTestSuite: spy });
      } catch {
        // archive may reject at the gate (spy exitCode 1) or later — irrelevant here
      }
    });
    assert.strictEqual(
      called,
      true,
      'gate must RUN (spy called) when testAllCommand is overridden, even without a test:all script'
    );
  } finally {
    cleanup(dir);
  }
});

await test('TC6b: archive gate still skipped with default command and no test:all script', async () => {
  const dir = makeArchiveFixtureWithoutTestAll();
  try {
    assert.strictEqual(
      config.execution.testAllCommand,
      DEFAULT_TEST_ALL_COMMAND,
      'precondition: testAllCommand must be at its default for this case'
    );
    let called = false;
    const spy = () => { called = true; return { exitCode: 1, output: '' }; };
    try {
      await archive(dir, 'spec', { auto: true }, { runFullTestSuite: spy });
    } catch {
      // archive may fail later on the empty .harness — irrelevant to this assertion
    }
    assert.strictEqual(
      called,
      false,
      'gate must stay skipped (spy not called) with the default command and no test:all script'
    );
  } finally {
    cleanup(dir);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
