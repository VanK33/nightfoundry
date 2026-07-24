/**
 * test-archive-pointer.js — Integration tests for the pointer-aware,
 * per-run-scoped archive() flow in archive.js.
 *
 * Builds a temp project with an active-run pointer plus a
 * runHarnessDir/state.json layout (SHARED_SUBDIRS seeded at the flat
 * harness root) and verifies that a successful archive() moves only the
 * per-run artifacts into the archive dir, clears the active-run pointer,
 * and leaves/recreates the shared subdirs at the flat harness root. Also
 * covers the --include-failed forensic archive path.
 *
 * Uses mocked summarizer and git dependencies to test the full archive flow
 * without Claude auth or an actual git repo.
 * Run: node test/test-archive-pointer.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { archive } from '../src/cli/commands/archive.js';
import {
  harnessRoot,
  runHarnessDir,
  claimActiveRun,
  readActiveRunPointer,
  activeRunPointerPath,
  generateRunId,
} from '../src/orchestrator/core/run-context.js';
import { SHARED_SUBDIRS } from '../src/orchestrator/core/bootstrap.js';

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
 * Create a temporary project directory with:
 *   - an active-run pointer (claimActiveRun) referencing a fresh runId
 *   - a runHarnessDir(projectRoot, runId)/state.json populated with sample
 *     milestones, plus per-run artifact subdirs (logs/, snapshots/, state/)
 *   - SHARED_SUBDIRS (learning/, dry-run/, brainstorm/) seeded at the flat
 *     harnessRoot(projectRoot), each with a marker file, so tests can assert
 *     they are left untouched by the move
 *
 * @param {{ milestoneStatus?: string, globalStatus?: string }} [opts]
 * @returns {{ projectRoot: string, runId: string, runDir: string, sharedRoot: string }}
 */
function makeTmpProject(opts = {}) {
  const { milestoneStatus = 'complete', globalStatus } = opts;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-pointer-'));
  tmpDirs.push(tmpDir);

  const runId = generateRunId('test-project');
  const claimed = claimActiveRun(tmpDir, { runId, slug: 'test-project', kind: 'spec' });
  assert.ok(claimed, 'claimActiveRun should succeed for a fresh project');

  const runDir = runHarnessDir(tmpDir, runId);
  fs.mkdirSync(runDir, { recursive: true });

  // Create the spec file referenced by state.json
  const specRelPath = 'spec.md';
  fs.writeFileSync(
    path.join(tmpDir, specRelPath),
    '# Test Spec\n\nSample spec content for pointer-aware archive integration test.',
    'utf8'
  );

  const state = {
    name: 'Test Project',
    spec: specRelPath,
    startedAt: '2026-01-01T00:00:00.000Z',
    milestones: [
      { id: '001', description: 'First milestone', status: milestoneStatus },
    ],
    projectMeta: {
      currentPhase: 'complete',
    },
  };
  if (globalStatus !== undefined) state.globalStatus = globalStatus;
  fs.writeFileSync(
    path.join(runDir, 'state.json'),
    JSON.stringify(state, null, 2),
    'utf8'
  );

  // Populate a subset of PER_RUN_SUBDIRS with real content so
  // moveHarnessToArchive has real entries to move (empty dirs are skipped).
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'logs', 'test.log'), 'sample log output', 'utf8');

  fs.mkdirSync(path.join(runDir, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'snapshots', 'snap.json'), '{}', 'utf8');

  fs.mkdirSync(path.join(runDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state', 'mission-001-001.json'), '{}', 'utf8');

  // Seed the shared subdirs at the flat harness root (sibling of the
  // per-run dir), each with a marker file so we can confirm they survive
  // (are neither moved into the archive nor wiped) across archive().
  const sharedRoot = harnessRoot(tmpDir);
  for (const sub of SHARED_SUBDIRS) {
    const subDir = path.join(sharedRoot, sub);
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'marker.txt'), `${sub} marker`, 'utf8');
  }

  return { projectRoot: tmpDir, runId, runDir, sharedRoot };
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

const mockSummarize = async () => ({
  headline: 'All milestones complete',
  bugs: [],
  summary: 'Test run completed successfully.',
});

const mockGetGitInfo = () => ({
  gitHead: 'abc1234567890abcdef',
  gitStatus: 'clean',
});

// ── Integration tests ─────────────────────────────────────────────────────────

