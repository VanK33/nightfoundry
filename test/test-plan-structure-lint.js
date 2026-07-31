#!/usr/bin/env node

/**
 * test-plan-structure-lint.js — Pure unit tests for the plan-time
 * structural lint gate (gates/plan-structure-lint.js: lintPlanStructure,
 * lintTaskCheckShapes, warnCrossMissionDuplicates) and the sibling
 * spec-reader readSpecPlanStructure (core/spec-text.js). No LLM/live SDK
 * calls are made — all fixtures are in-file plain objects (plus small,
 * self-cleaning temp-dir fixtures for readSpecPlanStructure's json-read
 * legs).
 *
 * TC1: lintPlanStructure L1/L2 — mission-count / milestone-count leg
 *      violations throw an Error prefixed '[plan-structure-lint]' naming
 *      max_missions/max_milestones; an absent or malformed
 *      specPlanStructure skips L1/L2 entirely (no throw), even when the
 *      plan's actual counts would otherwise exceed a would-be limit.
 * TC2: lintPlanStructure L3 (unconditional) — two different missions in
 *      the SAME milestone declaring path-equivalent targetFiles throws;
 *      the same duplication across DIFFERENT milestones does not; the
 *      scripts/run-tests.js path is exempt from L3; a projectRoot-resolved-
 *      equivalent pair throws, but a suffix-only pair (incl. a standard
 *      Python pkg/__init__.py vs tests/pkg/__init__.py layout) does NOT —
 *      L3 uses strict same-file equality (exact or path.resolve), not the
 *      planner's looser suffix-matching path-anchor notion.
 * TC3: lintTaskCheckShapes T1 — a modification-status predicate
 *      co-occurring with a non-own dot-extension path token throws (both
 *      the canonical "unchanged" fixture and an out-of-target "not
 *      modified" fixture); the extension guard (no path-like token) and
 *      the two-token content-qualifier window ("bytes") both pass without
 *      needing a behavioral marker; a behavioral-marker fixture passes via
 *      exemption 1.
 * TC4: lintTaskCheckShapes T2 — literal tree-state shapes throw
 *      regardless of targetFile membership ("only X modified" even when X
 *      IS in-target; "no test files"; bare git-status/working-tree
 *      cleanliness assertions); the backtick-literal exemption strips a
 *      tree-state phrase entirely enclosed in a matched backtick pair
 *      (pass); quote characters never open an exemption span (still
 *      throws); an unpaired ("stray") backtick opens no span, fail-closed
 *      (still throws); backticks wrapped around the bare predicate word
 *      alone DO exempt that occurrence — the disclosed KNOWN-ESCAPE (pass);
 *      two pinned measured non-triggers (arrow / "returns" phrasing) pass.
 * TC5: KNOWN-ESCAPE marker pins — a T1 shape co-occurring with a
 *      genuine "passes" behavioral-marker match escapes via exemption 1;
 *      a T2 "no other file modified" shape co-occurring with a genuine
 *      "throw" behavioral-marker match escapes the same way. Both are
 *      PASSING escapes by design (the gate's documented interim-defense
 *      posture), not bugs to "fix" here.
 * TC6: warnCrossMissionDuplicates — a same-milestone sibling targetFile
 *      hit returns a { severity, category: 'cross-mission-duplicate',
 *      description } warning naming both missions and the path, and does
 *      NOT throw; scripts/run-tests.js is exempt (no warning); an empty or
 *      absent sibling map returns an empty array; malformed plan/map
 *      inputs never throw and yield an array.
 * TC7: newTasks-shape traversal — lintTaskCheckShapes also walks
 *      plan.newTasks[] (the remediation/replan plan shape), throwing on a
 *      T2 tree-purity check shape there exactly as it does for
 *      subMissions[].tasks.
 * TC8: readSpecPlanStructure's fail-soft contract — a falsy prdPath
 *      returns {} with no fs access; a present plan_structure section is
 *      returned verbatim; a spec.json parse error returns {}; a spec.json
 *      lacking the plan_structure key returns {}. None of the four legs
 *      throw.
 * TC9: planMission wiring — lintPlanStructure/lintTaskCheckShapes run
 *      UNCONDITIONALLY inside Planner._planMissionReusable, outside the
 *      buildDeclaredSet(...).size > 0 guard that gates lintPlanScope: a
 *      spec-less context (no specTargetFiles/specAcceptanceCriteria, so the
 *      declaredSet guard is closed) still throws a
 *      '[plan-structure-lint]'-prefixed error when the planted plan carries
 *      a T2 tree-purity check shape (planner's sessionManager is stubbed;
 *      the reusable-session technique mirrors
 *      test-plan-scope-lint-wiring.js's TC1).
 * TC10: Pipeline._recordScopeMappingWarnings' ledger-category ternary, both
 *      directions — a warning carrying category 'cross-mission-duplicate'
 *      is written to archives/warnings.jsonl with that category verbatim;
 *      a warning carrying any other (or absent) category collapses to
 *      'plan-scope'.
 * TC11: the specPlanStructure cache (this._specPlanStructureCache) is one of
 *      the caches Pipeline._repointHarness busts: primed from one harness
 *      dir's spec.json, the cache reads back undefined immediately after
 *      _repointHarness(), and a subsequent _getSpecPlanStructure() call
 *      reflects the NEW harness dir's spec.json rather than the stale
 *      pre-repoint value.
 * TC12: dryRunValidate → planner.planGlobal → lintPlanStructure wiring — a
 *      dry-run against a fixture spec declaring plan_structure.max_missions:1
 *      is rejected with a '[plan-structure-lint]'-prefixed Error when the
 *      (stubbed) planner sessionManager resolves a 2-mission global plan;
 *      no queue/{slug}/ entry is written. The stub replaces
 *      planner.sessionManager (never planner.planGlobal itself), so the
 *      real planGlobal method — and its specPlanStructure wiring from both
 *      dryRunValidate's and run()'s _getSpecPlanStructure() call sites —
 *      is what's under test.
 *
 * Run: node test/test-plan-structure-lint.js
 */

