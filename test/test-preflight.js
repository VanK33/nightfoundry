/**
 * test-preflight.js — Unit tests for preflight.js.
 *
 * No Claude auth, no SDK. Pure fs + temp directories.
 * Run: node test/test-preflight.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';
import { preflight } from '../src/orchestrator/core/preflight.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

function createProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Create a freshly-bootstrapped .harness/ and return its path.
 * Callers can then mutate state.json before running preflight.
 */
function freshHarness(root) {
  const { harnessDir } = bootstrap(root);
  return harnessDir;
}

function readState(harnessDir) {
  return JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
}

function writeState(harnessDir, state) {
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));
}

function writeMissionState(harnessDir, missionId, state) {
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify(state, null, 2)
  );
}

/**
 * Build a valid milestone+mission entry in state.json that references a
 * mission state file which we also write.
 */
function addValidMission(harnessDir, { missionId = '001-001', withSubMission = true } = {}) {
  const state = readState(harnessDir);
  const msKey = missionId.split('-')[0];
  state.milestones[msKey] = {
    id: msKey,
    description: 'test milestone',
    status: 'pending',
    missions: {
      [missionId]: {
        id: missionId,
        description: 'test mission',
        status: 'pending',
        stateFile: `.harness/state/mission-${missionId}.json`,
      },
    },
  };
  writeState(harnessDir, state);

  const missionState = {
    id: missionId,
    missionId,
    description: 'test mission',
    status: 'pending',
    subMissions: {},
  };

  if (withSubMission) {
    const smId = `${missionId}-001`;
    missionState.subMissions[smId] = {
      id: smId,
      description: 'test sub-mission',
      status: 'pending',
      tasks: {
        [`${smId}-001`]: {
          id: `${smId}-001`,
          description: 'test task',
          status: 'pending',
        },
      },
    };
  }

  writeMissionState(harnessDir, missionId, missionState);
}

// ---------- Happy path ----------

test('preflight: fresh bootstrap passes clean', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    const result = preflight(harnessDir);
    assert.equal(result.ok, true, `expected ok, got errors: ${result.errors.join('; ')}`);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  } finally { cleanup(root); }
});

test('preflight: fully populated valid state passes', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    addValidMission(harnessDir);
    const result = preflight(harnessDir);
    assert.equal(result.ok, true, `expected ok, got errors: ${result.errors.join('; ')}`);
    assert.deepEqual(result.errors, []);
  } finally { cleanup(root); }
});

// ---------- Hard errors: missing structure ----------

test('preflight: missing .harness/ directory returns error', () => {
  const result = preflight('/nonexistent/harness/dir');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /does not exist/.test(e)));
});

test('preflight: missing state.json returns error', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    fs.rmSync(path.join(harnessDir, 'state.json'));
    const result = preflight(harnessDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /Missing state.json/.test(e)));
  } finally { cleanup(root); }
});

test('preflight: malformed state.json returns error', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    fs.writeFileSync(path.join(harnessDir, 'state.json'), '{not json');
    const result = preflight(harnessDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /not valid JSON/.test(e)));
  } finally { cleanup(root); }
});

test('preflight: missing subdirectory returns error', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    fs.rmSync(path.join(harnessDir, 'verify'), { recursive: true });
    const result = preflight(harnessDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /verify/.test(e)));
  } finally { cleanup(root); }
});

// ---------- ID format errors (I7-I10) ----------

test('preflight: milestone key "abc" fails I7', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    const state = readState(harnessDir);
    state.milestones['abc'] = { id: 'abc', description: 'bad', status: 'pending', missions: {} };
    writeState(harnessDir, state);
    const result = preflight(harnessDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /I7/.test(e)));
  } finally { cleanup(root); }
});

test('preflight: mission key "01-001" (two digits) fails I8', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    const state = readState(harnessDir);
    state.milestones['001'] = {
      id: '001',
      description: 'ms',
      status: 'pending',
      missions: {
        '01-001': { id: '01-001', description: 'bad', status: 'pending' },
      },
    };
    writeState(harnessDir, state);
    const result = preflight(harnessDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /I8/.test(e)));
  } finally { cleanup(root); }
});

