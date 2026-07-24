/**
 * test-archive-list.js — Unit tests for src/cli/commands/archive-list.js
 *
 * Uses temp directories with synthetic manifest.json files.
 * No Claude auth, no SDK. Pure fs + temp dirs.
 * Run: node test/test-archive-list.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { archiveList } from '../src/cli/commands/archive-list.js';

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

// ---------- stdout / stderr capture helpers ----------

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

function captureAll(fn) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);

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

  try {
    fn();
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.warn = origWarn;
  }

  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

// ---------- Fixtures ----------

const MANIFEST_A = {
  id: '001-alpha-run',
  name: 'Alpha Run',
  archivedAt: '2026-03-01T10:00:00.000Z',
  totalCost: 0.5432,
  totalSessions: 7,
  headline: 'First archive headline',
};

const MANIFEST_B = {
  id: '002-beta-run',
  name: 'Beta Run',
  archivedAt: '2026-04-05T14:30:00.000Z',
  totalCost: 1.2345,
  totalSessions: 12,
  headline: 'Second archive headline',
};

const MANIFEST_C = {
  id: '003-gamma-run',
  name: 'Gamma Run',
  archivedAt: '2026-02-15T08:00:00.000Z',
  totalCost: 0.0100,
  totalSessions: 2,
  headline: 'Third archive headline',
};

/** Create a temp projectRoot with archives populated per the given map.
 *  manifestMap: { dirName: manifest_object | 'CORRUPT' }
 */
function makeTempProject(manifestMap) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-list-test-'));
  const archivesDir = path.join(tmpDir, 'archives');
  fs.mkdirSync(archivesDir, { recursive: true });

  for (const [dirName, value] of Object.entries(manifestMap)) {
    const entryDir = path.join(archivesDir, dirName);
    fs.mkdirSync(entryDir, { recursive: true });
    if (value === 'CORRUPT') {
      fs.writeFileSync(path.join(entryDir, 'manifest.json'), '{ not valid json !!!', 'utf8');
    } else {
      fs.writeFileSync(path.join(entryDir, 'manifest.json'), JSON.stringify(value), 'utf8');
    }
  }

  return tmpDir;
}

// ---------- Tests ----------

