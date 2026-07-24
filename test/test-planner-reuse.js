/**
 * test-planner-reuse.js — Unit tests for planner session reuse.
 *
 * Tests what can be tested WITHOUT a live SDK:
 *   - PromptStream pull-push semantics
 *   - ReusableSession dispatch logic (via a fake query() function)
 *   - closeReusableSession() is safe to call repeatedly
 *   - Errors from one turn don't corrupt subsequent turns
 *
 * What this file CANNOT test:
 *   - Actual SDK cache reuse behavior (requires live dogfood)
 *   - Actual cost savings (requires live dogfood)
 *   - Actual session isolation under concurrent SDK load
 *
 * See docs/audit/phase-1-overhead-audit.md for the validation plan.
 *
 * Run: node test/test-planner-reuse.js
 */
import assert from 'assert';
import { EventEmitter } from 'events';
import { PromptStream, ReusableSession, SessionHandle } from '../src/orchestrator/infra/session-manager.js';
import { Planner } from '../src/orchestrator/agents/planner.js';

// Shared fake handle used by ReusableSession tests
class FakeHandle extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this._result = null;
    this.startedAt = new Date().toISOString();
    this.finished = false;
  }
}

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  const run = async () => {
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
  };
  return run();
}

// ── PromptStream tests ───────────────────────────────────────────────

await test('PromptStream: push-then-pull delivers the message', async () => {
  const s = new PromptStream();
  const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null };
  s.push(msg);
  const iter = s[Symbol.asyncIterator]();
  const { value, done } = await iter.next();
  assert.equal(done, false);
  assert.strictEqual(value, msg);
});

await test('PromptStream: pull-then-push parks the consumer until push fires', async () => {
  const s = new PromptStream();
  const iter = s[Symbol.asyncIterator]();
  const nextPromise = iter.next();
  // At this point the consumer is parked — the promise is pending
  let settled = false;
  nextPromise.then(() => { settled = true; });
  // Yield to the event loop once to confirm still pending
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'consumer should still be parked');
  // Push should unblock it
  const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null };
  s.push(msg);
  const { value, done } = await nextPromise;
  assert.equal(done, false);
  assert.strictEqual(value, msg);
});

await test('PromptStream: close() resolves parked consumer with done=true', async () => {
  const s = new PromptStream();
  const iter = s[Symbol.asyncIterator]();
  const nextPromise = iter.next();
  s.close();
  const { done } = await nextPromise;
  assert.equal(done, true);
});

await test('PromptStream: close() then pull returns done immediately', async () => {
  const s = new PromptStream();
  s.close();
  const iter = s[Symbol.asyncIterator]();
  const { done } = await iter.next();
  assert.equal(done, true);
});

await test('PromptStream: close() then push throws', async () => {
  const s = new PromptStream();
  s.close();
  assert.throws(
    () => s.push({ type: 'user', message: { role: 'user', content: [] }, parent_tool_use_id: null }),
    /closed stream/
  );
});

await test('PromptStream: FIFO ordering across multiple pushes', async () => {
  const s = new PromptStream();
  const msgs = ['a', 'b', 'c'].map((t) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: t }] },
    parent_tool_use_id: null,
  }));
  msgs.forEach((m) => s.push(m));
  const iter = s[Symbol.asyncIterator]();
  const results = [];
  for (let i = 0; i < 3; i++) {
    const { value } = await iter.next();
    results.push(value.message.content[0].text);
  }
  assert.deepEqual(results, ['a', 'b', 'c']);
});

// ── ReusableSession tests (with fake SDK) ────────────────────────────
//
// The real SDK's query() function returns a Query object that is also
// an AsyncIterable. For testing, we substitute a fake SessionManager
// that returns a controllable fake query.
//
// Pattern: the fake query yields whatever events we push into it,
// simulating what a real SDK session would emit. This lets us test
// ReusableSession's routing logic (send → result matching) without
// spending any money or touching a real Claude subprocess.