test('preflight: sub-mission key malformed fails I9', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    addValidMission(harnessDir, { withSubMission: false });
    const missionFile = path.join(harnessDir, 'state', 'mission-001-001.json');
    const missionState = JSON.parse(fs.readFileSync(missionFile, 'utf8'));
    missionState.subMissions['bad-id'] = { id: 'bad-id', description: 'x', status: 'pending', tasks: {} };
    fs.writeFileSync(missionFile, JSON.stringify(missionState, null, 2));
    const result = preflight(harnessDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /I9/.test(e)));
  } finally { cleanup(root); }
});

test('preflight: task key malformed fails I10', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    addValidMission(harnessDir);
    const missionFile = path.join(harnessDir, 'state', 'mission-001-001.json');
    const missionState = JSON.parse(fs.readFileSync(missionFile, 'utf8'));
    missionState.subMissions['001-001-001'].tasks['malformed'] = {
      id: 'malformed', description: 'x', status: 'pending',
    };
    fs.writeFileSync(missionFile, JSON.stringify(missionState, null, 2));
    const result = preflight(harnessDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /I10/.test(e)));
  } finally { cleanup(root); }
});

// ---------- Task ID replan suffix (I10) ----------

test('preflight: task key 001-001-001-001 (base) passes preflight', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    addValidMission(harnessDir);
    // addValidMission already creates 001-001-001-001 — just confirm preflight passes
    const result = preflight(harnessDir);
    assert.equal(result.ok, true, `expected ok, got errors: ${result.errors.join('; ')}`);
    assert.ok(!result.errors.some((e) => /I10/.test(e)));
  } finally { cleanup(root); }
});

test('preflight: task key 001-001-001-001-rp-1 (single replan) passes preflight', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    addValidMission(harnessDir);
    const missionFile = path.join(harnessDir, 'state', 'mission-001-001.json');
    const missionState = JSON.parse(fs.readFileSync(missionFile, 'utf8'));
    missionState.subMissions['001-001-001'].tasks['001-001-001-001-rp-1'] = {
      id: '001-001-001-001-rp-1', description: 'replan task', status: 'pending',
    };
    fs.writeFileSync(missionFile, JSON.stringify(missionState, null, 2));
    const result = preflight(harnessDir);
    assert.equal(result.ok, true, `expected ok, got errors: ${result.errors.join('; ')}`);
    assert.ok(!result.errors.some((e) => /I10/.test(e)));
  } finally { cleanup(root); }
});

test('preflight: task key 001-001-001-001-rp-1-rp-2 (nested replans) passes preflight', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    addValidMission(harnessDir);
    const missionFile = path.join(harnessDir, 'state', 'mission-001-001.json');
    const missionState = JSON.parse(fs.readFileSync(missionFile, 'utf8'));
    missionState.subMissions['001-001-001'].tasks['001-001-001-001-rp-1-rp-2'] = {
      id: '001-001-001-001-rp-1-rp-2', description: 'nested replan task', status: 'pending',
    };
    fs.writeFileSync(missionFile, JSON.stringify(missionState, null, 2));
    const result = preflight(harnessDir);
    assert.equal(result.ok, true, `expected ok, got errors: ${result.errors.join('; ')}`);
    assert.ok(!result.errors.some((e) => /I10/.test(e)));
  } finally { cleanup(root); }
});

test('preflight: task key 001-001-001-001-rp- (no digits after -rp-) fails I10', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    addValidMission(harnessDir);
    const missionFile = path.join(harnessDir, 'state', 'mission-001-001.json');
    const missionState = JSON.parse(fs.readFileSync(missionFile, 'utf8'));
    missionState.subMissions['001-001-001'].tasks['001-001-001-001-rp-'] = {
      id: '001-001-001-001-rp-', description: 'bad replan', status: 'pending',
    };
    fs.writeFileSync(missionFile, JSON.stringify(missionState, null, 2));
    const result = preflight(harnessDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /I10/.test(e)));
  } finally { cleanup(root); }
});

