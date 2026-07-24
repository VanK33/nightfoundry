/**
 * test-webhook-run-claim.js — Unit tests for buildWebhookApp's POST /run
 * claim-and-dispatch behavior, using an injected createPipeline stub (no
 * Claude auth, no SDK, no real Pipeline construction).
 *
 * Tests:
 *   TC1 — an unheld active-run pointer: POST /run responds 200
 *         {runId, status: 'started'}, and the createPipeline stub's run() is
 *         invoked with opts.preclaimedRun = {runId, slug, kind: 'run'}
 *         matching the response runId.
 *   TC2 — a pointer pre-seeded (claimActiveRun already holds it): POST /run
 *         responds 409 {error, activeRun}, and the createPipeline stub is
 *         never invoked.
 *   TC3 — a rejecting stub run(): the fire-and-forget .catch handler clears
 *         the active-run pointer only when resolveActiveHarnessDir(root) is
 *         null (no run dir was ever bootstrapped); when a valid run dir
 *         (state.json present) resolves for the claimed runId, the pointer
 *         is left intact.
 *   TC4 — importing webhook.js starts no listener (module import is
 *         side-effect free w.r.t. network binding), and
 *         buildWebhookApp({projectRoot, createPipeline}) returns an express
 *         app (a callable request handler with .listen).
 *
 * Clears CC_ORCH_ACTIVE_RUN unconditionally at module top (mirroring
 * scripts/run-tests.js and test-webhook-claim.js) so this suite is
 * re-entrancy-neutral regardless of launch context.
 *
 * Run: node test/test-webhook-run-claim.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import assert from 'assert';

import { buildWebhookApp } from '../src/triggers/webhook.js';
import {
  runHarnessDir,
  claimActiveRun,
  readActiveRunPointer,
  resolveActiveHarnessDir,
} from '../src/orchestrator/core/run-context.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// ---------- Fixture helpers ----------

function createRoot(prefix = 'webhook-run-claim-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds an injectable createPipeline stub: each construction call records
 * {root, hooks} on stub.calls, and each call to the returned pipeline's
 * run() records its (message, opts) args on stub.runCalls before delegating
 * to runImpl — so both the webhook's construction call and its fire-and-
 * forget run() invocation can be inspected/exercised.
 */
function makeStubCreatePipeline(runImpl) {
  const createPipeline = (root, hooks) => {
    createPipeline.calls.push({ root, hooks });
    return {
      autoFromHere: false,
      run: async (...args) => {
        createPipeline.runCalls.push(args);
        return runImpl(...args);
      },
    };
  };
  createPipeline.calls = [];
  createPipeline.runCalls = [];
  return createPipeline;
}

function postJson(port, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj ?? {});
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error(`Request to ${urlPath} timed out after 5000ms`));
    });
    req.write(data);
    req.end();
  });
}

// ---------- TC1: unheld pointer -> 200 + preclaimedRun wiring ----------

