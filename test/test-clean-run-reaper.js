#!/usr/bin/env node
/**
 * test-clean-run-reaper.js — reapOrphanRunDirs (`cc-orch clean --runs`)
 * classification + protection tests.
 *
 * Behavior under test (spec, see src/cli/commands/clean.js):
 *   - A non-pointer run-* dir with a PARSEABLE state.json and NO
 *     dry-run.marker is "terminal/active" → PRESERVED on disk, and a
 *     '[clean] Keeping terminal/active run dir: <basename>' line is logged.
 *     This holds regardless of whether the milestone content inside
 *     state.json reads as complete or still in-progress — the reaper does
 *     not inspect milestone status, only state.json parseability and the
 *     presence/absence of dry-run.marker.
 *   - The run dir currently referenced by the active-run pointer (resolved
 *     via resolveActiveHarnessDir) is EXCLUDED from classification entirely
 *     — it is never a deletion candidate and is left untouched even when its
 *     state.json is terminal.
 *   - A non-pointer run-* dir with a parseable state.json AND a
 *     dry-run.marker file is "mechanically-safe" → REAPED (removed from
 *     disk), with a '[clean] Reaped orphan run dir <basename>.' line logged.
 *   - A non-pointer run-* dir with NO parseable state.json (absent or
 *     corrupt) is also "mechanically-safe" → REAPED, logged.
 *   - SHARED_SUBDIRS (learning, dry-run, brainstorm) and any other non
 *     'run-*' entry directly under .harness/ (including the 'active-run'
 *     pointer file) are never enumerated as reap candidates and survive the
 *     --runs pass untouched.
 *
 * Fixtures: a single fs.mkdtempSync root built entirely from REAL
 * bootstrap(root, { runId }) calls (one per scenario run dir), then
 * hand-mutated per scenario (flip globalStatus/milestones, drop a
 * dry-run.marker file, delete/corrupt state.json, claim the active-run
 * pointer). All seven cases are exercised against ONE
 * reapOrphanRunDirs(root, { force: true }) call, matching the spec's
 * framing of a single "--runs reap pass".
 *
 * TC1 — case (a): non-pointer terminal/complete run dir preserved + logged.
 * TC2 — case (b): active-run pointer target dir untouched, never deleted.
 * TC3 — case (c): non-pointer active/in-progress run dir preserved + logged.
 * TC4 — case (d): non-pointer run dir w/ state.json + dry-run.marker reaped.
 * TC5 — case (e): non-pointer run dir w/ no parseable state.json reaped.
 * TC6 — case (f): SHARED_SUBDIRS + non-run-* entries untouched.
 * TC7 — case (g): active-run pointer file itself survives the --runs pass.
 *
 * Run: node test/test-clean-run-reaper.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

// See scripts/run-tests.js for why this is cleared at module top: the
// mkdtemp fixture roots below are NOT re-entrant cc-orch invocations, but a
// CC_ORCH_ACTIVE_RUN inherited from a live parent run would trip
// assertNoReentrantLiveRun (called internally by bootstrap()) on any fixture
// root that ends up with an active-run pointer + active state.json — exactly
// what case (b)'s fixture constructs.
delete process.env.CC_ORCH_ACTIVE_RUN;

import { reapOrphanRunDirs } from '../src/cli/commands/clean.js';
import { bootstrap, SHARED_SUBDIRS } from '../src/orchestrator/core/bootstrap.js';
import {
  harnessRoot,
  runHarnessDir,
  activeRunPointerPath,
  claimActiveRun,
} from '../src/orchestrator/core/run-context.js';
import {
  prdPathsMatch,
  classifyOrphanRunDirs,
} from '../src/orchestrator/core/harness-reaper.js';

let passCount = 0;
let failCount = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passCount++;
  } else {
    console.log(`  [FAIL] ${label}`);
    failCount++;
  }
}

// ── fixture helpers ─────────────────────────────────────────────────────

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-clean-run-reaper-'));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Read + JSON.parse a run dir's state.json. */
function readState(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
}

/** Overwrite a run dir's state.json with the given (still-parseable) object. */
function writeState(runDir, state) {
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2));
}

/** Mutate a bootstrapped run dir's state.json into a "complete" shape. */
function markComplete(runDir) {
  const state = readState(runDir);
  state.globalStatus = 'complete';
  state.milestones = { 'milestone-001': { status: 'complete' } };
  writeState(runDir, state);
}

/** Mutate a bootstrapped run dir's state.json into an "in-progress" shape. */
function markInProgress(runDir) {
  const state = readState(runDir);
  state.globalStatus = 'active';
  state.milestones = { 'milestone-001': { status: 'in_progress' } };
  writeState(runDir, state);
}

/** Drop a dry-run.marker file into a run dir. */
function plantDryRunMarker(runDir) {
  fs.writeFileSync(path.join(runDir, 'dry-run.marker'), '');
}

/**
 * Run reapOrphanRunDirs(root, flags) while capturing everything console.log
 * emits. Restores console.log in a finally so a throw doesn't poison later
 * tests. Returns { output, threw, err }.
 */
async function runReap(root, flags) {
  const chunks = [];
  const origLog = console.log;
  console.log = (...args) => { chunks.push(args.join(' ')); };
  let threw = false;
  let err = null;
  try {
    await reapOrphanRunDirs(root, flags);
  } catch (e) {
    threw = true;
    err = e;
  } finally {
    console.log = origLog;
  }
  return { output: chunks.join('\n'), threw, err };
}

