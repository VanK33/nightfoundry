/**
 * test-planner-warn-rejected-wiring.js — End-to-end wiring tests for the
 * rejected-behavior warn gate in Planner.planMission().
 *
 * Tests that planMission() correctly wires extractRejectedPhrases() +
 * _warnIfRejectedBehavior() when specConstraints (string[], from
 * spec.json.constraints[]) is provided via the context argument.
 *
 * No live SDK calls are made — a fake sessionManager intercepts spawn()
 * and returns a structured_output containing a plan with a planted task.
 *
 * Run: node test/test-planner-warn-rejected-wiring.js
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

const PLANTED_TASK_ID = '001-001-001-001';

/**
 * Returns a fake sessionManager whose spawn() and spawnReusable() resolve with
 * a plan containing a single task with the given description.
 *
 * spawnReusable is needed because planMission() unconditionally takes the
 * reusable session path (it is the only planner path).
 */
function makeFakeSessionManager(taskDescription) {
  const fakeHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
  const fakeResult = {
    structured_output: {
      subMissions: [
        {
          id: '001-001',
          tasks: [
            { id: PLANTED_TASK_ID, description: taskDescription, targetFiles: [] },
          ],
        },
      ],
      milestones: [],
    },
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    total_cost_usd: 0,
  };

  // Fake reusable session returned by spawnReusable()
  const fakeReusableSession = {
    handle: fakeHandle,
    turnCount: 0,
    sendPrompt: async () => fakeResult,
  };

  return {
    spawn(opts) {
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
    spawnReusable(opts) {
      return fakeReusableSession;
    },
  };
}

/**
 * Returns a fake logger that captures warn() calls into `warnCapture`
 * and satisfies the remaining Planner constructor requirements.
 */
function makeFakeLoggerWithWarn(warnCapture) {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-wiring.jsonl',
      write: () => {},
      close: () => {},
    }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
    warn: (msg) => { warnCapture.push(msg); },
  };
}

// ── TC-WIR-1: planMission with matching task description emits warnings ──

await test('TC-WIR-1: planMission emits per-task and summary warn for matching task', async () => {
  const warnCapture = [];
  const planner = new Planner(
    // A 'Never ...' constraint: extractRejectedPhrases strips the marker, so
    // the phrase tokens are {modify, legacy, parser} and the matching task
    // description triggers the warn.
    makeFakeSessionManager('modify legacy parser module'),
    makeFakeLoggerWithWarn(warnCapture),
    { recordSession: async () => {} },
  );

  await planner.planMission('m1', '/tmp', {
    missionPlan: '...',
    maxTasksPerSubMission: 3,
    mode: 'auto',
    specTargetFiles: [],
    specConstraints: ['Never modify legacy parser'],
  });

  // Should have at least 2 warnings: one per-task and one summary
  assert.ok(
    warnCapture.length >= 2,
    `Expected at least 2 warn lines, got ${warnCapture.length}: ${JSON.stringify(warnCapture)}`,
  );

  const allWarns = warnCapture.join('\n');

  // Per-task warn line must name the planted task id
  const perTaskLine = warnCapture.find((w) => w.includes(PLANTED_TASK_ID));
  assert.ok(
    perTaskLine !== undefined,
    `Expected a per-task warn line naming task id "${PLANTED_TASK_ID}". Got:\n${allWarns}`,
  );

  // Per-task warn line must contain the rejected phrase (or key words of it)
  assert.ok(
    perTaskLine.includes('modify legacy parser') || perTaskLine.includes('legacy parser'),
    `Per-task warn line should reference the phrase "modify legacy parser". Got:\n${perTaskLine}`,
  );

  // Summary line must contain "1 task(s) flagged"
  const summaryLine = warnCapture.find((w) => w.includes('1 task(s) flagged'));
  assert.ok(
    summaryLine !== undefined,
    `Expected a summary warn line containing "1 task(s) flagged". Got:\n${allWarns}`,
  );
});

// ── TC-WIR-1b: REGRESSION — a "Do not ..." constraint fires end-to-end ──
//
// Before the marker-stripping fix, "Do not modify the legacy parser" tokenised
// to {do, not, modify, legacy, parser}; the token 'not' is itself a negation
// marker, so any task description matching it always self-suppressed and the
// warn never fired for the most common (do-not) constraint form. After the fix
// the marker is stripped (tokens = {modify, legacy, parser}), so a task that
// proposes "modify the legacy parser" is correctly flagged. This test pins the
// fix end-to-end through planMission().

