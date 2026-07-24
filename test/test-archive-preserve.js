/**
 * test-archive-preserve.js — Tests for archive() --preserve flag behaviour.
 *
 * TC1: preserve:true keeps spec.md at projectRoot AND copies it to archive.
 * TC2: default (no preserve) removes spec.md from projectRoot, keeps it in archive.
 * TC3: archive directory file hashes are identical between preserve-on and preserve-off runs.
 *
 * Run: node test/test-archive-preserve.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import crypto from 'crypto';
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
 * Create a temporary project directory with a .harness/state.json
 * populated with sample milestones, a spec file, and harness artifacts.
 * Mirrors the fixture builder from test/test-archive.js exactly so that
 * two calls to makeTmpProject() produce byte-identical inputs.
 *
 * @returns {string} Absolute path to the project root temp dir
 */
function makeTmpProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-integration-'));
  tmpDirs.push(tmpDir);

  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  const specRelPath = 'spec.md';
  fs.writeFileSync(
    path.join(tmpDir, specRelPath),
    '# Test Spec\n\nSample spec content for integration test.',
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

  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'logs', 'test.log'), 'sample log output', 'utf8');

  fs.mkdirSync(path.join(harnessDir, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'snapshots', 'snap.json'), '{}', 'utf8');

  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'state', 'mission-001-001.json'), '{}', 'utf8');

  return tmpDir;
}

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

// ── Helper: compute SHA-256 hash of a file ────────────────────────────────────

function sha256File(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Recursively enumerate all files under a directory.
 * Returns an array of relative paths (using forward slashes).
 *
 * @param {string} dir    - Absolute directory to walk
 * @param {string} [base] - Base path for relative output (defaults to dir)
 * @returns {string[]}
 */
function walkFiles(dir, base) {
  const root = base ?? dir;
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, root));
    } else {
      results.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  return results;
}

// ── TC1: preserve:true keeps spec on disk ────────────────────────────────────

await test('TC1: preserve-true keeps spec on disk', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'preserve-test', { preserve: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDir, 'archive() should return the archive directory path');

  // spec.md must still exist at projectRoot
  const specAtRoot = path.join(projectRoot, 'spec.md');
  assert.ok(
    fs.existsSync(specAtRoot),
    `spec.md should remain at project root when preserve:true, expected: ${specAtRoot}`
  );

  // spec.md must also exist inside the archive dir
  const specInArchive = path.join(archiveDir, 'spec.md');
  assert.ok(
    fs.existsSync(specInArchive),
    `spec.md should exist inside archive dir, expected: ${specInArchive}`
  );
});

// ── TC2: default removes spec from disk ──────────────────────────────────────

await test('TC2: default removes spec from disk', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'no-preserve-test', {}, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDir, 'archive() should return the archive directory path');

  // spec.md must be ABSENT at projectRoot
  const specAtRoot = path.join(projectRoot, 'spec.md');
  assert.ok(
    !fs.existsSync(specAtRoot),
    `spec.md should be removed from project root when preserve is not set, found unexpectedly at: ${specAtRoot}`
  );

  // spec.md must exist inside the archive dir
  const specInArchive = path.join(archiveDir, 'spec.md');
  assert.ok(
    fs.existsSync(specInArchive),
    `spec.md should exist inside archive dir even when removed from root, expected: ${specInArchive}`
  );
});

// ── TC3: archive directory contents byte-identical across preserve toggle ─────

