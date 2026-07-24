#!/usr/bin/env node
/**
 * test-needs-revalidation-repass.js — the mid-run needs_revalidation re-pass
 * loop in Pipeline._executeMilestoneParallel.
 *
 * Written by the INDEPENDENT test author against the FIX CONTRACT only, in
 * parallel with the code author. Bug (archive failed-121): a task marked
 * complete → needs_revalidation MID-run by the analyzer cascade in
 * _dispatchAnalyzer is stranded — the scheduler only re-dispatches
 * needs_revalidation at milestone START (its runMilestone start scan), so after
 * scheduler.runMilestone returns, assertNoNonTerminalTasks finds the task
 * non-terminal and throws PendingTasksAtMilestoneAdvance → entry
 * failed-execution.
 *
 * The fix being implemented: _executeMilestoneParallel wraps the scheduler pass
 * in a bounded RE-PASS loop. After runMilestone returns cleanly, if any task is
 * needs_revalidation it re-calls runMilestone(msId, taskDAG) (which re-dispatches
 * needs_revalidation tasks via its start scan, re-validating them), looping up to
 * a CAP (3) with a no-progress repeat check; on convergence it proceeds to
 * assertNoNonTerminalTasks; on cap-exhaustion or a no-progress repeat it throws a
 * CircuitBreakerError with recommendation:'human' (→ routes to 'halted-analyzer'
 * PARK, NOT failed-execution); a genuinely-unrescuable non-terminal task
 * (pending/in_progress/blocked/failed — NOT needs_revalidation) still throws
 * PendingTasksAtMilestoneAdvance.
 *
 * SCENARIOS (all drive the real Pipeline + real Scheduler; only the per-task
 * work seam — executor/verifier, or the scheduler's documented runTask callback —
 * is controlled, never runMilestone or _executeMilestoneParallel):
 *
 *   S1 (Convergence — the core fix): a 2-task milestone where, while the REAL
 *      scheduler runs task A, a completed sibling task B is transitioned
 *      complete → needs_revalidation ON DISK (simulating the _dispatchAnalyzer
 *      cascade mark, AFTER the start scan already classified B as terminal). The
 *      re-pass loop must re-run runMilestone, whose start scan now re-dispatches
 *      B through the REAL _executeAndVerifyTask revalidation path (verifier seam
 *      passes) → B reaches 'complete' → the milestone advances WITHOUT throwing.
 *      NON-VACUITY: at pre-fix HEAD runMilestone returns with B still
 *      needs_revalidation, so assertNoNonTerminalTasks throws
 *      PendingTasksAtMilestoneAdvance — this scenario FAILS pre-fix and converges
 *      post-fix.
 *
 *   S2 (Cap/cycle → human-park): a needs_revalidation task that never drains
 *      (its runTask re-marks it needs_revalidation every pass → identical
 *      non-terminal set, no progress). After the cap / no-progress repeat,
 *      _executeMilestoneParallel must throw a CircuitBreakerError with
 *      recommendation === 'human' (asserted by error TYPE + recommendation),
 *      NOT a bare PendingTasksAtMilestoneAdvance and NOT a silent pass. This is
 *      what routes the entry to 'halted-analyzer' (park) instead of
 *      failed-execution. NON-VACUITY: this scenario FAILS if cap-exhaustion
 *      throws a bare PendingTasks (wrong type) or passes silently.
 *
 *   S3 (Genuine strand still throws — invariant not regressed): a task left
 *      in_progress (NOT needs_revalidation) at milestone advance must STILL throw
 *      PendingTasksAtMilestoneAdvance. The re-pass loop must not rescue or mask a
 *      non-needs_revalidation strand. NON-VACUITY: this scenario FAILS if the
 *      loop wrongly rescues an in_progress strand (no throw) or throws the wrong
 *      type.
 *
 * New-symbol handling: CircuitBreakerError already exists at HEAD
 * (src/orchestrator/core/circuit-breaker-error.js) and is imported directly; if
 * a future refactor moves it, the import would fail loudly — acceptable, since
 * the fix contract names this exact type.
 *
 * It is EXPECTED this file is not all-green until the code author lands the fix
 * (S1 throws PendingTasks pre-fix; S2 either passes-silently or throws the wrong
 * type pre-fix). `node --check` confirms it parses.
 *
 * Run: node test/test-needs-revalidation-repass.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import config from '../src/orchestrator/infra/config.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { CircuitBreakerError } from '../src/orchestrator/core/circuit-breaker-error.js';
import { PendingTasksAtMilestoneAdvance } from '../src/orchestrator/core/pending-tasks-error.js';
import { transitionTask } from '../src/orchestrator/core/state-machine.js';
import { readTaskStatus } from '../src/orchestrator/core/state.js';

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

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Create a temp project root with a .harness directory and a single milestone
 * '001' / mission '001-001' / sub-mission '001-001-001' carrying the given
 * tasks, each with a configurable pre-seeded status.
 *
 * Missions are written with status 'complete' so the resume re-judge path in
 * _executeMilestoneParallel skips _planAndApproveMission and builds the gate set
 * from completed missions — the scheduler then runs whichever TASKS are still
 * non-terminal on disk. (Established pattern: test-scheduler-resume.js +
 * test-dispatch-pending-invariant.js.)
 *
 * `tasks`: [{ id, status, targetFiles?, dependencies?, description? }]
 */
