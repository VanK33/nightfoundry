// archives.js — plain script (not ES module), loaded via <script src="archives.js">

// ─── Top-level state ──────────────────────────────────────────────────────────

let archives = [];
let sortState = { key: 'date', dir: 'desc' };

// ─── Comparators ─────────────────────────────────────────────────────────────

const STATUS_ORDER = ['pending', 'in_progress', 'complete'];

function compareValues(a, b, key) {
  switch (key) {
    case 'totalCostUsd':
    case 'verifiedTasks':
    case 'totalTasks': {
      const na = Number(a[key]) || 0;
      const nb = Number(b[key]) || 0;
      return na - nb;
    }
    case 'slug':
    case 'id': {
      const sa = String(a[key] || '');
      const sb = String(b[key] || '');
      return sa.localeCompare(sb);
    }
    case 'date': {
      // ISO timestamps sort lexicographically; treat null/missing as empty string (sorts first)
      const da = a[key] || '';
      const db = b[key] || '';
      if (da < db) return -1;
      if (da > db) return 1;
      return 0;
    }
    case 'status': {
      const ia = STATUS_ORDER.indexOf(a[key]);
      const ib = STATUS_ORDER.indexOf(b[key]);
      // unknown values get index -1; treat those as last (higher than any known index)
      const ra = ia === -1 ? STATUS_ORDER.length : ia;
      const rb = ib === -1 ? STATUS_ORDER.length : ib;
      return ra - rb;
    }
    default:
      return 0;
  }
}

// ─── Timestamp formatting ─────────────────────────────────────────────────────

/**
 * formatTimestamp — renders an ISO timestamp as `YYYY-MM-DD HH:mm`.
 *
 * Purely string-based so the output is deterministic (no locale- or
 * timezone-dependent APIs). Date-only values render as `YYYY-MM-DD`;
 * empty/missing values render as ''; anything unrecognised passes through.
 * Sorting always compares the RAW value, never this formatted string.
 */
function formatTimestamp(value) {
  if (!value) return '';
  const s = String(value);
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(s);
  if (!m) return s;
  return m[2] ? m[1] + ' ' + m[2] : m[1];
}

// ─── Badge state ───────────────────────────────────────────────────────────────

/**
 * archiveBadgeState — derives the status badge state token for an archive row.
 * Returns 'degraded' when archive.degraded === true, 'failed' when
 * archive.status === 'failed', and 'clean' otherwise.
 */
function archiveBadgeState(archive) {
  if (archive && archive.degraded === true) return 'degraded';
  if (archive && archive.status === 'failed') return 'failed';
  return 'clean';
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  const list = document.getElementById('archives-list');
  list.innerHTML = '';

  const sorted = archives.slice().sort((a, b) => {
    const cmp = compareValues(a, b, sortState.key);
    return sortState.dir === 'asc' ? cmp : -cmp;
  });

  for (const archive of sorted) {
    const isDegraded = archive && archive.degraded === true;

    // Presentational styling comes from the shared kanban.css classes
    // (.archive-row-card, .status-badge, .numeric) — no inline styles here.
    const row = document.createElement('div');
    row.className = 'archive-row archive-row-card';
    row.dataset.id = archive.id;
    if (isDegraded) {
      row.classList.add('archive-row-degraded');
    }

    // (1) status badge — state derived from archiveBadgeState()
    const state = archiveBadgeState(archive);
    const badge = document.createElement('span');
    badge.className = 'status-badge ' + state;
    badge.textContent = state;
    row.appendChild(badge);

    // (2) spec name
    const nameEl = document.createElement('span');
    nameEl.className = 'archive-name';
    nameEl.textContent = archive.slug || archive.id || '';
    row.appendChild(nameEl);

    // (3) date, complete/total task count, and cost — grouped, right-aligned, monospace
    const metrics = document.createElement('span');
    metrics.className = 'archive-metrics numeric';

    const dateEl = document.createElement('span');
    dateEl.className = 'archive-date';
    dateEl.textContent = formatTimestamp(archive.date);
    metrics.appendChild(dateEl);

    const countEl = document.createElement('span');
    countEl.className = 'archive-count';
    countEl.textContent = (Number(archive.verifiedTasks) || 0) + '/' + (Number(archive.totalTasks) || 0);
    metrics.appendChild(countEl);

    const costEl = document.createElement('span');
    costEl.className = 'archive-cost';
    costEl.textContent = '$' + Number(archive.totalCostUsd || 0).toFixed(2);
    metrics.appendChild(costEl);

    row.appendChild(metrics);

    // (4) degraded label — only rendered when archive.degraded === true
    if (isDegraded) {
      const degradedLabel = document.createElement('span');
      degradedLabel.className = 'archive-degraded-label';
      degradedLabel.textContent = 'legacy archive (no manifest)';
      row.appendChild(degradedLabel);
    }

    list.appendChild(row);
  }
}

// ─── Sort header click handlers ───────────────────────────────────────────────

const DEFAULT_DIR_DESC = new Set(['date', 'totalCostUsd']);

function installSortHandlers() {
  const ths = document.querySelectorAll('#archives-sort [data-sort-key]');
  for (const th of ths) {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (key === sortState.key) {
        // toggle direction
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.key = key;
        sortState.dir = DEFAULT_DIR_DESC.has(key) ? 'desc' : 'asc';
      }
      render(); // no re-fetch
    });
  }
}

// ─── Row click → navigation ───────────────────────────────────────────────────

function installRowClickHandler() {
  const list = document.getElementById('archives-list');
  list.addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (!row || !list.contains(row)) return;
    const id = row.dataset.id;
    if (!id) return;
    window.location.href = '/archive-detail.html?id=' + encodeURIComponent(id);
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  installSortHandlers();
  installRowClickHandler();

  fetch('/api/archives')
    .then(r => r.json())
    .then(data => {
      if (data && Array.isArray(data.archives)) {
        archives = data.archives;
      } else if (Array.isArray(data)) {
        archives = data;
      } else {
        archives = [];
      }
      render();
    })
    .catch(err => {
      console.warn('[archives] fetch error:', err);
      // leave tbody empty
    });
});
