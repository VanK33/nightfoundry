/**
 * test-ui-api.js — Integration tests for the UI API routes.
 *
 * Run: node test/test-ui-api.js
 *
 * Covers:
 *   TC1 — GET /api/state on populated fixture → 200, active + projectMeta + milestones shape
 *   TC2 — GET /api/cost on populated fixture → 200, totals + byType per-type entries
 *   TC3 — GET /api/task/001-001-001-001/verify → 200, only hardChecks + taskScopeChecks (no leakage)
 *   TC4 — GET /api/task/001-001-001-002/verify (no sidecar) → 404
 *   TC5 — GET /api/task/..%2Fetc%2Fpasswd/verify → 400 (path-traversal guard via regex)
 *   TC6 — GET /api/state with empty/missing harness → 200, {active:false, milestones:[]}
 *   TC7 — GET /api/cost with empty/missing harness → 200, all-zero + byType:{}
 *   TC8 — GET /api/task/001-001-001-001/verify with empty/missing harness → 404
 */
import { createServer } from '../src/ui/server.js';
import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ---------------------------------------------------------------------------
// httpGet helper — wraps http.get with a 5000ms timeout
// ---------------------------------------------------------------------------
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(body); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, body, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('Request timed out after 5000ms — server did not respond'));
    });
  });
}

// ---------------------------------------------------------------------------
// mkPopulatedHarness — creates a temp dir with all fixture files
// ---------------------------------------------------------------------------
function mkPopulatedHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-ui-api-'));
  const dir = path.join(tmp, '.harness');
  fs.mkdirSync(dir, { recursive: true });

  // state.json
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath: '/tmp/spec.md', currentPhase: 'executing' },
      globalStatus: 'active',
      milestones: {
        '001': {
          id: '001',
          description: 'M1',
          status: 'in_progress',
          missions: {
            '001-001': {
              id: '001-001',
              description: 'Mission 1',
              status: 'in_progress',
              stateFile: '.harness/state/mission-001-001.json',
              planFile: '.harness/plan/mission-001-001.md',
            },
          },
        },
      },
    })
  );

  // state/mission-001-001.json — one subMission with two tasks
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state', 'mission-001-001.json'),
    JSON.stringify({
      id: '001-001',
      missionId: '001-001',
      description: 'Mission 1',
      status: 'in_progress',
      subMissions: {
        '001-001-001': {
          id: '001-001-001',
          description: 'SubMission 1',
          status: 'in_progress',
          tasks: {
            '001-001-001-001': {
              id: '001-001-001-001',
              description: 'Task 1',
              status: 'verified',
              createdAt: '2026-01-01T00:00:00.000Z',
              retryCount: 1,
              targetFiles: ['src/foo.js'],
            },
            '001-001-001-002': {
              id: '001-001-001-002',
              description: 'Task 2',
              status: 'pending',
              createdAt: '2026-01-01T00:01:00.000Z',
              retryCount: 0,
              targetFiles: [],
            },
          },
        },
      },
    })
  );

  // logs/token-usage.json — three session types + persisted totals
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'logs', 'token-usage.json'),
    JSON.stringify({
      sessions: [
        {
          name: 'planner-001',
          type: 'planner',
          timestamp: '2026-01-01T00:00:00.000Z',
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreation: 100,
          cacheRead: 50,
          totalCostUsd: 0.01,
        },
        {
          name: 'executor-001',
          type: 'executor',
          timestamp: '2026-01-01T00:01:00.000Z',
          inputTokens: 2000,
          outputTokens: 800,
          cacheCreation: 200,
          cacheRead: 100,
          totalCostUsd: 0.02,
        },
        {
          name: 'verifier-001',
          type: 'verifier',
          timestamp: '2026-01-01T00:02:00.000Z',
          inputTokens: 500,
          outputTokens: 200,
          cacheCreation: 50,
          cacheRead: 25,
          totalCostUsd: 0.005,
        },
      ],
      totals: {
        sessionCount: 3,
        inputTokens: 3500,
        outputTokens: 1500,
        cacheCreation: 350,
        cacheRead: 175,
        totalCostUsd: 0.035,
        systemPromptTokens: 0,
        toolCallCount: 0,
      },
      updatedAt: '2026-01-01T00:03:00.000Z',
    })
  );

  // verification/task-001-001-001-001.json — sidecar for task 001-001-001-001
  fs.mkdirSync(path.join(dir, 'verification'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'verification', 'task-001-001-001-001.json'),
    JSON.stringify({
      result: 'PASSED',
      hardChecks: [{ name: 'lint', status: 'PASS', evidence: 'ok' }],
      taskScopeChecks: [{ description: 'TC1', status: 'PASS', evidence: 'matched' }],
      notes: 'n/a',
    })
  );

  return dir;
}

