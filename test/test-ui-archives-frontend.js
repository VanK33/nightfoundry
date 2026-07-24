/**
 * test-ui-archives-frontend.js — JSDOM-based smoke tests for archives.html and archive-detail.html
 * Run: node test/test-ui-archives-frontend.js
 *
 * Mirrors test/test-ui-kanban.js conventions:
 *   - PASS/FAIL counter
 *   - JSDOM with runScripts: 'outside-only'
 *   - fetch mock by URL substring
 *   - dispatch DOMContentLoaded
 *   - await microtask flush
 */
import { JSDOM } from 'jsdom';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const archivesHtmlPath      = path.resolve(__dirname, '../src/ui/public/archives.html');
const archiveDetailHtmlPath = path.resolve(__dirname, '../src/ui/public/archive-detail.html');
const archivesJsPath        = path.resolve(__dirname, '../src/ui/public/archives.js');
const kanbanJsPath          = path.resolve(__dirname, '../src/ui/public/kanban.js');
const archiveDetailJsPath   = path.resolve(__dirname, '../src/ui/public/archive-detail.js');
const indexHtmlPath         = path.resolve(__dirname, '../src/ui/public/index.html');

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

// ─── bootArchives: SCEN_A ─────────────────────────────────────────────────────

/**
 * Boot a JSDOM instance loaded with archives.html and archives.js.
 * mockArchives should be a plain array matching the shape returned by /api/archives.
 *
 * archives.html uses a regular (non-module) <script src="..."> tag. JSDOM with
 * runScripts:'outside-only' defers DOMContentLoaded asynchronously (after construction)
 * rather than firing it synchronously. We rely on JSDOM's natural dispatch rather than
 * manually dispatching, to avoid the double-fire that would occur if both JSDOM's deferred
 * event and our explicit dispatch both trigger the listener.
 */
async function bootArchives(mockArchives) {
  const html = fs.readFileSync(archivesHtmlPath, 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  // Count only /api/archives fetches — this is what "fetch invoked exactly once" means
  // semantically (the archives endpoint is hit once on load, not again on sort click).
  let archivesFetchCount = 0;
  window.fetch = (url) => {
    if (url.includes('/api/archives')) {
      archivesFetchCount++;
      return Promise.resolve({ ok: true, status: 200, json: async () => mockArchives });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  };

  window.eval(fs.readFileSync(archivesJsPath, 'utf8'));
  // JSDOM defers DOMContentLoaded asynchronously for regular-script HTML; wait for it to
  // fire naturally (tick 1), then wait for the fetch promise to resolve and render() to run (tick 2).
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));

  return { dom, window, document, getFetchCount: () => archivesFetchCount };
}

// ─── bootArchiveDetail: SCEN_B/C/D ───────────────────────────────────────────

/**
 * Boot a JSDOM instance loaded with archive-detail.html, kanban.js, and archive-detail.js.
 * Mocks /api/archive/<archiveId> to return responseData.
 * Mocks /api/state and /api/cost (needed because kanban.js DOMContentLoaded also fires).
 */
