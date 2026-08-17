#!/usr/bin/env node
/**
 * Mirrors the module-top marker-discipline guard used by
 * test/helpers/make-run.js / test/test-batch-resume.js: the fixtures below
 * bootstrap and claim REAL active-run pointers against isolated
 * fs.mkdtemp()/makeGitRoot() fixture roots, not a re-entrant cc-orch
 * invocation. If this file is launched from inside a live cc-orch run,
 * CC_ORCH_ACTIVE_RUN is inherited from the parent process environment and
 * would trip assertNoReentrantLiveRun's guard against a fixture root that
 * carries an active state.json — a false positive on the sanctioned mkdtemp
 * pattern (see reentrancy-guard.js). Clear the marker unconditionally here,
 * before any process.env-sensitive imports, so this file is re-entrancy-
 * neutral regardless of launch context.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

/**
 * test-disposition-residue-hygiene.js — "leaves no residue" hygiene checks
 * scattered across the disposition surfaces (batch-originated single-resume,
 * queue listing, park/park-resolve, forensic failed-archive, and the
 * planMission scope-mapping-consistency inert-gate). Drives the REAL
 * production functions against real fs.mkdtemp() roots / real git repos /
 * real bootstrap-created harness dirs — never a hand-copied algorithm.
 *
 * Covers:
 *   TC-a  — resume() of a batch-originated run whose queue/<slug>/ entry
 *           exists (git root): after the successful-archive leg, the queue
 *           entry is removed.
 *   TC-b1 — the same leg records a git `commit` invocation (via a PATH-front
 *           git shim generalized to capture ALL subcommands — the
 *           test-batch-resume.js TC11 precedent) whose subject is the
 *           archive manifest headline (makeFakeArchive-style headline ≠
 *           slug), proving the batch leg's message shape.
 *   TC-b2 — same scenario in a NON-git root: resume() completes without
 *           throwing and the queue entry is still removed (fail-soft
 *           commit) — graceful no-op, no commit assertion possible.
 *   TC-c  — regression pin: a plain single run with NO queue entry in a git
 *           root — archive succeeds, no queue dir is touched, and the shim
 *           records NO new `commit` invocation (commit count unchanged).
 *   TC-d  — a queue with one healthy entry and one broken entry (spec.md
 *           deleted): queueList(projectRoot)'s captured output contains a
 *           '[broken]' row naming the broken slug with a 'queue remove'
 *           hint, the healthy sibling still renders, and process.exitCode
 *           is not set (exit 0).
 *   TC-e1 — park a run (_parkEntry, the same primitive batchResume's park
 *           paths call) and confirm queue/<slug>/park.json records runId;
 *           parkResolve on that entry removes exactly .harness/<runId>/
 *           while a sibling .harness/run-{...}/ dir and the shared subdirs
 *           (learning/dry-run/brainstorm + a staging/ dir) survive.
 *   TC-e2 — parkResolve on a legacy scene WITHOUT a runId field resolves
 *           successfully with a silent skip — no dir is (or even can be)
 *           removed.
 *   TC-e3 — scene runId equals the active-run pointer's runId: parkResolve
 *           releases the pointer first, after which the parked run's dir IS
 *           removed and resolve still succeeds; a pointer naming a DIFFERENT
 *           runId is left untouched and its run dir still exists.
 *   TC-f  — forensic failed-archive (archive(root, name, {'include-failed':
 *           true}) on a halted per-run harness) leaves NO .harness/run-*
 *           residue for the archived run, while shared dirs and a sibling
 *           run dir survive.
 *   TC-g  — the real Planner's planMission-time scope-mapping-consistency
 *           surface: a real global scopeMapping fixture whose entries
 *           reference global missionIds unknown to the mission-level plan
 *           produces NO 'references unknown missionId' warning, while a
 *           genuinely malformed mapping entry (duplicate / missing
 *           scopeItemId) still produces its warning.
 *
 * Run: node test/test-disposition-residue-hygiene.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import {
  readQueueEntry,
  readParkScene,
  writeParkScene,
  updateQueueEntryStatus,
} from '../src/orchestrator/core/state.js';
import { queueList } from '../src/cli/commands/queue.js';
import { parkResolve } from '../src/cli/commands/park.js';
import { archive as archiveCommand } from '../src/cli/commands/archive.js';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';
import {
  generateRunId,
  claimActiveRun,
  clearActiveRunPointer,
  runHarnessDir,
  harnessRoot,
  activeRunPointerPath,
  readActiveRunPointer,
} from '../src/orchestrator/core/run-context.js';
import { Planner } from '../src/orchestrator/agents/planner.js';
import {
  makeGitRoot,
  makeTmpRoot,
  cleanup,
  gitSubjects,
  makePlan,
  createQueueEntry,
} from './helpers/batch-fixtures.js';
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

// ── withGitCallCapture ───────────────────────────────────────────────────────
//
// Generalized form of test-batch-resume.js's TC11 withGitPushCapture: a
// PATH-front `git` shim that records EVERY git invocation's subcommand
// (argv[1]) to a log file and delegates to the REAL git, returning the full
// list of recorded subcommands (not just 'push') so `commit` invocations can
// be asserted here.
async function withGitCallCapture(fn) {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-shim-residue-'));
  const logFile = path.join(shimDir, 'git-calls.log');
  // Resolve the real git BEFORE shimming PATH (else `command -v git` finds the shim).
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shimPath = path.join(shimDir, 'git');
  fs.writeFileSync(
    shimPath,
    `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(logFile)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  fs.chmodSync(shimPath, 0o755);

  const prevPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${prevPath}`;
  try {
    await fn();
  } finally {
    process.env.PATH = prevPath;
  }

  let recorded = '';
  try { recorded = fs.readFileSync(logFile, 'utf8'); } catch { /* no git ran */ }
  try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return recorded.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Capture console.log lines emitted synchronously by `fn`. */
