/**
 * harness-reaper.js — Orphan `.harness/run-*` directory classification +
 * disposal, extracted from `src/cli/commands/clean.js` (hole-21).
 *
 * This module owns the DECISION LOGIC (classifyOrphanRunDirs — never
 * disposes anything, never throws) and the ACTUAL DISPOSAL (sweepOrphanRunDirs
 * — deletes/quarantines, never prompts, never throws). `cc-orch clean --runs`
 * remains the interactive/CLI-flag-driven entry point in clean.js; it is
 * expected to call classifyOrphanRunDirs directly when it needs a prompt
 * (counts before confirming), and this module's sweepOrphanRunDirs when it
 * wants a non-interactive sweep (e.g. an auto-mode housekeeping pass).
 *
 * Classification model — three disjoint dispositions per run-* dir:
 *   - mechanicallySafe: no parseable state.json (missing/corrupt), OR (only
 *     when includeMarkerDirs is true) a dry-run.marker file is present.
 *   - superseded: a parseable state.json, no dry-run.marker, a non-empty
 *     projectMeta.prdPath that canonically matches (see prdPathsMatch) an
 *     archives/*\/state.json entry whose mtime is strictly NEWER than this run
 *     dir's own state.json mtime, and not shielded by a live park/interrupt
 *     ref for its raw queue slug.
 *   - kept: everything else — terminal/active runs, and superseded-but-shielded
 *     runs (shielded by a live refs/park/<slug> or refs/interrupt/<slug> ref,
 *     OR by a parked-runId match — see collectParkedRunIds).
 *
 * Exemptions applied BEFORE any of the above (in order):
 *   1. The active-run pointer's target directory (resolveActiveHarnessDir) is
 *      excluded entirely — never a candidate, never appears in any list.
 *   2. The parked-runId shield: a run dir whose basename (== runId) is
 *      recorded as the `runId` of a LIVE parked/halted queue entry's
 *      park.json is force-kept — applied before ANY disposition, including
 *      the mechanically-safe deletion path (a run dir with a corrupt/missing
 *      state.json is otherwise mechanically-safe, but a live parked WIP run
 *      must never be reaped just because its state.json happens to be
 *      unreadable).
 *   3. dry-run.marker governance: when includeMarkerDirs is false (the mode
 *      sweepOrphanRunDirs always uses), a dry-run.marker dir is EXCLUDED from
 *      all three lists entirely (not classified at all). When true, it is
 *      classified mechanicallySafe.
 */
import fs from 'fs';
import path from 'path';
import { listSnapshotRefs } from './park-snapshot.js';
import { harnessRoot, resolveActiveHarnessDir } from './run-context.js';
import { SHARED_SUBDIRS } from './bootstrap.js';
import { readParkScene, LIVE_PARK_STATUSES } from './state.js';

/**
 * Build a Map from a completed/failed archive's projectMeta.prdPath to the
 * NEWEST mtime (in ms) of the state.json that recorded it, by enumerating
 * archives/*\/state.json ONCE per invocation (including failed-<NNN>-* dirs).
 *
 * Fail-soft by construction: a missing archives/ directory yields an empty
 * map; an archive entry whose state.json is missing, unreadable, unparseable,
 * or whose projectMeta.prdPath is empty/non-string is skipped — this function
 * never throws.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @returns {Map<string, number>} prdPath -> newest state.json mtime (ms)
 */
export function buildArchivePrdPathMap(projectRoot) {
  const map = new Map();
  const archivesDir = path.join(projectRoot, 'archives');

  let entries;
  try {
    entries = fs.readdirSync(archivesDir, { withFileTypes: true });
  } catch {
    return map;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(archivesDir, entry.name, 'state.json');

    let parsed;
    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const prdPath = parsed?.projectMeta?.prdPath;
    if (typeof prdPath !== 'string' || prdPath.length === 0) continue;

    let mtimeMs;
    try {
      mtimeMs = fs.statSync(statePath).mtimeMs;
    } catch {
      continue;
    }

    const existing = map.get(prdPath);
    if (existing === undefined || mtimeMs > existing) {
      map.set(prdPath, mtimeMs);
    }
  }

  return map;
}

/**
 * Derive the RAW queue slug from a prdPath that ends in
 * `queue/<raw-slug>/spec.md` (path-separator agnostic). Returns null when
 * prdPath does not point at a queue/<slug>/spec.md location (i.e. a
 * non-batch run).
 *
 * @param {string} prdPath
 * @returns {string|null}
 */
