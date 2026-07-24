import fs from 'fs';
import path from 'path';

/**
 * Format a currency value as a dollar string.
 * @param {number} v
 * @returns {string}
 */
function fmtCost(v) {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Format a percentage change string, guarding against zero denominators.
 * @param {number} from
 * @param {number} to
 * @returns {string}
 */
function fmtPct(from, to) {
  if (from === 0) return 'n/a';
  const pct = ((to - from) / Math.abs(from)) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(0)}%`;
}

/**
 * Format a numeric delta with sign.
 * @param {number} delta
 * @returns {string}
 */
function fmtDelta(delta) {
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta}`;
}

/**
 * Load manifest.json from archives/{id}/manifest.json.
 * Returns null if not found.
 *
 * @param {string} archivesDir
 * @param {string} id
 * @returns {object|null}
 */
function loadManifest(archivesDir, id) {
  const manifestPath = path.join(archivesDir, id, 'manifest.json');
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * List available archive IDs from the archives directory.
 * @param {string} archivesDir
 * @returns {string[]}
 */
function listArchiveIds(archivesDir) {
  try {
    return fs.readdirSync(archivesDir).filter((entry) => {
      const p = path.join(archivesDir, entry);
      return fs.statSync(p).isDirectory();
    });
  } catch {
    return [];
  }
}

/**
 * Derive mission count from milestones array.
 * Each milestone whose id looks like a mission root (e.g. '001') contributes.
 * Falls back to 'n/a' when milestones array is absent.
 *
 * For simplicity we expose the full milestone count and mark missions/tasks
 * as 'n/a' since the manifest schema only stores flat milestones without
 * a mission/task hierarchy distinction.
 *
 * @param {object} manifest
 * @returns {{ missions: string|number, tasks: string|number }}
 */
function deriveMissionTaskCounts(manifest) {
  if (!Array.isArray(manifest.milestones)) {
    return { missions: 'n/a', tasks: 'n/a' };
  }
  // The manifest stores flat milestones — no mission/task hierarchy.
  // Return n/a per spec ("derive from milestones array if available or show 'n/a'").
  return { missions: 'n/a', tasks: 'n/a' };
}

/**
 * Compare two archives and display (or return) the diff.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {string} idA - ID of the first (baseline) archive
 * @param {string} idB - ID of the second (comparison) archive
 * @param {object} [options={}]
 * @param {boolean} [options.json=false] - Output structured diff object instead of formatted text
 */
export function archiveDiff(projectRoot, idA, idB, options = {}) {
  const { json = false } = options;
  const archivesDir = path.join(projectRoot, 'archives');

  const manifestA = loadManifest(archivesDir, idA);
  const manifestB = loadManifest(archivesDir, idB);

  const missing = [];
  if (!manifestA) missing.push(idA);
  if (!manifestB) missing.push(idB);

  if (missing.length > 0) {
    for (const id of missing) {
      console.error(`Error: archive not found: ${id}`);
    }
    const available = listArchiveIds(archivesDir);
    if (available.length === 0) {
      console.error('No archives available.');
    } else {
      console.error('Available archive IDs:');
      for (const id of available) {
        console.error(`  ${id}`);
      }
    }
    return;
  }

  // Compute deltas
  const costA = manifestA.totalCost ?? 0;
  const costB = manifestB.totalCost ?? 0;
  const costDelta = costB - costA;

  const sessionsA = manifestA.totalSessions ?? 0;
  const sessionsB = manifestB.totalSessions ?? 0;
  const sessionsDelta = sessionsB - sessionsA;

  const milestonesA = Array.isArray(manifestA.milestones) ? manifestA.milestones.length : 0;
  const milestonesB = Array.isArray(manifestB.milestones) ? manifestB.milestones.length : 0;
  const milestonesDelta = milestonesB - milestonesA;

  const { missions: missionsA, tasks: tasksA } = deriveMissionTaskCounts(manifestA);
  const { missions: missionsB, tasks: tasksB } = deriveMissionTaskCounts(manifestB);

  if (json) {
    const diff = {
      a: idA,
      b: idB,
      cost: {
        a: costA,
        b: costB,
        delta: costDelta,
        pct: costA === 0 ? null : parseFloat(((costDelta / Math.abs(costA)) * 100).toFixed(2)),
      },
      sessions: {
        a: sessionsA,
        b: sessionsB,
        delta: sessionsDelta,
        pct: sessionsA === 0 ? null : parseFloat(((sessionsDelta / Math.abs(sessionsA)) * 100).toFixed(2)),
      },
      milestones: {
        a: milestonesA,
        b: milestonesB,
        delta: milestonesDelta,
        pct: milestonesA === 0 ? null : parseFloat(((milestonesDelta / Math.abs(milestonesA)) * 100).toFixed(2)),
      },
      missions: { a: missionsA, b: missionsB },
      tasks: { a: tasksA, b: tasksB },
      duration: 'n/a',
    };
    console.log(JSON.stringify(diff, null, 2));
    return diff;
  }

  // Formatted text output
  const lines = [];
  lines.push(`Archive diff: ${idA}  →  ${idB}`);
  lines.push('');

  // Cost  e.g. '$12.54 → $4.84 (-$7.70, -61%)'
  const costPctStr = fmtPct(costA, costB);
  const costDeltaStr = costDelta >= 0 ? `+${fmtCost(costDelta)}` : fmtCost(costDelta);
  lines.push(`Cost:       ${fmtCost(costA)} → ${fmtCost(costB)} (${costDeltaStr}, ${costPctStr})`);

  // Sessions
  const sessionsSign = sessionsDelta >= 0 ? '+' : '';
  const sessionsPctStr = fmtPct(sessionsA, sessionsB);
  lines.push(`Sessions:   ${sessionsA} → ${sessionsB} (${sessionsSign}${sessionsDelta}, ${sessionsPctStr})`);

  // Milestones
  const milestonesPctStr = fmtPct(milestonesA, milestonesB);
  lines.push(`Milestones: ${milestonesA} → ${milestonesB} (${fmtDelta(milestonesDelta)}, ${milestonesPctStr})`);

  // Missions / Tasks
  lines.push(`Missions:   ${missionsA} → ${missionsB}`);
  lines.push(`Tasks:      ${tasksA} → ${tasksB}`);

  // Duration placeholder
  lines.push(`Duration:   n/a`);

  console.log(lines.join('\n'));
}
