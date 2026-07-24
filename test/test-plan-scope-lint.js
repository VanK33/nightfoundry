#!/usr/bin/env node

/**
 * test-plan-scope-lint.js — Pure unit tests for the plan-vs-spec
 * declared-scope lint gate (buildDeclaredSet, lintPlanScope,
 * lintGlobalPlanScope, checkScopeMappingConsistency). No LLM/live SDK
 * calls are made — all fixtures are in-file plain objects.
 *
 * TC1: buildDeclaredSet unions specTargetFiles with the path tokens
 *      extracted from kind='command' acceptance criteria, and skips
 *      non-command (manual / file-check) criteria entirely.
 * TC2: lintPlanScope throws an Error naming the offending task id and path
 *      on a hard excursion in subMissions[].tasks.
 * TC3: lintPlanScope throws the same way on a hard excursion in
 *      replacementTasks and in newTasks (the other two plan shapes).
 * TC4: lintPlanScope does NOT throw when an emitted path matches a declared
 *      path only by case, by suffix, or by projectRoot-resolution — parity
 *      with the planner's path-anchor gate.
 * TC5: F1 regression pin — a partial remediation plan whose newTasks
 *      target a SUBSET of a multi-file declared set does NOT throw. The
 *      blanket "every declared path must be covered by SOMETHING in this
 *      plan" loop that existed in v1 was pure-omission masquerading as
 *      per-mission coverage; remediation plans by construction touch a
 *      subset, so the loop bricked them. Pure omission lives at
 *      lintGlobalPlanScope now.
 * TC6: Per-scoped-check multi-token coverage — an acceptance command
 *      whose path tokens overlap SOME emitted task's targetFiles (so it
 *      gets scoped onto that task) but reference an ADDITIONAL token no
 *      task covers throws naming the uncovered token; the same command
 *      with every token covered passes.
 * TC7: lintGlobalPlanScope — an acceptance command whose path token is
 *      not covered by ANY mission's targetFiles throws; the same
 *      command with a covering mission passes; a milestone-only command
 *      (no path tokens) is silently skipped.
 * TC8: checkScopeMappingConsistency file-vs-mission advisory — an
 *      emitted task whose targetFiles include a path a scope item's text
 *      names for a mapping-DIFFERENT mission produces a warning; the
 *      same setup with the current mission in the mapping does NOT.
 * TC9: checkScopeMappingConsistency shape warnings — inconsistent /
 *      malformed / empty / undefined mappings return warning objects
 *      and never throw.
 *
 * Run: node test/test-plan-scope-lint.js
 */

// This suite is spawned by scripts/run-tests.js, which may itself be invoked
// from inside an active cc-orch run (CC_ORCH_ACTIVE_RUN inherited by child
// processes). None of the functions under test here touch that marker, but
// per the sibling gate-test convention we clear it at module top so the
// suite runs re-entrancy-neutral regardless of launch context.
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'node:assert';
import {
  buildDeclaredSet,
  lintPlanScope,
  lintGlobalPlanScope,
  checkScopeMappingConsistency,
} from '../src/orchestrator/gates/plan-scope-lint.js';
import { extractPathTokens } from '../src/orchestrator/agents/planner.js';

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

// ── TC1: buildDeclaredSet unions target files with command path tokens; ────
// ── skips non-command criteria ──────────────────────────────────────────────

await test('TC1: buildDeclaredSet unions target files with command path tokens; skips non-command criteria', async () => {
  const specTargetFiles = ['src/known.js'];
  const specAcceptanceCriteria = [
    {
      description: 'lints clean',
      verification: { kind: 'command', command: 'node --check src/foo.js' },
    },
    {
      description: 'manual review',
      verification: { kind: 'manual' },
    },
    {
      description: 'file must exist',
      verification: { kind: 'file-check', targetFile: 'src/should-not-appear.js' },
    },
  ];

  const declaredSet = buildDeclaredSet(specTargetFiles, specAcceptanceCriteria);
  assert.ok(declaredSet instanceof Set, 'buildDeclaredSet should return a Set');

  assert.ok(
    declaredSet.has('src/known.js'),
    `declaredSet should include the spec target file, got: ${[...declaredSet]}`,
  );
  assert.ok(
    declaredSet.has('src/foo.js'),
    `declaredSet should include the acceptance-command path token, got: ${[...declaredSet]}`,
  );
  assert.ok(
    !declaredSet.has('src/should-not-appear.js'),
    'declaredSet should NOT include a path from a kind=file-check criterion',
  );
  assert.strictEqual(
    declaredSet.size,
    2,
    `declaredSet should contain exactly the target file and the command token (manual/file-check ` +
    `criteria contribute nothing), got: ${[...declaredSet]}`,
  );
});

