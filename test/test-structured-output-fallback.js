/**
 * test-structured-output-fallback.js — Regression tests for extractStructured fallback logic.
 *
 * Covers:
 *   TC1. Fallback fires: extractStructured returns _capturedStructuredOutput when structured_output absent
 *   TC2. Preferred path: extractStructured returns structured_output when present, ignores _capturedStructuredOutput
 *   TC3. LAST-wins: two StructuredOutput tool_use blocks → handle captures the second payload
 *   TC4. Warning emission: opts.warn called exactly once when fallback fires
 *   TC5. No warning: opts.warn NOT called when preferred path fires
 *   TC6. Null: extractStructured returns null when neither field present
 *   TC7. End-to-end: _dispatchEvent + extractStructured integration — assistant event with
 *        StructuredOutput tool_use → result event without structured_output → extractStructured
 *        returns captured payload
 *
 * Run: node test/test-structured-output-fallback.js
 */
import assert from 'assert';
import { extractStructured } from '../src/orchestrator/agents/_schemas.js';
import { SessionHandle, SessionManager } from '../src/orchestrator/infra/session-manager.js';

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

// --- TC1: Fallback fires ---
await test('TC1: extractStructured returns _capturedStructuredOutput when structured_output absent', () => {
  const captured = { status: 'COMPLETED', summary: 'done', affectedFiles: [] };
  const sdkResult = { _capturedStructuredOutput: captured };
  const result = extractStructured(sdkResult);
  assert.deepStrictEqual(result, captured, 'Expected _capturedStructuredOutput to be returned as fallback');
});

// --- TC2: Preferred path ---
await test('TC2: extractStructured returns structured_output when present, ignores _capturedStructuredOutput', () => {
  const preferred = { status: 'COMPLETED', summary: 'from sdk', affectedFiles: [] };
  const captured  = { status: 'BLOCKED',   summary: 'fallback',  affectedFiles: [] };
  const sdkResult = {
    structured_output: preferred,
    _capturedStructuredOutput: captured,
  };
  const result = extractStructured(sdkResult);
  assert.deepStrictEqual(result, preferred, 'Expected structured_output to be returned (preferred path)');
  assert.notDeepStrictEqual(result, captured, 'Should NOT return _capturedStructuredOutput when structured_output is present');
});

// --- TC3: LAST-wins for multiple StructuredOutput tool_use calls ---
await test('TC3: LAST-wins — two StructuredOutput tool_use blocks → handle captures the second payload', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('test-last-wins');

  const firstPayload  = { status: 'BLOCKED',   summary: 'first attempt' };
  const secondPayload = { status: 'COMPLETED',  summary: 'final answer' };

  const event = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'StructuredOutput', input: firstPayload },
        { type: 'tool_use', id: 'tu_2', name: 'StructuredOutput', input: secondPayload },
      ],
    },
  };

  sm._dispatchEvent(handle, event);

  assert.deepStrictEqual(
    handle._capturedStructuredOutput,
    secondPayload,
    `Expected second payload to win. Got: ${JSON.stringify(handle._capturedStructuredOutput)}`
  );
});

// --- TC4: Warning emission when fallback fires ---
await test('TC4: opts.warn called exactly once when fallback fires', () => {
  const captured = { status: 'COMPLETED', summary: 'fallback path', affectedFiles: [] };
  const sdkResult = { _capturedStructuredOutput: captured };

  let warnCount = 0;
  const opts = { warn: () => { warnCount++; } };

  extractStructured(sdkResult, opts);

  assert.strictEqual(warnCount, 1, `Expected opts.warn to be called exactly once, got ${warnCount}`);
});

// --- TC5: No warning on preferred path ---
await test('TC5: opts.warn NOT called when preferred path fires (structured_output present)', () => {
  const preferred = { status: 'COMPLETED', summary: 'sdk path', affectedFiles: [] };
  const sdkResult = { structured_output: preferred };

  let warnCount = 0;
  const opts = { warn: () => { warnCount++; } };

  extractStructured(sdkResult, opts);

  assert.strictEqual(warnCount, 0, `Expected opts.warn NOT to be called, but it was called ${warnCount} time(s)`);
});

// --- TC6: Null when neither field present ---
await test('TC6: extractStructured returns null when neither structured_output nor _capturedStructuredOutput is present', () => {
  const sdkResult = { result: 'PASSED (prose only)' };
  const result = extractStructured(sdkResult);
  assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
});