class FakeQuery {
  constructor() {
    this._events = [];
    this._resolvers = [];
    this._closed = false;
  }
  emit(event) {
    if (this._closed) return;
    const resolver = this._resolvers.shift();
    if (resolver) {
      resolver({ value: event, done: false });
    } else {
      this._events.push(event);
    }
  }
  close() {
    this._closed = true;
    while (this._resolvers.length > 0) {
      this._resolvers.shift()({ value: undefined, done: true });
    }
  }
  [Symbol.asyncIterator]() {
    const self = this;
    return {
      next() {
        if (self._events.length > 0) {
          return Promise.resolve({ value: self._events.shift(), done: false });
        }
        if (self._closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => self._resolvers.push(resolve));
      },
    };
  }
}

class FakeSessionManager {
  constructor() {
    this._active = new Map();
    this.lastQuery = null;
    this.lastOptions = null;
  }
  _buildSdkOptions(options) {
    return { fakeSdkOpts: true, ...options };
  }
  _dispatchEvent(handle, event) {
    // mimic the real dispatch so handle.on('result') etc. work
    if (event.type === 'result') {
      handle._result = event;
      handle.emit?.('result', event);
    }
  }
}

// We can't call the real ReusableSession constructor directly because
// it uses the SDK's query(). Instead, we build a ReusableSession-shaped
// object via Object.create and reproduce the constructor's internal
// setup with a fake query. This tests the send/result routing logic
// without touching a real SDK subprocess.

function makeFakeReusableSession(name, fakeQuery) {
  const sessionManager = new FakeSessionManager();
  const handle = new FakeHandle(name);
  sessionManager._active.set(name, handle);
  handle._query = fakeQuery;

  const sess = Object.create(ReusableSession.prototype);
  sess._sessionManager = sessionManager;
  sess._options = {};
  sess._stream = new PromptStream();
  sess._pendingResults = [];
  sess._turnCount = 0;
  sess._closed = false;
  sess._error = null;
  sess.handle = handle;
  sess._consumerPromise = sess._consumeEvents(fakeQuery);
  return sess;
}

await test('ReusableSession: send then matching result resolves the promise', async () => {
  const fakeQuery = new FakeQuery();
  const sess = makeFakeReusableSession('test-reusable', fakeQuery);

  const sendPromise = sess.sendPrompt('hello');
  await new Promise((r) => setImmediate(r));
  fakeQuery.emit({
    type: 'result',
    usage: { input_tokens: 100, output_tokens: 50 },
    total_cost_usd: 0.012,
    structured_output: { foo: 'bar' },
  });
  const result = await sendPromise;
  assert.strictEqual(result.type, 'result');
  assert.strictEqual(result.total_cost_usd, 0.012);

  fakeQuery.close();
  await sess._consumerPromise;
});

await test('ReusableSession: FIFO matching across multiple sends', async () => {
  const fakeQuery = new FakeQuery();
  const sess = makeFakeReusableSession('test-reusable-2', fakeQuery);

  const p1 = sess.sendPrompt('first');
  const p2 = sess.sendPrompt('second');
  const p3 = sess.sendPrompt('third');
  await new Promise((r) => setImmediate(r));

  fakeQuery.emit({ type: 'result', total_cost_usd: 0.01, marker: 'first-result' });
  fakeQuery.emit({ type: 'result', total_cost_usd: 0.02, marker: 'second-result' });
  fakeQuery.emit({ type: 'result', total_cost_usd: 0.03, marker: 'third-result' });

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1.marker, 'first-result');
  assert.equal(r2.marker, 'second-result');
  assert.equal(r3.marker, 'third-result');

  fakeQuery.close();
  await sess._consumerPromise;
});

await test('ReusableSession: send after close throws', async () => {
  // Note: the real SDK closes its output iterator when the input
  // stream closes. FakeQuery doesn't auto-close that way, so we
  // close it manually first to unblock the consumer loop.
  const fakeQuery = new FakeQuery();
  const sess = makeFakeReusableSession('test-reusable-closed', fakeQuery);

  fakeQuery.close();
  await sess.close();

  await assert.rejects(
    () => sess.sendPrompt('too late'),
    /closed session/
  );
});

await test('ReusableSession: turnCount increments per send', async () => {
  const fakeQuery = new FakeQuery();
  const sess = makeFakeReusableSession('test-reusable-turns', fakeQuery);

  assert.equal(sess.turnCount, 0);
  const p1 = sess.sendPrompt('a');
  assert.equal(sess.turnCount, 1);
  const p2 = sess.sendPrompt('b');
  assert.equal(sess.turnCount, 2);

  fakeQuery.emit({ type: 'result', total_cost_usd: 0 });
  fakeQuery.emit({ type: 'result', total_cost_usd: 0 });
  await Promise.all([p1, p2]);
  fakeQuery.close();
  await sess._consumerPromise;
});

