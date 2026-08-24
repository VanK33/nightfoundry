/**
 * test-scheduler-stall-rescue.js — Scheduler stall-boundary rescue test.
 *
 * TC1: a task that was pre-terminal ('complete') at DAG-build time and is
 * demoted to 'needs_revalidation' mid-run (after its own build-time
 * classification already skipped it) must be picked up by the scheduler's
 * stall-boundary rescue: once every other task's dependency chain stalls on
 * it, the scheduler re-scans on-disk status for exactly this case and
 * re-adds the task to `pending` for a verifier-only dispatch instead of
 * throwing a spurious dependency-stall error.
 *
 * Run: node test/test-scheduler-stall-rescue.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Scheduler } from '../src/orchestrator/core/scheduler.js';
import { readTaskStatus } from '../src/orchestrator/core/state.js';

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
 * Create a temp project root with a .harness subdirectory and the given
 * mission layout. Every task can be seeded with a pre-run status via
 * `preStatus` (keyed by task id; defaults to 'pending' when absent).
 */
function createStallHarness({
  milestoneId = '001',
  missions,
  preStatus = {},
}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-stall-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const missionEntries = {};
  for (const mission of missions) {
    missionEntries[mission.id] = {
      id: mission.id,
      description: `mission ${mission.id}`,
      status: 'in_progress',
      stateFile: `.harness/state/mission-${mission.id}.json`,
      planFile: `.harness/plan/mission-${mission.id}.md`,
    };

    const tasks = {};
    for (const task of mission.tasks) {
      const taskStatus = preStatus[task.id] || 'pending';
      tasks[task.id] = {
        id: task.id,
        description: task.description || `task ${task.id}`,
        status: taskStatus,
        dependencies: task.dependencies || [],
        targetFiles: task.targetFiles || [],
        verifyFile: `.harness/verify/task-${task.id}.json`,
        progressFile: `.harness/progress/task-${task.id}.json`,
        verificationFile: `.harness/verification/task-${task.id}.json`,
      };

      // Source files for the task under the project root.
      for (const f of task.targetFiles || []) {
        const full = path.join(projectRoot, f);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (!fs.existsSync(full)) fs.writeFileSync(full, `// ${f}\n`);
      }

      // verify.json stub
      fs.writeFileSync(
        path.join(harnessDir, 'verify', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, targetFiles: task.targetFiles || [], hardChecks: [], testCases: [] })
      );

      // Pre-seed a PASSED verification sidecar for tasks seeded 'complete'.
      if (taskStatus === 'complete') {
        fs.writeFileSync(
          path.join(harnessDir, 'verification', `task-${task.id}.json`),
          JSON.stringify({ result: 'PASSED', verified: true })
        );
      }
    }

    const subMissionId = `${mission.id}-001`;
    const missionState = {
      id: mission.id,
      missionId: mission.id,
      description: `mission ${mission.id}`,
      status: 'in_progress',
      subMissions: {
        [subMissionId]: {
          id: subMissionId,
          description: 'sm',
          status: 'in_progress',
          tasks,
        },
      },
    };
    fs.writeFileSync(
      path.join(harnessDir, 'state', `mission-${mission.id}.json`),
      JSON.stringify(missionState, null, 2)
    );
  }

  const state = {
    projectMeta: {
      prdPath: '',
      createdAt: new Date().toISOString(),
      currentPhase: 'executing',
    },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId,
        description: `milestone ${milestoneId}`,
        status: 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: missionEntries,
      },
    },
  };

  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  return { projectRoot, harnessDir };
}

function cleanup(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

function readTaskState(harnessDir, missionId, subMissionId, taskId) {
  const state = JSON.parse(
    fs.readFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), 'utf8')
  );
  return state.subMissions[subMissionId].tasks[taskId];
}

/**
 * Rewrite a single task's status directly in its on-disk mission state
 * file — disk is the source of truth, so tests mutate it in place rather
 * than going through the (parent-level) state-machine transition table.
 */