await test('TC-WIR-1b: planMission flags a task for a "Do not ..." constraint (marker-stripping regression)', async () => {
  const warnCapture = [];
  const planner = new Planner(
    // Task description proposes the rejected behaviour, with NO negation marker.
    makeFakeSessionManager('modify the legacy parser to add a feature'),
    makeFakeLoggerWithWarn(warnCapture),
    { recordSession: async () => {} },
  );

  await planner.planMission('m1', '/tmp', {
    missionPlan: '...',
    maxTasksPerSubMission: 3,
    mode: 'auto',
    specTargetFiles: [],
    specConstraints: ['Do not modify the legacy parser'],
  });

  const allWarns = warnCapture.join('\n');

  // Per-task warn line must name the planted task id (proves the gate fired).
  const perTaskLine = warnCapture.find((w) => w.includes(PLANTED_TASK_ID));
  assert.ok(
    perTaskLine !== undefined,
    `Expected the "Do not ..." constraint to flag the matching task ${PLANTED_TASK_ID}. ` +
    `If this is empty, the negative marker is leaking into tokens again. Got:\n${allWarns}`,
  );

  // Per-task warn line must reference the stripped phrase (behaviour words only).
  assert.ok(
    perTaskLine.includes('modify the legacy parser') || perTaskLine.includes('legacy parser'),
    `Per-task warn line should reference the phrase "modify the legacy parser". Got:\n${perTaskLine}`,
  );

  // Summary line confirms exactly one task was flagged.
  const summaryLine = warnCapture.find((w) => w.includes('1 task(s) flagged'));
  assert.ok(
    summaryLine !== undefined,
    `Expected a summary warn line containing "1 task(s) flagged". Got:\n${allWarns}`,
  );
});

// ── TC-WIR-2: planMission with empty specConstraints emits zero rejected-behavior warnings ──

await test('TC-WIR-2: planMission with specConstraints: [] produces zero rejected-behavior warnings', async () => {
  const warnCapture = [];
  const planner = new Planner(
    makeFakeSessionManager('never modify legacy parser module'),
    makeFakeLoggerWithWarn(warnCapture),
    { recordSession: async () => {} },
  );

  await planner.planMission('m1', '/tmp', {
    missionPlan: '...',
    maxTasksPerSubMission: 3,
    mode: 'auto',
    specTargetFiles: [],
    specConstraints: [],
  });

  // No warn lines should mention rejected behavior or flagged tasks
  const rejectedWarns = warnCapture.filter(
    (w) => w.includes('task(s) flagged') || w.includes('rejected behavior') || w.includes('DO-NOT'),
  );
  assert.equal(
    rejectedWarns.length,
    0,
    `Expected zero rejected-behavior warnings with empty specConstraints, got: ${JSON.stringify(rejectedWarns)}`,
  );
});

// ── TC-WIR-3: negation guard suppresses warn when task description negates the phrase ──

await test('TC-WIR-3: negation guard suppresses warn for "never modify legacy parser without breaking the build"', async () => {
  const warnCapture = [];
  const planner = new Planner(
    // Task contains all phrase tokens (never/modify/legacy/parser) but the
    // negation marker 'without' sits within 6 word-positions → suppressed.
    makeFakeSessionManager('never modify legacy parser without breaking the build'),
    makeFakeLoggerWithWarn(warnCapture),
    { recordSession: async () => {} },
  );

  await planner.planMission('m1', '/tmp', {
    missionPlan: '...',
    maxTasksPerSubMission: 3,
    mode: 'auto',
    specTargetFiles: [],
    specConstraints: ['Never modify legacy parser'],
  });

  // No rejected-behavior warnings should be emitted
  const rejectedWarns = warnCapture.filter(
    (w) => w.includes('task(s) flagged') || w.includes('rejected behavior') || w.includes('DO-NOT'),
  );
  assert.equal(
    rejectedWarns.length,
    0,
    `Expected zero rejected-behavior warnings due to negation guard, got: ${JSON.stringify(rejectedWarns)}`,
  );
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
