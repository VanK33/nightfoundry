// Verified compatible with w4-gate-predicate-fidelity (invalidationReason-aware drain logic).
/**
 * test-hardcheck-rehoming.js — Regression tests for spec-hardcheck re-homing
 * (spec: hardcheck-rehoming.spec.md).
 *
 * Contract under test, two halves that compose:
 *  (A) Scheduler.replaceTask re-homes the failed original's spec hardChecks
 *      onto the replacements: source = union of the original's verify sidecar
 *      `.harness/verify/task-<failedTaskId>.json` → .hardChecks and the
 *      in-memory failedTask.hardChecks, de-duplicated by command; assignment
 *      via scopeSpecHardChecks targetFile matching; assigned checks land in
 *      BOTH the in-memory rt.hardChecks AND the replacement's on-disk verify
 *      sidecar. A check matching NO replacement logs a warning naming the
 *      command and lands nowhere. A replacement already carrying a command
 *      does not get a duplicate.
 *  (B) Pipeline._assertSpecHardCheckCoverage skips verify sidecars belonging
 *      to tasks whose mission-state status is 'invalidated', so a spec check
 *      whose ONLY home is an invalidated task's sidecar is flagged as an
 *      orphan (IncompleteScopeError; warn-only under _allowIncompleteScope)
 *      instead of vacuously passing. Sidecars whose taskId appears in no
 *      mission state still count (conservative).
 *
 * Tests:
 *  TC1.  Re-homing happy path: two sidecar checks → each lands on its matching
 *        replacement, in memory AND on disk (persist→re-read).
 *  TC2a. In-memory fallback: no original sidecar, failedTask.hardChecks set in
 *        memory → still re-homed (union path).
 *  TC2b. De-dup: a replacement already carrying a command does not get it
 *        twice; the other replacement still receives its sidecar check.
 *  TC3.  Un-re-homed check: a check matching no replacement → warning naming
 *        the command is logged; no replacement sidecar carries it.
 *  TC4a. Drain filter kills the false-green: the only sidecar carrying spec
 *        check X belongs to an invalidated task → IncompleteScopeError.
 *  TC4b. Control: same sidecar behind a 'complete' task → no throw.
 *  TC4c. _allowIncompleteScope=true on the invalidated case → warns, no throw.
 *  TC4d. Conservative: a sidecar whose taskId is in no mission state still
 *        counts as assigned → no throw.
 *  TC5a. Composition: replaceTask where the original's check matches a
 *        replacement → drain passes (live replacement's sidecar counts).
 *  TC5b. Composition: replaceTask where the original's check matches no
 *        replacement → drain throws IncompleteScopeError.
 *
 * Run: node test/test-hardcheck-rehoming.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Scheduler } from '../src/orchestrator/core/scheduler.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { IncompleteScopeError } from '../src/orchestrator/core/incomplete-scope-error.js';

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

// ── Shared check fixtures ────────────────────────────────────────────────────

const CHECK_A = { name: 'check A', command: 'node test/test-a.js' };
const CHECK_B = { name: 'check B', command: 'node test/test-b.js' };
const CHECK_ZZZ = { name: 'check ZZZ', command: 'node test/test-zzz.js' };
const CHECK_X = { name: 'check X', command: 'node test/test-x.js' };

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Create a temp project root with a `.harness` dir: state.json (projectMeta
 * .prdPath → <root>/spec.md), per-mission state files built from `tasks`
 * (status from `preStatus`, default 'pending'), and the harness sub-dirs the
 * Pipeline constructor expects. When `specChecks` is given, writes the
 * sibling <root>/spec.json with acceptance_criteria carrying
 * verification.{kind:'command', command, targetFile} (parseSpecHardChecks
 * shape). Harness layout mirrors test-hard-checks-pipeline-wiring.js's drain
 * env; mission-state shape mirrors test-cycle-rollback-pending.js.
 */
