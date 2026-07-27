/**
 * test-siderail-timing.js — Deterministic unit tests for the
 * timing.avgTaskDurationMs derivation in createSiderailHandler
 * (src/ui/api/siderail.js). No SDK/auth, no live pipeline: the handler is
 * invoked directly against temp `.harness` fixtures with a fake `res` object
 * that captures the payload passed to `res.json(...)`.
 *
 * Run: node test/test-siderail-timing.js
 *
 * Covers:
 *   TC1 — two completed (verified) tasks with startedAt/completedAt spans of
 *         100000ms and 200000ms → timing.avgTaskDurationMs === 150000 (the
 *         arithmetic mean of the per-completed-task spans)
 *   TC2 — no completed task exposes both startedAt/completedAt (or none are
 *         completed) → timing.avgTaskDurationMs key is entirely absent
 *         (hasOwnProperty false), never defaulted to 0
 *   TC3 — elapsedMs and remainingTasks are still present in the omission case
 *   TC4 — corrupt state.json → {active:false} returned without throwing
 */
import { createSiderailHandler } from '../src/ui/api/siderail.js';
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
// mkFakeRes — captures the payload passed to res.json(...)
// ---------------------------------------------------------------------------
function mkFakeRes() {
  return {
    payload: undefined,
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

// ---------------------------------------------------------------------------
// mkHarness — creates a temp dir with a minimal `.harness` tree: one
// milestone → one mission → one subMission → tasks. Tasks are supplied by
// the caller so both the derivation and omission cases can seed different
// task shapes while sharing the same tree-walk scaffolding.
// ---------------------------------------------------------------------------
function mkHarness(tasks) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-siderail-timing-'));
  const harnessDir = path.join(tmp, '.harness');
  const archivesDir = path.join(tmp, 'archives');
  fs.mkdirSync(harnessDir, { recursive: true });

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      globalStatus: 'active',
      startedAt: new Date(Date.now() - 60000).toISOString(),
      milestones: {
        '001': {
          id: '001',
          description: 'Milestone One',
          status: 'in_progress',
          missions: {
            '001-001': {
              id: '001-001',
              description: 'Mission 1',
              status: 'in_progress',
              stateFile: '.harness/state/mission-001-001.json',
            },
          },
        },
      },
    })
  );

  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(harnessDir, 'state', 'mission-001-001.json'),
    JSON.stringify({
      id: '001-001',
      missionId: '001-001',
      description: 'Mission 1',
      status: 'in_progress',
      subMissions: {
        '001-001-001': {
          id: '001-001-001',
          description: 'SubMission 1',
          status: 'in_progress',
          tasks,
        },
      },
    })
  );

  return { tmp, projectRoot: tmp, archivesDir };
}

// ---------------------------------------------------------------------------
// invoke — calls createSiderailHandler({projectRoot, archivesDir}) directly
// with a fake req/res pair and returns the captured payload.
// ---------------------------------------------------------------------------
function invoke(projectRoot, archivesDir) {
  const handler = createSiderailHandler({ projectRoot, archivesDir });
  const res = mkFakeRes();
  handler({}, res);
  return res.payload;
}

