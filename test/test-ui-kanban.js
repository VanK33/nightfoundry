/**
 * test-ui-kanban.js — JSDOM-based tests for src/ui/public/kanban.js
 * Run: node test/test-ui-kanban.js
 */
import { JSDOM } from 'jsdom';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const indexHtmlPath = path.resolve(__dirname, '../src/ui/public/index.html');
const kanbanJsPath  = path.resolve(__dirname, '../src/ui/public/kanban.js');

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

// ─── bootDom ────────────────────────────────────────────────────────────────

async function bootDom({ stateResp, costResp, verifyResp }) {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  // Install fetch mock routing by URL substring
  window.fetch = (url) => {
    let resp;
    if (url.includes('/api/state')) {
      resp = { ok: true, status: 200, json: async () => stateResp };
    } else if (url.includes('/api/cost')) {
      resp = { ok: true, status: 200, json: async () => costResp };
    } else if (url.includes('/api/task/')) {
      if (verifyResp && verifyResp.status === 404) {
        resp = { ok: false, status: 404, json: async () => ({}) };
      } else if (verifyResp) {
        const body = verifyResp.body !== undefined ? verifyResp.body : verifyResp;
        resp = { ok: true, status: verifyResp.status || 200, json: async () => body };
      } else {
        resp = { ok: false, status: 404, json: async () => ({}) };
      }
    } else {
      resp = { ok: false, status: 404, json: async () => ({}) };
    }
    return Promise.resolve(resp);
  };

  // Eval kanban.js so function declarations attach to window
  window.eval(fs.readFileSync(kanbanJsPath, 'utf8'));

  // Dispatch DOMContentLoaded to trigger boot path
  document.dispatchEvent(new window.Event('DOMContentLoaded'));

  // Flush microtasks so first pollOnce settles
  await new Promise(r => setTimeout(r, 0));

  return { dom, window, document };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const populatedState = {
  active: true,
  projectMeta: { specPath: '/x.md', currentPhase: 'executing', globalStatus: 'active' },
  milestones: [{
    id: '001',
    description: 'M1',
    status: 'in_progress',
    missions: [{
      id: '001-001',
      description: 'Mission',
      status: 'in_progress',
      subMissions: [{
        id: '001-001-001',
        description: 'SM1',
        tasks: [
          { id: '001-001-001-001', description: 'A short task', status: 'verified',    retryCount: 0, targetFiles: [] },
          { id: '001-001-001-002', description: 'B',            status: 'in_progress', retryCount: 0, targetFiles: [] },
          { id: '001-001-001-003', description: 'C',            status: 'pending',     retryCount: 0, targetFiles: [] },
        ],
      }],
    }],
  }],
};

const populatedCost = {
  sessionCount: 5,
  inputTokens: 100,
  outputTokens: 50,
  cacheCreation: 0,
  cacheRead: 0,
  totalCostUsd: 1.23,
  byType: {
    planner:  { sessionCount: 2, totalCostUsd: 0.5  },
    executor: { sessionCount: 3, totalCostUsd: 0.73 },
  },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

async function run() {

// TC1: render structure — correct element counts
await test('TC1: rendered DOM has correct counts of milestone-column/mission-card/submission-header/task-card', async () => {
  const { dom, document } = await bootDom({ stateResp: populatedState, costResp: populatedCost });
  try {
    assert.strictEqual(
      document.querySelectorAll('.milestone-column').length, 1,
      'Expected 1 .milestone-column'
    );
    assert.strictEqual(
      document.querySelectorAll('.mission-card').length, 1,
      'Expected 1 .mission-card'
    );
    assert.strictEqual(
      document.querySelectorAll('.submission-header').length, 1,
      'Expected 1 .submission-header'
    );
    assert.strictEqual(
      document.querySelectorAll('.task-card').length, 3,
      'Expected 3 .task-card'
    );
  } finally {
    dom.window.close();
  }
});

// TC2: status classes — underscore→dash transform
await test('TC2: task cards carry correct status classes (task-verified / task-in-progress / task-pending)', async () => {
  const { dom, document } = await bootDom({ stateResp: populatedState, costResp: populatedCost });
  try {
    const verifiedCard    = document.querySelector('[data-task-id="001-001-001-001"]');
    const inProgressCard  = document.querySelector('[data-task-id="001-001-001-002"]');
    const pendingCard     = document.querySelector('[data-task-id="001-001-001-003"]');
    assert.ok(verifiedCard,   'Expected card for 001-001-001-001');
    assert.ok(inProgressCard, 'Expected card for 001-001-001-002');
    assert.ok(pendingCard,    'Expected card for 001-001-001-003');
    assert.ok(
      verifiedCard.classList.contains('task-verified'),
      `verified card classes: ${verifiedCard.className}`
    );
    assert.ok(
      inProgressCard.classList.contains('task-in-progress'),
      `in_progress card classes: ${inProgressCard.className}`
    );
    assert.ok(
      pendingCard.classList.contains('task-pending'),
      `pending card classes: ${pendingCard.className}`
    );
  } finally {
    dom.window.close();
  }
});

// TC3: cost display text and title tooltip
await test('TC3: #cost-display text === \'$1.23\' and title contains planner and executor', async () => {
  const { dom, document } = await bootDom({ stateResp: populatedState, costResp: populatedCost });
  try {
    const el = document.getElementById('cost-display');
    assert.strictEqual(el.textContent, '$1.23', `Expected '$1.23', got '${el.textContent}'`);
    assert.ok(
      el.title.includes('planner'),
      `Expected title to include 'planner', got: ${el.title}`
    );
    assert.ok(
      el.title.includes('executor'),
      `Expected title to include 'executor', got: ${el.title}`
    );
  } finally {
    dom.window.close();
  }
});

// TC4: progress bar width ~33.33% and progress text
await test('TC4: #progress-fill width ≈ 33.33% and #progress-text matches "1 / 3 tasks verified"', async () => {
  const { dom, document } = await bootDom({ stateResp: populatedState, costResp: populatedCost });
  try {
    const fill = document.getElementById('progress-fill');
    const text = document.getElementById('progress-text');
    const width = parseFloat(fill.style.width);
    assert.ok(
      width > 33 && width < 34,
      `Expected width ≈ 33.33%, got ${fill.style.width}`
    );
    assert.match(
      text.textContent,
      /^1 \/ 3 tasks verified$/,
      `Expected '1 / 3 tasks verified', got '${text.textContent}'`
    );
  } finally {
    dom.window.close();
  }
});

// TC5: click-to-verify — 200 path
await test('TC5: clicking a task with 200 verify response opens #verify-panel with hardChecks + taskScopeChecks', async () => {
  const verifyResp = {
    status: 200,
    body: {
      hardChecks:      [{ name: 'lint', status: 'PASS', evidence: 'ok'      }],
      taskScopeChecks: [{ description: 'TC1', status: 'PASS', evidence: 'matched' }],
    },
  };
  const { dom, window, document } = await bootDom({
    stateResp: populatedState,
    costResp: populatedCost,
    verifyResp,
  });
  try {
    const taskCard = document.querySelector('[data-task-id="001-001-001-001"]');
    taskCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    // Flush microtasks for async handleTaskClick
    await new Promise(r => setTimeout(r, 0));
    const panel = document.getElementById('verify-panel');
    assert.ok(!panel.hasAttribute('hidden'), 'panel should not have hidden attribute');
    assert.strictEqual(panel.dataset.taskId, '001-001-001-001', `panel.dataset.taskId should be '001-001-001-001'`);
    assert.ok(panel.textContent.includes('lint'), `panel should contain 'lint', got: ${panel.textContent}`);
    assert.ok(panel.textContent.includes('TC1'),  `panel should contain 'TC1', got: ${panel.textContent}`);
  } finally {
    dom.window.close();
  }
});

// TC6: click-to-verify — 404 path
await test('TC6: clicking a task with 404 verify response shows "Not yet verified"', async () => {
  const verifyResp = { status: 404 };
  const { dom, window, document } = await bootDom({
    stateResp: populatedState,
    costResp: populatedCost,
    verifyResp,
  });
  try {
    const taskCard = document.querySelector('[data-task-id="001-001-001-001"]');
    taskCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    const panel = document.getElementById('verify-panel');
    assert.ok(!panel.hasAttribute('hidden'), 'panel should not have hidden attribute');
    assert.ok(
      panel.textContent.includes('Not yet verified'),
      `panel should contain 'Not yet verified', got: ${panel.textContent}`
    );
  } finally {
    dom.window.close();
  }
});

// TC7: second click on same task closes panel
await test('TC7: second click on the same task closes the panel', async () => {
  const verifyResp = {
    status: 200,
    body: { hardChecks: [], taskScopeChecks: [] },
  };
  const { dom, window, document } = await bootDom({
    stateResp: populatedState,
    costResp: populatedCost,
    verifyResp,
  });
  try {
    const taskCard = document.querySelector('[data-task-id="001-001-001-001"]');
    // First click — open
    taskCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    const panel = document.getElementById('verify-panel');
    assert.ok(!panel.hasAttribute('hidden'), 'panel should be open after first click');
    // Second click — close
    taskCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    assert.ok(panel.hasAttribute('hidden'), 'panel should be hidden after second click');
  } finally {
    dom.window.close();
  }
});

// TC8: Escape keydown closes panel
await test('TC8: Escape keydown closes the panel', async () => {
  const verifyResp = {
    status: 200,
    body: { hardChecks: [], taskScopeChecks: [] },
  };
  const { dom, window, document } = await bootDom({
    stateResp: populatedState,
    costResp: populatedCost,
    verifyResp,
  });
  try {
    const taskCard = document.querySelector('[data-task-id="001-001-001-001"]');
    // Open panel
    taskCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));
    const panel = document.getElementById('verify-panel');
    assert.ok(!panel.hasAttribute('hidden'), 'panel should be open before Escape');
    // Dispatch Escape
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(panel.hasAttribute('hidden'), 'panel should be hidden after Escape');
  } finally {
    dom.window.close();
  }
});

// TC9: visibilitychange pauses and resumes polling
await test('TC9: visibilitychange pauses polling (clearInterval) and resumes it (setInterval)', async () => {
  const { dom, window, document } = await bootDom({
    stateResp: populatedState,
    costResp: populatedCost,
  });
  try {
    // Spy on clearInterval
    let clearIntervalCalled = false;
    const origClearInterval = window.clearInterval;
    window.clearInterval = (...args) => {
      clearIntervalCalled = true;
      return origClearInterval.call(window, ...args);
    };

    // Spy on setInterval
    let setIntervalCallCount = 0;
    const origSetInterval = window.setInterval;
    window.setInterval = (...args) => {
      setIntervalCallCount++;
      return origSetInterval.call(window, ...args);
    };

    // Simulate page hidden → stopPolling
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new window.Event('visibilitychange'));
    assert.ok(clearIntervalCalled, 'clearInterval should have been called when document.hidden = true');

    // Reset setInterval spy count, then simulate page visible → startPolling
    setIntervalCallCount = 0;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new window.Event('visibilitychange'));
    assert.ok(
      setIntervalCallCount > 0,
      'setInterval should have been called when document becomes visible again'
    );
  } finally {
    dom.window.close();
  }
});

// TC10: inactive state renders placeholder, zero task cards
await test('TC10: inactive state (active:false) shows "No active run" and zero .task-card elements', async () => {
  const { dom, document } = await bootDom({
    stateResp: { active: false, milestones: [] },
    costResp: populatedCost,
  });
  try {
    const container = document.getElementById('milestone-columns');
    assert.ok(
      container.textContent.includes('No active run'),
      `Expected 'No active run' in milestone-columns, got: ${container.textContent}`
    );
    assert.strictEqual(
      document.querySelectorAll('.task-card').length,
      0,
      'Expected zero .task-card elements for inactive state'
    );
  } finally {
    dom.window.close();
  }
});

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);

}

run();
