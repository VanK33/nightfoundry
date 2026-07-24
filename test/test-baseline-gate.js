/**
 * test-baseline-gate.js — Pre-spend baseline gate (engine hole 18).
 *
 * Covers the REAL exported runBaselineGate (src/orchestrator/gates/baseline.js)
 * at unit level over fs.mkdtemp fixture roots, and its REAL entry wiring at
 * cc-orch CLI (src/cli/index.js) and webhook (src/triggers/webhook.js) level.
 *
 * Unit cases (config.execution mutated + restored per case via
 * withConfigOverride, mirroring test-configurable-test-commands.js):
 *   (a)  both commands green                                    -> {ok:true}
 *   (b)  smoke red                                               -> {ok:false}
 *        naming the configured testCommand verbatim + exit code
 *   (c)  smoke green + full red                                  -> {ok:false}
 *        naming the configured testAllCommand
 *   (d)  a failing command emitting >2000 chars                  -> outputTail
 *        is exactly the LAST 2000 chars
 *   (e)  SHORT-CIRCUIT: smoke red -> the full-suite command is NEVER invoked
 *        (proven by the absence of a side-effect file it would have written)
 *   (e2) IDENTICAL-COMMAND DEDUP: testCommand === testAllCommand -> the
 *        command runs exactly ONCE (side-effect counter file === 1)
 *   (e3) SANCTIONED SKIP: default npm commands + a package.json without the
 *        matching scripts -> {ok:true} with both skips reported; a
 *        CONFIGURED (non-default) red command in the same scriptless
 *        fixture still REFUSES
 *
 * Real-entry cases (real `git init` fixtures, ALL fixture inputs — spec.md,
 * .cc-orch.json, package.json — committed BEFORE spawning the CLI via
 * spawnSync on src/cli/index.js):
 *   (f) red fixture: `run <spec>`, `dry-run <spec>`, `task "x"`, and
 *       `resume --batch` each refuse with the gate message, exit non-zero,
 *       and create NO .harness/
 *   (g) green fixture with a deterministic PRE-SPEND STOPPER: a pre-seeded
 *       active-run pointer makes `run` and `task` refuse on claim conflict
 *       (pipeline.js run(), ~line 505-527) before any planner dispatch; an
 *       empty queue makes `resume --batch` refuse before any planner
 *       dispatch. dryRunValidate has NO such pre-spend stopper (it always
 *       reaches planner dispatch), so dry-run's green direction is covered
 *       ONLY at unit level via case (a) above — no case in this file spawns
 *       a real agent session.
 *   (h) NEGATIVE: `status` and single (non-batch) `resume` on the red
 *       fixture never emit the gate message (neither command is
 *       baseline-gated).
 *
 * Webhook cases (buildWebhookApp, src/triggers/webhook.js):
 *   (i) an injected RED-stub baselineGate + a createPipeline stub -> POST
 *       /run still answers 200, the running entry lands 'failed' carrying
 *       the gate message, the active-run claim is CLEARED, and
 *       createPipeline is NEVER called; a GREEN-stub gate -> createPipeline
 *       IS called; and the buildWebhookApp `baselineGate` default parameter
 *       is proven to be the real runBaselineGate (both by source-text
 *       inspection and by dynamically observing the real gate's configured
 *       commands actually execute).
 *
 * Clears CC_ORCH_ACTIVE_RUN unconditionally at module top (mirroring
 * scripts/run-tests.js and test-webhook-run-claim.js) so this suite is
 * re-entrancy-neutral regardless of launch context.
 *
 * Run: node test/test-baseline-gate.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { spawnSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

import config from '../src/orchestrator/infra/config.js';
import { runBaselineGate } from '../src/orchestrator/gates/baseline.js';
import { buildWebhookApp } from '../src/triggers/webhook.js';
import {
  claimActiveRun,
  readActiveRunPointer,
} from '../src/orchestrator/core/run-context.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// ── config.execution mutate/restore-per-case helper ─────────────────────────
// Mirrors test-configurable-test-commands.js's withConfigOverride exactly:
// mutates config.execution[key] for the duration of fn, then restores the
// original value (or deletes the key if it was originally absent) in
// finally — even across an async fn's await points.

function withConfigOverride(key, value, fn) {
  const hadKey = Object.prototype.hasOwnProperty.call(config.execution, key);
  const original = config.execution[key];
  const restore = () => {
    if (hadKey) {
      config.execution[key] = original;
    } else {
      delete config.execution[key];
    }
  };
  config.execution[key] = value;
  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (v) => { restore(); return v; },
      (err) => { restore(); throw err; }
    );
  }
  restore();
  return result;
}

// Snapshot the pre-suite config.execution values so the very last test can
// independently prove every override made in this file was restored.
const ORIGINAL_TEST_COMMAND = config.execution.testCommand;
const ORIGINAL_TEST_ALL_COMMAND = config.execution.testAllCommand;

// ── Shell-command builders ───────────────────────────────────────────────────

const DEFAULT_TEST_COMMAND = 'npm test';
const DEFAULT_TEST_ALL_COMMAND = 'npm run test:all';

const GREEN_CMD = 'node -e "process.exit(0)"';

function redCommand(exitCode) {
  return `node -e "process.exit(${exitCode})"`;
}

/** Writes a marker file relative to cwd (proves whether a command ran). */
function markerCommand(markerName) {
  return `node -e "require('fs').writeFileSync('${markerName}', 'ran')"`;
}

