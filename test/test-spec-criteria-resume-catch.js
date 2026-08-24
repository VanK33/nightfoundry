#!/usr/bin/env node
/**
 * test-spec-criteria-resume-catch.js — Pipeline.resume() catching the
 * last-milestone spec-criteria drain (SpecCriterionError) thrown by
 * _runSpecCriteriaDrain() (see pipeline.js's resume() catch block, the
 * `err instanceof SpecCriterionError` branch just after the milestone
 * execution loop).
 *
 * Reuses the on-disk .harness fixture + stubbed-LLM-seam Pipeline style from
 * test-spec-criteria-drain.js (real state.json / mission state / spec.json on
 * disk, only the LLM-bearing seams — planner approval, scheduler, mission
 * regression, reviewer, verifier, analyzer — stubbed; the drain itself and
 * the real _executeMilestone control flow are untouched), wrapped in a real
 * git working tree (via test/helpers/batch-fixtures.js) so "the WIP is not
 * reverted" is an observable, checkable claim.
 *
 * Contract under test (pipeline.js resume(), read at the time this test was
 * written):
 *   - a drain failure (SpecCriterionError) during the milestone execution
 *     loop is caught INSIDE resume() (not left to propagate to the CLI
 *     wrapper);
 *   - the failing criteria are printed to stderr, one line per failure, in
 *     the same {name, targetFile}/{name, exitCode, command} shape as the
 *     batchResume criteria-failures.txt disposition, followed by a
 *     fix-and-re-run hint naming `cc-orch resume` as the next step;
 *   - NO git revert of any kind is attempted on this path (unlike
 *     batchResume's SpecCriterionError disposition) — the WIP is left in
 *     place for a human to fix;
 *   - a best-effort marker is persisted to .harness/state.json
 *     (globalStatus: 'paused') so a later `cc-orch resume` can recognize the
 *     drain as the pending step;
 *   - resume() calls process.exit(1) directly from inside the catch — no
 *     stack trace is ever printed on this path;
 *   - the outer review gate (_reviewGate) and archive seam (_archive) are
 *     never reached when the drain fails.
 *
 * TC2 is the byte-identical-happy-path regression: when the same last
 * milestone's drain PASSES, resume() must still proceed exactly as before —
 * reaching the outer _reviewGate seam and then the _archive seam once each,
 * with globalStatus never marked 'paused'.
 *
 * Cases:
 *   TC1 — last-milestone drain throws in resume(): criteria printed with the
 *         fix-and-re-run hint, WIP left in place (git tree unreverted), a
 *         drain-pending globalStatus is persisted, exit code captured
 *         non-zero, no stack trace printed, review-gate/archive not reached.
 *   TC2 — passing drain: resume() reaches the _reviewGate/archive seam
 *         unchanged (regression: happy path unaffected by the drain-catch).
 *
 * Run: node test/test-spec-criteria-resume-catch.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { SpecCriterionError } from '../src/orchestrator/core/spec-criterion-error.js';
import { seedPassedSidecars } from './helpers/seed-passed-sidecars.js';
import { makeGitRoot, cleanup, porcelain } from './helpers/batch-fixtures.js';

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

/** Settle-timeout guard: a regression that hangs must fail, not wedge the runner. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`settle-timeout after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Capture console.log/console.error + stdout/stderr writes made during fn(),
 * and any error fn() throws (used to observe the mocked process.exit
 * sentinel without letting it escape the test).
 */
async function captureOutput(fn) {
  const outChunks = [];
  const errChunks = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);

  process.stdout.write = (chunk) => {
    outChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk) => {
    errChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => outChunks.push(args.join(' ') + '\n');
  console.error = (...args) => errChunks.push(args.join(' ') + '\n');

  let thrownError = null;
  try { await fn(); }
  catch (err) { thrownError = err; }
  finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
  }
  return { stdout: outChunks.join(''), stderr: errChunks.join(''), thrownError };
}

// ── Fixture command vocabulary (mirrors test-spec-criteria-drain.js) ────────
const FAILING_MO_CMD = `node -e "console.log('drain-boom');console.error('drain-boom');process.exit(3)"`;
const PASSING_MO_CMD = `node -e "process.exit(0)"`;

const cmdCriterion = (description, command) =>
  ({ description, verification: { kind: 'command', command } });

function writeSpecJson(root, criteria) {
  fs.writeFileSync(
    path.join(root, 'spec.json'),
    JSON.stringify({ goal: 'resume-catch fixture spec', acceptance_criteria: criteria }, null, 2)
  );
}

