/**
 * test-percall-wallclock.js — Acceptance tests for per-call wall-clock cap
 * semantics on ReusableSession (percall-wallclock.spec.md).
 *
 * The cap (config.execution.maxSessionWallClockMs) must measure each
 * outstanding call, NOT the session's lifetime: the timer is armed only
 * while at least one request is outstanding (empty→non-empty transition
 * of the pending-results queue), cleared when the queue empties, and a
 * fresh budget applies per armed window. Idle time never counts.
 *
 * Case inventory (mapped to spec acceptance criteria):
 *   TC1 (AC1): W2-F3 scenario — cumulative ACTIVE time across two calls
 *              crosses the cap mid-call-2; each call is under the cap, so
 *              call 2 must complete. RED at pre-fix HEAD (lifetime timer
 *              kills mid-call-2 — exactly how W2 entry 2 died).
 *   TC2 (AC1): session AGE (active + idle mix, no single span over the cap)
 *              exceeds the cap before a fresh short call arrives; the call
 *              must complete. RED at pre-fix HEAD.
 *   TC3 (AC2): a single call that exceeds the cap IS killed with
 *              WallClockExceededError (runaway protection). GREEN at HEAD,
 *              must stay green.
 *   TC4 (AC3): idle exemption — session idle LONGER than the cap between
 *              two calls is not killed; the second call completes. RED at
 *              pre-fix HEAD.
 *   TC5 (AC4): captured-reject guard race survives the re-scope — a
 *              hard-stalled generator during an ACTIVE second call is
 *              terminated by the timer; sendPrompt rejects promptly and
 *              close()/teardown do not hang. GREEN at HEAD, must stay green.
 *   TC6 (AC5): totalActiveMs/callCount accumulate on the session handle
 *              (idle excluded from totalActiveMs) and both appear in the
 *              teardown log. RED at pre-fix HEAD (fields do not exist).
 *
 * Fixture rules (spec constraint): only trigger conditions are stubbed —
 * scripted SDK generators echoing crafted result events per user message,
 * or hard-stalling like the TC5/TC7 mocks in test-session-wall-clock.js.
 * The timer logic and _consumeEvents are NEVER stubbed.
 *
 * Cap overrides follow the established pattern (test-session-wall-clock.js
 * TC5/TC7): set config.execution.maxSessionWallClockMs to a tiny value
 * BEFORE spawning, restore in finally. The config value is read at arm
 * time, so the override must stay in place until every prompt under test
 * has been dispatched.
 *
 * Run: node test/test-percall-wallclock.js
 */
import assert from 'assert';
import { SessionManager, WallClockExceededError } from '../src/orchestrator/infra/session-manager.js';
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scripted SDK generator factory. `script[i]` controls how the i-th user
 * message pushed by sendPrompt() is answered:
 *   { delayMs: n } — wait n ms (ref'd timer keeps the loop alive so the
 *                    unref'd wall-clock timer can fire mid-call), then
 *                    yield a crafted success result event.
 *   'stall'        — hard-stall: never yield. A ref'd 30s keep-alive timer
 *                    holds the event loop open so the unref'd wall-clock
 *                    timer can fire; return() tears the stall down. This
 *                    mirrors the TC5/TC7 hard-stall mocks in
 *                    test-session-wall-clock.js.
 *
 * The generator pulls real user messages from the PromptStream that
 * ReusableSession passes as `prompt`, so call boundaries (sendPrompt →
 * matching result event via _pendingResults) are exercised for real;
 * only the SDK side is faked.
 */
function makeScriptedQueryFn(script) {
  return ({ prompt }) => {
    const promptIter = prompt[Symbol.asyncIterator]();
    let msgIndex = 0;
    let hangResolve = null;
    let keepAliveTimer = null;
    let done = false;
    function resolveHang() {
      if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; }
      done = true;
      if (hangResolve) { hangResolve({ value: undefined, done: true }); hangResolve = null; }
    }
    const iterator = {
      async next() {
        if (done) return { value: undefined, done: true };
        const pulled = await promptIter.next();
        if (done || pulled.done) return { value: undefined, done: true };
        const step = script[msgIndex++] ?? { delayMs: 0 };
        if (step === 'stall') {
          return new Promise((resolve) => {
            hangResolve = resolve;
            keepAliveTimer = setTimeout(() => {}, 30000);
          });
        }
        if (step.delayMs > 0) await sleep(step.delayMs);
        if (done) return { value: undefined, done: true };
        return {
          value: { type: 'result', subtype: 'success', result: `ok-${msgIndex}`, usage: {} },
          done: false,
        };
      },
      return() { resolveHang(); return Promise.resolve({ value: undefined, done: true }); },
    };
    return {
      // terminate() calls handle._query?.return?.() — must unblock a stall.
      return() { resolveHang(); return Promise.resolve({ value: undefined, done: true }); },
      [Symbol.asyncIterator]() { return iterator; },
    };
  };
}

