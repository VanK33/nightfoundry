/**
 * test-milestone-check-robustness.js — Tests for runMilestoneOnlyChecks
 * robustness improvements and drain-time parse-catch warning.
 *
 * TC1: maxBuffer — runMilestoneOnlyChecks with >1 MiB stdout does not throw;
 *      check passes (exit 0, within 16 MiB).
 * TC2: timeout classification — runMilestoneOnlyChecks with a command that
 *      terminates via SIGTERM; failure object must have timedOut: true.
 * TC3: maxBuffer exceeded — runMilestoneOnlyChecks with >16 MiB stdout;
 *      failure object must contain 'maxBuffer' in its outputTail.
 * TC4: normal failure — runMilestoneOnlyChecks with exit 1; failure has
 *      exitCode 1, timedOut is falsy.
 * TC5: drain-time warning — Pipeline._assertSpecHardCheckCoverage with a
 *      corrupt spec.json; log contains specJsonPath and 'unreadable'; no throw.
 * TC6: drain-time warning — Pipeline._runSpecCriteriaDrain with a corrupt
 *      spec.json; same assertions.
 *
 * Run: node test/test-milestone-check-robustness.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runMilestoneOnlyChecks } from '../src/orchestrator/gates/hard-checks.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';

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

/** Settle-timeout guard so a hung check fails the test instead of wedging the runner. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`settle-timeout after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Pipeline teardown helper (mirrors test-hardcheck-rehoming.js) ────────────

function teardownPipeline(pipeline) {
  const handlers = pipeline._signalHandlers || {};
  if (handlers.SIGINT) process.removeListener('SIGINT', handlers.SIGINT);
  if (handlers.SIGTERM) process.removeListener('SIGTERM', handlers.SIGTERM);
  if (handlers.exit) process.removeListener('exit', handlers.exit);
  if (handlers.uncaughtException) process.removeListener('uncaughtException', handlers.uncaughtException);
  if (typeof pipeline.destroy === 'function') pipeline.destroy();
}

// ── Drain fixture: minimal harness root with a corrupt spec.json ─────────────
//
// Layout mirrors test-hardcheck-rehoming.js / createEnv:
//   <root>/
//     spec.md           (prdPath — deriveSpecJsonPath infers <root>/spec.json)
//     spec.json         (CORRUPT — invalid JSON)
//     .harness/
//       state.json      (projectMeta.prdPath = <root>/spec.md)
//       state/          (empty — no missions needed; parse-catch fires before
//                        drain tries to walk mission files)
//       verify/
//       verification/
//       progress/
//       analysis/
//       snapshots/
//       plan/
//       logs/
//         token-usage.json

function createCorruptSpecFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-robust-drain-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(harnessDir, 'logs', 'token-usage.json'),
    JSON.stringify({ sessions: [], totals: {} })
  );

  // prdPath = <root>/spec.md → specJsonPath = <root>/spec.json
  const prdPath = path.join(root, 'spec.md');
  fs.writeFileSync(prdPath, '# corrupt spec fixture\n');

  // Corrupt spec.json: exists but not valid JSON → parse-catch fires.
  fs.writeFileSync(path.join(root, 'spec.json'), '{ this is not valid json }{');

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta: {
        prdPath,
        createdAt: new Date().toISOString(),
        currentPhase: 'executing',
      },
      globalStatus: 'active',
      milestones: {
        '001': {
          id: '001',
          status: 'in_progress',
          missions: {},
        },
      },
    }, null, 2)
  );

  const specJsonPath = path.join(root, 'spec.json'); // deriveSpecJsonPath result
  return { root, harnessDir, specJsonPath };
}

function makeDrainPipeline(projectRoot) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(String(msg)),
    onConfirm: async () => true,
    statusBar: false,
  });
  return { pipeline, logs };
}

// ─────────────────────────────────────────────────────────────────────────────
// TC1: >1 MiB stdout — check passes (exit 0, within 16 MiB limit)
// ─────────────────────────────────────────────────────────────────────────────

await test('TC1: runMilestoneOnlyChecks with >1 MiB stdout does not throw; check passes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-robust-'));
  try {
    // 2 MiB output — within the 16 MiB maxBuffer limit. Exit 0 → passes.
    const cmd = `node -e "process.stdout.write(Buffer.alloc(2*1024*1024, 120))"`;
    const result = await withTimeout(
      Promise.resolve(runMilestoneOnlyChecks(
        [{ name: 'big-stdout', command: cmd }],
        root,
        { onLog: () => {} }
      )),
      60_000, 'TC1 runMilestoneOnlyChecks'
    );
    assert.strictEqual(result.passed, true,
      `expected passed=true (large but within-buffer output), got ${JSON.stringify(result)}`);
    assert.ok(Array.isArray(result.failures) && result.failures.length === 0,
      `expected zero failures, got ${JSON.stringify(result.failures)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC2: SIGTERM / timeout classification — timedOut: true in the failure object
// ─────────────────────────────────────────────────────────────────────────────

await test('TC2: runMilestoneOnlyChecks SIGTERM termination → timedOut: true in failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-robust-'));
  try {
    // The child process sends SIGTERM to itself. execSync catches the error with
    // err.signal === 'SIGTERM', which the implementation maps to timedOut=true.
    // (This is the same signal the OS sends when the real MILESTONE_ONLY_CHECK_TIMEOUT_MS
    // fires — using self-SIGTERM lets us test the classification path without
    // waiting 10 minutes for the real timeout.)
    // `exec` replaces the shell with node, so the process Node signals is the
    // direct child. Without it dash reports the survived shell's exit 143
    // (signal null) while bash propagates SIGTERM — the assertion below wants
    // the signalled-child case on both.
    const cmd = `exec node -e "process.kill(process.pid, 'SIGTERM')"`;
    const result = await withTimeout(
      Promise.resolve(runMilestoneOnlyChecks(
        [{ name: 'sigterm-self', command: cmd }],
        root,
        { onLog: () => {} }
      )),
      30_000, 'TC2 runMilestoneOnlyChecks'
    );
    assert.strictEqual(result.passed, false,
      `expected passed=false, got ${JSON.stringify(result)}`);
    assert.ok(Array.isArray(result.failures) && result.failures.length === 1,
      `expected exactly 1 failure, got ${JSON.stringify(result.failures)}`);
    const f = result.failures[0];
    assert.ok(f.timedOut === true,
      `expected timedOut=true in failure, got: ${JSON.stringify(f)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC3: maxBuffer exceeded (>16 MiB) — failure contains 'maxBuffer' in outputTail
// ─────────────────────────────────────────────────────────────────────────────

await test('TC3: runMilestoneOnlyChecks >16 MiB stdout → "maxBuffer" in failure outputTail', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-robust-'));
  try {
    // 17 MiB output — exceeds the 16 MiB maxBuffer ceiling. The catch block
    // rewrites stderr to 'maxBuffer exceeded...' so the failure is honest (not
    // misleadingly labelled as exit -1 with no explanation).
    const cmd = `node -e "process.stdout.write(Buffer.alloc(17*1024*1024, 120))"`;
    const result = await withTimeout(
      Promise.resolve(runMilestoneOnlyChecks(
        [{ name: 'maxbuffer-overflow', command: cmd }],
        root,
        { onLog: () => {} }
      )),
      120_000, 'TC3 runMilestoneOnlyChecks maxBuffer'
    );
    assert.strictEqual(result.passed, false,
      `expected passed=false (maxBuffer exceeded), got ${JSON.stringify(result)}`);
    assert.ok(Array.isArray(result.failures) && result.failures.length === 1,
      `expected exactly 1 failure, got ${JSON.stringify(result.failures)}`);
    const f = result.failures[0];
    assert.ok(typeof f.outputTail === 'string' && f.outputTail.includes('maxBuffer'),
      `expected outputTail to contain 'maxBuffer' (honest error), got: ${JSON.stringify(f.outputTail)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC4: normal failure — exitCode 1, timedOut falsy
// ─────────────────────────────────────────────────────────────────────────────

await test('TC4: runMilestoneOnlyChecks exit 1 → exitCode=1, timedOut falsy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-robust-'));
  try {
    const cmd = `node -e "process.exit(1)"`;
    const result = await withTimeout(
      Promise.resolve(runMilestoneOnlyChecks(
        [{ name: 'exit-one', command: cmd }],
        root,
        { onLog: () => {} }
      )),
      30_000, 'TC4 runMilestoneOnlyChecks exit 1'
    );
    assert.strictEqual(result.passed, false,
      `expected passed=false, got ${JSON.stringify(result)}`);
    assert.ok(Array.isArray(result.failures) && result.failures.length === 1,
      `expected exactly 1 failure, got ${JSON.stringify(result.failures)}`);
    const f = result.failures[0];
    assert.strictEqual(f.exitCode, 1,
      `expected exitCode=1, got ${f.exitCode}`);
    assert.ok(!f.timedOut,
      `expected timedOut to be falsy, got ${f.timedOut}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC5: drain-time warning — _assertSpecHardCheckCoverage with corrupt spec.json
// ─────────────────────────────────────────────────────────────────────────────

await test('TC5: Pipeline._assertSpecHardCheckCoverage with corrupt spec.json → log contains path + "unreadable"; no throw', async () => {
  const env = createCorruptSpecFixture();
  const { pipeline, logs } = makeDrainPipeline(env.root);
  try {
    // Must not throw — drain is fail-soft on unreadable spec.json.
    await pipeline._assertSpecHardCheckCoverage();

    // A log line must name the specJsonPath.
    assert.ok(
      logs.some((l) => l.includes(env.specJsonPath)),
      `expected a log line containing specJsonPath "${env.specJsonPath}", got:\n${logs.join('\n')}`
    );
    // A log line must contain 'unreadable'.
    assert.ok(
      logs.some((l) => l.includes('unreadable')),
      `expected a log line containing 'unreadable', got:\n${logs.join('\n')}`
    );
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC6: drain-time warning — _runSpecCriteriaDrain with corrupt spec.json
// ─────────────────────────────────────────────────────────────────────────────

await test('TC6: Pipeline._runSpecCriteriaDrain with corrupt spec.json → log contains path + "unreadable"; no throw', async () => {
  const env = createCorruptSpecFixture();
  const { pipeline, logs } = makeDrainPipeline(env.root);
  try {
    // Must not throw — drain is fail-soft on unreadable spec.json.
    await pipeline._runSpecCriteriaDrain();

    // A log line must name the specJsonPath.
    assert.ok(
      logs.some((l) => l.includes(env.specJsonPath)),
      `expected a log line containing specJsonPath "${env.specJsonPath}", got:\n${logs.join('\n')}`
    );
    // A log line must contain 'unreadable'.
    assert.ok(
      logs.some((l) => l.includes('unreadable')),
      `expected a log line containing 'unreadable', got:\n${logs.join('\n')}`
    );
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
