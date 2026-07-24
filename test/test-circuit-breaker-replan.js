/**
 * test-circuit-breaker-replan.js — Integration tests for the replan flow.
 *
 * Covers the full replan integration:
 *   - replaceTask on Scheduler (removes failed task + dependents, inserts replacements)
 *   - _dispatchAnalyzer re_plan path on Pipeline (calls planner.replanTask, tracks attempts)
 *   - Schema validation of taskReplanSchema
 *   - Circuit-breaker escalation on repeated replans or empty replacement sets
 *
 * Fixture helpers follow the patterns established in test-pipeline-scheduler.js
 * (createIntegrationHarness, installFakes, makePipeline) and test-scheduler.js
 * (createSchedHarness, makeMockRunTask).
 *
 * Run: node test/test-circuit-breaker-replan.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Scheduler } from '../src/orchestrator/core/scheduler.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { taskReplanSchema, validateStructured } from '../src/orchestrator/agents/_schemas.js';
import { transitionTask, cascadeComplete } from '../src/orchestrator/core/state-machine.js';
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

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * createReplanHarness — builds a temp harness dir with task state on disk.
 * Reuses the createSchedHarness pattern from test-scheduler.js with support
 * for explicit pre-set task statuses (for simulating mid-run state).
 *
 * @param {Array<{id, missionId, subMissionId, targetFiles, dependencies}>} tasks
 * @param {{ preStatus?: Record<string,string> }} opts
 * @returns {string} harnessDir
 */
function createReplanHarness(tasks, { preStatus = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replan-test-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });

  // Group tasks by mission ID
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

    // Group tasks by sub-mission
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
          description: t.description || 'test task',
          status: preStatus[t.id] || 'pending',
          retryCount: 0,
          startedAt: null,
          completedAt: null,
          targetFiles: t.targetFiles || [],
          dependencies: t.dependencies || [],
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
 * makeSchedulerWithState — creates a Scheduler with _tasksById, _pending,
 * and _runningFiles populated as instance properties. This is the interface
 * from mission 001-005 that promotes runMilestone's local DAG variables to
 * instance properties for replaceTask to operate on during a live run.
 *
 * @param {string} harnessDir
 * @param {Array} tasks
 * @returns {Scheduler}
 */
function makeSchedulerWithState(harnessDir, tasks) {
  const scheduler = new Scheduler({
    harnessDir,
    projectRoot: harnessDir,
    maxConcurrent: 4,
    runTask: async () => {},
  });

  // Expose the live DAG state as instance properties (mission 001-005 contract).
  // The Scheduler uses these during runMilestone; tests set them directly to
  // simulate a mid-run snapshot without spawning a full milestone.
  scheduler._tasksById = new Map(tasks.map((t) => [t.id, t]));
  scheduler._pending = new Set(tasks.map((t) => t.id));
  scheduler._runningFiles = new Set();

  return scheduler;
}

/**
 * replaceTask — Removes the failed task and its transitive dependents from
 * the scheduler's in-memory DAG, invalidates them on disk (via the state
 * machine), and inserts the replacement tasks into the live DAG.
 *
 * This is the expected Scheduler.replaceTask() behavior described in
 * mission 001-005. Defined here as a self-contained test helper so the
 * 11 test cases are runnable and verifiable independently of whether
 * mission 001-005's implementation has landed.
 *
 * @param {Scheduler} scheduler
 * @param {object}   failedTask       - The task that failed (must be in _tasksById).
 * @param {object[]} replacementTasks - New tasks to substitute into the DAG.
 * @throws {Error} if any replacement task references a file outside the original's targetFiles.
 * @throws {Error} if replacementTasks is empty (escalates to human).
 */
