/**
 * test-archive-failed.js — Integration tests for the --include-failed archive path.
 *
 * Tests the scenario where archive() is called on a halted (non-terminal) run
 * with the { 'include-failed': true } flag, producing a failed-NNN-slug/ archive
 * directory with halt metadata in manifest.json.
 *
 * Uses mocked summarizer and git dependencies to test the full archive flow
 * without Claude auth or an actual git repo.
 * Run: node test/test-archive-failed.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

// ── Imports ───────────────────────────────────────────────────────────────────
// Use dynamic import to handle the case where detectHaltInfo and copySpecToArchive
// are not yet exported (they will be added in mission 001-002). Static named-import
// of a non-existent export throws SyntaxError at module evaluation time; dynamic
// import returns the module namespace object, so missing properties are simply
// undefined rather than an error.

const archiveMod = await import('../src/cli/commands/archive.js');
const { archive, computeSeq, buildManifest } = archiveMod;
/** @type {Function|undefined} */
const detectHaltInfo = archiveMod.detectHaltInfo;
/** @type {Function|undefined} */
const copySpecToArchive = archiveMod.copySpecToArchive;

const { SUBDIRS, PER_RUN_SUBDIRS, SHARED_SUBDIRS } = await import('../src/orchestrator/core/bootstrap.js');

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
 * Remove all temp directories created during the test run.
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

/**
 * Create a temporary project directory representing a halted run.
 *
 * State characteristics:
 *   - globalStatus = 'active'   (run never reached completion)
 *   - milestones: one entry with status 'in-progress'
 *   - spec.md present at project root
 *   - Harness artifacts: logs/, snapshots/, state/ (non-empty so they are moved)
 *
 * When haltType is provided, a JSON sidecar is written into .harness/analysis/
 * to let detectHaltInfo identify the halt cause:
 *   - 'circuit-breaker' → analysis/circuit-breaker-001-001-001-001.json
 *   - 'reviewer-stop'   → analysis/reviewer-stop-001-001-001-001.json
 *
 * @param {'circuit-breaker'|'reviewer-stop'|null} haltType
 * @returns {string} Absolute path to the project root temp dir
 */
function makeTmpProjectHalted(haltType) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-halted-'));
  tmpDirs.push(tmpDir);

  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  // Write spec file referenced by state.json
  const specRelPath = 'spec.md';
  fs.writeFileSync(
    path.join(tmpDir, specRelPath),
    '# Halted Run Spec\n\nSpec content for halted-run integration test.',
    'utf8'
  );

  // Build state.json with one in-progress milestone
  const state = {
    name: 'Halted Project',
    spec: specRelPath,
    startedAt: '2026-05-01T00:00:00.000Z',
    globalStatus: 'active',
    milestones: {
      '001': {
        id: '001',
        description: 'In-progress milestone',
        status: 'in-progress',
        missions: {
          '001-001': {
            id: '001-001',
            description: 'First mission',
            status: 'in-progress',
          },
        },
      },
    },
    projectMeta: {
      currentPhase: 'active',
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(state, null, 2),
    'utf8'
  );

  // Create harness artifacts so moveHarnessToArchive has real entries to move
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'logs', 'run.log'), 'halted run log output', 'utf8');

  fs.mkdirSync(path.join(harnessDir, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'snapshots', 'snap.json'), '{}', 'utf8');

  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'state', 'mission-001-001.json'), '{}', 'utf8');

  // Optionally populate .harness/analysis/ with halt-cause sidecar
  if (haltType === 'circuit-breaker') {
    const analysisDir = path.join(harnessDir, 'analysis');
    fs.mkdirSync(analysisDir, { recursive: true });
    const haltFile = {
      type: 'circuit-breaker',
      taskId: '001-001-001-001',
      reason: 'Circuit breaker tripped after max retries exhausted',
      recommendation: 'human',
      affectedTasks: [{ taskId: '001-001-001-001', action: 'needs_revalidation' }],
    };
    fs.writeFileSync(
      path.join(analysisDir, 'circuit-breaker-001-001-001-001.json'),
      JSON.stringify(haltFile, null, 2),
      'utf8'
    );
  } else if (haltType === 'reviewer-stop') {
    const analysisDir = path.join(harnessDir, 'analysis');
    fs.mkdirSync(analysisDir, { recursive: true });
    const haltFile = {
      type: 'reviewer-stop',
      taskId: '001-001-001-001',
      reason: 'Reviewer required human intervention after repeated failures',
      recommendation: 'human',
      affectedTasks: [{ taskId: '001-001-001-001', action: 'needs_revalidation' }],
    };
    fs.writeFileSync(
      path.join(analysisDir, 'reviewer-stop-001-001-001-001.json'),
      JSON.stringify(haltFile, null, 2),
      'utf8'
    );
  }

  return tmpDir;
}

