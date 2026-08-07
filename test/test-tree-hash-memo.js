/**
 * test-tree-hash-memo.js — Unit tests for gates/test-memo.js: the working-tree
 * content hash and the green full-suite memo it keys.
 *
 * Contract:
 *   - computeTreeHash is stable for an unchanged tree and changes whenever a
 *     tracked file's content changes or an untracked file appears (including
 *     inside a new directory, via `-uall`); reverting restores the hash.
 *   - A non-git directory yields null (memo unusable, callers run for real).
 *   - readGreenMemo hits only on exact treeHash + command match within
 *     maxAgeMs; missing/corrupt memo files and stale timestamps are misses,
 *     never throws.
 *
 * Run: node test/test-tree-hash-memo.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import {
  computeTreeHash,
  readGreenMemo,
  recordGreenMemo,
  testAllMemoPath,
} from '../src/orchestrator/gates/test-memo.js';

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
function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function cleanupAll() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
}

/** Init a git repo with one committed file and a .gitignore for .harness/. */
function makeGitRepo() {
  const dir = makeTmpDir('cc-orch-tree-hash-');
  const git = (cmd) => execSync(
    `git -c user.email=t@t -c user.name=t ${cmd}`,
    { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  git('init -q');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.harness/\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'original\n', 'utf8');
  git('add -A');
  git('commit -q -m init');
  return dir;
}

// ── computeTreeHash ───────────────────────────────────────────────────────────

await test('computeTreeHash is stable across calls on an unchanged tree', async () => {
  const dir = makeGitRepo();
  const h1 = computeTreeHash(dir);
  const h2 = computeTreeHash(dir);
  assert.ok(typeof h1 === 'string' && h1.length > 0, 'Expected a non-empty hash string');
  assert.strictEqual(h1, h2, 'Expected identical hashes for an unchanged tree');
});

await test('computeTreeHash changes when a tracked file changes, and reverts with it', async () => {
  const dir = makeGitRepo();
  const clean = computeTreeHash(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'modified\n', 'utf8');
  const dirty = computeTreeHash(dir);
  assert.notStrictEqual(dirty, clean, 'Expected the hash to change with tracked-file content');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'original\n', 'utf8');
  assert.strictEqual(computeTreeHash(dir), clean, 'Expected the hash to revert with the content');
});

await test('computeTreeHash changes on a dirty file content change with an unchanged porcelain listing', async () => {
  // Both states list `?? u.txt` — only the CONTENT hash distinguishes them.
  const dir = makeGitRepo();
  fs.writeFileSync(path.join(dir, 'u.txt'), 'v1\n', 'utf8');
  const v1 = computeTreeHash(dir);
  fs.writeFileSync(path.join(dir, 'u.txt'), 'v2\n', 'utf8');
  const v2 = computeTreeHash(dir);
  assert.notStrictEqual(v1, v2, 'Expected content of an untracked file to affect the hash');
});

await test('computeTreeHash sees untracked files inside a new directory (-uall)', async () => {
  const dir = makeGitRepo();
  const before = computeTreeHash(dir);
  fs.mkdirSync(path.join(dir, 'newdir'));
  fs.writeFileSync(path.join(dir, 'newdir', 'n.txt'), 'x\n', 'utf8');
  assert.notStrictEqual(computeTreeHash(dir), before, 'Expected a file in a new directory to change the hash');
});

await test('computeTreeHash ignores gitignored paths (.harness/)', async () => {
  const dir = makeGitRepo();
  const before = computeTreeHash(dir);
  fs.mkdirSync(path.join(dir, '.harness'));
  fs.writeFileSync(path.join(dir, '.harness', 'test-all-memo.json'), '{}', 'utf8');
  assert.strictEqual(computeTreeHash(dir), before, 'Expected gitignored writes to leave the hash unchanged');
});

await test('computeTreeHash returns null for a non-git directory', async () => {
  const dir = makeTmpDir('cc-orch-nongit-');
  assert.strictEqual(computeTreeHash(dir), null);
});

// ── readGreenMemo / recordGreenMemo ───────────────────────────────────────────

await test('recordGreenMemo → readGreenMemo roundtrip hits on exact key', async () => {
  const dir = makeGitRepo();
  recordGreenMemo(dir, { treeHash: 'h1', command: 'npm run test:all' });
  assert.ok(fs.existsSync(testAllMemoPath(dir)), 'Expected the memo file under .harness/');
  const memo = readGreenMemo(dir, { treeHash: 'h1', command: 'npm run test:all', maxAgeMs: 60_000 });
  assert.ok(memo, 'Expected a memo hit');
  assert.strictEqual(memo.treeHash, 'h1');
  assert.strictEqual(memo.command, 'npm run test:all');
  assert.ok(typeof memo.timestamp === 'number');
});

await test('readGreenMemo misses on treeHash or command mismatch', async () => {
  const dir = makeGitRepo();
  recordGreenMemo(dir, { treeHash: 'h1', command: 'npm run test:all' });
  assert.strictEqual(readGreenMemo(dir, { treeHash: 'OTHER', command: 'npm run test:all', maxAgeMs: 60_000 }), null);
  assert.strictEqual(readGreenMemo(dir, { treeHash: 'h1', command: 'other cmd', maxAgeMs: 60_000 }), null);
});

await test('readGreenMemo misses when the memo is older than maxAgeMs', async () => {
  const dir = makeGitRepo();
  recordGreenMemo(dir, { treeHash: 'h1', command: 'npm run test:all' });
  const memoPath = testAllMemoPath(dir);
  const memo = JSON.parse(fs.readFileSync(memoPath, 'utf8'));
  memo.timestamp = Date.now() - 3_600_001;
  fs.writeFileSync(memoPath, JSON.stringify(memo), 'utf8');
  assert.strictEqual(readGreenMemo(dir, { treeHash: 'h1', command: 'npm run test:all', maxAgeMs: 3_600_000 }), null);
});

await test('readGreenMemo misses on a future timestamp (clock skew guard)', async () => {
  const dir = makeGitRepo();
  const memoPath = testAllMemoPath(dir);
  fs.mkdirSync(path.dirname(memoPath), { recursive: true });
  fs.writeFileSync(memoPath, JSON.stringify({ treeHash: 'h1', command: 'c', timestamp: Date.now() + 60_000 }), 'utf8');
  assert.strictEqual(readGreenMemo(dir, { treeHash: 'h1', command: 'c', maxAgeMs: 3_600_000 }), null);
});

await test('readGreenMemo treats a missing or corrupt memo file as a miss, never throws', async () => {
  const dir = makeGitRepo();
  assert.strictEqual(readGreenMemo(dir, { treeHash: 'h1', command: 'c', maxAgeMs: 60_000 }), null);
  const memoPath = testAllMemoPath(dir);
  fs.mkdirSync(path.dirname(memoPath), { recursive: true });
  fs.writeFileSync(memoPath, 'not json {', 'utf8');
  assert.strictEqual(readGreenMemo(dir, { treeHash: 'h1', command: 'c', maxAgeMs: 60_000 }), null);
  fs.writeFileSync(memoPath, '"a bare string"', 'utf8');
  assert.strictEqual(readGreenMemo(dir, { treeHash: 'h1', command: 'c', maxAgeMs: 60_000 }), null);
});

cleanupAll();
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
