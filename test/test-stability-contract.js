/**
 * test-stability-contract.js — Contract tests for index.js public surface stability.
 *
 * Asserts that the named exports of index.js exactly match the expected set,
 * that HarnessShell is absent, that package.json exports are pinned, and that
 * every schema/helper from _schemas.js is re-exported.
 *
 * Run: node test/test-stability-contract.js
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

const EXPECTED = [
  'Pipeline',
  'SessionManager',
  'SessionHandle',
  'Logger',
  'TokenTracker',
  'config',
  'Planner',
  'Executor',
  'Verifier',
  'Analyzer',
  'Reviewer',
  'Summarizer',
  'Brainstormer',
  'verifierSchema',
  'analyzerSchema',
  'executorSchema',
  'summarizerSchema',
  'reviewerSchema',
  'assumptionRemediationSchema',
  'reviewRemediationSchema',
  'taskReplanSchema',
  'brainstormSpecSchema',
  'extractStructured',
  'validateStructured',
];

const SCHEMA_HELPER_NAMES = [
  'verifierSchema',
  'analyzerSchema',
  'executorSchema',
  'summarizerSchema',
  'reviewerSchema',
  'assumptionRemediationSchema',
  'reviewRemediationSchema',
  'taskReplanSchema',
  'brainstormSpecSchema',
  'extractStructured',
  'validateStructured',
];

// ── TC1: index.js exports exactly the expected set ────────────────────────

const mod = await import('../index.js');

test('TC1 index.js exports exactly the expected set', () => {
  const actual = Object.keys(mod).sort();
  const expected = [...EXPECTED].sort();
  assert.deepStrictEqual(actual, expected);
});

// ── TC2: HarnessShell is absent from index.js exports ────────────────────

test('TC2 HarnessShell is absent from index.js exports', () => {
  assert.ok(!('HarnessShell' in mod));
});

// ── TC3: package.json exports field is exactly { '.': './index.js' } ──────

test("TC3 package.json exports field is exactly { '.': './index.js' }", () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
  assert.ok(pkg.exports !== null && typeof pkg.exports === 'object', 'pkg.exports must be an object');
  assert.strictEqual(pkg.exports['.'], './index.js');
  assert.strictEqual(Object.keys(pkg.exports).length, 1);
});

// ── TC4: every schema/helper from _schemas.js is re-exported by index.js ──

test('TC4 every schema/helper from _schemas.js is re-exported by index.js', () => {
  for (const name of SCHEMA_HELPER_NAMES) {
    assert.ok(name in mod, name);
  }
});

// ── TC5: test is self-contained (no top-level exports) ────────────────────

test('TC5 test is self-contained', () => {
  const src = readFileSync(__filename, 'utf8');
  assert.ok(!/^export /m.test(src), 'test file must not contain top-level export statements');
});

const STABILITY_DOC = readFileSync(resolve(__dirname, '../docs/STABILITY-CONTRACT.md'), 'utf8');

const BUNDLE_SCHEMA_FIELDS = [
  'schemaVersion',
  'generatedBy',
  'baseCommit',
  'entries',
  'id',
  'kind',
  'text',
  'evidence',
  'file',
  'symbol',
  'lastScannedCommit',
];

// ── TC6: 'Pro integration surface' section heading is documented ──────────

test("TC6 'Pro integration surface' section heading is documented", () => {
  assert.ok(STABILITY_DOC.includes('Pro integration surface'), "STABILITY-CONTRACT.md must contain the 'Pro integration surface' heading");
});

// ── TC7: every v0 bundle schema field is pinned in the doc ────────────────

test('TC7 every v0 bundle schema field is pinned in the doc', () => {
  for (const field of BUNDLE_SCHEMA_FIELDS) {
    assert.ok(STABILITY_DOC.includes(field), `STABILITY-CONTRACT.md must pin bundle schema field: ${field}`);
  }
});

// ── TC8: memory/ lifecycle guarantee is documented ────────────────────────

test('TC8 memory/ lifecycle guarantee is documented', () => {
  assert.ok(STABILITY_DOC.includes('memory/'), "STABILITY-CONTRACT.md must contain the literal token 'memory/'");
  assert.ok(/survives every core cleanup operation/.test(STABILITY_DOC), 'STABILITY-CONTRACT.md must document that memory/ survives cleanup');
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
