#!/usr/bin/env node
/**
 * test-test-gate-honesty.js — Honesty of the final test-gate signal, at both
 * the runner layer (runFullTestSuite) and the batch consumer layer
 * (Pipeline.prototype.batchResume's TestGateError arm).
 *
 * Runner layer (real execSync, real fixture commands, no stubbing):
 *   TC(a) — testAllCommand emits MORE than 16 MiB of stdout: runFullTestSuite
 *           must NOT report exitCode -1 (the timeout sentinel — an overflow is
 *           not a timeout) and must NOT report exitCode 0 (the output was lost,
 *           not verified) — and `output` must name the overflow / the 16 MiB
 *           ceiling, so a human reading the gate result is never told a
 *           truncated-output run either "timed out" or "passed".
 *   TC(b) — a command comfortably UNDER 16 MiB exiting 0 → exitCode === 0
 *           (regression pin: the overflow handling above must not swallow the
 *           ordinary success path).
 *   TC(c) — REGRESSION PIN: a genuine timeout-shaped run (SIGTERM without
 *           ENOBUFS/maxBuffer) still yields exitCode === -1.
 *   TC(d) — REGRESSION PIN: a command exiting non-zero on its own merits still
 *           yields that exit status, with stdout+stderr captured in `output`.
 *
 * Batch consumer layer (real Pipeline.prototype.batchResume against a temp git
 * repo, mirroring test-batch-test-gate-park-snapshot.js's harness):
 *   TC(e) — the failed-test-gate arm writes queue/<slug>/test-gate-error.txt
 *           containing the raw TestGateError message even when the message
 *           tail has NO [FAIL] and NO Total: line (the undiagnosable shape);
 *           test-gate-failures.txt content is not required in that case.
 *   TC(f) — the same arm still writes queue/<slug>/test-gate-failures.txt when
 *           [FAIL] lines and a Total: line DO parse, AND also writes
 *           test-gate-error.txt — with the snapshot (refs/test-gate/<slug>),
 *           the git revert, the 'failed-test-gate' status, and the
 *           batch-continue disposition all unchanged from pre-existing
 *           behavior.
 *   TC(g) — a forced failure writing test-gate-error.txt (a directory
 *           pre-created at that path so fs.writeFileSync throws) leaves the
 *           arm undisturbed: the entry is still marked 'failed-test-gate' and
 *           the batch still continues to the next entry.
 *
 * This suite is NOT a re-entrant cc-orch invocation — every fixture root is
 * an isolated fs.mkdtemp() directory. But when this file is launched from
 * inside a live cc-orch run, CC_ORCH_ACTIVE_RUN is inherited from the parent
 * process environment and would trip assertNoReentrantLiveRun's guard on the
 * freshly-bootstrapped active roots these fixtures construct — a false
 * positive on the sanctioned mkdtemp pattern (see reentrancy-guard.js). Clear
 * the marker unconditionally here, mirroring scripts/run-tests.js and
 * test/test-batch-test-gate-park-snapshot.js, so this file is
 * re-entrancy-neutral regardless of launch context.
 *
 * Run: node test/test-test-gate-honesty.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import config from '../src/orchestrator/infra/config.js';
import { runFullTestSuite } from '../src/orchestrator/gates/regression.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeQueueEntry, readQueueEntry } from '../src/orchestrator/core/state.js';
import { TestGateError, runFinalTestGate } from '../src/cli/commands/archive.js';
import { activeHarnessDir } from '../src/orchestrator/core/run-context.js';

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

// ── Runner-layer harness (mirrors test-configurable-test-commands.js) ───────

function createFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'test-gate-honesty-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Temporarily overrides config.execution.<key> in-process, runs fn, and
 * restores the original value (deleting the key if it was originally absent)
 * in finally. Never stubs the execSync wrappers themselves — only the
 * trigger condition. Mirrors test-configurable-test-commands.js.
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

// ── Batch-layer harness (mirrors test-batch-test-gate-park-snapshot.js) ────

function makeTmpGitRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-batch-tg-honesty-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(
    path.join(dir, '.gitignore'),
    '.harness/\nqueue/\n# cc-orch ephemeral inputs\nspec-*.md\n*.spec.md\n',
  );
  fs.writeFileSync(path.join(dir, 'README.md'), '# baseline\n');
  execSync('git add .gitignore README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "baseline"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanupRoot(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Seed pending queue entries with a minimal spec + plan. */
