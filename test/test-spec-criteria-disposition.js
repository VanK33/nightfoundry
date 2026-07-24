#!/usr/bin/env node
/**
 * test-spec-criteria-disposition.js — Integration tests for the batchResume
 * spec-criteria failure disposition (pipeline.js's SpecCriterionError branch).
 *
 * When the last milestone's spec-criteria drain fails one or more acceptance
 * criteria (file-check or command-check), batchResume must:
 *   - preserve the pre-revert WIP into a gc-safe refs/test-gate/<slug> snapshot
 *     (createParkSnapshot(slug, root, 'refs/test-gate/') — the SpecCriterionError
 *     branch reuses the test-gate snapshot namespace);
 *   - persist the failing criteria (file-check and/or command-check) to
 *     queue/<slug>/criteria-failures.txt, and also emit each failure line to
 *     the onLog log;
 *   - revert the (still-uncommitted) working tree via `git reset --hard` +
 *     `git clean` so the batch stays isolated;
 *   - re-queue the entry as status 'failed-criteria' (NOT 'failed-execution',
 *     NOT a forensic archive — this is unmet acceptance criteria, not a halt).
 *
 * A failure to snapshot (createParkSnapshot throws) must degrade SOFT: the
 * rest of the disposition (failures file, revert, status, log) still
 * completes; only a loud error line is logged for the snapshot step.
 *
 * Test cases:
 *   TC1 — full disposition: refs/test-gate/<slug> ref exists, criteria-failures.txt
 *         names the failing criteria (targetFile and/or command lines), the
 *         failures are emitted to the onLog log, the tree is clean, entry
 *         status === 'failed-criteria'.
 *   TC2 — soft degrade: createParkSnapshot throws (pre-existing refs/test-gate
 *         D/F ref conflict) → disposition still completes (requeued
 *         'failed-criteria', tree clean), and a loud snapshot-failure message
 *         is logged.
 *
 * These tests drive the REAL Pipeline.batchResume against a temp git repo
 * (the shared makeGitRoot/makeRealBatchPipeline fixtures from
 * test/helpers/batch-fixtures.js — the same seam used by
 * test-test-gate-disposition.js). Only archive() and _executeAllMilestones
 * are stubbed; the disposition branch itself (pipeline.js's SpecCriterionError
 * catch) runs unmodified.
 *
 * Run: node test/test-spec-criteria-disposition.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { readQueueEntry } from '../src/orchestrator/core/state.js';
import { SpecCriterionError } from '../src/orchestrator/core/spec-criterion-error.js';
import {
  makeGitRoot,
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

// Realistic failing-criteria shapes matching the contract documented on
// SpecCriterionError: a file-check failure ({ name, targetFile }) and a
// command-check failure ({ name, command, exitCode }).
const REALISTIC_FAILURES = [
  { name: 'README documents setup', targetFile: 'README.md' },
  { name: 'lint passes', command: 'npm run lint', exitCode: 1 },
];

// A no-op archive() stub — never actually invoked by this disposition (the
// drain failure happens inside milestone execution, before archive() would
// be called), but stubbed per the fixture contract so a stray call surfaces
// loudly instead of hitting a live Summarizer.
async function archiveStub(_projectRoot, slug, _opts) {
  throw new Error(`archive() must not be called for slug '${slug}' on a SpecCriterionError disposition`);
}

// ── TC1 ───────────────────────────────────────────────────────────────────────
// full disposition on a spec-criteria failure

await test('TC1: spec-criteria failure → refs/test-gate/<slug> snapshot + criteria-failures.txt + FAIL lines logged + clean tree + failed-criteria', async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-spec-crit-' });
  try {
    createQueueEntry(root, 'crit-fail', {});

    const { pipeline, logs } = makeRealBatchPipeline(root, {
      archive: archiveStub,
      executeAllMilestones: async () => {
        // Deliverable written by the (stubbed) milestone execution — still
        // uncommitted when the spec-criteria drain throws, so this is what
        // gets snapshotted/reverted by the disposition below.
        fs.writeFileSync(path.join(root, 'deliverable-crit-fail.txt'), 'work in progress\n');
        throw new SpecCriterionError(REALISTIC_FAILURES);
      },
    });
    pipeline.planner.verifyAssumptions = async () => []; // all pass, no remediation

    await pipeline.batchResume({ autonomous: true });

    // (a) refs/test-gate/crit-fail exists — the pre-revert WIP is snapshotted.
    assert.ok(
      refExists(root, 'refs/test-gate/crit-fail'),
      'refs/test-gate/crit-fail must exist (git rev-parse --verify) — the WIP must be pinned before the revert',
    );

    // (b) queue/crit-fail/criteria-failures.txt exists and names the failing
    //     criteria — both the file-check and the command-check shapes.
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

    // (c) the failing criteria lines were emitted to the onLog log array.
    assert.ok(
      logs.some((l) => l.includes('README documents setup')),
      `expected a log line naming 'README documents setup'. Logs:\n${logs.join('\n')}`,
    );
    assert.ok(
      logs.some((l) => l.includes('lint passes')),
      `expected a log line naming 'lint passes'. Logs:\n${logs.join('\n')}`,
    );

    // (d) the working tree is reverted clean.
    assert.strictEqual(
      porcelain(root),
      '',
      `working tree must be clean after the spec-criteria disposition; got porcelain: "${porcelain(root)}"`,
    );
    assert.ok(
      !fs.existsSync(path.join(root, 'deliverable-crit-fail.txt')),
      'the uncommitted deliverable must have been reverted from the working tree',
    );

    // (e) the entry is requeued with status 'failed-criteria'.
    const entry = readQueueEntry(root, 'crit-fail');
    assert.ok(entry !== null, "queue entry 'crit-fail' must still exist");
    assert.strictEqual(entry.status, 'failed-criteria',
      `entry status should be 'failed-criteria', got '${entry?.status}'`);
  } finally {
    cleanup(root);
  }
});

// ── TC2 ───────────────────────────────────────────────────────────────────────
// soft degrade: createParkSnapshot throws (pre-existing refs/test-gate D/F
// conflict) → disposition still completes, snapshot failure logged loudly.

await test("TC2: createParkSnapshot throw (refs/test-gate D/F conflict) degrades soft — still requeued failed-criteria, tree clean, snapshot failure logged", async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-spec-crit-' });
  try {
    createQueueEntry(root, 'crit-fail2', {});

    // Pre-create a ref at exactly 'refs/test-gate' (a loose ref FILE). Later,
    // createParkSnapshot('crit-fail2', root, 'refs/test-gate/') will try
    // `git update-ref refs/test-gate/crit-fail2 <sha>`, which requires
    // 'refs/test-gate' to be usable as a DIRECTORY — a D/F conflict that makes
    // the update-ref (and therefore createParkSnapshot) throw.
    const headSha = git(['rev-parse', 'HEAD'], root).trim();
    git(['update-ref', 'refs/test-gate', headSha], root);

    const { pipeline, logs } = makeRealBatchPipeline(root, {
      archive: archiveStub,
      executeAllMilestones: async () => {
        fs.writeFileSync(path.join(root, 'deliverable-crit-fail2.txt'), 'work in progress\n');
        throw new SpecCriterionError(REALISTIC_FAILURES);
      },
    });
    pipeline.planner.verifyAssumptions = async () => [];

    await pipeline.batchResume({ autonomous: true });

    // The disposition still completes despite the snapshot failure:

    // (a) entry still requeued 'failed-criteria'.
    const entry = readQueueEntry(root, 'crit-fail2');
    assert.ok(entry !== null, "queue entry 'crit-fail2' must still exist");
    assert.strictEqual(entry.status, 'failed-criteria',
      `entry status should be 'failed-criteria' even when the snapshot failed, got '${entry?.status}'`);

    // (b) the working tree is still reverted clean.
    assert.strictEqual(
      porcelain(root),
      '',
      `working tree must be clean even when the snapshot step failed; got porcelain: "${porcelain(root)}"`,
    );
    assert.ok(
      !fs.existsSync(path.join(root, 'deliverable-crit-fail2.txt')),
      'the uncommitted deliverable must have been reverted from the working tree',
    );

    // (c) a loud snapshot-failure message was logged.
    assert.ok(
      logs.some((l) => /ERROR: failed to snapshot work for 'crit-fail2'/.test(l)),
      `expected a loud snapshot-failure log line for 'crit-fail2'. Logs:\n${logs.join('\n')}`,
    );

    // (d) the pre-existing refs/test-gate ref (the conflict source) is
    //     unharmed — the D/F conflict means no refs/test-gate/crit-fail2 ref
    //     could ever be created.
    assert.ok(refExists(root, 'refs/test-gate'),
      'the pre-existing refs/test-gate ref should be untouched by the failed snapshot attempt');
    assert.ok(!refExists(root, 'refs/test-gate/crit-fail2'),
      'refs/test-gate/crit-fail2 must NOT exist — the D/F conflict prevented its creation');
  } finally {
    cleanup(root);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
