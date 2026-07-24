/**
 * test-remediation-no-line-refs.js — Unit tests for remediateAssumption prompt guardrails.
 *
 * Tests that the remediateAssumption prompt contains prohibition instructions
 * against line-number and column references. No live SDK calls are made —
 * a fake sessionManager intercepts spawn() and captures the `prompt` argument.
 *
 * Run: node test/test-remediation-no-line-refs.js
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
 * Returns a fake session manager whose spawn() captures the `prompt` argument
 * (opts.prompt, not opts.systemPrompt) into `capturedPrompts` and resolves
 * immediately with a minimal fake result for remediateAssumption.
 */
function makeFakeSessionManager(capturedPrompts, structuredOutput) {
  const defaultOutput = {
    revisedAssumptions: [
      { text: 'The module exports a config helper', phase: 'invariant' },
    ],
    specEdit: {
      section: 'Assumptions',
      old: 'The function at line 42 exports config',
      new: 'The function that exports config',
    },
  };
  return {
    spawn(opts) {
      capturedPrompts.push(opts.prompt);
      const fakeHandle = {
        systemPromptTokens: 0,
        _toolCallCount: 0,
      };
      const fakeResult = {
        structured_output: structuredOutput || defaultOutput,
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
}

function makeFakeLogger() {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-remediation-no-line-refs.jsonl',
      write: () => {},
      close: () => {},
    }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
  };
}

// ── TC1: remediateAssumption prompt contains line-number prohibition ──────────

await test('remediateAssumption prompt contains line-number prohibition', async () => {
  const capturedPrompts = [];
  const planner = new Planner(
    makeFakeSessionManager(capturedPrompts),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner.remediateAssumption('test assumption', 'test evidence', 'test excerpt');

  assert.equal(capturedPrompts.length, 1, 'spawn() should have been called exactly once');
  const capturedPrompt = capturedPrompts[0];

  assert.ok(
    typeof capturedPrompt === 'string',
    `opts.prompt should be a string, got: ${typeof capturedPrompt}`,
  );

  // Accept either capitalisation ('Describe' at sentence start or 'describe' inline).
  const SEMANTICS_PHRASE_RE = /describe semantics, not positions/i;
  assert.ok(
    SEMANTICS_PHRASE_RE.test(capturedPrompt),
    `remediateAssumption prompt should contain 'describe semantics, not positions' (case-insensitive)\n` +
    `Prompt excerpt: ${capturedPrompt.slice(0, 500)}`,
  );
});

// ── TC2: remediateAssumption prompt contains /line.?numbers?/i and /column/i ─

await test('remediation output contains no line/column references (prompt-level guardrail test)', async () => {
  // Fixture: a realistic structured_output that contains line/column refs
  // (the kind of thing the model might produce without guardrails).
  const fixtureOutput = {
    revisedAssumptions: [
      { text: 'The config export at line 42 is correct', phase: 'invariant' },
    ],
    specEdit: {
      section: 'Assumptions',
      old: 'function at line 10 exports config',
      new: 'function covering lines 5-20 exports config',
    },
  };

  // Confirm the fixture actually contains line references (validates the fixture).
  assert.ok(
    /\blines? \d+/i.test(fixtureOutput.revisedAssumptions[0].text) ||
    /\blines? \d+/i.test(fixtureOutput.specEdit.new) ||
    /\bcolumn \d+/i.test(fixtureOutput.revisedAssumptions[0].text),
    'Fixture structured_output should contain line/column references to be a realistic test case',
  );

  const capturedPrompts = [];
  const planner = new Planner(
    makeFakeSessionManager(capturedPrompts, fixtureOutput),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner.remediateAssumption('test assumption', 'test evidence', 'test excerpt');

  assert.equal(capturedPrompts.length, 1, 'spawn() should have been called exactly once');
  const capturedPrompt = capturedPrompts[0];

  // The prompt should contain prohibition keywords for line numbers.
  assert.ok(
    /line.?numbers?/i.test(capturedPrompt),
    `remediateAssumption prompt should contain a prohibition matching /line.?numbers?/i\n` +
    `Prompt excerpt: ${capturedPrompt.slice(0, 500)}`,
  );

  // The prompt should contain a prohibition for column references.
  assert.ok(
    /column/i.test(capturedPrompt),
    `remediateAssumption prompt should contain a prohibition matching /column/i\n` +
    `Prompt excerpt: ${capturedPrompt.slice(0, 500)}`,
  );
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
