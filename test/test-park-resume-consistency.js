#!/usr/bin/env node
/**
 * test-park-resume-consistency.js — Track P P2: a requeued (reattached) entry
 * re-runs against its persisted mission-state without redoing already-complete
 * tasks, and the re-attached diff does not contradict the persisted state
 * (spec: p2-park-diff-preservation.spec.md / .json, AC5).
 *
 * Written by the INDEPENDENT test author against the spec's acceptance
 * criteria + the pinned interface contract — before the implementation
 * exists. At a pre-feature HEAD this fails on module resolution
 * (src/orchestrator/core/park-snapshot.js absent).
 *
 * AC5: preserve + reattach + resume must stay CONSISTENT. The spec is explicit
 * (architecture notes) that AC5 leans on the EXISTING resume behavior
 * (scheduler skips terminal-on-disk tasks; mission-state sidecars persist)
 * rather than new mid-execution coverage machinery — so this test crosses the
 * REAL persist→reattach→re-run boundary:
 *
 *   1. A mission-state sidecar is persisted with some tasks terminal-on-disk
 *      ('complete' + a verification sidecar), exactly the on-disk shape the
 *      scheduler's resume path reads (mirrors test/test-scheduler-resume.js's
 *      createResumeHarness — its fixture format is the production contract).
 *   2. The verified WIP from the (incomplete) work is preserved with the REAL
 *      createParkSnapshot (gc-safe stash ref), leaving the tree clean.
 *   3. The preserved WIP is re-attached with the REAL reattachParkSnapshot.
 *   4. The REAL pipeline._executeMilestone re-runs the persisted milestone and
 *      MUST skip the already-complete tasks (no re-execution) while the
 *      re-attached WIP coexists with the persisted state (no contradiction).
 *
 * Discipline (spec Constraints / two-agents): only the agent SDK seams
 * (executor / verifier / analyzer / reviewer) are faked, exactly as
 * test-scheduler-resume.js does; the scheduler, state-machine, resume path,
 * and the park-snapshot primitive are all real.
 *
 * Run: node test/test-park-resume-consistency.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import config from '../src/orchestrator/infra/config.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import {
  createParkSnapshot,
  reattachParkSnapshot,
} from '../src/orchestrator/core/park-snapshot.js';

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

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Build a resume-shaped harness INSIDE a real git repo. This is
 * test-scheduler-resume.js's createResumeHarness format (the on-disk resume
 * contract: .harness/state/mission-<id>.json + per-task verification sidecars
 * for terminal tasks) layered onto an initialized git repo whose source files
 * are committed, so the park-snapshot git primitive has a real base to work
 * against.
 *
 * @param {{ missions, preStatus, committedFiles }} cfg
 */
