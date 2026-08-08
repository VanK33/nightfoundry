/**
 * run-report.js — Core data-gathering for run reports.
 *
 * Public API:
 *   gatherReportData(archiveDir, projectRoot, deps?) → plain data object
 *
 * Reads manifest.json, spec.md, token-usage.json, review-milestone-*.json,
 * and state/mission-*.json from archiveDir, plus calls getDiffSummary to
 * produce a git diff summary relative to the previous archive.
 *
 * All missing files are handled gracefully (returns defaults/empty values).
 */

import fs from 'fs';
import path from 'path';
import { aggregateByRole } from './usage-analyzer.js';
import { getDiffSummary } from '../../cli/commands/archive.js';

/**
 * Extract the text under the `## Goal` section from a spec markdown string.
 * Returns the content between `## Goal` and the next `##`-level heading (or EOF).
 *
 * @param {string} specContent - Raw markdown text
 * @returns {string|null} Goal text (trimmed) or null if section not found
 */
export function extractGoalFromSpec(specContent) {
  // Match ## Goal heading then capture everything until next ## heading or end.
  // JS regex has no \z anchor; (?![\s\S]) is a negative lookahead that only
  // succeeds at end-of-input, which is what we want here. Plain $ would match
  // end-of-line under /m and truncate multi-line goals at their first newline.
  const match = specContent.match(/^##\s+Goal\s*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/m);
  if (!match) return null;
  const text = match[1].trim();
  return text.length > 0 ? text : null;
}

/**
 * Gather all data needed to render a run report for an archived run.
 *
 * @param {string} archiveDir   - Absolute path to the archive directory (e.g. archives/001-...)
 * @param {string} projectRoot  - Absolute path to the project root (used for getDiffSummary)
 * @param {object} [deps={}]    - Injectable deps: { getDiffSummary }
 * @returns {object} Plain data object with all report fields
 */
export function gatherReportData(archiveDir, projectRoot, deps = {}) {
  const _getDiffSummary = deps.getDiffSummary ?? getDiffSummary;

  // ── Manifest ─────────────────────────────────────────────────────────────
  let seq = '';
  let headline = '';
  let archivedAt = '';
  let totalCost = 0;
  let totalSessions = 0;
  let milestones = [];
  let changelog = [];

  const manifestPath = path.join(archiveDir, 'manifest.json');
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    seq = manifest.seq ?? '';
    headline = manifest.headline ?? '';
    archivedAt = manifest.archivedAt ?? '';
    totalCost = manifest.totalCost ?? 0;
    totalSessions = manifest.totalSessions ?? 0;
    milestones = manifest.milestones ?? [];
    changelog = manifest.changelog ?? [];
  } catch {
    // manifest missing or unparseable — keep defaults
  }

  // ── Goal from spec.md ─────────────────────────────────────────────────────
  let goal = '(no goal found)';
  const specPath = path.join(archiveDir, 'spec.md');
  try {
    const specContent = fs.readFileSync(specPath, 'utf8');
    const extracted = extractGoalFromSpec(specContent);
    if (extracted) goal = extracted;
  } catch {
    // spec.md missing — keep default
  }

  // ── Token usage & per-type cost breakdown ─────────────────────────────────
  let costByType = {};
  const tokenUsagePath = path.join(archiveDir, 'logs', 'token-usage.json');
  try {
    const raw = fs.readFileSync(tokenUsagePath, 'utf8');
    const data = JSON.parse(raw);
    const sessions = data.sessions ?? [];
    costByType = aggregateByRole(sessions);
  } catch {
    // token-usage.json missing or unparseable — keep defaults
  }

  // ── Reviewer findings from verification/review-milestone-*.json ───────────
  let findings = [];
  const verificationDir = path.join(archiveDir, 'verification');
  try {
    const entries = fs.readdirSync(verificationDir);
    const reviewFiles = entries
      .filter((e) => /^review-milestone-.*\.json$/.test(e))
      .sort();
    for (const file of reviewFiles) {
      try {
        const raw = fs.readFileSync(path.join(verificationDir, file), 'utf8');
        const review = JSON.parse(raw);
        const relevant = (review.findings ?? []).filter(
          (f) => f.severity === 'critical' || f.severity === 'warning' || f.severity === 'info',
        );
        findings = findings.concat(relevant);
      } catch {
        // skip unreadable review file
      }
    }
  } catch {
    // verification dir missing — keep empty findings
  }

  // ── Task statuses from state/mission-*.json ───────────────────────────────
  let taskStatuses = [];
  const stateDir = path.join(archiveDir, 'state');
  try {
    const entries = fs.readdirSync(stateDir);
    const missionFiles = entries
      .filter((e) => /^mission-.*\.json$/.test(e))
      .sort();
    for (const file of missionFiles) {
      try {
        const raw = fs.readFileSync(path.join(stateDir, file), 'utf8');
        const mission = JSON.parse(raw);
        taskStatuses.push({
          id: mission.id ?? file,
          description: mission.description ?? '',
          status: mission.status ?? 'unknown',
        });
      } catch {
        // skip unreadable mission file
      }
    }
  } catch {
    // state dir missing — keep empty taskStatuses
  }

  // ── Git diff summary ──────────────────────────────────────────────────────
  // archiveDir is e.g. archives/001-..., archivesDir is archives/. The new
  // archive's manifest.json has already been written with the current HEAD as
  // gitHead, so we exclude it from getDiffSummary's "highest-seq" scan —
  // otherwise the diff degenerates to `git diff HEAD..HEAD` and renders as
  // "First run — no diff baseline" on every run after the first.
  const archivesDir = path.dirname(archiveDir);
  const currentArchiveId = path.basename(archiveDir);
  let diffSummary = '';
  try {
    diffSummary = _getDiffSummary(projectRoot, archivesDir, { excludeArchiveId: currentArchiveId }) ?? '';
  } catch {
    diffSummary = '';
  }

  return {
    seq,
    headline,
    archivedAt,
    totalCost,
    totalSessions,
    milestones,
    changelog,
    goal,
    costByType,
    findings,
    taskStatuses,
    diffSummary,
  };
}

