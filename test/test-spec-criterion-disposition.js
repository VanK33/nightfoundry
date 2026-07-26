#!/usr/bin/env node
/**
 * test-spec-criterion-disposition.js — Integration tests for the
 * SpecCriterionError disposition on BOTH the batch path (Pipeline.batchResume's
 * `err instanceof SpecCriterionError` branch) and the single-run path (the CLI
 * `resume()` wrapper's outer catch, since Pipeline.resume() itself has no
 * SpecCriterionError-specific disposition — it lets the error propagate).
 *
 * SpecCriterionError is thrown by the last-milestone spec-criteria drain
 * (pipeline.js) when one or more spec acceptance criteria (file-check or
 * command-check) are unmet after a milestone otherwise completed execution.
 *
 * Batch path (mirrors test-test-gate-disposition.js's TestGateError case,
 * swapping 'failed-test-gate' for 'failed-criteria' and the failures filename
 * for criteria-failures.txt):
 *   - snapshots the pre-revert WIP into refs/test-gate/<slug> (batch reuses the
 *     test-gate snapshot namespace for this disposition too);
 *   - persists the failing criteria to queue/<slug>/criteria-failures.txt;
 *   - reverts the (still-uncommitted) working tree so the batch stays isolated;
 *   - re-queues the entry as status 'failed-criteria'.
 *
 * Single path: resume() has no SpecCriterionError catch of its own, so the
 * error propagates out to the CLI resume() wrapper's outer try/catch, which
 * prints `Resume error: <message>` to stderr and calls process.exit(1) — no
 * revert (single-run leaves the WIP in place for a human to fix), no raw
 * stack escaping to the terminal.
 *
 * Test cases:
 *   TC1 — batch path: full disposition (snapshot ref, failures file, reverted
 *         tree, failed-criteria status).
 *   TC2 — single path: resume() throws SpecCriterionError → tree NOT
 *         reverted, criteria printed clearly to stderr, process exits
 *         non-zero, no unhandled stack.
 *   TC3 — degenerate inputs: SpecCriterionError with an empty failures array,
 *         and with a missing/undefined failures field — both paths still land
 *         cleanly with no crash from mapping an empty/undefined list.
 *
 * Run: node test/test-spec-criterion-disposition.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { readQueueEntry } from '../src/orchestrator/core/state.js';
import { SpecCriterionError } from '../src/orchestrator/core/spec-criterion-error.js';
import { resume } from '../src/cli/commands/resume.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import {
  makeGitRoot,
  cleanup,
  porcelain,
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

// ── captureOutput (async) ─────────────────────────────────────────────────────
// Mirrors test-resume.js's helper: captures console.error/log + stdout/stderr
// writes, and returns any thrown error (the process.exit sentinel, when mocked).

async function captureOutput(fn) {
  const outChunks = [];
  const errChunks = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);

  process.stdout.write = (chunk) => {
    outChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk) => {
    errChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
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

/**
 * Run the CLI resume() wrapper with Pipeline.prototype.resume stubbed to
 * throw the given error, process.exit mocked to a sentinel-throw (so we can
 * observe every exit-code call without actually killing the test process),
 * and output captured. Restores both globals in a finally.
 */
async function runSingleResumeWith(root, errToThrow) {
  const capturedExitCodes = [];
  const sentinel = new Error('__SENTINEL_EXIT__');
  const origExit = process.exit;
  process.exit = (code) => {
    capturedExitCodes.push(code);
    throw sentinel;
  };

  const origPipelineResume = Pipeline.prototype.resume;
  Pipeline.prototype.resume = async function stubResume() {
    throw errToThrow;
  };

  let output;
  try {
    output = await captureOutput(async () => {
      await resume(root, { auto: true });
    });
  } finally {
    process.exit = origExit;
    Pipeline.prototype.resume = origPipelineResume;
  }
  return { ...output, capturedExitCodes, sentinel };
}

// Realistic failing-criteria shapes matching the contract documented on
// SpecCriterionError: a file-check failure ({ name, targetFile }) and a
// command-check failure ({ name, command, exitCode, outputTail }).
const REALISTIC_FAILURES = [
  { name: 'README documents setup', targetFile: 'README.md' },
  { name: 'lint passes', command: 'npm run lint', exitCode: 1, outputTail: 'error: unexpected token' },
];