// This suite is spawned by scripts/run-tests.js, which may itself be invoked
// from inside an active cc-orch run (CC_ORCH_ACTIVE_RUN inherited by child
// processes). None of the functions under test here touch that marker, but
// per the sibling gate-test convention we clear it at module top so the
// suite runs re-entrancy-neutral regardless of launch context.
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  lintPlanStructure,
  lintTaskCheckShapes,
  warnCrossMissionDuplicates,
} from '../src/orchestrator/gates/plan-structure-lint.js';
import { readSpecPlanStructure } from '../src/orchestrator/core/spec-text.js';
import { Planner } from '../src/orchestrator/agents/planner.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';
import { readLedger } from '../src/orchestrator/core/warnings-ledger.js';

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

/** Builds a task carrying a single testCase string for lintTaskCheckShapes fixtures. */
function taskWith(id, targetFiles, testCase) {
  return { id, targetFiles, testCases: [testCase] };
}

// ── TC1: lintPlanStructure L1/L2 leg-count violations throw; absent/ ───────
// ── malformed specPlanStructure skips L1/L2 entirely ───────────────────────

await test('TC1: lintPlanStructure L1/L2 leg-count violations throw prefixed [plan-structure-lint]; absent/malformed spec skips L1/L2', async () => {
  // L1 — mission count exceeds spec-declared max_missions (flattened
  // missions[] fixture shape).
  const overMissionPlan = {
    missions: [
      { id: 'm1', targetFiles: [] },
      { id: 'm2', targetFiles: [] },
    ],
  };
  assert.throws(
    () => lintPlanStructure(overMissionPlan, { max_missions: 1 }),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(
        err.message.startsWith('[plan-structure-lint]'),
        `message should be prefixed '[plan-structure-lint]', got: ${err.message}`,
      );
      assert.ok(
        err.message.includes('max_missions'),
        `message should name max_missions, got: ${err.message}`,
      );
      return true;
    },
    'mission count exceeding spec-declared max_missions should throw',
  );

  // L2 — milestone count exceeds spec-declared max_milestones (canonical
  // milestones[].missions[] fixture shape).
  const overMilestonePlan = {
    milestones: [
      { missions: [{ id: 'm1', targetFiles: [] }] },
      { missions: [{ id: 'm2', targetFiles: [] }] },
    ],
  };
  assert.throws(
    () => lintPlanStructure(overMilestonePlan, { max_milestones: 1 }),
    (err) => {
      assert.ok(err instanceof Error, 'should be an Error instance');
      assert.ok(
        err.message.startsWith('[plan-structure-lint]'),
        `message should be prefixed '[plan-structure-lint]', got: ${err.message}`,
      );
      assert.ok(
        err.message.includes('max_milestones'),
        `message should name max_milestones, got: ${err.message}`,
      );
      return true;
    },
    'milestone count exceeding spec-declared max_milestones should throw',
  );

  // Absent specPlanStructure → L1/L2 skipped entirely, even though the
  // plan above would exceed a would-be max_missions=1 limit.
  assert.doesNotThrow(
    () => lintPlanStructure(overMissionPlan, undefined),
    'an absent specPlanStructure must skip L1/L2 entirely, no throw',
  );

  // Malformed specPlanStructure (non-integer max_missions) → L1/L2 skipped.
  assert.doesNotThrow(
    () => lintPlanStructure(overMissionPlan, { max_missions: '1' }),
    'a malformed (non-integer) max_missions must skip L1, no throw',
  );

  // Malformed specPlanStructure (not a plain object) → L1/L2 skipped.
  assert.doesNotThrow(
    () => lintPlanStructure(overMissionPlan, 'not-an-object'),
    'a non-plain-object specPlanStructure must skip L1/L2, no throw',
  );
});

// ── TC2: lintPlanStructure L3 declared-duplicate (unconditional) ──────────