function seedQueue(root, slugs) {
  for (const slug of slugs) {
    writeQueueEntry(root, slug, {
      spec: `# Spec for ${slug}\n\nMinimal spec content for testing.\n`,
      plan: { milestones: [], assumptions: [] },
      validatedAt: new Date().toISOString(),
      status: 'pending',
    });
  }
}

/**
 * Lightweight archive stub injected via the Pipeline `archive` seam.
 * Creates archives/{seq}-{slug}/ (or failed-{seq}-{slug}/ when
 * include-failed) + manifest.json, and returns the dir.
 */
function makeStubArchive(root) {
  return async (_projectRoot, slug, opts = {}) => {
    const archivesDir = path.join(root, 'archives');
    fs.mkdirSync(archivesDir, { recursive: true });
    let maxSeq = 0;
    for (const d of fs.readdirSync(archivesDir)) {
      const m = d.match(/^(?:failed-)?(\d+)/);
      if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
    }
    const seq = String(maxSeq + 1).padStart(3, '0');
    const isFailed = opts['include-failed'] === true;
    const name = isFailed ? `failed-${seq}-${slug}` : `${seq}-${slug}`;
    const dir = path.join(archivesDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ headline: isFailed ? '' : slug }));
    return dir;
  };
}

/**
 * Build a Pipeline with planner/execution stubs, driving the REAL
 * Pipeline.prototype.batchResume against `root`. Mirrors
 * test-batch-test-gate-park-snapshot.js's makeBatchPipeline.
 */
function makeBatchPipeline(root, { gateFailOn = null, gateMessage = null } = {}) {
  const logs = [];
  const defaultGateMessage = 'Final test gate failed: `npm run test:all` exited 1 (simulated)';

  const baseArchive = makeStubArchive(root);
  const archiveStub = async (projectRoot, slug, opts = {}) => {
    if (gateFailOn !== null && slug === gateFailOn && !opts['include-failed']) {
      throw new TestGateError(gateMessage ?? defaultGateMessage);
    }
    return baseArchive(projectRoot, slug, opts);
  };

  const pipeline = new Pipeline(root, {
    skipWorktreeCreation: true,
    onLog: (m) => logs.push(m),
    archive: archiveStub,
  });

  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._reviewGate = async () => {};
  pipeline._skipCoverageGate = true;

  pipeline._executeAllMilestones = async (_plan) => {
    const stateJsonPath = path.join(activeHarnessDir(root), 'state.json');
    let slug = 'unknown-slug';
    try {
      const raw = fs.readFileSync(stateJsonPath, 'utf8');
      const state = JSON.parse(raw);
      const prdPath = state.projectMeta?.prdPath || state.spec || '';
      const match = prdPath.match(/queue\/([^/]+)\/spec\.md$/);
      if (match) slug = match[1];
    } catch { /* ignore read/parse errors */ }
    fs.writeFileSync(path.join(root, `file-${slug}.txt`), 'hello');
  };

  return { pipeline, logs };
}

// ── TC(a) ─────────────────────────────────────────────────────────────────
// >16 MiB stdout → exitCode is NOT -1 and NOT 0; output names the overflow.

await test('TC(a): testAllCommand emitting >16 MiB stdout → exitCode neither -1 nor 0, output names the 16 MiB overflow', () => {
  const fixture = createFixtureDir();
  try {
    const cmd = 'node -e "process.stdout.write(\'x\'.repeat(17*1024*1024))"';
    const r = withConfigOverride('testAllCommand', cmd, () => runFullTestSuite(fixture));
    assert.notStrictEqual(r.exitCode, -1, 'overflow must NOT be reported as the timeout sentinel (-1)');
    assert.notStrictEqual(r.exitCode, 0, 'overflow must NOT be reported as a pass (0) — the output was lost, not verified');
    assert.ok(
      typeof r.output === 'string' && /16\s*MiB/i.test(r.output),
      `output must name the 16 MiB ceiling/overflow, got: ${String(r.output).slice(0, 300)}`
    );
  } finally {
    cleanup(fixture);
  }
});

