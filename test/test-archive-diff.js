/**
 * test-archive-diff.js — Unit tests for archiveDiff in archive-diff.js.
 *
 * Covers SC-5 (valid diff with correct deltas) and SC-6 (missing archive error
 * + available IDs hint), plus --json output and zero-denominator edge case.
 * No Claude auth, no SDK. Pure fs + temp directories.
 * Run: node test/test-archive-diff.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { archiveDiff } from '../src/cli/commands/archive-diff.js';

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

// ── stdout/stderr capture helper ──────────────────────────────────────────────

function captureOutput(fn) {
  const outChunks = [];
  const errChunks = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);

  process.stdout.write = (chunk, ...args) => {
    outChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk, ...args) => {
    errChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => {
    outChunks.push(args.join(' ') + '\n');
  };
  console.error = (...args) => {
    errChunks.push(args.join(' ') + '\n');
  };

  let returnValue;
  try {
    returnValue = fn();
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
  }

  return {
    stdout: outChunks.join(''),
    stderr: errChunks.join(''),
    returnValue,
  };
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

const MANIFEST_A = {
  id: '001-alpha-run',
  name: 'Alpha Run',
  archivedAt: '2026-03-01T10:00:00.000Z',
  totalCost: 1.00,
  totalSessions: 4,
  milestones: [
    { id: '001', description: 'First milestone', status: 'complete' },
    { id: '002', description: 'Second milestone', status: 'complete' },
  ],
  headline: 'Alpha archive headline',
  summary: 'Alpha summary',
};

const MANIFEST_B = {
  id: '002-beta-run',
  name: 'Beta Run',
  archivedAt: '2026-04-05T14:30:00.000Z',
  totalCost: 3.00,
  totalSessions: 8,
  milestones: [
    { id: '001', description: 'First milestone', status: 'complete' },
    { id: '002', description: 'Second milestone', status: 'complete' },
    { id: '003', description: 'Third milestone', status: 'complete' },
    { id: '004', description: 'Fourth milestone', status: 'complete' },
  ],
  headline: 'Beta archive headline',
  summary: 'Beta summary',
};

/**
 * Create a temp projectRoot with archives populated per the given map.
 * manifestMap: { archiveId: manifest_object }
 */
function makeTempProject(manifestMap) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-diff-test-'));
  const archivesDir = path.join(tmpDir, 'archives');
  fs.mkdirSync(archivesDir, { recursive: true });

  for (const [archiveId, manifest] of Object.entries(manifestMap)) {
    const entryDir = path.join(archivesDir, archiveId);
    fs.mkdirSync(entryDir, { recursive: true });
    fs.writeFileSync(
      path.join(entryDir, 'manifest.json'),
      JSON.stringify(manifest),
      'utf8'
    );
  }

  return tmpDir;
}

// ── TC1: SC-5 — two valid archive IDs prints comparison with correct deltas ───