// ---------------------------------------------------------------------------
// TC1: derivation — two completed tasks spanning 100000ms and 200000ms →
// timing.avgTaskDurationMs === 150000 (arithmetic mean)
// ---------------------------------------------------------------------------
test('TC1: two completed tasks spanning 100000ms and 200000ms → avgTaskDurationMs === 150000', () => {
  const { tmp, projectRoot, archivesDir } = mkHarness({
    '001-001-001-001': {
      id: '001-001-001-001',
      description: 'Task A (done)',
      status: 'verified',
      createdAt: '2026-01-01T00:00:00.000Z',
      retryCount: 0,
      targetFiles: ['src/a.js'],
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:40.000Z', // +100000ms
    },
    '001-001-001-002': {
      id: '001-001-001-002',
      description: 'Task B (done)',
      status: 'verified',
      createdAt: '2026-01-01T00:02:00.000Z',
      retryCount: 0,
      targetFiles: ['src/b.js'],
      startedAt: '2026-01-01T00:02:00.000Z',
      completedAt: '2026-01-01T00:05:20.000Z', // +200000ms
    },
  });
  dirsToCleanup.push(tmp);
  try {
    const payload = invoke(projectRoot, archivesDir);
    assert.ok(payload && payload.timing, `Expected a timing object, got ${JSON.stringify(payload)}`);
    assert.strictEqual(
      payload.timing.avgTaskDurationMs, 150000,
      `Expected avgTaskDurationMs 150000 ((100000+200000)/2), got ${payload.timing.avgTaskDurationMs}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

// ---------------------------------------------------------------------------
// TC2 + TC3: omission — no completed task exposes both startedAt/completedAt
// → timing lacks the avgTaskDurationMs key entirely (never defaults to 0),
// while elapsedMs and remainingTasks are still present.
// ---------------------------------------------------------------------------
test('TC2+TC3: no completed task with both timestamps → avgTaskDurationMs key absent, elapsedMs/remainingTasks present', () => {
  const { tmp, projectRoot, archivesDir } = mkHarness({
    '001-001-001-001': {
      id: '001-001-001-001',
      description: 'Task A (in progress)',
      status: 'in_progress',
      createdAt: '2026-01-01T00:00:00.000Z',
      retryCount: 0,
      targetFiles: ['src/a.js'],
    },
    '001-001-001-002': {
      id: '001-001-001-002',
      description: 'Task B (pending)',
      status: 'pending',
      createdAt: '2026-01-01T00:02:00.000Z',
      retryCount: 0,
      targetFiles: [],
    },
  });
  dirsToCleanup.push(tmp);
  try {
    const payload = invoke(projectRoot, archivesDir);
    assert.ok(payload && payload.timing, `Expected a timing object, got ${JSON.stringify(payload)}`);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(payload.timing, 'avgTaskDurationMs'), false,
      `Expected timing to omit avgTaskDurationMs entirely, got ${JSON.stringify(payload.timing)}`
    );
    assert.ok(
      typeof payload.timing.elapsedMs === 'number' && payload.timing.elapsedMs >= 0,
      `Expected timing.elapsedMs to be a non-negative number, got ${payload.timing.elapsedMs}`
    );
    assert.strictEqual(
      payload.timing.remainingTasks, 2,
      `Expected timing.remainingTasks 2 (2 total - 0 complete), got ${payload.timing.remainingTasks}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

// ---------------------------------------------------------------------------
// TC2b: a verified task WITHOUT startedAt/completedAt also does not
// contribute to avgTaskDurationMs — the key must still be absent even when
// tasks are complete, as long as none carry usable spans.
// ---------------------------------------------------------------------------
test('TC2b: completed task lacking startedAt/completedAt → avgTaskDurationMs key still absent', () => {
  const { tmp, projectRoot, archivesDir } = mkHarness({
    '001-001-001-001': {
      id: '001-001-001-001',
      description: 'Task A (done, no timestamps)',
      status: 'verified',
      createdAt: '2026-01-01T00:00:00.000Z',
      retryCount: 0,
      targetFiles: ['src/a.js'],
    },
  });
  dirsToCleanup.push(tmp);
  try {
    const payload = invoke(projectRoot, archivesDir);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(payload.timing, 'avgTaskDurationMs'), false,
      `Expected timing to omit avgTaskDurationMs entirely, got ${JSON.stringify(payload.timing)}`
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

// ---------------------------------------------------------------------------
// TC4: corrupt state.json → {active:false} without throwing
// ---------------------------------------------------------------------------
test('TC4: corrupt state.json → {active:false} without throwing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-siderail-timing-corrupt-'));
  const harnessDir = path.join(tmp, '.harness');
  const archivesDir = path.join(tmp, 'archives');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'state.json'), '{ not valid json ][');
  dirsToCleanup.push(tmp);
  try {
    let payload;
    assert.doesNotThrow(() => {
      payload = invoke(tmp, archivesDir);
    }, 'Expected createSiderailHandler to never throw on corrupt state.json');
    assert.deepStrictEqual(
      payload, { active: false },
      `Expected {active:false}, got ${JSON.stringify(payload)}`
    );
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
