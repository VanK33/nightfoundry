import fs from 'fs';
import path from 'path';
import { TokenTracker } from '../../orchestrator/infra/token-tracker.js';
import {
  aggregateByRole,
  topNBySessionCost,
  filterByRole,
  filterByTaskId,
  cacheEfficiency,
} from '../../orchestrator/infra/usage-analyzer.js';
import config from '../../orchestrator/infra/config.js';
import {
  enumerateArchives,
  aggregateAcrossArchives,
} from '../../orchestrator/infra/cross-archive-analyzer.js';
import { activeHarnessDir } from '../../orchestrator/core/run-context.js';

/**
 * Compute the overall cache efficiency ratio across all sessions:
 *   sum(cacheRead) / sum(cacheCreation), or null if cacheCreation is 0.
 *
 * @param {Array} sessions
 * @returns {number|null}
 */
function _overallCacheRatio(sessions) {
  let totalCreation = 0;
  let totalRead = 0;
  for (const s of sessions) {
    totalCreation += s.cacheCreation || 0;
    totalRead += s.cacheRead || 0;
  }
  if (totalCreation === 0) return null;
  return totalRead / totalCreation;
}

/**
 * Render a 3-line run cost summary to stdout, plus optional warnings for
 * sessions that breach configured alert thresholds.
 *
 * Line 1: Run cost: $X.XX • N sessions • Y.Zx cache efficiency
 * Line 2: (blank separator)
 * Line 3+: warnings when thresholds are breached
 *
 * @param {TokenTracker} tracker
 * @param {number} runStartSessionCount - session index marking start of this run
 * @param {object} [opts={}]
 * @param {object} [opts.alerts] - override alert thresholds (defaults to config.alerts)
 */
export function renderRunCostSummary(tracker, runStartSessionCount, opts = {}) {
  const runTotals = tracker.getUsageSince(runStartSessionCount);
  const runSessions = tracker._sessions.slice(runStartSessionCount);
  const sessionCount = runSessions.length;

  const overallRatio = _overallCacheRatio(runSessions);
  const ratioStr = overallRatio !== null ? `${overallRatio.toFixed(1)}x` : 'n/a';

  const costStr = `$${Number(runTotals.totalCostUsd).toFixed(2)}`;

  console.log(`Run cost: ${costStr} • ${sessionCount} sessions • ${ratioStr} cache efficiency`);

  // Alert thresholds
  const alerts = opts.alerts || config.alerts || {};
  const maxToolCalls = alerts.maxToolCallsPerSession;
  const minCacheEff = alerts.minCacheEfficiency;

  // Check per-session toolCallCount threshold
  if (maxToolCalls !== undefined) {
    const breached = runSessions.filter((s) => (s.toolCallCount || 0) > maxToolCalls);
    if (breached.length > 0) {
      const names = breached.map((s) => s.name || s.type || '(unknown)').join(', ');
      console.warn(`⚠ Tool call limit exceeded (>${maxToolCalls}) in sessions: ${names}`);
    }
  }

  // Check per-role cache efficiency threshold
  if (minCacheEff !== undefined) {
    const effByRole = cacheEfficiency(runSessions);
    for (const [role, eff] of Object.entries(effByRole)) {
      if (eff.ratio !== null && eff.ratio < minCacheEff) {
        console.warn(`⚠ Cache efficiency below threshold (<${minCacheEff}x) for role: ${role} (ratio=${eff.ratio.toFixed(2)})`);
      }
    }
  }
}

/**
 * Render a single-line cost summary for small-task mode.
 *
 * Format: "[$X.XX | N sessions | Y.Zx cache]"
 *
 * @param {TokenTracker} tracker
 * @param {number} runStartSessionCount - session index marking start of this run
 */
export function renderSmallTaskCostSummary(tracker, runStartSessionCount) {
  const runTotals = tracker.getUsageSince(runStartSessionCount);
  const runSessions = tracker._sessions.slice(runStartSessionCount);
  const sessionCount = runSessions.length;

  const overallRatio = _overallCacheRatio(runSessions);
  const ratioStr = overallRatio !== null ? `${overallRatio.toFixed(1)}x cache` : 'n/a cache';

  const costStr = `$${Number(runTotals.totalCostUsd).toFixed(2)}`;

  console.log(`[${costStr} | ${sessionCount} sessions | ${ratioStr}]`);
}