/** Increments a counter file relative to cwd (proves how many times a command ran). */
function counterCommand(fileName) {
  return `node -e "const fs=require('fs'); let n=0; try { n = parseInt(fs.readFileSync('${fileName}','utf8'),10) || 0; } catch (e) {} fs.writeFileSync('${fileName}', String(n+1)); process.exit(0);"`;
}

// Deterministic >2000-char failing output. fs.writeSync(1, ...) (NOT
// process.stdout.write) guarantees the write is flushed synchronously before
// process.exit(1) — process.stdout.write on a piped fd is async, and an
// immediate process.exit() after it would truncate the captured output.
const LONG_OUTPUT_PREFIX = 'X'.repeat(3000);
const LONG_OUTPUT_SUFFIX = 'TAILMARKEREND1234567890';
const FULL_LONG_OUTPUT = LONG_OUTPUT_PREFIX + LONG_OUTPUT_SUFFIX; // length 3024
function longOutputFailCommand() {
  return `node -e "require('fs').writeSync(1, '${FULL_LONG_OUTPUT}'); process.exit(1)"`;
}

// ── Unit-level fixture helpers ───────────────────────────────────────────────

function createFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-gate-unit-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── CLI / webhook helpers ────────────────────────────────────────────────────

const cliPath = path.resolve(__dirname, '../src/cli/index.js');

function spawnCli(args, opts = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env },
    timeout: 15000,
    encoding: 'utf8',
    ...opts,
  });
  assert.ifError(result.error);
  assert.notStrictEqual(
    result.status,
    null,
    `CLI did not exit cleanly for args ${JSON.stringify(args)} (cwd=${opts.cwd})`
  );
  return result;
}

/**
 * Builds a real `git init`-backed fixture with spec.md, .cc-orch.json, and
 * package.json ALL committed (clean working tree) BEFORE the CLI is ever
 * spawned against it — required by gitGuard's dirty-tree check on
 * `run`/`dry-run`, and applied uniformly to every CLI fixture in this file
 * for fixture-discipline consistency.
 */
