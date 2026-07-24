/**
 * test-spec-consulted-honest-report.js — Regression tests for honest spec_consulted reporting.
 *
 * Verifies that back_reference_check.spec_consulted reflects ONLY whether the
 * verifier session actually READ the spec file (via _readFiles), NOT whether
 * compact spec context was injected into the prompt. The "spec_injected" field
 * is reported separately on specReadAudit so callers can distinguish the two
 * cases without conflating them.
 *
 * Regression: under the old `didReadSpec || specInjected` formula the
 * injected-but-not-read case falsely reported spec_consulted:true, making the
 * audit field untrustworthy as an honest read indicator.
 *
 * Run: node test/test-spec-consulted-honest-report.js
 * Expected output: 4 passed, 0 failed
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-honest-report-'));
}
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

/**
 * Build a mock setup. Returns { sessionManager, logger, tokenTracker, warnSpy }.
 *
 * @param {object} opts
 * @param {Array}  opts.readFiles     - value for handle._readFiles (array of paths)
 * @param {object|undefined} opts.structuredOutput - if undefined → stub (no structured_output)
 */
function makeMockSetup({ readFiles, structuredOutput }) {
  const warnSpy = { calls: [] };
  const spawnSpy = { calls: [] };

  const handle = {
    _readFiles: readFiles,
    _toolCallCount: 0,
    systemPromptTokens: 0,
  };

  const sdkResult = structuredOutput !== undefined
    ? { structured_output: structuredOutput }
    : {};

  const spawnResult = { handle, result: sdkResult };

  const thenable = Object.assign(Promise.resolve(spawnResult), { handle });

  const sessionManager = {
    spawn: (spawnOpts) => {
      spawnSpy.calls.push(spawnOpts);
      return thenable;
    },
  };

  const logger = {
    createSessionLog: () => ({ logPath: '/tmp/test-spec-audit.log', close: () => {} }),
    attachToSession: () => {},
    warn: (msg) => { warnSpy.calls.push(msg); },
    writeSessionSummary: async () => {},
    getSessionSummary: () => '',
  };

  const tokenTracker = { recordSession: async () => {} };

  return { sessionManager, logger, tokenTracker, warnSpy, spawnSpy };
}

// ── TC-HR-A: injected-but-not-read → spec_consulted===false, spec_injected===true ──
//
// The core regression: when _readFiles is empty (spec not physically read) but
// relevantCriteria is non-empty (compact spec context was injected into the
// prompt), spec_consulted must be FALSE on BOTH the on-disk sidecar and the
// in-memory verdict.structured. A separate spec_injected field must be TRUE.

