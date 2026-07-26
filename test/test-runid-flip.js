/**
 * test-runid-flip.js — E2E tests for the run-id-scoped harness "flip": five
 * scenarios proving that per-run harness isolation, concurrent dryRunValidate
 * scratch dirs, the active-run pointer lifecycle, archive's build-before-clear
 * ordering, and the stale-pointer overwrite-protection route all hold together
 * end-to-end (as opposed to any single unit in isolation).
 *
 * (a) isolation by construction — run(specA) driven to a completed-but-
 *     unarchived state, then dryRunValidate(specB) against the SAME project
 *     root: B resolves a disjoint per-run harness dir, and A's state.json +
 *     the queue are left untouched.
 * (b) concurrency — N (>=3) concurrent dryRunValidate calls against the same
 *     root produce N pairwise-disjoint scratch dirs (each self-cleaned on
 *     success) and N queue entries, each carrying its own spec's content.
 * (c) pointer lifecycle — the active-run pointer is claimed (non-null, with
 *     the run's runId) once run() starts; a concurrent claimActiveRun/run()
 *     against the same root is refused (false / silent return), NOT a
 *     ReentrantRunError; the pointer is still present after run() completes
 *     (run() never archives); and is cleared exactly when archive() runs.
 * (d) archive ordering — the summarizer data package built during archive()
 *     contains the run's verification/mission data, proving it is built
 *     while activeHarnessDir(projectRoot) still resolves the run dir, BEFORE
 *     clearActiveRunPointer() runs.
 * (e) stale-pointer-to-completed-run — run() against a root whose active-run
 *     pointer resolves to a run with globalStatus==='complete' throws the
 *     overwrite-protection guidance ('already completed' / 'archive the
 *     existing run'), NOT a ReentrantRunError.
 *
 * No Claude auth, no SDK — every agent/gate seam is stubbed. Every fixture
 * root is an isolated fs.mkdtemp() directory.
 *
 * This suite is NOT a re-entrant cc-orch invocation, but when launched from
 * inside a live cc-orch run (e.g. a spawned test-gate), CC_ORCH_ACTIVE_RUN
 * would be inherited from the parent environment and could trip
 * assertNoReentrantLiveRun's guard against a fixture root that legitimately
 * carries an active/complete state.json — a false positive on the sanctioned
 * mkdtemp pattern. Clear the marker unconditionally here, mirroring
 * scripts/run-tests.js and test-bootstrap-run-scoped.js, so this file is
 * re-entrancy-neutral regardless of launch context.
 *
 * Run: node test/test-runid-flip.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { archive } from '../src/cli/commands/archive.js';
import { readQueueEntry, writeQueueEntry } from '../src/orchestrator/core/state.js';
import {
  generateRunId,
  runHarnessDir,
  claimActiveRun,
  readActiveRunPointer,
} from '../src/orchestrator/core/run-context.js';
import { ReentrantRunError } from '../src/orchestrator/core/reentrancy-guard.js';

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

function createRoot(prefix = 'runid-flip-test-') {
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

function writeSpecFixture(root, filename, content) {
  const specPath = path.join(root, filename);
  fs.writeFileSync(specPath, content ?? `# ${filename}\n\nGoal.\n`, 'utf8');
  return specPath;
}

/**
 * Build a Pipeline whose run() reaches the post-final-test-gate globalStatus
 * write without doing any real work (mirrors test-run-complete-status.js's
 * makeRunnablePipeline). Deliberately does NOT stub _checkOverwriteProtection
 * — on a freshly-claimed root it is never invoked by run(), and scenario (e)
 * needs the REAL implementation to exercise the overwrite-protection throw.
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
  pipeline._detectUncheckableSpec = () => {};
  pipeline.planner.planGlobal = async () => cannedGlobalPlan();
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._remediateAssumptions = async () => ({ passed: true });
  return pipeline;
}

const mockSummarize = async () => ({ headline: 'Test archive', bugs: [], summary: 'Test summary.' });
const mockGetGitInfo = () => ({ gitHead: 'abc1234567890abcdef', gitStatus: 'clean' });

function listQueueSlugs(root) {
  const queueDir = path.join(root, 'queue');
  if (!fs.existsSync(queueDir)) return [];
  return fs.readdirSync(queueDir).filter((s) => {
    try { return fs.statSync(path.join(queueDir, s)).isDirectory(); } catch { return false; }
  });
}

// ---------- (a) isolation by construction ----------

await test("TC1 (a): dryRunValidate(specB) after run(specA)->completed-unarchived resolves a disjoint harness dir and leaves A's state.json + queue untouched", async () => {
  const root = createRoot();
  try {
    const pipelineA = makeRunnablePipeline(root);
    await pipelineA.run('Build spec A', { auto: true });

    const pointerA = readActiveRunPointer(root);
    assert.ok(pointerA && pointerA.runId, 'sanity: run(specA) should leave an active-run pointer with a runId');
    const harnessDirA = runHarnessDir(root, pointerA.runId);
    const stateFileA = path.join(harnessDirA, 'state.json');
    assert.ok(fs.existsSync(stateFileA), "sanity: spec A's per-run state.json should exist");
    const stateA = JSON.parse(fs.readFileSync(stateFileA, 'utf8'));
    assert.strictEqual(stateA.globalStatus, 'complete', 'sanity: spec A run should be completed-but-unarchived');
    const beforeBytes = fs.readFileSync(stateFileA);

    const specBPath = writeSpecFixture(root, 'spec-b.md', '# Spec B\n\nGoal B.\n');
    const pipelineB = makeDryRunPipeline(root);
    await pipelineB.dryRunValidate('Build spec B', { prdPath: specBPath });

    // B's harness dir must be disjoint from A's.
    assert.notStrictEqual(pipelineB.harnessDir, harnessDirA, "B's harness dir must differ from A's");

    // A's state.json must be byte-identical (untouched by B).
    const afterBytes = fs.readFileSync(stateFileA);
    assert.ok(beforeBytes.equals(afterBytes), "A's state.json must be untouched by B's dryRunValidate");

    // The queue must contain exactly B's entry — A was never queued/touched.
    const slugs = listQueueSlugs(root);
    assert.deepStrictEqual(slugs, ['spec-b'], "queue should contain exactly B's entry, not any entry for A");
    const entryB = readQueueEntry(root, 'spec-b');
    assert.ok(entryB, 'B queue entry should be readable');
    assert.strictEqual(entryB.status, 'pending', "B's queue entry status should be 'pending'");
  } finally {
    cleanup(root);
  }
});

// ---------- (b) concurrency ----------

await test('TC2 (b): N concurrent dryRunValidate calls produce N pairwise-disjoint scratch dirs (each self-cleaned) and N correct queue entries', async () => {
  const root = createRoot();
  try {
    const N = 3;
    const capturedDirs = [];
    const calls = [];

    for (let i = 0; i < N; i++) {
      const specPath = writeSpecFixture(root, `concurrent-spec-${i}.md`, `# Concurrent Spec ${i}\n\nGoal ${i}.\n`);
      const pipeline = makeDryRunPipeline(root);
      pipeline.planner.planGlobal = async () => {
        // Captured mid-flight, before the scratch harness dir is self-cleaned,
        // so we can assert both disjointness and self-clean-afterward.
        capturedDirs.push(pipeline.harnessDir);
        return cannedGlobalPlan();
      };
      calls.push({ pipeline, specPath, i });
    }

    await Promise.all(calls.map(({ pipeline, specPath, i }) =>
      pipeline.dryRunValidate(`Concurrent goal ${i}`, { prdPath: specPath })
    ));

    // N pairwise-disjoint scratch dirs were used.
    assert.strictEqual(capturedDirs.length, N, `expected ${N} captured harness dirs`);
    assert.strictEqual(new Set(capturedDirs).size, N, 'all captured harness dirs must be pairwise disjoint');

    // Each self-cleaned afterward (success path removes the scratch dir).
    for (const dir of capturedDirs) {
      assert.ok(!fs.existsSync(dir), `scratch dir ${dir} should be removed after successful dryRunValidate`);
    }

    // N queue entries, each carrying its own spec's content.
    const slugs = listQueueSlugs(root).sort();
    assert.strictEqual(slugs.length, N, `expected ${N} queue entries`);
    for (let i = 0; i < N; i++) {
      const expectedSlug = `concurrent-spec-${i}`;
      assert.ok(slugs.includes(expectedSlug), `expected queue entry '${expectedSlug}'`);
      const entry = readQueueEntry(root, expectedSlug);
      assert.ok(entry, `queue entry '${expectedSlug}' should be readable`);
      assert.ok(
        entry.spec.includes(`Concurrent Spec ${i}`),
        `queue entry '${expectedSlug}' should carry its own spec content, got: ${entry.spec}`
      );
    }
  } finally {
    cleanup(root);
  }
});

// ---------- (c) pointer lifecycle ----------

await test('TC3 (c): pointer claimed at run start; concurrent claim/run refused (not ReentrantRunError); pointer persists post-run; cleared exactly at archive', async () => {
  const root = createRoot();
  try {
    const pipelineA = makeRunnablePipeline(root);
    let pointerAtStart = null;
    let secondClaimResult = 'not-called';
    let secondRunResult = 'not-called';
    let secondRunThrew = null;

    pipelineA._executeAllMilestones = async () => {
      pointerAtStart = readActiveRunPointer(root);

      // A second claimActiveRun against the same root must be refused.
      secondClaimResult = claimActiveRun(root, { runId: 'concurrent-run-id', slug: 'concurrent', kind: 'run' });

      // A second, fully independent run() against the same (still-active)
      // root must be refused as a concurrent-run disposition (log + silent
      // return), NOT throw a ReentrantRunError (that guard is keyed off
      // CC_ORCH_ACTIVE_RUN, which this suite clears at module top, so any
      // throw here would have to come from a different code path).
      const pipelineB = makeRunnablePipeline(root);
      try {
        secondRunResult = await pipelineB.run('Concurrent goal');
      } catch (err) {
        secondRunThrew = err;
      }
    };

    await pipelineA.run('Build spec A', { auto: true });

    assert.ok(
      pointerAtStart && typeof pointerAtStart.runId === 'string' && pointerAtStart.runId.length > 0,
      'the pointer should be non-null with a runId once the run starts'
    );
    assert.strictEqual(secondClaimResult, false, 'a concurrent claimActiveRun against the same root must be refused (return false)');
    assert.strictEqual(secondRunThrew, null, `a concurrent run() must NOT throw, got: ${secondRunThrew && secondRunThrew.message}`);
    assert.ok(!(secondRunThrew instanceof ReentrantRunError), 'a concurrent run() refusal must NOT be classified as a ReentrantRunError');
    assert.strictEqual(secondRunResult, undefined, 'a concurrent run() refusal returns undefined (logged refusal), not a result object');

    // Pointer still present post-run, same runId (run() never archives/clears it).
    const pointerPostRun = readActiveRunPointer(root);
    assert.ok(pointerPostRun, 'pointer must still be present after run() completes (unarchived)');
    assert.strictEqual(pointerPostRun.runId, pointerAtStart.runId, 'pointer runId must be unchanged post-run');

    // Cleared exactly at archive.
    await archive(root, 'runid-flip-tc3', { auto: true }, {
      summarize: mockSummarize,
      getGitInfo: mockGetGitInfo,
      promptYesNo: async () => true,
    });
    assert.strictEqual(readActiveRunPointer(root), null, 'active-run pointer must be cleared exactly at archive');
  } finally {
    cleanup(root);
  }
});

// ---------- (d) archive ordering ----------

await test("TC4 (d): archive's summarizer data package contains the run's verification/mission data, built before the pointer clear", async () => {
  const root = createRoot();
  try {
    const runId = generateRunId('tc4-project');
    const claimed = claimActiveRun(root, { runId, slug: 'tc4-project', kind: 'run' });
    assert.ok(claimed, 'sanity: claimActiveRun should succeed for a fresh root');
    const runDir = runHarnessDir(root, runId);
    fs.mkdirSync(runDir, { recursive: true });

    const specRelPath = 'spec.md';
    fs.writeFileSync(path.join(root, specRelPath), '# TC4 Spec\n\nSample spec content.\n', 'utf8');

    const state = {
      spec: specRelPath,
      globalStatus: 'complete',
      milestones: {
        '001': {
          id: '001',
          description: 'First milestone',
          status: 'complete',
          missions: { '001-001': { id: '001-001', description: 'Test mission' } },
        },
      },
      projectMeta: { currentPhase: 'complete' },
    };
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

    fs.mkdirSync(path.join(runDir, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'state', 'mission-001-001.json'),
      JSON.stringify({
        subMissions: {
          '001-001-001': {
            tasks: { '001-001-001-001': { id: '001-001-001-001', description: 'Do the thing', status: 'complete' } },
          },
        },
      }),
      'utf8'
    );

    fs.mkdirSync(path.join(runDir, 'verification'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'verification', 'task-001-001-001-001.json'),
      JSON.stringify({ taskId: '001-001-001-001', verdict: 'pass', notes: 'looks correct' }),
      'utf8'
    );

    let capturedDataPackage = null;
    let pointerDuringSummarize = null;
    const captureSummarize = async (dataPackage) => {
      capturedDataPackage = dataPackage;
      pointerDuringSummarize = readActiveRunPointer(root);
      return mockSummarize();
    };

    await archive(root, 'tc4-archive', { auto: true }, {
      summarize: captureSummarize,
      getGitInfo: mockGetGitInfo,
      promptYesNo: async () => true,
    });

    assert.ok(capturedDataPackage, 'summarize should have been called with a data package');
    assert.ok(
      pointerDuringSummarize,
      'the active-run pointer must still be present while the data package is being built (before the clear)'
    );
    assert.strictEqual(pointerDuringSummarize.runId, runId, 'pointer during summarize must still resolve to this run');

    assert.strictEqual(
      capturedDataPackage.completedTasks.length,
      1,
      'data package should include the completed task from mission state'
    );
    assert.strictEqual(capturedDataPackage.completedTasks[0].id, '001-001-001-001');
    assert.ok(
      capturedDataPackage.verificationSidecars.includes('001-001-001-001'),
      'data package verificationSidecars should include the task verification sidecar'
    );
    assert.ok(
      capturedDataPackage.milestoneList.some((m) => m.id === '001'),
      'data package milestoneList should include the run milestone'
    );

    // Pointer is cleared only AFTER archive completes (built before the clear).
    assert.strictEqual(readActiveRunPointer(root), null, 'active-run pointer must be cleared after archive completes');
  } finally {
    cleanup(root);
  }
});

// ---------- (e) stale-pointer-to-completed-run ----------

await test('TC5 (e): run() against a stale pointer to a completed run throws overwrite-protection guidance, not ReentrantRunError', async () => {
  const root = createRoot();
  try {
    const runId = generateRunId('stale-project');
    const claimed = claimActiveRun(root, { runId, slug: 'stale-project', kind: 'run' });
    assert.ok(claimed, 'sanity: claimActiveRun should succeed for a fresh root');
    const runDir = runHarnessDir(root, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const state = {
      globalStatus: 'complete',
      milestones: { '001': { id: '001', description: 'Done', status: 'complete' } },
      projectMeta: { currentPhase: 'complete' },
    };
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

    const pipeline = makeRunnablePipeline(root);
    let thrown = null;
    try {
      await pipeline.run('New goal against stale pointer');
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'run() must throw when the active-run pointer resolves to a completed run');
    assert.ok(
      !(thrown instanceof ReentrantRunError),
      `the throw must NOT be a ReentrantRunError, got: ${thrown && thrown.constructor && thrown.constructor.name}`
    );
    assert.ok(thrown.message.includes('already completed'), `expected 'already completed' guidance, got: ${thrown.message}`);
    assert.ok(
      thrown.message.includes('archive the existing run'),
      `expected 'archive the existing run' guidance, got: ${thrown.message}`
    );
  } finally {
    cleanup(root);
  }
});

// ---------- (f) forensic-archive pointer preservation ----------

await test('TC6 (f): batchResume failed-execution disposition (forensic --include-failed archive) still leaves readActiveRunPointer(projectRoot) non-null, proving the pointer is preserved/re-claimed across the forensic archive', async () => {
  const root = createRoot();
  try {
    writeQueueEntry(root, 'flip-fail', {
      spec: '# Flip Fail Spec\n\nGoal.\n',
      plan: cannedGlobalPlan(),
      validatedAt: new Date().toISOString(),
      status: 'pending',
    });

    // Stub the forensic archive (this._archive) so the disposition reaches
    // completion without any real archive.js work; record calls so we can
    // assert the forensic (--include-failed) leg actually ran.
    const archiveCalls = [];
    const archiveStub = async (_projectRoot, slug, archiveOpts) => {
      archiveCalls.push({ slug, opts: archiveOpts });
      const dir = path.join(root, 'fake-archives', String(archiveCalls.length));
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };

    const pipeline = makeRunnablePipeline(root, { archive: archiveStub });
    // Drive the failed-execution disposition: _executeAllMilestones throws.
    pipeline._executeAllMilestones = async () => {
      throw new Error('milestone execution exploded');
    };

    const result = await pipeline.batchResume({});

    assert.strictEqual(result.failed, 1, `expected failed:1, got ${result.failed}`);
    assert.strictEqual(result.archived, 0, `expected archived:0, got ${result.archived}`);

    const forensic = archiveCalls.filter((c) => c.opts && c.opts['include-failed']);
    assert.strictEqual(forensic.length, 1, `expected exactly one forensic (--include-failed) archive call, got ${forensic.length}`);

    // The invariant under test: only successful completion clears the
    // active-run pointer slot. A failed-execution disposition performs the
    // forensic archive (which resets .harness/ and clears the pointer as a
    // side effect) but must re-claim it afterward, leaving a non-null
    // pointer for this entry.
    const pointerAfter = readActiveRunPointer(root);
    assert.ok(
      pointerAfter,
      'active-run pointer must be non-null after the failed-execution disposition completes (preserved/re-claimed across the forensic archive)'
    );
  } finally {
    cleanup(root);
  }
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