// ── superseded-classifier fixture helpers (appended below; TC1–TC7 above and
// every helper they use are UNTOUCHED) ─────────────────────────────────────
//
// TC8  — case (a): superseded run dir (newer matching archive, archive name
//        shares no prefix with the run slug) → quarantined to .harness/stale/.
// TC9  — case (b): failed-<NNN>-<anything> archive parity with TC8.
// TC10 — case (c): no prdPath-matching archive (decoy has a similar name but
//        a different prdPath) → kept.
// TC11 — case (d): REF SHIELD — a live refs/park/<raw-dotted-slug> (and,
//        separately, refs/interrupt/<raw-dotted-slug>) keeps an otherwise-
//        superseded dir.
// TC12 — case (e): POINTER SHIELD — the active-run pointer target is never a
//        candidate even with a newer matching archive.
// TC13 — case (f): mechanically-safe parity — no-state.json / dry-run.marker
//        dirs are still rm'd, never quarantined.
// TC14 — case (g): an archives/ entry lacking state.json is skipped without
//        throwing, while a separately superseded dir is still quarantined.
// TC15 — case (h): --force skips the prompt and performs both dispositions
//        (rm + quarantine) in one pass.
// TC16 — case (i): a matching archive with an OLDER state.json mtime leaves
//        the dir kept.
//
// Build-time audit (no re-pin needed here): every archive fixture TC8–TC16
// constructs uses a QUEUE-form prdPath (`queue/<slug>/spec.md`), so
// extractRawQueueSlug never returns null for them — none of TC8–TC16 ever
// exercised (nor pinned a KEEP disposition via) the old inverted
// `isShieldedByLiveRef(root, null)` bug. The corrected (post-fix) semantics —
// a null-rawSlug (ROOT-form) candidate is NOT vacuously shielded and must be
// QUARANTINED when superseded — are pinned fresh below by TC17/TC18 (the
// canonical-identity CROSS-form cases), which are ROOT-form on one side.
//
// TC17 — AC-2/C1 (forward): a ROOT-form candidate (<root>/<slug>.md) is
//        quarantined via the REAL reapOrphanRunDirs wrapper by a strictly
//        newer QUEUE-form archive (<root>/queue/<slug>/spec.md) of the same
//        anchor+slug — the ec33 cross-form identity, end-to-end through CLI.
// TC18 — AC-2/C1 (reverse): the reverse pairing (QUEUE-form candidate vs
//        ROOT-form archive of the same anchor+slug) is likewise quarantined
//        via the wrapper. prdPathsMatch is asserted true in both argument
//        orders for the same cross-form pair.
// TC19 — AC-2/C2: task-command NON-COLLAPSE — two run dirs whose prdPaths
//        are distinct nested <runDir>/tmp-spec-archived.md files never
//        canonically collapse; an archive matching dirA's exact nested path
//        quarantines dirA only via the wrapper, dirB is kept.
// TC20 — AC-2/C3: a nested <root>/specs/<slug>.md prdPath does not
//        canonically match a queue-form or root-form archive of the same
//        basename slug → kept via the wrapper.
// TC21 — AC-2/C4: a run dir whose basename equals a LIVE parked queue
//        entry's park.json runId is kept through the wrapper even with a
//        corrupt state.json; a same-shape dir with no matching park.json is
//        still reaped.
// TC22 — AC-2/C5: a dry-run.marker orphan dir is listed
//        (classifyOrphanRunDirs, includeMarkerDirs:true) and DELETED via the
//        interactive reapOrphanRunDirs path, with the reaped-log line naming
//        it.

/** Run git with argv (no shell) in cwd; throws on non-zero exit. */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * git-init a fixture root with identity config + one commit, so HEAD is
 * resolvable (git update-ref needs an existing object to point a ref at).
 * Only the ref-shield fixture (TC11) needs this — listSnapshotRefs returns
 * [] on a non-git root, which is exactly the behavior the OTHER new TCs rely
 * on (no park/interrupt ref ever matches, so the shield never fires there).
 */
function gitInitRoot(root) {
  git(['init', '-q'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'CC Test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  fs.writeFileSync(path.join(root, '.gitkeep'), '');
  git(['add', '.gitkeep'], root);
  git(['commit', '-q', '-m', 'init'], root);
}

/** Plant a ref (e.g. refs/park/<slug>) pointing at HEAD. */
function plantRef(root, ref) {
  git(['update-ref', ref, 'HEAD'], root);
}

/**
 * Create a plain archives/<dirName>/state.json fixture directly with fs (NOT
 * via bootstrap() — archives/ entries are terminal snapshots read by
 * buildArchivePrdPathMap, not live run dirs) carrying the given prdPath, then
 * pin its state.json mtime via fs.utimesSync so newer/older comparisons
 * against a run dir's own state.json mtime are deterministic.
 */
function makeArchiveState(root, dirName, prdPath, mtimeMs) {
  const dir = path.join(root, 'archives', dirName);
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ projectMeta: { prdPath } }, null, 2));
  const t = mtimeMs / 1000;
  fs.utimesSync(statePath, t, t);
}

