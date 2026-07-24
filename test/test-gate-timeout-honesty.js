#!/usr/bin/env node
/**
 * test-gate-timeout-honesty.js — the full test suite (and the spec-criteria
 * drain) can be KILLED BY TIMEOUT rather than genuinely FAIL. A timeout says
 * nothing about whether the suite/criteria would pass or fail, so every
 * disposition that reacts to a red gate must distinguish the two: a timeout
 * routes to the honest infrastructure leg (no revert, no forensic status,
 * leave the entry pending, propagate InfrastructureError so the run can be
 * retried once the environment recovers); a genuine failure keeps today's
 * strict disposition (revert + re-queue / print-and-exit, naming the actual
 * failing test or criterion).
 *
 * Cases:
 *   (a) runFinalTestGate(): runFullTestSuite exitCode -1 (timed out) maps to
 *       a TestGateError with timedOut === true and the distinguished
 *       'TIMED OUT' wording.
 *   (b) runFinalTestGate(): a genuine non-zero, non--1 exit maps to a
 *       TestGateError with timedOut falsey and the generic 'Final test gate
 *       failed' wording (no 'TIMED OUT').
 *   (c) archive()'s final-test-gate try/catch: on a timedOut TestGateError,
 *       logs 'full suite TIMED OUT under load (not a test failure)' to
 *       console.error and rethrows (fail-closed, same error identity).
 *   (d) batchResume's TestGateError arm: timedOut === true leaves the entry
 *       pending (no park snapshot, no revert, no failed-test-gate status)
 *       and batchResume rejects with an InfrastructureError. A regression
 *       pin alongside it proves the SAME arm, without timedOut, still takes
 *       today's snapshot + revert + failed-test-gate disposition unchanged.
 *   (e) batchResume's SpecCriterionError arm: a non-empty, all-timedOut
 *       failures array takes the same infra leg (pending entry,
 *       InfrastructureError, no snapshot/revert/criteria-failures.txt).
 *   (f) Pipeline.resume()'s SpecCriterionError catch: a non-empty,
 *       all-timedOut failures array prints an honest timeout statement (not
 *       the 'Fix the failing criteria above' hint, and no criterion is
 *       named), persists the paused marker, and does NOT revert the WIP.
 *   (g) Fail-safe: an EMPTY failures array, a missing/undefined failures
 *       list, a MIXED array (one timedOut, one genuine), and an array whose
 *       failures simply omit the timedOut field altogether must all take
 *       TODAY'S STRICT arm byte-identically (entry reverted/re-queued on
 *       batch, criterion named + WIP untouched on single-resume) — guarding
 *       the vacuous `[].every(...) === true` trap that would otherwise
 *       misroute an empty/degenerate failures list onto the infra leg.
 *
 * Production-real shapes throughout: TestGateError / SpecCriterionError are
 * imported from their real modules; SpecCriterionError.failures entries use
 * the exact shape runMilestoneOnlyChecks/runFileCheckCriteria emit
 * ({name, command, exitCode, timedOut, outputTail} / {name, targetFile}).
 *
 * This suite spins up isolated fs.mkdtemp() git fixtures (batch cases) and a
 * real bootstrapped per-run harness (single-resume cases) — not a re-entrant
 * cc-orch invocation. But when launched from inside a live cc-orch run,
 * CC_ORCH_ACTIVE_RUN is inherited from the parent process environment and
 * would trip assertNoReentrantLiveRun's guard on these freshly-bootstrapped
 * roots — a false positive on the sanctioned mkdtemp pattern (see
 * reentrancy-guard.js). Clear the marker unconditionally here, mirroring
 * scripts/run-tests.js and test/test-batch-test-gate-park-snapshot.js, so
 * this file is re-entrancy-neutral regardless of launch context.
 *
 * Run: node test/test-gate-timeout-honesty.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { archive, runFinalTestGate, TestGateError } from '../src/cli/commands/archive.js';
import { SpecCriterionError } from '../src/orchestrator/core/spec-criterion-error.js';
import { InfrastructureError } from '../src/orchestrator/infra/session-manager.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { readQueueEntry } from '../src/orchestrator/core/state.js';
import { makeRun } from './helpers/make-run.js';
import {
  makeGitRoot,
  cleanup,
  refExists,
  createQueueEntry,
  makeRealBatchPipeline,
} from './helpers/batch-fixtures.js';

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

// ── shared helpers ───────────────────────────────────────────────────────────

const tmpDirs = [];
function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function cleanupTmpDirs() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
}

/** Project dir with a package.json carrying a `test:all` script, so the
 * final test gate is armed (mirrors test-run-final-test-gate.js). */
