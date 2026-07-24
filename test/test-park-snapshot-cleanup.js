#!/usr/bin/env node
/**
 * test-park-snapshot-cleanup.js — Track P P2: the snapshot's anchoring ref is
 * cleaned up on every resolution (spec: p2-park-diff-preservation.spec.md /
 * .json, AC4).
 *
 * Written by the INDEPENDENT test author against the spec's acceptance
 * criteria + the pinned interface contract — before the implementation
 * exists. At a pre-feature HEAD this fails on module resolution
 * (src/orchestrator/core/park-snapshot.js absent).
 *
 * AC4: refs/park/<slug> is removed after a successful requeue re-attach AND
 * after a --reject / --waive resolution — no orphaned park refs accumulate.
 * cleanupParkSnapshot is idempotent (calling it when the ref is already gone
 * does not throw).
 *
 * The primitive-level idempotency + drop is asserted directly against
 * park-snapshot.js. The "every resolution verb cleans up" contract is driven
 * END-TO-END through the `cc-orch park resolve` CLI surface (so the test does
 * not hard-code the implementer's internal resolve→cleanup wiring): a park
 * carrying a snapshot, resolved with --requeue / --reject / --waive, must
 * leave no refs/park/<slug> behind.
 *
 * Run: node test/test-park-snapshot-cleanup.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  createParkSnapshot,
  cleanupParkSnapshot,
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

This is a test spec for park snapshot cleanup.

## Goals
- Build something useful
`;
const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

function makeTmpRoot(prefix = 'cc-orch-park-cleanup-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// A real git repo whose harness dirs are gitignored (so queue/ writes do not
// themselves become WIP that the snapshot would capture).
function makeGitRoot(prefix = 'cc-orch-park-cleanup-git-') {
  const root = makeTmpRoot(prefix);
  git(root, 'init');
  git(root, 'config user.email "test@example.com"');
  git(root, 'config user.name "Test User"');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed content\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'queue/\narchives/\n.harness/\n');
  git(root, 'add -A');
  git(root, 'commit -m init');
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function refExists(root, slug) {
  try {
    git(root, `rev-parse --verify refs/park/${slug}`);
    return true;
  } catch {
    return false;
  }
}

// Spec-pinned park scene carrying a snapshot reference.
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

function createQueueEntry(root, slug, status) {
  writeQueueEntry(root, slug, {
    spec: SPEC_MD,
    plan: { milestones: [], assumptions: [] },
    validatedAt: new Date().toISOString(),
    status,
    specJson: SPEC_JSON,
  });
}

function runCli(root, args) {
  const res = spawnSync('node', [CLI_PATH, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', out: `${res.stdout || ''}\n${res.stderr || ''}` };
}

// Make a dirty tree, snapshot it (this also creates refs/park/<slug>).
function snapshotWip(root, slug) {
  fs.writeFileSync(path.join(root, 'seed.txt'), `seed content\nWIP for ${slug}\n`);
  fs.writeFileSync(path.join(root, `new-${slug}.js`), `untracked for ${slug}\n`);
  return createParkSnapshot(slug, root);
}

// ── AC4.1 (primitive): cleanupParkSnapshot drops the ref and is idempotent ──

await test('AC4: cleanupParkSnapshot drops refs/park/<slug>, and a second call (ref already gone) does not throw', async () => {
  const root = makeGitRoot();
  try {
    const snap = snapshotWip(root, 'cl-prim');
    assert.ok(snap, 'fixture: createParkSnapshot must produce a snapshot for a dirty tree');
    assert.ok(refExists(root, 'cl-prim'), 'fixture: refs/park/cl-prim must exist after createParkSnapshot');

    cleanupParkSnapshot('cl-prim', root);
    assert.ok(!refExists(root, 'cl-prim'),
      'cleanupParkSnapshot must drop refs/park/<slug>');

    // Idempotent: calling again when the ref is already gone must not throw.
    assert.doesNotThrow(() => cleanupParkSnapshot('cl-prim', root),
      'cleanupParkSnapshot must be idempotent — a second call (ref already gone) must not throw');

    // Idempotent even for a slug that never had a ref.
    assert.doesNotThrow(() => cleanupParkSnapshot('never-existed', root),
      'cleanupParkSnapshot on a never-created ref must not throw');
  } finally {
    cleanup(root);
  }
});

// ── AC4.2 (end-to-end): --requeue leaves no orphaned ref ────────────────────

await test('AC4: park resolve --requeue removes refs/park/<slug> after a successful re-attach (no orphaned ref)', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'cl-rq', 'halted-review');
    const snap = snapshotWip(root, 'cl-rq');
    writeScene(root, 'cl-rq', makeSnapshotScene(snap));
    assert.ok(refExists(root, 'cl-rq'), 'fixture: refs/park/cl-rq must exist before resolve');

    const res = runCli(root, ['park', 'resolve', 'cl-rq', '--requeue']);
    assert.strictEqual(res.status, 0,
      `resolve --requeue must succeed (got exit ${res.status}; output: ${res.out.trim().slice(0, 400)})`);

    assert.ok(!refExists(root, 'cl-rq'),
      'a successful requeue re-attach must clean up refs/park/<slug> — no orphaned park ref may remain');
  } finally {
    cleanup(root);
  }
});

// ── AC4.3 (end-to-end): --reject leaves no orphaned ref (no reattach) ───────

await test('AC4: park resolve --reject removes refs/park/<slug> without reattaching the WIP', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'cl-rj', 'halted-review');
    const snap = snapshotWip(root, 'cl-rj');
    writeScene(root, 'cl-rj', makeSnapshotScene(snap));
    assert.ok(refExists(root, 'cl-rj'), 'fixture: refs/park/cl-rj must exist before resolve');

    const res = runCli(root, ['park', 'resolve', 'cl-rj', '--reject']);
    assert.strictEqual(res.status, 0,
      `resolve --reject must succeed (got exit ${res.status}; output: ${res.out.trim().slice(0, 400)})`);

    assert.ok(!refExists(root, 'cl-rj'),
      'a --reject resolution must clean up refs/park/<slug> (the work is discarded — no orphaned park ref)');
    // --reject does NOT reattach: the tree stays clean.
    assert.strictEqual(git(root, 'status --porcelain').trim(), '',
      'a --reject resolution must NOT reattach the WIP to the working tree');
  } finally {
    cleanup(root);
  }
});

// ── AC4.4 (end-to-end): --waive leaves no orphaned ref (no reattach) ────────
// --waive is only legal on an assumption-gate park (parked), not on
// halted-review/halted-analyzer. The snapshot legs are the resolvable-park
// halts; an assumption-gate park may also carry a snapshot, so a waived
// resolution must drop the ref too.

await test('AC4: park resolve --waive removes refs/park/<slug> without reattaching the WIP', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'cl-wv', 'parked');
    const snap = snapshotWip(root, 'cl-wv');
    writeScene(root, 'cl-wv', makeSnapshotScene(snap, { site: 'assumption-gate' }));
    assert.ok(refExists(root, 'cl-wv'), 'fixture: refs/park/cl-wv must exist before resolve');

    const res = runCli(root, ['park', 'resolve', 'cl-wv', '--waive']);
    assert.strictEqual(res.status, 0,
      `resolve --waive must succeed on a parked entry (got exit ${res.status}; output: ${res.out.trim().slice(0, 400)})`);

    assert.ok(!refExists(root, 'cl-wv'),
      'a --waive resolution must clean up refs/park/<slug> (no orphaned park ref)');
    assert.strictEqual(git(root, 'status --porcelain').trim(), '',
      'a --waive resolution must NOT reattach the WIP to the working tree');
  } finally {
    cleanup(root);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
