/**
 * test-summarizer-scope.js — Tests for getRecentCommits scope logic in archive.js.
 *
 * Verifies that getRecentCommits correctly scopes git log to commits after
 * the prior archive's gitHead, falls back to full capped history when no
 * prior archives exist, and uses the highest-seq archive when multiple exist.
 *
 * Run: node test/test-summarizer-scope.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { execSync } from 'child_process';
import { getRecentCommits } from '../src/cli/commands/archive.js';

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

// ── Temp dir helpers ──────────────────────────────────────────────────────────

const tmpDirs = [];

function makeTmpArchivesDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarizer-scope-'));
  tmpDirs.push(tmpDir);
  return tmpDir;
}

function writeManifest(archivesDir, archiveName, gitHead) {
  const archiveDir = path.join(archivesDir, archiveName);
  fs.mkdirSync(archiveDir, { recursive: true });
  const manifest = {
    id: archiveName,
    seq: archiveName.slice(0, 3),
    gitHead,
    gitStatus: 'clean',
  };
  fs.writeFileSync(
    path.join(archiveDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Use the actual project root as projectRoot — it's a real git repo so
// git commands will succeed. SHAs are resolved at test-run time.
const projectRoot = path.resolve(process.cwd());
const currentHead = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf8' }).trim();
const olderHead = execSync('git rev-parse HEAD~1', { cwd: projectRoot, encoding: 'utf8' }).trim();

// ── TC1: range-scoped — prior archive with gitHead returns only commits in range ──

// When a prior archive exists with gitHead == currentHead, the range
// `<currentHead>..HEAD` is empty (no commits made after the snapshot).
// This proves the function uses the ranged `git log <sha>..HEAD` form.
await test('TC1: range-scoped — prior archive gitHead returns only in-range commits', () => {
  const archivesDir = makeTmpArchivesDir();
  writeManifest(archivesDir, '001-prior-release', currentHead);

  const result = getRecentCommits(projectRoot, archivesDir);

  // Range <currentHead>..HEAD is empty — no commits since the snapshot.
  assert.strictEqual(
    result,
    '',
    `Expected empty range result when gitHead == HEAD, got: ${JSON.stringify(result)}`
  );
});

// ── TC2: first-run fallback — no prior archives returns full capped history ──

// When archivesDir is empty (no prior archives), getRecentCommits falls back
// to `git log --oneline -50`. The real repo has commits, so result is non-empty.
await test('TC2: first-run fallback — no prior archives returns full capped history', () => {
  const archivesDir = makeTmpArchivesDir();
  // archivesDir is empty — no archive entries

  const result = getRecentCommits(projectRoot, archivesDir);

  assert.ok(
    typeof result === 'string' && result.length > 0,
    `Expected non-empty commit log for first-run fallback, got: ${JSON.stringify(result)}`
  );

  // The fallback should return up to 50 commits; verify it includes at least one
  // commit line (format: "<sha> <message>")
  const lines = result.split('\n').filter((l) => l.trim().length > 0);
  assert.ok(
    lines.length >= 1,
    `Expected at least 1 commit line in fallback result, got ${lines.length} lines`
  );
});

// ── TC3: multi-release — highest-seq archive gitHead used, older archives ignored ──

// Two archives exist: 001- (older, gitHead = olderHead) and 002- (newer, gitHead = currentHead).
// getRecentCommits must use 002's gitHead (currentHead), yielding an empty
// range result. If it incorrectly used 001's gitHead (olderHead), the range
// `olderHead..HEAD` would be non-empty.
await test('TC3: multi-release — highest-seq archive gitHead used as range start', () => {
  const archivesDir = makeTmpArchivesDir();
  writeManifest(archivesDir, '001-older-release', olderHead);   // seq 001, older SHA
  writeManifest(archivesDir, '002-latest-release', currentHead); // seq 002, HEAD SHA

  const result = getRecentCommits(projectRoot, archivesDir);

  // If seq 002 (currentHead) is correctly chosen, range is empty.
  // If seq 001 (olderHead) were used instead, range would include at least the latest commit.
  assert.strictEqual(
    result,
    '',
    `Expected empty range because seq-002 gitHead == HEAD; got non-empty result suggesting ` +
    `wrong archive was picked: ${JSON.stringify(result)}`
  );
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
