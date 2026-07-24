/**
 * test-session-wall-clock-cap.js — Unit tests for wall-clock session cap.
 *
 * Covers:
 *   TC1: tiny maxSessionWallClockMs aborts promptly without hanging
 *   TC2: WallClockExceededError is NOT retryable InfrastructureError
 *   TC3: default maxSessionWallClockMs >= 2400000
 *   TC4: per-task elapsed present in progress sidecar after _writeElapsedToSidecar
 *
 * Run: node test/test-session-wall-clock-cap.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SessionManager, InfrastructureError, WallClockExceededError } from '../src/orchestrator/infra/session-manager.js';
import config from '../src/orchestrator/infra/config.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// --- TC1: tiny maxSessionWallClockMs aborts promptly without hanging ---
await test('TC1: tiny maxSessionWallClockMs aborts promptly without hanging', async () => {
  const originalCap = config.execution.maxSessionWallClockMs;
  try {
    config.execution.maxSessionWallClockMs = 200;

    const sm = new SessionManager();

    // Mock _queryFn: returns an async generator that stalls indefinitely
    sm._queryFn = async function* stallingGenerator(_options) {
      // Never produces a result event — stalls with a long timeout
      await new Promise((resolve) => setTimeout(resolve, 999999));
      // This line is never reached
      yield { type: 'result', result: null };
    };

    const start = Date.now();
    let thrownErr = null;
    try {
      await sm.spawn({
        prompt: 'test prompt',
        name: 'tc1-wall-clock-test',
      });
    } catch (err) {
      thrownErr = err;
    }
    const elapsed = Date.now() - start;

    assert.ok(thrownErr !== null, 'Expected spawn() to reject, but it resolved');
    assert.ok(
      thrownErr instanceof WallClockExceededError,
      `Expected WallClockExceededError, got ${thrownErr?.constructor?.name}: ${thrownErr?.message}`
    );
    assert.ok(
      elapsed < 1000,
      `Expected spawn() to abort in < 1 second, but took ${elapsed}ms`
    );
  } finally {
    config.execution.maxSessionWallClockMs = originalCap;
  }
});

// --- TC2: WallClockExceededError is NOT retryable InfrastructureError ---
await test('TC2: WallClockExceededError is NOT retryable InfrastructureError', () => {
  const err = new WallClockExceededError('Session exceeded wall-clock limit');

  assert.ok(
    !(err instanceof InfrastructureError),
    'Expected WallClockExceededError to NOT be instanceof InfrastructureError'
  );
  assert.strictEqual(
    err.retryable,
    false,
    `Expected err.retryable === false, got ${err.retryable}`
  );
  assert.strictEqual(
    err.category,
    'wall-clock-exceeded',
    `Expected err.category === 'wall-clock-exceeded', got '${err.category}'`
  );
});

// --- TC3: default maxSessionWallClockMs >= 2400000 ---
await test('TC3: default maxSessionWallClockMs >= 2400000', () => {
  assert.ok(
    config.execution.maxSessionWallClockMs >= 2400000,
    `Expected maxSessionWallClockMs >= 2400000 (40 minutes), got ${config.execution.maxSessionWallClockMs}`
  );
});

// --- TC4: per-task elapsed present in progress sidecar after _writeElapsedToSidecar ---
await test('TC4: per-task elapsed present in progress sidecar after _writeElapsedToSidecar', async () => {
  // Create a tmpDir with the required harness structure
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-tc4-'));
  const harnessDir = path.join(tmpDir, '.harness');
  const progressDir = path.join(harnessDir, 'progress');

  try {
    fs.mkdirSync(progressDir, { recursive: true });

    // Write an initial sidecar with status COMPLETED
    const sidecarPath = path.join(progressDir, 'task-test-elapsed.json');
    fs.writeFileSync(sidecarPath, JSON.stringify({ status: 'COMPLETED' }), 'utf8');

    // Construct a minimal Pipeline instance
    const pipeline = new Pipeline(tmpDir, { onLog: () => {} });

    // Call _writeElapsedToSidecar to add the elapsed field
    await pipeline._writeElapsedToSidecar('test-elapsed', 'executorElapsedMs', 5000);

    // Read back the sidecar and assert both fields are present
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    assert.strictEqual(
      sidecar.executorElapsedMs,
      5000,
      `Expected executorElapsedMs === 5000, got ${sidecar.executorElapsedMs}`
    );
    assert.strictEqual(
      sidecar.status,
      'COMPLETED',
      `Expected status === 'COMPLETED', got '${sidecar.status}'`
    );
  } finally {
    // Clean up tmpDir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// --- Summary ---
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
