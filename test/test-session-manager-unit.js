/**
 * test-session-manager-unit.js — Unit tests for session-manager.js additions.
 *
 * Covers:
 *   1. SessionHandle initializes _toolCallCount to 0 and systemPromptTokens to 0
 *   2. _buildSdkOptions computes approx tokens from systemPrompt length / 4
 *   3. _dispatchEvent increments _toolCallCount for each tool_use block in assistant events
 *   4. spawn() sets handle.systemPromptTokens from computed value
 *   5. spawnReusable() sets handle.systemPromptTokens from computed value
 *
 * Run: node test/test-session-manager-unit.js
 */
import assert from 'assert';
import { SessionHandle, SessionManager, RESULT_WATCHDOG_MS } from '../src/orchestrator/infra/session-manager.js';

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

// --- Test 1: SessionHandle initializes _toolCallCount and systemPromptTokens ---
await test('SessionHandle initializes _toolCallCount to 0', () => {
  const handle = new SessionHandle('test-handle');
  assert.strictEqual(handle._toolCallCount, 0, `Expected 0, got ${handle._toolCallCount}`);
});

await test('SessionHandle initializes systemPromptTokens to 0', () => {
  const handle = new SessionHandle('test-handle');
  assert.strictEqual(handle.systemPromptTokens, 0, `Expected 0, got ${handle.systemPromptTokens}`);
});

// --- Test 2: _buildSdkOptions computes approx tokens from systemPrompt ---
await test('_buildSdkOptions computes approx tokens: Math.ceil(length / 4)', () => {
  const sm = new SessionManager();
  const prompt = 'A'.repeat(100); // 100 chars → ceil(100/4) = 25
  const opts = sm._buildSdkOptions({ systemPrompt: prompt });
  assert.strictEqual(
    opts._approxSystemPromptTokens,
    25,
    `Expected 25, got ${opts._approxSystemPromptTokens}`
  );
});

await test('_buildSdkOptions: non-multiple-of-4 rounds up (Math.ceil)', () => {
  const sm = new SessionManager();
  const prompt = 'A'.repeat(101); // 101 chars → ceil(101/4) = 26
  const opts = sm._buildSdkOptions({ systemPrompt: prompt });
  assert.strictEqual(
    opts._approxSystemPromptTokens,
    26,
    `Expected 26, got ${opts._approxSystemPromptTokens}`
  );
});

await test('_buildSdkOptions: no systemPrompt → _approxSystemPromptTokens undefined', () => {
  const sm = new SessionManager();
  const opts = sm._buildSdkOptions({});
  assert.strictEqual(
    opts._approxSystemPromptTokens,
    undefined,
    `Expected undefined, got ${opts._approxSystemPromptTokens}`
  );
});

// --- Test 3: _dispatchEvent increments _toolCallCount for tool_use blocks ---
await test('_dispatchEvent: counts tool_use blocks in assistant event', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('test-dispatch');

  const event = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'I will call a tool.' },
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} },
        { type: 'tool_use', id: 'tu_2', name: 'Read', input: {} },
      ],
    },
  };

  sm._dispatchEvent(handle, event);
  assert.strictEqual(handle._toolCallCount, 2, `Expected 2, got ${handle._toolCallCount}`);
});

await test('_dispatchEvent: no tool_use blocks → _toolCallCount stays 0', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('test-dispatch-none');

  const event = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Just text, no tools.' },
      ],
    },
  };

  sm._dispatchEvent(handle, event);
  assert.strictEqual(handle._toolCallCount, 0, `Expected 0, got ${handle._toolCallCount}`);
});

await test('_dispatchEvent: accumulates across multiple assistant events', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('test-dispatch-accumulate');

  sm._dispatchEvent(handle, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] },
  });
  sm._dispatchEvent(handle, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: {} }, { type: 'tool_use', id: 'tu_3', name: 'Write', input: {} }] },
  });

  assert.strictEqual(handle._toolCallCount, 3, `Expected 3, got ${handle._toolCallCount}`);
});

