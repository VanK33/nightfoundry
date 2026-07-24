#!/usr/bin/env node
/**
 * analyze-overhead.js — Per-dispatch overhead analyzer.
 *
 * Reads session-summary.json from one or more .harness archives
 * (or the current .harness/logs/) and produces a breakdown of
 * per-session cost and duration by role, with specific attention to
 * cache-creation overhead that could be eliminated by session reuse.
 *
 * Usage (either invocation form works — script is executable):
 *   ./scripts/analyze-overhead.js                       # analyzes current .harness/logs/
 *   ./scripts/analyze-overhead.js archive 003           # analyzes archives/003-*
 *   ./scripts/analyze-overhead.js all                   # analyzes all archives
 *   ./scripts/analyze-overhead.js --json all            # JSON output instead of human
 *
 *   (or prefix with `node ` if you prefer)
 *
 * No Claude auth, no SDK. Pure fs + json.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { loadArchiveSummary, aggregateAcrossArchives } from '../src/orchestrator/infra/cross-archive-analyzer.js';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function findArchiveDirs(mode, filter) {
  const archivesDir = path.join(ROOT, 'archives');
  if (mode === 'current') {
    return [{ name: 'current', dir: path.join(ROOT, '.harness') }];
  }
  if (!fs.existsSync(archivesDir)) return [];
  const all = fs.readdirSync(archivesDir)
    .filter((d) => fs.statSync(path.join(archivesDir, d)).isDirectory())
    .sort()
    .map((d) => ({ name: d, dir: path.join(archivesDir, d) }));

  if (mode === 'all') return all;
  if (mode === 'archive') {
    return all.filter((a) => !filter || a.name.startsWith(filter));
  }
  return [];
}

/**
 * Adapter: loads sessions via loadArchiveSummary and builds the byRole shape
 * required by formatTable/formatJson.
 *
 * - totalCost is summed directly from raw session entries (not post-rounded totalCostUsd)
 * - avgCost, avgDurationMs, avgToolCalls derived from those raw sums
 * - estimateReuseSavings obtained from aggregateAcrossArchives (which uses enrichByRole)
 *
 * Returns { sessions, byRole } or null if session-summary.json is absent/malformed.
 */
function loadArchiveStats(archive) {
  const sessions = loadArchiveSummary(archive);
  if (!sessions) return null;

  // Build per-role stats by summing directly from raw sessions (un-rounded totalCost)
  const byRole = {};
  for (const s of sessions) {
    const role = s.role || (s.name || '').split('-')[0] || 'unknown';
    if (!byRole[role]) {
      byRole[role] = {
        role,
        count: 0,
        totalCost: 0,
        totalDurationMs: 0,
        totalCacheCreation: 0,
        totalCacheRead: 0,
        totalToolCalls: 0,
      };
    }
    const r = byRole[role];
    r.count += 1;
    r.totalCost += s.totalCost || 0;
    r.totalDurationMs += s.durationMs || 0;
    r.totalCacheCreation += s.cacheCreation || 0;
    r.totalCacheRead += s.cacheRead || 0;
    r.totalToolCalls += s.toolCalls || 0;
  }

  // Add averages
  for (const r of Object.values(byRole)) {
    r.avgCost = r.count > 0 ? r.totalCost / r.count : 0;
    r.avgDurationMs = r.count > 0 ? r.totalDurationMs / r.count : 0;
    r.avgToolCalls = r.count > 0 ? r.totalToolCalls / r.count : 0;
  }

  // Obtain estimateReuseSavings from aggregateAcrossArchives (uses enrichByRole internally)
  const aggResult = aggregateAcrossArchives([archive], {});
  const archiveByRole = (aggResult.archives[0] || {}).byRole || {};
  for (const [role, r] of Object.entries(byRole)) {
    const enriched = archiveByRole[role];
    r.estimateReuseSavings = enriched
      ? enriched.estimateReuseSavings
      : { avoidableCacheCreationTokens: 0, note: 'Only 0 or 1 session of this role; no reuse savings possible.' };
  }

  return { sessions, byRole };
}