function createGitResumeHarness({ milestoneId = '001', missions, preStatus = {}, committedFiles = {} }) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-park-resume-'));
  const harnessDir = path.join(projectRoot, '.harness');

  // Real git repo: identity + committed source files + a .gitignore for the
  // harness dirs so .harness/ writes do not themselves become WIP that the
  // snapshot would capture.
  git(projectRoot, 'init');
  git(projectRoot, 'config user.email "test@example.com"');
  git(projectRoot, 'config user.name "Test User"');
  fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.harness/\nqueue/\narchives/\n');
  for (const [rel, content] of Object.entries(committedFiles)) {
    const full = path.join(projectRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const missionEntries = {};
  for (const mission of missions) {
    missionEntries[mission.id] = {
      id: mission.id,
      description: `mission ${mission.id}`,
      status: preStatus[mission.id] || 'pending',
      stateFile: `.harness/state/mission-${mission.id}.json`,
      planFile: `.harness/plan/mission-${mission.id}.md`,
    };

    const tasks = {};
    for (const task of mission.tasks) {
      const taskStatus = preStatus[task.id] || 'pending';
      tasks[task.id] = {
        id: task.id,
        description: task.description || `task ${task.id}`,
        status: taskStatus,
        createdAt: new Date().toISOString(),
        startedAt: taskStatus !== 'pending' ? new Date().toISOString() : null,
        completedAt: (taskStatus === 'complete' || taskStatus === 'invalidated') ? new Date().toISOString() : null,
        targetFiles: task.targetFiles || [],
        dependencies: task.dependencies || [],
        testCases: [],
        tracesScenario: [],
        patternReferences: [],
        dataSchemas: [],
        verifyFile: `.harness/verify/task-${task.id}.json`,
        progressFile: `.harness/progress/task-${task.id}.json`,
        verificationFile: `.harness/verification/task-${task.id}.json`,
        retryCount: 0,
      };

      for (const f of task.targetFiles || []) {
        const full = path.join(projectRoot, f);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (!fs.existsSync(full)) fs.writeFileSync(full, `// ${f}\n`);
      }

      fs.writeFileSync(
        path.join(harnessDir, 'verify', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, targetFiles: task.targetFiles || [], hardChecks: [], testCases: [] })
      );

      // Terminal-on-disk: a verification sidecar with result:'PASSED' is what
      // the scheduler resume path / Phase-5 audit reads to treat a task as
      // already done.
      if (taskStatus === 'verified' || taskStatus === 'complete') {
        fs.writeFileSync(
          path.join(harnessDir, 'verification', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', report: 'pre-seeded' })
        );
      }
    }

    const subMissionId = `${mission.id}-001`;
    const missionState = {
      id: mission.id,
      missionId: mission.id,
      description: `mission ${mission.id}`,
      status: preStatus[`mission:${mission.id}`] || 'pending',
      subMissions: {
        [subMissionId]: {
          id: subMissionId,
          description: 'sm',
          status: preStatus[`sm:${subMissionId}`] || 'pending',
          tasks,
        },
      },
    };
    fs.writeFileSync(
      path.join(harnessDir, 'state', `mission-${mission.id}.json`),
      JSON.stringify(missionState, null, 2)
    );
  }

  const state = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId,
        description: `milestone ${milestoneId}`,
        status: preStatus[`ms:${milestoneId}`] || 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: missionEntries,
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  // Commit the source files so the working tree starts clean (the park
  // snapshot's base). .harness/ etc. are gitignored.
  git(projectRoot, 'add -A');
  git(projectRoot, 'commit -m seed');

  return { projectRoot, harnessDir };
}

function readTaskState(harnessDir, missionId, subMissionId, taskId) {
  const state = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), 'utf8'));
  return state.subMissions[subMissionId].tasks[taskId];
}

// Fake the agent SDK seams only (mirrors test-scheduler-resume.js installFakes).
function installFakes(pipeline) {
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
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'verification', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, verified: true, result: 'PASSED', report: 'fake' })
      );
      return { verified: true, report: 'fake', structured: { verified: true, report: 'fake' } };
    },
  };
  // verifyRegression: the regression gates now call the dedicated method;
  // the mock reuses the same implementation (same id-sniff branches apply).
  pipeline.verifier.verifyRegression = pipeline.verifier.verifyTask;
  pipeline.analyzer = { analyzeFailure: async () => ({ eventId: 'fake', recommendation: 'human', affectedTasks: [] }) };
  pipeline.reviewer = {
    reviewMilestone: async () => ({
      passed: true, findings: [], report: 'fake', reportPath: '',
      structured: { result: 'PASSED', findings: [], passedReason: 'fake' },
    }),
  };
  return trace;
}

function makePipeline(projectRoot, { maxConcurrent = 3 } = {}) {
  const origMax = config.execution.maxConcurrentSessions;
  config.execution.maxConcurrentSessions = maxConcurrent;
  const pipeline = new Pipeline(projectRoot, { onLog: () => {}, onConfirm: async () => true });
  pipeline._missionRegression = async () => {};
  return { pipeline, restore: () => { config.execution.maxConcurrentSessions = origMax; } };
}

// ── AC5: requeue re-run skips complete tasks; reattached WIP coexists ───────

