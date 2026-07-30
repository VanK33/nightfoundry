#!/usr/bin/env node

/**
 * test-queue-retry.js — Unit tests for queueRetry (src/cli/commands/queue.js).
 *
 * Hermetic: builds queue entries under fs.mkdtemp roots and calls queueRetry
 * directly. Never imports or reaches the real SDK.
 *
 * No external test framework. Run: node test/test-queue-retry.js
 *
 * Covers:
 *   TC1 — RESET: 'failed-execution' → 'pending' with a resume --batch confirmation
 *   TC2 — TC1's before/after directory snapshot differs only in the status file
 *   TC3 — NO-OP: already-'pending' entry unchanged, friendly message
 *   TC4 — UNKNOWN: unknown slug → not-found error, no directory created
 *   TC5 — DAMAGED: refused with a 'queue remove' hint, status file unchanged
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { queueRetry } from '../src/cli/commands/queue.js';
import { writeQueueEntry } from '../src/orchestrator/core/state.js';

function main() {
  let passed = 0;
  let failed = 0;

  function assert(label, condition) {
    if (condition) {
      console.log(`  [PASS] ${label}`);
      passed++;
    } else {
      console.log(`  [FAIL] ${label}`);
      failed++;
    }
  }

  /**
   * Capture console.log/console.error output from a callback, restoring the
   * original functions afterward (even if fn throws).
   * @param {Function} fn
   * @returns {{ stdout: string[], stderr: string[] }}
   */
  function captureOutput(fn) {
    const stdout = [];
    const stderr = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => stdout.push(args.map(String).join(' '));
    console.error = (...args) => stderr.push(args.map(String).join(' '));
    try {
      fn();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    return { stdout, stderr };
  }

  /**
   * Snapshot every file directly inside a directory as { name: content }.
   * Returns {} if the directory does not exist.
   * @param {string} dir
   */
  function snapshotDir(dir) {
    if (!fs.existsSync(dir)) return {};
    const out = {};
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isFile()) {
        out[name] = fs.readFileSync(full, 'utf8');
      }
    }
    return out;
  }

  console.log('=== queueRetry Tests ===\n');

  // ── TC1: RESET — 'failed-execution' → 'pending' with resume --batch confirmation
  console.log('TC1: RESET — failed-execution -> pending with resume --batch confirmation');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-queue-retry-tc1-'));
    const slug = 'project-reset';
    writeQueueEntry(tmpDir, slug, {
      spec: '# Reset spec',
      plan: { tasks: [] },
      validatedAt: '2026-04-01T10:00:00.000Z',
      status: 'failed-execution',
    });

    const entryDir = path.join(tmpDir, 'queue', slug);
    const before = snapshotDir(entryDir);

    const { stdout } = captureOutput(() => queueRetry(tmpDir, slug));

    const after = snapshotDir(entryDir);

    const statusPath = path.join(entryDir, 'status');
    const statusContent = fs.readFileSync(statusPath, 'utf8').trim();
    assert('TC1: status file now reads pending', statusContent === 'pending');

    const allOutput = stdout.join('\n');
    assert(
      'TC1: confirmation mentions resume --batch',
      allOutput.includes('resume --batch')
    );

    // ── TC2 (snapshot diff): the ONLY difference between before/after is `status` ──
    const beforeKeys = Object.keys(before).sort();
    const afterKeys = Object.keys(after).sort();
    assert(
      'TC2: same set of files before/after (no files added/removed)',
      JSON.stringify(beforeKeys) === JSON.stringify(afterKeys)
    );

    const changedFiles = afterKeys.filter((name) => before[name] !== after[name]);
    assert(
      'TC2: only the status file differs between before/after snapshots',
      changedFiles.length === 1 && changedFiles[0] === 'status'
    );
    assert(
      'TC2: non-status files (spec.md, plan.json, validated-at.json) are byte-identical',
      afterKeys
        .filter((name) => name !== 'status')
        .every((name) => before[name] === after[name])
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── TC3: NO-OP — already-pending entry unchanged, friendly message ──────────
  console.log('\nTC3: NO-OP — already-pending entry unchanged, friendly message');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-queue-retry-tc3-'));
    const slug = 'project-noop';
    writeQueueEntry(tmpDir, slug, {
      spec: '# Noop spec',
      plan: { tasks: [] },
      validatedAt: '2026-04-02T10:00:00.000Z',
      status: 'pending',
    });

    const entryDir = path.join(tmpDir, 'queue', slug);
    const before = snapshotDir(entryDir);

    const { stdout, stderr } = captureOutput(() => queueRetry(tmpDir, slug));

    const after = snapshotDir(entryDir);

    assert(
      'TC3: entry directory unchanged (no file content differs)',
      JSON.stringify(before) === JSON.stringify(after)
    );

    const statusContent = fs.readFileSync(path.join(entryDir, 'status'), 'utf8').trim();
    assert('TC3: status remains pending', statusContent === 'pending');

    const allOutput = stdout.join('\n');
    assert(
      'TC3: friendly already-pending message printed',
      allOutput.toLowerCase().includes('already') && allOutput.toLowerCase().includes('pending')
    );
    assert('TC3: no error output', stderr.length === 0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── TC4: UNKNOWN — unknown slug -> not-found error, no directory created ────
  console.log('\nTC4: UNKNOWN — unknown slug -> not-found error, no directory created');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-queue-retry-tc4-'));
    const slug = 'does-not-exist';
    const entryDir = path.join(tmpDir, 'queue', slug);

    assert('TC4: entry directory does not exist before call', !fs.existsSync(entryDir));

    const { stdout, stderr } = captureOutput(() => queueRetry(tmpDir, slug));

    assert('TC4: entry directory still does not exist after call', !fs.existsSync(entryDir));

    const allErrors = stderr.join('\n');
    assert(
      'TC4: not-found error mentions the slug',
      allErrors.includes(slug) && allErrors.toLowerCase().includes('not found')
    );
    assert('TC4: no success message printed', stdout.length === 0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── TC5: DAMAGED — refused with a 'queue remove' hint, status file unchanged ─
  console.log('\nTC5: DAMAGED — refused with a "queue remove" hint, status file unchanged');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-queue-retry-tc5-'));
    const slug = 'project-damaged';
    writeQueueEntry(tmpDir, slug, {
      spec: '# Damaged spec',
      plan: { tasks: [] },
      validatedAt: '2026-04-03T10:00:00.000Z',
      status: 'failed-execution',
    });

    const entryDir = path.join(tmpDir, 'queue', slug);
    // Damage the entry by deleting spec.md so readQueueEntry throws.
    fs.rmSync(path.join(entryDir, 'spec.md'));

    const statusBefore = fs.readFileSync(path.join(entryDir, 'status'), 'utf8');

    const { stdout, stderr } = captureOutput(() => queueRetry(tmpDir, slug));

    const statusAfter = fs.readFileSync(path.join(entryDir, 'status'), 'utf8');

    assert('TC5: status file content unchanged', statusBefore === statusAfter);

    const allErrors = stderr.join('\n');
    assert(
      'TC5: refusal message contains a "queue remove" hint',
      allErrors.includes('queue remove')
    );
    assert('TC5: no success message printed', stdout.length === 0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  // queueRetry sets process.exitCode = 1 on its UNKNOWN/DAMAGED refusal paths
  // (TC4, TC5) as a side effect of the real CLI behavior under test. That is
  // correct CLI behavior but must not leak into this suite's own pass/fail
  // exit code — reset it here based on the suite's actual assertion tally.
  process.exitCode = 0;

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
