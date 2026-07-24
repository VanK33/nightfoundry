/**
 * test-usage-intelligence.js — Tests for renderRunCostSummary and
 * renderSmallTaskCostSummary from usage.js.
 *
 * Covers:
 *   TC1 – 3-line summary format: Run cost: $X.XX • N sessions • Y.Zx cache efficiency
 *   TC2 – Warning emitted when session toolCallCount exceeds maxToolCallsPerSession
 *   TC3 – Warning names the specific session(s) that breached toolCallCount threshold
 *   TC4 – Warning emitted when role cache efficiency below minCacheEfficiency
 *   TC5 – No warnings when all sessions are within thresholds
 *   TC6 – renderSmallTaskCostSummary produces single-line output
 *
 * Run: node test/test-usage-intelligence.js
 */
import assert from 'assert';
import { TokenTracker } from '../src/orchestrator/infra/token-tracker.js';
import { renderRunCostSummary, renderSmallTaskCostSummary } from '../src/cli/commands/usage.js';

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

// ---------- Output capture helper ----------
// Captures console.log AND console.warn so warning assertions work.

function captureOutput(fn) {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);

  process.stdout.write = (chunk, ...args) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => {
    chunks.push(args.join(' ') + '\n');
  };
  console.warn = (...args) => {
    chunks.push(args.join(' ') + '\n');
  };

  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
    console.warn = origWarn;
  }

  return chunks.join('');
}

// ---------- Fixtures ----------

// Two healthy sessions: cache efficiency >= 1.5, toolCallCount <= 30
// executor: cacheCreation=100, cacheRead=200 → ratio=2.0 (healthy)
// verifier: cacheCreation=50,  cacheRead=100 → ratio=2.0 (healthy)
// Total cost: 0.05 + 0.02 = 0.07   Session count: 2
const HEALTHY_SESSIONS = [
  {
    name: 'healthy-executor',
    type: 'executor',
    timestamp: '2026-01-01T00:00:00Z',
    inputTokens: 1000,
    outputTokens: 200,
    cacheCreation: 100,
    cacheRead: 200,
    totalCostUsd: 0.05,
    toolCallCount: 10,
  },
  {
    name: 'healthy-verifier',
    type: 'verifier',
    timestamp: '2026-01-01T01:00:00Z',
    inputTokens: 500,
    outputTokens: 100,
    cacheCreation: 50,
    cacheRead: 100,
    totalCostUsd: 0.02,
    toolCallCount: 5,
  },
];

// Session that breaches the tool-call threshold (toolCallCount=50, exceeds cap of 30)
const HIGH_TOOL_SESSION = {
  name: 'heavy-executor',
  type: 'executor',
  timestamp: '2026-01-01T02:00:00Z',
  inputTokens: 2000,
  outputTokens: 500,
  cacheCreation: 200,
  cacheRead: 400,
  totalCostUsd: 0.10,
  toolCallCount: 50,
};

// Session whose per-role cache ratio is below 1.5
// planner: cacheCreation=100, cacheRead=50 → ratio=0.5 (below 1.5)
const LOW_CACHE_SESSIONS = [
  {
    name: 'cold-planner',
    type: 'planner',
    timestamp: '2026-01-01T03:00:00Z',
    inputTokens: 800,
    outputTokens: 150,
    cacheCreation: 100,
    cacheRead: 50,
    totalCostUsd: 0.03,
    toolCallCount: 2,
  },
];

// ---------- Tracker factory ----------

const originalLoad = TokenTracker.prototype._load;

function makeTracker(sessions) {
  TokenTracker.prototype._load = function () {
    this._sessions = sessions.slice();
  };
  return new TokenTracker('/fake/root');
}

// Alert options used for most tests (match config.alerts defaults)
const ALERTS = { maxToolCallsPerSession: 30, minCacheEfficiency: 1.5 };

