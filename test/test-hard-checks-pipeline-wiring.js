/**
 * test-hard-checks-pipeline-wiring.js — Hard-checks gate pipeline wiring tests.
 *
 * Verifies that the hard-checks gate (runHardChecks) is correctly wired into
 * the pipeline's _executeAndVerifyTask path. Tests cover the interaction between
 * verify.json hardChecks entries, the gate's pass/fail result shape, and the
 * pipeline's branching logic on gate outcomes.
 *
 * Test cases:
 * CT1: hardCheck gate runs after verifier PASS with passing hardCheck
 * CT2: LLM PASS + hardCheck FAIL → verdict overridden with evidence js-hardCheck mismatch
 * CT3: LLM FAIL → runHardChecks not invoked
 * CT4: zero hardChecks → vacuous PASS, no override
 * CT5: missing verify.json → gate skipped gracefully, verdict stays PASS
 * CT6: sleep 60 hardCheck triggers timeout within ~30s, recorded as FAIL with timeout reason
 * CT7: needs_revalidation path through _executeAndVerifyTask also runs hardCheck gate (mirror CT2)
 * CT8: applySpecHardChecks does NOT throw on a per-mission orphan (assignment-only; judgment deferred to the drain)
 * CT9: _assertSpecHardCheckCoverage with an orphan + _allowIncompleteScope=true warns and does NOT throw
 * CT10: applySpecHardChecks does NOT throw + assigns checks when every path-bearing check is covered
 * CT11: _assertSpecHardCheckCoverage unions across ALL mission files — checks assigned in DIFFERENT missions are not orphans (multi-mission regression)
 * CT12: _assertSpecHardCheckCoverage throws IncompleteScopeError naming the command of a check assigned in NO mission file
 * CT13: _assertSpecHardCheckCoverage is a no-op when spec.json is absent
 * CT14: _assertSpecHardCheckCoverage never flags a no-path-token (milestone-only) check
 * CT15: _assertSpecHardCheckCoverage does NOT throw when the sole persisted task
 *       owning the check's target file has status 'complete' (no hardChecks key,
 *       no verify sidecar — coverage is inferred from the owning task's completion)
 * CT16: _assertSpecHardCheckCoverage throws UnassignedSpecCheckError naming the
 *       check when the identical fixture's sole owning task is 'pending' instead
 *       of 'complete'
 * CT17: _assertSpecHardCheckCoverage does NOT throw when the sole coverage of a
 *       path-bearing spec check is an intact verify/task-*.json sidecar whose
 *       taskId belongs to a persisted non-invalidated task, and no persisted
 *       task has status 'complete' or targetFiles overlapping the check
 *       (proves the terminal-task rule is additive, not a regression of
 *       sidecar-based assignment)
 * CT18: the ONLY possible coverage of a path-bearing spec check is a
 *       verify/task-*.json sidecar belonging to a persisted mission-state task
 *       with status 'invalidated' and invalidationReason 'replaced' — the
 *       sidecar must not suppress the orphan; _assertSpecHardCheckCoverage
 *       throws UnassignedSpecCheckError naming 'node test/test-z.js'
 * CT19: identical fixture to CT18 except invalidationReason 'redundant' — the
 *       sidecar counts as coverage; _assertSpecHardCheckCoverage returns
 *       without throwing
 * CT20: identical fixture to CT18 except the invalidated task carries no
 *       invalidationReason field (legacy) — the pipeline's onLog receives a
 *       message containing 'missing invalidationReason' AND
 *       _assertSpecHardCheckCoverage throws UnassignedSpecCheckError naming
 *       'node test/test-z.js'
 *
 * Run: node test/test-hard-checks-pipeline-wiring.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline, applySpecHardChecks } from '../src/orchestrator/core/pipeline.js';
import { writeMissionState } from '../src/orchestrator/core/state.js';
import { IncompleteScopeError, UnassignedSpecCheckError } from '../src/orchestrator/core/incomplete-scope-error.js';
import config from '../src/orchestrator/infra/config.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failCount++;
    }
  );
}

/**
 * Build a minimal harness directory with one task ready for
 * _executeAndVerifyTask. Creates state.json, the mission state file,
 * and writes a verify.json sidecar with the provided hardChecks array.
 *
 * @param {string} taskId
 * @param {{ taskStatus?: string, hardChecks?: Array<{name:string,command:string,expectExitCode?:number,timeout?:number}> }} options
 */
