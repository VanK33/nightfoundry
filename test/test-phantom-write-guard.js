/**
 * test-phantom-write-guard.js — Self-attestation gap closure (v0.1.32) +
 *                                no-op disambiguation probe (v0.1.36).
 *
 * Background: the executor's progress.json (status, affectedFiles) is the
 * model's structured self-report — there is no JS-side verification that
 * the claimed writes actually landed on disk. A silent failure path exists
 * where _guardToolUse denies an Edit (file not Read first, or targetFiles
 * mismatch); the SDK reports the tool error to the model; the model
 * recovers and emits status:'COMPLETED' with a plausible affectedFiles
 * list. Before/after snapshots are byte-identical.
 *
 * Helper-level (TC-PW-1..7): assertChangesLanded() compares SHA-256 of
 * each declared file against the before/ snapshot.
 *
 * Pipeline-level (TC-PW-PROBE-1..7): Defect #17 v0.1.36 fix, presence-gate
 * recast (spec-phantom-write-presence-gate). When phantom-write fires, route
 * to verifier as a disambiguation probe instead of retrying. PASS → if every
 * declared targetFile already existed before the executor ran (in-before),
 * the task was redundant → mark `invalidated`; if ANY declared targetFile is
 * both-missing (absent from before-snapshot AND disk = never produced) →
 * FAILED → analyzer. FAIL → executor genuinely lied → analyzer once, no
 * retry, no _captureLastFailed.
 *
 * Helper tests:
 * TC-PW-1: file in before/, unchanged on disk → unchanged
 * TC-PW-2: file in before/, modified on disk → changed
 * TC-PW-3: file NOT in before/, created on disk → changed (creation)
 * TC-PW-4: file NOT in before/, NOT on disk (both missing) → unchanged
 * TC-PW-5: empty file list → ok:true, unchanged:[] (vacuous)
 * TC-PW-6: ALL files unchanged → ok:false (phantom-write detected)
 * TC-PW-7: not all declared files changed (one unchanged) → ok:false
 * TC-PW-8: bothMissing classification — in-before-unchanged excluded,
 *          both-missing included
 *
 * Pipeline tests:
 * TC-PW-PROBE-1: phantom-write + verifier PASS + in-before targetFile →
 *                task `invalidated` (redundant), no retry, no analyzer
 * TC-PW-PROBE-1b: phantom-write + verifier PASS + ALL targetFiles in-before
 *                (multi-file) → still `invalidated`, no analyzer
 * TC-PW-PROBE-2: phantom-write + verifier FAIL → analyzer dispatched
 *                once, no retry, no _captureLastFailed call
 * TC-PW-PROBE-3: verifier throws InfrastructureError → propagates
 * TC-PW-PROBE-4: state-transition path on redundant (in-before) probe-PASS:
 *                in_progress → awaiting_verification → invalidated
 *                (no `failed` intermediate)
 * TC-PW-PROBE-5: empty affectedFiles → vacuous PW skip preserves
 *                existing behavior (verifier dispatched normally,
 *                verified path used, NOT probe path)
 * TC-PW-PROBE-6: non-PW verifier-FAIL still retries (regression
 *                guard — gate must not affect non-probe path)
 * TC-PW-PROBE-7: verifier throws non-Infra Error → propagates
 * TC-PW-PROBE-8: phantom-write + verifier PASS + both-missing targetFile →
 *                task `failed`, analyzer dispatched
 * TC-PW-PROBE-9: phantom-write + verifier PASS + multi-file mix (one
 *                in-before + one both-missing) → `failed` (any-missing)
 * TC-PW-PROBE-10: executor-reported-but-undeclared both-missing file does
 *                NOT trigger FAILED (gate scoped to targetFiles only)
 *
 * Run: node test/test-phantom-write-guard.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { snapshotFiles, assertChangesLanded } from '../src/orchestrator/core/snapshots.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { InfrastructureError } from '../src/orchestrator/infra/session-manager.js';
import { writeMissionState } from '../src/orchestrator/core/state.js';

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

function createEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-write-test-'));
  const projectRoot = path.join(root, 'project');
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'snapshots'), { recursive: true });
  return { root, projectRoot, harnessDir };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

await test('TC-PW-1: file in before/ unchanged on disk → unchanged', async () => {
  const { root, projectRoot, harnessDir } = createEnv();
  try {
    writeFile(projectRoot, 'a.js', 'original');
    snapshotFiles(harnessDir, projectRoot, 't1', 'before', ['a.js']);
    const result = assertChangesLanded(harnessDir, projectRoot, 't1', ['a.js']);
    assert.strictEqual(result.ok, false, 'no change → ok:false');
    assert.deepStrictEqual(result.unchanged, ['a.js']);
  } finally { cleanup(root); }
});

await test('TC-PW-2: file in before/ modified on disk → changed', async () => {
  const { root, projectRoot, harnessDir } = createEnv();
  try {
    writeFile(projectRoot, 'a.js', 'original');
    snapshotFiles(harnessDir, projectRoot, 't2', 'before', ['a.js']);
    writeFile(projectRoot, 'a.js', 'modified');
    const result = assertChangesLanded(harnessDir, projectRoot, 't2', ['a.js']);
    assert.strictEqual(result.ok, true, 'change present → ok:true');
    assert.deepStrictEqual(result.unchanged, []);
  } finally { cleanup(root); }
});

await test('TC-PW-3: file NOT in before/, created on disk → changed (creation)', async () => {
  const { root, projectRoot, harnessDir } = createEnv();
  try {
    snapshotFiles(harnessDir, projectRoot, 't3', 'before', ['new.js']); // file doesn't exist; snapshot is empty
    writeFile(projectRoot, 'new.js', 'just created');
    const result = assertChangesLanded(harnessDir, projectRoot, 't3', ['new.js']);
    assert.strictEqual(result.ok, true, 'creation counts as change');
    assert.deepStrictEqual(result.unchanged, []);
  } finally { cleanup(root); }
});

await test('TC-PW-4: file NOT in before/, NOT on disk (both missing) → unchanged', async () => {
  const { root, projectRoot, harnessDir } = createEnv();
  try {
    const result = assertChangesLanded(harnessDir, projectRoot, 't4', ['ghost.js']);
    assert.strictEqual(result.ok, false, 'both missing counts as unchanged (phantom claim)');
    assert.deepStrictEqual(result.unchanged, ['ghost.js']);
  } finally { cleanup(root); }
});

await test('TC-PW-5: empty file list → ok:true, unchanged:[] (vacuous)', async () => {
  const { root, projectRoot, harnessDir } = createEnv();
  try {
    const result = assertChangesLanded(harnessDir, projectRoot, 't5', []);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.unchanged, []);
  } finally { cleanup(root); }
});

await test('TC-PW-6: ALL files unchanged → ok:false (phantom-write detected)', async () => {
  const { root, projectRoot, harnessDir } = createEnv();
  try {
    writeFile(projectRoot, 'a.js', 'A');
    writeFile(projectRoot, 'b.js', 'B');
    snapshotFiles(harnessDir, projectRoot, 't6', 'before', ['a.js', 'b.js']);
    // No edits on disk
    const result = assertChangesLanded(harnessDir, projectRoot, 't6', ['a.js', 'b.js']);
    assert.strictEqual(result.ok, false, 'all unchanged → phantom');
    assert.deepStrictEqual(result.unchanged.sort(), ['a.js', 'b.js']);
  } finally { cleanup(root); }
});

await test('TC-PW-7: not all declared files changed (one unchanged) → ok:false', async () => {
  const { root, projectRoot, harnessDir } = createEnv();
  try {
    writeFile(projectRoot, 'a.js', 'A');
    writeFile(projectRoot, 'b.js', 'B');
    snapshotFiles(harnessDir, projectRoot, 't7', 'before', ['a.js', 'b.js']);
    writeFile(projectRoot, 'b.js', 'B-modified');
    const result = assertChangesLanded(harnessDir, projectRoot, 't7', ['a.js', 'b.js']);
    assert.strictEqual(result.ok, false, 'a partial deliverable (one declared file unchanged) must fail the all-changed rule');
    assert.deepStrictEqual(result.unchanged, ['a.js']);
  } finally { cleanup(root); }
});

await test('TC-PW-8: bothMissing classification — in-before-unchanged excluded, both-missing included', async () => {
  const { root, projectRoot, harnessDir } = createEnv();
  try {
    // a.js exists and is snapshotted (in-before, unchanged → NOT both-missing);
    // ghost.js was never created and never snapshotted (both-missing).
    writeFile(projectRoot, 'a.js', 'A');
    snapshotFiles(harnessDir, projectRoot, 't8', 'before', ['a.js', 'ghost.js']);
    const result = assertChangesLanded(harnessDir, projectRoot, 't8', ['a.js', 'ghost.js']);
    // Both are unchanged (a.js byte-identical; ghost.js null===null), so probe fires.
    assert.strictEqual(result.ok, false, 'all unchanged → phantom');
    assert.deepStrictEqual(result.unchanged.sort(), ['a.js', 'ghost.js']);
    // But only the truly-absent file is both-missing.
    assert.deepStrictEqual(result.bothMissing, ['ghost.js'],
      'bothMissing includes only the file absent from before-snapshot AND disk');
  } finally { cleanup(root); }
});

// ── Pipeline integration tests for Defect #17 fix ───────────────────────────

/**
 * Build a minimal harness directory with one task ready for
 * _executeAndVerifyTask. Creates state.json, the mission state file,
 * and writes a verify.json sidecar so verifier.verifyTask doesn't
 * complain about missing input.
 */