test('TC1 SC-5: two valid archive IDs prints cost/sessions/milestones with correct deltas', () => {
  const tmpDir = makeTempProject({
    [MANIFEST_A.id]: MANIFEST_A,
    [MANIFEST_B.id]: MANIFEST_B,
  });
  try {
    const { stdout } = captureOutput(() =>
      archiveDiff(tmpDir, MANIFEST_A.id, MANIFEST_B.id)
    );

    // Header should mention both IDs
    assert.ok(
      stdout.includes(MANIFEST_A.id) && stdout.includes(MANIFEST_B.id),
      `Expected both archive IDs in output, got:\n${stdout}`
    );

    // Cost: $1.00 → $3.00 (+$2.00, +200%)
    assert.ok(
      stdout.includes('$1.00'),
      `Expected cost A '$1.00' in output, got:\n${stdout}`
    );
    assert.ok(
      stdout.includes('$3.00'),
      `Expected cost B '$3.00' in output, got:\n${stdout}`
    );
    // Absolute delta: +$2.00
    assert.ok(
      stdout.includes('+$2.00'),
      `Expected absolute cost delta '+$2.00' in output, got:\n${stdout}`
    );
    // Percentage delta: +200%
    assert.ok(
      stdout.includes('+200%'),
      `Expected percentage cost delta '+200%' in output, got:\n${stdout}`
    );

    // Sessions: 4 → 8 (+4, +100%)
    assert.ok(
      stdout.includes('+4'),
      `Expected sessions absolute delta '+4' in output, got:\n${stdout}`
    );
    assert.ok(
      stdout.includes('+100%'),
      `Expected sessions percentage delta '+100%' in output, got:\n${stdout}`
    );

    // Milestones: 2 → 4 (+2, +100%)
    assert.ok(
      stdout.includes('Milestones'),
      `Expected 'Milestones' label in output, got:\n${stdout}`
    );
    assert.ok(
      stdout.includes('+2'),
      `Expected milestones absolute delta '+2' in output, got:\n${stdout}`
    );

    // No NaN anywhere
    assert.ok(
      !stdout.includes('NaN'),
      `Output should not contain NaN, got:\n${stdout}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC2: SC-6 — one invalid archive ID prints error and lists available IDs ───

test('TC2 SC-6: invalid archive ID prints error and lists available archive IDs', () => {
  const tmpDir = makeTempProject({
    [MANIFEST_A.id]: MANIFEST_A,
    [MANIFEST_B.id]: MANIFEST_B,
  });
  try {
    const { stdout, stderr } = captureOutput(() =>
      archiveDiff(tmpDir, MANIFEST_A.id, 'nonexistent-archive-id')
    );

    // Error about the missing ID
    assert.ok(
      stderr.includes('nonexistent-archive-id'),
      `Expected error mentioning missing ID in stderr, got:\n${stderr}`
    );
    assert.ok(
      stderr.toLowerCase().includes('error') ||
      stderr.toLowerCase().includes('not found'),
      `Expected error message in stderr, got:\n${stderr}`
    );

    // Hint showing available IDs
    assert.ok(
      stderr.includes(MANIFEST_A.id) || stderr.includes(MANIFEST_B.id),
      `Expected available archive IDs listed in stderr, got:\n${stderr}`
    );

    // No diff output on stdout
    assert.ok(
      !stdout.includes('Cost:'),
      `Expected no diff output on stdout when ID is missing, got:\n${stdout}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC3: JSON mode outputs structured diff object with delta fields ────────────

test('TC3: --json mode outputs structured diff object with delta fields', () => {
  const tmpDir = makeTempProject({
    [MANIFEST_A.id]: MANIFEST_A,
    [MANIFEST_B.id]: MANIFEST_B,
  });
  try {
    const { stdout, returnValue } = captureOutput(() =>
      archiveDiff(tmpDir, MANIFEST_A.id, MANIFEST_B.id, { json: true })
    );

    // stdout should be valid JSON
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      throw new Error(`Expected valid JSON output, parse error: ${e.message}\nOutput: ${stdout}`);
    }

    // Top-level fields: a, b, cost, sessions, milestones
    assert.strictEqual(parsed.a, MANIFEST_A.id, `Expected a === '${MANIFEST_A.id}'`);
    assert.strictEqual(parsed.b, MANIFEST_B.id, `Expected b === '${MANIFEST_B.id}'`);

    // cost section with delta fields
    assert.ok(typeof parsed.cost === 'object', 'Expected cost object in diff');
    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed.cost, 'delta'),
      'Expected cost.delta field'
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed.cost, 'pct'),
      'Expected cost.pct field'
    );
    assert.strictEqual(parsed.cost.a, 1.00, `Expected cost.a === 1.00, got ${parsed.cost.a}`);
    assert.strictEqual(parsed.cost.b, 3.00, `Expected cost.b === 3.00, got ${parsed.cost.b}`);
    assert.ok(
      Math.abs(parsed.cost.delta - 2.00) < 0.001,
      `Expected cost.delta ≈ 2.00, got ${parsed.cost.delta}`
    );

    // sessions section with delta fields
    assert.ok(typeof parsed.sessions === 'object', 'Expected sessions object in diff');
    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed.sessions, 'delta'),
      'Expected sessions.delta field'
    );
    assert.strictEqual(parsed.sessions.delta, 4, `Expected sessions.delta === 4, got ${parsed.sessions.delta}`);

    // milestones section with delta fields
    assert.ok(typeof parsed.milestones === 'object', 'Expected milestones object in diff');
    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed.milestones, 'delta'),
      'Expected milestones.delta field'
    );
    assert.strictEqual(parsed.milestones.delta, 2, `Expected milestones.delta === 2, got ${parsed.milestones.delta}`);

    // Return value should match the parsed diff
    if (returnValue !== undefined) {
      assert.strictEqual(returnValue.a, MANIFEST_A.id, 'Return value should have a === idA');
      assert.strictEqual(returnValue.b, MANIFEST_B.id, 'Return value should have b === idB');
    }

    // No NaN in JSON output
    assert.ok(!stdout.includes('NaN'), `JSON output should not contain NaN, got:\n${stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC4: Zero-cost archive doesn't produce NaN in percentage output ───────────

test('TC4: zero-cost archive shows n/a (not NaN) in percentage output', () => {
  const zeroCostManifest = {
    id: '001-zero-cost',
    name: 'Zero Cost Run',
    archivedAt: '2026-01-01T00:00:00.000Z',
    totalCost: 0,
    totalSessions: 0,
    milestones: [],
    headline: 'Zero cost headline',
    summary: 'Zero cost summary',
  };
  const nonZeroManifest = {
    id: '002-some-cost',
    name: 'Some Cost Run',
    archivedAt: '2026-02-01T00:00:00.000Z',
    totalCost: 2.50,
    totalSessions: 5,
    milestones: [
      { id: '001', description: 'A milestone', status: 'complete' },
    ],
    headline: 'Non-zero cost headline',
    summary: 'Non-zero cost summary',
  };

  const tmpDir = makeTempProject({
    [zeroCostManifest.id]: zeroCostManifest,
    [nonZeroManifest.id]: nonZeroManifest,
  });
  try {
    // Text output: zero as baseline
    const { stdout: textOut } = captureOutput(() =>
      archiveDiff(tmpDir, zeroCostManifest.id, nonZeroManifest.id)
    );

    assert.ok(
      !textOut.includes('NaN'),
      `Text output should not contain NaN when cost baseline is 0, got:\n${textOut}`
    );
    // Should show n/a instead of a percentage when denominator is 0
    assert.ok(
      textOut.includes('n/a'),
      `Expected 'n/a' for zero-denominator percentage, got:\n${textOut}`
    );

    // JSON output: zero as baseline → pct should be null (not NaN)
    const { stdout: jsonOut } = captureOutput(() =>
      archiveDiff(tmpDir, zeroCostManifest.id, nonZeroManifest.id, { json: true })
    );

    const parsed = JSON.parse(jsonOut);
    assert.ok(
      !jsonOut.includes('NaN'),
      `JSON output should not contain NaN when cost baseline is 0, got:\n${jsonOut}`
    );
    // pct should be null (not NaN) when baseline is 0
    assert.strictEqual(
      parsed.cost.pct,
      null,
      `Expected cost.pct === null for zero baseline, got ${parsed.cost.pct}`
    );
    assert.strictEqual(
      parsed.sessions.pct,
      null,
      `Expected sessions.pct === null for zero baseline, got ${parsed.sessions.pct}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
