/**
 * test-planner-path-anchor-validation.js — Unit tests for path-anchor
 * preservation validation in planner output.
 *
 * TC1: exact-match relative path does not throw — same relative path in task
 *      and spec passes silently.
 * TC2: exact-match absolute path does not throw — byte-equal absolute paths
 *      are accepted without error.
 * TC3: suffix-mismatch throws — when a task emits only the filename
 *      ('helper.js') but spec declares the full path ('src/utils/helper.js'),
 *      the function must throw with a message containing task id, emitted
 *      path, and spec path.
 * TC4: multi-segment suffix-mismatch throws — similar to TC3 but with a
 *      multi-segment emitted suffix path.
 * TC5: path not in spec at all does not throw — files not declared in
 *      specTargetFiles are silently ignored.
 * TC6: case-mismatch throws — when a task emits a case-variant of a spec path
 *      (e.g., 'SRC/Foo.JS' vs 'src/foo.js'), the function must throw.
 * TC7: prefix-mismatch throws — when the spec path is a prefix of the emitted
 *      path (specLower.endsWith('/'+emittedLower) branch), throw is raised.
 * TC8: replan shape {replacementTasks:[...]} throws on violation.
 * TC9: component-boundary false-positive guard — no throw when no suffix/case
 *      match exists between emitted path and spec.
 * TC10: empty specTargetFiles early-returns without throw.
 * TC11: throw message includes task id, emitted path, and spec path.
 * TC12: paths not in spec inside a plan with other spec files do not throw.
 *
 * No live SDK calls are made.
 *
 * Run: node test/test-planner-path-anchor-validation.js
 */
import assert from 'node:assert';
import { _validatePathAnchorPreservation } from '../src/orchestrator/agents/planner.js';

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

// ── TC1: exact-match relative path does not throw ────────────────────────────

await test('TC1: exact-match relative path does not throw', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-001', targetFiles: ['src/foo.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => _validatePathAnchorPreservation(plan, ['src/foo.js']),
    '_validatePathAnchorPreservation should not throw for relative self-match',
  );

  // targetFiles must remain unchanged
  assert.deepStrictEqual(
    plan.subMissions[0].tasks[0].targetFiles,
    ['src/foo.js'],
    'targetFiles should remain unchanged when path is in specTargetFiles',
  );
});

// ── TC2: exact-match absolute path does not throw ────────────────────────────

await test('TC2: exact-match absolute path does not throw', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-001', targetFiles: ['/abs/path/file.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => _validatePathAnchorPreservation(plan, ['/abs/path/file.js']),
    '_validatePathAnchorPreservation should not throw for byte-equal absolute path',
  );

  assert.strictEqual(
    plan.subMissions[0].tasks[0].targetFiles[0],
    '/abs/path/file.js',
    'absolute path should remain unchanged when it byte-equals the spec path',
  );
});

// ── TC3: single-segment suffix-mismatch throws ───────────────────────────────

await test('TC3: single-segment suffix-mismatch throws', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-001', targetFiles: ['helper.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.throws(
    () => _validatePathAnchorPreservation(plan, ['src/utils/helper.js']),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(err.message.includes('helper.js'), 'message should include emitted path');
      assert.ok(err.message.includes('src/utils/helper.js'), 'message should include spec path');
      return true;
    },
    'should throw when task emits only filename but spec declares full path',
  );
});

// ── TC4: multi-segment suffix-mismatch throws ────────────────────────────────

await test('TC4: multi-segment suffix-mismatch throws', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-001', targetFiles: ['agents/planner.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.throws(
    () => _validatePathAnchorPreservation(plan, ['src/orchestrator/agents/planner.js']),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(err.message.includes('agents/planner.js'), 'message should include emitted path');
      assert.ok(
        err.message.includes('src/orchestrator/agents/planner.js'),
        'message should include spec path',
      );
      return true;
    },
    'should throw on multi-segment suffix mismatch',
  );
});

