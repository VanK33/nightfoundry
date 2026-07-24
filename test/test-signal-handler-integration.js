/**
 * test-signal-handler-integration.js — Integration test that simulates
 * SIGINT / SIGTERM delivery to a running pipeline.
 *
 * Verifies that signal handlers do NOT call process.exit() and that the
 * pipeline settles cleanly after receiving a signal (graceful-cancel,
 * spec-tier1-graceful-cancel.md §Item C).
 *
 * Covers:
 *   TC1 — SIGINT handler does not call process.exit
 *   TC2 — state.json remains parseable JSON after SIGINT
 *   TC3 — pipeline.resume() settles (does not hang) after SIGINT
 *   TC4 — SIGTERM handler also does not call process.exit
 *
 * Run: node test/test-signal-handler-integration.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import config from '../src/orchestrator/infra/config.js';
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

// ── Fixture helpers ──────────────────────────────────────────────────

/**
 * Create a temp project root with a .harness subdirectory and a minimal
 * global state.json + per-mission state files. Mirrors the helper in
 * test-pipeline-scheduler.js.
 */
function createIntegrationHarness({
  milestoneId = '001',
  missions,
}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-signal-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis', 'learning', 'dry-run', 'brainstorm']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const missionEntries = {};
  for (const mission of missions) {
    missionEntries[mission.id] = {
      id: mission.id,
      description: `mission ${mission.id}`,
      status: 'pending',
      stateFile: `.harness/state/mission-${mission.id}.json`,
      planFile: `.harness/plan/mission-${mission.id}.md`,
    };

    const tasks = {};
    for (const task of mission.tasks) {
      tasks[task.id] = {
        id: task.id,
        description: task.description || `task ${task.id}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
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

      // Create the source file in projectRoot so snapshots can copy it
      for (const f of task.targetFiles || []) {
        const full = path.join(projectRoot, f);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (!fs.existsSync(full)) fs.writeFileSync(full, `// ${f}\n`);
      }

      // Write the stub verify.json that the state machine expects
      fs.writeFileSync(
        path.join(harnessDir, 'verify', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, targetFiles: task.targetFiles || [], hardChecks: [], testCases: [] })
      );
    }

    const subMissionId = `${mission.id}-001`;
    const missionState = {
      id: mission.id,
      missionId: mission.id,
      description: `mission ${mission.id}`,
      status: 'pending',
      subMissions: {
        [subMissionId]: {
          id: subMissionId,
          description: 'sm',
          status: 'pending',
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
    projectMeta: {
      prdPath: '',
      createdAt: new Date().toISOString(),
      currentPhase: 'executing',
    },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId,
        description: `milestone ${milestoneId}`,
        status: 'pending',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: missionEntries,
      },
    },
  };

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(state, null, 2)
  );

  return { projectRoot, harnessDir };
}

