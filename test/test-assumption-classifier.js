#!/usr/bin/env node
/**
 * test-assumption-classifier.js — Standalone unit tests for
 * src/orchestrator/core/assumption-classifier.js.
 *
 * Imports ONLY from the classifier module (no pipeline/state imports).
 * Covers TC1–TC7 as specified.
 *
 * Run: node test/test-assumption-classifier.js
 */

import assert from 'assert';
import {
  BENIGN_CATEGORIES,
  classifyBenignUncertain,
} from '../src/orchestrator/core/assumption-classifier.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// Per-category representative benign evidence strings.
// Each is chosen to match exactly one of the four documented whitelist shapes,
// and none of them match the synthetic `stub` / `stubbed evidence for` strings.
const BENIGN_EVIDENCE = {
  'inspector-cannot-execute': 'Cannot execute the test suite in this environment.',
  'inspector-cannot-access-git-history': 'The git history is not accessible from the inspector sandbox.',
  'cross-spec-or-planning-claim': 'This is a process/meta claim that cannot be confirmed or denied purely from code.',
  'inspector-cannot-trace-full-path': 'The inspector did not trace the full call path for this assumption.',
};

// Generic evidence that matches no category → must return null.
const NON_BENIGN_EVIDENCE = 'some unverifiable reason that matches no whitelist category';

// ── TC1: BENIGN_CATEGORIES has the 4 keys in documented order with RegExp[] ──

await test('TC1: BENIGN_CATEGORIES has exactly 4 keys in documented order, each with a non-empty RegExp[] patterns array', async () => {
  assert.ok(Array.isArray(BENIGN_CATEGORIES), 'BENIGN_CATEGORIES must be an array');
  const expectedKeys = [
    'inspector-cannot-execute',
    'inspector-cannot-access-git-history',
    'cross-spec-or-planning-claim',
    'inspector-cannot-trace-full-path',
  ];
  assert.strictEqual(BENIGN_CATEGORIES.length, 4,
    `BENIGN_CATEGORIES must have exactly 4 entries (got ${BENIGN_CATEGORIES.length})`);
  const actualKeys = BENIGN_CATEGORIES.map((c) => c.key);
  assert.deepStrictEqual(actualKeys, expectedKeys,
    `BENIGN_CATEGORIES keys must be exactly ${JSON.stringify(expectedKeys)} in order (got ${JSON.stringify(actualKeys)})`);
  for (const c of BENIGN_CATEGORIES) {
    assert.strictEqual(typeof c.key, 'string', `category must have a string key (got ${typeof c.key})`);
    assert.strictEqual(typeof c.label, 'string', `category '${c.key}' must have a string label`);
    assert.ok(Array.isArray(c.patterns) && c.patterns.length > 0,
      `category '${c.key}' must have a non-empty patterns array`);
    for (const p of c.patterns) {
      assert.ok(p instanceof RegExp,
        `category '${c.key}' patterns must be RegExp instances (got ${typeof p})`);
    }
  }
});

// ── TC2: each category classifies its representative benign evidence to {key,label} ──

await test('TC2: each category classifies its representative benign evidence to its own {key, label}', async () => {
  for (const c of BENIGN_CATEGORIES) {
    const evidence = BENIGN_EVIDENCE[c.key];
    assert.ok(evidence,
      `test fixture missing benign evidence for category '${c.key}'`);
    const result = classifyBenignUncertain({ status: 'uncertain', evidence });
    assert.ok(result,
      `category '${c.key}' must classify its benign evidence (got null for "${evidence}")`);
    assert.strictEqual(result.key, c.key,
      `evidence "${evidence}" must classify as '${c.key}', got '${result?.key}'`);
    assert.strictEqual(result.label, c.label,
      `classify result.label must equal the category label for '${c.key}' (got '${result?.label}', expected '${c.label}')`);
  }
});

// ── TC3: evidence 'stub' returns null ──

await test('TC3: evidence "stub" returns null (synthetic park-test evidence must not match any category)', async () => {
  const result = classifyBenignUncertain({ status: 'uncertain', evidence: 'stub' });
  assert.strictEqual(result, null,
    "evidence 'stub' must classify as null — no BENIGN_CATEGORIES pattern may match bare 'stub'");
});

// ── TC4: 'stubbed evidence for "UNCERTAIN-ONE"' returns null ──

await test('TC4: evidence \'stubbed evidence for "UNCERTAIN-ONE"\' returns null (park-foundation fixture guard)', async () => {
  const result = classifyBenignUncertain({ status: 'uncertain', evidence: 'stubbed evidence for "UNCERTAIN-ONE"' });
  assert.strictEqual(result, null,
    'the synthetic park-foundation evidence must classify as null — TC2/TC3b must keep parking');
});

// ── TC5: missing/empty/null/non-string/generic-unmatched evidence each return null ──

