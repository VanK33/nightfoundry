/**
 * test-parallel-runner.js — Worker-pool behaviour of scripts/run-tests.js.
 *
 * Contract:
 *   - runAll(entries, {jobs}) executes every entry and returns results at
 *     their manifest index (order preserved regardless of completion order).
 *   - At most `jobs` children are in flight at once (verified from the
 *     children's own start/end timestamps — a hard invariant, not a timing
 *     race: a correct pool can never produce an overlap above the cap).
 *   - jobs=1 degenerates to strictly serial execution.
 *   - A non-zero child exit is a FAIL for that entry only; no fail-fast.
 *   - defaultJobs() honours CC_ORCH_TEST_JOBS ≥ 1 and ignores junk.
 *
 * Run: node test/test-parallel-runner.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runAll, defaultJobs } from '../scripts/run-tests.js';

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

const tmpDirs = [];
function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function cleanupAll() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
}

/**
 * Write a quiet fake test script (CommonJS — the tmp dir has no
 * package.json) that stamps start/end wall-clock files and exits with the
 * given code after `holdMs`.
 */
function makeFakeTest(dir, name, { exitCode = 0, holdMs = 200 } = {}) {
  const file = path.join(dir, `${name}.js`);
  const startStamp = path.join(dir, `${name}.start`);
  const endStamp = path.join(dir, `${name}.end`);
  fs.writeFileSync(file, `
    const fs = require('fs');
    fs.writeFileSync(${JSON.stringify(startStamp)}, String(Date.now()));
    setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(endStamp)}, String(Date.now()));
      process.exit(${exitCode});
    }, ${holdMs});
  `, 'utf8');
  return { file, startStamp, endStamp };
}

