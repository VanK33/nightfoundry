/**
 * test-cache-efficiency.js — Unit tests for cacheEfficiency() and classifyRatio()
 * in src/orchestrator/infra/usage-analyzer.js.
 *
 * Run: node test/test-cache-efficiency.js
 */
import assert from 'assert';
import { cacheEfficiency, classifyRatio } from '../src/orchestrator/infra/usage-analyzer.js';

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

// ---------- classifyRatio ----------

test('classifyRatio returns excellent for ratio >= 3.0', () => {
  assert.strictEqual(classifyRatio(3.0), 'excellent');
  assert.strictEqual(classifyRatio(5.0), 'excellent');
  assert.strictEqual(classifyRatio(10), 'excellent');
});

test('classifyRatio returns healthy for ratio >= 1.0 and < 3.0', () => {
  assert.strictEqual(classifyRatio(1.0), 'healthy');
  assert.strictEqual(classifyRatio(2.0), 'healthy');
  assert.strictEqual(classifyRatio(2.99), 'healthy');
});

test('classifyRatio returns marginal for ratio >= 0.3 and < 1.0', () => {
  assert.strictEqual(classifyRatio(0.3), 'marginal');
  assert.strictEqual(classifyRatio(0.5), 'marginal');
  assert.strictEqual(classifyRatio(0.99), 'marginal');
});

test('classifyRatio returns wasteful for ratio < 0.3', () => {
  assert.strictEqual(classifyRatio(0.0), 'wasteful');
  assert.strictEqual(classifyRatio(0.1), 'wasteful');
  assert.strictEqual(classifyRatio(0.29), 'wasteful');
});

// ---------- cacheEfficiency ----------

// (1) excellent: ratio >= 3.0
test('cacheEfficiency returns excellent for ratio >= 3.0', () => {
  const sessions = [
    { type: 'executor', cacheCreation: 10, cacheRead: 30 }, // ratio = 3.0
  ];
  const result = cacheEfficiency(sessions);
  assert.strictEqual(result.executor.verdict, 'excellent');
  assert.strictEqual(result.executor.ratio, 3.0);
  assert.strictEqual(result.executor.cacheCreation, 10);
  assert.strictEqual(result.executor.cacheRead, 30);
});

// (2) healthy: ratio >= 1.0 and < 3.0
test('cacheEfficiency returns healthy for ratio >= 1.0 and < 3.0', () => {
  const sessions = [
    { type: 'executor', cacheCreation: 10, cacheRead: 20 }, // ratio = 2.0
  ];
  const result = cacheEfficiency(sessions);
  assert.strictEqual(result.executor.verdict, 'healthy');
  assert.strictEqual(result.executor.ratio, 2.0);
});

// (3) marginal: ratio >= 0.3 and < 1.0
test('cacheEfficiency returns marginal for ratio >= 0.3 and < 1.0', () => {
  const sessions = [
    { type: 'executor', cacheCreation: 10, cacheRead: 5 }, // ratio = 0.5
  ];
  const result = cacheEfficiency(sessions);
  assert.strictEqual(result.executor.verdict, 'marginal');
  assert.strictEqual(result.executor.ratio, 0.5);
});

// (4) wasteful: ratio < 0.3
test('cacheEfficiency returns wasteful for ratio < 0.3', () => {
  const sessions = [
    { type: 'executor', cacheCreation: 100, cacheRead: 10 }, // ratio = 0.1
  ];
  const result = cacheEfficiency(sessions);
  assert.strictEqual(result.executor.verdict, 'wasteful');
  assert.strictEqual(result.executor.ratio, 0.1);
});

// (5) n/a for zero cacheCreation
test('cacheEfficiency returns n/a for zero cacheCreation', () => {
  const sessions = [
    { type: 'planner', cacheCreation: 0, cacheRead: 0 },
    { type: 'planner', cacheCreation: 0, cacheRead: 50 },
  ];
  const result = cacheEfficiency(sessions);
  assert.strictEqual(result.planner.verdict, 'n/a');
  assert.strictEqual(result.planner.ratio, null);
  assert.strictEqual(result.planner.cacheCreation, 0);
  assert.strictEqual(result.planner.cacheRead, 50);
});

// (6) handles empty sessions array
test('cacheEfficiency handles empty sessions array', () => {
  const result = cacheEfficiency([]);
  assert.deepStrictEqual(result, {});
});

// (7) groups correctly by role
test('cacheEfficiency groups correctly by role', () => {
  const sessions = [
    { type: 'planner',  cacheCreation: 10, cacheRead: 30 },
    { type: 'planner',  cacheCreation: 10, cacheRead: 30 },
    { type: 'executor', cacheCreation: 20, cacheRead: 10 },
    { type: 'verifier', cacheCreation:  5, cacheRead:  1 },
  ];
  const result = cacheEfficiency(sessions);

  // planner: total creation=20, read=60, ratio=3.0 → excellent
  assert.strictEqual(result.planner.cacheCreation, 20);
  assert.strictEqual(result.planner.cacheRead, 60);
  assert.strictEqual(result.planner.ratio, 3.0);
  assert.strictEqual(result.planner.verdict, 'excellent');

  // executor: ratio=0.5 → marginal
  assert.strictEqual(result.executor.cacheCreation, 20);
  assert.strictEqual(result.executor.cacheRead, 10);
  assert.strictEqual(result.executor.ratio, 0.5);
  assert.strictEqual(result.executor.verdict, 'marginal');

  // verifier: ratio=0.2 → wasteful
  assert.strictEqual(result.verifier.cacheCreation, 5);
  assert.strictEqual(result.verifier.cacheRead, 1);
  assert.ok(Math.abs(result.verifier.ratio - 0.2) < 0.0001);
  assert.strictEqual(result.verifier.verdict, 'wasteful');

  // All 3 roles present, no extras
  assert.deepStrictEqual(Object.keys(result).sort(), ['executor', 'planner', 'verifier']);
});

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