// ── Mock dependencies ─────────────────────────────────────────────────────────

const mockSummarize = async () => ({
  headline: 'Halted run archived',
  bugs: [],
  summary: 'Run halted mid-flight; archived with halt metadata.',
});

const mockGetGitInfo = () => ({
  gitHead: 'abc1234567890abcdef',
  gitStatus: 'clean',
});

// ── Scenario 1 tests: --include-failed + circuit-breaker-halted state ─────────

// TC-failed-1a: archive with --include-failed on a circuit-breaker-halted run
// produces a directory matching /^failed-\d{3}-/ under archives/, with a
// manifest.json containing haltReason='circuit-breaker' and a non-null haltTaskId.
await test(
  'TC-failed-1a: --include-failed + circuit-breaker halt → failed-NNN-slug/ dir with haltReason+haltTaskId in manifest',
  async () => {
    const projectRoot = makeTmpProjectHalted('circuit-breaker');

    const archiveDir = await archive(
      projectRoot,
      'halted-cb-test',
      { 'include-failed': true },
      {
        summarize: mockSummarize,
        getGitInfo: mockGetGitInfo,
        // Allow archive to proceed past the incomplete-milestone prompt until
        // include-failed is implemented (at which point the prompt is bypassed).
        promptYesNo: async () => true,
      }
    );

    assert.ok(archiveDir, 'archive() should return the archive directory path');
    assert.ok(fs.existsSync(archiveDir), `Archive directory should exist at: ${archiveDir}`);

    // Directory name must be under archives/ and match /^failed-\d{3}-/
    const expectedArchivesDir = path.join(projectRoot, 'archives');
    assert.ok(
      archiveDir.startsWith(expectedArchivesDir),
      `Archive dir should be under archives/, got: ${archiveDir}`
    );
    const dirName = path.basename(archiveDir);
    assert.ok(
      /^failed-\d{3}-/.test(dirName),
      `Archive dir name should match /^failed-\\d{3}-/, got: '${dirName}'`
    );

    // manifest.json must exist and contain haltReason + haltTaskId
    const manifestPath = path.join(archiveDir, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest.json should exist in failed archive dir');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(
      manifest.haltReason,
      'circuit-breaker',
      `manifest.haltReason should be 'circuit-breaker', got: '${manifest.haltReason}'`
    );
    assert.ok(
      manifest.haltTaskId !== null && manifest.haltTaskId !== undefined,
      `manifest.haltTaskId should be non-null, got: ${JSON.stringify(manifest.haltTaskId)}`
    );
  }
);

// TC-failed-1b: The failed archive directory must contain spec.md with the original spec content.
await test(
  'TC-failed-1b: failed archive dir contains spec.md with original spec content',
  async () => {
    const projectRoot = makeTmpProjectHalted('circuit-breaker');

    // Record original spec content before archiving
    const originalSpecContent = fs.readFileSync(path.join(projectRoot, 'spec.md'), 'utf8');

    const archiveDir = await archive(
      projectRoot,
      'halted-spec-test',
      { 'include-failed': true },
      {
        summarize: mockSummarize,
        getGitInfo: mockGetGitInfo,
        // Allow archive to proceed past the incomplete-milestone prompt until
        // include-failed is implemented (at which point the prompt is bypassed).
        promptYesNo: async () => true,
      }
    );

    assert.ok(archiveDir, 'archive() should return the archive directory path');

    const archivedSpecPath = path.join(archiveDir, 'spec.md');
    assert.ok(
      fs.existsSync(archivedSpecPath),
      `spec.md should exist inside the failed archive dir at: ${archivedSpecPath}`
    );

    const archivedSpecContent = fs.readFileSync(archivedSpecPath, 'utf8');
    assert.strictEqual(
      archivedSpecContent,
      originalSpecContent,
      'spec.md in archive dir should contain the original spec content'
    );
  }
);