function captureLogLines(fn) {
  const lines = [];
  const origLog = console.log;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return lines;
}

// ── Fixtures (single-run resume() leg) ───────────────────────────────────────

/**
 * A fake archive() for the constructor's injection seam, shaped for the
 * single-run resume() call site: resume() invokes `this._archive(projectRoot,
 * null, {auto:true})` — the slug argument is always `null` (unlike
 * batchResume's per-entry `entry.slug`) — so this local variant must NOT
 * path.join() the (null) slug argument. Writes a real
 * archives/<dirName>/manifest.json (carrying the headline) so the
 * post-archive commit-subject read has real content.
 */
function makeResumeFakeArchive(headline, dirName = 'resume-run') {
  return async (projectRoot, _slug, _opts) => {
    const dir = path.join(projectRoot, 'archives', dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ headline }));
    fs.writeFileSync(path.join(dir, 'report.txt'), `archived ${headline}`);
    return dir;
  };
}

/**
 * Build a Pipeline wired to drive a REAL single-run resume(): bootstraps +
 * claims a real active-run pointer for `slug` (so resume()'s
 * readActiveRunPointer() sees it and this.harnessDir resolves correctly),
 * then constructs the Pipeline with `archive` injected via the constructor
 * seam. `_reviewGate` and `_skipCoverageGate` are stubbed so the run
 * completes without a live planner/reviewer session; everything else
 * (preflight, milestone loop over the bootstrap's empty milestones, cost
 * summary, queue removal + git commit) runs for real.
 */
function makeResumePipeline(root, { archive, slug = 'resume-test-run', kind = 'batch' } = {}) {
  const { runId } = makeRun(root, { slug, kind, claim: true });
  const pipeline = new Pipeline(root, {
    onLog: () => {},
    onConfirm: async () => true,
    statusBar: false,
    archive,
  });
  pipeline._skipCoverageGate = true;
  pipeline._reviewGate = async () => {};
  return { pipeline, runId };
}

// ── TC-a ──────────────────────────────────────────────────────────────────
// resume() of a batch-originated run whose queue/<slug>/ entry exists (git
// root): after the successful-archive leg, queue/<slug>/ is removed.

