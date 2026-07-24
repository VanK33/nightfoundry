#!/usr/bin/env node

/**
 * test-verifier-wholesuite-verdict.js — Whole-suite verdict rescue at the
 * REAL verifier verdict-processing boundary, REWORKED contract.
 *
 * REWORKED BEHAVIOR CONTRACT (the target):
 *   When the verifier AI returns a FAILED verdict whose ONLY FAIL-status
 *   taskScopeChecks are "whole-suite" (their description/evidence references
 *   the configured whole-suite command) and there is no failing hardCheck,
 *   the verdict is RESCUED — deferred to the final integration gate. The
 *   reworked contract sharpens three things over the previous version:
 *
 *   1. SIDECAR CONSISTENCY (cross-boundary): the rescue must propagate to the
 *      PERSISTED sidecar — `<root>/.harness/verification/task-<id>.json` must
 *      carry `result: 'PASSED'`, not merely flip the returned `verified`.
 *      The on-disk SoT and the in-memory verdict must agree.
 *
 *   2. PER-TASK SCOPE via task id: the rescue fires ONLY for per-task ids.
 *      A task whose `id` starts with `regression-` is the WHOLE-SUITE GATE
 *      itself — running the full suite IS its job — so a whole-suite FAIL on
 *      a regression-* task must NOT be rescued (verified:false, sidecar
 *      result:'FAILED').
 *
 *   3. DETECTION TIGHTENED: taskScopeCheckIsWholeSuite must not be fooled by
 *      per-task / negated prose that merely CONTAINS 'npm test' as a substring
 *      ('npm test:unit failed', 'npm test-integration is red', 'npm testHarness
 *      wrapper broke', 'npm test was NOT run'). It must still recognize a real
 *      whole-suite reference ('ran npm run test:all, 3 suites red').
 *
 *   4. GUARDS (already true at HEAD): a per-task hardCheck FAIL is never
 *      rescued; a non-whole-suite taskScopeCheck FAIL is never rescued; a
 *      PASSED verdict stays verified:true.
 *
 *   5. CONFIG-SOURCED: a non-default testAllCommand is honored by detection.
 *
 * This test drives the REAL Verifier.verifyTask via a mock sessionManager /
 * logger / tokenTracker (makeMockSetup({ structuredOutput })), so the verdict
 * crosses the real verifier verdict-processing boundary rather than a synthetic
 * helper. The mock sessionManager.spawn returns an sdkResult whose
 * `structured_output` is the verdict the mock AI "returns".
 *
 * DISCRIMINATION (at current HEAD the reworked contract is NOT fully
 * implemented, so these SHOULD FAIL — that failure is the signal):
 *   - #1 sidecar PASSED      → FAILS (HEAD flips only the returned `verified`;
 *                              sidecar stays result:'FAILED').
 *   - #2 regression-* id      → FAILS for the regression-id case (HEAD rescues
 *                              regardless of id → sidecar PASSED, verified:true).
 *   - #3 detection tightened   → FAILS for the per-task / negated prose cases
 *                              (HEAD's loose 'npm test' substring matches them).
 *   - #4 guards                → PASS at HEAD.
 *   - #5 config-sourced        → PASS at HEAD (already config-sourced).
 *
 * Every assertion is wrapped so the file always runs to completion (a missing
 * symbol / throw is reported as a FAIL, never an uncaught crash).
 *
 * Run: node test/test-verifier-wholesuite-verdict.js
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import assert from 'assert';

import { Verifier, taskScopeCheckIsWholeSuite } from '../src/orchestrator/agents/verifier.js';
import config       from '../src/orchestrator/infra/config.js';

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

// ── tmp harness ────────────────────────────────────────────────────────────

function makeTmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-wholesuite-'));
  // verifyTask reads context/standards from .harness; make the dir tree so
  // nothing in the real verifier path throws on a missing directory.
  fs.mkdirSync(path.join(root, '.harness', 'verify'),        { recursive: true });
  fs.mkdirSync(path.join(root, '.harness', 'verification'),  { recursive: true });
  fs.mkdirSync(path.join(root, '.harness', 'logs'),          { recursive: true });
  // verifyTask requires context.specPath to point to an existing, non-empty file.
  fs.writeFileSync(path.join(root, 'spec.md'), '# Spec');
  return root;
}
function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }); }

// Read the persisted sidecar for a task id; returns the parsed object, or
// throws a descriptive error if the file is missing (so a missing sidecar is
// reported as a FAIL, not an opaque ENOENT).
function readSidecar(root, taskId) {
  const p = path.join(root, '.harness', 'verification', `task-${taskId}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`expected sidecar at ${p} but it does not exist`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── makeMockSetup ───────────────────────────────────────────────────────────
//
// Builds the (sessionManager, logger, tokenTracker) trio the real Verifier
// needs, wiring sessionManager.spawn so the mock AI "returns" `structuredOutput`
// as the session's structured_output. Returns a constructed Verifier plus the
// captured spawn args for inspection.
//
// spawn() must return a thenable that ALSO exposes a synchronous `.handle`
// property (the real SessionManager.spawn does this so the caller can
// attachToSession before awaiting). We mimic that shape exactly.

function makeMockSetup({ structuredOutput } = {}) {
  const handle = {
    name: 'verifier-mock',
    systemPromptTokens: 0,
    _toolCallCount: 0,
    _readFiles: new Set(),
  };

  // back_reference_check is REQUIRED by the verifier schema; inject a default so
  // fixtures (which focus on result / taskScopeChecks) stay schema-valid. A
  // fixture may override it via its own back_reference_check (spread wins).
  const withBrc = structuredOutput === undefined
    ? undefined
    : { back_reference_check: { spec_consulted: true, plan_consulted: false, deviations: [] }, ...structuredOutput };
  const sdkResult = withBrc === undefined
    ? {}                                   // no structured_output at all
    : { structured_output: withBrc };

  const spawnCalls = [];
  const sessionManager = {
    spawn(opts) {
      spawnCalls.push(opts);
      const p = Promise.resolve({ handle, result: sdkResult });
      // The real spawn exposes handle synchronously on the returned promise.
      p.handle = handle;
      return p;
    },
  };

  const logger = {
    createSessionLog: (_name) => ({
      logPath: '/dev/null',
      close:   () => {},
    }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
    warn: () => {},
    onLog: () => {},
  };

  const tokenTracker = {
    recordSession: async () => {},
  };

  const verifier = new Verifier(sessionManager, logger, tokenTracker);
  return { verifier, sessionManager, logger, tokenTracker, spawnCalls };
}

// Per-task id (NOT a regression-* id) — the rescue SHOULD fire for this.
const PER_TASK_ID = 'wholesuite-001';
// Regression / whole-suite-gate id — the rescue must NOT fire for this.
const REGRESSION_ID = 'regression-milestone-001';

function makeTask(id) {
  return { id, description: 'Implement feature X', targetFiles: ['src/x.js'] };
}

// Resolve the default whole-suite commands the contract names, falling back
// to the literal defaults if config does not (yet) carry them.
const TEST_ALL_CMD = config.execution.testAllCommand || 'npm run test:all';
const TEST_CMD     = config.execution.testCommand    || 'npm test';

// A whole-suite-only FAILED verdict: every FAIL is a genuine whole-suite check,
// no failing hardCheck. Parameterized on the whole-suite command referenced.
function wholeSuiteOnlyFailedVerdict(cmd = TEST_ALL_CMD) {
  return {
    result: 'FAILED',
    hardChecks: [
      { name: 'npm test (per-task subset)', status: 'PASS', evidence: 'task tests green' },
    ],
    taskScopeChecks: [
      { description: 'targetFiles match description', status: 'PASS', evidence: 'src/x.js updated' },
      { description: 'edge cases covered',            status: 'PASS', evidence: 'covered' },
      {
        description: `ran ${cmd}, 3 suites red`,
        status: 'FAIL',
        evidence: `${cmd}: 250/249/1 red`,
      },
    ],
    standardsChecks: [],
    notes: 'only the cross-cutting whole-suite check is red',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 1 (SIDECAR CONSISTENCY, CORE / cross-boundary):
//   A per-task whole-suite-only FAILED verdict is rescued — BOTH the returned
//   verified is true AND the on-disk sidecar's result is 'PASSED'.
//
// EXPECTED TO FAIL AT HEAD: the rescue flips only the returned `verified`; the
// persisted sidecar still carries result:'FAILED'.
// ─────────────────────────────────────────────────────────────────────────────

await test('A1 (SIDECAR): per-task whole-suite-only FAIL → verified:true AND sidecar result:PASSED', async () => {
  const root = makeTmpProject();
  try {
    const structuredOutput = wholeSuiteOnlyFailedVerdict(TEST_ALL_CMD);
    const { verifier } = makeMockSetup({ structuredOutput });
    const out = await verifier.verifyTask(makeTask(PER_TASK_ID), root, { specPath: path.join(root, 'spec.md') });

    assert.strictEqual(
      out.verified, true,
      'whole-suite-only FAIL must be deferred to the final gate, not fail the task'
    );
    const sidecar = readSidecar(root, PER_TASK_ID);
    assert.strictEqual(
      sidecar.result, 'PASSED',
      'rescue must propagate to the persisted sidecar: on-disk result must be PASSED, not FAILED'
    );
  } finally { cleanup(root); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 2 (PER-TASK SCOPE via task id): drive BOTH ids through the SAME
// whole-suite-only FAILED verdict.
//
//   2a — per-task id   → rescued (verified:true, sidecar PASSED).  [matches A1]
//   2b — regression-* id → NOT rescued (verified:false, sidecar FAILED), because
//        a regression task IS the whole-suite gate; deferring its whole-suite
//        FAIL would defeat the gate.
//
// EXPECTED TO FAIL AT HEAD for 2b: the override fires regardless of id, so a
// regression-* task is wrongly rescued.
// ─────────────────────────────────────────────────────────────────────────────

await test('A2a (PER-TASK ID): per-task id whole-suite-only FAIL → rescued (verified:true, sidecar PASSED)', async () => {
  const root = makeTmpProject();
  try {
    const { verifier } = makeMockSetup({ structuredOutput: wholeSuiteOnlyFailedVerdict(TEST_ALL_CMD) });
    const out = await verifier.verifyTask(makeTask(PER_TASK_ID), root, { specPath: path.join(root, 'spec.md') });
    assert.strictEqual(out.verified, true, 'per-task id: whole-suite-only FAIL must be rescued');
    const sidecar = readSidecar(root, PER_TASK_ID);
    assert.strictEqual(sidecar.result, 'PASSED', 'per-task id: sidecar must be PASSED after rescue');
  } finally { cleanup(root); }
});

await test('A2b (REGRESSION ID): regression-* id whole-suite-only FAIL → NOT rescued (verified:false, sidecar FAILED)', async () => {
  const root = makeTmpProject();
  try {
    const { verifier } = makeMockSetup({ structuredOutput: wholeSuiteOnlyFailedVerdict(TEST_ALL_CMD) });
    const out = await verifier.verifyRegression(makeTask(REGRESSION_ID), root, { specPath: path.join(root, 'spec.md') });
    assert.strictEqual(
      out.verified, false,
      'regression-* id: a whole-suite FAIL is the gate doing its job — it must NOT be rescued'
    );
    const sidecar = readSidecar(root, REGRESSION_ID);
    assert.strictEqual(
      sidecar.result, 'FAILED',
      'regression-* id: sidecar must stay FAILED (no rescue for the whole-suite gate itself)'
    );
  } finally { cleanup(root); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 3 (DETECTION TIGHTENED): taskScopeCheckIsWholeSuite must reject
// per-task / negated prose that merely contains 'npm test' as a substring, and
// accept a genuine whole-suite reference.
//
// EXPECTED TO FAIL AT HEAD for the FALSE cases: HEAD's loose substring test
// (haystack.includes('npm test')) matches 'npm test:unit', 'npm test-integration',
// 'npm testHarness', and 'npm test was NOT run'.
// ─────────────────────────────────────────────────────────────────────────────

const DETECTION_CFG = {
  execution: { testAllCommand: 'npm run test:all', testCommand: 'npm test' },
};

// Cases that must be detected as NOT whole-suite (per-task / negated prose).
const NOT_WHOLE_SUITE_CASES = [
  'npm test:unit failed',
  'npm test-integration is red',
  'npm testHarness wrapper broke',
  'npm test was NOT run',
];

for (const desc of NOT_WHOLE_SUITE_CASES) {
  await test(`A3 (DETECTION FALSE): "${desc}" is NOT whole-suite`, async () => {
    if (typeof taskScopeCheckIsWholeSuite !== 'function') {
      throw new Error('taskScopeCheckIsWholeSuite is not exported as a function');
    }
    // Probe both via description and via evidence to be robust to which field
    // the implementation reads.
    const viaDesc = taskScopeCheckIsWholeSuite({ description: desc, evidence: '' }, DETECTION_CFG);
    const viaEvid = taskScopeCheckIsWholeSuite({ description: '', evidence: desc }, DETECTION_CFG);
    assert.strictEqual(viaDesc, false, `detection on description: "${desc}" must be FALSE (per-task / negated, not whole-suite)`);
    assert.strictEqual(viaEvid, false, `detection on evidence: "${desc}" must be FALSE (per-task / negated, not whole-suite)`);
  });
}

await test('A3 (DETECTION TRUE): "ran npm run test:all, 3 suites red" IS whole-suite', async () => {
  if (typeof taskScopeCheckIsWholeSuite !== 'function') {
    throw new Error('taskScopeCheckIsWholeSuite is not exported as a function');
  }
  const positive = 'ran npm run test:all, 3 suites red';
  const viaDesc = taskScopeCheckIsWholeSuite({ description: positive, evidence: '' }, DETECTION_CFG);
  assert.strictEqual(viaDesc, true, 'a genuine whole-suite reference must be detected as whole-suite');
});

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 4 (GUARDS — should already pass at HEAD).
// ─────────────────────────────────────────────────────────────────────────────

await test('A4a (GUARD): per-task hardCheck FAIL + only-whole-suite taskScopeCheck FAIL → verified:false', async () => {
  const root = makeTmpProject();
  try {
    const structuredOutput = {
      result: 'FAILED',
      hardChecks: [
        { name: 'node --check src/x.js', status: 'FAIL', evidence: 'SyntaxError: unexpected token' },
      ],
      taskScopeChecks: [
        { description: 'targetFiles match description', status: 'PASS', evidence: 'src/x.js updated' },
        {
          description: `ran ${TEST_ALL_CMD}, 3 suites red`,
          status: 'FAIL',
          evidence: `${TEST_ALL_CMD}: 250/249/1 red`,
        },
      ],
      standardsChecks: [],
      notes: 'a real hardCheck is red alongside the whole-suite check',
    };
    const { verifier } = makeMockSetup({ structuredOutput });
    const out = await verifier.verifyTask(makeTask(PER_TASK_ID), root, { specPath: path.join(root, 'spec.md') });
    assert.strictEqual(
      out.verified, false,
      'a genuine hardCheck FAIL must NOT be rescued by the whole-suite carve-out'
    );
  } finally { cleanup(root); }
});

await test('A4b (GUARD): non-whole-suite taskScopeCheck FAIL → verified:false', async () => {
  const root = makeTmpProject();
  try {
    const structuredOutput = {
      result: 'FAILED',
      hardChecks: [
        { name: 'npm test (per-task subset)', status: 'PASS', evidence: 'task tests green' },
      ],
      taskScopeChecks: [
        { description: 'targetFiles match description', status: 'PASS', evidence: 'src/x.js updated' },
        {
          description: 'function foo handles null input',
          status: 'FAIL',
          evidence: 'foo(null) throws instead of returning []',
        },
        {
          description: `ran ${TEST_ALL_CMD}, 3 suites red`,
          status: 'FAIL',
          evidence: `${TEST_ALL_CMD}: 250/249/1 red`,
        },
      ],
      standardsChecks: [],
      notes: 'a real per-task check is red alongside the whole-suite check',
    };
    const { verifier } = makeMockSetup({ structuredOutput });
    const out = await verifier.verifyTask(makeTask(PER_TASK_ID), root, { specPath: path.join(root, 'spec.md') });
    assert.strictEqual(
      out.verified, false,
      'a genuine per-task FAIL must NOT be rescued by the whole-suite carve-out'
    );
  } finally { cleanup(root); }
});

await test('A4c (GUARD): a normally PASSED verdict → verified:true', async () => {
  const root = makeTmpProject();
  try {
    const structuredOutput = {
      result: 'PASSED',
      hardChecks: [
        { name: 'npm test', status: 'PASS', evidence: '12 tests passed' },
      ],
      taskScopeChecks: [
        { description: 'targetFiles match description', status: 'PASS', evidence: 'src/x.js updated' },
      ],
      standardsChecks: [],
      notes: '',
    };
    const { verifier } = makeMockSetup({ structuredOutput });
    const out = await verifier.verifyTask(makeTask(PER_TASK_ID), root, { specPath: path.join(root, 'spec.md') });
    assert.strictEqual(out.verified, true, 'a PASSED verdict must stay verified:true');
  } finally { cleanup(root); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 5 (CONFIG-SOURCED): a NON-default testAllCommand is honored by the
// detection, and the literal default is NOT treated as whole-suite when it is
// not the configured command.
//
// config.js exports a singleton object the verifier reads live, so we mutate
// config.execution in-place and restore in finally.
// ─────────────────────────────────────────────────────────────────────────────

await test('A5 (CONFIG-SOURCED): a NON-default testAllCommand is honored; the literal default is NOT', async () => {
  const root = makeTmpProject();
  const CUSTOM = 'make test-all';
  const hadTestAll  = Object.prototype.hasOwnProperty.call(config.execution, 'testAllCommand');
  const prevTestAll = config.execution.testAllCommand;
  config.execution.testAllCommand = CUSTOM;
  try {
    // (i) a whole-suite FAIL referencing the CONFIGURED command → rescued.
    {
      const structuredOutput = {
        result: 'FAILED',
        hardChecks: [],
        taskScopeChecks: [
          { description: 'targetFiles match description', status: 'PASS', evidence: 'ok' },
          { description: `ran ${CUSTOM}, 3 red`, status: 'FAIL', evidence: `${CUSTOM}: 3 red` },
        ],
        standardsChecks: [],
        notes: 'whole-suite per configured command',
      };
      const { verifier } = makeMockSetup({ structuredOutput });
      const out = await verifier.verifyTask(makeTask(PER_TASK_ID), root, { specPath: path.join(root, 'spec.md') });
      assert.strictEqual(
        out.verified, true,
        `a FAIL check referencing the configured testAllCommand (${CUSTOM}) must be deferred → verified:true`
      );
    }

    // (ii) a whole-suite FAIL referencing the LITERAL default 'npm run test:all'
    //      is NOT the configured command, so it must NOT be rescued. (config.testCommand
    //      stays 'npm test'; 'npm run test:all' does not contain it.)
    {
      const structuredOutput = {
        result: 'FAILED',
        hardChecks: [],
        taskScopeChecks: [
          { description: 'targetFiles match description', status: 'PASS', evidence: 'ok' },
          {
            description: 'ran npm run test:all, 1 red',
            status: 'FAIL',
            evidence: 'npm run test:all: 1 red',
          },
        ],
        standardsChecks: [],
        notes: 'references the literal default, not the configured command',
      };
      const { verifier } = makeMockSetup({ structuredOutput });
      const out = await verifier.verifyTask(makeTask(PER_TASK_ID), root, { specPath: path.join(root, 'spec.md') });
      assert.strictEqual(
        out.verified, false,
        'a FAIL check referencing the literal default (not the configured command) must NOT be treated as whole-suite'
      );
    }
  } finally {
    if (hadTestAll) config.execution.testAllCommand = prevTestAll;
    else            delete config.execution.testAllCommand;
    cleanup(root);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
