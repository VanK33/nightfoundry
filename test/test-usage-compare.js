/**
 * test-usage-compare.js — Unit tests for compare() in src/cli/commands/usage.js
 *
 * Creates tmpdir fixture archives with token-usage.json files and asserts
 * compare output contains expected deltas, cache efficiency verdicts, and
 * schema-drift warnings.
 *
 * Run: node test/test-usage-compare.js
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { compare } from '../src/cli/commands/usage.js';

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

// ---------- stdout + stderr capture helper ----------

function captureOutput(fn) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  process.stdout.write = (chunk, ...args) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => {
    stdoutChunks.push(args.join(' ') + '\n');
  };
  console.warn = (...args) => {
    stderrChunks.push(args.join(' ') + '\n');
  };
  console.error = (...args) => {
    stderrChunks.push(args.join(' ') + '\n');
  };

  try {
    fn();
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    all: stdoutChunks.join('') + stderrChunks.join(''),
  };
}

// ---------- Fixture helpers ----------

/**
 * Build a token-usage.json object matching the required file shape.
 */
function makeUsage(sessions, totalsOverride = {}) {
  const sessionCount = sessions.length;
  const inputTokens = sessions.reduce((s, e) => s + (e.inputTokens || 0), 0);
  const outputTokens = sessions.reduce((s, e) => s + (e.outputTokens || 0), 0);
  const cacheCreation = sessions.reduce((s, e) => s + (e.cacheCreation || 0), 0);
  const cacheRead = sessions.reduce((s, e) => s + (e.cacheRead || 0), 0);
  const totalCostUsd = sessions.reduce((s, e) => s + (e.totalCostUsd || 0), 0);
  return {
    sessions,
    totals: {
      sessionCount,
      inputTokens,
      outputTokens,
      cacheCreation,
      cacheRead,
      totalCostUsd,
      ...totalsOverride,
    },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Write token-usage.json into <archivesDir>/<archiveId>/logs/token-usage.json.
 */
function writeArchive(archivesDir, archiveId, usageData) {
  const logsDir = path.join(archivesDir, archiveId, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'token-usage.json'), JSON.stringify(usageData, null, 2));
}

// ---------- Common fixture sessions ----------

const SESSIONS_A = [
  { name: 'plan-1',   type: 'planner',  inputTokens: 100, outputTokens: 50,  cacheCreation: 10, cacheRead: 5,  totalCostUsd: 0.01 },
  { name: 'exec-1',   type: 'executor', inputTokens: 400, outputTokens: 200, cacheCreation: 40, cacheRead: 20, totalCostUsd: 0.04 },
  { name: 'verify-1', type: 'verifier', inputTokens: 180, outputTokens: 90,  cacheCreation: 18, cacheRead: 9,  totalCostUsd: 0.018 },
];

const SESSIONS_B = [
  { name: 'plan-2',   type: 'planner',  inputTokens: 200, outputTokens: 80,  cacheCreation: 20, cacheRead: 10, totalCostUsd: 0.02 },
  { name: 'exec-2',   type: 'executor', inputTokens: 500, outputTokens: 250, cacheCreation: 50, cacheRead: 25, totalCostUsd: 0.05 },
  { name: 'verify-2', type: 'verifier', inputTokens: 220, outputTokens: 110, cacheCreation: 22, cacheRead: 11, totalCostUsd: 0.022 },
  { name: 'exec-3',   type: 'executor', inputTokens: 600, outputTokens: 300, cacheCreation: 60, cacheRead: 30, totalCostUsd: 0.06 },
];

// ---------- Set up shared tmpdir fixture ----------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-compare-'));
const archivesDir = path.join(tmpRoot, 'archives');
fs.mkdirSync(archivesDir, { recursive: true });

writeArchive(archivesDir, 'archive-A', makeUsage(SESSIONS_A));
writeArchive(archivesDir, 'archive-B', makeUsage(SESSIONS_B));

// ---------- TC1: compare output includes cost delta between two fixture archives ----------

test('TC1: compare output includes cost delta between two fixture archives', () => {
  const { stdout } = captureOutput(() => compare(tmpRoot, 'archive-A', 'archive-B'));

  // costA = 0.01 + 0.04 + 0.018 = 0.068
  // costB = 0.02 + 0.05 + 0.022 + 0.06 = 0.152
  // delta = +0.0840
  assert.ok(
    stdout.includes('Total cost'),
    `Expected "Total cost" row in compare output, got:\n${stdout}`
  );
  // The output should contain both cost values and a delta with $ sign
  assert.ok(
    stdout.includes('$0.07') || stdout.includes('$0.068'),
    `Expected archiveA cost "$0.07" in compare output, got:\n${stdout}`
  );
  assert.ok(
    stdout.includes('$0.15') || stdout.includes('$0.152'),
    `Expected archiveB cost "$0.15" in compare output, got:\n${stdout}`
  );
  // The delta row should have a + prefix indicating cost increased
  assert.ok(
    /\+\$0\.08|\+\$0\.084/.test(stdout),
    `Expected positive cost delta in compare output, got:\n${stdout}`
  );
});

// ---------- TC2: compare output includes session count delta ----------

test('TC2: compare output includes session count delta', () => {
  const { stdout } = captureOutput(() => compare(tmpRoot, 'archive-A', 'archive-B'));

  // Sessions A: 3, Sessions B: 4, delta = +1
  assert.ok(
    stdout.includes('Sessions'),
    `Expected "Sessions" row in compare output, got:\n${stdout}`
  );
  // Session count delta should be +1
  assert.ok(
    stdout.includes('+1'),
    `Expected "+1" session count delta in compare output, got:\n${stdout}`
  );
  // Both counts should appear
  assert.ok(
    /\b3\b/.test(stdout),
    `Expected session count "3" for archiveA in compare output, got:\n${stdout}`
  );
  assert.ok(
    /\b4\b/.test(stdout),
    `Expected session count "4" for archiveB in compare output, got:\n${stdout}`
  );
});

// ---------- TC3: compare output includes per-role cache efficiency verdicts ----------

test('TC3: compare output includes per-role cache efficiency verdicts', () => {
  const { stdout } = captureOutput(() => compare(tmpRoot, 'archive-A', 'archive-B'));

  assert.ok(
    stdout.includes('--- Cache Efficiency ---'),
    `Expected "--- Cache Efficiency ---" section in compare output, got:\n${stdout}`
  );
  // Each role should appear with verdict for both archives
  assert.ok(
    stdout.includes('planner'),
    `Expected "planner" in cache efficiency section, got:\n${stdout}`
  );
  assert.ok(
    stdout.includes('executor'),
    `Expected "executor" in cache efficiency section, got:\n${stdout}`
  );
  assert.ok(
    stdout.includes('verifier'),
    `Expected "verifier" in cache efficiency section, got:\n${stdout}`
  );
  // Verdict keyword should appear inline (e.g., "0.5x marginal")
  assert.ok(
    /marginal|healthy|excellent|wasteful|n\/a/.test(stdout),
    `Expected a cache verdict keyword in cache efficiency section, got:\n${stdout}`
  );
});

// ---------- TC4: compare output includes schema-drift warning when one archive has fields the other lacks ----------

test('TC4: compare output includes schema-drift warning when one archive has fields the other lacks', () => {
  // Create archives where sessions differ in fields
  const driftTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-drift-'));
  const driftArchivesDir = path.join(driftTmpRoot, 'archives');
  fs.mkdirSync(driftArchivesDir, { recursive: true });

  const sessionsWithExtra = [
    { name: 'plan-1', type: 'planner', inputTokens: 100, outputTokens: 50, cacheCreation: 10, cacheRead: 5, totalCostUsd: 0.01, experimentalField: 'new-feature' },
  ];
  const sessionsWithout = [
    { name: 'plan-2', type: 'planner', inputTokens: 200, outputTokens: 80, cacheCreation: 20, cacheRead: 10, totalCostUsd: 0.02 },
  ];

  writeArchive(driftArchivesDir, 'drift-A', makeUsage(sessionsWithout));
  writeArchive(driftArchivesDir, 'drift-B', makeUsage(sessionsWithExtra));

  const { stderr } = captureOutput(() => compare(driftTmpRoot, 'drift-A', 'drift-B'));

  assert.ok(
    stderr.toLowerCase().includes('schema drift') || stderr.toLowerCase().includes('schema-drift'),
    `Expected "schema drift" warning in stderr, got:\n${stderr}`
  );
  assert.ok(
    stderr.includes('experimentalField'),
    `Expected field name "experimentalField" in schema-drift warning, got:\n${stderr}`
  );

  // Cleanup
  fs.rmSync(driftTmpRoot, { recursive: true, force: true });
});

// ---------- TC5: compare handles missing archive ID gracefully ----------

test('TC5: compare handles missing archive ID gracefully', () => {
  const { stderr, stdout } = captureOutput(() =>
    compare(tmpRoot, 'archive-A', 'nonexistent-archive-xyz')
  );

  // Should not throw; should emit an error message about the missing archive
  const combined = stderr + stdout;
  assert.ok(
    combined.toLowerCase().includes('nonexistent-archive-xyz') ||
    combined.toLowerCase().includes('not found') ||
    combined.toLowerCase().includes('error'),
    `Expected error/not-found message for missing archive, got stderr:\n${stderr}\nstdout:\n${stdout}`
  );
  // Should NOT produce the compare table (no "Usage Compare" header)
  assert.ok(
    !stdout.includes('--- Usage Compare'),
    `Compare table should NOT be printed when an archive is missing, got stdout:\n${stdout}`
  );
});

// ---------- Cleanup ----------

fs.rmSync(tmpRoot, { recursive: true, force: true });

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