/** Create an archives/<dirName>/ entry with NO state.json (tolerance fixture). */
function makeArchiveWithoutState(root, dirName) {
  fs.mkdirSync(path.join(root, 'archives', dirName), { recursive: true });
}

/** Pin a run dir's own state.json mtime via fs.utimesSync for deterministic newer/older comparisons. */
function setStateMtime(runDir, mtimeMs) {
  const t = mtimeMs / 1000;
  fs.utimesSync(path.join(runDir, 'state.json'), t, t);
}

/** Absolute path to the .harness/stale/ quarantine destination for a fixture root. */
function staleDir(root) {
  return path.join(harnessRoot(root), 'stale');
}

/**
 * Plant a git-free, minimal LIVE parked queue/<slug>/ entry: a `status` file
 * (one of collectParkedRunIds' PARKED_STATUSES) plus a park.json carrying the
 * given runId. Only what collectParkedRunIds actually reads (status +
 * park.json) — no spec.md/plan.json/validated-at.json needed for the
 * parked-runId shield fixtures below.
 */
function plantParkedQueueEntry(root, slug, runId) {
  const entryDir = path.join(root, 'queue', slug);
  fs.mkdirSync(entryDir, { recursive: true });
  fs.writeFileSync(path.join(entryDir, 'status'), 'parked');
  fs.writeFileSync(path.join(entryDir, 'park.json'), JSON.stringify({ runId }));
}

// A fixed baseline + newer/older offsets, so archive-vs-run-dir mtime
// ordering is deterministic — no reliance on wall-clock write-ordering delays
// between fs calls.
const BASE_MS = Date.now();
const NEWER_MS = BASE_MS + 10 * 60 * 1000;
const OLDER_MS = BASE_MS - 10 * 60 * 1000;

/**
 * TC8–TC16 — superseded-classifier section. Each case gets its own
 * fs.mkdtempSync root (git-init'd only for TC11, the ref-shield case) and its
 * own reapOrphanRunDirs(root, flags) pass, kept separate from TC1–TC7's
 * shared root/pass.
 */
