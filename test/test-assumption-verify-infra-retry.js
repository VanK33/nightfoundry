#!/usr/bin/env node
/**
 * test-assumption-verify-infra-retry.js — Tests for the new
 * verifyAssumptions infra-failure contract (spec:
 * assumption-verify-infra-retry.spec.md).
 *
 * Contract under test (planner.verifyAssumptions(assumptions, projectRoot)):
 *   - A SESSION FAILURE that throws a RETRYABLE InfrastructureError is retried
 *     a small bounded number of times; if it KEEPS throwing, the error is
 *     RE-THROWN (the call rejects) and NO assumption is ever marked 'uncertain'.
 *   - A NON-RETRYABLE InfrastructureError is RE-THROWN immediately (no retry),
 *     never 'uncertain'.
 *   - A SUCCESSFUL session that returns a genuine status:'uncertain' verdict is
 *     unchanged — it stays 'uncertain'.
 *   - In batch, an InfrastructureError that originates in assumption
 *     verification halts resumably: batchResume re-throws it (NOT
 *     'failed-execution', NOT parked).
 *
 * Run: node test/test-assumption-verify-infra-retry.js
 *
 * No live Claude sessions are spawned — sessionManager (and, for the batch
 * case, planner.verifyAssumptions) are replaced by stubs.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Planner } from '../src/orchestrator/agents/planner.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { InfrastructureError } from '../src/orchestrator/infra/session-manager.js';
import { writeQueueEntry, readQueueEntry } from '../src/orchestrator/core/state.js';

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

// ── Planner seam helpers ────────────────────────────────────────────────────

/**
 * Minimal logger stub satisfying the surface verifyAssumptions touches:
 * createSessionLog/attachToSession/getSessionSummary/writeSessionSummary/warn.
 * It records warn() calls so retry logging can be observed if needed.
 */
