/**
 * test-replan-cap-retry-budget.js — Contract tests for the replan-cap /
 * retry-budget spec (replan-cap-retry-budget.spec.md).
 *
 * Two same-family ③ non-convergence holes:
 *  (A) The replan cap canonicalizes ids by stripping (-rp-\d+)+$ but the
 *      {original-id}-rp-NNN convention was only prompt-enforced — a
 *      non-conforming planner id canonicalizes to itself and opens a fresh
 *      replan budget every cycle. Post-fix: schema `pattern` on the
 *      replacement id, a shared exported canonicalTaskId(), and a
 *      normalization pass in replaceTask that RENAMES any replacement whose
 *      canonical id differs from the failed task's canonical id to
 *      `${failedTaskId}-rp-NNN` (collision-free, intra-batch dep refs
 *      rewritten, renamed id persisted).
 *  (B) transitionTask('failed') persists task.retryCount but nothing read
 *      it back — every _executeAndVerifyTask entry passed retryCount=0.
 *      Post-fix: the entry clamps retryCount to the persisted value
 *      (Math.max), making the budget a durable per-task lifetime budget.
 *
 * Tests (≈ spec acceptance criteria 1-5):
 *  TC1.  Schema: non-conforming replacement id fails validateStructured;
 *        conforming single ('X-rp-001') and stacked ('X-rp-001-rp-002')
 *        suffixes pass.
 *  TC2.  canonicalTaskId: strips one and multiple -rp-N groups, leaves
 *        non-suffixed ids unchanged.
 *  TC3.  Normalization: non-conforming replacement ids are renamed to
 *        X-rp-NNN in _tasksById, _pending AND the on-disk mission state;
 *        intra-batch dependency refs are rewritten; the replan counter is
 *        keyed on canonicalTaskId(X).
 *  TC4.  Collision: with X-rp-001 already in the DAG, the rename picks
 *        X-rp-002.
 *  TC5.  Cap integrity across generations: conforming gen-1 replacement is
 *        NOT renamed; non-conforming gen-2 replacement is renamed into the
 *        same family; the counter accumulates on canonical X; at
 *        MAX_REPLAN_ATTEMPTS the next replaceTask for the family throws.
 *  TC6a. Retry budget survives: persisted retryCount = config.maxRetries →
 *        a BLOCKED executor stub runs EXACTLY once and the analyzer is
 *        dispatched (no fresh retry chain).
 *  TC6b. Control: persisted retryCount = 0 → the normal chain runs
 *        (executor called config.maxRetries + 1 times, then analyzer).
 *
 * Fixture helpers mirror test-cycle-rollback-pending.js (createSchedHarness,
 * makeScheduler) and test-circuit-breaker-replan.js
 * (createMinimalPipelineHarness).
 *
 * Run: node test/test-replan-cap-retry-budget.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { taskReplanSchema, validateStructured } from '../src/orchestrator/agents/_schemas.js';
import config from '../src/orchestrator/infra/config.js';

// Dynamic import so the file still runs to completion at baseline when
// canonicalTaskId is not yet exported — each case asserts existence itself
// instead of crashing the whole file at static-import link time.
const schedMod = await import('../src/orchestrator/core/scheduler.js');
const { Scheduler } = schedMod;

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

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Create a temp harness dir with a minimal global state.json + per-mission
 * state files. Tasks default to 'pending' unless overridden in `preStatus`.
 * Replicated from test-cycle-rollback-pending.js so tests run in isolation.
 */
function createSchedHarness(tasks, { preStatus = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replan-cap-budget-test-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });

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
      path.join(dir, 'state', `mission-${missionId}.json`),
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
    path.join(dir, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones,
    }, null, 2)
  );

  return dir;
}

/**
 * Build a minimal Scheduler instance with a no-op runTask and preset DAG
 * state (instance-surgery pattern from test-cycle-rollback-pending.js).
 */
function makeScheduler(harnessDir, tasks) {
  const scheduler = new Scheduler({
    harnessDir,
    projectRoot: harnessDir,
    maxConcurrent: 4,
    runTask: async () => {},
  });
  scheduler._tasksById = new Map(tasks.map((t) => [t.id, t]));
  scheduler._pending = new Set(tasks.map((t) => t.id));
  scheduler._runningFiles = new Set();
  return scheduler;
}

