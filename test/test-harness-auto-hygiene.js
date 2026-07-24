#!/usr/bin/env node
/**
 * test-harness-auto-hygiene.js — Auto-hygiene sweep tests for the run-dir
 * reaper (src/orchestrator/core/harness-reaper.js) and its two production
 * call sites (Pipeline.run() and Pipeline.batchResume()).
 *
 * Mirrors the module-top marker-discipline guard used by
 * test/test-clean-run-reaper.js and test/test-batch-log-anchoring.js: this
 * file drives the REAL classifyOrphanRunDirs/sweepOrphanRunDirs against
 * isolated fs.mkdtemp() fixture roots (git-init'ed only where a ref shield
 * would otherwise be exercised — none of the cases below need one), plus a
 * REAL Pipeline.batchResume()/Pipeline.run() with every planner/execution
 * seam stubbed. No test case spawns a real agent session.
 *
 * Covers (see task spec for the authoritative one-line descriptions):
 *   TC1 — sweepOrphanRunDirs removes a mechanicallySafe orphan run dir (no
 *         parseable state.json — missing OR corrupt) and never throws.
 *   TC2 — sweepOrphanRunDirs quarantines a superseded run dir into
 *         .harness/stale/ via fs.renameSync (never fs.rmSync'd — contents
 *         survive intact under the new location). Also pins TASK
 *         NON-COLLAPSE: two run dirs whose prdPaths are distinct nested
 *         run-scoped tmp files (<runDirA>/tmp-spec-archived.md vs
 *         <runDirB>/tmp-spec-archived.md) never canonically collapse into
 *         each other or into an archive matching the OTHER dir's path.
 *   TC3 — a dry-run.marker orphan dir is NOT auto-swept (AUTO mode, i.e.
 *         includeMarkerDirs:false, excludes marker dirs from all three
 *         classification lists entirely) but IS classified
 *         mechanicallySafe under includeMarkerDirs:true (the interactive
 *         CLI mode `cc-orch clean --runs` uses).
 *   TC4 — .harness/stale/ contents (and the SHARED_SUBDIRS — learning/,
 *         dry-run/, brainstorm/) are never enumerated or auto-emptied by a
 *         sweep.
 *   TC5 — a parked-runId collected from queue/{slug}/park.json shields a
 *         matching run dir from mechanicallySafe rm (a same-shape dir with
 *         no matching park.json is NOT shielded and is still rm'd).
 *   TC6 — batchResume triggers sweepOrphanRunDirs at the top (before the
 *         per-entry queue loop) and again in its finally block, STRICTLY
 *         AFTER planner.closeReusableSession() (ordering pin via a
 *         call-order-sensitive log-line assertion).
 *   TC7 — Pipeline.run() sweeps only on the successful-claim branch: a
 *         refused concurrent claim (foreign active-run pointer already
 *         held) does NOT sweep and a pre-seeded husk run dir survives; a
 *         free pointer claims and sweeps, reaping the husk.
 *   EC33 — prdPathsMatch cross-form shape coverage: (1)/(2) a genuinely
 *         cross-form pair — one side ROOT-form (<root>/<slug>.md), the
 *         other QUEUE-form (<root>/queue/<slug>/spec.md) of the textually
 *         same slug — DOES canonically match in both orderings (both
 *         reduce to the same (anchor, slug) identity): a run dir recording
 *         one form is classified superseded (and quarantined) by a strictly
 *         newer archive recording the other form of the same anchor+slug —
 *         the live ec33 miss this predicate exists to close. By contrast, a
 *         nested-dir prdPath (<root>/specs/foo.md) and an outside-project
 *         prdPath do NOT canonicalize against either form (exact-string
 *         only) — each anchors to its own dirname and can never collapse
 *         into a project-root or queue identity. (3) the REAL discriminating
 *         null-slug-shield regression this cross-form probe sets up: a
 *         root-form candidate prdPath (<root>/<slug>.md) matching an
 *         archive's prdPath with the trailing extension dropped by an
 *         upstream normalizer (<root>/<slug>) — a genuine, achievable
 *         root-form tolerance match — is classified superseded, and because
 *         its own prdPath is root-form (extractRawQueueSlug → null),
 *         isShieldedByLiveRef(root, null) must be FALSE (CHANGE (1) in
 *         harness-reaper.js — the shipped `clean.js` predecessor returned
 *         `true` for a null/falsy rawSlug, the "inverted null-slug shield"
 *         bug, which would have wrongly kept this exact candidate); the fix
 *         is pinned both directly (isShieldedByLiveRef(root, null) ===
 *         false) and end-to-end (classifyOrphanRunDirs puts the candidate in
 *         `superseded`, and sweepOrphanRunDirs quarantines it into
 *         .harness/stale/).
 *   FS   — FAIL-SOFT: a candidate engineered to throw mid-classification
 *         (fs.existsSync monkey-patched to throw for one specific dir's
 *         dry-run.marker check — the one call in the per-dir loop body that
 *         is NOT already wrapped in its own inner try/catch) is skipped
 *         (appears in none of the three classification lists) without
 *         aborting classification of the other candidates, and
 *         sweepOrphanRunDirs still disposes of the remaining ones and never
 *         throws.
 *
 * Run: node test/test-harness-auto-hygiene.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

import {
  classifyOrphanRunDirs,
  sweepOrphanRunDirs,
  prdPathsMatch,
  isShieldedByLiveRef,
} from '../src/orchestrator/core/harness-reaper.js';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';
import {
  harnessRoot,
  generateRunId,
  claimActiveRun,
  readActiveRunPointer,
} from '../src/orchestrator/core/run-context.js';
import { writeParkScene } from '../src/orchestrator/core/state.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { reapOrphanRunDirs } from '../src/cli/commands/clean.js';
import { archive as realArchive } from '../src/cli/commands/archive.js';
import {
  makeRealBatchPipeline,
  makePlan,
  createQueueEntry,
  makeGitRoot,
  cleanup,
  git,
} from './helpers/batch-fixtures.js';

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

// ── fixture helpers ─────────────────────────────────────────────────────

function makeTmpRoot(prefix = 'cc-harness-hygiene-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Pin a state.json's mtime via fs.utimesSync for deterministic newer/older comparisons. */
function setMtime(statePath, mtimeMs) {
  const t = mtimeMs / 1000;
  fs.utimesSync(statePath, t, t);
}

