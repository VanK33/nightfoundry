#!/usr/bin/env node

/**
 * test-queue-cli.js — Unit tests for the queue CLI commands.
 *
 * No external test framework.  Run: node test/test-queue-cli.js
 *
 * Covers:
 *   TC1 — queueList displays formatted table for 2 pending entries
 *   TC2 — queueList JSON output is valid and contains all entry fields
 *   TC3 — queueList shows empty message when no entries exist
 *   TC4 — queueRemove removes existing entry successfully
 *   TC5 — queueRemove handles non-existent slug gracefully
 *   TC6 — 'queue' is in KNOWN_COMMANDS
 *   TC7 — suggest('queu', KNOWN_COMMANDS) returns 'queue'
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { queueList, queueRemove } from '../src/cli/commands/queue.js';
import { writeQueueEntry } from '../src/orchestrator/core/state.js';
import { suggest, KNOWN_COMMANDS } from '../src/cli/suggest.js';

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
   * Capture console.log output from a callback.
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

  console.log('=== Queue CLI Tests ===\n');

  // ── TC1: queueList displays formatted table for 2 pending entries ──────────
  console.log('TC1: queueList displays formatted table for 2 pending entries');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-queue-tc1-'));
    writeQueueEntry(tmpDir, 'project-alpha', {
      spec: '# Alpha spec',
      plan: { tasks: [] },
      validatedAt: '2026-04-01T10:00:00.000Z',
      status: 'pending',
    });
    writeQueueEntry(tmpDir, 'project-beta', {
      spec: '# Beta spec',
      plan: { tasks: [] },
      validatedAt: '2026-04-02T10:00:00.000Z',
      status: 'pending',
    });

    const { stdout } = captureOutput(() => queueList(tmpDir));

    // Should have header line
    const headerLine = stdout.find((l) => l.includes('Name') && l.includes('Status'));
    assert('TC1: header line contains "Name" and "Status"', !!headerLine);

    // Should include both slugs
    const allOutput = stdout.join('\n');
    assert('TC1: output contains project-alpha', allOutput.includes('project-alpha'));
    assert('TC1: output contains project-beta', allOutput.includes('project-beta'));

    // Should have a separator line
    const separatorLine = stdout.find((l) => /^-+$/.test(l.trim()));
    assert('TC1: separator line present', !!separatorLine);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── TC2: queueList JSON output is valid and contains all entry fields ───────
  console.log('\nTC2: queueList JSON output is valid and contains all entry fields');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-queue-tc2-'));
    writeQueueEntry(tmpDir, 'project-gamma', {
      spec: '# Gamma spec',
      plan: { milestones: [{ id: '001', tasks: [] }] },
      validatedAt: '2026-04-03T12:00:00.000Z',
      status: 'pending',
    });

    const { stdout } = captureOutput(() => queueList(tmpDir, { json: true }));

    const raw = stdout.join('\n');
    let parsed;
    let parseOk = false;
    try {
      parsed = JSON.parse(raw);
      parseOk = true;
    } catch (_) {
      // fall through
    }
    assert('TC2: JSON output parses successfully', parseOk);
    assert('TC2: JSON output is an array', Array.isArray(parsed));
    assert('TC2: array has 1 entry', parsed && parsed.length === 1);

    const entry = parsed && parsed[0];
    assert('TC2: entry has slug field', entry && 'slug' in entry);
    assert('TC2: entry has spec field', entry && 'spec' in entry);
    assert('TC2: entry has plan field', entry && 'plan' in entry);
    assert('TC2: entry has validatedAt field', entry && 'validatedAt' in entry);
    assert('TC2: entry has status field', entry && 'status' in entry);
    assert('TC2: slug matches written slug', entry && entry.slug === 'project-gamma');
    assert('TC2: status matches written status', entry && entry.status === 'pending');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── TC3: queueList shows empty message when no entries exist ─────────────
  console.log('\nTC3: queueList shows empty message when no entries exist');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-queue-tc3-'));

    const { stdout } = captureOutput(() => queueList(tmpDir));

    const allOutput = stdout.join('\n');
    assert('TC3: output contains empty/queue message', allOutput.toLowerCase().includes('empty'));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── TC3 JSON variant: empty JSON array ────────────────────────────────────
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-queue-tc3j-'));

    const { stdout } = captureOutput(() => queueList(tmpDir, { json: true }));

    const raw = stdout.join('\n');
    let parsed;
    let parseOk = false;
    try {
      parsed = JSON.parse(raw);
      parseOk = true;
    } catch (_) {
      // fall through
    }
    assert('TC3 (json): empty JSON output parses successfully', parseOk);
    assert('TC3 (json): empty JSON output is an empty array', Array.isArray(parsed) && parsed.length === 0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── TC4: queueRemove removes existing entry successfully ──────────────────
  console.log('\nTC4: queueRemove removes existing entry successfully');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-queue-tc4-'));
    writeQueueEntry(tmpDir, 'project-delta', {
      spec: '# Delta spec',
      plan: {},
      validatedAt: '2026-04-04T09:00:00.000Z',
      status: 'pending',
    });

    const entryDir = path.join(tmpDir, 'queue', 'project-delta');
    assert('TC4: entry directory exists before remove', fs.existsSync(entryDir));

    const { stdout } = captureOutput(() => queueRemove(tmpDir, 'project-delta'));

    assert('TC4: entry directory removed', !fs.existsSync(entryDir));

    const allOutput = stdout.join('\n');
    assert('TC4: confirmation message printed', allOutput.includes('project-delta') && allOutput.toLowerCase().includes('remov'));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── TC5: queueRemove handles non-existent slug gracefully ─────────────────
  console.log('\nTC5: queueRemove handles non-existent slug gracefully');
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-queue-tc5-'));

    let threw = false;
    const { stderr } = captureOutput(() => {
      try {
        queueRemove(tmpDir, 'does-not-exist');
      } catch (_) {
        threw = true;
      }
    });

    assert('TC5: does not throw for missing slug', !threw);

    const allErrors = stderr.join('\n');
    assert('TC5: error message references missing slug', allErrors.includes('does-not-exist'));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── TC6: 'queue' is in KNOWN_COMMANDS ─────────────────────────────────────
  console.log('\nTC6: \'queue\' is in KNOWN_COMMANDS');
  {
    assert('TC6: KNOWN_COMMANDS includes "queue"', KNOWN_COMMANDS.includes('queue'));
  }

  // ── TC7: suggest('queu', KNOWN_COMMANDS) returns 'queue' ──────────────────
  console.log('\nTC7: suggest(\'queu\', KNOWN_COMMANDS) returns \'queue\'');
  {
    const suggestion = suggest('queu', KNOWN_COMMANDS);
    assert('TC7: suggest("queu", KNOWN_COMMANDS) === "queue"', suggestion === 'queue');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