await test('TC2: lintPlanStructure L3 same-milestone declared-duplicate throws; cross-milestone/run-tests.js/path-equivalent variants', async () => {
  // Same-milestone duplicate targetFile across two missions → throw.
  assert.throws(
    () => lintPlanStructure(
      { missions: [{ id: 'm1', targetFiles: ['a.js'] }, { id: 'm2', targetFiles: ['a.js'] }] },
      {},
    ),
    (err) => {
      assert.ok(err.message.startsWith('[plan-structure-lint]'), `should be prefixed, got: ${err.message}`);
      assert.ok(err.message.includes('m1') && err.message.includes('m2') && err.message.includes('a.js'),
        `message should name both missions and the path, got: ${err.message}`);
      return true;
    },
    'two different missions in the same milestone declaring the same targetFile should throw',
  );

  // Cross-milestone duplicate is legal — different milestone groups are
  // checked independently.
  assert.doesNotThrow(
    () => lintPlanStructure(
      {
        milestones: [
          { missions: [{ id: 'm1', targetFiles: ['a.js'] }] },
          { missions: [{ id: 'm2', targetFiles: ['a.js'] }] },
        ],
      },
      {},
    ),
    'the same targetFile declared by missions in DIFFERENT milestones must not throw',
  );

  // scripts/run-tests.js is exempt from L3 even when shared same-milestone.
  assert.doesNotThrow(
    () => lintPlanStructure(
      {
        missions: [
          { id: 'm1', targetFiles: ['scripts/run-tests.js'] },
          { id: 'm2', targetFiles: ['scripts/run-tests.js'] },
        ],
      },
      {},
    ),
    'scripts/run-tests.js shared same-milestone across missions must be exempt, no throw',
  );

  // Suffix-only pair (one path is a tail of the other) → NO throw. These are
  // DIFFERENT files (src/utils/helper.js vs a root helper.js), not duplicates.
  // L3 uses strict same-file equality (exact or path.resolve), not suffix.
  assert.doesNotThrow(
    () => lintPlanStructure(
      {
        missions: [
          { id: 'm1', targetFiles: ['src/utils/helper.js'] },
          { id: 'm2', targetFiles: ['helper.js'] },
        ],
      },
      {},
    ),
    'a suffix-only targetFile pair (different files) must NOT be flagged as a duplicate',
  );

  // Standard Python package layout: pkg/__init__.py and tests/pkg/__init__.py
  // share a suffix but are different files → NO throw (the regression this
  // strict-equality change fixes).
  assert.doesNotThrow(
    () => lintPlanStructure(
      {
        missions: [
          { id: 'm1', targetFiles: ['pkg/__init__.py'] },
          { id: 'm2', targetFiles: ['tests/pkg/__init__.py'] },
        ],
      },
      {},
      { projectRoot: '/tmp/fake-plan-structure-lint-root' },
    ),
    'a standard Python package/test __init__.py pair must NOT be flagged as a duplicate',
  );

  // projectRoot-resolved-equivalent pair (relative paths collapsing to the
  // same absolute file) → throw.
  assert.throws(
    () => lintPlanStructure(
      {
        missions: [
          { id: 'm1', targetFiles: ['a/b/foo.js'] },
          { id: 'm2', targetFiles: ['a/x/../b/foo.js'] },
        ],
      },
      {},
      { projectRoot: '/tmp/fake-plan-structure-lint-root' },
    ),
    (err) => err.message.startsWith('[plan-structure-lint]'),
    'a projectRoot-resolved-equivalent targetFile pair should throw',
  );
});

// ── TC3: lintTaskCheckShapes T1 — modification-status predicate + ─────────
// ── non-own dot-extension token; extension guard / content-qualifier / ────
// ── behavioral-marker passes ───────────────────────────────────────────────

await test('TC3: lintTaskCheckShapes T1 throws on a qualifying predicate + non-own path token; passes on the extension/content-qualifier/marker exemptions', async () => {
  // Canonical killer: "unchanged" predicate + two non-own dot-extension
  // tokens (config.yaml, config_ibkr.yaml) vs targetFiles ['config.yaml.example'].
  const planCanonical = {
    subMissions: [{
      id: 'sm1',
      tasks: [taskWith('t1', ['config.yaml.example'], 'config.yaml and config_ibkr.yaml are unchanged')],
    }],
  };
  assert.throws(
    () => lintTaskCheckShapes(planCanonical),
    (err) => {
      assert.ok(err.message.startsWith('[plan-structure-lint]'), `should be prefixed, got: ${err.message}`);
      assert.ok(err.message.includes('t1'), `message should name task "t1", got: ${err.message}`);
      return true;
    },
    'canonical T1 fixture (unchanged + non-own extension tokens) should throw',
  );

  // Out-of-target "not modified" fixture.
  const planNotModified = {
    subMissions: [{
      id: 'sm1',
      tasks: [taskWith('t2', ['src/other.js'], 'planner.js is not modified')],
    }],
  };
  assert.throws(
    () => lintTaskCheckShapes(planNotModified),
    (err) => err.message.startsWith('[plan-structure-lint]'),
    '"planner.js is not modified" with planner.js out of targetFiles should throw',
  );

  // Extension guard: no path-like (dot-extension) token present at all →
  // no T1 violation regardless of the qualifying predicate.
  const planExtGuard = {
    subMissions: [{
      id: 'sm1',
      tasks: [taskWith('t3', ['config.yaml.example'], 'try/catch/finally unchanged')],
    }],
  };
  assert.doesNotThrow(
    () => lintTaskCheckShapes(planExtGuard),
    '"try/catch/finally unchanged" carries no path-like token, must pass via the extension guard',
  );

  // Two-token content-qualifier window: "bytes" sits within the two tokens
  // preceding "unchanged" → the predicate is disqualified before any
  // path-token check runs.
  const planContentQualifier = {
    subMissions: [{
      id: 'sm1',
      tasks: [taskWith('t4', ['config.yaml.example'], 'state.json bytes unchanged')],
    }],
  };
  assert.doesNotThrow(
    () => lintTaskCheckShapes(planContentQualifier),
    '"state.json bytes unchanged" should pass via the content-qualifier window ("bytes")',
  );

  // Behavioral-marker exemption 1: "passes" exempts the whole testCase even
  // though "unchanged" also appears in it.
  const planMarker = {
    subMissions: [{
      id: 'sm1',
      tasks: [taskWith('t5', ['config.yaml.example'],
        'node test/test-reviewer-contract.js passes (existing TC1-TC12 unchanged)')],
    }],
  };
  assert.doesNotThrow(
    () => lintTaskCheckShapes(planMarker),
    'a testCase carrying the behavioral marker "passes" should be exempt (pass) despite "unchanged"',
  );
});

