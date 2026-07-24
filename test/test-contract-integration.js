/**
 * test-contract-integration.js — End-to-end integration tests for the
 * hard-contracts chain, covering the exact path that dogfood 2's two
 * bonus bugs broke.
 *
 * Context: the individual contract tests (test-verifier-contract.js,
 * test-analyzer-contract.js, test-executor-contract.js) validate each
 * agent's extraction logic in isolation. They did NOT catch the two
 * bonus bugs found in dogfood 2:
 *
 *   Bug 1: state-machine.js `verified` transition gate hardcoded `.md`
 *          path instead of checking the new `.json` sidecar. Fixed in
 *          d62c5fa.
 *   Bug 2: resume path re-ran the executor when task was already at
 *          awaiting_verification, tripping the state machine's
 *          self-loop rejection. Fixed in d9184e1.
 *
 * Both bugs were caller-site mismatches: the contract migration updated
 * the definitions but not every site that depended on the old
 * convention. This test file exercises the FULL CHAIN that spans those
 * caller sites, so future convention migrations get caught before they
 * hit a live dogfood.
 *
 * Run: node test/test-contract-integration.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

import { extractProgress } from '../src/orchestrator/agents/executor.js';
import { extractVerdict } from '../src/orchestrator/agents/verifier.js';
import { readAffectedFiles } from '../src/orchestrator/core/snapshots.js';
import { transitionTask, getTaskStatus } from '../src/orchestrator/core/state-machine.js';
import { auditVerification } from '../src/orchestrator/gates/audit.js';

let passCount = 0;
let failCount = 0;

// Phase I items 4+5: state-machine transitions are async (they acquire
// mutexes internally), so tests and assertThrows are async-aware.
// `await` on a non-promise is a no-op, so sync test bodies still work.
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

async function assertThrows(fn, pattern, msg) {
  let thrown;
  try { await fn(); } catch (e) { thrown = e; }
  if (!thrown) throw new Error(msg || 'Expected function to throw');
  if (pattern && !pattern.test(thrown.message)) {
    throw new Error(`${msg || 'Throw pattern mismatch'}. Got: ${thrown.message}`);
  }
}

// ── Fixture helpers ────────────────────────────────────────────────────

/**
 * Create a temp project root with a `.harness/` inside, mirroring the
 * convention bootstrap.js uses. audit.js resolves mission state files
 * relative to `harnessDir/..`, so the harness MUST be a child named
 * `.harness` for path resolution to work.
 *
 * Returns the harnessDir path; the parent project root is implicit.
 */
function createHarness() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-integration-'));
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'progress'), { recursive: true });
  return harnessDir;
}

function cleanup(harnessDir) {
  // Clean up the parent project root, not just the harness child.
  fs.rmSync(path.dirname(harnessDir), { recursive: true, force: true });
}

/**
 * Write a minimal global + mission state that has one awaiting-verification
 * task. Matches the real file layout the pipeline uses.
 */
