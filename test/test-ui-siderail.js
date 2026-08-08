/**
 * test-ui-siderail.js — Integration tests for GET /api/siderail and the
 * static /siderail.html page, served via src/ui/server.js's createServer().
 *
 * Run: node test/test-ui-siderail.js
 *
 * Covers:
 *   TC1 — GET /api/siderail on populated fixture → 200 JSON
 *   TC2 — progress counts (tasksComplete/tasksTotal, milestonesComplete/
 *         milestonesTotal) match the fixture
 *   TC3 — current in-progress task includes lineage text (missionId +
 *         milestoneId + description)
 *   TC4 — pendingDecision/error are booleans: both false on a clean run,
 *         and each true when the fixture seeds the corresponding
 *         parked/halted/gate signal
 *   TC5 — timing includes elapsedMs and remainingTasks; avgTaskDurationMs is
 *         derived in-run from completed tasks' own startedAt/completedAt
 *         spans and is omitted from timing when the fixture's verified
 *         tasks expose no such spans
 *   TC6 — empty/missing harness → {active:false}
 *   TC7 — GET /siderail.html → 200 serving the static page markup
 */
import { createServer } from '../src/ui/server.js';
import { deriveDecisionState } from '../src/ui/api/siderail.js';
import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

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

// ---------------------------------------------------------------------------
// httpGet helper — wraps http.get with a 5000ms timeout
// ---------------------------------------------------------------------------
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(body); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, body, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('Request timed out after 5000ms — server did not respond'));
    });
  });
}

// ---------------------------------------------------------------------------
// withServer helper — spins up an ephemeral server on port 0, deriving
// projectRoot from harnessDir (via activeHarnessDir's flat-root fallback)
// and passing both projectRoot and archivesDir through to createServer
// (archivesDir is required for /api/siderail's avgTaskDurationMs archive
// scan).
// ---------------------------------------------------------------------------
async function withServer(harnessDir, archivesDir, fn) {
  const projectRoot = path.dirname(harnessDir);
  const server = createServer({ projectRoot, archivesDir }).listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
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
// mkPopulatedHarness — creates a temp dir with a `.harness` tree whose
// milestones/missions/tasks span complete/in_progress/pending/invalidated
// statuses, plus an `archives/*/manifest.json` fixture supplying timing data.
//
// Statuses are the ones persisted state actually carries: the terminal
// 'complete' (never the transient 'verified', which snapshots never show) and
// the 'invalidated' replan husk, which must be excluded from tasksTotal.
//
//   milestone 001 (complete)   → mission 001-001 → 2 complete tasks
//   milestone 002 (in_progress) → mission 002-001 → complete + in_progress +
//                                 pending + 1 invalidated husk
//
// tasksTotal = 5 (the husk is excluded), tasksComplete = 3 (2 + 1 complete),
// remainingTasks = 2
// milestonesTotal = 2, milestonesComplete = 1
//
// archives/archive-001/manifest.json: startedAt..archivedAt spans 600000ms
// over a 2-task archive → avgTaskDurationMs === 300000
//
// `signal` optionally overlays queueStatus/gate/awaitingDecision/error onto
// state.json's projectMeta to drive the pendingDecision/error assertions.
// ---------------------------------------------------------------------------
function mkPopulatedHarness(signal) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-ui-siderail-'));
  const harnessDir = path.join(tmp, '.harness');
  const archivesDir = path.join(tmp, 'archives');
  fs.mkdirSync(harnessDir, { recursive: true });

  const projectMeta = { prdPath: '/tmp/spec.md', currentPhase: 'executing', ...signal };

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta,
      globalStatus: 'active',
      startedAt: new Date(Date.now() - 60000).toISOString(),
      milestones: {
        '001': {
          id: '001',
          description: 'Milestone One',
          status: 'complete',
          missions: {
            '001-001': {
              id: '001-001',
              description: 'Mission 1',
              status: 'complete',
              stateFile: '.harness/state/mission-001-001.json',
            },
          },
        },
        '002': {
          id: '002',
          description: 'Milestone Two',
          status: 'in_progress',
          missions: {
            '002-001': {
              id: '002-001',
              description: 'Mission 2',
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
    path.join(harnessDir, 'state', 'mission-001-001.json'),
    JSON.stringify({
      id: '001-001',
      missionId: '001-001',
      description: 'Mission 1',
      status: 'complete',
      subMissions: {
        '001-001-001': {
          id: '001-001-001',
          description: 'SubMission 1',
          status: 'complete',
          tasks: {
            '001-001-001-001': {
              id: '001-001-001-001',
              description: 'Task A (done)',
              status: 'complete',
              createdAt: '2026-01-01T00:00:00.000Z',
              retryCount: 0,
              targetFiles: ['src/a.js'],
            },
            '001-001-001-002': {
              id: '001-001-001-002',
              description: 'Task B (done)',
              status: 'complete',
              createdAt: '2026-01-01T00:00:00.000Z',
              retryCount: 0,
              targetFiles: ['src/b.js'],
            },
          },
        },
      },
    })
  );

  fs.writeFileSync(
    path.join(harnessDir, 'state', 'mission-002-001.json'),
    JSON.stringify({
      id: '002-001',
      missionId: '002-001',
      description: 'Mission 2',
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
              status: 'complete',
              createdAt: '2026-01-01T00:01:00.000Z',
              retryCount: 0,
              targetFiles: ['src/c.js'],
            },
            '002-001-001-002': {
              id: '002-001-001-002',
              description: 'Task D (in progress)',
              status: 'in_progress',
              createdAt: '2026-01-01T00:02:00.000Z',
              retryCount: 0,
              targetFiles: [],
            },
            '002-001-001-003': {
              id: '002-001-001-003',
              description: 'Task E (pending)',
              status: 'pending',
              createdAt: '2026-01-01T00:03:00.000Z',
              retryCount: 0,
              targetFiles: [],
            },
            // Replan husk — must land in NEITHER tasksTotal nor tasksComplete.
            // It carries startedAt/completedAt so it would also corrupt the
            // duration average if the timing branch ever counted it.
            '002-001-001-004': {
              id: '002-001-001-004',
              description: 'Task F (invalidated husk)',
              status: 'invalidated',
              createdAt: '2026-01-01T00:04:00.000Z',
              startedAt: '2026-01-01T00:04:00.000Z',
              completedAt: '2026-01-01T02:04:00.000Z',
              retryCount: 0,
              targetFiles: [],
            },
          },
        },
      },
    })
  );

  // ── archives/archive-001/manifest.json fixture → timing data ────────────
  const archiveDir = path.join(archivesDir, 'archive-001');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(
    path.join(archiveDir, 'manifest.json'),
    JSON.stringify({
      id: 'archive-001',
      startedAt: '2026-01-01T00:00:00.000Z',
      archivedAt: '2026-01-01T00:10:00.000Z', // 600000ms span
    })
  );
  fs.writeFileSync(
    path.join(archiveDir, 'state.json'),
    JSON.stringify({
      milestones: {
        '001': {
          id: '001',
          missions: {
            '001-001': { id: '001-001' },
          },
        },
      },
    })
  );
  fs.mkdirSync(path.join(archiveDir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(archiveDir, 'state', 'mission-001-001.json'),
    JSON.stringify({
      subMissions: {
        '001-001-001': {
          tasks: {
            '001-001-001-001': { id: '001-001-001-001' },
            '001-001-001-002': { id: '001-001-001-002' },
          },
        },
      },
    })
  );
  // 600000ms / 2 tasks === 300000ms avgTaskDurationMs

  return { tmp, harnessDir, archivesDir };
}

