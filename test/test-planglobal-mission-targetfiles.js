/**
 * test-planglobal-mission-targetfiles.js — Unit tests for planGlobal's
 * mission-level `targetFiles` JSON schema requirement and the
 * planGlobal-time `[plan-scope-lint]` pure-omission catcher
 * (lintGlobalPlanScope), driven on the live planner.planGlobal() call path
 * with an injected fake sessionManager (no live SDK calls are made).
 *
 * Run: node test/test-planglobal-mission-targetfiles.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

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
 * Returns a fake session manager whose spawn(opts) captures opts.jsonSchema
 * into `capturedSchemas` and returns an awaitable Promise (with a `.handle`
 * property set synchronously, mirroring the real spawnPromise shape) that
 * resolves to `{ handle, result }` where `result.structured_output` is the
 * caller-supplied real-shape plan.
 */
function makeFakeSessionManager(capturedSchemas, structuredOutput) {
  const fakeHandle = {
    systemPromptTokens: 0,
    _toolCallCount: 0,
  };
  const fakeResult = {
    structured_output: structuredOutput,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    total_cost_usd: 0,
  };
  return {
    spawn(opts) {
      capturedSchemas.push(opts.jsonSchema);
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
  };
}

function makeFakeLogger() {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-planglobal-mission-targetfiles.jsonl',
      write: () => {},
      close: () => {},
    }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
  };
}

function makeFakeTokenTracker() {
  return { recordSession: async () => {} };
}

// ── TC1: captured jsonSchema requires mission targetFiles, minItems 1 ──

await test('(a) captured planGlobal jsonSchema mission items require targetFiles with minItems 1', async () => {
  const capturedSchemas = [];
  const planner = new Planner(
    makeFakeSessionManager(capturedSchemas, { milestones: [], assumptions: [], scopeMapping: [] }),
    makeFakeLogger(),
    makeFakeTokenTracker(),
  );

  await planner.planGlobal('test goal', '/fake/root');

  assert.equal(capturedSchemas.length, 1, 'spawn() should have been called exactly once');
  const schema = capturedSchemas[0];

  const missionItemsSchema = schema?.properties?.milestones?.items?.properties?.missions?.items;
  assert.ok(missionItemsSchema, 'schema should have properties.milestones.items.properties.missions.items');
  assert.ok(
    Array.isArray(missionItemsSchema.required) && missionItemsSchema.required.includes('targetFiles'),
    `mission items schema 'required' should include 'targetFiles', got: ${JSON.stringify(missionItemsSchema.required)}`,
  );
  assert.equal(
    missionItemsSchema.properties?.targetFiles?.minItems,
    1,
    `mission items schema properties.targetFiles.minItems should be 1, got: ${missionItemsSchema.properties?.targetFiles?.minItems}`,
  );
});

// ── TC2: uncovered acceptance-command file → throws [plan-scope-lint] ──

await test("(b) plan with an uncovered acceptance-command file makes planGlobal throw '[plan-scope-lint]'", async () => {
  const capturedSchemas = [];
  const plan = {
    milestones: [
      {
        id: '001',
        description: 'Milestone one',
        missions: [
          { id: '001-001', description: 'Mission one', targetFiles: ['src/other.js'] },
        ],
      },
    ],
    assumptions: [],
    scopeMapping: [],
  };
  const planner = new Planner(
    makeFakeSessionManager(capturedSchemas, plan),
    makeFakeLogger(),
    makeFakeTokenTracker(),
  );

  await assert.rejects(
    () => planner.planGlobal('test goal', '/fake/root', {
      specAcceptanceCriteria: [
        {
          description: 'test-foo passes',
          verification: { kind: 'command', command: 'node test/test-foo.js' },
        },
      ],
    }),
    (err) => {
      assert.ok(err instanceof Error, 'rejection should be an Error');
      assert.ok(
        err.message.includes('[plan-scope-lint]'),
        `error message should include '[plan-scope-lint]', got: ${err.message}`,
      );
      return true;
    },
  );
});

// ── TC3: covered acceptance-command file → resolves and returns plan ──

await test('(c) plan covering the acceptance-command file resolves and returns the plan', async () => {
  const capturedSchemas = [];
  const plan = {
    milestones: [
      {
        id: '001',
        description: 'Milestone one',
        missions: [
          { id: '001-001', description: 'Mission one', targetFiles: ['test/test-foo.js'] },
        ],
      },
    ],
    assumptions: [],
    scopeMapping: [],
  };
  const planner = new Planner(
    makeFakeSessionManager(capturedSchemas, plan),
    makeFakeLogger(),
    makeFakeTokenTracker(),
  );

  const result = await planner.planGlobal('test goal', '/fake/root', {
    specAcceptanceCriteria: [
      {
        description: 'test-foo passes',
        verification: { kind: 'command', command: 'node test/test-foo.js' },
      },
    ],
  });

  assert.strictEqual(result, plan, 'planGlobal should resolve to the plan object');
});

// ── TC4: no/empty specAcceptanceCriteria → does not throw ──

await test('(d) planGlobal with no/empty specAcceptanceCriteria does not throw', async () => {
  const plan = {
    milestones: [
      {
        id: '001',
        description: 'Milestone one',
        missions: [
          { id: '001-001', description: 'Mission one', targetFiles: ['src/other.js'] },
        ],
      },
    ],
    assumptions: [],
    scopeMapping: [],
  };

  // No opts at all.
  const planner1 = new Planner(
    makeFakeSessionManager([], plan),
    makeFakeLogger(),
    makeFakeTokenTracker(),
  );
  await assert.doesNotReject(() => planner1.planGlobal('test goal', '/fake/root'));

  // Explicit empty specAcceptanceCriteria array.
  const planner2 = new Planner(
    makeFakeSessionManager([], plan),
    makeFakeLogger(),
    makeFakeTokenTracker(),
  );
  await assert.doesNotReject(() => planner2.planGlobal('test goal', '/fake/root', {
    specAcceptanceCriteria: [],
  }));
});

// ── TC5: missions lack targetFiles entirely → lint no-ops (backward compat) ──

await test('(e) plan whose missions lack targetFiles entirely resolves (lint no-ops)', async () => {
  const plan = {
    milestones: [
      {
        id: '001',
        description: 'Milestone one',
        missions: [
          { id: '001-001', description: 'Mission one' },
        ],
      },
    ],
    assumptions: [],
    scopeMapping: [],
  };
  const planner = new Planner(
    makeFakeSessionManager([], plan),
    makeFakeLogger(),
    makeFakeTokenTracker(),
  );

  await assert.doesNotReject(() => planner.planGlobal('test goal', '/fake/root', {
    specAcceptanceCriteria: [
      {
        description: 'test-foo passes',
        verification: { kind: 'command', command: 'node test/test-foo.js' },
      },
    ],
  }));
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
