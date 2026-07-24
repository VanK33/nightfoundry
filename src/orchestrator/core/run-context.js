/**
 * run-context.js — Module providing identifier generation and path
 * derivation helpers for orchestrator runs, plus the active-run pointer
 * lifecycle (claim / read / clear). The identifier and path helpers are
 * pure computations; the pointer lifecycle functions perform filesystem I/O.
 *
 * Public API:
 *   generateRunId(slug)                → string, 'run-{YYYYMMDDTHHmmss}-{sanitizedSlug}-{4hex}'
 *   harnessRoot(projectRoot)           → string, '.harness' dir path under projectRoot
 *   runHarnessDir(projectRoot, runId)  → string, per-run harness dir path under harnessRoot
 *   activeRunPointerPath(projectRoot)  → string, active-run pointer file path under harnessRoot
 *   claimActiveRun(projectRoot, {runId, slug, kind}) → boolean, atomically claims the pointer
 *   readActiveRunPointer(projectRoot)  → object|null, parsed pointer contents or null
 *   clearActiveRunPointer(projectRoot) → void, idempotently removes the pointer file
 *   resolveActiveHarnessDir(projectRoot) → string|null, validated active run harness dir or null
 *   activeHarnessDir(projectRoot)      → string, resolved active run harness dir or the flat harnessRoot fallback
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Returns a compact date-time string derived from the current time, in the
 * form YYYYMMDDTHHmmss (UTC).
 *
 * @returns {string}
 */
function compactTimestamp() {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const year = now.getUTCFullYear();
  const month = pad(now.getUTCMonth() + 1);
  const day = pad(now.getUTCDate());
  const hours = pad(now.getUTCHours());
  const minutes = pad(now.getUTCMinutes());
  const seconds = pad(now.getUTCSeconds());
  return `${year}${month}${day}T${hours}${minutes}${seconds}`;
}

/**
 * Lowercases the given slug and collapses any run of non-alphanumeric
 * characters into a single hyphen, trimming leading/trailing hyphens.
 *
 * @param {string} slug
 * @returns {string}
 */
