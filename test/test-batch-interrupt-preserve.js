#!/usr/bin/env node
/**
 * test-batch-interrupt-preserve.js — Regression test for work-preserving
 * SIGINT handling DURING task execution in a batch run (route B).
 *
 * SPEC (the behavior under test):
 *   On a batch run (batchResume), a SIGINT that fires WHILE a milestone is
 *   executing must PRESERVE work: the current entry stays resumable (NOT
 *   'failed-execution'), the work-in-progress is NOT discarded by a
 *   `git reset --hard` / `git clean`, the entry is neither archived nor
 *   advanced as a success, and the batch loop STOPS (a second pending entry
 *   is not processed).
 *
 *   Route B (interrupted-batch recovery) changes WHERE the preserved work
 *   lives: at the abort exit the pipeline runs `createParkSnapshot(slug)`,
 *   moving the whole-tree WIP (tracked mods + untracked new files) into a
 *   gc-safe stash ref refs/interrupt/<slug> and leaving the working tree CLEAN.
 *   The clean tree is deliberate — the clean-tree guard runs only once at
 *   batch start, so a dirty tree left by the interrupt would DEADLOCK the next
 *   `resume --batch` (it would be refused). The work is not lost: it is
 *   recoverable from refs/interrupt/<slug> (and the still-'pending' entry re-runs
 *   from scratch on the next batch). The invariant that survives from the
 *   original fix: NO destructive reset/clean discarded the work.
 *
 * Pre-fix, an abort mid-execution reached `assertNoNonTerminalTasks` (pipeline.js
 * ~:2111) with no abort short-circuit, throwing PendingTasksAtMilestoneAdvance →
 * the batch catch marked the entry 'failed-execution' and ran `git reset --hard`
 * / `git clean`, discarding completed edits and deleting new files.
 *
 * The fix is two guards (BOTH must be present for this test to pass):
 *   (1) _executeMilestone returns cleanly when this._cancelController.signal is
 *       aborted, BEFORE assertNoNonTerminalTasks (pipeline.js ~:2109);
 *   (2) batchResume, after _executeAllMilestones when aborted, calls
 *       _snapshotInterruptedEntry(slug) → createParkSnapshot moves the WIP into
 *       refs/interrupt/<slug> + leaves the tree CLEAN, then BREAKS the loop WITHOUT
 *       archive / advance / failed-status.
 *
 * Mutation resistance (verified by hand — see report):
 *   - Remove guard (1): _executeMilestone falls through to
 *     assertNoNonTerminalTasks, which throws PendingTasksAtMilestoneAdvance →
 *     batch catch → 'failed-execution' + reset → assertions (a) and (b) FAIL.
 *   - No-op guard (2)'s snapshot (stub _snapshotInterruptedEntry): the abort
 *     break still runs, but the tree is left DIRTY and no refs/interrupt/<slug> is
 *     created → assertion (b) (tree CLEAN + ref exists + WIP-in-ref) FAILS.
 *   - Remove guard (2)'s break entirely: the batch loop continues into
 *     _reviewGate → _archive → removeQueueEntry → commit → the entry is
 *     archived/advanced → assertions (c) and (d) FAIL.
 *
 * How the abort is driven (faithful to the production path):
 *   We let the REAL batchResume → _executeAllMilestones → _executeMilestone run.
 *   We stub only _executeMilestoneParallel (the seam _executeMilestone calls at
 *   ~:2107) so that, mid-execution, it: (i) writes a mission state file with a
 *   non-terminal task so assertNoNonTerminalTasks WOULD throw if reached,
 *   (ii) creates a dirty WIP (a tracked modification + an untracked new file),
 *   and (iii) aborts pipeline._cancelController. This exercises BOTH the
 *   ~:2109 guard inside _executeMilestone AND the post-execute batchResume
 *   snapshot-and-break.
 *
 * Run: node test/test-batch-interrupt-preserve.js
 *
 * No live Claude sessions are spawned — all agent interactions are stubbed.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeQueueEntry, readQueueEntry } from '../src/orchestrator/core/state.js';
import { showParkSnapshot } from '../src/orchestrator/core/park-snapshot.js';
import { makeGitRoot, cleanup, porcelain, refExists } from './helpers/batch-fixtures.js';

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

// ── Fixture data ───────────────────────────────────────────────────────────

// Scope-item-free markdown (no '## Scope — in', no **Bug N** bullets) so the
// scope-coverage gate skips — mirrors test/test-batch-failure-crash-safety.js.
const SPEC_MD = `# Test Spec

This is a test spec for the SIGINT-during-execution preservation path.

## Goals
- Build something useful
`;

// Parseable sibling json so the uncheckable-spec gate passes.
const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

// Plan with ONE milestone + ONE mission. writeGlobalPlan copies the mission map
// into state.milestones[ms.id].missions, which assertNoNonTerminalTasks reads.
// scopeItems:[]/scopeMapping:[] mark this a goal-only (not legacy) plan so the
// scope gate skips on present-and-empty.
const MS_ID = 'M1';
const MI_ID = 'M1-mission-1';
function makePlan() {
  return {
    milestones: [
      {
        id: MS_ID,
        description: 'The only milestone',
        missions: [{ id: MI_ID, description: 'The only mission' }],
      },
    ],
    assumptions: [],
    scopeItems: [],
    scopeMapping: [],
  };
}

// Git fixture (shared builder): a tracked seed file (tracked.txt) the interrupt
// test later modifies, and a .gitignore that also ignores archives/ +
// fake-archives/ so the injected archive stub never dirties the tree, committed
// so the tree starts clean — mirrors test/test-batch-failure-crash-safety.js.
function makePreserveGitRoot() {
  return makeGitRoot({
    prefix: 'cc-orch-interrupt-git-',
    gitignore: 'queue/\narchives/\nfake-archives/\n.harness/\n',
    seedFiles: { 'tracked.txt': 'original content\n' },
  });
}

function createQueueEntry(root, slug, { validatedAt = new Date().toISOString() } = {}) {
  writeQueueEntry(root, slug, {
    spec: SPEC_MD,
    plan: makePlan(),
    validatedAt,
    status: 'pending',
    specJson: SPEC_JSON,
  });
}

// Build a batch pipeline with stubbed agents and an injected archive seam.
// _executeMilestoneParallel is left UNstubbed here — each test stubs it to drive
// the abort (so the real _executeMilestone wrapper, with its ~:2109 guard, runs).
function makeBatchPipeline(root, opts = {}) {
  const logs = [];
  const archiveCalls = [];
  let reviewCallCount = 0;

  const archiveStub = async (_projectRoot, slug, archiveOpts) => {
    archiveCalls.push({ slug, opts: archiveOpts });
    const dir = path.join(root, 'fake-archives', String(archiveCalls.length));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ headline: 'h' }));
    return dir;
  };

  const pipeline = new Pipeline(root, {
    skipWorktreeCreation: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    archive: archiveStub,
    ...opts,
  });

  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => {};
  // _reviewGate must NOT be reached on the preserve path; count calls so a
  // regression (guard #2 removed) is observable.
  pipeline._reviewGate = async () => { reviewCallCount++; };

  return {
    pipeline,
    logs,
    archiveCalls,
    getReviewCount: () => reviewCallCount,
  };
}

// Stub _executeMilestoneParallel to simulate a SIGINT landing mid-milestone:
// leave a non-terminal task on disk, dirty the working tree, then abort.
function installAbortingExecutor(pipeline, root) {
  pipeline._executeMilestoneParallel = async (msId, _msState) => {
    // (i) Persist a mission state file with a NON-terminal task so that, if the
    //     ~:2109 abort guard were removed, assertNoNonTerminalTasks would throw.
    const stateDir = path.join(pipeline.harnessDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, `mission-${MI_ID}.json`),
      JSON.stringify({
        id: MI_ID,
        subMissions: {
          'sm-1': {
            tasks: {
              't-1': { id: 't-1', status: 'in_progress' }, // non-terminal
            },
          },
        },
      }),
    );

    // (ii) Create the work-in-progress the run produced: a tracked modification
    //      AND an untracked new file. A `git reset --hard` would revert the
    //      first; a `git clean` would delete the second.
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'WORK IN PROGRESS — edited by the run\n');
    fs.writeFileSync(path.join(root, 'new-file.txt'), 'NEW FILE created by the run\n');

    // (iii) The SIGINT lands: the cancel controller aborts mid-execution.
    pipeline._cancelController.abort();
  };
}

// ── TC1: SIGINT during execution preserves work and stops the batch ─────────

await test('TC1: SIGINT mid-execution → entry resumable, WIP snapshotted to ref + tree clean, no archive/advance, batch stops', async () => {
  const root = makePreserveGitRoot();
  try {
    // Two pending entries: the first is interrupted mid-execution; the second
    // must NOT be processed (the loop must stop).
    createQueueEntry(root, 'interrupted', { validatedAt: '2026-06-01T00:00:00.000Z' });
    createQueueEntry(root, 'untouched', { validatedAt: '2026-06-02T00:00:00.000Z' });

    const { pipeline, logs, archiveCalls, getReviewCount } = makeBatchPipeline(root);
    installAbortingExecutor(pipeline, root);

    const result = await pipeline.batchResume({});

    // (a) The interrupted entry is NOT marked failed-execution; it stays
    //     resumable (still 'pending' on disk).
    const entry = readQueueEntry(root, 'interrupted');
    assert.ok(entry, "entry 'interrupted' must still exist in the queue");
    assert.notStrictEqual(entry.status, 'failed-execution',
      `entry 'interrupted' must NOT be marked 'failed-execution' (got '${entry.status}')`);
    assert.strictEqual(entry.status, 'pending',
      `entry 'interrupted' should be left resumable as 'pending' (got '${entry.status}')`);

    // (b) Route B: NO destructive git reset --hard / git clean discarded the
    //     work. Instead the WIP was snapshotted into refs/interrupt/interrupted
    //     and the working tree was left CLEAN (so the next resume --batch's
    //     clean-tree guard is not deadlocked). "Work not lost" is still
    //     genuinely verified — just at its new location, the snapshot ref.
    //
    //  (b.1) The working tree is CLEAN after the abort (porcelain empty).
    const porcelainOut = porcelain(root);
    assert.strictEqual(porcelainOut, '',
      `the working tree must be left CLEAN after the snapshot (route B); got porcelain: "${porcelainOut}"`);

    //  (b.2) The snapshot ref exists — the WIP is pinned (gc-safe, recoverable).
    assert.ok(refExists(root, 'refs/interrupt/interrupted'),
      'refs/interrupt/interrupted must exist — the interrupted WIP is preserved in a gc-safe stash ref');

    //  (b.3) The preserved stash actually CONTAINS the WIP: the tracked
    //     modification AND the untracked new file. Read via the production
    //     read path (showParkSnapshot → `git stash show -p -u`), so "work not
    //     lost" is verified against the real recovery mechanism, not a proxy.
    const preserved = showParkSnapshot('refs/interrupt/interrupted', root);
    assert.ok(/WORK IN PROGRESS/.test(preserved),
      `the preserved snapshot must contain the tracked modification. Got:\n${preserved}`);
    assert.ok(/new-file\.txt/.test(preserved) && /NEW FILE created by the run/.test(preserved),
      `the preserved snapshot must contain the untracked new file. Got:\n${preserved}`);

    // (c) The aborted entry was NOT archived / NOT advanced as success.
    assert.strictEqual(result.archived, 0, `expected archived:0, got ${result.archived}`);
    assert.strictEqual(archiveCalls.length, 0,
      `archive must NOT be called on the interrupt-preserve path (got ${archiveCalls.length} call(s))`);
    assert.strictEqual(getReviewCount(), 0,
      `_reviewGate must NOT run after a mid-execution abort (got ${getReviewCount()} call(s))`);
    // The entry was not removed from the queue (not advanced as a success).
    assert.ok(fs.existsSync(path.join(root, 'queue', 'interrupted')),
      "entry 'interrupted' must NOT be removed from the queue");

    // (d) The loop stopped: the second pending entry was never processed.
    const untouched = readQueueEntry(root, 'untouched');
    assert.ok(untouched, "entry 'untouched' must still exist");
    assert.strictEqual(untouched.status, 'pending',
      `the second entry must remain unprocessed ('pending'), got '${untouched.status}'`);
    assert.ok(fs.existsSync(path.join(root, 'queue', 'untouched')),
      "the second entry must still be in the queue (loop stopped before it)");

    // result.failed must be 0 — an interrupt is not a failure.
    assert.strictEqual(result.failed, 0, `expected failed:0 (interrupt is not a failure), got ${result.failed}`);

    // Sanity: the interrupt-snapshot branch's announcement was emitted (not
    // load-bearing for the behavior, but confirms the snapshot-and-break abort
    // branch — not some unrelated early exit — is what stopped the run). Route A
    // routes the announcement through _snapshotInterruptedEntry, which names the
    // ref only when one was actually created (finding #3/#4); on this dirty-tree
    // path a ref IS created, so the line names refs/interrupt/interrupted.
    assert.ok(logs.some((l) => l.includes('refs/interrupt/interrupted')),
      `expected the interrupt-snapshot announcement naming refs/interrupt/interrupted. Logs:\n${logs.join('\n')}`);
  } finally {
    cleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
