/**
 * test-ui-siderail-page.js — JSDOM-based tests for src/ui/public/siderail.html
 * (inline <script>, executed via JSDOM + window.eval)
 * Run: node test/test-ui-siderail-page.js
 */
import { JSDOM } from 'jsdom';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const siderailHtmlPath = path.resolve(__dirname, '../src/ui/public/siderail.html');

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

// ─── Extract inline <script> content from siderail.html ────────────────────

const siderailHtml = fs.readFileSync(siderailHtmlPath, 'utf8');
const scriptMatch = siderailHtml.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  throw new Error('Could not find inline <script> in siderail.html');
}
const inlineScript = scriptMatch[1];

// ─── bootDom ─────────────────────────────────────────────────────────────────

async function bootDom({ siderailResp }) {
  const dom = new JSDOM(siderailHtml, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  // Install fetch mock routing by URL substring
  window.fetch = (url) => {
    let resp;
    if (url.includes('/api/siderail')) {
      resp = { ok: true, status: 200, json: async () => siderailResp };
    } else {
      resp = { ok: false, status: 404, json: async () => ({}) };
    }
    return Promise.resolve(resp);
  };

  // Eval the inline script so its function declarations attach to window
  // and the top-level `if (!document.hidden) startPolling();` runs.
  window.eval(inlineScript);

  // Flush microtasks so first pollOnce (fetch → json → render) settles
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));

  return { dom, window, document };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const activePayload = {
  active: true,
  progress: { tasksComplete: 3, tasksTotal: 10 },
  current: {
    description: 'Implement the widget factory',
    missionId: '001-002',
    milestoneId: '001',
  },
  pendingDecision: false,
  error: null,
  timing: {
    elapsedMs: 45000,
    remainingTasks: 7,
    avgTaskDurationMs: 6500,
  },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

async function run() {

// TC1: progress fill/text reflect data.progress counts
await test('TC1: #progress-fill/#progress-text reflect data.progress counts', async () => {
  const { dom, document } = await bootDom({ siderailResp: activePayload });
  try {
    const fill = document.getElementById('progress-fill');
    const text = document.getElementById('progress-text');
    assert.strictEqual(fill.style.width, '30%', `Expected width '30%', got '${fill.style.width}'`);
    assert.strictEqual(
      text.textContent, '3 / 10',
      `Expected '3 / 10', got '${text.textContent}'`
    );
  } finally {
    dom.window.close();
  }
});

// TC2: #current-task shows description + missionId/milestoneId lineage
await test('TC2: #current-task shows description + missionId/milestoneId lineage', async () => {
  const { dom, document } = await bootDom({ siderailResp: activePayload });
  try {
    const currentTask = document.getElementById('current-task');
    const description = document.getElementById('current-task-description');
    const why = document.getElementById('current-task-why');
    assert.ok(!currentTask.hidden, 'current-task should not be hidden for active payload with current task');
    assert.strictEqual(
      description.textContent, 'Implement the widget factory',
      `Expected description text, got '${description.textContent}'`
    );
    assert.ok(
      why.textContent.includes('001-002'),
      `Expected why text to include missionId '001-002', got '${why.textContent}'`
    );
    assert.ok(
      why.textContent.includes('001'),
      `Expected why text to include milestoneId '001', got '${why.textContent}'`
    );
  } finally {
    dom.window.close();
  }
});

// TC3: decision-banner visible when pendingDecision:true, hidden when false
await test('TC3: #decision-banner visible when pendingDecision:true, hidden when false', async () => {
  const decisionPayload = { ...activePayload, pendingDecision: true };
  const { dom, document } = await bootDom({ siderailResp: decisionPayload });
  try {
    const banner = document.getElementById('decision-banner');
    assert.strictEqual(banner.hidden, false, 'decision-banner should be visible when pendingDecision:true');
  } finally {
    dom.window.close();
  }

  const noDecisionPayload = { ...activePayload, pendingDecision: false };
  const { dom: dom2, document: document2 } = await bootDom({ siderailResp: noDecisionPayload });
  try {
    const banner2 = document2.getElementById('decision-banner');
    assert.strictEqual(banner2.hidden, true, 'decision-banner should be hidden when pendingDecision:false');
  } finally {
    dom2.window.close();
  }
});

// TC4: error-banner visible when error:true
await test('TC4: #error-banner visible when error is truthy', async () => {
  const errorPayload = { ...activePayload, error: 'Something went wrong' };
  const { dom, document } = await bootDom({ siderailResp: errorPayload });
  try {
    const banner = document.getElementById('error-banner');
    assert.strictEqual(banner.hidden, false, 'error-banner should be visible when error is truthy');
    assert.ok(
      banner.textContent.includes('Something went wrong'),
      `Expected error-banner to include error text, got '${banner.textContent}'`
    );
  } finally {
    dom.window.close();
  }

  const noErrorPayload = { ...activePayload, error: null };
  const { dom: dom2, document: document2 } = await bootDom({ siderailResp: noErrorPayload });
  try {
    const banner2 = document2.getElementById('error-banner');
    assert.strictEqual(banner2.hidden, true, 'error-banner should be hidden when error is falsy');
  } finally {
    dom2.window.close();
  }
});

// TC5: #timing-line shows elapsedMs/remainingTasks/avgTaskDurationMs
await test('TC5: #timing-line shows elapsedMs/remainingTasks/avgTaskDurationMs', async () => {
  const { dom, document } = await bootDom({ siderailResp: activePayload });
  try {
    const timingLine = document.getElementById('timing-line');
    assert.ok(
      timingLine.textContent.includes('45000'),
      `Expected timing-line to include elapsedMs '45000', got '${timingLine.textContent}'`
    );
    assert.ok(
      timingLine.textContent.includes('7'),
      `Expected timing-line to include remainingTasks '7', got '${timingLine.textContent}'`
    );
    assert.ok(
      timingLine.textContent.includes('6500'),
      `Expected timing-line to include avgTaskDurationMs '6500', got '${timingLine.textContent}'`
    );
  } finally {
    dom.window.close();
  }
});

// TC6: visibilitychange to hidden stops polling; back to visible resumes
await test('TC6: visibilitychange to hidden stops polling (clearInterval); back to visible resumes (setInterval)', async () => {
  const { dom, window, document } = await bootDom({ siderailResp: activePayload });
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

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);

}

run();