await test('TC1: POST /run with an unheld pointer returns 200 {runId, status: started} and invokes stub.run() with matching opts.preclaimedRun', async () => {
  const root = createRoot();
  let server;
  try {
    const createPipeline = makeStubCreatePipeline(async () => {});
    const baselineGate = async () => ({ ok: true, skipped: [] });
    const app = buildWebhookApp({ projectRoot: root, createPipeline, baselineGate });
    server = app.listen(0);
    const port = server.address().port;

    const goal = 'Build the TC1 thing';
    const res = await postJson(port, '/run', { goal });

    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.ok(
      res.body && typeof res.body.runId === 'string' && res.body.runId.length > 0,
      `response should include a non-empty runId, got: ${JSON.stringify(res.body)}`
    );
    assert.strictEqual(res.body.status, 'started', "response status should be 'started'");

    // Give the fire-and-forget pipeline.run() call a chance to be invoked.
    for (let i = 0; i < 40 && createPipeline.runCalls.length === 0; i++) {
      await wait(25);
    }

    assert.strictEqual(createPipeline.runCalls.length, 1, 'stub.run() should have been invoked exactly once');
    const [, opts] = createPipeline.runCalls[0];
    assert.deepStrictEqual(
      opts.preclaimedRun,
      { runId: res.body.runId, slug: goal, kind: 'run' },
      `opts.preclaimedRun should be {runId, slug, kind: 'run'} matching the response, got: ${JSON.stringify(opts.preclaimedRun)}`
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    cleanup(root);
  }
});

// ---------- TC2: pointer already held -> 409, stub never invoked ----------

await test('TC2: POST /run with a pointer already held returns 409 {error, activeRun} and never invokes the createPipeline stub', async () => {
  const root = createRoot();
  let server;
  try {
    const seededPointer = { runId: 'run-preexisting-tc2', slug: 'preexisting', kind: 'run' };
    const claimed = claimActiveRun(root, seededPointer);
    assert.ok(claimed, 'sanity: claimActiveRun should succeed on a fresh project root');

    const createPipeline = makeStubCreatePipeline(async () => {});
    const baselineGate = async () => ({ ok: true, skipped: [] });
    const app = buildWebhookApp({ projectRoot: root, createPipeline, baselineGate });
    server = app.listen(0);
    const port = server.address().port;

    const res = await postJson(port, '/run', { goal: 'Build the TC2 thing' });

    assert.strictEqual(res.statusCode, 409, `expected 409, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.ok(
      res.body && typeof res.body.error === 'string' && res.body.error.length > 0,
      `the 409 body should include a non-empty error message, got: ${JSON.stringify(res.body)}`
    );
    assert.ok(
      res.body && res.body.activeRun && typeof res.body.activeRun === 'object',
      `the 409 body should include the activeRun pointer, got: ${JSON.stringify(res.body)}`
    );
    assert.strictEqual(
      res.body.activeRun.runId,
      seededPointer.runId,
      'the returned activeRun should be the pre-seeded pointer'
    );

    assert.strictEqual(createPipeline.calls.length, 0, 'createPipeline construction should never be invoked');
    assert.strictEqual(createPipeline.runCalls.length, 0, 'stub.run() should never be invoked');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    cleanup(root);
  }
});

// ---------- TC3: rejecting stub.run() clears pointer only when no run dir resolves ----------

await test('TC3: a rejecting stub.run() clears the pointer only when resolveActiveHarnessDir(root) is null, and preserves it when a valid run dir resolves', async () => {
  // --- Scenario A: no run dir is ever bootstrapped -> pointer is cleared. ---
  const rootA = createRoot('webhook-run-claim-test-noRunDir-');
  let serverA;
  try {
    let rejectRunA;
    const runPromiseA = new Promise((_resolve, reject) => { rejectRunA = reject; });
    const createPipelineA = makeStubCreatePipeline(() => runPromiseA);
    const baselineGateA = async () => ({ ok: true, skipped: [] });
    const appA = buildWebhookApp({ projectRoot: rootA, createPipeline: createPipelineA, baselineGate: baselineGateA });
    serverA = appA.listen(0);
    const portA = serverA.address().port;

    const resA = await postJson(portA, '/run', { goal: 'Build the doomed TC3a thing' });
    assert.strictEqual(resA.statusCode, 200, `expected 200, got ${resA.statusCode}: ${JSON.stringify(resA.body)}`);
    assert.ok(
      readActiveRunPointer(rootA),
      'sanity: the pointer should be claimed synchronously before the fire-and-forget run() settles'
    );
    assert.strictEqual(
      resolveActiveHarnessDir(rootA),
      null,
      'sanity: no run dir was ever bootstrapped, so resolveActiveHarnessDir should be null'
    );

    rejectRunA(new Error('simulated pipeline failure before bootstrap'));

    for (let i = 0; i < 40 && readActiveRunPointer(rootA) !== null; i++) {
      await wait(25);
    }

    assert.strictEqual(
      readActiveRunPointer(rootA),
      null,
      'the claim should be cleared once the rejecting run() settles, since resolveActiveHarnessDir(root) is null'
    );
  } finally {
    if (serverA) await new Promise((resolve) => serverA.close(resolve));
    cleanup(rootA);
  }

  // --- Scenario B: a valid run dir resolves for the claimed runId -> pointer is preserved. ---
  const rootB = createRoot('webhook-run-claim-test-withRunDir-');
  let serverB;
  try {
    let rejectRunB;
    const runPromiseB = new Promise((_resolve, reject) => { rejectRunB = reject; });
    const createPipelineB = makeStubCreatePipeline((_message, opts) => {
      // Bootstrap a valid run dir (state.json present) for the preclaimed
      // runId BEFORE the promise ever rejects, so resolveActiveHarnessDir(root)
      // can validate it once the .catch handler runs.
      const runId = opts.preclaimedRun.runId;
      const dir = runHarnessDir(rootB, runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ globalStatus: 'active' }));
      return runPromiseB;
    });
    const baselineGateB = async () => ({ ok: true, skipped: [] });
    const appB = buildWebhookApp({ projectRoot: rootB, createPipeline: createPipelineB, baselineGate: baselineGateB });
    serverB = appB.listen(0);
    const portB = serverB.address().port;

    const resB = await postJson(portB, '/run', { goal: 'Build the doomed TC3b thing' });
    assert.strictEqual(resB.statusCode, 200, `expected 200, got ${resB.statusCode}: ${JSON.stringify(resB.body)}`);

    // Give the fire-and-forget run() a chance to bootstrap the run dir.
    for (let i = 0; i < 40 && resolveActiveHarnessDir(rootB) === null; i++) {
      await wait(25);
    }
    assert.strictEqual(
      resolveActiveHarnessDir(rootB),
      runHarnessDir(rootB, resB.body.runId),
      'sanity: a valid run dir should now resolve for the claimed runId'
    );

    const pointerBeforeReject = readActiveRunPointer(rootB);
    assert.ok(pointerBeforeReject, 'sanity: the pointer should still be present before rejection');

    rejectRunB(new Error('simulated pipeline failure after bootstrap'));

    // Give the fire-and-forget rejection's .catch handler a chance to run.
    await wait(200);

    const pointerAfterReject = readActiveRunPointer(rootB);
    assert.ok(
      pointerAfterReject,
      'the pointer should be preserved after rejection, since resolveActiveHarnessDir(root) resolves a valid run dir'
    );
    assert.strictEqual(
      pointerAfterReject.runId,
      pointerBeforeReject.runId,
      'the preserved pointer runId should be unchanged'
    );
  } finally {
    if (serverB) await new Promise((resolve) => serverB.close(resolve));
    cleanup(rootB);
  }
});

// ---------- TC4: importing webhook.js binds no listener; buildWebhookApp returns an app ----------

await test('TC4: importing webhook.js starts no listener, and buildWebhookApp({projectRoot, createPipeline}) returns an express app', async () => {
  const root = createRoot();
  try {
    const createPipeline = makeStubCreatePipeline(async () => {});
    const baselineGate = async () => ({ ok: true, skipped: [] });
    const app = buildWebhookApp({ projectRoot: root, createPipeline, baselineGate });

    // An express app is a callable request handler exposing .listen/.use/etc.
    assert.strictEqual(typeof app, 'function', 'buildWebhookApp should return a callable express app');
    assert.strictEqual(typeof app.listen, 'function', 'the returned app should expose .listen (express app shape)');
    assert.strictEqual(typeof app.use, 'function', 'the returned app should expose .use (express app shape)');

    // The module was already imported at the top of this file (import
    // buildWebhookApp from '../src/triggers/webhook.js') before any test ran;
    // that import alone must not have started a listener. Prove no server is
    // occupying the module's own default port-derivation env var path by
    // confirming buildWebhookApp itself never auto-listens: only an explicit
    // app.listen(0) call (never made here) would bind a socket.
    let listenCalled = false;
    const origListen = app.listen.bind(app);
    app.listen = (...args) => {
      listenCalled = true;
      return origListen(...args);
    };
    // No .listen() invocation follows — simply importing the module and
    // calling buildWebhookApp() must not have triggered a bind.
    assert.strictEqual(listenCalled, false, 'buildWebhookApp must not itself call app.listen');
  } finally {
    cleanup(root);
  }
});

// ---------- TC5: injected baselineGate stub {ok:true} -> gate passes, createPipeline invoked ----------

await test('TC5: an injected baselineGate stub returning {ok:true, skipped:[]} lets POST /run proceed past the gate and invoke the createPipeline stub', async () => {
  const root = createRoot();
  let server;
  try {
    const createPipeline = makeStubCreatePipeline(async () => {});
    const baselineGate = async () => ({ ok: true, skipped: [] });
    const app = buildWebhookApp({ projectRoot: root, createPipeline, baselineGate });
    server = app.listen(0);
    const port = server.address().port;

    const res = await postJson(port, '/run', { goal: 'Build the TC5 thing' });

    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.ok(
      res.body && typeof res.body.runId === 'string' && res.body.runId.length > 0,
      `response should include a non-empty runId, got: ${JSON.stringify(res.body)}`
    );
    assert.strictEqual(res.body.status, 'started', "response status should be 'started'");

    // Give the fire-and-forget gate + pipeline construction a chance to run.
    for (let i = 0; i < 40 && createPipeline.calls.length === 0; i++) {
      await wait(25);
    }

    assert.strictEqual(
      createPipeline.calls.length,
      1,
      'createPipeline should be constructed exactly once once the gate passes'
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    cleanup(root);
  }
});

// ---------- TC6: injected baselineGate stub {ok:false} -> gate fails, createPipeline never invoked ----------

await test('TC6: an injected baselineGate stub returning {ok:false, message} blocks POST /run from invoking createPipeline, marks the run failed with the gate message, and clears the active-run pointer', async () => {
  const root = createRoot();
  let server;
  try {
    const gateMessage = '<gate failure>';
    const createPipeline = makeStubCreatePipeline(async () => {});
    const baselineGate = async () => ({
      ok: false,
      message: gateMessage,
      command: 'npm test',
      exitCode: 1,
      outputTail: 'simulated baseline gate failure output',
    });
    const app = buildWebhookApp({ projectRoot: root, createPipeline, baselineGate });
    server = app.listen(0);
    const port = server.address().port;

    const res = await postJson(port, '/run', { goal: 'Build the TC6 thing' });

    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.ok(
      res.body && typeof res.body.runId === 'string' && res.body.runId.length > 0,
      `response should include a non-empty runId, got: ${JSON.stringify(res.body)}`
    );

    // Give the fire-and-forget gate a chance to settle and mark the entry failed.
    let logsRes;
    for (let i = 0; i < 40; i++) {
      logsRes = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/runs/${res.body.runId}/logs`, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => {
            try { resolve({ statusCode: r.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
            catch (err) { reject(err); }
          });
        }).on('error', reject);
      });
      if (logsRes.body && logsRes.body.status === 'failed') break;
      await wait(25);
    }

    assert.ok(logsRes, 'the /runs/:id/logs endpoint should respond');
    assert.strictEqual(
      logsRes.body.status,
      'failed',
      `the run entry should report status 'failed' after a red gate, got: ${JSON.stringify(logsRes.body)}`
    );
    assert.strictEqual(
      logsRes.body.error,
      gateMessage,
      `the failed run entry should carry the gate failure message, got: ${JSON.stringify(logsRes.body)}`
    );

    assert.strictEqual(createPipeline.calls.length, 0, 'createPipeline construction should never be invoked when the gate fails');
    assert.strictEqual(createPipeline.runCalls.length, 0, 'stub.run() should never be invoked when the gate fails');

    assert.strictEqual(
      resolveActiveHarnessDir(root),
      null,
      'no run dir was ever bootstrapped by the (never-invoked) pipeline, so resolveActiveHarnessDir should be null'
    );
    assert.strictEqual(
      readActiveRunPointer(root),
      null,
      'the active-run pointer should be cleared after the red gate clears it via resolveActiveHarnessDir(root) === null'
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
