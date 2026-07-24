/**
 * test-planner-sequential-ordering-integration.js — Integration tests for
 * sub-mission sequential ordering dep-chain wiring.
 *
 * Verifies that the reusable planMission call path invokes the
 * `_enforceSequentialOrdering` post-processor so that sub-missions with
 * `ordering: 'sequential'` always yield a synthesized hard dep chain
 * A→B→C, regardless of what the LLM emitted in `dependencies`.
 *
 * TC-wire-reusable: _planMissionReusable returns plan with synthesized
 *   hard dep chain A→B→C in the sequential sub-mission's tasks.
 *
 * No live SDK calls are made. The reusable path uses a fake session that
 * returns a pre-built structured_output with ordering:'sequential' and three
 * tasks that have NO dependencies — the post-processor must inject them.
 *
 * See: 2026-05-03-planner-sequential-ordering.md (spec),
 * _enforceSequentialOrdering (post-processor method).
 *
 * Run: node test/test-planner-sequential-ordering-integration.js
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Planner } from '../src/orchestrator/agents/planner.js';
import { writeMissionState, stateToDecomp } from '../src/orchestrator/core/state.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  const run = async () => {
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
  };
  return run();
}

/**
 * Returns a structured_output plan with a single sequential sub-mission
 * containing three tasks (A, B, C) without any pre-wired dependencies.
 * This is the raw LLM output before the post-processor runs.
 */
function makeSequentialPlan() {
  return {
    subMissions: [
      {
        id: '001-001-001',
        description: 'Sequential sub-mission for testing',
        ordering: 'sequential',
        tasks: [
          {
            id: '001-001-001-001',
            description: 'Task A — first step',
            targetFiles: ['src/a.js'],
            dependencies: [],
            testCases: [],
          },
          {
            id: '001-001-001-002',
            description: 'Task B — second step',
            targetFiles: ['src/b.js'],
            dependencies: [],
            testCases: [],
          },
          {
            id: '001-001-001-003',
            description: 'Task C — third step',
            targetFiles: ['src/c.js'],
            dependencies: [],
            testCases: [],
          },
        ],
      },
    ],
  };
}

/**
 * Reusable-session fake. sendPrompt() resolves with the sequential plan
 * as structured_output. Also exposes a minimal handle so the planner's
 * per-turn telemetry path doesn't throw.
 */
function makeFakeReusableSession() {
  return {
    turnCount: 0,
    handle: {
      systemPromptTokens: 0,
      _toolCallCount: 0,
    },
    sendPrompt: async () => ({
      type: 'result',
      structured_output: makeSequentialPlan(),
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      total_cost_usd: 0,
    }),
  };
}

function makeFakeLogger() {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-planner-ordering-integration.jsonl',
      write: () => {},
      close: () => {},
    }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
    warn: () => {},
    info: () => {},
  };
}

// ── TC-wire-reusable ──────────────────────────────────────────────────────────
//
// _planMissionReusable must call _enforceSequentialOrdering after
// _warnIfVagueDescriptions. Same dep chain assertions, reusable-session path.