// ---------------------------------------------------------------------------
// mkEmptyHarness — returns a non-existent path under tmpdir
// ---------------------------------------------------------------------------
function mkEmptyHarness() {
  // Create a real temp base dir for cleanup, but the harness path itself does not exist
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-ui-api-empty-'));
  return path.join(base, '.harness');
}

// ---------------------------------------------------------------------------
// withServer helper — spins up an ephemeral server on port 0
// ---------------------------------------------------------------------------
async function withServer(harnessDir, fn) {
  const projectRoot = path.dirname(harnessDir);
  const server = createServer({ projectRoot }).listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Cleanup tracking (belt-and-suspenders for CI)
// ---------------------------------------------------------------------------
const dirsToCleanup = [];

process.on('exit', () => {
  for (const d of dirsToCleanup) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run() {

// ---------------------------------------------------------------------------
// TC1: GET /api/state on populated fixture
// ---------------------------------------------------------------------------
await test('TC1: GET /api/state populated → 200, active, projectMeta.specPath, milestones shape', async () => {
  const dir = mkPopulatedHarness();
  const baseDir = path.dirname(dir);
  dirsToCleanup.push(baseDir);
  try {
    await withServer(dir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/state`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      assert.strictEqual(json.active, true, `Expected active===true, got ${json.active}`);
      assert.strictEqual(
        json.projectMeta.specPath,
        '/tmp/spec.md',
        `Expected projectMeta.specPath '/tmp/spec.md', got ${json.projectMeta.specPath}`
      );
      assert.strictEqual(
        json.milestones[0].id,
        '001',
        `Expected milestones[0].id '001', got ${json.milestones[0].id}`
      );
      const tasks = json.milestones[0].missions[0].subMissions[0].tasks;
      assert.strictEqual(
        tasks.length,
        2,
        `Expected 2 tasks in subMissions[0], got ${tasks.length}`
      );
    });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(baseDir), 1);
  }
});

// ---------------------------------------------------------------------------
// TC2: GET /api/cost on populated fixture
// ---------------------------------------------------------------------------
await test('TC2: GET /api/cost populated → 200, top-level totals + byType per-type entries', async () => {
  const dir = mkPopulatedHarness();
  const baseDir = path.dirname(dir);
  dirsToCleanup.push(baseDir);
  try {
    await withServer(dir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/cost`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      assert.strictEqual(json.sessionCount, 3, `Expected sessionCount 3, got ${json.sessionCount}`);
      assert.strictEqual(json.inputTokens, 3500, `Expected inputTokens 3500, got ${json.inputTokens}`);
      assert.strictEqual(json.outputTokens, 1500, `Expected outputTokens 1500, got ${json.outputTokens}`);
      assert.strictEqual(json.cacheCreation, 350, `Expected cacheCreation 350, got ${json.cacheCreation}`);
      assert.strictEqual(json.cacheRead, 175, `Expected cacheRead 175, got ${json.cacheRead}`);
      assert.strictEqual(json.totalCostUsd, 0.035, `Expected totalCostUsd 0.035, got ${json.totalCostUsd}`);
      assert.ok(
        json.byType.planner && json.byType.planner.sessionCount > 0,
        `Expected byType.planner with sessionCount > 0, got ${JSON.stringify(json.byType.planner)}`
      );
      assert.ok(
        json.byType.executor && json.byType.executor.sessionCount > 0,
        `Expected byType.executor with sessionCount > 0, got ${JSON.stringify(json.byType.executor)}`
      );
      assert.ok(
        json.byType.verifier && json.byType.verifier.sessionCount > 0,
        `Expected byType.verifier with sessionCount > 0, got ${JSON.stringify(json.byType.verifier)}`
      );
    });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(baseDir), 1);
  }
});

// ---------------------------------------------------------------------------
// TC3: GET /api/task/001-001-001-001/verify → 200, body has ONLY hardChecks + taskScopeChecks
// ---------------------------------------------------------------------------
await test('TC3: GET /api/task/001-001-001-001/verify → 200, body keys exactly [hardChecks,taskScopeChecks]', async () => {
  const dir = mkPopulatedHarness();
  const baseDir = path.dirname(dir);
  dirsToCleanup.push(baseDir);
  try {
    await withServer(dir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/task/001-001-001-001/verify`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      const keys = Object.keys(json).sort();
      assert.deepStrictEqual(
        keys,
        ['hardChecks', 'taskScopeChecks'],
        `Expected body keys exactly ['hardChecks','taskScopeChecks'], got ${JSON.stringify(keys)}`
      );
      assert.strictEqual(
        json.hardChecks[0].name,
        'lint',
        `Expected hardChecks[0].name 'lint', got ${json.hardChecks[0].name}`
      );
    });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(baseDir), 1);
  }
});

// ---------------------------------------------------------------------------
// TC4: GET /api/task/001-001-001-002/verify (no sidecar) → 404
// ---------------------------------------------------------------------------
await test('TC4: GET /api/task/001-001-001-002/verify (no sidecar) → 404', async () => {
  const dir = mkPopulatedHarness();
  const baseDir = path.dirname(dir);
  dirsToCleanup.push(baseDir);
  try {
    await withServer(dir, async (base) => {
      const { status } = await httpGet(`${base}/api/task/001-001-001-002/verify`);
      assert.strictEqual(status, 404, `Expected status 404, got ${status}`);
    });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(baseDir), 1);
  }
});

// ---------------------------------------------------------------------------
// TC5: GET /api/task/..%2Fetc%2Fpasswd/verify → 400 (traversal id rejected by regex)
// ---------------------------------------------------------------------------
await test('TC5: GET /api/task/..%2Fetc%2Fpasswd/verify → 400 (path-traversal guard)', async () => {
  const dir = mkPopulatedHarness();
  const baseDir = path.dirname(dir);
  dirsToCleanup.push(baseDir);
  try {
    await withServer(dir, async (base) => {
      const { status } = await httpGet(`${base}/api/task/..%2Fetc%2Fpasswd/verify`);
      assert.strictEqual(status, 400, `Expected status 400, got ${status}`);
    });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(baseDir), 1);
  }
});

// ---------------------------------------------------------------------------
// TC6: GET /api/state with empty/missing harness → 200, {active:false, milestones:[]}
// ---------------------------------------------------------------------------
await test('TC6: GET /api/state empty harness → 200, {active:false, milestones:[]}', async () => {
  const harnessDir = mkEmptyHarness();
  const baseDir = path.dirname(harnessDir);
  dirsToCleanup.push(baseDir);
  try {
    await withServer(harnessDir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/state`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      assert.strictEqual(json.active, false, `Expected active===false, got ${json.active}`);
      assert.deepStrictEqual(
        json.milestones,
        [],
        `Expected milestones===[], got ${JSON.stringify(json.milestones)}`
      );
    });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(baseDir), 1);
  }
});