const BASE_MS = Date.now();
const NEWER_MS = BASE_MS + 10 * 60 * 1000;

/**
 * Build a Pipeline whose run() can reach completion (or the refusal branch)
 * without doing any real work — mirrors test-preclaimed-run.js's
 * makeRunnablePipeline. Every planner/execution seam is stubbed; onLog is
 * caller-supplied so call sites can capture/inspect log order.
 */
function makeRunnablePipeline(projectRoot, { onLog = () => {} } = {}) {
  const pipeline = new Pipeline(projectRoot, {
    onLog,
    onConfirm: async () => true,
  });
  pipeline.planner.planGlobal = async () => ({
    milestones: [
      { id: '001', description: 'Test milestone', missions: [{ id: '001-001', description: 'Test mission' }] },
    ],
    assumptions: [],
    scopeItems: [],
    scopeMapping: [],
  });
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._remediateAssumptions = async () => ({ passed: true });
  pipeline._scopeCoverageGate = async () => {};
  pipeline._detectUncheckableSpec = () => {};
  pipeline._executeAllMilestones = async () => {};
  pipeline._reviewGate = async () => {};
  pipeline._runFinalTestGate = () => {};
  return pipeline;
}

// ── TC1 ──────────────────────────────────────────────────────────────────

await test(
  'TC1: sweepOrphanRunDirs removes a mechanicallySafe orphan run dir (missing OR corrupt state.json) and never throws',
  async () => {
    const root = makeTmpRoot('cc-hh-tc1-');
    try {
      const corruptDir = path.join(harnessRoot(root), 'run-tc1-corrupt');
      fs.mkdirSync(corruptDir, { recursive: true });
      fs.writeFileSync(path.join(corruptDir, 'state.json'), '{ not valid json');

      const missingDir = path.join(harnessRoot(root), 'run-tc1-missing');
      fs.mkdirSync(missingDir, { recursive: true });
      // deliberately no state.json at all

      const logs = [];
      let threw = false;
      let caught = null;
      try {
        sweepOrphanRunDirs(root, { log: (m) => logs.push(m) });
      } catch (err) {
        threw = true;
        caught = err;
      }

      assert.ok(!threw, `sweepOrphanRunDirs must never throw, got: ${caught && caught.stack}`);
      assert.ok(!fs.existsSync(corruptDir), 'corrupt-state.json orphan dir must be removed');
      assert.ok(!fs.existsSync(missingDir), 'no-state.json orphan dir must be removed');
      assert.ok(
        logs.some((l) => l.includes('Reaped orphan run dir run-tc1-corrupt.')),
        `expected a "Reaped" log line naming run-tc1-corrupt, got: ${JSON.stringify(logs)}`,
      );
      assert.ok(
        logs.some((l) => l.includes('Reaped orphan run dir run-tc1-missing.')),
        `expected a "Reaped" log line naming run-tc1-missing, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      cleanup(root);
    }
  },
);

// ── TC2 ──────────────────────────────────────────────────────────────────

await test(
  'TC2: sweepOrphanRunDirs quarantines a superseded run dir into .harness/stale/ via rename (never rm)',
  async () => {
    const root = makeTmpRoot('cc-hh-tc2-');
    try {
      const slug = 'tc2-svc';
      const prdPath = path.join(root, 'queue', slug, 'spec.md');
      const { harnessDir: dir } = bootstrap(root, { runId: 'run-tc2-superseded', prdPath });
      setMtime(path.join(dir, 'state.json'), BASE_MS);

      const archiveDir = path.join(root, 'archives', '099-unrelated');
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, 'state.json'), JSON.stringify({ projectMeta: { prdPath } }));
      setMtime(path.join(archiveDir, 'state.json'), NEWER_MS);

      const base = path.basename(dir);
      const logs = [];
      let threw = false;
      try {
        sweepOrphanRunDirs(root, { log: (m) => logs.push(m) });
      } catch (err) {
        threw = true;
        console.log(`       error: ${err && err.stack}`);
      }
      assert.ok(!threw, 'sweepOrphanRunDirs must never throw');

      const staleDest = path.join(harnessRoot(root), 'stale', base);
      assert.ok(!fs.existsSync(dir), 'original run dir path must be gone after quarantine (rename moves it)');
      assert.ok(fs.existsSync(staleDest), 'quarantined dir must exist at .harness/stale/<name>');
      assert.ok(
        fs.existsSync(path.join(staleDest, 'state.json')),
        'quarantined dir must retain its own state.json — proves a rename (contents preserved), not a fresh empty dir',
      );
      assert.ok(
        logs.some((l) => l.includes(`Quarantined superseded run dir ${base} \u2192 .harness/stale/`)),
        `expected a "Quarantined" log line naming ${base}, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      cleanup(root);
    }
  },
);

await test(
  'TC2 (task non-collapse): distinct nested run-scoped tmp-spec-archived.md prdPaths never canonically collapse into each other or into an archive matching the OTHER dir\'s path',
  async () => {
    const root = makeTmpRoot('cc-hh-tc2nc-');
    try {
      const { harnessDir: dirA } = bootstrap(root, { runId: 'run-tc2nc-a' });
      const prdPathA = path.join(dirA, 'tmp-spec-archived.md');
      const stateA = JSON.parse(fs.readFileSync(path.join(dirA, 'state.json'), 'utf8'));
      stateA.projectMeta = { ...(stateA.projectMeta || {}), prdPath: prdPathA };
      fs.writeFileSync(path.join(dirA, 'state.json'), JSON.stringify(stateA));
      setMtime(path.join(dirA, 'state.json'), BASE_MS);

      const { harnessDir: dirB } = bootstrap(root, { runId: 'run-tc2nc-b' });
      const prdPathB = path.join(dirB, 'tmp-spec-archived.md');
      const stateB = JSON.parse(fs.readFileSync(path.join(dirB, 'state.json'), 'utf8'));
      stateB.projectMeta = { ...(stateB.projectMeta || {}), prdPath: prdPathB };
      fs.writeFileSync(path.join(dirB, 'state.json'), JSON.stringify(stateB));
      setMtime(path.join(dirB, 'state.json'), BASE_MS);

      // An archive whose recorded prdPath matches dirA EXACTLY (newer mtime)
      // must supersede dirA, but must NOT bleed into dirB — a different
      // nested tmp-spec-archived.md path, even though the basename is
      // identical, is a different string and gets no canonicalization
      // tolerance (only queue-form and root-form-.md get any tolerance;
      // this shape degrades to plain exact-string comparison).
      const archiveDir = path.join(root, 'archives', '001-nc');
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, 'state.json'), JSON.stringify({ projectMeta: { prdPath: prdPathA } }));
      setMtime(path.join(archiveDir, 'state.json'), NEWER_MS);

      const classified = classifyOrphanRunDirs(root, { includeMarkerDirs: false });
      const resolvedSuperseded = classified.superseded.map((d) => path.resolve(d));
      const resolvedKept = classified.kept.map((d) => path.resolve(d));

      assert.ok(
        resolvedSuperseded.includes(path.resolve(dirA)),
        'dirA (exact prdPath match against the archive) must be classified superseded',
      );
      assert.ok(
        !resolvedSuperseded.includes(path.resolve(dirB)),
        'dirB must NOT be classified superseded merely because dirA\'s distinct nested prdPath matched an archive',
      );
      assert.ok(
        resolvedKept.includes(path.resolve(dirB)),
        'dirB must be kept — no archive matches its own distinct nested prdPath',
      );
    } finally {
      cleanup(root);
    }
  },
);

