/**
 * test-cli-router-spec-stdin.js — Deterministic router-level regression test
 * for the `--spec-stdin` bypass of the missing-positional Usage guard on
 * `run` and `dry-run`.
 *
 * Run: node test/test-cli-router-spec-stdin.js
 *
 * This test requires NO Claude SDK/auth and NO full pipeline execution: it
 * only spawns the CLI router (src/cli/index.js) with malformed JSON on
 * stdin, which fails fast inside prepareUserSpecInput() before any agent
 * session is ever created.
 *
 * Covers:
 *   TC1 — 'run --spec-stdin -a --allow-dirty --no-git-required' with malformed
 *         JSON on stdin: stderr lacks 'Usage: nightfoundry run' and contains
 *         'Failed to parse JSON from stdin' (proves the missing-positional
 *         guard was bypassed and control reached run()).
 *   TC2 — 'run' with no positional and no --spec-stdin: stderr contains
 *         'Usage: nightfoundry run <spec.md>' and exit status is 1 (guard still
 *         fires for the ordinary invocation).
 *   TC3 — 'dry-run --spec-stdin -a --allow-dirty --no-git-required' with
 *         malformed JSON on stdin: stderr lacks 'Usage: nightfoundry dry-run' and
 *         contains 'Failed to parse JSON from stdin'.
 *   TC4 — 'dry-run' with no positional and no --spec-stdin: stderr contains
 *         'Usage: nightfoundry dry-run <spec.md>' and exit status is 1.
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
// TC1 — 'run --spec-stdin -a --allow-dirty --no-git-required' with malformed
// JSON on stdin bypasses the "Usage: nightfoundry run" guard and reaches run().
// ---------------------------------------------------------------------------
await test(
  "TC1: 'run --spec-stdin -a --allow-dirty --no-git-required' with malformed stdin JSON bypasses Usage guard",
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-spec-stdin-test-'));
    try {
      const result = spawnCli(
        ['run', '--spec-stdin', '-a', '--allow-dirty', '--no-git-required'],
        { cwd: tmpDir, input: '{ not valid json' }
      );
      const stderr = result.stderr || '';

      assert.ok(
        !stderr.includes('Usage: nightfoundry run'),
        `Expected the missing-positional Usage guard to be bypassed, but got: ${stderr.trim()}`
      );

      assert.ok(
        stderr.includes('Failed to parse JSON from stdin'),
        `Expected stderr to contain "Failed to parse JSON from stdin", got: ${stderr.trim()}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// TC2 — 'run' with no positional and no --spec-stdin: the Usage guard still
// fires normally.
// ---------------------------------------------------------------------------
await test(
  "TC2: 'run' with no positional and no --spec-stdin still fires the Usage guard",
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-spec-stdin-test-'));
    try {
      const result = spawnCli(['run'], { cwd: tmpDir });
      const stderr = result.stderr || '';

      assert.ok(
        stderr.includes('Usage: nightfoundry run <spec.md>'),
        `Expected stderr to contain "Usage: nightfoundry run <spec.md>", got: ${stderr.trim()}`
      );

      assert.strictEqual(
        result.status,
        1,
        `Expected exit status 1, got ${result.status}. stderr: ${stderr.trim()}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// TC3 — 'dry-run --spec-stdin -a --allow-dirty --no-git-required' with
// malformed JSON on stdin bypasses the "Usage: nightfoundry dry-run" guard and
// reaches the stdin read.
// ---------------------------------------------------------------------------
await test(
  "TC3: 'dry-run --spec-stdin -a --allow-dirty --no-git-required' with malformed stdin JSON bypasses Usage guard",
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-spec-stdin-test-'));
    try {
      const result = spawnCli(
        ['dry-run', '--spec-stdin', '-a', '--allow-dirty', '--no-git-required'],
        { cwd: tmpDir, input: '{ not valid json' }
      );
      const stderr = result.stderr || '';

      assert.ok(
        !stderr.includes('Usage: nightfoundry dry-run'),
        `Expected the missing-positional Usage guard to be bypassed, but got: ${stderr.trim()}`
      );

      assert.ok(
        stderr.includes('Failed to parse JSON from stdin'),
        `Expected stderr to contain "Failed to parse JSON from stdin" (proving the stdin read was reached), got: ${stderr.trim()}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// TC4 — 'dry-run' with no positional and no --spec-stdin: the Usage guard
// still fires normally.
// ---------------------------------------------------------------------------
await test(
  "TC4: 'dry-run' with no positional and no --spec-stdin still fires the Usage guard",
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-spec-stdin-test-'));
    try {
      const result = spawnCli(['dry-run'], { cwd: tmpDir });
      const stderr = result.stderr || '';

      assert.ok(
        stderr.includes('Usage: nightfoundry dry-run <spec.md>'),
        `Expected stderr to contain "Usage: nightfoundry dry-run <spec.md>", got: ${stderr.trim()}`
      );

      assert.strictEqual(
        result.status,
        1,
        `Expected exit status 1, got ${result.status}. stderr: ${stderr.trim()}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
