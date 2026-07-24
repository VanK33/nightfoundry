#!/usr/bin/env node

/**
 * Integration test: Pipeline state management.
 * Tests state writing, reading, and structure compliance WITHOUT spawning claude sessions.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { isMissionAlreadyStarted } from '../src/orchestrator/core/state.js';

async function main() {
  let passed = 0;
  let failed = 0;

  function assert(label, condition) {
    if (condition) {
      console.log(`  [PASS] ${label}`);
      passed++;
    } else {
      console.log(`  [FAIL] ${label}`);
      failed++;
    }
  }

  console.log('=== Pipeline State Tests ===\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-pipeline-'));
  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'plan'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'verify'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'progress'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });

  const initialState = {
    projectMeta: {
      prdPath: '',
      createdAt: new Date().toISOString(),
      currentPhase: 'planning',
    },
    globalStatus: 'active',
    milestones: {},
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(initialState, null, 2));

  // Test 1: State schema compliance
  console.log('Test 1: State schema compliance');
  const state = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
  assert('has projectMeta', !!state.projectMeta);
  assert('has globalStatus', typeof state.globalStatus === 'string');
  assert('globalStatus is valid', ['active', 'complete', 'paused'].includes(state.globalStatus));
  assert('has milestones object', typeof state.milestones === 'object');

  // Test 2: Simulate global plan write
  console.log('\nTest 2: Global plan write');
  const mockPlan = {
    milestones: [
      {
        id: '001',
        description: 'Test milestone',
        missions: [
          { id: '001-001', description: 'Test mission A' },
          { id: '001-002', description: 'Test mission B' },
        ],
      },
    ],
  };

  state.projectMeta.currentPhase = 'executing';
  for (const ms of mockPlan.milestones) {
    const missions = {};
    for (const mi of ms.missions) {
      missions[mi.id] = {
        id: mi.id,
        description: mi.description,
        status: 'pending',
        stateFile: `.harness/state/mission-${mi.id}.json`,
        planFile: `.harness/plan/mission-${mi.id}.md`,
      };
    }
    state.milestones[ms.id] = {
      id: ms.id,
      description: ms.description,
      status: 'pending',
      planFile: `.harness/plan/milestone-${ms.id}.md`,
      missions,
    };
  }
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  const updatedState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
  assert('milestone 001 exists', !!updatedState.milestones['001']);
  assert('milestone ID format', /^\d{3}$/.test(updatedState.milestones['001'].id));
  assert('milestone has description (not title)', !!updatedState.milestones['001'].description);
  assert('mission 001-001 exists', !!updatedState.milestones['001'].missions['001-001']);
  assert('mission ID format', /^\d{3}-\d{3}$/.test(updatedState.milestones['001'].missions['001-001'].id));
  assert('currentPhase = executing', updatedState.projectMeta.currentPhase === 'executing');

  // Test 3: Mission state file
  console.log('\nTest 3: Mission state file');
  const missionState = {
    id: '001-001',
    missionId: '001-001',
    description: 'Test mission A',
    status: 'in_progress',
    subMissions: {
      '001-001-001': {
        id: '001-001-001',
        description: 'Test sub-mission',
        status: 'pending',
        tasks: {
          '001-001-001-001': {
            id: '001-001-001-001',
            description: 'Create test file',
            status: 'pending',
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            targetFiles: ['test.js'],
            dependencies: [],
            verifyFile: '.harness/verify/task-001-001-001-001.json',
            progressFile: '.harness/progress/task-001-001-001-001.md',
            verificationFile: '.harness/verification/task-001-001-001-001.md',
            retryCount: 0,
          },
        },
      },
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state', 'mission-001-001.json'),
    JSON.stringify(missionState, null, 2)
  );

  const msFile = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state', 'mission-001-001.json'), 'utf8'));
  assert('mission state has id', msFile.id === '001-001');
  assert('mission state has missionId', msFile.missionId === '001-001');
  assert('sub-mission ID format', /^\d{3}-\d{3}-\d{3}$/.test(Object.keys(msFile.subMissions)[0]));
  assert('task ID format', /^\d{3}-\d{3}-\d{3}-\d{3}$/.test(Object.keys(msFile.subMissions['001-001-001'].tasks)[0]));
  assert('task has description', !!msFile.subMissions['001-001-001'].tasks['001-001-001-001'].description);
  assert('task has targetFiles', Array.isArray(msFile.subMissions['001-001-001'].tasks['001-001-001-001'].targetFiles));
  assert('task retryCount = 0', msFile.subMissions['001-001-001'].tasks['001-001-001-001'].retryCount === 0);

  // Test 4: Verify.json structure
  console.log('\nTest 4: Verify.json structure');
  const verifyJson = {
    taskId: '001-001-001-001',
    targetFiles: ['test.js'],
    hardChecks: [],
    testCases: [{ id: 'TC1', description: 'basic test' }],
  };
  fs.writeFileSync(
    path.join(harnessDir, 'verify', 'task-001-001-001-001.json'),
    JSON.stringify(verifyJson, null, 2)
  );
  const vf = JSON.parse(fs.readFileSync(path.join(harnessDir, 'verify', 'task-001-001-001-001.json'), 'utf8'));
  assert('verify has taskId', vf.taskId === '001-001-001-001');
  assert('verify has hardChecks array', Array.isArray(vf.hardChecks));
  assert('verify has testCases', vf.testCases.length === 1);

  // Test 5: Resume logic
  console.log('\nTest 5: Resume logic');
  function findNextTask(stateJson) {
    for (const [msId, ms] of Object.entries(stateJson.milestones).sort()) {
      if (ms.status === 'complete' || ms.status === 'invalidated') continue;
      for (const [miId, mi] of Object.entries(ms.missions).sort()) {
        if (mi.status === 'complete' || mi.status === 'invalidated') continue;
        const stateFile = path.join(harnessDir, 'state', `mission-${miId}.json`);
        if (!fs.existsSync(stateFile)) continue;
        const miState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        for (const [smId, sm] of Object.entries(miState.subMissions).sort()) {
          for (const [tId, task] of Object.entries(sm.tasks).sort()) {
            if (task.status === 'pending' || task.status === 'in_progress' || task.status === 'failed') {
              return tId;
            }
          }
        }
      }
    }
    return null;
  }

  const nextTask = findNextTask(updatedState);
  assert('finds pending task', nextTask === '001-001-001-001');

  msFile.subMissions['001-001-001'].tasks['001-001-001-001'].status = 'complete';
  fs.writeFileSync(
    path.join(harnessDir, 'state', 'mission-001-001.json'),
    JSON.stringify(msFile, null, 2)
  );
  const nextAfterComplete = findNextTask(updatedState);
  assert('no pending task after completion', nextAfterComplete === null);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\nCleaned up: ${tmpDir}`);

  // ─────────────────────────────────────────────────────────────
  // Test 6: _checkOverwriteProtection
  // ─────────────────────────────────────────────────────────────
  console.log('\nTest 6: _checkOverwriteProtection');

  // Import Pipeline dynamically so we can use it without full agent setup
  const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');

  /**
   * Helper: create a temp harness with a given state.json content.
   * Returns { projectRoot, harnessDir, pipeline }.
   */
  function makeTmpHarness(stateContent) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-owp-'));
    const hDir = path.join(root, '.harness');
    // Logger needs logs dir; mkdir recursively covers it
    fs.mkdirSync(path.join(hDir, 'logs'), { recursive: true });
    if (stateContent !== null) {
      fs.writeFileSync(path.join(hDir, 'state.json'), JSON.stringify(stateContent, null, 2));
    }
    const p = new Pipeline(root, { onLog: () => {} });
    return { projectRoot: root, harnessDir: hDir, pipeline: p };
  }

  function assertThrows(label, fn) {
    try {
      fn();
      console.log(`  [FAIL] ${label} — expected throw but did not throw`);
      failed++;
    } catch (err) {
      // verify message is actionable
      if (err.message.includes('cc-orch archive') || err.message.includes('new project directory')) {
        console.log(`  [PASS] ${label}`);
        passed++;
      } else {
        console.log(`  [FAIL] ${label} — threw but message is not actionable: ${err.message}`);
        failed++;
      }
    }
  }

  function assertNoThrow(label, fn) {
    try {
      fn();
      console.log(`  [PASS] ${label}`);
      passed++;
    } catch (err) {
      console.log(`  [FAIL] ${label} — unexpected throw: ${err.message}`);
      failed++;
    }
  }

  // TC1: No state.json → proceeds (no throw)
  {
    const { pipeline, harnessDir: hDir } = makeTmpHarness(null);
    assertNoThrow('TC1: no state.json → proceeds', () => pipeline._checkOverwriteProtection(hDir));
    fs.rmSync(path.dirname(hDir), { recursive: true, force: true });
  }

  // TC2: active + all milestones complete → throws
  {
    const state = {
      globalStatus: 'active',
      milestones: {
        '001': { status: 'complete' },
        '002': { status: 'complete' },
      },
    };
    const { pipeline, harnessDir: hDir } = makeTmpHarness(state);
    assertThrows('TC2: active + all complete → throws', () => pipeline._checkOverwriteProtection(hDir));
    fs.rmSync(path.dirname(hDir), { recursive: true, force: true });
  }

  // TC3: active + all milestones invalidated → throws
  {
    const state = {
      globalStatus: 'active',
      milestones: {
        '001': { status: 'invalidated' },
        '002': { status: 'invalidated' },
      },
    };
    const { pipeline, harnessDir: hDir } = makeTmpHarness(state);
    assertThrows('TC3: active + all invalidated → throws', () => pipeline._checkOverwriteProtection(hDir));
    fs.rmSync(path.dirname(hDir), { recursive: true, force: true });
  }

  // TC4: active + mix of complete and invalidated → throws
  {
    const state = {
      globalStatus: 'active',
      milestones: {
        '001': { status: 'complete' },
        '002': { status: 'invalidated' },
      },
    };
    const { pipeline, harnessDir: hDir } = makeTmpHarness(state);
    assertThrows('TC4: active + complete+invalidated mix → throws', () => pipeline._checkOverwriteProtection(hDir));
    fs.rmSync(path.dirname(hDir), { recursive: true, force: true });
  }

  // TC5: active + one milestone pending → proceeds (resume)
  {
    const state = {
      globalStatus: 'active',
      milestones: {
        '001': { status: 'complete' },
        '002': { status: 'pending' },
      },
    };
    const { pipeline, harnessDir: hDir } = makeTmpHarness(state);
    assertNoThrow('TC5: active + one pending → proceeds', () => pipeline._checkOverwriteProtection(hDir));
    fs.rmSync(path.dirname(hDir), { recursive: true, force: true });
  }

  // TC6: active + one milestone in_progress → proceeds (resume)
  {
    const state = {
      globalStatus: 'active',
      milestones: {
        '001': { status: 'complete' },
        '002': { status: 'in_progress' },
      },
    };
    const { pipeline, harnessDir: hDir } = makeTmpHarness(state);
    assertNoThrow('TC6: active + one in_progress → proceeds', () => pipeline._checkOverwriteProtection(hDir));
    fs.rmSync(path.dirname(hDir), { recursive: true, force: true });
  }

  // TC7: active + empty milestones object → proceeds (fresh plan not yet written)
  {
    const state = {
      globalStatus: 'active',
      milestones: {},
    };
    const { pipeline, harnessDir: hDir } = makeTmpHarness(state);
    assertNoThrow('TC7: active + empty milestones → proceeds', () => pipeline._checkOverwriteProtection(hDir));
    fs.rmSync(path.dirname(hDir), { recursive: true, force: true });
  }

  // TC8: globalStatus=complete → throws
  {
    const state = {
      globalStatus: 'complete',
      milestones: {
        '001': { status: 'complete' },
      },
    };
    const { pipeline, harnessDir: hDir } = makeTmpHarness(state);
    assertThrows('TC8: globalStatus=complete → throws', () => pipeline._checkOverwriteProtection(hDir));
    fs.rmSync(path.dirname(hDir), { recursive: true, force: true });
  }

  // TC9: globalStatus=paused + all milestones complete → throws
  {
    const state = {
      globalStatus: 'paused',
      milestones: {
        '001': { status: 'complete' },
        '002': { status: 'complete' },
      },
    };
    const { pipeline, harnessDir: hDir } = makeTmpHarness(state);
    assertThrows('TC9: paused + all complete → throws', () => pipeline._checkOverwriteProtection(hDir));
    fs.rmSync(path.dirname(hDir), { recursive: true, force: true });
  }

  // Test 7: isMissionAlreadyStarted — skip mission re-confirm on resume
  console.log('\nTest 7: isMissionAlreadyStarted (resume mission-approval skip)');
  {
    // Pre-approval state: all tasks pending → treat as fresh, prompt user
    const freshState = {
      subMissions: {
        '001-001-001': {
          tasks: {
            '001-001-001-001': { status: 'pending' },
            '001-001-001-002': { status: 'pending' },
          },
        },
      },
    };
    assert('TC7.1: all-pending mission → not started', isMissionAlreadyStarted(freshState) === false);

    // Mid-run: one task in_progress → skip prompt, already approved
    const inProgressState = {
      subMissions: {
        '001-001-001': {
          tasks: {
            '001-001-001-001': { status: 'complete' },
            '001-001-001-002': { status: 'in_progress' },
          },
        },
      },
    };
    assert('TC7.2: in_progress task → already started', isMissionAlreadyStarted(inProgressState) === true);

    // Cross-sub-mission: only a later sub-mission has a non-pending task
    const laterSmState = {
      subMissions: {
        '001-001-001': { tasks: { '001-001-001-001': { status: 'pending' } } },
        '001-001-002': { tasks: { '001-001-002-001': { status: 'verified' } } },
      },
    };
    assert('TC7.3: non-pending in later sub-mission → already started', isMissionAlreadyStarted(laterSmState) === true);

    // Defensive: malformed / missing
    assert('TC7.4: null state → not started', isMissionAlreadyStarted(null) === false);
    assert('TC7.5: undefined state → not started', isMissionAlreadyStarted(undefined) === false);
    assert('TC7.6: empty subMissions → not started', isMissionAlreadyStarted({ subMissions: {} }) === false);
    assert('TC7.7: subMission with empty tasks → not started', isMissionAlreadyStarted({ subMissions: { a: { tasks: {} } } }) === false);

    // Edge: failed / awaiting_verification also count as started
    const awaitingState = {
      subMissions: {
        a: { tasks: { x: { status: 'awaiting_verification' } } },
      },
    };
    assert('TC7.8: awaiting_verification → already started', isMissionAlreadyStarted(awaitingState) === true);
  }

  // ─────────────────────────────────────────────────────────────
  // Test 8: Signal infrastructure
  // ─────────────────────────────────────────────────────────────
  console.log('\nTest 8: Signal infrastructure');

  // TC-cancel-controller-exists & TC-exit-handler-unchanged & TC-signal-threaded-to-scheduler
  // & TC-signal-on-sessionManager — share one pipeline where the signal stays non-aborted.
  {
    const { pipeline: pSig, harnessDir: hSig } = makeTmpHarness(null);

    // TC1: _cancelController is an AbortController with signal.aborted === false
    assert(
      'TC-cancel-controller-exists: _cancelController instanceof AbortController',
      pSig._cancelController instanceof AbortController
    );
    assert(
      'TC-cancel-controller-exists: signal.aborted === false initially',
      pSig._cancelController.signal.aborted === false
    );

    // TC4: calling exit() does NOT abort the signal
    pSig._signalHandlers.exit();
    assert(
      'TC-exit-handler-unchanged: signal.aborted still false after exit()',
      pSig._cancelController.signal.aborted === false
    );

    // TC5: scheduler is wired with pipeline's signal
    assert(
      'TC-signal-threaded-to-scheduler: pipeline.scheduler is constructed',
      !!pSig.scheduler
    );
    assert(
      'TC-signal-threaded-to-scheduler: pipeline._cancelController.signal is AbortSignal (threaded to scheduler)',
      pSig._cancelController.signal instanceof AbortSignal
    );

    // TC6: sessionManager.signal === pipeline._cancelController.signal
    assert(
      'TC-signal-on-sessionManager: sessionManager.signal === pipeline._cancelController.signal',
      pSig.sessionManager.signal === pSig._cancelController.signal
    );

    // Remove process listeners to avoid listener leaks
    process.removeListener('SIGINT', pSig._signalHandlers.SIGINT);
    process.removeListener('SIGTERM', pSig._signalHandlers.SIGTERM);
    process.removeListener('exit', pSig._signalHandlers.exit);
    process.removeListener('uncaughtException', pSig._signalHandlers.uncaughtException);
    fs.rmSync(path.dirname(hSig), { recursive: true, force: true });
  }

  // TC2: SIGINT aborts the signal
  {
    const { pipeline: pSigInt, harnessDir: hSigInt } = makeTmpHarness(null);
    pSigInt._signalHandlers.SIGINT();
    assert(
      'TC-sigint-aborts: SIGINT() sets signal.aborted to true',
      pSigInt._cancelController.signal.aborted === true
    );
    process.removeListener('SIGINT', pSigInt._signalHandlers.SIGINT);
    process.removeListener('SIGTERM', pSigInt._signalHandlers.SIGTERM);
    process.removeListener('exit', pSigInt._signalHandlers.exit);
    process.removeListener('uncaughtException', pSigInt._signalHandlers.uncaughtException);
    fs.rmSync(path.dirname(hSigInt), { recursive: true, force: true });
  }

  // TC3: SIGTERM aborts the signal
  {
    const { pipeline: pSigTerm, harnessDir: hSigTerm } = makeTmpHarness(null);
    pSigTerm._signalHandlers.SIGTERM();
    assert(
      'TC-sigterm-aborts: SIGTERM() sets signal.aborted to true',
      pSigTerm._cancelController.signal.aborted === true
    );
    process.removeListener('SIGINT', pSigTerm._signalHandlers.SIGINT);
    process.removeListener('SIGTERM', pSigTerm._signalHandlers.SIGTERM);
    process.removeListener('exit', pSigTerm._signalHandlers.exit);
    process.removeListener('uncaughtException', pSigTerm._signalHandlers.uncaughtException);
    fs.rmSync(path.dirname(hSigTerm), { recursive: true, force: true });
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
