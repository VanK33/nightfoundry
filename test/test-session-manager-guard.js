/**
 * test-session-manager-guard.js — Unit tests for SessionHandle._readFiles and
 * SessionManager._guardToolUse / canUseTool closure.
 *
 * Run: node test/test-session-manager-guard.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { SessionHandle, SessionManager } from '../src/orchestrator/infra/session-manager.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempFile(content = 'hello') {
  const p = path.join(os.tmpdir(), `guard-test-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(p, content);
  return p;
}

function removeTempFile(p) {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

const sm = new SessionManager();

// ── Test 1: SessionHandle._readFiles is initialized as empty Set ─────────────

await test('SessionHandle constructor initializes _readFiles as an empty Set', () => {
  const handle = new SessionHandle('test-handle');
  assert.ok(handle._readFiles instanceof Set, '_readFiles should be a Set');
  assert.equal(handle._readFiles.size, 0, '_readFiles should be empty');
});

// ── Test 2: _guardToolUse returns { behavior: 'allow', updatedInput } for allowed tools ────
// SDK Zod schema requires updatedInput on the allow branch — missing it produces a
// ZodError that fails every tool call in the session.

await test('_guardToolUse returns { behavior: "allow", updatedInput } (not boolean true) for allowed tools', () => {
  const input = { file_path: '/some/file.js' };
  const result = sm._guardToolUse('Read', input, undefined);
  assert.equal(result.behavior, 'allow', 'behavior must be "allow"');
  assert.deepStrictEqual(result.updatedInput, input, 'updatedInput must pass through the toolInput');
  assert.notStrictEqual(result, true, 'must not return boolean true');
});

// ── Test 3: _guardToolUse returns { behavior: 'deny', message } for blocked ──

await test('_guardToolUse returns { behavior: "deny", message } (not boolean false) for blocked tools', () => {
  const result = sm._guardToolUse('Bash', { command: 'git commit -m "oops"' }, undefined);
  assert.equal(result.behavior, 'deny', 'behavior must be "deny"');
  assert.ok(typeof result.message === 'string' && result.message.length > 0, 'message must be a non-empty string');
  assert.notStrictEqual(result, false, 'must not return boolean false');
});

// ── Test 4: canUseTool closure tracks Read calls ──────────────────────────────

await test('canUseTool closure tracks Read calls by adding file_path to _readFiles', () => {
  const readFiles = new Set();
  const sdkOpts = sm._buildSdkOptions(
    { targetFiles: ['src/foo.js'] },
    readFiles
  );

  assert.ok(typeof sdkOpts.canUseTool === 'function', 'canUseTool should be a function');

  // Simulate a Read call
  sdkOpts.canUseTool('Read', { file_path: '/project/src/foo.js' });
  assert.ok(readFiles.has('/project/src/foo.js'), 'file_path should be added to readFiles after Read');
});

// ── Test 5: blocks Edit on existing file not in _readFiles ────────────────────

await test('_guardToolUse blocks Edit on existing file not in _readFiles (when targetFiles present)', () => {
  const existingFile = makeTempFile();
  try {
    const readFiles = new Set(); // file not Read yet
    const targetFiles = [existingFile];
    const result = sm._guardToolUse('Edit', { file_path: existingFile }, targetFiles, readFiles);
    assert.equal(result.behavior, 'deny', 'Edit on existing unread file should be denied');
    assert.ok(result.message.includes(existingFile) || result.message.length > 0,
      'deny message should reference the file or explain the block');
  } finally {
    removeTempFile(existingFile);
  }
});

// ── Test 6: allows Edit on existing file that IS in _readFiles ────────────────

await test('_guardToolUse allows Edit on existing file that IS in _readFiles', () => {
  const existingFile = makeTempFile();
  try {
    const readFiles = new Set([existingFile]); // file was Read
    const targetFiles = [existingFile];
    const input = { file_path: existingFile };
    const result = sm._guardToolUse('Edit', input, targetFiles, readFiles);
    assert.equal(result.behavior, 'allow');
    assert.deepStrictEqual(result.updatedInput, input);
  } finally {
    removeTempFile(existingFile);
  }
});

// ── Test 7: allows Write to new file (not on disk) without prior Read ─────────

await test('_guardToolUse allows Write to new file (not on disk) without prior Read', () => {
  const newFile = path.join(os.tmpdir(), `guard-new-${Math.random().toString(36).slice(2)}.js`);
  // Ensure the file does NOT exist
  assert.ok(!fs.existsSync(newFile), 'test precondition: file must not exist');
  const readFiles = new Set();
  const targetFiles = [newFile];
  const input = { file_path: newFile };
  const result = sm._guardToolUse('Write', input, targetFiles, readFiles);
  assert.equal(result.behavior, 'allow');
  assert.deepStrictEqual(result.updatedInput, input);
});

// ── Test 8: allows Edit/Write freely when no targetFiles ──────────────────────

await test('_guardToolUse allows Edit/Write freely when no targetFiles (non-executor sessions)', () => {
  const existingFile = makeTempFile();
  try {
    const readFiles = new Set(); // file not read, but no targetFiles
    // Edit without targetFiles — should allow
    const editInput = { file_path: existingFile };
    const editResult = sm._guardToolUse('Edit', editInput, undefined, readFiles);
    assert.equal(editResult.behavior, 'allow', 'Edit should be allowed without targetFiles');
    assert.deepStrictEqual(editResult.updatedInput, editInput);

    const writeInput = { file_path: existingFile };
    const writeResult = sm._guardToolUse('Write', writeInput, null, readFiles);
    assert.equal(writeResult.behavior, 'allow', 'Write should be allowed without targetFiles');
    assert.deepStrictEqual(writeResult.updatedInput, writeInput);

    // Empty array also counts as "no targetFiles"
    const edit2Input = { file_path: existingFile };
    const editResult2 = sm._guardToolUse('Edit', edit2Input, [], readFiles);
    assert.equal(editResult2.behavior, 'allow', 'Edit should be allowed with empty targetFiles');
    assert.deepStrictEqual(editResult2.updatedInput, edit2Input);
  } finally {
    removeTempFile(existingFile);
  }
});

// ── Test 9: Bash dangerous-command blocking works with new PermissionResult ───

await test('Bash dangerous-command blocking still works with new PermissionResult return type', () => {
  const dangerousCommands = [
    'git commit -m "bad"',
    'git push origin main',
    'git reset --hard',
    'rm -rf /tmp/foo',
    'sudo apt install something',
    'npm publish',
  ];

  for (const cmd of dangerousCommands) {
    const result = sm._guardToolUse('Bash', { command: cmd }, undefined);
    assert.equal(result.behavior, 'deny',
      `Expected deny for dangerous command: ${cmd}`);
    assert.ok(typeof result.message === 'string' && result.message.length > 0,
      `Expected non-empty message for: ${cmd}`);
  }

  // Safe Bash command should be allowed
  const safeInput = { command: 'ls -la' };
  const safeResult = sm._guardToolUse('Bash', safeInput, undefined);
  assert.equal(safeResult.behavior, 'allow');
  assert.deepStrictEqual(safeResult.updatedInput, safeInput);
});

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
