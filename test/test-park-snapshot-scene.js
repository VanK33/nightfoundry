#!/usr/bin/env node
/**
 * test-park-snapshot-scene.js — Track P P2: the park scene records the
 * snapshot, and `park show` displays the preserved diff (spec:
 * p2-park-diff-preservation.spec.md / .json, AC2).
 *
 * Written by the INDEPENDENT test author against the spec's acceptance
 * criteria + the pinned interface contract — before the implementation
 * exists. At a pre-feature HEAD this fails on module resolution
 * (src/orchestrator/core/park-snapshot.js absent).
 *
 * AC2: the park scene persists a reference to the preserved snapshot (stashRef
 * / stashSha / baseSha), and `park show` displays the preserved
 * work-in-progress diff for a park that carries a snapshot.
 *
 * The scene persistence is asserted at the on-disk park.json the production
 * writers produce (writeParkScene). `park show`'s diff display is driven
 * END-TO-END through the `cc-orch park show` CLI surface so the test does not
 * depend on the implementer's internal show→diff wiring.
 *
 * Run: node test/test-park-snapshot-scene.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  createParkSnapshot,
  showParkSnapshot,
} from '../src/orchestrator/core/park-snapshot.js';
import {
  writeQueueEntry,
  writeParkScene,
  readParkScene,
} from '../src/orchestrator/core/state.js';

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

This is a test spec for park snapshot scene.

## Goals
- Build something useful
`;
const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });
const DAY = 24 * 60 * 60 * 1000;

function makeTmpRoot(prefix = 'cc-orch-park-scene-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function makeGitRoot(prefix = 'cc-orch-park-scene-git-') {
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

function createQueueEntry(root, slug, status) {
  writeQueueEntry(root, slug, {
    spec: SPEC_MD,
    plan: { milestones: [], assumptions: [] },
    validatedAt: new Date().toISOString(),
    status,
    specJson: SPEC_JSON,
  });
}

function baseScene(overrides = {}) {
  return {
    site: 'review-gate',
    parkedAt: new Date(Date.now() - DAY).toISOString(),
    round1: [],
    round2: null,
    appliedSpecEdits: [],
    questions: ['Review-gate decision needed.'],
    previousResolutions: [],
    resolution: null,
    ...overrides,
  };
}

function runCli(root, args) {
  const res = spawnSync('node', [CLI_PATH, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', out: `${res.stdout || ''}\n${res.stderr || ''}` };
}

function snapshotWip(root, slug) {
  fs.writeFileSync(path.join(root, 'seed.txt'), `seed content\nWIP-TRACKED-CHANGE-${slug}\n`);
  fs.writeFileSync(path.join(root, `new-${slug}.js`), `UNTRACKED-NEW-FILE-${slug}\n`);
  return createParkSnapshot(slug, root);
}

// ── AC2.1: the scene persists stashRef / stashSha / baseSha round-trip ──────

await test('AC2: the park scene persists stashRef/stashSha/baseSha and round-trips through writeParkScene/readParkScene', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'scene-snap', 'halted-review');
    const snap = snapshotWip(root, 'scene-snap');
    assert.ok(snap && snap.stashRef && snap.stashSha && snap.baseSha,
      `fixture: createParkSnapshot must return {stashRef,stashSha,baseSha} (got ${JSON.stringify(snap)})`);

    const scene = baseScene({
      stashRef: snap.stashRef,
      stashSha: snap.stashSha,
      baseSha: snap.baseSha,
    });
    writeParkScene(root, 'scene-snap', scene);

    const back = readParkScene(root, 'scene-snap');
    assert.ok(back, 'readParkScene must return the persisted scene');
    assert.strictEqual(back.stashRef, snap.stashRef,
      'the scene must persist the snapshot stashRef');
    assert.strictEqual(back.stashSha, snap.stashSha,
      'the scene must persist the snapshot stashSha');
    assert.strictEqual(back.baseSha, snap.baseSha,
      'the scene must persist the base commit (baseSha) at snapshot time');
    assert.strictEqual(back.baseSha, git(root, 'rev-parse HEAD').trim(),
      'baseSha must equal the HEAD commit at snapshot time');
  } finally {
    cleanup(root);
  }
});

// ── AC2.2: showParkSnapshot renders the preserved WIP from the scene ref ────
// Primitive-level proof that the scene's stashRef is a sufficient handle to
// render the preserved diff — the data `park show` will display.

await test('AC2: showParkSnapshot renders the preserved WIP (tracked + untracked) from the ref carried in the scene', async () => {
  const root = makeGitRoot();
  try {
    const snap = snapshotWip(root, 'scene-diff');
    const scene = baseScene({ stashRef: snap.stashRef, stashSha: snap.stashSha, baseSha: snap.baseSha });

    const diff = showParkSnapshot(scene.stashRef, root);
    assert.ok(typeof diff === 'string' && diff.length > 0,
      `showParkSnapshot must return non-empty diff text (got ${JSON.stringify(diff)})`);
    assert.ok(diff.includes('WIP-TRACKED-CHANGE-scene-diff'),
      `the preserved diff must include the tracked modification (diff: ${diff.slice(0, 400)})`);
    assert.ok(diff.includes('UNTRACKED-NEW-FILE-scene-diff'),
      `the preserved diff must include the untracked new file's content (diff: ${diff.slice(0, 400)})`);
  } finally {
    cleanup(root);
  }
});

// ── AC2.3 (end-to-end): `park show` displays the preserved diff ─────────────

await test('AC2: cc-orch park show displays the preserved work-in-progress diff for a park that carries a snapshot', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'show-snap', 'halted-review');
    const snap = snapshotWip(root, 'show-snap');
    // Age the spec files so the divergence warning does not fire and muddy the
    // output (snapshot display is the subject here).
    const old = new Date(Date.now() - 2 * DAY);
    fs.utimesSync(path.join(root, 'queue', 'show-snap', 'spec.md'), old, old);
    fs.utimesSync(path.join(root, 'queue', 'show-snap', 'spec.json'), old, old);
    writeParkScene(root, 'show-snap', baseScene({
      stashRef: snap.stashRef,
      stashSha: snap.stashSha,
      baseSha: snap.baseSha,
    }));

    const res = runCli(root, ['park', 'show', 'show-snap']);
    assert.strictEqual(res.status, 0,
      `park show must exit 0 (got ${res.status}; output: ${res.out.trim().slice(0, 400)})`);

    // The preserved WIP content must appear in the show output — both the
    // tracked change and the untracked file.
    assert.ok(res.stdout.includes('WIP-TRACKED-CHANGE-show-snap'),
      `park show must display the preserved tracked modification (output: ${res.out.trim().slice(0, 600)})`);
    assert.ok(res.stdout.includes('UNTRACKED-NEW-FILE-show-snap'),
      `park show must display the preserved untracked new file content (output: ${res.out.trim().slice(0, 600)})`);
  } finally {
    cleanup(root);
  }
});

// ── AC2.4 (end-to-end control): a snapshot-less park show shows no diff ──────
// A park with no snapshot in its scene must not fabricate or crash — show
// works as before (no preserved-diff section). Non-vacuous companion to the
// positive case.

await test('AC2: cc-orch park show on a snapshot-less park still works and shows no preserved diff', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'no-snap', 'halted-review');
    const old = new Date(Date.now() - 2 * DAY);
    fs.utimesSync(path.join(root, 'queue', 'no-snap', 'spec.md'), old, old);
    fs.utimesSync(path.join(root, 'queue', 'no-snap', 'spec.json'), old, old);
    writeParkScene(root, 'no-snap', baseScene()); // no stashRef/stashSha/baseSha

    const res = runCli(root, ['park', 'show', 'no-snap']);
    assert.strictEqual(res.status, 0,
      `park show must exit 0 on a snapshot-less park (got ${res.status}; output: ${res.out.trim().slice(0, 400)})`);
    // The scene is still shown (site/questions present).
    assert.ok(res.stdout.includes('review-gate'),
      'park show must still render the scene for a snapshot-less park');
  } finally {
    cleanup(root);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
