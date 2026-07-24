/**
 * test-verifier-contract.js — Round-trip tests for the verifier structured contract.
 *
 * No Claude auth, no SDK. Feeds fixture SDK results through the
 * extraction + validation pipeline and asserts the verifier module
 * produces the right verdict without touching a live session.
 *
 * Run: node test/test-verifier-contract.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import {
  verifierSchema,
  extractStructured,
  validateStructured,
} from '../src/orchestrator/agents/_schemas.js';

let passCount = 0;
let failCount = 0;

// Phase I items 4+5 dogfood 5 finding: previously this file used a
// sync `test` helper with async test bodies. Assertion failures
// became unhandled promise rejections and the helper reported PASS
// regardless. Converting to async-aware.
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-contract-'));
}
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

// ── Fixtures ────────────────────────────────────────────────────────────

const fixturePassed = {
  structured_output: {
    result: 'PASSED',
    hardChecks: [
      { name: 'npm test', status: 'PASS', evidence: '12 tests passed' },
    ],
    taskScopeChecks: [
      { description: 'targetFiles match description', status: 'PASS', evidence: 'staging.js updated as expected' },
    ],
    standardsChecks: [],
    back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
    notes: '',
  },
};

const fixtureFailed = {
  structured_output: {
    result: 'FAILED',
    hardChecks: [
      { name: 'npm test', status: 'FAIL', evidence: '3 tests failed' },
    ],
    taskScopeChecks: [],
    standardsChecks: [],
    back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
    notes: 'hard check failed, skipped soft verification',
  },
};

const fixtureNoStructured = {
  // No structured_output — simulates an SDK response without jsonSchema
  // or an SDK drift where the contract silently breaks.
  result: 'PASSED (prose only)',
};

const fixtureMalformed = {
  structured_output: {
    result: 'MAYBE',  // not in enum
    hardChecks: [],
    taskScopeChecks: [],
  },
};

// ── extractStructured ───────────────────────────────────────────────────

await test('extractStructured: returns object on valid structured_output', () => {
  const obj = extractStructured(fixturePassed);
  assert.ok(obj);
  assert.equal(obj.result, 'PASSED');
});

await test('extractStructured: returns null when structured_output missing', () => {
  assert.equal(extractStructured(fixtureNoStructured), null);
});

await test('extractStructured: returns null on null input', () => {
  assert.equal(extractStructured(null), null);
});

// ── validateStructured ─────────────────────────────────────────────────

await test('validateStructured: passes on valid verifier payload', () => {
  const r = validateStructured(fixturePassed.structured_output, verifierSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

await test('validateStructured: fails on enum violation (MAYBE)', () => {
  const r = validateStructured(fixtureMalformed.structured_output, verifierSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not in enum/.test(e)));
});

await test('validateStructured: fails on missing required field', () => {
  const bad = { result: 'PASSED' }; // missing hardChecks, taskScopeChecks
  const r = validateStructured(bad, verifierSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 2);
});

await test('validateStructured: fails on nested array item wrong type', () => {
  const bad = {
    result: 'PASSED',
    hardChecks: [{ name: 'x', status: 'MAYBE', evidence: 'y' }], // MAYBE invalid
    taskScopeChecks: [],
  };
  const r = validateStructured(bad, verifierSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /hardChecks\[0\]\.status/.test(e)));
});

// ── New TC1–TC4: back_reference_check schema tests ────────────────────────

// Post-A4 contract: back_reference_check is REQUIRED — omission is non-conformant.
await test('back_reference_check absent → invalid (required post-A4)', () => {
  const { back_reference_check, ...withoutBrc } = fixturePassed.structured_output;
  const r = validateStructured(withoutBrc, verifierSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /back_reference_check: missing/.test(e)), JSON.stringify(r.errors));
});

await test('back_reference_check fully populated → valid', () => {
  const payload = {
    result: 'PASSED',
    hardChecks: [],
    taskScopeChecks: [],
    back_reference_check: {
      spec_consulted: true,
      plan_consulted: false,
      deviations: [
        { kind: 'spec_mismatch', description: 'some description', evidence: 'some evidence' },
      ],
    },
  };
  const r = validateStructured(payload, verifierSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

await test('back_reference_check kind not in enum → invalid', () => {
  const payload = {
    result: 'PASSED',
    hardChecks: [],
    taskScopeChecks: [],
    back_reference_check: {
      spec_consulted: true,
      plan_consulted: false,
      deviations: [
        { kind: 'BOGUS', description: 'some description', evidence: 'some evidence' },
      ],
    },
  };
  const r = validateStructured(payload, verifierSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not in enum/.test(e)));
});

await test('back_reference_check deviation missing evidence → invalid', () => {
  const payload = {
    result: 'PASSED',
    hardChecks: [],
    taskScopeChecks: [],
    back_reference_check: {
      spec_consulted: true,
      plan_consulted: false,
      deviations: [
        { kind: 'spec_mismatch', description: 'some description' },
      ],
    },
  };
  const r = validateStructured(payload, verifierSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /evidence: missing/.test(e)));
});

// (a) back_reference_check absent → invalid (post-A4: the field is required)
await test('back_reference_check absent → invalid (required post-A4, explicit false stays valid)', () => {
  const { back_reference_check, ...withoutBrc } = fixturePassed.structured_output;
  const r = validateStructured(withoutBrc, verifierSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /back_reference_check: missing/.test(e)), JSON.stringify(r.errors));
  // Explicit honest non-consultation remains conformant.
  const rExplicit = validateStructured(fixturePassed.structured_output, verifierSchema);
  assert.equal(rExplicit.ok, true, JSON.stringify(rExplicit.errors));
});

// (b) back_reference_check with empty deviations → valid
await test('back_reference_check with empty deviations → valid', () => {
  const payload = {
    result: 'PASSED',
    hardChecks: [],
    taskScopeChecks: [],
    back_reference_check: {
      spec_consulted: true,
      plan_consulted: true,
      deviations: [],
    },
  };
  const r = validateStructured(payload, verifierSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// (c) back_reference_check with one deviation of each kind → valid
await test('back_reference_check with one deviation of each kind → valid', () => {
  const payload = {
    result: 'PASSED',
    hardChecks: [],
    taskScopeChecks: [],
    back_reference_check: {
      spec_consulted: true,
      plan_consulted: false,
      deviations: [
        { kind: 'spec_mismatch',          description: 'desc1', evidence: 'ev1' },
        { kind: 'plan_contradiction',     description: 'desc2', evidence: 'ev2' },
        { kind: 'missing_constraint',     description: 'desc3', evidence: 'ev3' },
        { kind: 'undefined_composition',  description: 'desc4', evidence: 'ev4' },
      ],
    },
  };
  const r = validateStructured(payload, verifierSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// (d) back_reference_check deviation missing kind → invalid
await test('back_reference_check deviation missing kind → invalid', () => {
  const payload = {
    result: 'PASSED',
    hardChecks: [],
    taskScopeChecks: [],
    back_reference_check: {
      spec_consulted: true,
      plan_consulted: true,
      deviations: [
        { description: 'missing the kind field', evidence: 'some evidence' },
      ],
    },
  };
  const r = validateStructured(payload, verifierSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /kind: missing/.test(e)));
});

// (e) back_reference_check deviation with invalid kind enum → invalid
await test('back_reference_check deviation with invalid kind enum → invalid', () => {
  const payload = {
    result: 'PASSED',
    hardChecks: [],
    taskScopeChecks: [],
    back_reference_check: {
      spec_consulted: true,
      plan_consulted: true,
      deviations: [
        { kind: 'invalid_enum_value', description: 'desc', evidence: 'ev' },
      ],
    },
  };
  const r = validateStructured(payload, verifierSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not in enum/.test(e)));
});

// ── End-to-end: verifier.js extractVerdict integration ─────────────────
//
// Imports the verifier module and exercises its pure extractVerdict
// helper. This is the real entry point the pipeline consumers will hit
// once the SDK returns structured output.

await test('verifier.extractVerdict: PASSED fixture → {verified: true}', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const dir = tempDir();
  try {
    const out = extractVerdict(fixturePassed, 'test-001', dir);
    assert.equal(out.verified, true);
    assert.equal(out.structured.result, 'PASSED');
    // JSON sidecar is written
    const sidecar = path.join(dir, 'verification', 'task-test-001.json');
    assert.ok(fs.existsSync(sidecar));
    const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.equal(parsed.result, 'PASSED');
  } finally { cleanup(dir); }
});

await test('verifier.extractVerdict: FAILED fixture → {verified: false}', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const dir = tempDir();
  try {
    const out = extractVerdict(fixtureFailed, 'test-002', dir);
    assert.equal(out.verified, false);
    assert.equal(out.structured.result, 'FAILED');
  } finally { cleanup(dir); }
});

await test('verifier.extractVerdict: no structured_output → verified:false, sidecar written with result:FAILED', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const dir = tempDir();
  try {
    const out = extractVerdict(fixtureNoStructured, 'test-003', dir);
    assert.equal(out.verified, false, 'missing structured_output defaults to FAILED');
    assert.equal(out.structured.result, 'FAILED', 'structured result is FAILED');
    const sidecar = path.join(dir, 'verification', 'task-test-003.json');
    assert.ok(fs.existsSync(sidecar), 'sidecar JSON file written');
    const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.equal(parsed.result, 'FAILED', 'sidecar contains result:FAILED');
    assert.equal(parsed.isStub, true, 'sidecar contains isStub:true');
  } finally {
    cleanup(dir);
  }
});

await test('verifier.extractVerdict: no structured_output with existing .md file → .md ignored, still returns verified:false', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const dir = tempDir();
  try {
    // Place a legacy .md file that the old verifier might have read
    const legacyMdPath = path.join(dir, 'verification', 'task-test-005.md');
    fs.mkdirSync(path.join(dir, 'verification'), { recursive: true });
    fs.writeFileSync(legacyMdPath, '**Result:** PASSED\n');

    const out = extractVerdict(fixtureNoStructured, 'test-005', dir);
    assert.equal(out.verified, false, '.md file is ignored; still returns verified:false');
    assert.equal(out.structured.result, 'FAILED', 'result is FAILED regardless of .md content');
    // The sidecar JSON should exist and not be influenced by the .md file
    const sidecar = path.join(dir, 'verification', 'task-test-005.json');
    assert.ok(fs.existsSync(sidecar), 'JSON sidecar written');
    const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.equal(parsed.result, 'FAILED', 'sidecar is FAILED, not PASSED from .md');
  } finally {
    cleanup(dir);
  }
});

await test('verifier.extractVerdict: malformed structured_output → FAILED + validation errors', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const dir = tempDir();
  const logs = [];
  const warn = console.warn;
  console.warn = (...args) => logs.push(args.join(' '));
  try {
    const out = extractVerdict(fixtureMalformed, 'test-004', dir);
    assert.equal(out.verified, false);
    assert.ok(logs.some((l) => /validation/i.test(l) || /DEPRECATED/.test(l)));
  } finally {
    console.warn = warn;
    cleanup(dir);
  }
});

await test('verifier.extractVerdict: opts.warn is forwarded into extractStructured (spy on malformed fixture)', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const dir = tempDir();
  const warnMessages = [];
  const warnSpy = (...args) => warnMessages.push(args.join(' '));
  try {
    // fixtureMalformed triggers validation failure — extractStructured should
    // call warn (Bug B's fallback path) if it encounters issues, and the
    // validation warn in extractVerdict definitely fires. Either way, the
    // spy must receive at least one call, proving opts.warn was forwarded.
    const out = extractVerdict(fixtureMalformed, 'test-warn-fwd', dir, { warn: warnSpy });
    assert.equal(out.verified, false, 'malformed fixture → verified:false');
    assert.ok(
      warnMessages.length > 0,
      `expected opts.warn spy to be called at least once, got 0 calls`
    );
  } finally {
    cleanup(dir);
  }
});

// (f) extractVerdict preserves back_reference_check when present
const fixtureBrc = {
  structured_output: {
    result: 'PASSED',
    hardChecks: [],
    taskScopeChecks: [],
    back_reference_check: {
      spec_consulted: true,
      plan_consulted: true,
      deviations: [
        { kind: 'spec_mismatch', description: 'example deviation', evidence: 'example evidence' },
      ],
    },
  },
};

await test('extractVerdict preserves back_reference_check when present', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const dir = tempDir();
  try {
    const out = extractVerdict(fixtureBrc, 'test-brc-present', dir);
    assert.deepStrictEqual(
      out.structured.back_reference_check,
      fixtureBrc.structured_output.back_reference_check
    );
    const sidecar = path.join(dir, 'verification', 'task-test-brc-present.json');
    assert.ok(fs.existsSync(sidecar));
    const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.deepStrictEqual(
      parsed.back_reference_check,
      fixtureBrc.structured_output.back_reference_check
    );
  } finally { cleanup(dir); }
});

// (g) extractVerdict does not synthesize back_reference_check when absent
await test('extractVerdict does not synthesize back_reference_check when absent', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const dir = tempDir();
  try {
    // Field-less payload (non-conformant post-A4, but extractVerdict must
    // still pass it through without synthesizing the key).
    const { back_reference_check, ...withoutBrc } = fixturePassed.structured_output;
    const out = extractVerdict({ structured_output: withoutBrc }, 'test-brc-absent', dir);
    assert.equal('back_reference_check' in out.structured, false,
      'back_reference_check should not be present in structured output when not provided');

    // stub branch (no structured_output) also must not synthesize the key
    const stubOut = extractVerdict(fixtureNoStructured, 'test-brc-stub', dir);
    assert.equal('back_reference_check' in stubOut.structured, false,
      'stub branch must not synthesize back_reference_check');
  } finally { cleanup(dir); }
});

// TC25 — back_reference_check inner required: empty object now rejected
await test("validateStructured: rejects back_reference_check: {} (inner required enforced)", () => {
  const payload = {
    result: 'PASSED',
    hardChecks: [],
    taskScopeChecks: [],
    back_reference_check: {},
  };
  const r = validateStructured(payload, verifierSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /spec_consulted|plan_consulted|deviations/.test(e)),
    `expected inner-required error, got: ${JSON.stringify(r.errors)}`,
  );
});

// ── TC1-TC3: firstWrite / SidecarReuseError guard ──────────────────────

await test('TC1: extractVerdict with opts.firstWrite=true and pre-existing sidecar throws SidecarReuseError', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const { SidecarReuseError } = await import('../src/orchestrator/core/sidecar-reuse-error.js');
  const dir = tempDir();
  try {
    // Pre-create the sidecar file
    const sidecarDir = path.join(dir, 'verification');
    fs.mkdirSync(sidecarDir, { recursive: true });
    fs.writeFileSync(path.join(sidecarDir, 'task-tc1.json'), '{}');
    let threw = false;
    try {
      extractVerdict(fixturePassed, 'tc1', dir, { firstWrite: true });
    } catch (err) {
      threw = true;
      assert.ok(err instanceof SidecarReuseError, `expected SidecarReuseError, got ${err.constructor.name}`);
      assert.equal(err.taskId, 'tc1');
      assert.ok(err.sidecarPath.includes('task-tc1.json'));
    }
    assert.ok(threw, 'expected SidecarReuseError to be thrown');
  } finally { cleanup(dir); }
});

await test('TC2: extractVerdict with opts.firstWrite=true and no pre-existing sidecar succeeds normally', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const dir = tempDir();
  try {
    const out = extractVerdict(fixturePassed, 'tc2', dir, { firstWrite: true });
    assert.equal(out.verified, true);
    const sidecar = path.join(dir, 'verification', 'task-tc2.json');
    assert.ok(fs.existsSync(sidecar), 'sidecar should be written on first write');
  } finally { cleanup(dir); }
});

await test('TC3: extractVerdict with opts.firstWrite=false (default) and pre-existing sidecar overwrites without error', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const dir = tempDir();
  try {
    // Pre-create sidecar with a different value
    const sidecarDir = path.join(dir, 'verification');
    fs.mkdirSync(sidecarDir, { recursive: true });
    fs.writeFileSync(path.join(sidecarDir, 'task-tc3.json'), '{"result":"FAILED"}');
    // firstWrite defaults to false — should overwrite without throwing
    const out = extractVerdict(fixturePassed, 'tc3', dir);
    assert.equal(out.verified, true);
    const parsed = JSON.parse(fs.readFileSync(path.join(sidecarDir, 'task-tc3.json'), 'utf8'));
    assert.equal(parsed.result, 'PASSED', 'sidecar should be overwritten with new result');
  } finally { cleanup(dir); }
});

// ── extractVerdict pure contract: arity + no-opts no-op ──────────────────

await test('extractVerdict pure contract: signature length and no-op when called without opts is unchanged', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  // TC2: positional arity must remain 3 (sdkResult, taskId, workDir)
  assert.equal(extractVerdict.length, 3, `expected extractVerdict.length === 3, got ${extractVerdict.length}`);

  const dir = tempDir();
  try {
    // TC3: calling without opts produces a sidecar whose JSON deepStrictEquals fixturePassed.structured_output
    extractVerdict(fixturePassed, 'tc-contract-pure', dir);
    const sidecar = path.join(dir, 'verification', 'task-tc-contract-pure.json');
    assert.ok(fs.existsSync(sidecar), 'sidecar JSON file should be written');
    const parsedSidecar = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.deepStrictEqual(parsedSidecar, fixturePassed.structured_output);
  } finally { cleanup(dir); }
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