// ── TC(a2) ────────────────────────────────────────────────────────────────
// END-TO-END across the seam TC(a) stops at. TC(a) proves runFullTestSuite's
// own contract; this proves the diagnostic actually REACHES a human, by
// driving the REAL runFinalTestGate (archive.js) with the REAL
// runFullTestSuite against a real overflow and reading the real TestGateError.
//
// This is the case that would have caught the original defect: the first
// implementation PREPENDED the marker to megabytes of captured fragment, and
// archive.js keeps only `output.slice(-2000)` — so the marker was sliced off
// and the operator saw nothing but 'xxxx'. TC(a) passed anyway, because it
// never crossed into archive.js. archive.js is NOT modified here; it is
// exercised, which its `deps` seam and this spec's scope both permit.

await test('TC(a2): END-TO-END — a real overflow through the real runFinalTestGate surfaces the marker in the TestGateError a human reads', () => {
  const fixture = createFixtureDir();
  try {
    // A real package.json with a test:all script, so the gate's own
    // hasTestAll/isDefaultCommand precondition is satisfied production-style.
    fs.writeFileSync(
      path.join(fixture, 'package.json'),
      JSON.stringify({ name: 'fx', scripts: { 'test:all': 'true' } }),
    );
    const cmd = 'node -e "process.stdout.write(\'x\'.repeat(17*1024*1024))"';
    let thrown = null;
    withConfigOverride('testAllCommand', cmd, () => {
      try {
        runFinalTestGate(fixture, {});   // real deps → real runFullTestSuite
      } catch (err) {
        thrown = err;
      }
    });

    assert.ok(thrown, 'the gate must throw on an overflow');
    assert.ok(thrown instanceof TestGateError, `expected TestGateError, got ${thrown?.constructor?.name}`);
    assert.notStrictEqual(
      thrown.timedOut, true,
      'an overflow must NOT be flagged timedOut — that is the infra leg, which leaves the entry pending forever on a possibly-green suite',
    );
    // The load-bearing assertion: the marker survives archive.js's slice(-2000).
    assert.ok(
      /16\s*MiB/i.test(thrown.message),
      `the TestGateError a human reads must name the overflow; got tail: ${String(thrown.message).slice(-300)}`,
    );
    assert.ok(
      /UNKNOWN/i.test(thrown.message),
      'the message must say the suite state is UNKNOWN — an overflow is not a test failure',
    );
  } finally {
    cleanup(fixture);
  }
});

// ── TC(b) ─────────────────────────────────────────────────────────────────
// Comfortably under 16 MiB, exit 0 → exitCode === 0.

await test('TC(b): command comfortably under 16 MiB exiting 0 → exitCode === 0', () => {
  const fixture = createFixtureDir();
  try {
    const cmd = 'node -e "process.stdout.write(\'x\'.repeat(1024*1024)); process.exit(0)"';
    const r = withConfigOverride('testAllCommand', cmd, () => runFullTestSuite(fixture));
    assert.strictEqual(r.exitCode, 0, 'a comfortably-under-ceiling successful run must yield exitCode 0');
  } finally {
    cleanup(fixture);
  }
});

// ── TC(c) ─────────────────────────────────────────────────────────────────
// REGRESSION PIN: genuine timeout-shaped run (SIGTERM, no ENOBUFS) → -1.

await test('TC(c): REGRESSION PIN — SIGTERM-killed run (no maxBuffer overflow) still maps to exitCode -1', () => {
  const fixture = createFixtureDir();
  try {
    // `exec` so the signalled process is Node's direct child on any /bin/sh —
    // dash otherwise reports the survived shell's exit 143 instead of SIGTERM.
    const cmd = 'exec node -e "process.kill(process.pid, \'SIGTERM\')"';
    const r = withConfigOverride('testAllCommand', cmd, () => runFullTestSuite(fixture));
    assert.strictEqual(r.exitCode, -1, 'a genuine timeout-shaped (signal-terminated, no overflow) run must still map to exitCode -1');
  } finally {
    cleanup(fixture);
  }
});

// ── TC(d) ─────────────────────────────────────────────────────────────────
// REGRESSION PIN: non-zero exit on its own merits → that status, output captured.

await test('TC(d): REGRESSION PIN — command exiting non-zero on its merits yields that status, stdout+stderr captured', () => {
  const fixture = createFixtureDir();
  try {
    const cmd = 'node -e "console.log(\'TGH_STDOUT_MARKER\'); console.error(\'TGH_STDERR_MARKER\'); process.exit(2)"';
    const r = withConfigOverride('testAllCommand', cmd, () => runFullTestSuite(fixture));
    assert.strictEqual(r.exitCode, 2, 'exitCode must be the command\'s own exit status (2)');
    assert.ok(r.output.includes('TGH_STDOUT_MARKER'), `output must contain stdout text, got: ${r.output.slice(0, 300)}`);
    assert.ok(r.output.includes('TGH_STDERR_MARKER'), `output must contain stderr text, got: ${r.output.slice(0, 300)}`);
  } finally {
    cleanup(fixture);
  }
});

