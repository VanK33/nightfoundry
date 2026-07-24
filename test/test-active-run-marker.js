/**
 * test-active-run-marker.js — Verifies CC_ORCH_ACTIVE_RUN (run-marker.js)
 * reaches every spawn seam: withRunMarkerEnv itself, SessionManager's SDK
 * options builder, the configurable-test-command runner, and the hard-checks
 * per-check runner.
 *
 * TC1: withRunMarkerEnv() sets CC_ORCH_ACTIVE_RUN to getRunMarker() and
 *      preserves an existing process.env entry.
 * TC2: sessionManager._buildSdkOptions(...).env[CC_ORCH_ACTIVE_RUN] equals
 *      the run marker.
 * TC3: runTestCommand against a fixture using an override command that
 *      prints process.env.CC_ORCH_ACTIVE_RUN yields output containing the
 *      marker value.
 * TC4: the hard-checks per-check runner executes a check command that
 *      prints CC_ORCH_ACTIVE_RUN and the recorded output contains the
 *      marker.
 *
 * Tests mutate config.execution in-process (TC3) and restore it in finally.
 *
 * Marker discipline: unlike sibling suites that bootstrap real active-run
 * pointers (test-batch-resume.js, test-queue-spec-json.js, etc.) and so
 * clear process.env.CC_ORCH_ACTIVE_RUN unconditionally at module top, THIS
 * file is the marker itself under test — TC1-TC4 above must observe the
 * env-plumbing exactly as production sets/reads it. There is deliberately no
 * blanket clear here; scripts/run-tests.js's own module-top clear runs only
 * in the parent process before this file is spawned as a child and does not
 * touch the env each TC constructs for its own child processes, so it does
 * not clobber the marker under test.
 *
 * Run: node test/test-active-run-marker.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

import config from '../src/orchestrator/infra/config.js';
import { CC_ORCH_ACTIVE_RUN, getRunMarker, withRunMarkerEnv } from '../src/orchestrator/core/run-marker.js';
import { SessionManager } from '../src/orchestrator/infra/session-manager.js';
import { runTestCommand } from '../src/orchestrator/gates/regression.js';
import { runHardChecks } from '../src/orchestrator/gates/hard-checks.js';

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

/**
 * Temporarily overrides config.execution.<key> in-process, runs fn, and restores
 * the original value (deleting the key if it was originally absent) in finally.
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
    return result.then(
      (v) => { restore(); return v; },
      (err) => { restore(); throw err; }
    );
  }
  restore();
  return result;
}

function createFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'active-run-marker-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Fixture construction, not a marker-discipline hazard: this root never
// claims an active-run pointer (no claimActiveRun call), so
// activeHarnessDir(root) would resolve to this exact same
// harnessRoot(root) === path.join(root, '.harness') fallback path — the
// literal join below is equivalent to the accessor, just spelled out at
// fixture-build time. TC4 (the only consumer) never re-reads harnessDir
// after runHardChecks() runs; it asserts only on runHardChecks's returned
// value, so there is no post-run read that would need re-keying through
// activeHarnessDir(root). Left as a plain join for that reason.
function createHardCheckEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'active-run-marker-hardchecks-'));
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'verify'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  return { projectRoot: root, harnessDir };
}

function writeVerify(harnessDir, taskId, hardChecks) {
  const verify = { taskId, hardChecks, testCases: [], targetFiles: [] };
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify(verify, null, 2)
  );
}

// Command that prints process.env.CC_ORCH_ACTIVE_RUN to stdout, portably via node.
const PRINT_MARKER_COMMAND =
  `node -e "process.stdout.write(process.env.CC_ORCH_ACTIVE_RUN || '')"`;

// ── Tests ────────────────────────────────────────────────────────────────────

await test('TC1: withRunMarkerEnv sets CC_ORCH_ACTIVE_RUN and preserves a parent env var', () => {
  const sentinelKey = '__CC_ORCH_TEST_SENTINEL_TC1__';
  const sentinelValue = 'sentinel-value-' + Date.now();
  const baseEnv = { ...process.env, [sentinelKey]: sentinelValue };

  const result = withRunMarkerEnv(baseEnv);

  assert.strictEqual(
    result[CC_ORCH_ACTIVE_RUN],
    getRunMarker(),
    `Expected env[${CC_ORCH_ACTIVE_RUN}] to equal getRunMarker()`
  );
  assert.strictEqual(
    result[sentinelKey],
    sentinelValue,
    'Expected existing baseEnv entry to be preserved'
  );
  // Must be a NEW object, not a mutation of baseEnv.
  assert.notStrictEqual(result, baseEnv, 'withRunMarkerEnv must return a new object');
});

await test('TC2: _buildSdkOptions env carries the marker', () => {
  const sentinelKey = '__CC_ORCH_TEST_SENTINEL_TC2__';
  const sentinelValue = 'sentinel-value-' + Date.now();
  process.env[sentinelKey] = sentinelValue;
  try {
    const sessionManager = new SessionManager();
    const opts = sessionManager._buildSdkOptions({});
    assert.ok(opts.env, 'Expected _buildSdkOptions() to return an env object');
    assert.strictEqual(
      opts.env[CC_ORCH_ACTIVE_RUN],
      getRunMarker(),
      `Expected env[${CC_ORCH_ACTIVE_RUN}] to equal getRunMarker()`
    );
    assert.strictEqual(
      opts.env[sentinelKey],
      sentinelValue,
      'Expected existing process.env entry to be preserved in the built env'
    );
  } finally {
    delete process.env[sentinelKey];
  }
});

await test('TC3: runTestCommand child observes CC_ORCH_ACTIVE_RUN', () => {
  const fixture = createFixtureDir();
  try {
    const r = withConfigOverride('testCommand', PRINT_MARKER_COMMAND, () =>
      runTestCommand(fixture)
    );
    const marker = getRunMarker();
    assert.strictEqual(r.exitCode, 0, 'override command must exit 0');
    assert.ok(
      typeof r.output === 'string' && r.output.includes(marker),
      `Expected output to include getRunMarker() (${marker}), got: ${String(r.output).slice(0, 200)}`
    );
  } finally {
    cleanup(fixture);
  }
});

await test('TC4: hard-checks runner child observes CC_ORCH_ACTIVE_RUN', async () => {
  const { projectRoot, harnessDir } = createHardCheckEnv();
  try {
    writeVerify(harnessDir, 'active-run-marker-tc4', [
      { name: 'print run marker', command: PRINT_MARKER_COMMAND },
    ]);
    const result = await runHardChecks(harnessDir, 'active-run-marker-tc4', projectRoot);
    const marker = getRunMarker();
    assert.strictEqual(result.results.length, 1);
    assert.ok(
      result.results[0].output.includes(marker),
      `Expected captured output to include getRunMarker() (${marker}), got: ${result.results[0].output}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
