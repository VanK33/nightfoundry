#!/usr/bin/env node

/**
 * test-read-task-status-guard.js — Unit tests for the 4-segment guard in readTaskStatus.
 *
 * No external test framework.  Run: node test/test-read-task-status-guard.js
 *
 * Covers:
 *   TC-RTS-1 — readTaskStatus with 3-segment id throws
 *   TC-RTS-2 — readTaskStatus with 5-segment id throws
 *   TC-RTS-3 — readTaskStatus with valid 4-segment id does not throw (returns null for missing state file)
 *   TC-RTS-4 — readTaskStatus with valid -rp-NNN replan-suffixed id does not throw (Defect #16)
 *   TC-RTS-5 — readTaskStatus with malformed -rp-X (non-numeric N) throws
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { readTaskStatus } from '../src/orchestrator/core/state.js';

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function main() {
  let passed = 0;
  let failed = 0;

  function run(name, fn) {
    try {
      fn();
      console.log(`  PASS  ${name}`);
      passed++;
    } catch (err) {
      console.log(`  FAIL  ${name}: ${err.message}`);
      failed++;
    }
  }

  // TC-RTS-1: 3-segment id throws
  run('TC-RTS-1: 3-segment id throws', () => {
    let threw = false;
    let msg = '';
    try {
      readTaskStatus('/nonexistent', '001-001-001');
    } catch (err) {
      threw = true;
      msg = err.message;
    }
    assert(threw, 'expected readTaskStatus to throw for 3-segment id');
    assert(msg.includes('001-001-001'), `error message should include invalid taskId, got: ${msg}`);
    assert(msg.includes('4'), `error message should mention 4 segments, got: ${msg}`);
  });

  // TC-RTS-2: 5-segment id throws
  run('TC-RTS-2: 5-segment id throws', () => {
    let threw = false;
    let msg = '';
    try {
      readTaskStatus('/nonexistent', '001-001-001-001-001');
    } catch (err) {
      threw = true;
      msg = err.message;
    }
    assert(threw, 'expected readTaskStatus to throw for 5-segment id');
    assert(msg.includes('001-001-001-001-001'), `error message should include invalid taskId, got: ${msg}`);
    assert(msg.includes('4'), `error message should mention 4 segments, got: ${msg}`);
  });

  // TC-RTS-3: valid 4-segment id does not throw; returns null (no state file)
  run('TC-RTS-3: valid 4-segment id does not throw', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-test-'));
    try {
      // No state file exists, so result should be null
      const result = readTaskStatus(tmpDir, '001-001-001-001');
      assert(result === null, `expected null for missing state file, got: ${result}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // TC-RTS-4: valid -rp-NNN replan suffix does not throw (Defect #16 fix)
  // dogfood-20 / commit 1bc9265 introduced replanned-task IDs of the form
  // {originalId}-rp-NNN. v0.1.31's strict 4-segment check unintentionally
  // rejected them; this test guards the regression sentinel.
  run('TC-RTS-4: valid -rp-NNN replan-suffixed id does not throw', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-test-'));
    try {
      const result = readTaskStatus(tmpDir, '001-003-001-001-rp-001');
      assert(result === null, `expected null for missing state file, got: ${result}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // TC-RTS-5: malformed -rp- suffix (non-numeric N). Strip regex requires
  // numeric N, so "-rp-abc" doesn't match — leaving 6 segments → throws.
  run('TC-RTS-5: malformed -rp-X (non-numeric N) throws', () => {
    let threw = false;
    let msg = '';
    try {
      readTaskStatus('/nonexistent', '001-001-001-001-rp-abc');
    } catch (err) {
      threw = true;
      msg = err.message;
    }
    assert(threw, 'expected throw for non-numeric replan-suffix');
    assert(msg.includes('001-001-001-001-rp-abc'),
      `error message should include invalid taskId, got: ${msg}`);
  });

  // TC-RTS-6: non-numeric 4-segment id (test fixture style) does NOT throw.
  // v0.1.31's check was parts.length !== 4 (segment count only, no format
  // enforcement). Format-level enforcement belongs in _schemas.js for
  // planner-emitted IDs; readTaskStatus accepts any 4-segment ID so test
  // fixtures using ids like "001-001-001-cost1" continue to work.
  run('TC-RTS-6: non-numeric 4-segment id does not throw', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-test-'));
    try {
      const result = readTaskStatus(tmpDir, '001-001-001-cost1');
      assert(result === null, `expected null for missing state file, got: ${result}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // TC-RTS-7: double replan suffix (replan of a replan) does not throw.
  // Sibling helpers (scheduler.js ~696, pipeline.js ~2865) already use
  // /(-rp-\d+)+$/ to strip multi-level rp chains; readTaskStatus was the
  // lone single-strip outlier. retry-cap (3) makes -rp-N-rp-N legitimate.
  run('TC-RTS-7: double -rp- suffix does not throw', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-test-'));
    try {
      const result = readTaskStatus(tmpDir, '001-002-001-004-rp-001-rp-001');
      assert(result === null, `expected null for missing state file, got: ${result}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
