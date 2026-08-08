/**
 * test-ui-archives-api.js — Integration tests for the UI archives API routes.
 *
 * Run: node test/test-ui-archives-api.js
 *
 * Covers:
 *   TC1 — GET /api/archives → 200, body shape { archives: [...] } with length 3
 *   TC2 — each list entry has the 7 required keys
 *   TC3 — GET /api/archives against empty archivesDir → 200, { archives: [] }
 *   TC4 — GET /api/archive/complete-archive → 200, 6-key detail shape
 *   TC5 — GET /api/archive/does-not-exist → 404
 *   TC6 — GET /api/archive/missing-spec-archive → specMd === null, other fields populated
 *   TC7 — GET /api/archive/missing-reviewer-archive → reviewerFindings === null
 *   TC8 — manifest-less dir → degraded entry with id===dirname, degradedReason non-empty string
 *   TC9 — unparseable manifest.json (invalid JSON) → same degraded-entry assertions
 *   TC10 — non-object manifest.json (value 42) → same degraded-entry assertions, plus
 *          degraded + healthy entries in the same archivesDir come back sorted ascending by id
 *   TC11 — healthy entry shape unchanged: own-property key set is exactly the 7 original
 *          fields (no 'degraded'/'degradedReason'), and id/slug/date/totalCostUsd/status
 *          match the values derived from manifest.json
 *   TC12 — no console.warn for degraded entries: a counting stub replaces console.warn for
 *          the duration of a request over an all-degraded archivesDir, records 0 calls, and
 *          the original console.warn is restored in a finally block
 *   TC13 — task counters use the real state-machine statuses: verifiedTasks counts
 *          'complete' (there is no 'verified' status), and 'invalidated' replan husks are
 *          excluded from BOTH totalTasks and verifiedTasks
 */
