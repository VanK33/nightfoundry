/**
 * test-classify-result.js — Unit tests for classifyResult() and its wiring
 * into SessionManager.spawn().
 *
 * Covers:
 *   TC-CR-TIMEOUT-APIMS   : zero api_ms + zero tokens + is_error → retryable network InfrastructureError
 *   TC-CR-TIMEOUT-MSG     : transport message pattern match → retryable InfrastructureError
 *   TC-CR-SEMANTIC-PASSTHROUGH : semantic is_error (API time + output tokens) → null
 *   TC-CR-SUCCESS-PASSTHROUGH  : normal success result → null
 *   TC-CR-SPAWN-THROWS    : spawn() rejects with retryable InfrastructureError when SDK yields transport-timeout result event
 *
 * Run: node test/test-classify-result.js
 */
import assert from 'assert';
import {
  SessionManager,
  InfrastructureError,
  classifyResult,
} from '../src/orchestrator/infra/session-manager.js';

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

// ---------------------------------------------------------------------------
// TC-CR-TIMEOUT-APIMS: zero api_ms + zero tokens + is_error
// ---------------------------------------------------------------------------

await test('TC-CR-TIMEOUT-APIMS: zero api_ms + zero output tokens returns retryable network InfrastructureError', async () => {
  const result = classifyResult({
    is_error: true,
    result: 'Request timed out',
    duration_api_ms: 0,
    usage: { output_tokens: 0 },
  });

  assert.ok(
    result instanceof InfrastructureError,
    `Expected InfrastructureError, got ${result?.constructor?.name ?? 'null'}`
  );
  assert.strictEqual(result.category, 'network', `Expected category 'network', got '${result.category}'`);
  assert.strictEqual(result.retryable, true, `Expected retryable=true, got ${result.retryable}`);
});

// ---------------------------------------------------------------------------
// TC-CR-TIMEOUT-MSG: message matches transport pattern despite api_ms !== 0
// ---------------------------------------------------------------------------

await test('TC-CR-TIMEOUT-MSG: fetch failed ECONNRESET message returns retryable InfrastructureError', async () => {
  const result = classifyResult({
    is_error: true,
    result: 'fetch failed: ECONNRESET',
    duration_api_ms: 12,
    usage: { output_tokens: 0 },
  });

  assert.ok(
    result instanceof InfrastructureError,
    `Expected InfrastructureError, got ${result?.constructor?.name ?? 'null'}`
  );
  assert.strictEqual(result.category, 'network', `Expected category 'network', got '${result.category}'`);
  assert.strictEqual(result.retryable, true, `Expected retryable=true, got ${result.retryable}`);
});

// ---------------------------------------------------------------------------
// TC-CR-SEMANTIC-PASSTHROUGH: is_error but has API time and output tokens → null
// ---------------------------------------------------------------------------

await test('TC-CR-SEMANTIC-PASSTHROUGH: semantic is_error with API time + output tokens returns null', async () => {
  const result = classifyResult({
    is_error: true,
    result: 'stopped at max_tokens',
    duration_api_ms: 4200,
    usage: { output_tokens: 1800 },
  });

  assert.strictEqual(result, null, `Expected null, got ${result?.constructor?.name ?? result}`);
});

// ---------------------------------------------------------------------------
// TC-CR-SUCCESS-PASSTHROUGH: normal success result → null
// ---------------------------------------------------------------------------

await test('TC-CR-SUCCESS-PASSTHROUGH: normal success result returns null', async () => {
  const result = classifyResult({
    is_error: false,
    result: '{...}',
    duration_api_ms: 3000,
    usage: { output_tokens: 900 },
  });

  assert.strictEqual(result, null, `Expected null, got ${result?.constructor?.name ?? result}`);
});

// ---------------------------------------------------------------------------
// TC-CR-SPAWN-THROWS: spawn() rejects with InfrastructureError for transport-timeout result event
// ---------------------------------------------------------------------------

await test('TC-CR-SPAWN-THROWS: spawn() rejects with retryable InfrastructureError when SDK yields transport-timeout result event', async () => {
  const sm = new SessionManager();

  // Async generator that yields a result event matching the transport-timeout pattern
  async function* timeoutResultGenerator() {
    yield {
      type: 'result',
      is_error: true,
      result: 'Request timed out',
      duration_api_ms: 0,
      usage: { output_tokens: 0 },
      total_cost_usd: 0,
    };
  }

  sm._queryFn = () => timeoutResultGenerator();

  let rejected = null;
  try {
    await sm.spawn({ name: 'tc-spawn', prompt: 'hello' });
  } catch (err) {
    rejected = err;
  }

  assert.ok(rejected !== null, 'Expected spawn() to reject but it resolved');
  assert.ok(
    rejected instanceof InfrastructureError,
    `Expected InfrastructureError, got ${rejected?.constructor?.name}: ${rejected?.message}`
  );
  assert.strictEqual(rejected.retryable, true, `Expected retryable=true, got ${rejected.retryable}`);
  assert.strictEqual(rejected.category, 'network', `Expected category 'network', got '${rejected.category}'`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
