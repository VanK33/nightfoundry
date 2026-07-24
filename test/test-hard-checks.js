/**
 * test-hard-checks.js — Unit tests for hard-checks.js.
 *
 * No Claude auth, no SDK. Uses temp directories + shell primitives
 * (true, false, sleep, echo) that exist on any POSIX system.
 * Run: node test/test-hard-checks.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { runHardChecks, HARD_CHECK_DEFAULT_TIMEOUT_MS } from '../src/orchestrator/gates/hard-checks.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      failCount++;
    }
  );
}

async function assertThrowsAsync(fn, pattern, msg) {
  let thrown;
  try { await fn(); } catch (e) { thrown = e; }
  if (!thrown) throw new Error(msg || 'Expected function to throw');
  if (pattern && !pattern.test(thrown.message)) {
    throw new Error(`${msg || 'Throw pattern mismatch'}. Got: ${thrown.message}`);
  }
}

// ---------- Fixture helpers ----------

function createTestEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-checks-test-'));
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'verify'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  return { projectRoot: root, harnessDir };
}

function cleanup(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

function writeVerify(harnessDir, taskId, hardChecks) {
  const verify = { taskId, hardChecks, testCases: [], targetFiles: [] };
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify(verify, null, 2)
  );
}

// ---------- Tests ----------

async function main() {
  await test('empty hardChecks array → passed=true with empty results', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      writeVerify(harnessDir, '001-001-001-001', []);
      const result = await runHardChecks(harnessDir, '001-001-001-001', projectRoot);
      assert.equal(result.passed, true);
      assert.deepEqual(result.results, []);
      assert.ok(fs.existsSync(result.reportPath));
    } finally { cleanup(projectRoot); }
  });

  await test('single passing check (true) → passed=true', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      writeVerify(harnessDir, '001-001-001-001', [
        { name: 'trivially true', command: 'true' },
      ]);
      const result = await runHardChecks(harnessDir, '001-001-001-001', projectRoot);
      assert.equal(result.passed, true);
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].passed, true);
      assert.equal(result.results[0].exitCode, 0);
    } finally { cleanup(projectRoot); }
  });

  await test('single failing check (false) → passed=false', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      writeVerify(harnessDir, '001-001-001-001', [
        { name: 'trivially false', command: 'false' },
      ]);
      const result = await runHardChecks(harnessDir, '001-001-001-001', projectRoot);
      assert.equal(result.passed, false);
      assert.equal(result.results[0].passed, false);
      assert.equal(result.results[0].exitCode, 1);
      assert.equal(result.results[0].timedOut, false);
    } finally { cleanup(projectRoot); }
  });

  await test('mixed pass/fail → overall passed=false', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      writeVerify(harnessDir, '001-001-001-001', [
        { name: 'ok', command: 'true' },
        { name: 'nope', command: 'false' },
      ]);
      const result = await runHardChecks(harnessDir, '001-001-001-001', projectRoot);
      assert.equal(result.passed, false);
      assert.equal(result.results.length, 2);
      assert.equal(result.results[0].passed, true);
      assert.equal(result.results[1].passed, false);
    } finally { cleanup(projectRoot); }
  });

  await test('timeout: sleep 5 with timeout 1 → fails with timedOut=true', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      writeVerify(harnessDir, '001-001-001-001', [
        { name: 'slow', command: 'sleep 5', timeout: 1 },
      ]);
      const result = await runHardChecks(harnessDir, '001-001-001-001', projectRoot);
      assert.equal(result.passed, false);
      assert.equal(result.results[0].passed, false);
      assert.equal(result.results[0].timedOut, true);
    } finally { cleanup(projectRoot); }
  });

  await test('expectExitCode=1 passes when command exits 1', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      writeVerify(harnessDir, '001-001-001-001', [
        { name: 'expects failure', command: 'false', expectExitCode: 1 },
      ]);
      const result = await runHardChecks(harnessDir, '001-001-001-001', projectRoot);
      assert.equal(result.passed, true);
      assert.equal(result.results[0].passed, true);
      assert.equal(result.results[0].exitCode, 1);
    } finally { cleanup(projectRoot); }
  });

  await test('missing verify.json throws', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      await assertThrowsAsync(
        () => runHardChecks(harnessDir, '001-001-001-999', projectRoot),
        /verify\.json not found/
      );
    } finally { cleanup(projectRoot); }
  });

  await test('malformed verify.json throws', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      fs.writeFileSync(
        path.join(harnessDir, 'verify', 'task-001-001-001-001.json'),
        '{not json'
      );
      await assertThrowsAsync(
        () => runHardChecks(harnessDir, '001-001-001-001', projectRoot),
        /not valid JSON/
      );
    } finally { cleanup(projectRoot); }
  });

  await test('report file written with expected content', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      writeVerify(harnessDir, '001-001-001-001', [
        { name: 'echo test', command: 'echo hello' },
        { name: 'fail it', command: 'false' },
      ]);
      const result = await runHardChecks(harnessDir, '001-001-001-001', projectRoot);
      const report = fs.readFileSync(result.reportPath, 'utf8');
      assert.ok(report.includes('# Hard Verification Report'));
      assert.ok(report.includes('FAILED'));
      assert.ok(report.includes('1/2 passed'));
      assert.ok(report.includes('[PASS] echo test'));
      assert.ok(report.includes('[FAIL] fail it'));
      assert.ok(report.includes('hello'), 'stdout should be captured in report');
    } finally { cleanup(projectRoot); }
  });

  await test('long stdout is truncated in report', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      // Generate output far exceeding truncation limit.
      writeVerify(harnessDir, '001-001-001-001', [
        { name: 'noisy', command: 'yes y | head -c 5000' },
      ]);
      const result = await runHardChecks(harnessDir, '001-001-001-001', projectRoot);
      const report = fs.readFileSync(result.reportPath, 'utf8');
      assert.ok(report.includes('truncated'));
    } finally { cleanup(projectRoot); }
  });

  await test('HARD_CHECK_DEFAULT_TIMEOUT_MS is exported and equals 30000', async () => {
    assert.strictEqual(HARD_CHECK_DEFAULT_TIMEOUT_MS, 30000);
  });

  await test('default timeout is used when check.timeout is omitted', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      // sleep 1 with no explicit timeout should complete successfully under the
      // default 30 s timeout, confirming HARD_CHECK_DEFAULT_TIMEOUT_MS is wired
      // through runOne rather than defaulting to 0 (which would time out).
      writeVerify(harnessDir, '001-001-001-001', [
        { name: 'short sleep no timeout', command: 'sleep 1' },
      ]);
      const result = await runHardChecks(harnessDir, '001-001-001-001', projectRoot);
      assert.equal(result.passed, true);
      assert.equal(result.results[0].passed, true);
      assert.equal(result.results[0].timedOut, false);
    } finally { cleanup(projectRoot); }
  });

  await test('report header includes passed check count', async () => {
    const { projectRoot, harnessDir } = createTestEnv();
    try {
      writeVerify(harnessDir, '001-001-001-001', [
        { name: 'a', command: 'true' },
        { name: 'b', command: 'true' },
        { name: 'c', command: 'true' },
      ]);
      const result = await runHardChecks(harnessDir, '001-001-001-001', projectRoot);
      const report = fs.readFileSync(result.reportPath, 'utf8');
      assert.ok(report.includes('3/3 passed'));
      assert.ok(report.includes('PASSED'));
      assert.equal(result.passed, true);
    } finally { cleanup(projectRoot); }
  });

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