/**
 * Real git working tree + real .harness layout on disk: a single milestone
 * '001' (also the LAST milestone) with one complete mission/sub-mission/task,
 * so _executeMilestone proceeds straight through to the reviewer gate and
 * the spec-criteria drain. A dirty, uncommitted "WIP" file simulates the
 * work a prior (already-run) milestone step left behind, still uncommitted
 * when resume() runs — this is what "not reverted" is checked against.
 */
function createResumeFixture({ criteria }) {
  const root = makeGitRoot({ prefix: 'cc-orch-spec-resume-catch-' });
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs', 'learning', 'dry-run', 'brainstorm']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(harnessDir, 'logs', 'token-usage.json'),
    JSON.stringify({ sessions: [], totals: {} })
  );

  fs.writeFileSync(path.join(root, 'spec.md'), '# resume-catch fixture spec\n\nNo scenarios here.\n');
  writeSpecJson(root, criteria);

  const msId = '001';
  const miId = '001-001';
  const smId = `${miId}-001`;
  const taskId = `${smId}-001`;

  const milestones = {
    [msId]: {
      id: msId,
      description: `milestone ${msId}`,
      status: 'in_progress',
      planFile: `.harness/plan/milestone-${msId}.md`,
      missions: {
        [miId]: {
          id: miId,
          description: `mission ${miId}`,
          status: 'complete',
          stateFile: `.harness/state/mission-${miId}.json`,
          planFile: `.harness/plan/mission-${miId}.md`,
        },
      },
    },
  };

  const missionState = {
    id: miId,
    missionId: miId,
    description: `mission ${miId}`,
    status: 'complete',
    subMissions: {
      [smId]: {
        id: smId,
        description: `sub-mission ${smId}`,
        status: 'complete',
        tasks: {
          [taskId]: {
            id: taskId,
            description: `task ${taskId}`,
            status: 'complete',
            targetFiles: [],
            dependencies: [],
            testCases: [],
            tracesScenario: [],
            retryCount: 0,
          },
        },
      },
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${miId}.json`),
    JSON.stringify(missionState, null, 2)
  );
  seedPassedSidecars(harnessDir, missionState);
  fs.writeFileSync(
    path.join(harnessDir, 'plan', `mission-${miId}.md`),
    `# Plan for mission ${miId}\n\nFixture plan content.\n`
  );

  const globalState = {
    projectMeta: {
      prdPath: path.join(root, 'spec.md'),
      createdAt: new Date().toISOString(),
      currentPhase: 'executing',
    },
    globalStatus: 'active',
    milestones,
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  // Simulate uncommitted WIP a prior milestone step left behind — still
  // dirty in the working tree when resume() runs.
  const wipFileName = 'deliverable-resume-catch.txt';
  fs.writeFileSync(path.join(root, wipFileName), 'work in progress from a prior milestone execution\n');

  return { root, harnessDir, msId, wipFileName };
}

/**
 * Pipeline with ONLY the LLM-bearing seams stubbed (same discipline as
 * makeWiringPipeline in test-spec-criteria-drain.js), plus the coverage gate
 * skipped (no live planner to drive it — irrelevant to the drain under test)
 * and the outer review-gate / archive seams instrumented so TC1/TC2 can
 * assert whether resume() reached past the milestone-execution loop.
 */
function makeWiringPipeline(projectRoot) {
  const trace = {
    logs: [], reviewerCalls: 0, verifyCalls: 0, regressionCalls: [],
    schedulerInvocations: 0, reviewGateCalls: 0, archiveCalls: [],
  };
  const pipeline = new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: (msg) => trace.logs.push(String(msg)),
    onConfirm: async () => true,
    archive: async (...args) => { trace.archiveCalls.push(args); },
  });

  pipeline._skipCoverageGate = true;
  pipeline._planAndApproveMission = async (miId) => {
    throw new Error(`_planAndApproveMission unexpectedly called for ${miId} — fixture missions are complete`);
  };
  pipeline.scheduler.runMilestone = async () => { trace.schedulerInvocations += 1; };
  pipeline._missionRegression = async (miId) => { trace.regressionCalls.push(miId); };
  pipeline.reviewer = {
    reviewMilestone: async () => {
      trace.reviewerCalls += 1;
      return { passed: true, findings: [] };
    },
  };
  pipeline.verifier = {
    verifyRegression: async () => {
      trace.verifyCalls += 1;
      return { verified: true, report: 'ok' };
    },
  };
  pipeline.analyzer = {
    analyzeFailure: async () => ({ eventId: 'fake', recommendation: 'human', affectedTasks: [] }),
  };
  pipeline._reviewGate = async (opts) => { trace.reviewGateCalls += 1; return opts; };

  return { pipeline, trace };
}

