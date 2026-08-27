/**
 * read-only-audit.js — Snapshot a project's tracked-file set (and which of
 * those files are currently modified) so a later "restore the tree to what
 * it looked like before a read-only audit" step can detect which files, if
 * any, failed to restore.
 *
 * End-to-end fail-soft contract: every caller-facing entry point in this
 * module is fail-soft. None of the following ever throw:
 *   - projectRoot cannot be resolved (undefined, null, missing path, or any
 *     other realpathSync failure)
 *   - projectRoot resolves but is not inside a git repository (git errors
 *     out on `git ls-files` / `git status --porcelain`)
 *   - the harness-state read that a caller layers on top of a snapshot fails
 *     (e.g. a corrupt or missing state file)
 *   - a later restore step is unable to put a tracked-but-modified file back
 *     the way it was
 * In every one of these cases the failure is reported back to the caller as
 * data (an `{ ok: false, reason }` result, or a flagged/omitted entry in a
 * restore report) — never as a thrown exception. Callers that build on this
 * module's snapshot (e.g. a restore step) are expected to follow the same
 * discipline: collect failures, report them, and keep going.
 *
 * Public API:
 *   captureTrackedSnapshot(projectRoot) -> { ok: true, tracked: Set<string>,
 *     modified: Set<string> } | { ok: false, reason: string }
 *   notify(onLog, message) -> undefined
 *   collectPendingTargetFiles(projectRoot) -> { targetFiles: Set<string>,
 *     error: string | null }
 *   auditTrackedDeletions(projectRoot, snapshot, opts?) -> { deleted: string[],
 *     restored: Array<{ path: string, note: string | null }>,
 *     reportOnly: string[], failed: Array<{ path: string | null, reason: string }> }
 */
import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import { activeHarnessDir } from '../core/run-context.js';

const GIT_OPTS_BASE = { stdio: 'pipe', encoding: 'utf8' };

// Mirrors state-machine.js's private TERMINAL_OK set (not exported there):
// a mission's targetFiles are only excluded from the pending-audit report
// once the mission itself has reached one of these terminal statuses.
const TERMINAL_MISSION_STATUSES = new Set(['complete', 'invalidated']);

/**
 * Snapshot the set of git-tracked repo-relative paths under projectRoot,
 * plus the subset of those paths that git currently reports as modified
 * (uncommitted changes). Intended to be captured before a read-only audit
 * runs, so a later restore can flag any tracked-and-modified file whose
 * content could not be recovered.
 *
 * Fail-soft: never throws, for any input including undefined/null
 * projectRoot. Returns `{ ok: false, reason }` when projectRoot cannot be
 * resolved, is not inside a git repository, or either git invocation fails.
 *
 * @param {string} projectRoot - Absolute (or relative) path to the project
 *   root. Realpath-normalized first, before any git invocation.
 * @returns {{ ok: true, tracked: Set<string>, modified: Set<string> } |
 *   { ok: false, reason: string }}
 */
export function captureTrackedSnapshot(projectRoot) {
  let realProjectRoot;
  try {
    realProjectRoot = fs.realpathSync(projectRoot);
  } catch {
    return { ok: false, reason: 'unresolvable projectRoot' };
  }

  const gitOpts = { ...GIT_OPTS_BASE, cwd: realProjectRoot };

  let lsFilesOut;
  let statusOut;
  try {
    lsFilesOut = execSync('git ls-files', gitOpts);
    statusOut = execSync('git status --porcelain', gitOpts);
  } catch {
    return { ok: false, reason: 'not a git repository or git invocation failed' };
  }

  const tracked = new Set(
    lsFilesOut.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  );

  const modified = new Set();
  const statusLines = statusOut.split('\n').filter((l) => l.length > 0);
  for (const line of statusLines) {
    // Porcelain v1: `XY <path>` (rename entries carry `<old> -> <new>`; the
    // current on-disk path is the `-> ` side).
    let relPath = line.slice(3);
    const arrowIdx = relPath.indexOf(' -> ');
    if (arrowIdx !== -1) relPath = relPath.slice(arrowIdx + 4);
    if (tracked.has(relPath)) modified.add(relPath);
  }

  return { ok: true, tracked, modified };
}

/**
 * Invoke a caller-supplied log callback with a message, swallowing any
 * exception the callback itself throws.
 *
 * Fail-soft by design: `onLog` may be undefined, null, a plain object
 * lacking a callable shape (e.g. a test mock missing `.warn`), or a function
 * that throws when called. None of these ever propagate out of `notify` —
 * it always returns undefined.
 *
 * @param {*} onLog - expected to be a function accepting a single string;
 *   any other value is silently ignored.
 * @param {string} message - the message to pass to onLog.
 * @returns {undefined}
 */
export function notify(onLog, message) {
  if (typeof onLog !== 'function') return undefined;
  try {
    onLog(message);
  } catch {
    // Swallow: a throwing callback must never propagate out of notify.
  }
  return undefined;
}

/**
 * Collect the set of targetFiles paths declared by every mission that has
 * not yet reached a terminal status ('complete' or 'invalidated'), across
 * the currently active harness run.
 *
 * Fail-soft: never throws. Any failure while resolving the harness dir or
 * reading state (missing harness dir, missing state.json, missing mission
 * state file, or unparsable JSON) is reported back as a non-null `error`
 * string alongside whatever targetFiles were successfully collected before
 * the failure (an empty Set when the failure happens before any mission's
 * files could be read).
 *
 * For each non-terminal mission this walks two sources of targetFiles:
 *   1. The mission's own `targetFiles` field in state.json (present only
 *      when the plan declared mission-level targetFiles).
 *   2. Every task's `targetFiles` inside
 *      `<harnessDir>/state/mission-<id>.json`, mirroring the traversal in
 *      state.js's buildFileToMissionMap.
 *
 * @param {string} projectRoot
 * @returns {{ targetFiles: Set<string>, error: string | null }}
 */