async function runSupersededClassifierTests() {
  console.log('\n=== Superseded-classifier Tests (TC8–TC16) ===\n');

  // ── TC8 / case (a): SUPERSEDED → QUARANTINE ─────────────────────────────
  console.log('TC8: superseded run dir (newer matching archive, no shared name prefix) → quarantined\n');
  {
    const root = makeTmpRoot();
    try {
      const slug = 'tc8-svc-alpha';
      const prdPath = path.join(root, 'queue', slug, 'spec.md');
      const { harnessDir: dir } = bootstrap(root, { runId: 'run-tc8-superseded', prdPath });
      setStateMtime(dir, BASE_MS);
      // Archive dir name deliberately shares NO prefix with the run dir's
      // slug/runId — pins the prdPath matcher, not a name matcher.
      makeArchiveState(root, '099-zzz-completely-unrelated', prdPath, NEWER_MS);

      const base = path.basename(dir);
      const { output, threw, err } = await runReap(root, { force: true });
      assert('TC8: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC8a: original run dir path is gone', !fs.existsSync(dir));
      assert('TC8b: quarantined dir exists at .harness/stale/<name>',
        fs.existsSync(path.join(staleDir(root), base)));
      assert('TC8c: output logs the quarantine line',
        output.includes(`Quarantined superseded run dir ${base} → .harness/stale/`));
    } finally {
      cleanup(root);
    }
  }

  // ── TC9 / case (b): failed-archive parity ───────────────────────────────
  console.log('\nTC9: failed-<NNN>-<anything> archive parity → quarantined\n');
  {
    const root = makeTmpRoot();
    try {
      const slug = 'tc9-svc-beta';
      const prdPath = path.join(root, 'queue', slug, 'spec.md');
      const { harnessDir: dir } = bootstrap(root, { runId: 'run-tc9-superseded', prdPath });
      setStateMtime(dir, BASE_MS);
      makeArchiveState(root, 'failed-004-anything', prdPath, NEWER_MS);

      const base = path.basename(dir);
      const { output, threw, err } = await runReap(root, { force: true });
      assert('TC9: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC9a: original run dir path is gone', !fs.existsSync(dir));
      assert('TC9b: quarantined dir exists at .harness/stale/<name>',
        fs.existsSync(path.join(staleDir(root), base)));
      assert('TC9c: output logs the quarantine line',
        output.includes(`Quarantined superseded run dir ${base} → .harness/stale/`));
    } finally {
      cleanup(root);
    }
  }

  // ── TC10 / case (c): NOT superseded (no prdPath-matching archive) ──────
  console.log('\nTC10: no prdPath-matching archive (decoy has different prdPath) → kept\n');
  {
    const root = makeTmpRoot();
    try {
      const slug = 'tc10-svc-gamma';
      const prdPath = path.join(root, 'queue', slug, 'spec.md');
      const { harnessDir: dir } = bootstrap(root, { runId: 'run-tc10-notsuperseded', prdPath });
      setStateMtime(dir, BASE_MS);
      // Decoy: similar dir NAME, but a DIFFERENT prdPath — must not match.
      const decoyPrdPath = path.join(root, 'queue', `${slug}-other`, 'spec.md');
      makeArchiveState(root, '010-tc10-svc-gamma-decoy', decoyPrdPath, NEWER_MS);

      const base = path.basename(dir);
      const { output, threw, err } = await runReap(root, { force: true });
      assert('TC10: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC10a: run dir still exists at its original path', fs.existsSync(dir));
      assert('TC10b: output logs "Keeping terminal/active run dir:" naming it',
        output.includes(`[clean] Keeping terminal/active run dir: ${base}`));
      assert('TC10c: run dir is NOT under .harness/stale/',
        !fs.existsSync(path.join(staleDir(root), base)));
    } finally {
      cleanup(root);
    }
  }

  // ── TC11 / case (d): REF SHIELD (park + interrupt) ──────────────────────
  console.log('\nTC11: live refs/park or refs/interrupt ref for the RAW dotted queue slug → kept\n');
  {
    const root = makeTmpRoot();
    gitInitRoot(root);
    try {
      // park sub-case
      const rawSlugPark = 'plan-time-disposition.park.spec';
      const prdPathPark = path.join(root, 'queue', rawSlugPark, 'spec.md');
      const { harnessDir: dirPark } = bootstrap(root, {
        runId: 'run-tc11-plan-time-disposition-park-spec',
        prdPath: prdPathPark,
      });
      setStateMtime(dirPark, BASE_MS);
      makeArchiveState(root, '020-unrelated-park', prdPathPark, NEWER_MS);
      plantRef(root, `refs/park/${rawSlugPark}`);

      // interrupt sub-case
      const rawSlugInterrupt = 'plan-time-disposition.interrupt.spec';
      const prdPathInterrupt = path.join(root, 'queue', rawSlugInterrupt, 'spec.md');
      const { harnessDir: dirInterrupt } = bootstrap(root, {
        runId: 'run-tc11-plan-time-disposition-interrupt-spec',
        prdPath: prdPathInterrupt,
      });
      setStateMtime(dirInterrupt, BASE_MS);
      makeArchiveState(root, '021-unrelated-interrupt', prdPathInterrupt, NEWER_MS);
      plantRef(root, `refs/interrupt/${rawSlugInterrupt}`);

      const basePark = path.basename(dirPark);
      const baseInterrupt = path.basename(dirInterrupt);
      const { threw, err } = await runReap(root, { force: true });
      assert('TC11: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC11a: refs/park-shielded run dir is KEPT', fs.existsSync(dirPark));
      assert('TC11a-not-stale: refs/park-shielded run dir is NOT under .harness/stale/',
        !fs.existsSync(path.join(staleDir(root), basePark)));
      assert('TC11b: refs/interrupt-shielded run dir is KEPT', fs.existsSync(dirInterrupt));
      assert('TC11b-not-stale: refs/interrupt-shielded run dir is NOT under .harness/stale/',
        !fs.existsSync(path.join(staleDir(root), baseInterrupt)));
    } finally {
      cleanup(root);
    }
  }

  // ── TC12 / case (e): POINTER SHIELD ─────────────────────────────────────
  console.log('\nTC12: active-run pointer target with a newer matching archive → never a candidate, kept\n');
  {
    const root = makeTmpRoot();
    try {
      const slug = 'tc12-pointer-target';
      const prdPath = path.join(root, 'queue', slug, 'spec.md');
      const { harnessDir: dir } = bootstrap(root, { runId: 'run-tc12-pointer', prdPath });
      setStateMtime(dir, BASE_MS);
      makeArchiveState(root, '030-unrelated-pointer', prdPath, NEWER_MS);
      const claimed = claimActiveRun(root, { runId: 'run-tc12-pointer', slug, kind: 'test' });
      assert('TC12 fixture: active-run pointer claimed', claimed === true);

      const base = path.basename(dir);
      const { output, threw, err } = await runReap(root, { force: true });
      assert('TC12: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC12a: pointer-target run dir still exists on disk', fs.existsSync(dir));
      assert('TC12b: pointer-target run dir is NOT under .harness/stale/',
        !fs.existsSync(path.join(staleDir(root), base)));
      assert('TC12c: output does not report the pointer target as quarantined',
        !output.includes(`Quarantined superseded run dir ${base} → .harness/stale/`));
    } finally {
      cleanup(root);
    }
  }

  // ── TC13 / case (f): mechanically-safe parity ───────────────────────────
  console.log("\nTC13: no-state.json dir + dry-run.marker dir → still rm'd, never quarantined\n");
  {
    const root = makeTmpRoot();
    try {
      const { harnessDir: dirNoState } = bootstrap(root, { runId: 'run-tc13-nostate' });
      fs.writeFileSync(path.join(dirNoState, 'state.json'), '{ not valid json ');

      const { harnessDir: dirMarker } = bootstrap(root, { runId: 'run-tc13-marker' });
      plantDryRunMarker(dirMarker);

      const baseNoState = path.basename(dirNoState);
      const baseMarker = path.basename(dirMarker);
      const { output, threw, err } = await runReap(root, { force: true });
      assert('TC13: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC13a: no-state.json dir was removed from disk', !fs.existsSync(dirNoState));
      assert('TC13b: output has "[clean] Reaped orphan run dir" naming the no-state dir',
        output.includes(`[clean] Reaped orphan run dir ${baseNoState}.`));
      assert('TC13c: dry-run.marker dir was removed from disk', !fs.existsSync(dirMarker));
      assert('TC13d: output has "[clean] Reaped orphan run dir" naming the marker dir',
        output.includes(`[clean] Reaped orphan run dir ${baseMarker}.`));
      assert('TC13e: no-state dir never appears under .harness/stale/',
        !fs.existsSync(path.join(staleDir(root), baseNoState)));
      assert('TC13f: marker dir never appears under .harness/stale/',
        !fs.existsSync(path.join(staleDir(root), baseMarker)));
      assert('TC13g: output contains no "Quarantined" line at all',
        !output.includes('Quarantined superseded run dir'));
    } finally {
      cleanup(root);
    }
  }

  // ── TC14 / case (g): archive-without-state tolerance ────────────────────
  console.log('\nTC14: archives/ entry lacking state.json is skipped without throwing\n');
  {
    const root = makeTmpRoot();
    try {
      makeArchiveWithoutState(root, '040-no-state');

      const slug = 'tc14-svc-delta';
      const prdPath = path.join(root, 'queue', slug, 'spec.md');
      const { harnessDir: dir } = bootstrap(root, { runId: 'run-tc14-superseded', prdPath });
      setStateMtime(dir, BASE_MS);
      makeArchiveState(root, '041-match', prdPath, NEWER_MS);

      const base = path.basename(dir);
      const { output, threw, err } = await runReap(root, { force: true });
      assert('TC14: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC14a: separately-superseded run dir was still quarantined',
        fs.existsSync(path.join(staleDir(root), base)));
      assert('TC14b: output logs the quarantine line',
        output.includes(`Quarantined superseded run dir ${base} → .harness/stale/`));
    } finally {
      cleanup(root);
    }
  }

  // ── TC15 / case (h): --force performs both dispositions in one pass ────
  console.log('\nTC15: --force skips the prompt, performs rm AND quarantine in one pass\n');
  {
    const root = makeTmpRoot();
    try {
      const { harnessDir: dirRm } = bootstrap(root, { runId: 'run-tc15-nostate' });
      fs.writeFileSync(path.join(dirRm, 'state.json'), '{ not valid json ');

      const slug = 'tc15-svc-epsilon';
      const prdPath = path.join(root, 'queue', slug, 'spec.md');
      const { harnessDir: dirQuarantine } = bootstrap(root, { runId: 'run-tc15-superseded', prdPath });
      setStateMtime(dirQuarantine, BASE_MS);
      makeArchiveState(root, '050-match-force', prdPath, NEWER_MS);

      const baseRm = path.basename(dirRm);
      const baseQuarantine = path.basename(dirQuarantine);
      const { output, threw, err } = await runReap(root, { force: true });
      assert('TC15: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC15a: output logs the --force skip-confirmation line',
        output.includes('[clean] --force: skipping confirmation, reaping orphan run dirs'));
      assert("TC15b: mechanically-safe dir was rm'd", !fs.existsSync(dirRm));
      assert('TC15c: output logs the reap line for the rm\'d dir',
        output.includes(`[clean] Reaped orphan run dir ${baseRm}.`));
      assert('TC15d: superseded dir was quarantined',
        fs.existsSync(path.join(staleDir(root), baseQuarantine)));
      assert('TC15e: output logs the quarantine line',
        output.includes(`Quarantined superseded run dir ${baseQuarantine} → .harness/stale/`));
    } finally {
      cleanup(root);
    }
  }

  // ── TC16 / case (i): OLDER archive leaves the dir KEPT ──────────────────
  console.log('\nTC16: matching archive with an OLDER state.json mtime → kept\n');
  {
    const root = makeTmpRoot();
    try {
      const slug = 'tc16-svc-zeta';
      const prdPath = path.join(root, 'queue', slug, 'spec.md');
      const { harnessDir: dir } = bootstrap(root, { runId: 'run-tc16-notsuperseded', prdPath });
      setStateMtime(dir, BASE_MS);
      makeArchiveState(root, '060-older-match', prdPath, OLDER_MS);

      const base = path.basename(dir);
      const { output, threw, err } = await runReap(root, { force: true });
      assert('TC16: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC16a: run dir still exists at its original path', fs.existsSync(dir));
      assert('TC16b: output logs "Keeping terminal/active run dir:" naming it',
        output.includes(`[clean] Keeping terminal/active run dir: ${base}`));
      assert('TC16c: run dir is NOT under .harness/stale/',
        !fs.existsSync(path.join(staleDir(root), base)));
    } finally {
      cleanup(root);
    }
  }
}