// ── TC3 ──────────────────────────────────────────────────────────────────

await test(
  'TC3: a dry-run.marker orphan dir is NOT auto-swept (AUTO mode excludes marker dirs) but is classified mechanicallySafe under the interactive-CLI includeMarkerDirs:true mode',
  async () => {
    const root = makeTmpRoot('cc-hh-tc3-');
    try {
      const dir = path.join(harnessRoot(root), 'run-tc3-marker');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'dry-run.marker'), '');
      // No parseable state.json either — would otherwise ALSO be
      // mechanicallySafe on its own; the marker-exemption must still win in
      // AUTO mode regardless.

      const logs = [];
      sweepOrphanRunDirs(root, { log: (m) => logs.push(m) });

      assert.ok(fs.existsSync(dir), 'dry-run.marker dir must survive the AUTO sweep');
      assert.ok(
        !logs.some((l) => l.includes('run-tc3-marker')),
        `expected no disposal log line to mention the marker dir, got: ${JSON.stringify(logs)}`,
      );

      const autoClassified = classifyOrphanRunDirs(root, { includeMarkerDirs: false });
      const autoAll = [...autoClassified.mechanicallySafe, ...autoClassified.superseded, ...autoClassified.kept]
        .map((d) => path.resolve(d));
      assert.ok(
        !autoAll.includes(path.resolve(dir)),
        'AUTO mode (includeMarkerDirs:false) must exclude the marker dir from ALL THREE classification lists',
      );

      const cliClassified = classifyOrphanRunDirs(root, { includeMarkerDirs: true });
      assert.ok(
        cliClassified.mechanicallySafe.map((d) => path.resolve(d)).includes(path.resolve(dir)),
        'interactive-CLI mode (includeMarkerDirs:true) must classify the marker dir mechanicallySafe (still listed/deleted there)',
      );

      // Drive the ACTUAL interactive CLI entry point (cc-orch clean --runs
      // delegates to this exact function) with --force to skip the prompt —
      // proves the marker dir is not just "listed" mechanicallySafe under
      // includeMarkerDirs:true, but genuinely DELETED via that path.
      await reapOrphanRunDirs(root, { force: true });
      assert.ok(
        !fs.existsSync(dir),
        'the interactive CLI path (reapOrphanRunDirs, includeMarkerDirs:true) must actually delete the dry-run.marker dir',
      );
    } finally {
      cleanup(root);
    }
  },
);

// ── TC4 ──────────────────────────────────────────────────────────────────

