#!/usr/bin/env node
/**
 * test-plan-time-disposition.js — Plan-time and mid-entry batch disposition
 * tests (spec: 001-001-002-001).
 *
 * Covers:
 *   (a) A ReusableSession turn whose result event is an is_error transport
 *       failure (duration_api_ms:0 + usage.output_tokens:0) rejects the
 *       awaiting sendPrompt() promise with an InfrastructureError. Driven via
 *       a fake SDK queryFn injected on SessionManager that emits a REAL event
 *       sequence (system → assistant → result) through the production
 *       spawnReusable()/_consumeEvents() path — no hand-called internals.
 *   (b) A normal (is_error:false) result event still resolves the turn
 *       promise with the raw event (regression pin for (a)'s classification).
 *   (c) A batch entry whose planner.planMission throws at the plan-phase
 *       call site (_planAndApproveMission, tagged err.planPhase = true) on a
 *       clean tree lands the entry at status 'failed-plan',
 *       queue/<slug>/plan-failure.txt contains the thrown message, no
 *       forensic archive is written, and the tree is not reverted (no
 *       additional commit, no forensic archive dir).
 *   (d) An UNTAGGED plain Error thrown by a stubbed _executeAllMilestones on
 *       a clean tree still takes the failed-execution arm: a forensic
 *       archive directory is created containing error.txt with the error
 *       message (regression pin for the stub-family test files).
 *   (e) A throwing planner.closeReusableSession does not escape batchResume
 *       — the batch summary/result is still produced.
 *   (f) An InfrastructureError raised mid-entry (via _executeAllMilestones)
 *       leaves that entry's status 'pending' (batch stops, propagates).
 *
 * Run: node test/test-plan-time-disposition.js
 *
 * This suite is NOT a re-entrant cc-orch invocation — every fixture root is
 * an isolated fs.mkdtemp() directory (via makeGitRoot). But when launched
 * from inside a live cc-orch run, CC_ORCH_ACTIVE_RUN would be inherited from
 * the parent process environment and trip the reentrancy guard on the
 * freshly-bootstrapped active roots these fixtures construct. Clear the
 * marker unconditionally here, mirroring scripts/run-tests.js and
 * test/test-batch-revert-and-continue.js.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  SessionManager,
  InfrastructureError,
} from '../src/orchestrator/infra/session-manager.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { readQueueEntry } from '../src/orchestrator/core/state.js';
import {
  makeGitRoot,
  makeFakeArchive,
  makeRealBatchPipeline,
  createQueueEntry,
  cleanup,
  git,
} from './helpers/batch-fixtures.js';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * An async generator that yields a REAL event sequence — a system init
 * event, an assistant message event, then a terminal result event — so the
 * production ReusableSession._consumeEvents dispatch/classification path
 * runs end-to-end (no hand-called internals).
 */
async function* realEventSequence(resultEvent) {
  yield { type: 'system', subtype: 'init' };
  yield {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'working...' }] },
  };
  yield resultEvent;
}

// ---------------------------------------------------------------------------
// Case (a): is_error transport result rejects sendPrompt with InfrastructureError
// ---------------------------------------------------------------------------

await test('(a) transport is_error result event rejects sendPrompt() with InfrastructureError', async () => {
  const sm = new SessionManager();
  sm._queryFn = () => realEventSequence({
    type: 'result',
    is_error: true,
    duration_api_ms: 0,
    usage: { output_tokens: 0 },
    result: 'Request timed out',
  });

  const session = sm.spawnReusable({ name: 'tc-a-reusable' });
  // No await between spawnReusable() and sendPrompt(): the pending-result
  // entry must be queued before the fake generator's first microtask tick
  // delivers the 'result' event, mirroring real production ordering (a real
  // prompt is always sent before the SDK can answer it).
  const turnPromise = session.sendPrompt('hello');

  let rejected = null;
  try {
    await turnPromise;
  } catch (err) {
    rejected = err;
  }

  assert.ok(rejected !== null, 'Expected sendPrompt() turn promise to reject');
  assert.ok(
    rejected instanceof InfrastructureError,
    `Expected InfrastructureError, got ${rejected?.constructor?.name}: ${rejected?.message}`
  );
  assert.strictEqual(rejected.category, 'network', `Expected category 'network', got '${rejected.category}'`);
  assert.strictEqual(rejected.retryable, true, `Expected retryable=true, got ${rejected.retryable}`);

  await session.close().catch(() => {});
});