// ── TC1 ───────────────────────────────────────────────────────────────────────
// Batch path: full disposition on a spec-criteria failure.

await test('TC1: batch — SpecCriterionError → refs/test-gate/<slug> snapshot + criteria-failures.txt + reverted tree + failed-criteria status', async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-spec-crit-' });
  try {
    createQueueEntry(root, 'crit-fail', {});

    const { pipeline } = makeRealBatchPipeline(root, {
      executeAllMilestones: async () => {
        // Deliverable written by the (stubbed) milestone execution — still
        // uncommitted when the last-milestone spec-criteria drain throws, so
        // this is what gets snapshotted/reverted by the disposition below.
        fs.writeFileSync(path.join(root, 'deliverable-crit-fail.txt'), 'work in progress\n');
        throw new SpecCriterionError(REALISTIC_FAILURES);
      },
    });
    pipeline.planner.verifyAssumptions = async () => [];

    await pipeline.batchResume({ autonomous: true });

    // (a) refs/test-gate/crit-fail exists — the pre-revert WIP is snapshotted
    //     (the SpecCriterionError branch reuses the test-gate snapshot
    //     namespace, per pipeline.js).
    assert.ok(
      refExists(root, 'refs/test-gate/crit-fail'),
      'refs/test-gate/crit-fail must exist — the WIP must be pinned before the revert',
    );

    // (b) queue/crit-fail/criteria-failures.txt exists and names the failures.
    const failuresPath = path.join(root, 'queue', 'crit-fail', 'criteria-failures.txt');
    assert.ok(fs.existsSync(failuresPath), 'criteria-failures.txt must be written');
    const failuresContent = fs.readFileSync(failuresPath, 'utf8');
    assert.ok(failuresContent.includes('README documents setup'),
      `criteria-failures.txt must name 'README documents setup'. Got:\n${failuresContent}`);
    assert.ok(failuresContent.includes('README.md'),
      `criteria-failures.txt must name the missing target file. Got:\n${failuresContent}`);
    assert.ok(failuresContent.includes('lint passes'),
      `criteria-failures.txt must name 'lint passes'. Got:\n${failuresContent}`);
    assert.ok(failuresContent.includes('npm run lint'),
      `criteria-failures.txt must name the failing command. Got:\n${failuresContent}`);

    // (c) the working tree is reverted clean.
    assert.strictEqual(
      porcelain(root),
      '',
      `working tree must be clean after the spec-criteria disposition; got porcelain: "${porcelain(root)}"`,
    );
    assert.ok(
      !fs.existsSync(path.join(root, 'deliverable-crit-fail.txt')),
      'the uncommitted deliverable must have been reverted from the working tree',
    );

    // (d) the entry is requeued with status 'failed-criteria'.
    const entry = readQueueEntry(root, 'crit-fail');
    assert.ok(entry !== null, "queue entry 'crit-fail' must still exist");
    assert.strictEqual(entry.status, 'failed-criteria',
      `entry status should be 'failed-criteria', got '${entry?.status}'`);
  } finally {
    cleanup(root);
  }
});

// ── TC2 ───────────────────────────────────────────────────────────────────────
// Single path: resume() throws SpecCriterionError → NOT reverted, criteria
// printed clearly, non-zero exit, no raw stack escape.

