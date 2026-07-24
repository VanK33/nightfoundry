/**
 * test-planner-reextract-assumptions.js — Unit tests for Planner.reExtractAssumptions.
 *
 * Covers:
 *   TC1: reExtractAssumptions returns {text, specSection, phase}[] matching planGlobal assumption item schema
 *   TC2: reExtractAssumptions with empty spec returns empty array
 *
 * No live Claude sessions are spawned — a fake sessionManager intercepts spawn()
 * and returns fixture data.
 *
 * Run: node test/test-planner-reextract-assumptions.js
 */
import assert from 'assert';
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

// ── Shared test helpers ──────────────────────────────────────────────────────

function makeFakeLogger() {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-reextract.jsonl',
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

/**
 * Build a fake sessionManager whose spawn() returns the given structured_output.
 * Captures spawn options so tests can inspect session name, systemPrompt, etc.
 */
function makeFakeSessionManager(structuredOutput) {
  const spawnCalls = [];
  const sm = {
    spawnCalls,
    spawn(opts) {
      spawnCalls.push(opts);
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
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
  };
  return sm;
}

// planGlobal assumption item schema (inline mirror — must stay in sync with planner.js)
const planGlobalAssumptionItemSchema = {
  type: 'object',
  properties: {
    text:        { type: 'string' },
    specSection: { type: 'string' },
    phase:       { type: 'string', enum: ['invariant', 'post-fix'] },
  },
  required: ['text', 'specSection'],
};

/**
 * Minimal in-process validator for the assumption item schema.
 * Returns { ok: boolean, errors: string[] }.
 */
function validateItem(item) {
  const errors = [];
  if (typeof item !== 'object' || item === null) {
    errors.push('item must be an object');
    return { ok: false, errors };
  }
  if (typeof item.text !== 'string') errors.push('text must be a string');
  if (typeof item.specSection !== 'string') errors.push('specSection must be a string');
  if (item.phase !== undefined && !['invariant', 'post-fix'].includes(item.phase)) {
    errors.push(`phase must be 'invariant' or 'post-fix', got: '${item.phase}'`);
  }
  return { ok: errors.length === 0, errors };
}

// ── TC1: reExtractAssumptions returns {text, specSection, phase}[] ───────────

await test('TC1: reExtractAssumptions returns {text, specSection, phase}[] matching planGlobal assumption item schema', async () => {
  const mockAssumptions = [
    { text: 'src/orchestrator/agents/_schemas.js exports assumptionRemediationSchema', specSection: '## Schemas', phase: 'invariant' },
    { text: 'sessionManager.spawn returns a promise with a .handle property', specSection: '## Session API', phase: 'invariant' },
    { text: 'After execution, pipeline will emit a completion event', specSection: '## Lifecycle', phase: 'post-fix' },
  ];

  const sm = makeFakeSessionManager({ assumptions: mockAssumptions });
  const planner = new Planner(sm, makeFakeLogger(), makeFakeTokenTracker());

  const result = await planner.reExtractAssumptions('/fake/spec.md', '/fake/root');

  // Must return an array
  assert.ok(Array.isArray(result), `reExtractAssumptions must return an array, got: ${typeof result}`);

  // Must have the same number of items as the mock
  assert.equal(result.length, mockAssumptions.length,
    `Expected ${mockAssumptions.length} assumptions, got ${result.length}`);

  // Each item must match the planGlobal assumption item schema
  for (let i = 0; i < result.length; i++) {
    const v = validateItem(result[i]);
    assert.ok(v.ok,
      `Item at index ${i} failed schema validation: ${v.errors.join(', ')}\nItem: ${JSON.stringify(result[i])}`);
    assert.equal(result[i].text, mockAssumptions[i].text,
      `Item ${i} text mismatch. Expected: "${mockAssumptions[i].text}", got: "${result[i].text}"`);
    assert.equal(result[i].specSection, mockAssumptions[i].specSection,
      `Item ${i} specSection mismatch`);
    assert.equal(result[i].phase, mockAssumptions[i].phase,
      `Item ${i} phase mismatch`);
  }

  // Session name must be 'planner-reextract-assumptions'
  assert.equal(sm.spawnCalls.length, 1, 'spawn() must be called exactly once');
  assert.equal(sm.spawnCalls[0].name, 'planner-reextract-assumptions',
    `Session name must be 'planner-reextract-assumptions', got: '${sm.spawnCalls[0].name}'`);
});

// ── TC2: reExtractAssumptions with empty spec returns empty array ─────────────

await test('TC2: reExtractAssumptions with empty spec returns empty array', async () => {
  // Simulate a session that found no assumptions (e.g. empty or non-committal spec)
  const sm = makeFakeSessionManager({ assumptions: [] });
  const planner = new Planner(sm, makeFakeLogger(), makeFakeTokenTracker());

  const result = await planner.reExtractAssumptions('/fake/empty-spec.md', '/fake/root');

  assert.ok(Array.isArray(result), `reExtractAssumptions must return an array even for empty spec`);
  assert.equal(result.length, 0, `Expected empty array for empty spec, got ${result.length} items`);
});

// ── TC3: reExtractAssumptions with missing assumptions key returns empty array ─

await test('TC3: reExtractAssumptions with missing assumptions key in output returns empty array', async () => {
  // Simulate malformed session output (missing assumptions key)
  const sm = makeFakeSessionManager({});
  const planner = new Planner(sm, makeFakeLogger(), makeFakeTokenTracker());

  const result = await planner.reExtractAssumptions('/fake/spec.md', '/fake/root');

  assert.ok(Array.isArray(result), `reExtractAssumptions must return an array even when output is malformed`);
  assert.equal(result.length, 0, `Expected empty array for malformed output, got ${result.length} items`);
});

// ── TC4: assumptions without phase field are still valid (phase is optional) ──

await test('TC4: assumptions without phase field still pass schema validation (phase is optional)', async () => {
  const mockAssumptions = [
    { text: 'config.execution.plannerModel is defined', specSection: '## Config' },
    // no phase field — should still be valid
  ];

  const sm = makeFakeSessionManager({ assumptions: mockAssumptions });
  const planner = new Planner(sm, makeFakeLogger(), makeFakeTokenTracker());

  const result = await planner.reExtractAssumptions('/fake/spec.md', '/fake/root');

  assert.equal(result.length, 1, 'Expected 1 assumption');
  const v = validateItem(result[0]);
  assert.ok(v.ok,
    `Assumption without phase should still be schema-valid: ${v.errors.join(', ')}`);
  assert.equal(result[0].text, mockAssumptions[0].text, 'text should match');
  assert.equal(result[0].specSection, mockAssumptions[0].specSection, 'specSection should match');
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
