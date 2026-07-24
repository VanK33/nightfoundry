/**
 * test-usage-since.js — Unit tests for TokenTracker.getUsageSince().
 *
 * Constructs a TokenTracker with a stubbed _load, pushes fixture sessions,
 * and asserts getUsageSince at index 0, mid-point, and past-end.
 *
 * Run: node test/test-usage-since.js
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

// ---------- Fixture sessions ----------

const FIXTURE_SESSIONS = [
  {
    name: 'planner-0',
    type: 'planner',
    timestamp: '2026-04-11T00:00:00Z',
    inputTokens: 100,
    outputTokens: 50,
    cacheCreation: 10,
    cacheRead: 5,
    totalCostUsd: 0.01,
  },
  {
    name: 'executor-1',
    type: 'executor',
    timestamp: '2026-04-11T01:00:00Z',
    inputTokens: 200,
    outputTokens: 80,
    cacheCreation: 20,
    cacheRead: 15,
    totalCostUsd: 0.02,
  },
  {
    name: 'verifier-2',
    type: 'verifier',
    timestamp: '2026-04-11T02:00:00Z',
    inputTokens: 150,
    outputTokens: 60,
    cacheCreation: 5,
    cacheRead: 10,
    totalCostUsd: 0.015,
  },
];

// ---------- Mock setup ----------

const originalLoad = TokenTracker.prototype._load;

TokenTracker.prototype._load = function () {
  this._sessions = FIXTURE_SESSIONS.slice();
};

// ---------- Tests ----------

// TC1: getUsageSince(0) equals getTotalUsage()
test('getUsageSince(0) equals getTotalUsage()', () => {
  const tracker = new TokenTracker('/fake/root');
  const since0 = tracker.getUsageSince(0);
  const total = tracker.getTotalUsage();

  assert.strictEqual(
    since0.sessionCount,
    total.sessionCount,
    `sessionCount mismatch: since0=${since0.sessionCount}, total=${total.sessionCount}`
  );
  assert.strictEqual(
    since0.inputTokens,
    total.inputTokens,
    `inputTokens mismatch: since0=${since0.inputTokens}, total=${total.inputTokens}`
  );
  assert.strictEqual(
    since0.outputTokens,
    total.outputTokens,
    `outputTokens mismatch: since0=${since0.outputTokens}, total=${total.outputTokens}`
  );
  assert.strictEqual(
    since0.cacheCreation,
    total.cacheCreation,
    `cacheCreation mismatch: since0=${since0.cacheCreation}, total=${total.cacheCreation}`
  );
  assert.strictEqual(
    since0.cacheRead,
    total.cacheRead,
    `cacheRead mismatch: since0=${since0.cacheRead}, total=${total.cacheRead}`
  );
  assert.strictEqual(
    since0.totalCostUsd,
    total.totalCostUsd,
    `totalCostUsd mismatch: since0=${since0.totalCostUsd}, total=${total.totalCostUsd}`
  );
});

// TC2: getUsageSince(1) aggregates sessions[1..]
test('getUsageSince(1) aggregates sessions[1..]', () => {
  const tracker = new TokenTracker('/fake/root');
  const since1 = tracker.getUsageSince(1);

  // Expected values from FIXTURE_SESSIONS[1] + FIXTURE_SESSIONS[2]
  const expectedSessionCount = 2;
  const expectedInputTokens = 200 + 150;   // 350
  const expectedOutputTokens = 80 + 60;    // 140
  const expectedCacheCreation = 20 + 5;    // 25
  const expectedCacheRead = 15 + 10;       // 25
  const expectedCostUsd = Math.round((0.02 + 0.015) * 1000) / 1000; // 0.035

  assert.strictEqual(
    since1.sessionCount,
    expectedSessionCount,
    `Expected sessionCount=${expectedSessionCount}, got ${since1.sessionCount}`
  );
  assert.strictEqual(
    since1.inputTokens,
    expectedInputTokens,
    `Expected inputTokens=${expectedInputTokens}, got ${since1.inputTokens}`
  );
  assert.strictEqual(
    since1.outputTokens,
    expectedOutputTokens,
    `Expected outputTokens=${expectedOutputTokens}, got ${since1.outputTokens}`
  );
  assert.strictEqual(
    since1.cacheCreation,
    expectedCacheCreation,
    `Expected cacheCreation=${expectedCacheCreation}, got ${since1.cacheCreation}`
  );
  assert.strictEqual(
    since1.cacheRead,
    expectedCacheRead,
    `Expected cacheRead=${expectedCacheRead}, got ${since1.cacheRead}`
  );
  assert.strictEqual(
    since1.totalCostUsd,
    expectedCostUsd,
    `Expected totalCostUsd=${expectedCostUsd}, got ${since1.totalCostUsd}`
  );
});

// TC3: getUsageSince(sessions.length) returns sessionCount 0 and all zeros
test('getUsageSince(sessions.length) returns sessionCount 0 and all zeros', () => {
  const tracker = new TokenTracker('/fake/root');
  const pastEnd = tracker.getUsageSince(tracker._sessions.length);

  assert.strictEqual(pastEnd.sessionCount, 0, `Expected sessionCount=0, got ${pastEnd.sessionCount}`);
  assert.strictEqual(pastEnd.inputTokens, 0, `Expected inputTokens=0, got ${pastEnd.inputTokens}`);
  assert.strictEqual(pastEnd.outputTokens, 0, `Expected outputTokens=0, got ${pastEnd.outputTokens}`);
  assert.strictEqual(pastEnd.cacheCreation, 0, `Expected cacheCreation=0, got ${pastEnd.cacheCreation}`);
  assert.strictEqual(pastEnd.cacheRead, 0, `Expected cacheRead=0, got ${pastEnd.cacheRead}`);
  assert.strictEqual(pastEnd.totalCostUsd, 0, `Expected totalCostUsd=0, got ${pastEnd.totalCostUsd}`);
});

// ---------- Restore prototype patch ----------
TokenTracker.prototype._load = originalLoad;

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
