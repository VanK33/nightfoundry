/**
 * warnings-ledger.js — Persistent cross-run reviewer-warning ledger.
 *
 * Reviewer warning/info findings are appended to archives/warnings.jsonl
 * at digest time so they accumulate across runs instead of rotting in
 * per-run output. One JSONL entry per line:
 *   { id, hash, createdAt, milestone, severity, category, file,
 *     description, status, note?, resolvedAt?, brainstormSlug? }
 * Status enum: open | waived | deferred | done.
 *
 * Pure JS — no AI.
 *
 * Public API:
 *   hashWarning(entry)
 *   appendWarnings(projectRoot, entries)
 *   readLedger(projectRoot, { onWarn })
 *   resolveEntries(projectRoot, ids, { status, note })
 *   stampBrainstormSlug(projectRoot, ids, slug)
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/** Legal ledger entry statuses. */
export const LEDGER_STATUSES = ['open', 'waived', 'deferred', 'done'];

/** Statuses a resolve action may assign (open is the append-time default). */
const RESOLVE_STATUSES = ['waived', 'deferred', 'done'];

/** Absolute path of the ledger file for a project. */
export function ledgerPath(projectRoot) {
  return path.join(projectRoot, 'archives', 'warnings.jsonl');
}

/**
 * Deterministic content hash of a warning's identity fields
 * (milestone + severity + category + file + description). Used for
 * dedup: re-reviews and resumed runs re-rendering the same digest
 * produce the same hash and are not re-appended while an entry with
 * that hash is still open or deferred.
 *
 * @param {{ milestone?: string, severity?: string, category?: string, file?: string, description?: string }} entry
 * @returns {string}  e.g. 'sha256:a3f1b2c4d5e6f708'
 */
export function hashWarning(entry) {
  const identity = JSON.stringify([
    entry.milestone ?? '',
    entry.severity ?? '',
    entry.category ?? '',
    entry.file ?? '',
    entry.description ?? '',
  ]);
  const hex = crypto.createHash('sha256').update(identity).digest('hex');
  return `sha256:${hex.slice(0, 16)}`;
}

/**
 * Read the ledger tolerantly. A missing file (or missing archives/) is an
 * empty ledger, not an error. A corrupt line is skipped and reported via
 * `onWarn` — one damaged line never kills the whole read.
 *
 * @param {string} projectRoot
 * @param {{ onWarn?: (message: string) => void }} [options]
 * @returns {Array<object>}  Parsed entries in file order.
 */
export function readLedger(projectRoot, options = {}) {
  const { onWarn = () => {} } = options;
  let raw;
  try {
    raw = fs.readFileSync(ledgerPath(projectRoot), 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') {
        throw new Error('not a ledger entry object');
      }
      entries.push(entry);
    } catch (err) {
      onWarn(`warnings.jsonl line ${i + 1} is corrupt and was skipped: ${err.message}`);
    }
  }
  return entries;
}

