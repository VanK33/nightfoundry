/**
 * test-hard-checks-integration.js — Integration tests for writeVerifyJson → runHardChecks roundtrip.
 *
 * Covers:
 *   TC-HC-INT-1: passing check
 *   TC-HC-INT-2: failing check
 *   TC-HC-INT-3: no hardChecks field → passed:true, 0 results
 *   TC-HC-INT-4: mixed pass/fail
 *
 * Run: node test/test-hard-checks-integration.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { writeVerifyJson } from '../src/orchestrator/core/state.js';
import { runHardChecks } from '../src/orchestrator/gates/hard-checks.js';

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

// ---------- Fixture helpers ----------

function createTestEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-checks-int-test-'));
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'verify'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  return { projectRoot: root, harnessDir };
}

function cleanup(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

// ---------- Integration Tests ----------

async function main() {
  // TC-HC-INT-1: passing check
  await test('TC-HC-INT-1: writeVerifyJson with passing hardCheck → passed:true, results.length===1, results[0].passed===true', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      const task = {
        id: '001-001-001-003',
        targetFiles: ['test/test-hard-checks-integration.js'],
        hardChecks: [{ name: 'pass', command: 'true' }],
        testCases: ['TC-HC-INT-1: passing check'],
      };
      writeVerifyJson(harnessDir, task);
      const result = await runHardChecks(harnessDir, '001-001-001-003', projectRoot);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.results.length, 1);
      assert.strictEqual(result.results[0].passed, true);
    } finally { cleanup(projectRoot); }
  });

  // TC-HC-INT-2: failing check
  await test('TC-HC-INT-2: writeVerifyJson with failing hardCheck → passed:false, results[0].passed===false', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      const task = {
        id: '001-001-001-003',
        targetFiles: ['test/test-hard-checks-integration.js'],
        hardChecks: [{ name: 'fail', command: 'false' }],
        testCases: ['TC-HC-INT-2: failing check'],
      };
      writeVerifyJson(harnessDir, task);
      const result = await runHardChecks(harnessDir, '001-001-001-003', projectRoot);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.results[0].passed, false);
    } finally { cleanup(projectRoot); }
  });

  // TC-HC-INT-3: no hardChecks field → passed:true, results.length===0
  await test('TC-HC-INT-3: writeVerifyJson with no hardChecks → passed:true, results.length===0', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      const task = {
        id: '001-001-001-003',
        targetFiles: ['test/test-hard-checks-integration.js'],
        // hardChecks intentionally omitted
        testCases: ['TC-HC-INT-3: no hardChecks'],
      };
      writeVerifyJson(harnessDir, task);
      const result = await runHardChecks(harnessDir, '001-001-001-003', projectRoot);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.results.length, 0);
    } finally { cleanup(projectRoot); }
  });

  // TC-HC-INT-4: mixed pass/fail → passed:false, results.length===2
  await test('TC-HC-INT-4: writeVerifyJson with two checks (one pass, one fail) → passed:false, results.length===2', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      const task = {
        id: '001-001-001-003',
        targetFiles: ['test/test-hard-checks-integration.js'],
        hardChecks: [
          { name: 'pass', command: 'true' },
          { name: 'fail', command: 'false' },
        ],
        testCases: ['TC-HC-INT-4: mixed pass/fail'],
      };
      writeVerifyJson(harnessDir, task);
      const result = await runHardChecks(harnessDir, '001-001-001-003', projectRoot);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.results.length, 2);
    } finally { cleanup(projectRoot); }
  });

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
