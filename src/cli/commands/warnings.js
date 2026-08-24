/**
 * warnings.js — Triage CLI for the reviewer-warning ledger
 * (archives/warnings.jsonl) plus the batch brainstorm bridge.
 *
 * Verbs follow the park.js precedent (list / show / resolve, --note,
 * tolerant of damaged data, output readable without a TTY):
 *
 *   cc-orch warnings list [--all]
 *   cc-orch warnings show <id>
 *   cc-orch warnings resolve <id...> --waive|--defer|--done [--note <text>]
 *   cc-orch warnings brainstorm <id...> [--no-tty]
 */
import { displayName } from '../../orchestrator/infra/display-name.js';
import {
  readLedger,
  resolveEntries,
  stampBrainstormSlug,
} from '../../orchestrator/core/warnings-ledger.js';
import { brainstorm } from './brainstorm.js';
import { SessionManager } from '../../orchestrator/infra/session-manager.js';
import { Logger } from '../../orchestrator/infra/logger.js';
import { TokenTracker } from '../../orchestrator/infra/token-tracker.js';
import path from 'path';
import { harnessRoot } from '../../orchestrator/core/run-context.js';

/** Resolve verbs and the ledger status each one assigns. */
const RESOLVE_VERBS = { waive: 'waived', defer: 'deferred', done: 'done' };

/** Truncate a description for the list view (~60 chars, park-style). */
function truncateDescription(description) {
  const d = description || '';
  return d.length > 60 ? `${d.slice(0, 57)}...` : d;
}