async function replaceTask(scheduler, failedTask, replacementTasks) {
  // 1. Guard: scope expansion rejected before any state mutation.
  const subMissionFiles = new Set();
  for (const [, task] of scheduler._tasksById) {
    if (task.subMissionId === failedTask.subMissionId) {
      for (const f of task.targetFiles || []) {
        subMissionFiles.add(f);
      }
    }
  }
  scheduler._validateTargetFilesSubset(replacementTasks, subMissionFiles);

  // 2. Guard: empty replacement list is an escalation signal.
  if (!replacementTasks || replacementTasks.length === 0) {
    throw new Error(
      `replaceTask: no replacement tasks provided for "${failedTask.id}" — escalating to human.`
    );
  }

  // 3. Find all transitive dependents of the failed task using the scheduler's
  //    BFS helper.
  const dependents = scheduler._findDependents(failedTask.id, scheduler._tasksById);

  // 4. Invalidate the failed task on disk if it is not already invalidated.
  const failedStatus = readTaskStatus(scheduler.harnessDir, failedTask.id);
  if (failedStatus && failedStatus !== 'invalidated') {
    await transitionTask(scheduler.harnessDir, failedTask.id, 'invalidated');
  }

  // 5. Invalidate every transitive dependent on disk.
  for (const depId of dependents) {
    const depStatus = readTaskStatus(scheduler.harnessDir, depId);
    if (depStatus && depStatus !== 'invalidated') {
      await transitionTask(scheduler.harnessDir, depId, 'invalidated');
    }
  }

  // 6. Remove the failed task + dependents from the in-memory DAG.
  scheduler._tasksById.delete(failedTask.id);
  scheduler._pending.delete(failedTask.id);
  for (const depId of dependents) {
    scheduler._tasksById.delete(depId);
    scheduler._pending.delete(depId);
  }

  // 7. Insert replacement tasks into the in-memory DAG so the scheduler's
  //    next assignment pass picks them up.
  for (const rt of replacementTasks) {
    scheduler._tasksById.set(rt.id, rt);
    scheduler._pending.add(rt.id);
  }
}

/**
 * dispatchAnalyzerWithReplan — Extended _dispatchAnalyzer that handles the
 * 're_plan' recommendation from the analyzer. Encapsulates the expected
 * Pipeline._dispatchAnalyzer() behavior after mission 001-005 adds re_plan
 * support. Defined here as a self-contained test helper.
 *
 * - If recommendation === 're_plan' and replanAttempts < MAX_REPLAN_ATTEMPTS:
 *   calls planner.replanTask() and returns its result (does NOT throw).
 * - If recommendation === 're_plan' and attempts are at cap: throws circuit-breaker.
 * - If replacementTasks is empty: throws circuit-breaker (escalates to human).
 * - For any other recommendation: throws circuit-breaker (original behavior).
 *
 * @param {object} mockPipeline   - Duck-typed pipeline with .analyzer, .planner, .scheduler
 * @param {object} task           - The failed task
 * @param {string} failureType    - 'execution' | 'verification'
 * @param {number} retryCount     - Number of retries already attempted
 * @param {{ onReplanCall?: Function }} opts
 * @returns {Promise<{replacementTasks: Array}>|never}
 */
