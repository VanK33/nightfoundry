/**
 * test-task-id-collision.js — Tests for cross-mission task-id collision checks.
 *
 * Test cases:
 *   TC-COLL-1: checkTaskIdCollision returns cleanly when no collision exists across 2 mission state files
 *   TC-COLL-2: checkTaskIdCollision throws TaskIdCollisionError when taskId exists in a different mission's state file
 *   TC-COLL-3: mergeRemediationTasks throws TaskIdCollisionError when a new task (after normalization) collides with a task in another mission
 *   TC-COLL-4: mergeRemediationTasks succeeds when tasks don't collide across missions (regression)
 *   TC-COLL-5: collision within same mission's different sub-mission is detected (intra-mission cross-sub-mission collision)
 *   TC-COLL-6: normalizeTaskId skips cross-mission colliding candidate ('001-002-001-001' taken in another mission → resolves to '001-002-001-002')
 *
 * Run: node test/test-task-id-collision.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { mergeRemediationTasks, checkTaskIdCollision } from '../src/orchestrator/gates/coverage.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failCount++;
    }
  );
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Create a minimal harness dir with:
 *   - state.json (global, no prdPath so coverage check is skipped)
 *   - One or more mission state files, each with configurable sub-missions and tasks
 *
 * `missions` is an array of mission configs:
 *   { missionId, subMissions: { [smId]: { tasks: { [taskId]: taskObj } } } }
 *
 * Returns { harnessDir }
 */
function createTestEnv({ missions = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collision-test-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'verify'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones: {},
    }, null, 2)
  );

  for (const mission of missions) {
    const { missionId, subMissions = {} } = mission;

    // Build the subMissions object with proper shape
    const subMissionsObj = {};
    for (const [smId, smConfig] of Object.entries(subMissions)) {
      subMissionsObj[smId] = {
        id: smId,
        description: `sub-mission ${smId}`,
        status: 'in_progress',
        tasks: smConfig.tasks || {},
      };
    }

    fs.writeFileSync(
      path.join(root, 'state', `mission-${missionId}.json`),
      JSON.stringify({
        id: missionId,
        missionId,
        description: `test mission ${missionId}`,
        status: 'in_progress',
        subMissions: subMissionsObj,
      }, null, 2)
    );
  }

  return { harnessDir: root };
}

/** Minimal missionDecomp stub (subMissions array). */
function makeDecomp(...smIds) {
  return { subMissions: smIds.map((id) => ({ id, tasks: [] })) };
}

/** Read saved mission state from disk. */
function readMissionState(harnessDir, missionId) {
  return JSON.parse(
    fs.readFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), 'utf8')
  );
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// ── Tests ────────────────────────────────────────────────────────────────────

// TC-COLL-1: checkTaskIdCollision returns cleanly when no collision exists across 2 mission state files
await test('TC-COLL-1: checkTaskIdCollision no collision across 2 missions', () => {
  const { harnessDir } = createTestEnv({
    missions: [
      {
        missionId: '001-001',
        subMissions: {
          '001-001-001': {
            tasks: {
              '001-001-001-001': { id: '001-001-001-001', description: 'task in mission 1', status: 'pending', retryCount: 0 },
            },
          },
        },
      },
      {
        missionId: '001-002',
        subMissions: {
          '001-002-001': {
            tasks: {
              '001-002-001-001': { id: '001-002-001-001', description: 'task in mission 2', status: 'pending', retryCount: 0 },
            },
          },
        },
      },
    ],
  });
  try {
    // These two task IDs are unique across the two missions — should not throw.
    assert.doesNotThrow(() => checkTaskIdCollision(harnessDir, '001-001-001-002'));
    assert.doesNotThrow(() => checkTaskIdCollision(harnessDir, '001-002-001-002'));
  } finally {
    cleanup(harnessDir);
  }
});