import { createServer } from '../src/ui/server.js';
import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
// withServer helper — spins up an ephemeral server on port 0
// ---------------------------------------------------------------------------
async function withServer(archivesDir, fn) {
  const server = createServer({ archivesDir }).listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Fixture path
// ---------------------------------------------------------------------------
const ARCHIVES_MOCK_DETAIL = path.resolve(__dirname, 'fixtures', 'archives-mock-detail');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run() {

// ---------------------------------------------------------------------------
// TC1: GET /api/archives → 200, body { archives: [...] } with length 3
// ---------------------------------------------------------------------------
await test('TC1: GET /api/archives → 200, body { archives: [...] } length 3', async () => {
  await withServer(ARCHIVES_MOCK_DETAIL, async (base) => {
    const { status, json } = await httpGet(`${base}/api/archives`);
    assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
    assert.ok(
      json && typeof json === 'object' && !Array.isArray(json),
      `Expected body to be an object, got ${JSON.stringify(json)}`
    );
    assert.ok(
      Array.isArray(json.archives),
      `Expected body.archives to be an array, got ${JSON.stringify(json.archives)}`
    );
    assert.strictEqual(
      json.archives.length,
      3,
      `Expected archives.length === 3, got ${json.archives.length}`
    );
  });
});

// ---------------------------------------------------------------------------
// TC2: each list entry has all 7 keys
// ---------------------------------------------------------------------------
await test('TC2: each archive entry has 7 keys: id, slug, date, totalCostUsd, totalTasks, verifiedTasks, status', async () => {
  await withServer(ARCHIVES_MOCK_DETAIL, async (base) => {
    const { status, json } = await httpGet(`${base}/api/archives`);
    assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
    assert.ok(
      Array.isArray(json.archives),
      `Expected body.archives to be an array, got ${JSON.stringify(json.archives)}`
    );
    const REQUIRED_KEYS = ['id', 'slug', 'date', 'totalCostUsd', 'totalTasks', 'verifiedTasks', 'status'];
    for (const entry of json.archives) {
      const keys = Object.keys(entry).sort();
      const required = [...REQUIRED_KEYS].sort();
      for (const k of required) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(entry, k),
          `Expected entry to have key '${k}', got keys: ${JSON.stringify(Object.keys(entry))}`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// TC3: empty archivesDir → 200, { archives: [] }
// ---------------------------------------------------------------------------
await test('TC3: GET /api/archives against empty archivesDir → 200, { archives: [] }', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-archives-empty-'));
  try {
    await withServer(emptyDir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/archives`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      assert.ok(
        json && typeof json === 'object' && !Array.isArray(json),
        `Expected body to be an object, got ${JSON.stringify(json)}`
      );
      assert.deepStrictEqual(
        json.archives,
        [],
        `Expected archives === [], got ${JSON.stringify(json.archives)}`
      );
    });
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC4: GET /api/archive/complete-archive → 200, 6-key shape
// ---------------------------------------------------------------------------
await test('TC4: GET /api/archive/complete-archive → 200, body keys {id,state,cost,specMd,reviewerFindings,runReportRelPath}', async () => {
  await withServer(ARCHIVES_MOCK_DETAIL, async (base) => {
    const { status, json } = await httpGet(`${base}/api/archive/complete-archive`);
    assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
    const EXPECTED_KEYS = ['id', 'state', 'cost', 'specMd', 'reviewerFindings', 'runReportRelPath'].sort();
    const actualKeys = Object.keys(json).sort();
    assert.deepStrictEqual(
      actualKeys,
      EXPECTED_KEYS,
      `Expected body keys ${JSON.stringify(EXPECTED_KEYS)}, got ${JSON.stringify(actualKeys)}`
    );
  });
});

// ---------------------------------------------------------------------------
// TC5: GET /api/archive/does-not-exist → 404
// ---------------------------------------------------------------------------
await test('TC5: GET /api/archive/does-not-exist → 404', async () => {
  await withServer(ARCHIVES_MOCK_DETAIL, async (base) => {
    const { status } = await httpGet(`${base}/api/archive/does-not-exist`);
    assert.strictEqual(status, 404, `Expected status 404, got ${status}`);
  });
});

// ---------------------------------------------------------------------------
// TC6: GET /api/archive/missing-spec-archive → specMd === null, other fields populated
// ---------------------------------------------------------------------------
await test('TC6: GET /api/archive/missing-spec-archive → specMd===null, other fields non-null', async () => {
  await withServer(ARCHIVES_MOCK_DETAIL, async (base) => {
    const { status, json } = await httpGet(`${base}/api/archive/missing-spec-archive`);
    assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
    assert.strictEqual(
      json.specMd,
      null,
      `Expected specMd===null, got ${JSON.stringify(json.specMd)}`
    );
    assert.ok(json.id != null, `Expected id to be non-null, got ${JSON.stringify(json.id)}`);
    assert.ok(json.state != null, `Expected state to be non-null, got ${JSON.stringify(json.state)}`);
    assert.ok(json.cost != null, `Expected cost to be non-null, got ${JSON.stringify(json.cost)}`);
    assert.ok(
      json.reviewerFindings != null,
      `Expected reviewerFindings to be non-null, got ${JSON.stringify(json.reviewerFindings)}`
    );
    assert.ok(
      json.runReportRelPath != null,
      `Expected runReportRelPath to be non-null, got ${JSON.stringify(json.runReportRelPath)}`
    );
  });
});

// ---------------------------------------------------------------------------
// TC7: GET /api/archive/missing-reviewer-archive → reviewerFindings === null
// ---------------------------------------------------------------------------
await test('TC7: GET /api/archive/missing-reviewer-archive → reviewerFindings===null', async () => {
  await withServer(ARCHIVES_MOCK_DETAIL, async (base) => {
    const { status, json } = await httpGet(`${base}/api/archive/missing-reviewer-archive`);
    assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
    assert.strictEqual(
      json.reviewerFindings,
      null,
      `Expected reviewerFindings===null, got ${JSON.stringify(json.reviewerFindings)}`
    );
  });
});

// ---------------------------------------------------------------------------
// TC8: manifest-less dir → degraded entry
// ---------------------------------------------------------------------------
await test('TC8: manifest-less dir → degraded entry with id===dirname and non-empty degradedReason', async () => {
  const archivesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-archives-degraded-'));
  try {
    const dirname = 'no-manifest-archive';
    const archiveDir = path.join(archivesDir, dirname);
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'state.json'), JSON.stringify({ milestones: {} }));

    await withServer(archivesDir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/archives`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      assert.strictEqual(
        json.archives.length,
        1,
        `Expected archives.length === 1, got ${json.archives.length}`
      );
      const entry = json.archives[0];
      assert.strictEqual(
        entry.id,
        dirname,
        `Expected entry.id === '${dirname}', got ${JSON.stringify(entry.id)}`
      );
      assert.strictEqual(
        entry.degraded,
        true,
        `Expected entry.degraded === true, got ${JSON.stringify(entry.degraded)}`
      );
      assert.strictEqual(
        typeof entry.degradedReason,
        'string',
        `Expected entry.degradedReason to be a string, got ${typeof entry.degradedReason}`
      );
      assert.ok(
        entry.degradedReason.length > 0,
        `Expected entry.degradedReason to be non-empty, got ${JSON.stringify(entry.degradedReason)}`
      );
    });
  } finally {
    fs.rmSync(archivesDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC9: unparseable manifest.json (invalid JSON) → degraded entry
// ---------------------------------------------------------------------------
await test('TC9: unparseable manifest.json → degraded entry with id===dirname and non-empty degradedReason', async () => {
  const archivesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-archives-degraded-'));
  try {
    const dirname = 'bad-json-archive';
    const archiveDir = path.join(archivesDir, dirname);
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'manifest.json'), '{ this is not valid JSON');

    await withServer(archivesDir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/archives`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      assert.strictEqual(
        json.archives.length,
        1,
        `Expected archives.length === 1, got ${json.archives.length}`
      );
      const entry = json.archives[0];
      assert.strictEqual(
        entry.id,
        dirname,
        `Expected entry.id === '${dirname}', got ${JSON.stringify(entry.id)}`
      );
      assert.strictEqual(
        entry.degraded,
        true,
        `Expected entry.degraded === true, got ${JSON.stringify(entry.degraded)}`
      );
      assert.strictEqual(
        typeof entry.degradedReason,
        'string',
        `Expected entry.degradedReason to be a string, got ${typeof entry.degradedReason}`
      );
      assert.ok(
        entry.degradedReason.length > 0,
        `Expected entry.degradedReason to be non-empty, got ${JSON.stringify(entry.degradedReason)}`
      );
    });
  } finally {
    fs.rmSync(archivesDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC10: non-object manifest.json (value 42) → degraded entry; degraded +
// healthy entries in the same archivesDir come back sorted ascending by id
// ---------------------------------------------------------------------------
await test('TC10: non-object manifest.json (42) → degraded entry; sorted ascending by id alongside a healthy entry', async () => {
  const archivesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-archives-degraded-'));
  try {
    const degradedDirname = 'zzz-non-object-manifest-archive';
    const degradedArchiveDir = path.join(archivesDir, degradedDirname);
    fs.mkdirSync(degradedArchiveDir, { recursive: true });
    fs.writeFileSync(path.join(degradedArchiveDir, 'manifest.json'), JSON.stringify(42));

    const healthyDirname = 'aaa-healthy-archive';
    const healthyArchiveDir = path.join(archivesDir, healthyDirname);
    fs.mkdirSync(healthyArchiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(healthyArchiveDir, 'manifest.json'),
      JSON.stringify({
        id: 'healthy-archive',
        name: 'healthy-archive',
        seq: '001',
        archivedAt: '2026-05-10T12:00:00.000Z',
        milestones: [{ id: '001', status: 'complete' }],
        totalCost: 1.23,
      })
    );

    await withServer(archivesDir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/archives`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      assert.strictEqual(
        json.archives.length,
        2,
        `Expected archives.length === 2, got ${json.archives.length}`
      );

      const degradedEntry = json.archives.find((e) => e.id === degradedDirname);
      assert.ok(
        degradedEntry,
        `Expected an entry with id === '${degradedDirname}', got ${JSON.stringify(json.archives)}`
      );
      assert.strictEqual(
        degradedEntry.degraded,
        true,
        `Expected degradedEntry.degraded === true, got ${JSON.stringify(degradedEntry.degraded)}`
      );
      assert.strictEqual(
        typeof degradedEntry.degradedReason,
        'string',
        `Expected degradedEntry.degradedReason to be a string, got ${typeof degradedEntry.degradedReason}`
      );
      assert.ok(
        degradedEntry.degradedReason.length > 0,
        `Expected degradedEntry.degradedReason to be non-empty, got ${JSON.stringify(degradedEntry.degradedReason)}`
      );

      const ids = json.archives.map((e) => e.id);
      const sortedIds = [...ids].sort((a, b) => String(a).localeCompare(String(b)));
      assert.deepStrictEqual(
        ids,
        sortedIds,
        `Expected archives to be sorted ascending by id, got ${JSON.stringify(ids)}`
      );
    });
  } finally {
    fs.rmSync(archivesDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC11: healthy entry shape unchanged — own keys are exactly the 7 original
// fields (no 'degraded'/'degradedReason'), values match the manifest
// ---------------------------------------------------------------------------
await test('TC11: healthy entry shape unchanged — exact 7-key set, no degraded fields, values match manifest', async () => {
  const archivesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-archives-shape-'));
  try {
    const healthyDirname = 'healthy-entry-archive';
    const healthyArchiveDir = path.join(archivesDir, healthyDirname);
    fs.mkdirSync(healthyArchiveDir, { recursive: true });
    const manifest = {
      id: 'healthy-entry-archive-id',
      name: 'healthy-entry-archive',
      archivedAt: '2026-01-01T00:00:00.000Z',
      milestones: [{ id: '001', status: 'complete' }],
      totalCost: 4.56,
    };
    fs.writeFileSync(path.join(healthyArchiveDir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(healthyArchiveDir, 'state.json'), JSON.stringify({ milestones: {} }));

    const degradedDirname = 'no-manifest-archive-shape';
    const degradedArchiveDir = path.join(archivesDir, degradedDirname);
    fs.mkdirSync(degradedArchiveDir, { recursive: true });
    fs.writeFileSync(path.join(degradedArchiveDir, 'state.json'), JSON.stringify({ milestones: {} }));

    await withServer(archivesDir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/archives`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      assert.strictEqual(
        json.archives.length,
        2,
        `Expected archives.length === 2, got ${json.archives.length}`
      );

      const healthyEntry = json.archives.find((e) => e.id === manifest.id);
      assert.ok(
        healthyEntry,
        `Expected an entry with id === '${manifest.id}', got ${JSON.stringify(json.archives)}`
      );

      const EXPECTED_KEYS = ['id', 'slug', 'date', 'totalCostUsd', 'totalTasks', 'verifiedTasks', 'status'];
      const actualKeys = Object.keys(healthyEntry).sort();
      const expectedSorted = [...EXPECTED_KEYS].sort();
      assert.deepStrictEqual(
        actualKeys,
        expectedSorted,
        `Expected healthy entry own-keys to be exactly ${JSON.stringify(expectedSorted)}, got ${JSON.stringify(actualKeys)}`
      );
      assert.ok(
        !Object.prototype.hasOwnProperty.call(healthyEntry, 'degraded'),
        `Expected healthy entry to NOT have key 'degraded', got keys: ${JSON.stringify(Object.keys(healthyEntry))}`
      );
      assert.ok(
        !Object.prototype.hasOwnProperty.call(healthyEntry, 'degradedReason'),
        `Expected healthy entry to NOT have key 'degradedReason', got keys: ${JSON.stringify(Object.keys(healthyEntry))}`
      );

      assert.strictEqual(
        healthyEntry.id,
        manifest.id,
        `Expected healthyEntry.id === '${manifest.id}', got ${JSON.stringify(healthyEntry.id)}`
      );
      assert.strictEqual(
        healthyEntry.slug,
        manifest.name,
        `Expected healthyEntry.slug === '${manifest.name}', got ${JSON.stringify(healthyEntry.slug)}`
      );
      assert.strictEqual(
        healthyEntry.date,
        manifest.archivedAt,
        `Expected healthyEntry.date === '${manifest.archivedAt}', got ${JSON.stringify(healthyEntry.date)}`
      );
      assert.strictEqual(
        healthyEntry.totalCostUsd,
        manifest.totalCost,
        `Expected healthyEntry.totalCostUsd === ${manifest.totalCost}, got ${JSON.stringify(healthyEntry.totalCostUsd)}`
      );
      assert.strictEqual(
        healthyEntry.status,
        'complete',
        `Expected healthyEntry.status === 'complete', got ${JSON.stringify(healthyEntry.status)}`
      );
    });
  } finally {
    fs.rmSync(archivesDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC12: no console.warn for degraded entries — a counting stub replaces
// console.warn for the duration of the request, records 0 calls, and the
// original console.warn is restored in a finally block
// ---------------------------------------------------------------------------
await test('TC12: no console.warn for degraded entries', async () => {
  const archivesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-archives-nowarn-'));
  const originalWarn = console.warn;
  let warnCallCount = 0;
  try {
    const noManifestDirname = 'no-manifest-archive-warn';
    fs.mkdirSync(path.join(archivesDir, noManifestDirname), { recursive: true });
    fs.writeFileSync(
      path.join(archivesDir, noManifestDirname, 'state.json'),
      JSON.stringify({ milestones: {} })
    );

    const badJsonDirname = 'bad-json-archive-warn';
    fs.mkdirSync(path.join(archivesDir, badJsonDirname), { recursive: true });
    fs.writeFileSync(
      path.join(archivesDir, badJsonDirname, 'manifest.json'),
      '{ this is not valid JSON'
    );

    const nonObjectDirname = 'non-object-manifest-archive-warn';
    fs.mkdirSync(path.join(archivesDir, nonObjectDirname), { recursive: true });
    fs.writeFileSync(
      path.join(archivesDir, nonObjectDirname, 'manifest.json'),
      JSON.stringify(42)
    );

    console.warn = (...args) => {
      warnCallCount++;
    };

    await withServer(archivesDir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/archives`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      assert.strictEqual(
        json.archives.length,
        3,
        `Expected archives.length === 3, got ${json.archives.length}`
      );
      for (const entry of json.archives) {
        assert.strictEqual(
          entry.degraded,
          true,
          `Expected entry.degraded === true, got ${JSON.stringify(entry.degraded)}`
        );
      }
      assert.strictEqual(
        warnCallCount,
        0,
        `Expected console.warn to be called 0 times, got ${warnCallCount}`
      );
    });
  } finally {
    console.warn = originalWarn;
    fs.rmSync(archivesDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC13: verifiedTasks counts status 'complete'; 'invalidated' replan husks are
// excluded from both totalTasks and verifiedTasks
// ---------------------------------------------------------------------------
await test("TC13: verifiedTasks counts 'complete'; 'invalidated' husks excluded from both counts", async () => {
  // The shared fixture's complete-archive mission carries 2 complete + 1 pending
  // + 1 invalidated husk → totalTasks 3 (husk excluded), verifiedTasks 2.
  await withServer(ARCHIVES_MOCK_DETAIL, async (base) => {
    const { status, json } = await httpGet(`${base}/api/archives`);
    assert.strictEqual(status, 200, `Expected status 200, got ${status}`);

    const entry = json.archives.find((e) => e.slug === 'complete-archive' || e.id === 'complete-archive');
    assert.ok(
      entry,
      `Expected an entry for complete-archive, got ${JSON.stringify(json.archives)}`
    );
    assert.strictEqual(
      entry.totalTasks,
      3,
      `Expected totalTasks === 3 (invalidated husk excluded), got ${JSON.stringify(entry.totalTasks)}`
    );
    assert.strictEqual(
      entry.verifiedTasks,
      2,
      `Expected verifiedTasks === 2 (the two 'complete' tasks), got ${JSON.stringify(entry.verifiedTasks)}`
    );
  });
});

// ---------------------------------------------------------------------------
// TC14: a synthetic archive whose tasks are ALL 'invalidated' reports 0/0 —
// pins that husks never reach the denominator
// ---------------------------------------------------------------------------
await test('TC14: all-invalidated tasks → totalTasks 0 and verifiedTasks 0', async () => {
  const archivesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-archives-husk-'));
  try {
    const dirname = 'husk-archive';
    const archiveDir = path.join(archivesDir, dirname);
    fs.mkdirSync(path.join(archiveDir, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, 'manifest.json'),
      JSON.stringify({
        id: 'husk-archive',
        name: 'husk-archive',
        archivedAt: '2026-05-10T12:00:00.000Z',
        milestones: [{ id: '001', status: 'complete' }],
        totalCost: 0,
      })
    );
    fs.writeFileSync(
      path.join(archiveDir, 'state.json'),
      JSON.stringify({
        milestones: { '001': { id: '001', missions: { '001-001': { id: '001-001' } } } },
      })
    );
    fs.writeFileSync(
      path.join(archiveDir, 'state', 'mission-001-001.json'),
      JSON.stringify({
        id: '001-001',
        subMissions: {
          '001-001-001': {
            id: '001-001-001',
            tasks: {
              '001-001-001-001': { id: '001-001-001-001', status: 'invalidated' },
              '001-001-001-002': { id: '001-001-001-002', status: 'invalidated' },
            },
          },
        },
      })
    );

    await withServer(archivesDir, async (base) => {
      const { status, json } = await httpGet(`${base}/api/archives`);
      assert.strictEqual(status, 200, `Expected status 200, got ${status}`);
      const entry = json.archives[0];
      assert.ok(entry, `Expected one entry, got ${JSON.stringify(json.archives)}`);
      assert.strictEqual(
        entry.totalTasks,
        0,
        `Expected totalTasks === 0, got ${JSON.stringify(entry.totalTasks)}`
      );
      assert.strictEqual(
        entry.verifiedTasks,
        0,
        `Expected verifiedTasks === 0, got ${JSON.stringify(entry.verifiedTasks)}`
      );
    });
  } finally {
    fs.rmSync(archivesDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
