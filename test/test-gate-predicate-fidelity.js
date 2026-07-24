/**
 * test-gate-predicate-fidelity.js — Gate-predicate fidelity regression suite.
 *
 * Contract under test (four ACs):
 *
 *  AC1 — isCheckableCriterion predicate fidelity:
 *    The uncheckable-spec guard counts a criterion as checkable only when its
 *    verification is parser-extractable (kind 'command' with non-empty string
 *    command, or kind 'file-check' with non-empty string targetFile) or an
 *    explicit kind 'manual'; empty objects, missing/typo'd kinds, and arrays no
 *    longer pass; the predicate is single-sourced with
 *    parseSpecHardChecks/parseSpecFileChecks; criteria consumers tolerate
 *    non-object items with a loud log instead of crashing.
 *
 *  AC2 — extractPathTokens URL-scheme and existing-directory exclusion:
 *    extractPathTokens excludes URL-scheme (://) tokens and
 *    existing-directory tokens so such checks classify as milestone-only and
 *    execute in the criteria drain instead of dying as plan-fatal orphans; the
 *    edge-punctuation strip set gains | & ! $.
 *
 *  AC3 — invalidationReason persistence and coverage-drain skipping:
 *    Both invalidation producers persist an invalidationReason ('replaced' vs
 *    'redundant') into mission state and the coverage drain skips only
 *    'replaced' sidecars; redundant-verified sidecars count as coverage; legacy
 *    entries without a reason keep the conservative skip with a warning.
 *
 *  AC4 — runMilestoneOnlyChecks robustness:
 *    runMilestoneOnlyChecks sets an explicit generous maxBuffer, reports buffer
 *    overflow honestly instead of exit -1, classifies SIGTERM/ETIMEDOUT as
 *    timedOut like the sibling runOne, and the drain-time parse catch warns
 *    loudly instead of silently no-opping when spec.json is unreadable after
 *    planning.
 *
 * Tests:
 *   AC1-TC1 through AC1-TC8: isCheckableCriterion predicate fidelity
 *   AC2-TC1 through AC2-TC8: extractPathTokens URL-scheme and directory exclusion
 *   AC3-TC1 through AC3-TC3: invalidationReason persistence and drain semantics
 *   (AC4 tests will be added in a subsequent task)
 *
 * Run: node test/test-gate-predicate-fidelity.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  isCheckableCriterion,
  extractPathTokens,
  isMilestoneOnlyCheck,
  parseSpecHardChecks,
  parseSpecFileChecks,
  findUnassignedSpecHardChecks,
} from '../src/orchestrator/agents/planner.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { UncheckableSpecError } from '../src/orchestrator/core/uncheckable-spec-error.js';
import { IncompleteScopeError } from '../src/orchestrator/core/incomplete-scope-error.js';
import { runMilestoneOnlyChecks, MILESTONE_ONLY_CHECK_TIMEOUT_MS } from '../src/orchestrator/gates/hard-checks.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Create a temp project root with a `.harness` dir: state.json (projectMeta
 * .prdPath → <root>/spec.md), per-mission state files built from `tasks`
 * (status from `preStatus`, default 'pending'), and the harness sub-dirs the
 * Pipeline constructor expects.
 *
 * Supports:
 *   preStatus    — { [taskId]: statusString } overrides for individual tasks
 *   invalidationReason — { [taskId]: 'replaced' | 'redundant' } optional
 *                        reason written into the mission-state task entry
 *   specChecks   — array of { name, command, targetFile } written to spec.json
 *                  acceptance_criteria with kind:'command' verification shapes
 *   specTargetFiles — top-level target_files array in spec.json
 */
