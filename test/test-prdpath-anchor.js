#!/usr/bin/env node
/**
 * test-prdpath-anchor.js — Tests for Pipeline._anchorPrdPath, the pre-planning
 * state-prdPath anchor (spec: dryrun-prdpath-anchor, W1-F1).
 *
 * Bug shape: dryRunValidate/run() bootstrap ONLY when .harness/state.json is
 * absent, and dryRunValidate repoints state.projectMeta.prdPath to the queue
 * copy only AFTER planning (step 6c) — so a second invocation from the same
 * project root plans with the PREVIOUS spec's prdPath, and the planner's
 * injected specTargetFiles/specAcceptanceCriteria serve the WRONG spec.json.
 *
 * Tests:
 *   TC1  — pollution repro killed: two sequential dryRunValidate calls on the
 *          same root (state.json surviving, fresh Pipeline per call = CLI
 *          process equivalence) — the SECOND call's planGlobal receives the
 *          SECOND spec's specTargetFiles/specAcceptanceCriteria, not the first's
 *   TC2  — anchor unit: _anchorPrdPath({prdPath: specB}) persists resolved
 *          spec B into state.json AND resets all four per-spec getter caches
 *          (goal/targetFiles/constraints/acceptanceCriteria flip from A to B)
 *   TC3a — no-op: falsy opts.prdPath leaves state.json untouched (bytes+mtime)
 *   TC3b — no-op: missing .harness/state.json does not throw (and creates none)
 *   TC3c — no-op: already-equal path writes nothing (bytes+mtime unchanged)
 *   TC4  — run() entry path anchored too: same stale-state shape driven
 *          through run() (planGlobal captures then throws a sentinel) —
 *          captured context is the invoked spec's
 *
 * Run: node test/test-prdpath-anchor.js
 *
 * No live Claude sessions are spawned — all planner interactions are mocked.
 *
 * This suite is NOT a re-entrant cc-orch invocation — every fixture root is
 * an isolated fs.mkdtemp() directory. But when this file is launched from
 * inside a live cc-orch run, CC_ORCH_ACTIVE_RUN is inherited from the parent
 * process environment and would trip assertNoReentrantLiveRun's guard (and
 * skew activeHarnessDir resolution) on the freshly-built active roots these
 * fixtures construct — a false positive on the sanctioned mkdtemp pattern
 * (see reentrancy-guard.js). Clear the marker unconditionally here, mirroring
 * scripts/run-tests.js and test/test-bootstrap-run-scoped.js, so this file is
 * re-entrancy-neutral regardless of launch context.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
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

// Deliberately scope-item-free markdown (no '## Scope — in', no backticked
// paths) so the md fallback of _getSpecTargetFiles never masks the json.
const SPEC_MD = `# Test Spec

This is a test spec for the prdPath anchor.

## Goals
- Build something useful
`;

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

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-prdpath-anchor-'));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Re-keyed via activeHarnessDir(root) (run-context.js) rather than a
// hardcoded '.harness/state.json' join: it resolves to the validated
// per-run harness dir when the active-run pointer is claimed and its
// state.json exists, falling back to the flat '.harness/' root otherwise —
// mirroring exactly how Pipeline itself resolves this.harnessDir. On a root
// with no harness state at all (TC3b), the pointer is absent, so this falls
// back to the flat '.harness/state.json' path, which does not exist either —
// preserving TC3b's no-throw / creates-none semantics against the resolved
// location.
function stateJsonPath(root) {
  return path.join(activeHarnessDir(root), 'state.json');
}

function readStateJson(root) {
  return JSON.parse(fs.readFileSync(stateJsonPath(root), 'utf8'));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Per-spec discriminating fixture values. Spec "A" and spec "B" carry fully
 * distinct goal / target_files / acceptance_criteria / constraints so any
 * cross-spec bleed is observable on every one of the four getters.
 */
function specJsonFor(tag, file) {
  return JSON.stringify({
    goal: `GOAL-${tag}`,
    target_files: [file],
    acceptance_criteria: [
      { description: `CRIT-${tag}`, verification: { kind: 'command', command: `node ${file}` } },
    ],
    constraints: [`CON-${tag}`],
  }, null, 2);
}

