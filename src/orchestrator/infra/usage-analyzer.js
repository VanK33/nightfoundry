/**
 * usage-analyzer.js — Pure functions for analyzing session token/cost usage.
 *
 * Operates on session entry objects produced by TokenTracker. No I/O, no class —
 * all functions are stateless transformations over arrays of session entries.
 *
 * Public API:
 *   aggregateByRole(sessions) → Object<type, aggregateTotals>
 *   topNBySessionCost(sessions, n) → SessionEntry[]
 *   filterByRole(sessions, role) → SessionEntry[]
 *   filterByTaskId(sessions, taskId) → SessionEntry[]
 *   cacheEfficiency(sessions) → Object<role, { cacheCreation, cacheRead, ratio, verdict }>
 */

/**
 * Aggregate sessions grouped by their `type` field.
 * Returns a plain object keyed by type, each value mirroring TokenTracker._aggregate shape.
 *
 * @param {Array} sessions - Array of SessionEntry objects
 * @returns {Object<string, Object>} Plain object keyed by session type, each value containing summed token/cost totals
 */
export function aggregateByRole(sessions) {
  const map = {};
  for (const s of sessions) {
    const role = s.type;
    if (!map[role]) {
      map[role] = { sessionCount: 0, inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0, totalCostUsd: 0 };
    }
    map[role].sessionCount += 1;
    map[role].inputTokens += s.inputTokens || 0;
    map[role].outputTokens += s.outputTokens || 0;
    map[role].cacheCreation += s.cacheCreation || 0;
    map[role].cacheRead += s.cacheRead || 0;
    map[role].totalCostUsd += s.totalCostUsd || 0;
  }
  for (const role of Object.keys(map)) {
    map[role].totalCostUsd = Math.round(map[role].totalCostUsd * 1000) / 1000;
  }
  return map;
}

/**
 * Return the top-n session entries sorted descending by totalCostUsd.
 *
 * @param {Array} sessions - Array of SessionEntry objects
 * @param {number} n - Maximum number of entries to return
 * @returns {Array} Up to n SessionEntry objects ordered by descending totalCostUsd
 */
export function topNBySessionCost(sessions, n) {
  return sessions.slice().sort((a, b) => (b.totalCostUsd || 0) - (a.totalCostUsd || 0)).slice(0, n);
}

/**
 * Return only sessions whose `type` matches the given role.
 *
 * @param {Array} sessions - Array of SessionEntry objects
 * @param {string} role - The type value to filter by
 * @returns {Array} Filtered SessionEntry objects
 */
export function filterByRole(sessions, role) {
  return sessions.filter((s) => s.type === role);
}

/**
 * Return only sessions whose `taskId` matches the given taskId.
 *
 * @param {Array} sessions - Array of SessionEntry objects
 * @param {string} taskId - The taskId value to filter by
 * @returns {Array} Filtered SessionEntry objects
 */
export function filterByTaskId(sessions, taskId) {
  return sessions.filter((s) => s.taskId === taskId);
}

/**
 * Classify a cache read/creation ratio into a human-readable verdict.
 *
 * Thresholds:
 *   >= 3.0 → "excellent"
 *   >= 1.0 → "healthy"
 *   >= 0.3 → "marginal"
 *   <  0.3 → "wasteful"
 *
 * @param {number} ratio - cacheRead / cacheCreation
 * @returns {string} One of: "excellent" | "healthy" | "marginal" | "wasteful"
 */
export function classifyRatio(ratio) {
  if (ratio >= 3.0) return 'excellent';
  if (ratio >= 1.0) return 'healthy';
  if (ratio >= 0.3) return 'marginal';
  return 'wasteful';
}

/**
 * Compute per-role cache read/creation ratios and efficiency verdicts.
 *
 * For each role (session type), sums cacheCreation and cacheRead across all
 * sessions, computes ratio = cacheRead / cacheCreation, and classifies via
 * classifyRatio. If cacheCreation is zero the verdict is "n/a" and ratio is null.
 *
 * @param {Array} sessions - Array of SessionEntry objects
 * @returns {Object<string, { cacheCreation: number, cacheRead: number, ratio: number|null, verdict: string }>}
 */
export function cacheEfficiency(sessions) {
  const map = {};
  for (const s of sessions) {
    const role = s.type;
    if (!map[role]) {
      map[role] = { cacheCreation: 0, cacheRead: 0 };
    }
    map[role].cacheCreation += s.cacheCreation || 0;
    map[role].cacheRead += s.cacheRead || 0;
  }
  const result = {};
  for (const role of Object.keys(map)) {
    const { cacheCreation, cacheRead } = map[role];
    if (cacheCreation === 0) {
      result[role] = { cacheCreation, cacheRead, ratio: null, verdict: 'n/a' };
    } else {
      const ratio = cacheRead / cacheCreation;
      result[role] = { cacheCreation, cacheRead, ratio, verdict: classifyRatio(ratio) };
    }
  }
  return result;
}
