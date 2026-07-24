/**
 * test-verifier-spec-read-audit.js — Tests for the spec-read audit feature in verifier.js.
 *
 * No Claude auth, no live sessions. Uses mock sessionManager/logger/tokenTracker
 * whose `spawn` returns a thenable resolving to { handle, result }.
 *
 * Run: node test/test-verifier-spec-read-audit.js
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-spec-audit-'));
}
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

/**
 * Build a mock setup. Returns { sessionManager, logger, tokenTracker, warnSpy }.
 *
 * @param {object} opts
 * @param {Array}  opts.readFiles     - value for handle._readFiles (array of paths)
 * @param {object|undefined} opts.structuredOutput - if undefined → stub (no structured_output)
 *
 * The returned `spawnSpy` captures the options object passed to
 * sessionManager.spawn(...) (including `opts.prompt`), so callers can assert on
 * the verifier prompt that verifyTask built.
 */
function makeMockSetup({ readFiles, structuredOutput }) {
  const warnSpy = { calls: [] };
  const spawnSpy = { calls: [] };

  const handle = {
    _readFiles: readFiles,
    _toolCallCount: 0,
    systemPromptTokens: 0,
  };

  // When structuredOutput is undefined, omit structured_output to trigger stub path.
  const sdkResult = structuredOutput !== undefined
    ? { structured_output: structuredOutput }
    : {};

  const spawnResult = { handle, result: sdkResult };

  // The thenable must expose .handle synchronously (for attachToSession call)
  // AND resolve to { handle, result } when awaited.
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

// ── AC1a: didReadSpec=true when _readFiles contains resolved specPath ─────────

await test('AC1: didReadSpec=true when _readFiles contains resolved specPath', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const { sessionManager, logger, tokenTracker } = makeMockSetup({
      readFiles: [specPath],
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
    const task = { id: 'ac1a-task', description: 'test', targetFiles: [] };

    await verifier.verifyTask(task, projectRoot, { specPath });

    const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    assert.strictEqual(
      parsed.specReadAudit.didReadSpec,
      true,
      `expected specReadAudit.didReadSpec === true, got ${parsed.specReadAudit.didReadSpec}`,
    );
    assert.strictEqual(
      parsed.specReadAudit.specPath,
      specPath,
      `expected specReadAudit.specPath === specPath, got ${parsed.specReadAudit.specPath}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── AC1b: didReadSpec=false when _readFiles excludes resolved specPath ────────

await test('AC1: didReadSpec=false when _readFiles excludes resolved specPath', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const someOtherFile = path.join(projectRoot, 'other.md');
    fs.writeFileSync(someOtherFile, '# Other\n');

    const { sessionManager, logger, tokenTracker } = makeMockSetup({
      readFiles: [someOtherFile],
      structuredOutput: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: {
          spec_consulted: true,
          plan_consulted: false,
          deviations: [],
        },
      },
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'ac1b-task', description: 'test', targetFiles: [] };

    await verifier.verifyTask(task, projectRoot, { specPath });

    const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    assert.strictEqual(
      parsed.specReadAudit.didReadSpec,
      false,
      `expected specReadAudit.didReadSpec === false, got ${parsed.specReadAudit.didReadSpec}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── AC1c: no realpathSync in verifier.js audit path (grep guard) ──────────────

await test('AC1: no realpathSync introduced in verifier.js audit path (grep guard)', () => {
  const verifierPath = path.resolve(__dirname, '../src/orchestrator/agents/verifier.js');
  const source = fs.readFileSync(verifierPath, 'utf8');
  assert.ok(
    !/realpathSync/.test(source),
    'verifier.js must not use realpathSync in the audit path — use path.resolve() only',
  );
});

// ── AC2: self-reported spec_consulted:true overridden when _readFiles lacks specPath

await test('AC2: self-reported spec_consulted:true is overridden to false when _readFiles lacks specPath', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const { sessionManager, logger, tokenTracker } = makeMockSetup({
      readFiles: [],
      structuredOutput: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: {
          spec_consulted: true,  // self-reported true — should be overridden to false
          plan_consulted: false,
          deviations: [],
        },
      },
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'ac2-task', description: 'test', targetFiles: [] };

    await verifier.verifyTask(task, projectRoot, { specPath });

    const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    assert.strictEqual(
      parsed.back_reference_check.spec_consulted,
      false,
      'spec_consulted should be overridden to false when _readFiles does not contain specPath',
    );
    assert.strictEqual(
      parsed.specReadAudit.didReadSpec,
      false,
      'specReadAudit.didReadSpec should be false',
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── AC3: extractVerdict without audit info preserves back_reference_check verbatim

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

await test('AC3: extractVerdict without audit info preserves back_reference_check verbatim', async () => {
  const { extractVerdict } = await import('../src/orchestrator/agents/verifier.js');
  const dir = tempDir();
  try {
    const out = extractVerdict(fixtureBrc, 'ac3', dir);

    assert.deepStrictEqual(
      out.structured.back_reference_check,
      fixtureBrc.structured_output.back_reference_check,
      'extractVerdict must preserve back_reference_check verbatim in the returned structured object',
    );

    const sidecarPath = path.join(dir, 'verification', 'task-ac3.json');
    assert.ok(fs.existsSync(sidecarPath), 'sidecar file must be written');
    const parsedSidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    assert.deepStrictEqual(
      parsedSidecar.back_reference_check,
      fixtureBrc.structured_output.back_reference_check,
      'sidecar must contain verbatim back_reference_check when no audit opts are passed',
    );
  } finally {
    cleanup(dir);
  }
});

// ── AC4a: verdict.isStub → no specReadAudit, no spec-read warn ───────────────

await test('AC4: verdict.isStub leaves spec_consulted untouched, no specReadAudit, no warn', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    // No structured_output → stub branch (verdict.isStub === true)
    const { sessionManager, logger, tokenTracker, warnSpy } = makeMockSetup({
      readFiles: [],
      structuredOutput: undefined,
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'ac4a-task', description: 'test', targetFiles: [] };

    await verifier.verifyTask(task, projectRoot, { specPath });

    const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    assert.ok(
      !('specReadAudit' in parsed),
      `specReadAudit must not appear in stub sidecar, got keys: ${Object.keys(parsed).join(', ')}`,
    );

    // No back_reference_check mutation (stub has no back_reference_check at all)
    assert.ok(
      !('back_reference_check' in parsed),
      'stub sidecar must not have back_reference_check',
    );

    // No spec-read warn (audit path is skipped entirely for stubs)
    const specReadWarns = warnSpy.calls.filter(m => /specPath/.test(m) && /not read/.test(m));
    assert.strictEqual(
      specReadWarns.length,
      0,
      `expected 0 spec-read warn calls, got: ${JSON.stringify(specReadWarns)}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── AC4b: regression-* task → no specReadAudit, spec_consulted untouched ─────

await test('AC4: regression-* task id leaves spec_consulted untouched, no specReadAudit, no warn', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const { sessionManager, logger, tokenTracker, warnSpy } = makeMockSetup({
      readFiles: [],  // spec not read — but audit should be skipped for regression tasks
      structuredOutput: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: {
          spec_consulted: true,  // should remain true (audit skipped for regression-*)
          plan_consulted: false,
          deviations: [],
        },
      },
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    // regression-* prefix → audit path is bypassed
    const task = { id: 'regression-foo', description: 'test', targetFiles: [] };

    await verifier.verifyRegression(task, projectRoot, { specPath });

    const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    assert.ok(
      !('specReadAudit' in parsed),
      `specReadAudit must not appear in regression task sidecar, got keys: ${Object.keys(parsed).join(', ')}`,
    );

    assert.strictEqual(
      parsed.back_reference_check.spec_consulted,
      true,
      'spec_consulted must remain unchanged (true) for regression-* tasks',
    );

    // No spec-read warn
    const specReadWarns = warnSpy.calls.filter(m => /specPath/.test(m) && /not read/.test(m));
    assert.strictEqual(
      specReadWarns.length,
      0,
      `expected 0 spec-read warn calls for regression task, got: ${JSON.stringify(specReadWarns)}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── AC5: PASSED + _readFiles lacks specPath → warn emitted, verdict.verified=true

await test('AC5: PASSED + _readFiles lacks specPath emits warn but verdict.verified stays true', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const { sessionManager, logger, tokenTracker, warnSpy } = makeMockSetup({
      readFiles: [],  // spec was NOT read by the verifier session
      structuredOutput: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: {
          spec_consulted: true,
          plan_consulted: false,
          deviations: [],
        },
      },
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'ac5-task', description: 'test', targetFiles: [] };

    const verdict = await verifier.verifyTask(task, projectRoot, { specPath });

    // 1. verdict.verified remains true — spec-read failure is warn-only, never forced FAIL
    assert.strictEqual(
      verdict.verified,
      true,
      `expected verdict.verified === true (PASSED is not overridden), got ${verdict.verified}`,
    );

    // 2. warn spy captured a message containing both task.id and specPath
    const specReadWarns = warnSpy.calls.filter(
      m => m.includes(task.id) && m.includes(specPath),
    );
    assert.ok(
      specReadWarns.length > 0,
      `expected at least one warn containing task.id ("${task.id}") and specPath ("${specPath}"), got calls: ${JSON.stringify(warnSpy.calls)}`,
    );

    // 3. sidecar has specReadAudit.didReadSpec === false
    const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    assert.strictEqual(
      parsed.specReadAudit.didReadSpec,
      false,
      `expected parsed.specReadAudit.didReadSpec === false, got ${parsed.specReadAudit.didReadSpec}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── SI1: relevantCriteria non-empty → prompt CONTAINS the criterion description
//
// When context.relevantCriteria is non-empty, verifyTask injects a compact spec
// back-reference block (goal + each relevant criterion's description). We capture
// the prompt via spawnSpy and assert the criterion description 'X' appears.

await test('SI1: relevantCriteria non-empty → captured prompt contains the criterion description', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      readFiles: [specPath],
      structuredOutput: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
      },
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'si1-task', description: 'test', targetFiles: [] };

    await verifier.verifyTask(task, projectRoot, {
      specPath,
      specGoal: 'Inject compact spec context into the verifier.',
      relevantCriteria: [
        { description: 'UNIQUE_CRITERION_DESCRIPTION_X', verification: { kind: 'command', command: 'node test/test-x.js' } },
      ],
    });

    assert.strictEqual(spawnSpy.calls.length, 1, 'spawn must be called exactly once');
    const prompt = spawnSpy.calls[0].prompt;
    assert.strictEqual(typeof prompt, 'string', 'spawn was called with a string prompt');
    assert.ok(
      prompt.includes('UNIQUE_CRITERION_DESCRIPTION_X'),
      `prompt must contain the injected criterion description (the back-reference block). Prompt was:\n${prompt}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── SI2: relevantCriteria empty → prompt has NO spec back-reference block ─────
//
// For generic infra tasks (no relevant criteria) the prompt must be byte-identical
// to today — i.e. no injected criterion descriptions. We capture two prompts: one
// built with a relevantCriteria entry whose description is a sentinel, and one
// built with relevantCriteria=[]; the empty-criteria prompt must NOT contain the
// sentinel that only appears when injection happens.

await test('SI2: relevantCriteria empty → captured prompt has no spec back-reference block', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const SENTINEL = 'SENTINEL_CRITERION_DESC_ONLY_WHEN_INJECTED';

    // First: with a relevant criterion whose description is the sentinel.
    const withSetup = makeMockSetup({
      readFiles: [specPath],
      structuredOutput: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
      },
    });
    const withVerifier = new Verifier(withSetup.sessionManager, withSetup.logger, withSetup.tokenTracker);
    await withVerifier.verifyTask(
      { id: 'si2-with', description: 'test', targetFiles: [] },
      projectRoot,
      {
        specPath,
        specGoal: 'some goal',
        relevantCriteria: [{ description: SENTINEL, verification: { kind: 'command', command: 'node test/test-y.js' } }],
      },
    );
    const withPrompt = withSetup.spawnSpy.calls[0].prompt;
    assert.ok(
      withPrompt.includes(SENTINEL),
      'sanity: prompt WITH a relevant criterion must contain the sentinel description',
    );

    // Second: empty relevantCriteria → no injection → sentinel absent.
    const emptySetup = makeMockSetup({
      readFiles: [specPath],
      structuredOutput: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
      },
    });
    const emptyVerifier = new Verifier(emptySetup.sessionManager, emptySetup.logger, emptySetup.tokenTracker);
    await emptyVerifier.verifyTask(
      { id: 'si2-empty', description: 'test', targetFiles: [] },
      projectRoot,
      { specPath, specGoal: 'some goal', relevantCriteria: [] },
    );
    const emptyPrompt = emptySetup.spawnSpy.calls[0].prompt;
    assert.ok(
      !emptyPrompt.includes(SENTINEL),
      `prompt with relevantCriteria=[] must NOT contain an injected criterion description. Prompt was:\n${emptyPrompt}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── SI3: spec NOT read BUT relevantCriteria non-empty → spec_consulted true, no warn
//
// Audit coherence (honest reporting): spec_consulted = didReadSpec only.
// When the verifier session did NOT read specPath, spec_consulted is false even
// if the compact context WAS injected — injection is reported separately as
// spec_injected, and the "specPath not read" warn still fires on genuine non-read.

await test('SI3: spec not read BUT relevantCriteria non-empty → spec_consulted===false, spec_injected===true, and spec-read warn fires', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    // _readFiles empty → session did NOT read the spec.
    const { sessionManager, logger, tokenTracker, warnSpy } = makeMockSetup({
      readFiles: [],
      structuredOutput: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
      },
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'si3-task', description: 'test', targetFiles: [] };

    await verifier.verifyTask(task, projectRoot, {
      specPath,
      specGoal: 'some goal',
      relevantCriteria: [
        { description: 'A relevant criterion', verification: { kind: 'command', command: 'node test/test-z.js' } },
      ],
    });

    const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    assert.strictEqual(
      parsed.specReadAudit.didReadSpec,
      false,
      'didReadSpec must be false (session did not read specPath)',
    );
    assert.strictEqual(
      parsed.back_reference_check.spec_consulted,
      false,
      'spec_consulted must reflect actual consultation (raw didReadSpec) only — injection alone does not count as consulted',
    );
    assert.strictEqual(
      parsed.back_reference_check.spec_injected,
      true,
      'spec_injected must be reported separately as true when relevantCriteria were injected',
    );

    const specReadWarns = warnSpy.calls.filter(m => m.includes(task.id) && m.includes(specPath));
    assert.ok(
      specReadWarns.length >= 1,
      `the "specPath not read" warn must fire on genuine non-read, even when context was injected. Got: ${JSON.stringify(specReadWarns)}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── SI4: spec NOT read AND relevantCriteria empty → spec_consulted false, warn fires
//
// Existing behavior preserved: when neither holds (no read, no injection), the
// derived spec_consulted is false and the "specPath not read" warn fires.

await test('SI4: spec not read AND relevantCriteria empty → spec_consulted===false and the spec-read warn fires', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const { sessionManager, logger, tokenTracker, warnSpy } = makeMockSetup({
      readFiles: [],
      structuredOutput: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: { spec_consulted: true, plan_consulted: false, deviations: [] },
      },
    });

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'si4-task', description: 'test', targetFiles: [] };

    await verifier.verifyTask(task, projectRoot, {
      specPath,
      specGoal: '',
      relevantCriteria: [],
    });

    const sidecarPath = path.join(harnessDir, 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    assert.strictEqual(
      parsed.specReadAudit.didReadSpec,
      false,
      'didReadSpec must be false (session did not read specPath)',
    );
    assert.strictEqual(
      parsed.back_reference_check.spec_consulted,
      false,
      'spec_consulted must be false when neither read nor injection occurred',
    );

    const specReadWarns = warnSpy.calls.filter(m => m.includes(task.id) && m.includes(specPath));
    assert.ok(
      specReadWarns.length > 0,
      `the "specPath not read" warn must fire when neither read nor injection occurred. Got: ${JSON.stringify(warnSpy.calls)}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