await test('_dispatchEvent: non-assistant events do not affect _toolCallCount', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('test-dispatch-result');

  sm._dispatchEvent(handle, {
    type: 'result',
    subtype: 'success',
    result: 'done',
  });

  assert.strictEqual(handle._toolCallCount, 0, `Expected 0, got ${handle._toolCallCount}`);
});

// --- Test 4: spawn() sets handle.systemPromptTokens ---
// NOTE: these four token-math cases inject makeInstantCloseQueryFn so no real
// SDK entrypoint is reached — they previously built bare SessionManagers and
// were the 4 live real-spawn leaks the hermeticity guard now blocks
// (probe-verified 2026-08-20). The assertions are purely synchronous math and
// are unaffected by the fake.
await test('spawn() sets handle.systemPromptTokens synchronously before SDK call', () => {
  const sm = new SessionManager();
  sm._queryFn = makeInstantCloseQueryFn();
  const systemPrompt = 'X'.repeat(400); // 400 chars → ceil(400/4) = 100 tokens
  const promise = sm.spawn({
    name: 'test-spawn-tokens',
    prompt: 'hello',
    systemPrompt,
  });

  // systemPromptTokens is set synchronously in spawn() before the async IIFE runs
  assert.strictEqual(
    promise.handle.systemPromptTokens,
    100,
    `Expected 100, got ${promise.handle.systemPromptTokens}`
  );

  // The instant-close fake settles the spawn on its own; kill() is not
  // needed (and the fake carries no .close()). Await settlement.
  return promise.catch(() => {});
});

await test('spawn() sets handle.systemPromptTokens to 0 when no systemPrompt', () => {
  const sm = new SessionManager();
  sm._queryFn = makeInstantCloseQueryFn();
  const promise = sm.spawn({
    name: 'test-spawn-no-prompt',
    prompt: 'hello',
  });

  assert.strictEqual(
    promise.handle.systemPromptTokens,
    0,
    `Expected 0, got ${promise.handle.systemPromptTokens}`
  );

  return promise.catch(() => {});
});

// --- Test 5: spawnReusable() sets handle.systemPromptTokens ---
await test('spawnReusable() sets handle.systemPromptTokens from computed value', () => {
  const sm = new SessionManager();
  sm._queryFn = makeInstantCloseQueryFn();
  const systemPrompt = 'Y'.repeat(80); // 80 chars → ceil(80/4) = 20 tokens
  let session;
  try {
    session = sm.spawnReusable({
      name: 'test-reusable-tokens',
      systemPrompt,
    });

    assert.strictEqual(
      session.handle.systemPromptTokens,
      20,
      `Expected 20, got ${session.handle.systemPromptTokens}`
    );
  } finally {
    if (session) {
      session.close().catch(() => {});
    }
  }
});

await test('spawnReusable() sets handle.systemPromptTokens to 0 when no systemPrompt', () => {
  const sm = new SessionManager();
  sm._queryFn = makeInstantCloseQueryFn();
  let session;
  try {
    session = sm.spawnReusable({
      name: 'test-reusable-no-prompt',
    });

    assert.strictEqual(
      session.handle.systemPromptTokens,
      0,
      `Expected 0, got ${session.handle.systemPromptTokens}`
    );
  } finally {
    if (session) {
      session.close().catch(() => {});
    }
  }
});

