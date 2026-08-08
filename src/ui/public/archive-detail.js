// archive-detail.js — runs as a plain <script>; relies on initKanban() defined globally by kanban.js loaded before this script.

function renderConclusionBand(response) {
  const state = (response && response.state) || {};
  // Terminal parity: count the terminal 'complete' status. 'verified' is a
  // transient in-flight state (awaiting_verification → verified → complete)
  // that persisted snapshots never show, so counting it reads as zero.
  // 'invalidated' tasks are replan husks that never run — count neither in
  // the denominator.
  let complete = 0;
  let total = 0;
  let hasFailedOrBlocked = false;

  for (const milestone of (state.milestones || [])) {
    for (const mission of (milestone.missions || [])) {
      for (const subMission of (mission.subMissions || [])) {
        for (const task of (subMission.tasks || [])) {
          if (task.status === 'invalidated') continue;
          total++;
          if (task.status === 'complete') complete++;
          if (task.status === 'failed' || task.status === 'blocked') hasFailedOrBlocked = true;
        }
      }
    }
  }

  let status;
  if (hasFailedOrBlocked) {
    status = 'failed';
  } else if (total > 0 && complete === total) {
    status = 'complete';
  } else {
    status = 'in progress';
  }

  const badge = document.getElementById('verdict-badge');
  if (badge) {
    badge.textContent = status;
    badge.setAttribute('data-status', status);
  }

  const testsEl = document.getElementById('verdict-tests');
  if (testsEl) {
    testsEl.textContent = `${complete} / ${total} tasks complete`;
  }

  const costEl = document.getElementById('verdict-cost');
  if (costEl) {
    const cost = response && response.cost;
    const totalCostUsd = (cost && cost.totalCostUsd != null) ? cost.totalCostUsd : 0;
    costEl.textContent = '$' + totalCostUsd.toFixed(2);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');

  if (!id) {
    document.getElementById('kanban-root').textContent =
      'Error: No archive id specified in URL.';
    return;
  }

  document.getElementById('archive-id').textContent = id;

  let response;
  try {
    const res = await fetch('/api/archive/' + encodeURIComponent(id));
    if (!res.ok) {
      throw new Error('Non-200 response: ' + res.status);
    }
    response = await res.json();
  } catch (err) {
    console.warn('[archive-detail] fetch error:', err);
    document.getElementById('kanban-root').textContent =
      'Error: Failed to load archive data.';
    return;
  }

  // (a) #cost-block
  const costBlock = document.getElementById('cost-block');
  const cost = response.cost || {};
  const totalCostUsd = cost.totalCostUsd != null ? cost.totalCostUsd : 0;
  const totalP = document.createElement('p');
  totalP.textContent = 'Total: $' + totalCostUsd.toFixed(2);
  totalP.className = 'numeric';
  costBlock.appendChild(totalP);

  const byType = (cost && cost.byType) ? cost.byType : {};
  const byTypeEntries = Object.entries(byType);
  if (byTypeEntries.length > 0) {
    const list = document.createElement('ul');
    for (const [type, info] of byTypeEntries) {
      const li = document.createElement('li');
      li.textContent = type + ': $' + (info.totalCostUsd != null ? info.totalCostUsd.toFixed(2) : '0.00');
      li.className = 'numeric';
      list.appendChild(li);
    }
    costBlock.appendChild(list);
  }

  // (b) #spec-block pre
  const specPre = document.querySelector('#spec-block pre');
  if (response.specMd) {
    specPre.textContent = response.specMd;
  } else {
    specPre.textContent = 'Spec not preserved';
  }

  // (c) #reviewer-block
  const reviewerBlock = document.getElementById('reviewer-block');
  const findings = Array.isArray(response.reviewerFindings) ? response.reviewerFindings : [];
  if (findings.length === 0) {
    reviewerBlock.textContent = 'No reviewer findings';
  } else {
    for (const finding of findings) {
      const div = document.createElement('div');
      div.className = 'finding';
      const severityValue = finding.severity || '';
      div.innerHTML =
        '<span class="finding-severity" data-severity="' + severityValue + '">' + severityValue + '</span> ' +
        '<span class="finding-file">' + (finding.file || '') + '</span> ' +
        '<span class="finding-description">' + (finding.description || '') + '</span>';
      reviewerBlock.appendChild(div);
    }
  }

  // (d) #report-button
  const reportBtn = document.getElementById('report-button');
  if (response.runReportRelPath) {
    reportBtn.href = '/archives/' + encodeURIComponent(id) + '/RUN-REPORT.html';
    reportBtn.target = '_blank';
  } else {
    reportBtn.hidden = true;
  }

  // Populate the conclusion band (verdict badge, test counts, cost)
  renderConclusionBand(response);

  // Initialize kanban in archived mode
  initKanban({ archivedMode: true, state: response.state });
});
