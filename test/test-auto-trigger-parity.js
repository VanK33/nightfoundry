/**
 * test-auto-trigger-parity.js — Parity tests for auto-trigger sources and _gateConfirm.
 *
 * Verifies that --auto flag, in-run 'a' menu choice, and binary y/n onConfirm
 * produce equivalent observable behaviour at _gateConfirm call sites.
 *
 * TC1: --auto CLI flag sets autoFromHere=true, Cat-A auto-resolves without onConfirm
 * TC2: in-run menu 'a' choice (manual autoFromHere=true) produces identical _gateConfirm
 *      behaviour to TC1
 * TC3: y/n menu 'y' (autoFromHere stays false, onConfirm=true) produces same boolean
 *      result as binary onConfirm=true
 * TC4: --auto suppresses plan-approval: autoFromHere=true causes the plan-confirm
 *      branch to be skipped (onMenu is never called at that site)
 *
 * Run: node test/test-auto-trigger-parity.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';

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

/**
 * Replicate the createPipeline pattern from src/cli/commands/run.js.
 * projectRoot: string
 * flags: { auto?: boolean, a?: boolean }
 */
function createPipeline(projectRoot, flags) {
  const autoMode = flags.auto || flags.a;
  const opts = {
    onLog: () => {},
    onConfirm: autoMode
      ? async () => true
      : async (_question, _askOpts) => false, // interactive non-auto returns false by default
    onMenu: autoMode
      ? async (_question, options) => (options ? options[0].key : null)
      : async (_question, _options, _askOpts) => 'y',
    statusBar: false,
  };
  const pipeline = new Pipeline(projectRoot, opts);
  pipeline.autoFromHere = !!autoMode;
  return pipeline;
}

/**
 * Make a minimal bootstrapped temp directory and return cleanup fn.
 */