function makeProjectWithTestAll() {
  const dir = makeTmpDir('cc-orch-gate-timeout-honesty-');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'tmp-target', scripts: { 'test:all': 'node scripts/run-tests.js' } }),
  );
  return dir;
}

/** Capture console.error output made during fn(); returns { result, stderr, thrown }. */
async function captureConsoleError(fn) {
  const chunks = [];
  const orig = console.error;
  console.error = (...args) => chunks.push(args.join(' '));
  let thrown = null;
  let result;
  try { result = await fn(); }
  catch (err) { thrown = err; }
  finally { console.error = orig; }
  return { result, stderr: chunks.join('\n'), thrown };
}

/** Capture console.error/console.log + stdout/stderr writes, and any thrown
 * error (used to observe the mocked process.exit sentinel). Mirrors
 * test-spec-criteria-resume-catch.js's captureOutput. */
async function captureOutput(fn) {
  const outChunks = [];
  const errChunks = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);

  process.stdout.write = (chunk) => { outChunks.push(typeof chunk === 'string' ? chunk : chunk.toString()); return true; };
  process.stderr.write = (chunk) => { errChunks.push(typeof chunk === 'string' ? chunk : chunk.toString()); return true; };
  console.log = (...args) => outChunks.push(args.join(' ') + '\n');
  console.error = (...args) => errChunks.push(args.join(' ') + '\n');

  let thrownError = null;
  try { await fn(); }
  catch (err) { thrownError = err; }
  finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
  }
  return { stdout: outChunks.join(''), stderr: errChunks.join(''), thrownError };
}

// Production-real failure shapes (mirrors src/orchestrator/gates/hard-checks.js).
const cmdFailure = (name, { timedOut, exitCode = 1 } = {}) => ({
  name, command: `node -e "process.exit(${exitCode})"`, exitCode, timedOut,
  outputTail: timedOut ? '[timed out] ...' : '--- stdout ---\nboom',
});
const fileFailure = (name, targetFile) => ({ name, targetFile });

// ═════════════════════════════════════════════════════════════════════════════
// (a)/(b) — runFinalTestGate's exitCode → TestGateError mapping
// ═════════════════════════════════════════════════════════════════════════════

await test('(a) runFinalTestGate: exitCode -1 (timed out) → TestGateError timedOut===true + TIMED OUT wording', async () => {
  const dir = makeProjectWithTestAll();
  const spy = () => ({ exitCode: -1, output: 'still running...' });

  let threw = null;
  try { runFinalTestGate(dir, {}, { runFullTestSuite: spy }); }
  catch (err) { threw = err; }

  assert.ok(threw instanceof TestGateError,
    `expected a TestGateError, got: ${threw && threw.constructor && threw.constructor.name}`);
  assert.strictEqual(threw.timedOut, true,
    `expected timedOut === true for an exitCode -1 suite, got: ${threw.timedOut}`);
  assert.ok(/TIMED OUT/.test(threw.message),
    `expected the distinguished 'TIMED OUT' wording, got: ${threw.message}`);
});