await test(
  'TC4: .harness/stale/ contents (and SHARED_SUBDIRS) are never enumerated or auto-emptied by a sweep',
  async () => {
    const root = makeTmpRoot('cc-hh-tc4-');
    try {
      const stale = path.join(harnessRoot(root), 'stale');
      fs.mkdirSync(stale, { recursive: true });
      const staleEntry = path.join(stale, 'run-old-quarantined');
      fs.mkdirSync(staleEntry, { recursive: true });
      fs.writeFileSync(path.join(staleEntry, 'state.json'), '{ not valid json');
      fs.writeFileSync(path.join(stale, 'loose-file.txt'), 'leftover');

      // SHARED_SUBDIRS — never candidates.
      const learningDir = path.join(harnessRoot(root), 'learning');
      const dryRunDir = path.join(harnessRoot(root), 'dry-run');
      const brainstormDir = path.join(harnessRoot(root), 'brainstorm');
      for (const d of [learningDir, dryRunDir, brainstormDir]) {
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'seed.txt'), 'seed content');
      }

      const logs = [];
      let threw = false;
      try {
        sweepOrphanRunDirs(root, { log: (m) => logs.push(m) });
      } catch {
        threw = true;
      }
      assert.ok(!threw, 'sweepOrphanRunDirs must never throw');

      assert.ok(fs.existsSync(staleEntry), '.harness/stale/ subdirectory must be untouched');
      assert.ok(fs.existsSync(path.join(staleEntry, 'state.json')), '.harness/stale/ subdir contents must be untouched');
      assert.ok(fs.existsSync(path.join(stale, 'loose-file.txt')), '.harness/stale/ loose file must be untouched');
      assert.ok(
        !logs.some((l) => l.includes('run-old-quarantined')),
        `expected no log line to reference .harness/stale/ contents, got: ${JSON.stringify(logs)}`,
      );

      for (const d of [learningDir, dryRunDir, brainstormDir]) {
        assert.ok(fs.existsSync(path.join(d, 'seed.txt')), `SHARED_SUBDIRS entry ${path.basename(d)} must be untouched`);
      }

      const classified = classifyOrphanRunDirs(root, { includeMarkerDirs: false });
      const allDirs = [...classified.mechanicallySafe, ...classified.superseded, ...classified.kept]
        .map((d) => path.resolve(d));
      assert.ok(!allDirs.includes(path.resolve(stale)), 'stale/ itself must never be a classification candidate');
      assert.ok(!allDirs.includes(path.resolve(staleEntry)), 'stale/ contents must never be enumerated as classification candidates');
    } finally {
      cleanup(root);
    }
  },
);

// ── TC5 ──────────────────────────────────────────────────────────────────

await test(
  'TC5: a parked-runId collected from queue/*/park.json shields a matching run dir from mechanicallySafe rm; a same-shape unshielded dir is still rm\'d',
  async () => {
    const root = makeTmpRoot('cc-hh-tc5-');
    try {
      const parkedRunId = 'run-tc5-parked-shield';
      const shieldedDir = path.join(harnessRoot(root), parkedRunId);
      fs.mkdirSync(shieldedDir, { recursive: true });
      // No parseable state.json — otherwise mechanicallySafe on its own; the
      // parked-runId shield must be applied BEFORE that disposition.
      fs.writeFileSync(path.join(shieldedDir, 'state.json'), '{ not valid json');

      createQueueEntry(root, 'tc5-slug', { status: 'parked' });
      writeParkScene(root, 'tc5-slug', { runId: parkedRunId });

      const classified = classifyOrphanRunDirs(root, { includeMarkerDirs: false });
      assert.ok(
        classified.kept.map((d) => path.resolve(d)).includes(path.resolve(shieldedDir)),
        'a run dir named after a LIVE parked queue entry\'s park.json runId must be classified kept (shielded)',
      );
      assert.ok(
        !classified.mechanicallySafe.map((d) => path.resolve(d)).includes(path.resolve(shieldedDir)),
        'the shielded dir must NOT appear in mechanicallySafe despite its unparseable state.json',
      );

      const logs = [];
      sweepOrphanRunDirs(root, { log: (m) => logs.push(m) });
      assert.ok(fs.existsSync(shieldedDir), 'the parked-runId-shielded dir must survive the sweep');

      // Negative control: same shape (unparseable state.json, run-* name),
      // but no park.json anywhere references it — not shielded, still rm'd.
      const unshieldedDir = path.join(harnessRoot(root), 'run-tc5-unshielded');
      fs.mkdirSync(unshieldedDir, { recursive: true });
      fs.writeFileSync(path.join(unshieldedDir, 'state.json'), '{ not valid json');

      sweepOrphanRunDirs(root, { log: (m) => logs.push(m) });
      assert.ok(!fs.existsSync(unshieldedDir), 'an unshielded same-shape orphan dir must still be rm\'d');
      assert.ok(fs.existsSync(shieldedDir), 'the shielded dir must still survive the second sweep pass');
    } finally {
      cleanup(root);
    }
  },
);

// ── EC33 ─────────────────────────────────────────────────────────────────