await test('AC5: a reattached entry re-runs against persisted mission-state — already-complete tasks are NOT redone and the re-attached WIP coexists with the persisted state', async () => {
  const missions = [{
    id: '001-001',
    tasks: [
      { id: '001-001-001-001', targetFiles: ['src/a.js'] }, // complete on disk
      { id: '001-001-001-002', targetFiles: ['src/b.js'] }, // complete on disk
      { id: '001-001-001-003', targetFiles: ['src/c.js'] }, // pending — re-runs
    ],
  }];
  const preStatus = {
    '001-001-001-001': 'complete',
    '001-001-001-002': 'complete',
  };
  // The complete tasks' target files carry their finished content committed at
  // seed; the pending task's file is the unfinished placeholder.
  const committedFiles = {
    'src/a.js': '// src/a.js — task 001 finished\n',
    'src/b.js': '// src/b.js — task 002 finished\n',
    'src/c.js': '// src/c.js\n',
  };

  const { projectRoot, harnessDir } = createGitResumeHarness({ missions, preStatus, committedFiles });
  const { pipeline, restore } = makePipeline(projectRoot);

  try {
    // ── Persist boundary already crossed by the fixture: tasks 1+2 are
    // terminal-on-disk, the source tree is committed clean.

    // The verified WIP that existed when the entry halted: a tracked edit to
    // the pending task's file + an untracked new test file the executor wrote.
    fs.writeFileSync(path.join(projectRoot, 'src/c.js'), '// src/c.js — WIP-IN-PROGRESS\n');
    fs.writeFileSync(path.join(projectRoot, 'src/c.test.js'), '// UNTRACKED-WIP-TEST\n');

    // ── Preserve (the park snapshot the halt would take instead of reset). ──
    const snap = createParkSnapshot('resume-consistency', projectRoot);
    assert.ok(snap, 'fixture: createParkSnapshot must preserve the WIP for a dirty tree');
    assert.strictEqual(git(projectRoot, 'status --porcelain').trim(), '',
      'fixture: the snapshot must leave the tree clean (ready for the next entry)');

    // ── Reattach (what requeue does before re-run). ──
    reattachParkSnapshot(snap.stashRef, projectRoot);

    // The re-attached WIP must NOT contradict the persisted state: the
    // already-complete tasks' files are untouched by the reattach…
    assert.strictEqual(fs.readFileSync(path.join(projectRoot, 'src/a.js'), 'utf8'),
      '// src/a.js — task 001 finished\n',
      'the re-attached WIP must not overwrite a completed task\'s persisted output (no contradiction)');
    assert.strictEqual(fs.readFileSync(path.join(projectRoot, 'src/b.js'), 'utf8'),
      '// src/b.js — task 002 finished\n',
      'the re-attached WIP must not overwrite the second completed task\'s persisted output');
    // …and the preserved WIP is back in the tree.
    assert.strictEqual(fs.readFileSync(path.join(projectRoot, 'src/c.js'), 'utf8'),
      '// src/c.js — WIP-IN-PROGRESS\n',
      'the re-attached WIP (tracked edit to the pending task\'s file) must be restored');
    assert.ok(fs.existsSync(path.join(projectRoot, 'src/c.test.js')),
      'the re-attached WIP (untracked new test file) must be restored');

    // ── Re-run the persisted milestone (the requeued entry re-executes). ──
    const trace = installFakes(pipeline);
    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone('001', globalState.milestones['001']);

    // The already-complete tasks must NOT be redone — only the pending task
    // re-executes (this is the scheduler skipping terminal-on-disk tasks).
    assert.deepStrictEqual(trace.executorCalls.sort(), ['001-001-001-003'],
      `only the pending task may re-execute; the complete tasks must be skipped (got ${JSON.stringify(trace.executorCalls.sort())})`);
    assert.ok(!trace.executorCalls.includes('001-001-001-001'),
      'task 001 (complete-on-disk) must NOT be re-executed after requeue');
    assert.ok(!trace.executorCalls.includes('001-001-001-002'),
      'task 002 (complete-on-disk) must NOT be re-executed after requeue');

    // Final persisted state stays consistent: all three end complete, and the
    // completed tasks were never reset back to a re-run.
    for (const task of missions[0].tasks) {
      const st = readTaskState(harnessDir, '001-001', '001-001-001', task.id);
      assert.strictEqual(st.status, 'complete',
        `task ${task.id} must be complete in the final persisted state (got '${st.status}')`);
    }

    // The re-attached WIP from the pending task still coexists with the
    // persisted complete-task outputs — nothing was clobbered by the re-run.
    assert.ok(fs.existsSync(path.join(projectRoot, 'src/c.test.js')),
      'the re-attached untracked WIP must still coexist with the persisted state after the re-run');
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