function createEnv(tasks, { preStatus = {}, specChecks = null, specTargetFiles = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-rehome-test-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(harnessDir, 'logs', 'token-usage.json'),
    JSON.stringify({ sessions: [], totals: {} })
  );

  const prdPath = path.join(root, 'spec.md');
  fs.writeFileSync(prdPath, '# spec');

  const byMission = new Map();
  for (const task of tasks) {
    if (!byMission.has(task.missionId)) byMission.set(task.missionId, []);
    byMission.get(task.missionId).push(task);
  }

  const milestones = { '001': { id: '001', status: 'in_progress', missions: {} } };

  for (const [missionId, missionTasks] of byMission.entries()) {
    milestones['001'].missions[missionId] = {
      id: missionId,
      status: 'in_progress',
      stateFile: `.harness/state/mission-${missionId}.json`,
    };
    const bySubMission = new Map();
    for (const t of missionTasks) {
      if (!bySubMission.has(t.subMissionId)) bySubMission.set(t.subMissionId, []);
      bySubMission.get(t.subMissionId).push(t);
    }
    const subMissions = {};
    for (const [smId, smTasks] of bySubMission.entries()) {
      const taskMap = {};
      for (const t of smTasks) {
        taskMap[t.id] = {
          id: t.id,
          description: t.description || 'test',
          status: preStatus[t.id] || 'pending',
          retryCount: 0,
        };
      }
      subMissions[smId] = { id: smId, status: 'in_progress', tasks: taskMap };
    }
    fs.writeFileSync(
      path.join(harnessDir, 'state', `mission-${missionId}.json`),
      JSON.stringify({
        id: missionId,
        missionId,
        description: 'test mission',
        status: 'in_progress',
        subMissions,
      }, null, 2)
    );
  }

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath, createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones,
    }, null, 2)
  );

  if (specChecks) {
    const specJson = {
      goal: 'hardcheck re-homing test spec',
      target_files: specTargetFiles,
      acceptance_criteria: specChecks.map((c) => ({
        description: c.name,
        verification: { kind: 'command', command: c.command, targetFile: c.targetFile },
      })),
    };
    // deriveSpecJsonPath(prdPath='<root>/spec.md') → '<root>/spec.json'
    fs.writeFileSync(path.join(root, 'spec.json'), JSON.stringify(specJson, null, 2));
  }

  return { root, harnessDir };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Write a verify sidecar at .harness/verify/task-<taskId>.json. */
function writeSidecar(harnessDir, taskId, targetFiles, hardChecks) {
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles, hardChecks, testCases: [] }, null, 2)
  );
}

/** Re-read a verify sidecar from disk (persist→re-read proof). */
function readSidecar(harnessDir, taskId) {
  return JSON.parse(
    fs.readFileSync(path.join(harnessDir, 'verify', `task-${taskId}.json`), 'utf8')
  );
}

/** Commands carried by a hardChecks array (order-preserving). */
function commandsOf(hardChecks) {
  return (hardChecks || []).map((c) => c.command);
}

/**
 * Build a minimal Scheduler with preset DAG state and a log collector
 * (pattern from test-cycle-rollback-pending.js / test-scheduler-replace-task.js).
 */
function makeScheduler(env, tasks, logs) {
  const scheduler = new Scheduler({
    harnessDir: env.harnessDir,
    projectRoot: env.root,
    maxConcurrent: 4,
    runTask: async () => {},
    onLog: (msg) => logs.push(msg),
  });
  scheduler._tasksById = new Map(tasks.map((t) => [t.id, t]));
  scheduler._pending = new Set(tasks.map((t) => t.id));
  scheduler._runningFiles = new Set();
  return scheduler;
}

/**
 * Original task owning three test files + two replacements with conforming
 * `-rp-NNN` ids (no step-7d rename → predictable sidecar paths), each owning
 * one file. Fresh objects each call (replaceTask mutates them).
 */
function makeRehomeFixture() {
  const original = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['test/test-a.js', 'test/test-b.js', 'test/test-zzz.js'],
    dependencies: [],
    description: 'Original task (will be replaced)',
  };
  const repA = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['test/test-a.js'],
    dependencies: [],
    description: 'Replacement A (owns test-a)',
  };
  const repB = {
    id: '001-001-001-001-rp-002',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['test/test-b.js'],
    dependencies: [],
    description: 'Replacement B (owns test-b)',
  };
  return { original, repA, repB };
}

/**
 * Build a bare Pipeline for calling _assertSpecHardCheckCoverage directly
 * (drain idiom from test-hard-checks-pipeline-wiring.js).
 */