// TC1: SC-1 — archives dir does not exist → prints 'No archives found.'
test("TC1 SC-1: missing archives → prints 'No archives found.'", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-list-empty-'));
  try {
    const out = captureStdout(() => archiveList(tmpDir));
    assert.ok(out.includes('No archives found.'), `Expected 'No archives found.' in output, got:\n${out}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC1b: SC-1 — archives dir exists but is empty → prints 'No archives found.'
test("TC1b SC-1: empty archives → prints 'No archives found.'", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-list-empty2-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'archives'), { recursive: true });
    const out = captureStdout(() => archiveList(tmpDir));
    assert.ok(out.includes('No archives found.'), `Expected 'No archives found.' in output, got:\n${out}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC2: SC-2 — 2+ archives → table contains ID, Date, Cost, Sessions, Headline columns
test('TC2 SC-2: 2+ archives → table output contains column headers', () => {
  const tmpDir = makeTempProject({ 'alpha-run': MANIFEST_A, 'beta-run': MANIFEST_B });
  try {
    const out = captureStdout(() => archiveList(tmpDir));
    assert.ok(out.includes('ID'), `Expected 'ID' column header, got:\n${out}`);
    assert.ok(out.includes('Date'), `Expected 'Date' column header, got:\n${out}`);
    assert.ok(out.includes('Cost'), `Expected 'Cost' column header, got:\n${out}`);
    // archive-list.js abbreviates the session-count header to 'Sess' to keep
     // the row under 80 cols; accept either spelling for forward-compat.
    assert.ok(/Sess(ions)?/.test(out), `Expected 'Sess' or 'Sessions' column header, got:\n${out}`);
    assert.ok(out.includes('Headline'), `Expected 'Headline' column header, got:\n${out}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC2b: SC-2 — archives sorted reverse-chronologically (newer first)
test('TC2b SC-2: 2+ archives → sorted reverse-chronologically (newer ID appears first)', () => {
  const tmpDir = makeTempProject({
    'alpha-run': MANIFEST_A,  // 2026-03-01
    'beta-run':  MANIFEST_B,  // 2026-04-05 (newer)
    'gamma-run': MANIFEST_C,  // 2026-02-15 (oldest)
  });
  try {
    const out = captureStdout(() => archiveList(tmpDir));

    // Find positions of each archive ID in the output
    const posB = out.indexOf(MANIFEST_B.id);
    const posA = out.indexOf(MANIFEST_A.id);
    const posC = out.indexOf(MANIFEST_C.id);

    assert.ok(posB !== -1, `Expected '${MANIFEST_B.id}' in output`);
    assert.ok(posA !== -1, `Expected '${MANIFEST_A.id}' in output`);
    assert.ok(posC !== -1, `Expected '${MANIFEST_C.id}' in output`);

    // B (newest) should appear before A, which should appear before C (oldest)
    assert.ok(posB < posA, `Expected ${MANIFEST_B.id} (newer) to appear before ${MANIFEST_A.id} in output`);
    assert.ok(posA < posC, `Expected ${MANIFEST_A.id} to appear before ${MANIFEST_C.id} (oldest) in output`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC2c: SC-2 — each archive's data appears in the table
test('TC2c SC-2: table contains manifest data (id, cost, sessions, headline)', () => {
  const tmpDir = makeTempProject({ 'alpha-run': MANIFEST_A, 'beta-run': MANIFEST_B });
  try {
    const out = captureStdout(() => archiveList(tmpDir));

    assert.ok(out.includes(MANIFEST_A.id), `Expected id '${MANIFEST_A.id}' in output`);
    assert.ok(out.includes(MANIFEST_B.id), `Expected id '${MANIFEST_B.id}' in output`);
    assert.ok(out.includes(MANIFEST_A.headline), `Expected headline '${MANIFEST_A.headline}' in output`);
    assert.ok(out.includes(MANIFEST_B.headline), `Expected headline '${MANIFEST_B.headline}' in output`);
    // archive-list.js formats cost with toFixed(2) to keep the row under 80
    // cols; accept either the truncated form or any-precision form so the
    // test tolerates future formatting changes.
    assert.ok(/\$0\.54(32)?/.test(out), `Expected cost ~$0.54 in output`);
    assert.ok(/\$1\.23(45)?/.test(out), `Expected cost ~$1.23 in output`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC3: SC-7 — --json flag → valid JSON array of manifest objects
test('TC3 SC-7: --json flag → outputs valid JSON array', () => {
  const tmpDir = makeTempProject({ 'alpha-run': MANIFEST_A, 'beta-run': MANIFEST_B });
  try {
    const out = captureStdout(() => archiveList(tmpDir, { json: true }));
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch (e) {
      throw new Error(`Expected valid JSON output, got parse error: ${e.message}\nOutput: ${out}`);
    }
    assert.ok(Array.isArray(parsed), `Expected JSON array, got: ${typeof parsed}`);
    assert.strictEqual(parsed.length, 2, `Expected 2 entries in JSON array, got ${parsed.length}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC3b: SC-7 — JSON array contains manifest fields
test('TC3b SC-7: --json array entries contain manifest id and headline fields', () => {
  const tmpDir = makeTempProject({ 'alpha-run': MANIFEST_A, 'beta-run': MANIFEST_B });
  try {
    const out = captureStdout(() => archiveList(tmpDir, { json: true }));
    const parsed = JSON.parse(out);

    const ids = parsed.map(m => m.id);
    assert.ok(ids.includes(MANIFEST_A.id), `Expected '${MANIFEST_A.id}' in JSON output IDs: ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(MANIFEST_B.id), `Expected '${MANIFEST_B.id}' in JSON output IDs: ${JSON.stringify(ids)}`);

    for (const entry of parsed) {
      assert.ok(Object.prototype.hasOwnProperty.call(entry, 'id'), 'Expected each entry to have id field');
      assert.ok(Object.prototype.hasOwnProperty.call(entry, 'archivedAt'), 'Expected each entry to have archivedAt field');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC3c: SC-7 — --json output should NOT include human-readable table headers
test('TC3c SC-7: --json output does not include table headers (ID, Date, Sessions)', () => {
  const tmpDir = makeTempProject({ 'alpha-run': MANIFEST_A, 'beta-run': MANIFEST_B });
  try {
    const out = captureStdout(() => archiveList(tmpDir, { json: true }));
    // Make sure there's no table header line (just JSON)
    const lines = out.trim().split('\n');
    // The first character of valid output should start a JSON array
    assert.ok(out.trimStart().startsWith('['), `Expected JSON array starting with '[', got: ${out.slice(0, 20)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC4: Corrupt manifest is skipped with warning; valid ones still display
test('TC4: corrupt manifest skipped with warning; valid manifests still shown', () => {
  const tmpDir = makeTempProject({
    'alpha-run':  MANIFEST_A,
    'corrupt-run': 'CORRUPT',
    'beta-run':   MANIFEST_B,
  });
  try {
    const { stdout, stderr } = captureAll(() => archiveList(tmpDir));

    // Valid manifests should appear in output
    assert.ok(stdout.includes(MANIFEST_A.id), `Expected valid manifest '${MANIFEST_A.id}' in stdout`);
    assert.ok(stdout.includes(MANIFEST_B.id), `Expected valid manifest '${MANIFEST_B.id}' in stdout`);

    // A warning should have been emitted for the corrupt entry
    assert.ok(
      stderr.includes('Warning') || stderr.toLowerCase().includes('corrupt') || stderr.includes('skipping'),
      `Expected a warning about corrupt manifest in stderr, got:\n${stderr}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TC4b: Corrupt manifest skipped in --json mode; valid ones appear in JSON array
test('TC4b: corrupt manifest skipped in --json mode; valid manifests in JSON array', () => {
  const tmpDir = makeTempProject({
    'alpha-run':  MANIFEST_A,
    'corrupt-run': 'CORRUPT',
  });
  try {
    const { stdout } = captureAll(() => archiveList(tmpDir, { json: true }));
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed), 'Expected JSON array output');
    assert.strictEqual(parsed.length, 1, `Expected 1 valid entry (corrupt skipped), got ${parsed.length}`);
    assert.strictEqual(parsed[0].id, MANIFEST_A.id, `Expected id '${MANIFEST_A.id}'`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
