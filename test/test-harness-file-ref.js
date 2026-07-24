/**
 * test-harness-file-ref.js — Regression test for the harness-relative file
 * reference resolution helper (resolveHarnessFileRef) and for the migrated
 * writeMissionState/writeGlobalPlan persisted shapes: file pointers must be
 * written harness-relative (no leading `.harness/` prefix).
 *
 * Run: node test/test-harness-file-ref.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  resolveHarnessFileRef,
  writeGlobalPlan,
  writeMissionState,
} from '../src/orchestrator/core/state.js';

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
    failCount++;
  }
}

function createHarnessDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-file-ref-'));
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeBaseState(harnessDir) {
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta: {
        prdPath: '',
        createdAt: new Date().toISOString(),
        currentPhase: 'planning',
      },
      globalStatus: 'active',
      milestones: {},
    }, null, 2)
  );
}

async function run() {

// ─────────────────────────────────────────────────────────────────────
// TC1: resolveHarnessFileRef returns an absolute ref unchanged.
// ─────────────────────────────────────────────────────────────────────

await test('TC1: absolute ref returned unchanged', () => {
  const harnessDir = '/some/harness/dir';
  const absRef = '/abs/path/verify/task-1.json';
  const result = resolveHarnessFileRef(harnessDir, absRef);
  assert.strictEqual(result, absRef);
});

// ─────────────────────────────────────────────────────────────────────
// TC2: a `.harness/`-prefixed legacy ref resolves to
// path.join(harnessDir, strippedRef).
// ─────────────────────────────────────────────────────────────────────

await test("TC2: '.harness/'-prefixed legacy ref resolves to path.join(harnessDir, strippedRef)", () => {
  const harnessDir = '/some/harness/dir';
  const ref = '.harness/verify/task-1.json';
  const expected = path.join(harnessDir, 'verify/task-1.json');
  const result = resolveHarnessFileRef(harnessDir, ref);
  assert.strictEqual(result, expected);
});

// ─────────────────────────────────────────────────────────────────────
// TC3: a bare harness-relative ref resolves to path.join(harnessDir, ref).
// ─────────────────────────────────────────────────────────────────────

await test('TC3: bare harness-relative ref resolves to path.join(harnessDir, ref)', () => {
  const harnessDir = '/some/harness/dir';
  const ref = 'verify/task-1.json';
  const expected = path.join(harnessDir, ref);
  const result = resolveHarnessFileRef(harnessDir, ref);
  assert.strictEqual(result, expected);
});

// ─────────────────────────────────────────────────────────────────────
// TC4: after writeMissionState, the persisted task carries
// verifyFile/progressFile/verificationFile in harness-relative shape,
// with no `.harness/` prefix.
// ─────────────────────────────────────────────────────────────────────

await test('TC4: writeMissionState persists harness-relative file pointers with no .harness/ prefix', () => {
  const harnessDir = createHarnessDir();
  try {
    const missionId = '001-001';
    const taskId = '001-001-001-001';
    const decomp = {
      subMissions: [
        {
          id: '001-001-001',
          description: 'sub-mission',
          tasks: [
            {
              id: taskId,
              description: 'a task',
              targetFiles: [],
              dependencies: [],
              testCases: [],
            },
          ],
        },
      ],
    };

    writeMissionState(harnessDir, missionId, 'a mission', decomp);

    const stateFile = path.join(harnessDir, 'state', `mission-${missionId}.json`);
    const missionState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const task = missionState.subMissions['001-001-001'].tasks[taskId];

    assert.strictEqual(task.verifyFile, `verify/task-${taskId}.json`);
    assert.strictEqual(task.progressFile, `progress/task-${taskId}.json`);
    assert.strictEqual(task.verificationFile, `verification/task-${taskId}.json`);

    assert.ok(!task.verifyFile.startsWith('.harness/'), `verifyFile should not carry .harness/ prefix, got ${task.verifyFile}`);
    assert.ok(!task.progressFile.startsWith('.harness/'), `progressFile should not carry .harness/ prefix, got ${task.progressFile}`);
    assert.ok(!task.verificationFile.startsWith('.harness/'), `verificationFile should not carry .harness/ prefix, got ${task.verificationFile}`);
  } finally {
    cleanup(harnessDir);
  }
});

// ─────────────────────────────────────────────────────────────────────
// TC5: after writeGlobalPlan, the persisted mission carries stateFile
// and planFile, and the milestone carries planFile — all harness-relative
// without a `.harness/` prefix.
// ─────────────────────────────────────────────────────────────────────

await test('TC5: writeGlobalPlan persists harness-relative stateFile/planFile with no .harness/ prefix', () => {
  const harnessDir = createHarnessDir();
  try {
    writeBaseState(harnessDir);

    const milestoneId = '001';
    const missionId = '001-001';
    const plan = {
      milestones: [
        {
          id: milestoneId,
          description: 'a milestone',
          missions: [
            { id: missionId, description: 'a mission' },
          ],
        },
      ],
      scopeItems: [],
      scopeMapping: {},
    };

    writeGlobalPlan(harnessDir, plan);

    const state = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const milestone = state.milestones[milestoneId];
    const mission = milestone.missions[missionId];

    assert.strictEqual(mission.stateFile, `state/mission-${missionId}.json`);
    assert.strictEqual(mission.planFile, `plan/mission-${missionId}.md`);
    assert.strictEqual(milestone.planFile, `plan/milestone-${milestoneId}.md`);

    assert.ok(!mission.stateFile.startsWith('.harness/'), `mission.stateFile should not carry .harness/ prefix, got ${mission.stateFile}`);
    assert.ok(!mission.planFile.startsWith('.harness/'), `mission.planFile should not carry .harness/ prefix, got ${mission.planFile}`);
    assert.ok(!milestone.planFile.startsWith('.harness/'), `milestone.planFile should not carry .harness/ prefix, got ${milestone.planFile}`);
  } finally {
    cleanup(harnessDir);
  }
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