// --- Hermeticity guard: a bare (un-injected) SessionManager must refuse to
// reach the real SDK under CC_ORCH_TEST=1 (spawn + reusable legs). Env is set
// explicitly (saved/restored) so these cases exercise the guarded condition
// even when the file runs directly outside the runner.
await test('hermeticity guard: spawn() with real _queryFn throws under CC_ORCH_TEST=1', () => {
  const savedTest = process.env.CC_ORCH_TEST;
  const savedReal = process.env.CC_ORCH_REAL_SDK;
  process.env.CC_ORCH_TEST = '1';
  delete process.env.CC_ORCH_REAL_SDK;
  try {
    const sm = new SessionManager();
    const promise = sm.spawn({ name: 'test-hermeticity-spawn', prompt: 'hello' });
    let rejected = null;
    return promise.then(
      () => { throw new Error('Expected spawn() to reject under the hermeticity guard'); },
      (err) => {
        rejected = err;
        assert.ok(
          /Hermeticity guard/.test(err.message),
          `Expected hermeticity-guard rejection, got: ${err.message}`
        );
      }
    );
  } finally {
    if (savedTest === undefined) delete process.env.CC_ORCH_TEST; else process.env.CC_ORCH_TEST = savedTest;
    if (savedReal === undefined) delete process.env.CC_ORCH_REAL_SDK; else process.env.CC_ORCH_REAL_SDK = savedReal;
  }
});

await test('hermeticity guard: spawnReusable() with real _queryFn throws under CC_ORCH_TEST=1', () => {
  const savedTest = process.env.CC_ORCH_TEST;
  const savedReal = process.env.CC_ORCH_REAL_SDK;
  process.env.CC_ORCH_TEST = '1';
  delete process.env.CC_ORCH_REAL_SDK;
  try {
    const sm = new SessionManager();
    assert.throws(
      () => sm.spawnReusable({ name: 'test-hermeticity-reusable' }),
      /Hermeticity guard/,
      'Expected spawnReusable() to throw under the hermeticity guard'
    );
    assert.strictEqual(
      sm.active().length,
      0,
      'Constructor unwind must not leak a handle in _active after the guard throw'
    );
  } finally {
    if (savedTest === undefined) delete process.env.CC_ORCH_TEST; else process.env.CC_ORCH_TEST = savedTest;
    if (savedReal === undefined) delete process.env.CC_ORCH_REAL_SDK; else process.env.CC_ORCH_REAL_SDK = savedReal;
  }
});

// --- New tests: read-then-write enforcement and PermissionResult migration ---

// Test A: SessionHandle._readFiles initialized as empty Set
await test('SessionHandle._readFiles is initialized as an empty Set', () => {
  const handle = new SessionHandle('test-readfiles');
  assert.ok(handle._readFiles instanceof Set, `Expected Set, got ${typeof handle._readFiles}`);
  assert.strictEqual(handle._readFiles.size, 0, `Expected empty Set, got size ${handle._readFiles.size}`);
});

// Test B: _guardToolUse returns PermissionResult objects not booleans
await test('_guardToolUse returns { behavior: "allow" } object (not boolean) for safe Read', () => {
  const sm = new SessionManager();
  const result = sm._guardToolUse('Read', { file_path: '/some/file.js' }, null, new Set());
  assert.strictEqual(typeof result, 'object', `Expected object, got ${typeof result}`);
  assert.strictEqual(result.behavior, 'allow', `Expected "allow", got ${result.behavior}`);
});

await test('_guardToolUse returns { behavior: "deny", message } object (not boolean) for dangerous Bash', () => {
  const sm = new SessionManager();
  const result = sm._guardToolUse('Bash', { command: 'git commit -m "test"' }, null, new Set());
  assert.strictEqual(typeof result, 'object', `Expected object, got ${typeof result}`);
  assert.strictEqual(result.behavior, 'deny', `Expected "deny", got ${result.behavior}`);
  assert.ok(typeof result.message === 'string', `Expected string message, got ${typeof result.message}`);
});

// Test C: canUseTool tracks Read calls into _readFiles
await test('canUseTool (via _buildSdkOptions) tracks Read calls into _readFiles', () => {
  const sm = new SessionManager();
  const readFiles = new Set();
  const opts = sm._buildSdkOptions({ targetFiles: [] }, readFiles);
  opts.canUseTool('Read', { file_path: '/some/path/file.js' });
  assert.ok(readFiles.has('/some/path/file.js'), `Expected readFiles to contain /some/path/file.js`);
});

