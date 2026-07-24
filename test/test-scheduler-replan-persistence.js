/**
 * test-scheduler-replan-persistence.js — Unit tests for Scheduler._replanAttempts
 * hydration from persisted state.json on construction.
 *
 * Tests:
 *  TC1: Construct Scheduler with no state.json → _replanAttempts.size === 0
 *  TC2: Construct with state.json containing scheduler.replanAttempts
 *       {'001-001-001-001': 1} → _replanAttempts.get('001-001-001-001') === 1
 *  TC3: Construct with state.json missing scheduler subtree entirely
 *       → empty Map, no crash
 *  TC4: Construct with malformed replanAttempts (value is string 'abc')
 *       → entry skipped, warning logged via onLog, no crash
 *
 * Run: node test/test-scheduler-replan-persistence.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Scheduler } from '../src/orchestrator/core/scheduler.js';

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
 * state files for the given tasks (all start as 'pending').
 * Mirrors the pattern from test-scheduler-replace-task.js so TC5–TC7 can
 * call replaceTask without missing task entries in the mission state file.
 */
function createSchedHarness(tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-rp-'));
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
          status: 'pending',
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
 * Build a Scheduler with the given tasks pre-loaded into the in-memory DAG
 * (_tasksById, _pending, _runningFiles). Used by TC5–TC7 so replaceTask
 * can be invoked without first running runMilestone.
 */
function makeSchedulerWithTasks(harnessDir, tasks) {
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

/**
 * Create a minimal temp harness dir with:
 *  - state/ subdirectory
 *  - a minimal mission state file
 *  - state.json containing the provided extra top-level fields merged in
 *
 * @param {object} [stateExtra={}] Extra fields merged into the root of state.json.
 *   Pass `undefined` as `stateExtra` to skip writing state.json entirely (TC1).
 */
function createHarnessDir({ stateExtra } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-persist-test-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });

  // Minimal mission state file so the Scheduler constructor doesn't error
  // if it tries to read per-mission state.
  const missionState = {
    id: '001-001',
    missionId: '001-001',
    description: 'test mission',
    status: 'in_progress',
    subMissions: {
      '001-001-001': {
        id: '001-001-001',
        status: 'in_progress',
        tasks: {},
      },
    },
  };
  fs.writeFileSync(
    path.join(dir, 'state', 'mission-001-001.json'),
    JSON.stringify(missionState, null, 2)
  );

  // Write state.json only when stateExtra is explicitly provided (including {})
  if (stateExtra !== undefined) {
    const base = {
      projectMeta: {
        prdPath: '',
        createdAt: new Date().toISOString(),
        currentPhase: 'executing',
      },
      globalStatus: 'active',
      milestones: {
        '001': {
          id: '001',
          status: 'in_progress',
          missions: {
            '001-001': {
              id: '001-001',
              status: 'in_progress',
              stateFile: '.harness/state/mission-001-001.json',
            },
          },
        },
      },
    };
    const merged = Object.assign({}, base, stateExtra);
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify(merged, null, 2)
    );
  }

  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a minimal Scheduler instance. Does NOT override _replanAttempts so
 * that the constructor's hydration logic runs unimpeded.
 */
