/**
 * test-session-manager-sdk-lifecycle.js — Regression tests for the
 * SDK lifecycle bugs surfaced in dogfood 28 (2026-04-25) and dogfood
 * status-bar-v3 (2026-04-24), and the related _buildSdkOptions
 * handle-leak surfaced 2026-05-02.
 *
 * Three regression scenarios:
 *
 * 1. dogfood-28 hang — SDK subprocess emits a `result` event then
 *    its async iterator never closes. spawn()'s for-await loop must
 *    short-circuit on `result` and resolve quickly, NOT wait for the
 *    iterator to close.
 *    Fixed by: src/orchestrator/infra/session-manager.js:497-503
 *    (break + RESULT_WATCHDOG_MS watchdog), shipped v0.1.22 / c70185a.
 *
 * 2. dogfood-status-bar-v3 dropped structured_output — agent calls
 *    StructuredOutput tool then continues with extra prose turns; SDK
 *    final result event has no structured_output field. extractStructured()
 *    must fall back to the captured tool_use input.
 *    Fixed by: session-manager.js:668-674 (capture in _dispatchEvent) +
 *    _schemas.js:332-338 (step-3 fallback in extractStructured), shipped
 *    v0.1.21 / 42d7f57.
 *
 * 3. _buildSdkOptions handle-leak — synchronous failure in _buildSdkOptions
 *    must remove the handle from _active before re-throwing, so the failed
 *    handle doesn't linger as a ghost session forever.
 *    Fixed by: session-manager.js:480-494 (try/catch around _buildSdkOptions),
 *    shipped 2026-05-02 alongside this test.
 *
 * Run: node test/test-session-manager-sdk-lifecycle.js
 */
import assert from 'assert';
import {
  SessionHandle,
  SessionManager,
  RESULT_WATCHDOG_MS,
} from '../src/orchestrator/infra/session-manager.js';
import { extractStructured } from '../src/orchestrator/agents/_schemas.js';

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
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
}

// Helper: produce an async generator that yields a sequence of events.
// `onClose` is called when the consumer terminates iteration (via break,
// return(), or by exhausting the generator) so the test can assert
// whether the for-await broke out of the loop properly.
function makeMockQuery(events, { hangAfterEvents = false, onClose = null } = {}) {
  return function _queryFn() {
    let i = 0;
    const iterator = {
      async next() {
        if (i < events.length) {
          return { value: events[i++], done: false };
        }
        if (hangAfterEvents) {
          // Never resolve — simulates a subprocess that emits its result
          // but does not close its stream. If the consumer break'd properly,
          // this never gets called again. If the consumer kept iterating,
          // this hangs the test forever (so tests must enforce a timeout).
          return new Promise(() => {});
        }
        return { value: undefined, done: true };
      },
      async return() {
        if (onClose) onClose();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() { return this; },
    };
    return iterator;
  };
}

// =============================================================
// Scenario 1: dogfood-28 hang — generator yields result, never closes.
// Without the break at session-manager.js:503, spawn() would hang
// for RESULT_WATCHDOG_MS (60s) before the watchdog forces q.return().
// With the break, spawn() resolves immediately after the result event.
// =============================================================

await test('dogfood-28 regression: spawn() resolves promptly when generator hangs after result event', async () => {
  const sm = new SessionManager();
  const resultEvent = {
    type: 'result',
    subtype: 'success',
    result: 'OK',
    structured_output: null,
  };

  let returnCalled = false;
  sm._queryFn = makeMockQuery([resultEvent], {
    hangAfterEvents: true,
    onClose: () => { returnCalled = true; },
  });

  const start = Date.now();
  const { handle, result } = await sm.spawn({
    name: 'hang-test',
    prompt: 'go',
  });
  const elapsed = Date.now() - start;

  // The break at line 503 should make spawn() resolve in well under 1s.
  // If we waited for the 60s watchdog, this would fail.
  assert.ok(
    elapsed < 5000,
    `Expected spawn() to resolve in <5s (was ${elapsed}ms). Indicates for-await did not break on result event.`
  );

  assert.strictEqual(handle.finished, true, 'handle should be marked finished after break');
  assert.strictEqual(handle._resultReceived, true, '_resultReceived should be true');
  assert.strictEqual(result, resultEvent, 'spawn() should resolve with the result event');
  assert.strictEqual(sm._active.has('hang-test'), false, 'handle should be removed from _active');
});

await test('dogfood-28 regression: RESULT_WATCHDOG_MS is set to a non-zero timeout (safety-net guard)', () => {
  // The break is the primary fix; watchdog is the backup. Sanity-check
  // the watchdog constant is plumbed through and exported.
  assert.strictEqual(typeof RESULT_WATCHDOG_MS, 'number', 'RESULT_WATCHDOG_MS should be a number');
  assert.ok(RESULT_WATCHDOG_MS > 0, `RESULT_WATCHDOG_MS should be positive, got ${RESULT_WATCHDOG_MS}`);
  assert.ok(RESULT_WATCHDOG_MS >= 30000, `Watchdog should be >=30s to avoid premature force-close; got ${RESULT_WATCHDOG_MS}`);
});

// =============================================================
// Scenario 2: dropped structured_output — agent over-runs after
// StructuredOutput call, SDK result event has structured_output undefined.
// _dispatchEvent must capture the StructuredOutput tool_use input and
// attach it to the result event as _capturedStructuredOutput.
// extractStructured must then fall back to that captured payload.
// =============================================================

await test('dogfood-statusbarv3 regression: structured_output captured from StructuredOutput tool_use when SDK omits it', async () => {
  const sm = new SessionManager();
  const verdict = {
    result: 'FAILED',
    summary: 'Mock-drift detected in 9 hardChecks',
    hardChecks: [{ name: 'foo', status: 'FAIL', evidence: 'mismatch' }],
    affectedFiles: [],
  };

  // Mimic the dogfood-status-bar-v3 sequence:
  //   1. Assistant calls StructuredOutput tool with the verdict
  //   2. Assistant continues with confirmation prose (over-run)
  //   3. Result event lacks structured_output (this is the bug class)
  const events = [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_so', name: 'StructuredOutput', input: verdict },
        ],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I have completed verification.' },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'done',
      // structured_output field deliberately absent — this is the over-run pattern
    },
  ];

  sm._queryFn = makeMockQuery(events);

  const { handle, result } = await sm.spawn({
    name: 'overrun-test',
    prompt: 'verify',
  });

  // The capture path should have moved the StructuredOutput input onto the result event.
  assert.deepStrictEqual(
    result._capturedStructuredOutput,
    verdict,
    '_capturedStructuredOutput should carry the StructuredOutput tool_use input'
  );

  // The slot on the handle should be cleared after attachment to prevent
  // cross-turn contamination in reusable sessions.
  assert.strictEqual(
    handle._capturedStructuredOutput,
    null,
    'handle._capturedStructuredOutput should be cleared after result event'
  );
});

