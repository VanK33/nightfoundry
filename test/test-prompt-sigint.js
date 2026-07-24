#!/usr/bin/env node
/**
 * test-prompt-sigint.js — Tests for the W2-F2 prompt Ctrl-C deadlock kill
 * (spec: prompt-sigint-interrupt).
 *
 * Written INDEPENDENTLY from the spec's acceptance criteria — assertions
 * derive from the spec contracts, not from the in-flight implementation.
 *
 * Coverage (numbered after the spec's acceptance criteria):
 *   TC1  — ^C (0x03) during askYesNo rejects with UserInterruptError
 *          promptly (no deadlock); statusBar.promptDidEnd fires exactly once.
 *          RED at pre-fix HEAD: the promise never settles there — the
 *          settle-within-timeout race turns the deadlock into a clean FAIL.
 *   TC2  — same contract for askMenu fixed-choice mode.
 *   TC3  — same contract for askMenu free-text mode (options = null).
 *   TC4  — regression pin (green pre/post): invalid input gets a visible
 *          re-ask (question text re-renders, invalid-input notice printed)
 *          and a subsequent valid answer resolves normally.
 *   TC5  — no SIGINT-handler interference: normal y/n and menu answers
 *          resolve exactly as before, both with terminal:true and with the
 *          default terminal detection (PassThrough → non-terminal mode);
 *          a 0x03 arriving AFTER settlement causes no second settlement
 *          (promptDidEnd stays at exactly 1).
 *   TC6  — batch abort: a UserInterruptError thrown during entry 1 of 2 is
 *          rethrown out of batchResume; entry 1's queue status unchanged
 *          ('pending'), entry 2 never started, no failed-execution/halted-*
 *          status write, no forensic archive call; the outer finally
 *          (closeReusableSession) still runs.
 *   TC7a — UserInterruptError instanceof HaltError, site 'user-interrupt',
 *          own message (not HaltError's generic "Auto mode encountered halt
 *          site…" text); if REVIEW_GATE_HALT_SITES is exported, it must not
 *          include 'user-interrupt'.
 *   TC7b — behavioral pin of the REVIEW_GATE_HALT_SITES contract: a
 *          UserInterruptError thrown from the review gate in batch is an
 *          ABORT (rethrown, status unchanged), not a 'halted-review' park.
 *
 * Run: node test/test-prompt-sigint.js
 *
 * Stubbing discipline (per spec): only trigger conditions are faked — fake
 * streams + terminal:true + 0x03 bytes + a fake statusBar with call
 * counters; readline itself and the prompt functions' internals are never
 * stubbed. Batch tests stub only the per-entry execution trigger
 * (_executeAllMilestones / _reviewGate throwing), never the park/batch layer.
 *
 * Probe-verified (2026-06-11, this session, mirrors the spec's probe):
 * readline with terminal:true + PassThrough streams emits 'SIGINT' on a
 * 0x03 byte — no PTY needed; in default (non-terminal) detection a 0x03 is
 * a dead byte and the question callback never fires (the pre-fix deadlock
 * shape). Every async case is raced against a timeout so a pre-fix
 * deadlock surfaces as a clean FAIL, never a hang.
 *
 * NOTE: registration in scripts/run-tests.js is the implementation side's
 * task (spec scope item 4); this file is standalone-runnable.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PassThrough } from 'stream';
import { execSync } from 'child_process';
import { askYesNo, askMenu } from '../src/cli/prompt.js';
import { writeQueueEntry, readQueueEntry } from '../src/orchestrator/core/state.js';

// Dynamic imports so a missing UserInterruptError export (pre-fix HEAD)
// produces honest per-test FAILs instead of a module-link crash of the
// whole file.
const haltErrorMod = await import('../src/orchestrator/core/halt-error.js');
const { HaltError } = haltErrorMod;
const UserInterruptError = haltErrorMod.UserInterruptError; // undefined pre-fix
const pipelineMod = await import('../src/orchestrator/core/pipeline.js');
const { Pipeline } = pipelineMod;

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ── Deadlock-proofing helpers ──────────────────────────────────────────────

const PROMPT_SETTLE_MS = 1000;   // spec: "settles within a short timeout"
const BATCH_SETTLE_MS = 30000;   // batch fixture does real git + bootstrap work

/**
 * Race a promise against a timeout. Never rejects on settlement — returns
 * { status: 'resolved', value } or { status: 'rejected', error }. Throws
 * (→ test FAIL) only when the promise does not settle in time, which is
 * exactly the pre-fix W2-F2 deadlock shape.
 */
