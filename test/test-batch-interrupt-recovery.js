#!/usr/bin/env node
/**
 * test-batch-interrupt-recovery.js — interrupted-batch recovery (route B).
 *
 * Locks the snapshot-clean + rerun-from-scratch contract for a `resume --batch`
 * entry that is interrupted mid-execution:
 *
 *   - At interrupt, _snapshotInterruptedEntry fires at EVERY abort exit:
 *       IR1  post-execute cooperative abort (pipeline.js ~1261) — DIRTY tree
 *       IR2  UserInterruptError catch (~1320) — interactive Ctrl-C, DIRTY tree
 *       IR3  pre-execute cooperative abort (~1254) — the tree is CLEAN, since
 *            bootstrap only ensures its artifacts via the untracked
 *            .git/info/exclude (never touching the tracked tree)
 *     IR1/IR2 leave the tree CLEAN, the entry still `pending`,
 *     refs/interrupt/<slug> present, and a cancel message that names the ref.
 *     IR3's null-guarded snapshot on the already-clean tree creates NO ref.
 *   - IR4  snapshot-null: a clean tree at interrupt → no ref, entry reruns.
 *   - IR5  next `resume --batch` on the clean tree: the clean-tree guard PASSES
 *          (not refused), the pending entry reruns from scratch, archives,
 *          dequeues, and the snapshot ref is KEPT after the rerun.
 *   - IR6  snapshot throws with the tree still dirty (unmerged paths) → honest
 *          "STILL DIRTY / manual" message, no ref.
 *   - IR7  `cc-orch clean` reaps ONLY queue-absent refs/interrupt/*: an orphan
 *          interrupt ref IS reaped, a queue-present interrupt ref is preserved,
 *          and a gate-halt refs/park/* ref is PRESERVED even when queue-absent
 *          (the #5 cross-worktree data-loss regression guard — the reaper never
 *          enumerates the park namespace).
 *
 * The tests drive the REAL Pipeline.batchResume against live git repos and
 * observe real behavior (ref existence, tree cleanliness, guard pass/refuse,
 * rerun-from-scratch, ref-kept, parked-ref-preserved) — no hand-copies.
 *
 * Run: node test/test-batch-interrupt-recovery.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { readQueueEntry } from '../src/orchestrator/core/state.js';
import { clean } from '../src/cli/commands/clean.js';
import { UserInterruptError } from '../src/orchestrator/core/halt-error.js';
import {
  git,
  makeTmpRoot,
  makeGitRoot,
  cleanup,
  porcelain,
  refExists,
  makeFakeArchive,
  makePlan,
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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// Local fixtures (git + queue + real-batch pipeline) now live in
// ./helpers/batch-fixtures.js. The default makeGitRoot gitignore carries the
// bootstrap marker; IR3 passes a marker-less gitignore too, but this no longer
// dirties the tracked tree — bootstrap's artifacts are excluded via the
// untracked .git/info/exclude, so the tree stays clean either way.

// ── IR1 ───────────────────────────────────────────────────────────────────────
// Post-execute cooperative abort (pipeline.js ~1261): the entry's deliverables
// are written, so the tree is DIRTY → snapshot fires.

await test('IR1 — post-execute interrupt snapshots WIP, leaves tree CLEAN, entry stays pending', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'spec-a', { plan: makePlan() });

    const { pipeline, logs } = makeRealBatchPipeline(root, {});
    let executed = false;
    pipeline._executeAllMilestones = async () => {
      executed = true;
      // Mid-task deliverable on the tree.
      fs.writeFileSync(path.join(root, 'wip.txt'), 'half done\n');
      // Cooperative abort: signal aborted AFTER execute returns (the ~1271 check
      // routes to the ~1261 snapshot exit).
      pipeline._cancelController.abort();
    };

    const result = await pipeline.batchResume({});

    assert.ok(executed, 'IR1: execution ran');
    assert.strictEqual(result.archived, 0, `IR1: nothing archived (interrupted), got ${result.archived}`);
    // Tree CLEAN — the snapshot reset it.
    assert.strictEqual(porcelain(root), '', `IR1: tree must be left clean. Got:\n${porcelain(root)}`);
    // WIP preserved in the ref (not destroyed).
    assert.ok(refExists(root, 'refs/interrupt/spec-a'), 'IR1: refs/interrupt/spec-a must exist');
    // Entry still pending (not dequeued, not archived).
    const entry = readQueueEntry(root, 'spec-a');
    assert.ok(entry !== null && entry.status === 'pending',
      `IR1: entry must remain pending. Got: ${JSON.stringify(entry && entry.status)}`);
    // Cancel message names the ref.
    assert.ok(logs.some((l) => l.includes('refs/interrupt/spec-a')),
      `IR1: a message must name refs/interrupt/spec-a. Logs:\n${logs.join('\n')}`);
  } finally {
    cleanup(root);
  }
});

// ── IR2 ───────────────────────────────────────────────────────────────────────
// UserInterruptError catch (~1320): an interactive Ctrl-C surfaces as a throw;
// the tree holds mid-task WIP → snapshot before rethrow. (Route 2 missed this.)

await test('IR2 — UserInterruptError interrupt snapshots WIP and rethrows, tree CLEAN, entry pending', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'spec-a', { plan: makePlan() });

    const { pipeline, logs } = makeRealBatchPipeline(root, {});
    pipeline._executeAllMilestones = async () => {
      fs.writeFileSync(path.join(root, 'wip.txt'), 'half done\n');
      throw new UserInterruptError();
    };

    // The interrupt rethrows out of batchResume (the user asked out of the batch).
    await assert.rejects(
      () => pipeline.batchResume({}),
      UserInterruptError,
      'IR2: batchResume must rethrow UserInterruptError',
    );

    assert.strictEqual(porcelain(root), '', `IR2: tree must be left clean. Got:\n${porcelain(root)}`);
    assert.ok(refExists(root, 'refs/interrupt/spec-a'), 'IR2: refs/interrupt/spec-a must exist');
    const entry = readQueueEntry(root, 'spec-a');
    assert.ok(entry !== null && entry.status === 'pending',
      `IR2: entry must remain pending. Got: ${JSON.stringify(entry && entry.status)}`);
    assert.ok(logs.some((l) => l.includes('refs/interrupt/spec-a')),
      `IR2: a message must name refs/interrupt/spec-a. Logs:\n${logs.join('\n')}`);
  } finally {
    cleanup(root);
  }
});

// ── IR3 ───────────────────────────────────────────────────────────────────────
// Pre-execute cooperative abort (~1254): the tree is CLEAN here — bootstrap
// only ensures its artifacts via the untracked .git/info/exclude, never
// touching the tracked tree — so the null-guarded snapshot creates NO ref.

await test('IR3 — pre-execute interrupt on the clean bootstrap tree creates NO ref, entry stays pending', async () => {
  // Marker-less .gitignore: bootstrap no longer appends any stanza to the
  // tracked .gitignore (artifacts are excluded via .git/info/exclude instead),
  // so this stays as clean as the default gitignore.
  const root = makeGitRoot({ gitignore: '.harness/\nqueue/\n' });
  try {
    createQueueEntry(root, 'spec-a', { plan: makePlan() });

    const { pipeline } = makeRealBatchPipeline(root, {});
    let executed = false;
    pipeline._executeAllMilestones = async () => { executed = true; };
    // Abort INSIDE the loop, right after the top-of-loop abort check has
    // already passed (the "Processing queue entry" log fires between that
    // check and bootstrap). The per-entry bootstrap then runs (tree stays
    // clean), and the pre-execute abort check fires and calls the
    // null-guarded snapshot — execution never starts. (A pre-loop abort() no
    // longer reaches this window: the top-of-loop check exits before
    // bootstrap.)
    const origOnLog = pipeline.onLog;
    pipeline.onLog = (msg) => {
      if (typeof msg === 'string' && msg.includes('Processing queue entry')) {
        pipeline._cancelController.abort();
      }
      origOnLog(msg);
    };

    const result = await pipeline.batchResume({});

    assert.ok(!executed, 'IR3: execution must NOT start on a pre-execute abort');
    assert.strictEqual(result.archived, 0, `IR3: nothing archived, got ${result.archived}`);
    // The tree was already clean at this abort exit → the snapshot is a
    // null-guarded no-op (no stash, no ref).
    assert.strictEqual(porcelain(root), '', `IR3: tree must be left clean. Got:\n${porcelain(root)}`);
    assert.ok(!refExists(root, 'refs/interrupt/spec-a'),
      'IR3: a clean pre-execute abort must NOT create refs/interrupt/spec-a');
    const entry = readQueueEntry(root, 'spec-a');
    assert.ok(entry !== null && entry.status === 'pending',
      `IR3: entry must remain pending. Got: ${JSON.stringify(entry && entry.status)}`);
  } finally {
    cleanup(root);
  }
});

// ── IR4 ───────────────────────────────────────────────────────────────────────
// snapshot-null: the tree is already clean at interrupt → no ref created; the
// entry still reruns from scratch.

await test('IR4 — clean tree at interrupt creates NO ref (null snapshot), entry still pending', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'spec-a', { plan: makePlan() });

    const { pipeline } = makeRealBatchPipeline(root, {});
    pipeline._executeAllMilestones = async () => {
      // Write NOTHING — the tree stays clean — then abort post-execute.
      pipeline._cancelController.abort();
    };

    const result = await pipeline.batchResume({});

    assert.strictEqual(result.archived, 0, `IR4: nothing archived, got ${result.archived}`);
    assert.strictEqual(porcelain(root), '', `IR4: tree clean. Got:\n${porcelain(root)}`);
    assert.ok(!refExists(root, 'refs/interrupt/spec-a'),
      'IR4: a clean tree at interrupt must NOT create a snapshot ref');
    const entry = readQueueEntry(root, 'spec-a');
    assert.ok(entry !== null && entry.status === 'pending',
      `IR4: entry must remain pending. Got: ${JSON.stringify(entry && entry.status)}`);
  } finally {
    cleanup(root);
  }
});

// ── IR5 ───────────────────────────────────────────────────────────────────────
// The next `resume --batch` on the clean tree: the clean-tree guard PASSES (not
// refused), the pending entry reruns from scratch, archives, dequeues, and the
// snapshot ref is KEPT after the rerun (keep-ref; reaped only by `cc-orch clean`).

await test('IR5 — next batch on the clean tree reruns from scratch, archives, dequeues, KEEPS the ref', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'spec-a', { plan: makePlan() });

    // ── Phase 1: interrupt mid-execution (post-execute abort). ──
    const p1 = makeRealBatchPipeline(root, {});
    p1.pipeline._executeAllMilestones = async () => {
      fs.writeFileSync(path.join(root, 'wip.txt'), 'half done\n');
      p1.pipeline._cancelController.abort();
    };
    await p1.pipeline.batchResume({});
    assert.strictEqual(porcelain(root), '', 'IR5: interrupt must leave a clean tree');
    assert.ok(refExists(root, 'refs/interrupt/spec-a'), 'IR5: interrupt must create the ref');
    assert.ok(readQueueEntry(root, 'spec-a').status === 'pending', 'IR5: entry still pending after interrupt');

    // ── Phase 2: rerun on the clean tree — fresh pipeline + fresh controller. ──
    const p2 = makeRealBatchPipeline(root, { archive: makeFakeArchive() });
    let reran = false;
    p2.pipeline._executeAllMilestones = async () => {
      reran = true;
      fs.writeFileSync(path.join(root, 'final.txt'), 'done\n');
    };
    const r2 = await p2.pipeline.batchResume({});

    // The clean-tree guard PASSED (not refused) and the entry reran from scratch.
    assert.ok(reran, 'IR5: the pending entry must rerun from scratch');
    assert.strictEqual(r2.archived, 1,
      `IR5: rerun must archive the entry (proves the guard passed, not refused). Got archived:${r2.archived}`);
    assert.ok(!p2.logs.some((l) => l.includes('working tree is not clean')),
      `IR5: the second batch must NOT be refused by the clean-tree guard. Logs:\n${p2.logs.join('\n')}`);
    // Dequeued after archive.
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'spec-a')), 'IR5: entry must be dequeued after rerun');
    // Ref KEPT after the rerun (preserves any user hand-edits in the stash).
    assert.ok(refExists(root, 'refs/interrupt/spec-a'),
      'IR5: the snapshot ref must be KEPT after the rerun (reaped only by cc-orch clean)');
  } finally {
    cleanup(root);
  }
});

// ── IR6 ───────────────────────────────────────────────────────────────────────
// snapshot throws with the tree still dirty (unmerged paths / merge in
// progress): _snapshotInterruptedEntry re-probes the ACTUAL tree state and is
// HONEST — "STILL DIRTY", needs a manual git stash — rather than overselling a
// graceful recovery. No ref is created.

await test('IR6 — snapshot throw with the tree still dirty emits an honest manual-residual message, no ref', async () => {
  const root = makeGitRoot();
  try {
    // Build an unmerged-paths state so `git stash push -u` fails while the tree
    // stays dirty.
    fs.writeFileSync(path.join(root, 'conflict.txt'), 'base\n');
    git(['add', 'conflict.txt'], root);
    git(['commit', '-q', '-m', 'base'], root);
    const baseBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim();
    git(['checkout', '-q', '-b', 'feature'], root);
    fs.writeFileSync(path.join(root, 'conflict.txt'), 'feature side\n');
    git(['add', 'conflict.txt'], root);
    git(['commit', '-q', '-m', 'feature'], root);
    git(['checkout', '-q', baseBranch], root);
    fs.writeFileSync(path.join(root, 'conflict.txt'), 'mainline side\n');
    git(['add', 'conflict.txt'], root);
    git(['commit', '-q', '-m', 'mainline'], root);
    try { git(['merge', 'feature'], root); } catch { /* expected: conflict, unmerged paths */ }
    assert.ok(porcelain(root) !== '', 'IR6 fixture: the tree must be dirty (unmerged paths) before the snapshot');

    const { pipeline, logs } = makeRealBatchPipeline(root, {});
    // Direct call: _snapshotInterruptedEntry is the helper that fires at every
    // abort exit; this exercises its tree-state-branched catch. isGitRepo===true
    // is required to reach the git/catch path (the isGitRepo===false branch does
    // no git work at all — see IR9).
    pipeline._snapshotInterruptedEntry('spec-x', true);

    // Honest: the tree is STILL dirty and no ref was created.
    assert.ok(porcelain(root) !== '', 'IR6: the tree must remain dirty (the stash could not run)');
    assert.ok(!refExists(root, 'refs/interrupt/spec-x'), 'IR6: no ref is created when the snapshot throws');
    assert.ok(
      logs.some((l) => /STILL DIRTY/i.test(l) && /manual/i.test(l)),
      `IR6: expected an honest "STILL DIRTY / manual" message. Logs:\n${logs.join('\n')}`,
    );
  } finally {
    cleanup(root);
  }
});

