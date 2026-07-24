/**
 * test-webhook-claim.js — Integration tests for the webhook trigger's
 * check-and-claim active-run flow, and the pipeline-level preclaimedRun
 * dispositions it depends on.
 *
 * (a)-(c) drive buildWebhookApp({ projectRoot, createPipeline }) over a real
 *     ephemeral HTTP listener (no supertest — raw http, mirroring
 *     test-ui-server.js) with an injectable createPipeline stub: the first
 *     POST /run claims the active-run pointer and answers 200 with the
 *     claimed runId; a second POST while that pointer is still held is
 *     refused with 409 {error, activeRun} and does NOT construct a second
 *     pipeline; after the pointer is cleared, a new POST succeeds with a
 *     fresh claim.
 * (d) a createPipeline stub whose run() rejects before ever bootstrapping a
 *     run dir must have its claim hygiene kick in: once the fire-and-forget
 *     rejection settles, the pointer is cleared because
 *     resolveActiveHarnessDir(root) cannot validate any run dir.
 * (e)/(f) drive src/orchestrator/core/pipeline.js's Pipeline.run() directly
 *     (no HTTP): with a matching opts.preclaimedRun, run() must skip
 *     re-claiming the pointer and bootstrap the given runId; without it,
 *     run() must keep the pre-existing behavior of claiming a freshly
 *     generated runId and bootstrapping normally.
 *
 * No Claude auth, no SDK — every agent/gate seam is stubbed. Every fixture
 * root is an isolated fs.mkdtemp() directory, cleaned up in a finally block.
 *
 * Clears CC_ORCH_ACTIVE_RUN unconditionally at module top (mirroring
 * scripts/run-tests.js and test-runid-flip.js) so this suite is
 * re-entrancy-neutral regardless of launch context.
 *
 * Run: node test/test-webhook-claim.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import assert from 'assert';

import { buildWebhookApp } from '../src/triggers/webhook.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import {
  generateRunId,
  runHarnessDir,
  claimActiveRun,
  readActiveRunPointer,
  clearActiveRunPointer,
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

function createRoot(prefix = 'webhook-claim-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeSpecFixture(root, filename, content) {
  const specPath = path.join(root, filename);
  fs.writeFileSync(specPath, content ?? `# ${filename}\n\nGoal.\n`, 'utf8');
  return specPath;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds an injectable createPipeline stub: each call records {root, hooks}
 * on stub.calls and returns a minimal pipeline-shaped object whose run()
 * delegates to runImpl (so the webhook's fire-and-forget .then/.catch wiring
 * can be exercised without any real planning/execution work).
 */
