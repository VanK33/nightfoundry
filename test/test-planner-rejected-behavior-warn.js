/**
 * test-planner-rejected-behavior-warn.js — Tests for extractRejectedPhrases and
 * Planner._warnIfRejectedBehavior.
 *
 * No Claude auth, no SDK. Pure deterministic assertions.
 * Run: node test/test-planner-rejected-behavior-warn.js
 */
import assert from 'assert';
import { extractRejectedPhrases } from '../src/orchestrator/core/scope-parser.js';
import { Planner } from '../src/orchestrator/agents/planner.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

// ── Fake logger factory (warn-capturing) ─────────────────────────────
//
// The `warn` function closes over the module-level `warnLines` binding so that
// assigning `warnLines = []` inside a test resets the capture array for the
// next assertion.

let warnLines = [];

function makeFakeLogger() {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-planner-rej-warn.jsonl',
      write: () => {},
      close: () => {},
    }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
    warn: (msg) => { warnLines.push(msg); },
  };
}

// Construct one Planner for the WARN test group.
// The fake session manager is never actually invoked by the warn-only helper.
const planner = new Planner(
  { spawn: () => {} },
  makeFakeLogger(),
  { recordSession: async () => {} },
);

// Canonical negative-marker constraint for the EXTRACT test group.
// extractRejectedPhrases now takes a string[] (spec.json.constraints[]).
const SPEC_TC1 = ['Do not modify the legacy parser'];

// Fixture for the WARN test group. extractRejectedPhrases strips the negative
// marker before tokenising, so both 'Never ...' and 'Do not ...' yield the
// behaviour-word tokens {modify, legacy, parser} (the marker words never leak
// into tokens — see TC-DONOT-WARN below, which pins the do-not form
// specifically). The rejected-behavior MATCHER (_warnIfRejectedBehavior, out
// of scope, unchanged) requires every phrase token to appear in the task
// description and suppresses matches sitting within 6 word-positions of a
// negation marker ('not', "n't", 'avoid', 'without', 'unlike', 'rejected',
// 'instead of', 'rather than', 'differs from').
const WARN_CONSTRAINT = 'Never modify the legacy parser';
const extractedPhrasesFromTC1 = extractRejectedPhrases([WARN_CONSTRAINT]);

// Phrases extracted from a "Do not ..." constraint — used by the do-not
// regression test. After the marker-stripping fix these tokens are
// {modify, legacy, parser} (no do/not), identical to the 'Never' fixture.
const doNotPhrases = extractRejectedPhrases(['Do not modify the legacy parser']);

// ─────────────────────────────────────────────────────────────────────

test('TC-EXTRACT-1: distinctive phrase tokens exclude stopwords', () => {
  const phrases = extractRejectedPhrases(SPEC_TC1);
  assert.ok(phrases.length >= 1, `Expected at least 1 phrase, got ${phrases.length}`);
  const entry = phrases[0];
  assert.ok(entry.tokens instanceof Set, 'tokens must be a Set');
  assert.ok(entry.tokens.has('modify'), "tokens must contain 'modify'");
  assert.ok(entry.tokens.has('legacy'), "tokens must contain 'legacy'");
  assert.ok(entry.tokens.has('parser'), "tokens must contain 'parser'");
  const STOPWORDS = [
    'the', 'a', 'an', 'in', 'on', 'of', 'for', 'and', 'or',
    'to', 'is', 'it', 'with', 'by', 'at', 'from', 'as',
  ];
  for (const sw of STOPWORDS) {
    assert.ok(!entry.tokens.has(sw), `tokens must NOT contain stopword '${sw}'`);
  }
});

test('TC-EXTRACT-2: skips phrase with fewer than 2 distinctive content tokens', () => {
  // A negative-marker constraint that yields a single token after STOPWORD
  // filtering → dropped by the >=2-tokens rule.
  const phrases = extractRejectedPhrases(['Never']);
  assert.strictEqual(
    phrases.length,
    0,
    `Expected 0 phrases (fewer than 2 content tokens), got ${phrases.length}: ${JSON.stringify(phrases)}`,
  );
});

test('TC-EXTRACT-3: post-em-dash rationale excluded from phrase and tokens', () => {
  const phrases = extractRejectedPhrases(['Do not modify legacy parser — rationale here']);
  assert.ok(phrases.length >= 1, `Expected at least 1 phrase, got ${phrases.length}`);
  const entry = phrases[0];
  assert.ok(
    entry.tokens.has('modify') && entry.tokens.has('legacy') && entry.tokens.has('parser'),
    `tokens must contain the core terms modify/legacy/parser, got: ${JSON.stringify([...entry.tokens])}`,
  );
  assert.ok(
    !entry.tokens.has('rationale'),
    "tokens must NOT contain 'rationale' — post-em-dash text must be excluded",
  );
  assert.ok(
    !entry.phrase.includes('rationale'),
    `phrase must not include post-em-dash rationale, got '${entry.phrase}'`,
  );
});

