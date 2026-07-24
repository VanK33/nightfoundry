/**
 * test-multi-edit-split.js — Unit tests for validateTaskDependencies
 *
 * The same-file fan-out (one task → N clones, one per same-file hardCheck) has
 * been retired: validateTaskDependencies never splits. A single task carries
 * all its same-file acceptance hardChecks (bundled), and the function's only
 * remaining job is dependency validation.
 *
 * TC1: fixture plan with one task targeting src/foo.js and 3 same-file
 *      spec.json acceptance checks → NO split (still 1 task), and driving the
 *      REAL applySpecHardChecks bundles all 3 hardChecks onto that single task
 * TC2: fixture plan with one task and 1 hardCheck on src/foo.js → plan returned
 *      with 1 task unchanged, no spurious split
 * TC3: fixture plan with one task targeting both src/a.js and src/b.js → no
 *      splitting (no split path remains)
 * TC4: dep-free plan validates cleanly and is returned unchanged
 * TC5: plan with sequential sub-mission ordering: with no split, the two tasks
 *      are unchanged and _enforceSequentialOrdering still chains them correctly
 * TC7: plan with two sub-missions where sm-001 has 3 same-file hardChecks (no
 *      split); sm-002 task dep on 'sm-001-001' stays 'sm-001-001' (no remap)
 * TC8: plan with a task whose dep references non-existent 'sm-001-999';
 *      validateTaskDependencies throws with error containing referencing task
 *      ID and 'sm-001-999'
 * TC9: plan with two sub-missions where sm-001 task has only 1 hardCheck (no
 *      split); sm-002 dep on 'sm-001-001' remains unchanged (no false-positive)
 *
 * Run: node test/test-multi-edit-split.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { validateTaskDependencies, Planner } from '../src/orchestrator/agents/planner.js';
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

function makeFakeSessionManager() {
  return {
    spawn(opts) {
      const fakeHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
      const fakeResult = {
        structured_output: { subMissions: [], milestones: [] },
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        total_cost_usd: 0,
      };
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
  };
}

function makeFakeLogger() {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-multi-edit-split.jsonl',
      write: () => {},
      close: () => {},
    }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
  };
}

// ── TC1: 3 grep checks same file → 1 task carrying all 3 hardChecks ──────────

await test('TC1: 3 grep checks same file produces 1 task carrying all 3 hardChecks', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        description: 'A sub-mission',
        ordering: 'sequential',
        tasks: [
          {
            id: 'sm-001-001',
            description: 'Edit src/foo.js',
            targetFiles: ['src/foo.js'],
            dependencies: [],
          },
        ],
      },
    ],
  };

  // (a) No split: validateTaskDependencies leaves the plan structurally as-is —
  // still exactly one task (direct unit assertion, not a tautology).
  const result = validateTaskDependencies(plan);
  const tasks = result.subMissions[0].tasks;
  assert.strictEqual(tasks.length, 1, `Expected 1 task (no split), got ${tasks.length}`);

  // (b) The bundled end-state goes through the REAL applySpecHardChecks (same
  // on-disk fixture pattern as test-cross-mission-dep.js TC4): write a spec.json
  // whose 3 command-kind acceptance criteria path-token-match the task's target
  // file, then assert the one task carries all 3 hardChecks by command identity.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-edit-split-tc1-'));
  try {
    const harnessDir = path.join(root, '.harness');
    fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });

    const specsDir = path.join(root, 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    const specMdPath = path.join(specsDir, 'feature.spec.md');
    fs.writeFileSync(specMdPath, '# Spec: feature\n');
    fs.writeFileSync(
      path.join(specsDir, 'feature.spec.json'),
      JSON.stringify({
        acceptance_criteria: [
          {
            description: 'string 1 present',
            verification: { kind: 'command', command: "grep -q 'STRING_1' src/foo.js", targetFile: 'src/foo.js' },
          },
          {
            description: 'string 2 present',
            verification: { kind: 'command', command: "grep -q 'STRING_2' src/foo.js", targetFile: 'src/foo.js' },
          },
          {
            description: 'string 3 present',
            verification: { kind: 'command', command: "grep -q 'STRING_3' src/foo.js", targetFile: 'src/foo.js' },
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(harnessDir, 'state.json'),
      JSON.stringify({ projectMeta: { prdPath: specMdPath } }),
    );

    const missionDecomp = {
      subMissions: [
        {
          id: 'sm-001',
          description: 'A sub-mission',
          tasks: [
            {
              id: 'sm-001-001',
              description: 'Edit src/foo.js',
              targetFiles: ['src/foo.js'],
              dependencies: [],
            },
          ],
        },
      ],
    };

    applySpecHardChecks(missionDecomp, root, harnessDir);

    const mergedTasks = missionDecomp.subMissions[0].tasks;
    assert.strictEqual(mergedTasks.length, 1, `Expected 1 task after applySpecHardChecks, got ${mergedTasks.length}`);

    const only = mergedTasks[0];
    assert.ok(Array.isArray(only.hardChecks), 'single task hardChecks should be an array');
    assert.strictEqual(
      only.hardChecks.length,
      3,
      `single task should carry all 3 hardChecks, got ${only.hardChecks.length}`,
    );
    const carried = new Set(only.hardChecks.map((c) => c.command));
    for (const cmd of ["grep -q 'STRING_1' src/foo.js", "grep -q 'STRING_2' src/foo.js", "grep -q 'STRING_3' src/foo.js"]) {
      assert.ok(
        carried.has(cmd),
        `single task hardChecks should include ${JSON.stringify(cmd)}, got ${JSON.stringify([...carried])}`,
      );
    }
    assert.ok(
      Array.isArray(only.targetFiles) && only.targetFiles.includes('src/foo.js'),
      `single task targetFiles should include 'src/foo.js', got ${JSON.stringify(only.targetFiles)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── TC2: 1 check → 1 task unchanged ─────────────────────────────────────────

await test('TC2: 1 check produces 1 task unchanged', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        description: 'A sub-mission',
        tasks: [
          {
            id: 'sm-001-001',
            description: 'Edit src/foo.js',
            targetFiles: ['src/foo.js'],
            dependencies: [],
          },
        ],
      },
    ],
  };

  const result = validateTaskDependencies(plan);

  const tasks = result.subMissions[0].tasks;
  assert.strictEqual(tasks.length, 1, `Expected 1 task (no split), got ${tasks.length}`);
});

// ── TC3: 2 checks different files → no split ────────────────────────────────

await test('TC3: 2 checks different files no split', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        description: 'A sub-mission',
        tasks: [
          {
            id: 'sm-001-001',
            description: 'Edit src/a.js and src/b.js',
            targetFiles: ['src/a.js', 'src/b.js'],
            dependencies: [],
          },
        ],
      },
    ],
  };

  const result = validateTaskDependencies(plan);

  const tasks = result.subMissions[0].tasks;
  assert.strictEqual(
    tasks.length,
    1,
    `Expected 1 task (no split when checks target distinct files), got ${tasks.length}`,
  );
});

// ── TC4: dep-free plan validates cleanly and is returned unchanged ───────────

await test('TC4: dep-free plan validates cleanly and is returned unchanged', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        description: 'A sub-mission',
        tasks: [
          {
            id: 'sm-001-001',
            description: 'Edit src/foo.js',
            targetFiles: ['src/foo.js'],
            dependencies: [],
          },
        ],
      },
    ],
  };

  const result = validateTaskDependencies(plan);

  const tasks = result.subMissions[0].tasks;
  assert.strictEqual(tasks.length, 1, `Expected plan unchanged with 1 task, got ${tasks.length}`);
  assert.strictEqual(
    result.subMissions[0].tasks[0].id,
    'sm-001-001',
    'Task ID should be unchanged',
  );
});

// ── TC5: no split — sequential ordering chains the (unchanged) tasks ──────────

await test('TC5: no split — sequential ordering chains the unchanged tasks', async () => {
  const planner = new Planner(
    makeFakeSessionManager(),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  // Plan with two tasks: the first has 3 same-file hardChecks (formerly split
  // into 3, now bundled into one task), the second depends on it.
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        description: 'A sequential sub-mission',
        ordering: 'sequential',
        tasks: [
          {
            id: 'sm-001-001',
            description: 'Edit src/foo.js (no longer split)',
            targetFiles: ['src/foo.js'],
            dependencies: [],
          },
          {
            id: 'sm-001-002',
            description: 'Another task depending on the first',
            targetFiles: ['src/bar.js'],
            dependencies: [{ taskId: 'sm-001-001', type: 'hard' }],
          },
        ],
      },
    ],
  };

  // No split: the two tasks remain exactly two tasks.
  validateTaskDependencies(plan);

  const tasksAfterValidate = plan.subMissions[0].tasks;
  assert.strictEqual(
    tasksAfterValidate.length,
    2,
    `Expected 2 tasks (no split), got ${tasksAfterValidate.length}`,
  );

  // Now enforce sequential ordering on the (unchanged) plan.
  planner._enforceSequentialOrdering(plan);

  const tasks = plan.subMissions[0].tasks;
  assert.strictEqual(tasks.length, 2, `Expected 2 tasks after ordering, got ${tasks.length}`);

  // tasks[0] should have no dependencies
  assert.deepStrictEqual(
    tasks[0].dependencies,
    [],
    `tasks[0] should have no dependencies, got: ${JSON.stringify(tasks[0].dependencies)}`,
  );

  // tasks[1] should depend on tasks[0]
  const deps1 = tasks[1].dependencies;
  assert.ok(
    deps1.some((d) => d.taskId === tasks[0].id && d.type === 'hard'),
    `tasks[1].dependencies should contain hard dep on tasks[0] (${tasks[0].id}), got: ${JSON.stringify(deps1)}`,
  );
});

// ── TC7: cross-sub-mission dep — no remap (no split) ─────────────────────────

await test('TC7: cross-sub-mission dep — dep unchanged with same-file checks (no split)', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        description: 'First sub-mission',
        ordering: 'sequential',
        tasks: [
          {
            id: 'sm-001-001',
            description: 'Edit src/foo.js (will be split)',
            targetFiles: ['src/foo.js'],
            dependencies: [],
          },
        ],
      },
      {
        id: 'sm-002',
        description: 'Second sub-mission',
        ordering: 'sequential',
        tasks: [
          {
            id: 'sm-002-001',
            description: 'Task depending on sm-001-001',
            targetFiles: ['src/bar.js'],
            dependencies: [{ taskId: 'sm-001-001', type: 'hard' }],
          },
        ],
      },
    ],
  };

  const result = validateTaskDependencies(plan);

  // sm-001 should still have 1 task (no split, even with 3 same-file checks)
  assert.strictEqual(
    result.subMissions[0].tasks.length,
    1,
    `Expected 1 task in sm-001 (no split), got ${result.subMissions[0].tasks.length}`,
  );

  // sm-002's task dep should remain 'sm-001-001' unchanged (no remap)
  const sm002Task = result.subMissions[1].tasks[0];
  const depTaskId = sm002Task.dependencies[0].taskId;
  assert.strictEqual(
    depTaskId,
    'sm-001-001',
    `Expected dep to remain 'sm-001-001' (no remap), got '${depTaskId}'`,
  );
});

// ── TC8: unresolvable dep throws ──────────────────────────────────────────────

await test('TC8: unresolvable dep throws — error contains referencing task ID and missing ID', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        description: 'A sub-mission',
        ordering: 'sequential',
        tasks: [
          {
            id: 'sm-001-001',
            description: 'Task with bad dependency',
            targetFiles: ['src/foo.js'],
            dependencies: [{ taskId: 'sm-001-999', type: 'hard' }],
          },
        ],
      },
    ],
  };

  assert.throws(
    () => validateTaskDependencies(plan),
    (err) => {
      assert.ok(
        err.message.includes('sm-001-001'),
        `Error message should include referencing task ID 'sm-001-001', got: ${err.message}`,
      );
      assert.ok(
        err.message.includes('sm-001-999'),
        `Error message should include missing dep ID 'sm-001-999', got: ${err.message}`,
      );
      assert.ok(
        err.message.includes('dependency target not found in plan'),
        `Error message should include 'dependency target not found in plan', got: ${err.message}`,
      );
      return true;
    },
    'Expected validateTaskDependencies to throw for unresolvable dep',
  );
});

// ── TC9: cross-sub-mission dep no false-positive rewrite ──────────────────────

await test('TC9: cross-sub-mission dep no false-positive rewrite — dep unchanged when no split', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        description: 'First sub-mission',
        ordering: 'sequential',
        tasks: [
          {
            id: 'sm-001-001',
            description: 'Edit src/foo.js (no split — only 1 hardCheck)',
            targetFiles: ['src/foo.js'],
            dependencies: [],
          },
        ],
      },
      {
        id: 'sm-002',
        description: 'Second sub-mission',
        ordering: 'sequential',
        tasks: [
          {
            id: 'sm-002-001',
            description: 'Task depending on sm-001-001',
            targetFiles: ['src/bar.js'],
            dependencies: [{ taskId: 'sm-001-001', type: 'hard' }],
          },
        ],
      },
    ],
  };

  const result = validateTaskDependencies(plan);

  // sm-001 should still have 1 task (no split)
  assert.strictEqual(
    result.subMissions[0].tasks.length,
    1,
    `Expected 1 task in sm-001 (no split), got ${result.subMissions[0].tasks.length}`,
  );

  // sm-002's task dep should remain 'sm-001-001' unchanged
  const sm002Task = result.subMissions[1].tasks[0];
  const depTaskId = sm002Task.dependencies[0].taskId;
  assert.strictEqual(
    depTaskId,
    'sm-001-001',
    `Expected dep to remain 'sm-001-001' (no false-positive rewrite), got '${depTaskId}'`,
  );
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