await test(
  'EC33-1: a genuinely cross-form pair (ROOT-form candidate <root>/<slug>.md vs QUEUE-form archive <root>/queue/<slug>/spec.md of the same anchor+slug) canonically MATCHES — candidate superseded and quarantined (the live ec33 miss)',
  async () => {
    const root = makeTmpRoot('cc-hh-ec33a-');
    try {
      const slug = 'ec33-cross';
      const rootFormPrdPath = path.join(root, `${slug}.md`);
      const queueFormPrdPath = path.join(root, 'queue', slug, 'spec.md');

      // Direct unit-level proof first: the predicate MUST match this
      // cross-form pair in both argument orders — the engine records the
      // same spec both ways (direct run = ROOT form, batch = QUEUE form).
      assert.strictEqual(
        prdPathsMatch(rootFormPrdPath, queueFormPrdPath), true,
        'prdPathsMatch(ROOT-form, QUEUE-form) of the same anchor+slug must be true — the ec33 cross-form identity',
      );
      assert.strictEqual(
        prdPathsMatch(queueFormPrdPath, rootFormPrdPath), true,
        'prdPathsMatch(QUEUE-form, ROOT-form) of the same anchor+slug must be true (reverse argument order)',
      );

      // End-to-end: a run dir recording the ROOT-form prdPath IS superseded
      // by a strictly newer archive recording the QUEUE-form prdPath of the
      // same anchor+slug (on shipped 0.1.171 this dir was wrongly KEPT).
      const { harnessDir: dir } = bootstrap(root, { runId: 'run-ec33a-candidate' });
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      state.projectMeta = { ...(state.projectMeta || {}), prdPath: rootFormPrdPath };
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
      setMtime(path.join(dir, 'state.json'), BASE_MS);

      const archiveDir = path.join(root, 'archives', '001-ec33a');
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, 'state.json'), JSON.stringify({ projectMeta: { prdPath: queueFormPrdPath } }));
      setMtime(path.join(archiveDir, 'state.json'), NEWER_MS);

      const classified = classifyOrphanRunDirs(root, { includeMarkerDirs: false });
      assert.ok(
        classified.superseded.map((d) => path.resolve(d)).includes(path.resolve(dir)),
        'the ROOT-form candidate must be classified superseded — the QUEUE-form archive of the same anchor+slug supersedes it',
      );
      assert.ok(
        !classified.kept.map((d) => path.resolve(d)).includes(path.resolve(dir)),
        'the ROOT-form candidate must NOT appear in kept',
      );
    } finally {
      cleanup(root);
    }
  },
);

await test(
  'EC33-2: the reverse pairing (QUEUE-form candidate vs ROOT-form archive of the same anchor+slug) also canonically MATCHES — candidate superseded',
  async () => {
    const root = makeTmpRoot('cc-hh-ec33b-');
    try {
      const slug = 'ec33-cross-rev';
      const queueFormPrdPath = path.join(root, 'queue', slug, 'spec.md');
      const rootFormPrdPath = path.join(root, `${slug}.md`);

      const { harnessDir: dir } = bootstrap(root, { runId: 'run-ec33b-candidate' });
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      state.projectMeta = { ...(state.projectMeta || {}), prdPath: queueFormPrdPath };
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
      setMtime(path.join(dir, 'state.json'), BASE_MS);

      const archiveDir = path.join(root, 'archives', '001-ec33b');
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, 'state.json'), JSON.stringify({ projectMeta: { prdPath: rootFormPrdPath } }));
      setMtime(path.join(archiveDir, 'state.json'), NEWER_MS);

      const classified = classifyOrphanRunDirs(root, { includeMarkerDirs: false });
      assert.ok(
        classified.superseded.map((d) => path.resolve(d)).includes(path.resolve(dir)),
        'the QUEUE-form candidate must be classified superseded — the ROOT-form archive of the same anchor+slug supersedes it',
      );
      assert.ok(
        !classified.kept.map((d) => path.resolve(d)).includes(path.resolve(dir)),
        'the QUEUE-form candidate must NOT appear in kept',
      );
    } finally {
      cleanup(root);
    }
  },
);

await test(
  'EC33-3: a nested-dir prdPath (<root>/specs/foo.md) and an outside-project prdPath do not canonicalize (exact-string only)',
  async () => {
    const root = '/tmp/ec33-nested-root-does-not-need-to-exist';
    const nestedPrdPath = path.join(root, 'specs', 'foo.md');
    const outsideProjectPrdPath = '/completely/different/tree/foo.md';
    const queueFormPrdPath = path.join(root, 'queue', 'foo', 'spec.md');

    assert.strictEqual(
      prdPathsMatch(nestedPrdPath, outsideProjectPrdPath), false,
      'a nested-dir prdPath and an out-of-project prdPath sharing only a basename must not canonicalize',
    );
    assert.strictEqual(
      prdPathsMatch(nestedPrdPath, queueFormPrdPath), false,
      'a nested-dir (non-root, non-queue) prdPath must not canonicalize against a queue-form prdPath of the same basename slug',
    );
    assert.strictEqual(
      prdPathsMatch(outsideProjectPrdPath, queueFormPrdPath), false,
      'an out-of-project prdPath must not canonicalize against an in-project queue-form prdPath of the same basename',
    );
  },
);