// ── TC2: lintPlanScope throws with task id+path on excursion in ────────────
// ── subMissions[].tasks ──────────────────────────────────────────────────────

await test('TC2: lintPlanScope throws with task id+path on excursion in subMissions[].tasks', async () => {
  const declaredSet = new Set(['src/foo.js']);
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-999', targetFiles: ['src/bar.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.throws(
    () => lintPlanScope(plan, declaredSet),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(
        err.message.includes('task-999'),
        `message should include offending task id "task-999", got: ${err.message}`,
      );
      assert.ok(
        err.message.includes('src/bar.js'),
        `message should include offending path "src/bar.js", got: ${err.message}`,
      );
      return true;
    },
    'should throw a hard scope excursion naming task id and path',
  );
});

// ── TC3: lintPlanScope throws on excursion in replacementTasks and in ──────
// ── newTasks ──────────────────────────────────────────────────────────────

await test('TC3: lintPlanScope throws on excursion in replacementTasks and in newTasks', async () => {
  const declaredSet = new Set(['src/foo.js']);

  // replacementTasks shape.
  const planReplacement = {
    replacementTasks: [
      { id: 'task-repl-001', targetFiles: ['src/rogue-replacement.js'], dependencies: [] },
    ],
  };

  assert.throws(
    () => lintPlanScope(planReplacement, declaredSet),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(
        err.message.includes('task-repl-001'),
        `message should include offending task id "task-repl-001", got: ${err.message}`,
      );
      assert.ok(
        err.message.includes('src/rogue-replacement.js'),
        `message should include offending path "src/rogue-replacement.js", got: ${err.message}`,
      );
      return true;
    },
    'should throw a hard scope excursion for replacementTasks naming task id and path',
  );

  // newTasks shape.
  const planNew = {
    newTasks: [
      { id: 'task-new-001', targetFiles: ['src/rogue-new.js'], dependencies: [] },
    ],
  };

  assert.throws(
    () => lintPlanScope(planNew, declaredSet),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(
        err.message.includes('task-new-001'),
        `message should include offending task id "task-new-001", got: ${err.message}`,
      );
      assert.ok(
        err.message.includes('src/rogue-new.js'),
        `message should include offending path "src/rogue-new.js", got: ${err.message}`,
      );
      return true;
    },
    'should throw a hard scope excursion for newTasks naming task id and path',
  );
});

// ── TC4: lintPlanScope no-throw on case/suffix/root-equivalent emitted path ─

await test('TC4: lintPlanScope no-throw on case/suffix/root-equivalent emitted path', async () => {
  // Case-variant: declared path differs only by case from the emitted path.
  const declaredSetCase = new Set(['src/Foo.js']);
  const planCase = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-001', targetFiles: ['SRC/foo.JS'], dependencies: [] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => lintPlanScope(planCase, declaredSetCase),
    'case-variant emitted path equivalent to a declared path should not throw',
  );

  // Suffix-variant: task emits only the filename/suffix while the declared
  // path is the fuller path — same candidate detection used by the
  // planner's path-anchor gate.
  const declaredSetSuffix = new Set(['src/utils/helper.js']);
  const planSuffix = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-002', targetFiles: ['helper.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => lintPlanScope(planSuffix, declaredSetSuffix),
    'suffix-variant emitted path equivalent to a declared path should not throw',
  );

  // projectRoot-resolution-variant: the emitted path is not a case-insensitive
  // exact match nor a literal suffix/prefix of the declared path (so the
  // shared case/suffix candidate detection alone would NOT catch it), but it
  // resolves to the exact same absolute file under opts.projectRoot once
  // "../" segments are collapsed.
  const declaredSetRoot = new Set(['a/b/foo.js']);
  const planRoot = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-003', targetFiles: ['a/x/../b/foo.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => lintPlanScope(planRoot, declaredSetRoot, { projectRoot: '/tmp/fake-project-root' }),
    'projectRoot-resolution-equivalent emitted path should not throw',
  );
});

