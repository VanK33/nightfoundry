/**
 * test-scheduler-normalize.js — Verifies that the Scheduler's
 * file-conflict detection works correctly with mixed path forms.
 *
 * TC1: relative 'src/a.js' in runningFiles conflicts with absolute
 *      '/proj/src/a.js' in a candidate task.
 * TC2: absolute '/proj/src/b.js' in runningFiles conflicts with
 *      relative 'src/b.js' in a candidate task.
 * TC3: './src/c.js' in runningFiles conflicts with 'src/c.js' in
 *      a candidate task.
 *
 * Run: node test/test-scheduler-normalize.js
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

// ── Fixture helpers ──────────────────────────────────────────────────

/**
 * Create a minimal harness directory with a state.json and per-mission
 * state files for each task. The `projectRoot` is a fixed string used
 * only for path normalisation — it does not need to exist on disk.
 *
 * @param {Array<{id, targetFiles, dependencies?}>} tasks
 * @returns {string} harnessDir
 */
function createMinimalHarness(tasks) {
  const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-norm-'));
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });

  // Minimal state.json — the Scheduler constructor reads this to hydrate
  // _replanAttempts; an empty scheduler section is sufficient.
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({ scheduler: { replanAttempts: {} } }, null, 2)
  );

  // Group tasks by missionId so we can write one state file per mission.
  const missionGroups = {};
  for (const task of tasks) {
    const parts = task.id.split('-');
    const missionId    = `${parts[0]}-${parts[1]}`;
    const subMissionId = `${parts[0]}-${parts[1]}-${parts[2]}`;
    if (!missionGroups[missionId]) missionGroups[missionId] = {};
    if (!missionGroups[missionId][subMissionId]) {
      missionGroups[missionId][subMissionId] = {};
    }
    missionGroups[missionId][subMissionId][task.id] = {
      id: task.id,
      description: `task ${task.id}`,
      status: 'pending',
      targetFiles: task.targetFiles || [],
      dependencies: task.dependencies || [],
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      retryCount: 0,
    };
  }

  // Write one mission-<missionId>.json per mission.
  for (const [missionId, subMissions] of Object.entries(missionGroups)) {
    const subMissionsObj = {};
    for (const [subMissionId, taskMap] of Object.entries(subMissions)) {
      subMissionsObj[subMissionId] = {
        id: subMissionId,
        description: `sub-mission ${subMissionId}`,
        status: 'pending',
        tasks: taskMap,
      };
    }
    const missionState = {
      id: missionId,
      missionId,
      description: `mission ${missionId}`,
      status: 'pending',
      subMissions: subMissionsObj,
    };
    fs.writeFileSync(
      path.join(harnessDir, 'state', `mission-${missionId}.json`),
      JSON.stringify(missionState, null, 2)
    );
  }

  return harnessDir;
}

function cleanup(harnessDir) {
  fs.rmSync(harnessDir, { recursive: true, force: true });
}

/**
 * Build a taskDAG entry — the shape expected by Scheduler.runMilestone.
 * missionId and subMissionId are derived from the task ID so callers
 * don't have to repeat them.
 */
function makeTask({ id, targetFiles, dependencies = [] }) {
  const parts = id.split('-');
  return {
    id,
    missionId:    `${parts[0]}-${parts[1]}`,
    subMissionId: `${parts[0]}-${parts[1]}-${parts[2]}`,
    description:  `task ${id}`,
    targetFiles:  targetFiles || [],
    dependencies,
    testCases: [],
    patternReferences: [],
    dataSchemas: [],
  };
}

/**
 * Create a Scheduler backed by a mock runTask that:
 *   - Records which other tasks were already running at start time.
 *   - Simulates a short async delay so file-conflict serialization is
 *     exercised: the second (conflicting) task must wait for the first.
 *
 * Returns { scheduler, trace } where trace.runningDuringStart is an
 * array of { taskId, concurrent: Set<string> } entries.
 */
function makeSchedulerWithTrace(harnessDir, { projectRoot, delay = 20 } = {}) {
  const trace = { runningDuringStart: [] };
  const running = new Set();

  const runTask = async (task) => {
    // Record which tasks were already running when this task was dispatched.
    trace.runningDuringStart.push({ taskId: task.id, concurrent: new Set(running) });
    running.add(task.id);
    await new Promise((r) => setTimeout(r, delay));
    running.delete(task.id);
  };

  const scheduler = new Scheduler({
    harnessDir,
    projectRoot,
    maxConcurrent: 2,   // Allow up to 2 concurrent — ensures we see a conflict
    runTask,
    onLog: () => {},
    onProgress: () => {},
  });

  return { scheduler, trace };
}

// ── Tests ────────────────────────────────────────────────────────────

