/**
 * test-pending-tasks-invariant.js — Tests for assertNoNonTerminalTasks and PendingTasksAtMilestoneAdvance.
 *
 * Test cases:
 *   TC-PTI-1: all tasks complete — no throw
 *   TC-PTI-2: all tasks verified/invalidated — no throw
 *   TC-PTI-3: one pending task — throws PendingTasksAtMilestoneAdvance
 *   TC-PTI-4: in_progress task — throws
 *   TC-PTI-5: blocked/failed task — throws
 *   TC-PTI-6: PendingTasksAtMilestoneAdvance constructor properties
 *   TC-PTI-7: milestoneId field matches the msId passed, not the miId
 *
 * Run: node test/test-pending-tasks-invariant.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { assertNoNonTerminalTasks } from '../src/orchestrator/core/pipeline.js';
import { PendingTasksAtMilestoneAdvance } from '../src/orchestrator/core/pending-tasks-error.js';

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
 * Creates a minimal harness directory with:
 *   - state/mission-<miId>.json containing one sub-mission with `tasks`
 *
 * Returns { harnessDir, msId, miId, msState }
 */
function createTestEnv({ tasks = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-tasks-invariant-test-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });

  const msId = '001-001';
  const miId = '001-001';
  const smId = `${miId}-001`;

  fs.writeFileSync(
    path.join(root, 'state', `mission-${miId}.json`),
    JSON.stringify({
      id: miId,
      missionId: miId,
      description: 'test mission',
      status: 'in_progress',
      subMissions: {
        [smId]: {
          id: smId,
          description: 'test sub-mission',
          status: 'in_progress',
          tasks,
        },
      },
    }, null, 2)
  );

  const msState = {
    missions: {
      [miId]: {
        id: miId,
        status: 'in_progress',
      },
    },
  };

  return { harnessDir: root, msId, miId, smId, msState };
}

function makeTask(id, status) {
  return { id, status, description: `task ${id}` };
}

const noop = () => {};

// ── Tests ────────────────────────────────────────────────────────────────────

await test('TC-PTI-1: all tasks complete — no throw', async () => {
  const tasks = {
    't1': makeTask('001-001-001-001', 'complete'),
    't2': makeTask('001-001-001-002', 'complete'),
    't3': makeTask('001-001-001-003', 'complete'),
  };
  const { harnessDir, msId, msState } = createTestEnv({ tasks });

  // Should not throw
  assertNoNonTerminalTasks(harnessDir, msId, msState, noop);
});

await test('TC-PTI-2: all tasks verified/invalidated — no throw', async () => {
  const tasks = {
    't1': makeTask('001-001-001-001', 'verified'),
    't2': makeTask('001-001-001-002', 'invalidated'),
    't3': makeTask('001-001-001-003', 'verified'),
  };
  const { harnessDir, msId, msState } = createTestEnv({ tasks });

  // Should not throw
  assertNoNonTerminalTasks(harnessDir, msId, msState, noop);
});

await test('TC-PTI-3: one pending task — throws PendingTasksAtMilestoneAdvance', async () => {
  const pendingTaskId = '001-001-001-002';
  const tasks = {
    't1': makeTask('001-001-001-001', 'complete'),
    't2': makeTask(pendingTaskId, 'pending'),
  };
  const { harnessDir, msId, msState } = createTestEnv({ tasks });

  let threw = false;
  try {
    assertNoNonTerminalTasks(harnessDir, msId, msState, noop);
  } catch (err) {
    threw = true;
    assert.ok(err instanceof PendingTasksAtMilestoneAdvance, `Expected PendingTasksAtMilestoneAdvance, got ${err.constructor.name}`);
    assert.strictEqual(err.milestoneId, msId, `Expected milestoneId to be ${msId}`);
    assert.ok(Array.isArray(err.pendingTaskIds), 'Expected pendingTaskIds to be an array');
    assert.ok(err.pendingTaskIds.includes(pendingTaskId), `Expected pendingTaskIds to include ${pendingTaskId}`);
  }
  assert.ok(threw, 'Expected assertNoNonTerminalTasks to throw');
});

