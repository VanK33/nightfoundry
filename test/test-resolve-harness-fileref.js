import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { resolveHarnessFileRef } from '../src/orchestrator/core/state.js';
import { TEST_FILES } from '../scripts/run-tests.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      failCount++;
    }
  );
}

function createTestEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-harness-fileref-test-'));
  return { projectRoot: root };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// TC1: Absolute ref returns unchanged
await test('TC1: absolute ref returned unchanged', () => {
  const absRef = '/abs/x/task-1.json';
  const result = resolveHarnessFileRef('/some/harness/dir', absRef);
  assert.strictEqual(result, absRef);
});

// TC2: Flat harnessDir, legacy '.harness/'-prefixed ref resolves identically
// to the old `path.join(harnessDir, '..', ref)` walk.
await test("TC2: flat harnessDir, '.harness/'-prefixed ref matches old '..' walk", () => {
  const { projectRoot } = createTestEnv();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    const ref = '.harness/verify/task-1.json';
    const expected = path.join(harnessDir, '..', ref);
    const result = resolveHarnessFileRef(harnessDir, ref);
    assert.strictEqual(result, expected);
  } finally {
    cleanup(projectRoot);
  }
});

// TC3: Flat harnessDir, run-relative ref resolves to path.join(harnessDir, ref)
await test('TC3: flat harnessDir, bare run-relative ref joins from harnessDir', () => {
  const { projectRoot } = createTestEnv();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    const ref = 'verify/task-1.json';
    const expected = path.join(harnessDir, ref);
    const result = resolveHarnessFileRef(harnessDir, ref);
    assert.strictEqual(result, expected);
  } finally {
    cleanup(projectRoot);
  }
});

// TC4: Run-scoped harnessDir, '.harness/'-prefixed ref resolves inside run dir
await test("TC4: run-scoped harnessDir, '.harness/'-prefixed ref resolves inside run dir", () => {
  const { projectRoot } = createTestEnv();
  try {
    const harnessDir = path.join(projectRoot, '.harness', 'run-x');
    fs.mkdirSync(harnessDir, { recursive: true });
    const ref = '.harness/verify/task-1.json';
    const result = resolveHarnessFileRef(harnessDir, ref);
    assert.ok(
      result.startsWith(harnessDir),
      `expected ${result} to start with ${harnessDir}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// TC5: Run-scoped harnessDir, bare run-relative ref resolves inside run dir
await test('TC5: run-scoped harnessDir, bare run-relative ref resolves inside run dir', () => {
  const { projectRoot } = createTestEnv();
  try {
    const harnessDir = path.join(projectRoot, '.harness', 'run-x');
    fs.mkdirSync(harnessDir, { recursive: true });
    const ref = 'verify/task-1.json';
    const result = resolveHarnessFileRef(harnessDir, ref);
    assert.ok(
      result.startsWith(harnessDir),
      `expected ${result} to start with ${harnessDir}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// TC6: Non-path-like string does not throw and returns a string
await test('TC6: non-path-like string does not throw and returns a string', () => {
  const harnessDir = '/some/harness/dir';
  const ref = 'not a path!!';
  const result = resolveHarnessFileRef(harnessDir, ref);
  assert.strictEqual(typeof result, 'string');
});

// TC7: this test file is registered in TEST_FILES in scripts/run-tests.js
await test('TC7: test file is registered in scripts/run-tests.js TEST_FILES', () => {
  assert.ok(
    TEST_FILES.includes('test/test-resolve-harness-fileref.js'),
    'expected TEST_FILES to include test/test-resolve-harness-fileref.js'
  );
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
