/**
 * test-siderail-lineage.js — Deterministic unit tests (no SDK/auth, no live
 * pipeline) asserting that createSiderailHandler's `current` snapshot carries
 * the mission/milestone why-text (missionDescription/milestoneDescription),
 * and that notify.js's detectTransitions weaves both description strings
 * into its lineage-suffixed message.
 *
 * Run: node test/test-siderail-lineage.js
 *
 * Covers:
 *   TC1 — snapshot.current.missionDescription and .milestoneDescription
 *         equal the fixture mission/milestone descriptions (current.description
 *         is still the task description)
 *   TC2 — detectTransitions(prev, curr) message includes both description
 *         strings in the lineage suffix
 *   TC3 — corrupt/missing state.json → handler returns {active:false}, no throw
 */
import { createSiderailHandler } from '../src/ui/api/siderail.js';
import { detectTransitions } from '../src/ui/notify.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

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

// ---------------------------------------------------------------------------
// Cleanup tracking (belt-and-suspenders for CI)
// ---------------------------------------------------------------------------
const dirsToCleanup = [];

process.on('exit', () => {
  for (const d of dirsToCleanup) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// fakeRes — captures the res.json(...) payload for direct handler invocation
// (createSiderailHandler({projectRoot, archivesDir}) returns an Express-style
// (req, res) => void handler; no HTTP server needed here).
// ---------------------------------------------------------------------------
function fakeRes() {
  const res = { payload: undefined };
  res.json = (body) => {
    res.payload = body;
    return res;
  };
  return res;
}

// ---------------------------------------------------------------------------
// mkPopulatedHarness — mirrors test/test-ui-siderail.js's mkPopulatedHarness:
// a temp .harness fixture with state.json (globalStatus:'active', a milestone
// carrying description 'Milestone Two' and a mission carrying description
// 'Mission 2') plus a mission-<id>.json whose subMissions contain an
// in_progress task.
// ---------------------------------------------------------------------------
const MILESTONE_DESCRIPTION = 'Milestone Two';
const MISSION_DESCRIPTION = 'Mission 2';
const TASK_DESCRIPTION = 'Task D (in progress)';

function mkPopulatedHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-siderail-lineage-'));
  const harnessDir = path.join(tmp, '.harness');
  const archivesDir = path.join(tmp, 'archives');
  fs.mkdirSync(harnessDir, { recursive: true });

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath: '/tmp/spec.md', currentPhase: 'executing' },
      globalStatus: 'active',
      startedAt: new Date(Date.now() - 60000).toISOString(),
      milestones: {
        '002': {
          id: '002',
          description: MILESTONE_DESCRIPTION,
          status: 'in_progress',
          missions: {
            '002-001': {
              id: '002-001',
              description: MISSION_DESCRIPTION,
              status: 'in_progress',
              stateFile: '.harness/state/mission-002-001.json',
            },
          },
        },
      },
    })
  );

  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(harnessDir, 'state', 'mission-002-001.json'),
    JSON.stringify({
      id: '002-001',
      missionId: '002-001',
      description: MISSION_DESCRIPTION,
      status: 'in_progress',
      subMissions: {
        '002-001-001': {
          id: '002-001-001',
          description: 'SubMission 2',
          status: 'in_progress',
          tasks: {
            '002-001-001-001': {
              id: '002-001-001-001',
              description: 'Task C (done)',
              status: 'verified',
              createdAt: '2026-01-01T00:01:00.000Z',
              retryCount: 0,
              targetFiles: ['src/c.js'],
            },
            '002-001-001-002': {
              id: '002-001-001-002',
              description: TASK_DESCRIPTION,
              status: 'in_progress',
              createdAt: '2026-01-01T00:02:00.000Z',
              retryCount: 0,
              targetFiles: [],
            },
          },
        },
      },
    })
  );

  return { tmp, harnessDir, archivesDir };
}

// ---------------------------------------------------------------------------
// mkCorruptHarness — state.json present but not valid JSON.
// ---------------------------------------------------------------------------
function mkCorruptHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-siderail-lineage-corrupt-'));
  const harnessDir = path.join(tmp, '.harness');
  const archivesDir = path.join(tmp, 'archives');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'state.json'), '{ this is not valid JSON ');
  return { tmp, harnessDir, archivesDir };
}