function createGitFixture({ testCommand, testAllCommand, packageScripts = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-gate-cli-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'baseline-gate-fixture@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Baseline Gate Fixture'], { cwd: dir });

  fs.writeFileSync(
    path.join(dir, 'spec.md'),
    '# Baseline Gate Fixture Spec\n\n## Description\n\nA trivial fixture spec used to drive baseline-gate CLI wiring tests.\n\n## Success Criteria\n\n- [ ] n/a\n',
    'utf8'
  );

  const ccOrchConfig = { execution: {} };
  if (testCommand !== undefined) ccOrchConfig.execution.testCommand = testCommand;
  if (testAllCommand !== undefined) ccOrchConfig.execution.testAllCommand = testAllCommand;
  fs.writeFileSync(path.join(dir, '.cc-orch.json'), JSON.stringify(ccOrchConfig, null, 2), 'utf8');

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'baseline-gate-fixture', version: '1.0.0', private: true, scripts: packageScripts }, null, 2),
    'utf8'
  );

  execFileSync('git', ['add', 'spec.md', '.cc-orch.json', 'package.json'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture: initial commit (spec.md, .cc-orch.json, package.json)'], { cwd: dir });

  return dir;
}

// Distinctive substrings from baseline.js's message text.
const GATE_MARKER = 'Refusing to spend before the baseline is proven green';
// Distinctive substring from pipeline.js's active-run claim-conflict refusal.
const STOPPER_MARKER = 'Refusing to start a new run:';

function createWebhookRoot(prefix = 'baseline-gate-webhook-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeStubCreatePipeline(runImpl) {
  const createPipeline = (root, hooks) => {
    createPipeline.calls.push({ root, hooks });
    return {
      autoFromHere: false,
      run: async (...args) => {
        createPipeline.runCalls.push(args);
        return runImpl(...args);
      },
    };
  };
  createPipeline.calls = [];
  createPipeline.runCalls = [];
  return createPipeline;
}

function postJson(port, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj ?? {});
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error(`Request to ${urlPath} timed out after 5000ms`));
    });
    req.write(data);
    req.end();
  });
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

// ═════════════════════════════════════════════════════════════════════════
// Unit cases — real runBaselineGate over fs.mkdtemp fixture roots
// ═════════════════════════════════════════════════════════════════════════

await test('(a) both commands green -> runBaselineGate returns {ok:true}, both commands actually ran, nothing skipped', async () => {
  const fixture = createFixtureDir();
  try {
    const smokeMarker = 'smoke-ran.marker';
    const fullMarker = 'full-ran.marker';
    await withConfigOverride('testCommand', markerCommand(smokeMarker), () =>
      withConfigOverride('testAllCommand', markerCommand(fullMarker), async () => {
        const result = await runBaselineGate(fixture);
        assert.strictEqual(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
        assert.deepStrictEqual(result.skipped, []);
        assert.ok(fs.existsSync(path.join(fixture, smokeMarker)), 'smoke command must actually have run');
        assert.ok(fs.existsSync(path.join(fixture, fullMarker)), 'full command must actually have run');
      })
    );
  } finally {
    cleanup(fixture);
  }
});

await test('(b) smoke red -> {ok:false} naming the configured testCommand verbatim + its exit code', async () => {
  const fixture = createFixtureDir();
  try {
    const smokeCmd = redCommand(7);
    const fullMarker = 'full-should-not-run-b.marker';
    await withConfigOverride('testCommand', smokeCmd, () =>
      withConfigOverride('testAllCommand', markerCommand(fullMarker), async () => {
        const result = await runBaselineGate(fixture);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.command, smokeCmd, 'command must equal the configured testCommand verbatim');
        assert.strictEqual(result.exitCode, 7);
      })
    );
  } finally {
    cleanup(fixture);
  }
});

await test('(c) smoke green + full red -> {ok:false} naming the configured testAllCommand', async () => {
  const fixture = createFixtureDir();
  try {
    const fullCmd = redCommand(4);
    await withConfigOverride('testCommand', GREEN_CMD, () =>
      withConfigOverride('testAllCommand', fullCmd, async () => {
        const result = await runBaselineGate(fixture);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.command, fullCmd, 'command must equal the configured testAllCommand verbatim');
        assert.strictEqual(result.exitCode, 4);
      })
    );
  } finally {
    cleanup(fixture);
  }
});

await test('(d) failing output >2000 chars -> outputTail is exactly the last 2000 chars', async () => {
  const fixture = createFixtureDir();
  try {
    const cmd = longOutputFailCommand();
    await withConfigOverride('testCommand', cmd, () =>
      withConfigOverride('testAllCommand', GREEN_CMD, async () => {
        const result = await runBaselineGate(fixture);
        assert.strictEqual(result.ok, false);
        const expectedTail = FULL_LONG_OUTPUT.slice(-2000);
        assert.strictEqual(result.outputTail.length, 2000, `outputTail must be exactly 2000 chars, got ${result.outputTail.length}`);
        assert.strictEqual(result.outputTail, expectedTail, 'outputTail must be exactly the last 2000 chars of the command output');
      })
    );
  } finally {
    cleanup(fixture);
  }
});

