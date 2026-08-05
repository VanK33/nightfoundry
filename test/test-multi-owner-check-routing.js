/**
 * test-multi-owner-check-routing.js — Multi-owner spec hard-check routing.
 *
 * Behavior contract under test (written independently of the implementation):
 * a spec acceptance-criterion hard check whose command's path tokens overlap
 * the targetFiles of TWO OR MORE tasks (a "multi-owner" check) attaches to
 * NO task at scoping time — gating any single sharer on the file's END state
 * fails whichever sharer verifies first. Such checks are instead executed
 * once by the pipeline's spec-criteria drain, which re-derives ownership
 * from persisted mission state (excluding invalidated tasks).
 *
 * Cases:
 *   TC1: incident shape — 5 tasks share the token file → NO task's entry
 *        contains the check
 *   TC2: exactly 1 owner → check attached to that one task (regression of
 *        existing sole-owner behavior); non-owners get nothing
 *   TC3: a multi-owner check does not affect attachment of OTHER
 *        single-owner checks in the same scopeSpecHardChecks call
 *   TC4: isMultiOwnerCheck — true at 2 owners and at 5; false at 1 owner;
 *        false at 0 owners; false for a token-free command
 *   TC5: findUnassignedSpecHardChecks WITH allTasks → multi-owner
 *        unassigned check NOT reported; same call WITHOUT allTasks →
 *        reported (prior behavior preserved); a single-owner unassigned
 *        check is still reported even WITH allTasks
 *   TC6: drain — a multi-owner check whose ≥2 owners live in persisted
 *        mission-*.json state is drain-selected AND drain-executed
 *        (marker proof) by _runSpecCriteriaDrain
 *   TC7: drain — an invalidated task does not count as an owner: a check
 *        owned by 1 active + 1 invalidated task is single-owner → NOT
 *        drain-routed via multi-owner (no drain log, marker absent)
 *   TC8: scopeSpecHardChecks 5th param — 1 in-scope owner + 1 overlapping
 *        externalOwnerSources entry → NOT attached (cross-scope
 *        multi-owner); external sources never appear in the returned Map
 *   TC9: 1 in-scope owner + external sources present but NONE overlapping
 *        → attached (sole-owner behavior preserved)
 *   TC10: externalOwnerSources entries with undefined/null targetFiles →
 *        safely ignored (no throw, sole owner still attached)
 *   TC11: applySpecHardChecks — a persisted OTHER mission's non-invalidated
 *        task sharing the token file makes the current decomp's sole
 *        sharer NOT attached; control: without the external mission file
 *        the same decomp task IS attached
 *   TC12: applySpecHardChecks — declared targetFiles of a NOT-yet-planned
 *        mission (state.milestones entry, no mission-<id>.json) count as
 *        external owners → current decomp's sole sharer NOT attached
 *   TC13: drain — a multi-owner check whose command exits non-zero is
 *        recorded as a failure: _runSpecCriteriaDrain throws
 *        SpecCriterionError naming the check
 *
 * Drain seam note: TC6/TC7 call pipeline._runSpecCriteriaDrain() directly
 * over a real on-disk .harness fixture (state.json + mission-*.json +
 * spec.json), the same drain entry point the full _executeMilestone wiring
 * tests (test-spec-criteria-drain.js) reach at the last milestone — chosen
 * over full _executeMilestone integration because the invalidated-owner
 * fixture only needs the drain's own state walk, not the milestone
 * lifecycle around it.
 *
 * Run: node test/test-multi-owner-check-routing.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { scopeSpecHardChecks, isMultiOwnerCheck, findUnassignedSpecHardChecks } from '../src/orchestrator/agents/planner.js';
import { Pipeline, applySpecHardChecks } from '../src/orchestrator/core/pipeline.js';
import { SpecCriterionError } from '../src/orchestrator/core/spec-criterion-error.js';

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

// ---------- Fixture vocabulary ----------

// The real incident shape: a grep-count criterion over a file five tasks share.
const INCIDENT_FILE = 'src/orchestrator/gates/regression.js';
const INCIDENT_CHECK = {
  name: 'stripTreePurityChecks appears at least 3 times',
  command: `test $(grep -c "stripTreePurityChecks" ${INCIDENT_FILE}) -ge 3`,
};
const fiveSharers = () =>
  ['t1', 't2', 't3', 't4', 't5'].map((id) => ({ id, targetFiles: [INCIDENT_FILE] }));

// Drain fixture: a path-bearing command ('mkmarker.js' ends in .js — NOT
// milestone-only) that, IF EXECUTED, writes a marker file into cwd.
const MARKER_CMD = 'node mkmarker.js';
const MARKER_FILE = 'marker-ran.txt';
const MKMARKER_SRC = `require('fs').writeFileSync('${MARKER_FILE}', 'ran');\n`;

// ---------- Drain fixture ----------

/**
 * Real .harness layout on disk with ONE persisted mission state file whose
 * tasks are given by taskSpecs: [{id, status, targetFiles}]. spec.json holds
 * a single kind=command criterion running MARKER_CMD (no target_files key →
 * legacy zero-token milestone-only classification, so the path-bearing
 * marker command is NOT milestone-only and can only reach the drain set via
 * the multi-owner route).
 */