test('TC-WARN-1: violating task emits per-task warn naming id + phrase, plus summary with 1 task(s) flagged', () => {
  warnLines = [];
  const plan = {
    subMissions: [{
      tasks: [{ id: 't1', description: 'never modify the legacy parser to fix a bug' }],
    }],
  };
  planner._warnIfRejectedBehavior(plan, extractedPhrasesFromTC1, 'planMission');

  const phraseStr = extractedPhrasesFromTC1[0].phrase;
  const taskWarns = warnLines.filter(
    (l) => typeof l === 'string' && l.includes('t1') && l.includes(phraseStr),
  );
  assert.ok(
    taskWarns.length >= 1,
    `Expected a per-task warn containing 't1' and '${phraseStr}'. Got: ${JSON.stringify(warnLines)}`,
  );
  const summaryWarns = warnLines.filter(
    (l) => typeof l === 'string' && l.includes('1 task(s) flagged'),
  );
  assert.ok(
    summaryWarns.length >= 1,
    `Expected a summary warn containing '1 task(s) flagged'. Got: ${JSON.stringify(warnLines)}`,
  );
});

test('TC-DONOT-WARN: REGRESSION — a "Do not ..." constraint flags a matching task (marker stripped, no phantom self-suppression)', () => {
  // Before the marker-stripping fix, the token 'not' leaked into the phrase
  // and acted as a negation marker, so a "Do not ..." constraint could never
  // flag any task. After the fix, tokens are {modify, legacy, parser} and a
  // task proposing that behaviour (with no negation marker) is flagged.
  warnLines = [];
  const plan = {
    subMissions: [{
      tasks: [{ id: 'dn1', description: 'modify the legacy parser to add a feature' }],
    }],
  };
  planner._warnIfRejectedBehavior(plan, doNotPhrases, 'planMission');

  const phraseStr = doNotPhrases[0].phrase;
  const taskWarns = warnLines.filter(
    (l) => typeof l === 'string' && l.includes('dn1') && l.includes(phraseStr),
  );
  assert.ok(
    taskWarns.length >= 1,
    `Expected a per-task warn for the do-not constraint containing 'dn1' and '${phraseStr}'. ` +
    `If empty, the negative marker is leaking into tokens again. Got: ${JSON.stringify(warnLines)}`,
  );
  const summaryWarns = warnLines.filter(
    (l) => typeof l === 'string' && l.includes('1 task(s) flagged'),
  );
  assert.ok(
    summaryWarns.length >= 1,
    `Expected a summary warn containing '1 task(s) flagged'. Got: ${JSON.stringify(warnLines)}`,
  );
});

test('TC-WARN-2: negation guard via "instead of" within 6 word-positions suppresses match', () => {
  warnLines = [];
  const plan = {
    subMissions: [{
      tasks: [{
        id: 't2',
        description: 'never modify legacy parser instead of the new module',
      }],
    }],
  };
  planner._warnIfRejectedBehavior(plan, extractedPhrasesFromTC1, 'planMission');

  const rejectedWarns = warnLines.filter(
    (l) => typeof l === 'string' && (l.includes('t2') || l.includes('flagged')),
  );
  assert.strictEqual(
    rejectedWarns.length,
    0,
    `Expected 0 rejected-behavior warnings (negation guard must suppress). Got: ${JSON.stringify(rejectedWarns)}`,
  );
});

test('TC-WARN-3: task with no matching tokens is not flagged', () => {
  warnLines = [];
  const plan = {
    subMissions: [{ tasks: [{ id: 't3', description: 'update the README' }] }],
  };
  planner._warnIfRejectedBehavior(plan, extractedPhrasesFromTC1, 'planMission');

  assert.strictEqual(
    warnLines.length,
    0,
    `Expected 0 warns for unrelated task. Got: ${JSON.stringify(warnLines)}`,
  );
});

test('TC-WARN-4: never throws for null/undefined inputs; plan object unchanged after call', () => {
  warnLines = [];

  assert.doesNotThrow(
    () => planner._warnIfRejectedBehavior(null, null, 'planMission'),
    'should not throw when plan is null and rejectedPhrases is null',
  );
  assert.doesNotThrow(
    () => planner._warnIfRejectedBehavior(undefined, undefined, 'planMission'),
    'should not throw when plan is undefined and rejectedPhrases is undefined',
  );

  const plan = {
    subMissions: [{ tasks: [{ id: 't1', description: 'modify legacy parser to fix a bug' }] }],
  };
  const original = JSON.parse(JSON.stringify(plan));
  planner._warnIfRejectedBehavior(plan, extractedPhrasesFromTC1, 'planMission');
  assert.deepStrictEqual(
    plan,
    original,
    'plan object must be deeply equal to its pre-call snapshot (no mutations)',
  );
});

test('TC-WARN-5: empty rejectedPhrases array is a no-op producing zero warns', () => {
  warnLines = [];
  const plan = {
    subMissions: [{ tasks: [{ id: 't1', description: 'modify legacy parser to fix a bug' }] }],
  };
  planner._warnIfRejectedBehavior(plan, [], 'planMission');

  assert.strictEqual(
    warnLines.length,
    0,
    `Expected 0 warns for empty rejectedPhrases. Got: ${JSON.stringify(warnLines)}`,
  );
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\nFAIL ${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