// ============================================================
// TC1: 3-line summary matches expected format
// ============================================================
test(
  'TC1: 3-line summary format matches Run cost: $X.XX • N sessions • Y.Zx cache efficiency',
  () => {
    const tracker = makeTracker(HEALTHY_SESSIONS);
    const output = captureOutput(() =>
      renderRunCostSummary(tracker, 0, { alerts: ALERTS })
    );

    // Line 1 should match the spec format
    const lines = output.split('\n').filter((l) => l.trim() !== '');
    const line1 = lines[0];

    assert.ok(
      line1,
      `Expected at least one output line, got empty output`
    );

    // Verify individual required tokens
    assert.ok(
      output.includes('Run cost:'),
      `Expected 'Run cost:' in output, got:\n${output}`
    );
    assert.ok(
      output.includes('$0.07'),
      `Expected '$0.07' (0.05+0.02) in output, got:\n${output}`
    );
    assert.ok(
      output.includes('2 sessions'),
      `Expected '2 sessions' in output, got:\n${output}`
    );
    assert.ok(
      output.includes('cache efficiency'),
      `Expected 'cache efficiency' in output, got:\n${output}`
    );

    // Validate the full format pattern
    const formatRe = /Run cost: \$[\d.]+ • \d+ sessions • [\d.]+x cache efficiency/;
    assert.ok(
      formatRe.test(line1),
      `Expected format 'Run cost: $X.XX • N sessions • Y.Zx cache efficiency', got:\n${line1}`
    );
  }
);

// ============================================================
// TC2: Warning emitted when toolCallCount exceeds maxToolCallsPerSession
// ============================================================
test(
  'TC2: Warning emitted when session toolCallCount exceeds maxToolCallsPerSession',
  () => {
    const tracker = makeTracker([...HEALTHY_SESSIONS, HIGH_TOOL_SESSION]);
    const output = captureOutput(() =>
      renderRunCostSummary(tracker, 0, { alerts: ALERTS })
    );

    assert.ok(
      output.includes('Tool call limit exceeded'),
      `Expected 'Tool call limit exceeded' warning in output, got:\n${output}`
    );
  }
);

// ============================================================
// TC3: Warning names the specific session(s) that breached toolCallCount
// ============================================================
test(
  'TC3: Warning names the specific session(s) that breached toolCallCount threshold',
  () => {
    const tracker = makeTracker([...HEALTHY_SESSIONS, HIGH_TOOL_SESSION]);
    const output = captureOutput(() =>
      renderRunCostSummary(tracker, 0, { alerts: ALERTS })
    );

    assert.ok(
      output.includes('heavy-executor'),
      `Expected session name 'heavy-executor' in tool-call warning, got:\n${output}`
    );
  }
);

// ============================================================
// TC4: Warning emitted when role cache efficiency below minCacheEfficiency
// ============================================================
test(
  'TC4: Warning emitted when role cache efficiency below minCacheEfficiency',
  () => {
    const tracker = makeTracker(LOW_CACHE_SESSIONS);
    const output = captureOutput(() =>
      renderRunCostSummary(tracker, 0, { alerts: ALERTS })
    );

    assert.ok(
      output.includes('Cache efficiency below threshold'),
      `Expected 'Cache efficiency below threshold' warning in output, got:\n${output}`
    );
    assert.ok(
      output.includes('planner'),
      `Expected role 'planner' named in cache efficiency warning, got:\n${output}`
    );
  }
);

// ============================================================
// TC5: No warnings when all sessions are within thresholds
// ============================================================
test(
  'TC5: No warnings emitted when all sessions are within thresholds',
  () => {
    const tracker = makeTracker(HEALTHY_SESSIONS);
    const output = captureOutput(() =>
      renderRunCostSummary(tracker, 0, { alerts: ALERTS })
    );

    assert.ok(
      !output.includes('⚠'),
      `Expected no ⚠ warning symbol in output, got:\n${output}`
    );
    assert.ok(
      !output.includes('Tool call limit exceeded'),
      `Expected no tool-call warning in output, got:\n${output}`
    );
    assert.ok(
      !output.includes('Cache efficiency below threshold'),
      `Expected no cache-efficiency warning in output, got:\n${output}`
    );
  }
);

// ============================================================
// TC6: renderSmallTaskCostSummary produces single-line output
// ============================================================
test(
  'TC6: renderSmallTaskCostSummary produces single-line output',
  () => {
    const tracker = makeTracker(HEALTHY_SESSIONS);
    const output = captureOutput(() =>
      renderSmallTaskCostSummary(tracker, 0)
    );

    const lines = output.split('\n').filter((l) => l.trim() !== '');
    assert.strictEqual(
      lines.length,
      1,
      `Expected exactly 1 output line, got ${lines.length}:\n${output}`
    );

    // Format: [$X.XX | N sessions | Y.Zx cache]
    const formatRe = /\[\$[\d.]+ \| \d+ sessions \| [\d.]+x cache\]/;
    assert.ok(
      formatRe.test(lines[0]),
      `Expected format '[$X.XX | N sessions | Y.Zx cache]', got:\n${lines[0]}`
    );
  }
);

// ---------- Restore prototype ----------
TokenTracker.prototype._load = originalLoad;

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
