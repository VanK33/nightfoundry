#!/usr/bin/env node
/**
 * test-park-leg-selection.js — Track P P2: the PIPELINE-LEVEL leg selection
 * that decides snapshot-vs-discard on each batch halt leg
 * (spec: p2-park-diff-preservation.spec.md, Scope #1 + AC1).
 *
 * The heart of P2 is `pipeline.js` `isResolvablePark` choosing, ON EACH HALT,
 * between PRESERVING the verified work-in-progress (a gc-safe stash snapshot
 * anchored at refs/park/<slug>) and DISCARDING it (the unconditional
 * `git reset --hard` the true-failure paths still run). The existing P2 tests
 * all exercise the `createParkSnapshot` PRIMITIVE directly — none drive the
 * real `batchResume` catch, so the leg-selection branch had ZERO coverage:
 * mutating `isResolvablePark` to `false` (reverting to always-discard) left
 * every other P2 test green.
 *
 * This test closes that gap by driving a REAL `batchResume` (real temp git
 * repo as projectRoot, real queue entry, stubbed SDK/pipeline seams) to two
 * halt legs that leave a DIRTY work-in-progress (a tracked modification AND an
 * untracked new file) on the tree at halt time:
 *
 *   (a) RESOLVABLE-PARK leg — a review-gate HaltError → status 'halted-review'.
 *       Assert: refs/park/<slug> exists, the park.json scene carries
 *       stashRef/stashSha/baseSha, the working tree is left CLEAN (the WIP was
 *       PRESERVED, not discarded), and the WIP is recoverable from the ref.
 *
 *   (b) TRUE-FAILURE leg — a plain Error → status 'failed-execution'.
 *       Assert: NO refs/park/<slug> ref was created, and the WIP was DISCARDED
 *       (tree reset to HEAD — the tracked mod reverted, the untracked file
 *       removed).
 *
 * How it catches the regression (the whole point):
 *   Forcing `isResolvablePark = false` (or restoring the old unconditional
 *   `git reset --hard` on the resolvable-park leg) makes leg (a) DISCARD the
 *   WIP and create no ref — violating every assertion in case (a). A plain
 *   primitive-level test (createParkSnapshot in isolation) cannot see this,
 *   because the mutation lives in pipeline.js, not in park-snapshot.js.
 *
 * Assertions derive from the SPEC behavior, not the implementation; conflict /
 * preservation are checked by observable git/queue state.
 *
 * Coexistence pin (added by the mission's final task): `_parkEntry` is the
 * single leg-selection primitive behind every park/halt disposition — its
 * `status` option ('parked' default, 'halted-review', 'halted-analyzer', or
 * 'halted-scope' for a scope-proposal scene) is the ONLY thing that decides
 * which on-disk leg an entry lands on. A third test case below drives
 * `_parkEntry` directly (no batchResume, no git fixture needed) across all
 * four scenes and asserts each resolves to its OWN distinct on-disk status —
 * i.e. the four dispositions coexist without collision.
 *
 * Run: node test/test-park-leg-selection.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { HaltError } from '../src/orchestrator/core/halt-error.js';
import { writeQueueEntry, readParkScene } from '../src/orchestrator/core/state.js';

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

// ── Git fixture ──────────────────────────────────────────────────────────────

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * A real temp git repo used as projectRoot: git init + identity + a committed
 * tracked seed file. queue/ archives/ .harness/ are gitignored exactly as a
 * real cc-orch project root is, so the batch-start clean-tree guard sees an
 * empty porcelain and the WIP the snapshot captures is the src/ change + the
 * untracked root file (NOT the queue/ entry or .harness/).
 */
