/**
 * test-run-complete-status.js — globalStatus='complete' write after run() and detectHaltInfo.
 *
 * TC1: After a run() clean completion, state.json on disk has globalStatus === 'complete'.
 * TC2: A missing/unwritable .harness state dir does not throw — the try/catch in run()
 *      swallows the error and run() still returns.
 * TC3: detectHaltInfo returns null for a state with globalStatus === 'complete' and all
 *      milestones terminal (the 'completed normally' branch is reachable).
 * TC3b: detectHaltInfo returns a non-null halt object for a non-complete (halted) state.
 *
 * Run: node test/test-run-complete-status.js
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { detectHaltInfo } from '../src/cli/commands/archive.js';
import { activeHarnessDir } from '../src/orchestrator/core/run-context.js';

const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');
const { bootstrap } = await import('../src/orchestrator/core/bootstrap.js');

// ── Test harness ─────────────────────────────────────────────────────────────

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

const tmpDirs = [];
function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
}

// ── Pipeline helpers ──────────────────────────────────────────────────────────

/**
 * Build a Pipeline whose run() reaches the post-final-test-gate globalStatus write
 * without doing any real work. Mirrors the pattern from test-run-final-test-gate.js.
 */
function makeRunnablePipeline(projectRoot, extraOpts = {}) {
  const pipeline = new Pipeline(projectRoot, {
    onLog: () => {},
    onConfirm: async () => true,
    ...extraOpts,
  });

  // Stub all external side-effects so only the run() completion path is exercised.
  pipeline._runPreflight = () => {};
  pipeline._checkOverwriteProtection = () => {};
  pipeline.planner.planGlobal = async () => ({
    milestones: [
      { id: '001', description: 'Test milestone', missions: [{ id: '001-001', description: 'Test mission' }] },
    ],
    assumptions: [],
    scopeItems: [],
    scopeMapping: [],
  });
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._remediateAssumptions = async () => ({ passed: true });
  pipeline._scopeCoverageGate = async () => {};
  pipeline._detectUncheckableSpec = () => {};
  pipeline._executeAllMilestones = async () => {};
  pipeline._reviewGate = async () => {};
  // Stub the final test gate so it is a no-op (no real test suite).
  pipeline._runFinalTestGate = () => {};

  return pipeline;
}

// ── TC1: after run() clean completion, state.json has globalStatus='complete' ──

await test("TC1 'clean run sets globalStatus=complete on disk'", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-run-complete-'));
  tmpDirs.push(tmpDir);

  bootstrap(tmpDir, {});

  const pipeline = makeRunnablePipeline(tmpDir);

  await pipeline.run('Test goal', { auto: true });

  // run() writes its state inside .harness/run-{id}/; the pointer is still
  // claimed post-run (cleared only at archive), so activeHarnessDir resolves
  // the run dir. The flat fixture state.json from bootstrap() above is
  // vestigial and must NOT be what we read.
  const harnessDir = activeHarnessDir(tmpDir);
  assert.notStrictEqual(harnessDir, path.join(tmpDir, '.harness'),
    'post-run, activeHarnessDir must resolve the per-run dir via the claimed pointer');
  const stateRaw = fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8');
  const state = JSON.parse(stateRaw);

  assert.strictEqual(
    state.globalStatus,
    'complete',
    `Expected globalStatus='complete' on disk after run(), got: ${state.globalStatus}`
  );
});

// ── TC2: missing/unwritable .harness state dir does not throw ─────────────────

await test("TC2 'write is best-effort'", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-run-nowrit-'));
  tmpDirs.push(tmpDir);

  bootstrap(tmpDir, {});

  const pipeline = makeRunnablePipeline(tmpDir);

  // After bootstrap, remove .harness entirely so the write inside run() will fail.
  // The try/catch in run() must swallow the error and run() must still return.
  const harnessDir = path.join(tmpDir, '.harness');
  // We patch writeJsonAtomic at the module level by overriding pipeline's internal
  // harnessDir to a non-existent path AFTER bootstrap so state.json write fails.
  // Simpler: remove the harness dir after bootstrap but before run().
  fs.rmSync(harnessDir, { recursive: true, force: true });

  // run() must complete without throwing even though the state.json write will fail.
  let threw = null;
  try {
    await pipeline.run('Test goal', { auto: true });
  } catch (err) {
    threw = err;
  }

  assert.strictEqual(
    threw,
    null,
    `Expected run() to complete without throwing when .harness is missing, got: ${threw && threw.message}`
  );
});

// ── TC3: detectHaltInfo returns null for complete + all-terminal state ─────────

await test("TC3 'detectHaltInfo returns null for complete+all-terminal state'", () => {
  // Construct a state with globalStatus='complete' and all milestones terminal.
  const completeState = {
    globalStatus: 'complete',
    milestones: {
      '001': { id: '001', description: 'Milestone one', status: 'complete' },
      '002': { id: '002', description: 'Milestone two', status: 'invalidated' },
    },
  };

  // detectHaltInfo's first argument is harnessDir; for the complete+all-terminal
  // branch it returns null without reading any files, so we can pass any string.
  const result = detectHaltInfo('/nonexistent-harness-dir', completeState);

  assert.strictEqual(
    result,
    null,
    `Expected detectHaltInfo to return null for complete+all-terminal state, got: ${JSON.stringify(result)}`
  );
});

// ── TC3b: detectHaltInfo returns non-null for a non-complete (halted) state ───

await test("TC3b 'detectHaltInfo returns non-null for a non-complete (halted) state'", () => {
  // Construct a non-complete state: globalStatus is 'active' (not 'complete')
  // and at least one milestone is not terminal.
  const haltedState = {
    globalStatus: 'active',
    milestones: {
      '001': { id: '001', description: 'Milestone one', status: 'in_progress' },
    },
  };

  // Use a temporary directory as harnessDir so detectHaltInfo doesn't crash
  // when it tries to read analysis/ files (it will gracefully handle missing dir).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-halted-'));
  tmpDirs.push(tmpDir);

  const result = detectHaltInfo(tmpDir, haltedState);

  assert.ok(
    result !== null,
    'Expected detectHaltInfo to return a non-null halt object for a non-complete state'
  );
  assert.ok(
    typeof result === 'object',
    `Expected a halt info object, got: ${JSON.stringify(result)}`
  );
  assert.ok(
    typeof result.haltReason === 'string',
    `Expected haltReason to be a string, got: ${typeof result.haltReason}`
  );
});

// ── Teardown & report ─────────────────────────────────────────────────────────

cleanup();

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