await test('TC6b: extractStructured returns null when sdkResult is null', () => {
  const result = extractStructured(null);
  assert.strictEqual(result, null, 'Expected null when sdkResult is null');
});

// --- TC7: End-to-end integration ---
await test('TC7: _dispatchEvent captures StructuredOutput tool_use, result event carries _capturedStructuredOutput, extractStructured returns it', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('test-e2e');

  const capturedPayload = { status: 'COMPLETED', summary: 'e2e test', affectedFiles: [{ path: 'foo.js', reason: 'updated' }] };

  // Step 1: assistant event with StructuredOutput tool_use
  const assistantEvent = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Here is the structured output.' },
        { type: 'tool_use', id: 'tu_so', name: 'StructuredOutput', input: capturedPayload },
      ],
    },
  };
  sm._dispatchEvent(handle, assistantEvent);

  // Verify handle captured the payload
  assert.deepStrictEqual(
    handle._capturedStructuredOutput,
    capturedPayload,
    'handle._capturedStructuredOutput should be set after assistant event'
  );

  // Step 2: result event WITHOUT structured_output (SDK did not populate it)
  const resultEvent = {
    type: 'result',
    // no structured_output field
    total_cost_usd: 0.001,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  sm._dispatchEvent(handle, resultEvent);

  // Verify the result event was decorated with _capturedStructuredOutput
  assert.deepStrictEqual(
    resultEvent._capturedStructuredOutput,
    capturedPayload,
    'result event should be decorated with _capturedStructuredOutput when structured_output is absent'
  );

  // Step 3: extractStructured should return the captured payload
  let warnFired = false;
  const extracted = extractStructured(resultEvent, { warn: () => { warnFired = true; } });

  assert.deepStrictEqual(
    extracted,
    capturedPayload,
    `extractStructured should return the captured payload. Got: ${JSON.stringify(extracted)}`
  );

  // Fallback path should have triggered a warning
  assert.strictEqual(warnFired, true, 'opts.warn should have been called during fallback in end-to-end flow');
});

// ─── TC-edge-1: null vs undefined distinguishable by warn message ─────────────
await test('TC-edge-1a: structured_output=null → returns null + warns with "null"', () => {
  const warns = [];
  const opts = { warn: (msg) => warns.push(msg) };
  const result = extractStructured({ structured_output: null }, opts);
  assert.strictEqual(result, null, 'Expected null for structured_output=null');
  assert.strictEqual(warns.length, 1, `Expected exactly 1 warning, got ${warns.length}`);
  assert.ok(
    warns[0].toLowerCase().includes('null'),
    `Warning should mention "null", got: "${warns[0]}"`
  );
});

await test('TC-edge-1b: {} (no structured_output key) → falls through to fallback path (no null warn)', () => {
  const warns = [];
  const opts = { warn: (msg) => warns.push(msg) };
  // No structured_output key at all — should try fallback, find nothing, return null with zero warns
  const result = extractStructured({}, opts);
  assert.strictEqual(result, null, 'Expected null when neither field present');
  // Must NOT have fired a "null" warn (that only fires when structured_output is explicitly null)
  const nullWarn = warns.find((m) => m.toLowerCase().includes('null'));
  assert.strictEqual(nullWarn, undefined, `Should not emit a null-specific warn on fallback miss, got: ${JSON.stringify(warns)}`);
});

// ─── TC-edge-2: undefined structured_output + _capturedStructuredOutput ───────
await test('TC-edge-2: no structured_output key + _capturedStructuredOutput → returns captured + single fallback warn', () => {
  const warns = [];
  const opts = { warn: (msg) => warns.push(msg) };
  const captured = { a: 1 };
  const result = extractStructured({ _capturedStructuredOutput: captured }, opts);
  assert.deepStrictEqual(result, captured, 'Expected _capturedStructuredOutput to be returned');
  assert.strictEqual(warns.length, 1, `Expected exactly 1 fallback warning, got ${warns.length}`);
});

// ─── TC-edge-3: structured_output={} is valid ─────────────────────────────────
await test('TC-edge-3: structured_output={} is a valid empty object → returns {} with zero warnings', () => {
  const warns = [];
  const opts = { warn: (msg) => warns.push(msg) };
  const emptyObj = {};
  const result = extractStructured({ structured_output: emptyObj }, opts);
  assert.deepStrictEqual(result, emptyObj, 'Expected empty object to be returned');
  assert.strictEqual(warns.length, 0, `Expected zero warnings, got ${warns.length}: ${JSON.stringify(warns)}`);
});