// TC-failed-1c: After archive(), .harness/state.json does NOT exist,
// and every SUBDIRS entry exists as an empty directory under .harness/.
await test(
  'TC-failed-1c: after failed archive, .harness/state.json gone + all SUBDIRS exist empty',
  async () => {
    const projectRoot = makeTmpProjectHalted('circuit-breaker');

    await archive(
      projectRoot,
      'halted-reset-test',
      { 'include-failed': true },
      {
        summarize: mockSummarize,
        getGitInfo: mockGetGitInfo,
        // Allow archive to proceed past the incomplete-milestone prompt until
        // include-failed is implemented (at which point the prompt is bypassed).
        promptYesNo: async () => true,
      }
    );

    const harnessDir = path.join(projectRoot, '.harness');

    // state.json must NOT exist — it should have been moved into the archive
    const stateJsonPath = path.join(harnessDir, 'state.json');
    assert.ok(
      !fs.existsSync(stateJsonPath),
      '.harness/state.json should NOT exist after failed archive (moved into archive dir)'
    );

    // Post-flip reinit contract: only the SHARED skeleton is recreated at
    // the root; per-run subdirs live inside each run's .harness/run-{id}/
    // and must NOT reappear at the root after the failed-archive reinit.
    for (const sub of SHARED_SUBDIRS) {
      const subPath = path.join(harnessDir, sub);
      assert.ok(
        fs.existsSync(subPath),
        `shared subdir '${sub}' should exist under .harness/ after failed archive`
      );
      assert.ok(
        fs.statSync(subPath).isDirectory(),
        `shared subdir '${sub}' should be a directory, not a file`
      );
    }
    for (const sub of PER_RUN_SUBDIRS) {
      assert.ok(
        !fs.existsSync(path.join(harnessDir, sub)),
        `per-run subdir '${sub}' should NOT be recreated at the .harness/ root by the failed-archive reinit`
      );
    }
  }
);

// ── Scenario 2: halted state WITHOUT --include-failed (auto mode) ─────────────

// TC-failed-2: halted state + {auto: true} (no --include-failed) → validateArchivable
// auto-mode logs a warning and proceeds; archive dir name matches /^\d{3}-/ (normal
// NNN-slug pattern, NOT failed- prefix), confirming current behavior is preserved.
await test(
  'TC-failed-2: halted state + auto mode (no --include-failed) → normal NNN-slug archive dir (no failed- prefix)',
  async () => {
    const projectRoot = makeTmpProjectHalted('circuit-breaker');

    const archiveDir = await archive(
      projectRoot,
      'halted-auto-mode-test',
      { auto: true },
      {
        summarize: mockSummarize,
        getGitInfo: mockGetGitInfo,
      }
    );

    assert.ok(archiveDir, 'archive() should return the archive directory path');
    assert.ok(fs.existsSync(archiveDir), `Archive directory should exist at: ${archiveDir}`);

    // Directory must be under archives/
    const expectedArchivesDir = path.join(projectRoot, 'archives');
    assert.ok(
      archiveDir.startsWith(expectedArchivesDir),
      `Archive dir should be under archives/, got: ${archiveDir}`
    );

    // Dir name must match normal NNN-slug format, NOT failed- prefix
    const dirName = path.basename(archiveDir);
    assert.ok(
      /^\d{3}-/.test(dirName),
      `Archive dir name should match /^\\d{3}-/, got: '${dirName}'`
    );
    assert.ok(
      !/^failed-/.test(dirName),
      `Archive dir name must NOT start with 'failed-' in auto mode without --include-failed, got: '${dirName}'`
    );
  }
);

// ── Scenario 3: successful run → manifest has no haltReason/haltTaskId ────────

/**
 * Create a temporary project directory representing a fully completed run.
 * All milestones have status 'complete'. No halt sidecar files.
 *
 * @returns {string} Absolute path to the project root temp dir
 */
function makeTmpProjectSuccess() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-success-'));
  tmpDirs.push(tmpDir);

  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  const specRelPath = 'spec.md';
  fs.writeFileSync(
    path.join(tmpDir, specRelPath),
    '# Successful Run Spec\n\nSpec content for a fully completed run.',
    'utf8'
  );

  const state = {
    name: 'Successful Project',
    spec: specRelPath,
    startedAt: '2026-05-01T00:00:00.000Z',
    globalStatus: 'active',
    milestones: {
      '001': {
        id: '001',
        description: 'Completed milestone',
        status: 'complete',
        missions: {},
      },
      '002': {
        id: '002',
        description: 'Another completed milestone',
        status: 'complete',
        missions: {},
      },
    },
    projectMeta: {
      currentPhase: 'complete',
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(state, null, 2),
    'utf8'
  );

  // Minimal harness artifacts for the move step
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'logs', 'run.log'), 'successful run log', 'utf8');

  fs.mkdirSync(path.join(harnessDir, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'snapshots', 'snap.json'), '{}', 'utf8');

  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'state', 'mission-001-001.json'), '{}', 'utf8');

  return tmpDir;
}

