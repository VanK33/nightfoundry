/**
 * test-invalidation-reason.js — Tests for invalidationReason persistence and
 * drain semantics.
 *
 * TC1: transitionTask to 'invalidated' with opts.invalidationReason='replaced'
 *      persists the field — read back mission state JSON, assert
 *      task.invalidationReason === 'replaced'.
 * TC2: transitionTask to 'invalidated' with opts.invalidationReason='redundant'
 *      persists the field — assert task.invalidationReason === 'redundant'.
 * TC3: transitionTask to 'invalidated' with no opts.invalidationReason — assert
 *      task.invalidationReason is undefined (backward compat).
 * TC4: _assertSpecHardCheckCoverage skips sidecar for task with
 *      invalidationReason='replaced' — only sidecar carrying check X belongs to
 *      a replaced-invalidated task → IncompleteScopeError (orphan).
 * TC5: _assertSpecHardCheckCoverage counts sidecar for task with
 *      invalidationReason='redundant' as coverage — only sidecar carrying check X
 *      belongs to a redundant-invalidated task → no throw.
 * TC6: _assertSpecHardCheckCoverage legacy fallback — invalidated task with no
 *      invalidationReason field → skipped with warning log mentioning
 *      'missing invalidationReason'.
 * TC7: Control — complete task sidecar still counts as coverage.
 *
 * Run: node test/test-invalidation-reason.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { transitionTask } from '../src/orchestrator/core/state-machine.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { IncompleteScopeError } from '../src/orchestrator/core/incomplete-scope-error.js';

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

// ── Shared check fixture ─────────────────────────────────────────────────────

const CHECK_X = { name: 'check X', command: 'node test/test-x.js' };

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Create a temp project root with a `.harness` dir containing the structures
 * that Pipeline and transitionTask expect.
 *
 * Extended from test-hardcheck-rehoming.js to support:
 *   preInvalidationReason: { [taskId]: string } — sets invalidationReason on
 *     the task entry in the mission state JSON alongside the status.
 */
function createEnv(
  tasks,
  {
    preStatus = {},
    preInvalidationReason = {},
    specChecks = null,
    specTargetFiles = [],
  } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-reason-test-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of [
    'state',
    'verify',
    'verification',
    'progress',
    'analysis',
    'snapshots',
    'plan',
    'logs',
  ]) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(harnessDir, 'logs', 'token-usage.json'),
    JSON.stringify({ sessions: [], totals: {} })
  );

  const prdPath = path.join(root, 'spec.md');
  fs.writeFileSync(prdPath, '# spec');

  const byMission = new Map();
  for (const task of tasks) {
    if (!byMission.has(task.missionId)) byMission.set(task.missionId, []);
    byMission.get(task.missionId).push(task);
  }

  const milestones = { '001': { id: '001', status: 'in_progress', missions: {} } };

  for (const [missionId, missionTasks] of byMission.entries()) {
    milestones['001'].missions[missionId] = {
      id: missionId,
      status: 'in_progress',
      stateFile: `.harness/state/mission-${missionId}.json`,
    };
    const bySubMission = new Map();
    for (const t of missionTasks) {
      if (!bySubMission.has(t.subMissionId)) bySubMission.set(t.subMissionId, []);
      bySubMission.get(t.subMissionId).push(t);
    }
    const subMissions = {};
    for (const [smId, smTasks] of bySubMission.entries()) {
      const taskMap = {};
      for (const t of smTasks) {
        const entry = {
          id: t.id,
          description: t.description || 'test',
          status: preStatus[t.id] || 'pending',
          retryCount: 0,
        };
        if (preInvalidationReason[t.id] !== undefined) {
          entry.invalidationReason = preInvalidationReason[t.id];
        }
        taskMap[t.id] = entry;
      }
      subMissions[smId] = { id: smId, status: 'in_progress', tasks: taskMap };
    }
    fs.writeFileSync(
      path.join(harnessDir, 'state', `mission-${missionId}.json`),
      JSON.stringify(
        {
          id: missionId,
          missionId,
          description: 'test mission',
          status: 'in_progress',
          subMissions,
        },
        null,
        2
      )
    );
  }

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(
      {
        projectMeta: {
          prdPath,
          createdAt: new Date().toISOString(),
          currentPhase: 'executing',
        },
        globalStatus: 'active',
        milestones,
      },
      null,
      2
    )
  );

  if (specChecks) {
    const specJson = {
      goal: 'invalidation reason test spec',
      target_files: specTargetFiles,
      acceptance_criteria: specChecks.map((c) => ({
        description: c.name,
        verification: { kind: 'command', command: c.command, targetFile: c.targetFile },
      })),
    };
    fs.writeFileSync(path.join(root, 'spec.json'), JSON.stringify(specJson, null, 2));
  }

  return { root, harnessDir };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Write a verify sidecar at .harness/verify/task-<taskId>.json. */