await test('ReusableSession: pending sends reject when SDK iterator closes cleanly (regression — Copilot review 2026-04-09)', async () => {
  // Bug caught by Copilot on the autonomous branch PR: if the SDK
  // subprocess ends cleanly (iterator done=true) while sendPrompt
  // promises are still pending, the old code would fall through to
  // finally without rejecting them, and callers would hang forever.
  // Fix: reject all pending sends in the finally block on BOTH the
  // error path and the happy-path exit, with a sentinel error on
  // the happy path.
  const fakeQuery = new FakeQuery();
  const sess = makeFakeReusableSession('test-reusable-pending-close', fakeQuery);

  // Start a send that will never get its result
  const pendingSend = sess.sendPrompt('will hang without the fix');

  // Yield so the send push() happens
  await new Promise((r) => setImmediate(r));

  // Close the fake query cleanly WITHOUT emitting a result event.
  // This simulates the SDK subprocess ending gracefully mid-turn.
  fakeQuery.close();

  // The pending send should now reject with the sentinel error,
  // NOT hang forever.
  await assert.rejects(
    () => pendingSend,
    /closed before result arrived/
  );

  await sess._consumerPromise;
});

await test('ReusableSession: non-result events do not resolve pending sends', async () => {
  // Regression sentinel: only 'result' events should match a pending
  // sendPrompt promise. Other event types (init, message) are forwarded
  // to the handle for logging but must not prematurely resolve sends.
  const fakeQuery = new FakeQuery();
  const sess = makeFakeReusableSession('test-reusable-events', fakeQuery);

  const p1 = sess.sendPrompt('hello');
  await new Promise((r) => setImmediate(r));

  // Emit a system init event — should NOT resolve p1
  fakeQuery.emit({ type: 'system', subtype: 'init' });
  // Emit an assistant message — should NOT resolve p1
  fakeQuery.emit({ type: 'assistant', message: { content: [] } });

  // Verify p1 is still pending
  let settled = false;
  p1.then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'p1 should still be pending');

  // Now emit the result — should resolve p1
  fakeQuery.emit({ type: 'result', total_cost_usd: 0.001, marker: 'done' });
  const result = await p1;
  assert.equal(result.marker, 'done');

  fakeQuery.close();
  await sess._consumerPromise;
});

// ── SessionHandle: default no-op error listener ────────────────────

await test('SessionHandle: emit(error) on a zero-listener handle does not crash (regression — Copilot review 2026-04-09)', () => {
  // Bug caught by Copilot: Node's EventEmitter throws synchronously
  // if you emit 'error' with no listeners attached. SessionHandle
  // has a real window where this can happen — during the sync
  // prefix of spawn()'s IIFE or ReusableSession._consumeEvents, the
  // SDK can fail BEFORE the caller has attached a logger listener.
  // Fix: attach a default no-op 'error' listener in the
  // SessionHandle constructor.
  //
  // This test verifies the invariant directly: a fresh SessionHandle
  // with no caller-attached listeners MUST NOT crash when error is
  // emitted. Without the fix, this test would throw and fail.
  const handle = new SessionHandle('test-default-error-listener');
  handle.emit('error', new Error('early SDK failure'));
  // Getting here means the emit was absorbed by the no-op default
  // listener. The assertion is implicit — reaching this line is
  // success.
  assert.ok(handle instanceof SessionHandle);
});

await test('SessionHandle: real listeners still receive error events alongside the no-op default', () => {
  // Ensures the no-op default listener doesn't suppress real listeners.
  // After logger.attachToSession() attaches a real 'error' handler,
  // emit('error', ...) must still deliver the event to that handler.
  const handle = new SessionHandle('test-real-listener-coexist');
  const received = [];
  handle.on('error', (err) => received.push(err.message));
  handle.emit('error', new Error('test error'));
  assert.equal(received.length, 1);
  assert.equal(received[0], 'test error');
});

// ── ReusableSession: constructor failure cleanup ────────────────────

