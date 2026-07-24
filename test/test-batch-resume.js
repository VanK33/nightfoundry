#!/usr/bin/env node
/**
 * Mirrors the module-top marker-discipline guard used by
 * test/helpers/make-run.js / test/test-bootstrap-run-scoped.js: the batch
 * fixtures below (via makeRun) bootstrap and claim REAL active-run pointers
 * against isolated fs.mkdtemp()/makeGitRoot() fixture roots, not a re-entrant
 * cc-orch invocation. If this file is launched from inside a live cc-orch run,
 * CC_ORCH_ACTIVE_RUN is inherited from the parent process environment and
 * would trip assertNoReentrantLiveRun's guard against a fixture root that
 * carries an active state.json — a false positive on the sanctioned mkdtemp
 * pattern (see reentrancy-guard.js). Clear the marker unconditionally here,
 * before any process.env-sensitive imports, so this file is re-entrancy-
 * neutral regardless of launch context.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

/**
 * test-batch-resume.js — Integration tests for the batch resume flow.
 *
 * TC1-TC9 drive the REAL Pipeline.batchResume (via makeRealBatchPipeline seams)
 * and assert the CURRENT PRODUCTION contract — not a hand-copied algorithm.
 * TC10-TC12b were already on the real batchResume; TC13-TC15 exercise resume.js.
 *
 * Production contract highlights the assertions below encode (src/orchestrator/
 * core/pipeline.js batchResume):
 *   - Returns { archived, failed, parked } (parked is a first-class field).
 *   - Iterates ONLY status==='pending' entries; failed-validation /
 *     failed-execution / parked entries are never selected and stay untouched.
 *   - Assumptions still failing after the round-2 remediation re-verify PARK the
 *     entry (status 'parked', parked++), they do NOT become 'failed-validation'.
 *   - Remediation auto-accepts every planner-proposed spec edit — there is NO
 *     Levenshtein/similarity gate (that lived only in the retired v1 hand-copy).
 *
 * Covers:
 *   TC1  — empty queue returns {archived:0,failed:0,parked:0} and logs 'Queue is empty'
 *   TC2  — batchResume processes 2 pending entries in creation-time (validatedAt) order
 *   TC3  — entry with all assumptions verified → full pipeline runs and entry removed
 *   TC4  — assumptions still failing after round 2 → entry PARKED (status 'parked')
 *   TC5  — round-1 failure remediated (edit auto-accepted), round 2 passes → archived
 *   TC6  — RETIRED: production has no similarity-based edit-rejection branch
 *   TC7  — mixed batch: 1 archived + 1 parked → {archived:1, failed:0, parked:1}
 *   TC8  — entries with status 'failed-validation' are skipped (pending-only filter)
 *   TC9  — entries with status 'failed-execution' are skipped (pending-only filter)
 *   TC10 — dirty working tree refuses with friendly message (working tree is not clean)
 *   TC11 — spec-boundary commit on per-spec success (git add + git commit "headline")
 *   TC12 — execution-phase throw triggers park-failed-execution and status 'failed-execution'
 *   TC12b — InfrastructureError rethrows without writing failed-execution or git reset
 *   TC13 — batch=true + unresumable state → batchResume executes, no exit(76)
 *   TC14 — batch=false + unresumable state → process.exit(76) called, stderr has 'cc-orch run'
 *   TC15 — Pipeline constructor receives pipelineOpts without autoMode key
 *
 * Run: node test/test-batch-resume.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { readQueueEntry } from '../src/orchestrator/core/state.js';
import { resume } from '../src/cli/commands/resume.js';
import { InfrastructureError } from '../src/orchestrator/infra/session-manager.js';
import { activeHarnessDir } from '../src/orchestrator/core/run-context.js';
import {
  makeGitRoot,
  makeTmpRoot,
  cleanup,
  porcelain,
  gitSubjects,
  makeFakeArchive,
  makePlan,
  createQueueEntry,
  makeRealBatchPipeline,
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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ── captureOutput (async) ─────────────────────────────────────────────────────
// Mirrors the pattern from test-resume.js: awaits async fn and captures both
// stdout and stderr (process.stdout.write + console.log/error overrides).

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
  try { await fn(); }
  catch (err) { thrownError = err; }
  finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
  }
  return { stdout: outChunks.join(''), stderr: errChunks.join(''), thrownError };
}

// ── withGitPushCapture (TC11) ─────────────────────────────────────────────────
//
// Run `fn` with a PATH-front `git` shim that records every git invocation's
// subcommand (argv[1]) to a log file and then delegates to the REAL git, and
// return the list of `push` invocations captured.
//
// The pipeline shells out to an unqualified `git` (execSync / execFileSync), so
// prepending a recording shim to PATH captures ALL git calls made during `fn`,
// push included, without changing production behavior. Used to guard
// push-needs-approval: the spec-boundary commit path must issue `git add` /
// `git commit` but NEVER `git push`.
async function withGitPushCapture(fn) {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-shim-'));
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
  return recorded.split('\n').map((s) => s.trim()).filter((s) => s === 'push');
}

// Spec-edit strings for TC5's remediation fixture. These are plain fixture
// content (a section body + the edit the planner proposes); the production
// remediation path auto-accepts any proposed edit, so no similarity property is
// asserted (the v1 similarity gate is retired — see TC6).
const SPEC_EDIT_OLD = 'sessionManager.spawn accepts a jsonSchema parameter for structured output';
const SPEC_EDIT_NEW = 'sessionManager.spawn accepts a schema parameter for structured output';

// ── TC1 ─────────────────────────────────────────────────────────────────────
// empty queue returns {archived:0, failed:0, parked:0} and logs 'Queue is empty'

await test('TC1: empty queue returns {archived:0,failed:0,parked:0} and logs "Queue is empty"', async () => {
  const root = makeGitRoot({ prefix: 'cc-batch-resume-' });
  try {
    const { pipeline, logs } = makeRealBatchPipeline(root, {});

    const result = await pipeline.batchResume({});

    assert.deepStrictEqual(
      result,
      { archived: 0, failed: 0, parked: 0 },
      `Expected {archived:0,failed:0,parked:0} but got ${JSON.stringify(result)}`,
    );
    assert.ok(
      logs.some((l) => /queue is empty/i.test(l)),
      `Expected a "Queue is empty" log message. Logs:\n${logs.join('\n')}`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC2 ─────────────────────────────────────────────────────────────────────
// batchResume processes 2 pending entries in creation-time (validatedAt) order

await test('TC2: processes 2 pending entries in creation-time order', async () => {
  const root = makeGitRoot({ prefix: 'cc-batch-resume-' });
  try {
    const processed = [];

    // 'alpha' is older (earlier validatedAt), 'beta' is newer. listQueue sorts
    // pending entries by validatedAt ascending, so alpha must run before beta.
    createQueueEntry(root, 'alpha', {
      plan: makePlan({ assumptions: [{ text: 'alpha-assumption', specSection: '## A' }] }),
      validatedAt: '2026-01-01T00:00:00.000Z',
    });
    createQueueEntry(root, 'beta', {
      plan: makePlan({ assumptions: [{ text: 'beta-assumption', specSection: '## B' }] }),
      validatedAt: '2026-01-02T00:00:00.000Z',
    });

    const { pipeline } = makeRealBatchPipeline(root, {
      archive: makeFakeArchive(),
      // Record which entry's plan is executed (production passes the entry's
      // plan into _executeAllMilestones).
      executeAllMilestones: async (plan) => {
        const names = (plan?.assumptions || []).map((a) => a.text ?? a);
        if (names.includes('alpha-assumption')) processed.push('alpha');
        else if (names.includes('beta-assumption')) processed.push('beta');
        else processed.push('unknown');
      },
    });
    pipeline.planner.verifyAssumptions = async () => []; // all pass

    const result = await pipeline.batchResume({});

    assert.strictEqual(result.archived, 2, `Expected 2 archived, got ${result.archived}`);
    assert.strictEqual(result.failed, 0, `Expected 0 failed, got ${result.failed}`);
    assert.strictEqual(result.parked, 0, `Expected 0 parked, got ${result.parked}`);

    assert.ok(
      processed.includes('alpha') && processed.includes('beta'),
      `Expected both alpha and beta to be processed. Got: ${JSON.stringify(processed)}`,
    );
    assert.ok(
      processed.indexOf('alpha') < processed.indexOf('beta'),
      `Expected alpha before beta but got: ${JSON.stringify(processed)}`,
    );

    // Both queue entries removed (archived).
    const queueDir = path.join(root, 'queue');
    const remaining = fs.existsSync(queueDir) ? fs.readdirSync(queueDir) : [];
    assert.strictEqual(
      remaining.length,
      0,
      `Expected empty queue after batch, but found: ${JSON.stringify(remaining)}`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC3 ─────────────────────────────────────────────────────────────────────
// entry with all assumptions verified → full pipeline runs and entry removed

await test('TC3: all-pass verification → full pipeline runs and entry removed from queue', async () => {
  const root = makeGitRoot({ prefix: 'cc-batch-resume-' });
  try {
    const plan = makePlan({
      assumptions: [
        { text: 'The foo module exports bar()', specSection: '## Foo API' },
        { text: 'Config reads from .env file', specSection: '## Config' },
      ],
    });
    createQueueEntry(root, 'my-spec', { spec: 'spec content', plan });

    let executeCount = 0;
    let reviewCount = 0;
    const { pipeline } = makeRealBatchPipeline(root, {
      archive: makeFakeArchive(),
      executeAllMilestones: async () => { executeCount++; },
      reviewGate: async () => { reviewCount++; },
    });
    // All assumptions verified → no failures → no remediation, no round 2.
    pipeline.planner.verifyAssumptions = async () => [
      { assumption: { text: 'The foo module exports bar()' }, status: 'verified' },
      { assumption: { text: 'Config reads from .env file' }, status: 'verified' },
    ];

    const result = await pipeline.batchResume({});

    assert.strictEqual(executeCount, 1, `_executeAllMilestones should run once (got ${executeCount})`);
    assert.strictEqual(reviewCount, 1, `_reviewGate should run once (got ${reviewCount})`);
    assert.strictEqual(result.archived, 1, `Expected archived:1, got ${result.archived}`);
    assert.strictEqual(result.failed, 0, `Expected failed:0, got ${result.failed}`);
    assert.strictEqual(result.parked, 0, `Expected parked:0, got ${result.parked}`);

    assert.ok(
      !fs.existsSync(path.join(root, 'queue', 'my-spec')),
      `Queue entry 'my-spec' should be removed after successful archive`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC4 ─────────────────────────────────────────────────────────────────────
// assumptions still failing after the round-2 re-verify → entry PARKED.
//
// PRODUCTION CONTRACT (pipeline.js ~1228): a `failed` verdict after remediation
// routes to _parkEntry({site:'assumption-gate'}) with status 'parked' and
// parked++. It does NOT set 'failed-validation' (the v1 hand-copy's behavior).

await test('TC4: assumptions failing after round 2 → entry PARKED (status "parked"), not failed-validation', async () => {
  const root = makeGitRoot({ prefix: 'cc-batch-resume-' });
  try {
    const failedAssumption = { text: 'Persistent stale assumption', specSection: '## Stale' };
    const plan = makePlan({ assumptions: [failedAssumption] });
    createQueueEntry(root, 'stale-spec', { plan });

    let verifyCallCount = 0;
    let executeCount = 0;
    const { pipeline } = makeRealBatchPipeline(root, {
      executeAllMilestones: async () => { executeCount++; },
    });
    // Fails on every round (round 1 and the post-remediation round 2). The
    // default spec has no '## Stale' section, so remediation finds nothing to
    // edit and round 2 fails identically → park.
    pipeline.planner.verifyAssumptions = async () => {
      verifyCallCount++;
      return [{ assumption: failedAssumption, status: 'failed', evidence: 'Not found in codebase' }];
    };

    const result = await pipeline.batchResume({});

    // Execution never runs for a parked entry.
    assert.strictEqual(executeCount, 0, `_executeAllMilestones must NOT run when the entry parks`);
    // Two verify rounds (round 1 + round 2).
    assert.strictEqual(verifyCallCount, 2, `Expected 2 verifyAssumptions calls (got ${verifyCallCount})`);

    // Return shape: parked, not failed.
    assert.strictEqual(result.archived, 0, `Expected archived:0, got ${result.archived}`);
    assert.strictEqual(result.failed, 0, `Expected failed:0 (production parks, not fails), got ${result.failed}`);
    assert.strictEqual(result.parked, 1, `Expected parked:1, got ${result.parked}`);

    // Entry kept on disk with status 'parked'.
    const entry = readQueueEntry(root, 'stale-spec');
    assert.ok(entry, `Queue entry 'stale-spec' should still exist after parking`);
    assert.strictEqual(
      entry.status,
      'parked',
      `Expected status 'parked' (production), got '${entry.status}'`,
    );
    // A park scene was written (park show / resolve is the recovery path).
    assert.ok(
      fs.existsSync(path.join(root, 'queue', 'stale-spec', 'park.json')),
      `Expected a park.json scene for the parked entry`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC5 ─────────────────────────────────────────────────────────────────────
// round-1 failure remediated (edit auto-accepted), round 2 passes → archived.
//
// PRODUCTION CONTRACT: the remediation loop auto-accepts EVERY planner-proposed
// spec edit (no similarity gate). Here the applied edit makes round 2 pass, so
// the entry runs the full pipeline and archives. This locks the real
// remediation-repairs-and-proceeds path (distinct from TC3's no-failure path).

await test('TC5: round-1 failure remediated then round 2 passes → pipeline runs, entry archived', async () => {
  const root = makeGitRoot({ prefix: 'cc-batch-resume-' });
  try {
    const failingAssumption = { text: SPEC_EDIT_OLD, specSection: '## Session API' };
    const plan = makePlan({ assumptions: [failingAssumption] });

    // Spec contains the '## Session API' section + the old text so the proposed
    // edit can be located and applied.
    createQueueEntry(root, 'remediated', {
      spec: `# Spec\n\n## Session API\n\n${SPEC_EDIT_OLD}\n\nMore content here.`,
      plan,
    });

    let verifyCallCount = 0;
    let executeCount = 0;
    let specAtExecute = null;
    const { pipeline } = makeRealBatchPipeline(root, {
      archive: makeFakeArchive(),
      executeAllMilestones: async () => {
        executeCount++;
        // Capture the spec NOW — after remediation applied the edit and round 2
        // passed, but before the archive dequeues (and deletes) the entry.
        specAtExecute = fs.readFileSync(path.join(root, 'queue', 'remediated', 'spec.md'), 'utf8');
      },
    });
    pipeline.planner.verifyAssumptions = async () => {
      verifyCallCount++;
      // Round 1 fails; round 2 (after the auto-accepted edit) passes.
      if (verifyCallCount === 1) {
        return [{ assumption: failingAssumption, status: 'failed', evidence: 'Use schema not jsonSchema' }];
      }
      return [];
    };
    pipeline.planner.remediateAssumption = async () => ({
      revisedAssumptions: [{ text: SPEC_EDIT_NEW, phase: 'invariant', specSection: '## Session API' }],
      specEdit: { section: '## Session API', old: SPEC_EDIT_OLD, new: SPEC_EDIT_NEW },
    });

    const result = await pipeline.batchResume({});

    assert.strictEqual(executeCount, 1,
      `_executeAllMilestones should run once after remediation passes (got ${executeCount})`);
    assert.strictEqual(result.archived, 1, `Expected archived:1, got ${result.archived}`);
    assert.strictEqual(result.failed, 0, `Expected failed:0, got ${result.failed}`);
    assert.strictEqual(result.parked, 0, `Expected parked:0, got ${result.parked}`);

    // The edit was actually applied to the on-disk spec (old text replaced),
    // observed at execution time before the archive dequeued the entry.
    assert.ok(specAtExecute !== null, `execution should have run and captured the spec`);
    assert.ok(specAtExecute.includes(SPEC_EDIT_NEW) && !specAtExecute.includes(SPEC_EDIT_OLD),
      `The remediation edit should have been auto-applied to the spec. Got:\n${specAtExecute}`);

    assert.ok(
      !fs.existsSync(path.join(root, 'queue', 'remediated')),
      `Queue entry 'remediated' should be removed after successful archive`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC6 ─────────────────────────────────────────────────────────────────────
// RETIRED. The v1 hand-copy auto-accepted an edit only when the old/new
// Levenshtein similarity was >50% and REJECTED (→ failed-validation) scope
// changes at <=50%. Production batchResume has NO such gate — it auto-accepts
// every planner-proposed edit unconditionally (pipeline.js ~1171-1176; grep for
// `levenshtein`/`similarity` in src/ returns nothing). There is no production
// behavior to port this test to (the round-2 re-verify then decides park vs
// proceed, which TC4 and TC5 already cover), so TC6 is deleted rather than
// rewritten against a mechanism that no longer exists.

// ── TC7 ─────────────────────────────────────────────────────────────────────
// mixed batch: 1 archived + 1 parked → {archived:1, failed:0, parked:1}

await test('TC7: mixed batch produces correct archived/parked counts', async () => {
  const root = makeGitRoot({ prefix: 'cc-batch-resume-' });
  try {
    const goodAssumption = { text: 'Good assumption that verifies', specSection: '## Good' };
    const badAssumption  = { text: 'Bad assumption that always fails', specSection: '## Bad' };

    createQueueEntry(root, 'good-spec', {
      plan: makePlan({ assumptions: [goodAssumption] }),
      validatedAt: '2026-03-01T00:00:00.000Z',
    });
    createQueueEntry(root, 'bad-spec', {
      plan: makePlan({ assumptions: [badAssumption] }),
      validatedAt: '2026-03-02T00:00:00.000Z',
    });

    const { pipeline } = makeRealBatchPipeline(root, {
      archive: makeFakeArchive(),
    });
    pipeline.planner.verifyAssumptions = async (assumptions) => {
      const text = (assumptions || []).map((a) => (typeof a === 'string' ? a : a.text)).join(' ');
      if (text.includes('Good assumption')) return []; // good spec passes
      return [{ assumption: badAssumption, status: 'failed', evidence: 'Not found' }]; // bad spec fails
    };

    const result = await pipeline.batchResume({});

    assert.strictEqual(result.archived, 1, `Expected archived:1, got ${result.archived}`);
    assert.strictEqual(result.failed, 0, `Expected failed:0, got ${result.failed}`);
    assert.strictEqual(result.parked, 1, `Expected parked:1, got ${result.parked}`);

    // 'good-spec' removed (archived); 'bad-spec' kept with status 'parked'.
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'good-spec')),
      `'good-spec' should have been removed from queue after archiving`);
    const badEntry = readQueueEntry(root, 'bad-spec');
    assert.ok(badEntry !== null, `'bad-spec' should still be in queue`);
    assert.strictEqual(
      badEntry.status,
      'parked',
      `'bad-spec' should have status 'parked', got '${badEntry.status}'`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC8 ─────────────────────────────────────────────────────────────────────
// entries with status 'failed-validation' are skipped during iteration.
//
// PRODUCTION CONTRACT: the batch iterates `entries.filter(e => e.status ===
// 'pending')` — a failed-validation entry is never selected and is left
// untouched on disk (status + queue dir preserved).

await test('TC8: entries with status "failed-validation" are skipped and left untouched', async () => {
  const root = makeGitRoot({ prefix: 'cc-batch-resume-' });
  try {
    createQueueEntry(root, 'already-failed', {
      plan: makePlan({ assumptions: [{ text: 'Previously failed', specSection: '## X' }] }),
      status: 'failed-validation',
    });
    createQueueEntry(root, 'pending-spec', {
      plan: makePlan({ assumptions: [{ text: 'Fresh assumption', specSection: '## Y' }] }),
      status: 'pending',
    });

    let verifyCallCount = 0;
    let executeCount = 0;
    const { pipeline } = makeRealBatchPipeline(root, {
      archive: makeFakeArchive(),
      executeAllMilestones: async () => { executeCount++; },
    });
    pipeline.planner.verifyAssumptions = async () => { verifyCallCount++; return []; };

    const result = await pipeline.batchResume({});

    // Only the pending entry ran.
    assert.strictEqual(result.archived, 1, `Expected archived:1 (only pending-spec), got ${result.archived}`);
    assert.strictEqual(result.failed, 0, `Expected failed:0, got ${result.failed}`);
    assert.strictEqual(result.parked, 0, `Expected parked:0, got ${result.parked}`);
    assert.strictEqual(executeCount, 1, `_executeAllMilestones should run once (pending-spec)`);
    // verifyAssumptions must run at most once — the failed-validation entry is
    // never selected, so it is never verified.
    assert.ok(verifyCallCount <= 1,
      `verifyAssumptions should run at most once (pending-spec only). Got ${verifyCallCount}`);

    // 'pending-spec' archived + removed.
    assert.ok(!readQueueEntry(root, 'pending-spec'), `'pending-spec' should be removed after archive`);

    // 'already-failed' untouched: same status, queue dir intact.
    const failedEntry = readQueueEntry(root, 'already-failed');
    assert.ok(failedEntry !== null, `'already-failed' should still be in queue`);
    assert.strictEqual(failedEntry.status, 'failed-validation',
      `'already-failed' status should remain 'failed-validation', got '${failedEntry.status}'`);
    assert.ok(fs.existsSync(path.join(root, 'queue', 'already-failed')),
      `'already-failed' queue dir must stay intact`);
  } finally {
    cleanup(root);
  }
});

// ── TC9 ─────────────────────────────────────────────────────────────────────
// entries with status 'failed-execution' are skipped during iteration.
//
// Same pending-only filter as TC8, exercised end-to-end through the REAL
// batchResume (the v1 test only re-implemented the filter expression inline and
// guarded nothing). The failed-execution entry must be left untouched on disk.

await test('TC9: entries with status "failed-execution" are skipped and left untouched', async () => {
  const root = makeGitRoot({ prefix: 'cc-batch-resume-' });
  try {
    createQueueEntry(root, 'exec-failed', {
      plan: makePlan({ assumptions: [{ text: 'Exec-failed assumption', specSection: '## X' }] }),
      status: 'failed-execution',
    });
    createQueueEntry(root, 'pending-slug', {
      plan: makePlan({ assumptions: [{ text: 'Pending assumption', specSection: '## Y' }] }),
      status: 'pending',
    });

    let executeCount = 0;
    const { pipeline } = makeRealBatchPipeline(root, {
      archive: makeFakeArchive(),
      executeAllMilestones: async () => { executeCount++; },
    });
    pipeline.planner.verifyAssumptions = async () => [];

    const result = await pipeline.batchResume({});

    // Only the pending entry ran and archived.
    assert.strictEqual(result.archived, 1, `Expected archived:1 (only pending-slug), got ${result.archived}`);
    assert.strictEqual(result.failed, 0, `Expected failed:0, got ${result.failed}`);
    assert.strictEqual(result.parked, 0, `Expected parked:0, got ${result.parked}`);
    assert.strictEqual(executeCount, 1, `_executeAllMilestones should run once (pending-slug)`);
    assert.ok(!readQueueEntry(root, 'pending-slug'), `'pending-slug' should be removed after archive`);

    // 'exec-failed' untouched: same status, queue dir intact (skipped, not deleted).
    const failedEntry = readQueueEntry(root, 'exec-failed');
    assert.ok(failedEntry !== null, `'exec-failed' should still exist on disk`);
    assert.strictEqual(failedEntry.status, 'failed-execution',
      `'exec-failed' status must remain 'failed-execution', got '${failedEntry.status}'`);
    assert.ok(fs.existsSync(path.join(root, 'queue', 'exec-failed')),
      `'exec-failed' queue dir must stay intact`);
  } finally {
    cleanup(root);
  }
});

// ── TC10 ─────────────────────────────────────────────────────────────────────
// dirty working tree refuses with friendly message
//
// When git status --porcelain returns a non-empty string, batchResume must
// refuse immediately with { archived:0, failed:0 } and log a line containing
// "working tree is not clean".  The queue entry must remain untouched.

await test('TC10 — dirty working tree refuses with friendly message', async () => {
  const root = makeGitRoot({ prefix: 'cc-batch-resume-' });
  try {
    // One pending entry (so the refusal is the guard, not an empty queue).
    createQueueEntry(root, 'pending-spec', { plan: makePlan() });

    // Dirty the real tree with an untracked, non-ignored file the guard sees.
    fs.writeFileSync(path.join(root, 'dirty.txt'), 'uncommitted\n');

    const logs = [];
    const { pipeline } = makeRealBatchPipeline(root, {
      archive: async () => { throw new Error('TC10: archive should not be called'); },
      executeAllMilestones: async () => { throw new Error('TC10: execution should not run'); },
      onLog: (msg) => logs.push(msg),
    });

    const result = await pipeline.batchResume({});

    // (a) TC10: nothing archived or failed — the guard returns before the loop.
    assert.strictEqual(result.archived, 0, `TC10: expected archived:0, got ${result.archived}`);
    assert.strictEqual(result.failed, 0, `TC10: expected failed:0, got ${result.failed}`);

    // (b) TC10: refusal log names the unclean working tree.
    assert.ok(
      logs.some((l) => l.includes('working tree is not clean')),
      `TC10: expected log with "working tree is not clean". Logs:\n${logs.join('\n')}`,
    );
    // It must be the clean-tree guard, NOT the empty-queue early return.
    assert.ok(
      !logs.some((l) => /queue is empty/i.test(l)),
      `TC10: refusal must come from the clean-tree guard, not the empty-queue path. Logs:\n${logs.join('\n')}`,
    );

    // (c) TC10: the pending entry is untouched (removeQueueEntry never ran).
    const entry = readQueueEntry(root, 'pending-spec');
    assert.ok(entry !== null, 'TC10: queue entry should still exist');
    assert.strictEqual(entry.status, 'pending', `TC10: entry status unchanged, got '${entry.status}'`);
  } finally {
    cleanup(root);
  }
});

// ── TC11 ─────────────────────────────────────────────────────────────────────
// spec-boundary commit on per-spec success
//
// After a successful pipeline run, batchResume must stage all deliverables
// (excluding queue/) and commit with the headline from manifest.json.
// No git push should be issued.

await test('TC11 — spec-boundary commit on per-spec success', async () => {
  const root = makeGitRoot({ prefix: 'cc-batch-resume-' });
  try {
    // One pending entry (no assumptions — validation rounds skipped).
    createQueueEntry(root, 'my-spec', { plan: makePlan() });

    const { pipeline } = makeRealBatchPipeline(root, {
      // manifest headline differs from the slug → proves the commit subject is
      // the headline, not entry.slug.
      archive: makeFakeArchive('My headline'),
      executeAllMilestones: async () => {
        // A tracked deliverable so the spec-boundary commit has content to land.
        fs.writeFileSync(path.join(root, 'deliverable.txt'), 'shipped\n');
      },
    });

    const before = gitSubjects(root).length;
    let result;
    const pushCalls = await withGitPushCapture(async () => {
      result = await pipeline.batchResume({});
    });
    assert.strictEqual(result.archived, 1, `TC11: expected archived:1, got ${result.archived}`);

    // (a) TC11: exactly one spec-boundary commit was created.
    const subjects = gitSubjects(root);
    assert.strictEqual(subjects.length, before + 1,
      `TC11: expected exactly one new commit, got ${subjects.length - before}. Subjects: ${JSON.stringify(subjects)}`);

    // (b) TC11: its subject is the manifest headline (not the slug).
    assert.strictEqual(subjects[0], 'My headline',
      `TC11: commit subject must be the manifest headline. Got: '${subjects[0]}'`);

    // (c) TC11: the deliverable is committed and the tree is clean afterward —
    // the work is persisted by a local commit (no push, nothing left dirty).
    assert.strictEqual(porcelain(root), '',
      `TC11: tree must be clean after the spec-boundary commit. Got:\n${porcelain(root)}`);
    assert.ok(fs.existsSync(path.join(root, 'deliverable.txt')),
      'TC11: committed deliverable should remain on disk');

    // (d) TC11: the entry is dequeued after archive.
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'my-spec')),
      'TC11: queue entry should be removed after successful archive');

    // (e) TC11: NO git push was issued. The spec-boundary path persists work
    // with a LOCAL commit only; pushing to a remote is a separate action that
    // needs explicit approval. A future `git push` slipped into the commit
    // block (whose try/catch would otherwise swallow a failed push on a
    // remote-less repo) is caught here by the PATH-shim capture.
    assert.strictEqual(pushCalls.length, 0,
      `TC11: no git push must be issued on the spec-boundary commit path (push needs approval); got ${pushCalls.length}: ${JSON.stringify(pushCalls)}`);
  } finally {
    cleanup(root);
  }
});

// ── TC12 ─────────────────────────────────────────────────────────────────────
// execution-phase throw triggers park-failed-execution and
// writeQueueEntry called with status: 'failed-execution'
//
// When _executeAllMilestones throws a generic Error, batchResume must:
//   (a) call writeQueueEntry with status: 'failed-execution'
//   (b) issue git reset --hard HEAD and git clean -fd -e queue
//   (c) create a "Park failed spec <slug> (execution failure)" commit
//   (d) return failed: 1

await test('TC12 — execution-phase throw triggers park-failed-execution', async () => {
  const root = makeGitRoot({ prefix: 'cc-batch-resume-' });
  const slug = 'exec-fail-spec';
  try {
    createQueueEntry(root, slug, { plan: makePlan() });

    const { pipeline } = makeRealBatchPipeline(root, {
      archive: makeFakeArchive(),
      executeAllMilestones: async () => {
        // Half-written deliverable, then a generic execution failure.
        fs.writeFileSync(path.join(root, 'half-written.txt'), 'partial\n');
        throw new Error('boom');
      },
    });

    const result = await pipeline.batchResume({});

    // (a) TC12: the entry is re-queued status 'failed-execution' (status-only).
    const entry = readQueueEntry(root, slug);
    assert.ok(entry !== null, 'TC12: queue entry should still exist after failed-execution');
    assert.strictEqual(entry.status, 'failed-execution',
      `TC12: expected status 'failed-execution', got '${entry.status}'`);

    // (b) TC12: the forensic park commit landed in real git history.
    const subjects = gitSubjects(root);
    assert.ok(
      subjects.some((s) => s === `Park failed spec ${slug} (execution failure)`),
      `TC12: expected a "Park failed spec ${slug} (execution failure)" commit. Subjects: ${JSON.stringify(subjects)}`,
    );

    // (c) TC12: the tree is reverted clean and the half-written WIP is gone.
    assert.strictEqual(porcelain(root), '',
      `TC12: tree must be clean after the failed-execution revert. Got:\n${porcelain(root)}`);
    assert.ok(!fs.existsSync(path.join(root, 'half-written.txt')),
      'TC12: the half-written deliverable must be reverted');

    // (d) TC12: return value has failed: 1
    assert.strictEqual(result.failed, 1, `TC12: expected failed:1, got ${result.failed}`);
  } finally {
    cleanup(root);
  }
});

// ── TC12b ─────────────────────────────────────────────────────────────────────
// InfrastructureError rethrows without writing failed-execution or git reset
//
// When _executeAllMilestones throws an InfrastructureError, batchResume must
// rethrow it immediately.  It must NOT write status:'failed-execution' and must
// NOT issue git reset --hard HEAD.

await test('TC12b — InfrastructureError rethrows without writing failed-execution', async () => {
  const root = makeGitRoot({ prefix: 'cc-batch-resume-' });
  const slug = 'infra-fail-spec';
  try {
    createQueueEntry(root, slug, { plan: makePlan() });

    const infraErr = new InfrastructureError('network failure', {
      category: 'network',
      retryable: true,
      statusCode: undefined,
      cause: new Error('original network error'),
    });

    const { pipeline } = makeRealBatchPipeline(root, {
      // archive() must never be reached — InfrastructureError rethrows before
      // the forensic-archive leg.
      archive: async () => { throw new Error('TC12b: archive must not be called'); },
      executeAllMilestones: async () => { throw infraErr; },
    });

    // TC12b: batchResume rethrows InfrastructureError (does NOT swallow it).
    await assert.rejects(
      () => pipeline.batchResume({}),
      InfrastructureError,
      'TC12b: expected batchResume to rethrow InfrastructureError',
    );

    // TC12b: the entry was NOT re-queued as failed-execution — it stays pending.
    const entry = readQueueEntry(root, slug);
    assert.ok(entry !== null, 'TC12b: queue entry should still exist');
    assert.strictEqual(entry.status, 'pending',
      `TC12b: entry must remain 'pending' (no failed-execution write). Got: '${entry.status}'`);

    // TC12b: no park/failed-execution commit was created (the rethrow precedes
    // the forensic-archive + reset leg entirely).
    const subjects = gitSubjects(root);
    assert.ok(
      !subjects.some((s) => /Park failed spec/.test(s)),
      `TC12b: expected NO park commit. Subjects: ${JSON.stringify(subjects)}`,
    );
  } finally {
    cleanup(root);
  }
});

// ── TC13 ─────────────────────────────────────────────────────────────────────
// batch=true + unresumable state → batchResume runs, '=== Batch Resume Complete ===' appears
//
// When flags.batch is true, resume.js skips the isUnresumableState guard entirely
// (the guard is inside `if (!flags.batch) { … }`).  Therefore batchResume must be
// reached and run to completion even when state.json contains an unresumable shape.

await test('TC13 — batch=true + unresumable state → batchResume executes, no exit(76)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-batch-resume-tc9-'));
  const origBatchResume = Pipeline.prototype.batchResume;
  const origExit = process.exit;
  try {
    // Bootstrap + claim a REAL per-run active-run harness dir (the batch run's
    // resolved harness dir), then overwrite its state.json with the exact
    // unresumable-state shape: globalStatus:'active', currentPhase:'planning',
    // milestones:{}.
    makeRun(root, { slug: 'tc13-unresumable', kind: 'batch' });
    const harnessDir = activeHarnessDir(root);
    fs.writeFileSync(
      path.join(harnessDir, 'state.json'),
      JSON.stringify({
        globalStatus: 'active',
        projectMeta: { currentPhase: 'planning' },
        milestones: {},
      }),
    );

    // Stub batchResume to succeed immediately (no real Claude sessions needed).
    // batch=true means the unresumable-state guard is bypassed, so batchResume
    // must be reached and complete without process.exit(76).
    Pipeline.prototype.batchResume = async function stubBatchResume() {
      return { archived: 0, failed: 0 };
    };

    // Capture any unexpected exit codes but do NOT throw — we expect no exit(76).
    const capturedExitCodes = [];
    process.exit = (code) => {
      capturedExitCodes.push(code);
      throw new Error(`Unexpected process.exit(${code})`);
    };

    let stdout = '';
    ({ stdout } = await captureOutput(async () => {
      await resume(root, { batch: true, auto: true });
    }));

    // (1) '=== Batch Resume Complete ===' must appear — confirms batchResume ran
    assert.ok(
      stdout.includes('Batch Resume Complete'),
      `Expected '=== Batch Resume Complete ===' in stdout. Got:\n${stdout}`,
    );

    // (2) process.exit(76) must NOT have been called — guard is skipped for batch mode
    assert.ok(
      !capturedExitCodes.includes(76),
      `process.exit(76) must NOT be called in batch mode. Got exit codes: [${capturedExitCodes.join(', ')}]`,
    );
  } finally {
    process.exit = origExit;
    Pipeline.prototype.batchResume = origBatchResume;
    cleanup(root);
  }
});

// ── TC14 ────────────────────────────────────────────────────────────────────
// batch=false + unresumable state → process.exit(76) called, stderr contains 'cc-orch run'
//
// When flags.batch is false (or absent), resume.js reads state.json and calls
// process.exit(76) if the state is unresumable.  This is the guard that batch
// mode intentionally bypasses.

await test('TC14 — batch=false + unresumable state → process.exit(76) called, stderr contains cc-orch run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-batch-resume-tc10-'));
  const origBatchResume = Pipeline.prototype.batchResume;
  const origExit = process.exit;
  try {
    // Same unresumable state shape as TC13, bootstrapped via makeRun so
    // harnessDir resolves through activeHarnessDir(root) rather than a
    // hardcoded flat '.harness'. claim:false — this guard (resume.js's
    // `if (!flags.batch)` pre-flight) intentionally reads the FLAT
    // .harness/state.json regardless of any active-run pointer, so no
    // active-run pointer is claimed here and activeHarnessDir(root) resolves
    // to that same flat root (no validated active run to prefer).
    makeRun(root, { slug: 'tc14-unresumable', kind: 'batch', claim: false });
    const harnessDir = activeHarnessDir(root);
    fs.writeFileSync(
      path.join(harnessDir, 'state.json'),
      JSON.stringify({
        globalStatus: 'active',
        projectMeta: { currentPhase: 'planning' },
        milestones: {},
      }),
    );

    // Patch batchResume to throw if it is somehow reached (it must NOT be, because
    // process.exit(76) should fire before the pipeline call).
    Pipeline.prototype.batchResume = async function patchedBatchResume() {
      throw new Error('batchResume reached after unresumable-state guard — should not happen');
    };

    // Capture ALL exit codes; throw a sentinel so async execution unwinds after the
    // first exit call (mirroring original TC14 pattern).
    const capturedExitCodes = [];
    const sentinel = new Error('__SENTINEL_EXIT__');
    process.exit = (code) => {
      capturedExitCodes.push(code);
      throw sentinel;
    };

    let stdout = '';
    let stderr = '';
    ({ stdout, stderr } = await captureOutput(async () => {
      // batch: false → the isUnresumableState guard is active
      await resume(root, { batch: false, auto: true });
    }));

    // (1) process.exit must have been called with code 76
    assert.ok(
      capturedExitCodes.includes(76),
      `Expected process.exit(76) to be called. Got exit codes: [${capturedExitCodes.join(', ')}]`,
    );

    // (2) stderr must contain the 'cc-orch run' recovery hint
    assert.ok(
      stderr.includes('cc-orch run'),
      `Expected stderr to contain 'cc-orch run'. Got:\n${stderr}`,
    );

    // (3) '=== Batch Resume Complete ===' must NOT appear — the pipeline never ran
    assert.ok(
      !stdout.includes('Batch Resume Complete'),
      `'Batch Resume Complete' must NOT appear when state is unresumable. stdout:\n${stdout}`,
    );
  } finally {
    process.exit = origExit;
    Pipeline.prototype.batchResume = origBatchResume;
    cleanup(root);
  }
});

// ── TC15 ────────────────────────────────────────────────────────────────────
// Pipeline constructor receives pipelineOpts without autoMode key
//
// resume.js stores the flags.auto value in a local variable `autoMode` that
// it uses to configure callbacks (onConfirm, onMenu) inside pipelineOpts.
// The `autoMode` variable itself must NOT be forwarded as a key in pipelineOpts
// — Pipeline does not recognise it and it would represent a leaking internal
// detail.  This test confirms:
//   (a) the pipeline instance has no `autoMode` own property (Pipeline never
//       stores an unrecognised opts key on `this`)
//   (b) auto mode behaviour IS present via onConfirm (proving flags.auto=true
//       was correctly translated to the recognised `onConfirm` opt)

await test('TC15 — Pipeline constructor receives pipelineOpts without autoMode key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-batch-resume-tc11-'));
  const origBatchResume = Pipeline.prototype.batchResume;
  const origExit = process.exit;
  try {
    // Bootstrap + claim a REAL per-run active-run harness dir so Logger can
    // initialise (batch mode skips the unresumable-state guard so the state
    // shape does not matter here); harnessDir resolves through
    // activeHarnessDir(root) to the batch run's real per-run harness dir.
    makeRun(root, { slug: 'tc15-autoMode', kind: 'batch' });
    const harnessDir = activeHarnessDir(root);
    fs.writeFileSync(
      path.join(harnessDir, 'state.json'),
      JSON.stringify({
        globalStatus: 'active',
        projectMeta: { currentPhase: 'planning' },
        milestones: {},
      }),
    );

    // Stub batchResume to capture the pipeline instance (`this`) and resolve
    // immediately — no real Claude sessions or filesystem queue needed.
    let capturedPipeline = null;
    Pipeline.prototype.batchResume = async function stubBatchResume() {
      capturedPipeline = this;
      return { archived: 0, failed: 0 };
    };

    // Safety net: catch any unexpected exits without silently passing.
    process.exit = (code) => {
      throw new Error(`Unexpected process.exit(${code}) in TC15`);
    };

    await captureOutput(async () => {
      await resume(root, { auto: true, batch: true });
    });

    // Pipeline instance must have been created and batchResume invoked.
    assert.ok(
      capturedPipeline !== null,
      'Expected batchResume to be called (Pipeline instance was created)',
    );

    // (1) The pipelineOpts passed to new Pipeline() must NOT have contained an
    // 'autoMode' key.  Pipeline processes and stores each recognised opt as an
    // own property (e.g. this.dryRun, this.noReview, this.skipReview).  It
    // never stores opts.autoMode — so the absence of an 'autoMode' own property
    // on the instance confirms resume.js did not include autoMode in pipelineOpts.
    assert.ok(
      !Object.hasOwn(capturedPipeline, 'autoMode'),
      'Pipeline instance must not have an autoMode own property — ' +
      'resume.js should NOT include autoMode as a key in pipelineOpts',
    );

    // (2) Auto mode behaviour must still be present via the recognised onConfirm
    // opt: calling pipeline.onConfirm() should auto-accept (return true) because
    // flags.auto=true was correctly translated to `onConfirm: async () => true`.
    const confirmResult = await capturedPipeline.onConfirm('test question');
    assert.strictEqual(
      confirmResult,
      true,
      `Expected onConfirm to auto-accept (return true) in auto mode. Got: ${JSON.stringify(confirmResult)}`,
    );
  } finally {
    process.exit = origExit;
    Pipeline.prototype.batchResume = origBatchResume;
    cleanup(root);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
