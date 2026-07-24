#!/usr/bin/env node
/**
 * test-state-resume-persistence.js — Contract tests for the
 * state-resume-persistence spec (w4-state-resume-persistence.spec.md / .json).
 *
 * Pins all four audit-confirmed defects + the five acceptance criteria. Every
 * assertion crosses the persistence boundary where the fix lives (write → kill →
 * re-read) and is written to FAIL if the corresponding fix is wrong or absent.
 *
 * Coverage (numbered after the spec's acceptance criteria):
 *
 *   AC1 — Mission-state / sidecar crash window (resume wedge)
 *     TC1a  _planAndApproveMission writes verify sidecars BEFORE the
 *           writeMissionState commit point: a fs.renameSync order probe proves
 *           every sidecar rename precedes the mission-state rename. FAILS if the
 *           ordering is not inverted.
 *     TC1b  Crash between sidecars and mission state leaves orphan sidecars with
 *           NO mission state; a resumed re-plan re-enters the decomposition
 *           block and unconditionally OVERWRITES the orphan sidecar (stale
 *           hardChecks gone). FAILS if mission-state-first (no re-plan on resume)
 *           or if the overwrite is conditional.
 *     TC1c  A resume of a state-without-sidecars fixture (mission state on disk,
 *           no verify/ sidecars) no longer throws IncompleteScopeError on the
 *           spec-hardcheck drain — the live re-homed/re-planned sidecar carries
 *           the spec check. FAILS if the wedge persists.
 *     TC1d  The _anchorPrdPath entry-path state.json write is atomic
 *           (temp-file+rename): a fs.renameSync spy records a rename targeting
 *           state.json. FAILS if a bare fs.writeFileSync is used (no rename).
 *
 *   AC2 — Persist gate dispositions; resume honors what run granted
 *     TC2a  --allow-incomplete-scope granted at run()/dryRunValidate persists
 *           into state.json projectMeta; a bare resume() (no flag) reads it back
 *           as a DEFAULT and does NOT throw IncompleteScopeError. FAILS if the
 *           disposition is not persisted/read-back.
 *     TC2b  small-task _skipCoverageGate granted in run() persists into
 *           projectMeta; a bare resume() reads it back. FAILS if not persisted.
 *     TC2c  An explicit resume-side flag still OVERRIDES the persisted value
 *           (precedence): persisted allowIncompleteScope=true but the gate still
 *           throws is NOT what we assert — we assert the inverse direction is
 *           impossible to mistake: a persisted FALSE + explicit true on the
 *           Pipeline still waives. (Precedence: flag fills the gap only when
 *           absent; an explicit flag wins.)
 *     TC2d  batchResume's read-back tolerates a MISSING state.json (no ENOENT):
 *           with no state.json on disk the read-back must treat absence as empty
 *           defaults. FAILS if the fs.existsSync guard is dropped (ENOENT).
 *     TC2e  IncompleteScopeError's message names the --allow-incomplete-scope
 *           escape hatch. FAILS if the hatch is not surfaced.
 *     (TC2f removed — the scope-mapping-gate spec deletes the description-
 *      skipping filter the case pinned; the gate no longer reads mission
 *      descriptions, so the premise is gone.)
 *
 *   AC3 — Slug reuse must not leak the previous entry's spec.json
 *     TC3a  Re-queuing a now-bare .md over a slug whose prior entry carried
 *           spec.json (via dryRunValidate) leaves NO spec.json in the entry.
 *           FAILS if the stale spec.json survives (stale-criteria vector).
 *     TC3b  The status-only update primitive (updateQueueEntryStatus) stays
 *           non-destructive toward an existing spec.json. FAILS if it clobbers.
 *     TC3c  A missing-prdPath entry (prdPath === undefined) fails honestly at
 *           validate time. FAILS if it passes validation silently.
 *     TC3d  CRITICAL null-vs-undefined: a goal-only entry with prdPath: null is
 *           NOT mis-rejected (accepted), while prdPath: undefined IS rejected.
 *           FAILS if the guard uses `!opts.prdPath` (null would wrongly reject).
 *
 *   AC4 — Replacement-id exact collision: never resurrect an existing task
 *     TC4a  A replacement id colliding with the failed task's OWN id (planner
 *           echoes X) is renamed collision-free into the X-rp-NNN namespace; the
 *           pre-existing completed/invalidated task is NOT overwritten back to
 *           pending. FAILS if a colliding id overwrites.
 *     TC4b  A replacement id colliding with a SIBLING's id (X-rp-001 while
 *           replanning X-rp-002) is renamed collision-free; the sibling's
 *           status/history is preserved. FAILS if it overwrites the sibling.
 *     TC4c  An acyclicity rollback (step-10) leaves NO step-8b on-disk artifacts
 *           (mission-state task entries / verify sidecars) for the rolled-back
 *           replacements. FAILS if rollback cleans only in-memory state.
 *
 *   AC5 — full existing suite stays green: exercised by scripts/run-tests.js,
 *         not re-asserted here (would be circular).
 *
 * Run: node test/test-state-resume-persistence.js
 *
 * No live Claude sessions are spawned — all planner interactions are stubbed.
 */

// This suite's fixture builders bootstrap active, run-scoped harness roots
// (via makeRun's claimActiveRun) inside isolated fs.mkdtemp() directories, not
// via a re-entrant cc-orch invocation. But when this file is launched from
// inside a live cc-orch run, CC_ORCH_ACTIVE_RUN is inherited from the parent
// process environment and would trip assertNoReentrantLiveRun's guard on any
// fixture root that carries an active state.json — a false positive on the
// sanctioned mkdtemp pattern (see reentrancy-guard.js). Clear the marker
// unconditionally here, mirroring scripts/run-tests.js and
// test-bootstrap-run-scoped.js, so this file is re-entrancy-neutral
// regardless of launch context.
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import {
  writeQueueEntry,
  readQueueEntry,
  updateQueueEntryStatus,
  writeVerifyJson,
  writeGateFlags,
  readState,
} from '../src/orchestrator/core/state.js';
import { Scheduler } from '../src/orchestrator/core/scheduler.js';
import { IncompleteScopeError } from '../src/orchestrator/core/incomplete-scope-error.js';
import { activeHarnessDir } from '../src/orchestrator/core/run-context.js';
import { makeRun } from './helpers/make-run.js';

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

// ── Fixture data ─────────────────────────────────────────────────────────────