function createPipelineEnv(taskId = '001-004-001-001', { taskStatus = 'pending', hardChecks = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-pipeline-test-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(harnessDir, 'logs', 'token-usage.json'),
    JSON.stringify({ sessions: [], totals: {} })
  );

  const parts = taskId.split('-');
  const missionId = `${parts[0]}-${parts[1]}`;
  const subMissionId = `${parts[0]}-${parts[1]}-${parts[2]}`;
  const milestoneId = parts[0];

  const state = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId,
        description: 'test milestone',
        status: 'pending',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: {
          [missionId]: {
            id: missionId,
            description: 'test mission',
            status: 'pending',
            stateFile: `.harness/state/mission-${missionId}.json`,
            planFile: `.harness/plan/mission-${missionId}.md`,
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  writeMissionState(harnessDir, missionId, 'test mission', {
    subMissions: [{
      id: subMissionId,
      description: 'test sm',
      tasks: [{
        id: taskId,
        description: 'test task for hard-checks wiring',
        targetFiles: ['src/foo.js'],
        dependencies: [],
        testCases: [],
        status: taskStatus,
      }],
    }],
  });

  // Write verify.json sidecar with the provided hardChecks
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: ['src/foo.js'], hardChecks, testCases: [] })
  );

  // Create the targetFile so before-snapshot can capture it
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/foo.js'), 'original content');

  return { root, harnessDir, taskId, missionId, subMissionId, milestoneId };
}

/**
 * Build a Pipeline instance with stubbed executor, verifier, analyzer,
 * and _dispatchAnalyzer for deterministic testing.
 *
 * Executor stub: writes progress sidecar + edits src/foo.js to 'modified'.
 * Verifier stub: writes verification sidecar + returns verifyResult.
 * Analyzer stub: no-op (returns minimal shape).
 * _dispatchAnalyzer stub: no-op.
 *
 * @param {string} projectRoot
 * @param {{ execResult: object, verifyResult: object }} options
 * @returns {{ pipeline: Pipeline, logs: string[] }}
 */
function makePipelineWithFakes(projectRoot, { execResult, verifyResult }) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    statusBar: false,
  });

  pipeline.executor = {
    executeTask: async (task) => {
      // Write progress sidecar mimicking executor
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'progress', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, status: execResult.status, affectedFiles: execResult.affectedFiles || [] })
      );
      // Actually edit src/foo.js to 'modified' so phantom-write guard passes
      fs.writeFileSync(path.join(projectRoot, 'src', 'foo.js'), 'modified');
      return execResult;
    },
  };

  pipeline.verifier = {
    verifyTask: async (task) => {
      // Write verification sidecar
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'verification', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, ...verifyResult })
      );
      return verifyResult;
    },
  };

  pipeline.analyzer = {
    analyzeFailure: async () => ({ eventId: 'fake', recommendation: 'human', affectedTasks: [] }),
  };

  pipeline._dispatchAnalyzer = async () => {};

  return { pipeline, logs };
}

/**
 * Build a fixture for the applySpecHardChecks orphan-coverage gate.
 *
 * Creates a tmp project root with a .harness/state.json whose
 * projectMeta.prdPath points at <root>/spec.md, so deriveSpecJsonPath resolves
 * to the sibling <root>/spec.json. Writes that spec.json with one
 * acceptance-criterion verification command per entry in `specCommands`.
 * Returns the matching missionDecomp object (subMissions[].tasks[]) built from
 * `tasks`.
 *
 * @param {{ specCommands: Array<{description:string,command:string}>, tasks: Array<{id:string,targetFiles:string[]}> }} opts
 * @returns {{ root: string, harnessDir: string, missionDecomp: object }}
 */
function createSpecHardCheckEnv({ specCommands = [], tasks = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-orphan-test-'));
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });

  const prdPath = path.join(root, 'spec.md');
  fs.writeFileSync(prdPath, '# spec');

  const state = {
    projectMeta: { prdPath, createdAt: new Date().toISOString(), currentPhase: 'planning' },
    globalStatus: 'active',
    milestones: {},
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  // deriveSpecJsonPath(prdPath='<root>/spec.md') → '<root>/spec.json'
  const specJson = {
    goal: 'test spec',
    acceptance_criteria: specCommands.map((c) => ({
      description: c.description,
      verification: { kind: 'command', command: c.command },
    })),
  };
  fs.writeFileSync(path.join(root, 'spec.json'), JSON.stringify(specJson, null, 2));

  const missionDecomp = {
    subMissions: [{
      id: '001-001-001',
      description: 'test sm',
      tasks: tasks.map((t) => ({
        id: t.id,
        description: 'test task',
        targetFiles: t.targetFiles,
        dependencies: [],
        testCases: [],
      })),
    }],
  };

  return { root, harnessDir, missionDecomp };
}

