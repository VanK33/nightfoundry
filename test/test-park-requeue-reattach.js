#!/usr/bin/env node
/**
 * test-park-requeue-reattach.js — Track P P2: requeue re-attaches the
 * preserved snapshot before re-execution; a failed/conflicting re-attach is
 * surfaced loudly and the entry is NOT advanced (spec:
 * p2-park-diff-preservation.spec.md / .json, AC3).
 *
 * Written by the INDEPENDENT test author against the spec's acceptance
 * criteria + the pinned interface contract — before the implementation
 * exists. At a pre-feature HEAD this fails on module resolution
 * (src/orchestrator/core/park-snapshot.js absent).
 *
 * AC3: park resolve --requeue re-attaches the preserved snapshot (3-way) to
 * the working tree BEFORE the entry re-runs; when re-application
 * conflicts/fails the failure is surfaced loudly and the entry is NOT advanced
 * to pending as if the work were restored.
 *
 * Pinned contract:
 *   reattachParkSnapshot(stashRef, cwd) → git stash apply (3-way); THROWS on
 *     conflict/failure.
 *   park resolve --requeue reattaches BEFORE pending; on reattach throw →
 *     loud + entry NOT advanced; on success → cleanup ref → pending.
 *
 * The happy path's tree-restoration and the conflict path's
 * loud-failure-and-no-advance are driven END-TO-END through the
 * `cc-orch park resolve --requeue` CLI surface, plus a primitive-level
 * assertion that reattachParkSnapshot throws on conflict.
 *
 * Run: node test/test-park-requeue-reattach.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  createParkSnapshot,
  reattachParkSnapshot,
  showParkSnapshot,
} from '../src/orchestrator/core/park-snapshot.js';
import { writeQueueEntry } from '../src/orchestrator/core/state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../src/cli/index.js');

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

// ── Fixtures ────────────────────────────────────────────────────────────────

const SPEC_MD = `# Test Spec

This is a test spec for park requeue reattach.

## Goals
- Build something useful
`;
const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

function makeTmpRoot(prefix = 'cc-orch-park-reattach-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function makeGitRoot(prefix = 'cc-orch-park-reattach-git-') {
  const root = makeTmpRoot(prefix);
  git(root, 'init');
  git(root, 'config user.email "test@example.com"');
  git(root, 'config user.name "Test User"');
  // Multi-line seed so we can target distinct lines for clean vs conflicting
  // re-application.
  fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nline two\nline three\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'queue/\narchives/\n.harness/\n');
  git(root, 'add -A');
  git(root, 'commit -m init');
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function readStatus(root, slug) {
  return fs.readFileSync(path.join(root, 'queue', slug, 'status'), 'utf8').trim();
}

function refExists(root, slug) {
  try { git(root, `rev-parse --verify refs/park/${slug}`); return true; } catch { return false; }
}

function createQueueEntry(root, slug, status) {
  writeQueueEntry(root, slug, {
    spec: SPEC_MD,
    plan: { milestones: [], assumptions: [] },
    validatedAt: new Date().toISOString(),
    status,
    specJson: SPEC_JSON,
  });
}

function makeSnapshotScene(snap, overrides = {}) {
  return {
    site: 'review-gate',
    parkedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    round1: [],
    round2: null,
    appliedSpecEdits: [],
    questions: ['Review-gate decision needed.'],
    previousResolutions: [],
    resolution: null,
    stashRef: snap.stashRef,
    stashSha: snap.stashSha,
    baseSha: snap.baseSha,
    ...overrides,
  };
}

function writeScene(root, slug, scene) {
  fs.writeFileSync(path.join(root, 'queue', slug, 'park.json'), JSON.stringify(scene, null, 2));
}

function runCli(root, args) {
  const res = spawnSync('node', [CLI_PATH, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', out: `${res.stdout || ''}\n${res.stderr || ''}` };
}

// An error must be non-silent: non-zero exit OR stderr output.
function assertLoud(res, label) {
  assert.ok(
    res.status !== 0 || res.stderr.trim().length > 0,
    `${label}: the failure must be surfaced loudly (non-zero exit or stderr message); got exit ${res.status} with empty stderr`
  );
}

// ── AC3.1 (primitive): reattach restores the WIP (tracked + untracked) ──────

await test('AC3: reattachParkSnapshot restores the WIP (tracked change + untracked file) to the working tree', async () => {
  const root = makeGitRoot();
  try {
    fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nWIP-LINE-TWO\nline three\n');
    fs.writeFileSync(path.join(root, 'new-file.js'), 'UNTRACKED-CONTENT\n');
    const snap = createParkSnapshot('ra-ok', root);
    assert.strictEqual(git(root, 'status --porcelain').trim(), '',
      'fixture: snapshot must leave a clean tree');

    reattachParkSnapshot(snap.stashRef, root);

    assert.strictEqual(fs.readFileSync(path.join(root, 'seed.txt'), 'utf8'), 'line one\nWIP-LINE-TWO\nline three\n',
      'reattach must restore the tracked modification');
    assert.ok(fs.existsSync(path.join(root, 'new-file.js')),
      'reattach must restore the untracked new file');
    assert.strictEqual(fs.readFileSync(path.join(root, 'new-file.js'), 'utf8'), 'UNTRACKED-CONTENT\n',
      'the restored untracked file must carry its original content');
  } finally {
    cleanup(root);
  }
});

// ── AC3.2 (primitive): reattach THROWS on a conflicting tree ────────────────

await test('AC3: reattachParkSnapshot THROWS when the 3-way re-application conflicts with the current tree', async () => {
  const root = makeGitRoot();
  try {
    // Snapshot changes line two.
    fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nWIP-LINE-TWO\nline three\n');
    const snap = createParkSnapshot('ra-conflict', root);

    // Now make a CONFLICTING change to the same line in the working tree
    // before reattaching: a 3-way apply cannot reconcile two different edits
    // to the same line.
    fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nDIVERGENT-LINE-TWO\nline three\n');

    assert.throws(
      () => reattachParkSnapshot(snap.stashRef, root),
      'reattachParkSnapshot must THROW when git stash apply conflicts (do not silently swallow a conflict)'
    );
  } finally {
    cleanup(root);
  }
});

// ── AC3.3 (end-to-end): --requeue restores the WIP to the tree ──────────────

await test('AC3: park resolve --requeue re-attaches the preserved WIP (tracked change + untracked file) to the working tree', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'rq-ok', 'halted-review');
    fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nWIP-LINE-TWO\nline three\n');
    fs.writeFileSync(path.join(root, 'new-file.js'), 'UNTRACKED-CONTENT\n');
    const snap = createParkSnapshot('rq-ok', root);
    assert.strictEqual(git(root, 'status --porcelain').trim(), '', 'fixture: clean tree after snapshot');
    writeScene(root, 'rq-ok', makeSnapshotScene(snap));

    const res = runCli(root, ['park', 'resolve', 'rq-ok', '--requeue']);
    assert.strictEqual(res.status, 0,
      `resolve --requeue must succeed (got exit ${res.status}; output: ${res.out.trim().slice(0, 400)})`);

    // The WIP is back in the working tree.
    assert.strictEqual(fs.readFileSync(path.join(root, 'seed.txt'), 'utf8'), 'line one\nWIP-LINE-TWO\nline three\n',
      'requeue must re-attach the tracked modification to the working tree');
    assert.ok(fs.existsSync(path.join(root, 'new-file.js')),
      'requeue must re-attach the untracked new file to the working tree');
    assert.strictEqual(fs.readFileSync(path.join(root, 'new-file.js'), 'utf8'), 'UNTRACKED-CONTENT\n',
      'the re-attached untracked file must carry its original content');

    // Advanced to pending (the re-attach succeeded BEFORE the status flip).
    assert.strictEqual(readStatus(root, 'rq-ok'), 'pending',
      "a successful requeue re-attach must advance the entry to 'pending'");
  } finally {
    cleanup(root);
  }
});

// ── AC3.4 (end-to-end): conflict on --requeue → loud + entry NOT advanced ───

await test('AC3: park resolve --requeue on a conflicting tree fails loudly and does NOT advance the entry to pending', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'rq-conflict', 'halted-review');
    fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nWIP-LINE-TWO\nline three\n');
    const snap = createParkSnapshot('rq-conflict', root);
    writeScene(root, 'rq-conflict', makeSnapshotScene(snap));

    // Arrange a conflicting working-tree change on the same line so the 3-way
    // re-application cannot apply. (This models HEAD/tree having moved
    // incompatibly between halt and requeue.)
    fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nDIVERGENT-LINE-TWO\nline three\n');

    const res = runCli(root, ['park', 'resolve', 'rq-conflict', '--requeue']);

    // Surfaced loudly — never a silent success.
    assertLoud(res, 'requeue on a conflicting tree');

    // The entry must NOT be advanced as if the work were restored.
    assert.strictEqual(readStatus(root, 'rq-conflict'), 'halted-review',
      "a conflicting re-attach must NOT advance the entry to 'pending' — it stays at its pre-resolve status so a human can intervene");

    // And the snapshot must NOT be cleaned up — a conflict means the work is
    // not yet safely restored, so the anchoring ref must survive for retry.
    assert.ok(refExists(root, 'rq-conflict'),
      'a conflicting re-attach must NOT drop refs/park/<slug> — the preserved work must remain recoverable');
  } finally {
    cleanup(root);
  }
});

// ── AC3.5 (HEAD-moved): the real 3-way conflict that justified a stash object ─
//
// The earlier conflict tests model a DIRTY working tree at reattach time. This
// one models the scenario that JUSTIFIED choosing a stash OBJECT (3-way apply)
// over a plain patch file: HEAD has MOVED between the halt and the requeue (a
// later batch entry committed deliverables at its spec boundary), so the
// snapshot's base diverges from the current tree even though the tree is CLEAN.
// A plain `git apply` of a patch would fail; the 3-way stash apply still
// CONFLICTS here because the moved HEAD edits the SAME line the preserved WIP
// edits. The failure must surface loudly, the entry must NOT advance, the
// anchoring ref must be RETAINED, and the preserved work must remain
// recoverable from the ref. (Asserted by BEHAVIOR, not message text.)

await test('AC3: reattach surfaces a HEAD-moved 3-way conflict loudly and keeps the work recoverable (clean tree, base diverged by a commit)', async () => {
  const root = makeGitRoot();
  try {
    // Preserve a WIP that edits line two.
    fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nWIP-LINE-TWO\nline three\n');
    const snap = createParkSnapshot('ra-head-moved', root);
    assert.strictEqual(git(root, 'status --porcelain').trim(), '',
      'fixture: the snapshot must leave a CLEAN tree (the divergence is via a commit, not a dirty tree)');
    const baseAtSnapshot = git(root, 'rev-parse HEAD').trim();

    // Now MOVE HEAD: commit a conflicting change to the SAME line, so the
    // snapshot's base (baseAtSnapshot) no longer matches the current tree.
    fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nHEAD-MOVED-LINE-TWO\nline three\n');
    git(root, 'add -A');
    git(root, 'commit -m "diverge HEAD on the same line"');
    const headAfterMove = git(root, 'rev-parse HEAD').trim();
    assert.notStrictEqual(headAfterMove, baseAtSnapshot,
      'fixture: HEAD must have moved so the snapshot base genuinely diverged');
    assert.strictEqual(git(root, 'status --porcelain').trim(), '',
      'fixture: the tree must be CLEAN when reattach runs (this is the HEAD-moved, not dirty-tree, case)');

    // The 3-way apply must THROW — it cannot reconcile two different edits of
    // the same line across the diverged base.
    assert.throws(
      () => reattachParkSnapshot(snap.stashRef, root),
      'reattach must THROW on a HEAD-moved 3-way conflict (a plain patch could not even attempt this; the stash object is why a 3-way is possible at all)'
    );

    // The preserved work must remain RECOVERABLE from the ref — a failed
    // reattach must not have dropped it.
    assert.ok(refExists(root, 'ra-head-moved'),
      'a conflicting HEAD-moved reattach must RETAIN refs/park/<slug> — the preserved work must stay recoverable');
    const preserved = showParkSnapshot(snap.stashRef, root);
    assert.ok(preserved.includes('WIP-LINE-TWO'),
      `the preserved WIP must still be readable from the ref after a failed reattach. diff:\n${preserved.slice(0, 400)}`);
  } finally {
    cleanup(root);
  }
});

// ── AC3.6 (HEAD-moved, end-to-end): --requeue on a diverged base ────────────
//
// The same HEAD-moved divergence, driven through the `park resolve --requeue`
// CLI surface: a clean tree, the snapshot base moved by a commit on the same
// line. The CLI must fail LOUDLY (non-zero exit or stderr), must NOT advance
// the entry to 'pending', and must RETAIN refs/park/<slug> so the work stays
// recoverable. Behavior, not message text.

await test('AC3: park resolve --requeue on a HEAD-moved diverged base fails loudly, does NOT advance, and retains the ref', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'rq-head-moved', 'halted-review');
    fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nWIP-LINE-TWO\nline three\n');
    const snap = createParkSnapshot('rq-head-moved', root);
    assert.strictEqual(git(root, 'status --porcelain').trim(), '', 'fixture: clean tree after snapshot');
    writeScene(root, 'rq-head-moved', makeSnapshotScene(snap));

    // Move HEAD: commit a conflicting change on the same line, leaving the tree
    // clean. (Models a later batch entry committing deliverables at its spec
    // boundary between the halt and the requeue.)
    fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nHEAD-MOVED-LINE-TWO\nline three\n');
    git(root, 'add -A');
    git(root, 'commit -m "diverge HEAD on the same line"');
    assert.strictEqual(git(root, 'status --porcelain').trim(), '',
      'fixture: tree must be CLEAN when requeue runs (HEAD-moved, not dirty-tree)');

    const res = runCli(root, ['park', 'resolve', 'rq-head-moved', '--requeue']);

    // Surfaced loudly — never a silent success.
    assertLoud(res, 'requeue on a HEAD-moved diverged base');

    // The entry must NOT advance as if the work were restored.
    assert.strictEqual(readStatus(root, 'rq-head-moved'), 'halted-review',
      "a HEAD-moved conflict must NOT advance the entry to 'pending' — it stays at its pre-resolve status for a human to intervene");

    // The anchoring ref must survive so the preserved work remains recoverable.
    assert.ok(refExists(root, 'rq-head-moved'),
      'a HEAD-moved conflict must RETAIN refs/park/<slug> — the preserved work must stay recoverable for retry');
    const preserved = showParkSnapshot(snap.stashRef, root);
    assert.ok(preserved.includes('WIP-LINE-TWO'),
      'the preserved WIP must still be recoverable from the ref after a failed requeue');
  } finally {
    cleanup(root);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
