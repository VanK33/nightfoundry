// Verified compatible with w4-gate-predicate-fidelity.
/**
 * test-spec-criteria-drain.js — Deterministic execution drain for
 * milestone-only command checks and file-check criteria (line-293 closure).
 *
 * Spec: spec-criteria-drain.spec.md / .json
 *
 * Contracts under test (FROM THE SPEC — written independently of the
 * in-flight implementation):
 *   - planner.js exports parseSpecFileChecks(specJsonPath) → [{name, targetFile}]
 *     built from kind=file-check acceptance criteria (command/manual ignored),
 *     and isMilestoneOnlyCheck(check) → true iff check.command has zero
 *     path-like tokens (contains '/' or ends with a known code/test extension).
 *   - gates/hard-checks.js exports
 *     runMilestoneOnlyChecks(checks, projectRoot, {onLog}) →
 *       {passed, failures:[{name, command, exitCode, outputTail}]}
 *       executing ONLY the zero-path-token subset, sequential, cwd=projectRoot,
 *       never throws; and
 *     runFileCheckCriteria(fileChecks, projectRoot) →
 *       {passed, failures:[{name, targetFile}]} — existence check resolved
 *       against projectRoot, never throws.
 *   - core/spec-criterion-error.js exports SpecCriterionError
 *     (extends Error, carries a .failures array).
 *   - pipeline: a drain at the LAST milestone, after the reviewer gate and
 *     before verifyMilestone, composing the helpers and throwing
 *     SpecCriterionError; fail-soft when no spec.json or zero relevant
 *     criteria; NOT waived by _allowIncompleteScope; kind=manual ignored;
 *     shared _isLastMilestone(msId) with the existing orphan drain.
 *
 * Cases:
 *   H1 isMilestoneOnlyCheck predicate matrix (zero-path-token notion)
 *   H2 parseSpecFileChecks: only kind=file-check parsed; command/manual ignored
 *   H3 runMilestoneOnlyChecks: failing check recorded with exitCode 3 + outputTail
 *   H4 runMilestoneOnlyChecks: passing check (cwd-probe proves cwd=projectRoot)
 *   H5 runMilestoneOnlyChecks: path-bearing command NOT executed (marker proof)
 *   H6 runFileCheckCriteria: absent target → failure naming it; present → passes
 *   H7 SpecCriterionError shape (extends Error, name, .failures)
 *   W1 wiring: failing milestone-only check → _executeMilestone rejects with
 *      SpecCriterionError naming the check, BEFORE verifyMilestone (red at
 *      pre-fix HEAD: the run completes green)
 *   W2 wiring: absent file-check target → SpecCriterionError naming the
 *      targetFile (red at pre-fix HEAD)
 *   W3 wiring: _allowIncompleteScope=true does NOT suppress the drain throw
 *   W4 wiring: a NON-last milestone does not fire the drain (run completes)
 *   W5 wiring: mixed spec all-satisfied → run completes, verifyMilestone
 *      reached, path-bearing check NOT executed at the drain (marker proof),
 *      manual criteria ignored
 *   W6 wiring: no spec.json → drain no-ops (fail-soft)
 *   W7 wiring: only manual criteria → zero relevant → drain no-ops
 *   W8 wiring: existing orphan drain unchanged — unassigned path-bearing spec
 *      check at the last milestone still throws IncompleteScopeError
 *   W9 _isLastMilestone(msId) helper discriminates last vs non-last
 *
 * Run: node test/test-spec-criteria-drain.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
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

// ── Dynamic imports for spec-new symbols ─────────────────────────────────────
// The new exports/module may not exist at pre-fix HEAD. Dynamic import keeps
// the rest of the file runnable: a missing symbol/module fails ONLY the tests
// that need it (expected red before the implementation lands).

const importPlanner = () => import('../src/orchestrator/agents/planner.js');
const importHardChecks = () => import('../src/orchestrator/gates/hard-checks.js');
const importSpecCriterionError = () => import('../src/orchestrator/core/spec-criterion-error.js');

async function getExport(importer, name, moduleLabel) {
  const mod = await importer();
  assert.strictEqual(typeof mod[name], 'function',
    `expected ${moduleLabel} to export ${name} (got ${typeof mod[name]})`);
  return mod[name];
}

// ── Fixture command vocabulary ───────────────────────────────────────────────
// Milestone-only commands (zero path-like tokens — no '/' anywhere, no token
// ending in a known code/test extension):
const FAILING_MO_CMD = `node -e "console.log('drain-boom');console.error('drain-boom');process.exit(3)"`;
const PASSING_MO_CMD = `node -e "process.exit(0)"`;
// Exits 0 ONLY when cwd contains cwd-probe.txt → proves cwd=projectRoot.
// ('.txt' is not a path-like extension, so this stays milestone-only.)
const CWD_PROBE_CMD = `node -e "process.exit(require('fs').existsSync('cwd-probe.txt')?0:7)"`;
// Path-bearing command ('mkmarker.js' ends with .js): if EXECUTED it creates
// marker-ran.txt in cwd — its absence proves the drain skipped it.
const MARKER_CMD = 'node mkmarker.js';
const MARKER_FILE = 'marker-ran.txt';
const MKMARKER_SRC = `require('fs').writeFileSync('${MARKER_FILE}', 'ran');\n`;

// ── spec.json criterion builders ─────────────────────────────────────────────

const cmdCriterion = (description, command) =>
  ({ description, verification: { kind: 'command', command } });
const fileCriterion = (description, targetFile) =>
  ({ description, verification: { kind: 'file-check', targetFile } });
const manualCriterion = (description) =>
  ({ description, verification: { kind: 'manual', manualSteps: ['look at it'] } });

function writeSpecJson(root, criteria) {
  fs.writeFileSync(
    path.join(root, 'spec.json'),
    JSON.stringify({ goal: 'drain fixture spec', acceptance_criteria: criteria }, null, 2)
  );
}

// ── Pure-helper fixture: bare tmp dir as projectRoot ─────────────────────────

function makeHelperRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spec-drain-helper-'));
}

// ── Wiring fixture ───────────────────────────────────────────────────────────
// Mirrors the established harness of test-milestone-gate-rejudge.js /
// test-hard-checks-pipeline-wiring.js: real .harness layout on disk, missions
// complete so Phase A/B/C are pass-through, LLM-bearing seams stubbed
// (planner approval, scheduler, mission regression, reviewer, verifier).
// The drain and the pure helpers are NEVER stubbed.

/**
 * @param {{ milestoneIds?: string[], runMsId?: string,
 *           criteria?: object[]|null,
 *           sidecarChecks?: Array<{name:string,command:string}> }} opts
 *   criteria === null → no spec.json written (fail-soft case).
 *   sidecarChecks → persisted into a verify sidecar of the first mission's
 *   task so path-bearing spec checks count as assigned for the orphan drain.
 */