await test('TC-PTI-4: in_progress task — throws', async () => {
  const inProgressTaskId = '001-001-001-003';
  const tasks = {
    't1': makeTask('001-001-001-001', 'complete'),
    't2': makeTask(inProgressTaskId, 'in_progress'),
  };
  const { harnessDir, msId, msState } = createTestEnv({ tasks });

  let threw = false;
  try {
    assertNoNonTerminalTasks(harnessDir, msId, msState, noop);
  } catch (err) {
    threw = true;
    assert.ok(err instanceof PendingTasksAtMilestoneAdvance, `Expected PendingTasksAtMilestoneAdvance, got ${err.constructor.name}`);
    assert.ok(err.pendingTaskIds.includes(inProgressTaskId), `Expected pendingTaskIds to include ${inProgressTaskId}`);
  }
  assert.ok(threw, 'Expected assertNoNonTerminalTasks to throw for in_progress task');
});

await test('TC-PTI-5: blocked/failed task — throws', async () => {
  const blockedTaskId = '001-001-001-004';
  const failedTaskId = '001-001-001-005';
  const tasks = {
    't1': makeTask('001-001-001-001', 'complete'),
    't2': makeTask(blockedTaskId, 'blocked'),
    't3': makeTask(failedTaskId, 'failed'),
  };
  const { harnessDir, msId, msState } = createTestEnv({ tasks });

  let threw = false;
  try {
    assertNoNonTerminalTasks(harnessDir, msId, msState, noop);
  } catch (err) {
    threw = true;
    assert.ok(err instanceof PendingTasksAtMilestoneAdvance, `Expected PendingTasksAtMilestoneAdvance, got ${err.constructor.name}`);
    assert.ok(err.pendingTaskIds.includes(blockedTaskId), `Expected pendingTaskIds to include blocked task ${blockedTaskId}`);
    assert.ok(err.pendingTaskIds.includes(failedTaskId), `Expected pendingTaskIds to include failed task ${failedTaskId}`);
  }
  assert.ok(threw, 'Expected assertNoNonTerminalTasks to throw for blocked/failed tasks');
});

await test('TC-PTI-6: PendingTasksAtMilestoneAdvance constructor properties', async () => {
  const msId = '001-002';
  const pendingTaskIds = ['001-002-001-001', '001-002-001-002'];
  const err = new PendingTasksAtMilestoneAdvance(msId, pendingTaskIds);

  assert.strictEqual(err.name, 'PendingTasksAtMilestoneAdvance', `Expected name to be 'PendingTasksAtMilestoneAdvance', got '${err.name}'`);
  assert.strictEqual(err.milestoneId, msId, `Expected milestoneId to be '${msId}', got '${err.milestoneId}'`);
  assert.deepStrictEqual(err.pendingTaskIds, pendingTaskIds, `Expected pendingTaskIds to match`);
  assert.ok(err instanceof Error, 'Expected PendingTasksAtMilestoneAdvance to be an instance of Error');
  assert.ok(typeof err.message === 'string' && err.message.length > 0, 'Expected a non-empty message');
});

await test('TC-PTI-7: milestoneId field matches the msId passed, not the miId', async () => {
  const msId = '002';
  const miId = '002-001';
  const smId = `${miId}-001`;
  const pendingTaskId = '002-001-001-001';

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-tasks-invariant-test-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'state', `mission-${miId}.json`),
    JSON.stringify({
      id: miId,
      missionId: miId,
      description: 'test mission',
      status: 'in_progress',
      subMissions: {
        [smId]: {
          id: smId,
          description: 'test sub-mission',
          status: 'in_progress',
          tasks: {
            't1': makeTask(pendingTaskId, 'pending'),
          },
        },
      },
    }, null, 2)
  );

  const msState = {
    missions: {
      [miId]: {
        id: miId,
        status: 'in_progress',
      },
    },
  };

  let threw = false;
  try {
    assertNoNonTerminalTasks(root, msId, msState, noop);
  } catch (err) {
    threw = true;
    assert.ok(err instanceof PendingTasksAtMilestoneAdvance, `Expected PendingTasksAtMilestoneAdvance, got ${err.constructor.name}`);
    assert.strictEqual(err.milestoneId, '002', `Expected milestoneId to be '002' (msId), got '${err.milestoneId}'`);
    assert.notStrictEqual(err.milestoneId, '002-001', `Expected milestoneId NOT to be '002-001' (miId)`);
  }
  assert.ok(threw, 'Expected assertNoNonTerminalTasks to throw');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