// ── TC4: lintTaskCheckShapes T2 — literal tree-state shapes (unconditional ─
// ── of targetFile membership); backtick / quote / stray-backtick exemption ─
// ── boundary; pinned non-triggers ──────────────────────────────────────────

await test('TC4: lintTaskCheckShapes T2 throws on literal tree-state shapes even in-target; backtick-only exemption boundary; pinned non-triggers pass', async () => {
  // "only X modified" throws even though X IS in the task's own targetFiles
  // — T2 is checked unconditionally of targetFile membership.
  const planOnlyModified = {
    subMissions: [{
      id: 'sm1',
      tasks: [taskWith('t1', ['config.yaml.example'], 'only config.yaml.example modified')],
    }],
  };
  assert.throws(
    () => lintTaskCheckShapes(planOnlyModified),
    (err) => err.message.startsWith('[plan-structure-lint]') && err.message.includes('T2'),
    '"only config.yaml.example modified" must throw even though the file is in-target',
  );

  // "no test files" throws.
  assert.throws(
    () => lintTaskCheckShapes({
      subMissions: [{ id: 'sm1', tasks: [taskWith('t2', ['a.js'], 'no test files')] }],
    }),
    (err) => err.message.startsWith('[plan-structure-lint]'),
    '"no test files" must throw',
  );

  // Bare git-status/working-tree cleanliness assertion throws.
  assert.throws(
    () => lintTaskCheckShapes({
      subMissions: [{ id: 'sm1', tasks: [taskWith('t3', ['a.js'], 'git status is clean')] }],
    }),
    (err) => err.message.startsWith('[plan-structure-lint]'),
    'a bare "git status is clean" assertion must throw',
  );
  assert.throws(
    () => lintTaskCheckShapes({
      subMissions: [{ id: 'sm1', tasks: [taskWith('t4', ['a.js'], 'the working tree is dirty')] }],
    }),
    (err) => err.message.startsWith('[plan-structure-lint]'),
    'a bare "working tree is dirty" assertion must throw',
  );

  // Backtick-literal exemption: a grep-for-message TC whose tree-state
  // words all sit inside a matched backtick pair passes (no behavioral
  // marker present here — this exercises exemption 2 specifically).
  assert.doesNotThrow(
    () => lintTaskCheckShapes({
      subMissions: [{
        id: 'sm1',
        tasks: [taskWith('t5', ['a.js'],
          'the failure message contains the exact text `only config.yaml modified`')],
      }],
    }),
    'a tree-state phrase strictly inside a matched backtick pair should be exempt (pass)',
  );

  // The canonical killer with emphasis quotes around its predicate — quote
  // characters never open an exemption span, so this STILL throws.
  assert.throws(
    () => lintTaskCheckShapes({
      subMissions: [{
        id: 'sm1',
        tasks: [taskWith('t6', ['config.yaml.example'],
          'config.yaml and config_ibkr.yaml are "unchanged"')],
      }],
    }),
    (err) => err.message.startsWith('[plan-structure-lint]'),
    'quote characters must never open an exemption span — still throws',
  );

  // The canonical killer with a single STRAY backtick — unpaired backticks
  // open no span (fail-closed), so this STILL throws.
  assert.throws(
    () => lintTaskCheckShapes({
      subMissions: [{
        id: 'sm1',
        tasks: [taskWith('t7', ['config.yaml.example'],
          'config.yaml and config_ibkr.yaml are `unchanged')],
      }],
    }),
    (err) => err.message.startsWith('[plan-structure-lint]'),
    'an unpaired (stray) backtick must open no exemption span — still throws',
  );

  // The canonical killer with backticks around the BARE predicate word
  // alone — the disclosed KNOWN-ESCAPE — passes.
  assert.doesNotThrow(
    () => lintTaskCheckShapes({
      subMissions: [{
        id: 'sm1',
        tasks: [taskWith('t8', ['config.yaml.example'],
          'config.yaml and config_ibkr.yaml are `unchanged`')],
      }],
    }),
    'DISCLOSED KNOWN-ESCAPE: backticks wrapped around the bare predicate word alone exempt it (pass)',
  );

  // Pinned measured non-triggers.
  assert.doesNotThrow(
    () => lintTaskCheckShapes({
      subMissions: [{
        id: 'sm1',
        tasks: [taskWith('t9', ['a.js'],
          'gitGuard returns { ok: false, reason: dirty-tree } for dirty working tree')],
      }],
    }),
    'gitGuard-returns fixture is a pinned non-trigger (behavioral marker "returns") — pass',
  );
  assert.doesNotThrow(
    () => lintTaskCheckShapes({
      subMissions: [{
        id: 'sm1',
        tasks: [taskWith('t10', ['a.js'], 'Clean tree \u2192 createParkSnapshot returns null')],
      }],
    }),
    'Clean-tree arrow fixture is a pinned non-trigger (arrow marker) — pass',
  );
});

