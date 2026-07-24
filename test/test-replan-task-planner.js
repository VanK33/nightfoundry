/**
 * test-replan-task-planner.js — Unit tests for Planner.replanTask.
 *
 * No live Claude sessions are spawned — sessionManager.spawn is replaced
 * by a mock fixture following the test-review-remediation-planner.js pattern.
 *
 * Run: node test/test-replan-task-planner.js
 */
import assert from 'assert';
import { taskReplanSchema } from '../src/orchestrator/agents/_schemas.js';
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

// Fixture replacement tasks that sessionManager.spawn resolves with
const fixtureReplacementTasks = [
  {
    id: '001-002-003-004-rp-001',
    description: 'Fix null check in executor.js before accessing structured_output',
    targetFiles: ['src/orchestrator/agents/executor.js'],
    dependencies: [{ taskId: '001-002-003-003', type: 'hard' }],
  },
  {
    id: '001-002-003-004-rp-002',
    description: 'Add error handling in pipeline.js for missing tokenTracker',
    targetFiles: ['src/orchestrator/core/pipeline.js'],
    dependencies: [{ taskId: '001-002-003-004-rp-001', type: 'hard' }],
  },
];

const fixtureResult = {
  structured_output: {
    replacementTasks: fixtureReplacementTasks,
  },
};

// Sample failedTask passed to replanTask
const sampleFailedTask = {
  id: '001-002-003-004',
  description: 'Implement token tracking in executor with null safety',
  targetFiles: [
    'src/orchestrator/agents/executor.js',
    'src/orchestrator/core/pipeline.js',
  ],
};

// Sample analyzerReport passed to replanTask
const sampleAnalyzerReport = {
  rootCause: 'executor.js accesses result.structured_output without null guard causing TypeError',
  evidence: 'Stack trace shows TypeError at executor.js:142 — Cannot read property of undefined',
};

// Sample missionContext passed to replanTask
const sampleMissionContext = 'Mission 001-002-003: Implement robust error handling across orchestrator agents.';

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

// ── TC1: spawn is called with jsonSchema equal to taskReplanSchema ──────────

await test('TC1: spawn is called with jsonSchema equal to taskReplanSchema', async () => {
  const { mockSessionManager, getSpawnCalls } = makeMockSessionManager();
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  await planner.replanTask(sampleFailedTask, sampleAnalyzerReport, sampleMissionContext);

  const calls = getSpawnCalls();
  assert.equal(calls.length, 1, `Expected 1 spawn call, got ${calls.length}`);
  assert.deepStrictEqual(
    calls[0].jsonSchema,
    taskReplanSchema,
    `spawn jsonSchema should equal taskReplanSchema.\nGot: ${JSON.stringify(calls[0].jsonSchema)}`,
  );
});

// ── TC2: Prompt includes failedTask.id, failedTask.description, each targetFile ──

await test('TC2: prompt includes failedTask.id, failedTask.description, each targetFile', async () => {
  const { mockSessionManager, getSpawnCalls } = makeMockSessionManager();
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  await planner.replanTask(sampleFailedTask, sampleAnalyzerReport, sampleMissionContext);

  const { prompt } = getSpawnCalls()[0];

  assert.ok(
    prompt.includes(sampleFailedTask.id),
    `Prompt should include failedTask.id "${sampleFailedTask.id}".\nPrompt:\n${prompt}`,
  );
  assert.ok(
    prompt.includes(sampleFailedTask.description),
    `Prompt should include failedTask.description "${sampleFailedTask.description}".\nPrompt:\n${prompt}`,
  );
  for (const targetFile of sampleFailedTask.targetFiles) {
    assert.ok(
      prompt.includes(targetFile),
      `Prompt should include targetFile "${targetFile}".\nPrompt:\n${prompt}`,
    );
  }
});

// ── TC3: Prompt includes analyzerReport.rootCause and analyzerReport.evidence ─

await test('TC3: prompt includes analyzerReport.rootCause and analyzerReport.evidence', async () => {
  const { mockSessionManager, getSpawnCalls } = makeMockSessionManager();
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  await planner.replanTask(sampleFailedTask, sampleAnalyzerReport, sampleMissionContext);

  const { prompt } = getSpawnCalls()[0];

  assert.ok(
    prompt.includes(sampleAnalyzerReport.rootCause),
    `Prompt should include analyzerReport.rootCause "${sampleAnalyzerReport.rootCause}".\nPrompt:\n${prompt}`,
  );
  assert.ok(
    prompt.includes(sampleAnalyzerReport.evidence),
    `Prompt should include analyzerReport.evidence "${sampleAnalyzerReport.evidence}".\nPrompt:\n${prompt}`,
  );
});

// ── TC4: Prompt includes missionContext text ────────────────────────────────

await test('TC4: prompt includes missionContext text', async () => {
  const { mockSessionManager, getSpawnCalls } = makeMockSessionManager();
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  await planner.replanTask(sampleFailedTask, sampleAnalyzerReport, sampleMissionContext);

  const { prompt } = getSpawnCalls()[0];

  assert.ok(
    prompt.includes(sampleMissionContext),
    `Prompt should include missionContext text "${sampleMissionContext}".\nPrompt:\n${prompt}`,
  );
});

// ── TC5: Return value has replacementTasks array matching the fixture ────────

await test('TC5: return value has replacementTasks array matching the fixture', async () => {
  const { mockSessionManager } = makeMockSessionManager();
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  const result = await planner.replanTask(sampleFailedTask, sampleAnalyzerReport, sampleMissionContext);

  assert.ok(result && typeof result === 'object',
    'Result should be a non-null object');
  assert.ok(Array.isArray(result.replacementTasks),
    `result.replacementTasks should be an array. Got: ${JSON.stringify(result)}`);
  assert.deepStrictEqual(
    result.replacementTasks,
    fixtureReplacementTasks,
    `result.replacementTasks should match fixtureReplacementTasks.\nExpected: ${JSON.stringify(fixtureReplacementTasks)}\nActual:   ${JSON.stringify(result.replacementTasks)}`,
  );
});

// ── TC6: Replacement task IDs follow {original-id}-rp-001 convention ────────

await test('TC6: replacement task ID convention is referenced in system prompt or prompt', async () => {
  const { mockSessionManager, getSpawnCalls } = makeMockSessionManager();
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  await planner.replanTask(sampleFailedTask, sampleAnalyzerReport, sampleMissionContext);

  const call = getSpawnCalls()[0];
  const combinedText = (call.prompt || '') + (call.systemPrompt || '');

  // The convention "{original-id}-rp-001" should appear in the prompt or system prompt
  assert.ok(
    combinedText.includes('-rp-001'),
    `Prompt or system prompt should reference the "-rp-001" ID convention.\nCombined text:\n${combinedText}`,
  );
});

// ── TC7: Session name includes failed task ID for log correlation ─────────────

await test('TC7: session name includes failed task ID for log correlation', async () => {
  const { mockSessionManager, getSpawnCalls } = makeMockSessionManager();
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  await planner.replanTask(sampleFailedTask, sampleAnalyzerReport, sampleMissionContext);

  const calls = getSpawnCalls();
  assert.equal(calls.length, 1, 'Expected 1 spawn call');
  assert.ok(
    calls[0].name && calls[0].name.includes(sampleFailedTask.id),
    `Session name should include failedTask.id "${sampleFailedTask.id}".\nActual name: "${calls[0].name}"`,
  );
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
