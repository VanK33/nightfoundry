/**
 * test-write-json-atomic.js — Crash-resilience tests for writeJsonAtomic from state.js.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeJsonAtomic } from '../src/orchestrator/core/state.js';

let passCount = 0;
let failCount = 0;

function pass(label) {
  console.log(`  PASS  ${label}`);
  passCount++;
}

function fail(label, err) {
  console.error(`  FAIL  ${label}: ${err?.message ?? err}`);
  failCount++;
}

// Helper: create a unique temp directory for each test
function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'test-wja-'));
}

// TC1: writeJsonAtomic round-trip produces valid JSON matching input
try {
  const dir = mkTmpDir();
  const tmpFile = path.join(dir, 'tc1.json');
  writeJsonAtomic(tmpFile, { a: 1 });
  const result = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  assert.deepStrictEqual(result, { a: 1 }, 'TC1: round-trip value mismatch');
  fs.rmSync(dir, { recursive: true, force: true });
  pass('TC1: round-trip produces valid JSON matching input');
} catch (err) {
  fail('TC1: round-trip produces valid JSON matching input', err);
}

// TC2: no .tmp.* files left after successful write
try {
  const dir = mkTmpDir();
  const filePath = path.join(dir, 'tc2.json');
  writeJsonAtomic(filePath, { b: 2 });
  const leftover = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
  assert.strictEqual(leftover.length, 0, `TC2: leftover tmp files found: ${leftover.join(', ')}`);
  fs.rmSync(dir, { recursive: true, force: true });
  pass('TC2: no .tmp.* files left after successful write');
} catch (err) {
  fail('TC2: no .tmp.* files left after successful write', err);
}

// TC3: overwrite replaces content atomically
try {
  const dir = mkTmpDir();
  const filePath = path.join(dir, 'tc3.json');
  writeJsonAtomic(filePath, { v: 1 });
  writeJsonAtomic(filePath, { v: 2 });
  const result = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepStrictEqual(result, { v: 2 }, 'TC3: overwrite did not replace content');
  fs.rmSync(dir, { recursive: true, force: true });
  pass('TC3: overwrite replaces content atomically');
} catch (err) {
  fail('TC3: overwrite replaces content atomically', err);
}

// TC4: simulated crash (renameSync throws) leaves original file intact
try {
  const dir = mkTmpDir();
  const filePath = path.join(dir, 'tc4.json');

  // Write initial content
  writeJsonAtomic(filePath, { v: 'original' });

  // Monkey-patch fs.renameSync to throw after the tmp file is written
  const originalRenameSync = fs.renameSync;
  let tmpLeftover = null;
  fs.renameSync = function (src, dst) {
    tmpLeftover = src;
    throw new Error('simulated crash: renameSync failed');
  };

  try {
    writeJsonAtomic(filePath, { v: 'new' });
  } catch {
    // expected
  } finally {
    fs.renameSync = originalRenameSync;
  }

  // Original file must be untouched
  const result = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepStrictEqual(result, { v: 'original' }, 'TC4: original file was corrupted after simulated crash');

  // Clean up leftover tmp file if it exists
  if (tmpLeftover && fs.existsSync(tmpLeftover)) {
    fs.unlinkSync(tmpLeftover);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  pass('TC4: simulated crash (renameSync throws) leaves original file intact');
} catch (err) {
  fail('TC4: simulated crash (renameSync throws) leaves original file intact', err);
}

// TC5: 10 concurrent writes never produce partial/corrupt JSON
try {
  const dir = mkTmpDir();
  const filePath = path.join(dir, 'tc5.json');

  // Write an initial file so concurrent writers have something to overwrite
  writeJsonAtomic(filePath, { i: -1 });

  const writes = [];
  for (let i = 0; i < 10; i++) {
    writes.push(
      new Promise((resolve) => {
        // Stagger slightly with setImmediate to encourage interleaving
        setImmediate(() => {
          try {
            writeJsonAtomic(filePath, { i });
          } catch {
            // a losing writer may throw if tmp name collides — acceptable
          }
          resolve();
        });
      })
    );
  }

  await Promise.all(writes);

  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`TC5: file contents are not valid JSON after 10 concurrent writes: ${e.message}`);
  }

  assert.ok(
    typeof parsed.i === 'number' && parsed.i >= 0 && parsed.i <= 9,
    `TC5: parsed.i out of expected range [0,9]: ${parsed.i}`
  );

  fs.rmSync(dir, { recursive: true, force: true });
  pass('TC5: 10 concurrent writes never produce partial/corrupt JSON');
} catch (err) {
  fail('TC5: 10 concurrent writes never produce partial/corrupt JSON', err);
}

// Summary
console.log(`\ntest-write-json-atomic.js: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
  process.exit(1);
}