/**
 * Remove leftover process signal listeners / timers a Pipeline registers, so
 * repeated Pipeline construction across tests doesn't pile up listeners.
 * Safe to call even after resume() already ran its own finally-block
 * teardown (removeListener / destroy() are idempotent no-ops in that case).
 */
function teardownPipeline(pipeline) {
  const handlers = pipeline._signalHandlers || {};
  if (handlers.SIGINT) process.removeListener('SIGINT', handlers.SIGINT);
  if (handlers.SIGTERM) process.removeListener('SIGTERM', handlers.SIGTERM);
  if (handlers.exit) process.removeListener('exit', handlers.exit);
  if (handlers.uncaughtException) process.removeListener('uncaughtException', handlers.uncaughtException);
  if (typeof pipeline.destroy === 'function') pipeline.destroy();
}

const WIRING_TIMEOUT_MS = 90_000;

// ═════════════════════════════════════════════════════════════════════════════

await test('TC1: resume() catches the last-milestone spec-criteria drain failure — prints criteria + fix-and-re-run hint, does not revert the WIP, persists a drain-pending globalStatus, captures a non-zero exit code, no stack trace, review-gate/archive not reached', async () => {
  const env = createResumeFixture({
    criteria: [cmdCriterion('drain-fail criterion', FAILING_MO_CMD)],
  });
  const { pipeline, trace } = makeWiringPipeline(env.root);

  const capturedExitCodes = [];
  const sentinel = new Error('__SENTINEL_EXIT__');
  const origExit = process.exit;
  process.exit = (code) => {
    capturedExitCodes.push(code);
    throw sentinel;
  };

  try {
    const dirtyBefore = porcelain(env.root);
    assert.notStrictEqual(dirtyBefore, '', 'precondition: the working tree must be dirty (WIP present) before resume() runs');
    assert.ok(fs.existsSync(path.join(env.root, env.wipFileName)),
      'precondition: the WIP deliverable must exist on disk before resume() runs');

    const output = await captureOutput(async () => {
      await withTimeout(pipeline.resume(), WIRING_TIMEOUT_MS, 'TC1 resume()');
    });

    // resume() must escape via the mocked process.exit sentinel — not by
    // letting the raw SpecCriterionError (or anything else) propagate.
    assert.strictEqual(output.thrownError, sentinel,
      `expected resume() to exit via the mocked process.exit sentinel, got: ${output.thrownError && output.thrownError.stack}`);
    assert.ok(capturedExitCodes.length > 0 && capturedExitCodes.every((c) => c !== 0 && typeof c === 'number'),
      `expected process.exit to be called with a non-zero code, got [${capturedExitCodes.join(', ')}]`);

    // Failing criteria printed, with the fix-and-re-run hint naming
    // `cc-orch resume` as the next step.
    assert.ok(output.stderr.includes('drain-fail criterion'),
      `expected the failing criterion name printed to stderr. Got:\n${output.stderr}`);
    assert.ok(output.stderr.includes(FAILING_MO_CMD),
      `expected the failing command printed to stderr. Got:\n${output.stderr}`);
    assert.ok(output.stderr.includes('Fix the failing criteria above'),
      `expected the fix-and-re-run hint printed. Got:\n${output.stderr}`);
    assert.ok(/(cc-orch|nightfoundry) resume/.test(output.stderr),
      `expected the hint to name \`cc-orch resume\` as the next step. Got:\n${output.stderr}`);

    // No stack trace printed on this path.
    const combined = output.stdout + output.stderr;
    assert.ok(!/\n\s+at .+:\d+:\d+\)?/.test(combined),
      `expected no stack trace in the captured output. Got:\n${combined}`);
    assert.ok(!combined.includes('pipeline.js:'),
      `expected no source-frame reference (stack trace) in the captured output. Got:\n${combined}`);

    // The WIP is left in place — no git revert on this path.
    assert.ok(fs.existsSync(path.join(env.root, env.wipFileName)),
      'the WIP deliverable must still exist — resume() must not revert the working tree on a drain failure');
    assert.strictEqual(porcelain(env.root), dirtyBefore,
      `the working tree must be unchanged (not reverted) after the drain failure; before="${dirtyBefore}" after="${porcelain(env.root)}"`);

    // .harness/state.json globalStatus persisted marking the drain pending.
    const state = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state.json'), 'utf8'));
    assert.strictEqual(state.globalStatus, 'paused',
      `expected globalStatus to be persisted as 'paused' (drain-pending marker) so a later \`cc-orch resume\` recognizes the pending step, got '${state.globalStatus}'`);

    // Deterministic gate precedes the outer review gate / archive: neither
    // is reached once the drain has failed.
    assert.strictEqual(trace.reviewGateCalls, 0,
      `the outer review gate must not be reached after a drain failure, got ${trace.reviewGateCalls} call(s)`);
    assert.strictEqual(trace.archiveCalls.length, 0,
      `the archive seam must not be reached after a drain failure, got ${trace.archiveCalls.length} call(s)`);
    assert.strictEqual(trace.verifyCalls, 0,
      `verifyMilestone must not run after a drain failure, verifier called ${trace.verifyCalls}x`);
    // Drain placement is after the per-milestone reviewer gate — it DID run.
    assert.strictEqual(trace.reviewerCalls, 1,
      `expected the per-milestone reviewer gate to have run before the drain, got ${trace.reviewerCalls} call(s)`);
  } finally {
    process.exit = origExit;
    teardownPipeline(pipeline);
    cleanup(env.root);
  }
});