await test(
  'EC33-4: the REAL discriminating null-slug-shield regression — a root-form candidate matching an extension-dropped archive of the SAME identity is superseded and quarantined (shipped 0.1.171\'s inverted null-slug shield would have wrongly kept it)',
  async () => {
    const root = makeTmpRoot('cc-hh-ec33c-');
    try {
      const slug = 'ec33-nullslug';
      const rootFormPrdPath = path.join(root, `${slug}.md`);
      // A trailing extension dropped by a normalizer upstream — a genuine,
      // achievable root-form tolerance match per prdPathsMatch's documented
      // intent (NOT a cross-form pair; this is the one case the root-form
      // branch actually exists to handle).
      const extensionDroppedPrdPath = rootFormPrdPath.slice(0, -3);
      assert.ok(extensionDroppedPrdPath !== rootFormPrdPath && !extensionDroppedPrdPath.endsWith('.md'));

      assert.strictEqual(
        prdPathsMatch(rootFormPrdPath, extensionDroppedPrdPath), true,
        'prdPathsMatch must tolerate a trailing-.md-dropped archive recording of the same root-form identity',
      );

      // Direct pin of CHANGE (1): a candidate whose OWN prdPath is root-form
      // (extractRawQueueSlug → null) must NOT be vacuously shielded.
      assert.strictEqual(
        isShieldedByLiveRef(root, null), false,
        'isShieldedByLiveRef(root, null) must be false — the shipped clean.js predecessor\'s `if (!rawSlug) return true;` (inverted null-slug shield) is the exact regression this pins',
      );

      const { harnessDir: dir } = bootstrap(root, { runId: 'run-ec33c-candidate' });
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      state.projectMeta = { ...(state.projectMeta || {}), prdPath: rootFormPrdPath };
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
      setMtime(path.join(dir, 'state.json'), BASE_MS);

      const archiveDir = path.join(root, 'archives', '001-ec33c');
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, 'state.json'), JSON.stringify({ projectMeta: { prdPath: extensionDroppedPrdPath } }));
      setMtime(path.join(archiveDir, 'state.json'), NEWER_MS);

      const classified = classifyOrphanRunDirs(root, { includeMarkerDirs: false });
      assert.ok(
        classified.superseded.map((d) => path.resolve(d)).includes(path.resolve(dir)),
        'the root-form candidate must be classified superseded (matched + newer archive + null-rawSlug correctly NOT shielded)',
      );
      assert.ok(
        !classified.kept.map((d) => path.resolve(d)).includes(path.resolve(dir)),
        'the root-form candidate must NOT be classified kept — the fixed null-slug shield must not vacuously protect it',
      );

      const base = path.basename(dir);
      const logs = [];
      sweepOrphanRunDirs(root, { log: (m) => logs.push(m) });
      assert.ok(!fs.existsSync(dir), 'original run dir must be gone after quarantine');
      assert.ok(
        fs.existsSync(path.join(harnessRoot(root), 'stale', base)),
        'the candidate must be quarantined into .harness/stale/ — proving the fixed shield does not wrongly keep it',
      );
    } finally {
      cleanup(root);
    }
  },
);

// ── FS (fail-soft) ───────────────────────────────────────────────────────

await test(
  'FS: a candidate engineered to throw mid-classification is skipped (appears in no list) without aborting classification of the other candidates; sweepOrphanRunDirs still disposes of the remaining ones and never throws',
  async () => {
    const root = makeTmpRoot('cc-hh-fs-');
    try {
      const goodDirA = path.join(harnessRoot(root), 'run-fs-good-a');
      fs.mkdirSync(goodDirA, { recursive: true });
      // no state.json — mechanicallySafe.

      const boomDir = path.join(harnessRoot(root), 'run-fs-boom');
      fs.mkdirSync(boomDir, { recursive: true });
      // no state.json either — would ALSO be mechanicallySafe, but classification
      // never gets that far: the engineered throw fires first.

      const goodDirB = path.join(harnessRoot(root), 'run-fs-good-b');
      fs.mkdirSync(goodDirB, { recursive: true });
      // no state.json — mechanicallySafe.

      // Monkey-patch fs.existsSync (the harness-reaper module imports the
      // SAME CommonJS `fs` singleton object, so this override is visible to
      // it too) to throw ONLY for run-fs-boom's dry-run.marker check — the
      // one call in the per-dir loop body that is NOT already wrapped in its
      // own inner try/catch, so the exception escapes to the per-dir
      // fail-soft catch (classifyOrphanRunDirs' documented "skip it, appears
      // in none of the three lists, continue" behavior).
      const originalExistsSync = fs.existsSync;
      fs.existsSync = function (p, ...rest) {
        if (typeof p === 'string' && p.includes('run-fs-boom') && p.endsWith('dry-run.marker')) {
          throw new Error('ENGINEERED: dry-run.marker check exploded mid-classification');
        }
        return originalExistsSync.call(fs, p, ...rest);
      };

      let classified;
      let threwDuringClassify = false;
      try {
        classified = classifyOrphanRunDirs(root, { includeMarkerDirs: false });
      } catch {
        threwDuringClassify = true;
      } finally {
        fs.existsSync = originalExistsSync;
      }

      assert.ok(!threwDuringClassify, 'classifyOrphanRunDirs must never throw even when a per-dir candidate errors mid-classification');
      const allClassified = [...classified.mechanicallySafe, ...classified.superseded, ...classified.kept]
        .map((d) => path.resolve(d));
      assert.ok(
        !allClassified.includes(path.resolve(boomDir)),
        'the engineered-error candidate must appear in NONE of the three classification lists',
      );
      assert.ok(
        classified.mechanicallySafe.map((d) => path.resolve(d)).includes(path.resolve(goodDirA)),
        'a sibling candidate before the engineered error must still be classified normally',
      );
      assert.ok(
        classified.mechanicallySafe.map((d) => path.resolve(d)).includes(path.resolve(goodDirB)),
        'a sibling candidate after the engineered error must still be classified normally — classification of remaining candidates continues',
      );

      // Re-apply the patch and drive the actual sweep: it must log/dispose
      // of the surviving good candidates, skip (never touch) the boomed
      // one, and never throw.
      fs.existsSync = function (p, ...rest) {
        if (typeof p === 'string' && p.includes('run-fs-boom') && p.endsWith('dry-run.marker')) {
          throw new Error('ENGINEERED: dry-run.marker check exploded mid-classification');
        }
        return originalExistsSync.call(fs, p, ...rest);
      };
      const logs = [];
      let threwDuringSweep = false;
      try {
        sweepOrphanRunDirs(root, { log: (m) => logs.push(m) });
      } catch {
        threwDuringSweep = true;
      } finally {
        fs.existsSync = originalExistsSync;
      }

      assert.ok(!threwDuringSweep, 'sweepOrphanRunDirs must never throw even when a per-dir candidate errors mid-classification');
      assert.ok(!fs.existsSync(goodDirA), 'the sibling candidate before the engineered error must still be reaped');
      assert.ok(!fs.existsSync(goodDirB), 'the sibling candidate after the engineered error must still be reaped');
      assert.ok(fs.existsSync(boomDir), 'the engineered-error candidate itself must survive (never classified, so never disposed)');
      assert.ok(
        logs.some((l) => l.includes('run-fs-good-a')) && logs.some((l) => l.includes('run-fs-good-b')),
        `expected disposal log lines for both surviving siblings, got: ${JSON.stringify(logs)}`,
      );
    } finally {
      cleanup(root);
    }
  },
);