function settleWithin(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `${label} did not settle within ${ms}ms — prompt deadlock (pre-fix W2-F2 shape?)`
      ));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve({ status: 'resolved', value }); },
      (error) => { clearTimeout(timer); resolve({ status: 'rejected', error }); }
    );
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeLater(stream, data, ms) {
  setTimeout(() => stream.write(data), ms);
}

// ── Fakes (trigger conditions only) ────────────────────────────────────────

function makeFakeStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let captured = '';
  output.on('data', (chunk) => { captured += chunk.toString(); });
  return { input, output, getOutput: () => captured };
}

function makeFakeStatusBar() {
  const calls = { promptWillStart: 0, promptDidEnd: 0 };
  return {
    calls,
    promptWillStart() { calls.promptWillStart += 1; },
    promptDidEnd() { calls.promptDidEnd += 1; },
  };
}

/**
 * Shared assertions for the Ctrl-C interrupt contract (TC1–TC3): the
 * promise must REJECT (not resolve) with a UserInterruptError (site
 * 'user-interrupt', instanceof HaltError) within PROMPT_SETTLE_MS, and the
 * statusBar cleanup must have run exactly once.
 */
async function assertInterrupted(promise, statusBar, label) {
  const settled = await settleWithin(promise, PROMPT_SETTLE_MS, label);
  assert.strictEqual(settled.status, 'rejected',
    `${label}: expected REJECTION on ^C, but the promise resolved with ${JSON.stringify(settled.value)}`);
  const err = settled.error;
  assert.ok(err instanceof Error, `${label}: rejection value must be an Error, got ${typeof err}`);
  assert.ok(err instanceof HaltError,
    `${label}: rejection must be instanceof HaltError (got ${err.constructor && err.constructor.name}: ${err.message})`);
  assert.strictEqual(err.site, 'user-interrupt',
    `${label}: rejection .site must be 'user-interrupt', got '${err.site}'`);
  assert.strictEqual(typeof UserInterruptError, 'function',
    `${label}: UserInterruptError must be exported from src/orchestrator/core/halt-error.js`);
  assert.ok(err instanceof UserInterruptError,
    `${label}: rejection must be instanceof UserInterruptError`);
  // Give any erroneous second settlement / second cleanup a beat to fire.
  await delay(50);
  assert.strictEqual(statusBar.calls.promptDidEnd, 1,
    `${label}: statusBar.promptDidEnd must fire exactly once, got ${statusBar.calls.promptDidEnd}`);
  assert.strictEqual(statusBar.calls.promptWillStart, 1,
    `${label}: statusBar.promptWillStart must have fired exactly once, got ${statusBar.calls.promptWillStart}`);
}

const MENU_OPTIONS = [
  { key: 'a', label: 'apply' },
  { key: 's', label: 'skip' },
];

// ── TC1: ^C during askYesNo ────────────────────────────────────────────────

await test('TC1: ^C (0x03) during askYesNo rejects with UserInterruptError promptly; promptDidEnd exactly once', async () => {
  const { input, output } = makeFakeStreams();
  const statusBar = makeFakeStatusBar();
  const promise = askYesNo('Proceed with mission 001-002? (y/n) ', {
    input, output, terminal: true, statusBar,
  });
  writeLater(input, '\x03', 20);
  await assertInterrupted(promise, statusBar, 'askYesNo ^C');
});

