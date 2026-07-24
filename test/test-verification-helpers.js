/**
 * test-verification-helpers.js — Unit tests for the extracted, stateless
 * verification-gate helpers in src/orchestrator/core/verification-helpers.js.
 *
 * These tests import { parseVerificationSidecar, recordGateOverride,
 * runTestRegistrationGate } DIRECTLY from the helpers module (never via
 * Pipeline), and pin the degenerate-input parity captured from the current
 * Pipeline._X behavior (see test/test-gate-external-project.js for the
 * sibling Pipeline-driven suite covering the same behaviors):
 *
 *  - parseVerificationSidecar: null when no sidecar exists for the task,
 *    null (no throw) on corrupt/invalid JSON, and the parsed object for a
 *    well-formed sidecar.
 *  - recordGateOverride: fail-soft when the sidecar is absent (no throw, no
 *    file created); appends { gate, evidence, at: ISO } to gateOverrides
 *    while preserving existing fields when the sidecar is valid.
 *  - runTestRegistrationGate: on a projectRoot without scripts/run-tests.js
 *    returns { passed:true, violations:[], notApplicable:true } and logs a
 *    line containing 'not applicable' via the onLog callback.
 *
 * Run: node test/test-verification-helpers.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  parseVerificationSidecar,
  recordGateOverride,
  runTestRegistrationGate,
} from '../src/orchestrator/core/verification-helpers.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** mkdtemp harnessDir with a verification/ subdir. */
function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verif-helpers-'));
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  return { root, harnessDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** mkdtemp project root; optionally write scripts/run-tests.js with raw content. */
function makeRoot(manifestContent /* string | null */) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verif-helpers-proj-'));
  if (manifestContent !== null) {
    const scriptsDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'run-tests.js'), manifestContent, 'utf8');
  }
  return { projectRoot: tmpDir, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

function sidecarPathFor(harnessDir, taskId) {
  return path.join(harnessDir, 'verification', `task-${taskId}.json`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TC1: parseVerificationSidecar — no sidecar for the task → null
// ─────────────────────────────────────────────────────────────────────────────
await test('TC1: parseVerificationSidecar returns null when no sidecar exists for the task', async () => {
  const { harnessDir, cleanup } = makeHarness();
  const taskId = '001-001-001-001';
  try {
    // Deliberately no sidecar written for this taskId.
    const result = parseVerificationSidecar(harnessDir, taskId);
    assert.strictEqual(result, null, `Expected null, got: ${JSON.stringify(result)}`);
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC2: parseVerificationSidecar — corrupt/invalid JSON → null (no throw)
// ─────────────────────────────────────────────────────────────────────────────
await test('TC2: parseVerificationSidecar returns null (no throw) on invalid JSON sidecar', async () => {
  const { harnessDir, cleanup } = makeHarness();
  const taskId = '001-001-001-002';
  const p = sidecarPathFor(harnessDir, taskId);
  try {
    fs.writeFileSync(p, '{ this is not valid JSON !!!', 'utf8');
    const result = parseVerificationSidecar(harnessDir, taskId);
    assert.strictEqual(result, null, `Expected null on corrupt JSON, got: ${JSON.stringify(result)}`);
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC3: parseVerificationSidecar — well-formed sidecar → parsed object
// ─────────────────────────────────────────────────────────────────────────────
await test('TC3: parseVerificationSidecar returns the parsed object for a well-formed sidecar', async () => {
  const { harnessDir, cleanup } = makeHarness();
  const taskId = '001-001-001-003';
  const p = sidecarPathFor(harnessDir, taskId);
  const payload = { taskId, result: 'PASSED', hardChecks: [{ name: 'x', status: 'PASS' }] };
  try {
    fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
    const result = parseVerificationSidecar(harnessDir, taskId);
    assert.deepStrictEqual(result, payload, `Expected parsed sidecar object, got: ${JSON.stringify(result)}`);
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC4: recordGateOverride — absent sidecar → fail-soft, no throw, no file created
// ─────────────────────────────────────────────────────────────────────────────
await test('TC4: recordGateOverride against an absent sidecar neither throws nor creates the file', async () => {
  const { harnessDir, cleanup } = makeHarness();
  const taskId = '001-001-001-004';
  const p = sidecarPathFor(harnessDir, taskId);
  try {
    assert.strictEqual(fs.existsSync(p), false, 'Sanity check: sidecar must not pre-exist');
    // Must not throw.
    recordGateOverride(harnessDir, taskId, 'test-registration-gate', 'evidence');
    assert.strictEqual(fs.existsSync(p), false,
      'recordGateOverride must not create verification/task-<id>.json when the sidecar was absent');
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC5: recordGateOverride — existing valid sidecar → appends entry, preserves fields
// ─────────────────────────────────────────────────────────────────────────────
await test('TC5: recordGateOverride against an existing sidecar appends {gate, evidence, at} and preserves existing fields', async () => {
  const { harnessDir, cleanup } = makeHarness();
  const taskId = '001-001-001-005';
  const p = sidecarPathFor(harnessDir, taskId);
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
  try {
    fs.writeFileSync(p, JSON.stringify({ result: 'PASSED' }), 'utf8');

    recordGateOverride(harnessDir, taskId, 'test-registration-gate', 'some evidence');

    const sidecar = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(sidecar.result, 'PASSED',
      `Existing sidecar fields must be preserved; got: ${JSON.stringify(sidecar)}`);
    assert.ok(Array.isArray(sidecar.gateOverrides),
      `Expected gateOverrides array, got: ${JSON.stringify(sidecar.gateOverrides)}`);
    assert.strictEqual(sidecar.gateOverrides.length, 1,
      `Expected 1 override entry, got: ${JSON.stringify(sidecar.gateOverrides)}`);

    const entry = sidecar.gateOverrides[0];
    assert.strictEqual(entry.gate, 'test-registration-gate', `entry.gate mismatch: ${JSON.stringify(entry)}`);
    assert.strictEqual(entry.evidence, 'some evidence', `entry.evidence mismatch: ${JSON.stringify(entry)}`);
    assert.strictEqual(typeof entry.at, 'string', `entry.at must be a string, got: ${JSON.stringify(entry.at)}`);
    assert.ok(ISO_RE.test(entry.at) && !Number.isNaN(Date.parse(entry.at)),
      `entry.at must be an ISO timestamp string, got: ${entry.at}`);
  } finally {
    cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC6 & TC7: runTestRegistrationGate — no-manifest project → notApplicable pass
//            + onLog line containing 'not applicable'
// ─────────────────────────────────────────────────────────────────────────────
await test('TC6+TC7: runTestRegistrationGate on a projectRoot without scripts/run-tests.js returns notApplicable:true and logs "not applicable"', async () => {
  const { harnessDir, cleanup: cleanupHarness } = makeHarness();
  const { projectRoot, cleanup: cleanupRoot } = makeRoot(null); // NO scripts/ dir
  const logs = [];
  const onLog = (m) => logs.push(m);
  const task = { id: '001-001-001-006', targetFiles: ['test/test-foo.js'] };
  try {
    const result = await runTestRegistrationGate(task, harnessDir, projectRoot, onLog);

    assert.deepStrictEqual(result, { passed: true, violations: [], notApplicable: true },
      `Expected {passed:true, violations:[], notApplicable:true}, got: ${JSON.stringify(result)}`);

    assert.ok(logs.some((l) => /not applicable/i.test(l)),
      `Expected an onLog line containing 'not applicable', got: ${JSON.stringify(logs)}`);
  } finally {
    cleanupHarness();
    cleanupRoot();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
