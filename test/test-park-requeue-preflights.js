#!/usr/bin/env node
/**
 * Mirrors the module-top marker-discipline guard used elsewhere (see
 * test/test-park-requeue-reattach.js / test/test-batch-resume.js): this file
 * bootstraps and drives REAL git fixture roots + a REAL Pipeline against
 * isolated fs.mkdtemp() roots, not a re-entrant cc-orch invocation. Clear the
 * inherited marker unconditionally, before any process.env-sensitive imports,
 * so this file is re-entrancy-neutral regardless of launch context.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

/**
 * test-park-requeue-preflights.js — the producer→consumer seam between
 * `cc-orch park resolve --requeue` (the producer of the park-resume marker,
 * queue/<slug>/resumed-from-park.json) and the batch clean-tree preflight
 * that later narrows itself against that marker's restored paths (the
 * consumer).
 *
 * TC1 drives the REAL `park resolve --requeue` CLI end-to-end over a real git
 * fixture and proves the producer side of the seam: once cleanupParkSnapshot
 * has deleted refs/park/<slug> (a successful requeue always runs it), the
 * park-resume marker written by that SAME resolve still names a stash commit
 * SHA (never the now-dangling refs/park/<slug> ref name) that is still
 * readable via showParkSnapshot, and the path set `git stash show
 * --name-only -u <stashSha>` derives from it equals the preserved WIP paths.
 *
 * TC2/TC3 drive the REAL Pipeline#batchResume clean-tree preflight and prove
 * the consumer side: per src/cli/skills/cc-orch-operator/references/
 * debugging.md ("Park-resume preflight exemption scope"), "the preflight
 * clean-tree narrowing accepts a dirty working tree only when its dirty
 * paths are a subset of the paths restored from the marker's stash — any
 * dirty path outside that restored set still fails the clean-tree check."
 * TC2 re-dirties only a path inside that derived restored set (batchResume
 * must proceed past the guard); TC3 dirties a path outside it (batchResume
 * must still refuse with 'Batch refused: working tree is not clean' and
 * return { archived: 0, failed: 0, parked: 0 }).
 *
 * The marker/restored-path set in every case comes from a REAL `park resolve
 * --requeue` run — never hand-fabricated.
 *
 * Run: node test/test-park-requeue-preflights.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  createParkSnapshot,
  showParkSnapshot,
} from '../src/orchestrator/core/park-snapshot.js';
import {
  writeQueueEntry,
  writeParkScene,
  readParkResumeMarker,
  PARK_RESUME_MARKER_FILE,
} from '../src/orchestrator/core/state.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { computeBatchBaselineExemption } from '../src/cli/index.js';
import { runBaselineGate } from '../src/orchestrator/gates/baseline.js';
import config from '../src/orchestrator/infra/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../src/cli/index.js');

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

// ── Fixtures ────────────────────────────────────────────────────────────────

const SPEC_MD = `# Test Spec

This is a test spec for park requeue preflights.

## Goals
- Build something useful
`;
const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

function makeTmpRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function makeGitRoot(prefix) {
  const root = makeTmpRoot(prefix);
  git(root, 'init');
  git(root, 'config user.email "test@example.com"');
  git(root, 'config user.name "Test User"');
  git(root, 'config commit.gpgsign false');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nline two\nline three\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'queue/\narchives/\n.harness/\n');
  git(root, 'add -A');
  git(root, 'commit -m init');
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function refExists(root, slug) {
  try { git(root, `rev-parse --verify refs/park/${slug}`); return true; } catch { return false; }
}

function createQueueEntry(root, slug, status) {
  writeQueueEntry(root, slug, {
    spec: SPEC_MD,
    plan: { milestones: [], assumptions: [] },
    validatedAt: new Date().toISOString(),
    status,
    specJson: SPEC_JSON,
  });
}

function makeSnapshotScene(snap, overrides = {}) {
  return {
    site: 'review-gate',
    parkedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    round1: [],
    round2: null,
    appliedSpecEdits: [],
    questions: ['Review-gate decision needed.'],
    previousResolutions: [],
    resolution: null,
    stashRef: snap.stashRef,
    stashSha: snap.stashSha,
    baseSha: snap.baseSha,
    ...overrides,
  };
}

function writeScene(root, slug, scene) {
  writeParkScene(root, slug, scene);
}

function runCli(root, args) {
  const res = spawnSync('node', [CLI_PATH, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', out: `${res.stdout || ''}\n${res.stderr || ''}` };
}

/** The repo-relative path set `git stash show` restores from a stash SHA. */
function derivedRestoredPaths(root, stashSha) {
  const out = git(root, `stash show --name-only -u ${stashSha}`);
  return out.split('\n').map((s) => s.trim()).filter(Boolean).sort();
}