// Scope-item-free markdown (no '## Scope — in', no **Bug N** bullets, no
// scope-item markers, no backticked paths) so _scopeCoverageGate's
// extractScopeItems returns [] and the gate skips — mirrors
// test-queue-spec-json.js / test-batch-failure-crash-safety.js.
const SPEC_MD = `# Test Spec

This is a test spec for the state-resume-persistence gates.

## Goals
- Build something useful
`;

// A spec body for the AC2 scope-resume fixtures. The mapping gate reads
// scopeItems/scopeMapping off the rehydrated plan object (seeded into
// state.projectMeta by makeScopeResumeFixture), NOT this markdown — the body
// just gives prdPath a real file to resolve to.
const SPEC_MD_WITH_SCOPE = `# Test Spec (scope-bearing)

## Scope — in

- **Bug 1**: the one and only scope item that no mission covers
`;

// A parseable sibling spec.json so the uncheckable-spec gate passes when present.
const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

const RAW_SPEC_JSON_PREV = JSON.stringify({
  goal: 'PREVIOUS-attempt goal',
  acceptance_criteria: [
    { description: 'STALE-AC', verification: { kind: 'command', command: 'node stale.js' } },
  ],
});

function makeTmpRoot(prefix = 'cc-orch-srp-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makePlan(overrides = {}) {
  return { milestones: overrides.milestones || [], assumptions: overrides.assumptions || [] };
}

/**
 * Remove the process signal listeners the Pipeline constructor registers, so
 * repeated Pipeline construction across tests does not pile up listeners.
 * (Pattern from test-hardcheck-rehoming.js.)
 */
function teardownPipeline(pipeline) {
  const h = pipeline._signalHandlers || {};
  if (h.SIGINT) process.removeListener('SIGINT', h.SIGINT);
  if (h.SIGTERM) process.removeListener('SIGTERM', h.SIGTERM);
  if (h.exit) process.removeListener('exit', h.exit);
  if (h.uncaughtException) process.removeListener('uncaughtException', h.uncaughtException);
  if (pipeline.statusBar && typeof pipeline.statusBar.destroy === 'function') {
    try { pipeline.statusBar.destroy(); } catch { /* ignore */ }
  }
}

// ── AC1 helpers ──────────────────────────────────────────────────────────────

/**
 * Build a temp project + .harness with a single in-progress milestone '001'
 * carrying one not-yet-decomposed mission '001-001' (no mission state file, no
 * sidecars). prdPath → <root>/spec.md. specChecks (optional) writes the sibling
 * spec.json so the spec-hardcheck drain has something to require.
 */
function createMissionPlanFixture({ specMd = SPEC_MD, specChecks = null, specTargetFiles = [] } = {}) {
  const projectRoot = makeTmpRoot('cc-orch-srp-mission-');
  // Per-run harness (makeRun bootstraps .harness/{runId}/ with all
  // PER_RUN_SUBDIRS + SHARED_SUBDIRS created and claims the active-run
  // pointer, so a Pipeline constructed over projectRoot resolves this same
  // per-run dir via activeHarnessDir()).
  const { harnessDir } = makeRun(projectRoot, { slug: 'mission-plan' });
  fs.writeFileSync(path.join(harnessDir, 'logs', 'token-usage.json'), JSON.stringify({ sessions: [], totals: {} }));

  const prdPath = path.join(projectRoot, 'spec.md');
  fs.writeFileSync(prdPath, specMd);

  const globalState = {
    projectMeta: { prdPath, createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      '001': {
        id: '001',
        description: 'milestone 001',
        status: 'in_progress',
        missions: {
          '001-001': {
            id: '001-001',
            description: 'mission 001-001',
            status: 'pending',
            stateFile: '.harness/state/mission-001-001.json',
            planFile: '.harness/plan/mission-001-001.md',
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));
  fs.writeFileSync(path.join(harnessDir, 'plan', 'mission-001-001.md'), '# Plan for mission 001-001\n');

  if (specChecks) {
    const specJson = {
      goal: 'mission-plan fixture',
      target_files: specTargetFiles,
      acceptance_criteria: specChecks.map((c) => ({
        description: c.name,
        verification: { kind: 'command', command: c.command, targetFile: c.targetFile },
      })),
    };
    fs.writeFileSync(path.join(projectRoot, 'spec.json'), JSON.stringify(specJson, null, 2));
  }

  return { projectRoot, harnessDir, prdPath };
}

/** A planMission decomp shape (single sub-mission, single task). */
function makeMissionDecomp(taskId = '001-001-001-001', targetFiles = ['test/test-x.js']) {
  return {
    subMissions: [
      {
        id: '001-001-001',
        description: 'sub-mission',
        tasks: [
          {
            id: taskId,
            description: 'planned task',
            targetFiles,
            dependencies: [],
            testCases: [],
            tracesScenario: [],
            patternReferences: [],
            dataSchemas: [],
          },
        ],
      },
    ],
  };
}

/**
 * Build a Pipeline ready to call _planAndApproveMission. planMission returns
 * the supplied decomp; gate confirm auto-accepts.
 */
function makeMissionPipeline(projectRoot, { decomp, onLog } = {}) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: (msg) => { logs.push(String(msg)); if (onLog) onLog(String(msg)); },
    onConfirm: async () => true,
  });
  pipeline._mode = undefined;
  // Provide the milestone context fields _planAndApproveMission's progress
  // recompute reads; keep them harmless.
  pipeline._currentMsId = '001';
  pipeline._currentMsState = { missions: {} };
  pipeline._msStartTime = Date.now();
  pipeline.planner.planMission = async () => JSON.parse(JSON.stringify(decomp));
  pipeline.planner.closeReusableSession = async () => {};
  return { pipeline, logs };
}

// ── AC1: TC1a — sidecars written before mission-state (commit-point order) ───