function createPipelineEnv(taskId = '001-001-001-001') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-pipeline-test-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(harnessDir, 'logs', 'token-usage.json'),
    JSON.stringify({ sessions: [], totals: {} }));

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
        description: 'test task that the executor will pretend to complete',
        targetFiles: ['src/foo.js'],
        dependencies: [],
        testCases: [],
      }],
    }],
  });

  // Write verify.json sidecar
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: ['src/foo.js'], hardChecks: [], testCases: [] })
  );

  // Create the targetFile so before-snapshot can capture it
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/foo.js'), 'original content');

  return { root, harnessDir, taskId, missionId, subMissionId, milestoneId };
}

function makePipelineWithFakes(projectRoot, { execResult, verifyResult, verifyThrow }) {
  const logs = [];
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); origWarn(...args); };
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    statusBar: false,
  });
  let analyzerDispatched = 0;
  let captureLastFailedCalled = 0;
  pipeline.executor = {
    executeTask: async (task) => {
      // Write progress sidecar mimicking executor
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'progress', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, status: execResult.status, affectedFiles: execResult.affectedFiles || [] })
      );
      return execResult;
    },
  };
  pipeline.verifier = {
    verifyTask: async (task) => {
      if (verifyThrow) throw verifyThrow;
      // Write verification sidecar
      fs.writeFileSync(
        path.join(pipeline.harnessDir, 'verification', `task-${task.id}.json`),
        JSON.stringify({ taskId: task.id, ...verifyResult })
      );
      return verifyResult;
    },
  };
  pipeline.analyzer = {
    analyzeFailure: async () => {
      analyzerDispatched++;
      return { eventId: `fake-${analyzerDispatched}`, recommendation: 'human', affectedTasks: [] };
    },
  };
  // Track _captureLastFailed without breaking it (we want to assert it's NOT called on probe-FAIL)
  const origCapture = pipeline._captureLastFailed.bind(pipeline);
  pipeline._captureLastFailed = (task) => { captureLastFailedCalled++; return origCapture(task); };

  const restoreWarn = () => { console.warn = origWarn; };
  return { pipeline, logs, warns, getAnalyzerDispatched: () => analyzerDispatched, getCaptureLastFailedCalled: () => captureLastFailedCalled, restoreWarn };
}

