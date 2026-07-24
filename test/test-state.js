/**
 * test-state.js — Unit tests for state.js predicate helpers.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isUnresumableState, writeJsonAtomic, writeGlobalPlan, writeMissionState, assertNoStubVerifierSidecar } from '../src/orchestrator/core/state.js';

// TC1: returns true when all three conditions are met
{
  const state = {
    globalStatus: 'active',
    projectMeta: { currentPhase: 'planning' },
    milestones: {},
  };
  assert.strictEqual(isUnresumableState(state), true, 'TC1: should return true for active+planning+empty milestones');
}

// TC2: returns false when globalStatus is not 'active'
{
  const state = {
    globalStatus: 'complete',
    projectMeta: { currentPhase: 'planning' },
    milestones: {},
  };
  assert.strictEqual(isUnresumableState(state), false, 'TC2: should return false when globalStatus is complete');
}

// TC3: returns false when currentPhase is not 'planning'
{
  const state = {
    globalStatus: 'active',
    projectMeta: { currentPhase: 'executing' },
    milestones: {},
  };
  assert.strictEqual(isUnresumableState(state), false, 'TC3: should return false when currentPhase is executing');
}

// TC4: returns false when milestones has entries
{
  const state = {
    globalStatus: 'active',
    projectMeta: { currentPhase: 'planning' },
    milestones: { '001': { id: '001', description: 'first milestone' } },
  };
  assert.strictEqual(isUnresumableState(state), false, 'TC4: should return false when milestones is non-empty');
}

// TC5: returns false when milestones key is missing (defensive)
{
  const state = {
    globalStatus: 'active',
    projectMeta: { currentPhase: 'planning' },
  };
  assert.strictEqual(isUnresumableState(state), false, 'TC5: should return false when milestones key is undefined');
}

// TC6: writeJsonAtomic writes valid JSON that round-trips through JSON.parse
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-state-tc6-'));
  const filePath = path.join(tmpDir, 'tc6.json');
  const data = { foo: 'bar' };
  writeJsonAtomic(filePath, data);
  const readBack = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepStrictEqual(readBack, data, 'TC6: round-trip JSON should deep equal original data');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// TC7: writeJsonAtomic does not leave a .tmp.* file on success
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-state-tc7-'));
  const filePath = path.join(tmpDir, 'tc7.json');
  writeJsonAtomic(filePath, { hello: 'world' });
  const dirContents = fs.readdirSync(tmpDir);
  const tmpFiles = dirContents.filter((f) => f.includes('.tmp.'));
  assert.strictEqual(tmpFiles.length, 0, 'TC7: no .tmp.* sibling files should remain after successful write');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// TC8: writeJsonAtomic overwrites an existing file atomically
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-state-tc8-'));
  const filePath = path.join(tmpDir, 'tc8.json');
  writeJsonAtomic(filePath, { initial: true });
  writeJsonAtomic(filePath, { updated: true });
  const readBack = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepStrictEqual(readBack, { updated: true }, 'TC8: file should contain new content after overwrite');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// TC9: writeGlobalPlan produces readable state.json with currentPhase executing
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-state-tc9-'));
  // writeGlobalPlan calls readState(harnessDir) first — seed a minimal state.json
  const initialState = {
    globalStatus: 'active',
    projectMeta: { currentPhase: 'planning' },
    milestones: {},
  };
  fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(initialState, null, 2));
  const plan = {
    milestones: [
      {
        id: '001',
        description: 'Test milestone',
        missions: [
          { id: '001-001', description: 'Test mission' },
        ],
      },
    ],
  };
  writeGlobalPlan(tmpDir, plan);
  const stateBack = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state.json'), 'utf8'));
  assert.strictEqual(stateBack.projectMeta.currentPhase, 'executing', 'TC9: currentPhase should be executing after writeGlobalPlan');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// TC10: writeMissionState produces readable mission-*.json with expected task
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-state-tc10-'));
  const missionId = '001-001';
  const decomp = {
    subMissions: [
      {
        id: '001-001-001',
        description: 'Test sub-mission',
        tasks: [
          {
            id: '001-001-001-001',
            description: 'Test task',
            targetFiles: ['src/foo.js'],
            dependencies: [],
            testCases: [],
          },
        ],
      },
    ],
  };
  writeMissionState(tmpDir, missionId, 'Test mission description', decomp);
  const missionFile = path.join(tmpDir, 'state', `mission-${missionId}.json`);
  const missionState = JSON.parse(fs.readFileSync(missionFile, 'utf8'));
  const task = missionState.subMissions?.['001-001-001']?.tasks?.['001-001-001-001'];
  assert.ok(task, 'TC10: task should exist in the written mission state file');
  assert.strictEqual(task.id, '001-001-001-001', 'TC10: task id should match');
  assert.strictEqual(task.description, 'Test task', 'TC10: task description should match');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// TC-stub-1: assertNoStubVerifierSidecar returns undefined when sidecar file does not exist
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-state-stub1-'));
  fs.mkdirSync(path.join(tmpDir, 'verification'), { recursive: true });
  const result = assertNoStubVerifierSidecar(tmpDir, '001-002-001-002');
  assert.strictEqual(result, undefined, 'TC-stub-1: should return undefined when sidecar file does not exist');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// TC-stub-2: assertNoStubVerifierSidecar returns undefined when sidecar exists with {result:'FAILED'} (no isStub)
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-state-stub2-'));
  fs.mkdirSync(path.join(tmpDir, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'verification', 'task-001-002-001-002.json'), JSON.stringify({ result: 'FAILED' }));
  const result = assertNoStubVerifierSidecar(tmpDir, '001-002-001-002');
  assert.strictEqual(result, undefined, 'TC-stub-2: should return undefined when sidecar has no isStub field');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// TC-stub-3: assertNoStubVerifierSidecar throws Error with message containing task ID when sidecar has {isStub:true, result:'FAILED'}
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-state-stub3-'));
  fs.mkdirSync(path.join(tmpDir, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'verification', 'task-001-002-001-002.json'), JSON.stringify({ isStub: true, result: 'FAILED' }));
  let threw = false;
  try {
    assertNoStubVerifierSidecar(tmpDir, '001-002-001-002');
  } catch (err) {
    threw = true;
    assert.ok(err instanceof Error, 'TC-stub-3: thrown value should be an Error');
    assert.ok(err.message.includes('001-002-001-002'), `TC-stub-3: error message should contain task ID, got: ${err.message}`);
  }
  assert.strictEqual(threw, true, 'TC-stub-3: should have thrown an error for isStub:true sidecar');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('test-state.js: all tests passed');