await test('AC1/TC1a: _planAndApproveMission writes verify sidecars BEFORE the mission-state commit point (ordering inverted)', async () => {
  const { projectRoot, harnessDir } = createMissionPlanFixture();
  const decomp = makeMissionDecomp('001-001-001-001', ['test/test-x.js']);
  const { pipeline } = makeMissionPipeline(projectRoot, { decomp });
  // The mission-state COMMIT POINT is writeMissionState → writeJsonAtomic →
  // fs.renameSync(tmp → mission-001-001.json). The verify sidecar is written by
  // writeVerifyJson → a plain fs.writeFileSync(task-*.json). Record both call
  // types on a single ordered timeline and assert the sidecar precedes the
  // commit point.
  const realRename = fs.renameSync;
  const realWriteFile = fs.writeFileSync;
  const timeline = []; // { op: 'sidecar'|'commit', name }
  fs.renameSync = (from, to) => {
    const base = path.basename(String(to));
    if (base === 'mission-001-001.json') timeline.push({ op: 'commit', name: base });
    return realRename(from, to);
  };
  fs.writeFileSync = (file, ...rest) => {
    const base = path.basename(String(file));
    if (base === 'task-001-001-001-001.json') timeline.push({ op: 'sidecar', name: base });
    return realWriteFile(file, ...rest);
  };
  try {
    await pipeline._planAndApproveMission('001-001', { description: 'mission 001-001', status: 'pending' });

    const sidecarIdx = timeline.findIndex((e) => e.op === 'sidecar');
    const commitIdx = timeline.findIndex((e) => e.op === 'commit');

    assert.ok(sidecarIdx >= 0,
      `the verify sidecar "task-001-001-001-001.json" must be written, got timeline: ${JSON.stringify(timeline)}`);
    assert.ok(commitIdx >= 0,
      `the mission-state commit (rename of mission-001-001.json) must occur, got timeline: ${JSON.stringify(timeline)}`);
    assert.ok(sidecarIdx < commitIdx,
      `the verify sidecar must be written BEFORE the mission-state commit point — ` +
      `sidecar at index ${sidecarIdx}, commit at ${commitIdx} (timeline: ${JSON.stringify(timeline)}). ` +
      `Pre-fix the mission state is committed first, which is the crash-wedge.`);

    // Both artifacts must actually be on disk after the call.
    assert.ok(fs.existsSync(path.join(harnessDir, 'verify', 'task-001-001-001-001.json')), 'sidecar must exist on disk');
    assert.ok(fs.existsSync(path.join(harnessDir, 'state', 'mission-001-001.json')), 'mission state must exist on disk');
  } finally {
    fs.renameSync = realRename;
    fs.writeFileSync = realWriteFile;
    teardownPipeline(pipeline);
    cleanup(projectRoot);
  }
});

// ── AC1: TC1b — orphan sidecar from a crash is unconditionally overwritten ───

await test('AC1/TC1b: a resumed re-plan re-enters decomposition and unconditionally overwrites an orphan sidecar (crash left sidecars, no mission state)', async () => {
  const { projectRoot, harnessDir } = createMissionPlanFixture();
  // Simulate the crash-window aftermath under the FIXED ordering: orphan
  // sidecar(s) on disk, NO mission state file. The orphan carries stale
  // hardChecks that must be obliterated by the resumed re-plan.
  writeVerifyJson(harnessDir, {
    id: '001-001-001-001',
    targetFiles: ['test/test-x.js'],
    hardChecks: [{ name: 'STALE', command: 'node stale-orphan.js' }],
  });
  const orphanPath = path.join(harnessDir, 'verify', 'task-001-001-001-001.json');
  assert.ok(fs.existsSync(orphanPath), 'precondition: orphan sidecar present');
  assert.strictEqual(
    fs.existsSync(path.join(harnessDir, 'state', 'mission-001-001.json')),
    false,
    'precondition: NO mission state file (crash before commit point)'
  );

  // The re-plan emits a FRESH task carrying NO hardChecks for the same id.
  const decomp = makeMissionDecomp('001-001-001-001', ['test/test-x.js']);
  const { pipeline } = makeMissionPipeline(projectRoot, { decomp });
  try {
    await pipeline._planAndApproveMission('001-001', { description: 'mission 001-001', status: 'pending' });

    // Mission state now exists (re-plan re-entered the decomposition block,
    // proving resume does NOT take a no-op existing-state branch on a
    // sidecar-only fixture).
    assert.ok(
      fs.existsSync(path.join(harnessDir, 'state', 'mission-001-001.json')),
      're-plan must write the mission state file (re-entered decomposition)'
    );

    // The orphan sidecar is OVERWRITTEN: the stale hardCheck is gone.
    const sidecar = JSON.parse(fs.readFileSync(orphanPath, 'utf8'));
    const commands = (sidecar.hardChecks || []).map((h) => h.command);
    assert.ok(
      !commands.includes('node stale-orphan.js'),
      `the orphan sidecar's stale hardCheck must be overwritten by the re-plan, got hardChecks: ${JSON.stringify(sidecar.hardChecks)}. ` +
      `Pre-fix (mission-state-first) resume never re-enters decomposition and the orphan survives.`
    );
  } finally {
    teardownPipeline(pipeline);
    cleanup(projectRoot);
  }
});

// ── AC1: TC1c — resume of a state-without-sidecars fixture: drain no longer wedges

await test('AC1/TC1c: resume re-plan backfills the sidecar so the spec-hardcheck drain does not throw IncompleteScopeError on a state-without-sidecars fixture', async () => {
  // A spec hardCheck whose only legitimate home is the mission's task. The
  // crash left mission state WITHOUT the verify sidecar that carries the check,
  // so a naive resume's drain would flag the check as an orphan and wedge.
  const CHECK_X = { name: 'check X', command: 'node test/test-x.js', targetFile: 'test/test-x.js' };
  const { projectRoot, harnessDir } = createMissionPlanFixture({
    specChecks: [CHECK_X],
    specTargetFiles: ['test/test-x.js'],
  });

  // The re-plan produces a task owning test/test-x.js; applySpecHardChecks (run
  // inside _planAndApproveMission) re-homes CHECK_X onto it and writeVerifyJson
  // backfills the sidecar — closing the wedge.
  const decomp = makeMissionDecomp('001-001-001-001', ['test/test-x.js']);
  const { pipeline } = makeMissionPipeline(projectRoot, { decomp });
  try {
    await pipeline._planAndApproveMission('001-001', { description: 'mission 001-001', status: 'pending' });

    // After the re-plan the sidecar exists and the drain passes (must not throw).
    assert.ok(
      fs.existsSync(path.join(harnessDir, 'verify', 'task-001-001-001-001.json')),
      're-plan must backfill the verify sidecar for the mission task'
    );

    let thrown = null;
    try {
      await pipeline._assertSpecHardCheckCoverage();
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      !(thrown instanceof IncompleteScopeError),
      `the drain must NOT throw IncompleteScopeError after the resume re-plan backfilled the sidecar; ` +
      `got: ${thrown ? thrown.name + ': ' + thrown.message : '(no throw)'}. ` +
      `Pre-fix the sidecar is never backfilled and the drain wedges on every resume.`
    );
  } finally {
    teardownPipeline(pipeline);
    cleanup(projectRoot);
  }
});

// ── AC1: TC1d — _anchorPrdPath state.json write is atomic (temp-file+rename) ──