function sanitizeSlug(slug) {
  return String(slug)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Generates a unique run identifier of the form
 * `run-{YYYYMMDDTHHmmss}-{sanitizedSlug}-{4hex}`.
 *
 * The trailing 4-hex suffix is derived from crypto.randomBytes(2), so two
 * calls made within the same second with the same slug yield different ids.
 *
 * @param {string} slug
 * @returns {string}
 */
export function generateRunId(slug) {
  const timestamp = compactTimestamp();
  // Default to 'run' when the slug sanitizes to empty (e.g. an all-symbol
  // slug), so the id never degenerates to `run-{ts}--{hex}`.
  const sanitizedSlug = sanitizeSlug(slug) || 'run';
  const suffix = crypto.randomBytes(2).toString('hex');
  return `run-${timestamp}-${sanitizedSlug}-${suffix}`;
}

/**
 * Returns the `.harness` directory path under the given project root.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function harnessRoot(projectRoot) {
  return path.join(projectRoot, '.harness');
}

/**
 * Returns the per-run harness directory path for the given runId, located
 * under harnessRoot(projectRoot).
 *
 * @param {string} projectRoot
 * @param {string} runId
 * @returns {string}
 */
export function runHarnessDir(projectRoot, runId) {
  return path.join(harnessRoot(projectRoot), runId);
}

/**
 * Returns the active-run pointer file path, located directly under
 * harnessRoot(projectRoot).
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function activeRunPointerPath(projectRoot) {
  return path.join(harnessRoot(projectRoot), 'active-run');
}

/**
 * Atomically claims the active-run pointer for the given project root.
 *
 * Ensures harnessRoot(projectRoot) exists, then attempts to create the
 * pointer file exclusively (O_EXCL via the 'wx' flag). On success, writes
 * the JSON-serialized {runId, slug, kind, startedAt} pointer contents and
 * returns true. If the pointer file already exists (EEXIST), returns false
 * without throwing — this indicates another run already holds the claim. Any
 * other error propagates to the caller.
 *
 * @param {string} projectRoot
 * @param {{runId: string, slug: string, kind: string}} pointer
 * @returns {boolean} true if the claim was acquired, false if already held
 */
export function claimActiveRun(projectRoot, { runId, slug, kind }) {
  fs.mkdirSync(harnessRoot(projectRoot), { recursive: true });

  let fd;
  try {
    fd = fs.openSync(activeRunPointerPath(projectRoot), 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return false;
    }
    throw err;
  }

  let wrote = false;
  try {
    fs.writeSync(fd, JSON.stringify({ runId, slug, kind, startedAt: new Date().toISOString() }));
    wrote = true;
  } finally {
    fs.closeSync(fd);
    if (!wrote) {
      // A failed write left a zero-byte pointer that would EEXIST-block every
      // future claim and read back as null — remove it before the error
      // propagates so the claim slot is not permanently poisoned.
      try { fs.rmSync(activeRunPointerPath(projectRoot), { force: true }); } catch { /* best-effort */ }
    }
  }

  return true;
}

/**
 * Reads and parses the active-run pointer file for the given project root.
 *
 * Returns the parsed pointer object, or null when the pointer file is
 * absent or its contents cannot be parsed as JSON. Never throws.
 *
 * @param {string} projectRoot
 * @returns {object|null}
 */
export function readActiveRunPointer(projectRoot) {
  let raw;
  try {
    raw = fs.readFileSync(activeRunPointerPath(projectRoot), 'utf8');
  } catch {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Removes the active-run pointer file for the given project root.
 *
 * Idempotent — does not throw when the pointer file is already absent.
 *
 * @param {string} projectRoot
 * @returns {void}
 */
export function clearActiveRunPointer(projectRoot) {
  try {
    fs.rmSync(activeRunPointerPath(projectRoot), { force: true });
  } catch {
    // no-op: removal is best-effort/idempotent
  }
}

/**
 * Resolves the harness directory for the currently active run, performing
 * per-hop existence validation and never throwing.
 *
 * Hops:
 *   1. The active-run pointer file must exist and be readable/parseable as
 *      an object with a runId (readActiveRunPointer already collapses a
 *      missing or unparseable pointer file to null).
 *   2. The computed runHarnessDir(projectRoot, pointer.runId) must contain a
 *      state.json file.
 *
 * Only when both hops pass is the run harness directory path returned.
 * This function does not import or read globalStatus or state.js.
 *
 * @param {string} projectRoot
 * @returns {string|null}
 */
export function resolveActiveHarnessDir(projectRoot) {
  const pointer = readActiveRunPointer(projectRoot);
  // runId must be a NON-EMPTY STRING: a truthy non-string (e.g. {runId: 123})
  // would pass a bare `!pointer.runId` check and then throw in path.join,
  // violating the never-throws contract.
  if (!pointer || typeof pointer !== 'object'
      || typeof pointer.runId !== 'string' || pointer.runId.length === 0) {
    return null;
  }

  const dir = runHarnessDir(projectRoot, pointer.runId);
  const stateFile = path.join(dir, 'state.json');

  // state.json must be a regular FILE — existsSync would also accept a
  // directory named state.json. statSync throws on a missing path, so the
  // try/catch collapses "absent" to null alongside any other stat error.
  let st;
  try {
    st = fs.statSync(stateFile);
  } catch {
    return null;
  }

  if (!st.isFile()) {
    return null;
  }

  return dir;
}

/**
 * Returns the harness directory to use for the currently active run, falling
 * back to the flat harnessRoot(projectRoot) directory when there is no
 * validated active run.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function activeHarnessDir(projectRoot) {
  return resolveActiveHarnessDir(projectRoot) ?? harnessRoot(projectRoot);
}
