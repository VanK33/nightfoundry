/**
 * test-pipeline-repoint.js — Exercises the run-id-scoped harness "seam
 * flip" and the active-run claim lifecycle end-to-end, using isolated
 * fs.mkdtemp() project roots.
 *
 * TC1: Pipeline's constructor binds this.harnessDir via activeHarnessDir():
 *      (a) the flat harnessRoot(projectRoot) fallback when no active-run
 *          pointer exists, and (b) runHarnessDir(projectRoot, runId) when a
 *          valid pointer + that run's state.json both exist.
 * TC2: _repointHarness(dir) rebuilds logger/tokenTracker/progress/scheduler
 *      against the new dir (fresh instances, all reading this.harnessDir ===
 *      dir) and re-wires sessionManager's tokenTracker reference to the new
 *      TokenTracker instance.
 * TC3: interim webhook semantics — once a run holds the active-run pointer,
 *      a second claimActiveRun against the same project root is refused
 *      (returns false, does not throw).
 * TC4: dryRunValidate() bootstraps into a per-run scratch harness dir but
 *      never claims the active-run pointer; on success it self-cleans that
 *      scratch dir.
 * TC5: run() against a project root whose active-run pointer resolves to a
 *      completed-but-unarchived run refuses the second claim and routes
 *      through _checkOverwriteProtection, which throws (globalStatus ===
 *      'complete').
 *
 * No Claude auth, no SDK — every agent/gate seam that would otherwise spawn
 * a session is stubbed. Every fixture root is an isolated fs.mkdtemp()
 * directory.
 *
 * This suite is NOT a re-entrant cc-orch invocation, but when launched from
 * inside a live cc-orch run, CC_ORCH_ACTIVE_RUN would be inherited from the
 * parent environment and could trip assertNoReentrantLiveRun's guard against
 * a fixture root that legitimately carries an active/complete state.json.
 * Clear the marker unconditionally here, mirroring test-runid-flip.js and
 * scripts/run-tests.js, so this file is re-entrancy-neutral regardless of
 * launch context.
 *
 * Run: node test/test-pipeline-repoint.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import {
  harnessRoot,
  runHarnessDir,
  generateRunId,
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

function createRoot(prefix = 'pipeline-repoint-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeSpecFixture(root, filename, content) {
  const specPath = path.join(root, filename);
  fs.writeFileSync(specPath, content ?? `# ${filename}\n\nGoal.\n`, 'utf8');
  return specPath;
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

// Removes every process-level listener a Pipeline instance registered in
// its constructor, so constructing several Pipelines in one test-process
// run does not accumulate listeners across tests.
function teardownPipeline(pipeline) {
  if (!pipeline || !pipeline._signalHandlers) return;
  process.removeListener('SIGINT', pipeline._signalHandlers.SIGINT);
  process.removeListener('SIGTERM', pipeline._signalHandlers.SIGTERM);
  process.removeListener('exit', pipeline._signalHandlers.exit);
  process.removeListener('uncaughtException', pipeline._signalHandlers.uncaughtException);
}

/**
 * Build a Pipeline whose run() reaches the post-final-test-gate globalStatus
 * write without doing any real work (mirrors test-runid-flip.js's
 * makeRunnablePipeline). Deliberately does NOT stub _checkOverwriteProtection
 * — TC5 needs the REAL implementation to exercise the overwrite-protection
 * throw.
 */