// ── TC2: ^C during askMenu fixed-choice mode ───────────────────────────────

await test('TC2: ^C during askMenu (fixed-choice) rejects with UserInterruptError promptly; promptDidEnd exactly once', async () => {
  const { input, output } = makeFakeStreams();
  const statusBar = makeFakeStatusBar();
  const promise = askMenu('Choose action: ', MENU_OPTIONS, {
    input, output, terminal: true, statusBar,
  });
  writeLater(input, '\x03', 20);
  await assertInterrupted(promise, statusBar, 'askMenu fixed-choice ^C');
});

// ── TC3: ^C during askMenu free-text mode ──────────────────────────────────

await test('TC3: ^C during askMenu (free-text, options=null) rejects with UserInterruptError promptly; promptDidEnd exactly once', async () => {
  const { input, output } = makeFakeStreams();
  const statusBar = makeFakeStatusBar();
  const promise = askMenu('Enter replacement text: ', null, {
    input, output, terminal: true, statusBar,
  });
  writeLater(input, '\x03', 20);
  await assertInterrupted(promise, statusBar, 'askMenu free-text ^C');
});

// ── TC4: regression pin — invalid input re-asks visibly, then resolves ─────

await test('TC4: askYesNo invalid input → visible re-ask (notice + question re-rendered), then valid answer resolves true (green pre/post)', async () => {
  const QUESTION = 'Proceed with mission 001-002? (y/n) ';
  const { input, output, getOutput } = makeFakeStreams();
  const statusBar = makeFakeStatusBar();
  const promise = askYesNo(QUESTION, { input, output, terminal: true, statusBar });
  writeLater(input, 'x\n', 20);
  writeLater(input, 'y\n', 120);

  const settled = await settleWithin(promise, PROMPT_SETTLE_MS, 'askYesNo invalid-then-valid');
  assert.strictEqual(settled.status, 'resolved',
    `expected resolution, got rejection: ${settled.status === 'rejected' ? settled.error.message : ''}`);
  assert.strictEqual(settled.value, true,
    `'y' after an invalid answer must resolve true, got ${JSON.stringify(settled.value)}`);

  const out = getOutput();
  assert.ok(out.includes('Please answer "y" or "n"'),
    `output must contain the invalid-input notice (got: ${JSON.stringify(out.slice(0, 300))})`);
  const renders = out.split(QUESTION.trim()).length - 1;
  assert.ok(renders >= 2,
    `question text must appear at least twice (re-render after invalid input); appeared ${renders} time(s)`);
  assert.strictEqual(statusBar.calls.promptDidEnd, 1,
    `promptDidEnd must fire exactly once on the normal path, got ${statusBar.calls.promptDidEnd}`);
});

// ── TC5: no SIGINT-handler interference on normal answers ──────────────────

await test('TC5a: askYesNo normal "y" resolves true with terminal:true; late ^C after settlement causes no second settlement', async () => {
  const { input, output } = makeFakeStreams();
  const statusBar = makeFakeStatusBar();
  const promise = askYesNo('Proceed? (y/n) ', { input, output, terminal: true, statusBar });
  writeLater(input, 'y\n', 20);
  const settled = await settleWithin(promise, PROMPT_SETTLE_MS, 'askYesNo normal y (terminal:true)');
  assert.strictEqual(settled.status, 'resolved',
    `expected resolution, got rejection: ${settled.status === 'rejected' ? settled.error.message : ''}`);
  assert.strictEqual(settled.value, true, `'y' must resolve true, got ${JSON.stringify(settled.value)}`);

  // No double settlement / double cleanup: a ^C arriving after the answer
  // already settled must be inert (spec: "no double-resolution").
  input.write('\x03');
  await delay(50);
  assert.strictEqual(statusBar.calls.promptDidEnd, 1,
    `promptDidEnd must stay at exactly 1 after a post-settlement ^C, got ${statusBar.calls.promptDidEnd}`);
});

