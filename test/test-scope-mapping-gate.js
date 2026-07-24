/**
 * test-scope-mapping-gate.js — Primary evidence for the scope-mapping coverage
 * gate spec (scope-mapping-gate.spec.md).
 *
 * The gate's source of truth moves from a fragile re-derived LEXICAL guess to a
 * planner-authored `scopeItemId -> missionIds` mapping carried as a field on the
 * plan object. This file pins acceptance criteria AC1–AC8.
 *
 * Two test layers, used where each adds signal:
 *   • Pure unit  — checkScopeCoverageByMapping(scopeItems, scopeMapping,
 *                  validMissionIds) → { covered, uncovered } (CONTRACT-1).
 *   • Gate integ — the REAL Pipeline.prototype._scopeCoverageGate driven on a
 *                  duck-typed fakeThis OR via the REAL persist→resume boundary.
 *
 * AC1 — failed-120-shaped symmetric scope set + covering mapping → gate PASSES.
 * AC2 — mapping missing an entry, and (separate) empty missionIds → throws.
 * AC3 — dangling mission id (not in plan) → uncovered → throws; STRICT all-valid.
 * AC4 — RUN→PERSIST→RESUME round-trip witness (crosses real persist→reconstruct).
 * AC5 — goal-only: writeGlobalPlan persists scopeItems:[] (key PRESENT) + skip.
 * AC6 — legacy: NO scopeItems field → fail-closed; with _allowIncompleteScope → warn.
 * AC7 — fresh plan with scopeItems present but mapping omitting an id → genuine throw.
 * AC8 — planGlobal inline schema has a top-level scopeMapping array.
 *
 * Run: node test/test-scope-mapping-gate.js
 *
 * No live Claude sessions are spawned — the planner is stubbed (AC8) and the
 * resume side effects are stubbed (AC4); the gate itself is always REAL.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { IncompleteScopeError } from '../src/orchestrator/core/incomplete-scope-error.js';
import { checkScopeCoverageByMapping } from '../src/orchestrator/gates/scope-coverage.js';
import { writeGlobalPlan, readState } from '../src/orchestrator/core/state.js';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';
import { Planner } from '../src/orchestrator/agents/planner.js';

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpRoot(prefix = 'cc-scope-mapping-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Duck-typed fakeThis for the REAL Pipeline.prototype._scopeCoverageGate, plus
 * a logs array. Mirrors test-scope-coverage-gate.js so the unit-level gate
 * cases run the production gate without the full Pipeline constructor.
 */
function makeFakeGate({ allowIncompleteScope = false } = {}) {
  const tmpDir = makeTmpRoot('cc-scope-mapping-gate-');
  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  const logs = [];
  const fakeThis = {
    harnessDir,
    projectRoot: tmpDir,
    _allowIncompleteScope: allowIncompleteScope,
    onLog: (msg) => logs.push(String(msg)),
  };
  return { fakeThis, logs, tmpDir };
}

const scopeCoverageGate = Pipeline.prototype._scopeCoverageGate;

// The failed-120-shaped SYMMETRIC scope set: shared vocabulary across parallel
// "Round-1 …" / "Round-2 …" items is exactly what lexical matching false-positived.
const FAILED120_SCOPE_ITEMS = [
  { id: 's1', label: 'Round-1 auto-waive branch', source: 'numbered-subsection' },
  { id: 's2', label: 'Round-2 auto-waive branch', source: 'numbered-subsection' },
  { id: 's3', label: 'Auto-waive scene file', source: 'numbered-subsection' },
];

