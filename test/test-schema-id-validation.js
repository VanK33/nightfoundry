/**
 * test-schema-id-validation.js — Tests for reviewRemediationSchema pattern constraints.
 *
 * No Claude auth, no SDK. Validates that the tightened reviewRemediationSchema
 * with pattern constraints (id: 4-segment, subMissionId: 3-segment) works
 * correctly via validateStructured.
 *
 * Run: node test/test-schema-id-validation.js
 *
 * Covers:
 *   TC-SCHEMA-1 — valid 4-segment id + 3-segment subMissionId passes
 *   TC-SCHEMA-2 — wrong-format id fails pattern
 *   TC-SCHEMA-3 — missing subMissionId fails required
 */

import assert from 'assert';
import {
  reviewRemediationSchema,
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

// ── Fixtures ──────────────────────────────────────────────────────────────

// TC-SCHEMA-1: valid 4-segment id + 3-segment subMissionId
const fixtureValidWithSubMissionId = {
  newTasks: [
    {
      id: '001-001-001-001',
      subMissionId: '001-001-001',
      description: 'Fix missing await on async call in pipeline.',
      targetFiles: ['src/orchestrator/pipeline.js'],
    },
  ],
};

// TC-SCHEMA-2: wrong-format id (3-segment instead of 4-segment)
const fixtureWrongFormatId = {
  newTasks: [
    {
      id: '001-001-001',
      subMissionId: '001-001-001',
      description: 'Fix missing await on async call in pipeline.',
      targetFiles: ['src/orchestrator/pipeline.js'],
    },
  ],
};

// TC-SCHEMA-3: missing subMissionId (required field absent)
const fixtureMissingSubMissionId = {
  newTasks: [
    {
      id: '001-001-001-001',
      description: 'Fix missing await on async call in pipeline.',
      targetFiles: ['src/orchestrator/pipeline.js'],
    },
  ],
};

// ── TC-SCHEMA-1: valid 4-segment id + 3-segment subMissionId passes ───────

await test('TC-SCHEMA-1: valid 4-segment id + 3-segment subMissionId passes', () => {
  const r = validateStructured(fixtureValidWithSubMissionId, reviewRemediationSchema);
  assert.equal(r.ok, true, `expected ok=true, got errors: ${JSON.stringify(r.errors)}`);
});

// ── TC-SCHEMA-2: wrong-format id fails pattern ────────────────────────────

await test('TC-SCHEMA-2: wrong-format id fails pattern', () => {
  const r = validateStructured(fixtureWrongFormatId, reviewRemediationSchema);
  assert.equal(r.ok, false, 'expected ok=false for wrong-format id');
  assert.ok(
    r.errors.some((e) => /pattern/.test(e) || /id/.test(e)),
    `expected a pattern or id error, got: ${JSON.stringify(r.errors)}`,
  );
});

// ── TC-SCHEMA-3: missing subMissionId fails required ─────────────────────

await test('TC-SCHEMA-3: missing subMissionId fails required', () => {
  const r = validateStructured(fixtureMissingSubMissionId, reviewRemediationSchema);
  assert.equal(r.ok, false, 'expected ok=false for missing subMissionId');
  assert.ok(
    r.errors.some((e) => /subMissionId/.test(e)),
    `expected a subMissionId error, got: ${JSON.stringify(r.errors)}`,
  );
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
