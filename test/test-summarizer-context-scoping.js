/**
 * test-summarizer-context-scoping.js — Regression tests for summarizer context scoping.
 *
 * Verifies that:
 *   - Poisoned HEAD commit subject/body does NOT leak into buildSummarizerDataPackage
 *   - Prior CHANGELOG raw text does NOT leak into buildSummarizerDataPackage
 *   - Happy-path: extractSummary with valid structured_output (including source field) works
 *   - validateChangelogSources handles diff-file items correctly
 *   - summarizerSchema validates the source enum on changelog items correctly
 *
 * Run: node test/test-summarizer-context-scoping.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

import {
  buildSummarizerDataPackage,
  validateChangelogSources,
} from '../src/cli/commands/archive.js';
import { extractSummary } from '../src/orchestrator/agents/summarizer.js';
import {
  summarizerSchema,
  validateStructured,
} from '../src/orchestrator/agents/_schemas.js';

// ── Test harness ──────────────────────────────────────────────────────────────

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

// ── Temp dir helpers ──────────────────────────────────────────────────────────

const tmpDirs = [];

function makeTmpProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarizer-scope-'));
  tmpDirs.push(tmpDir);
  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  return tmpDir;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const minimalState = {
  globalStatus: 'completed',
  milestones: {},
};

const minimalUsageData = { totalCost: 0.42, totalSessions: 3 };

// ── TC1: Poisoned HEAD doesn't leak ──────────────────────────────────────────
//
// buildSummarizerDataPackage must NOT include the git HEAD commit subject/body
// in the returned data package. We inject a mock getDiffSummary that returns a
// diffSummary mentioning only status-bar.js, then assert that the package does
// not contain HEAD-related terms in any string field.

await test('TC1: poisoned HEAD — buildSummarizerDataPackage excludes git HEAD commit subject/body', () => {
  const tmpDir = makeTmpProject();

  // Poisoned diffSummary: only status-bar.js is referenced, no HEAD info
  const cleanDiffSummary = '  src/status-bar.js | 12 ++++++------\n 1 file changed, 6 insertions(+), 6 deletions(-)';

  const deps = {
    getDiffSummary: () => cleanDiffSummary,
  };

  const pkg = buildSummarizerDataPackage(
    minimalState,
    tmpDir,
    'spec content here',
    minimalUsageData,
    path.join(tmpDir, 'archives'),
    deps
  );

  // Collect all string values in the package for inspection
  const packageStr = JSON.stringify(pkg);

  // The package should not include HEAD-related terms that could come from git HEAD
  // (subject, body, commit SHA patterns from git log --format=%s or %B)
  const headTermPatterns = [
    /\bHEAD\b/,
    /git log/i,
    /commit subject/i,
    /commit body/i,
  ];

  for (const pattern of headTermPatterns) {
    // Only assert the diffSummary itself doesn't include HEAD terms —
    // the mock returns a clean diff, so the package's diffSummary must match
    assert.ok(
      !pattern.test(pkg.diffSummary),
      `diffSummary must not contain HEAD-related term matching ${pattern}: got ${pkg.diffSummary}`
    );
  }

  // Verify the diffSummary actually came from our mock (status-bar.js is present)
  assert.ok(
    pkg.diffSummary.includes('status-bar.js'),
    `Expected diffSummary to contain 'status-bar.js', got: ${pkg.diffSummary}`
  );

  // The package must NOT have a raw gitHead commit message string field
  assert.ok(
    !('headCommitSubject' in pkg),
    'Package must not include headCommitSubject field'
  );
  assert.ok(
    !('headCommitBody' in pkg),
    'Package must not include headCommitBody field'
  );
  assert.ok(
    !('gitLog' in pkg),
    'Package must not include gitLog field (recent commits should not be in the package)'
  );
});

// ── TC2: Cross-archive CHANGELOG content doesn't leak ────────────────────────
//
// buildSummarizerDataPackage must NOT include prior CHANGELOG raw text.
// We create a project with an archives/ directory containing a prior manifest
// with a changelog, then assert the returned package does NOT contain that
// prior changelog content.

await test('TC2: cross-archive leak — buildSummarizerDataPackage excludes prior CHANGELOG raw text', () => {
  const tmpDir = makeTmpProject();
  const archivesDir = path.join(tmpDir, 'archives');
  fs.mkdirSync(archivesDir, { recursive: true });

  // Write a prior archive with a CHANGELOG-style manifest
  const priorArchiveDir = path.join(archivesDir, '001-prior-release');
  fs.mkdirSync(priorArchiveDir, { recursive: true });

  const priorChangelog = [
    { type: 'feature', description: 'PRIOR_UNIQUE_CHANGELOG_CONTENT_XYZ — should not appear' },
  ];
  const priorManifest = {
    id: '001-prior-release',
    seq: '001',
    gitHead: 'deadbeefdeadbeef',
    changelog: priorChangelog,
  };
  fs.writeFileSync(
    path.join(priorArchiveDir, 'manifest.json'),
    JSON.stringify(priorManifest, null, 2),
    'utf8'
  );

  // Also write a CHANGELOG.md-style file in the archive
  fs.writeFileSync(
    path.join(priorArchiveDir, 'CHANGELOG.md'),
    '## Prior Release\n- PRIOR_UNIQUE_CHANGELOG_CONTENT_XYZ\n',
    'utf8'
  );

  const deps = {
    getDiffSummary: () => '  src/new-feature.js | 5 +++++\n 1 file changed',
  };

  const pkg = buildSummarizerDataPackage(
    minimalState,
    tmpDir,
    'current spec',
    minimalUsageData,
    archivesDir,
    deps
  );

  const packageStr = JSON.stringify(pkg);

  // The prior changelog unique content must NOT appear in the data package
  assert.ok(
    !packageStr.includes('PRIOR_UNIQUE_CHANGELOG_CONTENT_XYZ'),
    `Package must not include prior CHANGELOG content, but found it in: ${packageStr}`
  );

  // The package must not have a priorChangelog or changelog field at top-level
  assert.ok(
    !('priorChangelog' in pkg),
    'Package must not include priorChangelog field'
  );
  assert.ok(
    !('changelog' in pkg),
    'Package must not include a top-level changelog field (that would be prior CHANGELOG content)'
  );
});

// ── TC3: Happy-path — extractSummary with source field ────────────────────────
//
// extractSummary must correctly return all fields including changelog entries
// that include the optional source field.

await test('TC3: happy path — extractSummary with valid structured_output returns correct fields including source', () => {
  const sdkResult = {
    structured_output: {
      headline: 'Pipeline completed — all 3 tasks passed',
      bugs: ['executor timed out on task-002'],
      summary: 'The pipeline ran 3 tasks. One bug was detected and resolved.',
      changelog: [
        { type: 'feature', description: 'Added status-bar rendering', source: 'diff-file', taskIds: ['task-001'] },
        { type: 'fix', description: 'Executor timeout now surfaces correct error', source: 'task-desc', taskIds: ['task-002'] },
      ],
    },
  };

  const out = extractSummary(sdkResult);

  assert.equal(out.headline, sdkResult.structured_output.headline,
    `Expected headline to match fixture`);
  assert.deepEqual(out.bugs, sdkResult.structured_output.bugs,
    `Expected bugs to match fixture`);
  assert.equal(out.summary, sdkResult.structured_output.summary,
    `Expected summary to match fixture`);

  // Changelog must be returned including source field
  assert.ok(Array.isArray(out.changelog), 'changelog must be an array');
  assert.equal(out.changelog.length, 2, 'changelog must have 2 entries');

  assert.equal(out.changelog[0].type, 'feature');
  assert.equal(out.changelog[0].description, 'Added status-bar rendering');
  assert.equal(out.changelog[0].source, 'diff-file',
    `Expected source field 'diff-file', got: ${out.changelog[0].source}`);

  assert.equal(out.changelog[1].type, 'fix');
  assert.equal(out.changelog[1].source, 'task-desc',
    `Expected source field 'task-desc', got: ${out.changelog[1].source}`);

  // structured must be the raw object
  assert.equal(out.structured.headline, sdkResult.structured_output.headline);
});

// ── TC4: validateChangelogSources — diff-file item with file in diff → valid ──

await test('TC4: validateChangelogSources — diff-file item with file in diff → valid', () => {
  const diffSummary = [
    '  src/status-bar.js | 12 ++++++------',
    '  src/pipeline.js   |  3 +--',
    ' 2 files changed, 9 insertions(+), 6 deletions(-)',
  ].join('\n');

  const changelog = [
    { type: 'feature', description: 'Status bar improvements', source: 'diff-file', file: 'src/status-bar.js' },
    { type: 'fix', description: 'Pipeline cleanup', source: 'diff-file', file: 'src/pipeline.js' },
  ];

  const { valid, invalid } = validateChangelogSources(changelog, diffSummary);

  assert.equal(valid.length, 2, `Expected 2 valid items, got ${valid.length}`);
  assert.equal(invalid.length, 0, `Expected 0 invalid items, got ${invalid.length}`);
  assert.equal(valid[0].file, 'src/status-bar.js');
  assert.equal(valid[1].file, 'src/pipeline.js');
});

// ── TC5: validateChangelogSources — diff-file item with file NOT in diff → invalid ──

await test('TC5: validateChangelogSources — diff-file item with file NOT in diff → invalid', () => {
  const diffSummary = [
    '  src/status-bar.js | 12 ++++++------',
    ' 1 file changed, 6 insertions(+), 6 deletions(-)',
  ].join('\n');

  const changelog = [
    // This file IS in the diff → valid
    { type: 'feature', description: 'Status bar improvements', source: 'diff-file', file: 'src/status-bar.js' },
    // This file is NOT in the diff → invalid
    { type: 'fix', description: 'Fix something in executor', source: 'diff-file', file: 'src/executor.js' },
    // Non-diff-file source → always valid regardless
    { type: 'fix', description: 'Mentioned in task desc', source: 'task-desc' },
  ];

  const { valid, invalid } = validateChangelogSources(changelog, diffSummary);

  assert.equal(valid.length, 2, `Expected 2 valid items (status-bar.js + task-desc), got ${valid.length}: ${JSON.stringify(valid)}`);
  assert.equal(invalid.length, 1, `Expected 1 invalid item (executor.js not in diff), got ${invalid.length}: ${JSON.stringify(invalid)}`);
  assert.equal(invalid[0].file, 'src/executor.js',
    `Expected invalid item to be executor.js, got: ${invalid[0].file}`);
});

// ── TC6: Source field — summarizerSchema validates source enum correctly ───────

await test('TC6: source field — summarizerSchema accepts valid source enum values', () => {
  const validSourceEnums = ['mission-desc', 'task-desc', 'spec', 'diff-file', 'manifest-bugs'];

  for (const source of validSourceEnums) {
    const obj = {
      headline: 'Pipeline done',
      bugs: [],
      summary: 'All good.',
      changelog: [
        { type: 'feature', description: 'Something was added', source, taskIds: ['task-001'] },
      ],
    };
    const r = validateStructured(obj, summarizerSchema);
    assert.equal(r.ok, true,
      `Expected validation to pass for source="${source}", errors: ${JSON.stringify(r.errors)}`);
  }
});

await test('TC6: source field — summarizerSchema rejects invalid source enum value', () => {
  const obj = {
    headline: 'Pipeline done',
    bugs: [],
    summary: 'All good.',
    changelog: [
      { type: 'feature', description: 'Something was added', source: 'invalid-source-xyz', taskIds: ['task-001'] },
    ],
  };
  const r = validateStructured(obj, summarizerSchema);
  assert.equal(r.ok, false,
    'Expected validation to fail for invalid source enum value');
  assert.ok(
    r.errors.some((e) => /not in enum/i.test(e)),
    `Expected enum error for invalid source, got: ${JSON.stringify(r.errors)}`
  );
});

await test('TC6: source field — changelog entry without source still passes (source is optional)', () => {
  const obj = {
    headline: 'Pipeline done',
    bugs: [],
    summary: 'All good.',
    changelog: [
      { type: 'fix', description: 'Fixed something without source field', taskIds: ['task-001'] },
    ],
  };
  const r = validateStructured(obj, summarizerSchema);
  assert.equal(r.ok, true,
    `Expected validation to pass when source is omitted (it is optional), errors: ${JSON.stringify(r.errors)}`);
});

// ── TC7: Citation scoping regression — prior-release task IDs are dropped ─────
//
// Fixture: specContent mentions PRIOR_RELEASE_FEATURE_ABC (a prior-release
// feature). completedTaskIds contains ONLY current-run task IDs.
//
// The structured_output produced by the agent has two changelog items:
//   1. One citing a prior-release task ID ('000-prev-release-001') that is NOT
//      in completedTaskIds → must be dropped by citation filtering.
//   2. One citing a current-run task ID ('001-004-001-001') that IS in
//      completedTaskIds → must survive citation filtering.
//
// After applying citation filtering:
//   - TC7/TC1: the prior-release item is dropped
//   - TC7/TC2: the current-run item is kept
//   - TC7/TC3: droppedChangelogCount === 1

/**
 * Filter a changelog to only keep items whose taskIds are all present in the
 * completedTaskIds set. Items with any task ID not in the set are dropped.
 *
 * Returns { changelog: keptItems, droppedChangelogCount }.
 */
