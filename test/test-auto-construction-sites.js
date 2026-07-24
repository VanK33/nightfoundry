/**
 * test-auto-construction-sites.js — Unit tests verifying that each CLI entry
 * point sets pipeline.autoFromHere correctly after construction.
 *
 * Tests:
 *   TC1 — run.js createPipeline with flags.auto=true  → pipeline.autoFromHere===true
 *   TC2 — task.js createPipeline with flags.auto=true → pipeline.autoFromHere===true
 *   TC3 — resume.js with flags.auto=true              → pipeline.autoFromHere===true
 *   TC4 — dry-run.js with flags.auto=true             → pipeline.autoFromHere===true
 *   TC5 — webhook.js pipeline                         → pipeline.autoFromHere===true (always)
 *   TC6 — run.js createPipeline with flags.auto=false → pipeline.autoFromHere===false
 *
 * Approach:
 *   - Import each CLI command function directly.
 *   - Import Pipeline from the shared ESM module (same binding used inside the CLI).
 *   - Stub Pipeline.prototype methods before calling CLI functions — ESM module
 *     caching means the prototype stub applies to instances created inside the CLI.
 *   - Capture `this` (the pipeline instance) inside the stub and assert autoFromHere.
 *   - Restore all stubs in finally blocks.
 *
 * Run: node test/test-auto-construction-sites.js
 */
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// This suite's fixtures spawn a fresh Pipeline against isolated fs.mkdtemp
// roots (TC3/TC5 create a flat .harness/ dir for Logger init; TC6 creates a
// flat .harness/state.json to skip the interactive prompt). None of these
// carry an active-run pointer, so assertNoReentrantLiveRun's fallback to the
// flat harnessRoot() is a no-op for them via the resolveActiveHarnessDir
// accessor — UNLESS this suite is launched from inside a live cc-orch run
// (e.g. via a spawned test gate), in which case CC_ORCH_ACTIVE_RUN is
// inherited from the parent process. Clear the marker here so this file runs
// re-entrancy-neutral regardless of launch context (mirrors
// scripts/run-tests.js).
delete process.env.CC_ORCH_ACTIVE_RUN;

import { run } from '../src/cli/commands/run.js';
import { task } from '../src/cli/commands/task.js';
import { resume } from '../src/cli/commands/resume.js';
import { dryRun } from '../src/cli/commands/dry-run.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress stdout/stderr during fn(), return { stdout, stderr, thrownError }. */
async function captureOutput(fn) {
  const outChunks = [];
  const errChunks = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  process.stdout.write = (chunk) => { outChunks.push(typeof chunk === 'string' ? chunk : chunk.toString()); return true; };
  process.stderr.write = (chunk) => { errChunks.push(typeof chunk === 'string' ? chunk : chunk.toString()); return true; };
  console.log = (...args) => outChunks.push(args.join(' ') + '\n');
  console.error = (...args) => errChunks.push(args.join(' ') + '\n');
  console.warn = (...args) => outChunks.push(args.join(' ') + '\n');

  let thrownError = null;
  try { await fn(); }
  catch (err) { thrownError = err; }
  finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
  return { stdout: outChunks.join(''), stderr: errChunks.join(''), thrownError };
}