/**
 * Drive a REAL `cc-orch park resolve --requeue` end-to-end over a fresh git
 * fixture: seed a halted-review queue entry + WIP, snapshot it, write the
 * park scene, then resolve --requeue. Returns the resolved root/slug, the
 * REAL park-resume marker readParkResumeMarker sees afterward, and the
 * restored-path set derived from that marker's stashSha — all produced by
 * the real CLI, never hand-fabricated.
 */
function setupRequeuedEntry(prefix, slug) {
  const root = makeGitRoot(prefix);
  createQueueEntry(root, slug, 'halted-review');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nWIP-LINE-TWO\nline three\n');
  fs.writeFileSync(path.join(root, 'wip-new.js'), 'UNTRACKED-CONTENT\n');
  const snap = createParkSnapshot(slug, root);
  assert.strictEqual(git(root, 'status --porcelain').trim(), '',
    'fixture: snapshot must leave a clean tree');
  writeScene(root, slug, makeSnapshotScene(snap));

  const res = runCli(root, ['park', 'resolve', slug, '--requeue']);
  assert.strictEqual(res.status, 0,
    `fixture: resolve --requeue must succeed (got exit ${res.status}; output: ${res.out.trim().slice(0, 400)})`);

  const marker = readParkResumeMarker(root, slug);
  assert.ok(marker, 'fixture: a park-resume marker must be readable after resolve --requeue');

  const restoredPaths = derivedRestoredPaths(root, marker.stashSha);

  return { root, slug, marker, restoredPaths, cliResult: res };
}

/**
 * Mutates config.execution[key] for the duration of fn, then restores the
 * original value (or deletes the key if it was originally absent) in
 * finally — even across an async fn's await points. Mirrors
 * test-baseline-gate.js's withConfigOverride exactly.
 */
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

/** Writes a marker file relative to cwd (proves whether a command ran). */
function markerCommand(markerName) {
  return `node -e "require('fs').writeFileSync('${markerName}', 'ran')"`;
}

/** Runs fn while capturing everything written via console.log; restores console.log after. */
async function captureConsoleLog(fn) {
  const chunks = [];
  const origLog = console.log.bind(console);
  console.log = (...args) => chunks.push(args.join(' '));
  let result;
  try {
    result = await fn();
  } finally {
    console.log = origLog;
  }
  return { result, log: chunks.join('\n') };
}

/** A Pipeline wired for a REAL batchResume run with no live LLM spend. */
function makeBatchPipeline(root) {
  const logs = [];
  const pipeline = new Pipeline(root, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    archive: async (projectRoot, slug) => {
      const dir = path.join(projectRoot, 'archives', slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ headline: 'test headline' }));
      fs.writeFileSync(path.join(dir, 'report.txt'), `archived ${slug}`);
      return dir;
    },
    runFinalTestGate: async () => {},
  });
  pipeline.planner.planGlobal = async () => ({ milestones: [], assumptions: [] });
  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.reExtractAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._executeAllMilestones = async () => {};
  pipeline._reviewGate = async () => {};
  pipeline._skipCoverageGate = true;
  return { pipeline, logs };
}

// ── TC1 ───────────────────────────────────────────────────────────────────
// The marker survives ref cleanup (producer→consumer seam).