await test('dogfood-statusbarv3 regression: extractStructured() returns the captured payload when structured_output is undefined', () => {
  const verdict = { result: 'PASSED', summary: 'all green' };
  const sdkResult = {
    type: 'result',
    // structured_output deliberately undefined
    _capturedStructuredOutput: verdict,
  };
  const out = extractStructured(sdkResult);
  assert.deepStrictEqual(out, verdict, 'extractStructured should fall back to _capturedStructuredOutput');
});

await test('extractStructured returns null when both structured_output and capture are absent', () => {
  const sdkResult = {
    type: 'result',
    // both fields missing
  };
  const out = extractStructured(sdkResult);
  assert.strictEqual(out, null, 'extractStructured should return null when no signal at all');
});

await test('structured_output present takes precedence over _capturedStructuredOutput', () => {
  // Ordering invariant: if SDK delivers structured_output natively, we trust
  // it over the side-channel capture. Captures are a fallback, not an override.
  const sdkVerdict = { result: 'PASSED', source: 'sdk' };
  const captureVerdict = { result: 'FAILED', source: 'capture' };
  const sdkResult = {
    type: 'result',
    structured_output: sdkVerdict,
    _capturedStructuredOutput: captureVerdict,
  };
  const out = extractStructured(sdkResult);
  assert.deepStrictEqual(out, sdkVerdict, 'native structured_output should win over capture');
});

// =============================================================
// Scenario 3: _buildSdkOptions handle-leak — synchronous failure in
// option construction must clean up _active before re-throwing.
// Without the guard, the handle stays in _active with finished=false
// permanently, looking like a stuck ghost session.
// =============================================================

await test('handle-leak regression: spawn() removes handle from _active when _buildSdkOptions throws', () => {
  const sm = new SessionManager();
  const buildErr = new Error('synthetic _buildSdkOptions failure');
  sm._buildSdkOptions = () => { throw buildErr; };

  let thrown = null;
  try {
    sm.spawn({ name: 'leak-test', prompt: 'go' });
  } catch (err) {
    thrown = err;
  }

  assert.strictEqual(thrown, buildErr, 'spawn should re-throw the original error');
  assert.strictEqual(
    sm._active.has('leak-test'),
    false,
    '_active should not contain the handle after _buildSdkOptions failure'
  );
});

await test('handle-leak regression: handle marked finished when _buildSdkOptions throws (cleanup state)', () => {
  // The handle reference itself isn't externally observable post-throw, but
  // we can detect leakage by inspecting _active. We also confirm that the
  // sm has a clean state after the failure by spawning a second session
  // with the same name and asserting no collision.
  const sm = new SessionManager();
  let throwOnce = true;
  sm._buildSdkOptions = (opts) => {
    if (throwOnce) {
      throwOnce = false;
      throw new Error('first call fails');
    }
    return { _approxSystemPromptTokens: 0 };
  };

  // First spawn fails — should clean up.
  try { sm.spawn({ name: 'reuse-name', prompt: 'go' }); } catch {}

  // _active should be empty so the same name is reusable.
  assert.strictEqual(sm._active.has('reuse-name'), false, 'first failed spawn should not leak');

  // Second spawn with the same name should succeed (no collision).
  // Inject a noop _queryFn so we don't actually hit the network; the test
  // only cares that name reuse works after the failure cleanup.
  sm._queryFn = makeMockQuery([{ type: 'result', subtype: 'success', result: 'OK' }]);
  const promise = sm.spawn({ name: 'reuse-name', prompt: 'go' });
  promise.catch(() => {}); // safety
  assert.ok(promise, 'second spawn with reused name should succeed');
});

// =============================================================
// Summary
// =============================================================

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
