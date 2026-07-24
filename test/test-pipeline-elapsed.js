#!/usr/bin/env node

/**
 * Integration test: Pipeline._writeElapsedToSidecar
 * Tests elapsed-time sidecar merging without spawning claude sessions.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

async function main() {
  let passCount = 0;
  let failCount = 0;

  function assert(label, condition) {
    if (condition) {
      console.log(`  [PASS] ${label}`);
      passCount++;
    } else {
      console.log(`  [FAIL] ${label}`);
      failCount++;
    }
  }

  console.log('=== Pipeline _writeElapsedToSidecar Tests ===\n');

  const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');

  /**
   * Helper: create a temp harness directory with .harness/progress.
   * Returns { projectRoot, harnessDir, pipeline }.
   */
  function makeTmpHarness() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-elapsed-'));
    const hDir = path.join(root, '.harness');
    fs.mkdirSync(path.join(hDir, 'progress'), { recursive: true });
    fs.mkdirSync(path.join(hDir, 'logs'), { recursive: true });
    const p = new Pipeline(root, { onLog: () => {} });
    return { projectRoot: root, harnessDir: hDir, pipeline: p };
  }

  // TC1: merges executorElapsedMs into existing sidecar
  console.log('TC1: merges executorElapsedMs into existing sidecar');
  {
    const { projectRoot, harnessDir, pipeline } = makeTmpHarness();
    const sidecarPath = path.join(harnessDir, 'progress', 'task-test-1.json');
    fs.writeFileSync(sidecarPath, JSON.stringify({ status: 'COMPLETED' }, null, 2));

    pipeline._writeElapsedToSidecar('test-1', 'executorElapsedMs', 12345);

    const result = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert("TC1: status is 'COMPLETED'", result.status === 'COMPLETED');
    assert('TC1: executorElapsedMs is 12345', result.executorElapsedMs === 12345);

    // cleanup
    process.removeListener('SIGINT', pipeline._signalHandlers.SIGINT);
    process.removeListener('SIGTERM', pipeline._signalHandlers.SIGTERM);
    process.removeListener('exit', pipeline._signalHandlers.exit);
    process.removeListener('uncaughtException', pipeline._signalHandlers.uncaughtException);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }

  // TC2: merges verifierElapsedMs into existing sidecar
  console.log('\nTC2: merges verifierElapsedMs into existing sidecar');
  {
    const { projectRoot, harnessDir, pipeline } = makeTmpHarness();
    const sidecarPath = path.join(harnessDir, 'progress', 'task-test-1.json');
    fs.writeFileSync(sidecarPath, JSON.stringify({ status: 'COMPLETED' }, null, 2));

    pipeline._writeElapsedToSidecar('test-1', 'verifierElapsedMs', 6789);

    const result = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert("TC2: status is 'COMPLETED'", result.status === 'COMPLETED');
    assert('TC2: verifierElapsedMs is 6789', result.verifierElapsedMs === 6789);

    // cleanup
    process.removeListener('SIGINT', pipeline._signalHandlers.SIGINT);
    process.removeListener('SIGTERM', pipeline._signalHandlers.SIGTERM);
    process.removeListener('exit', pipeline._signalHandlers.exit);
    process.removeListener('uncaughtException', pipeline._signalHandlers.uncaughtException);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }

  // TC3: no-ops gracefully when sidecar missing
  console.log('\nTC3: no-ops gracefully when sidecar missing');
  {
    const { projectRoot, harnessDir, pipeline } = makeTmpHarness();

    let threw = false;
    try {
      pipeline._writeElapsedToSidecar('nonexistent-task-id', 'executorElapsedMs', 999);
    } catch {
      threw = true;
    }
    assert('TC3: does not throw when sidecar missing', threw === false);

    // cleanup
    process.removeListener('SIGINT', pipeline._signalHandlers.SIGINT);
    process.removeListener('SIGTERM', pipeline._signalHandlers.SIGTERM);
    process.removeListener('exit', pipeline._signalHandlers.exit);
    process.removeListener('uncaughtException', pipeline._signalHandlers.uncaughtException);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }

  // TC4: no-ops gracefully when sidecar is malformed
  console.log('\nTC4: no-ops gracefully when sidecar is malformed');
  {
    const { projectRoot, harnessDir, pipeline } = makeTmpHarness();
    const sidecarPath = path.join(harnessDir, 'progress', 'task-test-1.json');
    fs.writeFileSync(sidecarPath, 'not json');

    let threw = false;
    try {
      pipeline._writeElapsedToSidecar('test-1', 'executorElapsedMs', 111);
    } catch {
      threw = true;
    }
    assert('TC4: does not throw when sidecar is malformed', threw === false);

    // cleanup
    process.removeListener('SIGINT', pipeline._signalHandlers.SIGINT);
    process.removeListener('SIGTERM', pipeline._signalHandlers.SIGTERM);
    process.removeListener('exit', pipeline._signalHandlers.exit);
    process.removeListener('uncaughtException', pipeline._signalHandlers.uncaughtException);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }

  console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