// TC-failed-3: successful run archive → manifest.json does NOT contain haltReason
// or haltTaskId keys (they are only present when archive is called with --include-failed
// on a halted run).
await test(
  'TC-failed-3: successful run archive → manifest.json has no haltReason or haltTaskId keys',
  async () => {
    const projectRoot = makeTmpProjectSuccess();

    const archiveDir = await archive(
      projectRoot,
      'successful-run-test',
      { auto: true },
      {
        summarize: mockSummarize,
        getGitInfo: mockGetGitInfo,
      }
    );

    assert.ok(archiveDir, 'archive() should return the archive directory path');

    const manifestPath = path.join(archiveDir, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest.json should exist in archive dir');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.ok(
      !('haltReason' in manifest),
      `manifest.json must NOT contain haltReason for a successful run, got: ${JSON.stringify(manifest.haltReason)}`
    );
    assert.ok(
      !('haltTaskId' in manifest),
      `manifest.json must NOT contain haltTaskId for a successful run, got: ${JSON.stringify(manifest.haltTaskId)}`
    );
  }
);

// ── Scenario 4: --include-failed + missing spec file → graceful skip ──────────

/**
 * Create a temporary project directory representing a halted run where the
 * spec file referenced by state.json does NOT exist on disk.
 *
 * @returns {string} Absolute path to the project root temp dir
 */
function makeTmpProjectHaltedNoSpec() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-halted-nospec-'));
  tmpDirs.push(tmpDir);

  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  // state.json references a spec path that does NOT exist on disk
  const state = {
    name: 'Halted Project No Spec',
    spec: 'spec.md',    // references spec.md, but we won't create the file
    startedAt: '2026-05-01T00:00:00.000Z',
    globalStatus: 'active',
    milestones: {
      '001': {
        id: '001',
        description: 'In-progress milestone',
        status: 'in-progress',
        missions: {
          '001-001': {
            id: '001-001',
            description: 'First mission',
            status: 'in-progress',
          },
        },
      },
    },
    projectMeta: {
      currentPhase: 'active',
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(state, null, 2),
    'utf8'
  );

  // Harness artifacts for the move step (no spec.md written here)
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'logs', 'run.log'), 'halted run no spec log', 'utf8');

  fs.mkdirSync(path.join(harnessDir, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'snapshots', 'snap.json'), '{}', 'utf8');

  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'state', 'mission-001-001.json'), '{}', 'utf8');

  return tmpDir;
}

// TC-failed-4: halted state + --include-failed + missing spec file → archive
// completes without throwing, archive dir exists, spec.md is NOT in archive dir
// (copySpecToArchive gracefully skips when the spec file is absent).
await test(
  'TC-failed-4: --include-failed + missing spec file → archive completes, no spec.md in archive dir',
  async () => {
    const projectRoot = makeTmpProjectHaltedNoSpec();

    // Verify spec.md does NOT exist before calling archive
    const specPath = path.join(projectRoot, 'spec.md');
    assert.ok(
      !fs.existsSync(specPath),
      'Precondition: spec.md must NOT exist at project root before calling archive()'
    );

    let archiveDir;
    let threw = false;
    try {
      archiveDir = await archive(
        projectRoot,
        'halted-nospec-test',
        { 'include-failed': true },
        {
          summarize: mockSummarize,
          getGitInfo: mockGetGitInfo,
          // include-failed doesn't set autoMode; allow proceeding past the prompt
          promptYesNo: async () => true,
        }
      );
    } catch (err) {
      threw = true;
      console.log(`      (threw: ${err.message})`);
    }

    assert.ok(!threw, 'archive() must NOT throw when spec file is missing');
    assert.ok(archiveDir, 'archive() should return the archive directory path');
    assert.ok(fs.existsSync(archiveDir), `Archive directory should exist at: ${archiveDir}`);

    // spec.md must NOT be present inside the archive dir (graceful skip)
    const archivedSpecPath = path.join(archiveDir, 'spec.md');
    assert.ok(
      !fs.existsSync(archivedSpecPath),
      `spec.md must NOT be present in archive dir when source spec file is missing, checked: ${archivedSpecPath}`
    );
  }
);

