/**
 * test-batch-entry-cost.js — Unit tests for usageBaseline clamp logic
 * surfaced through archive()'s emitted manifest.json.
 *
 * No Claude auth, no SDK. Pure fs + temp directories.
 * Run: node test/test-batch-entry-cost.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { archive, buildManifest, getUsageData } from '../src/cli/commands/archive.js';

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

// TokenTracker-shaped token-usage.json totals (matches the real schema).
const sampleUsageData = {
  sessions: [],
  totals: {
    sessionCount: 8,
    totalCostUsd: 5.0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreation: 0,
    cacheRead: 0,
  },
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// ── Temp project helpers ──────────────────────────────────────────────────────

/**
 * Create a minimal temp project dir with a .harness ready for archive().
 * Writes state.json (all milestones complete) and logs/token-usage.json.
 *
 * @returns {string} Absolute path to the project root temp dir
 */
function makeTmpProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-cost-test-'));

  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  // Spec file referenced by state.json
  fs.writeFileSync(
    path.join(tmpDir, 'spec.md'),
    '# Test Spec\n\nSample content.',
    'utf8',
  );

  // state.json — all milestones complete so validateArchivable passes.
  const state = {
    name: 'Batch Cost Test',
    spec: 'spec.md',
    startedAt: '2026-01-01T00:00:00.000Z',
    milestones: [
      { id: '001', description: 'First milestone', status: 'complete' },
    ],
    projectMeta: { currentPhase: 'complete' },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(state, null, 2),
    'utf8',
  );

  // logs/token-usage.json — TokenTracker-shaped with totals {5.0, 8}.
  const logsDir = path.join(harnessDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(logsDir, 'token-usage.json'),
    JSON.stringify(sampleUsageData),
    'utf8',
  );

  return tmpDir;
}

// ── Mock dependencies ─────────────────────────────────────────────────────────

const mockSummarize = async () => ({
  headline: 'Test complete',
  bugs: [],
  summary: 'Batch cost test run.',
  changelog: [],
});

const mockGetGitInfo = () => ({
  gitHead: 'abc1234567890abcdef',
  gitStatus: 'clean',
});

// ── Tests ─────────────────────────────────────────────────────────────────────

// TC1: usage {5.0, 8} minus baseline {3.0, 5} → manifest {2.0, 3}
await test('TC1: baseline-present clamped subtraction (5-3=2, 8-5=3)', async () => {
  const projectRoot = makeTmpProject();
  try {
    const archiveDir = await archive(
      projectRoot,
      'batch-cost-tc1',
      {
        auto: true,
        'skip-test-gate': true,
        usageBaseline: { totalCost: 3.0, totalSessions: 5 },
      },
      {
        summarize: mockSummarize,
        getGitInfo: mockGetGitInfo,
      },
    );

    const manifest = JSON.parse(
      fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8'),
    );

    assert.strictEqual(manifest.totalCost, 2.0,
      `Expected manifest.totalCost === 2.0, got ${manifest.totalCost}`);
    assert.strictEqual(manifest.totalSessions, 3,
      `Expected manifest.totalSessions === 3, got ${manifest.totalSessions}`);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// TC1b: baseline {9, 9} > usage {5.0, 8} → clamped to {0, 0}
await test('TC1b: baseline larger than usage clamps to 0', async () => {
  const projectRoot = makeTmpProject();
  try {
    const archiveDir = await archive(
      projectRoot,
      'batch-cost-tc1b',
      {
        auto: true,
        'skip-test-gate': true,
        usageBaseline: { totalCost: 9, totalSessions: 9 },
      },
      {
        summarize: mockSummarize,
        getGitInfo: mockGetGitInfo,
      },
    );

    const manifest = JSON.parse(
      fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8'),
    );

    assert.strictEqual(manifest.totalCost, 0,
      `Expected manifest.totalCost === 0, got ${manifest.totalCost}`);
    assert.strictEqual(manifest.totalSessions, 0,
      `Expected manifest.totalSessions === 0, got ${manifest.totalSessions}`);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// TC2: no usageBaseline flag → manifest reflects getUsageData unchanged {5.0, 8}
await test('TC2: baseline-absent — manifest equals getUsageData unchanged', async () => {
  const projectRoot = makeTmpProject();
  try {
    // Verify getUsageData returns {5.0, 8} from our fixture (byte-identical check).
    const harnessDir = path.join(projectRoot, '.harness');
    const usageFromFile = getUsageData(harnessDir);
    assert.strictEqual(usageFromFile.totalCost, 5.0,
      `getUsageData should return totalCost 5.0, got ${usageFromFile.totalCost}`);
    assert.strictEqual(usageFromFile.totalSessions, 8,
      `getUsageData should return totalSessions 8, got ${usageFromFile.totalSessions}`);

    const archiveDir = await archive(
      projectRoot,
      'batch-cost-tc2',
      {
        auto: true,
        'skip-test-gate': true,
        // No usageBaseline flag
      },
      {
        summarize: mockSummarize,
        getGitInfo: mockGetGitInfo,
      },
    );

    const manifest = JSON.parse(
      fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8'),
    );

    assert.strictEqual(manifest.totalCost, 5.0,
      `Expected manifest.totalCost === 5.0 (unchanged), got ${manifest.totalCost}`);
    assert.strictEqual(manifest.totalSessions, 8,
      `Expected manifest.totalSessions === 8 (unchanged), got ${manifest.totalSessions}`);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