function createEnv(tasks, {
  preStatus = {},
  invalidationReason = {},
  specChecks = null,
  specTargetFiles = [],
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-pred-test-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(harnessDir, 'logs', 'token-usage.json'),
    JSON.stringify({ sessions: [], totals: {} })
  );

  const prdPath = path.join(root, 'spec.md');
  fs.writeFileSync(prdPath, '# spec');

  const byMission = new Map();
  for (const task of tasks) {
    if (!byMission.has(task.missionId)) byMission.set(task.missionId, []);
    byMission.get(task.missionId).push(task);
  }

  const milestones = { '001': { id: '001', status: 'in_progress', missions: {} } };

  for (const [missionId, missionTasks] of byMission.entries()) {
    milestones['001'].missions[missionId] = {
      id: missionId,
      status: 'in_progress',
      stateFile: `.harness/state/mission-${missionId}.json`,
    };
    const bySubMission = new Map();
    for (const t of missionTasks) {
      if (!bySubMission.has(t.subMissionId)) bySubMission.set(t.subMissionId, []);
      bySubMission.get(t.subMissionId).push(t);
    }
    const subMissions = {};
    for (const [smId, smTasks] of bySubMission.entries()) {
      const taskMap = {};
      for (const t of smTasks) {
        const entry = {
          id: t.id,
          description: t.description || 'test',
          status: preStatus[t.id] || 'pending',
          retryCount: 0,
        };
        if (invalidationReason[t.id] != null) {
          entry.invalidationReason = invalidationReason[t.id];
        }
        taskMap[t.id] = entry;
      }
      subMissions[smId] = { id: smId, status: 'in_progress', tasks: taskMap };
    }
    fs.writeFileSync(
      path.join(harnessDir, 'state', `mission-${missionId}.json`),
      JSON.stringify({
        id: missionId,
        missionId,
        description: 'test mission',
        status: 'in_progress',
        subMissions,
      }, null, 2)
    );
  }

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath, createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones,
    }, null, 2)
  );

  if (specChecks) {
    const specJson = {
      goal: 'gate predicate fidelity test spec',
      target_files: specTargetFiles,
      acceptance_criteria: specChecks.map((c) => ({
        description: c.name,
        verification: { kind: 'command', command: c.command, targetFile: c.targetFile },
      })),
    };
    fs.writeFileSync(path.join(root, 'spec.json'), JSON.stringify(specJson, null, 2));
  }

  return { root, harnessDir };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * Write a spec-pair: spec.md + spec.json with the given acceptance_criteria
 * shape verbatim (not wrapped — caller controls the verification shape).
 */
function writeSpecPair(root, acceptanceCriteria) {
  const prdPath = path.join(root, 'spec.md');
  fs.writeFileSync(prdPath, '# spec');
  const specJson = {
    goal: 'gate predicate fidelity test spec',
    target_files: [],
    acceptance_criteria: acceptanceCriteria,
  };
  fs.writeFileSync(path.join(root, 'spec.json'), JSON.stringify(specJson, null, 2));
}

/**
 * Build a bare Pipeline for calling coverage-drain methods directly.
 * Returns { pipeline, logs }.
 */
function makeDrainPipeline(projectRoot) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    statusBar: false,
  });
  return { pipeline, logs };
}

/**
 * Remove the process signal listeners the Pipeline constructor registers so
 * repeated Pipeline construction across tests does not pile up listeners.
 */
function teardownPipeline(pipeline) {
  const handlers = pipeline._signalHandlers || {};
  if (handlers.SIGINT) process.removeListener('SIGINT', handlers.SIGINT);
  if (handlers.SIGTERM) process.removeListener('SIGTERM', handlers.SIGTERM);
  if (handlers.exit) process.removeListener('exit', handlers.exit);
  if (handlers.uncaughtException) process.removeListener('uncaughtException', handlers.uncaughtException);
}

/**
 * Write a verify sidecar at .harness/verify/task-<taskId>.json.
 */
function writeSidecar(harnessDir, taskId, targetFiles, hardChecks) {
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles, hardChecks, testCases: [] }, null, 2)
  );
}

// ── Shared helper: minimal fakeThis for _detectUncheckableSpec ───────────────

const detectUncheckableSpec = Pipeline.prototype._detectUncheckableSpec;

/**
 * Build a minimal fake-this for _detectUncheckableSpec calls.
 * Only needs: harnessDir, projectRoot, _allowIncompleteScope, onLog.
 */