const MAX_ID = 20;

/**
 * Aggregate token usage across multiple archives and emit a summary.
 *
 * @param {string} projectRoot
 * @param {object} [options={}]
 * @param {boolean} [options.json]
 * @param {string}  [options.role]
 * @param {string}  [options.since]
 * @param {number}  [options.last]
 * @param {boolean} [options.includeFailed] - When false (default), archives whose id starts with 'failed-' are excluded
 */
export function usageAll(projectRoot, options = {}) {
  const { json = false, role, since, last, includeFailed = false } = options;
  const archivesDir = path.join(projectRoot, 'archives');

  // Enumerate and sort descriptors chronologically (by date string, ascending)
  let descriptors = enumerateArchives(archivesDir);
  descriptors = [...descriptors].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Filter out failed archives unless includeFailed is true
  if (!includeFailed) {
    descriptors = descriptors.filter((d) => !d.id.startsWith('failed-'));
  }

  // Apply since filter: drop descriptors whose date string is before `since`
  if (since) {
    descriptors = descriptors.filter((d) => d.date >= since);
  }

  // Apply last filter: keep only the last N descriptors after sort
  if (last !== undefined && last !== null) {
    const n = Number(last);
    if (n > 0) {
      descriptors = descriptors.slice(-n);
    }
  }

  const result = aggregateAcrossArchives(descriptors, { role, since, last });

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2));
    return;
  }

  // Text mode: emit chronological table
  console.log('Archive              | Date       | Sessions | Total Cost | Cache | Top-3 Roles');
  console.log('-'.repeat(90));

  for (const arch of result.archives) {
    // Truncate archive id to MAX_ID chars
    const label = arch.id.length > MAX_ID ? arch.id.slice(0, MAX_ID) + '…' : arch.id;

    // Cache ratio: reuse same vocabulary as _overallCacheRatio formatting
    const cacheStr = arch.overallCacheRatio !== null && arch.overallCacheRatio !== undefined
      ? `${Number(arch.overallCacheRatio).toFixed(1)}x`
      : 'n/a';

    // Top-3 roles by totalCostUsd from per-archive byRole
    const byRole = arch.byRole || {};
    const top3 = Object.entries(byRole)
      .sort((a, b) => (b[1].totalCostUsd || 0) - (a[1].totalCostUsd || 0))
      .slice(0, 3)
      .map(([k]) => k)
      .join(',');

    const costStr = `$${Number(arch.totalCostUsd).toFixed(2)}`;
    console.log(
      `${label.padEnd(20)} | ${arch.date || ''} | ${String(arch.sessionCount).padStart(8)} | ${costStr.padStart(10)} | ${cacheStr.padStart(5)} | ${top3}`
    );
  }

  // Trailing aggregate summary block
  const agg = result.aggregate;
  const aggCacheStr = agg.overallCacheRatio !== null && agg.overallCacheRatio !== undefined
    ? `${Number(agg.overallCacheRatio).toFixed(1)}x`
    : 'n/a';

  console.log('\n--- Aggregate ---');
  console.log(`Archives: ${result.archives.length}`);
  console.log(`Sessions: ${agg.totalSessions}`);
  console.log(`Total cost: $${Number(agg.totalCostUsd).toFixed(2)}`);
  console.log(`Cache efficiency: ${aggCacheStr}`);
}

