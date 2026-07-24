/**
 * test-make-run.js — Unit tests for the test/helpers/make-run.js makeRun()
 * helper: return shape, runId format, per-run state.json creation, active-run
 * pointer claiming (default claim:true), and claim:false leaving the pointer
 * unclaimed.
 *
 * No Claude auth, no SDK. Pure fs + temp directories.
 * Run: node test/test-make-run.js
 *
 * This suite is NOT a re-entrant cc-orch invocation — every fixture root is
 * an isolated fs.mkdtemp() directory. But when this file is launched from
 * inside a live cc-orch run, CC_ORCH_ACTIVE_RUN is inherited from the parent
 * process environment and would trip assertNoReentrantLiveRun's guard on any
 * fixture root that carries an active state.json — a false positive on the
 * sanctioned mkdtemp pattern (see reentrancy-guard.js). Clear the marker
 * unconditionally here, mirroring scripts/run-tests.js and
 * test/test-bootstrap-run-scoped.js, so this file is re-entrancy-neutral
 * regardless of launch context.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { makeRun } from './helpers/make-run.js';
import { readActiveRunPointer, resolveActiveHarnessDir } from '../src/orchestrator/core/run-context.js';

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

function createProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'make-run-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- TC1: return shape + runId format + per-run state.json exists ----------

test('TC1: makeRun(root, {slug, kind}) returns {runId, harnessDir}, runId starts with run- and includes slug, harnessDir/state.json exists', () => {
  const root = createProjectRoot();
  try {
    const { runId, harnessDir } = makeRun(root, { slug: 'demo', kind: 'run' });

    assert.equal(harnessDir, path.join(root, '.harness', runId));
    assert.ok(runId.startsWith('run-'), `runId should start with 'run-', got: ${runId}`);
    assert.ok(runId.includes('demo'), `runId should include 'demo', got: ${runId}`);
    assert.ok(
      fs.existsSync(path.join(harnessDir, 'state.json')),
      'harnessDir/state.json should exist'
    );
  } finally { cleanup(root); }
});

// ---------- TC2: claim:true writes the pointer ----------

test('TC2: with default claim:true, readActiveRunPointer(root).runId === runId and resolveActiveHarnessDir(root) === harnessDir', () => {
  const root = createProjectRoot();
  try {
    const { runId, harnessDir } = makeRun(root, { slug: 'demo', kind: 'run' });

    const pointer = readActiveRunPointer(root);
    assert.ok(pointer, 'active-run pointer should be readable');
    assert.equal(pointer.runId, runId);

    assert.equal(resolveActiveHarnessDir(root), harnessDir);
  } finally { cleanup(root); }
});

// ---------- TC3: claim:false creates the run dir but leaves the pointer null ----------

test('TC3: makeRun(root, {slug, kind, claim:false}) creates the run dir but readActiveRunPointer(root) is null', () => {
  const root = createProjectRoot();
  try {
    const { harnessDir } = makeRun(root, { slug: 'demo', kind: 'run', claim: false });

    assert.ok(fs.existsSync(harnessDir), 'harnessDir should exist even without claiming');
    assert.ok(
      fs.existsSync(path.join(harnessDir, 'state.json')),
      'harnessDir/state.json should exist even without claiming'
    );
    assert.equal(readActiveRunPointer(root), null, 'no pointer should be written when claim:false');
  } finally { cleanup(root); }
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