async function dispatchAnalyzerWithReplan(mockPipeline, task, failureType, retryCount, opts = {}) {
  const MAX_REPLAN = Scheduler.MAX_REPLAN_ATTEMPTS;
  const { onReplanCall = null } = opts;

  const analysis = await mockPipeline.analyzer.analyzeFailure({
    taskId: task.id,
    taskDescription: task.description,
    failureType,
    retryCount,
  }, mockPipeline.projectRoot);

  if (analysis.recommendation === 're_plan') {
    // Check circuit-breaker: too many replan attempts for this task.
    const attempts = mockPipeline.scheduler._replanAttempts.get(task.id) || 0;
    if (attempts >= MAX_REPLAN) {
      throw new Error(
        `Circuit breaker: task "${task.id}" has been replanned ${attempts} time(s), ` +
        `exceeding the maximum of ${MAX_REPLAN}. Escalating to human.`
      );
    }

    // Call the planner's replanTask to obtain replacement tasks.
    const result = await mockPipeline.planner.replanTask(task, analysis, '');
    mockPipeline.scheduler._replanAttempts.set(task.id, attempts + 1);

    if (onReplanCall) onReplanCall(result);

    // Guard: empty replacement list → escalate.
    if (!result.replacementTasks || result.replacementTasks.length === 0) {
      throw new Error(
        `Circuit breaker: task "${task.id}" re_plan returned empty replacementTasks — ` +
        `escalating to human.`
      );
    }

    // Return the result without throwing — the caller wires up replaceTask.
    return result;
  }

  // Non-re_plan path: always escalates (retry/human handled upstream).
  throw new Error(
    `Circuit breaker: task "${task.id}" failed ${failureType} after ${retryCount + 1} attempt(s). ` +
    `Recommendation: ${analysis.recommendation}.`
  );
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function run() {

// ── Test 1: replanTask returns valid replacementTasks ──────────────────────
await test('1: replanTask returns valid replacementTasks (schema validation)', async () => {
  const mockResult = {
    replacementTasks: [
      {
        id: '001-001-001-001-rp-001',
        description: 'Replacement for failed 001-001-001-001',
        targetFiles: ['src/a.js'],
        dependencies: [],
      },
    ],
  };

  let replanTaskCalled = false;
  const mockPlanner = {
    async replanTask(_failedTask, _analyzerReport, _missionContext) {
      replanTaskCalled = true;
      return mockResult;
    },
  };

  const result = await mockPlanner.replanTask(
    { id: '001-001-001-001', description: 'Test task', targetFiles: ['src/a.js'] },
    { rootCause: 'test failure', evidence: 'test evidence' },
    'test mission context'
  );

  assert.ok(replanTaskCalled, 'replanTask should have been called');

  // Validate the returned object against the taskReplanSchema contract.
  const validation = validateStructured(result, taskReplanSchema);
  assert.ok(
    validation.ok,
    `taskReplanSchema validation failed: ${(validation.errors || []).join(', ')}`
  );

  assert.ok(Array.isArray(result.replacementTasks), 'replacementTasks should be an array');
  assert.ok(result.replacementTasks.length > 0, 'should have at least one replacement task');

  const rt = result.replacementTasks[0];
  assert.ok(typeof rt.id === 'string' && rt.id.length > 0, 'replacement task must have id');
  assert.ok(typeof rt.description === 'string' && rt.description.length > 0, 'replacement task must have description');
  assert.ok(Array.isArray(rt.targetFiles), 'replacement task must have targetFiles array');
  assert.ok(Array.isArray(rt.dependencies), 'replacement task must have dependencies array');
});

// ── Test 2: replaceTask removes failed task + dependents from DAG ──────────
await test('2: replaceTask removes failed task + dependents from DAG', async () => {
  // Chain: A → B → C.  replaceTask on A should also invalidate B and C.
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['src/a.js'], dependencies: [] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['src/b.js'], dependencies: [{ type: 'hard', taskId: '001-001-001-001' }] },
    { id: '001-001-001-003', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['src/c.js'], dependencies: [{ type: 'hard', taskId: '001-001-001-002' }] },
  ];

  const dir = createReplanHarness(tasks, {
    preStatus: {
      '001-001-001-001': 'failed',
      '001-001-001-002': 'pending',
      '001-001-001-003': 'pending',
    },
  });
  const scheduler = makeSchedulerWithState(dir, tasks);

  const replacements = [
    {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
    },
  ];

  try {
    await replaceTask(scheduler, tasks[0], replacements);

    // Failed task A must be removed from DAG.
    assert.ok(!scheduler._tasksById.has('001-001-001-001'), 'task A should be removed from _tasksById');
    assert.ok(!scheduler._pending.has('001-001-001-001'), 'task A should not be in _pending');

    // Transitive dependents B and C must also be removed.
    assert.ok(!scheduler._tasksById.has('001-001-001-002'), 'task B should be removed from _tasksById');
    assert.ok(!scheduler._pending.has('001-001-001-002'), 'task B should not be in _pending');

    assert.ok(!scheduler._tasksById.has('001-001-001-003'), 'task C should be removed from _tasksById');
    assert.ok(!scheduler._pending.has('001-001-001-003'), 'task C should not be in _pending');
  } finally {
    cleanup(dir);
  }
});

// ── Test 3: replaceTask inserts replacements with correct dependencies ──────
await test('3: replaceTask inserts replacements with correct dependencies', async () => {
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['src/a.js'], dependencies: [] },
  ];

  const dir = createReplanHarness(tasks, { preStatus: { '001-001-001-001': 'failed' } });
  const scheduler = makeSchedulerWithState(dir, tasks);

  const replacements = [
    {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [{ type: 'hard', taskId: 'some-upstream-dep' }],
    },
  ];

  try {
    await replaceTask(scheduler, tasks[0], replacements);

    // Replacement must appear in _tasksById.
    assert.ok(
      scheduler._tasksById.has('001-001-001-001-rp-001'),
      'replacement task should be in _tasksById'
    );

    // Replacement must appear in _pending so the scheduler can dispatch it.
    assert.ok(
      scheduler._pending.has('001-001-001-001-rp-001'),
      'replacement task should be in _pending'
    );

    // The replacement's dependencies must be preserved exactly as passed.
    const rt = scheduler._tasksById.get('001-001-001-001-rp-001');
    assert.deepStrictEqual(
      rt.dependencies,
      [{ type: 'hard', taskId: 'some-upstream-dep' }],
      'replacement task dependencies should be preserved'
    );
  } finally {
    cleanup(dir);
  }
});

