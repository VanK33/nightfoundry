/**
 * test-test-registration-pipeline.js — Pipeline-wiring tests for the
 * test-registration gate (spec acceptance #5).
 *
 * The gate's unit tests (test-test-registration-gate.js, TC1-4) only exercise
 * the checkTestRegistration function in isolation. These tests cover the
 * load-bearing pipeline override that flips a verified verdict to FAILED when a
 * task created an unregistered test:
 *
 *   #5a: per-task verify-pass (_executeAndVerifyTask) where the task created an
 *        unregistered test → verifyResult overridden, task → failed.
 *
 * Run: node test/test-test-registration-pipeline.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeMissionState } from '../src/orchestrator/core/state.js';
import config from '../src/orchestrator/infra/config.js';

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

/**
 * Build a temp project: a scripts/run-tests.js exporting `registered` as
 * TEST_FILES, a harness with the given tasks under one sub-mission, verify.json
 * sidecars with EMPTY hardChecks (so only the test-registration gate can
 * override a verified verdict), and the target files created on disk.
 */
function createEnv(tasks, registered) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-reg-pipe-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(harnessDir, 'logs', 'token-usage.json'), JSON.stringify({ sessions: [], totals: {} }));

  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'run-tests.js'), `export const TEST_FILES = ${JSON.stringify(registered)};\n`);

  const parts = tasks[0].id.split('-');
  const milestoneId = parts[0];
  const missionId = `${parts[0]}-${parts[1]}`;
  const subMissionId = `${parts[0]}-${parts[1]}-${parts[2]}`;

  const state = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId, description: 'm', status: 'pending',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: {
          [missionId]: {
            id: missionId, description: 'mi', status: 'pending',
            stateFile: `.harness/state/mission-${missionId}.json`,
            planFile: `.harness/plan/mission-${missionId}.md`,
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  writeMissionState(harnessDir, missionId, 'mi', {
    subMissions: [{
      id: subMissionId, description: 'sm',
      tasks: tasks.map((t) => ({
        id: t.id, description: 'task', targetFiles: t.targetFiles,
        dependencies: [], testCases: [], status: t.status || 'pending',
      })),
    }],
  });

  for (const t of tasks) {
    fs.writeFileSync(
      path.join(harnessDir, 'verify', `task-${t.id}.json`),
      JSON.stringify({ taskId: t.id, targetFiles: t.targetFiles, hardChecks: [], testCases: [] })
    );
    // Create each target file on disk (before-snapshot baseline).
    for (const tf of t.targetFiles) {
      const abs = path.join(root, tf);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '// baseline\n');
    }
  }

  return { root, harnessDir, missionId, subMissionId, milestoneId };
}

function makePipeline(root) {
  const logs = [];
  const pipeline = new Pipeline(root, { onLog: (m) => logs.push(m), onConfirm: async () => true, statusBar: false });
  pipeline._dispatchAnalyzer = async () => {};
  return { pipeline, logs };
}

// ── #5a: per-task override ────────────────────────────────────────────────────
await test('#5a: per-task verify-pass creating an unregistered test → task failed (gate override)', async () => {
  const taskId = '001-001-001-001';
  const bogus = 'test/test-bogus-unregistered.js';
  // Registered set deliberately EXCLUDES the bogus test.
  const env = createEnv([{ id: taskId, targetFiles: [bogus] }], ['test/test-something-else.js']);
  const origMaxRetries = config.maxRetries;
  config.maxRetries = 0;
  try {
    const { pipeline, logs } = makePipeline(env.root);
    pipeline.executor = {
      executeTask: async (task) => {
        fs.writeFileSync(
          path.join(pipeline.harnessDir, 'progress', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, status: 'COMPLETED', affectedFiles: [bogus] })
        );
        // Mutate the bogus test so the phantom-write guard sees a real change.
        fs.writeFileSync(path.join(env.root, bogus), '// a test the executor wrote but did not register\n');
        return { status: 'COMPLETED', affectedFiles: [bogus] };
      },
    };
    pipeline.verifier = {
      verifyTask: async (task) => {
        fs.writeFileSync(
          path.join(pipeline.harnessDir, 'verification', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, verified: true })
        );
        return { verified: true };
      },
    };

    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: taskId, description: 'task', targetFiles: [bogus], dependencies: [],
    });

    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[taskId];
    assert.strictEqual(task.status, 'failed', `expected failed (gate override), got ${task.status}`);
    assert.ok(
      logs.some((l) => /test-registration gate FAILED/i.test(l)),
      `expected a 'test-registration gate FAILED' log, got: ${logs.slice(-8).join('\n')}`
    );
  } finally {
    config.maxRetries = origMaxRetries;
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
