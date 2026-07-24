#!/usr/bin/env node
/**
 * test-batch-test-gate-park-snapshot.js — Integration tests for the
 * refs/test-gate/<slug> park-snapshot preservation on the TestGateError
 * failure path of Pipeline.batchResume.
 *
 * Test cases:
 *   TC1 — dirty tree + TestGateError: createParkSnapshot(entry.slug,
 *         projectRoot, 'refs/test-gate/') succeeds and pins a
 *         refs/test-gate/<slug> ref; the ref's name is logged via onLog.
 *   TC2 — park snapshot throws: the error is caught and logged
 *         ("ERROR: failed to snapshot work for '<slug>' ..."), the entry is
 *         still marked 'failed-test-gate', and the batch continues to the
 *         next entry.
 *   TC3 — queue/<slug>/test-gate-failures.txt is written containing the
 *         extracted [FAIL] marker lines + the summary Total line from the
 *         TestGateError message tail; the same [FAIL] lines are emitted via
 *         onLog.
 *   TC4 — the pre-existing behavior (revert of the entry's deliverable,
 *         'failed-test-gate' status, clean tree, batch continuing to
 *         archive the surrounding entries) is unchanged.
 *
 * Run: node test/test-batch-test-gate-park-snapshot.js
 *
 * Architecture note
 * ─────────────────
 * These tests drive the REAL Pipeline.prototype.batchResume against a temp
 * git repo (mirroring test/test-batch-revert-and-continue.js and
 * test/test-batch-failure-crash-safety.js), so the production TestGateError
 * catch branch — including the createParkSnapshot(..., 'refs/test-gate/')
 * call, the FAIL/Total extraction into queue/<slug>/test-gate-failures.txt,
 * the git reset --hard + git clean revert, and the failed-test-gate status
 * write — runs unmodified. Only the leaf collaborators are stubbed:
 *   - archive() is injected via the Pipeline `archive` constructor seam,
 *     wrapped so a targeted slug's success-path call throws TestGateError
 *     (the forensic include-failed re-archive is never reached on this path);
 *   - planner.verifyAssumptions / _reviewGate / _executeAllMilestones are
 *     stubbed — the milestone stub writes a deliverable file for every slug,
 *     which is what naturally dirties the tree before archive() runs in
 *     production.
 *
 * TC2's "park snapshot throws" is produced WITHOUT touching any production
 * source: a plain file is pre-created at .git/refs/test-gate, so
 * createParkSnapshot's internal `git update-ref refs/test-gate/<slug> <sha>`
 * genuinely fails ("non-directory in the way") after the preceding
 * `git stash push -u` has already reset the tree to clean — matching real
 * git failure semantics end-to-end, not a mocked throw.
 *
 * This suite is NOT a re-entrant cc-orch invocation — every fixture root is
 * an isolated fs.mkdtemp() directory. But when this file is launched from
 * inside a live cc-orch run, CC_ORCH_ACTIVE_RUN is inherited from the parent
 * process environment and would trip assertNoReentrantLiveRun's guard (and
 * skew activeHarnessDir resolution) on the freshly-bootstrapped active roots
 * these fixtures construct — a false positive on the sanctioned mkdtemp
 * pattern (see reentrancy-guard.js). Clear the marker unconditionally here,
 * mirroring scripts/run-tests.js and test/test-bootstrap-run-scoped.js, so
 * this file is re-entrancy-neutral regardless of launch context.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeQueueEntry, readQueueEntry } from '../src/orchestrator/core/state.js';
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
 * Create a temporary git repo with a baseline commit and a .gitignore that
 * ignores .harness/ and queue/ (so `git status --porcelain` is clean at
 * batch start) while leaving archives/ trackable.
 */
function makeTmpGitRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-batch-tg-park-'));
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