/** A plan carrying three missions whose ids the gate derives validMissionIds from. */
function planWithMissions(missionIds = ['001-001', '001-002', '001-003']) {
  return {
    milestones: [
      {
        id: '001',
        description: 'Milestone 1',
        missions: missionIds.map((id) => ({ id, description: `mission ${id}` })),
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — failed-120-shaped SYMMETRIC scope set + covering mapping → gate PASSES.
//   The headline: lexical matching used to false-positive on these symmetric
//   labels; the explicit mapping makes the gate verify coverage structurally.
//   Both layers: pure function + gate integration.
// ─────────────────────────────────────────────────────────────────────────────
await test('AC1[pure]: covering mapping over a failed-120 symmetric scope set → all covered, none uncovered', () => {
  const mapping = [
    { scopeItemId: 's1', missionIds: ['001-001'] },
    { scopeItemId: 's2', missionIds: ['001-002'] },
    { scopeItemId: 's3', missionIds: ['001-003'] },
  ];
  const { covered, uncovered } = checkScopeCoverageByMapping(
    FAILED120_SCOPE_ITEMS, mapping, ['001-001', '001-002', '001-003'],
  );
  assert.strictEqual(uncovered.length, 0, `expected 0 uncovered, got: ${JSON.stringify(uncovered)}`);
  assert.strictEqual(covered.length, 3, `expected 3 covered, got: ${JSON.stringify(covered)}`);
  // covered carries { id, label } (CONTRACT-1).
  for (const c of covered) {
    assert.ok(typeof c.id === 'string' && typeof c.label === 'string',
      `each covered entry must carry { id, label }, got: ${JSON.stringify(c)}`);
  }
  // validMissionIds may be a Set OR Array (function normalizes) — Set must also work.
  const viaSet = checkScopeCoverageByMapping(
    FAILED120_SCOPE_ITEMS, mapping, new Set(['001-001', '001-002', '001-003']),
  );
  assert.strictEqual(viaSet.uncovered.length, 0, 'Set-typed validMissionIds must normalize identically');
});

await test('AC1[gate]: gate PASSES (no throw) on a failed-120 symmetric plan with a covering mapping', async () => {
  const { fakeThis, logs, tmpDir } = makeFakeGate({ allowIncompleteScope: false });
  try {
    const plan = {
      ...planWithMissions(['001-001', '001-002', '001-003']),
      scopeItems: FAILED120_SCOPE_ITEMS,
      scopeMapping: [
        { scopeItemId: 's1', missionIds: ['001-001'] },
        { scopeItemId: 's2', missionIds: ['001-002'] },
        { scopeItemId: 's3', missionIds: ['001-003'] },
      ],
    };
    let threw = null;
    try {
      await scopeCoverageGate.call(fakeThis, plan, { prdPath: path.join(tmpDir, 'spec.md') });
    } catch (err) {
      threw = err;
    }
    assert.strictEqual(threw, null,
      `gate must not throw on a covered failed-120 plan; got: ${threw ? threw.name + ': ' + threw.message : '(none)'}`);
    assert.ok(logs.some((l) => l.includes('all') && l.includes('covered')),
      `expected an "all … covered" success log, got:\n${logs.join('\n') || '(none)'}`);
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — mapping missing an entry, and (separate) empty missionIds → throws.
// ─────────────────────────────────────────────────────────────────────────────
await test('AC2[pure]: a missing mapping entry leaves that item uncovered (by LABEL)', () => {
  const { uncovered } = checkScopeCoverageByMapping(
    FAILED120_SCOPE_ITEMS,
    [
      { scopeItemId: 's1', missionIds: ['001-001'] },
      // s2 entry omitted
      { scopeItemId: 's3', missionIds: ['001-003'] },
    ],
    ['001-001', '001-002', '001-003'],
  );
  assert.deepStrictEqual(uncovered, ['Round-2 auto-waive branch'],
    `uncovered must be the LABEL of the unmapped item, got: ${JSON.stringify(uncovered)}`);
});

await test('AC2[pure]: an entry with EMPTY missionIds leaves that item uncovered', () => {
  const { uncovered } = checkScopeCoverageByMapping(
    FAILED120_SCOPE_ITEMS,
    [
      { scopeItemId: 's1', missionIds: ['001-001'] },
      { scopeItemId: 's2', missionIds: [] }, // present but empty → uncovered
      { scopeItemId: 's3', missionIds: ['001-003'] },
    ],
    ['001-001', '001-002', '001-003'],
  );
  assert.deepStrictEqual(uncovered, ['Round-2 auto-waive branch'],
    `empty-missionIds entry must be uncovered, got: ${JSON.stringify(uncovered)}`);
});

await test('AC2[gate]: a missing entry (allow=false) → IncompleteScopeError with non-empty uncoveredLabels', async () => {
  const { fakeThis, tmpDir } = makeFakeGate({ allowIncompleteScope: false });
  try {
    const plan = {
      ...planWithMissions(),
      scopeItems: FAILED120_SCOPE_ITEMS,
      scopeMapping: [
        { scopeItemId: 's1', missionIds: ['001-001'] },
        { scopeItemId: 's3', missionIds: ['001-003'] },
      ], // s2 omitted
    };
    let thrown = null;
    try {
      await scopeCoverageGate.call(fakeThis, plan, { prdPath: path.join(tmpDir, 'spec.md') });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof IncompleteScopeError,
      `expected IncompleteScopeError, got: ${thrown ? thrown.constructor.name + ': ' + thrown.message : '(none)'}`);
    assert.ok(Array.isArray(thrown.uncoveredLabels) && thrown.uncoveredLabels.length > 0,
      `uncoveredLabels must be non-empty, got: ${JSON.stringify(thrown.uncoveredLabels)}`);
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — dangling mission id (not in plan) → uncovered → throws; STRICT all-valid.
// ─────────────────────────────────────────────────────────────────────────────
await test('AC3[pure]: a mapping entry referencing a mission id NOT in the plan → uncovered', () => {
  const { uncovered } = checkScopeCoverageByMapping(
    FAILED120_SCOPE_ITEMS,
    [
      { scopeItemId: 's1', missionIds: ['001-001'] },
      { scopeItemId: 's2', missionIds: ['001-002'] },
      { scopeItemId: 's3', missionIds: ['001-999'] }, // dangling — not in plan
    ],
    ['001-001', '001-002', '001-003'],
  );
  assert.deepStrictEqual(uncovered, ['Auto-waive scene file'],
    `dangling-only entry must be uncovered, got: ${JSON.stringify(uncovered)}`);
});

await test('AC3[pure]: STRICT all-valid — missionIds = [valid, dangling] is STILL uncovered', () => {
  const { uncovered } = checkScopeCoverageByMapping(
    FAILED120_SCOPE_ITEMS,
    [
      { scopeItemId: 's1', missionIds: ['001-001'] },
      { scopeItemId: 's2', missionIds: ['001-002'] },
      { scopeItemId: 's3', missionIds: ['001-003', '001-999'] }, // one valid + one dangling
    ],
    ['001-001', '001-002', '001-003'],
  );
  assert.deepStrictEqual(uncovered, ['Auto-waive scene file'],
    `one dangling id among valid ones must STILL make the item uncovered (strict all-valid), got: ${JSON.stringify(uncovered)}`);
});

await test('AC3[gate]: a dangling-ref mapping (allow=false) → IncompleteScopeError', async () => {
  const { fakeThis, tmpDir } = makeFakeGate({ allowIncompleteScope: false });
  try {
    const plan = {
      ...planWithMissions(),
      scopeItems: FAILED120_SCOPE_ITEMS,
      scopeMapping: [
        { scopeItemId: 's1', missionIds: ['001-001'] },
        { scopeItemId: 's2', missionIds: ['001-002'] },
        { scopeItemId: 's3', missionIds: ['001-003', '001-999'] }, // dangling
      ],
    };
    let thrown = null;
    try {
      await scopeCoverageGate.call(fakeThis, plan, { prdPath: path.join(tmpDir, 'spec.md') });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof IncompleteScopeError,
      `expected IncompleteScopeError on a dangling ref, got: ${thrown ? thrown.constructor.name : '(none)'}`);
    assert.ok(thrown.uncoveredLabels.includes('Auto-waive scene file'),
      `uncoveredLabels must name the dangling item's label, got: ${JSON.stringify(thrown.uncoveredLabels)}`);
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — RUN→PERSIST→RESUME round-trip witness (crosses the REAL persist→
//   reconstruct boundary). Bootstrap a temp harness, build a globalPlan with a
//   COMPLETE-coverage scopeItems+scopeMapping, persist via the REAL
//   writeGlobalPlan, assert readState round-trips them, then drive the REAL
//   Pipeline.resume() (side effects stubbed; the gate REAL) and assert NO
//   IncompleteScopeError (not spuriously fail-closed).
// ─────────────────────────────────────────────────────────────────────────────
function stubResumeSideEffects(pipeline) {
  const noop = () => {};
  const asyncNoop = async () => {};
  pipeline._runPreflight = noop;
  pipeline._startAgentTicker = noop;
  pipeline._stopAgentTicker = noop;
  pipeline._executeMilestone = asyncNoop;
  pipeline._reviewGate = asyncNoop;
  pipeline._emitRunCostSummary = noop;
  pipeline._archive = asyncNoop;
  if (pipeline.planner) pipeline.planner.closeReusableSession = asyncNoop;
  if (pipeline.statusBar) pipeline.statusBar.destroy = noop;
}

await test('AC4: run→persist→resume round-trip — writeGlobalPlan persists scopeItems/scopeMapping; resume() rehydrates and the gate PASSES (not fail-closed)', async () => {
  const root = makeTmpRoot('cc-scope-mapping-rt-');
  try {
    const specPath = path.join(root, 'spec.md');
    fs.writeFileSync(specPath, '# Round-trip feature\n\n## Scope — in\n\n### 1. Auth\n### 2. Cache\n### 3. Logging\n');
    // Sibling spec.json so _detectUncheckableSpec (fires right after the scope
    // gate) passes — mirrors test-resume.js TC7.
    fs.writeFileSync(
      path.join(root, 'spec.json'),
      JSON.stringify({
        goal: 'Cover Auth, Cache and Logging',
        target_files: ['src/auth.js'],
        acceptance_criteria: [{ description: 'it works', verification: { kind: 'manual' } }],
      }),
    );

    // Bootstrap establishes state.json (phase 'planning') with prdPath.
    const { harnessDir } = bootstrap(root, { prdPath: specPath });

    // Build an in-memory globalPlan with complete coverage and persist it.
    const globalPlan = {
      milestones: [
        {
          id: '001',
          description: 'Milestone 1',
          missions: [
            { id: '001-001', description: 'Implement Auth' },
            { id: '001-002', description: 'Build Cache' },
            { id: '001-003', description: 'Add Logging' },
          ],
        },
      ],
      scopeItems: [
        { id: 's1', label: 'Auth', source: 'numbered-subsection' },
        { id: 's2', label: 'Cache', source: 'numbered-subsection' },
        { id: 's3', label: 'Logging', source: 'numbered-subsection' },
      ],
      scopeMapping: [
        { scopeItemId: 's1', missionIds: ['001-001'] },
        { scopeItemId: 's2', missionIds: ['001-002'] },
        { scopeItemId: 's3', missionIds: ['001-003'] },
      ],
    };
    writeGlobalPlan(harnessDir, globalPlan);

    // The persist boundary: scopeItems/scopeMapping must round-trip under projectMeta.
    const persisted = readState(harnessDir);
    assert.deepStrictEqual(
      persisted.projectMeta.scopeItems,
      globalPlan.scopeItems,
      `persisted scopeItems must round-trip under state.projectMeta, got: ${JSON.stringify(persisted.projectMeta.scopeItems)}`,
    );
    assert.deepStrictEqual(
      persisted.projectMeta.scopeMapping,
      globalPlan.scopeMapping,
      `persisted scopeMapping must round-trip under state.projectMeta, got: ${JSON.stringify(persisted.projectMeta.scopeMapping)}`,
    );

    // Now drive the REAL resume() — gate REAL, side effects stubbed.
    const pipeline = new Pipeline(root, { onLog: () => {}, statusBar: false });
    stubResumeSideEffects(pipeline);

    let thrown = null;
    try {
      await pipeline.resume();
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      !(thrown instanceof IncompleteScopeError),
      `resume() must rehydrate scopeItems/scopeMapping and PASS on complete coverage (not spuriously fail-closed); ` +
      `got: ${thrown ? thrown.name + ': ' + thrown.message : '(none)'}`,
    );
    if (thrown) {
      throw new Error(`resume() must not throw on the covered round-trip, got: ${thrown.name}: ${thrown.message}`);
    }
  } finally {
    cleanup(root);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — goal-only: writeGlobalPlan persists scopeItems:[] (KEY PRESENT, value
//   []), and the gate SKIPS (present-and-empty) — distinct from ABSENT (legacy).
// ─────────────────────────────────────────────────────────────────────────────
await test('AC5[persist]: a goal-only globalPlan persists scopeItems with the KEY PRESENT and value [] under projectMeta', () => {
  const root = makeTmpRoot('cc-scope-mapping-goalonly-');
  try {
    const specPath = path.join(root, 'spec.md');
    fs.writeFileSync(specPath, '# Goal-only\n');
    const { harnessDir } = bootstrap(root, { prdPath: specPath });

    writeGlobalPlan(harnessDir, {
      milestones: [{ id: '001', description: 'm', missions: [{ id: '001-001', description: 'mm' }] }],
      scopeItems: [],
      scopeMapping: [],
    });

    const persisted = readState(harnessDir);
    assert.ok(
      Object.prototype.hasOwnProperty.call(persisted.projectMeta, 'scopeItems'),
      `the scopeItems KEY must be present even when [] (goal-only), got projectMeta keys: ${Object.keys(persisted.projectMeta).join(', ')}`,
    );
    assert.deepStrictEqual(persisted.projectMeta.scopeItems, [],
      `goal-only scopeItems must persist as [], got: ${JSON.stringify(persisted.projectMeta.scopeItems)}`);
  } finally {
    cleanup(root);
  }
});

await test('AC5[gate]: a present-and-empty plan.scopeItems → gate SKIPS (no throw)', async () => {
  const { fakeThis, logs, tmpDir } = makeFakeGate({ allowIncompleteScope: false });
  try {
    const plan = {
      ...planWithMissions(['001-001']),
      scopeItems: [],   // present and EMPTY → goal-only skip
      scopeMapping: [],
    };
    let thrown = null;
    try {
      await scopeCoverageGate.call(fakeThis, plan, { prdPath: path.join(tmpDir, 'spec.md') });
    } catch (err) {
      thrown = err;
    }
    assert.strictEqual(thrown, null,
      `present-and-empty scopeItems must SKIP (not fail-closed), got: ${thrown ? thrown.name + ': ' + thrown.message : '(none)'}`);
    assert.ok(logs.some((l) => l.includes('no scope items') || l.includes('skipping')),
      `expected a skip log on goal-only, got:\n${logs.join('\n') || '(none)'}`);
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — legacy: a reconstructed plan with NO scopeItems field → fail-closed;
//   the SAME plan with _allowIncompleteScope=true → warn, no throw. The legacy
//   plan is built by OMITTING the scopeItems key (never via git).
// ─────────────────────────────────────────────────────────────────────────────
function legacyPlanNoScopeItems() {
  // KEY ABSENT — distinguishes legacy fail-closed from goal-only [] (CONTRACT-4).
  return {
    milestones: [
      {
        id: '001',
        description: 'Legacy milestone',
        missions: [{ id: '001-001', description: 'a mission' }],
      },
    ],
    // NOTE: no `scopeItems` key at all (legacy persisted run).
  };
}

await test('AC6: legacy plan (NO scopeItems field) → fail-closed IncompleteScopeError', async () => {
  const { fakeThis, tmpDir } = makeFakeGate({ allowIncompleteScope: false });
  try {
    const plan = legacyPlanNoScopeItems();
    assert.ok(!Object.prototype.hasOwnProperty.call(plan, 'scopeItems'),
      'precondition: the legacy plan must have NO scopeItems key');
    let thrown = null;
    try {
      await scopeCoverageGate.call(fakeThis, plan, { prdPath: path.join(tmpDir, 'spec.md') });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof IncompleteScopeError,
      `a legacy plan with an ABSENT scopeItems key must fail closed; got: ${thrown ? thrown.constructor.name : '(none)'}`);
  } finally {
    cleanup(tmpDir);
  }
});

await test('AC6: SAME legacy plan under _allowIncompleteScope=true → warn, no throw', async () => {
  const { fakeThis, logs, tmpDir } = makeFakeGate({ allowIncompleteScope: true });
  try {
    let thrown = null;
    try {
      await scopeCoverageGate.call(fakeThis, legacyPlanNoScopeItems(), { prdPath: path.join(tmpDir, 'spec.md') });
    } catch (err) {
      thrown = err;
    }
    assert.strictEqual(thrown, null,
      `legacy + _allowIncompleteScope must warn (not throw), got: ${thrown ? thrown.name + ': ' + thrown.message : '(none)'}`);
    assert.ok(logs.length > 0, 'expected at least one log line (the legacy warning) under _allowIncompleteScope');
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — fresh plan with scopeItems PRESENT but scopeMapping omitting an id
//   (lazy planner) → genuine IncompleteScopeError, NOT legacy-escapable. The
//   field is present, so it is judged against the authoritative set.
// ─────────────────────────────────────────────────────────────────────────────
await test('AC7: fresh plan with scopeItems present but scopeMapping omitting an id → genuine IncompleteScopeError', async () => {
  const { fakeThis, tmpDir } = makeFakeGate({ allowIncompleteScope: false });
  try {
    const plan = {
      ...planWithMissions(['001-001', '001-002', '001-003']),
      scopeItems: FAILED120_SCOPE_ITEMS, // PRESENT — not legacy
      scopeMapping: [
        { scopeItemId: 's1', missionIds: ['001-001'] },
        { scopeItemId: 's2', missionIds: ['001-002'] },
        // s3 omitted — lazy planner
      ],
    };
    let thrown = null;
    try {
      await scopeCoverageGate.call(fakeThis, plan, { prdPath: path.join(tmpDir, 'spec.md') });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof IncompleteScopeError,
      `a present-but-incomplete mapping must throw a GENUINE IncompleteScopeError (judged vs the authoritative set), ` +
      `got: ${thrown ? thrown.constructor.name : '(none)'}`);
    assert.ok(thrown.uncoveredLabels.includes('Auto-waive scene file'),
      `the omitted id's label must be reported uncovered, got: ${JSON.stringify(thrown.uncoveredLabels)}`);
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — planGlobal inline schema has a top-level scopeMapping array requiring
//   scopeItemId (string) + missionIds (string array, minItems 1); scopeMapping
//   is NOT in the top-level required. Captured by stubbing sessionManager.spawn
//   (planGlobal's path) and reading opts.jsonSchema — mirrors the established
//   planner-test harness (test-planner-prompt.js / test-planner-sequential-ordering.js).
// ─────────────────────────────────────────────────────────────────────────────
function makeSchemaCapturingSessionManager(capturedSchemas) {
  const fakeHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
  const fakeResult = {
    structured_output: {
      milestones: [
        { id: '001', description: 'm', missions: [{ id: '001-001', description: 'mm' }] },
      ],
      assumptions: [],
      scopeMapping: [],
    },
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    total_cost_usd: 0,
  };
  return {
    // planGlobal goes through spawn() (not spawnReusable). Capture jsonSchema.
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
    createSessionLog: () => ({ logPath: '/tmp/fake-scope-mapping.jsonl', write: () => {}, close: () => {} }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
    warn: () => {},
    info: () => {},
  };
}

await test('AC8: planGlobal inline schema carries a top-level scopeMapping array (scopeItemId:string + missionIds:string[] minItems 1; NOT required)', async () => {
  const capturedSchemas = [];
  const planner = new Planner(
    makeSchemaCapturingSessionManager(capturedSchemas),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner.planGlobal('test goal', '/fake/root');

  assert.strictEqual(capturedSchemas.length, 1, 'spawn() should have been called exactly once by planGlobal');
  const schema = capturedSchemas[0];
  assert.ok(schema && schema.properties, 'planGlobal jsonSchema should have properties');

  const sm = schema.properties.scopeMapping;
  assert.ok(sm, `schema.properties must include 'scopeMapping', got keys: ${Object.keys(schema.properties).join(', ')}`);
  assert.strictEqual(sm.type, 'array', `scopeMapping must be an array, got: ${JSON.stringify(sm.type)}`);
  assert.ok(sm.items && sm.items.properties, 'scopeMapping.items must have properties');

  const props = sm.items.properties;
  assert.strictEqual(props.scopeItemId && props.scopeItemId.type, 'string',
    `scopeMapping.items.properties.scopeItemId.type must be 'string', got: ${JSON.stringify(props.scopeItemId)}`);
  assert.strictEqual(props.missionIds && props.missionIds.type, 'array',
    `scopeMapping.items.properties.missionIds.type must be 'array', got: ${JSON.stringify(props.missionIds)}`);
  assert.strictEqual(props.missionIds.items && props.missionIds.items.type, 'string',
    `missionIds.items.type must be 'string', got: ${JSON.stringify(props.missionIds.items)}`);
  assert.strictEqual(props.missionIds.minItems, 1,
    `missionIds.minItems must be 1, got: ${JSON.stringify(props.missionIds.minItems)}`);

  // 'scopeMapping' must NOT be a top-level required key (optional at schema layer;
  // enforcement is the gate against the authoritative set).
  const topRequired = schema.required || [];
  assert.ok(!topRequired.includes('scopeMapping'),
    `'scopeMapping' must NOT be in the top-level required, got required: ${JSON.stringify(topRequired)}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
