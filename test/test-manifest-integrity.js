/**
 * test-manifest-integrity.js — Meta-test that keeps the test/ directory and
 * scripts/run-tests.js's TEST_FILES manifest honest with each other.
 *
 * Invariants enforced:
 *   (a) Every test/test-*.js file discovered on disk (excluding
 *       test/helpers/ and anything not matching the test-*.js basename
 *       pattern) is either registered in TEST_FILES or explicitly listed in
 *       scripts/test-exemptions.json.
 *   (b) Every TEST_FILES entry resolves to a file that actually exists on
 *       disk (no dangling registrations).
 *
 * This file imports TEST_FILES via a plain static ESM import from
 * scripts/run-tests.js. Because run-tests.js gates its suite-execution block
 * behind an `isMain` check on process.argv[1], importing it here does not
 * spawn or execute any of the registered test files — this meta-test runs
 * entirely in-process.
 *
 * Run: node test/test-manifest-integrity.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { TEST_FILES } from '../scripts/run-tests.js';
import { runTestRegistrationGate } from '../src/orchestrator/core/verification-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

async function asyncTest(name, fn) {
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

/**
 * Read the flat exemption list from scripts/test-exemptions.json. This is
 * the ONLY exemption source consulted by this meta-test — no in-file
 * annotations, comments, or other markers are honored.
 * @returns {Array<{ file: string, reason: string }>}
 */