// ── TC6 ──────────────────────────────────────────────────────────────────

await test(
  'TC6: a REAL 2-entry batchResume — sweepOrphanRunDirs fires at the top of the queue loop and again in finally, STRICTLY AFTER closeReusableSession; a pre-seeded superseded dir is quarantined at batch start; both entries\' post-archive husks are reaped by the finally sweep',
  async () => {
    const root = makeGitRoot({ prefix: 'cc-hh-tc6-' });
    try {
      const startOrphanDir = path.join(harnessRoot(root), 'run-orphan-start-tc6');
      fs.mkdirSync(startOrphanDir, { recursive: true });
      // no state.json — mechanicallySafe, reaped by the BATCH-START sweep
      // (which runs before the queue loop even begins).

      // A pre-seeded SUPERSEDED dir (parseable state.json, queue-form
      // prdPath matching a pre-existing, strictly-newer archive entry for an
      // UNRELATED slug) — must be quarantined into .harness/stale/ by the
      // same batch-start sweep, not merely rm'd.
      const supersededSlug = 'tc6-superseded-slug';
      const supersededPrdPath = path.join(root, 'queue', supersededSlug, 'spec.md');
      const { harnessDir: supersededDir } = bootstrap(root, { runId: 'run-tc6-superseded', prdPath: supersededPrdPath });
      setMtime(path.join(supersededDir, 'state.json'), BASE_MS);
      const supersededBase = path.basename(supersededDir);
      const oldArchiveDir = path.join(root, 'archives', '000-tc6-old');
      fs.mkdirSync(oldArchiveDir, { recursive: true });
      fs.writeFileSync(path.join(oldArchiveDir, 'state.json'), JSON.stringify({ projectMeta: { prdPath: supersededPrdPath } }));
      setMtime(path.join(oldArchiveDir, 'state.json'), NEWER_MS);
      // archives/ is NOT gitignored (unlike .harness/ and queue/) — commit
      // this fixture so batchResume's clean-tree guard doesn't refuse.
      git(['add', '-A'], root);
      git(['commit', '-q', '-m', 'seed tc6 old archive fixture'], root);

      // A REAL 2-entry queue.
      createQueueEntry(root, 'tc6-entry-a', { plan: makePlan({ assumptions: [] }) });
      createQueueEntry(root, 'tc6-entry-b', { plan: makePlan({ assumptions: [] }) });

      let finallyOrphanDir = null;
      let executeCount = 0;
      // Drive the REAL archive() via the opts.archive injection seam,
      // stubbing ONLY the summarizer (LLM) seam — precedent:
      // test-uncertain-advisory.js's TC4 (~:483-497). A fake archive() never
      // touches the per-run .harness dir (it only writes archives/<slug>/
      // separately), so it can never drain a per-run dir into a "husk" for
      // the finally-sweep to reap. The REAL archive() moves state.json (and
      // the other PER_RUN_SUBDIRS) out of the per-run harness dir via
      // moveHarnessToArchive, leaving behind an emptied husk (no parseable
      // state.json) that classifyOrphanRunDirs then sees as mechanicallySafe.
      const { pipeline, logs } = makeRealBatchPipeline(root, {
        archive: async (projectRoot, slug, flags) => realArchive(projectRoot, slug, flags, {
          summarize: async () => ({ headline: 'tc6 headline', bugs: [], summary: '', changelog: [] }),
        }),
        executeAllMilestones: async () => {
          executeCount++;
          if (executeCount === 1) {
            // Created DURING per-entry processing of the FIRST entry — does
            // not exist yet when the batch-start sweep ran, so it can only
            // be reaped by the finally-block sweep, which fires after
            // closeReusableSession.
            finallyOrphanDir = path.join(harnessRoot(root), 'run-orphan-finally-tc6');
            fs.mkdirSync(finallyOrphanDir, { recursive: true });
          }
        },
      });

      pipeline.planner.closeReusableSession = async () => {
        logs.push('MARKER: closeReusableSession called');
      };

      const result = await pipeline.batchResume({});
      assert.strictEqual(result.archived, 2, `expected 2 archived (real archive(), 2-entry queue), got ${JSON.stringify(result)}`);

      const startIdx = logs.findIndex((l) => l.includes('Reaped orphan run dir run-orphan-start-tc6.'));
      const quarantinedIdx = logs.findIndex((l) => l.includes(`Quarantined superseded run dir ${supersededBase} \u2192 .harness/stale/`));
      const markerIdx = logs.findIndex((l) => l === 'MARKER: closeReusableSession called');
      const finallyIdx = logs.findIndex((l) => l.includes('Reaped orphan run dir run-orphan-finally-tc6.'));

      assert.notStrictEqual(startIdx, -1, `expected a start-of-batch sweep log line, got: ${JSON.stringify(logs)}`);
      assert.notStrictEqual(quarantinedIdx, -1, `expected a start-of-batch quarantine log line for the superseded dir, got: ${JSON.stringify(logs)}`);
      assert.notStrictEqual(markerIdx, -1, 'expected the closeReusableSession marker to have been logged');
      assert.notStrictEqual(finallyIdx, -1, `expected a finally-block sweep log line, got: ${JSON.stringify(logs)}`);

      assert.ok(startIdx < markerIdx, 'the batch-start sweep must fire before closeReusableSession');
      assert.ok(quarantinedIdx < markerIdx, 'the batch-start quarantine of the superseded dir must fire before closeReusableSession');
      assert.ok(markerIdx < finallyIdx, 'the finally-block sweep must fire strictly AFTER closeReusableSession');

      assert.ok(!fs.existsSync(startOrphanDir), 'the batch-start orphan must have been reaped');
      assert.ok(finallyOrphanDir && !fs.existsSync(finallyOrphanDir), 'the mid-run orphan must have been reaped by the finally sweep');

      assert.ok(!fs.existsSync(supersededDir), 'the superseded dir\'s original path must be gone (quarantined, not left in place)');
      assert.ok(
        fs.existsSync(path.join(harnessRoot(root), 'stale', supersededBase)),
        'the superseded dir must be quarantined into .harness/stale/ at batch start',
      );

      // Husks gone: the REAL archive() drained both entries' per-run harness
      // dirs (state.json moved into archives/), and the finally-block sweep
      // reaped the resulting empty husks — no run-* dirs should remain.
      const remainingRunDirs = fs.readdirSync(harnessRoot(root)).filter((name) => name.startsWith('run-'));
      assert.deepStrictEqual(
        remainingRunDirs, [],
        `expected no leftover run-* husk dirs after batchResume, got: ${JSON.stringify(remainingRunDirs)}`,
      );

      // (archives/000-tc6-old/ is the pre-seeded fixture archive used only to
      // supersede the quarantined dir above — excluded here since this
      // assertion is scoped to the two REAL entries this batch archived.)
      const archiveEntries = fs.readdirSync(path.join(root, 'archives')).filter((d) => /^\d{3}-tc6-entry-/.test(d));
      assert.strictEqual(archiveEntries.length, 2, `expected exactly 2 real archive dirs for the batch entries, got: ${JSON.stringify(archiveEntries)}`);
    } finally {
      cleanup(root);
    }
  },
);