function makeDrainPipeline(projectRoot) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    statusBar: false,
  });
  return { pipeline, logs };
}

/**
 * Remove the process signal listeners the Pipeline constructor registers so
 * repeated Pipeline construction across tests does not pile up listeners.
 */
function teardownPipeline(pipeline) {
  const handlers = pipeline._signalHandlers || {};
  if (handlers.SIGINT) process.removeListener('SIGINT', handlers.SIGINT);
  if (handlers.SIGTERM) process.removeListener('SIGTERM', handlers.SIGTERM);
  if (handlers.exit) process.removeListener('exit', handlers.exit);
  if (handlers.uncaughtException) process.removeListener('uncaughtException', handlers.uncaughtException);
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {

// ── TC1: Re-homing happy path ────────────────────────────────────────────────
await test('TC1 re-homing happy path: each sidecar check lands on its matching replacement, in memory and on disk', async () => {
  const { original, repA, repB } = makeRehomeFixture();
  const env = createEnv([original]);
  try {
    writeSidecar(env.harnessDir, original.id, original.targetFiles, [CHECK_A, CHECK_B]);
    const logs = [];
    const scheduler = makeScheduler(env, [original], logs);

    const result = await scheduler.replaceTask(original.id, [repA, repB]);
    assert.deepStrictEqual(result.inserted, [repA.id, repB.id],
      'both replacements should be inserted');

    // In-memory: rt.hardChecks via scheduler._tasksById.
    const rtA = scheduler._tasksById.get(repA.id);
    const rtB = scheduler._tasksById.get(repB.id);
    assert.deepStrictEqual(commandsOf(rtA.hardChecks), [CHECK_A.command],
      `replacement A in-memory hardChecks must carry exactly its matched check, got: ${JSON.stringify(rtA.hardChecks)}`);
    assert.deepStrictEqual(commandsOf(rtB.hardChecks), [CHECK_B.command],
      `replacement B in-memory hardChecks must carry exactly its matched check, got: ${JSON.stringify(rtB.hardChecks)}`);

    // On disk: persist→re-read through .harness/verify/task-<rtId>.json.
    const sidecarA = readSidecar(env.harnessDir, repA.id);
    const sidecarB = readSidecar(env.harnessDir, repB.id);
    assert.deepStrictEqual(commandsOf(sidecarA.hardChecks), [CHECK_A.command],
      `replacement A sidecar must carry exactly its matched check, got: ${JSON.stringify(sidecarA.hardChecks)}`);
    assert.deepStrictEqual(commandsOf(sidecarB.hardChecks), [CHECK_B.command],
      `replacement B sidecar must carry exactly its matched check, got: ${JSON.stringify(sidecarB.hardChecks)}`);

    // Persisted shape is {name, command}.
    assert.strictEqual(sidecarA.hardChecks[0].name, CHECK_A.name,
      'persisted check must keep its name');
    assert.strictEqual(sidecarB.hardChecks[0].name, CHECK_B.name,
      'persisted check must keep its name');

    // In-memory and on-disk agree.
    assert.deepStrictEqual(commandsOf(rtA.hardChecks), commandsOf(sidecarA.hardChecks),
      'replacement A: in-memory hardChecks must agree with the sidecar');
    assert.deepStrictEqual(commandsOf(rtB.hardChecks), commandsOf(sidecarB.hardChecks),
      'replacement B: in-memory hardChecks must agree with the sidecar');

    // Original sidecar is preserved on disk (forensics).
    const originalSidecar = readSidecar(env.harnessDir, original.id);
    assert.deepStrictEqual(commandsOf(originalSidecar.hardChecks), [CHECK_A.command, CHECK_B.command],
      'original sidecar must be preserved on disk, not rewritten or deleted');
  } finally { cleanup(env.root); }
});

// ── TC2a: In-memory fallback (no original sidecar) ───────────────────────────
await test('TC2a in-memory fallback: no original sidecar, failedTask.hardChecks in memory → still re-homed', async () => {
  const { original, repA, repB } = makeRehomeFixture();
  const env = createEnv([original]);
  try {
    // NO sidecar for the original — union path must pick up the in-memory checks.
    original.hardChecks = [CHECK_A];
    const logs = [];
    const scheduler = makeScheduler(env, [original], logs);

    await scheduler.replaceTask(original.id, [repA, repB]);

    const rtA = scheduler._tasksById.get(repA.id);
    const rtB = scheduler._tasksById.get(repB.id);
    assert.deepStrictEqual(commandsOf(rtA.hardChecks), [CHECK_A.command],
      `replacement A must receive the in-memory check, got: ${JSON.stringify(rtA.hardChecks)}`);
    assert.deepStrictEqual(commandsOf(rtB.hardChecks), [],
      `replacement B matches nothing and must receive no checks, got: ${JSON.stringify(rtB.hardChecks)}`);

    const sidecarA = readSidecar(env.harnessDir, repA.id);
    const sidecarB = readSidecar(env.harnessDir, repB.id);
    assert.deepStrictEqual(commandsOf(sidecarA.hardChecks), [CHECK_A.command],
      `replacement A sidecar must carry the re-homed check, got: ${JSON.stringify(sidecarA.hardChecks)}`);
    assert.deepStrictEqual(commandsOf(sidecarB.hardChecks), [],
      `replacement B sidecar must carry no checks, got: ${JSON.stringify(sidecarB.hardChecks)}`);
  } finally { cleanup(env.root); }
});

// ── TC2b: De-dup — pre-seeded command not duplicated ─────────────────────────
await test('TC2b de-dup: replacement already carrying a command gets exactly one copy; sibling still receives its check', async () => {
  const { original, repA, repB } = makeRehomeFixture();
  const env = createEnv([original]);
  try {
    // Same command in BOTH sources (sidecar + in-memory) AND pre-seeded on
    // the replacement: after the call there must be exactly ONE copy.
    writeSidecar(env.harnessDir, original.id, original.targetFiles, [CHECK_A, CHECK_B]);
    original.hardChecks = [CHECK_A];
    repA.hardChecks = [{ name: 'pre-seeded copy', command: CHECK_A.command }];
    const logs = [];
    const scheduler = makeScheduler(env, [original], logs);

    await scheduler.replaceTask(original.id, [repA, repB]);

    const rtA = scheduler._tasksById.get(repA.id);
    const inMemoryCopies = commandsOf(rtA.hardChecks).filter((c) => c === CHECK_A.command);
    assert.strictEqual(inMemoryCopies.length, 1,
      `replacement A must carry exactly one copy of "${CHECK_A.command}" in memory, got: ${JSON.stringify(rtA.hardChecks)}`);

    const sidecarA = readSidecar(env.harnessDir, repA.id);
    const onDiskCopies = commandsOf(sidecarA.hardChecks).filter((c) => c === CHECK_A.command);
    assert.strictEqual(onDiskCopies.length, 1,
      `replacement A sidecar must carry exactly one copy of "${CHECK_A.command}", got: ${JSON.stringify(sidecarA.hardChecks)}`);

    // The sibling replacement still receives its own check (discriminating
    // half: pre-fix nothing is re-homed at all).
    const sidecarB = readSidecar(env.harnessDir, repB.id);
    assert.deepStrictEqual(commandsOf(sidecarB.hardChecks), [CHECK_B.command],
      `replacement B sidecar must carry its matched check, got: ${JSON.stringify(sidecarB.hardChecks)}`);
  } finally { cleanup(env.root); }
});

// ── TC3: Un-re-homed check is loud and lands nowhere ─────────────────────────
await test('TC3 un-re-homed check: warning names the command; no replacement sidecar carries it', async () => {
  const { original, repA, repB } = makeRehomeFixture();
  const env = createEnv([original]);
  try {
    // CHECK_ZZZ's path token (test/test-zzz.js) matches neither replacement.
    writeSidecar(env.harnessDir, original.id, original.targetFiles, [CHECK_A, CHECK_ZZZ]);
    const logs = [];
    const scheduler = makeScheduler(env, [original], logs);

    await scheduler.replaceTask(original.id, [repA, repB]);

    // A warning naming the un-re-homed command is logged.
    assert.ok(logs.some((l) => l.includes(CHECK_ZZZ.command)),
      `a log line must name the un-re-homed command "${CHECK_ZZZ.command}", got logs:\n${logs.join('\n')}`);

    // The un-re-homed check lands on NO replacement (memory + disk).
    const rtA = scheduler._tasksById.get(repA.id);
    const rtB = scheduler._tasksById.get(repB.id);
    assert.ok(!commandsOf(rtA.hardChecks).includes(CHECK_ZZZ.command),
      'replacement A in-memory hardChecks must not carry the unmatched check');
    assert.ok(!commandsOf(rtB.hardChecks).includes(CHECK_ZZZ.command),
      'replacement B in-memory hardChecks must not carry the unmatched check');
    const sidecarA = readSidecar(env.harnessDir, repA.id);
    const sidecarB = readSidecar(env.harnessDir, repB.id);
    assert.ok(!commandsOf(sidecarA.hardChecks).includes(CHECK_ZZZ.command),
      'replacement A sidecar must not carry the unmatched check');
    assert.ok(!commandsOf(sidecarB.hardChecks).includes(CHECK_ZZZ.command),
      'replacement B sidecar must not carry the unmatched check');

    // The matched check still re-homes normally alongside the warning.
    assert.deepStrictEqual(commandsOf(sidecarA.hardChecks), [CHECK_A.command],
      `replacement A sidecar must carry its matched check, got: ${JSON.stringify(sidecarA.hardChecks)}`);
  } finally { cleanup(env.root); }
});

// ── TC4a: Drain filter — invalidated-only sidecar is an orphan ───────────────
await test('TC4a drain filter: only sidecar carrying spec check X belongs to an invalidated task → IncompleteScopeError', async () => {
  const task = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['test/test-x.js'],
    dependencies: [],
    description: 'invalidated owner of check X',
  };
  const env = createEnv([task], {
    preStatus: { [task.id]: 'invalidated' },
    specChecks: [{ ...CHECK_X, targetFile: 'test/test-x.js' }],
    specTargetFiles: ['test/test-x.js'],
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    writeSidecar(env.harnessDir, task.id, task.targetFiles, [CHECK_X]);

    let thrown = null;
    try {
      await pipeline._assertSpecHardCheckCoverage();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown,
      'drain must throw when the only sidecar carrying check X belongs to an invalidated task (pre-fix vacuous pass is the regression)');
    assert.ok(thrown instanceof IncompleteScopeError,
      `drain must throw IncompleteScopeError, got: ${thrown.name}: ${thrown.message}`);
    assert.ok(thrown.message.includes(CHECK_X.command),
      `the error must name the orphaned command "${CHECK_X.command}", got: ${thrown.message}`);
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.root);
  }
});

// ── TC4b: Control — same sidecar behind a complete task ─────────────────────
await test('TC4b drain control: same sidecar behind a complete task → no throw', async () => {
  const task = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['test/test-x.js'],
    dependencies: [],
    description: 'complete owner of check X',
  };
  const env = createEnv([task], {
    preStatus: { [task.id]: 'complete' },
    specChecks: [{ ...CHECK_X, targetFile: 'test/test-x.js' }],
    specTargetFiles: ['test/test-x.js'],
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    writeSidecar(env.harnessDir, task.id, task.targetFiles, [CHECK_X]);
    await pipeline._assertSpecHardCheckCoverage(); // must not throw
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.root);
  }
});