// ── TC5: KNOWN-ESCAPE marker pins — genuine marker matches escape ─────────
// ── co-occurring tree-purity shapes (accepted design, not a bug) ──────────

await test('TC5: KNOWN-ESCAPE pins — a genuine "passes" marker escapes a T1 shape; a genuine "throw" marker escapes a T2 shape', async () => {
  // "passes" (a genuine behavioral-marker match) co-occurring with the T1
  // "unmodified" predicate escapes detection by construction.
  assert.doesNotThrow(
    () => lintTaskCheckShapes({
      subMissions: [{
        id: 'sm1',
        tasks: [taskWith('t1', ['a.js'],
          'Existing pins in b.js must remain passing; the suite still passes, UNMODIFIED')],
      }],
    }),
    'KNOWN-ESCAPE: a testCase carrying a genuine "passes" marker match must pass, even though ' +
    'it also carries the T1 "UNMODIFIED" predicate — this is the accepted marker-exemption escape',
  );

  // "throw" (a genuine behavioral-marker match, singular noun) co-occurring
  // with the T2 "no other file modified" shape escapes the same way.
  assert.doesNotThrow(
    () => lintTaskCheckShapes({
      subMissions: [{
        id: 'sm1',
        tasks: [taskWith('t2', ['a.js'], 'the single throw statement in pipeline.js; no other file modified')],
      }],
    }),
    'KNOWN-ESCAPE: a testCase carrying the noun "throw" (behavioral-marker match) must pass, ' +
    'even though it also carries the T2 "no other file modified" shape',
  );
});

// ── TC6: warnCrossMissionDuplicates — array-returning, never-throwing ─────
// ── WARN-level observer ────────────────────────────────────────────────────

await test('TC6: warnCrossMissionDuplicates returns an array and never throws, on both valid and malformed input', async () => {
  const plan = {
    subMissions: [{ id: 'sm1', tasks: [{ id: 't1', targetFiles: ['a.js'] }] }],
  };

  // Sibling map hit → a warning naming both missions and the path; no throw.
  const warnings = warnCrossMissionDuplicates(plan, { m2: ['a.js'] }, { missionId: 'm1' });
  assert.ok(Array.isArray(warnings), 'should return an array');
  assert.strictEqual(warnings.length, 1, 'should return exactly one warning for the sibling hit');
  assert.strictEqual(warnings[0].severity, 'warning', 'warning severity should be "warning"');
  assert.strictEqual(
    warnings[0].category,
    'cross-mission-duplicate',
    'warning category should be "cross-mission-duplicate"',
  );
  assert.ok(warnings[0].description.includes('m1'), `description should name mission "m1", got: ${warnings[0].description}`);
  assert.ok(warnings[0].description.includes('m2'), `description should name mission "m2", got: ${warnings[0].description}`);
  assert.ok(warnings[0].description.includes('a.js'), `description should name path "a.js", got: ${warnings[0].description}`);

  // scripts/run-tests.js is exempt — no warning even on a sibling hit.
  const planRunTests = {
    subMissions: [{ id: 'sm1', tasks: [{ id: 't1', targetFiles: ['scripts/run-tests.js'] }] }],
  };
  const warningsExempt = warnCrossMissionDuplicates(planRunTests, { m2: ['scripts/run-tests.js'] }, { missionId: 'm1' });
  assert.ok(Array.isArray(warningsExempt), 'should return an array');
  assert.strictEqual(warningsExempt.length, 0, 'scripts/run-tests.js should be exempt from cross-mission-duplicate warnings');

  // Empty sibling map → empty array, no throw.
  assert.doesNotThrow(() => {
    const w = warnCrossMissionDuplicates(plan, {}, { missionId: 'm1' });
    assert.ok(Array.isArray(w) && w.length === 0, 'empty sibling map should yield an empty array');
  }, 'warnCrossMissionDuplicates should not throw for an empty sibling map');

  // Absent sibling map → empty array, no throw.
  assert.doesNotThrow(() => {
    const w = warnCrossMissionDuplicates(plan, undefined, { missionId: 'm1' });
    assert.ok(Array.isArray(w) && w.length === 0, 'absent sibling map should yield an empty array');
  }, 'warnCrossMissionDuplicates should not throw for an absent sibling map');

  // Malformed plan/map inputs → never throw, always returns an array.
  assert.doesNotThrow(() => {
    const w = warnCrossMissionDuplicates(null, 'not-an-object', {});
    assert.ok(Array.isArray(w), 'should return an array even for null plan / non-object map');
  }, 'warnCrossMissionDuplicates should not throw on a null plan and a non-object sibling map');
  assert.doesNotThrow(() => {
    const w = warnCrossMissionDuplicates(undefined, undefined, undefined);
    assert.ok(Array.isArray(w) && w.length === 0, 'should return an empty array for fully undefined input');
  }, 'warnCrossMissionDuplicates should not throw for fully undefined input');
  assert.doesNotThrow(() => {
    const w = warnCrossMissionDuplicates({ subMissions: 'not-an-array' }, { m2: 'not-an-array' }, {});
    assert.ok(Array.isArray(w), 'should return an array even for malformed subMissions/sibling-target shapes');
  }, 'warnCrossMissionDuplicates should not throw on malformed subMissions/sibling-target shapes');
});