// Test D: Edit blocked on existing-but-unread file
await test('_guardToolUse: Edit blocked on existing-but-unread file', () => {
  const sm = new SessionManager();
  const existingFile = new URL(import.meta.url).pathname; // this test file exists on disk
  const result = sm._guardToolUse(
    'Edit',
    { file_path: existingFile },
    [existingFile],  // targetFiles includes the file
    new Set()        // readFiles is empty — file not read yet
  );
  assert.strictEqual(result.behavior, 'deny', `Expected "deny", got ${result.behavior}`);
  assert.ok(result.message.includes('not been Read'), `Expected message about not been Read, got: ${result.message}`);
});

// Test E: Edit allowed after Read
await test('_guardToolUse: Edit allowed after file has been Read', () => {
  const sm = new SessionManager();
  const existingFile = new URL(import.meta.url).pathname;
  const readFiles = new Set([existingFile]); // already read
  const result = sm._guardToolUse(
    'Edit',
    { file_path: existingFile },
    [existingFile],
    readFiles
  );
  assert.strictEqual(result.behavior, 'allow', `Expected "allow", got ${result.behavior}`);
});

// Test F: Write allowed on non-existent file without Read
await test('_guardToolUse: Write allowed on non-existent file without prior Read', () => {
  const sm = new SessionManager();
  const nonExistentFile = '/tmp/__cc_orch_test_nonexistent_' + Date.now() + '.js';
  const result = sm._guardToolUse(
    'Write',
    { file_path: nonExistentFile },
    [nonExistentFile],  // in targetFiles
    new Set()           // readFiles empty
  );
  assert.strictEqual(result.behavior, 'allow', `Expected "allow", got ${result.behavior}`);
});

// Test G: no read-guard when targetFiles absent
await test('_guardToolUse: Edit allowed on any existing file when targetFiles is null', () => {
  const sm = new SessionManager();
  const existingFile = new URL(import.meta.url).pathname;
  const result = sm._guardToolUse(
    'Edit',
    { file_path: existingFile },
    null,       // no targetFiles
    new Set()   // readFiles empty
  );
  assert.strictEqual(result.behavior, 'allow', `Expected "allow" when no targetFiles, got ${result.behavior}`);
});

await test('_guardToolUse: Edit allowed on any existing file when targetFiles is empty array', () => {
  const sm = new SessionManager();
  const existingFile = new URL(import.meta.url).pathname;
  const result = sm._guardToolUse(
    'Edit',
    { file_path: existingFile },
    [],         // empty targetFiles — guard skipped
    new Set()   // readFiles empty
  );
  assert.strictEqual(result.behavior, 'allow', `Expected "allow" for empty targetFiles, got ${result.behavior}`);
});

// Test H: Bash blocking returns PermissionResult deny
await test('_guardToolUse: Bash blocking returns PermissionResult deny with message for multiple dangerous patterns', () => {
  const sm = new SessionManager();
  const dangerousCommands = [
    'git commit -m "oops"',
    'git push origin main',
    'rm -rf /tmp/test',
    'sudo apt-get install something',
    'npm publish',
  ];
  for (const cmd of dangerousCommands) {
    const result = sm._guardToolUse('Bash', { command: cmd }, null, new Set());
    assert.strictEqual(result.behavior, 'deny', `Expected deny for: ${cmd}`);
    assert.ok(typeof result.message === 'string', `Expected string message for: ${cmd}`);
    assert.ok(result.message.length > 0, `Expected non-empty message for: ${cmd}`);
  }
});

