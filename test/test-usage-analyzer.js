/**
 * test-usage-analyzer.js — Unit tests for pure functions in usage-analyzer.js.
 *
 * Covers cacheEfficiency verdict levels, edge cases, and existing pure functions
 * (aggregateByRole, topNBySessionCost, filterByRole, filterByTaskId).
 *
 * Run: node test/test-usage-analyzer.js
 */
import assert from 'assert';
import {
  aggregateByRole,
  topNBySessionCost,
  filterByRole,
  filterByTaskId,
  cacheEfficiency,
} from '../src/orchestrator/infra/usage-analyzer.js';

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

// ---------- Fixtures ----------

// Mixed-role fixture for aggregateByRole, topNBySessionCost, filterByRole, filterByTaskId
const SESSIONS = [
  { name: 'plan-1', type: 'planner',  taskId: 'task-001', inputTokens: 100, outputTokens: 50,  cacheCreation: 10, cacheRead: 5,  totalCostUsd: 0.01 },
  { name: 'plan-2', type: 'planner',  inputTokens: 200, outputTokens: 80,  cacheCreation: 20, cacheRead: 10, totalCostUsd: 0.03 },
  { name: 'exec-1', type: 'executor', taskId: 'task-002', inputTokens: 400, outputTokens: 200, cacheCreation: 40, cacheRead: 20, totalCostUsd: 0.05 },
  { name: 'exec-2', type: 'executor', inputTokens: 300, outputTokens: 150, cacheCreation: 30, cacheRead: 15, totalCostUsd: 0.04 },
  { name: 'verify-1', type: 'verifier', inputTokens: 180, outputTokens: 90,  cacheCreation: 18, cacheRead: 9,  totalCostUsd: 0.02 },
];

// ---------- TC1: cacheEfficiency returns excellent for high read/creation ratio ----------
test('cacheEfficiency returns excellent for high read/creation ratio', () => {
  // ratio = 400 / 100 = 4.0 → excellent (>= 3.0)
  const sessions = [
    { type: 'executor', cacheCreation: 100, cacheRead: 400 },
  ];
  const result = cacheEfficiency(sessions);
  assert.strictEqual(result.executor.verdict, 'excellent',
    `Expected "excellent", got "${result.executor.verdict}"`);
  assert.ok(result.executor.ratio >= 3.0,
    `Expected ratio >= 3.0, got ${result.executor.ratio}`);
});

// ---------- TC2: cacheEfficiency returns healthy for moderate ratio ----------
test('cacheEfficiency returns healthy for moderate ratio', () => {
  // ratio = 150 / 100 = 1.5 → healthy (>= 1.0 and < 3.0)
  const sessions = [
    { type: 'planner', cacheCreation: 100, cacheRead: 150 },
  ];
  const result = cacheEfficiency(sessions);
  assert.strictEqual(result.planner.verdict, 'healthy',
    `Expected "healthy", got "${result.planner.verdict}"`);
  assert.ok(result.planner.ratio >= 1.0 && result.planner.ratio < 3.0,
    `Expected 1.0 <= ratio < 3.0, got ${result.planner.ratio}`);
});

// ---------- TC3: cacheEfficiency returns marginal for low ratio ----------
test('cacheEfficiency returns marginal for low ratio', () => {
  // ratio = 50 / 100 = 0.5 → marginal (>= 0.3 and < 1.0)
  const sessions = [
    { type: 'verifier', cacheCreation: 100, cacheRead: 50 },
  ];
  const result = cacheEfficiency(sessions);
  assert.strictEqual(result.verifier.verdict, 'marginal',
    `Expected "marginal", got "${result.verifier.verdict}"`);
  assert.ok(result.verifier.ratio >= 0.3 && result.verifier.ratio < 1.0,
    `Expected 0.3 <= ratio < 1.0, got ${result.verifier.ratio}`);
});

// ---------- TC4: cacheEfficiency returns wasteful for very low ratio ----------
test('cacheEfficiency returns wasteful for very low ratio', () => {
  // ratio = 10 / 100 = 0.1 → wasteful (< 0.3)
  const sessions = [
    { type: 'analyzer', cacheCreation: 100, cacheRead: 10 },
  ];
  const result = cacheEfficiency(sessions);
  assert.strictEqual(result.analyzer.verdict, 'wasteful',
    `Expected "wasteful", got "${result.analyzer.verdict}"`);
  assert.ok(result.analyzer.ratio < 0.3,
    `Expected ratio < 0.3, got ${result.analyzer.ratio}`);
});