function createRepassHarness({ tasks, milestoneId = '001', missionId = '001-001' } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-repass-'));
  const harnessDir = path.join(projectRoot, '.harness');
  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  const subMissionId = `${missionId}-001`;

  const taskMap = {};
  for (const t of tasks) {
    const status = t.status || 'pending';
    const targetFiles = t.targetFiles || [`src/${t.id}.js`];
    taskMap[t.id] = {
      id: t.id,
      description: t.description || `task ${t.id}`,
      status,
      createdAt: new Date().toISOString(),
      startedAt: status !== 'pending' ? new Date().toISOString() : null,
      completedAt: (status === 'complete' || status === 'invalidated') ? new Date().toISOString() : null,
      targetFiles,
      dependencies: t.dependencies || [],
      testCases: [],
      tracesScenario: [],
      patternReferences: [],
      dataSchemas: [],
      verifyFile: `.harness/verify/task-${t.id}.json`,
      progressFile: `.harness/progress/task-${t.id}.json`,
      verificationFile: `.harness/verification/task-${t.id}.json`,
      retryCount: 0,
    };

    // Source files (snapshots/diffs read these).
    for (const f of targetFiles) {
      const full = path.join(projectRoot, f);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (!fs.existsSync(full)) fs.writeFileSync(full, `// ${f}\n`);
    }

    // verify.json with EMPTY hardChecks → runHardChecks passes trivially on the
    // real revalidation path (zero checks ⇒ passed:true).
    fs.writeFileSync(
      path.join(harnessDir, 'verify', `task-${t.id}.json`),
      JSON.stringify({ taskId: t.id, targetFiles, hardChecks: [], testCases: [] })
    );

    // A real (non-stub) verification sidecar for any task that started terminal,
    // so the state-machine gate + assertNoStubVerifierSidecar are satisfied.
    if (status === 'complete' || status === 'verified') {
      fs.writeFileSync(
        path.join(harnessDir, 'verification', `task-${t.id}.json`),
        JSON.stringify({ taskId: t.id, verified: true, report: 'pre-seeded', result: 'PASSED' })
      );
    }
  }

  const missionState = {
    id: missionId,
    missionId,
    description: `mission ${missionId}`,
    status: 'complete',
    subMissions: {
      [subMissionId]: { id: subMissionId, description: 'sub-mission', status: 'complete', tasks: taskMap },
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify(missionState, null, 2)
  );

  const msState = {
    id: milestoneId,
    description: `milestone ${milestoneId}`,
    status: 'in_progress',
    planFile: `.harness/plan/milestone-${milestoneId}.md`,
    missions: {
      [missionId]: {
        id: missionId,
        description: `mission ${missionId}`,
        status: 'complete',
        stateFile: `.harness/state/mission-${missionId}.json`,
        planFile: `.harness/plan/mission-${missionId}.md`,
      },
    },
  };
  const globalState = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: { [milestoneId]: msState },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  return { projectRoot, harnessDir, milestoneId, missionId, subMissionId, msState };
}

function cleanup(projectRoot) {
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

function readTaskState(harnessDir, missionId, subMissionId, taskId) {
  const state = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), 'utf8'));
  return state.subMissions[subMissionId].tasks[taskId];
}