/** Capture everything written to stdout/stderr (passthrough preserved). */
function captureStdio() {
  const chunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...args) => { chunks.push(String(chunk)); return origOut(chunk, ...args); };
  process.stderr.write = (chunk, ...args) => { chunks.push(String(chunk)); return origErr(chunk, ...args); };
  return {
    stop() { process.stdout.write = origOut; process.stderr.write = origErr; },
    text() { return chunks.join(''); },
  };
}

// ── TC1 (AC1): W2-F3 — cumulative active time over the cap; fresh call survives ──
//
// cap = 500ms. Call 1 actively runs ~300ms, call 2 is dispatched right after
// and actively runs ~300ms. Each call is comfortably under the cap, but the
// session's birth-anchored elapsed crosses 500ms DURING call 2 — under the
// pre-fix lifetime semantics the timer kills call 2 mid-flight (W2 entry 2's
// exact death). Per percall-wallclock.spec.md, each call has a fresh budget,
// so call 2 must resolve.
await test('TC1 (AC1): cumulative active time exceeds cap — fresh short call is NOT killed (W2-F3)', async () => {
  const sm = new SessionManager();
  sm._queryFn = makeScriptedQueryFn([{ delayMs: 300 }, { delayMs: 300 }]);

  const originalMs = config.execution.maxSessionWallClockMs;
  config.execution.maxSessionWallClockMs = 500;
  const birth = Date.now();
  let session = null;
  try {
    session = sm.spawnReusable({ name: 'tc1-percall-w2f3' });

    const result1 = await session.sendPrompt('call 1');
    assert.strictEqual(result1.subtype, 'success', `Expected call 1 to succeed, got ${result1.subtype}`);

    // Dispatch call 2 immediately — cumulative ACTIVE time (~600ms) crosses
    // the 500ms cap while call 2 is in flight, but call 2 itself uses ~300ms.
    let result2 = null;
    let err2 = null;
    try {
      result2 = await session.sendPrompt('call 2');
    } catch (err) { err2 = err; }

    assert.ok(
      Date.now() - birth >= 500,
      `Fixture invariant: cumulative session time must exceed the cap (got ${Date.now() - birth}ms) — bump delays if this fires`
    );
    assert.strictEqual(
      err2, null,
      `Expected call 2 to complete under per-call semantics, but it was killed: ${err2?.name}: ${err2?.message}`
    );
    assert.strictEqual(result2.subtype, 'success', `Expected call 2 result success, got ${result2?.subtype}`);

    await session.close();
    // Guards the backstop-elapsed re-scope (spec: backstop must measure the
    // active window, not session birth): a clean multi-call session older
    // than the cap must not be branded wall-clock-exceeded at close.
    assert.strictEqual(
      session._error, null,
      `Expected no session error after clean close, got ${session._error?.name}: ${session._error?.message}`
    );
  } finally {
    config.execution.maxSessionWallClockMs = originalMs;
    try { await session?.close(); } catch {}
  }
});

// ── TC2 (AC1): session AGE (active+idle mix) over the cap before a fresh call ──
//
// cap = 500ms. Call 1 runs ~300ms, then ~280ms idle (idle alone is UNDER the
// cap — this is not the TC4 idle case), then a fresh ~100ms call arrives with
// session age ~585ms > cap. No single active window and no single idle span
// exceeds the cap; only the lifetime does. Pre-fix HEAD kills the session at
// 500ms (mid-idle) and the fresh call throws 'session errored'.
await test('TC2 (AC1): session age (active+idle) exceeds cap — fresh short call is NOT killed', async () => {
  const sm = new SessionManager();
  sm._queryFn = makeScriptedQueryFn([{ delayMs: 300 }, { delayMs: 100 }]);

  const originalMs = config.execution.maxSessionWallClockMs;
  config.execution.maxSessionWallClockMs = 500;
  const birth = Date.now();
  let session = null;
  try {
    session = sm.spawnReusable({ name: 'tc2-percall-aged' });

    const result1 = await session.sendPrompt('call 1');
    assert.strictEqual(result1.subtype, 'success', `Expected call 1 to succeed, got ${result1.subtype}`);

    await sleep(280); // idle, but under the cap

    assert.ok(
      Date.now() - birth >= 500,
      `Fixture invariant: session age must exceed the cap before call 2 (got ${Date.now() - birth}ms)`
    );

    let result2 = null;
    let err2 = null;
    try {
      result2 = await session.sendPrompt('call 2'); // throws sync at pre-fix HEAD: session already dead
    } catch (err) { err2 = err; }

    assert.strictEqual(
      err2, null,
      `Expected fresh call on an aged-but-healthy session to complete, got ${err2?.name}: ${err2?.message}`
    );
    assert.strictEqual(result2.subtype, 'success', `Expected call 2 result success, got ${result2?.subtype}`);

    await session.close();
    assert.strictEqual(
      session._error, null,
      `Expected no session error after clean close, got ${session._error?.name}: ${session._error?.message}`
    );
  } finally {
    config.execution.maxSessionWallClockMs = originalMs;
    try { await session?.close(); } catch {}
  }
});

