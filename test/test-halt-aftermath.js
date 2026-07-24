#!/usr/bin/env node
/**
 * test-halt-aftermath.js — halt-aftermath-parity spec (holes 22/23/24):
 * the civilized-halt family for single-run resume/dry-run paths.
 *
 * Written by the FINAL atomic task with hard dependencies on every
 * implementation task (pipeline.js's _persistHaltAftermath + queue-linked
 * leg, park.js's singlePath pointer-clear, dry-run.js's structured-result
 * branching). Every case drives the REAL helper / REAL breaker sites / REAL
 * CLI modules against fs.mkdtemp fixtures — reviewer/analyzer LLM sessions
 * are stubbed; NO test case spawns a real agent session.
 *
 * Coverage (numbered after the spec's acceptance criteria):
 *   TC1 (a)  — a reviewer-gate human breaker site persists globalStatus
 *              'paused' + projectMeta.haltRecord {kind, site, eventId,
 *              runId, at} on a queue-linked, pointer-claimed single run.
 *   TC2 (b)  — HOLE-22 discriminator: the single-run scene carries
 *              singlePath:true; a batch-mode _parkEntry scene does not.
 *   TC3 (c)  — resumability pin: preflight() on the post-halt harness still
 *              passes (globalStatus 'paused' is legal; preflight.js
 *              untouched).
 *   TC4 (d)  — a non-queue-linked prdPath, and a queue-form prdPath whose
 *              entry dir is gone, both persist paused+haltRecord but skip
 *              queue/park writes (no zombie mkdir).
 *   TC5 (e)  — BATCH NO-OP: _activeEntryRunId !== null makes the helper a
 *              pure no-op (byte-identical state.json); the pre-existing
 *              _parkEntry/previousResolutions accumulation contract keeps
 *              working underneath it.
 *   TC6 (f)  — task-level sites (escalation + repeat-verdict) fire the
 *              helper too, then rethrow the original CircuitBreakerError
 *              byte-identical.
 *   TC7 (g)  — singlePath resolve: requeue/waive/reject clear the MATCHING
 *              active-run pointer, leave a non-matching pointer alone;
 *              reject still writes its resolution into park.json.
 *   TC8 (h)  — HOLE-23 (residual park.json cleanup on a fresh dry-run entry)
 *              and HOLE-24 (all three queued:false legs + the queued:true
 *              success leg, and dry-run.js's CLI branching on each).
 *   TC9 (i)  — helper fail-soft: a poisoned queue entry dir makes the
 *              queue-linked write throw internally, but the failure is
 *              swallowed (logged) and the original breaker error still
 *              propagates byte-identical.
 *   TC10     — scripts/run-tests.js registers this file in TEST_FILES.
 *
 * Run: node test/test-halt-aftermath.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { CircuitBreakerError } from '../src/orchestrator/core/circuit-breaker-error.js';
import { Analyzer } from '../src/orchestrator/agents/analyzer.js';
import {
  writeQueueEntry,
  readParkScene,
  writeParkScene,
} from '../src/orchestrator/core/state.js';
import {
  generateRunId,
  runHarnessDir,
  claimActiveRun,
  readActiveRunPointer,
} from '../src/orchestrator/core/run-context.js';
import { preflight } from '../src/orchestrator/core/preflight.js';
import { parkResolve } from '../src/cli/commands/park.js';
import { dryRun } from '../src/cli/commands/dry-run.js';
import { seedPassedSidecars } from './helpers/seed-passed-sidecars.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// ── Shared fixture helpers ──────────────────────────────────────────────────

function makeTmpRoot(prefix = 'cc-halt-aftermath-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function readGlobalState(harnessDir) {
  return JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
}

function readSceneRaw(root, slug) {
  const p = path.join(root, 'queue', slug, 'park.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readStatus(root, slug) {
  return fs.readFileSync(path.join(root, 'queue', slug, 'status'), 'utf8').trim();
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// ── Reviewer-gate breaker harness (test-pipeline-reviewer-gate.js ~:272-310) ─

function createReviewerGateHarness(projectRoot, harnessDir, { prdPath = '' } = {}) {
  const milestoneId = '001';
  const missionId = '001-001';
  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  const taskId = `${missionId}-001-001`;
  const subMissionId = `${missionId}-001`;

  fs.writeFileSync(
    path.join(harnessDir, 'progress', `task-${taskId}.json`),
    JSON.stringify({ taskId, status: 'COMPLETE', affectedFiles: [{ path: 'src/foo.js' }], summary: 's', testsSummary: 't' })
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-${taskId}.json`),
    JSON.stringify({ taskId, verified: true, report: 'r', result: 'PASSED', hardChecks: [], taskScopeChecks: [], notes: null })
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: ['src/foo.js'], hardChecks: [], testCases: [] })
  );

  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'foo.js'), '// src/foo.js\n');

  const missionState = {
    id: missionId, missionId, description: 'mission', status: 'complete',
    subMissions: {
      [subMissionId]: {
        id: subMissionId, description: 'sub-mission', status: 'complete',
        tasks: {
          [taskId]: {
            id: taskId, description: 'task', status: 'complete',
            createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
            targetFiles: ['src/foo.js'], dependencies: [], testCases: [], tracesScenario: [], patternReferences: [], dataSchemas: [],
            verifyFile: `.harness/verify/task-${taskId}.json`,
            progressFile: `.harness/progress/task-${taskId}.json`,
            verificationFile: `.harness/verification/task-${taskId}.json`,
            retryCount: 0,
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), JSON.stringify(missionState, null, 2));
  seedPassedSidecars(harnessDir, missionState);

  const globalState = {
    projectMeta: { prdPath, createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId, description: 'milestone', status: 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: { [missionId]: { id: missionId, description: 'mission', status: 'complete', stateFile: `.harness/state/mission-${missionId}.json`, planFile: `.harness/plan/mission-${missionId}.md` } },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  return { milestoneId, missionId, taskId };
}

function installReviewerMocks(pipeline, { reviewerResult, analyzerRecommendation = 'human' }) {
  const trace = { analyzeFailureCalls: 0 };
  pipeline.executor = { executeTask: async (task) => ({ status: 'COMPLETE', affectedFiles: task.targetFiles || [] }) };
  pipeline.verifier = {
    verifyRegression: async () => ({ verified: true, report: 'mock', structured: { verified: true } }),
  };
  pipeline.analyzer = {
    analyzeFailure: async () => {
      trace.analyzeFailureCalls++;
      return { eventId: 'mock-event-001', recommendation: analyzerRecommendation, affectedTasks: [] };
    },
  };
  pipeline.reviewer = { reviewMilestone: async () => reviewerResult };
  pipeline._collectMilestoneContext = () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' });
  pipeline._executeMilestoneParallel = async () => {};
  return trace;
}

// ── Task-level breaker harness (test-analyzer-closure.js ~:361-451 pattern) ──

function createTaskHarness(projectRoot, { prdPath = '' } = {}) {
  const harnessDir = path.join(projectRoot, '.harness');
  // Includes SHARED_SUBDIRS (learning/, dry-run/, brainstorm/) alongside the
  // per-run subdirs: TC3(c) drives the REAL preflight() against this flat
  // harness layout (config.projectRoot === projectRoot, so preflight checks
  // SHARED_SUBDIRS under harnessRoot(projectRoot), which here IS harnessDir).
  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis', 'learning', 'dry-run', 'brainstorm']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  const missionId = '001-001';
  const subMissionId = `${missionId}-001`;
  const taskId = `${missionId}-001-001`;
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify({
      id: missionId, missionId, description: 'fixture mission', status: 'in_progress',
      subMissions: {
        [subMissionId]: {
          id: subMissionId, status: 'in_progress',
          tasks: { [taskId]: { id: taskId, description: 'fixture task', status: 'in_progress', retryCount: 0, targetFiles: ['src/foo.js'], dependencies: [] } },
        },
      },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath, createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones: {
        '001': {
          id: '001', description: 'fixture milestone', status: 'in_progress',
          missions: { [missionId]: { id: missionId, description: 'fixture mission', status: 'in_progress', stateFile: `.harness/state/mission-${missionId}.json` } },
        },
      },
    }, null, 2)
  );
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'foo.js'), '// foo\n');
  return { harnessDir, taskId, missionId };
}

function verdict({ recommendation = 'human', rootCause = 'fixture root cause', failureType = 'verification', affectedTaskIds = [], evidence = 'fixture evidence', notes = '' } = {}) {
  return {
    recommendation, rootCause, failureType,
    affectedTasks: affectedTaskIds.map((taskId) => ({ taskId, reason: 'shares files', action: 'needs_revalidation' })),
    evidence, notes,
  };
}

function makeAnalyzerHarness(verdictForCall) {
  const sessionManager = {
    spawn() {
      const structured = verdictForCall();
      const handle = { systemPromptTokens: 0, _toolCallCount: 0 };
      const p = Promise.resolve({ handle, result: { structured_output: structured } });
      p.handle = handle;
      return p;
    },
  };
  const logger = {
    createSessionLog: () => ({ logPath: path.join(os.tmpdir(), 'halt-aftermath-fake.log'), close() {} }),
    attachToSession() {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
    warn() {},
  };
  return new Analyzer(sessionManager, logger, null);
}

function makeDispatchPipeline(projectRoot, verdictForCall) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    statusBar: false,
    skipWorktreeCreation: true,
  });
  pipeline.analyzer = makeAnalyzerHarness(verdictForCall);
  pipeline.planner.replanTask = async () => ({ replacementTasks: [] });
  pipeline.planner.closeReusableSession = async () => {};
  return { pipeline, logs };
}

const taskFixture = (id = '001-001-001-001') => ({ id, missionId: '001-001', description: 'fixture task', targetFiles: ['src/foo.js'] });

async function dispatchCatch(pipeline, task, failureType = 'verification', retryCount = 3) {
  try {
    await pipeline._dispatchAnalyzer(task, failureType, retryCount);
    return null;
  } catch (err) {
    return err;
  }
}

// ═════════════════════════════════════════════════════════════════════════
// TC1 (a) + TC2 (b) HOLE-22 discriminator
// ═════════════════════════════════════════════════════════════════════════

await test('TC1(a)/TC2(b): reviewer-gate human breaker on a queue-linked, pointer-claimed single run persists paused+haltRecord and a singlePath:true park scene', async () => {
  const root = makeTmpRoot();
  try {
    const slug = 'halt-rg';
    writeQueueEntry(root, slug, {
      spec: '# Spec\n\nGoal.',
      plan: { milestones: [], assumptions: [] },
      validatedAt: new Date().toISOString(),
      status: 'pending',
    });
    const prdPath = path.join(root, 'queue', slug, 'spec.md');

    const runId = generateRunId(slug);
    const claimed = claimActiveRun(root, { runId, slug, kind: 'run' });
    assert.ok(claimed, 'sanity: claimActiveRun should succeed on a fresh root');
    const harnessDir = runHarnessDir(root, runId);

    const { milestoneId } = createReviewerGateHarness(root, harnessDir, { prdPath });

    const logs = [];
    const pipeline = new Pipeline(root, { onLog: (m) => logs.push(m), onConfirm: async () => true, statusBar: false });
    assert.strictEqual(pipeline.harnessDir, harnessDir, 'sanity: pipeline must resolve the pointer-claimed per-run harness dir');

    const reviewerResult = {
      passed: false,
      findings: [{ severity: 'critical', category: 'call-chain', file: 'src/foo.js', description: 'needs human', relatedFiles: [] }],
      structured: { result: 'FAILED', findings: [], notes: '' },
      reportPath: '',
    };
    installReviewerMocks(pipeline, { reviewerResult, analyzerRecommendation: 'human' });

    const globalState = readGlobalState(harnessDir);
    const msState = globalState.milestones[milestoneId];

    let thrown = null;
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'the reviewer-gate human recommendation must still throw');

    // (a) persisted paused + haltRecord.
    const stateAfter = readGlobalState(harnessDir);
    assert.strictEqual(stateAfter.globalStatus, 'paused', "globalStatus must be 'paused' after the helper runs");
    const rec = stateAfter.projectMeta && stateAfter.projectMeta.haltRecord;
    assert.ok(rec, 'projectMeta.haltRecord must be populated');
    assert.strictEqual(rec.kind, 'reviewer-gate');
    assert.strictEqual(rec.site, 'reviewer-gate-human');
    assert.strictEqual(rec.eventId, 'mock-event-001');
    assert.strictEqual(rec.runId, runId, 'haltRecord.runId must come from the active-run pointer');
    assert.ok(rec.at && !Number.isNaN(new Date(rec.at).getTime()), 'haltRecord.at must be a parseable timestamp');

    // Queue-linked leg: scene + status.
    assert.strictEqual(readStatus(root, slug), 'halted-analyzer');
    const scene = readSceneRaw(root, slug);
    assert.ok(scene, 'queue-linked leg must write a park scene');
    assert.strictEqual(scene.site, 'reviewer-gate-human');
    assert.strictEqual(scene.runId, runId);
    assert.strictEqual(scene.stashRef, null);
    assert.deepStrictEqual(scene.previousResolutions, []);
    assert.strictEqual(scene.resolution, null);

    // (b) HOLE-22 discriminator: singlePath:true on the single-run scene.
    assert.strictEqual(scene.singlePath, true, 'a single-run halt scene must carry singlePath:true');

    // Tree WIP / pointer untouched.
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'foo.js'), 'utf8'), '// src/foo.js\n');
    const pointer = readActiveRunPointer(root);
    assert.ok(pointer, 'the active-run pointer must still be present (untouched by the helper)');
    assert.strictEqual(pointer.runId, runId);
  } finally {
    cleanup(root);
  }
});

await test('TC2(b) HOLE-22 discriminator: a batch-mode _parkEntry scene does NOT carry singlePath:true', async () => {
  const root = makeTmpRoot();
  try {
    const slug = 'halt-batch-scene';
    writeQueueEntry(root, slug, { spec: '# S', plan: { milestones: [], assumptions: [] }, validatedAt: new Date().toISOString(), status: 'pending' });

    const pipeline = new Pipeline(root, { onLog: () => {}, onConfirm: async () => true, statusBar: false });
    pipeline._activeEntryRunId = 'batch-run-x';

    pipeline._parkEntry({ slug }, { site: 'analyzer-human', parkedAt: new Date().toISOString(), questions: ['Q'] }, { status: 'halted-analyzer' });

    const scene = readSceneRaw(root, slug);
    assert.ok(scene, '_parkEntry must write a scene');
    assert.notStrictEqual(scene.singlePath, true, 'a batch park scene must NOT carry singlePath:true');
    assert.strictEqual(scene.runId, 'batch-run-x');
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC3 (c) — resumability pin
// ═════════════════════════════════════════════════════════════════════════

await test('TC3(c): preflight() on the post-halt harness passes unchanged (globalStatus paused is legal)', async () => {
  const root = makeTmpRoot();
  try {
    const { harnessDir } = createTaskHarness(root, { prdPath: '' });
    const pipeline = new Pipeline(root, { onLog: () => {}, onConfirm: async () => true, statusBar: false, skipWorktreeCreation: true });
    pipeline._persistHaltAftermath({ kind: 'x', site: 'y', eventId: null });

    const stateAfter = readGlobalState(harnessDir);
    assert.strictEqual(stateAfter.globalStatus, 'paused');

    const result = preflight(harnessDir, { projectRoot: root });
    assert.strictEqual(result.ok, true, `preflight must pass on a paused halt harness (errors: ${JSON.stringify(result.errors)})`);

    // pipeline._runPreflight() must not throw either (resume()'s own gate).
    assert.doesNotThrow(() => pipeline._runPreflight(), 'resume-path _runPreflight() must not throw after the halt');
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC4 (d) — non-queue prdPath and gone-entry skip
// ═════════════════════════════════════════════════════════════════════════

await test('TC4(d): a non-queue-linked prdPath persists paused+haltRecord but never creates a queue/ dir', async () => {
  const root = makeTmpRoot();
  try {
    const { harnessDir } = createTaskHarness(root, { prdPath: path.join(root, 'somewhere-else', 'spec.md') });
    const pipeline = new Pipeline(root, { onLog: () => {}, onConfirm: async () => true, statusBar: false, skipWorktreeCreation: true });
    pipeline._persistHaltAftermath({ kind: 'k', site: 's', eventId: null });

    const stateAfter = readGlobalState(harnessDir);
    assert.strictEqual(stateAfter.globalStatus, 'paused');
    assert.ok(stateAfter.projectMeta.haltRecord, 'haltRecord must still be populated on the non-queue leg');
    assert.strictEqual(fs.existsSync(path.join(root, 'queue')), false, 'a non-queue-linked prdPath must never create a queue/ directory');
  } finally {
    cleanup(root);
  }
});

await test('TC4(d): a queue-form prdPath whose entry dir is gone persists paused+haltRecord but skips the zombie mkdir', async () => {
  const root = makeTmpRoot();
  try {
    const ghostSlug = 'ghost-entry';
    const { harnessDir } = createTaskHarness(root, { prdPath: path.join(root, 'queue', ghostSlug, 'spec.md') });
    const pipeline = new Pipeline(root, { onLog: () => {}, onConfirm: async () => true, statusBar: false, skipWorktreeCreation: true });
    pipeline._persistHaltAftermath({ kind: 'k', site: 's', eventId: null });

    const stateAfter = readGlobalState(harnessDir);
    assert.strictEqual(stateAfter.globalStatus, 'paused');
    assert.ok(stateAfter.projectMeta.haltRecord, 'haltRecord must still be populated when the entry is gone');
    assert.strictEqual(fs.existsSync(path.join(root, 'queue', ghostSlug)), false, 'a gone queue entry must never be mkdir-ed as a zombie');
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC5 (e) — BATCH NO-OP
// ═════════════════════════════════════════════════════════════════════════

await test('TC5(e): _activeEntryRunId !== null makes _persistHaltAftermath a byte-identical no-op on state.json', async () => {
  const root = makeTmpRoot();
  try {
    const slug = 'halt-batch-noop';
    writeQueueEntry(root, slug, { spec: '# S', plan: { milestones: [], assumptions: [] }, validatedAt: new Date().toISOString(), status: 'pending' });
    const { harnessDir } = createTaskHarness(root, { prdPath: path.join(root, 'queue', slug, 'spec.md') });

    const before = fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8');

    const pipeline = new Pipeline(root, { onLog: () => {}, onConfirm: async () => true, statusBar: false, skipWorktreeCreation: true });
    pipeline._activeEntryRunId = 'batch-run-owns-this';
    pipeline._persistHaltAftermath({ kind: 'k', site: 's', eventId: 'e1' });

    const after = fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8');
    assert.strictEqual(after, before, 'state.json must be byte-identical when _activeEntryRunId is set (no-op guard)');
    assert.strictEqual(fs.existsSync(path.join(root, 'queue', slug, 'park.json')), false, 'the no-op must never write a park scene');
  } finally {
    cleanup(root);
  }
});

await test('TC5(e): the pre-existing _parkEntry/previousResolutions accumulation contract stays intact while _activeEntryRunId is set', async () => {
  const root = makeTmpRoot();
  try {
    const slug = 'halt-batch-accum';
    writeQueueEntry(root, slug, { spec: '# S', plan: { milestones: [], assumptions: [] }, validatedAt: new Date().toISOString(), status: 'pending' });

    const pipeline = new Pipeline(root, { onLog: () => {}, onConfirm: async () => true, statusBar: false, skipWorktreeCreation: true });
    pipeline._activeEntryRunId = 'batch-run-1';

    pipeline._parkEntry({ slug }, { site: 'analyzer-human', parkedAt: new Date().toISOString(), questions: ['Q1'] }, { status: 'halted-analyzer', runId: 'run-1' });
    let scene = readSceneRaw(root, slug);
    assert.deepStrictEqual(scene.previousResolutions, [], 'a fresh park must start with no previousResolutions');
    assert.strictEqual(scene.resolution, null);

    // Simulate a resolution having been recorded on this scene (mirrors
    // park.js's parkResolve write), then park it again — the resolved
    // scene must be carried forward into previousResolutions.
    scene.resolution = { action: 'waive', at: new Date().toISOString(), note: null, consumedAt: null };
    writeParkScene(root, slug, scene);

    pipeline._parkEntry({ slug }, { site: 'analyzer-human', parkedAt: new Date().toISOString(), questions: ['Q2'] }, { status: 'halted-analyzer', runId: 'run-2' });
    scene = readSceneRaw(root, slug);
    assert.strictEqual(scene.previousResolutions.length, 1, 'the prior resolution must accumulate into previousResolutions');
    assert.strictEqual(scene.previousResolutions[0].action, 'waive');
    assert.strictEqual(scene.resolution, null, 'the fresh scene is unresolved again');
    assert.strictEqual(scene.runId, 'run-2');
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC6 (f) — task-level breaker coverage (~4851 escalatedByRepeat, ~4910)
// ═════════════════════════════════════════════════════════════════════════

await test('TC6(f): task-analyzer-escalation and task-analyzer-repeat-verdict sites both persist aftermath then rethrow byte-identical', async () => {
  const root = makeTmpRoot();
  try {
    const { harnessDir } = createTaskHarness(root, { prdPath: '' });
    const { pipeline } = makeDispatchPipeline(root, () => verdict({ recommendation: 'human', affectedTaskIds: [] }));
    const TASK = taskFixture();

    // Round 1 — first analysis: task-analyzer-escalation site.
    const err1 = await dispatchCatch(pipeline, TASK);
    assert.ok(err1, 'round 1 human verdict must throw');
    assert.ok(err1 instanceof CircuitBreakerError);
    const expected1 = `Circuit breaker: task ${TASK.id} failed verification after 4 attempts. ` +
      `Recommendation: human. 0 task(s) marked for revalidation. See .harness/analysis/${err1.eventId}.json`;
    assert.strictEqual(err1.message, expected1, 'the escalation throw must be byte-identical to its pre-helper template');

    let stateAfter = readGlobalState(harnessDir);
    assert.strictEqual(stateAfter.globalStatus, 'paused');
    assert.strictEqual(stateAfter.projectMeta.haltRecord.kind, 'task-analyzer');
    assert.strictEqual(stateAfter.projectMeta.haltRecord.site, 'task-analyzer-escalation');
    assert.strictEqual(stateAfter.projectMeta.haltRecord.eventId, err1.eventId);

    await tick();

    // Round 2 — identical verdict: task-analyzer-repeat-verdict site.
    const err2 = await dispatchCatch(pipeline, TASK);
    assert.ok(err2, 'round 2 identical verdict must throw');
    assert.strictEqual(err2.escalatedByRepeat, true);
    const expected2 = `Circuit breaker: task ${TASK.id} failed verification after 4 attempts. ` +
      `Analyzer repeated its previous verdict (rec=human) — escalated to human. See .harness/analysis/${err2.eventId}.json`;
    assert.strictEqual(err2.message, expected2, 'the repeat-escalation throw must be byte-identical to its pre-helper template');

    stateAfter = readGlobalState(harnessDir);
    assert.strictEqual(stateAfter.globalStatus, 'paused');
    assert.strictEqual(stateAfter.projectMeta.haltRecord.kind, 'task-analyzer-repeat');
    assert.strictEqual(stateAfter.projectMeta.haltRecord.site, 'task-analyzer-repeat-verdict');
    assert.strictEqual(stateAfter.projectMeta.haltRecord.eventId, err2.eventId);
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC7 (g) — singlePath resolve
// ═════════════════════════════════════════════════════════════════════════

function makeParkScene(overrides = {}) {
  return {
    site: 'analyzer-human', parkedAt: new Date().toISOString(),
    round1: [], round2: null, appliedSpecEdits: [], questions: ['Q'],
    previousResolutions: [], resolution: null,
    runId: null, singlePath: true, stashRef: null,
    ...overrides,
  };
}

await test('TC7(g): resolve --reject on a singlePath scene clears the MATCHING active-run pointer and writes its resolution', async () => {
  const root = makeTmpRoot();
  try {
    const slug = 'sp-reject';
    writeQueueEntry(root, slug, { spec: '# S', plan: { milestones: [], assumptions: [] }, validatedAt: new Date().toISOString(), status: 'halted-analyzer' });
    const runId = generateRunId(slug);
    writeParkScene(root, slug, makeParkScene({ runId }));
    assert.ok(claimActiveRun(root, { runId, slug, kind: 'run' }));

    parkResolve(root, slug, { reject: true, note: 'no thanks' });

    assert.strictEqual(readActiveRunPointer(root), null, 'the matching pointer must be cleared on reject');
    assert.strictEqual(readStatus(root, slug), 'rejected');
    const scene = readSceneRaw(root, slug);
    assert.ok(scene.resolution, 'reject must still write its resolution into park.json');
    assert.strictEqual(scene.resolution.action, 'reject');
    assert.strictEqual(scene.resolution.note, 'no thanks');
  } finally {
    cleanup(root);
  }
});

await test('TC7(g): resolve --requeue on a singlePath scene clears the MATCHING active-run pointer', async () => {
  const root = makeTmpRoot();
  try {
    const slug = 'sp-requeue';
    writeQueueEntry(root, slug, { spec: '# S', plan: { milestones: [], assumptions: [] }, validatedAt: new Date().toISOString(), status: 'parked' });
    const runId = generateRunId(slug);
    writeParkScene(root, slug, makeParkScene({ runId }));
    assert.ok(claimActiveRun(root, { runId, slug, kind: 'run' }));

    parkResolve(root, slug, { requeue: true });

    assert.strictEqual(readActiveRunPointer(root), null, 'the matching pointer must be cleared on requeue');
    assert.strictEqual(readStatus(root, slug), 'pending');
  } finally {
    cleanup(root);
  }
});

await test('TC7(g): resolve --waive on a singlePath scene leaves a NON-matching active-run pointer alone', async () => {
  const root = makeTmpRoot();
  try {
    const slug = 'sp-waive-mismatch';
    writeQueueEntry(root, slug, { spec: '# S', plan: { milestones: [], assumptions: [] }, validatedAt: new Date().toISOString(), status: 'parked' });
    const sceneRunId = generateRunId(slug);
    writeParkScene(root, slug, makeParkScene({ runId: sceneRunId }));

    const otherSlug = 'sp-someone-else';
    const otherRunId = generateRunId(otherSlug);
    assert.ok(claimActiveRun(root, { runId: otherRunId, slug: otherSlug, kind: 'run' }));

    parkResolve(root, slug, { waive: true });

    const pointer = readActiveRunPointer(root);
    assert.ok(pointer, 'a non-matching pointer must survive the resolve');
    assert.strictEqual(pointer.runId, otherRunId, 'the foreign pointer must be left completely alone');
    assert.strictEqual(readStatus(root, slug), 'pending');
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC8 (h) — HOLE-23 / HOLE-24
// ═════════════════════════════════════════════════════════════════════════

const REQ_SPEC_MD = `# Test Spec

## Goals
Build something.

## Requirements
This requires ORIGINAL-CLAUSE to hold.
`;

function makeDryRunPipeline(root, { onConfirm = async () => true, plan } = {}) {
  const logs = [];
  const pipeline = new Pipeline(root, { onLog: (m) => logs.push(m), onConfirm, statusBar: false });
  pipeline._detectUncheckableSpec = () => {};
  pipeline.planner.planGlobal = async () => plan;
  pipeline.planner.closeReusableSession = async () => {};
  return { pipeline, logs };
}

await test('TC8(h) HOLE-24: assumption-escalation leg returns queued:false with the pinned reason', async () => {
  const root = makeTmpRoot();
  try {
    const specPath = path.join(root, 'spec.md');
    fs.writeFileSync(specPath, REQ_SPEC_MD);
    const plan = { milestones: [], assumptions: [{ text: 'A1', phase: 'invariant', specSection: 'Requirements' }] };
    const { pipeline } = makeDryRunPipeline(root, { plan });
    pipeline.planner.verifyAssumptions = async () => [{ assumption: plan.assumptions[0], status: 'failed', evidence: 'e' }];
    pipeline.planner.remediateAssumption = async () => ({
      specEdit: { old: 'ORIGINAL-CLAUSE', new: 'FIXED-CLAUSE', section: 'Requirements' },
      revisedAssumptions: [{ text: 'A1-revised', phase: 'invariant', specSection: 'Requirements' }],
    });
    pipeline.planner.reExtractAssumptions = async () => [{ text: 'A1-revised', phase: 'invariant', specSection: 'Requirements' }];

    const result = await pipeline.dryRunValidate('goal', { prdPath: specPath, auto: true });
    assert.strictEqual(result.queued, false);
    assert.strictEqual(result.reason, 'assumption escalation: assumptions still failed after spec remediation');
  } finally {
    cleanup(root);
  }
});

await test('TC8(h) HOLE-24: declined proceed-anyway leg returns queued:false with the pinned reason', async () => {
  const root = makeTmpRoot();
  try {
    const specPath = path.join(root, 'spec.md');
    fs.writeFileSync(specPath, REQ_SPEC_MD);
    const plan = { milestones: [], assumptions: [{ text: 'A2', phase: 'invariant', specSection: null }] };
    const { pipeline } = makeDryRunPipeline(root, { plan, onConfirm: async () => false });
    pipeline.planner.verifyAssumptions = async () => [{ assumption: plan.assumptions[0], status: 'failed', evidence: 'e' }];

    const result = await pipeline.dryRunValidate('goal', { prdPath: specPath, auto: false });
    assert.strictEqual(result.queued, false);
    assert.strictEqual(result.reason, 'declined proceed-anyway: user chose not to proceed with failed assumptions');
  } finally {
    cleanup(root);
  }
});

await test('TC8(h) HOLE-24: plan-rejected leg returns queued:false with the pinned reason', async () => {
  const root = makeTmpRoot();
  try {
    const specPath = path.join(root, 'spec.md');
    fs.writeFileSync(specPath, REQ_SPEC_MD);
    const plan = { milestones: [{ id: '001', description: 'M', missions: [{ id: '001-001', description: 'Mi' }] }], assumptions: [] };
    const { pipeline } = makeDryRunPipeline(root, { plan, onConfirm: async () => false });

    const result = await pipeline.dryRunValidate('goal', { prdPath: specPath, auto: false });
    assert.strictEqual(result.queued, false);
    assert.strictEqual(result.reason, 'plan rejected by user');
  } finally {
    cleanup(root);
  }
});

await test('TC8(h) HOLE-24: the success leg returns queued:true and writes the queue entry', async () => {
  const root = makeTmpRoot();
  try {
    const specPath = path.join(root, 'spec.md');
    fs.writeFileSync(specPath, REQ_SPEC_MD);
    const plan = { milestones: [{ id: '001', description: 'M', missions: [{ id: '001-001', description: 'Mi' }] }], assumptions: [] };
    const { pipeline } = makeDryRunPipeline(root, { plan, onConfirm: async () => true });

    const result = await pipeline.dryRunValidate('goal', { prdPath: specPath, auto: false });
    assert.deepStrictEqual(result, { queued: true });
    assert.ok(fs.existsSync(path.join(root, 'queue', 'spec', 'spec.md')), 'the success leg must write the queue entry');
  } finally {
    cleanup(root);
  }
});

await test('TC8(h) HOLE-23: a fresh dry-run entry at a slug with a residual park.json ends park.json-free', async () => {
  const root = makeTmpRoot();
  try {
    const slug = 'residual-park';
    const specPath = path.join(root, `${slug}.md`);
    fs.writeFileSync(specPath, '# Test Spec\n\nGoal text.\n');
    fs.mkdirSync(path.join(root, 'queue', slug), { recursive: true });
    fs.writeFileSync(path.join(root, 'queue', slug, 'park.json'), JSON.stringify({ site: 'analyzer-human', parkedAt: '2020-01-01T00:00:00.000Z', questions: ['STALE'] }));

    const plan = { milestones: [{ id: '001', description: 'M', missions: [{ id: '001-001', description: 'Mi' }] }], assumptions: [] };
    const { pipeline } = makeDryRunPipeline(root, { plan, onConfirm: async () => true });

    const result = await pipeline.dryRunValidate('goal', { prdPath: specPath, auto: false });
    assert.strictEqual(result.queued, true);
    assert.strictEqual(fs.existsSync(path.join(root, 'queue', slug, 'park.json')), false, 'the recreated entry must be park.json-free');
  } finally {
    cleanup(root);
  }
});

await test('TC8(h) HOLE-24: dry-run.js CLI exits non-zero naming the reason on a queued:false result', async () => {
  const root = makeTmpRoot();
  const specPath = path.join(root, 'spec.md');
  fs.writeFileSync(specPath, '# Test Spec\n');
  const origDryRunValidate = Pipeline.prototype.dryRunValidate;
  const origExit = process.exit;
  const origError = console.error;
  const origLog = console.log;
  const errLines = [];
  const outLines = [];
  try {
    Pipeline.prototype.dryRunValidate = async function () {
      return { queued: false, reason: 'plan rejected by user' };
    };
    const exitCalls = [];
    process.exit = (code) => { exitCalls.push(code); };
    console.error = (msg) => errLines.push(String(msg));
    console.log = (msg) => outLines.push(String(msg));

    await dryRun(root, specPath, {});

    assert.ok(exitCalls.length > 0 && exitCalls.every((c) => c !== 0), `queued:false must exit non-zero (got ${JSON.stringify(exitCalls)})`);
    assert.ok(errLines.some((l) => l.includes('plan rejected by user')), `stderr must name the reason (got ${JSON.stringify(errLines)})`);
    assert.ok(!outLines.some((l) => l.includes('validated and queued')), 'no success epilogue on a queued:false result');
  } finally {
    Pipeline.prototype.dryRunValidate = origDryRunValidate;
    process.exit = origExit;
    console.error = origError;
    console.log = origLog;
    cleanup(root);
  }
});

await test('TC8(h) HOLE-24: dry-run.js CLI prints the success epilogue on a queued:true result', async () => {
  const root = makeTmpRoot();
  const specPath = path.join(root, 'spec.md');
  fs.writeFileSync(specPath, '# Test Spec\n');
  const origDryRunValidate = Pipeline.prototype.dryRunValidate;
  const origExit = process.exit;
  const origError = console.error;
  const origLog = console.log;
  const errLines = [];
  const outLines = [];
  try {
    Pipeline.prototype.dryRunValidate = async function () {
      return { queued: true };
    };
    const exitCalls = [];
    process.exit = (code) => { exitCalls.push(code); };
    console.error = (msg) => errLines.push(String(msg));
    console.log = (msg) => outLines.push(String(msg));

    await dryRun(root, specPath, {});

    assert.strictEqual(exitCalls.length, 0, `queued:true must never call process.exit (got ${JSON.stringify(exitCalls)})`);
    assert.ok(outLines.some((l) => l.includes('validated and queued')), `stdout must print the success epilogue (got ${JSON.stringify(outLines)})`);
  } finally {
    Pipeline.prototype.dryRunValidate = origDryRunValidate;
    process.exit = origExit;
    console.error = origError;
    console.log = origLog;
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC9 (i) — helper fail-soft
// ═════════════════════════════════════════════════════════════════════════

await test('TC9(i): a poisoned queue entry dir swallows the helper failure and the original CircuitBreakerError propagates byte-identical', async () => {
  const root = makeTmpRoot();
  try {
    const slug = 'poison-slug';
    // Poison: entryDir exists as a FILE, not a directory, so writeParkScene's
    // mkdirSync inside the queue-linked leg throws — after the state.json
    // write has already landed.
    fs.mkdirSync(path.join(root, 'queue'), { recursive: true });
    fs.writeFileSync(path.join(root, 'queue', slug), 'not a directory');

    const { harnessDir } = createTaskHarness(root, { prdPath: path.join(root, 'queue', slug, 'spec.md') });
    const { pipeline, logs } = makeDispatchPipeline(root, () => verdict({ recommendation: 'human', affectedTaskIds: [] }));
    const TASK = taskFixture();

    const err = await dispatchCatch(pipeline, TASK);
    assert.ok(err, 'the human verdict must still throw despite the poisoned queue dir');
    const expected = `Circuit breaker: task ${TASK.id} failed verification after 4 attempts. ` +
      `Recommendation: human. 0 task(s) marked for revalidation. See .harness/analysis/${err.eventId}.json`;
    assert.strictEqual(err.message, expected, 'the original error message must propagate byte-identical despite the poisoned queue dir');

    assert.ok(logs.some((l) => l.includes('[halt-aftermath]') && l.includes('failed to persist halt evidence')),
      `a fail-soft log line must be emitted (logs: ${JSON.stringify(logs.slice(-5))})`);

    // Partial success: the state.json write (which happens BEFORE the
    // queue-linked leg) must still have landed.
    const stateAfter = readGlobalState(harnessDir);
    assert.strictEqual(stateAfter.globalStatus, 'paused');
    assert.ok(stateAfter.projectMeta.haltRecord, 'haltRecord must still be persisted even though the queue-linked write failed');
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC10 — registration
// ═════════════════════════════════════════════════════════════════════════

await test('TC10: scripts/run-tests.js registers test/test-halt-aftermath.js in TEST_FILES', async () => {
  const runTestsPath = path.resolve(__dirname, '../scripts/run-tests.js');
  const src = fs.readFileSync(runTestsPath, 'utf8');
  assert.ok(src.includes("'test/test-halt-aftermath.js'"), 'TEST_FILES must include this file');
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
