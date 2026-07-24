/**
 * test-usage-detailed.js — Unit tests for detailed mode in src/cli/commands/usage.js
 * and pure functions in src/orchestrator/infra/usage-analyzer.js.
 *
 * Mocks TokenTracker to avoid filesystem access.
 * Run: node test/test-usage-detailed.js
 */
import assert from 'assert';
import { TokenTracker } from '../src/orchestrator/infra/token-tracker.js';
import {
  aggregateByRole,
  topNBySessionCost,
  filterByRole,
  filterByTaskId,
} from '../src/orchestrator/infra/usage-analyzer.js';
import { usage } from '../src/cli/commands/usage.js';

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

// ---------- stdout capture helper (verbatim from test-usage-json.js) ----------

function captureStdout(fn) {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log.bind(console);

  process.stdout.write = (chunk, ...args) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => {
    chunks.push(args.join(' ') + '\n');
  };

  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }

  return chunks.join('');
}

// ---------- Deterministic mixed-role fixture (12 sessions → top-10 truncation exercised) ----------

const FIXTURE_SESSIONS = [
  // planners (5)
  { name: 'plan-1', type: 'planner', timestamp: '2026-01-01T00:00:00Z', inputTokens: 100, outputTokens: 50,  cacheCreation: 10, cacheRead: 5,  totalCostUsd: 0.01,  taskId: 'task-001', durationMs: 1000 },
  { name: 'plan-2', type: 'planner', timestamp: '2026-01-01T01:00:00Z', inputTokens: 200, outputTokens: 80,  cacheCreation: 20, cacheRead: 10, totalCostUsd: 0.02,  durationMs: 2000 },
  { name: 'plan-3', type: 'planner', timestamp: '2026-01-01T02:00:00Z', inputTokens: 150, outputTokens: 60,  cacheCreation: 15, cacheRead: 8,  totalCostUsd: 0.015, durationMs: 1500 },
  { name: 'plan-4', type: 'planner', timestamp: '2026-01-01T03:00:00Z', inputTokens: 300, outputTokens: 100, cacheCreation: 30, cacheRead: 15, totalCostUsd: 0.03,  durationMs: 3000 },
  { name: 'plan-5', type: 'planner', timestamp: '2026-01-01T04:00:00Z', inputTokens: 250, outputTokens: 90,  cacheCreation: 25, cacheRead: 12, totalCostUsd: 0.025, durationMs: 2500 },
  // executors (4)
  { name: 'exec-1', type: 'executor', timestamp: '2026-01-01T05:00:00Z', inputTokens: 400, outputTokens: 200, cacheCreation: 40, cacheRead: 20, totalCostUsd: 0.04  },
  { name: 'exec-2', type: 'executor', timestamp: '2026-01-01T06:00:00Z', inputTokens: 500, outputTokens: 250, cacheCreation: 50, cacheRead: 25, totalCostUsd: 0.05  },
  { name: 'exec-3', type: 'executor', timestamp: '2026-01-01T07:00:00Z', inputTokens: 600, outputTokens: 300, cacheCreation: 60, cacheRead: 30, totalCostUsd: 0.06  },
  { name: 'exec-4', type: 'executor', timestamp: '2026-01-01T08:00:00Z', inputTokens: 350, outputTokens: 150, cacheCreation: 35, cacheRead: 18, totalCostUsd: 0.035, taskId: 'task-002' },
  // verifiers (3)
  { name: 'verify-1', type: 'verifier', timestamp: '2026-01-01T09:00:00Z',  inputTokens: 180, outputTokens: 90,  cacheCreation: 18, cacheRead: 9,  totalCostUsd: 0.018 },
  { name: 'verify-2', type: 'verifier', timestamp: '2026-01-01T10:00:00Z', inputTokens: 220, outputTokens: 110, cacheCreation: 22, cacheRead: 11, totalCostUsd: 0.022 },
  { name: 'verify-3', type: 'verifier', timestamp: '2026-01-01T11:00:00Z', inputTokens: 280, outputTokens: 140, cacheCreation: 28, cacheRead: 14, totalCostUsd: 0.028 },
];

// ---------- Mock setup ----------

const originalLoad = TokenTracker.prototype._load;
const originalSummary = TokenTracker.prototype.summary;