// ── TC4c: _allowIncompleteScope warns instead of throwing ───────────────────
await test('TC4c drain with _allowIncompleteScope=true: invalidated-only sidecar → coverage warning, no throw', async () => {
  const task = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['test/test-x.js'],
    dependencies: [],
    description: 'invalidated owner of check X',
  };
  const env = createEnv([task], {
    preStatus: { [task.id]: 'invalidated' },
    specChecks: [{ ...CHECK_X, targetFile: 'test/test-x.js' }],
    specTargetFiles: ['test/test-x.js'],
  });
  const { pipeline, logs } = makeDrainPipeline(env.root);
  try {
    writeSidecar(env.harnessDir, task.id, task.targetFiles, [CHECK_X]);
    pipeline._allowIncompleteScope = true;

    await pipeline._assertSpecHardCheckCoverage(); // must not throw

    assert.ok(logs.some((l) => l.includes('coverage warning') && l.includes(CHECK_X.command)),
      `expected a coverage warning naming "${CHECK_X.command}" in logs, got:\n${logs.join('\n')}`);
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.root);
  }
});

// ── TC4d: Conservative — sidecar with unknown taskId still counts ────────────
await test('TC4d drain conservative: sidecar whose taskId is in no mission state still counts as assigned → no throw', async () => {
  const task = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/unrelated.js'],
    dependencies: [],
    description: 'unrelated task (does not carry check X)',
  };
  const env = createEnv([task], {
    preStatus: { [task.id]: 'complete' },
    specChecks: [{ ...CHECK_X, targetFile: 'test/test-x.js' }],
    specTargetFiles: ['test/test-x.js'],
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    // The carrying sidecar's taskId appears in NO mission state — cannot be
    // proven invalidated, so it must NOT be skipped.
    writeSidecar(env.harnessDir, '999-999-999-999', ['test/test-x.js'], [CHECK_X]);
    await pipeline._assertSpecHardCheckCoverage(); // must not throw
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.root);
  }
});

