/**
 * test-ui-server.js — Unit tests for src/ui/server.js
 *
 * Uses the import-and-listen-on-port-0 approach for determinism.
 * Run: node test/test-ui-server.js
 */
import { createServer } from '../src/ui/server.js';
import http from 'http';
import assert from 'assert';
import { once } from 'events';

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

async function run() {

// TC1: GET / returns 200 serving the dashboard page. The marker is the full
// dashboard title — 'Night Foundry' alone appears on all three pages, so it
// would not prove that / served index.html rather than any other page.
await test('GET / returns 200 with the dashboard-specific title marker', async () => {
  const server = createServer().listen(0);
  try {
    const port = server.address().port;
    const { res, body } = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ res, body: Buffer.concat(chunks).toString() }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy(new Error('Request timed out after 5000ms — server did not respond'));
      });
    });
    assert.strictEqual(res.statusCode, 200, `Expected status 200, got ${res.statusCode}`);
    assert.ok(
      body.includes('Night Foundry — dashboard'),
      `Expected body to include the dashboard-specific title 'Night Foundry — dashboard', body was: ${body.slice(0, 500)}`
    );
  } finally {
    server.close(() => {});
  }
});

// TC2: graceful shutdown via server.close()
await test('graceful shutdown via server.close()', async () => {
  const sigintBefore = process.listenerCount('SIGINT');
  const server = createServer().listen(0);
  try {
    server.close();
    await once(server, 'close');
    const sigintAfter = process.listenerCount('SIGINT');
    assert.strictEqual(
      sigintAfter,
      sigintBefore,
      `Expected SIGINT listener count to be ${sigintBefore} (pre-listen), got ${sigintAfter} — possible leaked SIGINT handler from createServer()`
    );
  } finally {
    server.close(() => {});
  }
});

// TC3: address released after close
await test('address released after close', async () => {
  const server = createServer().listen(0);
  try {
    server.close();
    await once(server, 'close');
    assert.strictEqual(
      server.address(),
      null,
      `Expected server.address() to be null after close, got ${JSON.stringify(server.address())}`
    );
  } finally {
    server.close(() => {});
  }
});

// TC4: createServer honours a custom projectRoot (cc-orch ui --project wiring)
await test('createServer({projectRoot}) reads state from that dir, not cwd', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-harness-'));
  const harnessDir = path.join(tmp, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  const marker = '/custom/project/spec-marker.md';
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({ projectMeta: { prdPath: marker }, globalStatus: 'active', milestones: {} })
  );
  const server = createServer({ projectRoot: tmp }).listen(0);
  try {
    const port = server.address().port;
    const body = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/state`, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Request timed out after 5000ms')));
    });
    assert.ok(
      body.includes(marker),
      `Expected /api/state to read the custom harnessDir's state.json (specPath '${marker}'); got: ${body.slice(0, 300)}`
    );
  } finally {
    server.close(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);

}

run();
