#!/usr/bin/env node
/**
 * test-batch-failure-input-boundary.js — Batch-failure evidence/type fidelity
 * and spec-input boundary tests (spec: w4-batch-failure-input-boundary).
 *
 * Written by the INDEPENDENT test author against the spec contract only. At a
 * pre-fix HEAD the behavioral cases MUST fail for behavioral reasons:
 *   - AC1: the failure-path `git clean -fd -e queue` deletes the just-created
 *          forensic archive in a tracked-archives project when the park commit
 *          fails for a real reason; a real commit failure is swallowed silently
 *          (no loud log); a contamination-guard probe failure self-disables.
 *   - AC2: a CircuitBreakerError fired on a NON-FINAL task of a multi-task
 *          milestone is stripped of its type by the scheduler stall wrap, so the
 *          batch entry lands as 'failed-execution' (no park scene) instead of
 *          'halted-analyzer'; regression pseudo-task history outcomes stay null.
 *   - AC3: dry-running a non-.md file is accepted, then the project-root
 *          spec.json is copied into the queue entry AND unlinked from the root.
 *
 * Coverage (numbered after the spec's acceptance criteria):
 *   AC1a — tracked-archives git repo, real park-commit failure (no git
 *          identity): the forensic archive under archives/ SURVIVES the
 *          failure-path revert (git reset --hard + git clean), and the git
 *          error is logged loudly. Entry still ends 'failed-execution', batch
 *          continues.  RED at HEAD: the clean deletes archives/.
 *   AC1b — benign nothing-to-commit park commit stays SILENT (no loud
 *          "Park commit failed" log) — distinguishes the benign case from a
 *          real failure.
 *   AC1c — _assertBatchTreeClean probe failure in a confirmed-git batch ABORTS
 *          the batch loudly (fail-closed) instead of self-disabling the guard.
 *   AC2  — CircuitBreakerError on a non-final task of a MULTI-TASK milestone,
 *          crossing the REAL scheduler drain (scheduler.runMilestone runs, the
 *          stall branch throws), still routes the batch entry to
 *          'halted-analyzer' WITH a park scene; the regression pseudo-task
 *          (regression-ms-<id>) history entries get their outcome back-filled.
 *   AC3a — dry-run of a non-.md input is rejected with an honest error naming
 *          the .md requirement; nothing queued.
 *   AC3b — the project-root spec.json is NEVER copied into a queue entry nor
 *          unlinked for a non-.md input (a real root spec.json is staged and
 *          asserted to survive byte-identically and unreferenced).
 *
 * Run: node test/test-batch-failure-input-boundary.js
 *
 * No live Claude sessions are spawned — all agent interactions are stubbed at
 * narrow seams. AC2 stubs ONLY the analyzer LLM session and the per-task
 * runTask body (_executeAndVerifyTask); the scheduler's runMilestone / stall
 * drain, the batch catch routing, the park layer, and the real forensic-archive
 * chain all run un-stubbed (this is what TC6a in test-analyzer-closure.js
 * MASKED by stubbing _executeAllMilestones and never reaching the scheduler).
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeQueueEntry, readQueueEntry } from '../src/orchestrator/core/state.js';
import { Analyzer } from '../src/orchestrator/agents/analyzer.js';
import { readAnalysisHistory } from '../src/orchestrator/agents/analyzer.js';

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

// ── Fixture data ───────────────────────────────────────────────────────────

// Deliberately scope-item-free markdown (no '## Scope — in', no **Bug N**
// bullets, no scope-item markers, no backticked paths) so _scopeCoverageGate
// skips — mirrors test/test-batch-failure-crash-safety.js.
const SPEC_MD = `# Test Spec

This is a test spec for the batch failure / input-boundary paths.

## Goals
- Build something useful
`;

// Parseable sibling json so the uncheckable-spec gate passes.
const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

function makeTmpRoot(prefix = 'cc-orch-bfib-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Git fixture with archives/ TRACKED (NOT gitignored) — the AC1 precondition.
// Identity is set so the tree starts clean; AC1a unsets it afterward to make
// the park commit fail for a real reason.
function makeTrackedArchivesGitRoot(prefix = 'cc-orch-bfib-tracked-') {
  const root = makeTmpRoot(prefix);
  execSync('git init', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed content\n');
  // NOTE: archives/ deliberately ABSENT from .gitignore — the failure path must
  // attempt the park commit (archives/ is tracked).
  fs.writeFileSync(path.join(root, '.gitignore'), 'queue/\n.harness/\n');
  execSync('git add -A', { cwd: root, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: root, stdio: 'pipe' });
  return root;
}

// Standard git fixture (archives/ gitignored) for the AC1c contamination probe.
function makeGitRoot(prefix = 'cc-orch-bfib-git-') {
  const root = makeTmpRoot(prefix);
  execSync('git init', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed content\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'queue/\narchives/\n.harness/\n');
  execSync('git add -A', { cwd: root, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: root, stdio: 'pipe' });
  return root;
}

function createQueueEntry(root, slug, {
  spec = SPEC_MD,
  // Fresh-run shape: a goal-only entry.plan carries scopeItems:[]/scopeMapping:[]
  // (present-and-empty → gate skips). Absent the key, the gate treats it as a
  // LEGACY plan and fail-closes before this test's behavior runs.
  plan = { milestones: [], assumptions: [], scopeItems: [], scopeMapping: [] },
  validatedAt = new Date().toISOString(),
  status = 'pending',
  specJson = SPEC_JSON,
} = {}) {
  writeQueueEntry(root, slug, { spec, plan, validatedAt, status, specJson });
}

// ─────────────────────────────────────────────────────────────────────────
// AC1a — tracked-archives repo + REAL park-commit failure: forensic archive
//        survives the failure-path revert; the git error is logged loudly.
// ─────────────────────────────────────────────────────────────────────────

await test('AC1a: tracked archives/ + real park-commit failure (failing pre-commit hook) → forensic archive SURVIVES the failure-path clean, git error logged loudly, entry failed-execution, batch continues', async () => {
  const root = makeTrackedArchivesGitRoot();
  try {
    createQueueEntry(root, 'fail-a', { validatedAt: '2026-06-01T00:00:00.000Z' });
    createQueueEntry(root, 'fail-b', { validatedAt: '2026-06-02T00:00:00.000Z' });

    // Make the park commit fail for a REAL reason: a failing pre-commit hook
    // (deterministic and git-version-independent — note `git commit` does NOT
    // fail on a missing user.name/email on many systems because git derives a
    // fallback identity from EMAIL/hostname). The hook aborts the commit with a
    // non-zero exit and a distinctive message; `git add` succeeds first, so the
    // archive is staged-then-unstaged by the revert — the survival assertion is
    // load-bearing.
    const hooksDir = path.join(root, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "AC1A-HOOK-REJECT pre-commit hook failed on purpose" >&2\nexit 1\n');
    fs.chmodSync(hookPath, 0o755);

    const logs = [];
    // Forensic-archive seam: create a REAL tracked archive under archives/ so
    // the park-commit + clean operate on actual on-disk evidence.
    const archiveStub = async (_projectRoot, slug, archiveOpts) => {
      if (archiveOpts && archiveOpts['include-failed']) {
        const dir = path.join(root, 'archives', `failed-${slug}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ slug, forensic: true }));
        fs.writeFileSync(path.join(dir, 'spec.md'), SPEC_MD);
        return dir;
      }
      const dir = path.join(root, 'fake-archives', String(Date.now()));
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };

    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      statusBar: false,
      onLog: (msg) => logs.push(msg),
      onConfirm: async () => true,
      archive: archiveStub,
    });
    pipeline.planner.verifyAssumptions = async () => [];
    pipeline.planner.closeReusableSession = async () => {};
    pipeline._reviewGate = async () => {};

    let executeCount = 0;
    pipeline._executeAllMilestones = async () => {
      executeCount++;
      if (executeCount === 1) throw new Error('milestone execution exploded');
    };

    const result = await pipeline.batchResume({});

    // The forensic archive must SURVIVE the failure-path revert. At HEAD the
    // clean (`git clean -fd -e queue`) deletes the freshly-created, never-
    // committed archives/ tree — this assertion fails until `-e archives` is
    // added to the failure-path clean.
    const forensicDir = path.join(root, 'archives', 'failed-fail-a');
    assert.ok(fs.existsSync(forensicDir),
      'the forensic archive directory must survive the failure-path revert (at HEAD the failure-path `git clean` deletes it)');
    assert.ok(fs.existsSync(path.join(forensicDir, 'manifest.json')),
      'the forensic archive manifest.json must survive the clean');
    assert.ok(fs.existsSync(path.join(forensicDir, 'spec.md')),
      'the forensic archive spec.md copy must survive the clean');

    // The real commit failure must be logged LOUDLY (not swallowed silently).
    assert.ok(
      logs.some((l) => /park commit failed/i.test(l)),
      `a real park-commit failure must be logged loudly with the git error (logs: ${JSON.stringify(logs.filter((l) => /commit|park/i.test(l)))})`
    );

    // Conservative failure semantics unchanged: the entry still fails, the
    // batch still continues to the second entry.
    assert.strictEqual(result.failed, 1, `expected failed:1, got ${result.failed}`);
    assert.strictEqual(executeCount, 2,
      `_executeAllMilestones must run for BOTH entries — the batch continues past the failure (got ${executeCount})`);
    const entry = readQueueEntry(root, 'fail-a');
    assert.ok(entry, "entry 'fail-a' must still exist in the queue");
    assert.strictEqual(entry.status, 'failed-execution',
      `entry 'fail-a' expected status 'failed-execution', got '${entry.status}'`);
  } finally {
    cleanup(root);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// AC1b — benign nothing-to-commit park commit stays SILENT.
//        Distinguishes the benign case (no loud log) from AC1a's real failure.
// ─────────────────────────────────────────────────────────────────────────

await test('AC1b: benign nothing-to-commit park commit stays SILENT — no loud "Park commit failed" log', async () => {
  const root = makeTrackedArchivesGitRoot();
  try {
    // Pre-create and COMMIT an archives/ dir (tracked, already committed) so the
    // benign path is reachable: on the failure path `git add archives/` succeeds
    // as a no-op (nothing new), and `git commit` reports the benign "nothing to
    // commit" — which the fix must swallow SILENTLY. (A forensic archive that
    // creates no new files is the realistic trigger.)
    const archivesDir = path.join(root, 'archives');
    fs.mkdirSync(archivesDir, { recursive: true });
    fs.writeFileSync(path.join(archivesDir, '.gitkeep'), '');
    execSync('git add archives/.gitkeep', { cwd: root, stdio: 'pipe' });
    execSync('git commit -m "track archives"', { cwd: root, stdio: 'pipe' });

    createQueueEntry(root, 'benign-a', { validatedAt: '2026-06-01T00:00:00.000Z' });

    const logs = [];
    // Forensic archive produces NOTHING NEW under archives/ (returns a dir
    // outside archives/) → `git add archives/` is a no-op → `git commit` →
    // benign "nothing to commit". Identity intact, no hook → purely benign.
    const archiveStub = async (_projectRoot, slug, archiveOpts) => {
      if (archiveOpts && archiveOpts['include-failed']) {
        const dir = path.join(root, 'fake-archives', `forensic-${slug}`);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      }
      const dir = path.join(root, 'fake-archives', String(Date.now()));
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };

    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      statusBar: false,
      onLog: (msg) => logs.push(msg),
      onConfirm: async () => true,
      archive: archiveStub,
    });
    pipeline.planner.verifyAssumptions = async () => [];
    pipeline.planner.closeReusableSession = async () => {};
    pipeline._reviewGate = async () => {};
    pipeline._executeAllMilestones = async () => {
      throw new Error('milestone execution exploded');
    };

    const result = await pipeline.batchResume({});

    assert.strictEqual(result.failed, 1, `expected failed:1, got ${result.failed}`);

    // The benign nothing-to-commit case must NOT raise the loud real-failure
    // log. (After the fix the distinguisher is: real error → loud; nothing to
    // commit → silent. This pins the silent half.)
    assert.ok(
      !logs.some((l) => /park commit failed/i.test(l)),
      `the benign nothing-to-commit case must stay SILENT (no loud "Park commit failed" log; got: ${JSON.stringify(logs.filter((l) => /park commit/i.test(l)))})`
    );

    const entry = readQueueEntry(root, 'benign-a');
    assert.strictEqual(entry.status, 'failed-execution',
      `entry 'benign-a' expected 'failed-execution', got '${entry.status}'`);
  } finally {
    cleanup(root);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// AC1c — contamination guard: a probe failure in a confirmed-git batch ABORTS
//        loudly (fail-closed) instead of self-disabling.
// ─────────────────────────────────────────────────────────────────────────

await test('AC1c: a contamination-guard probe failure in a confirmed-git batch ABORTS loudly (fail-closed) — driven through the real batch failure path so the batch is genuinely confirmed-git at start', async () => {
  // Signature-agnostic, non-vacuous: the batch is confirmed-git at start (real
  // repo). On the failure path, the forensic-archive seam corrupts .git so the
  // guard's OWN `git status --porcelain` probe throws when _assertBatchTreeClean
  // runs. The contract: a probe failure in a confirmed-git batch must FAIL
  // CLOSED (abort the batch), not self-disable (swallow-and-return). At HEAD the
  // guard catches its probe error and returns → batchResume RESOLVES → this
  // case fails (no rejection). After the fix it rejects.
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'probe-fail', { validatedAt: '2026-06-01T00:00:00.000Z' });

    const logs = [];
    const gitDir = path.join(root, '.git');
    const gitAside = path.join(root, '.git-aside');

    // Forensic-archive seam: produce nothing AND corrupt git (rename .git
    // aside) so the failure-path revert's later `git status` probe inside
    // _assertBatchTreeClean throws. archive() runs before the revert + guard.
    const archiveStub = async (_projectRoot, slug, archiveOpts) => {
      if (archiveOpts && archiveOpts['include-failed']) {
        if (fs.existsSync(gitDir)) fs.renameSync(gitDir, gitAside);
        throw new Error('forensic archive produced nothing');
      }
      const dir = path.join(root, 'fake-archives', String(Date.now()));
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };

    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      statusBar: false,
      onLog: (msg) => logs.push(msg),
      onConfirm: async () => true,
      archive: archiveStub,
    });
    pipeline.planner.verifyAssumptions = async () => [];
    pipeline.planner.closeReusableSession = async () => {};
    pipeline._reviewGate = async () => {};
    pipeline._executeAllMilestones = async () => {
      throw new Error('milestone execution exploded');
    };

    let thrown = null;
    try {
      await pipeline.batchResume({});
    } catch (err) {
      thrown = err;
    } finally {
      // Restore .git so cleanup is well-behaved.
      try { if (fs.existsSync(gitAside) && !fs.existsSync(gitDir)) fs.renameSync(gitAside, gitDir); } catch { /* ignore */ }
    }

    assert.ok(thrown,
      'a contamination-guard probe failure in a confirmed-git batch must FAIL CLOSED (batchResume rejects); at HEAD the guard self-disables on its own probe error and the batch resolves normally');
    assert.ok(thrown instanceof Error, `expected an Error, got ${typeof thrown}`);

    // The aborting entry must already be marked failed on disk before the abort.
    const entry = readQueueEntry(root, 'probe-fail');
    assert.ok(entry, "entry 'probe-fail' must still exist in the queue");
    assert.strictEqual(entry.status, 'failed-execution',
      `the entry must be marked 'failed-execution' before the abort propagates, got '${entry.status}'`);
  } finally {
    cleanup(root);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// AC2 — CircuitBreakerError on a NON-FINAL task of a MULTI-TASK milestone,
//       crossing the REAL scheduler drain, routes to 'halted-analyzer' with a
//       park scene; regression pseudo-task history outcomes get back-filled.
//
// This is the case the prior spec's TC6a MASKED by stubbing
// _executeAllMilestones (it called _dispatchAnalyzer directly and threw,
// NEVER reaching scheduler.runMilestone). Here scheduler.runMilestone runs for
// real: task A throws a human-verdict CircuitBreakerError, task B depends on A
// and stays pending, so the scheduler reaches the STALL branch and throws the
// fresh terminal error. At HEAD that fresh error strips the CircuitBreakerError
// type → the batch catch keys `instanceof CircuitBreakerError` on a generic
// Error → routes to 'failed-execution' with NO park scene (the bug). After the
// fix the stall throw carries the original as `cause` and the batch catch
// resolves it via err.cause → 'halted-analyzer' + scene.
// ─────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(new URL(import.meta.url).pathname);

/** Real Analyzer with ONLY the LLM-session seam stubbed (returns a crafted
 *  structured verdict). Mirrors makeAnalyzerHarness in test-analyzer-closure.js. */
function makeAnalyzer(verdictForCall) {
  const spawnCalls = [];
  const sessionManager = {
    spawn(opts) {
      spawnCalls.push(opts);
      const structured = verdictForCall(spawnCalls.length, opts);
      const handle = { systemPromptTokens: 0, _toolCallCount: 0 };
      const p = Promise.resolve({ handle, result: { structured_output: structured } });
      p.handle = handle;
      return p;
    },
  };
  const logger = {
    createSessionLog: () => ({ logPath: path.join(os.tmpdir(), 'bfib-analyzer-fake.log'), close() {} }),
    attachToSession() {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
    warn() {},
  };
  return { analyzer: new Analyzer(sessionManager, logger, null), spawnCalls };
}

function humanVerdict() {
  return {
    recommendation: 'human',
    rootCause: 'AC2-ROOT-CAUSE the executor produced nothing on the non-final task',
    failureType: 'verification',
    affectedTasks: [],
    evidence: 'AC2-EVIDENCE verifier sidecar empty after retries',
    notes: '',
  };
}

const MILESTONE_PLAN = {
  milestones: [{ id: '001', description: 'Halt milestone', missions: [{ id: '001-001', description: 'Mission one' }] }],
  assumptions: [],
  // Scope-free fresh run: present-and-empty scope set so the gate skips (no
  // '## Scope — in' in this fixture's spec → zero items). Absent → legacy fail-close.
  scopeItems: [],
  scopeMapping: [],
};

function readSceneRaw(root, slug) {
  const p = path.join(root, 'queue', slug, 'park.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

await test("AC2: CircuitBreakerError on a non-final task of a multi-task milestone — crossing the REAL scheduler drain — routes to 'halted-analyzer' WITH a park scene; regression-ms-<id> history outcomes back-filled", async () => {
  const root = makeGitRoot('cc-orch-bfib-ac2-');
  try {
    createQueueEntry(root, 'halt-drain', {
      plan: MILESTONE_PLAN,
      validatedAt: '2026-06-01T00:00:00.000Z',
    });
    createQueueEntry(root, 'continue-after', {
      plan: MILESTONE_PLAN,
      validatedAt: '2026-06-02T00:00:00.000Z',
    });

    const logs = [];
    // NO `archive` injection on the halt entry path: the REAL forensic-archive
    // chain must run for the halted-analyzer entry. The second entry is parked
    // pre-execution (its drain throws too) — to keep it deterministic we let it
    // halt the same way.
    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      statusBar: false,
      onLog: (msg) => logs.push(msg),
      onConfirm: async () => true,
    });
    const { analyzer } = makeAnalyzer(() => humanVerdict());
    pipeline.analyzer = analyzer;
    pipeline.planner.verifyAssumptions = async () => [];
    pipeline.planner.remediateAssumption = async () => ({ specEdit: { old: '', new: '' }, revisedAssumptions: [] });
    pipeline.planner.reExtractAssumptions = async () => [];
    pipeline.planner.replanTask = async () => ({ replacementTasks: [] });
    pipeline.planner.closeReusableSession = async () => {};
    pipeline._reviewGate = async () => {};

    // runTask body seam: per-task. Task A (non-final) drives the REAL
    // _dispatchAnalyzer (real Analyzer, human verdict → CircuitBreakerError).
    // Task B depends on A → never assignable → stays pending. We do NOT touch
    // the scheduler: runMilestone, its assignment loop, the firstError gate,
    // and the stall throw all run for real.
    const TASK_A = { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', description: 'non-final task', targetFiles: ['src/a.js'], dependencies: [] };
    const TASK_B = { id: '001-001-001-002', missionId: '001-001', subMissionId: '001-001-001', description: 'final dependent task', targetFiles: ['src/b.js'], dependencies: [{ type: 'hard', taskId: '001-001-001-001' }] };

    let dispatchedB = 0;
    pipeline._executeAndVerifyTask = async (_missionId, _subMissionId, task) => {
      if (task.id === TASK_A.id) {
        // Dirty the tracked tree so the (unchanged) revert is observable.
        fs.writeFileSync(path.join(root, 'seed.txt'), 'CONTAMINATED\n');
        // Real analyzer dispatch — human verdict throws a CircuitBreakerError.
        await pipeline._dispatchAnalyzer(task, 'verification', 3);
        return;
      }
      // Task B must never run (it depends on the failed task A).
      dispatchedB++;
    };

    // _executeAllMilestones is replaced by a thin driver that invokes the REAL
    // scheduler.runMilestone over the multi-task DAG, so the genuine drain +
    // stall path runs. This is NOT the masked TC6a pattern (which bypassed the
    // scheduler entirely): scheduler.runMilestone is the real implementation.
    pipeline._executeAllMilestones = async () => {
      await pipeline.scheduler.runMilestone('001', [TASK_A, TASK_B]);
    };

    await pipeline.batchResume({});

    // THE classification: 'halted-analyzer', not 'failed-execution'. RED at
    // HEAD: the stall wrap strips the CircuitBreakerError type so the entry
    // lands as 'failed-execution' with no scene.
    const statusOnDisk = fs.readFileSync(path.join(root, 'queue', 'halt-drain', 'status'), 'utf8').trim();
    assert.strictEqual(statusOnDisk, 'halted-analyzer',
      `a human-verdict CircuitBreakerError fired on a non-final task and crossing the REAL scheduler drain must route to 'halted-analyzer' (got '${statusOnDisk}' — at HEAD the stall wrap strips the type → 'failed-execution')`);

    // The park scene must exist with the analyzer site + rootCause/evidence.
    const scene = readSceneRaw(root, 'halt-drain');
    assert.ok(scene, 'queue/halt-drain/park.json must exist with a parseable scene');
    assert.strictEqual(scene.site, 'analyzer-human',
      `scene.site must be 'analyzer-human' (got '${scene.site}')`);
    assert.ok(Array.isArray(scene.questions) && scene.questions.length > 0,
      'scene.questions must be a non-empty array');
    const questionsBlob = JSON.stringify(scene.questions);
    assert.ok(questionsBlob.includes('AC2-ROOT-CAUSE'),
      'scene.questions must carry the analyzer rootCause from the breaker that survived the drain');
    assert.ok(questionsBlob.includes('AC2-EVIDENCE'),
      'scene.questions must carry the analyzer evidence');

    // Sanity: task B (the dependent) never ran — the breaker fired on a
    // non-final task while B was still pending (the realistic stall case).
    assert.strictEqual(dispatchedB, 0,
      'task B (the dependent / final task) must never execute — the breaker fired while it was still pending');

    // The working-tree revert still runs on the halted-analyzer path.
    assert.strictEqual(fs.readFileSync(path.join(root, 'seed.txt'), 'utf8'), 'seed content\n',
      'the working-tree revert must still run on the halted-analyzer path');

    // ── Rider: regression pseudo-task (regression-ms-<id>) history outcomes
    //    get back-filled. Drive the real milestone-regression remediation loop
    //    directly and assert the regression-ms-<id> history entries carry a
    //    non-null outcome (at HEAD analyzeFailure writes outcome:null and the
    //    regression loop never back-fills it).
    await runRegressionBackfillProbe(root);
  } finally {
    cleanup(root);
  }
});

/**
 * Rider probe for AC2: the milestone-regression remediation loop must back-fill
 * the regression pseudo-task's history `outcome` (the same way task-site
 * entries get theirs). Drives the REAL _executeMilestone regression path with a
 * verifier mock that fails ONLY the milestone-regression check, a planner mock,
 * an inert executor, and the REAL Analyzer (session seam only).
 */
async function runRegressionBackfillProbe(_parentRoot) {
  const projectRoot = makeTmpRoot('cc-orch-bfib-regr-');
  try {
    const milestoneId = '001';
    const missionId = '001-001';
    const subMissionId = `${missionId}-001`;
    const taskId = `${missionId}-001-001`;
    const harnessDir = path.join(projectRoot, '.harness');
    for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
      fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
    }
    fs.writeFileSync(
      path.join(harnessDir, 'progress', `task-${taskId}.json`),
      JSON.stringify({ taskId, status: 'COMPLETE', affectedFiles: [{ path: 'src/foo.js' }], summary: 'done', testsSummary: 'ok' })
    );
    fs.writeFileSync(
      path.join(harnessDir, 'verification', `task-${taskId}.json`),
      JSON.stringify({ taskId, verified: true, report: 'ok', result: 'PASSED', hardChecks: [], taskScopeChecks: [], notes: null })
    );
    fs.writeFileSync(
      path.join(harnessDir, 'verify', `task-${taskId}.json`),
      JSON.stringify({ taskId, targetFiles: ['src/foo.js'], hardChecks: [], testCases: [] })
    );
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'foo.js'), '// src/foo.js\n');
    const missionState = {
      id: missionId, missionId, description: `mission ${missionId}`, status: 'complete',
      subMissions: {
        [subMissionId]: {
          id: subMissionId, description: 'sub-mission', status: 'complete',
          tasks: {
            [taskId]: {
              id: taskId, description: `task ${taskId}`, status: 'complete',
              createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
              targetFiles: ['src/foo.js'], dependencies: [], testCases: [], tracesScenario: [],
              patternReferences: [], dataSchemas: [],
              verifyFile: `.harness/verify/task-${taskId}.json`,
              progressFile: `.harness/progress/task-${taskId}.json`,
              verificationFile: `.harness/verification/task-${taskId}.json`,
              retryCount: 0,
            },
          },
        },
      },
    };
    fs.writeFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), JSON.stringify(missionState, null, 2));
    const globalState = {
      projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones: {
        [milestoneId]: {
          id: milestoneId, description: `milestone ${milestoneId}`, status: 'in_progress',
          planFile: `.harness/plan/milestone-${milestoneId}.md`,
          missions: {
            [missionId]: {
              id: missionId, description: `mission ${missionId}`, status: 'complete',
              stateFile: `.harness/state/mission-${missionId}.json`,
              planFile: `.harness/plan/mission-${missionId}.md`,
            },
          },
        },
      },
    };
    fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

    const pipeline = new Pipeline(projectRoot, {
      noReview: true,
      statusBar: false,
      skipWorktreeCreation: true,
      onLog: () => {},
      onConfirm: async () => true, // accept the regression-failed gate
    });
    // Distinct verdicts each iteration so the loop runs (not a repeat) — but a
    // 're_plan' fall-through has no real task to replan, so it returns and the
    // loop continues; each iteration produces a history entry to back-fill.
    let n = 0;
    const { analyzer } = makeAnalyzer(() => {
      n++;
      return {
        recommendation: 'retry',
        rootCause: `REGRESSION-ROOT variant ${n}`,
        failureType: 'regression',
        affectedTasks: [`001-001-001-00${n}`],
        evidence: 'regr evidence',
        notes: '',
      };
    });
    pipeline.analyzer = analyzer;
    pipeline.verifier = {
      verifyTask: async (task) => {
        if (task.id && task.id.startsWith('regression-milestone-')) {
          return { verified: false, report: 'FAILED: mock regression failure', structured: { verified: false } };
        }
        return { verified: true, report: 'PASSED', structured: { verified: true } };
      },
    };
    // verifyRegression: the regression gates now call the dedicated method;
    // the mock reuses the same implementation (same id-sniff branches apply).
    pipeline.verifier.verifyRegression = pipeline.verifier.verifyTask;
    pipeline.planner.remediateRegressionFailure = async () => ({ newTasks: [] });
    pipeline.planner.closeReusableSession = async () => {};
    pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
    pipeline._executeAndVerifyTask = async () => {};

    const msState = globalState.milestones[milestoneId];
    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch { /* the loop may exit via the accepted regression gate */ }

    const history = readAnalysisHistory(harnessDir, `regression-ms-${milestoneId}`);
    assert.ok(Array.isArray(history) && history.length >= 1,
      `the regression pseudo-task must accumulate history entries (got ${JSON.stringify(history)})`);
    const backfilled = history.filter((h) => h && typeof h.outcome === 'string' && h.outcome.length > 0);
    assert.ok(backfilled.length >= 1,
      `at least one regression-ms-${milestoneId} history entry must have its outcome back-filled (non-null string); at HEAD the regression loop never back-fills outcome so all are null (history: ${JSON.stringify(history.map((h) => h && h.outcome))})`);
  } finally {
    cleanup(projectRoot);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// AC3 — a non-.md dry-run input must be rejected and must NOT steal the
//        project-root spec.json.
// ─────────────────────────────────────────────────────────────────────────

import { bootstrap } from '../src/orchestrator/core/bootstrap.js';

function makeDryRunPipeline(root, opts = {}) {
  bootstrap(root, {});
  const logs = [];
  const pipeline = new Pipeline(root, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    statusBar: false,
    skipWorktreeCreation: true,
    ...(opts.allowIncompleteScope ? { allowIncompleteScope: true } : {}),
  });
  pipeline._runPreflight = () => {};
  let planGlobalCalls = 0;
  pipeline.planner.planGlobal = async () => {
    planGlobalCalls++;
    return { milestones: [{ id: '001', description: 'm', missions: [{ id: '001-001', description: 'mi' }] }], assumptions: [] };
  };
  pipeline.planner.planMission = async () => { throw new Error('planMission must not be called'); };
  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => {};
  return { pipeline, logs, getPlanGlobalCalls: () => planGlobalCalls };
}

