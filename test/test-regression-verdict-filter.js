/**
 * test-regression-verdict-filter.js — behavior tests for
 * shouldDowngradeRegressionFail (src/orchestrator/gates/regression-verdict-filter.js)
 * PLUS its two production consumer wiring sites in Pipeline
 * (_missionRegression and the milestone-regression section of
 * _executeMilestone, src/orchestrator/core/pipeline.js).
 *
 * Fixtures reconstruct the real regressionVerifierSchema sidecar shape
 * (result/hardChecks/taskScopeChecks/standardsChecks/notes/
 * back_reference_check/findings — see agents/_schemas.js) faithfully, in
 * BOTH the taskScopeChecks-only form (scenario a, mirroring incident #176)
 * and the hardChecks+duplicated form (scenario g, mirroring #177), and use
 * REAL git repos (fs.mkdtempSync + `git init` + an initial commit) for the
 * file-state arms so `git cat-file -e HEAD:F` / `git diff HEAD --quiet -- F`
 * exercise real object state, not mocks.
 *
 * Scenarios:
 *   (a) 176 replay — never-existed test file + untouched-at-HEAD
 *       scripts/run-tests.js, both pending-scoped, every FAIL check
 *       textually attributed → downgrade true.
 *   (b) counterexample — identical shape but scripts/run-tests.js MODIFIED
 *       on the working tree (registration line deleted) → downgrade false.
 *   (c) a FAIL check mentioning no downgraded finding's path → false.
 *   (d) empty findings / missing structured / findings lacking a string
 *       `file` → false each (vacuous-quantifier trap).
 *   (e) empty pendingTargetFiles → false.
 *   (f) non-git root and git-error paths → false WITHOUT throwing.
 *   (g) 177 shape — 4 FAIL checks, 2 findings, all attributed → true (pins
 *       that a count rule would be wrong).
 *   (h) mission-regression consumer wiring (Pipeline._missionRegression):
 *       a real (non-isStub) FAILED structured verdict that qualifies for
 *       downgrade passes the gate, emits a [regression-sequencing-override]
 *       log line, writes the gateOverrides sidecar + warnings-ledger
 *       records, and NEVER reaches analyzer.analyzeFailure; a
 *       non-qualifying FAIL still calls analyzeFailure.
 *   (i) milestone-regression consumer wiring (Pipeline._executeMilestone):
 *       a downgrade-qualifying milestone-regression FAIL skips the
 *       remediation loop (no remediateRegressionFailure call, no
 *       analyzeFailure call) and passes the gate.
 *
 * Run: node test/test-regression-verdict-filter.js
 */

// Module-top marker discipline: clear before any other logic runs (mirrors
// scripts/run-tests.js's parent-level clear for the whole suite) so this
// file never falsely trips assertNoReentrantLiveRun against its own
// mkdtemp fixture roots.
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { shouldDowngradeRegressionFail } from '../src/orchestrator/gates/regression-verdict-filter.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';

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

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ── Git fixture helpers ──────────────────────────────────────────────────

function gitInit(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
}

function gitCommitAll(dir, message) {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', message], { cwd: dir, stdio: 'pipe' });
}

/**
 * Real-git-repo fixture with a committed scripts/run-tests.js manifest,
 * mirroring the production shape (a TEST_FILES registration array) closely
 * enough for the "registration line deleted" counterexample (scenario b)
 * to make sense.
 */
const RUN_TESTS_CONTENT =
  `#!/usr/bin/env node\n` +
  `// scripts/run-tests.js fixture — mirrors the production TEST_FILES manifest.\n` +
  `export const TEST_FILES = [\n` +
  `  'test/test-alpha.js',\n` +
  `  'test/test-beta-registration.js',\n` +
  `  'test/test-gamma.js',\n` +
  `];\n`;

function makeSidecarProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-filter-sidecar-'));
  gitInit(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sidecar-fixture', version: '1.0.0' }, null, 2));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'run-tests.js'), RUN_TESTS_CONTENT);
  gitCommitAll(root, 'initial commit');
  return root;
}

/** A bare mkdtemp dir with no `.git` at all (fail-closed non-git case). */
function makeNonGitProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-filter-nongit-'));
}

// ── Production sidecar shape builders ────────────────────────────────────