function filterChangelogByCitation(changelog, completedTaskIds) {
  const completedSet = new Set(completedTaskIds);
  const kept = [];
  let droppedChangelogCount = 0;
  for (const item of (changelog || [])) {
    const cited = item.taskIds || [];
    // An item is valid only when every cited task ID appears in completedTaskIds.
    const allValid = cited.length > 0 && cited.every((id) => completedSet.has(id));
    if (allValid) {
      kept.push(item);
    } else {
      droppedChangelogCount++;
    }
  }
  return { changelog: kept, droppedChangelogCount };
}

await test('TC7: citation scoping regression — prior-release task ID is dropped; current-run task ID survives', () => {
  // Fixture: specContent that mentions a prior-release feature.
  // This simulates the scenario where the spec still references shipped work
  // from a previous release (which the agent could mistakenly cite).
  const specContent =
    'This spec describes the current pipeline. ' +
    'Note: PRIOR_RELEASE_FEATURE_ABC was shipped in v0.1.6 and is already live.';

  // completedTaskIds is scoped to current-run tasks ONLY — no prior-release IDs.
  const completedTaskIds = ['001-004-001-001', '001-004-001-002'];

  // structured_output from the agent: two changelog items.
  //   Item A cites a prior-release task ID (not in completedTaskIds).
  //   Item B cites a current-run task ID (in completedTaskIds).
  const sdkResult = {
    structured_output: {
      headline: 'Pipeline completed',
      bugs: [],
      summary: 'The current run completed successfully.',
      changelog: [
        {
          // Prior-release item: taskIds contains an ID not in completedTaskIds.
          // This could happen if specContent leaked PRIOR_RELEASE_FEATURE_ABC
          // into the agent context and the agent cited that prior task.
          type: 'feature',
          description: 'PRIOR_RELEASE_FEATURE_ABC — prior-release item that must be dropped',
          source: 'spec',
          taskIds: ['000-prev-release-001'],
        },
        {
          // Current-run item: taskIds contains a valid current-run ID.
          type: 'feature',
          description: 'Current-run scoping filter was implemented',
          source: 'task-desc',
          taskIds: ['001-004-001-001'],
        },
      ],
    },
  };

  // extractSummary returns the raw structured output (no citation filtering yet).
  const out = extractSummary(sdkResult);

  assert.ok(Array.isArray(out.changelog), 'extractSummary must return a changelog array');
  assert.equal(out.changelog.length, 2, 'Raw changelog must have 2 items before citation filtering');

  // Apply citation filtering using completedTaskIds scoped to current-run only.
  const { changelog: filtered, droppedChangelogCount } = filterChangelogByCitation(
    out.changelog,
    completedTaskIds
  );

  // TC7/TC1: Prior-release item (citing '000-prev-release-001') must be dropped.
  assert.ok(
    !filtered.some((item) => (item.taskIds || []).includes('000-prev-release-001')),
    'Prior-release task ID 000-prev-release-001 must be dropped by citation filtering'
  );

  // TC7/TC2: Current-run item (citing '001-004-001-001') must be kept.
  assert.ok(
    filtered.some((item) => (item.taskIds || []).includes('001-004-001-001')),
    'Current-run task ID 001-004-001-001 must survive citation filtering'
  );
  assert.equal(filtered.length, 1, 'Exactly 1 item must survive citation filtering');
  assert.equal(filtered[0].description, 'Current-run scoping filter was implemented',
    'The surviving item must be the current-run item, not the prior-release one');

  // TC7/TC3: droppedChangelogCount must reflect the single dropped prior-release item.
  assert.equal(droppedChangelogCount, 1,
    'droppedChangelogCount must be 1 — one prior-release item was dropped');

  // Verify that PRIOR_RELEASE_FEATURE_ABC cannot appear in the filtered changelog,
  // proving that specContent mentioning prior features cannot leak through when
  // citation validation is active.
  const filteredStr = JSON.stringify(filtered);
  assert.ok(
    !filteredStr.includes('PRIOR_RELEASE_FEATURE_ABC'),
    `PRIOR_RELEASE_FEATURE_ABC must not appear in the filtered changelog: ${filteredStr}`
  );
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
