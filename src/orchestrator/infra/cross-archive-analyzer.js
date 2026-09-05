/**
 * cross-archive-analyzer.js — Multi-archive session aggregation utilities.
 *
 * Enumerates .harness archive directories, loads per-archive session summaries,
 * normalizes on-disk entry shapes, and aggregates cost/token/cache statistics
 * across archives with optional role, date, and count filters.
 *
 * Public API:
 *   enumerateArchives(archivesDir) → { id, date, dir }[]
 *   loadArchiveSummary(archive) → SessionSummaryEntry[] | null
 *   aggregateAcrossArchives(archiveDescriptors, { role, since, last }) → AggregateResult
 */
import fs from 'fs';
import path from 'path';
import { aggregateByRole, cacheEfficiency } from './usage-analyzer.js';

/**
 * List archive descriptors from a directory, sorted by directory name.
 * Returns [] if archivesDir does not exist.
 *
 * @param {string} archivesDir
 * @returns {{ id: string, date: string|null, dir: string }[]}
 */
export function enumerateArchives(archivesDir) {
  if (!fs.existsSync(archivesDir)) return [];
  return fs.readdirSync(archivesDir)
    .filter((d) => fs.statSync(path.join(archivesDir, d)).isDirectory())
    .sort()
    .map((d) => {
      const dateMatch = d.match(/(\d{4}-\d{2}-\d{2})/);
      const dir = path.join(archivesDir, d);
      let date = dateMatch ? dateMatch[1] : null;
      if (date === null) {
        // Fallback: derive date from earliest startedAt in session-summary.json
        const summaryPath = path.join(dir, 'logs', 'session-summary.json');
        if (fs.existsSync(summaryPath)) {
          try {
            const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
            if (Array.isArray(data)) {
              const withStartedAt = data.filter((e) => e && typeof e.startedAt === 'string');
              if (withStartedAt.length > 0) {
                withStartedAt.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
                date = withStartedAt[0].startedAt.slice(0, 10);
              }
            }
          } catch (err) {
            console.warn(`[cross-archive-analyzer] Failed to parse session-summary.json for date derivation: ${summaryPath}: ${err.message}`);
          }
        }
      }
      return { id: d, date, dir };
    });
}

/**
 * Load the totalCost value from <archive.dir>/manifest.json.
 * Returns the numeric totalCost when the file exists and contains a finite number;
 * returns null when the file is missing, unreadable, unparseable, or totalCost is
 * absent/non-numeric.
 *
 * @param {{ dir: string, id?: string }} archive
 * @returns {number|null}
 */
export function loadArchiveManifestTotal(archive) {
  const archiveId = archive.id || path.basename(archive.dir || '');
  const manifestPath = path.join(archive.dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (typeof data.totalCost === 'number' && isFinite(data.totalCost)) {
      return data.totalCost;
    }
    return null;
  } catch (err) {
    console.warn(`[cross-archive-analyzer] Failed to parse manifest.json for archive ${archiveId}: ${manifestPath}: ${err.message}`);
    return null;
  }
}

/**
 * Load session entries for an archive, preferring logs/token-usage.json
 * (every session, including in-flight / interrupted ones) over
 * logs/session-summary.json (completed sessions only). The session-summary
 * file undercounts on failed/interrupted runs because mid-execution sessions
 * never reach the summary, so token-usage is the cost/session source of truth.
 *
 * The two files have DIFFERENT on-disk shapes:
 *   token-usage.json    — object { sessions: [...], totals: {...} };
 *                         entries use `type` + `totalCostUsd` (+ `timestamp`).
 *   session-summary.json — bare array; entries use `role` + `totalCost`
 *                         (+ `startedAt`).
 *
 * Both shapes are returned in the session-summary CANONICAL input shape that
 * the module-local normalizeEntry consumes (`role`, `totalCost`, `startedAt`):
 *   - session-summary entries are returned byte-intact (they already match).
 *   - token-usage entries are mapped type→role, totalCostUsd→totalCost,
 *     timestamp→startedAt (only filling startedAt when absent), so normalizeEntry
 *     then re-derives the canonical `type`/`totalCostUsd` exactly as before.
 * This keeps normalizeEntry and aggregateAcrossArchives unchanged.
 *
 * Returns null and logs a warning to stderr when the selected source is
 * missing or malformed (the archive is then skipped, not crashed) — preserving
 * the TC_ALL6 missing/malformed contract for whichever file is absent.
 *
 * @param {{ dir: string, id?: string }} archive
 * @returns {Array|null}
 */