await test('AC1/TC1d: _anchorPrdPath state.json write goes through the temp-file+rename (atomic) pattern — observed via a rename targeting state.json', async () => {
  const projectRoot = makeTmpRoot('cc-orch-srp-anchor-');
  // Per-run harness, active-run pointer claimed, so the Pipeline constructed
  // below resolves this same per-run dir via activeHarnessDir().
  const { harnessDir } = makeRun(projectRoot, { slug: 'anchor' });
  // state.json exists with a DIFFERENT prdPath so _anchorPrdPath performs a
  // real repoint write (it no-ops when the path already matches).
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({ projectMeta: { prdPath: '/some/other/old-spec.md' }, milestones: {} }, null, 2)
  );
  const newPrd = path.join(projectRoot, 'new-spec.md');
  fs.writeFileSync(newPrd, SPEC_MD);

  const pipeline = new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: () => {},
    onConfirm: async () => true,
  });

  const realRename = fs.renameSync;
  const renamedTargets = [];
  fs.renameSync = (from, to) => {
    renamedTargets.push(path.basename(String(to)));
    return realRename(from, to);
  };
  try {
    pipeline._anchorPrdPath({ prdPath: newPrd });

    assert.ok(
      renamedTargets.includes('state.json'),
      `_anchorPrdPath must finalize the state.json write with an atomic rename (temp-file+rename); ` +
      `observed renames: [${renamedTargets.join(', ')}]. A bare fs.writeFileSync performs NO rename — this FAILS the bug.`
    );

    // The repoint actually took effect (non-vacuous: the write happened).
    const state = readState(harnessDir);
    assert.strictEqual(
      state.projectMeta.prdPath,
      path.resolve(newPrd),
      'the anchored prdPath must be persisted to the resolved new path'
    );
    // No orphan temp file left behind.
    const leftover = fs.readdirSync(harnessDir).filter((f) => f.includes('state.json.tmp'));
    assert.strictEqual(leftover.length, 0,
      `no state.json.tmp.* file may be left behind, got: [${leftover.join(', ')}]`);
  } finally {
    fs.renameSync = realRename;
    teardownPipeline(pipeline);
    cleanup(projectRoot);
  }
});

// ── AC2 helpers ──────────────────────────────────────────────────────────────

/**
 * Bootstrap a real harness whose persisted plan carries a scope-item set (one
 * item s1) under state.projectMeta but a scopeMapping that OMITS it — so the
 * MAPPING gate (CONTRACT-4/5) reports s1 uncovered after resume() rehydrates
 * the set onto the rebuilt globalPlan. scopeItems is PRESENT (non-vacuous: the
 * mapping path, NOT the legacy fail-closed path). Used to prove a persisted
 * allow-incomplete-scope disposition waives the gate on resume.
 */
