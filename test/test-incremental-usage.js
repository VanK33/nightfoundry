/**
 * test-incremental-usage.js — Unit tests for TokenTracker.recordIncrementalUsage().
 *
 * Test cases:
 *   TC1: First call for sessionName='exec-T1' stores entry with given cumulative input/output/cost
 *   TC2: Second call for same sessionName REPLACES (not adds): stored cost equals latest call
 *   TC3: Different sessionName creates a separate entry; both coexist
 *   TC4: Sync return: no awaits, no mutex acquired, no fs writes triggered (spy on save())
 *
 * Run: node test/test-incremental-usage.js
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

// ---------- Mock _load to avoid filesystem reads ----------

const originalLoad = TokenTracker.prototype._load;
TokenTracker.prototype._load = function () {
  this._sessions = [];
};

// ---------- Tests ----------

// TC1: First call stores entry with correct cumulative input/output/cost
test('TC1: first call stores entry with given cumulative input/output/cost', () => {
  const tracker = new TokenTracker('/fake/root');
  const usage = {
    input_tokens: 120,
    output_tokens: 80,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 5,
    total_cost_usd: 0.042,
  };
  tracker.recordIncrementalUsage('exec-T1', 'executor', usage);

  const entry = tracker._inFlight.get('exec-T1');
  assert.ok(entry, '_inFlight should have an entry for exec-T1');
  assert.strictEqual(entry.name, 'exec-T1', `name mismatch: ${entry.name}`);
  assert.strictEqual(entry.type, 'executor', `type mismatch: ${entry.type}`);
  assert.strictEqual(entry.inputTokens, 120, `inputTokens mismatch: ${entry.inputTokens}`);
  assert.strictEqual(entry.outputTokens, 80, `outputTokens mismatch: ${entry.outputTokens}`);
  assert.strictEqual(entry.cacheCreation, 10, `cacheCreation mismatch: ${entry.cacheCreation}`);
  assert.strictEqual(entry.cacheRead, 5, `cacheRead mismatch: ${entry.cacheRead}`);
  assert.strictEqual(entry.totalCostUsd, 0.042, `totalCostUsd mismatch: ${entry.totalCostUsd}`);
  assert.ok(typeof entry.timestamp === 'string', 'timestamp should be a string');
});

// TC2: Second call for same sessionName REPLACES (not adds) — cost equals latest call, not sum
test('TC2: second call for same sessionName replaces entry (not accumulated)', () => {
  const tracker = new TokenTracker('/fake/root');

  tracker.recordIncrementalUsage('exec-T1', 'executor', {
    input_tokens: 100,
    output_tokens: 50,
    total_cost_usd: 0.010,
  });
  tracker.recordIncrementalUsage('exec-T1', 'executor', {
    input_tokens: 200,
    output_tokens: 90,
    total_cost_usd: 0.025,
  });

  assert.strictEqual(tracker._inFlight.size, 1, `expected 1 entry in _inFlight, got ${tracker._inFlight.size}`);
  const entry = tracker._inFlight.get('exec-T1');
  // Should be the SECOND call's values, not accumulated
  assert.strictEqual(entry.inputTokens, 200, `inputTokens should be 200 (latest), got ${entry.inputTokens}`);
  assert.strictEqual(entry.outputTokens, 90, `outputTokens should be 90 (latest), got ${entry.outputTokens}`);
  assert.strictEqual(entry.totalCostUsd, 0.025, `totalCostUsd should be 0.025 (latest), not sum 0.035; got ${entry.totalCostUsd}`);
});

// TC3: Different sessionName creates a separate entry; both coexist
test('TC3: different sessionName creates separate entry; both coexist', () => {
  const tracker = new TokenTracker('/fake/root');

  tracker.recordIncrementalUsage('exec-T1', 'executor', {
    input_tokens: 100,
    output_tokens: 50,
    total_cost_usd: 0.010,
  });
  tracker.recordIncrementalUsage('exec-T2', 'verifier', {
    input_tokens: 300,
    output_tokens: 150,
    total_cost_usd: 0.030,
  });

  assert.strictEqual(tracker._inFlight.size, 2, `expected 2 entries in _inFlight, got ${tracker._inFlight.size}`);

  const t1 = tracker._inFlight.get('exec-T1');
  const t2 = tracker._inFlight.get('exec-T2');

  assert.ok(t1, 'exec-T1 entry missing');
  assert.ok(t2, 'exec-T2 entry missing');

  assert.strictEqual(t1.inputTokens, 100, `exec-T1 inputTokens should be 100, got ${t1.inputTokens}`);
  assert.strictEqual(t1.type, 'executor', `exec-T1 type should be executor, got ${t1.type}`);
  assert.strictEqual(t2.inputTokens, 300, `exec-T2 inputTokens should be 300, got ${t2.inputTokens}`);
  assert.strictEqual(t2.type, 'verifier', `exec-T2 type should be verifier, got ${t2.type}`);
});

// TC4: Sync return, no mutex acquired, no fs writes triggered (spy on save())
test('TC4: sync return — no save() called, no mutex acquired', () => {
  const tracker = new TokenTracker('/fake/root');

  let saveCallCount = 0;
  const originalSave = tracker.save.bind(tracker);
  tracker.save = function (...args) {
    saveCallCount++;
    return originalSave(...args);
  };

  let mutexAcquired = false;
  const originalAcquire = tracker._writeMutex.acquire.bind(tracker._writeMutex);
  tracker._writeMutex.acquire = function (...args) {
    mutexAcquired = true;
    return originalAcquire(...args);
  };

  const result = tracker.recordIncrementalUsage('exec-T1', 'executor', {
    input_tokens: 50,
    output_tokens: 20,
    total_cost_usd: 0.005,
  });

  // Must return synchronously (undefined / not a Promise)
  assert.ok(
    result === undefined || (result !== null && typeof result?.then !== 'function'),
    'recordIncrementalUsage must return synchronously (not a Promise)'
  );
  assert.strictEqual(saveCallCount, 0, `save() should NOT be called, but was called ${saveCallCount} time(s)`);
  assert.strictEqual(mutexAcquired, false, 'mutex.acquire() should NOT be called');

  // Entry must still have been stored
  const entry = tracker._inFlight.get('exec-T1');
  assert.ok(entry, '_inFlight entry should exist after recordIncrementalUsage');
});

// TC4-bonus: total_cost_usd absent → carry prev value or default 0
test('TC4-bonus: totalCostUsd falls back to prev stored value when usage.total_cost_usd is absent', () => {
  const tracker = new TokenTracker('/fake/root');

  // First call with a known cost
  tracker.recordIncrementalUsage('exec-T1', 'executor', {
    input_tokens: 100,
    output_tokens: 50,
    total_cost_usd: 0.017,
  });

  // Second call without total_cost_usd — should carry 0.017
  tracker.recordIncrementalUsage('exec-T1', 'executor', {
    input_tokens: 200,
    output_tokens: 90,
  });

  const entry = tracker._inFlight.get('exec-T1');
  assert.strictEqual(entry.totalCostUsd, 0.017, `totalCostUsd should be carried forward as 0.017, got ${entry.totalCostUsd}`);

  // Brand new session with no cost field → should default to 0
  tracker.recordIncrementalUsage('exec-T9', 'planner', {
    input_tokens: 50,
    output_tokens: 10,
  });
  const t9 = tracker._inFlight.get('exec-T9');
  assert.strictEqual(t9.totalCostUsd, 0, `totalCostUsd should default to 0, got ${t9.totalCostUsd}`);
});

// ---------- Restore prototype patch ----------
TokenTracker.prototype._load = originalLoad;

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
