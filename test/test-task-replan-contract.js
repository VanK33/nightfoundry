/**
 * test-task-replan-contract.js — Round-trip tests for the task-replan structured contract.
 *
 * No Claude auth, no SDK. Feeds fixture SDK results through the
 * extraction + validation pipeline and asserts the task-replan module
 * produces the right verdict without touching a live session.
 *
 * Run: node test/test-task-replan-contract.js
 */
import assert from 'assert';
import {
  taskReplanSchema,
  extractStructured,
  validateStructured,
} from '../src/orchestrator/agents/_schemas.js';
import { _validateFindingDispositions } from '../src/orchestrator/agents/planner.js';

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

// (1) Valid fixture with all required fields
const fixtureValid = {
  structured_output: {
    replacementTasks: [
      {
        id: '001-001-002-rp-001',
        description: 'Rewrite the failing async handler.',
        targetFiles: ['src/orchestrator/pipeline.js'],
        dependencies: [
          { taskId: '001-001-001-001', type: 'hard' },
        ],
      },
    ],
  },
};

// (2) Fixture missing required 'id' field in a task
const fixtureMissingId = {
  structured_output: {
    replacementTasks: [
      {
        description: 'Rewrite the failing async handler.',
        targetFiles: ['src/orchestrator/pipeline.js'],
        dependencies: [
          { taskId: '001-001-001-001', type: 'hard' },
        ],
      },
    ],
  },
};

// (3) Fixture missing required 'dependencies' field in a task
const fixtureMissingDependencies = {
  structured_output: {
    replacementTasks: [
      {
        id: '001-001-002-001',
        description: 'Rewrite the failing async handler.',
        targetFiles: ['src/orchestrator/pipeline.js'],
      },
    ],
  },
};

// (4) Fixture with invalid dependency type enum value
const fixtureInvalidDepType = {
  structured_output: {
    replacementTasks: [
      {
        id: '001-001-002-001',
        description: 'Rewrite the failing async handler.',
        targetFiles: ['src/orchestrator/pipeline.js'],
        dependencies: [
          { taskId: '001-001-001-001', type: 'optional' },
        ],
      },
    ],
  },
};

// (5) Fixture with empty replacementTasks array (valid)
const fixtureEmptyTasks = {
  structured_output: {
    replacementTasks: [],
  },
};

// (6) SDK result without structured_output
const fixtureNoStructured = {
  // No structured_output — simulates an SDK response without jsonSchema
  result: 'some prose result',
};

// (7) Extra properties on task objects (should be tolerated)
const fixtureExtraProperties = {
  structured_output: {
    replacementTasks: [
      {
        id: '001-001-002-rp-002',
        description: 'Add retry logic to executor.',
        targetFiles: ['src/orchestrator/agents/executor.js'],
        dependencies: [
          { taskId: '001-001-001-001', type: 'soft' },
        ],
        extraField: 'should be ignored',
        anotherExtra: 42,
      },
    ],
  },
};

// ── TC1: Valid fixture passes validateStructured ─────────────────────────

await test('validateStructured: valid replacementTasks with all fields passes', () => {
  const r = validateStructured(fixtureValid.structured_output, taskReplanSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── TC2: Missing required 'id' field fails validateStructured ────────────

await test("validateStructured: fails when required 'id' field is missing from task", () => {
  const r = validateStructured(fixtureMissingId.structured_output, taskReplanSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /id/.test(e)),
    `expected 'id' error, got: ${JSON.stringify(r.errors)}`,
  );
});

// ── TC3: Missing required 'dependencies' field fails validateStructured ──

await test("validateStructured: fails when required 'dependencies' field is missing from task", () => {
  const r = validateStructured(fixtureMissingDependencies.structured_output, taskReplanSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /dependencies/.test(e)),
    `expected 'dependencies' error, got: ${JSON.stringify(r.errors)}`,
  );
});

// ── TC4: Invalid dependency type enum value fails validateStructured ─────

await test('validateStructured: fails when dependency type is not in enum [hard, soft]', () => {
  const r = validateStructured(fixtureInvalidDepType.structured_output, taskReplanSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /enum/.test(e) || /optional/.test(e)),
    `expected enum error, got: ${JSON.stringify(r.errors)}`,
  );
});

// ── TC5: Empty replacementTasks array is valid ───────────────────────────