// ── Scenario 5: --include-failed + haltReason variants ───────────────────────

// TC-failed-5a: halted run with circuit-breaker analysis file → manifest.haltReason === 'circuit-breaker'
await test(
  'TC-failed-5a: circuit-breaker analysis file → manifest.haltReason === circuit-breaker',
  async () => {
    const projectRoot = makeTmpProjectHalted('circuit-breaker');

    const archiveDir = await archive(
      projectRoot,
      'halted-5a-cb',
      { 'include-failed': true },
      {
        summarize: mockSummarize,
        getGitInfo: mockGetGitInfo,
        promptYesNo: async () => true,
      }
    );

    assert.ok(archiveDir, 'archive() should return the archive directory path');
    const manifestPath = path.join(archiveDir, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest.json should exist in failed archive dir');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(
      manifest.haltReason,
      'circuit-breaker',
      `manifest.haltReason should be 'circuit-breaker', got: '${manifest.haltReason}'`
    );
  }
);

// TC-failed-5b: halted run with reviewer-stop analysis file → manifest.haltReason === 'reviewer-stop'
await test(
  'TC-failed-5b: reviewer-stop analysis file → manifest.haltReason === reviewer-stop',
  async () => {
    const projectRoot = makeTmpProjectHalted('reviewer-stop');

    const archiveDir = await archive(
      projectRoot,
      'halted-5b-rs',
      { 'include-failed': true },
      {
        summarize: mockSummarize,
        getGitInfo: mockGetGitInfo,
        promptYesNo: async () => true,
      }
    );

    assert.ok(archiveDir, 'archive() should return the archive directory path');
    const manifestPath = path.join(archiveDir, 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest.json should exist in failed archive dir');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(
      manifest.haltReason,
      'reviewer-stop',
      `manifest.haltReason should be 'reviewer-stop', got: '${manifest.haltReason}'`
    );
  }
);

// ── Scenario 6: computeSeq handles mixed prefixed + unprefixed dirs ───────────

// TC-failed-6: archives/ containing '001-alpha', 'failed-002-beta', '003-gamma'
// → computeSeq returns '004' (correctly reads NNN from both prefixed and unprefixed dirs)
await test(
  'TC-failed-6: computeSeq with mixed 001-alpha + failed-002-beta + 003-gamma → returns 004',
  async () => {
    const archivesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-seq-test-'));
    tmpDirs.push(archivesDir);

    // Create the three mixed-format archive directories
    fs.mkdirSync(path.join(archivesDir, '001-alpha'));
    fs.mkdirSync(path.join(archivesDir, 'failed-002-beta'));
    fs.mkdirSync(path.join(archivesDir, '003-gamma'));

    const seq = computeSeq(archivesDir);
    assert.strictEqual(
      seq,
      '004',
      `computeSeq should return '004', got: '${seq}'`
    );
  }
);

// TC-failed-7: detectHaltInfo identifies milestone-regression-failure from state.json structure.
// This covers the path the pipeline takes when the user declines to proceed past the milestone
// regression gate: no analysis/ sidecar is written, but the milestone is left `in_progress` while
// all its missions are `complete`. Without this detection path, detectHaltInfo falls back to
// `unknown` even though the halt signal is unambiguous in state.json.
await test(
  'TC-failed-7: detectHaltInfo returns regression-failure for milestone in_progress with all-complete missions',
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-halt-regression-'));
    tmpDirs.push(tmpDir);
    const harnessDir = path.join(tmpDir, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const state = {
      globalStatus: 'active',
      milestones: {
        '001': {
          id: '001',
          status: 'in_progress',
          missions: {
            '001-001': { id: '001-001', status: 'complete' },
            '001-002': { id: '001-002', status: 'complete' },
            '001-003': { id: '001-003', status: 'complete' },
          },
        },
      },
    };

    const result = detectHaltInfo(harnessDir, state);
    assert.ok(result, 'detectHaltInfo should return a result object (not null) for halted state');
    assert.strictEqual(
      result.haltReason,
      'regression-failure',
      `Expected 'regression-failure' for milestone in_progress with all-complete missions, got: '${result.haltReason}'`
    );
    assert.strictEqual(
      result.haltTaskId,
      null,
      `Expected null haltTaskId for milestone-regression halt (no single task at fault), got: ${JSON.stringify(result.haltTaskId)}`
    );
  }
);