function backRefCheck() {
  return { spec_consulted: true, plan_consulted: true, deviations: [] };
}

/** Faithful regressionVerifierSchema shape, taskScopeChecks-only form (#176). */
function makeStructuredTaskScopeForm({ findings, taskScopeChecks }) {
  return {
    result: 'FAILED',
    hardChecks: [],
    taskScopeChecks,
    standardsChecks: [],
    notes: '',
    back_reference_check: backRefCheck(),
    findings,
  };
}

/** Faithful regressionVerifierSchema shape, hardChecks+duplicated form (#177). */
function makeStructuredDuplicatedForm({ findings, checks }) {
  return {
    result: 'FAILED',
    hardChecks: checks,
    taskScopeChecks: checks,
    standardsChecks: [],
    notes: '',
    back_reference_check: backRefCheck(),
    findings,
  };
}

async function run() {

// ── TC1: module-top delete process.env.CC_ORCH_ACTIVE_RUN ──────────────────

await test('TC1: module-top `delete process.env.CC_ORCH_ACTIVE_RUN` precedes all other logic', () => {
  assert.strictEqual(
    process.env.CC_ORCH_ACTIVE_RUN, undefined,
    'CC_ORCH_ACTIVE_RUN must be deleted from the environment'
  );
  const selfPath = fileURLToPath(import.meta.url);
  const src = fs.readFileSync(selfPath, 'utf8');
  const deleteIdx = src.indexOf('delete process.env.CC_ORCH_ACTIVE_RUN');
  assert.ok(deleteIdx >= 0, 'source must contain the delete statement');
  const firstImportIdx = src.indexOf('\nimport ');
  assert.ok(firstImportIdx >= 0, 'source must contain at least one import statement');
  assert.ok(
    deleteIdx < firstImportIdx,
    `delete statement (index ${deleteIdx}) must precede the first import statement (index ${firstImportIdx})`
  );
});

// ── (a) 176 replay ───────────────────────────────────────────────────────

await test('(a) 176 replay: never-existed test file + untouched run-tests.js, pending-scoped, all FAIL attributed → downgrade true', () => {
  const root = makeSidecarProject();
  try {
    const ghostFile = 'test/test-176-ghost.js';
    const runTestsFile = 'scripts/run-tests.js';
    const findings = [
      { file: ghostFile, description: 'Verifier could not locate the test file for this task on the working tree.' },
      { file: runTestsFile, description: `${runTestsFile} does not register ${ghostFile} in its TEST_FILES manifest.` },
    ];
    const structured = makeStructuredTaskScopeForm({
      findings,
      taskScopeChecks: [
        { description: 'New test file exists on disk', status: 'FAIL', evidence: `${ghostFile} was not found in the working tree.` },
        { description: 'Test file is registered in run-tests.js', status: 'FAIL', evidence: `${runTestsFile} does not contain a registration entry for ${ghostFile}.` },
      ],
    });
    const res = shouldDowngradeRegressionFail({
      structured,
      pendingTargetFiles: [ghostFile, runTestsFile],
      projectRoot: root,
      completedAffectedFiles: [],
    });
    assert.strictEqual(res.downgrade, true, `expected downgrade true; reason: ${res.reason}`);
    assert.deepStrictEqual(res.downgradedFindings, findings, 'downgradedFindings must deep-equal findings');
  } finally {
    cleanup(root);
  }
});

// ── (b) counterexample ───────────────────────────────────────────────────

await test('(b) counterexample: run-tests.js modified on tree (registration line deleted) → downgrade false', () => {
  const root = makeSidecarProject();
  try {
    const ghostFile = 'test/test-176-ghost.js';
    const runTestsFile = 'scripts/run-tests.js';

    // Simulate the registration line being deleted from the working tree —
    // scripts/run-tests.js now differs from HEAD.
    const runTestsPath = path.join(root, 'scripts', 'run-tests.js');
    const original = fs.readFileSync(runTestsPath, 'utf8');
    const modified = original
      .split('\n')
      .filter((line) => !line.includes("'test/test-beta-registration.js'"))
      .join('\n');
    assert.notStrictEqual(modified, original, 'fixture setup must actually remove the registration line');
    fs.writeFileSync(runTestsPath, modified);

    const findings = [
      { file: ghostFile, description: 'Verifier could not locate the test file for this task on the working tree.' },
      { file: runTestsFile, description: `${runTestsFile} does not register ${ghostFile} in its TEST_FILES manifest.` },
    ];
    const structured = makeStructuredTaskScopeForm({
      findings,
      taskScopeChecks: [
        { description: 'New test file exists on disk', status: 'FAIL', evidence: `${ghostFile} was not found in the working tree.` },
        { description: 'Test file is registered in run-tests.js', status: 'FAIL', evidence: `${runTestsFile} does not contain a registration entry for ${ghostFile}.` },
      ],
    });
    const res = shouldDowngradeRegressionFail({
      structured,
      pendingTargetFiles: [ghostFile, runTestsFile],
      projectRoot: root,
      completedAffectedFiles: [],
    });
    assert.strictEqual(res.downgrade, false, 'must not downgrade when scripts/run-tests.js is dirty vs HEAD');
  } finally {
    cleanup(root);
  }
});

// ── (c) unattributed FAIL check ──────────────────────────────────────────

await test('(c) a FAIL check mentioning no downgraded finding\'s path → downgrade false', () => {
  const root = makeSidecarProject();
  try {
    const ghostFile = 'test/test-176-ghost.js';
    const runTestsFile = 'scripts/run-tests.js';
    const findings = [
      { file: ghostFile, description: 'never existed' },
      { file: runTestsFile, description: 'untouched at HEAD' },
    ];
    const structured = makeStructuredTaskScopeForm({
      findings,
      taskScopeChecks: [
        { description: 'New test file exists on disk', status: 'FAIL', evidence: `${ghostFile} was not found in the working tree.` },
        { description: 'Test file is registered in run-tests.js', status: 'FAIL', evidence: `${runTestsFile} does not contain a registration entry for ${ghostFile}.` },
        // Unattributed: no downgraded finding's file path appears anywhere here.
        { description: 'Unrelated smoke check', status: 'FAIL', evidence: 'the build produced unexpected warnings' },
      ],
    });
    const res = shouldDowngradeRegressionFail({
      structured,
      pendingTargetFiles: [ghostFile, runTestsFile],
      projectRoot: root,
      completedAffectedFiles: [],
    });
    assert.strictEqual(res.downgrade, false, 'must not downgrade when a FAIL check references no downgraded file');
  } finally {
    cleanup(root);
  }
});

// ── (d) vacuous-quantifier trap ──────────────────────────────────────────

await test('(d-1) empty findings → downgrade false', () => {
  const root = makeSidecarProject();
  try {
    const structured = makeStructuredTaskScopeForm({
      findings: [],
      taskScopeChecks: [{ description: 'something', status: 'FAIL', evidence: 'something failed' }],
    });
    const res = shouldDowngradeRegressionFail({
      structured,
      pendingTargetFiles: ['test/test-176-ghost.js'],
      projectRoot: root,
      completedAffectedFiles: [],
    });
    assert.strictEqual(res.downgrade, false, 'must not downgrade when findings is empty (vacuous quantifier)');
  } finally {
    cleanup(root);
  }
});

await test('(d-2) missing structured verdict → downgrade false', () => {
  const root = makeSidecarProject();
  try {
    const res1 = shouldDowngradeRegressionFail({
      structured: undefined,
      pendingTargetFiles: ['test/test-176-ghost.js'],
      projectRoot: root,
      completedAffectedFiles: [],
    });
    assert.strictEqual(res1.downgrade, false, 'undefined structured must not downgrade');

    const res2 = shouldDowngradeRegressionFail({
      structured: null,
      pendingTargetFiles: ['test/test-176-ghost.js'],
      projectRoot: root,
      completedAffectedFiles: [],
    });
    assert.strictEqual(res2.downgrade, false, 'null structured must not downgrade');
  } finally {
    cleanup(root);
  }
});

await test('(d-3) finding lacking a string `file` field → downgrade false', () => {
  const root = makeSidecarProject();
  try {
    const structured = makeStructuredTaskScopeForm({
      findings: [{ description: 'no file field here' }],
      taskScopeChecks: [{ description: 'something', status: 'FAIL', evidence: 'something failed' }],
    });
    const res = shouldDowngradeRegressionFail({
      structured,
      pendingTargetFiles: ['test/test-176-ghost.js'],
      projectRoot: root,
      completedAffectedFiles: [],
    });
    assert.strictEqual(res.downgrade, false, 'must not downgrade when a finding lacks a string `file`');
  } finally {
    cleanup(root);
  }
});

// ── (e) empty pendingTargetFiles ─────────────────────────────────────────

await test('(e) empty pendingTargetFiles → downgrade false', () => {
  const root = makeSidecarProject();
  try {
    const ghostFile = 'test/test-176-ghost.js';
    const structured = makeStructuredTaskScopeForm({
      findings: [{ file: ghostFile, description: 'never existed' }],
      taskScopeChecks: [{ description: 'exists', status: 'FAIL', evidence: `${ghostFile} not found` }],
    });
    const res = shouldDowngradeRegressionFail({
      structured,
      pendingTargetFiles: [],
      projectRoot: root,
      completedAffectedFiles: [],
    });
    assert.strictEqual(res.downgrade, false, 'must not downgrade when pendingTargetFiles is empty');
  } finally {
    cleanup(root);
  }
});

// ── (f) non-git root and git-error paths ─────────────────────────────────

await test('(f-1) non-git projectRoot → downgrade false, no throw', () => {
  const root = makeNonGitProject();
  try {
    const ghostFile = 'test/test-176-ghost.js';
    const structured = makeStructuredTaskScopeForm({
      findings: [{ file: ghostFile, description: 'never existed' }],
      taskScopeChecks: [{ description: 'exists', status: 'FAIL', evidence: `${ghostFile} not found` }],
    });
    let res;
    assert.doesNotThrow(() => {
      res = shouldDowngradeRegressionFail({
        structured,
        pendingTargetFiles: [ghostFile],
        projectRoot: root,
        completedAffectedFiles: [],
      });
    }, 'must not throw for a non-git projectRoot');
    assert.strictEqual(res.downgrade, false, 'must not downgrade for a non-git projectRoot');
  } finally {
    cleanup(root);
  }
});

await test('(f-2) git-error projectRoot (nonexistent path) → downgrade false, no throw', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-filter-giterr-'));
  const missingRoot = path.join(parent, 'does-not-exist');
  try {
    const ghostFile = 'test/test-176-ghost.js';
    const structured = makeStructuredTaskScopeForm({
      findings: [{ file: ghostFile, description: 'never existed' }],
      taskScopeChecks: [{ description: 'exists', status: 'FAIL', evidence: `${ghostFile} not found` }],
    });
    let res;
    assert.doesNotThrow(() => {
      res = shouldDowngradeRegressionFail({
        structured,
        pendingTargetFiles: [ghostFile],
        projectRoot: missingRoot,
        completedAffectedFiles: [],
      });
    }, 'must not throw on a git error');
    assert.strictEqual(res.downgrade, false, 'must not downgrade on a git error');
  } finally {
    cleanup(parent);
  }
});

