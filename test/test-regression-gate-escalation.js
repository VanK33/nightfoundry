/**
 * test-regression-gate-escalation.js — Regression-gate verifier escalation.
 *
 * The Verifier's one-shot escalation (re-run on a stronger model when attempt-1
 * is schema-invalid or a stub) previously ran ONLY for per-task callers
 * (verifyTask). Regression-gate callers (verifyRegression — the synthetic
 * `regression-*` gate ids from gates/regression.js) were excluded and
 * fail-closed directly. The fix under test enables escalation for regression-
 * gate callers too, under the SAME findings-extended schema the regression
 * caller uses (regressionVerifierSchema), not the plain per-task verifierSchema.
 *
 * No Claude auth, no live sessions. sessionManager.spawn is mocked to return a
 * scripted { handle, result } per call (first schema-invalid, second
 * controllable), and each spawn's options (name/model/jsonSchema) are captured
 * so the escalated spawn can be asserted.
 *
 * Harness mirrors test/test-verifier-escalation.js (the direct precedent).
 *
 * Run: node test/test-regression-gate-escalation.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import config from '../src/orchestrator/infra/config.js';
import { verifierSchema, regressionVerifierSchema } from '../src/orchestrator/agents/_schemas.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'regression-gate-escalation-'));
}
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

// ── Fixtures ──────────────────────────────────────────────────────────────────
//
// extractVerdict validates every verdict against verifierSchema (the shared
// base), so the regression path's schema-invalidity is expressed with the same
// malformation as the per-task path: a PASSED verdict missing the required
// back_reference_check field.

function schemaInvalidPassedOutput() {
  return {
    result: 'PASSED',
    hardChecks: [{ name: 'check', status: 'PASS', evidence: 'ok' }],
    taskScopeChecks: [{ description: 'scope', status: 'PASS', evidence: 'ok' }],
    standardsChecks: [],
    notes: '',
    // back_reference_check intentionally OMITTED -> schema validation fails
  };
}

function schemaInvalidDoubleEncodedOutput() {
  return {
    result: 'PASSED',
    hardChecks: JSON.stringify([{ name: 'check', status: 'PASS', evidence: 'ok' }]),
    taskScopeChecks: [{ description: 'scope', status: 'PASS', evidence: 'ok' }],
    standardsChecks: [],
    back_reference_check: { spec_consulted: true, plan_consulted: true, deviations: [] },
    notes: '',
  };
}

function schemaValidPassedOutput() {
  return {
    result: 'PASSED',
    hardChecks: [{ name: 'check', status: 'PASS', evidence: 'ok' }],
    taskScopeChecks: [{ description: 'scope', status: 'PASS', evidence: 'ok' }],
    standardsChecks: [],
    back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
    findings: [],
    notes: '',
  };
}

// ── Mock setup (mirrors test-verifier-escalation.js makeMockSetup) ─────────────
//
// spawn returns a thenable resolving to { handle, result }, exposing `.handle`
// synchronously (verifyRegression reads spawnPromise.handle before awaiting).
// Each call captures its spawnOpts and pulls the next sdkResult from `outputs`.
function makeMockSetup({ outputs, readFiles }) {
  const spawnSpy = { calls: [] };
  const warnSpy = { calls: [] };
  const recordSpy = { calls: [] };
  const summarySpy = { calls: [] };
  const discardSpy = { calls: [] };

  const makeHandle = (idx) => ({
    _readFiles: readFiles,
    _toolCallCount: idx + 1,
    systemPromptTokens: (idx + 1) * 10,
  });

  const sessionManager = {
    spawn: (spawnOpts) => {
      const idx = spawnSpy.calls.length;
      spawnSpy.calls.push(spawnOpts);
      const handle = makeHandle(idx);
      const out = outputs[idx];
      const sdkResult = out !== undefined ? { structured_output: out } : {};
      const spawnResult = { handle, result: sdkResult };
      const thenable = Object.assign(Promise.resolve(spawnResult), { handle });
      return thenable;
    },
  };

  const logger = {
    createSessionLog: (name) => ({ logPath: `/tmp/test-regression-escalation-${name}.log`, close: () => {} }),
    attachToSession: () => {},
    warn: (msg) => { warnSpy.calls.push(msg); },
    writeSessionSummary: async (name) => { summarySpy.calls.push(name); },
    getSessionSummary: () => '',
  };

  const tokenTracker = {
    recordSession: async (name, role, sdkResult, meta) => {
      recordSpy.calls.push({ name, role, meta });
    },
    discardInFlight: (name) => { discardSpy.calls.push(name); },
  };

  return { sessionManager, logger, tokenTracker, spawnSpy, warnSpy, recordSpy, summarySpy, discardSpy };
}

// Sanity: the two schemas must be DISTINCT objects, and the regression one must
// be the findings-extended one — otherwise C1's identity assertion is vacuous.
await test('SANITY: regressionVerifierSchema !== verifierSchema and carries findings', async () => {
  assert.notStrictEqual(regressionVerifierSchema, verifierSchema, 'the two schemas must be distinct objects');
  assert.ok(regressionVerifierSchema.properties && regressionVerifierSchema.properties.findings,
    'regressionVerifierSchema must be the findings-extended schema (has properties.findings)');
  assert.ok(!(verifierSchema.properties && verifierSchema.properties.findings),
    'plain verifierSchema must NOT carry a findings property');
});

// ── C1 — regression schema-invalid attempt-1 escalates exactly once, under the
//         regression (findings-extended) schema, on the escalation model ───────

await test('C1: verifyRegression schema-invalid attempt-1 → exactly one escalated spawn on escalation model with the regression schema', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    fs.mkdirSync(path.join(projectRoot, '.harness'), { recursive: true });
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    // attempt-1 schema-invalid → escalation; escalated returns valid PASSED.
    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      outputs: [schemaInvalidPassedOutput(), schemaValidPassedOutput()],
      readFiles: [specPath],
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'regression-milestone-001', description: 'milestone gate', targetFiles: [] };

    await verifier.verifyRegression(task, projectRoot, { specPath });

    // Exactly one escalation → two spawns. Discriminates the pre-fix
    // allowEscalation:false state (which would be one spawn, no escalation).
    assert.strictEqual(spawnSpy.calls.length, 2,
      `regression schema-invalid attempt-1 must escalate exactly once (two spawns), got ${spawnSpy.calls.length}`);

    // Escalated spawn identity: name, model.
    assert.strictEqual(spawnSpy.calls[1].name, 'verifier-regression-milestone-001-escalated',
      `escalated spawn name must be 'verifier-regression-milestone-001-escalated', got ${spawnSpy.calls[1].name}`);
    assert.strictEqual(spawnSpy.calls[1].model, config.execution.verifierEscalationModel,
      `escalated spawn model must equal config.execution.verifierEscalationModel (${config.execution.verifierEscalationModel}), got ${spawnSpy.calls[1].model}`);

    // Schema clause: the escalated spawn's jsonSchema must be the SAME object the
    // regression caller uses (regressionVerifierSchema — findings-extended), NOT
    // the plain per-task verifierSchema. Fails if the escalation hardcodes
    // verifierSchema instead of opts.jsonSchema.
    assert.strictEqual(spawnSpy.calls[1].jsonSchema, regressionVerifierSchema,
      'escalated spawn jsonSchema must be the SAME object as regressionVerifierSchema (not the plain verifierSchema)');
    assert.notStrictEqual(spawnSpy.calls[1].jsonSchema, verifierSchema,
      'escalated spawn jsonSchema must NOT be the plain per-task verifierSchema');
    assert.ok(spawnSpy.calls[1].jsonSchema.properties && spawnSpy.calls[1].jsonSchema.properties.findings,
      'escalated spawn jsonSchema must be the findings-extended regression schema (has properties.findings)');

    // Sanity: attempt-1 also carried the regression schema (both spawns use opts.jsonSchema).
    assert.strictEqual(spawnSpy.calls[0].jsonSchema, regressionVerifierSchema,
      'attempt-1 spawn jsonSchema must be regressionVerifierSchema');
  } finally {
    cleanup(projectRoot);
  }
});

// ── C2 — escalated valid PASSED → gate passes (verified true, no fail-close) ───

await test('C2: escalated valid PASSED verdict makes verifyRegression pass (verified true)', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    fs.mkdirSync(path.join(projectRoot, '.harness'), { recursive: true });
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      outputs: [schemaInvalidPassedOutput(), schemaValidPassedOutput()],
      readFiles: [specPath],
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'regression-mission-002', description: 'mission gate', targetFiles: [] };

    const verdict = await verifier.verifyRegression(task, projectRoot, { specPath });

    // The escalated valid verdict is used downstream — no fail-close. Discriminates
    // pre-fix (which fail-closes attempt-1 to verified:false directly).
    assert.strictEqual(verdict.verified, true,
      'final verdict must be verified (the escalated valid PASSED), not the fail-closed attempt-1');
    assert.strictEqual(verdict.structured.result, 'PASSED',
      'final verdict result must be PASSED from the escalated valid verdict');
    assert.ok(!verdict.schemaInvalid,
      `final (escalated) verdict must NOT carry a truthy schemaInvalid, got ${verdict.schemaInvalid}`);
    // Exactly one escalation.
    assert.strictEqual(spawnSpy.calls.length, 2,
      `expected exactly one escalation (two spawns), got ${spawnSpy.calls.length}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ── C3 — escalated verdict ALSO schema-invalid → fail-close stands, once only ──

await test('C3: both verdicts schema-invalid → fail-closed stands and escalation fires exactly once', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    fs.mkdirSync(path.join(projectRoot, '.harness'), { recursive: true });
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    // Both attempts schema-invalid.
    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      outputs: [schemaInvalidPassedOutput(), schemaInvalidDoubleEncodedOutput()],
      readFiles: [specPath],
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'regression-milestone-003', description: 'milestone gate', targetFiles: [] };

    const verdict = await verifier.verifyRegression(task, projectRoot, { specPath });

    // Escalation fires once even when it also fails — no third spawn.
    assert.strictEqual(spawnSpy.calls.length, 2,
      `escalation must fire exactly once even when it also fails (two spawns), got ${spawnSpy.calls.length}`);
    // The fail-closed verdict stands.
    assert.strictEqual(verdict.verified, false,
      'final verdict must be fail-closed (verified false) when both verdicts are schema-invalid');
    assert.strictEqual(verdict.structured.result, 'FAILED',
      'final verdict result must be FAILED when both verdicts are schema-invalid');
  } finally {
    cleanup(projectRoot);
  }
});

// ── C4 (regression guard) — verifyTask escalation still uses the plain schema ──

await test('C4 (guard): verifyTask escalated spawn still carries the plain verifierSchema', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    fs.mkdirSync(path.join(projectRoot, '.harness'), { recursive: true });
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      outputs: [schemaInvalidPassedOutput(), schemaValidPassedOutput()],
      readFiles: [specPath],
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'c4-per-task', description: 'per-task', targetFiles: [] };

    await verifier.verifyTask(task, projectRoot, { specPath });

    assert.strictEqual(spawnSpy.calls.length, 2,
      `verifyTask schema-invalid attempt-1 must still escalate (two spawns), got ${spawnSpy.calls.length}`);
    // Per-task escalation carries the PLAIN verifierSchema — unchanged by the fix.
    assert.strictEqual(spawnSpy.calls[1].jsonSchema, verifierSchema,
      'verifyTask escalated spawn jsonSchema must be the plain verifierSchema');
    assert.notStrictEqual(spawnSpy.calls[1].jsonSchema, regressionVerifierSchema,
      'verifyTask escalated spawn jsonSchema must NOT be the regression (findings-extended) schema');
  } finally {
    cleanup(projectRoot);
  }
});

// ── C5 (regression guard) — valid attempt-1 regression verdict: NO escalation ──

await test('C5 (guard): verifyRegression with a VALID attempt-1 verdict spawns NO escalation', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    fs.mkdirSync(path.join(projectRoot, '.harness'), { recursive: true });
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    // A second output is provided to prove escalation would have material to pick,
    // yet it must NOT fire because attempt-1 is already valid.
    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      outputs: [schemaValidPassedOutput(), schemaValidPassedOutput()],
      readFiles: [specPath],
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'regression-milestone-005', description: 'milestone gate', targetFiles: [] };

    const verdict = await verifier.verifyRegression(task, projectRoot, { specPath });

    assert.strictEqual(spawnSpy.calls.length, 1,
      `a valid attempt-1 verdict must NOT escalate — spawn exactly once, got ${spawnSpy.calls.length}`);
    assert.strictEqual(verdict.verified, true,
      'a valid attempt-1 PASSED regression verdict must stay verified');
    assert.strictEqual(verdict.structured.result, 'PASSED',
      'a valid attempt-1 PASSED regression verdict result must be PASSED');
  } finally {
    cleanup(projectRoot);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