/**
 * TC17–TC22 — AC-2 CLI-path tests. Each case is driven end-to-end through the
 * REAL reapOrphanRunDirs(root, { force: true }) interactive wrapper (which
 * classifies with includeMarkerDirs:true), on its own fs.mkdtempSync
 * (git-free) fixture root.
 */
async function runCliPathCanonicalIdentityTests() {
  console.log('\n=== AC-2 CLI-path Tests (TC17–TC22) ===\n');

  // ── TC17 / AC-2 C1 (forward): ROOT-form candidate vs newer QUEUE-form ───
  console.log('TC17: ROOT-form candidate vs strictly-newer QUEUE-form archive of the same anchor+slug → quarantined via the wrapper\n');
  {
    const root = makeTmpRoot();
    try {
      const slug = 'tc17-ec33-cross';
      const rootFormPrdPath = path.join(root, `${slug}.md`);
      const queueFormPrdPath = path.join(root, 'queue', slug, 'spec.md');

      assert('TC17-unit: prdPathsMatch(ROOT-form, QUEUE-form) is true',
        prdPathsMatch(rootFormPrdPath, queueFormPrdPath) === true);
      assert('TC17-unit-rev: prdPathsMatch(QUEUE-form, ROOT-form) is true (reverse argument order)',
        prdPathsMatch(queueFormPrdPath, rootFormPrdPath) === true);

      const { harnessDir: dir } = bootstrap(root, { runId: 'run-tc17-candidate', prdPath: rootFormPrdPath });
      setStateMtime(dir, BASE_MS);
      makeArchiveState(root, '070-tc17-ec33-cross', queueFormPrdPath, NEWER_MS);

      const base = path.basename(dir);
      const { output, threw, err } = await runReap(root, { force: true });
      assert('TC17: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC17a: ROOT-form candidate original path is gone', !fs.existsSync(dir));
      assert('TC17b: quarantined dir exists at .harness/stale/<name>',
        fs.existsSync(path.join(staleDir(root), base)));
      assert('TC17c: output logs the quarantine line',
        output.includes(`Quarantined superseded run dir ${base} → .harness/stale/`));
    } finally {
      cleanup(root);
    }
  }

  // ── TC18 / AC-2 C1 (reverse): QUEUE-form candidate vs newer ROOT-form ───
  console.log('\nTC18: reverse pairing — QUEUE-form candidate vs strictly-newer ROOT-form archive of the same anchor+slug → quarantined via the wrapper\n');
  {
    const root = makeTmpRoot();
    try {
      const slug = 'tc18-ec33-cross-rev';
      const queueFormPrdPath = path.join(root, 'queue', slug, 'spec.md');
      const rootFormPrdPath = path.join(root, `${slug}.md`);

      assert('TC18-unit: prdPathsMatch(QUEUE-form, ROOT-form) is true',
        prdPathsMatch(queueFormPrdPath, rootFormPrdPath) === true);
      assert('TC18-unit-rev: prdPathsMatch(ROOT-form, QUEUE-form) is true (reverse argument order)',
        prdPathsMatch(rootFormPrdPath, queueFormPrdPath) === true);

      const { harnessDir: dir } = bootstrap(root, { runId: 'run-tc18-candidate', prdPath: queueFormPrdPath });
      setStateMtime(dir, BASE_MS);
      makeArchiveState(root, '071-tc18-ec33-cross-rev', rootFormPrdPath, NEWER_MS);

      const base = path.basename(dir);
      const { output, threw, err } = await runReap(root, { force: true });
      assert('TC18: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC18a: QUEUE-form candidate original path is gone', !fs.existsSync(dir));
      assert('TC18b: quarantined dir exists at .harness/stale/<name>',
        fs.existsSync(path.join(staleDir(root), base)));
      assert('TC18c: output logs the quarantine line',
        output.includes(`Quarantined superseded run dir ${base} → .harness/stale/`));
    } finally {
      cleanup(root);
    }
  }

  // ── TC19 / AC-2 C2: task-command NON-COLLAPSE ───────────────────────────
  console.log('\nTC19: two distinct <runDir>/tmp-spec-archived.md prdPaths never collapse — archive matching dirA quarantines dirA only, dirB kept\n');
  {
    const root = makeTmpRoot();
    try {
      const { harnessDir: dirA } = bootstrap(root, { runId: 'run-tc19-a' });
      const prdPathA = path.join(dirA, 'tmp-spec-archived.md');
      const stateA = readState(dirA);
      stateA.projectMeta = { ...(stateA.projectMeta || {}), prdPath: prdPathA };
      writeState(dirA, stateA);
      setStateMtime(dirA, BASE_MS);

      const { harnessDir: dirB } = bootstrap(root, { runId: 'run-tc19-b' });
      const prdPathB = path.join(dirB, 'tmp-spec-archived.md');
      const stateB = readState(dirB);
      stateB.projectMeta = { ...(stateB.projectMeta || {}), prdPath: prdPathB };
      writeState(dirB, stateB);
      setStateMtime(dirB, BASE_MS);

      // Archive matches dirA's EXACT nested prdPath (newer mtime). Same
      // basename as dirB's own nested prdPath, but a different string — no
      // canonicalization tolerance applies to this shape.
      makeArchiveState(root, '080-tc19-nc', prdPathA, NEWER_MS);

      const baseA = path.basename(dirA);
      const baseB = path.basename(dirB);
      const { output, threw, err } = await runReap(root, { force: true });
      assert('TC19: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC19a: dirA original path is gone (quarantined)', !fs.existsSync(dirA));
      assert('TC19b: dirA quarantined dir exists at .harness/stale/<name>',
        fs.existsSync(path.join(staleDir(root), baseA)));
      assert('TC19c: output logs the quarantine line for dirA',
        output.includes(`Quarantined superseded run dir ${baseA} → .harness/stale/`));
      assert('TC19d: dirB still exists at its original path (kept, not collapsed)', fs.existsSync(dirB));
      assert('TC19e: output logs "Keeping terminal/active run dir:" naming dirB',
        output.includes(`[clean] Keeping terminal/active run dir: ${baseB}`));
      assert('TC19f: dirB is NOT under .harness/stale/',
        !fs.existsSync(path.join(staleDir(root), baseB)));
    } finally {
      cleanup(root);
    }
  }

  // ── TC20 / AC-2 C3: nested-dir NON-MATCH ────────────────────────────────
  console.log('\nTC20: nested <root>/specs/<slug>.md prdPath does not canonically match a same-basename queue/root-form archive → kept\n');
  {
    const root = makeTmpRoot();
    try {
      const slug = 'tc20-nested-foo';
      const { harnessDir: dir } = bootstrap(root, { runId: 'run-tc20-nested' });
      const nestedPrdPath = path.join(root, 'specs', `${slug}.md`);
      const state = readState(dir);
      state.projectMeta = { ...(state.projectMeta || {}), prdPath: nestedPrdPath };
      writeState(dir, state);
      setStateMtime(dir, BASE_MS);

      // Same-basename decoys in BOTH tolerant forms — neither may match a
      // nested (non-root, non-queue) prdPath.
      const queueFormDecoy = path.join(root, 'queue', slug, 'spec.md');
      makeArchiveState(root, '090-tc20-queue-decoy', queueFormDecoy, NEWER_MS);
      const rootFormDecoy = path.join(root, `${slug}.md`);
      makeArchiveState(root, '091-tc20-root-decoy', rootFormDecoy, NEWER_MS);

      const base = path.basename(dir);
      const { output, threw, err } = await runReap(root, { force: true });
      assert('TC20: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC20a: run dir still exists at its original path', fs.existsSync(dir));
      assert('TC20b: output logs "Keeping terminal/active run dir:" naming it',
        output.includes(`[clean] Keeping terminal/active run dir: ${base}`));
      assert('TC20c: run dir is NOT under .harness/stale/',
        !fs.existsSync(path.join(staleDir(root), base)));
    } finally {
      cleanup(root);
    }
  }

  // ── TC21 / AC-2 C4: parked-runId SHIELD via the wrapper ─────────────────
  console.log('\nTC21: parked-runId shields a matching run dir through the wrapper (corrupt state.json); a same-shape unshielded dir is still reaped\n');
  {
    const root = makeTmpRoot();
    try {
      const parkedRunId = 'run-tc21-parked-shield';
      const shieldedDir = path.join(harnessRoot(root), parkedRunId);
      fs.mkdirSync(shieldedDir, { recursive: true });
      // Corrupt state.json — otherwise mechanically-safe on its own; the
      // parked-runId shield must win, applied before that disposition.
      fs.writeFileSync(path.join(shieldedDir, 'state.json'), '{ not valid json');
      plantParkedQueueEntry(root, 'tc21-slug', parkedRunId);

      // Negative control: same shape, no matching park.json anywhere.
      const unshieldedDir = path.join(harnessRoot(root), 'run-tc21-unshielded');
      fs.mkdirSync(unshieldedDir, { recursive: true });
      fs.writeFileSync(path.join(unshieldedDir, 'state.json'), '{ not valid json');

      const baseUnshielded = path.basename(unshieldedDir);
      const { output, threw, err } = await runReap(root, { force: true });
      assert('TC21: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC21a: parked-runId-shielded dir survives the wrapper', fs.existsSync(shieldedDir));
      assert('TC21b: shielded dir is NOT under .harness/stale/',
        !fs.existsSync(path.join(staleDir(root), parkedRunId)));
      assert('TC21c: unshielded same-shape dir was reaped', !fs.existsSync(unshieldedDir));
      assert('TC21d: output logs "[clean] Reaped orphan run dir" naming the unshielded dir',
        output.includes(`[clean] Reaped orphan run dir ${baseUnshielded}.`));
    } finally {
      cleanup(root);
    }
  }

  // ── TC22 / AC-2 C5: marker-dir CLI behavior ─────────────────────────────
  console.log('\nTC22: a dry-run.marker orphan dir is listed (includeMarkerDirs:true) and DELETED via the wrapper, reaped-log line naming it\n');
  {
    const root = makeTmpRoot();
    try {
      const { harnessDir: dir } = bootstrap(root, { runId: 'run-tc22-marker' });
      plantDryRunMarker(dir);

      const cliClassified = classifyOrphanRunDirs(root, { includeMarkerDirs: true });
      assert('TC22-listed: marker dir is classified mechanicallySafe under includeMarkerDirs:true',
        cliClassified.mechanicallySafe.map((d) => path.resolve(d)).includes(path.resolve(dir)));

      const base = path.basename(dir);
      const { output, threw, err } = await runReap(root, { force: true });
      assert('TC22: reapOrphanRunDirs did not throw', !threw);
      if (threw) console.log(`       error: ${err && err.stack}`);
      assert('TC22a: dry-run.marker dir was deleted via the wrapper', !fs.existsSync(dir));
      assert('TC22b: output logs "[clean] Reaped orphan run dir" naming the marker dir',
        output.includes(`[clean] Reaped orphan run dir ${base}.`));
    } finally {
      cleanup(root);
    }
  }
}

