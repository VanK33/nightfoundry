/**
 * test-usage-all.js — Backwards-compatibility snapshot tests for legacy usage() paths
 * and the compare() function in src/cli/commands/usage.js.
 * Also covers TC_ALL1–TC_ALL6: --all cross-archive happy-path, filter-narrowing,
 * and schema-drift scenarios consuming test/fixtures/archives-mock/.
 *
 * Mocks TokenTracker to avoid filesystem access (for legacy TCs).
 * Run: node test/test-usage-all.js
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TokenTracker } from '../src/orchestrator/infra/token-tracker.js';
import {
  aggregateByRole,
} from '../src/orchestrator/infra/usage-analyzer.js';
import { usage, compare, usageAll } from '../src/cli/commands/usage.js';

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

// ---------- stdout + stderr capture helper (for schema-drift TC) ----------

function captureOutput(fn) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log.bind(console);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origWarn = console.warn.bind(console);

  process.stdout.write = (chunk, ...args) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => {
    stdoutChunks.push(args.join(' ') + '\n');
  };
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.warn = (...args) => {
    stderrChunks.push(args.join(' ') + '\n');
  };

  try {
    fn();
  } finally {
    process.stdout.write = origStdoutWrite;
    console.log = origLog;
    process.stderr.write = origStderrWrite;
    console.warn = origWarn;
  }

  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

// ---------- Deterministic mixed-role fixture (12 sessions) ----------

const FIXTURE_SESSIONS = [
  // planners (5)
  { name: 'plan-1', type: 'planner', timestamp: '2026-01-01T00:00:00Z', inputTokens: 100, outputTokens: 50,  cacheCreation: 10, cacheRead: 5,  totalCostUsd: 0.01,  taskId: 'task-001', durationMs: 1000 },
  { name: 'plan-2', type: 'planner', timestamp: '2026-01-01T01:00:00Z', inputTokens: 200, outputTokens: 80,  cacheCreation: 20, cacheRead: 10, totalCostUsd: 0.02,  durationMs: 2000 },
  { name: 'plan-3', type: 'planner', timestamp: '2026-01-01T02:00:00Z', inputTokens: 150, outputTokens: 60,  cacheCreation: 15, cacheRead: 8,  totalCostUsd: 0.015, durationMs: 1500 },
  { name: 'plan-4', type: 'planner', timestamp: '2026-01-01T03:00:00Z', inputTokens: 300, outputTokens: 100, cacheCreation: 30, cacheRead: 15, totalCostUsd: 0.03,  durationMs: 3000 },
  { name: 'plan-5', type: 'planner', timestamp: '2026-01-01T04:00:00Z', inputTokens: 250, outputTokens: 90,  cacheCreation: 25, cacheRead: 12, totalCostUsd: 0.025, durationMs: 2500 },
  // executors (4)
  { name: 'exec-1', type: 'executor', timestamp: '2026-01-01T05:00:00Z', inputTokens: 400, outputTokens: 200, cacheCreation: 40, cacheRead: 20, totalCostUsd: 0.04  },
  { name: 'exec-2', type: 'executor', timestamp: '2026-01-01T06:00:00Z', inputTokens: 500, outputTokens: 250, cacheCreation: 50, cacheRead: 25, totalCostUsd: 0.05  },
  { name: 'exec-3', type: 'executor', timestamp: '2026-01-01T07:00:00Z', inputTokens: 600, outputTokens: 300, cacheCreation: 60, cacheRead: 30, totalCostUsd: 0.06  },
  { name: 'exec-4', type: 'executor', timestamp: '2026-01-01T08:00:00Z', inputTokens: 350, outputTokens: 150, cacheCreation: 35, cacheRead: 18, totalCostUsd: 0.035, taskId: 'task-002' },
  // verifiers (3)
  { name: 'verify-1', type: 'verifier', timestamp: '2026-01-01T09:00:00Z',  inputTokens: 180, outputTokens: 90,  cacheCreation: 18, cacheRead: 9,  totalCostUsd: 0.018 },
  { name: 'verify-2', type: 'verifier', timestamp: '2026-01-01T10:00:00Z', inputTokens: 220, outputTokens: 110, cacheCreation: 22, cacheRead: 11, totalCostUsd: 0.022 },
  { name: 'verify-3', type: 'verifier', timestamp: '2026-01-01T11:00:00Z', inputTokens: 280, outputTokens: 140, cacheCreation: 28, cacheRead: 14, totalCostUsd: 0.028 },
];

// ---------- Mock setup ----------

const originalLoad = TokenTracker.prototype._load;
const originalSummary = TokenTracker.prototype.summary;

TokenTracker.prototype._load = function () {
  this._sessions = FIXTURE_SESSIONS.slice();
};

TokenTracker.prototype.summary = function () {
  const totals = this._aggregate(this._sessions);
  return {
    totalSessions: this._sessions.length,
    sessionCount: this._sessions.length,
    ...totals,
    byType: aggregateByRole(this._sessions),
  };
};

// ---------- TC_BC1: legacy text path ----------

test('TC_BC1 legacy text path emits "--- Token Usage ---" and lacks detailed sections', () => {
  const out = captureStdout(() => usage('/fake', {}));
  assert.ok(out.includes('--- Token Usage ---'), `Expected "--- Token Usage ---" in output, got:\n${out}`);
  assert.ok(!out.includes('--- By Role ---'), `Back-compat text must NOT include "--- By Role ---"`);
  assert.ok(!out.includes('--- Top Sessions'), `Back-compat text must NOT include "--- Top Sessions"`);
  assert.ok(!out.includes('archives'), `Back-compat text must NOT contain "archives"`);
});

// ---------- TC_BC2: legacy JSON mode ----------

test('TC_BC2 legacy JSON has totalSessions/byType/cacheEfficiency, no archives/aggregate keys', () => {
  const out = captureStdout(() => usage('/fake', { json: true }));
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON, got parse error: ${e.message}\nOutput: ${out}`);
  }
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'totalSessions'), 'Expected "totalSessions" key');
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'byType'), 'Expected "byType" key');
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'cacheEfficiency'), 'Expected "cacheEfficiency" key');
  assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'archives'), 'Must NOT have "archives" key');
  assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'aggregate'), 'Must NOT have "aggregate" key');
});

// ---------- TC_BC3: detailed JSON mode ----------

test('TC_BC3 detailed JSON has summary/byRole/topSessions/cacheEfficiency', () => {
  const out = captureStdout(() => usage('/fake', { detailed: true, json: true }));
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON, got parse error: ${e.message}\nOutput: ${out}`);
  }
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'summary'), 'Expected "summary" key');
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'byRole'), 'Expected "byRole" key');
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'topSessions'), 'Expected "topSessions" key');
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'cacheEfficiency'), 'Expected "cacheEfficiency" key');
});

// ---------- TC_BC4: compare() with staged tmpdir archives ----------

test('TC_BC4 compare(A,B) prints "--- Usage Compare ---", Sessions row, and Total cost row', () => {
  // Stage two minimal token-usage.json files in a tmpdir
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-test-'));

  const sessionsA = [
    { name: 's1', type: 'planner', inputTokens: 100, outputTokens: 50, cacheCreation: 10, cacheRead: 5, totalCostUsd: 0.01 },
  ];
  const sessionsB = [
    { name: 's2', type: 'executor', inputTokens: 200, outputTokens: 100, cacheCreation: 20, cacheRead: 10, totalCostUsd: 0.02 },
    { name: 's3', type: 'executor', inputTokens: 300, outputTokens: 150, cacheCreation: 30, cacheRead: 15, totalCostUsd: 0.03 },
  ];

  // Create archive directory structure: <tmp>/archives/<id>/logs/token-usage.json
  for (const [id, sessions] of [['A', sessionsA], ['B', sessionsB]]) {
    const logsDir = path.join(tmpRoot, 'archives', id, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const usageData = {
      sessions,
      totals: {
        sessionCount: sessions.length,
        inputTokens: sessions.reduce((s, e) => s + e.inputTokens, 0),
        outputTokens: sessions.reduce((s, e) => s + e.outputTokens, 0),
        cacheCreation: sessions.reduce((s, e) => s + e.cacheCreation, 0),
        cacheRead: sessions.reduce((s, e) => s + e.cacheRead, 0),
        totalCostUsd: sessions.reduce((s, e) => s + e.totalCostUsd, 0),
      },
    };
    fs.writeFileSync(path.join(logsDir, 'token-usage.json'), JSON.stringify(usageData, null, 2));
  }

  const out = captureStdout(() => compare(tmpRoot, 'A', 'B', {}));

  // Clean up tmpdir
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  assert.ok(out.includes('--- Usage Compare ---'), `Expected "--- Usage Compare ---" in output, got:\n${out}`);
  assert.ok(out.includes('Sessions'), `Expected "Sessions" row in output, got:\n${out}`);
  assert.ok(out.includes('Total cost'), `Expected "Total cost" row in output, got:\n${out}`);
});

// ---------- Restore prototype patches ----------
TokenTracker.prototype._load = originalLoad;
TokenTracker.prototype.summary = originalSummary;

// ==========================================================================
// TC_ALL1–TC_ALL6: Cross-archive --all mode tests
// ==========================================================================

// Path to the static fixture archives
const FIXTURE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'archives-mock');

// Map fixture archive IDs to their representative dates (for directory renaming)
// The date prefix allows enumerateArchives to extract a date string for --since filtering
const FIXTURE_ARCHIVE_DATES = {
  '001-alpha': '2026-01-01',
  '002-beta':  '2026-02-01',
  '003-gamma': '2026-03-01',
  '004-delta': '2026-04-01',
};

/**
 * Build a tmpdir, copy the four fixture archive dirs into <tmp>/archives/
 * with date-prefixed names (e.g. 2026-01-01-001-alpha) so that
 * enumerateArchives can extract a date string for --since filtering.
 *
 * Optionally adds extra archive directories with custom contents:
 *   { id: '005-missing', noSummary: true }       → dir exists, no session-summary.json
 *   { id: '006-broken', summary: '{not valid' }   → dir exists, malformed session-summary.json
 *
 * Returns the tmp root path.
 *
 * @param {Array<{ id: string, noSummary?: boolean, summary?: string }>} extraDirs
 * @returns {string}
 */
