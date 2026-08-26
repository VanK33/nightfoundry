/**
 * test-verifier-callsite-plumbing.js — Verifier callsite and plumbing tests.
 *
 * Tests that the three callsites in pipeline.js were refactored from
 * `this.state?.projectMeta?.prdPath` to `readState(...)`, that verifyTask
 * validates its context argument, and that the verifierContextSchema works
 * as documented.
 *
 * Sidecar/state reads below resolve through activeHarnessDir(dir) rather
 * than a hardcoded flat `.harness` join, so these fixtures keep reading the
 * correct location if a future revision claims a per-run harness dir here
 * (see run-context.js). None of the fixtures in this file currently claim
 * the active-run pointer, so this is a no-op today (activeHarnessDir falls
 * back to the flat harnessRoot). The marker is cleared unconditionally
 * anyway, mirroring scripts/run-tests.js and test/helpers/make-run.js, so
 * this file stays re-entrancy-neutral regardless of launch context.
 *
 * The verifier/verifyTask context and the options forwarded from it may now
 * also carry `denyForeignPendingBash` and `foreignPendingFiles` as options
 * keys; the fixtures below accept both keys wherever they appear without
 * asserting on them.
 *
 * Run: node test/test-verifier-callsite-plumbing.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { fileURLToPath } from 'url';
import { activeHarnessDir } from '../src/orchestrator/core/run-context.js';
import { readQueueEntry } from '../src/orchestrator/core/state.js';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-plumbing-'));
}
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

// ── CT1: grep-based callsite validation ─────────────────────────────────────

await test('CT1: pipeline.js does not contain this.state?.projectMeta?.prdPath', () => {
  const pipelinePath = path.resolve(__dirname, '../src/orchestrator/core/pipeline.js');
  const source = fs.readFileSync(pipelinePath, 'utf8');
  assert.ok(
    !source.includes('this.state?.projectMeta?.prdPath'),
    'pipeline.js still contains this.state?.projectMeta?.prdPath — all 3 callsites must be replaced with readState()',
  );
});

// ── CT2: null specPath throw ──────────────────────────────────────────────────

await test('CT2: verifyTask throws on empty specPath', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const mockSessionManager = {
    spawn: async () => { throw new Error('spawn should not be called on validation error'); },
  };
  const mockLogger = {
    createSessionLog: () => ({ logPath: '/tmp/test.log', close: () => {} }),
    attachToSession: () => {},
    warn: () => {},
    writeSessionSummary: async () => {},
    getSessionSummary: () => '',
  };
  const mockTokenTracker = { recordSession: async () => {} };
  const verifier = new Verifier(mockSessionManager, mockLogger, mockTokenTracker);
  const task = { id: 'test-ct2', description: 'test task', targetFiles: [] };
  const projectRoot = tempDir();
  try {
    let threw = false;
    try {
      await verifier.verifyTask(task, projectRoot, { specPath: '' });
    } catch (err) {
      threw = true;
      assert.ok(
        /context\.specPath is required/.test(err.message),
        `Expected error matching /context\\.specPath is required/, got: "${err.message}"`,
      );
    }
    assert.ok(threw, 'expected verifyTask to throw on empty specPath');
  } finally {
    cleanup(projectRoot);
  }
});

// ── CT3: missing file throw ───────────────────────────────────────────────────

await test('CT3: verifyTask throws on nonexistent specPath file', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const mockSessionManager = {
    spawn: async () => { throw new Error('spawn should not be called on validation error'); },
  };
  const mockLogger = {
    createSessionLog: () => ({ logPath: '/tmp/test.log', close: () => {} }),
    attachToSession: () => {},
    warn: () => {},
    writeSessionSummary: async () => {},
    getSessionSummary: () => '',
  };
  const mockTokenTracker = { recordSession: async () => {} };
  const verifier = new Verifier(mockSessionManager, mockLogger, mockTokenTracker);
  const task = { id: 'test-ct3', description: 'test task', targetFiles: [] };
  const projectRoot = tempDir();
  try {
    let threw = false;
    try {
      await verifier.verifyTask(task, projectRoot, { specPath: '/nonexistent/path/spec.md' });
    } catch (err) {
      threw = true;
      assert.ok(
        /specPath file does not exist/.test(err.message),
        `Expected error matching /specPath file does not exist/, got: "${err.message}"`,
      );
    }
    assert.ok(threw, 'expected verifyTask to throw on nonexistent specPath file');
  } finally {
    cleanup(projectRoot);
  }
});

// ── CT4: schema validation ────────────────────────────────────────────────────

await test('CT4: verifierContextSchema validates correct/incorrect context objects', async () => {
  const { verifierContextSchema, validateStructured } = await import('../src/orchestrator/agents/_schemas.js');

  // Valid context with non-empty specPath
  const r1 = validateStructured({ specPath: '/a/b.md' }, verifierContextSchema);
  assert.equal(r1.ok, true, `Expected ok:true for {specPath: '/a/b.md'}, got: ${JSON.stringify(r1)}`);

  // Missing specPath (required field absent)
  const r2 = validateStructured({}, verifierContextSchema);
  assert.equal(r2.ok, false, `Expected ok:false for {}, got: ${JSON.stringify(r2)}`);

  // Empty specPath violates minLength:1
  const r3 = validateStructured({ specPath: '' }, verifierContextSchema);
  assert.equal(r3.ok, false, `Expected ok:false for {specPath: ''}, got: ${JSON.stringify(r3)}`);
});

// ── CT5: dryRunValidate persists queue entry ─────────────────────────────────

await test('CT5: dryRunValidate persists the queue entry for the spec', async () => {
  const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');
  const { bootstrap } = await import('../src/orchestrator/core/bootstrap.js');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-plumbing-dry-'));
  fs.mkdirSync(tmpDir, { recursive: true });
  bootstrap(tmpDir, {});

  const specPath = path.join(tmpDir, 'spec.md');
  fs.writeFileSync(specPath, '# Test Spec\n\nBuild something.');
  // Sibling spec.json fixture — the uncheckable-spec gate fails closed on a
  // bare .md, so the .md spec fixture needs a parseable sibling json.
  fs.writeFileSync(
    path.join(tmpDir, 'spec.json'),
    JSON.stringify({
      goal: 'Build something.',
      target_files: ['src/foo.js'],
      acceptance_criteria: [{ description: 'it works', verification: { kind: 'manual' } }],
    }),
  );

  const pipeline = new Pipeline(tmpDir, {
    onLog: () => {},
    onConfirm: async () => true,
  });

  pipeline._runPreflight = () => {};

  const cannedGlobalPlan = {
    milestones: [
      {
        id: '001',
        description: 'Core setup',
        missions: [{ id: '001-001', description: 'Initialize' }],
      },
    ],
  };

  pipeline.planner.planGlobal = async () => JSON.parse(JSON.stringify(cannedGlobalPlan));
  pipeline.planner.planMission = async (miId) => {
    throw new Error(`planMission should never be called in dryRunValidate (called with: ${miId})`);
  };
  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.closeReusableSession = async () => {};

  try {
    await pipeline.dryRunValidate('Build a sample app', { prdPath: specPath });

    // dryRunValidate self-cleans its per-run scratch harness dir on success,
    // so no state.json persists at any flat or per-run path. Assert against
    // the durable queue entry instead, the same way sibling
    // test-dry-run-queue.js TC5/TC10 do.
    const queueDir = path.join(tmpDir, 'queue');
    const slugs = fs.readdirSync(queueDir).filter((s) => {
      try {
        return fs.statSync(path.join(queueDir, s)).isDirectory();
      } catch {
        return false;
      }
    });
    assert.strictEqual(
      slugs.length,
      1,
      `expected exactly one queue entry subdirectory under "${queueDir}", got: ${JSON.stringify(slugs)}`,
    );
    const slug = slugs[0];

    const queueSpecPath = path.join(queueDir, slug, 'spec.md');
    assert.ok(
      fs.existsSync(queueSpecPath),
      `queue entry spec.md should exist at "${queueSpecPath}" after dryRunValidate`,
    );

    const entry = readQueueEntry(tmpDir, slug);
    assert.ok(
      entry,
      `queue entry for slug "${slug}" should be persisted after dryRunValidate`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── CT6: JSDoc presence ───────────────────────────────────────────────────────

await test('CT6: verifier.js contains "control outputs, not inputs" JSDoc anchor', () => {
  const verifierPath = path.resolve(__dirname, '../src/orchestrator/agents/verifier.js');
  const source = fs.readFileSync(verifierPath, 'utf8');
  assert.ok(
    source.includes('control outputs, not inputs'),
    'verifier.js does not contain the JSDoc string "control outputs, not inputs" — expected in a comment or JSDoc block',
  );
});

// ── A1: didReadSpec=true path ─────────────────────────────────────────────────

await test('A1: didReadSpec=true — sidecar has specReadAudit.didReadSpec===true and back_reference_check.spec_consulted===true', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');

  const dir = tempDir();
  try {
    const specPath = path.join(dir, 'spec-a1.md');
    fs.writeFileSync(specPath, '# Spec A1\n');

    const handle = { _readFiles: [specPath], _toolCallCount: 0, systemPromptTokens: 0 };
    const sdkResult = {
      structured_output: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
      },
    };

    const warnMessages = [];
    const mockLogger = {
      createSessionLog: () => ({ logPath: '/tmp/test-a1.log', close: () => {} }),
      attachToSession: () => {},
      warn: (msg) => warnMessages.push(msg),
      writeSessionSummary: async () => {},
      getSessionSummary: () => '',
    };
    const mockTokenTracker = { recordSession: async () => {} };
    const mockSessionManager = {
      spawn: () => {
        const p = Promise.resolve({ handle, result: sdkResult });
        p.handle = handle;
        return p;
      },
    };

    const verifier = new Verifier(mockSessionManager, mockLogger, mockTokenTracker);
    const task = { id: '001-001-001-A1', description: 'test task A1', targetFiles: [] };

    const verdict = await verifier.verifyTask(task, dir, { specPath });

    assert.strictEqual(verdict.verified, true, 'verdict.verified should be true for PASSED result');

    const sidecarPath = path.join(activeHarnessDir(dir), 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    assert.ok('specReadAudit' in parsed, 'sidecar must have specReadAudit key');
    assert.strictEqual(parsed.specReadAudit.didReadSpec, true, 'specReadAudit.didReadSpec must be true');
    assert.strictEqual(parsed.specReadAudit.specPath, specPath, 'specReadAudit.specPath must equal specPath');
    assert.strictEqual(parsed.back_reference_check.spec_consulted, true, 'back_reference_check.spec_consulted must be true');
  } finally {
    cleanup(dir);
  }
});

// ── A2: didReadSpec=false path ────────────────────────────────────────────────

await test('A2: didReadSpec=false — spec_consulted===false and logger.warn names taskId and specPath', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');

  const dir = tempDir();
  try {
    const specPath = path.join(dir, 'spec-a2.md');
    fs.writeFileSync(specPath, '# Spec A2\n');

    // _readFiles does NOT include specPath
    const handle = { _readFiles: ['/some/other/file.js'], _toolCallCount: 0, systemPromptTokens: 0 };
    const sdkResult = {
      structured_output: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: { spec_consulted: true, plan_consulted: false, deviations: [] },
      },
    };

    const warnMessages = [];
    const mockLogger = {
      createSessionLog: () => ({ logPath: '/tmp/test-a2.log', close: () => {} }),
      attachToSession: () => {},
      warn: (msg) => warnMessages.push(msg),
      writeSessionSummary: async () => {},
      getSessionSummary: () => '',
    };
    const mockTokenTracker = { recordSession: async () => {} };
    const mockSessionManager = {
      spawn: () => {
        const p = Promise.resolve({ handle, result: sdkResult });
        p.handle = handle;
        return p;
      },
    };

    const verifier = new Verifier(mockSessionManager, mockLogger, mockTokenTracker);
    const task = { id: '001-001-001-A2', description: 'test task A2', targetFiles: [] };

    const verdict = await verifier.verifyTask(task, dir, { specPath });

    assert.strictEqual(verdict.verified, true, 'verdict.verified should be true for PASSED result');

    const sidecarPath = path.join(activeHarnessDir(dir), 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    assert.ok('specReadAudit' in parsed, 'sidecar must have specReadAudit key');
    assert.strictEqual(parsed.specReadAudit.didReadSpec, false, 'specReadAudit.didReadSpec must be false');
    assert.strictEqual(parsed.back_reference_check.spec_consulted, false, 'back_reference_check.spec_consulted must be false');

    const warnMatch = warnMessages.find((m) => m.includes(task.id) && m.includes(specPath));
    assert.ok(warnMatch !== undefined, `logger.warn must be called with a message containing task.id "${task.id}" and specPath "${specPath}". Got: ${JSON.stringify(warnMessages)}`);
  } finally {
    cleanup(dir);
  }
});

// ── A3: stub branch ───────────────────────────────────────────────────────────

await test('A3: stub branch (no structured_output) — sidecar has NO specReadAudit key', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');

  const dir = tempDir();
  try {
    const specPath = path.join(dir, 'spec-a3.md');
    fs.writeFileSync(specPath, '# Spec A3\n');

    const handle = { _readFiles: [specPath], _toolCallCount: 0, systemPromptTokens: 0 };
    // null sdkResult → extractStructured returns null → stub
    const sdkResult = null;

    const mockLogger = {
      createSessionLog: () => ({ logPath: '/tmp/test-a3.log', close: () => {} }),
      attachToSession: () => {},
      warn: () => {},
      writeSessionSummary: async () => {},
      getSessionSummary: () => '',
    };
    const mockTokenTracker = { recordSession: async () => {} };
    const mockSessionManager = {
      spawn: () => {
        const p = Promise.resolve({ handle, result: sdkResult });
        p.handle = handle;
        return p;
      },
    };

    const verifier = new Verifier(mockSessionManager, mockLogger, mockTokenTracker);
    const task = { id: '001-001-001-A3', description: 'test task A3', targetFiles: [] };

    const verdict = await verifier.verifyTask(task, dir, { specPath });

    assert.strictEqual(verdict.isStub, true, 'verdict.isStub must be true when no structured_output');
    assert.strictEqual(verdict.verified, false, 'verdict.verified must be false for stub');

    const sidecarPath = path.join(activeHarnessDir(dir), 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    assert.ok(!('specReadAudit' in parsed), `sidecar must NOT have specReadAudit key for stub branch. Got: ${JSON.stringify(Object.keys(parsed))}`);
  } finally {
    cleanup(dir);
  }
});

// ── A4: regression- prefix ────────────────────────────────────────────────────

await test('A4: task.id starting with "regression-" — sidecar has NO specReadAudit key', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');

  const dir = tempDir();
  try {
    const specPath = path.join(dir, 'spec-a4.md');
    fs.writeFileSync(specPath, '# Spec A4\n');

    const handle = { _readFiles: [specPath], _toolCallCount: 0, systemPromptTokens: 0 };
    const sdkResult = {
      structured_output: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
      },
    };

    const mockLogger = {
      createSessionLog: () => ({ logPath: '/tmp/test-a4.log', close: () => {} }),
      attachToSession: () => {},
      warn: () => {},
      writeSessionSummary: async () => {},
      getSessionSummary: () => '',
    };
    const mockTokenTracker = { recordSession: async () => {} };
    const mockSessionManager = {
      spawn: () => {
        const p = Promise.resolve({ handle, result: sdkResult });
        p.handle = handle;
        return p;
      },
    };

    const verifier = new Verifier(mockSessionManager, mockLogger, mockTokenTracker);
    const task = { id: 'regression-001-A4', description: 'regression task A4', targetFiles: [] };

    const verdict = await verifier.verifyRegression(task, dir, { specPath });

    assert.strictEqual(verdict.verified, true, 'verdict.verified should be true for PASSED result');

    const sidecarPath = path.join(activeHarnessDir(dir), 'verification', `task-${task.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

    assert.ok(!('specReadAudit' in parsed), `sidecar must NOT have specReadAudit key for regression- task. Got: ${JSON.stringify(Object.keys(parsed))}`);
  } finally {
    cleanup(dir);
  }
});

// ── SC1: spec-context plumbing — task WITH a matching spec hardCheck ──────────
//
// Both verifyTask call sites (~2385 revalidation/retry, ~2579 main verify) spread
// `...this._buildVerifierSpecContext(task)` into the context passed to
// verifier.verifyTask. That helper IS the object the pipeline injects into the
// verifier context (context.specGoal + context.relevantCriteria), so asserting
// on its output is asserting exactly what both call sites pass — without driving
// the full state machine (executor / snapshots / transitions). We bootstrap a
// temp project whose state.projectMeta.prdPath points at a spec.md with a sibling
// spec.json (goal + acceptance_criteria), then build the per-task context.

await test('SC1: task WITH a matching spec hardCheck → context has non-empty specGoal + relevantCriteria containing the matching criterion', async () => {
  const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');
  const { bootstrap } = await import('../src/orchestrator/core/bootstrap.js');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-plumbing-sc1-'));
  fs.mkdirSync(tmpDir, { recursive: true });

  const specPath = path.join(tmpDir, 'spec.md');
  fs.writeFileSync(specPath, '# Test Spec\n\nBuild something.');

  const specJsonPath = path.join(tmpDir, 'spec.json');
  const matchingCriterion = {
    description: 'The matching acceptance criterion',
    verification: { kind: 'command', command: 'node test/test-matching.js' },
  };
  const otherCriterion = {
    description: 'An unrelated acceptance criterion',
    verification: { kind: 'command', command: 'node test/test-unrelated.js' },
  };
  fs.writeFileSync(
    specJsonPath,
    JSON.stringify({ goal: 'Inject compact spec context into the verifier.', acceptance_criteria: [matchingCriterion, otherCriterion] }, null, 2),
  );

  bootstrap(tmpDir, { prdPath: specPath, force: true });

  const pipeline = new Pipeline(tmpDir, { onLog: () => {}, onConfirm: async () => true });

  try {
    // Task carries a spec-derived hardCheck whose command matches matchingCriterion.
    const task = {
      id: 'sc1-task',
      description: 'a spec-derived task',
      targetFiles: [],
      hardChecks: [{ name: 'hc1', command: 'node test/test-matching.js' }],
    };

    const ctx = pipeline._buildVerifierSpecContext(task);

    assert.strictEqual(
      typeof ctx.specGoal,
      'string',
      'context.specGoal must be a string',
    );
    assert.ok(
      ctx.specGoal.length > 0,
      `context.specGoal must be non-empty for a spec-backed run, got: "${ctx.specGoal}"`,
    );
    assert.ok(
      Array.isArray(ctx.relevantCriteria),
      'context.relevantCriteria must be an array',
    );
    assert.strictEqual(
      ctx.relevantCriteria.length,
      1,
      `context.relevantCriteria must contain exactly the matching criterion, got: ${JSON.stringify(ctx.relevantCriteria)}`,
    );
    assert.deepStrictEqual(
      ctx.relevantCriteria[0],
      matchingCriterion,
      'the single relevantCriteria entry must be the criterion whose verification.command matches the task hardCheck',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── SC2: spec-context plumbing — task with NO spec hardChecks → relevantCriteria === []
//
// The same helper feeds BOTH call sites, so an empty relevantCriteria here proves
// both the main-verify (~2579) and revalidation/retry (~2385) paths inject [].

await test('SC2: task with NO spec hardChecks → context.relevantCriteria is empty (both call sites)', async () => {
  const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');
  const { bootstrap } = await import('../src/orchestrator/core/bootstrap.js');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-plumbing-sc2-'));
  fs.mkdirSync(tmpDir, { recursive: true });

  const specPath = path.join(tmpDir, 'spec.md');
  fs.writeFileSync(specPath, '# Test Spec\n\nBuild something.');

  const specJsonPath = path.join(tmpDir, 'spec.json');
  fs.writeFileSync(
    specJsonPath,
    JSON.stringify({
      goal: 'Inject compact spec context into the verifier.',
      acceptance_criteria: [
        { description: 'A criterion', verification: { kind: 'command', command: 'node test/test-x.js' } },
      ],
    }, null, 2),
  );

  bootstrap(tmpDir, { prdPath: specPath, force: true });

  const pipeline = new Pipeline(tmpDir, { onLog: () => {}, onConfirm: async () => true });

  try {
    // Generic infra task: no hardChecks at all → no criterion can match.
    const taskNoHardChecks = {
      id: 'sc2-task',
      description: 'a generic infra task',
      targetFiles: [],
    };
    const ctxNoHc = pipeline._buildVerifierSpecContext(taskNoHardChecks);
    assert.deepStrictEqual(
      ctxNoHc.relevantCriteria,
      [],
      `task with no hardChecks must get relevantCriteria === [], got: ${JSON.stringify(ctxNoHc.relevantCriteria)}`,
    );

    // Task whose hardCheck command matches NO acceptance criterion → still [].
    const taskNonSpecHardChecks = {
      id: 'sc2-task-b',
      description: 'a task with a non-spec hardCheck',
      targetFiles: [],
      hardChecks: [{ name: 'hc', command: 'node test/test-does-not-match.js' }],
    };
    const ctxNonSpec = pipeline._buildVerifierSpecContext(taskNonSpecHardChecks);
    assert.deepStrictEqual(
      ctxNonSpec.relevantCriteria,
      [],
      `task with no MATCHING spec hardCheck must get relevantCriteria === [], got: ${JSON.stringify(ctxNonSpec.relevantCriteria)}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── SC3: spec-context plumbing — production path: hardChecks ONLY in the verify sidecar
//
// Scheduler tasks are rehydrated by _buildTaskDAG from mission-*.json, which does
// NOT carry hardChecks — they are persisted only in the per-task verify sidecars
// `.harness/verify/task-{id}.json` (the writeVerifyJson shape, the same disk SoT
// runHardChecks reads). _buildVerifierSpecContext must therefore source commands
// from that sidecar, unioned with task.hardChecks || []. This is the production
// rehydrated-task path the original SC1/SC2 tests missed.

await test('SC3: task with NO in-memory hardChecks but a verify sidecar on disk → relevantCriteria contains the matching criterion', async () => {
  const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');
  const { bootstrap } = await import('../src/orchestrator/core/bootstrap.js');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-plumbing-sc3-'));
  fs.mkdirSync(tmpDir, { recursive: true });

  const specPath = path.join(tmpDir, 'spec.md');
  fs.writeFileSync(specPath, '# Test Spec\n\nBuild something.');

  const specJsonPath = path.join(tmpDir, 'spec.json');
  const matchingCriterion = {
    description: 'The matching acceptance criterion',
    verification: { kind: 'command', command: 'node test/test-matching.js' },
  };
  const otherCriterion = {
    description: 'An unrelated acceptance criterion',
    verification: { kind: 'command', command: 'node test/test-unrelated.js' },
  };
  fs.writeFileSync(
    specJsonPath,
    JSON.stringify({ goal: 'Inject compact spec context into the verifier.', acceptance_criteria: [matchingCriterion, otherCriterion] }, null, 2),
  );

  bootstrap(tmpDir, { prdPath: specPath, force: true });

  const pipeline = new Pipeline(tmpDir, { onLog: () => {}, onConfirm: async () => true });

  try {
    // Rehydrated production task: NO in-memory hardChecks (mission-*.json does
    // not carry them). The hardChecks live ONLY in the verify sidecar on disk.
    const task = {
      id: 'sc3-task',
      description: 'a rehydrated spec-derived task',
      targetFiles: [],
    };

    // Write the verify sidecar at the writeVerifyJson location/shape:
    // .harness/verify/task-{id}.json with top-level hardChecks: [{name, command}].
    const verifyDir = path.join(activeHarnessDir(tmpDir), 'verify');
    fs.mkdirSync(verifyDir, { recursive: true });
    fs.writeFileSync(
      path.join(verifyDir, `task-${task.id}.json`),
      JSON.stringify({ hardChecks: [{ name: 'hc1', command: 'node test/test-matching.js' }] }, null, 2),
    );

    const ctx = pipeline._buildVerifierSpecContext(task);

    assert.strictEqual(
      typeof ctx.specGoal,
      'string',
      'context.specGoal must be a string',
    );
    assert.ok(
      ctx.specGoal.length > 0,
      `context.specGoal must be non-empty for a spec-backed run, got: "${ctx.specGoal}"`,
    );
    assert.ok(
      Array.isArray(ctx.relevantCriteria),
      'context.relevantCriteria must be an array',
    );
    assert.strictEqual(
      ctx.relevantCriteria.length,
      1,
      `context.relevantCriteria must contain exactly the matching criterion sourced from the verify sidecar (task has NO in-memory hardChecks), got: ${JSON.stringify(ctx.relevantCriteria)}`,
    );
    assert.deepStrictEqual(
      ctx.relevantCriteria[0],
      matchingCriterion,
      'the single relevantCriteria entry must be the criterion whose verification.command matches the sidecar hardCheck',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── SC4: spec-context plumbing — neither in-memory hardChecks nor a sidecar ──
//
// Fail-soft contract: a missing sidecar file must NOT throw; with no in-memory
// hardChecks either, relevantCriteria must be [].

await test('SC4: task with neither in-memory hardChecks nor a verify sidecar → relevantCriteria is [] and no throw', async () => {
  const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');
  const { bootstrap } = await import('../src/orchestrator/core/bootstrap.js');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-plumbing-sc4-'));
  fs.mkdirSync(tmpDir, { recursive: true });

  const specPath = path.join(tmpDir, 'spec.md');
  fs.writeFileSync(specPath, '# Test Spec\n\nBuild something.');

  const specJsonPath = path.join(tmpDir, 'spec.json');
  fs.writeFileSync(
    specJsonPath,
    JSON.stringify({
      goal: 'Inject compact spec context into the verifier.',
      acceptance_criteria: [
        { description: 'A criterion', verification: { kind: 'command', command: 'node test/test-x.js' } },
      ],
    }, null, 2),
  );

  bootstrap(tmpDir, { prdPath: specPath, force: true });

  const pipeline = new Pipeline(tmpDir, { onLog: () => {}, onConfirm: async () => true });

  try {
    const task = {
      id: 'sc4-task',
      description: 'a task with no hardChecks anywhere',
      targetFiles: [],
    };

    // Precondition: the verify sidecar for this task must not exist on disk.
    const sidecarPath = path.join(activeHarnessDir(tmpDir), 'verify', `task-${task.id}.json`);
    assert.ok(
      !fs.existsSync(sidecarPath),
      `fixture precondition violated: sidecar must not exist at ${sidecarPath}`,
    );

    let ctx;
    try {
      ctx = pipeline._buildVerifierSpecContext(task);
    } catch (err) {
      assert.fail(`_buildVerifierSpecContext must not throw when the verify sidecar is missing (fail-soft), but threw: ${err.message}`);
    }

    assert.deepStrictEqual(
      ctx.relevantCriteria,
      [],
      `task with neither in-memory hardChecks nor a sidecar must get relevantCriteria === [], got: ${JSON.stringify(ctx.relevantCriteria)}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