export function usage(projectRoot, options = {}) {
  // Branch to usageAll when --all is set, OR when --include-failed is set on its
  // own: the include-failed filter only lives in the cross-archive path, so
  // without --all the flag would be silently ignored. Auto-imply --all so the
  // flag actually filters the cross-archive aggregator (min-surprise; the user's
  // intent — cumulative-with-failures — is unambiguous).
  if (options.all || options.includeFailed) {
    usageAll(projectRoot, options);
    return;
  }

  const { json = false, detailed = false, role, task, runStartSessionCount } = options;
  const harnessDir = activeHarnessDir(projectRoot);
  const tracker = new TokenTracker(harnessDir);

  // Apply optional filters up-front so every output mode (legacy JSON,
  // detailed JSON, text) sees the same filtered session list. Previously
  // the json && !detailed path early-returned before filters were applied,
  // so `--role` / `--task` were silently ignored in that mode.
  let sessions = tracker._sessions;
  if (role) sessions = filterByRole(sessions, role);
  if (task) sessions = filterByTaskId(sessions, task);

  // Compute aggregate views over the (possibly filtered) session list.
  // byRole is dynamic over whatever session types are present, so legacy
  // JSON, detailed JSON, and text all report the same role set — the
  // previous legacy JSON path hard-coded planner/executor/verifier and
  // diverged from the text path's aggregateByRole view.
  const totals = tracker._aggregate(sessions);
  const summary = { totalSessions: sessions.length, ...totals };
  const byRole = aggregateByRole(sessions);
  const topSessions = topNBySessionCost(sessions, 10);
  const cacheEff = cacheEfficiency(sessions);

  // Back-compat JSON shape for `--json` without `--detailed`:
  // { totalSessions, ...totals, byType }. byType is now sourced from
  // byRole (dynamic) so analyzer/summarizer sessions show up alongside
  // planner/executor/verifier when present. Consumers that reached into
  // byType.planner / .executor / .verifier still work because those keys
  // continue to appear whenever those session types exist.
  if (json && !detailed) {
    const legacy = { totalSessions: sessions.length, ...totals, byType: byRole, cacheEfficiency: cacheEff };
    process.stdout.write(JSON.stringify(legacy, null, 2));
    return;
  }

  // JSON + detailed: emit structured object
  if (json && detailed) {
    process.stdout.write(JSON.stringify({ summary, byRole, topSessions, cacheEfficiency: cacheEff }, null, 2));
    return;
  }

  // Text output: optional 'This run' block when runStartSessionCount is provided
  if (runStartSessionCount !== undefined) {
    const runTotals = tracker.getUsageSince(runStartSessionCount);
    const runSessionCount = tracker._sessions.length - runStartSessionCount;
    console.log('\n--- This Run ---');
    console.log(`  Sessions: ${runSessionCount}`);
    console.log(`  Input tokens: ${runTotals.inputTokens.toLocaleString()}`);
    console.log(`  Output tokens: ${runTotals.outputTokens.toLocaleString()}`);
    console.log(`  Total cost: $${runTotals.totalCostUsd}`);
  }

  // Text output: always emit the legacy summary block (back-compat)
  console.log('\n--- Token Usage ---');
  console.log(`  Sessions: ${summary.totalSessions}`);
  console.log(`  Input tokens: ${summary.inputTokens.toLocaleString()}`);
  console.log(`  Output tokens: ${summary.outputTokens.toLocaleString()}`);
  console.log(`  Cache (create/read): ${summary.cacheCreation.toLocaleString()} / ${summary.cacheRead.toLocaleString()}`);
  console.log(`  sys_prompt≈: ${(summary.systemPromptTokens || 0).toLocaleString()}  tool_calls: ${summary.toolCallCount || 0}`);
  console.log(`  Total cost: $${summary.totalCostUsd}`);

  // byType lines (back-compat: skip roles with zero sessions)
  for (const [type, data] of Object.entries(byRole)) {
    if (data.sessionCount > 0) {
      console.log(`  ${type}: ${data.sessionCount} sessions, $${data.totalCostUsd}`);
    }
  }

  // Cache Efficiency section
  console.log('\n--- Cache Efficiency ---');
  for (const [role, eff] of Object.entries(cacheEff)) {
    const ratioStr = eff.ratio !== null ? eff.ratio.toFixed(2) : 'n/a';
    console.log(`  ${role}: ratio=${ratioStr}  verdict=${eff.verdict}`);
  }

  if (!detailed) return;

  // Per-role breakdown table
  console.log('\n--- By Role ---');
  const rHeader =
    'Role'.padEnd(12) +
    'Sessions'.padStart(10) +
    'Input'.padStart(14) +
    'Output'.padStart(14) +
    'Cost'.padStart(12);
  console.log(rHeader);
  for (const [r, data] of Object.entries(byRole)) {
    const line =
      r.padEnd(12) +
      String(data.sessionCount).padStart(10) +
      String(data.inputTokens).padStart(14) +
      String(data.outputTokens).padStart(14) +
      `$${data.totalCostUsd}`.padStart(12);
    console.log(line);
  }

  // Top-10 sessions table
  console.log('\n--- Top Sessions by Cost ---');
  const sHeader =
    'Name'.padEnd(30) +
    'Role'.padEnd(12) +
    'TaskId'.padEnd(22) +
    'Input'.padStart(10) +
    'Output'.padStart(10) +
    'Cost'.padStart(10);
  console.log(sHeader);
  for (const s of topSessions) {
    const line =
      (typeof s.turnIdx === 'number' ? (s.name || '') + ` (turn ${s.turnIdx})` : (s.name || '')).padEnd(30) +
      (s.type || '').padEnd(12) +
      (s.taskId || '').padEnd(22) +
      String(s.inputTokens || 0).padStart(10) +
      String(s.outputTokens || 0).padStart(10) +
      `$${s.totalCostUsd || 0}`.padStart(10);
    console.log(line);
  }
}

