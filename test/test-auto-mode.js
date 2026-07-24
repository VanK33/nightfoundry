/**
 * test-auto-mode.js — Unit tests for auto-mode plumbing in Pipeline.
 *
 * Verifies that opts.auto is correctly translated to mode:'autonomous' or
 * mode:'interactive' when _remediateAssumptions is called from run() and
 * dryRunValidate().
 *
 * Run: node test/test-auto-mode.js
 *
 * TC1: run() with auto:true  → _remediateAssumptions receives mode:'autonomous'
 * TC2: run() without auto    → _remediateAssumptions receives mode:'interactive'
 * TC3: dryRunValidate() with auto:true  → _remediateAssumptions receives mode:'autonomous'
 * TC4: dryRunValidate() without auto    → _remediateAssumptions receives mode:'interactive'
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');
const { bootstrap } = await import('../src/orchestrator/core/bootstrap.js');

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

/**
 * Build a minimal global plan that has exactly one assumption.
 * This ensures the `if (globalPlan.assumptions?.length)` branch is taken
 * and `_remediateAssumptions` is called.
 */
function makeGlobalPlanWithAssumption() {
  return {
    milestones: [
      {
        id: '001',
        description: 'Test milestone',
        missions: [{ id: '001-001', description: 'Test mission' }],
      },
    ],
    assumptions: [
      { text: 'Test assumption: project is a Node.js app' },
    ],
  };
}

/**
 * Set up a fresh temp directory with a bootstrapped harness, then return a
 * Pipeline instance with all external side-effects stubbed out so only the
 * _remediateAssumptions call path is exercised.
 *
 * Returns { tmpDir, pipeline, cleanup }.
 */
