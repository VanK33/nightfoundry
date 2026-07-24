/**
 * test-brainstormer-evidence-contract.js — Imperative per-kind enforcement
 * tests for extractBrainstormResult's verification contract.
 *
 * The schema only does the FLAT part (verification required, kind enum). The
 * per-kind required sub-fields + `targetFile ∈ target_files` enforcement is
 * hand-coded imperatively in extractBrainstormResult and must throw
 * BRAINSTORM_VALIDATION_FAILED on violations:
 *   - kind=command   ⇒ requires command + targetFile
 *   - kind=file-check ⇒ requires targetFile
 *   - kind=manual    ⇒ requires manualSteps
 *   - command/file-check targetFile MUST be one of spec.target_files
 *
 * No Claude auth, no SDK.
 *
 * Run: node test/test-brainstormer-evidence-contract.js
 */
import assert from 'assert';
import { extractBrainstormResult } from '../src/orchestrator/agents/brainstormer.js';

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

// ── Helpers ────────────────────────────────────────────────────────────

function sdkResultFor(acceptanceCriteria, targetFiles = ['src/foo.js', 'test/foo.js']) {
  return {
    structured_output: {
      spec: {
        goal: 'A verification-bearing spec',
        target_files: targetFiles,
        acceptance_criteria: acceptanceCriteria,
      },
      specMd: '# Spec\n\nNarrative.',
    },
  };
}

function expectThrow(fn) {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  return thrown;
}

// ── Valid inputs (pass) ───────────────────────────────────────────────────

await test('command kind with command + targetFile ∈ target_files → passes', () => {
  const sdk = sdkResultFor([
    { description: 'foo works', verification: { kind: 'command', command: 'node test/foo.js', targetFile: 'test/foo.js' } },
  ]);
  const out = extractBrainstormResult(sdk, { warn: () => {} });
  assert.equal(out.spec.acceptance_criteria[0].verification.kind, 'command');
});

await test('file-check kind with targetFile ∈ target_files → passes', () => {
  const sdk = sdkResultFor([
    { description: 'file present', verification: { kind: 'file-check', targetFile: 'src/foo.js' } },
  ]);
  const out = extractBrainstormResult(sdk, { warn: () => {} });
  assert.equal(out.spec.acceptance_criteria[0].verification.kind, 'file-check');
});

await test('manual kind with manualSteps → passes', () => {
  const sdk = sdkResultFor([
    { description: 'UI looks right', verification: { kind: 'manual', manualSteps: 'Open page, confirm banner.' } },
  ]);
  const out = extractBrainstormResult(sdk, { warn: () => {} });
  assert.equal(out.spec.acceptance_criteria[0].verification.kind, 'manual');
});

// ── Directory-pattern target_files (trailing-slash) coverage ────────────────
// target_files legitimately mixes literal paths and directory patterns
// ("test/"). A concrete file UNDER such a directory must be accepted — it was
// wrongly hard-rejected by an exact-membership check before the fix.

await test('command kind targetFile under a trailing-slash dir entry → passes', () => {
  const sdk = sdkResultFor(
    [{ description: 'foo works', verification: { kind: 'command', command: 'node test/foo.js', targetFile: 'test/foo.js' } }],
    ['src/foo.js', 'test/'],
  );
  const out = extractBrainstormResult(sdk, { warn: () => {} });
  assert.equal(out.spec.acceptance_criteria[0].verification.targetFile, 'test/foo.js');
});

await test('file-check kind targetFile under a trailing-slash dir entry → passes', () => {
  const sdk = sdkResultFor(
    [{ description: 'fixture present', verification: { kind: 'file-check', targetFile: 'test/fixtures/x.json' } }],
    ['src/foo.js', 'test/'],
  );
  const out = extractBrainstormResult(sdk, { warn: () => {} });
  assert.equal(out.spec.acceptance_criteria[0].verification.targetFile, 'test/fixtures/x.json');
});

await test('command kind targetFile neither literal nor under any dir entry → throws', () => {
  // "lib/bar.js" is not a literal target_files entry and not under "test/"
  const sdk = sdkResultFor(
    [{ description: 'stray', verification: { kind: 'command', command: 'node lib/bar.js', targetFile: 'lib/bar.js' } }],
    ['src/foo.js', 'test/'],
  );
  const thrown = expectThrow(() => extractBrainstormResult(sdk, { warn: () => {} }));
  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(thrown.code, 'BRAINSTORM_VALIDATION_FAILED');
  assert.ok(
    thrown.errors.some((e) => /targetFile/.test(e) && /target_files/.test(e)),
    `errors should mention targetFile not in target_files; got: ${JSON.stringify(thrown.errors)}`
  );
});

