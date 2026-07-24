/**
 * test-repoint-agent-rewire.js — Pins that Pipeline._repointHarness rewires
 * the five agents' construction-time logger/tokenTracker captures onto the
 * rebuilt instances, so sessions started AFTER a repoint log and account into
 * the NEW harness dir rather than the one current at Pipeline construction.
 *
 * Background (observed live 2026-07-14): a batch process constructed against
 * the flat .harness (no active-run pointer) repointed per-entry into
 * run-{id}/ dirs, but the five agents kept their construction-time
 * logger/tokenTracker. The batch's 34 sessions ($29.27) logged and accounted
 * into the flat .harness/logs while the archive's run-scoped
 * token-usage.json recorded only the summarizer ($0.19).
 *
 * C1 (identity): after _repointHarness(dirB), each of planner/executor/
 *     verifier/analyzer/reviewer has agent.logger === pipeline.logger and
 *     agent.tokenTracker === pipeline.tokenTracker (the rebuilt instances),
 *     and NOT the pre-repoint instances captured before the call.
 * C2 (behavioral, logging): a session log created through an agent's logger
 *     after the repoint writes under dirB/logs, not the construction-time dir.
 * C3 (behavioral, accounting): usage recorded through an agent's tokenTracker
 *     after the repoint lands in dirB's logs/token-usage.json, not the
 *     construction-time dir's.
 *
 * Mirrors test-pipeline-repoint.js's fixture + teardown patterns.
 *
 * Run: node test/test-repoint-agent-rewire.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

import { Pipeline } from '../src/orchestrator/core/pipeline.js';

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

function createRoot(prefix = 'repoint-rewire-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Removes every process-level listener a Pipeline registered in its
// constructor, so constructing Pipelines across tests does not accumulate
// listeners (mirrors test-pipeline-repoint.js).
function teardownPipeline(pipeline) {
  if (!pipeline || !pipeline._signalHandlers) return;
  process.removeListener('SIGINT', pipeline._signalHandlers.SIGINT);
  process.removeListener('SIGTERM', pipeline._signalHandlers.SIGTERM);
  process.removeListener('exit', pipeline._signalHandlers.exit);
  process.removeListener('uncaughtException', pipeline._signalHandlers.uncaughtException);
}

const AGENT_KEYS = ['planner', 'executor', 'verifier', 'analyzer', 'reviewer'];

// ---------- C1: identity rewire ----------

await test('C1: every agent.logger/tokenTracker === the rebuilt pipeline instances (not the construction-time ones)', () => {
  const root = createRoot();
  let pipeline;
  try {
    pipeline = new Pipeline(root, { onLog: () => {} });

    // Construction-time captures — what each agent held before the repoint.
    const preLogger = pipeline.logger;
    const preTokenTracker = pipeline.tokenTracker;
    // Sanity: agents actually captured the construction-time instances.
    for (const key of AGENT_KEYS) {
      assert.strictEqual(pipeline[key].logger, preLogger, `sanity: ${key}.logger must start as the construction-time logger`);
      assert.strictEqual(pipeline[key].tokenTracker, preTokenTracker, `sanity: ${key}.tokenTracker must start as the construction-time tokenTracker`);
    }

    const dirB = path.join(root, '.harness', 'run-c1-repointed');
    pipeline._repointHarness(dirB);

    // The rebuild replaced pipeline.logger/tokenTracker with fresh instances.
    assert.notStrictEqual(pipeline.logger, preLogger, 'sanity: pipeline.logger must be rebuilt');
    assert.notStrictEqual(pipeline.tokenTracker, preTokenTracker, 'sanity: pipeline.tokenTracker must be rebuilt');

    for (const key of AGENT_KEYS) {
      assert.strictEqual(
        pipeline[key].logger,
        pipeline.logger,
        `${key}.logger must be rewired to the rebuilt pipeline.logger`
      );
      assert.strictEqual(
        pipeline[key].tokenTracker,
        pipeline.tokenTracker,
        `${key}.tokenTracker must be rewired to the rebuilt pipeline.tokenTracker`
      );
      assert.notStrictEqual(
        pipeline[key].logger,
        preLogger,
        `${key}.logger must no longer be the pre-repoint (construction-time) logger`
      );
      assert.notStrictEqual(
        pipeline[key].tokenTracker,
        preTokenTracker,
        `${key}.tokenTracker must no longer be the pre-repoint (construction-time) tokenTracker`
      );
    }
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ---------- C2: post-repoint session log lands under dirB ----------

await test("C2: a session log created via an agent's logger after repoint writes under dirB/logs", () => {
  const root = createRoot();
  let pipeline;
  let session;
  try {
    pipeline = new Pipeline(root, { onLog: () => {} });
    const preLogsDir = pipeline.logger.logsDir; // construction-time logs dir

    const dirB = path.join(root, '.harness', 'run-c2-repointed');
    pipeline._repointHarness(dirB);

    const expectedLogsDir = path.join(dirB, 'logs');
    // Sanity: pre and post logs dirs are genuinely different targets.
    assert.notStrictEqual(preLogsDir, expectedLogsDir, 'sanity: construction-time and post-repoint logs dirs must differ');

    // Create a real session log through the VERIFIER's logger (not the
    // pipeline's directly) — this is what a post-repoint agent session does.
    session = pipeline.verifier.logger.createSessionLog('probe');
    assert.ok(session && session.logPath, 'createSessionLog must return a logPath');

    assert.ok(
      session.logPath.startsWith(expectedLogsDir + path.sep),
      `session logPath must be under the post-repoint dir ${expectedLogsDir}, got: ${session.logPath}`
    );
    assert.ok(
      !session.logPath.startsWith(preLogsDir + path.sep),
      `session logPath must NOT be under the construction-time dir ${preLogsDir}, got: ${session.logPath}`
    );
  } finally {
    try { session && session.close && session.close(); } catch { /* ignore */ }
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ---------- C3: post-repoint usage lands in dirB's token-usage.json ----------

