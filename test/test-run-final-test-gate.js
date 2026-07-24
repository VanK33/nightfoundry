/**
 * test-run-final-test-gate.js — Fix 1: the full-suite test gate must fire on the
 * `cc-orch run()` path, not only inside archive().
 *
 * Contract (Fix 1):
 *   - archive.js exports `runFinalTestGate(projectRoot, flags={}, deps={})`,
 *     extracted byte-identically from archive()'s inline final-test-gate block.
 *   - Pipeline gains a `_runFinalTestGate` injection seam (constructor opt
 *     `runFinalTestGate`) and calls it in run() immediately after _reviewGate,
 *     still inside the try. run() still does NOT archive and does NOT bump.
 *   - A TestGateError thrown by the gate must propagate out of run() (fail-closed).
 *
 * Unit cases (a)(b)(c) exercise runFinalTestGate directly with an injected
 * runFullTestSuite spy. Integration cases (d)(e) drive pipeline.run() to
 * completion modelled on test/test-auto-mode.js.
 *
 * Run: node test/test-run-final-test-gate.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runFinalTestGate, TestGateError } from '../src/cli/commands/archive.js';

const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');
const { bootstrap } = await import('../src/orchestrator/core/bootstrap.js');

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

const tmpDirs = [];
function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function cleanupAll() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
}

/**
 * Write a project dir with a package.json carrying (or omitting) a test:all
 * script. With a test:all script present, the gate is armed.
 */