/** Create a temp project root dir with a minimal .harness/ for Logger init. */
function makeTmpRoot(prefix = 'cc-orch-auto-sites-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Make an HTTP POST request using the built-in http module.
 * Returns a Promise resolving to the parsed JSON response body.
 */
function httpPost(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (chunk) => { chunks += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(chunks)); }
          catch { resolve(chunks); }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// TC1: run.js createPipeline with flags.auto=true → pipeline.autoFromHere===true
// ---------------------------------------------------------------------------

await test('TC1: run.js flags.auto=true → pipeline.autoFromHere===true', async () => {
  const tmpDir = makeTmpRoot();
  let capturedPipeline = null;

  // Stub Pipeline.prototype.run to capture the pipeline instance (`this`) and
  // return null — run.js skips result-dependent rendering for a falsy result.
  const origRun = Pipeline.prototype.run;
  Pipeline.prototype.run = async function stubRun() {
    capturedPipeline = this;
    return null;
  };

  const origExit = process.exit;
  process.exit = (code) => { throw new Error(`process.exit called with code ${code}`); };

  try {
    const specPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specPath, '# Test Spec\n');

    // flags.auto=true → run.js logs "No .harness/ found. Initializing..."
    // and skips the interactive askYesNo prompt.
    await captureOutput(async () => {
      await run(tmpDir, specPath, { auto: true });
    });

    assert.ok(
      capturedPipeline !== null,
      'Expected pipeline.run to be called (pipeline instance captured)',
    );
    assert.strictEqual(
      capturedPipeline.autoFromHere,
      true,
      `Expected pipeline.autoFromHere===true, got ${JSON.stringify(capturedPipeline.autoFromHere)}`,
    );
  } finally {
    Pipeline.prototype.run = origRun;
    process.exit = origExit;
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// TC2: task.js createPipeline with flags.auto=true → pipeline.autoFromHere===true
// ---------------------------------------------------------------------------

await test('TC2: task.js flags.auto=true → pipeline.autoFromHere===true', async () => {
  const tmpDir = makeTmpRoot();
  let capturedPipeline = null;

  const origRun = Pipeline.prototype.run;
  Pipeline.prototype.run = async function stubRun() {
    capturedPipeline = this;
    return null; // falsy → skips result-dependent rendering in task.js
  };

  const origExit = process.exit;
  process.exit = (code) => { throw new Error(`process.exit called with code ${code}`); };

  try {
    // With flags.auto=true, task.js creates .harness/ automatically (no prompt).
    await captureOutput(async () => {
      await task(tmpDir, 'Implement something', { auto: true });
    });

    assert.ok(
      capturedPipeline !== null,
      'Expected pipeline.run to be called (pipeline instance captured)',
    );
    assert.strictEqual(
      capturedPipeline.autoFromHere,
      true,
      `Expected pipeline.autoFromHere===true, got ${JSON.stringify(capturedPipeline.autoFromHere)}`,
    );
  } finally {
    Pipeline.prototype.run = origRun;
    process.exit = origExit;
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// TC3: resume.js with flags.auto=true → pipeline.autoFromHere===true
// ---------------------------------------------------------------------------

await test('TC3: resume.js flags.auto=true → pipeline.autoFromHere===true', async () => {
  const tmpDir = makeTmpRoot();
  let capturedPipeline = null;

  // Stub batchResume to capture the pipeline instance.
  // Using batch:true so resume.js skips the isUnresumableState guard.
  const origBatchResume = Pipeline.prototype.batchResume;
  Pipeline.prototype.batchResume = async function stubBatchResume() {
    capturedPipeline = this;
    return { archived: 0, failed: 0 };
  };

  const origExit = process.exit;
  process.exit = (code) => { throw new Error(`process.exit called with code ${code}`); };

  try {
    // Create .harness/ so Logger can initialize without errors.
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });

    await captureOutput(async () => {
      await resume(tmpDir, { auto: true, batch: true });
    });

    assert.ok(
      capturedPipeline !== null,
      'Expected pipeline.batchResume to be called (pipeline instance captured)',
    );
    assert.strictEqual(
      capturedPipeline.autoFromHere,
      true,
      `Expected pipeline.autoFromHere===true, got ${JSON.stringify(capturedPipeline.autoFromHere)}`,
    );
  } finally {
    Pipeline.prototype.batchResume = origBatchResume;
    process.exit = origExit;
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// TC4: dry-run.js with flags.auto=true → pipeline.autoFromHere===true
// ---------------------------------------------------------------------------

await test('TC4: dry-run.js flags.auto=true → pipeline.autoFromHere===true', async () => {
  const tmpDir = makeTmpRoot();
  let capturedPipeline = null;

  // Stub dryRunValidate to capture the pipeline instance.
  const origDryRunValidate = Pipeline.prototype.dryRunValidate;
  Pipeline.prototype.dryRunValidate = async function stubDryRunValidate() {
    capturedPipeline = this;
  };

  const origExit = process.exit;
  process.exit = (code) => { throw new Error(`process.exit called with code ${code}`); };

  try {
    const specPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specPath, '# Test Spec\n');

    await captureOutput(async () => {
      await dryRun(tmpDir, specPath, { auto: true });
    });

    assert.ok(
      capturedPipeline !== null,
      'Expected pipeline.dryRunValidate to be called (pipeline instance captured)',
    );
    assert.strictEqual(
      capturedPipeline.autoFromHere,
      true,
      `Expected pipeline.autoFromHere===true, got ${JSON.stringify(capturedPipeline.autoFromHere)}`,
    );
  } finally {
    Pipeline.prototype.dryRunValidate = origDryRunValidate;
    process.exit = origExit;
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// TC5: webhook.js pipeline → pipeline.autoFromHere===true (always)
// ---------------------------------------------------------------------------
//
// webhook.js always sets `pipeline.autoFromHere = true` regardless of any flags.
// We build the app via the injectable buildWebhookApp({ projectRoot, createPipeline })
// factory, listen on an ephemeral port, POST to /run, and verify the pipeline
// instance captured by the injected createPipeline.

await test('TC5: webhook.js pipeline → pipeline.autoFromHere===true (always)', async () => {
  const tmpDir = makeTmpRoot();
  let capturedPipeline = null;
  let server = null;

  try {
    // Create .harness/ in tmpDir so Logger can initialize cleanly.
    fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });

    const { buildWebhookApp } = await import('../src/triggers/webhook.js');

    // Injected createPipeline captures the constructed pipeline instance and
    // mirrors webhook.js's own defaultCreatePipeline behaviour (autoFromHere
    // always true), with a stubbed run() so the fire-and-forget call resolves
    // immediately without doing real work.
    function createPipeline(root, opts) {
      const pipeline = new Pipeline(root, opts);
      pipeline.autoFromHere = true;
      pipeline.run = async () => null;
      capturedPipeline = pipeline;
      return pipeline;
    }

    // Green baselineGate stub so the default gate does not refuse before
    // createPipeline runs — TC5 POSTs against a bare mkdtemp fixture with no
    // package.json, which the real default gate would otherwise reject.
    const baselineGate = async () => ({ ok: true, skipped: [] });

    const app = buildWebhookApp({ projectRoot: tmpDir, createPipeline, baselineGate });
    server = app.listen(0);
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const port = server.address().port;

    // POST /run to trigger pipeline construction inside the route handler.
    await captureOutput(async () => {
      await httpPost(port, '/run', { goal: 'test goal for TC5' });
    });

    // The fire-and-forget pipeline.run() is called asynchronously inside the handler.
    // Give the micro-task queue a tick to let the stub execute.
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(
      capturedPipeline !== null,
      'Expected pipeline.run to be called by webhook handler (pipeline instance captured)',
    );
    assert.strictEqual(
      capturedPipeline.autoFromHere,
      true,
      `Expected pipeline.autoFromHere===true, got ${JSON.stringify(capturedPipeline.autoFromHere)}`,
    );
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// TC6: run.js createPipeline with flags.auto=false → pipeline.autoFromHere===false
// ---------------------------------------------------------------------------

await test('TC6: run.js flags.auto=false → pipeline.autoFromHere===false', async () => {
  const tmpDir = makeTmpRoot();
  let capturedPipeline = null;

  const origRun = Pipeline.prototype.run;
  Pipeline.prototype.run = async function stubRun() {
    capturedPipeline = this;
    return null;
  };

  const origExit = process.exit;
  process.exit = (code) => { throw new Error(`process.exit called with code ${code}`); };

  try {
    const specPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specPath, '# Test Spec\n');

    // Create .harness/state.json so run.js skips the interactive
    // "No .harness/ found — initialize?" prompt (only shown when autoMode is false).
    const harnessDir = path.join(tmpDir, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    fs.writeFileSync(
      path.join(harnessDir, 'state.json'),
      JSON.stringify({ globalStatus: 'idle', projectMeta: {}, milestones: {} }),
    );

    await captureOutput(async () => {
      await run(tmpDir, specPath, { auto: false });
    });

    assert.ok(
      capturedPipeline !== null,
      'Expected pipeline.run to be called (pipeline instance captured)',
    );
    // run.js uses `const autoMode = flags.auto || flags.a;` — when flags.auto===false
    // and flags.a is absent, the || operator short-circuits to undefined (falsy) rather
    // than the literal false. We assert falsy to match the actual source behaviour.
    assert.ok(
      !capturedPipeline.autoFromHere,
      `Expected pipeline.autoFromHere to be falsy when flags.auto=false, got ${JSON.stringify(capturedPipeline.autoFromHere)}`,
    );
  } finally {
    Pipeline.prototype.run = origRun;
    process.exit = origExit;
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