await test('TC1: the marker survives ref cleanup (producer→consumer seam)', async () => {
  const { root, slug, marker, restoredPaths } = setupRequeuedEntry('cc-orch-park-preflight-tc1-', 'pf-tc1');
  try {
    // cleanupParkSnapshot already ran as part of a successful requeue resolve
    // — the anchoring ref must be GONE.
    assert.ok(!refExists(root, slug),
      `refs/park/${slug} must be deleted — cleanupParkSnapshot runs on a successful requeue resolve`);

    // The marker must carry the durable stash COMMIT SHA, never the
    // now-dangling refs/park/<slug> ref name.
    assert.strictEqual(typeof marker.stashSha, 'string', 'marker.stashSha must be a string');
    assert.ok(marker.stashSha.length > 0 && !marker.stashSha.startsWith('refs/'),
      `marker.stashSha must be the durable stash commit SHA, not a ref name. Got: ${JSON.stringify(marker.stashSha)}`);

    // The marker's stash value must still resolve to a readable stash
    // object — reading it back via showParkSnapshot must succeed even
    // though the anchoring ref that pinned it is gone.
    const preserved = showParkSnapshot(marker.stashSha, root);
    assert.ok(preserved.includes('WIP-LINE-TWO'),
      `showParkSnapshot(marker.stashSha) must still read back the preserved WIP diff. Got:\n${preserved.slice(0, 300)}`);

    // The restored path set derived from the marker must equal the
    // preserved WIP paths (the tracked edit + the untracked new file).
    assert.deepStrictEqual(restoredPaths, ['seed.txt', 'wip-new.js'].sort(),
      `paths restored from marker.stashSha must equal the preserved WIP paths. Got: ${JSON.stringify(restoredPaths)}`);
  } finally {
    cleanup(root);
  }
});

// ── TC2 ───────────────────────────────────────────────────────────────────
// Narrowing accepts a subset.

await test('TC2: narrowing accepts a subset', async () => {
  const { root, restoredPaths } = setupRequeuedEntry('cc-orch-park-preflight-tc2-', 'pf-tc2');
  try {
    // Commit the reattached WIP so we start batchResume from a clean
    // baseline, then deliberately re-dirty only a path INSIDE the derived
    // restored set.
    git(root, 'add -A');
    git(root, 'commit -m "commit reattached WIP"');
    assert.strictEqual(git(root, 'status --porcelain').trim(), '',
      'fixture: tree must be clean after committing the reattached WIP');
    assert.ok(restoredPaths.includes('seed.txt'),
      `fixture: seed.txt must be part of the derived restored set. Got: ${JSON.stringify(restoredPaths)}`);

    fs.appendFileSync(path.join(root, 'seed.txt'), 'ANOTHER-EDIT\n');
    assert.notStrictEqual(git(root, 'status --porcelain').trim(), '',
      'fixture: tree must be dirty before batchResume runs');

    const { pipeline, logs } = makeBatchPipeline(root);
    await pipeline.batchResume({});

    assert.ok(
      !logs.some((l) => l.includes('Batch refused: working tree is not clean')),
      `a dirty set that is a subset of the marker's restored paths must pass the clean-tree preflight. Logs:\n${logs.join('\n')}`
    );
  } finally {
    cleanup(root);
  }
});

// ── TC3 ───────────────────────────────────────────────────────────────────
// Narrowing refuses an outside path.

await test('TC3: narrowing refuses an outside path', async () => {
  const { root, restoredPaths } = setupRequeuedEntry('cc-orch-park-preflight-tc3-', 'pf-tc3');
  try {
    git(root, 'add -A');
    git(root, 'commit -m "commit reattached WIP"');
    assert.strictEqual(git(root, 'status --porcelain').trim(), '',
      'fixture: tree must be clean after committing the reattached WIP');
    assert.ok(!restoredPaths.includes('outside-file.txt'),
      `fixture: outside-file.txt must NOT be part of the derived restored set. Got: ${JSON.stringify(restoredPaths)}`);

    fs.writeFileSync(path.join(root, 'outside-file.txt'), 'OUTSIDE-CONTENT\n');
    assert.notStrictEqual(git(root, 'status --porcelain').trim(), '',
      'fixture: tree must be dirty before batchResume runs');

    const { pipeline, logs } = makeBatchPipeline(root);
    const result = await pipeline.batchResume({});

    assert.ok(
      logs.some((l) => l.includes('Batch refused: working tree is not clean')),
      `a dirty path outside the marker's restored set must still fail the clean-tree preflight. Logs:\n${logs.join('\n')}`
    );
    assert.deepStrictEqual(result, { archived: 0, failed: 0, parked: 0 },
      `batchResume must return { archived: 0, failed: 0, parked: 0 } on refusal. Got: ${JSON.stringify(result)}`);
  } finally {
    cleanup(root);
  }
});