await test('(b) runFinalTestGate: exitCode 1 (genuine failure) → TestGateError timedOut falsey + generic wording', async () => {
  const dir = makeProjectWithTestAll();
  const spy = () => ({ exitCode: 1, output: 'X\nFAIL' });

  let threw = null;
  try { runFinalTestGate(dir, {}, { runFullTestSuite: spy }); }
  catch (err) { threw = err; }

  assert.ok(threw instanceof TestGateError,
    `expected a TestGateError, got: ${threw && threw.constructor && threw.constructor.name}`);
  assert.ok(!threw.timedOut, `expected timedOut to be falsey for a genuine failure, got: ${threw.timedOut}`);
  assert.ok(/Final test gate failed/.test(threw.message),
    `expected the generic 'Final test gate failed' wording, got: ${threw.message}`);
  assert.ok(!/TIMED OUT/.test(threw.message),
    `expected NO 'TIMED OUT' wording on a genuine (non-timeout) failure, got: ${threw.message}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// (c) — archive()'s final-test-gate catch: logs + rethrows on a timedOut gate
// ═════════════════════════════════════════════════════════════════════════════

await test("(c) archive(): a timedOut TestGateError logs 'full suite TIMED OUT under load (not a test failure)' and rethrows", async () => {
  const dir = makeProjectWithTestAll();
  const spy = () => ({ exitCode: -1, output: 'still running...' });

  const { thrown, stderr } = await captureConsoleError(() =>
    archive(dir, 'irrelevant-name', {}, { runFullTestSuite: spy }));

  assert.ok(thrown instanceof TestGateError,
    `expected archive() to rethrow a TestGateError, got: ${thrown && thrown.constructor && thrown.constructor.name}`);
  assert.strictEqual(thrown.timedOut, true, 'expected the rethrown error to carry timedOut === true');
  assert.ok(stderr.includes('full suite TIMED OUT under load (not a test failure)'),
    `expected the honest timeout console.error line. Got:\n${stderr}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// (d) — batchResume's TestGateError arm: timedOut infra leg + regression pin
// ═════════════════════════════════════════════════════════════════════════════

await test('(d) batch: TestGateError({timedOut:true}) leaves the entry pending, no snapshot/revert/status, batchResume rejects InfrastructureError', async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-gate-timeout-batch-' });
  try {
    createQueueEntry(root, 'gate-timeout', {});
    const deliverable = path.join(root, 'file-gate-timeout.txt');

    const { pipeline } = makeRealBatchPipeline(root, {
      archive: async () => {
        throw new TestGateError(
          'Final test gate TIMED OUT: `npm run test:all` did not complete before the timeout ' +
          '(the suite timed out — this is not a failing test).',
          { timedOut: true },
        );
      },
      executeAllMilestones: async () => { fs.writeFileSync(deliverable, 'wip\n'); },
    });
    pipeline.planner.verifyAssumptions = async () => [];

    await assert.rejects(
      () => pipeline.batchResume({ autonomous: true }),
      (err) => err instanceof InfrastructureError && err.category === 'timeout',
      'expected batchResume to reject with an InfrastructureError(category: timeout)',
    );

    const entry = readQueueEntry(root, 'gate-timeout');
    assert.ok(entry !== null, "entry 'gate-timeout' should still be in the queue");
    assert.strictEqual(entry.status, 'pending',
      `expected entry status to remain 'pending' on the timeout leg, got '${entry?.status}'`);
    assert.ok(!refExists(root, 'refs/test-gate/gate-timeout'),
      'expected NO refs/test-gate/gate-timeout park snapshot on the timeout leg');
    assert.ok(fs.existsSync(deliverable),
      'expected NO revert on the timeout leg — the deliverable must still exist');
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'gate-timeout', 'test-gate-failures.txt')),
      'expected NO test-gate-failures.txt written on the timeout leg');
  } finally {
    cleanup(root);
  }
});

