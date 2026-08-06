/**
 * test-regression-purity-strip.js — behavior tests for
 * stripTreePurityChecks (src/orchestrator/gates/regression-verdict-filter.js).
 *
 * Fixtures reconstruct the real regressionVerifierSchema sidecar shape
 * (result/hardChecks/taskScopeChecks/standardsChecks/notes/
 * back_reference_check/findings — see agents/_schemas.js) faithfully. The
 * function under test is pure over the verdict object: no fs, no git repo,
 * no temp directory, no network, no session/LLM call.
 *
 * Cases:
 *   (1) a FAIL hardCheck named 'git status shows modified test files' is
 *       stripped and the purity-only FAILED verdict flips to PASSED, with
 *       that check present in strippedChecks.
 *   (2) a FAIL taskScopeCheck reading 'only config.yaml.example modified'
 *       is stripped.
 *   (3) a behavioral FAIL check ('node test/x.js exits 1') is NOT stripped
 *       and the verdict stays FAILED.
 *   (4) a mixed verdict carrying one purity FAIL and one behavioral FAIL
 *       strips only the purity check and stays FAILED.
 *   (5) a tree-purity phrase strictly inside a backtick-quoted literal is
 *       NOT stripped.
 *   (6) a FAILED verdict with zero FAIL-status checks and no purity shapes
 *       comes back with result FAILED and an empty strippedChecks — no
 *       flip on an empty strip.
 *   (7) null input comes back as null with an empty strippedChecks.
 *   (8) findings[] deep-equal the input findings after a flip to PASSED.
 *   (9) every strippedChecks entry deep-equals { array, check } with array
 *       one of 'hardChecks' | 'taskScopeChecks' | 'standardsChecks' and
 *       check deep-equal to the original check object.
 *
 * Run: node test/test-regression-purity-strip.js
 */

import assert from 'assert';
import { stripTreePurityChecks } from '../src/orchestrator/gates/regression-verdict-filter.js';

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

// ── Production sidecar shape builder ─────────────────────────────────────

function backRefCheck() {
  return { spec_consulted: true, plan_consulted: true, deviations: [] };
}

/** Faithful regressionVerifierSchema shape. */
function makeVerdict({ result, hardChecks = [], taskScopeChecks = [], standardsChecks = [], findings = [] }) {
  return {
    result,
    hardChecks,
    taskScopeChecks,
    standardsChecks,
    notes: '',
    back_reference_check: backRefCheck(),
    findings,
  };
}

function assertStrippedEntryShape(entry, expectedArray, expectedCheck) {
  assert.ok(entry && typeof entry === 'object', 'strippedChecks entry must be an object');
  assert.deepStrictEqual(
    Object.keys(entry).sort(),
    ['array', 'check'].sort(),
    'strippedChecks entry must have exactly the keys { array, check }'
  );
  assert.ok(
    ['hardChecks', 'taskScopeChecks', 'standardsChecks'].includes(entry.array),
    `entry.array must be one of hardChecks|taskScopeChecks|standardsChecks, got "${entry.array}"`
  );
  assert.strictEqual(entry.array, expectedArray, `entry.array must be "${expectedArray}"`);
  assert.deepStrictEqual(entry.check, expectedCheck, 'entry.check must deep-equal the original check object');
}

