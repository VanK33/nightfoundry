/**
 * test-gate-external-project.js — Black-box tests for the test-registration
 * gate's external-project (no-manifest) behavior and the pipeline's
 * gate-override sidecar recording.
 *
 * Written from the behavior spec WITHOUT reading the implementation source.
 *
 * A) checkTestRegistration:
 *    A1: project WITHOUT scripts/run-tests.js → not-applicable pass
 *        ({ passed:true, violations:[], notApplicable:true }) even with an
 *        obviously unregistered test/test-*.js candidate.
 *    A2a: manifest EXISTS but has a syntax error → fail-closed (passed:false,
 *         unregistered candidate in violations, no notApplicable:true).
 *    A2b: manifest EXISTS but exports no TEST_FILES → same fail-closed.
 *    A3: normal path unchanged — registered candidate passes, unlisted
 *        candidate (no annotation) is a violation.
 *
 * B) Pipeline._recordGateOverride (driven via Pipeline.prototype with a
 *    duck-typed `this`, same approach as test-scope-coverage-gate.js):
 *    B1: valid sidecar → appends gateOverrides entry { gate, evidence, at:ISO },
 *        preserving existing fields.
 *    B2: two calls append two entries in order.
 *    B3a: sidecar absent → does not throw.
 *    B3b: sidecar invalid JSON → does not throw.
 *
 * C) Pipeline wrapper — full _executeAndVerifyTask drive (mirrors
 *    test-test-registration-pipeline.js #5a) on a project WITHOUT
 *    scripts/run-tests.js: task must NOT be failed by the gate, and an onLog
 *    line mentioning "not applicable" (case-insensitive) is emitted.
 *
 * Run: node test/test-gate-external-project.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeMissionState } from '../src/orchestrator/core/state.js';
import config from '../src/orchestrator/infra/config.js';

const { checkTestRegistration } = await import('../src/orchestrator/gates/test-registration.js');

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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (mirroring test-test-registration-gate.js fixture style)
// ─────────────────────────────────────────────────────────────────────────────

/** mkdtemp project root; optionally write scripts/run-tests.js with raw content. */
function makeRoot(manifestContent /* string | null */) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ext-proj-'));
  if (manifestContent !== null) {
    const scriptsDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'run-tests.js'), manifestContent, 'utf8');
  }
  return {
    projectRoot: tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function writeTestFile(dir, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

// ─────────────────────────────────────────────────────────────────────────────
// A1: no scripts/run-tests.js at all → not-applicable pass
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'A1: project without scripts/run-tests.js → passed:true, violations:[], notApplicable:true',
  async () => {
    const { projectRoot, cleanup } = makeRoot(null); // NO scripts/ dir

    try {
      // Obviously "unregistered" test file — but there is no manifest to be in.
      writeTestFile(projectRoot, 'test/test-foo.js', '// no annotation\n');

      const candidates = [path.join(projectRoot, 'test', 'test-foo.js')];
      const result = await checkTestRegistration(candidates, null, projectRoot);

      assert.strictEqual(result.passed, true,
        `Expected passed:true (not applicable) but got passed:${result.passed}, violations:${JSON.stringify(result.violations)}`);
      assert.deepStrictEqual(result.violations, [],
        `Expected violations:[] but got: ${JSON.stringify(result.violations)}`);
      assert.strictEqual(result.notApplicable, true,
        `Expected notApplicable:true but got: ${JSON.stringify(result.notApplicable)}`);
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// A2a: manifest exists but is broken (syntax error) → fail-closed
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'A2a: broken manifest (syntax error) + unregistered candidate → passed:false, in violations, not notApplicable',
  async () => {
    const { projectRoot, cleanup } = makeRoot('export const TEST_FILES = [ this is not javascript ;;;\n');

    try {
      writeTestFile(projectRoot, 'test/test-broken-manifest.js', '// no annotation\n');

      const candidates = [path.join(projectRoot, 'test', 'test-broken-manifest.js')];
      const result = await checkTestRegistration(candidates, null, projectRoot);

      assert.strictEqual(result.passed, false,
        `Broken manifest must fail closed; got passed:${result.passed}`);
      assert.ok(
        result.violations.some((v) => v.includes('test-broken-manifest.js')),
        `Expected 'test-broken-manifest.js' in violations, got: ${JSON.stringify(result.violations)}`,
      );
      assert.notStrictEqual(result.notApplicable, true,
        'Fail-closed result must NOT carry notApplicable:true');
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// A2b: manifest exists but exports no TEST_FILES → fail-closed
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'A2b: manifest without TEST_FILES export + unregistered candidate → passed:false, in violations, not notApplicable',
  async () => {
    const { projectRoot, cleanup } = makeRoot('export const SOMETHING_ELSE = 42;\n');

    try {
      writeTestFile(projectRoot, 'test/test-no-export.js', '// no annotation\n');

      const candidates = [path.join(projectRoot, 'test', 'test-no-export.js')];
      const result = await checkTestRegistration(candidates, null, projectRoot);

      assert.strictEqual(result.passed, false,
        `Manifest missing TEST_FILES must fail closed; got passed:${result.passed}`);
      assert.ok(
        result.violations.some((v) => v.includes('test-no-export.js')),
        `Expected 'test-no-export.js' in violations, got: ${JSON.stringify(result.violations)}`,
      );
      assert.notStrictEqual(result.notApplicable, true,
        'Fail-closed result must NOT carry notApplicable:true');
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// A3: normal path unchanged — registered passes, unlisted is a violation
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'A3: normal manifest — registered candidate passes, unlisted candidate is the sole violation',
  async () => {
    const { projectRoot, cleanup } = makeRoot(
      `export const TEST_FILES = ${JSON.stringify(['test/test-foo.js'])};\n`,
    );

    try {
      writeTestFile(projectRoot, 'test/test-foo.js', '// registered\n');
      writeTestFile(projectRoot, 'test/test-bar.js', '// unregistered, no annotation\n');

      const candidates = [
        path.join(projectRoot, 'test', 'test-foo.js'),
        path.join(projectRoot, 'test', 'test-bar.js'),
      ];
      const result = await checkTestRegistration(candidates, null, projectRoot);

      assert.strictEqual(result.passed, false,
        `Unlisted test-bar.js must fail the gate; got passed:${result.passed}`);
      assert.strictEqual(result.violations.length, 1,
        `Expected exactly 1 violation but got: ${JSON.stringify(result.violations)}`);
      assert.ok(
        result.violations[0].includes('test-bar.js'),
        `Expected the violation to be test-bar.js, got: ${result.violations[0]}`,
      );
      assert.ok(
        !result.violations.some((v) => v.includes('test-foo.js')),
        `Registered test-foo.js must NOT be a violation: ${JSON.stringify(result.violations)}`,
      );
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// B: Pipeline._recordGateOverride — driven via Pipeline.prototype with a
//    duck-typed `this` (same pattern as test-scope-coverage-gate.js /
//    test-format-banner.js: real method, no full constructor).
// ─────────────────────────────────────────────────────────────────────────────

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ext-sidecar-'));
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  const logs = [];
  const fakeThis = {
    harnessDir,
    projectRoot: root,
    onLog: (m) => logs.push(m),
  };
  return { root, harnessDir, fakeThis, logs, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const recordGateOverride = Pipeline.prototype._recordGateOverride;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

await test(
  'B1: valid sidecar → gateOverrides entry appended with gate/evidence/at, existing fields preserved',
  async () => {
    const { harnessDir, fakeThis, cleanup } = makeHarness();
    const taskId = '001-001-001-001';
    const sidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);

    try {
      fs.writeFileSync(sidecarPath, JSON.stringify({ result: 'PASSED' }), 'utf8');

      await recordGateOverride.call(fakeThis, taskId, 'test-registration-gate', 'some evidence');

      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      assert.strictEqual(sidecar.result, 'PASSED',
        `Existing sidecar fields must be preserved; got: ${JSON.stringify(sidecar)}`);
      assert.ok(Array.isArray(sidecar.gateOverrides),
        `Expected gateOverrides array, got: ${JSON.stringify(sidecar.gateOverrides)}`);
      assert.strictEqual(sidecar.gateOverrides.length, 1,
        `Expected 1 override entry, got: ${JSON.stringify(sidecar.gateOverrides)}`);

      const entry = sidecar.gateOverrides[sidecar.gateOverrides.length - 1];
      assert.strictEqual(entry.gate, 'test-registration-gate',
        `entry.gate mismatch: ${JSON.stringify(entry)}`);
      assert.strictEqual(entry.evidence, 'some evidence',
        `entry.evidence mismatch: ${JSON.stringify(entry)}`);
      assert.strictEqual(typeof entry.at, 'string',
        `entry.at must be a string, got: ${JSON.stringify(entry.at)}`);
      assert.ok(ISO_RE.test(entry.at) && !Number.isNaN(Date.parse(entry.at)),
        `entry.at must be an ISO timestamp string, got: ${entry.at}`);
    } finally {
      cleanup();
    }
  },
);

await test(
  'B2: calling _recordGateOverride twice appends two entries in order',
  async () => {
    const { harnessDir, fakeThis, cleanup } = makeHarness();
    const taskId = '001-001-001-002';
    const sidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);

    try {
      fs.writeFileSync(sidecarPath, JSON.stringify({ result: 'PASSED' }), 'utf8');

      await recordGateOverride.call(fakeThis, taskId, 'test-registration-gate', 'first evidence');
      await recordGateOverride.call(fakeThis, taskId, 'test-registration-gate', 'second evidence');

      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      assert.ok(Array.isArray(sidecar.gateOverrides),
        `Expected gateOverrides array, got: ${JSON.stringify(sidecar)}`);
      assert.strictEqual(sidecar.gateOverrides.length, 2,
        `Expected 2 override entries, got: ${JSON.stringify(sidecar.gateOverrides)}`);
      assert.strictEqual(sidecar.gateOverrides[0].evidence, 'first evidence',
        `First entry out of order: ${JSON.stringify(sidecar.gateOverrides)}`);
      assert.strictEqual(sidecar.gateOverrides[1].evidence, 'second evidence',
        `Second entry out of order: ${JSON.stringify(sidecar.gateOverrides)}`);
      assert.strictEqual(sidecar.result, 'PASSED', 'result field must survive both appends');
    } finally {
      cleanup();
    }
  },
);

await test(
  'B3a: sidecar file absent → _recordGateOverride does not throw',
  async () => {
    const { fakeThis, cleanup } = makeHarness();
    const taskId = '001-001-001-003'; // no sidecar written

    try {
      await recordGateOverride.call(fakeThis, taskId, 'test-registration-gate', 'evidence');
      // Reaching here without a throw is the assertion (fail-soft).
    } finally {
      cleanup();
    }
  },
);

await test(
  'B3b: sidecar contains invalid JSON → _recordGateOverride does not throw',
  async () => {
    const { harnessDir, fakeThis, cleanup } = makeHarness();
    const taskId = '001-001-001-004';
    const sidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);

    try {
      fs.writeFileSync(sidecarPath, '{ this is not valid JSON !!!', 'utf8');
      await recordGateOverride.call(fakeThis, taskId, 'test-registration-gate', 'evidence');
      // Reaching here without a throw is the assertion (fail-soft).
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// C: pipeline wrapper on a project WITHOUT scripts/run-tests.js — full
//    _executeAndVerifyTask drive, mirroring test-test-registration-pipeline.js
//    #5a but with NO manifest: the gate must be not-applicable → task passes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Same env builder as test-test-registration-pipeline.js#createEnv, except the
 * manifest (scripts/run-tests.js) is NOT written — this is the "external
 * project" under test.
 */
function createNoManifestEnv(tasks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ext-pipe-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(harnessDir, 'logs', 'token-usage.json'), JSON.stringify({ sessions: [], totals: {} }));

  // Deliberately NO scripts/run-tests.js.

  const parts = tasks[0].id.split('-');
  const milestoneId = parts[0];
  const missionId = `${parts[0]}-${parts[1]}`;
  const subMissionId = `${parts[0]}-${parts[1]}-${parts[2]}`;

  const state = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId, description: 'm', status: 'pending',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: {
          [missionId]: {
            id: missionId, description: 'mi', status: 'pending',
            stateFile: `.harness/state/mission-${missionId}.json`,
            planFile: `.harness/plan/mission-${missionId}.md`,
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  writeMissionState(harnessDir, missionId, 'mi', {
    subMissions: [{
      id: subMissionId, description: 'sm',
      tasks: tasks.map((t) => ({
        id: t.id, description: 'task', targetFiles: t.targetFiles,
        dependencies: [], testCases: [], status: t.status || 'pending',
      })),
    }],
  });

  for (const t of tasks) {
    fs.writeFileSync(
      path.join(harnessDir, 'verify', `task-${t.id}.json`),
      JSON.stringify({ taskId: t.id, targetFiles: t.targetFiles, hardChecks: [], testCases: [] })
    );
    for (const tf of t.targetFiles) {
      const abs = path.join(root, tf);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '// baseline\n');
    }
  }

  return { root, harnessDir, missionId, subMissionId, milestoneId };
}

function makePipeline(root) {
  const logs = [];
  const pipeline = new Pipeline(root, { onLog: (m) => logs.push(m), onConfirm: async () => true, statusBar: false });
  pipeline._dispatchAnalyzer = async () => {};
  return { pipeline, logs };
}

await test('C: no-manifest project — verify-pass task creating a test is NOT failed by the gate; "not applicable" logged', async () => {
  const taskId = '001-001-001-001';
  const newTest = 'test/test-created-in-external-project.js';
  const env = createNoManifestEnv([{ id: taskId, targetFiles: [newTest] }]);
  const origMaxRetries = config.maxRetries;
  config.maxRetries = 0;
  try {
    const { pipeline, logs } = makePipeline(env.root);
    pipeline.executor = {
      executeTask: async (task) => {
        fs.writeFileSync(
          path.join(pipeline.harnessDir, 'progress', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, status: 'COMPLETED', affectedFiles: [newTest] })
        );
        // Mutate the file so the phantom-write guard sees a real change.
        fs.writeFileSync(path.join(env.root, newTest), '// test written in a project with no manifest\n');
        return { status: 'COMPLETED', affectedFiles: [newTest] };
      },
    };
    pipeline.verifier = {
      verifyTask: async (task) => {
        fs.writeFileSync(
          path.join(pipeline.harnessDir, 'verification', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, verified: true })
        );
        return { verified: true };
      },
    };

    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: taskId, description: 'task', targetFiles: [newTest], dependencies: [],
    });

    const ms = JSON.parse(fs.readFileSync(path.join(env.harnessDir, 'state', `mission-${env.missionId}.json`), 'utf8'));
    const task = ms.subMissions[env.subMissionId].tasks[taskId];
    assert.notStrictEqual(task.status, 'failed',
      `Gate must be not-applicable on a no-manifest project; task ended '${task.status}'. Logs tail: ${logs.slice(-8).join('\n')}`);
    assert.ok(
      !logs.some((l) => /test-registration gate FAILED/i.test(l)),
      `No 'test-registration gate FAILED' log expected, got: ${logs.filter((l) => /test-registration/i.test(l)).join('\n')}`
    );
    assert.ok(
      logs.some((l) => /not applicable/i.test(l)),
      `Expected an onLog line mentioning 'not applicable', got: ${logs.filter((l) => /registration|applicable/i.test(l)).join('\n') || '(no matching lines)'}`
    );
  } finally {
    config.maxRetries = origMaxRetries;
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