await test('TC2: passing drain — resume() proceeds unchanged, reaching the review-gate then archive seam exactly once each (regression: happy path unaffected by the drain-catch)', async () => {
  const env = createResumeFixture({
    criteria: [cmdCriterion('drain-pass criterion', PASSING_MO_CMD)],
  });
  const { pipeline, trace } = makeWiringPipeline(env.root);

  try {
    const result = await withTimeout(pipeline.resume(), WIRING_TIMEOUT_MS, 'TC2 resume()');

    assert.ok(result && typeof result.runStartSessionCount === 'number',
      `expected resume() to return its normal { runStartSessionCount } result unchanged, got ${JSON.stringify(result)}`);

    assert.strictEqual(trace.verifyCalls, 1,
      `expected verifyMilestone to run once for the passing drain, verifier called ${trace.verifyCalls}x`);
    assert.strictEqual(trace.reviewerCalls, 1,
      `expected the per-milestone reviewer gate to have run, got ${trace.reviewerCalls} call(s)`);
    assert.strictEqual(trace.reviewGateCalls, 1,
      `expected the outer review-gate seam to be reached exactly once, got ${trace.reviewGateCalls} call(s)`);
    assert.strictEqual(trace.archiveCalls.length, 1,
      `expected the archive seam to be reached exactly once, got ${trace.archiveCalls.length} call(s)`);

    const state = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state.json'), 'utf8'));
    assert.notStrictEqual(state.globalStatus, 'paused',
      `expected globalStatus NOT to be marked drain-pending on the passing path, got '${state.globalStatus}'`);
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.root);
  }
});

// ── TC3: degenerate SpecCriterionError.failures — real resume() catch, not a
// stubbed Pipeline.prototype.resume. Drives the real `err.failures || []`
// guard (pipeline.js resume() catch, `err instanceof SpecCriterionError`
// branch) by overriding the pipeline instance's `_runSpecCriteriaDrain` to
// throw directly, so the throw is caught by the SAME real try/catch that
// wraps the milestone-execution loop as TC1/TC2 — only the origin of the
// SpecCriterionError differs (a degenerate failures list instead of a real
// FAILING_MO_CMD drain run). Both sub-cases must land in the merit-failure
// arm (resumeCritFailures.length > 0 is false for both, so the all-timedOut
// infra arm is skipped) and produce byte-identical observable outcomes to
// TC1: fix-and-re-run hint, globalStatus 'paused', non-zero exit via the
// sentinel, WIP left in place (no revert), no stack trace.
const tc3Cases = [
  {
    label: 'TC3a',
    description: 'pipeline._runSpecCriteriaDrain throws SpecCriterionError([]) (empty failures)',
    makeError: () => new SpecCriterionError([]),
  },
  {
    label: 'TC3b',
    description: 'pipeline._runSpecCriteriaDrain throws SpecCriterionError with .failures reassigned undefined post-construction',
    makeError: () => {
      // The constructor dereferences failures.length/.map, so it must be
      // constructed with [] first; only AFTER construction do we reassign
      // .failures to undefined to exercise the `err.failures || []` guard
      // against a genuinely missing failures list (not just an empty one).
      const err = new SpecCriterionError([]);
      err.failures = undefined;
      return err;
    },
  },
];