export function extractRawQueueSlug(prdPath) {
  if (typeof prdPath !== 'string' || prdPath.length === 0) return null;
  const normalized = prdPath.split(path.sep).join('/');
  const match = normalized.match(/\/queue\/([^/]+)\/spec\.md$/);
  return match ? match[1] : null;
}

/**
 * Park/interrupt shield for a SUPERSEDED candidate.
 *
 * CHANGE (1): a raw queue slug of null (non-batch prdPath) is no longer
 * vacuously shielded — it now correctly falls through to `false` (nothing
 * batch-specific to protect, so the SUPERSEDED verdict stands).
 *
 * Otherwise, the candidate is shielded (kept) when a LIVE refs/park/<raw-slug>
 * or refs/interrupt/<raw-slug> ref exists.
 *
 * @param {string} projectRoot
 * @param {string|null} rawSlug
 * @returns {boolean} true when the candidate must be KEPT (not quarantined)
 */
export function isShieldedByLiveRef(projectRoot, rawSlug) {
  if (!rawSlug) return false; // CHANGE (1): was `return true` in clean.js.
  const parkRefs = listSnapshotRefs(projectRoot, 'refs/park/');
  if (parkRefs.includes(`refs/park/${rawSlug}`)) return true;
  const interruptRefs = listSnapshotRefs(projectRoot, 'refs/interrupt/');
  if (interruptRefs.includes(`refs/interrupt/${rawSlug}`)) return true;
  return false;
}

/**
 * Determine whether two prdPath string values denote the SAME canonical PRD
 * file identity. This replaces exact-key lookups (archiveMap.has(prdPath))
 * with a tolerant-but-anchored comparison so archived/reused specs recorded
 * with cosmetic differences (path-separator style, or a trailing extension
 * dropped by a normalizer somewhere upstream) still resolve to the same
 * identity — WITHOUT loosening comparisons for shapes where that would be
 * unsafe (nested run-scoped tmp files, out-of-project paths, non-.md values).
 *
 * Two forms get tolerant treatment, checked in this order:
 *   1. Queue-form: `<root>/queue/<slug>/spec.md` — separator-agnostic; when
 *      BOTH prdPathA and prdPathB match this shape, identity is the
 *      (root, slug) pair (i.e. everything before `/queue/` plus the slug
 *      segment), so a backslash- vs forward-slash-separated recording of the
 *      identical queue entry still matches.
 *   2. Root-form: `<anchor>/<name>.md` — a bare `.md` file. Canonical
 *      identity is the (anchor dirname, `<name>` minus `.md`) pair. Because
 *      the anchor is the file's OWN dirname, a nested `<root>/specs/foo.md`,
 *      an out-of-project `/elsewhere/foo.md`, and a task run's
 *      `<runDir>/tmp-spec-archived.md` each anchor to different roots and
 *      can never collapse into one another or into a project-root identity.
 *
 * CROSS-FORM MATCHING IS THE POINT: a ROOT-form `<anchor>/<slug>.md` and a
 * QUEUE-form `<anchor>/queue/<slug>/spec.md` reduce to the SAME
 * (anchor, slug) identity and MATCH — the live ec33 miss this predicate was
 * built to close (the engine records the same spec both ways: direct `run`
 * stamps the ROOT form, a batch entry stamps the QUEUE form). Values with no
 * canonical form on either side (extension-dropped recordings, non-`.md`
 * strings) fall back to an exact string comparison after a no-op-safe
 * trailing-`.md` strip.
 *
 * @param {string} prdPathA
 * @param {string} prdPathB
 * @returns {boolean}
 */
export function prdPathsMatch(prdPathA, prdPathB) {
  if (typeof prdPathA !== 'string' || typeof prdPathB !== 'string') {
    return prdPathA === prdPathB;
  }

  // Canonical (anchorRoot, slug) identity — separator-agnostic. QUEUE form
  // <anchor>/queue/<slug>/spec.md and ROOT form <anchor>/<slug>.md reduce to
  // the SAME identity when their anchor dirs and slugs are equal — the ec33
  // cross-form case this predicate exists to close (the engine itself
  // records the same spec both ways: a direct `run` stamps the ROOT form,
  // a batch entry stamps the QUEUE form). Nested and out-of-project .md
  // paths anchor to their OWN dirname, so lookalike basenames under
  // different anchors (specs/foo.md, a task run's tmp-spec-archived.md)
  // can never collapse into each other.
  const canonicalIdentity = (p) => {
    const n = p.split(/[\\/]/).join('/');
    const queue = n.match(/^(.*)\/queue\/([^/]+)\/spec\.md$/);
    if (queue) return { root: queue[1], slug: queue[2] };
    if (n.endsWith('.md')) {
      const cut = n.lastIndexOf('/');
      const slug = n.slice(cut + 1, -3);
      if (cut > 0 && slug.length > 0) return { root: n.slice(0, cut), slug };
    }
    return null;
  };
  const canonA = canonicalIdentity(prdPathA);
  const canonB = canonicalIdentity(prdPathB);
  if (canonA && canonB) {
    return canonA.root === canonB.root && canonA.slug === canonB.slug;
  }

  // Mixed/other shapes (an extension-dropped recording, non-.md values):
  // exact string comparison after a no-op-safe trailing-.md strip — the
  // only tolerance the unanchored fallback grants.
  const stripTrailingMd = (s) => (s.endsWith('.md') ? s.slice(0, -3) : s);
  return stripTrailingMd(prdPathA) === stripTrailingMd(prdPathB);
}