function cleanup(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

/**
 * Install fake agents with a configurable delay so there is time for
 * a signal to arrive mid-execution. 200ms default ensures signals sent
 * at 100ms land before any task completes.
 */
function installFakes(pipeline, { failTaskIds = new Set(), delay = 200 } = {}) {
  const trace = {
    executorCalls: [],
    verifierCalls: [],
    startOrder: [],
    runningDuringStart: [],
  };
  const running = new Set();

  pipeline.executor = {
    executeTask: async (task, projectRoot, _opts) => {
      trace.executorCalls.push({ taskId: task.id, targetFiles: task.targetFiles });
      trace.startOrder.push(task.id);
      trace.runningDuringStart.push({
        taskId: task.id,
        concurrent: new Set(running),
      });
      running.add(task.id);

      if (failTaskIds.has(task.id)) {
        running.delete(task.id);
        const progressPath = path.join(pipeline.harnessDir, 'progress', `task-${task.id}.json`);
        fs.writeFileSync(progressPath, JSON.stringify({
          taskId: task.id,
          status: 'BLOCKED',
          affectedFiles: [],
          blockers: ['simulated failure'],
        }));
        return { status: 'BLOCKED', affectedFiles: [], blockers: ['simulated failure'] };
      }

      // Simulate work — long enough for a signal to interrupt
      await new Promise((r) => setTimeout(r, delay));

      const progressPath = path.join(pipeline.harnessDir, 'progress', `task-${task.id}.json`);
      fs.writeFileSync(progressPath, JSON.stringify({
        taskId: task.id,
        status: 'COMPLETE',
        affectedFiles: task.targetFiles || [],
      }));

      running.delete(task.id);
      return { status: 'COMPLETE', affectedFiles: task.targetFiles || [] };
    },
  };

  pipeline.verifier = {
    verifyTask: async (task, _projectRoot, _opts) => {
      trace.verifierCalls.push({ taskId: task.id });

      const sidecarPath = path.join(pipeline.harnessDir, 'verification', `task-${task.id}.json`);
      fs.writeFileSync(sidecarPath, JSON.stringify({
        taskId: task.id,
        verified: true,
        report: 'fake verifier',
      }));

      return { verified: true, report: 'fake verifier', structured: { verified: true, report: 'fake verifier' } };
    },
  };

  pipeline.analyzer = {
    analyzeFailure: async (_opts, _projectRoot) => {
      return { eventId: 'fake', recommendation: 'human', affectedTasks: [] };
    },
  };

  // Stub the reviewer so signal tests don't require real SDK auth.
  pipeline.reviewer = {
    reviewMilestone: async () => ({ passed: true, findings: [] }),
  };

  return trace;
}

function makePipeline(projectRoot) {
  const origMax = config.execution.maxConcurrentSessions;
  config.execution.maxConcurrentSessions = 2;

  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
  });

  const restore = () => {
    config.execution.maxConcurrentSessions = origMax;
  };

  return { pipeline, logs, restore };
}

// ── Shared fixture state for TC1–TC3 ────────────────────────────────
// TC1, TC2, TC3 share a single pipeline run: TC1 captures exit calls,
// TC2 checks state.json afterwards, TC3 checks the promise settled.

let _tc1_projectRoot = null;
let _tc1_harnessDir = null;
let _tc1_exitCalls = null;
let _tc1_resumePromise = null;
let _tc1_restore = null;
let _tc1_pipeline = null;

// ── Tests ────────────────────────────────────────────────────────────

await test('TC1: SIGINT handler does not call process.exit', async () => {
  const missions = [
    {
      id: '001-001',
      tasks: [
        { id: '001-001-001-001', targetFiles: ['src/a.js'] },
        { id: '001-001-001-002', targetFiles: ['src/b.js'] },
      ],
    },
  ];
  const { projectRoot, harnessDir } = createIntegrationHarness({ missions });
  _tc1_projectRoot = projectRoot;
  _tc1_harnessDir = harnessDir;

  const { pipeline, restore } = makePipeline(projectRoot);
  _tc1_restore = restore;
  _tc1_pipeline = pipeline;

  installFakes(pipeline, { delay: 200 });
  pipeline._missionRegression = async () => {};
  pipeline._reviewGate = async () => {};

  // Monkey-patch process.exit to record calls (never actually exits).
  const exitCalls = [];
  const origExit = process.exit;
  process.exit = (code) => exitCalls.push(code);
  _tc1_exitCalls = exitCalls;

  // Start the resume() pipeline — it will run async alongside our timer.
  _tc1_resumePromise = pipeline.resume();

  // After 100ms (tasks are 200ms) — pipeline is mid-flight. Send SIGINT.
  await new Promise((r) => setTimeout(r, 100));
  pipeline._signalHandlers.SIGINT();

  // Await the pipeline to settle (resolve or reject). Use a 10s timeout
  // so TC3 can reuse the same promise result.
  await Promise.race([
    _tc1_resumePromise.then(() => null, () => null),
    new Promise((_, rej) => setTimeout(() => rej(new Error('TC1 timeout: pipeline did not settle within 10s')), 10000)),
  ]);

  // Restore process.exit before asserting so a re-throw won't kill the process.
  process.exit = origExit;

  assert.strictEqual(exitCalls.length, 0,
    `process.exit should NOT have been called after SIGINT; got ${exitCalls.length} call(s) with codes: ${JSON.stringify(exitCalls)}`);
});