await test('ReusableSession: constructor leaves no handle in _active if _buildSdkOptions throws (regression — Copilot review 2026-04-09)', async () => {
  // Bug caught by Copilot: if the synchronous setup in the
  // ReusableSession constructor throws (e.g., invalid options,
  // SDK init failure), the handle would remain in _active forever
  // and callers would think the session was "stuck". Fix: wrap
  // the constructor's setup in try/catch, remove the handle from
  // _active on failure, mark it finished, and re-throw.
  //
  // We test this by providing a FakeSessionManager whose
  // _buildSdkOptions throws synchronously. The constructor should
  // propagate the error AND leave _active empty.
  class ThrowingSessionManager {
    constructor() {
      this._active = new Map();
    }
    _buildSdkOptions() {
      throw new Error('simulated buildSdkOptions failure');
    }
    _dispatchEvent() {}
  }
  const mgr = new ThrowingSessionManager();

  assert.throws(
    () => new ReusableSession(mgr, { name: 'test-throw' }),
    /simulated buildSdkOptions failure/
  );

  // _active must be empty — the handle was cleaned up in the catch
  assert.equal(mgr._active.size, 0,
    'handle should have been removed from _active after constructor failure');
});

await test('ReusableSession: _consumeEvents sync-prefix failure does not crash (regression — Copilot review 2026-04-09)', async () => {
  // Bug caught by Copilot: the sync prefix of _consumeEvents (the
  // code that runs from the start of the async function to the first
  // real await) can throw when `q[Symbol.asyncIterator]()` is called
  // on a malformed query. That catch block emits 'error' on the
  // handle — which runs in the same tick as the constructor, BEFORE
  // the caller has received the ReusableSession instance to attach
  // listeners.
  //
  // With the default no-op 'error' listener in SessionHandle, this
  // emit is now absorbed. This test exercises the failure path
  // directly: a FakeQuery whose [Symbol.asyncIterator] throws
  // synchronously. The ReusableSession must NOT crash the process;
  // the eventual sendPrompt should reject cleanly.
  class ThrowingAsyncIterator {
    [Symbol.asyncIterator]() {
      throw new Error('simulated iterator initialization failure');
    }
  }

  // Build a bypassed ReusableSession (as in makeFakeReusableSession)
  // but use our throwing "query" as the iterator source. The consumer
  // loop should catch the throw in its try block, record it in _error,
  // and emit 'error' on the handle. With the default listener in
  // place, the emit must NOT crash.
  const sessionManager = new FakeSessionManager();
  const handle = new SessionHandle('test-sync-prefix-throw');
  sessionManager._active.set(handle.name, handle);

  const throwingQuery = new ThrowingAsyncIterator();
  handle._query = throwingQuery;

  const sess = Object.create(ReusableSession.prototype);
  sess._sessionManager = sessionManager;
  sess._options = {};
  sess._stream = new PromptStream();
  sess._pendingResults = [];
  sess._turnCount = 0;
  sess._closed = false;
  sess._error = null;
  sess.handle = handle;

  // _consumeEvents should catch the sync throw, record _error, emit
  // (absorbed by the default listener), and run finally which
  // rejects pending sends.
  sess._consumerPromise = sess._consumeEvents(throwingQuery);

  // Wait for the consumer loop to finish.
  await sess._consumerPromise;

  // The error must have been recorded
  assert.ok(sess._error, 'consumer loop should have recorded the sync-prefix error');
  assert.match(sess._error.message, /simulated iterator initialization failure/);

  // A send after the failure should reject with the captured error
  // (via the post-close sendPrompt guard in the real class).
  await assert.rejects(
    () => sess.sendPrompt('anything'),
    /session errored/
  );
});