/**
 * Collect the set of runIds recorded in every LIVE (parked/halted-review/
 * halted-analyzer) queue entry's park.json `runId` field.
 *
 * A run dir named exactly one of these runIds is a still-recoverable parked
 * WIP run and must be shielded from ANY disposition (see classifyOrphanRunDirs).
 * Fail-soft by construction: a missing queue/ directory yields an empty set;
 * a queue entry whose status file or park.json is missing/unreadable/
 * unparseable, or whose park.json has no non-empty string `runId`, is
 * skipped — this function never throws.
 *
 * @param {string} projectRoot
 * @returns {Set<string>}
 */
export function collectParkedRunIds(projectRoot) {
  const runIds = new Set();
  const queueDir = path.join(projectRoot, 'queue');

  let names;
  try {
    names = fs.readdirSync(queueDir);
  } catch {
    return runIds;
  }

  for (const name of names) {
    try {
      const entryDir = path.join(queueDir, name);
      if (!fs.statSync(entryDir).isDirectory()) continue;

      const status = fs.readFileSync(path.join(entryDir, 'status'), 'utf8').trim();
      if (!LIVE_PARK_STATUSES.includes(status)) continue;

      const scene = readParkScene(projectRoot, name);
      const runId = scene?.runId;
      if (typeof runId === 'string' && runId.length > 0) {
        runIds.add(runId);
      }
    } catch {
      // Per-entry fail-soft: one damaged queue entry must never abort the scan.
      continue;
    }
  }

  return runIds;
}

/**
 * Classify orphan run-scoped harness directories (`.harness/run-*`) WITHOUT
 * disposing of anything. Never throws; per-dir fail-soft (an unexpected
 * error classifying one dir is swallowed and that dir is simply skipped —
 * it appears in none of the three lists).
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {object} [options={}]
 * @param {boolean} [options.includeMarkerDirs=false] - When false (the mode
 *   sweepOrphanRunDirs always uses), a dry-run.marker dir is excluded from
 *   ALL three lists. When true, a dry-run.marker dir is classified
 *   mechanicallySafe (unless shielded by the parked-runId check first).
 * @returns {{ mechanicallySafe: string[], superseded: string[], kept: string[] }}
 *   Absolute run-dir paths, one per list; the classifier disposes of nothing.
 */