await test('TC-a: resume-archive of a batch-originated queue entry removes queue/<slug>/', async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-residue-a-' });
  try {
    const slug = 'residue-a-slug';
    createQueueEntry(root, slug, { plan: makePlan() });

    const { pipeline } = makeResumePipeline(root, {
      archive: makeResumeFakeArchive('Residue A headline'),
      slug,
    });

    await pipeline.resume();

    assert.ok(
      !fs.existsSync(path.join(root, 'queue', slug)),
      `TC-a: queue/${slug}/ should be removed after the successful-archive leg`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC-b1 ─────────────────────────────────────────────────────────────────
// same leg records a git `commit` invocation via the shim, and gitSubjects
// shows exactly one new commit whose subject is the archive manifest
// headline (headline ≠ slug, proving the batch leg's message shape).

await test('TC-b1: the leg records a git commit invocation whose subject is the archive manifest headline', async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-residue-b1-' });
  try {
    const slug = 'residue-b1-slug';
    createQueueEntry(root, slug, { plan: makePlan() });

    const { pipeline } = makeResumePipeline(root, {
      // manifest headline differs from the slug → proves the commit subject is
      // the headline, not entry.slug.
      archive: makeResumeFakeArchive('Residue B1 headline'),
      slug,
    });

    const before = gitSubjects(root).length;
    const recorded = await withGitCallCapture(async () => {
      await pipeline.resume();
    });

    const commitCalls = recorded.filter((c) => c === 'commit');
    assert.strictEqual(
      commitCalls.length,
      1,
      `TC-b1: expected exactly one git commit invocation, got ${commitCalls.length}. Recorded: ${JSON.stringify(recorded)}`,
    );

    const subjects = gitSubjects(root);
    assert.strictEqual(
      subjects.length,
      before + 1,
      `TC-b1: expected exactly one new commit, got ${subjects.length - before}. Subjects: ${JSON.stringify(subjects)}`,
    );
    assert.strictEqual(
      subjects[0],
      'Residue B1 headline',
      `TC-b1: HEAD commit subject must equal the archive manifest headline. Got: '${subjects[0]}'`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC-b2 ─────────────────────────────────────────────────────────────────
// same scenario in a NON-git root: resume() completes without throwing,
// queue entry removed, no commit assertion possible — graceful no-op.

await test('TC-b2: same leg in a non-git root no-ops gracefully (fail-soft commit)', async () => {
  const root = makeTmpRoot('cc-orch-residue-b2-');
  try {
    const slug = 'residue-b2-slug';
    createQueueEntry(root, slug, { plan: makePlan() });

    const { pipeline } = makeResumePipeline(root, {
      archive: makeResumeFakeArchive('TC-b2 headline'),
      slug,
    });

    let thrown = null;
    try {
      await pipeline.resume();
    } catch (err) {
      thrown = err;
    }

    assert.strictEqual(
      thrown,
      null,
      `TC-b2: resume() must not throw even when projectRoot is not a git repository. Got: ${thrown ? thrown.stack || thrown.message : null}`,
    );
    assert.ok(
      !fs.existsSync(path.join(root, 'queue', slug)),
      `TC-b2: queue/${slug}/ should still be removed (fs-only removal precedes the failing git commit)`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC-c ──────────────────────────────────────────────────────────────────
// regression pin: a plain single run with NO queue entry in a git root —
// archive succeeds, no queue dir is touched, and the shim records NO new
// commit invocation attributable to the leg.

await test('TC-c: plain single run (no queue entry) — no queue removal, no new commit (regression pin)', async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-residue-c-' });
  try {
    const before = gitSubjects(root).length;
    const { pipeline } = makeResumePipeline(root, {
      archive: makeResumeFakeArchive('Should never be committed'),
      slug: 'no-queue-residue-c-slug',
    });

    const recorded = await withGitCallCapture(async () => {
      await pipeline.resume();
    });

    assert.ok(
      !recorded.includes('commit'),
      `TC-c: expected NO git commit invocation from the queue leg (no queue entry to mirror). Recorded: ${JSON.stringify(recorded)}`,
    );
    assert.ok(
      !fs.existsSync(path.join(root, 'queue')),
      'TC-c: no queue/ dir should exist — nothing was ever written and nothing should be created',
    );

    const subjects = gitSubjects(root);
    assert.strictEqual(
      subjects.length,
      before,
      `TC-c: commit count must be unchanged (byte-identical no-op). Before: ${before}, after: ${subjects.length}. Subjects: ${JSON.stringify(subjects)}`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC-d ──────────────────────────────────────────────────────────────────
// a queue with one healthy entry and one broken entry (spec.md deleted):
// queueList's captured output contains a '[broken]' row + 'queue remove'
// hint, the healthy sibling row renders, and process.exitCode is not set.

await test('TC-d: queue list renders a [broken] row + healthy sibling, exit 0', async () => {
  const root = makeTmpRoot('cc-orch-residue-d-');
  try {
    createQueueEntry(root, 'healthy-slug', { plan: makePlan() });
    createQueueEntry(root, 'broken-slug', { plan: makePlan() });
    fs.rmSync(path.join(root, 'queue', 'broken-slug', 'spec.md'), { force: true });

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    let lines;
    try {
      lines = captureLogLines(() => queueList(root));
    } finally {
      const observedExitCode = process.exitCode;
      process.exitCode = prevExitCode;
      assert.strictEqual(
        observedExitCode,
        undefined,
        `TC-d: process.exitCode must remain unset (exit 0), got ${observedExitCode}`,
      );
    }

    const out = lines.join('\n');
    assert.ok(out.includes('[broken]'), `TC-d: expected a '[broken]' row in output:\n${out}`);
    assert.ok(out.includes('broken-slug'), `TC-d: expected the broken slug to be named:\n${out}`);
    assert.ok(/queue remove/.test(out), `TC-d: expected a 'queue remove' hint:\n${out}`);
    assert.ok(out.includes('healthy-slug'), `TC-d: expected the healthy sibling to render:\n${out}`);
  } finally {
    cleanup(root);
  }
});

// ── TC-e1 ─────────────────────────────────────────────────────────────────
// park a run (_parkEntry) → queue/<slug>/park.json records runId; parkResolve
// on that entry removes exactly .harness/<runId>/ while a sibling
// .harness/run-*/ dir and shared dirs survive.

await test('TC-e1: park.json records runId; parkResolve removes exactly .harness/<runId>/, siblings + shared dirs survive', async () => {
  const root = makeTmpRoot('cc-orch-residue-e1-');
  try {
    const slug = 'residue-e1-slug';
    createQueueEntry(root, slug, { plan: makePlan() });

    const { runId } = makeRun(root, { slug, kind: 'batch', claim: true });
    const pipeline = new Pipeline(root, { onLog: () => {}, onConfirm: async () => true, statusBar: false });
    pipeline._activeEntryRunId = runId;

    const entry = readQueueEntry(root, slug);
    pipeline._parkEntry(entry, { site: 'residue-hygiene-e1' });

    const scene = readParkScene(root, slug);
    assert.ok(scene, 'TC-e1: a park.json scene must be written for the parked entry');
    assert.strictEqual(
      scene.runId,
      runId,
      `TC-e1: park.json's runId must equal the parked run's runId (expected ${runId}, got ${scene.runId})`,
    );

    assert.ok(fs.existsSync(runHarnessDir(root, runId)), 'TC-e1: fixture — the parked run\'s harness dir must exist');

    // A sibling run becomes the new active run (pointer must move OFF the
    // parked runId for removeParkedRunHarnessDir to be eligible to remove it).
    clearActiveRunPointer(root);
    const siblingRunId = generateRunId('residue-e1-sibling');
    bootstrap(root, { runId: siblingRunId });
    claimActiveRun(root, { runId: siblingRunId, slug: 'residue-e1-sibling', kind: 'run' });

    // A manually-created staging/ dir under the shared harness root, to prove
    // the shared subdirs (learning/dry-run/brainstorm + staging) survive.
    const stagingDir = path.join(harnessRoot(root), 'staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'sentinel.txt'), 'keep\n');

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      parkResolve(root, slug, { waive: true });
    } finally {
      assert.notStrictEqual(process.exitCode, 1, 'TC-e1: parkResolve must succeed (exitCode must not be 1)');
      process.exitCode = prevExitCode;
    }

    assert.ok(
      !fs.existsSync(runHarnessDir(root, runId)),
      `TC-e1: .harness/${runId}/ must be removed after parkResolve`,
    );
    assert.ok(
      fs.existsSync(runHarnessDir(root, siblingRunId)),
      `TC-e1: sibling .harness/${siblingRunId}/ must survive untouched`,
    );
    assert.ok(fs.existsSync(path.join(harnessRoot(root), 'learning')), 'TC-e1: shared learning/ must survive');
    assert.ok(fs.existsSync(path.join(harnessRoot(root), 'dry-run')), 'TC-e1: shared dry-run/ must survive');
    assert.ok(fs.existsSync(path.join(harnessRoot(root), 'brainstorm')), 'TC-e1: shared brainstorm/ must survive');
    assert.ok(fs.existsSync(stagingDir), 'TC-e1: shared staging/ dir must survive');
    assert.ok(
      fs.existsSync(path.join(stagingDir, 'sentinel.txt')),
      'TC-e1: staging/ contents must survive untouched',
    );
  } finally {
    cleanup(root);
  }
});

// ── TC-e2 ─────────────────────────────────────────────────────────────────
// a legacy scene WITHOUT runId — resolves successfully, silent skip, no dir
// removed (there is nothing recorded to remove).

await test('TC-e2: parkResolve on a legacy scene without runId resolves successfully (silent skip)', async () => {
  const root = makeTmpRoot('cc-orch-residue-e2-');
  try {
    const slug = 'residue-e2-slug';
    createQueueEntry(root, slug, { plan: makePlan(), status: 'parked' });
    writeParkScene(root, slug, {
      site: 'legacy-no-runid',
      parkedAt: new Date().toISOString(),
      previousResolutions: [],
      resolution: null,
      // no `runId` field — the legacy shape.
    });

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      parkResolve(root, slug, { waive: true });
    } finally {
      assert.notStrictEqual(process.exitCode, 1, 'TC-e2: parkResolve must succeed even without a recorded runId');
      process.exitCode = prevExitCode;
    }

    const entry = readQueueEntry(root, slug);
    assert.ok(entry, 'TC-e2: queue entry should still exist after resolving');
    assert.strictEqual(
      entry.status,
      'pending',
      `TC-e2: --waive resolves to status 'pending', got '${entry.status}'`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC-e3 ─────────────────────────────────────────────────────────────────
// scene runId equals the active-run pointer's runId — parkResolve releases
// the pointer FIRST, after which the parked run's dir IS removed and resolve
// still succeeds. A pointer naming a DIFFERENT runId is left untouched and
// its run dir still exists afterward.

await test('TC-e3: scene runId equal to the active-run pointer releases the pointer and removes its dir; a mismatched pointer is left untouched', async () => {
  // Part (i) — match: scene.runId === active-run pointer's runId. Per the
  // release-then-remove contract (W-361), parkResolve clears the pointer
  // FIRST, so removeParkedRunHarnessDir's own guard (skip while the pointer
  // still names this runId) no longer applies and the dir IS removed.
  const rootMatch = makeTmpRoot('cc-orch-residue-e3-match-');
  try {
    const slug = 'residue-e3-match-slug';
    const { runId } = makeRun(rootMatch, { slug: 'residue-e3-active', kind: 'run', claim: true });

    createQueueEntry(rootMatch, slug, { plan: makePlan(), status: 'parked' });
    writeParkScene(rootMatch, slug, {
      site: 'active-pointer-match',
      parkedAt: new Date().toISOString(),
      runId,
      previousResolutions: [],
      resolution: null,
    });

    assert.ok(fs.existsSync(runHarnessDir(rootMatch, runId)), 'TC-e3: fixture — the active run dir must exist');
    assert.ok(
      fs.existsSync(activeRunPointerPath(rootMatch)),
      'TC-e3: fixture — the active-run pointer must exist before resolve',
    );

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      parkResolve(rootMatch, slug, { waive: true });
    } finally {
      assert.notStrictEqual(
        process.exitCode,
        1,
        'TC-e3: parkResolve must succeed when scene.runId matches the active pointer',
      );
      process.exitCode = prevExitCode;
    }

    assert.ok(
      !fs.existsSync(activeRunPointerPath(rootMatch)),
      'TC-e3: the active-run pointer must be released (removed) once the matching run is resolved',
    );
    assert.ok(
      !fs.existsSync(runHarnessDir(rootMatch, runId)),
      `TC-e3: .harness/${runId}/ must be removed after the pointer is released`,
    );
    const entryMatch = readQueueEntry(rootMatch, slug);
    assert.strictEqual(
      entryMatch.status,
      'pending',
      `TC-e3: --waive resolves to status 'pending', got '${entryMatch.status}'`,
    );
  } finally {
    cleanup(rootMatch);
  }

  // Part (ii) — mismatch: the active-run pointer names a DIFFERENT runId than
  // the parked scene. parkResolve must leave that pointer untouched and its
  // run dir must still exist afterward.
  const rootMismatch = makeTmpRoot('cc-orch-residue-e3-mismatch-');
  try {
    const slug = 'residue-e3-mismatch-slug';
    const { runId: otherRunId } = makeRun(rootMismatch, {
      slug: 'residue-e3-other-active',
      kind: 'run',
      claim: true,
    });
    const { runId: sceneRunId } = makeRun(rootMismatch, {
      slug: 'residue-e3-parked',
      kind: 'run',
      claim: false,
    });

    createQueueEntry(rootMismatch, slug, { plan: makePlan(), status: 'parked' });
    writeParkScene(rootMismatch, slug, {
      site: 'active-pointer-mismatch',
      parkedAt: new Date().toISOString(),
      runId: sceneRunId,
      previousResolutions: [],
      resolution: null,
    });

    assert.ok(
      fs.existsSync(runHarnessDir(rootMismatch, otherRunId)),
      'TC-e3: fixture — the (different) active run dir must exist',
    );

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      parkResolve(rootMismatch, slug, { waive: true });
    } finally {
      assert.notStrictEqual(
        process.exitCode,
        1,
        'TC-e3: parkResolve must succeed even when the scene runId does not match the active pointer',
      );
      process.exitCode = prevExitCode;
    }

    const pointer = readActiveRunPointer(rootMismatch);
    assert.ok(pointer, 'TC-e3: a mismatched active-run pointer must still exist after resolve');
    assert.strictEqual(
      pointer.runId,
      otherRunId,
      `TC-e3: the active-run pointer must remain untouched, still naming ${otherRunId}, got ${pointer && pointer.runId}`,
    );
    assert.ok(
      fs.existsSync(runHarnessDir(rootMismatch, otherRunId)),
      `TC-e3: .harness/${otherRunId}/ (the untouched pointer's target) must still exist`,
    );
    const entryMismatch = readQueueEntry(rootMismatch, slug);
    assert.strictEqual(
      entryMismatch.status,
      'pending',
      `TC-e3: --waive resolves to status 'pending', got '${entryMismatch.status}'`,
    );
  } finally {
    cleanup(rootMismatch);
  }
});

// ── TC-f ──────────────────────────────────────────────────────────────────
// forensic failed-archive (archive(root, name, {'include-failed': true}) on
// a halted per-run harness) leaves NO .harness/run-* residue for the
// archived run while shared dirs and a sibling run dir survive.

await test('TC-f: forensic failed-archive leaves no .harness/run-* residue; shared dirs + sibling run dir survive', async () => {
  const root = makeTmpRoot('cc-orch-residue-f-');
  try {
    // The archived run: bootstrap's default state.json (globalStatus:
    // 'active', milestones: {}) is non-terminal, so detectHaltInfo does not
    // return null (it falls back to haltReason:'unknown') — a halted run.
    const { runId } = makeRun(root, { slug: 'residue-f-slug', kind: 'run', claim: true });

    // A sibling run dir, bootstrapped but NOT claimed as the active pointer
    // (the archived run must stay the active pointer target throughout the
    // archive() call, since activeHarnessDir() resolves off the pointer).
    const siblingRunId = generateRunId('residue-f-sibling');
    bootstrap(root, { runId: siblingRunId });

    // A manually-created staging/ dir under the shared harness root.
    const stagingDir = path.join(harnessRoot(root), 'staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'sentinel.txt'), 'keep\n');

    await archiveCommand(root, 'residue-f-forensic', { 'include-failed': true });

    assert.ok(
      !fs.existsSync(runHarnessDir(root, runId)),
      `TC-f: .harness/${runId}/ must be fully removed after the forensic failed-archive`,
    );
    assert.ok(
      fs.existsSync(runHarnessDir(root, siblingRunId)),
      `TC-f: sibling .harness/${siblingRunId}/ must survive untouched`,
    );
    assert.ok(fs.existsSync(path.join(harnessRoot(root), 'learning')), 'TC-f: shared learning/ must survive');
    assert.ok(fs.existsSync(path.join(harnessRoot(root), 'dry-run')), 'TC-f: shared dry-run/ must survive');
    assert.ok(fs.existsSync(path.join(harnessRoot(root), 'brainstorm')), 'TC-f: shared brainstorm/ must survive');
    assert.ok(fs.existsSync(stagingDir), 'TC-f: shared staging/ dir must survive');
    assert.ok(
      fs.existsSync(path.join(stagingDir, 'sentinel.txt')),
      'TC-f: staging/ contents must survive untouched',
    );
  } finally {
    cleanup(root);
  }
});

// ── TC-g ──────────────────────────────────────────────────────────────────
// planMission-time scope-mapping-consistency: a real global scopeMapping
// fixture whose entries reference global missionIds unknown to the
// mission-level plan produces NO 'references unknown missionId' warning,
// while a genuinely malformed mapping entry still produces its warning.

const PLANTED_MISSION_ID = '001-001';
const PLANTED_TASK_ID = '001-001-001-001';

/**
 * Fake sessionManager whose spawnReusable() resolves with a single-task plan
 * (mirrors test-plan-scope-lint-wiring.js's makeFakeReusableSessionManager).
 * planMission() unconditionally takes the reusable-session path.
 */
function makeFakeReusableSessionManager() {
  const fakeHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
  const fakeResult = {
    structured_output: {
      subMissions: [
        {
          id: PLANTED_MISSION_ID,
          tasks: [
            { id: PLANTED_TASK_ID, description: 'a planted task', targetFiles: ['src/foo.js'] },
          ],
        },
      ],
      milestones: [],
    },
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    total_cost_usd: 0,
  };

  const fakeReusableSession = {
    handle: fakeHandle,
    turnCount: 0,
    sendPrompt: async () => fakeResult,
  };

  return {
    spawn() {
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
    spawnReusable() {
      return fakeReusableSession;
    },
  };
}

function makeFakeLoggerWithCapture() {
  const logs = [];
  return {
    logger: {
      createSessionLog: () => ({
        logPath: '/tmp/fake-residue-hygiene-tc-g.jsonl',
        write: () => {},
        close: () => {},
      }),
      attachToSession: () => {},
      getSessionSummary: () => ({}),
      writeSessionSummary: async () => {},
      warn: (msg) => logs.push(msg),
    },
    logs,
  };
}

await test('TC-g: no "references unknown missionId" warning for global-mapping ids; malformed entry still warns', async () => {
  const { logger, logs } = makeFakeLoggerWithCapture();
  const planner = new Planner(
    makeFakeReusableSessionManager(),
    logger,
    { recordSession: async () => {} },
  );

  // A real GLOBAL scopeMapping fixture: entry 1 references missionIds that
  // are legitimate elsewhere in the global plan but unknown to THIS
  // mission-level plan's subMissions (only PLANTED_MISSION_ID is known here)
  // — this must NOT produce a 'references unknown missionId' warning.
  // Entry 2 duplicates entry 1's scopeItemId (malformed) — this MUST still
  // warn. Entry 3 is missing scopeItemId entirely (malformed) — this MUST
  // still warn too.
  const scopeMapping = [
    { scopeItemId: 'S1', missionIds: ['002-001', '003-002'] },
    { scopeItemId: 'S1', missionIds: [PLANTED_MISSION_ID] },
    { missionIds: [PLANTED_MISSION_ID] },
  ];

  const plan = await planner.planMission(PLANTED_MISSION_ID, '/tmp', {
    missionPlan: '...',
    maxTasksPerSubMission: 3,
    mode: 'auto',
    specTargetFiles: [],
    specAcceptanceCriteria: [],
    scopeMapping,
    scopeItems: [],
  });

  assert.ok(plan && Array.isArray(plan.subMissions), 'TC-g: expected planMission to resolve with a plan');

  assert.ok(
    !logs.some((l) => l.includes('references unknown missionId')),
    `TC-g: expected NO 'references unknown missionId' warning to be logged. Logs:\n${logs.join('\n')}`,
  );
  const scopeWarnings = Array.isArray(plan.scopeWarnings) ? plan.scopeWarnings : [];
  assert.ok(
    !scopeWarnings.some((w) => w.description && w.description.includes('references unknown missionId')),
    `TC-g: expected NO 'references unknown missionId' warning attached to plan.scopeWarnings. Got: ${JSON.stringify(scopeWarnings)}`,
  );

  assert.ok(
    logs.some((l) => l.includes('Duplicate scope mapping entry')),
    `TC-g: expected a 'Duplicate scope mapping entry' warning for the genuinely malformed duplicate entry. Logs:\n${logs.join('\n')}`,
  );
  assert.ok(
    logs.some((l) => l.includes('missing a valid scopeItemId')),
    `TC-g: expected a 'missing a valid scopeItemId' warning for the entry missing scopeItemId. Logs:\n${logs.join('\n')}`,
  );
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
