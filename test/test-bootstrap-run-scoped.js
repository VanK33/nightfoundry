/**
 * test-bootstrap-run-scoped.js — Unit tests for bootstrap()'s run-scoped
 * (opts.runId) behavior: per-run harness dirs under .harness/{runId}/,
 * shared subdirs under the flat .harness/ root, and disjointness between
 * runs and the no-runId flat layout.
 *
 * No Claude auth, no SDK. Pure fs + temp directories.
 * Run: node test/test-bootstrap-run-scoped.js
 *
 * This suite is NOT a re-entrant cc-orch invocation — every fixture root is
 * an isolated fs.mkdtemp() directory. But when this file is launched from
 * inside a live cc-orch run (e.g. a spawned test-gate that runs this file
 * directly rather than through scripts/run-tests.js), CC_ORCH_ACTIVE_RUN is
 * inherited from the parent process environment and would trip
 * assertNoReentrantLiveRun's guard on any fixture root that carries an
 * active state.json — a false positive on the sanctioned mkdtemp pattern
 * (see reentrancy-guard.js). Clear the marker unconditionally here,
 * mirroring scripts/run-tests.js, so this file is re-entrancy-neutral
 * regardless of launch context.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { bootstrap, PER_RUN_SUBDIRS, SHARED_SUBDIRS } from '../src/orchestrator/core/bootstrap.js';

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

function assertThrows(fn, pattern, msg) {
  let thrown;
  try { fn(); } catch (e) { thrown = e; }
  if (!thrown) throw new Error(msg || 'Expected function to throw');
  if (pattern && !pattern.test(thrown.message)) {
    throw new Error(`${msg || 'Throw pattern mismatch'}. Got: ${thrown.message}`);
  }
}

function createProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-run-scoped-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const ALL_SUBDIRS = Array.from(new Set([...PER_RUN_SUBDIRS, ...SHARED_SUBDIRS]));
const WIPE_SUBDIRS_ON_FORCE = [
  'state', 'plan', 'verify', 'progress', 'verification', 'analysis', 'snapshots',
];

// ---------- TC-a: runId call creates run-scoped layout, no flat state.json ----------

test('TC-a: bootstrap(root, {runId}) creates .harness/{runId}/state.json and 8 per-run subdirs inside, 3 shared subdirs at .harness/, no flat state.json', () => {
  const root = createProjectRoot();
  try {
    const runId = 'run-a';
    const { harnessDir, stateJsonPath } = bootstrap(root, { runId });

    assert.equal(harnessDir, path.join(root, '.harness', runId));
    assert.equal(stateJsonPath, path.join(root, '.harness', runId, 'state.json'));
    assert.ok(fs.existsSync(stateJsonPath), 'run-scoped state.json should exist');

    assert.equal(PER_RUN_SUBDIRS.length, 8, 'expected 8 PER_RUN_SUBDIRS');
    for (const sub of PER_RUN_SUBDIRS) {
      assert.ok(
        fs.existsSync(path.join(root, '.harness', runId, sub)),
        `.harness/${runId}/${sub}/ should exist`
      );
    }

    for (const sub of SHARED_SUBDIRS) {
      assert.ok(
        fs.existsSync(path.join(root, '.harness', sub)),
        `.harness/${sub}/ (shared) should exist directly under .harness/`
      );
    }

    assert.ok(
      !fs.existsSync(path.join(root, '.harness', 'state.json')),
      'flat .harness/state.json should NOT exist when runId is used'
    );
  } finally { cleanup(root); }
});

// ---------- TC-b: no-runId flat layout, all 11 SUBDIRS, no-force throws ----------

test('TC-b: bootstrap(root) with no runId writes flat .harness/state.json plus all 11 subdirs; second no-force call throws', () => {
  const root = createProjectRoot();
  try {
    const { harnessDir, stateJsonPath } = bootstrap(root);

    assert.equal(harnessDir, path.join(root, '.harness'));
    assert.equal(stateJsonPath, path.join(root, '.harness', 'state.json'));
    assert.ok(fs.existsSync(stateJsonPath), 'flat state.json should exist');

    assert.equal(ALL_SUBDIRS.length, 11, 'union of PER_RUN_SUBDIRS and SHARED_SUBDIRS should be 11');
    for (const sub of ALL_SUBDIRS) {
      assert.ok(
        fs.existsSync(path.join(harnessDir, sub)),
        `.harness/${sub}/ should exist`
      );
    }

    assertThrows(
      () => bootstrap(root),
      /already exists/,
      'second no-force bootstrap(root) should throw'
    );
  } finally { cleanup(root); }
});

// ---------- TC-c: two runIds produce disjoint dirs ----------

test('TC-c: bootstrap(root, {runId: run-a}) and bootstrap(root, {runId: run-b}) produce disjoint dirs, each with own state.json, undisturbed by the other and by shared dirs', () => {
  const root = createProjectRoot();
  try {
    const resA = bootstrap(root, { runId: 'run-a' });
    const resB = bootstrap(root, { runId: 'run-b' });

    assert.notEqual(resA.harnessDir, resB.harnessDir, 'run-a and run-b harness dirs should differ');
    assert.ok(fs.existsSync(resA.stateJsonPath), 'run-a state.json should exist');
    assert.ok(fs.existsSync(resB.stateJsonPath), 'run-b state.json should exist');

    for (const sub of PER_RUN_SUBDIRS) {
      assert.ok(fs.existsSync(path.join(root, '.harness', 'run-a', sub)), `run-a/${sub}/ should exist`);
      assert.ok(fs.existsSync(path.join(root, '.harness', 'run-b', sub)), `run-b/${sub}/ should exist`);
    }

    for (const sub of SHARED_SUBDIRS) {
      assert.ok(fs.existsSync(path.join(root, '.harness', sub)), `shared .harness/${sub}/ should exist`);
    }

    // run-b's bootstrap should not have wiped or otherwise disturbed run-a's dir tree.
    assert.ok(fs.existsSync(path.join(root, '.harness', 'run-a', 'state.json')), 'run-a state.json survives run-b bootstrap');
  } finally { cleanup(root); }
});

// ---------- TC-d: force=true with runId wipes only that run's 7 wipe-subdirs ----------

test('TC-d: force=true with runId wipes 7 stateful subdirs inside that run dir only, preserves its logs/, leaves other run and shared dirs untouched', () => {
  const root = createProjectRoot();
  try {
    bootstrap(root, { runId: 'run-a' });
    bootstrap(root, { runId: 'run-b' });

    const runADir = path.join(root, '.harness', 'run-a');
    const runBDir = path.join(root, '.harness', 'run-b');
    const sharedDir = path.join(root, '.harness');

    // Seed every PER_RUN_SUBDIR of run-a.
    for (const sub of PER_RUN_SUBDIRS) {
      fs.writeFileSync(path.join(runADir, sub, 'seed.txt'), `run-a seed ${sub}`);
    }

    // Seed run-b's subdirs too.
    for (const sub of PER_RUN_SUBDIRS) {
      fs.writeFileSync(path.join(runBDir, sub, 'seed.txt'), `run-b seed ${sub}`);
    }

    // Seed shared dirs.
    for (const sub of SHARED_SUBDIRS) {
      fs.writeFileSync(path.join(sharedDir, sub, 'seed.txt'), `shared seed ${sub}`);
    }

    bootstrap(root, { runId: 'run-a', force: true });

    // The 7 wipe-subdirs inside run-a/ are now empty.
    for (const sub of WIPE_SUBDIRS_ON_FORCE) {
      const dir = path.join(runADir, sub);
      assert.ok(fs.existsSync(dir), `run-a/${sub}/ should be re-created`);
      assert.equal(
        fs.readdirSync(dir).length,
        0,
        `run-a/${sub}/ should be empty after force bootstrap, got: ${JSON.stringify(fs.readdirSync(dir))}`
      );
    }

    // run-a's logs/ content is preserved (not in the wipe set).
    assert.ok(
      fs.existsSync(path.join(runADir, 'logs', 'seed.txt')),
      'run-a/logs/ seeded content should survive force bootstrap'
    );
    assert.equal(
      fs.readFileSync(path.join(runADir, 'logs', 'seed.txt'), 'utf8'),
      'run-a seed logs'
    );

    // run-b's seeded files are untouched.
    for (const sub of PER_RUN_SUBDIRS) {
      assert.ok(
        fs.existsSync(path.join(runBDir, sub, 'seed.txt')),
        `run-b/${sub}/seed.txt should survive run-a's force bootstrap`
      );
      assert.equal(
        fs.readFileSync(path.join(runBDir, sub, 'seed.txt'), 'utf8'),
        `run-b seed ${sub}`
      );
    }

    // Shared dirs' seeded content is untouched.
    for (const sub of SHARED_SUBDIRS) {
      assert.ok(
        fs.existsSync(path.join(sharedDir, sub, 'seed.txt')),
        `shared .harness/${sub}/seed.txt should survive run-a's force bootstrap`
      );
      assert.equal(
        fs.readFileSync(path.join(sharedDir, sub, 'seed.txt'), 'utf8'),
        `shared seed ${sub}`
      );
    }
  } finally { cleanup(root); }
});

// ---------- TC-e: alreadyExisted keying per runId ----------

test('TC-e: alreadyExisted is false on first bootstrap(root,{runId}) call and true on second force call for the same runId', () => {
  const root = createProjectRoot();
  try {
    const runId = 'run-a';
    const first = bootstrap(root, { runId });
    assert.equal(first.alreadyExisted, false, 'first call should report alreadyExisted=false');

    const second = bootstrap(root, { runId, force: true });
    assert.equal(second.alreadyExisted, true, 'second call should report alreadyExisted=true');
  } finally { cleanup(root); }
});

// ---------- TC-f: return shape ----------

test('TC-f: returned {harnessDir, stateJsonPath} equal path.join(root,.harness,runId) and .../state.json', () => {
  const root = createProjectRoot();
  try {
    const runId = 'run-a';
    const { harnessDir, stateJsonPath } = bootstrap(root, { runId });
    assert.equal(harnessDir, path.join(root, '.harness', runId));
    assert.equal(stateJsonPath, path.join(root, '.harness', runId, 'state.json'));
  } finally { cleanup(root); }
});

// ---------- TC-g: state.json shape identical in both modes ----------

test('TC-g: state.json written in runId mode and no-runId mode have identical projectMeta key shape, globalStatus, and milestones', () => {
  const rootRun = createProjectRoot();
  const rootFlat = createProjectRoot();
  try {
    const { stateJsonPath: runStatePath } = bootstrap(rootRun, { runId: 'run-a' });
    const { stateJsonPath: flatStatePath } = bootstrap(rootFlat);

    const runState = JSON.parse(fs.readFileSync(runStatePath, 'utf8'));
    const flatState = JSON.parse(fs.readFileSync(flatStatePath, 'utf8'));

    const expectedKeys = ['prdPath', 'createdAt', 'createdWithVersion', 'currentPhase'].sort();
    assert.deepEqual(Object.keys(runState.projectMeta).sort(), expectedKeys, 'run-mode projectMeta key shape');
    assert.deepEqual(Object.keys(flatState.projectMeta).sort(), expectedKeys, 'flat-mode projectMeta key shape');

    assert.equal(runState.globalStatus, 'active');
    assert.equal(flatState.globalStatus, 'active');

    assert.deepEqual(runState.milestones, {});
    assert.deepEqual(flatState.milestones, {});
  } finally {
    cleanup(rootRun);
    cleanup(rootFlat);
  }
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
