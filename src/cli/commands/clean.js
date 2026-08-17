/**
 * clean.js — Remove .harness/ from a project.
 *
 * Offers an optional archive-first flow when active milestones are detected.
 * Supports --force to skip all confirmation prompts.
 */
import fs from 'fs';
import path from 'path';
import { askYesNo } from '../prompt.js';
import { archive } from './archive.js';
import { listSnapshotRefs, cleanupParkSnapshot } from '../../orchestrator/core/park-snapshot.js';
import {
  harnessRoot,
  runHarnessDir,
  readActiveRunPointer,
  clearActiveRunPointer,
} from '../../orchestrator/core/run-context.js';
import { classifyOrphanRunDirs } from '../../orchestrator/core/harness-reaper.js';

/**
 * Reap ORPHAN interrupt refs — drop a refs/interrupt/<slug> ONLY when its
 * queue/<slug>/ directory is ABSENT.
 *
 * Why this exists: an interrupted batch entry's WIP is snapshotted to
 * refs/interrupt/<slug> (see pipeline.js _snapshotInterruptedEntry). When that
 * entry later reruns and is dequeued, removeQueueEntry drops the queue entry but
 * NOT the ref → a permanent orphan ref. `cc-orch clean` reaps those leaks here.
 *
 * SCOPE — this reaper enumerates the refs/interrupt/ namespace ONLY. Gate-halt
 * park refs (refs/park/*) are structurally out of scope: they are never
 * enumerated here, so they can never be dropped by clean. A gate-halt park ref
 * is LIVE, human-recoverable WIP backed by a park.json scene that
 * `park resolve --requeue` reattaches — and it may belong to a DIFFERENT git
 * worktree sharing the same object store. Enumerating refs/park/* here (as a
 * previous version did) risked destroying such a live park ref (cross-worktree
 * data loss). Keeping the two namespaces disjoint kills that bug at the root.
 *
 * The queue-dir cross-check is still the load-bearing guard for interrupt refs:
 * queue/<slug>/ present → LIVE (pending rerun) → PRESERVE; absent → orphan → drop.
 *
 * @param {string} projectRoot - Absolute path to the project root
 */
function reapOrphanInterruptRefs(projectRoot) {
  const refs = listSnapshotRefs(projectRoot, 'refs/interrupt/');
  for (const ref of refs) {
    const slug = ref.slice('refs/interrupt/'.length);
    if (!slug) continue;
    const queueDir = path.join(projectRoot, 'queue', slug);
    if (fs.existsSync(queueDir)) {
      // LIVE entry (pending rerun) — its ref is recoverable WIP. PRESERVE.
      continue;
    }
    // Orphan: the queue entry is gone (a recovered + dequeued interrupt) but the
    // ref leaked. Drop it so its object becomes gc-able.
    try {
      cleanupParkSnapshot(slug, projectRoot, 'refs/interrupt/');
      console.log(`[clean] Reaped orphan interrupt ref ${ref} (no queue entry).`);
    } catch {
      // Best-effort — a ref that vanished mid-loop (or a transient git error) is fine.
    }
  }
}

/**
 * Reap orphan interrupt refs, then remove the .harness/ directory and log it.
 * Shared by all clean exit paths so the reap + rmSync + log stay identical.
 *
 * @param {string} projectRoot - Absolute path to the project root
 */
function removeHarness(projectRoot) {
  reapOrphanInterruptRefs(projectRoot);
  const harnessDir = path.join(projectRoot, '.harness');
  fs.rmSync(harnessDir, { recursive: true, force: true });
  console.log('Removed .harness/');
}

/**
 * Count the total number of files and directories inside a directory (non-recursive top-level).
 *
 * @param {string} dir - Absolute path to the directory
 * @returns {number} count of entries
 */
