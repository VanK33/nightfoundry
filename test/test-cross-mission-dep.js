/**
 * test-cross-mission-dep.js — Tests for backward cross-mission dependency
 * validation in validateTaskDependencies / applySpecHardChecks (W1-F7 false kill).
 *
 * Contract (cross-mission-dep-validation.spec.md):
 *   validateTaskDependencies(plan, knownExternalTaskIds = new Set())
 *   — dep validation resolves a dep id via the current plan's task ids, then
 *   knownExternalTaskIds (verbatim pass-through, no rewrite); only an id in
 *   neither set throws 'dependency target not found'. Validation runs
 *   unconditionally — there is no spec-hardCheck gate. applySpecHardChecks
 *   builds the external set from harnessDir/state/mission-*.json persisted ids.
 *
 * TC1: backward cross-mission dep accepted — dep on a prior-mission id present
 *      in knownExternalTaskIds does not throw; dependency survives byte-identical
 * TC2: fail-closed — same plan with empty external set throws
 *      'dependency target not found'; ditto with a non-empty set lacking the id
 * TC3: back-compat — one-arg call: intra-plan dep resolves as before;
 *      unknown dep throws as before
 * TC4: end-to-end through applySpecHardChecks — mission-001-001.json persisted
 *      on disk; second mission's task depending on 001-001-001-001 does not
 *      throw and still receives its scoped hardCheck
 *
 * Run: node test/test-cross-mission-dep.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { validateTaskDependencies } from '../src/orchestrator/agents/planner.js';
import { applySpecHardChecks } from '../src/orchestrator/core/pipeline.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  const run = async () => {
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
  };
  return run();
}

// ---------- Fixture helpers ----------

/**
 * Plan B: a later mission's decomposition whose only task depends on a
 * prior mission's task id (001-001-001-001) that is NOT in this plan.
 * Fresh object per call.
 */
function makePlanWithExternalDep() {
  return {
    subMissions: [
      {
        id: '001-002-001',
        description: 'Second-mission sub-mission',
        tasks: [
          {
            id: '001-002-001-001',
            description: 'Edit src/foo.js (depends on a prior-mission task)',
            targetFiles: ['src/foo.js'],
            dependencies: [{ taskId: '001-001-001-001', type: 'hard' }],
          },
        ],
      },
    ],
  };
}

// ── TC1: backward cross-mission dep accepted ─────────────────────────────────

await test('TC1: backward cross-mission dep accepted via knownExternalTaskIds — dependency survives byte-identical', () => {
  const plan = makePlanWithExternalDep();
  const knownExternalTaskIds = new Set(['001-001-001-001']);

  // Must NOT throw (at pre-fix baseline this throws 'dependency target not found')
  const result = validateTaskDependencies(plan, knownExternalTaskIds);

  const task = result.subMissions[0].tasks[0];
  assert.strictEqual(
    task.dependencies.length,
    1,
    `Expected exactly 1 dependency to survive, got ${task.dependencies.length}`,
  );
  // Verbatim pass-through: taskId unchanged, type unchanged — no remap of external ids
  assert.deepStrictEqual(
    task.dependencies[0],
    { taskId: '001-001-001-001', type: 'hard' },
    `External dep must survive byte-identical, got ${JSON.stringify(task.dependencies[0])}`,
  );
});

// ── TC2: fail-closed — id in neither the plan nor the external set throws ────

await test('TC2: fail-closed — empty external set throws dependency target not found', () => {
  assert.throws(
    () => validateTaskDependencies(makePlanWithExternalDep(), new Set()),
    /dependency target not found/,
    'Expected throw with an empty knownExternalTaskIds set',
  );
});

await test('TC2: fail-closed — non-empty external set lacking the id still throws', () => {
  assert.throws(
    () =>
      validateTaskDependencies(
        makePlanWithExternalDep(),
        new Set(['001-001-001-099']),
      ),
    /dependency target not found/,
    'Expected throw when the dep id is in neither the plan nor the external set',
  );
});

// ── TC3: back-compat — one-arg call behaves exactly as at HEAD ───────────────

