/**
 * test-scenario-coverage-by-identity.js — Unit tests for remediationClosesCoverage
 * verifying that closure is gated on IDENTITY (matching scenario ids), not on
 * COUNT alone.
 *
 * Test cases:
 *   TC-ID-A: wrong ids of equal cardinality → false
 *            (proves identity, not count, gates closure — the regression the fix closes)
 *   TC-ID-B: outOfScope.scenarioId 's1' + newTasks.tracesScenario ['s2'] → true
 *   TC-ID-C: only 's1' addressed of ['s1','s2'] → false
 *   TC-ID-D: malformed remediation does not throw and returns false
 *   TC-ID-E: remediationClosesCoverage([], anyRemediation) → true (vacuous)
 *
 * Run: node test/test-scenario-coverage-by-identity.js
 */
import assert from 'assert';
import { remediationClosesCoverage } from '../src/orchestrator/gates/coverage.js';

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

// TC-ID-A: wrong ids of equal cardinality → false
// Remediation addresses ['x1','x2'] which has the same count as uncovered ['s1','s2']
// but different ids. Under the old count-based predicate this would have returned true;
// the identity-based predicate must return false.
await test('TC-ID-A: wrong ids of equal cardinality → false (identity not count)', async () => {
  const uncovered = ['s1', 's2'];
  const remediation = {
    outOfScope: [
      { scenarioId: 'x1', justification: 'out of scope' },
      { scenarioId: 'x2', justification: 'out of scope' },
    ],
    newTasks: [],
  };
  const result = remediationClosesCoverage(uncovered, remediation);
  assert.strictEqual(result, false, 'expected false when addressed ids differ from uncovered ids');
});

// TC-ID-B: outOfScope.scenarioId 's1' + newTasks.tracesScenario ['s2'] cover ['s1','s2'] → true
await test('TC-ID-B: outOfScope scenarioId + newTasks tracesScenario covers all uncovered → true', async () => {
  const uncovered = ['s1', 's2'];
  const remediation = {
    outOfScope: [
      { scenarioId: 's1', justification: 'handled by another mission' },
    ],
    newTasks: [
      { id: 'task-001', description: 'cover s2', tracesScenario: ['s2'] },
    ],
  };
  const result = remediationClosesCoverage(uncovered, remediation);
  assert.strictEqual(result, true, 'expected true when all uncovered ids are addressed');
});

// TC-ID-C: only 's1' addressed of ['s1','s2'] → false
await test('TC-ID-C: partial coverage (only s1 of [s1,s2]) → false', async () => {
  const uncovered = ['s1', 's2'];
  const remediation = {
    outOfScope: [
      { scenarioId: 's1', justification: 'out of scope' },
    ],
    newTasks: [],
  };
  const result = remediationClosesCoverage(uncovered, remediation);
  assert.strictEqual(result, false, 'expected false when only some uncovered ids are addressed');
});

// TC-ID-D: malformed remediation with uncovered ['s1'] → does not throw and returns false
await test('TC-ID-D: malformed remediation ({}) does not throw and returns false', async () => {
  const uncovered = ['s1'];

  // Case 1: empty object
  let result;
  assert.doesNotThrow(() => {
    result = remediationClosesCoverage(uncovered, {});
  }, 'must not throw for empty object');
  assert.strictEqual(result, false, 'empty object → false');

  // Case 2: no newTasks field
  assert.doesNotThrow(() => {
    result = remediationClosesCoverage(uncovered, { outOfScope: [] });
  }, 'must not throw when newTasks missing');
  assert.strictEqual(result, false, 'no newTasks → false');

  // Case 3: non-array tracesScenario
  assert.doesNotThrow(() => {
    result = remediationClosesCoverage(uncovered, {
      outOfScope: [],
      newTasks: [{ id: 'task-001', tracesScenario: 's1' }],
    });
  }, 'must not throw when tracesScenario is not an array');
  assert.strictEqual(result, false, 'non-array tracesScenario → false');

  // Case 4: undefined fields (null remediation)
  assert.doesNotThrow(() => {
    result = remediationClosesCoverage(uncovered, null);
  }, 'must not throw for null remediation');
  assert.strictEqual(result, false, 'null remediation → false');

  // Case 5: undefined remediation
  assert.doesNotThrow(() => {
    result = remediationClosesCoverage(uncovered, undefined);
  }, 'must not throw for undefined remediation');
  assert.strictEqual(result, false, 'undefined remediation → false');
});

// TC-ID-E: remediationClosesCoverage([], anyRemediation) → true (vacuous)
await test('TC-ID-E: empty uncovered array is vacuously true regardless of remediation', async () => {
  const anyRemediation = {
    outOfScope: [{ scenarioId: 'irrelevant', justification: 'n/a' }],
    newTasks: [{ id: 'task-001', tracesScenario: ['also-irrelevant'] }],
  };
  const result = remediationClosesCoverage([], anyRemediation);
  assert.strictEqual(result, true, 'expected vacuous true for empty uncovered array');

  // Also test with null/undefined remediation
  const result2 = remediationClosesCoverage([], null);
  assert.strictEqual(result2, true, 'expected vacuous true for empty uncovered with null remediation');

  const result3 = remediationClosesCoverage([], {});
  assert.strictEqual(result3, true, 'expected vacuous true for empty uncovered with empty remediation');
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
