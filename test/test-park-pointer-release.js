#!/usr/bin/env node
/**
 * Mirrors the module-top marker-discipline guard used by
 * test/helpers/make-run.js / test/test-disposition-residue-hygiene.js: these
 * fixtures bootstrap and claim REAL active-run pointers against isolated
 * fs.mkdtemp() fixture roots, not a re-entrant cc-orch invocation. If this
 * file is launched from inside a live cc-orch run, CC_ORCH_ACTIVE_RUN is
 * inherited from the parent process environment and would trip
 * assertNoReentrantLiveRun's guard against a fixture root that carries an
 * active state.json — a false positive on the sanctioned mkdtemp pattern
 * (see reentrancy-guard.js). Clear the marker unconditionally here, before
 * any process.env-sensitive imports, so this file is re-entrancy-neutral
 * regardless of launch context.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

/**
 * test-park-pointer-release.js — targeted regression pins for the
 * active-run pointer release inside parkResolve (src/cli/commands/park.js):
 * every resolve verb settles the parked run, so the active-run pointer must
 * be cleared too — but strictly only when it still names THIS run's runId
 * (never clobber a pointer some other run has since claimed).
 *
 * Drives the REAL parkResolve against fs.mkdtemp() fixture roots built with
 * the real makeRun helper (real bootstrap + real claimActiveRun), and reads
 * the pointer back with the real run-context.js accessors.
 *
 * Covers:
 *   TC1 — a singlePath (single-run halt-aftermath shaped) park scene whose
 *         runId equals the claimed pointer's runId: after parkResolve, the
 *         pointer file is gone and the queue entry's status is 'pending'.
 *   TC2 — a batch-parked scene (no singlePath flag — the ordinary
 *         _parkEntry shape) whose runId equals the claimed pointer's runId:
 *         after parkResolve, the pointer file is gone.
 *   TC3 — a scene whose runId differs from the claimed pointer's runId:
 *         after parkResolve, the pointer file still exists and still names
 *         the original (different) runId — untouched.
 *   TC4 — release precedes run-directory removal: with the pointer claimed
 *         for runId R and runHarnessDir(root, R) present on disk, after
 *         parkResolve on a scene carrying runId R BOTH the pointer file and
 *         runHarnessDir(root, R) are gone — the removal is pointer-guarded
 *         (removeParkedRunHarnessDir skips while the pointer still names the
 *         run), so the directory can only be absent when the pointer release
 *         ran first.
 *   TC5 — a throwing pointer release still writes the park scene: with the
 *         pointer removal forced to throw, parkResolve does not set
 *         process.exitCode to 1, queue/<slug>/park.json carries a non-null
 *         resolution whose action matches the resolve verb, and the queue
 *         entry's status is 'pending' — the fail-soft posture around the
 *         pointer release must never undo the scene write + status flip
 *         already committed.
 *   TC6 — the `clean --runs` case (clean(root, { runs: true, force: true })),
 *         which drives the real reapOrphanRunDirs pass (src/cli/commands/
 *         clean.js) over a fixture root, with the orphaned-active-run-pointer
 *         decision made PURELY from filesystem fact — never from state.json
 *         shape:
 *           TC6a — a pointer naming a runId with NO corresponding
 *                  runHarnessDir(root, runId) on disk is removed by the pass
 *                  (activeRunPointerPath(root) no longer exists afterward).
 *           TC6b — a pointer naming a runId whose runHarnessDir(root, runId)
 *                  DOES exist on disk survives the pass: the pointer file
 *                  still exists and readActiveRunPointer(root).runId still
 *                  equals that runId.
 *
 * Run: node test/test-park-pointer-release.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  readQueueEntry,
  writeParkScene,
  writeQueueEntry,
} from '../src/orchestrator/core/state.js';
import { parkResolve } from '../src/cli/commands/park.js';
import { clean } from '../src/cli/commands/clean.js';
import {
  activeRunPointerPath,
  readActiveRunPointer,
  runHarnessDir,
  generateRunId,
  claimActiveRun,
} from '../src/orchestrator/core/run-context.js';
import { makeRun } from './helpers/make-run.js';

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

/** Create a temporary project root directory. */
function makeTmpRoot(prefix = 'cc-orch-park-ptr-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Recursively remove a temp root (best-effort). */
function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Write a minimal parked queue entry under {root}/queue/{slug}/. */
function createParkedQueueEntry(root, slug) {
  writeQueueEntry(root, slug, {
    spec: `# Spec for ${slug}\n\nDefault spec content.`,
    plan: { milestones: [], assumptions: [] },
    validatedAt: new Date().toISOString(),
    status: 'parked',
  });
}

/** Run parkResolve with --waive, saving/restoring process.exitCode. */
function resolveWithWaive(root, slug) {
  const prevExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    parkResolve(root, slug, { waive: true });
  } finally {
    assert.notStrictEqual(process.exitCode, 1, 'parkResolve must succeed (exitCode must not be 1)');
    process.exitCode = prevExitCode;
  }
}