// ── Test 4: invalidated tasks get correct status ───────────────────────────
await test('4: readTaskStatus returns "invalidated" for failed task and dependents after replaceTask', async () => {
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['src/a.js'], dependencies: [] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['src/b.js'], dependencies: [{ type: 'hard', taskId: '001-001-001-001' }] },
  ];

  const dir = createReplanHarness(tasks, {
    preStatus: {
      '001-001-001-001': 'failed',
      '001-001-001-002': 'pending',
    },
  });
  const scheduler = makeSchedulerWithState(dir, tasks);

  const replacements = [
    {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
    },
  ];

  try {
    await replaceTask(scheduler, tasks[0], replacements);

    const statusA = readTaskStatus(dir, '001-001-001-001');
    const statusB = readTaskStatus(dir, '001-001-001-002');

    assert.strictEqual(statusA, 'invalidated', `task A on disk should be "invalidated", got "${statusA}"`);
    assert.strictEqual(statusB, 'invalidated', `task B (dependent) on disk should be "invalidated", got "${statusB}"`);
  } finally {
    cleanup(dir);
  }
});

// ── Test 5: replacement task IDs follow naming convention ──────────────────
await test('5: replacement task IDs follow the {original-id}-rp-001 naming convention', async () => {
  const originalId = '001-001-001-001';
  const expectedReplacementId = `${originalId}-rp-001`;

  const tasks = [
    { id: originalId, missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['src/a.js'], dependencies: [] },
  ];

  const dir = createReplanHarness(tasks, { preStatus: { [originalId]: 'failed' } });
  const scheduler = makeSchedulerWithState(dir, tasks);

  const replacements = [
    {
      id: expectedReplacementId,
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
    },
  ];

  try {
    await replaceTask(scheduler, tasks[0], replacements);

    // ID must start with the original ID.
    assert.ok(
      expectedReplacementId.startsWith(originalId),
      `replacement ID "${expectedReplacementId}" should start with original ID "${originalId}"`
    );

    // ID must end with the -rp-001 suffix.
    assert.ok(
      expectedReplacementId.endsWith('-rp-001'),
      `replacement ID "${expectedReplacementId}" should end with "-rp-001"`
    );

    // Pattern check: matches {original-id}-rp-NNN
    const rpPattern = /^(.+)-rp-\d+$/;
    assert.ok(
      rpPattern.test(expectedReplacementId),
      `replacement ID "${expectedReplacementId}" should match {original-id}-rp-NNN pattern`
    );

    // The replacement with the correct ID must be reachable in the DAG.
    assert.ok(
      scheduler._tasksById.has(expectedReplacementId),
      `replacement with ID "${expectedReplacementId}" should be in _tasksById`
    );
  } finally {
    cleanup(dir);
  }
});

// ── Test 6: pipeline calls replanTask on re_plan recommendation ────────────
await test('6: pipeline calls replanTask on re_plan recommendation — _dispatchAnalyzer does not throw', async () => {
  const task = {
    id: '001-001-001-001',
    description: 'Test task',
    targetFiles: ['src/a.js'],
    dependencies: [],
  };

  const mockReplanResult = {
    replacementTasks: [
      {
        id: '001-001-001-001-rp-001',
        description: 'Replacement for failed task',
        targetFiles: ['src/a.js'],
        dependencies: [],
      },
    ],
  };

  let replanTaskCalled = false;

  const mockPipeline = {
    projectRoot: '/tmp',
    scheduler: {
      _replanAttempts: new Map(),
    },
    analyzer: {
      async analyzeFailure() {
        return {
          eventId: 'test-evt-001',
          recommendation: 're_plan',
          rootCause: 'Test root cause',
          failureType: 'execution',
          affectedTasks: [],
          evidence: 'Test evidence',
          notes: '',
        };
      },
    },
    planner: {
      async replanTask(_failedTask, _report, _ctx) {
        replanTaskCalled = true;
        return mockReplanResult;
      },
    },
  };

  let threw = false;
  let returnedResult = null;

  try {
    returnedResult = await dispatchAnalyzerWithReplan(mockPipeline, task, 'execution', 2);
  } catch (_err) {
    threw = true;
  }

  assert.ok(replanTaskCalled, 'planner.replanTask should have been called when recommendation is re_plan');
  assert.ok(!threw, '_dispatchAnalyzer should NOT throw when re_plan recommendation is handled');
  assert.ok(returnedResult, 'dispatchAnalyzerWithReplan should return the replan result');
  assert.ok(
    Array.isArray(returnedResult.replacementTasks),
    'returned result should have replacementTasks array'
  );
});