function makeFakeDetectThis(tmpDir, { allowIncompleteScope = false } = {}) {
  const logs = [];
  const harnessDir = path.join(tmpDir, '.harness');
  const fakeThis = {
    harnessDir,
    projectRoot: tmpDir,
    _allowIncompleteScope: allowIncompleteScope,
    onLog: (msg) => logs.push(msg),
  };
  return { fakeThis, logs };
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {

// ── AC1: isCheckableCriterion predicate fidelity ─────────────────────────────

await test('AC1-TC1: isCheckableCriterion rejects {verification:{}} → false', async () => {
  const result = isCheckableCriterion({ verification: {} });
  assert.strictEqual(result, false,
    `Expected false for {verification:{}}, got ${result}`);
});

await test('AC1-TC2: isCheckableCriterion rejects {verification:{kind:"command"}} (missing command) → false', async () => {
  const result = isCheckableCriterion({ verification: { kind: 'command' } });
  assert.strictEqual(result, false,
    `Expected false for {verification:{kind:"command"}} with no command field, got ${result}`);
});

await test('AC1-TC3: isCheckableCriterion rejects {verification:{kind:"typo"}} → false', async () => {
  const result = isCheckableCriterion({ verification: { kind: 'typo' } });
  assert.strictEqual(result, false,
    `Expected false for {verification:{kind:"typo"}}, got ${result}`);
});

await test('AC1-TC4: isCheckableCriterion rejects {verification:[1,2]} (array) → false', async () => {
  const result = isCheckableCriterion({ verification: [1, 2] });
  assert.strictEqual(result, false,
    `Expected false for {verification:[1,2]} (array), got ${result}`);
});

await test('AC1-TC5: all-manual spec passes _detectUncheckableSpec (no throw)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac1-tc5-'));
  try {
    writeSpecPair(tmpDir, [
      { description: 'human checks A', verification: { kind: 'manual' } },
      { description: 'human checks B', verification: { kind: 'manual' } },
    ]);
    const prdPath = path.join(tmpDir, 'spec.md');
    const { fakeThis } = makeFakeDetectThis(tmpDir, { allowIncompleteScope: false });
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath });
    } catch (err) {
      throw new Error(`Expected no throw for all-manual spec, but got: ${err.message}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test('AC1-TC6: mixed spec (≥1 valid command criterion + legacy items) passes _detectUncheckableSpec (no throw)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac1-tc6-'));
  try {
    writeSpecPair(tmpDir, [
      { description: 'valid command check', verification: { kind: 'command', command: 'node --version' } },
      { description: 'legacy item with no verification object' },
      { description: 'empty verification', verification: {} },
    ]);
    const prdPath = path.join(tmpDir, 'spec.md');
    const { fakeThis } = makeFakeDetectThis(tmpDir, { allowIncompleteScope: false });
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath });
    } catch (err) {
      throw new Error(`Expected no throw for mixed spec (≥1 valid criterion), but got: ${err.message}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test('AC1-TC7: spec with ONLY {verification:{}} items rejected by _detectUncheckableSpec → throws UncheckableSpecError', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac1-tc7-'));
  try {
    writeSpecPair(tmpDir, [
      { description: 'empty verification A', verification: {} },
      { description: 'empty verification B', verification: {} },
    ]);
    const prdPath = path.join(tmpDir, 'spec.md');
    const { fakeThis } = makeFakeDetectThis(tmpDir, { allowIncompleteScope: false });
    let thrownErr = null;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath });
    } catch (err) {
      thrownErr = err;
    }
    if (!thrownErr) {
      throw new Error('Expected UncheckableSpecError to be thrown for all-empty-verification spec, but nothing was thrown');
    }
    if (!(thrownErr instanceof UncheckableSpecError)) {
      throw new Error(`Expected instanceof UncheckableSpecError, got: ${thrownErr.constructor.name}: ${thrownErr.message}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test('AC1-TC8: shared predicate — {verification:{kind:"command"}} (no command) rejected by both parseSpecHardChecks (returns []) and _detectUncheckableSpec (throws)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac1-tc8-'));
  try {
    // Write a spec.json with a single criterion: kind=command but no command field
    const specJsonPath = path.join(tmpDir, 'spec.json');
    const specJson = {
      goal: 'shared predicate test',
      target_files: [],
      acceptance_criteria: [
        { description: 'missing command', verification: { kind: 'command' } },
      ],
    };
    fs.writeFileSync(specJsonPath, JSON.stringify(specJson, null, 2));

    // 1) parseSpecHardChecks should return [] (criterion is not extractable)
    const checks = parseSpecHardChecks(specJsonPath);
    if (!Array.isArray(checks) || checks.length !== 0) {
      throw new Error(`Expected parseSpecHardChecks to return [] for no-command criterion, got: ${JSON.stringify(checks)}`);
    }

    // 2) _detectUncheckableSpec should throw (zero checkable criteria → legacy dialect)
    const prdPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(prdPath, '# spec');
    const { fakeThis } = makeFakeDetectThis(tmpDir, { allowIncompleteScope: false });
    let thrownErr = null;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath });
    } catch (err) {
      thrownErr = err;
    }
    if (!thrownErr) {
      throw new Error('Expected _detectUncheckableSpec to throw for zero-checkable spec, but nothing was thrown');
    }
    if (!(thrownErr instanceof UncheckableSpecError)) {
      throw new Error(`Expected instanceof UncheckableSpecError, got: ${thrownErr.constructor.name}: ${thrownErr.message}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── AC2: extractPathTokens URL-scheme and existing-directory exclusion ────────

await test('AC2-TC1: extractPathTokens excludes URL token (http://localhost:3000/health) → []', () => {
  const actual = extractPathTokens('curl http://localhost:3000/health');
  assert.deepStrictEqual(actual, [],
    `expected [], got ${JSON.stringify(actual)}`);
});

await test("AC2-TC2: extractPathTokens strips trailing pipe | from token edge → ['src/a.js']", () => {
  // The pipe is at the token edge after whitespace-split: 'src/a.js|' → 'src/a.js'
  const actual = extractPathTokens('cat src/a.js| wc -l');
  assert.deepStrictEqual(actual, ['src/a.js'],
    `expected ['src/a.js'], got ${JSON.stringify(actual)}`);
});

await test("AC2-TC3: extractPathTokens strips leading ! from token → ['test/x.js']", () => {
  const actual = extractPathTokens('!node test/x.js');
  assert.deepStrictEqual(actual, ['test/x.js'],
    `expected ['test/x.js'], got ${JSON.stringify(actual)}`);
});

await test("AC2-TC4: extractPathTokens strips leading $ from token → ['HOME/bin/foo.js']", () => {
  const actual = extractPathTokens('echo $HOME/bin/foo.js');
  assert.deepStrictEqual(actual, ['HOME/bin/foo.js'],
    `expected ['HOME/bin/foo.js'], got ${JSON.stringify(actual)}`);
});

await test("AC2-TC5: extractPathTokens strips trailing & from token → ['foo.js']", () => {
  const actual = extractPathTokens('cat foo.js&');
  assert.deepStrictEqual(actual, ['foo.js'],
    `expected ['foo.js'], got ${JSON.stringify(actual)}`);
});

await test('AC2-TC6: extractPathTokens excludes existing directory token (ls src, tmpDir) → []', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac2-tc6-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    const actual = extractPathTokens('ls src', tmpDir);
    assert.deepStrictEqual(actual, [],
      `expected [], got ${JSON.stringify(actual)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test('AC2-TC7: isMilestoneOnlyCheck curl URL returns true (URL criterion is milestone-only)', () => {
  const check = { name: 'health', command: 'curl http://localhost:3000/health' };
  const result = isMilestoneOnlyCheck(check, ['src/app.js']);
  assert.strictEqual(result, true,
    `Expected isMilestoneOnlyCheck to return true for curl URL command, got ${result}`);
});

await test('AC2-TC8: end-to-end drain routing — curl URL criterion is not reported as an orphan', () => {
  const curlCheck = { name: 'health', command: 'curl http://localhost:3000/health' };
  const specTargetFiles = ['src/app.js'];
  // Milestone-only checks (URL token excluded → zero path tokens) never appear
  // as orphans in findUnassignedSpecHardChecks — they route to the drain instead.
  const result = findUnassignedSpecHardChecks([curlCheck], new Set(), specTargetFiles);
  assert.ok(Array.isArray(result), 'expected an array from findUnassignedSpecHardChecks');
  assert.strictEqual(result.length, 0,
    `expected 0 unassigned/orphan checks for curl URL criterion (milestone-only → drain), got ${result.length}: ${JSON.stringify(result)}`);
});

// ── AC3: invalidationReason persistence and coverage-drain skipping ───────────

// Shared check fixture for AC3 tests.
const CHECK_X_AC3 = { name: 'check X', command: 'node test/test-x.js' };

await test('AC3-TC1: replaced sidecar skipped, redundant sidecar counts → no throw (asymmetric outcome)', async () => {
  const taskReplaced = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['test/test-x.js'],
    dependencies: [],
    description: 'replaced owner of check X',
  };
  const taskRedundant = {
    id: '001-001-001-002',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['test/test-x.js'],
    dependencies: [],
    description: 'redundant owner of check X',
  };
  const env = createEnv([taskReplaced, taskRedundant], {
    preStatus: {
      [taskReplaced.id]: 'invalidated',
      [taskRedundant.id]: 'invalidated',
    },
    invalidationReason: {
      [taskReplaced.id]: 'replaced',
      [taskRedundant.id]: 'redundant',
    },
    specChecks: [{ ...CHECK_X_AC3, targetFile: 'test/test-x.js' }],
    specTargetFiles: ['test/test-x.js'],
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    // Both sidecars carry check X; 'replaced' is skipped, 'redundant' counts.
    writeSidecar(env.harnessDir, taskReplaced.id, taskReplaced.targetFiles, [CHECK_X_AC3]);
    writeSidecar(env.harnessDir, taskRedundant.id, taskRedundant.targetFiles, [CHECK_X_AC3]);
    // Must not throw — the redundant sidecar counts as coverage.
    await pipeline._assertSpecHardCheckCoverage();
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.root);
  }
});

await test('AC3-TC2: only replaced sidecar for check X, no redundant sidecar → throws IncompleteScopeError', async () => {
  const taskReplaced = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['test/test-x.js'],
    dependencies: [],
    description: 'replaced owner of check X (only sidecar)',
  };
  const env = createEnv([taskReplaced], {
    preStatus: { [taskReplaced.id]: 'invalidated' },
    invalidationReason: { [taskReplaced.id]: 'replaced' },
    specChecks: [{ ...CHECK_X_AC3, targetFile: 'test/test-x.js' }],
    specTargetFiles: ['test/test-x.js'],
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    // Only the replaced sidecar — must be skipped → check X is orphaned.
    writeSidecar(env.harnessDir, taskReplaced.id, taskReplaced.targetFiles, [CHECK_X_AC3]);
    let thrown = null;
    try {
      await pipeline._assertSpecHardCheckCoverage();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown,
      'drain must throw IncompleteScopeError when the only sidecar for check X belongs to a replaced task');
    assert.ok(thrown instanceof IncompleteScopeError,
      `expected IncompleteScopeError, got: ${thrown?.constructor?.name}: ${thrown?.message}`);
    assert.ok(thrown.message.includes(CHECK_X_AC3.command),
      `the error must name the orphaned command "${CHECK_X_AC3.command}", got: ${thrown.message}`);
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.root);
  }
});

await test('AC3-TC3: legacy invalidated task (no invalidationReason) → sidecar skipped conservatively + warning log emitted', async () => {
  const taskLegacy = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['test/test-x.js'],
    dependencies: [],
    description: 'legacy invalidated owner of check X (no invalidationReason)',
  };
  // Deliberately omit invalidationReason — the mission-state entry has status
  // 'invalidated' but no invalidationReason field.
  const env = createEnv([taskLegacy], {
    preStatus: { [taskLegacy.id]: 'invalidated' },
    // No invalidationReason entry — legacy case.
    specChecks: [{ ...CHECK_X_AC3, targetFile: 'test/test-x.js' }],
    specTargetFiles: ['test/test-x.js'],
  });
  const { pipeline, logs } = makeDrainPipeline(env.root);
  try {
    writeSidecar(env.harnessDir, taskLegacy.id, taskLegacy.targetFiles, [CHECK_X_AC3]);
    // The sidecar is skipped conservatively → check X is orphaned.
    let thrown = null;
    try {
      await pipeline._assertSpecHardCheckCoverage();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown,
      'drain must throw because the legacy sidecar is skipped (conservative) leaving check X orphaned');
    assert.ok(thrown instanceof IncompleteScopeError,
      `expected IncompleteScopeError, got: ${thrown?.constructor?.name}: ${thrown?.message}`);
    // The warning log must mention 'missing invalidationReason'.
    assert.ok(logs.some((l) => l.includes('missing invalidationReason')),
      `expected a log warning containing 'missing invalidationReason', got logs:\n${logs.join('\n')}`);
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.root);
  }
});

// ── AC4: runMilestoneOnlyChecks robustness + drain-time parse-catch ───────────

await test('AC4-TC1: runMilestoneOnlyChecks with ~2 MiB stdout → passed: true, no ENOBUFS', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac4-tc1-'));
  try {
    // Command emits ~2 MiB to stdout; maxBuffer is 16 MiB so this must not overflow.
    const check = {
      name: 'big-output',
      command: `node -e "process.stdout.write('x'.repeat(2*1024*1024))"`,
    };
    const result = runMilestoneOnlyChecks([check], tmpDir, {});
    assert.strictEqual(result.passed, true,
      `Expected passed: true for ~2 MiB stdout, got passed: ${result.passed}; failures: ${JSON.stringify(result.failures)}`);
    assert.deepStrictEqual(result.failures, [],
      `Expected no failures for ~2 MiB stdout, got: ${JSON.stringify(result.failures)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test('AC4-TC2: runMilestoneOnlyChecks with SIGTERM-killed child → failure has timedOut: true', async () => {
  // MILESTONE_ONLY_CHECK_TIMEOUT_MS = 1_800_000 ms; we use self-SIGTERM to avoid
  // waiting for the timeout. err.signal === 'SIGTERM' → timedOut = true.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac4-tc2-'));
  try {
    const check = {
      name: 'self-sigterm',
      command: `node -e "process.kill(process.pid, 'SIGTERM')"`,
    };
    const result = runMilestoneOnlyChecks([check], tmpDir, {});
    assert.strictEqual(result.passed, false,
      `Expected passed: false for SIGTERM-killed child, got passed: ${result.passed}`);
    assert.ok(result.failures.length > 0,
      `Expected at least one failure for SIGTERM-killed child, got: ${JSON.stringify(result.failures)}`);
    assert.strictEqual(result.failures[0].timedOut, true,
      `Expected timedOut: true in failure object, got: ${JSON.stringify(result.failures[0])}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test('AC4-TC3: _assertSpecHardCheckCoverage with corrupted spec.json → no throw, warning log names spec path + "unreadable"', async () => {
  const taskA = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/index.js'],
    dependencies: [],
    description: 'test task for AC4-TC3',
  };
  const env = createEnv([taskA], {
    preStatus: { [taskA.id]: 'completed' },
    specChecks: [{ name: 'version check', command: 'node --version' }],
    specTargetFiles: ['src/index.js'],
  });
  const { pipeline, logs } = makeDrainPipeline(env.root);
  try {
    // Corrupt spec.json with invalid JSON (file still exists for fs.existsSync).
    const specJsonPath = path.join(env.root, 'spec.json');
    fs.writeFileSync(specJsonPath, '{ INVALID JSON !!! NOT PARSEABLE');

    // Must not throw.
    try {
      pipeline._assertSpecHardCheckCoverage();
    } catch (err) {
      throw new Error(`Expected no throw from _assertSpecHardCheckCoverage with corrupted spec.json, but got: ${err.message}`);
    }

    // Warning log must name the spec.json path.
    assert.ok(logs.some((l) => l.includes(specJsonPath)),
      `Expected a log mentioning spec.json path "${specJsonPath}"; logs:\n${logs.join('\n')}`);
    // Warning log must contain the word 'unreadable'.
    assert.ok(logs.some((l) => l.toLowerCase().includes('unreadable')),
      `Expected a log containing 'unreadable'; logs:\n${logs.join('\n')}`);
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.root);
  }
});

await test('AC4-TC4: _runSpecCriteriaDrain with corrupted spec.json → no throw, warning log names spec path + "unreadable"', async () => {
  const taskB = {
    id: '001-001-001-001',
    missionId: '001-001',
    subMissionId: '001-001-001',
    targetFiles: ['src/index.js'],
    dependencies: [],
    description: 'test task for AC4-TC4',
  };
  const env = createEnv([taskB], {
    preStatus: { [taskB.id]: 'completed' },
    specChecks: [{ name: 'version check', command: 'node --version' }],
    specTargetFiles: ['src/index.js'],
  });
  const { pipeline, logs } = makeDrainPipeline(env.root);
  try {
    // Corrupt spec.json with invalid JSON (file still exists for fs.existsSync).
    const specJsonPath = path.join(env.root, 'spec.json');
    fs.writeFileSync(specJsonPath, '{ INVALID JSON !!! NOT PARSEABLE');

    // Must not throw.
    try {
      pipeline._runSpecCriteriaDrain();
    } catch (err) {
      throw new Error(`Expected no throw from _runSpecCriteriaDrain with corrupted spec.json, but got: ${err.message}`);
    }

    // Warning log must name the spec.json path.
    assert.ok(logs.some((l) => l.includes(specJsonPath)),
      `Expected a log mentioning spec.json path "${specJsonPath}"; logs:\n${logs.join('\n')}`);
    // Warning log must contain the word 'unreadable'.
    assert.ok(logs.some((l) => l.toLowerCase().includes('unreadable')),
      `Expected a log containing 'unreadable'; logs:\n${logs.join('\n')}`);
  } finally {
    teardownPipeline(pipeline);
    cleanup(env.root);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
