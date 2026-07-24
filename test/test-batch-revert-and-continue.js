#!/usr/bin/env node
/**
 * test-batch-revert-and-continue.js — Integration tests for batchResume execution-failure
 * park-and-continue behavior (spec: spec-batch-revert-and-continue.md).
 *
 * Test cases:
 *   TC-REVERT-1 — execution throw parks and continues: queue with 3 specs; spec #2 throws;
 *                 assert spec #1 committed+archived, spec #2 → failed-execution, spec #3 runs.
 *   TC-REVERT-2 — failed spec's code edits are reverted, earlier spec's survive:
 *                 spec #1 writes file A (committed); spec #2 writes file B then throws;
 *                 assert file A present (committed) and file B absent (reverted).
 *   TC-REVERT-3 — forensic archive survives the clean: after spec #2 failure, assert
 *                 archives/failed-{seq}-{slug}/ still exists (committed before clean).
 *   TC-REVERT-4 — dirty-tree refusal: dirty working tree at batch start causes batchResume
 *                 to refuse with clear message, no specs run.
 *   TC-REVERT-5 — InfrastructureError pauses, not parks: spec #2 throws InfrastructureError;
 *                 assert it propagates (batch stops, spec #2 stays pending, not failed-execution).
 *
 * Run: node test/test-batch-revert-and-continue.js
 *
 * Architecture note
 * ─────────────────
 * These tests drive the REAL Pipeline.prototype.batchResume against a temp git repo,
 * so the production spec-boundary commit / forensic-archive / git reset --hard / git clean
 * path is exercised end-to-end (spec criterion #10). Only the leaf collaborators are stubbed:
 *   - archive() is injected via the Pipeline `archive` constructor seam (makeStubArchive),
 *     so no Summarizer AI is invoked;
 *   - planner.verifyAssumptions / _reviewGate / _executeAllMilestones are stubbed.
 * batchResume itself — including the plain `git add -A` spec-boundary commit (queue/ is
 * gitignored, so a plain add already excludes it; an explicit ":(exclude)queue" pathspec
 * would instead fail with exit-1) — runs unmodified.
 *
 * This suite is NOT a re-entrant cc-orch invocation — every fixture root is an
 * isolated fs.mkdtemp() directory. But when this file is launched from inside
 * a live cc-orch run, CC_ORCH_ACTIVE_RUN is inherited from the parent process
 * environment and would trip assertNoReentrantLiveRun's guard (and skew
 * activeHarnessDir resolution) on the freshly-bootstrapped active roots these
 * fixtures construct — a false positive on the sanctioned mkdtemp pattern
 * (see reentrancy-guard.js). Clear the marker unconditionally here, mirroring
 * scripts/run-tests.js and test/test-bootstrap-run-scoped.js, so this file is
 * re-entrancy-neutral regardless of launch context.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import {
  writeQueueEntry,
  readQueueEntry,
  listQueue,
} from '../src/orchestrator/core/state.js';
import { InfrastructureError } from '../src/orchestrator/infra/session-manager.js';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';
import { TestGateError } from '../src/cli/commands/archive.js';
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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Create a temporary git repo with a baseline commit and a .gitignore that:
 *   - Ignores .harness/ (transient harness state, not source)
 *   - Ignores queue/  (queue entries are gitignored so `git status --porcelain`
 *                     shows a clean working tree, satisfying batchResume's dirty-tree guard)
 *   - Does NOT ignore archives/ (forensic archives must be committable with `git add archives/`)
 *   - Includes the cc-orch stanza marker so bootstrap() does not modify .gitignore
 */
function makeTmpGitRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-batch-revert-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  // .gitignore: ignore .harness/ and queue/ only.
  // archives/ is intentionally NOT ignored — `git add archives/` must work for
  // the forensic-archive commit.  The cc-orch marker prevents bootstrap() from
  // appending its own stanza.
  fs.writeFileSync(
    path.join(dir, '.gitignore'),
    '.harness/\nqueue/\n# cc-orch ephemeral inputs\nspec-*.md\n*.spec.md\n',
  );
  fs.writeFileSync(path.join(dir, 'README.md'), '# baseline\n');
  execSync('git add .gitignore README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "baseline"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Seed three queue entries (spec-1, spec-2, spec-3) with status:'pending'
 * and a minimal plan.
 *
 * queue/ is gitignored in our test repos, so no git commit is needed — the queue
 * directory does not appear in `git status --porcelain`.
 */
function seedThreeSpecQueue(root) {
  for (const slug of ['spec-1', 'spec-2', 'spec-3']) {
    writeQueueEntry(root, slug, {
      spec: `# Spec for ${slug}\n\nMinimal spec content for testing.\n`,
      plan: { milestones: [], assumptions: [] },
      validatedAt: new Date().toISOString(),
      status: 'pending',
    });
  }
}

/**
 * Lightweight archive stub injected via the Pipeline `archive` seam, so the
 * REAL Pipeline.batchResume runs end-to-end without invoking the Summarizer.
 * Creates archives/{seq}-{slug}/ (or failed-{seq}-{slug}/ when include-failed)
 * + manifest.json, and returns the dir (a truthy archiveDir, which batchResume
 * requires on the success path).
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
 * Build a Pipeline with planner/execution stubs for execution-failure testing.
 *
 * @param {string} root - temp project root (a real git repo)
 * @param {object} opts
 *   opts.failOn         — slug string; _executeAllMilestones throws for this slug
 *   opts.failureError   — Error instance to throw
 *                         (default: new Error('circuit-breaker: too many retries'))
 *
 * Returns { pipeline, logs }.
 *
 * Stubs applied:
 *   - pipeline.planner.verifyAssumptions   → async () => []
 *   - pipeline.planner.closeReusableSession → async () => {}
 *   - pipeline._reviewGate                → async () => {}
 *   - pipeline._skipCoverageGate          → true
 *   - pipeline._executeAllMilestones      → reads prdPath from .harness/state.json to
 *                                           identify the current slug; throws failureError
 *                                           when slug===failOn, otherwise writes a
 *                                           deliverable file for that slug
 *   - opts.archive (constructor seam)     → makeStubArchive(root): creates the archive dir
 *                                           + manifest.json (no Summarizer), returns the dir
 *
 * batchResume itself is NOT overridden — the REAL Pipeline.prototype.batchResume runs, so
 * the spec-boundary commit (plain `git add -A`), forensic archive, git reset --hard, and
 * git clean are exercised end-to-end against the temp git repo (spec criterion #10).
 */
function makeRealBatchPipeline(root, { failOn = null, failureError = null, gateFailOn = null } = {}) {
  const logs = [];
  const defaultError = failureError ?? new Error('circuit-breaker: too many retries');

  // Wrap the stub archive so a specific slug's SUCCESS-path archive throws a
  // TestGateError — simulating the final test gate failing (`npm run test:all`).
  // Forensic (include-failed) re-archives still succeed.
  const baseArchive = makeStubArchive(root);
  const archiveStub = async (projectRoot, slug, opts = {}) => {
    if (gateFailOn !== null && slug === gateFailOn && !opts['include-failed']) {
      throw new TestGateError('Final test gate failed: `npm run test:all` exited 1 (simulated)');
    }
    return baseArchive(projectRoot, slug, opts);
  };

  const pipeline = new Pipeline(root, {
    skipWorktreeCreation: true,
    onLog: (m) => logs.push(m),
    archive: archiveStub,
  });

  // ── Planner / gate stubs ───────────────────────────────────────────────────
  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._reviewGate = async () => {};
  pipeline._skipCoverageGate = true;

  // ── _executeAllMilestones stub ─────────────────────────────────────────────
  // Reads prdPath from .harness/state.json (written by bootstrap() just before
  // this stub is called) to determine the current slug without relying on a
  // fragile counter.
  pipeline._executeAllMilestones = async (_plan) => {
    // Re-keyed via activeHarnessDir(root) (run-context.js) rather than a
    // hardcoded '.harness/state.json' join: it resolves to the validated
    // per-run harness dir when the active-run pointer is claimed and its
    // state.json exists, falling back to the flat '.harness/' root otherwise —
    // mirroring exactly how Pipeline itself resolves this.harnessDir.
    const stateJsonPath = path.join(activeHarnessDir(root), 'state.json');
    let slug = 'unknown-slug';
    try {
      const raw = fs.readFileSync(stateJsonPath, 'utf8');
      const state = JSON.parse(raw);
      const prdPath = state.projectMeta?.prdPath || state.spec || '';
      const match = prdPath.match(/queue\/([^/]+)\/spec\.md$/);
      if (match) slug = match[1];
    } catch { /* ignore read/parse errors */ }

    if (failOn !== null && slug === failOn) {
      throw defaultError;
    }
    // Write a deliverable file for non-failing slugs
    fs.writeFileSync(path.join(root, `file-${slug}.txt`), 'hello');
  };

  // No batchResume override — TC-REVERT-* below drive the REAL
  // Pipeline.prototype.batchResume (archive() comes from the injected stub
  // above; verifyAssumptions/_reviewGate/_executeAllMilestones are stubbed).
  return { pipeline, logs };
}

// ── TC-REVERT-1 ─────────────────────────────────────────────────────────────
// execution throw parks and continues

await test('TC-REVERT-1: execution throw on spec-2 parks it as failed-execution; spec-3 still runs', async () => {
  const root = makeTmpGitRoot();
  const origExit = process.exit;
  try {
    seedThreeSpecQueue(root);

    const { pipeline } = makeRealBatchPipeline(root, {
      failOn: 'spec-2',
      failureError: new Error('circuit-breaker: too many retries'),
    });

    // Install process.exit spy before batchResume; restore in finally.
    let exitCalled = false;
    try {
      process.exit = () => { exitCalled = true; };

      const result = await pipeline.batchResume({ autonomous: true });

      // (a) archived === 2, failed === 1
      assert.strictEqual(result.archived, 2,
        `Expected result.archived === 2, got ${result.archived}`);
      assert.strictEqual(result.failed, 1,
        `Expected result.failed === 1, got ${result.failed}`);

      // (b) spec-1 was archived (removed from queue)
      assert.strictEqual(readQueueEntry(root, 'spec-1'), null,
        'spec-1 should be null (archived/removed from queue)');

      // (c) spec-2 remains with status === 'failed-execution'
      const spec2Entry = readQueueEntry(root, 'spec-2');
      assert.ok(spec2Entry !== null, 'spec-2 should still be in queue');
      assert.strictEqual(spec2Entry.status, 'failed-execution',
        `spec-2 status should be 'failed-execution', got '${spec2Entry?.status}'`);

      // (d) spec-3 was archived (removed from queue)
      assert.strictEqual(readQueueEntry(root, 'spec-3'), null,
        'spec-3 should be null (archived/removed from queue)');

      // (e) process.exit was never invoked during the run
      assert.strictEqual(exitCalled, false,
        'process.exit should NOT have been called during batchResume');
    } finally {
      process.exit = origExit;
    }
  } finally {
    process.exit = origExit;
    cleanup(root);
  }
});

// ── TC-REVERT-2 ─────────────────────────────────────────────────────────────
// failed spec's code edits are reverted, earlier spec's survive

await test('TC-REVERT-2: failed spec edits are reverted; committed work from earlier specs survives', async () => {
  const root = makeTmpGitRoot();
  try {
    seedThreeSpecQueue(root);

    const { pipeline } = makeRealBatchPipeline(root, {
      failOn: 'spec-2',
      failureError: new Error('circuit-breaker: too many retries'),
    });

    await pipeline.batchResume({ autonomous: true });

    // (a) file-spec-1.txt exists: spec-1 succeeded and its deliverable was committed
    assert.ok(
      fs.existsSync(path.join(root, 'file-spec-1.txt')),
      'file-spec-1.txt should exist (spec-1 committed before spec-2 failed)',
    );

    // (b) file-spec-2.txt does NOT exist: spec-2 failed before writing its file;
    //     the revert (git reset --hard + git clean) ensures no partial work survives
    assert.strictEqual(
      fs.existsSync(path.join(root, 'file-spec-2.txt')),
      false,
      'file-spec-2.txt should NOT exist (spec-2 failure was reverted)',
    );

    // (c) file-spec-3.txt exists: spec-3 ran after spec-2 failure and succeeded
    assert.ok(
      fs.existsSync(path.join(root, 'file-spec-3.txt')),
      'file-spec-3.txt should exist (spec-3 ran and committed after spec-2 failure)',
    );
  } finally {
    cleanup(root);
  }
});

// ── TC-REVERT-3 ─────────────────────────────────────────────────────────────
// forensic archive survives the clean

await test('TC-REVERT-3: forensic archive for failed spec-2 lands in git with correct commit message', async () => {
  const root = makeTmpGitRoot();
  try {
    seedThreeSpecQueue(root);

    const { pipeline } = makeRealBatchPipeline(root, {
      failOn: 'spec-2',
      failureError: new Error('circuit-breaker: too many retries'),
    });

    await pipeline.batchResume({ autonomous: true });

    // (a) archives/ contains at least one entry matching /^failed-\d+-spec-2/
    const archivesDir = path.join(root, 'archives');
    const archiveEntries = fs.readdirSync(archivesDir);
    const failedSpec2Entries = archiveEntries.filter(e => /^failed-\d+-spec-2/.test(e));
    assert.ok(
      failedSpec2Entries.length > 0,
      `Expected at least one entry matching /^failed-\\d+-spec-2/ in archives/, got: [${archiveEntries.join(', ')}]`,
    );

    // (b) git log --oneline contains the forensic commit message
    const gitLog = execSync('git log --oneline', { cwd: root, encoding: 'utf8' });
    assert.ok(
      gitLog.includes('Park failed spec spec-2 (execution failure)'),
      `git log should contain 'Park failed spec spec-2 (execution failure)'. Got:\n${gitLog}`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC-REVERT-4 ─────────────────────────────────────────────────────────────
// dirty working tree refuses with guard message and no specs run

await test('TC-REVERT-4: dirty working tree refuses with guard message and no specs run', async () => {
  const root = makeTmpGitRoot();
  try {
    seedThreeSpecQueue(root);

    const { pipeline, logs } = makeRealBatchPipeline(root, {});

    // Install a counter on _executeAllMilestones so any invocation increments it
    let executeCount = 0;
    const originalExecute = pipeline._executeAllMilestones.bind(pipeline);
    pipeline._executeAllMilestones = async (...args) => {
      executeCount++;
      return originalExecute(...args);
    };

    // Write an untracked file dirty.txt to root so git status --porcelain returns non-empty
    fs.writeFileSync(path.join(root, 'dirty.txt'), 'dirty\n');

    // Call batchResume
    const result = await pipeline.batchResume({ autonomous: true });

    // (a) returned { archived: 0, failed: 0 }
    assert.strictEqual(result.archived, 0,
      `Expected result.archived === 0, got ${result.archived}`);
    assert.strictEqual(result.failed, 0,
      `Expected result.failed === 0, got ${result.failed}`);

    // (b) captured logs array contains a line matching /working tree is not clean/
    const hasGuardMessage = logs.some((line) => /working tree is not clean/.test(line));
    assert.ok(
      hasGuardMessage,
      `Expected logs to contain a line matching /working tree is not clean/. Got:\n${logs.join('\n')}`,
    );

    // (c) execute counter === 0
    assert.strictEqual(
      executeCount,
      0,
      `Expected _executeAllMilestones to be called 0 times, got ${executeCount}`,
    );

    // (d) spec-1, spec-2, spec-3 all still have status === 'pending' (no specs ran)
    for (const slug of ['spec-1', 'spec-2', 'spec-3']) {
      const entry = readQueueEntry(root, slug);
      assert.ok(entry !== null, `${slug} queue entry should still exist`);
      assert.strictEqual(
        entry.status,
        'pending',
        `${slug} status should be 'pending', got '${entry?.status}'`,
      );
    }
  } finally {
    cleanup(root);
  }
});

// ── TC-REVERT-5 ─────────────────────────────────────────────────────────────
// InfrastructureError from spec #2 propagates — batch stops

await test('TC-REVERT-5: InfrastructureError from spec #2 propagates — batch stops', async () => {
  const root = makeTmpGitRoot();
  try {
    seedThreeSpecQueue(root);

    const { pipeline } = makeRealBatchPipeline(root, {
      failOn: 'spec-2',
      failureError: new InfrastructureError('rate limited', {
        category: 'rate_limit',
        retryable: true,
        statusCode: 429,
        cause: new Error('upstream 429'),
      }),
    });

    // batchResume must reject with InfrastructureError with category === 'rate_limit'
    await assert.rejects(
      () => pipeline.batchResume({ autonomous: true }),
      (err) => err instanceof InfrastructureError && err.category === 'rate_limit',
    );

    // (a) spec-2 status remains 'pending' (NOT 'failed-execution')
    const spec2Entry = readQueueEntry(root, 'spec-2');
    assert.ok(spec2Entry !== null, 'spec-2 queue entry should still exist');
    assert.strictEqual(
      spec2Entry.status,
      'pending',
      `spec-2 status should be 'pending', got '${spec2Entry?.status}'`,
    );

    // (b) spec-3 status remains 'pending' (batch stopped before processing spec-3)
    const spec3Entry = readQueueEntry(root, 'spec-3');
    assert.ok(spec3Entry !== null, 'spec-3 queue entry should still exist');
    assert.strictEqual(
      spec3Entry.status,
      'pending',
      `spec-3 status should be 'pending', got '${spec3Entry?.status}'`,
    );

    // (c) no archives/failed-*spec-2* directory was created
    const archivesDir = path.join(root, 'archives');
    if (fs.existsSync(archivesDir)) {
      const archiveEntries = fs.readdirSync(archivesDir);
      const failedSpec2Entries = archiveEntries.filter((e) => /failed.*spec-2/.test(e));
      assert.strictEqual(
        failedSpec2Entries.length,
        0,
        `Expected no archives/failed-*spec-2* directory, found: [${failedSpec2Entries.join(', ')}]`,
      );
    }

    // (d) no git log entry contains 'Park failed spec spec-2'
    const gitLog = execSync('git log --oneline', { cwd: root, encoding: 'utf8' });
    assert.ok(
      !gitLog.includes('Park failed spec spec-2'),
      `git log should NOT contain 'Park failed spec spec-2'. Got:\n${gitLog}`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC-REVERT-6 ─────────────────────────────────────────────────────────────
// archive final-test-gate throw: revert + failed-test-gate, no forensic, continue
await test('TC-REVERT-6: archive final-gate throw reverts spec, re-queues failed-test-gate, no forensic, batch continues', async () => {
  const root = makeTmpGitRoot();
  const origExit = process.exit;
  try {
    seedThreeSpecQueue(root);
    const { pipeline } = makeRealBatchPipeline(root, { gateFailOn: 'spec-2' });
    let exitCalled = false;
    try {
      process.exit = () => { exitCalled = true; };
      await pipeline.batchResume({ autonomous: true });

      // spec-2 re-queued as failed-test-gate (NOT failed-execution)
      const spec2 = readQueueEntry(root, 'spec-2');
      assert.ok(spec2 !== null, 'spec-2 should still be in queue');
      assert.strictEqual(spec2.status, 'failed-test-gate',
        `spec-2 status should be 'failed-test-gate', got '${spec2 && spec2.status}'`);

      // spec-2's deliverable was reverted by git reset --hard
      assert.ok(!fs.existsSync(path.join(root, 'file-spec-2.txt')),
        'spec-2 deliverable should have been reverted');

      // NO forensic archive for a test-gate failure (a red suite, not a halt)
      const archivesDir = path.join(root, 'archives');
      const archives = fs.existsSync(archivesDir) ? fs.readdirSync(archivesDir) : [];
      assert.ok(!archives.some((d) => /^failed-.*spec-2/.test(d)),
        `a test-gate failure must not write a forensic archive, got: [${archives.join(', ')}]`);

      // spec-1 and spec-3 archived (removed from queue) — batch continued
      assert.strictEqual(readQueueEntry(root, 'spec-1'), null, 'spec-1 should be archived/removed');
      assert.strictEqual(readQueueEntry(root, 'spec-3'), null, 'spec-3 should be archived/removed');
      assert.strictEqual(exitCalled, false, 'process.exit must not be called');
    } finally {
      process.exit = origExit;
    }
  } finally {
    process.exit = origExit;
    cleanup(root);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
