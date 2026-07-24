/**
 * test-review-remediation-contract.js — Round-trip tests for the review-remediation structured contract.
 *
 * No Claude auth, no SDK. Feeds fixture SDK results through the
 * extraction + validation pipeline and asserts the review-remediation module
 * produces the right verdict without touching a live session.
 *
 * Run: node test/test-review-remediation-contract.js
 */
import assert from 'assert';
import {
  reviewRemediationSchema,
  extractStructured,
  validateStructured,
} from '../src/orchestrator/agents/_schemas.js';

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

// ── Fixtures ────────────────────────────────────────────────────────────

// (1) Valid fixture with newTasks containing id+description+targetFiles
const fixtureValid = {
  structured_output: {
    newTasks: [
      {
        id: '001-001-002-001',
        subMissionId: '001-001-002',
        description: 'Fix missing await on async call in pipeline.',
        targetFiles: ['src/orchestrator/pipeline.js'],
      },
    ],
  },
};

// (2) Fixture missing required 'id' field in a task
const fixtureMissingId = {
  structured_output: {
    newTasks: [
      {
        description: 'Fix missing await on async call in pipeline.',
        targetFiles: ['src/orchestrator/pipeline.js'],
      },
    ],
  },
};

// (3) Fixture missing required 'description' field in a task
const fixtureMissingDescription = {
  structured_output: {
    newTasks: [
      {
        id: '001-001-002-001',
        targetFiles: ['src/orchestrator/pipeline.js'],
      },
    ],
  },
};

// (4) Fixture with empty newTasks array (valid)
const fixtureEmptyTasks = {
  structured_output: {
    newTasks: [],
  },
};

// (5) SDK result without structured_output
const fixtureNoStructured = {
  // No structured_output — simulates an SDK response without jsonSchema
  result: 'some prose result',
};

// (6) Extra properties on task objects (should be tolerated)
const fixtureExtraProperties = {
  structured_output: {
    newTasks: [
      {
        id: '001-001-002-002',
        subMissionId: '001-001-002',
        description: 'Add retry logic to executor.',
        targetFiles: ['src/orchestrator/agents/executor.js'],
        extraField: 'should be ignored',
        anotherExtra: 42,
      },
    ],
  },
};

// ── TC1: Valid fixture passes validateStructured ─────────────────────────

await test('validateStructured: valid newTasks with id+description+targetFiles passes', () => {
  const r = validateStructured(fixtureValid.structured_output, reviewRemediationSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── TC2: Missing required 'id' field fails validateStructured ────────────

await test('validateStructured: fails when required \'id\' field is missing from task', () => {
  const r = validateStructured(fixtureMissingId.structured_output, reviewRemediationSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /id/.test(e)),
    `expected 'id' error, got: ${JSON.stringify(r.errors)}`,
  );
});

// ── TC3: Missing required 'description' field fails validateStructured ───

await test('validateStructured: fails when required \'description\' field is missing from task', () => {
  const r = validateStructured(fixtureMissingDescription.structured_output, reviewRemediationSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /description/.test(e)),
    `expected 'description' error, got: ${JSON.stringify(r.errors)}`,
  );
});

// ── TC4: Empty newTasks array is valid ───────────────────────────────────

await test('validateStructured: empty newTasks array is valid', () => {
  const r = validateStructured(fixtureEmptyTasks.structured_output, reviewRemediationSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── TC5: extractStructured returns null for missing structured_output ────

await test('extractStructured: returns null when structured_output missing', () => {
  assert.equal(extractStructured(fixtureNoStructured), null);
});

// ── Extra: Extra properties on task objects are tolerated ────────────────

await test('validateStructured: extra properties on task objects are tolerated', () => {
  const r = validateStructured(fixtureExtraProperties.structured_output, reviewRemediationSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