await test('(e) SHORT-CIRCUIT: smoke red -> the full-suite command is NEVER invoked', async () => {
  const fixture = createFixtureDir();
  try {
    const fullMarker = 'full-suite-should-not-run.marker';
    await withConfigOverride('testCommand', redCommand(3), () =>
      withConfigOverride('testAllCommand', markerCommand(fullMarker), async () => {
        const result = await runBaselineGate(fixture);
        assert.strictEqual(result.ok, false);
        assert.ok(
          !fs.existsSync(path.join(fixture, fullMarker)),
          'the full-suite command must never run when the smoke command is red'
        );
      })
    );
  } finally {
    cleanup(fixture);
  }
});

await test('(e2) IDENTICAL-COMMAND DEDUP: testCommand === testAllCommand -> the command runs exactly ONCE', async () => {
  const fixture = createFixtureDir();
  try {
    const counterFile = 'run-count.txt';
    const cmd = counterCommand(counterFile);
    await withConfigOverride('testCommand', cmd, () =>
      withConfigOverride('testAllCommand', cmd, async () => {
        const result = await runBaselineGate(fixture);
        assert.strictEqual(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
        const content = fs.readFileSync(path.join(fixture, counterFile), 'utf8');
        assert.strictEqual(content, '1', `identical testCommand/testAllCommand must run exactly once, counter=${content}`);
      })
    );
  } finally {
    cleanup(fixture);
  }
});

await test('(e3) SANCTIONED SKIP: default npm commands + a scriptless package.json -> {ok:true} with both skips reported; a configured red command in the same fixture still refuses', async () => {
  const fixture = createFixtureDir();
  try {
    fs.writeFileSync(
      path.join(fixture, 'package.json'),
      JSON.stringify({ name: 'scriptless-fixture', version: '1.0.0', scripts: {} }, null, 2),
      'utf8'
    );

    await withConfigOverride('testCommand', DEFAULT_TEST_COMMAND, () =>
      withConfigOverride('testAllCommand', DEFAULT_TEST_ALL_COMMAND, async () => {
        const result = await runBaselineGate(fixture);
        assert.strictEqual(result.ok, true, `expected ok:true (sanctioned skip), got: ${JSON.stringify(result)}`);
        assert.deepStrictEqual(
          result.skipped,
          [DEFAULT_TEST_COMMAND, DEFAULT_TEST_ALL_COMMAND],
          'both default commands must be reported as skipped'
        );
      })
    );

    // Same scriptless fixture, but a CONFIGURED (non-default) command must
    // never be skipped — it always runs, script or no script.
    const configuredRed = redCommand(9);
    await withConfigOverride('testCommand', configuredRed, () =>
      withConfigOverride('testAllCommand', DEFAULT_TEST_ALL_COMMAND, async () => {
        const result = await runBaselineGate(fixture);
        assert.strictEqual(result.ok, false, `configured non-default red command must never be skipped, got: ${JSON.stringify(result)}`);
        assert.strictEqual(result.command, configuredRed);
        assert.strictEqual(result.exitCode, 9);
      })
    );
  } finally {
    cleanup(fixture);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// (f) CLI wiring — red git fixture: run/dry-run/task/resume --batch all refuse
// ═════════════════════════════════════════════════════════════════════════

await test('(f) red git fixture: `run <spec>` refuses with the gate message, exits non-zero, creates no .harness/', async () => {
  const smokeCmd = redCommand(13);
  const dir = createGitFixture({ testCommand: smokeCmd, testAllCommand: GREEN_CMD });
  try {
    const result = spawnCli(['run', 'spec.md'], { cwd: dir });
    const combined = (result.stdout || '') + (result.stderr || '');
    assert.notStrictEqual(result.status, 0, `expected non-zero exit, got 0. Output: ${combined}`);
    assert.ok(combined.includes(GATE_MARKER), `expected the gate message. Output: ${combined}`);
    assert.ok(combined.includes(smokeCmd), `expected the configured testCommand named verbatim. Output: ${combined}`);
    assert.ok(!fs.existsSync(path.join(dir, '.harness')), 'run must create no .harness/ when the baseline gate refuses');
  } finally {
    cleanup(dir);
  }
});

await test('(f) red git fixture: `dry-run <spec>` refuses with the gate message, exits non-zero, creates no .harness/', async () => {
  const smokeCmd = redCommand(14);
  const dir = createGitFixture({ testCommand: smokeCmd, testAllCommand: GREEN_CMD });
  try {
    const result = spawnCli(['dry-run', 'spec.md'], { cwd: dir });
    const combined = (result.stdout || '') + (result.stderr || '');
    assert.notStrictEqual(result.status, 0, `expected non-zero exit, got 0. Output: ${combined}`);
    assert.ok(combined.includes(GATE_MARKER), `expected the gate message. Output: ${combined}`);
    assert.ok(combined.includes(smokeCmd), `expected the configured testCommand named verbatim. Output: ${combined}`);
    assert.ok(!fs.existsSync(path.join(dir, '.harness')), 'dry-run must create no .harness/ when the baseline gate refuses');
  } finally {
    cleanup(dir);
  }
});

await test('(f) red git fixture: `task "x"` refuses with the gate message, exits non-zero, creates no .harness/', async () => {
  const smokeCmd = redCommand(15);
  const dir = createGitFixture({ testCommand: smokeCmd, testAllCommand: GREEN_CMD });
  try {
    const result = spawnCli(['task', 'a trivial ad-hoc task'], { cwd: dir });
    const combined = (result.stdout || '') + (result.stderr || '');
    assert.notStrictEqual(result.status, 0, `expected non-zero exit, got 0. Output: ${combined}`);
    assert.ok(combined.includes(GATE_MARKER), `expected the gate message. Output: ${combined}`);
    assert.ok(combined.includes(smokeCmd), `expected the configured testCommand named verbatim. Output: ${combined}`);
    assert.ok(!fs.existsSync(path.join(dir, '.harness')), 'task must create no .harness/ when the baseline gate refuses');
  } finally {
    cleanup(dir);
  }
});

await test('(f) red git fixture: `resume --batch` refuses with the gate message, exits non-zero, creates no .harness/', async () => {
  const smokeCmd = redCommand(16);
  const dir = createGitFixture({ testCommand: smokeCmd, testAllCommand: GREEN_CMD });
  try {
    const result = spawnCli(['resume', '--batch'], { cwd: dir });
    const combined = (result.stdout || '') + (result.stderr || '');
    assert.notStrictEqual(result.status, 0, `expected non-zero exit, got 0. Output: ${combined}`);
    assert.ok(combined.includes(GATE_MARKER), `expected the gate message. Output: ${combined}`);
    assert.ok(combined.includes(smokeCmd), `expected the configured testCommand named verbatim. Output: ${combined}`);
    assert.ok(!fs.existsSync(path.join(dir, '.harness')), 'resume --batch must create no .harness/ when the baseline gate refuses');
  } finally {
    cleanup(dir);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// (g) CLI wiring — green git fixture with a deterministic pre-spend stopper
// ═════════════════════════════════════════════════════════════════════════

await test('(g) green git fixture: `run <spec>` does not emit the gate message and stops at the pre-spend active-run claim-conflict stopper (no agent session)', async () => {
  const dir = createGitFixture({ testCommand: GREEN_CMD, testAllCommand: GREEN_CMD });
  try {
    const seeded = claimActiveRun(dir, { runId: 'run-preexisting-green-run-stopper', slug: 'preexisting', kind: 'run' });
    assert.ok(seeded, 'sanity: pre-seeding the active-run pointer must succeed on a fresh fixture');

    const result = spawnCli(['run', 'spec.md'], { cwd: dir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.ok(!combined.includes(GATE_MARKER), `must NOT emit the baseline gate message on a green fixture. Output: ${combined}`);
    assert.ok(combined.includes(STOPPER_MARKER), `must stop at the pre-spend active-run claim-conflict stopper. Output: ${combined}`);
    assert.ok(!combined.includes('Planning: decomposing'), `must never reach planner dispatch (no real agent session). Output: ${combined}`);
  } finally {
    cleanup(dir);
  }
});

await test('(g) green git fixture: `task "x"` does not emit the gate message and stops at the pre-spend active-run claim-conflict stopper (no agent session)', async () => {
  const dir = createGitFixture({ testCommand: GREEN_CMD, testAllCommand: GREEN_CMD });
  try {
    const seeded = claimActiveRun(dir, { runId: 'run-preexisting-green-task-stopper', slug: 'preexisting', kind: 'run' });
    assert.ok(seeded, 'sanity: pre-seeding the active-run pointer must succeed on a fresh fixture');

    const result = spawnCli(['task', 'a trivial ad-hoc task'], { cwd: dir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.ok(!combined.includes(GATE_MARKER), `must NOT emit the baseline gate message on a green fixture. Output: ${combined}`);
    assert.ok(combined.includes(STOPPER_MARKER), `must stop at the pre-spend active-run claim-conflict stopper. Output: ${combined}`);
    assert.ok(!combined.includes('Planning: decomposing'), `must never reach planner dispatch (no real agent session). Output: ${combined}`);
  } finally {
    cleanup(dir);
  }
});

await test('(g) green git fixture: `resume --batch` does not emit the gate message and stops at the empty-queue pre-spend stopper (no agent session)', async () => {
  // NOTE: `dry-run`'s green direction is NOT exercised here with a real CLI
  // spawn. dryRunValidate (pipeline.js) has no active-run-pointer check —
  // unlike run()/task(), it always proceeds straight to a real planner
  // dispatch after a green gate, which would spawn a real agent session.
  // Its green direction is covered ONLY at unit level via case (a) above.
  const dir = createGitFixture({ testCommand: GREEN_CMD, testAllCommand: GREEN_CMD });
  try {
    const result = spawnCli(['resume', '--batch'], { cwd: dir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.ok(!combined.includes(GATE_MARKER), `must NOT emit the baseline gate message on a green fixture. Output: ${combined}`);
    assert.ok(combined.includes('Queue is empty'), `must stop at the empty-queue pre-spend stopper. Output: ${combined}`);
    assert.ok(!combined.includes('Planning: decomposing'), `must never reach planner dispatch (no real agent session). Output: ${combined}`);
  } finally {
    cleanup(dir);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// (h) CLI negative — status and single (non-batch) resume are never gated
// ═════════════════════════════════════════════════════════════════════════

await test('(h) negative: `status` on the red fixture never emits the gate message', async () => {
  const dir = createGitFixture({ testCommand: redCommand(21), testAllCommand: GREEN_CMD });
  try {
    const result = spawnCli(['status'], { cwd: dir });
    const combined = (result.stdout || '') + (result.stderr || '');
    assert.ok(!combined.includes(GATE_MARKER), `status must never emit the baseline gate message. Output: ${combined}`);
  } finally {
    cleanup(dir);
  }
});

await test('(h) negative: single (non-batch) `resume` on the red fixture never emits the gate message', async () => {
  const dir = createGitFixture({ testCommand: redCommand(22), testAllCommand: GREEN_CMD });
  try {
    // Deterministic pre-spend stopper for non-batch resume: an "unresumable"
    // state.json (active + planning phase + zero milestones) makes
    // cli/commands/resume.js exit 76 BEFORE ever calling pipeline.resume() —
    // proving this negative assertion without spawning a real agent session.
    const harnessDir = path.join(dir, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    fs.writeFileSync(
      path.join(harnessDir, 'state.json'),
      JSON.stringify({ globalStatus: 'active', projectMeta: { currentPhase: 'planning' }, milestones: {} }),
      'utf8'
    );

    const result = spawnCli(['resume'], { cwd: dir });
    const combined = (result.stdout || '') + (result.stderr || '');
    assert.ok(!combined.includes(GATE_MARKER), `single resume must never emit the baseline gate message. Output: ${combined}`);
    assert.strictEqual(result.status, 76, `expected the unresumable-state exit code 76. Output: ${combined}`);
  } finally {
    cleanup(dir);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// (i) Webhook — buildWebhookApp injected baselineGate + createPipeline stubs
// ═════════════════════════════════════════════════════════════════════════

await test('(i) webhook: an injected RED-stub baselineGate -> POST /run answers 200, the running entry lands failed carrying the gate message, the claim is cleared, and createPipeline is never called', async () => {
  const root = createWebhookRoot();
  let server;
  try {
    const gateMessage = 'BASELINE_GATE_RED_STUB_MESSAGE';
    const createPipeline = makeStubCreatePipeline(async () => {});
    const baselineGate = async () => ({
      ok: false,
      message: gateMessage,
      command: 'npm test',
      exitCode: 1,
      outputTail: 'simulated red gate output',
    });
    const app = buildWebhookApp({ projectRoot: root, createPipeline, baselineGate });
    server = app.listen(0);
    const port = server.address().port;

    const res = await postJson(port, '/run', { goal: 'red stub run' });
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body && typeof res.body.runId === 'string' && res.body.runId.length > 0);

    let logsRes;
    for (let i = 0; i < 60; i++) {
      logsRes = await getJson(port, `/runs/${res.body.runId}/logs`);
      if (logsRes.body && logsRes.body.status === 'failed') break;
      await wait(25);
    }

    assert.ok(logsRes, 'the /runs/:id/logs endpoint should respond');
    assert.strictEqual(logsRes.body.status, 'failed', `expected status failed, got: ${JSON.stringify(logsRes.body)}`);
    assert.strictEqual(logsRes.body.error, gateMessage, `expected the gate message as the error, got: ${JSON.stringify(logsRes.body)}`);

    assert.strictEqual(createPipeline.calls.length, 0, 'createPipeline must never be constructed when the gate fails');
    assert.strictEqual(createPipeline.runCalls.length, 0, 'stub.run() must never be invoked when the gate fails');

    assert.strictEqual(readActiveRunPointer(root), null, 'the active-run claim must be cleared after a red gate');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await test('(i) webhook: an injected GREEN-stub baselineGate -> POST /run lets createPipeline get invoked', async () => {
  const root = createWebhookRoot();
  let server;
  try {
    const createPipeline = makeStubCreatePipeline(async () => {});
    const baselineGate = async () => ({ ok: true, skipped: [] });
    const app = buildWebhookApp({ projectRoot: root, createPipeline, baselineGate });
    server = app.listen(0);
    const port = server.address().port;

    const res = await postJson(port, '/run', { goal: 'green stub run' });
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);

    for (let i = 0; i < 60 && createPipeline.calls.length === 0; i++) {
      await wait(25);
    }

    assert.strictEqual(createPipeline.calls.length, 1, 'createPipeline should be constructed exactly once once the gate passes');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await test("(i) webhook: buildWebhookApp's baselineGate default parameter is the real runBaselineGate", async () => {
  // Static proof: the function's own source names runBaselineGate as the
  // default value of its baselineGate parameter.
  assert.ok(
    /baselineGate\s*=\s*runBaselineGate/.test(buildWebhookApp.toString()),
    'buildWebhookApp source must default baselineGate to runBaselineGate'
  );

  // Dynamic proof: with NO baselineGate passed, POST /run must actually
  // execute the CONFIGURED commands in projectRoot (a stub or no-op could
  // never do this) before letting createPipeline run.
  const root = createWebhookRoot('baseline-gate-webhook-default-');
  let server;
  try {
    const smokeMarker = 'webhook-default-gate-smoke.marker';
    const fullMarker = 'webhook-default-gate-full.marker';
    const createPipeline = makeStubCreatePipeline(async () => {});

    await withConfigOverride('testCommand', markerCommand(smokeMarker), () =>
      withConfigOverride('testAllCommand', markerCommand(fullMarker), async () => {
        const app = buildWebhookApp({ projectRoot: root, createPipeline }); // baselineGate NOT passed
        server = app.listen(0);
        const port = server.address().port;

        const res = await postJson(port, '/run', { goal: 'default gate run' });
        assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);

        for (let i = 0; i < 80 && createPipeline.calls.length === 0; i++) {
          await wait(25);
        }

        assert.strictEqual(createPipeline.calls.length, 1, 'createPipeline should be invoked once the real default gate passes');
        assert.ok(fs.existsSync(path.join(root, smokeMarker)), 'the real runBaselineGate must have executed the configured smoke command');
        assert.ok(fs.existsSync(path.join(root, fullMarker)), 'the real runBaselineGate must have executed the configured full command');
      })
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Config restoration sanity — proves no override made in this file leaked
// ═════════════════════════════════════════════════════════════════════════

await test('config.execution.testCommand/testAllCommand are byte-identical to their pre-suite values after every case', () => {
  assert.strictEqual(config.execution.testCommand, ORIGINAL_TEST_COMMAND, 'testCommand must be restored');
  assert.strictEqual(config.execution.testAllCommand, ORIGINAL_TEST_ALL_COMMAND, 'testAllCommand must be restored');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