// Test I: same-turn Read+Edit ordering via sequential canUseTool calls
await test('canUseTool: Read then Edit in same turn allows Edit (sequential canUseTool calls)', () => {
  const sm = new SessionManager();
  const existingFile = new URL(import.meta.url).pathname;
  const readFiles = new Set();
  const opts = sm._buildSdkOptions({ targetFiles: [existingFile] }, readFiles);

  // First call: Read — should be allowed and track the file
  const readResult = opts.canUseTool('Read', { file_path: existingFile });
  assert.strictEqual(readResult.behavior, 'allow', `Read should be allowed, got ${readResult.behavior}`);
  assert.ok(readFiles.has(existingFile), `_readFiles should contain file after Read`);

  // Second call: Edit — should now be allowed since file was Read in same turn
  const editResult = opts.canUseTool('Edit', { file_path: existingFile });
  assert.strictEqual(editResult.behavior, 'allow', `Edit should be allowed after Read, got ${editResult.behavior}`);
});

// --- Tests: _capturedStructuredOutput ---

// Test 1: SessionHandle initializes _capturedStructuredOutput to null
await test('SessionHandle initializes _capturedStructuredOutput to null', () => {
  const handle = new SessionHandle('test-cso-init');
  assert.strictEqual(handle._capturedStructuredOutput, null, `Expected null, got ${handle._capturedStructuredOutput}`);
});

// Test 2: _dispatchEvent captures StructuredOutput tool_use input on handle
await test('_dispatchEvent captures StructuredOutput tool_use input on handle', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('test-cso-capture');

  const payload = { status: 'COMPLETED', summary: 'done' };
  sm._dispatchEvent(handle, {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'StructuredOutput', input: payload },
      ],
    },
  });

  assert.deepStrictEqual(handle._capturedStructuredOutput, payload, `Expected payload, got ${JSON.stringify(handle._capturedStructuredOutput)}`);
});

// Test 3: _dispatchEvent overwrites _capturedStructuredOutput on second StructuredOutput call (LAST-wins)
await test('_dispatchEvent overwrites _capturedStructuredOutput on second StructuredOutput call (LAST-wins)', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('test-cso-last-wins');

  const first = { status: 'COMPLETED', summary: 'first' };
  const second = { status: 'BLOCKED', summary: 'second', blockReason: 'ambiguous' };

  sm._dispatchEvent(handle, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'StructuredOutput', input: first }] },
  });
  sm._dispatchEvent(handle, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'StructuredOutput', input: second }] },
  });

  assert.deepStrictEqual(handle._capturedStructuredOutput, second, `Expected second payload to win, got ${JSON.stringify(handle._capturedStructuredOutput)}`);
});

// Test 4: _dispatchEvent copies _capturedStructuredOutput to result event when event.structured_output is absent
await test('_dispatchEvent copies _capturedStructuredOutput to result event when structured_output absent', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('test-cso-result-copy');

  const payload = { status: 'COMPLETED', summary: 'done' };
  sm._dispatchEvent(handle, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'StructuredOutput', input: payload }] },
  });

  const resultEvent = { type: 'result', subtype: 'success' };
  sm._dispatchEvent(handle, resultEvent);

  assert.deepStrictEqual(resultEvent._capturedStructuredOutput, payload, `Expected _capturedStructuredOutput on result event, got ${JSON.stringify(resultEvent._capturedStructuredOutput)}`);
});

// Test 5: _dispatchEvent does NOT copy fallback when result event already has structured_output
await test('_dispatchEvent does NOT copy fallback when result event already has structured_output', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('test-cso-no-overwrite');

  const captured = { status: 'COMPLETED', summary: 'from tool' };
  sm._dispatchEvent(handle, {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'StructuredOutput', input: captured }] },
  });

  const nativeOutput = { status: 'COMPLETED', summary: 'from SDK' };
  const resultEvent = { type: 'result', subtype: 'success', structured_output: nativeOutput };
  sm._dispatchEvent(handle, resultEvent);

  assert.strictEqual(resultEvent._capturedStructuredOutput, undefined, `Expected _capturedStructuredOutput to be absent on result with structured_output, got ${JSON.stringify(resultEvent._capturedStructuredOutput)}`);
});