await test('TC5: missing/empty/null/non-string/generic-unmatched evidence each return null (conservative classification)', async () => {
  assert.strictEqual(classifyBenignUncertain({ status: 'uncertain' }), null,
    'missing evidence must return null');
  assert.strictEqual(classifyBenignUncertain({ status: 'uncertain', evidence: '' }), null,
    'empty string evidence must return null');
  assert.strictEqual(classifyBenignUncertain({ status: 'uncertain', evidence: null }), null,
    'null evidence must return null');
  assert.strictEqual(classifyBenignUncertain({ status: 'uncertain', evidence: 123 }), null,
    'non-string (number) evidence must return null');
  assert.strictEqual(classifyBenignUncertain({ status: 'uncertain', evidence: [] }), null,
    'non-string (array) evidence must return null');
  assert.strictEqual(classifyBenignUncertain({ status: 'uncertain', evidence: NON_BENIGN_EVIDENCE }), null,
    `generic non-benign evidence must return null: "${NON_BENIGN_EVIDENCE}"`);
  // Also verify that calling with null/undefined verdict itself does not throw
  assert.strictEqual(classifyBenignUncertain(null), null,
    'null verdict must return null without throwing');
  assert.strictEqual(classifyBenignUncertain(undefined), null,
    'undefined verdict must return null without throwing');
});

// ── TC6: purity — same evidence classifies identically regardless of status field ──

await test('TC6: classifyBenignUncertain is status-agnostic — same evidence classifies identically across status "uncertain"/"failed"/absent', async () => {
  const evidence = BENIGN_EVIDENCE['inspector-cannot-execute'];

  const asUncertain = classifyBenignUncertain({ status: 'uncertain', evidence });
  const asFailed = classifyBenignUncertain({ status: 'failed', evidence });
  const noStatus = classifyBenignUncertain({ evidence });

  assert.ok(asUncertain,
    `benign evidence must classify with status:'uncertain' (got null for "${evidence}")`);
  assert.deepStrictEqual(asFailed, asUncertain,
    'classifyBenignUncertain must NOT inspect verdict.status — same evidence must classify identically with status:failed');
  assert.deepStrictEqual(noStatus, asUncertain,
    'classifyBenignUncertain must classify on evidence alone, even with no status field present');

  // Confirm the same holds for null-returning evidence across status values
  const nullUncertain = classifyBenignUncertain({ status: 'uncertain', evidence: NON_BENIGN_EVIDENCE });
  const nullFailed = classifyBenignUncertain({ status: 'failed', evidence: NON_BENIGN_EVIDENCE });
  const nullNoStatus = classifyBenignUncertain({ evidence: NON_BENIGN_EVIDENCE });
  assert.strictEqual(nullUncertain, null,
    'non-benign evidence must return null with status:uncertain');
  assert.deepStrictEqual(nullFailed, nullUncertain,
    'non-benign evidence must return null with status:failed (same as uncertain)');
  assert.deepStrictEqual(nullNoStatus, nullUncertain,
    'non-benign evidence must return null with no status field (same as uncertain)');
});

// ── TC7: first-match-in-order is returned ──

await test('TC7: first-match-in-order — evidence matching multiple categories returns the earliest category in BENIGN_CATEGORIES', async () => {
  // Construct evidence text that matches BOTH the first category
  // ('inspector-cannot-execute': /cannot execute/i) AND the last category
  // ('inspector-cannot-trace-full-path': /did not trace the full/i).
  // The classifier must return the FIRST match in order.
  const multiMatchEvidence = 'Cannot execute: did not trace the full call path for this assumption.';

  // Verify both patterns match independently (fixture sanity)
  const firstCategory = BENIGN_CATEGORIES[0]; // inspector-cannot-execute
  const lastCategory = BENIGN_CATEGORIES[BENIGN_CATEGORIES.length - 1]; // inspector-cannot-trace-full-path

  const firstPatternMatches = firstCategory.patterns.some((p) => p.test(multiMatchEvidence));
  const lastPatternMatches = lastCategory.patterns.some((p) => p.test(multiMatchEvidence));

  assert.ok(firstPatternMatches,
    `fixture sanity: first category '${firstCategory.key}' must have a pattern matching "${multiMatchEvidence}"`);
  assert.ok(lastPatternMatches,
    `fixture sanity: last category '${lastCategory.key}' must have a pattern matching "${multiMatchEvidence}"`);

  // Now confirm the classifier returns the FIRST (earliest) category.
  const result = classifyBenignUncertain({ status: 'uncertain', evidence: multiMatchEvidence });
  assert.ok(result,
    `multi-match evidence must classify to some category (got null for "${multiMatchEvidence}")`);
  assert.strictEqual(result.key, firstCategory.key,
    `first-match-in-order: expected '${firstCategory.key}' (first in BENIGN_CATEGORIES), got '${result?.key}'`);
  assert.strictEqual(result.label, firstCategory.label,
    `first-match-in-order: label must match the first category '${firstCategory.key}'`);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
