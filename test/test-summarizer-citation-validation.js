/**
 * test-summarizer-citation-validation.js — Tests for post-parse citation validation
 * in extractSummary() (task 001-003-001-002).
 *
 * Run: node test/test-summarizer-citation-validation.js
 */
import assert from 'assert';
import { extractSummary } from '../src/orchestrator/agents/summarizer.js';

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
    failCount++;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeFixture(changelogItems) {
  return {
    structured_output: {
      headline: 'Pipeline completed',
      bugs: [],
      summary: 'All tasks ran.',
      changelog: changelogItems,
    },
  };
}

// TC1: extractSummary with valid taskIds keeps all changelog items
await test('extractSummary: valid taskIds keeps all changelog items', () => {
  const fixture = makeFixture([
    { type: 'feature', description: 'Added X', source: 'task-desc', taskIds: ['001-001-001-001'] },
    { type: 'fix',     description: 'Fixed Y', source: 'task-desc', taskIds: ['001-001-001-002'] },
  ]);
  const out = extractSummary(fixture, {
    warn: () => {},
    completedTaskIds: ['001-001-001-001', '001-001-001-002'],
  });
  assert.equal(out.changelog.length, 2, `Expected 2 changelog items; got ${out.changelog.length}`);
  assert.equal(out.droppedChangelogCount, 0);
});

// TC2: extractSummary drops changelog items with unknown taskIds
await test('extractSummary: drops changelog items with unknown taskIds', () => {
  const fixture = makeFixture([
    { type: 'feature', description: 'Added X', source: 'task-desc', taskIds: ['001-001-001-001'] },
    { type: 'fix',     description: 'Fixed Y', source: 'task-desc', taskIds: ['001-001-001-UNKNOWN'] },
  ]);
  const out = extractSummary(fixture, {
    warn: () => {},
    completedTaskIds: ['001-001-001-001'],
  });
  assert.equal(out.changelog.length, 1, `Expected 1 changelog item after drop; got ${out.changelog.length}`);
  assert.equal(out.changelog[0].description, 'Added X');
});

// TC3: extractSummary returns droppedChangelogCount with correct value
await test('extractSummary: returns droppedChangelogCount with correct value', () => {
  const fixture = makeFixture([
    { type: 'feature', description: 'A', source: 'task-desc', taskIds: ['001-001-001-001'] },
    { type: 'fix',     description: 'B', source: 'task-desc', taskIds: ['BAD-ID-1'] },
    { type: 'fix',     description: 'C', source: 'task-desc', taskIds: ['BAD-ID-2'] },
  ]);
  const out = extractSummary(fixture, {
    warn: () => {},
    completedTaskIds: ['001-001-001-001'],
  });
  assert.equal(out.droppedChangelogCount, 2, `Expected droppedChangelogCount=2; got ${out.droppedChangelogCount}`);
  assert.equal(out.changelog.length, 1);
});

// TC4: extractSummary logs warning with count when items are dropped
await test('extractSummary: logs warning with dropped count when items are dropped', () => {
  const fixture = makeFixture([
    { type: 'feature', description: 'A', source: 'task-desc', taskIds: ['001-001-001-001'] },
    { type: 'fix',     description: 'B', source: 'task-desc', taskIds: ['UNKNOWN-1'] },
    { type: 'fix',     description: 'C', source: 'task-desc', taskIds: ['UNKNOWN-2'] },
  ]);

  const warnings = [];
  const warn = (msg) => warnings.push(msg);

  extractSummary(fixture, {
    warn,
    completedTaskIds: ['001-001-001-001'],
  });

  assert.equal(warnings.length, 1, `Expected 1 warning; got ${warnings.length}`);
  assert.ok(
    /dropped 2/i.test(warnings[0]),
    `Expected warning to mention "dropped 2"; got: ${warnings[0]}`
  );
});

// TC5: extractSummary with no completedTaskIds skips validation (backward-compatible)
await test('extractSummary: no completedTaskIds skips citation validation (backward-compatible)', () => {
  const fixture = makeFixture([
    { type: 'feature', description: 'A', source: 'task-desc', taskIds: ['ANY-ID'] },
    { type: 'fix',     description: 'B', source: 'task-desc', taskIds: ['ANOTHER-ID'] },
  ]);
  const out = extractSummary(fixture, { warn: () => {} });
  // All items kept — no filtering applied
  assert.equal(out.changelog.length, 2, `Expected all 2 items kept; got ${out.changelog.length}`);
});

// TC6: extractSummary with empty completedTaskIds skips validation
await test('extractSummary: empty completedTaskIds skips citation validation', () => {
  const fixture = makeFixture([
    { type: 'feature', description: 'A', source: 'task-desc', taskIds: ['ANY-ID'] },
    { type: 'fix',     description: 'B', source: 'task-desc', taskIds: ['ANOTHER-ID'] },
  ]);
  const out = extractSummary(fixture, {
    warn: () => {},
    completedTaskIds: [],
  });
  // All items kept — empty array skips filtering
  assert.equal(out.changelog.length, 2, `Expected all 2 items kept with empty completedTaskIds; got ${out.changelog.length}`);
});

// ── Bonus: items with partially-unknown taskIds are also dropped ──────────

await test('extractSummary: item with mixed valid/invalid taskIds is dropped', () => {
  const fixture = makeFixture([
    { type: 'feature', description: 'A', source: 'task-desc', taskIds: ['GOOD', 'BAD'] },
  ]);
  const out = extractSummary(fixture, {
    warn: () => {},
    completedTaskIds: ['GOOD'],
  });
  assert.equal(out.changelog.length, 0, `Expected 0 items (mixed invalid); got ${out.changelog.length}`);
  assert.equal(out.droppedChangelogCount, 1);
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