// ── TC5: F1 regression pin — a partial remediation plan does NOT throw ────
// The v1 blanket "every declared path must be covered by some task in this
// plan" loop bricked remediation and replan (which by construction touch
// a subset of the declared set). Pure omission is lintGlobalPlanScope's
// job now — per-mission emit sites see only their own plan and would
// false-throw on any cross-mission omission.

await test('TC5: F1 regression pin — partial newTasks over a multi-file declared set does NOT throw', async () => {
  const declaredSet = buildDeclaredSet(['src/foo.js', 'src/bar.js'], []);
  assert.strictEqual(declaredSet.size, 2, 'declaredSet should carry both target files');

  const remediationPlan = {
    newTasks: [
      { id: 't1', targetFiles: ['src/foo.js'], dependencies: [] },
    ],
  };

  assert.doesNotThrow(
    () => lintPlanScope(remediationPlan, declaredSet, {
      specTargetFiles: ['src/foo.js', 'src/bar.js'],
      specAcceptanceCriteria: [],
    }),
    'a partial-subset plan (only src/foo.js covered) must not throw — the ' +
    'blanket declared-coverage loop is gone; missing src/bar.js is not an emit-site violation',
  );
});

// ── TC6: Per-scoped-check multi-token coverage ────────────────────────────
// A command that touches both a task's file (test/a.js) AND another spec
// file the task does NOT cover (src/b.js) gets scoped onto the task by
// path-token overlap. Every token in the scoped command must then be
// covered by SOME emitted targetFile; a token no task carries throws
// naming the uncovered token.

await test('TC6: scoped multi-token acceptance command — uncovered token throws; full coverage passes', async () => {
  const specTargetFiles = ['test/a.js', 'src/b.js'];
  const specAcceptanceCriteria = [
    {
      description: 'run a with b',
      verification: { kind: 'command', command: 'node test/a.js --fixture src/b.js' },
    },
  ];
  const declaredSet = buildDeclaredSet(specTargetFiles, specAcceptanceCriteria);

  // Task targets only test/a.js — check gets scoped in via the a.js
  // overlap, then the src/b.js token has no emitted targetFile to
  // resolve into.
  const planUncovered = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-uncov', targetFiles: ['test/a.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.throws(
    () => lintPlanScope(planUncovered, declaredSet, { specTargetFiles, specAcceptanceCriteria }),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(
        err.message.includes('src/b.js'),
        `message should name the uncovered token "src/b.js", got: ${err.message}`,
      );
      return true;
    },
    'a scoped acceptance command with an uncovered token must throw',
  );

  // Same plan with a task covering src/b.js too — every scoped token
  // now resolves, no throw.
  const planCovered = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          {
            id: 'task-cov',
            targetFiles: ['test/a.js', 'src/b.js'],
            dependencies: [],
          },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => lintPlanScope(planCovered, declaredSet, { specTargetFiles, specAcceptanceCriteria }),
    'should not throw when every scoped command token is covered by some task',
  );
});

// ── TC7: lintGlobalPlanScope — pure-omission catcher at planGlobal time ───