/**
 * Write a spec pair (<base>.spec.md + sibling <base>.spec.json) at root.
 * The sibling json keeps the uncheckable-spec gate green AND carries the
 * per-spec discriminator values.
 *
 * @returns {string} absolute path to the .spec.md
 */
function writeSpecPair(root, base, tag, file) {
  const mdPath = path.join(root, `${base}.spec.md`);
  fs.writeFileSync(mdPath, SPEC_MD);
  fs.writeFileSync(mdPath.replace(/\.md$/, '.json'), specJsonFor(tag, file));
  return mdPath;
}

// ── Helper: mocked-planner pipeline on an EXISTING root ─────────────────────
// Mirrors the harness style of test/test-dry-run-queue.js / makeDryRunPipeline
// in test/test-queue-spec-json.js, but takes the root so two pipelines can
// share one root (the surviving-state.json shape the CLI produces).
//
// planGlobal captures its third arg (the planner context carrying
// specTargetFiles/specAcceptanceCriteria) into `captures`. When
// opts.planGlobalThrows is set, it throws that sentinel AFTER capturing —
// aborting run() right after planning, keeping the run()-path test cheap.

function makeMockedPipeline(root, opts = {}) {
  const logs = [];
  const captures = [];

  const pipeline = new Pipeline(root, {
    ...(opts.dryRun === false ? {} : { dryRun: true }),
    skipWorktreeCreation: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
  });

  pipeline.planner.planGlobal = async (goal, projectRoot, ctx) => {
    captures.push({ goal, ctx });
    if (opts.planGlobalThrows) throw new Error(opts.planGlobalThrows);
    return JSON.parse(JSON.stringify(cannedGlobalPlan));
  };
  pipeline.planner.planMission = async () => {
    throw new Error('planMission must NOT be called in these tests');
  };
  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => {};

  return { pipeline, logs, captures };
}

// Bare pipeline for unit-level _anchorPrdPath calls (no entry method driven,
// so no planner stubs needed).
function makeBarePipeline(root) {
  const logs = [];
  const pipeline = new Pipeline(root, {
    skipWorktreeCreation: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
  });
  return { pipeline, logs };
}

// Asserted up-front in the unit/no-op tests so a missing method fails the
// case cleanly instead of crashing the file (implementation lands in parallel).
function assertAnchorExists(pipeline) {
  assert.strictEqual(
    typeof pipeline._anchorPrdPath,
    'function',
    'Pipeline.prototype._anchorPrdPath must exist (new helper from dryrun-prdpath-anchor)'
  );
}

/**
 * Historically this built the W1-F1 stale-state shape: dry-run #1 left its
 * state.json on the shared root, and the stale prdPath polluted the second
 * invocation's planning context. Under runId isolation that pollution vector
 * is gone BY CONSTRUCTION — dry-run #1 works in its own self-cleaned
 * .harness/run-{id}/ scratch and never claims the active-run pointer, so no
 * surviving state exists for invocation #2 to inherit. The fixture now pins
 * that isolation property as its precondition, and TC1/TC4 keep asserting
 * the durable behavior: invocation #2 plans with the SECOND spec's context.
 *
 * @returns {{ root: string, specBPath: string }}
 */
async function buildPollutedRoot() {
  const root = makeTmpRoot();
  const specAPath = writeSpecPair(root, 'specA', 'A', 'src/a.js');

  const first = makeMockedPipeline(root);
  await first.pipeline.dryRunValidate('Implement spec A', { prdPath: specAPath });

  // Precondition (runId isolation, by construction): dry-run #1 leaves NO
  // resolvable state behind — its scratch run dir is self-cleaned and it
  // never claims the pointer, so activeHarnessDir falls back to the flat
  // root, where no state.json exists.
  assert.ok(
    !fs.existsSync(stateJsonPath(root)),
    `precondition: after dry-run #1 no surviving state should be resolvable from the root ` +
      `(runId isolation), but found "${stateJsonPath(root)}"`
  );

  const specBPath = writeSpecPair(root, 'specB', 'B', 'src/b.js');
  return { root, specBPath };
}

// ── TC1: pollution repro — second dry-run plans with the SECOND spec ────────

