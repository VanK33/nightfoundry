/**
 * test-reviewer-contract-integration.js — Round-trip tests for the reviewer
 * structured contract.
 *
 * No Claude auth, no SDK. Feeds fixture SDK results through the
 * extraction + validation pipeline and asserts the reviewer module
 * produces the right verdict without touching a live session.
 *
 * Run: node test/test-reviewer-contract-integration.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import {
  reviewerSchema,
  extractStructured,
  validateStructured,
} from '../src/orchestrator/agents/_schemas.js';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-contract-'));
}
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

// ── Fixtures ────────────────────────────────────────────────────────────

// TC1: PASSED with no findings
const fixturePassed = {
  structured_output: {
    result: 'PASSED',
    findings: [],
    notes: 'All modules integrate correctly.',
  },
};

// TC2: FAILED with a critical finding
const fixtureFailed = {
  structured_output: {
    result: 'FAILED',
    findings: [
      {
        severity: 'critical',
        category: 'call-chain',
        file: 'src/orchestrator/agents/executor.js',
        description: 'extractVerdict is called with wrong argument order.',
        relatedFiles: ['src/orchestrator/agents/verifier.js'],
      },
    ],
    notes: 'Critical call-chain mismatch found.',
  },
};

// TC3: PASSED with warning-only findings (warnings do not flip the result)
const fixtureWarningOnly = {
  structured_output: {
    result: 'PASSED',
    findings: [
      {
        severity: 'warning',
        category: 'integration',
        file: 'src/orchestrator/agents/reviewer.js',
        description: 'Optional relatedFiles field missing on some findings.',
        relatedFiles: [],
      },
    ],
    notes: 'Only warnings present; milestone passes.',
  },
};

// TC4: no structured_output at all
const fixtureNoStructured = {
  // No structured_output key — simulates SDK drift or missing jsonSchema contract.
  result: 'PASSED (prose only)',
};

// TC5: malformed structured_output (bad enum on result)
const fixtureMalformed = {
  structured_output: {
    result: 'MAYBE', // not in enum ['PASSED', 'FAILED']
    findings: [],
  },
};

// TC-passthrough: PASSED with scopeCompliance advisory field
const fixtureWithScopeCompliance = {
  structured_output: {
    result: 'PASSED',
    findings: [],
    notes: '',
    scopeCompliance: {
      verdict: 'exceeded_scope',
      evidence: 'unrelated refactor detected',
      exceededFiles: ['src/rogue.js'],
    },
  },
};

// ── End-to-end: reviewer.js extractReviewVerdict integration ─────────────

// TC1: PASSED fixture with empty findings → { passed: true }
await test('extractReviewVerdict: PASSED fixture with empty findings → { passed: true }', async () => {
  const { extractReviewVerdict } = await import('../src/orchestrator/agents/reviewer.js');
  const dir = tempDir();
  try {
    const out = extractReviewVerdict(fixturePassed, 'ms-001', dir);
    assert.equal(out.passed, true);
    assert.equal(out.structured.result, 'PASSED');
    assert.ok(Array.isArray(out.findings));
    assert.equal(out.findings.length, 0);
    assert.ok(typeof out.reportPath === 'string');
  } finally { cleanup(dir); }
});

// TC2: FAILED fixture with critical finding → { passed: false }
await test('extractReviewVerdict: FAILED fixture with critical finding → { passed: false }', async () => {
  const { extractReviewVerdict } = await import('../src/orchestrator/agents/reviewer.js');
  const dir = tempDir();
  try {
    const out = extractReviewVerdict(fixtureFailed, 'ms-002', dir);
    assert.equal(out.passed, false);
    assert.equal(out.structured.result, 'FAILED');
    assert.ok(out.findings.length > 0);
    assert.ok(out.findings.some(f => f.severity === 'critical'));
  } finally { cleanup(dir); }
});

// TC3: warning-only findings with result PASSED → { passed: true }
await test('extractReviewVerdict: warning-only findings with result PASSED → { passed: true }', async () => {
  const { extractReviewVerdict } = await import('../src/orchestrator/agents/reviewer.js');
  const dir = tempDir();
  try {
    const out = extractReviewVerdict(fixtureWarningOnly, 'ms-003', dir);
    assert.equal(out.passed, true, 'warnings alone should not fail the review');
    assert.equal(out.structured.result, 'PASSED');
    assert.ok(out.findings.some(f => f.severity === 'warning'));
  } finally { cleanup(dir); }
});

// TC4: no structured_output → { passed: false } with FAILED stub sidecar
await test('extractReviewVerdict: no structured_output → { passed: false } with FAILED stub sidecar', async () => {
  const { extractReviewVerdict } = await import('../src/orchestrator/agents/reviewer.js');
  const dir = tempDir();
  try {
    const out = extractReviewVerdict(fixtureNoStructured, 'ms-004', dir);
    assert.equal(out.passed, false, 'missing structured_output must default to FAILED');
    assert.equal(out.structured.result, 'FAILED', 'stub structured result should be FAILED');
    // Sidecar must exist and contain result: FAILED
    const sidecar = path.join(dir, 'verification', 'review-milestone-ms-004.json');
    assert.ok(fs.existsSync(sidecar), 'sidecar JSON must be written');
    const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.equal(parsed.result, 'FAILED', 'sidecar stub must have result: FAILED');
  } finally { cleanup(dir); }
});

// TC5: malformed structured_output (bad enum) → { passed: false }
await test('extractReviewVerdict: malformed structured_output (bad enum) → { passed: false }', async () => {
  const { extractReviewVerdict } = await import('../src/orchestrator/agents/reviewer.js');
  const dir = tempDir();
  const logs = [];
  const warn = console.warn;
  console.warn = (...args) => logs.push(args.join(' '));
  try {
    const out = extractReviewVerdict(fixtureMalformed, 'ms-005', dir);
    assert.equal(out.passed, false, 'malformed output must conservatively fail');
    assert.ok(
      logs.some(l => /validation/i.test(l) || /structured_output/i.test(l)),
      'should emit a warning about validation failure'
    );
  } finally {
    console.warn = warn;
    cleanup(dir);
  }
});

// TC6: sidecar written to .harness/verification/review-milestone-{id}.json
await test('extractReviewVerdict: sidecar written to correct path review-milestone-{id}.json', async () => {
  const { extractReviewVerdict } = await import('../src/orchestrator/agents/reviewer.js');
  const dir = tempDir();
  try {
    const out = extractReviewVerdict(fixturePassed, 'ms-006', dir);
    const expectedSidecar = path.join(dir, 'verification', 'review-milestone-ms-006.json');
    assert.ok(fs.existsSync(expectedSidecar), `sidecar should exist at ${expectedSidecar}`);
    assert.equal(out.reportPath, expectedSidecar, 'reportPath in return value should match sidecar path');
  } finally { cleanup(dir); }
});

// TC7: sidecar content matches structured output
await test('extractReviewVerdict: sidecar content matches structured output', async () => {
  const { extractReviewVerdict } = await import('../src/orchestrator/agents/reviewer.js');
  const dir = tempDir();
  try {
    const out = extractReviewVerdict(fixturePassed, 'ms-007', dir);
    const sidecar = path.join(dir, 'verification', 'review-milestone-ms-007.json');
    assert.ok(fs.existsSync(sidecar), 'sidecar should exist');
    const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.deepStrictEqual(parsed, out.structured, 'sidecar content must equal the structured field');
  } finally { cleanup(dir); }
});

// TC-passthrough: scopeCompliance flows through unchanged; does NOT affect passed
await test('extractReviewVerdict: scopeCompliance passthrough — advisory only, passed unaffected', async () => {
  const { extractReviewVerdict } = await import('../src/orchestrator/agents/reviewer.js');
  const dir = tempDir();
  try {
    const out = extractReviewVerdict(fixtureWithScopeCompliance, 'ms-pass', dir);
    assert.equal(out.passed, true, 'exceeded_scope verdict must NOT flip passed to false');
    assert.deepStrictEqual(
      out.structured.scopeCompliance,
      fixtureWithScopeCompliance.structured_output.scopeCompliance,
      'scopeCompliance must pass through unchanged'
    );
  } finally { cleanup(dir); }
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
