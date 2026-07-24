import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { writeVerifyJson } from '../src/orchestrator/core/state.js';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'write-verify-json-test-'));
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'verify'), { recursive: true });
  return { projectRoot: root, harnessDir };
}

function readVerifyFile(harnessDir, taskId) {
  const filePath = path.join(harnessDir, 'verify', `task-${taskId}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// TC-WV-1: task with hardChecks: [{name:'a',cmd:'true'},{name:'b',cmd:'false'}] → verify file hardChecks deep-equals input
await test('TC-WV-1: array hardChecks passthrough', () => {
  const { projectRoot, harnessDir } = createTestEnv();
  try {
    const task = {
      id: 'tc-wv-1',
      targetFiles: [],
      hardChecks: [{ name: 'a', cmd: 'true' }, { name: 'b', cmd: 'false' }],
      testCases: [],
    };
    writeVerifyJson(harnessDir, task);
    const verify = readVerifyFile(harnessDir, 'tc-wv-1');
    assert.deepStrictEqual(verify.hardChecks, [{ name: 'a', cmd: 'true' }, { name: 'b', cmd: 'false' }]);
  } finally {
    cleanup(projectRoot);
  }
});

// TC-WV-2: task with no hardChecks field → verify file hardChecks is []
await test('TC-WV-2: missing hardChecks field → []', () => {
  const { projectRoot, harnessDir } = createTestEnv();
  try {
    const task = {
      id: 'tc-wv-2',
      targetFiles: [],
      testCases: [],
    };
    writeVerifyJson(harnessDir, task);
    const verify = readVerifyFile(harnessDir, 'tc-wv-2');
    assert.deepStrictEqual(verify.hardChecks, []);
  } finally {
    cleanup(projectRoot);
  }
});

// TC-WV-3: task with hardChecks: null → verify file hardChecks is []
await test('TC-WV-3: null hardChecks → []', () => {
  const { projectRoot, harnessDir } = createTestEnv();
  try {
    const task = {
      id: 'tc-wv-3',
      targetFiles: [],
      hardChecks: null,
      testCases: [],
    };
    writeVerifyJson(harnessDir, task);
    const verify = readVerifyFile(harnessDir, 'tc-wv-3');
    assert.deepStrictEqual(verify.hardChecks, []);
  } finally {
    cleanup(projectRoot);
  }
});

// TC-WV-4: task with hardChecks: 'not-an-array' → verify file hardChecks is []
await test('TC-WV-4: string hardChecks → []', () => {
  const { projectRoot, harnessDir } = createTestEnv();
  try {
    const task = {
      id: 'tc-wv-4',
      targetFiles: [],
      hardChecks: 'not-an-array',
      testCases: [],
    };
    writeVerifyJson(harnessDir, task);
    const verify = readVerifyFile(harnessDir, 'tc-wv-4');
    assert.deepStrictEqual(verify.hardChecks, []);
  } finally {
    cleanup(projectRoot);
  }
});

// TC-WV-5: task with hardChecks: [] → verify file hardChecks is []
await test('TC-WV-5: empty array hardChecks → []', () => {
  const { projectRoot, harnessDir } = createTestEnv();
  try {
    const task = {
      id: 'tc-wv-5',
      targetFiles: [],
      hardChecks: [],
      testCases: [],
    };
    writeVerifyJson(harnessDir, task);
    const verify = readVerifyFile(harnessDir, 'tc-wv-5');
    assert.deepStrictEqual(verify.hardChecks, []);
  } finally {
    cleanup(projectRoot);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