// TC-COLL-2: checkTaskIdCollision throws TaskIdCollisionError for cross-mission duplicate
await test('TC-COLL-2: checkTaskIdCollision throws TaskIdCollisionError for cross-mission duplicate', () => {
  const collidingId = '001-001-001-001';
  const { harnessDir } = createTestEnv({
    missions: [
      {
        missionId: '001-001',
        subMissions: {
          '001-001-001': {
            tasks: {
              [collidingId]: { id: collidingId, description: 'existing task', status: 'pending', retryCount: 0 },
            },
          },
        },
      },
      {
        missionId: '001-002',
        subMissions: {
          '001-002-001': {
            tasks: {},
          },
        },
      },
    ],
  });
  try {
    // The task ID already exists in mission 001-001, so checking from mission 001-002's perspective should throw.
    let thrown = null;
    try {
      checkTaskIdCollision(harnessDir, collidingId);
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown !== null, 'expected TaskIdCollisionError to be thrown');
    assert.strictEqual(thrown.name, 'TaskIdCollisionError', `expected name 'TaskIdCollisionError', got '${thrown.name}'`);
    assert.strictEqual(thrown.taskId, collidingId, `expected .taskId '${collidingId}', got '${thrown.taskId}'`);
    assert.ok(
      typeof thrown.existingLocation === 'string' && thrown.existingLocation.length > 0,
      `expected .existingLocation to be a non-empty string, got '${thrown.existingLocation}'`
    );
    assert.ok(
      thrown.existingLocation.includes('001-001'),
      `expected .existingLocation to reference mission '001-001', got '${thrown.existingLocation}'`
    );
  } finally {
    cleanup(harnessDir);
  }
});

