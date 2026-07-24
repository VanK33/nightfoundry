/**
 * test-sidecar-reuse.js — Tests for SidecarReuseError guard in extractProgress / extractVerdict.
 *
 * Run: node test/test-sidecar-reuse.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

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

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-reuse-')); }
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

// Minimal valid executor fixture
const fixtureCompleted = {
  structured_output: {
    status: 'COMPLETED',
    summary: 'All done',
    affectedFiles: [],
    testsSummary: '',
  },
};

// Minimal valid verifier fixture
const fixtureVerdict = {
  structured_output: {
    result: 'PASSED',
    hardChecks: [],
    taskScopeChecks: [],
    back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
    notes: 'All good',
  },
};

// TC-SR-1: extractProgress with firstWrite:true and NO pre-existing sidecar writes normally
await test('TC-SR-1: extractProgress firstWrite:true no sidecar succeeds', async () => {
  const { extractProgress } = await import('../src/orchestrator/agents/executor.js');
  const dir = tempDir();
  try {
    const out = extractProgress(fixtureCompleted, 'task-001', dir, { firstWrite: true });
    assert.equal(out.status, 'COMPLETED');
    const sidecar = path.join(dir, 'progress', 'task-task-001.json');
    assert.ok(fs.existsSync(sidecar), 'sidecar should be written');
  } finally { cleanup(dir); }
});

// TC-SR-2: extractProgress with firstWrite:true and pre-existing sidecar throws SidecarReuseError
await test('TC-SR-2: extractProgress firstWrite:true existing sidecar throws SidecarReuseError', async () => {
  const { extractProgress } = await import('../src/orchestrator/agents/executor.js');
  const { SidecarReuseError } = await import('../src/orchestrator/core/sidecar-reuse-error.js');
  const dir = tempDir();
  try {
    // Pre-create the sidecar
    const sidecarDir = path.join(dir, 'progress');
    fs.mkdirSync(sidecarDir, { recursive: true });
    const sidecarPath = path.join(sidecarDir, 'task-task-002.json');
    fs.writeFileSync(sidecarPath, JSON.stringify({ status: 'COMPLETED' }));

    let threw = false;
    try {
      extractProgress(fixtureCompleted, 'task-002', dir, { firstWrite: true });
    } catch (err) {
      threw = true;
      assert.ok(err instanceof SidecarReuseError, `Expected SidecarReuseError, got ${err.constructor.name}`);
      assert.equal(err.taskId, 'task-002');
      assert.equal(err.sidecarPath, sidecarPath);
    }
    assert.ok(threw, 'Should have thrown SidecarReuseError');
  } finally { cleanup(dir); }
});

// TC-SR-3: extractProgress with firstWrite:false and pre-existing sidecar overwrites silently
await test('TC-SR-3: extractProgress firstWrite:false existing sidecar overwrites (regression)', async () => {
  const { extractProgress } = await import('../src/orchestrator/agents/executor.js');
  const dir = tempDir();
  try {
    // Pre-create the sidecar with old content
    const sidecarDir = path.join(dir, 'progress');
    fs.mkdirSync(sidecarDir, { recursive: true });
    const sidecarPath = path.join(sidecarDir, 'task-task-003.json');
    fs.writeFileSync(sidecarPath, JSON.stringify({ status: 'OLD_CONTENT' }));

    // Should NOT throw — firstWrite defaults to false
    const out = extractProgress(fixtureCompleted, 'task-003', dir, { firstWrite: false });
    assert.equal(out.status, 'COMPLETED');

    // Sidecar should be overwritten
    const written = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.equal(written.status, 'COMPLETED');
  } finally { cleanup(dir); }
});

// TC-SR-4: extractVerdict with firstWrite:true and pre-existing sidecar throws SidecarReuseError
await test('TC-SR-4: extractVerdict firstWrite:true existing sidecar throws SidecarReuseError', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const { SidecarReuseError } = await import('../src/orchestrator/core/sidecar-reuse-error.js');
  const dir = tempDir();
  try {
    // Pre-create the sidecar
    const sidecarDir = path.join(dir, 'verification');
    fs.mkdirSync(sidecarDir, { recursive: true });
    const sidecarPath = path.join(sidecarDir, 'task-task-004.json');
    fs.writeFileSync(sidecarPath, JSON.stringify({ result: 'PASSED' }));

    let threw = false;
    try {
      extractVerdict(fixtureVerdict, 'task-004', dir, { firstWrite: true });
    } catch (err) {
      threw = true;
      assert.ok(err instanceof SidecarReuseError, `Expected SidecarReuseError, got ${err.constructor.name}`);
      assert.equal(err.taskId, 'task-004');
      assert.equal(err.sidecarPath, sidecarPath);
    }
    assert.ok(threw, 'Should have thrown SidecarReuseError');
  } finally { cleanup(dir); }
});

// TC-SR-5: extractVerdict with firstWrite:false and pre-existing sidecar overwrites silently
await test('TC-SR-5: extractVerdict firstWrite:false existing sidecar overwrites (regression)', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const dir = tempDir();
  try {
    // Pre-create the sidecar with old content
    const sidecarDir = path.join(dir, 'verification');
    fs.mkdirSync(sidecarDir, { recursive: true });
    const sidecarPath = path.join(sidecarDir, 'task-task-005.json');
    fs.writeFileSync(sidecarPath, JSON.stringify({ result: 'OLD_CONTENT' }));

    // Should NOT throw — firstWrite defaults to false
    const out = extractVerdict(fixtureVerdict, 'task-005', dir, { firstWrite: false });
    assert.equal(out.verified, true);

    // Sidecar should be overwritten
    const written = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.equal(written.result, 'PASSED');
  } finally { cleanup(dir); }
});

// TC-SR-6: SidecarReuseError constructor sets .name, .taskId, .sidecarPath correctly
await test('TC-SR-6: SidecarReuseError constructor properties', async () => {
  const { SidecarReuseError } = await import('../src/orchestrator/core/sidecar-reuse-error.js');
  const err = new SidecarReuseError('my-task-id', '/some/path/to/sidecar.json');
  assert.equal(err.name, 'SidecarReuseError');
  assert.equal(err.taskId, 'my-task-id');
  assert.equal(err.sidecarPath, '/some/path/to/sidecar.json');
  assert.ok(err instanceof Error, 'SidecarReuseError should be an instance of Error');
  assert.ok(typeof err.message === 'string' && err.message.length > 0, 'message should be non-empty');
});

// ── Pipeline integration helpers (compact; mirror test-firstwrite-skip-executor.js) ─

function createPipelineHarness({ taskStatus = 'pending', taskId = '001-001-001-001' } = {}) {
  const milestoneId = '001';
  const missionId = '001-001';
  const subMissionId = '001-001-001';
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-reuse-pipe-'));
  const harnessDir = path.join(projectRoot, '.harness');
  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  const targetFile = 'a.js';
  fs.writeFileSync(path.join(projectRoot, targetFile), '// a.js\n');
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: [targetFile], hardChecks: [], testCases: [] })
  );
  const missionState = {
    id: missionId, missionId, description: 'test mission', status: 'in_progress',
    subMissions: { [subMissionId]: {
      id: subMissionId, description: 'test sub-mission', status: 'in_progress',
      tasks: { [taskId]: {
        id: taskId, description: 'test task', status: taskStatus,
        createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
        targetFiles: [targetFile], dependencies: [], testCases: [],
        tracesScenario: [], patternReferences: [], dataSchemas: [],
        verifyFile: `.harness/verify/task-${taskId}.json`,
        progressFile: `.harness/progress/task-${taskId}.json`,
        verificationFile: `.harness/verification/task-${taskId}.json`,
        retryCount: 0,
      }},
    }},
  };
  fs.writeFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), JSON.stringify(missionState, null, 2));
  const state = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: { [milestoneId]: {
      id: milestoneId, description: `milestone ${milestoneId}`, status: 'in_progress',
      planFile: `.harness/plan/milestone-${milestoneId}.md`,
      missions: { [missionId]: { id: missionId, description: 'test mission', status: 'in_progress', stateFile: `.harness/state/mission-${missionId}.json` }},
    }},
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));
  return { projectRoot, harnessDir, taskId, missionId, subMissionId, targetFile };
}

async function makePipelineNoAuth(projectRoot) {
  const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');
  return new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    onLog: () => {},
    onConfirm: async () => true,
    noReview: true,
    skipReview: true,
  });
}

// TC-SR-7: F02 — needs_revalidation parallel path with pre-existing verifier sidecar does NOT throw SidecarReuseError
await test('TC-SR-7: F02 needs_revalidation parallel path, pre-existing sidecar, no SidecarReuseError', async () => {
  const { projectRoot, harnessDir, taskId, missionId, subMissionId } =
    createPipelineHarness({ taskStatus: 'needs_revalidation' });
  try {
    // Pre-seed verification sidecar (simulates prior verifier run)
    fs.writeFileSync(
      path.join(harnessDir, 'verification', `task-${taskId}.json`),
      JSON.stringify({ taskId, result: 'PASSED', notes: 'pre-existing', isStub: false })
    );

    const pipeline = await makePipelineNoAuth(projectRoot);

    // Mock verifier: PASS and count invocations; capture firstWrite from opts
    let verifyCalls = 0;
    let firstWriteSeen = null;
    pipeline.verifier = {
      verifyTask: async (_task, _projRoot, opts) => {
        verifyCalls++;
        firstWriteSeen = opts?.firstWrite;
        return { verified: true, structured: { result: 'PASSED', hardChecks: [], taskScopeChecks: [] }, report: '', reportPath: path.join(harnessDir, 'verification', `task-${taskId}.json`) };
      },
    };
    // Mock executor: throw if called (F02 contract: re-verify only, executor NOT re-run)
    pipeline.executor = {
      executeTask: async () => { throw new Error('executor must NOT be called for needs_revalidation tasks'); },
    };

    const taskObj = {
      id: taskId, description: 'test task', status: 'needs_revalidation',
      targetFiles: ['a.js'], dependencies: [], testCases: [], hardChecks: [],
    };

    let threw = null;
    try {
      await pipeline._executeAndVerifyTask(missionId, subMissionId, taskObj, 0);
    } catch (err) {
      threw = err;
    }

    assert.ok(
      !threw || !/SidecarReuse/.test(threw.message),
      `F02 path must NOT trip SidecarReuseError. Got: ${threw?.message ?? '(none)'}`
    );
    assert.equal(verifyCalls, 1, 'verifier should be dispatched exactly once');
    assert.equal(firstWriteSeen, false, 'F02 fix should pass firstWrite: false to verifier');
  } finally { cleanup(projectRoot); }
});

// TC-SR-8: F04 — resume from awaiting_verification with pre-existing verifier sidecar does NOT throw SidecarReuseError
await test('TC-SR-8: F04 resume awaiting_verification, pre-existing sidecar, no SidecarReuseError, sidecar overwritten', async () => {
  const { projectRoot, harnessDir, taskId, missionId, subMissionId } =
    createPipelineHarness({ taskStatus: 'awaiting_verification' });
  try {
    // Pre-seed verification sidecar with old content (simulates prior crashed run)
    const sidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);
    fs.writeFileSync(sidecarPath, JSON.stringify({ taskId, result: 'OLD_CRASHED_CONTENT', notes: 'pre-crash stale' }));

    const pipeline = await makePipelineNoAuth(projectRoot);

    let verifyCalls = 0;
    let firstWriteSeen = null;
    pipeline.verifier = {
      verifyTask: async (_task, _projRoot, opts) => {
        verifyCalls++;
        firstWriteSeen = opts?.firstWrite;
        // Simulate verifier overwriting the sidecar
        fs.writeFileSync(sidecarPath, JSON.stringify({ taskId, result: 'PASSED', notes: 'resumed cleanly' }));
        return { verified: true, structured: { result: 'PASSED', hardChecks: [], taskScopeChecks: [] }, report: '', reportPath: sidecarPath };
      },
    };
    // Mock executor: throw if called (F04 contract: skipExecutor=true on resume)
    pipeline.executor = {
      executeTask: async () => { throw new Error('executor must NOT be called on awaiting_verification resume'); },
    };

    const taskObj = {
      id: taskId, description: 'test task', status: 'awaiting_verification',
      targetFiles: ['a.js'], dependencies: [], testCases: [], hardChecks: [],
    };

    let threw = null;
    try {
      await pipeline._executeAndVerifyTask(missionId, subMissionId, taskObj, 0);
    } catch (err) {
      threw = err;
    }

    assert.ok(
      !threw || !/SidecarReuse/.test(threw.message),
      `F04 resume must NOT trip SidecarReuseError. Got: ${threw?.message ?? '(none)'}`
    );
    assert.equal(verifyCalls, 1, 'verifier should be dispatched exactly once on resume');
    assert.equal(firstWriteSeen, false, 'F04 fix should pass firstWrite: false on resume');

    const finalSidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.equal(finalSidecar.result, 'PASSED', 'sidecar should be overwritten with new verdict');
  } finally { cleanup(projectRoot); }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
