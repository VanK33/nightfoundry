/**
 * test-session-inflight-reconcile.js — SessionManager owns in-flight cleanup.
 *
 * recordIncrementalUsage streams a live usage estimate into TokenTracker._inFlight
 * keyed by the session (handle) name; recordSession (the agent's finalize) deletes
 * it on success. If an agent throws between spawn and recordSession the estimate
 * would leak into getTotalUsage() forever. SessionManager now reconciles it for
 * EVERY session at settle time, so the leak cannot recur per-agent.
 *
 * These tests drive the REAL spawn()/spawnReusable() lifecycle with a mock
 * _queryFn + a spy TokenTracker, asserting discardInFlight(name) fires on
 * success, on a mid-stream error, and on reusable teardown. No Claude auth /
 * no real SDK.
 *
 * Run: node test/test-session-inflight-reconcile.js
 */
import assert from 'assert';
import { SessionManager } from '../src/orchestrator/infra/session-manager.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// A TokenTracker stand-in that records the discardInFlight calls and tracks the
// in-flight set the way the real tracker does (add on incremental, remove on
// finalize/discard).
function spyTracker() {
  const inflight = new Set();
  const discarded = [];
  const seen = new Set(); // every name ever streamed — proves in-flight was populated
  return {
    recordIncrementalUsage(name) { inflight.add(name); seen.add(name); },
    discardInFlight(name) { discarded.push(name); inflight.delete(name); },
    async recordSession(name) { inflight.delete(name); },
    inflight,
    discarded,
    seen,
  };
}

// Let any pending microtask (the raced.finally reconcile) run.
const tick = () => new Promise((r) => setImmediate(r));

const assistantUsage = { type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } };
const resultOk = { type: 'result', subtype: 'success', result: 'OK', usage: { input_tokens: 10, output_tokens: 5 } };

// Single-shot query: yields a fixed event list, then completes.
function makeShotQuery(events) {
  return function _queryFn() {
    let i = 0;
    return {
      async next() {
        return i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true };
      },
      async return() { return { value: undefined, done: true }; },
      [Symbol.asyncIterator]() { return this; },
    };
  };
}

// Single-shot query that streams one assistant event then throws mid-stream.
function makeErrorQuery() {
  return function _queryFn() {
    let i = 0;
    return {
      async next() {
        if (i++ === 0) return { value: assistantUsage, done: false };
        throw new Error('stream boom');
      },
      async return() { return { value: undefined, done: true }; },
      [Symbol.asyncIterator]() { return this; },
    };
  };
}

// Minimal reusable query: per prompt, streams one assistant-usage frame (so the
// tracker populates an in-flight estimate keyed by the handle name) then a result.
function makeReusableQuery() {
  return ({ prompt }) => {
    const promptIter = prompt[Symbol.asyncIterator]();
    let done = false;
    let pending = [];
    const iterator = {
      async next() {
        if (done) return { value: undefined, done: true };
        if (pending.length > 0) return { value: pending.shift(), done: false };
        const pulled = await promptIter.next();
        if (done || pulled.done) return { value: undefined, done: true };
        pending = [assistantUsage, { type: 'result', subtype: 'success', result: 'ok', usage: {} }];
        return { value: pending.shift(), done: false };
      },
      return() { done = true; return Promise.resolve({ value: undefined, done: true }); },
    };
    return {
      return() { done = true; return Promise.resolve({ value: undefined, done: true }); },
      [Symbol.asyncIterator]() { return iterator; },
    };
  };
}

await test('single-shot spawn success discards the in-flight estimate at settle', async () => {
  const sm = new SessionManager();
  const tt = spyTracker();
  sm.setTokenTracker(tt);
  sm._queryFn = makeShotQuery([assistantUsage, resultOk]);

  const { handle } = await sm.spawn({ name: 'sess-ok', agent: 'verifier', tools: [] });
  assert.strictEqual(handle.name, 'sess-ok');
  await tick();

  assert.ok(tt.seen.has('sess-ok'), 'streaming must have populated an in-flight estimate (else the test is vacuous)');
  assert.ok(tt.discarded.includes('sess-ok'), `discardInFlight must fire for 'sess-ok' on success, got ${JSON.stringify(tt.discarded)}`);
  assert.ok(!tt.inflight.has('sess-ok'), 'in-flight must be empty after a successful session settles');
});