function makePipeline() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-auto-mode-'));

  // Bootstrap so run() / dryRunValidate() skip the bootstrap branch.
  bootstrap(tmpDir, {});

  const pipeline = new Pipeline(tmpDir, {
    onLog: () => {},                     // silence log output
    onConfirm: async () => false,        // reject any confirms — should not be reached
  });

  // ── Stub instance methods ──────────────────────────────────────────────

  // No-op preflight: avoids harness config checks.
  pipeline._runPreflight = () => {};

  // No-op overwrite protection: the bootstrapped state.json is safe, but
  // we stub this to avoid any state-machine inspection.
  pipeline._checkOverwriteProtection = () => {};

  // Return a plan with one assumption so _remediateAssumptions is always called.
  pipeline.planner.planGlobal = async () => makeGlobalPlanWithAssumption();

  // No-op reusable session close (called in the finally block of run()).
  pipeline.planner.closeReusableSession = async () => {};

  return {
    tmpDir,
    pipeline,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TC1: run() with auto:true → _remediateAssumptions gets mode:'autonomous'
// ─────────────────────────────────────────────────────────────────────────────
await test('TC1: run() with auto:true → _remediateAssumptions receives mode:\'autonomous\'', async () => {
  const { pipeline, cleanup } = makePipeline();
  try {
    let capturedOpts = null;
    let askAssumptionFixCalled = false;

    pipeline._remediateAssumptions = async (_plan, opts) => {
      capturedOpts = opts;
      // askAssumptionFix must NOT be called on the autonomous path.
      // Since we own this stub, we can guarantee it — and assert here.
      assert.strictEqual(askAssumptionFixCalled, false,
        'askAssumptionFix must not be called before _remediateAssumptions returns');
      return { passed: false };  // return early — avoids writeGlobalPlan + onConfirm
    };

    await pipeline.run('Test goal', { auto: true });

    assert.ok(capturedOpts !== null, '_remediateAssumptions should have been called');
    assert.strictEqual(capturedOpts.mode, 'autonomous',
      `Expected mode:'autonomous', got mode:'${capturedOpts.mode}'`);

    // askAssumptionFix was never called (stub replaced the entire method)
    assert.strictEqual(askAssumptionFixCalled, false,
      'askAssumptionFix must not be called on the autonomous path');
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC2: run() without auto → _remediateAssumptions gets mode:'interactive'
//      (regression guard)
// ─────────────────────────────────────────────────────────────────────────────
await test('TC2: run() without auto → _remediateAssumptions receives mode:\'interactive\'', async () => {
  const { pipeline, cleanup } = makePipeline();
  try {
    let capturedOpts = null;

    pipeline._remediateAssumptions = async (_plan, opts) => {
      capturedOpts = opts;
      return { passed: false };
    };

    await pipeline.run('Test goal', {});

    assert.ok(capturedOpts !== null, '_remediateAssumptions should have been called');
    assert.strictEqual(capturedOpts.mode, 'interactive',
      `Expected mode:'interactive', got mode:'${capturedOpts.mode}'`);
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC3: dryRunValidate() with auto:true → _remediateAssumptions gets mode:'autonomous'
// ─────────────────────────────────────────────────────────────────────────────
await test('TC3: dryRunValidate() with auto:true → _remediateAssumptions receives mode:\'autonomous\'', async () => {
  const { tmpDir, pipeline, cleanup } = makePipeline();
  try {
    // re-pin: w4-state-resume-persistence — dryRunValidate now fails honestly
    // at validate time when opts.prdPath === undefined (a missing-prdPath entry
    // would pass validation but die at execute time). This test is about the
    // auto→mode routing into _remediateAssumptions, so give it a real prdPath
    // (spec.md + a checkable spec.json sibling so the uncheckable-spec gate is
    // satisfied) and assert the routing still works.
    const specMdPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specMdPath, '# Test spec\n');
    fs.writeFileSync(path.join(tmpDir, 'spec.json'), JSON.stringify({
      acceptance_criteria: [{ description: 'manual check', verification: { kind: 'manual' } }],
    }, null, 2));

    let capturedOpts = null;
    let askAssumptionFixCalled = false;

    pipeline._remediateAssumptions = async (_plan, opts) => {
      capturedOpts = opts;
      assert.strictEqual(askAssumptionFixCalled, false,
        'askAssumptionFix must not be called before _remediateAssumptions returns');
      return { passed: false };  // return early — avoids onConfirm + writeQueueEntry
    };

    await pipeline.dryRunValidate('Test goal', { auto: true, prdPath: specMdPath });

    assert.ok(capturedOpts !== null, '_remediateAssumptions should have been called');
    assert.strictEqual(capturedOpts.mode, 'autonomous',
      `Expected mode:'autonomous', got mode:'${capturedOpts.mode}'`);

    // askAssumptionFix was never called (stub replaced the entire method)
    assert.strictEqual(askAssumptionFixCalled, false,
      'askAssumptionFix must not be called on the autonomous path');
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC4: dryRunValidate() without auto → _remediateAssumptions gets mode:'interactive'
// ─────────────────────────────────────────────────────────────────────────────
await test('TC4: dryRunValidate() without auto → _remediateAssumptions receives mode:\'interactive\'', async () => {
  const { tmpDir, pipeline, cleanup } = makePipeline();
  try {
    // re-pin: w4-state-resume-persistence — dryRunValidate now fails honestly
    // at validate time when opts.prdPath === undefined. This test asserts the
    // (no-auto)→mode:'interactive' routing, so give it a real prdPath
    // (spec.md + checkable spec.json sibling) rather than the now-rejected
    // undefined-prdPath shape.
    const specMdPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specMdPath, '# Test spec\n');
    fs.writeFileSync(path.join(tmpDir, 'spec.json'), JSON.stringify({
      acceptance_criteria: [{ description: 'manual check', verification: { kind: 'manual' } }],
    }, null, 2));

    let capturedOpts = null;

    pipeline._remediateAssumptions = async (_plan, opts) => {
      capturedOpts = opts;
      return { passed: false };
    };

    await pipeline.dryRunValidate('Test goal', { prdPath: specMdPath });

    assert.ok(capturedOpts !== null, '_remediateAssumptions should have been called');
    assert.strictEqual(capturedOpts.mode, 'interactive',
      `Expected mode:'interactive', got mode:'${capturedOpts.mode}'`);
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