await test('AC3a: dry-running a non-.md file is rejected with an honest error naming the .md requirement; nothing is queued', async () => {
  const root = makeTmpRoot('cc-orch-bfib-ac3a-');
  try {
    // A real non-.md spec input at the project root.
    const notesPath = path.join(root, 'notes.txt');
    fs.writeFileSync(notesPath, '# Some notes, not a spec\n');

    const { pipeline, getPlanGlobalCalls } = makeDryRunPipeline(root);

    let thrown = null;
    try {
      await pipeline.dryRunValidate(`Implement the spec at ${notesPath}`, { prdPath: notesPath });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown,
      'dry-running a non-.md input must throw an honest rejection (at HEAD it is accepted and proceeds)');
    assert.ok(/\.md/i.test(thrown.message),
      `the rejection must name the .md requirement (got: ${thrown && thrown.message})`);

    // The gate must fire BEFORE planGlobal (no LLM spend on an invalid input).
    assert.strictEqual(getPlanGlobalCalls(), 0,
      'the non-.md rejection must fire before planGlobal (no LLM spend)');

    // Nothing queued.
    const queueDir = path.join(root, 'queue');
    const queued = fs.existsSync(queueDir)
      ? fs.readdirSync(queueDir).filter((s) => {
          try { return fs.statSync(path.join(queueDir, s)).isDirectory(); } catch { return false; }
        })
      : [];
    assert.strictEqual(queued.length, 0,
      `no queue entry may be created for a rejected non-.md input (got ${JSON.stringify(queued)})`);
  } finally {
    cleanup(root);
  }
});

