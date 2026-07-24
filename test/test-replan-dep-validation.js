/**
 * test-replan-dep-validation.js — Behavior tests for replan dependency teaching
 * and dependency-existence validation.
 *
 * Covers three behavior areas (spec-driven, black-box):
 *   A. buildReplanSystemPrompt() teaches the `dependencies` field: shape
 *      { taskId, type } with 'hard'/'soft', hard-only-for-read-after-write,
 *      only-existing-or-in-batch task ids, empty array as the normal case.
 *   B. The three Planner remediation prompts (remediateScenarios,
 *      remediateReviewFindings, remediateRegressionFailure) each state that
 *      subMissionId must name an EXISTING sub-mission and that task ids
 *      follow the {subMissionId}-{seq} pattern.
 *   C. Scheduler.replaceTask strips dependencies on unknown/malformed task
 *      ids (with an onLog warning naming the replacement and the unknown
 *      dep), keeps deps on existing DAG tasks and intra-batch replacements,
 *      and still inserts the batch successfully.
 *
 * No live Claude sessions are spawned — sessionManager.spawn is mocked
 * following the test-review-remediation-planner.js pattern. Scheduler
 * fixtures use fs.mkdtemp temp harness dirs (test-scheduler-replace-task.js
 * pattern); the repo's own .harness/ is never touched.
 *
 * Run: node test/test-replan-dep-validation.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildReplanSystemPrompt } from '../src/orchestrator/agents/planner-prompts.js';
import { Planner } from '../src/orchestrator/agents/planner.js';
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

// ── Part A: buildReplanSystemPrompt teaches the dependencies field ───────────

await test('A1: replan system prompt is a non-empty string mentioning the dependencies field', async () => {
  const prompt = buildReplanSystemPrompt();
  assert.ok(typeof prompt === 'string' && prompt.length > 0,
    'buildReplanSystemPrompt() must return a non-empty string');
  assert.ok(/dependencies/.test(prompt),
    'prompt must mention the `dependencies` field');
});

await test('A2: replan system prompt teaches the { taskId, type } shape with hard and soft types', async () => {
  const prompt = buildReplanSystemPrompt();
  assert.ok(/taskId/.test(prompt),
    'prompt must name the taskId key of a dependency item');
  assert.ok(/\btype\b/.test(prompt),
    'prompt must name the type key of a dependency item');
  assert.ok(/['"`]?hard['"`]?/.test(prompt) && /\bhard\b/.test(prompt),
    "prompt must name the 'hard' dependency type");
  assert.ok(/\bsoft\b/.test(prompt),
    "prompt must name the 'soft' dependency type");
});

await test('A3: replan system prompt restricts hard deps to read-after-write relationships', async () => {
  const prompt = buildReplanSystemPrompt();
  // 'hard' is used ONLY when the replacement reads something another task writes.
  assert.ok(/\bonly\b/i.test(prompt),
    "prompt must scope 'hard' with an ONLY-style restriction");
  assert.ok(/\breads?\b/i.test(prompt),
    'prompt must mention reading as the hard-dep trigger');
  assert.ok(/\bwrit(es?|ten|ing)\b/i.test(prompt),
    'prompt must mention another task writing as the hard-dep trigger');
});

await test('A4: replan system prompt forbids invented ids — only current plan or replacement batch', async () => {
  const prompt = buildReplanSystemPrompt();
  assert.ok(/exist/i.test(prompt),
    'prompt must require referenced task ids to exist');
  assert.ok(/\bbatch\b/i.test(prompt),
    'prompt must allow referencing ids from the replacement batch');
  assert.ok(/(current|existing)\s+plan/i.test(prompt),
    'prompt must allow referencing ids from the current/existing plan');
  assert.ok(/invent|made.?up|fabricat|do not (create|make up) new (task )?ids/i.test(prompt),
    'prompt must forbid invented/made-up task ids');
});

await test('A5: replan system prompt says an empty array is the normal/independent case', async () => {
  const prompt = buildReplanSystemPrompt();
  assert.ok(/empty array/i.test(prompt),
    'prompt must describe the empty-array case');
  assert.ok(/independen|normal|no depend|most/i.test(prompt),
    'prompt must frame the empty array as the normal / independent case');
});

// ── Part B: remediation prompts pin subMissionId + task-id pattern ───────────

const SUBMISSION_EXISTS_RE = /subMissionId must name an EXISTING sub-mission/i;
const TASK_ID_PATTERN_RE = /\{subMissionId\}-\{seq\}/;

/** Mock logger satisfying Planner's internal usage. */
function makeMockLogger() {
  return {
    createSessionLog: (_name) => ({ close: () => {} }),
    attachToSession: () => {},
    warn: () => {},
  };
}

