import fs from 'fs';
import path from 'path';
import { readQueueEntry, removeQueueEntry, updateQueueEntryStatus } from '../../orchestrator/core/state.js';
import { displayName } from '../../orchestrator/infra/display-name.js';

/**
 * Read one queue entry without letting a damaged directory throw.
 *
 * Local precedent to park.js's readQueueEntryTolerant: a gutted entry (e.g.
 * spec.md deleted) makes state.js's readQueueEntry throw. Returns
 * { entry, status, damage }: `entry` is null and `damage` carries the reason
 * when the entry files are missing/corrupt; `status` is recovered straight
 * from the status file when possible so damaged entries can still be
 * classified and listed.
 *
 * @param {string} projectRoot
 * @param {string} slug
 */
function readQueueEntryTolerant(projectRoot, slug) {
  let entry = null;
  let damage = null;
  try {
    entry = readQueueEntry(projectRoot, slug);
  } catch (err) {
    damage = err.message;
  }
  let status = entry?.status ?? null;
  if (status === null) {
    try {
      status = fs.readFileSync(path.join(projectRoot, 'queue', slug, 'status'), 'utf8').trim();
    } catch {
      status = null;
    }
  }
  return { entry, status, damage };
}

/**
 * Tolerant queue scan for `queue list`: like state.js's listQueue, but one
 * damaged entry must not kill the whole listing. Returns rows
 * { slug, status, entry, damage } sorted by validatedAt where readable
 * (damaged entries sort last) — the same ordering listQueue used, so the
 * all-healthy-queue output stays byte-identical to before.
 *
 * @param {string} projectRoot
 */
function scanQueueTolerant(projectRoot) {
  const queueDir = path.join(projectRoot, 'queue');
  let names = [];
  try {
    names = fs.readdirSync(queueDir);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    try {
      if (!fs.statSync(path.join(queueDir, name)).isDirectory()) continue;
    } catch {
      continue;
    }
    const { entry, status, damage } = readQueueEntryTolerant(projectRoot, name);
    if (entry === null && status === null) continue; // nothing classifiable at all
    rows.push({ slug: name, status, entry, damage });
  }
  rows.sort((a, b) => {
    const tA = new Date(a.entry?.validatedAt ?? NaN).getTime();
    const tB = new Date(b.entry?.validatedAt ?? NaN).getTime();
    return (Number.isFinite(tA) ? tA : Infinity) - (Number.isFinite(tB) ? tB : Infinity);
  });
  return rows;
}

/**
 * Display the project queue as a table or JSON.
 *
 * Fail-soft: a damaged entry (e.g. spec.md deleted from under a queue
 * directory) is rendered as a [broken] row/record with a hint to remove it
 * via `nightfoundry queue remove <slug>`, rather than crashing the whole listing.
 *
 * @param {string} projectRoot
 * @param {{ json?: boolean }} options
 */
export function queueList(projectRoot, options = {}) {
  const { json = false } = options;

  const rows = scanQueueTolerant(projectRoot);

  if (rows.length === 0) {
    if (json) {
      console.log(JSON.stringify([], null, 2));
    } else {
      console.log('Queue is empty.');
    }
    return;
  }

  if (json) {
    const out = rows.map((row) =>
      row.damage
        ? {
            slug: row.slug,
            broken: true,
            status: row.status,
            damage: row.damage,
          }
        : row.entry
    );
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // Print formatted table
  const NAME_WIDTH = 30;
  const STATUS_WIDTH = 22;

  const header =
    'Name'.padEnd(NAME_WIDTH) +
    'Status'.padEnd(STATUS_WIDTH) +
    'Validated At';
  console.log(header);
  console.log('-'.repeat(NAME_WIDTH + STATUS_WIDTH + 24));

  for (const row of rows) {
    if (row.damage) {
      const name = row.slug.padEnd(NAME_WIDTH);
      console.log(
        `${name}[broken] entry damaged (${row.damage}) — remove with: nightfoundry queue remove ${row.slug}`
      );
      continue;
    }
    const entry = row.entry;
    const name = (entry.slug || '').padEnd(NAME_WIDTH);
    const status = (entry.status || '').padEnd(STATUS_WIDTH);
    const ts = entry.validatedAt
      ? String(entry.validatedAt).slice(0, 24)
      : '';
    console.log(`${name}${status}${ts}`);
  }
}

/**
 * Remove a queue entry by slug, logging confirmation or error.
 *
 * @param {string} projectRoot
 * @param {string} slug
 */
export function queueRemove(projectRoot, slug) {
  const entryDir = path.join(projectRoot, 'queue', slug);
  if (!fs.existsSync(entryDir)) {
    console.error(`Queue entry '${slug}' not found.`);
    return;
  }
  removeQueueEntry(projectRoot, slug);
  console.log(`Queue entry '${slug}' removed.`);
}

/**
 * Reset a queue entry back to 'pending' so `nightfoundry resume --batch` will
 * pick it up again. Reads the entry via readQueueEntryTolerant and handles
 * four arms:
 *
 *  (a) DAMAGED — the entry directory exists but is unreadable (damage !=
 *      null). Refused without changing anything, same refusal posture as
 *      parkResolve's damaged-entry leg: names the slug, the damage reason,
 *      and `nightfoundry queue remove <slug>` as the way out.
 *  (b) UNKNOWN — entry, status, and damage are all null (readQueueEntry
 *      returns null for a missing entry directory rather than throwing).
 *      Reports a not-found error following queueRemove's message
 *      convention and changes nothing.
 *  (c) NO-OP — the entry's status is already 'pending'. Prints a friendly
 *      message and changes nothing.
 *  (d) RESET — any other status. Sets the status to 'pending' via
 *      updateQueueEntryStatus(projectRoot, slug, 'pending') — status-only,
 *      never writeQueueEntry, so spec.md/plan.json/spec.json/validated-at.json
 *      are left untouched — and prints a confirmation naming the previous
 *      status and directing the operator to `nightfoundry resume --batch`.
 *
 * @param {string} projectRoot
 * @param {string} slug
 */
export function queueRetry(projectRoot, slug) {
  const { entry, status, damage } = readQueueEntryTolerant(projectRoot, slug);

  if (damage) {
    console.error(
      `Refusing to retry '${slug}': queue entry is damaged (${damage}). ` +
      `There is nothing left to reset — inspect queue/${slug}/ and the ` +
      `failed archive for this run, or remove the entry with nightfoundry queue remove ${slug}.`
    );
    process.exitCode = 1;
    return;
  }

  if (entry === null && status === null) {
    console.error(`Queue entry '${slug}' not found.`);
    process.exitCode = 1;
    return;
  }

  if (status === 'pending') {
    console.log(`Queue entry '${slug}' is already pending.`);
    return;
  }

  updateQueueEntryStatus(projectRoot, slug, 'pending');
  console.log(
    `Queue entry '${slug}' reset from '${status}' to 'pending'. ` +
    `Run ${displayName()} resume --batch to pick it up.`
  );
}
