/**
 * test-git-guard-cli.js — CLI integration tests for git guard enforcement.
 *
 * Run: node test/test-git-guard-cli.js
 *
 * Covers:
 *   TC1 — `cc-orch run spec.md` in a temp dir with no .git exits non-zero with git guard message
 *   TC2 — `cc-orch run spec.md --no-git-required` in a temp dir with no .git bypasses git guard
 *   TC3 — `cc-orch dry-run spec.md` in a temp dir with no .git exits non-zero with git guard message
 *   TC4 — `cc-orch status` in a temp dir with no .git does NOT trigger git guard (exits with .harness error)
 *   TC5 — `cc-orch help` output includes --allow-dirty and --no-git-required
 *   TC6 — `cc-orch resume` in a non-git dir with .harness/state.json does NOT trigger git guard
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync as childSpawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const cliPath = path.resolve(__dirname, '../src/cli/index.js');

function spawnCli(args, opts = {}) {
  const result = childSpawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env },
    timeout: 10000,
    encoding: 'utf8',
    ...opts,
  });

  assert.ifError(result.error);
  assert.notStrictEqual(
    result.status,
    null,
    `CLI did not exit cleanly for args ${JSON.stringify(args)}`
  );

  return result;
}

// ---------------------------------------------------------------------------
// TC1 — run in non-git dir exits non-zero with git guard message
// ---------------------------------------------------------------------------
await test('TC1: run in non-git dir exits non-zero with git guard message', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-git-guard-tc1-'));
  try {
    const specFile = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specFile, '# Test spec\n', 'utf8');

    const result = spawnCli(['run', specFile], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.notStrictEqual(
      result.status,
      0,
      `Expected non-zero exit code when no .git exists, got 0`
    );

    assert.ok(
      combined.toLowerCase().includes('git') || combined.includes('.git'),
      `Expected git guard message in output, got: ${combined.trim()}`
    );

    // Should NOT mention .harness — this is a git guard failure, not a harness error
    assert.ok(
      !combined.includes('harness') || combined.toLowerCase().includes('git'),
      `Expected git guard message, not harness error. Got: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC2 — run --no-git-required in non-git dir bypasses git guard
// ---------------------------------------------------------------------------
await test('TC2: run --no-git-required in non-git dir bypasses git guard', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-git-guard-tc2-'));
  try {
    const specFile = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specFile, '# Test spec\n', 'utf8');

    const result = spawnCli(['run', specFile, '--no-git-required'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    // The git guard should be bypassed — so the output should NOT be about missing .git
    // (It may fail for other reasons — no SDK auth, no .harness, etc.)
    assert.ok(
      !combined.includes('No .git/ directory found'),
      `Expected git guard to be bypassed with --no-git-required, but got git guard message: ${combined.trim()}`
    );

    // Should fail for a different reason (not git-related), or succeed
    // The key assertion is that the git guard message is absent
    assert.ok(
      !combined.toLowerCase().includes('no .git'),
      `Expected no git guard message with --no-git-required, got: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC3 — dry-run in non-git dir exits non-zero with git guard message
// ---------------------------------------------------------------------------
await test('TC3: dry-run in non-git dir exits non-zero with git guard message', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-git-guard-tc3-'));
  try {
    const specFile = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specFile, '# Test spec\n', 'utf8');

    const result = spawnCli(['dry-run', specFile], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.notStrictEqual(
      result.status,
      0,
      `Expected non-zero exit code for dry-run in non-git dir, got 0`
    );

    assert.ok(
      combined.toLowerCase().includes('git') || combined.includes('.git'),
      `Expected git guard message in dry-run output, got: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC4 — status in non-git dir does NOT trigger git guard
// ---------------------------------------------------------------------------
await test("TC4: status in non-git dir does NOT trigger git guard (exits with .harness error)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-git-guard-tc4-'));
  try {
    const result = spawnCli(['status'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.notStrictEqual(
      result.status,
      0,
      `Expected non-zero exit code when .harness is missing, got 0`
    );

    // Should mention .harness, not the git guard
    assert.ok(
      combined.includes('.harness') || combined.includes('state.json') || combined.includes('init'),
      `Expected .harness error from status command, got: ${combined.trim()}`
    );

    // Should NOT mention the git guard no-.git message
    assert.ok(
      !combined.includes('No .git/ directory found'),
      `Expected status to skip git guard, but got git guard message: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC6 — resume in non-git dir does NOT trigger git guard
// ---------------------------------------------------------------------------
await test("TC6: resume in non-git dir does NOT trigger git guard", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-git-guard-tc6-'));
  try {
    // Create a minimal .harness/state.json so the harness-exists check passes
    const harnessDir = path.join(tmpDir, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    fs.writeFileSync(
      path.join(harnessDir, 'state.json'),
      JSON.stringify({ taskId: 'test-001', status: 'in_progress', tasks: [] }),
      'utf8'
    );

    const result = spawnCli(['resume'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    // Should NOT mention the git guard no-.git message
    assert.ok(
      !combined.includes('No .git/ directory found'),
      `Expected resume to skip git guard, but got git guard message: ${combined.trim()}`
    );

    // Should NOT mention git guard in any form
    assert.ok(
      !combined.toLowerCase().includes('git guard'),
      `Expected resume to skip git guard, but got git guard reference: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC5 — help output includes --allow-dirty and --no-git-required
// ---------------------------------------------------------------------------
await test("TC5: help output includes --allow-dirty and --no-git-required", async () => {
  const result = spawnCli(['help']);
  const combined = (result.stdout || '') + (result.stderr || '');

  assert.ok(
    combined.includes('--allow-dirty'),
    `Expected help output to include '--allow-dirty', got: ${combined.trim()}`
  );

  assert.ok(
    combined.includes('--no-git-required'),
    `Expected help output to include '--no-git-required', got: ${combined.trim()}`
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