// ---------------------------------------------------------------------------
// TC7: GET /api/cost with empty/missing harness → 200, all-zero + byType:{}
// ---------------------------------------------------------------------------
await test('TC7: GET /api/cost empty harness → 200, all-zero numeric fields + byType:{}', async () => {
  const harnessDir = mkEmptyHarness();
  const baseDir = path.dirname(harnessDir);
  dirsToCleanup.push(baseDir);
  try {
    await withServer(harnessDir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/cost`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      assert.strictEqual(json.sessionCount, 0, `Expected sessionCount===0, got ${json.sessionCount}`);
      assert.strictEqual(json.inputTokens, 0, `Expected inputTokens===0, got ${json.inputTokens}`);
      assert.strictEqual(json.outputTokens, 0, `Expected outputTokens===0, got ${json.outputTokens}`);
      assert.strictEqual(json.cacheCreation, 0, `Expected cacheCreation===0, got ${json.cacheCreation}`);
      assert.strictEqual(json.cacheRead, 0, `Expected cacheRead===0, got ${json.cacheRead}`);
      assert.strictEqual(json.totalCostUsd, 0, `Expected totalCostUsd===0, got ${json.totalCostUsd}`);
      assert.deepStrictEqual(
        json.byType,
        {},
        `Expected byType==={}, got ${JSON.stringify(json.byType)}`
      );
    });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(baseDir), 1);
  }
});

// ---------------------------------------------------------------------------
// TC8: GET /api/task/001-001-001-001/verify with empty/missing harness → 404
// ---------------------------------------------------------------------------
await test('TC8: GET /api/task/001-001-001-001/verify empty harness → 404', async () => {
  const harnessDir = mkEmptyHarness();
  const baseDir = path.dirname(harnessDir);
  dirsToCleanup.push(baseDir);
  try {
    await withServer(harnessDir, async (base) => {
      const { status } = await httpGet(`${base}/api/task/001-001-001-001/verify`);
      assert.strictEqual(status, 404, `Expected status 404, got ${status}`);
    });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(baseDir), 1);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