/** Re-read the on-disk mission state and return the sub-mission's task map. */
function readMissionTasks(harnessDir, missionId, subMissionId) {
  const stateFile = path.join(harnessDir, 'state', `mission-${missionId}.json`);
  const missionState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return missionState.subMissions?.[subMissionId]?.tasks || {};
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Create a minimal temp project + .harness dir suitable for driving
 * Pipeline._executeAndVerifyTask (mirrors createMinimalPipelineHarness in
 * test-circuit-breaker-replan.js, plus a configurable persisted retryCount).
 */
function createPipelineHarness({
  taskId = '001-001-001-001',
  missionId = '001-001',
  status = 'pending',
  retryCount = 0,
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'replan-budget-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const subMissionId = `${missionId}-001`;
  const missionState = {
    id: missionId, missionId, description: 'test mission', status: 'in_progress',
    subMissions: {
      [subMissionId]: {
        id: subMissionId, status: 'in_progress',
        tasks: {
          [taskId]: {
            id: taskId, description: 'test task', status,
            retryCount, targetFiles: ['src/foo.js'], dependencies: [],
          },
        },
      },
    },
  };

  fs.writeFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), JSON.stringify(missionState, null, 2));

  const globalState = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      '001': {
        id: '001', description: 'milestone', status: 'in_progress',
        missions: { [missionId]: { id: missionId, description: 'test', status: 'in_progress', stateFile: `.harness/state/mission-${missionId}.json` } },
      },
    },
  };

  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  const srcFile = path.join(projectRoot, 'src', 'foo.js');
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.writeFileSync(srcFile, '// foo\n');

  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: ['src/foo.js'], hardChecks: [], testCases: [] })
  );

  return { projectRoot, harnessDir, subMissionId };
}

/**
 * Build a Pipeline whose executor always reports BLOCKED and whose
 * _dispatchAnalyzer is a capturing stub (pattern from
 * test-circuit-breaker-replan.js / test-pipeline-replan.js).
 */
function makeBlockedPipeline(projectRoot) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
  });

  let execCalls = 0;
  pipeline.executor = {
    executeTask: async () => {
      execCalls++;
      return { status: 'BLOCKED' };
    },
  };

  const analyzerCalls = [];
  pipeline._dispatchAnalyzer = async (task, failureType, retryCount) => {
    analyzerCalls.push({ taskId: task.id, failureType, retryCount });
  };

  return { pipeline, logs, getExecCalls: () => execCalls, analyzerCalls };
}

