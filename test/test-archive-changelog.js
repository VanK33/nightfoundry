/**
 * test-archive-changelog.js — Unit tests for the CHANGELOG.md generation logic
 * inside archive().
 *
 * Uses mocked summarizer returning changelog fixtures, mocked getGitInfo,
 * and temp project directories to exercise three scenarios:
 *   TC1: Fresh project — CHANGELOG.md created with version header, date,
 *        headline, and grouped entries (features/fixes/breaking)
 *   TC2: Existing CHANGELOG.md — new entry prepended, old content preserved
 *   TC3: Empty changelog array — graceful handling, no crash
 *
 * Run: node test/test-archive-changelog.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { archive } from '../src/cli/commands/archive.js';

// ── Test harness ─────────────────────────────────────────────────────────────

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

// ── Temp project helpers ──────────────────────────────────────────────────────

const tmpDirs = [];

/**
 * Create a temporary project directory with all required harness artifacts.
 * All milestones are 'complete' so validateArchivable passes without prompting.
 *
 * @returns {string} Absolute path to the project root temp dir
 */
function makeTmpProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-changelog-'));
  tmpDirs.push(tmpDir);

  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  const specRelPath = 'spec.md';
  fs.writeFileSync(
    path.join(tmpDir, specRelPath),
    '# Test Spec\n\nSample spec content for changelog test.',
    'utf8'
  );

  const state = {
    name: 'Test Project',
    spec: specRelPath,
    startedAt: '2026-01-01T00:00:00.000Z',
    milestones: [
      { id: '001', description: 'First milestone', status: 'complete' },
      { id: '002', description: 'Second milestone', status: 'complete' },
    ],
    projectMeta: {
      currentPhase: 'complete',
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(state, null, 2),
    'utf8'
  );

  // Create harness artifacts so moveHarnessToArchive has entries to move
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'logs', 'test.log'), 'sample log output', 'utf8');

  fs.mkdirSync(path.join(harnessDir, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'snapshots', 'snap.json'), '{}', 'utf8');

  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'state', 'mission-001-001.json'), '{}', 'utf8');

  return tmpDir;
}

/**
 * Remove all temp directories created by makeTmpProject.
 */
function cleanup() {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tmpDirs.length = 0;
}

// ── Mock dependencies ─────────────────────────────────────────────────────────

const mockGetGitInfo = () => ({
  gitHead: 'abc1234567890abcdef',
  gitStatus: 'clean',
});

/**
 * Mock summarizer that returns a full summary with changelog entries.
 * Includes one breaking change, one feature, and one fix.
 */
const mockSummarizeWithChangelog = async () => ({
  headline: 'Trust layer shipped with audit trail',
  bugs: [],
  summary: 'All trust-layer features landed and verified.',
  changelog: [
    { type: 'breaking', description: 'Removed legacy --unsafe flag from CLI' },
    { type: 'feature', description: 'Added hard-contract validation at agent boundaries' },
    { type: 'feature', description: 'Session cost now displayed in run summary' },
    { type: 'fix', description: 'Fixed race condition in mutex acquisition' },
  ],
});

/**
 * Mock summarizer that returns an empty changelog array.
 */
const mockSummarizeEmptyChangelog = async () => ({
  headline: 'Minor internal cleanup',
  bugs: [],
  summary: 'Refactoring only, no user-facing changes.',
  changelog: [],
});

// ── Tests ─────────────────────────────────────────────────────────────────────

// TC1: Fresh project — CHANGELOG.md created with version header, date, headline,
//      and grouped entries (features/fixes/breaking).
await test('TC1: fresh project creates CHANGELOG.md with header, date, headline, and grouped entries', async () => {
  const projectRoot = makeTmpProject();
  const changelogPath = path.join(projectRoot, 'CHANGELOG.md');

  // Confirm no CHANGELOG.md exists before the run
  assert.ok(!fs.existsSync(changelogPath), 'CHANGELOG.md should not exist before archive()');

  await archive(projectRoot, 'changelog-test', { auto: true }, {
    summarize: mockSummarizeWithChangelog,
    getGitInfo: mockGetGitInfo,
  });

  // CHANGELOG.md must now exist
  assert.ok(fs.existsSync(changelogPath), 'CHANGELOG.md should be created by archive()');

  const content = fs.readFileSync(changelogPath, 'utf8');

  // Must contain the version header line (format: ## [version] - YYYY-MM-DD — headline)
  assert.ok(
    /^## \[.+\] - \d{4}-\d{2}-\d{2} — .+/m.test(content),
    `CHANGELOG.md should have a version header matching "## [version] - YYYY-MM-DD — headline", got:\n${content.slice(0, 300)}`
  );

  // Headline must appear in the entry
  assert.ok(
    content.includes('Trust layer shipped with audit trail'),
    `CHANGELOG.md should include the headline, got:\n${content.slice(0, 300)}`
  );

  // Today's date must appear (YYYY-MM-DD)
  const todayStr = new Date().toISOString().slice(0, 10);
  assert.ok(
    content.includes(todayStr),
    `CHANGELOG.md should include today's date (${todayStr}), got:\n${content.slice(0, 300)}`
  );

  // Breaking changes section must be present
  assert.ok(
    content.includes('### Breaking changes'),
    `CHANGELOG.md should have a "### Breaking changes" section`
  );
  assert.ok(
    content.includes('Removed legacy --unsafe flag from CLI'),
    `CHANGELOG.md should include the breaking change description`
  );

  // New features section must be present
  assert.ok(
    content.includes('### New features'),
    `CHANGELOG.md should have a "### New features" section`
  );
  assert.ok(
    content.includes('Added hard-contract validation at agent boundaries'),
    `CHANGELOG.md should include the feature description`
  );
  assert.ok(
    content.includes('Session cost now displayed in run summary'),
    `CHANGELOG.md should include the second feature description`
  );

  // Bug fixes section must be present
  assert.ok(
    content.includes('### Bug fixes'),
    `CHANGELOG.md should have a "### Bug fixes" section`
  );
  assert.ok(
    content.includes('Fixed race condition in mutex acquisition'),
    `CHANGELOG.md should include the fix description`
  );
});

