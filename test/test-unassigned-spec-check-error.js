/**
 * test-unassigned-spec-check-error.js — Class-contract tests for
 * UnassignedSpecCheckError, the IncompleteScopeError subclass raised when a
 * spec hard-check command's referenced file(s) are claimed by no task's
 * targetFiles.
 *
 * TC1: instanceof IncompleteScopeError AND UnassignedSpecCheckError, with
 *      name === 'UnassignedSpecCheckError'.
 * TC2: uncoveredLabels deep-equals the exact command array passed in.
 * TC3: message includes every command passed in for a two-command instance.
 * TC4: message does NOT include 'not matched by any mission' (that phrasing
 *      belongs to the base IncompleteScopeError, not this subclass).
 * TC5: message states the referenced file(s) are claimed by no task's
 *      targetFiles.
 * TC6: message names '--allow-incomplete-scope' and describes the
 *      disposition being persisted so a later resume honors it.
 * TC7: non-vacuous control — plain IncompleteScopeError still produces its
 *      current message containing 'not matched by any mission' and
 *      '--allow-incomplete-scope'.
 * TC8: pipeline-level — Pipeline#_assertSpecHardCheckCoverage, given a spec
 *      hard-check assigned in one mission file and a second check assigned
 *      nowhere, with allowIncompleteScope false, throws an error that is
 *      instanceof BOTH UnassignedSpecCheckError and IncompleteScopeError,
 *      whose uncoveredLabels includes the orphan command and excludes the
 *      assigned command, and whose message omits 'not matched by any
 *      mission'.
 * TC9: pipeline-level — the identical fixture with allowIncompleteScope
 *      true resolves without throwing, and the captured onLog output
 *      contains a line beginning 'Spec hard-check coverage warning:'
 *      followed by a '  - <orphan command>' bullet line.
 *
 * Run: node test/test-unassigned-spec-check-error.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  IncompleteScopeError,
  UnassignedSpecCheckError,
} from '../src/orchestrator/core/incomplete-scope-error.js';
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

await test('TC1: new UnassignedSpecCheckError is instanceof IncompleteScopeError and UnassignedSpecCheckError, with name === "UnassignedSpecCheckError"', async () => {
  const err = new UnassignedSpecCheckError(['node test/orphan-c.js']);
  assert.ok(
    err instanceof IncompleteScopeError,
    `Expected instanceof IncompleteScopeError, got: ${err.constructor.name}`
  );
  assert.ok(
    err instanceof UnassignedSpecCheckError,
    `Expected instanceof UnassignedSpecCheckError, got: ${err.constructor.name}`
  );
  assert.strictEqual(err.name, 'UnassignedSpecCheckError');
});

await test('TC2: uncoveredLabels deep-equals the exact command array passed to the constructor', async () => {
  const commands = ['node test/orphan-c.js'];
  const err = new UnassignedSpecCheckError(commands);
  assert.deepStrictEqual(err.uncoveredLabels, commands);
});

await test('TC3: message includes every command passed in for a two-command instance', async () => {
  const commands = ['node test/orphan-c.js', 'node test/orphan-d.js'];
  const err = new UnassignedSpecCheckError(commands);
  for (const cmd of commands) {
    assert.ok(
      err.message.includes(cmd),
      `Expected message to include command "${cmd}", got: "${err.message}"`
    );
  }
});

await test('TC4: message does NOT include "not matched by any mission"', async () => {
  const err = new UnassignedSpecCheckError(['node test/orphan-c.js']);
  assert.ok(
    !err.message.includes('not matched by any mission'),
    `Expected message NOT to include "not matched by any mission", got: "${err.message}"`
  );
});

await test('TC5: message states the referenced file(s) are claimed by no task\'s targetFiles', async () => {
  const err = new UnassignedSpecCheckError(['node test/orphan-c.js']);
  assert.ok(
    err.message.includes("claimed by no task's targetFiles"),
    `Expected message to state the referenced file(s) are claimed by no task's targetFiles, got: "${err.message}"`
  );
});

await test('TC6: message names --allow-incomplete-scope and describes the persisted disposition so a later resume honors it', async () => {
  const err = new UnassignedSpecCheckError(['node test/orphan-c.js']);
  assert.ok(
    err.message.includes('--allow-incomplete-scope'),
    `Expected message to name --allow-incomplete-scope, got: "${err.message}"`
  );
  assert.ok(
    err.message.includes('persisted') && err.message.includes('resume'),
    `Expected message to describe the disposition being persisted so a later resume honors it, got: "${err.message}"`
  );
});

await test('TC7 (control): plain IncompleteScopeError message is unchanged — contains "not matched by any mission" and "--allow-incomplete-scope"', async () => {
  const err = new IncompleteScopeError(['some label']);
  assert.ok(
    err.message.includes('not matched by any mission'),
    `Expected control IncompleteScopeError message to include "not matched by any mission", got: "${err.message}"`
  );
  assert.ok(
    err.message.includes('--allow-incomplete-scope'),
    `Expected control IncompleteScopeError message to include "--allow-incomplete-scope", got: "${err.message}"`
  );
});

// ── Pipeline-level fixture helpers (TC8/TC9) ────────────────────────────────
// Mirrors the createDrainEnv/writeMissionStateFixture/makeDrainPipeline/
// teardownPipeline recipe from test/test-hard-checks-pipeline-wiring.js so
// Pipeline#_assertSpecHardCheckCoverage can be exercised directly here too.

/**
 * Write a persisted mission state fixture file mirroring writeMissionState's
 * shape: mission-{missionId}.json →
 *   { id, missionId, description, status,
 *     subMissions: { [smId]: { id, description, status,
 *       tasks: { [taskId]: { ..., hardChecks: [{name, command}] } } } } }
 *
 * `assignedChecks` is the list of {name, command} hardChecks to persist, one
 * task per check. When empty, a single task WITHOUT a hardChecks key is
 * written (matching tasks persisted with no assigned checks).
 *
 * @param {string} harnessDir
 * @param {string} missionId - e.g. '001-001'
 * @param {Array<{name:string,command:string}>} assignedChecks
 */