await test('TC7: lintGlobalPlanScope — uncovered AC token throws; covering mission passes; milestone-only skipped', async () => {
  // (a) An acceptance command whose token no mission's targetFiles covers
  // → throws naming the command.
  const specTargetFiles = ['src/foo.js', 'test/x.js'];
  const specAcceptanceCriteria = [
    {
      description: 'the x test',
      verification: { kind: 'command', command: 'node test/x.js' },
    },
  ];
  const globalPlanUncovered = {
    milestones: [
      {
        id: '001',
        missions: [
          { id: '001-001', targetFiles: ['src/foo.js'] }, // no test/x.js anywhere
        ],
      },
    ],
  };

  assert.throws(
    () => lintGlobalPlanScope(globalPlanUncovered, specTargetFiles, specAcceptanceCriteria),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(
        err.message.includes('node test/x.js'),
        `message should reference the uncovered command "node test/x.js", got: ${err.message}`,
      );
      return true;
    },
    'lintGlobalPlanScope must throw when a non-milestone-only AC path is covered by no mission',
  );

  // (b) Same command with a mission covering test/x.js → no throw.
  const globalPlanCovered = {
    milestones: [
      {
        id: '001',
        missions: [
          { id: '001-001', targetFiles: ['src/foo.js', 'test/x.js'] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => lintGlobalPlanScope(globalPlanCovered, specTargetFiles, specAcceptanceCriteria),
    'lintGlobalPlanScope must not throw when a mission covers the AC path',
  );

  // (c) A milestone-only acceptance command (no path tokens at all) is
  // silently skipped — it has no per-mission home by design.
  const specAcceptanceCriteriaMilestoneOnly = [
    { description: 'suite', verification: { kind: 'command', command: 'npm test' } },
  ];
  assert.doesNotThrow(
    () => lintGlobalPlanScope(
      { milestones: [{ id: '001', missions: [{ id: '001-001', targetFiles: ['src/foo.js'] }] }] },
      ['src/foo.js'],
      specAcceptanceCriteriaMilestoneOnly,
    ),
    'lintGlobalPlanScope must silently skip milestone-only (no-path-token) AC commands',
  );

  // (d) A plan whose missions declare no targetFiles at all is a no-op —
  // the schema currently makes targetFiles optional at the mission level,
  // and the check has nothing to bind to.
  assert.doesNotThrow(
    () => lintGlobalPlanScope(
      { milestones: [{ id: '001', missions: [{ id: '001-001', description: 'no files' }] }] },
      specTargetFiles,
      specAcceptanceCriteria,
    ),
    'lintGlobalPlanScope must not throw when no mission declares targetFiles',
  );
});

// ── TC8: file-vs-mission advisory ─────────────────────────────────────────

await test('TC8: checkScopeMappingConsistency file-vs-mission advisory — cross-mission target emits a warning; same mission does not', async () => {
  const plan = {
    subMissions: [
      {
        id: '001-001-001',
        tasks: [
          { id: 't1', targetFiles: ['src/x.js'], dependencies: [] },
        ],
      },
    ],
  };
  // scopeItem s1 names src/x.js in its text; mapping puts s1 under a
  // DIFFERENT mission id than the current 001-001. The task's targeting
  // of src/x.js under 001-001 is the mission-boundary crossing.
  const scopeMapping = [
    { scopeItemId: 's1', missionIds: ['001-002'] },
  ];
  const scopeItems = [
    { id: 's1', text: 'the src/x.js edits belong to mission 001-002' },
  ];

  const warningsCross = checkScopeMappingConsistency(plan, scopeMapping, {
    scopeItems,
    currentMissionId: '001-001',
  });
  const fileVsMission = warningsCross.filter((w) =>
    w.description.includes('src/x.js') && w.description.includes('001-002'),
  );
  assert.ok(
    fileVsMission.length >= 1,
    `expected a file-vs-mission warning naming src/x.js and 001-002; got: ${JSON.stringify(warningsCross)}`,
  );

  // Same mission — the mapping assigns s1 to the current mission, so no
  // cross-boundary warning is expected (unrelated shape warnings for the
  // unknown missionId are irrelevant here — this mapping's missionIds
  // now includes '001-001-001', which is a real subMission id).
  const scopeMappingSame = [
    { scopeItemId: 's1', missionIds: ['001-001'] },
  ];
  const warningsSame = checkScopeMappingConsistency(plan, scopeMappingSame, {
    scopeItems,
    currentMissionId: '001-001',
  });
  const fileVsMissionSame = warningsSame.filter((w) =>
    w.description.includes('001-002'),
  );
  assert.strictEqual(
    fileVsMissionSame.length,
    0,
    `expected no file-vs-mission warning when mapping matches current mission; got: ${JSON.stringify(warningsSame)}`,
  );
});

// ── TC9: shape warnings + silent no-op inputs ─────────────────────────────

await test('TC9: checkScopeMappingConsistency returns warnings and never throws on inconsistent/empty/undefined mappings', async () => {
  // Cross-mission (unknown missionId) reference → warning object, no throw.
  const plan = {
    subMissions: [
      { id: 'sm-001', tasks: [] },
    ],
  };
  const crossMissionMapping = [
    { scopeItemId: 'item-1', missionIds: ['sm-999'] },
  ];

  let warnings = null;
  assert.doesNotThrow(() => {
    warnings = checkScopeMappingConsistency(plan, crossMissionMapping);
  }, 'checkScopeMappingConsistency must never throw on a cross-mission entry');
  assert.ok(Array.isArray(warnings), 'should return an array');
  assert.strictEqual(warnings.length, 1, 'should return exactly one warning for the cross-mission entry');
  const warning = warnings[0];
  assert.strictEqual(warning.severity, 'warning', 'warning severity should be "warning"');
  assert.strictEqual(
    warning.category,
    'scope-mapping-consistency',
    'warning category should be "scope-mapping-consistency"',
  );
  assert.ok(
    warning.description.includes('sm-999'),
    `warning description should reference the unknown missionId "sm-999", got: ${warning.description}`,
  );

  // Malformed / inconsistent mapping (non-object entry, missing scopeItemId,
  // duplicate scopeItemId, missing missionIds) → each yields a warning
  // object, never a throw.
  const malformedMapping = [
    null,
    { missionIds: ['sm-001'] }, // missing scopeItemId
    { scopeItemId: 'item-dup', missionIds: ['sm-001'] },
    { scopeItemId: 'item-dup', missionIds: ['sm-001'] }, // duplicate scopeItemId
    { scopeItemId: 'item-no-missions', missionIds: [] }, // empty missionIds
  ];

  let malformedWarnings;
  assert.doesNotThrow(() => {
    malformedWarnings = checkScopeMappingConsistency(plan, malformedMapping);
  }, 'checkScopeMappingConsistency must never throw on malformed entries');
  assert.ok(Array.isArray(malformedWarnings), 'should return an array for malformed mapping');
  assert.ok(
    malformedWarnings.every(
      (w) => w && w.severity === 'warning' && w.category === 'scope-mapping-consistency'
        && typeof w.description === 'string',
    ),
    'every returned warning should be a well-formed { severity, category, description } object',
  );
  assert.ok(
    malformedWarnings.length >= 4,
    `should return a warning for each malformed condition (missing scopeItemId, duplicate, ` +
    `empty missionIds), got ${malformedWarnings.length}: ${JSON.stringify(malformedWarnings)}`,
  );

  // Undefined plan and undefined scopeMapping → empty array, no throw.
  let undefinedWarnings;
  assert.doesNotThrow(() => {
    undefinedWarnings = checkScopeMappingConsistency(undefined, undefined);
  }, 'checkScopeMappingConsistency should not throw for undefined plan/scopeMapping');
  assert.ok(Array.isArray(undefinedWarnings), 'should return an array for undefined inputs');
  assert.strictEqual(undefinedWarnings.length, 0, 'should return no warnings for undefined inputs');

  // Empty plan and empty scopeMapping array → empty array, no throw.
  let emptyWarnings;
  assert.doesNotThrow(() => {
    emptyWarnings = checkScopeMappingConsistency({}, []);
  }, 'checkScopeMappingConsistency should not throw for empty plan/scopeMapping');
  assert.strictEqual(emptyWarnings.length, 0, 'should return no warnings for empty plan/scopeMapping');

  // Additional silent no-op coverage for the sibling exports: empty/absent
  // plan and declaredSet inputs to buildDeclaredSet and lintPlanScope never
  // throw either.
  let declared;
  assert.doesNotThrow(() => {
    declared = buildDeclaredSet(undefined, undefined);
  }, 'buildDeclaredSet should not throw on undefined inputs');
  assert.ok(declared instanceof Set, 'buildDeclaredSet should return a Set even for undefined inputs');
  assert.strictEqual(declared.size, 0, 'declared set should be empty for undefined inputs');

  assert.doesNotThrow(
    () => lintPlanScope({}, new Set()),
    'lintPlanScope should not throw for an empty plan and empty declaredSet',
  );
  assert.doesNotThrow(
    () => lintPlanScope(undefined, undefined),
    'lintPlanScope should not throw for undefined plan and declaredSet',
  );
  assert.doesNotThrow(
    () => lintPlanScope({}, []),
    'lintPlanScope should not throw for an empty plan and an empty array-form declaredSet',
  );

  // lintGlobalPlanScope: empty inputs no-op.
  assert.doesNotThrow(
    () => lintGlobalPlanScope({}, [], []),
    'lintGlobalPlanScope should not throw for an empty plan and empty spec',
  );
  assert.doesNotThrow(
    () => lintGlobalPlanScope(undefined, undefined, undefined),
    'lintGlobalPlanScope should not throw for undefined inputs',
  );
});

// ── TC10-TC17: argv[0] / assignment-token exemption from the per-scoped- ──
// ── check coverage requirement (see _exemptCommandTokens in ────────────────
// ── plan-scope-lint.js). Each case follows the TC6 fixture shape: a ────────
// ── kind='command' specAcceptanceCriteria entry plus a plan whose task's ───
// ── targetFiles overlap one of the command's path tokens so ────────────────
// ── scopeSpecHardChecks scopes the check onto that task, exercising the ────
// ── REAL exported lintPlanScope's coverage loop. ────────────────────────────

await test('TC10: exemption (a) — venv python runner argv[0] is exempt; test file token must still be covered', async () => {
  const specTargetFiles = ['tests/test_adapters.py'];
  const specAcceptanceCriteria = [
    {
      description: 'run adapter tests',
      verification: {
        kind: 'command',
        command: '.venv/bin/python -m pytest tests/test_adapters.py -q',
      },
    },
  ];
  const declaredSet = buildDeclaredSet(specTargetFiles, specAcceptanceCriteria);
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-adapters', targetFiles: ['tests/test_adapters.py'], dependencies: [] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => lintPlanScope(plan, declaredSet, { specTargetFiles, specAcceptanceCriteria }),
    'argv[0] runner ".venv/bin/python" must be exempt from the coverage requirement even ' +
    'though no task targets it, while the covered "tests/test_adapters.py" token satisfies coverage',
  );
});

await test('TC11: exemption (b) — node_modules/.bin jest runner argv[0] is exempt', async () => {
  const specTargetFiles = ['test/x.test.js'];
  const specAcceptanceCriteria = [
    {
      description: 'run jest test',
      verification: {
        kind: 'command',
        command: './node_modules/.bin/jest test/x.test.js',
      },
    },
  ];
  const declaredSet = buildDeclaredSet(specTargetFiles, specAcceptanceCriteria);
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-jest', targetFiles: ['test/x.test.js'], dependencies: [] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => lintPlanScope(plan, declaredSet, { specTargetFiles, specAcceptanceCriteria }),
    'argv[0] runner "./node_modules/.bin/jest" must be exempt while the covered ' +
    '"test/x.test.js" token satisfies coverage',
  );
});

await test('TC12: exemption (c) — compound command via && exempts the post-connector segment argv[0]', async () => {
  const specTargetFiles = ['tests/y.py'];
  const specAcceptanceCriteria = [
    {
      description: 'cd then run pytest',
      verification: {
        kind: 'command',
        command: 'cd tools && .venv/bin/python -m pytest tests/y.py',
      },
    },
  ];
  const declaredSet = buildDeclaredSet(specTargetFiles, specAcceptanceCriteria);
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-compound', targetFiles: ['tests/y.py'], dependencies: [] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => lintPlanScope(plan, declaredSet, { specTargetFiles, specAcceptanceCriteria }),
    'the segment argv[0] ".venv/bin/python" following the "&&" connector must be exempt ' +
    'while the covered "tests/y.py" token satisfies coverage',
  );
});