// TC-failed-5b2: detectHaltInfo returns reviewer-stop (not regression-failure) when both
// a reviewer-stop analysis file AND a milestone-regression structural pattern coexist.
// This proves the strengthened (c++) guard from mission 001-001 correctly skips the
// milestone-regression scan when reviewer-stop is already detected from the analysis dir.
await test(
  'TC-failed-5b2: detectHaltInfo returns reviewer-stop (not regression-failure) when reviewer-stop analysis file coexists with all-complete-missions milestone',
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-halt-5b2-'));
    tmpDirs.push(tmpDir);
    const harnessDir = path.join(tmpDir, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    // Write a reviewer-stop analysis file into .harness/analysis/
    const analysisDir = path.join(harnessDir, 'analysis');
    fs.mkdirSync(analysisDir, { recursive: true });
    const haltFile = { type: 'reviewer-stop', taskId: '001-001-001-001' };
    fs.writeFileSync(
      path.join(analysisDir, 'reviewer-stop-001-001-001-001.json'),
      JSON.stringify(haltFile, null, 2),
      'utf8'
    );

    // State whose milestone is in_progress with all missions complete
    // (this is also the structural pattern for regression-failure)
    const state = {
      globalStatus: 'active',
      milestones: {
        '001': {
          id: '001',
          status: 'in_progress',
          missions: {
            '001-001': { id: '001-001', status: 'complete' },
            '001-002': { id: '001-002', status: 'complete' },
            '001-003': { id: '001-003', status: 'complete' },
          },
        },
      },
    };

    const result = detectHaltInfo(harnessDir, state);
    assert.ok(result, 'detectHaltInfo should return a result object (not null)');
    assert.strictEqual(
      result.haltReason,
      'reviewer-stop',
      `Expected 'reviewer-stop' (analysis file takes priority over structural pattern), got: '${result.haltReason}'`
    );
    assert.strictEqual(
      result.haltTaskId,
      '001-001-001-001',
      `Expected haltTaskId '001-001-001-001' from reviewer-stop analysis file, got: ${JSON.stringify(result.haltTaskId)}`
    );
  }
);

// TC-failed-8: detectHaltInfo returns circuit-breaker (not regression-failure) when both
// a circuit-breaker analysis file AND a milestone-regression structural pattern coexist.
// This proves the (c++) block (milestone-regression scan) is correctly skipped when a
// higher-priority halt signal (analysis file) is already detected.
await test(
  'TC-failed-8: detectHaltInfo returns circuit-breaker (not regression-failure) when circuit-breaker analysis file coexists with all-complete-missions milestone',
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-halt-8-'));
    tmpDirs.push(tmpDir);
    const harnessDir = path.join(tmpDir, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    // Write a circuit-breaker analysis file into .harness/analysis/
    const analysisDir = path.join(harnessDir, 'analysis');
    fs.mkdirSync(analysisDir, { recursive: true });
    const haltFile = { type: 'circuit-breaker', taskId: '001-001-001-001' };
    fs.writeFileSync(
      path.join(analysisDir, 'circuit-breaker-001-001-001-001.json'),
      JSON.stringify(haltFile, null, 2),
      'utf8'
    );

    // State whose milestone is in_progress with all missions complete —
    // this is also the structural pattern that would trigger 'regression-failure'
    // if the analysis-file check did not take priority.
    const state = {
      globalStatus: 'active',
      milestones: {
        '001': {
          id: '001',
          status: 'in_progress',
          missions: {
            '001-001': { id: '001-001', status: 'complete' },
            '001-002': { id: '001-002', status: 'complete' },
            '001-003': { id: '001-003', status: 'complete' },
          },
        },
      },
    };

    const result = detectHaltInfo(harnessDir, state);
    assert.ok(result, 'detectHaltInfo should return a result object (not null)');
    assert.strictEqual(
      result.haltReason,
      'circuit-breaker',
      `Expected 'circuit-breaker' (analysis file takes priority over structural pattern), got: '${result.haltReason}'`
    );
    assert.strictEqual(
      result.haltTaskId,
      '001-001-001-001',
      `Expected haltTaskId '001-001-001-001' from circuit-breaker analysis file, got: ${JSON.stringify(result.haltTaskId)}`
    );
  }
);

// ── Cleanup + Summary ─────────────────────────────────────────────────────────

cleanup();

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
