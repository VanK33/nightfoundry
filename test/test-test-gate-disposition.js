#!/usr/bin/env node
/**
 * test-test-gate-disposition.js — Integration tests for the batchResume
 * final-test-gate failure disposition (pipeline.js's TestGateError branch).
 *
 * When an archived spec's final test gate (`npm run test:all`) fails,
 * archive() throws a TestGateError. batchResume must:
 *   - preserve the pre-revert WIP into a gc-safe refs/test-gate/<slug> snapshot
 *     (createParkSnapshot(slug, root, 'refs/test-gate/'));
 *   - extract the per-test FAIL marker lines + the summary Total line from the
 *     error message tail and persist them to
 *     queue/<slug>/test-gate-failures.txt, and also emit the FAIL lines to the
 *     onLog log;
 *   - revert the (still-uncommitted) working tree via `git reset --hard` +
 *     `git clean` so the batch stays isolated;
 *   - re-queue the entry as status 'failed-test-gate' (NOT 'failed-execution',
 *     NOT a forensic archive — this is a red suite, not a halt).
 *
 * A failure to snapshot (createParkSnapshot throws) must degrade SOFT: the
 * rest of the disposition (failures file, revert, status, log) still
 * completes; only a loud error line is logged for the snapshot step.
 *
 * Test cases:
 *   TC1 — full disposition: refs/test-gate/<slug> ref exists, failures file
 *         names the failing tests + Total line, FAIL lines are in the log,
 *         tree is clean, entry status === 'failed-test-gate'.
 *   TC2 — soft degrade: createParkSnapshot throws (pre-existing refs/test-gate
 *         D/F ref conflict) → disposition still completes (requeued
 *         'failed-test-gate', tree clean), and a loud snapshot-failure message
 *         is logged.
 *   TC3 — non-git root: the failures-file + [FAIL]-log diagnostics still run
 *         (they are not gated on isGitRepo), while the git-only
 *         createParkSnapshot/revert steps are skipped entirely; entry is
 *         still requeued 'failed-test-gate'.
 *
 * These tests drive the REAL Pipeline.batchResume against a temp git repo
 * (the shared makeGitRoot/makeRealBatchPipeline fixtures from
 * test/helpers/batch-fixtures.js — the same seam used by
 * test-batch-revert-and-continue.js's TC-REVERT-6). Only archive() and
 * _executeAllMilestones are stubbed; the disposition branch itself
 * (pipeline.js's TestGateError catch) runs unmodified.
 *
 * Run: node test/test-test-gate-disposition.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { readQueueEntry } from '../src/orchestrator/core/state.js';
import { TestGateError } from '../src/cli/commands/archive.js';
import {
  makeGitRoot,
  makeTmpRoot,
  cleanup,
  porcelain,
  refExists,
  createQueueEntry,
  makeRealBatchPipeline,
  git,
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

// ── Fixture helpers ──────────────────────────────────────────────────────────

// The TestGateError message shape the pipeline parses (mirrors
// src/cli/commands/archive.js's real construction): a
// '--- tail of test output ---' section holding per-test FAIL marker lines
// plus a summary Total line.
const TAIL_MARKER = '--- tail of test output ---\n';

function makeGateError(tail) {
  return new TestGateError(
    'Final test gate failed: `npm run test:all` exited 1. ' +
    'Refusing to archive a spec whose test suite does not pass. ' +
    'Fix the tests and re-run, or pass --skip-test-gate to override.\n' +
    TAIL_MARKER + tail,
  );
}

// Realistic per-test FAIL marker lines + a Total line, matching the
// production regexes: /\[FAIL\]/ for FAIL lines, /^\s*Total:/ for the summary.
const FAIL_TAIL = [
  '  [FAIL] test/unit/foo.test.js',
  '  [FAIL] test/unit/bar.test.js',
  '  Total: 2 failed, 8 passed',
].join('\n');

// ── TC1 ───────────────────────────────────────────────────────────────────────
// full disposition on a final-test-gate failure

await test('TC1: final test-gate failure → refs/test-gate/<slug> snapshot + failures file + FAIL lines logged + clean tree + failed-test-gate', async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-test-gate-' });
  try {
    createQueueEntry(root, 'gate-fail', {});

    const { pipeline, logs } = makeRealBatchPipeline(root, {
      archive: async (_projectRoot, slug, opts = {}) => {
        assert.strictEqual(slug, 'gate-fail', `unexpected archive() call for slug '${slug}'`);
        assert.ok(!opts['include-failed'],
          'a test-gate failure must NOT trigger a forensic (include-failed) re-archive');
        throw makeGateError(FAIL_TAIL);
      },
      executeAllMilestones: async () => {
        // Deliverable written by the (stubbed) milestone execution — still
        // uncommitted when archive() throws, so this is what gets
        // snapshotted/reverted by the disposition below.
        fs.writeFileSync(path.join(root, 'deliverable-gate-fail.txt'), 'work in progress\n');
      },
    });
    pipeline.planner.verifyAssumptions = async () => []; // all pass, no remediation

    await pipeline.batchResume({ autonomous: true });

    // (a) refs/test-gate/gate-fail exists — the pre-revert WIP is snapshotted.
    assert.ok(
      refExists(root, 'refs/test-gate/gate-fail'),
      'refs/test-gate/gate-fail must exist (git rev-parse --verify) — the WIP must be pinned before the revert',
    );

    // (b) queue/gate-fail/test-gate-failures.txt exists and names the failing
    //     test files + the Total line.
    const failuresPath = path.join(root, 'queue', 'gate-fail', 'test-gate-failures.txt');
    assert.ok(fs.existsSync(failuresPath), 'test-gate-failures.txt must be written');
    const failuresContent = fs.readFileSync(failuresPath, 'utf8');
    assert.ok(failuresContent.includes('test/unit/foo.test.js'),
      `test-gate-failures.txt must name test/unit/foo.test.js. Got:\n${failuresContent}`);
    assert.ok(failuresContent.includes('test/unit/bar.test.js'),
      `test-gate-failures.txt must name test/unit/bar.test.js. Got:\n${failuresContent}`);
    assert.ok(failuresContent.includes('Total: 2 failed, 8 passed'),
      `test-gate-failures.txt must include the Total line. Got:\n${failuresContent}`);

    // (c) the injected FAIL marker lines were emitted to the onLog log array.
    assert.ok(
      logs.some((l) => l.includes('[FAIL] test/unit/foo.test.js')),
      `expected a log line containing '[FAIL] test/unit/foo.test.js'. Logs:\n${logs.join('\n')}`,
    );
    assert.ok(
      logs.some((l) => l.includes('[FAIL] test/unit/bar.test.js')),
      `expected a log line containing '[FAIL] test/unit/bar.test.js'. Logs:\n${logs.join('\n')}`,
    );

    // (d) the working tree is reverted clean.
    assert.strictEqual(
      porcelain(root),
      '',
      `working tree must be clean after the test-gate disposition; got porcelain: "${porcelain(root)}"`,
    );
    assert.ok(
      !fs.existsSync(path.join(root, 'deliverable-gate-fail.txt')),
      'the uncommitted deliverable must have been reverted from the working tree',
    );

    // (e) the entry is requeued with status 'failed-test-gate'.
    const entry = readQueueEntry(root, 'gate-fail');
    assert.ok(entry !== null, "queue entry 'gate-fail' must still exist");
    assert.strictEqual(entry.status, 'failed-test-gate',
      `entry status should be 'failed-test-gate', got '${entry?.status}'`);
  } finally {
    cleanup(root);
  }
});

// ── TC2 ───────────────────────────────────────────────────────────────────────
// soft degrade: createParkSnapshot throws (pre-existing refs/test-gate D/F
// conflict) → disposition still completes, snapshot failure logged loudly.

await test("TC2: createParkSnapshot throw (refs/test-gate D/F conflict) degrades soft — still requeued failed-test-gate, tree clean, snapshot failure logged", async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-test-gate-' });
  try {
    createQueueEntry(root, 'gate-fail2', {});

    // Pre-create a ref at exactly 'refs/test-gate' (a loose ref FILE). Later,
    // createParkSnapshot('gate-fail2', root, 'refs/test-gate/') will try
    // `git update-ref refs/test-gate/gate-fail2 <sha>`, which requires
    // 'refs/test-gate' to be usable as a DIRECTORY — a D/F conflict that makes
    // the update-ref (and therefore createParkSnapshot) throw.
    const headSha = git(['rev-parse', 'HEAD'], root).trim();
    git(['update-ref', 'refs/test-gate', headSha], root);

    const { pipeline, logs } = makeRealBatchPipeline(root, {
      archive: async (_projectRoot, slug, opts = {}) => {
        assert.strictEqual(slug, 'gate-fail2', `unexpected archive() call for slug '${slug}'`);
        assert.ok(!opts['include-failed'],
          'a test-gate failure must NOT trigger a forensic (include-failed) re-archive');
        throw makeGateError(FAIL_TAIL);
      },
      executeAllMilestones: async () => {
        fs.writeFileSync(path.join(root, 'deliverable-gate-fail2.txt'), 'work in progress\n');
      },
    });
    pipeline.planner.verifyAssumptions = async () => [];

    await pipeline.batchResume({ autonomous: true });

    // The disposition still completes despite the snapshot failure:

    // (a) entry still requeued 'failed-test-gate'.
    const entry = readQueueEntry(root, 'gate-fail2');
    assert.ok(entry !== null, "queue entry 'gate-fail2' must still exist");
    assert.strictEqual(entry.status, 'failed-test-gate',
      `entry status should be 'failed-test-gate' even when the snapshot failed, got '${entry?.status}'`);

    // (b) the working tree is still reverted clean.
    assert.strictEqual(
      porcelain(root),
      '',
      `working tree must be clean even when the snapshot step failed; got porcelain: "${porcelain(root)}"`,
    );
    assert.ok(
      !fs.existsSync(path.join(root, 'deliverable-gate-fail2.txt')),
      'the uncommitted deliverable must have been reverted from the working tree',
    );

    // (c) a loud snapshot-failure message was logged.
    assert.ok(
      logs.some((l) => /ERROR: failed to snapshot work for 'gate-fail2'/.test(l)),
      `expected a loud snapshot-failure log line for 'gate-fail2'. Logs:\n${logs.join('\n')}`,
    );

    // (d) the pre-existing refs/test-gate ref (the conflict source) is
    //     unharmed — the D/F conflict means no refs/test-gate/gate-fail2 ref
    //     could ever be created.
    assert.ok(refExists(root, 'refs/test-gate'),
      'the pre-existing refs/test-gate ref should be untouched by the failed snapshot attempt');
    assert.ok(!refExists(root, 'refs/test-gate/gate-fail2'),
      'refs/test-gate/gate-fail2 must NOT exist — the D/F conflict prevented its creation');
  } finally {
    cleanup(root);
  }
});

// ── TC3 ───────────────────────────────────────────────────────────────────────
// non-git root: the diagnostics (failures file + [FAIL] log lines) still run
// even though the git-only createParkSnapshot/revert steps are skipped.

await test('TC3 (non-git): TestGateError on non-git root writes test-gate-failures.txt AND logs [FAIL] lines while git revert is skipped; entry status === \'failed-test-gate\'', async () => {
  const root = makeTmpRoot('cc-orch-test-gate-nongit-');
  try {
    createQueueEntry(root, 'gate-fail-nongit', {});

    const { pipeline, logs } = makeRealBatchPipeline(root, {
      archive: async (_projectRoot, slug, opts = {}) => {
        assert.strictEqual(slug, 'gate-fail-nongit', `unexpected archive() call for slug '${slug}'`);
        assert.ok(!opts['include-failed'],
          'a test-gate failure must NOT trigger a forensic (include-failed) re-archive');
        throw makeGateError(FAIL_TAIL);
      },
      executeAllMilestones: async () => {
        // Deliverable written by the (stubbed) milestone execution — since
        // there is no git repo here, there is nothing to revert; this just
        // proves the (skipped) revert step is never invoked to remove it.
        fs.writeFileSync(path.join(root, 'deliverable-gate-fail-nongit.txt'), 'work in progress\n');
      },
    });
    pipeline.planner.verifyAssumptions = async () => []; // all pass, no remediation

    await pipeline.batchResume({ autonomous: true });

    // (a) no git repo exists at all — refs/test-gate/* is meaningless here;
    //     the git-guarded createParkSnapshot/revert must not have run.
    assert.ok(
      !fs.existsSync(path.join(root, '.git')),
      'no .git directory should exist or have been created in the non-git root',
    );

    // (b) queue/gate-fail-nongit/test-gate-failures.txt exists and names the
    //     failing test files + the Total line — the diagnostics extraction
    //     runs unconditionally, regardless of isGitRepo.
    const failuresPath = path.join(root, 'queue', 'gate-fail-nongit', 'test-gate-failures.txt');
    assert.ok(fs.existsSync(failuresPath), 'test-gate-failures.txt must be written even on a non-git root');
    const failuresContent = fs.readFileSync(failuresPath, 'utf8');
    assert.ok(failuresContent.includes('test/unit/foo.test.js'),
      `test-gate-failures.txt must name test/unit/foo.test.js. Got:\n${failuresContent}`);
    assert.ok(failuresContent.includes('test/unit/bar.test.js'),
      `test-gate-failures.txt must name test/unit/bar.test.js. Got:\n${failuresContent}`);
    assert.ok(failuresContent.includes('Total: 2 failed, 8 passed'),
      `test-gate-failures.txt must include the Total line. Got:\n${failuresContent}`);

    // (c) the injected FAIL marker lines were emitted to the onLog log array.
    assert.ok(
      logs.some((l) => l.includes('[FAIL] test/unit/foo.test.js')),
      `expected a log line containing '[FAIL] test/unit/foo.test.js'. Logs:\n${logs.join('\n')}`,
    );
    assert.ok(
      logs.some((l) => l.includes('[FAIL] test/unit/bar.test.js')),
      `expected a log line containing '[FAIL] test/unit/bar.test.js'. Logs:\n${logs.join('\n')}`,
    );

    // (d) no git reset/clean revert occurs — the deliverable written during
    //     (stubbed) milestone execution is NOT removed, since there is no
    //     git-guarded revert to run on a non-git root.
    assert.ok(
      fs.existsSync(path.join(root, 'deliverable-gate-fail-nongit.txt')),
      'the deliverable must survive untouched — the git-guarded revert must be skipped on a non-git root',
    );

    // (e) the entry is requeued with status 'failed-test-gate'.
    const entry = readQueueEntry(root, 'gate-fail-nongit');
    assert.ok(entry !== null, "queue entry 'gate-fail-nongit' must still exist");
    assert.strictEqual(entry.status, 'failed-test-gate',
      `entry status should be 'failed-test-gate', got '${entry?.status}'`);
  } finally {
    cleanup(root);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