await test("TC1: second dryRunValidate on a surviving-state root injects the SECOND spec's specTargetFiles/specAcceptanceCriteria into planGlobal", async () => {
  const { root, specBPath } = await buildPollutedRoot();
  try {
    // FRESH Pipeline on the SAME root — CLI-process equivalence: each
    // `cc-orch dry-run` is a new process, but state.json survives on disk.
    const second = makeMockedPipeline(root);
    await second.pipeline.dryRunValidate('Implement spec B', { prdPath: specBPath });

    assert.strictEqual(second.captures.length, 1, 'planGlobal should be called exactly once in dry-run #2');
    const ctx = second.captures[0].ctx;

    assert.deepStrictEqual(
      ctx.specTargetFiles,
      ['src/b.js'],
      `planner must receive spec B's target_files (got ${JSON.stringify(ctx.specTargetFiles)} — ` +
        `['src/a.js'] means the W1-F1 pollution: state prdPath still on A's queue copy at planning time)`
    );
    assert.strictEqual(
      ctx.specAcceptanceCriteria?.[0]?.description,
      'CRIT-B',
      `planner must receive spec B's acceptance criteria (got ${JSON.stringify(ctx.specAcceptanceCriteria)} — ` +
        `'CRIT-A' means the W1-F1 pollution)`
    );
  } finally {
    cleanup(root);
  }
});

// ── TC2: anchor unit — persist resolved spec B + reset all four caches ──────

await test('TC2: _anchorPrdPath({prdPath: specB}) persists resolved spec B into state.json and resets all four getter caches', async () => {
  const root = makeTmpRoot();
  try {
    const specAPath = writeSpecPair(root, 'specA', 'A', 'src/a.js');
    const specBPath = writeSpecPair(root, 'specB', 'B', 'src/b.js');
    bootstrap(root, { prdPath: specAPath });

    const { pipeline } = makeBarePipeline(root);
    assertAnchorExists(pipeline);

    // Prime all four per-spec caches with A's values.
    assert.strictEqual(pipeline._getSpecGoal(), 'GOAL-A', 'precondition: goal getter serves A before the anchor');
    assert.deepStrictEqual(pipeline._getSpecTargetFiles(), ['src/a.js'], 'precondition: targetFiles getter serves A');
    assert.deepStrictEqual(pipeline._getSpecConstraints(), ['CON-A'], 'precondition: constraints getter serves A');
    assert.strictEqual(
      pipeline._getSpecAcceptanceCriteria()[0]?.description,
      'CRIT-A',
      'precondition: acceptanceCriteria getter serves A'
    );

    await pipeline._anchorPrdPath({ prdPath: specBPath });

    // Persisted: state.json on disk now carries the RESOLVED spec B path.
    const state = readStateJson(root);
    assert.strictEqual(
      state.projectMeta?.prdPath,
      path.resolve(specBPath),
      `state.json prdPath must be rewritten to path.resolve(specB) (got "${state.projectMeta?.prdPath}")`
    );

    // Cache reset proof: every one of the four getters now serves B.
    assert.strictEqual(pipeline._getSpecGoal(), 'GOAL-B', '_specGoalCache must be reset (goal still A = stale cache)');
    assert.deepStrictEqual(pipeline._getSpecTargetFiles(), ['src/b.js'], '_specTargetFilesCache must be reset');
    assert.deepStrictEqual(pipeline._getSpecConstraints(), ['CON-B'], '_specConstraintsCache must be reset');
    assert.strictEqual(
      pipeline._getSpecAcceptanceCriteria()[0]?.description,
      'CRIT-B',
      '_specAcceptanceCriteriaCache must be reset'
    );
  } finally {
    cleanup(root);
  }
});

// ── TC3a: no-op — falsy opts.prdPath leaves state.json untouched ────────────

await test('TC3a: _anchorPrdPath with falsy prdPath leaves state.json untouched (bytes + mtime)', async () => {
  const root = makeTmpRoot();
  try {
    const specAPath = writeSpecPair(root, 'specA', 'A', 'src/a.js');
    bootstrap(root, { prdPath: specAPath });

    const { pipeline } = makeBarePipeline(root);
    assertAnchorExists(pipeline);

    const bytesBefore = fs.readFileSync(stateJsonPath(root), 'utf8');
    const mtimeBefore = fs.statSync(stateJsonPath(root)).mtimeMs;
    await sleep(20); // ensure any rewrite would move mtime

    await pipeline._anchorPrdPath({});
    await pipeline._anchorPrdPath({ prdPath: null });

    assert.strictEqual(
      fs.readFileSync(stateJsonPath(root), 'utf8'),
      bytesBefore,
      'state.json content must be byte-identical after falsy-prdPath calls (goal-only mode keeps current behavior)'
    );
    assert.strictEqual(
      fs.statSync(stateJsonPath(root)).mtimeMs,
      mtimeBefore,
      'state.json must not be rewritten at all on a falsy prdPath (mtime moved = needless write)'
    );
  } finally {
    cleanup(root);
  }
});