function setTaskStatus(harnessDir, missionId, subMissionId, taskId, status) {
  const filePath = path.join(harnessDir, 'state', `mission-${missionId}.json`);
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  state.subMissions[subMissionId].tasks[taskId].status = status;
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

// ── TC1: stall-boundary rescue ──────────────────────────────────────────

await test('TC1 RESCUE: task demoted complete→needs_revalidation mid-run is re-adopted from the stall block', async () => {
  const missionId = '001-001';
  const subMissionId = `${missionId}-001`;
  const aId = '001-001-001-001';
  const bId = '001-001-001-002';
  const cId = '001-001-001-003';

  const missions = [{
    id: missionId,
    tasks: [
      { id: aId, targetFiles: ['src/a.js'], dependencies: [] },
      { id: bId, targetFiles: ['src/b.js'], dependencies: [{ taskId: aId, type: 'hard' }] },
      { id: cId, targetFiles: ['src/c.js'], dependencies: [] },
    ],
  }];

  const preStatus = { [aId]: 'complete' };

  const { projectRoot, harnessDir } = createStallHarness({ missions, preStatus });

  try {
    const taskA = { id: aId, missionId, subMissionId, description: 'Task A', targetFiles: ['src/a.js'], dependencies: [] };
    const taskB = { id: bId, missionId, subMissionId, description: 'Task B', targetFiles: ['src/b.js'], dependencies: [{ taskId: aId, type: 'hard' }] };
    const taskC = { id: cId, missionId, subMissionId, description: 'Task C', targetFiles: ['src/c.js'], dependencies: [] };

    // Order matters: with maxConcurrent 1, both B (dep A already complete)
    // and C (no deps) are assignable at build time — placing C ahead of B
    // in the DAG (and thus in the `pending` Set's insertion order) ensures
    // C is dispatched first.
    const taskDAG = [taskA, taskC, taskB];

    const trace = [];

    const runTask = async (task) => {
      // Read the task's status FRESH from disk at dispatch time — this is
      // the verifier-only dispatch seam the rescue must exercise for A.
      const statusAtDispatch = readTaskStatus(harnessDir, task.id);
      trace.push({ id: task.id, statusAtDispatch });

      if (task.id === cId) {
        // While C is "running", demote A on disk — this is what strands
        // the pre-terminal classification the scheduler made for A at
        // DAG-build time and forces B's dependency check to stall until
        // the rescue re-adopts A.
        setTaskStatus(harnessDir, missionId, subMissionId, aId, 'needs_revalidation');
      }

      setTaskStatus(harnessDir, missionId, subMissionId, task.id, 'complete');
    };

    const scheduler = new Scheduler({
      harnessDir,
      projectRoot,
      maxConcurrent: 1,
      runTask,
    });

    await scheduler.runMilestone('001', taskDAG);

    const aEntry = trace.find((t) => t.id === aId);
    assert.ok(aEntry, `expected a trace entry for task A, got trace=${JSON.stringify(trace)}`);
    assert.strictEqual(
      aEntry.statusAtDispatch,
      'needs_revalidation',
      `expected A's statusAtDispatch to be 'needs_revalidation' (verifier-only dispatch seam), got '${aEntry.statusAtDispatch}'`
    );

    const finalA = readTaskState(harnessDir, missionId, subMissionId, aId);
    const finalB = readTaskState(harnessDir, missionId, subMissionId, bId);
    const finalC = readTaskState(harnessDir, missionId, subMissionId, cId);

    assert.strictEqual(finalA.status, 'complete', `expected A 'complete', got '${finalA.status}'`);
    assert.strictEqual(finalB.status, 'complete', `expected B 'complete', got '${finalB.status}'`);
    assert.strictEqual(finalC.status, 'complete', `expected C 'complete', got '${finalC.status}'`);
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC2: genuine stall still throws ──────────────────────────────────────

await test('TC2 GENUINE STALL: pending task hard-depending on a blocked task rejects with unchanged message shape and dispatches nothing', async () => {
  const missionId = '001-001';
  const subMissionId = `${missionId}-001`;
  const xId = '001-001-001-001';
  const yId = '001-001-001-002';

  const missions = [{
    id: missionId,
    tasks: [
      { id: xId, targetFiles: ['src/x.js'], dependencies: [] },
      { id: yId, targetFiles: ['src/y.js'], dependencies: [{ taskId: xId, type: 'hard' }] },
    ],
  }];

  // X is seeded 'blocked' on disk — a real, existing task whose hard
  // dependency will never resolve to complete/invalidated. No task
  // anywhere on disk is 'needs_revalidation', so the stall-boundary
  // rescue scan must find nothing to re-adopt.
  const preStatus = { [xId]: 'blocked' };

  const { projectRoot, harnessDir } = createStallHarness({ missions, preStatus });

  try {
    const taskY = { id: yId, missionId, subMissionId, description: 'Task Y', targetFiles: ['src/y.js'], dependencies: [{ taskId: xId, type: 'hard' }] };
    // Only Y is in the DAG — X is never dispatched (it's not part of this
    // taskDAG at all, only present on disk), so its 'blocked' status can
    // never become terminal within this run.
    const taskDAG = [taskY];

    const trace = [];
    const runTask = async (task) => {
      trace.push({ id: task.id });
      setTaskStatus(harnessDir, missionId, subMissionId, task.id, 'complete');
    };

    const scheduler = new Scheduler({
      harnessDir,
      projectRoot,
      maxConcurrent: 1,
      runTask,
    });

    let thrown = null;
    try {
      await scheduler.runMilestone('001', taskDAG);
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'expected runMilestone to reject on a genuine dependency stall');
    assert.ok(thrown instanceof Error, `expected the rejection to be an Error, got: ${thrown}`);
    // The existing message shape must be unchanged by the rescue work.
    assert.ok(
      thrown.message.startsWith('Scheduler stall:'),
      `expected message to start with the exact prefix 'Scheduler stall:', got: ${thrown.message}`
    );
    assert.ok(
      thrown.message.includes(yId),
      `expected message to name Y's task id (${yId}), got: ${thrown.message}`
    );
    // Nothing rescuable existed (no needs_revalidation task anywhere on
    // disk), so the rescue must not have fabricated a dispatch.
    assert.strictEqual(trace.length, 0, `expected no dispatches, but trace=${JSON.stringify(trace)}`);

    const finalX = readTaskState(harnessDir, missionId, subMissionId, xId);
    const finalY = readTaskState(harnessDir, missionId, subMissionId, yId);
    assert.strictEqual(finalX.status, 'blocked', `expected X to remain 'blocked', got '${finalX.status}'`);
    assert.strictEqual(finalY.status, 'pending', `expected Y to remain 'pending' (never dispatched), got '${finalY.status}'`);
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC3: rescue is bounded (no infinite loop) ────────────────────────────

await test('TC3 BOUNDED: a task that re-demotes itself after being rescued is only rescued once, then a genuine stall throws', async () => {
  const missionId = '001-001';
  const subMissionId = `${missionId}-001`;
  const aId = '001-001-001-001';
  const bId = '001-001-001-002';
  const cId = '001-001-001-003';

  const missions = [{
    id: missionId,
    tasks: [
      { id: aId, targetFiles: ['src/a.js'], dependencies: [] },
      { id: bId, targetFiles: ['src/b.js'], dependencies: [{ taskId: aId, type: 'hard' }] },
      { id: cId, targetFiles: ['src/c.js'], dependencies: [] },
    ],
  }];

  const preStatus = { [aId]: 'complete' };

  const { projectRoot, harnessDir } = createStallHarness({ missions, preStatus });

  try {
    const taskA = { id: aId, missionId, subMissionId, description: 'Task A', targetFiles: ['src/a.js'], dependencies: [] };
    const taskB = { id: bId, missionId, subMissionId, description: 'Task B', targetFiles: ['src/b.js'], dependencies: [{ taskId: aId, type: 'hard' }] };
    const taskC = { id: cId, missionId, subMissionId, description: 'Task C', targetFiles: ['src/c.js'], dependencies: [] };

    // Same ordering trick as TC1: C is picked before B so C's runTask fires
    // first and can demote A while B is still blocked on A.
    const taskDAG = [taskA, taskC, taskB];

    const aDispatches = [];

    const runTask = async (task) => {
      if (task.id === cId) {
        // Demote A on disk while C "runs" — strands B and forces the
        // stall-boundary rescue to re-adopt A, exactly as in TC1.
        setTaskStatus(harnessDir, missionId, subMissionId, aId, 'needs_revalidation');
        setTaskStatus(harnessDir, missionId, subMissionId, task.id, 'complete');
        return;
      }
      if (task.id === aId) {
        // Record every dispatch of A. Instead of resolving A to 'complete'
        // like TC1 does, re-demote it to 'needs_revalidation' — simulating
        // a verifier-only rerun that keeps failing to land a terminal
        // status. If the rescue were unbounded, the scheduler would keep
        // re-adding A to `pending` forever and never terminate. Because
        // rescues are capped at one-per-task-per-run (_rescuedRevalIds),
        // this must NOT cause a second rescue: it must fall through to a
        // genuine dependency stall on B instead of looping.
        aDispatches.push(task.id);
        setTaskStatus(harnessDir, missionId, subMissionId, aId, 'needs_revalidation');
        return;
      }
      // B should never be dispatched — its dependency on A never becomes
      // terminal in this scenario.
      setTaskStatus(harnessDir, missionId, subMissionId, task.id, 'complete');
    };

    const scheduler = new Scheduler({
      harnessDir,
      projectRoot,
      maxConcurrent: 1,
      runTask,
    });

    let thrown = null;
    try {
      await scheduler.runMilestone('001', taskDAG);
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'expected runMilestone to throw once the one-shot rescue is exhausted and B remains permanently stalled');
    assert.match(thrown.message, /Scheduler stall/, `expected a "Scheduler stall" error, got: ${thrown.message}`);

    // A must have been rescued/dispatched exactly once — not repeatedly.
    assert.strictEqual(aDispatches.length, 1, `expected exactly one rescue dispatch of A, got ${aDispatches.length}: ${JSON.stringify(aDispatches)}`);

    // B was never assignable (A never reached a terminal state) so it was
    // never dispatched and remains 'pending' on disk.
    const finalB = readTaskState(harnessDir, missionId, subMissionId, bId);
    assert.strictEqual(finalB.status, 'pending', `expected B to remain 'pending', got '${finalB.status}'`);

    // A ends up stuck in 'needs_revalidation' — the bounded rescue does not
    // retry it again within this run.
    const finalA = readTaskState(harnessDir, missionId, subMissionId, aId);
    assert.strictEqual(finalA.status, 'needs_revalidation', `expected A to remain 'needs_revalidation', got '${finalA.status}'`);
  } finally {
    cleanup(projectRoot);
  }
});

// ── withTimeout helper ───────────────────────────────────────────────────

/**
 * withTimeout(promise, ms) — races `promise` against a timer of `ms`
 * milliseconds. If `promise` settles first, its outcome (resolve or reject)
 * is forwarded unchanged. If the timer fires first, the returned promise
 * rejects with an Error whose message is prefixed distinctly from the
 * scheduler's own 'Scheduler stall:' error, so an unbounded rescue loop
 * (one that never lets `runMilestone` settle) fails the test case instead
 * of hanging the whole suite.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`withTimeout: promise did not settle within ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// ── TC3 BOUNDEDNESS: rescue is dispatched at most once per task ─────────

await test("TC3 BOUNDEDNESS: a task still needs_revalidation after its rescue dispatch is dispatched exactly once and the second stall rejects with the existing 'Scheduler stall:' message", async () => {
  const missionId = '001-001';
  const subMissionId = `${missionId}-001`;
  const rId = '001-001-001-004';
  const sId = '001-001-001-005';
  const tId = '001-001-001-006';

  const missions = [{
    id: missionId,
    tasks: [
      { id: rId, targetFiles: ['src/r.js'], dependencies: [] },
      { id: sId, targetFiles: ['src/s.js'], dependencies: [{ taskId: rId, type: 'hard' }] },
      { id: tId, targetFiles: ['src/t.js'], dependencies: [] },
    ],
  }];

  // R is seeded 'complete' at DAG-build time, exactly like TC1/TC3's A —
  // this is the pre-terminal classification the rescue must strand and
  // then re-adopt exactly once.
  const preStatus = { [rId]: 'complete' };

  const { projectRoot, harnessDir } = createStallHarness({ missions, preStatus });

  try {
    const taskR = { id: rId, missionId, subMissionId, description: 'Task R', targetFiles: ['src/r.js'], dependencies: [] };
    const taskS = { id: sId, missionId, subMissionId, description: 'Task S', targetFiles: ['src/s.js'], dependencies: [{ taskId: rId, type: 'hard' }] };
    const taskT = { id: tId, missionId, subMissionId, description: 'Task T', targetFiles: ['src/t.js'], dependencies: [] };

    // T ahead of S in the DAG (and thus in `pending`'s insertion order)
    // ensures T is dispatched first under maxConcurrent 1, exactly as C
    // was in TC1/TC3's fixture.
    const taskDAG = [taskR, taskT, taskS];

    const trace = [];

    const runTask = async (task) => {
      trace.push({ id: task.id });

      if (task.id === tId) {
        // While T "runs", demote R on disk — strands S (hard-depends on R)
        // and forces the stall-boundary rescue to re-adopt R.
        setTaskStatus(harnessDir, missionId, subMissionId, rId, 'needs_revalidation');
        setTaskStatus(harnessDir, missionId, subMissionId, task.id, 'complete');
        return;
      }

      if (task.id === rId) {
        // Deliberately leave R at 'needs_revalidation' instead of
        // completing it — simulating a verifier-only rerun that never
        // lands a terminal status. If the rescue were unbounded, the
        // scheduler would keep re-adding R to `pending` forever and
        // `runMilestone` would never settle. The one-shot rescue cap
        // (_rescuedRevalIds) must instead fall through to a genuine
        // dependency stall on S.
        setTaskStatus(harnessDir, missionId, subMissionId, rId, 'needs_revalidation');
        return;
      }

      // S should never be dispatched — its dependency on R never becomes
      // terminal in this scenario.
      setTaskStatus(harnessDir, missionId, subMissionId, task.id, 'complete');
    };

    const scheduler = new Scheduler({
      harnessDir,
      projectRoot,
      maxConcurrent: 1,
      runTask,
    });

    let thrown = null;
    try {
      // Bound the wait: if the rescue loop is unbounded, `runMilestone`
      // never settles, and withTimeout is what fails this case instead of
      // hanging the whole suite.
      await withTimeout(scheduler.runMilestone('001', taskDAG), 10000);
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'expected runMilestone to reject once the one-shot rescue of R is exhausted and S remains permanently stalled');
    assert.ok(thrown instanceof Error, `expected the rejection to be an Error, got: ${thrown}`);
    // The rejection must be the scheduler's own stall error, not the
    // withTimeout guard's timeout message — proving the rescue terminated
    // on its own rather than being cut off by the test harness.
    assert.ok(
      thrown.message.startsWith('Scheduler stall:'),
      `expected the scheduler's own 'Scheduler stall:' error (not a withTimeout guard rejection), got: ${thrown.message}`
    );

    // R must have been dispatched (rescued) exactly once — not repeatedly.
    const rDispatches = trace.filter((entry) => entry.id === rId);
    assert.strictEqual(
      rDispatches.length,
      1,
      `expected R to be dispatched exactly once, got ${rDispatches.length}: ${JSON.stringify(trace)}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC3 guard: withTimeout fails fast instead of hanging ─────────────────

await test('TC3 guard: withTimeout fails the case rather than hanging if the wrapped promise never settles', async () => {
  const neverSettles = new Promise(() => {});

  let thrown = null;
  try {
    await withTimeout(neverSettles, 50);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'expected withTimeout to reject once its deadline elapses on a promise that never settles');
  assert.ok(thrown instanceof Error, `expected an Error, got: ${thrown}`);
  // The timeout rejection must be distinguishable from the scheduler's own
  // stall error, so a real scheduler stall is never mistaken for a hung
  // rescue loop (or vice versa).
  assert.ok(
    !thrown.message.startsWith('Scheduler stall:'),
    `expected a timeout-specific message distinct from the scheduler's own error, got: ${thrown.message}`
  );
});

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