/** Max number of simultaneously-open [start, end] intervals. */
function maxOverlap(fakes) {
  const events = [];
  for (const f of fakes) {
    events.push([Number(fs.readFileSync(f.startStamp, 'utf8')), +1]);
    events.push([Number(fs.readFileSync(f.endStamp, 'utf8')), -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let inFlight = 0;
  let peak = 0;
  for (const [, delta] of events) {
    inFlight += delta;
    peak = Math.max(peak, inFlight);
  }
  return peak;
}

await test('runAll executes every entry and preserves manifest order in results', async () => {
  const dir = makeTmpDir('cc-orch-pool-');
  const fakes = ['a', 'b', 'c', 'd'].map((n) => makeFakeTest(dir, n, { holdMs: 50 }));
  const entries = fakes.map((f) => f.file);
  const results = await runAll(entries, { jobs: 3 });
  assert.strictEqual(results.length, entries.length);
  results.forEach((r, i) => {
    assert.strictEqual(r.label, entries[i], `Expected result ${i} to keep manifest position`);
    assert.strictEqual(r.passed, true);
  });
  for (const f of fakes) {
    assert.ok(fs.existsSync(f.endStamp), 'Expected every fake test to have actually run');
  }
});

await test('the pool never exceeds the jobs cap', async () => {
  const dir = makeTmpDir('cc-orch-pool-');
  const fakes = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => makeFakeTest(dir, n, { holdMs: 250 }));
  await runAll(fakes.map((f) => f.file), { jobs: 3 });
  const peak = maxOverlap(fakes);
  assert.ok(peak <= 3, `Expected at most 3 children in flight, saw ${peak}`);
});

await test('jobs=1 degenerates to strictly serial execution', async () => {
  const dir = makeTmpDir('cc-orch-pool-');
  const fakes = ['a', 'b', 'c', 'd'].map((n) => makeFakeTest(dir, n, { holdMs: 100 }));
  await runAll(fakes.map((f) => f.file), { jobs: 1 });
  const peak = maxOverlap(fakes);
  assert.strictEqual(peak, 1, `Expected serial execution, saw overlap of ${peak}`);
});

await test('a failing entry is FAIL for that entry only — no fail-fast', async () => {
  const dir = makeTmpDir('cc-orch-pool-');
  const ok1 = makeFakeTest(dir, 'ok1', { holdMs: 30 });
  const bad = makeFakeTest(dir, 'bad', { exitCode: 1, holdMs: 30 });
  const ok2 = makeFakeTest(dir, 'ok2', { holdMs: 30 });
  const results = await runAll([ok1.file, bad.file, ok2.file], { jobs: 2 });
  assert.deepStrictEqual(results.map((r) => r.passed), [true, false, true]);
  assert.ok(fs.existsSync(ok2.endStamp), 'Expected entries after the failure to still run');
});

await test('a missing entry resolves as FAIL without breaking the pool', async () => {
  const dir = makeTmpDir('cc-orch-pool-');
  const ok = makeFakeTest(dir, 'ok', { holdMs: 30 });
  const results = await runAll([path.join(dir, 'does-not-exist.js'), ok.file], { jobs: 2 });
  assert.strictEqual(results[0].passed, false, 'Expected a nonexistent entry to be a FAIL');
  assert.strictEqual(results[1].passed, true);
});

await test('runAll([]) resolves to an empty result set', async () => {
  const results = await runAll([], { jobs: 4 });
  assert.deepStrictEqual(results, []);
});

/**
 * A fake test that hangs forever on its FIRST run (marker file absent) and
 * exits cleanly on any later run — models a runtime that wedges once.
 * Counts every invocation in a `.runs` file.
 */
function makeHangOnceTest(dir, name) {
  const file = path.join(dir, `${name}.js`);
  const marker = path.join(dir, `${name}.marker`);
  const runsFile = path.join(dir, `${name}.runs`);
  fs.writeFileSync(file, `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(runsFile)}, 'x');
    if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);
    fs.writeFileSync(${JSON.stringify(marker)}, '');
    setInterval(() => {}, 1000); // hang forever
  `, 'utf8');
  return { file, runsFile };
}

function runsOf(runsFile) {
  try { return fs.readFileSync(runsFile, 'utf8').length; } catch { return 0; }
}

await test('a hung child is killed, retried once serially, and the retry verdict wins', async () => {
  const dir = makeTmpDir('cc-orch-pool-');
  const hangOnce = makeHangOnceTest(dir, 'hang-once');
  const ok = makeFakeTest(dir, 'ok', { holdMs: 30 });
  const results = await runAll([hangOnce.file, ok.file], { jobs: 2, hangTimeoutMs: 1500 });
  assert.strictEqual(results[0].passed, true, 'Expected the hang-once entry to pass via the serial retry');
  assert.strictEqual(results[0].retriedAfterHang, true, 'Expected the retry to be flagged');
  assert.strictEqual(runsOf(hangOnce.runsFile), 2, 'Expected exactly one retry (2 invocations total)');
  assert.strictEqual(results[1].passed, true);
});

await test('a child that hangs on the retry too ends up FAIL', async () => {
  const dir = makeTmpDir('cc-orch-pool-');
  const alwaysHang = path.join(dir, 'always-hang.js');
  fs.writeFileSync(alwaysHang, 'setInterval(() => {}, 1000);', 'utf8');
  const results = await runAll([alwaysHang], { jobs: 1, hangTimeoutMs: 1000 });
  assert.strictEqual(results[0].passed, false, 'Expected a repeat hang to stay FAIL');
  assert.strictEqual(results[0].retriedAfterHang, true);
  assert.strictEqual(results[0].hung, true, 'Expected the retry itself to be flagged hung');
});

await test('an assertion failure (non-zero exit) is never retried', async () => {
  const dir = makeTmpDir('cc-orch-pool-');
  // Exits 1 on the first run, would exit 0 on a second — a retry would
  // flip it green, so a green result here would prove an illegal retry.
  const flaky = path.join(dir, 'flaky-fail.js');
  const marker = path.join(dir, 'flaky-fail.marker');
  const runsFile = path.join(dir, 'flaky-fail.runs');
  fs.writeFileSync(flaky, `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(runsFile)}, 'x');
    if (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);
    fs.writeFileSync(${JSON.stringify(marker)}, '');
    process.exit(1);
  `, 'utf8');
  const results = await runAll([flaky], { jobs: 1, hangTimeoutMs: 5000 });
  assert.strictEqual(results[0].passed, false, 'Expected the red exit to stand');
  assert.ok(!results[0].retriedAfterHang, 'Expected NO retry for an assertion failure');
  assert.strictEqual(runsOf(runsFile), 1, 'Expected exactly one invocation');
});

await test('defaultJobs honours CC_ORCH_TEST_JOBS ≥ 1 and ignores junk', async () => {
  const prev = process.env.CC_ORCH_TEST_JOBS;
  try {
    process.env.CC_ORCH_TEST_JOBS = '3';
    assert.strictEqual(defaultJobs(), 3);
    process.env.CC_ORCH_TEST_JOBS = '1';
    assert.strictEqual(defaultJobs(), 1);
    for (const junk of ['0', '-2', 'abc', '2.5', '']) {
      process.env.CC_ORCH_TEST_JOBS = junk;
      const jobs = defaultJobs();
      assert.ok(Number.isInteger(jobs) && jobs >= 1 && jobs <= 8,
        `Expected the formula default for junk ${JSON.stringify(junk)}, got ${jobs}`);
    }
  } finally {
    if (prev === undefined) delete process.env.CC_ORCH_TEST_JOBS;
    else process.env.CC_ORCH_TEST_JOBS = prev;
  }
});

cleanupAll();
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