function createDrainFixture(taskSpecs, { command = MARKER_CMD, scriptName = 'mkmarker.js', scriptSrc = MKMARKER_SRC } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-owner-drain-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(harnessDir, 'logs', 'token-usage.json'),
    JSON.stringify({ sessions: [], totals: {} })
  );

  fs.writeFileSync(path.join(root, 'spec.md'), '# multi-owner drain fixture\n');
  fs.writeFileSync(
    path.join(root, 'spec.json'),
    JSON.stringify({
      goal: 'multi-owner drain fixture',
      acceptance_criteria: [
        { description: 'multi-owner marker criterion', verification: { kind: 'command', command } },
      ],
    }, null, 2)
  );
  fs.writeFileSync(path.join(root, scriptName), scriptSrc);

  const miId = '001-001';
  const smId = '001-001-001';
  const tasks = {};
  for (const spec of taskSpecs) {
    tasks[spec.id] = {
      id: spec.id,
      description: `task ${spec.id}`,
      status: spec.status,
      targetFiles: spec.targetFiles,
      dependencies: [],
      testCases: [],
      retryCount: 0,
    };
  }
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${miId}.json`),
    JSON.stringify({
      id: miId,
      missionId: miId,
      description: `mission ${miId}`,
      status: 'complete',
      subMissions: { [smId]: { id: smId, description: `sub-mission ${smId}`, status: 'complete', tasks } },
    }, null, 2)
  );

  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify({
    projectMeta: {
      prdPath: path.join(root, 'spec.md'),
      createdAt: new Date().toISOString(),
      currentPhase: 'executing',
    },
    globalStatus: 'active',
    milestones: {
      '001': {
        id: '001',
        description: 'milestone 001',
        status: 'in_progress',
        planFile: '.harness/plan/milestone-001.md',
        missions: {
          [miId]: {
            id: miId,
            description: `mission ${miId}`,
            status: 'complete',
            stateFile: `.harness/state/mission-${miId}.json`,
            planFile: `.harness/plan/mission-${miId}.md`,
          },
        },
      },
    },
  }, null, 2));

  return { root, harnessDir };
}

function makeDrainPipeline(projectRoot) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: (msg) => logs.push(String(msg)),
    onConfirm: async () => true,
  });
  return { pipeline, logs };
}

// ---------- applySpecHardChecks fixture ----------

const SHARED_FILE = 'src/shared/f.js';
const SHARED_CHECK_CMD = `grep -q sharedSymbol ${SHARED_FILE}`;

/**
 * Minimal .harness for direct applySpecHardChecks calls: state.json +
 * spec.json holding one path-bearing check over SHARED_FILE (no target_files
 * key → legacy milestone-only classification, so the check is scopeable).
 *
 * @param {object} opts
 * @param {Array<{missionId: string, tasks: Array<{id, status, targetFiles}>}>} [opts.externalMissions]
 *   Persisted mission-<id>.json files for OTHER missions.
 * @param {Array<{missionId: string, targetFiles: string[]}>} [opts.unplannedMissions]
 *   state.milestones missions entries WITHOUT a mission-<id>.json (declared
 *   targetFiles only — the not-yet-planned case).
 */
function createApplyFixture({ externalMissions = [], unplannedMissions = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-owner-apply-'));
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });

  fs.writeFileSync(path.join(root, 'spec.md'), '# apply fixture\n');
  fs.writeFileSync(
    path.join(root, 'spec.json'),
    JSON.stringify({
      goal: 'apply fixture',
      acceptance_criteria: [
        { description: 'shared symbol present', verification: { kind: 'command', command: SHARED_CHECK_CMD } },
      ],
    }, null, 2)
  );

  const missions = {};
  for (const em of externalMissions) {
    const smId = `${em.missionId}-001`;
    const tasks = {};
    for (const t of em.tasks) {
      tasks[t.id] = { id: t.id, description: `task ${t.id}`, status: t.status, targetFiles: t.targetFiles, dependencies: [], testCases: [], retryCount: 0 };
    }
    fs.writeFileSync(
      path.join(harnessDir, 'state', `mission-${em.missionId}.json`),
      JSON.stringify({
        id: em.missionId,
        missionId: em.missionId,
        description: `mission ${em.missionId}`,
        status: 'complete',
        subMissions: { [smId]: { id: smId, description: `sub-mission ${smId}`, status: 'complete', tasks } },
      }, null, 2)
    );
    missions[em.missionId] = { id: em.missionId, description: `mission ${em.missionId}`, status: 'complete' };
  }
  for (const um of unplannedMissions) {
    missions[um.missionId] = { id: um.missionId, description: `mission ${um.missionId}`, status: 'pending', targetFiles: um.targetFiles };
  }

  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify({
    projectMeta: {
      prdPath: path.join(root, 'spec.md'),
      createdAt: new Date().toISOString(),
      currentPhase: 'executing',
    },
    globalStatus: 'active',
    milestones: { '001': { id: '001', description: 'milestone 001', status: 'in_progress', missions } },
  }, null, 2));

  return { root, harnessDir };
}

/** Fresh one-task decomposition whose sole task targets SHARED_FILE. */
function makeSoleSharerDecomp() {
  return {
    subMissions: [{
      id: '001-001-001',
      tasks: [{ id: '001-001-001-001', description: 'edit the shared file', targetFiles: [SHARED_FILE], dependencies: [], testCases: [] }],
    }],
  };
}

/** Remove the Pipeline constructor's process listeners/timers between tests. */
function teardownPipeline(pipeline) {
  const handlers = pipeline._signalHandlers || {};
  if (handlers.SIGINT) process.removeListener('SIGINT', handlers.SIGINT);
  if (handlers.SIGTERM) process.removeListener('SIGTERM', handlers.SIGTERM);
  if (handlers.exit) process.removeListener('exit', handlers.exit);
  if (handlers.uncaughtException) process.removeListener('uncaughtException', handlers.uncaughtException);
  if (typeof pipeline.destroy === 'function') pipeline.destroy();
}

// ---------- Tests ----------

async function main() {
  // TC1: incident shape — five tasks all declare the token file; the check
  // attaches to NONE of them.
  await test('TC1: 5 tasks share the token file → no task entry contains the check', () => {
    const tasks = fiveSharers();
    const result = scopeSpecHardChecks([INCIDENT_CHECK], tasks);
    assert.ok(result instanceof Map, 'Expected a Map');
    for (const task of tasks) {
      const entry = result.get(task.id) || [];
      assert.strictEqual(entry.length, 0,
        `Expected ${task.id} to get NO checks (multi-owner check must attach to nobody), got ${JSON.stringify(entry)}`);
    }
  });

  // TC2: sole owner → attached to exactly that task; non-owners get nothing.
  await test('TC2: exactly 1 owning task → check attached to that task only', () => {
    const tasks = [
      { id: 'owner', targetFiles: [INCIDENT_FILE] },
      { id: 'bystander-1', targetFiles: ['src/other/a.js'] },
      { id: 'bystander-2', targetFiles: ['src/other/b.js'] },
    ];
    const result = scopeSpecHardChecks([INCIDENT_CHECK], tasks);
    const ownerChecks = result.get('owner') || [];
    assert.strictEqual(ownerChecks.length, 1, `Expected 1 check for sole owner, got ${ownerChecks.length}`);
    assert.strictEqual(ownerChecks[0].command, INCIDENT_CHECK.command);
    assert.strictEqual((result.get('bystander-1') || []).length, 0, 'Expected no checks for bystander-1');
    assert.strictEqual((result.get('bystander-2') || []).length, 0, 'Expected no checks for bystander-2');
  });

  // TC3: a multi-owner check must not disturb the attachment of OTHER
  // single-owner checks scoped in the same call.
  await test('TC3: multi-owner check does not affect other single-owner checks in the same call', () => {
    const multiCheck = { name: 'shared check', command: 'grep -q sharedSymbol src/shared/util.js' };
    const soloCheck = { name: 'solo check', command: 'ls src/solo/lib.js' };
    const tasks = [
      { id: 'sharer-1', targetFiles: ['src/shared/util.js'] },
      { id: 'sharer-2', targetFiles: ['src/shared/util.js'] },
      { id: 'solo-owner', targetFiles: ['src/solo/lib.js'] },
    ];
    const result = scopeSpecHardChecks([multiCheck, soloCheck], tasks);
    assert.strictEqual((result.get('sharer-1') || []).length, 0, 'sharer-1 must get nothing');
    assert.strictEqual((result.get('sharer-2') || []).length, 0, 'sharer-2 must get nothing');
    const soloChecks = result.get('solo-owner') || [];
    assert.strictEqual(soloChecks.length, 1,
      `solo-owner must still get its single-owner check, got ${JSON.stringify(soloChecks)}`);
    assert.strictEqual(soloChecks[0].command, soloCheck.command);
  });

  // TC4: isMultiOwnerCheck predicate matrix.
  await test('TC4: isMultiOwnerCheck — true at 2+ owners; false at 1, at 0, and for a token-free command', () => {
    const twoOwners = [
      { id: 'a', targetFiles: [INCIDENT_FILE] },
      { id: 'b', targetFiles: [INCIDENT_FILE] },
    ];
    assert.strictEqual(isMultiOwnerCheck(INCIDENT_CHECK, twoOwners), true,
      'Expected true at exactly 2 owners');
    assert.strictEqual(isMultiOwnerCheck(INCIDENT_CHECK, fiveSharers()), true,
      'Expected true at 5 owners');
    const oneOwner = [
      { id: 'a', targetFiles: [INCIDENT_FILE] },
      { id: 'b', targetFiles: ['src/other/a.js'] },
    ];
    assert.strictEqual(isMultiOwnerCheck(INCIDENT_CHECK, oneOwner), false,
      'Expected false at exactly 1 owner');
    const zeroOwners = [
      { id: 'a', targetFiles: ['src/other/a.js'] },
      { id: 'b', targetFiles: ['src/other/b.js'] },
    ];
    assert.strictEqual(isMultiOwnerCheck(INCIDENT_CHECK, zeroOwners), false,
      'Expected false at 0 owners');
    const tokenFree = { name: 'lint', command: 'npm run lint' };
    assert.strictEqual(isMultiOwnerCheck(tokenFree, twoOwners), false,
      'Expected false for a command with no path tokens');
  });

  // TC5: findUnassignedSpecHardChecks — the optional 5th parameter.
  await test('TC5: findUnassignedSpecHardChecks — multi-owner not reported WITH allTasks; reported WITHOUT; single-owner still reported WITH allTasks', () => {
    const sharers = [
      { id: 'a', targetFiles: [INCIDENT_FILE] },
      { id: 'b', targetFiles: [INCIDENT_FILE] },
    ];
    // WITH allTasks: multi-owner is drain-executed by design → never an orphan.
    const withTasks = findUnassignedSpecHardChecks([INCIDENT_CHECK], new Set(), undefined, undefined, sharers);
    assert.strictEqual(withTasks.length, 0,
      `Expected multi-owner check NOT reported as unassigned when allTasks is provided, got ${JSON.stringify(withTasks)}`);
    // WITHOUT allTasks: prior behavior — path-bearing + unassigned → reported.
    const withoutTasks = findUnassignedSpecHardChecks([INCIDENT_CHECK], new Set(), undefined, undefined);
    assert.strictEqual(withoutTasks.length, 1,
      `Expected the check reported as unassigned without allTasks (prior behavior), got ${withoutTasks.length}`);
    assert.strictEqual(withoutTasks[0].command, INCIDENT_CHECK.command);
    // WITH allTasks but only ONE owner: allTasks must not blanket-suppress —
    // a single-owner unassigned check is still an orphan.
    const oneOwner = [{ id: 'a', targetFiles: [INCIDENT_FILE] }];
    const singleOwner = findUnassignedSpecHardChecks([INCIDENT_CHECK], new Set(), undefined, undefined, oneOwner);
    assert.strictEqual(singleOwner.length, 1,
      `Expected a single-owner unassigned check still reported with allTasks provided, got ${singleOwner.length}`);
  });

  // TC6: drain — owners persisted in mission state, both active → the check
  // is drain-selected AND drain-executed (marker proof).
  await test('TC6: drain executes a multi-owner check whose 2 owners live in persisted mission state (marker proof)', () => {
    const { root } = createDrainFixture([
      { id: '001-001-001-001', status: 'complete', targetFiles: ['mkmarker.js'] },
      { id: '001-001-001-002', status: 'complete', targetFiles: ['mkmarker.js'] },
    ]);
    const { pipeline, logs } = makeDrainPipeline(root);
    try {
      pipeline._runSpecCriteriaDrain();
      // Selection: the drain announces a non-empty drain set.
      assert.ok(logs.some((l) => l.includes('Spec-criteria drain: 1 milestone-only check(s)')),
        `Expected the drain to SELECT the multi-owner check into its drain set, logs: ${JSON.stringify(logs)}`);
      // Execution: the command actually ran (its marker exists).
      assert.ok(fs.existsSync(path.join(root, MARKER_FILE)),
        `Expected the multi-owner check to EXECUTE at the drain — '${MARKER_CMD}' never ran (marker file absent)`);
    } finally {
      teardownPipeline(pipeline);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // TC7: drain — invalidated tasks do not count as owners. 1 active + 1
  // invalidated sharer → single-owner → NOT drain-routed via multi-owner:
  // the drain set is empty (no drain log) and the command never runs.
  await test('TC7: drain — 1 active + 1 invalidated owner is single-owner → NOT drain-routed (marker absent)', () => {
    const { root } = createDrainFixture([
      { id: '001-001-001-001', status: 'complete', targetFiles: ['mkmarker.js'] },
      { id: '001-001-001-002', status: 'invalidated', targetFiles: ['mkmarker.js'] },
    ]);
    const { pipeline, logs } = makeDrainPipeline(root);
    try {
      pipeline._runSpecCriteriaDrain();
      assert.ok(!logs.some((l) => l.includes('Spec-criteria drain:')),
        `Expected an EMPTY drain set (invalidated task must not count as an owner), logs: ${JSON.stringify(logs)}`);
      assert.ok(!fs.existsSync(path.join(root, MARKER_FILE)),
        'Expected the single-owner check NOT to execute at the drain — marker file was created');
    } finally {
      teardownPipeline(pipeline);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // TC8: cross-scope multi-owner — 1 in-scope owner + 1 overlapping external
  // owner source → the check attaches to NOBODY; external sources are owner
  // COUNTERS only, never Map entries.
  await test('TC8: 1 in-scope owner + 1 overlapping externalOwnerSources entry → not attached', () => {
    const check = { name: 'shared check', command: `ls ${SHARED_FILE}` };
    const tasks = [{ id: 'in-scope', targetFiles: [SHARED_FILE] }];
    const external = [{ targetFiles: [SHARED_FILE] }];
    const result = scopeSpecHardChecks([check], tasks, undefined, undefined, external);
    assert.ok(result instanceof Map, 'Expected a Map');
    assert.strictEqual((result.get('in-scope') || []).length, 0,
      'Expected the in-scope task NOT to get the check (external source is a co-owner)');
    assert.strictEqual(result.size, 1,
      `Expected only the in-scope task in the returned Map (external sources are never attached to), got ${result.size} entries`);
  });

  // TC9: external sources present but none overlapping → sole in-scope owner
  // keeps its attachment.
  await test('TC9: 1 in-scope owner + non-overlapping external sources → attached (sole owner preserved)', () => {
    const check = { name: 'shared check', command: `ls ${SHARED_FILE}` };
    const tasks = [{ id: 'in-scope', targetFiles: [SHARED_FILE] }];
    const external = [
      { targetFiles: ['src/other/a.js'] },
      { targetFiles: ['src/other/b.js'] },
    ];
    const result = scopeSpecHardChecks([check], tasks, undefined, undefined, external);
    const attached = result.get('in-scope') || [];
    assert.strictEqual(attached.length, 1,
      `Expected the sole in-scope owner to keep the check, got ${JSON.stringify(attached)}`);
    assert.strictEqual(attached[0].command, check.command);
  });

  // TC10: malformed external sources (undefined/null targetFiles) are
  // safely ignored — no throw, sole owner still attached.
  await test('TC10: externalOwnerSources entries with undefined/null targetFiles are safely ignored', () => {
    const check = { name: 'shared check', command: `ls ${SHARED_FILE}` };
    const tasks = [{ id: 'in-scope', targetFiles: [SHARED_FILE] }];
    const external = [
      { targetFiles: undefined },
      { targetFiles: null },
      { targetFiles: ['src/other/a.js'] },
    ];
    const result = scopeSpecHardChecks([check], tasks, undefined, undefined, external);
    const attached = result.get('in-scope') || [];
    assert.strictEqual(attached.length, 1,
      `Expected malformed external sources ignored and the sole owner attached, got ${JSON.stringify(attached)}`);
  });

  // TC11: applySpecHardChecks — a persisted OTHER mission's non-invalidated
  // task sharing the token file counts as an external owner: the current
  // decomp's sole sharer is NOT attached. Control fixture without the
  // external mission → attached (proves the external file is the cause).
  await test('TC11: applySpecHardChecks — persisted other-mission sharer → decomp sole sharer not attached; control without it → attached', () => {
    // With the external sharer.
    const withExt = createApplyFixture({
      externalMissions: [{
        missionId: '000-001',
        tasks: [{ id: '000-001-001-001', status: 'complete', targetFiles: [SHARED_FILE] }],
      }],
    });
    try {
      const decomp = makeSoleSharerDecomp();
      applySpecHardChecks(decomp, withExt.root, withExt.harnessDir, '001-001');
      const task = decomp.subMissions[0].tasks[0];
      assert.strictEqual((task.hardChecks || []).length, 0,
        `Expected NO hardChecks (other mission's persisted task is a co-owner), got ${JSON.stringify(task.hardChecks)}`);
    } finally {
      fs.rmSync(withExt.root, { recursive: true, force: true });
    }
    // Control: no external mission on disk.
    const control = createApplyFixture();
    try {
      const decomp = makeSoleSharerDecomp();
      applySpecHardChecks(decomp, control.root, control.harnessDir, '001-001');
      const task = decomp.subMissions[0].tasks[0];
      assert.strictEqual((task.hardChecks || []).length, 1,
        `Control: expected the sole sharer attached with no external owners, got ${JSON.stringify(task.hardChecks)}`);
      assert.strictEqual(task.hardChecks[0].command, SHARED_CHECK_CMD);
    } finally {
      fs.rmSync(control.root, { recursive: true, force: true });
    }
  });

  // TC12: applySpecHardChecks — a NOT-yet-planned mission (milestones entry
  // with declared targetFiles, no mission-<id>.json) counts as an external
  // owner too.
  await test('TC12: applySpecHardChecks — unplanned mission declared targetFiles count as external owners → not attached', () => {
    const env = createApplyFixture({
      unplannedMissions: [{ missionId: '001-002', targetFiles: [SHARED_FILE] }],
    });
    try {
      const decomp = makeSoleSharerDecomp();
      applySpecHardChecks(decomp, env.root, env.harnessDir, '001-001');
      const task = decomp.subMissions[0].tasks[0];
      assert.strictEqual((task.hardChecks || []).length, 0,
        `Expected NO hardChecks (unplanned mission 001-002 declares the shared file), got ${JSON.stringify(task.hardChecks)}`);
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });

  // TC13: drain — a multi-owner check whose command FAILS (exit 3) must be
  // recorded as a failure: _runSpecCriteriaDrain throws SpecCriterionError
  // naming the check.
  await test('TC13: drain — failing multi-owner check → SpecCriterionError with the failure recorded', () => {
    const FAIL_CMD = 'node mkfail.js';
    const { root } = createDrainFixture(
      [
        { id: '001-001-001-001', status: 'complete', targetFiles: ['mkfail.js'] },
        { id: '001-001-001-002', status: 'complete', targetFiles: ['mkfail.js'] },
      ],
      { command: FAIL_CMD, scriptName: 'mkfail.js', scriptSrc: 'process.exit(3);\n' }
    );
    const { pipeline } = makeDrainPipeline(root);
    try {
      let thrown = null;
      try {
        pipeline._runSpecCriteriaDrain();
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown, 'Expected _runSpecCriteriaDrain to throw on the failing multi-owner check');
      assert.ok(thrown instanceof SpecCriterionError,
        `Expected SpecCriterionError, got ${thrown.name}: ${thrown.message}`);
      assert.ok(Array.isArray(thrown.failures) && thrown.failures.length === 1,
        `Expected exactly 1 recorded failure, got ${JSON.stringify(thrown.failures)}`);
      const f = thrown.failures[0];
      assert.strictEqual(f.command, FAIL_CMD, `Expected the failure to carry the command, got ${JSON.stringify(f)}`);
      assert.strictEqual(f.exitCode, 3, `Expected exitCode 3, got ${f.exitCode}`);
    } finally {
      teardownPipeline(pipeline);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
