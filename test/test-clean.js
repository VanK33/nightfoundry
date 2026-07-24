#!/usr/bin/env node

/**
 * test-clean.js — Tests for the `clean` CLI command.
 *
 * TC1 — no .harness/ → prints 'Nothing to clean.' and returns
 * TC2 — .harness/ with all complete milestones → prompts, removes on 'y'
 * TC3 — .harness/ with active (in_progress) milestones → warns, offers archive-first
 * TC4 — --force flag → skips all confirmations, deletes immediately
 * TC5 — user answers 'n' to confirmation → .harness/ is preserved
 * TC6 — archive-first flow: user says 'y' to archive prompt, then .harness/ is removed
 *
 * Run: node test/test-clean.js
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { PassThrough } from 'stream';

async function main() {
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

  console.log('=== Clean Command Tests ===\n');

  // ─────────────────────────────────────────────────────────────
  // Import
  // ─────────────────────────────────────────────────────────────

  const { clean } = await import('../src/cli/commands/clean.js');

  // ─────────────────────────────────────────────────────────────
  // Fixture helpers
  // ─────────────────────────────────────────────────────────────

  function makeTmpDir(prefix = 'cc-orch-clean-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }

  function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Create a .harness/ directory with a state.json containing the given
   * milestone map.  Returns the absolute path of the harness dir.
   */
  function makeHarness(tmpDir, milestones) {
    const harnessDir = path.join(tmpDir, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    fs.writeFileSync(
      path.join(harnessDir, 'state.json'),
      JSON.stringify({ milestones }, null, 2),
      'utf8'
    );
    return harnessDir;
  }

  // Canned states
  const completeState = {
    '001': { id: '001', description: 'Init', status: 'complete' },
  };

  const activeState = {
    '001': { id: '001', description: 'Init', status: 'in_progress' },
  };

  // ─────────────────────────────────────────────────────────────
  // I/O mocking helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Create a PassThrough stream pre-loaded with newline-terminated responses.
   * All bytes are written synchronously before readline attaches, so the
   * data is in the buffer ready to be consumed on demand.
   */
  function createMockStdin(...responses) {
    const stream = new PassThrough();
    for (const r of responses) {
      stream.write(r + '\n');
    }
    stream.end();
    return stream;
  }

  /**
   * Temporarily replace process.stdin with a mock that yields `responses`
   * (one per readline question) and capture all process.stdout output that
   * occurs during `fn`.  Returns the captured output string.
   *
   * Restores both streams in a finally block so failures don't poison later tests.
   */
  async function runClean(tmpDir, flags, responses = []) {
    // Save the original process.stdin descriptor (it's a getter-only property).
    const origStdinDesc = Object.getOwnPropertyDescriptor(process, 'stdin');
    const mockStdin = responses.length > 0 ? createMockStdin(...responses) : null;

    // Capture stdout (console.log routes through process.stdout.write).
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, enc, cb) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      // honour callbacks so callers don't block
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      return true;
    };

    if (mockStdin) {
      // Replace the getter-only process.stdin with our mock stream.
      Object.defineProperty(process, 'stdin', {
        value: mockStdin,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }

    try {
      await clean(tmpDir, flags);
    } finally {
      process.stdout.write = origWrite;
      if (mockStdin && origStdinDesc) {
        Object.defineProperty(process, 'stdin', origStdinDesc);
      }
    }

    return chunks.join('');
  }

  // ─────────────────────────────────────────────────────────────
  // TC1: no .harness/ → prints 'Nothing to clean.' and returns
  // ─────────────────────────────────────────────────────────────

  console.log('TC1: no .harness/ → prints "Nothing to clean." and returns\n');

  {
    const tmpDir = makeTmpDir();

    let output = '';
    let threw = false;
    try {
      output = await runClean(tmpDir, {});
    } catch (err) {
      threw = true;
      console.log(`  [FAIL] Unexpected error: ${err.message}`);
      failed++;
    }

    if (!threw) {
      assert('TC1a: .harness/ does not exist (nothing to clean)', !fs.existsSync(path.join(tmpDir, '.harness')));
      assert('TC1b: output contains "Nothing to clean."', output.includes('Nothing to clean.'));
    }

    cleanup(tmpDir);
  }

  // ─────────────────────────────────────────────────────────────
  // TC2: complete milestones, user says 'y' → .harness/ removed
  // ─────────────────────────────────────────────────────────────

  console.log('\nTC2: complete milestones + "y" → .harness/ removed\n');

  {
    const tmpDir = makeTmpDir();
    const harnessDir = makeHarness(tmpDir, completeState);

    let output = '';
    let threw = false;
    try {
      output = await runClean(tmpDir, {}, ['y']);
    } catch (err) {
      threw = true;
      console.log(`  [FAIL] Unexpected error: ${err.message}`);
      failed++;
    }

    if (!threw) {
      assert('TC2a: .harness/ was removed', !fs.existsSync(harnessDir));
      assert('TC2b: output contains "Removed .harness/"', output.includes('Removed .harness/'));
    }

    cleanup(tmpDir);
  }

  // ─────────────────────────────────────────────────────────────
  // TC3: active milestones → warns and offers archive-first
  // ─────────────────────────────────────────────────────────────

  console.log('\nTC3: active milestones → warning shown, archive-first offered\n');

  {
    const tmpDir = makeTmpDir();
    const harnessDir = makeHarness(tmpDir, activeState);

    // Answer 'n' to "Archive first?" then 'n' to "Really remove?" → aborted
    let output = '';
    let threw = false;
    try {
      output = await runClean(tmpDir, {}, ['n', 'n']);
    } catch (err) {
      threw = true;
      console.log(`  [FAIL] Unexpected error: ${err.message}`);
      failed++;
    }

    if (!threw) {
      assert('TC3a: .harness/ is still present (aborted)', fs.existsSync(harnessDir));
      assert(
        'TC3b: output contains active-milestone warning',
        output.includes('active milestone') || output.includes('Warning')
      );
      assert(
        'TC3c: output mentions archive-first option',
        output.includes('Archive first') || output.includes('archive')
      );
    }

    cleanup(tmpDir);
  }

  // ─────────────────────────────────────────────────────────────
  // TC4: --force flag → skips all confirmations, deletes immediately
  // ─────────────────────────────────────────────────────────────

  console.log('\nTC4: --force flag → deletes without any prompt\n');

  {
    // Use active milestones — without --force this would normally prompt twice
    const tmpDir = makeTmpDir();
    const harnessDir = makeHarness(tmpDir, activeState);

    // No mock stdin: if readline were invoked it would hang / throw
    let output = '';
    let threw = false;
    try {
      output = await runClean(tmpDir, { force: true });
    } catch (err) {
      threw = true;
      console.log(`  [FAIL] Unexpected error: ${err.message}`);
      failed++;
    }

    if (!threw) {
      assert('TC4a: .harness/ was removed', !fs.existsSync(harnessDir));
      assert(
        'TC4b: output mentions --force or skipping',
        output.includes('--force') || output.includes('force') || output.includes('skipping')
      );
    }

    cleanup(tmpDir);
  }

  // ─────────────────────────────────────────────────────────────
  // TC5: user answers 'n' → .harness/ is preserved
  // ─────────────────────────────────────────────────────────────

  console.log('\nTC5: user answers "n" to removal prompt → .harness/ preserved\n');

  {
    const tmpDir = makeTmpDir();
    const harnessDir = makeHarness(tmpDir, completeState);

    let output = '';
    let threw = false;
    try {
      output = await runClean(tmpDir, {}, ['n']);
    } catch (err) {
      threw = true;
      console.log(`  [FAIL] Unexpected error: ${err.message}`);
      failed++;
    }

    if (!threw) {
      assert('TC5a: .harness/ is still present', fs.existsSync(harnessDir));
      assert('TC5b: output contains "Aborted."', output.includes('Aborted.'));
    }

    cleanup(tmpDir);
  }

  // ─────────────────────────────────────────────────────────────
  // TC6: archive-first flow — user says 'y', .harness/ removed
  // ─────────────────────────────────────────────────────────────

  console.log('\nTC6: archive-first flow ("y") → .harness/ removed after archive\n');

  {
    const tmpDir = makeTmpDir();
    const harnessDir = makeHarness(tmpDir, activeState);

    // We pass flags.auto=true so that archive() skips its own "Archive anyway?"
    // confirmation (milestones are still in_progress).  The only stdin response
    // needed is 'y' for clean.js's "Archive first?" prompt.
    let output = '';
    let threw = false;
    try {
      output = await runClean(tmpDir, { auto: true }, ['y']);
    } catch (err) {
      threw = true;
      console.log(`  [FAIL] Unexpected error: ${err.message}`);
      failed++;
    }

    if (!threw) {
      assert('TC6a: .harness/ was removed after archive-first flow', !fs.existsSync(harnessDir));
      assert('TC6b: output contains "Removed .harness/"', output.includes('Removed .harness/'));
    }

    cleanup(tmpDir);
  }

  // ─────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
