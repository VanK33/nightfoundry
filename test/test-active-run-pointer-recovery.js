/**
 * test-active-run-pointer-recovery.js — Unit test for resume.js's
 * pointer-scoped auto-clear on the interactive (non-batch) leg: when
 * state.json for the currently-held active-run pointer is in the
 * planning-crashed shape (isUnresumableState), resume() must clear the
 * stranded pointer, name the pointer path and the held runId in its stderr
 * recovery message (without any 'verifyAssumptions escalation' speculation),
 * and exit(76) — leaving the pointer slot free for a subsequent claim.
 *
 * TC roster:
 *   TC1 — resume-side auto-clear: using a writePlanningCrashedRun() fixture,
 *         drive resume(root, {batch:false, auto:true}) and assert (all in
 *         one test(), each corresponding to a bullet in the task spec):
 *     (a) the active-run pointer file no longer exists on disk
 *     (b) captured stderr contains activeRunPointerPath(root) and the
 *         runId the pointer held
 *     (c) captured stderr does NOT contain 'verifyAssumptions escalation'
 *     (d) captured process.exit codes include 76
 *     (e) a subsequent claimActiveRun(root, {runId: <fresh id>, slug,
 *         kind:'run'}) returns true
 *   TC2-TC5 — the same assertions as TC1(b)-(e), enumerated separately in
 *         verify.json but implemented as part of the single TC1 test() above.
 *   TC6 — structural: every fixture root is an isolated fs.mkdtempSync()
 *         directory under os.tmpdir(), removed in a finally block
 *         (createRoot/cleanup below; see TC1's try/finally).
 *   TC7 — structural: `delete process.env.CC_ORCH_ACTIVE_RUN;` is the first
 *         executable statement in this file (see below).
 *   TC8 — structural: running this file directly exits non-zero when any
 *         case fails (see the Summary section) and opens no Claude SDK
 *         session (Pipeline.prototype.batchResume is stubbed to throw if
 *         reached; the interactive leg under test never reaches a real
 *         planner/session at all).
 *
 * No real Claude SDK session is created anywhere in this file: the
 * interactive resume leg exits via process.exit(76) before Pipeline.resume()
 * is ever invoked, and Pipeline.prototype.batchResume is stubbed to throw if
 * reached (it must not be, since flags.batch is false).
 *
 * Two further test() blocks below (also literally named "TC2" and "TC3",
 * distinct from the TC2-TC8 documentation bullets above, which describe
 * sub-assertions of the single TC1 resume-side test) exercise Pipeline.run()
 * itself, via the same fully-stubbed makeRunnablePipeline() seam used by
 * test-pipeline-repoint.js / test-preclaimed-run.js, so no Claude SDK session
 * is opened there either:
 *   TC2 — planning-window failure: planner.planGlobal throws a distinctive
 *         sentinel before any milestone is ever committed to state.json
 *         (bootstrap's freshly-written state.json still has milestones:{}).
 *         Asserts the sentinel (same instance, same message) propagates out
 *         of run() to the caller, and that no active-run pointer file
 *         remains afterward (readActiveRunPointer(root) === null and
 *         fs.existsSync(activeRunPointerPath(root)) === false).
 *   TC3 — pre-bootstrap-window failure: a leg running after the pointer
 *         claim but before any milestone exists (_runPreflight, stubbed to
 *         throw) throws a distinctive sentinel. Asserts the same
 *         propagation + no-stranded-pointer outcome as TC2, proving the
 *         release does not depend on a readable state.json.
 *
 * Clear CC_ORCH_ACTIVE_RUN unconditionally at module top (mirrors
 * scripts/run-tests.js, test-batch-resume.js, test-preclaimed-run.js) so this
 * suite is re-entrancy-neutral regardless of launch context.
 *
 * Run: node test/test-active-run-pointer-recovery.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { resume } from '../src/cli/commands/resume.js';
import {
  generateRunId,
  runHarnessDir,
  harnessRoot,
  claimActiveRun,
  activeRunPointerPath,
  readActiveRunPointer,
  clearActiveRunPointer,
} from '../src/orchestrator/core/run-context.js';

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

// ---------- Fixture helpers ----------

function createRoot(prefix = 'active-run-pointer-recovery-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── captureOutput (async) ─────────────────────────────────────────────────
// Captures process.stdout.write / process.stderr.write around an async call
// and restores both in a finally, regardless of whether fn throws.

async function captureOutput(fn) {
  const outChunks = [];
  const errChunks = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);

  process.stdout.write = (chunk) => {
    outChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk) => {
    errChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => outChunks.push(args.join(' ') + '\n');
  console.error = (...args) => errChunks.push(args.join(' ') + '\n');

  let thrownError = null;
  try {
    await fn();
  } catch (err) {
    thrownError = err;
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
  }
  return { stdout: outChunks.join(''), stderr: errChunks.join(''), thrownError };
}

// ── writePlanningCrashedRun ─────────────────────────────────────────────────
// Claims the active-run pointer for a freshly-generated runId, bootstraps a
// per-run harness dir under it, and writes a state.json in the exact
// planning-crashed shape isUnresumableState() recognizes: globalStatus
// 'active', projectMeta.currentPhase 'planning', and an empty milestones map.

function writePlanningCrashedRun(root, slug) {
  const runId = generateRunId(slug);
  const claimed = claimActiveRun(root, { runId, slug, kind: 'run' });
  assert.ok(claimed, `sanity: claimActiveRun should succeed for a fresh root (slug=${slug})`);

  const harnessDir = runHarnessDir(root, runId);
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      globalStatus: 'active',
      projectMeta: { currentPhase: 'planning' },
      milestones: {},
    }),
  );

  return { runId, harnessDir };
}

// ── TC1 ──────────────────────────────────────────────────────────────────
// resume-side auto-clear: a planning-crashed fixture with a stranded active-
// run pointer must have that pointer cleared by the interactive (non-batch)
// resume leg, with stderr naming the pointer path and held runId (no
// 'verifyAssumptions escalation' speculation), exit(76), and the pointer
// slot free for a subsequent claim.

await test('TC1 — resume-side auto-clear: stranded pointer on a planning-crashed run is cleared, stderr names the pointer path + runId, exit(76), pointer slot free afterward', async () => {
  const root = createRoot();
  const origExit = process.exit;
  const origBatchResume = Pipeline.prototype.batchResume;
  try {
    const slug = 'pointer-recovery-tc1';
    const { runId } = writePlanningCrashedRun(root, slug);
    const pointerPath = activeRunPointerPath(root);
    assert.ok(fs.existsSync(pointerPath), 'sanity: pointer file should exist before resume() runs');

    // batch:false → the interactive leg's isUnresumableState guard fires and
    // exits before any pipeline work; batchResume must never be reached.
    Pipeline.prototype.batchResume = async function patchedBatchResume() {
      throw new Error('batchResume reached — should not happen for interactive resume of an unresumable state');
    };

    const capturedExitCodes = [];
    const sentinel = new Error('__SENTINEL_EXIT__');
    process.exit = (code) => {
      capturedExitCodes.push(code);
      throw sentinel;
    };

    const { stderr } = await captureOutput(async () => {
      await resume(root, { batch: false, auto: true });
    });

    // (1) The active-run pointer file no longer exists on disk.
    assert.ok(
      !fs.existsSync(pointerPath),
      `Expected the active-run pointer file at ${pointerPath} to be removed after resume(). It still exists.`,
    );

    // (2) stderr contains the pointer path and the runId the pointer held.
    assert.ok(
      stderr.includes(pointerPath),
      `Expected stderr to contain the pointer path ${pointerPath}. Got:\n${stderr}`,
    );
    assert.ok(
      stderr.includes(runId),
      `Expected stderr to contain the held runId ${runId}. Got:\n${stderr}`,
    );

    // (3) stderr does NOT contain 'verifyAssumptions escalation'.
    assert.ok(
      !stderr.includes('verifyAssumptions escalation'),
      `Expected stderr NOT to contain 'verifyAssumptions escalation'. Got:\n${stderr}`,
    );

    // (4) captured process.exit codes include 76.
    assert.ok(
      capturedExitCodes.includes(76),
      `Expected process.exit(76) to be called. Got exit codes: [${capturedExitCodes.join(', ')}]`,
    );

    // (5) a subsequent claimActiveRun on the same root returns true.
    const freshRunId = generateRunId(slug);
    const reclaimed = claimActiveRun(root, { runId: freshRunId, slug, kind: 'run' });
    assert.strictEqual(
      reclaimed,
      true,
      'Expected claimActiveRun to succeed on the same root after the stranded pointer was cleared',
    );
  } finally {
    process.exit = origExit;
    Pipeline.prototype.batchResume = origBatchResume;
    cleanup(root);
  }
});

// ── run()-side fixtures (TC2, TC3) ──────────────────────────────────────
// Mirrors test-pipeline-repoint.js's / test-preclaimed-run.js's
// makeRunnablePipeline: every agent/gate seam Pipeline.run() would otherwise
// use to open a Claude SDK session is stubbed, so TC2/TC3 can drive run()
// itself and swap in one throwing sentinel each.

function cannedGlobalPlan() {
  return {
    milestones: [
      { id: '001', description: 'Test milestone', missions: [{ id: '001-001', description: 'Test mission' }] },
    ],
    assumptions: [],
    scopeItems: [],
    scopeMapping: [],
  };
}

function makeRunnablePipeline(projectRoot, extraOpts = {}) {
  const pipeline = new Pipeline(projectRoot, {
    onLog: () => {},
    onConfirm: async () => true,
    ...extraOpts,
  });
  pipeline._runPreflight = () => {};
  pipeline.planner.planGlobal = async () => cannedGlobalPlan();
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._remediateAssumptions = async () => ({ passed: true });
  pipeline._scopeCoverageGate = async () => {};
  pipeline._detectUncheckableSpec = () => {};
  pipeline._executeAllMilestones = async () => {};
  pipeline._reviewGate = async () => {};
  pipeline._runFinalTestGate = () => {};
  return pipeline;
}

// ── TC2 ──────────────────────────────────────────────────────────────────
// Planning-window failure: planner.planGlobal throws a distinctive sentinel
// before any milestone is ever committed to state.json (bootstrap's
// freshly-written state.json still has milestones: {}). The pointer claimed
// by THIS invocation of run() must be released, and the sentinel must
// propagate unchanged to the caller.

await test('TC2 — planning-window failure (planGlobal throws): sentinel propagates to the caller and no active-run pointer remains', async () => {
  const root = createRoot();
  try {
    assert.strictEqual(readActiveRunPointer(root), null, 'sanity: fresh root should have no active-run pointer');

    const pipeline = makeRunnablePipeline(root);
    const sentinel = new Error('__TC2_PLANGLOBAL_SENTINEL__');
    pipeline.planner.planGlobal = async () => { throw sentinel; };

    let thrown = null;
    try {
      await pipeline.run('Build TC2 goal', { auto: true });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'run() must propagate the sentinel error thrown by planGlobal');
    assert.strictEqual(thrown, sentinel, 'the propagated error must be the exact same sentinel instance');
    assert.strictEqual(thrown.message, sentinel.message, 'the propagated error message must be unchanged');

    assert.strictEqual(
      readActiveRunPointer(root),
      null,
      'readActiveRunPointer(root) must return null after the planning-window failure',
    );
    assert.strictEqual(
      fs.existsSync(activeRunPointerPath(root)),
      false,
      'the active-run pointer file must not exist after the planning-window failure',
    );
  } finally {
    cleanup(root);
  }
});

// ── TC3 ──────────────────────────────────────────────────────────────────
// Pre-bootstrap-window failure: a leg running after the pointer claim but
// before any milestone exists (_runPreflight, stubbed to throw here in
// place of its default no-op) throws a distinctive sentinel. Proves the
// release does not depend on a readable state.json: the same
// zero-milestone-count release logic fires regardless of which pre-planGlobal
// leg throws.

await test('TC3 — pre-bootstrap-window failure (leg after claim, before planGlobal): sentinel propagates to the caller and no active-run pointer remains', async () => {
  const root = createRoot();
  try {
    assert.strictEqual(readActiveRunPointer(root), null, 'sanity: fresh root should have no active-run pointer');

    const pipeline = makeRunnablePipeline(root);
    const sentinel = new Error('__TC3_PREBOOTSTRAP_SENTINEL__');
    pipeline._runPreflight = () => { throw sentinel; };

    let thrown = null;
    try {
      await pipeline.run('Build TC3 goal', { auto: true });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'run() must propagate the sentinel error thrown before planGlobal is ever reached');
    assert.strictEqual(thrown, sentinel, 'the propagated error must be the exact same sentinel instance');
    assert.strictEqual(thrown.message, sentinel.message, 'the propagated error message must be unchanged');

    assert.strictEqual(
      readActiveRunPointer(root),
      null,
      'readActiveRunPointer(root) must return null after the pre-bootstrap-window failure',
    );
    assert.strictEqual(
      fs.existsSync(activeRunPointerPath(root)),
      false,
      'the active-run pointer file must not exist after the pre-bootstrap-window failure',
    );
  } finally {
    cleanup(root);
  }
});

// ── TC4 ──────────────────────────────────────────────────────────────────
// Claim-failed safety pin: when run() is invoked against a root whose
// active-run pointer is ALREADY held by a foreign run (crashed-shape or
// healthy), claimActiveRun is refused and run() must (a) leave the pointer
// file's raw on-disk bytes completely untouched — a byte-for-byte identity
// check via fs.readFileSync (Buffer) before/after the attempt, not just a
// parsed-JSON equivalence check — and (b) surface the refusal through the
// pipeline's onLog collector with guidance naming both `cc-orch resume` and
// `cc-orch clean` as the next steps. Run as a table over two pre-existing
// pointer fixtures: one in the crashed/planning shape (zero milestones) and
// one healthy (≥1 milestone key, still resumable — not all done).

const tc4Fixtures = [
  {
    label: 'crashed-shape pre-existing pointer (planning, zero milestones)',
    slug: 'pointer-recovery-tc4-crashed',
    writeState: (harnessDir) => {
      fs.writeFileSync(
        path.join(harnessDir, 'state.json'),
        JSON.stringify({
          globalStatus: 'active',
          projectMeta: { currentPhase: 'planning' },
          milestones: {},
        }),
      );
    },
  },
  {
    label: 'healthy pre-existing pointer (≥1 milestone key, still resumable)',
    slug: 'pointer-recovery-tc4-healthy',
    writeState: (harnessDir) => {
      fs.writeFileSync(
        path.join(harnessDir, 'state.json'),
        JSON.stringify({
          globalStatus: 'active',
          projectMeta: { currentPhase: 'execution' },
          milestones: {
            '001': {
              id: '001',
              description: 'Test milestone',
              status: 'in_progress',
              missions: {},
            },
          },
        }),
      );
    },
  },
];

for (const fixture of tc4Fixtures) {
  await test(
    `TC4 — claim-failed safety pin: refused claim leaves the pointer file's raw bytes untouched and names cc-orch resume/clean (${fixture.label})`,
    async () => {
      const root = createRoot();
      try {
        const runId = generateRunId(fixture.slug);
        const claimed = claimActiveRun(root, { runId, slug: fixture.slug, kind: 'run' });
        assert.ok(claimed, `sanity: claimActiveRun should succeed for a fresh root (slug=${fixture.slug})`);

        const harnessDir = runHarnessDir(root, runId);
        fs.mkdirSync(harnessDir, { recursive: true });
        fixture.writeState(harnessDir);

        const pointerPath = activeRunPointerPath(root);
        assert.ok(fs.existsSync(pointerPath), 'sanity: pointer file should exist before the second run() attempt');

        // Raw bytes of the pointer file BEFORE invoking a second run() against
        // the same root — captured as a Buffer, not a parsed/decoded value.
        const bytesBefore = fs.readFileSync(pointerPath);
        assert.ok(Buffer.isBuffer(bytesBefore), 'sanity: fs.readFileSync without an encoding must yield a Buffer');

        const logs = [];
        const pipeline = makeRunnablePipeline(root, { onLog: (line) => logs.push(line) });

        // claimActiveRun is refused (the pointer is already held by `runId`
        // above); run() must resolve without throwing for both fixture
        // shapes here (neither is fully-complete nor all-milestones-done).
        await pipeline.run('Build TC4 goal', { auto: true });

        // Raw bytes of the pointer file AFTER the refused attempt — must be
        // byte-identical to the bytes captured before it.
        const bytesAfter = fs.readFileSync(pointerPath);
        assert.ok(Buffer.isBuffer(bytesAfter), 'sanity: fs.readFileSync without an encoding must yield a Buffer');
        assert.ok(
          bytesBefore.equals(bytesAfter),
          `Expected the active-run pointer file's raw bytes to be byte-identical before and after a refused ` +
          `claim attempt (${fixture.label}). Before: ${bytesBefore.toString('utf8')}\nAfter: ${bytesAfter.toString('utf8')}`,
        );

        const combinedLog = logs.join('\n');
        assert.ok(
          /(cc-orch|nightfoundry) resume/.test(combinedLog),
          `Expected the refusal captured via onLog to name the resume command. Got:\n${combinedLog}`,
        );
        assert.ok(
          /(cc-orch|nightfoundry) clean/.test(combinedLog),
          `Expected the refusal captured via onLog to name the clean command. Got:\n${combinedLog}`,
        );
      } finally {
        cleanup(root);
      }
    },
  );
}

// ── TC5 ──────────────────────────────────────────────────────────────────
// Zero-byte-pointer guard: a hand-written zero-byte pointer file (simulating
// the on-disk artifact a claimActiveRun write-failure would have left before
// its own best-effort cleanup, or any other zero-byte corruption) must read
// back as null via readActiveRunPointer, must BLOCK a subsequent
// claimActiveRun (the O_EXCL open sees the file already exists and refuses
// rather than silently overwriting it), and — once clearActiveRunPointer
// removes it — must allow a fresh claimActiveRun to succeed, proving the
// claim slot is recoverable rather than permanently poisoned.

await test('TC5 — zero-byte-pointer guard: reads as null, blocks claimActiveRun, recoverable via clearActiveRunPointer', async () => {
  const root = createRoot();
  try {
    const pointerPath = activeRunPointerPath(root);

    // Ensure the parent harnessRoot directory exists, then hand-write a
    // zero-byte file at the pointer path.
    fs.mkdirSync(harnessRoot(root), { recursive: true });
    fs.writeFileSync(pointerPath, Buffer.alloc(0));
    assert.strictEqual(
      fs.statSync(pointerPath).size,
      0,
      'sanity: hand-written pointer file must be zero bytes',
    );

    // (1) readActiveRunPointer(root) returns null for a zero-byte pointer.
    assert.strictEqual(
      readActiveRunPointer(root),
      null,
      'Expected readActiveRunPointer(root) to return null when the pointer file is zero bytes',
    );

    // (2) claimActiveRun returns false while the zero-byte pointer file is
    // present — the O_EXCL claim is blocked, not silently overwritten.
    const slug = 'pointer-recovery-tc5';
    const blockedRunId = generateRunId(slug);
    const blockedClaim = claimActiveRun(root, { runId: blockedRunId, slug, kind: 'run' });
    assert.strictEqual(
      blockedClaim,
      false,
      'Expected claimActiveRun to return false while a zero-byte pointer file is present',
    );
    assert.strictEqual(
      fs.statSync(pointerPath).size,
      0,
      'sanity: the zero-byte pointer file must remain zero bytes (not overwritten) after the blocked claim',
    );

    // (3) after clearActiveRunPointer(root) removes it, a fresh claimActiveRun
    // on the same root returns true.
    clearActiveRunPointer(root);
    assert.strictEqual(
      fs.existsSync(pointerPath),
      false,
      'sanity: pointer file must be gone after clearActiveRunPointer(root)',
    );

    const freshRunId = generateRunId(slug);
    const freshClaim = claimActiveRun(root, { runId: freshRunId, slug, kind: 'run' });
    assert.strictEqual(
      freshClaim,
      true,
      'Expected claimActiveRun to return true after clearActiveRunPointer removed the zero-byte pointer',
    );

    // (4) readActiveRunPointer(root) returns an object whose runId equals the
    // newly claimed runId.
    const pointer = readActiveRunPointer(root);
    assert.ok(pointer && typeof pointer === 'object', 'Expected readActiveRunPointer(root) to return an object');
    assert.strictEqual(
      pointer.runId,
      freshRunId,
      `Expected readActiveRunPointer(root).runId to equal the newly claimed runId ${freshRunId}, got ${pointer && pointer.runId}`,
    );
  } finally {
    cleanup(root);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
