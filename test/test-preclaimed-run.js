/**
 * test-preclaimed-run.js — Unit tests for run()'s opts.preclaimedRun
 * fast-path: when the caller (e.g. the CLI) has already claimed the
 * active-run pointer in the same process, it can hand that pointer's
 * {runId, slug} to run() via opts.preclaimedRun so run() skips
 * claimActiveRun entirely and bootstraps directly against the supplied
 * runId — but ONLY when the on-disk pointer still matches the supplied
 * runId. A mismatch (foreign/stale pointer, or none at all) must fall
 * through to the pre-existing derive-slug/claim path unchanged.
 *
 * TC1 — pointer pre-claimed with runId X + opts.preclaimedRun={runId:X}:
 *       run() completes, pipeline.harnessDir === runHarnessDir(root, X),
 *       and a bootstrapped state.json exists under that dir — proving
 *       claimActiveRun was SKIPPED (not refused) for the matching case.
 * TC2 — pointer pre-claimed with a foreign runId Y whose run dir carries a
 *       globalStatus:'complete' state.json + opts.preclaimedRun={runId:X}
 *       (X !== Y): run() falls through to the claim path (claimActiveRun
 *       fails since Y still holds the pointer), which routes to
 *       _checkOverwriteProtection and throws the overwrite-protection
 *       guidance ('already completed') — proving a mismatch does NOT
 *       honor the option.
 * TC3 — fresh root, run() WITHOUT opts.preclaimedRun: a new pointer is
 *       claimed (readActiveRunPointer(root).runId is a generated id) and
 *       the harness is bootstrapped — proving the absent-option path is
 *       unchanged from pre-existing behavior.
 *
 * No Claude auth, no SDK — every agent/gate seam is stubbed (mirrors
 * test-runid-flip.js's makeRunnablePipeline). Every fixture root is an
 * isolated fs.mkdtemp() directory.
 *
 * Clear CC_ORCH_ACTIVE_RUN unconditionally at module top (mirrors
 * scripts/run-tests.js and test-runid-flip.js) so this suite is
 * re-entrancy-neutral regardless of launch context.
 *
 * Run: node test/test-preclaimed-run.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import {
  generateRunId,
  runHarnessDir,
  claimActiveRun,
  readActiveRunPointer,
} from '../src/orchestrator/core/run-context.js';

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

// ---------- Fixture helpers ----------

function createRoot(prefix = 'preclaimed-run-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function cannedGlobalPlan() {
  return {
    milestones: [
      { id: '001', description: 'Test milestone', missions: [{ id: '001-001', description: 'Test mission' }] },
    ],
    assumptions: [],
    scopeItems: [],
    scopeMapping: [],
  };
}

/**
 * Build a Pipeline whose run() reaches the post-final-test-gate globalStatus
 * write without doing any real work (mirrors test-runid-flip.js's
 * makeRunnablePipeline). Deliberately does NOT stub _checkOverwriteProtection
 * — TC2 needs the REAL implementation to exercise the overwrite-protection
 * throw.
 */
function makeRunnablePipeline(projectRoot, extraOpts = {}) {
  const pipeline = new Pipeline(projectRoot, {
    onLog: () => {},
    onConfirm: async () => true,
    ...extraOpts,
  });
  pipeline.planner.planGlobal = async () => cannedGlobalPlan();
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._remediateAssumptions = async () => ({ passed: true });
  pipeline._scopeCoverageGate = async () => {};
  pipeline._detectUncheckableSpec = () => {};
  pipeline._executeAllMilestones = async () => {};
  pipeline._reviewGate = async () => {};
  pipeline._runFinalTestGate = () => {};
  return pipeline;
}

// ---------- TC1: matching preclaimed pointer — claim is skipped ----------