function makeTmpDir(prefix) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  bootstrap(tmpDir, {});
  return { tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

// ─────────────────────────────────────────────────────────────────────────────
// TC1: --auto CLI flag sets autoFromHere=true; Cat-A _gateConfirm auto-resolves
// ─────────────────────────────────────────────────────────────────────────────
await test('TC1: --auto flag → autoFromHere===true, Cat-A _gateConfirm resolves true without calling onConfirm', async () => {
  const { tmpDir, cleanup } = makeTmpDir('test-auto-trig-tc1-');
  try {
    // Replicate createPipeline with flags.auto=true
    const pipeline = createPipeline(tmpDir, { auto: true });

    // Assert autoFromHere is set by the createPipeline pattern
    assert.strictEqual(pipeline.autoFromHere, true,
      `Expected pipeline.autoFromHere===true, got ${pipeline.autoFromHere}`);

    // Track whether onConfirm is called (it must NOT be for Cat-A auto)
    let onConfirmCalled = false;
    const origOnConfirm = pipeline.onConfirm;
    pipeline.onConfirm = async (...args) => {
      onConfirmCalled = true;
      return origOnConfirm(...args);
    };

    const result = await pipeline._gateConfirm('site', 'q', { category: 'A', safeDefault: true });

    assert.strictEqual(result, true,
      `Expected _gateConfirm to return true, got ${result}`);
    assert.strictEqual(onConfirmCalled, false,
      'onConfirm must NOT be called for Cat-A when autoFromHere===true');
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC2: in-run menu 'a' choice (autoFromHere set manually) → identical behaviour
// ─────────────────────────────────────────────────────────────────────────────
await test('TC2: in-run menu "a" choice (manual autoFromHere=true) → same _gateConfirm parity as TC1', async () => {
  const { tmpDir, cleanup } = makeTmpDir('test-auto-trig-tc2-');
  try {
    // Start as non-auto (autoFromHere=false) — simulates a pipeline that was
    // created without --auto.
    const pipeline = createPipeline(tmpDir, { auto: false });

    assert.strictEqual(pipeline.autoFromHere, false,
      `Expected pipeline.autoFromHere===false initially, got ${pipeline.autoFromHere}`);

    // Simulate the user choosing 'a' from the plan-confirm menu, which sets
    // autoFromHere=true inside pipeline.run() at the plan-approval branch.
    pipeline.autoFromHere = true;

    // Now _gateConfirm should behave identically to TC1.
    let onConfirmCalled = false;
    const origOnConfirm = pipeline.onConfirm;
    pipeline.onConfirm = async (...args) => {
      onConfirmCalled = true;
      return origOnConfirm(...args);
    };

    const result = await pipeline._gateConfirm('site', 'q', { category: 'A', safeDefault: true });

    assert.strictEqual(result, true,
      `Expected _gateConfirm to return true after 'a' choice, got ${result}`);
    assert.strictEqual(onConfirmCalled, false,
      'onConfirm must NOT be called for Cat-A when autoFromHere===true (set via "a" choice)');
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC3: y/n menu 'y' (autoFromHere=false, onConfirm=true) → same true result
// ─────────────────────────────────────────────────────────────────────────────
await test('TC3: y/n "y" choice (autoFromHere=false, onConfirm=true) → _gateConfirm returns true', async () => {
  const { tmpDir, cleanup } = makeTmpDir('test-auto-trig-tc3-');
  try {
    // Non-auto pipeline — autoFromHere stays false.
    const pipeline = createPipeline(tmpDir, { auto: false });

    assert.strictEqual(pipeline.autoFromHere, false,
      `Expected autoFromHere===false, got ${pipeline.autoFromHere}`);

    // Override onConfirm to return true (simulates user typing 'y')
    let onConfirmCalled = false;
    pipeline.onConfirm = async () => {
      onConfirmCalled = true;
      return true;
    };

    // With autoFromHere=false, _gateConfirm delegates to onConfirm for ALL categories.
    const result = await pipeline._gateConfirm('site', 'q', { category: 'A', safeDefault: true });

    assert.strictEqual(result, true,
      `Expected _gateConfirm to return true when onConfirm=true, got ${result}`);
    assert.strictEqual(onConfirmCalled, true,
      'onConfirm MUST be called when autoFromHere===false (interactive mode)');
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC4: --auto suppresses plan-approval menu (autoFromHere=true skips onMenu)
// ─────────────────────────────────────────────────────────────────────────────
await test('TC4: --auto suppresses plan-approval: autoFromHere=true → onMenu not called at plan-confirm site', async () => {
  const { tmpDir, cleanup } = makeTmpDir('test-auto-trig-tc4-');
  try {
    const pipeline = createPipeline(tmpDir, { auto: true });

    assert.strictEqual(pipeline.autoFromHere, true,
      `Expected pipeline.autoFromHere===true, got ${pipeline.autoFromHere}`);

    // Track whether onMenu is invoked at the plan-confirm site.
    let planConfirmMenuCalled = false;

    // Stub all pipeline internals needed to exercise the plan-confirm branch.
    pipeline._runPreflight = () => {};
    pipeline._checkOverwriteProtection = () => {};
    pipeline._startAgentTicker = () => {};
    pipeline._stopAgentTicker = () => {};

    // Stub planner to return a minimal plan (no assumptions → skips _remediateAssumptions)
    pipeline.planner.planGlobal = async () => ({
      milestones: [
        {
          id: '001',
          description: 'Test milestone',
          missions: [{ id: '001-001', description: 'Test mission' }],
        },
      ],
      // no assumptions → skips _remediateAssumptions block
    });

    pipeline.planner.closeReusableSession = async () => {};

    // Intercept onMenu: if called with the plan-confirm question, record it.
    const origOnMenu = pipeline.onMenu;
    pipeline.onMenu = async (question, options, ...rest) => {
      if (question === 'Proceed with this plan?') {
        planConfirmMenuCalled = true;
      }
      return origOnMenu ? origOnMenu(question, options, ...rest) : null;
    };

    // Intercept _executeAllMilestones to short-circuit after plan-confirm branch.
    pipeline._executeAllMilestones = async () => {
      // reached here — plan was approved (not rejected), test is done
    };

    // Intercept _reviewGate to short-circuit
    pipeline._reviewGate = async () => {};

    // Run the pipeline — should reach _executeAllMilestones without calling the menu
    await pipeline.run('Test goal', { auto: true });

    assert.strictEqual(planConfirmMenuCalled, false,
      'onMenu must NOT be called at the plan-confirm site when autoFromHere===true');
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