/**
 * Write a persisted mission state fixture file mirroring writeMissionState's
 * shape (state.js): mission-{missionId}.json →
 *   { id, missionId, description, status,
 *     subMissions: { [smId]: { id, description, status,
 *       tasks: { [taskId]: { ..., status, targetFiles,
 *                             hardChecks?: [{name, command}] } } } } }
 *
 * `assignedChecks` is a list of per-task fixture specs, one task written per
 * entry. Each entry is `{name?, command?, status?, targetFiles?, invalidationReason?}`:
 *   - `command` (with optional `name`) assigns a single hardChecks entry
 *     `[{name, command}]` to that task; when `command` is omitted the task is
 *     written WITHOUT a hardChecks key at all (mirrors a persisted task that
 *     was assigned nothing — e.g. one whose coverage is instead inferred from
 *     its persisted `status`), so the drain's union walk must tolerate the
 *     absent field.
 *   - `status` defaults to 'pending' (matches prior behavior); `targetFiles`
 *     defaults to `[]` (matches prior behavior) — pass either explicitly to
 *     exercise the drain's status-aware / targetFiles-aware ownership rules.
 *   - `invalidationReason`, when provided, is written onto the task entry
 *     alongside `status` (mirrors transitionTask's persisted shape) — pass it
 *     together with `status: 'invalidated'` to exercise the drain's
 *     invalidation-reason branches (replaced / redundant / missing).
 *
 * When `assignedChecks` is empty, a single task WITHOUT a hardChecks key is
 * written (matching tasks persisted with no assigned checks) so the drain's
 * union walk must tolerate the absent field.
 *
 * @param {string} harnessDir
 * @param {string} missionId - e.g. '001-001'
 * @param {Array<{name?:string,command?:string,status?:string,targetFiles?:string[],invalidationReason?:string}>} assignedChecks
 */