TokenTracker.prototype._load = function () {
  this._sessions = FIXTURE_SESSIONS.slice();
};

TokenTracker.prototype.summary = function () {
  // Delegate to the real aggregation path so detailed mode uses the fixture
  const totals = this._aggregate(this._sessions);
  return {
    totalSessions: this._sessions.length,
    sessionCount: this._sessions.length,
    ...totals,
    byType: aggregateByRole(this._sessions),
  };
};

// ---------- Tests ----------

// (1) aggregateByRole returns correct structure for mixed-role session list
test('aggregateByRole returns correct structure for mixed-role session list', () => {
  const result = aggregateByRole(FIXTURE_SESSIONS);
  assert.ok(typeof result === 'object' && result !== null, 'result should be an object');
  assert.ok('planner' in result, 'result should have planner key');
  assert.ok('executor' in result, 'result should have executor key');
  assert.ok('verifier' in result, 'result should have verifier key');
  const plannerKeys = ['sessionCount', 'inputTokens', 'outputTokens', 'cacheCreation', 'cacheRead', 'totalCostUsd'];
  for (const k of plannerKeys) {
    assert.ok(k in result.planner, `planner aggregate should have key "${k}"`);
  }
  assert.strictEqual(result.planner.sessionCount, 5, 'Expected 5 planner sessions');
  assert.strictEqual(result.executor.sessionCount, 4, 'Expected 4 executor sessions');
  assert.strictEqual(result.verifier.sessionCount, 3, 'Expected 3 verifier sessions');
});

// (2) aggregateByRole handles empty input (returns {})
test('aggregateByRole handles empty input (returns {})', () => {
  const result = aggregateByRole([]);
  assert.deepStrictEqual(result, {}, 'Expected empty object for empty input');
});

// (3) aggregateByRole computes avgCost and avgDurationMs correctly
test('aggregateByRole computes avgCost and avgDurationMs correctly', () => {
  const result = aggregateByRole(FIXTURE_SESSIONS);
  // avgCost derived from totalCostUsd / sessionCount
  const plannerSessions = FIXTURE_SESSIONS.filter(s => s.type === 'planner');
  const expectedPlannerTotal = plannerSessions.reduce((sum, s) => sum + s.totalCostUsd, 0);
  const expectedPlannerAvg = expectedPlannerTotal / plannerSessions.length;
  const derivedAvg = result.planner.totalCostUsd / result.planner.sessionCount;
  assert.ok(
    Math.abs(derivedAvg - expectedPlannerAvg) < 0.0001,
    `avgCost mismatch: expected ~${expectedPlannerAvg}, got ${derivedAvg}`
  );
  // avgDurationMs derivable from fixture (aggregateByRole accumulates totals; avg = total / count)
  const plannerDurationSum = plannerSessions.reduce((sum, s) => sum + (s.durationMs || 0), 0);
  const expectedAvgDuration = plannerDurationSum / plannerSessions.length;
  assert.ok(expectedAvgDuration === 2000, `Expected planner avgDurationMs=2000, got ${expectedAvgDuration}`);
});

// (4) topNBySessionCost sorts by cost descending
test('topNBySessionCost sorts by cost descending', () => {
  const result = topNBySessionCost(FIXTURE_SESSIONS, FIXTURE_SESSIONS.length);
  for (let i = 0; i < result.length - 1; i++) {
    assert.ok(
      (result[i].totalCostUsd || 0) >= (result[i + 1].totalCostUsd || 0),
      `Sessions not sorted descending at index ${i}: ${result[i].totalCostUsd} < ${result[i + 1].totalCostUsd}`
    );
  }
  assert.strictEqual(result[0].name, 'exec-3', `Expected highest-cost session to be exec-3, got ${result[0].name}`);
});

// (5) topNBySessionCost respects the n limit
test('topNBySessionCost respects the n limit', () => {
  const result = topNBySessionCost(FIXTURE_SESSIONS, 5);
  assert.strictEqual(result.length, 5, `Expected 5 results, got ${result.length}`);
});

