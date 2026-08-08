// kanban.js — ES module, no imports (browser-loaded via <script type="module">)

// Module-scoped state
let lastStateJson = null;
let lastCostJson = null;
let pollTimer = null;

// ─── Polling ────────────────────────────────────────────────────────────────

async function pollOnce() {
  try {
    const [state, cost] = await Promise.all([
      fetch('/api/state').then(r => r.json()),
      fetch('/api/cost').then(r => r.json()),
    ]);

    const stateJson = JSON.stringify(state);
    if (stateJson !== lastStateJson) {
      lastStateJson = stateJson;
      renderState(state);
    }

    const costJson = JSON.stringify(cost);
    if (costJson !== lastCostJson) {
      lastCostJson = costJson;
      renderCost(cost);
    }
  } catch (err) {
    // network failure — swallow so poll loop survives
    console.warn('[kanban] pollOnce error:', err);
  }
}

function startPolling() {
  pollOnce();
  pollTimer = setInterval(pollOnce, 1500);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ─── Visibility ──────────────────────────────────────────────────────────────

function setupVisibility() {
  if (!document.hidden) {
    startPolling();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling();
    } else {
      startPolling();
    }
  });
}

// ─── Render: state ───────────────────────────────────────────────────────────

function renderState(state) {
  if (state.active === false) {
    renderInactive();
    return;
  }

  const container = document.getElementById('milestone-columns');
  container.innerHTML = '';

  for (const milestone of (state.milestones || [])) {
    const section = document.createElement('section');
    section.className = 'milestone-column';

    const milestoneHeader = document.createElement('h2');
    milestoneHeader.textContent = `${milestone.id}: ${milestone.description}`;
    section.appendChild(milestoneHeader);

    for (const mission of (milestone.missions || [])) {
      const missionCard = document.createElement('div');
      missionCard.className = 'mission-card';

      const missionHeader = document.createElement('h3');
      missionHeader.textContent = `${mission.id}: ${mission.description}`;
      missionCard.appendChild(missionHeader);

      for (const subMission of (mission.subMissions || [])) {
        const subHeader = document.createElement('div');
        subHeader.className = 'submission-header';
        subHeader.textContent = subMission.description;
        missionCard.appendChild(subHeader);

        for (const task of (subMission.tasks || [])) {
          const { id, description, status } = task;
          const cardEl = document.createElement('div');
          const statusClass = `task-${status.replace('_', '-')}`;
          cardEl.className = `task-card ${statusClass}`;
          cardEl.dataset.taskId = id;

          const idSpan = document.createElement('span');
          idSpan.className = 'task-id';
          idSpan.textContent = id;

          const descSpan = document.createElement('span');
          descSpan.className = 'task-desc';
          descSpan.title = description;
          descSpan.textContent =
            description.length > 60
              ? description.slice(0, 60) + '…'
              : description;

          cardEl.appendChild(idSpan);
          cardEl.appendChild(document.createTextNode(' '));
          cardEl.appendChild(descSpan);

          cardEl.addEventListener('click', () => handleTaskClick(id, cardEl));
          missionCard.appendChild(cardEl);
        }
      }

      section.appendChild(missionCard);
    }

    container.appendChild(section);
  }

  renderProgress(state);
}

function renderInactive() {
  const container = document.getElementById('milestone-columns');
  container.innerHTML =
    '<div class="inactive-placeholder submission-header">No active run — start a run and this page fills in live.</div>';
}

// ─── Render: cost ─────────────────────────────────────────────────────────────

function renderCost(cost) {
  const el = document.getElementById('cost-display');
  const totalCostUsd = (cost && cost.totalCostUsd != null) ? cost.totalCostUsd : 0;
  el.textContent = '$' + totalCostUsd.toFixed(2);

  const byType = (cost && cost.byType) ? cost.byType : {};
  el.title = Object.entries(byType)
    .map(([k, v]) => `${k}: $${v.totalCostUsd.toFixed(2)}`)
    .join('\n');
}

// ─── Render: progress ─────────────────────────────────────────────────────────

function renderProgress(state) {
  // Terminal parity: count the terminal 'complete' status. 'verified' is a
  // transient in-flight state (awaiting_verification → verified → complete)
  // that persisted snapshots never show, so counting it reads as zero.
  // 'invalidated' tasks are replan husks that never run — count neither in
  // the denominator.
  let complete = 0;
  let total = 0;

  for (const milestone of (state.milestones || [])) {
    for (const mission of (milestone.missions || [])) {
      for (const subMission of (mission.subMissions || [])) {
        for (const task of (subMission.tasks || [])) {
          if (task.status === 'invalidated') continue;
          total++;
          if (task.status === 'complete') complete++;
        }
      }
    }
  }

  const fill = document.getElementById('progress-fill');
  const text = document.getElementById('progress-text');
  fill.style.width = total ? (complete / total * 100) + '%' : '0%';
  text.textContent = `${complete} / ${total} tasks complete`;
}

// ─── Verify panel ─────────────────────────────────────────────────────────────

async function handleTaskClick(taskId, cardEl) {
  const panel = document.getElementById('verify-panel');
  if (panel.dataset.taskId === taskId && !panel.hasAttribute('hidden')) {
    closeVerifyPanel();
    return;
  }

  try {
    const res = await fetch('/api/task/' + encodeURIComponent(taskId) + '/verify');
    if (res.status === 200) {
      renderVerifyPanel(taskId, await res.json());
    } else if (res.status === 404) {
      renderVerifyEmpty(taskId);
    }
  } catch (err) {
    console.warn('[kanban] handleTaskClick error:', err);
  }
}

function renderVerifyPanel(taskId, data) {
  const panel = document.getElementById('verify-panel');

  function buildSection(label, items, nameKey) {
    const section = document.createElement('div');
    const heading = document.createElement('h4');
    heading.textContent = label;
    section.appendChild(heading);
    for (const item of (items || [])) {
      const row = document.createElement('div');
      row.className = 'verify-row';
      const nameEl = document.createElement('span');
      nameEl.className = 'verify-name';
      nameEl.textContent = item[nameKey] || '';
      const statusEl = document.createElement('span');
      statusEl.className = 'verify-status';
      statusEl.textContent = item.status || '';
      const evidenceEl = document.createElement('span');
      evidenceEl.className = 'verify-evidence';
      evidenceEl.textContent = item.evidence || '';
      row.appendChild(nameEl);
      row.appendChild(statusEl);
      row.appendChild(evidenceEl);
      section.appendChild(row);
    }
    return section;
  }

  panel.innerHTML = '';
  panel.appendChild(buildSection('Hard Checks', data.hardChecks, 'name'));
  panel.appendChild(buildSection('Task Scope Checks', data.taskScopeChecks, 'description'));

  panel.dataset.taskId = taskId;
  panel.removeAttribute('hidden');
}

function renderVerifyEmpty(taskId) {
  const panel = document.getElementById('verify-panel');
  panel.innerHTML = '<p>Not yet verified</p>';
  panel.dataset.taskId = taskId;
  panel.removeAttribute('hidden');
}

function closeVerifyPanel() {
  const panel = document.getElementById('verify-panel');
  panel.setAttribute('hidden', '');
  delete panel.dataset.taskId;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

function initKanban({ archivedMode = false, state = null } = {}) {
  if (archivedMode) {
    const container = document.getElementById('milestone-columns');
    if (container) container.classList.add('archived');
    renderState(state);
    renderCost(state.cost ?? {});
  } else {
    setupVisibility();
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeVerifyPanel();
    });
  }
}

document.addEventListener('DOMContentLoaded', () => initKanban());
