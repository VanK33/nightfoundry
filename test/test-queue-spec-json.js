#!/usr/bin/env node
/**
 * test-queue-spec-json.js — Tests for the queue spec.json gate chain
 * (spec: queue-spec-json-gate).
 *
 * Coverage (numbered after the spec's acceptance criteria):
 *   TC1a — writeQueueEntry with specJson persists queue/<slug>/spec.json
 *          verbatim; readQueueEntry round-trips it (real disk, no fs mocks)
 *   TC1b — writeQueueEntry without specJson writes no spec.json and
 *          readQueueEntry returns specJson: null
 *   TC1c — a status-only re-write (no specJson) leaves an existing on-disk
 *          spec.json intact and still readable
 *   TC2  — gate-chain revival: deriveSpecJsonPath(<queue spec.md>, root)
 *          points at an existing file that parses to the original spec.json
 *   TC3a — dryRunValidate (mocked planner): root originals .spec.md+.spec.json
 *          → queue entry carries both artifacts; BOTH originals removed
 *   TC3b — dryRunValidate: out-of-root spec.md+spec.json are never unlinked
 *   TC3c — dryRunValidate goal-only (null prdPath): completes, entry has no
 *          spec.json, unrelated root spec artifacts untouched
 *   TC4a — dryRunValidate on a bare .md throws UncheckableSpecError BEFORE
 *          planGlobal; nothing queued
 *   TC4b — dryRunValidate on a bare .md + allowIncompleteScope proceeds and
 *          queues an entry without spec.json
 *   TC4c — batchResume: json-less pending entries marked failed-validation
 *          WITHOUT executing milestones; batch continues; no forensic archive
 *   TC4d — batchResume: json-less entry + allowIncompleteScope proceeds
 *   TC4e — resume(): bare-.md prdPath throws UncheckableSpecError before any
 *          milestone executes
 *   TC4f — resume(): bare-.md prdPath + allowIncompleteScope executes
 *   TC5  — batch cache hygiene: two entries with different spec.json values —
 *          the spec getters serve each entry its own goal/criteria/
 *          constraints/target_files at execution time (captured inside
 *          _executeAllMilestones)
 *
 * Run: node test/test-queue-spec-json.js
 *
 * No live Claude sessions are spawned — all planner interactions are mocked.
 *
 * makeResumeFixture() bootstraps a fresh harness root (no active-run pointer
 * claimed), so state.json is read back via activeHarnessDir(root)'s flat
 * harnessRoot fallback. Clear CC_ORCH_ACTIVE_RUN unconditionally here,
 * mirroring test-pipeline-repoint.js / test-runid-flip.js / scripts/run-
 * tests.js, so this file is re-entrancy-neutral regardless of launch context.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeQueueEntry, readQueueEntry } from '../src/orchestrator/core/state.js';
import { deriveSpecJsonPath } from '../src/orchestrator/core/spec-paths.js';
import { UncheckableSpecError } from '../src/orchestrator/core/uncheckable-spec-error.js';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';
import { activeHarnessDir } from '../src/orchestrator/core/run-context.js';

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
// bullets, no <!-- scope-item --> markers, no backticked paths) so
// _scopeCoverageGate skips and _getSpecTargetFiles has no md fallback.
const SPEC_MD = `# Test Spec

This is a test spec for the queue spec.json gate chain.

## Goals
- Build something useful
`;

// Verbatim-fidelity probe: odd spacing + trailing newline must survive the
// queue layer byte-for-byte (the queue never parses/re-serializes specJson).
const RAW_SPEC_JSON = '{\n  "goal": "round-trip goal",\n  "acceptance_criteria": [],\n  "weird_spacing":   [1, 2,  3]\n}\n';

const cannedGlobalPlan = {
  milestones: [
    {
      id: '001',
      description: 'Test milestone',
      missions: [{ id: '001-001', description: 'Test mission one' }],
    },
  ],
  assumptions: [],
};

function makePlan(overrides = {}) {
  return {
    milestones: overrides.milestones || [],
    assumptions: overrides.assumptions || [],
    // Fresh-run shape: a goal-only/scope-free plan carries present-and-empty
    // scopeItems/scopeMapping so the gate SKIPS. Absent the key, the gate treats
    // it as a LEGACY plan and fail-closes (IncompleteScopeError) before the
    // behavior under test (queue round-trip / batchResume gate-chain) runs.
    scopeItems: overrides.scopeItems || [],
    scopeMapping: overrides.scopeMapping || [],
    ...(overrides.marker ? { marker: overrides.marker } : {}),
  };
}

function makeTmpRoot(prefix = 'cc-orch-specjson-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Helper: dry-run pipeline with mocked planner ───────────────────────────
// Mirrors the harness style of test/test-dry-run-queue.js.

function makeDryRunPipeline(opts = {}) {
  const tmpDir = makeTmpRoot();

  const specFilename = opts.specFilename || 'gated.spec.md';
  const specPath = path.join(tmpDir, specFilename);
  fs.writeFileSync(specPath, opts.specContent || SPEC_MD);

  const specJsonPath = specPath.replace(/\.md$/, '.json');
  if (opts.specJsonContent !== undefined) {
    fs.writeFileSync(specJsonPath, opts.specJsonContent);
  }

  const logs = [];
  let planGlobalCallCount = 0;

  const pipeline = new Pipeline(tmpDir, {
    dryRun: true,
    skipWorktreeCreation: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    ...(opts.allowIncompleteScope ? { allowIncompleteScope: true } : {}),
  });

  pipeline.planner.planGlobal = async () => {
    planGlobalCallCount++;
    return JSON.parse(JSON.stringify(cannedGlobalPlan));
  };
  pipeline.planner.planMission = async () => {
    throw new Error('planMission must NOT be called in dryRunValidate');
  };
  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => {};

  return {
    tmpDir,
    specPath,
    specJsonPath,
    pipeline,
    logs,
    getPlanGlobalCallCount: () => planGlobalCallCount,
  };
}

// ── Helper: batch pipeline with stubbed agents + injected archive ──────────
// Mirrors the harness style of test/test-batch-resume.js, but drives the REAL
// Pipeline.prototype.batchResume (the archive() injection seam keeps the
// success path off the real Summarizer).

function makeBatchPipeline(root, opts = {}) {
  const logs = [];
  const archiveCalls = [];
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
    ...(opts.allowIncompleteScope ? { allowIncompleteScope: true } : {}),
  });

  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.remediateAssumption = async () => {
    throw new Error('remediateAssumption must NOT be called in these tests');
  };
  pipeline.planner.reExtractAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => {};

  pipeline._executeAllMilestones = async () => { executeCallCount++; };
  pipeline._reviewGate = async () => { reviewCallCount++; };

  return {
    pipeline,
    logs,
    archiveCalls,
    getExecuteCount: () => executeCallCount,
    getReviewCount: () => reviewCallCount,
  };
}

// Write a pending queue entry through the production write path.
function createQueueEntry(root, slug, {
  spec = SPEC_MD,
  plan = makePlan(),
  validatedAt = new Date().toISOString(),
  status = 'pending',
  specJson,
} = {}) {
  writeQueueEntry(root, slug, { spec, plan, validatedAt, status, specJson });
}

// ── Helper: resume() fixture — bootstrapped harness + one pending milestone ─

function makeResumeFixture(opts = {}) {
  const root = makeTmpRoot('cc-orch-specjson-resume-');
  const specPath = path.join(root, 'bare.spec.md');
  fs.writeFileSync(specPath, SPEC_MD);

  bootstrap(root, { prdPath: specPath });

  // Inject one pending milestone so "executes milestones" is observable.
  const stateJsonPath = path.join(activeHarnessDir(root), 'state.json');
  const state = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
  // Fresh-run shape: seed present-and-empty scopeItems/scopeMapping into
  // projectMeta (same place writeGlobalPlan persists them) so resume() rehydrates
  // them and the scope gate SKIPS — letting the bare-.md path reach the
  // uncheckable-spec gate this fixture actually exercises. Absent the key, the
  // scope gate would fail-close first and TC4e/TC4f would never reach it.
  state.projectMeta = state.projectMeta || {};
  state.projectMeta.scopeItems = [];
  state.projectMeta.scopeMapping = [];
  state.milestones = state.milestones || {};
  state.milestones['001'] = { description: 'Resume milestone', status: 'pending', missions: {} };
  fs.writeFileSync(stateJsonPath, JSON.stringify(state, null, 2));

  const logs = [];
  let milestoneCallCount = 0;

  const pipeline = new Pipeline(root, {
    skipWorktreeCreation: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    archive: async () => path.join(root, 'fake-archive'),
    ...(opts.allowIncompleteScope ? { allowIncompleteScope: true } : {}),
  });

  pipeline.planner.closeReusableSession = async () => {};
  pipeline._executeMilestone = async () => { milestoneCallCount++; };
  pipeline._reviewGate = async () => {};

  return { root, specPath, pipeline, logs, getMilestoneCallCount: () => milestoneCallCount };
}

// ── TC1a: round-trip WITH specJson (verbatim, real persist→re-read) ────────

await test('TC1a: writeQueueEntry with specJson persists queue/<slug>/spec.json verbatim; readQueueEntry round-trips it', async () => {
  const root = makeTmpRoot();
  try {
    const plan = makePlan({ milestones: [{ id: '001', description: 'm', missions: [] }] });
    const validatedAt = '2026-06-10T00:00:00.000Z';
    writeQueueEntry(root, 'rt-spec', {
      spec: SPEC_MD,
      plan,
      validatedAt,
      status: 'pending',
      specJson: RAW_SPEC_JSON,
    });

    const onDiskPath = path.join(root, 'queue', 'rt-spec', 'spec.json');
    assert.ok(fs.existsSync(onDiskPath), 'queue/rt-spec/spec.json should exist on disk');
    assert.strictEqual(
      fs.readFileSync(onDiskPath, 'utf8'),
      RAW_SPEC_JSON,
      'on-disk spec.json must be byte-identical to the specJson string (verbatim, never re-serialized)'
    );

    const entry = readQueueEntry(root, 'rt-spec');
    assert.ok(entry, 'readQueueEntry should return the entry');
    assert.strictEqual(entry.slug, 'rt-spec', 'slug round-trips');
    assert.strictEqual(entry.spec, SPEC_MD, 'spec round-trips');
    assert.deepStrictEqual(entry.plan, plan, 'plan round-trips');
    assert.strictEqual(entry.validatedAt, validatedAt, 'validatedAt round-trips');
    assert.strictEqual(entry.status, 'pending', 'status round-trips');
    assert.strictEqual(
      entry.specJson,
      RAW_SPEC_JSON,
      'readQueueEntry must return specJson as the verbatim string'
    );
  } finally {
    cleanup(root);
  }
});

// ── TC1b: round-trip WITHOUT specJson → no file, specJson: null ────────────

await test('TC1b: writeQueueEntry without specJson writes no spec.json; readQueueEntry returns specJson: null', async () => {
  const root = makeTmpRoot();
  try {
    writeQueueEntry(root, 'no-json', {
      spec: SPEC_MD,
      plan: makePlan(),
      validatedAt: new Date().toISOString(),
      status: 'pending',
    });

    const onDiskPath = path.join(root, 'queue', 'no-json', 'spec.json');
    assert.strictEqual(
      fs.existsSync(onDiskPath),
      false,
      'no spec.json file may be written when specJson is undefined'
    );

    const entry = readQueueEntry(root, 'no-json');
    assert.ok(entry, 'readQueueEntry should return the entry');
    assert.strictEqual(
      entry.specJson,
      null,
      `readQueueEntry must return specJson: null when spec.json is absent (got ${JSON.stringify(entry.specJson)})`
    );
  } finally {
    cleanup(root);
  }
});

// ── TC1c: status-only re-write preserves existing on-disk spec.json ────────

await test('TC1c: status-only re-write (no specJson) leaves the existing on-disk spec.json intact', async () => {
  const root = makeTmpRoot();
  try {
    const plan = makePlan();
    const validatedAt = new Date().toISOString();
    writeQueueEntry(root, 'keep-json', {
      spec: SPEC_MD,
      plan,
      validatedAt,
      status: 'pending',
      specJson: RAW_SPEC_JSON,
    });

    // Re-write the entry with a new status and NO specJson — writeQueueEntry
    // must be non-destructive toward the existing spec.json.
    writeQueueEntry(root, 'keep-json', {
      spec: SPEC_MD,
      plan,
      validatedAt,
      status: 'failed-validation',
    });

    const onDiskPath = path.join(root, 'queue', 'keep-json', 'spec.json');
    assert.ok(
      fs.existsSync(onDiskPath),
      'spec.json must survive a status-only re-write (non-destructive contract)'
    );
    assert.strictEqual(
      fs.readFileSync(onDiskPath, 'utf8'),
      RAW_SPEC_JSON,
      'surviving spec.json content must be unchanged'
    );

    const entry = readQueueEntry(root, 'keep-json');
    assert.strictEqual(entry.status, 'failed-validation', 'status re-write applied');
    assert.strictEqual(
      entry.specJson,
      RAW_SPEC_JSON,
      'readQueueEntry must still return the preserved specJson after the re-write'
    );
  } finally {
    cleanup(root);
  }
});

// ── TC2: gate-chain revival via deriveSpecJsonPath ──────────────────────────

await test('TC2: deriveSpecJsonPath(<queue spec.md>, root) points at an existing file parsing to the original spec.json', async () => {
  const root = makeTmpRoot();
  try {
    writeQueueEntry(root, 'revive', {
      spec: SPEC_MD,
      plan: makePlan(),
      validatedAt: new Date().toISOString(),
      status: 'pending',
      specJson: RAW_SPEC_JSON,
    });

    // This is exactly how every spec.json consumer derives the path: the
    // sibling of the queue entry's spec.md (the post-dry-run prdPath).
    const queueSpecMdPath = path.join(root, 'queue', 'revive', 'spec.md');
    const derived = deriveSpecJsonPath(queueSpecMdPath, root);

    assert.ok(
      fs.existsSync(derived),
      `derived spec.json path must exist on disk (got ${derived})`
    );
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(derived, 'utf8')),
      JSON.parse(RAW_SPEC_JSON),
      'derived file content must JSON.parse to the original spec.json'
    );
  } finally {
    cleanup(root);
  }
});

// ── TC3a: dryRunValidate copies both artifacts, removes both originals ─────

await test('TC3a: dryRunValidate (mocked planner) — queue entry has spec.md + spec.json; BOTH originals removed', async () => {
  // Distinctive valid-JSON formatting to prove byte fidelity of the copy.
  const dryJson = '{\n  "goal": "dry-run goal",\n  "target_files":  ["src/a.js"]\n}\n';
  const { tmpDir, specPath, specJsonPath, pipeline } = makeDryRunPipeline({
    specFilename: 'gated.spec.md',
    specJsonContent: dryJson,
  });
  try {
    await pipeline.dryRunValidate('Implement gated spec', { prdPath: specPath });

    const slug = 'gated.spec';
    const queueMd = path.join(tmpDir, 'queue', slug, 'spec.md');
    const queueJson = path.join(tmpDir, 'queue', slug, 'spec.json');

    assert.ok(fs.existsSync(queueMd), `queue/${slug}/spec.md should exist`);
    assert.strictEqual(fs.readFileSync(queueMd, 'utf8'), SPEC_MD, 'queue spec.md matches original');

    assert.ok(fs.existsSync(queueJson), `queue/${slug}/spec.json should exist`);
    assert.strictEqual(
      fs.readFileSync(queueJson, 'utf8'),
      dryJson,
      'queue spec.json must be byte-identical to the original sibling json'
    );

    assert.strictEqual(fs.existsSync(specPath), false, 'original spec.md must be removed (inside projectRoot)');
    assert.strictEqual(fs.existsSync(specJsonPath), false, 'original spec.json must be removed (inside projectRoot, same guards as the .md)');
  } finally {
    cleanup(tmpDir);
  }
});

// ── TC3b: out-of-root spec.md + spec.json are never unlinked ───────────────

await test('TC3b: dryRunValidate never unlinks out-of-root spec.md or spec.json (guards honored for the json too)', async () => {
  const stamp = `${Date.now()}-${process.pid}`;
  const externalMd = path.join(os.tmpdir(), `external-specjson-${stamp}.spec.md`);
  const externalJson = externalMd.replace(/\.md$/, '.json');
  fs.writeFileSync(externalMd, SPEC_MD);
  const externalJsonContent = '{"goal": "external goal"}\n';
  fs.writeFileSync(externalJson, externalJsonContent);

  const { tmpDir, pipeline } = makeDryRunPipeline({});
  try {
    await pipeline.dryRunValidate('Implement external spec', { prdPath: externalMd });

    assert.ok(fs.existsSync(externalMd), 'out-of-root spec.md must NOT be deleted');
    assert.ok(fs.existsSync(externalJson), 'out-of-root spec.json must NOT be deleted');

    // The json content is still copied INTO the queue entry (read before any
    // unlink decision; copy-in is independent of the removal guards).
    const slug = path.basename(externalMd).replace(/\.[^.]+$/, '');
    const queueJson = path.join(tmpDir, 'queue', slug, 'spec.json');
    assert.ok(fs.existsSync(queueJson), `queue/${slug}/spec.json should exist for an out-of-root spec`);
    assert.strictEqual(
      fs.readFileSync(queueJson, 'utf8'),
      externalJsonContent,
      'queue spec.json must match the out-of-root original'
    );
  } finally {
    cleanup(tmpDir);
    for (const f of [externalMd, externalJson]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

// ── TC3c: goal-only mode — completes, no json, no unlink ───────────────────

await test('TC3c: dryRunValidate goal-only (null prdPath) completes with no spec.json and no unlink attempted', async () => {
  const { tmpDir, pipeline } = makeDryRunPipeline({});
  // Decoy spec artifacts at root — must be untouched in goal-only mode.
  const decoyMd = path.join(tmpDir, 'decoy.spec.md');
  const decoyJson = path.join(tmpDir, 'decoy.spec.json');
  fs.writeFileSync(decoyMd, SPEC_MD);
  fs.writeFileSync(decoyJson, '{"goal": "decoy"}');
  try {
    await pipeline.dryRunValidate('Goal-only run', { prdPath: null });

    const queueDir = path.join(tmpDir, 'queue');
    assert.ok(fs.existsSync(queueDir), 'queue directory should be created in goal-only mode');

    // Goal-only entries land under slug 'spec' (no filename to derive from).
    const entry = readQueueEntry(tmpDir, 'spec');
    assert.ok(entry, "goal-only queue entry 'spec' should exist");
    assert.strictEqual(
      fs.existsSync(path.join(tmpDir, 'queue', 'spec', 'spec.json')),
      false,
      'goal-only entry must have no spec.json file'
    );
    assert.strictEqual(entry.specJson, null, 'readQueueEntry must report specJson: null for a goal-only entry');

    assert.ok(fs.existsSync(decoyMd), 'unrelated root spec.md must not be unlinked in goal-only mode');
    assert.ok(fs.existsSync(decoyJson), 'unrelated root spec.json must not be unlinked in goal-only mode');
  } finally {
    cleanup(tmpDir);
  }
});

// ── TC4a: dryRunValidate bare .md → UncheckableSpecError before planning ───

await test('TC4a: dryRunValidate on a bare .md throws UncheckableSpecError before planGlobal; nothing queued', async () => {
  const { tmpDir, specPath, pipeline, getPlanGlobalCallCount } = makeDryRunPipeline({});
  try {
    let thrown = null;
    try {
      await pipeline.dryRunValidate('Implement bare spec', { prdPath: specPath });
    } catch (err) {
      thrown = err;
    }

    assert.ok(
      thrown instanceof UncheckableSpecError,
      `expected UncheckableSpecError, got ${thrown ? thrown.name + ': ' + thrown.message : 'no throw (dryRunValidate completed)'}`
    );
    assert.strictEqual(
      getPlanGlobalCallCount(),
      0,
      'the gate must fire BEFORE planGlobal (no LLM spend on an uncheckable spec)'
    );

    const queueDir = path.join(tmpDir, 'queue');
    const queued = fs.existsSync(queueDir)
      ? fs.readdirSync(queueDir).filter((s) => {
          try { return fs.statSync(path.join(queueDir, s)).isDirectory(); } catch { return false; }
        })
      : [];
    assert.strictEqual(queued.length, 0, 'no queue entry may be created when the gate throws');
  } finally {
    cleanup(tmpDir);
  }
});

// ── TC4b: dryRunValidate bare .md + allowIncompleteScope → proceeds ────────

await test('TC4b: dryRunValidate on a bare .md with allowIncompleteScope proceeds and queues (no spec.json in entry)', async () => {
  const { tmpDir, specPath, pipeline, getPlanGlobalCallCount } = makeDryRunPipeline({
    allowIncompleteScope: true,
  });
  try {
    await pipeline.dryRunValidate('Implement bare spec', { prdPath: specPath });

    assert.strictEqual(getPlanGlobalCallCount(), 1, 'planGlobal should run under allowIncompleteScope');

    const slug = 'gated.spec';
    const entry = readQueueEntry(tmpDir, slug);
    assert.ok(entry, `queue entry '${slug}' should exist`);
    assert.strictEqual(entry.status, 'pending', 'entry should be pending');
    assert.strictEqual(
      fs.existsSync(path.join(tmpDir, 'queue', slug, 'spec.json')),
      false,
      'a bare-.md spec has no sibling json — the entry must not contain spec.json'
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ── TC4c: batchResume json-less entries → failed-validation, no execution ──

await test('TC4c: batchResume marks json-less pending entries failed-validation, executes nothing, continues the batch, no forensic archive', async () => {
  const root = makeTmpRoot('cc-orch-specjson-batch-');
  try {
    createQueueEntry(root, 'gateless-a', { validatedAt: '2026-06-01T00:00:00.000Z' });
    await new Promise((r) => setTimeout(r, 20));
    createQueueEntry(root, 'gateless-b', { validatedAt: '2026-06-02T00:00:00.000Z' });

    const { pipeline, archiveCalls, getExecuteCount } = makeBatchPipeline(root);

    const result = await pipeline.batchResume({});

    assert.strictEqual(getExecuteCount(), 0,
      `_executeAllMilestones must NOT run for json-less entries (got ${getExecuteCount()} call(s))`);
    assert.strictEqual(result.archived, 0, `expected archived:0, got ${result.archived}`);
    assert.strictEqual(result.failed, 2,
      `expected failed:2 (batch must CONTINUE past the first gate failure), got ${result.failed}`);

    for (const slug of ['gateless-a', 'gateless-b']) {
      const entry = readQueueEntry(root, slug);
      assert.ok(entry, `entry '${slug}' must still exist (validation failure keeps the entry)`);
      assert.strictEqual(
        entry.status,
        'failed-validation',
        `entry '${slug}' expected status 'failed-validation', got '${entry.status}'`
      );
      assert.ok(
        fs.existsSync(path.join(root, 'queue', slug, 'spec.md')),
        `entry '${slug}' spec.md must be preserved`
      );
    }

    // Validation failure, not execution failure: no archive() of any kind —
    // in particular no forensic ({'include-failed': true}) archive.
    const forensic = archiveCalls.filter((c) => c.opts && c.opts['include-failed']);
    assert.strictEqual(forensic.length, 0,
      `no forensic archive may be produced for a gate failure (got ${forensic.length})`);
    assert.strictEqual(archiveCalls.length, 0,
      `archive() must not be called at all when every entry fails the gate (got ${archiveCalls.length} call(s))`);
  } finally {
    cleanup(root);
  }
});

// ── TC4d: batchResume json-less entry + allowIncompleteScope → proceeds ────

await test('TC4d: batchResume with allowIncompleteScope lets a json-less entry proceed to execution', async () => {
  const root = makeTmpRoot('cc-orch-specjson-batch-');
  try {
    createQueueEntry(root, 'inc-scope');

    const { pipeline, getExecuteCount, getReviewCount } = makeBatchPipeline(root, {
      allowIncompleteScope: true,
    });

    const result = await pipeline.batchResume({});

    assert.strictEqual(getExecuteCount(), 1,
      `_executeAllMilestones should run once under allowIncompleteScope (got ${getExecuteCount()})`);
    assert.strictEqual(getReviewCount(), 1, '_reviewGate should run once');
    assert.strictEqual(result.archived, 1, `expected archived:1, got ${result.archived}`);
    assert.strictEqual(result.failed, 0, `expected failed:0, got ${result.failed}`);
    assert.ok(
      !fs.existsSync(path.join(root, 'queue', 'inc-scope')),
      'entry should be removed after a successful run'
    );
  } finally {
    cleanup(root);
  }
});

// ── TC4e: resume() bare .md → UncheckableSpecError before milestones ───────

await test('TC4e: resume() with a bare-.md prdPath throws UncheckableSpecError before executing any milestone', async () => {
  const { root, pipeline, getMilestoneCallCount } = makeResumeFixture();
  try {
    let thrown = null;
    try {
      await pipeline.resume();
    } catch (err) {
      thrown = err;
    }

    assert.ok(
      thrown instanceof UncheckableSpecError,
      `expected UncheckableSpecError from resume(), got ${thrown ? thrown.name + ': ' + thrown.message : 'no throw (resume completed)'}`
    );
    assert.strictEqual(
      getMilestoneCallCount(),
      0,
      'no milestone may execute when the gate throws'
    );
  } finally {
    cleanup(root);
  }
});

// ── TC4f: resume() bare .md + allowIncompleteScope → executes ──────────────

await test('TC4f: resume() with a bare-.md prdPath and allowIncompleteScope executes milestones', async () => {
  const { root, pipeline, getMilestoneCallCount } = makeResumeFixture({
    allowIncompleteScope: true,
  });
  try {
    await pipeline.resume();
    assert.strictEqual(
      getMilestoneCallCount(),
      1,
      `expected the pending milestone to execute under allowIncompleteScope (got ${getMilestoneCallCount()})`
    );
  } finally {
    cleanup(root);
  }
});

// ── TC5: batch cache hygiene — no cross-entry spec.json bleed ──────────────

await test('TC5: two batch entries with different spec.json values — each execution sees its OWN goal/criteria/constraints/target_files', async () => {
  const root = makeTmpRoot('cc-orch-specjson-batch-');
  try {
    const specJsonOne = JSON.stringify({
      goal: 'GOAL-ONE',
      acceptance_criteria: [{ description: 'AC-ONE', verification: { kind: 'command', command: 'node one.js' } }],
      constraints: ['CON-ONE'],
      target_files: ['src/one.js'],
    });
    const specJsonTwo = JSON.stringify({
      goal: 'GOAL-TWO',
      acceptance_criteria: [{ description: 'AC-TWO', verification: { kind: 'command', command: 'node two.js' } }],
      constraints: ['CON-TWO'],
      target_files: ['src/two.js'],
    });

    createQueueEntry(root, 'spec-one', {
      plan: makePlan({ marker: 'one' }),
      validatedAt: '2026-06-01T00:00:00.000Z',
      specJson: specJsonOne,
    });
    await new Promise((r) => setTimeout(r, 20));
    createQueueEntry(root, 'spec-two', {
      plan: makePlan({ marker: 'two' }),
      validatedAt: '2026-06-02T00:00:00.000Z',
      specJson: specJsonTwo,
    });

    const { pipeline } = makeBatchPipeline(root);

    // Capture-at-execution: the strong assertion. Whatever the spec getters
    // serve while THIS entry's milestones execute is what its executor,
    // verifier, and reviewer would see.
    const captures = [];
    pipeline._executeAllMilestones = async (plan) => {
      captures.push({
        marker: plan && plan.marker,
        goal: pipeline._getSpecGoal(),
        criteria: pipeline._getSpecAcceptanceCriteria(),
        constraints: pipeline._getSpecConstraints(),
        targetFiles: pipeline._getSpecTargetFiles(),
      });
    };

    const result = await pipeline.batchResume({});

    assert.strictEqual(result.archived, 2, `expected both entries archived, got ${JSON.stringify(result)}`);
    assert.strictEqual(captures.length, 2, `expected 2 execution captures, got ${captures.length}`);

    const byMarker = {};
    for (const c of captures) byMarker[c.marker] = c;
    assert.ok(byMarker.one, "capture for entry 'spec-one' (marker 'one') missing");
    assert.ok(byMarker.two, "capture for entry 'spec-two' (marker 'two') missing");

    assert.strictEqual(byMarker.one.goal, 'GOAL-ONE',
      `entry 1 must see its own goal (got '${byMarker.one.goal}')`);
    assert.strictEqual(byMarker.two.goal, 'GOAL-TWO',
      `entry 2 must see ITS goal, never entry 1's (got '${byMarker.two.goal}' — cache bleed if 'GOAL-ONE', stale empty if '')`);

    assert.strictEqual(byMarker.one.criteria[0]?.description, 'AC-ONE', 'entry 1 acceptance criteria');
    assert.strictEqual(byMarker.two.criteria[0]?.description, 'AC-TWO',
      "entry 2 acceptance criteria must not be entry 1's (cache reset per entry)");

    assert.deepStrictEqual(byMarker.one.constraints, ['CON-ONE'], 'entry 1 constraints');
    assert.deepStrictEqual(byMarker.two.constraints, ['CON-TWO'],
      "entry 2 constraints must not be entry 1's (cache reset per entry)");

    assert.deepStrictEqual(byMarker.one.targetFiles, ['src/one.js'], 'entry 1 target files');
    assert.deepStrictEqual(byMarker.two.targetFiles, ['src/two.js'],
      "entry 2 target files must not be entry 1's (cache reset per entry)");
  } finally {
    cleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