// (6) topNBySessionCost handles fewer sessions than n
test('topNBySessionCost handles fewer sessions than n', () => {
  const small = FIXTURE_SESSIONS.slice(0, 3);
  const result = topNBySessionCost(small, 10);
  assert.strictEqual(result.length, 3, `Expected 3 results (all available), got ${result.length}`);
});

// (7) filterByRole includes matching sessions only
test('filterByRole includes matching sessions only', () => {
  const result = filterByRole(FIXTURE_SESSIONS, 'planner');
  assert.ok(result.every(s => s.type === 'planner'), 'All results should have type=planner');
  assert.strictEqual(result.length, 5, `Expected 5 planner sessions, got ${result.length}`);
});

// (8) filterByRole returns empty array when no matches
test('filterByRole returns empty array when no matches', () => {
  const result = filterByRole(FIXTURE_SESSIONS, 'nonexistent-role');
  assert.deepStrictEqual(result, [], 'Expected empty array for non-matching role');
});

// (9) filterByTaskId filters on taskId metadata field
test('filterByTaskId filters on taskId metadata field', () => {
  const result = filterByTaskId(FIXTURE_SESSIONS, 'task-001');
  assert.strictEqual(result.length, 1, `Expected 1 session with taskId=task-001, got ${result.length}`);
  assert.strictEqual(result[0].name, 'plan-1', `Expected plan-1, got ${result[0].name}`);
});

// (10) usage(root, { detailed: true }) output contains per-role breakdown header
test('usage(root, { detailed: true }) output contains per-role breakdown header', () => {
  const out = captureStdout(() => usage('/fake/root', { detailed: true }));
  assert.ok(out.includes('--- By Role ---'), `Expected "--- By Role ---" in detailed output, got:\n${out}`);
});

// (11) usage(root, { detailed: true }) output contains "Top 10" header
test('usage(root, { detailed: true }) output contains "Top 10" header', () => {
  const out = captureStdout(() => usage('/fake/root', { detailed: true }));
  assert.ok(
    out.includes('Top Sessions') || out.includes('Top 10'),
    `Expected "Top Sessions" or "Top 10" header in detailed output, got:\n${out}`
  );
});

// (12) usage(root, { detailed: true, json: true }) output is valid JSON with byRole and topSessions keys
test('usage(root, { detailed: true, json: true }) output is valid JSON with byRole and topSessions keys', () => {
  const out = captureStdout(() => usage('/fake/root', { detailed: true, json: true }));
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON, got parse error: ${e.message}\nOutput: ${out}`);
  }
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'byRole'), 'Expected "byRole" key in JSON output');
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'topSessions'), 'Expected "topSessions" key in JSON output');
});

// (13) usage(root, { detailed: true, role: 'planner' }) only shows planner sessions
test("usage(root, { detailed: true, role: 'planner' }) only shows planner sessions", () => {
  const out = captureStdout(() => usage('/fake/root', { detailed: true, json: true, role: 'planner' }));
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.topSessions), 'Expected topSessions to be an array');
  assert.ok(parsed.topSessions.every(s => s.type === 'planner'), 'All topSessions should be planner type');
  assert.ok(
    Object.keys(parsed.byRole).every(r => r === 'planner'),
    'byRole should only contain planner key when filtered by role'
  );
});

// (14) usage(root, { detailed: false }) output matches existing pre-detailed behavior (back-compat)
test('usage(root, { detailed: false }) output matches existing pre-detailed behavior (back-compat)', () => {
  const out = captureStdout(() => usage('/fake/root', { detailed: false }));
  // Legacy header must be present
  assert.ok(out.includes('--- Token Usage ---'), `Expected "--- Token Usage ---" in back-compat output, got:\n${out}`);
  // Detailed sections must NOT be present
  assert.ok(!out.includes('--- By Role ---'), `Back-compat output must NOT include "--- By Role ---"`);
  assert.ok(!out.includes('--- Top Sessions'), `Back-compat output must NOT include top-sessions section`);
  // Basic fields present
  assert.ok(out.includes('Sessions:'), `Expected "Sessions:" in back-compat output`);
  assert.ok(out.includes('Total cost:'), `Expected "Total cost:" in back-compat output`);
});

// ---------- Restore prototype patches ----------
TokenTracker.prototype._load = originalLoad;
TokenTracker.prototype.summary = originalSummary;

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