test('preflight: task key 001-001-001-001-xy-001 (wrong prefix) fails I10', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    addValidMission(harnessDir);
    const missionFile = path.join(harnessDir, 'state', 'mission-001-001.json');
    const missionState = JSON.parse(fs.readFileSync(missionFile, 'utf8'));
    missionState.subMissions['001-001-001'].tasks['001-001-001-001-xy-001'] = {
      id: '001-001-001-001-xy-001', description: 'bad suffix', status: 'pending',
    };
    fs.writeFileSync(missionFile, JSON.stringify(missionState, null, 2));
    const result = preflight(harnessDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /I10/.test(e)));
  } finally { cleanup(root); }
});

test('preflight: task key "001-001-001-001-rp-1 " (trailing space) fails I10', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    addValidMission(harnessDir);
    const missionFile = path.join(harnessDir, 'state', 'mission-001-001.json');
    const missionState = JSON.parse(fs.readFileSync(missionFile, 'utf8'));
    missionState.subMissions['001-001-001'].tasks['001-001-001-001-rp-1 '] = {
      id: '001-001-001-001-rp-1 ', description: 'trailing space', status: 'pending',
    };
    fs.writeFileSync(missionFile, JSON.stringify(missionState, null, 2));
    const result = preflight(harnessDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /I10/.test(e)));
  } finally { cleanup(root); }
});

test('preflight: task key 001-001-001-001-rp-abc (non-digit suffix) fails I10', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    addValidMission(harnessDir);
    const missionFile = path.join(harnessDir, 'state', 'mission-001-001.json');
    const missionState = JSON.parse(fs.readFileSync(missionFile, 'utf8'));
    missionState.subMissions['001-001-001'].tasks['001-001-001-001-rp-abc'] = {
      id: '001-001-001-001-rp-abc', description: 'non-digit replan', status: 'pending',
    };
    fs.writeFileSync(missionFile, JSON.stringify(missionState, null, 2));
    const result = preflight(harnessDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /I10/.test(e)));
  } finally { cleanup(root); }
});

// ---------- Mission state file reference (I12 / S3) ----------

test('preflight: missing mission state file yields warning (S3), not error', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    const state = readState(harnessDir);
    state.milestones['001'] = {
      id: '001',
      description: 'ms',
      status: 'pending',
      missions: {
        '001-001': {
          id: '001-001',
          description: 'mi',
          status: 'pending',
          stateFile: '.harness/state/mission-001-001.json',
        },
      },
    };
    writeState(harnessDir, state);
    // Deliberately do NOT write the mission state file.
    const result = preflight(harnessDir);
    assert.equal(result.ok, true, 'missing mission state file should be a warning');
    assert.ok(result.warnings.some((w) => /S3/.test(w)));
  } finally { cleanup(root); }
});

// ---------- Warning-only cases ----------

test('preflight: milestone key "milestone-001" yields S1 warning only', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    const state = readState(harnessDir);
    state.milestones['milestone-001'] = {
      id: 'milestone-001', description: 'x', status: 'pending', missions: {},
    };
    writeState(harnessDir, state);
    const result = preflight(harnessDir);
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => /S1/.test(w)));
    assert.deepEqual(result.errors, []);
  } finally { cleanup(root); }
});

test('preflight: title instead of description yields S2 warning only', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    const state = readState(harnessDir);
    state.milestones['001'] = {
      id: '001', title: 'bad', status: 'pending', missions: {},
    };
    writeState(harnessDir, state);
    const result = preflight(harnessDir);
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => /S2/.test(w)));
  } finally { cleanup(root); }
});

test('preflight: unknown status yields S4 warning only', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    const state = readState(harnessDir);
    state.milestones['001'] = {
      id: '001', description: 'x', status: 'weird', missions: {},
    };
    writeState(harnessDir, state);
    const result = preflight(harnessDir);
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => /S4/.test(w)));
  } finally { cleanup(root); }
});

test('preflight: invalid globalStatus is a hard error', () => {
  const root = createProjectRoot();
  try {
    const harnessDir = freshHarness(root);
    const state = readState(harnessDir);
    state.globalStatus = 'banana';
    writeState(harnessDir, state);
    const result = preflight(harnessDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /globalStatus/.test(e)));
  } finally { cleanup(root); }
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
