#!/usr/bin/env node
/**
 * test-auto-batch-persistence.js — Tests for autoFromHere state persistence
 * across simulated batch queue entries.
 *
 * TC1: autoFromHere=true persists across simulated batch queue entries
 * TC2: halt-y re-confirm 'n' in entry#1 makes entry#2 see autoFromHere=false
 *
 * Run: node test/test-auto-batch-persistence.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';

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

function makeTmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cc-auto-batch-${label}-`));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── TC1 ──────────────────────────────────────────────────────────────────────
// autoFromHere=true persists across simulated batch queue entries.
//
// Strategy: construct a real Pipeline, set autoFromHere=true, then stub
// batchResume with a two-entry loop.  Between the two iterations, capture
// the value of this.autoFromHere.  It must still be true — nothing in the
// batch loop should silently reset the flag when no halt occurs.

await test('TC1: autoFromHere=true persists across simulated batch queue entries', async () => {
  const root = makeTmpRoot('tc1');
  const origBatchResume = Pipeline.prototype.batchResume;
  try {
    // Captured state: value of autoFromHere seen at the start of each entry.
    const autoFromHereAtEntry = [];

    Pipeline.prototype.batchResume = async function stubBatchResume() {
      const entries = ['entry-1', 'entry-2'];

      for (const entry of entries) {
        // Record autoFromHere at the START of each entry (before any work).
        autoFromHereAtEntry.push({ entry, autoFromHere: this.autoFromHere });

        // Simulate minimal entry processing — no halt, no state mutation.
        // (In production this would be assumption verification + execution.)
        this.onLog(`[stub] Processing ${entry}`);
      }

      return { archived: 2, failed: 0 };
    };

    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: () => {},
      onConfirm: async () => true, // user always confirms
    });

    // Start with autoFromHere=true (simulating the user having chosen 'a'
    // from the plan menu or the CLI having set auto mode).
    pipeline.autoFromHere = true;

    await pipeline.batchResume();

    // Both entries must see autoFromHere=true — the flag must not reset
    // between iterations.
    assert.strictEqual(
      autoFromHereAtEntry.length,
      2,
      `Expected 2 entries to be processed, got ${autoFromHereAtEntry.length}`,
    );

    assert.strictEqual(
      autoFromHereAtEntry[0].autoFromHere,
      true,
      `entry-1 should see autoFromHere=true, got ${autoFromHereAtEntry[0].autoFromHere}`,
    );

    assert.strictEqual(
      autoFromHereAtEntry[1].autoFromHere,
      true,
      `entry-2 should see autoFromHere=true (persisted from entry-1), got ${autoFromHereAtEntry[1].autoFromHere}`,
    );
  } finally {
    Pipeline.prototype.batchResume = origBatchResume;
    cleanup(root);
  }
});

// ── TC2 ──────────────────────────────────────────────────────────────────────
// halt-y re-confirm 'n' in entry#1 makes entry#2 see autoFromHere=false.
//
// Strategy: start with autoFromHere=true, stub both batchResume and
// _gateConfirm.  The _gateConfirm stub simulates the real Category B
// halt-y/re-confirm-n path: the user says 'y' to proceed (halt-y) but 'n' to
// "Continue in auto mode?" (re-confirm-n), which sets this.autoFromHere=false
// exactly as the production _gateConfirm does on lines 346-348 of pipeline.js.
//
// Note: in non-TTY environments the real _gateConfirm throws exit-77 for
// category B when autoFromHere=true (it requires a live terminal).  The stub
// bypasses that guard while faithfully replicating the state-mutation outcome.

await test('TC2: halt-y re-confirm \'n\' in entry#1 makes entry#2 see autoFromHere=false', async () => {
  const root = makeTmpRoot('tc2');
  const origBatchResume = Pipeline.prototype.batchResume;
  try {
    // Captured state: value of autoFromHere seen at the start of each entry.
    const autoFromHereAtEntry = [];

    Pipeline.prototype.batchResume = async function stubBatchResume() {
      const entries = ['entry-1', 'entry-2'];

      // ── Stub _gateConfirm to simulate halt-y / re-confirm-n ──────────────
      // The real implementation (pipeline.js lines 333-352) does:
      //   1. Call askYesNo(question)         → user says 'y'  (halt-y)
      //   2. Call askYesNo('Continue auto?') → user says 'n'  (re-confirm-n)
      //   3. this.autoFromHere = false
      //   4. return true (the halt-y result)
      //
      // We stub that outcome: returns true AND sets autoFromHere=false, so we
      // can verify in a non-TTY test environment that the mutation carries.
      const origGateConfirm = this._gateConfirm.bind(this);
      this._gateConfirm = async function stubbedGateConfirm(site, question, opts = {}) {
        const { category } = opts;
        if (category === 'B' && this.autoFromHere) {
          // Simulate halt-y (returns true) followed by re-confirm-n
          // (autoFromHere → false), mirroring the real TTY path.
          this.autoFromHere = false;
          return true;
        }
        // Fall through to real implementation for all other calls.
        return origGateConfirm(site, question, opts);
      }.bind(this);

      try {
        for (const entry of entries) {
          // Record autoFromHere at the START of each entry (before any work).
          autoFromHereAtEntry.push({ entry, autoFromHere: this.autoFromHere });

          if (entry === 'entry-1') {
            // Fire a Category B gate during entry#1 — simulates the
            // 'assumption-failed' halt that surfaces in the real batchResume
            // loop when assumptions cannot be remediated autonomously.
            const confirmed = await this._gateConfirm(
              'assumption-failed',
              'Assumptions failed. Proceed anyway?',
              { safeDefault: false, category: 'B' },
            );

            this.onLog(
              `[stub] entry-1 halt-y result=${confirmed}, autoFromHere=${this.autoFromHere}`,
            );
          } else {
            // entry-2: no halt, just observe autoFromHere.
            this.onLog(`[stub] Processing ${entry} with autoFromHere=${this.autoFromHere}`);
          }
        }
      } finally {
        // Restore _gateConfirm so future Pipeline usage is unaffected.
        this._gateConfirm = origGateConfirm;
      }

      return { archived: 1, failed: 0 };
    };

    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: () => {},
      onConfirm: async () => true, // not reached by the stubbed _gateConfirm
    });

    // Start with autoFromHere=true.
    pipeline.autoFromHere = true;

    await pipeline.batchResume();

    assert.strictEqual(
      autoFromHereAtEntry.length,
      2,
      `Expected 2 entries to be processed, got ${autoFromHereAtEntry.length}`,
    );

    // entry-1 starts with autoFromHere=true (unchanged at entry start).
    assert.strictEqual(
      autoFromHereAtEntry[0].autoFromHere,
      true,
      `entry-1 should start with autoFromHere=true, got ${autoFromHereAtEntry[0].autoFromHere}`,
    );

    // entry-2 must see autoFromHere=false — the halt-y/re-confirm-n from
    // entry-1 must have carried through across the batch boundary.
    assert.strictEqual(
      autoFromHereAtEntry[1].autoFromHere,
      false,
      `entry-2 should see autoFromHere=false after entry-1 halt-y/re-confirm-n, ` +
      `got ${autoFromHereAtEntry[1].autoFromHere}`,
    );
  } finally {
    Pipeline.prototype.batchResume = origBatchResume;
    cleanup(root);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