// ── TC4 ───────────────────────────────────────────────────────────────────
// Baseline-exemption: an all-marked batch skips only the full-suite arm.
//
// Drives the SAME producer→consumer seam as TC1-TC3 one step further: the
// batch baseline-gate exemption descriptor (computeBatchBaselineExemption,
// src/cli/index.js) computed from a REAL requeued entry's on-disk
// park-resume marker is fed into the REAL runBaselineGate
// (src/orchestrator/gates/baseline.js) full-suite-exemption argument. With
// EVERY pending queue entry carrying the marker, the smoke arm must still
// run (its command's side-effect file is created) while the full-suite arm
// must be suppressed entirely (its command's side-effect file is absent),
// and the captured [baseline] log line must name the marked entry's slug,
// its park-resume stash SHA, and the fixed exemption reason.

await test("TC4: all-marked batch skips only the full-suite arm", async () => {
  const { root, slug, marker } = setupRequeuedEntry('cc-orch-park-preflight-tc4-', 'pf-tc4');
  try {
    const descriptor = computeBatchBaselineExemption(root);
    assert.ok(descriptor, `computeBatchBaselineExemption must find an exemption for an all-marked batch. Got: ${JSON.stringify(descriptor)}`);
    assert.deepStrictEqual(
      descriptor.entries,
      [{ slug, stashSha: marker.stashSha }],
      `descriptor.entries must name exactly the marked entry and its marker's stashSha. Got: ${JSON.stringify(descriptor.entries)}`
    );

    const smokeMarkerFile = 'tc4-smoke.marker';
    const fullMarkerFile = 'tc4-full.marker';

    const { result: gateResult, log } = await withConfigOverride('testCommand', markerCommand(smokeMarkerFile), () =>
      withConfigOverride('testAllCommand', markerCommand(fullMarkerFile), () =>
        captureConsoleLog(() => runBaselineGate(root, descriptor))
      )
    );

    assert.strictEqual(gateResult.ok, true, `expected ok:true, got: ${JSON.stringify(gateResult)}`);
    assert.ok(fs.existsSync(path.join(root, smokeMarkerFile)), 'the smoke command must actually have run');
    assert.ok(!fs.existsSync(path.join(root, fullMarkerFile)), 'the full-suite command must NOT have run — it is exempted');

    assert.ok(log.includes(slug), `the captured log must name the marked entry's slug ('${slug}'). Log:\n${log}`);
    assert.ok(log.includes(marker.stashSha), `the captured log must name the marker's stash SHA ('${marker.stashSha}'). Log:\n${log}`);
    assert.ok(
      log.includes('park-resume marker whose WIP was already re-attached'),
      `the captured log must name the exemption reason. Log:\n${log}`
    );
  } finally {
    cleanup(root);
  }
});

// ── TC5 ───────────────────────────────────────────────────────────────────
// Baseline-exemption: any unmarked pending entry runs the baseline gate.
//
// The same batch as TC4, plus one additional pending queue entry that never
// went through park resolve --requeue (so it carries no park-resume
// marker). Per debugging.md's "Park-resume preflight exemption scope", the
// suppression applies ONLY when EVERY pending entry carries the marker — a
// single unmarked pending entry means computeBatchBaselineExemption yields
// no exemption, and runBaselineGate must run BOTH arms in full.

