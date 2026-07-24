/**
 * test-planner-sequential-ordering.js — Unit tests for sub-mission ordering
 * schema field and prompt guidance.
 *
 * TC1: schema has `ordering` property at subMissions.items.properties.ordering
 *      with enum ['sequential','parallel']
 * TC2: `ordering` is NOT in subMissions.items.required
 * TC3: planMission systemPrompt contains '## Sub-mission ordering' heading
 * TC4: prompt contains a Good example and a Bad example for ordering
 *
 * No live SDK calls are made — a fake sessionManager intercepts
 * spawnReusable() and captures both the systemPrompt and jsonSchema
 * (which the reusable planner path bakes in at spawn time) before they
 * reach the network.
 *
 * Run: node test/test-planner-sequential-ordering.js
 */
import assert from 'assert';
import { Planner } from '../src/orchestrator/agents/planner.js';

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
 * Returns a fake session manager whose spawnReusable() captures both the
 * systemPrompt and jsonSchema into the provided arrays. The reusable
 * planner path (the only surviving path) passes both to spawnReusable()
 * at session-creation time, so this is where they are intercepted.
 *
 * The returned reusable session exposes the minimal surface the planner
 * touches: a handle (telemetry), turnCount, and a sendPrompt() that
 * resolves an empty structured_output plan.
 */
function makeFakeSessionManager(capturedPrompts, capturedSchemas) {
  return {
    spawnReusable(opts) {
      if (capturedPrompts) capturedPrompts.push(opts.systemPrompt);
      if (capturedSchemas) capturedSchemas.push(opts.jsonSchema);
      return {
        turnCount: 0,
        handle: {
          systemPromptTokens: 0,
          _toolCallCount: 0,
        },
        sendPrompt: async () => ({
          type: 'result',
          structured_output: { subMissions: [], milestones: [] },
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          total_cost_usd: 0,
        }),
      };
    },
  };
}