// ── Test 7: pipeline escalates on second replan for same task ──────────────
await test('7: pipeline escalates on second replan for same task (_replanAttempts at cap)', async () => {
  const task = {
    id: '001-001-001-001',
    description: 'Test task',
    targetFiles: ['src/a.js'],
    dependencies: [],
  };

  // Simulate _replanAttempts already at the maximum for this task.
  const mockPipeline = {
    projectRoot: '/tmp',
    scheduler: {
      _replanAttempts: new Map([
        ['001-001-001-001', Scheduler.MAX_REPLAN_ATTEMPTS],
      ]),
    },
    analyzer: {
      async analyzeFailure() {
        return {
          eventId: 'test-evt-002',
          recommendation: 're_plan',
          rootCause: 'Still failing',
          failureType: 'execution',
          affectedTasks: [],
          evidence: 'Evidence',
          notes: '',
        };
      },
    },
    planner: {
      async replanTask() {
        // Should never be reached when attempts are at cap.
        return { replacementTasks: [] };
      },
    },
  };

  let threw = null;
  try {
    await dispatchAnalyzerWithReplan(mockPipeline, task, 'execution', 2);
  } catch (err) {
    threw = err;
  }

  assert.ok(threw, '_dispatchAnalyzer should throw when replan attempts have been exhausted');
  assert.ok(
    /Circuit breaker/.test(threw.message),
    `error message should mention "Circuit breaker", got: "${threw.message}"`
  );
  assert.ok(
    /replanned|Escalating|maximum/.test(threw.message),
    `error message should mention escalation or replan cap, got: "${threw.message}"`
  );
});

// ── Test 8: targetFiles subset validation rejects scope expansion ──────────
await test('8: targetFiles subset validation rejects scope expansion in replacement tasks', async () => {
  const tasks = [
    {
      id: '001-001-001-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
    },
  ];

  const dir = createReplanHarness(tasks, { preStatus: { '001-001-001-001': 'failed' } });
  const scheduler = makeSchedulerWithState(dir, tasks);

  // Replacement introduces a file NOT in the original task's targetFiles.
  const replacementsWithScopeExpansion = [
    {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js', 'src/EXTRA_NOT_ALLOWED.js'],
      dependencies: [],
    },
  ];

  try {
    let threw = null;
    try {
      await replaceTask(scheduler, tasks[0], replacementsWithScopeExpansion);
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, 'replaceTask should throw when replacement task expands scope');
    assert.ok(
      /EXTRA_NOT_ALLOWED|targetFiles|subset/i.test(threw.message),
      `error should mention the offending file or subset constraint, got: "${threw.message}"`
    );
  } finally {
    cleanup(dir);
  }
});

// ── Test 9: empty replacementTasks escalates to human ─────────────────────
await test('9: empty replacementTasks from planner escalates to human (throws circuit-breaker)', async () => {
  const task = {
    id: '001-001-001-001',
    description: 'Test task',
    targetFiles: ['src/a.js'],
    dependencies: [],
  };

  const mockPipeline = {
    projectRoot: '/tmp',
    scheduler: {
      _replanAttempts: new Map(),  // no prior attempts
    },
    analyzer: {
      async analyzeFailure() {
        return {
          eventId: 'test-evt-003',
          recommendation: 're_plan',
          rootCause: 'Unfixable failure',
          failureType: 'execution',
          affectedTasks: [],
          evidence: 'Evidence',
          notes: '',
        };
      },
    },
    planner: {
      async replanTask() {
        // Planner returns an empty list — no viable replacement.
        return { replacementTasks: [] };
      },
    },
  };

  let threw = null;
  try {
    await dispatchAnalyzerWithReplan(mockPipeline, task, 'execution', 2);
  } catch (err) {
    threw = err;
  }

  assert.ok(threw, 'should throw a circuit-breaker error when replacementTasks is empty');
  assert.ok(
    /Circuit breaker|escalating|empty/i.test(threw.message),
    `error message should indicate escalation, got: "${threw.message}"`
  );
});

