/**
 * test-session-manager-classify-wiring.js — Tests that classifyError() is wired
 * into spawn()'s catch block and ReusableSession._consumeEvents()'s catch block.
 *
 * Covers:
 *   1. spawn() rejects with InfrastructureError (not raw SDK error) when query() throws RateLimitError
 *   2. spawn() emits 'error' event with InfrastructureError on handle
 *   3. ReusableSession._consumeEvents stores InfrastructureError as this._error when SDK iterator throws
 *   4. ReusableSession._consumeEvents emits 'error' with InfrastructureError on handle
 *   5. Subsequent sendPrompt() calls after _consumeEvents error reject with InfrastructureError
 *   6. Non-SDK errors (e.g. TypeError) are still wrapped as InfrastructureError with category 'unknown'
 *
 * Run: node test/test-session-manager-classify-wiring.js
 */
import assert from 'assert';
import {
  RateLimitError,
  APIConnectionError,
} from '@anthropic-ai/sdk';
import {
  SessionManager,
  SessionHandle,
  ReusableSession,
  InfrastructureError,
  classifyError,
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an async generator that throws the given error immediately.
 */
async function* throwingGenerator(err) {
  throw err;
}

/**
 * Create a bare ReusableSession (bypasses constructor + real SDK call) suitable
 * for directly calling _consumeEvents() with a custom async generator.
 */
function makeBareReusableSession(sm) {
  const session = Object.create(ReusableSession.prototype);
  session._sessionManager = sm;
  session._options = { name: 'bare-test' };
  session._pendingResults = [];
  session._turnCount = 0;
  session._closed = false;
  session._error = null;
  session.handle = new SessionHandle('bare-test');
  // Register the handle in the session manager's _active map so the
  // _consumeEvents finally block can delete it.
  sm._active.set(session.handle.name, session.handle);
  return session;
}

// ---------------------------------------------------------------------------
// TC1: spawn() rejects with InfrastructureError when query() throws RateLimitError
// ---------------------------------------------------------------------------

await test('TC1: spawn() rejects with InfrastructureError when query() throws RateLimitError', async () => {
  const sm = new SessionManager();
  const rateLimitErr = new RateLimitError(
    429,
    { error: { type: 'rate_limit_error', message: 'You are being rate limited' } },
    'You are being rate limited',
    new Headers()
  );

  // Inject a fake _queryFn that returns a generator which immediately throws
  sm._queryFn = () => throwingGenerator(rateLimitErr);

  let rejected = null;
  try {
    await sm.spawn({ name: 'tc1-spawn', prompt: 'hello' });
  } catch (err) {
    rejected = err;
  }

  assert.ok(rejected !== null, 'Expected spawn() to reject');
  assert.ok(
    rejected instanceof InfrastructureError,
    `Expected InfrastructureError, got ${rejected?.constructor?.name}: ${rejected?.message}`
  );
  assert.strictEqual(rejected.category, 'rate_limit', `Expected category 'rate_limit', got '${rejected.category}'`);
  assert.strictEqual(rejected.retryable, true, `Expected retryable=true, got ${rejected.retryable}`);
  assert.strictEqual(rejected.cause, rateLimitErr, 'Expected cause to be the original RateLimitError');
});

// ---------------------------------------------------------------------------
// TC2: spawn() emits 'error' event with InfrastructureError on handle
// ---------------------------------------------------------------------------

await test('TC2: spawn() emits error event with InfrastructureError on handle', async () => {
  const sm = new SessionManager();
  const rateLimitErr = new RateLimitError(
    429,
    { error: { type: 'rate_limit_error', message: 'rate limited' } },
    'rate limited',
    new Headers()
  );

  sm._queryFn = () => throwingGenerator(rateLimitErr);

  const promise = sm.spawn({ name: 'tc2-spawn', prompt: 'hello' });
  const handle = promise.handle;

  let emittedError = null;
  handle.on('error', (err) => { emittedError = err; });

  // Await (we expect it to reject)
  try { await promise; } catch { /* expected */ }

  assert.ok(emittedError !== null, 'Expected error event to be emitted on handle');
  assert.ok(
    emittedError instanceof InfrastructureError,
    `Expected InfrastructureError in error event, got ${emittedError?.constructor?.name}`
  );
  assert.strictEqual(
    emittedError.category, 'rate_limit',
    `Expected 'rate_limit', got '${emittedError.category}'`
  );
});

// ---------------------------------------------------------------------------
// TC3: ReusableSession._consumeEvents stores InfrastructureError as this._error
// ---------------------------------------------------------------------------

await test('TC3: _consumeEvents stores InfrastructureError as this._error when SDK iterator throws', async () => {
  const sm = new SessionManager();
  const connErr = new APIConnectionError({ message: 'connection refused' });

  const session = makeBareReusableSession(sm);
  await session._consumeEvents(throwingGenerator(connErr));

  assert.ok(
    session._error instanceof InfrastructureError,
    `Expected InfrastructureError stored as this._error, got ${session._error?.constructor?.name}`
  );
  assert.strictEqual(
    session._error.category, 'network',
    `Expected category 'network', got '${session._error.category}'`
  );
  assert.strictEqual(
    session._error.retryable, true,
    `Expected retryable=true, got ${session._error.retryable}`
  );
  assert.strictEqual(session._error.cause, connErr, 'Expected cause to be the original APIConnectionError');
});

// ---------------------------------------------------------------------------
// TC4: ReusableSession._consumeEvents emits 'error' with InfrastructureError on handle
// ---------------------------------------------------------------------------

await test('TC4: _consumeEvents emits InfrastructureError on handle', async () => {
  const sm = new SessionManager();
  const connErr = new APIConnectionError({ message: 'network timeout' });

  const session = makeBareReusableSession(sm);

  let emittedError = null;
  session.handle.on('error', (err) => { emittedError = err; });

  await session._consumeEvents(throwingGenerator(connErr));

  assert.ok(emittedError !== null, 'Expected error event to be emitted on handle');
  assert.ok(
    emittedError instanceof InfrastructureError,
    `Expected InfrastructureError in emitted error, got ${emittedError?.constructor?.name}`
  );
  assert.strictEqual(
    emittedError.category, 'network',
    `Expected 'network', got '${emittedError.category}'`
  );
});

// ---------------------------------------------------------------------------
// TC5: Subsequent sendPrompt() calls after _consumeEvents error reject with InfrastructureError
// ---------------------------------------------------------------------------

await test('TC5: sendPrompt() after _consumeEvents error rejects with InfrastructureError', async () => {
  const sm = new SessionManager();
  const connErr = new APIConnectionError({ message: 'lost connection' });

  const session = makeBareReusableSession(sm);
  // Set error and closed states to simulate post-error condition
  await session._consumeEvents(throwingGenerator(connErr));

  // Now attempt sendPrompt — _error is set, should throw
  let sendError = null;
  try {
    await session.sendPrompt('any prompt');
  } catch (err) {
    sendError = err;
  }

  assert.ok(sendError !== null, 'Expected sendPrompt() to throw after error');
  // sendPrompt throws a plain Error wrapping the message, but the stored _error
  // must be an InfrastructureError.
  assert.ok(
    session._error instanceof InfrastructureError,
    `Expected _error to be InfrastructureError, got ${session._error?.constructor?.name}`
  );
  // The thrown error from sendPrompt is a generic Error wrapping the message
  assert.ok(
    sendError.message.includes('session errored'),
    `Expected "session errored" in message, got: ${sendError.message}`
  );
});

// ---------------------------------------------------------------------------
// TC6: Non-SDK errors (e.g. TypeError) are wrapped as InfrastructureError category 'unknown'
// ---------------------------------------------------------------------------

await test('TC6: Non-SDK TypeError is wrapped as InfrastructureError with category "unknown"', async () => {
  const sm = new SessionManager();

  // Test via _consumeEvents with a plain TypeError
  const typeErr = new TypeError('Cannot read property of undefined');
  const session = makeBareReusableSession(sm);
  await session._consumeEvents(throwingGenerator(typeErr));

  assert.ok(
    session._error instanceof InfrastructureError,
    `Expected InfrastructureError, got ${session._error?.constructor?.name}`
  );
  assert.strictEqual(
    session._error.category, 'unknown',
    `Expected category 'unknown', got '${session._error.category}'`
  );
  assert.strictEqual(
    session._error.retryable, false,
    `Expected retryable=false for unknown error, got ${session._error.retryable}`
  );
  assert.strictEqual(session._error.cause, typeErr, 'Expected cause to be the original TypeError');
});

await test('TC6b: spawn() with non-SDK TypeError rejects with InfrastructureError category "unknown"', async () => {
  const sm = new SessionManager();
  const typeErr = new TypeError('Something unexpected broke');
  sm._queryFn = () => throwingGenerator(typeErr);

  let rejected = null;
  try {
    await sm.spawn({ name: 'tc6b-spawn', prompt: 'hello' });
  } catch (err) {
    rejected = err;
  }

  assert.ok(rejected instanceof InfrastructureError, `Expected InfrastructureError, got ${rejected?.constructor?.name}`);
  assert.strictEqual(rejected.category, 'unknown', `Expected 'unknown', got '${rejected.category}'`);
  assert.strictEqual(rejected.retryable, false, `Expected retryable=false, got ${rejected.retryable}`);
  assert.strictEqual(rejected.cause, typeErr, 'Expected cause to be the original TypeError');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