await test('AC3b: a non-.md input never copies the project-root spec.json into a queue entry nor unlinks it (the root spec.json survives byte-identically and unreferenced)', async () => {
  const root = makeTmpRoot('cc-orch-bfib-ac3b-');
  try {
    // Stage a REAL, UNRELATED project-root spec.json (distinctive content so we
    // can prove byte fidelity).
    const ROOT_SPEC_JSON = '{\n  "goal": "UNRELATED-ROOT-SPEC",\n  "target_files": ["src/unrelated.js"]\n}\n';
    const rootSpecJsonPath = path.join(root, 'spec.json');
    fs.writeFileSync(rootSpecJsonPath, ROOT_SPEC_JSON);

    // The degenerate input: a non-.md file. At HEAD deriveSpecJsonPath falls
    // back to <projectRoot>/spec.json for ANY non-.md path, so the copy/unlink
    // block would copy this root spec.json into the queue entry AND unlink it.
    const notesPath = path.join(root, 'notes.txt');
    fs.writeFileSync(notesPath, '# notes, not a spec\n');

    const { pipeline } = makeDryRunPipeline(root, { allowIncompleteScope: true });

    // Whether the input is rejected (post-fix) or proceeds (HEAD), the
    // invariant is identical: the root spec.json must survive untouched and
    // must never be attached to a queue entry.
    try {
      await pipeline.dryRunValidate(`Implement the spec at ${notesPath}`, { prdPath: notesPath });
    } catch { /* rejection is the post-fix behavior; the invariants below still hold */ }

    // (1) The project-root spec.json survives, byte-identical (never unlinked).
    assert.ok(fs.existsSync(rootSpecJsonPath),
      'the unrelated project-root spec.json must NOT be unlinked for a non-.md input (at HEAD it is deleted from the root)');
    assert.strictEqual(fs.readFileSync(rootSpecJsonPath, 'utf8'), ROOT_SPEC_JSON,
      'the project-root spec.json content must be unchanged');

    // (2) No queue entry may carry the stolen root spec.json as its criteria.
    const queueDir = path.join(root, 'queue');
    if (fs.existsSync(queueDir)) {
      for (const slug of fs.readdirSync(queueDir)) {
        const entryJson = path.join(queueDir, slug, 'spec.json');
        if (fs.existsSync(entryJson)) {
          const content = fs.readFileSync(entryJson, 'utf8');
          assert.ok(!content.includes('UNRELATED-ROOT-SPEC'),
            `queue entry '${slug}' must NOT have stolen the project-root spec.json as its criteria (found UNRELATED-ROOT-SPEC in queue/${slug}/spec.json)`);
        }
      }
    }
  } finally {
    cleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

void __dirname;
console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
