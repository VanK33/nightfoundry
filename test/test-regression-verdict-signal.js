/**
 * test-regression-verdict-signal.js — Regression soft-pass signal keys on the
 * structured verdict field, not a 'PASSED' substring scan of result.report.
 *
 * Contract (spec: regression-verdict-signal.spec.md):
 * `structuredVerdictPassed(result)` returns `result?.structured?.result === 'PASSED'`
 * and nothing else — no substring scanning of result.report. report is ALWAYS
 * the pretty-printed JSON of the verdict, so a FAILED verdict whose evidence/
 * notes merely mention 'PASSED' must NOT flip the soft-pass signal (the
 * false-green this spec kills, at both the mission and milestone gates).
 *
 * TC-VS-1: false-green killed at mission gate — FAILED verdict whose
 *          pretty-printed JSON report contains 'PASSED' in evidence/notes +
 *          green npm test → passed=false, softPass falsy
 * TC-VS-2: same verdict through verifyMilestone → passed=false, softPass
 *          falsy; written report contains '## Result: FAILED'
 * TC-VS-3: legitimate disagreement still soft-passes at mission gate —
 *          verified=false + structured.result='PASSED' + green npm test →
 *          passed=true, softPass=true
 * TC-VS-4: same through verifyMilestone → passed=true, softPass=true; report
 *          header '## Result: PASSED (soft-pass, verifier disagreement)'
 * TC-VS-5: structuredVerdictPassed unit edges — structured PASSED → true;
 *          structured FAILED with report 'PASSED PASSED PASSED' → false;
 *          structured absent ({ report: 'PASSED' }) → false; null/undefined → false
 * TC-VS-6: npm red blocks even a PASSED structured verdict → passed=false
 *
 * Run: node test/test-regression-verdict-signal.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { verifyMission, verifyMilestone, structuredVerdictPassed } from '../src/orchestrator/gates/regression.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failCount++;
    }
  );
}

// ── Harness helpers ──────────────────────────────────────────────────────────

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-verdict-signal-test-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'verify'), { recursive: true });
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.mkdirSync(path.join(root, 'progress'), { recursive: true });
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeMissionState(harnessDir, missionId, status = 'complete') {
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify({
      missionId,
      status,
      subMissions: {
        [`${missionId}-001`]: {
          id: `${missionId}-001`,
          tasks: {
            [`${missionId}-001-001`]: {
              id: `${missionId}-001-001`,
              status: 'complete',
              description: 'fake task',
            },
          },
        },
      },
    }, null, 2)
  );
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

/**
 * Creates a temp npm project whose `npm test` exits with the given code.
 */
function createTempProject(exitCode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-signal-project-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'verdict-signal-test-project',
        version: '1.0.0',
        scripts: { test: `node -e "process.exit(${exitCode})"` },
      },
      null,
      2
    )
  );
  return root;
}

const noopLog = () => {};

/**
 * Production-shaped FAILED verdict whose pretty-printed JSON report contains
 * the substring 'PASSED' multiple times (in evidence and notes) — exactly how
 * production builds report: JSON.stringify(structured, null, 2).
 */
function makeFalseGreenVerdict() {
  const structured = {
    result: 'FAILED',
    hardChecks: [{ name: 'check', status: 'FAIL', evidence: 'expected PASSED, got FAILED' }],
    taskScopeChecks: [],
    notes: 'verifier expected PASSED but the run FAILED',
  };
  return {
    verified: false,
    structured,
    report: JSON.stringify(structured, null, 2),
  };
}

/**
 * Legitimate disagreement verdict: verified=false but structured PASSED.
 */