function makeScheduler(harnessDir, { onLog = () => {} } = {}) {
  return new Scheduler({
    harnessDir,
    projectRoot: harnessDir,
    maxConcurrent: 4,
    runTask: async () => {},
    onLog,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {

// ── TC1: No state.json → _replanAttempts.size === 0 ────────────────────────
await test('TC1: no state.json → _replanAttempts.size === 0', async () => {
  // createHarnessDir with no arguments omits state.json entirely
  const dir = createHarnessDir();
  try {
    const scheduler = makeScheduler(dir);

    assert.ok(
      scheduler._replanAttempts instanceof Map,
      '_replanAttempts should be a Map'
    );
    assert.strictEqual(
      scheduler._replanAttempts.size, 0,
      `_replanAttempts.size should be 0 when there is no state.json, got ${scheduler._replanAttempts.size}`
    );
  } finally { cleanup(dir); }
});

// ── TC2: Hydration round-trip ─────────────────────────────────────────────
await test('TC2: state.json with scheduler.replanAttempts {"001-001-001-001": 1} → hydrated correctly', async () => {
  const dir = createHarnessDir({
    stateExtra: {
      scheduler: {
        replanAttempts: { '001-001-001-001': 1 },
      },
    },
  });
  try {
    const scheduler = makeScheduler(dir);

    assert.ok(
      scheduler._replanAttempts instanceof Map,
      '_replanAttempts should be a Map'
    );
    assert.strictEqual(
      scheduler._replanAttempts.get('001-001-001-001'), 1,
      `_replanAttempts.get('001-001-001-001') should be 1, got ${scheduler._replanAttempts.get('001-001-001-001')}`
    );
    assert.strictEqual(
      scheduler._replanAttempts.size, 1,
      `_replanAttempts.size should be 1, got ${scheduler._replanAttempts.size}`
    );
  } finally { cleanup(dir); }
});

// ── TC3: Missing scheduler subtree → empty Map ────────────────────────────
await test('TC3: state.json with no scheduler subtree → empty Map, no crash', async () => {
  // Pass an empty stateExtra so state.json is written but has no scheduler key
  const dir = createHarnessDir({ stateExtra: {} });
  try {
    let threw = null;
    let scheduler;
    try {
      scheduler = makeScheduler(dir);
    } catch (err) {
      threw = err;
    }

    assert.ok(!threw, `Scheduler constructor should not throw, got: ${threw?.message}`);
    assert.ok(
      scheduler._replanAttempts instanceof Map,
      '_replanAttempts should be a Map'
    );
    assert.strictEqual(
      scheduler._replanAttempts.size, 0,
      `_replanAttempts.size should be 0 when scheduler subtree is absent, got ${scheduler._replanAttempts.size}`
    );
  } finally { cleanup(dir); }
});

// ── TC4: Malformed string value → skipped with warning ───────────────────
await test('TC4: malformed replanAttempts value (string "abc") → entry skipped, warning logged, no crash', async () => {
  const dir = createHarnessDir({
    stateExtra: {
      scheduler: {
        replanAttempts: { '001-001-001-001': 'abc' },
      },
    },
  });
  try {
    const logs = [];
    const onLog = (msg) => logs.push(msg);

    let threw = null;
    let scheduler;
    try {
      scheduler = makeScheduler(dir, { onLog });
    } catch (err) {
      threw = err;
    }

    assert.ok(!threw, `Scheduler constructor should not throw, got: ${threw?.message}`);
    assert.ok(
      scheduler._replanAttempts instanceof Map,
      '_replanAttempts should be a Map'
    );
    assert.strictEqual(
      scheduler._replanAttempts.size, 0,
      `malformed entry should be skipped, _replanAttempts.size should be 0, got ${scheduler._replanAttempts.size}`
    );
    assert.ok(
      !scheduler._replanAttempts.has('001-001-001-001'),
      'malformed entry should NOT appear in _replanAttempts'
    );

    // A warning must have been emitted via onLog
    const warnLogged = logs.some((msg) =>
      /warning/i.test(msg) && /001-001-001-001/.test(msg)
    );
    assert.ok(
      warnLogged,
      `expected a warning log mentioning the task ID '001-001-001-001', got logs: ${JSON.stringify(logs)}`
    );
  } finally { cleanup(dir); }
});

// ── TC5: replaceTask increment → state.json on disk has updated count ────────
await test('TC5: replaceTask increment → state.json on disk has scheduler.replanAttempts with count', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A',
  };
  const dir = createSchedHarness([taskA]);
  try {
    const scheduler = makeSchedulerWithTasks(dir, [taskA]);

    const replacement = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'Replacement 1',
    };

    await scheduler.replaceTask(taskA.id, [replacement]);

    // Read state.json from disk and verify the persisted count
    const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    const state = JSON.parse(raw);

    assert.ok(
      state.scheduler?.replanAttempts,
      'state.json must have a scheduler.replanAttempts object after replaceTask'
    );
    assert.strictEqual(
      state.scheduler.replanAttempts['001-001-001-001'], 1,
      `state.json scheduler.replanAttempts['001-001-001-001'] should be 1, ` +
      `got ${state.scheduler.replanAttempts['001-001-001-001']}`
    );
  } finally { cleanup(dir); }
});

// ── TC6: increment then re-construct Scheduler → hydrated count matches ───────
await test('TC6: increment via replaceTask (count=1) → new Scheduler from same harnessDir → _replanAttempts.get(originalId) === 1', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A',
  };
  const dir = createSchedHarness([taskA]);
  try {
    const scheduler = makeSchedulerWithTasks(dir, [taskA]);

    const replacement = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'Replacement 1',
    };

    await scheduler.replaceTask(taskA.id, [replacement]);

    // Simulate a new process: construct a fresh Scheduler from the same harnessDir.
    // Its constructor hydrates _replanAttempts from the persisted state.json.
    const scheduler2 = makeScheduler(dir);

    assert.strictEqual(
      scheduler2._replanAttempts.get('001-001-001-001'), 1,
      `new Scheduler should hydrate _replanAttempts.get('001-001-001-001') === 1, ` +
      `got ${scheduler2._replanAttempts.get('001-001-001-001')}`
    );
  } finally { cleanup(dir); }
});