await test('(d-regression) batch: TestGateError WITHOUT timedOut still takes today\'s snapshot + revert + failed-test-gate disposition', async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-gate-timeout-batch-regr-' });
  try {
    createQueueEntry(root, 'gate-genuine', {});
    const deliverable = path.join(root, 'file-gate-genuine.txt');

    const { pipeline } = makeRealBatchPipeline(root, {
      archive: async () => {
        throw new TestGateError('Final test gate failed: `npm run test:all` exited 1.');
      },
      executeAllMilestones: async () => { fs.writeFileSync(deliverable, 'wip\n'); },
    });
    pipeline.planner.verifyAssumptions = async () => [];

    await pipeline.batchResume({ autonomous: true });

    const entry = readQueueEntry(root, 'gate-genuine');
    assert.strictEqual(entry.status, 'failed-test-gate',
      `expected the pre-existing 'failed-test-gate' disposition to be unchanged, got '${entry?.status}'`);
    assert.ok(refExists(root, 'refs/test-gate/gate-genuine'),
      'expected the pre-existing refs/test-gate/gate-genuine park snapshot to be unchanged');
    assert.ok(!fs.existsSync(deliverable),
      'expected the pre-existing revert-on-genuine-failure disposition to be unchanged');
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// (e) — batchResume's SpecCriterionError arm: all-timedOut infra leg
// ═════════════════════════════════════════════════════════════════════════════

await test('(e) batch: SpecCriterionError, non-empty all-timedOut failures, leaves the entry pending, batchResume rejects InfrastructureError', async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-crit-timeout-batch-' });
  try {
    createQueueEntry(root, 'crit-timeout', {});
    const deliverable = path.join(root, 'file-crit-timeout.txt');
    const failures = [
      cmdFailure('long-running milestone-only check', { timedOut: true }),
      cmdFailure('another slow check', { timedOut: true }),
    ];

    const { pipeline } = makeRealBatchPipeline(root, {
      archive: async () => { throw new Error('archive() must not be reached on a drain failure'); },
      executeAllMilestones: async () => {
        fs.writeFileSync(deliverable, 'wip\n');
        throw new SpecCriterionError(failures);
      },
    });
    pipeline.planner.verifyAssumptions = async () => [];

    await assert.rejects(
      () => pipeline.batchResume({ autonomous: true }),
      (err) => err instanceof InfrastructureError && err.category === 'timeout',
      'expected batchResume to reject with an InfrastructureError(category: timeout)',
    );

    const entry = readQueueEntry(root, 'crit-timeout');
    assert.strictEqual(entry.status, 'pending',
      `expected entry status to remain 'pending' on the timeout leg, got '${entry?.status}'`);
    assert.ok(!refExists(root, 'refs/test-gate/crit-timeout'),
      'expected NO refs/test-gate/crit-timeout park snapshot on the timeout leg');
    assert.ok(fs.existsSync(deliverable), 'expected NO revert on the timeout leg');
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'crit-timeout', 'criteria-failures.txt')),
      'expected NO criteria-failures.txt written on the timeout leg');
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// (f) — Pipeline.resume()'s SpecCriterionError catch: all-timedOut honest landing
// ═════════════════════════════════════════════════════════════════════════════

/** Real bootstrapped per-run harness + a real git tree with an uncommitted
 * "WIP" file, mirroring test-spec-criteria-resume-catch.js's fixture but
 * with _executeMilestone stubbed directly (no live drain execution needed —
 * only the SpecCriterionError catch in resume() itself is under test). */
function createSingleResumeFixture(slug) {
  const root = makeGitRoot({ prefix: `cc-orch-${slug}-` });
  const { harnessDir } = makeRun(root, { slug });
  const stateJsonPath = path.join(harnessDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
  state.projectMeta = state.projectMeta || {};
  state.projectMeta.currentPhase = 'executing';
  state.globalStatus = 'active';
  state.milestones = { '001': { id: '001', description: 'milestone 001', status: 'pending', missions: {} } };
  fs.writeFileSync(stateJsonPath, JSON.stringify(state, null, 2));

  const wipFile = `wip-${slug}.txt`;
  fs.writeFileSync(path.join(root, wipFile), 'work in progress from a prior milestone execution\n');

  return { root, harnessDir, wipFile };
}

function makeSingleResumePipeline(root, executeMilestone) {
  const pipeline = new Pipeline(root, {
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: () => {},
    onConfirm: async () => true,
    archive: async () => { throw new Error('archive() must not be reached on a drain failure'); },
  });
  pipeline._skipCoverageGate = true;
  pipeline._runPreflight = () => {};
  pipeline._executeMilestone = executeMilestone;
  pipeline._reviewGate = async () => { throw new Error('_reviewGate must not be reached on a drain failure'); };
  pipeline.planner.closeReusableSession = async () => {};
  return pipeline;
}

function teardownPipeline(pipeline) {
  const handlers = pipeline._signalHandlers || {};
  if (handlers.SIGINT) process.removeListener('SIGINT', handlers.SIGINT);
  if (handlers.SIGTERM) process.removeListener('SIGTERM', handlers.SIGTERM);
  if (handlers.exit) process.removeListener('exit', handlers.exit);
  if (handlers.uncaughtException) process.removeListener('uncaughtException', handlers.uncaughtException);
  if (typeof pipeline.destroy === 'function') pipeline.destroy();
}

async function runSingleResumeDrain(slug, failures) {
  const env = createSingleResumeFixture(slug);
  const pipeline = makeSingleResumePipeline(env.root, async () => { throw new SpecCriterionError(failures); });

  const capturedExitCodes = [];
  const sentinel = new Error('__SENTINEL_EXIT__');
  const origExit = process.exit;
  process.exit = (code) => { capturedExitCodes.push(code); throw sentinel; };

  let output;
  try {
    output = await captureOutput(() => pipeline.resume());
  } finally {
    process.exit = origExit;
    teardownPipeline(pipeline);
  }

  const stateAfter = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state.json'), 'utf8'));
  return { env, capturedExitCodes, sentinel, stateAfter, ...output };
}

await test('(f) single-resume: SpecCriterionError, non-empty all-timedOut failures, prints an honest timeout landing (no criterion named, no fix-hint), pauses, no revert', async () => {
  const failures = [
    cmdFailure('zzz-should-not-be-named', { timedOut: true }),
    cmdFailure('zzz-also-should-not-be-named', { timedOut: true }),
  ];
  const { env, capturedExitCodes, sentinel, stateAfter, thrownError, stderr } =
    await runSingleResumeDrain('gate-timeout-single-f', failures);

  try {
    assert.strictEqual(thrownError, sentinel,
      'expected resume() to exit via the mocked process.exit sentinel');
    assert.ok(capturedExitCodes.length > 0 && capturedExitCodes.every((c) => c !== 0),
      `expected process.exit to be called with a non-zero code, got [${capturedExitCodes.join(', ')}]`);

    assert.ok(/TIMED OUT/.test(stderr) && /not a criterion failure/i.test(stderr),
      `expected an honest timeout statement in stderr. Got:\n${stderr}`);
    assert.ok(!stderr.includes('Fix the failing criteria above'),
      `expected NO fix-the-failing-criteria hint on the timeout landing. Got:\n${stderr}`);
    assert.ok(!stderr.includes('zzz-should-not-be-named') && !stderr.includes('zzz-also-should-not-be-named'),
      `expected NO criterion to be named on the timeout landing. Got:\n${stderr}`);

    assert.strictEqual(stateAfter.globalStatus, 'paused',
      `expected the paused marker to be persisted, got '${stateAfter.globalStatus}'`);

    assert.ok(fs.existsSync(path.join(env.root, env.wipFile)),
      'expected NO revert on the timeout landing — the WIP must still exist');
  } finally {
    cleanup(env.root);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// (g) — Fail-safe: empty / missing / mixed / absent-field failures take
//        TODAY'S STRICT arm byte-identically (guards the vacuous .every() trap)
// ═════════════════════════════════════════════════════════════════════════════

async function assertBatchTakesStrictCriteriaArm(label, failures) {
  const root = makeGitRoot({ prefix: `cc-orch-${label}-` });
  try {
    createQueueEntry(root, label, {});
    const deliverable = path.join(root, `file-${label}.txt`);

    const { pipeline } = makeRealBatchPipeline(root, {
      archive: async () => { throw new Error('archive() must not be reached on a drain failure'); },
      executeAllMilestones: async () => {
        fs.writeFileSync(deliverable, 'wip\n');
        const err = new SpecCriterionError([]);
        err.failures = failures; // may be [], undefined, mixed, or field-omitting
        throw err;
      },
    });
    pipeline.planner.verifyAssumptions = async () => [];

    // Must NOT throw out of batchResume — the strict arm handles it inline.
    await pipeline.batchResume({ autonomous: true });

    const entry = readQueueEntry(root, label);
    assert.strictEqual(entry.status, 'failed-criteria',
      `[${label}] expected the strict arm's 'failed-criteria' status, got '${entry?.status}'`);
    assert.ok(refExists(root, `refs/test-gate/${label}`),
      `[${label}] expected the strict arm's refs/test-gate/${label} park snapshot`);
    assert.ok(!fs.existsSync(deliverable),
      `[${label}] expected the strict arm's revert (deliverable must be gone)`);
  } finally {
    cleanup(root);
  }
}

await test('(g1) batch fail-safe: SpecCriterionError([]) (EMPTY failures) still takes the strict arm — vacuous .every() trap guarded', async () => {
  await assertBatchTakesStrictCriteriaArm('degen-empty-g1', []);
});

await test('(g2) batch fail-safe: SpecCriterionError with undefined .failures still takes the strict arm', async () => {
  await assertBatchTakesStrictCriteriaArm('degen-undef-g2', undefined);
});

await test('(g3) batch fail-safe: MIXED failures (one timedOut, one genuine) still take the strict arm — regression pin', async () => {
  await assertBatchTakesStrictCriteriaArm('degen-mixed-g3', [
    cmdFailure('genuine failing check', { timedOut: false }),
    cmdFailure('timed-out check', { timedOut: true }),
  ]);
});

await test('(g4) batch fail-safe: a failure that OMITS the timedOut field entirely still takes the strict arm', async () => {
  await assertBatchTakesStrictCriteriaArm('degen-absent-g4', [fileFailure('README must exist', 'README.md')]);
});

await test('(g5) single-resume fail-safe: MIXED failures (one timedOut, one genuine) names the genuine criterion + fix-hint, no timeout wording, no revert', async () => {
  const failures = [
    cmdFailure('genuine failing criterion g5', { timedOut: false }),
    cmdFailure('timed-out criterion g5', { timedOut: true }),
  ];
  const { env, capturedExitCodes, sentinel, stateAfter, thrownError, stderr } =
    await runSingleResumeDrain('gate-mixed-single-g5', failures);

  try {
    assert.strictEqual(thrownError, sentinel,
      'expected resume() to exit via the mocked process.exit sentinel');
    assert.ok(capturedExitCodes.length > 0 && capturedExitCodes.every((c) => c !== 0),
      `expected process.exit to be called with a non-zero code, got [${capturedExitCodes.join(', ')}]`);

    assert.ok(stderr.includes('genuine failing criterion g5'),
      `expected the genuine failing criterion to be named. Got:\n${stderr}`);
    assert.ok(stderr.includes('Fix the failing criteria above'),
      `expected the strict arm's fix-and-re-run hint. Got:\n${stderr}`);
    assert.ok(!/suite TIMED OUT during resume/.test(stderr),
      `expected NO timeout-landing wording on a mixed (non-all-timedOut) drain. Got:\n${stderr}`);

    assert.strictEqual(stateAfter.globalStatus, 'paused',
      `expected the paused marker to still be persisted, got '${stateAfter.globalStatus}'`);
    assert.ok(fs.existsSync(path.join(env.root, env.wipFile)),
      'expected NO revert on the single-resume path (strict arm never reverts either)');
  } finally {
    cleanup(env.root);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// registration check — this file must run under `npm run test:all`
// ═════════════════════════════════════════════════════════════════════════════

await test('registration: test/test-gate-timeout-honesty.js is registered in scripts/run-tests.js TEST_FILES', async () => {
  const runTestsPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'run-tests.js');
  const { TEST_FILES } = await import(runTestsPath);
  assert.ok(
    TEST_FILES.includes('test/test-gate-timeout-honesty.js'),
    'expected scripts/run-tests.js TEST_FILES to include \'test/test-gate-timeout-honesty.js\'',
  );
});

// ── Teardown & report ─────────────────────────────────────────────────────────

cleanupTmpDirs();

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