// TC2: Existing CHANGELOG.md — new entry prepended, old content preserved below.
await test('TC2: existing CHANGELOG.md has new entry prepended and old content preserved', async () => {
  const projectRoot = makeTmpProject();
  const changelogPath = path.join(projectRoot, 'CHANGELOG.md');

  const existingContent = `## [0.9.0] - 2026-03-01 — Old release headline\n\n### New features\n- Old feature one\n- Old feature two\n\n`;
  fs.writeFileSync(changelogPath, existingContent, 'utf8');

  await archive(projectRoot, 'prepend-test', { auto: true }, {
    summarize: mockSummarizeWithChangelog,
    getGitInfo: mockGetGitInfo,
  });

  const content = fs.readFileSync(changelogPath, 'utf8');

  // New headline must appear in the file
  assert.ok(
    content.includes('Trust layer shipped with audit trail'),
    `CHANGELOG.md should contain the new headline`
  );

  // Old content must still be present
  assert.ok(
    content.includes('Old release headline'),
    `CHANGELOG.md should preserve the old entry's headline`
  );
  assert.ok(
    content.includes('Old feature one'),
    `CHANGELOG.md should preserve old feature descriptions`
  );

  // New entry must come BEFORE old entry (prepended)
  const newEntryIdx = content.indexOf('Trust layer shipped with audit trail');
  const oldEntryIdx = content.indexOf('Old release headline');
  assert.ok(
    newEntryIdx < oldEntryIdx,
    `New entry (index ${newEntryIdx}) should appear before old entry (index ${oldEntryIdx}) in CHANGELOG.md`
  );
});

// TC3: Empty changelog array — graceful handling, no crash, minimal entry written.
await test('TC3: empty changelog array results in graceful handling — no crash, minimal entry', async () => {
  const projectRoot = makeTmpProject();
  const changelogPath = path.join(projectRoot, 'CHANGELOG.md');

  // Should not throw
  let threw = false;
  try {
    await archive(projectRoot, 'empty-changelog', { auto: true }, {
      summarize: mockSummarizeEmptyChangelog,
      getGitInfo: mockGetGitInfo,
    });
  } catch (err) {
    threw = true;
    console.log(`      Unexpected error: ${err.message}`);
  }

  assert.ok(!threw, 'archive() should not throw when changelog array is empty');

  // CHANGELOG.md should exist (even if minimal — at least the header line)
  assert.ok(
    fs.existsSync(changelogPath),
    'CHANGELOG.md should exist even when changelog array is empty'
  );

  const content = fs.readFileSync(changelogPath, 'utf8');

  // The header line must be written (version header, even with no sections)
  assert.ok(
    /## \[.+\] - \d{4}-\d{2}-\d{2} — /.test(content),
    `CHANGELOG.md should still contain the version header line when changelog is empty`
  );

  // Headline should appear
  assert.ok(
    content.includes('Minor internal cleanup'),
    `CHANGELOG.md should include the headline even when changelog is empty`
  );

  // No section headers should be present (no items to group)
  assert.ok(
    !content.includes('### Breaking changes'),
    `CHANGELOG.md should not have "### Breaking changes" when changelog is empty`
  );
  assert.ok(
    !content.includes('### New features'),
    `CHANGELOG.md should not have "### New features" when changelog is empty`
  );
  assert.ok(
    !content.includes('### Bug fixes'),
    `CHANGELOG.md should not have "### Bug fixes" when changelog is empty`
  );
});

// ── Teardown & report ─────────────────────────────────────────────────────────

cleanup();

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
