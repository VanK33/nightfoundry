/**
 * usage-ledger.js — Append-only cross-run spend-outcome ledger.
 *
 * When a run's work is disposed of with a terminal, non-recoverable
 * outcome, a fact is appended to archives/usage-ledger.jsonl. One JSONL
 * entry per line:
 *   { ts, runId, slug, outcome, totals, sessions }
 *
 * The outcome set (USAGE_LEDGER_OUTCOMES) is CLOSED — exactly the seven
 * values enumerated below, no more, no less. Notably, there is no
 * 'interrupted' outcome: an interrupted run's logs are not archived under
 * a terminal disposition — they stay pending. Their flushed spend is
 * instead recovered later via the superseded→stale→sweep chain (a
 * pending run superseded by a fresh one becomes stale, and the sweep
 * pass reconciles/accounts for it), so 'interrupted' never needs — and
 * must never gain — its own ledger outcome.
 *
 * Double-count-free rule: an entry is appended ONLY when that runId's
 * logs are NOT ALSO being moved into an archive by the same disposition
 * (the ledger fact and the archive move are mutually exclusive views of
 * the same event, never both). Requeued or promoted work always runs
 * under a fresh runId, so a given runId's spend can never be represented
 * by more than one ledger entry or double-counted across a requeue.
 *
 * This is a pure fact log: no dedup, no counters, no status lifecycle, no
 * LLM calls. Writing is best-effort and fail-soft — a ledger write must
 * never alter caller control flow.
 *
 * Pure JS — no AI.
 *
 * Public API:
 *   usageLedgerPath(projectRoot)
 *   readRunUsage(harnessDir)
 *   appendUsageLedger(projectRoot, entry, { onWarn })
 */
import fs from 'fs';
import path from 'path';

/** Absolute path of the usage ledger file for a project. */
export function usageLedgerPath(projectRoot) {
  return path.join(projectRoot, 'archives', 'usage-ledger.jsonl');
}

/**
 * Read a single run's token-usage.json tolerantly, lifting `totals` and
 * `sessions` verbatim from the parsed object. A missing file, an unreadable
 * path (including a directory in its place), malformed JSON, or a parsed
 * object lacking those keys all resolve to the same empty shape — this
 * function never throws and performs no writes.
 *
 * @param {string} harnessDir
 * @returns {{ totals: object|null, sessions: Array<object> }}
 */
export function readRunUsage(harnessDir) {
  const empty = { totals: null, sessions: [] };
  let raw;
  try {
    raw = fs.readFileSync(path.join(harnessDir, 'logs', 'token-usage.json'), 'utf8');
  } catch {
    return empty;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (data === null || typeof data !== 'object') return empty;
  return {
    totals: data.totals ?? null,
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
  };
}

/**
 * Closed set of legal usage-ledger outcomes. There is deliberately no
 * 'interrupted' value — see the module header for why.
 */
export const USAGE_LEDGER_OUTCOMES = Object.freeze([
  'failed-criteria',
  'failed-plan',
  'failed-test-gate',
  'halted-scope',
  'halted-assumptions',
  'dry-run-failed',
  'rejected',
]);

/**
 * Append one usage-outcome fact to the ledger. Best-effort: all filesystem
 * work is wrapped in try/catch; on failure exactly one warning is emitted
 * via `onWarn` and the function returns undefined without throwing — the
 * caller's control flow is never altered.
 *
 * `totals`/`sessions` are taken from `entry.totals`/`entry.sessions` when
 * supplied; otherwise, when `entry.harnessDir` is given, they are read via
 * `readRunUsage(entry.harnessDir)` (tolerant of a missing/unreadable
 * token-usage.json — that still yields `totals: null` and an appended
 * entry, never a skipped one). With neither supplied, `totals` is null and
 * `sessions` is an empty array.
 *
 * @param {string} projectRoot
 * @param {{
 *   runId?: (string|null),
 *   slug?: (string|null),
 *   outcome?: (string|null),
 *   totals?: (object|null),
 *   sessions?: Array<object>,
 *   harnessDir?: string,
 * }} entry
 * @param {{ onWarn?: (message: string) => void }} [options]
 * @returns {undefined}
 */
export function appendUsageLedger(projectRoot, entry, options = {}) {
  const { onWarn = () => {} } = options;
  try {
    let totals;
    let sessions;
    if (entry?.totals !== undefined || entry?.sessions !== undefined) {
      totals = entry?.totals ?? null;
      sessions = Array.isArray(entry?.sessions) ? entry.sessions : [];
    } else if (entry?.harnessDir) {
      const usage = readRunUsage(entry.harnessDir);
      totals = usage.totals;
      sessions = usage.sessions;
    } else {
      totals = null;
      sessions = [];
    }
    const record = {
      ts: new Date().toISOString(),
      runId: entry?.runId ?? null,
      slug: entry?.slug ?? null,
      outcome: entry?.outcome ?? null,
      totals,
      sessions,
    };
    fs.mkdirSync(path.join(projectRoot, 'archives'), { recursive: true });
    // Double-count-free rule: append only when this runId's logs are NOT
    // ALSO being moved into an archive under the same disposition — the
    // ledger fact and the archive move are mutually exclusive views of the
    // same event, never both.
    fs.appendFileSync(usageLedgerPath(projectRoot), JSON.stringify(record) + '\n');
  } catch (err) {
    onWarn(`Failed to append usage to usage-ledger.jsonl: ${err.message}`);
  }
}
