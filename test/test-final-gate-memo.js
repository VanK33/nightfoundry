/**
 * test-final-gate-memo.js — Tree-hash memo behaviour at the two tail
 * full-suite consumers: the archive/run final gate (runFinalTestGate) and
 * the spec-criteria drain (runMilestoneOnlyChecks).
 *
 * Contract:
 *   - A fresh green memo for a byte-identical tree lets either consumer skip
 *     the suite; any tree change or a missing memo forces a real run.
 *   - A green run seeds the memo (only when the suite left the tree
 *     unchanged); a red or timed-out run never does.
 *   - config.execution.testAllMemo=false restores the always-run behaviour.
 *   - Non-full-suite drain checks are untouched by the memo.
 *
 * Run: node test/test-final-gate-memo.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { runFinalTestGate, TestGateError } from '../src/cli/commands/archive.js';
import { runMilestoneOnlyChecks } from '../src/orchestrator/gates/hard-checks.js';
import { computeTreeHash, recordGreenMemo, testAllMemoPath } from '../src/orchestrator/gates/test-memo.js';
import config from '../src/orchestrator/infra/config.js';

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
 * Git repo with a package.json carrying a test:all script (arms the final
 * gate) and a .gitignore for .harness/ (so memo writes stay off-porcelain).
 */
function makeGitProject() {
  const dir = makeTmpDir('cc-orch-gate-memo-');
  const git = (cmd) => execSync(
    `git -c user.email=t@t -c user.name=t ${cmd}`,
    { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  git('init -q');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.harness/\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'tmp-target',
    scripts: { 'test:all': 'node scripts/run-tests.js' },
  }), 'utf8');
  git('add -A');
  git('commit -q -m init');
  return dir;
}

// ── runFinalTestGate ──────────────────────────────────────────────────────────

await test('final gate: green run seeds the memo file', async () => {
  const dir = makeGitProject();
  let calls = 0;
  const spy = () => { calls++; return { exitCode: 0, output: 'all green' }; };
  runFinalTestGate(dir, {}, { runFullTestSuite: spy });
  assert.strictEqual(calls, 1, 'Expected the suite to run once');
  assert.ok(fs.existsSync(testAllMemoPath(dir)), 'Expected a memo file after a green run');
  const memo = JSON.parse(fs.readFileSync(testAllMemoPath(dir), 'utf8'));
  assert.strictEqual(memo.command, config.execution.testAllCommand);
  assert.strictEqual(memo.treeHash, computeTreeHash(dir));
});

await test('final gate: fresh memo + unchanged tree skips the suite', async () => {
  const dir = makeGitProject();
  recordGreenMemo(dir, { treeHash: computeTreeHash(dir), command: config.execution.testAllCommand });
  let calls = 0;
  const spy = () => { calls++; return { exitCode: 0, output: '' }; };
  runFinalTestGate(dir, {}, { runFullTestSuite: spy });
  assert.strictEqual(calls, 0, 'Expected the memo hit to skip the suite entirely');
});

await test('final gate: a tree change after the memo forces a real run', async () => {
  const dir = makeGitProject();
  recordGreenMemo(dir, { treeHash: computeTreeHash(dir), command: config.execution.testAllCommand });
  fs.writeFileSync(path.join(dir, 'changed.txt'), 'new content\n', 'utf8');
  let calls = 0;
  const spy = () => { calls++; return { exitCode: 0, output: '' }; };
  runFinalTestGate(dir, {}, { runFullTestSuite: spy });
  assert.strictEqual(calls, 1, 'Expected a changed tree to force a real suite run');
});

await test('final gate: a red run throws and does not seed the memo', async () => {
  const dir = makeGitProject();
  const spy = () => ({ exitCode: 1, output: 'FAIL' });
  assert.throws(
    () => runFinalTestGate(dir, {}, { runFullTestSuite: spy }),
    (err) => err instanceof TestGateError && !err.timedOut
  );
  assert.ok(!fs.existsSync(testAllMemoPath(dir)), 'Expected no memo after a red run');
});

await test('final gate: a timed-out run throws and does not seed the memo', async () => {
  const dir = makeGitProject();
  const spy = () => ({ exitCode: -1, output: '' });
  assert.throws(
    () => runFinalTestGate(dir, {}, { runFullTestSuite: spy }),
    (err) => err instanceof TestGateError && err.timedOut
  );
  assert.ok(!fs.existsSync(testAllMemoPath(dir)), 'Expected no memo after a timed-out run');
});

await test('final gate: a suite run that dirties the tree does not seed the memo', async () => {
  const dir = makeGitProject();
  const spy = () => {
    fs.writeFileSync(path.join(dir, 'dirtied-by-suite.txt'), 'x\n', 'utf8');
    return { exitCode: 0, output: '' };
  };
  runFinalTestGate(dir, {}, { runFullTestSuite: spy });
  assert.ok(!fs.existsSync(testAllMemoPath(dir)), 'Expected no memo when the suite mutated the tree');
});