// ── TC3b: no-op — missing state.json does not throw ─────────────────────────

await test('TC3b: _anchorPrdPath on a root with NO .harness/state.json does not throw (and creates none)', async () => {
  const root = makeTmpRoot();
  try {
    const specBPath = writeSpecPair(root, 'specB', 'B', 'src/b.js');

    const { pipeline } = makeBarePipeline(root);
    assertAnchorExists(pipeline);

    // Must not throw — fresh-bootstrap case is handled by bootstrap itself.
    await pipeline._anchorPrdPath({ prdPath: specBPath });

    assert.strictEqual(
      fs.existsSync(stateJsonPath(root)),
      false,
      '_anchorPrdPath must be a pure no-op when state.json is absent (it may not create one)'
    );
  } finally {
    cleanup(root);
  }
});

// ── TC3c: no-op — already-equal path writes nothing ─────────────────────────

await test('TC3c: _anchorPrdPath with a path equal to state prdPath writes nothing (bytes + mtime unchanged)', async () => {
  const root = makeTmpRoot();
  try {
    const specAPath = writeSpecPair(root, 'specA', 'A', 'src/a.js');
    bootstrap(root, { prdPath: specAPath });

    const { pipeline } = makeBarePipeline(root);
    assertAnchorExists(pipeline);

    const bytesBefore = fs.readFileSync(stateJsonPath(root), 'utf8');
    const mtimeBefore = fs.statSync(stateJsonPath(root)).mtimeMs;
    await sleep(20); // ensure any rewrite would move mtime

    await pipeline._anchorPrdPath({ prdPath: specAPath });

    assert.strictEqual(
      fs.readFileSync(stateJsonPath(root), 'utf8'),
      bytesBefore,
      'state.json content must be byte-identical after an equal-path call (silent no-op)'
    );
    assert.strictEqual(
      fs.statSync(stateJsonPath(root)).mtimeMs,
      mtimeBefore,
      'equal paths must write NOTHING (mtime moved = a redundant rewrite happened)'
    );
  } finally {
    cleanup(root);
  }
});

// ── TC4: run() entry path anchored too ──────────────────────────────────────

await test("TC4: run() on a surviving-state root injects the invoked spec's context into planGlobal (same anchor, second entry path)", async () => {
  const { root, specBPath } = await buildPollutedRoot();
  const SENTINEL = 'TC4-sentinel: abort run() right after planGlobal';
  try {
    // Fresh Pipeline driving run() — planGlobal captures its context and then
    // throws the sentinel, aborting run() before execution (keeps it cheap).
    const second = makeMockedPipeline(root, { dryRun: false, planGlobalThrows: SENTINEL });

    let caught = null;
    try {
      await second.pipeline.run('Implement spec B via run()', { prdPath: specBPath });
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught && caught.message === SENTINEL,
      `run() must reach planGlobal and surface the sentinel (got ${caught ? `"${caught.message}"` : 'no throw'})`
    );

    assert.strictEqual(second.captures.length, 1, 'planGlobal should be called exactly once by run()');
    const ctx = second.captures[0].ctx;

    assert.deepStrictEqual(
      ctx.specTargetFiles,
      ['src/b.js'],
      `run()'s planner must receive spec B's target_files (got ${JSON.stringify(ctx.specTargetFiles)} — ` +
        `['src/a.js'] means run() shares the W1-F1 stale-prdPath shape and is not anchored)`
    );
    assert.strictEqual(
      ctx.specAcceptanceCriteria?.[0]?.description,
      'CRIT-B',
      `run()'s planner must receive spec B's acceptance criteria (got ${JSON.stringify(ctx.specAcceptanceCriteria)})`
    );
  } finally {
    cleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
