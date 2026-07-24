/**
 * test-verifier-escalation.js — Verifier schema-invalid escalation tests.
 *
 * Two real false-RED failures motivate this hardening:
 *   - "050": verifier emitted a SCHEMA-INVALID verdict (double-encoded the
 *     hardChecks array as a JSON string). Work was correct (result PASSED,
 *     every check PASS) but the schema-invalid verdict was fail-closed to
 *     FAILED, killing correct work.
 *   - "135": verifier invented an out-of-spec acceptance criterion.
 *
 * The hardening (bound here):
 *   [1a] extractVerdict's schema-validation-failure branch additionally carries
 *        `schemaInvalid: true` (still fail-closed: result 'FAILED', verified
 *        false). The schema-VALID path carries no truthy schemaInvalid.
 *   [1b] verifyTask re-spawns the verifier EXACTLY ONCE MORE on a schemaInvalid
 *        first verdict, with model = config.execution.verifierEscalationModel,
 *        re-runs extractVerdict (firstWrite:false) on the new sdkResult, and
 *        uses the ESCALATED verdict downstream. Escalation happens at most once.
 *
 * No Claude auth, no live sessions. CASE A drives the pure extractVerdict.
 * CASE B/B2 drive the real verifyTask with a MOCK sessionManager whose `spawn`
 * returns a thenable resolving to { handle, result }, returning a different
 * sdkResult per call (first invalid, second valid / second invalid).
 *
 * Run: node test/test-verifier-escalation.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-escalation-'));
}
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

// ── Fixtures ──────────────────────────────────────────────────────────────────

// A schema-INVALID verdict that still claims result:'PASSED'. Omits the required
// back_reference_check field — the realistic 135-style malformation that fails
// schema validation while the work itself passed.
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

// The 050-style malformation: hardChecks DOUBLE-ENCODED as a JSON string rather
// than an array. Also schema-invalid while claiming PASSED.
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

// A fully schema-VALID verdict claiming PASSED.
function schemaValidPassedOutput() {
  return {
    result: 'PASSED',
    hardChecks: [{ name: 'check', status: 'PASS', evidence: 'ok' }],
    taskScopeChecks: [{ description: 'scope', status: 'PASS', evidence: 'ok' }],
    standardsChecks: [],
    back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
    notes: '',
  };
}

// ── CASE A — [1a] schemaInvalid signal (drive real extractVerdict directly) ────

await test('CASE A: schema-invalid PASSED verdict carries schemaInvalid===true and is fail-closed', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const d = tempDir();
  try {
    const verdict = extractVerdict(
      { structured_output: schemaInvalidPassedOutput() },
      'caseA-missing-brc',
      d,
      { warn: () => {} },
    );

    assert.strictEqual(verdict.schemaInvalid, true, 'schema-invalid verdict must carry schemaInvalid === true');
    assert.strictEqual(verdict.structured.result, 'FAILED', 'schema-invalid verdict must be fail-closed to FAILED');
    assert.strictEqual(verdict.verified, false, 'schema-invalid verdict must not be verified');
  } finally {
    cleanup(d);
  }
});

await test('CASE A: double-encoded hardChecks (050-style) also carries schemaInvalid===true and FAILED', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const d = tempDir();
  try {
    const verdict = extractVerdict(
      { structured_output: schemaInvalidDoubleEncodedOutput() },
      'caseA-double-encoded',
      d,
      { warn: () => {} },
    );

    assert.strictEqual(verdict.schemaInvalid, true, 'double-encoded verdict must carry schemaInvalid === true');
    assert.strictEqual(verdict.structured.result, 'FAILED', 'double-encoded verdict must be fail-closed to FAILED');
    assert.strictEqual(verdict.verified, false, 'double-encoded verdict must not be verified');
  } finally {
    cleanup(d);
  }
});

await test('CASE A: schema-VALID PASSED verdict carries NO truthy schemaInvalid (verified, PASSED)', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const d = tempDir();
  try {
    const verdict = extractVerdict(
      { structured_output: schemaValidPassedOutput() },
      'caseA-valid',
      d,
      { warn: () => {} },
    );

    assert.ok(!verdict.schemaInvalid, `schema-valid verdict must NOT carry a truthy schemaInvalid, got ${verdict.schemaInvalid}`);
    assert.strictEqual(verdict.verified, true, 'schema-valid PASSED verdict must stay verified');
    assert.strictEqual(verdict.structured.result, 'PASSED', 'schema-valid PASSED result must be preserved');
  } finally {
    cleanup(d);
  }
});

// ── Mock setup for CASE B/B2 ───────────────────────────────────────────────────
//
// sessionManager.spawn returns a thenable resolving to { handle, result }. The
// thenable also exposes `.handle` synchronously (verifyTask reads spawnPromise
// .handle for attachToSession before awaiting). Each spawn call captures its
// options (so the second call's options.model is assertable) and pulls the next
// sdkResult from `outputs` (one entry per expected spawn).
//
// `readFiles` is shared across spawns; it is set to [specPath] so the spec-read
// audit on the escalated PASSED verdict does not emit spurious not-read warns.
function makeMockSetup({ outputs, readFiles, failSpawnAt = -1 }) {
  const spawnSpy = { calls: [] };
  const warnSpy = { calls: [] };
  const recordSpy = { calls: [] };
  const summarySpy = { calls: [] };
  const discardSpy = { calls: [] };

  // A DISTINCT handle per spawn (distinct _toolCallCount / systemPromptTokens)
  // so a test can verify which session's metadata a ledger record was built
  // from — a single shared handle would mask wrong-handle attribution bugs.
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
      // Simulate a spawn-time failure (budget/transport/auth) at this index.
      // A thenable (not a real rejected Promise) so there is no dangling
      // unhandledRejection between the synchronous .handle read and the await.
      if (idx === failSpawnAt) {
        return { handle, then: (_resolve, reject) => reject(new Error('escalation spawn failed')) };
      }
      // `undefined` output entry → omit structured_output (stub path); otherwise
      // wrap the entry as the SDK result's structured_output.
      const out = outputs[idx];
      const sdkResult = out !== undefined ? { structured_output: out } : {};
      const spawnResult = { handle, result: sdkResult };
      const thenable = Object.assign(Promise.resolve(spawnResult), { handle });
      return thenable;
    },
  };

  const logger = {
    createSessionLog: (name) => ({ logPath: `/tmp/test-escalation-${name}.log`, close: () => {} }),
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

// ── CASE B — [1b] escalation path (real verifyTask, mock sessionManager) ───────

await test('CASE B: schema-invalid first verdict escalates exactly once to verifierEscalationModel and uses the valid verdict', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    // First spawn → schema-invalid PASSED (triggers escalation).
    // Second spawn → schema-valid PASSED (the escalated verdict used downstream).
    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      outputs: [schemaInvalidPassedOutput(), schemaValidPassedOutput()],
      readFiles: [specPath],
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'caseB-task', description: 'test', targetFiles: [] };

    const verdict = await verifier.verifyTask(task, projectRoot, { specPath });

    // (a) spawn called exactly TWICE (one escalation, no more).
    assert.strictEqual(spawnSpy.calls.length, 2, `spawn must be called exactly twice (one escalation), got ${spawnSpy.calls.length}`);

    // (b) the SECOND spawn used the escalation model.
    assert.strictEqual(
      spawnSpy.calls[1].model,
      config.execution.verifierEscalationModel,
      `second spawn options.model must equal config.execution.verifierEscalationModel (${config.execution.verifierEscalationModel}), got ${spawnSpy.calls[1].model}`,
    );

    // sanity: the FIRST spawn used the normal verifier model, NOT the escalation model.
    assert.strictEqual(
      spawnSpy.calls[0].model,
      config.execution.verifierModel,
      `first spawn options.model must equal config.execution.verifierModel (${config.execution.verifierModel}), got ${spawnSpy.calls[0].model}`,
    );

    // (c) the FINAL verdict reflects the VALID escalated verdict, not the malformed first.
    assert.strictEqual(verdict.verified, true, 'final verdict must be verified (the escalated valid PASSED), not the malformed first');
    assert.strictEqual(verdict.structured.result, 'PASSED', 'final verdict result must be PASSED from the escalated valid verdict');
    assert.ok(!verdict.schemaInvalid, `final (escalated) verdict must NOT carry a truthy schemaInvalid, got ${verdict.schemaInvalid}`);

    // (d) no THIRD spawn — escalation at most once (already covered by (a); explicit guard).
    assert.ok(spawnSpy.calls.length <= 2, 'escalation must happen at most once (no third spawn)');
  } finally {
    cleanup(projectRoot);
  }
});

// ── CASE B2 — both spawns schema-invalid → still exactly twice, fail-closed ────

await test('CASE B2: both verdicts schema-invalid → spawn called exactly twice and final verdict fail-closed', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    // Both spawns return schema-invalid PASSED output.
    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      outputs: [schemaInvalidPassedOutput(), schemaInvalidDoubleEncodedOutput()],
      readFiles: [specPath],
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'caseB2-task', description: 'test', targetFiles: [] };

    const verdict = await verifier.verifyTask(task, projectRoot, { specPath });

    // Still exactly two spawns — escalation fires once even when it also fails.
    assert.strictEqual(spawnSpy.calls.length, 2, `spawn must be called exactly twice even when escalation also fails, got ${spawnSpy.calls.length}`);

    // Final verdict is fail-closed (the escalated verdict is also schema-invalid).
    assert.strictEqual(verdict.verified, false, 'final verdict must be fail-closed (verified false) when both verdicts are schema-invalid');
    assert.strictEqual(verdict.structured.result, 'FAILED', 'final verdict result must be FAILED when both verdicts are schema-invalid');
  } finally {
    cleanup(projectRoot);
  }
});

// ── CASE C — regression-* tasks escalate too (enabled 2026-07-14) ─────────────
// Originally regression callers were excluded (fail-close preferred over a
// costly re-run); a systematic small-model schema flub at a live regression
// gate inverted that rationale (false FAILED → remediation churn → breaker),
// so escalation now runs for regression-* ids as well. Deep coverage (schema
// identity, fail-close when both attempts are bad) lives in
// test-regression-gate-escalation.js.

await test('CASE C: a schema-invalid regression-* verdict escalates once and uses the valid verdict', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    // First spawn → schema-invalid; second (escalated) → valid PASSED.
    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      outputs: [schemaInvalidPassedOutput(), schemaValidPassedOutput()],
      readFiles: [specPath],
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'regression-milestone-001', description: 'milestone gate', targetFiles: [] };

    const verdict = await verifier.verifyRegression(task, projectRoot, { specPath });

    assert.strictEqual(spawnSpy.calls.length, 2, `regression-* must escalate exactly once — expected 2 spawns, got ${spawnSpy.calls.length}`);
    assert.strictEqual(spawnSpy.calls[1].name, 'verifier-regression-milestone-001-escalated', 'second spawn must be the escalated session');
    assert.strictEqual(verdict.verified, true, 'escalated valid PASSED verdict must be used (gate passes)');
  } finally {
    cleanup(projectRoot);
  }
});

// ── CASE D — a no-structured-output (stub) verdict also escalates ──────────────

await test('CASE D: a no-structured-output verdict (non-regression) escalates and uses the valid verdict', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    // First spawn → NO structured_output (undefined → stub path); second → valid.
    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      outputs: [undefined, schemaValidPassedOutput()],
      readFiles: [specPath],
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'caseD-task', description: 'test', targetFiles: [] };

    const verdict = await verifier.verifyTask(task, projectRoot, { specPath });

    assert.strictEqual(spawnSpy.calls.length, 2, `empty verdict must escalate — spawn exactly twice, got ${spawnSpy.calls.length}`);
    assert.strictEqual(spawnSpy.calls[1].model, config.execution.verifierEscalationModel, 'second spawn must use the escalation model');
    assert.strictEqual(verdict.verified, true, 'final verdict must be the escalated valid PASSED');
    assert.strictEqual(verdict.structured.result, 'PASSED', 'final verdict result must be PASSED');
  } finally {
    cleanup(projectRoot);
  }
});

// ── CASE E — escalation spawn failure falls back to attempt-1 fail-closed verdict

await test('CASE E: escalation spawn failure falls back to attempt-1 verdict (no throw)', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    // First spawn → schema-invalid (triggers escalation); second spawn → FAILS.
    const { sessionManager, logger, tokenTracker, spawnSpy, recordSpy } = makeMockSetup({
      outputs: [schemaInvalidPassedOutput(), schemaValidPassedOutput()],
      readFiles: [specPath],
      failSpawnAt: 1,
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'caseE-task', description: 'test', targetFiles: [] };

    // Must NOT throw — degrades to attempt-1's fail-closed verdict.
    const verdict = await verifier.verifyTask(task, projectRoot, { specPath });

    assert.strictEqual(spawnSpy.calls.length, 2, `escalation must be attempted exactly once, got ${spawnSpy.calls.length}`);
    assert.strictEqual(verdict.verified, false, 'on escalation failure the attempt-1 fail-closed verdict (verified false) must stand');
    assert.strictEqual(verdict.structured.result, 'FAILED', 'on escalation failure the attempt-1 FAILED result must stand');

    // skipEndRecord guard: attempt-1 is recorded inline; on escalation failure the
    // end-of-function block must be skipped so attempt-1 is recorded EXACTLY ONCE
    // (no double-count) and never under the -escalated name. Without skipEndRecord
    // this would be 2 records — this is the only test that catches that mutation.
    assert.strictEqual(recordSpy.calls.length, 1, `on escalation failure attempt-1 must be recorded exactly once, got ${recordSpy.calls.length}: ${JSON.stringify(recordSpy.calls.map(c => c.name))}`);
    assert.strictEqual(recordSpy.calls[0].name, 'verifier-caseE-task', `the single record must be attempt-1's session name, got ${recordSpy.calls[0].name}`);

    // Handle is NOT reassigned on spawn failure — attempt-1 stays authoritative,
    // so the single record carries the FIRST spawn's handle metadata (toolCallCount 1).
    // (In-flight cleanup on spawn failure is now owned by session-manager, not the
    // verifier, so it is asserted in the session-manager tests, not here.)
    assert.strictEqual(recordSpy.calls[0].meta.toolCallCount, 1, `on escalation failure the record must use attempt-1's handle metadata (toolCallCount 1), got ${recordSpy.calls[0].meta.toolCallCount}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ── CASE F — both spawns are recorded under DISTINCT session names ─────────────

await test('CASE F: escalation records BOTH sessions under distinct names (no dropped/conflated ledger)', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const { sessionManager, logger, tokenTracker, spawnSpy, recordSpy } = makeMockSetup({
      outputs: [schemaInvalidPassedOutput(), schemaValidPassedOutput()],
      readFiles: [specPath],
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'caseF-task', description: 'test', targetFiles: [] };

    await verifier.verifyTask(task, projectRoot, { specPath });

    assert.strictEqual(spawnSpy.calls.length, 2, 'expected an escalation (two spawns)');
    // Attempt 1 and the escalated attempt must be recorded SEPARATELY so the
    // first model's tokens are neither dropped nor conflated.
    const names = recordSpy.calls.map(c => c.name);
    assert.strictEqual(recordSpy.calls.length, 2, `both sessions must be recorded, got ${recordSpy.calls.length}: ${JSON.stringify(names)}`);
    const attempt1 = recordSpy.calls.find(c => c.name === 'verifier-caseF-task');
    const escalatedRec = recordSpy.calls.find(c => c.name === 'verifier-caseF-task-escalated');
    assert.ok(attempt1, `attempt-1 session must be recorded as 'verifier-caseF-task', got ${JSON.stringify(names)}`);
    assert.ok(escalatedRec, `escalated session must be recorded as 'verifier-caseF-task-escalated', got ${JSON.stringify(names)}`);
    // Handle attribution: the attempt-1 record must carry the FIRST spawn's
    // handle metadata (toolCallCount 1) and the escalated record the SECOND
    // spawn's (toolCallCount 2) — i.e. attempt-1 is recorded from its own handle
    // BEFORE the reassignment, not from the escalated handle.
    assert.strictEqual(attempt1.meta.toolCallCount, 1, `attempt-1 record must use the first spawn's handle metadata (toolCallCount 1), got ${attempt1.meta.toolCallCount}`);
    assert.strictEqual(escalatedRec.meta.toolCallCount, 2, `escalated record must use the escalated spawn's handle metadata (toolCallCount 2), got ${escalatedRec.meta.toolCallCount}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