/**
 * Mock sessionManager whose spawn() records call options and resolves to a
 * fixture result (thenable carries .handle, as Planner expects).
 */
function makeMockSessionManager(resultFixture) {
  const spawnCalls = [];
  const mockSessionManager = {
    spawn(opts) {
      spawnCalls.push(opts);
      const mockHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
      const p = Promise.resolve({ handle: mockHandle, result: resultFixture });
      p.handle = mockHandle;
      return p;
    },
  };
  return { mockSessionManager, getSpawnCalls: () => spawnCalls };
}

const remediationTaskFixture = [
  {
    id: '001-001-001-001',
    subMissionId: '001-001-001',
    description: 'Fix finding in executor.js',
    targetFiles: ['src/orchestrator/agents/executor.js'],
  },
];

const sampleFindings = [
  {
    severity: 'critical',
    category: 'functional',
    file: 'src/orchestrator/agents/executor.js',
    description: 'Missing null check before accessing result.structured_output',
  },
];

function assertPromptPinsSubMissionRules(prompt, label) {
  assert.ok(typeof prompt === 'string' && prompt.length > 0,
    `${label}: captured prompt should be a non-empty string`);
  assert.ok(SUBMISSION_EXISTS_RE.test(prompt),
    `${label}: prompt must state subMissionId must name an EXISTING sub-mission.\nPrompt:\n${prompt}`);
  assert.ok(TASK_ID_PATTERN_RE.test(prompt),
    `${label}: prompt must state task ids follow {subMissionId}-{seq}.\nPrompt:\n${prompt}`);
}

await test('B1: remediateScenarios prompt pins EXISTING sub-mission + {subMissionId}-{seq}', async () => {
  const fixture = { structured_output: { newTasks: [], outOfScope: [] } };
  const { mockSessionManager, getSpawnCalls } = makeMockSessionManager(fixture);
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  await planner.remediateScenarios('001-001', '/tmp/project', {
    uncoveredScenarios: ['SC-1: user can log in with valid credentials'],
    missionPlan: '# Mission plan\nSome plan text.',
  });

  const calls = getSpawnCalls();
  assert.equal(calls.length, 1, `Expected 1 spawn call, got ${calls.length}`);
  assertPromptPinsSubMissionRules(calls[0].prompt, 'remediateScenarios');
});

await test('B2: remediateReviewFindings prompt pins EXISTING sub-mission + {subMissionId}-{seq}', async () => {
  const fixture = { structured_output: { newTasks: remediationTaskFixture } };
  const { mockSessionManager, getSpawnCalls } = makeMockSessionManager(fixture);
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  await planner.remediateReviewFindings('001-002', sampleFindings, '/tmp/project');

  const calls = getSpawnCalls();
  assert.equal(calls.length, 1, `Expected 1 spawn call, got ${calls.length}`);
  assertPromptPinsSubMissionRules(calls[0].prompt, 'remediateReviewFindings');
});

await test('B3: remediateRegressionFailure prompt pins EXISTING sub-mission + {subMissionId}-{seq}', async () => {
  const fixture = { structured_output: { newTasks: remediationTaskFixture } };
  const { mockSessionManager, getSpawnCalls } = makeMockSessionManager(fixture);
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  await planner.remediateRegressionFailure('001-002', sampleFindings, '/tmp/project');

  const calls = getSpawnCalls();
  assert.equal(calls.length, 1, `Expected 1 spawn call, got ${calls.length}`);
  assertPromptPinsSubMissionRules(calls[0].prompt, 'remediateRegressionFailure');
});

// ── Part C fixtures: temp-harness Scheduler (test-scheduler-replace-task.js pattern) ──