function writeMissionStateFixture(harnessDir, missionId, assignedChecks = []) {
  const smId = `${missionId}-001`;
  const tasks = {};
  if (assignedChecks.length === 0) {
    const taskId = `${smId}-001`;
    tasks[taskId] = {
      id: taskId,
      description: 'drain fixture task (no assigned checks)',
      status: 'pending',
      targetFiles: ['src/foo.js'],
      dependencies: [],
      testCases: [],
      // no hardChecks key on purpose — mirrors a persisted task that was
      // assigned nothing; the drain must not trip over the absent field.
    };
  } else {
    assignedChecks.forEach((entry, i) => {
      const taskId = `${smId}-${String(i + 1).padStart(3, '0')}`;
      const { name, command, status = 'pending', targetFiles = [], invalidationReason } = entry;
      const task = {
        id: taskId,
        description: 'drain fixture task',
        status,
        targetFiles,
        dependencies: [],
        testCases: [],
      };
      if (invalidationReason !== undefined) {
        task.invalidationReason = invalidationReason;
      }
      if (typeof command === 'string') {
        task.hardChecks = [{ name, command }];
      }
      tasks[taskId] = task;
    });
  }
  const missionState = {
    id: missionId,
    missionId,
    description: 'drain fixture mission',
    status: 'pending',
    subMissions: {
      [smId]: { id: smId, description: 'drain fixture sm', status: 'pending', tasks },
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify(missionState, null, 2)
  );
}

/**
 * Build a fixture for the _assertSpecHardCheckCoverage drain: a tmp project
 * root with .harness/state.json whose projectMeta.prdPath points at
 * <root>/spec.md (sibling spec.json written from `specCommands` unless
 * writeSpecJson=false), plus one persisted .harness/state/mission-*.json per
 * entry in `missionAssignments` ({ missionId → [{name, command}] }).
 *
 * `sidecars` writes a verify/task-<taskId>.json sidecar per entry — mirroring
 * the persisted-home shape state.js's writeVerifyJson produces
 * ({ taskId, targetFiles, hardChecks, testCases: [] }) — so tests can exercise
 * coverage that is assigned ONLY through a sidecar (no hardChecks key on the
 * mission-state task itself). `targetFiles` defaults to `[]`.
 *
 * @param {{ specCommands?: Array<{description:string,command:string}>,
 *           missionAssignments?: Record<string, Array<{name?:string,command?:string,status?:string,targetFiles?:string[]}>>,
 *           writeSpecJson?: boolean,
 *           sidecars?: Array<{taskId:string,hardChecks:Array<{name:string,command:string}>,targetFiles?:string[]}> }} opts
 * @returns {{ root: string, harnessDir: string }}
 */
function createDrainEnv({ specCommands = [], missionAssignments = {}, writeSpecJson = true, sidecars = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-drain-test-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(harnessDir, 'logs', 'token-usage.json'),
    JSON.stringify({ sessions: [], totals: {} })
  );

  const prdPath = path.join(root, 'spec.md');
  fs.writeFileSync(prdPath, '# spec');

  const state = {
    projectMeta: { prdPath, createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {},
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  if (writeSpecJson) {
    const specJson = {
      goal: 'drain test spec',
      acceptance_criteria: specCommands.map((c) => ({
        description: c.description,
        verification: { kind: 'command', command: c.command },
      })),
    };
    fs.writeFileSync(path.join(root, 'spec.json'), JSON.stringify(specJson, null, 2));
  }

  for (const [missionId, assignedChecks] of Object.entries(missionAssignments)) {
    writeMissionStateFixture(harnessDir, missionId, assignedChecks);
  }

  for (const { taskId, hardChecks = [], targetFiles = [] } of sidecars) {
    fs.writeFileSync(
      path.join(harnessDir, 'verify', `task-${taskId}.json`),
      JSON.stringify({ taskId, targetFiles, hardChecks, testCases: [] })
    );
  }

  return { root, harnessDir };
}

/**
 * Build a bare Pipeline instance for calling _assertSpecHardCheckCoverage
 * directly (no agent fakes needed — the drain only reads .harness state and
 * spec.json from disk).
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
 * Remove the process signal listeners the Pipeline constructor registers, so
 * the drain tests (which construct extra Pipeline instances) don't pile up
 * listeners past Node's MaxListeners warning threshold. removeListener on an
 * unregistered handler is a safe no-op.
 */
function teardownPipeline(pipeline) {
  const handlers = pipeline._signalHandlers || {};
  if (handlers.SIGINT) process.removeListener('SIGINT', handlers.SIGINT);
  if (handlers.SIGTERM) process.removeListener('SIGTERM', handlers.SIGTERM);
  if (handlers.exit) process.removeListener('exit', handlers.exit);
  if (handlers.uncaughtException) process.removeListener('uncaughtException', handlers.uncaughtException);
}

// ── Placeholder tests ────────────────────────────────────────────────────────
// CT1–CT7 are declared in the file header. The full behavioural tests will be
// added in a subsequent task once the hard-checks gate API is finalised.
// These stubs ensure the runner reports the correct test count structure.

await test('CT1: hardCheck gate runs after verifier PASS with passing hardCheck', async () => {
  const env = createPipelineEnv('001-004-001-001', {
    hardChecks: [{ name: 'ok', command: 'true' }],
  });
  try {
    const { pipeline, logs } = makePipelineWithFakes(env.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: true, report: 'ok' },
    });
    pipeline._dispatchAnalyzer = async () => {};
    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: env.taskId, description: 'test task for hard-checks wiring', targetFiles: ['src/foo.js'], dependencies: [],
    });
    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[env.taskId];
    assert.strictEqual(task.status, 'complete', `expected complete, got ${task.status}`);
    assert.ok(logs.some(l => /VERIFIED/i.test(l)), `expected 'VERIFIED' in logs, got: ${logs.slice(-10).join('\n')}`);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('CT2: LLM PASS + hardCheck FAIL → verdict overridden with evidence js-hardCheck mismatch', async () => {
  const env = createPipelineEnv('001-004-001-001', {
    hardChecks: [{ name: 'fail', command: 'false' }],
  });
  const origMaxRetries = config.maxRetries;
  config.maxRetries = 0;
  try {
    const { pipeline, logs } = makePipelineWithFakes(env.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: true, report: 'ok' },
    });
    pipeline._dispatchAnalyzer = async () => {};
    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: env.taskId, description: 'test task for hard-checks wiring', targetFiles: ['src/foo.js'], dependencies: [],
    });
    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[env.taskId];
    assert.strictEqual(task.status, 'failed', `expected failed, got ${task.status}`);
    assert.ok(logs.some(l => /hard-check gate FAILED/i.test(l)), `expected 'hard-check gate FAILED' in logs, got: ${logs.slice(-10).join('\n')}`);
  } finally {
    config.maxRetries = origMaxRetries;
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('CT3: LLM FAIL → runHardChecks not invoked', async () => {
  const env = createPipelineEnv('001-004-001-001', {
    hardChecks: [{ name: 'should-not-run', command: 'false' }],
  });
  const origMaxRetries = config.maxRetries;
  config.maxRetries = 0;
  try {
    const { pipeline, logs } = makePipelineWithFakes(env.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: false, report: 'llm said no' },
    });
    pipeline._dispatchAnalyzer = async () => {};
    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: env.taskId, description: 'test task for hard-checks wiring', targetFiles: ['src/foo.js'], dependencies: [],
    });
    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[env.taskId];
    assert.strictEqual(task.status, 'failed', `expected failed, got ${task.status}`);
    assert.ok(!logs.some(l => /hard-check gate/i.test(l)),
      `expected logs to NOT contain 'hard-check gate', but found: ${logs.filter(l => /hard-check gate/i.test(l)).join('\n')}`);
  } finally {
    config.maxRetries = origMaxRetries;
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('CT4: zero hardChecks → vacuous PASS, no override', async () => {
  const env = createPipelineEnv('001-004-001-001', {
    hardChecks: [],
  });
  try {
    const { pipeline } = makePipelineWithFakes(env.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: true, report: 'ok' },
    });
    pipeline._dispatchAnalyzer = async () => {};
    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: env.taskId, description: 'test task for hard-checks wiring', targetFiles: ['src/foo.js'], dependencies: [],
    });
    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[env.taskId];
    assert.strictEqual(task.status, 'complete', `expected complete, got ${task.status}`);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('CT5: missing verify.json → gate fail-closed, task does NOT complete', async () => {
  const env = createPipelineEnv('001-004-001-001', {
    hardChecks: [],
  });
  // Delete verify.json to simulate missing sidecar
  const verifyPath = path.join(env.harnessDir, 'verify', `task-${env.taskId}.json`);
  fs.unlinkSync(verifyPath);
  try {
    const { pipeline, logs } = makePipelineWithFakes(env.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: true, report: 'ok' },
    });
    pipeline._dispatchAnalyzer = async () => {};
    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: env.taskId, description: 'test task for hard-checks wiring', targetFiles: ['src/foo.js'], dependencies: [],
    });
    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[env.taskId];
    // A2 fail-closed: a missing verify.json makes runHardChecks throw, which now
    // forces the task FAILED — it must NOT pass through to 'complete' on the
    // verifier's own PASS (this case previously asserted the buggy fail-open).
    assert.notStrictEqual(task.status, 'complete',
      `expected task NOT 'complete' (fail-closed on missing verify.json), got ${task.status}`);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('CT6: sleep 60 hardCheck triggers timeout within ~30s, recorded as FAIL with timeout reason', async () => {
  const env = createPipelineEnv('001-004-001-001', {
    hardChecks: [{ name: 'slow', command: 'sleep 60', timeout: 1 }],
  });
  const origMaxRetries = config.maxRetries;
  config.maxRetries = 0;
  try {
    const { pipeline, logs } = makePipelineWithFakes(env.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: true },
    });
    pipeline._dispatchAnalyzer = async () => {};
    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: env.taskId, description: 'test', targetFiles: ['src/foo.js'], dependencies: [],
    });
    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[env.taskId];
    assert.strictEqual(task.status, 'failed', `expected failed, got ${task.status}`);
    assert.ok(logs.some(l => /hard-check gate FAILED/i.test(l)), `expected 'hard-check gate FAILED' in logs, got: ${logs.slice(-10).join('\n')}`);
    const reportPath = path.join(env.harnessDir, 'verification', `task-${env.taskId}-hard.md`);
    assert.ok(fs.existsSync(reportPath), `expected hard-check report at ${reportPath}`);
    const report = fs.readFileSync(reportPath, 'utf8');
    assert.ok(report.includes('TIMEOUT'), `expected 'TIMEOUT' in report, got: ${report.slice(0, 500)}`);
  } finally {
    config.maxRetries = origMaxRetries;
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('CT7: needs_revalidation path also runs hardCheck gate (mirror CT2)', async () => {
  const env = createPipelineEnv('001-004-001-001', {
    hardChecks: [{ name: 'fail', command: 'false' }],
  });
  // maxRetries=0 so the recursive re-execute (revalidation FAIL → re-execute)
  // terminates at the circuit breaker rather than looping.
  const origMaxRetries = config.maxRetries;
  config.maxRetries = 0;
  try {
    // Patch task status to needs_revalidation in the state file
    const stateFile = path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`);
    const ms = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    ms.subMissions[env.subMissionId].tasks[env.taskId].status = 'needs_revalidation';
    fs.writeFileSync(stateFile, JSON.stringify(ms, null, 2));

    // Create before/ and after/ snapshot directories with the target file. The
    // live needs_revalidation branch restores from after/ before the verifier
    // runs, so both must be seeded.
    const beforeDir = path.join(env.harnessDir, 'snapshots', env.taskId, 'before');
    fs.mkdirSync(path.join(beforeDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(beforeDir, 'src', 'foo.js'), 'original content');

    const afterDir = path.join(env.harnessDir, 'snapshots', env.taskId, 'after');
    fs.mkdirSync(path.join(afterDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(afterDir, 'src', 'foo.js'), 'modified content');

    const { pipeline, logs } = makePipelineWithFakes(env.root, {
      execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
      verifyResult: { verified: true },
    });
    pipeline._dispatchAnalyzer = async () => {};

    // Drive the live revalidation path directly through _executeAndVerifyTask on
    // a needs_revalidation task. The verifier passes but the failing hardCheck
    // overrides the revalidation to FAILED, which re-executes; with maxRetries=0
    // the recursive pass terminates at the circuit breaker. The method under test
    // cannot be no-oped, so the fakes (executor COMPLETED, failing hardCheck)
    // ensure termination.
    const task = { id: env.taskId, description: 'test', targetFiles: ['src/foo.js'], dependencies: [] };
    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, task);

    assert.ok(logs.some(l => /hard-check gate FAILED/i.test(l)),
      `expected 'hard-check gate FAILED' in logs, got: ${logs.slice(-10).join('\n')}`);
    assert.ok(logs.some(l => /revalidation FAILED/i.test(l)),
      `expected 'revalidation FAILED' in logs, got: ${logs.slice(-10).join('\n')}`);
  } finally {
    config.maxRetries = origMaxRetries;
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('CT8: applySpecHardChecks does NOT throw on a per-mission orphan (assignment-only; judgment deferred to the drain)', () => {
  // spec.json names test/orphan.js; the only task in THIS mission targets
  // src/foo.js. Under lazy DFS the check may belong to a later mission, so
  // per-mission applySpecHardChecks must pass it through without throwing —
  // the check simply isn't assigned to any task here. Orphan judgment is
  // deferred to the last-milestone drain (_assertSpecHardCheckCoverage).
  const env = createSpecHardCheckEnv({
    specCommands: [{ description: 'later-mission criterion', command: 'node test/orphan.js' }],
    tasks: [{ id: '001-001-001-001', targetFiles: ['src/foo.js'] }],
  });
  try {
    assert.doesNotThrow(
      () => applySpecHardChecks(env.missionDecomp, env.root, env.harnessDir),
      'expected applySpecHardChecks to NOT throw on a per-mission orphan (judgment moved to the drain)',
    );
    // The unmatched check must NOT be assigned onto any of this mission's tasks.
    const allTasks = env.missionDecomp.subMissions.flatMap((sm) => sm.tasks);
    for (const task of allTasks) {
      const cmds = (task.hardChecks || []).map((c) => c.command);
      assert.ok(
        !cmds.includes('node test/orphan.js'),
        `expected the unmatched check NOT assigned to task ${task.id}, got hardChecks: ${JSON.stringify(cmds)}`,
      );
    }
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('CT9: _assertSpecHardCheckCoverage with an orphan + _allowIncompleteScope=true warns and does NOT throw', async () => {
  // spec.json carries a path-bearing check assigned in NO mission file; with
  // the grace flag set, the drain warns and continues instead of throwing.
  const env = createDrainEnv({
    specCommands: [{ description: 'orphan criterion', command: 'node test/orphan.js' }],
    missionAssignments: { '001-001': [] },
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    pipeline._allowIncompleteScope = true;
    // Must not throw (sync) nor reject (if implemented async).
    await pipeline._assertSpecHardCheckCoverage();
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('CT10: applySpecHardChecks does NOT throw + assigns checks when every path-bearing check is covered', () => {
  // spec.json names test/covered.js; the task targets test/covered.js → covered.
  const env = createSpecHardCheckEnv({
    specCommands: [{ description: 'covered criterion', command: 'node test/covered.js' }],
    tasks: [{ id: '001-001-001-001', targetFiles: ['test/covered.js'] }],
  });
  try {
    assert.doesNotThrow(
      () => applySpecHardChecks(env.missionDecomp, env.root, env.harnessDir),
      'expected applySpecHardChecks to NOT throw when every path-bearing check is covered',
    );
    // Unchanged behavior: the covered check is assigned onto the matching task.
    const task = env.missionDecomp.subMissions[0].tasks.find((t) => t.id === '001-001-001-001');
    assert.ok(Array.isArray(task.hardChecks), 'expected the covered task to receive a hardChecks array');
    assert.strictEqual(task.hardChecks.length, 1, `expected 1 assigned hardCheck, got ${task.hardChecks?.length}`);
    assert.strictEqual(task.hardChecks[0].command, 'node test/covered.js');
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('CT11: _assertSpecHardCheckCoverage unions across ALL mission files — checks assigned in DIFFERENT missions are not orphans (multi-mission regression)', async () => {
  // The proving-run scenario: spec has checks A and B; A is assigned in
  // mission-001-001.json, B in mission-001-003.json (a DIFFERENT mission
  // file). The drain judges against the UNION of all persisted assignments,
  // so neither is an orphan and the drain must not throw.
  const env = createDrainEnv({
    specCommands: [
      { description: 'check A', command: 'node test/test-x.js' },
      { description: 'check B', command: 'node test/test-y.js' },
    ],
    missionAssignments: {
      '001-001': [{ name: 'check A', command: 'node test/test-x.js' }],
      '001-003': [{ name: 'check B', command: 'node test/test-y.js' }],
    },
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    // No grace flag — a false orphan here would throw and fail the test.
    await pipeline._assertSpecHardCheckCoverage();
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('CT12: _assertSpecHardCheckCoverage throws IncompleteScopeError naming the command of a check assigned in NO mission file', async () => {
  // Check A is assigned in mission-001-001.json; check C is assigned nowhere
  // → C is a true orphan and the drain must throw IncompleteScopeError whose
  // uncoveredLabels (or message) names C's command.
  const orphanCommand = 'node test/orphan-c.js';
  const env = createDrainEnv({
    specCommands: [
      { description: 'check A', command: 'node test/test-x.js' },
      { description: 'check C', command: orphanCommand },
    ],
    missionAssignments: {
      '001-001': [{ name: 'check A', command: 'node test/test-x.js' }],
    },
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    let thrown = null;
    try {
      await pipeline._assertSpecHardCheckCoverage();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'expected _assertSpecHardCheckCoverage to throw on a true orphan, but it did not throw');
    assert.ok(
      thrown instanceof IncompleteScopeError,
      `expected IncompleteScopeError, got ${thrown.name}: ${thrown.message}`,
    );
    const labels = Array.isArray(thrown.uncoveredLabels) ? thrown.uncoveredLabels : [];
    assert.ok(
      labels.includes(orphanCommand) || thrown.message.includes(orphanCommand),
      `expected uncoveredLabels (or message) to name '${orphanCommand}'; uncoveredLabels=${JSON.stringify(labels)}, message=${thrown.message}`,
    );
    assert.ok(
      !labels.includes('node test/test-x.js'),
      `expected the assigned check A NOT in uncoveredLabels, got ${JSON.stringify(labels)}`,
    );
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('CT13: _assertSpecHardCheckCoverage is a no-op when spec.json is absent', async () => {
  // prdPath resolves to <root>/spec.md but no sibling spec.json exists →
  // the drain returns without throwing.
  const env = createDrainEnv({
    writeSpecJson: false,
    missionAssignments: { '001-001': [] },
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    await pipeline._assertSpecHardCheckCoverage();
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('CT14: _assertSpecHardCheckCoverage never flags a no-path-token (milestone-only) check', async () => {
  // 'npm run test:all' has no path tokens, so it is milestone-only and never
  // an orphan — even though no mission file assigns it. No grace flag set.
  const env = createDrainEnv({
    specCommands: [{ description: 'milestone-wide suite', command: 'npm run test:all' }],
    missionAssignments: { '001-001': [] },
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    await pipeline._assertSpecHardCheckCoverage();
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test("CT15: _assertSpecHardCheckCoverage does NOT throw when the sole persisted task owning the check's target file has status 'complete' (no hardChecks key, no verify sidecar)", async () => {
  // .harness/verify/ is left empty (no sidecar) and the sole persisted task
  // carries NO hardChecks key — coverage must instead be inferred from that
  // task's persisted status ('complete') owning the check's target file.
  const env = createDrainEnv({
    specCommands: [{ description: 'check on test/test-x.js', command: 'node test/test-x.js' }],
    missionAssignments: {
      '001-001': [{ status: 'complete', targetFiles: ['test/test-x.js'] }],
    },
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    // Must not throw (sync) nor reject (if implemented async).
    await pipeline._assertSpecHardCheckCoverage();
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test("CT16: _assertSpecHardCheckCoverage throws UnassignedSpecCheckError naming the check when the identical fixture's sole owning task is 'pending' instead of 'complete'", async () => {
  // Identical fixture to CT15 except the sole owning task's persisted status
  // is 'pending' — the check is no longer covered by task-completion
  // inference, and it has exactly one owner (this task) so the multi-owner
  // exclusion in findUnassignedSpecHardChecks cannot suppress the orphan.
  const orphanCommand = 'node test/test-x.js';
  const env = createDrainEnv({
    specCommands: [{ description: 'check on test/test-x.js', command: orphanCommand }],
    missionAssignments: {
      '001-001': [{ status: 'pending', targetFiles: ['test/test-x.js'] }],
    },
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    let thrown = null;
    try {
      await pipeline._assertSpecHardCheckCoverage();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'expected _assertSpecHardCheckCoverage to throw when the sole owning task is only pending, but it did not throw');
    assert.ok(
      thrown instanceof UnassignedSpecCheckError,
      `expected UnassignedSpecCheckError, got ${thrown.name}: ${thrown.message}`,
    );
    const labels = Array.isArray(thrown.uncoveredLabels) ? thrown.uncoveredLabels : [];
    assert.ok(
      labels.includes(orphanCommand) || thrown.message.includes(orphanCommand),
      `expected uncoveredLabels (or message) to name '${orphanCommand}'; uncoveredLabels=${JSON.stringify(labels)}, message=${thrown.message}`,
    );
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test("CT17: a spec check assigned only through an intact verify/task-*.json sidecar of a persisted non-invalidated task makes _assertSpecHardCheckCoverage() return without throwing", async () => {
  // spec.json declares the path-bearing criterion 'node test/test-y.js'. The
  // sole persisted mission-state task is 'pending' (not 'complete') and its
  // targetFiles do NOT overlap the command — so the terminal-task ownership
  // rule (CT15/CT16) contributes nothing here. The only coverage is an intact
  // verify/task-*.json sidecar, keyed to that same persisted, non-invalidated
  // taskId, whose hardChecks include { name, command: 'node test/test-y.js' }.
  const checkCommand = 'node test/test-y.js';
  const taskId = '001-001-001-001';
  const env = createDrainEnv({
    specCommands: [{ description: 'check on test-y', command: checkCommand }],
    missionAssignments: {
      '001-001': [{ status: 'pending', targetFiles: ['src/unrelated.js'] }],
    },
    sidecars: [{ taskId, hardChecks: [{ name: 'y check', command: checkCommand }] }],
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    // Must not throw (sync) nor reject (if implemented async).
    await pipeline._assertSpecHardCheckCoverage();
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test("CT18: a sidecar belonging to an invalidated task with invalidationReason 'replaced' does not suppress the orphan — UnassignedSpecCheckError naming 'node test/test-z.js'", async () => {
  // spec.json declares the path-bearing criterion 'node test/test-z.js'. The
  // sole persisted mission-state task is 'invalidated' with
  // invalidationReason 'replaced', and its targetFiles do NOT overlap the
  // command, so no complete-status task owns the command's token file and the
  // terminal-task rule cannot supply coverage. The only possible coverage is
  // an intact verify/task-*.json sidecar keyed to that same invalidated
  // taskId — a 'replaced' reason means the sidecar must be skipped, so the
  // check remains an orphan.
  const checkCommand = 'node test/test-z.js';
  const taskId = '001-001-001-001';
  const env = createDrainEnv({
    specCommands: [{ description: 'check on test-z', command: checkCommand }],
    missionAssignments: {
      '001-001': [{ status: 'invalidated', invalidationReason: 'replaced', targetFiles: ['src/unrelated.js'] }],
    },
    sidecars: [{ taskId, hardChecks: [{ name: 'z check', command: checkCommand }] }],
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    let thrown = null;
    try {
      await pipeline._assertSpecHardCheckCoverage();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'expected _assertSpecHardCheckCoverage to throw when the only sidecar belongs to a replaced-invalidated task, but it did not throw');
    assert.ok(
      thrown instanceof UnassignedSpecCheckError,
      `expected UnassignedSpecCheckError, got ${thrown.name}: ${thrown.message}`,
    );
    const labels = Array.isArray(thrown.uncoveredLabels) ? thrown.uncoveredLabels : [];
    assert.ok(
      labels.includes(checkCommand) || thrown.message.includes(checkCommand),
      `expected uncoveredLabels (or message) to name '${checkCommand}'; uncoveredLabels=${JSON.stringify(labels)}, message=${thrown.message}`,
    );
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test("CT19: a sidecar belonging to an invalidated task with invalidationReason 'redundant' counts as coverage — no throw", async () => {
  // Identical fixture to CT18 except invalidationReason 'redundant' — the
  // sidecar still counts as coverage, so the drain must not throw.
  const checkCommand = 'node test/test-z.js';
  const taskId = '001-001-001-001';
  const env = createDrainEnv({
    specCommands: [{ description: 'check on test-z', command: checkCommand }],
    missionAssignments: {
      '001-001': [{ status: 'invalidated', invalidationReason: 'redundant', targetFiles: ['src/unrelated.js'] }],
    },
    sidecars: [{ taskId, hardChecks: [{ name: 'z check', command: checkCommand }] }],
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    // Must not throw (sync) nor reject (if implemented async).
    await pipeline._assertSpecHardCheckCoverage();
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test("CT20: a sidecar belonging to an invalidated task with no invalidationReason field logs 'missing invalidationReason' and throws UnassignedSpecCheckError naming 'node test/test-z.js'", async () => {
  // Identical fixture to CT18 except the invalidated task carries no
  // invalidationReason field (legacy) — the drain must apply the
  // conservative-skip fallback, logging a warning that mentions 'missing
  // invalidationReason', and still throw UnassignedSpecCheckError since the
  // sidecar is skipped and no other coverage exists.
  const checkCommand = 'node test/test-z.js';
  const taskId = '001-001-001-001';
  const env = createDrainEnv({
    specCommands: [{ description: 'check on test-z', command: checkCommand }],
    missionAssignments: {
      '001-001': [{ status: 'invalidated', targetFiles: ['src/unrelated.js'] }],
    },
    sidecars: [{ taskId, hardChecks: [{ name: 'z check', command: checkCommand }] }],
  });
  const { pipeline, logs } = makeDrainPipeline(env.root);
  try {
    let thrown = null;
    try {
      await pipeline._assertSpecHardCheckCoverage();
    } catch (err) {
      thrown = err;
    }
    assert.ok(
      logs.some((l) => l.includes('missing invalidationReason')),
      `expected a log line mentioning 'missing invalidationReason', got logs:\n${logs.join('\n')}`,
    );
    assert.ok(thrown, 'expected _assertSpecHardCheckCoverage to throw when the only sidecar belongs to a legacy-invalidated task, but it did not throw');
    assert.ok(
      thrown instanceof UnassignedSpecCheckError,
      `expected UnassignedSpecCheckError, got ${thrown.name}: ${thrown.message}`,
    );
    const labels = Array.isArray(thrown.uncoveredLabels) ? thrown.uncoveredLabels : [];
    assert.ok(
      labels.includes(checkCommand) || thrown.message.includes(checkCommand),
      `expected uncoveredLabels (or message) to name '${checkCommand}'; uncoveredLabels=${JSON.stringify(labels)}, message=${thrown.message}`,
    );
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
