/**
 * test-usage-json.js — Unit tests for src/cli/commands/usage.js
 *
 * Mocks TokenTracker to avoid filesystem access.
 * Run: node test/test-usage-json.js
 */
import assert from 'assert';
import { TokenTracker } from '../src/orchestrator/infra/token-tracker.js';
import { usage } from '../src/cli/commands/usage.js';

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

// ---------- Mock setup ----------
//
// Previously this file mocked `TokenTracker.prototype.summary()` directly.
// That masked a real bug: the legacy JSON path early-returned through
// summary() without applying --role/--task filters, and used summary()'s
// hard-coded planner/executor/verifier byType shape which diverged from
// the text path's dynamic aggregateByRole view. Both issues were fixed
// in usage.js, which now builds the legacy JSON shape from a filtered
// session list using aggregateByRole — so this mock now populates
// `_sessions` with fixture entries and lets the real aggregation run.

const FIXTURE_SESSIONS = [
  { name: 'plan-1', type: 'planner', timestamp: '2026-01-01T01:00:00Z', inputTokens: 400, outputTokens: 200, cacheCreation: 80, cacheRead: 40, totalCostUsd: 0.015 },
  { name: 'exec-1', type: 'executor', timestamp: '2026-01-01T02:00:00Z', inputTokens: 400, outputTokens: 200, cacheCreation: 80, cacheRead: 40, totalCostUsd: 0.015 },
  { name: 'verify-1', type: 'verifier', timestamp: '2026-01-01T03:00:00Z', inputTokens: 200, outputTokens: 100, cacheCreation: 40, cacheRead: 20, totalCostUsd: 0.012 },
];

// Patch prototype before any usage() calls
const originalLoad = TokenTracker.prototype._load;
const originalSummary = TokenTracker.prototype.summary;

TokenTracker.prototype._load = function () {
  this._sessions = FIXTURE_SESSIONS.slice();
};

// ---------- stdout capture helper ----------

function captureStdout(fn) {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log.bind(console);

  process.stdout.write = (chunk, ...args) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => {
    chunks.push(args.join(' ') + '\n');
  };

  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }

  return chunks.join('');
}

// ---------- Tests ----------

// TC-HR1: usage(root) output includes '--- Token Usage ---' header
test('TC-HR1: usage(root) output includes "--- Token Usage ---" header', () => {
  const out = captureStdout(() => usage('/fake/root'));
  assert.ok(out.includes('--- Token Usage ---'), `Expected "--- Token Usage ---" in output, got:\n${out}`);
});

// TC-HR2: usage(root) output includes 'Sessions:' line
test('TC-HR2: usage(root) output includes "Sessions:" line', () => {
  const out = captureStdout(() => usage('/fake/root'));
  assert.ok(out.includes('Sessions:'), `Expected "Sessions:" in output, got:\n${out}`);
});

// TC-HR3: usage(root) output includes 'Input tokens:', 'Output tokens:', 'Total cost:' lines
test('TC-HR3: usage(root) output includes "Input tokens:", "Output tokens:", "Total cost:" lines', () => {
  const out = captureStdout(() => usage('/fake/root'));
  assert.ok(out.includes('Input tokens:'), `Expected "Input tokens:" in output`);
  assert.ok(out.includes('Output tokens:'), `Expected "Output tokens:" in output`);
  assert.ok(out.includes('Total cost:'), `Expected "Total cost:" in output`);
});

// TC-HR4: usage(root) output is NOT valid JSON
test('TC-HR4: usage(root) output is NOT valid JSON', () => {
  const out = captureStdout(() => usage('/fake/root'));
  let parsed = true;
  try { JSON.parse(out); } catch { parsed = false; }
  assert.ok(!parsed, `Expected output to NOT be valid JSON, but it parsed successfully`);
});

// TC-HR5: usage(root, {json:false}) produces identical output to usage(root)
test('TC-HR5: usage(root, {json:false}) produces identical output to usage(root)', () => {
  const out1 = captureStdout(() => usage('/fake/root'));
  const out2 = captureStdout(() => usage('/fake/root', { json: false }));
  assert.strictEqual(out1, out2, `Expected identical output for usage(root) and usage(root, {json:false})`);
});