function readExemptions() {
  const exemptionsPath = path.join(repoRoot, 'scripts', 'test-exemptions.json');
  const raw = fs.readFileSync(exemptionsPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected ${exemptionsPath} to contain a flat array of { file, reason } entries, got: ${typeof parsed}`
    );
  }
  return parsed;
}

/**
 * List the test-*.js files directly under test/ (non-recursive), so
 * test/helpers/ (and any other subdirectory) is excluded, along with any
 * top-level file whose basename does not match test-*.js.
 * @returns {string[]} project-relative paths, e.g. 'test/test-foo.js'
 */
function discoverTestFiles() {
  const testDir = path.join(repoRoot, 'test');
  const entries = fs.readdirSync(testDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^test-.*\.js$/.test(entry.name))
    .map((entry) => `test/${entry.name}`)
    .sort();
}

// ──────────────────────────────────────────────────────────────────────
// TC1 (invariant a): every discovered test file is registered or exempted.
// Membership is decided from TEST_FILES and scripts/test-exemptions.json
// ONLY — the contents of discovered files are never read, so no in-file
// annotation can satisfy this invariant.
// ──────────────────────────────────────────────────────────────────────
test('TC1: every discovered test/test-*.js file is registered in TEST_FILES or exempted', () => {
  const discovered = discoverTestFiles();
  const registered = new Set(TEST_FILES);
  const exemptions = readExemptions();
  const exempted = new Set(exemptions.map((entry) => entry.file));

  const unregistered = discovered.filter(
    (file) => !registered.has(file) && !exempted.has(file)
  );

  assert.deepStrictEqual(
    unregistered,
    [],
    `Found ${unregistered.length} discovered test file(s) in test/ that are neither ` +
      `registered in scripts/run-tests.js TEST_FILES nor listed in ` +
      `scripts/test-exemptions.json: ${unregistered.join(', ')}`
  );
});

// ──────────────────────────────────────────────────────────────────────
// TC2 (invariant b): every TEST_FILES entry resolves to a file on disk.
// ──────────────────────────────────────────────────────────────────────
test('TC2: every TEST_FILES entry resolves to a file that exists on disk', () => {
  const dangling = TEST_FILES.filter((entry) => {
    const filePath = path.join(repoRoot, entry);
    return !fs.existsSync(filePath);
  });

  assert.deepStrictEqual(
    dangling,
    [],
    `Found ${dangling.length} TEST_FILES entry/entries in scripts/run-tests.js with no ` +
      `corresponding file on disk: ${dangling.join(', ')}`
  );
});

// ──────────────────────────────────────────────────────────────────────
// TC3 (invariant c): exemption entries must resolve to real files on disk,
// AND must be mutually exclusive with TEST_FILES — a path cannot be both
// exempt and registered. Uses the same readExemptions() reader (backed by
// scripts/test-exemptions.json) as TC1; no second exemption source.
// ──────────────────────────────────────────────────────────────────────
test('TC3: every exemption resolves to a file on disk and no exemption is also registered in TEST_FILES', () => {
  const exemptions = readExemptions();
  const registered = new Set(TEST_FILES);

  const missing = exemptions
    .map((entry) => entry.file)
    .filter((file) => !fs.existsSync(path.join(repoRoot, file)));

  const bothExemptAndRegistered = exemptions
    .map((entry) => entry.file)
    .filter((file) => registered.has(file));

  const offending = [...missing, ...bothExemptAndRegistered];

  assert.deepStrictEqual(
    offending,
    [],
    `Found exemption path(s) in scripts/test-exemptions.json that violate invariant (c): ` +
      `missing from disk: [${missing.join(', ')}]; ` +
      `both exempt and registered in TEST_FILES: [${bothExemptAndRegistered.join(', ')}]`
  );
});

// ──────────────────────────────────────────────────────────────────────
// TC4 (invariant d): every TEST_FILES element must be a plain string —
// the previously supported npm-shaped ({ npm: true, args: [...] }) entry
// can never reappear.
// ──────────────────────────────────────────────────────────────────────
test('TC4: every TEST_FILES entry is a plain string (no npm-shaped entries)', () => {
  const nonString = TEST_FILES.filter((entry) => typeof entry !== 'string');

  assert.deepStrictEqual(
    nonString,
    [],
    `Found non-string TEST_FILES entry/entries in scripts/run-tests.js (npm-shaped entries ` +
      `are no longer supported): ${JSON.stringify(nonString)}`
  );
});

// ──────────────────────────────────────────────────────────────────────
// TC5: test/test-milestone-only-hardening.js must not exist on disk.
// ──────────────────────────────────────────────────────────────────────
test('TC5: test/test-milestone-only-hardening.js does not exist on disk', () => {
  const staleFile = path.join(repoRoot, 'test', 'test-milestone-only-hardening.js');

  assert.strictEqual(
    fs.existsSync(staleFile),
    false,
    `Expected test/test-milestone-only-hardening.js to not exist on disk, but it does: ${staleFile}`
  );
});

// ──────────────────────────────────────────────────────────────────────
// TC6 (gate-side exemption, positive case): a task whose targetFiles names
// the exempted test/test-signal-handler-integration.js must pass the
// registration gate, and the exempted path must not appear among any
// violations — proving the exemption filter removes it from the candidate
// set before checkTestRegistration ever sees it.
// ──────────────────────────────────────────────────────────────────────
await asyncTest('TC6: runTestRegistrationGate passes for the exempted test/test-signal-handler-integration.js', async () => {
  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-integrity-tc6-'));
  try {
    const task = { id: '001-003-001-003-tc6', targetFiles: ['test/test-signal-handler-integration.js'] };
    const result = await runTestRegistrationGate(task, harnessRoot, repoRoot, () => {});

    assert.strictEqual(
      result.passed,
      true,
      `Expected passed:true for the exempted test/test-signal-handler-integration.js, got: ${JSON.stringify(result)}`
    );
    assert.ok(
      !(result.violations || []).some((v) => v.includes('test-signal-handler-integration.js')),
      `Expected no violation naming test/test-signal-handler-integration.js, got: ${JSON.stringify(result)}`
    );
  } finally {
    fs.rmSync(harnessRoot, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────
// TC7 (gate-side exemption, negative case): a task whose targetFiles names
// a novel, unregistered, unexempted test path must still fail the gate,
// with that path reported among the violations — proving non-exempt
// behavior is unchanged by the exemption filter. This probe path is
// deliberately never written to disk.
// ──────────────────────────────────────────────────────────────────────
await asyncTest('TC7: runTestRegistrationGate fails for a novel unregistered, unexempted test path', async () => {
  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-integrity-tc7-'));
  try {
    const probePath = 'test/test-zz-nonexistent-probe.js';
    const task = { id: '001-003-001-003-tc7', targetFiles: [probePath] };
    const result = await runTestRegistrationGate(task, harnessRoot, repoRoot, () => {});

    assert.strictEqual(
      result.passed,
      false,
      `Expected passed:false for the novel unregistered path ${probePath}, got: ${JSON.stringify(result)}`
    );
    assert.ok(
      (result.violations || []).includes(probePath),
      `Expected violations to include ${probePath}, got: ${JSON.stringify(result)}`
    );
  } finally {
    fs.rmSync(harnessRoot, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
