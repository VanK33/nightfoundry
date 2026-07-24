/**
 * test-brainstormer-contract.js — Agent contract tests for the Brainstormer
 * extraction + prompt-construction surface.
 *
 * Tests the pure functions that form the Brainstormer's contract with the SDK
 * structured-output: buildBrainstormerPrompt for each mode, and
 * extractBrainstormResult for valid / missing-key / null / extra-field
 * SDK results. TC9–TC16 exercise Brainstormer.initialize and .revise via
 * in-process mocks (no Claude auth, no SDK).
 *
 * Run: node test/test-brainstormer-contract.js
 */
import assert from 'assert';
import {
  buildBrainstormerPrompt,
  extractBrainstormResult,
  Brainstormer,
} from '../src/orchestrator/agents/brainstormer.js';

let passCount = 0;
let failCount = 0;
const allTests = [];

async function test(name, fn) {
  const p = (async () => {
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
  })();
  allTests.push(p);
  return p;
}

// ── Fixtures ────────────────────────────────────────────────────────────

const validSpec = {
  goal: 'Implement a new CLI subcommand for cc-orch',
  target_files: ['src/cli/commands/foo.js', 'test/'],
  acceptance_criteria: [
    { description: 'CLI prints help on --help', verification: { kind: 'command', command: 'node test/test-foo-cli.js', targetFile: 'src/cli/commands/foo.js' } },
  ],
  constraints: ['No new dependencies'],
  architecture_notes: 'Mirror existing subcommand pattern',
};

const validSdkResult = {
  structured_output: { spec: validSpec, specMd: '# Foo\n\nThis ships foo.' },
};

const sdkMissingSpec = {
  structured_output: { specMd: '# Foo\n\nMissing spec key.' },
};

const sdkMissingSpecMd = {
  structured_output: { spec: validSpec },
};

const sdkInvalidSpec = {
  structured_output: {
    spec: { /* missing required goal/target_files/acceptance_criteria */ extra: 'x' },
    specMd: '# Bad',
  },
};

const sdkExtraTopLevel = {
  structured_output: {
    spec: validSpec,
    specMd: '# Ok',
    extraField: 'tolerated',
  },
};

const sdkNoStructured = {
  result: 'just prose, no structured_output',
};

// ── SDK mock fixtures for Brainstormer method tests ──────────────────────

const MOCK_SDK_VALID = {
  structured_output: {
    spec: validSpec,
    specMd: '# Foo\n\nThis ships foo.',
  },
};

const MOCK_SDK_MISSING_REQUIRED = {
  structured_output: {
    spec: {
      goal: 'Missing acceptance_criteria',
      target_files: ['src/foo.js'],
      // acceptance_criteria intentionally omitted
    },
    specMd: '# Missing required field',
  },
};

const MOCK_SDK_WRONG_TYPE = {
  structured_output: {
    spec: {
      goal: 42, // should be string, not number
      target_files: ['src/foo.js'],
      acceptance_criteria: [{ description: 'x', verification: { kind: 'command', command: 'node test/x.js', targetFile: 'src/foo.js' } }],
    },
    specMd: '# Wrong type',
  },
};

const MOCK_SDK_EXTRA_FIELD = {
  structured_output: {
    spec: validSpec,
    specMd: '# Extra fields tolerated',
    extraTopLevelKey: 'should be ignored',
  },
};

// ── Mock factories ───────────────────────────────────────────────────────

/**
 * Creates a mock sessionManager whose spawn() returns an object that is both:
 *   - awaitable (Promise<{handle, result}>)
 *   - has a synchronous .handle property (for attachToSession before await)
 *
 * @param {object|function} sdkResultOrThrower - SDK result object, or a
 *   zero-arg function whose return value is thrown (for spawn-level errors).
 */