await test('TC-PW-PROBE-1: phantom-write + verifier PASS + in-before targetFile → invalidated (redundant), no analyzer', async () => {
  // Presence gate: a phantom-write task that PASSES the verifier whose
  // declared targetFile already existed before the executor ran (in-before,
  // not both-missing) is genuinely redundant — the goal was already
  // satisfied. It must end `invalidated` (REDUNDANT), NOT `failed`, and the
  // analyzer must NOT be dispatched. (createPipelineEnv creates src/foo.js,
  // so the before-snapshot captures it → in-before.)
  const env = createPipelineEnv();  // src/foo.js exists → in-before
  const { pipeline, getAnalyzerDispatched, restoreWarn } = makePipelineWithFakes(env.root, {
    execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },  // executor lies — won't actually edit foo.js
    verifyResult: { verified: true, report: 'goal state holds' },
  });
  try {
    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: env.taskId, description: 'test', targetFiles: ['src/foo.js'], dependencies: [],
    });
    // Re-read mission state to check final task status
    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[env.taskId];
    assert.strictEqual(task.status, 'invalidated', `expected invalidated (in-before target → redundant), got ${task.status}`);
    assert.strictEqual(getAnalyzerDispatched(), 0, 'analyzer should NOT be dispatched when the declared file already existed (redundant)');
  } finally {
    restoreWarn();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-PW-PROBE-1b: phantom-write + verifier PASS + ALL targetFiles in-before (multi-file) → invalidated, no analyzer', async () => {
  // Presence gate, multi-file variant: when EVERY declared targetFile
  // already existed before the executor ran (none both-missing), the
  // phantom-write probe-PASS is redundant — it stays `invalidated` and the
  // analyzer is NOT dispatched. (Sole-authorship is no longer the
  // discriminator; only before-snapshot presence matters.)
  const env = createPipelineEnv();
  // Create a second in-before file and declare both as targetFiles.
  fs.writeFileSync(path.join(env.root, 'src/bar.js'), 'original bar');
  writeMissionState(env.harnessDir, env.missionId, 'test mission', {
    subMissions: [{
      id: env.subMissionId,
      description: 'test sm',
      tasks: [
        { id: env.taskId, description: 'phantom-write task', targetFiles: ['src/foo.js', 'src/bar.js'], dependencies: [], testCases: [] },
      ],
    }],
  });
  fs.writeFileSync(
    path.join(env.harnessDir, 'verify', `task-${env.taskId}.json`),
    JSON.stringify({ taskId: env.taskId, targetFiles: ['src/foo.js', 'src/bar.js'], hardChecks: [], testCases: [] })
  );

  const { pipeline, getAnalyzerDispatched, restoreWarn } = makePipelineWithFakes(env.root, {
    execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js', 'src/bar.js'] },  // executor lies — edits nothing
    verifyResult: { verified: true, report: 'goal state holds' },
  });
  try {
    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: env.taskId, description: 'phantom-write task', targetFiles: ['src/foo.js', 'src/bar.js'], dependencies: [],
    });
    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[env.taskId];
    assert.strictEqual(task.status, 'invalidated', `expected invalidated (all targets in-before → redundant), got ${task.status}`);
    assert.strictEqual(getAnalyzerDispatched(), 0, 'analyzer should NOT be dispatched when all declared files already existed');
  } finally {
    restoreWarn();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-PW-PROBE-2: phantom-write + verifier FAIL → analyzer once, no retry, no _captureLastFailed', async () => {
  const env = createPipelineEnv();
  const { pipeline, logs, getAnalyzerDispatched, getCaptureLastFailedCalled, restoreWarn } = makePipelineWithFakes(env.root, {
    execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
    verifyResult: { verified: false, report: 'goal state not met' },
  });
  try {
    // Analyzer recommends 'human' (fake default) → _dispatchAnalyzer throws
    // a Circuit-breaker error. Expected: we should still see analyzer
    // dispatched exactly once and _captureLastFailed never called.
    let threw = null;
    try {
      await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
        id: env.taskId, description: 'test', targetFiles: ['src/foo.js'], dependencies: [],
      });
    } catch (e) { threw = e; }

    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[env.taskId];
    assert.strictEqual(task.status, 'failed', `expected failed (transitionTask before analyzer dispatch), got ${task.status}`);
    assert.strictEqual(getAnalyzerDispatched(), 1, 'analyzer should dispatch exactly once (no retries on probe-FAIL)');
    assert.strictEqual(getCaptureLastFailedCalled(), 0, '_captureLastFailed should NOT be called on probe-FAIL (last-failed/ ≡ before/ for no-op)');
    assert.ok(logs.some(l => /CIRCUIT BREAKER.*phantom-write \+ verifier-FAIL/.test(l)),
      `expected probe-FAIL circuit-breaker log, got: ${logs.slice(-5).join('\n')}`);
    assert.ok(threw && /Circuit breaker.*human/i.test(threw.message),
      `expected analyzer's human-recommendation throw, got: ${threw?.message}`);
  } finally {
    restoreWarn();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-PW-PROBE-3: verifier throws InfrastructureError → propagates', async () => {
  const env = createPipelineEnv();
  const infraErr = new InfrastructureError('test infra', 'unknown');
  const { pipeline, restoreWarn } = makePipelineWithFakes(env.root, {
    execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
    verifyThrow: infraErr,
  });
  try {
    let threw = null;
    try {
      await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
        id: env.taskId, description: 'test', targetFiles: ['src/foo.js'], dependencies: [],
      });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw instanceof InfrastructureError, `expected InfrastructureError, got: ${threw?.constructor?.name}`);
  } finally {
    restoreWarn();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-PW-PROBE-4: state-transition on redundant probe-PASS skips `failed` intermediate', async () => {
  // Track that the redundant (in-before) probe-PASS follows the path:
  //   in_progress → awaiting_verification → invalidated
  // (NOT in_progress → failed → ... which would hit a state-machine
  // transition error per state-machine.js:96 — failed cannot go to
  // awaiting_verification).
  // Presence gate: the invalidated path requires only that the declared
  // targetFile already existed before the executor ran (in-before). The
  // default createPipelineEnv creates src/foo.js, so the single task is
  // redundant — no sibling scaffold needed.
  const env = createPipelineEnv();  // src/foo.js exists → in-before
  const { pipeline, restoreWarn } = makePipelineWithFakes(env.root, {
    execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
    verifyResult: { verified: true, report: 'goal state holds' },
  });
  try {
    // No exception means all transitions were legal per state-machine.
    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: env.taskId, description: 'test', targetFiles: ['src/foo.js'], dependencies: [],
    });
    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[env.taskId];
    assert.strictEqual(task.status, 'invalidated');
  } finally {
    restoreWarn();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-PW-PROBE-5: empty affectedFiles + no targetFiles → vacuous PW skip (verifier path, not probe path)', async () => {
  // Set up env where targetFiles is empty AND executor declares
  // affectedFiles: []. assertChangesLanded returns ok:true vacuously
  // (per existing TC-PW-5 behavior). Pipeline should run the normal
  // verified path, NOT the probe path.
  const env = createPipelineEnv();
  // Overwrite mission state to use empty targetFiles
  writeMissionState(env.harnessDir, env.missionId, 'test mission', {
    subMissions: [{
      id: env.subMissionId,
      description: 'test sm',
      tasks: [{ id: env.taskId, description: 'no-target task', targetFiles: [], dependencies: [], testCases: [] }],
    }],
  });
  fs.writeFileSync(
    path.join(env.harnessDir, 'verify', `task-${env.taskId}.json`),
    JSON.stringify({ taskId: env.taskId, targetFiles: [], hardChecks: [], testCases: [] })
  );

  const { pipeline, restoreWarn } = makePipelineWithFakes(env.root, {
    execResult: { status: 'COMPLETED', affectedFiles: [] },
    verifyResult: { verified: true, report: 'ok' },
  });
  try {
    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: env.taskId, description: 'no-target task', targetFiles: [], dependencies: [],
    });
    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[env.taskId];
    // Expected: NORMAL verified path, ending at `complete` — NOT `invalidated`
    assert.strictEqual(task.status, 'complete', `expected complete (normal path), got ${task.status} — probe path may have wrongly fired on vacuous case`);
  } finally {
    restoreWarn();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-PW-PROBE-6: non-PW verifier-FAIL still retries (regression guard)', async () => {
  // When executor genuinely edits files (not a phantom-write), verifier
  // FAIL should still trigger the classical retry path. The probe-FAIL
  // gate must NOT short-circuit retries on non-probe-path failures.
  const env = createPipelineEnv();
  // Make executor actually edit the file so phantom-write doesn't fire
  const { pipeline, getAnalyzerDispatched, getCaptureLastFailedCalled, restoreWarn } = makePipelineWithFakes(env.root, {
    execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
    verifyResult: { verified: false, report: 'real verification failure' },
  });
  // Override executor to actually edit the file
  const origExec = pipeline.executor.executeTask;
  pipeline.executor.executeTask = async (task) => {
    fs.writeFileSync(path.join(env.root, 'src/foo.js'), 'edited content ' + Math.random());
    return origExec(task);
  };
  try {
    let threw = null;
    try {
      await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
        id: env.taskId, description: 'test', targetFiles: ['src/foo.js'], dependencies: [],
      });
    } catch (e) {
      threw = e;
    }
    // Without phantom-write, classical retry path runs all maxRetries
    // before circuit-breaker. _captureLastFailed must have been called
    // when circuit-breaker fired (proves we went through classic path,
    // not probe-FAIL path which skips it).
    assert.strictEqual(getCaptureLastFailedCalled(), 1,
      '_captureLastFailed should be called once when classical circuit-breaker fires');
    assert.ok(getAnalyzerDispatched() >= 1, 'analyzer dispatched at least once');
  } finally {
    restoreWarn();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-PW-PROBE-7: verifier throws non-Infra Error → propagates', async () => {
  const env = createPipelineEnv();
  const genericErr = new Error('test generic failure');
  const { pipeline, restoreWarn } = makePipelineWithFakes(env.root, {
    execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js'] },
    verifyThrow: genericErr,
  });
  try {
    let threw = null;
    try {
      await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
        id: env.taskId, description: 'test', targetFiles: ['src/foo.js'], dependencies: [],
      });
    } catch (e) {
      threw = e;
    }
    assert.strictEqual(threw, genericErr, 'expected the same error to propagate');
  } finally {
    restoreWarn();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-PW-PROBE-8: phantom-write + verifier PASS + both-missing targetFile → failed, analyzer dispatched', async () => {
  // Presence gate: a phantom-write probe-PASS whose declared targetFile is
  // both-missing (never snapshotted because it never existed, and still
  // absent on disk) means the file was never produced — a genuine
  // phantom-write FAILURE. It must end `failed` and dispatch the analyzer,
  // NOT be absorbed as redundant.
  const env = createPipelineEnv();
  // Redeclare the single task to target a file that does NOT exist on disk.
  writeMissionState(env.harnessDir, env.missionId, 'test mission', {
    subMissions: [{
      id: env.subMissionId,
      description: 'test sm',
      tasks: [
        { id: env.taskId, description: 'phantom-write task', targetFiles: ['src/ghost.js'], dependencies: [], testCases: [] },
      ],
    }],
  });
  fs.writeFileSync(
    path.join(env.harnessDir, 'verify', `task-${env.taskId}.json`),
    JSON.stringify({ taskId: env.taskId, targetFiles: ['src/ghost.js'], hardChecks: [], testCases: [] })
  );

  const { pipeline, getAnalyzerDispatched, restoreWarn } = makePipelineWithFakes(env.root, {
    execResult: { status: 'COMPLETED', affectedFiles: ['src/ghost.js'] },  // executor lies — ghost.js never produced
    verifyResult: { verified: true, report: 'goal state holds' },
  });
  try {
    // Analyzer recommends 'human' (fake default) → _dispatchAnalyzer may
    // throw a circuit-breaker error after dispatching. We only care that the
    // task ends `failed` and the analyzer was dispatched at least once.
    try {
      await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
        id: env.taskId, description: 'phantom-write task', targetFiles: ['src/ghost.js'], dependencies: [],
      });
    } catch { /* analyzer human-recommendation throw is acceptable */ }
    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[env.taskId];
    assert.strictEqual(task.status, 'failed', `expected failed (both-missing target → never produced), got ${task.status}`);
    assert.ok(getAnalyzerDispatched() >= 1, `analyzer should be dispatched for a both-missing phantom-write, got ${getAnalyzerDispatched()}`);
  } finally {
    restoreWarn();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-PW-PROBE-9: phantom-write + verifier PASS + multi-file mix (one in-before + one both-missing) → failed (any-missing)', async () => {
  // Any-missing semantics: a multi-file task where ONE declared targetFile
  // already existed (in-before, src/foo.js) and ANOTHER is both-missing
  // (src/ghost.js) must FAIL — a single never-produced declared file is
  // enough to reject the redundancy absorption.
  const env = createPipelineEnv();  // src/foo.js exists → in-before
  writeMissionState(env.harnessDir, env.missionId, 'test mission', {
    subMissions: [{
      id: env.subMissionId,
      description: 'test sm',
      tasks: [
        { id: env.taskId, description: 'phantom-write task', targetFiles: ['src/foo.js', 'src/ghost.js'], dependencies: [], testCases: [] },
      ],
    }],
  });
  fs.writeFileSync(
    path.join(env.harnessDir, 'verify', `task-${env.taskId}.json`),
    JSON.stringify({ taskId: env.taskId, targetFiles: ['src/foo.js', 'src/ghost.js'], hardChecks: [], testCases: [] })
  );

  const { pipeline, getAnalyzerDispatched, restoreWarn } = makePipelineWithFakes(env.root, {
    execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js', 'src/ghost.js'] },  // edits nothing
    verifyResult: { verified: true, report: 'goal state holds' },
  });
  try {
    try {
      await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
        id: env.taskId, description: 'phantom-write task', targetFiles: ['src/foo.js', 'src/ghost.js'], dependencies: [],
      });
    } catch { /* analyzer human-recommendation throw is acceptable */ }
    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[env.taskId];
    assert.strictEqual(task.status, 'failed', `expected failed (any-missing: one both-missing target rejects redundancy), got ${task.status}`);
    assert.ok(getAnalyzerDispatched() >= 1, `analyzer should be dispatched on any-missing, got ${getAnalyzerDispatched()}`);
  } finally {
    restoreWarn();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC-PW-PROBE-10: executor-reported-but-undeclared both-missing file does NOT trigger FAILED (targetFiles-scoped)', async () => {
  // Contract-not-self-report: the gate keys on task.targetFiles ONLY. An
  // executor self-reports a both-missing affectedFile (src/ghost.js) that is
  // NOT in the declared targetFiles (which is only the in-before src/foo.js).
  // The undeclared both-missing file must NOT pull the task into FAILED —
  // the declared file is in-before, so the task is redundant → invalidated.
  const env = createPipelineEnv();  // src/foo.js exists → in-before; declared target stays src/foo.js
  const { pipeline, getAnalyzerDispatched, restoreWarn } = makePipelineWithFakes(env.root, {
    // Executor self-reports an undeclared, never-produced file alongside foo.js.
    execResult: { status: 'COMPLETED', affectedFiles: ['src/foo.js', 'src/ghost.js'] },
    verifyResult: { verified: true, report: 'goal state holds' },
  });
  try {
    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: env.taskId, description: 'test', targetFiles: ['src/foo.js'], dependencies: [],
    });
    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[env.taskId];
    assert.strictEqual(task.status, 'invalidated',
      `expected invalidated (undeclared both-missing affectedFile must NOT trigger FAILED — gate is targetFiles-scoped), got ${task.status}`);
    assert.strictEqual(getAnalyzerDispatched(), 0, 'analyzer should NOT be dispatched — the declared target is in-before (redundant)');
  } finally {
    restoreWarn();
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