await test('TC2: state.json remains parseable JSON after SIGINT', async () => {
  assert.ok(_tc1_harnessDir, 'TC2 depends on TC1 having run — harnessDir must exist');

  const stateJsonPath = path.join(_tc1_harnessDir, 'state.json');
  assert.ok(fs.existsSync(stateJsonPath), `state.json must exist at ${stateJsonPath}`);

  let parsed;
  const raw = fs.readFileSync(stateJsonPath, 'utf8');
  assert.doesNotThrow(() => {
    parsed = JSON.parse(raw);
  }, 'state.json must be parseable JSON after SIGINT');

  // Expected top-level keys present
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'projectMeta'),
    'state.json must contain "projectMeta" key');
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'globalStatus'),
    'state.json must contain "globalStatus" key');
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'milestones'),
    'state.json must contain "milestones" key');

  // Cleanup shared TC1-TC3 harness now that TC2 assertions are done.
  if (_tc1_restore) { _tc1_restore(); _tc1_restore = null; }
  if (_tc1_projectRoot) { cleanup(_tc1_projectRoot); _tc1_projectRoot = null; }
});

await test('TC3: pipeline.resume() settles (does not hang) after SIGINT', async () => {
  assert.ok(_tc1_resumePromise, 'TC3 depends on TC1 having started the resume() promise');

  // If TC1 already settled the promise (await above), this will resolve
  // immediately. Either way, racing with 10s timeout proves no hang.
  let settled = false;
  await Promise.race([
    _tc1_resumePromise.then(() => { settled = true; }, () => { settled = true; }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('TC3: pipeline.resume() did not settle within 10s after SIGINT')), 10000)
    ),
  ]);

  assert.ok(settled, 'pipeline.resume() must resolve or reject after SIGINT; it must not hang');

  // Null out shared state.
  _tc1_resumePromise = null;
  _tc1_pipeline = null;
  _tc1_exitCalls = null;
});

await test('TC4: SIGTERM handler also does not call process.exit', async () => {
  const missions = [
    {
      id: '001-001',
      tasks: [
        { id: '001-001-001-001', targetFiles: ['src/x.js'] },
        { id: '001-001-001-002', targetFiles: ['src/y.js'] },
      ],
    },
  ];
  const { projectRoot, harnessDir } = createIntegrationHarness({ missions });
  const { pipeline, restore } = makePipeline(projectRoot);

  installFakes(pipeline, { delay: 200 });
  pipeline._missionRegression = async () => {};
  pipeline._reviewGate = async () => {};

  // Monkey-patch process.exit to record calls (never actually exits).
  const exitCalls = [];
  const origExit = process.exit;
  process.exit = (code) => exitCalls.push(code);

  try {
    const resumePromise = pipeline.resume();

    // After 100ms — pipeline is mid-flight. Send SIGTERM.
    await new Promise((r) => setTimeout(r, 100));
    pipeline._signalHandlers.SIGTERM();

    // Await settlement with a 10s guard.
    await Promise.race([
      resumePromise.then(() => null, () => null),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('TC4 timeout: pipeline did not settle within 10s after SIGTERM')), 10000)
      ),
    ]);

    assert.strictEqual(exitCalls.length, 0,
      `process.exit should NOT have been called after SIGTERM; got ${exitCalls.length} call(s) with codes: ${JSON.stringify(exitCalls)}`);
  } finally {
    process.exit = origExit;
    restore();
    cleanup(projectRoot);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