await test('ReusableSession: constructor failure does NOT emit error event on zero-listener handle (regression — Copilot review 2026-04-09)', async () => {
  // Follow-up bug caught by Copilot: the original catch block emitted
  // 'error' and 'exit' on the handle. At constructor time, no caller
  // has had a chance to attach listeners — and emitting 'error' on a
  // zero-listener EventEmitter crashes the process (Node throws an
  // unhandled error synchronously). The fix is to NOT emit from the
  // constructor catch; the thrown error is sufficient signal.
  //
  // This test asserts the invariant directly by monkey-patching the
  // handle's emit() so we can observe whether 'error' was emitted.
  // If the constructor ever emits 'error' again, this test fails
  // loudly instead of accidentally passing the way assert.throws does.
  class ThrowingSessionManager {
    constructor() {
      this._active = new Map();
    }
    _buildSdkOptions() {
      throw new Error('simulated buildSdkOptions failure');
    }
    _dispatchEvent() {}
  }
  const mgr = new ThrowingSessionManager();

  // Patch SessionHandle.prototype.emit to record calls rather than
  // fire. We restore it in finally so it doesn't leak across tests.
  const { SessionHandle } = await import('../src/orchestrator/infra/session-manager.js');
  const originalEmit = SessionHandle.prototype.emit;
  const emitted = [];
  SessionHandle.prototype.emit = function (event, ...args) {
    emitted.push({ event, args });
    // Do NOT forward to originalEmit — we're only checking calls.
    return true;
  };

  try {
    assert.throws(
      () => new ReusableSession(mgr, { name: 'test-no-emit-on-fail' }),
      /simulated buildSdkOptions failure/
    );
    // The catch block must NOT have emitted 'error' or 'exit'.
    const errorEvents = emitted.filter((e) => e.event === 'error');
    const exitEvents = emitted.filter((e) => e.event === 'exit');
    assert.equal(errorEvents.length, 0,
      'constructor failure must NOT emit error event (no listeners attached at constructor time)');
    assert.equal(exitEvents.length, 0,
      'constructor failure must NOT emit exit event (no listeners attached at constructor time)');
  } finally {
    SessionHandle.prototype.emit = originalEmit;
  }
});

// ── Planner: log leak on spawnReusable failure ──────────────────────

await test('Planner: _ensureReusableSession cleans up log on spawnReusable throw (regression — Copilot review 2026-04-09)', async () => {
  // Bug caught by Copilot: if spawnReusable throws synchronously,
  // the log file handle opened just above would leak and
  // _reusableSessionLog would remain set until process exit.
  // Fix: try/catch around spawnReusable, close the log and reset
  // state on throw.
  const closedLogs = [];
  const fakeLogger = {
    createSessionLog: (name) => ({
      logPath: `/tmp/${name}.jsonl`,
      write: () => {},
      close: () => { closedLogs.push(name); },
    }),
    attachToSession: () => {},
    writeSessionSummary: () => {},
  };
  const fakeSessionManager = {
    spawnReusable: () => { throw new Error('simulated SDK init failure'); },
  };
  const fakeTokenTracker = { recordSession: () => {} };

  const planner = new Planner(fakeSessionManager, fakeLogger, fakeTokenTracker);

  assert.throws(
    () => planner._ensureReusableSession('/fake/root', 7),
    /simulated SDK init failure/
  );

  // State must be reset so a retry path doesn't hit a half-constructed session
  assert.equal(planner._reusableSession, null);
  assert.equal(planner._reusableSessionLog, null);
  // The log must have been closed during the cleanup (we track via
  // the fakeLogger's close() spy — note the log was named 'planner-reusable')
  assert.equal(closedLogs.length, 1);
});

// ── Planner: session-summary entry per reusable turn ───────────────

