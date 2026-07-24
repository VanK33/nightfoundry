/**
 * test-per-turn-tracking.js — Unit tests for per-turn tracking fields on reusable sessions.
 *
 * Verifies that turnIdx and reused fields are preserved on stored session entries,
 * and that two reusable-session turn entries with different turnIdx values aggregate
 * as 2 sessions in aggregateByRole (not collapsed to 1).
 *
 * Uses the TokenTracker prototype mock pattern to avoid filesystem access.
 * Run: node test/test-per-turn-tracking.js
 */
import assert from 'assert';
import { TokenTracker } from '../src/orchestrator/infra/token-tracker.js';
import { aggregateByRole } from '../src/orchestrator/infra/usage-analyzer.js';

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

// ---------- Fixture: two reusable-session turn entries ----------

const FIXTURE_SESSIONS = [
  {
    name: 'planner-reused-turn-0',
    type: 'planner',
    timestamp: '2026-04-11T00:00:00Z',
    inputTokens: 100,
    outputTokens: 50,
    cacheCreation: 10,
    cacheRead: 5,
    totalCostUsd: 0.01,
    phase: '3b',
    missionId: 'mission-001',
    reused: true,
    turnIdx: 0,
  },
  {
    name: 'planner-reused-turn-1',
    type: 'planner',
    timestamp: '2026-04-11T01:00:00Z',
    inputTokens: 120,
    outputTokens: 60,
    cacheCreation: 12,
    cacheRead: 6,
    totalCostUsd: 0.012,
    phase: '3b',
    missionId: 'mission-001',
    reused: true,
    turnIdx: 1,
  },
];

// ---------- Mock setup ----------

const originalLoad = TokenTracker.prototype._load;

TokenTracker.prototype._load = function () {
  this._sessions = FIXTURE_SESSIONS.slice();
};

// ---------- Tests ----------

// TC1: Two reusable-session turn entries aggregate as 2 sessions in aggregateByRole
test('Two reusable-session turn entries aggregate as 2 sessions in aggregateByRole', () => {
  const result = aggregateByRole(FIXTURE_SESSIONS);
  assert.ok('planner' in result, 'result should have a planner key');
  assert.strictEqual(result.planner.sessionCount, 2, `Expected sessionCount=2, got ${result.planner.sessionCount}`);
});

// TC2: turnIdx field is preserved on stored session entries
test('turnIdx field is preserved on stored session entries', () => {
  const tracker = new TokenTracker('/fake/root');
  const sessions = tracker._sessions;
  assert.ok(sessions.every(s => 'turnIdx' in s), 'All sessions should have a turnIdx field');
  assert.strictEqual(sessions[0].turnIdx, 0, `Expected first session turnIdx=0, got ${sessions[0].turnIdx}`);
  assert.strictEqual(sessions[1].turnIdx, 1, `Expected second session turnIdx=1, got ${sessions[1].turnIdx}`);
});

// TC3: reused field is preserved on stored session entries
test('reused field is preserved on stored session entries', () => {
  const tracker = new TokenTracker('/fake/root');
  const sessions = tracker._sessions;
  assert.ok(sessions.every(s => s.reused === true), 'All sessions should have reused=true');
});

// TC4: Entries with different turnIdx values are not collapsed
test('Entries with different turnIdx values are not collapsed', () => {
  const result = aggregateByRole(FIXTURE_SESSIONS);
  // If collapsed, there would be 1 session; distinct turnIdx values must yield 2
  assert.strictEqual(
    result.planner.sessionCount,
    2,
    `Expected 2 planner sessions (not collapsed), got ${result.planner.sessionCount}`
  );
  // Also confirm both turnIdx values are present on the raw fixture
  const turnIdxValues = FIXTURE_SESSIONS.map(s => s.turnIdx);
  assert.ok(turnIdxValues.includes(0), 'Fixture should include an entry with turnIdx=0');
  assert.ok(turnIdxValues.includes(1), 'Fixture should include an entry with turnIdx=1');
  assert.strictEqual(new Set(turnIdxValues).size, 2, 'Both turnIdx values should be distinct');
});

// ---------- Restore prototype patches ----------
TokenTracker.prototype._load = originalLoad;

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
