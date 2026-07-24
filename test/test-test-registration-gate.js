/**
 * test-test-registration-gate.js — Unit tests for checkTestRegistration gate.
 *
 * TC1: unregistered candidate file (no annotation) → passed:false with file in violations
 * TC2: all candidate files present in TEST_FILES → passed:true with empty violations
 * TC3: unregistered file with 'R2-OK: not-in-test-all' annotation in first 30 lines
 *      → passed:true (escape hatch)
 * TC4: candidates include non-test files (e.g. src/foo.js) — those are never in violations
 *      (strict scoping to test/test-*.js basenames only)
 *
 * Run: node test/test-test-registration-gate.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { checkTestRegistration } = await import('../src/orchestrator/gates/test-registration.js');

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
    failCount++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: create a temporary project root with a scripts/run-tests.js that
// exports a given TEST_FILES array.  Returns { projectRoot, cleanup }.
// Each call uses a unique directory so dynamic import() caching is avoided.
// ─────────────────────────────────────────────────────────────────────────────
function makeProjectRoot(testFilesEntries) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-reg-gate-'));
  const scriptsDir = path.join(tmpDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  // Serialise the array so that non-string entries (objects) are preserved.
  const serialised = JSON.stringify(testFilesEntries);
  const content = `export const TEST_FILES = ${serialised};\n`;
  fs.writeFileSync(path.join(scriptsDir, 'run-tests.js'), content, 'utf8');

  return {
    projectRoot: tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: write a real file inside a temp dir so the gate can read it.
// Returns the absolute path.
// ─────────────────────────────────────────────────────────────────────────────
function writeTestFile(dir, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

// ─────────────────────────────────────────────────────────────────────────────
// TC1: unregistered candidate file (no annotation) → passed:false, file in violations
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC1: unregistered candidate file (no annotation) → passed:false, file in violations',
  async () => {
    const { projectRoot, cleanup } = makeProjectRoot([]);

    try {
      // Create the candidate file in projectRoot/test/ with no annotation
      writeTestFile(projectRoot, 'test/test-unregistered.js', '// no annotation here\n');

      const candidates = [path.join(projectRoot, 'test', 'test-unregistered.js')];
      const result = await checkTestRegistration(candidates, null, projectRoot);

      assert.strictEqual(result.passed, false,
        `Expected passed:false but got passed:${result.passed}`);
      assert.strictEqual(result.violations.length, 1,
        `Expected 1 violation but got ${result.violations.length}: ${JSON.stringify(result.violations)}`);
      assert.ok(
        result.violations[0].includes('test-unregistered.js'),
        `Expected violation to include 'test-unregistered.js', got: ${result.violations[0]}`,
      );
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC2: all candidate files present in TEST_FILES → passed:true, violations empty
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC2: all candidate files present in TEST_FILES → passed:true, violations empty',
  async () => {
    const { projectRoot, cleanup } = makeProjectRoot(['test/test-registered.js']);

    try {
      writeTestFile(projectRoot, 'test/test-registered.js', '// registered test\n');

      const candidates = [path.join(projectRoot, 'test', 'test-registered.js')];
      const result = await checkTestRegistration(candidates, null, projectRoot);

      assert.strictEqual(result.passed, true,
        `Expected passed:true but got passed:${result.passed}`);
      assert.strictEqual(result.violations.length, 0,
        `Expected empty violations but got: ${JSON.stringify(result.violations)}`);
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC3: unregistered file with 'R2-OK: not-in-test-all' annotation in first 30
//      lines → passed:true (escape hatch)
// ─────────────────────────────────────────────────────────────────────────────
await test(
  "TC3: R2-OK escape-hatch annotation in first 30 lines → passed:true",
  async () => {
    const { projectRoot, cleanup } = makeProjectRoot([]);

    try {
      // Put the annotation on line 5, well within first 30 lines
      const annotatedContent = [
        '// line 1',
        '// line 2',
        '// line 3',
        '// line 4',
        '// R2-OK: not-in-test-all',
        '// line 6',
        "import assert from 'assert';",
      ].join('\n');

      writeTestFile(projectRoot, 'test/test-annotated.js', annotatedContent);

      const candidates = [path.join(projectRoot, 'test', 'test-annotated.js')];
      const result = await checkTestRegistration(candidates, null, projectRoot);

      assert.strictEqual(result.passed, true,
        `Expected passed:true (escape hatch) but got passed:${result.passed}`);
      assert.strictEqual(result.violations.length, 0,
        `Expected empty violations but got: ${JSON.stringify(result.violations)}`);
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC4: non-test-*.js files in candidates are strictly ignored — they never
//      appear in violations even when absent from TEST_FILES
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC4: non-test-*.js candidates (e.g. src/foo.js) never appear in violations',
  async () => {
    // TEST_FILES is empty — any scoped file would be a violation
    const { projectRoot, cleanup } = makeProjectRoot([]);

    try {
      // Write a src file that would be a violation if scoping were wrong
      writeTestFile(projectRoot, 'src/foo.js', '// src file, not a test\n');

      const candidates = [
        path.join(projectRoot, 'src', 'foo.js'),
        // Also include a plain JS file that doesn't match test/test-*.js
        path.join(projectRoot, 'lib', 'helper.js'),
      ];

      const result = await checkTestRegistration(candidates, null, projectRoot);

      // No test/test-*.js files in candidates → nothing to violate
      assert.strictEqual(result.passed, true,
        `Expected passed:true for non-test candidates but got passed:${result.passed}`);
      assert.strictEqual(result.violations.length, 0,
        `Expected empty violations but got: ${JSON.stringify(result.violations)}`);

      // Explicitly confirm the src file is not mentioned in violations
      const mentionsFoo = result.violations.some(v => v.includes('foo.js'));
      assert.strictEqual(mentionsFoo, false,
        'src/foo.js must never appear in violations (strict scoping to test/test-*.js)');
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC5 (A1 core fix): a nested-directory test, correctly registered with its full
//      project-relative path, must PASS. Before A1 the lookup key was truncated
//      at 'test/test-' so the nested entry could never match → false violation.
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC5: nested-dir test registered with full project-relative path → passed:true (A1 fix)',
  async () => {
    const { projectRoot, cleanup } = makeProjectRoot(['dogfood-scratch/test/test-strings.js']);

    try {
      writeTestFile(projectRoot, 'dogfood-scratch/test/test-strings.js', '// nested, registered\n');

      // candidate arrives as an absolute path (the targetFiles/affected common case)
      const candidates = [path.join(projectRoot, 'dogfood-scratch', 'test', 'test-strings.js')];
      const result = await checkTestRegistration(candidates, null, projectRoot);

      assert.strictEqual(result.passed, true,
        `Nested registered test must pass; got passed:${result.passed}, violations:${JSON.stringify(result.violations)}`);
      assert.strictEqual(result.violations.length, 0,
        `Expected empty violations but got: ${JSON.stringify(result.violations)}`);
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC6: candidate supplied as a RELATIVE string (the affectedFiles-style spelling)
//      must also normalise and match a relative TEST_FILES entry → passed:true.
//      Confirms the canonical is spelling-independent on the candidate side too.
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC6: relative candidate string matches relative nested TEST_FILES entry → passed:true',
  async () => {
    const { projectRoot, cleanup } = makeProjectRoot(['packages/x/test/test-y.js']);

    try {
      writeTestFile(projectRoot, 'packages/x/test/test-y.js', '// nested, registered\n');

      // candidate is a bare project-relative string, NOT absolute
      const candidates = ['packages/x/test/test-y.js'];
      const result = await checkTestRegistration(candidates, null, projectRoot);

      assert.strictEqual(result.passed, true,
        `Relative candidate must match; got passed:${result.passed}, violations:${JSON.stringify(result.violations)}`);
      assert.strictEqual(result.violations.length, 0,
        `Expected empty violations but got: ${JSON.stringify(result.violations)}`);
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC7: a nested-dir test that is NOT registered → violation, and the violation
//      label is reported as the project-relative path (readable), not absolute
//      and not the old truncated key.
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC7: unregistered nested-dir test → violation labelled with project-relative path',
  async () => {
    const { projectRoot, cleanup } = makeProjectRoot([]); // nothing registered

    try {
      writeTestFile(projectRoot, 'sub/test/test-orphan.js', '// no annotation\n');

      const candidates = [path.join(projectRoot, 'sub', 'test', 'test-orphan.js')];
      const result = await checkTestRegistration(candidates, null, projectRoot);

      assert.strictEqual(result.passed, false,
        `Unregistered nested test must fail; got passed:${result.passed}`);
      assert.strictEqual(result.violations.length, 1,
        `Expected 1 violation but got: ${JSON.stringify(result.violations)}`);
      assert.strictEqual(result.violations[0].replace(/\\/g, '/'), 'sub/test/test-orphan.js',
        `Violation label must be the project-relative path, got: ${result.violations[0]}`);
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC8 (anti-regression): same basename in a DIFFERENT directory must NOT
//      false-pass. Guards against degrading the canonical into basename-only
//      matching (rejected candidate 2): a/test/test-dup.js registered must not
//      satisfy b/test/test-dup.js.
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC8: same basename in a different directory → still a violation (no basename false-pass)',
  async () => {
    const { projectRoot, cleanup } = makeProjectRoot(['packages/a/test/test-dup.js']);

    try {
      // The registered file lives under packages/a; the candidate is the
      // same basename under packages/b and is NOT registered.
      writeTestFile(projectRoot, 'packages/b/test/test-dup.js', '// different dir, unregistered\n');

      const candidates = [path.join(projectRoot, 'packages', 'b', 'test', 'test-dup.js')];
      const result = await checkTestRegistration(candidates, null, projectRoot);

      assert.strictEqual(result.passed, false,
        `Same basename in a different dir must NOT false-pass; got passed:${result.passed}`);
      assert.strictEqual(result.violations[0].replace(/\\/g, '/'), 'packages/b/test/test-dup.js',
        `Expected the b/ path as the violation, got: ${result.violations[0]}`);
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