async function bootArchiveDetail({ archiveId = 'test-1', responseData }) {
  const html = fs.readFileSync(archiveDetailHtmlPath, 'utf8');
  const dom = new JSDOM(html, {
    url: `http://localhost/archive-detail.html?id=${archiveId}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  window.fetch = (url) => {
    if (url.includes('/api/archive/')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => responseData });
    }
    if (url.includes('/api/state')) {
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ active: false, milestones: [] }),
      });
    }
    if (url.includes('/api/cost')) {
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ totalCostUsd: 0, byType: {} }),
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  };

  // Load kanban.js: strip the `export` keyword from declarations so the code can be
  // eval'd in a non-module (global) context. Top-level function declarations in eval
  // become globals, so initKanban will be accessible as window.initKanban.
  const kanbanSrc = fs.readFileSync(kanbanJsPath, 'utf8')
    .replace(/^export\s+(function|const|let|var|class)\s/gm, '$1 ');
  window.eval(kanbanSrc);

  // Load archive-detail.js with all ES module import lines stripped (eval does not
  // support import statements). initKanban is now a global from the kanban.js eval above.
  const archiveDetailSrc = fs.readFileSync(archiveDetailJsPath, 'utf8')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('import '))
    .join('\n');
  window.eval(archiveDetailSrc);

  // archive-detail.html uses module scripts; JSDOM fires DOMContentLoaded synchronously
  // during construction for module-script HTML (it can't load them). Manually dispatch to
  // trigger both the kanban.js and archive-detail.js DOMContentLoaded listeners we eval'd.
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  // archive-detail.js handler is async (awaits fetch + json); one macrotask flush is
  // enough because all promises are pre-resolved and run as microtasks before the timeout.
  await new Promise(r => setTimeout(r, 0));

  return { dom, window, document };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Plain array — matches what /api/archives returns and what archives.js expects
const archivesFixture = [
  { id: 'test-1', slug: 'a', date: '2026-05-10', totalCostUsd: 1.5, totalTasks: 5, verifiedTasks: 3, status: 'complete' },
  { id: 'test-2', slug: 'b', date: '2026-05-09', totalCostUsd: 0.5, totalTasks: 3, verifiedTasks: 1, status: 'in_progress' },
  { id: 'test-3', slug: 'c', date: '2026-05-08', totalCostUsd: 2.0, totalTasks: 7, verifiedTasks: 7, status: 'complete' },
];

// State fixture with one milestone→mission→subMission→task for archive-detail rendering
const detailState = {
  active: true,
  projectMeta: {},
  milestones: [{
    id: '001',
    description: 'Milestone 1',
    status: 'complete',
    missions: [{
      id: '001-001',
      description: 'Mission 1',
      status: 'complete',
      subMissions: [{
        id: '001-001-001',
        description: 'SubMission 1',
        tasks: [
          { id: '001-001-001-001', description: 'Task 1', status: 'verified', retryCount: 0, targetFiles: [] },
        ],
      }],
    }],
  }],
};

// Full detail response fixture (SCEN_B, SCEN_C, SCEN_D with runReportRelPath set)
const detailResp = {
  id: 'test-1',
  state: detailState,
  cost: { totalCostUsd: 2.50, sessionCount: 3, byType: {} },
  specMd: '# spec body',
  reviewerFindings: [
    { severity: 'error', category: 'correctness', file: 'foo.js', description: 'something wrong', relatedFiles: [] },
  ],
  runReportRelPath: 'report.html',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

async function run() {

// ── SCEN_A ────────────────────────────────────────────────────────────────────

// TC1: 3 fetched archives render 3 <tr> rows in #archives-tbody
await test('TC1 SCEN_A: 3 fetched archives render 3 <tr> rows in #archives-tbody', async () => {
  const { dom, document } = await bootArchives(archivesFixture);
  try {
    const rows = document.querySelectorAll('#archives-tbody tr');
    assert.strictEqual(rows.length, 3, `Expected 3 rows, got ${rows.length}`);
  } finally {
    dom.window.close();
  }
});

// TC2: clicking <th data-sort-key="totalCostUsd"> reorders rows; fetch invoked exactly once
await test('TC2 SCEN_A: clicking <th data-sort-key="totalCostUsd"> reorders rows; fetch invoked exactly once', async () => {
  const { dom, document, getFetchCount } = await bootArchives(archivesFixture);
  try {
    // Capture initial DOM order (initial sort: date desc → test-1, test-2, test-3)
    const rowsBefore = [...document.querySelectorAll('#archives-tbody tr')].map(r => r.dataset.id);
    assert.strictEqual(rowsBefore.length, 3, 'Expected 3 rows before sort');

    // Click the totalCostUsd sort header
    const th = document.querySelector('th[data-sort-key="totalCostUsd"]');
    assert.ok(th, 'Expected <th data-sort-key="totalCostUsd"> to exist');
    th.click();

    // Sort is synchronous (no re-fetch); flush any remaining microtasks
    await new Promise(r => setTimeout(r, 0));

    const rowsAfter = [...document.querySelectorAll('#archives-tbody tr')].map(r => r.dataset.id);
    assert.strictEqual(rowsAfter.length, 3, 'Expected 3 rows after sort');

    // totalCostUsd desc (first click): 2.0→test-3, 1.5→test-1, 0.5→test-2
    // Initial date desc: test-1, test-2, test-3 → should differ
    assert.notDeepStrictEqual(
      rowsBefore, rowsAfter,
      `Expected rows to be reordered after sort click. Before: ${rowsBefore}, After: ${rowsAfter}`
    );

    // Only one fetch call total (no re-fetch on sort click)
    assert.strictEqual(
      getFetchCount(), 1,
      `Expected fetch to be invoked exactly once, got ${getFetchCount()}`
    );
  } finally {
    dom.window.close();
  }
});

// ── SCEN_B ────────────────────────────────────────────────────────────────────

// TC3: archive-detail.html?id=test-1 renders milestone columns, cost block ($),
//      spec block ('# spec body'), reviewer block (≥1 .finding), report-button present
await test('TC3 SCEN_B: milestone columns ≥1 task-card, cost block $, spec block content, reviewer .finding, report-button', async () => {
  const { dom, document } = await bootArchiveDetail({ archiveId: 'test-1', responseData: detailResp });
  try {
    // #milestone-columns has ≥1 child task-card
    const taskCards = document.querySelectorAll('#milestone-columns .task-card');
    assert.ok(
      taskCards.length >= 1,
      `Expected ≥1 .task-card in #milestone-columns, got ${taskCards.length}`
    );

    // #cost-block textContent contains '$'
    const costBlock = document.getElementById('cost-block');
    assert.ok(
      costBlock.textContent.includes('$'),
      `Expected '$' in #cost-block textContent, got: "${costBlock.textContent}"`
    );

    // #spec-block pre textContent contains '# spec body'
    const specPre = document.querySelector('#spec-block pre');
    assert.ok(
      specPre.textContent.includes('# spec body'),
      `Expected '# spec body' in #spec-block pre, got: "${specPre.textContent}"`
    );

    // #reviewer-block has ≥1 .finding
    const findings = document.querySelectorAll('#reviewer-block .finding');
    assert.ok(
      findings.length >= 1,
      `Expected ≥1 .finding in #reviewer-block, got ${findings.length}`
    );

    // #report-button exists
    const reportBtn = document.getElementById('report-button');
    assert.ok(reportBtn, 'Expected #report-button to exist in DOM');
  } finally {
    dom.window.close();
  }
});