// ---------- TC5: cacheEfficiency handles zero cacheCreation returns n/a ----------
test('cacheEfficiency handles zero cacheCreation returns n/a', () => {
  const sessions = [
    { type: 'planner', cacheCreation: 0, cacheRead: 0 },
  ];
  const result = cacheEfficiency(sessions);
  assert.strictEqual(result.planner.verdict, 'n/a',
    `Expected "n/a" verdict when cacheCreation is zero, got "${result.planner.verdict}"`);
  assert.strictEqual(result.planner.ratio, null,
    `Expected null ratio when cacheCreation is zero, got ${result.planner.ratio}`);
});

// ---------- TC6: cacheEfficiency handles empty sessions array ----------
test('cacheEfficiency handles empty sessions array', () => {
  const result = cacheEfficiency([]);
  assert.deepStrictEqual(result, {},
    `Expected empty object for empty sessions, got ${JSON.stringify(result)}`);
});

// ---------- TC7: aggregateByRole groups by type correctly ----------
test('aggregateByRole groups by type correctly', () => {
  const result = aggregateByRole(SESSIONS);
  assert.ok('planner' in result,   'Expected "planner" key in result');
  assert.ok('executor' in result,  'Expected "executor" key in result');
  assert.ok('verifier' in result,  'Expected "verifier" key in result');
  assert.strictEqual(result.planner.sessionCount,  2, `Expected 2 planner sessions, got ${result.planner.sessionCount}`);
  assert.strictEqual(result.executor.sessionCount, 2, `Expected 2 executor sessions, got ${result.executor.sessionCount}`);
  assert.strictEqual(result.verifier.sessionCount, 1, `Expected 1 verifier session, got ${result.verifier.sessionCount}`);
  // Verify token sums for planner (100+200=300 input, 50+80=130 output)
  assert.strictEqual(result.planner.inputTokens, 300,
    `Expected planner inputTokens=300, got ${result.planner.inputTokens}`);
  assert.strictEqual(result.planner.outputTokens, 130,
    `Expected planner outputTokens=130, got ${result.planner.outputTokens}`);
});

// ---------- TC8: topNBySessionCost sorts descending by cost ----------
test('topNBySessionCost sorts descending by cost', () => {
  const result = topNBySessionCost(SESSIONS, SESSIONS.length);
  // Verify descending order
  for (let i = 0; i < result.length - 1; i++) {
    assert.ok(
      (result[i].totalCostUsd || 0) >= (result[i + 1].totalCostUsd || 0),
      `Sessions not sorted descending at index ${i}: ${result[i].totalCostUsd} < ${result[i + 1].totalCostUsd}`
    );
  }
  // Highest cost session should be exec-1 (0.05)
  assert.strictEqual(result[0].name, 'exec-1',
    `Expected exec-1 as most expensive, got ${result[0].name}`);
  // Verify n limit
  const top2 = topNBySessionCost(SESSIONS, 2);
  assert.strictEqual(top2.length, 2, `Expected 2 results for n=2, got ${top2.length}`);
});

// ---------- TC9: filterByRole filters correctly ----------
test('filterByRole filters correctly', () => {
  const planners = filterByRole(SESSIONS, 'planner');
  assert.strictEqual(planners.length, 2,
    `Expected 2 planner sessions, got ${planners.length}`);
  assert.ok(planners.every(s => s.type === 'planner'),
    'All returned sessions should have type=planner');
  // Non-matching role returns empty array
  const none = filterByRole(SESSIONS, 'nonexistent');
  assert.deepStrictEqual(none, [],
    'Expected empty array for non-matching role');
});

// ---------- TC10: filterByTaskId filters correctly ----------
test('filterByTaskId filters correctly', () => {
  const task1 = filterByTaskId(SESSIONS, 'task-001');
  assert.strictEqual(task1.length, 1,
    `Expected 1 session with taskId=task-001, got ${task1.length}`);
  assert.strictEqual(task1[0].name, 'plan-1',
    `Expected plan-1, got ${task1[0].name}`);
  const task2 = filterByTaskId(SESSIONS, 'task-002');
  assert.strictEqual(task2.length, 1,
    `Expected 1 session with taskId=task-002, got ${task2.length}`);
  assert.strictEqual(task2[0].name, 'exec-1',
    `Expected exec-1, got ${task2[0].name}`);
  // Non-matching taskId returns empty array
  const none = filterByTaskId(SESSIONS, 'task-999');
  assert.deepStrictEqual(none, [],
    'Expected empty array for non-matching taskId');
});

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
