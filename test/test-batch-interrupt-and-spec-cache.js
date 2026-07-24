#!/usr/bin/env node
/**
 * test-batch-interrupt-and-spec-cache.js — Contract tests for three engine
 * holes, written from the contract (not the fix diff):
 *
 *   C1 (hole 7 — batch interrupt classification). When batchResume's cancel
 *      controller has aborted (SIGINT → this._cancelController.abort()), ANY
 *      error thrown out of an entry's processing must be dispositioned as a
 *      USER INTERRUPT — never a failure class:
 *        C1a  aborted + err.planPhase===true  → status stays 'pending', NO
 *             queue/<slug>/plan-failure.txt, error rethrown (batch stops).
 *        C1b  aborted + plain/untyped error   → status stays 'pending', NO
 *             forensic archive, error rethrown.
 *        C1c  (regression guard) UserInterruptError with signal NOT aborted →
 *             snapshot + rethrow + status unchanged, as today.
 *
 *   C2 (hole 12a — _repointHarness busts spec-text caches). _repointHarness()
 *      must reset the four per-spec getter caches so a pre-repoint value is
 *      never served post-repoint (direct + behavioral variants).
 *
 *   C3 (hole 12b — getSpecTargetFiles memoizes only a spec-anchored read).
 *      The exported getSpecTargetFiles() must NOT memoize when state.json's
 *      projectMeta.prdPath is absent; must still memoize when present; and
 *      must let readState's throw propagate when state.json is missing.
 *
 * Run: node test/test-batch-interrupt-and-spec-cache.js
 *
 * No live Claude sessions are spawned — all agent seams are stubbed and the
 * abort is forced deterministically inside a stubbed _executeAllMilestones.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeQueueEntry, readQueueEntry } from '../src/orchestrator/core/state.js';
import { getSpecTargetFiles } from '../src/orchestrator/core/assumption-data.js';
import { UserInterruptError } from '../src/orchestrator/core/halt-error.js';

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

// ── Fixture helpers ─────────────────────────────────────────────────────────

// Scope-item-free markdown so _scopeCoverageGate skips (mirrors the precedent
// test/test-batch-failure-crash-safety.js).
const SPEC_MD = `# Test Spec

This is a test spec for the batch interrupt-classification paths.

## Goals
- Build something useful
`;
const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

function makePlan() {
  return { milestones: [], assumptions: [], scopeItems: [], scopeMapping: [] };
}

function makeTmpRoot(prefix = 'cc-orch-interrupt-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeGitRoot(prefix = 'cc-orch-interrupt-git-') {
  const root = makeTmpRoot(prefix);
  execSync('git init', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed content\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'queue/\narchives/\nfake-archives/\n.harness/\n');
  execSync('git add -A', { cwd: root, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: root, stdio: 'pipe' });
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Removes the process-level listeners a Pipeline registered in its constructor
// (copied from test/test-pipeline-repoint.js) so constructing several
// Pipelines in one process does not accumulate listeners across tests.
function teardownPipeline(pipeline) {
  if (!pipeline || !pipeline._signalHandlers) return;
  process.removeListener('SIGINT', pipeline._signalHandlers.SIGINT);
  process.removeListener('SIGTERM', pipeline._signalHandlers.SIGTERM);
  process.removeListener('exit', pipeline._signalHandlers.exit);
  process.removeListener('uncaughtException', pipeline._signalHandlers.uncaughtException);
}

function createQueueEntry(root, slug, { validatedAt = new Date().toISOString() } = {}) {
  writeQueueEntry(root, slug, {
    spec: SPEC_MD,
    plan: makePlan(),
    validatedAt,
    status: 'pending',
    specJson: SPEC_JSON,
  });
}

// Mirrors test/test-batch-failure-crash-safety.js makeBatchPipeline: stubs the
// agent/gate seams so the batch entry path runs without LLM calls. `archive`
// is the this._archive injection seam; archiveCalls records forensic vs
// success-path invocations.
function makeBatchPipeline(root) {
  const logs = [];
  const archiveCalls = [];

  const archiveStub = async (_projectRoot, slug, archiveOpts) => {
    archiveCalls.push({ slug, opts: archiveOpts });
    const dir = path.join(root, 'fake-archives', String(archiveCalls.length));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const pipeline = new Pipeline(root, {
    skipWorktreeCreation: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    archive: archiveStub,
  });

  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._executeAllMilestones = async () => {};
  pipeline._reviewGate = async () => {};

  return { pipeline, logs, archiveCalls };
}

// state.json with (or without) projectMeta.prdPath.
function writeStateWithPrd(harnessDir, prdPath) {
  fs.mkdirSync(harnessDir, { recursive: true });
  const state = { projectMeta: prdPath ? { prdPath } : {} };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state));
}

// Writes an absolute-pathed spec whose sibling spec.json carries target_files.
// Returns the absolute .md path (so deriveSpecJsonPath resolves the sibling
// .json without any cwd dependence).
function writeSpecWithTargets(root, base, targets) {
  const mdPath = path.join(root, base + '.md');
  fs.writeFileSync(mdPath, `# ${base}\n\nGoal.\n`);
  fs.writeFileSync(
    path.join(root, base + '.json'),
    JSON.stringify({ goal: '', target_files: targets, acceptance_criteria: [] }),
  );
  return mdPath;
}

// ── C1a: aborted + planPhase error → interrupt, not failed-plan ─────────────

await test('C1a: signal aborted + err.planPhase===true → status stays pending, no plan-failure.txt, batchResume rethrows', async () => {
  const root = makeGitRoot();
  let pipeline;
  try {
    createQueueEntry(root, 'int-plan');
    ({ pipeline } = makeBatchPipeline(root));

    // Force the abort deterministically, then throw a plan-phase-tagged error
    // (as a killed planner session would). No real SIGINT / child process.
    pipeline._executeAllMilestones = async () => {
      pipeline._cancelController.abort();
      const err = new Error('planner session killed by SIGINT');
      err.planPhase = true;
      throw err;
    };

    // Post-fix: recognised as an interrupt (aborted signal) → rethrown.
    // Pre-fix: falls into the failed-plan leg → status 'failed-plan' (or
    // 'failed-execution' if the tree is dirty), NO rethrow.
    await assert.rejects(
      () => pipeline.batchResume({}),
      /planner session killed/,
      'aborted planPhase error must be rethrown out of batchResume (interrupt, not failure)'
    );

    const entry = readQueueEntry(root, 'int-plan');
    assert.ok(entry, "entry 'int-plan' must still exist");
    assert.strictEqual(entry.status, 'pending',
      `status must REMAIN 'pending' on an aborted planPhase error, got '${entry.status}'`);
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'int-plan', 'plan-failure.txt')),
      'no plan-failure.txt may be written on the interrupt leg');
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ── C1b: aborted + plain error → interrupt, not failed-execution ────────────

await test('C1b: signal aborted + plain untyped error → status stays pending, no forensic archive, batchResume rethrows', async () => {
  const root = makeGitRoot();
  let pipeline;
  try {
    createQueueEntry(root, 'int-gate');
    let archiveCalls;
    ({ pipeline, archiveCalls } = makeBatchPipeline(root));

    pipeline._executeAllMilestones = async () => {
      pipeline._cancelController.abort();
      throw new Error('gate verifier session died mid-flight');
    };

    // Post-fix: interrupt leg rethrows. Pre-fix: generic failed-execution arm
    // marks 'failed-execution', attempts a forensic archive, and does NOT
    // rethrow.
    await assert.rejects(
      () => pipeline.batchResume({}),
      /gate verifier session died/,
      'aborted plain error must be rethrown out of batchResume (interrupt, not failure)'
    );

    const entry = readQueueEntry(root, 'int-gate');
    assert.ok(entry, "entry 'int-gate' must still exist");
    assert.strictEqual(entry.status, 'pending',
      `status must REMAIN 'pending' on an aborted plain error, got '${entry.status}'`);
    const forensic = archiveCalls.filter((c) => c.opts && c.opts['include-failed']);
    assert.strictEqual(forensic.length, 0,
      `no forensic archive may be created on the interrupt leg (got ${forensic.length})`);
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ── C1c: regression guard — UserInterruptError, signal NOT aborted ──────────

await test('C1c [regression guard]: UserInterruptError with signal NOT aborted → rethrow + status unchanged, no forensic archive', async () => {
  const root = makeGitRoot();
  let pipeline;
  try {
    createQueueEntry(root, 'int-typed');
    let archiveCalls;
    ({ pipeline, archiveCalls } = makeBatchPipeline(root));

    // No abort: exercise the pre-existing typed-interrupt behavior.
    pipeline._executeAllMilestones = async () => {
      throw new UserInterruptError('Ctrl-C at gate prompt');
    };

    await assert.rejects(
      () => pipeline.batchResume({}),
      (err) => err instanceof UserInterruptError,
      'a UserInterruptError must always be rethrown out of batchResume'
    );

    const entry = readQueueEntry(root, 'int-typed');
    assert.ok(entry, "entry 'int-typed' must still exist");
    assert.strictEqual(entry.status, 'pending',
      `status must remain 'pending' on the typed-interrupt path, got '${entry.status}'`);
    const forensic = archiveCalls.filter((c) => c.opts && c.opts['include-failed']);
    assert.strictEqual(forensic.length, 0, 'no forensic archive on the typed-interrupt path');
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ── C2 direct: _repointHarness busts the four per-spec getter caches ────────

await test('C2 direct: _repointHarness resets _specTargetFilesCache/_specConstraintsCache/_specAcceptanceCriteriaCache/_specGoalCache to undefined', () => {
  const root = makeTmpRoot('cc-orch-repoint-cache-');
  let pipeline;
  try {
    pipeline = new Pipeline(root, { onLog: () => {} });

    pipeline._specTargetFilesCache = ['sentinel-target'];
    pipeline._specConstraintsCache = ['sentinel-constraint'];
    pipeline._specAcceptanceCriteriaCache = [{ id: 'sentinel-ac' }];
    pipeline._specGoalCache = 'sentinel-goal';

    // A never-existed dir is fine — the repoint captures only store paths
    // (mirrors test-pipeline-repoint.js TC2).
    pipeline._repointHarness(path.join(root, '.harness', 'repointed-c2'));

    assert.strictEqual(pipeline._specTargetFilesCache, undefined,
      '_specTargetFilesCache must be busted by _repointHarness');
    assert.strictEqual(pipeline._specConstraintsCache, undefined,
      '_specConstraintsCache must be busted by _repointHarness');
    assert.strictEqual(pipeline._specAcceptanceCriteriaCache, undefined,
      '_specAcceptanceCriteriaCache must be busted by _repointHarness');
    assert.strictEqual(pipeline._specGoalCache, undefined,
      '_specGoalCache must be busted by _repointHarness');
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ── C2 behavioral: a value cached before repoint is never served after ──────

await test('C2 behavioral: _getSpecTargetFiles caches [X] under harness A, then returns [Y] (not stale [X]) after _repointHarness to B', () => {
  const root = makeTmpRoot('cc-orch-repoint-behav-');
  let pipeline;
  try {
    const dirA = path.join(root, '.harness-a');
    const dirB = path.join(root, '.harness-b');
    const specA = writeSpecWithTargets(root, 'spec-a', ['src/alpha.js']);
    const specB = writeSpecWithTargets(root, 'spec-b', ['src/beta.js']);
    writeStateWithPrd(dirA, specA);
    writeStateWithPrd(dirB, specB);

    pipeline = new Pipeline(root, { onLog: () => {} });

    pipeline._repointHarness(dirA);
    const fromA = pipeline._getSpecTargetFiles();
    assert.deepStrictEqual(fromA, ['src/alpha.js'], 'sanity: harness A must yield spec A target files [X]');

    pipeline._repointHarness(dirB);
    const fromB = pipeline._getSpecTargetFiles();
    assert.deepStrictEqual(fromB, ['src/beta.js'],
      'after repoint to B, _getSpecTargetFiles must return [Y]; a stale [X] means the cache was not busted');
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ── C3: getSpecTargetFiles must NOT memoize an un-anchored (no prdPath) read ─

await test('C3: getSpecTargetFiles does not memoize when prdPath is absent; the SAME cache yields [Y] once state gains a prdPath', () => {
  const root = makeTmpRoot('cc-orch-spec-cache-anchor-');
  try {
    const harnessDir = path.join(root, '.harness');
    writeStateWithPrd(harnessDir, undefined); // projectMeta has no prdPath

    const cache = {};
    const first = getSpecTargetFiles(harnessDir, root, cache);
    assert.deepStrictEqual(first, [], 'un-anchored read must return the empty fallback');
    assert.strictEqual(cache.value, undefined,
      'un-anchored read must NOT set cache.value (no memoization without a prdPath)');

    // Anchor state.json at a real spec with target files [Y].
    const specY = writeSpecWithTargets(root, 'spec-y', ['src/gamma.js']);
    writeStateWithPrd(harnessDir, specY);

    const second = getSpecTargetFiles(harnessDir, root, cache);
    assert.deepStrictEqual(second, ['src/gamma.js'],
      'once anchored, the same cache holder must yield [Y]; a stale [] means the empty read was wrongly memoized');
  } finally {
    cleanup(root);
  }
});

// ── C3 [regression guard]: memoization still works when prdPath IS present ──

await test('C3 [regression guard]: an anchored read is memoized — cached value survives deletion of the spec file', () => {
  const root = makeTmpRoot('cc-orch-spec-cache-memo-');
  try {
    const harnessDir = path.join(root, '.harness');
    const specZ = writeSpecWithTargets(root, 'spec-z', ['src/delta.js']);
    writeStateWithPrd(harnessDir, specZ);

    const cache = {};
    const first = getSpecTargetFiles(harnessDir, root, cache);
    assert.deepStrictEqual(first, ['src/delta.js'], 'anchored first read returns [Y]');

    // Delete the spec so a non-memoized re-read would yield []; the memoized
    // holder must still return [Y] without re-reading.
    fs.rmSync(path.join(root, 'spec-z.json'));
    fs.rmSync(path.join(root, 'spec-z.md'));

    const second = getSpecTargetFiles(harnessDir, root, cache);
    assert.deepStrictEqual(second, ['src/delta.js'],
      'anchored read must be memoized — the cached value must survive the spec deletion');
  } finally {
    cleanup(root);
  }
});

// ── C3 [regression guard]: readState's throw propagates when state.json is gone

await test('C3 [regression guard]: getSpecTargetFiles propagates readState throw when state.json is missing', () => {
  const root = makeTmpRoot('cc-orch-spec-cache-nostate-');
  try {
    const harnessDir = path.join(root, '.harness-missing');
    fs.mkdirSync(harnessDir, { recursive: true }); // dir exists, no state.json

    const cache = {};
    assert.throws(
      () => getSpecTargetFiles(harnessDir, root, cache),
      /ENOENT|no such file|state\.json/i,
      'a missing state.json must let readState throw propagate (behavior unchanged)'
    );
  } finally {
    cleanup(root);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