await test('validateStructured: empty replacementTasks array is valid', () => {
  const r = validateStructured(fixtureEmptyTasks.structured_output, taskReplanSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── TC6: extractStructured returns null for missing structured_output ────

await test('extractStructured: returns null when structured_output missing', () => {
  assert.equal(extractStructured(fixtureNoStructured), null);
});

// ── TC7: Extra properties on task objects are tolerated ──────────────────

await test('validateStructured: extra properties on task objects are tolerated', () => {
  const r = validateStructured(fixtureExtraProperties.structured_output, taskReplanSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── TC8: Empty targetFiles[] is rejected (minItems: 1) ───────────────────

await test('validateStructured: replacement task with empty targetFiles is REJECTED', () => {
  const fixtureEmptyTargetFiles = {
    structured_output: {
      replacementTasks: [
        {
          id: '001-001-002-001',
          description: 'Some replacement task.',
          targetFiles: [],
          dependencies: [],
        },
      ],
    },
  };
  const r = validateStructured(fixtureEmptyTargetFiles.structured_output, taskReplanSchema);
  assert.equal(r.ok, false, 'Expected validation to fail on empty targetFiles');
  assert.ok(
    r.errors.some((e) => /targetFiles/i.test(e) && (/minItems/i.test(e) || /at least/i.test(e) || /minimum/i.test(e))),
    `Expected minItems error on targetFiles, got: ${JSON.stringify(r.errors)}`,
  );
});

// ── TC9: Missing disposition for a secondary finding throws ─────────────

await test('_validateFindingDispositions: missing disposition for F2 throws mentioning F2', () => {
  const analyzerReport = {
    secondaryFindings: [
      { id: 'F1', summary: 's1' },
      { id: 'F2', summary: 's2' },
    ],
  };
  const replanResult = {
    findingDispositions: [
      { findingId: 'F1', disposition: 'fix' },
    ],
  };
  assert.throws(
    () => _validateFindingDispositions(replanResult, analyzerReport),
    (err) => {
      assert.ok(err instanceof Error, 'expected an Error to be thrown');
      assert.ok(err.message.includes('F2'), `expected thrown message to contain 'F2', got: ${err.message}`);
      return true;
    },
  );
});

// ── TC10: Every secondary finding dispositioned does not throw, and the ──
// ── resulting replan payload still validates against taskReplanSchema. ──

await test('_validateFindingDispositions: full dispositions do not throw and replan payload validates', () => {
  const analyzerReport = {
    secondaryFindings: [
      { id: 'F1', summary: 's1' },
      { id: 'F2', summary: 's2' },
    ],
  };
  const replanResult = {
    replacementTasks: [
      {
        id: '001-001-002-rp-001',
        description: 'Rewrite the failing async handler.',
        targetFiles: ['src/orchestrator/pipeline.js'],
        dependencies: [
          { taskId: '001-001-001-001', type: 'hard' },
        ],
      },
    ],
    findingDispositions: [
      { findingId: 'F1', disposition: 'fix' },
      { findingId: 'F2', disposition: 'defer' },
    ],
  };
  assert.doesNotThrow(() => _validateFindingDispositions(replanResult, analyzerReport));

  const r = validateStructured(replanResult, taskReplanSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── TC11: No secondaryFindings property on analyzer report is a no-op ────

await test('_validateFindingDispositions: analyzer report with no secondaryFindings does not throw', () => {
  const analyzerReport = {
    rootCause: 'executor.js accesses result.structured_output without null guard causing TypeError',
    evidence: 'Stack trace shows TypeError at executor.js:142 — Cannot read property of undefined',
  };
  const fixtureNoFindings = {
    structured_output: {
      replacementTasks: [
        {
          id: '001-001-002-rp-001',
          description: 'Guard against missing structured_output.',
          targetFiles: ['src/orchestrator/agents/executor.js'],
          dependencies: [],
        },
      ],
    },
  };
  const replanResult = extractStructured(fixtureNoFindings);
  assert.doesNotThrow(() => _validateFindingDispositions(replanResult, analyzerReport));

  const r = validateStructured(replanResult, taskReplanSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── TC12: Duplicate dispositions naming the same finding throws ──────────

await test('_validateFindingDispositions: duplicate dispositions for F1 throws', () => {
  const analyzerReport = {
    secondaryFindings: [
      { id: 'F1', summary: 's1' },
    ],
  };
  const replanResult = {
    findingDispositions: [
      { findingId: 'F1', disposition: 'fix' },
      { findingId: 'F1', disposition: 'defer' },
    ],
  };
  assert.throws(() => _validateFindingDispositions(replanResult, analyzerReport));
});

// ── TC13: Disposition naming an id absent from secondaryFindings throws ──

await test('_validateFindingDispositions: disposition referencing unknown finding id throws', () => {
  const analyzerReport = {
    secondaryFindings: [
      { id: 'F1', summary: 's1' },
    ],
  };
  const replanResult = {
    findingDispositions: [
      { findingId: 'F1', disposition: 'fix' },
      { findingId: 'F9', disposition: 'not_applicable' },
    ],
  };
  assert.throws(() => _validateFindingDispositions(replanResult, analyzerReport));
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