export function loadArchiveSummary(archive) {
  const archiveId = archive.id || path.basename(archive.dir || '');
  const tokenUsagePath = path.join(archive.dir, 'logs', 'token-usage.json');

  // PRIMARY: token-usage.json (object { sessions, totals }).
  if (fs.existsSync(tokenUsagePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(tokenUsagePath, 'utf8'));
      const sessions = data && Array.isArray(data.sessions) ? data.sessions : [];
      // Map token-usage entries into the session-summary canonical input shape
      // (role/totalCost/startedAt) so normalizeEntry consumes them unchanged.
      return sessions.map((s) => ({
        ...s,
        role: s.type,
        totalCost: s.totalCostUsd,
        startedAt: s.startedAt != null ? s.startedAt : s.timestamp,
      }));
    } catch (err) {
      console.warn(`[cross-archive-analyzer] Failed to parse token-usage.json for archive ${archiveId}: ${tokenUsagePath}: ${err.message}`);
      return null;
    }
  }

  // FALLBACK: session-summary.json (bare array, role/totalCost). Byte-intact —
  // existing test/test-usage-all.js fixtures stage only this file.
  const summaryPath = path.join(archive.dir, 'logs', 'session-summary.json');
  if (!fs.existsSync(summaryPath)) {
    // Thin-loop archives (v0.3) carry a top-level record.json instead of
    // logs/ — skipping them here is expected layout, not a broken archive,
    // so stay silent. Anything else missing both files still warns.
    if (fs.existsSync(path.join(archive.dir, 'record.json'))) return null;
    console.warn(`[cross-archive-analyzer] no token-usage.json or session-summary.json for archive ${archiveId}: ${summaryPath}`);
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`[cross-archive-analyzer] Failed to parse session-summary.json for archive ${archiveId}: ${summaryPath}: ${err.message}`);
    return null;
  }
}

/**
 * Normalize a raw SessionSummaryEntry (on-disk shape) to the canonical
 * SessionEntry shape consumed by aggregateByRole / cacheEfficiency.
 *
 * Maps: role → type, totalCost → totalCostUsd
 * Skips entries missing role or totalCost (emits one console.warn per skipped entry).
 *
 * @param {Object} entry - Raw on-disk session entry
 * @returns {Object|null} Canonical entry or null if skipped
 */
function normalizeEntry(entry) {
  if (entry.role == null) {
    console.warn('[cross-archive-analyzer] Skipping entry missing role:', entry);
    return null;
  }
  if (entry.totalCost == null) {
    console.warn('[cross-archive-analyzer] Skipping entry missing totalCost:', entry);
    return null;
  }
  return {
    ...entry,
    type: entry.role,
    totalCostUsd: entry.totalCost,
  };
}

/**
 * Compute session-reuse savings estimate for a list of sessions of a single role.
 * Sessions are sorted ascending by startedAt; the first session's cacheCreation is
 * considered unavoidable (cold start), all subsequent sessions' cacheCreation is avoidable.
 *
 * @param {Array} sessions - Normalized sessions for a single role
 * @returns {Object}
 */
function estimateReuseSavings(sessions) {
  const sorted = [...sessions].sort((a, b) =>
    (a.startedAt || '').localeCompare(b.startedAt || '')
  );
  if (sorted.length <= 1) {
    return {
      avoidableCacheCreationTokens: 0,
      note: 'Only 0 or 1 session of this role; no reuse savings possible.',
    };
  }
  const [first, ...rest] = sorted;
  const firstCacheCreation = first.cacheCreation || 0;
  const avoidable = rest.reduce((sum, s) => sum + (s.cacheCreation || 0), 0);
  return {
    sessionCount: sorted.length,
    firstSessionCacheCreation: firstCacheCreation,
    avoidableCacheCreationTokens: avoidable,
    percentAvoidable: firstCacheCreation + avoidable > 0
      ? avoidable / (firstCacheCreation + avoidable)
      : 0,
  };
}

/**
 * Compute overall cache ratio = sum(cacheRead) / sum(cacheCreation).
 * Returns null when sum(cacheCreation) === 0.
 *
 * @param {Array} sessions
 * @returns {number|null}
 */
function computeOverallCacheRatio(sessions) {
  const totalCacheCreation = sessions.reduce((sum, s) => sum + (s.cacheCreation || 0), 0);
  const totalCacheRead = sessions.reduce((sum, s) => sum + (s.cacheRead || 0), 0);
  return totalCacheCreation === 0 ? null : totalCacheRead / totalCacheCreation;
}

