/**
 * test-verifier-schemafail-result.js — fail-closed verdict on schema-invalid output.
 *
 * Regression guard for the false-green path: when the verifier's structured
 * output FAILS schema validation, extractVerdict must NOT let it carry
 * result:'PASSED' downstream. structuredVerdictPassed / the regression
 * soft-pass key on structured.result, so a schema-invalid verdict that still
 * claims PASSED would otherwise be resurrected as a pass.
 *
 * No Claude auth, no SDK — feeds fixture SDK results through the real
 * extractVerdict + the real structuredVerdictPassed signal.
 *
 * Run: node test/test-verifier-schemafail-result.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { extractVerdict } from '../src/orchestrator/agents/verifier.js';
import { structuredVerdictPassed } from '../src/orchestrator/gates/regression.js';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-schemafail-'));
}
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

function readSidecar(harnessDir, taskId) {
  return JSON.parse(
    fs.readFileSync(path.join(harnessDir, 'verification', `task-${taskId}.json`), 'utf8')
  );
}

// A structured verdict that CLAIMS result:'PASSED' but is schema-INVALID
// (omits the required back_reference_check field) — the exact realistic
// drift the fail-close guards against.
const schemaInvalidPassed = {
  structured_output: {
    result: 'PASSED',
    hardChecks: [{ name: 'check', status: 'PASS', evidence: 'ok' }],
    taskScopeChecks: [{ description: 'scope', status: 'PASS', evidence: 'ok' }],
    standardsChecks: [],
    notes: '',
    // back_reference_check intentionally OMITTED -> schema validation fails
  },
};

// A fully schema-VALID verdict claiming PASSED (control / no-regression case).
const schemaValidPassed = {
  structured_output: {
    result: 'PASSED',
    hardChecks: [{ name: 'check', status: 'PASS', evidence: 'ok' }],
    taskScopeChecks: [{ description: 'scope', status: 'PASS', evidence: 'ok' }],
    standardsChecks: [],
    back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
    notes: '',
  },
};

(async () => {
  await test('schema-invalid verdict claiming PASSED is forced to FAILED (return + sidecar + downstream signal)', async () => {
    const d = tempDir();
    try {
      const verdict = extractVerdict(schemaInvalidPassed, 'schemafail-1', d, { warn: () => {} });

      // (a) the verifier rejected it
      assert.strictEqual(verdict.verified, false, 'schema-invalid verdict must not be verified');

      // (b) result is fail-closed in the RETURNED verdict (not the model's 'PASSED')
      assert.strictEqual(
        verdict.structured.result, 'FAILED',
        `returned structured.result must be FAILED, got ${verdict.structured.result}`
      );

      // (c) the persisted on-disk sidecar (the SoT audit.js reads) is also FAILED
      const sidecar = readSidecar(d, 'schemafail-1');
      assert.strictEqual(
        sidecar.result, 'FAILED',
        `persisted sidecar result must be FAILED, got ${sidecar.result}`
      );

      // (d) the downstream regression soft-pass signal can no longer fire on it
      assert.strictEqual(
        structuredVerdictPassed(verdict), false,
        'structuredVerdictPassed must be false for a schema-invalid (fail-closed) verdict'
      );
    } finally {
      cleanup(d);
    }
  });

  await test('schema-valid PASSED verdict is unaffected (verified true, result PASSED)', async () => {
    const d = tempDir();
    try {
      const verdict = extractVerdict(schemaValidPassed, 'schemavalid-1', d, { warn: () => {} });

      assert.strictEqual(verdict.verified, true, 'schema-valid PASSED verdict must stay verified');
      assert.strictEqual(verdict.structured.result, 'PASSED', 'valid PASSED result must be preserved');

      const sidecar = readSidecar(d, 'schemavalid-1');
      assert.strictEqual(sidecar.result, 'PASSED', 'valid PASSED sidecar must stay PASSED');

      assert.strictEqual(
        structuredVerdictPassed(verdict), true,
        'structuredVerdictPassed must stay true for a valid PASSED verdict'
      );
    } finally {
      cleanup(d);
    }
  });

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount === 0 ? 0 : 1);
})();