await test('TC2: single — resume() SpecCriterionError → tree NOT reverted, criteria printed clearly, non-zero exit, no raw CLI escape', async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-spec-crit-single-' });
  try {
    // Simulate the WIP a milestone execution would have left behind before the
    // last-milestone drain fires — still uncommitted.
    fs.writeFileSync(path.join(root, 'deliverable-single.txt'), 'work in progress\n');
    assert.notStrictEqual(porcelain(root), '', 'precondition: tree must be dirty before resume() runs');

    const err = new SpecCriterionError(REALISTIC_FAILURES);
    const { stderr, capturedExitCodes, thrownError, sentinel } = await runSingleResumeWith(root, err);

    // (a) the working tree is NOT reverted — the WIP is left in place for a
    //     human to fix (unlike the batch path).
    assert.ok(
      fs.existsSync(path.join(root, 'deliverable-single.txt')),
      'the WIP deliverable must still exist — the single-run path must not revert',
    );
    assert.notStrictEqual(
      porcelain(root),
      '',
      'the working tree must still be dirty after a single-run SpecCriterionError — no revert on this path',
    );

    // (b) the failing criteria are printed clearly (the CLI's outer catch
    //     prints `Resume error: <err.message>`, and SpecCriterionError's
    //     message names every failure).
    assert.ok(
      stderr.includes('README documents setup'),
      `stderr must clearly name the failing criterion 'README documents setup'. Got:\n${stderr}`,
    );
    assert.ok(
      stderr.includes('lint passes'),
      `stderr must clearly name the failing criterion 'lint passes'. Got:\n${stderr}`,
    );
    assert.ok(
      stderr.includes('Resume error'),
      `stderr must clearly frame the failure as a resume error. Got:\n${stderr}`,
    );

    // (c) process exits non-zero via the thrown/returned contract.
    assert.ok(
      capturedExitCodes.length > 0 && capturedExitCodes.every((c) => c !== 0),
      `process.exit must have been called with a non-zero code. Got: [${capturedExitCodes.join(', ')}]`,
    );

    // (d) the SpecCriterionError does not escape raw to the CLI: what
    //     propagates out of resume() is the mocked process.exit's sentinel
    //     (thrown from inside the CLI's own catch, after it already printed
    //     the friendly message) — not the raw SpecCriterionError, and no
    //     unhandled stack was ever surfaced by resume() itself.
    assert.strictEqual(
      thrownError,
      sentinel,
      'the error escaping resume() must be the process.exit sentinel (caught internally), not the raw SpecCriterionError',
    );
    assert.notStrictEqual(thrownError?.name, 'SpecCriterionError',
      'the raw SpecCriterionError must not escape the CLI wrapper uncaught');
  } finally {
    cleanup(root);
  }
});

// ── TC3 ───────────────────────────────────────────────────────────────────────
// Degenerate inputs: empty failures array, and a missing/undefined failures
// field — both paths must still land cleanly with no crash.
//
// Note: SpecCriterionError's constructor computes its message from
// `failures.length` / `failures.map(...)`, so it requires an array-like at
// construction time. To exercise the "missing/undefined failures list" case
// (matching pipeline.js's own `(err.failures || [])` defensive guard in the
// batch catch), we construct with `[]` (a valid, safe input) and then
// overwrite `.failures` to `undefined` post-construction — producing exactly
// the object shape ({ name: 'SpecCriterionError', failures: undefined }) the
// disposition code must tolerate.
//
// Clarifying note: TC3a-TC3d (like TC2 above) drive their scenario through
// runSingleResumeWith(), which stubs Pipeline.prototype.resume to throw the
// constructed SpecCriterionError directly — it never calls through to the
// real resume() implementation. So these degenerate (empty/undefined
// .failures) cases verify the CLI/disposition layer's tolerance of that
// shape, but do NOT exercise the real resume() internal SpecCriterionError
// catch. Genuine internal-catch coverage of this degenerate shape lives in
// test/test-spec-criteria-resume-catch.js.

await test('TC3a: batch — SpecCriterionError([]) (empty failures) still lands failed-criteria with a written (empty-bodied) failures file and a reverted tree', async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-spec-crit-degen-' });
  try {
    createQueueEntry(root, 'degen-empty', {});

    const { pipeline } = makeRealBatchPipeline(root, {
      executeAllMilestones: async () => {
        fs.writeFileSync(path.join(root, 'deliverable-degen-empty.txt'), 'wip\n');
        throw new SpecCriterionError([]);
      },
    });
    pipeline.planner.verifyAssumptions = async () => [];

    await pipeline.batchResume({ autonomous: true });

    assert.ok(refExists(root, 'refs/test-gate/degen-empty'),
      'refs/test-gate/degen-empty must exist even for an empty failures list');
    const failuresPath = path.join(root, 'queue', 'degen-empty', 'criteria-failures.txt');
    assert.ok(fs.existsSync(failuresPath), 'criteria-failures.txt must still be written for an empty failures list');
    assert.strictEqual(porcelain(root), '',
      `working tree must be clean; got porcelain: "${porcelain(root)}"`);
    const entry = readQueueEntry(root, 'degen-empty');
    assert.strictEqual(entry.status, 'failed-criteria',
      `entry status should be 'failed-criteria', got '${entry?.status}'`);
  } finally {
    cleanup(root);
  }
});

