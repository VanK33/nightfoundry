/**
 * test-ui-per-run-resolution.js — Proves the UI server resolves the active
 * run's harness dir freshly on every request rather than freezing it at
 * createServer() time (the frozen-harnessDir bug).
 *
 * A single createServer({ projectRoot }) instance is created once and never
 * restarted. Between requests, the active-run pointer is repointed from
 * run-A to run-B via claimActiveRun/clearActiveRunPointer, and each
 * subsequent request must reflect the newly-pointed-to run's data.
 *
 * Run: node test/test-ui-per-run-resolution.js
 */
import { createServer } from '../src/ui/server.js';
import { claimActiveRun, clearActiveRunPointer, runHarnessDir } from '../src/orchestrator/core/run-context.js';
import http from 'http';
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Failed to parse JSON response from ${urlPath}: ${err.message}; body was: ${body.slice(0, 300)}`));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error(`Request to ${urlPath} timed out after 5000ms`));
    });
  });
}

async function run() {

// TC1: /api/state reflects whichever run the active-run pointer currently
// targets, re-resolved per request with no server restart.
await test('TC1: /api/state re-resolves per-run harnessDir without server restart', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-per-run-state-'));
  const projectRoot = tmp;
  const runIdA = 'run-A';
  const runIdB = 'run-B';
  const markerA = '/marker/run-A/spec.md';
  const markerB = '/marker/run-B/spec.md';

  const dirA = runHarnessDir(projectRoot, runIdA);
  const dirB = runHarnessDir(projectRoot, runIdB);
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(
    path.join(dirA, 'state.json'),
    JSON.stringify({ projectMeta: { prdPath: markerA }, globalStatus: 'active', milestones: {} })
  );
  fs.writeFileSync(
    path.join(dirB, 'state.json'),
    JSON.stringify({ projectMeta: { prdPath: markerB }, globalStatus: 'active', milestones: {} })
  );

  const server = createServer({ projectRoot }).listen(0);
  try {
    const port = server.address().port;

    clearActiveRunPointer(projectRoot);
    const claimedA = claimActiveRun(projectRoot, { runId: runIdA, slug: 'run-a', kind: 'test' });
    assert.ok(claimedA, 'Expected claimActiveRun to successfully claim run-A on a clean pointer');

    const bodyA = await getJson(port, '/api/state');
    assert.strictEqual(
      bodyA.projectMeta?.specPath,
      markerA,
      `Expected /api/state.projectMeta.specPath to be run-A's marker '${markerA}' while pointer=run-A, got: ${JSON.stringify(bodyA.projectMeta)}`
    );

    // Repoint the active-run pointer to run-B, WITHOUT restarting the server.
    clearActiveRunPointer(projectRoot);
    const claimedB = claimActiveRun(projectRoot, { runId: runIdB, slug: 'run-b', kind: 'test' });
    assert.ok(claimedB, 'Expected claimActiveRun to successfully claim run-B after clearing the pointer');

    const bodyB = await getJson(port, '/api/state');
    assert.strictEqual(
      bodyB.projectMeta?.specPath,
      markerB,
      `Expected /api/state.projectMeta.specPath to be run-B's marker '${markerB}' after repointing to run-B (no server restart), got: ${JSON.stringify(bodyB.projectMeta)}`
    );
  } finally {
    server.close(() => {});
    clearActiveRunPointer(projectRoot);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// TC2: /api/cost reflects whichever run the active-run pointer currently
// targets, re-resolved per request with no server restart.
await test('TC2: /api/cost re-resolves per-run token-usage totals without server restart', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-per-run-cost-'));
  const projectRoot = tmp;
  const runIdA = 'run-A';
  const runIdB = 'run-B';

  const dirA = runHarnessDir(projectRoot, runIdA);
  const dirB = runHarnessDir(projectRoot, runIdB);
  const logsA = path.join(dirA, 'logs');
  const logsB = path.join(dirB, 'logs');
  fs.mkdirSync(logsA, { recursive: true });
  fs.mkdirSync(logsB, { recursive: true });

  // state.json is required for activeHarnessDir() to validate the pointer.
  fs.writeFileSync(
    path.join(dirA, 'state.json'),
    JSON.stringify({ projectMeta: {}, globalStatus: 'active', milestones: {} })
  );
  fs.writeFileSync(
    path.join(dirB, 'state.json'),
    JSON.stringify({ projectMeta: {}, globalStatus: 'active', milestones: {} })
  );

  const totalsA = {
    sessionCount: 3,
    inputTokens: 1000,
    outputTokens: 200,
    cacheCreation: 10,
    cacheRead: 20,
    totalCostUsd: 1.23,
  };
  const totalsB = {
    sessionCount: 7,
    inputTokens: 9000,
    outputTokens: 800,
    cacheCreation: 50,
    cacheRead: 60,
    totalCostUsd: 9.87,
  };
  fs.writeFileSync(path.join(logsA, 'token-usage.json'), JSON.stringify({ totals: totalsA, sessions: [] }));
  fs.writeFileSync(path.join(logsB, 'token-usage.json'), JSON.stringify({ totals: totalsB, sessions: [] }));

  const server = createServer({ projectRoot }).listen(0);
  try {
    const port = server.address().port;

    clearActiveRunPointer(projectRoot);
    const claimedA = claimActiveRun(projectRoot, { runId: runIdA, slug: 'run-a', kind: 'test' });
    assert.ok(claimedA, 'Expected claimActiveRun to successfully claim run-A on a clean pointer');

    const costA = await getJson(port, '/api/cost');
    assert.strictEqual(
      costA.sessionCount,
      totalsA.sessionCount,
      `Expected /api/cost.sessionCount to be run-A's total ${totalsA.sessionCount} while pointer=run-A, got: ${costA.sessionCount}`
    );
    assert.strictEqual(
      costA.totalCostUsd,
      totalsA.totalCostUsd,
      `Expected /api/cost.totalCostUsd to be run-A's total ${totalsA.totalCostUsd} while pointer=run-A, got: ${costA.totalCostUsd}`
    );

    // Repoint the active-run pointer to run-B, WITHOUT restarting the server.
    clearActiveRunPointer(projectRoot);
    const claimedB = claimActiveRun(projectRoot, { runId: runIdB, slug: 'run-b', kind: 'test' });
    assert.ok(claimedB, 'Expected claimActiveRun to successfully claim run-B after clearing the pointer');

    const costB = await getJson(port, '/api/cost');
    assert.strictEqual(
      costB.sessionCount,
      totalsB.sessionCount,
      `Expected /api/cost.sessionCount to be run-B's total ${totalsB.sessionCount} after repointing to run-B (no server restart), got: ${costB.sessionCount}`
    );
    assert.strictEqual(
      costB.totalCostUsd,
      totalsB.totalCostUsd,
      `Expected /api/cost.totalCostUsd to be run-B's total ${totalsB.totalCostUsd} after repointing to run-B (no server restart), got: ${costB.totalCostUsd}`
    );
  } finally {
    server.close(() => {});
    clearActiveRunPointer(projectRoot);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);

}

run();