await test('Planner: _planMissionReusable writes per-turn session-summary entry (regression — Copilot review 2026-04-09)', async () => {
  // Bug caught by Copilot: the reuse path called tokenTracker.recordSession
  // but NOT logger.writeSessionSummary, so scripts/analyze-overhead.js
  // (which reads session-summary.json) couldn't see reusable-session
  // turns. The validation workflow depends on per-turn entries.
  const writtenSummaries = [];
  const fakeLogger = {
    createSessionLog: () => ({ logPath: '/tmp/fake.jsonl', write: () => {}, close: () => {} }),
    attachToSession: () => {},
    writeSessionSummary: (name, summary, meta) => {
      writtenSummaries.push({ name, summary, meta });
    },
  };
  const fakeSession = {
    turnCount: 0,
    // Planner now reads session.handle.systemPromptTokens and session.handle._toolCallCount
    // when writing the per-turn telemetry entry (see planner.js:649). Add a minimal
    // stub handle so the test exercises the per-turn summary path rather than throwing.
    handle: {
      systemPromptTokens: 0,
      _toolCallCount: 0,
    },
    sendPrompt: async () => ({
      type: 'result',
      structured_output: { subMissions: [] },
      usage: {
        input_tokens: 42,
        output_tokens: 100,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 5000,
      },
      total_cost_usd: 0.123,
    }),
  };
  const fakeSessionManager = {
    spawnReusable: () => fakeSession,
  };
  const fakeTokenTracker = { recordSession: () => {} };

  const planner = new Planner(fakeSessionManager, fakeLogger, fakeTokenTracker);
  // Pre-populate the reusable session to skip _ensureReusableSession path
  planner._reusableSession = fakeSession;

  await planner._planMissionReusable(
    '001-001',
    '/fake/root',
    { missionPlan: 'test mission plan' },
    7
  );

  // Should have called writeSessionSummary exactly once for this turn
  assert.equal(writtenSummaries.length, 1);
  const entry = writtenSummaries[0];
  assert.match(entry.name, /^planner-mission-001-001-turn\d+$/);

  // Summary fields derived from the SDK result event
  assert.equal(entry.summary.inputTokens, 42);
  assert.equal(entry.summary.outputTokens, 100);
  assert.equal(entry.summary.cacheCreation, 1000);
  assert.equal(entry.summary.cacheRead, 5000);
  assert.equal(entry.summary.totalCost, 0.123);
  assert.ok(typeof entry.summary.durationMs === 'number');
  assert.ok(typeof entry.summary.startedAt === 'string');
  assert.ok(typeof entry.summary.finishedAt === 'string');

  // Meta should mark this as a reused turn
  assert.equal(entry.meta.role, 'planner');
  assert.equal(entry.meta.phase, '3b');
  assert.equal(entry.meta.missionId, '001-001');
  assert.equal(entry.meta.reused, true);
});

await test('Planner: _planMissionReusable accounts the turn even when post-result parsing throws', async () => {
  // The session-manager discards a reusable session's handle-name in-flight
  // estimate at the turn boundary, so the turn's usage MUST be recorded before
  // any parsing/validation that could throw — otherwise a parse/validator
  // failure would drop the completed turn's real token spend from usage.
  const recorded = [];
  const fakeLogger = {
    createSessionLog: () => ({ logPath: '/tmp/fake.jsonl', write: () => {}, close: () => {} }),
    attachToSession: () => {},
    writeSessionSummary: () => {},
  };
  const fakeSession = {
    turnCount: 0,
    handle: { systemPromptTokens: 7, _toolCallCount: 3 },
    // No structured_output / parseable content → _extractJson throws.
    sendPrompt: async () => ({ type: 'result', usage: { input_tokens: 42, output_tokens: 100 }, total_cost_usd: 0.123 }),
  };
  const fakeSessionManager = { spawnReusable: () => fakeSession };
  const fakeTokenTracker = {
    recordSession: (name, role, result, meta) => { recorded.push({ name, role, meta }); },
  };

  const planner = new Planner(fakeSessionManager, fakeLogger, fakeTokenTracker);
  planner._reusableSession = fakeSession;

  await assert.rejects(
    () => planner._planMissionReusable('001-002', '/fake/root', { missionPlan: 'x' }, 7),
    /Could not extract structured plan/,
  );

  // The turn's usage was recorded BEFORE the parse threw — not dropped.
  assert.equal(recorded.length, 1, 'recordSession must run even when later parsing throws');
  assert.match(recorded[0].name, /^planner-mission-001-002-turn\d+$/);
  assert.equal(recorded[0].meta.reused, true);
});

// ── Planner: reusable session input consistency ────────────────────

await test('Planner: _ensureReusableSession throws on projectRoot mismatch (regression — Copilot review 2026-04-09)', async () => {
  // Bug caught by Copilot: _ensureReusableSession returned the
  // cached session without verifying the inputs match. A caller
  // that varies projectRoot across planMission calls would silently
  // reuse a session rooted in the wrong cwd, producing wrong tool
  // reads and wrong plans. Fix: store initial inputs on first
  // spawn, assert match on subsequent calls, throw on mismatch.
  const fakeLogger = {
    createSessionLog: () => ({ logPath: '/tmp/fake.jsonl', write: () => {}, close: () => {} }),
    attachToSession: () => {},
    writeSessionSummary: () => {},
  };
  const fakeSessionManager = {
    spawnReusable: () => ({ turnCount: 0, sendPrompt: async () => ({}), close: async () => {} }),
  };
  const planner = new Planner(fakeSessionManager, fakeLogger, { recordSession: () => {} });

  // First call spawns the session with projectRoot=/project-a
  planner._ensureReusableSession('/project-a', 7);

  // Second call with a DIFFERENT projectRoot must throw
  assert.throws(
    () => planner._ensureReusableSession('/project-b', 7),
    /projectRoot mismatch/
  );
});

