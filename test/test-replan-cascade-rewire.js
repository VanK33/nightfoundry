/**
 * test-replan-cascade-rewire.js — Tests for deduplication and cascade-rewire
 * behaviour within Scheduler.replaceTask.
 *
 * Verifies:
 *   TC-DEDUP-1. 4 identical replacements (same description + sorted targetFiles)
 *               collapse to 1 inserted after deduplication.
 *   TC-DEDUP-2. 2 replacements with distinct descriptions but same targetFiles
 *               both survive deduplication.
 *   TC-DEDUP-3. A replacement whose dep points to a dropped duplicate ID has
 *               its dependency rewritten to the kept (surviving) ID.
 *   TC-CASCADE-1. Direct dependent is preserved and rewired to the last
 *                 replacement; only the failing task appears in invalidated[].
 *   TC-CASCADE-2. Transitive A→B→C chain: only A is invalidated, B is rewired
 *                 to last replacement, C's dep on B is unchanged, both remain
 *                 in _pending.
 *   TC-CASCADE-3. Cycle produced by rewire is detected; replaceTask throws with
 *                 /cycle/i and restores B's dependencies to their pre-rewire
 *                 value via rewireSnapshot rollback.
 *
 * Run: node test/test-replan-cascade-rewire.js
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
 * state files. Tasks default to 'pending' unless overridden in `preStatus`.
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

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a minimal Scheduler instance with a no-op runTask and preset DAG state.
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

// ── TC-DEDUP-1: 4 identical replacements collapse to 1 inserted ──────────────

await test('TC-DEDUP-1: 4 identical replacements (same description + targetFiles) collapse to 1 inserted', async () => {
  const task = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Original task',
  };

  // All four replacements share the same description and sorted targetFiles.
  const rp1 = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Shared description',
  };
  const rp2 = {
    id: '001-001-001-001-rp-002',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Shared description',
  };
  const rp3 = {
    id: '001-001-001-001-rp-003',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Shared description',
  };
  const rp4 = {
    id: '001-001-001-001-rp-004',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Shared description',
  };

  const dir = createSchedHarness([task]);
  try {
    const scheduler = makeScheduler(dir, [task]);
    const result = await scheduler.replaceTask(task.id, [rp1, rp2, rp3, rp4]);

    assert.strictEqual(result.inserted.length, 1,
      `deduplication should collapse 4 identical replacements to 1; got ${result.inserted.length}`);

    const keptId = result.inserted[0];
    assert.ok(scheduler._tasksById.has(keptId),
      `kept replacement "${keptId}" should be present in _tasksById`);

    // The 3 dropped IDs must not appear in either _tasksById or _pending.
    const allIds = [rp1.id, rp2.id, rp3.id, rp4.id];
    const droppedIds = allIds.filter((id) => id !== keptId);
    assert.strictEqual(droppedIds.length, 3, 'exactly 3 IDs should be dropped');
    for (const id of droppedIds) {
      assert.ok(!scheduler._tasksById.has(id),
        `dropped replacement "${id}" must NOT be in _tasksById`);
      assert.ok(!scheduler._pending.has(id),
        `dropped replacement "${id}" must NOT be in _pending`);
    }
  } finally { cleanup(dir); }
});

// ── TC-DEDUP-2: 2 distinct-description replacements both survive ─────────────

await test('TC-DEDUP-2: 2 replacements with distinct descriptions both survive deduplication', async () => {
  const task = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Original task',
  };

  // Same targetFiles but distinct descriptions → two unique keys → both survive.
  const rp1 = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Description alpha',
  };
  const rp2 = {
    id: '001-001-001-001-rp-002',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Description beta',
  };

  const dir = createSchedHarness([task]);
  try {
    const scheduler = makeScheduler(dir, [task]);
    const result = await scheduler.replaceTask(task.id, [rp1, rp2]);

    assert.strictEqual(result.inserted.length, 2,
      `both distinct replacements should survive deduplication; got ${result.inserted.length}`);
    assert.ok(scheduler._tasksById.has(rp1.id),
      `rp1 "${rp1.id}" should be in _tasksById`);
    assert.ok(scheduler._tasksById.has(rp2.id),
      `rp2 "${rp2.id}" should be in _tasksById`);
    assert.ok(scheduler._pending.has(rp1.id),
      `rp1 "${rp1.id}" should be in _pending`);
    assert.ok(scheduler._pending.has(rp2.id),
      `rp2 "${rp2.id}" should be in _pending`);
  } finally { cleanup(dir); }
});

// ── TC-DEDUP-3: dropped-id dep in surviving replacement is rewritten to kept ID

await test('TC-DEDUP-3: dep pointing to a dropped duplicate is rewritten to the kept survivor', async () => {
  const task = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js', 'src/b.js'],
    dependencies: [],
    description: 'Original task',
  };

  // rp-001 and rp-003 are duplicates (same description + same sorted targetFiles).
  // rp-002 has a hard dep on rp-001.
  // After dedup, exactly one of {rp-001, rp-003} is kept (first-wins or last-wins
  // is implementation-defined).  rp-002's dep must be rewritten to the survivor.
  const rp001 = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Shared dup description',
  };
  const rp002 = {
    id: '001-001-001-001-rp-002',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/b.js'],
    dependencies: [{ taskId: '001-001-001-001-rp-001', type: 'hard' }],
    description: 'Unique middle task',
  };
  const rp003 = {
    id: '001-001-001-001-rp-003',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Shared dup description',
  };

  const dir = createSchedHarness([task]);
  try {
    const scheduler = makeScheduler(dir, [task]);
    const result = await scheduler.replaceTask(task.id, [rp001, rp002, rp003]);

    // Exactly 2 tasks inserted: rp-002 + exactly one of {rp-001, rp-003}.
    assert.strictEqual(result.inserted.length, 2,
      `expected 2 inserted after dedup (rp-002 + 1 survivor); got ${result.inserted.length}`);

    const rp001Kept = scheduler._tasksById.has(rp001.id);
    const rp003Kept = scheduler._tasksById.has(rp003.id);
    assert.ok(
      rp001Kept !== rp003Kept,
      `exactly one of rp-001 / rp-003 should survive dedup; got rp001Kept=${rp001Kept}, rp003Kept=${rp003Kept}`
    );

    const survivorId = rp001Kept ? rp001.id : rp003.id;
    const droppedId  = rp001Kept ? rp003.id : rp001.id;

    // The survivor and rp-002 must be in both _tasksById and _pending.
    assert.ok(scheduler._tasksById.has(survivorId), `survivor "${survivorId}" must be in _tasksById`);
    assert.ok(scheduler._pending.has(survivorId),   `survivor "${survivorId}" must be in _pending`);
    assert.ok(scheduler._tasksById.has(rp002.id),  `rp-002 must be in _tasksById`);
    assert.ok(scheduler._pending.has(rp002.id),    `rp-002 must be in _pending`);

    // Dropped ID must not appear anywhere.
    assert.ok(!scheduler._tasksById.has(droppedId), `dropped "${droppedId}" must NOT be in _tasksById`);
    assert.ok(!scheduler._pending.has(droppedId),   `dropped "${droppedId}" must NOT be in _pending`);

    // rp-002's dep must now reference the survivor, not the dropped ID.
    const rp002task = scheduler._tasksById.get(rp002.id);
    const depIds = (rp002task.dependencies || []).map((d) => d.taskId);
    assert.ok(
      depIds.includes(survivorId),
      `rp-002 dep should be rewritten to survivor "${survivorId}"; actual deps: ${JSON.stringify(depIds)}`
    );
    assert.ok(
      !depIds.includes(droppedId),
      `rp-002 dep must NOT reference dropped "${droppedId}"; actual deps: ${JSON.stringify(depIds)}`
    );
  } finally { cleanup(dir); }
});

// ── TC-CASCADE-1: direct dependent preserved + rewired + re-pended ───────────

await test('TC-CASCADE-1: direct dependent B preserved, rewired to last replacement, remains in _pending', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A',
  };
  const taskB = {
    id: '001-001-001-002',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/b.js'],
    dependencies: [{ taskId: taskA.id, type: 'hard' }],
    description: 'Task B (depends on A)',
  };
  const replacement = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Replacement for A',
  };

  const dir = createSchedHarness([taskA, taskB]);
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB]);
    const result = await scheduler.replaceTask(taskA.id, [replacement]);

    // Only task A is invalidated; B is preserved via rewire.
    assert.deepStrictEqual(result.invalidated, [taskA.id],
      `invalidated should be exactly [A.id]; got ${JSON.stringify(result.invalidated)}`);

    // B must survive in the scheduler index and remain pending.
    assert.ok(scheduler._tasksById.has(taskB.id),
      'task B must remain in _tasksById after cascade-rewire');
    assert.ok(scheduler._pending.has(taskB.id),
      'task B must remain in _pending after cascade-rewire');

    // B's dependency on A must be rewritten to the replacement.
    const bTask = scheduler._tasksById.get(taskB.id);
    const bDepIds = (bTask.dependencies || []).map((d) => d.taskId);
    assert.ok(
      bDepIds.includes(replacement.id),
      `B's dep should be rewired to "${replacement.id}"; got ${JSON.stringify(bDepIds)}`
    );
    assert.ok(
      !bDepIds.includes(taskA.id),
      `B's dep must no longer reference "${taskA.id}"; got ${JSON.stringify(bDepIds)}`
    );
  } finally { cleanup(dir); }
});

// ── TC-CASCADE-2: transitive A→B→C chain, only A invalidated ────────────────

await test('TC-CASCADE-2: A→B→C chain: only A invalidated, B rewired, C dep on B unchanged, B and C in _pending', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A',
  };
  const taskB = {
    id: '001-001-001-002',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/b.js'],
    dependencies: [{ taskId: taskA.id, type: 'hard' }],
    description: 'Task B (depends on A)',
  };
  const taskC = {
    id: '001-001-001-003',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/c.js'],
    dependencies: [{ taskId: taskB.id, type: 'hard' }],
    description: 'Task C (depends on B)',
  };
  const replacement = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Replacement for A',
  };

  const dir = createSchedHarness([taskA, taskB, taskC]);
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB, taskC]);
    const result = await scheduler.replaceTask(taskA.id, [replacement]);

    // Only A is invalidated — B and C are preserved via cascade-rewire.
    assert.deepStrictEqual(result.invalidated, [taskA.id],
      `invalidated should be exactly [A.id]; got ${JSON.stringify(result.invalidated)}`);

    // B is rewired to the replacement.
    assert.ok(scheduler._tasksById.has(taskB.id), 'task B must remain in _tasksById');
    assert.ok(scheduler._pending.has(taskB.id),   'task B must remain in _pending');
    const bTask = scheduler._tasksById.get(taskB.id);
    const bDepIds = (bTask.dependencies || []).map((d) => d.taskId);
    assert.ok(
      bDepIds.includes(replacement.id),
      `B's dep should be rewired to "${replacement.id}"; got ${JSON.stringify(bDepIds)}`
    );
    assert.ok(
      !bDepIds.includes(taskA.id),
      `B's dep must no longer reference "${taskA.id}"; got ${JSON.stringify(bDepIds)}`
    );

    // C's dep on B is unchanged.
    assert.ok(scheduler._tasksById.has(taskC.id), 'task C must remain in _tasksById');
    assert.ok(scheduler._pending.has(taskC.id),   'task C must remain in _pending');
    const cTask = scheduler._tasksById.get(taskC.id);
    const cDepIds = (cTask.dependencies || []).map((d) => d.taskId);
    assert.ok(
      cDepIds.includes(taskB.id),
      `C's dep on B "${taskB.id}" should be unchanged; got ${JSON.stringify(cDepIds)}`
    );
    assert.ok(
      !cDepIds.includes(taskA.id),
      `C's deps must not include "${taskA.id}"; got ${JSON.stringify(cDepIds)}`
    );
  } finally { cleanup(dir); }
});

// ── TC-CASCADE-3: acyclicity rollback restores rewired edges ─────────────────

await test('TC-CASCADE-3: cycle from rewire causes throw /cycle/i and restores B deps via rewireSnapshot', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [],
    description: 'Task A',
  };
  // B depends on A initially.
  const taskB = {
    id: '001-001-001-002',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/b.js'],
    dependencies: [{ taskId: taskA.id, type: 'hard' }],
    description: 'Task B (depends on A)',
  };
  // The replacement depends on B.  After rewire, B would also depend on the
  // replacement (B's A-dep gets rewritten to replacement).  That creates:
  //   replacement → B → replacement  (cycle).
  const replacement = {
    id: '001-001-001-001-rp-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js'],
    dependencies: [{ taskId: taskB.id, type: 'hard' }],
    description: 'Replacement that depends on B (cycle)',
  };

  // Capture B's original dependencies before the replaceTask call.
  const originalBDeps = taskB.dependencies.map((d) => ({ ...d }));

  const dir = createSchedHarness([taskA, taskB]);
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB]);

    // replaceTask must throw because the rewire creates a cycle.
    let threw = null;
    try {
      await scheduler.replaceTask(taskA.id, [replacement]);
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, 'replaceTask should throw when a cycle is introduced');
    assert.match(threw.message, /cycle/i,
      `error message should match /cycle/i; got: "${threw.message}"`);

    // After rollback, B's dependencies must be restored to the original value
    // (dep on A, NOT on the replacement). This is the rewireSnapshot rollback.
    const bTask = scheduler._tasksById.get(taskB.id);
    assert.ok(bTask, 'task B should still be in _tasksById after rollback');
    const bDepIds = (bTask.dependencies || []).map((d) => d.taskId);
    assert.ok(
      bDepIds.includes(taskA.id),
      `B's dep should be restored to "${taskA.id}" after rollback; got ${JSON.stringify(bDepIds)}`
    );
    assert.ok(
      !bDepIds.includes(replacement.id),
      `B's dep must NOT reference replacement "${replacement.id}" after rollback; got ${JSON.stringify(bDepIds)}`
    );

    // Verify the restored dep array matches the original snapshot structurally.
    assert.strictEqual(bDepIds.length, originalBDeps.length,
      `B's deps length after rollback should match original (${originalBDeps.length}); got ${bDepIds.length}`);
  } finally { cleanup(dir); }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
