/**
 * test-progress-total-cache.js — Unit tests for ProgressTracker.recomputeTotal
 * and its mtime-based cache behaviour.
 *
 * Covers:
 *   1. First call after milestone start: disk scan runs, tracker returns total.
 *   2. Second call without disk changes: cached value returned, readFileSync not called.
 *   3. Disk scan is source of truth even when scheduler has more tasks.
 *   4. Empty disk state: fallback to mission count (existing behaviour).
 *
 * Run: node test/test-progress-total-cache.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── helpers ──────────────────────────────────────────────────────────────────

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 5).join('\n'));
    failCount++;
  }
}

// ── Import ProgressTracker ────────────────────────────────────────────────────

import { ProgressTracker } from '../src/orchestrator/core/progress-tracker.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeTmpHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-cache-test-'));
  const harnessDir = path.join(tmp, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  return harnessDir;
}

/** Write a mission-{id}.json file with the given task map structure. */
function writeMissionState(harnessDir, missionId, subMissions) {
  const filePath = path.join(harnessDir, 'state', `mission-${missionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ subMissions }, null, 2));
  return filePath;
}

/** Build a minimal msState object as _executeMilestone receives it. */
function makeMsState(missionIds) {
  const missions = {};
  for (const id of missionIds) {
    missions[id] = { id, status: 'pending' };
  }
  return { missions };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

await test('1. First call: disk scan runs, cache populated', () => {
  const harnessDir = makeTmpHarness();

  // Write mission state: mission-001 has 2 tasks, mission-002 has 3 tasks.
  writeMissionState(harnessDir, '001', {
    sm1: { tasks: { t1: {}, t2: {} } },
  });
  writeMissionState(harnessDir, '002', {
    sm1: { tasks: { t1: {}, t2: {}, t3: {} } },
  });

  const tracker = new ProgressTracker(harnessDir, null);

  const total = tracker.recomputeTotal('001', makeMsState(['001', '002']));

  assert.strictEqual(total, 5, `expected 5 tasks, got ${total}`);

  // Verify the cache was populated by confirming a second call returns the
  // same value (cache hit) without re-reading disk.
  const total2 = tracker.recomputeTotal('001', makeMsState(['001', '002']));
  assert.strictEqual(total2, 5, 'cached return value should also be 5');
});

await test('2. Second call without disk changes: returns cached value, readFileSync not called', () => {
  const harnessDir = makeTmpHarness();

  writeMissionState(harnessDir, '001', {
    sm1: { tasks: { t1: {}, t2: {} } },
  });

  const tracker = new ProgressTracker(harnessDir, null);
  const msState = makeMsState(['001']);

  // First call — warms the cache.
  const first = tracker.recomputeTotal('001', msState);
  assert.strictEqual(first, 2, 'first call should return 2');

  // Monkey-patch fs.readFileSync to track invocations.
  const origReadFileSync = fs.readFileSync;
  let readFileSyncCallCount = 0;
  fs.readFileSync = (...args) => {
    readFileSyncCallCount++;
    return origReadFileSync(...args);
  };

  try {
    const second = tracker.recomputeTotal('001', msState);
    assert.strictEqual(second, 2, 'second call should return same value');
    assert.strictEqual(
      readFileSyncCallCount,
      0,
      `fs.readFileSync should NOT have been called on cache hit, but was called ${readFileSyncCallCount} time(s)`,
    );
  } finally {
    fs.readFileSync = origReadFileSync;
  }
});

await test('3. Disk scan is source of truth even when scheduler has tasks (no fast-path)', () => {
  // The old scheduler fast-path returned _tasksById.size as a "fast" answer,
  // but that Map is reset per Scheduler.runMilestone call AND persists across
  // milestones — making it return per-mission size (lazy DFS) or stale size
  // (cross-milestone). Removed in favor of always disk-scanning. This test
  // now verifies disk wins over scheduler.size, the opposite of the prior
  // contract.
  const harnessDir = makeTmpHarness();

  writeMissionState(harnessDir, '001', {
    sm1: { tasks: { t1: {}, t2: {}, t3: {} } }, // 3 tasks on disk (the truth)
  });

  // ProgressTracker doesn't read scheduler state — disk is the sole source.
  const tracker = new ProgressTracker(harnessDir, null);

  const total = tracker.recomputeTotal('001', makeMsState(['001']));

  assert.strictEqual(
    total,
    3,
    `expected disk scan total (3), got ${total} — scheduler.size (5) should NOT shadow disk`,
  );
});

await test('4. Empty disk state: falls back to mission count', () => {
  const harnessDir = makeTmpHarness();
  // Do NOT write any mission state files — simulate first run before planner writes them.

  const tracker = new ProgressTracker(harnessDir, null);

  // 3 missions, no state files on disk.
  const msState = makeMsState(['001', '002', '003']);
  const total = tracker.recomputeTotal('ms1', msState);

  assert.strictEqual(total, 3, `expected mission count fallback (3), got ${total}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
