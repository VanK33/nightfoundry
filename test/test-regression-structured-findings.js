/**
 * test-regression-structured-findings.js — Structured findings flow from the
 * regression verifier through the milestone gate to remediation planning.
 *
 * Written black-box from the behavior spec (no reading of regression.js /
 * verifier.js / pipeline.js source). Reference data: agents/_schemas.js.
 *
 * A) SCHEMA
 *   TC-A-1: regressionVerifierSchema = verifierSchema + optional `findings`
 *           array ({file, description} required; evidence/relatedFiles
 *           optional); `required` identical to verifierSchema.required
 *           (findings NOT required).
 *
 * B) PRODUCER — verifyMilestone
 *   TC-B-1: failing verdict WITH structured findings → JSON companion
 *           .harness/verification/regression-milestone-<id>.json written with
 *           passed:false + findings deep-equal to the verifier's structured
 *           findings; return value carries findingsPath (plus
 *           reportPath/report/passed as before); markdown report format
 *           unchanged ('## Result:').
 *   TC-B-2: structured output present but NO findings field → companion still
 *           written with findings: [], nothing throws.
 *   TC-B-3: structured absent entirely → companion still written with
 *           findings: [], nothing throws.
 *
 * C) CONSUMER — pipeline regression-remediation findings extraction
 *   TC-C-1: findingsPath JSON with findings [{file:'src/x.js',
 *           description:'d'}] → planner.remediateRegressionFailure receives
 *           exactly those findings (NOT the synthetic unknown).
 *   TC-C-2: findingsPath JSON with findings: [] → falls back to a single
 *           synthetic finding with file 'unknown'.
 *   TC-C-3: findingsPath nonexistent (companion deleted before planning) +
 *           markdown report → synthetic unknown finding, as before.
 *
 * Run: node test/test-regression-structured-findings.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { verifyMilestone } from '../src/orchestrator/gates/regression.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { verifierSchema, regressionVerifierSchema } from '../src/orchestrator/agents/_schemas.js';

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

const noopLog = () => {};

// ── Part B harness helpers (mirrors test-regression-verdict-signal.js) ──────

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-structured-findings-test-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'verify'), { recursive: true });
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.mkdirSync(path.join(root, 'progress'), { recursive: true });
  return root;
}

function writeGlobalState(harnessDir, milestoneId) {
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones: {
        [milestoneId]: {
          id: milestoneId,
          description: 'fake milestone',
          status: 'in_progress',
          missions: {
            '001-001': { id: '001-001', description: 'fake mission', status: 'complete' },
          },
        },
      },
    }, null, 2)
  );
}

function createTempProject(exitCode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-findings-project-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'structured-findings-test-project',
        version: '1.0.0',
        scripts: { test: `node -e "process.exit(${exitCode})"` },
      },
      null,
      2
    )
  );
  return root;
}

/**
 * Production-shaped FAILED verdict carrying structured findings.
 */
function makeFailingVerdictWithFindings(findings) {
  const structured = {
    result: 'FAILED',
    hardChecks: [],
    taskScopeChecks: [],
    standardsChecks: [],
    notes: '',
    back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
    ...(findings !== undefined ? { findings } : {}),
  };
  return {
    verified: false,
    isStub: false,
    structured,
    report: JSON.stringify(structured, null, 2),
  };
}

// ── Part C harness helpers (mirrors test-pipeline-milestone-regression-remediation.js) ──

