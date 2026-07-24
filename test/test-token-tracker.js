/**
 * test-token-tracker.js — Unit tests for TokenTracker.getUsageSince().
 *
 * Uses the TokenTracker prototype mock pattern to inject 5 fixture sessions
 * with known token/cost values without touching the filesystem.
 *
 * Test cases:
 *   TC1: getUsageSince(0) deep-equals getTotalUsage() (aggregates all 5)
 *   TC2: getUsageSince(3) aggregates only sessions at indices 3 and 4
 *   TC3: getUsageSince(5) returns sessionCount=0 and all-zero totals
 *
 * Run: node test/test-token-tracker.js
 */
import assert from 'assert';
import { TokenTracker } from '../src/orchestrator/infra/token-tracker.js';

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

// ---------- Fixtures: 5 sessions with known token/cost values ----------

const FIXTURE_SESSIONS = [
  {
    name: 'session-0',
    type: 'planner',
    timestamp: '2026-04-11T00:00:00Z',
    inputTokens: 100,
    outputTokens: 50,
    cacheCreation: 10,
    cacheRead: 5,
    totalCostUsd: 0.01,
    systemPromptTokens: 0,
    toolCallCount: 1,
  },
  {
    name: 'session-1',
    type: 'executor',
    timestamp: '2026-04-11T01:00:00Z',
    inputTokens: 200,
    outputTokens: 100,
    cacheCreation: 20,
    cacheRead: 10,
    totalCostUsd: 0.02,
    systemPromptTokens: 0,
    toolCallCount: 2,
  },
  {
    name: 'session-2',
    type: 'verifier',
    timestamp: '2026-04-11T02:00:00Z',
    inputTokens: 300,
    outputTokens: 150,
    cacheCreation: 30,
    cacheRead: 15,
    totalCostUsd: 0.03,
    systemPromptTokens: 0,
    toolCallCount: 3,
  },
  {
    name: 'session-3',
    type: 'executor',
    timestamp: '2026-04-11T03:00:00Z',
    inputTokens: 400,
    outputTokens: 200,
    cacheCreation: 40,
    cacheRead: 20,
    totalCostUsd: 0.04,
    systemPromptTokens: 0,
    toolCallCount: 4,
  },
  {
    name: 'session-4',
    type: 'verifier',
    timestamp: '2026-04-11T04:00:00Z',
    inputTokens: 500,
    outputTokens: 250,
    cacheCreation: 50,
    cacheRead: 25,
    totalCostUsd: 0.05,
    systemPromptTokens: 0,
    toolCallCount: 5,
  },
];

// Precomputed expected values
// All 5: inputTokens=1500, outputTokens=750, cacheCreation=150, cacheRead=75, totalCostUsd=0.15, toolCallCount=15
// fixtures[3]+fixtures[4]: inputTokens=900, outputTokens=450, cacheCreation=90, cacheRead=45, totalCostUsd=0.09, toolCallCount=9

// ---------- Mock setup ----------

const originalLoad = TokenTracker.prototype._load;

TokenTracker.prototype._load = function () {
  this._sessions = FIXTURE_SESSIONS.slice();
};

// ---------- Tests ----------

// TC1: getUsageSince(0) deep-equals getTotalUsage() (aggregates all 5)
test('getUsageSince(0) deep-equals getTotalUsage() — all 5 sessions aggregated', () => {
  const tracker = new TokenTracker('/fake/root');
  const since0 = tracker.getUsageSince(0);
  const total = tracker.getTotalUsage();
  assert.deepStrictEqual(since0, total, 'getUsageSince(0) should equal getTotalUsage()');
  assert.strictEqual(since0.sessionCount, 5, `Expected sessionCount=5, got ${since0.sessionCount}`);
  assert.strictEqual(since0.inputTokens, 1500, `Expected inputTokens=1500, got ${since0.inputTokens}`);
  assert.strictEqual(since0.outputTokens, 750, `Expected outputTokens=750, got ${since0.outputTokens}`);
  assert.strictEqual(since0.totalCostUsd, 0.15, `Expected totalCostUsd=0.15, got ${since0.totalCostUsd}`);
});

// TC2: getUsageSince(3) aggregates only sessions at indices 3 and 4
test('getUsageSince(3) returns sessionCount=2 with correct sums for fixtures[3]+fixtures[4]', () => {
  const tracker = new TokenTracker('/fake/root');
  const result = tracker.getUsageSince(3);
  assert.strictEqual(result.sessionCount, 2, `Expected sessionCount=2, got ${result.sessionCount}`);
  assert.strictEqual(result.inputTokens, 900, `Expected inputTokens=900, got ${result.inputTokens}`);
  assert.strictEqual(result.outputTokens, 450, `Expected outputTokens=450, got ${result.outputTokens}`);
  assert.strictEqual(result.cacheCreation, 90, `Expected cacheCreation=90, got ${result.cacheCreation}`);
  assert.strictEqual(result.cacheRead, 45, `Expected cacheRead=45, got ${result.cacheRead}`);
  assert.strictEqual(result.totalCostUsd, 0.09, `Expected totalCostUsd=0.09, got ${result.totalCostUsd}`);
});

// TC3: getUsageSince(5) (= sessions.length) returns sessionCount=0 and all-zero totals
test('getUsageSince(5) returns sessionCount=0 and all-zero totals', () => {
  const tracker = new TokenTracker('/fake/root');
  const result = tracker.getUsageSince(5);
  assert.strictEqual(result.sessionCount, 0, `Expected sessionCount=0, got ${result.sessionCount}`);
  assert.strictEqual(result.inputTokens, 0, `Expected inputTokens=0, got ${result.inputTokens}`);
  assert.strictEqual(result.outputTokens, 0, `Expected outputTokens=0, got ${result.outputTokens}`);
  assert.strictEqual(result.cacheCreation, 0, `Expected cacheCreation=0, got ${result.cacheCreation}`);
  assert.strictEqual(result.cacheRead, 0, `Expected cacheRead=0, got ${result.cacheRead}`);
  assert.strictEqual(result.totalCostUsd, 0, `Expected totalCostUsd=0, got ${result.totalCostUsd}`);
  assert.strictEqual(result.systemPromptTokens, 0, `Expected systemPromptTokens=0, got ${result.systemPromptTokens}`);
  assert.strictEqual(result.toolCallCount, 0, `Expected toolCallCount=0, got ${result.toolCallCount}`);
});

// ---------- Restore prototype patch ----------
TokenTracker.prototype._load = originalLoad;

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