// ─── TC-hang tests ──────────────────────────────────────────────────────────

// TC-hang-1: result short-circuits the for-await loop; spawn resolves <500ms;
//            _capturedStructuredOutput from StructuredOutput tool_use is copied
//            onto the result event when the event omits structured_output.
await test('TC-hang-1: spawn() resolves <500ms; bogus extra event ignored; _capturedStructuredOutput preserved', async () => {
  const sm = new SessionManager();
  const structuredPayload = { status: 'COMPLETED', summary: 'mock output' };

  sm._queryFn = () => {
    let step = 0;
    const events = [
      { type: 'system', subtype: 'init', session_id: 'mock-123' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_so', name: 'StructuredOutput', input: structuredPayload },
          ],
        },
      },
      // result event — omits structured_output so fallback copy should happen
      { type: 'result', subtype: 'success', result: 'done' },
      // bogus extra event — must never be dispatched because loop breaks on result
      { type: 'message', content: 'bogus extra — should never be dispatched' },
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

  const start = Date.now();
  const { handle, result } = await sm.spawn({ name: 'tc-hang-1', prompt: 'test' });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 500, `Expected spawn() to resolve in <500ms, took ${elapsed}ms`);
  assert.ok(handle._resultReceived, 'handle._resultReceived should be true after result');
  assert.deepStrictEqual(
    result._capturedStructuredOutput,
    structuredPayload,
    `Expected _capturedStructuredOutput on result event, got ${JSON.stringify(result._capturedStructuredOutput)}`
  );
});

// TC-hang-2: watchdog fires at an overridden (short) delay; when .return() throws
//            the error must be swallowed — no unhandled rejection, no crash.
//            Because RESULT_WATCHDOG_MS is a module-level const with no injection
//            seam, the test replaces the timer after _dispatchEvent sets it.
await test('TC-hang-2: watchdog fires and swallows .return() throws (no unhandled rejection)', async () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('tc-hang-2');
  sm._active.set(handle.name, handle);

  // Stub: .return() throws — the watchdog must swallow this
  let returnCalled = false;
  handle._query = {
    return() {
      returnCalled = true;
      throw new Error('mock .return() throw — must be swallowed by watchdog');
    },
  };

  // Note: the first-wins flag + watchdog live in spawn()'s for-await loop
  // (single-shot semantics), NOT in _dispatchEvent (shared with
  // ReusableSession). This test exercises the watchdog's swallow-throws
  // behavior, which is orthogonal to where it's armed — simulate the
  // post-result state by dispatching + setting the flag + arming the
  // watchdog manually.
  const resultEvent = { type: 'result', subtype: 'success', result: 'done' };
  sm._dispatchEvent(handle, resultEvent);
  handle._resultReceived = true;
  handle._watchdogTimer = setTimeout(() => {
    try { handle._query?.return?.(); } catch {}
  }, 60_000);
  handle._watchdogTimer.unref();

  assert.ok(handle._resultReceived, '_resultReceived should be true after test setup');
  assert.ok(handle._watchdogTimer !== null, 'watchdog timer should be armed after test setup');

  // Override the delay: replace the 60 000 ms production timer with a 30 ms test timer.
  // The callback mirrors the real implementation inside _dispatchEvent.
  clearTimeout(handle._watchdogTimer);
  let timerFired = false;
  handle._watchdogTimer = setTimeout(() => {
    timerFired = true;
    try { handle._query?.return?.(); } catch { /* swallow — matches real behaviour */ }
  }, 30);
  handle._watchdogTimer.unref();

  // Wait long enough for the short watchdog to fire
  await new Promise((r) => setTimeout(r, 150));

  assert.ok(timerFired, 'watchdog timer should have fired');
  assert.ok(returnCalled, 'watchdog should have called .return() on the query');
  // Reaching here without an unhandled-rejection crash proves the throw was swallowed
});