await test('single-shot spawn error still discards the in-flight estimate (no leak on throw)', async () => {
  const sm = new SessionManager();
  const tt = spyTracker();
  sm.setTokenTracker(tt);
  sm._queryFn = makeErrorQuery();

  let threw = false;
  try {
    await sm.spawn({ name: 'sess-err', agent: 'verifier', tools: [] });
  } catch {
    threw = true;
  }
  await tick();

  assert.ok(threw, 'a mid-stream error must reject the spawn');
  assert.ok(tt.seen.has('sess-err'), 'the assistant frame before the error must have populated an in-flight estimate');
  assert.ok(tt.discarded.includes('sess-err'), `discardInFlight must fire for 'sess-err' on error, got ${JSON.stringify(tt.discarded)}`);
  assert.ok(!tt.inflight.has('sess-err'), 'in-flight must be empty after an errored session settles');
});

await test('reusable session discards the handle-name in-flight estimate at teardown', async () => {
  const sm = new SessionManager();
  const tt = spyTracker();
  sm.setTokenTracker(tt);
  sm._queryFn = makeReusableQuery();

  const session = sm.spawnReusable({ name: 'reuse-1', agent: 'planner', tools: [] });
  await session.sendPrompt('turn 1');
  // The per-turn assistant frame populates an in-flight estimate keyed by the
  // handle name. The agent finalizes the turn via recordSession under a
  // turn-specific name, so the turn's RESULT event must clear the handle-name
  // estimate at the turn boundary — otherwise getTotalUsage would double-count
  // this turn (finalized under the turn name AND still in-flight under the
  // handle name) for the rest of the session.
  assert.ok(tt.seen.has('reuse-1'), 'a turn must have populated an in-flight estimate under the handle name');
  assert.ok(!tt.inflight.has('reuse-1'), 'the handle-name estimate must be cleared at the turn boundary (no mid-session double-count)');
  assert.ok(tt.discarded.includes('reuse-1'), `the turn boundary must discard the handle-name estimate, got ${JSON.stringify(tt.discarded)}`);

  await session.close();
  await tick();

  assert.ok(!tt.inflight.has('reuse-1'), 'reusable in-flight must remain empty after teardown');
});

await test('reusable teardown clears a lingering estimate when the session ends before a turn result', async () => {
  const sm = new SessionManager();
  const tt = spyTracker();
  sm.setTokenTracker(tt);
  // Streams one assistant-usage frame (populating an in-flight estimate) then
  // ends the stream WITHOUT ever emitting a result — so the turn-boundary
  // discard never runs and only the teardown backstop can clear it.
  sm._queryFn = ({ prompt }) => {
    const promptIter = prompt[Symbol.asyncIterator]();
    let stage = 0;
    const it = {
      async next() {
        if (stage === 0) { await promptIter.next(); stage = 1; return { value: assistantUsage, done: false }; }
        return { value: undefined, done: true };
      },
      return() { return Promise.resolve({ value: undefined, done: true }); },
    };
    return { return() { return Promise.resolve({ value: undefined, done: true }); }, [Symbol.asyncIterator]() { return it; } };
  };

  const session = sm.spawnReusable({ name: 'reuse-teardown', agent: 'planner', tools: [] });
  const pending = session.sendPrompt('x').catch(() => {}); // rejected at teardown (no result arrives)
  await tick();
  await tick();
  await pending;
  await tick();

  assert.ok(tt.seen.has('reuse-teardown'), 'the assistant frame must have populated an in-flight estimate');
  assert.ok(tt.discarded.includes('reuse-teardown'), 'teardown must discard the lingering estimate when no result boundary fired');
  assert.ok(!tt.inflight.has('reuse-teardown'), 'the lingering handle-name estimate must be cleared by teardown (close-before-result path)');
});

await test('a settled handle does not record incremental usage (the !handle.finished guard)', async () => {
  const sm = new SessionManager();
  const tt = spyTracker();
  sm.setTokenTracker(tt);
  const assistantEvent = { type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [] } };

  // A late frame draining out of a wall-clock/abort loser arrives at
  // _dispatchEvent AFTER the session settled (handle.finished=true) and its
  // in-flight estimate was already discarded. The guard must suppress it so it
  // cannot resurrect an _inFlight entry that no discard path would clean again.
  const finishedHandle = { name: 'guard-finished', agent: 'verifier', finished: true, _toolCallCount: 0, emit() {} };
  sm._dispatchEvent(finishedHandle, assistantEvent);
  assert.ok(!tt.seen.has('guard-finished'), 'a settled (finished) handle must NOT record incremental usage');
  assert.ok(!tt.inflight.has('guard-finished'), 'no in-flight entry may be created for a settled handle');

  // Control: a live handle DOES record — proves the suppression above is the
  // guard at work, not a dead assertion.
  const liveHandle = { name: 'guard-live', agent: 'verifier', finished: false, _toolCallCount: 0, emit() {} };
  sm._dispatchEvent(liveHandle, assistantEvent);
  assert.ok(tt.seen.has('guard-live'), 'a live (unfinished) handle MUST record incremental usage (control)');
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