// ── (g) 177 shape: 4 FAIL checks, 2 findings, all attributed ────────────

await test('(g) 177 shape: 4 FAIL checks (hardChecks+duplicated), 2 findings, all attributed → downgrade true', () => {
  const root = makeSidecarProject();
  try {
    const ghostFile = 'test/test-177-ghost.js';
    const runTestsFile = 'scripts/run-tests.js';
    const findings = [
      { file: ghostFile, description: 'Verifier could not locate the test file for this task on the working tree.' },
      { file: runTestsFile, description: `${runTestsFile} does not register ${ghostFile} in its TEST_FILES manifest.` },
    ];
    // Same two FAIL checks appear in BOTH hardChecks and taskScopeChecks
    // (duplicated) — 4 FAIL checks total against only 2 findings. A naive
    // "check count === finding count" rule would wrongly reject this.
    const checks = [
      { name: 'file-exists', description: 'New test file exists on disk', status: 'FAIL', evidence: `${ghostFile} was not found in the working tree.` },
      { name: 'registration', description: 'Test file is registered in run-tests.js', status: 'FAIL', evidence: `${runTestsFile} does not contain a registration entry for ${ghostFile}.` },
    ];
    const structured = makeStructuredDuplicatedForm({ findings, checks });
    assert.strictEqual(
      structured.hardChecks.filter((c) => c.status === 'FAIL').length +
      structured.taskScopeChecks.filter((c) => c.status === 'FAIL').length,
      4,
      'fixture must produce exactly 4 FAIL checks'
    );
    assert.strictEqual(findings.length, 2, 'fixture must produce exactly 2 findings');

    const res = shouldDowngradeRegressionFail({
      structured,
      pendingTargetFiles: [ghostFile, runTestsFile],
      projectRoot: root,
      completedAffectedFiles: [],
    });
    assert.strictEqual(res.downgrade, true, `expected downgrade true; reason: ${res.reason}`);
    assert.deepStrictEqual(res.downgradedFindings, findings, 'downgradedFindings must deep-equal findings');
  } finally {
    cleanup(root);
  }
});