function makeLoggerStub() {
  const warns = [];
  return {
    warns,
    createSessionLog: () => ({ logPath: '/dev/null', close: () => {} }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
    warn: (msg) => { warns.push(msg); },
  };
}

/**
 * Build a Planner with a sessionManager whose spawn(...) is driven by `spawnFn`.
 * No tokenTracker (it is optional — recordSession is called with ?.).
 *
 * spawnFn receives the spawn-arg object and returns a "spawnPromise":
 * an object with a `.handle` property that ALSO resolves (it's awaited) to
 * { handle, result }. Throwing (sync or async) from spawnFn simulates a
 * session failure on the spawn+await path.
 */
function makePlanner(spawnFn) {
  let spawnCalls = 0;
  const sessionManager = {
    spawn: (args) => {
      spawnCalls++;
      return spawnFn(args, spawnCalls);
    },
  };
  const planner = new Planner(sessionManager, makeLoggerStub(), undefined);
  return { planner, getSpawnCalls: () => spawnCalls };
}

/**
 * A spawnPromise whose await resolves to { handle, result } carrying the given
 * structured output. Mirrors how a SUCCESSFUL session result is shaped: the
 * planner extracts JSON via `result.structured_output`.
 */
function makeSpawnSuccess(structuredOutput) {
  const handle = { systemPromptTokens: 0, _toolCallCount: 0 };
  const result = { structured_output: structuredOutput };
  // The planner does `const spawnPromise = this.sessionManager.spawn(...)`,
  // reads `spawnPromise.handle`, then `await spawnPromise` for { handle, result }.
  const spawnPromise = Promise.resolve({ handle, result });
  spawnPromise.handle = handle;
  return spawnPromise;
}

// ── TC1: retryable infra → retried then re-thrown, never uncertain ──────────

await test('TC1: retryable InfrastructureError is retried then re-thrown, never uncertain', async () => {
  const infra = () => new InfrastructureError('network failure', {
    category: 'network',
    retryable: true,
  });

  const { planner, getSpawnCalls } = makePlanner(() => { throw infra(); });

  const assumptions = [{ text: 'A exists', specSection: '## A' }];

  let caught = null;
  let resolved;
  try {
    resolved = await planner.verifyAssumptions(assumptions, '/tmp/proj');
  } catch (err) {
    caught = err;
  }

  // (a) The call must REJECT with the InfrastructureError — never resolve.
  assert.ok(caught, 'verifyAssumptions must reject (throw) on a persistent retryable infra error');
  assert.ok(
    caught instanceof InfrastructureError,
    `Expected an InfrastructureError to be re-thrown, got: ${caught && caught.constructor && caught.constructor.name}`,
  );
  assert.equal(caught.retryable, true, 'Re-thrown error should preserve retryable:true');

  // (b) It must NEVER have resolved to an array of uncertain verdicts.
  assert.equal(
    resolved,
    undefined,
    `verifyAssumptions must not resolve when infra keeps failing. Got: ${JSON.stringify(resolved)}`,
  );

  // (c) Retry happened: spawn was invoked MORE THAN ONCE.
  const calls = getSpawnCalls();
  assert.ok(
    calls > 1,
    `Expected spawn to be retried (>1 invocation), got ${calls}`,
  );

  // (d) Bounded: total attempts = 1 initial + 2 retries = 3 (MAX_INFRA_RETRIES=2).
  assert.equal(
    calls,
    3,
    `Expected exactly 3 bounded attempts (1 + 2 retries), got ${calls}`,
  );
});

// ── TC2: non-retryable infra → re-thrown immediately, no retry ──────────────

await test('TC2: non-retryable InfrastructureError is re-thrown immediately (no retry), never uncertain', async () => {
  const infra = () => new InfrastructureError('auth failed', {
    category: 'auth',
    retryable: false,
  });

  const { planner, getSpawnCalls } = makePlanner(() => { throw infra(); });

  const assumptions = [{ text: 'B exists', specSection: '## B' }];

  let caught = null;
  let resolved;
  try {
    resolved = await planner.verifyAssumptions(assumptions, '/tmp/proj');
  } catch (err) {
    caught = err;
  }

  // (a) Rejects with the InfrastructureError.
  assert.ok(caught, 'verifyAssumptions must reject on a non-retryable infra error');
  assert.ok(
    caught instanceof InfrastructureError,
    `Expected InfrastructureError, got: ${caught && caught.constructor && caught.constructor.name}`,
  );
  assert.equal(caught.retryable, false, 'Re-thrown error should preserve retryable:false');

  // (b) Never resolves to uncertain verdicts.
  assert.equal(
    resolved,
    undefined,
    `verifyAssumptions must not resolve for a non-retryable infra error. Got: ${JSON.stringify(resolved)}`,
  );

  // (c) NO retry: spawn called EXACTLY ONCE.
  const calls = getSpawnCalls();
  assert.equal(
    calls,
    1,
    `Expected spawn called exactly once (no retry) for non-retryable infra, got ${calls}`,
  );
});

// ── TC3: genuine uncertain verdict from a SUCCESSFUL session is unchanged ────

await test('TC3: genuine status:uncertain from a successful session stays uncertain', async () => {
  const assumptions = [{ text: 'tokenTracker is always present', specSection: '## Tokens' }];

  // The session SUCCEEDS and returns a structured `results` array (the shape
  // the planner parses via _extractJson → result.structured_output). The
  // verdict is a genuine 'uncertain' — it must flow through untouched.
  const structuredOutput = {
    results: [
      {
        assumption: assumptions[0].text,
        status: 'uncertain',
        evidence: 'tokenTracker is optional and not always present',
      },
    ],
  };

  const { planner, getSpawnCalls } = makePlanner(() => makeSpawnSuccess(structuredOutput));

  const out = await planner.verifyAssumptions(assumptions, '/tmp/proj');

  // (a) The call RESOLVES (no throw).
  assert.ok(Array.isArray(out), `verifyAssumptions should resolve to an array, got: ${typeof out}`);
  assert.equal(out.length, 1, `Expected 1 verdict, got ${out.length}`);

  // (b) The verdict for that assumption is still 'uncertain'.
  assert.equal(
    out[0].status,
    'uncertain',
    `Genuine uncertain verdict must be preserved, got status='${out[0].status}'`,
  );

  // (c) Success path spawns exactly once (no retry on success).
  assert.equal(getSpawnCalls(), 1, `Expected exactly one spawn on the success path, got ${getSpawnCalls()}`);
});

// ── Batch harness (real Pipeline.prototype.batchResume against a temp git repo)

/**
 * Temp git repo with a baseline commit + .gitignore ignoring .harness/ and
 * queue/ (so `git status --porcelain` is clean and batchResume's dirty-tree
 * guard passes). Mirrors the harness in test-batch-revert-and-continue.js.
 */
function makeTmpGitRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-assume-infra-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(
    path.join(dir, '.gitignore'),
    '.harness/\nqueue/\n# cc-orch ephemeral inputs\nspec-*.md\n*.spec.md\n',
  );
  fs.writeFileSync(path.join(dir, 'README.md'), '# baseline\n');
  execSync('git add .gitignore README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "baseline"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Lightweight archive stub injected via the Pipeline `archive` seam. */
function makeStubArchive(root) {
  return async (_projectRoot, slug, opts = {}) => {
    const archivesDir = path.join(root, 'archives');
    fs.mkdirSync(archivesDir, { recursive: true });
    let maxSeq = 0;
    for (const d of fs.readdirSync(archivesDir)) {
      const m = d.match(/^(?:failed-)?(\d+)/);
      if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
    }
    const seq = String(maxSeq + 1).padStart(3, '0');
    const isFailed = opts['include-failed'] === true;
    const name = isFailed ? `failed-${seq}-${slug}` : `${seq}-${slug}`;
    const dir = path.join(archivesDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ headline: isFailed ? '' : slug }));
    return dir;
  };
}