// ── TC7 ──────────────────────────────────────────────────────────────────

await test(
  'TC7a: Pipeline.run() with an already-held foreign active-run pointer refuses without sweeping — a pre-seeded husk run dir survives',
  async () => {
    const root = makeTmpRoot('cc-hh-tc7a-');
    try {
      const foreignRunId = generateRunId('foreign');
      const claimedForeign = claimActiveRun(root, { runId: foreignRunId, slug: 'foreign', kind: 'run' });
      assert.ok(claimedForeign, 'sanity: foreign pointer claim should succeed on a fresh root');
      // Deliberately no run dir/state.json for the foreign pointer, so
      // _checkOverwriteProtection's stateFile existsSync check is false and
      // it returns silently (no throw) — the refusal path returns cleanly.

      const huskDir = path.join(harnessRoot(root), 'run-tc7-husk-refused');
      fs.mkdirSync(huskDir, { recursive: true });

      const logs = [];
      const pipeline = makeRunnablePipeline(root, { onLog: (m) => logs.push(m) });
      await pipeline.run('Some goal', { auto: true });

      assert.ok(fs.existsSync(huskDir), 'the husk run dir must SURVIVE when the concurrent claim is refused');
      assert.ok(
        !logs.some((l) => l.includes('[harness-reaper]')),
        `expected no harness-reaper sweep log line on a refused claim, got: ${JSON.stringify(logs)}`,
      );
      assert.ok(
        logs.some((l) => l.includes('Refusing to start a new run')),
        'expected the refusal message to have been logged',
      );

      const pointer = readActiveRunPointer(root);
      assert.ok(pointer, 'the foreign pointer must still be present');
      assert.strictEqual(pointer.runId, foreignRunId, 'the foreign pointer must be unchanged (never re-claimed)');
    } finally {
      cleanup(root);
    }
  },
);

await test(
  'TC7b: Pipeline.run() with a free active-run pointer claims successfully and sweeps — a pre-seeded husk run dir is reaped',
  async () => {
    const root = makeTmpRoot('cc-hh-tc7b-');
    try {
      assert.strictEqual(readActiveRunPointer(root), null, 'sanity: fresh root should have no active-run pointer');

      const huskDir = path.join(harnessRoot(root), 'run-tc7-husk-swept');
      fs.mkdirSync(huskDir, { recursive: true });

      const logs = [];
      const pipeline = makeRunnablePipeline(root, { onLog: (m) => logs.push(m) });
      await pipeline.run('Some goal', { auto: true });

      assert.ok(!fs.existsSync(huskDir), 'the husk run dir must be swept away after a successful claim');
      assert.ok(
        logs.some((l) => l.includes('Reaped orphan run dir run-tc7-husk-swept.')),
        `expected a sweep log line after a successful claim, got: ${JSON.stringify(logs)}`,
      );

      const pointer = readActiveRunPointer(root);
      assert.ok(pointer && typeof pointer.runId === 'string' && pointer.runId.length > 0, 'run() should have claimed a new pointer');
    } finally {
      cleanup(root);
    }
  },
);

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
