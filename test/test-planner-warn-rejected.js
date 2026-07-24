/**
 * test-planner-warn-rejected.js — Unit tests for Planner._warnIfRejectedBehavior
 *
 * Exercises the rejected-behavior warning method directly, covering:
 *   TC-WRB-1  graceful no-op on undefined/null inputs
 *   TC-WRB-2  per-task + summary warnings when all phrase tokens appear
 *   TC-WRB-3  suppression when a token sits within the 6-word negation window
 *   TC-WRB-4  no warning when one phrase token is missing from the description
 *   TC-WRB-5  iterates replacementTasks and newTasks; summary count is aggregate
 *   TC-WRB-6  callerLabel string appears verbatim in both warn message types
 *
 * Run: node test/test-planner-warn-rejected.js
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

/** Minimal session manager — never actually called in these tests */
function makeFakeSessionManager() {
  return {
    spawn() {
      const fakeHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
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
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
  };
}

/**
 * Returns a fake logger whose warn(msg) appends to the supplied array.
 * All other logger methods are no-ops satisfying the Planner constructor.
 */
function makeFakeLoggerWithWarn(warnMessages) {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-warn-rejected.jsonl',
      write: () => {},
      close: () => {},
    }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
    warn: (msg) => { warnMessages.push(msg); },
  };
}

// ── TC-WRB-1: swallow on undefined plan and undefined rejectedPhrases ─────────

await test('TC-WRB-1: no throw and no warnings for undefined plan and undefined rejectedPhrases', async () => {
  const warnMessages = [];
  const planner = new Planner(
    makeFakeSessionManager(),
    makeFakeLoggerWithWarn(warnMessages),
    { recordSession: async () => {} },
  );

  // None of these calls should throw or emit warnings
  planner._warnIfRejectedBehavior(undefined, undefined, 'wrb1-label');
  planner._warnIfRejectedBehavior(null, null, 'wrb1-label');
  planner._warnIfRejectedBehavior({}, undefined, 'wrb1-label');
  planner._warnIfRejectedBehavior({ subMissions: [] }, [], 'wrb1-label');

  assert.strictEqual(
    warnMessages.length,
    0,
    `Expected 0 warnings, got ${warnMessages.length}: ${warnMessages.join(' | ')}`,
  );
});

// ── TC-WRB-2: flags a subMissions task when all tokens appear ─────────────────

await test('TC-WRB-2: per-task warn names task id and phrase; summary contains "1 task(s) flagged"', async () => {
  const warnMessages = [];
  const planner = new Planner(
    makeFakeSessionManager(),
    makeFakeLoggerWithWarn(warnMessages),
    { recordSession: async () => {} },
  );

  const plan = {
    subMissions: [
      {
        tasks: [
          { id: 'wrb2-task-001', description: 'Use the deprecated api to fetch data' },
        ],
      },
    ],
  };
  const rejectedPhrases = [
    { phrase: 'use deprecated api', tokens: new Set(['use', 'deprecated', 'api']) },
  ];

  planner._warnIfRejectedBehavior(plan, rejectedPhrases, 'wrb2-caller');

  // Expect at least a per-task warning and a summary warning
  assert.ok(
    warnMessages.length >= 2,
    `Expected at least 2 warnings, got ${warnMessages.length}: ${warnMessages.join(' | ')}`,
  );

  const allWarns = warnMessages.join('\n');

  assert.ok(
    allWarns.includes('wrb2-task-001'),
    `Per-task warning should reference task id 'wrb2-task-001'. Warnings:\n${allWarns}`,
  );
  assert.ok(
    allWarns.includes('use deprecated api'),
    `Per-task warning should include phrase 'use deprecated api'. Warnings:\n${allWarns}`,
  );
  assert.ok(
    allWarns.includes('1 task(s) flagged'),
    `Summary warning should contain '1 task(s) flagged'. Warnings:\n${allWarns}`,
  );
});

// ── TC-WRB-3: NOT flagged when token is within 6-word negation window ─────────