await test('HR-A: readFiles:[] + non-empty relevantCriteria → spec_consulted===false and spec_injected===true on sidecar and verdict.structured', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const { sessionManager, logger, tokenTracker } = makeMockSetup({
      readFiles: [],  // spec NOT read by the verifier session
      structuredOutput: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: {
          spec_consulted: false,
          plan_consulted: false,
          deviations: [],
        },
      },
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'hr-a-task', description: 'test', targetFiles: [] };

    const verdict = await verifier.verifyTask(task, projectRoot, {
      specPath,
      specGoal: 'some goal',
      relevantCriteria: [
        { description: 'A relevant criterion', verification: { kind: 'command', command: 'node test/test-z.js' } },
      ],
    });

    const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    // TC1: sidecar.back_reference_check.spec_consulted === false
    assert.strictEqual(
      parsed.back_reference_check.spec_consulted,
      false,
      `sidecar: spec_consulted must be false when spec was not read (even though relevantCriteria were injected). Got: ${parsed.back_reference_check.spec_consulted}`,
    );

    // TC1: sidecar injection-presence field === true
    assert.strictEqual(
      parsed.back_reference_check.spec_injected,
      true,
      `sidecar: back_reference_check.spec_injected must be true when relevantCriteria were injected. Got: ${parsed.back_reference_check && parsed.back_reference_check.spec_injected}`,
    );

    // TC2: verdict.structured.back_reference_check.spec_consulted === false
    assert.strictEqual(
      verdict.structured.back_reference_check.spec_consulted,
      false,
      `verdict.structured: spec_consulted must be false when spec was not read (even though relevantCriteria were injected). Got: ${verdict.structured.back_reference_check.spec_consulted}`,
    );

    // TC2: verdict.structured injection-presence field === true
    assert.strictEqual(
      verdict.structured.back_reference_check.spec_injected,
      true,
      `verdict.structured: back_reference_check.spec_injected must be true when relevantCriteria were injected. Got: ${verdict.structured.back_reference_check && verdict.structured.back_reference_check.spec_injected}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC-HR-B-read-no-injection: spec READ, no injection → spec_consulted===true ───

await test('HR-B-read-no-injection: readFiles:[specPath] + relevantCriteria:[] → spec_consulted===true on sidecar and verdict.structured', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const { sessionManager, logger, tokenTracker } = makeMockSetup({
      readFiles: [specPath],  // spec WAS read
      structuredOutput: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: {
          spec_consulted: false,
          plan_consulted: false,
          deviations: [],
        },
      },
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'hr-b-no-inj-task', description: 'test', targetFiles: [] };

    const verdict = await verifier.verifyTask(task, projectRoot, {
      specPath,
      specGoal: '',
      relevantCriteria: [],  // no injection
    });

    const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    // TC3: sidecar spec_consulted === true (spec was read)
    assert.strictEqual(
      parsed.back_reference_check.spec_consulted,
      true,
      `sidecar: spec_consulted must be true when spec file was read. Got: ${parsed.back_reference_check.spec_consulted}`,
    );

    // TC3: verdict.structured spec_consulted === true
    assert.strictEqual(
      verdict.structured.back_reference_check.spec_consulted,
      true,
      `verdict.structured: spec_consulted must be true when spec file was read. Got: ${verdict.structured.back_reference_check.spec_consulted}`,
    );

    // spec_injected must be false (no relevantCriteria)
    assert.strictEqual(
      parsed.back_reference_check.spec_injected,
      false,
      `sidecar: back_reference_check.spec_injected must be false when relevantCriteria were empty. Got: ${parsed.back_reference_check && parsed.back_reference_check.spec_injected}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC-HR-B-read-with-injection: spec READ AND injected → spec_consulted===true ──

await test('HR-B-read-with-injection: readFiles:[specPath] + non-empty relevantCriteria → spec_consulted===true and spec_injected===true on both', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const { sessionManager, logger, tokenTracker } = makeMockSetup({
      readFiles: [specPath],  // spec WAS read
      structuredOutput: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: {
          spec_consulted: false,
          plan_consulted: false,
          deviations: [],
        },
      },
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'hr-b-with-inj-task', description: 'test', targetFiles: [] };

    const verdict = await verifier.verifyTask(task, projectRoot, {
      specPath,
      specGoal: 'some goal',
      relevantCriteria: [
        { description: 'A relevant criterion', verification: { kind: 'command', command: 'node test/test-w.js' } },
      ],
    });

    const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    // TC4: sidecar spec_consulted === true (read takes priority; also injected)
    assert.strictEqual(
      parsed.back_reference_check.spec_consulted,
      true,
      `sidecar: spec_consulted must be true when spec file was read. Got: ${parsed.back_reference_check.spec_consulted}`,
    );

    // TC4: sidecar spec_injected === true
    assert.strictEqual(
      parsed.back_reference_check.spec_injected,
      true,
      `sidecar: back_reference_check.spec_injected must be true when relevantCriteria were injected. Got: ${parsed.back_reference_check && parsed.back_reference_check.spec_injected}`,
    );

    // TC4: verdict.structured spec_consulted === true
    assert.strictEqual(
      verdict.structured.back_reference_check.spec_consulted,
      true,
      `verdict.structured: spec_consulted must be true when spec file was read. Got: ${verdict.structured.back_reference_check.spec_consulted}`,
    );

    // TC4: verdict.structured spec_injected === true
    assert.strictEqual(
      verdict.structured.back_reference_check.spec_injected,
      true,
      `verdict.structured: back_reference_check.spec_injected must be true when relevantCriteria were injected. Got: ${verdict.structured.back_reference_check && verdict.structured.back_reference_check.spec_injected}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC-HR-C: disk ≡ in-memory (back_reference_check parity) ──────────────────
//
// Confirms that the back_reference_check written to the sidecar JSON is
// deepStrictEqual to the one returned in verdict.structured (no silent
// divergence between the on-disk SoT and the in-memory value returned to the
// pipeline).

await test('HR-C: disk back_reference_check deepStrictEqual verdict.structured.back_reference_check', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    // Use the injected-but-not-read scenario (the regression case) for parity check.
    const { sessionManager, logger, tokenTracker } = makeMockSetup({
      readFiles: [],
      structuredOutput: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: {
          spec_consulted: false,
          plan_consulted: false,
          deviations: [],
        },
      },
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'hr-c-task', description: 'test', targetFiles: [] };

    const verdict = await verifier.verifyTask(task, projectRoot, {
      specPath,
      specGoal: 'parity check goal',
      relevantCriteria: [
        { description: 'parity criterion', verification: { kind: 'command', command: 'node test/test-p.js' } },
      ],
    });

    const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    // TC5: disk === in-memory
    assert.deepStrictEqual(
      parsed.back_reference_check,
      verdict.structured.back_reference_check,
      `disk back_reference_check must deepStrictEqual verdict.structured.back_reference_check.\nDisk: ${JSON.stringify(parsed.back_reference_check)}\nIn-memory: ${JSON.stringify(verdict.structured.back_reference_check)}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
