/**
 * test-user-spec-input.js — No-SDK contract tests for src/cli/user-spec-input.js.
 *
 * Exercises isUserSpecInvocation / loadUserSpec / validateUserSpecFailClosed /
 * warnOnEngineSpecJson / resolveUserSpecSlug / writeUserSpecBundle /
 * renderProjectionPreview against fixtures and scratch tmpdir project roots —
 * no Claude auth, no SDK.
 *
 * Run: node test/test-user-spec-input.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  isUserSpecInvocation,
  loadUserSpec,
  validateUserSpecFailClosed,
  warnOnEngineSpecJson,
  renderProjectionPreview,
  resolveUserSpecSlug,
  writeUserSpecBundle,
} from '../src/cli/user-spec-input.js';

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

const validUserSpec = {
  goal: 'Add a widget to the dashboard',
  scope_in: [{ label: 'Widget component', files: ['src/widget.js'] }],
  success_criteria: [{ description: 'Widget renders', evidence: 'src/widget.js' }],
};

// ── TC1: isUserSpecInvocation recognizes .uspec.json / --spec-stdin, rejects .md ──

await test('TC1: isUserSpecInvocation recognizes .uspec.json and --spec-stdin, rejects .md', () => {
  assert.equal(isUserSpecInvocation('foo.uspec.json', {}), true);
  assert.equal(isUserSpecInvocation(undefined, { 'spec-stdin': true }), true);
  assert.equal(isUserSpecInvocation('foo.md', {}), false);
  assert.equal(isUserSpecInvocation('foo.md', { 'spec-stdin': false }), false);
});

// ── TC2: loadUserSpec throws actionable error when both .uspec.json and --spec-stdin given ──

await test('TC2: loadUserSpec throws actionable mutual-exclusion error', async () => {
  await assert.rejects(
    () =>
      loadUserSpec({
        specPath: 'foo.uspec.json',
        flags: { 'spec-stdin': true, auto: true },
        readStdin: async () => JSON.stringify(validUserSpec),
      }),
    (err) => {
      assert.ok(/mutually exclusive/i.test(err.message), `expected mutual-exclusivity message, got: ${err.message}`);
      assert.ok(err.message.includes('.uspec.json'), `expected message to mention .uspec.json, got: ${err.message}`);
      assert.ok(err.message.includes('--spec-stdin'), `expected message to mention --spec-stdin, got: ${err.message}`);
      return true;
    }
  );
});

// ── TC3: loadUserSpec throws actionable --auto-required error for --spec-stdin without --auto ──

await test('TC3: loadUserSpec throws actionable --auto-required error for --spec-stdin without --auto', async () => {
  await assert.rejects(
    () =>
      loadUserSpec({
        specPath: undefined,
        flags: { 'spec-stdin': true },
        readStdin: async () => JSON.stringify(validUserSpec),
      }),
    (err) => {
      assert.ok(err.message.includes('--auto'), `expected message to mention --auto, got: ${err.message}`);
      assert.ok(err.message.includes('--spec-stdin'), `expected message to mention --spec-stdin, got: ${err.message}`);
      return true;
    }
  );
});

// ── TC4: loadUserSpec reads+parses stdin under --spec-stdin --auto ──

await test('TC4: loadUserSpec reads and parses stdin under --spec-stdin --auto', async () => {
  let called = false;
  const readStdin = async () => {
    called = true;
    return JSON.stringify(validUserSpec);
  };
  const result = await loadUserSpec({
    specPath: undefined,
    flags: { 'spec-stdin': true, auto: true },
    readStdin,
  });
  assert.ok(called, 'expected the readStdin stub to have been invoked');
  assert.deepEqual(result, validUserSpec);
});

// ── TC5: validateUserSpecFailClosed throws with per-field .errors on invalid spec ──

await test('TC5: validateUserSpecFailClosed throws with per-field .errors on a spec missing a required field', () => {
  const missingGoal = { scope_in: validUserSpec.scope_in, success_criteria: validUserSpec.success_criteria };
  assert.throws(
    () => validateUserSpecFailClosed(missingGoal),
    (err) => {
      assert.ok(Array.isArray(err.errors), `expected err.errors to be an Array, got: ${JSON.stringify(err.errors)}`);
      assert.ok(err.errors.length > 0, 'expected at least one error message');
      assert.ok(
        err.errors.some((e) => e.includes('goal')),
        `expected an error naming 'goal', got: ${JSON.stringify(err.errors)}`
      );
      return true;
    }
  );
});

// ── TC6: warnOnEngineSpecJson is warn-only ──

await test('TC6: warnOnEngineSpecJson warns on malformed sibling spec.json, silent when absent, never throws', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'user-spec-warn-'));
  try {
    const mdPath = path.join(tmp, 'foo.spec.md');
    const jsonPath = path.join(tmp, 'foo.spec.json');
    fs.writeFileSync(mdPath, '# Foo');
    // Malformed: acceptance_criteria present but with an invalid item shape.
    fs.writeFileSync(jsonPath, JSON.stringify({ acceptance_criteria: [42] }));

    const warnings = [];
    const warn = (msg) => warnings.push(msg);

    assert.doesNotThrow(() => warnOnEngineSpecJson(mdPath, tmp, { warn }));
    assert.ok(warnings.length > 0, 'expected at least one warning for a malformed sibling spec.json');

    // Absent sibling spec.json → no warning, still no throw.
    const mdPathNoSibling = path.join(tmp, 'bar.spec.md');
    fs.writeFileSync(mdPathNoSibling, '# Bar');
    const warningsNoSibling = [];
    const warnNoSibling = (msg) => warningsNoSibling.push(msg);
    assert.doesNotThrow(() => warnOnEngineSpecJson(mdPathNoSibling, tmp, { warn: warnNoSibling }));
    assert.deepEqual(warningsNoSibling, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── TC7: resolveUserSpecSlug suffixes -1/-2 on pre-existing <slug>.spec.md files ──

await test('TC7: resolveUserSpecSlug suffixes -1/-2 when <slug>.spec.md files pre-exist', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'user-spec-slug-'));
  try {
    const goal = 'My Test Goal';
    const baseSlug = resolveUserSpecSlug(tmp, goal);
    assert.ok(baseSlug.length > 0);

    fs.writeFileSync(path.join(tmp, `${baseSlug}.spec.md`), '# base');
    const bumpedSlug1 = resolveUserSpecSlug(tmp, goal);
    assert.equal(bumpedSlug1, `${baseSlug}-1`);

    fs.writeFileSync(path.join(tmp, `${baseSlug}-1.spec.md`), '# bumped-1');
    const bumpedSlug2 = resolveUserSpecSlug(tmp, goal);
    assert.equal(bumpedSlug2, `${baseSlug}-2`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── TC8: writeUserSpecBundle writes <slug>.spec.json and <slug>.spec.md, returns the .md path ──

await test('TC8: writeUserSpecBundle writes <slug>.spec.json and <slug>.spec.md, returns the .md path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'user-spec-bundle-'));
  try {
    const specJson = { goal: 'Bundle goal', target_files: ['src/foo.js'], acceptance_criteria: [] };
    const specMd = '# Bundle goal\n';

    const { mdPath, jsonPath } = writeUserSpecBundle(tmp, 'my-slug', { specJson, specMd });

    assert.equal(mdPath, path.join(tmp, 'my-slug.spec.md'));
    assert.equal(jsonPath, path.join(tmp, 'my-slug.spec.json'));
    assert.ok(fs.existsSync(mdPath), 'expected <slug>.spec.md to have been written');
    assert.ok(fs.existsSync(jsonPath), 'expected <slug>.spec.json to have been written');

    assert.equal(fs.readFileSync(mdPath, 'utf8'), specMd);
    assert.deepEqual(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), specJson);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── TC9: renderProjectionPreview output contains each criterion description and its classified kind ──

await test('TC9: renderProjectionPreview output lists each criterion description and its classified kind', () => {
  const projection = {
    specJson: {
      goal: 'Preview goal',
      target_files: ['src/foo.js'],
      acceptance_criteria: [
        { description: 'Command check', verification: { kind: 'command', command: 'node test/foo.js' } },
        { description: 'File check', verification: { kind: 'file-check', targetFile: 'src/foo.js' } },
        { description: 'Manual check', verification: { kind: 'manual', manualSteps: 'Click the button' } },
      ],
    },
    warnings: [],
  };

  const preview = renderProjectionPreview(projection);

  assert.ok(preview.includes('=== Projection Preview ==='));
  for (const c of projection.specJson.acceptance_criteria) {
    assert.ok(preview.includes(c.description), `expected preview to include description "${c.description}"`);
    assert.ok(preview.includes(c.verification.kind), `expected preview to include kind "${c.verification.kind}"`);
  }
  assert.ok(preview.includes('node test/foo.js'));
  assert.ok(preview.includes('src/foo.js'));
  assert.ok(preview.includes('Click the button'));
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