await test('TC5b: askYesNo normal "y" resolves true WITHOUT terminal option (default detection → non-terminal with PassThrough)', async () => {
  const { input, output } = makeFakeStreams();
  const statusBar = makeFakeStatusBar();
  const promise = askYesNo('Proceed? (y/n) ', { input, output, statusBar });
  writeLater(input, 'y\n', 20);
  const settled = await settleWithin(promise, PROMPT_SETTLE_MS, 'askYesNo normal y (default terminal detection)');
  assert.strictEqual(settled.status, 'resolved',
    `expected resolution, got rejection: ${settled.status === 'rejected' ? settled.error.message : ''}`);
  assert.strictEqual(settled.value, true, `'y' must resolve true, got ${JSON.stringify(settled.value)}`);
  assert.strictEqual(statusBar.calls.promptDidEnd, 1,
    `promptDidEnd must fire exactly once, got ${statusBar.calls.promptDidEnd}`);
});

await test('TC5c: askMenu valid key resolves that key with terminal:true', async () => {
  const { input, output } = makeFakeStreams();
  const statusBar = makeFakeStatusBar();
  const promise = askMenu('Choose action: ', MENU_OPTIONS, { input, output, terminal: true, statusBar });
  writeLater(input, 's\n', 20);
  const settled = await settleWithin(promise, PROMPT_SETTLE_MS, 'askMenu valid key (terminal:true)');
  assert.strictEqual(settled.status, 'resolved',
    `expected resolution, got rejection: ${settled.status === 'rejected' ? settled.error.message : ''}`);
  assert.strictEqual(settled.value, 's', `valid key 's' must resolve 's', got ${JSON.stringify(settled.value)}`);
  assert.strictEqual(statusBar.calls.promptDidEnd, 1,
    `promptDidEnd must fire exactly once, got ${statusBar.calls.promptDidEnd}`);
});

await test('TC5d: askMenu valid key resolves that key WITHOUT terminal option (default detection)', async () => {
  const { input, output } = makeFakeStreams();
  const promise = askMenu('Choose action: ', MENU_OPTIONS, { input, output });
  writeLater(input, 'a\n', 20);
  const settled = await settleWithin(promise, PROMPT_SETTLE_MS, 'askMenu valid key (default terminal detection)');
  assert.strictEqual(settled.status, 'resolved',
    `expected resolution, got rejection: ${settled.status === 'rejected' ? settled.error.message : ''}`);
  assert.strictEqual(settled.value, 'a', `valid key 'a' must resolve 'a', got ${JSON.stringify(settled.value)}`);
});

// ── Batch fixture (mirrors test/test-batch-failure-crash-safety.js) ────────

const SPEC_MD = `# Test Spec

This is a test spec for the prompt SIGINT batch-abort path.

## Goals
- Build something useful
`;

const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

function makePlan() {
  // Fresh-run shape: a goal-only plan attaches scopeItems:[]/scopeMapping:[]
  // (the gate skips on present-and-empty). Without the key it would be treated
  // as a LEGACY plan and the scope gate would fail-closed before this test's
  // behavior runs.
  return { milestones: [], assumptions: [], scopeItems: [], scopeMapping: [] };
}

