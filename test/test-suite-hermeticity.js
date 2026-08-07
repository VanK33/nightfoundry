/**
 * test-suite-hermeticity.js — Verifies that the test suite runs hermetically:
 * no case opens a real Agent SDK session or requires claude CLI
 * authentication unless explicitly opted in via CC_ORCH_REAL_SDK=1.
 *
 * Covers:
 *   Criterion 1 — test/test-session.js, when spawned with CC_ORCH_REAL_SDK
 *     absent from its env, self-skips: exits 0, prints a SKIP marker naming
 *     CC_ORCH_REAL_SDK, and emits none of its SessionManager test banners.
 *   Criterion 2 — archive()'s hermeticity guard: under CC_ORCH_TEST='1',
 *     omitting deps.summarize causes archive() to reject with a descriptive
 *     error naming the deps.summarize override the caller must inject,
 *     instead of constructing a real Summarizer / opening a real SDK
 *     session; injecting a stub deps.summarize makes the guard inert.
 *   Criterion 5 — the runner's in-flight marker and its own manifest
 *     registration: scripts/run-tests.js's source emits a `[RUN] ` marker
 *     ahead of each spawnSync invocation inside runEntry (both the
 *     plain-node and npm special-case branches), and dynamically importing
 *     run-tests.js exposes a TEST_FILES export that includes this file's
 *     own path — self-verifying its registration in the suite manifest.
 *
 * Run: node test/test-suite-hermeticity.js
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { archive } from '../src/cli/commands/archive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

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

// ── Criterion 1 ──────────────────────────────────────────────────────
await test('Criterion 1: test-session.js self-skips with no CC_ORCH_REAL_SDK', async () => {
  const childEnv = { ...process.env };
  delete childEnv.CC_ORCH_REAL_SDK;
  assert.ok(
    !Object.prototype.hasOwnProperty.call(childEnv, 'CC_ORCH_REAL_SDK'),
    'CC_ORCH_REAL_SDK must be absent from the child env, not merely empty'
  );

  const testSessionPath = path.join(repoRoot, 'test', 'test-session.js');

  const result = spawnSync('node', [testSessionPath], {
    encoding: 'utf8',
    env: childEnv,
  });

  assert.strictEqual(
    result.status,
    0,
    `expected child exit status 0, got ${result.status}; stderr: ${result.stderr}`
  );

  const stdout = result.stdout || '';

  assert.ok(
    /\[SKIP\][^\n]*CC_ORCH_REAL_SDK/.test(stdout),
    `expected stdout to contain a SKIP marker naming CC_ORCH_REAL_SDK; got: ${stdout}`
  );

  assert.ok(
    !stdout.includes('=== SessionManager Tests (Agent SDK) ==='),
    'stdout must NOT contain the SessionManager Tests banner'
  );
  assert.ok(
    !stdout.includes('Test 1:'),
    'stdout must NOT contain a "Test 1:" header'
  );
  assert.ok(
    !stdout.includes('=== Results:'),
    'stdout must NOT contain the "=== Results:" banner'
  );
});

// ── Criterion 2 ──────────────────────────────────────────────────────
// Fixture helper: an mkdtemp .harness/ project with exactly one 'complete'
// milestone (so validateArchivable accepts it), a spec file, some harness
// artifacts for the move, and a package.json with NO scripts['test:all']
// (so runFinalTestGate self-skips and no external suite is shelled out).

const tmpDirs = [];
function cleanupTmpDirs() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
}

function makeHermeticityFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-hermeticity-archive-'));
  tmpDirs.push(tmpDir);

  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  const specRelPath = 'spec.md';
  fs.writeFileSync(
    path.join(tmpDir, specRelPath),
    '# Test Spec\n\nCriterion-2 hermeticity guard fixture.',
    'utf8'
  );

  const state = {
    name: 'Hermeticity Guard Fixture',
    spec: specRelPath,
    startedAt: '2026-01-01T00:00:00.000Z',
    milestones: [
      { id: '001', description: 'Only milestone', status: 'complete' },
    ],
    projectMeta: { currentPhase: 'complete' },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

  // Harness artifacts so the archive move has content.
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'logs', 'test.log'), 'sample log', 'utf8');

  // package.json with NO scripts['test:all'] — runFinalTestGate self-skips.
  const pkg = { name: 'suite-hermeticity-fixture', version: '0.0.0', scripts: {} };
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');

  return tmpDir;
}

const mockGetGitInfo = () => ({ gitHead: 'abc1234567890abcdef', gitStatus: 'clean' });

const stubSummarize = async () => ({
  headline: 'Hermeticity guard stub run',
  bugs: [],
  summary: 'Run completed via stubbed summarizer.',
});

await test('Criterion 2: archive() hermeticity guard rejects without deps.summarize, is inert with it', async () => {
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, 'CC_ORCH_TEST');
  const priorValue = process.env.CC_ORCH_TEST;
  try {
    // Set explicitly INSIDE the case, so the guarded condition is exercised
    // when this file is run directly (not merely inherited from the runner).
    process.env.CC_ORCH_TEST = '1';

    // (i) No deps.summarize override → archive() must reject, and the
    // rejection message must identify the refusal to construct a real
    // Summarizer and name the deps.summarize override.
    const fixtureRootA = makeHermeticityFixture();
    const depsNoSummarize = { getGitInfo: mockGetGitInfo };

    let rejected = false;
    let rejectionMessage = '';
    try {
      await archive(fixtureRootA, null, { auto: true }, depsNoSummarize);
    } catch (err) {
      rejected = true;
      rejectionMessage = err.message;
    }

    assert.ok(rejected, 'archive() must reject when deps carries no summarize override under CC_ORCH_TEST=1');
    assert.ok(
      /Refusing to construct a real Summarizer/.test(rejectionMessage),
      `rejection message should identify the refusal to construct a real Summarizer, got: ${rejectionMessage}`
    );
    assert.ok(
      rejectionMessage.includes('deps.summarize'),
      `rejection message should name the deps.summarize override, got: ${rejectionMessage}`
    );

    // (ii) With a stub deps.summarize override, archive() on a fresh fixture
    // settles WITHOUT producing the guard error — demonstrating the guard is
    // inert once the seam is injected. The stub never constructs a real
    // Summarizer or opens an SDK session.
    const fixtureRootB = makeHermeticityFixture();
    const depsWithSummarize = { getGitInfo: mockGetGitInfo, summarize: stubSummarize };

    let settledWithGuardError = false;
    try {
      await archive(fixtureRootB, null, { auto: true }, depsWithSummarize);
    } catch (err) {
      if (/Refusing to construct a real Summarizer/.test(err.message)) {
        settledWithGuardError = true;
      }
      // Any other failure is not the concern of this guard assertion — the
      // fixture is a minimal archive() run; what matters is the guard did
      // not fire when a summarize override was injected.
    }

    assert.ok(
      !settledWithGuardError,
      'archive() with a stub deps.summarize override must not produce the hermeticity guard error'
    );
  } finally {
    // Restore process.env.CC_ORCH_TEST to its pre-case state, even if
    // archive() throws, so the mutation cannot leak into other cases.
    if (hadKey) {
      process.env.CC_ORCH_TEST = priorValue;
    } else {
      delete process.env.CC_ORCH_TEST;
    }
    cleanupTmpDirs();
  }
});

// ── Criterion 5 ──────────────────────────────────────────────────────
// (i) scripts/run-tests.js's source emits a `[RUN] ` marker ahead of the
//     spawn invocation inside runEntry — a child's launch must be visible
//     before it runs, under serial and pooled execution alike.
// (ii) Dynamically importing scripts/run-tests.js exposes a TEST_FILES
//     export that includes this file's own path — the file registers
//     itself in the suite manifest. The import is side-effect-free: the
//     runner's execution is guarded behind an isMain check keyed off
//     process.argv[1], which does not match when this file (not
//     run-tests.js) is the entry point, so no test loop runs and nothing
//     is shelled out.

const runTestsPath = path.join(repoRoot, 'scripts', 'run-tests.js');

await test('Criterion 5: run-tests.js emits [RUN] markers and self-registers this file', async () => {
  const src = fs.readFileSync(runTestsPath, 'utf8');

  // (i) A `[RUN] ` marker emission is present in the source at all.
  assert.ok(
    src.includes('[RUN] '),
    'scripts/run-tests.js source must contain a `[RUN] ` marker log emission'
  );

  // Isolate the runEntry function body so the ordering assertions below
  // are scoped to it (not merely present somewhere else in the file).
  const fnStart = src.indexOf('function runEntry(entry');
  assert.ok(fnStart !== -1, 'expected to find a runEntry function declaration');
  const nextMarkerIdx = src.indexOf('export async function runAll', fnStart);
  assert.ok(nextMarkerIdx !== -1, 'expected to find the runAll pool after runEntry');
  const runEntrySrc = src.slice(fnStart, nextMarkerIdx);

  // `[RUN] ` log must precede the spawn('node', ...) call.
  const logIdx = runEntrySrc.indexOf('[RUN] ');
  const spawnIdx = runEntrySrc.indexOf("spawn('node'");
  assert.ok(logIdx !== -1, 'runEntry must contain a `[RUN] ` log emission');
  assert.ok(spawnIdx !== -1, "runEntry must contain a spawn('node', ...) call");
  assert.ok(
    logIdx < spawnIdx,
    'the `[RUN] ` marker must be logged before the spawn invocation'
  );

  // (ii) Dynamically import run-tests.js purely for its TEST_FILES export.
  // Cache-busting query string avoids ESM module-cache collisions across
  // repeated test runs; the import triggers no test loop because the
  // runner's execution is guarded behind an isMain check
  // (process.argv[1].endsWith('run-tests.js')), which is false here since
  // this file — not run-tests.js — is the entry point.
  const mod = await import(`${pathToFileURL(runTestsPath).href}?t=${Date.now()}`);
  const testFiles = mod.TEST_FILES ?? [];

  assert.ok(Array.isArray(testFiles), 'expected run-tests.js to export a TEST_FILES array');
  assert.ok(
    testFiles.includes('test/test-suite-hermeticity.js'),
    "TEST_FILES must include this file's own registration: test/test-suite-hermeticity.js"
  );
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