function makeRunnablePipeline(projectRoot, extraOpts = {}) {
  const pipeline = new Pipeline(projectRoot, {
    onLog: () => {},
    onConfirm: async () => true,
    ...extraOpts,
  });
  pipeline._runPreflight = () => {};
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

/**
 * Build a Pipeline for dryRunValidate(): stubs planGlobal + the uncheckable-
 * spec gate + assumption remediation so no LLM calls are made; onConfirm
 * defaults to true (approve and queue).
 */
function makeDryRunPipeline(projectRoot, extraOpts = {}) {
  const pipeline = new Pipeline(projectRoot, {
    onLog: () => {},
    onConfirm: async () => true,
    ...extraOpts,
  });
  pipeline._runPreflight = () => {};
  pipeline._detectUncheckableSpec = () => {};
  pipeline.planner.planGlobal = async () => cannedGlobalPlan();
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._remediateAssumptions = async () => ({ passed: true });
  return pipeline;
}

// ---------- TC1: constructor harnessDir binding ----------

await test('TC1a: constructor harnessDir === flat harnessRoot when no active-run pointer exists', () => {
  const root = createRoot();
  let pipeline;
  try {
    pipeline = new Pipeline(root, { onLog: () => {} });
    assert.strictEqual(
      pipeline.harnessDir,
      harnessRoot(root),
      'with no active-run pointer, harnessDir must be the flat .harness fallback'
    );
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

await test('TC1b: constructor harnessDir === runHarnessDir when a valid pointer + state.json exist', () => {
  const root = createRoot();
  let pipeline;
  try {
    const runId = generateRunId('tc1b-project');
    const claimed = claimActiveRun(root, { runId, slug: 'tc1b-project', kind: 'run' });
    assert.ok(claimed, 'sanity: claimActiveRun should succeed for a fresh root');
    const runDir = runHarnessDir(root, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'state.json'),
      JSON.stringify({ globalStatus: 'active', milestones: {} }, null, 2),
      'utf8'
    );

    pipeline = new Pipeline(root, { onLog: () => {} });
    assert.strictEqual(
      pipeline.harnessDir,
      runDir,
      'with a valid pointer + state.json, harnessDir must resolve to the run harness dir'
    );
    assert.notStrictEqual(
      pipeline.harnessDir,
      harnessRoot(root),
      'the resolved run dir must differ from the flat fallback'
    );
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ---------- TC2: _repointHarness rebuild ----------

await test('TC2: _repointHarness rebuilds logger/tokenTracker/progress/scheduler and re-wires sessionManager', () => {
  const root = createRoot();
  let pipeline;
  try {
    pipeline = new Pipeline(root, { onLog: () => {} });

    const originalLogger = pipeline.logger;
    const originalTokenTracker = pipeline.tokenTracker;
    const originalProgress = pipeline.progress;
    const originalScheduler = pipeline.scheduler;

    const newDir = path.join(root, '.harness', 'run-tc2-repointed');
    pipeline._repointHarness(newDir);

    assert.strictEqual(pipeline.harnessDir, newDir, 'harnessDir must be updated to the new dir');

    // Every capture is rebuilt (fresh instance, not a mutation of the old one).
    assert.notStrictEqual(pipeline.logger, originalLogger, 'logger must be a new instance');
    assert.notStrictEqual(pipeline.tokenTracker, originalTokenTracker, 'tokenTracker must be a new instance');
    assert.notStrictEqual(pipeline.progress, originalProgress, 'progress must be a new instance');
    assert.notStrictEqual(pipeline.scheduler, originalScheduler, 'scheduler must be a new instance');

    // Each rebuilt capture targets the new dir.
    assert.strictEqual(pipeline.logger.logsDir, path.join(newDir, 'logs'), "logger's logsDir must be under the new harnessDir");
    assert.strictEqual(pipeline.tokenTracker.harnessDir, newDir, "tokenTracker's harnessDir must be the new dir");
    assert.strictEqual(pipeline.progress.harnessDir, newDir, "progress's harnessDir must be the new dir");
    assert.strictEqual(pipeline.scheduler.harnessDir, newDir, "scheduler's harnessDir must be the new dir");

    // sessionManager is re-wired to the NEW tokenTracker, not the old one.
    assert.strictEqual(
      pipeline.sessionManager._tokenTracker,
      pipeline.tokenTracker,
      'sessionManager._tokenTracker must equal the new tokenTracker'
    );
    assert.notStrictEqual(
      pipeline.sessionManager._tokenTracker,
      originalTokenTracker,
      'sessionManager._tokenTracker must no longer be the old tokenTracker'
    );
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ---------- TC3: second claimActiveRun on a held slot ----------

await test('TC3: a held active-run pointer makes a second claimActiveRun return false', () => {
  const root = createRoot();
  try {
    const runId = generateRunId('tc3-project');
    const firstClaim = claimActiveRun(root, { runId, slug: 'tc3-project', kind: 'run' });
    assert.strictEqual(firstClaim, true, 'the first claimActiveRun against a fresh root must succeed');

    // Interim webhook semantics: a second, fully independent in-process
    // claim attempt against the same still-held slot must be refused
    // (return false), not throw and not silently overwrite the pointer.
    const secondRunId = generateRunId('tc3-project-again');
    const secondClaim = claimActiveRun(root, { runId: secondRunId, slug: 'tc3-project-again', kind: 'run' });
    assert.strictEqual(secondClaim, false, 'a second claimActiveRun against a held slot must return false');

    // The pointer must still reflect the FIRST claim, unmodified by the refusal.
    const pointer = readActiveRunPointer(root);
    assert.ok(pointer, 'the pointer must still be present');
    assert.strictEqual(pointer.runId, runId, "the pointer's runId must remain the first claimant's");
  } finally {
    cleanup(root);
  }
});

// ---------- TC4: dryRunValidate scratch-dir lifecycle ----------

await test('TC4: dryRunValidate leaves readActiveRunPointer null and removes the scratch dir on success', async () => {
  const root = createRoot();
  let pipeline;
  try {
    const specPath = writeSpecFixture(root, 'spec-tc4.md', '# Spec TC4\n\nGoal TC4.\n');
    pipeline = makeDryRunPipeline(root);

    let capturedScratchDir = null;
    pipeline.planner.planGlobal = async () => {
      // Captured mid-flight, before the scratch harness dir is self-cleaned,
      // so we can assert both "it existed" and "it was removed afterward".
      capturedScratchDir = pipeline.harnessDir;
      assert.ok(fs.existsSync(capturedScratchDir), 'sanity: scratch dir must exist while dryRunValidate is mid-flight');
      return cannedGlobalPlan();
    };

    await pipeline.dryRunValidate('Goal for TC4', { prdPath: specPath });

    assert.ok(capturedScratchDir, 'sanity: planGlobal should have captured a scratch harness dir');
    assert.ok(
      !fs.existsSync(capturedScratchDir),
      `scratch dir ${capturedScratchDir} must be removed after a successful dryRunValidate`
    );
    assert.strictEqual(
      readActiveRunPointer(root),
      null,
      'dryRunValidate must never claim the active-run pointer, on success or otherwise'
    );
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ---------- TC5: run() claim-failure branch through _checkOverwriteProtection ----------

await test('TC5: run() with a completed-unarchived pointer throws via _checkOverwriteProtection', async () => {
  const root = createRoot();
  let pipeline;
  try {
    const runId = generateRunId('tc5-stale-project');
    const claimed = claimActiveRun(root, { runId, slug: 'tc5-stale-project', kind: 'run' });
    assert.ok(claimed, 'sanity: claimActiveRun should succeed for a fresh root');

    const runDir = runHarnessDir(root, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const state = {
      globalStatus: 'complete',
      milestones: { '001': { id: '001', description: 'Done', status: 'complete' } },
      projectMeta: { currentPhase: 'complete' },
    };
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

    pipeline = makeRunnablePipeline(root);
    let thrown = null;
    try {
      await pipeline.run('New goal against a completed-unarchived pointer');
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'run() must throw when the held active-run pointer resolves to a completed run');
    assert.ok(
      thrown.message.includes('already completed'),
      `expected '_checkOverwriteProtection' completed-run guidance, got: ${thrown.message}`
    );
    assert.ok(
      thrown.message.includes('archive the existing run'),
      `expected 'archive the existing run' guidance, got: ${thrown.message}`
    );

    // The pointer is untouched by the refused claim attempt — it still names
    // the original (completed, unarchived) run.
    const pointer = readActiveRunPointer(root);
    assert.ok(pointer, 'the pointer must still be present after the refused claim');
    assert.strictEqual(pointer.runId, runId, "the pointer's runId must remain the original run's");
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