function makeGitRoot(prefix = 'cc-orch-sigint-git-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync('git init', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed content\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'queue/\narchives/\nfake-archives/\n.harness/\n');
  execSync('git add -A', { cwd: root, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: root, stdio: 'pipe' });
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function createQueueEntry(root, slug, { validatedAt = new Date().toISOString() } = {}) {
  writeQueueEntry(root, slug, {
    spec: SPEC_MD,
    plan: makePlan(),
    validatedAt,
    status: 'pending',
    specJson: SPEC_JSON,
  });
}

function makeBatchPipeline(root) {
  const logs = [];
  const archiveCalls = [];
  let executeCallCount = 0;
  let reusableSessionClosed = false;

  const archiveStub = async (_projectRoot, slug, archiveOpts) => {
    archiveCalls.push({ slug, opts: archiveOpts });
    const dir = path.join(root, 'fake-archives', String(archiveCalls.length));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const pipeline = new Pipeline(root, {
    skipWorktreeCreation: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    archive: archiveStub,
  });

  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => { reusableSessionClosed = true; };
  pipeline._executeAllMilestones = async () => { executeCallCount++; };
  pipeline._reviewGate = async () => {};

  return {
    pipeline,
    logs,
    archiveCalls,
    getExecuteCount: () => executeCallCount,
    wasReusableSessionClosed: () => reusableSessionClosed,
  };
}

// ── TC6: batch abort on UserInterruptError ─────────────────────────────────

await test('TC6: batchResume — UserInterruptError during entry 1 of 2 → rethrown, entry 1 status unchanged, entry 2 never started, no status write, no forensic archive', async () => {
  assert.strictEqual(typeof UserInterruptError, 'function',
    'UserInterruptError must be exported from src/orchestrator/core/halt-error.js');
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'intr-a', { validatedAt: '2026-06-01T00:00:00.000Z' });
    createQueueEntry(root, 'intr-b', { validatedAt: '2026-06-02T00:00:00.000Z' });

    const { pipeline, archiveCalls, getExecuteCount, wasReusableSessionClosed } = makeBatchPipeline(root);

    // Trigger only: entry 1's execution path raises the user interrupt
    // (a Ctrl-C at an interactive prompt mid-execution). The batch/park
    // layer itself is NOT stubbed.
    let executeCount = 0;
    pipeline._executeAllMilestones = async () => {
      executeCount++;
      if (executeCount === 1) throw new UserInterruptError();
    };

    const settled = await settleWithin(pipeline.batchResume({}), BATCH_SETTLE_MS, 'batchResume (user interrupt)');
    assert.strictEqual(settled.status, 'rejected',
      `batchResume must RETHROW the user interrupt (abort), but it resolved with ${JSON.stringify(settled.value)}`);
    assert.ok(settled.error instanceof UserInterruptError,
      `the rethrown error must be the UserInterruptError (got ${settled.error.constructor && settled.error.constructor.name}: ${settled.error.message})`);

    // Entry 1: queue status untouched — NOT failed-execution, NOT halted-*.
    const entryA = readQueueEntry(root, 'intr-a');
    assert.ok(entryA, "entry 'intr-a' must still exist in the queue");
    assert.strictEqual(entryA.status, 'pending',
      `entry 'intr-a' status must be unchanged ('pending' — it was not a failure), got '${entryA.status}'`);

    // Entry 2: never started, still queued and pending.
    assert.strictEqual(executeCount, 1,
      `entry 2 must never start after the abort (_executeAllMilestones ran ${executeCount} time(s), expected 1)`);
    assert.strictEqual(getExecuteCount(), 0,
      'sanity: the default execute stub must not have run (override in place)');
    const entryB = readQueueEntry(root, 'intr-b');
    assert.ok(entryB, "entry 'intr-b' must still exist in the queue");
    assert.strictEqual(entryB.status, 'pending',
      `entry 'intr-b' status must be 'pending', got '${entryB.status}'`);

    // No forensic archive (and no success archive either — nothing completed).
    const forensic = archiveCalls.filter((c) => c.opts && c.opts['include-failed']);
    assert.strictEqual(forensic.length, 0,
      `no forensic archive may be produced on user interrupt (got ${forensic.length})`);
    assert.strictEqual(archiveCalls.length, 0,
      `no archive call of any kind expected (got ${archiveCalls.length})`);

    // The outer finally still runs (spec constraint: closeReusableSession etc.).
    assert.strictEqual(wasReusableSessionClosed(), true,
      'the outer finally must still run (closeReusableSession was not called)');
  } finally {
    cleanup(root);
  }
});

