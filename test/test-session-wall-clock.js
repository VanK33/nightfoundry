/**
 * test-session-wall-clock.js — Unit tests for WallClockExceededError and wall-clock timer behavior.
 *
 * Covers:
 *   TC1: WallClockExceededError has correct fields
 *   TC2: WallClockExceededError is not instanceof InfrastructureError
 *   TC3: config.execution.maxSessionWallClockMs equals 2700000
 *   TC4: spawn() clears wall-clock timer on normal exit
 *   TC5: spawn() throws WallClockExceededError when wall-clock fires
 *   TC6: WallClockExceededError is exported from session-manager.js
 *   TC7: ReusableSession wall-clock aborts a hard-stalled session without hanging
 *   TC8: ReusableSession abort via signal rejects pending send with AbortError, close() does not hang
 *
 * Run: node test/test-session-wall-clock.js
 */
import assert from 'assert';
import { SessionManager, InfrastructureError, WallClockExceededError } from '../src/orchestrator/infra/session-manager.js';
import config from '../src/orchestrator/infra/config.js';

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

// --- TC1: WallClockExceededError has correct fields ---
await test('TC1: WallClockExceededError has correct fields', () => {
  const err = new WallClockExceededError('session exceeded wall-clock limit');
  assert.strictEqual(err.name, 'WallClockExceededError', `Expected name 'WallClockExceededError', got '${err.name}'`);
  assert.strictEqual(err.retryable, false, `Expected retryable false, got ${err.retryable}`);
  assert.strictEqual(err.category, 'wall-clock-exceeded', `Expected category 'wall-clock-exceeded', got '${err.category}'`);
});

// --- TC2: WallClockExceededError is not instanceof InfrastructureError ---
await test('TC2: WallClockExceededError is not instanceof InfrastructureError', () => {
  const err = new WallClockExceededError('exceeded');
  assert.ok(err instanceof Error, 'Expected WallClockExceededError to be instanceof Error');
  assert.ok(!(err instanceof InfrastructureError), 'Expected WallClockExceededError to NOT be instanceof InfrastructureError');
});

// --- TC3: config.execution.maxSessionWallClockMs equals 2700000 ---
await test('TC3: config.execution.maxSessionWallClockMs equals 2700000', () => {
  assert.strictEqual(
    config.execution.maxSessionWallClockMs,
    2700000,
    `Expected 2700000, got ${config.execution.maxSessionWallClockMs}`
  );
});

// --- TC4: spawn() clears wall-clock timer on normal exit ---
await test('TC4: spawn() clears wall-clock timer on normal exit', async () => {
  const sm = new SessionManager();

  // Mock _queryFn that yields a result event immediately
  sm._queryFn = () => {
    let step = 0;
    const events = [
      { type: 'result', subtype: 'success', result: 'done' },
    ];
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (step < events.length) return { value: events[step++], done: false };
            return { value: undefined, done: true };
          },
        };
      },
    };
  };

  const { handle } = await sm.spawn({ name: 'tc4-wall-clock-clear', prompt: 'test' });

  assert.strictEqual(
    handle._wallClockTimer,
    null,
    `Expected handle._wallClockTimer to be null after normal exit, got ${handle._wallClockTimer}`
  );
});

// --- TC5: spawn() throws WallClockExceededError when wall-clock fires ---
await test('TC5: spawn() throws WallClockExceededError when wall-clock fires', async () => {
  const sm = new SessionManager();

  // Mock _queryFn that hangs (never yields a result event).
  // It supports return() so the wall-clock timer can close the iterator.
  // A ref'd keep-alive timer is used to hold the event loop open so the
  // unref'd 1ms wall-clock timer in spawn() has a chance to fire.
  sm._queryFn = () => {
    let hangResolve = null;
    let keepAliveTimer = null;
    let done = false;

    function resolveHang() {
      // Clear the ref'd keep-alive timer so Node can exit once done
      if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; }
      done = true;
      if (hangResolve) {
        hangResolve({ value: undefined, done: true });
        hangResolve = null;
      }
    }

    const iterator = {
      next() {
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          hangResolve = resolve;
          // Keep the event loop alive (ref'd) so the unref'd wall-clock
          // timer in spawn() can fire and call q.return()
          keepAliveTimer = setTimeout(() => {}, 10000);
        });
      },
      return() { resolveHang(); return Promise.resolve({ value: undefined, done: true }); },
    };

    const q = {
      // Wall-clock timer calls handle._query?.return?.()
      return() { resolveHang(); return Promise.resolve({ value: undefined, done: true }); },
      [Symbol.asyncIterator]() { return iterator; },
    };

    return q;
  };

  // Override wall-clock limit to 50ms so the timer fires reliably
  // (1ms is too tight — Date.now() resolution may cause the elapsed check
  // to see 0ms before the timer callback runs in the macrotask queue)
  const originalMs = config.execution.maxSessionWallClockMs;
  config.execution.maxSessionWallClockMs = 50;
  try {
    await sm.spawn({ name: 'tc5-wall-clock-exceeded', prompt: 'test' });
    assert.fail('Expected spawn() to reject with WallClockExceededError');
  } catch (err) {
    assert.strictEqual(
      err.name,
      'WallClockExceededError',
      `Expected WallClockExceededError, got ${err.name}: ${err.message}`
    );
    assert.ok(err instanceof WallClockExceededError, 'Expected err to be instanceof WallClockExceededError');
  } finally {
    config.execution.maxSessionWallClockMs = originalMs;
  }
});