function formatTable(archives) {
  const lines = [];
  lines.push('OVERHEAD AUDIT — Per-role breakdown across archives');
  lines.push('Source: .harness/archives/*/logs/session-summary.json');
  lines.push('');
  for (const archive of archives) {
    const stats = loadArchiveStats(archive);
    if (!stats) {
      lines.push(`### ${archive.name}: no session-summary.json`);
      continue;
    }

    const { sessions, byRole } = stats;
    lines.push(`## ${archive.name}  (${sessions.length} sessions)`);
    lines.push('');

    // Header
    lines.push(
      `  ${'role'.padEnd(22)}  ${'n'.padStart(4)}  ${'$total'.padStart(8)}  ` +
      `${'$/sess'.padStart(8)}  ${'s/sess'.padStart(8)}  ${'cacheCr'.padStart(10)}  ` +
      `${'cacheRd'.padStart(10)}  ${'avoidable'.padStart(10)}`
    );
    lines.push('  ' + '─'.repeat(96));

    const sortedRoles = Object.values(byRole).sort((a, b) => b.totalCost - a.totalCost);
    for (const r of sortedRoles) {
      const savings = r.estimateReuseSavings;
      lines.push(
        `  ${r.role.padEnd(22)}  ${String(r.count).padStart(4)}  ` +
        `${('$' + r.totalCost.toFixed(2)).padStart(8)}  ` +
        `${('$' + r.avgCost.toFixed(3)).padStart(8)}  ` +
        `${(r.avgDurationMs / 1000).toFixed(1).padStart(8)}  ` +
        `${r.totalCacheCreation.toLocaleString().padStart(10)}  ` +
        `${r.totalCacheRead.toLocaleString().padStart(10)}  ` +
        `${(savings.avoidableCacheCreationTokens || 0).toLocaleString().padStart(10)}`
      );
    }

    // Per-archive totals
    const total = sortedRoles.reduce((acc, r) => ({
      count: acc.count + r.count,
      cost: acc.cost + r.totalCost,
      cacheCr: acc.cacheCr + r.totalCacheCreation,
      cacheRd: acc.cacheRd + r.totalCacheRead,
      avoidable: acc.avoidable + (r.estimateReuseSavings.avoidableCacheCreationTokens || 0),
    }), { count: 0, cost: 0, cacheCr: 0, cacheRd: 0, avoidable: 0 });
    lines.push('  ' + '─'.repeat(96));
    lines.push(
      `  ${'TOTAL'.padEnd(22)}  ${String(total.count).padStart(4)}  ` +
      `${('$' + total.cost.toFixed(2)).padStart(8)}  ` +
      `${''.padStart(8)}  ${''.padStart(8)}  ` +
      `${total.cacheCr.toLocaleString().padStart(10)}  ` +
      `${total.cacheRd.toLocaleString().padStart(10)}  ` +
      `${total.avoidable.toLocaleString().padStart(10)}`
    );
    lines.push('');
  }
  return lines.join('\n');
}

function formatJson(archives) {
  const result = {};
  for (const archive of archives) {
    const stats = loadArchiveStats(archive);
    if (!stats) continue;
    const { sessions, byRole } = stats;
    const roles = {};
    for (const r of Object.values(byRole)) {
      const savings = r.estimateReuseSavings;
      roles[r.role] = {
        count: r.count,
        totalCost: Math.round(r.totalCost * 1000) / 1000,
        avgCost: Math.round(r.avgCost * 1000) / 1000,
        avgDurationS: Math.round(r.avgDurationMs / 100) / 10,
        totalCacheCreation: r.totalCacheCreation,
        totalCacheRead: r.totalCacheRead,
        avgToolCalls: Math.round(r.avgToolCalls * 10) / 10,
        estimatedReuseSavings: savings,
      };
    }
    result[archive.name] = { sessionCount: sessions.length, byRole: roles };
  }
  return JSON.stringify(result, null, 2);
}

// ── Main ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const nonFlagArgs = args.filter((a) => !a.startsWith('--'));

let mode, filter;
if (nonFlagArgs.length === 0) {
  mode = 'current';
} else if (nonFlagArgs[0] === 'current') {
  // Explicit `current` form. The usage header advertises this as
  // an acceptable argument, so parse it explicitly (otherwise it
  // falls through to the error branch — bug caught in Copilot review).
  mode = 'current';
} else if (nonFlagArgs[0] === 'all') {
  mode = 'all';
} else if (nonFlagArgs[0] === 'archive') {
  mode = 'archive';
  filter = nonFlagArgs[1];
} else {
  console.error('Usage: ./scripts/analyze-overhead.js [current|all|archive NNN] [--json]');
  process.exit(1);
}

const archives = findArchiveDirs(mode, filter);
if (archives.length === 0) {
  console.error('No archives found.');
  process.exit(1);
}

const output = jsonMode ? formatJson(archives) : formatTable(archives);
console.log(output);