function makeDisagreementVerdict() {
  const structured = { result: 'PASSED', hardChecks: [], taskScopeChecks: [] };
  return {
    verified: false,
    structured,
    report: JSON.stringify(structured, null, 2),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

await test('TC-VS-1: mission gate — FAILED verdict with PASSED-containing JSON report + green npm test → passed=false, softPass falsy', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject(0);
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);

    const verdict = makeFalseGreenVerdict();
    // Sanity: the report really does contain 'PASSED' multiple times.
    assert.ok((verdict.report.match(/PASSED/g) || []).length >= 2,
      'fixture self-check: report must contain PASSED multiple times');

    const verifier = { verifyRegression: async () => verdict };

    const result = await verifyMission({
      missionId,
      missionPlan: 'plan',
      verifier,
      projectRoot,
      harnessDir,
      onLog: noopLog,
    });

    assert.strictEqual(result.passed, false,
      'passed must be false — a FAILED structured verdict whose report mentions PASSED must not soft-pass');
    assert.ok(!result.softPass, 'softPass must be falsy');
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test("TC-VS-2: milestone gate — same FAILED verdict → passed=false, softPass falsy, report '## Result: FAILED'", async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject(0);
  try {
    const milestoneId = '001';
    writeGlobalState(harnessDir, milestoneId);

    const verifier = { verifyRegression: async () => makeFalseGreenVerdict() };

    const result = await verifyMilestone({
      milestoneId,
      milestoneDesc: 'deliver feature X',
      specPath: null,
      verifier,
      projectRoot,
      harnessDir,
      onLog: noopLog,
    });

    assert.strictEqual(result.passed, false,
      'passed must be false — false-green soft-pass must be dead at the milestone gate too');
    assert.ok(!result.softPass, 'softPass must be falsy');

    const reportPath = path.join(harnessDir, 'verification', `regression-milestone-${milestoneId}.md`);
    const reportContent = fs.readFileSync(reportPath, 'utf8');
    assert.ok(reportContent.includes('## Result: FAILED'),
      "written report must contain '## Result: FAILED'");
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test('TC-VS-3: mission gate — legitimate disagreement (structured PASSED, verified=false, green npm test) → passed=true, softPass=true', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject(0);
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);

    const verifier = { verifyRegression: async () => makeDisagreementVerdict() };

    const result = await verifyMission({
      missionId,
      missionPlan: 'plan',
      verifier,
      projectRoot,
      harnessDir,
      onLog: noopLog,
    });

    assert.strictEqual(result.passed, true, 'passed must be true for legitimate disagreement soft-pass');
    assert.strictEqual(result.softPass, true, 'softPass must be true');
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test("TC-VS-4: milestone gate — legitimate disagreement → passed=true, softPass=true, report '## Result: PASSED (soft-pass, verifier disagreement)'", async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject(0);
  try {
    const milestoneId = '001';
    writeGlobalState(harnessDir, milestoneId);

    const verifier = { verifyRegression: async () => makeDisagreementVerdict() };

    const result = await verifyMilestone({
      milestoneId,
      milestoneDesc: 'deliver feature X',
      specPath: null,
      verifier,
      projectRoot,
      harnessDir,
      onLog: noopLog,
    });

    assert.strictEqual(result.passed, true, 'passed must be true for legitimate disagreement soft-pass');
    assert.strictEqual(result.softPass, true, 'softPass must be true');

    const reportPath = path.join(harnessDir, 'verification', `regression-milestone-${milestoneId}.md`);
    const reportContent = fs.readFileSync(reportPath, 'utf8');
    assert.ok(reportContent.includes('## Result: PASSED (soft-pass, verifier disagreement)'),
      'written report must contain the soft-pass result header');
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test('TC-VS-5: structuredVerdictPassed unit edges', () => {
  assert.strictEqual(typeof structuredVerdictPassed, 'function',
    'structuredVerdictPassed must be exported from gates/regression.js');

  assert.strictEqual(
    structuredVerdictPassed({ structured: { result: 'PASSED' }, report: '' }),
    true,
    'structured PASSED → true'
  );
  assert.strictEqual(
    structuredVerdictPassed({ structured: { result: 'FAILED' }, report: 'PASSED PASSED PASSED' }),
    false,
    "structured FAILED must be false even when report is full of 'PASSED' substrings"
  );
  assert.strictEqual(
    structuredVerdictPassed({ report: 'PASSED' }),
    false,
    'structured absent → false (no substring fallback on report)'
  );
  assert.strictEqual(structuredVerdictPassed(null), false, 'null → false');
  assert.strictEqual(structuredVerdictPassed(undefined), false, 'undefined → false');
});

await test('TC-VS-6: mission gate — npm test red blocks even a PASSED structured verdict → passed=false', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject(1); // npm test exits 1
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);

    const verifier = { verifyRegression: async () => makeDisagreementVerdict() };

    const result = await verifyMission({
      missionId,
      missionPlan: 'plan',
      verifier,
      projectRoot,
      harnessDir,
      onLog: noopLog,
    });

    assert.strictEqual(result.passed, false,
      'passed must be false when npm test exits non-zero, regardless of structured PASSED');
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