await test('TC13: exemption (d) — leading env-assignment (slashless value) is skipped when locating argv[0]', async () => {
  const specTargetFiles = ['tests/y.py'];
  const specAcceptanceCriteria = [
    {
      description: 'env-prefixed pytest run',
      verification: {
        kind: 'command',
        command: 'PYTHONPATH=src .venv/bin/python -m pytest tests/y.py',
      },
    },
  ];
  const declaredSet = buildDeclaredSet(specTargetFiles, specAcceptanceCriteria);
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-env', targetFiles: ['tests/y.py'], dependencies: [] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => lintPlanScope(plan, declaredSet, { specTargetFiles, specAcceptanceCriteria }),
    'the leading "PYTHONPATH=src" assignment must be skipped when locating argv[0], leaving ' +
    '".venv/bin/python" as the exempt argv[0]; "tests/y.py" satisfies coverage',
  );
});

await test('TC14: exemption (d2) — leading env-assignment with a path-like (slash-bearing) value is itself exempt', async () => {
  const specTargetFiles = ['tests/y.py'];
  const specAcceptanceCriteria = [
    {
      description: 'env-prefixed pytest run, path-like assignment value',
      verification: {
        kind: 'command',
        command: 'PYTHONPATH=src/lib .venv/bin/python -m pytest tests/y.py',
      },
    },
  ];
  const declaredSet = buildDeclaredSet(specTargetFiles, specAcceptanceCriteria);
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-env-slash', targetFiles: ['tests/y.py'], dependencies: [] },
        ],
      },
    ],
  };

  assert.doesNotThrow(
    () => lintPlanScope(plan, declaredSet, { specTargetFiles, specAcceptanceCriteria }),
    'the assignment token "PYTHONPATH=src/lib" is itself exempt as an assignment token even ' +
    'though it is path-like; ".venv/bin/python" is the exempt argv[0]; "tests/y.py" satisfies coverage',
  );
});

