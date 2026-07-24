/**
 * test-summarizer-contract.js — Round-trip tests for summarizer structured contract.
 *
 * Run: node test/test-summarizer-contract.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import {
  summarizerSchema,
  validateStructured,
} from '../src/orchestrator/agents/_schemas.js';

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

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'summarizer-contract-')); }
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

// ── Fixtures ────────────────────────────────────────────────────────────

const fixtureValid = {
  structured_output: {
    headline: 'Pipeline completed successfully — all 3 tasks passed',
    bugs: ['executor timed out on task-002', 'verifier returned empty affectedFiles'],
    summary: 'The pipeline ran 3 tasks. Two minor bugs were detected but both were resolved. All affected files were committed.',
    changelog: [
      { type: 'feature', description: 'Added changelog field to summarizer schema', taskIds: ['001-001-001-001'] },
      { type: 'fix', description: 'Executor timeout now surfaces correct error message', taskIds: ['001-001-001-002'] },
    ],
  },
};

const fixtureMissingHeadline = {
  structured_output: {
    bugs: [],
    summary: 'No headline here.',
    changelog: [],
  },
};

const fixtureMissingBugs = {
  structured_output: {
    headline: 'Done',
    summary: 'Everything worked.',
    changelog: [{ type: 'fix', description: 'Minor patch applied' }],
  },
};

// TC2: missing changelog field entirely — should fail validation (required)
const fixtureMissingChangelog = {
  structured_output: {
    headline: 'All tasks completed',
    bugs: [],
    summary: 'Everything ran cleanly.',
    // changelog intentionally omitted
  },
};

// TC3: changelog entry with invalid type enum value
const fixtureInvalidChangelogType = {
  structured_output: {
    headline: 'All tasks completed',
    bugs: [],
    summary: 'Everything ran cleanly.',
    changelog: [{ type: 'improvement', description: 'Should fail enum check' }],
  },
};

const fixtureNoStructured = { result: 'pipeline ran, here is prose output' };

const fixtureMalformed = {
  structured_output: {
    headline: 42,      // wrong type — not a string
    bugs: 'not-an-array',
    summary: null,
  },
};

// ── Schema validation ───────────────────────────────────────────────────

// TC1: fixtureValid with changelog passes validateStructured
await test('validateStructured: valid summarizer fixture (with changelog) passes', () => {
  const r = validateStructured(fixtureValid.structured_output, summarizerSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

await test('validateStructured: missing headline is rejected', () => {
  const r = validateStructured(fixtureMissingHeadline.structured_output, summarizerSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /headline.*missing/i.test(e)),
    `Expected headline missing error, got: ${JSON.stringify(r.errors)}`
  );
});

await test('validateStructured: missing bugs array is rejected', () => {
  const r = validateStructured(fixtureMissingBugs.structured_output, summarizerSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /bugs.*missing/i.test(e)),
    `Expected bugs missing error, got: ${JSON.stringify(r.errors)}`
  );
});

// TC2: missing changelog field is rejected (now required)
await test('validateStructured: missing changelog is rejected (required field)', () => {
  const r = validateStructured(fixtureMissingChangelog.structured_output, summarizerSchema);
  assert.equal(r.ok, false, 'Expected validation to fail when changelog is missing');
  assert.ok(
    r.errors.some((e) => /changelog.*missing/i.test(e)),
    `Expected changelog missing error, got: ${JSON.stringify(r.errors)}`
  );
});

// TC3: changelog entry with invalid type enum fails validation
await test('validateStructured: changelog with invalid type enum fails validation', () => {
  const r = validateStructured(fixtureInvalidChangelogType.structured_output, summarizerSchema);
  assert.equal(r.ok, false, 'Expected validation to fail for invalid changelog type enum');
  assert.ok(
    r.errors.some((e) => /not in enum/i.test(e)),
    `Expected enum error for invalid changelog type, got: ${JSON.stringify(r.errors)}`
  );
});

// ── extractSummary integration ──────────────────────────────────────────

// extractSummary is now return-only (no sidecar write). The caller
// (archive.js) persists the summary into manifest.json directly.
// See retro/RETRO-dogfood-3.md for rationale.

// TC4: extractSummary returns changelog array from valid fixture
await test('extractSummary: valid SDK result returns fields including changelog (no sidecar write)', async () => {
  const { extractSummary } = await import('../src/orchestrator/agents/summarizer.js');
  const out = extractSummary(fixtureValid);
  assert.equal(out.headline, fixtureValid.structured_output.headline);
  assert.deepEqual(out.bugs, fixtureValid.structured_output.bugs);
  assert.equal(out.summary, fixtureValid.structured_output.summary);
  assert.equal(out.structured.headline, fixtureValid.structured_output.headline);
  // TC4: changelog array is returned from valid fixture
  assert.deepEqual(out.changelog, fixtureValid.structured_output.changelog,
    `Expected changelog to match fixture, got: ${JSON.stringify(out.changelog)}`);
  assert.ok(Array.isArray(out.changelog), 'changelog should be an array');
  assert.ok(out.changelog.length > 0, 'changelog should have entries from fixture');
});

// TC5: extractSummary returns empty changelog from no-structured fixture
await test('extractSummary: no structured_output triggers deprecation stub (empty changelog)', async () => {
  const { extractSummary } = await import('../src/orchestrator/agents/summarizer.js');
  const out = extractSummary(fixtureNoStructured);
  assert.equal(out.headline, '[archived without AI summary]');
  // TC5: empty changelog on stub path
  assert.deepEqual(out.changelog, [], `Expected empty changelog from stub, got: ${JSON.stringify(out.changelog)}`);
});

// TC5: extractSummary returns empty changelog from malformed fixture
await test('extractSummary: malformed structured_output returns conservative defaults (empty changelog)', async () => {
  const { extractSummary } = await import('../src/orchestrator/agents/summarizer.js');
  const warn = console.warn;
  console.warn = () => {}; // suppress validation warning output
  try {
    const out = extractSummary(fixtureMalformed);
    assert.equal(out.headline, '');
    assert.deepEqual(out.bugs, []);
    assert.equal(out.summary, '');
    // TC5: empty changelog on malformed path
    assert.deepEqual(out.changelog, [], `Expected empty changelog from malformed, got: ${JSON.stringify(out.changelog)}`);
  } finally {
    console.warn = warn;
  }
});

// ── Integration-class regression: summarizer prompt receives a STRING, not '[object Object]' ──
// Guards against the v3.1 bug where archive.js returned verificationSidecars as an
// object and summarizer.js interpolated it via template literal.
await test('buildSummarizerDataPackage: verificationSidecars is a string, not an object', async () => {
  const { buildSummarizerDataPackage } = await import('../src/cli/commands/archive.js');

  const tmp = tempDir();
  try {
    const verificationDir = path.join(tmp, '.harness', 'verification');
    fs.mkdirSync(verificationDir, { recursive: true });
    fs.writeFileSync(
      path.join(verificationDir, 'task-001-001-001-001.json'),
      JSON.stringify({ result: 'PASSED', hardChecks: [], notes: 'ok' }, null, 2)
    );

    const state = { milestones: { '001': { id: '001', description: 'd', status: 'complete' } } };
    const pkg = buildSummarizerDataPackage(
      state, tmp, 'spec content', { totalCost: 0, totalSessions: 0 }, path.join(tmp, 'archives'),
      { getDiffSummary: () => '' }
    );

    assert.equal(typeof pkg.verificationSidecars, 'string',
      `verificationSidecars must be a string for prompt interpolation; was ${typeof pkg.verificationSidecars}`);
    assert.ok(pkg.verificationSidecars.includes('task-001-001-001-001.json'),
      'serialized sidecars should include the filename as a header');
    assert.ok(pkg.verificationSidecars.includes('"result": "PASSED"'),
      'serialized sidecars should include the sidecar JSON content');
    assert.ok(!pkg.verificationSidecars.includes('[object Object]'),
      'must not contain [object Object] marker from an earlier regression');
  } finally {
    cleanup(tmp);
  }
});

// ── Integration-class regression: summarizer schema lets model emit `file` for diff-file source ──
// Guards against the v3.1 bug where the schema had no `file` property so the model
// under constrained decoding could never produce it, and validateChangelogSources
// stripped every diff-file item unconditionally.
await test('summarizerSchema: changelog items validate when file is present alongside source=diff-file', () => {
  const payload = {
    headline: 'h',
    bugs: [],
    summary: 's',
    changelog: [
      { type: 'fix', description: 'Fixed X', source: 'diff-file', file: 'src/foo.js', taskIds: ['001-001-001-001'] },
      { type: 'feature', description: 'Added Y', source: 'mission-desc', taskIds: ['001-001-001-002'] },
    ],
  };
  const validation = validateStructured(payload, summarizerSchema);
  assert.ok(validation.ok, `expected valid; errors: ${validation.errors?.join('; ')}`);
});

await test('validateChangelogSources: diff-file items with matching file are kept', async () => {
  const { validateChangelogSources } = await import('../src/cli/commands/archive.js');
  const changelog = [
    { type: 'fix', description: 'A', source: 'diff-file', file: 'src/foo.js' },     // kept
    { type: 'fix', description: 'B', source: 'diff-file', file: 'src/nonexistent.js' }, // stripped
    { type: 'fix', description: 'C', source: 'mission-desc' },                      // kept (non-diff-file)
  ];
  // Simulate git diff --stat output — that's what validateChangelogSources parses.
  const diffSummary = [
    ' src/foo.js | 10 ++++++----',
    ' src/bar.js |  4 ++--',
  ].join('\n');
  const { valid, invalid } = validateChangelogSources(changelog, diffSummary);
  assert.equal(valid.length, 2, `expected 2 valid; got ${valid.length}`);
  assert.equal(invalid.length, 1, `expected 1 invalid; got ${invalid.length}`);
  assert.equal(valid[0].description, 'A');
  assert.equal(valid[1].description, 'C');
  assert.equal(invalid[0].description, 'B');
});

// ── taskIds schema constraint tests ────────────────────────────────────────

// TC1 (taskIds): changelog entry with valid taskIds passes validation
await test('validateStructured: changelog with valid taskIds passes schema validation', () => {
  const payload = {
    headline: 'Done',
    bugs: [],
    summary: 'All good.',
    changelog: [{ type: 'fix', description: 'Fixed bug', taskIds: ['001-001-001-001'] }],
  };
  const r = validateStructured(payload, summarizerSchema);
  assert.equal(r.ok, true, `Expected validation to pass with valid taskIds, got: ${JSON.stringify(r.errors)}`);
});

// TC2 (taskIds): changelog entry missing taskIds fails as required field
await test('validateStructured: changelog missing taskIds fails as required field', () => {
  const payload = {
    headline: 'Done',
    bugs: [],
    summary: 'All good.',
    changelog: [{ type: 'fix', description: 'Fixed bug' }],
  };
  const r = validateStructured(payload, summarizerSchema);
  assert.equal(r.ok, false, 'Expected validation to fail when taskIds is missing from changelog entry');
  assert.ok(
    r.errors.some((e) => /taskIds.*missing/i.test(e)),
    `Expected taskIds missing error, got: ${JSON.stringify(r.errors)}`
  );
});

// TC3 (taskIds): changelog entry with empty taskIds array fails minItems:1 validation
await test('validateStructured: changelog with empty taskIds array fails minItems check', () => {
  const payload = {
    headline: 'Done',
    bugs: [],
    summary: 'All good.',
    changelog: [{ type: 'fix', description: 'Fixed bug', taskIds: [] }],
  };
  const r = validateStructured(payload, summarizerSchema);
  assert.equal(r.ok, false, 'Expected validation to fail when taskIds is empty array');
  assert.ok(
    r.errors.some((e) => /minItems|too few/i.test(e)),
    `Expected minItems error for empty taskIds, got: ${JSON.stringify(r.errors)}`
  );
});

// TC4 (taskIds): changelog entry with taskIds: [''] fails minLength:1 validation
await test('validateStructured: changelog with empty-string taskId fails minLength check', () => {
  const payload = {
    headline: 'Done',
    bugs: [],
    summary: 'All good.',
    changelog: [{ type: 'fix', description: 'Fixed bug', taskIds: [''] }],
  };
  const r = validateStructured(payload, summarizerSchema);
  assert.equal(r.ok, false, 'Expected validation to fail when taskIds contains empty string');
  assert.ok(
    r.errors.some((e) => /minLength|too short/i.test(e)),
    `Expected minLength error for empty-string taskId, got: ${JSON.stringify(r.errors)}`
  );
});

// ── completedTasks enrichment ────────────────────────────────────────────

// TC1: completedTasks contains only completed tasks with {id, description} shape
await test('buildSummarizerDataPackage: completedTasks contains completed tasks with {id, description}', async () => {
  const { buildSummarizerDataPackage } = await import('../src/cli/commands/archive.js');

  const tmp = tempDir();
  try {
    const verificationDir = path.join(tmp, '.harness', 'verification');
    const stateDir = path.join(tmp, '.harness', 'state');
    fs.mkdirSync(verificationDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Write a mission state file with one completed and one pending task
    const missionState = {
      subMissions: {
        '001-001-001': {
          tasks: {
            '001-001-001-001': {
              id: '001-001-001-001',
              description: 'Completed task alpha',
              status: 'complete',
              affectedFiles: ['src/foo.js'],
            },
            '001-001-001-002': {
              id: '001-001-001-002',
              description: 'Pending task beta',
              status: 'pending',
              affectedFiles: [],
            },
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(stateDir, 'mission-001-001.json'),
      JSON.stringify(missionState, null, 2)
    );

    const state = {
      milestones: {
        '001': {
          id: '001',
          description: 'd',
          status: 'complete',
          missions: {
            '001-001': { id: '001-001', stateFile: '.harness/state/mission-001-001.json' },
          },
        },
      },
    };

    const pkg = buildSummarizerDataPackage(
      state, tmp, 'spec content', { totalCost: 0, totalSessions: 0 }, path.join(tmp, 'archives'),
      { getDiffSummary: () => '' }
    );

    assert.ok(Array.isArray(pkg.completedTasks), 'completedTasks must be an array');
    assert.equal(pkg.completedTasks.length, 1,
      `Expected 1 completed task, got ${pkg.completedTasks.length}`);
    assert.equal(pkg.completedTasks[0].id, '001-001-001-001',
      `Expected id '001-001-001-001', got '${pkg.completedTasks[0].id}'`);
    assert.equal(pkg.completedTasks[0].description, 'Completed task alpha',
      `Expected description 'Completed task alpha', got '${pkg.completedTasks[0].description}'`);
  } finally {
    cleanup(tmp);
  }
});

// TC2: completedTasks is empty array when no mission state files exist
await test('buildSummarizerDataPackage: completedTasks is empty array when no mission state files exist', async () => {
  const { buildSummarizerDataPackage } = await import('../src/cli/commands/archive.js');

  const tmp = tempDir();
  try {
    const verificationDir = path.join(tmp, '.harness', 'verification');
    fs.mkdirSync(verificationDir, { recursive: true });
    // No state files written — .harness/state/ does not exist

    const state = { milestones: { '001': { id: '001', description: 'd', status: 'complete' } } };
    const pkg = buildSummarizerDataPackage(
      state, tmp, 'spec content', { totalCost: 0, totalSessions: 0 }, path.join(tmp, 'archives'),
      { getDiffSummary: () => '' }
    );

    assert.ok(Array.isArray(pkg.completedTasks), 'completedTasks must be an array');
    assert.equal(pkg.completedTasks.length, 0,
      `Expected empty completedTasks, got ${JSON.stringify(pkg.completedTasks)}`);
  } finally {
    cleanup(tmp);
  }
});

// TC3: completedTasks items do NOT contain affectedFiles or other extra fields
await test('buildSummarizerDataPackage: completedTasks items have only {id, description} — no affectedFiles or extra fields', async () => {
  const { buildSummarizerDataPackage } = await import('../src/cli/commands/archive.js');

  const tmp = tempDir();
  try {
    const verificationDir = path.join(tmp, '.harness', 'verification');
    const stateDir = path.join(tmp, '.harness', 'state');
    fs.mkdirSync(verificationDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    const missionState = {
      subMissions: {
        '001-001-001': {
          tasks: {
            '001-001-001-001': {
              id: '001-001-001-001',
              description: 'Task with extra fields',
              status: 'done',
              affectedFiles: ['src/bar.js'],
              summary: 'Did something',
              result: 'COMPLETED',
            },
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(stateDir, 'mission-001-001.json'),
      JSON.stringify(missionState, null, 2)
    );

    const state = {
      milestones: {
        '001': {
          id: '001',
          description: 'd',
          status: 'complete',
          missions: {
            '001-001': { id: '001-001', stateFile: '.harness/state/mission-001-001.json' },
          },
        },
      },
    };

    const pkg = buildSummarizerDataPackage(
      state, tmp, 'spec content', { totalCost: 0, totalSessions: 0 }, path.join(tmp, 'archives'),
      { getDiffSummary: () => '' }
    );

    assert.equal(pkg.completedTasks.length, 1, 'Expected 1 completed task');
    const item = pkg.completedTasks[0];
    const keys = Object.keys(item);
    assert.deepEqual(keys.sort(), ['description', 'id'],
      `Expected only {id, description} keys, got: ${JSON.stringify(keys)}`);
    assert.ok(!('affectedFiles' in item), 'completedTasks items must not contain affectedFiles');
    assert.ok(!('summary' in item), 'completedTasks items must not contain summary');
    assert.ok(!('result' in item), 'completedTasks items must not contain result');
    assert.ok(!('status' in item), 'completedTasks items must not contain status');
  } finally {
    cleanup(tmp);
  }
});

// ── Citation validation (completedTaskIds) ────────────────────────────────

// TC1: extractSummary keeps changelog items whose taskIds are all in completedTaskIds
await test('extractSummary: keeps changelog items with valid taskIds', async () => {
  const { extractSummary } = await import('../src/orchestrator/agents/summarizer.js');
  const fixture = {
    structured_output: {
      headline: 'Done',
      bugs: [],
      summary: 'All good.',
      changelog: [
        { type: 'fix', description: 'Fixed something', taskIds: ['001-001-001-001'] },
      ],
    },
  };
  const out = extractSummary(fixture, { completedTaskIds: ['001-001-001-001'] });
  assert.equal(out.changelog.length, 1,
    `Expected 1 changelog item to be kept, got ${out.changelog.length}`);
  assert.equal(out.changelog[0].description, 'Fixed something');
  assert.equal(out.droppedChangelogCount, 0,
    `Expected droppedChangelogCount=0, got ${out.droppedChangelogCount}`);
});

// TC2: extractSummary drops items citing unknown IDs and sets droppedChangelogCount
await test('extractSummary: drops items with unknown taskIds and sets droppedChangelogCount', async () => {
  const { extractSummary } = await import('../src/orchestrator/agents/summarizer.js');
  const fixture = {
    structured_output: {
      headline: 'Done',
      bugs: [],
      summary: 'All good.',
      changelog: [
        { type: 'fix', description: 'Unknown task item', taskIds: ['999-999-999-999'] },
      ],
    },
  };
  const out = extractSummary(fixture, { completedTaskIds: ['001-001-001-001'] });
  assert.equal(out.changelog.length, 0,
    `Expected 0 changelog items (unknown taskId dropped), got ${out.changelog.length}`);
  assert.equal(out.droppedChangelogCount, 1,
    `Expected droppedChangelogCount=1, got ${out.droppedChangelogCount}`);
});

// TC3: extractSummary accepts item with multiple taskIds when ALL are valid
await test('extractSummary: accepts multi-task citation when all taskIds are valid', async () => {
  const { extractSummary } = await import('../src/orchestrator/agents/summarizer.js');
  const fixture = {
    structured_output: {
      headline: 'Done',
      bugs: [],
      summary: 'All good.',
      changelog: [
        {
          type: 'feature',
          description: 'Multi-task item',
          taskIds: ['001-001-001-001', '001-001-001-002'],
        },
      ],
    },
  };
  const out = extractSummary(fixture, { completedTaskIds: ['001-001-001-001', '001-001-001-002'] });
  assert.equal(out.changelog.length, 1,
    `Expected 1 changelog item kept (all taskIds valid), got ${out.changelog.length}`);
  assert.equal(out.changelog[0].description, 'Multi-task item');
  assert.equal(out.droppedChangelogCount, 0,
    `Expected droppedChangelogCount=0, got ${out.droppedChangelogCount}`);
});

// TC4: extractSummary drops item if ANY taskId is invalid (mixed valid/invalid in one item)
await test('extractSummary: drops item if ANY taskId is invalid (mixed valid/invalid)', async () => {
  const { extractSummary } = await import('../src/orchestrator/agents/summarizer.js');
  const fixture = {
    structured_output: {
      headline: 'Done',
      bugs: [],
      summary: 'All good.',
      changelog: [
        {
          type: 'feature',
          description: 'Mixed taskIds item',
          taskIds: ['001-001-001-001', '999-999-999-999'],
        },
      ],
    },
  };
  const out = extractSummary(fixture, { completedTaskIds: ['001-001-001-001'] });
  assert.equal(out.changelog.length, 0,
    `Expected 0 items when ANY taskId is invalid, got ${out.changelog.length}`);
  assert.equal(out.droppedChangelogCount, 1,
    `Expected droppedChangelogCount=1, got ${out.droppedChangelogCount}`);
});

// TC4: extractSummary skips validation when completedTaskIds not provided (backward compat)
await test('extractSummary: skips citation validation when completedTaskIds not provided', async () => {
  const { extractSummary } = await import('../src/orchestrator/agents/summarizer.js');
  const fixture = {
    structured_output: {
      headline: 'Done',
      bugs: [],
      summary: 'All good.',
      changelog: [
        { type: 'fix', description: 'Item A', taskIds: ['001-001-001-001'] },
        { type: 'feature', description: 'Item B', taskIds: ['002-002-002-002'] },
      ],
    },
  };
  // No completedTaskIds passed — all items should be kept
  const out = extractSummary(fixture);
  assert.equal(out.changelog.length, 2,
    `Expected all 2 changelog items kept (no completedTaskIds), got ${out.changelog.length}`);
});

// TC5: warn is called with dropped count message when items are filtered
await test('extractSummary: warn is called with dropped count when items are filtered', async () => {
  const { extractSummary } = await import('../src/orchestrator/agents/summarizer.js');
  const fixture = {
    structured_output: {
      headline: 'Done',
      bugs: [],
      summary: 'All good.',
      changelog: [
        { type: 'fix', description: 'Invalid item', taskIds: ['999-999-999-999'] },
        { type: 'feature', description: 'Also invalid', taskIds: ['888-888-888-888'] },
      ],
    },
  };
  const warnMessages = [];
  const warn = (msg) => warnMessages.push(msg);
  const out = extractSummary(fixture, { completedTaskIds: ['001-001-001-001'], warn });
  assert.equal(out.droppedChangelogCount, 2,
    `Expected droppedChangelogCount=2, got ${out.droppedChangelogCount}`);
  assert.ok(warnMessages.length > 0, 'Expected warn to be called at least once');
  const hasDroppedMsg = warnMessages.some((m) => /dropped.*2/i.test(m) || /2.*dropped/i.test(m));
  assert.ok(hasDroppedMsg,
    `Expected warn message to mention "dropped" and "2"; got: ${JSON.stringify(warnMessages)}`);
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
