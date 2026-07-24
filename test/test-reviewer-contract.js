/**
 * test-reviewer-contract.js — Round-trip tests for the reviewer structured contract.
 *
 * No Claude auth, no SDK. Feeds fixture SDK results through the
 * extraction + validation pipeline and asserts the reviewer module
 * produces the right verdict without touching a live session.
 *
 * Run: node test/test-reviewer-contract.js
 */
import assert from 'assert';
import os from 'os';
import path from 'path';
import {
  reviewerSchema,
  extractStructured,
  validateStructured,
} from '../src/orchestrator/agents/_schemas.js';
import { extractReviewVerdict } from '../src/orchestrator/agents/reviewer.js';

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

// ── Fixtures ────────────────────────────────────────────────────────────

// (1) PASSED result, empty findings, notes string
const fixturePassed = {
  structured_output: {
    result: 'PASSED',
    findings: [],
    notes: 'No issues found.',
  },
};

// (2) FAILED result, one critical call-chain finding, one warning integration
//     finding, one critical functional finding — covers all 3 categories + both severities
const fixtureFailedCritical = {
  structured_output: {
    result: 'FAILED',
    findings: [
      {
        severity: 'critical',
        category: 'call-chain',
        file: 'src/orchestrator/pipeline.js',
        description: 'Missing await on async call causes silent data loss.',
        relatedFiles: ['src/orchestrator/runner.js'],
      },
      {
        severity: 'warning',
        category: 'integration',
        file: 'src/orchestrator/agents/verifier.js',
        description: 'Return value from extractVerdict is not checked by caller.',
        relatedFiles: [],
      },
      {
        severity: 'critical',
        category: 'functional',
        file: 'src/orchestrator/agents/executor.js',
        description: 'Exit code 1 is swallowed, task marked COMPLETED incorrectly.',
        relatedFiles: ['src/orchestrator/state.js'],
      },
    ],
    notes: 'Critical issues detected; run must be halted.',
  },
};

// (3) PASSED result, findings with only warning severity (valid: warnings don't force FAILED)
const fixtureWarningOnly = {
  structured_output: {
    result: 'PASSED',
    findings: [
      {
        severity: 'warning',
        category: 'functional',
        file: 'src/orchestrator/audit.js',
        description: 'Redundant log statement on every tick.',
        relatedFiles: [],
      },
    ],
    notes: 'Minor warnings only.',
  },
};

// (4) SDK result without structured_output
const fixtureNoStructured = {
  // No structured_output — simulates an SDK response without jsonSchema
  result: 'PASSED (prose only)',
};

// (5) result 'MAYBE' (bad enum)
const fixtureMalformedResult = {
  structured_output: {
    result: 'MAYBE',
    findings: [],
    notes: '',
  },
};

// (6) severity 'debug' (bad enum; note: 'info' is now valid as of reviewer-findings-structured)
const fixtureMalformedSeverity = {
  structured_output: {
    result: 'PASSED',
    findings: [
      {
        severity: 'debug',
        category: 'functional',
        file: 'src/foo.js',
        description: 'Some description.',
        relatedFiles: [],
      },
    ],
    notes: '',
  },
};

// (7) category 'style' (bad enum)
const fixtureMalformedCategory = {
  structured_output: {
    result: 'PASSED',
    findings: [
      {
        severity: 'warning',
        category: 'style',
        file: 'src/foo.js',
        description: 'Some description.',
        relatedFiles: [],
      },
    ],
    notes: '',
  },
};

// ── extractStructured ───────────────────────────────────────────────────

// TC1
await test('extractStructured: returns reviewer object from valid structured_output', () => {
  const obj = extractStructured(fixturePassed);
  assert.ok(obj);
  assert.equal(obj.result, 'PASSED');
  assert.ok(Array.isArray(obj.findings));
});

// TC2
await test('extractStructured: returns null when structured_output missing', () => {
  assert.equal(extractStructured(fixtureNoStructured), null);
});

// ── validateStructured ─────────────────────────────────────────────────