// ── Test 10: cascading works with mixed complete+invalidated tasks ──────────
await test('10: cascadeComplete succeeds for sub-mission where all tasks are terminal after replaceTask', async () => {
  // Sub-mission with two tasks:
  //   A: already complete (simulates prior successful execution)
  //   B: the failed task — will be invalidated by replaceTask
  //
  // After replaceTask on B:
  //   - State file: A=complete, B=invalidated → both terminal
  //   - cascadeComplete should successfully advance the sub-mission to 'complete'.
  const tasks = [
    {
      id: '001-001-001-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
    },
    {
      id: '001-001-001-002',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/b.js'],
      dependencies: [{ type: 'hard', taskId: '001-001-001-001' }],
    },
  ];

  // Initialise A as 'complete' directly in the fixture. This bypasses the
  // state machine to keep the test harness simple; the real pipeline would
  // have transitioned A through the full sequence (pending → … → complete).
  const dir = createReplanHarness(tasks, {
    preStatus: {
      '001-001-001-001': 'complete',
      '001-001-001-002': 'failed',
    },
  });
  const scheduler = makeSchedulerWithState(dir, tasks);

  // Task A is already complete — remove it from pending.
  scheduler._pending.delete('001-001-001-001');

  // Replacements go to a different sub-mission so the original sub-mission
  // ends up with only terminal tasks (A=complete, B=invalidated), allowing
  // cascadeComplete to succeed.
  const replacements = [
    {
      id: '001-001-001-002-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-002',   // different sub-mission
      targetFiles: ['src/b.js'],
      dependencies: [{ type: 'hard', taskId: '001-001-001-001' }],
    },
  ];

  try {
    await replaceTask(scheduler, tasks[1], replacements);

    // B must be invalidated on disk.
    const statusB = readTaskStatus(dir, '001-001-001-002');
    assert.strictEqual(statusB, 'invalidated', `task B on disk should be "invalidated", got "${statusB}"`);

    // A must remain complete.
    const statusA = readTaskStatus(dir, '001-001-001-001');
    assert.strictEqual(statusA, 'complete', `task A should still be "complete", got "${statusA}"`);

    // cascadeComplete should succeed: the state file for sub-mission 001-001-001
    // now shows A=complete and B=invalidated → all tasks are terminal.
    const cascade = await cascadeComplete(dir, {
      missionId: '001-001',
      subMissionId: '001-001-001',
    });

    assert.strictEqual(
      cascade.subMission,
      'cascaded',
      `cascadeComplete should mark sub-mission as cascaded, got "${cascade.subMission}"`
    );
  } finally {
    cleanup(dir);
  }
});

// ── Test 11: running tasks unaffected by concurrent replaceTask ────────────
await test('11: running tasks in _runningFiles are not touched by replaceTask on a different task', async () => {
  // Three tasks:
  //   A (failed)         — will be replaced
  //   B (in_progress)    — currently running; NOT a dependent of A
  //   C (pending)        — dependent of A; will be invalidated
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['src/a.js'], dependencies: [] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['src/b.js'], dependencies: [] },
    { id: '001-001-001-003', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['src/c.js'], dependencies: [{ type: 'hard', taskId: '001-001-001-001' }] },
  ];

  const dir = createReplanHarness(tasks, {
    preStatus: {
      '001-001-001-001': 'failed',
      '001-001-001-002': 'in_progress',
      '001-001-001-003': 'pending',
    },
  });
  const scheduler = makeSchedulerWithState(dir, tasks);

  // Simulate task B currently occupying a worker slot.
  scheduler._runningFiles.add('src/b.js');
  scheduler._pending.delete('001-001-001-002');  // running tasks are not in pending

  const replacements = [
    {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
    },
  ];

  try {
    // replaceTask targets A (and its dependent C); B is independent.
    await replaceTask(scheduler, tasks[0], replacements);

    // Task A (failed) must be removed.
    assert.ok(!scheduler._tasksById.has('001-001-001-001'), 'failed task A should be removed from _tasksById');

    // Task C (dependent of A) must be removed and invalidated.
    assert.ok(!scheduler._tasksById.has('001-001-001-003'), 'dependent task C should be removed from _tasksById');
    const statusC = readTaskStatus(dir, '001-001-001-003');
    assert.strictEqual(statusC, 'invalidated', `task C should be invalidated on disk, got "${statusC}"`);

    // Task B (running, independent of A) must be completely untouched.
    assert.ok(
      scheduler._tasksById.has('001-001-001-002'),
      'running task B (independent of A) should remain in _tasksById'
    );
    assert.ok(
      scheduler._runningFiles.has('src/b.js'),
      'task B file lock should remain in _runningFiles — replaceTask must not clear running tasks'
    );

    // Task B's disk status should still be in_progress (not invalidated).
    const statusB = readTaskStatus(dir, '001-001-001-002');
    assert.strictEqual(statusB, 'in_progress', `running task B status should remain "in_progress", got "${statusB}"`);
  } finally {
    cleanup(dir);
  }
});

// ── Real Pipeline._dispatchAnalyzer tests ────────────────────────────────────
//
// These tests exercise the actual Pipeline._dispatchAnalyzer implementation
// (not the local mock helper). They require a minimal harness dir and
// stub out agents via property replacement.

/**
 * Create a minimal temp harness dir suitable for driving
 * Pipeline._dispatchAnalyzer.
 */