// TC-JSON1: usage(root, {json:true}) writes valid JSON to stdout
test('TC-JSON1: usage(root, {json:true}) writes valid JSON to stdout', () => {
  const out = captureStdout(() => usage('/fake/root', { json: true }));
  let parsed;
  try { parsed = JSON.parse(out); } catch (e) { throw new Error(`Expected valid JSON, got parse error: ${e.message}\nOutput: ${out}`); }
  assert.ok(parsed !== null && typeof parsed === 'object', 'Expected parsed JSON to be an object');
});

// TC-JSON2: Parsed JSON has all required top-level fields
test('TC-JSON2: Parsed JSON has required top-level fields: totalSessions, inputTokens, outputTokens, cacheCreation, cacheRead, totalCostUsd, byType', () => {
  const out = captureStdout(() => usage('/fake/root', { json: true }));
  const parsed = JSON.parse(out);
  const required = ['totalSessions', 'inputTokens', 'outputTokens', 'cacheCreation', 'cacheRead', 'totalCostUsd', 'byType'];
  for (const field of required) {
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, field), `Expected field "${field}" in JSON output`);
  }
});

// TC-JSON3: byType contains planner, executor, verifier keys
test('TC-JSON3: byType contains planner, executor, verifier keys', () => {
  const out = captureStdout(() => usage('/fake/root', { json: true }));
  const parsed = JSON.parse(out);
  assert.ok(parsed.byType && typeof parsed.byType === 'object', 'Expected byType to be an object');
  assert.ok(Object.prototype.hasOwnProperty.call(parsed.byType, 'planner'), 'Expected byType.planner');
  assert.ok(Object.prototype.hasOwnProperty.call(parsed.byType, 'executor'), 'Expected byType.executor');
  assert.ok(Object.prototype.hasOwnProperty.call(parsed.byType, 'verifier'), 'Expected byType.verifier');
});

// TC-JSON4: JSON output does NOT include human-readable header '--- Token Usage ---'
test('TC-JSON4: JSON output does NOT include human-readable header "--- Token Usage ---"', () => {
  const out = captureStdout(() => usage('/fake/root', { json: true }));
  assert.ok(!out.includes('--- Token Usage ---'), `Expected JSON output to NOT include "--- Token Usage ---", got:\n${out}`);
});

// TC-FILTER1: --role filter applies in legacy JSON mode (regression for Copilot finding)
test('TC-FILTER1: json && !detailed honors --role filter', () => {
  const out = captureStdout(() => usage('/fake/root', { json: true, role: 'planner' }));
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.totalSessions, 1, 'Expected only planner sessions to pass the filter');
  assert.ok(parsed.byType.planner, 'Expected byType.planner to exist');
  assert.ok(!parsed.byType.executor, 'Expected byType.executor to be absent under role=planner filter');
  assert.strictEqual(parsed.byType.planner.sessionCount, 1);
});

// TC-FILTER2: --task filter applies in legacy JSON mode
test('TC-FILTER2: json && !detailed honors --task filter', () => {
  const out = captureStdout(() => usage('/fake/root', { json: true, task: 'nonexistent-task' }));
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.totalSessions, 0, 'Expected zero sessions for unmatched task filter');
  assert.deepStrictEqual(parsed.byType, {}, 'Expected empty byType when no sessions match');
});

// TC-CONSISTENT1: legacy JSON byType matches text-path aggregateByRole (roles align across modes)
test('TC-CONSISTENT1: legacy JSON byType reflects all present roles (not hard-coded)', () => {
  const out = captureStdout(() => usage('/fake/root', { json: true }));
  const parsed = JSON.parse(out);
  const roles = Object.keys(parsed.byType).sort();
  assert.deepStrictEqual(roles, ['executor', 'planner', 'verifier'], `Expected byType to list exactly the present roles, got ${roles}`);
});

// ---------- Restore mocks ----------
TokenTracker.prototype._load = originalLoad;
TokenTracker.prototype.summary = originalSummary;

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
