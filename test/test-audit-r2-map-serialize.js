/**
 * test-audit-r2-map-serialize.js — Tests for mapToObject serialization helper
 * in scripts/audit-r2.js.
 *
 * TC1: mapToObject converts entries — builds coveredDefects and exemptDefects
 *      Maps, calls mapToObject on each, round-trips through JSON, and asserts
 *      parsed objects are non-empty and carry the expected entries.
 *
 * TC2: assembled defectCoverage shape round-trips — builds a defectCoverage
 *      object with mapToObject-converted Maps, JSON.stringify-then-parse, and
 *      asserts parsed.coveredDefects and parsed.exemptDefects are non-empty
 *      objects with the expected keys/values.
 *
 * TC3: negative control: raw Map serializes to {} — documents why the helper
 *      is necessary by asserting JSON.parse(JSON.stringify(new Map(...)))
 *      produces an empty object.
 *
 * TC4: mapToObject on empty Map — asserts mapToObject(new Map()) deep-equals {}.
 *
 * Run: node test/test-audit-r2-map-serialize.js
 */
import assert from 'assert';
import { mapToObject } from '../scripts/audit-r2.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failCount++;
    }
  );
}

// ── TC1: mapToObject converts entries ───────────────────────────────────────

await test('TC1 mapToObject converts entries', async () => {
  const coveredDefects = new Map([[12, 'inv-alpha'], [34, 'inv-beta']]);
  const exemptDefects = new Map([[7, 'known-safe reason']]);

  const parsedCovered = JSON.parse(JSON.stringify(mapToObject(coveredDefects)));
  const parsedExempt = JSON.parse(JSON.stringify(mapToObject(exemptDefects)));

  // coveredDefects assertions
  assert.strictEqual(Object.keys(parsedCovered).length, 2,
    'parsedCovered should have 2 keys');
  assert.strictEqual(parsedCovered['12'], 'inv-alpha',
    "parsedCovered['12'] should be 'inv-alpha'");
  assert.strictEqual(parsedCovered['34'], 'inv-beta',
    "parsedCovered['34'] should be 'inv-beta'");

  // exemptDefects assertions
  assert.strictEqual(Object.keys(parsedExempt).length, 1,
    'parsedExempt should have 1 key');
  assert.strictEqual(parsedExempt['7'], 'known-safe reason',
    "parsedExempt['7'] should be 'known-safe reason'");
});

// ── TC2: assembled defectCoverage shape round-trips ─────────────────────────

await test('TC2 assembled defectCoverage shape round-trips', async () => {
  const coveredDefects = new Map([[12, 'inv-alpha'], [34, 'inv-beta']]);
  const exemptDefects = new Map([[7, 'known-safe reason']]);

  const defectCoverage = {
    allDefects: [7, 12, 34],
    coveredDefects: mapToObject(coveredDefects),
    exemptDefects: mapToObject(exemptDefects),
    uncoveredDefects: [],
  };

  const parsed = JSON.parse(JSON.stringify(defectCoverage));

  // coveredDefects should be a non-empty object
  assert.ok(parsed.coveredDefects !== null && typeof parsed.coveredDefects === 'object',
    'parsed.coveredDefects should be an object');
  assert.ok(Object.keys(parsed.coveredDefects).length > 0,
    'parsed.coveredDefects should be non-empty');
  assert.strictEqual(parsed.coveredDefects['12'], 'inv-alpha',
    "parsed.coveredDefects['12'] should be 'inv-alpha'");
  assert.strictEqual(parsed.coveredDefects['34'], 'inv-beta',
    "parsed.coveredDefects['34'] should be 'inv-beta'");

  // exemptDefects should be a non-empty object
  assert.ok(parsed.exemptDefects !== null && typeof parsed.exemptDefects === 'object',
    'parsed.exemptDefects should be an object');
  assert.ok(Object.keys(parsed.exemptDefects).length > 0,
    'parsed.exemptDefects should be non-empty');
  assert.strictEqual(parsed.exemptDefects['7'], 'known-safe reason',
    "parsed.exemptDefects['7'] should be 'known-safe reason'");
});

// ── TC3: negative control: raw Map serializes to {} ─────────────────────────

await test('TC3 negative control: raw Map serializes to {}', async () => {
  const rawResult = JSON.parse(JSON.stringify(new Map([[1, 'x']])));
  assert.strictEqual(Object.keys(rawResult).length, 0,
    'raw Map should serialize to {} — this is why mapToObject is necessary');
  assert.deepStrictEqual(rawResult, {},
    'raw Map JSON round-trip should deep-equal {}');
});

// ── TC4: mapToObject on empty Map ────────────────────────────────────────────

await test('TC4 mapToObject on empty Map', async () => {
  const result = mapToObject(new Map());
  assert.deepStrictEqual(result, {},
    'mapToObject(new Map()) should deep-equal {}');
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