async function run() {

// ── TC1 ──────────────────────────────────────────────────────────────
await test(
  "TC1: relative 'src/a.js' conflicts with absolute '/proj/src/a.js'",
  async () => {
    // projectRoot is /proj.  Task A uses a relative path; Task B uses
    // the equivalent absolute path.  Without normalisation they would
    // not match and both tasks could run in parallel.  With
    // normalisation both resolve to /proj/src/a.js, so Task B must
    // wait until Task A has finished.
    const PROJECT_ROOT = '/proj';

    const rawTasks = [
      { id: '001-001-001-001', targetFiles: ['src/a.js'] },
      { id: '001-001-001-002', targetFiles: ['/proj/src/a.js'] },
    ];

    const harnessDir = createMinimalHarness(rawTasks);
    const taskDAG = rawTasks.map(makeTask);

    try {
      const { scheduler, trace } = makeSchedulerWithTrace(harnessDir, {
        projectRoot: PROJECT_ROOT,
      });

      await scheduler.runMilestone('001', taskDAG);

      // Both tasks must have run.
      assert.ok(
        trace.runningDuringStart.length === 2,
        `expected 2 tasks to run, got ${trace.runningDuringStart.length}`
      );

      // When task 001-001-001-002 (absolute path) started, task
      // 001-001-001-001 (relative path) must NOT have been running.
      const entry002 = trace.runningDuringStart.find(
        (e) => e.taskId === '001-001-001-002'
      );
      assert.ok(entry002, 'task 001-001-001-002 must have run');
      assert.ok(
        !entry002.concurrent.has('001-001-001-001'),
        'task with absolute /proj/src/a.js must not overlap task with relative src/a.js'
      );
    } finally {
      cleanup(harnessDir);
    }
  }
);

// ── TC2 ──────────────────────────────────────────────────────────────
await test(
  "TC2: absolute '/proj/src/b.js' conflicts with relative 'src/b.js'",
  async () => {
    // Task A uses the absolute path; Task B uses the equivalent relative
    // path.  Reversed order compared with TC1.
    const PROJECT_ROOT = '/proj';

    const rawTasks = [
      { id: '001-002-001-001', targetFiles: ['/proj/src/b.js'] },
      { id: '001-002-001-002', targetFiles: ['src/b.js'] },
    ];

    const harnessDir = createMinimalHarness(rawTasks);
    const taskDAG = rawTasks.map(makeTask);

    try {
      const { scheduler, trace } = makeSchedulerWithTrace(harnessDir, {
        projectRoot: PROJECT_ROOT,
      });

      await scheduler.runMilestone('001', taskDAG);

      assert.ok(
        trace.runningDuringStart.length === 2,
        `expected 2 tasks to run, got ${trace.runningDuringStart.length}`
      );

      // When task 001-002-001-002 (relative path) started, task
      // 001-002-001-001 (absolute path) must NOT have been running.
      const entry002 = trace.runningDuringStart.find(
        (e) => e.taskId === '001-002-001-002'
      );
      assert.ok(entry002, 'task 001-002-001-002 must have run');
      assert.ok(
        !entry002.concurrent.has('001-002-001-001'),
        'task with relative src/b.js must not overlap task with absolute /proj/src/b.js'
      );
    } finally {
      cleanup(harnessDir);
    }
  }
);

// ── TC3 ──────────────────────────────────────────────────────────────
await test(
  "TC3: './src/c.js' conflicts with 'src/c.js'",
  async () => {
    // Task A uses a dot-relative path; Task B uses the canonical
    // relative path.  path.resolve('/proj', './src/c.js') and
    // path.resolve('/proj', 'src/c.js') both yield /proj/src/c.js,
    // so the conflict must be detected.
    const PROJECT_ROOT = '/proj';

    const rawTasks = [
      { id: '001-003-001-001', targetFiles: ['./src/c.js'] },
      { id: '001-003-001-002', targetFiles: ['src/c.js'] },
    ];

    const harnessDir = createMinimalHarness(rawTasks);
    const taskDAG = rawTasks.map(makeTask);

    try {
      const { scheduler, trace } = makeSchedulerWithTrace(harnessDir, {
        projectRoot: PROJECT_ROOT,
      });

      await scheduler.runMilestone('001', taskDAG);

      assert.ok(
        trace.runningDuringStart.length === 2,
        `expected 2 tasks to run, got ${trace.runningDuringStart.length}`
      );

      // When task 001-003-001-002 ('src/c.js') started, task
      // 001-003-001-001 ('./src/c.js') must NOT have been running.
      const entry002 = trace.runningDuringStart.find(
        (e) => e.taskId === '001-003-001-002'
      );
      assert.ok(entry002, 'task 001-003-001-002 must have run');
      assert.ok(
        !entry002.concurrent.has('001-003-001-001'),
        "task with 'src/c.js' must not overlap task with './src/c.js'"
      );
    } finally {
      cleanup(harnessDir);
    }
  }
);

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