// ---------------------------------------------------------------------------
// mkMissingHarness — .harness/state.json does not exist at all.
// ---------------------------------------------------------------------------
function mkMissingHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-siderail-lineage-missing-'));
  return { tmp, harnessDir: path.join(tmp, '.harness'), archivesDir: path.join(tmp, 'archives') };
}

// ---------------------------------------------------------------------------
// invokeHandler — createSiderailHandler({projectRoot, archivesDir}) resolves
// its harnessDir via activeHarnessDir(projectRoot), whose flat-root fallback
// resolves to path.join(projectRoot, '.harness') — mirroring withServer's
// projectRoot derivation in test/test-ui-siderail.js.
// ---------------------------------------------------------------------------
function invokeHandler(harnessDir, archivesDir) {
  const projectRoot = path.dirname(harnessDir);
  const handler = createSiderailHandler({ projectRoot, archivesDir });
  const res = fakeRes();
  handler({}, res);
  return res.payload;
}

// ---------------------------------------------------------------------------
// TC1: snapshot.current.missionDescription and .milestoneDescription equal
// the fixture mission/milestone descriptions (current.description remains
// the task description)
// ---------------------------------------------------------------------------
test('TC1: current.missionDescription/.milestoneDescription equal fixture descriptions', () => {
  const { tmp, harnessDir, archivesDir } = mkPopulatedHarness();
  dirsToCleanup.push(tmp);
  try {
    const payload = invokeHandler(harnessDir, archivesDir);
    assert.ok(payload.current, `Expected a current task, got ${JSON.stringify(payload.current)}`);
    assert.strictEqual(
      payload.current.description, TASK_DESCRIPTION,
      `Expected current.description '${TASK_DESCRIPTION}', got ${payload.current.description}`
    );
    assert.strictEqual(
      payload.current.missionDescription, MISSION_DESCRIPTION,
      `Expected current.missionDescription '${MISSION_DESCRIPTION}', got ${payload.current.missionDescription}`
    );
    assert.strictEqual(
      payload.current.milestoneDescription, MILESTONE_DESCRIPTION,
      `Expected current.milestoneDescription '${MILESTONE_DESCRIPTION}', got ${payload.current.milestoneDescription}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

// ---------------------------------------------------------------------------
// TC2: detectTransitions(prev, curr) message includes both description
// strings in the lineage suffix
// ---------------------------------------------------------------------------
test('TC2: detectTransitions lineage suffix includes mission + milestone descriptions', () => {
  const { tmp, harnessDir, archivesDir } = mkPopulatedHarness();
  dirsToCleanup.push(tmp);
  try {
    const curr = invokeHandler(harnessDir, archivesDir);
    // prev snapshot: pendingDecision false (baseline, same shape otherwise)
    const prev = { ...curr, pendingDecision: false };
    // this snapshot: pendingDecision true (fires the pendingDecision edge)
    curr.pendingDecision = true;

    const transitions = detectTransitions(prev, curr);
    const pendingTransition = transitions.find((t) => t.type === 'pendingDecision');
    assert.ok(
      pendingTransition,
      `Expected a pendingDecision transition, got ${JSON.stringify(transitions)}`
    );
    assert.ok(
      pendingTransition.message.includes(MISSION_DESCRIPTION),
      `Expected message to include mission description '${MISSION_DESCRIPTION}', got: ${pendingTransition.message}`
    );
    assert.ok(
      pendingTransition.message.includes(MILESTONE_DESCRIPTION),
      `Expected message to include milestone description '${MILESTONE_DESCRIPTION}', got: ${pendingTransition.message}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

// ---------------------------------------------------------------------------
// TC3: corrupt/missing state.json → handler returns {active:false}, no throw
// ---------------------------------------------------------------------------
test('TC3a: corrupt state.json → {active:false}, no throw', () => {
  const { tmp, harnessDir, archivesDir } = mkCorruptHarness();
  dirsToCleanup.push(tmp);
  try {
    let payload;
    assert.doesNotThrow(() => {
      payload = invokeHandler(harnessDir, archivesDir);
    });
    assert.strictEqual(payload.active, false, `Expected active:false, got ${JSON.stringify(payload)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

test('TC3b: missing state.json → {active:false}, no throw', () => {
  const { tmp, harnessDir, archivesDir } = mkMissingHarness();
  dirsToCleanup.push(tmp);
  try {
    let payload;
    assert.doesNotThrow(() => {
      payload = invokeHandler(harnessDir, archivesDir);
    });
    assert.strictEqual(payload.active, false, `Expected active:false, got ${JSON.stringify(payload)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