// ── TC5: path not in spec at all does not throw ──────────────────────────────

await test('TC5: path not in spec at all does not throw', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-001', targetFiles: ['src/bar.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => _validatePathAnchorPreservation(plan, ['src/foo.js']),
    '_validatePathAnchorPreservation should not throw when targetFile is unrelated to any spec path',
  );

  assert.strictEqual(
    plan.subMissions[0].tasks[0].targetFiles[0],
    'src/bar.js',
    'targetFiles[0] should remain unchanged when it has no suffix/case match in spec',
  );
});

// ── TC6: case-mismatch throws with descriptive message ───────────────────────

await test('TC6: case-mismatch throws with descriptive message', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-abc', targetFiles: ['SRC/Foo.JS'], dependencies: [] },
        ],
      },
    ],
  };

  assert.throws(
    () => _validatePathAnchorPreservation(plan, ['src/foo.js']),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(
        err.message.includes('task-abc'),
        `message should include task id "task-abc", got: ${err.message}`,
      );
      assert.ok(
        err.message.includes('SRC/Foo.JS'),
        `message should include emitted path "SRC/Foo.JS", got: ${err.message}`,
      );
      assert.ok(
        err.message.includes('src/foo.js'),
        `message should include spec path "src/foo.js", got: ${err.message}`,
      );
      return true;
    },
    'should throw on case-mismatch with message containing task id, emitted path, spec path',
  );
});

// ── TC7: prefix-mismatch throws (specLower ends with emittedLower) ────────────

await test('TC7: prefix-mismatch throws (spec path is suffix of emitted path)', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-001', targetFiles: ['~/projects/app/index.js'], dependencies: [] },
        ],
      },
    ],
  };

  // specLower = 'index.js', emittedLower = '~/projects/app/index.js'
  // emittedLower.endsWith('/index.js') → true → should throw
  assert.throws(
    () => _validatePathAnchorPreservation(plan, ['index.js']),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(err.message.includes('index.js'), 'message should include spec path');
      return true;
    },
    'should throw when emitted path ends with /specPath',
  );
});

// ── TC8: replan shape {replacementTasks:[...]} throws on violation ────────────

await test('TC8: replan shape {replacementTasks:[...]} throws on violation', async () => {
  const plan = {
    replacementTasks: [
      { id: 't-rp-001', targetFiles: ['helper.js'], dependencies: [] },
    ],
  };

  assert.throws(
    () => _validatePathAnchorPreservation(plan, ['src/utils/helper.js']),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(
        err.message.includes('t-rp-001'),
        `message should include task id "t-rp-001", got: ${err.message}`,
      );
      assert.ok(err.message.includes('helper.js'), 'message should include emitted path');
      assert.ok(
        err.message.includes('src/utils/helper.js'),
        'message should include spec path',
      );
      return true;
    },
    'should throw for replacementTasks shape on suffix mismatch',
  );
});

// ── TC9: component-boundary false-positive guard — no throw when no suffix match

await test('TC9: component-boundary false-positive guard — no throw when no suffix match', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-001', targetFiles: ['src/components/ButtonGroup.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => _validatePathAnchorPreservation(plan, ['src/components/Button.js']),
    'should not throw — ButtonGroup.js does not end with /Button.js',
  );

  assert.strictEqual(
    plan.subMissions[0].tasks[0].targetFiles[0],
    'src/components/ButtonGroup.js',
    'targetFiles[0] should remain "src/components/ButtonGroup.js" — no suffix match for /Button.js',
  );
});

// ── TC10: empty specTargetFiles early-returns without throw ──────────────────

await test('TC10: empty specTargetFiles early-returns without throw', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-001', targetFiles: ['anything.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => _validatePathAnchorPreservation(plan, []),
    'should not throw when specTargetFiles is empty — no spec to enforce',
  );

  assert.doesNotThrow(
    () => _validatePathAnchorPreservation(plan, null),
    'should not throw when specTargetFiles is null',
  );
});