// ── TC5a: Composition — re-homed check keeps the drain green ─────────────────
await test('TC5a composition: replaceTask re-homes the spec check onto a replacement → drain passes', async () => {
  const original = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['test/test-a.js'],
    dependencies: [],
    description: 'Original task (will be replaced)',
  };
  const rep = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['test/test-a.js'],
    dependencies: [],
    description: 'Replacement (owns test-a)',
  };
  const env = createEnv([original], {
    specChecks: [{ ...CHECK_A, targetFile: 'test/test-a.js' }],
    specTargetFiles: ['test/test-a.js'],
  });
  try {
    writeSidecar(env.harnessDir, original.id, original.targetFiles, [CHECK_A]);
    const logs = [];
    const scheduler = makeScheduler(env, [original], logs);

    await scheduler.replaceTask(original.id, [rep]);

    // Re-homed: the live replacement's sidecar carries the check, so the
    // drain counts it even though the original is now invalidated on disk.
    const sidecarRep = readSidecar(env.harnessDir, rep.id);
    assert.deepStrictEqual(commandsOf(sidecarRep.hardChecks), [CHECK_A.command],
      `replacement sidecar must carry the re-homed check, got: ${JSON.stringify(sidecarRep.hardChecks)}`);

    const { pipeline } = makeDrainPipeline(env.root);
    try {
      await pipeline._assertSpecHardCheckCoverage(); // must not throw
    } finally {
      teardownPipeline(pipeline);
    }
  } finally { cleanup(env.root); }
});