function cloneFixtureToTmp(extraDirs = []) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-all-'));

  for (const [id, date] of Object.entries(FIXTURE_ARCHIVE_DATES)) {
    const srcLogsDir = path.join(FIXTURE_DIR, id, 'logs');
    // Rename to include date prefix so enumerateArchives extracts the date
    const destName = `${date}-${id}`;
    const destLogsDir = path.join(tmpRoot, 'archives', destName, 'logs');
    fs.mkdirSync(destLogsDir, { recursive: true });
    fs.copyFileSync(
      path.join(srcLogsDir, 'session-summary.json'),
      path.join(destLogsDir, 'session-summary.json')
    );
  }

  for (const extra of extraDirs) {
    const destLogsDir = path.join(tmpRoot, 'archives', extra.id, 'logs');
    fs.mkdirSync(destLogsDir, { recursive: true });
    if (!extra.noSummary && extra.summary !== undefined) {
      fs.writeFileSync(path.join(destLogsDir, 'session-summary.json'), extra.summary);
    }
    // If noSummary: true, the logs dir exists but no session-summary.json is written
  }

  return tmpRoot;
}

// ---------- TC_ALL1: text mode table ----------

test('TC_ALL1 --all text emits table header + 4 rows + Aggregate block with Archives:4', () => {
  const tmpRoot = cloneFixtureToTmp();
  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { all: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // Header line must contain all required columns
  const lines = out.split('\n');
  const headerLine = lines.find((l) => l.includes('Archive'));
  assert.ok(headerLine, `Expected a header line containing 'Archive', got:\n${out}`);
  assert.ok(headerLine.includes('Date'),         `Header must contain 'Date': ${headerLine}`);
  assert.ok(headerLine.includes('Sessions'),     `Header must contain 'Sessions': ${headerLine}`);
  assert.ok(headerLine.includes('Total Cost'),   `Header must contain 'Total Cost': ${headerLine}`);
  assert.ok(headerLine.includes('Cache'),        `Header must contain 'Cache': ${headerLine}`);
  assert.ok(headerLine.includes('Top-3 Roles'),  `Header must contain 'Top-3 Roles': ${headerLine}`);

  // Count archive data rows: lines containing ' | 2026-' (date column)
  const archiveRows = lines.filter((l) => l.includes('| 2026-'));
  assert.strictEqual(archiveRows.length, 4, `Expected exactly 4 archive rows, got ${archiveRows.length}:\n${out}`);

  // Aggregate block
  assert.ok(out.includes('--- Aggregate ---'), `Expected '--- Aggregate ---' block:\n${out}`);
  assert.ok(out.includes('Archives: 4'), `Expected 'Archives: 4' in aggregate block:\n${out}`);
});

// ---------- TC_ALL2: --all --json top-level shape + totalSessions ----------

test('TC_ALL2 --all --json yields {archives,aggregate} with correct totalSessions', () => {
  const tmpRoot = cloneFixtureToTmp();

  // Compute expected totalSessions from on-disk fixtures (not hardcoded)
  let expectedTotalSessions = 0;
  for (const id of Object.keys(FIXTURE_ARCHIVE_DATES)) {
    const summaryPath = path.join(FIXTURE_DIR, id, 'logs', 'session-summary.json');
    const sessions = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    expectedTotalSessions += sessions.length;
  }

  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { all: true, json: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  let result;
  try {
    result = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON output, got parse error: ${e.message}\nOutput: ${out}`);
  }

  // Top-level keys must be exactly ['archives', 'aggregate']
  const keys = Object.keys(result).sort();
  assert.deepStrictEqual(keys, ['aggregate', 'archives'], `Expected top-level keys ['archives','aggregate'], got: ${JSON.stringify(keys)}`);

  // Must have 4 archives
  assert.strictEqual(result.archives.length, 4, `Expected 4 archives, got ${result.archives.length}`);

  // totalSessions must match sum of all fixture sessions
  assert.strictEqual(
    result.aggregate.totalSessions,
    expectedTotalSessions,
    `Expected totalSessions=${expectedTotalSessions}, got ${result.aggregate.totalSessions}`
  );
});

// ---------- TC_ALL3: --all --last 2 keeps two most recent archives ----------

test('TC_ALL3 --all --last 2 keeps 003-gamma and 004-delta (last by sort)', () => {
  const tmpRoot = cloneFixtureToTmp();
  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { all: true, last: 2, json: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  let result;
  try {
    result = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON output, got parse error: ${e.message}\nOutput: ${out}`);
  }

  assert.strictEqual(result.archives.length, 2, `Expected 2 archives with --last 2, got ${result.archives.length}`);

  const ids = result.archives.map((a) => a.id);
  assert.ok(
    ids.some((id) => id.includes('003-gamma')),
    `Expected one archive to include '003-gamma', got ids: ${JSON.stringify(ids)}`
  );
  assert.ok(
    ids.some((id) => id.includes('004-delta')),
    `Expected one archive to include '004-delta', got ids: ${JSON.stringify(ids)}`
  );
});

// ---------- TC_ALL4: --all --since 2026-02-15 excludes earlier archives ----------

test('TC_ALL4 --all --since 2026-02-15 yields 2 archives, none dated before since', () => {
  const tmpRoot = cloneFixtureToTmp();
  const since = '2026-02-15';
  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { all: true, since, json: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  let result;
  try {
    result = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON output, got parse error: ${e.message}\nOutput: ${out}`);
  }

  assert.strictEqual(result.archives.length, 2, `Expected 2 archives after --since ${since}, got ${result.archives.length}`);

  // No returned archive's date should be before since
  for (const arch of result.archives) {
    assert.ok(
      arch.date == null || arch.date >= since,
      `Archive '${arch.id}' has date '${arch.date}' which is before since='${since}'`
    );
  }
});

// ---------- TC_ALL5: --all --last 1 --since 2026-02-15 yields a single archive ----------

test('TC_ALL5 --all --last 1 --since 2026-02-15 yields exactly 1 archive', () => {
  const tmpRoot = cloneFixtureToTmp();
  const since = '2026-02-15';
  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { all: true, last: 1, since, json: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  let result;
  try {
    result = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON output, got parse error: ${e.message}\nOutput: ${out}`);
  }

  assert.strictEqual(result.archives.length, 1, `Expected 1 archive after --since ${since} --last 1, got ${result.archives.length}`);
});

// ---------- TC_ALL6: schema-drift — missing + malformed session-summary.json ----------

test('TC_ALL6 missing+malformed session-summary.json: stderr warns, exit 0, 4 valid archives returned', () => {
  const tmpRoot = cloneFixtureToTmp([
    { id: '005-missing', noSummary: true },
    { id: '006-broken', summary: '{not valid json' },
  ]);

  let captured;
  try {
    captured = captureOutput(() => usageAll(tmpRoot, { all: true, json: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const { stdout: out, stderr } = captured;

  // stderr must contain a warning for each bad archive
  assert.ok(
    stderr.includes('005-missing'),
    `Expected stderr warning for '005-missing', got stderr:\n${stderr}`
  );
  assert.ok(
    stderr.includes('006-broken'),
    `Expected stderr warning for '006-broken', got stderr:\n${stderr}`
  );

  // JSON output must be parseable (process exits 0 — no exception thrown)
  let result;
  try {
    result = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON output after schema-drift, got parse error: ${e.message}\nOutput: ${out}`);
  }

  // Only the 4 valid archives should appear; the 2 bad ones must be skipped entirely
  assert.strictEqual(
    result.archives.length,
    4,
    `Expected 4 valid archives (bad ones skipped), got ${result.archives.length}: ${JSON.stringify(result.archives.map((a) => a.id))}`
  );
});

// ==========================================================================
// TC1–TC7: Concrete tmpdir-based tests (buildTempProject mirror style)
// ==========================================================================

/**
 * Build a fresh tmpdir with three archives:
 *   2026-01-01-archive-a          (planner + executor, cacheCreation > 0)
 *   2026-02-01-archive-b          (executor only, cacheCreation = 0 → n/a cache)
 *   2026-03-01-this-archive-has-a-very-long-identifier  (executor, cacheCreation > 0)
 *
 * Returns the tmp root path.
 */
function buildTmpFixture() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-tc-'));

  const archives = [
    {
      id: '2026-01-01-archive-a',
      sessions: [
        {
          name: 'planner-1', role: 'planner',
          inputTokens: 100, outputTokens: 50,
          cacheCreation: 100, cacheRead: 200,
          totalCost: 0.01, durationMs: 1000,
          startedAt: '2026-01-01T10:00:00.000Z',
          finishedAt: '2026-01-01T10:00:01.000Z',
        },
        {
          name: 'executor-1', role: 'executor',
          inputTokens: 200, outputTokens: 100,
          cacheCreation: 200, cacheRead: 400,
          totalCost: 0.02, durationMs: 2000,
          startedAt: '2026-01-01T10:01:00.000Z',
          finishedAt: '2026-01-01T10:01:02.000Z',
        },
      ],
    },
    {
      id: '2026-02-01-archive-b',
      sessions: [
        {
          name: 'executor-2', role: 'executor',
          inputTokens: 300, outputTokens: 150,
          cacheCreation: 0, cacheRead: 0,
          totalCost: 0.03, durationMs: 3000,
          startedAt: '2026-02-01T10:00:00.000Z',
          finishedAt: '2026-02-01T10:00:03.000Z',
        },
      ],
    },
    {
      id: '2026-03-01-this-archive-has-a-very-long-identifier',
      sessions: [
        {
          name: 'executor-3', role: 'executor',
          inputTokens: 400, outputTokens: 200,
          cacheCreation: 300, cacheRead: 600,
          totalCost: 0.04, durationMs: 4000,
          startedAt: '2026-03-01T10:00:00.000Z',
          finishedAt: '2026-03-01T10:00:04.000Z',
        },
      ],
    },
  ];

  for (const arch of archives) {
    const logsDir = path.join(tmpRoot, 'archives', arch.id, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, 'session-summary.json'),
      JSON.stringify(arch.sessions, null, 2)
    );
  }

  return tmpRoot;
}

// ---------- TC1: text mode table header ----------

test('TC1 usageAll text mode prints table header with Archive/Date/Sessions/Total Cost/Cache/Top-3 Roles + one row per archive', () => {
  const tmpRoot = buildTmpFixture();
  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { all: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const lines = out.split('\n');
  const headerLine = lines.find((l) => l.includes('Archive'));
  assert.ok(headerLine, `Expected a header line containing 'Archive', got:\n${out}`);
  assert.ok(headerLine.includes('Date'),        `Header must contain 'Date': ${headerLine}`);
  assert.ok(headerLine.includes('Sessions'),    `Header must contain 'Sessions': ${headerLine}`);
  assert.ok(headerLine.includes('Total Cost'),  `Header must contain 'Total Cost': ${headerLine}`);
  assert.ok(headerLine.includes('Cache'),       `Header must contain 'Cache': ${headerLine}`);
  assert.ok(headerLine.includes('Top-3 Roles'), `Header must contain 'Top-3 Roles': ${headerLine}`);

  // One row per archive — the fixture has 3 archives with dates 2026-01-01, 2026-02-01, 2026-03-01
  const archiveRows = lines.filter((l) => l.includes('| 2026-'));
  assert.strictEqual(archiveRows.length, 3, `Expected 3 archive rows (one per fixture archive), got ${archiveRows.length}:\n${out}`);
});

// ---------- TC2: JSON mode shape + totalSessions ----------

test('TC2 usageAll --json emits {archives,aggregate} with correct totalSessions', () => {
  const tmpRoot = buildTmpFixture();
  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { all: true, json: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  let result;
  try {
    result = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON output, got parse error: ${e.message}\nOutput: ${out}`);
  }

  const keys = Object.keys(result).sort();
  assert.deepStrictEqual(
    keys,
    ['aggregate', 'archives'],
    `Expected top-level keys ['archives','aggregate'], got: ${JSON.stringify(keys)}`
  );

  // 3 archives, each with their sessions: 2+1+1 = 4 total
  assert.strictEqual(result.archives.length, 3, `Expected 3 archives, got ${result.archives.length}`);
  assert.strictEqual(
    result.aggregate.totalSessions,
    4,
    `Expected totalSessions=4 (2+1+1), got ${result.aggregate.totalSessions}`
  );
});

// ---------- TC3: --last 1 yields single archive ----------

test('TC3 usageAll --last 1 yields a single archive in result', () => {
  const tmpRoot = buildTmpFixture();
  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { all: true, last: 1, json: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  let result;
  try {
    result = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON output, got parse error: ${e.message}\nOutput: ${out}`);
  }

  assert.strictEqual(result.archives.length, 1, `Expected exactly 1 archive with --last 1, got ${result.archives.length}`);
});

// ---------- TC4: --since 2026-01-02 excludes archives dated before boundary ----------

test('TC4 usageAll --since 2026-01-02 excludes archives dated before that boundary', () => {
  const tmpRoot = buildTmpFixture();
  const since = '2026-01-02';
  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { all: true, since, json: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  let result;
  try {
    result = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON output, got parse error: ${e.message}\nOutput: ${out}`);
  }

  // archive-a is dated 2026-01-01, which is before 2026-01-02 — must be excluded
  assert.strictEqual(result.archives.length, 2, `Expected 2 archives after --since ${since}, got ${result.archives.length}`);
  for (const arch of result.archives) {
    assert.ok(
      arch.date == null || arch.date >= since,
      `Archive '${arch.id}' has date '${arch.date}' which is before since='${since}'`
    );
  }
});

// ---------- TC5: --role executor restricts aggregate.byRole to only 'executor' ----------

test("TC5 usageAll --role executor narrows aggregate.byRole keys to only 'executor'", () => {
  const tmpRoot = buildTmpFixture();
  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { all: true, role: 'executor', json: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  let result;
  try {
    result = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON output, got parse error: ${e.message}\nOutput: ${out}`);
  }

  const byRoleKeys = Object.keys(result.aggregate.byRole);
  assert.deepStrictEqual(
    byRoleKeys,
    ['executor'],
    `Expected aggregate.byRole to only have 'executor', got: ${JSON.stringify(byRoleKeys)}`
  );
});

// ---------- TC6: long archive id rendered with '…' truncation ----------

test("TC6 archive id longer than 20 chars is rendered with '…' truncation in text mode", () => {
  const tmpRoot = buildTmpFixture();
  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { all: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // The fixture archive '2026-03-01-this-archive-has-a-very-long-identifier' is >20 chars
  assert.ok(
    out.includes('…'),
    `Expected '…' in output for long archive id, got:\n${out}`
  );

  // The truncated label must not exceed MAX_ID (20) chars before the '…'
  const lines = out.split('\n');
  const longRow = lines.find((l) => l.includes('…'));
  assert.ok(longRow, `Expected a row containing '…', got:\n${out}`);
  const label = longRow.split('|')[0].trimEnd();
  assert.ok(label.length <= 21, `Truncated label must be ≤21 chars (20 + '…'), got length ${label.length}: '${label}'`);
});

// ---------- TC7: 'n/a' rendered when overallCacheRatio is null ----------

test("TC7 cache column is 'n/a' when overallCacheRatio is null (cacheCreation=0)", () => {
  const tmpRoot = buildTmpFixture();
  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { all: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // archive-b has cacheCreation=0 → overallCacheRatio=null → cache column is 'n/a'
  // That archive has date 2026-02-01; find its row and verify 'n/a'
  const lines = out.split('\n');
  const archiveBRow = lines.find((l) => l.includes('2026-02-01'));
  assert.ok(archiveBRow, `Expected a row for archive dated 2026-02-01, got:\n${out}`);
  assert.ok(
    archiveBRow.includes('n/a'),
    `Expected 'n/a' in cache column for archive with cacheCreation=0, got row:\n${archiveBRow}`
  );
});

// ==========================================================================
// TC_FAIL1–TC_FAIL3: --include-failed flag tests
// ==========================================================================

/**
 * Build a fresh tmpdir using buildTmpFixture() and add an extra
 * 'failed-2026-04-01-bad-run' archive with one session.
 * Returns the tmp root path.
 */
function buildTmpFixtureWithFailed() {
  const tmpRoot = buildTmpFixture();
  const failedLogsDir = path.join(tmpRoot, 'archives', 'failed-2026-04-01-bad-run', 'logs');
  fs.mkdirSync(failedLogsDir, { recursive: true });
  fs.writeFileSync(
    path.join(failedLogsDir, 'session-summary.json'),
    JSON.stringify([
      {
        name: 'planner-failed', role: 'planner',
        inputTokens: 50, outputTokens: 25,
        cacheCreation: 0, cacheRead: 0,
        totalCost: 0.005, durationMs: 500,
        startedAt: '2026-04-01T10:00:00.000Z',
        finishedAt: '2026-04-01T10:00:00.500Z',
      },
    ], null, 2)
  );
  return tmpRoot;
}

// ---------- TC_FAIL1: default excludes failed- archives ----------

test("TC_FAIL1 usageAll excludes failed- archives by default", () => {
  const tmpRoot = buildTmpFixtureWithFailed();
  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { json: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  let result;
  try {
    result = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON output, got parse error: ${e.message}\nOutput: ${out}`);
  }

  const failedArchives = result.archives.filter((a) => a.id.includes('failed-'));
  assert.strictEqual(
    failedArchives.length,
    0,
    `Expected no archive id to include 'failed-', got: ${JSON.stringify(result.archives.map((a) => a.id))}`
  );
});

// ---------- TC_FAIL2: includeFailed:true includes failed- archives ----------

test("TC_FAIL2 usageAll with includeFailed:true includes failed- archives", () => {
  const tmpRoot = buildTmpFixtureWithFailed();
  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { json: true, includeFailed: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  let result;
  try {
    result = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON output, got parse error: ${e.message}\nOutput: ${out}`);
  }

  const failedArchives = result.archives.filter((a) => a.id.includes('failed-'));
  assert.ok(
    failedArchives.length >= 1,
    `Expected at least one archive id to include 'failed-', got: ${JSON.stringify(result.archives.map((a) => a.id))}`
  );
});

// ---------- TC_FAIL3: empty tmpdir returns empty archives and totalSessions===0 ----------

test("TC_FAIL3 usageAll with no archives dir returns empty archives and aggregate.totalSessions===0", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-empty-'));
  let out;
  try {
    out = captureStdout(() => usageAll(tmpRoot, { json: true }));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  let result;
  try {
    result = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON output, got parse error: ${e.message}\nOutput: ${out}`);
  }

  assert.strictEqual(
    result.archives.length,
    0,
    `Expected archives.length===0, got ${result.archives.length}`
  );
  assert.strictEqual(
    result.aggregate.totalSessions,
    0,
    `Expected aggregate.totalSessions===0, got ${result.aggregate.totalSessions}`
  );
});

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