// ── TC1 ──────────────────────────────────────────────────────────────────
// singlePath scene whose runId equals the pointer's — pointer released.

await test('TC1: singlePath resolve releases the pointer', async () => {
  const root = makeTmpRoot('cc-orch-park-ptr-tc1-');
  try {
    const slug = 'park-ptr-tc1-slug';
    const { runId } = makeRun(root, { slug: 'park-ptr-tc1-run', kind: 'run', claim: true });

    createParkedQueueEntry(root, slug);
    writeParkScene(root, slug, {
      site: 'tc1-single-path',
      parkedAt: new Date().toISOString(),
      runId,
      singlePath: true,
      stashRef: null,
      previousResolutions: [],
      resolution: null,
    });

    assert.ok(
      fs.existsSync(activeRunPointerPath(root)),
      'TC1: fixture — the active-run pointer file must exist before resolve',
    );

    resolveWithWaive(root, slug);

    assert.ok(
      !fs.existsSync(activeRunPointerPath(root)),
      'TC1: the active-run pointer file must be gone after parkResolve',
    );
    const entry = readQueueEntry(root, slug);
    assert.strictEqual(
      entry.status,
      'pending',
      `TC1: --waive resolves to status 'pending', got '${entry.status}'`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC2 ──────────────────────────────────────────────────────────────────
// batch-parked scene (no singlePath) whose runId equals the pointer's —
// pointer released.

await test('TC2: batch-parked resolve releases the pointer', async () => {
  const root = makeTmpRoot('cc-orch-park-ptr-tc2-');
  try {
    const slug = 'park-ptr-tc2-slug';
    const { runId } = makeRun(root, { slug: 'park-ptr-tc2-run', kind: 'batch', claim: true });

    createParkedQueueEntry(root, slug);
    writeParkScene(root, slug, {
      site: 'tc2-batch-parked',
      parkedAt: new Date().toISOString(),
      runId,
      // no `singlePath` field — the ordinary _parkEntry / batch-parked shape.
      previousResolutions: [],
      resolution: null,
    });

    assert.ok(
      fs.existsSync(activeRunPointerPath(root)),
      'TC2: fixture — the active-run pointer file must exist before resolve',
    );

    resolveWithWaive(root, slug);

    assert.ok(
      !fs.existsSync(activeRunPointerPath(root)),
      'TC2: the active-run pointer file must be gone after parkResolve',
    );
  } finally {
    cleanup(root);
  }
});

// ── TC3 ──────────────────────────────────────────────────────────────────
// scene runId differs from the pointer's runId — pointer left untouched.

await test('TC3: a pointer naming a different run is left untouched', async () => {
  const root = makeTmpRoot('cc-orch-park-ptr-tc3-');
  try {
    const slug = 'park-ptr-tc3-slug';
    const { runId: otherRunId } = makeRun(root, { slug: 'park-ptr-tc3-other-run', kind: 'run', claim: true });

    createParkedQueueEntry(root, slug);
    writeParkScene(root, slug, {
      site: 'tc3-different-run',
      parkedAt: new Date().toISOString(),
      // A different runId than the claimed pointer's — deliberately not
      // otherRunId, so the pointer-equality guard in parkResolve must skip
      // the release.
      runId: 'run-tc3-different-runid',
      previousResolutions: [],
      resolution: null,
    });

    assert.ok(
      fs.existsSync(activeRunPointerPath(root)),
      'TC3: fixture — the active-run pointer file must exist before resolve',
    );

    resolveWithWaive(root, slug);

    assert.ok(
      fs.existsSync(activeRunPointerPath(root)),
      'TC3: the active-run pointer file must still exist after parkResolve (different runId)',
    );
    const pointer = readActiveRunPointer(root);
    assert.strictEqual(
      pointer?.runId,
      otherRunId,
      `TC3: the pointer must still name the original runId '${otherRunId}', got '${pointer?.runId}'`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC4 ──────────────────────────────────────────────────────────────────
// release precedes run-directory removal: with the pointer claimed for
// runId R and runHarnessDir(root, R) present on disk, after parkResolve on
// a scene carrying runId R BOTH the pointer file and runHarnessDir(root, R)
// must be gone — the removal is pointer-guarded, so the directory can only
// be absent when the pointer release ran first.

await test('TC4: release precedes run-directory removal', async () => {
  const root = makeTmpRoot('cc-orch-park-ptr-tc4-');
  try {
    const slug = 'park-ptr-tc4-slug';
    const { runId } = makeRun(root, { slug: 'park-ptr-tc4-run', kind: 'run', claim: true });

    createParkedQueueEntry(root, slug);
    writeParkScene(root, slug, {
      site: 'tc4-run-dir-removal',
      parkedAt: new Date().toISOString(),
      runId,
      singlePath: true,
      stashRef: null,
      previousResolutions: [],
      resolution: null,
    });

    assert.ok(
      fs.existsSync(activeRunPointerPath(root)),
      'TC4: fixture — the active-run pointer file must exist before resolve',
    );
    assert.ok(
      fs.existsSync(runHarnessDir(root, runId)),
      'TC4: fixture — runHarnessDir(root, runId) must exist before resolve',
    );

    resolveWithWaive(root, slug);

    assert.ok(
      !fs.existsSync(activeRunPointerPath(root)),
      'TC4: the active-run pointer file must be gone after parkResolve',
    );
    assert.ok(
      !fs.existsSync(runHarnessDir(root, runId)),
      'TC4: runHarnessDir(root, runId) must be gone after parkResolve — removal is ' +
      'pointer-guarded, so the directory can only be absent once the pointer release ran first',
    );
  } finally {
    cleanup(root);
  }
});

// ── TC5 ──────────────────────────────────────────────────────────────────
// a throwing pointer release must not undo the already-committed scene
// write + status flip. Force removal of the pointer path to throw (fs.rmSync
// is monkey-patched for that exact path only, then restored), and assert
// the resolve still lands cleanly.

await test('TC5: a throwing pointer release still writes the park scene', async () => {
  const root = makeTmpRoot('cc-orch-park-ptr-tc5-');
  const realRmSync = fs.rmSync;
  try {
    const slug = 'park-ptr-tc5-slug';
    const { runId } = makeRun(root, { slug: 'park-ptr-tc5-run', kind: 'run', claim: true });

    createParkedQueueEntry(root, slug);
    writeParkScene(root, slug, {
      site: 'tc5-release-throws',
      parkedAt: new Date().toISOString(),
      runId,
      singlePath: true,
      stashRef: null,
      previousResolutions: [],
      resolution: null,
    });

    const pointerPath = activeRunPointerPath(root);
    // Only the active-run pointer's removal is made to fail — every other
    // rmSync call (including this test's own tmp-root cleanup) still runs
    // through the real implementation.
    fs.rmSync = function patchedRmSync(targetPath, options) {
      if (targetPath === pointerPath) {
        throw new Error('TC5: simulated pointer removal failure');
      }
      return realRmSync.call(fs, targetPath, options);
    };

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      parkResolve(root, slug, { waive: true });
    } finally {
      assert.notStrictEqual(
        process.exitCode,
        1,
        'TC5: a throwing pointer release must not fail the resolve (exitCode must not be 1)',
      );
      process.exitCode = prevExitCode;
    }

    const scenePath = path.join(root, 'queue', slug, 'park.json');
    const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
    assert.ok(
      scene.resolution !== null && scene.resolution !== undefined,
      'TC5: park.json must carry a non-null resolution despite the throwing pointer release',
    );
    assert.strictEqual(
      scene.resolution.action,
      'waive',
      `TC5: resolution.action must equal the resolve verb 'waive', got '${scene.resolution?.action}'`,
    );

    const entry = readQueueEntry(root, slug);
    assert.strictEqual(
      entry.status,
      'pending',
      `TC5: entry status must be 'pending' despite the throwing pointer release, got '${entry.status}'`,
    );
  } finally {
    fs.rmSync = realRmSync;
    cleanup(root);
  }
});

// ── TC6a ─────────────────────────────────────────────────────────────────
// clean --runs (clean(root, { runs: true, force: true })) drives the real
// reapOrphanRunDirs pass. A pointer naming a runId with NO corresponding
// runHarnessDir(root, runId) on disk is orphaned — the pass must remove it.
// The fixture never bootstraps a run directory for this runId, so orphanhood
// here is a plain filesystem fact, not an inference from state.json shape.

await test('TC6a: an orphaned pointer (no run directory) is removed by clean --runs', async () => {
  const root = makeTmpRoot('cc-orch-park-ptr-tc6a-');
  try {
    const runId = generateRunId('park-ptr-tc6a-orphan');
    const claimed = claimActiveRun(root, { runId, slug: 'park-ptr-tc6a-orphan', kind: 'run' });

    assert.ok(claimed, 'TC6a: fixture — claimActiveRun must succeed');
    assert.ok(
      fs.existsSync(activeRunPointerPath(root)),
      'TC6a: fixture — the active-run pointer file must exist before the pass',
    );
    assert.ok(
      !fs.existsSync(runHarnessDir(root, runId)),
      'TC6a: fixture — runHarnessDir(root, runId) must NOT exist before the pass (orphaned pointer)',
    );

    await clean(root, { runs: true, force: true });

    assert.ok(
      !fs.existsSync(activeRunPointerPath(root)),
      'TC6a: activeRunPointerPath(root) must no longer exist after clean --runs (orphaned pointer reaped)',
    );
  } finally {
    cleanup(root);
  }
});

// ── TC6b ─────────────────────────────────────────────────────────────────
// A pointer naming a runId whose runHarnessDir(root, runId) DOES exist on
// disk survives the pass — the pointer file still exists and still names
// that runId. Uses the real makeRun helper (real bootstrap + real
// claimActiveRun) so the run directory is a genuine on-disk fact.

await test('TC6b: a pointer whose run directory exists survives clean --runs', async () => {
  const root = makeTmpRoot('cc-orch-park-ptr-tc6b-');
  try {
    const { runId } = makeRun(root, { slug: 'park-ptr-tc6b-live', kind: 'run', claim: true });

    assert.ok(
      fs.existsSync(activeRunPointerPath(root)),
      'TC6b: fixture — the active-run pointer file must exist before the pass',
    );
    assert.ok(
      fs.existsSync(runHarnessDir(root, runId)),
      'TC6b: fixture — runHarnessDir(root, runId) must exist before the pass',
    );

    await clean(root, { runs: true, force: true });

    assert.ok(
      fs.existsSync(activeRunPointerPath(root)),
      'TC6b: the active-run pointer file must still exist after clean --runs (run directory present)',
    );
    const pointer = readActiveRunPointer(root);
    assert.strictEqual(
      pointer?.runId,
      runId,
      `TC6b: the pointer must still name runId '${runId}', got '${pointer?.runId}'`,
    );
  } finally {
    cleanup(root);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
