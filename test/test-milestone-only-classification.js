/**
 * test-milestone-only-classification.js — spec hardCheck milestone-only
 * classification vs spec.json target_files.
 *
 * Contract under test (written independently of the in-flight fix):
 *   1. isMilestoneOnlyCheck(check, specTargetFiles) — optional 2nd param.
 *      Milestone-only when the command has zero path tokens (legacy rule)
 *      OR when specTargetFiles is a non-empty array and NONE of the check's
 *      path tokens match any entry (same 3 matching rules as
 *      scopeSpecHardChecks: exact; targetFile endsWith '/'+token; token
 *      endsWith '/'+targetFile). Absent/empty/non-array specTargetFiles →
 *      byte-identical legacy behavior.
 *   2. findUnassignedSpecHardChecks / findOrphanedSpecHardChecks accept the
 *      same optional param and never report a milestone-only-by-target_files
 *      check as unassigned/orphaned.
 *   3. scopeSpecHardChecks(hardChecks, tasks, specTargetFiles) excludes such
 *      checks from task scoping.
 *   4. parseSpecTargetFiles(specJsonPath) — new export: target_files filtered
 *      to non-empty strings; [] when absent/not-array; throws on
 *      unreadable/malformed file (like parseSpecHardChecks).
 *   5. Pipeline._assertSpecHardCheckCoverage no longer throws for the
 *      reproduced shape (path-bearing spec command whose token is NOT in
 *      target_files, unassigned), but STILL throws when the token IS in
 *      target_files (genuinely dropped deliverable).
 *   6. Pipeline._runSpecCriteriaDrain executes milestone-only-by-target_files
 *      command checks at the drain, de-duplicating identical command strings.
 *
 * Cases:
 *   TC1  legacy pin: zero-path-token → milestone-only (no 2nd arg; and with
 *        a non-empty specTargetFiles — zero-token rule is an OR, unchanged)
 *   TC2  legacy pin: token-bearing check NOT milestone-only when
 *        specTargetFiles is absent / [] / non-array
 *   TC3  NEW: token-bearing check, non-empty specTargetFiles, no token
 *        matches any entry → milestone-only
 *   TC4  pin: token exactly matches a specTargetFiles entry → NOT
 *        milestone-only
 *   TC5  matcher parity (suffix: targetFile endsWith '/'+token):
 *        classification and scoping agree — path-scoped AND assigned
 *   TC6  matcher parity (reverse-suffix: token endsWith '/'+targetFile):
 *        classification and scoping agree — path-scoped AND assigned
 *   TC7  pin: multi-token command where at least ONE token matches → NOT
 *        milestone-only
 *   TC8  NEW: findUnassignedSpecHardChecks never returns a
 *        milestone-only-by-target_files check
 *   TC9  pin: findUnassignedSpecHardChecks still returns the check when its
 *        token IS in specTargetFiles
 *   TC10 legacy pin: findUnassignedSpecHardChecks without the 3rd param
 *        returns the unassigned path-bearing check
 *   TC11 NEW: findOrphanedSpecHardChecks never returns a
 *        milestone-only-by-target_files check
 *   TC12 NEW: scopeSpecHardChecks excludes a milestone-only-by-target_files
 *        check even when a task's targetFiles overlap its token
 *   TC13 pin: scopeSpecHardChecks still scopes the check when its token IS
 *        in specTargetFiles
 *   TC14 legacy pin: scopeSpecHardChecks without the 3rd param scopes by
 *        task-targetFiles overlap as before
 *   TC15 NEW: parseSpecTargetFiles returns target_files filtered to
 *        non-empty strings
 *   TC16 NEW: parseSpecTargetFiles → [] when target_files absent / not-array
 *   TC17 NEW: parseSpecTargetFiles throws on missing path and malformed JSON
 *   W1   NEW (reproduced shape): unassigned `node scripts/run-tests.js` spec
 *        command, token NOT in target_files → _executeMilestone completes
 *        (no IncompleteScopeError), verifyMilestone reached
 *   W2   pin: same shape but token IS in target_files → still throws
 *        IncompleteScopeError (gate not weakened)
 *   W3   NEW: drain executes a milestone-only-by-target_files command and
 *        de-duplicates an identical command repeated across criteria
 *
 * Run: node test/test-milestone-only-classification.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import {
  isMilestoneOnlyCheck,
  scopeSpecHardChecks,
  findUnassignedSpecHardChecks,
  findOrphanedSpecHardChecks,
} from '../src/orchestrator/agents/planner.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { IncompleteScopeError } from '../src/orchestrator/core/incomplete-scope-error.js';
import { seedPassedSidecars } from './helpers/seed-passed-sidecars.js';

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
    failCount++;
  }
}

/** Settle-timeout guard: a regression that hangs must fail, not wedge the runner. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`settle-timeout after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// New export may not exist at pre-fix HEAD — dynamic import keeps the rest of
// the file runnable; only the tests that need it go red.
async function getParseSpecTargetFiles() {
  const mod = await import('../src/orchestrator/agents/planner.js');
  assert.strictEqual(typeof mod.parseSpecTargetFiles, 'function',
    `expected planner.js to export parseSpecTargetFiles (got ${typeof mod.parseSpecTargetFiles})`);
  return mod.parseSpecTargetFiles;
}

// ── Fixture vocabulary ───────────────────────────────────────────────────────
// The live-reproduced check shape: path-bearing token `scripts/run-tests.js`.
const REPRO_CMD = 'node scripts/run-tests.js';
const REPRO_TOKEN = 'scripts/run-tests.js';
const reproCheck = () => ({ name: 'full suite passes', command: REPRO_CMD });

// ── spec.json builders ───────────────────────────────────────────────────────

const cmdCriterion = (description, command) =>
  ({ description, verification: { kind: 'command', command } });

function writeSpecJson(root, criteria, targetFiles) {
  const spec = { goal: 'classification fixture spec', acceptance_criteria: criteria };
  if (targetFiles !== undefined) spec.target_files = targetFiles;
  fs.writeFileSync(path.join(root, 'spec.json'), JSON.stringify(spec, null, 2));
}

function makeHelperRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'milestone-only-classification-test-'));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// ── Wiring fixture ───────────────────────────────────────────────────────────
// Mirrors test-spec-criteria-drain.js: real .harness layout on disk, missions
// complete so Phase A/B/C are pass-through, LLM seams stubbed. The coverage
// gate, the spec-criteria drain, and the pure helpers are NEVER stubbed.

function createWiringFixture({ criteria, targetFiles } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'milestone-only-wiring-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(harnessDir, 'logs', 'token-usage.json'),
    JSON.stringify({ sessions: [], totals: {} })
  );

  fs.writeFileSync(path.join(root, 'spec.md'), '# classification fixture spec\n\nNo scenarios here.\n');
  writeSpecJson(root, criteria, targetFiles);

  const msId = '001';
  const miId = `${msId}-001`;
  const smId = `${miId}-001`;
  const taskId = `${smId}-001`;

  const milestones = {
    [msId]: {
      id: msId,
      description: `milestone ${msId}`,
      status: 'in_progress',
      planFile: `.harness/plan/milestone-${msId}.md`,
      missions: {
        [miId]: {
          id: miId,
          description: `mission ${miId}`,
          status: 'complete',
          stateFile: `.harness/state/mission-${miId}.json`,
          planFile: `.harness/plan/mission-${miId}.md`,
        },
      },
    },
  };

  const missionState = {
    id: miId,
    missionId: miId,
    description: `mission ${miId}`,
    status: 'complete',
    subMissions: {
      [smId]: {
        id: smId,
        description: `sub-mission ${smId}`,
        status: 'complete',
        tasks: {
          [taskId]: {
            id: taskId,
            description: `task ${taskId}`,
            status: 'complete',
            targetFiles: [],
            dependencies: [],
            testCases: [],
            tracesScenario: [],
            retryCount: 0,
          },
        },
      },
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${miId}.json`),
    JSON.stringify(missionState, null, 2)
  );
  // Production reality: every complete leaf task carries a PASSED verification
  // sidecar (verified→complete requires it). Seed one so the Phase-5 audit does
  // not throw VerificationAuditError on the synthetic complete task.
  seedPassedSidecars(harnessDir, missionState);
  fs.writeFileSync(
    path.join(harnessDir, 'plan', `mission-${miId}.md`),
    `# Plan for mission ${miId}\n\nFixture plan content.\n`
  );

  const globalState = {
    projectMeta: {
      prdPath: path.join(root, 'spec.md'),
      createdAt: new Date().toISOString(),
      currentPhase: 'executing',
    },
    globalStatus: 'active',
    milestones,
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  const msState = JSON.parse(
    fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8')
  ).milestones[msId];

  return { root, harnessDir, msState, runMsId: msId };
}

function makeWiringPipeline(projectRoot) {
  const trace = { logs: [], reviewerCalls: 0, verifyCalls: 0 };
  const pipeline = new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: (msg) => trace.logs.push(String(msg)),
    onConfirm: async () => true,
  });

  pipeline._planAndApproveMission = async (miId) => {
    throw new Error(`_planAndApproveMission unexpectedly called for ${miId} — fixture missions are complete`);
  };
  pipeline.scheduler.runMilestone = async () => {};
  pipeline._missionRegression = async () => {};
  pipeline.reviewer = {
    reviewMilestone: async () => {
      trace.reviewerCalls += 1;
      return { passed: true, findings: [] };
    },
  };
  pipeline.verifier = {
    verifyRegression: async () => {
      trace.verifyCalls += 1;
      return { verified: true, report: 'ok' };
    },
  };
  pipeline.analyzer = {
    analyzeFailure: async () => ({ eventId: 'fake', recommendation: 'human', affectedTasks: [] }),
  };

  return { pipeline, trace };
}

function teardownPipeline(pipeline) {
  const handlers = pipeline._signalHandlers || {};
  if (handlers.SIGINT) process.removeListener('SIGINT', handlers.SIGINT);
  if (handlers.SIGTERM) process.removeListener('SIGTERM', handlers.SIGTERM);
  if (handlers.exit) process.removeListener('exit', handlers.exit);
  if (handlers.uncaughtException) process.removeListener('uncaughtException', handlers.uncaughtException);
  if (typeof pipeline.destroy === 'function') pipeline.destroy();
}

const WIRING_TIMEOUT_MS = 90_000;

// ═════════════════════════════════════════════════════════════════════════════
// Contract 1 — isMilestoneOnlyCheck(check, specTargetFiles)
// ═════════════════════════════════════════════════════════════════════════════

await test('TC1: legacy pin — zero-path-token check is milestone-only, with and without specTargetFiles', () => {
  const zeroToken = { name: 'lint', command: 'npm run lint' };
  assert.strictEqual(isMilestoneOnlyCheck(zeroToken), true,
    `'npm run lint' must be milestone-only with no 2nd arg`);
  // The zero-token rule is an OR leg: a non-empty specTargetFiles must not
  // flip a zero-token check.
  assert.strictEqual(isMilestoneOnlyCheck(zeroToken, ['src/feature.js']), true,
    `'npm run lint' must stay milestone-only with non-empty specTargetFiles`);
});

await test('TC2: legacy pin — token-bearing check NOT milestone-only when specTargetFiles is absent / [] / non-array', () => {
  assert.strictEqual(isMilestoneOnlyCheck(reproCheck()), false,
    `'${REPRO_CMD}' must NOT be milestone-only with no 2nd arg (legacy)`);
  assert.strictEqual(isMilestoneOnlyCheck(reproCheck(), undefined), false,
    `'${REPRO_CMD}' must NOT be milestone-only with specTargetFiles=undefined`);
  assert.strictEqual(isMilestoneOnlyCheck(reproCheck(), []), false,
    `'${REPRO_CMD}' must NOT be milestone-only with specTargetFiles=[] (empty array → legacy)`);
  assert.strictEqual(isMilestoneOnlyCheck(reproCheck(), 'src/feature.js'), false,
    `'${REPRO_CMD}' must NOT be milestone-only with a non-array specTargetFiles (→ legacy)`);
  assert.strictEqual(isMilestoneOnlyCheck(reproCheck(), null), false,
    `'${REPRO_CMD}' must NOT be milestone-only with specTargetFiles=null (→ legacy)`);
});

await test('TC3: NEW — token-bearing check whose tokens match NO entry of a non-empty specTargetFiles IS milestone-only', () => {
  // The live-reproduced shape: token scripts/run-tests.js, target_files
  // declare other files only.
  assert.strictEqual(
    isMilestoneOnlyCheck(reproCheck(), ['src/feature.js', 'test/test-feature.js']), true,
    `'${REPRO_CMD}' must be milestone-only when no token matches any target_files entry`);
});

await test('TC4: pin — token exactly matching a specTargetFiles entry → NOT milestone-only', () => {
  assert.strictEqual(
    isMilestoneOnlyCheck(reproCheck(), ['src/feature.js', REPRO_TOKEN]), false,
    `'${REPRO_CMD}' must NOT be milestone-only when '${REPRO_TOKEN}' is a target_files entry (exact match)`);
});

await test('TC5: matcher parity (suffix: targetFile endsWith \'/\'+token) — classification and scoping agree', () => {
  // targetFile is an absolute-ish path ending in the relative token.
  const tf = '/abs/project/scripts/run-tests.js';
  const check = reproCheck();

  const pathScoped = !isMilestoneOnlyCheck(check, [tf]);
  assert.strictEqual(pathScoped, true,
    `suffix shape must match: targetFile '${tf}' endsWith '/${REPRO_TOKEN}' → NOT milestone-only`);

  const scopedMap = scopeSpecHardChecks([check], [{ id: 't1', targetFiles: [tf] }], [tf]);
  const assigned = (scopedMap.get('t1') || []).length === 1;
  assert.strictEqual(assigned, true, `suffix shape must scope the check to t1`);

  assert.strictEqual(pathScoped, assigned,
    `classification (${pathScoped}) and scoping (${assigned}) must agree on the suffix shape`);
});

await test('TC6: matcher parity (reverse-suffix: token endsWith \'/\'+targetFile) — classification and scoping agree', () => {
  // Token is an absolute-ish path ending in the relative targetFile.
  const check = { name: 'abs token check', command: 'node /abs/project/scripts/run-tests.js' };
  const tf = REPRO_TOKEN;

  const pathScoped = !isMilestoneOnlyCheck(check, [tf]);
  assert.strictEqual(pathScoped, true,
    `reverse-suffix shape must match: token '/abs/project/${REPRO_TOKEN}' endsWith '/${tf}' → NOT milestone-only`);

  const scopedMap = scopeSpecHardChecks([check], [{ id: 't1', targetFiles: [tf] }], [tf]);
  const assigned = (scopedMap.get('t1') || []).length === 1;
  assert.strictEqual(assigned, true, `reverse-suffix shape must scope the check to t1`);

  assert.strictEqual(pathScoped, assigned,
    `classification (${pathScoped}) and scoping (${assigned}) must agree on the reverse-suffix shape`);
});

await test('TC7: pin — multi-token command where at least ONE token matches → NOT milestone-only', () => {
  const check = { name: 'two tokens', command: 'node scripts/run-tests.js src/feature.js' };
  assert.strictEqual(isMilestoneOnlyCheck(check, ['src/feature.js']), false,
    `a single matching token ('src/feature.js') is enough — must NOT be milestone-only`);
});

// ═════════════════════════════════════════════════════════════════════════════
// Contract 2 — findUnassignedSpecHardChecks / findOrphanedSpecHardChecks
// ═════════════════════════════════════════════════════════════════════════════

await test('TC8: NEW — findUnassignedSpecHardChecks never returns a milestone-only-by-target_files check', () => {
  const result = findUnassignedSpecHardChecks(
    [reproCheck()], new Set(), ['src/feature.js', 'test/test-feature.js']);
  assert.ok(Array.isArray(result), 'Expected an array');
  assert.strictEqual(result.length, 0,
    `expected 0 unassigned checks ('${REPRO_TOKEN}' matches no target_files entry → milestone-only), got ${result.length}: ${JSON.stringify(result)}`);
});

await test('TC9: pin — findUnassignedSpecHardChecks still returns the check when its token IS in specTargetFiles', () => {
  const result = findUnassignedSpecHardChecks(
    [reproCheck()], new Set(), ['src/feature.js', REPRO_TOKEN]);
  assert.strictEqual(result.length, 1,
    `expected 1 unassigned check (token IS a declared deliverable), got ${result.length}`);
  assert.strictEqual(result[0].command, REPRO_CMD);
});

await test('TC10: legacy pin — findUnassignedSpecHardChecks without the 3rd param returns the unassigned path-bearing check', () => {
  const result = findUnassignedSpecHardChecks([reproCheck()], new Set());
  assert.strictEqual(result.length, 1,
    `expected 1 unassigned check (legacy, no specTargetFiles), got ${result.length}`);
  assert.strictEqual(result[0].command, REPRO_CMD);
});

await test('TC11: NEW — findOrphanedSpecHardChecks never returns a milestone-only-by-target_files check', () => {
  const specTargetFiles = ['src/feature.js', 'test/test-feature.js'];
  const checks = [reproCheck()];
  const tasks = [{ id: 't1', targetFiles: ['src/feature.js'] }];
  const scopedMap = scopeSpecHardChecks(checks, tasks, specTargetFiles);
  const orphans = findOrphanedSpecHardChecks(checks, scopedMap, specTargetFiles);
  assert.ok(Array.isArray(orphans), 'Expected an array');
  assert.strictEqual(orphans.length, 0,
    `expected 0 orphans (milestone-only-by-target_files check is never an orphan), got ${orphans.length}: ${JSON.stringify(orphans)}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// Contract 3 — scopeSpecHardChecks(hardChecks, tasks, specTargetFiles)
// ═════════════════════════════════════════════════════════════════════════════

await test('TC12: NEW — scopeSpecHardChecks excludes a milestone-only-by-target_files check even when a task\'s targetFiles overlap', () => {
  // The task DOES declare the file, but spec target_files do not — the check
  // is milestone-only and belongs to the drain, not to task scoping.
  const checks = [reproCheck()];
  const tasks = [{ id: 't1', targetFiles: [REPRO_TOKEN] }];
  const result = scopeSpecHardChecks(checks, tasks, ['src/feature.js']);
  assert.ok(result instanceof Map, 'Expected a Map');
  assert.strictEqual((result.get('t1') || []).length, 0,
    `expected no checks scoped to t1 (check is milestone-only by target_files), got ${(result.get('t1') || []).length}`);
});

await test('TC13: pin — scopeSpecHardChecks still scopes the check when its token IS in specTargetFiles', () => {
  const checks = [reproCheck()];
  const tasks = [{ id: 't1', targetFiles: [REPRO_TOKEN] }];
  const result = scopeSpecHardChecks(checks, tasks, ['src/feature.js', REPRO_TOKEN]);
  const taskChecks = result.get('t1') || [];
  assert.strictEqual(taskChecks.length, 1, `expected 1 check scoped to t1, got ${taskChecks.length}`);
  assert.strictEqual(taskChecks[0].command, REPRO_CMD);
});

await test('TC14: legacy pin — scopeSpecHardChecks without the 3rd param scopes by task-targetFiles overlap as before', () => {
  const checks = [reproCheck()];
  const tasks = [{ id: 't1', targetFiles: [REPRO_TOKEN] }];
  const result = scopeSpecHardChecks(checks, tasks);
  const taskChecks = result.get('t1') || [];
  assert.strictEqual(taskChecks.length, 1, `expected 1 check scoped to t1 (legacy), got ${taskChecks.length}`);
  assert.strictEqual(taskChecks[0].command, REPRO_CMD);
});

// ═════════════════════════════════════════════════════════════════════════════
// Contract 4 — parseSpecTargetFiles(specJsonPath)
// ═════════════════════════════════════════════════════════════════════════════

await test('TC15: NEW — parseSpecTargetFiles returns target_files filtered to non-empty strings', async () => {
  const parseSpecTargetFiles = await getParseSpecTargetFiles();
  const root = makeHelperRoot();
  try {
    fs.writeFileSync(path.join(root, 'spec.json'), JSON.stringify({
      goal: 'fixture',
      acceptance_criteria: [],
      target_files: ['src/feature.js', '', 42, null, 'test/test-feature.js'],
    }));
    const result = parseSpecTargetFiles(path.join(root, 'spec.json'));
    assert.deepStrictEqual(result, ['src/feature.js', 'test/test-feature.js'],
      `expected non-empty strings only, got ${JSON.stringify(result)}`);
  } finally { cleanup(root); }
});

await test('TC16: NEW — parseSpecTargetFiles → [] when target_files is absent or not an array', async () => {
  const parseSpecTargetFiles = await getParseSpecTargetFiles();
  const root = makeHelperRoot();
  try {
    fs.writeFileSync(path.join(root, 'spec-absent.json'),
      JSON.stringify({ goal: 'fixture', acceptance_criteria: [] }));
    assert.deepStrictEqual(parseSpecTargetFiles(path.join(root, 'spec-absent.json')), [],
      'expected [] when target_files is absent');

    fs.writeFileSync(path.join(root, 'spec-nonarray.json'),
      JSON.stringify({ goal: 'fixture', acceptance_criteria: [], target_files: 'src/feature.js' }));
    assert.deepStrictEqual(parseSpecTargetFiles(path.join(root, 'spec-nonarray.json')), [],
      'expected [] when target_files is not an array');
  } finally { cleanup(root); }
});

await test('TC17: NEW — parseSpecTargetFiles throws on missing path and malformed JSON (like parseSpecHardChecks)', async () => {
  const parseSpecTargetFiles = await getParseSpecTargetFiles();
  const root = makeHelperRoot();
  try {
    assert.throws(() => parseSpecTargetFiles(path.join(root, 'no-such-spec.json')),
      undefined, 'expected a throw on a missing spec.json');

    fs.writeFileSync(path.join(root, 'malformed.json'), '{ this is not json');
    assert.throws(() => parseSpecTargetFiles(path.join(root, 'malformed.json')),
      undefined, 'expected a throw on malformed JSON');
  } finally { cleanup(root); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Contract 5 — pipeline coverage-gate shapes (real _executeMilestone path)
// ═════════════════════════════════════════════════════════════════════════════

await test('W1: NEW (reproduced shape) — unassigned spec command whose token is NOT in target_files → run completes, no IncompleteScopeError', async () => {
  const env = createWiringFixture({
    criteria: [cmdCriterion('full suite passes', REPRO_CMD)],
    // target_files declared and non-empty, but scripts/run-tests.js is NOT
    // among them — exactly the live-reproduced green-run kill.
    targetFiles: ['src/feature.js', 'test/test-feature.js'],
  });
  // The drain executes the milestone-only-by-target_files command — give it a
  // real passing script so the run can complete.
  fs.mkdirSync(path.join(env.root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(env.root, 'scripts', 'run-tests.js'), 'process.exit(0);\n');

  const { pipeline, trace } = makeWiringPipeline(env.root);
  try {
    let thrown = null;
    try {
      await withTimeout(pipeline._executeMilestone(env.runMsId, env.msState), WIRING_TIMEOUT_MS, 'W1 _executeMilestone');
    } catch (err) {
      thrown = err;
    }
    assert.ok(!thrown,
      `expected the run to complete — the check is milestone-only by target_files, not a dropped deliverable; got ${thrown && thrown.name}: ${thrown && thrown.message}`);
    assert.strictEqual(trace.verifyCalls, 1,
      `expected verifyMilestone to be reached, verifier called ${trace.verifyCalls}x`);
    const state = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state.json'), 'utf8'));
    assert.strictEqual(state.milestones['001'].status, 'complete',
      `expected milestone 001 to complete, got ${state.milestones['001'].status}`);
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('W2: pin — unassigned spec command whose token IS in target_files still throws IncompleteScopeError (gate not weakened)', async () => {
  const env = createWiringFixture({
    criteria: [cmdCriterion('full suite passes', REPRO_CMD)],
    // The token IS a declared deliverable and no task/sidecar carries the
    // check — a genuinely dropped deliverable: the gate's real purpose.
    targetFiles: [REPRO_TOKEN, 'src/feature.js'],
  });
  const { pipeline } = makeWiringPipeline(env.root);
  try {
    let thrown = null;
    try {
      await withTimeout(pipeline._executeMilestone(env.runMsId, env.msState), WIRING_TIMEOUT_MS, 'W2 _executeMilestone');
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'expected the coverage gate to throw on a genuinely dropped deliverable');
    assert.ok(thrown instanceof IncompleteScopeError,
      `expected IncompleteScopeError, got ${thrown.name}: ${thrown.message}`);
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Contract 6 — drain executes milestone-only-by-target_files commands, deduped
// ═════════════════════════════════════════════════════════════════════════════

await test('W3: NEW — drain executes a milestone-only-by-target_files command once, de-duplicating an identical command across criteria', async () => {
  const APPEND_CMD = 'node scripts/append-run.js';
  const env = createWiringFixture({
    criteria: [
      cmdCriterion('suite passes (criterion one)', APPEND_CMD),
      cmdCriterion('suite passes (criterion two — identical command)', APPEND_CMD),
    ],
    // scripts/append-run.js is NOT among target_files → milestone-only by
    // target_files → the drain is its execution channel.
    targetFiles: ['src/feature.js'],
  });
  // Each execution appends one line — line count is the execution count.
  fs.mkdirSync(path.join(env.root, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(env.root, 'scripts', 'append-run.js'),
    `require('fs').appendFileSync('runs.log', 'ran\\n');\n`
  );

  const { pipeline, trace } = makeWiringPipeline(env.root);
  try {
    let thrown = null;
    try {
      await withTimeout(pipeline._executeMilestone(env.runMsId, env.msState), WIRING_TIMEOUT_MS, 'W3 _executeMilestone');
    } catch (err) {
      thrown = err;
    }
    assert.ok(!thrown,
      `expected the run to complete, got ${thrown && thrown.name}: ${thrown && thrown.message}`);
    const logPath = path.join(env.root, 'runs.log');
    assert.ok(fs.existsSync(logPath),
      'expected the drain to EXECUTE the milestone-only-by-target_files command — runs.log was never created');
    const runs = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(runs.length, 1,
      `expected the identical command to run exactly ONCE (de-duplicated), got ${runs.length} executions`);
    assert.strictEqual(trace.verifyCalls, 1,
      `expected verifyMilestone to be reached, verifier called ${trace.verifyCalls}x`);
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