function makeProjectWithTestAll({ withTestAll = true } = {}) {
  const dir = makeTmpDir('cc-orch-run-gate-');
  const pkg = {
    name: 'tmp-target',
    scripts: withTestAll ? { 'test:all': 'node scripts/run-tests.js' } : {},
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
  return dir;
}

// ── (a) runFinalTestGate throws TestGateError when the suite exits non-zero ────

await test('Fix1-a: runFinalTestGate throws TestGateError when test:all exits non-zero', async () => {
  const dir = makeProjectWithTestAll({ withTestAll: true });

  let called = false;
  const spy = () => { called = true; return { exitCode: 1, output: 'X\nFAIL' }; };

  let threw = null;
  try {
    runFinalTestGate(dir, {}, { runFullTestSuite: spy });
  } catch (err) {
    threw = err;
  }

  assert.ok(called, 'Expected runFinalTestGate to invoke the injected runFullTestSuite');
  assert.ok(threw, 'Expected runFinalTestGate to throw on a non-zero exit code');
  assert.ok(
    threw instanceof TestGateError,
    `Expected a TestGateError, got: ${threw && threw.constructor && threw.constructor.name}`
  );
  assert.ok(
    /Final test gate failed/.test(threw.message),
    `Expected "Final test gate failed" in the message, got: ${threw.message}`
  );
});

// ── (b) no-op when no test:all script (default command + no script) ───────────

await test('Fix1-b: runFinalTestGate is a no-op when target has no test:all script', async () => {
  const dir = makeProjectWithTestAll({ withTestAll: false });

  let called = false;
  const spy = () => { called = true; return { exitCode: 0, output: '' }; };

  let result;
  let threw = null;
  try {
    result = runFinalTestGate(dir, {}, { runFullTestSuite: spy });
  } catch (err) {
    threw = err;
  }

  assert.strictEqual(threw, null, `Expected no throw when no test:all script, got: ${threw && threw.message}`);
  assert.strictEqual(called, false, 'runFullTestSuite must NOT be called when there is no test:all script');
  assert.strictEqual(result, undefined, 'runFinalTestGate should return undefined');
});

// ── (c) no-op under include-failed and under skip-test-gate ───────────────────

await test('Fix1-c1: runFinalTestGate is a no-op under flags[include-failed]', async () => {
  const dir = makeProjectWithTestAll({ withTestAll: true });

  let called = false;
  const spy = () => { called = true; return { exitCode: 1, output: 'FAIL' }; };

  let threw = null;
  try {
    runFinalTestGate(dir, { 'include-failed': true }, { runFullTestSuite: spy });
  } catch (err) {
    threw = err;
  }

  assert.strictEqual(threw, null, `Expected no throw under include-failed, got: ${threw && threw.message}`);
  assert.strictEqual(called, false, 'runFullTestSuite must NOT be called under include-failed');
});

await test('Fix1-c2: runFinalTestGate is a no-op under flags[skip-test-gate]', async () => {
  const dir = makeProjectWithTestAll({ withTestAll: true });

  let called = false;
  const spy = () => { called = true; return { exitCode: 1, output: 'FAIL' }; };

  let threw = null;
  try {
    runFinalTestGate(dir, { 'skip-test-gate': true }, { runFullTestSuite: spy });
  } catch (err) {
    threw = err;
  }

  assert.strictEqual(threw, null, `Expected no throw under skip-test-gate, got: ${threw && threw.message}`);
  assert.strictEqual(called, false, 'runFullTestSuite must NOT be called under skip-test-gate');
});

// ── Integration helpers (modelled on test/test-auto-mode.js) ──────────────────

function makeGlobalPlanWithAssumption() {
  return {
    milestones: [
      {
        id: '001',
        description: 'Test milestone',
        missions: [{ id: '001-001', description: 'Test mission' }],
      },
    ],
    assumptions: [
      { text: 'Test assumption: project is a Node.js app' },
    ],
  };
}

/**
 * Build a Pipeline whose run() reaches _reviewGate (and therefore the new
 * _runFinalTestGate call right after it) without doing any real work.
 * Returns { tmpDir, pipeline, cleanup }. `opts` is forwarded to the
 * Pipeline constructor (used to inject runFinalTestGate / archive spies).
 */
function makeRunnablePipeline(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-run-final-gate-'));
  bootstrap(tmpDir, {});

  const pipeline = new Pipeline(tmpDir, {
    onLog: () => {},
    onConfirm: async () => true,
    ...opts,
  });

  // Stub external side-effects so only the run()→gate path is exercised.
  pipeline._runPreflight = () => {};
  pipeline._checkOverwriteProtection = () => {};
  pipeline.planner.planGlobal = async () => makeGlobalPlanWithAssumption();
  pipeline.planner.closeReusableSession = async () => {};
  // Assumptions remediation "passes" so run() proceeds past the assumption gate.
  pipeline._remediateAssumptions = async () => ({ passed: true });
  // Skip real milestone execution.
  pipeline._executeAllMilestones = async () => {};
  // Review gate accepts silently (no onMenu needed).
  pipeline._reviewGate = async () => {};

  return {
    tmpDir,
    pipeline,
    cleanup: () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

// ── (d) run()-path integration: gate runs once, archive is NOT called ─────────

await test('Fix1-d: run() invokes _runFinalTestGate once with projectRoot and does NOT archive', async () => {
  let gateCalls = [];
  const gateSpy = (...args) => { gateCalls.push(args); };

  let archiveCalled = false;
  const archiveSpy = async () => { archiveCalled = true; return '/tmp/should-not-happen'; };

  const { pipeline, cleanup } = makeRunnablePipeline({
    runFinalTestGate: gateSpy,
    archive: archiveSpy,
  });

  try {
    await pipeline.run('Test goal', { auto: true });

    assert.strictEqual(
      gateCalls.length, 1,
      `Expected _runFinalTestGate to be called exactly once, got ${gateCalls.length}`
    );
    assert.strictEqual(
      gateCalls[0][0], pipeline.projectRoot,
      `Expected the gate to be called with this.projectRoot (${pipeline.projectRoot}), got: ${gateCalls[0][0]}`
    );
    assert.strictEqual(
      archiveCalled, false,
      'run() must NOT archive — only the gate is added on the run() path'
    );
  } finally {
    cleanup();
  }
});

// ── (e) run() propagates a gate error (fail-closed) ───────────────────────────

await test('Fix1-e: run() rejects when _runFinalTestGate throws (fail-closed)', async () => {
  const boomGate = () => { throw new TestGateError('boom'); };

  const { pipeline, cleanup } = makeRunnablePipeline({
    runFinalTestGate: boomGate,
  });

  try {
    let caught = null;
    try {
      await pipeline.run('Test goal', { auto: true });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'Expected run() to reject when the final test gate throws');
    assert.ok(
      caught instanceof TestGateError,
      `Expected the propagated error to be a TestGateError, got: ${caught && caught.constructor && caught.constructor.name}`
    );
    assert.strictEqual(
      caught.message, 'boom',
      `Expected the gate's error to propagate unchanged, got: ${caught && caught.message}`
    );
  } finally {
    cleanup();
  }
});

// ── Teardown & report ─────────────────────────────────────────────────────────

cleanupAll();

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