// --- TC6: WallClockExceededError is exported from session-manager.js ---
await test('TC6: WallClockExceededError is exported from session-manager.js', () => {
  assert.strictEqual(
    typeof WallClockExceededError,
    'function',
    `Expected WallClockExceededError to be a function (class), got ${typeof WallClockExceededError}`
  );
});

// --- TC7: ReusableSession wall-clock aborts a hard-stalled session without hanging ---
await test('TC7: ReusableSession wall-clock aborts a hard-stalled session without hanging', async () => {
  const sm = new SessionManager();

  // Hard-stalling generator: never yields a result, supports return() so
  // the wall-clock terminate() can tear it down. A ref'd keep-alive timer
  // (cleared on return()) holds the loop open so the unref'd wall-clock
  // timer can fire — mirrors the TC5 mock.
  sm._queryFn = () => {
    let hangResolve = null;
    let keepAliveTimer = null;
    let done = false;
    function resolveHang() {
      if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; }
      done = true;
      if (hangResolve) { hangResolve({ value: undefined, done: true }); hangResolve = null; }
    }
    const iterator = {
      next() {
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          hangResolve = resolve;
          keepAliveTimer = setTimeout(() => {}, 10000);
        });
      },
      return() { resolveHang(); return Promise.resolve({ value: undefined, done: true }); },
    };
    return {
      return() { resolveHang(); return Promise.resolve({ value: undefined, done: true }); },
      [Symbol.asyncIterator]() { return iterator; },
    };
  };

  const originalMs = config.execution.maxSessionWallClockMs;
  config.execution.maxSessionWallClockMs = 50;
  try {
    const session = sm.spawnReusable({ name: 'tc7-reusable-wall-clock', prompt: 'test' });
    const start = Date.now();
    let sendErr = null;
    try {
      await session.sendPrompt('test');
    } catch (err) { sendErr = err; }
    const sendElapsed = Date.now() - start;

    assert.ok(
      sendErr instanceof WallClockExceededError,
      `Expected sendPrompt to reject with WallClockExceededError, got ${sendErr?.constructor?.name}: ${sendErr?.message}`
    );
    assert.ok(sendElapsed < 2000, `Expected sendPrompt to reject promptly, took ${sendElapsed}ms`);

    // close() awaits _consumerPromise — previously this would hang on the
    // stalled generator. It must now return promptly.
    const closeStart = Date.now();
    await session.close();
    assert.ok(Date.now() - closeStart < 2000, `Expected close() to return promptly, took ${Date.now() - closeStart}ms`);

    // No ghost handle left in _active after the wall-clock abort.
    assert.ok(
      !sm._active.has('tc7-reusable-wall-clock'),
      'Expected the session handle to be removed from _active after wall-clock abort'
    );
  } finally {
    config.execution.maxSessionWallClockMs = originalMs;
  }
});

// --- TC8: ReusableSession abort via signal rejects pending send with AbortError, close() does not hang ---
await test('TC8: ReusableSession abort via signal rejects pending send with AbortError, close() does not hang', async () => {
  const sm = new SessionManager();
  const controller = new AbortController();

  // Hard-stalling generator (same shape as TC7) — here abort, not wall-clock,
  // is what must tear it down.
  sm._queryFn = () => {
    let hangResolve = null;
    let keepAliveTimer = null;
    let done = false;
    function resolveHang() {
      if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; }
      done = true;
      if (hangResolve) { hangResolve({ value: undefined, done: true }); hangResolve = null; }
    }
    const iterator = {
      next() {
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          hangResolve = resolve;
          keepAliveTimer = setTimeout(() => {}, 10000);
        });
      },
      return() { resolveHang(); return Promise.resolve({ value: undefined, done: true }); },
    };
    return {
      return() { resolveHang(); return Promise.resolve({ value: undefined, done: true }); },
      [Symbol.asyncIterator]() { return iterator; },
    };
  };

  const session = sm.spawnReusable({ name: 'tc8-reusable-abort', prompt: 'test', signal: controller.signal });

  let sendErr = null;
  const sendPromise = session.sendPrompt('test').catch((err) => { sendErr = err; });
  // Fire the abort after the send is parked in _pendingResults.
  setTimeout(() => controller.abort(), 20);
  await sendPromise;

  assert.ok(
    sendErr instanceof DOMException && sendErr.name === 'AbortError',
    `Expected pending send to reject with AbortError, got ${sendErr?.constructor?.name}: ${sendErr?.name} (${sendErr?.message})`
  );

  // close() must not hang on the stalled generator after an abort.
  const closeStart = Date.now();
  await session.close();
  assert.ok(Date.now() - closeStart < 2000, `Expected close() to return promptly after abort, took ${Date.now() - closeStart}ms`);

  assert.ok(
    !sm._active.has('tc8-reusable-abort'),
    'Expected the session handle to be removed from _active after abort'
  );
});

// --- Summary ---
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