await test('TC3: archive directory contents byte-identical across preserve toggle', async () => {
  // Run two archives with identical fixtures — one with preserve, one without.
  const projectRootOn = makeTmpProject();
  const projectRootOff = makeTmpProject();

  const archiveDirOn = await archive(projectRootOn, 'byte-check', { preserve: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  const archiveDirOff = await archive(projectRootOff, 'byte-check', {}, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDirOn, 'preserve:true archive should return a directory path');
  assert.ok(archiveDirOff, 'preserve:false archive should return a directory path');

  // Enumerate files from both archives and exclude manifest.json and run-report*
  const isExcluded = (relPath) =>
    relPath === 'manifest.json' || relPath === 'report.html' || path.basename(relPath).startsWith('run-report');

  const filesOn = walkFiles(archiveDirOn).filter(f => !isExcluded(f)).sort();
  const filesOff = walkFiles(archiveDirOff).filter(f => !isExcluded(f)).sort();

  assert.deepStrictEqual(
    filesOn,
    filesOff,
    `File list mismatch between preserve-on and preserve-off archives.\n  preserve-on:  ${JSON.stringify(filesOn)}\n  preserve-off: ${JSON.stringify(filesOff)}`
  );

  assert.ok(filesOn.length > 0, 'Expected at least one non-excluded file in each archive');

  // Compare SHA-256 hashes for every file
  const mismatches = [];
  for (const relPath of filesOn) {
    const hashOn = sha256File(path.join(archiveDirOn, relPath));
    const hashOff = sha256File(path.join(archiveDirOff, relPath));
    if (hashOn !== hashOff) {
      mismatches.push({ relPath, hashOn, hashOff });
    }
  }

  assert.strictEqual(
    mismatches.length,
    0,
    `SHA-256 hash mismatch(es) found between preserve-on and preserve-off archives:\n${mismatches.map(m => `  ${m.relPath}: on=${m.hashOn} off=${m.hashOff}`).join('\n')}`
  );
});

// ── TC4: -P short alias produces identical behaviour to --preserve ────────────

await test('TC4: -P short alias keeps spec on disk (same as TC1)', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'preserve-short-alias-test', { P: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDir, 'archive() should return the archive directory path');

  // spec.md must still exist at projectRoot
  const specAtRoot = path.join(projectRoot, 'spec.md');
  assert.ok(
    fs.existsSync(specAtRoot),
    `spec.md should remain at project root when P:true, expected: ${specAtRoot}`
  );

  // spec.md must also exist inside the archive dir
  const specInArchive = path.join(archiveDir, 'spec.md');
  assert.ok(
    fs.existsSync(specInArchive),
    `spec.md should exist inside archive dir, expected: ${specInArchive}`
  );
});

// ── md + json sibling fixture helper ──────────────────────────────────────────

/**
 * Augment a makeTmpProject() root with a sibling spec.json next to spec.md,
 * so both artifacts are present at project root for preserve/unlink symmetry
 * tests. Returns the json content written (for content assertions).
 *
 * @param {string} projectRoot - Root produced by makeTmpProject()
 * @returns {string} the spec.json content written
 */
function addSpecJsonSibling(projectRoot) {
  const jsonContent = JSON.stringify({ goal: 'json sot sibling', sot: true }, null, 2);
  fs.writeFileSync(path.join(projectRoot, 'spec.json'), jsonContent, 'utf8');
  return jsonContent;
}

// ── TC5: preserve:true keeps BOTH spec.md and spec.json on disk + in archive ──

await test('TC5: preserve-true keeps both spec.md and spec.json on disk and in archive', async () => {
  const projectRoot = makeTmpProject();
  const jsonContent = addSpecJsonSibling(projectRoot);

  const archiveDir = await archive(projectRoot, 'preserve-mdjson-test', { preserve: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDir, 'archive() should return the archive directory path');

  // Both originals must remain at project root
  const mdAtRoot = path.join(projectRoot, 'spec.md');
  const jsonAtRoot = path.join(projectRoot, 'spec.json');
  assert.ok(
    fs.existsSync(mdAtRoot),
    `spec.md should remain at project root when preserve:true, expected: ${mdAtRoot}`
  );
  assert.ok(
    fs.existsSync(jsonAtRoot),
    `spec.json should remain at project root when preserve:true, expected: ${jsonAtRoot}`
  );

  // Both artifacts must also exist inside the archive dir
  const mdInArchive = path.join(archiveDir, 'spec.md');
  const jsonInArchive = path.join(archiveDir, 'spec.json');
  assert.ok(
    fs.existsSync(mdInArchive),
    `spec.md should exist inside archive dir, expected: ${mdInArchive}`
  );
  assert.ok(
    fs.existsSync(jsonInArchive),
    `spec.json should exist inside archive dir, expected: ${jsonInArchive}`
  );
  assert.strictEqual(
    fs.readFileSync(jsonInArchive, 'utf8'),
    jsonContent,
    'archived spec.json content should equal the json source content'
  );
});

// ── TC6: default (no preserve) removes BOTH originals, keeps BOTH in archive ──

await test('TC6: default removes both spec.md and spec.json from disk, keeps both in archive', async () => {
  const projectRoot = makeTmpProject();
  const jsonContent = addSpecJsonSibling(projectRoot);

  const archiveDir = await archive(projectRoot, 'no-preserve-mdjson-test', {}, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDir, 'archive() should return the archive directory path');

  // Both originals must be ABSENT at project root
  const mdAtRoot = path.join(projectRoot, 'spec.md');
  const jsonAtRoot = path.join(projectRoot, 'spec.json');
  assert.ok(
    !fs.existsSync(mdAtRoot),
    `spec.md should be removed from project root when preserve is not set, found unexpectedly at: ${mdAtRoot}`
  );
  assert.ok(
    !fs.existsSync(jsonAtRoot),
    `spec.json should be removed from project root when preserve is not set, found unexpectedly at: ${jsonAtRoot}`
  );

  // Both artifacts must exist inside the archive dir
  const mdInArchive = path.join(archiveDir, 'spec.md');
  const jsonInArchive = path.join(archiveDir, 'spec.json');
  assert.ok(
    fs.existsSync(mdInArchive),
    `spec.md should exist inside archive dir even when removed from root, expected: ${mdInArchive}`
  );
  assert.ok(
    fs.existsSync(jsonInArchive),
    `spec.json should exist inside archive dir even when removed from root, expected: ${jsonInArchive}`
  );
  assert.strictEqual(
    fs.readFileSync(jsonInArchive, 'utf8'),
    jsonContent,
    'archived spec.json content should equal the json source content'
  );
});

// ── Cleanup + Summary ─────────────────────────────────────────────────────────

cleanup();

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