function makeStubCreatePipeline(runImpl) {
  const createPipeline = (root, hooks) => {
    createPipeline.calls.push({ root, hooks });
    return {
      autoFromHere: false,
      run: runImpl,
    };
  };
  createPipeline.calls = [];
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

function cannedGlobalPlan() {
  return {
    milestones: [
      { id: '001', description: 'Test milestone', missions: [{ id: '001-001', description: 'Test mission' }] },
    ],
    assumptions: [],
    scopeItems: [],
    scopeMapping: [],
  };
}

/**
 * Build a Pipeline whose run() reaches the post-bootstrap/_repointHarness
 * success path without doing any real planning/execution work (mirrors
 * test-runid-flip.js's makeRunnablePipeline).
 */
function makeRunnablePipeline(projectRoot, extraOpts = {}) {
  const pipeline = new Pipeline(projectRoot, {
    onLog: () => {},
    onConfirm: async () => true,
    ...extraOpts,
  });
  pipeline.planner.planGlobal = async () => cannedGlobalPlan();
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._remediateAssumptions = async () => ({ passed: true });
  pipeline._scopeCoverageGate = async () => {};
  pipeline._detectUncheckableSpec = () => {};
  pipeline._executeAllMilestones = async () => {};
  pipeline._reviewGate = async () => {};
  pipeline._runFinalTestGate = () => {};
  return pipeline;
}

// ---------- (a)(b)(c) webhook claim / refuse-while-held / clear-then-reclaim ----------

await test('(a)(b)(c) POST /run claims the pointer, a second POST is refused 409 while held, and a new POST succeeds after the pointer is cleared', async () => {
  const root = createRoot();
  let server;
  try {
    const createPipeline = makeStubCreatePipeline(async () => {});
    const baselineGate = async () => ({ ok: true, skipped: [] });
    const app = buildWebhookApp({ projectRoot: root, createPipeline, baselineGate });
    server = app.listen(0);
    const port = server.address().port;

    // (a) first POST /run claims the pointer and answers 200 with that runId.
    const first = await postJson(port, '/run', { goal: 'Build the thing' });
    assert.strictEqual(first.statusCode, 200, `expected 200, got ${first.statusCode}: ${JSON.stringify(first.body)}`);
    assert.ok(
      first.body && typeof first.body.runId === 'string' && first.body.runId.length > 0,
      `response should include a non-empty runId, got: ${JSON.stringify(first.body)}`
    );
    assert.strictEqual(first.body.status, 'started', "response status should be 'started'");
    const pointerAfterFirst = readActiveRunPointer(root);
    assert.ok(pointerAfterFirst, 'the active-run pointer should be claimed after the first POST /run');
    assert.strictEqual(pointerAfterFirst.runId, first.body.runId, 'the claimed pointer runId should match the response runId');
    assert.strictEqual(createPipeline.calls.length, 1, 'createPipeline should have been invoked exactly once by the first POST');

    // (b) a second POST /run while the pointer is still held is refused.
    const second = await postJson(port, '/run', { goal: 'Build another thing' });
    assert.strictEqual(second.statusCode, 409, `expected 409, got ${second.statusCode}: ${JSON.stringify(second.body)}`);
    assert.ok(
      second.body && typeof second.body.error === 'string' && second.body.error.length > 0,
      `the 409 body should include a non-empty error message, got: ${JSON.stringify(second.body)}`
    );
    assert.ok(
      second.body && second.body.activeRun && typeof second.body.activeRun === 'object',
      `the 409 body should include the activeRun pointer, got: ${JSON.stringify(second.body)}`
    );
    assert.strictEqual(
      createPipeline.calls.length,
      1,
      'createPipeline call-count should stay at 1 after the refused second POST (no second pipeline constructed)'
    );
    const pointerAfterSecond = readActiveRunPointer(root);
    assert.ok(pointerAfterSecond, 'the pointer should still be present after the refused second POST');
    assert.strictEqual(
      pointerAfterSecond.runId,
      pointerAfterFirst.runId,
      'the held pointer must be undisturbed (same runId) by the refused second POST'
    );

    // (c) after clearing the pointer, a new POST /run succeeds with a fresh claim.
    clearActiveRunPointer(root);
    assert.strictEqual(readActiveRunPointer(root), null, 'sanity: pointer should be null after clearActiveRunPointer');

    const third = await postJson(port, '/run', { goal: 'Build yet another thing' });
    assert.strictEqual(third.statusCode, 200, `expected 200, got ${third.statusCode}: ${JSON.stringify(third.body)}`);
    assert.ok(
      third.body && typeof third.body.runId === 'string' && third.body.runId.length > 0,
      `the new POST should return a non-empty runId, got: ${JSON.stringify(third.body)}`
    );
    assert.strictEqual(
      createPipeline.calls.length,
      2,
      'createPipeline should have been invoked a second time after the pointer was cleared'
    );
    const pointerAfterThird = readActiveRunPointer(root);
    assert.ok(pointerAfterThird, 'a fresh pointer should be claimed after the third POST');
    assert.strictEqual(
      pointerAfterThird.runId,
      third.body.runId,
      "the freshly-claimed pointer's runId should match the third response's runId"
    );
    assert.notStrictEqual(
      pointerAfterThird.runId,
      pointerAfterFirst.runId,
      'the fresh pointer runId should differ from the original claim'
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    cleanup(root);
  }
});

// ---------- (d) rejecting run() before a run dir exists clears the claim ----------

await test('(d) pipeline.run() rejecting before a run dir exists clears the active-run claim', async () => {
  const root = createRoot();
  let server;
  try {
    // Use a deferred/controllable promise (rather than an immediately-
    // rejecting async function) so the claim-is-held sanity check below is
    // observed BEFORE the rejection is triggered — an immediate rejection's
    // microtask can settle the fire-and-forget .catch() (and clear the
    // pointer) faster than the HTTP response round-trip completes, which
    // would make the "still claimed" sanity check racy/flaky.
    let rejectRun;
    const runPromise = new Promise((_resolve, reject) => { rejectRun = reject; });
    const createPipeline = makeStubCreatePipeline(() => runPromise);
    const baselineGate = async () => ({ ok: true, skipped: [] });
    const app = buildWebhookApp({ projectRoot: root, createPipeline, baselineGate });
    server = app.listen(0);
    const port = server.address().port;

    const res = await postJson(port, '/run', { goal: 'Build a doomed thing' });
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.ok(
      readActiveRunPointer(root),
      'sanity: the pointer should be claimed synchronously before the fire-and-forget run() settles'
    );
    assert.strictEqual(
      resolveActiveHarnessDir(root),
      null,
      'sanity: no run dir was ever bootstrapped, so resolveActiveHarnessDir should be null'
    );

    // Deliberately never bootstraps/creates a run dir before rejecting, so
    // resolveActiveHarnessDir(root) can never validate a run dir.
    rejectRun(new Error('simulated pipeline failure before bootstrap'));

    // Give the fire-and-forget rejection's .catch handler a chance to settle.
    for (let i = 0; i < 40 && readActiveRunPointer(root) !== null; i++) {
      await wait(25);
    }

    assert.strictEqual(
      readActiveRunPointer(root),
      null,
      'the claim should be cleared once the rejecting run() settles, since resolveActiveHarnessDir(root) is null'
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    cleanup(root);
  }
});

// ---------- (e) run() with a matching preclaimedRun skips re-claim and bootstraps the given id ----------

await test('(e) run() with opts.preclaimedRun matching the on-disk pointer skips re-claim and bootstraps the given runId', async () => {
  const root = createRoot();
  try {
    const slug = 'preclaimed-project';
    const runId = generateRunId(slug);
    const claimed = claimActiveRun(root, { runId, slug, kind: 'run' });
    assert.ok(claimed, 'sanity: claimActiveRun should succeed for a fresh root');

    const specPath = writeSpecFixture(root, 'spec.md', '# Preclaimed Spec\n\nGoal.\n');
    const pipeline = makeRunnablePipeline(root);

    await pipeline.run('Build the preclaimed thing', {
      prdPath: specPath,
      preclaimedRun: { runId, slug },
    });

    const expectedDir = runHarnessDir(root, runId);
    assert.strictEqual(
      pipeline.harnessDir,
      expectedDir,
      'pipeline.harnessDir should be bootstrapped/repointed to the preclaimed runId'
    );
    assert.ok(fs.existsSync(path.join(expectedDir, 'state.json')), 'state.json should exist under the preclaimed run dir');

    const pointerAfter = readActiveRunPointer(root);
    assert.ok(pointerAfter, 'the pointer should still be present after run() with a matching preclaimedRun');
    assert.strictEqual(pointerAfter.runId, runId, 'run() must not have re-claimed/changed the pointer runId');
  } finally {
    cleanup(root);
  }
});

// ---------- (f) run() without opts.preclaimedRun spot-pins existing claim behavior ----------

await test('(f) run() without opts.preclaimedRun claims a freshly generated runId and bootstraps the harness (existing behavior spot-pinned)', async () => {
  const root = createRoot();
  try {
    const specPath = writeSpecFixture(root, 'spec.md', '# Fresh Spec\n\nGoal.\n');
    const pipeline = makeRunnablePipeline(root);

    await pipeline.run('Build a fresh thing', { prdPath: specPath });

    const pointerAfter = readActiveRunPointer(root);
    assert.ok(
      pointerAfter && typeof pointerAfter.runId === 'string' && pointerAfter.runId.length > 0,
      'a freshly generated runId should be claimed'
    );

    const expectedDir = runHarnessDir(root, pointerAfter.runId);
    assert.strictEqual(
      pipeline.harnessDir,
      expectedDir,
      'pipeline.harnessDir should be bootstrapped at the freshly claimed runId dir'
    );
    assert.ok(fs.existsSync(path.join(expectedDir, 'state.json')), 'state.json should exist under the freshly-claimed run dir');
  } finally {
    cleanup(root);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