// ── TC11: throw message includes task id, emitted path, and spec path ─────────

await test('TC11: throw message includes task id, emitted path, and spec path', async () => {
  const plan = {
    newTasks: [
      { id: 'my-task-999', targetFiles: ['utils/math.js'], dependencies: [] },
    ],
  };

  let thrownError = null;
  try {
    _validatePathAnchorPreservation(plan, ['src/lib/utils/math.js']);
  } catch (err) {
    thrownError = err;
  }

  assert.ok(thrownError !== null, 'should have thrown an error');
  assert.ok(
    thrownError.message.includes('my-task-999'),
    `error message must contain task id "my-task-999", got: ${thrownError.message}`,
  );
  assert.ok(
    thrownError.message.includes('utils/math.js'),
    `error message must contain emitted path "utils/math.js", got: ${thrownError.message}`,
  );
  assert.ok(
    thrownError.message.includes('src/lib/utils/math.js'),
    `error message must contain spec path "src/lib/utils/math.js", got: ${thrownError.message}`,
  );
});

// ── TC12: paths not in spec inside a plan with other spec files do not throw ──

await test('TC12: unrelated task file among spec files does not throw', async () => {
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          {
            id: 'task-001',
            // 'src/new-feature.js' is not in spec and has no suffix/case match
            targetFiles: ['src/new-feature.js'],
            dependencies: [],
          },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () =>
      _validatePathAnchorPreservation(plan, [
        'src/orchestrator/agents/planner.js',
        'src/orchestrator/agents/executor.js',
      ]),
    'should not throw for a new file that has no relationship to any spec path',
  );
});

// ── TC13: same-file resolution via projectRoot does not throw ────────────────

await test('TC13: same-file resolution via projectRoot does not throw', async () => {
  // Sub-case A: emitted='agents/planner.js', spec='src/orchestrator/agents/planner.js'
  // path.resolve('/project', 'agents/planner.js') !== path.resolve('/project', 'src/orchestrator/agents/planner.js')
  // → still throws even with projectRoot, because they resolve to different files
  const planA = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-001', targetFiles: ['agents/planner.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.throws(
    () => _validatePathAnchorPreservation(planA, ['src/orchestrator/agents/planner.js'], '/project'),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(err.message.includes('agents/planner.js'), 'message should include emitted path');
      assert.ok(
        err.message.includes('src/orchestrator/agents/planner.js'),
        'message should include spec path',
      );
      return true;
    },
    'should still throw when resolved paths differ under projectRoot',
  );

  // Sub-case B: emitted='./agents/planner.js', spec='agents/planner.js'
  // path.resolve('/project', './agents/planner.js') === path.resolve('/project', 'agents/planner.js')
  // → does NOT throw because they resolve to the same absolute file
  const planB = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-001', targetFiles: ['./agents/planner.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => _validatePathAnchorPreservation(planB, ['agents/planner.js'], '/project'),
    'should not throw when emitted and spec resolve to the same file under projectRoot',
  );
});

// ── TC14: genuine violation still throws with projectRoot ────────────────────

await test('TC14: genuine violation still throws with projectRoot', async () => {
  // emitted='utils/helper.js', spec='src/lib/utils/helper.js'
  // path.resolve('/project', 'utils/helper.js') = '/project/utils/helper.js'
  // path.resolve('/project', 'src/lib/utils/helper.js') = '/project/src/lib/utils/helper.js'
  // → NOT equal → still throws
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-001', targetFiles: ['utils/helper.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.throws(
    () => _validatePathAnchorPreservation(plan, ['src/lib/utils/helper.js'], '/project'),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(err.message.includes('utils/helper.js'), 'message should include emitted path');
      assert.ok(
        err.message.includes('src/lib/utils/helper.js'),
        'message should include spec path',
      );
      return true;
    },
    'should still throw when resolved paths differ under projectRoot — genuine violation',
  );
});

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