function countEntries(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/**
 * Read state.json and return active milestones (status !== 'complete' and !== 'archived').
 *
 * @param {string} harnessDir - Absolute path to the .harness directory
 * @returns {{ hasActive: boolean, activeCount: number }}
 */
function detectActiveMilestones(harnessDir) {
  try {
    const statePath = path.join(harnessDir, 'state.json');
    const raw = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(raw);
    const milestones = Object.values(state.milestones ?? {});
    const active = milestones.filter(
      (m) => m.status !== 'complete' && m.status !== 'archived'
    );
    return { hasActive: active.length > 0, activeCount: active.length };
  } catch {
    // state.json missing or unreadable — treat as no active milestones
    return { hasActive: false, activeCount: 0 };
  }
}

/**
 * Reap orphan run-scoped harness directories (`.harness/run-*`).
 *
 * Interactive wrapper over harness-reaper.js's classifyOrphanRunDirs, which
 * owns ALL the decision logic (active-run exemption, parked-runId shield,
 * mechanically-safe/superseded/kept classification, park/interrupt live-ref
 * shielding). Called here with { includeMarkerDirs: true } — CLI mode
 * INCLUDES dry-run.marker dirs as rm candidates (unlike the non-interactive
 * sweepOrphanRunDirs, which excludes them entirely).
 *
 * This function only:
 *   1. Logs a 'Keeping terminal/active run dir' line for each kept dir.
 *   2. Early-returns with 'No orphan run dirs to reap.' when both the rm and
 *      quarantine lists are empty.
 *   3. Prompts once via askYesNo (or honors flags.force) with a SINGLE
 *      combined confirmation covering both counts.
 *   4. Runs its OWN disposition loop: fs.rmSync for mechanicallySafe dirs,
 *      and fs.mkdirSync + fs.renameSync into .harness/stale/ for superseded
 *      dirs.
 *
 * .harness/stale/ is never auto-emptied, and learning/dry-run/brainstorm/
 * stale directories are never candidates (excluded by classifyOrphanRunDirs).
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {object} [flags={}] - CLI flags; flags.force skips the confirmation prompt
 * @returns {Promise<void>}
 */
export async function reapOrphanRunDirs(projectRoot, flags = {}) {
  const root = harnessRoot(projectRoot);

  const classified = classifyOrphanRunDirs(projectRoot, { includeMarkerDirs: true });
  const toDelete = classified.mechanicallySafe;
  const toQuarantine = classified.superseded;
  const toKeep = classified.kept;

  for (const dir of toKeep) {
    let label = '(state unreadable — keeping as a precaution)';
    try {
      const statePath = path.join(dir, 'state.json');
      const raw = fs.readFileSync(statePath, 'utf8');
      const state = JSON.parse(raw);
      const globalStatus = state.globalStatus;
      if (globalStatus === 'complete' || globalStatus === 'rejected') {
        label = '(terminal, never archived)';
      } else if (globalStatus === 'active') {
        label = '(active — preserved as in-progress work)';
      } else {
        label = '(state unreadable — keeping as a precaution)';
      }
    } catch {
      // state.json missing or corrupt — fall back to the generic label above.
      label = '(state unreadable — keeping as a precaution)';
    }
    console.log(`[clean] Keeping terminal/active run dir: ${path.basename(dir)} ${label}`);
  }

  if (toDelete.length === 0 && toQuarantine.length === 0) {
    console.log('[clean] No orphan run dirs to reap.');
    return;
  }

  if (!flags.force) {
    const confirm = await askYesNo(
      `Reap ${toDelete.length} orphan run dir(s) and quarantine ${toQuarantine.length} superseded run dir(s)? (y/n) `
    );
    if (!confirm) {
      console.log('Aborted.');
      return;
    }
  } else {
    console.log('[clean] --force: skipping confirmation, reaping orphan run dirs');
  }

  for (const dir of toDelete) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[clean] Reaped orphan run dir ${path.basename(dir)}.`);
  }

  for (const dir of toQuarantine) {
    const staleDir = path.join(root, 'stale');
    fs.mkdirSync(staleDir, { recursive: true });
    const dirName = path.basename(dir);
    fs.renameSync(dir, path.join(staleDir, dirName));
    console.log(`Quarantined superseded run dir ${dirName} → .harness/stale/`);
  }
}

/**
 * Reap an ORPHANED active-run pointer (`.harness/active-run`).
 *
 * Orphanhood is decided ONLY from the filesystem fact that the pointer's
 * runId has no corresponding run directory on disk
 * (runHarnessDir(projectRoot, runId) does not exist) — there is no
 * inspection of state.json/globalStatus or any other state-shape inference
 * about whether the run is alive.
 *
 * A pointer whose run directory exists is left untouched. A missing or
 * unparseable pointer (readActiveRunPointer returns null) is a no-op. Any
 * failure while reading or clearing the pointer is caught, emits a
 * console.warn, and does not propagate.
 *
 * @param {string} projectRoot - Absolute path to the project root
 */
function reapOrphanActiveRunPointer(projectRoot) {
  try {
    const pointer = readActiveRunPointer(projectRoot);
    if (!pointer || !pointer.runId) {
      return;
    }
    const dir = runHarnessDir(projectRoot, pointer.runId);
    if (fs.existsSync(dir)) {
      // Run dir still present on disk — pointer is not orphaned. PRESERVE.
      return;
    }
    clearActiveRunPointer(projectRoot);
    console.log(`[clean] Removed orphaned active-run pointer for ${pointer.runId}.`);
  } catch (err) {
    console.warn(`[clean] Failed to reap orphaned active-run pointer: ${err.message}`);
  }
}

/**
 * Remove .harness/ from the given project root.
 *
 * Flow:
 *   1. Check if .harness/ exists; exit early with 'Nothing to clean.' if not.
 *   2. Count files/dirs in .harness/ for display.
 *   3. Read state.json to detect active milestones.
 *   4. If active milestones found, offer archive-first flow.
 *   5. If no active milestones, prompt for simple removal.
 *   6. Delete .harness/ with fs.rmSync.
 *   --force flag skips all confirmation prompts.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {object} [flags={}] - CLI flags; flags.force skips all prompts
 * @param {object} [deps={}] - Optional dependency overrides, forwarded to archive() as a
 *   dependency-injection seam (e.g. deps.summarize to suppress a real Summarizer in tests)
 */
export async function clean(projectRoot, flags = {}, deps = {}) {
  if (flags.runs) {
    await reapOrphanRunDirs(projectRoot, flags);
    reapOrphanActiveRunPointer(projectRoot);
    return;
  }

  const harnessDir = path.join(projectRoot, '.harness');

  // Step 1: Check existence. Even with no .harness/ there may be leaked
  // interrupt refs to reap — queue/ lives at the project root and survives
  // harness removal, so the queue-present liveness guard still applies here.
  // Without this pass, a project whose harness is gone could never reap an
  // orphan ref again (permanent leak).
  if (!fs.existsSync(harnessDir)) {
    reapOrphanInterruptRefs(projectRoot);
    console.log('Nothing to clean.');
    return;
  }

  // Step 2: Count entries for display
  const entryCount = countEntries(harnessDir);
  console.log(`Found .harness/ with ${entryCount} item(s).`);

  // Step 3: Detect active milestones
  const { hasActive, activeCount } = detectActiveMilestones(harnessDir);

  if (hasActive) {
    // Step 4: Active milestones — offer archive-first flow
    console.log(`Warning: ${activeCount} active milestone(s) found with unarchived state.`);

    if (flags.force) {
      // --force: skip all prompts, delete immediately
      console.log('[clean] --force: skipping confirmation, removing .harness/');
      removeHarness(projectRoot);
      return;
    }

    const archiveFirst = await askYesNo('Archive first? (y/n) ');
    if (archiveFirst) {
      // clean is housekeeping (archive-then-remove), not a release gate — it
      // must not run, or be blocked by, the full test:all suite.
      await archive(projectRoot, null, { ...flags, 'skip-test-gate': true }, deps);
      // After archive, .harness/ is reinitialized — remove it now (rmSync with
      // force is a no-op if it happens to be absent).
      removeHarness(projectRoot);
      return;
    }

    // User said no to archive — confirm deletion with warning
    const confirmDelete = await askYesNo(
      'WARNING: Unarchived state will be lost. Really remove .harness/? (y/n) '
    );
    if (!confirmDelete) {
      console.log('Aborted.');
      return;
    }
  } else {
    // Step 5: No active milestones — simple removal prompt
    if (flags.force) {
      console.log('[clean] --force: skipping confirmation, removing .harness/');
      removeHarness(projectRoot);
      return;
    }

    const confirm = await askYesNo('Remove .harness/? (y/n) ');
    if (!confirm) {
      console.log('Aborted.');
      return;
    }
  }

  // Step 6: Delete
  removeHarness(projectRoot);
}
