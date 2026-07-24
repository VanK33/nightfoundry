/**
 * test-session-manager-infrastructure-error.js — Unit tests for InfrastructureError and classifyError.
 *
 * Covers:
 *   1. InfrastructureError is a proper Error subclass (instanceof Error === true)
 *   2. InfrastructureError stores category, retryable, statusCode, and original cause
 *   3. classifyError(new RateLimitError(...)) → category 'rate_limit', retryable true
 *   4. classifyError(new APIConnectionError(...)) → category 'network', retryable true
 *   5. classifyError(new AuthenticationError(...)) → category 'auth', retryable false
 *   6. classifyError(new InternalServerError(...)) → category 'server', retryable true
 *   7. classifyError(new Error('random')) → category 'unknown', retryable false
 *   8. classifyError preserves original error as .cause
 *
 * Run: node test/test-session-manager-infrastructure-error.js
 */
import assert from 'assert';
import {
  RateLimitError,
  APIConnectionError,
  AuthenticationError,
  InternalServerError,
} from '@anthropic-ai/sdk';
import { InfrastructureError, classifyError } from '../src/orchestrator/infra/session-manager.js';

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

// --- Test 1: InfrastructureError is a proper Error subclass ---
await test('InfrastructureError instanceof Error === true', () => {
  const err = new InfrastructureError('test', {
    category: 'unknown',
    retryable: false,
    statusCode: undefined,
    cause: new Error('original'),
  });
  assert.ok(err instanceof Error, 'Expected InfrastructureError to be instanceof Error');
  assert.ok(err instanceof InfrastructureError, 'Expected InfrastructureError to be instanceof InfrastructureError');
});

// --- Test 2: InfrastructureError stores all fields ---
await test('InfrastructureError stores category, retryable, statusCode, and cause', () => {
  const original = new Error('root cause');
  const err = new InfrastructureError('infra msg', {
    category: 'server',
    retryable: true,
    statusCode: 500,
    cause: original,
  });
  assert.strictEqual(err.message, 'infra msg', `Expected 'infra msg', got '${err.message}'`);
  assert.strictEqual(err.category, 'server', `Expected 'server', got '${err.category}'`);
  assert.strictEqual(err.retryable, true, `Expected true, got ${err.retryable}`);
  assert.strictEqual(err.statusCode, 500, `Expected 500, got ${err.statusCode}`);
  assert.strictEqual(err.cause, original, 'Expected cause to be the original error');
});

// --- Test 3: classifyError with RateLimitError ---
await test("classifyError(RateLimitError) → category 'rate_limit', retryable true", () => {
  const sdkErr = new RateLimitError(429, { error: { type: 'rate_limit_error', message: 'rate limited' } }, 'rate limited', new Headers());
  const result = classifyError(sdkErr);
  assert.ok(result instanceof InfrastructureError, 'Expected InfrastructureError');
  assert.strictEqual(result.category, 'rate_limit', `Expected 'rate_limit', got '${result.category}'`);
  assert.strictEqual(result.retryable, true, `Expected true, got ${result.retryable}`);
});

// --- Test 4: classifyError with APIConnectionError ---
await test("classifyError(APIConnectionError) → category 'network', retryable true", () => {
  const sdkErr = new APIConnectionError({ message: 'connection failed' });
  const result = classifyError(sdkErr);
  assert.ok(result instanceof InfrastructureError, 'Expected InfrastructureError');
  assert.strictEqual(result.category, 'network', `Expected 'network', got '${result.category}'`);
  assert.strictEqual(result.retryable, true, `Expected true, got ${result.retryable}`);
});

// --- Test 5: classifyError with AuthenticationError ---
await test("classifyError(AuthenticationError) → category 'auth', retryable false", () => {
  const sdkErr = new AuthenticationError(401, { error: { type: 'authentication_error', message: 'invalid key' } }, 'invalid key', new Headers());
  const result = classifyError(sdkErr);
  assert.ok(result instanceof InfrastructureError, 'Expected InfrastructureError');
  assert.strictEqual(result.category, 'auth', `Expected 'auth', got '${result.category}'`);
  assert.strictEqual(result.retryable, false, `Expected false, got ${result.retryable}`);
});

// --- Test 6: classifyError with InternalServerError ---
await test("classifyError(InternalServerError) → category 'server', retryable true", () => {
  const sdkErr = new InternalServerError(500, { error: { type: 'api_error', message: 'internal error' } }, 'internal error', new Headers());
  const result = classifyError(sdkErr);
  assert.ok(result instanceof InfrastructureError, 'Expected InfrastructureError');
  assert.strictEqual(result.category, 'server', `Expected 'server', got '${result.category}'`);
  assert.strictEqual(result.retryable, true, `Expected true, got ${result.retryable}`);
});

// --- Test 7: classifyError with plain Error ---
await test("classifyError(new Error('random')) → category 'unknown', retryable false", () => {
  const plainErr = new Error('random error');
  const result = classifyError(plainErr);
  assert.ok(result instanceof InfrastructureError, 'Expected InfrastructureError');
  assert.strictEqual(result.category, 'unknown', `Expected 'unknown', got '${result.category}'`);
  assert.strictEqual(result.retryable, false, `Expected false, got ${result.retryable}`);
});

// --- Test 8: classifyError preserves original error as .cause ---
await test('classifyError preserves original error as .cause', () => {
  const original = new Error('original error');
  const result = classifyError(original);
  assert.strictEqual(result.cause, original, 'Expected result.cause to be the original error');

  const sdkErr = new AuthenticationError(401, { error: { type: 'authentication_error', message: 'bad key' } }, 'bad key', new Headers());
  const result2 = classifyError(sdkErr);
  assert.strictEqual(result2.cause, sdkErr, 'Expected result.cause to be the SDK error');
});

// --- Summary ---
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