await test('TC-WRB-3: no warning when phrase tokens are within 6-word negation window (one assertion per marker)', async () => {
  const rejectedPhrases = [
    { phrase: 'use deprecated api', tokens: new Set(['use', 'deprecated', 'api']) },
  ];

  /**
   * Asserts that the given description produces 0 warnings, illustrating
   * that the negation marker suppresses the phrase match.
   */
  function assertNoWarn(description, markerName) {
    const warnMessages = [];
    const planner = new Planner(
      makeFakeSessionManager(),
      makeFakeLoggerWithWarn(warnMessages),
      { recordSession: async () => {} },
    );
    const plan = {
      subMissions: [{ tasks: [{ id: 'wrb3-task', description }] }],
    };
    planner._warnIfRejectedBehavior(plan, rejectedPhrases, 'wrb3-caller');
    assert.strictEqual(
      warnMessages.length,
      0,
      `Marker '${markerName}': expected 0 warnings for desc "${description}", got ${warnMessages.length}: ${warnMessages.join(' | ')}`,
    );
  }

  // 'not' — single-word negation marker
  // words: ["do","not","use","deprecated","api","here"] → "not"@1, "use"@2 → |2-1|=1 ≤ 6
  assertNoWarn('do not use deprecated api here', 'not');

  // 'n\'t' — contraction; "n't" tokenises to ["n","t"] under \W+ split,
  // so suppression is provided by the adjacent "not" word in the phrase.
  // words: ["should","not","n","t","use","deprecated","api"] → "not"@1, "use"@4 → |4-1|=3 ≤ 6
  assertNoWarn("should not n't use deprecated api", "n't");

  // 'avoid' — single-word negation marker
  // words: ["please","avoid","use","of","deprecated","api"] → "avoid"@1, "use"@2 → |2-1|=1 ≤ 6
  assertNoWarn('please avoid use of deprecated api', 'avoid');

  // 'without' — single-word negation marker
  // words: ["implement","without","use","of","deprecated","api"] → "without"@1, "use"@2 → |2-1|=1 ≤ 6
  assertNoWarn('implement without use of deprecated api', 'without');

  // 'instead of' — multi-word negation marker
  // words: ["use","new","sdk","instead","of","deprecated","api","here"]
  // "instead"@3 + words[4]="of" → negation@3; "use"@0 → |0-3|=3 ≤ 6
  assertNoWarn('use new sdk instead of deprecated api here', 'instead of');

  // 'rather than' — multi-word negation marker
  // words: ["use","deprecated","api","rather","than","legacy","one"]
  // "rather"@3 + words[4]="than" → negation@3; "use"@0 → |0-3|=3 ≤ 6
  assertNoWarn('use deprecated api rather than legacy one', 'rather than');

  // 'differs from' — multi-word negation marker
  // words: ["this","differs","from","use","of","deprecated","api"]
  // "differs"@1 + words[2]="from" → negation@1; "use"@3 → |3-1|=2 ≤ 6
  assertNoWarn('this differs from use of deprecated api', 'differs from');

  // 'unlike' — single-word negation marker
  // words: ["unlike","use","of","deprecated","api"] → "unlike"@0, "use"@1 → |1-0|=1 ≤ 6
  assertNoWarn('unlike use of deprecated api', 'unlike');

  // 'rejected' — single-word negation marker
  // words: ["rejected","use","of","deprecated","api","behavior"] → "rejected"@0, "use"@1 → |1-0|=1 ≤ 6
  assertNoWarn('rejected use of deprecated api behavior', 'rejected');
});

// ── TC-WRB-4: NOT flagged when one phrase token is missing ────────────────────

await test('TC-WRB-4: no warning when one of the phrase tokens is absent from the description', async () => {
  const warnMessages = [];
  const planner = new Planner(
    makeFakeSessionManager(),
    makeFakeLoggerWithWarn(warnMessages),
    { recordSession: async () => {} },
  );

  const plan = {
    subMissions: [
      {
        tasks: [
          // "deprecated" is absent — only "use" and "api" appear
          { id: 'wrb4-task-001', description: 'Use the new api to fetch data efficiently' },
        ],
      },
    ],
  };
  const rejectedPhrases = [
    { phrase: 'use deprecated api', tokens: new Set(['use', 'deprecated', 'api']) },
  ];

  planner._warnIfRejectedBehavior(plan, rejectedPhrases, 'wrb4-caller');

  assert.strictEqual(
    warnMessages.length,
    0,
    `Expected 0 warnings when 'deprecated' token is absent, got ${warnMessages.length}: ${warnMessages.join(' | ')}`,
  );
});

