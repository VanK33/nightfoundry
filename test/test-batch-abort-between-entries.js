#!/usr/bin/env node
/**
 * test-batch-abort-between-entries.js — abort absorbed during a review gate must
 * let THAT entry finish, then stop the batch BEFORE the next pending entry.
 *
 * SPEC (behavior under test — batchResume loop head):
 *   batchResume processes pending queue entries in creation-time order. Each
 *   entry runs: gates → bootstrap → execute milestones → review gate → archive →
 *   dequeue → spec-boundary git commit. A cancel AbortController lives at
 *   pipeline._cancelController; SIGINT aborts its signal.
 *
 *   If the abort signal fires WHILE an entry's REVIEW GATE (or archive/commit)
 *   runs — i.e. AFTER that entry's execution finished — that entry must still
 *   complete normally: archived, dequeued, and committed at the spec boundary
 *   (its work is verified; discarding it would waste a delivery). The abort then
 *   takes effect BEFORE the NEXT pending entry starts:
 *     - the batch loop stops with a log line
 *       "Pipeline cancelled — batch stopped before next entry";
 *     - the next entry is NEVER processed — no "Processing queue entry: <slug2>"
 *       log line for it;
 *     - the next entry stays 'pending' with its queue/<slug2>/ dir intact;
 *     - it spends nothing.
 *   Because the completing entry's spec-boundary commit leaves the tree CLEAN,
 *   NO interrupt snapshot ref (refs/interrupt/*) is created for either entry on
 *   this path (this is the review-gate-absorbed abort, NOT the mid-execution
 *   interrupt that snapshots WIP).
 *
 * These tests drive the REAL Pipeline.batchResume against live git repos and
 * observe real behavior (archive dir, dequeue, commit subject, ref absence,
 * tree cleanliness, log lines). Planner/execution phases are stubbed; archive()
 * and the review gate are injected seams.
 *
 * Run: node test/test-batch-abort-between-entries.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { readQueueEntry } from '../src/orchestrator/core/state.js';
import {
  git,
  makeGitRoot,
  cleanup,
  porcelain,
  gitSubjects,
  makePlan,
  createQueueEntry,
  makeFakeArchive,
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

// Shared git + queue + real-batch fixtures live in ./helpers/batch-fixtures.js.
// listInterruptRefs is abort-specific (only this file enumerates the namespace).

/** Every ref under refs/interrupt/* (empty list == none exist). */
function listInterruptRefs(root) {
  const out = git(['for-each-ref', '--format=%(refname)', 'refs/interrupt/'], root).trim();
  return out === '' ? [] : out.split('\n');
}

// ── AB1 ───────────────────────────────────────────────────────────────────────
// Abort absorbed during entry 1's review gate: entry 1 completes normally
// (archived + dequeued + committed), the batch stops BEFORE entry 2, entry 2
// stays pending + untouched, and NO interrupt ref exists (clean-tree path).