function makeFakeLogger() {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-planner-ordering.jsonl',
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

// ── TC1: schema ordering enum values are ['sequential','parallel'] ────────

await test('TC1: schema ordering enum values are [\'sequential\',\'parallel\']', async () => {
  const capturedPrompts = [];
  const capturedSchemas = [];
  const planner = new Planner(
    makeFakeSessionManager(capturedPrompts, capturedSchemas),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner._planMissionReusable('001-001', '/fake/root', { missionPlan: 'test plan' }, 7);

  assert.equal(capturedSchemas.length, 1, 'spawnReusable() should have been called exactly once');
  const schema = capturedSchemas[0];

  assert.ok(schema, 'jsonSchema should be defined');
  assert.ok(schema.properties, 'jsonSchema should have properties');
  assert.ok(schema.properties.subMissions, 'jsonSchema should have subMissions property');
  assert.ok(schema.properties.subMissions.items, 'subMissions should have items');
  assert.ok(schema.properties.subMissions.items.properties, 'subMissions.items should have properties');

  const orderingProp = schema.properties.subMissions.items.properties.ordering;
  assert.ok(
    orderingProp,
    `subMissions.items.properties should have an 'ordering' property\n` +
    `Available properties: ${Object.keys(schema.properties.subMissions.items.properties).join(', ')}`,
  );

  assert.ok(
    Array.isArray(orderingProp.enum),
    `ordering property should have an enum array, got: ${JSON.stringify(orderingProp)}`,
  );

  assert.deepStrictEqual(
    orderingProp.enum,
    ['sequential', 'parallel'],
    `ordering enum should be ['sequential','parallel'], got: ${JSON.stringify(orderingProp.enum)}`,
  );
});

// ── TC2: ordering not in required array ──────────────────────────────────

await test('TC2: ordering not in required array', async () => {
  const capturedPrompts = [];
  const capturedSchemas = [];
  const planner = new Planner(
    makeFakeSessionManager(capturedPrompts, capturedSchemas),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner._planMissionReusable('001-001', '/fake/root', { missionPlan: 'test plan' }, 7);

  assert.equal(capturedSchemas.length, 1, 'spawnReusable() should have been called exactly once');
  const schema = capturedSchemas[0];

  const subMissionItems = schema?.properties?.subMissions?.items;
  assert.ok(subMissionItems, 'subMissions.items should exist in schema');

  const required = subMissionItems.required || [];
  assert.ok(
    !required.includes('ordering'),
    `'ordering' should NOT be in subMissions.items.required, but found it in: ${JSON.stringify(required)}`,
  );
});

// ── TC3: prompt contains '## Sub-mission ordering' ───────────────────────

await test('TC3: prompt contains \'## Sub-mission ordering\'', async () => {
  const capturedPrompts = [];
  const planner = new Planner(
    makeFakeSessionManager(capturedPrompts),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner._planMissionReusable('001-001', '/fake/root', { missionPlan: 'test plan' }, 7);

  assert.equal(capturedPrompts.length, 1, 'spawnReusable() should have been called exactly once');
  const systemPrompt = capturedPrompts[0];

  assert.ok(
    systemPrompt.includes('## Sub-mission ordering'),
    `planMission system prompt should contain '## Sub-mission ordering' heading\n` +
    `Prompt excerpt (first 500 chars): ${systemPrompt.slice(0, 500)}`,
  );
});

// ── TC4: prompt contains Good/Bad ordering examples ──────────────────────

await test('TC4: prompt contains Good/Bad ordering examples', async () => {
  const capturedPrompts = [];
  const planner = new Planner(
    makeFakeSessionManager(capturedPrompts),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner._planMissionReusable('001-001', '/fake/root', { missionPlan: 'test plan' }, 7);

  assert.equal(capturedPrompts.length, 1, 'spawnReusable() should have been called exactly once');
  const systemPrompt = capturedPrompts[0];

  // The ordering section should include both a Good and a Bad example
  const hasGoodExample = systemPrompt.includes('Good') || systemPrompt.includes('good');
  const hasBadExample = systemPrompt.includes('Bad') || systemPrompt.includes('bad');

  assert.ok(
    hasGoodExample,
    `planMission system prompt should contain a 'Good' example for ordering\n` +
    `Prompt excerpt (first 800 chars): ${systemPrompt.slice(0, 800)}`,
  );

  assert.ok(
    hasBadExample,
    `planMission system prompt should contain a 'Bad' example for ordering\n` +
    `Prompt excerpt (first 800 chars): ${systemPrompt.slice(0, 800)}`,
  );
});

// ── TC5: 3 sequential tasks get chain deps ───────────────────────────────

await test('TC5: 3 sequential tasks get chain deps', async () => {
  const planner = new Planner(
    makeFakeSessionManager([]),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  const tasks = [
    { id: 'task-001', description: 'First task', targetFiles: [], dependencies: [] },
    { id: 'task-002', description: 'Second task', targetFiles: [], dependencies: [] },
    { id: 'task-003', description: 'Third task', targetFiles: [], dependencies: [] },
  ];

  const plan = {
    subMissions: [
      { id: 'sm-001', description: 'A sequential sub-mission', ordering: 'sequential', tasks },
    ],
  };

  planner._enforceSequentialOrdering(plan);

  // tasks[0] should have no new deps
  assert.deepStrictEqual(
    plan.subMissions[0].tasks[0].dependencies,
    [],
    'tasks[0] should have no dependencies',
  );

  // tasks[1] should depend on tasks[0]
  const deps1 = plan.subMissions[0].tasks[1].dependencies;
  assert.ok(
    deps1.some((d) => d.taskId === 'task-001' && d.type === 'hard'),
    `tasks[1].dependencies should contain {taskId:'task-001', type:'hard'}, got: ${JSON.stringify(deps1)}`,
  );

  // tasks[2] should depend on tasks[1]
  const deps2 = plan.subMissions[0].tasks[2].dependencies;
  assert.ok(
    deps2.some((d) => d.taskId === 'task-002' && d.type === 'hard'),
    `tasks[2].dependencies should contain {taskId:'task-002', type:'hard'}, got: ${JSON.stringify(deps2)}`,
  );
});

// ── TC6: no ordering → tasks unchanged ──────────────────────────────────

await test('TC6: no ordering → tasks unchanged', async () => {
  const planner = new Planner(
    makeFakeSessionManager([]),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  const tasks = [
    { id: 'task-001', description: 'First task', targetFiles: [], dependencies: [] },
    { id: 'task-002', description: 'Second task', targetFiles: [], dependencies: [] },
  ];

  const plan = {
    subMissions: [
      { id: 'sm-001', description: 'Sub-mission without ordering', tasks },
    ],
  };

  planner._enforceSequentialOrdering(plan);

  assert.deepStrictEqual(
    plan.subMissions[0].tasks[0].dependencies,
    [],
    'tasks[0] should have no dependencies when ordering is unset',
  );
  assert.deepStrictEqual(
    plan.subMissions[0].tasks[1].dependencies,
    [],
    'tasks[1] should have no dependencies when ordering is unset',
  );
});

// ── TC7: ordering:'parallel' → tasks unchanged ───────────────────────────

await test('TC7: ordering:\'parallel\' → tasks unchanged', async () => {
  const planner = new Planner(
    makeFakeSessionManager([]),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  const tasks = [
    { id: 'task-001', description: 'First task', targetFiles: [], dependencies: [] },
    { id: 'task-002', description: 'Second task', targetFiles: [], dependencies: [] },
  ];

  const plan = {
    subMissions: [
      { id: 'sm-001', description: 'A parallel sub-mission', ordering: 'parallel', tasks },
    ],
  };

  planner._enforceSequentialOrdering(plan);

  assert.deepStrictEqual(
    plan.subMissions[0].tasks[0].dependencies,
    [],
    'tasks[0] should have no dependencies for parallel ordering',
  );
  assert.deepStrictEqual(
    plan.subMissions[0].tasks[1].dependencies,
    [],
    'tasks[1] should have no dependencies for parallel ordering',
  );
});

// ── TC8: 1 task sequential → no deps added ───────────────────────────────

await test('TC8: 1 task sequential → no deps added', async () => {
  const planner = new Planner(
    makeFakeSessionManager([]),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  const tasks = [
    { id: 'task-001', description: 'Only task', targetFiles: [], dependencies: [] },
  ];

  const plan = {
    subMissions: [
      { id: 'sm-001', description: 'Single-task sequential sub-mission', ordering: 'sequential', tasks },
    ],
  };

  planner._enforceSequentialOrdering(plan);

  assert.deepStrictEqual(
    plan.subMissions[0].tasks[0].dependencies,
    [],
    'single task in sequential sub-mission should have no dependencies added',
  );
});

// ── TC9: double call → no duplicates ─────────────────────────────────────

await test('TC9: double call → no duplicates', async () => {
  const planner = new Planner(
    makeFakeSessionManager([]),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  const tasks = [
    { id: 'task-001', description: 'First task', targetFiles: [], dependencies: [] },
    { id: 'task-002', description: 'Second task', targetFiles: [], dependencies: [] },
    { id: 'task-003', description: 'Third task', targetFiles: [], dependencies: [] },
  ];

  const plan = {
    subMissions: [
      { id: 'sm-001', description: 'A sequential sub-mission', ordering: 'sequential', tasks },
    ],
  };

  // Call twice
  planner._enforceSequentialOrdering(plan);
  planner._enforceSequentialOrdering(plan);

  // tasks[1] should have exactly one dep on tasks[0]
  const deps1 = plan.subMissions[0].tasks[1].dependencies;
  const hardDepsOnTask001 = deps1.filter((d) => d.taskId === 'task-001' && d.type === 'hard');
  assert.strictEqual(
    hardDepsOnTask001.length,
    1,
    `tasks[1] should have exactly 1 hard dep on task-001 after double call, got: ${JSON.stringify(deps1)}`,
  );

  // tasks[2] should have exactly one dep on tasks[1]
  const deps2 = plan.subMissions[0].tasks[2].dependencies;
  const hardDepsOnTask002 = deps2.filter((d) => d.taskId === 'task-002' && d.type === 'hard');
  assert.strictEqual(
    hardDepsOnTask002.length,
    1,
    `tasks[2] should have exactly 1 hard dep on task-002 after double call, got: ${JSON.stringify(deps2)}`,
  );
});

// ── TC10: soft deps preserved alongside new hard dep ─────────────────────

await test('TC10: existing soft dep preserved alongside new hard dep', async () => {
  const planner = new Planner(
    makeFakeSessionManager([]),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  const tasks = [
    { id: 'task-001', description: 'First task', targetFiles: [], dependencies: [] },
    {
      id: 'task-002',
      description: 'Second task',
      targetFiles: [],
      dependencies: [{ taskId: 'external-task-999', type: 'soft' }],
    },
  ];

  const plan = {
    subMissions: [
      { id: 'sm-001', description: 'A sequential sub-mission', ordering: 'sequential', tasks },
    ],
  };

  planner._enforceSequentialOrdering(plan);

  const deps = plan.subMissions[0].tasks[1].dependencies;

  // Soft dep on external task must still be present
  assert.ok(
    deps.some((d) => d.taskId === 'external-task-999' && d.type === 'soft'),
    `tasks[1] should still have soft dep on external-task-999, got: ${JSON.stringify(deps)}`,
  );

  // New hard dep on task-001 must have been added
  assert.ok(
    deps.some((d) => d.taskId === 'task-001' && d.type === 'hard'),
    `tasks[1] should have new hard dep on task-001, got: ${JSON.stringify(deps)}`,
  );
});

// ── TC11: pre-existing identical hard dep not duplicated ─────────────────

await test('TC11: pre-existing hard dep not duplicated', async () => {
  const planner = new Planner(
    makeFakeSessionManager([]),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  const tasks = [
    { id: 'task-001', description: 'First task', targetFiles: [], dependencies: [] },
    {
      id: 'task-002',
      description: 'Second task',
      targetFiles: [],
      // Already has the hard dep that _enforceSequentialOrdering would add
      dependencies: [{ taskId: 'task-001', type: 'hard' }],
    },
  ];

  const plan = {
    subMissions: [
      { id: 'sm-001', description: 'A sequential sub-mission', ordering: 'sequential', tasks },
    ],
  };

  planner._enforceSequentialOrdering(plan);

  const deps = plan.subMissions[0].tasks[1].dependencies;
  const hardDepsOnTask001 = deps.filter((d) => d.taskId === 'task-001' && d.type === 'hard');

  assert.strictEqual(
    hardDepsOnTask001.length,
    1,
    `tasks[1] should have exactly 1 hard dep on task-001, got: ${JSON.stringify(deps)}`,
  );
});

// ── TC12: null/malformed plans never throw ───────────────────────────────

await test('TC12: null/undefined/{}/empty plans never throw', async () => {
  const planner = new Planner(
    makeFakeSessionManager([]),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  const malformedInputs = [
    null,
    undefined,
    {},
    { subMissions: null },
    { subMissions: [] },
  ];

  for (const input of malformedInputs) {
    assert.doesNotThrow(
      () => planner._enforceSequentialOrdering(input),
      `_enforceSequentialOrdering should not throw for input: ${JSON.stringify(input)}`,
    );
  }
});

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