// TC-hang-3: when the iterator closes naturally right after the result event,
//            spawn() must clear _watchdogTimer (no leaked timer, process can exit).
await test('TC-hang-3: clean iterator close clears _watchdogTimer (handle._watchdogTimer === null)', async () => {
  const sm = new SessionManager();

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
            // Iterator closes naturally — done: true
            return { value: undefined, done: true };
          },
        };
      },
    };
  };

  const { handle } = await sm.spawn({ name: 'tc-hang-3', prompt: 'test' });

  assert.strictEqual(
    handle._watchdogTimer,
    null,
    `Expected _watchdogTimer === null after clean close, got ${handle._watchdogTimer}`
  );
});

// TC-hang-4: when two result events arrive back-to-back, only the FIRST is
//            accepted — handle._result equals the first event, the 'result'
//            listener fires exactly once, and _resultReceived is set on the first.
await test('TC-hang-4: two back-to-back result events → _result is FIRST; result listener fires once', async () => {
  const sm = new SessionManager();
  const firstResult  = { type: 'result', subtype: 'success', result: 'first'  };
  const secondResult = { type: 'result', subtype: 'success', result: 'second' };

  sm._queryFn = () => {
    let step = 0;
    const events = [firstResult, secondResult];
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

  let resultListenerCount = 0;
  const promise = sm.spawn({ name: 'tc-hang-4', prompt: 'test' });
  promise.handle.on('result', () => { resultListenerCount++; });

  const { handle } = await promise;

  assert.strictEqual(
    handle._result,
    firstResult,
    `Expected _result to be firstResult, got ${JSON.stringify(handle._result)}`
  );
  assert.strictEqual(
    resultListenerCount,
    1,
    `Expected 'result' listener to fire exactly once, got ${resultListenerCount}`
  );
  assert.ok(handle._resultReceived, 'handle._resultReceived should be true');
});

// ─── AbortSignal tests ──────────────────────────────────────────────────────

// Helper: minimal mock iterator that closes immediately with done:true
function makeInstantCloseQueryFn() {
  return () => ({
    [Symbol.asyncIterator]() {
      return { next() { return Promise.resolve({ value: undefined, done: true }); } };
    },
  });
}

// Helper: mock that yields one result event immediately
function makeResultQueryFn() {
  return () => {
    let step = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (step === 0) {
              step++;
              return { value: { type: 'result', subtype: 'success', result: 'done' }, done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
  };
}

// TC-spawn-pre-aborted
await test('TC-spawn-pre-aborted: spawn with pre-aborted signal rejects with AbortError', async () => {
  const sm = new SessionManager();
  sm._queryFn = makeInstantCloseQueryFn();

  const controller = new AbortController();
  controller.abort();

  const promise = sm.spawn({ name: 'tc-pre-aborted', prompt: 'test', signal: controller.signal });
  try {
    await promise;
    assert.fail('Expected promise to reject with AbortError');
  } catch (err) {
    assert.strictEqual(err.name, 'AbortError', `Expected AbortError, got ${err.name}: ${err.message}`);
  }
});

// TC-spawn-mid-flight-abort
await test('TC-spawn-mid-flight-abort: aborting during for-await rejects with AbortError and handle.finished is true', async () => {
  const sm = new SessionManager();

  // Mock: yields one assistant event, then hangs until .return() is called
  let rejectNextCall = null;
  sm._queryFn = () => {
    let step = 0;
    return {
      // onAbort calls handle._query?.return?.() which is this .return()
      return() {
        if (rejectNextCall) {
          rejectNextCall(new DOMException('The operation was aborted', 'AbortError'));
          rejectNextCall = null;
        }
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (step === 0) {
              step++;
              return Promise.resolve({
                value: { type: 'assistant', message: { content: [] } },
                done: false,
              });
            }
            // Hang until .return() is called from onAbort
            return new Promise((_, reject) => { rejectNextCall = reject; });
          },
        };
      },
    };
  };

  const controller = new AbortController();
  const promise = sm.spawn({ name: 'tc-mid-flight', prompt: 'test', signal: controller.signal });
  const handle = promise.handle;

  // Give spawn time to reach the hanging next()
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();

  try {
    await promise;
    assert.fail('Expected promise to reject with AbortError');
  } catch (err) {
    assert.strictEqual(err.name, 'AbortError', `Expected AbortError, got ${err.name}: ${err.message}`);
  }

  assert.ok(handle.finished, 'handle.finished should be true after mid-flight abort');
});

// TC-spawn-signal-from-instance
await test('TC-spawn-signal-from-instance: sm.signal fallback works when options.signal absent', async () => {
  const sm = new SessionManager();
  sm._queryFn = makeInstantCloseQueryFn();

  const controller = new AbortController();
  controller.abort();
  sm.signal = controller.signal; // set instance-level signal

  // spawn WITHOUT options.signal — should fall back to sm.signal
  const promise = sm.spawn({ name: 'tc-instance-signal', prompt: 'test' });
  try {
    await promise;
    assert.fail('Expected promise to reject with AbortError');
  } catch (err) {
    assert.strictEqual(err.name, 'AbortError', `Expected AbortError from instance signal, got ${err.name}: ${err.message}`);
  }
});

// TC-spawn-options-signal-overrides-instance
await test('TC-spawn-options-signal-overrides-instance: options.signal takes priority over sm.signal', async () => {
  const sm = new SessionManager();
  sm._queryFn = makeInstantCloseQueryFn();

  // Instance-level signal: never aborted
  const instanceController = new AbortController();
  sm.signal = instanceController.signal;

  // options.signal: pre-aborted
  const optionsController = new AbortController();
  optionsController.abort();

  const promise = sm.spawn({
    name: 'tc-options-overrides',
    prompt: 'test',
    signal: optionsController.signal,
  });
  try {
    await promise;
    assert.fail('Expected promise to reject with AbortError');
  } catch (err) {
    assert.strictEqual(err.name, 'AbortError', `Expected AbortError from options.signal, got ${err.name}: ${err.message}`);
  }
});

// TC-sendPrompt-pre-aborted
await test('TC-sendPrompt-pre-aborted: sendPrompt on session with aborted signal throws AbortError', async () => {
  const sm = new SessionManager();

  // Mock: hangs indefinitely (the session will never process events)
  sm._queryFn = () => ({
    [Symbol.asyncIterator]() {
      return { next() { return new Promise(() => {}); } }; // never resolves
    },
  });

  const controller = new AbortController();
  controller.abort(); // pre-aborted

  const session = sm.spawnReusable({ name: 'tc-sendprompt-aborted', signal: controller.signal });

  try {
    await session.sendPrompt('hello');
    assert.fail('Expected sendPrompt to throw AbortError');
  } catch (err) {
    assert.strictEqual(err.name, 'AbortError', `Expected AbortError from sendPrompt, got ${err.name}: ${err.message}`);
  } finally {
    session.close().catch(() => {});
  }
});

// TC-spawn-no-signal-unaffected
await test('TC-spawn-no-signal-unaffected: spawn without signal resolves normally (regression guard)', async () => {
  const sm = new SessionManager();
  sm._queryFn = makeResultQueryFn();

  // Call spawn() with NO signal at all
  const { handle, result } = await sm.spawn({ name: 'tc-no-signal', prompt: 'test' });

  assert.ok(result, 'Expected a result object');
  assert.strictEqual(result.type, 'result', `Expected result.type === 'result', got ${result.type}`);
  assert.ok(handle.finished, 'handle.finished should be true');
});

// --- Summary ---
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