// ── TC(e) ─────────────────────────────────────────────────────────────────
// test-gate-error.txt written with raw message even with NO [FAIL]/Total: lines.

await test('TC(e): failed-test-gate arm writes test-gate-error.txt with the raw message even when NO [FAIL]/Total: lines are present', async () => {
  const root = makeTmpGitRoot();
  try {
    seedQueue(root, ['tge-a']);
    const gateMessage = 'Final test gate failed: `npm run test:all` exited 1. No structured tail was captured — the process died before emitting a parseable report.';
    assert.ok(!/\[FAIL\]/.test(gateMessage), 'harness precondition: message must contain no [FAIL] marker');
    assert.ok(!/^\s*Total:/m.test(gateMessage), 'harness precondition: message must contain no Total: line');

    const { pipeline } = makeBatchPipeline(root, { gateFailOn: 'tge-a', gateMessage });
    await pipeline.batchResume({ autonomous: true });

    const errorPath = path.join(root, 'queue', 'tge-a', 'test-gate-error.txt');
    assert.ok(fs.existsSync(errorPath), 'queue/tge-a/test-gate-error.txt must be written even with no [FAIL]/Total: lines');
    const content = fs.readFileSync(errorPath, 'utf8');
    assert.ok(content.includes(gateMessage), `test-gate-error.txt must contain the raw TestGateError message. Got:\n${content}`);

    const entry = readQueueEntry(root, 'tge-a');
    assert.strictEqual(entry.status, 'failed-test-gate', `entry 'tge-a' expected status 'failed-test-gate', got '${entry?.status}'`);
    // test-gate-failures.txt content is NOT required in this no-[FAIL] case.
  } finally {
    cleanupRoot(root);
  }
});

// ── TC(f) ─────────────────────────────────────────────────────────────────
// Both files written when [FAIL]/Total: lines parse; snapshot/revert/status/continue unchanged.