// ─── TC-edge-4: fake stream — LAST-wins end-to-end via extractStructured ───────
await test('TC-edge-4: fake stream two StructuredOutput tool_use blocks → extractStructured returns LAST payload', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('test-edge-4-last-wins');

  const firstPayload  = { status: 'BLOCKED',   summary: 'first attempt' };
  const secondPayload = { status: 'COMPLETED',  summary: 'final answer' };

  // Feed an assistant event with two StructuredOutput tool_use blocks
  sm._dispatchEvent(handle, {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'StructuredOutput', input: firstPayload },
        { type: 'tool_use', id: 'tu_2', name: 'StructuredOutput', input: secondPayload },
      ],
    },
  });

  // Feed a result event with no structured_output (SDK did not populate it)
  const resultEvent = { type: 'result', total_cost_usd: 0.001 };
  sm._dispatchEvent(handle, resultEvent);

  // extractStructured should return the SECOND payload via the fallback path
  const warns = [];
  const extracted = extractStructured(resultEvent, { warn: (msg) => warns.push(msg) });

  assert.deepStrictEqual(
    extracted,
    secondPayload,
    `Expected second payload (LAST-wins). Got: ${JSON.stringify(extracted)}`
  );
});

// ─── TC-edge-5: spawn() rejection → no captured leak ──────────────────────────
await test('TC-edge-5: spawn() rejects → handle._result is null and extractStructured returns null', async () => {
  const sm = new SessionManager();

  // Override _queryFn to return an async iterable that throws immediately
  sm._queryFn = function() {
    return {
      [Symbol.asyncIterator]() {
        return {
          next() { return Promise.reject(new Error('simulated query failure')); },
        };
      },
    };
  };

  const promise = sm.spawn({ name: 'test-edge-5-reject', prompt: 'hello', systemPrompt: 'sys' });
  promise.catch(() => {}); // suppress unhandled-rejection noise

  // Manually set a _capturedStructuredOutput on the handle BEFORE the error fires
  // to simulate a partial stream where some content was captured but session errored
  const handle = promise.handle;
  handle._capturedStructuredOutput = { status: 'COMPLETED', summary: 'should not leak' };

  let rejected = false;
  try {
    await promise;
  } catch (_err) {
    rejected = true;
  }

  assert.strictEqual(rejected, true, 'Expected promise to reject');
  // handle._result should be null (never set because error path doesn't populate it)
  assert.strictEqual(handle._result, null, `Expected handle._result to be null, got: ${JSON.stringify(handle._result)}`);

  // extractStructured on a null result must return null — even though _capturedStructuredOutput exists on handle
  const extracted = extractStructured(handle._result);
  assert.strictEqual(extracted, null, 'extractStructured(null) should return null — no captured leak');
});

// ─── TC-edge-6: extractStructured(undefined) and extractStructured(null) ──────
await test('TC-edge-6: extractStructured(undefined) → null with zero warnings', () => {
  const warns = [];
  const result = extractStructured(undefined, { warn: (msg) => warns.push(msg) });
  assert.strictEqual(result, null, 'Expected null for undefined input');
  assert.strictEqual(warns.length, 0, `Expected zero warnings, got ${warns.length}`);
});

await test('TC-edge-6b: extractStructured(null) → null with zero warnings', () => {
  const warns = [];
  const result = extractStructured(null, { warn: (msg) => warns.push(msg) });
  assert.strictEqual(result, null, 'Expected null for null input');
  assert.strictEqual(warns.length, 0, `Expected zero warnings, got ${warns.length}`);
});

// ─── TC-edge-7: non-object structured_output ──────────────────────────────────
await test('TC-edge-7: structured_output=42 → null + exactly one warn mentioning "malformed" or type name', () => {
  const warns = [];
  const opts = { warn: (msg) => warns.push(msg) };
  const result = extractStructured({ structured_output: 42 }, opts);
  assert.strictEqual(result, null, 'Expected null for non-object structured_output');
  assert.strictEqual(warns.length, 1, `Expected exactly 1 warning, got ${warns.length}`);
  const mentionsMalformedOrType = warns[0].toLowerCase().includes('malformed') || warns[0].includes('number');
  assert.ok(
    mentionsMalformedOrType,
    `Warning should mention "malformed" or the type name "number", got: "${warns[0]}"`
  );
});

// --- Summary ---
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