// ── TC5b: Composition — dropped check makes the drain throw ──────────────────
await test('TC5b composition: original check matches no replacement → drain throws IncompleteScopeError', async () => {
  const original = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['test/test-a.js', 'test/test-zzz.js'],
    dependencies: [],
    description: 'Original task (will be replaced)',
  };
  const rep = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['test/test-a.js'],
    dependencies: [],
    description: 'Replacement (owns only test-a)',
  };
  const env = createEnv([original], {
    specChecks: [{ ...CHECK_ZZZ, targetFile: 'test/test-zzz.js' }],
    specTargetFiles: ['test/test-a.js', 'test/test-zzz.js'],
  });
  try {
    // The spec check's only home is the original's sidecar; the replacement
    // does not own test/test-zzz.js, so re-homing drops it (loudly) and the
    // invalidated original's sidecar must not keep the drain green.
    writeSidecar(env.harnessDir, original.id, original.targetFiles, [CHECK_ZZZ]);
    const logs = [];
    const scheduler = makeScheduler(env, [original], logs);

    await scheduler.replaceTask(original.id, [rep]);

    const { pipeline } = makeDrainPipeline(env.root);
    try {
      let thrown = null;
      try {
        await pipeline._assertSpecHardCheckCoverage();
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown,
        'drain must throw after replaceTask drops the only home of a spec check (pre-fix the invalidated original sidecar keeps it falsely green)');
      assert.ok(thrown instanceof IncompleteScopeError,
        `drain must throw IncompleteScopeError, got: ${thrown.name}: ${thrown.message}`);
      assert.ok(thrown.message.includes(CHECK_ZZZ.command),
        `the error must name the dropped command "${CHECK_ZZZ.command}", got: ${thrown.message}`);
    } finally {
      teardownPipeline(pipeline);
    }
  } finally { cleanup(env.root); }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