/**
 * Create a temp harness dir with a minimal global state.json + per-mission
 * state files. Tasks default to 'pending'.
 */
function createSchedHarness(tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replan-depval-test-'));
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

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a minimal Scheduler with a no-op runTask, preset DAG state, and a
 * log collector wired through onLog.
 */
function makeScheduler(harnessDir, tasks, logs) {
  const scheduler = new Scheduler({
    harnessDir,
    projectRoot: harnessDir,
    maxConcurrent: 4,
    runTask: async () => {},
    onLog: (msg) => logs.push(String(msg)),
  });
  scheduler._tasksById = new Map(tasks.map((t) => [t.id, t]));
  scheduler._pending = new Set(tasks.map((t) => t.id));
  scheduler._runningFiles = new Set();
  return scheduler;
}

/** Canonical two-task DAG: A (will fail) + independent B (dep target). */
function makeBaseTasks() {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/a.js', 'src/a2.js'],
    dependencies: [],
    description: 'Task A (will be replaced)',
  };
  const taskB = {
    id: '001-001-001-002',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/b.js'],
    dependencies: [],
    description: 'Task B (independent, valid dep target)',
  };
  return { taskA, taskB };
}

// ── Part C: replaceTask dependency-existence validation ─────────────────────

await test('C1: well-formed but nonexistent dep id is stripped and an onLog warning names both ids', async () => {
  const { taskA, taskB } = makeBaseTasks();
  const dir = createSchedHarness([taskA, taskB]);
  const logs = [];
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB], logs);

    const unknownDepId = '001-001-999-999';   // well-formed, exists nowhere
    const rp1 = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [{ taskId: unknownDepId, type: 'hard' }],
      description: 'Replacement with phantom dep',
    };

    const result = await scheduler.replaceTask(taskA.id, [rp1]);

    assert.ok(result.inserted.includes(rp1.id),
      'replacement should still be inserted despite the phantom dep');

    const inserted = scheduler._tasksById.get(rp1.id);
    assert.ok(inserted, 'inserted replacement should be in _tasksById');
    assert.ok(
      !inserted.dependencies.some((d) => d.taskId === unknownDepId),
      `phantom dep ${unknownDepId} must be stripped from the inserted task, got: ${JSON.stringify(inserted.dependencies)}`
    );

    const warning = logs.find((l) => l.includes(rp1.id) && l.includes(unknownDepId));
    assert.ok(warning,
      `an onLog warning must name both the replacement id (${rp1.id}) and the unknown dep id (${unknownDepId}).\nLogs:\n${logs.join('\n')}`);
  } finally { cleanup(dir); }
});

await test('C2: malformed dep id (e.g. "setup-db") is stripped without throwing', async () => {
  const { taskA, taskB } = makeBaseTasks();
  const dir = createSchedHarness([taskA, taskB]);
  const logs = [];
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB], logs);

    const rp1 = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [{ taskId: 'setup-db', type: 'hard' }],
      description: 'Replacement with malformed dep id',
    };

    let threw = null;
    let result;
    try {
      result = await scheduler.replaceTask(taskA.id, [rp1]);
    } catch (err) {
      threw = err;
    }

    assert.ok(!threw, `replaceTask must not throw on a malformed dep id, got: ${threw?.message}`);
    assert.ok(result.inserted.includes(rp1.id), 'replacement should still be inserted');

    const inserted = scheduler._tasksById.get(rp1.id);
    assert.ok(
      !inserted.dependencies.some((d) => d.taskId === 'setup-db'),
      `malformed dep "setup-db" must be stripped, got: ${JSON.stringify(inserted.dependencies)}`
    );
  } finally { cleanup(dir); }
});

await test('C3: dep on an existing DAG task id is KEPT', async () => {
  const { taskA, taskB } = makeBaseTasks();
  const dir = createSchedHarness([taskA, taskB]);
  const logs = [];
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB], logs);

    const rp1 = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [{ taskId: taskB.id, type: 'hard' }],   // B exists in the DAG
      description: 'Replacement depending on existing task B',
    };

    const result = await scheduler.replaceTask(taskA.id, [rp1]);

    assert.ok(result.inserted.includes(rp1.id), 'replacement should be inserted');
    const inserted = scheduler._tasksById.get(rp1.id);
    assert.strictEqual(inserted.dependencies.length, 1,
      `dep on existing DAG task must be kept, got: ${JSON.stringify(inserted.dependencies)}`);
    assert.strictEqual(inserted.dependencies[0].taskId, taskB.id,
      `kept dep should point at existing task ${taskB.id}`);
  } finally { cleanup(dir); }
});

