/**
 * test-regression-softpass.js — Soft-pass logic regression tests.
 *
 * Covers the soft-pass path introduced in regression.js:
 * When result.verified===false but npm test exits 0 AND the verifier's text/
 * structured output signals PASSED, the mission/milestone is accepted as a
 * "soft-pass" (verifier disagreement).
 *
 * TC-SP-1: verifyMission with result.verified===true → passed=true, softPass absent/false
 * TC-SP-2: verifyMission verified===false + npm exit 0 + structured.result='PASSED'
 *          → passed=true, softPass=true
 * TC-SP-3: verifyMission verified===false + npm exit 0 + no text signal → passed=false
 * TC-SP-4: verifyMission verified===false + npm exit 1 → passed=false
 * TC-SP-5: verifyMilestone soft-pass report contains
 *          '## Result: PASSED (soft-pass, verifier disagreement)'
 * TC-SP-6: structuredVerdictPassed(result) returns true when result.structured.result==='PASSED'
 * TC-SP-7: structuredVerdictPassed(result) returns false when result.structured.result==='FAILED'
 * TC-SP-8: runTestCommand returns { exitCode: 0 } in a directory with passing npm test
 *          (integration, skipped if no package.json in project root)
 *
 * Run: node test/test-regression-softpass.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { verifyMission, verifyMilestone, runTestCommand, structuredVerdictPassed } from '../src/orchestrator/gates/regression.js';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-softpass-test-'));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'softpass-project-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'softpass-test-project',
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

// ── Tests ────────────────────────────────────────────────────────────────────

await test('TC-SP-1: verifyMission verified===true → passed=true, softPass absent/false', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject(0);
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);

    const verifier = {
      verifyRegression: async () => ({ verified: true, report: 'all good' }),
    };

    const result = await verifyMission({
      missionId,
      missionPlan: 'plan',
      verifier,
      projectRoot,
      harnessDir,
      onLog: noopLog,
    });

    assert.strictEqual(result.passed, true, 'passed must be true when verified=true');
    assert.ok(!result.softPass, 'softPass must be absent or false when verified=true');
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test('TC-SP-2: verifyMission verified===false + npm exit 0 + structured.result=PASSED → passed=true, softPass=true', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject(0);
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);

    // Stub verifier: verified=false but structured output says PASSED
    const verifier = {
      verifyRegression: async () => ({
        verified: false,
        report: 'PASSED',
        structured: { result: 'PASSED' },
      }),
    };

    const result = await verifyMission({
      missionId,
      missionPlan: 'plan',
      verifier,
      projectRoot,
      harnessDir,
      onLog: noopLog,
    });

    assert.strictEqual(result.passed, true, 'passed must be true for soft-pass');
    assert.strictEqual(result.softPass, true, 'softPass must be true');
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test('TC-SP-3: verifyMission verified===false + npm exit 0 + no text signal → passed=false', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject(0);
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);

    // Stub verifier: verified=false and no PASSED signal in report or structured
    const verifier = {
      verifyRegression: async () => ({
        verified: false,
        report: 'issues found, nothing matches',
        structured: { result: 'FAILED' },
      }),
    };

    const result = await verifyMission({
      missionId,
      missionPlan: 'plan',
      verifier,
      projectRoot,
      harnessDir,
      onLog: noopLog,
    });

    assert.strictEqual(result.passed, false, 'passed must be false when text signal absent');
    assert.ok(!result.softPass, 'softPass must be falsy');
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test('TC-SP-4: verifyMission verified===false + npm exit 1 → passed=false', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject(1); // npm test will exit 1
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);

    // Stub verifier: verified=false but text/structured says PASSED — npm exit beats it
    const verifier = {
      verifyRegression: async () => ({
        verified: false,
        report: 'PASSED',
        structured: { result: 'PASSED' },
      }),
    };

    const result = await verifyMission({
      missionId,
      missionPlan: 'plan',
      verifier,
      projectRoot,
      harnessDir,
      onLog: noopLog,
    });

    assert.strictEqual(result.passed, false, 'passed must be false when npm test exits non-zero');
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test("TC-SP-5: verifyMilestone soft-pass report contains '## Result: PASSED (soft-pass, verifier disagreement)'", async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject(0);
  try {
    const milestoneId = '001';
    writeGlobalState(harnessDir, milestoneId);

    const verifier = {
      verifyRegression: async () => ({
        verified: false,
        report: 'PASSED',
        structured: { result: 'PASSED' },
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

    assert.ok(
      result.report.includes('## Result: PASSED (soft-pass, verifier disagreement)'),
      'report must contain soft-pass result header'
    );
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test('TC-SP-6: structuredVerdictPassed returns true when result.structured.result===PASSED', () => {
  const result = { structured: { result: 'PASSED' }, report: '' };
  assert.strictEqual(structuredVerdictPassed(result), true, 'structuredVerdictPassed must return true for structured PASSED');
});

await test("TC-SP-7: structuredVerdictPassed returns false when result.structured.result==='FAILED'", () => {
  const result = { structured: { result: 'FAILED' }, report: 'there were errors and nothing worked' };
  assert.strictEqual(structuredVerdictPassed(result), false, 'structuredVerdictPassed must return false when structured verdict is not PASSED');
});

await test('TC-SP-8: runTestCommand returns { exitCode: 0 } in a directory with passing npm test (integration)', async () => {
  // Skip if the current project root has no package.json (CI safety)
  const projectRoot = createTempProject(0);
  try {
    const r = runTestCommand(projectRoot);
    assert.strictEqual(r.exitCode, 0, 'exitCode must be 0 for passing npm test');
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'exitCode'), 'result must have exitCode property');
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'output'), 'result must have output property');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