// ── SCEN_B_FALLBACK ───────────────────────────────────────────────────────────

// TC4: specMd null → #spec-block pre textContent === 'Spec not preserved'
//      reviewerFindings [] → #reviewer-block contains 'No reviewer findings'
await test('TC4 SCEN_B_FALLBACK: specMd null → "Spec not preserved"; reviewerFindings [] → "No reviewer findings"', async () => {
  const fallbackResp = {
    ...detailResp,
    specMd: null,
    reviewerFindings: [],
  };
  const { dom, document } = await bootArchiveDetail({ archiveId: 'test-1', responseData: fallbackResp });
  try {
    const specPre = document.querySelector('#spec-block pre');
    assert.strictEqual(
      specPre.textContent,
      'Spec not preserved',
      `Expected 'Spec not preserved', got: "${specPre.textContent}"`
    );

    const reviewerBlock = document.getElementById('reviewer-block');
    assert.ok(
      reviewerBlock.textContent.includes('No reviewer findings'),
      `Expected 'No reviewer findings' in #reviewer-block, got: "${reviewerBlock.textContent}"`
    );
  } finally {
    dom.window.close();
  }
});

// ── SCEN_C ────────────────────────────────────────────────────────────────────

// TC5: after archive-detail.js init, #milestone-columns.classList.contains('archived') === true
await test('TC5 SCEN_C: #milestone-columns.classList.contains("archived") === true after archive-detail boot', async () => {
  const { dom, document } = await bootArchiveDetail({ archiveId: 'test-1', responseData: detailResp });
  try {
    const milestoneColumns = document.getElementById('milestone-columns');
    assert.ok(
      milestoneColumns.classList.contains('archived'),
      `Expected #milestone-columns to have class "archived", classes: "${milestoneColumns.className}"`
    );
  } finally {
    dom.window.close();
  }
});

// ── SCEN_D ────────────────────────────────────────────────────────────────────

// TC6a: runReportRelPath='report.html' with id='test-1' →
//        #report-button.getAttribute('href') === '/archives/test-1/RUN-REPORT.html'
//        #report-button.getAttribute('target') === '_blank'
await test('TC6a SCEN_D: runReportRelPath set → #report-button href="/archives/test-1/RUN-REPORT.html" target="_blank"', async () => {
  const { dom, document } = await bootArchiveDetail({ archiveId: 'test-1', responseData: detailResp });
  try {
    const reportBtn = document.getElementById('report-button');
    assert.ok(reportBtn, 'Expected #report-button to exist');

    const href = reportBtn.getAttribute('href');
    assert.strictEqual(
      href,
      '/archives/test-1/RUN-REPORT.html',
      `Expected href="/archives/test-1/RUN-REPORT.html", got: "${href}"`
    );

    const target = reportBtn.getAttribute('target');
    assert.strictEqual(target, '_blank', `Expected target="_blank", got: "${target}"`);
  } finally {
    dom.window.close();
  }
});

// TC6b: runReportRelPath=null → #report-button.hidden === true
await test('TC6b SCEN_D: runReportRelPath null → #report-button.hidden === true', async () => {
  const nullReportResp = { ...detailResp, runReportRelPath: null };
  const { dom, document } = await bootArchiveDetail({ archiveId: 'test-1', responseData: nullReportResp });
  try {
    const reportBtn = document.getElementById('report-button');
    assert.ok(reportBtn, 'Expected #report-button to exist in DOM');
    assert.strictEqual(
      reportBtn.hidden,
      true,
      `Expected #report-button.hidden === true, got: ${reportBtn.hidden}`
    );
  } finally {
    dom.window.close();
  }
});

// ── SCEN_E ────────────────────────────────────────────────────────────────────

// TC7: src/ui/public/index.html contains href="/archives.html"
await test('TC7 SCEN_E: src/ui/public/index.html contains href="/archives.html"', async () => {
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const occurrences = (indexHtml.match(/href="\/archives\.html"/g) || []).length;
  assert.ok(
    occurrences >= 1,
    `Expected at least 1 occurrence of href="/archives.html" in index.html, got ${occurrences}`
  );
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);

}

run();