await test('AB1 — abort during entry-1 review gate: entry 1 finishes + dequeues + commits, batch stops before entry 2, entry 2 stays pending, no interrupt ref', async () => {
  const root = makeGitRoot();
  try {
    // Two pending entries in creation-time order (entry-one first).
    createQueueEntry(root, 'entry-one', { plan: makePlan(), validatedAt: '2026-06-01T00:00:00.000Z' });
    await new Promise((r) => setTimeout(r, 20));
    createQueueEntry(root, 'entry-two', { plan: makePlan(), validatedAt: '2026-06-02T00:00:00.000Z' });

    // Track which entries executed to prove entry 2 never runs.
    const executed = [];
    let reviewCalls = 0;

    const built = makeRealBatchPipeline(root, {
      archive: makeFakeArchive('Entry one headline'),
      executeAllMilestones: async () => {
        // Write a tracked deliverable so the spec-boundary commit has content.
        // (Only entry 1 should ever reach here.)
        const n = executed.length + 1;
        fs.writeFileSync(path.join(root, `deliverable-${n}.txt`), `shipped ${n}\n`);
        executed.push(n);
      },
    });
    const { pipeline, logs } = built;

    // Review-gate seam: on entry 1's review gate, absorb a SIGINT (abort the
    // cancel controller) and then return normally (review PASSED). The abort must
    // take effect only after this entry finishes archiving/committing.
    pipeline._reviewGate = async () => {
      reviewCalls++;
      if (reviewCalls === 1) {
        pipeline._cancelController.abort();
      }
    };

    const result = await pipeline.batchResume({});

    // (a) Exactly one entry executed (entry 1). Entry 2 never ran.
    assert.deepStrictEqual(executed, [1],
      `AB1: only entry 1 should execute; got executed=${JSON.stringify(executed)}`);
    assert.strictEqual(reviewCalls, 1,
      `AB1: the review gate must run exactly once (entry 1 only); got ${reviewCalls}`);

    // (b) Entry 1 archived + dequeued.
    assert.strictEqual(result.archived, 1, `AB1: expected archived:1, got ${result.archived}`);
    assert.ok(fs.existsSync(path.join(root, 'archives', 'entry-one')),
      'AB1: entry 1 must be archived (archives/entry-one/ exists)');
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'entry-one')),
      'AB1: entry 1 must be dequeued (queue/entry-one/ removed)');

    // (c) Entry 1's spec-boundary commit landed (subject == manifest headline).
    const subjects = gitSubjects(root);
    assert.ok(subjects.includes('Entry one headline'),
      `AB1: expected a spec-boundary commit "Entry one headline". Subjects: ${JSON.stringify(subjects)}`);

    // (d) The batch stopped before entry 2 — the cancel log line appears.
    assert.ok(
      logs.some((l) => l.includes('batch stopped before next entry')),
      `AB1: expected a "batch stopped before next entry" cancel line. Logs:\n${logs.join('\n')}`,
    );

    // (e) Entry 2 was NEVER processed: no "Processing queue entry: entry-two".
    assert.ok(
      !logs.some((l) => l.includes('Processing queue entry: entry-two')),
      `AB1: entry 2 must never be announced/processed. Logs:\n${logs.join('\n')}`,
    );

    // (f) Entry 2 still pending, queue dir intact, not archived.
    const entry2 = readQueueEntry(root, 'entry-two');
    assert.ok(entry2 !== null && entry2.status === 'pending',
      `AB1: entry 2 must remain pending. Got: ${JSON.stringify(entry2 && entry2.status)}`);
    assert.ok(fs.existsSync(path.join(root, 'queue', 'entry-two')),
      'AB1: entry 2 queue dir (queue/entry-two/) must stay intact');
    assert.ok(!fs.existsSync(path.join(root, 'archives', 'entry-two')),
      'AB1: entry 2 must NOT be archived');

    // (g) NO interrupt snapshot ref for either entry — the completing entry's
    //     spec-boundary commit left the tree clean, so this is NOT the WIP-snapshot
    //     interrupt path.
    assert.deepStrictEqual(listInterruptRefs(root), [],
      `AB1: no refs/interrupt/* may exist on the review-gate-absorbed path. Got: ${JSON.stringify(listInterruptRefs(root))}`);

    // (h) The working tree is clean (entry 1's spec-boundary commit persisted).
    assert.strictEqual(porcelain(root), '',
      `AB1: tree must be clean after entry 1's spec-boundary commit. Got:\n${porcelain(root)}`);

    // (i) An interrupt is not a failure.
    assert.strictEqual(result.failed, 0, `AB1: expected failed:0, got ${result.failed}`);
  } finally {
    cleanup(root);
  }
});

// ── AB2 ───────────────────────────────────────────────────────────────────────
// Control (no abort): same two entries; the review gate returns normally without
// aborting → BOTH entries archive + dequeue. Proves the new loop-head check does
// not false-fire when no abort happened.