/** Next sequential 'W-NNN' id, scanning existing entry ids (any status). */
function nextId(existing) {
  let max = 0;
  for (const entry of existing) {
    const m = /^W-(\d+)$/.exec(entry.id ?? '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return (n) => `W-${String(max + n).padStart(3, '0')}`;
}

/**
 * Append warning entries to the ledger with sequential 'W-NNN' ids and
 * status 'open'. Creates archives/ if absent (the run() path never
 * archives, so the directory may not exist yet).
 *
 * Content-hash dedup: an EXISTING open-or-deferred entry with the same
 * hash blocks re-append (so re-reviews and repeated digests cannot
 * double-record), and duplicate hashes within one call append only once.
 * Waived/done entries do not block — a recurrence of an already-closed
 * warning is a new fact worth recording.
 *
 * @param {string} projectRoot
 * @param {Array<{ milestone?: string, severity: string, category?: string, file?: string, description?: string }>} entries
 * @returns {Array<object>}  The entries actually appended (full shape).
 */
export function appendWarnings(projectRoot, entries) {
  const existing = readLedger(projectRoot);
  const blocked = new Set(
    existing
      .filter((e) => e.status === 'open' || e.status === 'deferred')
      .map((e) => e.hash)
  );
  const makeId = nextId(existing);

  const appended = [];
  for (const entry of entries) {
    const hash = hashWarning(entry);
    if (blocked.has(hash)) continue;
    blocked.add(hash); // in-batch dedup too
    const record = {
      id: makeId(appended.length + 1),
      hash,
      createdAt: new Date().toISOString(),
      milestone: entry.milestone ?? null,
      severity: entry.severity,
      category: entry.category ?? null,
      file: entry.file ?? null,
      description: entry.description ?? null,
      status: 'open',
    };
    // Optional passthrough: only stamp specSection when the caller supplied
    // one (the assumption-uncertain producer does; reviewer warnings do not),
    // so existing reviewer-warning entries keep their exact shape.
    if (entry.specSection !== undefined) record.specSection = entry.specSection;
    appended.push(record);
  }
  if (appended.length === 0) return appended;

  fs.mkdirSync(path.join(projectRoot, 'archives'), { recursive: true });
  fs.appendFileSync(
    ledgerPath(projectRoot),
    appended.map((e) => JSON.stringify(e)).join('\n') + '\n'
  );
  return appended;
}

/**
 * Append one assumption-uncertain ledger entry per uncertain verify-result.
 *
 * A genuine `uncertain` assumption verdict no longer parks the run — it is
 * recorded here (durable cross-run record) and surfaced later (review gate +
 * archive). Each appended entry is an `info`-severity record categorised as
 * `'assumption-uncertain'`, with the assumption text as the description and
 * its specSection carried alongside. Reuses appendWarnings' persistence and
 * content-hash dedup; the consumer side (list/show/resolve/brainstorm) is
 * unchanged.
 *
 * @param {string} projectRoot
 * @param {Array<{ assumption?: ({ text?: string, specSection?: string }|string), status?: string, evidence?: string }>} uncertains
 *   verify-result objects (a.assumption is either {text, specSection} or a bare string).
 * @returns {Array<object>}  The entries actually appended (full shape).
 */
export function appendUncertainAssumptions(projectRoot, uncertains) {
  const entries = (uncertains ?? []).map((a) => {
    const text = a.assumption?.text ?? a.assumption ?? '';
    const specSection = a.assumption?.specSection ?? '';
    return {
      severity: 'info',
      category: 'assumption-uncertain',
      description: text,
      specSection,
    };
  });
  return appendWarnings(projectRoot, entries);
}

/**
 * Rewrite the ledger atomically (pid-qualified tmp file + rename — same
 * discipline as state.js writeJsonAtomic), applying `mutate(entry)` to
 * every parsed entry. Unparsable lines are preserved verbatim so a
 * rewrite never destroys evidence a tolerant read would have skipped.
 */
function rewriteLedger(projectRoot, mutate) {
  const filePath = ledgerPath(projectRoot);
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      out.push(line); // corrupt line: keep verbatim
      continue;
    }
    out.push(JSON.stringify(mutate(entry) ?? entry));
  }
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, out.join('\n') + '\n');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Assert every id in `ids` exists in the ledger; throws naming the
 * unknown ones. Returns the matched entries keyed by id.
 */
function indexByIds(projectRoot, ids) {
  const byId = new Map(readLedger(projectRoot).map((e) => [e.id, e]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown warning id(s): ${unknown.join(', ')}`);
  }
  return byId;
}

/**
 * Resolve ledger entries: set status (waived | deferred | done), stamp
 * resolvedAt, and record the optional note. Multi-id. The file is
 * rewritten atomically (tmp + rename). Throws naming any unknown id —
 * nothing is written in that case.
 *
 * @param {string} projectRoot
 * @param {string[]} ids
 * @param {{ status: 'waived'|'deferred'|'done', note?: string }} resolution
 * @returns {Array<object>}  The updated entries.
 */
export function resolveEntries(projectRoot, ids, { status, note } = {}) {
  if (!RESOLVE_STATUSES.includes(status)) {
    throw new Error(
      `Invalid resolve status '${status}' — expected one of: ${RESOLVE_STATUSES.join(', ')}.`
    );
  }
  indexByIds(projectRoot, ids); // throws on unknown ids before any write

  const idSet = new Set(ids);
  const updated = [];
  rewriteLedger(projectRoot, (entry) => {
    if (!idSet.has(entry.id)) return entry;
    const next = {
      ...entry,
      status,
      resolvedAt: new Date().toISOString(),
      ...(note !== undefined ? { note } : {}),
    };
    updated.push(next);
    return next;
  });
  return updated;
}

/**
 * Stamp `brainstormSlug` on the named entries — metadata only, STATUS
 * UNCHANGED (entries are closed manually via resolve --done after the
 * fix actually ships). Atomic rewrite; throws naming any unknown id.
 *
 * @param {string} projectRoot
 * @param {string[]} ids
 * @param {string} slug
 * @returns {Array<object>}  The updated entries.
 */
export function stampBrainstormSlug(projectRoot, ids, slug) {
  indexByIds(projectRoot, ids); // throws on unknown ids before any write

  const idSet = new Set(ids);
  const updated = [];
  rewriteLedger(projectRoot, (entry) => {
    if (!idSet.has(entry.id)) return entry;
    const next = { ...entry, brainstormSlug: slug };
    updated.push(next);
    return next;
  });
  return updated;
}
