/**
 * test-planner-prompt.js — Unit tests for planner system prompt content.
 *
 * Tests that the planMission system prompt contains task-specificity
 * instructions and that the planGlobal system prompt does NOT.
 *
 * No live SDK calls are made — a fake sessionManager intercepts spawn()
 * and captures the systemPrompt argument before it would reach the network.
 *
 * Run: node test/test-planner-prompt.js
 */
import assert from 'assert';
import { Planner, PROMPT_SECTION_TASK_SPECIFICITY, PROMPT_SECTION_SYMBOL_ANCHOR, PROMPT_SECTION_LITERAL_PATHS, PROMPT_SECTION_PRESERVE_PATH_ANCHOR } from '../src/orchestrator/agents/planner.js';
import { PROMPT_SECTION_TASK_SPECIFICITY as SRC_TASK_SPECIFICITY, PROMPT_SECTION_SYMBOL_ANCHOR as SRC_SYMBOL_ANCHOR, PROMPT_SECTION_LITERAL_PATHS as SRC_LITERAL_PATHS, PROMPT_SECTION_PRESERVE_PATH_ANCHOR as SRC_PRESERVE_PATH_ANCHOR, PROMPT_SECTION_NO_READONLY_TASKS } from '../src/orchestrator/agents/planner-prompts.js';

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

// Keywords introduced by the task-specificity instruction in buildMissionSystemPrompt
const TASK_SPECIFICITY_KEYWORDS = ['independently verifiable', 'explicit deliverables'];

/**
 * Returns a fake session manager whose spawn() and spawnReusable() capture the
 * systemPrompt into `capturedPrompts`. The reusable path is the only live
 * planner path, so spawnReusable() captures the systemPrompt passed at spawn
 * time and returns a fake reusable session whose sendPrompt() resolves with a
 * minimal fake result.
 */
function makeFakeSessionManager(capturedPrompts) {
  const fakeHandle = {
    systemPromptTokens: 0,
    _toolCallCount: 0,
  };
  const fakeResult = {
    structured_output: { subMissions: [], milestones: [] },
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
      capturedPrompts.push(opts.systemPrompt);
      // spawnPromise must be awaitable AND have a .handle property
      // (the planner accesses spawnPromise.handle synchronously for logger.attachToSession)
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
    spawnReusable(opts) {
      // The reusable path passes the mission system prompt at spawn time.
      capturedPrompts.push(opts.systemPrompt);
      return {
        handle: fakeHandle,
        turnCount: 0,
        sendPrompt: async () => fakeResult,
      };
    },
  };
}

function makeFakeLogger() {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-planner-prompt.jsonl',
      write: () => {},
      close: () => {},
    }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
  };
}

// ── TC-anchor-mission: planMission prompt contains anchor instruction ────