// TC-COLL-3: mergeRemediationTasks throws TaskIdCollisionError on cross-mission collision
await test('TC-COLL-3: mergeRemediationTasks throws TaskIdCollisionError on cross-mission collision', async () => {
  // Mission 001-001 already has task 001-001-001-001.
  // We try to merge a new task with the same ID into mission 001-002 — should throw.
  const collidingId = '001-001-001-001';
  const { harnessDir } = createTestEnv({
    missions: [
      {
        missionId: '001-001',
        subMissions: {
          '001-001-001': {
            tasks: {
              [collidingId]: { id: collidingId, description: 'existing task', status: 'pending', retryCount: 0 },
            },
          },
        },
      },
      {
        missionId: '001-002',
        subMissions: {
          '001-002-001': {
            tasks: {},
          },
        },
      },
    ],
  });
  try {
    let thrown = null;
    try {
      await mergeRemediationTasks({
        harnessDir,
        missionId: '001-002',
        newTasks: [
          {
            id: collidingId,        // valid 4-segment id — normalization keeps it as-is
            subMissionId: '001-002-001',
            description: 'collision task',
            targetFiles: [],
            testCases: [],
          },
        ],
        missionDecomp: makeDecomp('001-002-001'),
        onLog: () => {},
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown !== null, 'expected TaskIdCollisionError to be thrown');
    assert.strictEqual(thrown.name, 'TaskIdCollisionError', `expected name 'TaskIdCollisionError', got '${thrown.name}'`);
    assert.strictEqual(thrown.taskId, collidingId, `expected .taskId '${collidingId}', got '${thrown.taskId}'`);
    assert.ok(
      typeof thrown.existingLocation === 'string' && thrown.existingLocation.length > 0,
      `expected .existingLocation to be a non-empty string`
    );
  } finally {
    cleanup(harnessDir);
  }
});

// TC-COLL-4: mergeRemediationTasks succeeds when tasks don't collide across missions (regression)
await test('TC-COLL-4: mergeRemediationTasks succeeds with no collisions (regression)', async () => {
  const { harnessDir } = createTestEnv({
    missions: [
      {
        missionId: '001-001',
        subMissions: {
          '001-001-001': {
            tasks: {
              '001-001-001-001': { id: '001-001-001-001', description: 'existing task', status: 'pending', retryCount: 0 },
            },
          },
        },
      },
      {
        missionId: '001-002',
        subMissions: {
          '001-002-001': {
            tasks: {},
          },
        },
      },
    ],
  });
  try {
    const logs = [];
    // Add a task with a unique 4-segment id to mission 001-002 — should succeed without throwing.
    await mergeRemediationTasks({
      harnessDir,
      missionId: '001-002',
      newTasks: [
        {
          id: '001-002-001-001',   // unique, does not exist in mission 001-001
          subMissionId: '001-002-001',
          description: 'new unique task',
          targetFiles: [],
          testCases: [],
        },
      ],
      missionDecomp: makeDecomp('001-002-001'),
      onLog: (msg) => logs.push(msg),
    });

    const state = readMissionState(harnessDir, '001-002');
    const taskIds = Object.keys(state.subMissions['001-002-001'].tasks);

    assert.ok(taskIds.includes('001-002-001-001'), `expected '001-002-001-001' in task ids, got ${JSON.stringify(taskIds)}`);
    assert.strictEqual(taskIds.length, 1, 'expected exactly 1 task in mission 001-002');
  } finally {
    cleanup(harnessDir);
  }
});

// TC-COLL-5: intra-mission cross-sub-mission collision detected
await test('TC-COLL-5: intra-mission cross-sub-mission collision detected', () => {
  // Same mission, two different sub-missions — a task ID present in sub-mission A
  // must be detected when checking from the perspective of sub-mission B.
  const collidingId = '001-001-001-001';
  const { harnessDir } = createTestEnv({
    missions: [
      {
        missionId: '001-001',
        subMissions: {
          '001-001-001': {
            tasks: {
              [collidingId]: { id: collidingId, description: 'task in sub-mission 001', status: 'pending', retryCount: 0 },
            },
          },
          '001-001-002': {
            tasks: {},
          },
        },
      },
    ],
  });
  try {
    let thrown = null;
    try {
      // This ID already exists in sub-mission 001-001-001 of the same mission.
      // Checking for it should detect the collision even though the target is 001-001-002.
      checkTaskIdCollision(harnessDir, collidingId);
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown !== null, 'expected TaskIdCollisionError to be thrown for intra-mission cross-sub-mission collision');
    assert.strictEqual(thrown.name, 'TaskIdCollisionError', `expected name 'TaskIdCollisionError', got '${thrown.name}'`);
    assert.strictEqual(thrown.taskId, collidingId, `expected .taskId '${collidingId}', got '${thrown.taskId}'`);
    assert.ok(
      typeof thrown.existingLocation === 'string' && thrown.existingLocation.includes('001-001-001'),
      `expected .existingLocation to reference sub-mission '001-001-001', got '${thrown.existingLocation}'`
    );
  } finally {
    cleanup(harnessDir);
  }
});

// TC-COLL-6: normalizeTaskId skips cross-mission colliding candidate
await test('TC-COLL-6: normalizeTaskId skips cross-mission colliding candidate', async () => {
  // Mission 001-001 already has task '001-002-001-001'.
  // Mission 001-002 has sub-mission '001-002-001' with no tasks.
  // We call mergeRemediationTasks on mission 001-002 with a non-conforming id 'fix-bug'
  // and subMissionId='001-002-001'.
  // normalizeTaskId's first candidate would be '001-002-001-001', but that collides
  // cross-mission with mission 001-001's task, so it should skip to '001-002-001-002'.
  const { harnessDir } = createTestEnv({
    missions: [
      {
        missionId: '001-001',
        subMissions: {
          '001-001-001': {
            tasks: {
              '001-002-001-001': { id: '001-002-001-001', description: 'existing task in mission 001-001', status: 'pending', retryCount: 0 },
            },
          },
        },
      },
      {
        missionId: '001-002',
        subMissions: {
          '001-002-001': {
            tasks: {},
          },
        },
      },
    ],
  });
  try {
    const logs = [];
    // 'fix-bug' is non-conforming — normalizeTaskId will derive the candidate from
    // subMissionId '001-002-001', starting at '001-002-001-001'. That collides with
    // mission 001-001's task, so it must bump to '001-002-001-002'.
    await mergeRemediationTasks({
      harnessDir,
      missionId: '001-002',
      newTasks: [
        {
          id: 'fix-bug',
          subMissionId: '001-002-001',
          description: 'task with non-conforming id that triggers normalization',
          targetFiles: [],
          testCases: [],
        },
      ],
      missionDecomp: makeDecomp('001-002-001'),
      onLog: (msg) => logs.push(msg),
    });

    const state = readMissionState(harnessDir, '001-002');
    const taskIds = Object.keys(state.subMissions['001-002-001'].tasks);

    assert.ok(
      taskIds.includes('001-002-001-002'),
      `expected '001-002-001-002' in task ids (skipped -001 due to cross-mission collision), got ${JSON.stringify(taskIds)}`
    );
    assert.ok(
      !taskIds.includes('001-002-001-001'),
      `expected '001-002-001-001' NOT to be in task ids (it would collide cross-mission), got ${JSON.stringify(taskIds)}`
    );
    assert.strictEqual(taskIds.length, 1, `expected exactly 1 task in mission 001-002, got ${taskIds.length}`);

    const task = state.subMissions['001-002-001'].tasks['001-002-001-002'];
    assert.ok(task, 'expected task object at key 001-002-001-002');
    assert.strictEqual(task.id, '001-002-001-002', `expected task.id to be '001-002-001-002', got '${task.id}'`);
  } finally {
    cleanup(harnessDir);
  }
});

// TC-PREFIX-1: valid id, prefix matches, no collision → accepted as-is
await test('TC-PREFIX-1: valid id prefix-matches, no collision → accepted as-is', async () => {
  // Task id '001-002-001-001' starts with '001-002-001-', so prefixMatches=true.
  // No other mission or sub-mission has this id, so collides=false.
  // → Quadrant 1: accepted as-is without any rewrite.
  const { harnessDir } = createTestEnv({
    missions: [
      {
        missionId: '001-001',
        subMissions: {
          '001-001-001': {
            tasks: {
              '001-001-001-001': { id: '001-001-001-001', description: 'unrelated task', status: 'pending', retryCount: 0 },
            },
          },
        },
      },
      {
        missionId: '001-002',
        subMissions: {
          '001-002-001': {
            tasks: {},
          },
        },
      },
    ],
  });
  try {
    const logs = [];
    await mergeRemediationTasks({
      harnessDir,
      missionId: '001-002',
      newTasks: [
        {
          id: '001-002-001-001',
          subMissionId: '001-002-001',
          description: 'task with matching prefix and no collision',
          targetFiles: [],
          testCases: [],
        },
      ],
      missionDecomp: makeDecomp('001-002-001'),
      onLog: (msg) => logs.push(msg),
    });

    const state = readMissionState(harnessDir, '001-002');
    const taskIds = Object.keys(state.subMissions['001-002-001'].tasks);

    assert.ok(
      taskIds.includes('001-002-001-001'),
      `expected '001-002-001-001' to be persisted as-is, got ${JSON.stringify(taskIds)}`
    );
    assert.strictEqual(taskIds.length, 1, `expected exactly 1 task, got ${taskIds.length}`);

    const task = state.subMissions['001-002-001'].tasks['001-002-001-001'];
    assert.ok(task, 'expected task object at key 001-002-001-001');
    assert.strictEqual(task.id, '001-002-001-001', `expected task.id '001-002-001-001', got '${task.id}'`);
  } finally {
    cleanup(harnessDir);
  }
});

// TC-PREFIX-2: valid id, prefix diverges, no collision → orphan re-parent via rename loop
await test('TC-PREFIX-2: valid id prefix-diverges, no collision → orphan re-parent to 001-002-001-001', async () => {
  // Task id '001-001-001-005' is valid format but does NOT start with '001-002-001-',
  // so prefixMatches=false. There is no collision anywhere, so collides=false.
  // → Quadrant 3: orphan re-parent — falls through to rename loop, which assigns '001-002-001-001'.
  const { harnessDir } = createTestEnv({
    missions: [
      {
        missionId: '001-001',
        subMissions: {
          '001-001-001': {
            tasks: {
              '001-001-001-001': { id: '001-001-001-001', description: 'unrelated task in 001-001', status: 'pending', retryCount: 0 },
            },
          },
        },
      },
      {
        missionId: '001-002',
        subMissions: {
          '001-002-001': {
            tasks: {},
          },
        },
      },
    ],
  });
  try {
    const logs = [];
    await mergeRemediationTasks({
      harnessDir,
      missionId: '001-002',
      newTasks: [
        {
          id: '001-001-001-005',   // valid format, but prefix belongs to a different sub-mission
          subMissionId: '001-002-001',
          description: 'orphan task that should be re-parented',
          targetFiles: [],
          testCases: [],
        },
      ],
      missionDecomp: makeDecomp('001-002-001'),
      onLog: (msg) => logs.push(msg),
    });

    const state = readMissionState(harnessDir, '001-002');
    const taskIds = Object.keys(state.subMissions['001-002-001'].tasks);

    assert.ok(
      taskIds.includes('001-002-001-001'),
      `expected orphan task to be re-parented to '001-002-001-001', got ${JSON.stringify(taskIds)}`
    );
    assert.ok(
      !taskIds.includes('001-001-001-005'),
      `expected original id '001-001-001-005' NOT to be in task ids, got ${JSON.stringify(taskIds)}`
    );
    assert.strictEqual(taskIds.length, 1, `expected exactly 1 task, got ${taskIds.length}`);

    const task = state.subMissions['001-002-001'].tasks['001-002-001-001'];
    assert.ok(task, 'expected task object at key 001-002-001-001');
    assert.strictEqual(task.id, '001-002-001-001', `expected task.id '001-002-001-001', got '${task.id}'`);
  } finally {
    cleanup(harnessDir);
  }
});

// TC-PREFIX-3: valid id, prefix diverges, cross-mission collision → TaskIdCollisionError thrown
await test('TC-PREFIX-3: valid id prefix-diverges, cross-mission collision → TaskIdCollisionError', async () => {
  // Mission 001-001 already owns task '001-001-001-001'.
  // New task also has id '001-001-001-001' but targets subMissionId '001-002-001'.
  // collides=true (cross-mission), prefixMatches=false (001-001-001-001 !starts 001-002-001-).
  // → Quadrant 2: throw TaskIdCollisionError (cross-namespace collision).
  const collidingId = '001-001-001-001';
  const { harnessDir } = createTestEnv({
    missions: [
      {
        missionId: '001-001',
        subMissions: {
          '001-001-001': {
            tasks: {
              [collidingId]: { id: collidingId, description: 'existing task in mission 001-001', status: 'pending', retryCount: 0 },
            },
          },
        },
      },
      {
        missionId: '001-002',
        subMissions: {
          '001-002-001': {
            tasks: {},
          },
        },
      },
    ],
  });
  try {
    let thrown = null;
    try {
      await mergeRemediationTasks({
        harnessDir,
        missionId: '001-002',
        newTasks: [
          {
            id: collidingId,
            subMissionId: '001-002-001',
            description: 'task that collides cross-mission with mismatched prefix',
            targetFiles: [],
            testCases: [],
          },
        ],
        missionDecomp: makeDecomp('001-002-001'),
        onLog: () => {},
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown !== null, 'expected TaskIdCollisionError to be thrown');
    assert.strictEqual(thrown.name, 'TaskIdCollisionError', `expected name 'TaskIdCollisionError', got '${thrown.name}'`);
    assert.strictEqual(thrown.taskId, collidingId, `expected .taskId '${collidingId}', got '${thrown.taskId}'`);
    assert.ok(
      typeof thrown.existingLocation === 'string' && thrown.existingLocation.length > 0,
      `expected .existingLocation to be a non-empty string`
    );
  } finally {
    cleanup(harnessDir);
  }
});

// TC-PREFIX-4: valid id, prefix matches, same-namespace collision → bumped to next sequence
await test('TC-PREFIX-4: valid id prefix-matches, same-namespace collision → bumped to 001-002-001-002', async () => {
  // Sub-mission 001-002-001 already has task '001-002-001-001'.
  // New task also has id '001-002-001-001' with subMissionId '001-002-001'.
  // prefixMatches=true, collides=true (intra-sub-mission).
  // → Quadrant 4: benign same-namespace collision — falls through to rename loop → '001-002-001-002'.
  const { harnessDir } = createTestEnv({
    missions: [
      {
        missionId: '001-002',
        subMissions: {
          '001-002-001': {
            tasks: {
              '001-002-001-001': { id: '001-002-001-001', description: 'already existing task', status: 'pending', retryCount: 0 },
            },
          },
        },
      },
    ],
  });
  try {
    const logs = [];
    await mergeRemediationTasks({
      harnessDir,
      missionId: '001-002',
      newTasks: [
        {
          id: '001-002-001-001',   // same-namespace collision
          subMissionId: '001-002-001',
          description: 'new task that bumps to next sequence',
          targetFiles: [],
          testCases: [],
        },
      ],
      missionDecomp: makeDecomp('001-002-001'),
      onLog: (msg) => logs.push(msg),
    });

    const state = readMissionState(harnessDir, '001-002');
    const taskIds = Object.keys(state.subMissions['001-002-001'].tasks);

    assert.ok(
      taskIds.includes('001-002-001-002'),
      `expected collision to be resolved by bumping to '001-002-001-002', got ${JSON.stringify(taskIds)}`
    );
    assert.ok(
      taskIds.includes('001-002-001-001'),
      `expected original task '001-002-001-001' to still be present, got ${JSON.stringify(taskIds)}`
    );
    assert.strictEqual(taskIds.length, 2, `expected exactly 2 tasks, got ${taskIds.length}`);

    const newTask = state.subMissions['001-002-001'].tasks['001-002-001-002'];
    assert.ok(newTask, 'expected new task object at key 001-002-001-002');
    assert.strictEqual(newTask.id, '001-002-001-002', `expected task.id '001-002-001-002', got '${newTask.id}'`);
  } finally {
    cleanup(harnessDir);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