// ── command-kind violations ────────────────────────────────────────────────

await test('command kind missing command → throws BRAINSTORM_VALIDATION_FAILED', () => {
  const sdk = sdkResultFor([
    { description: 'no command', verification: { kind: 'command', targetFile: 'test/foo.js' } },
  ]);
  const thrown = expectThrow(() => extractBrainstormResult(sdk, { warn: () => {} }));
  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(thrown.code, 'BRAINSTORM_VALIDATION_FAILED');
  assert.ok(
    thrown.errors.some((e) => /command/.test(e)),
    `errors should mention command; got: ${JSON.stringify(thrown.errors)}`
  );
});

await test('command kind missing targetFile → throws BRAINSTORM_VALIDATION_FAILED', () => {
  const sdk = sdkResultFor([
    { description: 'no targetFile', verification: { kind: 'command', command: 'node test/foo.js' } },
  ]);
  const thrown = expectThrow(() => extractBrainstormResult(sdk, { warn: () => {} }));
  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(thrown.code, 'BRAINSTORM_VALIDATION_FAILED');
  assert.ok(
    thrown.errors.some((e) => /targetFile/.test(e)),
    `errors should mention targetFile; got: ${JSON.stringify(thrown.errors)}`
  );
});

// ── file-check-kind violations ──────────────────────────────────────────────

await test('file-check kind missing targetFile → throws BRAINSTORM_VALIDATION_FAILED', () => {
  const sdk = sdkResultFor([
    { description: 'no targetFile', verification: { kind: 'file-check' } },
  ]);
  const thrown = expectThrow(() => extractBrainstormResult(sdk, { warn: () => {} }));
  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(thrown.code, 'BRAINSTORM_VALIDATION_FAILED');
  assert.ok(
    thrown.errors.some((e) => /targetFile/.test(e)),
    `errors should mention targetFile; got: ${JSON.stringify(thrown.errors)}`
  );
});

// ── manual-kind violations ──────────────────────────────────────────────────

await test('manual kind missing manualSteps → throws BRAINSTORM_VALIDATION_FAILED', () => {
  const sdk = sdkResultFor([
    { description: 'no steps', verification: { kind: 'manual' } },
  ]);
  const thrown = expectThrow(() => extractBrainstormResult(sdk, { warn: () => {} }));
  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(thrown.code, 'BRAINSTORM_VALIDATION_FAILED');
  assert.ok(
    thrown.errors.some((e) => /manualSteps/.test(e)),
    `errors should mention manualSteps; got: ${JSON.stringify(thrown.errors)}`
  );
});

// ── targetFile ∉ target_files violations ─────────────────────────────────────

await test('command kind targetFile not in target_files → throws BRAINSTORM_VALIDATION_FAILED', () => {
  const sdk = sdkResultFor([
    { description: 'stray targetFile', verification: { kind: 'command', command: 'node test/bar.js', targetFile: 'test/bar.js' } },
  ]);
  const thrown = expectThrow(() => extractBrainstormResult(sdk, { warn: () => {} }));
  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(thrown.code, 'BRAINSTORM_VALIDATION_FAILED');
  assert.ok(
    thrown.errors.some((e) => /targetFile/.test(e) && /target_files/.test(e)),
    `errors should mention targetFile not in target_files; got: ${JSON.stringify(thrown.errors)}`
  );
});

await test('file-check kind targetFile not in target_files → throws BRAINSTORM_VALIDATION_FAILED', () => {
  const sdk = sdkResultFor([
    { description: 'stray targetFile', verification: { kind: 'file-check', targetFile: 'src/nope.js' } },
  ]);
  const thrown = expectThrow(() => extractBrainstormResult(sdk, { warn: () => {} }));
  assert.ok(thrown !== null, 'must throw');
  assert.strictEqual(thrown.code, 'BRAINSTORM_VALIDATION_FAILED');
  assert.ok(
    thrown.errors.some((e) => /targetFile/.test(e) && /target_files/.test(e)),
    `errors should mention targetFile not in target_files; got: ${JSON.stringify(thrown.errors)}`
  );
});

await test('manual kind does NOT require targetFile ∈ target_files (manualSteps only)', () => {
  const sdk = sdkResultFor([
    { description: 'manual ok', verification: { kind: 'manual', manualSteps: 'Click around.' } },
  ]);
  const out = extractBrainstormResult(sdk, { warn: () => {} });
  assert.equal(out.spec.acceptance_criteria[0].verification.kind, 'manual');
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