export function collectPendingTargetFiles(projectRoot) {
  const targetFiles = new Set();
  const errors = [];

  const harnessDir = activeHarnessDir(projectRoot);

  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
  } catch (err) {
    return { targetFiles, error: `Failed to read harness state.json: ${err.message}` };
  }

  for (const milestone of Object.values(state.milestones || {})) {
    for (const [missionId, mission] of Object.entries(milestone.missions || {})) {
      if (TERMINAL_MISSION_STATUSES.has(mission.status)) continue;

      if (Array.isArray(mission.targetFiles)) {
        for (const filePath of mission.targetFiles) {
          targetFiles.add(filePath);
        }
      }

      const missionStateFile = path.join(harnessDir, 'state', `mission-${missionId}.json`);
      let missionState;
      try {
        missionState = JSON.parse(fs.readFileSync(missionStateFile, 'utf8'));
      } catch (err) {
        errors.push(`Failed to read mission state for ${missionId}: ${err.message}`);
        continue;
      }

      for (const sm of Object.values(missionState.subMissions || {})) {
        for (const task of Object.values(sm.tasks || {})) {
          for (const filePath of task.targetFiles || []) {
            targetFiles.add(filePath);
          }
        }
      }
    }
  }

  return { targetFiles, error: errors.length > 0 ? errors.join('; ') : null };
}

/**
 * Compare a pre-session `captureTrackedSnapshot` result against the tree's
 * current state and restore any tracked file that vanished from disk during
 * the session — UNLESS a still-in-flight (non-terminal) mission's
 * `targetFiles` declares that exact path, in which case the deletion is
 * assumed to be legitimate in-scope work-in-progress and is only reported,
 * never restored.
 *
 * Fail-soft, end-to-end: this never throws, no matter what. A missing or
 * `ok: false` snapshot is treated as "nothing to audit" and short-circuits
 * to the empty report with zero side effects (no callback invocation, no
 * `failed` entry — there is nothing to have failed at). Every other failure
 * mode (the fresh git recompute, the harness-state read
 * `collectPendingTargetFiles` layers on top, and each individual
 * `git checkout --` restore attempt) is caught, appended to the returned
 * `failed` array, and surfaced through `notify(opts.onLog, ...)` — a
 * throwing or non-function `opts.onLog` is itself swallowed by `notify` and
 * can never cause this function to throw.
 *
 * @param {string} projectRoot
 * @param {{ ok: boolean, tracked?: Set<string>, modified?: Set<string> } | undefined | null} snapshot -
 *   the pre-session result of `captureTrackedSnapshot(projectRoot)`.
 * @param {{ onLog?: (message: string) => void }} [opts]
 * @returns {{
 *   deleted: string[],
 *   restored: Array<{ path: string, note: string | null }>,
 *   reportOnly: string[],
 *   failed: Array<{ path: string | null, reason: string }>
 * }}
 */
export function auditTrackedDeletions(projectRoot, snapshot, opts = {}) {
  const report = { deleted: [], restored: [], reportOnly: [], failed: [] };

  if (!snapshot || snapshot.ok === false) return report;

  const onLog = opts && typeof opts === 'object' ? opts.onLog : undefined;

  let realProjectRoot;
  try {
    realProjectRoot = fs.realpathSync(projectRoot);
  } catch (err) {
    const reason = `Failed to resolve projectRoot during deletion audit: ${err.message}`;
    report.failed.push({ path: null, reason });
    notify(onLog, reason);
    return report;
  }

  const freshSnapshot = captureTrackedSnapshot(realProjectRoot);
  if (!freshSnapshot.ok) {
    const reason = `Failed to recompute tracked set during deletion audit: ${freshSnapshot.reason}`;
    report.failed.push({ path: null, reason });
    notify(onLog, reason);
    return report;
  }

  const previouslyTracked = snapshot.tracked instanceof Set ? snapshot.tracked : new Set();
  const previouslyModified = snapshot.modified instanceof Set ? snapshot.modified : new Set();

  const deleted = [];
  for (const p of previouslyTracked) {
    if (!freshSnapshot.tracked.has(p)) continue; // no longer tracked at all — not this audit's concern
    const exists = fs.existsSync(path.join(realProjectRoot, p));
    if (!exists) deleted.push(p);
  }
  report.deleted = deleted;

  if (deleted.length === 0) return report;

  const { targetFiles: pendingTargetFiles, error: pendingError } = collectPendingTargetFiles(realProjectRoot);
  if (pendingError) {
    const reason = `Failed to determine in-flight target files during deletion audit: ${pendingError}`;
    report.failed.push({ path: null, reason });
    notify(onLog, reason);
  }

  for (const p of deleted) {
    if (pendingTargetFiles.has(p)) {
      report.reportOnly.push(p);
      continue;
    }

    try {
      execFileSync('git', ['checkout', '--', p], {
        cwd: realProjectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      const note = previouslyModified.has(p)
        ? `Uncommitted modifications to ${p} were unrecoverable: the file was restored to its last committed content.`
        : null;
      report.restored.push({ path: p, note });
    } catch (err) {
      const reason = `Failed to restore deleted tracked file ${p}: ${err.message}`;
      report.failed.push({ path: p, reason });
      notify(onLog, reason);
    }
  }

  return report;
}
