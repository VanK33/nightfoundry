/**
 * test-replace-task-cascade.js — Tests for the cascadeComplete integration
 * within Scheduler.replaceTask.
 *
 * Verifies:
 *   TC1. All tasks invalidated with no replacement → sub-mission becomes terminal
 *        (cascadeComplete is triggered and getSubMissionStatus returns 'complete').
 *   TC2. Replacement inserted → sub-mission stays non-terminal, cascade is no-op
 *        (pending replacement blocks the sub-mission gate; status stays 'in_progress').
 *   TC3. cascade throws → replaceTask still completes and error is logged
 *        (monkey-patch cascadeComplete to throw; scheduler swallows the error,
 *        logs it via onLog, and returns { invalidated, inserted } normally).
 *
 * Run: node test/test-replace-task-cascade.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Scheduler } from '../src/orchestrator/core/scheduler.js';
import {
  cascadeComplete,
  getSubMissionStatus,
} from '../src/orchestrator/core/state-machine.js';
import * as stateMachineModule from '../src/orchestrator/core/state-machine.js';

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
 * Follows the same pattern as test-scheduler-replace-task.js.
 */
function createSchedHarness(tasks, { preStatus = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-rp-test-'));
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

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a minimal Scheduler instance with a no-op runTask and preset DAG state.
 * Follows the same pattern as test-scheduler-replace-task.js.
 */
function makeScheduler(harnessDir, tasks, { onLog } = {}) {
  const scheduler = new Scheduler({
    harnessDir,
    projectRoot: harnessDir,
    maxConcurrent: 4,
    runTask: async () => {},
    onLog,
  });
  scheduler._tasksById = new Map(tasks.map((t) => [t.id, t]));
  scheduler._pending = new Set(tasks.map((t) => t.id));
  scheduler._runningFiles = new Set();
  return scheduler;
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {

// ── TC1: all tasks invalidated with no replacement → sub-mission becomes terminal ──

await test('TC1: all tasks invalidated with no replacement → sub-mission becomes terminal', async () => {
  const task = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A',
  };

  const dir = createSchedHarness([task]);
  try {
    const scheduler = makeScheduler(dir, [task]);

    // Replace the single task with an empty replacements array.
    // This invalidates the only task in the sub-mission. After replaceTask,
    // cascadeComplete should be able to complete the sub-mission because all
    // its tasks are now in terminal states ('invalidated').
    const result = await scheduler.replaceTask(task.id, []);

    assert.deepStrictEqual(result.invalidated, [task.id],
      'invalidated should contain only the failed task');
    assert.deepStrictEqual(result.inserted, [],
      'inserted should be empty when no replacements are given');

    // cascadeComplete should have transitioned the sub-mission to 'complete'
    // because all tasks are terminal (invalidated).
    const smStatus = getSubMissionStatus(dir, task.missionId, task.subMissionId);
    assert.strictEqual(smStatus, 'complete',
      `sub-mission status should be 'complete' after all tasks invalidated, got '${smStatus}'`);
  } finally { cleanup(dir); }
});

// ── TC2: replacement inserted → sub-mission stays non-terminal, cascade is no-op ──

await test('TC2: replacement inserted → sub-mission stays non-terminal, cascade is no-op', async () => {
  const task = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A',
  };
  const replacement = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Replacement A',
  };

  const dir = createSchedHarness([task]);
  try {
    const scheduler = makeScheduler(dir, [task]);

    // Replace the task with one replacement. The replacement is inserted as
    // 'pending', so cascadeComplete's gate (all tasks must be terminal) fails
    // with a 'not terminal' error → cascade short-circuits → sub-mission
    // remains 'in_progress'.
    const result = await scheduler.replaceTask(task.id, [replacement]);

    assert.deepStrictEqual(result.invalidated, [task.id],
      'invalidated should contain only the original task');
    assert.deepStrictEqual(result.inserted, [replacement.id],
      'inserted should contain the replacement task ID');

    // Sub-mission must stay 'in_progress' because the replacement task is
    // 'pending' (non-terminal) — cascadeComplete skips the sub-mission gate.
    const smStatus = getSubMissionStatus(dir, task.missionId, task.subMissionId);
    assert.strictEqual(smStatus, 'in_progress',
      `sub-mission status should stay 'in_progress' when a pending replacement exists, got '${smStatus}'`);
  } finally { cleanup(dir); }
});

// ── TC3: cascade throws → replaceTask still completes and error is logged ──────

await test('TC3: cascade throws → replaceTask still completes, returns {invalidated, inserted}, error in onLog', async () => {
  const task = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A',
  };

  const dir = createSchedHarness([task]);
  try {
    const logs = [];

    // Monkey-patch cascadeComplete to throw.
    //
    // We attempt to replace `cascadeComplete` on the imported module namespace
    // so the Scheduler's call to cascadeComplete throws. In strict ESM, module
    // namespace properties are read-only; if the assignment fails we fall back to
    // deleting the mission state file inside onLog (which causes the real
    // cascadeComplete to throw with an ENOENT when it reads the file).
    const throwingCascade = async () => {
      throw new Error('monkey-patched cascade error');
    };
    const originalCascade = cascadeComplete;

    let cascadePatched = false;
    try {
      // Attempt ESM monkey-patch: assign throwing version to the module export.
      stateMachineModule.cascadeComplete = throwingCascade;
      // Verify the patch actually took effect (may silently no-op in strict ESM).
      cascadePatched = stateMachineModule.cascadeComplete === throwingCascade;
    } catch (_patchErr) {
      // Assignment threw (e.g. TypeError in strict-mode ESM) — patch did not apply.
      cascadePatched = false;
    }

    // ESM-compatible fallback: if the monkey-patch could not be applied, delete
    // the mission state file from within onLog so the real cascadeComplete throws
    // ENOENT when it tries to read the file. The "complete —" log fires
    // synchronously just before the cascadeComplete await, so the file will be
    // absent by the time the await resumes.
    const missionStateFilePath = path.join(dir, 'state', `mission-${task.missionId}.json`);
    const onLog = (msg) => {
      logs.push(msg);
      if (!cascadePatched && msg.includes('Scheduler.replaceTask: complete —')) {
        try { fs.unlinkSync(missionStateFilePath); } catch (_) { /* already gone */ }
      }
    };

    const scheduler = makeScheduler(dir, [task], { onLog });

    // replaceTask must NOT throw even though cascadeComplete will throw.
    let result;
    let threw = null;
    try {
      result = await scheduler.replaceTask(task.id, []);
    } catch (err) {
      threw = err;
    } finally {
      // Restore the original cascadeComplete if we managed to patch it.
      if (cascadePatched) {
        try { stateMachineModule.cascadeComplete = originalCascade; } catch (_) {}
      }
    }

    assert.ok(!threw, `replaceTask should not throw even when cascadeComplete throws; got: ${threw?.message}`);
    assert.ok(result, 'replaceTask should return a result object');
    assert.deepStrictEqual(result.invalidated, [task.id],
      'invalidated should contain the failed task ID');
    assert.deepStrictEqual(result.inserted, [],
      'inserted should be empty when no replacements are given');

    // The cascade error must have been captured in the onLog output.
    const cascadeErrorLog = logs.find((m) => m.includes('cascade after replaceTask threw'));
    assert.ok(
      cascadeErrorLog,
      `expected a log entry containing "cascade after replaceTask threw", got logs:\n${logs.join('\n')}`
    );
  } finally { cleanup(dir); }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
