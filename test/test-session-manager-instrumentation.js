/**
 * test-session-manager-instrumentation.js — Unit tests for SessionManager instrumentation:
 *   - _toolCallCount increments on _dispatchEvent with assistant/tool_use events
 *   - systemPromptTokens flows through _buildSdkOptions → SessionHandle
 *   - Backward-compat: pre-instrumentation session entries (no new fields) load and
 *     aggregate in TokenTracker without error, yielding 0 for new fields.
 *
 * Run: node test/test-session-manager-instrumentation.js
 */
import assert from 'assert';
import { SessionManager, SessionHandle } from '../src/orchestrator/infra/session-manager.js';
import { TokenTracker } from '../src/orchestrator/infra/token-tracker.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

// ---------- Helpers ----------

/** Build a mock assistant SDK event with an array of content blocks. */
function makeAssistantEvent(contentBlocks) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: contentBlocks,
    },
  };
}

/** Build a tool_use content block. */
function toolUseBlock(id = 'tu_1') {
  return { type: 'tool_use', id, name: 'SomeTool', input: {} };
}

/** Build a text content block. */
function textBlock(text = 'hello') {
  return { type: 'text', text };
}

// ---------- TC1: _dispatchEvent with 2 tool_use blocks increments _toolCallCount by 2 ----------

test('TC1: _dispatchEvent with assistant event containing 2 tool_use blocks increments _toolCallCount by 2', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('tc1');

  assert.strictEqual(handle._toolCallCount, 0, 'Initial _toolCallCount should be 0');

  const event = makeAssistantEvent([toolUseBlock('tu_a'), toolUseBlock('tu_b')]);
  sm._dispatchEvent(handle, event);

  assert.strictEqual(handle._toolCallCount, 2, `Expected _toolCallCount=2, got ${handle._toolCallCount}`);
});

// ---------- TC2: _dispatchEvent with 0 tool_use blocks does not increment _toolCallCount ----------

test('TC2: _dispatchEvent with assistant event containing 0 tool_use blocks does not increment _toolCallCount', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('tc2');

  const event = makeAssistantEvent([textBlock('just text, no tools')]);
  sm._dispatchEvent(handle, event);

  assert.strictEqual(handle._toolCallCount, 0, `Expected _toolCallCount=0, got ${handle._toolCallCount}`);
});

// ---------- TC3: Multiple assistant events accumulate _toolCallCount correctly ----------

test('TC3: Multiple assistant events accumulate _toolCallCount correctly', () => {
  const sm = new SessionManager();
  const handle = new SessionHandle('tc3');

  // First event: 1 tool_use
  sm._dispatchEvent(handle, makeAssistantEvent([toolUseBlock('tu_1')]));
  // Second event: 3 tool_use
  sm._dispatchEvent(handle, makeAssistantEvent([
    toolUseBlock('tu_2'),
    toolUseBlock('tu_3'),
    toolUseBlock('tu_4'),
  ]));
  // Third event: mixed (1 text + 2 tool_use)
  sm._dispatchEvent(handle, makeAssistantEvent([
    textBlock('some text'),
    toolUseBlock('tu_5'),
    toolUseBlock('tu_6'),
  ]));

  assert.strictEqual(handle._toolCallCount, 6, `Expected _toolCallCount=6, got ${handle._toolCallCount}`);
});

// ---------- TC4: systemPromptTokens computed as ceil(systemPrompt.length / 4) ----------

test('TC4: systemPromptTokens computed as ceil(systemPrompt.length / 4)', () => {
  const sm = new SessionManager();
  const systemPrompt = 'A'.repeat(100); // 100 chars → ceil(100/4) = 25
  const sdkOpts = sm._buildSdkOptions({ systemPrompt });

  const expected = Math.ceil(systemPrompt.length / 4);
  assert.strictEqual(
    sdkOpts._approxSystemPromptTokens,
    expected,
    `Expected _approxSystemPromptTokens=${expected}, got ${sdkOpts._approxSystemPromptTokens}`
  );

  // Also verify it flows onto the handle (as done in spawn/spawnReusable)
  const handle = new SessionHandle('tc4');
  handle.systemPromptTokens = sdkOpts._approxSystemPromptTokens || 0;
  assert.strictEqual(handle.systemPromptTokens, expected, `Expected handle.systemPromptTokens=${expected}`);

  // Non-multiple-of-4 to exercise ceil
  const systemPrompt2 = 'B'.repeat(101); // ceil(101/4) = 26
  const sdkOpts2 = sm._buildSdkOptions({ systemPrompt: systemPrompt2 });
  assert.strictEqual(
    sdkOpts2._approxSystemPromptTokens,
    Math.ceil(101 / 4),
    `Expected 26 for 101-char prompt, got ${sdkOpts2._approxSystemPromptTokens}`
  );
});