// ── TC4: batch — InfrastructureError originating in assumption verification ──
//         halts resumably (re-thrown; NOT failed-execution, NOT parked).

await test('TC4: batchResume re-throws an InfrastructureError that originates in assumption verification (resumable halt, not failed-execution / park)', async () => {
  const root = makeTmpGitRoot();
  try {
    // One pending queue entry whose plan has a non-empty assumptions array, so
    // batchResume reaches the round-1 verifyAssumptions call (it is gated on
    // plan.assumptions?.length).
    writeQueueEntry(root, 'spec-infra', {
      spec: '# Spec for spec-infra\n\nMinimal spec content.\n',
      plan: {
        milestones: [],
        assumptions: [{ text: 'X exists', specSection: '## X' }],
      },
      validatedAt: new Date().toISOString(),
      status: 'pending',
    });

    const logs = [];
    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: (m) => logs.push(m),
      archive: makeStubArchive(root),
    });

    // The InfrastructureError ORIGINATES in assumption verification: the real
    // batchResume calls planner.verifyAssumptions per entry — make it throw.
    pipeline.planner.verifyAssumptions = async () => {
      throw new InfrastructureError('rate limited', {
        category: 'rate_limit',
        retryable: true,
        statusCode: 429,
        cause: new Error('upstream 429'),
      });
    };
    pipeline.planner.closeReusableSession = async () => {};
    pipeline._reviewGate = async () => {};
    pipeline._skipCoverageGate = true;
    // Should NEVER be reached — verification throws first.
    pipeline._executeAllMilestones = async () => {
      throw new Error('_executeAllMilestones must not run when verification throws InfrastructureError');
    };

    // (a) batchResume must REJECT with the InfrastructureError (resumable halt).
    await assert.rejects(
      () => pipeline.batchResume({ autonomous: true }),
      (err) => err instanceof InfrastructureError && err.category === 'rate_limit',
      'batchResume must re-throw the InfrastructureError originating in assumption verification',
    );

    // (b) The entry stays 'pending' — NOT 'failed-execution'.
    const entry = readQueueEntry(root, 'spec-infra');
    assert.ok(entry !== null, 'spec-infra queue entry should still exist');
    assert.strictEqual(
      entry.status,
      'pending',
      `Entry must remain 'pending' (resumable), got '${entry?.status}'`,
    );
    assert.notStrictEqual(
      entry.status,
      'failed-execution',
      'Entry must NOT be marked failed-execution on an InfrastructureError halt',
    );

    // (c) No park scene / forensic failed-archive was written for the entry.
    const archivesDir = path.join(root, 'archives');
    if (fs.existsSync(archivesDir)) {
      const failedEntries = fs.readdirSync(archivesDir).filter((e) => /failed.*spec-infra/.test(e));
      assert.strictEqual(
        failedEntries.length,
        0,
        `Expected no forensic failed-archive for spec-infra, found: [${failedEntries.join(', ')}]`,
      );
    }

    // (d) No 'Park failed spec' commit was made for the entry.
    const gitLog = execSync('git log --oneline', { cwd: root, encoding: 'utf8' });
    assert.ok(
      !gitLog.includes('Park failed spec spec-infra'),
      `git log should NOT contain a park commit for spec-infra. Got:\n${gitLog}`,
    );
  } finally {
    cleanup(root);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
