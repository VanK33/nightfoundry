/**
 * bundle-gate.js — Bundle path derivation and reading/validation.
 *
 * Deterministic JavaScript only. Imports are limited to node builtins (e.g.
 * fs/path) plus the config singleton — this module MUST NOT import
 * session-manager or any module under src/orchestrator/agents/, and it MUST
 * make no LLM or agent-session calls. It is a pure, synchronous helper.
 *
 * Public API:
 *   deriveBundlePath(specFilePath) → string|null
 *   readBundle(specFilePath, projectRoot) → {
 *     bundle: object|null,
 *     entries: Array,
 *     dropped: Array,
 *     rejectionReason: string|null,
 *   }
 */
import fs from 'fs';
import path from 'path';
import config from '../infra/config.js';

const NO_BUNDLE_RESULT = Object.freeze({
  bundle: null,
  entries: [],
  dropped: [],
  rejectionReason: null,
});

/**
 * Returns true when value is a plain object (not null, not an array).
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a single bundle entry against the v0 entry shape:
 *   { id: string, kind: string, text: string,
 *     evidence: Array<{ file: string, symbol?: string }>,
 *     lastScannedCommit?: string }
 * @param {unknown} entry
 * @returns {boolean}
 */
function isValidEntry(entry) {
  if (!isPlainObject(entry)) return false;
  if (typeof entry.id !== 'string' || entry.id === '') return false;
  if (typeof entry.kind !== 'string' || entry.kind === '') return false;
  if (typeof entry.text !== 'string') return false;
  if (!Array.isArray(entry.evidence)) return false;

  for (const item of entry.evidence) {
    if (!isPlainObject(item)) return false;
    if (typeof item.file !== 'string' || item.file === '') return false;
    if (
      Object.prototype.hasOwnProperty.call(item, 'symbol') &&
      typeof item.symbol !== 'string'
    ) {
      return false;
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(entry, 'lastScannedCommit') &&
    typeof entry.lastScannedCommit !== 'string'
  ) {
    return false;
  }

  return true;
}

/**
 * Validate the top-level v0 bundle shape:
 *   { schemaVersion: 1, generatedBy: string, baseCommit: string,
 *     entries: Array<Entry> }
 * generatedBy is recorded provenance only — its value is never branched on.
 * @param {unknown} parsed
 * @returns {boolean}
 */
function isValidBundleShape(parsed) {
  if (!isPlainObject(parsed)) return false;
  if (parsed.schemaVersion !== 1) return false;
  if (typeof parsed.generatedBy !== 'string') return false;
  if (typeof parsed.baseCommit !== 'string') return false;
  if (!Array.isArray(parsed.entries)) return false;

  for (const entry of parsed.entries) {
    if (!isValidEntry(entry)) return false;
  }

  return true;
}

/**
 * Derive the bundle.json path for a given spec file path.
 *
 * Pinned filename-derivation rule: when the basename of specFilePath ends
 * with 'spec.json', return the path in the same directory whose basename
 * replaces that trailing 'spec.json' with 'bundle.json' — so
 * '<dir>/<slug>.spec.json' → '<dir>/<slug>.bundle.json' and a queue entry's
 * '<dir>/spec.json' → '<dir>/bundle.json'. For any other basename (or a
 * falsy/non-string argument) returns null.
 *
 * Never throws.
 *
 * @param {string} specFilePath - path to a spec.json file (may be falsy)
 * @returns {string|null} derived bundle.json path, or null if not derivable
 */
export function deriveBundlePath(specFilePath) {
  if (!specFilePath || typeof specFilePath !== 'string') return null;

  const lastSlash = Math.max(specFilePath.lastIndexOf('/'), specFilePath.lastIndexOf('\\'));
  const dir = lastSlash >= 0 ? specFilePath.slice(0, lastSlash + 1) : '';
  const basename = lastSlash >= 0 ? specFilePath.slice(lastSlash + 1) : specFilePath;

  if (!basename.endsWith('spec.json')) return null;

  const newBasename = basename.slice(0, basename.length - 'spec.json'.length) + 'bundle.json';
  return dir + newBasename;
}

/**
 * Re-verify a single evidence anchor against the current working tree.
 * An anchor resolves when its `file` exists relative to projectRoot and,
 * if a `symbol` string is present on the anchor, that symbol occurs
 * (via a plain substring check) in the file's current text.
 *
 * Never throws — any filesystem error while checking is treated as an
 * unresolved anchor.
 *
 * @param {{ file: string, symbol?: string }} anchor
 * @param {string} projectRoot
 * @returns {{ ok: boolean, reason: string|null }}
 */
function checkEvidenceAnchor(anchor, projectRoot) {
  const filePath = path.isAbsolute(anchor.file)
    ? anchor.file
    : path.resolve(typeof projectRoot === 'string' ? projectRoot : '', anchor.file);

  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      reason: `evidence file ${anchor.file} does not exist or could not be read (${
        err && err.message ? err.message : String(err)
      })`,
    };
  }

  if (Object.prototype.hasOwnProperty.call(anchor, 'symbol')) {
    if (!text.includes(anchor.symbol)) {
      return {
        ok: false,
        reason: `symbol "${anchor.symbol}" not found in evidence file ${anchor.file}`,
      };
    }
  }

  return { ok: true, reason: null };
}