/**
 * Build a real Pipeline scoped to the gate-free re-pass path:
 *   - _skipCoverageGate true   → no spec-hard-check / milestone-coverage gates
 *   - _missionRegression no-op → Phase C does not pull in regression machinery
 *   - reviewer not invoked     → we call _executeMilestoneParallel directly
 * Concurrency is forced via config so file-overlap serialization is deterministic.
 */
function makePipeline(projectRoot, { maxConcurrent = 3 } = {}) {
  const origMax = config.execution.maxConcurrentSessions;
  config.execution.maxConcurrentSessions = maxConcurrent;

  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    statusBar: false,
    skipWorktreeCreation: true,
    noReview: true,
  });
  pipeline._skipCoverageGate = true;
  pipeline._missionRegression = async () => {};
  pipeline._msStartTime = Date.now();

  const restore = () => { config.execution.maxConcurrentSessions = origMax; };
  return { pipeline, logs, restore };
}

/**
 * Install passing executor + verifier seams (the only per-task work seams). The
 * scheduler, runMilestone, _executeMilestoneParallel, _executeAndVerifyTask and
 * the revalidation handler all run for real. `onVerify(task)` is an optional hook
 * fired at the START of every verifyTask — used by S1 to inject the mid-run mark.
 */
function installPassingSeams(pipeline, { onVerify = null } = {}) {
  const trace = { executorCalls: [], verifierCalls: [] };
  pipeline.executor = {
    executeTask: async (task) => {
      trace.executorCalls.push(task.id);
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'progress', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, status: 'COMPLETE', affectedFiles: task.targetFiles || [] })
      );
      return { status: 'COMPLETE', affectedFiles: task.targetFiles || [] };
    },
  };
  pipeline.verifier = {
    verifyTask: async (task) => {
      trace.verifierCalls.push(task.id);
      if (onVerify) await onVerify(task);
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'verification', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, verified: true, report: 'fake', result: 'PASSED' })
      );
      return { verified: true, report: 'fake', structured: { verified: true, report: 'fake' } };
    },
  };
  pipeline.analyzer = {
    analyzeFailure: async () => ({ eventId: 'fake', recommendation: 'human', affectedTasks: [] }),
  };
  return trace;
}

// ═════════════════════════════════════════════════════════════════════════════
// S1 — CONVERGENCE (the core fix). REAL scheduler; the mid-run mark is injected
// from inside the verifier seam of task A, flipping a completed sibling B
// complete → needs_revalidation AFTER the start scan has already classified B as
// terminal. The re-pass loop must re-run runMilestone and drive B to 'complete'
// through the REAL revalidation path; the milestone must advance without throwing.
//
// NON-VACUITY: at pre-fix HEAD runMilestone returns with B still
// needs_revalidation; assertNoNonTerminalTasks then throws
// PendingTasksAtMilestoneAdvance. This case PASSES only after the fix lands.
// ═════════════════════════════════════════════════════════════════════════════