await test('TC5: any unmarked pending entry runs the baseline gate', async () => {
  const { root } = setupRequeuedEntry('cc-orch-park-preflight-tc5-', 'pf-tc5-marked');
  try {
    createQueueEntry(root, 'pf-tc5-unmarked', 'pending');

    const descriptor = computeBatchBaselineExemption(root);
    assert.strictEqual(descriptor, null,
      `an unmarked pending entry in the batch must yield no exemption. Got: ${JSON.stringify(descriptor)}`);

    const smokeMarkerFile = 'tc5-smoke.marker';
    const fullMarkerFile = 'tc5-full.marker';

    const gateResult = await withConfigOverride('testCommand', markerCommand(smokeMarkerFile), () =>
      withConfigOverride('testAllCommand', markerCommand(fullMarkerFile), () =>
        runBaselineGate(root, descriptor)
      )
    );

    assert.strictEqual(gateResult.ok, true, `expected ok:true, got: ${JSON.stringify(gateResult)}`);
    assert.ok(fs.existsSync(path.join(root, smokeMarkerFile)), 'the smoke command must run when the batch is not all-marked');
    assert.ok(fs.existsSync(path.join(root, fullMarkerFile)), 'the full-suite command must ALSO run when the batch is not all-marked');
  } finally {
    cleanup(root);
  }
});

// ── TC6 ───────────────────────────────────────────────────────────────────
// Baseline-exemption: the marker is spent by execution.
//
// The marker is a ONE-SHOT grant: pipeline.js's batchResume deletes the
// on-disk park-resume marker (queue/<slug>/resumed-from-park.json) as soon
// as its entry begins executing (claimed + bootstrapped) — see
// pipeline.js's "Park-resume exemption ... consumed — one-shot marker
// removed." log line. This drives a REAL batchResume run over the marked
// entry (committing its reattached WIP first so the clean-tree guard is a
// no-op and batchResume proceeds straight to execution), proves the marker
// file is gone afterward, then proves a second exemption computation over
// the SAME project root — now marker-less — yields no exemption, so a
// second baseline-gate pass runs BOTH arms (no second exemption granted).

await test('TC6: the marker is spent by execution', async () => {
  const { root, slug } = setupRequeuedEntry('cc-orch-park-preflight-tc6-', 'pf-tc6');
  try {
    const markerPath = path.join(root, 'queue', slug, PARK_RESUME_MARKER_FILE);
    assert.ok(fs.existsSync(markerPath), 'fixture: the park-resume marker must exist on disk before execution begins');

    // Commit the reattached WIP so the tree is clean before batchResume —
    // isolates this case to marker-consumption, independent of the
    // clean-tree narrowing guard covered by TC2/TC3.
    git(root, 'add -A');
    git(root, 'commit -m "commit reattached WIP"');
    assert.strictEqual(git(root, 'status --porcelain').trim(), '',
      'fixture: tree must be clean after committing the reattached WIP');

    const { pipeline } = makeBatchPipeline(root);
    await pipeline.batchResume({});

    assert.ok(!fs.existsSync(markerPath),
      'the park-resume marker must no longer exist on disk once the entry has begun executing');

    // Second batch pass: recompute the exemption over the same project
    // root now that the marker is spent — no exemption should be granted,
    // so both baseline-gate arms must run.
    const descriptor2 = computeBatchBaselineExemption(root);
    assert.strictEqual(descriptor2, null,
      `a spent marker must yield no exemption on a second pass. Got: ${JSON.stringify(descriptor2)}`);

    const smokeMarkerFile = 'tc6-smoke.marker';
    const fullMarkerFile = 'tc6-full.marker';

    const gateResult = await withConfigOverride('testCommand', markerCommand(smokeMarkerFile), () =>
      withConfigOverride('testAllCommand', markerCommand(fullMarkerFile), () =>
        runBaselineGate(root, descriptor2)
      )
    );

    assert.strictEqual(gateResult.ok, true, `expected ok:true, got: ${JSON.stringify(gateResult)}`);
    assert.ok(fs.existsSync(path.join(root, smokeMarkerFile)), 'the smoke command must run on the second pass');
    assert.ok(fs.existsSync(path.join(root, fullMarkerFile)), 'the full-suite command must ALSO run on the second pass — no second exemption');
  } finally {
    cleanup(root);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