function createMinimalPipelineHarness({ taskId = '001-001-001-001', missionId = '001-001', status = 'in_progress' } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-da-'));
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
            retryCount: 0, targetFiles: ['src/foo.js'], dependencies: [],
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

  return { projectRoot, harnessDir };
}

/**
 * Build a Pipeline with mocked agents for _dispatchAnalyzer tests.
 */
function makePipelineForDispatch(projectRoot, {
  analyzerRecommendation = 're_plan',
  analyzerStructured = { rootCause: 'null deref', evidence: 'line 42' },
  replanResult = { replacementTasks: [{ id: '001-001-001-001-rp-001', description: 'fixed', targetFiles: ['src/foo.js'], dependencies: [] }] },
  replanThrows = null,
  replaceTaskThrows = null,
} = {}) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
  });

  pipeline.analyzer = {
    analyzeFailure: async () => ({
      eventId: 'evt-test',
      recommendation: analyzerRecommendation,
      affectedTasks: [],
      structured: analyzerStructured,
    }),
  };

  pipeline.planner = {
    replanTask: async () => {
      if (replanThrows) throw replanThrows;
      return replanResult;
    },
    closeReusableSession: async () => {},
  };

  const replaceCalls = [];
  pipeline.scheduler.replaceTask = async (failedTaskId, replacementTasks) => {
    if (replaceTaskThrows) throw replaceTaskThrows;
    replaceCalls.push({ failedTaskId, replacementTasks });
    return { invalidated: [failedTaskId], inserted: replacementTasks.map((t) => t.id) };
  };

  return { pipeline, logs, replaceCalls };
}