/**
 * Re-verify all evidence anchors for a single bundle entry against the
 * current working tree. Returns the first unresolved-anchor reason, or
 * null when every anchor resolves (including entries with no evidence).
 *
 * Never throws — an unreadable/erroring anchor check is treated as an
 * unresolved anchor rather than propagating.
 *
 * @param {object} entry - a schema-valid bundle entry
 * @param {string} projectRoot
 * @returns {string|null}
 */
function findUnresolvedEvidenceReason(entry, projectRoot) {
  try {
    for (const anchor of entry.evidence) {
      const result = checkEvidenceAnchor(anchor, projectRoot);
      if (!result.ok) return result.reason;
    }
    return null;
  } catch (err) {
    return `evidence anchors could not be checked (${err && err.message ? err.message : String(err)})`;
  }
}

/**
 * Read and validate an architect bundle.json file associated with a spec
 * file. Fail-open: every failure mode (missing file, oversized file,
 * unreadable file, unparseable JSON, wrong schemaVersion, or a shape that
 * fails v0 validation) rejects the bundle WHOLE and returns the same
 * no-bundle result shape rather than throwing or propagating a failure to
 * the caller. Rejections other than "no path derivable" / "file does not
 * exist" emit exactly one console.warn naming the bundle path and reason.
 *
 * generatedBy is recorded provenance only — this function never branches
 * on its value.
 *
 * Once the bundle shape is validated, each entry's evidence anchors are
 * re-verified against the working tree (see findUnresolvedEvidenceReason).
 * An entry whose anchors no longer all resolve is DROPPED individually:
 * it is excluded from the returned `entries`, appended to `dropped` as
 * { id, reason }, and reported via a single console.warn — this never
 * causes the bundle as a whole to be rejected.
 *
 * @param {string} specFilePath - path to the spec.json file
 * @param {string} projectRoot - project root, used to resolve a relative
 *   bundle path and to resolve evidence anchor file paths
 * @returns {{ bundle: object|null, entries: Array, dropped: Array, rejectionReason: string|null }}
 */
export function readBundle(specFilePath, projectRoot) {
  let derivedPath;
  try {
    derivedPath = deriveBundlePath(specFilePath);
  } catch {
    return { ...NO_BUNDLE_RESULT };
  }

  if (!derivedPath) {
    return { ...NO_BUNDLE_RESULT };
  }

  const bundlePath =
    typeof projectRoot === 'string' && projectRoot.length > 0 && !path.isAbsolute(derivedPath)
      ? path.resolve(projectRoot, derivedPath)
      : derivedPath;

  const reject = (reason) => {
    console.warn(`Bundle rejected at ${bundlePath}: ${reason}`);
    return { ...NO_BUNDLE_RESULT, rejectionReason: reason };
  };

  let stat;
  try {
    stat = fs.statSync(bundlePath);
  } catch {
    // No bundle file present — silent no-op, not a rejection.
    return { ...NO_BUNDLE_RESULT };
  }

  if (stat.size > config.architect.bundleMaxBytes) {
    return reject(
      `bundle size ${stat.size} bytes exceeds config.architect.bundleMaxBytes (${config.architect.bundleMaxBytes})`
    );
  }

  let raw;
  try {
    raw = fs.readFileSync(bundlePath, 'utf8');
  } catch (err) {
    return reject(`bundle file could not be read (${err && err.message ? err.message : String(err)})`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject('bundle file is not parseable JSON');
  }

  if (!isPlainObject(parsed) || parsed.schemaVersion !== 1) {
    return reject('bundle schemaVersion is missing or not equal to 1');
  }

  if (!isValidBundleShape(parsed)) {
    return reject('bundle does not match the v0 bundle shape');
  }

  const entries = [];
  const dropped = [];

  for (const entry of parsed.entries) {
    const reason = findUnresolvedEvidenceReason(entry, projectRoot);
    if (reason === null) {
      entries.push(entry);
    } else {
      dropped.push({ id: entry.id, reason });
      console.warn(`Bundle entry dropped at ${bundlePath} (id=${entry.id}): ${reason}`);
    }
  }

  return {
    bundle: parsed,
    entries,
    dropped,
    rejectionReason: null,
  };
}