function makeProjectRoot(prefix = 'cc-orch-leg-sel-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, 'init');
  git(root, 'config user.email "test@example.com"');
  git(root, 'config user.name "Test User"');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'line one\nline two\nline three\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'queue/\narchives/\n.harness/\n');
  git(root, 'add -A');
  git(root, 'commit -m init');
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function porcelain(root) {
  return git(root, 'status --porcelain').trim();
}

function refExists(root, slug) {
  try { git(root, `rev-parse --verify refs/park/${slug}`); return true; } catch { return false; }
}

function readStatus(root, slug) {
  return fs.readFileSync(path.join(root, 'queue', slug, 'status'), 'utf8').trim();
}

const SPEC_MD = `# Test Spec\n\nLeg-selection spec.\n\n## Goals\n- Build something useful\n`;
const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

function createQueueEntry(root, slug) {
  // No assumptions → the assumption-verification rounds are skipped and control
  // reaches the execution try/catch directly.
  writeQueueEntry(root, slug, {
    spec: SPEC_MD,
    plan: { milestones: [], assumptions: [] },
    validatedAt: new Date().toISOString(),
    status: 'pending',
    specJson: SPEC_JSON,
  });
}

/**
 * Build a Pipeline wired to drive batchResume into one halt leg.
 *
 * - `_archive` is stubbed (constructor injection) to a no-op so the forensic
 *   archive in the failure catch neither fails nor perturbs the WIP.
 * - `_skipCoverageGate` so the scope-coverage gate does not run.
 * - `_executeAllMilestones` creates the DIRTY WIP (tracked mod + untracked
 *   file) on the tree, then for the true-failure leg throws directly.
 * - `_reviewGate` throws a review-gate HaltError for the resolvable-park leg.
 */
function makePipeline(root, { leg, slug }) {
  const logs = [];
  const pipeline = new Pipeline(root, {
    noReview: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    archive: async () => {},
  });
  pipeline._skipCoverageGate = true;

  const writeWip = () => {
    // Tracked modification to a committed file…
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'line one\nWIP-LINE-TWO\nline three\n');
    // …and a brand-new untracked file (executors create new files such as tests).
    fs.writeFileSync(path.join(root, 'wip-new.js'), 'UNTRACKED-WIP-CONTENT\n');
  };

  if (leg === 'resolvable') {
    // Milestones "succeed" (leaving the verified WIP on the tree); the review
    // gate then halts for a human → halted-review (a resolvable park).
    pipeline._executeAllMilestones = async () => { writeWip(); };
    pipeline._reviewGate = async () => {
      throw new HaltError('review-gate', 'A human review decision is required.');
    };
  } else if (leg === 'true-failure') {
    // A mid-run execution failure (plain Error) AFTER the WIP exists on the
    // tree → failed-execution (a true-failure leg that discards the WIP).
    pipeline._executeAllMilestones = async () => {
      writeWip();
      throw new Error('Simulated mid-run execution failure.');
    };
  } else {
    throw new Error(`unknown leg: ${leg}`);
  }

  return { pipeline, logs };
}

// ── (a) RESOLVABLE-PARK leg: the WIP is PRESERVED (snapshot, not discarded) ──

await test('leg-selection: a resolvable-park halt PRESERVES the WIP — refs/park/<slug>, scene snapshot fields, clean tree, recoverable WIP', async () => {
  const root = makeProjectRoot();
  const slug = 'leg-resolvable';
  try {
    createQueueEntry(root, slug);
    assert.strictEqual(porcelain(root), '', 'fixture: tree must be clean before batchResume (queue/ is gitignored)');

    const headBefore = git(root, 'rev-parse HEAD').trim();
    const { pipeline } = makePipeline(root, { leg: 'resolvable', slug });

    const res = await pipeline.batchResume();

    // The entry parked as a RESOLVABLE review halt (not failed-execution).
    // (The on-disk status — not the summary counters — is the resolvable-vs-
    // failed signal: the catch's park legs share failCount with true failures.)
    assert.strictEqual(readStatus(root, slug), 'halted-review',
      `a review-gate halt must park the entry as 'halted-review' (got '${readStatus(root, slug)}')`);

    // The WIP was PRESERVED into a gc-safe ref — the discriminator the
    // isResolvablePark=false mutation would break.
    assert.ok(refExists(root, slug),
      `refs/park/${slug} must exist — the resolvable-park leg must PRESERVE the WIP into a gc-safe ref, not discard it`);

    // The park scene carries the snapshot descriptor fields.
    const scene = readParkScene(root, slug);
    assert.ok(scene, 'a park.json scene must be written for the halted entry');
    assert.ok(typeof scene.stashRef === 'string' && scene.stashRef.length > 0,
      `the scene must carry stashRef (got ${JSON.stringify(scene.stashRef)})`);
    assert.ok(typeof scene.stashSha === 'string' && scene.stashSha.length > 0,
      `the scene must carry stashSha (got ${JSON.stringify(scene.stashSha)})`);
    assert.strictEqual(scene.baseSha, headBefore,
      `the scene's baseSha must be HEAD at snapshot time (expected ${headBefore}, got ${scene.baseSha})`);

    // The tree was left CLEAN for the next entry (the WIP moved into the stash,
    // it was not left on disk).
    assert.strictEqual(porcelain(root), '',
      `the working tree must be left CLEAN after a resolvable-park halt (got: ${porcelain(root)})`);

    // …and the preserved WIP is genuinely recoverable from the ref — both the
    // tracked modification and the untracked file are inside the snapshot.
    const preserved = git(root, `stash show -p -u ${scene.stashRef}`);
    assert.ok(preserved.includes('WIP-LINE-TWO'),
      `the preserved snapshot must contain the tracked modification (the WIP was NOT discarded). diff:\n${preserved.slice(0, 400)}`);
    assert.ok(preserved.includes('UNTRACKED-WIP-CONTENT'),
      `the preserved snapshot must contain the untracked new file (the WIP was NOT discarded). diff:\n${preserved.slice(0, 400)}`);
  } finally {
    cleanup(root);
  }
});