await test('AB2 — control: review gate returns normally (no abort) → BOTH entries archive + dequeue, no cancel line', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'entry-one', { plan: makePlan(), validatedAt: '2026-06-01T00:00:00.000Z' });
    await new Promise((r) => setTimeout(r, 20));
    createQueueEntry(root, 'entry-two', { plan: makePlan(), validatedAt: '2026-06-02T00:00:00.000Z' });

    const executed = [];
    const { pipeline, logs } = makeRealBatchPipeline(root, {
      archive: makeFakeArchive('headline'),
      executeAllMilestones: async () => {
        const n = executed.length + 1;
        fs.writeFileSync(path.join(root, `deliverable-${n}.txt`), `shipped ${n}\n`);
        executed.push(n);
      },
      // Review gate never aborts.
      reviewGate: async () => {},
    });

    const result = await pipeline.batchResume({});

    // Both entries ran and archived.
    assert.strictEqual(result.archived, 2, `AB2: expected archived:2, got ${result.archived}`);
    assert.strictEqual(result.failed, 0, `AB2: expected failed:0, got ${result.failed}`);
    assert.deepStrictEqual(executed, [1, 2],
      `AB2: both entries should execute in order; got ${JSON.stringify(executed)}`);

    // Both dequeued.
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'entry-one')),
      'AB2: entry 1 must be dequeued');
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'entry-two')),
      'AB2: entry 2 must be dequeued');
    // Both archived.
    assert.ok(fs.existsSync(path.join(root, 'archives', 'entry-one')),
      'AB2: entry 1 must be archived');
    assert.ok(fs.existsSync(path.join(root, 'archives', 'entry-two')),
      'AB2: entry 2 must be archived');

    // The new loop-head check must NOT false-fire: no cancel line.
    assert.ok(
      !logs.some((l) => l.includes('batch stopped before next entry')),
      `AB2: no cancel line may appear when nothing aborted. Logs:\n${logs.join('\n')}`,
    );

    // No interrupt ref on the clean control path.
    assert.deepStrictEqual(listInterruptRefs(root), [],
      `AB2: no refs/interrupt/* may exist on the control path. Got: ${JSON.stringify(listInterruptRefs(root))}`);

    // Clean tree.
    assert.strictEqual(porcelain(root), '',
      `AB2: tree must be clean after both spec-boundary commits. Got:\n${porcelain(root)}`);
  } finally {
    cleanup(root);
  }
});

// ── AB3 ───────────────────────────────────────────────────────────────────────
// Abort during the review gate of the LAST (only) entry: the entry archives
// normally and the loop simply ends (there is no next entry to stop before), so
// no crash, no interrupt ref, and no "batch stopped before next entry" is
// required.

await test('AB3 — abort during review gate of the LAST entry: entry archives normally, no crash, no interrupt ref', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'only-entry', { plan: makePlan() });

    const { pipeline } = makeRealBatchPipeline(root, {
      archive: makeFakeArchive('Only headline'),
      executeAllMilestones: async () => {
        fs.writeFileSync(path.join(root, 'deliverable.txt'), 'shipped\n');
      },
    });

    let reviewCalls = 0;
    pipeline._reviewGate = async () => {
      reviewCalls++;
      pipeline._cancelController.abort();
    };

    // Must not throw — an absorbed abort on the last entry is a graceful end.
    const result = await pipeline.batchResume({});

    assert.strictEqual(reviewCalls, 1, `AB3: the review gate must run once; got ${reviewCalls}`);

    // The entry archived + dequeued normally.
    assert.strictEqual(result.archived, 1, `AB3: expected archived:1, got ${result.archived}`);
    assert.strictEqual(result.failed, 0, `AB3: expected failed:0, got ${result.failed}`);
    assert.ok(fs.existsSync(path.join(root, 'archives', 'only-entry')),
      'AB3: the entry must be archived');
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'only-entry')),
      'AB3: the entry must be dequeued');

    // The spec-boundary commit landed.
    assert.ok(gitSubjects(root).includes('Only headline'),
      `AB3: expected a spec-boundary commit "Only headline". Subjects: ${JSON.stringify(gitSubjects(root))}`);

    // No interrupt ref — the completed entry left the tree clean.
    assert.deepStrictEqual(listInterruptRefs(root), [],
      `AB3: no refs/interrupt/* may exist. Got: ${JSON.stringify(listInterruptRefs(root))}`);

    // Clean tree.
    assert.strictEqual(porcelain(root), '',
      `AB3: tree must be clean after the spec-boundary commit. Got:\n${porcelain(root)}`);
  } finally {
    cleanup(root);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