// ---------------------------------------------------------------------------
// Case (b): normal result resolves the turn promise with the event
// ---------------------------------------------------------------------------

await test('(b) normal (is_error:false) result event resolves sendPrompt() with the event', async () => {
  const sm = new SessionManager();
  const resultEvent = {
    type: 'result',
    is_error: false,
    duration_api_ms: 4200,
    usage: { output_tokens: 128 },
    result: 'All good',
  };
  sm._queryFn = () => realEventSequence(resultEvent);

  const session = sm.spawnReusable({ name: 'tc-b-reusable' });
  const turnPromise = session.sendPrompt('hello');

  const resolved = await turnPromise;
  assert.strictEqual(resolved.type, 'result', `Expected resolved event type 'result', got '${resolved.type}'`);
  assert.strictEqual(resolved.is_error, false, 'Expected resolved event is_error === false');
  assert.strictEqual(resolved.result, 'All good', `Expected resolved.result === 'All good', got '${resolved.result}'`);

  await session.close().catch(() => {});
});

// ---------------------------------------------------------------------------
// Case (c): planMission throw on a clean tree -> failed-plan
// ---------------------------------------------------------------------------

await test("(c) planner.planMission throw on a clean tree lands the entry at 'failed-plan' with plan-failure.txt, no forensic archive, tree not reverted", async () => {
  const root = makeGitRoot();
  try {
    const slug = 'plan-fail-spec';
    const plan = {
      milestones: [
        {
          id: 'ms1',
          description: 'Milestone 1',
          missions: [{ id: 'mi1', description: 'Mission 1' }],
        },
      ],
      assumptions: [],
    };
    createQueueEntry(root, slug, { plan });

    const headBefore = git(['rev-parse', 'HEAD'], root).trim();

    const { pipeline } = makeRealBatchPipeline(root, { archive: makeFakeArchive() });
    // Restore the REAL _executeAllMilestones (the fixture default is a
    // no-op stub) so the real entry-processing path — bootstrap →
    // writeGlobalPlan → _executeAllMilestones → _executeMilestone →
    // _executeMilestoneParallel → _planAndApproveMission — runs and reaches
    // the tag-and-rethrow plan-phase call site.
    pipeline._executeAllMilestones = Pipeline.prototype._executeAllMilestones;
    const planErrMessage = 'planMission boom: cannot decompose mission';
    pipeline.planner.planMission = async () => { throw new Error(planErrMessage); };

    const result = await pipeline.batchResume({ autonomous: true });

    assert.strictEqual(result.failed, 1, `Expected result.failed === 1, got ${result.failed}`);

    const entry = readQueueEntry(root, slug);
    assert.ok(entry !== null, 'Entry should still be in queue');
    assert.strictEqual(entry.status, 'failed-plan', `Expected status 'failed-plan', got '${entry?.status}'`);

    const planFailurePath = path.join(root, 'queue', slug, 'plan-failure.txt');
    assert.ok(fs.existsSync(planFailurePath), 'plan-failure.txt should exist');
    const planFailureContent = fs.readFileSync(planFailurePath, 'utf8');
    assert.ok(
      planFailureContent.includes(planErrMessage),
      `plan-failure.txt should contain the thrown message. Got:\n${planFailureContent}`
    );

    // No forensic archive was written for this leg. The cross-run ledger
    // FILES (candidates.jsonl / warnings.jsonl / usage-ledger.jsonl)
    // legitimately live under archives/ and are not forensic archive dirs —
    // exclude them.
    const archivesDir = path.join(root, 'archives');
    const LEDGER_FILES = new Set(['candidates.jsonl', 'warnings.jsonl', 'usage-ledger.jsonl']);
    const archiveEntries = (fs.existsSync(archivesDir) ? fs.readdirSync(archivesDir) : [])
      .filter((e) => !LEDGER_FILES.has(e));
    assert.strictEqual(
      archiveEntries.length, 0,
      `Expected no forensic archive dir, found: [${archiveEntries.join(', ')}]`
    );

    // Tree not reverted: no additional commit was made (no spec-boundary
    // commit, no forensic park-commit) — HEAD is unchanged from baseline —
    // and the working tree is clean (nothing to revert; this leg is
    // explicitly ahead of the forensic-archive/revert code, which never runs
    // on it).
    const headAfter = git(['rev-parse', 'HEAD'], root).trim();
    assert.strictEqual(headAfter, headBefore, 'HEAD should be unchanged — no commit/revert cycle ran');
    const porcelainAfter = git(['status', '--porcelain'], root).trim();
    assert.strictEqual(porcelainAfter, '', `Expected a clean working tree after the run, got:\n${porcelainAfter}`);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Case (d): untagged Error from _executeAllMilestones -> failed-execution
// ---------------------------------------------------------------------------

await test('(d) an untagged plain Error from a stubbed _executeAllMilestones on a clean tree takes the failed-execution arm with a forensic archive containing error.txt', async () => {
  const root = makeGitRoot();
  try {
    const slug = 'exec-fail-spec';
    createQueueEntry(root, slug);

    const execErrMessage = 'plain execution failure: no error tag';
    const { pipeline } = makeRealBatchPipeline(root, {
      archive: makeFakeArchive(),
      executeAllMilestones: async () => { throw new Error(execErrMessage); },
    });

    const result = await pipeline.batchResume({ autonomous: true });

    assert.strictEqual(result.failed, 1, `Expected result.failed === 1, got ${result.failed}`);

    const entry = readQueueEntry(root, slug);
    assert.ok(entry !== null, 'Entry should still be in queue');
    assert.strictEqual(entry.status, 'failed-execution', `Expected status 'failed-execution', got '${entry?.status}'`);

    const archiveDir = path.join(root, 'archives', slug);
    assert.ok(fs.existsSync(archiveDir), `Expected forensic archive dir at ${archiveDir}`);
    const errorTxtPath = path.join(archiveDir, 'error.txt');
    assert.ok(fs.existsSync(errorTxtPath), 'Expected error.txt in the forensic archive dir');
    const errorTxtContent = fs.readFileSync(errorTxtPath, 'utf8');
    assert.ok(
      errorTxtContent.includes(execErrMessage),
      `error.txt should contain the error message. Got:\n${errorTxtContent}`
    );
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Case (e): throwing closeReusableSession does not escape batchResume
// ---------------------------------------------------------------------------

await test('(e) a throwing closeReusableSession does not escape batchResume — the batch summary is still produced', async () => {
  const root = makeGitRoot();
  try {
    const slug = 'close-throw-spec';
    createQueueEntry(root, slug);

    const { pipeline } = makeRealBatchPipeline(root, { archive: makeFakeArchive() });
    pipeline.planner.closeReusableSession = async () => { throw new Error('close boom'); };

    const result = await pipeline.batchResume({ autonomous: true });

    assert.ok(result !== undefined, 'batchResume must still return a result object');
    assert.strictEqual(result.archived, 1, `Expected result.archived === 1, got ${result.archived}`);
    assert.strictEqual(result.failed, 0, `Expected result.failed === 0, got ${result.failed}`);
    assert.strictEqual(readQueueEntry(root, slug), null, 'Entry should be archived/removed from queue');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Case (f): InfrastructureError mid-entry leaves the entry pending
// ---------------------------------------------------------------------------

await test('(f) an InfrastructureError raised mid-entry leaves that entry pending and stops the batch', async () => {
  const root = makeGitRoot();
  try {
    const slug = 'infra-mid-entry-spec';
    createQueueEntry(root, slug);

    const infraErr = new InfrastructureError('rate limited mid-entry', {
      category: 'rate_limit',
      retryable: true,
      statusCode: 429,
      cause: new Error('upstream 429'),
    });

    const { pipeline } = makeRealBatchPipeline(root, {
      archive: makeFakeArchive(),
      executeAllMilestones: async () => { throw infraErr; },
    });

    await assert.rejects(
      () => pipeline.batchResume({ autonomous: true }),
      (err) => err instanceof InfrastructureError && err.category === 'rate_limit'
    );

    const entry = readQueueEntry(root, slug);
    assert.ok(entry !== null, 'Entry should still be in queue');
    assert.strictEqual(entry.status, 'pending', `Expected status 'pending', got '${entry?.status}'`);

    // No forensic archive should have been created for an infra halt.
    const archivesDir = path.join(root, 'archives');
    const archiveEntries = fs.existsSync(archivesDir) ? fs.readdirSync(archivesDir) : [];
    assert.strictEqual(
      archiveEntries.length, 0,
      `Expected no archive dir for an infrastructure halt, found: [${archiveEntries.join(', ')}]`
    );
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