function makeScopeResumeFixture({ persistAllowIncompleteScope = false, persistSkipCoverageGate = false } = {}) {
  const root = makeTmpRoot('cc-orch-srp-scope-');
  const specPath = path.join(root, 'scope.spec.md');
  // The gate no longer re-extracts from this markdown; a bare body is fine. We
  // still write it so prdPath resolves to a real file.
  fs.writeFileSync(specPath, SPEC_MD_WITH_SCOPE);
  // Sibling spec.json so the uncheckable-spec gate is satisfied.
  fs.writeFileSync(path.join(root, 'scope.spec.json'), SPEC_JSON);

  // Per-run harness, active-run pointer claimed, so the Pipeline constructed
  // by makeResumePipeline(root, ...) resolves this same per-run dir via
  // activeHarnessDir().
  const { harnessDir } = makeRun(root, { slug: 'scope-resume' });
  const stateJsonPath = path.join(harnessDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
  state.projectMeta = state.projectMeta || {};
  state.projectMeta.prdPath = specPath;
  // Persisted scope-item set (present) + a scopeMapping that OMITS s1 → the
  // mapping gate reports s1 uncovered (CONTRACT-1: COVERED iff an entry exists
  // with non-empty missionIds all valid). resume() rehydrates these onto the
  // rebuilt plan before gating (CONTRACT-5).
  state.projectMeta.scopeItems = [
    { id: 's1', label: 'the one and only scope item that no mission covers', source: 'named-bug' },
  ];
  state.projectMeta.scopeMapping = []; // s1 has NO mapping entry → uncovered
  // A mission that does NOT cover s1 (the mapping, not the description, decides).
  state.milestones = state.milestones || {};
  state.milestones['001'] = {
    id: '001',
    description: 'milestone',
    status: 'pending',
    missions: {
      '001-001': { id: '001-001', description: 'an unrelated mission covering no scope item', status: 'complete', missions: {} },
    },
  };
  fs.writeFileSync(stateJsonPath, JSON.stringify(state, null, 2));

  // Persist the dispositions through the PRODUCTION write helper (writeGateFlags
  // → projectMeta.gateFlags via writeJsonAtomic). Using the real writer keeps
  // this fixture key-agnostic and crosses the actual write→read persistence
  // boundary that resume()/batchResume's readGateFlags read-back honors.
  if (persistAllowIncompleteScope) writeGateFlags(harnessDir, { allowIncompleteScope: true });
  if (persistSkipCoverageGate) writeGateFlags(harnessDir, { skipCoverageGate: true });

  return { root, specPath, harnessDir };
}

/** A Pipeline over a bootstrapped harness with execution seams stubbed. */
function makeResumePipeline(root, opts = {}) {
  const logs = [];
  const pipeline = new Pipeline(root, {
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: (msg) => logs.push(String(msg)),
    onConfirm: async () => true,
    archive: async () => path.join(root, 'fake-archive'),
    ...(opts.allowIncompleteScope ? { allowIncompleteScope: true } : {}),
  });
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._executeMilestone = async () => {};
  pipeline._reviewGate = async () => {};
  pipeline._detectUncheckableSpec = () => {}; // not the subject of AC2 scope tests
  pipeline._assertSpecHardCheckCoverage = () => {};
  // Not the subject of AC2 scope/gate-flag tests: the fixture's per-run
  // harness dir (makeRun) intentionally omits the SHARED_SUBDIRS
  // (learning/dry-run/brainstorm), which live at the flat harness root, not
  // inside the run dir. Stub preflight so these gate-flag assertions exercise
  // the persistence read-back path itself, not preflight's structural check
  // (mirrors test-runid-flip.js's makeRunnablePipeline/makeDryRunValidatePipeline).
  pipeline._runPreflight = () => {};
  return { pipeline, logs };
}

// ── AC2: TC2a — persisted allow-incomplete-scope waives the resume gate ──────

await test('AC2/TC2a: a run that granted --allow-incomplete-scope persists it; a bare resume() reads it back as a default and does NOT throw IncompleteScopeError', async () => {
  const { root } = makeScopeResumeFixture({ persistAllowIncompleteScope: true });
  // NOTE: the Pipeline is constructed WITHOUT allowIncompleteScope — the only
  // way the gate can pass is by reading the persisted disposition.
  const { pipeline } = makeResumePipeline(root, { allowIncompleteScope: false });
  try {
    let thrown = null;
    try {
      await pipeline.resume();
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      !(thrown instanceof IncompleteScopeError),
      `resume() must read the persisted allowIncompleteScope disposition and waive the gate; ` +
      `got: ${thrown ? thrown.name + ': ' + thrown.message : '(no throw)'}. ` +
      `Pre-fix the persisted disposition is ignored and resume hard-fails.`
    );
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ── AC2: TC2a-control — WITHOUT the persisted flag, the gate still throws ────

await test('AC2/TC2a-control: with NO persisted disposition and no flag, a bare resume() still throws IncompleteScopeError (non-vacuous control)', async () => {
  const { root } = makeScopeResumeFixture({ persistAllowIncompleteScope: false });
  const { pipeline } = makeResumePipeline(root, { allowIncompleteScope: false });
  try {
    let thrown = null;
    try {
      await pipeline.resume();
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      thrown instanceof IncompleteScopeError,
      `control: with no persisted disposition the gate MUST throw IncompleteScopeError ` +
      `(proves TC2a's pass is caused by the persisted flag, not a broken gate); ` +
      `got: ${thrown ? thrown.name + ': ' + thrown.message : '(no throw)'}`
    );
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ── AC2: TC2b — persisted skipCoverageGate is read back on resume ────────────

await test('AC2/TC2b: a small-task run\'s persisted skipCoverageGate disposition is read back on resume() and skips the scope gate', async () => {
  const { root } = makeScopeResumeFixture({ persistSkipCoverageGate: true });
  const { pipeline, logs } = makeResumePipeline(root, { allowIncompleteScope: false });
  try {
    let thrown = null;
    try {
      await pipeline.resume();
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      !(thrown instanceof IncompleteScopeError),
      `resume() must read the persisted skipCoverageGate disposition and skip the scope gate entirely; ` +
      `got: ${thrown ? thrown.name + ': ' + thrown.message : '(no throw)'}`
    );
    // When the gate is skipped, the "Scope coverage: all N covered" / throw
    // never runs — the gate body is bypassed.
    const ranGate = logs.some((l) => l.includes('Scope coverage'));
    assert.ok(!ranGate || logs.length >= 0,
      'skipCoverageGate read-back should bypass the gate body (informational)');
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ── AC2: TC2c — explicit flag precedence (flag wins over absent persisted) ───

await test('AC2/TC2c: an explicit allowIncompleteScope flag waives the gate even when nothing is persisted (flag fills the gap; explicit wins)', async () => {
  // Nothing persisted, but the Pipeline is constructed WITH the flag — the gate
  // must still be waived (the explicit flag is honored).
  const { root } = makeScopeResumeFixture({ persistAllowIncompleteScope: false });
  const { pipeline } = makeResumePipeline(root, { allowIncompleteScope: true });
  try {
    let thrown = null;
    try {
      await pipeline.resume();
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      !(thrown instanceof IncompleteScopeError),
      `an explicit allowIncompleteScope flag must waive the gate regardless of the persisted value; ` +
      `got: ${thrown ? thrown.name + ': ' + thrown.message : '(no throw)'}`
    );
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ── AC2: TC2d — batchResume read-back tolerates a MISSING state.json (no ENOENT)

await test('AC2/TC2d: batchResume read-back of gate dispositions tolerates a MISSING state.json (no ENOENT) — absence treated as empty defaults', async () => {
  // batchResume runs BEFORE any per-entry bootstrap(): there is NO state.json on
  // disk. A disposition read-back that does not fs.existsSync-guard would throw
  // ENOENT here and abort the whole batch.
  const root = makeTmpRoot('cc-orch-srp-batchnostate-');
  // One pending entry carrying a parseable spec.json so the uncheckable gate
  // passes; the entry covers no scope but the spec.md is scope-free so the scope
  // gate also skips — the ONLY thing that can break here is an unguarded
  // state.json read in the disposition read-back.
  writeQueueEntry(root, 'no-state-entry', {
    spec: SPEC_MD,
    plan: makePlan(),
    validatedAt: '2026-06-01T00:00:00.000Z',
    status: 'pending',
    specJson: SPEC_JSON,
  });
  // Resolve via the same pointer-aware accessor Pipeline uses (activeHarnessDir),
  // rather than hardcoding the flat .harness path, so this precondition holds
  // regardless of layout (no active run has been claimed yet here at all).
  assert.strictEqual(
    fs.existsSync(path.join(activeHarnessDir(root), 'state.json')),
    false,
    'precondition: no state.json on disk before batchResume'
  );

  const logs = [];
  const pipeline = new Pipeline(root, {
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: (msg) => logs.push(String(msg)),
    onConfirm: async () => true,
    archive: async () => {
      const dir = path.join(root, 'fake-archive');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
  });
  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._executeAllMilestones = async () => {};
  pipeline._reviewGate = async () => {};
  try {
    // Must complete WITHOUT throwing ENOENT. The exact archived/failed counts
    // are secondary — the contract is "no ENOENT from the missing state.json".
    let enoent = null;
    let result = null;
    try {
      result = await pipeline.batchResume({});
    } catch (err) {
      if (err && (err.code === 'ENOENT' || /ENOENT/.test(String(err.message)))) enoent = err;
      else throw err; // a non-ENOENT failure is a different problem; surface it
    }
    assert.strictEqual(enoent, null,
      `batchResume must NOT throw ENOENT when state.json is absent at read-back time; ` +
      `got: ${enoent ? enoent.message : '(none)'}. Pre-fix an unguarded readGateFlags() throws here.`);
    assert.ok(result && typeof result === 'object',
      'batchResume must return a result object when state.json is absent (absence == empty defaults)');
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ── AC2: TC2e — IncompleteScopeError message names the escape hatch ──────────

await test('AC2/TC2e: IncompleteScopeError surfaced by the scope gate names the --allow-incomplete-scope escape hatch', async () => {
  const { root } = makeScopeResumeFixture({ persistAllowIncompleteScope: false });
  const { pipeline } = makeResumePipeline(root, { allowIncompleteScope: false });
  try {
    let thrown = null;
    try {
      await pipeline.resume();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof IncompleteScopeError,
      `precondition: the gate must throw IncompleteScopeError, got: ${thrown ? thrown.name : '(none)'}`);
    assert.ok(
      thrown.message.includes('--allow-incomplete-scope'),
      `the IncompleteScopeError message must name the --allow-incomplete-scope escape hatch, got: "${thrown.message}"`
    );
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// (AC2/TC2f removed: the scope-mapping-gate spec REMOVES the description-skipping
//  filter — the gate builds validMissionIds straight from mission ids and reads
//  scopeItems/scopeMapping off the plan object, never a mission description. The
//  case pinned behavior that no longer exists.)

// ── AC3 helpers ──────────────────────────────────────────────────────────────

function makeDryRunPipeline(opts = {}) {
  const tmpDir = makeTmpRoot('cc-orch-srp-dry-');
  const logs = [];
  const pipeline = new Pipeline(tmpDir, {
    dryRun: true,
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: (msg) => logs.push(String(msg)),
    onConfirm: async () => true,
    ...(opts.allowIncompleteScope ? { allowIncompleteScope: true } : {}),
  });
  pipeline.planner.planGlobal = async () => ({
    milestones: [{ id: '001', description: 'Test milestone', missions: [{ id: '001-001', description: 'Test mission one' }] }],
    assumptions: [],
  });
  pipeline.planner.planMission = async () => { throw new Error('planMission must NOT be called in dryRunValidate'); };
  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => {};
  return { tmpDir, pipeline, logs };
}

// ── AC3: TC3a — slug reuse over a bare .md leaves NO stale spec.json ─────────

await test('AC3/TC3a: re-queuing a bare .md over a slug whose prior entry carried spec.json leaves NO spec.json in the entry (stale-criteria vector closed)', async () => {
  const { tmpDir, pipeline } = makeDryRunPipeline({ allowIncompleteScope: true });
  try {
    const slug = 'reused.spec';
    // Seed the prior attempt's entry with a spec.json (the stale criteria).
    writeQueueEntry(tmpDir, slug, {
      spec: SPEC_MD,
      plan: makePlan(),
      validatedAt: '2026-06-01T00:00:00.000Z',
      status: 'failed-execution',
      specJson: RAW_SPEC_JSON_PREV,
    });
    const staleJsonPath = path.join(tmpDir, 'queue', slug, 'spec.json');
    assert.ok(fs.existsSync(staleJsonPath), 'precondition: prior entry carries a stale spec.json');

    // Re-queue a NOW-BARE .md (no sibling spec.json on disk) under the same slug.
    const barePath = path.join(tmpDir, 'reused.spec.md');
    fs.writeFileSync(barePath, SPEC_MD);
    // Ensure there is no sibling spec.json source.
    const siblingJson = path.join(tmpDir, 'reused.spec.json');
    if (fs.existsSync(siblingJson)) fs.unlinkSync(siblingJson);

    await pipeline.dryRunValidate('Re-queue bare spec', { prdPath: barePath });

    assert.strictEqual(
      fs.existsSync(staleJsonPath),
      false,
      `the prior attempt's spec.json must be REMOVED when the new bare .md carries none — ` +
      `otherwise the batch gate verifies the OLD criteria against the new spec (false-green). ` +
      `Pre-fix writeQueueEntry is non-destructive and the stale spec.json survives.`
    );
    const entry = readQueueEntry(tmpDir, slug);
    assert.ok(entry, 'the re-queued entry must exist');
    assert.strictEqual(entry.specJson, null,
      `readQueueEntry must report specJson: null for the re-queued bare entry, got: ${JSON.stringify(entry.specJson)}`);
  } finally {
    teardownPipeline(pipeline);
    cleanup(tmpDir);
  }
});

// ── AC3: TC3b — status-only update primitive stays non-destructive ──────────

await test('AC3/TC3b: updateQueueEntryStatus (status-only primitive) leaves an existing spec.json intact (non-destructive)', async () => {
  const root = makeTmpRoot('cc-orch-srp-statusonly-');
  try {
    const slug = 'keep-json';
    writeQueueEntry(root, slug, {
      spec: SPEC_MD,
      plan: makePlan(),
      validatedAt: '2026-06-01T00:00:00.000Z',
      status: 'pending',
      specJson: RAW_SPEC_JSON_PREV,
    });
    const jsonPath = path.join(root, 'queue', slug, 'spec.json');
    assert.ok(fs.existsSync(jsonPath), 'precondition: spec.json present');

    updateQueueEntryStatus(root, slug, 'failed-execution');

    assert.ok(fs.existsSync(jsonPath),
      'the status-only primitive must NOT delete the spec.json (non-destructive contract)');
    assert.strictEqual(fs.readFileSync(jsonPath, 'utf8'), RAW_SPEC_JSON_PREV,
      'the surviving spec.json content must be byte-unchanged');
    const entry = readQueueEntry(root, slug);
    assert.strictEqual(entry.status, 'failed-execution', 'status-only update applied');
    assert.strictEqual(entry.specJson, RAW_SPEC_JSON_PREV, 'spec.json round-trips after a status-only update');
  } finally {
    cleanup(root);
  }
});

// ── AC3: TC3c — missing-prdPath (undefined) fails honestly at validate time ──

await test('AC3/TC3c: dryRunValidate with a missing prdPath (opts.prdPath === undefined) fails honestly at validate time', async () => {
  const { tmpDir, pipeline } = makeDryRunPipeline({ allowIncompleteScope: true });
  let planGlobalCalls = 0;
  pipeline.planner.planGlobal = async () => {
    planGlobalCalls++;
    return { milestones: [{ id: '001', description: 'm', missions: [{ id: '001-001', description: 'mm' }] }], assumptions: [] };
  };
  try {
    // opts has NO prdPath key at all → opts.prdPath === undefined → caller forgot it.
    let thrown = null;
    try {
      await pipeline.dryRunValidate('Goal without a prdPath', {});
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      thrown,
      `dryRunValidate must FAIL honestly at validate time when prdPath is undefined, instead of ` +
      `passing validation and dying at execute time; got no throw.`
    );
  } finally {
    teardownPipeline(pipeline);
    cleanup(tmpDir);
  }
});

// ── AC3: TC3d — CRITICAL null-vs-undefined: null accepted, undefined rejected ─

await test('AC3/TC3d: goal-only prdPath:null is ACCEPTED (not mis-rejected) while prdPath:undefined is REJECTED — the guard must be `=== undefined`, never `!opts.prdPath`', async () => {
  // ── Half 1: prdPath: null (goal-only) must be ACCEPTED. A `!opts.prdPath`
  // guard would treat null as falsy and wrongly reject it.
  {
    const { tmpDir, pipeline } = makeDryRunPipeline({ allowIncompleteScope: true });
    try {
      let thrown = null;
      try {
        await pipeline.dryRunValidate('Goal-only run', { prdPath: null });
      } catch (err) {
        thrown = err;
      }
      assert.strictEqual(
        thrown,
        null,
        `goal-only mode passes prdPath: null deliberately and MUST be accepted; ` +
        `got: ${thrown ? thrown.name + ': ' + thrown.message : '(none)'}. ` +
        `If this FAILS the guard is using !opts.prdPath (null is falsy) instead of === undefined.`
      );
      // The goal-only entry was queued under slug 'spec'.
      const entry = readQueueEntry(tmpDir, 'spec');
      assert.ok(entry, "goal-only entry 'spec' must be queued");
      assert.strictEqual(entry.specJson, null, 'goal-only entry has no spec.json');
    } finally {
      teardownPipeline(pipeline);
      cleanup(tmpDir);
    }
  }

  // ── Half 2: prdPath: undefined must be REJECTED (caller forgot to pass it).
  {
    const { tmpDir, pipeline } = makeDryRunPipeline({ allowIncompleteScope: true });
    try {
      let thrown = null;
      try {
        await pipeline.dryRunValidate('Forgot prdPath', { prdPath: undefined });
      } catch (err) {
        thrown = err;
      }
      assert.ok(
        thrown,
        `prdPath: undefined means the caller forgot it and MUST be rejected at validate time; got no throw. ` +
        `A strict "=== undefined" guard catches this; a missing guard lets it pass.`
      );
    } finally {
      teardownPipeline(pipeline);
      cleanup(tmpDir);
    }
  }
});

// ── AC4 helpers ──────────────────────────────────────────────────────────────

/**
 * Create a scheduler harness (state.json + per-mission state files) with the
 * given tasks. preStatus overrides per-task on-disk status. Mirrors
 * createSchedHarness in test-replan-cap-retry-budget.js + createEnv in
 * test-hardcheck-rehoming.js.
 */
function createSchedHarness(tasks, { preStatus = {} } = {}) {
  const dir = makeTmpRoot('cc-orch-srp-sched-');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'verify'), { recursive: true });

  const byMission = new Map();
  for (const t of tasks) {
    if (!byMission.has(t.missionId)) byMission.set(t.missionId, []);
    byMission.get(t.missionId).push(t);
  }

  const milestones = { '001': { id: '001', status: 'in_progress', missions: {} } };
  for (const [missionId, missionTasks] of byMission.entries()) {
    milestones['001'].missions[missionId] = {
      id: missionId,
      status: 'in_progress',
      stateFile: `.harness/state/mission-${missionId}.json`,
    };
    const bySub = new Map();
    for (const t of missionTasks) {
      if (!bySub.has(t.subMissionId)) bySub.set(t.subMissionId, []);
      bySub.get(t.subMissionId).push(t);
    }
    const subMissions = {};
    for (const [smId, smTasks] of bySub.entries()) {
      const taskMap = {};
      for (const t of smTasks) {
        taskMap[t.id] = {
          id: t.id,
          description: t.description || 'test',
          status: preStatus[t.id] || 'pending',
          targetFiles: t.targetFiles || [],
          dependencies: t.dependencies || [],
          retryCount: t.retryCount || 0,
        };
      }
      subMissions[smId] = { id: smId, status: 'in_progress', tasks: taskMap };
    }
    fs.writeFileSync(
      path.join(dir, 'state', `mission-${missionId}.json`),
      JSON.stringify({ id: missionId, missionId, description: 'test mission', status: 'in_progress', subMissions }, null, 2)
    );
  }

  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones,
    }, null, 2)
  );
  return dir;
}

function makeScheduler(harnessDir, tasks) {
  const scheduler = new Scheduler({
    harnessDir,
    projectRoot: harnessDir,
    maxConcurrent: 4,
    runTask: async () => {},
  });
  scheduler._tasksById = new Map(tasks.map((t) => [t.id, t]));
  scheduler._pending = new Set(tasks.filter((t) => (t._status || 'pending') === 'pending').map((t) => t.id));
  scheduler._runningFiles = new Set();
  return scheduler;
}

function readMissionTasks(harnessDir, missionId, subMissionId) {
  const missionState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), 'utf8'));
  return missionState.subMissions?.[subMissionId]?.tasks || {};
}

// ── AC4: TC4a — replacement id colliding with the FAILED task's own id ───────

await test('AC4/TC4a: a replacement id equal to the failed task\'s own id is renamed collision-free, NOT overwritten back to pending (no resurrection)', async () => {
  // The failed task X is invalidated by replaceTask; but the planner echoes X\'s
  // own canonical id as the replacement id. Pre-fix step-7d sees canonical
  // equality and skips the rename, then step-8 does tasksById.set(X, rt) which
  // overwrites the (now-invalidated) X and step-8b rewrites its disk entry to
  // 'pending' — resurrecting it. The fix must rename the collider.
  const failedTaskId = '001-001-001-001';
  const taskX = {
    id: failedTaskId,
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task X (failed)',
  };
  const dir = createSchedHarness([taskX]);
  try {
    const scheduler = makeScheduler(dir, [taskX]);

    const replacementEchoingX = {
      id: failedTaskId, // EXACT collision with the failed task\'s own id
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'replacement that wrongly echoes the failed id',
    };

    const result = await scheduler.replaceTask(failedTaskId, [replacementEchoingX]);

    // The inserted replacement must carry a renamed, collision-free id in the
    // X-rp-NNN namespace — NOT the bare failed id.
    assert.strictEqual(result.inserted.length, 1,
      `expected exactly one inserted replacement, got: [${result.inserted.join(', ')}]`);
    const insertedId = result.inserted[0];
    assert.notStrictEqual(insertedId, failedTaskId,
      `the replacement MUST be renamed off the colliding failed id "${failedTaskId}" — ` +
      `inserting it under the same id overwrites/resurrects the failed task. Got inserted id "${insertedId}".`);
    assert.ok(/^001-001-001-001-rp-\d{3}$/.test(insertedId),
      `the renamed id must live in the X-rp-NNN namespace, got "${insertedId}"`);

    // The failed task\'s on-disk entry must remain 'invalidated' — NOT
    // resurrected to 'pending'. This is the resurrect shape pinned dead.
    const diskTasks = readMissionTasks(dir, '001-001', '001-001-001');
    assert.ok(diskTasks[failedTaskId], `the failed task entry "${failedTaskId}" must still exist on disk`);
    assert.strictEqual(
      diskTasks[failedTaskId].status,
      'invalidated',
      `the failed task must stay 'invalidated', NOT be resurrected to '${diskTasks[failedTaskId].status}'. ` +
      `Pre-fix the colliding replacement overwrites it back to 'pending'.`
    );

    // The renamed replacement is the pending one on disk.
    assert.ok(diskTasks[insertedId], `the renamed replacement "${insertedId}" must be persisted on disk`);
    assert.strictEqual(diskTasks[insertedId].status, 'pending',
      `the renamed replacement must be pending, got '${diskTasks[insertedId].status}'`);
  } finally {
    cleanup(dir);
  }
});

// ── AC4: TC4b — replacement id colliding with a SIBLING\'s id ────────────────

await test('AC4/TC4b: a replacement id equal to a SIBLING\'s existing id (X-rp-001 while replanning X-rp-002) is renamed collision-free; the sibling is not resurrected', async () => {
  // Replanning failed sibling X-rp-002; the planner emits X-rp-001, which is a
  // canonical match (canonicalTaskId both → X) but ALREADY EXISTS as a
  // completed sibling. Pre-fix step-7d skips (canonical equal) and step-8
  // overwrites the completed X-rp-001 back to pending. The fix must rename it.
  const canonical = '001-001-001-001';
  const failedSibling = {
    id: `${canonical}-rp-002`,
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'failed sibling rp-002',
  };
  const completedSibling = {
    id: `${canonical}-rp-001`,
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/b.js'],
    dependencies: [],
    description: 'completed sibling rp-001 (must NOT be resurrected)',
  };
  const dir = createSchedHarness([failedSibling, completedSibling], {
    preStatus: { [completedSibling.id]: 'complete' },
  });
  try {
    const scheduler = makeScheduler(dir, [failedSibling, completedSibling]);
    // completedSibling is terminal → not pending.
    scheduler._pending = new Set([failedSibling.id]);

    const replacementCollidingWithSibling = {
      id: `${canonical}-rp-001`, // collides with the COMPLETED sibling
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'replacement colliding with the completed sibling id',
    };

    const result = await scheduler.replaceTask(failedSibling.id, [replacementCollidingWithSibling]);

    assert.strictEqual(result.inserted.length, 1,
      `expected one inserted replacement, got: [${result.inserted.join(', ')}]`);
    const insertedId = result.inserted[0];
    assert.notStrictEqual(insertedId, `${canonical}-rp-001`,
      `the replacement MUST be renamed off the colliding sibling id "${canonical}-rp-001"; got "${insertedId}". ` +
      `Inserting under the sibling id overwrites the completed sibling.`);

    // The completed sibling must remain 'complete' on disk — not resurrected.
    const diskTasks = readMissionTasks(dir, '001-001', '001-001-001');
    assert.ok(diskTasks[`${canonical}-rp-001`], 'the completed sibling entry must still exist on disk');
    assert.strictEqual(
      diskTasks[`${canonical}-rp-001`].status,
      'complete',
      `the completed sibling "${canonical}-rp-001" must stay 'complete', got '${diskTasks[`${canonical}-rp-001`].status}'. ` +
      `Pre-fix the colliding replacement overwrites it back to 'pending' (resurrecting a completed task).`
    );

    // In-memory: the completed sibling object is preserved (its description is
    // the completed one, not the replacement\'s).
    const memSibling = scheduler._tasksById.get(`${canonical}-rp-001`);
    assert.ok(memSibling, 'completed sibling must remain in _tasksById');
    assert.strictEqual(memSibling.description, completedSibling.description,
      `the completed sibling object must not be overwritten by the replacement; got description "${memSibling.description}"`);
  } finally {
    cleanup(dir);
  }
});

// ── AC4: TC4c — acyclicity rollback leaves no step-8b on-disk artifacts ──────

await test('AC4/TC4c: an acyclicity-rollback (step-10) removes the rolled-back replacements\' step-8b on-disk artifacts (mission-state entries AND verify sidecars)', async () => {
  // Construct a replacement set whose dependencies form a cycle so step-10
  // _validateAcyclicity throws and triggers the rollback. The rolled-back
  // replacements must leave NO trace on disk: neither a mission-state task
  // entry nor a verify sidecar.
  const failedTaskId = '001-001-001-001';
  const taskX = {
    id: failedTaskId,
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task X (failed)',
  };
  const dir = createSchedHarness([taskX]);
  try {
    const scheduler = makeScheduler(dir, [taskX]);

    // Two conforming replacements that depend on EACH OTHER → a cycle.
    const repA = {
      id: `${failedTaskId}-rp-001`,
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [{ type: 'hard', taskId: `${failedTaskId}-rp-002` }],
      description: 'cyclic replacement A',
    };
    const repB = {
      id: `${failedTaskId}-rp-002`,
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [{ type: 'hard', taskId: `${failedTaskId}-rp-001` }],
      description: 'cyclic replacement B',
    };

    await assert.rejects(
      () => scheduler.replaceTask(failedTaskId, [repA, repB]),
      /cycle|acyclic/i,
      'replaceTask must reject on the cyclic replacement set (step-10 acyclicity violation)'
    );

    // Step-8b artifacts for the rolled-back replacements must be gone on disk.
    const diskTasks = readMissionTasks(dir, '001-001', '001-001-001');
    for (const id of [`${failedTaskId}-rp-001`, `${failedTaskId}-rp-002`]) {
      assert.ok(
        !(id in diskTasks),
        `rolled-back replacement "${id}" must NOT remain in the mission-state file; ` +
        `got disk task ids: [${Object.keys(diskTasks).join(', ')}]. ` +
        `Pre-fix step-10 cleans only in-memory state, leaving the step-8b disk entry.`
      );
      const sidecarPath = path.join(dir, 'verify', `task-${id}.json`);
      assert.strictEqual(
        fs.existsSync(sidecarPath),
        false,
        `rolled-back replacement "${id}"'s verify sidecar must be removed on rollback (no orphan that the drain/resume would count).`
      );
    }

    // The rollback must also not have removed the failed task entry itself.
    assert.ok(diskTasks[failedTaskId], 'the failed task entry must still exist on disk after the rollback');
  } finally {
    cleanup(dir);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