// ── TC3 (AC2): runaway protection — a single call over the cap IS killed ──
//
// cap = 120ms, the generator hard-stalls on the very first call. The
// runaway-kill semantics must stay exactly as they are: sendPrompt rejects
// with WallClockExceededError (non-retryable, category preserved).
await test('TC3 (AC2): single call exceeding cap IS killed with WallClockExceededError', async () => {
  const sm = new SessionManager();
  sm._queryFn = makeScriptedQueryFn(['stall']);

  const originalMs = config.execution.maxSessionWallClockMs;
  config.execution.maxSessionWallClockMs = 120;
  let session = null;
  try {
    session = sm.spawnReusable({ name: 'tc3-percall-runaway' });

    const start = Date.now();
    let sendErr = null;
    try {
      await session.sendPrompt('stuck call');
    } catch (err) { sendErr = err; }
    const elapsed = Date.now() - start;

    assert.ok(
      sendErr instanceof WallClockExceededError,
      `Expected WallClockExceededError, got ${sendErr?.constructor?.name}: ${sendErr?.message}`
    );
    assert.strictEqual(sendErr.retryable, false, `Expected retryable false, got ${sendErr.retryable}`);
    assert.strictEqual(
      sendErr.category, 'wall-clock-exceeded',
      `Expected category 'wall-clock-exceeded', got '${sendErr.category}'`
    );
    assert.ok(elapsed < 2000, `Expected the stuck call to be killed promptly, took ${elapsed}ms`);
  } finally {
    config.execution.maxSessionWallClockMs = originalMs;
    try { await session?.close(); } catch {}
  }
});

// ── TC4 (AC3): idle exemption — idle longer than the cap must never kill ──
//
// cap = 300ms. Call 1 completes fast, the session then idles ~700ms (>2× the
// cap) with NOTHING outstanding, then call 2 arrives and must complete. This
// is the load-bearing semantic: the timer exists only while a request is
// outstanding (the planner session routinely idles while missions execute).
await test('TC4 (AC3): session idle longer than the cap is NOT killed; second call completes', async () => {
  const sm = new SessionManager();
  sm._queryFn = makeScriptedQueryFn([{ delayMs: 30 }, { delayMs: 30 }]);

  const originalMs = config.execution.maxSessionWallClockMs;
  config.execution.maxSessionWallClockMs = 300;
  let session = null;
  try {
    session = sm.spawnReusable({ name: 'tc4-percall-idle' });

    const result1 = await session.sendPrompt('call 1');
    assert.strictEqual(result1.subtype, 'success', `Expected call 1 to succeed, got ${result1.subtype}`);

    await sleep(700); // idle for >2× the cap — must never arm/fire the timer

    let result2 = null;
    let err2 = null;
    try {
      result2 = await session.sendPrompt('call 2'); // throws sync at pre-fix HEAD: killed mid-idle
    } catch (err) { err2 = err; }

    assert.strictEqual(
      err2, null,
      `Expected an idle session to survive (idle exemption), got ${err2?.name}: ${err2?.message}`
    );
    assert.strictEqual(result2.subtype, 'success', `Expected call 2 result success, got ${result2?.subtype}`);

    await session.close();
    assert.strictEqual(
      session._error, null,
      `Expected no session error after clean close, got ${session._error?.name}: ${session._error?.message}`
    );
  } finally {
    config.execution.maxSessionWallClockMs = originalMs;
    try { await session?.close(); } catch {}
  }
});