// ---------------------------------------------------------------------------
// mkEmptyHarness — returns a non-existent path under tmpdir
// ---------------------------------------------------------------------------
function mkEmptyHarness() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-ui-siderail-empty-'));
  return { base, harnessDir: path.join(base, '.harness'), archivesDir: path.join(base, 'archives') };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run() {

// ---------------------------------------------------------------------------
// TC1: GET /api/siderail on populated fixture → 200 JSON
// ---------------------------------------------------------------------------
await test('TC1: GET /api/siderail on populated fixture → 200 JSON', async () => {
  const { tmp, harnessDir, archivesDir } = mkPopulatedHarness();
  dirsToCleanup.push(tmp);
  try {
    await withServer(harnessDir, archivesDir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/siderail`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      assert.strictEqual(typeof json, 'object', `Expected a JSON object body, got ${typeof json}`);
      assert.strictEqual(json.active, true, `Expected active===true, got ${json.active}`);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

// ---------------------------------------------------------------------------
// TC2: progress counts match the fixture — tasksComplete counts the terminal
// 'complete' status, and the fixture's 'invalidated' husk is in neither the
// numerator nor the denominator (6 tasks exist; tasksTotal is 5)
// ---------------------------------------------------------------------------
await test('TC2: progress counts count \'complete\' and exclude the \'invalidated\' husk', async () => {
  const { tmp, harnessDir, archivesDir } = mkPopulatedHarness();
  dirsToCleanup.push(tmp);
  try {
    await withServer(harnessDir, archivesDir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/siderail`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      assert.deepStrictEqual(
        json.progress,
        { tasksComplete: 3, tasksTotal: 5, milestonesComplete: 1, milestonesTotal: 2 },
        `Unexpected progress: ${JSON.stringify(json.progress)}`
      );
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

// ---------------------------------------------------------------------------
// TC3: current in-progress task includes lineage text (missionId+milestoneId+description)
// ---------------------------------------------------------------------------
await test('TC3: current in-progress task includes lineage (missionId+milestoneId+description)', async () => {
  const { tmp, harnessDir, archivesDir } = mkPopulatedHarness();
  dirsToCleanup.push(tmp);
  try {
    await withServer(harnessDir, archivesDir, async (base) => {
      const { json } = await httpGet(`${base}/api/siderail`);
      assert.ok(json.current, `Expected a current task, got ${JSON.stringify(json.current)}`);
      assert.strictEqual(
        json.current.taskId, '002-001-001-002',
        `Expected current.taskId '002-001-001-002', got ${json.current.taskId}`
      );
      assert.strictEqual(
        json.current.description, 'Task D (in progress)',
        `Expected current.description 'Task D (in progress)', got ${json.current.description}`
      );
      assert.strictEqual(
        json.current.missionId, '002-001',
        `Expected current.missionId '002-001', got ${json.current.missionId}`
      );
      assert.strictEqual(
        json.current.milestoneId, '002',
        `Expected current.milestoneId '002', got ${json.current.milestoneId}`
      );
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

// ---------------------------------------------------------------------------
// TC4: pendingDecision/error are booleans — false on clean run, true when
// the fixture seeds the corresponding parked/halted/gate signal
// ---------------------------------------------------------------------------
await test('TC4a: clean run → pendingDecision:false, error:false, both booleans', async () => {
  const { tmp, harnessDir, archivesDir } = mkPopulatedHarness();
  dirsToCleanup.push(tmp);
  try {
    await withServer(harnessDir, archivesDir, async (base) => {
      const { json } = await httpGet(`${base}/api/siderail`);
      assert.strictEqual(typeof json.pendingDecision, 'boolean', `Expected pendingDecision boolean, got ${typeof json.pendingDecision}`);
      assert.strictEqual(typeof json.error, 'boolean', `Expected error boolean, got ${typeof json.error}`);
      assert.strictEqual(json.pendingDecision, false, `Expected pendingDecision:false, got ${json.pendingDecision}`);
      assert.strictEqual(json.error, false, `Expected error:false, got ${json.error}`);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

await test('TC4b: seeded queueStatus:"parked" → pendingDecision:true, error:false', async () => {
  const { tmp, harnessDir, archivesDir } = mkPopulatedHarness({ queueStatus: 'parked' });
  dirsToCleanup.push(tmp);
  try {
    await withServer(harnessDir, archivesDir, async (base) => {
      const { json } = await httpGet(`${base}/api/siderail`);
      assert.strictEqual(json.pendingDecision, true, `Expected pendingDecision:true, got ${json.pendingDecision}`);
      assert.strictEqual(json.error, false, `Expected error:false, got ${json.error}`);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

await test('TC4c: seeded queueStatus:"halted-review" → error:true, pendingDecision:false', async () => {
  const { tmp, harnessDir, archivesDir } = mkPopulatedHarness({ queueStatus: 'halted-review' });
  dirsToCleanup.push(tmp);
  try {
    await withServer(harnessDir, archivesDir, async (base) => {
      const { json } = await httpGet(`${base}/api/siderail`);
      assert.strictEqual(json.error, true, `Expected error:true, got ${json.error}`);
      assert.strictEqual(json.pendingDecision, false, `Expected pendingDecision:false, got ${json.pendingDecision}`);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

await test('TC4d: seeded gate:true → pendingDecision:true', async () => {
  const { tmp, harnessDir, archivesDir } = mkPopulatedHarness({ gate: true });
  dirsToCleanup.push(tmp);
  try {
    await withServer(harnessDir, archivesDir, async (base) => {
      const { json } = await httpGet(`${base}/api/siderail`);
      assert.strictEqual(json.pendingDecision, true, `Expected pendingDecision:true, got ${json.pendingDecision}`);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

// ---------------------------------------------------------------------------
// TC5: timing has elapsedMs, remainingTasks; avgTaskDurationMs is derived
// in-run from completed tasks' own startedAt/completedAt spans and is
// omitted when the fixture's complete tasks expose no such spans. The
// fixture's invalidated husk carries a span for realism; note the husk is
// excluded by the counter's `continue` BEFORE the timing branch, so this
// test pins the count exclusion, not the timing gate itself.
// ---------------------------------------------------------------------------
await test('TC5: timing has elapsedMs, remainingTasks; avgTaskDurationMs omitted (no in-run task spans in fixture)', async () => {
  const { tmp, harnessDir, archivesDir } = mkPopulatedHarness();
  dirsToCleanup.push(tmp);
  try {
    await withServer(harnessDir, archivesDir, async (base) => {
      const { json } = await httpGet(`${base}/api/siderail`);
      assert.ok(json.timing, `Expected a timing object, got ${JSON.stringify(json)}`);
      assert.ok(
        typeof json.timing.elapsedMs === 'number' && json.timing.elapsedMs >= 0,
        `Expected timing.elapsedMs to be a non-negative number, got ${json.timing.elapsedMs}`
      );
      assert.strictEqual(
        json.timing.remainingTasks, 2,
        `Expected timing.remainingTasks 2 (5 total - 3 complete), got ${json.timing.remainingTasks}`
      );
      assert.strictEqual(
        json.timing.avgTaskDurationMs, undefined,
        `Expected timing.avgTaskDurationMs to be omitted (fixture's complete tasks have no startedAt/completedAt, and the invalidated husk's span must not count), got ${json.timing.avgTaskDurationMs}`
      );
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

// ---------------------------------------------------------------------------
// TC6: empty/missing harness → {active:false}
// ---------------------------------------------------------------------------
await test('TC6: GET /api/siderail with empty/missing harness → {active:false}', async () => {
  const { base: baseDir, harnessDir, archivesDir } = mkEmptyHarness();
  dirsToCleanup.push(baseDir);
  try {
    await withServer(harnessDir, archivesDir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/siderail`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      assert.strictEqual(json.active, false, `Expected active:false, got ${JSON.stringify(json)}`);
    });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(baseDir), 1);
  }
});

// ---------------------------------------------------------------------------
// TC7: GET /siderail.html → 200 serving the static page markup
// ---------------------------------------------------------------------------
await test('TC7: GET /siderail.html → 200 serving the static page markup', async () => {
  const { tmp, harnessDir, archivesDir } = mkPopulatedHarness();
  dirsToCleanup.push(tmp);
  try {
    await withServer(harnessDir, archivesDir, async (base) => {
      const { status, body } = await httpGet(`${base}/siderail.html`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      assert.ok(
        body.includes('id="decision-banner"'),
        'Expected siderail.html markup to include id="decision-banner"'
      );
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    dirsToCleanup.splice(dirsToCleanup.indexOf(tmp), 1);
  }
});

// ---------------------------------------------------------------------------
// UT1-UT6: deriveDecisionState pure-function unit cases (no server/filesystem)
// ---------------------------------------------------------------------------
await test('UT1: { queueStatus: "parked" } → pendingDecision:true, error:false', () => {
  assert.deepStrictEqual(
    deriveDecisionState({ queueStatus: 'parked' }),
    { pendingDecision: true, error: false }
  );
});

await test('UT2: { queueStatus: "halted-review" } → pendingDecision:false, error:true', () => {
  assert.deepStrictEqual(
    deriveDecisionState({ queueStatus: 'halted-review' }),
    { pendingDecision: false, error: true }
  );
});

await test('UT3: { queueStatus: "halted-analyzer" } → pendingDecision:false, error:true', () => {
  assert.deepStrictEqual(
    deriveDecisionState({ queueStatus: 'halted-analyzer' }),
    { pendingDecision: false, error: true }
  );
});

await test('UT4: empty/unknown/absent status with no markers → both flags false', () => {
  assert.deepStrictEqual(deriveDecisionState({}), { pendingDecision: false, error: false });
  assert.deepStrictEqual(deriveDecisionState({ queueStatus: '' }), { pendingDecision: false, error: false });
  assert.deepStrictEqual(deriveDecisionState({ queueStatus: 'running' }), { pendingDecision: false, error: false });
  assert.deepStrictEqual(deriveDecisionState(undefined), { pendingDecision: false, error: false });
  assert.deepStrictEqual(deriveDecisionState('not-an-object'), { pendingDecision: false, error: false });
});

await test('UT5: { gate: true } → pendingDecision:true', () => {
  const result = deriveDecisionState({ gate: true });
  assert.strictEqual(result.pendingDecision, true, `Expected pendingDecision:true, got ${result.pendingDecision}`);
});

await test('UT6: { awaitingDecision: true } → pendingDecision:true', () => {
  const result = deriveDecisionState({ awaitingDecision: true });
  assert.strictEqual(result.pendingDecision, true, `Expected pendingDecision:true, got ${result.pendingDecision}`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