export function classifyOrphanRunDirs(projectRoot, options = {}) {
  const { includeMarkerDirs = false } = options;
  const result = { mechanicallySafe: [], superseded: [], kept: [] };

  const root = harnessRoot(projectRoot);

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }

  let activeDir = null;
  try {
    activeDir = resolveActiveHarnessDir(projectRoot);
  } catch {
    activeDir = null;
  }

  // Enumerated/built ONCE per invocation — never re-read per-candidate.
  // Both are fail-soft by construction (see their own doc comments).
  const archiveMap = buildArchivePrdPathMap(projectRoot);
  const parkedRunIds = collectParkedRunIds(projectRoot);

  const runEntries = entries.filter((entry) => {
    if (!entry.name.startsWith('run-')) return false;
    if (entry.name === 'active-run') return false;
    if (entry.name === 'stale') return false;
    if (SHARED_SUBDIRS.includes(entry.name)) return false;
    return true;
  });

  for (const entry of runEntries) {
    try {
      const dir = path.join(root, entry.name);

      if (activeDir && path.resolve(dir) === path.resolve(activeDir)) {
        // Active-run pointer target — never a classification candidate.
        continue;
      }

      // CHANGE (3): the parked-runId shield is applied BEFORE any
      // disposition, including the mechanically-safe rm path — a live
      // parked/halted WIP run must never be reaped merely because its
      // state.json happens to be missing/corrupt (or it carries a stray
      // dry-run.marker).
      if (parkedRunIds.has(entry.name)) {
        result.kept.push(dir);
        continue;
      }

      // CHANGE (4): dry-run.marker exemption. includeMarkerDirs:false
      // (sweepOrphanRunDirs' mode) excludes the dir from ALL THREE lists;
      // includeMarkerDirs:true classifies it mechanicallySafe.
      const hasDryRunMarker = fs.existsSync(path.join(dir, 'dry-run.marker'));
      if (hasDryRunMarker) {
        if (!includeMarkerDirs) continue;
        result.mechanicallySafe.push(dir);
        continue;
      }

      const statePath = path.join(dir, 'state.json');
      let stateParsed = false;
      let parsedState = null;
      try {
        parsedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        stateParsed = true;
      } catch {
        stateParsed = false;
      }

      if (!stateParsed) {
        result.mechanicallySafe.push(dir);
        continue;
      }

      // Parseable state.json, no dry-run marker — check the SUPERSEDED
      // classification (canonical archive prdPath match + strictly newer
      // archive mtime).
      const prdPath = typeof parsedState?.projectMeta?.prdPath === 'string'
        ? parsedState.projectMeta.prdPath
        : '';

      let superseded = false;
      if (prdPath) {
        // CHANGE (2): canonical prdPathsMatch comparison instead of an exact
        // archiveMap.has(prdPath) key lookup — take the NEWEST mtime among
        // ALL archive entries whose prdPath canonically matches this one.
        let matchedMtimeMs;
        for (const [archivedPrdPath, mtimeMs] of archiveMap) {
          if (prdPathsMatch(prdPath, archivedPrdPath)) {
            if (matchedMtimeMs === undefined || mtimeMs > matchedMtimeMs) {
              matchedMtimeMs = mtimeMs;
            }
          }
        }

        if (matchedMtimeMs !== undefined) {
          let ownMtimeMs;
          try {
            ownMtimeMs = fs.statSync(statePath).mtimeMs;
          } catch {
            ownMtimeMs = undefined;
          }
          if (typeof ownMtimeMs === 'number' && matchedMtimeMs > ownMtimeMs) {
            superseded = true;
          }
        }
      }

      if (superseded) {
        const rawSlug = extractRawQueueSlug(prdPath);
        if (isShieldedByLiveRef(projectRoot, rawSlug)) {
          result.kept.push(dir);
        } else {
          result.superseded.push(dir);
        }
      } else {
        result.kept.push(dir);
      }
    } catch {
      // Per-dir fail-soft: an unexpected error classifying this dir must
      // never abort classification of the remaining dirs. Skip it (it
      // appears in none of the three lists) and continue.
      continue;
    }
  }

  return result;
}

/**
 * Non-interactive sweep: classify (with includeMarkerDirs:false, i.e. marker
 * dirs are excluded entirely rather than treated as mechanically-safe — see
 * classifyOrphanRunDirs), then dispose of the result. Never prompts, never
 * throws.
 *
 *   - mechanicallySafe dirs are removed with fs.rmSync({recursive, force}).
 *   - superseded dirs are quarantined via fs.renameSync into
 *     .harness/stale/<dirname> — NEVER fs.rmSync'd.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {object} [options={}]
 * @param {(message: string) => void} [options.log=console.log] - Sink for
 *   per-disposal log lines; defaults to console.log.
 * @returns {void}
 */
export function sweepOrphanRunDirs(projectRoot, options = {}) {
  const { log = console.log } = options;

  let classified;
  try {
    classified = classifyOrphanRunDirs(projectRoot, { includeMarkerDirs: false });
  } catch {
    return;
  }

  const root = harnessRoot(projectRoot);

  for (const dir of classified.mechanicallySafe) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`[harness-reaper] Reaped orphan run dir ${path.basename(dir)}.`);
    } catch {
      // Fail-soft: one dir's disposal error must never abort the sweep.
    }
  }

  for (const dir of classified.superseded) {
    try {
      const staleDir = path.join(root, 'stale');
      fs.mkdirSync(staleDir, { recursive: true });
      const dirName = path.basename(dir);
      fs.renameSync(dir, path.join(staleDir, dirName));
      log(`[harness-reaper] Quarantined superseded run dir ${dirName} \u2192 .harness/stale/`);
    } catch {
      // Fail-soft: one dir's disposal error must never abort the sweep.
    }
  }
}
