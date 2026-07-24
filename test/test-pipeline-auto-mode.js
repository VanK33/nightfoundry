/**
 * test-pipeline-auto-mode.js — Unit tests for Pipeline _gateConfirm category
 * gating and the plan-confirm y/n/auto menu.
 *
 * Tests construct a minimal Pipeline (mocked agents) and exercise:
 *   TC1: _gateConfirm with autoFromHere=true + category='A' returns true.
 *   TC2: _gateConfirm with autoFromHere=true + category='B' + non-TTY throws
 *        error containing 'exit-77'.
 *   TC3: _gateConfirm with autoFromHere=false falls through to onConfirm.
 *   TC4: plan-confirm (run method ~line 263) with autoFromHere=true skips
 *        the menu prompt (onMenu not called).
 *
 * Run: node test/test-pipeline-auto-mode.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { HaltError } from '../src/orchestrator/core/halt-error.js';

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
 * Create a minimal temp directory tree that satisfies Pipeline's constructor
 * (Logger needs .harness/logs/ to exist, which it creates via mkdirSync).
 */
function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-auto-'));
  // Logger creates .harness/logs/ itself; we just need the root dir.
  return root;
}

/**
 * Create a minimal Pipeline with silent logging.
 */
function makeMinimalPipeline(root, extraOpts = {}) {
  return new Pipeline(root, { onLog: () => {}, ...extraOpts });
}

/**
 * Pre-create the full harness directory structure and a minimal state.json so
 * that Pipeline.run() skips the bootstrap() call (state.json already present)
 * and can write plan files during writeGlobalPlan().
 */
function createHarnessStructure(root) {
  const hDir = path.join(root, '.harness');
  const subdirs = [
    'state',
    'plan',
    'verify',
    'progress',
    'verification',
    'analysis',
    'snapshots',
    'learning',
    'dry-run',
    'logs',
  ];
  for (const sub of subdirs) {
    fs.mkdirSync(path.join(hDir, sub), { recursive: true });
  }
  const stateJson = {
    projectMeta: {
      currentPhase: 'planning',
      prdPath: '',
      createdAt: new Date().toISOString(),
    },
    globalStatus: 'active',
    milestones: {},
  };
  fs.writeFileSync(path.join(hDir, 'state.json'), JSON.stringify(stateJson, null, 2));
}

// ── Helpers to temporarily override process.stdout.isTTY ─────────────────────

function setIsTTY(value) {
  try {
    Object.defineProperty(process.stdout, 'isTTY', {
      value,
      writable: true,
      configurable: true,
    });
  } catch (_) {
    // If defineProperty is blocked, fall back to direct assignment.
    process.stdout.isTTY = value;
  }
}

async function run() {
  // ── TC1: _gateConfirm category A + autoFromHere=true → true ─────────────
  await test('TC1: _gateConfirm category A + autoFromHere=true → true', async () => {
    const root = makeTmpRoot();
    try {
      const pipeline = makeMinimalPipeline(root);
      pipeline.autoFromHere = true;
      const result = await pipeline._gateConfirm(
        'test-site',
        'Test question?',
        { category: 'A', safeDefault: true },
      );
      assert.strictEqual(result, true, '_gateConfirm should return true for category A in auto mode');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ── TC2: _gateConfirm category B + autoFromHere=true + non-TTY → exit-77 ─
  await test('TC2: _gateConfirm category B + autoFromHere=true + non-TTY → exit-77 error', async () => {
    const root = makeTmpRoot();
    const origIsTTY = process.stdout.isTTY;
    setIsTTY(false);
    try {
      const pipeline = makeMinimalPipeline(root);
      pipeline.autoFromHere = true;
      let threw = false;
      let caughtErr = null;
      try {
        await pipeline._gateConfirm(
          'test-site',
          'Assumptions failed. Proceed anyway?',
          { category: 'B', safeDefault: false },
        );
      } catch (err) {
        threw = true;
        caughtErr = err;
      }
      assert.ok(threw, '_gateConfirm should throw when category B + autoFromHere + non-TTY');
      assert.ok(
        caughtErr instanceof HaltError,
        `Expected HaltError, got ${caughtErr?.constructor?.name}: "${caughtErr?.message}"`,
      );
    } finally {
      setIsTTY(origIsTTY);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ── TC3: _gateConfirm autoFromHere=false → onConfirm called ──────────────
  await test('TC3: _gateConfirm autoFromHere=false → onConfirm called', async () => {
    const root = makeTmpRoot();
    try {
      let confirmCalled = false;
      const pipeline = makeMinimalPipeline(root, {
        onConfirm: async () => {
          confirmCalled = true;
          return true;
        },
      });
      pipeline.autoFromHere = false;
      await pipeline._gateConfirm(
        'test-site',
        'Test question?',
        { category: 'A', safeDefault: true },
      );
      assert.ok(confirmCalled, 'onConfirm should be called when autoFromHere=false');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ── TC4: plan-confirm skipped when autoFromHere=true ─────────────────────
  await test('TC4: plan-confirm skipped when autoFromHere=true', async () => {
    const root = makeTmpRoot();
    try {
      let menuCalled = false;
      const pipeline = makeMinimalPipeline(root, {
        onMenu: async (_question, _options) => {
          menuCalled = true;
          return 'y';
        },
      });

      // Build a valid harness so run() skips bootstrap and can write plan files.
      createHarnessStructure(root);

      // Patch internal lifecycle methods to prevent real execution while
      // still allowing run() to reach the autoFromHere check at ~line 263.
      pipeline._checkOverwriteProtection = () => {};
      pipeline._runPreflight = () => {};
      pipeline._startAgentTicker = () => {};
      pipeline._stopAgentTicker = () => {};
      pipeline.planner.planGlobal = async () => ({
        milestones: [
          {
            id: '001',
            description: 'Mock milestone',
            missions: [{ id: '001-001', description: 'Mock mission' }],
          },
        ],
        assumptions: [],
      });
      pipeline.planner.closeReusableSession = async () => {};
      pipeline._executeAllMilestones = async () => {};
      pipeline._reviewGate = async () => {};
      // StatusBar methods are no-ops when not a TTY; patch them to be safe.
      pipeline.statusBar.updateAgent = () => {};
      pipeline.statusBar.setPhase = () => {};
      pipeline.statusBar.destroy = () => {};

      // Activate auto mode BEFORE calling run() — this is the contract being tested.
      pipeline.autoFromHere = true;

      await pipeline.run('test goal');

      assert.strictEqual(
        menuCalled,
        false,
        'onMenu should NOT be called for the plan-confirm prompt when autoFromHere=true',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

run();