await test('TC15: NEGATIVE (e) — plain pytest argv[0] is not path-like; an uncovered trailing test file still throws', async () => {
  const specTargetFiles = ['tests/a.py'];
  const specAcceptanceCriteria = [
    {
      description: 'run two pytest files',
      verification: {
        kind: 'command',
        command: 'pytest tests/a.py tests/b.py',
      },
    },
  ];
  const declaredSet = buildDeclaredSet(specTargetFiles, specAcceptanceCriteria);
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-partial', targetFiles: ['tests/a.py'], dependencies: [] },
        ],
      },
    ],
  };

  assert.throws(
    () => lintPlanScope(plan, declaredSet, { specTargetFiles, specAcceptanceCriteria }),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(
        err.message.includes('tests/b.py'),
        `message should name the uncovered token "tests/b.py", got: ${err.message}`,
      );
      return true;
    },
    'the uncovered non-exempt "tests/b.py" token must still throw even though "tests/a.py" is covered',
  );
});

await test('TC16: NEGATIVE (f) — a venv-python path in ARGUMENT position (not argv[0]) is not exempt', async () => {
  const specTargetFiles = ['tests/a.py'];
  const specAcceptanceCriteria = [
    {
      description: 'pytest with a venv path as a trailing argument',
      verification: {
        kind: 'command',
        command: 'pytest tests/a.py .venv/bin/python',
      },
    },
  ];
  const declaredSet = buildDeclaredSet(specTargetFiles, specAcceptanceCriteria);
  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 'task-positional', targetFiles: ['tests/a.py'], dependencies: [] },
        ],
      },
    ],
  };

  assert.throws(
    () => lintPlanScope(plan, declaredSet, { specTargetFiles, specAcceptanceCriteria }),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(
        err.message.includes('.venv/bin/python'),
        `message should name the uncovered token ".venv/bin/python", got: ${err.message}`,
      );
      return true;
    },
    'the exemption is positional (argv[0] only), not a blanket exemption for the ' +
    '".venv/bin/python" string appearing anywhere in the command; here it is a trailing ' +
    'argument, not argv[0], and must still throw',
  );
});

await test('TC17: SHARED-EXTRACTOR PIN (g) — extractPathTokens still returns ".venv/bin/python"; the exemption lives in the lint, not the extractor', async () => {
  const tokens = extractPathTokens('.venv/bin/python -m pytest tests/y.py');
  assert.ok(
    tokens.includes('.venv/bin/python'),
    `extractPathTokens should still include ".venv/bin/python" among its path-like tokens, got: ${JSON.stringify(tokens)}`,
  );
});

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
