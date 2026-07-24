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

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  const tbody = document.getElementById('archives-tbody');
  tbody.innerHTML = '';

  const sorted = archives.slice().sort((a, b) => {
    const cmp = compareValues(a, b, sortState.key);
    return sortState.dir === 'asc' ? cmp : -cmp;
  });

  for (const archive of sorted) {
    const tr = document.createElement('tr');
    tr.dataset.id = archive.id;

    const cells = [
      archive.id,
      archive.slug,
      archive.date || '',
      '$' + Number(archive.totalCostUsd || 0).toFixed(2),
      archive.verifiedTasks + '/' + archive.totalTasks,
      archive.status,
    ];

    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }
}

// ─── Sort header click handlers ───────────────────────────────────────────────

const DEFAULT_DIR_DESC = new Set(['date', 'totalCostUsd']);

function installSortHandlers() {
  const ths = document.querySelectorAll('#archives-table thead th[data-sort-key]');
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
  const tbody = document.getElementById('archives-tbody');
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
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
      archives = Array.isArray(data) ? data : [];
      render();
    })
    .catch(err => {
      console.warn('[archives] fetch error:', err);
      // leave tbody empty
    });
});
