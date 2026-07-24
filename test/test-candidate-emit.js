#!/usr/bin/env node
/**
 * test-candidate-emit.js — Integration coverage for the brainstorm-candidate
 * ledger (archives/candidates.jsonl) emitted by Pipeline.batchResume's
 * terminal-failure legs (src/orchestrator/core/pipeline.js + src/orchestrator/
 * core/candidates-ledger.js).
 *
 * Drives the REAL Pipeline.batchResume against a temp git repo (mirroring
 * test/test-batch-resume.js TC12/TC12b) via the shared batch-test fixture
 * harness in test/helpers/batch-fixtures.js — no live LLM sessions.
 *
 * Coverage:
 *   TC1 — a failed-test-gate leg (archive() throws TestGateError on the
 *         success-path auto:true call) writes EXACTLY ONE new
 *         archives/candidates.jsonl line whose signature is the four-field
 *         {phase, errorClass, analyzerRecommendation, taskState} object with
 *         phase 'failed-test-gate' and errorClass 'TestGateError' (matching
 *         err.constructor.name); the queue entry's status is
 *         'failed-test-gate'.
 *   TC2 — a failed-execution leg (_executeAllMilestones throws a generic
 *         Error) writes EXACTLY ONE new candidates.jsonl line with
 *         signature.phase 'failed-execution' and signature.errorClass
 *         matching the thrown error's constructor name ('Error'); the queue
 *         entry's status is 'failed-execution'.
 *   TC3 — a pending-leg guard: an InfrastructureError thrown from
 *         _executeAllMilestones (the timeout/infra arm) leaves the entry
 *         'pending' and writes ZERO candidates.jsonl lines (no ledger file
 *         at all).
 *   TC4 — sanity: the existing batchResume test family (test-batch-resume.js)
 *         still passes unmodified when run standalone.
 *
 * Run: node test/test-candidate-emit.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { readQueueEntry } from '../src/orchestrator/core/state.js';
import { TestGateError } from '../src/cli/commands/archive.js';
import { InfrastructureError } from '../src/orchestrator/infra/session-manager.js';
import { candidatesLedgerPath } from '../src/orchestrator/core/candidates-ledger.js';
import {
  makeGitRoot,
  cleanup,
  makeFakeArchive,
  makePlan,
  createQueueEntry,
  makeRealBatchPipeline,
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

/** Read archives/candidates.jsonl as an array of parsed records ([] when absent). */
function readCandidateLines(root) {
  const p = candidatesLedgerPath(root);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  return raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

// ── TC1 ───────────────────────────────────────────────────────────────────────
// failed-test-gate leg: archive() throws TestGateError on the success-path
// (auto:true) call — no forensic (include-failed) re-archive is reached on
// this leg, so the injected archive() only needs to handle the auto call.

await test('TC1: failed-test-gate leg writes exactly one candidates.jsonl line', async () => {
  const root = makeGitRoot({ prefix: 'cc-candidate-emit-' });
  const slug = 'test-gate-fail-spec';
  try {
    createQueueEntry(root, slug, { plan: makePlan() });

    const { pipeline } = makeRealBatchPipeline(root, {
      archive: async (_projectRoot, _slug, opts) => {
        if (opts?.auto) {
          throw new TestGateError(
            'npm run test:all failed\n--- tail of test output ---\n[FAIL] some test\nTotal: 1 failed, 1 total',
          );
        }
        throw new Error('TC1: forensic archive() must not be called on the failed-test-gate leg');
      },
      executeAllMilestones: async () => {
        fs.writeFileSync(path.join(root, 'deliverable.txt'), 'work\n');
      },
    });

    const result = await pipeline.batchResume({});

    const entry = readQueueEntry(root, slug);
    assert.ok(entry !== null, 'TC1: queue entry should still exist');
    assert.strictEqual(entry.status, 'failed-test-gate',
      `TC1: expected status 'failed-test-gate', got '${entry.status}'`);
    assert.strictEqual(result.failed, 1, `TC1: expected failed:1, got ${result.failed}`);

    const lines = readCandidateLines(root);
    assert.strictEqual(lines.length, 1,
      `TC1: expected exactly one candidates.jsonl line, got ${lines.length}`);

    const record = lines[0];
    const sigKeys = Object.keys(record.signature).sort();
    assert.deepStrictEqual(sigKeys, ['analyzerRecommendation', 'errorClass', 'phase', 'taskState'],
      `TC1: signature must be the exact four-field object. Got keys: ${JSON.stringify(sigKeys)}`);
    assert.strictEqual(record.signature.phase, 'failed-test-gate',
      `TC1: expected signature.phase 'failed-test-gate', got '${record.signature.phase}'`);
    assert.strictEqual(record.signature.errorClass, 'TestGateError',
      `TC1: expected signature.errorClass 'TestGateError', got '${record.signature.errorClass}'`);
  } finally {
    cleanup(root);
  }
});

// ── TC2 ───────────────────────────────────────────────────────────────────────
// failed-execution leg: _executeAllMilestones throws a generic Error (mirrors
// test-batch-resume.js TC12).

await test('TC2: failed-execution leg writes exactly one candidates.jsonl line', async () => {
  const root = makeGitRoot({ prefix: 'cc-candidate-emit-' });
  const slug = 'exec-fail-spec';
  try {
    createQueueEntry(root, slug, { plan: makePlan() });

    const { pipeline } = makeRealBatchPipeline(root, {
      archive: makeFakeArchive(),
      executeAllMilestones: async () => {
        fs.writeFileSync(path.join(root, 'half-written.txt'), 'partial\n');
        throw new Error('boom');
      },
    });

    const result = await pipeline.batchResume({});

    const entry = readQueueEntry(root, slug);
    assert.ok(entry !== null, 'TC2: queue entry should still exist');
    assert.strictEqual(entry.status, 'failed-execution',
      `TC2: expected status 'failed-execution', got '${entry.status}'`);
    assert.strictEqual(result.failed, 1, `TC2: expected failed:1, got ${result.failed}`);

    const lines = readCandidateLines(root);
    assert.strictEqual(lines.length, 1,
      `TC2: expected exactly one candidates.jsonl line, got ${lines.length}`);

    const record = lines[0];
    const sigKeys = Object.keys(record.signature).sort();
    assert.deepStrictEqual(sigKeys, ['analyzerRecommendation', 'errorClass', 'phase', 'taskState'],
      `TC2: signature must be the exact four-field object. Got keys: ${JSON.stringify(sigKeys)}`);
    assert.strictEqual(record.signature.phase, 'failed-execution',
      `TC2: expected signature.phase 'failed-execution', got '${record.signature.phase}'`);
    assert.strictEqual(record.signature.errorClass, 'Error',
      `TC2: expected signature.errorClass 'Error', got '${record.signature.errorClass}'`);
  } finally {
    cleanup(root);
  }
});

// ── TC3 ───────────────────────────────────────────────────────────────────────
// pending-leg guard: InfrastructureError (the timeout/infra arm) rethrows
// before any leg-specific status write or ledger emit — the entry stays
// 'pending' and NO candidates.jsonl line is written (mirrors
// test-batch-resume.js TC12b).

await test('TC3: InfrastructureError pending leg writes zero candidates.jsonl lines', async () => {
  const root = makeGitRoot({ prefix: 'cc-candidate-emit-' });
  const slug = 'infra-fail-spec';
  try {
    createQueueEntry(root, slug, { plan: makePlan() });

    const infraErr = new InfrastructureError('network failure', {
      category: 'network',
      retryable: true,
      statusCode: undefined,
      cause: new Error('original network error'),
    });

    const { pipeline } = makeRealBatchPipeline(root, {
      archive: async () => { throw new Error('TC3: archive() must not be called'); },
      executeAllMilestones: async () => { throw infraErr; },
    });

    await assert.rejects(
      () => pipeline.batchResume({}),
      InfrastructureError,
      'TC3: expected batchResume to rethrow InfrastructureError',
    );

    const entry = readQueueEntry(root, slug);
    assert.ok(entry !== null, 'TC3: queue entry should still exist');
    assert.strictEqual(entry.status, 'pending',
      `TC3: entry must remain 'pending'. Got: '${entry.status}'`);

    const lines = readCandidateLines(root);
    assert.strictEqual(lines.length, 0,
      `TC3: expected zero candidates.jsonl lines, got ${lines.length}`);
    assert.ok(!fs.existsSync(candidatesLedgerPath(root)),
      'TC3: candidates.jsonl must not exist at all');
  } finally {
    cleanup(root);
  }
});

// ── TC4 ───────────────────────────────────────────────────────────────────────
// Sanity: the existing batchResume test family still passes unmodified.

await test('TC4: the existing batchResume test family still passes unmodified', async () => {
  const { spawnSync } = await import('child_process');
  const testPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'test-batch-resume.js');
  const result = spawnSync(process.execPath, [testPath], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0,
    `TC4: test-batch-resume.js must exit 0. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
