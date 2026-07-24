/**
 * test-scheduler-circuit-breaker.js — Unit tests for the circuit-breaker
 * state and detection infrastructure added to Scheduler.
 *
 * Covers:
 *   1. _isInfraError returns true for InfrastructureError with retryable=true
 *   2. _isInfraError returns false for plain Error
 *   3. _isInfraError returns false for InfrastructureError with retryable=false
 *   4. _recordInfraError adds entry with Date.now() timestamp
 *   5. _isCircuitTripped returns false with 2 errors in window
 *   6. _isCircuitTripped returns true with 3 errors in window
 *   7. _isCircuitTripped returns false when oldest error is outside 60s window
 *
 * Run: node test/test-scheduler-circuit-breaker.js
 */
import assert from 'assert';
import { Scheduler } from '../src/orchestrator/core/scheduler.js';
import { InfrastructureError } from '../src/orchestrator/infra/session-manager.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

/**
 * Build a minimal Scheduler instance (no real harness needed for
 * circuit-breaker unit tests — the constructor fields are set up in
 * the constructor regardless of whether runMilestone is ever called).
 */
function makeScheduler() {
  return new Scheduler({
    harnessDir: '/tmp/cb-test',
    projectRoot: '/tmp/cb-test',
    maxConcurrent: 2,
    runTask: async () => {},
  });
}

// ── Test 1: _isInfraError returns true for InfrastructureError retryable=true ──

test('_isInfraError returns true for InfrastructureError with retryable=true', () => {
  const scheduler = makeScheduler();
  const err = new InfrastructureError('rate limit', {
    category: 'rate_limit',
    retryable: true,
    statusCode: 429,
    cause: new Error('original'),
  });
  assert.strictEqual(scheduler._isInfraError(err), true);
});

// ── Test 2: _isInfraError returns false for plain Error ──────────────────────

test('_isInfraError returns false for plain Error', () => {
  const scheduler = makeScheduler();
  const err = new Error('some generic error');
  assert.strictEqual(scheduler._isInfraError(err), false);
});

// ── Test 3: _isInfraError returns false for InfrastructureError retryable=false ──

test('_isInfraError returns false for InfrastructureError with retryable=false', () => {
  const scheduler = makeScheduler();
  const err = new InfrastructureError('auth error', {
    category: 'auth',
    retryable: false,
    statusCode: 401,
    cause: new Error('original'),
  });
  assert.strictEqual(scheduler._isInfraError(err), false);
});

// ── Test 4: _recordInfraError adds entry with Date.now() timestamp ────────────

test('_recordInfraError adds entry with Date.now() timestamp', () => {
  const scheduler = makeScheduler();
  const before = Date.now();
  const err = new InfrastructureError('network error', {
    category: 'network',
    retryable: true,
    statusCode: undefined,
    cause: new Error('original'),
  });
  scheduler._recordInfraError(err);
  const after = Date.now();

  assert.strictEqual(scheduler._infraErrors.length, 1, 'should have 1 entry after one record');
  const entry = scheduler._infraErrors[0];
  assert.ok(
    entry.timestamp >= before && entry.timestamp <= after,
    `timestamp ${entry.timestamp} should be between ${before} and ${after}`
  );
  assert.strictEqual(entry.err, err, 'entry.err should be the recorded error');
});

// ── Test 5: _isCircuitTripped returns false with 2 errors in window ───────────

test('_isCircuitTripped returns false with 2 errors in window', () => {
  const scheduler = makeScheduler();
  const now = Date.now();
  // Inject 2 entries within the window manually
  scheduler._infraErrors = [
    { timestamp: now - 1000, err: new Error('e1') },
    { timestamp: now - 500,  err: new Error('e2') },
  ];
  assert.strictEqual(scheduler._isCircuitTripped(), false,
    'should not trip with only 2 errors (threshold=3)');
});

// ── Test 6: _isCircuitTripped returns true with 3 errors in window ────────────

test('_isCircuitTripped returns true with 3 errors in window', () => {
  const scheduler = makeScheduler();
  const now = Date.now();
  scheduler._infraErrors = [
    { timestamp: now - 2000, err: new Error('e1') },
    { timestamp: now - 1000, err: new Error('e2') },
    { timestamp: now - 500,  err: new Error('e3') },
  ];
  assert.strictEqual(scheduler._isCircuitTripped(), true,
    'should trip with 3 errors in window (threshold=3)');
});

// ── Test 7: _isCircuitTripped returns false when oldest error is outside window ──

test('_isCircuitTripped returns false when oldest error is outside 60s window (only 2 remain)', () => {
  const scheduler = makeScheduler();
  const now = Date.now();
  // First entry is older than INFRA_WINDOW_MS (60000ms), so only 2 remain in window
  scheduler._infraErrors = [
    { timestamp: now - 70000, err: new Error('e1') },  // outside window
    { timestamp: now - 1000,  err: new Error('e2') },
    { timestamp: now - 500,   err: new Error('e3') },
  ];
  assert.strictEqual(scheduler._isCircuitTripped(), false,
    'should not trip when only 2 errors remain after pruning stale entry');
  // Verify the stale entry was pruned
  assert.strictEqual(scheduler._infraErrors.length, 2,
    'stale entry should be pruned from _infraErrors');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
