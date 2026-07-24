/**
 * test-regression-stub.js — Defect #13 fix verification.
 *
 * verifyMission and verifyMilestone synthesize ad-hoc tasks (regression-{id})
 * that bypass the executor's verify.json write at writeVerifyJson(). The
 * verifier prompt instructs the model to "Read the verify.json file" — when
 * the file is missing the model manufactures a 'file exists' hardCheck and
 * returns FAILED, regardless of whether the actual functional check passed.
 *
 * Fix: regression.js writes a uniform-shape verify.json stub via
 * writeVerifyJson() before calling verifier.verifyTask, so the file is
 * present and empty (hardChecks=[], testCases=[]) — verifier prompt rule
 * "result PASSED only if every hardCheck passes" is then vacuously satisfied.
 *
 * TC-RS-1: verifyMission writes stub at .harness/verify/task-regression-{missionId}.json
 * TC-RS-2: stub shape matches writeVerifyJson contract
 *          (taskId, targetFiles=[], hardChecks=[], testCases=[])
 * TC-RS-3: verifyMilestone writes stub at task-regression-milestone-{milestoneId}.json
 * TC-RS-4: file exists at the same path verifier.js computes (parity check)
 *
 * Run: node test/test-regression-stub.js
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

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-stub-test-'));
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

// Stub verifier: returns verified: true without spawning real session.
const stubVerifier = {
  verifyRegression: async () => ({ verified: true, report: 'stub' }),
};

const noopLog = () => {};

// ── Tests ────────────────────────────────────────────────────────────────────

await test('TC-RS-1: verifyMission writes stub at .harness/verify/task-regression-{missionId}.json', async () => {
  const harnessDir = createHarness();
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);

    await verifyMission({
      missionId,
      missionPlan: 'fake plan',
      verifier: stubVerifier,
      projectRoot: harnessDir,
      harnessDir,
      onLog: noopLog,
    });

    const stubPath = path.join(harnessDir, 'verify', `task-regression-${missionId}.json`);
    assert.ok(fs.existsSync(stubPath), `stub must exist at ${stubPath}`);
  } finally { cleanup(harnessDir); }
});

await test('TC-RS-2: stub shape matches writeVerifyJson contract (taskId, targetFiles=[], hardChecks=[], testCases=[])', async () => {
  const harnessDir = createHarness();
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);

    await verifyMission({
      missionId,
      missionPlan: 'fake plan',
      verifier: stubVerifier,
      projectRoot: harnessDir,
      harnessDir,
      onLog: noopLog,
    });

    const stubPath = path.join(harnessDir, 'verify', `task-regression-${missionId}.json`);
    const stub = JSON.parse(fs.readFileSync(stubPath, 'utf8'));
    assert.strictEqual(stub.taskId, `regression-${missionId}`, 'taskId field');
    assert.deepStrictEqual(stub.targetFiles, [], 'targetFiles must be empty array');
    assert.deepStrictEqual(stub.hardChecks, [], 'hardChecks must be empty array');
    assert.deepStrictEqual(stub.testCases, [], 'testCases must be empty array');
  } finally { cleanup(harnessDir); }
});

await test('TC-RS-3: verifyMilestone writes stub at .harness/verify/task-regression-milestone-{milestoneId}.json', async () => {
  const harnessDir = createHarness();
  try {
    const milestoneId = '001';
    writeGlobalState(harnessDir, milestoneId);

    await verifyMilestone({
      milestoneId,
      milestoneDesc: 'fake milestone desc',
      specPath: null,
      verifier: stubVerifier,
      projectRoot: harnessDir,
      harnessDir,
      onLog: noopLog,
    });

    const stubPath = path.join(harnessDir, 'verify', `task-regression-milestone-${milestoneId}.json`);
    assert.ok(fs.existsSync(stubPath), `stub must exist at ${stubPath}`);

    const stub = JSON.parse(fs.readFileSync(stubPath, 'utf8'));
    assert.strictEqual(stub.taskId, `regression-milestone-${milestoneId}`);
    assert.deepStrictEqual(stub.hardChecks, []);
    assert.deepStrictEqual(stub.testCases, []);
  } finally { cleanup(harnessDir); }
});

await test('TC-RS-4: stub path matches verifier.js verifyJsonPath computation (parity check)', async () => {
  // verifier.js:104 computes:
  //   path.join(harnessDir, 'verify', `task-${task.id}.json`)
  // For task.id = 'regression-001-001', that's task-regression-001-001.json.
  // This test guards against drift if either side changes the path scheme.
  const harnessDir = createHarness();
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);

    await verifyMission({
      missionId,
      missionPlan: 'fake plan',
      verifier: stubVerifier,
      projectRoot: harnessDir,
      harnessDir,
      onLog: noopLog,
    });

    const expected = path.join(harnessDir, 'verify', `task-regression-${missionId}.json`);
    const stub = JSON.parse(fs.readFileSync(expected, 'utf8'));
    assert.strictEqual(`task-${stub.taskId}.json`, path.basename(expected),
      'stub filename must equal task-{stub.taskId}.json — parity with verifier.js:104');
  } finally { cleanup(harnessDir); }
});

// ── isStub propagation tests (001-002-001-001) ────────────────────────────────

await test('TC-STUB-1: verifyMission returns isStub: false when result.isStub is undefined', async () => {
  const harnessDir = createHarness();
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);
    const verifier = { verifyRegression: async () => ({ verified: true, report: 'ok' }) };
    const result = await verifyMission({
      missionId, missionPlan: 'plan', verifier,
      projectRoot: harnessDir, harnessDir, onLog: noopLog,
    });
    assert.strictEqual(result.isStub, false, 'isStub must be false when not set');
  } finally { cleanup(harnessDir); }
});

await test('TC-STUB-2: verifyMission returns isStub: true when result.isStub is true', async () => {
  const harnessDir = createHarness();
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);
    const verifier = { verifyRegression: async () => ({ verified: true, report: 'ok', isStub: true }) };
    const result = await verifyMission({
      missionId, missionPlan: 'plan', verifier,
      projectRoot: harnessDir, harnessDir, onLog: noopLog,
    });
    assert.strictEqual(result.isStub, true, 'isStub must be true when verifier sets it');
  } finally { cleanup(harnessDir); }
});

await test('TC-STUB-3: verifyMilestone returns isStub: false when result.isStub is undefined', async () => {
  const harnessDir = createHarness();
  try {
    const milestoneId = '001';
    writeGlobalState(harnessDir, milestoneId);
    const verifier = { verifyRegression: async () => ({ verified: true, report: 'ok' }) };
    const result = await verifyMilestone({
      milestoneId, milestoneDesc: 'desc', specPath: null, verifier,
      projectRoot: harnessDir, harnessDir, onLog: noopLog,
    });
    assert.strictEqual(result.isStub, false, 'isStub must be false when not set');
  } finally { cleanup(harnessDir); }
});

await test('TC-STUB-4: verifyMilestone returns isStub: true when result.isStub is true', async () => {
  const harnessDir = createHarness();
  try {
    const milestoneId = '001';
    writeGlobalState(harnessDir, milestoneId);
    const verifier = { verifyRegression: async () => ({ verified: true, report: 'ok', isStub: true }) };
    const result = await verifyMilestone({
      milestoneId, milestoneDesc: 'desc', specPath: null, verifier,
      projectRoot: harnessDir, harnessDir, onLog: noopLog,
    });
    assert.strictEqual(result.isStub, true, 'isStub must be true when verifier sets it');
  } finally { cleanup(harnessDir); }
});

await test('TC-STUB-5: verifyMilestone report includes stub banner when result.isStub is true', async () => {
  const harnessDir = createHarness();
  try {
    const milestoneId = '001';
    writeGlobalState(harnessDir, milestoneId);
    const verifier = { verifyRegression: async () => ({ verified: true, report: 'ok', isStub: true }) };
    const result = await verifyMilestone({
      milestoneId, milestoneDesc: 'desc', specPath: null, verifier,
      projectRoot: harnessDir, harnessDir, onLog: noopLog,
    });
    assert.ok(
      result.report.startsWith('⚠️ STUB VERDICT — verifier timed out or returned no structured_output'),
      'report must start with stub banner when isStub=true'
    );
  } finally { cleanup(harnessDir); }
});

await test('TC-STUB-6: verifyMilestone report does NOT include stub banner when result.isStub is falsy', async () => {
  const harnessDir = createHarness();
  try {
    const milestoneId = '001';
    writeGlobalState(harnessDir, milestoneId);
    const verifier = { verifyRegression: async () => ({ verified: true, report: 'ok' }) };
    const result = await verifyMilestone({
      milestoneId, milestoneDesc: 'desc', specPath: null, verifier,
      projectRoot: harnessDir, harnessDir, onLog: noopLog,
    });
    assert.ok(
      !result.report.includes('⚠️ STUB VERDICT'),
      'report must NOT include stub banner when isStub is falsy'
    );
  } finally { cleanup(harnessDir); }
});

// ── soft-pass tests ──────────────────────────────────────────────────────────

function createTempProject(testScript) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soft-pass-project-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      { name: 'soft-pass-test', version: '1.0.0', scripts: { test: testScript } },
      null, 2
    )
  );
  return root;
}

await test('TC-SP-1: verifyMission verified:false + npm-exit-0 + text-PASS → passed:true, softPass:true', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject('node -e "process.exit(0)"');
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);
    const verifier = {
      verifyRegression: async () => ({
        verified: false,
        report: 'PASSED',
        structured: { result: 'PASSED' },
      }),
    };
    const result = await verifyMission({
      missionId, missionPlan: 'plan', verifier,
      projectRoot, harnessDir, onLog: noopLog,
    });
    assert.strictEqual(result.passed, true, 'passed must be true for soft-pass');
    assert.strictEqual(result.softPass, true, 'softPass must be true');
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test('TC-SP-2: verifyMission verified:false + npm-exit-0 + text-PASS → onLog includes [verifier-disagreement]', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject('node -e "process.exit(0)"');
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);
    const verifier = {
      verifyRegression: async () => ({
        verified: false,
        report: 'PASSED',
        structured: { result: 'PASSED' },
      }),
    };
    const logs = [];
    await verifyMission({
      missionId, missionPlan: 'plan', verifier,
      projectRoot, harnessDir, onLog: (msg) => logs.push(msg),
    });
    assert.ok(
      logs.some((l) => l.includes('[verifier-disagreement]')),
      'onLog must include at least one [verifier-disagreement] entry'
    );
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test('TC-SP-3: verifyMission verified:false + npm-exit-0 + text-FAIL → passed:false', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject('node -e "process.exit(0)"');
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);
    const verifier = {
      verifyRegression: async () => ({
        verified: false,
        report: 'issues found',
        structured: { result: 'FAILED' },
      }),
    };
    const result = await verifyMission({
      missionId, missionPlan: 'plan', verifier,
      projectRoot, harnessDir, onLog: noopLog,
    });
    assert.strictEqual(result.passed, false, 'passed must be false when text signal is FAIL');
    assert.ok(!result.softPass, 'softPass must be falsy');
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test('TC-SP-4: verifyMission verified:false + npm-exit-nonzero → passed:false', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject('node -e "process.exit(1)"');
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);
    const verifier = {
      verifyRegression: async () => ({
        verified: false,
        report: 'PASSED',
        structured: { result: 'PASSED' },
      }),
    };
    const result = await verifyMission({
      missionId, missionPlan: 'plan', verifier,
      projectRoot, harnessDir, onLog: noopLog,
    });
    assert.strictEqual(result.passed, false, 'passed must be false when npm test exits nonzero');
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test('TC-SP-5: verifyMission verified:missing (undefined) → treated same as verified:false, soft-pass applies', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject('node -e "process.exit(0)"');
  try {
    const missionId = '001-001';
    writeMissionState(harnessDir, missionId);
    const verifier = {
      verifyRegression: async () => ({
        // no `verified` key
        report: 'PASSED',
        structured: { result: 'PASSED' },
      }),
    };
    const result = await verifyMission({
      missionId, missionPlan: 'plan', verifier,
      projectRoot, harnessDir, onLog: noopLog,
    });
    assert.strictEqual(result.passed, true, 'passed must be true for soft-pass when verified is missing');
    assert.strictEqual(result.softPass, true, 'softPass must be true when verified is missing');
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test('TC-SP-6: verifyMilestone soft-pass report header', async () => {
  const harnessDir = createHarness();
  const projectRoot = createTempProject('node -e "process.exit(0)"');
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
    await verifyMilestone({
      milestoneId, milestoneDesc: 'desc', specPath: null, verifier,
      projectRoot, harnessDir, onLog: noopLog,
    });
    const reportPath = path.join(harnessDir, 'verification', `regression-milestone-${milestoneId}.md`);
    const reportContent = fs.readFileSync(reportPath, 'utf8');
    assert.ok(
      reportContent.includes('## Result: PASSED (soft-pass, verifier disagreement)'),
      'report must contain soft-pass result header'
    );
  } finally {
    cleanup(harnessDir);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
