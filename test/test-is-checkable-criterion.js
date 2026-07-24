/**
 * test-is-checkable-criterion.js — Unit tests for the exported
 * `isCheckableCriterion` function.
 *
 * Run: node test/test-is-checkable-criterion.js
 */
import assert from 'assert';
import { isCheckableCriterion } from '../src/orchestrator/agents/planner.js';

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

// TC1: kind=command with command present → true
await test('TC1: {verification:{kind:"command",command:"echo hi"}} → true', () => {
  assert.strictEqual(isCheckableCriterion({ verification: { kind: 'command', command: 'echo hi' } }), true);
});

// TC2: kind=file-check with targetFile present → true
await test('TC2: {verification:{kind:"file-check",targetFile:"f.js"}} → true', () => {
  assert.strictEqual(isCheckableCriterion({ verification: { kind: 'file-check', targetFile: 'f.js' } }), true);
});

// TC3: kind=manual → true
await test('TC3: {verification:{kind:"manual"}} → true', () => {
  assert.strictEqual(isCheckableCriterion({ verification: { kind: 'manual' } }), true);
});

// TC4: verification is empty object → false
await test('TC4: {verification:{}} → false (empty object)', () => {
  assert.strictEqual(isCheckableCriterion({ verification: {} }), false);
});

// TC5: kind=command but missing command field → false
await test('TC5: {verification:{kind:"command"}} → false (missing command)', () => {
  assert.strictEqual(isCheckableCriterion({ verification: { kind: 'command' } }), false);
});

// TC6: kind=file-check but missing targetFile → false
await test('TC6: {verification:{kind:"file-check"}} → false (missing targetFile)', () => {
  assert.strictEqual(isCheckableCriterion({ verification: { kind: 'file-check' } }), false);
});

// TC7: kind is a typo/unknown → false
await test('TC7: {verification:{kind:"typo"}} → false', () => {
  assert.strictEqual(isCheckableCriterion({ verification: { kind: 'typo' } }), false);
});

// TC8: null → false
await test('TC8: null → false', () => {
  assert.strictEqual(isCheckableCriterion(null), false);
});

// TC9: empty object → false
await test('TC9: {} → false', () => {
  assert.strictEqual(isCheckableCriterion({}), false);
});

// TC10: verification is null → false
await test('TC10: {verification:null} → false', () => {
  assert.strictEqual(isCheckableCriterion({ verification: null }), false);
});

// TC11: verification is an array → false
await test('TC11: {verification:[]} → false (array)', () => {
  assert.strictEqual(isCheckableCriterion({ verification: [] }), false);
});

// TC12: string input → false
await test('TC12: "string" → false', () => {
  assert.strictEqual(isCheckableCriterion('string'), false);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