// ── IR7 ───────────────────────────────────────────────────────────────────────
// `cc-orch clean`'s reaper enumerates ONLY the refs/interrupt/* namespace and
// drops a ref ONLY when its queue/<slug>/ is ABSENT. Three first-class guards:
//   (a) an ORPHAN interrupt ref (refs/interrupt/<slug>, queue entry ABSENT — a
//       recovered + dequeued interrupt) IS reaped.
//   (b) a LIVE interrupt ref (refs/interrupt/<slug>, queue entry PRESENT — a
//       still-pending rerun) is PRESERVED (the queue-dir scope).
//   (c) a gate-halt park ref (refs/park/<slug>) is PRESERVED even when its
//       queue/<slug>/ is ABSENT — the reaper NEVER enumerates refs/park/*, so a
//       LIVE park ref owned by a DIFFERENT git worktree (shared object store,
//       per-tree queue) cannot be destroyed. This is the #5 cross-worktree
//       data-loss regression guard, now STRUCTURAL (namespace isolation).

await test('IR7 — clean reaps ONLY queue-absent refs/interrupt/*; a refs/park/* gate-halt ref is preserved even when queue-absent', async () => {
  const root = makeGitRoot();
  try {
    // clean only proceeds when .harness/ exists.
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });

    // (a) Orphan interrupt ref: present, queue entry ABSENT → must be reaped.
    git(['update-ref', 'refs/interrupt/orphan-slug', 'HEAD'], root);

    // (b) Live interrupt ref: queue entry PRESENT (a still-pending rerun) →
    //     must be PRESERVED (its WIP is recoverable until the rerun consumes it).
    createQueueEntry(root, 'pending-slug', { plan: makePlan(), status: 'pending' });
    git(['update-ref', 'refs/interrupt/pending-slug', 'HEAD'], root);

    // (c) Cross-worktree gate-halt park ref: refs/park/xworktree-slug lives in
    //     the shared object store, but its queue entry belongs to a DIFFERENT
    //     worktree, so queue/xworktree-slug/ is ABSENT here. The reaper must
    //     NEVER enumerate refs/park/* → this ref is structurally PRESERVED (the
    //     #5 data-loss guard). No park.json is written here on purpose: writing
    //     one would create queue/xworktree-slug/ and defeat the queue-absent
    //     simulation.
    git(['update-ref', 'refs/park/xworktree-slug', 'HEAD'], root);

    // Silence clean's console output for a quiet test run.
    const origLog = console.log;
    console.log = () => {};
    try {
      await clean(root, { force: true });
    } finally {
      console.log = origLog;
    }

    // (a) Orphan interrupt ref reaped.
    assert.ok(!refExists(root, 'refs/interrupt/orphan-slug'),
      'IR7: an orphan interrupt ref (queue entry absent) must be reaped by clean');
    // (b) Live interrupt ref (queue entry present) preserved.
    assert.ok(refExists(root, 'refs/interrupt/pending-slug'),
      'IR7: a live interrupt ref (queue entry present) must be PRESERVED');
    // (c) refs/park/* ref preserved even though its queue entry is absent — the
    //     reaper never touches the park namespace (cross-worktree data-loss fix).
    assert.ok(refExists(root, 'refs/park/xworktree-slug'),
      'IR7: a gate-halt refs/park/* ref must be PRESERVED by clean even when queue-absent (#5)');
  } finally {
    cleanup(root);
  }
});