function makeMockSessionManager(sdkResultOrThrower) {
  return {
    spawn(_opts) {
      const handle = {
        sessionId: 'mock-sid',
        systemPromptTokens: 0,
        _toolCallCount: 0,
      };

      let p;
      if (typeof sdkResultOrThrower === 'function') {
        p = Promise.resolve().then(() => {
          throw sdkResultOrThrower();
        });
      } else {
        p = Promise.resolve({ handle, result: sdkResultOrThrower });
      }

      // Attach .handle synchronously so brainstormer.js can access it before await
      p.handle = handle;
      return p;
    },
  };
}

/**
 * Creates a mock logger with no-op implementations of all methods used by
 * Brainstormer.initialize and Brainstormer.revise.
 */
function makeMockLogger() {
  return {
    createSessionLog(_name) {
      return {
        logPath: '/tmp/mock-session.log',
        close() {},
      };
    },
    attachToSession(_handle, _log, _opts) {},
    getSessionSummary(_logPath) {
      return {};
    },
    writeSessionSummary(_name, _summary, _opts) {},
    warn(_msg) {},
  };
}

/**
 * Creates a mock tokenTracker with an async no-op recordSession method.
 */
function makeMockTokenTracker() {
  return {
    async recordSession(_name, _role, _result, _opts) {},
  };
}

// ── Tests: TC1–TC8 (pure helper surface) ────────────────────────────────

test('TC1: buildBrainstormerPrompt initialize mode — emits user input', () => {
  const prompt = buildBrainstormerPrompt({
    mode: 'initialize',
    userInput: 'Add a foo subcommand',
  });
  assert.strictEqual(typeof prompt, 'string', 'prompt must be a string');
  assert.ok(prompt.includes('Add a foo subcommand'), 'prompt must include user input');
  assert.ok(prompt.length > 100, 'prompt must include schema guidance, not just echo input');
});

test('TC2: buildBrainstormerPrompt revise modes — accepts each mode without throwing', () => {
  for (const mode of ['regenerate', 'edit', 'append']) {
    const prompt = buildBrainstormerPrompt({
      mode,
      currentSpec: validSpec,
      feedback: 'tighten the constraints',
    });
    assert.strictEqual(typeof prompt, 'string', `prompt for ${mode} must be a string`);
    assert.ok(prompt.length > 100, `prompt for ${mode} must include schema guidance`);
  }
});

test('TC3: extractBrainstormResult — valid SDK result returns {spec, specMd}', () => {
  const out = extractBrainstormResult(validSdkResult, { warn: () => {} });
  assert.deepStrictEqual(out.spec, validSpec, 'spec must round-trip');
  assert.strictEqual(out.specMd, '# Foo\n\nThis ships foo.', 'specMd must round-trip');
});

