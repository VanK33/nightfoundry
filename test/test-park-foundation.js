#!/usr/bin/env node
/**
 * test-park-foundation.js — Track P P1: park foundation + plan-time
 * assumption gate (spec: p1-park-foundation.spec.md / .json).
 *
 * Written by the INDEPENDENT test author against the spec contract only —
 * before the implementation exists. At a pre-feature HEAD the behavioral
 * cases (TC2, TC3a, TC3b, TC4a, TC4b, TC4c, TC6) MUST fail because today an
 * uncertain assumption silently passes and the entry proceeds instead of
 * parking; the guard cases (TC3c, TC4d, TC5b, TC5c) pin today's behavior and
 * must keep passing after the feature lands.
 *
 * Coverage (numbered after the spec's acceptance criteria):
 *   TC1a (AC1) — VALID_QUEUE_STATUSES includes 'parked', 'halted-review',
 *                'rejected', 'failed-test-gate'
 *   TC1b (AC1) — writeParkScene/readParkScene round-trip on a real queue
 *                entry; readParkScene → null on missing AND on corrupt
 *   TC2  (AC2) — uncertain-only round 1 parks immediately (no remediation,
 *                no round 2; complete scene; status 'parked'); batch
 *                continues with the second entry
 *   TC3a (AC3) — failed-after-round-2 parks with appliedSpecEdits captured
 *                AND the remediated on-disk queue spec.md survives parking
 *                (no stale in-memory clobber)
 *   TC3b (AC3) — uncertain in round 2 also parks (final round decides)
 *   TC3d (AC3) — GAP TEST: execution failure AFTER successful remediation —
 *                the failed-execution status write must not clobber the
 *                remediated on-disk spec.md (spec.json untouched)
 *   TC3c (AC3) — genuine validation failure (UncheckableSpecError) still
 *                yields 'failed-validation', no park scene
 *   TC4a (AC4) — unconsumed waive: assumption verification skipped,
 *                consumedAt persisted to the scene, postFixAssumptions
 *                restored from the scene's round-1 deferred entries
 *   TC4b (AC4/AC6) — consumed waive is NOT re-waived (verification runs);
 *                re-park appends the prior resolution chain to
 *                previousResolutions in order
 *   TC4c (AC4) — requeue resolution triggers reExtractAssumptions on the
 *                queue copy spec.md before round 1
 *   TC4d (AC4) — reject is terminal: a 'rejected' entry is never picked up
 *   TC5a (AC5) — review-gate-site HaltError → status 'halted-review' +
 *                minimal scene (site/parkedAt/questions=[reason]); revert
 *                still performed; prior previousResolutions + consumed
 *                waive survive the minimal-scene write; batch continues
 *   TC5d (AC5) — GAP TEST (live-dogfood blind spot #3): review-gate halt
 *                with the REAL forensic-archive chain (no archive injection)
 *                — the queue entry must end the pass complete (spec.md +
 *                spec.json + plan.json + status + park.json all present)
 *   TC5e (AC5/AC3) — GAP TEST: generic execution failure with the REAL
 *                forensic-archive chain — preserve is unconditional for
 *                batch: the failed-execution entry keeps spec.md/spec.json
 *                and listQueue (the `queue list` read path) still works
 *   TC5b (AC5) — non-review-site HaltError keeps today's failed-execution
 *   TC5c (AC5) — review-gate "r"-choice Error (err.status === 'rejected')
 *                is NOT conflated with queue status 'rejected'
 *   TC6  (AC6) — crash-window state (scene present, status 'pending') is
 *                harmlessly re-validated; a null resolution is skipped (not
 *                appended to previousResolutions) on the re-park
 *
 * Run: node test/test-park-foundation.js
 *
 * Discipline (spec Constraints): only trigger conditions are stubbed — the
 * return values of planner.verifyAssumptions / reExtractAssumptions /
 * remediateAssumption (LLM seams) and injected HaltErrors. The real
 * batchResume, _parkEntry, and park-scene I/O are always exercised.
 * Park scenes used as FIXTURE INPUT are written with plain fs (the on-disk
 * format queue/<slug>/park.json is spec-pinned), so this file does not
 * depend on new state.js symbols at module-load time.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import * as stateMod from '../src/orchestrator/core/state.js';
import { writeQueueEntry, readQueueEntry, listQueue, VALID_QUEUE_STATUSES } from '../src/orchestrator/core/state.js';
import { HaltError } from '../src/orchestrator/core/halt-error.js';
import { readLedger } from '../src/orchestrator/core/warnings-ledger.js';

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

// ── Fixture data ───────────────────────────────────────────────────────────

// Deliberately scope-item-free markdown (no '## Scope — in', no **Bug N**
// bullets, no scope-item markers, no backticked paths) so _scopeCoverageGate
// skips — mirrors test/test-batch-failure-crash-safety.js. The '## Goals'
// section + ORIGINAL-CLAUSE anchor exist for the remediation path
// (_extractSpecSection exact-matches 'Goals'; _applySpecEdit replaces the
// clause text).
const SPEC_MD = `# Test Spec

This is a test spec for the park-foundation paths.

## Goals
- Build something useful around ORIGINAL-CLAUSE here
`;

// Parseable sibling json so the uncheckable-spec gate passes.
const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

function makePlan(assumptions = []) {
  // Fresh-run shape: a goal-only plan carries scopeItems:[]/scopeMapping:[]
  // (present-and-empty → gate skips). Absent the key → treated as LEGACY and
  // the scope gate fail-closes before this test's behavior runs.
  return { milestones: [], assumptions, scopeItems: [], scopeMapping: [] };
}

function makeTmpRoot(prefix = 'cc-orch-park-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Git fixture for the revert-observing case: init + identity + tracked seed
// file + .gitignore covering harness-side dirs, committed clean.
function makeGitRoot(prefix = 'cc-orch-park-git-') {
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

// Write a pending queue entry through the production write path.
function createQueueEntry(root, slug, {
  spec = SPEC_MD,
  plan = makePlan(),
  validatedAt = new Date().toISOString(),
  status = 'pending',
  specJson = SPEC_JSON,
} = {}) {
  writeQueueEntry(root, slug, { spec, plan, validatedAt, status, specJson });
}

// Park-scene FIXTURE writer — plain fs against the spec-pinned on-disk
// location queue/<slug>/park.json. (Fixture input only; assertions on scenes
// the pipeline writes always re-read the file the real code produced.)
function writeSceneFixture(root, slug, scene) {
  fs.writeFileSync(
    path.join(root, 'queue', slug, 'park.json'),
    JSON.stringify(scene, null, 2)
  );
}

function readSceneRaw(root, slug) {
  const p = path.join(root, 'queue', slug, 'park.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function sceneExists(root, slug) {
  return fs.existsSync(path.join(root, 'queue', slug, 'park.json'));
}

// The advisory-no-park contract: each genuine uncertain is appended to the
// warnings ledger (category 'assumption-uncertain', description === the
// assumption text). Read it back through the production readLedger.
function uncertainLedgerEntries(root) {
  return readLedger(root).filter((e) => e.category === 'assumption-uncertain');
}

// Spec-pinned scene shape (Scope item 1).
function makeScene(overrides = {}) {
  return {
    site: 'assumption-gate',
    parkedAt: '2026-06-01T00:00:00.000Z',
    round1: [],
    round2: null,
    appliedSpecEdits: [],
    questions: [],
    previousResolutions: [],
    resolution: null,
    ...overrides,
  };
}

function assertValidTimestamp(value, label) {
  assert.ok(value, `${label} must be set (got ${JSON.stringify(value)})`);
  assert.ok(
    !Number.isNaN(new Date(value).getTime()),
    `${label} must be a parseable timestamp (got ${JSON.stringify(value)})`
  );
}

function assertEmptyish(value, label) {
  assert.ok(
    value == null || (Array.isArray(value) && value.length === 0),
    `${label} must be empty/null in this scene (got ${JSON.stringify(value)})`
  );
}

// ── Helper: batch pipeline with stubbed agent seams + injected archive ──────
// Mirrors test/test-batch-failure-crash-safety.js makeBatchPipeline. Only
// trigger seams are stubbed; batchResume itself is the real code path.
//
// verifyResponder(text, assumptionObj) → 'verified'|'failed'|'uncertain'|'deferred'
function makeBatchPipeline(root, opts = {}) {
  const logs = [];
  const archiveCalls = [];
  const verifyCalls = [];      // array of arrays of assumption texts per call
  const reExtractCalls = [];   // array of { specPath, projectRoot }
  const remediateCalls = [];   // array of assumption texts
  const executeCaptures = [];  // array of { plan, sceneAtExecution }
  let executeCallCount = 0;
  let reviewCallCount = 0;

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

  const verifyResponder = opts.verifyResponder || (() => 'verified');
  pipeline.planner.verifyAssumptions = async (assumptions) => {
    const texts = (assumptions || []).map((a) => a?.text ?? a);
    verifyCalls.push(texts);
    return (assumptions || []).map((a) => ({
      assumption: a,
      status: verifyResponder(a?.text ?? a, a, verifyCalls.length),
      evidence: `stubbed evidence for "${a?.text ?? a}"`,
    }));
  };

  pipeline.planner.remediateAssumption = async (assumptionText) => {
    remediateCalls.push(assumptionText);
    if (opts.onRemediate) return opts.onRemediate(assumptionText);
    return { specEdit: { old: '', new: '' }, revisedAssumptions: [] };
  };

  pipeline.planner.reExtractAssumptions = async (specPath, projectRoot) => {
    reExtractCalls.push({ specPath, projectRoot });
    if (opts.onReExtract) return opts.onReExtract(specPath, projectRoot);
    return [];
  };

  pipeline.planner.closeReusableSession = async () => {};

  pipeline._executeAllMilestones = async (plan) => {
    executeCallCount++;
    if (opts.onExecute) {
      return opts.onExecute(plan, executeCallCount, executeCaptures);
    }
  };
  pipeline._reviewGate = async (reviewOpts) => {
    reviewCallCount++;
    if (opts.onReview) return opts.onReview(reviewOpts, reviewCallCount);
  };

  return {
    pipeline,
    logs,
    archiveCalls,
    verifyCalls,
    reExtractCalls,
    remediateCalls,
    executeCaptures,
    getExecuteCount: () => executeCallCount,
    getReviewCount: () => reviewCallCount,
  };
}

// ── TC1a (AC1): VALID_QUEUE_STATUSES extended ───────────────────────────────

await test('TC1a (AC1): VALID_QUEUE_STATUSES includes parked, halted-review, rejected, failed-test-gate', async () => {
  for (const s of ['parked', 'halted-review', 'rejected', 'failed-test-gate']) {
    assert.ok(
      VALID_QUEUE_STATUSES.includes(s),
      `VALID_QUEUE_STATUSES must include '${s}' (got [${VALID_QUEUE_STATUSES.join(', ')}])`
    );
  }
  // Existing statuses must survive the extension.
  for (const s of ['pending', 'failed-validation', 'failed-execution']) {
    assert.ok(VALID_QUEUE_STATUSES.includes(s), `existing status '${s}' must remain registered`);
  }
});

// ── TC1b (AC1): writeParkScene/readParkScene state-layer contract ───────────

await test('TC1b (AC1): writeParkScene/readParkScene round-trip; readParkScene → null on missing and on corrupt park.json', async () => {
  assert.strictEqual(typeof stateMod.writeParkScene, 'function',
    'state.js must export writeParkScene(projectRoot, slug, scene)');
  assert.strictEqual(typeof stateMod.readParkScene, 'function',
    'state.js must export readParkScene(projectRoot, slug)');

  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'scene-rt');
    const scene = makeScene({
      round1: [{ assumption: { text: 'RT-A', phase: 'pre', specSection: 'Goals' }, status: 'uncertain', evidence: 'e' }],
      questions: ['RT-A'],
      previousResolutions: [{ action: 'requeue', at: '2026-05-01T00:00:00.000Z', note: 'n', consumedAt: null }],
      resolution: { action: 'waive', at: '2026-06-01T00:00:00.000Z', note: 'w', consumedAt: null },
    });
    stateMod.writeParkScene(root, 'scene-rt', scene);

    const onDisk = path.join(root, 'queue', 'scene-rt', 'park.json');
    assert.ok(fs.existsSync(onDisk), 'park scene must live at queue/<slug>/park.json');

    const back = stateMod.readParkScene(root, 'scene-rt');
    assert.deepStrictEqual(back, scene, 'readParkScene must round-trip the scene written by writeParkScene');

    // Missing → null, never throws.
    assert.strictEqual(stateMod.readParkScene(root, 'no-such-slug'), null,
      'readParkScene must return null for a missing park.json');

    // Corrupt → null, never throws.
    createQueueEntry(root, 'scene-corrupt');
    fs.writeFileSync(path.join(root, 'queue', 'scene-corrupt', 'park.json'), 'not json {{{');
    assert.strictEqual(stateMod.readParkScene(root, 'scene-corrupt'), null,
      'readParkScene must return null for an unparseable park.json');
  } finally {
    cleanup(root);
  }
});

// ── TC2 (advisory-no-park): uncertain-only round 1 does NOT park ─────────────
// Re-pinned to the advisory contract: a genuine uncertain no longer parks or
// gates — it is appended to the warnings ledger and the run CONTINUES. The
// entry executes and is removed (default no-op execution stub = success); no
// park.json scene is written; the ledger gains an 'assumption-uncertain'
// entry. Non-vacuous: it would fail if the entry parked OR the ledger were
// empty.

await test('TC2 (advisory-no-park): uncertain-only round 1 does NOT park — no park scene, the entry proceeds, and the uncertain is recorded to the warnings ledger', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'park-a', {
      plan: makePlan([{ text: 'UNCERTAIN-ONE', phase: 'pre', specSection: 'Goals' }]),
      validatedAt: '2026-06-01T00:00:00.000Z',
    });
    createQueueEntry(root, 'park-b', {
      plan: makePlan([]),
      validatedAt: '2026-06-02T00:00:00.000Z',
    });

    const h = makeBatchPipeline(root, {
      verifyResponder: (text) => (text === 'UNCERTAIN-ONE' ? 'uncertain' : 'verified'),
    });

    const result = await h.pipeline.batchResume({});

    // NO park: the uncertain must not write a park.json scene…
    assert.ok(!sceneExists(root, 'park-a'),
      'an uncertain-only verdict must NOT write a park.json scene — uncertain is advisory now, not a park trigger');
    // …and the entry must NOT end 'parked'. With a clean execution stub it
    // proceeds, archives, and is removed from the queue.
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'park-a')),
      "entry 'park-a' must proceed past the assumption gate (uncertain no longer gates) — it executes and is removed, not parked");

    // The uncertain was RECORDED to the warnings ledger.
    const uncertains = uncertainLedgerEntries(root);
    assert.ok(uncertains.length >= 1,
      `the warnings ledger must gain an 'assumption-uncertain' entry for the uncertain (got ${uncertains.length})`);
    assert.ok(uncertains.some((e) => e.description === 'UNCERTAIN-ONE'),
      `a ledger entry must carry the uncertain assumption text as its description (entries: ${JSON.stringify(uncertains.map((e) => e.description))})`);

    // No remediation, no round 2 — uncertain is neither failed nor deferred.
    assert.strictEqual(h.remediateCalls.length, 0,
      `remediateAssumption must NOT run for an uncertain-only round 1 (got ${h.remediateCalls.length} call(s))`);
    assert.strictEqual(h.reExtractCalls.length, 0,
      `reExtractAssumptions must NOT run (no remediation pass) (got ${h.reExtractCalls.length} call(s))`);
    assert.strictEqual(h.verifyCalls.length, 1,
      `verifyAssumptions must run exactly once (round 1 only) (got ${h.verifyCalls.length} call(s))`);

    // Both entries proceed and the batch archives both (the uncertain one is
    // no longer skipped).
    assert.strictEqual(h.getExecuteCount(), 2,
      `both entries must execute now that uncertain no longer skips execution (got ${h.getExecuteCount()} execution(s))`);
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'park-b')),
      "entry 'park-b' should be removed after its successful run");
    assert.strictEqual(result.archived, 2, `expected archived:2, got ${result.archived}`);
  } finally {
    cleanup(root);
  }
});

// ── TC3a (AC3): failed-after-round-2 parks; appliedSpecEdits captured; no stale clobber ──

await test('TC3a (AC3): failed after round 2 → parked with appliedSpecEdits; remediated on-disk spec.md survives parking', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'remed-a', {
      plan: makePlan([{ text: 'FAILED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }]),
    });

    const h = makeBatchPipeline(root, {
      verifyResponder: (text) => {
        if (text === 'FAILED-ASSUMPTION') return 'failed';   // round 1
        if (text === 'REVISED-ASSUMPTION') return 'failed';  // round 2 — still failing
        return 'verified';
      },
      onRemediate: () => ({
        specEdit: { old: 'ORIGINAL-CLAUSE', new: 'REMEDIATED-CLAUSE', section: 'Goals' },
        revisedAssumptions: [{ text: 'REVISED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }],
      }),
      onReExtract: () => [{ text: 'REVISED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }],
    });

    await h.pipeline.batchResume({});

    const entry = readQueueEntry(root, 'remed-a');
    assert.ok(entry, "entry 'remed-a' must still exist in the queue");
    assert.strictEqual(entry.status, 'parked',
      `entry 'remed-a' expected status 'parked' (failed-after-round-2 is a needs-a-human stop, not 'failed-validation'), got '${entry.status}'`);

    // Remediation actually ran (real _applySpecEdit on the queue copy)…
    assert.strictEqual(h.remediateCalls.length, 1,
      `remediateAssumption should run once for the round-1 failure (got ${h.remediateCalls.length})`);
    assert.strictEqual(h.verifyCalls.length, 2,
      `verifyAssumptions should run twice (round 1 + round 2) (got ${h.verifyCalls.length})`);

    // …and the scene captured the applied edits + both rounds.
    const scene = readSceneRaw(root, 'remed-a');
    assert.ok(scene, 'queue/remed-a/park.json must exist with a parseable scene');
    assert.ok(Array.isArray(scene.appliedSpecEdits) && scene.appliedSpecEdits.length >= 1,
      `scene.appliedSpecEdits must capture the auto-accepted remediation edit (got ${JSON.stringify(scene.appliedSpecEdits)})`);
    assert.ok(JSON.stringify(scene.round1).includes('FAILED-ASSUMPTION'),
      'scene.round1 must capture the round-1 failure');
    assert.ok(scene.round2 && JSON.stringify(scene.round2).includes('REVISED-ASSUMPTION'),
      'scene.round2 must capture the round-2 results');

    // No-stale-clobber: the remediated queue spec.md must survive parking.
    const specOnDisk = fs.readFileSync(path.join(root, 'queue', 'remed-a', 'spec.md'), 'utf8');
    assert.ok(specOnDisk.includes('REMEDIATED-CLAUSE'),
      'the remediated queue spec.md must survive parking — the park write must not persist the stale in-memory entry.spec captured at batch start');
    assert.ok(!specOnDisk.includes('ORIGINAL-CLAUSE'),
      'the pre-remediation clause must NOT reappear in the queue spec.md after parking (stale clobber)');
    // spec.json passthrough on the park write.
    assert.strictEqual(fs.readFileSync(path.join(root, 'queue', 'remed-a', 'spec.json'), 'utf8'), SPEC_JSON,
      'queue spec.json must survive the park status write (specJson passthrough)');
  } finally {
    cleanup(root);
  }
});

// ── TC3b (advisory-no-park): uncertain in round 2 does NOT park ─────────────
// Re-pinned to the advisory contract: a round-1 `failed` still routes to
// remediation (unchanged), but if round 2 comes back `uncertain` (zero
// failed), the entry no longer parks — the uncertain is recorded to the
// warnings ledger and the run CONTINUES. The entry executes and is removed; no
// park scene is written. Non-vacuous: it would fail if round-2 uncertain
// parked OR the ledger were empty.

await test('TC3b (advisory-no-park): uncertain in round 2 (after a real round-1 remediation) does NOT park — no park scene, the entry proceeds, the uncertain is recorded to the ledger', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'remed-b', {
      plan: makePlan([{ text: 'FAILED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }]),
    });

    const h = makeBatchPipeline(root, {
      verifyResponder: (text) => {
        if (text === 'FAILED-ASSUMPTION') return 'failed';     // round 1 → remediation
        if (text === 'REVISED-ASSUMPTION') return 'uncertain'; // round 2 — uncertain now
        return 'verified';
      },
      onRemediate: () => ({
        specEdit: { old: 'ORIGINAL-CLAUSE', new: 'REMEDIATED-CLAUSE', section: 'Goals' },
        revisedAssumptions: [{ text: 'REVISED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }],
      }),
      onReExtract: () => [{ text: 'REVISED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }],
    });

    await h.pipeline.batchResume({});

    // Round 1 failed → remediation really ran; round 2 came back uncertain.
    assert.strictEqual(h.remediateCalls.length, 1,
      `remediateAssumption should run once for the round-1 failure (got ${h.remediateCalls.length})`);
    assert.strictEqual(h.verifyCalls.length, 2,
      `verifyAssumptions should run twice (round 1 + round 2) (got ${h.verifyCalls.length})`);

    // NO park: a round-2 uncertain (zero failed) must not write a park scene…
    assert.ok(!sceneExists(root, 'remed-b'),
      'a round-2 uncertain must NOT write a park.json scene — uncertain is advisory now');
    // …and the entry proceeds, executes, and is removed.
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'remed-b')),
      "entry 'remed-b' must proceed past the assumption gate (round-2 uncertain no longer gates) — it executes and is removed, not parked");
    assert.strictEqual(h.getExecuteCount(), 1,
      'the entry must reach execution once the round-2 uncertain is recorded and let through');

    // The round-2 uncertain was recorded to the warnings ledger.
    const uncertains = uncertainLedgerEntries(root);
    assert.ok(uncertains.some((e) => e.description === 'REVISED-ASSUMPTION'),
      `the round-2 uncertain must be recorded to the warnings ledger (entries: ${JSON.stringify(uncertains.map((e) => e.description))})`);
  } finally {
    cleanup(root);
  }
});

// ── TC3d (AC3 / no-stale-clobber): post-remediation EXECUTION failure ────────
// The no-stale-clobber constraint covers ANY queue-entry rewrite that happens
// after remediation may have applied spec edits — including the
// failed-execution status write. GAP TEST (adversarial-review round): against
// the unfixed implementation this fails because the failed-execution write
// persists the stale in-memory entry.spec captured at batch start; it passes
// once status flips go through a status-only write primitive.

await test('TC3d (AC3): execution failure after successful remediation — failed-execution write must NOT clobber the remediated spec.md (spec.json untouched)', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'remed-exec', {
      plan: makePlan([{ text: 'FAILED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }]),
    });

    const h = makeBatchPipeline(root, {
      verifyResponder: (text) => {
        if (text === 'FAILED-ASSUMPTION') return 'failed';    // round 1
        if (text === 'REVISED-ASSUMPTION') return 'verified'; // round 2 — clean
        return 'verified';
      },
      onRemediate: () => ({
        specEdit: { old: 'ORIGINAL-CLAUSE', new: 'REMEDIATED-CLAUSE', section: 'Goals' },
        revisedAssumptions: [{ text: 'REVISED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }],
      }),
      onReExtract: () => [{ text: 'REVISED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }],
      onExecute: () => {
        throw new Error('milestone execution exploded (generic, non-HaltError)');
      },
    });

    await h.pipeline.batchResume({});

    // Fixture sanity: remediation really ran and round 2 passed clean.
    assert.strictEqual(h.remediateCalls.length, 1,
      `fixture: remediateAssumption should run once (got ${h.remediateCalls.length})`);
    assert.strictEqual(h.verifyCalls.length, 2,
      `fixture: verifyAssumptions should run twice (got ${h.verifyCalls.length})`);
    assert.strictEqual(h.getExecuteCount(), 1,
      `fixture: the entry must reach execution after the clean round 2 (got ${h.getExecuteCount()})`);

    const entry = readQueueEntry(root, 'remed-exec');
    assert.ok(entry, "entry 'remed-exec' must still exist in the queue");
    assert.strictEqual(entry.status, 'failed-execution',
      `a generic execution failure keeps 'failed-execution', got '${entry.status}'`);
    assert.ok(!sceneExists(root, 'remed-exec'),
      'no park.json may be written for a plain execution failure');

    // The point of the test: any post-remediation queue-entry rewrite must be
    // status-only (or re-read from disk) — never persist the stale
    // batch-start entry.spec.
    const specOnDisk = fs.readFileSync(path.join(root, 'queue', 'remed-exec', 'spec.md'), 'utf8');
    assert.ok(specOnDisk.includes('REMEDIATED-CLAUSE'),
      'the remediated queue spec.md must survive the failed-execution write — the status flip must not persist the stale in-memory entry.spec captured at batch start');
    assert.ok(!specOnDisk.includes('ORIGINAL-CLAUSE'),
      'the pre-remediation clause must NOT reappear in the queue spec.md after the failed-execution write (stale clobber)');
    assert.strictEqual(fs.readFileSync(path.join(root, 'queue', 'remed-exec', 'spec.json'), 'utf8'), SPEC_JSON,
      'queue spec.json must be untouched by the failed-execution status write');
  } finally {
    cleanup(root);
  }
});

// ── TC3c (AC3): genuine validation failure stays failed-validation ──────────
// Guard case: passes at pre-feature HEAD and must keep passing.

await test('TC3c (AC3): genuine validation failure (UncheckableSpecError: no spec.json) still yields failed-validation, no park scene', async () => {
  const root = makeTmpRoot();
  try {
    // No specJson → the uncheckable-spec gate throws UncheckableSpecError.
    writeQueueEntry(root, 'uncheckable-a', {
      spec: SPEC_MD,
      plan: makePlan([{ text: 'NEVER-CHECKED', phase: 'pre', specSection: 'Goals' }]),
      validatedAt: new Date().toISOString(),
      status: 'pending',
    });

    const h = makeBatchPipeline(root, {
      verifyResponder: () => 'uncertain',
    });

    const result = await h.pipeline.batchResume({});

    const entry = readQueueEntry(root, 'uncheckable-a');
    assert.ok(entry, "entry 'uncheckable-a' must still exist in the queue");
    assert.strictEqual(entry.status, 'failed-validation',
      `a genuine validation failure must stay 'failed-validation', got '${entry.status}'`);
    assert.ok(!sceneExists(root, 'uncheckable-a'),
      'no park.json may be written for a genuine validation failure');
    assert.strictEqual(h.verifyCalls.length, 0,
      'the gate fires before round-1 verification — verifyAssumptions must not be called');
    assert.strictEqual(result.failed, 1, `expected failed:1, got ${result.failed}`);
  } finally {
    cleanup(root);
  }
});

// ── TC4a (AC4): unconsumed waive — skip verification once, consume, restore postFix ──

await test('TC4a (AC4): unconsumed waive skips verification, persists consumedAt, restores postFixAssumptions from round-1 deferred entries', async () => {
  const root = makeTmpRoot();
  try {
    const deferredAssumption = { text: 'DEFERRED-POSTFIX', phase: 'post-fix', specSection: 'Goals' };
    createQueueEntry(root, 'waive-a', {
      plan: makePlan([{ text: 'WAIVED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }]),
    });
    writeSceneFixture(root, 'waive-a', makeScene({
      round1: [
        { assumption: { text: 'WAIVED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }, status: 'uncertain', evidence: 'could not confirm' },
        { assumption: deferredAssumption, status: 'deferred', evidence: '' },
      ],
      questions: ['WAIVED-ASSUMPTION'],
      resolution: { action: 'waive', at: '2026-06-10T00:00:00.000Z', note: 'accepted risk', consumedAt: null },
    }));

    const h = makeBatchPipeline(root, {
      verifyResponder: () => 'verified',
      // Fail execution (after capturing) so the entry — and its scene — stay
      // on disk for the consumedAt persistence assertion.
      onExecute: (plan, _count, captures) => {
        captures.push({
          postFixAssumptions: plan.postFixAssumptions,
          sceneAtExecution: readSceneRaw(root, 'waive-a'),
        });
        throw new Error('execution exploded (intentional, keeps the entry on disk)');
      },
    });

    await h.pipeline.batchResume({});

    // Verification skipped entirely for the waived entry.
    assert.strictEqual(h.verifyCalls.length, 0,
      `an unconsumed waive must skip assumption verification (verifyAssumptions was called ${h.verifyCalls.length} time(s) — at the broken baseline the waive resolution is ignored and verification runs)`);

    // postFixAssumptions restored from the scene's round-1 deferred entries.
    assert.strictEqual(h.executeCaptures.length, 1, 'the waived entry must reach execution');
    const restored = h.executeCaptures[0].postFixAssumptions;
    assert.ok(Array.isArray(restored) && restored.length === 1,
      `plan.postFixAssumptions must be restored from the scene's round-1 deferred entries (got ${JSON.stringify(restored)})`);
    assert.ok(JSON.stringify(restored).includes('DEFERRED-POSTFIX'),
      `restored postFixAssumptions must contain the deferred assumption (got ${JSON.stringify(restored)})`);

    // consumedAt persisted to the scene (one-shot marker).
    const scene = readSceneRaw(root, 'waive-a');
    assert.ok(scene, 'park.json must still exist after the failed execution');
    assert.ok(scene.resolution && scene.resolution.action === 'waive',
      `the waive resolution must remain in the scene (got ${JSON.stringify(scene.resolution)})`);
    assertValidTimestamp(scene.resolution.consumedAt, 'scene.resolution.consumedAt');

    // Execution failed → today's failed-execution labeling (unchanged).
    const entry = readQueueEntry(root, 'waive-a');
    assert.strictEqual(entry.status, 'failed-execution',
      `the post-waive execution failure keeps today's handling, got '${entry.status}'`);
  } finally {
    cleanup(root);
  }
});

// ── TC4b (AC4/AC6): consumed waive is not re-waived; re-park appends history ──

await test('TC4b (AC4/AC6): consumed waive does NOT re-waive (verification runs); re-park appends prior resolution chain to previousResolutions', async () => {
  const root = makeTmpRoot();
  try {
    const priorRequeue = { action: 'requeue', at: '2026-06-09T00:00:00.000Z', note: 'first try', consumedAt: null };
    const consumedWaive = { action: 'waive', at: '2026-06-10T00:00:00.000Z', note: 'accepted once', consumedAt: '2026-06-10T01:00:00.000Z' };
    // PARK TRIGGER switched to failed-after-remediation (TC3a pattern): an
    // uncertain no longer parks, so to genuinely exercise the re-park /
    // previousResolutions-append machinery the entry must still-fail after a
    // remediation round. The SUBJECT (consumed waive runs verification; the
    // prior chain is appended on re-park) is unchanged.
    createQueueEntry(root, 'waive-b', {
      plan: makePlan([{ text: 'FAILED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }]),
    });
    writeSceneFixture(root, 'waive-b', makeScene({
      round1: [{ assumption: { text: 'FAILED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }, status: 'failed', evidence: 'e' }],
      questions: ['FAILED-ASSUMPTION'],
      previousResolutions: [priorRequeue],
      resolution: consumedWaive,
    }));

    const h = makeBatchPipeline(root, {
      verifyResponder: (text) => {
        if (text === 'FAILED-ASSUMPTION') return 'failed';   // round 1 → remediation
        if (text === 'REVISED-ASSUMPTION') return 'failed';  // round 2 — still failing → re-park
        return 'verified';
      },
      onRemediate: () => ({
        specEdit: { old: 'ORIGINAL-CLAUSE', new: 'REMEDIATED-CLAUSE', section: 'Goals' },
        revisedAssumptions: [{ text: 'REVISED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }],
      }),
      onReExtract: () => [{ text: 'REVISED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }],
    });

    await h.pipeline.batchResume({});

    // A consumed waive is spent: verification must run again — both rounds
    // (round 1 failed → remediation → round 2 re-verifies).
    assert.strictEqual(h.verifyCalls.length, 2,
      `a consumed waive must NOT skip verification (verifyAssumptions called ${h.verifyCalls.length} time(s), expected 2 — round 1 + round 2)`);

    const entry = readQueueEntry(root, 'waive-b');
    assert.ok(entry, "entry 'waive-b' must still exist in the queue");
    assert.strictEqual(entry.status, 'parked',
      `the still-failing entry must re-park, got '${entry.status}'`);

    const scene = readSceneRaw(root, 'waive-b');
    assert.ok(scene, 'queue/waive-b/park.json must exist');
    assert.strictEqual(scene.resolution, null,
      `a fresh re-park has resolution: null (got ${JSON.stringify(scene.resolution)})`);
    assert.ok(Array.isArray(scene.previousResolutions) && scene.previousResolutions.length === 2,
      `previousResolutions must keep the prior chain AND gain the consumed waive (got ${JSON.stringify(scene.previousResolutions)})`);
    assert.strictEqual(scene.previousResolutions[0].action, 'requeue',
      'the pre-existing previousResolutions entry must be preserved first');
    assert.strictEqual(scene.previousResolutions[1].action, 'waive',
      'the prior scene resolution must be APPENDED to previousResolutions on re-park');
  } finally {
    cleanup(root);
  }
});

// ── TC4c (AC4): requeue triggers reExtractAssumptions on the queue spec.md ──

await test('TC4c (AC4): requeue resolution re-runs reExtractAssumptions against the queue spec.md before round 1', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'requeue-a', {
      plan: makePlan([{ text: 'STALE-ASSUMPTION', phase: 'pre', specSection: 'Goals' }]),
    });
    writeSceneFixture(root, 'requeue-a', makeScene({
      round1: [{ assumption: { text: 'STALE-ASSUMPTION', phase: 'pre', specSection: 'Goals' }, status: 'uncertain', evidence: 'e' }],
      questions: ['STALE-ASSUMPTION'],
      resolution: { action: 'requeue', at: '2026-06-10T00:00:00.000Z', note: 'spec edited by hand', consumedAt: null },
    }));

    const h = makeBatchPipeline(root, {
      verifyResponder: () => 'verified',
      onReExtract: () => [{ text: 'FRESH-ASSUMPTION', phase: 'pre', specSection: 'Goals' }],
    });

    const result = await h.pipeline.batchResume({});

    assert.strictEqual(h.reExtractCalls.length, 1,
      `a requeue resolution must trigger reExtractAssumptions exactly once before round 1 (got ${h.reExtractCalls.length} call(s) — at the broken baseline the resolution is ignored)`);
    assert.strictEqual(
      h.reExtractCalls[0].specPath,
      path.join(root, 'queue', 'requeue-a', 'spec.md'),
      `reExtractAssumptions must run against the QUEUE copy spec.md (got '${h.reExtractCalls[0].specPath}')`
    );

    // Round 1 verifies the freshly extracted assumptions, not the stale plan.
    assert.ok(h.verifyCalls.length >= 1, 'round-1 verification must still run after re-extraction');
    assert.deepStrictEqual(h.verifyCalls[0], ['FRESH-ASSUMPTION'],
      `round 1 must verify the re-extracted assumptions (got ${JSON.stringify(h.verifyCalls[0])})`);

    // All verified → the entry proceeds and completes.
    assert.strictEqual(h.getExecuteCount(), 1, 'the requeued entry should execute after passing round 1');
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'requeue-a')),
      'the requeued entry should be removed after its successful run');
    assert.strictEqual(result.archived, 1, `expected archived:1, got ${result.archived}`);
  } finally {
    cleanup(root);
  }
});

// ── TC4d (AC4): reject is terminal ───────────────────────────────────────────
// Guard case: batch entry selection stays status === 'pending'.

await test("TC4d (AC4): a 'rejected' entry is terminal — never picked up by the batch", async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'rejected-a', {
      plan: makePlan([{ text: 'REJECTED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }]),
      status: 'rejected',
    });
    writeSceneFixture(root, 'rejected-a', makeScene({
      questions: ['REJECTED-ASSUMPTION'],
      resolution: { action: 'reject', at: '2026-06-10T00:00:00.000Z', note: 'not doing this', consumedAt: null },
    }));

    const h = makeBatchPipeline(root, { verifyResponder: () => 'verified' });

    const result = await h.pipeline.batchResume({});

    // Field-level (not whole-shape) assertions: the spec contracts that a
    // rejected entry is neither executed nor counted as a failure; the
    // summary object may carry additional fields (e.g. a parked count).
    assert.strictEqual(result.archived, 0,
      `a rejected entry must not be executed/archived (got ${JSON.stringify(result)})`);
    assert.strictEqual(result.failed, 0,
      `a rejected entry is terminal — it must not be re-counted as failed (got ${JSON.stringify(result)})`);
    assert.strictEqual(h.verifyCalls.length, 0, 'a rejected entry must never be verified');
    assert.strictEqual(h.getExecuteCount(), 0, 'a rejected entry must never execute');

    const entry = readQueueEntry(root, 'rejected-a');
    assert.ok(entry, 'the rejected entry must remain on disk (terminal close, no garbage collection in P1)');
    assert.strictEqual(entry.status, 'rejected', `status must remain 'rejected', got '${entry.status}'`);
  } finally {
    cleanup(root);
  }
});

// ── TC5a (AC5): review-gate HaltError → halted-review + minimal scene + revert ──

await test("TC5a (AC5): review-gate-site HaltError → status 'halted-review', minimal scene, revert performed, prior history survives, batch continues", async () => {
  const root = makeGitRoot();
  try {
    const priorRequeue = { action: 'requeue', at: '2026-06-08T00:00:00.000Z', note: 'earlier requeue', consumedAt: null };
    const consumedWaive = { action: 'waive', at: '2026-06-09T00:00:00.000Z', note: 'earlier waive', consumedAt: '2026-06-09T01:00:00.000Z' };

    createQueueEntry(root, 'halt-a', {
      plan: makePlan([]),
      validatedAt: '2026-06-01T00:00:00.000Z',
    });
    // Pre-existing park history: must survive the minimal-scene write
    // (read-existing-then-append, same logic as _parkEntry).
    writeSceneFixture(root, 'halt-a', makeScene({
      questions: ['OLD-QUESTION'],
      previousResolutions: [priorRequeue],
      resolution: consumedWaive,
    }));
    createQueueEntry(root, 'halt-b', {
      plan: makePlan([]),
      validatedAt: '2026-06-02T00:00:00.000Z',
    });

    const HALT_REASON = 'Review-gate accept/reject decision must be made by a human under auto mode.';
    const h = makeBatchPipeline(root, {
      onExecute: (_plan, count) => {
        // Dirty the tracked tree during the first entry's execution so the
        // revert is observable.
        if (count === 1) fs.writeFileSync(path.join(root, 'seed.txt'), 'CONTAMINATED\n');
      },
      onReview: (_opts, count) => {
        if (count === 1) throw new HaltError('review-gate', HALT_REASON);
      },
    });

    const result = await h.pipeline.batchResume({});

    const entry = readQueueEntry(root, 'halt-a');
    assert.ok(entry, "entry 'halt-a' must still exist in the queue");
    assert.strictEqual(entry.status, 'halted-review',
      `a review-gate HaltError in batch must be labeled 'halted-review' (got '${entry.status}' — at the broken baseline it is mislabeled 'failed-execution')`);
    assert.strictEqual(entry.specJson, SPEC_JSON,
      'specJson must be passed through on the halted-review write');

    // Minimal scene.
    const scene = readSceneRaw(root, 'halt-a');
    assert.ok(scene, 'queue/halt-a/park.json must exist with a parseable scene');
    assert.strictEqual(scene.site, 'review-gate',
      `minimal scene site expected 'review-gate', got '${scene.site}'`);
    assertValidTimestamp(scene.parkedAt, 'scene.parkedAt');
    assert.deepStrictEqual(scene.questions, [HALT_REASON],
      `minimal scene questions must be [HaltError.reason] (got ${JSON.stringify(scene.questions)})`);
    assertEmptyish(scene.round1, 'minimal scene round1');
    assertEmptyish(scene.round2, 'minimal scene round2');
    assertEmptyish(scene.appliedSpecEdits, 'minimal scene appliedSpecEdits');

    // Prior park history survives the minimal-scene write.
    assert.ok(Array.isArray(scene.previousResolutions) && scene.previousResolutions.length === 2,
      `a prior park's previousResolutions + consumed waive must survive the review-gate halt (got ${JSON.stringify(scene.previousResolutions)})`);
    assert.strictEqual(scene.previousResolutions[0].action, 'requeue', 'prior chain preserved first');
    assert.strictEqual(scene.previousResolutions[1].action, 'waive', 'prior scene resolution appended');
    assert.strictEqual(scene.resolution, null, 'the fresh halted-review scene is unresolved');

    // Revert still performed: tracked file restored, tree clean.
    assert.strictEqual(fs.readFileSync(path.join(root, 'seed.txt'), 'utf8'), 'seed content\n',
      'the working-tree revert must still run on the halted-review path (revert behavior unchanged)');
    const porcelain = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).trim();
    assert.strictEqual(porcelain, '', `working tree must be clean after the halted-review revert (got: ${porcelain})`);

    // Batch continues with the next entry.
    assert.strictEqual(h.getExecuteCount(), 2,
      `_executeAllMilestones should run for BOTH entries (got ${h.getExecuteCount()}) — the batch must continue past the halt`);
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'halt-b')),
      "entry 'halt-b' should be removed after its successful run");
    assert.strictEqual(result.archived, 1, `expected archived:1, got ${result.archived}`);
  } finally {
    cleanup(root);
  }
});

// ── TC5d (AC5): review-gate halt with the REAL forensic-archive chain ───────
// GAP TEST (live-dogfood regression, shared blind spot #3). TC5a injects the
// Pipeline `archive` seam, so the real archive() — whose include-failed branch
// calls copySpecToArchive(..., preserveMode=false) and MOVES the queue
// spec.md/spec.json into the failed archive — never ran in its halt path.
// Live result: entry marked 'halted-review' but gutted (readQueueEntry
// ENOENT, park list/show crash, requeue impossible). This case constructs
// the pipeline WITHOUT the archive injection so the real forensic chain runs
// (git repo fixture replicates the real batch environment), and pins the
// spec-correct end state: the queue entry survives the pass COMPLETE.

await test('TC5d (AC5): review-gate halt with the REAL forensic-archive chain — entry ends the pass complete (spec.md/spec.json not gutted)', async () => {
  const root = makeGitRoot();
  try {
    // A real (pending) milestone so the post-bootstrap state is a genuine
    // non-terminal run for detectHaltInfo — same shape the live batch had.
    createQueueEntry(root, 'halt-real', {
      plan: {
        milestones: [{ id: '001', description: 'Halt milestone', missions: [{ id: '001-001', description: 'Mission one' }] }],
        assumptions: [],
        // Scope-free fresh run: present-and-empty scope set so the gate skips.
        // Absent → legacy fail-close before the forensic-archive chain runs.
        scopeItems: [],
        scopeMapping: [],
      },
    });

    const HALT_REASON = 'Review-gate accept/reject decision must be made by a human under auto mode.';
    const logs = [];
    // NO `archive` injection: this._archive falls back to the real archive()
    // (pipeline.js: `this._archive = opts.archive || archive`). Stubs remain
    // trigger-only: planner LLM seams, a no-op execution stub, and the
    // injected review-gate HaltError.
    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: (msg) => logs.push(msg),
      onConfirm: async () => true,
    });
    pipeline.planner.verifyAssumptions = async () => [];
    pipeline.planner.remediateAssumption = async () => ({ specEdit: { old: '', new: '' }, revisedAssumptions: [] });
    pipeline.planner.reExtractAssumptions = async () => [];
    pipeline.planner.closeReusableSession = async () => {};
    pipeline._executeAllMilestones = async () => {};
    pipeline._reviewGate = async () => {
      throw new HaltError('review-gate', HALT_REASON);
    };

    await pipeline.batchResume({});

    // Fixture sanity: the REAL forensic archive actually ran (failed-* dir
    // with manifest + its own spec.md copy). Without this gate a pre-fix
    // pass would be vacuous (archive silently erroring out preserves the
    // entry by accident).
    const archivesDir = path.join(root, 'archives');
    const failedDirs = fs.existsSync(archivesDir)
      ? fs.readdirSync(archivesDir).filter((d) => d.startsWith('failed-'))
      : [];
    assert.strictEqual(failedDirs.length, 1,
      `fixture: the real forensic archive must run exactly once in the halt path (found ${JSON.stringify(failedDirs)}; archive logs: ${logs.filter((l) => l.toLowerCase().includes('archive')).join(' | ') || '(none)'})`);
    const failedDir = path.join(archivesDir, failedDirs[0]);
    assert.ok(fs.existsSync(path.join(failedDir, 'manifest.json')),
      'fixture: the forensic archive must contain manifest.json');
    assert.ok(fs.existsSync(path.join(failedDir, 'spec.md')),
      'fixture: the forensic archive must contain its own spec.md copy');

    // Honest classification + scene, as in TC5a.
    const statusOnDisk = fs.readFileSync(path.join(root, 'queue', 'halt-real', 'status'), 'utf8').trim();
    assert.strictEqual(statusOnDisk, 'halted-review',
      `the review-gate halt must be labeled 'halted-review' (got '${statusOnDisk}')`);
    const scene = readSceneRaw(root, 'halt-real');
    assert.ok(scene, 'queue/halt-real/park.json must exist with a parseable scene');
    assert.strictEqual(scene.site, 'review-gate', `scene.site expected 'review-gate', got '${scene.site}'`);
    assert.deepStrictEqual(scene.questions, [HALT_REASON],
      `minimal scene questions must be [HaltError.reason] (got ${JSON.stringify(scene.questions)})`);

    // THE regression: the queue entry must survive the pass COMPLETE — the
    // forensic archive must PRESERVE the queue spec files for a halted-review
    // entry instead of moving them into the failed archive.
    const entryDir = path.join(root, 'queue', 'halt-real');
    assert.ok(fs.existsSync(path.join(entryDir, 'spec.md')),
      'queue/halt-real/spec.md must still be present after the halt — the forensic archive gutted the entry at the broken baseline (copySpecToArchive preserveMode=false), crashing park list/show and making requeue impossible');
    assert.strictEqual(fs.readFileSync(path.join(entryDir, 'spec.md'), 'utf8'), SPEC_MD,
      'the surviving queue spec.md must carry the original content');
    assert.ok(fs.existsSync(path.join(entryDir, 'spec.json')),
      'queue/halt-real/spec.json must still be present after the halt (moved into the failed archive at the broken baseline)');
    assert.strictEqual(fs.readFileSync(path.join(entryDir, 'spec.json'), 'utf8'), SPEC_JSON,
      'the surviving queue spec.json must carry the original content');
    for (const f of ['plan.json', 'status', 'park.json']) {
      assert.ok(fs.existsSync(path.join(entryDir, f)),
        `the entry must end the pass complete: queue/halt-real/${f} must be present`);
    }

    // And the production read path works again — requeue is possible.
    const entry = readQueueEntry(root, 'halt-real');
    assert.ok(entry, 'readQueueEntry must succeed on the post-halt entry (no ENOENT)');
    assert.strictEqual(entry.status, 'halted-review',
      `readQueueEntry must report 'halted-review', got '${entry.status}'`);
    assert.strictEqual(entry.spec, SPEC_MD, 'readQueueEntry must round-trip the original spec');
    assert.strictEqual(entry.specJson, SPEC_JSON, 'readQueueEntry must round-trip the original specJson');
  } finally {
    cleanup(root);
  }
});

// ── TC5e (AC5/AC3): generic execution failure with the REAL forensic chain ──
// GAP TEST (escalated from TC5d's adjacent finding): the forensic archive's
// preserve must be UNCONDITIONAL for batch entries, not review-halt-only. A
// failed-execution entry whose spec files were moved into the failed archive
// breaks `cc-orch queue list` (listQueue → unguarded readQueueEntry throws
// ENOENT). Pre-P1, the failure-path full rewrite incidentally restored the
// moved files; the status-only write (no-stale-clobber fix) removed that
// accident, so preservation must now be explicit. Same real-forensic-chain
// fixture as TC5d; the execution stub throws a GENERIC error, not a
// HaltError.

await test('TC5e (AC5/AC3): generic execution failure with the REAL forensic-archive chain — entry keeps spec.md/spec.json and listQueue still works', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'fail-real', {
      plan: {
        milestones: [{ id: '001', description: 'Fail milestone', missions: [{ id: '001-001', description: 'Mission one' }] }],
        assumptions: [],
        // Scope-free fresh run: present-and-empty scope set so the gate skips.
        // Absent → legacy fail-close before the forensic-archive chain runs.
        scopeItems: [],
        scopeMapping: [],
      },
    });

    const logs = [];
    // NO `archive` injection — the real archive() include-failed chain runs.
    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: (msg) => logs.push(msg),
      onConfirm: async () => true,
    });
    pipeline.planner.verifyAssumptions = async () => [];
    pipeline.planner.remediateAssumption = async () => ({ specEdit: { old: '', new: '' }, revisedAssumptions: [] });
    pipeline.planner.reExtractAssumptions = async () => [];
    pipeline.planner.closeReusableSession = async () => {};
    pipeline._executeAllMilestones = async () => {
      throw new Error('milestone execution exploded (generic, non-HaltError)');
    };
    pipeline._reviewGate = async () => {};

    const result = await pipeline.batchResume({});

    // Fixture sanity: the REAL forensic archive actually ran.
    const archivesDir = path.join(root, 'archives');
    const failedDirs = fs.existsSync(archivesDir)
      ? fs.readdirSync(archivesDir).filter((d) => d.startsWith('failed-'))
      : [];
    assert.strictEqual(failedDirs.length, 1,
      `fixture: the real forensic archive must run exactly once (found ${JSON.stringify(failedDirs)}; archive logs: ${logs.filter((l) => l.toLowerCase().includes('archive')).join(' | ') || '(none)'})`);
    const failedDir = path.join(archivesDir, failedDirs[0]);
    assert.ok(fs.existsSync(path.join(failedDir, 'manifest.json')),
      'fixture: the forensic archive must contain manifest.json');
    assert.ok(fs.existsSync(path.join(failedDir, 'spec.md')),
      'fixture: the forensic archive must contain its own spec.md copy');

    // Today's labeling unchanged: generic failure, no park scene.
    const statusOnDisk = fs.readFileSync(path.join(root, 'queue', 'fail-real', 'status'), 'utf8').trim();
    assert.strictEqual(statusOnDisk, 'failed-execution',
      `a generic execution failure keeps 'failed-execution', got '${statusOnDisk}'`);
    assert.ok(!sceneExists(root, 'fail-real'),
      'no park.json may be written for a plain execution failure');
    assert.strictEqual(result.failed, 1, `expected failed:1, got ${result.failed}`);

    // THE regression: the failed-execution entry must also end the pass with
    // its spec files intact — preserve is unconditional for batch, not
    // review-halt-only.
    const entryDir = path.join(root, 'queue', 'fail-real');
    assert.ok(fs.existsSync(path.join(entryDir, 'spec.md')),
      'queue/fail-real/spec.md must still be present after a failed-execution pass — with review-halt-only preserve the forensic archive guts the entry and `cc-orch queue list` crashes on the unguarded readQueueEntry');
    assert.strictEqual(fs.readFileSync(path.join(entryDir, 'spec.md'), 'utf8'), SPEC_MD,
      'the surviving queue spec.md must carry the original content');
    assert.ok(fs.existsSync(path.join(entryDir, 'spec.json')),
      'queue/fail-real/spec.json must still be present after a failed-execution pass');
    assert.strictEqual(fs.readFileSync(path.join(entryDir, 'spec.json'), 'utf8'), SPEC_JSON,
      'the surviving queue spec.json must carry the original content');

    // And the production listing path works: listQueue must return the entry
    // without throwing (this is the `cc-orch queue list` read path).
    const listed = listQueue(root);
    assert.strictEqual(listed.length, 1,
      `listQueue must succeed over the queue and return the failed entry (got ${listed.length} entr(ies))`);
    assert.strictEqual(listed[0].slug, 'fail-real', 'listQueue must return the failed entry');
    assert.strictEqual(listed[0].status, 'failed-execution',
      `listQueue must report the entry as failed-execution, got '${listed[0].status}'`);
  } finally {
    cleanup(root);
  }
});

// ── TC5b (AC5): non-review-site HaltError keeps failed-execution ────────────
// Guard case: passes at pre-feature HEAD and must keep passing.

await test('TC5b (AC5): non-review-site HaltError keeps today\'s failed-execution handling (no halted-review, no park scene)', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'halt-other', { plan: makePlan([]) });

    const h = makeBatchPipeline(root, {
      onExecute: () => {
        throw new HaltError('coverage-gate', 'Coverage gate requires a human decision.');
      },
    });

    const result = await h.pipeline.batchResume({});

    const entry = readQueueEntry(root, 'halt-other');
    assert.ok(entry, "entry 'halt-other' must still exist in the queue");
    assert.strictEqual(entry.status, 'failed-execution',
      `a non-review-site HaltError keeps today's 'failed-execution' handling, got '${entry.status}'`);
    assert.ok(!sceneExists(root, 'halt-other'),
      'no park.json may be written for a non-review-site HaltError');
    assert.strictEqual(result.failed, 1, `expected failed:1, got ${result.failed}`);
  } finally {
    cleanup(root);
  }
});

// ── TC5c (AC5): review-gate "r"-choice Error is not conflated with 'rejected' ──
// Guard case: err.status === 'rejected' is a property on a plain Error thrown
// by the review gate's reject choice — NOT the queue status 'rejected'.

await test("TC5c (AC5): review-gate 'r'-choice Error (err.status === 'rejected') is NOT conflated with queue status 'rejected'", async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'reject-choice', { plan: makePlan([]) });

    const h = makeBatchPipeline(root, {
      onReview: () => {
        const err = new Error('Pipeline run rejected at review gate.');
        err.status = 'rejected';
        throw err;
      },
    });

    await h.pipeline.batchResume({});

    const entry = readQueueEntry(root, 'reject-choice');
    assert.ok(entry, "entry 'reject-choice' must still exist in the queue");
    assert.notStrictEqual(entry.status, 'rejected',
      "the review-gate reject Error must NOT produce queue status 'rejected' (that status is reserved for the park resolve --reject verb)");
    assert.notStrictEqual(entry.status, 'halted-review',
      "a plain Error (even with .status === 'rejected') is not a HaltError — it must not be classified 'halted-review'");
    assert.strictEqual(entry.status, 'failed-execution',
      `the reject Error keeps today's 'failed-execution' handling, got '${entry.status}'`);
  } finally {
    cleanup(root);
  }
});

// ── TC6 (AC6): crash-window state harmlessly re-validated; null resolution skipped ──
// Scene-before-status ordering makes "scene present, status still pending"
// the only possible crash window; the spec requires it to be harmless.

await test('TC6 (AC6): crash-window state (scene present, status pending) is harmlessly re-validated; null resolution is skipped, not appended', async () => {
  const root = makeTmpRoot();
  try {
    // PARK TRIGGER switched to failed-after-remediation (TC3a pattern): an
    // uncertain no longer parks, so the entry must still-fail after a
    // remediation round to genuinely re-park. The SUBJECT (a crash-window
    // scene with status 'pending' is harmlessly re-validated; a null
    // resolution is skipped, not appended) is unchanged.
    createQueueEntry(root, 'crash-window', {
      plan: makePlan([{ text: 'FAILED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }]),
      status: 'pending',
    });
    // Crash window: park.json fully written, status flip never happened.
    writeSceneFixture(root, 'crash-window', makeScene({
      round1: [{ assumption: { text: 'FAILED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }, status: 'failed', evidence: 'e' }],
      questions: ['FAILED-ASSUMPTION'],
      resolution: null,
    }));

    const h = makeBatchPipeline(root, {
      verifyResponder: (text) => {
        if (text === 'FAILED-ASSUMPTION') return 'failed';   // round 1 → remediation
        if (text === 'REVISED-ASSUMPTION') return 'failed';  // round 2 — still failing → re-park
        return 'verified';
      },
      onRemediate: () => ({
        specEdit: { old: 'ORIGINAL-CLAUSE', new: 'REMEDIATED-CLAUSE', section: 'Goals' },
        revisedAssumptions: [{ text: 'REVISED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }],
      }),
      onReExtract: () => [{ text: 'REVISED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }],
    });

    const result = await h.pipeline.batchResume({});

    // Re-validated normally (a null resolution consumes nothing) — both
    // rounds run (round 1 failed → remediation → round 2 re-verifies).
    assert.strictEqual(h.verifyCalls.length, 2,
      `the crash-window entry must be re-validated normally (verifyAssumptions called ${h.verifyCalls.length} time(s), expected 2 — round 1 + round 2)`);

    // …and re-parked, with the null resolution skipped (NOT appended).
    const entry = readQueueEntry(root, 'crash-window');
    assert.ok(entry, "entry 'crash-window' must still exist in the queue");
    assert.strictEqual(entry.status, 'parked',
      `the still-failing crash-window entry must end parked (got '${entry.status}')`);

    const scene = readSceneRaw(root, 'crash-window');
    assert.ok(scene, 'queue/crash-window/park.json must exist');
    assert.deepStrictEqual(scene.previousResolutions, [],
      `a null resolution (crash-window re-park) must be SKIPPED, not appended (got ${JSON.stringify(scene.previousResolutions)})`);
    assert.strictEqual(scene.resolution, null, 'the re-parked scene is unresolved');
    assert.strictEqual(h.getExecuteCount(), 0,
      'the crash-window entry must never reach execution');
    assert.strictEqual(result.archived, 0, `expected archived:0, got ${result.archived}`);
  } finally {
    cleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