function cleanup(root) {
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
 * Pre-create a plain FILE at .git/refs/test-gate. This is not a mock: it
 * genuinely breaks git's ability to create the refs/test-gate/<slug>
 * directory-and-file loose ref later — `git update-ref` fails with "unable
 * to create lock file ...; non-directory in the way" — so createParkSnapshot
 * throws for a real git reason, without any source changes.
 */
function blockTestGateRefsDir(root) {
  const refsDir = path.join(root, '.git', 'refs');
  fs.mkdirSync(refsDir, { recursive: true });
  fs.writeFileSync(path.join(refsDir, 'test-gate'), '');
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
 * Pipeline.prototype.batchResume against `root`.
 *
 * opts.gateFailOn  — slug string; the SUCCESS-path archive() call for this
 *                     slug throws TestGateError(opts.gateMessage) instead of
 *                     archiving (the forensic include-failed re-archive is
 *                     never invoked on the TestGateError branch).
 * opts.gateMessage — TestGateError message (default: a minimal simulated
 *                     final-test-gate failure message).
 *
 * The _executeAllMilestones stub writes a deliverable file
 * (file-<slug>.txt) for EVERY slug it runs for — matching production, where
 * the milestones complete (dirtying the tree) before archive() is called
 * and can still throw TestGateError.
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
    // Re-keyed via activeHarnessDir(root) (run-context.js) rather than a
    // flat path.join(root, '.harness', 'state.json'): batchResume claims a
    // fresh per-run active-run pointer for each queue entry before
    // _executeAllMilestones runs, so the entry's state.json lives under the
    // resolved per-run harness dir, not the flat .harness root.
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

// ── TC1 ──────────────────────────────────────────────────────────────────────
// dirty tree + TestGateError → refs/test-gate/<slug> ref exists, its name is logged

await test('TC1: dirty tree + TestGateError creates refs/test-gate/<slug> and logs the ref name', async () => {
  const root = makeTmpGitRoot();
  const origExit = process.exit;
  try {
    seedQueue(root, ['tc1-a', 'tc1-b']);
    const { pipeline, logs } = makeBatchPipeline(root, { gateFailOn: 'tc1-a' });

    let exitCalled = false;
    try {
      process.exit = () => { exitCalled = true; };
      await pipeline.batchResume({ autonomous: true });
    } finally {
      process.exit = origExit;
    }

    // The refs/test-gate/tc1-a ref must exist and resolve.
    let refSha = null;
    assert.doesNotThrow(() => {
      refSha = execSync('git rev-parse --verify refs/test-gate/tc1-a', { cwd: root, encoding: 'utf8' }).trim();
    }, 'refs/test-gate/tc1-a must exist and be resolvable after the TestGateError revert');
    assert.ok(refSha && refSha.length > 0, 'refs/test-gate/tc1-a must resolve to a non-empty sha');

    // The ref's name is logged.
    const loggedRef = logs.some((l) => l.includes("Preserved pre-revert work for 'tc1-a' as refs/test-gate/tc1-a"));
    assert.ok(loggedRef, `Expected a log line naming refs/test-gate/tc1-a. Got:\n${logs.join('\n')}`);

    assert.strictEqual(exitCalled, false, 'process.exit must not be called');
  } finally {
    process.exit = origExit;
    cleanup(root);
  }
});

// ── TC2 ──────────────────────────────────────────────────────────────────────
// park snapshot throws → error logged, entry status 'failed-test-gate', batch continues

await test('TC2: park snapshot throw is logged; entry still marked failed-test-gate; batch continues', async () => {
  const root = makeTmpGitRoot();
  try {
    blockTestGateRefsDir(root);
    seedQueue(root, ['tc2-a', 'tc2-b']);
    const { pipeline, logs } = makeBatchPipeline(root, { gateFailOn: 'tc2-a' });

    const result = await pipeline.batchResume({ autonomous: true });

    // The park-snapshot failure was caught and logged.
    const loggedError = logs.some((l) =>
      l.includes("ERROR: failed to snapshot work for 'tc2-a' before test-gate revert"));
    assert.ok(loggedError, `Expected a log line reporting the park-snapshot failure for 'tc2-a'. Got:\n${logs.join('\n')}`);

    // Entry is still marked failed-test-gate despite the park-snapshot throw.
    const entry = readQueueEntry(root, 'tc2-a');
    assert.ok(entry !== null, "entry 'tc2-a' should still be in queue");
    assert.strictEqual(entry.status, 'failed-test-gate',
      `entry 'tc2-a' expected status 'failed-test-gate', got '${entry?.status}'`);

    // Batch continued to the second entry (archived/removed from queue).
    assert.strictEqual(readQueueEntry(root, 'tc2-b'), null,
      "entry 'tc2-b' should be archived/removed — the batch must continue past the park-snapshot throw");
    assert.strictEqual(result.failed, 1, `expected failed:1, got ${result.failed}`);
    assert.strictEqual(result.archived, 1, `expected archived:1, got ${result.archived}`);
  } finally {
    cleanup(root);
  }
});

// ── TC3 ──────────────────────────────────────────────────────────────────────
// test-gate-failures.txt contains the FAIL + Total lines; FAIL lines are logged

await test('TC3: queue/<slug>/test-gate-failures.txt has FAIL+Total lines; FAIL lines are emitted via onLog', async () => {
  const root = makeTmpGitRoot();
  try {
    seedQueue(root, ['tc3-a']);
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

    const { pipeline, logs } = makeBatchPipeline(root, { gateFailOn: 'tc3-a', gateMessage });

    await pipeline.batchResume({ autonomous: true });

    const failuresPath = path.join(root, 'queue', 'tc3-a', 'test-gate-failures.txt');
    assert.ok(fs.existsSync(failuresPath), 'queue/tc3-a/test-gate-failures.txt must be written');
    const content = fs.readFileSync(failuresPath, 'utf8');
    assert.ok(content.includes(failLine1), `test-gate-failures.txt must contain "${failLine1}". Got:\n${content}`);
    assert.ok(content.includes(failLine2), `test-gate-failures.txt must contain "${failLine2}". Got:\n${content}`);
    assert.ok(content.includes(totalLine), `test-gate-failures.txt must contain "${totalLine}". Got:\n${content}`);

    assert.ok(logs.some((l) => l.includes(failLine1)), `Expected onLog to include "${failLine1}". Got:\n${logs.join('\n')}`);
    assert.ok(logs.some((l) => l.includes(failLine2)), `Expected onLog to include "${failLine2}". Got:\n${logs.join('\n')}`);

    const entry = readQueueEntry(root, 'tc3-a');
    assert.strictEqual(entry.status, 'failed-test-gate',
      `entry 'tc3-a' expected status 'failed-test-gate', got '${entry?.status}'`);
  } finally {
    cleanup(root);
  }
});

// ── TC4 ──────────────────────────────────────────────────────────────────────
// existing revert + 'failed-test-gate' status + tree-clean + continue disposition unchanged

await test('TC4: revert + failed-test-gate status + clean tree + batch continues (unchanged)', async () => {
  const root = makeTmpGitRoot();
  const origExit = process.exit;
  try {
    seedQueue(root, ['tc4-a', 'tc4-b', 'tc4-c']);
    const { pipeline } = makeBatchPipeline(root, { gateFailOn: 'tc4-b' });

    let exitCalled = false;
    try {
      process.exit = () => { exitCalled = true; };
      await pipeline.batchResume({ autonomous: true });
    } finally {
      process.exit = origExit;
    }

    // tc4-b re-queued as failed-test-gate (not removed, not failed-execution).
    const tc4b = readQueueEntry(root, 'tc4-b');
    assert.ok(tc4b !== null, "entry 'tc4-b' should still be in queue");
    assert.strictEqual(tc4b.status, 'failed-test-gate',
      `entry 'tc4-b' expected status 'failed-test-gate', got '${tc4b?.status}'`);

    // tc4-b's deliverable was reverted by git reset --hard + git clean.
    assert.ok(!fs.existsSync(path.join(root, 'file-tc4-b.txt')),
      "entry 'tc4-b' deliverable should have been reverted");

    // No forensic archive for a test-gate failure.
    const archivesDir = path.join(root, 'archives');
    const archives = fs.existsSync(archivesDir) ? fs.readdirSync(archivesDir) : [];
    assert.ok(!archives.some((d) => /^failed-.*tc4-b/.test(d)),
      `a test-gate failure must not write a forensic archive, got: [${archives.join(', ')}]`);

    // tc4-a and tc4-c archived (removed) — batch continued around the failure.
    assert.strictEqual(readQueueEntry(root, 'tc4-a'), null, "entry 'tc4-a' should be archived/removed");
    assert.strictEqual(readQueueEntry(root, 'tc4-c'), null, "entry 'tc4-c' should be archived/removed");

    // Working tree is clean after the run (the failure-path revert leaves no
    // residue outside the gitignored queue/ dir).
    const porcelain = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).trim();
    assert.strictEqual(porcelain, '', `working tree should be clean after the batch. Got:\n${porcelain}`);

    assert.strictEqual(exitCalled, false, 'process.exit must not be called');
  } finally {
    process.exit = origExit;
    cleanup(root);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