// ── TC7: cap exhaustion across process boundaries → new Scheduler throws ──────
await test('TC7: exhaust cap across processes → new Scheduler throws on next replan attempt', async () => {
  const MAX = Scheduler.MAX_REPLAN_ATTEMPTS;

  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A',
  };
  const dir = createSchedHarness([taskA]);
  try {
    // "Process 1": exhaust the replan cap via MAX successive replaceTask calls.
    const scheduler = makeSchedulerWithTasks(dir, [taskA]);

    // Track each replacement task object in order so we know the last active ID.
    const allTasks = [taskA];
    let lastActiveId = taskA.id;

    for (let i = 1; i <= MAX; i++) {
      const nextRp = {
        id: `001-001-001-001-rp-00${i}`,
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['src/a.js'],
        dependencies: [],
        description: `Replacement ${i}`,
      };
      await scheduler.replaceTask(lastActiveId, [nextRp]);
      lastActiveId = nextRp.id;
      allTasks.push(nextRp);
    }

    assert.strictEqual(
      scheduler._replanAttempts.get('001-001-001-001'), MAX,
      `after ${MAX} replaceTask calls, in-memory count should be ${MAX}`
    );

    // Verify state.json on disk has count = MAX
    const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    const state = JSON.parse(raw);
    assert.strictEqual(
      state.scheduler.replanAttempts['001-001-001-001'], MAX,
      `state.json should have replanAttempts['001-001-001-001'] = ${MAX}, ` +
      `got ${state.scheduler.replanAttempts['001-001-001-001']}`
    );

    // "Process 2": construct a brand-new Scheduler (simulating process restart).
    // The constructor hydrates _replanAttempts = MAX from state.json.
    const scheduler2 = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 4,
      runTask: async () => {},
    });
    // Wire up in-memory DAG for the last active replacement task.
    const lastActiveTask = allTasks[allTasks.length - 1];
    scheduler2._tasksById = new Map([[lastActiveTask.id, lastActiveTask]]);
    scheduler2._pending = new Set([lastActiveTask.id]);
    scheduler2._runningFiles = new Set();

    assert.strictEqual(
      scheduler2._replanAttempts.get('001-001-001-001'), MAX,
      `new Scheduler should have hydrated count = ${MAX}, ` +
      `got ${scheduler2._replanAttempts.get('001-001-001-001')}`
    );

    // Attempt another replaceTask on the new Scheduler — must throw cap exceeded.
    const overCapRp = {
      id: '001-001-001-001-rp-999',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'Should be blocked by cap',
    };

    let threw = null;
    try {
      await scheduler2.replaceTask(lastActiveTask.id, [overCapRp]);
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, 'new Scheduler should throw when the replan cap is already exhausted');
    assert.ok(
      /replan cap/i.test(threw.message),
      `error message should mention "replan cap", got: ${threw.message}`
    );
  } finally { cleanup(dir); }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} test(s): ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