await test('TC-wire-reusable: _planMissionReusable returns plan with synthesized hard dep chain A→B→C', async () => {
  const fakeReusableSession = makeFakeReusableSession();
  const fakeSessionManager = {
    spawnReusable: () => fakeReusableSession,
  };

  const planner = new Planner(
    fakeSessionManager,
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  // Pre-populate the reusable session so _ensureReusableSession doesn't try
  // to call spawnReusable (which requires a more elaborate setup).
  // This mirrors the approach in test-planner-reuse.js line 616.
  planner._reusableSession = fakeReusableSession;

  const plan = await planner._planMissionReusable(
    '001-001-001',
    '/fake/root',
    { missionPlan: 'sequential test plan' },
    7,
  );

  assert.ok(plan, 'plan should be returned');
  assert.ok(Array.isArray(plan.subMissions), 'plan should have subMissions array');
  assert.equal(plan.subMissions.length, 1, 'plan should have exactly one sub-mission');

  const sm = plan.subMissions[0];
  assert.equal(sm.id, '001-001-001', 'sub-mission id should match');
  assert.equal(sm.ordering, 'sequential', 'sub-mission ordering should be sequential');
  assert.ok(Array.isArray(sm.tasks), 'sub-mission should have tasks array');
  assert.equal(sm.tasks.length, 3, 'sub-mission should have 3 tasks');

  // tasks[0] (A) needs no synthesized dependency
  assert.equal(sm.tasks[0].id, '001-001-001-001', 'tasks[0] should be task A');

  // tasks[1] (B) must have a hard dep on tasks[0] (A)
  assert.equal(sm.tasks[1].id, '001-001-001-002', 'tasks[1] should be task B');
  assert.ok(
    Array.isArray(sm.tasks[1].dependencies),
    'tasks[1].dependencies should be an array',
  );
  const bHasDepOnA = sm.tasks[1].dependencies.some(
    (d) => d.taskId === '001-001-001-001' && d.type === 'hard',
  );
  assert.ok(
    bHasDepOnA,
    `tasks[1].dependencies should include { taskId:'001-001-001-001', type:'hard' }\n` +
    `Got: ${JSON.stringify(sm.tasks[1].dependencies)}`,
  );

  // tasks[2] (C) must have a hard dep on tasks[1] (B)
  assert.equal(sm.tasks[2].id, '001-001-001-003', 'tasks[2] should be task C');
  assert.ok(
    Array.isArray(sm.tasks[2].dependencies),
    'tasks[2].dependencies should be an array',
  );
  const cHasDepOnB = sm.tasks[2].dependencies.some(
    (d) => d.taskId === '001-001-001-002' && d.type === 'hard',
  );
  assert.ok(
    cHasDepOnB,
    `tasks[2].dependencies should include { taskId:'001-001-001-002', type:'hard' }\n` +
    `Got: ${JSON.stringify(sm.tasks[2].dependencies)}`,
  );
});

// ── TC-roundtrip ──────────────────────────────────────────────────────────────
//
// writeMissionState persists the synthesized hard dep chain to disk.
// stateToDecomp reconstructs it. The round-trip must preserve:
//   tasks[1].dependencies deep-equals [{ taskId: A.id, type: 'hard' }]
//   tasks[2].dependencies deep-equals [{ taskId: B.id, type: 'hard' }]

await test('TC-roundtrip: synthesized deps survive writeMissionState → stateToDecomp round-trip', async () => {
  const taskA = {
    id: '001-001-001-001',
    description: 'Task A — first step',
    targetFiles: ['src/a.js'],
    dependencies: [],
    testCases: [],
    tracesScenario: [],
    patternReferences: [],
    dataSchemas: [],
  };
  const taskB = {
    id: '001-001-001-002',
    description: 'Task B — second step',
    targetFiles: ['src/b.js'],
    dependencies: [{ taskId: taskA.id, type: 'hard' }],
    testCases: [],
    tracesScenario: [],
    patternReferences: [],
    dataSchemas: [],
  };
  const taskC = {
    id: '001-001-001-003',
    description: 'Task C — third step',
    targetFiles: ['src/c.js'],
    dependencies: [{ taskId: taskB.id, type: 'hard' }],
    testCases: [],
    tracesScenario: [],
    patternReferences: [],
    dataSchemas: [],
  };

  const decomp = {
    subMissions: [
      {
        id: '001-001-001',
        description: 'Sequential sub-mission for round-trip testing',
        tasks: [taskA, taskB, taskC],
      },
    ],
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-roundtrip-'));
  try {
    writeMissionState(tmpDir, '001-001', 'Test mission', decomp);

    const stateFile = path.join(tmpDir, 'state', 'mission-001-001.json');
    const missionState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

    const reconstructed = stateToDecomp(missionState);

    assert.ok(Array.isArray(reconstructed.subMissions), 'reconstructed should have subMissions array');
    assert.equal(reconstructed.subMissions.length, 1, 'should have one sub-mission');

    const sm = reconstructed.subMissions[0];
    assert.equal(sm.tasks.length, 3, 'sub-mission should have 3 tasks');

    // tasks[1] (B) must have exactly [{ taskId: A.id, type: 'hard' }]
    assert.deepEqual(
      sm.tasks[1].dependencies,
      [{ taskId: taskA.id, type: 'hard' }],
      `tasks[1].dependencies should deep-equal [{taskId:'${taskA.id}', type:'hard'}]\n` +
      `Got: ${JSON.stringify(sm.tasks[1].dependencies)}`,
    );

    // tasks[2] (C) must have exactly [{ taskId: B.id, type: 'hard' }]
    assert.deepEqual(
      sm.tasks[2].dependencies,
      [{ taskId: taskB.id, type: 'hard' }],
      `tasks[2].dependencies should deep-equal [{taskId:'${taskB.id}', type:'hard'}]\n` +
      `Got: ${JSON.stringify(sm.tasks[2].dependencies)}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