function writeMissionStateFixture(harnessDir, missionId, assignedChecks = []) {
  const smId = `${missionId}-001`;
  const tasks = {};
  if (assignedChecks.length === 0) {
    const taskId = `${smId}-001`;
    tasks[taskId] = {
      id: taskId,
      description: 'drain fixture task (no assigned checks)',
      status: 'pending',
      targetFiles: ['src/foo.js'],
      dependencies: [],
      testCases: [],
      // no hardChecks key on purpose — mirrors a persisted task that was
      // assigned nothing; the drain must not trip over the absent field.
    };
  } else {
    assignedChecks.forEach((check, i) => {
      const taskId = `${smId}-${String(i + 1).padStart(3, '0')}`;
      tasks[taskId] = {
        id: taskId,
        description: 'drain fixture task',
        status: 'pending',
        targetFiles: [],
        dependencies: [],
        testCases: [],
        hardChecks: [check],
      };
    });
  }
  const missionState = {
    id: missionId,
    missionId,
    description: 'drain fixture mission',
    status: 'pending',
    subMissions: {
      [smId]: { id: smId, description: 'drain fixture sm', status: 'pending', tasks },
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify(missionState, null, 2)
  );
}

/**
 * Build a fixture for the _assertSpecHardCheckCoverage drain: a tmp project
 * root with .harness/state.json whose projectMeta.prdPath points at
 * <root>/spec.md (sibling spec.json written from `specCommands`), plus one
 * persisted .harness/state/mission-*.json per entry in `missionAssignments`
 * ({ missionId → [{name, command}] }).
 *
 * @param {{ specCommands?: Array<{description:string,command:string}>,
 *           missionAssignments?: Record<string, Array<{name:string,command:string}>> }} opts
 * @returns {{ root: string, harnessDir: string }}
 */
function createDrainEnv({ specCommands = [], missionAssignments = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unassigned-spec-check-drain-'));
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

  const state = {
    projectMeta: { prdPath, createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {},
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  const specJson = {
    goal: 'drain test spec',
    acceptance_criteria: specCommands.map((c) => ({
      description: c.description,
      verification: { kind: 'command', command: c.command },
    })),
  };
  fs.writeFileSync(path.join(root, 'spec.json'), JSON.stringify(specJson, null, 2));

  for (const [missionId, assignedChecks] of Object.entries(missionAssignments)) {
    writeMissionStateFixture(harnessDir, missionId, assignedChecks);
  }

  return { root, harnessDir };
}

/**
 * Build a bare Pipeline instance for calling _assertSpecHardCheckCoverage
 * directly (no agent fakes needed — the drain only reads .harness state and
 * spec.json from disk).
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
 * Remove the process signal listeners the Pipeline constructor registers, so
 * these tests (which construct extra Pipeline instances) don't pile up
 * listeners past Node's MaxListeners warning threshold. removeListener on an
 * unregistered handler is a safe no-op.
 */
function teardownPipeline(pipeline) {
  const handlers = pipeline._signalHandlers || {};
  if (handlers.SIGINT) process.removeListener('SIGINT', handlers.SIGINT);
  if (handlers.SIGTERM) process.removeListener('SIGTERM', handlers.SIGTERM);
  if (handlers.exit) process.removeListener('exit', handlers.exit);
  if (handlers.uncaughtException) process.removeListener('uncaughtException', handlers.uncaughtException);
}

await test('TC8: Pipeline#_assertSpecHardCheckCoverage throws an UnassignedSpecCheckError (also instanceof IncompleteScopeError) naming the orphan command and excluding the assigned command, with allowIncompleteScope=false', async () => {
  const assignedCommand = 'node test/test-x.js';
  const orphanCommand = 'node test/orphan-c.js';
  const env = createDrainEnv({
    specCommands: [
      { description: 'check A', command: assignedCommand },
      { description: 'check C', command: orphanCommand },
    ],
    missionAssignments: {
      '001-001': [{ name: 'check A', command: assignedCommand }],
    },
  });
  const { pipeline } = makeDrainPipeline(env.root);
  try {
    let thrown = null;
    try {
      await pipeline._assertSpecHardCheckCoverage();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'expected _assertSpecHardCheckCoverage to throw on a true orphan, but it did not throw');
    assert.ok(
      thrown instanceof UnassignedSpecCheckError,
      `expected instanceof UnassignedSpecCheckError, got ${thrown.constructor.name}: ${thrown.message}`
    );
    assert.ok(
      thrown instanceof IncompleteScopeError,
      `expected instanceof IncompleteScopeError, got ${thrown.constructor.name}: ${thrown.message}`
    );
    const labels = Array.isArray(thrown.uncoveredLabels) ? thrown.uncoveredLabels : [];
    assert.ok(
      labels.includes(orphanCommand),
      `expected uncoveredLabels to include '${orphanCommand}', got ${JSON.stringify(labels)}`
    );
    assert.ok(
      !labels.includes(assignedCommand),
      `expected uncoveredLabels to NOT include the assigned command '${assignedCommand}', got ${JSON.stringify(labels)}`
    );
    assert.ok(
      !thrown.message.includes('not matched by any mission'),
      `expected message NOT to include "not matched by any mission", got: "${thrown.message}"`
    );
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

await test('TC9: Pipeline#_assertSpecHardCheckCoverage with the identical fixture and allowIncompleteScope=true resolves without throwing and logs a "Spec hard-check coverage warning:" line with a "  - <orphan command>" bullet', async () => {
  const assignedCommand = 'node test/test-x.js';
  const orphanCommand = 'node test/orphan-c.js';
  const env = createDrainEnv({
    specCommands: [
      { description: 'check A', command: assignedCommand },
      { description: 'check C', command: orphanCommand },
    ],
    missionAssignments: {
      '001-001': [{ name: 'check A', command: assignedCommand }],
    },
  });
  const { pipeline, logs } = makeDrainPipeline(env.root);
  try {
    pipeline._allowIncompleteScope = true;
    // _assertSpecHardCheckCoverage is currently synchronous; awaiting its
    // result is still safe (await on a non-promise resolves immediately) and
    // future-proofs this test if the drain becomes async.
    await pipeline._assertSpecHardCheckCoverage();
    const warningLine = logs.find((l) => l.startsWith('Spec hard-check coverage warning:'));
    assert.ok(
      warningLine,
      `expected a log line starting with 'Spec hard-check coverage warning:', got: ${logs.slice(-10).join('\n')}`
    );
    assert.ok(
      warningLine.includes(`  - ${orphanCommand}`),
      `expected the warning line to include a '  - ${orphanCommand}' bullet, got: "${warningLine}"`
    );
  } finally {
    teardownPipeline(pipeline);
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