await test('TC3b: batch — SpecCriterionError with undefined .failures still lands failed-criteria with no crash from mapping', async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-spec-crit-degen-' });
  try {
    createQueueEntry(root, 'degen-undef', {});

    const { pipeline } = makeRealBatchPipeline(root, {
      executeAllMilestones: async () => {
        fs.writeFileSync(path.join(root, 'deliverable-degen-undef.txt'), 'wip\n');
        const err = new SpecCriterionError([]);
        err.failures = undefined; // simulate a missing failures list reaching the disposition
        throw err;
      },
    });
    pipeline.planner.verifyAssumptions = async () => [];

    // Must not throw / crash the batch itself.
    await pipeline.batchResume({ autonomous: true });

    assert.ok(refExists(root, 'refs/test-gate/degen-undef'),
      'refs/test-gate/degen-undef must exist even when .failures is undefined');
    const failuresPath = path.join(root, 'queue', 'degen-undef', 'criteria-failures.txt');
    assert.ok(fs.existsSync(failuresPath), 'criteria-failures.txt must still be written when .failures is undefined');
    assert.strictEqual(porcelain(root), '',
      `working tree must be clean; got porcelain: "${porcelain(root)}"`);
    const entry = readQueueEntry(root, 'degen-undef');
    assert.strictEqual(entry.status, 'failed-criteria',
      `entry status should be 'failed-criteria', got '${entry?.status}'`);
  } finally {
    cleanup(root);
  }
});

await test('TC3c: single — resume() throwing SpecCriterionError([]) (empty failures) still prints and exits non-zero with no crash', async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-spec-crit-degen-single-' });
  try {
    fs.writeFileSync(path.join(root, 'deliverable-degen-empty-single.txt'), 'wip\n');

    const err = new SpecCriterionError([]);
    const { stderr, capturedExitCodes, thrownError, sentinel } = await runSingleResumeWith(root, err);

    assert.ok(fs.existsSync(path.join(root, 'deliverable-degen-empty-single.txt')),
      'the WIP deliverable must still exist — no revert on the single-run path');
    assert.ok(stderr.includes('Resume error'),
      `stderr must print a resume error even for an empty failures list. Got:\n${stderr}`);
    assert.ok(
      capturedExitCodes.length > 0 && capturedExitCodes.every((c) => c !== 0),
      `process.exit must have been called with a non-zero code. Got: [${capturedExitCodes.join(', ')}]`,
    );
    assert.strictEqual(thrownError, sentinel,
      'the error escaping resume() must be the process.exit sentinel, not the raw SpecCriterionError');
  } finally {
    cleanup(root);
  }
});

await test('TC3d: single — resume() throwing SpecCriterionError with undefined .failures still prints and exits non-zero with no crash', async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-spec-crit-degen-single-' });
  try {
    fs.writeFileSync(path.join(root, 'deliverable-degen-undef-single.txt'), 'wip\n');

    const err = new SpecCriterionError([]);
    err.failures = undefined;
    const { stderr, capturedExitCodes, thrownError, sentinel } = await runSingleResumeWith(root, err);

    assert.ok(fs.existsSync(path.join(root, 'deliverable-degen-undef-single.txt')),
      'the WIP deliverable must still exist — no revert on the single-run path');
    assert.ok(stderr.includes('Resume error'),
      `stderr must print a resume error even when .failures is undefined. Got:\n${stderr}`);
    assert.ok(
      capturedExitCodes.length > 0 && capturedExitCodes.every((c) => c !== 0),
      `process.exit must have been called with a non-zero code. Got: [${capturedExitCodes.join(', ')}]`,
    );
    assert.strictEqual(thrownError, sentinel,
      'the error escaping resume() must be the process.exit sentinel, not the raw SpecCriterionError');
  } finally {
    cleanup(root);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
