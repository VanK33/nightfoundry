#!/usr/bin/env node
/**
 * test-clean-orphan-ref-no-harness.js — the orphan interrupt-ref reaper must run
 * even when .harness/ is ABSENT.
 *
 * Behavior under test (spec): `clean(projectRoot, flags)` must run its orphan
 * interrupt-ref reap pass BEFORE printing "Nothing to clean." and returning,
 * even on the no-.harness path. Reap semantics (unchanged):
 *   - refs/interrupt/<slug> with queue/<slug>/ PRESENT → LIVE → PRESERVED.
 *   - refs/interrupt/<slug> with queue/<slug>/ ABSENT  → ORPHAN → DROPPED, with
 *     a reap log line naming the ref.
 *   - refs/park/* is NEVER touched by clean, on any path.
 *   - non-git dir (or git unavailable) → silent no-op, no crash, still prints
 *     "Nothing to clean.".
 *
 * Every case here has .harness/ ABSENT.
 *
 * NC1 — orphan interrupt ref (no queue/<slug>/) → ref dropped, reap log names
 *       the ref, "Nothing to clean." printed.
 * NC2 — live interrupt ref (queue/<slug>/ with a status file) → ref preserved.
 * NC3 — non-git projectRoot → no throw, prints "Nothing to clean.".
 * NC4 — refs/park/<slug> with no queue entry → preserved (park untouchable).
 * NC5 — mixed: orphan + live + park → only the orphan is dropped.
 *
 * Run: node test/test-clean-orphan-ref-no-harness.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { clean } from '../src/cli/commands/clean.js';

let passCount = 0;
let failCount = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passCount++;
  } else {
    console.log(`  [FAIL] ${label}`);
    failCount++;
  }
}

// ── git + fixture helpers ─────────────────────────────────────────────────────

/** Run git with argv (no shell) in cwd; throws on non-zero exit. */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-clean-noharness-'));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** A temp dir initialised as a git repo with one commit (HEAD resolvable). */
function makeGitRoot() {
  const root = makeTmpRoot();
  git(['init', '-q'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'CC Test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  fs.writeFileSync(path.join(root, '.gitignore'), '.harness/\nqueue/\n');
  git(['add', '.gitignore'], root);
  git(['commit', '-q', '-m', 'init'], root);
  return root;
}

/** True when ref resolves to an object. */
function refExists(root, ref) {
  try {
    git(['rev-parse', '--verify', '--quiet', ref], root);
    return true;
  } catch {
    return false;
  }
}

/** Plant refs/interrupt/<slug> (or any ref) pointing at HEAD. */
function plantRef(root, ref) {
  git(['update-ref', ref, 'HEAD'], root);
}

/** Create a live queue/<slug>/ dir with a status file (marks the ref LIVE). */
function makeQueueEntry(root, slug) {
  const dir = path.join(root, 'queue', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status'), 'pending\n');
}

/**
 * Run clean(root, flags) while capturing everything console.log emits (clean's
 * user-facing output routes through console.log). Restores console.log in a
 * finally so a throw doesn't poison later tests. Returns { output, threw, err }.
 */
async function runClean(root, flags) {
  const chunks = [];
  const origLog = console.log;
  console.log = (...args) => { chunks.push(args.join(' ')); };
  let threw = false;
  let err = null;
  try {
    await clean(root, flags);
  } catch (e) {
    threw = true;
    err = e;
  } finally {
    console.log = origLog;
  }
  return { output: chunks.join('\n'), threw, err };
}

// Guard: .harness/ must be ABSENT for every fixture in this file.
function assertNoHarness(label, root) {
  assert(`${label}: fixture has NO .harness/`, !fs.existsSync(path.join(root, '.harness')));
}

async function main() {
  console.log('=== Clean orphan interrupt-ref reap (no .harness/) Tests ===\n');

  // ── NC1: orphan interrupt ref → reaped + reap log + "Nothing to clean." ──
  console.log('NC1: orphan interrupt ref (no queue entry) → dropped, logged\n');
  {
    const root = makeGitRoot();
    try {
      assertNoHarness('NC1', root);
      plantRef(root, 'refs/interrupt/orphan-slug');
      assert('NC1 fixture: ref planted', refExists(root, 'refs/interrupt/orphan-slug'));

      const { output, threw, err } = await runClean(root, { force: true });

      assert('NC1a: clean did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.message}`);
      assert('NC1b: orphan ref refs/interrupt/orphan-slug was dropped',
        !refExists(root, 'refs/interrupt/orphan-slug'));
      assert('NC1c: output has a reap log naming the ref',
        output.includes('orphan-slug'));
      assert('NC1d: output contains "Nothing to clean."',
        output.includes('Nothing to clean.'));
    } finally {
      cleanup(root);
    }
  }

  // ── NC2: live interrupt ref (queue entry present) → preserved ──
  console.log('\nNC2: live interrupt ref (queue/<slug>/status present) → preserved\n');
  {
    const root = makeGitRoot();
    try {
      assertNoHarness('NC2', root);
      makeQueueEntry(root, 'live-slug');
      plantRef(root, 'refs/interrupt/live-slug');
      assert('NC2 fixture: ref planted', refExists(root, 'refs/interrupt/live-slug'));

      const { threw, err } = await runClean(root, { force: true });

      assert('NC2a: clean did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.message}`);
      assert('NC2b: live interrupt ref (queue present) is PRESERVED',
        refExists(root, 'refs/interrupt/live-slug'));
    } finally {
      cleanup(root);
    }
  }

  // ── NC3: non-git projectRoot → no throw, still prints "Nothing to clean." ──
  console.log('\nNC3: non-git projectRoot → no crash, silent reap no-op\n');
  {
    const root = makeTmpRoot(); // NOT a git repo — no `git init`.
    try {
      assertNoHarness('NC3', root);
      assert('NC3 fixture: not a git repo', !fs.existsSync(path.join(root, '.git')));

      const { output, threw, err } = await runClean(root, { force: true });

      assert('NC3a: clean did not throw on a non-git dir', !threw);
      if (threw) console.log(`       error: ${err && err.message}`);
      assert('NC3b: output contains "Nothing to clean."',
        output.includes('Nothing to clean.'));
      assert('NC3c: no git repo was created as a side effect',
        !fs.existsSync(path.join(root, '.git')));
    } finally {
      cleanup(root);
    }
  }

  // ── NC4: refs/park/<slug> with no queue entry → preserved (untouchable) ──
  console.log('\nNC4: refs/park/<slug> (queue absent) → preserved (park namespace untouchable)\n');
  {
    const root = makeGitRoot();
    try {
      assertNoHarness('NC4', root);
      plantRef(root, 'refs/park/park-slug');
      assert('NC4 fixture: park ref planted', refExists(root, 'refs/park/park-slug'));

      const { threw, err } = await runClean(root, { force: true });

      assert('NC4a: clean did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.message}`);
      assert('NC4b: refs/park/park-slug is PRESERVED (never reaped by clean)',
        refExists(root, 'refs/park/park-slug'));
    } finally {
      cleanup(root);
    }
  }

  // ── NC5: mixed — orphan interrupt + live interrupt + park → only orphan drops ──
  console.log('\nNC5: mixed (orphan + live + park) → only the orphan interrupt ref is dropped\n');
  {
    const root = makeGitRoot();
    try {
      assertNoHarness('NC5', root);
      // orphan interrupt: no queue entry → must drop.
      plantRef(root, 'refs/interrupt/orphan-slug');
      // live interrupt: queue entry present → must preserve.
      makeQueueEntry(root, 'live-slug');
      plantRef(root, 'refs/interrupt/live-slug');
      // park ref: queue absent, but park namespace untouchable → must preserve.
      plantRef(root, 'refs/park/park-slug');

      const { output, threw, err } = await runClean(root, { force: true });

      assert('NC5a: clean did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.message}`);
      assert('NC5b: orphan interrupt ref dropped',
        !refExists(root, 'refs/interrupt/orphan-slug'));
      assert('NC5c: live interrupt ref preserved',
        refExists(root, 'refs/interrupt/live-slug'));
      assert('NC5d: park ref preserved (untouchable)',
        refExists(root, 'refs/park/park-slug'));
      assert('NC5e: reap log names the orphan ref',
        output.includes('orphan-slug'));
    } finally {
      cleanup(root);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
