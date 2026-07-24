/**
 * test-git-guard.js — Unit tests for src/cli/git-guard.js.
 *
 * No Claude auth, no SDK. Pure fs + child_process + temp directories.
 * Run: node test/test-git-guard.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { execSync } from 'child_process';
import { gitGuard, MAX_UPWARD_WALK } from '../src/cli/git-guard.js';

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

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Initialise a bare git repo in dir so that `git status --porcelain` works.
 * Sets local user config so git doesn't complain about missing identity.
 */
function gitInit(dir) {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
}

// ---------- TC1: valid git repo with clean tree ----------

await test('TC1: gitGuard returns { ok: true, gitRoot } for a valid git repo with clean tree', async () => {
  const dir = createTempDir('git-guard-tc1-');
  try {
    gitInit(dir);
    const result = await gitGuard(dir);
    assert.strictEqual(result.ok, true, `expected ok===true, got: ${JSON.stringify(result)}`);
    assert.ok(result.gitRoot, 'expected gitRoot to be set');
    // gitRoot should resolve to the same directory (symlinks resolved)
    assert.strictEqual(
      fs.realpathSync(result.gitRoot),
      fs.realpathSync(dir),
      `expected gitRoot to be ${dir}, got ${result.gitRoot}`
    );
  } finally {
    cleanup(dir);
  }
});

// ---------- TC2: no .git directory ----------

await test('TC2: gitGuard returns { ok: false, reason: "no-git" } when no .git directory exists', async () => {
  const dir = createTempDir('git-guard-tc2-');
  try {
    const result = await gitGuard(dir);
    assert.strictEqual(result.ok, false, `expected ok===false, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.reason, 'no-git', `expected reason==="no-git", got: ${result.reason}`);
  } finally {
    cleanup(dir);
  }
});

// ---------- TC3: opts.noGitRequired bypasses no-git ----------

await test('TC3: opts.noGitRequired=true bypasses no-git and returns { ok: true, gitRoot: null }', async () => {
  const dir = createTempDir('git-guard-tc3-');
  try {
    const result = await gitGuard(dir, { noGitRequired: true });
    assert.strictEqual(result.ok, true, `expected ok===true, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.gitRoot, null, `expected gitRoot===null, got: ${result.gitRoot}`);
  } finally {
    cleanup(dir);
  }
});

// ---------- TC4: dirty working tree ----------

await test('TC4: gitGuard returns { ok: false, reason: "dirty-tree" } for dirty working tree', async () => {
  const dir = createTempDir('git-guard-tc4-');
  try {
    gitInit(dir);
    // Create an uncommitted file — untracked files make the tree dirty
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted content\n');
    const result = await gitGuard(dir);
    assert.strictEqual(result.ok, false, `expected ok===false, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.reason, 'dirty-tree', `expected reason==="dirty-tree", got: ${result.reason}`);
  } finally {
    cleanup(dir);
  }
});

// ---------- TC5: opts.allowDirty bypasses dirty-tree ----------

await test('TC5: opts.allowDirty=true bypasses dirty-tree check and returns ok: true', async () => {
  const dir = createTempDir('git-guard-tc5-');
  try {
    gitInit(dir);
    // Create an uncommitted file to make tree dirty
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted content\n');
    const result = await gitGuard(dir, { allowDirty: true });
    assert.strictEqual(result.ok, true, `expected ok===true, got: ${JSON.stringify(result)}`);
  } finally {
    cleanup(dir);
  }
});

// ---------- TC6: upward walk finds .git in parent ----------

await test('TC6: upward walk finds .git in parent directory and returns correct gitRoot', async () => {
  const rootDir = createTempDir('git-guard-tc6-');
  try {
    gitInit(rootDir);
    // Create a nested child directory
    const childDir = path.join(rootDir, 'nested', 'child');
    fs.mkdirSync(childDir, { recursive: true });
    const result = await gitGuard(childDir);
    assert.strictEqual(result.ok, true, `expected ok===true, got: ${JSON.stringify(result)}`);
    assert.ok(result.gitRoot, 'expected gitRoot to be set');
    assert.strictEqual(
      fs.realpathSync(result.gitRoot),
      fs.realpathSync(rootDir),
      `expected gitRoot to be ${rootDir}, got ${result.gitRoot}`
    );
  } finally {
    cleanup(rootDir);
  }
});

// ---------- TC7: MAX_UPWARD_WALK is exported and is a positive integer ----------

await test('TC7: MAX_UPWARD_WALK is exported and is a positive integer', async () => {
  assert.ok(
    typeof MAX_UPWARD_WALK === 'number',
    `expected MAX_UPWARD_WALK to be a number, got: ${typeof MAX_UPWARD_WALK}`
  );
  assert.ok(
    Number.isInteger(MAX_UPWARD_WALK),
    `expected MAX_UPWARD_WALK to be an integer, got: ${MAX_UPWARD_WALK}`
  );
  assert.ok(
    MAX_UPWARD_WALK > 0,
    `expected MAX_UPWARD_WALK to be positive, got: ${MAX_UPWARD_WALK}`
  );
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