await test('Planner: _ensureReusableSession throws on maxTasks mismatch (regression — Copilot review 2026-04-09)', async () => {
  const fakeLogger = {
    createSessionLog: () => ({ logPath: '/tmp/fake.jsonl', write: () => {}, close: () => {} }),
    attachToSession: () => {},
    writeSessionSummary: () => {},
  };
  const fakeSessionManager = {
    spawnReusable: () => ({ turnCount: 0, sendPrompt: async () => ({}), close: async () => {} }),
  };
  const planner = new Planner(fakeSessionManager, fakeLogger, { recordSession: () => {} });

  // First call spawns the session with maxTasks=7
  planner._ensureReusableSession('/project-a', 7);

  // Second call with a DIFFERENT maxTasks must throw
  assert.throws(
    () => planner._ensureReusableSession('/project-a', 10),
    /maxTasks mismatch/
  );
});

await test('Planner: _ensureReusableSession returns same session on matching inputs', async () => {
  // Happy path: same inputs → same session returned, no throw.
  const fakeLogger = {
    createSessionLog: () => ({ logPath: '/tmp/fake.jsonl', write: () => {}, close: () => {} }),
    attachToSession: () => {},
    writeSessionSummary: () => {},
  };
  let spawnCount = 0;
  const fakeSessionManager = {
    spawnReusable: () => {
      spawnCount++;
      return { turnCount: 0, sendPrompt: async () => ({}), close: async () => {} };
    },
  };
  const planner = new Planner(fakeSessionManager, fakeLogger, { recordSession: () => {} });

  const s1 = planner._ensureReusableSession('/project-a', 7);
  const s2 = planner._ensureReusableSession('/project-a', 7);
  const s3 = planner._ensureReusableSession('/project-a', 7);

  assert.strictEqual(s1, s2);
  assert.strictEqual(s2, s3);
  assert.equal(spawnCount, 1, 'spawnReusable should have been called exactly once');
});

await test('Planner: closeReusableSession clears input tracking, allowing different inputs next time', async () => {
  // After close, the input-consistency tracking must reset so a
  // subsequent _ensureReusableSession call with different inputs
  // creates a fresh session instead of re-throwing.
  const fakeLogger = {
    createSessionLog: () => ({ logPath: '/tmp/fake.jsonl', write: () => {}, close: () => {} }),
    attachToSession: () => {},
    writeSessionSummary: () => {},
  };
  let spawnCount = 0;
  const fakeSessionManager = {
    spawnReusable: () => {
      spawnCount++;
      return { turnCount: 0, sendPrompt: async () => ({}), close: async () => {} };
    },
  };
  const planner = new Planner(fakeSessionManager, fakeLogger, { recordSession: () => {} });

  planner._ensureReusableSession('/project-a', 7);
  await planner.closeReusableSession();

  // After close, using different inputs should succeed (not throw)
  planner._ensureReusableSession('/project-b', 10);
  assert.equal(spawnCount, 2, 'should have spawned twice: once before close, once after');
  assert.deepEqual(planner._reusableSessionInputs, { projectRoot: '/project-b', maxTasks: 10 });
});

// ── Planner: closeReusableSession safety ────────────────────────────

await test('Planner: closeReusableSession is safe when no session was opened', async () => {
  // Mock SessionManager + Logger + TokenTracker so we don't touch the SDK
  const fakeSessionManager = {};
  const fakeLogger = {
    createSessionLog: () => ({ logPath: '/tmp/fake.jsonl', write: () => {}, close: () => {} }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: () => {},
  };
  const fakeTokenTracker = { recordSession: () => {} };

  const planner = new Planner(fakeSessionManager, fakeLogger, fakeTokenTracker);
  // Should not throw — no session was ever opened
  await planner.closeReusableSession();
  assert.equal(planner._reusableSession, null);
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