/**
 * Render an HTML string for the run report.
 *
 * @param {object} data - Data object returned by gatherReportData()
 * @returns {string} Full HTML document string
 */
export function renderReportHtml(data) {
  const {
    seq = '',
    headline = '',
    archivedAt = '',
    totalCost = 0,
    totalSessions = 0,
    milestones = [],
    goal = '',
    costByType = {},
    findings = [],
    taskStatuses = [],
    diffSummary = '',
    changelog = [],
  } = data;

  const archiveId = seq ? `Run #${seq}` : 'Run Report';
  const costFormatted = `$${totalCost.toFixed(2)}`;
  const dateFormatted = archivedAt ? new Date(archivedAt).toLocaleString() : '';

  // Diff / changelog section
  const diffSection = diffSummary
    ? `<pre class="diff-stats">${escapeHtml(diffSummary)}</pre>`
    : '<p class="first-run">First run — no diff baseline</p>';

  // Findings section
  const criticalFindings = findings.filter((f) => f.severity === 'critical');
  const warningFindings = findings.filter((f) => f.severity === 'warning');
  const infoFindings = findings.filter((f) => f.severity === 'info');

  const renderFinding = (f) => `
    <div class="finding finding-${escapeHtml(f.severity)}">
      <span class="finding-severity">${escapeHtml(f.severity.toUpperCase())}</span>
      <span class="finding-category">${escapeHtml(f.category || '')}</span>
      <p>${escapeHtml(f.description || '')}</p>
      ${f.file ? `<code>${escapeHtml(f.file)}</code>` : ''}
    </div>`;

  const findingsHtml = findings.length > 0
    ? `<section class="findings">
      <h2>Reviewer Findings</h2>
      ${criticalFindings.map(renderFinding).join('')}
      ${warningFindings.map(renderFinding).join('')}
      ${infoFindings.map(renderFinding).join('')}
    </section>`
    : '';

  // Milestones section
  const milestonesHtml = milestones.length > 0
    ? `<ul>${milestones.map((m) => `<li><strong>${escapeHtml(m.id || '')}</strong>: ${escapeHtml(m.description || '')} (${escapeHtml(m.status || '')})</li>`).join('')}</ul>`
    : '<p>No milestones</p>';

  // Task statuses grouped by sub-mission
  const tasksBySubMission = {};
  for (const task of taskStatuses) {
    const parts = String(task.id).split('-');
    const subMission = parts.length > 1 ? parts.slice(0, -1).join('-') : task.id;
    if (!tasksBySubMission[subMission]) tasksBySubMission[subMission] = [];
    tasksBySubMission[subMission].push(task);
  }

  const taskStatusesHtml = Object.entries(tasksBySubMission).length > 0
    ? Object.entries(tasksBySubMission).map(([subMission, tasks]) =>
        `<div class="sub-mission">
          <h3>${escapeHtml(subMission)}</h3>
          <ul>
            ${tasks.map((t) => `<li><code>${escapeHtml(t.id)}</code> — <span class="task-status task-status-${escapeHtml(t.status)}">${escapeHtml(t.status)}</span>${t.description ? `: ${escapeHtml(t.description)}` : ''}</li>`).join('')}
          </ul>
        </div>`
      ).join('')
    : '<p>No tasks recorded.</p>';

  // Cost by type
  const costByTypeHtml = Object.entries(costByType).map(([type, agg]) =>
    `<tr><td>${escapeHtml(type)}</td><td>${agg.sessionCount}</td><td>$${(agg.totalCostUsd || 0).toFixed(2)}</td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Run Report: ${escapeHtml(archiveId)}</title>
  <style>
    /* ──────────────────────────────────────────────────────────────────────
       palette mirrors src/ui/public/tokens.css — keep in sync
       (self-contained report: no external stylesheet, hex literals OK here;
       the theme-tokens gate only scans src/ui/public/*)
       ────────────────────────────────────────────────────────────────────── */
    :root {
      --bg: #0E1116;
      --surface: #151B23;
      --surface-2: #1C242E;
      --border: #27303C;
      --text: #E6EDF3;
      --text-2: #98A5B3;
      --text-3: #5E6A76;
      --accent: #E8853D;
      --accent-hover: #F09A55;
      --ok: #3FB950;
      --fail: #F85149;
      --warn: #D29922;
      --info: #58A6FF;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
      --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: var(--font-ui); font-size: 15px; line-height: 1.5; color: var(--text); background: var(--bg); margin: 0; padding: 24px; }
    .numeric, .diff-stats, .stat-value, td, .finding code, .sub-mission .task-id { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .container { max-width: 960px; margin: 0 auto; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .header { background: var(--surface-2); color: var(--text); padding: 24px 28px; border-bottom: 1px solid var(--border); border-left: 3px solid var(--accent); }
    .header h1 { margin: 0 0 4px 0; font-size: 20px; font-weight: 600; color: var(--text); }
    .meta { font-size: 12px; color: var(--text-3); margin-top: 8px; text-transform: uppercase; letter-spacing: 0.06em; }
    .meta span { display: inline-block; margin-right: 16px; }
    .stats-bar { display: flex; gap: 0; border-bottom: 1px solid var(--border); background: var(--surface); }
    .stat { flex: 1; padding: 16px 20px; text-align: center; border-right: 1px solid var(--border); }
    .stat:last-child { border-right: none; }
    .stat-value { font-size: 26px; font-weight: 600; color: var(--text); }
    .stat-label { font-size: 12px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px; }
    .content { padding: 24px 28px; }
    section { margin-bottom: 24px; }
    h2 { font-size: 12px; font-weight: 600; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid var(--border); padding-bottom: 6px; margin: 0 0 12px 0; }
    p { color: var(--text); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { color: var(--accent-hover); text-decoration: underline; }
    .diff-stats { background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 12px; font-size: 13px; color: var(--text-2); overflow-x: auto; margin: 0; }
    .first-run { color: var(--text-3); font-style: italic; margin: 0; }
    .findings .finding { background: var(--surface-2); padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; border-left: 4px solid var(--text-3); }
    .finding-critical { border-left-color: var(--fail); }
    .finding-warning { border-left-color: var(--warn); }
    .finding-info { border-left-color: var(--info); }
    .finding p { margin: 6px 0 0 0; color: var(--text); }
    .finding-severity { font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; margin-right: 8px; }
    .finding-critical .finding-severity { color: var(--fail); }
    .finding-warning .finding-severity { color: var(--warn); }
    .finding-info .finding-severity { color: var(--info); }
    .finding-category { font-size: 13px; color: var(--text-2); margin-right: 8px; }
    .finding code { font-size: 12px; color: var(--text-2); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--text); }
    th { background: var(--surface-2); color: var(--text-3); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
    .sub-mission { margin-bottom: 16px; }
    .sub-mission h3 { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--text-2); margin: 0 0 6px 0; }
    .sub-mission ul { margin: 0; padding-left: 20px; }
    .sub-mission li { font-size: 13px; margin-bottom: 4px; color: var(--text); }
    .sub-mission code { font-family: var(--font-mono); color: var(--text-2); }
    .task-status { font-weight: 600; }
    .task-status-completed, .task-status-complete { color: var(--ok); }
    .task-status-failed { color: var(--fail); }
    .task-status-pending { color: var(--warn); }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>${escapeHtml(archiveId)}: ${escapeHtml(headline)}</h1>
    <div class="meta">
      <span>Archived: ${escapeHtml(dateFormatted)}</span>
      <span>Sessions: ${totalSessions}</span>
    </div>
  </div>
  <div class="stats-bar">
    <div class="stat">
      <div class="stat-value">${escapeHtml(costFormatted)}</div>
      <div class="stat-label">Total Cost</div>
    </div>
    <div class="stat">
      <div class="stat-value">${totalSessions}</div>
      <div class="stat-label">Sessions</div>
    </div>
    <div class="stat">
      <div class="stat-value">${milestones.length}</div>
      <div class="stat-label">Milestones</div>
    </div>
  </div>
  <div class="content">
    <section>
      <h2>Goal</h2>
      <p>${escapeHtml(goal)}</p>
    </section>
    <section>
      <h2>Milestones</h2>
      ${milestonesHtml}
    </section>
    <section>
      <h2>Diff Summary</h2>
      ${diffSection}
    </section>
    ${findingsHtml}
    <section>
      <h2>Test Coverage</h2>
      ${taskStatusesHtml}
    </section>
    <section>
      <h2>Cost by Session Type</h2>
      <table>
        <thead><tr><th>Type</th><th>Sessions</th><th>Cost</th></tr></thead>
        <tbody>${costByTypeHtml}</tbody>
      </table>
    </section>
  </div>
</div>
</body>
</html>`;
}

/**
 * Escape HTML special characters.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generate a run report HTML file inside archiveDir.
 *
 * @param {string} archiveDir  - Absolute path to the archive directory
 * @param {string} projectRoot - Absolute path to the project root
 * @param {object} [deps={}]   - Injectable deps: { getDiffSummary }
 * @returns {Promise<string>}  Resolves to the HTML string written
 */
export async function generateRunReport(archiveDir, projectRoot, deps = {}) {
  const data = gatherReportData(archiveDir, projectRoot, deps);
  const html = renderReportHtml(data);
  const reportPath = path.join(archiveDir, 'report.html');
  fs.writeFileSync(reportPath, html, 'utf8');
  return html;
}

const MAX_RUN_HISTORY_ENTRIES = 20;

/**
 * Update the run history index file (RUNS.md) in projectRoot.
 * Creates the file with a "# Run History" header if it doesn't exist.
 * Prepends the new entry and caps at MAX_RUN_HISTORY_ENTRIES entries.
 *
 * Each entry includes: seq (as run number), headline, archivedAt (formatted as
 * date), totalCost (2 decimal places), totalSessions, changelog items as a
 * bullet list, and a relative link to archives/{manifest.id}/report.html.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {string} archiveDir  - Absolute path to the archive directory
 * @param {object} manifest    - Manifest object for the new archive
 * @returns {Promise<void>}
 */
export async function updateRunHistory(projectRoot, archiveDir, manifest) {
  const runsPath = path.join(projectRoot, 'RUNS.md');

  // ── Derive entry fields from manifest ───────────────────────────────────────
  const archiveId = manifest.id ?? path.basename(archiveDir);
  const seq = manifest.seq ?? '';
  const headline = manifest.headline ?? '';
  const archivedAt = manifest.archivedAt ?? new Date().toISOString();
  const totalCost = manifest.totalCost ?? 0;
  const totalSessions = manifest.totalSessions ?? 0;
  const changelog = manifest.changelog ?? [];

  // Format archivedAt as a human-readable date string
  let dateFormatted = archivedAt;
  try {
    dateFormatted = new Date(archivedAt).toDateString();
  } catch {
    // keep raw string if date is unparseable
  }

  // Cost with 2 decimal places
  const costFormatted = `$${totalCost.toFixed(2)}`;

  // Heading: include seq when present, fall back to headline or archiveId
  const heading = seq
    ? `## Run #${seq} — ${headline}`
    : `## ${headline || archiveId}`;

  // Changelog items as bullet list
  const changelogBlock =
    changelog.length > 0
      ? '\n- **Changelog:**\n' +
        changelog.map((c) => `  - ${c.type ?? 'change'}: ${c.description ?? ''}`).join('\n')
      : '';

  // Relative link to the HTML report
  const reportLink = `[View Report](archives/${archiveId}/report.html)`;

  const newEntry =
    `${heading}\n\n` +
    `- **Date:** ${dateFormatted}\n` +
    `- **Cost:** ${costFormatted}\n` +
    `- **Sessions:** ${totalSessions}` +
    `${changelogBlock}\n` +
    `- ${reportLink}`;

  // ── Read existing RUNS.md ───────────────────────────────────────────────────
  let existingEntries = [];

  if (fs.existsSync(runsPath)) {
    const existingContent = fs.readFileSync(runsPath, 'utf8');
    // Strip the "# Run History" header line to isolate the entries block
    const headerMatch = existingContent.match(/^(# Run History\s*\n+)/);
    const afterHeader = headerMatch
      ? existingContent.slice(headerMatch[0].length)
      : existingContent;

    // Split existing entries on the "## " heading delimiter
    existingEntries = afterHeader
      .split(/(?=^## )/m)
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
  }

  // ── Prepend new entry, cap at MAX, write back ───────────────────────────────
  const allEntries = [newEntry.trim(), ...existingEntries].slice(0, MAX_RUN_HISTORY_ENTRIES);

  const newContent = `# Run History\n\n${allEntries.join('\n\n')}\n`;
  fs.writeFileSync(runsPath, newContent, 'utf8');
}