function createIntegrationHarness({
  milestoneId = '001',
  missionId = '001-001',
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-structured-findings-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const taskId = `${missionId}-001-001`;
  const subMissionId = `${missionId}-001`;

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

  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({
      taskId,
      targetFiles: ['src/foo.js'],
      hardChecks: [],
      testCases: [],
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

  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify(missionState, null, 2)
  );

  const globalState = {
    projectMeta: {
      prdPath: '',
      createdAt: new Date().toISOString(),
      currentPhase: 'executing',
    },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId,
        description: `milestone ${milestoneId}`,
        status: 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
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
    },
  };

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(globalState, null, 2)
  );

  return { projectRoot, harnessDir, milestoneId, missionId, taskId, subMissionId };
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function makePipeline(projectRoot, extraOpts = {}) {
  const logs = [];
  const confirmCalls = [];

  const pipeline = new Pipeline(projectRoot, {
    noReview: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async (question) => {
      confirmCalls.push(question);
      return extraOpts.confirmAnswer ?? true;
    },
    ...extraOpts,
  });

  return { pipeline, logs, confirmCalls };
}

/**
 * Stateful verifier mock: the first `failCount` calls for
 * 'regression-milestone-*' tasks return a FAILED verdict built by
 * failingVerdictFactory(); subsequent calls pass.
 */
function makeVerifierMock(failCount, failingVerdictFactory) {
  let regressionCallCount = 0;
  const verifier = {
    verifyRegression: async (task) => {
      if (task.id && task.id.startsWith('regression-milestone-')) {
        regressionCallCount++;
        if (regressionCallCount <= failCount) {
          return failingVerdictFactory();
        }
        return { verified: true, report: 'PASSED', structured: { verified: true } };
      }
      return { verified: true, report: 'PASSED', structured: { verified: true } };
    },
  };
  return { verifier, getRegressionCallCount: () => regressionCallCount };
}

function makeAnalyzerMock(recommendation = 'retry', onAnalyze = null) {
  const analyzeCalls = [];
  const analyzer = {
    analyzeFailure: async (opts, projectRoot) => {
      analyzeCalls.push({ opts, projectRoot });
      if (onAnalyze) onAnalyze(opts, projectRoot);
      return {
        eventId: 'mock-event-001',
        recommendation,
        affectedTasks: [],
      };
    },
  };
  return { analyzer, getAnalyzeCalls: () => analyzeCalls };
}

function makePlannerMock(newTasks = []) {
  const plannerCalls = [];
  const planner = {
    remediateRegressionFailure: async (milestoneId, findings, projectRoot) => {
      plannerCalls.push({ milestoneId, findings, projectRoot });
      return { newTasks };
    },
  };
  return { planner, getPlannerCalls: () => plannerCalls };
}

/**
 * Wire the standard mock set onto a pipeline for the milestone-regression
 * remediation section, and run _executeMilestone.
 */
async function runMilestoneWithMocks({ pipeline, harnessDir, milestoneId, verifier, analyzer, planner }) {
  pipeline._executeAndVerifyTask = async () => {};
  pipeline.verifier = verifier;
  pipeline.analyzer = analyzer;
  pipeline.planner = planner;
  pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
  pipeline._collectMilestoneContext = () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' });

  const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
  const msState = globalState.milestones[milestoneId];
  await pipeline._executeMilestone(milestoneId, msState);
}

// ── A) Schema pins ───────────────────────────────────────────────────────────

await test('TC-A-1: regressionVerifierSchema = verifierSchema + optional findings; required identical', () => {
  assert.ok(regressionVerifierSchema && typeof regressionVerifierSchema === 'object',
    'regressionVerifierSchema must be exported from agents/_schemas.js');

  // All of verifierSchema's properties are present (and structurally equal).
  for (const key of Object.keys(verifierSchema.properties)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(regressionVerifierSchema.properties, key),
      `regressionVerifierSchema.properties must include verifierSchema property '${key}'`
    );
    assert.deepStrictEqual(
      regressionVerifierSchema.properties[key],
      verifierSchema.properties[key],
      `property '${key}' must be identical to verifierSchema's`
    );
  }

  // Plus a findings array property.
  const findings = regressionVerifierSchema.properties.findings;
  assert.ok(findings, 'regressionVerifierSchema must define a findings property');
  assert.strictEqual(findings.type, 'array', 'findings must be an array schema');
  assert.deepStrictEqual(
    [...findings.items.required].sort(),
    ['description', 'file'],
    'findings items must require exactly {file, description}'
  );
  assert.ok(findings.items.properties.evidence,
    'findings items must allow optional evidence');
  assert.ok(findings.items.properties.relatedFiles,
    'findings items must allow optional relatedFiles');
  assert.ok(!findings.items.required.includes('evidence'), 'evidence must be optional');
  assert.ok(!findings.items.required.includes('relatedFiles'), 'relatedFiles must be optional');

  // required list is IDENTICAL to verifierSchema.required — findings NOT required.
  assert.deepStrictEqual(
    regressionVerifierSchema.required,
    verifierSchema.required,
    'regressionVerifierSchema.required must be identical to verifierSchema.required'
  );
  assert.ok(!regressionVerifierSchema.required.includes('findings'),
    'findings must NOT be in the required list');
});

// ── B) Producer — verifyMilestone ────────────────────────────────────────────