await test('C4: intra-batch dep (replacement depends on sibling replacement) is KEPT', async () => {
  const { taskA, taskB } = makeBaseTasks();
  const dir = createSchedHarness([taskA, taskB]);
  const logs = [];
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB], logs);

    const rp1 = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'Replacement 1 (batch sibling)',
    };
    const rp2 = {
      id: '001-001-001-001-rp-002',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a2.js'],
      dependencies: [{ taskId: rp1.id, type: 'hard' }],   // intra-batch dep
      description: 'Replacement 2 (depends on sibling rp-001)',
    };

    const result = await scheduler.replaceTask(taskA.id, [rp1, rp2]);

    assert.ok(result.inserted.includes(rp1.id) && result.inserted.includes(rp2.id),
      'both batch replacements should be inserted');
    const inserted2 = scheduler._tasksById.get(rp2.id);
    assert.strictEqual(inserted2.dependencies.length, 1,
      `intra-batch dep must be kept, got: ${JSON.stringify(inserted2.dependencies)}`);
    assert.strictEqual(inserted2.dependencies[0].taskId, rp1.id,
      `kept intra-batch dep should point at sibling ${rp1.id}`);
  } finally { cleanup(dir); }
});

await test('C5: mixed deps — unknown stripped, existing + intra-batch kept, batch inserted successfully', async () => {
  const { taskA, taskB } = makeBaseTasks();
  const dir = createSchedHarness([taskA, taskB]);
  const logs = [];
  try {
    const scheduler = makeScheduler(dir, [taskA, taskB], logs);

    const unknownDepId = '001-001-777-777';
    const rp1 = {
      id: '001-001-001-001-rp-001',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a.js'],
      dependencies: [],
      description: 'Replacement 1 (no deps)',
    };
    const rp2 = {
      id: '001-001-001-001-rp-002',
      missionId: '001-001',
      subMissionId: '001-001-001',
      targetFiles: ['src/a2.js'],
      dependencies: [
        { taskId: unknownDepId, type: 'hard' },   // → stripped
        { taskId: taskB.id, type: 'soft' },       // existing DAG task → kept
        { taskId: rp1.id, type: 'hard' },         // intra-batch → kept
      ],
      description: 'Replacement 2 (mixed deps)',
    };

    const result = await scheduler.replaceTask(taskA.id, [rp1, rp2]);

    // Despite stripping, replaceTask succeeds and inserts the whole batch.
    assert.deepStrictEqual(result.inserted, [rp1.id, rp2.id],
      `inserted must contain both replacements in order, got: ${JSON.stringify(result.inserted)}`);
    assert.ok(!scheduler._pending.has(taskA.id), 'failed task should leave _pending');
    assert.ok(scheduler._pending.has(rp1.id) && scheduler._pending.has(rp2.id),
      'both replacements should be in _pending');

    // Inserted task's dependencies reflect the stripped/kept set.
    const inserted2 = scheduler._tasksById.get(rp2.id);
    const depIds = inserted2.dependencies.map((d) => d.taskId).sort();
    assert.deepStrictEqual(depIds, [taskB.id, rp1.id].sort(),
      `rp2's deps after validation should be exactly [existing B, sibling rp1], got: ${JSON.stringify(inserted2.dependencies)}`);
    assert.ok(
      !inserted2.dependencies.some((d) => d.taskId === unknownDepId),
      `unknown dep ${unknownDepId} must be stripped`
    );

    // Warning emitted for the stripped dep, naming both ids.
    const warning = logs.find((l) => l.includes(rp2.id) && l.includes(unknownDepId));
    assert.ok(warning,
      `an onLog warning must name both ${rp2.id} and ${unknownDepId}.\nLogs:\n${logs.join('\n')}`);
  } finally { cleanup(dir); }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