// ── TC7: newTasks-shape traversal — lintTaskCheckShapes also walks ────────
// ── plan.newTasks[] (the remediation/replan plan shape) ────────────────────

await test('TC7: lintTaskCheckShapes throws on a tree-purity shape inside plan.newTasks[] (remediation plan shape)', async () => {
  const remediationPlan = {
    newTasks: [taskWith('t-remediate-001', ['a.js'], 'no test files')],
  };
  assert.throws(
    () => lintTaskCheckShapes(remediationPlan),
    (err) => {
      assert.ok(err.message.startsWith('[plan-structure-lint]'), `should be prefixed, got: ${err.message}`);
      assert.ok(err.message.includes('t-remediate-001'), `should name the task, got: ${err.message}`);
      return true;
    },
    'a T2 tree-purity shape inside plan.newTasks[] must throw, same as subMissions[].tasks',
  );
});

// ── TC8: readSpecPlanStructure fail-soft contract ─────────────────────────

function mkTmpSpecDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-structure-lint-spec-'));
}

await test('TC8: readSpecPlanStructure fail-soft legs — falsy prdPath / present section / parse error / absent section', async () => {
  // Falsy prdPath → {} with no fs access, never throws.
  assert.doesNotThrow(() => {
    const result = readSpecPlanStructure('', '/tmp');
    assert.deepStrictEqual(result, {}, 'a falsy (empty-string) prdPath should return {}');
  }, 'readSpecPlanStructure should not throw on a falsy prdPath');
  assert.doesNotThrow(() => {
    const result = readSpecPlanStructure(undefined, '/tmp');
    assert.deepStrictEqual(result, {}, 'an undefined prdPath should return {}');
  }, 'readSpecPlanStructure should not throw on an undefined prdPath');

  const dir = mkTmpSpecDir();
  try {
    const prdPath = path.join(dir, 'spec.md');
    fs.writeFileSync(prdPath, '# spec\n');
    const specJsonPath = path.join(dir, 'spec.json');

    // Present section → returned verbatim.
    fs.writeFileSync(specJsonPath, JSON.stringify({ plan_structure: { max_missions: 2, max_milestones: 1 } }));
    assert.doesNotThrow(() => {
      const result = readSpecPlanStructure(prdPath, dir);
      assert.deepStrictEqual(
        result,
        { max_missions: 2, max_milestones: 1 },
        `present plan_structure section should be returned verbatim, got: ${JSON.stringify(result)}`,
      );
    }, 'readSpecPlanStructure should not throw when plan_structure is present');

    // Parse error → {}.
    fs.writeFileSync(specJsonPath, '{ this is not valid json');
    assert.doesNotThrow(() => {
      const result = readSpecPlanStructure(prdPath, dir);
      assert.deepStrictEqual(result, {}, 'a spec.json parse error should yield {}');
    }, 'readSpecPlanStructure should not throw on a spec.json parse error');

    // Absent section (valid json, no plan_structure key) → {}.
    fs.writeFileSync(specJsonPath, JSON.stringify({ goal: 'no plan_structure here' }));
    assert.doesNotThrow(() => {
      const result = readSpecPlanStructure(prdPath, dir);
      assert.deepStrictEqual(result, {}, 'an absent plan_structure key should yield {}');
    }, 'readSpecPlanStructure should not throw when plan_structure is absent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── TC9: planMission wiring — lintPlanStructure/lintTaskCheckShapes ───────
// ── run UNCONDITIONALLY, outside the declaredSet guard ────────────────────

/**
 * Fake reusable-session-capable sessionManager whose spawnReusable()
 * resolves a planMission-shaped plan (single sub-mission, single task
 * carrying `testCase` as its lone testCases[] entry). planMission()
 * unconditionally takes the reusable-session path (mirrors
 * test-plan-scope-lint-wiring.js's makeFakeReusableSessionManager).
 */
function makeFakeReusableSessionManagerForStructureLint(testCase) {
  const fakeHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
  const fakeResult = {
    structured_output: {
      subMissions: [
        {
          id: '001-001',
          tasks: [
            {
              id: '001-001-001-001',
              description: 'a planted task',
              targetFiles: ['a.js'],
              testCases: [testCase],
            },
          ],
        },
      ],
      milestones: [],
    },
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    total_cost_usd: 0,
  };

  const fakeReusableSession = {
    handle: fakeHandle,
    turnCount: 0,
    sendPrompt: async () => fakeResult,
  };

  return {
    spawn() {
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
    spawnReusable() {
      return fakeReusableSession;
    },
  };
}

function makeFakeLoggerForStructureLint() {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-plan-structure-lint-wiring.jsonl',
      write: () => {},
      close: () => {},
    }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
    warn: () => {},
  };
}

await test('TC9: planMission-unconditional-wiring — lintPlanStructure/lintTaskCheckShapes fire outside the declaredSet guard', async () => {
  const planner = new Planner(
    makeFakeReusableSessionManagerForStructureLint('no test files'),
    makeFakeLoggerForStructureLint(),
    { recordSession: async () => {} },
  );

  let threw = null;
  try {
    // Spec-less context: no specTargetFiles/specAcceptanceCriteria at all,
    // so buildDeclaredSet(...).size === 0 and lintPlanScope's declaredSet
    // guard does NOT run. lintPlanStructure/lintTaskCheckShapes must still
    // fire — they are wired unconditionally, independent of that guard.
    await planner.planMission('m1', '/tmp', {
      missionPlan: '...',
      maxTasksPerSubMission: 3,
      mode: 'auto',
    });
  } catch (err) {
    threw = err;
  }

  assert.ok(
    threw,
    'expected planMission to throw via the unconditional plan-structure-lint wiring even with no declared scope, but it resolved',
  );
  assert.ok(
    threw.message.startsWith('[plan-structure-lint]'),
    `expected a [plan-structure-lint] error, got: ${threw.message}`,
  );
  assert.ok(
    !/scope excursion/.test(threw.message),
    `this must be the plan-structure-lint gate firing (unconditional), not the plan-scope-lint gate ` +
    `(which is guarded by declaredSet.size > 0 and should not even run here) — got: ${threw.message}`,
  );
});

// ── TC10: Pipeline._recordScopeMappingWarnings — ledger category ternary, ─
// ── both directions ─────────────────────────────────────────────────────

/** Minimal fresh-tmp-dir Pipeline, sufficient for _recordScopeMappingWarnings. */
function makeLedgerPipeline() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-structure-lint-ledger-'));
  const pipeline = new Pipeline(projectRoot, {
    statusBar: false,
    onLog: () => {},
    onConfirm: async () => true,
  });
  return { projectRoot, pipeline };
}

function teardownLedgerPipeline(pipeline) {
  const h = pipeline._signalHandlers || {};
  if (h.SIGINT) process.removeListener('SIGINT', h.SIGINT);
  if (h.SIGTERM) process.removeListener('SIGTERM', h.SIGTERM);
  if (h.exit) process.removeListener('exit', h.exit);
  if (h.uncaughtException) process.removeListener('uncaughtException', h.uncaughtException);
}

await test('TC10: ledger-category-both-directions — cross-mission-duplicate warnings keep their category; other warnings collapse to plan-scope', async () => {
  const { projectRoot, pipeline } = makeLedgerPipeline();
  try {
    pipeline._recordScopeMappingWarnings('001-001', [
      { category: 'cross-mission-duplicate', description: 'm1/m2 share a.js (cross-mission)' },
      { category: 'scope-mapping-consistency', description: 'a scope-mapping-consistency warning (non-cross-mission)' },
    ]);

    const entries = readLedger(projectRoot);
    assert.strictEqual(entries.length, 2, `expected exactly two ledger entries, got ${entries.length}`);

    const crossEntry = entries.find((e) => e.description.includes('cross-mission'));
    const scopeEntry = entries.find((e) => e.description.includes('non-cross-mission'));
    assert.ok(crossEntry, 'expected a ledger entry for the cross-mission-duplicate warning');
    assert.ok(scopeEntry, 'expected a ledger entry for the non-cross-mission-duplicate warning');

    assert.strictEqual(
      crossEntry.category,
      'cross-mission-duplicate',
      `a warning carrying category 'cross-mission-duplicate' must keep it verbatim, got: ${crossEntry.category}`,
    );
    assert.strictEqual(
      scopeEntry.category,
      'plan-scope',
      `a warning carrying any other category must collapse to 'plan-scope', got: ${scopeEntry.category}`,
    );
  } finally {
    teardownLedgerPipeline(pipeline);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── TC11: _repointHarness clears the specPlanStructure cache (the fifth ───
// ── per-spec getter cache) so a later read is not served a stale value ────

/**
 * Two independent harness dirs under the same projectRoot, each with its
 * own state.json (prdPath) and sibling spec.json declaring a DIFFERENT
 * plan_structure.max_missions — enough to prove a post-repoint read
 * reflects the NEW harness dir, not a stale pre-repoint cache value.
 */
function createRepointFixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-structure-lint-repoint-'));

  function makeHarness(dirName, prdBasename, maxMissions) {
    const harnessDir = path.join(projectRoot, dirName);
    for (const sub of ['state', 'snapshots', 'analysis', 'plan']) {
      fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
    }
    const prdPath = path.join(projectRoot, prdBasename);
    fs.writeFileSync(prdPath, `# ${prdBasename}\n`);
    fs.writeFileSync(prdPath.replace(/\.md$/, '.json'), JSON.stringify({ plan_structure: { max_missions: maxMissions } }));
    fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify({
      projectMeta: { prdPath, createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones: {},
    }));
    return harnessDir;
  }

  // harnessRoot(projectRoot) === path.join(projectRoot, '.harness') — this is
  // the dir the Pipeline constructor resolves to (no active-run pointer set).
  const harnessDir1 = makeHarness('.harness', 'spec-one.md', 1);
  const harnessDir2 = makeHarness('.harness-run-002', 'spec-two.md', 7);

  return { projectRoot, harnessDir1, harnessDir2 };
}

await test('TC11: five-cache-bust-repoint — _repointHarness clears the specPlanStructure cache; a later read is not served a stale value', async () => {
  const { projectRoot, harnessDir2 } = createRepointFixture();
  const pipeline = new Pipeline(projectRoot, {
    statusBar: false,
    onLog: () => {},
    onConfirm: async () => true,
  });
  try {
    const before = pipeline._getSpecPlanStructure();
    assert.deepStrictEqual(before, { max_missions: 1 }, `expected the pre-repoint read from harness1, got: ${JSON.stringify(before)}`);
    assert.strictEqual(
      pipeline._specPlanStructureCache,
      before,
      'the pre-repoint read should have primed this._specPlanStructureCache',
    );

    pipeline._repointHarness(harnessDir2);

    assert.strictEqual(
      pipeline._specPlanStructureCache,
      undefined,
      '_repointHarness must clear this._specPlanStructureCache (the fifth per-spec getter cache)',
    );

    const after = pipeline._getSpecPlanStructure();
    assert.deepStrictEqual(
      after,
      { max_missions: 7 },
      `a read after _repointHarness must reflect the NEW harness dir's spec.json (max_missions: 7), ` +
      `not the stale pre-repoint value (max_missions: 1); got: ${JSON.stringify(after)}`,
    );
  } finally {
    teardownLedgerPipeline(pipeline);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── TC12: dryRunValidate → planner.planGlobal → lintPlanStructure — a ─────
// ── plan whose mission count exceeds spec-declared max_missions is ───────
// ── rejected at validation time, no queue entry written ───────────────────

/**
 * Fake reusable-session-capable sessionManager (planGlobal uses
 * sessionManager.spawnReusable() + session.sendPrompt(), for its bounded
 * corrective-turn retry loop) whose sendPrompt() resolves the supplied
 * globalPlan-shaped structured_output. Installed on planner.sessionManager
 * directly — NEVER on planner.planGlobal itself — so the real planGlobal
 * method (and its lintPlanStructure call) runs.
 */
function makeFakeGlobalSpawnSessionManagerForDryRun(structuredPlan) {
  return {
    spawnReusable() {
      const fakeHandle = { systemPromptTokens: 0, _toolCallCount: 0, on: () => {} };
      const fakeResult = {
        structured_output: structuredPlan,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        total_cost_usd: 0,
      };
      let turnCount = 0;
      return {
        handle: fakeHandle,
        get turnCount() { return turnCount; },
        sendPrompt: async () => {
          turnCount++;
          return fakeResult;
        },
        close: async () => {},
      };
    },
  };
}

function createDryRunMaxMissionsFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-structure-lint-dry-run-'));
  bootstrap(tmpDir, {});
  const specPath = path.join(tmpDir, 'spec.md');
  fs.writeFileSync(specPath, '# Test Spec\n\nBuild something.');
  // Sibling spec.json: passes the uncheckable-spec gate (target_files +
  // acceptance_criteria present) and declares plan_structure.max_missions: 1.
  fs.writeFileSync(
    path.join(tmpDir, 'spec.json'),
    JSON.stringify({
      goal: 'Build something.',
      target_files: ['src/foo.js'],
      acceptance_criteria: [{ description: 'it works', verification: { kind: 'manual' } }],
      plan_structure: { max_missions: 1 },
    }),
  );
  return { tmpDir, specPath };
}

await test('TC12: dryRunValidate-max_missions-rejection — a 2-mission plan is rejected against a max_missions:1 spec, no queue entry written', async () => {
  const { tmpDir, specPath } = createDryRunMaxMissionsFixture();
  const pipeline = new Pipeline(tmpDir, {
    onLog: () => {},
    onConfirm: async () => true,
  });
  pipeline._runPreflight = () => {};

  // Stub the planner's SESSION MANAGER (never planner.planGlobal itself) so
  // the real planGlobal method executes, including its
  // specPlanStructure-driven lintPlanStructure call.
  const twoMissionPlan = {
    milestones: [
      {
        id: '001',
        description: 'ms1',
        missions: [
          { id: '001-001', description: 'm1' },
          { id: '001-002', description: 'm2' },
        ],
      },
    ],
    assumptions: [],
  };
  pipeline.planner.sessionManager = makeFakeGlobalSpawnSessionManagerForDryRun(twoMissionPlan);

  try {
    let threw = null;
    try {
      await pipeline.dryRunValidate('Build a sample app', { prdPath: specPath });
    } catch (err) {
      threw = err;
    }

    assert.ok(threw, 'expected dryRunValidate to throw when the plan exceeds spec-declared max_missions, but it resolved');
    assert.ok(
      threw.message.startsWith('[plan-structure-lint]'),
      `expected a [plan-structure-lint] error, got: ${threw.message}`,
    );
    assert.ok(
      threw.message.includes('max_missions'),
      `expected the error to name max_missions, got: ${threw.message}`,
    );

    const queueDir = path.join(tmpDir, 'queue', 'spec');
    assert.ok(!fs.existsSync(queueDir), 'no queue/{slug}/ entry should be written when validation is rejected');
  } finally {
    teardownLedgerPipeline(pipeline);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