await test('TC-B-1: failing verdict with structured findings → JSON companion (passed:false, findings deep-equal), findingsPath in return, md report unchanged', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject(0);
  try {
    const milestoneId = '001';
    writeGlobalState(harnessDir, milestoneId);

    const structuredFindings = [
      { file: 'src/x.js', description: 'broke y' },
      { file: 'src/z.js', description: 'regression in z', evidence: 'test t fails', relatedFiles: ['src/w.js'] },
    ];
    const verifier = { verifyRegression: async () => makeFailingVerdictWithFindings(structuredFindings) };

    const result = await verifyMilestone({
      milestoneId,
      milestoneDesc: 'deliver feature X',
      specPath: null,
      verifier,
      projectRoot,
      harnessDir,
      onLog: noopLog,
    });

    // Return shape: passed/report/reportPath still there, plus findingsPath.
    assert.strictEqual(result.passed, false, 'passed must be false for a FAILED verdict');
    assert.ok(typeof result.report === 'string' && result.report.length > 0,
      'result.report must still be a non-empty string');
    assert.ok(typeof result.reportPath === 'string' && result.reportPath.length > 0,
      'result.reportPath must still be present');
    assert.ok(typeof result.findingsPath === 'string' && result.findingsPath.length > 0,
      'result.findingsPath must be present');

    const expectedJsonPath = path.join(harnessDir, 'verification', `regression-milestone-${milestoneId}.json`);
    assert.strictEqual(
      path.resolve(result.findingsPath),
      path.resolve(expectedJsonPath),
      `findingsPath must point at ${expectedJsonPath}, got ${result.findingsPath}`
    );

    // JSON companion written alongside the markdown report.
    assert.ok(fs.existsSync(expectedJsonPath), 'JSON companion must exist on disk');
    const companion = JSON.parse(fs.readFileSync(expectedJsonPath, 'utf8'));
    assert.strictEqual(companion.passed, false, 'companion.passed must be false');
    assert.deepStrictEqual(
      companion.findings,
      structuredFindings,
      'companion.findings must deep-equal the structured findings the verifier returned'
    );

    // Markdown report format unchanged.
    const reportPath = path.join(harnessDir, 'verification', `regression-milestone-${milestoneId}.md`);
    assert.ok(fs.existsSync(reportPath), 'markdown report must still be written');
    const reportContent = fs.readFileSync(reportPath, 'utf8');
    assert.ok(reportContent.includes('## Result:'),
      "markdown report must still contain '## Result:'");
  } finally {
    cleanup(harnessDir);
    cleanup(projectRoot);
  }
});

await test('TC-B-2: structured output without findings field → companion written with findings: [], nothing throws', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject(0);
  try {
    const milestoneId = '001';
    writeGlobalState(harnessDir, milestoneId);

    // structured present but NO findings key.
    const verifier = { verifyRegression: async () => makeFailingVerdictWithFindings(undefined) };

    const result = await verifyMilestone({
      milestoneId,
      milestoneDesc: 'deliver feature X',
      specPath: null,
      verifier,
      projectRoot,
      harnessDir,
      onLog: noopLog,
    });

    assert.strictEqual(result.passed, false, 'passed must be false');

    const expectedJsonPath = path.join(harnessDir, 'verification', `regression-milestone-${milestoneId}.json`);
    assert.ok(fs.existsSync(expectedJsonPath),
      'JSON companion must be written even when structured has no findings');
    const companion = JSON.parse(fs.readFileSync(expectedJsonPath, 'utf8'));
    assert.deepStrictEqual(companion.findings, [],
      'companion.findings must be [] when the verifier provided none');
    assert.strictEqual(companion.passed, false, 'companion.passed must be false');
  } finally {
    cleanup(harnessDir);
    cleanup(projectRoot);
  }
});

await test('TC-B-3: structured absent entirely → companion written with findings: [], nothing throws', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject(1); // npm red too — nothing green to lean on
  try {
    const milestoneId = '001';
    writeGlobalState(harnessDir, milestoneId);

    // No structured field at all.
    const verifier = {
      verifyRegression: async () => ({
        verified: false,
        isStub: false,
        report: 'plain prose failure report with no structured verdict',
      }),
    };

    const result = await verifyMilestone({
      milestoneId,
      milestoneDesc: 'deliver feature X',
      specPath: null,
      verifier,
      projectRoot,
      harnessDir,
      onLog: noopLog,
    });

    assert.strictEqual(result.passed, false, 'passed must be false');

    const expectedJsonPath = path.join(harnessDir, 'verification', `regression-milestone-${milestoneId}.json`);
    assert.ok(fs.existsSync(expectedJsonPath),
      'JSON companion must be written even when structured is absent entirely');
    const companion = JSON.parse(fs.readFileSync(expectedJsonPath, 'utf8'));
    assert.deepStrictEqual(companion.findings, [],
      'companion.findings must be [] when structured is absent');
  } finally {
    cleanup(harnessDir);
    cleanup(projectRoot);
  }
});

// ── C) Consumer — pipeline remediation findings extraction ──────────────────