// ── TC7a: UserInterruptError class contract ────────────────────────────────

await test('TC7a: UserInterruptError instanceof HaltError, site "user-interrupt", own message; REVIEW_GATE_HALT_SITES (if exported) excludes it', async () => {
  assert.strictEqual(typeof UserInterruptError, 'function',
    'UserInterruptError must be exported from src/orchestrator/core/halt-error.js');
  const err = new UserInterruptError();
  assert.ok(err instanceof HaltError, 'UserInterruptError must be instanceof HaltError');
  assert.ok(err instanceof Error, 'UserInterruptError must be instanceof Error');
  assert.strictEqual(err.site, 'user-interrupt',
    `site must be 'user-interrupt', got '${err.site}'`);
  assert.ok(typeof err.message === 'string' && err.message.length > 0,
    'UserInterruptError must carry a non-empty message');
  assert.ok(!err.message.includes('Auto mode encountered halt site'),
    `UserInterruptError must have its OWN message, not HaltError's generic auto-mode text (got: ${err.message})`);

  // REVIEW_GATE_HALT_SITES is a module-private const at pre-fix HEAD (not in
  // pipeline.js's export list). If the implementation exports it, pin the
  // membership directly; otherwise the observable contract — Ctrl-C at a
  // review-gate menu in batch is an abort, not a 'halted-review' park — is
  // pinned behaviorally by TC7b below. Honest skip, not a silent pass.
  const sites = pipelineMod.REVIEW_GATE_HALT_SITES;
  if (sites !== undefined) {
    assert.ok(Array.isArray(sites) || sites instanceof Set ? true : typeof sites === 'object',
      'REVIEW_GATE_HALT_SITES export has an unexpected shape');
    const list = Array.isArray(sites) ? sites : Array.from(sites);
    assert.ok(!list.includes('user-interrupt'),
      `REVIEW_GATE_HALT_SITES must NOT include 'user-interrupt' (got: ${JSON.stringify(list)})`);
  }
});

// ── TC7b: review-gate ^C in batch is an abort, not a halted-review park ────

await test('TC7b: batchResume — UserInterruptError from the review gate → abort (rethrown, status unchanged), NOT a halted-review park', async () => {
  assert.strictEqual(typeof UserInterruptError, 'function',
    'UserInterruptError must be exported from src/orchestrator/core/halt-error.js');
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'rg-intr');

    const { pipeline, archiveCalls } = makeBatchPipeline(root);
    // Trigger only: the user hits ^C at the review-gate menu.
    pipeline._reviewGate = async () => { throw new UserInterruptError(); };

    const settled = await settleWithin(pipeline.batchResume({}), BATCH_SETTLE_MS, 'batchResume (review-gate interrupt)');
    assert.strictEqual(settled.status, 'rejected',
      `batchResume must RETHROW a review-gate user interrupt, but it resolved with ${JSON.stringify(settled.value)}`);
    assert.ok(settled.error instanceof UserInterruptError,
      `the rethrown error must be the UserInterruptError (got ${settled.error.constructor && settled.error.constructor.name}: ${settled.error.message})`);

    const entry = readQueueEntry(root, 'rg-intr');
    assert.ok(entry, "entry 'rg-intr' must still exist in the queue");
    assert.strictEqual(entry.status, 'pending',
      `a ^C at the review gate must NOT park the entry ('halted-review') nor fail it — status must stay 'pending', got '${entry.status}'`);

    const forensic = archiveCalls.filter((c) => c.opts && c.opts['include-failed']);
    assert.strictEqual(forensic.length, 0,
      `no forensic archive may be produced on a review-gate user interrupt (got ${forensic.length})`);
  } finally {
    cleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