async function run() {

// ── (1) purity-only hardCheck: 'git status shows modified test files' ───

await test('(1) FAIL hardCheck "git status shows modified test files" is stripped; purity-only FAILED verdict → PASSED', () => {
  const check = {
    name: 'git status shows modified test files',
    status: 'FAIL',
    evidence: 'git status output listed test/test-foo.js as modified',
  };
  const findings = [{ file: 'test/test-foo.js', description: 'unexpected modification' }];
  const verdict = makeVerdict({
    result: 'FAILED',
    hardChecks: [check],
    findings,
  });

  const { structured, strippedChecks } = stripTreePurityChecks(verdict);

  assert.strictEqual(structured.result, 'PASSED', 'result must flip to PASSED');
  assert.strictEqual(strippedChecks.length, 1, 'exactly one check must be stripped');
  assertStrippedEntryShape(strippedChecks[0], 'hardChecks', check);
  assert.strictEqual(structured.hardChecks.length, 0, 'the stripped hardCheck must be removed from the cleaned verdict');
});

// ── (2) 'only config.yaml.example modified' taskScopeCheck stripped ──────

await test('(2) FAIL taskScopeCheck "only config.yaml.example modified" is stripped', () => {
  const check = {
    description: 'only config.yaml.example modified',
    status: 'FAIL',
    evidence: 'the working tree shows only config.yaml.example modified',
  };
  const verdict = makeVerdict({
    result: 'FAILED',
    taskScopeChecks: [check],
    findings: [{ file: 'config.yaml.example', description: 'unexpected modification' }],
  });

  const { structured, strippedChecks } = stripTreePurityChecks(verdict);

  assert.strictEqual(strippedChecks.length, 1, 'exactly one check must be stripped');
  assertStrippedEntryShape(strippedChecks[0], 'taskScopeChecks', check);
  assert.strictEqual(structured.result, 'PASSED', 'result must flip to PASSED (nothing else remains FAIL)');
});

// ── (3) behavioral FAIL check is NOT stripped ─────────────────────────────

await test('(3) behavioral FAIL check "node test/x.js exits 1" is NOT stripped; verdict stays FAILED', () => {
  const check = {
    description: 'node test/x.js exits 1',
    status: 'FAIL',
    evidence: 'the process exited with code 1 instead of 0',
  };
  const verdict = makeVerdict({
    result: 'FAILED',
    taskScopeChecks: [check],
    findings: [{ file: 'test/x.js', description: 'test fails' }],
  });

  const { structured, strippedChecks } = stripTreePurityChecks(verdict);

  assert.strictEqual(strippedChecks.length, 0, 'no check should be stripped');
  assert.strictEqual(structured.result, 'FAILED', 'result must stay FAILED');
  assert.strictEqual(structured.taskScopeChecks.length, 1, 'the behavioral check must remain in the cleaned verdict');
  assert.deepStrictEqual(structured.taskScopeChecks[0], check, 'the remaining check must be unchanged');
});

// ── (4) mixed verdict: one purity FAIL + one behavioral FAIL ─────────────

await test('(4) mixed verdict strips only the purity check and stays FAILED', () => {
  const purityCheck = {
    name: 'git status shows modified test files',
    status: 'FAIL',
    evidence: 'git status output listed test/test-foo.js as modified',
  };
  const behavioralCheck = {
    description: 'node test/x.js exits 1',
    status: 'FAIL',
    evidence: 'the process exited with code 1 instead of 0',
  };
  const verdict = makeVerdict({
    result: 'FAILED',
    hardChecks: [purityCheck],
    taskScopeChecks: [behavioralCheck],
    findings: [
      { file: 'test/test-foo.js', description: 'unexpected modification' },
      { file: 'test/x.js', description: 'test fails' },
    ],
  });

  const { structured, strippedChecks } = stripTreePurityChecks(verdict);

  assert.strictEqual(strippedChecks.length, 1, 'exactly one (purity) check must be stripped');
  assertStrippedEntryShape(strippedChecks[0], 'hardChecks', purityCheck);
  assert.strictEqual(structured.result, 'FAILED', 'result must stay FAILED because a behavioral FAIL remains');
  assert.strictEqual(structured.hardChecks.length, 0, 'purity hardCheck must be removed');
  assert.strictEqual(structured.taskScopeChecks.length, 1, 'behavioral taskScopeCheck must remain');
});

// ── (5) tree-purity phrase strictly inside a backtick literal ────────────

await test('(5) tree-purity phrase strictly inside a backtick-quoted literal is NOT stripped', () => {
  const check = {
    description: 'the failure message contains the exact text `only config.yaml modified`',
    status: 'FAIL',
    evidence: 'assertion output matched the expected error string verbatim',
  };
  const verdict = makeVerdict({
    result: 'FAILED',
    taskScopeChecks: [check],
    findings: [{ file: 'config.yaml', description: 'assertion mismatch' }],
  });

  const { structured, strippedChecks } = stripTreePurityChecks(verdict);

  assert.strictEqual(strippedChecks.length, 0, 'nothing should be stripped when the shape sits strictly inside a backtick literal');
  assert.strictEqual(structured.result, 'FAILED', 'result must stay FAILED (no flip on an empty strip)');
});

// ── (6) zero FAIL-status checks and no purity shapes ──────────────────────

await test('(6) FAILED verdict with zero FAIL-status checks and no purity shapes comes back unchanged (no flip)', () => {
  const verdict = makeVerdict({
    result: 'FAILED',
    hardChecks: [{ name: 'unrelated hard check', status: 'PASS', evidence: 'all good' }],
    taskScopeChecks: [{ description: 'unrelated task-scope check', status: 'PASS', evidence: 'all good' }],
    standardsChecks: [{ description: 'unrelated standards check', status: 'PASS', evidence: 'all good' }],
    findings: [],
  });

  const { structured, strippedChecks } = stripTreePurityChecks(verdict);

  assert.strictEqual(strippedChecks.length, 0, 'strippedChecks must be empty');
  assert.strictEqual(structured.result, 'FAILED', 'result must stay FAILED — no flip on an empty strip');
});

// ── (7) null input ─────────────────────────────────────────────────────

await test('(7) null input comes back as null with an empty strippedChecks', () => {
  const { structured, strippedChecks } = stripTreePurityChecks(null);

  assert.strictEqual(structured, null, 'structured must be returned as null');
  assert.deepStrictEqual(strippedChecks, [], 'strippedChecks must be an empty array');
});

// ── (8) findings[] survive a flip to PASSED untouched ─────────────────────

await test('(8) findings[] deep-equal the input findings after a flip to PASSED', () => {
  const check = {
    name: 'git status shows modified test files',
    status: 'FAIL',
    evidence: 'git status output listed test/test-foo.js as modified',
  };
  const findings = [
    { file: 'test/test-foo.js', description: 'unexpected modification', evidence: 'diff shown here', relatedFiles: ['test/test-bar.js'] },
  ];
  const verdict = makeVerdict({
    result: 'FAILED',
    hardChecks: [check],
    findings,
  });

  const { structured } = stripTreePurityChecks(verdict);

  assert.strictEqual(structured.result, 'PASSED', 'sanity: verdict must have flipped to PASSED');
  assert.deepStrictEqual(structured.findings, findings, 'findings[] must deep-equal the input findings after the flip');
});

// ── (9) strippedChecks entry shape, exhaustively, across all three arrays ─

await test('(9) strippedChecks entries deep-equal { array, check } for hardChecks / taskScopeChecks / standardsChecks', () => {
  const hardCheck = {
    name: 'git status shows modified test files',
    status: 'FAIL',
    evidence: 'git status output listed test/test-foo.js as modified',
  };
  const taskScopeCheck = {
    description: 'only config.yaml.example modified',
    status: 'FAIL',
    evidence: 'the working tree shows only config.yaml.example modified',
  };
  const standardsCheck = {
    description: 'no test files were modified',
    status: 'FAIL',
    evidence: 'the standards reviewer found no test files were modified',
  };
  const verdict = makeVerdict({
    result: 'FAILED',
    hardChecks: [hardCheck],
    taskScopeChecks: [taskScopeCheck],
    standardsChecks: [standardsCheck],
    findings: [{ file: 'test/test-foo.js', description: 'unexpected modification' }],
  });

  const { strippedChecks } = stripTreePurityChecks(verdict);

  assert.strictEqual(strippedChecks.length, 3, 'all three purity checks must be stripped');
  const byArray = Object.fromEntries(strippedChecks.map((e) => [e.array, e]));
  assertStrippedEntryShape(byArray.hardChecks, 'hardChecks', hardCheck);
  assertStrippedEntryShape(byArray.taskScopeChecks, 'taskScopeChecks', taskScopeCheck);
  assertStrippedEntryShape(byArray.standardsChecks, 'standardsChecks', standardsCheck);
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

await run();