await test('TC1: run() with opts.preclaimedRun matching the on-disk pointer skips claimActiveRun and bootstraps directly under that runId', async () => {
  const root = createRoot();
  try {
    const slug = 'preclaimed-tc1';
    const runId = generateRunId(slug);
    const claimed = claimActiveRun(root, { runId, slug, kind: 'run' });
    assert.ok(claimed, 'sanity: claimActiveRun should succeed for a fresh root');

    const pipeline = makeRunnablePipeline(root);
    await pipeline.run('Build TC1 goal', { auto: true, preclaimedRun: { runId, slug } });

    const expectedHarnessDir = runHarnessDir(root, runId);
    assert.strictEqual(
      pipeline.harnessDir,
      expectedHarnessDir,
      `pipeline.harnessDir should equal runHarnessDir(root, X), got ${pipeline.harnessDir} vs ${expectedHarnessDir}`
    );

    const stateFile = path.join(expectedHarnessDir, 'state.json');
    assert.ok(fs.existsSync(stateFile), 'a bootstrapped state.json should exist under the preclaimed run dir');

    // The pointer must still resolve to the same runId (claimActiveRun was
    // never re-invoked; it was skipped, not refused/re-claimed).
    const pointer = readActiveRunPointer(root);
    assert.ok(pointer, 'active-run pointer should still be present after run()');
    assert.strictEqual(pointer.runId, runId, 'pointer runId should be unchanged (X), proving the claim step was skipped');
  } finally {
    cleanup(root);
  }
});

// ---------- TC2: mismatched preclaimed pointer — falls through to claim/overwrite-protection ----------

await test('TC2: run() with opts.preclaimedRun NOT matching a foreign completed-run pointer falls through and throws overwrite-protection guidance', async () => {
  const root = createRoot();
  try {
    const slugY = 'preclaimed-tc2-foreign';
    const runIdY = generateRunId(slugY);
    const claimedY = claimActiveRun(root, { runId: runIdY, slug: slugY, kind: 'run' });
    assert.ok(claimedY, 'sanity: claimActiveRun should succeed for a fresh root');

    const runDirY = runHarnessDir(root, runIdY);
    fs.mkdirSync(runDirY, { recursive: true });
    const stateY = {
      globalStatus: 'complete',
      milestones: { '001': { id: '001', description: 'Done', status: 'complete' } },
      projectMeta: { currentPhase: 'complete' },
    };
    fs.writeFileSync(path.join(runDirY, 'state.json'), JSON.stringify(stateY, null, 2), 'utf8');

    // A DIFFERENT runId X, never claimed on disk — the caller believes it
    // preclaimed X, but the on-disk pointer actually resolves to Y.
    const slugX = 'preclaimed-tc2-caller';
    const runIdX = generateRunId(slugX);
    assert.notStrictEqual(runIdX, runIdY, 'sanity: X and Y must differ');

    const pipeline = makeRunnablePipeline(root);
    let thrown = null;
    try {
      await pipeline.run('Build TC2 goal', { preclaimedRun: { runId: runIdX, slug: slugX } });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'run() must throw when opts.preclaimedRun does not match a foreign completed-run pointer');
    assert.ok(
      thrown.message.includes('already completed'),
      `expected 'already completed' overwrite-protection guidance, got: ${thrown.message}`
    );

    // The foreign pointer (Y) must be untouched — the mismatch never
    // re-claimed or clobbered it.
    const pointer = readActiveRunPointer(root);
    assert.ok(pointer, 'foreign pointer should still be present after the throw');
    assert.strictEqual(pointer.runId, runIdY, "foreign pointer's runId (Y) must be unchanged");
  } finally {
    cleanup(root);
  }
});

// ---------- TC3: absent preclaimedRun — existing claim path unchanged ----------

await test('TC3: run() without opts.preclaimedRun on a fresh root claims a new pointer with a generated runId and bootstraps (unchanged behavior)', async () => {
  const root = createRoot();
  try {
    assert.strictEqual(readActiveRunPointer(root), null, 'sanity: fresh root should have no active-run pointer');

    const pipeline = makeRunnablePipeline(root);
    await pipeline.run('Build TC3 goal', { auto: true });

    const pointer = readActiveRunPointer(root);
    assert.ok(
      pointer && typeof pointer.runId === 'string' && pointer.runId.length > 0,
      'run() should have claimed a new pointer with a generated runId'
    );

    const expectedHarnessDir = runHarnessDir(root, pointer.runId);
    assert.strictEqual(
      pipeline.harnessDir,
      expectedHarnessDir,
      'pipeline.harnessDir should resolve to the newly-claimed runId'
    );

    const stateFile = path.join(expectedHarnessDir, 'state.json');
    assert.ok(fs.existsSync(stateFile), 'a bootstrapped state.json should exist under the newly-claimed run dir');
  } finally {
    cleanup(root);
  }
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
