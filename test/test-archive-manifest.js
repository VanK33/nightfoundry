/**
 * test-archive-manifest.js — Unit tests for buildManifest and writeGitignore in archive.js.
 *
 * No Claude auth, no SDK. Pure fs + temp directories.
 * Run: node test/test-archive-manifest.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { buildManifest, writeGitignore, getGitInfo, getUsageData } from '../src/cli/commands/archive.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const sampleState = {
  name: 'My Project',
  spec: 'spec.md',
  startedAt: '2026-01-01T00:00:00.000Z',
  milestones: [
    { id: '001', description: 'First milestone', status: 'complete' },
    { id: '002', description: 'Second milestone', status: 'complete' },
  ],
};

const sampleGitInfo = { head: 'abc1234', status: 'clean' };
const sampleSummaryData = { headline: 'All done', bugs: ['bug-1'], summary: 'Great run.' };
const sampleUsageData = { totalCost: 1.23, totalSessions: 5 };

// ── Tests: buildManifest ──────────────────────────────────────────────────────

test('buildManifest returns object with all required fields', () => {
  const manifest = buildManifest(
    sampleState, '001', 'my-project', '# spec content',
    sampleGitInfo, sampleSummaryData, sampleUsageData
  );

  const requiredFields = [
    'id', 'name', 'seq', 'spec', 'specSnapshot',
    'startedAt', 'archivedAt', 'gitHead', 'gitStatus',
    'models', 'milestones', 'totalCost', 'totalSessions',
    'headline', 'bugs', 'summary',
  ];

  for (const field of requiredFields) {
    assert.ok(Object.prototype.hasOwnProperty.call(manifest, field),
      `Missing required field: ${field}`);
  }
});

test("buildManifest.id format is '{seq}-{slug}'", () => {
  const manifest = buildManifest(
    sampleState, '007', 'cool-slug', '# spec',
    sampleGitInfo, sampleSummaryData, sampleUsageData
  );
  assert.strictEqual(manifest.id, '007-cool-slug');
});

test('buildManifest.archivedAt is a valid ISO timestamp', () => {
  const before = Date.now();
  const manifest = buildManifest(
    sampleState, '001', 'slug', '# spec',
    sampleGitInfo, sampleSummaryData, sampleUsageData
  );
  const after = Date.now();

  const parsed = Date.parse(manifest.archivedAt);
  assert.ok(!isNaN(parsed), 'archivedAt is not a valid date');
  // Should round-trip through ISO string
  assert.strictEqual(new Date(manifest.archivedAt).toISOString(), manifest.archivedAt,
    'archivedAt is not a valid ISO string');
  assert.ok(parsed >= before && parsed <= after, 'archivedAt is not within expected range');
});

test('buildManifest.milestones is array extracted from state', () => {
  const manifest = buildManifest(
    sampleState, '001', 'slug', '# spec',
    sampleGitInfo, sampleSummaryData, sampleUsageData
  );

  assert.ok(Array.isArray(manifest.milestones), 'milestones should be an array');
  assert.strictEqual(manifest.milestones.length, sampleState.milestones.length);
  assert.deepStrictEqual(manifest.milestones, sampleState.milestones);
});

test('buildManifest.milestones defaults to [] when state has none', () => {
  const stateWithoutMilestones = { name: 'test', spec: 'spec.md' };
  const manifest = buildManifest(
    stateWithoutMilestones, '001', 'slug', '# spec',
    sampleGitInfo, sampleSummaryData, sampleUsageData
  );
  assert.ok(Array.isArray(manifest.milestones));
  assert.strictEqual(manifest.milestones.length, 0);
});

// ── Tests: writeGitignore ─────────────────────────────────────────────────────

test('writeGitignore creates .gitignore with exactly 4 entries', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  try {
    writeGitignore(tmpDir);

    const gitignorePath = path.join(tmpDir, '.gitignore');
    assert.ok(fs.existsSync(gitignorePath), '.gitignore was not created');

    const content = fs.readFileSync(gitignorePath, 'utf8');
    // Split by newlines, filter empty trailing line AND comment lines (gitignore
    // file includes a header-comment block that isn't an "entry" per se).
    const entries = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
    assert.strictEqual(entries.length, 4,
      `Expected 4 entries, got ${entries.length}: ${JSON.stringify(entries)}`);

    // Verify the 4 expected entries
    assert.ok(entries.includes('logs/'), 'Missing logs/ entry');
    assert.ok(entries.includes('snapshots/'), 'Missing snapshots/ entry');
    assert.ok(entries.includes('progress/'), 'Missing progress/ entry');
    assert.ok(entries.includes('analysis/'), 'Missing analysis/ entry');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Tests: getGitInfo ─────────────────────────────────────────────────────────

test('getGitInfo returns gitHead and gitStatus strings for a valid git repo', () => {
  // Run from the project root which is a git repository
  const result = getGitInfo(process.cwd());

  assert.ok(typeof result.gitHead === 'string', 'gitHead should be a string');
  assert.ok(typeof result.gitStatus === 'string', 'gitStatus should be a string');
  assert.ok(result.gitHead.length > 0, 'gitHead should be non-empty');
  assert.ok(
    result.gitStatus === 'clean' || result.gitStatus === 'dirty',
    `gitStatus should be 'clean' or 'dirty', got: ${result.gitStatus}`
  );
});

test("getGitInfo returns 'unknown' values when git fails", () => {
  // Pass a non-existent directory to force git failure
  const result = getGitInfo('/nonexistent/path/that/has/no/git');

  assert.strictEqual(result.gitHead, 'unknown', 'gitHead should be "unknown" on failure');
  assert.strictEqual(result.gitStatus, 'unknown', 'gitStatus should be "unknown" on failure');
});

// ── Tests: getUsageData ───────────────────────────────────────────────────────

test('getUsageData returns zeros when token-usage.json is missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
  try {
    const result = getUsageData(tmpDir);

    assert.strictEqual(result.totalCost, 0, 'totalCost should default to 0');
    assert.strictEqual(result.totalSessions, 0, 'totalSessions should default to 0');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getUsageData reads totals.totalCostUsd/sessionCount (TokenTracker-shaped)', () => {
  // The real schema (from TokenTracker.save()) is
  //   { sessions: [...], totals: {totalCostUsd, sessionCount, ...}, updatedAt }
  // The old version of this test used a hand-authored {totalCost, totalSessions}
  // shape that didn't match reality, which let Bug 5 ship in dogfood 3 (every
  // archive manifest had totalCost=0 and totalSessions=0). Fixture now mirrors
  // the real TokenTracker output. This is the ARCHITECTURE.md Rule 6 lesson
  // (fixtures from real code execution, not spec descriptions) made concrete.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
  try {
    const logsDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, 'token-usage.json'),
      JSON.stringify({
        sessions: [],
        totals: {
          sessionCount: 12,
          totalCostUsd: 4.56,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreation: 0,
          cacheRead: 0,
        },
        updatedAt: '2026-04-09T00:00:00.000Z',
      }),
      'utf8'
    );

    const result = getUsageData(tmpDir);

    assert.strictEqual(result.totalCost, 4.56, 'totalCost should be parsed from totals.totalCostUsd');
    assert.strictEqual(result.totalSessions, 12, 'totalSessions should be parsed from totals.sessionCount');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
