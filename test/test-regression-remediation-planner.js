/**
 * test-regression-remediation-planner.js — Unit tests for Planner.remediateRegressionFailure.
 *
 * No live Claude sessions are spawned — sessionManager.spawn is replaced
 * by a mock fixture following the test-review-remediation-planner.js pattern.
 *
 * Run: node test/test-regression-remediation-planner.js
 */
import assert from 'assert';
import { regressionRemediationSchema } from '../src/orchestrator/agents/_schemas.js';
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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ── Mock fixtures ──────────────────────────────────────────────────────────

// Fixture return value that sessionManager.spawn resolves with
const fixtureNewTasks = [
  {
    id: '001-002-003-001',
    subMissionId: '001-002-003',
    description: 'Fix regression in executor.js caused by missing guard',
    targetFiles: ['src/orchestrator/agents/executor.js'],
  },
  {
    id: '001-002-003-002',
    subMissionId: '001-002-003',
    description: 'Restore baseline behaviour in pipeline.js regression path',
    targetFiles: ['src/orchestrator/core/pipeline.js'],
  },
];

const fixtureResult = {
  structured_output: {
    newTasks: fixtureNewTasks,
  },
};

// Sample findings passed to remediateRegressionFailure
const sampleFindings = [
  {
    severity: 'critical',
    category: 'regression',
    file: 'src/orchestrator/agents/executor.js',
    description: 'Executor no longer returns structured_output on task completion',
  },
  {
    severity: 'critical',
    category: 'regression',
    file: 'src/orchestrator/core/pipeline.js',
    description: 'Pipeline milestone regression detected: verifyMilestone returned false after changes',
  },
];

// ── Mock builders ──────────────────────────────────────────────────────────

/**
 * Build a mock logger that satisfies Planner's internal usage:
 *   logger.createSessionLog(name) → { close() }
 *   logger.attachToSession(handle, log, meta) → void
 */
function makeMockLogger() {
  return {
    createSessionLog: (_name) => ({ close: () => {} }),
    attachToSession: () => {},
    warn: () => {},
  };
}

/**
 * Build a mock sessionManager whose spawn() records the call options,
 * returns a thenable with a `.handle` property (as Planner expects), and
 * resolves to { handle, result } where result carries the fixture.
 *
 * Returns { mockSessionManager, getSpawnCalls }.
 */
function makeMockSessionManager(resultFixture = fixtureResult) {
  const spawnCalls = [];

  const mockSessionManager = {
    spawn(opts) {
      spawnCalls.push(opts);
      const mockHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
      const p = Promise.resolve({ handle: mockHandle, result: resultFixture });
      // Planner accesses spawnPromise.handle before awaiting
      p.handle = mockHandle;
      return p;
    },
  };

  return {
    mockSessionManager,
    getSpawnCalls: () => spawnCalls,
  };
}

// ── TC1: spawn is called with jsonSchema equal to regressionRemediationSchema ──

await test('TC1: spawn is called with jsonSchema equal to regressionRemediationSchema', async () => {
  const { mockSessionManager, getSpawnCalls } = makeMockSessionManager();
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  await planner.remediateRegressionFailure('001-002', sampleFindings, '/tmp/project');

  const calls = getSpawnCalls();
  assert.equal(calls.length, 1, `Expected 1 spawn call, got ${calls.length}`);
  assert.deepStrictEqual(
    calls[0].jsonSchema,
    regressionRemediationSchema,
    `spawn jsonSchema should equal regressionRemediationSchema.\nGot: ${JSON.stringify(calls[0].jsonSchema)}`,
  );
});

// ── TC2: Prompt text includes each finding's file path and description ──────

await test('TC2: prompt text includes each finding\'s file path and description', async () => {
  const { mockSessionManager, getSpawnCalls } = makeMockSessionManager();
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  await planner.remediateRegressionFailure('001-002', sampleFindings, '/tmp/project');

  const { prompt } = getSpawnCalls()[0];

  for (const finding of sampleFindings) {
    assert.ok(
      prompt.includes(finding.file),
      `Prompt should include file path "${finding.file}".\nPrompt:\n${prompt}`,
    );
    assert.ok(
      prompt.includes(finding.description),
      `Prompt should include description "${finding.description}".\nPrompt:\n${prompt}`,
    );
  }
});

// ── TC3: Return value has newTasks array matching the fixture ───────────────

await test('TC3: return value has newTasks array matching the fixture', async () => {
  const { mockSessionManager } = makeMockSessionManager();
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  const result = await planner.remediateRegressionFailure('001-002', sampleFindings, '/tmp/project');

  assert.ok(result && typeof result === 'object',
    'Result should be a non-null object');
  assert.ok(Array.isArray(result.newTasks),
    `result.newTasks should be an array. Got: ${JSON.stringify(result)}`);
  assert.deepStrictEqual(
    result.newTasks,
    fixtureNewTasks,
    `result.newTasks should match fixtureNewTasks.\nExpected: ${JSON.stringify(fixtureNewTasks)}\nActual:   ${JSON.stringify(result.newTasks)}`,
  );
});

// ── TC4: Empty findings array produces a valid prompt (no crash) ────────────

await test('TC4: empty findings array produces a valid prompt (no crash)', async () => {
  const emptyFixture = {
    structured_output: { newTasks: [] },
  };
  const { mockSessionManager, getSpawnCalls } = makeMockSessionManager(emptyFixture);
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  let result;
  let threw = false;
  try {
    result = await planner.remediateRegressionFailure('001-002', [], '/tmp/project');
  } catch (err) {
    threw = true;
    assert.fail(`remediateRegressionFailure threw with empty findings: ${err.message}`);
  }

  assert.equal(threw, false, 'Should not throw with empty findings');
  assert.ok(result && typeof result === 'object', 'Result should be an object');
  assert.ok(Array.isArray(result.newTasks), 'result.newTasks should be an array');
  assert.equal(result.newTasks.length, 0, 'newTasks should be empty for empty findings');

  // The spawn call should still have been made with a non-empty prompt string
  const calls = getSpawnCalls();
  assert.equal(calls.length, 1, 'spawn should still have been called once');
  assert.ok(typeof calls[0].prompt === 'string' && calls[0].prompt.length > 0,
    'prompt should be a non-empty string even with empty findings');
});

// ── TC5: Malformed structured_output returns { newTasks: [] } gracefully ────

await test('TC5: malformed structured_output (missing newTasks key) returns { newTasks: [] } without throwing', async () => {
  // structured_output present but missing the newTasks key
  const malformedFixture = {
    structured_output: { unexpectedKey: 'bad-value' },
  };
  const { mockSessionManager } = makeMockSessionManager(malformedFixture);
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  let result;
  let threw = false;
  try {
    result = await planner.remediateRegressionFailure('001-002', sampleFindings, '/tmp/project');
  } catch (err) {
    threw = true;
    assert.fail(`remediateRegressionFailure threw on malformed structured_output: ${err.message}`);
  }

  assert.equal(threw, false, 'Should not throw on malformed structured_output');
  assert.ok(result && typeof result === 'object',
    `Result should be a non-null object. Got: ${JSON.stringify(result)}`);
  assert.ok(Array.isArray(result.newTasks),
    `result.newTasks should be an array. Got: ${JSON.stringify(result)}`);
  assert.equal(result.newTasks.length, 0,
    `result.newTasks should be empty when structured_output is malformed. Got: ${JSON.stringify(result.newTasks)}`);
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