/**
 * Load token-usage.json from a given archive directory.
 * Returns null if the file cannot be read or parsed.
 *
 * @param {string} archivesDir
 * @param {string} archiveId
 * @returns {object|null}
 */
function loadTokenUsage(archivesDir, archiveId) {
  const filePath = path.join(archivesDir, archiveId, 'logs', 'token-usage.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Collect all unique field names from an array of session entries.
 * @param {Array} sessions
 * @returns {Set<string>}
 */
function sessionFields(sessions) {
  const fields = new Set();
  for (const s of sessions) {
    for (const k of Object.keys(s)) {
      fields.add(k);
    }
  }
  return fields;
}

/**
 * Format a signed delta with explicit + sign for non-negatives.
 * @param {number} delta
 * @returns {string}
 */
function fmtDelta(delta) {
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toLocaleString()}`;
}

/**
 * Format a signed cost delta.
 * @param {number} delta
 * @returns {string}
 */
function fmtCostDelta(delta) {
  const abs = Math.abs(delta).toFixed(2);
  const sign = delta >= 0 ? '+' : '-';
  return `${sign}$${abs}`;
}

/**
 * Compare two archived token-usage.json files and print a diff table.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {string} archiveA - ID of the first (baseline) archive
 * @param {string} archiveB - ID of the second (comparison) archive
 * @param {object} [options={}]
 */
export function compare(projectRoot, archiveA, archiveB, options = {}) {
  const archivesDir = path.join(projectRoot, 'archives');

  const usageA = loadTokenUsage(archivesDir, archiveA);
  const usageB = loadTokenUsage(archivesDir, archiveB);

  // Handle missing archives gracefully
  const missing = [];
  if (!usageA) missing.push(archiveA);
  if (!usageB) missing.push(archiveB);

  if (missing.length > 0) {
    for (const id of missing) {
      console.error(`Error: token-usage.json not found for archive: ${id}`);
    }
    return;
  }

  const sessionsA = Array.isArray(usageA.sessions) ? usageA.sessions : [];
  const sessionsB = Array.isArray(usageB.sessions) ? usageB.sessions : [];

  // Schema-drift detection: warn when one side has fields the other lacks
  const fieldsA = sessionFields(sessionsA);
  const fieldsB = sessionFields(sessionsB);
  const onlyInA = [...fieldsA].filter((f) => !fieldsB.has(f));
  const onlyInB = [...fieldsB].filter((f) => !fieldsA.has(f));
  if (onlyInA.length > 0 || onlyInB.length > 0) {
    console.warn('Warning: schema drift detected between archives.');
    if (onlyInA.length > 0) {
      console.warn(`  Fields only in ${archiveA}: ${onlyInA.join(', ')}`);
    }
    if (onlyInB.length > 0) {
      console.warn(`  Fields only in ${archiveB}: ${onlyInB.join(', ')}`);
    }
  }

  // Run aggregations on both sides
  const byRoleA = aggregateByRole(sessionsA);
  const byRoleB = aggregateByRole(sessionsB);
  const cacheEffA = cacheEfficiency(sessionsA);
  const cacheEffB = cacheEfficiency(sessionsB);

  // Compute totals from the stored totals field (fallback: aggregate from sessions)
  const totA = usageA.totals || {};
  const totB = usageB.totals || {};

  const sessionCountA = totA.sessionCount ?? sessionsA.length;
  const sessionCountB = totB.sessionCount ?? sessionsB.length;
  const inputA = totA.inputTokens ?? sessionsA.reduce((s, e) => s + (e.inputTokens || 0), 0);
  const inputB = totB.inputTokens ?? sessionsB.reduce((s, e) => s + (e.inputTokens || 0), 0);
  const outputA = totA.outputTokens ?? sessionsA.reduce((s, e) => s + (e.outputTokens || 0), 0);
  const outputB = totB.outputTokens ?? sessionsB.reduce((s, e) => s + (e.outputTokens || 0), 0);
  const costA = totA.totalCostUsd ?? sessionsA.reduce((s, e) => s + (e.totalCostUsd || 0), 0);
  const costB = totB.totalCostUsd ?? sessionsB.reduce((s, e) => s + (e.totalCostUsd || 0), 0);
  const cacheCreationA = totA.cacheCreation ?? sessionsA.reduce((s, e) => s + (e.cacheCreation || 0), 0);
  const cacheCreationB = totB.cacheCreation ?? sessionsB.reduce((s, e) => s + (e.cacheCreation || 0), 0);
  const cacheReadA = totA.cacheRead ?? sessionsA.reduce((s, e) => s + (e.cacheRead || 0), 0);
  const cacheReadB = totB.cacheRead ?? sessionsB.reduce((s, e) => s + (e.cacheRead || 0), 0);

  // Truncate archive IDs for display (keep first 20 chars)
  const MAX_ID = 20;
  const labelA = archiveA.length > MAX_ID ? archiveA.slice(0, MAX_ID) + '…' : archiveA;
  const labelB = archiveB.length > MAX_ID ? archiveB.slice(0, MAX_ID) + '…' : archiveB;

  // Print diff table
  console.log(`\n--- Usage Compare ---`);
  console.log(`  A: ${archiveA}`);
  console.log(`  B: ${archiveB}`);
  console.log('');

  const col0 = 20;
  const col1 = 14;
  const col2 = 14;
  const col3 = 14;

  const header =
    'Metric'.padEnd(col0) +
    'A'.padStart(col1) +
    'B'.padStart(col2) +
    'Delta'.padStart(col3);
  console.log(header);
  console.log('-'.repeat(col0 + col1 + col2 + col3));

  const row = (label, a, b, deltaStr) =>
    label.padEnd(col0) +
    String(a).padStart(col1) +
    String(b).padStart(col2) +
    deltaStr.padStart(col3);

  console.log(row('Sessions', sessionCountA, sessionCountB, fmtDelta(sessionCountB - sessionCountA)));
  console.log(row('Input tokens', inputA.toLocaleString(), inputB.toLocaleString(), fmtDelta(inputB - inputA)));
  console.log(row('Output tokens', outputA.toLocaleString(), outputB.toLocaleString(), fmtDelta(outputB - outputA)));
  console.log(row('Cache creation', cacheCreationA.toLocaleString(), cacheCreationB.toLocaleString(), fmtDelta(cacheCreationB - cacheCreationA)));
  console.log(row('Cache read', cacheReadA.toLocaleString(), cacheReadB.toLocaleString(), fmtDelta(cacheReadB - cacheReadA)));
  console.log(row('Total cost', `$${Number(costA).toFixed(2)}`, `$${Number(costB).toFixed(2)}`, fmtCostDelta(costB - costA)));

  // Cache efficiency comparison table
  console.log('\n--- Cache Efficiency ---');
  const effCol0 = 14;
  const effCol1 = 18;
  const effCol2 = 18;
  console.log(
    'Role'.padEnd(effCol0) +
    'A'.padStart(effCol1) +
    'B'.padStart(effCol2)
  );
  console.log('-'.repeat(effCol0 + effCol1 + effCol2));

  const allRoles = new Set([...Object.keys(cacheEffA), ...Object.keys(cacheEffB)]);
  for (const role of allRoles) {
    const a = cacheEffA[role] || { ratio: null, verdict: 'n/a' };
    const b = cacheEffB[role] || { ratio: null, verdict: 'n/a' };
    const cellA = a.ratio !== null ? `${a.ratio.toFixed(1)}x ${a.verdict}` : 'n/a';
    const cellB = b.ratio !== null ? `${b.ratio.toFixed(1)}x ${b.verdict}` : 'n/a';
    console.log(
      role.padEnd(effCol0) +
      cellA.padStart(effCol1) +
      cellB.padStart(effCol2)
    );
  }
}