// ── IR8 ───────────────────────────────────────────────────────────────────────
// Contract #2 (code-review [0] guard): _snapshotInterruptedEntry(slug, true) on
// a CLEAN tree — createParkSnapshot returns null, so NO ref is created. The
// helper must NOT be silent (a clean-tree post-exec interrupt would otherwise
// break the loop with zero output) and must NOT name a refs/interrupt/ ref it
// never created (a false-recovery hint the user would follow to "unknown
// revision"). It logs a clean-tree "interrupted" line pointing at resume.

await test('IR8 — clean-tree interrupt (isGitRepo=true, null snapshot) logs a resume hint, NO refs/interrupt/ claim, no ref', async () => {
  const root = makeGitRoot();
  try {
    const { pipeline, logs } = makeRealBatchPipeline(root, {});
    // Tree is clean (makeGitRoot commits everything) → createParkSnapshot → null.
    assert.strictEqual(porcelain(root), '', 'IR8 fixture: the tree must be clean before the call');

    pipeline._snapshotInterruptedEntry('spec-clean', true);

    // (i) A clean-tree "interrupted" line that mentions resume was emitted.
    assert.ok(
      logs.some((l) => /interrupted on a clean tree/i.test(l) && /resume/i.test(l)),
      `IR8: expected a clean-tree "interrupted … resume" hint. Logs:\n${logs.join('\n')}`,
    );
    // (ii) NO line names a refs/interrupt/ ref — none was created.
    assert.ok(
      !logs.some((l) => l.includes('refs/interrupt/')),
      `IR8: no log line may name a refs/interrupt/ ref on a null snapshot. Logs:\n${logs.join('\n')}`,
    );
    // (iii) No ref was actually created.
    assert.ok(!refExists(root, 'refs/interrupt/spec-clean'),
      'IR8: a clean tree (null snapshot) must NOT create a snapshot ref');
    // Sanity: the helper was NOT silent.
    assert.ok(logs.length > 0, 'IR8: the helper must not be silent on a clean-tree interrupt');
  } finally {
    cleanup(root);
  }
});