/**
 * Enrich a byRole map with script-specific per-role stats:
 * avgDurationMs, avgToolCalls, estimateReuseSavings.
 *
 * @param {Object} byRoleMap - Result of aggregateByRole(sessions)
 * @param {Array} sessions - Normalized sessions (same set used to build byRoleMap)
 * @returns {Object} byRoleMap entries enriched with per-role averages and savings
 */
function enrichByRole(byRoleMap, sessions) {
  // Group sessions by type for per-role stats
  const sessionsByRole = {};
  for (const s of sessions) {
    if (!sessionsByRole[s.type]) sessionsByRole[s.type] = [];
    sessionsByRole[s.type].push(s);
  }

  const result = {};
  for (const [role, stats] of Object.entries(byRoleMap)) {
    const roleSessions = sessionsByRole[role] || [];
    const count = roleSessions.length;
    const totalDurationMs = roleSessions.reduce((sum, s) => sum + (s.durationMs || 0), 0);
    const totalToolCalls = roleSessions.reduce((sum, s) => sum + (s.toolCalls || 0), 0);
    result[role] = {
      ...stats,
      avgDurationMs: count > 0 ? totalDurationMs / count : 0,
      avgToolCalls: count > 0 ? totalToolCalls / count : 0,
      estimateReuseSavings: estimateReuseSavings(roleSessions),
    };
  }
  return result;
}

/**
 * Aggregate session data across multiple archive descriptors.
 *
 * Filters:
 *   role  — keep only sessions whose type matches
 *   since — keep only sessions with startedAt >= since (ISO date string)
 *   last  — limit to the last N descriptors (after sort)
 *
 * @param {{ id: string, date: string|null, dir: string }[]} archiveDescriptors
 * @param {{ role?: string, since?: string, last?: number }} options
 * @returns {{
 *   archives: { id: string, date: string|null, sessionCount: number, totalCostUsd: number, overallCacheRatio: number|null, byRole: Object }[],
 *   aggregate: { totalCostUsd: number, overallCacheRatio: number|null, totalSessions: number, byRole: Object }
 * }}
 */
export function aggregateAcrossArchives(archiveDescriptors, { role, since, last } = {}) {
  // Apply `last` filter: keep only the trailing N descriptors
  let descriptors = archiveDescriptors;
  if (last != null) {
    descriptors = descriptors.slice(-last);
  }

  const perArchive = [];
  const allNormalized = [];

  for (const archive of descriptors) {
    const rawEntries = loadArchiveSummary(archive);
    // Skip archives whose session-summary.json is missing or unparseable
    if (rawEntries === null) continue;
    const rawList = rawEntries;

    // Normalize on-disk shape → canonical shape
    let normalized = rawList
      .map(normalizeEntry)
      .filter((e) => e !== null);

    // Apply role filter
    if (role != null) {
      normalized = normalized.filter((e) => e.type === role);
    }

    // Apply since filter
    if (since != null) {
      normalized = normalized.filter((e) => (e.startedAt || '') >= since);
    }

    const sessionSumCost = normalized.reduce((sum, s) => sum + (s.totalCostUsd || 0), 0);
    let totalCostUsd;
    if (role == null && since == null) {
      const manifestTotal = loadArchiveManifestTotal(archive);
      totalCostUsd = manifestTotal !== null ? manifestTotal : sessionSumCost;
    } else {
      totalCostUsd = sessionSumCost;
    }
    const overallCacheRatio = computeOverallCacheRatio(normalized);
    const byRoleRaw = aggregateByRole(normalized);
    const byRole = enrichByRole(byRoleRaw, normalized);

    perArchive.push({
      id: archive.id,
      date: archive.date,
      sessionCount: normalized.length,
      totalCostUsd,
      overallCacheRatio,
      byRole,
    });

    allNormalized.push(...normalized);
  }

  // Aggregate across all archives — sum per-archive totalCostUsd values
  const aggregateTotalCostUsd = perArchive.reduce((sum, a) => sum + (a.totalCostUsd || 0), 0);
  const aggregateCacheRatio = computeOverallCacheRatio(allNormalized);
  const aggregateByRoleRaw = aggregateByRole(allNormalized);
  const aggregateByRoleEnriched = enrichByRole(aggregateByRoleRaw, allNormalized);

  return {
    archives: perArchive,
    aggregate: {
      totalCostUsd: aggregateTotalCostUsd,
      overallCacheRatio: aggregateCacheRatio,
      totalSessions: allNormalized.length,
      byRole: aggregateByRoleEnriched,
    },
  };
}
