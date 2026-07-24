#!/usr/bin/env node

/**
 * test-queue-state.js — Unit tests for queue CRUD helpers in state.js.
 *
 * No external test framework.  Run: node test/test-queue-state.js
 *
 * Covers:
 *   TC1 — writeQueueEntry + readQueueEntry round-trip preserves all fields
 *   TC2 — readQueueEntry returns null for missing entry
 *   TC3 — listQueue returns empty array for missing queue dir
 *   TC4 — listQueue returns entries sorted by validatedAt timestamp
 *   TC5 — removeQueueEntry removes directory, subsequent read returns null
 *   TC6 — removeQueueEntry on non-existent slug does not throw
 *   TC7 — writeQueueEntry overwrites existing entry cleanly
 *   TC8 — writeQueueEntry + readQueueEntry round-trip preserves status='failed-execution'
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  writeQueueEntry,
  readQueueEntry,
  listQueue,
  removeQueueEntry,
  VALID_QUEUE_STATUSES,
} from '../src/orchestrator/core/state.js';

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

  console.log('=== Queue State Unit Tests ===\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-queue-state-'));

  // Clean up temp dir on exit
  process.on('exit', () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // ── TC1: writeQueueEntry + readQueueEntry round-trip ─────────────────────
  console.log('TC1: writeQueueEntry + readQueueEntry round-trip preserves all fields');

  const slug1 = 'test-slug-1';
  const entry1 = {
    spec: '# My Spec\n\nSome spec content here.',
    plan: { milestones: [{ id: '001', description: 'Milestone One', missions: [] }] },
    validatedAt: '2024-03-15T10:00:00.000Z',
    status: 'pending',
  };

  writeQueueEntry(tmpDir, slug1, entry1);
  const read1 = readQueueEntry(tmpDir, slug1);

  assert('TC1: returned entry is not null', read1 !== null);
  assert('TC1: slug field matches', read1 !== null && read1.slug === slug1);
  assert('TC1: spec field matches', read1 !== null && read1.spec === entry1.spec);
  assert(
    'TC1: plan field matches (milestones count)',
    read1 !== null && Array.isArray(read1.plan.milestones) && read1.plan.milestones.length === 1
  );
  assert(
    'TC1: plan milestone id matches',
    read1 !== null && read1.plan.milestones[0].id === '001'
  );
  assert(
    'TC1: validatedAt field matches',
    read1 !== null && read1.validatedAt === entry1.validatedAt
  );
  assert('TC1: status field matches', read1 !== null && read1.status === entry1.status);

  // ── TC2: readQueueEntry returns null for missing entry ────────────────────
  console.log('\nTC2: readQueueEntry returns null for missing entry');

  const missing = readQueueEntry(tmpDir, 'non-existent-slug');
  assert('TC2: returns null for missing slug', missing === null);

  // ── TC3: listQueue returns empty array for missing queue dir ──────────────
  console.log('\nTC3: listQueue returns empty array for missing queue dir');

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-no-queue-'));
  process.on('exit', () => {
    try {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const listEmpty = listQueue(emptyRoot);
  assert('TC3: returns an array', Array.isArray(listEmpty));
  assert('TC3: returns empty array', listEmpty.length === 0);

  // ── TC4: listQueue returns entries sorted by validatedAt timestamp ─────────
  console.log('\nTC4: listQueue returns entries sorted by validatedAt timestamp');

  const sortRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-sort-'));
  process.on('exit', () => {
    try {
      fs.rmSync(sortRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const entryOlder = {
    spec: '# Older spec',
    plan: { milestones: [] },
    validatedAt: '2024-01-01T00:00:00.000Z',
    status: 'pending',
  };
  const entryNewer = {
    spec: '# Newer spec',
    plan: { milestones: [] },
    validatedAt: '2024-06-01T00:00:00.000Z',
    status: 'pending',
  };
  const entryMiddle = {
    spec: '# Middle spec',
    plan: { milestones: [] },
    validatedAt: '2024-03-15T00:00:00.000Z',
    status: 'pending',
  };

  // Write in non-chronological order
  writeQueueEntry(sortRoot, 'slug-newer', entryNewer);
  writeQueueEntry(sortRoot, 'slug-older', entryOlder);
  writeQueueEntry(sortRoot, 'slug-middle', entryMiddle);

  const sorted = listQueue(sortRoot);
  assert('TC4: returns 3 entries', sorted.length === 3);
  assert('TC4: first entry is oldest', sorted.length >= 1 && sorted[0].slug === 'slug-older');
  assert('TC4: second entry is middle', sorted.length >= 2 && sorted[1].slug === 'slug-middle');
  assert('TC4: third entry is newest', sorted.length >= 3 && sorted[2].slug === 'slug-newer');

  // ── TC5: removeQueueEntry removes directory, subsequent read returns null ──
  console.log('\nTC5: removeQueueEntry removes directory, subsequent read returns null');

  const slug5 = 'remove-me';
  writeQueueEntry(tmpDir, slug5, {
    spec: '# To be removed',
    plan: { milestones: [] },
    validatedAt: '2024-05-01T00:00:00.000Z',
    status: 'pending',
  });

  const beforeRemove = readQueueEntry(tmpDir, slug5);
  assert('TC5: entry exists before remove', beforeRemove !== null);

  removeQueueEntry(tmpDir, slug5);

  const afterRemove = readQueueEntry(tmpDir, slug5);
  assert('TC5: entry directory is gone', !fs.existsSync(path.join(tmpDir, 'queue', slug5)));
  assert('TC5: readQueueEntry returns null after remove', afterRemove === null);

  // ── TC6: removeQueueEntry on non-existent slug does not throw ─────────────
  console.log('\nTC6: removeQueueEntry on non-existent slug does not throw');

  let tc6Error = null;
  try {
    removeQueueEntry(tmpDir, 'does-not-exist-at-all');
  } catch (err) {
    tc6Error = err;
  }
  assert('TC6: no exception thrown for non-existent slug', tc6Error === null);

  // ── TC7: writeQueueEntry overwrites existing entry cleanly ────────────────
  console.log('\nTC7: writeQueueEntry overwrites existing entry cleanly');

  const slug7 = 'overwrite-me';
  const originalEntry = {
    spec: '# Original spec content',
    plan: { milestones: [{ id: '001', description: 'Original milestone', missions: [] }] },
    validatedAt: '2024-02-01T00:00:00.000Z',
    status: 'pending',
  };
  const updatedEntry = {
    spec: '# Updated spec content',
    plan: { milestones: [{ id: '002', description: 'Updated milestone', missions: [] }] },
    validatedAt: '2024-04-01T00:00:00.000Z',
    status: 'running',
  };

  writeQueueEntry(tmpDir, slug7, originalEntry);
  const readOriginal = readQueueEntry(tmpDir, slug7);
  assert('TC7: original entry written correctly', readOriginal !== null && readOriginal.spec === originalEntry.spec);

  writeQueueEntry(tmpDir, slug7, updatedEntry);
  const readUpdated = readQueueEntry(tmpDir, slug7);
  assert('TC7: overwritten entry is not null', readUpdated !== null);
  assert('TC7: spec is overwritten', readUpdated !== null && readUpdated.spec === updatedEntry.spec);
  assert(
    'TC7: plan is overwritten',
    readUpdated !== null && readUpdated.plan.milestones[0].id === '002'
  );
  assert(
    'TC7: validatedAt is overwritten',
    readUpdated !== null && readUpdated.validatedAt === updatedEntry.validatedAt
  );
  assert('TC7: status is overwritten', readUpdated !== null && readUpdated.status === updatedEntry.status);

  // ── TC8: writeQueueEntry + readQueueEntry round-trip preserves status='failed-execution' ──
  console.log("\nTC8: writeQueueEntry + readQueueEntry round-trip preserves status='failed-execution'");

  const slug8 = 'failed-execution-slug';
  const entry8 = {
    spec: '# Failed execution spec',
    plan: { milestones: [] },
    validatedAt: '2024-07-01T00:00:00.000Z',
    status: 'failed-execution',
  };

  writeQueueEntry(tmpDir, slug8, entry8);
  const read8 = readQueueEntry(tmpDir, slug8);

  assert("TC8: returned entry is not null", read8 !== null);
  assert("TC8: status field equals 'failed-execution'", read8 !== null && read8.status === 'failed-execution');
  assert("TC8: status is NOT coerced to 'failed-validation'", read8 !== null && read8.status !== 'failed-validation');

  const list8 = listQueue(tmpDir);
  const list8Entry = list8.find(e => e.slug === slug8);
  assert("TC8: listQueue returns the entry", list8Entry !== undefined);
  assert("TC8: listQueue entry has status 'failed-execution'", list8Entry !== undefined && list8Entry.status === 'failed-execution');

  assert("TC8: VALID_QUEUE_STATUSES includes 'failed-execution'", Array.isArray(VALID_QUEUE_STATUSES) && VALID_QUEUE_STATUSES.includes('failed-execution'));

  // ── TC10: assumptionResults round-trip via sibling file ───────────────────
  console.log('\nTC10: writeQueueEntry persists assumptionResults; readQueueEntry returns them');

  const slug10 = 'assumption-results';
  const ar = [
    { name: 'has-x', status: 'verified' },
    { name: 'has-y', status: 'failed' },
  ];
  writeQueueEntry(tmpDir, slug10, {
    spec: '# spec',
    plan: { milestones: [] },
    validatedAt: '2024-05-01T00:00:00.000Z',
    assumptionResults: ar,
    status: 'pending',
  });
  const arPath = path.join(tmpDir, 'queue', slug10, 'assumption-results.json');
  assert('TC10: assumption-results.json file exists', fs.existsSync(arPath));
  const read10 = readQueueEntry(tmpDir, slug10);
  assert('TC10: validatedAt is the flat ISO string', read10 !== null && read10.validatedAt === '2024-05-01T00:00:00.000Z');
  assert(
    'TC10: assumptionResults round-trips with the same length',
    read10 !== null && Array.isArray(read10.assumptionResults) && read10.assumptionResults.length === 2,
  );
  assert(
    'TC10: assumptionResults[0].name preserved',
    read10 !== null && read10.assumptionResults[0]?.name === 'has-x',
  );

  // ── TC11: readQueueEntry tolerates legacy {timestamp, assumptionResults} shape ─
  console.log('\nTC11: readQueueEntry tolerates legacy object shape on disk');

  const slug11 = 'legacy-shape';
  const legacyDir = path.join(tmpDir, 'queue', slug11);
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'spec.md'), '# legacy');
  fs.writeFileSync(path.join(legacyDir, 'plan.json'), JSON.stringify({ milestones: [] }));
  fs.writeFileSync(
    path.join(legacyDir, 'validated-at.json'),
    JSON.stringify({ timestamp: '2023-12-31T00:00:00.000Z', assumptionResults: [{ name: 'legacy' }] }),
  );
  fs.writeFileSync(path.join(legacyDir, 'status'), 'pending');

  const read11 = readQueueEntry(tmpDir, slug11);
  assert(
    'TC11: legacy shape lifted to flat string validatedAt',
    read11 !== null && read11.validatedAt === '2023-12-31T00:00:00.000Z',
  );
  assert(
    'TC11: legacy assumptionResults surfaced from object',
    read11 !== null && Array.isArray(read11.assumptionResults) && read11.assumptionResults[0]?.name === 'legacy',
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