function seedTaskAwaitingVerification(harnessDir, taskId = '001-001-001-001') {
  const [msId, miId] = [taskId.slice(0, 3), taskId.slice(0, 7)];
  const smId = taskId.slice(0, 11);

  // Global state pointing at the mission file
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones: {
        [msId]: {
          id: msId,
          description: 'test milestone',
          status: 'in_progress',
          missions: {
            [miId]: {
              id: miId,
              description: 'test mission',
              status: 'in_progress',
              stateFile: `.harness/state/mission-${miId}.json`,
            },
          },
        },
      },
    }, null, 2)
  );

  // Mission state with one sub-mission and one task
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${miId}.json`),
    JSON.stringify({
      id: miId,
      missionId: miId,
      description: 'test mission',
      status: 'in_progress',
      subMissions: {
        [smId]: {
          id: smId,
          description: 'test sub-mission',
          status: 'in_progress',
          tasks: {
            [taskId]: {
              id: taskId,
              description: 'test task',
              status: 'awaiting_verification',
              createdAt: new Date().toISOString(),
              targetFiles: ['src/foo.js'],
            },
          },
        },
      },
    }, null, 2)
  );

  return { taskId, msId, miId, smId };
}

// Phase I items 4+5: wrap all test invocations in an async run() so
// top-level `await test(...)` works without the Node top-level-await
// flag.
async function run() {

// ── Full-chain happy path ──────────────────────────────────────────────

await test('end-to-end: JSON sidecars only — executor → snapshots → state-machine → audit', async () => {
  const dir = createHarness();
  try {
    const { taskId, msId } = seedTaskAwaitingVerification(dir);

    // Step 1: executor produces structured output → sidecar is written
    const execSdkResult = {
      structured_output: {
        status: 'COMPLETED',
        summary: 'Implemented the feature',
        affectedFiles: [
          { path: 'src/foo.js', reason: 'primary target' },
          { path: 'src/bar.js', reason: 'required helper' },
        ],
        testsSummary: 'Added 3 test cases',
      },
    };
    const progress = extractProgress(execSdkResult, taskId, dir);
    assert.equal(progress.status, 'COMPLETED');
    assert.ok(fs.existsSync(path.join(dir, 'progress', `task-${taskId}.json`)));

    // Step 2: snapshots.readAffectedFiles reads the sidecar
    const affected = readAffectedFiles(dir, taskId);
    assert.deepEqual(affected, ['src/foo.js', 'src/bar.js']);

    // Step 3: verifier produces structured output → sidecar is written
    const verifierSdkResult = {
      structured_output: {
        result: 'PASSED',
        hardChecks: [{ name: 'npm test', status: 'PASS', evidence: 'all green' }],
        taskScopeChecks: [{ description: 'files match spec', status: 'PASS', evidence: 'src/foo.js:12' }],
        standardsChecks: [],
        back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
        notes: '',
      },
    };
    const verdict = extractVerdict(verifierSdkResult, taskId, dir);
    assert.equal(verdict.verified, true);
    assert.ok(fs.existsSync(path.join(dir, 'verification', `task-${taskId}.json`)));

    // Step 4: state-machine transitions verified (gated on sidecar existence) —
    // this is exactly where bonus bug 1 was: before d62c5fa, this threw
    // because the gate hardcoded .md.
    await transitionTask(dir, taskId, 'verified', { caller: 'verification' });
    assert.equal(getTaskStatus(dir, taskId), 'verified');

    await transitionTask(dir, taskId, 'complete');
    assert.equal(getTaskStatus(dir, taskId), 'complete');

    // Step 5: audit reads the JSON sidecar at milestone close
    const auditResult = auditVerification(dir, msId);
    assert.equal(auditResult.total, 1);
    assert.deepEqual(auditResult.anomalies, []);
  } finally { cleanup(dir); }
});

// ── Bonus bug 1 regression sentinel ────────────────────────────────────

await test('bonus bug 1 regression: state-machine verified gate accepts JSON sidecar', async () => {
  const dir = createHarness();
  try {
    const { taskId } = seedTaskAwaitingVerification(dir);

    // Write a valid JSON sidecar (no .md) — this is the state where
    // d62c5fa's fix matters.
    fs.writeFileSync(
      path.join(dir, 'verification', `task-${taskId}.json`),
      JSON.stringify({ result: 'PASSED', hardChecks: [], taskScopeChecks: [], notes: '' })
    );

    // This must NOT throw. Pre-d62c5fa, it threw:
    // "Transition to 'verified' requires verification report at ...task-{id}.md"
    await transitionTask(dir, taskId, 'verified', { caller: 'verification' });
    assert.equal(getTaskStatus(dir, taskId), 'verified');
  } finally { cleanup(dir); }
});

await test('bonus bug 1 regression: state-machine gate rejects when neither sidecar nor .md exists', async () => {
  const dir = createHarness();
  try {
    const { taskId } = seedTaskAwaitingVerification(dir);
    // Neither .json nor .md present
    await assertThrows(
      () => transitionTask(dir, taskId, 'verified', { caller: 'verification' }),
      /requires verification sidecar/
    );
  } finally { cleanup(dir); }
});

// ── Bonus bug 2 regression sentinel ────────────────────────────────────
//
// Bug 2: the pipeline tried to transition from awaiting_verification to
// awaiting_verification on resume. The state-machine correctly rejects
// this as a self-loop — that's not the bug. The bug was in pipeline.js
// calling the illegal transition. This test documents the invariant:
// the state machine MUST reject the self-loop. If this invariant ever
// changes, pipeline.js's resume path needs to be re-audited.

await test('bonus bug 2 regression sentinel: state machine rejects awaiting_verification self-loop', async () => {
  const dir = createHarness();
  try {
    const { taskId } = seedTaskAwaitingVerification(dir);
    // Task is already at awaiting_verification. Attempting to transition
    // to the same state must throw — this is the invariant that
    // pipeline.js's resume path relies on (it skips the transition if
    // already at awaiting_verification).
    await assertThrows(
      () => transitionTask(dir, taskId, 'awaiting_verification'),
      /Illegal task transition/
    );
  } finally { cleanup(dir); }
});

// ── Schema drift → validation failure → conservative default ──────────
//
// If a future SDK or prompt edit produces structured output that doesn't
// match the schema, the validators should flag it and the extraction
// helpers should return conservative defaults (FAILED / BLOCKED) instead
// of silently propagating broken state.

await test('schema drift: malformed verifier output → verified=false, sidecar still persisted', async () => {
  const dir = createHarness();
  const taskId = '001-001-001-001';
  try {
    const malformed = {
      structured_output: {
        result: 'MAYBE_PASSED',  // not in enum
        hardChecks: [],
        taskScopeChecks: [],
      },
    };
    const origWarn = console.warn;
    console.warn = () => {}; // silence deprecation warnings for this assertion
    try {
      const verdict = extractVerdict(malformed, taskId, dir);
      assert.equal(verdict.verified, false, 'malformed structured output must not verify');
      assert.ok(fs.existsSync(path.join(dir, 'verification', `task-${taskId}.json`)));
    } finally {
      console.warn = origWarn;
    }
  } finally { cleanup(dir); }
});

await test('schema drift: malformed executor output → BLOCKED, sidecar persisted', async () => {
  const dir = createHarness();
  const taskId = '001-001-001-001';
  try {
    const malformed = {
      structured_output: {
        status: 'PARTIALLY_DONE',  // not in enum
        summary: 'x',
        affectedFiles: [],
      },
    };
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const progress = extractProgress(malformed, taskId, dir);
      assert.equal(progress.status, 'BLOCKED');
      assert.ok(fs.existsSync(path.join(dir, 'progress', `task-${taskId}.json`)));
    } finally {
      console.warn = origWarn;
    }
  } finally { cleanup(dir); }
});

// ── Summary ────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

} // end of async function run()

run();
