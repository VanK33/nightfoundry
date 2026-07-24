/**
 * test-analyze-overhead-snapshot.js — Golden snapshot tests for analyze-overhead.js
 *
 * Run: node test/test-analyze-overhead-snapshot.js
 *
 * Covers:
 *   TC1 — text mode stdout strictly equals golden-text.txt byte-for-byte
 *   TC2 — json mode stdout strictly equals golden-json.txt byte-for-byte
 *   TC3 — test passes against the unmodified pre-refactor script
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    failCount++;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const scriptSrc = path.resolve(__dirname, '../scripts/analyze-overhead.js');
const fixturesDir = path.resolve(__dirname, 'fixtures/analyze-overhead');
const goldenTextPath = path.join(fixturesDir, 'golden-text.txt');
const goldenJsonPath = path.join(fixturesDir, 'golden-json.txt');

/**
 * Build a temp project root that mirrors the fixture archives so that
 * the script's ROOT (derived from __dirname of the *copied* script) resolves
 * to the temp dir rather than the real repo root.
 *
 *   <tmp>/
 *     scripts/
 *       analyze-overhead.js   ← copy of the real script
 *     src/orchestrator/infra/
 *       cross-archive-analyzer.js  ← runtime dependency of the script
 *       usage-analyzer.js          ← transitive dependency
 *     archives/
 *       A-001/logs/session-summary.json
 *       A-002/logs/session-summary.json
 *
 * Returns the path to the copied script inside the temp dir.
 */
function buildTempProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-snap-'));
  const repoRoot = path.resolve(__dirname, '..');

  // scripts/
  fs.mkdirSync(path.join(tmpDir, 'scripts'));
  fs.copyFileSync(scriptSrc, path.join(tmpDir, 'scripts', 'analyze-overhead.js'));

  // src/orchestrator/infra/ — copy modules imported by the script
  const infraSrc = path.join(repoRoot, 'src', 'orchestrator', 'infra');
  const infraDst = path.join(tmpDir, 'src', 'orchestrator', 'infra');
  fs.mkdirSync(infraDst, { recursive: true });
  for (const mod of ['cross-archive-analyzer.js', 'usage-analyzer.js']) {
    fs.copyFileSync(path.join(infraSrc, mod), path.join(infraDst, mod));
  }

  // archives/ — copy each fixture archive
  const archivesSrc = path.join(fixturesDir, 'archives');
  for (const archiveName of fs.readdirSync(archivesSrc).sort()) {
    const logsDir = path.join(tmpDir, 'archives', archiveName, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.copyFileSync(
      path.join(archivesSrc, archiveName, 'logs', 'session-summary.json'),
      path.join(logsDir, 'session-summary.json')
    );
  }

  return { tmpDir, scriptPath: path.join(tmpDir, 'scripts', 'analyze-overhead.js') };
}

// ---------------------------------------------------------------------------
// TC1 — text mode stdout strictly equals golden-text.txt
// ---------------------------------------------------------------------------
await test('TC1: text mode stdout equals golden-text.txt byte-for-byte', async () => {
  const { tmpDir, scriptPath } = buildTempProject();
  try {
    const result = spawnSync(process.execPath, [scriptPath, 'all'], {
      encoding: 'buffer',
      timeout: 15000,
    });

    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, `Script exited with status ${result.status}. stderr: ${result.stderr?.toString()}`);

    const actual = result.stdout;
    const expected = fs.readFileSync(goldenTextPath);

    assert.ok(
      actual.equals(expected),
      `Text output does not match golden.\n` +
      `Expected (${expected.length} bytes):\n${expected.toString()}\n` +
      `Actual (${actual.length} bytes):\n${actual.toString()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC2 — json mode stdout strictly equals golden-json.txt
// ---------------------------------------------------------------------------
await test('TC2: json mode stdout equals golden-json.txt byte-for-byte', async () => {
  const { tmpDir, scriptPath } = buildTempProject();
  try {
    const result = spawnSync(process.execPath, [scriptPath, '--json', 'all'], {
      encoding: 'buffer',
      timeout: 15000,
    });

    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, `Script exited with status ${result.status}. stderr: ${result.stderr?.toString()}`);

    const actual = result.stdout;
    const expected = fs.readFileSync(goldenJsonPath);

    assert.ok(
      actual.equals(expected),
      `JSON output does not match golden.\n` +
      `Expected (${expected.length} bytes):\n${expected.toString()}\n` +
      `Actual (${actual.length} bytes):\n${actual.toString()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
console.log(`${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