// ── TC5 (AC4): captured-reject guard race survives the per-call re-scope ──
//
// cap = 300ms. Call 1 succeeds (so post-fix the timer has been armed AND
// cleared once), then call 2 hard-stalls the generator mid-active-window.
// The timer must win the race against the stalled iterator (the 449b433
// terminate/rejectGuard/settled design): sendPrompt rejects promptly with
// WallClockExceededError, close() returns without hanging on the stalled
// generator, and no ghost handle is left in _active.
await test('TC5 (AC4): hard-stalled generator during an active call — timer wins, close() does not hang', async () => {
  const sm = new SessionManager();
  sm._queryFn = makeScriptedQueryFn([{ delayMs: 30 }, 'stall']);

  const originalMs = config.execution.maxSessionWallClockMs;
  config.execution.maxSessionWallClockMs = 300;
  let session = null;
  try {
    session = sm.spawnReusable({ name: 'tc5-percall-guard-race' });

    const result1 = await session.sendPrompt('call 1');
    assert.strictEqual(result1.subtype, 'success', `Expected call 1 to succeed, got ${result1.subtype}`);

    const start = Date.now();
    let sendErr = null;
    try {
      await session.sendPrompt('stuck call 2');
    } catch (err) { sendErr = err; }
    const sendElapsed = Date.now() - start;

    assert.ok(
      sendErr instanceof WallClockExceededError,
      `Expected sendPrompt to reject with WallClockExceededError, got ${sendErr?.constructor?.name}: ${sendErr?.message}`
    );
    assert.ok(sendElapsed < 2000, `Expected the stalled call to be killed promptly, took ${sendElapsed}ms`);

    // close() awaits _consumerPromise — the guard race must have already
    // settled it; a hang here means the protection regressed.
    const closeStart = Date.now();
    await session.close();
    assert.ok(Date.now() - closeStart < 2000, `Expected close() to return promptly, took ${Date.now() - closeStart}ms`);

    assert.ok(
      !sm._active.has('tc5-percall-guard-race'),
      'Expected the session handle to be removed from _active after the wall-clock abort'
    );
  } finally {
    config.execution.maxSessionWallClockMs = originalMs;
    try { await session?.close(); } catch {}
  }
});

// ── TC6 (AC5): totalActiveMs/callCount accumulate and appear in teardown log ──
//
// Default cap (no override — the observability rider must not depend on a
// tiny cap). Two ~60ms calls separated by ~500ms idle:
//   - callCount on the session handle must be exactly 2.
//   - totalActiveMs must cover both active windows (>= ~100ms allowing
//     timer slop) but EXCLUDE the 500ms idle gap (< 450ms).
//   - both names must appear in the teardown log (stdio captured across
//     the session's lifetime; teardown happens inside close()).
await test('TC6 (AC5): totalActiveMs/callCount accumulate on the handle and appear in the teardown log', async () => {
  const sm = new SessionManager();
  sm._queryFn = makeScriptedQueryFn([{ delayMs: 60 }, { delayMs: 60 }]);

  let session = null;
  const capture = captureStdio();
  try {
    session = sm.spawnReusable({ name: 'tc6-percall-observability' });
    const handle = session.handle;

    const result1 = await session.sendPrompt('call 1');
    assert.strictEqual(result1.subtype, 'success', `Expected call 1 to succeed, got ${result1.subtype}`);

    await sleep(500); // idle — must NOT count toward totalActiveMs

    const result2 = await session.sendPrompt('call 2');
    assert.strictEqual(result2.subtype, 'success', `Expected call 2 to succeed, got ${result2.subtype}`);

    await session.close(); // teardown: accumulators final + log line emitted
    capture.stop();

    assert.strictEqual(
      handle.callCount, 2,
      `Expected handle.callCount === 2 after two sendPrompt calls, got ${handle.callCount}`
    );
    assert.strictEqual(
      typeof handle.totalActiveMs, 'number',
      `Expected handle.totalActiveMs to be a number, got ${typeof handle.totalActiveMs}`
    );
    assert.ok(
      handle.totalActiveMs >= 100,
      `Expected totalActiveMs to cover two ~60ms active windows (>= 100ms), got ${handle.totalActiveMs}`
    );
    assert.ok(
      handle.totalActiveMs < 450,
      `Expected totalActiveMs to EXCLUDE the ~500ms idle gap (< 450ms), got ${handle.totalActiveMs}`
    );

    const logged = capture.text();
    assert.ok(
      logged.includes('totalActiveMs'),
      'Expected the teardown log to mention totalActiveMs'
    );
    assert.ok(
      logged.includes('callCount'),
      'Expected the teardown log to mention callCount'
    );
  } finally {
    capture.stop();
    try { await session?.close(); } catch {}
  }
});

// --- Summary ---
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