// TC3
await test('validateStructured: passes on PASSED payload with empty findings', () => {
  const r = validateStructured(fixturePassed.structured_output, reviewerSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// TC4
await test('validateStructured: passes on FAILED payload with critical+warning findings across all 3 categories', () => {
  const r = validateStructured(fixtureFailedCritical.structured_output, reviewerSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// TC5
await test('validateStructured: passes on warning-only findings with PASSED result', () => {
  const r = validateStructured(fixtureWarningOnly.structured_output, reviewerSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// TC6
await test('validateStructured: fails on result enum violation (\'MAYBE\')', () => {
  const r = validateStructured(fixtureMalformedResult.structured_output, reviewerSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not in enum/.test(e)), `expected enum error, got: ${JSON.stringify(r.errors)}`);
});

// TC7
await test('validateStructured: fails on severity enum violation (\'debug\')', () => {
  const r = validateStructured(fixtureMalformedSeverity.structured_output, reviewerSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not in enum/.test(e)), `expected enum error, got: ${JSON.stringify(r.errors)}`);
});

// TC8
await test('validateStructured: fails on category enum violation (\'style\')', () => {
  const r = validateStructured(fixtureMalformedCategory.structured_output, reviewerSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not in enum/.test(e)), `expected enum error, got: ${JSON.stringify(r.errors)}`);
});

// TC9
await test('validateStructured: fails on missing required field \'result\'', () => {
  const bad = { findings: [] };
  const r = validateStructured(bad, reviewerSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /result/.test(e)), `expected result error, got: ${JSON.stringify(r.errors)}`);
});

// TC10
await test('validateStructured: fails on missing required field \'findings\'', () => {
  const bad = { result: 'PASSED' };
  const r = validateStructured(bad, reviewerSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /findings/.test(e)), `expected findings error, got: ${JSON.stringify(r.errors)}`);
});

// TC11
await test('validateStructured: fails on missing required fields in findings items (severity, category, file, description)', () => {
  const bad = {
    result: 'FAILED',
    findings: [
      {}, // missing severity, category, file, description
    ],
    notes: '',
  };
  const r = validateStructured(bad, reviewerSchema);
  assert.equal(r.ok, false);
  const allErrors = r.errors.join(' ');
  assert.ok(/severity/.test(allErrors), `expected severity error, got: ${JSON.stringify(r.errors)}`);
  assert.ok(/category/.test(allErrors), `expected category error, got: ${JSON.stringify(r.errors)}`);
  assert.ok(/file/.test(allErrors), `expected file error, got: ${JSON.stringify(r.errors)}`);
  assert.ok(/description/.test(allErrors), `expected description error, got: ${JSON.stringify(r.errors)}`);
});

// ── extractReviewVerdict warn-forwarding ────────────────────────────────

// TC12
// Feed a fixture whose structured_output is absent but _capturedStructuredOutput
// is present — this triggers extractStructured's fallback path, which calls
// opts.warn. We assert that extractReviewVerdict correctly forwards its local
// `warn` binding into extractStructured so the spy is invoked.
await test('extractReviewVerdict: forwards opts.warn into extractStructured (fallback path)', () => {
  const warnMessages = [];
  const spy = (msg) => warnMessages.push(msg);

  const fixtureCaptured = {
    _capturedStructuredOutput: {
      result: 'PASSED',
      findings: [],
      notes: 'From StructuredOutput tool_use capture.',
    },
  };

  const tmpDir = path.join(os.tmpdir(), `reviewer-test-${Date.now()}`);
  const verdict = extractReviewVerdict(fixtureCaptured, 'test-milestone', tmpDir, { warn: spy });

  assert.ok(
    warnMessages.some((m) => /StructuredOutput tool_use fallback/.test(m)),
    `expected spy to receive fallback warning, got: ${JSON.stringify(warnMessages)}`
  );
  assert.ok(verdict.passed === true, 'expected PASSED verdict from valid captured output');
});

// TC13
await test('extractReviewVerdict: stub path returns structured.isStub === true', () => {
  const tmpDir = path.join(os.tmpdir(), `reviewer-test-${Date.now()}`);
  const verdict = extractReviewVerdict(fixtureNoStructured, 'test-milestone', tmpDir, {});

  assert.ok(
    verdict.structured.isStub === true,
    `expected verdict.structured.isStub to be true, got: ${verdict.structured.isStub}`
  );
  assert.ok(
    verdict.passed === false,
    `expected verdict.passed to be false, got: ${verdict.passed}`
  );
  assert.equal(
    verdict.structured.result,
    'FAILED',
    `expected verdict.structured.result to be 'FAILED', got: ${verdict.structured.result}`
  );
});

// ── scopeCompliance field ────────────────────────────────────────────────

// TC14 — backwards-compat: existing fixturePassed (no scopeCompliance) still validates
await test('validateStructured: passes on payload WITHOUT scopeCompliance (backwards-compat)', () => {
  const r = validateStructured(fixturePassed.structured_output, reviewerSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// TC15 — minimal scopeCompliance: only verdict (optional evidence/exceededFiles absent)
await test('validateStructured: passes on scopeCompliance with verdict only (optional fields absent)', () => {
  const payload = {
    result: 'PASSED',
    findings: [],
    notes: '',
    scopeCompliance: { verdict: 'within_scope' },
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// TC16 — full shape: all three enum verdicts with evidence + exceededFiles
await test('validateStructured: passes on all three scopeCompliance verdicts with full sub-fields', () => {
  const verdicts = ['within_scope', 'exceeded_scope', 'insufficient_scope'];
  for (const verdict of verdicts) {
    const payload = {
      result: 'PASSED',
      findings: [],
      notes: '',
      scopeCompliance: {
        verdict,
        evidence: 'Some evidence text.',
        exceededFiles: ['src/extra.js'],
      },
    };
    const r = validateStructured(payload, reviewerSchema);
    assert.equal(r.ok, true, `verdict '${verdict}': ${JSON.stringify(r.errors)}`);
  }
});

// TC17 — enum guard: invalid verdict 'maybe_scope'
await test('validateStructured: fails on scopeCompliance.verdict enum violation (\'maybe_scope\')', () => {
  const payload = {
    result: 'PASSED',
    findings: [],
    notes: '',
    scopeCompliance: { verdict: 'maybe_scope' },
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not in enum/.test(e)), `expected enum error, got: ${JSON.stringify(r.errors)}`);
});

// TC18 — inner-required guard: scopeCompliance present but verdict missing
await test('validateStructured: fails on scopeCompliance missing required \'verdict\'', () => {
  const payload = {
    result: 'PASSED',
    findings: [],
    notes: '',
    scopeCompliance: {},
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /verdict/.test(e)), `expected verdict error, got: ${JSON.stringify(r.errors)}`);
});

// ── Reviewer findings — new severity 'info' + expanded category enum ───

// TC19 — accept severity 'info'
await test("validateStructured: accepts finding with severity 'info'", () => {
  const payload = {
    result: 'PASSED',
    findings: [{ severity: 'info', category: 'integration', file: 'src/x.js', description: 'noteworthy but non-blocking' }],
    notes: '',
    scopeCompliance: { verdict: 'within_scope' },
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, true, `expected ok, got: ${JSON.stringify(r.errors)}`);
});

// TC20 — accept each of the five new category values
const newCategories = [
  'plan-coherence', 'position-precision', 'behavioral-race', 'scope-expansion', 'contract-mismatch',
];
for (const cat of newCategories) {
  await test(`validateStructured: accepts new category '${cat}'`, () => {
    const payload = {
      result: 'PASSED',
      findings: [{ severity: 'info', category: cat, file: 'src/x.js', description: `example for ${cat}` }],
      notes: '',
      scopeCompliance: { verdict: 'within_scope' },
    };
    const r = validateStructured(payload, reviewerSchema);
    assert.equal(r.ok, true, `expected ok for ${cat}, got: ${JSON.stringify(r.errors)}`);
  });
}

// TC21 — reject invalid severity
await test("validateStructured: rejects finding with severity 'fyi' (invalid enum)", () => {
  const payload = {
    result: 'PASSED',
    findings: [{ severity: 'fyi', category: 'integration', file: 'src/x.js', description: 'd' }],
    notes: '',
    scopeCompliance: { verdict: 'within_scope' },
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /severity/.test(e) && /not in enum/.test(e)), `expected severity enum error, got: ${JSON.stringify(r.errors)}`);
});

// TC22 — reject invalid category
await test("validateStructured: rejects finding with category 'random-string' (invalid enum)", () => {
  const payload = {
    result: 'PASSED',
    findings: [{ severity: 'warning', category: 'random-string', file: 'src/x.js', description: 'd' }],
    notes: '',
    scopeCompliance: { verdict: 'within_scope' },
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /category/.test(e) && /not in enum/.test(e)), `expected category enum error, got: ${JSON.stringify(r.errors)}`);
});

// TC23 — backward compat: old-shape finding (warning + integration) still accepted
await test('validateStructured: accepts old-shape finding for backward compatibility', () => {
  const payload = {
    result: 'PASSED',
    findings: [{ severity: 'warning', category: 'integration', file: 'src/x.js', description: 'legacy shape' }],
    notes: '',
    scopeCompliance: { verdict: 'within_scope' },
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, true, `expected ok, got: ${JSON.stringify(r.errors)}`);
});

// TC24 — fully-typed output with one finding of each new category validates
await test('validateStructured: accepts fully-typed output with one finding per new category', () => {
  const payload = {
    result: 'PASSED',
    findings: newCategories.map((cat, i) => ({
      severity: i === 0 ? 'warning' : 'info',
      category: cat,
      file: `src/file-${i}.js`,
      description: `finding ${i}`,
      relatedFiles: [],
    })),
    notes: 'multi-category output',
    scopeCompliance: { verdict: 'within_scope', evidence: 'audit clean', exceededFiles: [] },
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, true, `expected ok, got: ${JSON.stringify(r.errors)}`);
});

// ── Reviewer findings — tier + disposition fields (optional, additive) ───

// TC25 — accept finding with tier + disposition
await test('validateStructured: accepts finding with tier + disposition fields', () => {
  const payload = {
    result: 'PASSED',
    findings: [{
      severity: 'warning', category: 'plan-coherence', file: 'src/x.js',
      description: 'd', tier: 'composition', disposition: 'pending',
    }],
    notes: '',
    scopeCompliance: { verdict: 'within_scope' },
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, true, `expected ok, got: ${JSON.stringify(r.errors)}`);
});

// TC26 — each tier value accepted
for (const tier of ['composition', 'behavioral', 'cosmetic']) {
  await test(`validateStructured: accepts tier '${tier}'`, () => {
    const payload = {
      result: 'PASSED',
      findings: [{ severity: 'info', category: 'integration', file: 'src/x.js', description: 'd', tier }],
      notes: '',
      scopeCompliance: { verdict: 'within_scope' },
    };
    const r = validateStructured(payload, reviewerSchema);
    assert.equal(r.ok, true, `expected ok for tier=${tier}, got: ${JSON.stringify(r.errors)}`);
  });
}

// TC27 — each disposition value accepted
for (const disposition of ['pending', 'accepted-with-followup', 'fixed', 'dismissed']) {
  await test(`validateStructured: accepts disposition '${disposition}'`, () => {
    const payload = {
      result: 'PASSED',
      findings: [{ severity: 'info', category: 'integration', file: 'src/x.js', description: 'd', disposition }],
      notes: '',
      scopeCompliance: { verdict: 'within_scope' },
    };
    const r = validateStructured(payload, reviewerSchema);
    assert.equal(r.ok, true, `expected ok for disposition=${disposition}, got: ${JSON.stringify(r.errors)}`);
  });
}

// TC28 — reject invalid tier
await test("validateStructured: rejects tier 'urgent' (invalid enum)", () => {
  const payload = {
    result: 'PASSED',
    findings: [{ severity: 'warning', category: 'integration', file: 'src/x.js', description: 'd', tier: 'urgent' }],
    notes: '',
    scopeCompliance: { verdict: 'within_scope' },
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /tier/.test(e) && /not in enum/.test(e)), `expected tier enum error, got: ${JSON.stringify(r.errors)}`);
});

// TC29 — reject invalid disposition
await test("validateStructured: rejects disposition 'rejected' (invalid enum)", () => {
  const payload = {
    result: 'PASSED',
    findings: [{ severity: 'warning', category: 'integration', file: 'src/x.js', description: 'd', disposition: 'rejected' }],
    notes: '',
    scopeCompliance: { verdict: 'within_scope' },
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /disposition/.test(e) && /not in enum/.test(e)), `expected disposition enum error, got: ${JSON.stringify(r.errors)}`);
});

// TC30 — both fields optional: finding without tier/disposition still validates (backward compat)
await test('validateStructured: accepts finding WITHOUT tier or disposition (additive)', () => {
  const payload = {
    result: 'PASSED',
    findings: [{ severity: 'warning', category: 'integration', file: 'src/x.js', description: 'no tier no disposition' }],
    notes: '',
    scopeCompliance: { verdict: 'within_scope' },
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, true, `expected ok, got: ${JSON.stringify(r.errors)}`);
});

// TC31 — dispositionReason positive-population path
await test("validateStructured: accepts finding with disposition='fixed' and non-empty dispositionReason string", () => {
  const payload = {
    result: 'PASSED',
    findings: [{
      severity: 'warning',
      category: 'integration',
      file: 'src/x.js',
      description: 'd',
      tier: 'composition',
      disposition: 'fixed',
      dispositionReason: 'addressed in commit abc1234',
    }],
    notes: '',
    scopeCompliance: { verdict: 'within_scope' },
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, true, `expected ok, got: ${JSON.stringify(r.errors)}`);
});

// ── Reviewer verdict — optional uncoveredCriteria string-array field ────

// TC32 — verdict WITH uncoveredCriteria (non-empty string array) validates
await test('validateStructured: accepts verdict WITH uncoveredCriteria (optional string array)', () => {
  const payload = {
    result: 'PASSED',
    findings: [],
    notes: '',
    scopeCompliance: { verdict: 'within_scope' },
    uncoveredCriteria: [
      'The login endpoint rejects expired tokens.',
      'A README section documents the new flag.',
    ],
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, true, `expected ok with uncoveredCriteria present, got: ${JSON.stringify(r.errors)}`);
});

// TC33 — verdict WITHOUT uncoveredCriteria still validates (field is optional)
await test('validateStructured: accepts verdict WITHOUT uncoveredCriteria (field is optional)', () => {
  const payload = {
    result: 'PASSED',
    findings: [],
    notes: '',
    scopeCompliance: { verdict: 'within_scope' },
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, true, `expected ok with uncoveredCriteria absent, got: ${JSON.stringify(r.errors)}`);
});

// TC34 — empty uncoveredCriteria array validates (all-covered / no-criteria path)
await test('validateStructured: accepts verdict with empty uncoveredCriteria array', () => {
  const payload = {
    result: 'PASSED',
    findings: [],
    notes: '',
    scopeCompliance: { verdict: 'within_scope' },
    uncoveredCriteria: [],
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, true, `expected ok with empty uncoveredCriteria, got: ${JSON.stringify(r.errors)}`);
});

// TC35 — uncoveredCriteria with a non-string item fails (items must be strings)
await test('validateStructured: fails when uncoveredCriteria contains a non-string item', () => {
  const payload = {
    result: 'PASSED',
    findings: [],
    notes: '',
    scopeCompliance: { verdict: 'within_scope' },
    uncoveredCriteria: ['ok string', 42],
  };
  const r = validateStructured(payload, reviewerSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /uncoveredCriteria/.test(e) && /string/.test(e)),
    `expected a uncoveredCriteria string-type error, got: ${JSON.stringify(r.errors)}`
  );
});

// TC36 — round-trip: a verdict with uncoveredCriteria survives
//         extractReviewVerdict (passes through to structured / sidecar)
await test('extractReviewVerdict: passes a verdict carrying uncoveredCriteria through to structured', () => {
  const fixture = {
    structured_output: {
      result: 'PASSED',
      findings: [],
      notes: 'one criterion uncovered',
      uncoveredCriteria: ['The operator can rotate keys manually.'],
    },
  };
  const tmpDir = path.join(os.tmpdir(), `reviewer-test-uc-${Date.now()}`);
  const verdict = extractReviewVerdict(fixture, 'test-milestone-uc', tmpDir, {});
  assert.equal(verdict.passed, true, 'expected passed=true (PASSED, no critical findings)');
  assert.deepStrictEqual(
    verdict.structured.uncoveredCriteria,
    ['The operator can rotate keys manually.'],
    'expected uncoveredCriteria to survive through extractReviewVerdict'
  );
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