await test('TC3: back-compat — one-arg call resolves an intra-plan dep unchanged', () => {
  const plan = {
    subMissions: [
      {
        id: '001-002-001',
        description: 'First sub-mission',
        tasks: [
          {
            id: '001-002-001-001',
            description: 'Edit src/foo.js',
            targetFiles: ['src/foo.js'],
            dependencies: [],
          },
        ],
      },
      {
        id: '001-002-002',
        description: 'Second sub-mission',
        tasks: [
          {
            id: '001-002-002-001',
            description: 'Task depending on 001-002-001-001',
            targetFiles: ['src/bar.js'],
            dependencies: [{ taskId: '001-002-001-001', type: 'hard' }],
          },
        ],
      },
    ],
  };

  // One-arg call (default knownExternalTaskIds) — must not throw
  const result = validateTaskDependencies(plan);

  const depTask = result.subMissions[1].tasks[0];
  assert.strictEqual(depTask.dependencies.length, 1, 'Expected 1 dependency');
  assert.deepStrictEqual(
    depTask.dependencies[0],
    { taskId: '001-002-001-001', type: 'hard' },
    `Intra-plan dep should resolve unchanged, got ${JSON.stringify(depTask.dependencies[0])}`,
  );
});

await test('TC3: back-compat — one-arg call with an unknown dep throws', () => {
  assert.throws(
    () => validateTaskDependencies(makePlanWithExternalDep()),
    /dependency target not found/,
    'Expected one-arg call to throw on an unknown dep id (pre-fix behavior preserved)',
  );
});

// ── TC4: end-to-end through applySpecHardChecks ──────────────────────────────

await test('TC4: applySpecHardChecks — persisted mission-001-001.json id accepted, scoped hardCheck intact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-mission-dep-test-'));
  try {
    const harnessDir = path.join(root, '.harness');
    fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });

    // Spec pair: state.json projectMeta.prdPath → spec.md; sibling spec.json
    // declares one command-kind acceptance criterion matching the decomp
    // task's targetFile (deriveSpecJsonPath replaces .md with .json).
    const specsDir = path.join(root, 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    const specMdPath = path.join(specsDir, 'feature.spec.md');
    fs.writeFileSync(specMdPath, '# Spec: feature\n');
    fs.writeFileSync(
      path.join(specsDir, 'feature.spec.json'),
      JSON.stringify({
        acceptance_criteria: [
          {
            description: 'feature test passes',
            verification: {
              kind: 'command',
              command: 'node test/test-feature.js',
              targetFile: 'test/test-feature.js',
            },
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(harnessDir, 'state.json'),
      JSON.stringify({ projectMeta: { prdPath: specMdPath } }),
    );

    // Persisted FIRST mission state on disk: subMissions[].tasks{} carries
    // the task id the second mission depends on.
    fs.writeFileSync(
      path.join(harnessDir, 'state', 'mission-001-001.json'),
      JSON.stringify({
        missionId: '001-001',
        status: 'complete',
        subMissions: {
          '001-001-001': {
            id: '001-001-001',
            tasks: {
              '001-001-001-001': {
                id: '001-001-001-001',
                status: 'complete',
                description: 'Prior-mission task',
                targetFiles: [],
                dependencies: [],
              },
            },
          },
        },
      }),
    );

    // SECOND mission's decomposition: its task depends on the prior
    // mission's persisted id 001-001-001-001 (not in this decomp).
    const missionDecomp = {
      subMissions: [
        {
          id: '001-002-001',
          description: 'Second mission sub-mission',
          tasks: [
            {
              id: '001-002-001-001',
              description: 'Create test/test-feature.js',
              targetFiles: ['test/test-feature.js'],
              dependencies: [{ taskId: '001-001-001-001', type: 'hard' }],
            },
          ],
        },
      ],
    };

    // Must NOT throw (at pre-fix baseline: 'dependency target not found')
    applySpecHardChecks(missionDecomp, root, harnessDir);

    const task = missionDecomp.subMissions[0].tasks[0];

    // Scoping unaffected: the task still receives its scoped hardCheck
    assert.ok(Array.isArray(task.hardChecks), 'Expected task.hardChecks to be an array');
    assert.strictEqual(
      task.hardChecks.length,
      1,
      `Expected exactly 1 scoped hardCheck, got ${task.hardChecks.length}`,
    );
    assert.strictEqual(
      task.hardChecks[0].command,
      'node test/test-feature.js',
      `Expected scoped hardCheck command 'node test/test-feature.js', got '${task.hardChecks[0].command}'`,
    );

    // Cross-mission dependency survives verbatim
    assert.deepStrictEqual(
      task.dependencies[0],
      { taskId: '001-001-001-001', type: 'hard' },
      `Cross-mission dep must survive verbatim, got ${JSON.stringify(task.dependencies[0])}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