test('TC4: extractBrainstormResult — missing top-level "spec" throws BRAINSTORM_VALIDATION_FAILED', () => {
  let thrown = null;
  try {
    extractBrainstormResult(sdkMissingSpec, { warn: () => {} });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(thrown.code, 'BRAINSTORM_VALIDATION_FAILED');
  assert.ok(
    thrown.errors.some((e) => /spec/.test(e)),
    `error list should mention 'spec'; got: ${JSON.stringify(thrown.errors)}`
  );
});

test('TC5: extractBrainstormResult — missing top-level "specMd" throws BRAINSTORM_VALIDATION_FAILED', () => {
  let thrown = null;
  try {
    extractBrainstormResult(sdkMissingSpecMd, { warn: () => {} });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(thrown.code, 'BRAINSTORM_VALIDATION_FAILED');
  assert.ok(
    thrown.errors.some((e) => /specMd/.test(e)),
    `error list should mention 'specMd'; got: ${JSON.stringify(thrown.errors)}`
  );
});

test('TC6: extractBrainstormResult — invalid spec (missing required fields) throws schema validation error', () => {
  let thrown = null;
  try {
    extractBrainstormResult(sdkInvalidSpec, { warn: () => {} });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(thrown.code, 'BRAINSTORM_VALIDATION_FAILED');
  assert.ok(
    thrown.errors.some((e) => /goal|target_files|acceptance_criteria/.test(e)),
    `error list should mention a missing required field; got: ${JSON.stringify(thrown.errors)}`
  );
});

test('TC7: extractBrainstormResult — extra top-level fields tolerated', () => {
  // Extra fields beyond spec/specMd should not cause validation failure.
  // The contract requires spec + specMd; extra keys are silently ignored.
  const out = extractBrainstormResult(sdkExtraTopLevel, { warn: () => {} });
  assert.deepStrictEqual(out.spec, validSpec);
  assert.strictEqual(out.specMd, '# Ok');
});

test('TC8: extractBrainstormResult — no structured_output throws BRAINSTORM_VALIDATION_FAILED', () => {
  let thrown = null;
  try {
    extractBrainstormResult(sdkNoStructured, { warn: () => {} });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown !== null, 'must throw on null structured_output');
  assert.strictEqual(thrown.code, 'BRAINSTORM_VALIDATION_FAILED');
});

// ── Tests: TC9–TC16 (Brainstormer method surface) ────────────────────────

test('TC9: initialize(userInput) with MOCK_SDK_VALID returns {spec, specMd, sessionMeta} where spec deepEquals validSpec, specMd is the fixture string, and sessionMeta.mode === "initialize" and sessionMeta.sessionId === "mock-sid"', async () => {
  const sm = makeMockSessionManager(MOCK_SDK_VALID);
  const logger = makeMockLogger();
  const tokenTracker = makeMockTokenTracker();
  const brainstormer = new Brainstormer(sm, logger, tokenTracker);

  const result = await brainstormer.initialize('Add a foo subcommand');

  assert.ok(result && typeof result === 'object', 'must return an object');
  assert.deepStrictEqual(result.spec, validSpec, 'spec must deepEqual validSpec');
  assert.strictEqual(result.specMd, '# Foo\n\nThis ships foo.', 'specMd must be the fixture string');
  assert.ok(result.sessionMeta && typeof result.sessionMeta === 'object', 'sessionMeta must be an object');
  assert.strictEqual(result.sessionMeta.mode, 'initialize', 'sessionMeta.mode must be "initialize"');
  assert.strictEqual(result.sessionMeta.sessionId, 'mock-sid', 'sessionMeta.sessionId must be "mock-sid"');
});

test('TC10: initialize(userInput) with MOCK_SDK_MISSING_REQUIRED rejects with err.code === BRAINSTORM_VALIDATION_FAILED', async () => {
  const sm = makeMockSessionManager(MOCK_SDK_MISSING_REQUIRED);
  const logger = makeMockLogger();
  const tokenTracker = makeMockTokenTracker();
  const brainstormer = new Brainstormer(sm, logger, tokenTracker);

  let thrown = null;
  try {
    await brainstormer.initialize('Add a foo subcommand');
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(
    thrown.code,
    'BRAINSTORM_VALIDATION_FAILED',
    `expected BRAINSTORM_VALIDATION_FAILED, got: ${thrown.code}`
  );
});

test('TC11: initialize(userInput) with MOCK_SDK_WRONG_TYPE rejects with err.code === BRAINSTORM_VALIDATION_FAILED', async () => {
  const sm = makeMockSessionManager(MOCK_SDK_WRONG_TYPE);
  const logger = makeMockLogger();
  const tokenTracker = makeMockTokenTracker();
  const brainstormer = new Brainstormer(sm, logger, tokenTracker);

  let thrown = null;
  try {
    await brainstormer.initialize('Add a foo subcommand');
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(
    thrown.code,
    'BRAINSTORM_VALIDATION_FAILED',
    `expected BRAINSTORM_VALIDATION_FAILED, got: ${thrown.code}`
  );
});

test('TC12: initialize(userInput) with MOCK_SDK_EXTRA_FIELD resolves (extra fields tolerated) and returns {spec, specMd, sessionMeta}', async () => {
  const sm = makeMockSessionManager(MOCK_SDK_EXTRA_FIELD);
  const logger = makeMockLogger();
  const tokenTracker = makeMockTokenTracker();
  const brainstormer = new Brainstormer(sm, logger, tokenTracker);

  const result = await brainstormer.initialize('Add a foo subcommand');

  assert.ok(result && typeof result === 'object', 'must return an object');
  assert.deepStrictEqual(result.spec, validSpec, 'spec must deepEqual validSpec');
  assert.strictEqual(result.specMd, '# Extra fields tolerated', 'specMd must be the fixture string');
  assert.ok(result.sessionMeta && typeof result.sessionMeta === 'object', 'sessionMeta must be an object');
  assert.strictEqual(result.sessionMeta.mode, 'initialize', 'sessionMeta.mode must be "initialize"');
  assert.strictEqual(result.sessionMeta.sessionId, 'mock-sid', 'sessionMeta.sessionId must be "mock-sid"');
});

test('TC13: revise(validSpec, feedback, "regenerate") with MOCK_SDK_VALID returns sessionMeta.mode === "regenerate"', async () => {
  const sm = makeMockSessionManager(MOCK_SDK_VALID);
  const logger = makeMockLogger();
  const tokenTracker = makeMockTokenTracker();
  const brainstormer = new Brainstormer(sm, logger, tokenTracker);

  const result = await brainstormer.revise(validSpec, 'tighten constraints', 'regenerate');

  assert.ok(result && typeof result === 'object', 'must return an object');
  assert.strictEqual(result.sessionMeta.mode, 'regenerate', 'sessionMeta.mode must be "regenerate"');
});

test('TC14: revise(validSpec, feedback, "edit") with MOCK_SDK_VALID returns sessionMeta.mode === "edit"', async () => {
  const sm = makeMockSessionManager(MOCK_SDK_VALID);
  const logger = makeMockLogger();
  const tokenTracker = makeMockTokenTracker();
  const brainstormer = new Brainstormer(sm, logger, tokenTracker);

  const result = await brainstormer.revise(validSpec, 'tighten constraints', 'edit');

  assert.ok(result && typeof result === 'object', 'must return an object');
  assert.strictEqual(result.sessionMeta.mode, 'edit', 'sessionMeta.mode must be "edit"');
});

test('TC15: revise(validSpec, feedback, "append") with MOCK_SDK_VALID returns sessionMeta.mode === "append"', async () => {
  const sm = makeMockSessionManager(MOCK_SDK_VALID);
  const logger = makeMockLogger();
  const tokenTracker = makeMockTokenTracker();
  const brainstormer = new Brainstormer(sm, logger, tokenTracker);

  const result = await brainstormer.revise(validSpec, 'tighten constraints', 'append');

  assert.ok(result && typeof result === 'object', 'must return an object');
  assert.strictEqual(result.sessionMeta.mode, 'append', 'sessionMeta.mode must be "append"');
});

test('TC16: revise(validSpec, feedback, "unknown") rejects with err.code === BRAINSTORM_INVALID_MODE', async () => {
  const sm = makeMockSessionManager(MOCK_SDK_VALID);
  const logger = makeMockLogger();
  const tokenTracker = makeMockTokenTracker();
  const brainstormer = new Brainstormer(sm, logger, tokenTracker);

  let thrown = null;
  try {
    await brainstormer.revise(validSpec, 'tighten constraints', 'unknown');
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(
    thrown.code,
    'BRAINSTORM_INVALID_MODE',
    `expected BRAINSTORM_INVALID_MODE, got: ${thrown.code}`
  );
});

// ── SDK fixtures for the elicitation methods (proposeQuestions/proposeFollowups) ──

const MOCK_PQ_VALID = {
  structured_output: {
    restatement: { paraphrase: 'You want a foo subcommand', evidence: ['src/cli/index.js'], unknowns: ['flag set'] },
    questions: [
      { id: 'q1', question: 'Low?', premise: 'p1', category: 'ambiguity', importance: 1 },
      { id: 'q2', question: 'High?', premise: 'p2', category: 'boundary', importance: 9 },
      { id: 'q3', question: 'Mid?', premise: 'p3', category: 'non-goal', importance: 5 },
    ],
    assessedComplexity: 'medium',
  },
};

// 6 questions (> default cap 5) to exercise rank-DESC + cap + omittedCount.
const MOCK_PQ_OVERCAP = {
  structured_output: {
    restatement: { paraphrase: 'X', evidence: [], unknowns: [] },
    questions: Array.from({ length: 6 }, (_, i) => ({
      id: `q${i}`, question: `Q${i}?`, premise: 'p', category: 'ambiguity', importance: i,
    })),
    assessedComplexity: 'large',
  },
};

const MOCK_PQ_INVALID = { structured_output: { notAQuestionSet: true } };

const MOCK_PF_VALID = {
  structured_output: {
    done: false,
    integrationNote: 'Given your answers, you want Y',
    questions: [
      { id: 'f1', question: 'FA?', premise: 'p', category: 'boundary', importance: 2 },
      { id: 'f2', question: 'FB?', premise: 'p', category: 'failure-scenario', importance: 8 },
    ],
  },
};

const MOCK_PF_INVALID = { structured_output: { note: 'no done/questions' } };

// A tokenTracker that records whether recordSession ran AND the mode it was
// called with — for the record-usage-BEFORE-extract ordering invariant the
// shared scaffold preserves, plus the per-caller mode label threading.
function makeOrderTrackingTokenTracker() {
  const calls = { recorded: false, mode: undefined };
  return {
    tracker: { async recordSession(_name, _role, _result, opts) { calls.recorded = true; calls.mode = opts?.mode; } },
    calls,
  };
}

test('TC17: proposeQuestions(MOCK_PQ_VALID) returns restatement + importance-DESC questions + omittedCount 0', async () => {
  const brainstormer = new Brainstormer(makeMockSessionManager(MOCK_PQ_VALID), makeMockLogger(), makeMockTokenTracker());
  const out = await brainstormer.proposeQuestions('add foo');
  assert.strictEqual(out.assessedComplexity, 'medium');
  assert.strictEqual(out.restatement.paraphrase, 'You want a foo subcommand');
  assert.strictEqual(out.omittedCount, 0, '3 questions < cap → nothing omitted');
  assert.strictEqual(out.questions[0].importance, 9, 'highest importance first');
  assert.ok(out.questions[0].importance >= out.questions[1].importance && out.questions[1].importance >= out.questions[2].importance, 'importance DESC');
});

test('TC18: proposeQuestions caps an over-cap list to maxQuestions and reports omittedCount', async () => {
  const brainstormer = new Brainstormer(makeMockSessionManager(MOCK_PQ_OVERCAP), makeMockLogger(), makeMockTokenTracker());
  const out = await brainstormer.proposeQuestions('big ask');
  assert.strictEqual(out.questions.length, 5, 'capped to default maxQuestions (5)');
  assert.strictEqual(out.omittedCount, 1, '6 proposed − 5 cap = 1 omitted');
  assert.strictEqual(out.questions[0].importance, 5, 'highest of the 6 kept first');
  assert.ok(!out.questions.some((q) => q.importance === 0), 'the lowest-importance question was dropped');
});

test('TC19: proposeQuestions rejects BRAINSTORM_VALIDATION_FAILED on invalid output', async () => {
  const brainstormer = new Brainstormer(makeMockSessionManager(MOCK_PQ_INVALID), makeMockLogger(), makeMockTokenTracker());
  let thrown = null;
  try { await brainstormer.proposeQuestions('x'); } catch (err) { thrown = err; }
  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(thrown.code, 'BRAINSTORM_VALIDATION_FAILED');
});

test('TC20: proposeFollowups(MOCK_PF_VALID) returns done + integrationNote + importance-DESC questions + omittedCount', async () => {
  const brainstormer = new Brainstormer(makeMockSessionManager(MOCK_PF_VALID), makeMockLogger(), makeMockTokenTracker());
  const out = await brainstormer.proposeFollowups('add foo', { paraphrase: 'p' }, [{ question: 'q', answer: 'a' }]);
  assert.strictEqual(out.done, false);
  assert.strictEqual(out.integrationNote, 'Given your answers, you want Y');
  assert.strictEqual(out.omittedCount, 0);
  assert.strictEqual(out.questions[0].importance, 8, 'highest importance first');
});

test('TC21: proposeFollowups rejects BRAINSTORM_VALIDATION_FAILED on invalid output', async () => {
  const brainstormer = new Brainstormer(makeMockSessionManager(MOCK_PF_INVALID), makeMockLogger(), makeMockTokenTracker());
  let thrown = null;
  try { await brainstormer.proposeFollowups('x', { paraphrase: 'p' }, []); } catch (err) { thrown = err; }
  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(thrown.code, 'BRAINSTORM_VALIDATION_FAILED');
});

test('TC22: proposeQuestions records token usage BEFORE extraction (recordSession ran even when extract throws)', async () => {
  const { tracker, calls } = makeOrderTrackingTokenTracker();
  const brainstormer = new Brainstormer(makeMockSessionManager(MOCK_PQ_INVALID), makeMockLogger(), tracker);
  let thrown = null;
  try { await brainstormer.proposeQuestions('x'); } catch (err) { thrown = err; }
  assert.ok(thrown !== null, 'must still throw on invalid output');
  assert.strictEqual(calls.recorded, true, 'recordSession must run before the extractor throws — the record-before-extract invariant');
  assert.strictEqual(calls.mode, 'propose-questions', 'usage recorded under the propose-questions mode label');
});

test('TC23: proposeFollowups records token usage BEFORE extraction (recordSession ran even when extract throws)', async () => {
  const { tracker, calls } = makeOrderTrackingTokenTracker();
  const brainstormer = new Brainstormer(makeMockSessionManager(MOCK_PF_INVALID), makeMockLogger(), tracker);
  let thrown = null;
  try { await brainstormer.proposeFollowups('x', { paraphrase: 'p' }, []); } catch (err) { thrown = err; }
  assert.ok(thrown !== null, 'must still throw on invalid output');
  assert.strictEqual(calls.recorded, true, 'recordSession must run before the extractor throws — the record-before-extract invariant');
  assert.strictEqual(calls.mode, 'propose-followups', 'usage recorded under the propose-followups mode label');
});

test('TC24: proposeQuestions honours a non-default style.maxQuestions (not a hardcoded cap)', async () => {
  const brainstormer = new Brainstormer(makeMockSessionManager(MOCK_PQ_OVERCAP), makeMockLogger(), makeMockTokenTracker());
  const out = await brainstormer.proposeQuestions('big ask', { style: { maxQuestions: 2 } });
  assert.strictEqual(out.questions.length, 2, 'capped to style.maxQuestions (2), not the default 5');
  assert.strictEqual(out.omittedCount, 4, '6 proposed − 2 cap = 4 omitted');
  assert.strictEqual(out.questions[0].importance, 5, 'highest of the 6 kept first');
});

test('TC25: proposeFollowups honours a non-default style.maxQuestions (not a hardcoded cap)', async () => {
  const brainstormer = new Brainstormer(makeMockSessionManager(MOCK_PF_VALID), makeMockLogger(), makeMockTokenTracker());
  const out = await brainstormer.proposeFollowups('x', { paraphrase: 'p' }, [], { style: { maxQuestions: 1 } });
  assert.strictEqual(out.questions.length, 1, 'capped to style.maxQuestions (1)');
  assert.strictEqual(out.omittedCount, 1, '2 proposed − 1 cap = 1 omitted');
  assert.strictEqual(out.questions[0].importance, 8, 'highest kept');
});

// ── Summary ─────────────────────────────────────────────────────────────

// Wait for all async tests (including TC9–TC25) to settle before printing.
Promise.all(allTests).then(() => {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount === 0 ? 0 : 1);
});