await test('TC-C-1: findingsPath JSON with non-empty findings → remediateRegressionFailure receives exactly those findings', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline } = makePipeline(projectRoot);
  try {
    const structuredFindings = [{ file: 'src/x.js', description: 'd' }];
    const { verifier } = makeVerifierMock(1, () => makeFailingVerdictWithFindings(structuredFindings));
    const { analyzer } = makeAnalyzerMock('retry');
    const { planner, getPlannerCalls } = makePlannerMock([]);

    await runMilestoneWithMocks({ pipeline, harnessDir, milestoneId, verifier, analyzer, planner });

    const plannerCalls = getPlannerCalls();
    assert.strictEqual(plannerCalls.length, 1,
      `Expected exactly 1 remediateRegressionFailure call; got ${plannerCalls.length}`);

    const received = plannerCalls[0].findings;
    assert.deepStrictEqual(
      received,
      structuredFindings,
      `remediation must receive exactly the structured findings; got ${JSON.stringify(received)}`
    );
    assert.notStrictEqual(received[0].file, 'unknown',
      'must NOT be the synthetic unknown finding when structured findings exist');
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC-C-2: findingsPath JSON with findings: [] → falls back to single synthetic unknown finding', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline } = makePipeline(projectRoot);
  try {
    // Verifier fails with structured findings: [] → companion has empty array.
    const { verifier } = makeVerifierMock(1, () => makeFailingVerdictWithFindings([]));
    const { analyzer } = makeAnalyzerMock('retry');
    const { planner, getPlannerCalls } = makePlannerMock([]);

    await runMilestoneWithMocks({ pipeline, harnessDir, milestoneId, verifier, analyzer, planner });

    const plannerCalls = getPlannerCalls();
    assert.strictEqual(plannerCalls.length, 1,
      `Expected exactly 1 remediateRegressionFailure call; got ${plannerCalls.length}`);

    const received = plannerCalls[0].findings;
    assert.strictEqual(received.length, 1,
      `synthetic fallback must be a single finding; got ${received.length}`);
    assert.strictEqual(received[0].file, 'unknown',
      `synthetic finding must have file 'unknown'; got '${received[0].file}'`);
    assert.ok(typeof received[0].description === 'string' && received[0].description.length > 0,
      'synthetic finding description must be a non-empty string');
    assert.ok(received[0].description.length <= 2000,
      `synthetic finding description must be capped at 2000 chars; got ${received[0].description.length}`);
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC-C-3: nonexistent findingsPath + markdown report → synthetic unknown finding, as before', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const { pipeline } = makePipeline(projectRoot);
  try {
    // Verifier fails WITH real structured findings — but we delete the JSON
    // companion inside the analyzer mock (which runs after the regression
    // verify and before remediation planning). If extraction were reading
    // in-memory findings instead of the findingsPath file, this test would
    // catch it: remediation must fall back to the synthetic unknown finding
    // because the file is gone and the markdown report is not JSON.
    const structuredFindings = [{ file: 'src/real.js', description: 'a real finding that must NOT surface' }];
    const { verifier } = makeVerifierMock(1, () => makeFailingVerdictWithFindings(structuredFindings));

    const companionPath = path.join(harnessDir, 'verification', `regression-milestone-${milestoneId}.json`);
    const { analyzer } = makeAnalyzerMock('retry', () => {
      fs.rmSync(companionPath, { force: true });
    });
    // Wrap the planner mock to record whether the companion file existed at
    // the exact moment remediation planning was invoked (the re-verify after
    // remediation legitimately re-writes it, so checking after the run is too late).
    const { planner, getPlannerCalls } = makePlannerMock([]);
    const companionExistedAtPlanTime = [];
    const innerRemediate = planner.remediateRegressionFailure;
    planner.remediateRegressionFailure = async (...args) => {
      companionExistedAtPlanTime.push(fs.existsSync(companionPath));
      return innerRemediate(...args);
    };

    await runMilestoneWithMocks({ pipeline, harnessDir, milestoneId, verifier, analyzer, planner });

    // Sanity: the companion really was gone when planning ran.
    assert.deepStrictEqual(companionExistedAtPlanTime, [false],
      'fixture self-check: companion must have been deleted before planning ran');

    const plannerCalls = getPlannerCalls();
    assert.strictEqual(plannerCalls.length, 1,
      `Expected exactly 1 remediateRegressionFailure call; got ${plannerCalls.length}`);

    const received = plannerCalls[0].findings;
    assert.strictEqual(received.length, 1,
      `synthetic fallback must be a single finding; got ${received.length}: ${JSON.stringify(received)}`);
    assert.strictEqual(received[0].file, 'unknown',
      `synthetic finding must have file 'unknown'; got '${received[0].file}'`);
    assert.ok(typeof received[0].description === 'string' && received[0].description.length > 0,
      'synthetic finding description must be a non-empty string');
    assert.ok(received[0].description.length <= 2000,
      `synthetic finding description must be capped at 2000 chars; got ${received[0].description.length}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