// ── Consumer-wiring harness helpers (h)/(i) ──────────────────────────────

/**
 * Build a Pipeline-shaped .harness fixture rooted in a real git repo:
 *   - milestone '001' → mission '001-001', one COMPLETE task (targetFiles
 *     ['src/foo.js']).
 *   - optionally milestone '002' → mission '001-002', one PENDING task
 *     whose targetFiles is [pendingFile] — this is what makes
 *     pendingTargetFiles non-empty for the downgrade filter's scope
 *     collector (which walks ALL missions across ALL milestones).
 *
 * Pre-creates the verification sidecars for both the mission-level
 * (`regression-001-001`) and milestone-level (`regression-ms-001`)
 * regression pseudo-tasks so recordGateOverride has somewhere to write.
 */
function createConsumerHarness({ includePendingScope, pendingFile } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-filter-consumer-'));
  const harnessDir = path.join(projectRoot, '.harness');
  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const missionId = '001-001';
  const subMissionId = `${missionId}-001`;
  const taskId = `${missionId}-001-001`;

  fs.writeFileSync(
    path.join(harnessDir, 'progress', `task-${taskId}.json`),
    JSON.stringify({
      taskId,
      status: 'COMPLETE',
      affectedFiles: [{ path: 'src/foo.js' }],
      summary: 'task completed',
      testsSummary: 'all tests passed',
    })
  );

  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-${taskId}.json`),
    JSON.stringify({
      taskId,
      verified: true,
      report: 'fake verifier report',
      result: 'PASSED',
      hardChecks: [],
      taskScopeChecks: [],
      notes: null,
    })
  );

  const srcDir = path.join(projectRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'foo.js'), '// src/foo.js\n');

  const missionState = {
    id: missionId,
    missionId,
    description: `mission ${missionId}`,
    status: 'complete',
    subMissions: {
      [subMissionId]: {
        id: subMissionId,
        description: 'sub-mission',
        status: 'complete',
        tasks: {
          [taskId]: {
            id: taskId,
            description: `task ${taskId}`,
            status: 'complete',
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            targetFiles: ['src/foo.js'],
            dependencies: [],
            testCases: [],
            tracesScenario: [],
            patternReferences: [],
            dataSchemas: [],
            verifyFile: `.harness/verify/task-${taskId}.json`,
            progressFile: `.harness/progress/task-${taskId}.json`,
            verificationFile: `.harness/verification/task-${taskId}.json`,
            retryCount: 0,
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), JSON.stringify(missionState, null, 2));

  const milestones = {
    '001': {
      id: '001',
      description: 'milestone 001',
      status: 'in_progress',
      planFile: '.harness/plan/milestone-001.md',
      missions: {
        [missionId]: {
          id: missionId,
          description: `mission ${missionId}`,
          status: 'complete',
          stateFile: `.harness/state/mission-${missionId}.json`,
          planFile: `.harness/plan/mission-${missionId}.md`,
        },
      },
    },
  };

  let pendingMissionId = null;
  if (includePendingScope) {
    // Deliberately a SEPARATE, not-yet-reached milestone so
    // assertNoNonTerminalTasks (scoped to milestone '001' only) never sees
    // this pending task.
    pendingMissionId = '001-002';
    const pendingSubMissionId = `${pendingMissionId}-001`;
    const pendingTaskId = `${pendingMissionId}-001-001`;
    const pendingMissionState = {
      id: pendingMissionId,
      missionId: pendingMissionId,
      description: `mission ${pendingMissionId}`,
      status: 'pending',
      subMissions: {
        [pendingSubMissionId]: {
          id: pendingSubMissionId,
          description: 'pending sub-mission',
          status: 'pending',
          tasks: {
            [pendingTaskId]: {
              id: pendingTaskId,
              description: `task ${pendingTaskId}`,
              status: 'pending',
              targetFiles: [pendingFile],
              dependencies: [],
              testCases: [],
              tracesScenario: [],
              patternReferences: [],
              dataSchemas: [],
              retryCount: 0,
            },
          },
        },
      },
    };
    fs.writeFileSync(path.join(harnessDir, 'state', `mission-${pendingMissionId}.json`), JSON.stringify(pendingMissionState, null, 2));

    milestones['002'] = {
      id: '002',
      description: 'milestone 002',
      status: 'pending',
      planFile: '.harness/plan/milestone-002.md',
      missions: {
        [pendingMissionId]: {
          id: pendingMissionId,
          description: `mission ${pendingMissionId}`,
          status: 'pending',
          stateFile: `.harness/state/mission-${pendingMissionId}.json`,
          planFile: `.harness/plan/mission-${pendingMissionId}.md`,
        },
      },
    };
  }

  const globalState = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones,
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  // Pre-create the gate-override sidecars so recordGateOverride (which
  // silently no-ops on a missing sidecar) has somewhere real to write.
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-regression-${missionId}.json`),
    JSON.stringify({ taskId: `regression-${missionId}` })
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-regression-ms-001.json`),
    JSON.stringify({ taskId: 'regression-ms-001' })
  );

  // Real git repo so shouldDowngradeRegressionFail's file-state checks run
  // against real object state, not a mock.
  gitInit(projectRoot);
  gitCommitAll(projectRoot, 'initial commit');

  return { projectRoot, harnessDir, missionId, milestoneId: '001', pendingMissionId };
}

function makeConsumerPipeline(projectRoot, extraOpts = {}) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    noReview: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    ...extraOpts,
  });
  return { pipeline, logs };
}

function makeQualifyingStructured(pendingFile) {
  return makeStructuredTaskScopeForm({
    findings: [{ file: pendingFile, description: 'Verifier could not locate the test file for this task on the working tree.' }],
    taskScopeChecks: [
      { description: 'New test file exists on disk', status: 'FAIL', evidence: `${pendingFile} was not found in the working tree.` },
    ],
  });
}

function makeNonQualifyingStructured() {
  return makeStructuredTaskScopeForm({
    findings: [{ file: 'src/unrelated-regression.js', description: 'Something actually broke here.' }],
    taskScopeChecks: [
      { description: 'Unrelated check', status: 'FAIL', evidence: 'src/unrelated-regression.js is broken.' },
    ],
  });
}

// ── (h) mission-regression consumer wiring ──────────────────────────────

await test('(h-1) qualifying mission-regression FAIL passes gate, writes sidecar+ledger, analyzeFailure never called', async () => {
  const pendingFile = 'test/test-h-ghost.js';
  const { projectRoot, harnessDir, missionId } = createConsumerHarness({ includePendingScope: true, pendingFile });
  try {
    const { pipeline, logs } = makeConsumerPipeline(projectRoot);
    const structured = makeQualifyingStructured(pendingFile);

    let analyzeCalls = 0;
    pipeline.verifier = {
      verifyRegression: async () => ({ verified: false, isStub: false, structured, report: JSON.stringify(structured) }),
    };
    pipeline.analyzer = {
      analyzeFailure: async () => { analyzeCalls++; return { recommendation: 'human', eventId: 'should-not-run' }; },
    };

    await pipeline._missionRegression(missionId, 'mission plan text');

    assert.strictEqual(analyzeCalls, 0, 'analyzeFailure must NEVER be called on a qualifying downgrade');
    assert.ok(
      logs.some((l) => l.includes('[regression-sequencing-override]')),
      `expected a [regression-sequencing-override] log line; got:\n${logs.join('\n')}`
    );

    const sidecarPath = path.join(harnessDir, 'verification', `task-regression-${missionId}.json`);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.ok(Array.isArray(sidecar.gateOverrides) && sidecar.gateOverrides.length === 1, 'expected exactly one gateOverrides entry');
    assert.strictEqual(sidecar.gateOverrides[0].gate, 'regression-sequencing-override');

    const ledgerPath = path.join(projectRoot, 'archives', 'warnings.jsonl');
    assert.ok(fs.existsSync(ledgerPath), 'expected archives/warnings.jsonl to be written');
    const ledgerEntries = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(
      ledgerEntries.some((e) => e.category === 'regression-sequencing-override'),
      'expected a regression-sequencing-override ledger record'
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('(h-2) non-qualifying mission-regression FAIL still calls analyzeFailure (remediation/breaker path)', async () => {
  const { projectRoot, missionId } = createConsumerHarness({ includePendingScope: false });
  try {
    const { pipeline } = makeConsumerPipeline(projectRoot);
    const structured = makeNonQualifyingStructured();

    let analyzeCalls = 0;
    pipeline.verifier = {
      verifyRegression: async () => ({ verified: false, isStub: false, structured, report: JSON.stringify(structured) }),
    };
    pipeline.analyzer = {
      analyzeFailure: async () => { analyzeCalls++; return { recommendation: 'human', eventId: 'expected-run' }; },
    };

    let thrown = null;
    try {
      await pipeline._missionRegression(missionId, 'mission plan text');
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'expected the pipeline to throw (analyzer recommends human on a non-qualifying FAIL)');
    assert.strictEqual(analyzeCalls, 1, 'analyzeFailure must be called exactly once for a non-qualifying FAIL');
  } finally {
    cleanup(projectRoot);
  }
});

// ── (i) milestone-regression consumer wiring ─────────────────────────────

await test('(i) qualifying milestone-regression FAIL skips the remediation loop (no remediateRegressionFailure call) and passes the gate', async () => {
  const pendingFile = 'test/test-i-ghost.js';
  const { projectRoot, harnessDir, milestoneId } = createConsumerHarness({ includePendingScope: true, pendingFile });
  try {
    const { pipeline, logs } = makeConsumerPipeline(projectRoot);
    const structured = makeQualifyingStructured(pendingFile);

    let analyzeCalls = 0;
    let plannerCalls = 0;
    pipeline.verifier = {
      verifyRegression: async (task) => {
        if (task.id && task.id.startsWith('regression-milestone-')) {
          return { verified: false, isStub: false, structured, report: JSON.stringify(structured) };
        }
        return { verified: true, report: 'PASSED', structured: { result: 'PASSED' } };
      },
    };
    pipeline.analyzer = {
      analyzeFailure: async () => { analyzeCalls++; return { recommendation: 'human', eventId: 'should-not-run' }; },
    };
    pipeline.planner = {
      remediateRegressionFailure: async () => { plannerCalls++; return { newTasks: [] }; },
    };
    pipeline.executor = { executeTask: async (task) => ({ status: 'COMPLETE', affectedFiles: task.targetFiles || [] }) };
    pipeline._collectMilestoneContext = () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '', specScopeFiles: [], exceededFiles: [] });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    await pipeline._executeMilestone(milestoneId, msState);

    assert.strictEqual(plannerCalls, 0, 'planner.remediateRegressionFailure must NEVER be called on a qualifying downgrade');
    assert.strictEqual(analyzeCalls, 0, 'analyzer.analyzeFailure must NEVER be called on a qualifying downgrade');
    assert.ok(
      logs.some((l) => l.includes('[regression-sequencing-override]')),
      `expected a [regression-sequencing-override] log line; got:\n${logs.join('\n')}`
    );

    const sidecarPath = path.join(harnessDir, 'verification', `task-regression-ms-${milestoneId}.json`);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.ok(Array.isArray(sidecar.gateOverrides) && sidecar.gateOverrides.length === 1, 'expected exactly one gateOverrides entry');
    assert.strictEqual(sidecar.gateOverrides[0].gate, 'regression-sequencing-override');

    // Gate passed: the milestone reached Phase 5 and transitioned to complete.
    const finalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    assert.strictEqual(finalState.milestones[milestoneId].status, 'complete', 'milestone must have completed (gate passed)');
  } finally {
    cleanup(projectRoot);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

await run();