// ── IR9 ───────────────────────────────────────────────────────────────────────
// Contract #1 (code-review [6] guard): _snapshotInterruptedEntry(slug, false) —
// a NON-git project. The helper must do NO git work at all (no createParkSnapshot,
// no `git status`), create no ref, and emit exactly one plain "stays pending /
// reruns" line — never a "STILL DIRTY" / "git error" / "snapshotted" message
// (all of which would be bogus in a repo where git was never involved).

await test('IR9 — non-git interrupt (isGitRepo=false) logs a plain pending/rerun line, no git work, no ref, no dirty/error/snapshot text', async () => {
  // A NON-git directory: no `git init`, so any git spawn would throw. The helper
  // must not spawn git at all on this branch.
  const root = makeTmpRoot();
  try {
    const { pipeline, logs } = makeRealBatchPipeline(root, {});

    pipeline._snapshotInterruptedEntry('spec-nogit', false);

    // (i) A line telling the user the entry stays pending / reruns next batch.
    assert.ok(
      logs.some((l) => /interrupted/i.test(l) && /pending/i.test(l) && /reruns/i.test(l)),
      `IR9: expected a "stays pending / reruns" line. Logs:\n${logs.join('\n')}`,
    );
    // (ii) NONE of the git-branch messages leaked into a non-git run.
    assert.ok(
      !logs.some((l) => /STILL DIRTY/i.test(l)),
      `IR9: no "STILL DIRTY" text on a non-git branch. Logs:\n${logs.join('\n')}`,
    );
    assert.ok(
      !logs.some((l) => /snapshotted/i.test(l)),
      `IR9: no "snapshotted" text on a non-git branch. Logs:\n${logs.join('\n')}`,
    );
    assert.ok(
      !logs.some((l) => /git error/i.test(l)),
      `IR9: no "git error" text on a non-git branch. Logs:\n${logs.join('\n')}`,
    );
    // (iii) No git side effect: no refs/interrupt/ named anywhere, and the dir is
    //       still not a git repo (the helper never ran `git init`/any git spawn).
    assert.ok(
      !logs.some((l) => l.includes('refs/interrupt/')),
      `IR9: no refs/interrupt/ ref may be named on a non-git branch. Logs:\n${logs.join('\n')}`,
    );
    assert.ok(!fs.existsSync(path.join(root, '.git')),
      'IR9: the non-git branch must not create a git repo (no git work at all)');
  } finally {
    cleanup(root);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