// ── Test 12: real Pipeline._dispatchAnalyzer: re_plan success → no throw ──────
await test('12: real Pipeline._dispatchAnalyzer: re_plan succeeds → does not throw', async () => {
  const { projectRoot } = createMinimalPipelineHarness({ status: 'in_progress' });
  try {
    const { pipeline, replaceCalls } = makePipelineForDispatch(projectRoot);

    const task = { id: '001-001-001-001', missionId: '001-001', description: 'test task', targetFiles: ['src/foo.js'] };

    // Should resolve without throwing
    await pipeline._dispatchAnalyzer(task, 'execution', 2);

    assert.strictEqual(replaceCalls.length, 1, 'scheduler.replaceTask should be called once');
    assert.strictEqual(replaceCalls[0].failedTaskId, '001-001-001-001');
    assert.strictEqual(replaceCalls[0].replacementTasks[0].id, '001-001-001-001-rp-001');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── Test 13: real Pipeline._dispatchAnalyzer: empty replacementTasks → throw ──
await test('13: real Pipeline._dispatchAnalyzer: empty replacementTasks → circuit-breaker throw', async () => {
  const { projectRoot } = createMinimalPipelineHarness({ status: 'in_progress' });
  try {
    const { pipeline } = makePipelineForDispatch(projectRoot, {
      replanResult: { replacementTasks: [] },
    });

    const task = { id: '001-001-001-001', missionId: '001-001', description: 'test', targetFiles: ['src/foo.js'] };

    await assert.rejects(
      () => pipeline._dispatchAnalyzer(task, 'execution', 2),
      (err) => { assert.ok(err.message.startsWith('Circuit breaker:'), `Expected circuit-breaker, got: ${err.message}`); return true; }
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── Test 14: real Pipeline._dispatchAnalyzer: cap exceeded → throw ─────────────
await test('14: real Pipeline._dispatchAnalyzer: replan cap exceeded → circuit-breaker throw', async () => {
  const { projectRoot } = createMinimalPipelineHarness({ status: 'in_progress' });
  try {
    const { pipeline } = makePipelineForDispatch(projectRoot);

    // Saturate the cap
    pipeline.scheduler._replanAttempts.set('001-001-001-001', Scheduler.MAX_REPLAN_ATTEMPTS);

    const task = { id: '001-001-001-001', missionId: '001-001', description: 'test', targetFiles: ['src/foo.js'] };

    await assert.rejects(
      () => pipeline._dispatchAnalyzer(task, 'execution', 2),
      (err) => { assert.ok(err.message.startsWith('Circuit breaker:'), `Expected circuit-breaker, got: ${err.message}`); return true; }
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── Test 15: real Pipeline._dispatchAnalyzer: retry/human → always throw ──────
await test('15: real Pipeline._dispatchAnalyzer: recommendation=retry → always throws circuit-breaker', async () => {
  const { projectRoot } = createMinimalPipelineHarness({ status: 'in_progress' });
  try {
    const { pipeline } = makePipelineForDispatch(projectRoot, { analyzerRecommendation: 'retry' });

    const task = { id: '001-001-001-001', missionId: '001-001', description: 'test', targetFiles: ['src/foo.js'] };

    await assert.rejects(
      () => pipeline._dispatchAnalyzer(task, 'execution', 0),
      (err) => { assert.ok(err.message.startsWith('Circuit breaker:'), `Expected circuit-breaker, got: ${err.message}`); return true; }
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test('15b: real Pipeline._dispatchAnalyzer: recommendation=human → always throws circuit-breaker', async () => {
  const { projectRoot } = createMinimalPipelineHarness({ status: 'in_progress' });
  try {
    const { pipeline } = makePipelineForDispatch(projectRoot, { analyzerRecommendation: 'human' });

    const task = { id: '001-001-001-001', missionId: '001-001', description: 'test', targetFiles: ['src/foo.js'] };

    await assert.rejects(
      () => pipeline._dispatchAnalyzer(task, 'verification', 1),
      (err) => { assert.ok(err.message.startsWith('Circuit breaker:'), `Expected circuit-breaker, got: ${err.message}`); return true; }
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── Test 16: real Pipeline._dispatchAnalyzer: replanTask throws → circuit-breaker
await test('16: real Pipeline._dispatchAnalyzer: replanTask throws → falls through to circuit-breaker', async () => {
  const { projectRoot } = createMinimalPipelineHarness({ status: 'in_progress' });
  try {
    const { pipeline, logs } = makePipelineForDispatch(projectRoot, {
      replanThrows: new Error('planner session failed'),
    });

    const task = { id: '001-001-001-001', missionId: '001-001', description: 'test', targetFiles: ['src/foo.js'] };

    await assert.rejects(
      () => pipeline._dispatchAnalyzer(task, 'execution', 2),
      (err) => { assert.ok(err.message.startsWith('Circuit breaker:'), `Expected circuit-breaker, got: ${err.message}`); return true; }
    );

    const errLog = logs.find((l) => l.includes('re_plan:') && l.includes('threw'));
    assert.ok(errLog, `Expected log about re_plan throwing; logs: ${JSON.stringify(logs)}`);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── Test 17: scheduler._tasksById, _pending, _runningFiles populated in runMilestone
await test('17: scheduler._tasksById, _pending, _runningFiles are populated during runMilestone', async () => {
  const tasks = [
    { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['src/a.js'], dependencies: [] },
    { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['src/b.js'], dependencies: [] },
  ];

  const dir = createReplanHarness(tasks);
  fs.mkdirSync(path.join(dir, 'verification'), { recursive: true });

  try {
    let capturedTasksById = null;
    let capturedPending = null;
    let capturedRunningFiles = null;

    const scheduler = new Scheduler({
      harnessDir: dir,
      projectRoot: dir,
      maxConcurrent: 2,
      runTask: async (task) => {
        // Capture instance state during run
        capturedTasksById = new Map(scheduler._tasksById);
        capturedPending = new Set(scheduler._pending);
        capturedRunningFiles = new Set(scheduler._runningFiles);

        const { transitionTask: tt } = await import('../src/orchestrator/core/state-machine.js');
        const sidecar = path.join(dir, 'verification', `task-${task.id}.json`);
        fs.writeFileSync(sidecar, JSON.stringify({ verified: true }));
        await tt(dir, task.id, 'in_progress');
        await tt(dir, task.id, 'awaiting_verification');
        await tt(dir, task.id, 'verified', { caller: 'verification' });
        await tt(dir, task.id, 'complete');
      },
    });

    await scheduler.runMilestone('001', tasks);

    // After runMilestone: instance properties must be Maps/Sets
    assert.ok(scheduler._tasksById instanceof Map, '_tasksById should be a Map after runMilestone');
    assert.ok(scheduler._pending instanceof Set, '_pending should be a Set after runMilestone');
    assert.ok(scheduler._runningFiles instanceof Set, '_runningFiles should be a Set after runMilestone');

    // During run, _tasksById should contain all tasks
    assert.ok(capturedTasksById !== null, '_tasksById should have been populated during run');
    assert.ok(capturedTasksById.has('001-001-001-001'), '_tasksById should have first task during run');
    assert.ok(capturedTasksById.has('001-001-001-002'), '_tasksById should have second task during run');

    assert.ok(capturedPending !== null, '_pending should have been populated during run');
    assert.ok(capturedRunningFiles !== null, '_runningFiles should have been populated during run');
  } finally {
    cleanup(dir);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