for (const tc3 of tc3Cases) {
  await test(`TC3: resume() catches a degenerate SpecCriterionError from an overridden _runSpecCriteriaDrain (${tc3.label}: ${tc3.description}) — same fix-and-re-run hint, paused globalStatus, non-zero exit, no revert, no stack trace as TC1`, async () => {
    const env = createResumeFixture({
      criteria: [cmdCriterion('unused-in-tc3 criterion', PASSING_MO_CMD)],
    });
    const { pipeline, trace } = makeWiringPipeline(env.root);

    // Override the REAL Pipeline instance method (not Pipeline.prototype.resume)
    // so resume()'s own try/catch around the milestone-execution loop is the
    // thing doing the catching, exactly as it does for a real drain failure.
    pipeline._runSpecCriteriaDrain = () => {
      throw tc3.makeError();
    };

    const capturedExitCodes = [];
    const sentinel = new Error('__SENTINEL_EXIT__');
    const origExit = process.exit;
    process.exit = (code) => {
      capturedExitCodes.push(code);
      throw sentinel;
    };

    try {
      const dirtyBefore = porcelain(env.root);
      assert.notStrictEqual(dirtyBefore, '', 'precondition: the working tree must be dirty (WIP present) before resume() runs');
      assert.ok(fs.existsSync(path.join(env.root, env.wipFileName)),
        'precondition: the WIP deliverable must exist on disk before resume() runs');

      const output = await captureOutput(async () => {
        await withTimeout(pipeline.resume(), WIRING_TIMEOUT_MS, `${tc3.label} resume()`);
      });

      // resume() must escape via the mocked process.exit sentinel — not by
      // letting the raw SpecCriterionError (or anything else) propagate.
      assert.strictEqual(output.thrownError, sentinel,
        `expected resume() to exit via the mocked process.exit sentinel, got: ${output.thrownError && output.thrownError.stack}`);
      assert.ok(capturedExitCodes.length > 0 && capturedExitCodes.every((c) => c !== 0 && typeof c === 'number'),
        `expected process.exit to be called with a non-zero code, got [${capturedExitCodes.join(', ')}]`);

      // Fix-and-re-run hint naming `cc-orch resume` as the next step, even
      // though there is no specific failing criterion to name (degenerate
      // empty/undefined failures list).
      assert.ok(output.stderr.includes('Fix the failing criteria above'),
        `expected the fix-and-re-run hint printed. Got:\n${output.stderr}`);
      assert.ok(/(cc-orch|nightfoundry) resume/.test(output.stderr),
        `expected the hint to name \`cc-orch resume\` as the next step. Got:\n${output.stderr}`);

      // No stack trace / source-frame reference printed on this path.
      const combined = output.stdout + output.stderr;
      assert.ok(!/\n\s+at .+:\d+:\d+\)?/.test(combined),
        `expected no stack trace in the captured output. Got:\n${combined}`);
      assert.ok(!combined.includes('pipeline.js:'),
        `expected no source-frame reference (stack trace) in the captured output. Got:\n${combined}`);

      // The WIP is left in place — no git revert on this path.
      assert.ok(fs.existsSync(path.join(env.root, env.wipFileName)),
        'the WIP deliverable must still exist — resume() must not revert the working tree on a drain failure');
      assert.strictEqual(porcelain(env.root), dirtyBefore,
        `the working tree must be unchanged (not reverted) after the drain failure; before="${dirtyBefore}" after="${porcelain(env.root)}"`);

      // .harness/state.json globalStatus persisted marking the drain pending.
      const state = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state.json'), 'utf8'));
      assert.strictEqual(state.globalStatus, 'paused',
        `expected globalStatus to be persisted as 'paused' (drain-pending marker) so a later \`cc-orch resume\` recognizes the pending step, got '${state.globalStatus}'`);

      // Deterministic gate precedes the outer review gate / archive: neither
      // is reached once the drain has failed. The overridden drain also
      // means the per-milestone reviewer gate has already run by the time
      // it throws (drain placement is after the reviewer gate).
      assert.strictEqual(trace.reviewGateCalls, 0,
        `the outer review gate must not be reached after a drain failure, got ${trace.reviewGateCalls} call(s)`);
      assert.strictEqual(trace.archiveCalls.length, 0,
        `the archive seam must not be reached after a drain failure, got ${trace.archiveCalls.length} call(s)`);
      assert.strictEqual(trace.verifyCalls, 0,
        `verifyMilestone must not run after a drain failure, verifier called ${trace.verifyCalls}x`);
    } finally {
      process.exit = origExit;
      teardownPipeline(pipeline);
      cleanup(env.root);
    }
  });
}

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