await test('final gate: testAllMemo=false always runs the suite', async () => {
  const dir = makeGitProject();
  recordGreenMemo(dir, { treeHash: computeTreeHash(dir), command: config.execution.testAllCommand });
  const prev = config.execution.testAllMemo;
  config.execution.testAllMemo = false;
  try {
    let calls = 0;
    const spy = () => { calls++; return { exitCode: 0, output: '' }; };
    runFinalTestGate(dir, {}, { runFullTestSuite: spy });
    assert.strictEqual(calls, 1, 'Expected the disabled memo to leave the suite running');
  } finally {
    config.execution.testAllMemo = prev;
  }
});

// ── runMilestoneOnlyChecks (spec-criteria drain) ──────────────────────────────

/**
 * Point config.execution.testAllCommand at a sentinel-appending command for
 * the duration of fn. The sentinel lives OUTSIDE the git repo so a green
 * "suite" leaves the tree byte-identical (memo seeding requires that).
 */
function withSentinelSuite(fn) {
  const sentinelDir = makeTmpDir('cc-orch-sentinel-');
  const sentinel = path.join(sentinelDir, 'ran.txt');
  const prev = config.execution.testAllCommand;
  config.execution.testAllCommand = `node -e 'require("fs").appendFileSync(${JSON.stringify(sentinel)}, "x")'`;
  try {
    return fn(sentinel, config.execution.testAllCommand);
  } finally {
    config.execution.testAllCommand = prev;
  }
}

function sentinelRuns(sentinel) {
  try { return fs.readFileSync(sentinel, 'utf8').length; } catch { return 0; }
}

await test('drain: green full-suite check runs once, then the memo covers the repeat', async () => {
  const dir = makeGitProject();
  await withSentinelSuite((sentinel, command) => {
    const check = { name: 'full suite green', command };
    const first = runMilestoneOnlyChecks([check], dir, {});
    assert.ok(first.passed, 'Expected the first drain run to pass');
    assert.strictEqual(sentinelRuns(sentinel), 1, 'Expected the suite to actually run once');
    assert.ok(fs.existsSync(testAllMemoPath(dir)), 'Expected the green run to seed the memo');

    const second = runMilestoneOnlyChecks([check], dir, {});
    assert.ok(second.passed, 'Expected the memo-covered run to pass');
    assert.strictEqual(sentinelRuns(sentinel), 1, 'Expected the memo hit to skip the second execution');
  });
});

await test('drain: memo seeded by the drain is honoured by the final gate (cross-consumer)', async () => {
  const dir = makeGitProject();
  await withSentinelSuite((sentinel, command) => {
    runMilestoneOnlyChecks([{ name: 'full suite', command }], dir, {});
    assert.strictEqual(sentinelRuns(sentinel), 1);
    // Non-default testAllCommand arms the final gate without a package.json probe.
    let calls = 0;
    const spy = () => { calls++; return { exitCode: 0, output: '' }; };
    runFinalTestGate(dir, {}, { runFullTestSuite: spy });
    assert.strictEqual(calls, 0, 'Expected the final gate to reuse the drain-seeded memo');
  });
});

await test('drain: a tree change invalidates the drain memo', async () => {
  const dir = makeGitProject();
  await withSentinelSuite((sentinel, command) => {
    const check = { name: 'full suite', command };
    runMilestoneOnlyChecks([check], dir, {});
    fs.writeFileSync(path.join(dir, 'edit.txt'), 'remediation\n', 'utf8');
    runMilestoneOnlyChecks([check], dir, {});
    assert.strictEqual(sentinelRuns(sentinel), 2, 'Expected the changed tree to force a re-run');
  });
});

await test('drain: a red full-suite check fails and does not seed the memo', async () => {
  const dir = makeGitProject();
  const prev = config.execution.testAllCommand;
  config.execution.testAllCommand = 'node -e "process.exit(1)"';
  try {
    const result = runMilestoneOnlyChecks(
      [{ name: 'full suite red', command: config.execution.testAllCommand }], dir, {});
    assert.ok(!result.passed, 'Expected the red check to fail');
    assert.ok(!fs.existsSync(testAllMemoPath(dir)), 'Expected no memo after a red run');
  } finally {
    config.execution.testAllCommand = prev;
  }
});

await test('drain: non-full-suite checks execute regardless of the memo', async () => {
  const dir = makeGitProject();
  await withSentinelSuite((sentinel, command) => {
    // Seed a memo via the full-suite check, then run an unrelated check.
    runMilestoneOnlyChecks([{ name: 'full suite', command }], dir, {});
    const otherSentinel = path.join(path.dirname(sentinel), 'other.txt');
    const other = {
      name: 'unrelated check',
      command: `node -e 'require("fs").appendFileSync(${JSON.stringify(otherSentinel)}, "x")'`,
    };
    const result = runMilestoneOnlyChecks([other], dir, {});
    assert.ok(result.passed);
    assert.strictEqual(sentinelRuns(otherSentinel), 1, 'Expected the unrelated check to actually execute');
  });
});

cleanupAll();
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
