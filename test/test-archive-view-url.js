/**
 * test-archive-view-url.js — verifies the "view this run" URL step at the
 * end of a successful archive():
 *
 *   - deps.probeUiReachable resolving `true`  -> a direct
 *     "[archive] View this run: http://localhost:3939/archive-detail.html?id=<archiveDirName>"
 *     line is printed.
 *   - deps.probeUiReachable resolving `false` -> a
 *     "[archive] Run 'cc-orch ui' then open: http://localhost:3939/archive-detail.html?id=<archiveDirName>"
 *     hint line is printed instead, and no "View this run:" line appears.
 *   - deps.probeUiReachable rejecting/throwing -> the same hint line is
 *     printed (rejection treated as unreachable) and archive() still
 *     resolves normally with the archive directory path.
 *
 * The stubbed probe is a plain injected function — no real HTTP listener is
 * ever started and no real network request is made in this file.
 *
 * Run: node test/test-archive-view-url.js
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

const tmpDirs = [];
function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
}

// ── Temp project helper (mirrors test-archive-clean-delivery.js) ─────────────

function makeProjectWithState(milestones, extra = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-view-url-'));
  tmpDirs.push(tmpDir);
  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  const specRelPath = 'spec.md';
  fs.writeFileSync(path.join(tmpDir, specRelPath), '# Test Spec', 'utf8');
  const state = {
    name: 'Test Project',
    spec: specRelPath,
    startedAt: '2026-01-01T00:00:00.000Z',
    milestones,
    projectMeta: { currentPhase: 'complete' },
    ...extra,
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'logs', 'test.log'), 'sample log', 'utf8');
  return tmpDir;
}

const mockGetGitInfo = () => ({ gitHead: 'abc1234567890abcdef', gitStatus: 'clean' });
const mockSummarize = async () => ({ headline: 'Test run', bugs: [], summary: 'Run completed.', changelog: [] });

// Captures console.log/console.warn output while `fn` runs and restores the
// original console methods afterward (even if `fn` throws).
async function captureOutput(fn) {
  const lines = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args) => { lines.push(args.join(' ')); };
  console.warn = (...args) => { lines.push(args.join(' ')); };
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    const result = await fn();
    return { result, output: lines.join('\n') };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
}

const CLEAN_MILESTONES = [
  { id: '001', description: 'First milestone', status: 'complete' },
];

// ── TC1: probe resolves true -> "View this run:" line with exact URL ─────────

await test('TC1: probe resolving true prints "View this run:" with the exact archive-detail URL', async () => {
  const projectRoot = makeProjectWithState(CLEAN_MILESTONES);
  let probeCalls = 0;
  const stubProbe = async () => { probeCalls++; return true; };

  const { result: archiveDir, output } = await captureOutput(() =>
    archive(projectRoot, 'view-url-true', { auto: true, 'skip-test-gate': true }, {
      summarize: mockSummarize,
      getGitInfo: mockGetGitInfo,
      probeUiReachable: stubProbe,
    })
  );

  assert.ok(archiveDir, 'archive() should return the archive directory path');
  assert.strictEqual(probeCalls, 1, 'the stubbed probeUiReachable must be invoked exactly once');

  const archiveDirName = path.basename(archiveDir);
  const expectedUrl = `http://localhost:3939/archive-detail.html?id=${archiveDirName}`;

  assert.ok(
    output.includes('View this run:'),
    `expected output to contain 'View this run:', got:\n${output}`
  );
  assert.ok(
    output.includes(expectedUrl),
    `expected output to contain the exact URL ${expectedUrl}, got:\n${output}`
  );
});

// ── TC2: probe resolves false -> hint line, no "View this run:" ──────────────

await test('TC2: probe resolving false prints the "Run \'cc-orch ui\' then open:" hint and no "View this run:"', async () => {
  const projectRoot = makeProjectWithState(CLEAN_MILESTONES);
  let probeCalls = 0;
  const stubProbe = async () => { probeCalls++; return false; };

  const { result: archiveDir, output } = await captureOutput(() =>
    archive(projectRoot, 'view-url-false', { auto: true, 'skip-test-gate': true }, {
      summarize: mockSummarize,
      getGitInfo: mockGetGitInfo,
      probeUiReachable: stubProbe,
    })
  );

  assert.ok(archiveDir, 'archive() should return the archive directory path');
  assert.strictEqual(probeCalls, 1, 'the stubbed probeUiReachable must be invoked exactly once');

  const archiveDirName = path.basename(archiveDir);
  const expectedUrl = `http://localhost:3939/archive-detail.html?id=${archiveDirName}`;

  assert.ok(
    output.includes("Run 'cc-orch ui' then open:"),
    `expected output to contain the "Run 'cc-orch ui' then open:" hint, got:\n${output}`
  );
  assert.ok(
    output.includes(expectedUrl),
    `expected the hint line to contain the URL ${expectedUrl}, got:\n${output}`
  );
  assert.ok(
    !output.includes('View this run:'),
    `expected output to NOT contain 'View this run:', got:\n${output}`
  );
});

// ── TC3: probe throws/rejects -> hint printed, archive() still resolves ──────

await test('TC3: probe throwing prints the hint line and archive() still resolves with the archive dir', async () => {
  const projectRoot = makeProjectWithState(CLEAN_MILESTONES);
  let probeCalls = 0;
  const stubProbe = async () => { probeCalls++; throw new Error('simulated probe failure'); };

  const { result: archiveDir, output } = await captureOutput(() =>
    archive(projectRoot, 'view-url-throws', { auto: true, 'skip-test-gate': true }, {
      summarize: mockSummarize,
      getGitInfo: mockGetGitInfo,
      probeUiReachable: stubProbe,
    })
  );

  assert.ok(archiveDir, 'archive() should still resolve with the archive directory path when the probe throws');
  assert.ok(fs.existsSync(archiveDir), `archive directory should exist on disk: ${archiveDir}`);
  assert.strictEqual(probeCalls, 1, 'the stubbed probeUiReachable must be invoked exactly once even though it throws');

  const archiveDirName = path.basename(archiveDir);
  const expectedUrl = `http://localhost:3939/archive-detail.html?id=${archiveDirName}`;

  assert.ok(
    output.includes("Run 'cc-orch ui' then open:"),
    `expected output to contain the "Run 'cc-orch ui' then open:" hint even when the probe throws, got:\n${output}`
  );
  assert.ok(
    output.includes(expectedUrl),
    `expected the hint line to contain the URL ${expectedUrl}, got:\n${output}`
  );
  assert.ok(
    !output.includes('View this run:'),
    `expected output to NOT contain 'View this run:' when the probe throws, got:\n${output}`
  );
});

// ── Teardown & report ─────────────────────────────────────────────────────────

cleanup();

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