await test('TC(f): failed-test-gate arm writes BOTH test-gate-failures.txt and test-gate-error.txt when [FAIL]/Total: lines parse; snapshot/revert/status/continue unchanged', async () => {
  const root = makeTmpGitRoot();
  const origExit = process.exit;
  try {
    seedQueue(root, ['tgf-a', 'tgf-b']);
    const failLine1 = '[FAIL] test/foo.test.js > widget renders';
    const failLine2 = '[FAIL] test/bar.test.js > widget clicks';
    const totalLine = 'Total: 12 passed, 2 failed';
    const gateMessage = [
      'Final test gate failed: `npm run test:all` exited 1. Refusing to archive a spec whose test suite does not pass.',
      '--- tail of test output ---',
      '[PASS] test/baz.test.js > baseline check',
      failLine1,
      failLine2,
      totalLine,
    ].join('\n');

    const { pipeline, logs } = makeBatchPipeline(root, { gateFailOn: 'tgf-a', gateMessage });

    let exitCalled = false;
    try {
      process.exit = () => { exitCalled = true; };
      await pipeline.batchResume({ autonomous: true });
    } finally {
      process.exit = origExit;
    }

    // test-gate-failures.txt written with FAIL + Total lines.
    const failuresPath = path.join(root, 'queue', 'tgf-a', 'test-gate-failures.txt');
    assert.ok(fs.existsSync(failuresPath), 'queue/tgf-a/test-gate-failures.txt must be written');
    const failuresContent = fs.readFileSync(failuresPath, 'utf8');
    assert.ok(failuresContent.includes(failLine1), `test-gate-failures.txt must contain "${failLine1}". Got:\n${failuresContent}`);
    assert.ok(failuresContent.includes(failLine2), `test-gate-failures.txt must contain "${failLine2}". Got:\n${failuresContent}`);
    assert.ok(failuresContent.includes(totalLine), `test-gate-failures.txt must contain "${totalLine}". Got:\n${failuresContent}`);

    // test-gate-error.txt ALSO written with the raw message.
    const errorPath = path.join(root, 'queue', 'tgf-a', 'test-gate-error.txt');
    assert.ok(fs.existsSync(errorPath), 'queue/tgf-a/test-gate-error.txt must ALSO be written when [FAIL] lines parse');
    const errorContent = fs.readFileSync(errorPath, 'utf8');
    assert.ok(errorContent.includes(gateMessage), `test-gate-error.txt must contain the raw TestGateError message. Got:\n${errorContent}`);

    // FAIL lines emitted via onLog (pre-existing behavior).
    assert.ok(logs.some((l) => l.includes(failLine1)), `Expected onLog to include "${failLine1}". Got:\n${logs.join('\n')}`);
    assert.ok(logs.some((l) => l.includes(failLine2)), `Expected onLog to include "${failLine2}". Got:\n${logs.join('\n')}`);

    // Snapshot ref created (pre-existing behavior).
    let refSha = null;
    assert.doesNotThrow(() => {
      refSha = execSync('git rev-parse --verify refs/test-gate/tgf-a', { cwd: root, encoding: 'utf8' }).trim();
    }, 'refs/test-gate/tgf-a must exist and be resolvable after the TestGateError revert');
    assert.ok(refSha && refSha.length > 0, 'refs/test-gate/tgf-a must resolve to a non-empty sha');

    // Revert of the entry's deliverable (pre-existing behavior).
    assert.ok(!fs.existsSync(path.join(root, 'file-tgf-a.txt')), "entry 'tgf-a' deliverable should have been reverted");

    // Status still 'failed-test-gate' (pre-existing behavior).
    const entry = readQueueEntry(root, 'tgf-a');
    assert.strictEqual(entry.status, 'failed-test-gate', `entry 'tgf-a' expected status 'failed-test-gate', got '${entry?.status}'`);

    // Batch continued to tgf-b (pre-existing behavior).
    assert.strictEqual(readQueueEntry(root, 'tgf-b'), null, "entry 'tgf-b' should be archived/removed — the batch must continue past the test-gate failure");

    assert.strictEqual(exitCalled, false, 'process.exit must not be called');
  } finally {
    process.exit = origExit;
    cleanupRoot(root);
  }
});

// ── TC(g) ─────────────────────────────────────────────────────────────────
// Forced test-gate-error.txt write failure leaves the arm undisturbed.

await test('TC(g): a forced test-gate-error.txt write failure leaves the arm undisturbed — status still failed-test-gate, batch still continues', async () => {
  const root = makeTmpGitRoot();
  try {
    seedQueue(root, ['tgg-a', 'tgg-b']);

    // Pre-create a DIRECTORY at the exact path test-gate-error.txt would be
    // written to, so fs.writeFileSync(errorPath, ...) genuinely throws
    // (EISDIR) — no source changes, no mocking of fs.
    const queueEntryDir = path.join(root, 'queue', 'tgg-a');
    fs.mkdirSync(path.join(queueEntryDir, 'test-gate-error.txt'), { recursive: true });

    const gateMessage = 'Final test gate failed: `npm run test:all` exited 1 (no fail markers here either)';
    const { pipeline } = makeBatchPipeline(root, { gateFailOn: 'tgg-a', gateMessage });

    const result = await pipeline.batchResume({ autonomous: true });

    // Entry still marked failed-test-gate despite the write failure.
    const entry = readQueueEntry(root, 'tgg-a');
    assert.ok(entry !== null, "entry 'tgg-a' should still be in queue");
    assert.strictEqual(entry.status, 'failed-test-gate', `entry 'tgg-a' expected status 'failed-test-gate', got '${entry?.status}'`);

    // The pre-created directory must remain a directory (write genuinely failed, not silently succeeded).
    const stat = fs.statSync(path.join(queueEntryDir, 'test-gate-error.txt'));
    assert.ok(stat.isDirectory(), 'the pre-created directory at test-gate-error.txt must be untouched (the write must have failed, not silently replaced it)');

    // Batch continued to the second entry.
    assert.strictEqual(readQueueEntry(root, 'tgg-b'), null, "entry 'tgg-b' should be archived/removed — the batch must continue past the write failure");
    assert.strictEqual(result.failed, 1, `expected failed:1, got ${result.failed}`);
    assert.strictEqual(result.archived, 1, `expected archived:1, got ${result.archived}`);
  } finally {
    cleanupRoot(root);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
