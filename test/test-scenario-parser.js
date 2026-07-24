/**
 * test-scenario-parser.js — Unit tests for scenario-parser.js.
 *
 * No Claude auth, no SDK. Pure string parsing assertions.
 * Run: node test/test-scenario-parser.js
 */
import assert from 'assert';
import {
  extractScenariosFromSpec,
  extractCoveredScenarios,
  diffCoverage,
} from '../src/orchestrator/core/scenario-parser.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

// ---------- extractScenariosFromSpec ----------

test('extract: basic ### Scenarios with bullet list', () => {
  const spec = `
# My Feature

## Testing

### Scenarios

- S1: User can log in
- S2: Invalid password shows error
- S3: Lockout after 5 failures

## Implementation

- unrelated bullet
`;
  assert.deepEqual(extractScenariosFromSpec(spec), ['S1', 'S2', 'S3']);
});

test('extract: ## Scenarios (not nested under Testing)', () => {
  const spec = `
## Scenarios

- S1: thing one
- S2: thing two
`;
  assert.deepEqual(extractScenariosFromSpec(spec), ['S1', 'S2']);
});

test('extract: **S1** bold ID formatting', () => {
  const spec = `
### Scenarios

- **S1**: Bold ID
- **S2**: Another
`;
  assert.deepEqual(extractScenariosFromSpec(spec), ['S1', 'S2']);
});

test('extract: ID without description', () => {
  const spec = `
### Scenarios

- S1
- S2
`;
  assert.deepEqual(extractScenariosFromSpec(spec), ['S1', 'S2']);
});

test('extract: * bullet style', () => {
  const spec = `
### Scenarios

* S1: alt bullet
* S2: also alt
`;
  assert.deepEqual(extractScenariosFromSpec(spec), ['S1', 'S2']);
});

test('extract: SC-1 hyphenated ID format', () => {
  const spec = `
### Scenarios

- SC-1: first
- SC-2: second
`;
  assert.deepEqual(extractScenariosFromSpec(spec), ['SC-1', 'SC-2']);
});

test('extract: stops at next heading and ignores later bullets', () => {
  const spec = `
### Scenarios

- S1: in section
- S2: also in section

### Notes

- S99: should NOT be captured
- S100: also not
`;
  assert.deepEqual(extractScenariosFromSpec(spec), ['S1', 'S2']);
});

test('extract: no Scenarios heading returns empty array', () => {
  const spec = `
# Feature

## Implementation

- A
- B
`;
  assert.deepEqual(extractScenariosFromSpec(spec), []);
});

test('extract: empty/null input returns empty array', () => {
  assert.deepEqual(extractScenariosFromSpec(''), []);
  assert.deepEqual(extractScenariosFromSpec(null), []);
  assert.deepEqual(extractScenariosFromSpec(undefined), []);
});

test('extract: case-sensitive ID prefix (s1 does not match)', () => {
  const spec = `
### Scenarios

- s1: lowercase
- S2: uppercase
`;
  // Only S2 matches — the S prefix is case-sensitive by design.
  assert.deepEqual(extractScenariosFromSpec(spec), ['S2']);
});

test('extract: Scenarios heading is case-insensitive', () => {
  const spec = `
### scenarios

- S1: lowercase heading
`;
  assert.deepEqual(extractScenariosFromSpec(spec), ['S1']);
});

test('extract: deduplicates repeated IDs preserving order', () => {
  const spec = `
### Scenarios

- S1: first
- S2: second
- S1: duplicate
- S3: third
`;
  assert.deepEqual(extractScenariosFromSpec(spec), ['S1', 'S2', 'S3']);
});

test('extract: mixed heading levels work (####)', () => {
  const spec = `
## Testing

### Acceptance

#### Scenarios

- S1: deeply nested
`;
  assert.deepEqual(extractScenariosFromSpec(spec), ['S1']);
});

// ---------- extractCoveredScenarios ----------

test('covered: union across tasks', () => {
  const missionState = {
    subMissions: {
      '001-001-001': {
        tasks: {
          '001-001-001-001': { tracesScenario: ['S1', 'S2'] },
          '001-001-001-002': { tracesScenario: ['S2', 'S3'] },
        },
      },
      '001-001-002': {
        tasks: {
          '001-001-002-001': { tracesScenario: ['S4'] },
        },
      },
    },
  };
  const covered = extractCoveredScenarios(missionState);
  assert.deepEqual([...covered].sort(), ['S1', 'S2', 'S3', 'S4']);
});

test('covered: missing tracesScenario treated as empty', () => {
  const missionState = {
    subMissions: {
      '001-001-001': {
        tasks: {
          '001-001-001-001': {}, // no tracesScenario field
          '001-001-001-002': { tracesScenario: null },
          '001-001-001-003': { tracesScenario: ['S1'] },
        },
      },
    },
  };
  const covered = extractCoveredScenarios(missionState);
  assert.deepEqual([...covered], ['S1']);
});

test('covered: empty mission state returns empty set', () => {
  assert.equal(extractCoveredScenarios({}).size, 0);
  assert.equal(extractCoveredScenarios(null).size, 0);
  assert.equal(extractCoveredScenarios({ subMissions: {} }).size, 0);
});

test('covered: ignores non-string and empty IDs', () => {
  const missionState = {
    subMissions: {
      '001-001-001': {
        tasks: {
          '001-001-001-001': { tracesScenario: ['S1', '', null, 42, 'S2'] },
        },
      },
    },
  };
  const covered = extractCoveredScenarios(missionState);
  assert.deepEqual([...covered].sort(), ['S1', 'S2']);
});

// ---------- diffCoverage ----------

test('diff: all covered returns empty uncovered', () => {
  const { covered, uncovered } = diffCoverage(['S1', 'S2'], new Set(['S1', 'S2', 'S3']));
  assert.deepEqual(covered, ['S1', 'S2']);
  assert.deepEqual(uncovered, []);
});

test('diff: some uncovered returned in spec order', () => {
  const { covered, uncovered } = diffCoverage(['S1', 'S2', 'S3', 'S4'], new Set(['S2', 'S4']));
  assert.deepEqual(covered, ['S2', 'S4']);
  assert.deepEqual(uncovered, ['S1', 'S3']);
});

test('diff: accepts Set or array for coveredIds', () => {
  const a = diffCoverage(['S1', 'S2'], new Set(['S1']));
  const b = diffCoverage(['S1', 'S2'], ['S1']);
  assert.deepEqual(a, b);
});

test('diff: empty spec returns empty both', () => {
  const { covered, uncovered } = diffCoverage([], new Set(['S1']));
  assert.deepEqual(covered, []);
  assert.deepEqual(uncovered, []);
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
