/**
 * test-assert-changes-landed-all-files.js — Regression test for the tightened
 * assertChangesLanded predicate (ok: unchanged.length === 0).
 *
 * Background: under the old `unchanged.length < files.length` predicate,
 * a partial deliverable (one unchanged file among several declared files)
 * would incorrectly return ok:true. The tightened predicate requires ALL
 * declared files to have changed for ok to be true.
 *
 * TC-ALL-1: all declared files changed → result.ok === true, result.unchanged deepStrictEqual []
 * TC-ALL-2: one of two files byte-identical → result.ok === false and result.unchanged includes that file
 * TC-ALL-3: empty-input [] → deepStrictEqual { ok: true, unchanged: [], bothMissing: [] }
 * TC-ALL-4: falsy files (undefined) → deepStrictEqual { ok: true, unchanged: [], bothMissing: [] }
 * TC-ALL-5: both-missing declared file → result.bothMissing deepStrictEqual ['ghost.js'] AND result.ok === false
 *
 * Run: node test/test-assert-changes-landed-all-files.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { snapshotFiles, assertChangesLanded } from '../src/orchestrator/core/snapshots.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failCount++;
    }
  );
}

function createEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-changes-all-test-'));
  const projectRoot = path.join(root, 'project');
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'snapshots'), { recursive: true });
  return { root, projectRoot, harnessDir };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

await test('TC-ALL-1: all declared files changed → ok:true, unchanged:[]', async () => {
  const { root, projectRoot, harnessDir } = createEnv();
  try {
    writeFile(projectRoot, 'a.js', 'original-a');
    writeFile(projectRoot, 'b.js', 'original-b');
    snapshotFiles(harnessDir, projectRoot, 'task-all-1', 'before', ['a.js', 'b.js']);
    writeFile(projectRoot, 'a.js', 'modified-a');
    writeFile(projectRoot, 'b.js', 'modified-b');
    const result = assertChangesLanded(harnessDir, projectRoot, 'task-all-1', ['a.js', 'b.js']);
    assert.strictEqual(result.ok, true, 'all files changed → ok:true');
    assert.deepStrictEqual(result.unchanged, []);
  } finally { cleanup(root); }
});

await test('TC-ALL-2: one of two files byte-identical → ok:false, unchanged includes that file', async () => {
  const { root, projectRoot, harnessDir } = createEnv();
  try {
    writeFile(projectRoot, 'a.js', 'original-a');
    writeFile(projectRoot, 'b.js', 'original-b');
    snapshotFiles(harnessDir, projectRoot, 'task-all-2', 'before', ['a.js', 'b.js']);
    // Only modify b.js; a.js remains byte-identical to its before-snapshot (partial deliverable)
    writeFile(projectRoot, 'b.js', 'modified-b');
    const result = assertChangesLanded(harnessDir, projectRoot, 'task-all-2', ['a.js', 'b.js']);
    assert.strictEqual(result.ok, false, 'one unchanged file → ok:false (partial deliverable)');
    assert.ok(result.unchanged.includes('a.js'), `unchanged should include 'a.js', got ${JSON.stringify(result.unchanged)}`);
  } finally { cleanup(root); }
});

await test('TC-ALL-3: empty-input [] → { ok: true, unchanged: [], bothMissing: [] }', async () => {
  const { root, projectRoot, harnessDir } = createEnv();
  try {
    const result = assertChangesLanded(harnessDir, projectRoot, 'task-all-3', []);
    assert.deepStrictEqual(result, { ok: true, unchanged: [], bothMissing: [] });
  } finally { cleanup(root); }
});

await test('TC-ALL-4: falsy files (undefined) → { ok: true, unchanged: [], bothMissing: [] }', async () => {
  const { root, projectRoot, harnessDir } = createEnv();
  try {
    const result = assertChangesLanded(harnessDir, projectRoot, 'task-all-4', undefined);
    assert.deepStrictEqual(result, { ok: true, unchanged: [], bothMissing: [] });
  } finally { cleanup(root); }
});

await test('TC-ALL-5: both-missing declared file → bothMissing deepStrictEqual [\'ghost.js\'] AND ok:false', async () => {
  const { root, projectRoot, harnessDir } = createEnv();
  try {
    // ghost.js was never created on disk and never snapshotted → both-missing
    const result = assertChangesLanded(harnessDir, projectRoot, 'task-all-5', ['ghost.js']);
    assert.deepStrictEqual(result.bothMissing, ['ghost.js'],
      `bothMissing should be ['ghost.js'], got ${JSON.stringify(result.bothMissing)}`);
    assert.strictEqual(result.ok, false, 'both-missing → ok:false (phantom claim)');
  } finally { cleanup(root); }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