// ---------- TC5: systemPromptTokens is 0 when no systemPrompt provided ----------

test('TC5: systemPromptTokens is 0 when no systemPrompt provided', () => {
  const sm = new SessionManager();
  const sdkOpts = sm._buildSdkOptions({ prompt: 'hello', name: 'tc5' });

  // _approxSystemPromptTokens should not be set (undefined)
  assert.ok(
    sdkOpts._approxSystemPromptTokens === undefined || sdkOpts._approxSystemPromptTokens === 0,
    `Expected _approxSystemPromptTokens to be absent or 0, got ${sdkOpts._approxSystemPromptTokens}`
  );

  // Handle receives 0
  const handle = new SessionHandle('tc5');
  handle.systemPromptTokens = sdkOpts._approxSystemPromptTokens || 0;
  assert.strictEqual(handle.systemPromptTokens, 0, `Expected handle.systemPromptTokens=0, got ${handle.systemPromptTokens}`);
});

// ---------- TC6 & TC7: Pre-instrumentation backward-compat ----------
// Patch TokenTracker._load to inject a legacy session entry (missing new fields)
// and assert it loads + aggregates without error.

const originalLoad = TokenTracker.prototype._load;

test('TC6: Pre-instrumentation session entry (no new fields) loads and aggregates in TokenTracker without error', () => {
  // Patch _load for this test only
  TokenTracker.prototype._load = function () {
    this._sessions = [
      {
        name: 'legacy-session',
        type: 'executor',
        timestamp: '2025-01-01T00:00:00Z',
        inputTokens: 100,
        outputTokens: 50,
        cacheCreation: 10,
        cacheRead: 5,
        totalCostUsd: 0.01,
        // NOTE: no systemPromptTokens, no toolCallCount — simulating pre-instrumentation entry
      },
    ];
  };

  let tracker;
  let err = null;
  try {
    tracker = new TokenTracker('/fake/harness/dir');
    // getTotalUsage calls _aggregate — should not throw
    tracker.getTotalUsage();
  } catch (e) {
    err = e;
  } finally {
    TokenTracker.prototype._load = originalLoad;
  }

  assert.strictEqual(err, null, `Expected no error loading pre-instrumentation entry, got: ${err && err.message}`);
  assert.strictEqual(tracker._sessions.length, 1, `Expected 1 session loaded, got ${tracker._sessions.length}`);
});

test('TC7: Pre-instrumentation entry aggregates to 0 for systemPromptTokens and toolCallCount', () => {
  TokenTracker.prototype._load = function () {
    this._sessions = [
      {
        name: 'legacy-session-2',
        type: 'planner',
        timestamp: '2025-06-01T00:00:00Z',
        inputTokens: 200,
        outputTokens: 80,
        cacheCreation: 20,
        cacheRead: 10,
        totalCostUsd: 0.02,
        // No systemPromptTokens, no toolCallCount
      },
    ];
  };

  let agg;
  try {
    const tracker = new TokenTracker('/fake/harness/dir');
    agg = tracker.getTotalUsage();
  } finally {
    TokenTracker.prototype._load = originalLoad;
  }

  assert.strictEqual(
    agg.systemPromptTokens,
    0,
    `Expected systemPromptTokens=0 for pre-instrumentation entry, got ${agg.systemPromptTokens}`
  );
  assert.strictEqual(
    agg.toolCallCount,
    0,
    `Expected toolCallCount=0 for pre-instrumentation entry, got ${agg.toolCallCount}`
  );
});

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
