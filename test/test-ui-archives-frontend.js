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
  { id: 'test-1', slug: 'a', date: '2026-05-10T09:07:00.000Z', totalCostUsd: 1.5, totalTasks: 5, verifiedTasks: 3, status: 'complete' },
  { id: 'test-2', slug: 'b', date: '2026-05-09T23:45:12.000Z', totalCostUsd: 0.5, totalTasks: 3, verifiedTasks: 1, status: 'in_progress' },
  { id: 'test-3', slug: 'c', date: '2026-05-08T00:00:00.000Z', totalCostUsd: 2.0, totalTasks: 7, verifiedTasks: 7, status: 'complete' },
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
          { id: '001-001-001-001', description: 'Task 1', status: 'complete', retryCount: 0, targetFiles: [] },
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

// TC1: 3 fetched archives render 3 .archive-row rows in #archives-list
// (selectors track the card-row DOM introduced by the demo-grade-ui pass:
//  rows are div.archive-row inside #archives-list; sort headers are
//  [data-sort-key] spans inside #archives-sort.)
await test('TC1 SCEN_A: 3 fetched archives render 3 .archive-row rows in #archives-list', async () => {
  const { dom, document } = await bootArchives(archivesFixture);
  try {
    const rows = document.querySelectorAll('#archives-list .archive-row');
    assert.strictEqual(rows.length, 3, `Expected 3 rows, got ${rows.length}`);
  } finally {
    dom.window.close();
  }
});

// TC2: clicking the [data-sort-key="totalCostUsd"] header reorders rows; fetch invoked exactly once
await test('TC2 SCEN_A: clicking [data-sort-key="totalCostUsd"] reorders rows; fetch invoked exactly once', async () => {
  const { dom, document, getFetchCount } = await bootArchives(archivesFixture);
  try {
    // Capture initial DOM order (initial sort: date desc → test-1, test-2, test-3)
    const rowsBefore = [...document.querySelectorAll('#archives-list .archive-row')].map(r => r.dataset.id);
    assert.strictEqual(rowsBefore.length, 3, 'Expected 3 rows before sort');

    // Click the totalCostUsd sort header
    const th = document.querySelector('#archives-sort [data-sort-key="totalCostUsd"]');
    assert.ok(th, 'Expected an #archives-sort [data-sort-key="totalCostUsd"] header to exist');
    th.click();

    // Sort is synchronous (no re-fetch); flush any remaining microtasks
    await new Promise(r => setTimeout(r, 0));

    const rowsAfter = [...document.querySelectorAll('#archives-list .archive-row')].map(r => r.dataset.id);
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

// Same-minute fixture — the discriminating input for TC2b.
//
// 'older-same-minute' and 'newer-same-minute' collapse to the SAME rendered
// 'YYYY-MM-DD HH:mm' text and differ only in seconds, and the older of the two
// is listed FIRST in fetch order. A comparator that sorted the formatted string
// would see them as equal, and the stable sort would leave the older one ahead;
// only a RAW-ISO comparison puts the newer one first under date-desc. That is
// the mutation TC2b is built to catch.
const sameMinuteFixture = [
  { id: 'older-same-minute', slug: 'd', date: '2026-05-10T09:07:05.000Z', totalCostUsd: 3.0, totalTasks: 2, verifiedTasks: 2, status: 'complete' },
  { id: 'newer-same-minute', slug: 'a', date: '2026-05-10T09:07:30.000Z', totalCostUsd: 1.5, totalTasks: 5, verifiedTasks: 3, status: 'complete' },
  { id: 'previous-day',      slug: 'b', date: '2026-05-09T23:45:12.000Z', totalCostUsd: 0.5, totalTasks: 3, verifiedTasks: 1, status: 'in_progress' },
];

// TC2b: .archive-date renders the ISO timestamp as `YYYY-MM-DD HH:mm`, and the
//       date sort compares the RAW ISO value — pinned by two rows whose rendered
//       text is identical and whose raw values differ only in seconds
await test('TC2b SCEN_A: dates render as "YYYY-MM-DD HH:mm"; date sort compares the raw ISO seconds', async () => {
  const { dom, document } = await bootArchives(sameMinuteFixture);
  try {
    const rows = [...document.querySelectorAll('#archives-list .archive-row')];
    const dates = rows.map(r => r.querySelector('.archive-date').textContent);

    // Formatting: seconds are dropped, so the first two rows render identically.
    assert.deepStrictEqual(
      dates,
      ['2026-05-10 09:07', '2026-05-10 09:07', '2026-05-09 23:45'],
      `Expected YYYY-MM-DD HH:mm formatted dates, got ${JSON.stringify(dates)}`
    );

    // Raw-ISO sort: initial state is date desc. The two same-minute rows are
    // indistinguishable once formatted, so this ordering is only reachable by
    // comparing the raw values — a formatted-string comparator ties them and the
    // stable sort would emit 'older-same-minute' first (its fetch-order position).
    assert.deepStrictEqual(
      rows.map(r => r.dataset.id),
      ['newer-same-minute', 'older-same-minute', 'previous-day'],
      `Expected date-desc to rank the raw ISO seconds (newer first), got ${JSON.stringify(rows.map(r => r.dataset.id))}`
    );

    // Toggling to asc still reads the raw value; the same-minute pair flips back.
    const th = document.querySelector('#archives-sort [data-sort-key="date"]');
    assert.ok(th, 'Expected an #archives-sort [data-sort-key="date"] header to exist');
    th.click();
    await new Promise(r => setTimeout(r, 0));

    const asc = [...document.querySelectorAll('#archives-list .archive-row')].map(r => r.dataset.id);
    assert.deepStrictEqual(
      asc,
      ['previous-day', 'older-same-minute', 'newer-same-minute'],
      `Expected date-asc order previous-day, older-same-minute, newer-same-minute, got ${JSON.stringify(asc)}`
    );
  } finally {
    dom.window.close();
  }
});

// TC2c: a missing/empty date renders as the empty string (unchanged behaviour)
await test('TC2c SCEN_A: missing date renders as empty string', async () => {
  const withMissingDate = [
    { id: 'test-1', slug: 'a', date: null, totalCostUsd: 1.5, totalTasks: 5, verifiedTasks: 3, status: 'complete' },
  ];
  const { dom, document } = await bootArchives(withMissingDate);
  try {
    const dateEl = document.querySelector('#archives-list .archive-row .archive-date');
    assert.ok(dateEl, 'Expected an .archive-date element');
    assert.strictEqual(
      dateEl.textContent,
      '',
      `Expected empty string for a null date, got: "${dateEl.textContent}"`
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
//        #report-button.getAttribute('href') === '/archives/test-1/report.html'
//        (filename comes from the API's runReportRelPath, not a frontend hardcode)
//        #report-button.getAttribute('target') === '_blank'
await test('TC6a SCEN_D: runReportRelPath set → #report-button href="/archives/test-1/report.html" target="_blank"', async () => {
  const { dom, document } = await bootArchiveDetail({ archiveId: 'test-1', responseData: detailResp });
  try {
    const reportBtn = document.getElementById('report-button');
    assert.ok(reportBtn, 'Expected #report-button to exist');

    const href = reportBtn.getAttribute('href');
    assert.strictEqual(
      href,
      '/archives/test-1/report.html',
      `Expected href="/archives/test-1/report.html", got: "${href}"`
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
