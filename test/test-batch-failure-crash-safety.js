#!/usr/bin/env node
/**
 * test-batch-failure-crash-safety.js — Tests for batchResume's crash-safe
 * failure-path cleanup (spec: batch-failure-crash-safety).
 *
 * Coverage (numbered after the spec's acceptance criteria):
 *   TC1  — crash-safety regression killed (git repo): execution failure +
 *          forensic archive that produces nothing + park commit with nothing
 *          to commit → batch does NOT reject; entry marked 'failed-execution'
 *          on disk with specJson passed through; a second pending entry is
 *          still processed
 *   TC2  — non-git projectRoot: execution failure → no rejection, entry
 *          marked 'failed-execution', batch continues (failure-path git
 *          steps skipped entirely)
 *   TC3  — contamination abort, failed-execution path: _assertBatchTreeClean
 *          stubbed to throw → batchResume rejects AND the entry was already
 *          marked 'failed-execution' before the rejection
 *   TC4a — contamination abort, TestGateError path: entry marked
 *          'failed-test-gate' first, then the rejection propagates
 *   TC4b — TestGateError clean case: revert succeeds, tree clean → entry
 *          re-queued as 'failed-test-gate' and the loop continues to the
 *          next entry exactly as today
 *   TC5a — _assertBatchTreeClean unit: clean git tree → returns
 *   TC5b — _assertBatchTreeClean unit: dirty tree (tracked file modified)
 *          → throws with the slug in the message
 *
 * Run: node test/test-batch-failure-crash-safety.js
 *
 * No live Claude sessions are spawned — all agent interactions are stubbed.
 * NOTE: TC2 drives git commands in a non-git directory; "fatal: not a git
 * repository" stderr noise from the batch-start guard is expected there.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeQueueEntry, readQueueEntry } from '../src/orchestrator/core/state.js';
import { TestGateError } from '../src/cli/commands/archive.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ── Fixture data ───────────────────────────────────────────────────────────

// Deliberately scope-item-free markdown (no '## Scope — in', no **Bug N**
// bullets, no scope-item markers, no backticked paths) so _scopeCoverageGate
// skips — mirrors test/test-queue-spec-json.js.
const SPEC_MD = `# Test Spec

This is a test spec for the batch failure crash-safety paths.

## Goals
- Build something useful
`;

// Parseable sibling json so the e7d3627 uncheckable-spec gate passes.
const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

function makePlan() {
  // Fresh-run shape: a goal-only plan attaches scopeItems:[]/scopeMapping:[]
  // (the gate skips on present-and-empty). Without the key it would be treated
  // as a LEGACY plan and the scope gate would fail-closed before this test's
  // behavior runs.
  return { milestones: [], assumptions: [], scopeItems: [], scopeMapping: [] };
}

function makeTmpRoot(prefix = 'cc-orch-crashsafe-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Git fixture: init + identity + tracked seed file + .gitignore covering the
// harness-side dirs (mirrors production, where queue/ and .harness/ are
// gitignored), committed so the tree starts clean.
function makeGitRoot(prefix = 'cc-orch-crashsafe-git-') {
  const root = makeTmpRoot(prefix);
  execSync('git init', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed content\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'queue/\narchives/\nfake-archives/\n.harness/\n');
  execSync('git add -A', { cwd: root, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: root, stdio: 'pipe' });
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Write a pending queue entry through the production write path. Entries
// carry specJson so the uncheckable-spec gate passes.
function createQueueEntry(root, slug, { validatedAt = new Date().toISOString() } = {}) {
  writeQueueEntry(root, slug, {
    spec: SPEC_MD,
    plan: makePlan(),
    validatedAt,
    status: 'pending',
    specJson: SPEC_JSON,
  });
}

// ── Helper: batch pipeline with stubbed agents + injected archive ──────────
// Mirrors test/test-queue-spec-json.js makeBatchPipeline; the `archive` opt
// is the this._archive injection seam. `onArchive(slug, archiveOpts, callIndex)`
// customizes per-test behavior (throw for forensic, TestGateError, …); the
// default creates and returns a fake archive dir.

function makeBatchPipeline(root, opts = {}) {
  const logs = [];
  const archiveCalls = [];
  let executeCallCount = 0;

  const defaultArchive = (callIndex) => {
    const dir = path.join(root, 'fake-archives', String(callIndex));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const archiveStub = async (_projectRoot, slug, archiveOpts) => {
    archiveCalls.push({ slug, opts: archiveOpts });
    if (opts.onArchive) {
      return opts.onArchive(slug, archiveOpts, archiveCalls.length, defaultArchive);
    }
    return defaultArchive(archiveCalls.length);
  };

  const pipeline = new Pipeline(root, {
    skipWorktreeCreation: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    archive: archiveStub,
  });

  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._executeAllMilestones = async () => { executeCallCount++; };
  pipeline._reviewGate = async () => {};

  return {
    pipeline,
    logs,
    archiveCalls,
    getExecuteCount: () => executeCallCount,
  };
}

// ── TC1: crash-safety regression killed (git repo) ─────────────────────────

await test('TC1: git repo — execution failure + forensic archive producing nothing + nothing-to-commit park commit → no rejection, entry failed-execution with specJson, second entry still processed', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'crash-a', { validatedAt: '2026-06-01T00:00:00.000Z' });
    createQueueEntry(root, 'crash-b', { validatedAt: '2026-06-02T00:00:00.000Z' });

    const { pipeline, archiveCalls } = makeBatchPipeline(root, {
      // Forensic archive produces nothing (throws); the success-path archive
      // for the second entry returns a real dir.
      onArchive: (slug, archiveOpts, callIndex, defaultArchive) => {
        if (archiveOpts && archiveOpts['include-failed']) {
          throw new Error('forensic archive produced nothing');
        }
        return defaultArchive(callIndex);
      },
    });

    let executeCount = 0;
    pipeline._executeAllMilestones = async () => {
      executeCount++;
      if (executeCount === 1) throw new Error('milestone execution exploded');
    };

    // The bug under test: at the broken baseline this REJECTS (the unguarded
    // `git add archives/` + park commit throws out of the catch).
    const result = await pipeline.batchResume({});

    assert.strictEqual(result.failed, 1, `expected failed:1, got ${result.failed}`);
    assert.strictEqual(result.archived, 1, `expected archived:1 (second entry processed), got ${result.archived}`);

    // Persist→re-read: the status write must have reached disk despite every
    // best-effort git step failing.
    const entry = readQueueEntry(root, 'crash-a');
    assert.ok(entry, "entry 'crash-a' must still exist in the queue");
    assert.strictEqual(entry.status, 'failed-execution',
      `entry 'crash-a' expected status 'failed-execution', got '${entry.status}'`);
    assert.strictEqual(entry.specJson, SPEC_JSON,
      'specJson must be passed through on the failed-execution write');

    // Second entry was processed: executed and removed from the queue.
    assert.strictEqual(executeCount, 2,
      `_executeAllMilestones should run for BOTH entries (got ${executeCount}); the batch must continue past the first failure`);
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'crash-b')),
      "entry 'crash-b' should be removed after its successful run");

    // The forensic archive was attempted exactly once, for the failed entry.
    const forensic = archiveCalls.filter((c) => c.opts && c.opts['include-failed']);
    assert.strictEqual(forensic.length, 1,
      `expected exactly one forensic archive attempt, got ${forensic.length}`);
    assert.strictEqual(forensic[0].slug, 'crash-a', 'forensic archive must target the failed entry');
  } finally {
    cleanup(root);
  }
});

// ── TC2: non-git projectRoot — failure-path git steps skipped entirely ─────

await test('TC2: non-git root — execution failure → no rejection, entry failed-execution, batch continues', async () => {
  const root = makeTmpRoot('cc-orch-crashsafe-nogit-');
  try {
    createQueueEntry(root, 'nogit-a');

    const { pipeline, logs } = makeBatchPipeline(root, {
      onArchive: (slug, archiveOpts, callIndex, defaultArchive) => {
        if (archiveOpts && archiveOpts['include-failed']) {
          throw new Error('forensic archive produced nothing');
        }
        return defaultArchive(callIndex);
      },
    });
    pipeline._executeAllMilestones = async () => {
      throw new Error('milestone execution exploded');
    };

    // At the broken baseline this rejects: every failure-path git call throws
    // in a non-repo. Post-fix the git steps are skipped (isGitRepo === false).
    const result = await pipeline.batchResume({});

    assert.ok(logs.some((l) => l.includes('Clean-tree guard skipped')),
      'the batch-start guard should have logged that the clean-tree guard was skipped (non-git root)');
    assert.strictEqual(result.failed, 1, `expected failed:1, got ${result.failed}`);
    assert.strictEqual(result.archived, 0, `expected archived:0, got ${result.archived}`);

    const entry = readQueueEntry(root, 'nogit-a');
    assert.ok(entry, "entry 'nogit-a' must still exist in the queue");
    assert.strictEqual(entry.status, 'failed-execution',
      `entry 'nogit-a' expected status 'failed-execution', got '${entry.status}'`);
    assert.strictEqual(entry.specJson, SPEC_JSON,
      'specJson must be passed through on the failed-execution write');
  } finally {
    cleanup(root);
  }
});

// ── TC3: contamination abort — failed-execution path ───────────────────────

await test('TC3: contamination abort (failed-execution path) — _assertBatchTreeClean stubbed to throw → batchResume rejects with the entry already marked failed-execution', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'exec-abort');

    const { pipeline } = makeBatchPipeline(root, {
      onArchive: (slug, archiveOpts, callIndex, defaultArchive) => {
        if (archiveOpts && archiveOpts['include-failed']) {
          throw new Error('forensic archive produced nothing');
        }
        return defaultArchive(callIndex);
      },
    });
    pipeline._executeAllMilestones = async () => {
      throw new Error('milestone execution exploded');
    };
    pipeline._assertBatchTreeClean = (slug) => {
      throw new Error('contaminated: ' + slug);
    };

    await assert.rejects(
      () => pipeline.batchResume({}),
      /contaminated: exec-abort/,
      'batchResume must reject with the cleanliness-verification error (fail-closed, no swallowing)'
    );

    // The abort must happen AFTER the status write: read back from disk
    // after the rejection.
    const entry = readQueueEntry(root, 'exec-abort');
    assert.ok(entry, "entry 'exec-abort' must still exist in the queue");
    assert.strictEqual(entry.status, 'failed-execution',
      `entry must already be marked 'failed-execution' before the abort propagates, got '${entry.status}'`);
    assert.strictEqual(entry.specJson, SPEC_JSON,
      'specJson must be passed through on the failed-execution write');
  } finally {
    cleanup(root);
  }
});

// ── TC4a: contamination abort — TestGateError path ─────────────────────────

await test('TC4a: contamination abort (TestGateError path) — entry marked failed-test-gate, then the rejection propagates', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'tg-abort');

    const { pipeline } = makeBatchPipeline(root, {
      // Success-path archive throws TestGateError → routes to the
      // failed-test-gate branch (milestones completed, suite red).
      onArchive: () => {
        throw new TestGateError('npm run test:all failed after archive');
      },
    });
    pipeline._assertBatchTreeClean = (slug) => {
      throw new Error('contaminated: ' + slug);
    };

    await assert.rejects(
      () => pipeline.batchResume({}),
      /contaminated: tg-abort/,
      'batchResume must reject with the cleanliness-verification error on the TestGateError path too'
    );

    const entry = readQueueEntry(root, 'tg-abort');
    assert.ok(entry, "entry 'tg-abort' must still exist in the queue");
    assert.strictEqual(entry.status, 'failed-test-gate',
      `entry must already be marked 'failed-test-gate' before the abort propagates, got '${entry.status}'`);
    assert.strictEqual(entry.specJson, SPEC_JSON,
      'specJson must be passed through on the failed-test-gate write');
  } finally {
    cleanup(root);
  }
});

// ── TC4b: TestGateError clean case — loop continues exactly as today ───────

await test('TC4b: TestGateError clean case — entry re-queued as failed-test-gate, batch continues to the next entry', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'tg-a', { validatedAt: '2026-06-01T00:00:00.000Z' });
    createQueueEntry(root, 'tg-b', { validatedAt: '2026-06-02T00:00:00.000Z' });

    const { pipeline, archiveCalls, getExecuteCount } = makeBatchPipeline(root, {
      // First success-path archive (entry tg-a) hits the red suite; the
      // second (entry tg-b) succeeds.
      onArchive: (slug, archiveOpts, callIndex, defaultArchive) => {
        if (callIndex === 1) {
          throw new TestGateError('npm run test:all failed after archive');
        }
        return defaultArchive(callIndex);
      },
    });

    const result = await pipeline.batchResume({});

    assert.strictEqual(result.failed, 1, `expected failed:1, got ${result.failed}`);
    assert.strictEqual(result.archived, 1, `expected archived:1, got ${result.archived}`);
    assert.strictEqual(getExecuteCount(), 2,
      `_executeAllMilestones should run for BOTH entries (got ${getExecuteCount()})`);

    const entry = readQueueEntry(root, 'tg-a');
    assert.ok(entry, "entry 'tg-a' must still exist in the queue (re-queued, not removed)");
    assert.strictEqual(entry.status, 'failed-test-gate',
      `entry 'tg-a' expected status 'failed-test-gate', got '${entry.status}'`);
    assert.strictEqual(entry.specJson, SPEC_JSON,
      'specJson must be passed through on the failed-test-gate write');

    assert.ok(!fs.existsSync(path.join(root, 'queue', 'tg-b')),
      "entry 'tg-b' should be removed after its successful run");

    // TestGateError semantics unchanged: NO forensic archive on that path.
    const forensic = archiveCalls.filter((c) => c.opts && c.opts['include-failed']);
    assert.strictEqual(forensic.length, 0,
      `no forensic archive may be produced on the TestGateError path (got ${forensic.length})`);
  } finally {
    cleanup(root);
  }
});

// ── TC5a: _assertBatchTreeClean unit — clean tree returns ──────────────────

await test('TC5a: _assertBatchTreeClean on a clean git tree returns without throwing', async () => {
  const root = makeGitRoot();
  try {
    const { pipeline } = makeBatchPipeline(root);
    assert.strictEqual(typeof pipeline._assertBatchTreeClean, 'function',
      '_assertBatchTreeClean must be an instance method on Pipeline');

    // Tolerate a sync or async implementation; neither may throw/reject.
    const result = pipeline._assertBatchTreeClean('clean-slug');
    if (result && typeof result.then === 'function') await result;
  } finally {
    cleanup(root);
  }
});

// ── TC5b: _assertBatchTreeClean unit — dirty tree throws with the slug ─────

await test('TC5b: _assertBatchTreeClean on a dirty tree (tracked file modified) throws an Error naming the slug', async () => {
  const root = makeGitRoot();
  try {
    const { pipeline } = makeBatchPipeline(root);
    assert.strictEqual(typeof pipeline._assertBatchTreeClean, 'function',
      '_assertBatchTreeClean must be an instance method on Pipeline');

    // Dirty the tree: modify a TRACKED file so `git status --porcelain` is
    // non-empty (queue/, .harness/ etc. are gitignored in this fixture).
    fs.writeFileSync(path.join(root, 'seed.txt'), 'modified content\n');

    let thrown = null;
    try {
      const result = pipeline._assertBatchTreeClean('dirty-slug');
      if (result && typeof result.then === 'function') await result;
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, '_assertBatchTreeClean must throw on a dirty tree');
    assert.ok(thrown instanceof Error, `expected an Error, got ${typeof thrown}`);
    assert.ok(thrown.message.includes('dirty-slug'),
      `the error message must name the slug 'dirty-slug' (got: ${thrown.message})`);
  } finally {
    cleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