// Canonical failed-task fixture shared by the replaceTask cases.
function makeFailedTaskX() {
  return {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task X (failed, will be replaced)',
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {

// ── TC1: schema pattern on replacement ids ───────────────────────────────────
await test('TC1 schema: validateStructured rejects non -rp-N replacement ids, accepts single and stacked suffixes', async () => {
  const nonConforming = {
    replacementTasks: [
      { id: 'fix-task-1', description: 'd', targetFiles: ['f'], dependencies: [] },
    ],
  };
  const badResult = validateStructured(nonConforming, taskReplanSchema);
  assert.strictEqual(badResult.ok, false,
    `id "fix-task-1" (no -rp-N suffix) must FAIL taskReplanSchema validation, got ok=${badResult.ok}`);

  const conformingSingle = {
    replacementTasks: [
      { id: 'X-rp-001', description: 'd', targetFiles: ['f'], dependencies: [] },
    ],
  };
  const singleResult = validateStructured(conformingSingle, taskReplanSchema);
  assert.strictEqual(singleResult.ok, true,
    `id "X-rp-001" must PASS taskReplanSchema validation, errors: ${(singleResult.errors || []).join(', ')}`);

  const conformingStacked = {
    replacementTasks: [
      { id: 'X-rp-001-rp-002', description: 'd', targetFiles: ['f'], dependencies: [] },
    ],
  };
  const stackedResult = validateStructured(conformingStacked, taskReplanSchema);
  assert.strictEqual(stackedResult.ok, true,
    `id "X-rp-001-rp-002" must PASS taskReplanSchema validation, errors: ${(stackedResult.errors || []).join(', ')}`);
});

// ── TC2: canonicalTaskId mappings ────────────────────────────────────────────
await test('TC2 canonicalTaskId: strips one and multiple -rp-N groups, leaves other ids unchanged', async () => {
  assert.strictEqual(typeof schedMod.canonicalTaskId, 'function',
    'canonicalTaskId must be exported from src/orchestrator/core/scheduler.js');
  const { canonicalTaskId } = schedMod;

  assert.strictEqual(canonicalTaskId('001-002-003-004-rp-001'), '001-002-003-004',
    'single -rp-N group must be stripped');
  assert.strictEqual(canonicalTaskId('001-002-003-004-rp-001-rp-002'), '001-002-003-004',
    'stacked -rp-N groups must all be stripped');
  assert.strictEqual(canonicalTaskId('001-002-003-004'), '001-002-003-004',
    'non-suffixed numeric id must be unchanged');
  assert.strictEqual(canonicalTaskId('custom-name'), 'custom-name',
    'non-suffixed custom id must be unchanged');
});

// ── TC3: normalization pass in replaceTask ───────────────────────────────────
await test('TC3 normalization: non-conforming replacement ids renamed to X-rp-NNN everywhere, intra-batch deps rewritten, counter keyed on canonical X', async () => {
  const taskX = makeFailedTaskX();
  const dir = createSchedHarness([taskX]);
  try {
    const scheduler = makeScheduler(dir, [taskX]);

    const repA = {
      id: 'totally-custom',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'replacement A: rebuild the parser core',
    };
    const repB = {
      id: 'also-custom',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [{ type: 'hard', taskId: 'totally-custom' }],
      description: 'replacement B: rewire the parser consumers',
    };

    const result = await scheduler.replaceTask(taskX.id, [repA, repB]);

    // Old non-conforming ids must not survive anywhere.
    const diskTasks = readMissionTasks(dir, '001-001', '001-001-001');
    for (const oldId of ['totally-custom', 'also-custom']) {
      assert.ok(!scheduler._tasksById.has(oldId),
        `non-conforming id "${oldId}" must NOT be in _tasksById`);
      assert.ok(!scheduler._pending.has(oldId),
        `non-conforming id "${oldId}" must NOT be in _pending`);
      assert.ok(!(oldId in diskTasks),
        `non-conforming id "${oldId}" must NOT be persisted in the mission state file`);
    }

    // Two renamed X-rp-NNN ids must exist in all three places.
    assert.strictEqual(result.inserted.length, 2,
      `expected 2 inserted replacements, got: [${result.inserted.join(', ')}]`);
    for (const id of result.inserted) {
      assert.ok(/^001-001-001-001-rp-\d{3}$/.test(id),
        `inserted id "${id}" must match 001-001-001-001-rp-NNN`);
      assert.ok(scheduler._tasksById.has(id), `renamed id "${id}" must be in _tasksById`);
      assert.ok(scheduler._pending.has(id), `renamed id "${id}" must be in _pending`);
      assert.ok(id in diskTasks,
        `renamed id "${id}" must be persisted in the on-disk mission state (persist→re-read)`);
    }
    assert.deepStrictEqual(
      [...result.inserted].sort(),
      ['001-001-001-001-rp-001', '001-001-001-001-rp-002'],
      'smallest collision-free NNN ≥ 001 must be chosen for each rename'
    );

    // Intra-batch dependency reference to the old id must be rewritten to the
    // NEW id of the first replacement — in memory and on disk.
    const insertedTasks = result.inserted.map((id) => scheduler._tasksById.get(id));
    const newA = insertedTasks.find((t) => t.description === repA.description);
    const newB = insertedTasks.find((t) => t.description === repB.description);
    assert.ok(newA, 'renamed replacement A must be findable by description');
    assert.ok(newB, 'renamed replacement B must be findable by description');
    assert.strictEqual(newB.dependencies.length, 1,
      'replacement B must keep exactly 1 dependency');
    assert.strictEqual(newB.dependencies[0].taskId, newA.id,
      `replacement B's intra-batch dep must be rewritten to A's new id "${newA.id}", got: "${newB.dependencies[0].taskId}"`);
    const diskB = diskTasks[newB.id];
    assert.ok(diskB, `renamed B "${newB.id}" must exist in the mission state file`);
    assert.strictEqual(diskB.dependencies[0].taskId, newA.id,
      `persisted B's dep must point at A's new id "${newA.id}", got: "${diskB.dependencies[0].taskId}"`);

    // Replan counter keyed on canonicalTaskId(X).
    assert.strictEqual(scheduler._replanAttempts.get('001-001-001-001'), 1,
      '_replanAttempts must be keyed on canonical "001-001-001-001" with value 1');
  } finally { cleanup(dir); }
});

// ── TC4: rename collision avoidance ──────────────────────────────────────────
await test('TC4 collision: with X-rp-001 already in the DAG, a non-conforming replacement is renamed to X-rp-002', async () => {
  const taskX = makeFailedTaskX();
  const sibling = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/b.js'],
    dependencies: [],
    description: 'pre-existing sibling occupying the X-rp-001 slot',
  };
  const dir = createSchedHarness([taskX, sibling]);
  try {
    const scheduler = makeScheduler(dir, [taskX, sibling]);

    const rep = {
      id: 'non-conforming-id',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'replacement that needs a collision-free rename',
    };

    const result = await scheduler.replaceTask(taskX.id, [rep]);

    assert.deepStrictEqual(result.inserted, ['001-001-001-001-rp-002'],
      `rename must skip the occupied X-rp-001 and pick X-rp-002, got: [${result.inserted.join(', ')}]`);

    const diskTasks = readMissionTasks(dir, '001-001', '001-001-001');
    assert.ok(!scheduler._tasksById.has('non-conforming-id'),
      '"non-conforming-id" must NOT be in _tasksById');
    assert.ok(!scheduler._pending.has('non-conforming-id'),
      '"non-conforming-id" must NOT be in _pending');
    assert.ok(!('non-conforming-id' in diskTasks),
      '"non-conforming-id" must NOT be persisted in the mission state file');

    assert.ok(scheduler._tasksById.has('001-001-001-001-rp-002'),
      'renamed "001-001-001-001-rp-002" must be in _tasksById');
    assert.ok(scheduler._pending.has('001-001-001-001-rp-002'),
      'renamed "001-001-001-001-rp-002" must be in _pending');
    assert.ok('001-001-001-001-rp-002' in diskTasks,
      'renamed "001-001-001-001-rp-002" must be persisted in the mission state file');

    // The pre-existing occupant is untouched.
    assert.ok(scheduler._tasksById.has('001-001-001-001-rp-001'),
      'pre-existing sibling "001-001-001-001-rp-001" must remain in _tasksById');
  } finally { cleanup(dir); }
});

// ── TC5: cap integrity across generations ────────────────────────────────────
await test('TC5 cap across generations: counter accumulates on canonical X regardless of replacement naming; throws at MAX_REPLAN_ATTEMPTS', async () => {
  const MAX = Scheduler.MAX_REPLAN_ATTEMPTS;
  assert.ok(Number.isInteger(MAX) && MAX >= 2,
    `fixture precondition: Scheduler.MAX_REPLAN_ATTEMPTS must be an integer >= 2, got: ${MAX}`);

  const taskX = makeFailedTaskX();
  const dir = createSchedHarness([taskX]);
  try {
    const scheduler = makeScheduler(dir, [taskX]);

    // Generation 1: conforming replacement (canonical equal) is NOT renamed.
    const gen1 = await scheduler.replaceTask('001-001-001-001', [{
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'gen1 replacement (conforming id)',
    }]);
    assert.deepStrictEqual(gen1.inserted, ['001-001-001-001-rp-001'],
      `conforming id must NOT be renamed, got: [${gen1.inserted.join(', ')}]`);
    assert.strictEqual(scheduler._replanAttempts.get('001-001-001-001'), 1,
      'after gen1 the counter on canonical X must be 1');

    // Generation 2: the replacement becomes the failed task; its replacement
    // carries a NON-conforming id → must be renamed into the same family.
    const gen2 = await scheduler.replaceTask('001-001-001-001-rp-001', [{
      id: 'wild-nonconforming',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'gen2 replacement (non-conforming id)',
    }]);
    assert.strictEqual(gen2.inserted.length, 1,
      `expected 1 inserted gen2 replacement, got: [${gen2.inserted.join(', ')}]`);
    const gen2Id = gen2.inserted[0];
    assert.ok(/^001-001-001-001-rp-001(-rp-\d{3})+$/.test(gen2Id),
      `gen2 replacement must be renamed to \${failedTaskId}-rp-NNN within the X family, got: "${gen2Id}"`);
    assert.ok(!scheduler._tasksById.has('wild-nonconforming'),
      '"wild-nonconforming" must NOT be in _tasksById');
    assert.strictEqual(scheduler._replanAttempts.get('001-001-001-001'), 2,
      'after gen2 the counter must accumulate to 2 on the SAME canonical key "001-001-001-001"');

    // Pre-burn further generations until the cap is reached (no-op when
    // MAX_REPLAN_ATTEMPTS === 2 — gen2 already reached it).
    let latest = gen2Id;
    let gen = 3;
    while ((scheduler._replanAttempts.get('001-001-001-001') ?? 0) < MAX) {
      const r = await scheduler.replaceTask(latest, [{
        id: `wild-gen-${gen}`,
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['src/a.js'],
        dependencies: [],
        description: `gen${gen} replacement (non-conforming id)`,
      }]);
      latest = r.inserted[0];
      gen++;
    }

    // At the cap: the next replaceTask for the same canonical family throws.
    await assert.rejects(
      () => scheduler.replaceTask(latest, [{
        id: 'wild-final',
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['src/a.js'],
        dependencies: [],
        description: 'over-cap replacement (must never be inserted)',
      }]),
      (err) => {
        assert.ok(/cap|attempt/i.test(err.message),
          `cap error must mention the cap/attempts, got: "${err.message}"`);
        return true;
      },
      'replaceTask must throw once the canonical family is at MAX_REPLAN_ATTEMPTS'
    );
  } finally { cleanup(dir); }
});

// ── TC6a: retry budget survives — persisted retryCount at maxRetries ─────────
await test('TC6a retry budget survives: persisted retryCount = config.maxRetries → BLOCKED executor runs exactly once, analyzer dispatched', async () => {
  const { projectRoot, subMissionId } = createPipelineHarness({
    status: 'failed',
    retryCount: config.maxRetries,
  });
  try {
    const { pipeline, getExecCalls, analyzerCalls } = makeBlockedPipeline(projectRoot);

    const task = {
      id: '001-001-001-001',
      missionId: '001-001',
      subMissionId,
      description: 'test task',
      targetFiles: ['src/foo.js'],
      dependencies: [],
    };

    await pipeline._executeAndVerifyTask('001-001', subMissionId, task, 0);

    assert.strictEqual(getExecCalls(), 1,
      `executor must run EXACTLY once when persisted retryCount (${config.maxRetries}) is already at config.maxRetries — no fresh retry chain`);
    assert.strictEqual(analyzerCalls.length, 1,
      `analyzer must be dispatched exactly once, got ${analyzerCalls.length} call(s)`);
    assert.strictEqual(analyzerCalls[0].failureType, 'execution',
      `analyzer must be dispatched for the execution failure, got: "${analyzerCalls[0].failureType}"`);
    assert.ok(analyzerCalls[0].retryCount >= config.maxRetries,
      `analyzer retryCount must reflect the adopted persisted budget (>= ${config.maxRetries}), got: ${analyzerCalls[0].retryCount}`);
  } finally { cleanup(projectRoot); }
});

// ── TC6b: control — persisted retryCount 0 → normal retry chain ──────────────
await test('TC6b control: persisted retryCount = 0 → normal chain runs (executor called maxRetries+1 times, then analyzer)', async () => {
  const { projectRoot, subMissionId } = createPipelineHarness({
    status: 'pending',
    retryCount: 0,
  });
  try {
    const { pipeline, getExecCalls, analyzerCalls } = makeBlockedPipeline(projectRoot);

    const task = {
      id: '001-001-001-001',
      missionId: '001-001',
      subMissionId,
      description: 'test task',
      targetFiles: ['src/foo.js'],
      dependencies: [],
    };

    await pipeline._executeAndVerifyTask('001-001', subMissionId, task, 0);

    assert.strictEqual(getExecCalls(), config.maxRetries + 1,
      `with a fresh budget the BLOCKED executor must run config.maxRetries + 1 = ${config.maxRetries + 1} times, got: ${getExecCalls()}`);
    assert.strictEqual(analyzerCalls.length, 1,
      `analyzer must be dispatched exactly once after the chain is exhausted, got ${analyzerCalls.length} call(s)`);
    assert.strictEqual(analyzerCalls[0].failureType, 'execution',
      `analyzer must be dispatched for the execution failure, got: "${analyzerCalls[0].failureType}"`);
    assert.strictEqual(analyzerCalls[0].retryCount, config.maxRetries,
      `analyzer retryCount must equal config.maxRetries (${config.maxRetries}), got: ${analyzerCalls[0].retryCount}`);
  } finally { cleanup(projectRoot); }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