await test('S1: a completed sibling marked needs_revalidation MID-run (real scheduler) is re-validated by the re-pass loop → milestone advances WITHOUT throwing (pre-fix: throws PendingTasksAtMilestoneAdvance)', async () => {
  const TASK_A = '001-001-001-001'; // pending → drives normally; its verifier injects the mark
  const TASK_B = '001-001-001-002'; // complete at start → marked needs_revalidation mid-run
  const { projectRoot, harnessDir, milestoneId, missionId, subMissionId, msState } = createRepassHarness({
    tasks: [
      { id: TASK_A, status: 'pending', targetFiles: ['src/a.js'] },
      { id: TASK_B, status: 'complete', targetFiles: ['src/b.js'] },
    ],
  });
  const { pipeline, restore } = makePipeline(projectRoot);
  try {
    let markedOnce = false;
    let bRevalidated = false;
    installPassingSeams(pipeline, {
      onVerify: async (task) => {
        // While A is being verified in the FIRST pass, mark the already-complete
        // sibling B for revalidation — exactly what _dispatchAnalyzer's cascade
        // does mid-run, AFTER the scheduler's start scan classified B terminal.
        if (task.id === TASK_A && !markedOnce) {
          markedOnce = true;
          if (readTaskStatus(harnessDir, TASK_B) === 'complete') {
            await transitionTask(harnessDir, TASK_B, 'needs_revalidation');
          }
        }
        // Observe that B's revalidation actually flows through the real path on
        // the re-pass (B enters verifyTask while in needs_revalidation lineage).
        if (task.id === TASK_B) bRevalidated = true;
      },
    });

    // REAL scheduler, REAL re-pass loop. Must not throw post-fix.
    let thrown = null;
    try {
      await pipeline._executeMilestoneParallel(milestoneId, msState);
    } catch (err) {
      thrown = err;
    }

    assert.ok(markedOnce, 'precondition: the mid-run mark must have fired during pass 1');
    assert.strictEqual(thrown, null,
      `the re-pass loop must converge and advance WITHOUT throwing — got ${thrown && thrown.constructor.name}: ${thrown && thrown.message}. ` +
      `At pre-fix HEAD this throws PendingTasksAtMilestoneAdvance because B is left needs_revalidation after runMilestone returns.`);

    // B must have been re-dispatched through the real revalidation path and
    // driven to terminal.
    assert.ok(bRevalidated, 'task B must have been re-dispatched through the real revalidation (verifyTask) path on the re-pass');
    const bFinal = readTaskState(harnessDir, missionId, subMissionId, TASK_B);
    assert.strictEqual(bFinal.status, 'complete',
      `task B must end 'complete' after revalidation, got '${bFinal.status}'`);
    const aFinal = readTaskState(harnessDir, missionId, subMissionId, TASK_A);
    assert.strictEqual(aFinal.status, 'complete', `task A must end 'complete', got '${aFinal.status}'`);
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// S2 — CAP / CYCLE → HUMAN-PARK. A needs_revalidation task that never drains:
// its runTask re-marks it needs_revalidation every pass, so each re-pass produces
// the IDENTICAL non-terminal set (no progress). The re-pass loop must NOT loop
// forever, NOT pass silently, and NOT throw a bare PendingTasksAtMilestoneAdvance.
// It must throw a CircuitBreakerError with recommendation === 'human' — the shape
// the batch catch routes to 'halted-analyzer' (park) rather than failed-execution.
//
// We install the scheduler's documented runTask seam (the real Scheduler, real
// runMilestone start-scan re-dispatch, real re-pass loop) so non-convergence is
// forced deterministically without per-task lifecycle noise.
//
// NON-VACUITY: pre-fix there is no re-pass loop — the single pass leaves the task
// needs_revalidation and assertNoNonTerminalTasks throws a bare
// PendingTasksAtMilestoneAdvance (wrong type). This case PASSES only after the
// fix wraps the loop and converts cap/no-progress into the human CircuitBreaker.
// ═════════════════════════════════════════════════════════════════════════════

await test("S2: a needs_revalidation task that never drains → re-pass cap/no-progress throws CircuitBreakerError with recommendation==='human' (parks), NOT a bare PendingTasksAtMilestoneAdvance and NOT a silent pass", async () => {
  const STUCK = '001-001-001-001';
  const { projectRoot, harnessDir, milestoneId, msState } = createRepassHarness({
    tasks: [{ id: STUCK, status: 'needs_revalidation', targetFiles: ['src/a.js'] }],
  });
  const { pipeline, restore } = makePipeline(projectRoot);
  try {
    // Inert per-task seams so _executeAndVerifyTask is never relied on for this
    // task's draining behavior.
    installPassingSeams(pipeline);

    // Replace ONLY the scheduler's runTask callback (its documented work seam).
    // The Scheduler, runMilestone, _executeMilestoneParallel and the re-pass loop
    // remain the real implementations. Every time the task is dispatched it is
    // re-asserted needs_revalidation — it never reaches terminal, and the
    // non-terminal set is byte-identical every pass (no progress).
    let dispatches = 0;
    pipeline.scheduler.runTask = async (task) => {
      dispatches++;
      const status = readTaskStatus(harnessDir, task.id);
      // Normalise back to needs_revalidation regardless of how the start scan
      // left it, so the post-pass non-terminal set is invariant across passes.
      if (status !== 'needs_revalidation') {
        // legal path back: needs_revalidation → awaiting_verification → failed →
        // ... is noisy; instead just leave it. The start scan keeps it
        // needs_revalidation, and we deliberately do nothing terminal here.
      }
    };

    let thrown = null;
    try {
      await pipeline._executeMilestoneParallel(milestoneId, msState);
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown !== null,
      'a never-draining needs_revalidation task must NOT pass silently — the re-pass loop must escalate');
    assert.ok(thrown instanceof CircuitBreakerError,
      `cap/no-progress must throw a CircuitBreakerError (so the batch catch can route to halted-analyzer), got ${thrown.constructor.name}: ${thrown.message}`);
    assert.strictEqual(thrown.recommendation, 'human',
      `the escalation must carry recommendation==='human' (this is what parks the entry rather than failed-execution), got recommendation=${JSON.stringify(thrown.recommendation)}`);
    assert.ok(!(thrown instanceof PendingTasksAtMilestoneAdvance),
      'a never-draining needs_revalidation task must NOT throw a bare PendingTasksAtMilestoneAdvance (that routes to failed-execution, the bug)');
    assert.ok(dispatches >= 2,
      `the re-pass loop must re-dispatch the stuck task more than once before escalating (got ${dispatches} dispatch(es))`);
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// S3 — GENUINE STRAND STILL THROWS (invariant not regressed). A task left
// in_progress (NOT needs_revalidation) at milestone advance must STILL throw
// PendingTasksAtMilestoneAdvance. The re-pass loop must only rescue
// needs_revalidation strands — it must not rescue or mask an in_progress strand.
//
// We use the scheduler's runTask seam to leave the task in_progress (no terminal
// transition). The worker resolves without error, the pass drains and returns,
// and the task is left non-terminal but NOT needs_revalidation.
//
// NON-VACUITY: this case FAILS if the loop wrongly rescues the in_progress strand
// (no throw) or throws the wrong type — the loop must be needs_revalidation-only.
// ═════════════════════════════════════════════════════════════════════════════

await test('S3: a task left in_progress (NOT needs_revalidation) at advance still throws PendingTasksAtMilestoneAdvance — the re-pass loop must not rescue a non-needs_revalidation strand', async () => {
  const STRAND = '001-001-001-001';
  const { projectRoot, harnessDir, milestoneId, missionId, subMissionId, msState } = createRepassHarness({
    tasks: [{ id: STRAND, status: 'in_progress', targetFiles: ['src/a.js'] }],
  });
  const { pipeline, restore } = makePipeline(projectRoot);
  try {
    installPassingSeams(pipeline);

    // runTask seam that does NOT advance the task — it stays in_progress on disk.
    let dispatches = 0;
    pipeline.scheduler.runTask = async () => { dispatches++; };

    let thrown = null;
    try {
      await pipeline._executeMilestoneParallel(milestoneId, msState);
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown !== null,
      'an in_progress strand at milestone advance must still throw (the invariant must not be regressed)');
    assert.ok(thrown instanceof PendingTasksAtMilestoneAdvance,
      `a non-needs_revalidation strand must throw PendingTasksAtMilestoneAdvance, got ${thrown.constructor.name}: ${thrown.message}`);
    assert.ok(!(thrown instanceof CircuitBreakerError),
      'an in_progress strand must NOT be escalated as a human CircuitBreaker — only needs_revalidation strands route to park');
    assert.ok(Array.isArray(thrown.pendingTaskIds) && thrown.pendingTaskIds.includes(STRAND),
      `pendingTaskIds must include the stranded in_progress task ${STRAND}, got ${JSON.stringify(thrown.pendingTaskIds)}`);

    const final = readTaskState(harnessDir, missionId, subMissionId, STRAND);
    assert.strictEqual(final.status, 'in_progress',
      `the strand must remain in_progress (not silently rescued), got '${final.status}'`);
    assert.ok(dispatches >= 1, 'the strand must have been dispatched at least once by the real scheduler');
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