// TC1: per-run artifacts land in archiveDir; learning/dry-run/brainstorm
// remain at the flat harness root (not moved into the archive dir).
await test('TC1: per-run artifacts land in archiveDir; shared subdirs remain at flat harness root', async () => {
  const { projectRoot, sharedRoot } = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'pointer-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDir, 'archive() should return the archive directory path');

  // Per-run artifacts moved into archiveDir.
  assert.ok(
    fs.existsSync(path.join(archiveDir, 'state.json')),
    'state.json should be moved into archive dir'
  );
  assert.ok(
    fs.existsSync(path.join(archiveDir, 'logs')),
    'logs/ directory should be moved into archive dir'
  );
  assert.ok(
    fs.existsSync(path.join(archiveDir, 'snapshots')),
    'snapshots/ directory should be moved into archive dir'
  );
  assert.ok(
    fs.existsSync(path.join(archiveDir, 'state')),
    'state/ directory should be moved into archive dir'
  );

  // Shared subdirs (learning/dry-run/brainstorm) must remain at the flat
  // harness root, and must NOT have been moved into the archive dir.
  for (const sub of SHARED_SUBDIRS) {
    assert.ok(
      fs.existsSync(path.join(sharedRoot, sub)),
      `${sub}/ should remain at the flat harness root after archive`
    );
    assert.ok(
      !fs.existsSync(path.join(archiveDir, sub)),
      `${sub}/ should NOT be moved into the archive dir`
    );
  }
});

// TC2: the active-run pointer file is absent after a successful archive.
await test('TC2: active-run pointer file is absent after a successful archive', async () => {
  const { projectRoot } = makeTmpProject();

  assert.ok(
    readActiveRunPointer(projectRoot),
    'sanity check: pointer should exist before archive'
  );

  await archive(projectRoot, 'pointer-test-2', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.strictEqual(
    readActiveRunPointer(projectRoot),
    null,
    'active-run pointer should be null after a successful archive'
  );
  assert.ok(
    !fs.existsSync(activeRunPointerPath(projectRoot)),
    'active-run pointer file should not exist on disk after a successful archive'
  );
});

// TC3: SHARED_SUBDIRS are recreated under harnessRoot(projectRoot) after archive.
await test('TC3: SHARED_SUBDIRS recreated under harnessRoot(projectRoot) after archive', async () => {
  const { projectRoot, sharedRoot } = makeTmpProject();

  await archive(projectRoot, 'pointer-test-3', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.strictEqual(sharedRoot, harnessRoot(projectRoot), 'sanity check: sharedRoot === harnessRoot(projectRoot)');

  for (const sub of SHARED_SUBDIRS) {
    const subDir = path.join(harnessRoot(projectRoot), sub);
    assert.ok(fs.existsSync(subDir), `${sub}/ should exist under harnessRoot(projectRoot) after archive`);
    assert.ok(fs.statSync(subDir).isDirectory(), `${sub} should be a directory`);
  }

  assert.strictEqual(
    readActiveRunPointer(projectRoot),
    null,
    'active-run pointer should be gone after archive'
  );
});

// TC4: --include-failed archive clears the pointer and preserves shared subdirs.
await test('TC4: --include-failed archive clears the pointer and preserves shared subdirs', async () => {
  // A halted (non-clean-delivery) state: milestone left in_progress with no
  // globalStatus:'complete' so detectHaltInfo() does not treat the run as a
  // normal completion and returns a non-null haltInfo, letting the forensic
  // --include-failed branch proceed.
  const { projectRoot, sharedRoot } = makeTmpProject({ milestoneStatus: 'in_progress' });

  assert.ok(
    readActiveRunPointer(projectRoot),
    'sanity check: pointer should exist before archive'
  );

  const failedArchiveDir = await archive(projectRoot, 'pointer-test-4', { 'include-failed': true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(failedArchiveDir, '--include-failed archive() should return the failed archive dir path');
  assert.ok(
    /^failed-/.test(path.basename(failedArchiveDir)),
    `failed archive dir name should start with 'failed-', got: ${path.basename(failedArchiveDir)}`
  );

  // Pointer cleared.
  assert.strictEqual(
    readActiveRunPointer(projectRoot),
    null,
    'active-run pointer should be null after a --include-failed archive'
  );
  assert.ok(
    !fs.existsSync(activeRunPointerPath(projectRoot)),
    'active-run pointer file should not exist on disk after a --include-failed archive'
  );

  // Shared subdirs preserved (present, and still directories) at the flat
  // harness root — including the original marker files seeded before archive.
  for (const sub of SHARED_SUBDIRS) {
    const subDir = path.join(sharedRoot, sub);
    assert.ok(fs.existsSync(subDir), `${sub}/ should be preserved under harnessRoot(projectRoot) after --include-failed archive`);
    assert.ok(
      fs.existsSync(path.join(subDir, 'marker.txt')),
      `${sub}/marker.txt seeded before archive should still be present`
    );
  }
});

// ── Cleanup + Summary ─────────────────────────────────────────────────────────

cleanup();

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
