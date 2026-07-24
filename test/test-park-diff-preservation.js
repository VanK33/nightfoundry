#!/usr/bin/env node
/**
 * test-park-diff-preservation.js — Track P P2: preserve the work-in-progress
 * diff on a resolvable-park gate-halt (spec: p2-park-diff-preservation.spec.md
 * / .json, AC1).
 *
 * Written by the INDEPENDENT test author against the spec's acceptance
 * criteria + the pinned interface contract — before the implementation
 * exists. At a pre-feature HEAD this fails on module resolution (no
 * src/orchestrator/core/park-snapshot.js); once the primitive lands these
 * behavioral assertions hold.
 *
 * AC1: On a gate-halt that routes to a resolvable park, the WIP diff —
 * tracked modifications AND untracked new files — is preserved (not
 * discarded), the working tree is left CLEAN for the next entry, and the
 * preserved snapshot survives a `git gc`.
 *
 * Pinned contract under test (createParkSnapshot / showParkSnapshot /
 * reattachParkSnapshot):
 *   createParkSnapshot(slug, cwd) → captures WIP (tracked + untracked) via
 *     git stash, pins refs/park/<slug> (gc-safe), leaves tree CLEAN, returns
 *     { stashRef, stashSha, baseSha }; returns null when tree already clean.
 *   showParkSnapshot(stashRefOrSha, cwd) → diff text of the preserved WIP.
 *   reattachParkSnapshot(stashRef, cwd) → git stash apply (3-way); THROWS on
 *     conflict/failure.
 *
 * Run: node test/test-park-diff-preservation.js
 *
 * Discipline: a REAL temp git repo (git init + commits) is used because the
 * snapshot primitive is git-stash/ref level; no logic is copied from the
 * implementation into the assertions.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import {
  createParkSnapshot,
  showParkSnapshot,
  reattachParkSnapshot,
} from '../src/orchestrator/core/park-snapshot.js';

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

// ── Git fixture ─────────────────────────────────────────────────────────────

function makeTmpRoot(prefix = 'cc-orch-park-diff-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// init + identity + a tracked seed file committed clean. Mirrors
// test-park-foundation.js makeGitRoot but local to this file (and without the
// harness-side .gitignore — this file exercises the raw git primitive, where
// untracked-file capture is part of the contract).
function makeGitRoot(prefix = 'cc-orch-park-diff-git-') {
  const root = makeTmpRoot(prefix);
  git(root, 'init');
  git(root, 'config user.email "test@example.com"');
  git(root, 'config user.name "Test User"');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed content\n');
  git(root, 'add -A');
  git(root, 'commit -m init');
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function porcelain(root) {
  return git(root, 'status --porcelain').trim();
}

function headSha(root) {
  return git(root, 'rev-parse HEAD').trim();
}

// ── AC1.1: capture both tracked + untracked, leave the tree CLEAN ───────────

await test('AC1: createParkSnapshot captures BOTH a tracked modification and an untracked new file, then leaves the working tree clean', async () => {
  const root = makeGitRoot();
  try {
    // Tracked modification + a brand-new untracked file (executors create new
    // files such as tests — the spec requires both be captured).
    fs.writeFileSync(path.join(root, 'seed.txt'), 'seed content\nWIP-TRACKED-CHANGE\n');
    fs.writeFileSync(path.join(root, 'new-test.js'), 'UNTRACKED-NEW-FILE-CONTENT\n');

    // Sanity: the tree is genuinely dirty before snapshotting.
    assert.notStrictEqual(porcelain(root), '',
      'fixture: the working tree must be dirty before createParkSnapshot');

    const snap = createParkSnapshot('diff-a', root);

    assert.ok(snap && typeof snap === 'object',
      `createParkSnapshot must return a snapshot descriptor for a dirty tree (got ${JSON.stringify(snap)})`);
    assert.ok(snap.stashRef, `descriptor must carry stashRef (got ${JSON.stringify(snap)})`);
    assert.ok(snap.stashSha, `descriptor must carry stashSha (got ${JSON.stringify(snap)})`);
    assert.ok(snap.baseSha, `descriptor must carry baseSha (got ${JSON.stringify(snap)})`);
    assert.strictEqual(snap.baseSha, headSha(root),
      'baseSha must be the HEAD commit at snapshot time');

    // The tree is now CLEAN — both the tracked mod and the untracked file are
    // gone from the working tree (ready for the next batch entry).
    assert.strictEqual(porcelain(root), '',
      `the working tree must be CLEAN after createParkSnapshot (got: ${porcelain(root)})`);
    assert.strictEqual(fs.readFileSync(path.join(root, 'seed.txt'), 'utf8'), 'seed content\n',
      'the tracked modification must be removed from the working tree (reverted to HEAD)');
    assert.ok(!fs.existsSync(path.join(root, 'new-test.js')),
      'the untracked new file must be removed from the working tree by the snapshot');
  } finally {
    cleanup(root);
  }
});

// ── AC1.2: the snapshot is recoverable — content includes BOTH changes ──────

await test('AC1: the preserved snapshot is recoverable and its content includes both the tracked change and the untracked file', async () => {
  const root = makeGitRoot();
  try {
    fs.writeFileSync(path.join(root, 'seed.txt'), 'seed content\nWIP-TRACKED-CHANGE\n');
    fs.writeFileSync(path.join(root, 'new-test.js'), 'UNTRACKED-NEW-FILE-CONTENT\n');

    const snap = createParkSnapshot('diff-b', root);

    // showParkSnapshot renders the preserved WIP as diff text — it must carry
    // both the tracked change and the untracked file's content.
    const diff = showParkSnapshot(snap.stashRef, root);
    assert.ok(typeof diff === 'string' && diff.length > 0,
      `showParkSnapshot must return non-empty diff text (got ${JSON.stringify(diff)})`);
    assert.ok(diff.includes('WIP-TRACKED-CHANGE'),
      `the preserved diff must include the tracked modification (diff: ${diff.slice(0, 400)})`);
    assert.ok(diff.includes('UNTRACKED-NEW-FILE-CONTENT'),
      `the preserved diff must include the untracked new file's content (diff: ${diff.slice(0, 400)})`);

    // Recoverable by SHA too (showParkSnapshot accepts a ref OR a sha).
    const diffBySha = showParkSnapshot(snap.stashSha, root);
    assert.ok(diffBySha.includes('WIP-TRACKED-CHANGE') && diffBySha.includes('UNTRACKED-NEW-FILE-CONTENT'),
      'showParkSnapshot must render the same WIP when given the stashSha');
  } finally {
    cleanup(root);
  }
});

// ── AC1.3: the snapshot survives `git gc --prune=now` (ref-anchored) ────────

await test('AC1: the preserved snapshot survives git gc --prune=now — the ref still resolves and reattach still restores the WIP', async () => {
  const root = makeGitRoot();
  try {
    fs.writeFileSync(path.join(root, 'seed.txt'), 'seed content\nWIP-TRACKED-CHANGE\n');
    fs.writeFileSync(path.join(root, 'new-test.js'), 'UNTRACKED-NEW-FILE-CONTENT\n');

    const snap = createParkSnapshot('diff-c', root);

    // The anchoring ref must exist (gc-safety is its whole purpose).
    const ref = `refs/park/diff-c`;
    const resolvedBefore = git(root, `rev-parse --verify ${ref}`).trim();
    assert.ok(resolvedBefore, `refs/park/<slug> must be created to anchor the stash object (ref: ${ref})`);

    // Aggressively gc: a dangling stash object would be pruned here.
    git(root, 'gc --prune=now');
    // Also expire reflogs so the stash reflog entry cannot keep the object
    // alive — only the explicit ref should.
    try { git(root, 'reflog expire --expire=now --all'); git(root, 'gc --prune=now'); } catch { /* best effort */ }

    // The ref still resolves after gc…
    const resolvedAfter = git(root, `rev-parse --verify ${ref}`).trim();
    assert.strictEqual(resolvedAfter, resolvedBefore,
      'refs/park/<slug> must still resolve to the same object after git gc --prune=now (object was anchored, not dangling)');

    // …and the WIP is still recoverable / reattachable after gc.
    const diff = showParkSnapshot(snap.stashRef, root);
    assert.ok(diff.includes('WIP-TRACKED-CHANGE') && diff.includes('UNTRACKED-NEW-FILE-CONTENT'),
      'the preserved diff must still be readable after git gc');

    reattachParkSnapshot(snap.stashRef, root);
    assert.strictEqual(fs.readFileSync(path.join(root, 'seed.txt'), 'utf8'), 'seed content\nWIP-TRACKED-CHANGE\n',
      'reattach after gc must restore the tracked modification to the working tree');
    assert.ok(fs.existsSync(path.join(root, 'new-test.js')),
      'reattach after gc must restore the untracked new file to the working tree');
    assert.strictEqual(fs.readFileSync(path.join(root, 'new-test.js'), 'utf8'), 'UNTRACKED-NEW-FILE-CONTENT\n',
      'the restored untracked file must carry its original content');
  } finally {
    cleanup(root);
  }
});

// ── AC1.4: an already-clean tree → null (nothing to preserve) ───────────────

await test('AC1: createParkSnapshot returns null on an already-clean tree (no snapshot, no ref)', async () => {
  const root = makeGitRoot();
  try {
    assert.strictEqual(porcelain(root), '', 'fixture: the tree must be clean to start');

    const snap = createParkSnapshot('diff-clean', root);
    assert.strictEqual(snap, null,
      `createParkSnapshot must return null when there is no WIP to preserve (got ${JSON.stringify(snap)})`);

    // No anchoring ref may be created for a no-op snapshot.
    let refExists = true;
    try { git(root, 'rev-parse --verify refs/park/diff-clean'); } catch { refExists = false; }
    assert.ok(!refExists,
      'no refs/park/<slug> may be created when the tree is already clean');

    // The tree stays clean.
    assert.strictEqual(porcelain(root), '', 'a no-op snapshot must leave the tree clean');
  } finally {
    cleanup(root);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
