/**
 * test-run-cost-display.js — Tests for 'This run' / run-cost display in usage().
 *
 * Mocks TokenTracker._load to avoid filesystem access.
 * Verifies that calling usage() with runStartSessionCount produces both
 * a per-run block (delta cost, 2 sessions) and a cumulative block (5 sessions).
 *
 * Run: node test/test-run-cost-display.js
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

// ---------- stdout capture helper (verbatim from test-usage-detailed.js) ----------

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

// ---------- Fixtures ----------

// 3 pre-existing sessions (present before the run starts)
const PRE_RUN_SESSIONS = [
  {
    name: 'pre-1',
    type: 'planner',
    timestamp: '2026-01-01T00:00:00Z',
    inputTokens: 100,
    outputTokens: 50,
    cacheCreation: 10,
    cacheRead: 5,
    totalCostUsd: 0.01,
  },
  {
    name: 'pre-2',
    type: 'executor',
    timestamp: '2026-01-01T01:00:00Z',
    inputTokens: 200,
    outputTokens: 100,
    cacheCreation: 20,
    cacheRead: 10,
    totalCostUsd: 0.02,
  },
  {
    name: 'pre-3',
    type: 'verifier',
    timestamp: '2026-01-01T02:00:00Z',
    inputTokens: 300,
    outputTokens: 150,
    cacheCreation: 30,
    cacheRead: 15,
    totalCostUsd: 0.03,
  },
];

// 2 sessions added during the current run
const RUN_SESSIONS = [
  {
    name: 'run-1',
    type: 'executor',
    timestamp: '2026-01-01T03:00:00Z',
    inputTokens: 400,
    outputTokens: 200,
    cacheCreation: 40,
    cacheRead: 20,
    totalCostUsd: 0.04,
  },
  {
    name: 'run-2',
    type: 'verifier',
    timestamp: '2026-01-01T04:00:00Z',
    inputTokens: 500,
    outputTokens: 250,
    cacheCreation: 50,
    cacheRead: 25,
    totalCostUsd: 0.05,
  },
];

// Expected values
// run delta:  0.04 + 0.05 = 0.09
// cumulative: 0.01 + 0.02 + 0.03 + 0.04 + 0.05 = 0.15
const EXPECTED_RUN_COST = 0.09;
const EXPECTED_TOTAL_COST = 0.15;
const EXPECTED_RUN_SESSION_COUNT = 2;
const EXPECTED_TOTAL_SESSION_COUNT = 5;
const RUN_START_SESSION_COUNT = 3; // number of sessions before this run

// ---------- Mock setup ----------

const originalLoad = TokenTracker.prototype._load;

// Step 1: Patch _load to inject 3 pre-existing sessions
TokenTracker.prototype._load = function () {
  this._sessions = PRE_RUN_SESSIONS.slice();
};

// Step 2: Instantiate a tracker and push 2 more sessions onto _sessions
//         (simulating sessions added during a run)
const setupTracker = new TokenTracker('/fake/root');
setupTracker._sessions.push(...RUN_SESSIONS);

// Step 3: Update the mock so usage()'s internal tracker also sees all 5 sessions
TokenTracker.prototype._load = function () {
  this._sessions = [...PRE_RUN_SESSIONS, ...RUN_SESSIONS];
};

// ---------- Capture output once (all assertions share it) ----------

const capturedOutput = captureStdout(() =>
  usage('/fake/root', { runStartSessionCount: RUN_START_SESSION_COUNT })
);

// ---------- Tests ----------

// TC1: Output contains 'This run' / 'Run cost' block with sessionCount=2 and correct delta cost
test(
  "Output contains 'This run' block with sessionCount=2 and correct delta cost",
  () => {
    assert.ok(
      capturedOutput.includes('--- This Run ---') ||
        capturedOutput.includes('Run cost') ||
        capturedOutput.includes('This Run'),
      `Expected a 'This Run' / 'Run cost' header in output, got:\n${capturedOutput}`
    );

    // Verify session count for the run block (Sessions: 2 must appear before the cumulative block)
    const runBlockMatch =
      capturedOutput.includes(`Sessions: ${EXPECTED_RUN_SESSION_COUNT}`) ||
      capturedOutput.match(new RegExp(`Sessions:\\s*${EXPECTED_RUN_SESSION_COUNT}\\b`));
    assert.ok(
      runBlockMatch,
      `Expected 'Sessions: ${EXPECTED_RUN_SESSION_COUNT}' in run block, got:\n${capturedOutput}`
    );

    // Verify delta cost appears in the run block
    assert.ok(
      capturedOutput.includes(`$${EXPECTED_RUN_COST}`),
      `Expected run cost '$${EXPECTED_RUN_COST}' in output, got:\n${capturedOutput}`
    );
  }
);

// TC2: Output contains cumulative block with sessionCount=5 and correct total cost
test(
  'Output contains cumulative block with sessionCount=5 and correct total cost',
  () => {
    assert.ok(
      capturedOutput.includes('--- Token Usage ---'),
      `Expected '--- Token Usage ---' cumulative header in output, got:\n${capturedOutput}`
    );

    assert.ok(
      capturedOutput.includes(`Sessions: ${EXPECTED_TOTAL_SESSION_COUNT}`),
      `Expected 'Sessions: ${EXPECTED_TOTAL_SESSION_COUNT}' in cumulative block, got:\n${capturedOutput}`
    );

    assert.ok(
      capturedOutput.includes(`$${EXPECTED_TOTAL_COST}`),
      `Expected total cost '$${EXPECTED_TOTAL_COST}' in cumulative block, got:\n${capturedOutput}`
    );
  }
);

// TC3: Both blocks appear in the output (not just one)
test('Both This Run block and cumulative Token Usage block appear in output', () => {
  const hasRunBlock =
    capturedOutput.includes('--- This Run ---') ||
    capturedOutput.includes('This Run') ||
    capturedOutput.includes('Run cost');

  const hasCumulativeBlock = capturedOutput.includes('--- Token Usage ---');

  assert.ok(
    hasRunBlock,
    `Expected run block header ('--- This Run ---') in output, got:\n${capturedOutput}`
  );
  assert.ok(
    hasCumulativeBlock,
    `Expected cumulative block header ('--- Token Usage ---') in output, got:\n${capturedOutput}`
  );

  // Both must appear, verify they are distinct sections
  const runBlockIdx = capturedOutput.indexOf('--- This Run ---');
  const cumulativeIdx = capturedOutput.indexOf('--- Token Usage ---');
  assert.ok(
    runBlockIdx !== -1 && cumulativeIdx !== -1,
    `Both blocks must be present; runBlockIdx=${runBlockIdx}, cumulativeIdx=${cumulativeIdx}`
  );
  assert.ok(
    runBlockIdx < cumulativeIdx,
    `Run block should appear before cumulative block; runBlockIdx=${runBlockIdx}, cumulativeIdx=${cumulativeIdx}`
  );
});

// ---------- Restore prototype patches ----------
TokenTracker.prototype._load = originalLoad;

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