function createWiringFixture({ milestoneIds = ['001'], runMsId = '001', criteria = null, sidecarChecks = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-drain-wiring-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(harnessDir, 'logs', 'token-usage.json'),
    JSON.stringify({ sessions: [], totals: {} })
  );

  // Scenario-free spec markdown → the real coverage gate logs its skip line.
  fs.writeFileSync(path.join(root, 'spec.md'), '# drain fixture spec\n\nNo scenarios here.\n');
  if (criteria !== null) writeSpecJson(root, criteria);

  // Script the path-bearing marker command would run IF executed.
  fs.writeFileSync(path.join(root, 'mkmarker.js'), MKMARKER_SRC);
  // cwd probe target for milestone-only commands that assert cwd=projectRoot.
  fs.writeFileSync(path.join(root, 'cwd-probe.txt'), 'probe');

  const milestones = {};
  for (const msId of milestoneIds) {
    const miId = `${msId}-001`;
    const smId = `${miId}-001`;
    const taskId = `${smId}-001`;

    milestones[msId] = {
      id: msId,
      description: `milestone ${msId}`,
      status: msId === runMsId ? 'in_progress' : 'pending',
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
    // sidecar (verified→complete requires it). Seed one so the Phase-5 audit
    // does not throw VerificationAuditError on the synthetic complete task.
    seedPassedSidecars(harnessDir, missionState);
    fs.writeFileSync(
      path.join(harnessDir, 'plan', `mission-${miId}.md`),
      `# Plan for mission ${miId}\n\nFixture plan content.\n`
    );
  }

  if (sidecarChecks.length > 0) {
    // Persisted home of assigned hardChecks (production ground truth read by
    // the orphan drain): the verify sidecar of the run-milestone's task.
    const taskId = `${runMsId}-001-001-001`;
    fs.writeFileSync(
      path.join(harnessDir, 'verify', `task-${taskId}.json`),
      JSON.stringify({ taskId, targetFiles: [], hardChecks: sidecarChecks, testCases: [] })
    );
  }

  const globalState = {
    projectMeta: {
      // Absolute, matching the established drain fixtures (createDrainEnv in
      // test-hard-checks-pipeline-wiring.js): deriveSpecJsonPath keeps the
      // prdPath's own base, so a bare relative path would resolve spec.json
      // against process.cwd() instead of the fixture root.
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
  ).milestones[runMsId];

  return { root, harnessDir, msState, runMsId };
}

/**
 * Pipeline with ONLY the LLM-bearing seams stubbed:
 *   - _planAndApproveMission: must never be called (all missions complete)
 *   - scheduler.runMilestone: recorded no-op (tasks already terminal on disk)
 *   - _missionRegression: recorded no-op
 *   - reviewer.reviewMilestone: recorded PASS
 *   - verifier.verifyRegression: recorded PASS (verifyMilestone's LLM seam)
 * The spec-criteria drain, the pure helpers, the orphan drain, and the real
 * _executeMilestone control flow are all left intact.
 */
function makeWiringPipeline(projectRoot) {
  const trace = { logs: [], reviewerCalls: 0, verifyCalls: 0, regressionCalls: [], schedulerInvocations: 0 };
  const pipeline = new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: (msg) => trace.logs.push(String(msg)),
    onConfirm: async () => true,
  });

  pipeline._planAndApproveMission = async (miId) => {
    throw new Error(`_planAndApproveMission unexpectedly called for ${miId} — fixture missions are complete`);
  };
  pipeline.scheduler.runMilestone = async () => { trace.schedulerInvocations += 1; };
  pipeline._missionRegression = async (miId) => { trace.regressionCalls.push(miId); };
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

/**
 * Remove the process signal listeners the Pipeline constructor registers and
 * clear timers, so repeated Pipeline construction across tests doesn't pile up
 * listeners or leak intervals.
 */
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
// Pure-helper cases
// ═════════════════════════════════════════════════════════════════════════════

await test('H1: isMilestoneOnlyCheck — true iff command has zero path-like tokens', async () => {
  const isMilestoneOnlyCheck = await getExport(importPlanner, 'isMilestoneOnlyCheck', 'planner.js');

  // Zero path tokens → milestone-only.
  assert.strictEqual(isMilestoneOnlyCheck({ name: 'lint', command: 'npm run lint' }), true,
    `'npm run lint' must be milestone-only`);
  assert.strictEqual(isMilestoneOnlyCheck({ name: 'exit3', command: FAILING_MO_CMD }), true,
    `'${FAILING_MO_CMD}' must be milestone-only (no path-like tokens)`);

  // Path-bearing (contains '/' or token ends with a code/test extension).
  assert.strictEqual(isMilestoneOnlyCheck({ name: 'slash', command: 'node test/foo.js' }), false,
    `'node test/foo.js' must NOT be milestone-only (contains '/')`);
  assert.strictEqual(isMilestoneOnlyCheck({ name: 'ext', command: 'node script.js' }), false,
    `'node script.js' must NOT be milestone-only (token ends with .js)`);
  // Quoted path token: edge-punctuation stripping is part of the existing
  // path-token notion the predicate must single-source.
  assert.strictEqual(isMilestoneOnlyCheck({ name: 'quoted', command: 'bash -c "node test/foo.js"' }), false,
    `'bash -c "node test/foo.js"' must NOT be milestone-only (quoted path token)`);
});

await test('H2: parseSpecFileChecks — [{name, targetFile}] from kind=file-check only; command/manual ignored', async () => {
  const parseSpecFileChecks = await getExport(importPlanner, 'parseSpecFileChecks', 'planner.js');
  const root = makeHelperRoot();
  try {
    writeSpecJson(root, [
      cmdCriterion('a command criterion', 'node test/foo.js'),
      fileCriterion('deliverable one exists', 'docs/out.md'),
      manualCriterion('a human looks at the UI'),
      fileCriterion('deliverable two exists', 'artifacts/report.json'),
    ]);
    const result = parseSpecFileChecks(path.join(root, 'spec.json'));
    assert.ok(Array.isArray(result), `expected an array, got ${typeof result}`);
    assert.strictEqual(result.length, 2,
      `expected exactly the 2 file-check criteria, got ${result.length}: ${JSON.stringify(result)}`);
    const byTarget = new Map(result.map((c) => [c.targetFile, c.name]));
    assert.strictEqual(byTarget.get('docs/out.md'), 'deliverable one exists');
    assert.strictEqual(byTarget.get('artifacts/report.json'), 'deliverable two exists');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await test('H3: runMilestoneOnlyChecks — failing check recorded with name, command, exitCode 3, outputTail; no throw', async () => {
  const runMilestoneOnlyChecks = await getExport(importHardChecks, 'runMilestoneOnlyChecks', 'gates/hard-checks.js');
  const root = makeHelperRoot();
  try {
    const logs = [];
    const result = await withTimeout(
      Promise.resolve(runMilestoneOnlyChecks(
        [{ name: 'failing milestone-only check', command: FAILING_MO_CMD }],
        root,
        { onLog: (m) => logs.push(String(m)) }
      )),
      30_000, 'runMilestoneOnlyChecks failing check'
    );
    assert.strictEqual(result.passed, false, `expected passed=false, got ${JSON.stringify(result)}`);
    assert.ok(Array.isArray(result.failures) && result.failures.length === 1,
      `expected exactly 1 failure, got ${JSON.stringify(result.failures)}`);
    const f = result.failures[0];
    assert.strictEqual(f.name, 'failing milestone-only check');
    assert.strictEqual(f.command, FAILING_MO_CMD);
    assert.strictEqual(f.exitCode, 3, `expected exitCode 3, got ${f.exitCode}`);
    assert.ok(typeof f.outputTail === 'string' && f.outputTail.includes('drain-boom'),
      `expected outputTail to capture 'drain-boom', got: ${JSON.stringify(f.outputTail)}`);
    // Long-op visibility: a per-check progress log line before execution.
    assert.ok(logs.length >= 1, `expected at least one onLog progress line, got ${logs.length}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await test('H4: runMilestoneOnlyChecks — passing check passes; cwd-probe proves cwd=projectRoot', async () => {
  const runMilestoneOnlyChecks = await getExport(importHardChecks, 'runMilestoneOnlyChecks', 'gates/hard-checks.js');
  const root = makeHelperRoot();
  try {
    // Exits 0 only when cwd-probe.txt exists in cwd — written into projectRoot.
    fs.writeFileSync(path.join(root, 'cwd-probe.txt'), 'probe');
    const result = await withTimeout(
      Promise.resolve(runMilestoneOnlyChecks(
        [{ name: 'cwd probe', command: CWD_PROBE_CMD }],
        root,
        { onLog: () => {} }
      )),
      30_000, 'runMilestoneOnlyChecks passing check'
    );
    assert.strictEqual(result.passed, true,
      `expected passed=true (cwd must be projectRoot), got ${JSON.stringify(result)}`);
    assert.ok(Array.isArray(result.failures) && result.failures.length === 0,
      `expected zero failures, got ${JSON.stringify(result.failures)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await test('H5: runMilestoneOnlyChecks — path-bearing command is NOT executed (marker proof)', async () => {
  const runMilestoneOnlyChecks = await getExport(importHardChecks, 'runMilestoneOnlyChecks', 'gates/hard-checks.js');
  const root = makeHelperRoot();
  try {
    fs.writeFileSync(path.join(root, 'mkmarker.js'), MKMARKER_SRC);
    const result = await withTimeout(
      Promise.resolve(runMilestoneOnlyChecks(
        [
          { name: 'path-bearing — must be skipped', command: MARKER_CMD },
          { name: 'milestone-only pass', command: PASSING_MO_CMD },
        ],
        root,
        { onLog: () => {} }
      )),
      30_000, 'runMilestoneOnlyChecks mixed subset'
    );
    assert.ok(!fs.existsSync(path.join(root, MARKER_FILE)),
      `path-bearing command '${MARKER_CMD}' must NOT execute at the drain — marker file was created`);
    assert.strictEqual(result.passed, true,
      `the milestone-only subset all passes → passed=true, got ${JSON.stringify(result)}`);
    assert.ok(Array.isArray(result.failures) && result.failures.length === 0,
      `expected zero failures, got ${JSON.stringify(result.failures)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await test('H6: runFileCheckCriteria — absent target fails naming it; present target passes; resolved against projectRoot', async () => {
  const runFileCheckCriteria = await getExport(importHardChecks, 'runFileCheckCriteria', 'gates/hard-checks.js');
  const root = makeHelperRoot();
  try {
    const checks = [{ name: 'deliverable exists', targetFile: 'out/deliverable.txt' }];

    const missing = await withTimeout(
      Promise.resolve(runFileCheckCriteria(checks, root)),
      30_000, 'runFileCheckCriteria absent'
    );
    assert.strictEqual(missing.passed, false, `expected passed=false, got ${JSON.stringify(missing)}`);
    assert.ok(Array.isArray(missing.failures) && missing.failures.length === 1,
      `expected exactly 1 failure, got ${JSON.stringify(missing.failures)}`);
    assert.strictEqual(missing.failures[0].name, 'deliverable exists');
    assert.strictEqual(missing.failures[0].targetFile, 'out/deliverable.txt');

    // Create the relative target UNDER projectRoot → proves resolution base.
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'out', 'deliverable.txt'), 'present');
    const present = await withTimeout(
      Promise.resolve(runFileCheckCriteria(checks, root)),
      30_000, 'runFileCheckCriteria present'
    );
    assert.strictEqual(present.passed, true, `expected passed=true, got ${JSON.stringify(present)}`);
    assert.ok(Array.isArray(present.failures) && present.failures.length === 0,
      `expected zero failures, got ${JSON.stringify(present.failures)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await test('H7: SpecCriterionError — extends Error, name set, carries the failures array', async () => {
  const mod = await importSpecCriterionError();
  const SpecCriterionError = mod.SpecCriterionError;
  assert.strictEqual(typeof SpecCriterionError, 'function',
    'expected core/spec-criterion-error.js to export SpecCriterionError');
  const failures = [{ name: 'failing milestone-only check', command: FAILING_MO_CMD, exitCode: 3, outputTail: 'drain-boom' }];
  const err = new SpecCriterionError(failures);
  assert.ok(err instanceof Error, 'SpecCriterionError must extend Error');
  assert.strictEqual(err.name, 'SpecCriterionError');
  assert.ok(Array.isArray(err.failures), `expected .failures array, got ${typeof err.failures}`);
  assert.strictEqual(err.failures.length, 1);
  assert.strictEqual(err.failures[0].name, 'failing milestone-only check');
  assert.ok(typeof err.message === 'string' && err.message.length > 0, 'expected a non-empty message');
});

// ═════════════════════════════════════════════════════════════════════════════
// Wiring cases — real pipeline path through _executeMilestone with a real
// spec.json on disk; only LLM seams stubbed.
// ═════════════════════════════════════════════════════════════════════════════

await test('W1: failing milestone-only check → _executeMilestone rejects with SpecCriterionError naming the check, before verifyMilestone (red at pre-fix HEAD)', async () => {
  const env = createWiringFixture({
    criteria: [cmdCriterion('drain-fail criterion', FAILING_MO_CMD)],
  });
  const { pipeline, trace } = makeWiringPipeline(env.root);
  try {
    let thrown = null;
    try {
      await withTimeout(pipeline._executeMilestone(env.runMsId, env.msState), WIRING_TIMEOUT_MS, 'W1 _executeMilestone');
    } catch (err) {
      thrown = err;
    }
    // Drive the pipeline BEFORE importing the new error module so the pre-fix
    // failure mode is the false-green itself, not a module-resolution error.
    assert.ok(thrown,
      'expected _executeMilestone to reject via the spec-criteria drain — the run completed green (pre-fix false-green)');
    const { SpecCriterionError } = await importSpecCriterionError();
    assert.ok(thrown instanceof SpecCriterionError,
      `expected SpecCriterionError, got ${thrown.name}: ${thrown.message}`);
    assert.ok(Array.isArray(thrown.failures), `expected .failures array on the error, got ${typeof thrown.failures}`);
    assert.ok(
      thrown.failures.some((f) =>
        f.name === 'drain-fail criterion' || (typeof f.command === 'string' && f.command === FAILING_MO_CMD)),
      `expected failures to name the check, got ${JSON.stringify(thrown.failures)}`
    );
    // Deterministic gate precedes LLM judgment: verifyMilestone never reached.
    assert.strictEqual(trace.verifyCalls, 0,
      `verifyMilestone must NOT run after a drain failure, verifier called ${trace.verifyCalls}x`);
    // Drain placement is after the reviewer gate — the reviewer DID run.
    assert.strictEqual(trace.reviewerCalls, 1,
      `expected the reviewer gate to have run before the drain, got ${trace.reviewerCalls} calls`);
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('W2: absent file-check target → SpecCriterionError naming the targetFile (red at pre-fix HEAD)', async () => {
  const env = createWiringFixture({
    criteria: [fileCriterion('spec deliverable exists', 'deliverables/missing-artifact.md')],
  });
  const { pipeline, trace } = makeWiringPipeline(env.root);
  try {
    let thrown = null;
    try {
      await withTimeout(pipeline._executeMilestone(env.runMsId, env.msState), WIRING_TIMEOUT_MS, 'W2 _executeMilestone');
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown,
      'expected _executeMilestone to reject on the absent file-check target — the run completed green (pre-fix false-green)');
    const { SpecCriterionError } = await importSpecCriterionError();
    assert.ok(thrown instanceof SpecCriterionError,
      `expected SpecCriterionError, got ${thrown.name}: ${thrown.message}`);
    assert.ok(
      (thrown.failures || []).some((f) => f.targetFile === 'deliverables/missing-artifact.md'),
      `expected failures to name the targetFile, got ${JSON.stringify(thrown.failures)}`
    );
    assert.strictEqual(trace.verifyCalls, 0,
      `verifyMilestone must NOT run after a drain failure, verifier called ${trace.verifyCalls}x`);
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('W3: _allowIncompleteScope=true does NOT waive a drain failure', async () => {
  const env = createWiringFixture({
    criteria: [cmdCriterion('drain-fail criterion', FAILING_MO_CMD)],
  });
  const { pipeline } = makeWiringPipeline(env.root);
  try {
    pipeline._allowIncompleteScope = true;
    let thrown = null;
    try {
      await withTimeout(pipeline._executeMilestone(env.runMsId, env.msState), WIRING_TIMEOUT_MS, 'W3 _executeMilestone');
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown,
      '_allowIncompleteScope waives scope-assignment uncertainty only — a drain failure must still throw');
    const { SpecCriterionError } = await importSpecCriterionError();
    assert.ok(thrown instanceof SpecCriterionError,
      `expected SpecCriterionError, got ${thrown.name}: ${thrown.message}`);
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('W4: NON-last milestone does not fire the drain — failing criterion, run completes', async () => {
  const env = createWiringFixture({
    milestoneIds: ['001', '002'],
    runMsId: '001',
    criteria: [cmdCriterion('drain-fail criterion', FAILING_MO_CMD)],
  });
  const { pipeline, trace } = makeWiringPipeline(env.root);
  try {
    // Milestone '001' is not last ('002' exists) → the drain must not fire and
    // the milestone proceeds through verifyMilestone to completion.
    await withTimeout(pipeline._executeMilestone(env.runMsId, env.msState), WIRING_TIMEOUT_MS, 'W4 _executeMilestone');
    assert.strictEqual(trace.verifyCalls, 1,
      `expected verifyMilestone to run on the non-last milestone, verifier called ${trace.verifyCalls}x`);
    const state = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state.json'), 'utf8'));
    assert.strictEqual(state.milestones['001'].status, 'complete',
      `expected milestone 001 to complete, got ${state.milestones['001'].status}`);
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('W5: mixed spec all-satisfied → drain passes, verifyMilestone reached, scoped path-bearing check not executed at the drain, manual ignored', async () => {
  const env = createWiringFixture({
    criteria: [
      cmdCriterion('milestone-only passes', CWD_PROBE_CMD),
      // Path-bearing check, assigned via a verify sidecar (its existing
      // scoping/orphan channel) — the drain must not execute it.
      cmdCriterion('path-bearing scoped check', MARKER_CMD),
      fileCriterion('deliverable exists', 'out/deliverable.txt'),
      manualCriterion('a human admires the output'),
    ],
    sidecarChecks: [{ name: 'path-bearing scoped check', command: MARKER_CMD }],
  });
  fs.mkdirSync(path.join(env.root, 'out'), { recursive: true });
  fs.writeFileSync(path.join(env.root, 'out', 'deliverable.txt'), 'present');
  const { pipeline, trace } = makeWiringPipeline(env.root);
  try {
    await withTimeout(pipeline._executeMilestone(env.runMsId, env.msState), WIRING_TIMEOUT_MS, 'W5 _executeMilestone');
    assert.strictEqual(trace.verifyCalls, 1,
      `expected the pipeline to proceed to verifyMilestone, verifier called ${trace.verifyCalls}x`);
    assert.ok(!fs.existsSync(path.join(env.root, MARKER_FILE)),
      `the scoped path-bearing check must NOT execute at the drain (no double execution) — marker file was created`);
    const state = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state.json'), 'utf8'));
    assert.strictEqual(state.milestones['001'].status, 'complete',
      `expected milestone 001 to complete, got ${state.milestones['001'].status}`);
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('W6: fail-soft — no spec.json → drain no-ops, run completes', async () => {
  const env = createWiringFixture({ criteria: null });
  const { pipeline, trace } = makeWiringPipeline(env.root);
  try {
    await withTimeout(pipeline._executeMilestone(env.runMsId, env.msState), WIRING_TIMEOUT_MS, 'W6 _executeMilestone');
    assert.strictEqual(trace.verifyCalls, 1,
      `expected verifyMilestone reached with no spec.json, verifier called ${trace.verifyCalls}x`);
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('W7: fail-soft — only kind=manual criteria (zero relevant) → drain no-ops, run completes', async () => {
  const env = createWiringFixture({
    criteria: [manualCriterion('a human verifies the rendering by hand')],
  });
  const { pipeline, trace } = makeWiringPipeline(env.root);
  try {
    await withTimeout(pipeline._executeMilestone(env.runMsId, env.msState), WIRING_TIMEOUT_MS, 'W7 _executeMilestone');
    assert.strictEqual(trace.verifyCalls, 1,
      `expected verifyMilestone reached with manual-only criteria, verifier called ${trace.verifyCalls}x`);
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('W8: existing orphan drain unchanged — unassigned path-bearing spec check at the last milestone still throws IncompleteScopeError', async () => {
  const env = createWiringFixture({
    criteria: [cmdCriterion('orphan path-bearing criterion', 'node test/orphan.js')],
  });
  const { pipeline } = makeWiringPipeline(env.root);
  try {
    let thrown = null;
    try {
      await withTimeout(pipeline._executeMilestone(env.runMsId, env.msState), WIRING_TIMEOUT_MS, 'W8 _executeMilestone');
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'expected the orphan hard-check drain to throw on an unassigned path-bearing check');
    assert.ok(thrown instanceof IncompleteScopeError,
      `expected IncompleteScopeError (orphan drain behavior unchanged), got ${thrown.name}: ${thrown.message}`);
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('W9: _isLastMilestone(msId) — shared last-milestone helper discriminates last vs non-last', async () => {
  const env = createWiringFixture({ milestoneIds: ['001', '002'], runMsId: '001', criteria: null });
  const { pipeline } = makeWiringPipeline(env.root);
  try {
    assert.strictEqual(typeof pipeline._isLastMilestone, 'function',
      'expected the shared _isLastMilestone(msId) helper on Pipeline');
    assert.ok(pipeline._isLastMilestone('002'), `expected '002' to be the last milestone`);
    assert.ok(!pipeline._isLastMilestone('001'), `expected '001' NOT to be the last milestone`);
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