async function main() {
  console.log('=== Clean --runs orphan run-dir reaper Tests ===\n');

  const root = makeTmpRoot();
  try {
    // (a) non-pointer, terminal/complete state.json, no marker → keep.
    const { harnessDir: dirA } = bootstrap(root, { runId: 'run-a-complete' });
    markComplete(dirA);

    // (b) active-run pointer target, terminal state.json → untouched.
    const { harnessDir: dirB } = bootstrap(root, { runId: 'run-b-pointer' });
    markComplete(dirB);
    const claimed = claimActiveRun(root, {
      runId: 'run-b-pointer',
      slug: 'pointer-target',
      kind: 'test',
    });

    // (c) non-pointer, active/in-progress state.json, no marker → keep.
    const { harnessDir: dirC } = bootstrap(root, { runId: 'run-c-active' });
    markInProgress(dirC);

    // (d) non-pointer, parseable state.json + dry-run.marker → reap.
    const { harnessDir: dirD } = bootstrap(root, { runId: 'run-d-marker' });
    plantDryRunMarker(dirD);

    // (e) non-pointer, no parseable state.json (corrupted) → reap.
    const { harnessDir: dirE } = bootstrap(root, { runId: 'run-e-stateless' });
    fs.writeFileSync(path.join(dirE, 'state.json'), '{ not valid json ');

    // (f) extra non-'run-*' entry directly under .harness/, beyond
    // SHARED_SUBDIRS (which bootstrap already created via ensureSharedSkeleton).
    const root_ = harnessRoot(root);
    const extraNonRunDir = path.join(root_, 'not-a-run-dir');
    fs.mkdirSync(extraNonRunDir, { recursive: true });

    // Sanity on the fixture itself before reaping.
    assert('fixture: active-run pointer claimed', claimed === true);
    assert('fixture: dirA exists pre-reap', fs.existsSync(dirA));
    assert('fixture: dirB exists pre-reap', fs.existsSync(dirB));
    assert('fixture: dirC exists pre-reap', fs.existsSync(dirC));
    assert('fixture: dirD exists pre-reap', fs.existsSync(dirD));
    assert('fixture: dirE exists pre-reap', fs.existsSync(dirE));

    const { output, threw, err } = await runReap(root, { force: true });
    assert('reapOrphanRunDirs did not throw', !threw);
    if (threw) console.log(`       error: ${err && err.stack}`);

    const baseA = path.basename(dirA);
    const baseB = path.basename(dirB);
    const baseC = path.basename(dirC);
    const baseD = path.basename(dirD);
    const baseE = path.basename(dirE);

    // ── TC1 / case (a) ──────────────────────────────────────────────────
    console.log('\nTC1: non-pointer terminal/complete run dir preserved + logged\n');
    assert('TC1a: dirA still exists on disk', fs.existsSync(dirA));
    assert(
      'TC1b: output has "[clean] Keeping terminal/active run dir:" naming dirA',
      output.includes(`[clean] Keeping terminal/active run dir: ${baseA}`)
    );

    // ── TC2 / case (b) ──────────────────────────────────────────────────
    console.log('\nTC2: active-run pointer target dir untouched, never deleted\n');
    assert('TC2a: dirB (pointer target) still exists on disk', fs.existsSync(dirB));
    assert(
      'TC2b: output does NOT report dirB as reaped',
      !output.includes(`[clean] Reaped orphan run dir ${baseB}.`)
    );

    // ── TC3 / case (c) ──────────────────────────────────────────────────
    console.log('\nTC3: non-pointer active/in-progress run dir preserved + logged\n');
    assert('TC3a: dirC still exists on disk', fs.existsSync(dirC));
    assert(
      'TC3b: output has "[clean] Keeping terminal/active run dir:" naming dirC',
      output.includes(`[clean] Keeping terminal/active run dir: ${baseC}`)
    );

    // ── TC4 / case (d) ──────────────────────────────────────────────────
    console.log('\nTC4: non-pointer run dir w/ state.json + dry-run.marker reaped\n');
    assert('TC4a: dirD was removed from disk', !fs.existsSync(dirD));
    assert(
      'TC4b: output has "[clean] Reaped orphan run dir" naming dirD',
      output.includes(`[clean] Reaped orphan run dir ${baseD}.`)
    );

    // ── TC5 / case (e) ──────────────────────────────────────────────────
    console.log('\nTC5: non-pointer run dir w/ no parseable state.json reaped\n');
    assert('TC5a: dirE was removed from disk', !fs.existsSync(dirE));
    assert(
      'TC5b: output has "[clean] Reaped orphan run dir" naming dirE',
      output.includes(`[clean] Reaped orphan run dir ${baseE}.`)
    );

    // ── TC6 / case (f) ──────────────────────────────────────────────────
    console.log('\nTC6: SHARED_SUBDIRS + non-run-* entries untouched\n');
    for (const sub of SHARED_SUBDIRS) {
      const subPath = path.join(root_, sub);
      assert(`TC6: SHARED_SUBDIRS entry '${sub}' still exists`, fs.existsSync(subPath));
    }
    assert('TC6: extra non-run-* dir still exists', fs.existsSync(extraNonRunDir));

    // ── TC7 / case (g) ──────────────────────────────────────────────────
    console.log('\nTC7: active-run pointer file survives the --runs pass\n');
    assert('TC7: activeRunPointerPath(root) exists', fs.existsSync(activeRunPointerPath(root)));

    // Sanity: runHarnessDir(root, 'run-b-pointer') resolves to dirB, matching
    // the claimed pointer target used for TC2.
    assert(
      'fixture sanity: runHarnessDir matches dirB',
      path.resolve(runHarnessDir(root, 'run-b-pointer')) === path.resolve(dirB)
    );
  } finally {
    cleanup(root);
  }

  await runSupersededClassifierTests();
  await runCliPathCanonicalIdentityTests();

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