// ── (b) TRUE-FAILURE leg: the WIP is DISCARDED (reset, no ref) ──────────────

await test('leg-selection: a true-failure halt DISCARDS the WIP — no refs/park/<slug>, tracked mod reverted, untracked file removed', async () => {
  const root = makeProjectRoot();
  const slug = 'leg-failure';
  try {
    createQueueEntry(root, slug);
    assert.strictEqual(porcelain(root), '', 'fixture: tree must be clean before batchResume');

    const { pipeline } = makePipeline(root, { leg: 'true-failure', slug });

    const res = await pipeline.batchResume();

    // The entry was recorded as a genuine execution failure (not parked).
    assert.strictEqual(readStatus(root, slug), 'failed-execution',
      `a plain mid-run Error must mark the entry 'failed-execution' (got '${readStatus(root, slug)}')`);
    assert.strictEqual(res.failed, 1, `batchResume must report 1 failed (got ${JSON.stringify(res)})`);

    // NO preservation ref — the true-failure leg keeps its discard semantics.
    assert.ok(!refExists(root, slug),
      `no refs/park/${slug} may be created on the true-failure leg — it must DISCARD the WIP, not preserve it`);

    // The WIP was discarded: the tree is back at HEAD.
    assert.strictEqual(porcelain(root), '',
      `the working tree must be clean after the true-failure revert (got: ${porcelain(root)})`);
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'),
      'line one\nline two\nline three\n',
      'the tracked modification must be reverted to HEAD on the true-failure leg (WIP discarded)');
    assert.ok(!fs.existsSync(path.join(root, 'wip-new.js')),
      'the untracked new file must be removed on the true-failure leg (WIP discarded)');
  } finally {
    cleanup(root);
  }
});

// ── (c) Coexistence: four scenes each select their OWN distinct leg ─────────

await test('leg-selection coexistence: a parked, a halted-review, a halted-analyzer and a scope-proposal scene each select their own distinct on-disk leg via _parkEntry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-leg-coexist-'));
  try {
    const pipeline = new Pipeline(root, { onLog: () => {}, onConfirm: async () => true, statusBar: false });

    const legs = [
      {
        slug: 'leg-parked',
        opts: {},
        scene: { site: 'analyzer-human', parkedAt: new Date().toISOString(), questions: ['Q'] },
        expected: 'parked',
      },
      {
        slug: 'leg-halted-review',
        opts: { status: 'halted-review' },
        scene: { site: 'reviewer-gate-human', parkedAt: new Date().toISOString(), questions: ['Q'] },
        expected: 'halted-review',
      },
      {
        slug: 'leg-halted-analyzer',
        opts: { status: 'halted-analyzer' },
        scene: { site: 'analyzer-human', parkedAt: new Date().toISOString(), questions: ['Q'] },
        expected: 'halted-analyzer',
      },
      {
        slug: 'leg-scope-proposal',
        opts: { status: 'halted-scope' },
        scene: {
          site: 'plan-scope-lint',
          kind: 'scope-proposal',
          parkedAt: new Date().toISOString(),
          proposedFiles: [],
          candidatePlan: { milestones: [] },
          candidatePlanDigest: 'fixture-digest',
          missionId: '001-001',
          lintArmsPending: [],
        },
        expected: 'halted-scope',
      },
    ];

    for (const leg of legs) {
      createQueueEntry(root, leg.slug);
      pipeline._parkEntry({ slug: leg.slug }, leg.scene, leg.opts);
    }

    const resolved = legs.map((leg) => readStatus(root, leg.slug));
    assert.deepStrictEqual(resolved, legs.map((leg) => leg.expected),
      `each scene must resolve to its own leg (expected ${JSON.stringify(legs.map((l) => l.expected))}, got ${JSON.stringify(resolved)})`);

    // The whole point: FOUR distinct dispositions coexist — none collide.
    assert.strictEqual(new Set(resolved).size, 4,
      `the parked / halted-review / halted-analyzer / halted-scope legs must be four DISTINCT statuses (got ${JSON.stringify(resolved)})`);

    // Each scene also lands its scope-proposal 'kind' marker correctly (the
    // discriminator batchResume's approved-scope-proposal recognition step
    // keys on), while the other three legs stay kind-free.
    const scopeScene = readParkScene(root, 'leg-scope-proposal');
    assert.strictEqual(scopeScene.kind, 'scope-proposal', "the scope-proposal scene must carry kind:'scope-proposal'");
    for (const slug of ['leg-parked', 'leg-halted-review', 'leg-halted-analyzer']) {
      const scene = readParkScene(root, slug);
      assert.notStrictEqual(scene.kind, 'scope-proposal', `'${slug}' must not carry a scope-proposal kind marker`);
    }
  } finally {
    cleanup(root);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
