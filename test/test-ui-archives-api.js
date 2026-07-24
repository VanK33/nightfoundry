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
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