// ── TC-WRB-5: iterates replacementTasks and newTasks; aggregate summary count ─

await test('TC-WRB-5: iterates replacementTasks and newTasks; summary count reflects total across shapes', async () => {
  const warnMessages = [];
  const planner = new Planner(
    makeFakeSessionManager(),
    makeFakeLoggerWithWarn(warnMessages),
    { recordSession: async () => {} },
  );

  const plan = {
    // subMissions intentionally omitted (or empty) — matches come from the other two shapes
    replacementTasks: [
      { id: 'wrb5-replacement-001', description: 'Use the deprecated api for replacement logic' },
    ],
    newTasks: [
      { id: 'wrb5-new-001', description: 'Use this deprecated api in new task flow' },
    ],
  };
  const rejectedPhrases = [
    { phrase: 'use deprecated api', tokens: new Set(['use', 'deprecated', 'api']) },
  ];

  planner._warnIfRejectedBehavior(plan, rejectedPhrases, 'wrb5-caller');

  // 2 per-task warnings + 1 summary = at least 3 warn calls
  assert.ok(
    warnMessages.length >= 3,
    `Expected at least 3 warnings (2 per-task + 1 summary), got ${warnMessages.length}: ${warnMessages.join(' | ')}`,
  );

  const allWarns = warnMessages.join('\n');

  assert.ok(
    allWarns.includes('wrb5-replacement-001'),
    `Should warn about replacementTasks entry. Warnings:\n${allWarns}`,
  );
  assert.ok(
    allWarns.includes('wrb5-new-001'),
    `Should warn about newTasks entry. Warnings:\n${allWarns}`,
  );
  assert.ok(
    allWarns.includes('2 task(s) flagged'),
    `Summary should reflect aggregate count '2 task(s) flagged'. Warnings:\n${allWarns}`,
  );
});

// ── TC-WRB-6: callerLabel appears verbatim in both per-task and summary warns ─

await test('TC-WRB-6: callerLabel string appears verbatim in per-task and summary warn messages', async () => {
  const warnMessages = [];
  const planner = new Planner(
    makeFakeSessionManager(),
    makeFakeLoggerWithWarn(warnMessages),
    { recordSession: async () => {} },
  );

  const callerLabel = 'my-custom-caller-label-xyz';
  const plan = {
    subMissions: [
      {
        tasks: [
          { id: 'wrb6-task-001', description: 'Use the deprecated api here for testing' },
        ],
      },
    ],
  };
  const rejectedPhrases = [
    { phrase: 'use deprecated api', tokens: new Set(['use', 'deprecated', 'api']) },
  ];

  planner._warnIfRejectedBehavior(plan, rejectedPhrases, callerLabel);

  assert.ok(
    warnMessages.length >= 2,
    `Expected at least 2 warnings, got ${warnMessages.length}`,
  );

  // per-task warning must contain callerLabel
  const perTaskWarn = warnMessages.find((m) => m.includes('wrb6-task-001'));
  assert.ok(
    perTaskWarn !== undefined,
    `Expected a per-task warning referencing task 'wrb6-task-001'. Warnings:\n${warnMessages.join('\n')}`,
  );
  assert.ok(
    perTaskWarn.includes(callerLabel),
    `Per-task warning must include callerLabel '${callerLabel}'. Got: ${perTaskWarn}`,
  );

  // summary warning must contain callerLabel
  const summaryWarn = warnMessages.find((m) => m.includes('task(s) flagged'));
  assert.ok(
    summaryWarn !== undefined,
    `Expected a summary warning containing 'task(s) flagged'. Warnings:\n${warnMessages.join('\n')}`,
  );
  assert.ok(
    summaryWarn.includes(callerLabel),
    `Summary warning must include callerLabel '${callerLabel}'. Got: ${summaryWarn}`,
  );
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
