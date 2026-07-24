// archive-detail.js — runs as a plain <script>; relies on initKanban() defined globally by kanban.js loaded before this script.

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
  costBlock.appendChild(totalP);

  const byType = (cost && cost.byType) ? cost.byType : {};
  const byTypeEntries = Object.entries(byType);
  if (byTypeEntries.length > 0) {
    const list = document.createElement('ul');
    for (const [type, info] of byTypeEntries) {
      const li = document.createElement('li');
      li.textContent = type + ': $' + (info.totalCostUsd != null ? info.totalCostUsd.toFixed(2) : '0.00');
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
      div.innerHTML =
        '<span class="finding-severity">' + (finding.severity || '') + '</span> ' +
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

  // Initialize kanban in archived mode
  initKanban({ archivedMode: true, state: response.state });
});
