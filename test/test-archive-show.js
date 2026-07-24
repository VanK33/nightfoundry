/**
 * test-archive-show.js — Unit tests for archiveShow in archive-show.js.
 *
 * Covers SC-3 (valid ID shows details) and SC-4 (invalid ID shows error + available IDs).
 * No Claude auth, no SDK. Pure fs + temp directories.
 * Run: node test/test-archive-show.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { archiveShow } from '../src/cli/commands/archive-show.js';

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

// ── stdout/stderr capture helper ──────────────────────────────────────────────

function captureOutput(fn) {
  const outChunks = [];
  const errChunks = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);

  process.stdout.write = (chunk, ...args) => {
    outChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk, ...args) => {
    errChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => {
    outChunks.push(args.join(' ') + '\n');
  };
  console.error = (...args) => {
    errChunks.push(args.join(' ') + '\n');
  };

  try {
    fn();
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
  }

  return {
    stdout: outChunks.join(''),
    stderr: errChunks.join(''),
  };
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

const SAMPLE_MANIFEST = {
  id: '001-my-project',
  name: 'My Project',
  seq: '001',
  spec: 'spec.md',
  specSnapshot: '# spec content',
  startedAt: '2026-01-01T00:00:00.000Z',
  archivedAt: '2026-04-10T12:00:00.000Z',
  gitHead: 'abc1234',
  gitStatus: 'clean',
  models: [],
  milestones: [
    { id: '001', description: 'First milestone', status: 'complete' },
    { id: '002', description: 'Second milestone', status: 'complete' },
  ],
  totalCost: 1.23,
  totalSessions: 5,
  headline: 'All done',
  bugs: ['bug-1', 'bug-2'],
  summary: 'Great run. Everything worked.',
};

function makeProjectWithArchive(manifest, archiveId) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-show-test-'));
  const archivesDir = path.join(tmpDir, 'archives');
  const archiveDir = path.join(archivesDir, archiveId);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return tmpDir;
}

function makeProjectWithArchivesDir(archiveIds = []) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-show-test-'));
  const archivesDir = path.join(tmpDir, 'archives');
  for (const id of archiveIds) {
    const archiveDir = path.join(archivesDir, id);
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'manifest.json'), JSON.stringify({ id }, null, 2), 'utf8');
  }
  return tmpDir;
}

// ── TC1: SC-3 — valid archive ID prints detailed view ────────────────────────

test('TC1: SC-3 valid archive ID shows Archive header line', () => {
  const tmpDir = makeProjectWithArchive(SAMPLE_MANIFEST, '001-my-project');
  try {
    const { stdout } = captureOutput(() => archiveShow(tmpDir, '001-my-project'));
    assert.ok(stdout.includes('Archive: 001-my-project'), `Expected "Archive: 001-my-project" in output, got:\n${stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC1: SC-3 valid archive ID shows archivedAt date', () => {
  const tmpDir = makeProjectWithArchive(SAMPLE_MANIFEST, '001-my-project');
  try {
    const { stdout } = captureOutput(() => archiveShow(tmpDir, '001-my-project'));
    assert.ok(stdout.includes('2026-04-10T12:00:00.000Z'), `Expected archivedAt timestamp in output, got:\n${stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC1: SC-3 valid archive ID shows git info', () => {
  const tmpDir = makeProjectWithArchive(SAMPLE_MANIFEST, '001-my-project');
  try {
    const { stdout } = captureOutput(() => archiveShow(tmpDir, '001-my-project'));
    assert.ok(stdout.includes('abc1234'), `Expected gitHead "abc1234" in output, got:\n${stdout}`);
    assert.ok(stdout.includes('clean'), `Expected gitStatus "clean" in output, got:\n${stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC1: SC-3 valid archive ID shows cost and sessions', () => {
  const tmpDir = makeProjectWithArchive(SAMPLE_MANIFEST, '001-my-project');
  try {
    const { stdout } = captureOutput(() => archiveShow(tmpDir, '001-my-project'));
    assert.ok(stdout.includes('$1.23'), `Expected cost "$1.23" in output, got:\n${stdout}`);
    assert.ok(stdout.includes('5'), `Expected sessions "5" in output, got:\n${stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC1: SC-3 valid archive ID shows Milestones section', () => {
  const tmpDir = makeProjectWithArchive(SAMPLE_MANIFEST, '001-my-project');
  try {
    const { stdout } = captureOutput(() => archiveShow(tmpDir, '001-my-project'));
    assert.ok(stdout.includes('Milestones:'), `Expected "Milestones:" in output, got:\n${stdout}`);
    assert.ok(stdout.includes('First milestone'), `Expected milestone description in output, got:\n${stdout}`);
    assert.ok(stdout.includes('complete'), `Expected milestone status in output, got:\n${stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC1: SC-3 valid archive ID shows Summary section', () => {
  const tmpDir = makeProjectWithArchive(SAMPLE_MANIFEST, '001-my-project');
  try {
    const { stdout } = captureOutput(() => archiveShow(tmpDir, '001-my-project'));
    assert.ok(stdout.includes('Summary:'), `Expected "Summary:" in output, got:\n${stdout}`);
    assert.ok(stdout.includes('Great run. Everything worked.'), `Expected summary text in output, got:\n${stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC1: SC-3 valid archive ID shows Bugs section', () => {
  const tmpDir = makeProjectWithArchive(SAMPLE_MANIFEST, '001-my-project');
  try {
    const { stdout } = captureOutput(() => archiveShow(tmpDir, '001-my-project'));
    assert.ok(stdout.includes('Bugs:'), `Expected "Bugs:" in output, got:\n${stdout}`);
    assert.ok(stdout.includes('bug-1'), `Expected "bug-1" in output, got:\n${stdout}`);
    assert.ok(stdout.includes('bug-2'), `Expected "bug-2" in output, got:\n${stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC2: SC-4 — invalid archive ID prints error and lists available IDs ───────

test('TC2: SC-4 invalid archive ID prints "Archive not found" error', () => {
  const tmpDir = makeProjectWithArchivesDir(['001-foo', '002-bar']);
  try {
    const { stderr } = captureOutput(() => archiveShow(tmpDir, 'nonexistent-id'));
    assert.ok(stderr.includes('Archive not found: nonexistent-id'), `Expected "Archive not found: nonexistent-id" in stderr, got:\n${stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC2: SC-4 invalid archive ID lists available archive IDs', () => {
  const tmpDir = makeProjectWithArchivesDir(['001-foo', '002-bar']);
  try {
    const { stderr } = captureOutput(() => archiveShow(tmpDir, 'nonexistent-id'));
    assert.ok(stderr.includes('Available archives:'), `Expected "Available archives:" in stderr, got:\n${stderr}`);
    assert.ok(stderr.includes('001-foo'), `Expected "001-foo" in stderr listing, got:\n${stderr}`);
    assert.ok(stderr.includes('002-bar'), `Expected "002-bar" in stderr listing, got:\n${stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC3: JSON mode outputs raw manifest object ────────────────────────────────

test('TC3: --json outputs valid JSON to stdout', () => {
  const tmpDir = makeProjectWithArchive(SAMPLE_MANIFEST, '001-my-project');
  try {
    const { stdout } = captureOutput(() => archiveShow(tmpDir, '001-my-project', { json: true }));
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      throw new Error(`Expected valid JSON output, got parse error: ${e.message}\nOutput: ${stdout}`);
    }
    assert.ok(parsed !== null && typeof parsed === 'object', 'Expected parsed JSON to be an object');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC3: --json output matches original manifest', () => {
  const tmpDir = makeProjectWithArchive(SAMPLE_MANIFEST, '001-my-project');
  try {
    const { stdout } = captureOutput(() => archiveShow(tmpDir, '001-my-project', { json: true }));
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.id, SAMPLE_MANIFEST.id, 'Expected id to match manifest');
    assert.strictEqual(parsed.gitHead, SAMPLE_MANIFEST.gitHead, 'Expected gitHead to match manifest');
    assert.strictEqual(parsed.totalCost, SAMPLE_MANIFEST.totalCost, 'Expected totalCost to match manifest');
    assert.deepStrictEqual(parsed.milestones, SAMPLE_MANIFEST.milestones, 'Expected milestones to match manifest');
    assert.deepStrictEqual(parsed.bugs, SAMPLE_MANIFEST.bugs, 'Expected bugs to match manifest');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC3: --json does NOT include human-readable "Archive:" header', () => {
  const tmpDir = makeProjectWithArchive(SAMPLE_MANIFEST, '001-my-project');
  try {
    const { stdout } = captureOutput(() => archiveShow(tmpDir, '001-my-project', { json: true }));
    assert.ok(!stdout.includes('Archive:'), `Expected JSON output to NOT include "Archive:" header, got:\n${stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC4: Missing archives dir prints appropriate error ────────────────────────

test('TC4: missing archives dir prints error to stderr', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-show-nodir-'));
  try {
    // No archives dir created
    const { stderr } = captureOutput(() => archiveShow(tmpDir, 'some-id'));
    assert.ok(
      stderr.includes('Archive not found: some-id') || stderr.includes('No archives'),
      `Expected "Archive not found" or "No archives" in stderr, got:\n${stderr}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TC4: missing archives dir prints "No archives directory found" message', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-show-nodir-'));
  try {
    const { stderr } = captureOutput(() => archiveShow(tmpDir, 'some-id'));
    assert.ok(
      stderr.includes('No archives directory found'),
      `Expected "No archives directory found" in stderr, got:\n${stderr}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