await test("C3: usage recorded via an agent's tokenTracker after repoint lands in dirB's token-usage.json, not the construction-time dir's", async () => {
  const root = createRoot();
  let pipeline;
  try {
    pipeline = new Pipeline(root, { onLog: () => {} });
    const preUsagePath = pipeline.tokenTracker.usagePath; // construction-time token-usage.json

    const dirB = path.join(root, '.harness', 'run-c3-repointed');
    pipeline._repointHarness(dirB);

    const expectedUsagePath = path.join(dirB, 'logs', 'token-usage.json');
    // Sanity: pre and post usage paths are genuinely different targets.
    assert.notStrictEqual(preUsagePath, expectedUsagePath, 'sanity: construction-time and post-repoint usage paths must differ');

    // Minimal fake sdkResult in the shape recordSession expects: usage frame
    // + total_cost_usd (see TokenTracker.recordSession in token-tracker.js).
    const fakeSdkResult = {
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      total_cost_usd: 3.14,
    };

    // Record through the EXECUTOR's tokenTracker — what a post-repoint agent
    // session finalization does.
    await pipeline.executor.tokenTracker.recordSession('probe-session', 'executor', fakeSdkResult);

    assert.ok(
      fs.existsSync(expectedUsagePath),
      `token-usage.json must be written under the post-repoint dir: ${expectedUsagePath}`
    );
    const recorded = JSON.parse(fs.readFileSync(expectedUsagePath, 'utf8'));
    const entries = Array.isArray(recorded) ? recorded : recorded.sessions;
    assert.ok(
      Array.isArray(entries) && entries.some((e) => e.name === 'probe-session' && e.totalCostUsd === 3.14),
      `post-repoint token-usage.json must contain the recorded session ($3.14), got: ${JSON.stringify(recorded)}`
    );

    // The construction-time dir's token-usage.json must NOT have received it.
    if (fs.existsSync(preUsagePath)) {
      const preRecorded = JSON.parse(fs.readFileSync(preUsagePath, 'utf8'));
      const preEntries = Array.isArray(preRecorded) ? preRecorded : (preRecorded.sessions || []);
      assert.ok(
        !preEntries.some((e) => e.name === 'probe-session'),
        `construction-time token-usage.json must NOT contain the post-repoint session, but it did: ${preUsagePath}`
      );
    }
  } finally {
    teardownPipeline(pipeline);
    cleanup(root);
  }
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