/** Relative age of an ISO timestamp, e.g. '3d', '5h', '12m', '<1m'. */
function formatAge(createdAt) {
  const ms = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Tolerant ledger read for the CLI views: corrupt lines warn, never kill. */
function readLedgerTolerant(projectRoot) {
  return readLedger(projectRoot, {
    onWarn: (message) => console.error(`Warning: ${message}`),
  });
}

/**
 * List ledger entries: open + deferred by default, everything with --all.
 * Columns: id, severity, file, truncated description, age, status.
 * An empty or missing ledger is an honest empty message, exit 0.
 *
 * @param {string} projectRoot
 * @param {{ all?: boolean, json?: boolean }} options
 */
export function warningsList(projectRoot, options = {}) {
  const { all = false, json = false } = options;

  const entries = readLedgerTolerant(projectRoot).filter(
    (e) => all || e.status === 'open' || e.status === 'deferred'
  );

  if (json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log(all ? 'No warnings recorded.' : 'No open or deferred warnings.');
    return;
  }

  const ID_WIDTH = 8;
  const SEVERITY_WIDTH = 10;
  const FILE_WIDTH = 36;
  const DESC_WIDTH = 62;
  const AGE_WIDTH = 6;

  console.log(
    'Id'.padEnd(ID_WIDTH) +
    'Severity'.padEnd(SEVERITY_WIDTH) +
    'File'.padEnd(FILE_WIDTH) +
    'Description'.padEnd(DESC_WIDTH) +
    'Age'.padEnd(AGE_WIDTH) +
    'Status'
  );
  console.log('-'.repeat(ID_WIDTH + SEVERITY_WIDTH + FILE_WIDTH + DESC_WIDTH + AGE_WIDTH + 8));
  for (const e of entries) {
    console.log(
      String(e.id ?? '?').padEnd(ID_WIDTH) +
      String(e.severity ?? '?').padEnd(SEVERITY_WIDTH) +
      String(e.file ?? '(no file)').padEnd(FILE_WIDTH) +
      truncateDescription(e.description).padEnd(DESC_WIDTH) +
      formatAge(e.createdAt).padEnd(AGE_WIDTH) +
      String(e.status ?? '?')
    );
  }
}

/**
 * Show one ledger entry in full (every recorded field, including note and
 * brainstormSlug when present).
 *
 * @param {string} projectRoot
 * @param {string} id
 */
export function warningsShow(projectRoot, id) {
  if (!id) {
    console.error(`Usage: ${displayName()} warnings show <id>`);
    process.exitCode = 1;
    return;
  }

  const entry = readLedgerTolerant(projectRoot).find((e) => e.id === id);
  if (!entry) {
    console.error(`Warning '${id}' not found in the ledger.`);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(entry, null, 2));
}

/**
 * Resolve ledger entries with exactly one of --waive|--defer|--done
 * (optional --note). Multi-id; resolvedAt is stamped by the ledger module.
 * Unknown ids error without writing anything.
 *
 * @param {string} projectRoot
 * @param {string[]} ids
 * @param {{ waive?: boolean, defer?: boolean, done?: boolean, note?: string }} flags
 */
export function warningsResolve(projectRoot, ids, flags = {}) {
  if (!ids || ids.length === 0) {
    console.error(`Usage: ${displayName()} warnings resolve <id...> --waive|--defer|--done [--note <text>]`);
    process.exitCode = 1;
    return;
  }

  const verbs = Object.keys(RESOLVE_VERBS).filter((v) => flags[v]);
  if (verbs.length !== 1) {
    console.error('warnings resolve requires exactly one of --waive, --defer, --done.');
    process.exitCode = 1;
    return;
  }
  const status = RESOLVE_VERBS[verbs[0]];

  let updated;
  try {
    updated = resolveEntries(projectRoot, ids, { status, note: flags.note });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  for (const entry of updated) {
    console.log(`Warning '${entry.id}' resolved → status '${status}'.`);
  }
}

/**
 * Synthesize the deterministic prose goal for the brainstorm bridge:
 * one-line bundling instruction + a numbered list with each entry's
 * severity, file, and description.
 *
 * @param {Array<object>} entries
 * @returns {string}
 */
export function synthesizeBrainstormGoal(entries) {
  const lines = entries.map(
    (e, i) => `${i + 1}. [${e.severity}] ${e.file ?? '(no file)'}: ${e.description ?? '(no description)'}`
  );
  return [
    `Fix the following ${entries.length} reviewer warning(s) from the warnings ledger as one bundled change:`,
    ...lines,
  ].join('\n');
}

/**
 * Batch brainstorm bridge: synthesize the selected entries into one prose
 * goal and drive the existing brainstorm command to draft a bundled fix
 * spec. Unknown or already-done ids error (named) BEFORE any brainstorm
 * invocation. Afterwards each selected entry is stamped with the draft's
 * brainstormSlug — metadata only, STATUS UNCHANGED: entries are closed
 * manually via `resolve --done` after the fix actually ships.
 *
 * Spec approval / run / acceptance stay fully human-gated — the bridge
 * only creates the draft (the normal brainstorm lifecycle takes over).
 *
 * @param {string} projectRoot
 * @param {string[]} ids
 * @param {{ 'no-tty'?: boolean }} flags
 * @param {{ brainstorm?: Function }} [deps]  Injectable seam for tests.
 * @returns {Promise<{ slug: string, status: string, dir: string }|undefined>}
 */
export async function warningsBrainstorm(projectRoot, ids, flags = {}, deps = {}) {
  if (!ids || ids.length === 0) {
    console.error(`Usage: ${displayName()} warnings brainstorm <id...> [--no-tty]`);
    process.exitCode = 1;
    return;
  }

  const byId = new Map(readLedgerTolerant(projectRoot).map((e) => [e.id, e]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    console.error(`Unknown warning id(s): ${unknown.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const done = ids.filter((id) => byId.get(id).status === 'done');
  if (done.length > 0) {
    console.error(`Already-done warning id(s): ${done.join(', ')} — nothing to brainstorm.`);
    process.exitCode = 1;
    return;
  }

  const entries = ids.map((id) => byId.get(id));
  const prose = synthesizeBrainstormGoal(entries);

  let bridge = deps.brainstorm;
  let opts = {};
  if (!bridge) {
    bridge = brainstorm;
    const harnessDir = harnessRoot(projectRoot);
    opts = {
      sessionManager: new SessionManager(),
      logger: new Logger(harnessDir),
      tokenTracker: new TokenTracker(harnessDir),
    };
  }

  const result = await bridge(projectRoot, [prose], { 'no-tty': !!flags['no-tty'] }, opts);

  stampBrainstormSlug(projectRoot, ids, result.slug);
  console.log(
    `Stamped brainstormSlug '${result.slug}' on ${ids.length} warning(s): ${ids.join(', ')} ` +
    `(status unchanged — close with: ${displayName()} warnings resolve ${ids.join(' ')} --done after the fix ships).`
  );
  return result;
}