await test('TC-anchor-mission: planMission prompt contains anchor instruction', async () => {
  const capturedPrompts = [];
  const planner = new Planner(
    makeFakeSessionManager(capturedPrompts),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner._planMissionReusable('001-001', '/fake/root', { missionPlan: 'test plan' }, 7);

  assert.equal(capturedPrompts.length, 1, 'spawn() should have been called exactly once');
  const missionPrompt = capturedPrompts[0];

  const ANCHOR_PHRASES = ['always anchor', 'Always anchor', 'symbol anchor'];
  const hasAnchorInstruction = ANCHOR_PHRASES.some((phrase) => missionPrompt.includes(phrase));
  assert.ok(
    hasAnchorInstruction,
    `planMission system prompt should contain an anchor instruction (one of: [${ANCHOR_PHRASES.join(', ')}])\n` +
    `Prompt excerpt: ${missionPrompt.slice(0, 500)}`,
  );
});

// ── TC-anchor-example: planMission prompt contains the Good anchor example ──

await test('TC-anchor-example: planMission prompt contains Good anchor example', async () => {
  const capturedPrompts = [];
  const planner = new Planner(
    makeFakeSessionManager(capturedPrompts),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner._planMissionReusable('001-001', '/fake/root', { missionPlan: 'test plan' }, 7);

  assert.equal(capturedPrompts.length, 1, 'spawn() should have been called exactly once');
  const missionPrompt = capturedPrompts[0];

  // The Good anchor example names a specific function: resolveTimeout
  const ANCHOR_GOOD_EXAMPLE = 'resolveTimeout';
  assert.ok(
    missionPrompt.includes(ANCHOR_GOOD_EXAMPLE),
    `planMission system prompt should contain the Good anchor example referencing '${ANCHOR_GOOD_EXAMPLE}'\n` +
    `Prompt excerpt: ${missionPrompt.slice(0, 500)}`,
  );
});

// ── TC-replan-specificity: replanTask prompt contains specificity block ───

await test('TC-replan-specificity: replanTask prompt contains specificity heading and independently verifiable', async () => {
  const capturedPrompts = [];
  const fakeSessionManager = {
    spawn(opts) {
      capturedPrompts.push(opts.systemPrompt);
      const fakeHandle = {
        systemPromptTokens: 0,
        _toolCallCount: 0,
      };
      const fakeResult = {
        structured_output: { replacementTasks: [] },
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

  const planner = new Planner(
    fakeSessionManager,
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  const fakeFailedTask = {
    id: '001-001',
    description: 'Add helper function',
    targetFiles: ['src/utils.js'],
  };
  const fakeAnalyzerReport = {
    rootCause: 'Missing implementation',
    evidence: 'Function not found',
  };

  await planner.replanTask(fakeFailedTask, fakeAnalyzerReport, 'Mission context text');

  assert.equal(capturedPrompts.length, 1, 'spawn() should have been called exactly once');
  const replanPrompt = capturedPrompts[0];

  assert.ok(
    replanPrompt.includes('## Task description specificity'),
    `replanTask system prompt should contain '## Task description specificity' heading\n` +
    `Prompt excerpt: ${replanPrompt.slice(0, 500)}`,
  );
  assert.ok(
    replanPrompt.includes('independently verifiable'),
    `replanTask system prompt should contain 'independently verifiable' keyword\n` +
    `Prompt excerpt: ${replanPrompt.slice(0, 500)}`,
  );
});

// ── TC2: planMission prompt contains task-specificity instruction ─────

await test('planMission prompt contains task-specificity instruction', async () => {
  const capturedPrompts = [];
  const planner = new Planner(
    makeFakeSessionManager(capturedPrompts),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  // Drive the reusable path (the only planner path) so the mission
  // system prompt is captured via the spawnReusable mock.
  await planner._planMissionReusable('001-001', '/fake/root', { missionPlan: 'test plan' }, 7);

  assert.equal(capturedPrompts.length, 1, 'spawn() should have been called exactly once');
  const missionPrompt = capturedPrompts[0];

  const hasKeyword = TASK_SPECIFICITY_KEYWORDS.some((kw) => missionPrompt.includes(kw));
  assert.ok(
    hasKeyword,
    `planMission system prompt should contain at least one of: [${TASK_SPECIFICITY_KEYWORDS.join(', ')}]\n` +
    `Prompt excerpt: ${missionPrompt.slice(0, 300)}`,
  );
});

// ── TC3: planGlobal prompt does NOT contain task-specificity instruction

await test('planGlobal prompt does NOT contain task-specificity instruction', async () => {
  const capturedPrompts = [];
  const planner = new Planner(
    makeFakeSessionManager(capturedPrompts),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner.planGlobal('test goal', '/fake/root');

  assert.equal(capturedPrompts.length, 1, 'spawn() should have been called exactly once');
  const globalPrompt = capturedPrompts[0];

  const hasKeyword = TASK_SPECIFICITY_KEYWORDS.some((kw) => globalPrompt.includes(kw));
  assert.ok(
    !hasKeyword,
    `planGlobal system prompt should NOT contain task-specificity keywords: [${TASK_SPECIFICITY_KEYWORDS.join(', ')}]\n` +
    `Prompt excerpt: ${globalPrompt.slice(0, 300)}`,
  );
});

// ── _warnIfVagueDescriptions tests ───────────────────────────────────

/**
 * Returns a fake logger that captures warn() calls into an array and
 * also satisfies the remaining Planner constructor requirements.
 */
function makeFakeLoggerWithWarn(warnCalls) {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-planner-prompt.jsonl',
      write: () => {},
      close: () => {},
    }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
    warn: (...args) => { warnCalls.push(args); },
  };
}

// ── TC-warn-match ─────────────────────────────────────────────────────

await test('TC-warn-match: logger.warn called when description matches /\\.[a-z]{1,5}:\\d+/i', async () => {
  const warnCalls = [];
  const planner = new Planner(
    makeFakeSessionManager([]),
    makeFakeLoggerWithWarn(warnCalls),
    { recordSession: async () => {} },
  );

  const plan = {
    subMissions: [
      {
        tasks: [
          { id: '001-001-001-001', description: 'edit foo.js:42 to fix bug' },
        ],
      },
    ],
  };

  planner._warnIfVagueDescriptions(plan, 'test');

  assert.ok(
    warnCalls.length >= 1,
    `logger.warn should have been called at least once, got ${warnCalls.length} calls`,
  );
  const allWarnArgs = warnCalls.flat().join(' ');
  assert.ok(
    allWarnArgs.includes('001-001-001-001'),
    `warn call should reference task ID '001-001-001-001', got: ${allWarnArgs}`,
  );
});

// ── TC-no-warn-404 ────────────────────────────────────────────────────

await test('TC-no-warn-404: logger.warn NOT called for "404: not found"', async () => {
  const warnCalls = [];
  const planner = new Planner(
    makeFakeSessionManager([]),
    makeFakeLoggerWithWarn(warnCalls),
    { recordSession: async () => {} },
  );

  const plan = {
    subMissions: [
      {
        tasks: [
          { id: '001-001-001-002', description: '404: not found' },
        ],
      },
    ],
  };

  planner._warnIfVagueDescriptions(plan, 'test');

  assert.equal(
    warnCalls.length,
    0,
    `logger.warn should NOT have been called for '404: not found', got ${warnCalls.length} call(s)`,
  );
});

// ── TC-no-warn-taskid ─────────────────────────────────────────────────

await test('TC-no-warn-taskid: logger.warn NOT called for task ID strings like "001-002-003-004"', async () => {
  const warnCalls = [];
  const planner = new Planner(
    makeFakeSessionManager([]),
    makeFakeLoggerWithWarn(warnCalls),
    { recordSession: async () => {} },
  );

  const plan = {
    subMissions: [
      {
        tasks: [
          { id: '001-001-001-003', description: 'task 001-002-003-004 done' },
        ],
      },
    ],
  };

  planner._warnIfVagueDescriptions(plan, 'test');

  assert.equal(
    warnCalls.length,
    0,
    `logger.warn should NOT have been called for a task-ID-style description, got ${warnCalls.length} call(s)`,
  );
});

// ── TC-no-throw ───────────────────────────────────────────────────────

await test('TC-no-throw: _warnIfVagueDescriptions does not throw for null/undefined/{}/bad inputs', async () => {
  const planner = new Planner(
    makeFakeSessionManager([]),
    makeFakeLoggerWithWarn([]),
    { recordSession: async () => {} },
  );

  const badInputs = [null, undefined, {}, { subMissions: null }];
  for (const input of badInputs) {
    try {
      planner._warnIfVagueDescriptions(input, 'test');
    } catch (err) {
      assert.fail(`_warnIfVagueDescriptions threw for input ${JSON.stringify(input)}: ${err.message}`);
    }
  }
});

// ── TC-literal-mission: mission prompt contains backtick-wrapped paths instruction ───

await test('TC-literal-mission: mission prompt contains backtick-wrapped paths', async () => {
  const capturedPrompts = [];
  const planner = new Planner(
    makeFakeSessionManager(capturedPrompts),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner._planMissionReusable('001-001', '/fake/root', { missionPlan: 'test plan' }, 7);

  assert.equal(capturedPrompts.length, 1, 'spawn() should have been called exactly once');
  const missionPrompt = capturedPrompts[0];

  assert.ok(
    missionPrompt.includes('backtick-wrapped paths'),
    `planMission system prompt should contain 'backtick-wrapped paths'\n` +
    `Prompt excerpt: ${missionPrompt.slice(0, 500)}`,
  );
});

await test('TC-literal-mission: mission prompt contains exactly as written', async () => {
  const capturedPrompts = [];
  const planner = new Planner(
    makeFakeSessionManager(capturedPrompts),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner._planMissionReusable('001-001', '/fake/root', { missionPlan: 'test plan' }, 7);

  assert.equal(capturedPrompts.length, 1, 'spawn() should have been called exactly once');
  const missionPrompt = capturedPrompts[0];

  assert.ok(
    missionPrompt.includes('exactly as written'),
    `planMission system prompt should contain 'exactly as written'\n` +
    `Prompt excerpt: ${missionPrompt.slice(0, 500)}`,
  );
});

// ── TC-literal-replan: replan prompt contains backtick-wrapped paths ─────

await test('TC-literal-replan: replan prompt contains backtick-wrapped paths', async () => {
  const capturedPrompts = [];
  const fakeSessionManager = {
    spawn(opts) {
      capturedPrompts.push(opts.systemPrompt);
      const fakeHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
      const fakeResult = {
        structured_output: { replacementTasks: [] },
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        total_cost_usd: 0,
      };
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
  };

  const planner = new Planner(fakeSessionManager, makeFakeLogger(), { recordSession: async () => {} });

  const fakeFailedTask = {
    id: '001-001',
    description: 'Add helper function',
    targetFiles: ['src/utils.js'],
  };
  const fakeAnalyzerReport = {
    rootCause: 'Missing implementation',
    evidence: 'Function not found',
  };

  await planner.replanTask(fakeFailedTask, fakeAnalyzerReport, 'Mission context text');

  assert.equal(capturedPrompts.length, 1, 'spawn() should have been called exactly once');
  const replanPrompt = capturedPrompts[0];

  assert.ok(
    replanPrompt.includes('backtick-wrapped paths'),
    `replanTask system prompt should contain 'backtick-wrapped paths'\n` +
    `Prompt excerpt: ${replanPrompt.slice(0, 500)}`,
  );
});

// ── TC-literal-example: mission prompt contains 'test/test-foo.js' example ──

await test('TC-literal-example: mission prompt contains test/test-foo.js example', async () => {
  const capturedPrompts = [];
  const planner = new Planner(
    makeFakeSessionManager(capturedPrompts),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner._planMissionReusable('001-001', '/fake/root', { missionPlan: 'test plan' }, 7);

  assert.equal(capturedPrompts.length, 1, 'spawn() should have been called exactly once');
  const missionPrompt = capturedPrompts[0];

  assert.ok(
    missionPrompt.includes('test/test-foo.js'),
    `planMission system prompt should contain the Good example path 'test/test-foo.js'\n` +
    `Prompt excerpt: ${missionPrompt.slice(0, 500)}`,
  );
});

// ── TC: planner prompts teach functional identity vs precision scenery ──

await test('planGlobal prompt body contains functionalization guidance (functional identity vs scenery)', async () => {
  const fs = await import('fs');
  const url = await import('url');
  const pathMod = await import('path');
  const __dirname = pathMod.dirname(url.fileURLToPath(import.meta.url));
  const plannerSrc = fs.readFileSync(
    pathMod.resolve(__dirname, '../src/orchestrator/agents/planner.js'),
    'utf8',
  );
  // Must mention both 'functional' AND one of {scenery, line number, line-number}
  assert.ok(
    /functional/i.test(plannerSrc),
    'planner.js must mention functional identity in its prompt',
  );
  assert.ok(
    /scenery|line[\s-]number/i.test(plannerSrc),
    "planner.js prompt must reference 'scenery' or 'line number' so the model knows what to lift identity out of",
  );
});

await test('verifyAssumptions prompt body teaches identity-vs-scenery in classification', async () => {
  const fs = await import('fs');
  const url = await import('url');
  const pathMod = await import('path');
  const __dirname = pathMod.dirname(url.fileURLToPath(import.meta.url));
  const plannerSrc = fs.readFileSync(
    pathMod.resolve(__dirname, '../src/orchestrator/agents/planner.js'),
    'utf8',
  );
  // The verifyAssumptions classification block must clarify that line-number drift alone is not failed
  assert.ok(
    /line[\s-]number mismatch ALONE is NOT a failed assumption|line[\s-]number mismatch alone is not/i.test(plannerSrc),
    'verifyAssumptions prompt must state that line-number mismatch alone is NOT a failed assumption',
  );
});

// ── makeFakeSessionManagerCaptureBoth ───────────────────────────────────────

/**
 * Like makeFakeSessionManager, but captures BOTH opts.systemPrompt (into
 * capturedSystem) AND opts.prompt (into capturedUser) on each spawn/spawnReusable call.
 */
function makeFakeSessionManagerCaptureBoth(capturedSystem, capturedUser) {
  const fakeHandle = {
    systemPromptTokens: 0,
    _toolCallCount: 0,
  };
  const fakeResult = {
    structured_output: { subMissions: [], milestones: [] },
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
      capturedSystem.push(opts.systemPrompt);
      capturedUser.push(opts.prompt);
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
    spawnReusable(opts) {
      capturedSystem.push(opts.systemPrompt);
      let turnCount = 0;
      return {
        handle: fakeHandle,
        get turnCount() { return turnCount; },
        sendPrompt: async (prompt) => {
          capturedUser.push(prompt);
          turnCount++;
          return fakeResult;
        },
        close: async () => {},
      };
    },
  };
}

// ── TC-global-target-files-and-criteria ─────────────────────────────────────

await test('TC-global-target-files-and-criteria: user prompt contains target files and acceptance criteria', async () => {
  const capturedSystem = [];
  const capturedUser = [];
  const planner = new Planner(
    makeFakeSessionManagerCaptureBoth(capturedSystem, capturedUser),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner.planGlobal('test goal', '/fake/root', {
    specTargetFiles: ['src/foo.js', 'src/bar.ts'],
    specAcceptanceCriteria: [
      {
        description: 'Login rejects expired tokens',
        verification: { kind: 'command', command: 'node test/test-auth.js' },
      },
      {
        description: 'README updated',
        verification: { kind: 'file-check' },
      },
    ],
  });

  assert.equal(capturedUser.length, 1, 'spawn() should have been called exactly once');
  const userPrompt = capturedUser[0];

  assert.ok(
    userPrompt.includes('Declared target files'),
    'user prompt should include "Declared target files" header',
  );
  assert.ok(
    userPrompt.includes('src/foo.js'),
    'user prompt should include src/foo.js',
  );
  assert.ok(
    userPrompt.includes('src/bar.ts'),
    'user prompt should include src/bar.ts',
  );
  assert.ok(
    userPrompt.includes('Acceptance criteria'),
    'user prompt should include "Acceptance criteria" header',
  );
  assert.ok(
    userPrompt.includes('Login rejects expired tokens'),
    'user prompt should include the command criterion description',
  );
  assert.ok(
    userPrompt.includes('README updated'),
    'user prompt should include the file-check criterion description',
  );
  assert.ok(
    userPrompt.includes('Verify: node test/test-auth.js'),
    'user prompt should include Verify line for kind=command criterion',
  );
  // The file-check criterion should NOT have a Verify: line immediately after its entry
  const lines = userPrompt.split('\n');
  const readmeLineIndex = lines.findIndex((l) => l.includes('README updated'));
  assert.ok(readmeLineIndex !== -1, 'README updated line should exist in user prompt');
  const nextLine = lines[readmeLineIndex + 1] || '';
  assert.ok(
    !nextLine.trim().startsWith('Verify:'),
    `user prompt should NOT include a Verify: line for the file-check criterion (got: "${nextLine}")`,
  );
});

// ── TC-global-empty-no-block ─────────────────────────────────────────────────

await test('TC-global-empty-no-block: user prompt omits sections when arrays are empty or absent', async () => {
  const capturedSystem1 = [];
  const capturedUser1 = [];
  const planner1 = new Planner(
    makeFakeSessionManagerCaptureBoth(capturedSystem1, capturedUser1),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );
  await planner1.planGlobal('test goal', '/fake/root', { specTargetFiles: [], specAcceptanceCriteria: [] });

  const capturedSystem2 = [];
  const capturedUser2 = [];
  const planner2 = new Planner(
    makeFakeSessionManagerCaptureBoth(capturedSystem2, capturedUser2),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );
  await planner2.planGlobal('test goal', '/fake/root');

  for (const [label, userPrompt] of [['empty arrays', capturedUser1[0]], ['no opts', capturedUser2[0]]]) {
    assert.ok(
      !userPrompt.includes('Declared target files'),
      `user prompt (${label}) should NOT contain "Declared target files"`,
    );
    assert.ok(
      !userPrompt.includes('Acceptance criteria'),
      `user prompt (${label}) should NOT contain "Acceptance criteria"`,
    );
  }
});

// ── TC-global-system-prompt-unchanged ───────────────────────────────────────

await test('TC-global-system-prompt-unchanged: system prompt does not contain spec-specific strings', async () => {
  const capturedSystem = [];
  const capturedUser = [];
  const planner = new Planner(
    makeFakeSessionManagerCaptureBoth(capturedSystem, capturedUser),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner.planGlobal('test goal', '/fake/root', {
    specTargetFiles: ['src/foo.js', 'src/bar.ts'],
    specAcceptanceCriteria: [
      {
        description: 'Login rejects expired tokens',
        verification: { kind: 'command', command: 'node test/test-auth.js' },
      },
      {
        description: 'README updated',
        verification: { kind: 'file-check' },
      },
    ],
  });

  assert.equal(capturedSystem.length, 1, 'spawn() should have been called exactly once');
  const systemPrompt = capturedSystem[0];

  const specStrings = [
    'Declared target files',
    'Acceptance criteria',
    'src/foo.js',
    'node test/test-auth.js',
  ];
  for (const s of specStrings) {
    assert.ok(
      !systemPrompt.includes(s),
      `system prompt should NOT contain "${s}"`,
    );
  }
});

// ── TC-shared-identity-mission-replan: 4 constants appear in both mission and replan prompts ──

await test('TC-shared-identity-mission-replan: 4 prompt-section constants appear in mission and replan prompts', async () => {
  // Capture mission prompt
  const missionPrompts = [];
  const missionPlanner = new Planner(
    makeFakeSessionManager(missionPrompts),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );
  await missionPlanner._planMissionReusable('001-001', '/fake/root', { missionPlan: 'test' }, 7);
  assert.equal(missionPrompts.length, 1, 'spawnReusable() should have been called exactly once for mission');
  const missionPrompt = missionPrompts[0];

  // Capture replan prompt
  const replanPrompts = [];
  const fakeSessionManager = {
    spawn(opts) {
      replanPrompts.push(opts.systemPrompt);
      const fakeHandle = {
        systemPromptTokens: 0,
        _toolCallCount: 0,
      };
      const fakeResult = {
        structured_output: { replacementTasks: [] },
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
  const replanPlanner = new Planner(
    fakeSessionManager,
    makeFakeLogger(),
    { recordSession: async () => {} },
  );
  const fakeFailedTask = {
    id: '001-001',
    description: 'Add helper function',
    targetFiles: ['src/utils.js'],
  };
  const fakeAnalyzerReport = {
    rootCause: 'Missing implementation',
    evidence: 'Function not found',
  };
  await replanPlanner.replanTask(fakeFailedTask, fakeAnalyzerReport, 'ctx');
  assert.equal(replanPrompts.length, 1, 'spawn() should have been called exactly once for replan');
  const replanPrompt = replanPrompts[0];

  const constants = [
    ['PROMPT_SECTION_TASK_SPECIFICITY', PROMPT_SECTION_TASK_SPECIFICITY],
    ['PROMPT_SECTION_SYMBOL_ANCHOR', PROMPT_SECTION_SYMBOL_ANCHOR],
    ['PROMPT_SECTION_LITERAL_PATHS', PROMPT_SECTION_LITERAL_PATHS],
    ['PROMPT_SECTION_PRESERVE_PATH_ANCHOR', PROMPT_SECTION_PRESERVE_PATH_ANCHOR],
    ['PROMPT_SECTION_NO_READONLY_TASKS', PROMPT_SECTION_NO_READONLY_TASKS],
  ];
  for (const [name, constant] of constants) {
    assert.ok(
      missionPrompt.includes(constant),
      `mission prompt should include ${name}`,
    );
    assert.ok(
      replanPrompt.includes(constant),
      `replan prompt should include ${name}`,
    );
  }
});

// ── TC-dedup-grep-task-specificity: '## Task description specificity' appears exactly once ──

await test('TC-dedup-grep-task-specificity: heading appears exactly once in planner-prompts.js source', async () => {
  const fs = await import('fs');
  const url = await import('url');
  const pathMod = await import('path');
  const __dirname = pathMod.dirname(url.fileURLToPath(import.meta.url));
  const plannerSrc = fs.readFileSync(
    pathMod.resolve(__dirname, '../src/orchestrator/agents/planner-prompts.js'),
    'utf8',
  );
  const heading = '## Task description specificity';
  const occurrences = plannerSrc.split(heading).length - 1;
  assert.equal(
    occurrences,
    1,
    `'${heading}' should appear exactly once in planner-prompts.js, found ${occurrences}`,
  );
});

// ── TC-dedup-grep-preserve-path: '## Preserve spec author\'s path anchor' appears exactly once ──

await test("TC-dedup-grep-preserve-path: heading appears exactly once in planner-prompts.js source", async () => {
  const fs = await import('fs');
  const url = await import('url');
  const pathMod = await import('path');
  const __dirname = pathMod.dirname(url.fileURLToPath(import.meta.url));
  const plannerSrc = fs.readFileSync(
    pathMod.resolve(__dirname, '../src/orchestrator/agents/planner-prompts.js'),
    'utf8',
  );
  const heading = "## Preserve spec author's path anchor";
  const occurrences = plannerSrc.split(heading).length - 1;
  assert.equal(
    occurrences,
    1,
    `'${heading}' should appear exactly once in planner-prompts.js, found ${occurrences}`,
  );
});

// ── TC-sot-wiring: planner.js re-exports are reference-identical to planner-prompts.js originals ──

await test('TC-sot-wiring: planner.js re-exports are reference-identical (===) to planner-prompts.js originals', async () => {
  assert.strictEqual(PROMPT_SECTION_TASK_SPECIFICITY, SRC_TASK_SPECIFICITY, 'TASK_SPECIFICITY must be === identical');
  assert.strictEqual(PROMPT_SECTION_SYMBOL_ANCHOR, SRC_SYMBOL_ANCHOR, 'SYMBOL_ANCHOR must be === identical');
  assert.strictEqual(PROMPT_SECTION_LITERAL_PATHS, SRC_LITERAL_PATHS, 'LITERAL_PATHS must be === identical');
  assert.strictEqual(PROMPT_SECTION_PRESERVE_PATH_ANCHOR, SRC_PRESERVE_PATH_ANCHOR, 'PRESERVE_PATH_ANCHOR must be === identical');
});

// ── TC-ac-null-no-crash: null items in acceptance criteria do not crash ──

await test('TC-ac-null-no-crash: planGlobal with null acceptance criteria items does not crash', async () => {
  const capturedUser = [];
  const planner = new Planner(
    makeFakeSessionManagerCaptureBoth([], capturedUser),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  // Should not throw even with null items
  await planner.planGlobal('test goal', '/fake/root', {
    specAcceptanceCriteria: [
      null,
      { description: 'Valid criterion' },
      null,
    ],
  });

  assert.equal(capturedUser.length, 1, 'spawn() should have been called exactly once');
  const userPrompt = capturedUser[0];

  assert.ok(
    userPrompt.includes('Valid criterion'),
    'user prompt should include the valid criterion description',
  );
});

// ── TC-ac-no-description-warn: items without description are skipped with warning ──

await test('TC-ac-no-description-warn: planGlobal skips criterion without description and logs warning via onLog', async () => {
  const capturedUser = [];
  const logMessages = [];
  const planner = new Planner(
    makeFakeSessionManagerCaptureBoth([], capturedUser),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner.planGlobal('test goal', '/fake/root', {
    specAcceptanceCriteria: [
      { verification: { kind: 'command', command: 'x' } },
      { description: 'Valid criterion' },
    ],
    onLog: (msg) => logMessages.push(msg),
  });

  assert.equal(capturedUser.length, 1, 'spawn() should have been called exactly once');
  const userPrompt = capturedUser[0];

  assert.ok(
    !userPrompt.includes('Verify: x') || userPrompt.includes('Valid criterion'),
    'user prompt should include valid criterion but not the no-description item',
  );
  assert.ok(
    userPrompt.includes('Valid criterion'),
    'user prompt should still include the valid criterion',
  );

  // Verify warning was emitted
  assert.ok(
    logMessages.length >= 1,
    `onLog should have been called at least once, got ${logMessages.length} calls`,
  );
  const allMessages = logMessages.join(' ');
  assert.ok(
    allMessages.includes('Skipping non-object/missing-description acceptance criterion at index 0'),
    `warning message should match expected pattern, got: ${allMessages}`,
  );
});

// ── TC-ac-valid-criteria-correct-block: all valid criteria produce correct block ──

await test('TC-ac-valid-criteria-correct-block: planGlobal with all valid criteria produces correct acceptanceCriteriaBlock', async () => {
  const capturedUser = [];
  const planner = new Planner(
    makeFakeSessionManagerCaptureBoth([], capturedUser),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner.planGlobal('test goal', '/fake/root', {
    specAcceptanceCriteria: [
      { description: 'First criterion', verification: { kind: 'command', command: 'node test/tc1.js' } },
      { description: 'Second criterion', verification: { kind: 'file-check' } },
      { description: 'Third criterion' },
    ],
  });

  assert.equal(capturedUser.length, 1, 'spawn() should have been called exactly once');
  const userPrompt = capturedUser[0];

  assert.ok(userPrompt.includes('Acceptance criteria'), 'user prompt should include "Acceptance criteria" header');
  assert.ok(userPrompt.includes('First criterion'), 'user prompt should include "First criterion"');
  assert.ok(userPrompt.includes('Second criterion'), 'user prompt should include "Second criterion"');
  assert.ok(userPrompt.includes('Third criterion'), 'user prompt should include "Third criterion"');
  assert.ok(userPrompt.includes('Verify: node test/tc1.js'), 'user prompt should include verify line for first criterion');

  const lines = userPrompt.split('\n');
  const secondCriterionIndex = lines.findIndex((l) => l.includes('Second criterion'));
  assert.ok(secondCriterionIndex !== -1, '"Second criterion" line should exist');
  const nextLine = lines[secondCriterionIndex + 1] || '';
  assert.ok(
    !nextLine.trim().startsWith('Verify:'),
    `"Second criterion" (file-check) should NOT have a Verify: line, got: "${nextLine}"`,
  );
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