function writeSidecar(harnessDir, taskId, targetFiles, hardChecks) {
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles, hardChecks, testCases: [] }, null, 2)
  );
}

/** Read mission state JSON for a task and return the task entry. */
function readTaskFromMissionState(harnessDir, taskId) {
  const missionId = taskId.split('-').slice(0, 2).join('-');
  const subMissionId = taskId.split('-').slice(0, 3).join('-');
  const data = JSON.parse(
    fs.readFileSync(
      path.join(harnessDir, 'state', `mission-${missionId}.json`),
      'utf8'
    )
  );
  return data.subMissions?.[subMissionId]?.tasks?.[taskId];
}

/**
 * Build a bare Pipeline for calling _assertSpecHardCheckCoverage directly.
 */
function makeDrainPipeline(projectRoot) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    statusBar: false,
  });
  return { pipeline, logs };
}

/**
 * Remove the process signal listeners the Pipeline constructor registers.
 */
function teardownPipeline(pipeline) {
  const handlers = pipeline._signalHandlers || {};
  if (handlers.SIGINT) process.removeListener('SIGINT', handlers.SIGINT);
  if (handlers.SIGTERM) process.removeListener('SIGTERM', handlers.SIGTERM);
  if (handlers.exit) process.removeListener('exit', handlers.exit);
  if (handlers.uncaughtException)
    process.removeListener('uncaughtException', handlers.uncaughtException);
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {
  // ── TC1: invalidationReason='replaced' is persisted ─────────────────────────
  await test(
    "TC1 transitionTask to 'invalidated' with invalidationReason='replaced' persists the field",
    async () => {
      const task = {
        id: '001-001-001-001',
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['test/test-x.js'],
        dependencies: [],
        description: 'task for TC1',
      };
      const env = createEnv([task]);
      try {
        await transitionTask(env.harnessDir, task.id, 'invalidated', {
          invalidationReason: 'replaced',
        });
        const entry = readTaskFromMissionState(env.harnessDir, task.id);
        assert.ok(entry, 'task entry must exist in mission state');
        assert.strictEqual(entry.status, 'invalidated', 'task status must be invalidated');
        assert.strictEqual(
          entry.invalidationReason,
          'replaced',
          `task.invalidationReason must be 'replaced', got: ${JSON.stringify(entry.invalidationReason)}`
        );
      } finally {
        cleanup(env.root);
      }
    }
  );

  // ── TC2: invalidationReason='redundant' is persisted ─────────────────────────
  await test(
    "TC2 transitionTask to 'invalidated' with invalidationReason='redundant' persists the field",
    async () => {
      const task = {
        id: '001-001-001-002',
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['test/test-x.js'],
        dependencies: [],
        description: 'task for TC2',
      };
      const env = createEnv([task]);
      try {
        await transitionTask(env.harnessDir, task.id, 'invalidated', {
          invalidationReason: 'redundant',
        });
        const entry = readTaskFromMissionState(env.harnessDir, task.id);
        assert.ok(entry, 'task entry must exist in mission state');
        assert.strictEqual(entry.status, 'invalidated', 'task status must be invalidated');
        assert.strictEqual(
          entry.invalidationReason,
          'redundant',
          `task.invalidationReason must be 'redundant', got: ${JSON.stringify(entry.invalidationReason)}`
        );
      } finally {
        cleanup(env.root);
      }
    }
  );

  // ── TC3: no invalidationReason → field remains absent ────────────────────────
  await test(
    "TC3 transitionTask to 'invalidated' with no opts.invalidationReason → task.invalidationReason is undefined",
    async () => {
      const task = {
        id: '001-001-001-003',
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['test/test-x.js'],
        dependencies: [],
        description: 'task for TC3',
      };
      const env = createEnv([task]);
      try {
        await transitionTask(env.harnessDir, task.id, 'invalidated');
        const entry = readTaskFromMissionState(env.harnessDir, task.id);
        assert.ok(entry, 'task entry must exist in mission state');
        assert.strictEqual(entry.status, 'invalidated', 'task status must be invalidated');
        assert.strictEqual(
          entry.invalidationReason,
          undefined,
          `task.invalidationReason must be undefined for backward compat, got: ${JSON.stringify(entry.invalidationReason)}`
        );
      } finally {
        cleanup(env.root);
      }
    }
  );

  // ── TC4: replaced-invalidated task sidecar → orphan (IncompleteScopeError) ──
  await test(
    "TC4 _assertSpecHardCheckCoverage skips sidecar for replaced-invalidated task → IncompleteScopeError",
    async () => {
      const task = {
        id: '001-001-001-001',
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['test/test-x.js'],
        dependencies: [],
        description: 'replaced-invalidated owner of check X',
      };
      const env = createEnv([task], {
        preStatus: { [task.id]: 'invalidated' },
        preInvalidationReason: { [task.id]: 'replaced' },
        specChecks: [{ ...CHECK_X, targetFile: 'test/test-x.js' }],
        specTargetFiles: ['test/test-x.js'],
      });
      const { pipeline } = makeDrainPipeline(env.root);
      try {
        writeSidecar(env.harnessDir, task.id, task.targetFiles, [CHECK_X]);

        let thrown = null;
        try {
          await pipeline._assertSpecHardCheckCoverage();
        } catch (err) {
          thrown = err;
        }
        assert.ok(
          thrown,
          'drain must throw when the only sidecar carrying check X belongs to a replaced-invalidated task'
        );
        assert.ok(
          thrown instanceof IncompleteScopeError,
          `drain must throw IncompleteScopeError, got: ${thrown.name}: ${thrown.message}`
        );
        assert.ok(
          thrown.message.includes(CHECK_X.command),
          `the error must name the orphaned command "${CHECK_X.command}", got: ${thrown.message}`
        );
      } finally {
        teardownPipeline(pipeline);
        cleanup(env.root);
      }
    }
  );

  // ── TC5: redundant-invalidated task sidecar counts as coverage → no throw ───
  await test(
    "TC5 _assertSpecHardCheckCoverage counts sidecar for redundant-invalidated task as coverage → no throw",
    async () => {
      const task = {
        id: '001-001-001-001',
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['test/test-x.js'],
        dependencies: [],
        description: 'redundant-invalidated owner of check X',
      };
      const env = createEnv([task], {
        preStatus: { [task.id]: 'invalidated' },
        preInvalidationReason: { [task.id]: 'redundant' },
        specChecks: [{ ...CHECK_X, targetFile: 'test/test-x.js' }],
        specTargetFiles: ['test/test-x.js'],
      });
      const { pipeline } = makeDrainPipeline(env.root);
      try {
        writeSidecar(env.harnessDir, task.id, task.targetFiles, [CHECK_X]);
        // Must not throw: redundant-invalidated sidecar still counts as coverage
        await pipeline._assertSpecHardCheckCoverage();
      } finally {
        teardownPipeline(pipeline);
        cleanup(env.root);
      }
    }
  );

  // ── TC6: legacy invalidated task (no invalidationReason) → skip + warning ───
  await test(
    "TC6 _assertSpecHardCheckCoverage legacy fallback: invalidated task with no invalidationReason → skipped with warning log",
    async () => {
      const task = {
        id: '001-001-001-001',
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['test/test-x.js'],
        dependencies: [],
        description: 'legacy invalidated owner of check X',
      };
      // preInvalidationReason intentionally omitted → no invalidationReason field
      const env = createEnv([task], {
        preStatus: { [task.id]: 'invalidated' },
        specChecks: [{ ...CHECK_X, targetFile: 'test/test-x.js' }],
        specTargetFiles: ['test/test-x.js'],
      });
      const { pipeline, logs } = makeDrainPipeline(env.root);
      try {
        writeSidecar(env.harnessDir, task.id, task.targetFiles, [CHECK_X]);

        let thrown = null;
        try {
          await pipeline._assertSpecHardCheckCoverage();
        } catch (err) {
          thrown = err;
        }

        // Legacy path: skip conservatively (treat like 'replaced' — orphan)
        assert.ok(
          thrown instanceof IncompleteScopeError,
          `drain must throw IncompleteScopeError for legacy invalidated task, got: ${thrown ? thrown.name + ': ' + thrown.message : 'no error'}`
        );
        // Warning log must mention 'missing invalidationReason'
        assert.ok(
          logs.some((l) => l.includes('missing invalidationReason')),
          `expected a log line mentioning 'missing invalidationReason', got logs:\n${logs.join('\n')}`
        );
      } finally {
        teardownPipeline(pipeline);
        cleanup(env.root);
      }
    }
  );

  // ── TC7: Control — complete task sidecar counts as coverage ─────────────────
  await test(
    'TC7 control: complete task sidecar still counts as coverage → no throw',
    async () => {
      const task = {
        id: '001-001-001-001',
        missionId: '001-001',
        subMissionId: '001-001-001',
        targetFiles: ['test/test-x.js'],
        dependencies: [],
        description: 'complete owner of check X',
      };
      const env = createEnv([task], {
        preStatus: { [task.id]: 'complete' },
        specChecks: [{ ...CHECK_X, targetFile: 'test/test-x.js' }],
        specTargetFiles: ['test/test-x.js'],
      });
      const { pipeline } = makeDrainPipeline(env.root);
      try {
        writeSidecar(env.harnessDir, task.id, task.targetFiles, [CHECK_X]);
        // Must not throw: complete task sidecar always counts
        await pipeline._assertSpecHardCheckCoverage();
      } finally {
        teardownPipeline(pipeline);
        cleanup(env.root);
      }
    }
  );

  // ── Summary ──────────────────────────────────────────────────────────────────

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

run();
