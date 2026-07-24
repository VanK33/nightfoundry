/**
 * test-analyzer-contract.js — Round-trip tests for analyzer structured contract.
 *
 * Run: node test/test-analyzer-contract.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import {
  analyzerSchema,
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

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-contract-')); }
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

const fixtureRetry = {
  structured_output: {
    recommendation: 'retry',
    rootCause: 'Transient test flake — retry should succeed',
    failureType: 'verification',
    affectedTasks: [],
    evidence: 'npm test produced a timeout on one test, rerun would likely pass',
    notes: '',
  },
};

const fixtureReplan = {
  structured_output: {
    recommendation: 're_plan',
    rootCause: 'Task depended on API that does not exist in this codebase',
    failureType: 'execution',
    affectedTasks: [
      { taskId: '001-001-001-002', reason: 'shares file with failed task', action: 'needs_revalidation' },
      { taskId: '001-001-001-003', reason: 'no overlap', action: 'safe_to_keep' },
    ],
    evidence: 'grep found no such function in src/',
    notes: 'planner should re-decompose with correct API surface',
  },
};

const fixtureHuman = {
  structured_output: {
    recommendation: 'human',
    rootCause: 'Spec is ambiguous — two contradicting scenarios',
    failureType: 'execution',
    affectedTasks: [],
    evidence: 'spec lines 30 and 85 contradict',
    notes: 'needs user clarification',
  },
};

const fixtureMalformed = {
  structured_output: {
    recommendation: 'escalate', // not in enum
    rootCause: 'x',
    failureType: 'execution',
    affectedTasks: [],
  },
};

const fixtureNoStructured = { result: 'prose report only' };

// ── Schema validation ───────────────────────────────────────────────────

await test('validateStructured: retry fixture is valid', () => {
  const r = validateStructured(fixtureRetry.structured_output, analyzerSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

await test('validateStructured: re_plan with affectedTasks is valid', () => {
  const r = validateStructured(fixtureReplan.structured_output, analyzerSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

await test('validateStructured: human fixture is valid', () => {
  const r = validateStructured(fixtureHuman.structured_output, analyzerSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

await test('validateStructured: invalid recommendation enum rejected', () => {
  const r = validateStructured(fixtureMalformed.structured_output, analyzerSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /recommendation.*escalate/.test(e)));
});

await test('validateStructured: invalid action enum rejected', () => {
  const bad = {
    recommendation: 'retry',
    rootCause: 'x',
    failureType: 'execution',
    affectedTasks: [{ taskId: 'a', reason: 'b', action: 'delete' }],
  };
  const r = validateStructured(bad, analyzerSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /affectedTasks\[0\]\.action/.test(e)));
});

// ── analyzer.extractAnalysis integration ───────────────────────────────

await test('analyzer.extractAnalysis: retry fixture → {recommendation: "retry"}', async () => {
  const { extractAnalysis } = await import('../src/orchestrator/agents/analyzer.js');
  const dir = tempDir();
  try {
    const out = extractAnalysis(fixtureRetry, 'evt-1', dir);
    assert.equal(out.recommendation, 'retry');
    assert.deepEqual(out.affectedTasks, []);
    // JSON sidecar written
    const sidecar = path.join(dir, 'analysis', 'evt-1.json');
    assert.ok(fs.existsSync(sidecar));
  } finally { cleanup(dir); }
});

await test('analyzer.extractAnalysis: re_plan fixture surfaces needs_revalidation only', async () => {
  const { extractAnalysis } = await import('../src/orchestrator/agents/analyzer.js');
  const dir = tempDir();
  try {
    const out = extractAnalysis(fixtureReplan, 'evt-2', dir);
    assert.equal(out.recommendation, 're_plan');
    // Pipeline consumes affectedTasks as string IDs (filtered to needs_revalidation)
    assert.deepEqual(out.affectedTasks, ['001-001-001-002']);
  } finally { cleanup(dir); }
});

await test('analyzer.extractAnalysis: human fixture → {recommendation: "human"}', async () => {
  const { extractAnalysis } = await import('../src/orchestrator/agents/analyzer.js');
  const dir = tempDir();
  try {
    const out = extractAnalysis(fixtureHuman, 'evt-3', dir);
    assert.equal(out.recommendation, 'human');
  } finally { cleanup(dir); }
});

await test('analyzer.extractAnalysis: missing structured_output → recommendation human', async () => {
  const { extractAnalysis } = await import('../src/orchestrator/agents/analyzer.js');
  const dir = tempDir();
  try {
    const out = extractAnalysis(fixtureNoStructured, 'evt-4', dir);
    assert.equal(out.recommendation, 'human', 'safest default');
    assert.deepEqual(out.affectedTasks, [], 'affectedTasks must be empty array');
    assert.strictEqual(out.structured, null, 'structured must be null, not a stub object');
    // Minimal sidecar must be written
    const sidecarPath = path.join(dir, 'analysis', 'evt-4.json');
    assert.ok(fs.existsSync(sidecarPath), 'sidecar must be written');
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.equal(sidecar.recommendation, 'human', 'sidecar recommendation must be human');
  } finally { cleanup(dir); }
});

await test('analyzer.extractAnalysis: missing structured_output does NOT log [DEPRECATED]', async () => {
  const { extractAnalysis } = await import('../src/orchestrator/agents/analyzer.js');
  const dir = tempDir();
  const logs = [];
  const warn = console.warn;
  console.warn = (...args) => logs.push(args.join(' '));
  try {
    extractAnalysis(fixtureNoStructured, 'evt-4b', dir);
    assert.ok(!logs.some((l) => /DEPRECATED/.test(l)), '[DEPRECATED] must not appear in logs');
  } finally {
    console.warn = warn;
    cleanup(dir);
  }
});

await test('analyzer.extractAnalysis: malformed → default human', async () => {
  const { extractAnalysis } = await import('../src/orchestrator/agents/analyzer.js');
  const dir = tempDir();
  const logs = [];
  const warn = console.warn;
  console.warn = (...args) => logs.push(args.join(' '));
  try {
    const out = extractAnalysis(fixtureMalformed, 'evt-5', dir);
    assert.equal(out.recommendation, 'human');
  } finally {
    console.warn = warn;
    cleanup(dir);
  }
});

// ── opts.warn forwarding (Bug B regression) ────────────────────────────

await test('analyzer.extractAnalysis: opts.warn forwarded into extractStructured (Bug B fallback path)', async () => {
  const { extractAnalysis } = await import('../src/orchestrator/agents/analyzer.js');
  const dir = tempDir();
  // Use _capturedStructuredOutput (no structured_output) to trigger the
  // fallback path inside extractStructured. When { warn } is forwarded,
  // extractStructured calls warn() with its diagnostic message.
  const capturedPayload = {
    _capturedStructuredOutput: {
      recommendation: 'retry',
      rootCause: 'transient flake',
      failureType: 'verification',
      affectedTasks: [],
      evidence: '',
      notes: '',
    },
  };
  const warnMessages = [];
  const spy = (msg) => warnMessages.push(msg);
  try {
    const out = extractAnalysis(capturedPayload, 'evt-warn', dir, { warn: spy });
    // extractStructured should have emitted the fallback diagnostic
    assert.ok(
      warnMessages.some((m) => /structured_output absent/.test(m)),
      `expected fallback diagnostic in warn spy, got: ${JSON.stringify(warnMessages)}`
    );
    // Should still produce a valid result via the captured payload
    assert.equal(out.recommendation, 'retry');
  } finally { cleanup(dir); }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
