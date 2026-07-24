/**
 * test-schemas-verification.js — Contract tests for the brainstormSpecSchema
 * `verification` object on each acceptance_criteria item.
 *
 * The schema does the FLAT part of the enforcement split:
 *   - `verification` is REQUIRED on every acceptance_criteria item
 *   - `verification.kind` is an enum (command | file-check | manual)
 *   - `verification.command` / `targetFile` / `manualSteps` are FLAT optional
 *     sub-fields (per-kind conditionality is NOT in the schema — it lives in
 *     extractBrainstormResult).
 *
 * No Claude auth, no SDK. Feeds fixture objects through validateStructured.
 *
 * Run: node test/test-schemas-verification.js
 */
import assert from 'assert';
import {
  brainstormSpecSchema,
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

const specCommandKind = {
  goal: 'Add a verification-bearing criterion',
  target_files: ['src/foo.js'],
  acceptance_criteria: [
    {
      description: 'foo works',
      verification: { kind: 'command', command: 'node test/foo.js', targetFile: 'test/foo.js' },
    },
  ],
};

const specFileCheckKind = {
  goal: 'file-check criterion',
  target_files: ['src/foo.js'],
  acceptance_criteria: [
    {
      description: 'config exists',
      verification: { kind: 'file-check', targetFile: 'src/foo.js' },
    },
  ],
};

const specManualKind = {
  goal: 'manual criterion',
  target_files: ['src/foo.js'],
  acceptance_criteria: [
    {
      description: 'UI looks right',
      verification: { kind: 'manual', manualSteps: 'Open the page and confirm the banner renders.' },
    },
  ],
};

const specMissingVerification = {
  goal: 'criterion with no verification',
  target_files: ['src/foo.js'],
  acceptance_criteria: [{ description: 'something happens' }],
};

const specBadKind = {
  goal: 'criterion with invalid kind',
  target_files: ['src/foo.js'],
  acceptance_criteria: [
    { description: 'bad kind', verification: { kind: 'shell' } },
  ],
};

const specVerificationNotObject = {
  goal: 'verification is a string',
  target_files: ['src/foo.js'],
  acceptance_criteria: [
    { description: 'wrong type', verification: 'node test/foo.js' },
  ],
};

// ── TC1: command-kind verification validates ──────────────────────────────

await test('TC1: command-kind verification → ok:true', () => {
  const r = validateStructured(specCommandKind, brainstormSpecSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── TC2: file-check-kind verification validates ───────────────────────────

await test('TC2: file-check-kind verification → ok:true', () => {
  const r = validateStructured(specFileCheckKind, brainstormSpecSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── TC3: manual-kind verification validates ───────────────────────────────

await test('TC3: manual-kind verification → ok:true', () => {
  const r = validateStructured(specManualKind, brainstormSpecSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── TC4: missing verification → ok:false (verification required) ──────────

await test('TC4: acceptance_criteria item missing verification → ok:false', () => {
  const r = validateStructured(specMissingVerification, brainstormSpecSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /verification/.test(e) && /missing/.test(e)),
    `expected a 'verification: missing' error, got: ${JSON.stringify(r.errors)}`
  );
});

// ── TC5: kind not in enum → ok:false ──────────────────────────────────────

await test('TC5: verification.kind not in enum → ok:false', () => {
  const r = validateStructured(specBadKind, brainstormSpecSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /kind/.test(e) && /enum/.test(e)),
    `expected an enum error on kind, got: ${JSON.stringify(r.errors)}`
  );
});

// ── TC6: verification of wrong type (string) → ok:false ───────────────────

await test('TC6: verification is a string instead of object → ok:false', () => {
  const r = validateStructured(specVerificationNotObject, brainstormSpecSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /verification/.test(e) && /expected object/.test(e)),
    `expected 'verification: expected object' error, got: ${JSON.stringify(r.errors)}`
  );
});

// ── TC7: schema shape — kind is an enum, sub-fields are flat optional ─────

await test('TC7: schema declares verification flatly (kind enum + optional sub-fields)', () => {
  const item = brainstormSpecSchema.properties.acceptance_criteria.items;
  // verification required on the item
  assert.ok(
    Array.isArray(item.required) && item.required.includes('verification'),
    'acceptance_criteria item must require "verification"'
  );
  const v = item.properties.verification;
  assert.ok(v && v.type === 'object', 'verification must be an object schema node');
  // kind is an enum of exactly the three kinds
  assert.deepStrictEqual(
    v.properties.kind.enum,
    ['command', 'file-check', 'manual'],
    'kind enum must be [command, file-check, manual]'
  );
  // verification itself only requires kind (sub-fields are flat optional)
  assert.deepStrictEqual(
    v.required,
    ['kind'],
    'verification must require only "kind" — sub-fields are flat optional (no per-kind conditionality)'
  );
  // sub-fields are declared but optional
  assert.equal(v.properties.command.type, 'string', 'command sub-field declared as string');
  assert.equal(v.properties.targetFile.type, 'string', 'targetFile sub-field declared as string');
  assert.equal(v.properties.manualSteps.type, 'string', 'manualSteps sub-field declared as string');
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
