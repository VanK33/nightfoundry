/**
 * test-user-spec-cli.js — End-to-end (no-SDK, no-subprocess-pipeline)
 * integration tests for the `.uspec.json` CLI entry point.
 *
 * Exercises the full CLI-facing surface of src/cli/user-spec-input.js
 * (isUserSpecInvocation, loadUserSpec, prepareUserSpecInput,
 * warnOnEngineSpecJson) end-to-end against scratch tmpdir project roots, and
 * confirms the resulting `<slug>.spec.json` / `<slug>.spec.md` pair is
 * actually consumable by the downstream pipeline library functions
 * (parseSpecHardChecks from planner.js, Pipeline.prototype._detectUncheckableSpec)
 * — WITHOUT spawning a subprocess pipeline run.
 *
 * No Claude auth, no SDK, no subprocess pipeline invocation.
 *
 * Run: node test/test-user-spec-cli.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';

import {
  isUserSpecInvocation,
  loadUserSpec,
  prepareUserSpecInput,
  warnOnEngineSpecJson,
} from '../src/cli/user-spec-input.js';
import { generateSlug } from '../src/cli/commands/brainstorm.js';
import { parseSpecHardChecks } from '../src/orchestrator/agents/planner.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { UncheckableSpecError } from '../src/orchestrator/core/uncheckable-spec-error.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function gitInit(dir) {
  spawnSync('git', ['init', '-q', dir], { stdio: 'ignore' });
}

// A valid userSpec whose single success_criteria evidence is command-shaped
// and matches a scope_in file, so it projects into exactly one
// kind:'command' acceptance criterion (and therefore one hardCheck).
const validUserSpec = {
  goal: 'Add a widget test file',
  scope_in: [
    { label: 'Widget test', files: ['test/widget.js'], behavior: 'creates a widget test' },
  ],
  success_criteria: [
    { description: 'Widget test passes', evidence: 'node test/widget.js' },
  ],
};

// ── TC1: EXTENSION ROUTING ──────────────────────────────────────────────

await test('TC1: isUserSpecInvocation routes .uspec.json and --spec-stdin, rejects .md', () => {
  assert.equal(isUserSpecInvocation('foo.uspec.json', {}), true);
  assert.equal(isUserSpecInvocation(undefined, { 'spec-stdin': true }), true);
  assert.equal(isUserSpecInvocation('foo.md', {}), false);
});

// ── TC2: --spec-stdin FORCES --auto ─────────────────────────────────────

await test('TC2: --spec-stdin without --auto throws an actionable --auto-required error', async () => {
  const tmp = mkTmpDir('uspec-cli-auto-');
  try {
    await assert.rejects(
      () =>
        prepareUserSpecInput({
          projectRoot: tmp,
          specPath: undefined,
          flags: { 'spec-stdin': true },
          readStdin: async () => JSON.stringify(validUserSpec),
          log: () => {},
          warn: () => {},
        }),
      (err) => {
        assert.ok(err.message.includes('--auto'), `expected message to mention --auto, got: ${err.message}`);
        assert.ok(err.message.includes('--spec-stdin'), `expected message to mention --spec-stdin, got: ${err.message}`);
        return true;
      }
    );
    // No files should have been written.
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally {
    cleanup(tmp);
  }
});

// ── TC3: MUTUAL EXCLUSION ────────────────────────────────────────────────

await test('TC3: a .uspec.json positional plus --spec-stdin throws an actionable mutual-exclusion error', async () => {
  const tmp = mkTmpDir('uspec-cli-mutex-');
  try {
    const specPath = path.join(tmp, 'foo.uspec.json');
    // File need not exist on disk: the mutual-exclusion check fires before
    // any read of specPath.
    await assert.rejects(
      () =>
        loadUserSpec({
          specPath,
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
  } finally {
    cleanup(tmp);
  }
});

// ── TC4: FAIL-CLOSED READABLE ERRORS ─────────────────────────────────────

await test('TC4: an invalid userSpec (missing required field) throws with a readable per-field .errors message', async () => {
  const tmp = mkTmpDir('uspec-cli-invalid-');
  try {
    const invalidUserSpec = {
      scope_in: validUserSpec.scope_in,
      success_criteria: validUserSpec.success_criteria,
      // goal omitted — required field missing.
    };
    await assert.rejects(
      () =>
        prepareUserSpecInput({
          projectRoot: tmp,
          specPath: undefined,
          flags: { 'spec-stdin': true, auto: true },
          readStdin: async () => JSON.stringify(invalidUserSpec),
          log: () => {},
          warn: () => {},
        }),
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
    // Fail-closed: nothing should have been written to disk.
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally {
    cleanup(tmp);
  }
});

// ── TC5: PAIR WRITTEN TO DISK ─────────────────────────────────────────────

await test('TC5: prepareUserSpecInput writes <slug>.spec.json and <slug>.spec.md matching the projection', async () => {
  const tmp = mkTmpDir('uspec-cli-write-');
  try {
    const mdPath = await prepareUserSpecInput({
      projectRoot: tmp,
      specPath: undefined,
      flags: { 'spec-stdin': true, auto: true },
      readStdin: async () => JSON.stringify(validUserSpec),
      log: () => {},
      warn: () => {},
    });

    assert.ok(mdPath.endsWith('.spec.md'), `expected mdPath to end with .spec.md, got: ${mdPath}`);
    assert.equal(path.dirname(mdPath), tmp);

    const jsonPath = mdPath.replace(/\.spec\.md$/, '.spec.json');
    assert.ok(fs.existsSync(jsonPath), `expected sibling ${jsonPath} to exist`);
    assert.ok(fs.existsSync(mdPath), `expected ${mdPath} to exist`);

    const specJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.deepEqual(specJson.target_files, ['test/widget.js']);
    assert.equal(specJson.acceptance_criteria.length, 1);
    assert.equal(specJson.acceptance_criteria[0].description, 'Widget test passes');
    assert.deepEqual(specJson.acceptance_criteria[0].verification, {
      kind: 'command',
      command: 'node test/widget.js',
      targetFile: 'test/widget.js',
    });

    const specMd = fs.readFileSync(mdPath, 'utf8');
    assert.ok(specMd.includes('## Scope — in'), `expected rendered markdown to contain the '## Scope — in' section, got:\n${specMd}`);
  } finally {
    cleanup(tmp);
  }
});

// ── TC6: SLUG SUFFIXING ────────────────────────────────────────────────────

await test('TC6: a pre-existing <slug>.spec.md forces a -1-suffixed slug pair', async () => {
  const tmp = mkTmpDir('uspec-cli-slug-');
  try {
    const baseSlug = generateSlug(validUserSpec.goal);
    // Pre-create the base slug's markdown sibling so the resolver must bump.
    fs.writeFileSync(path.join(tmp, `${baseSlug}.spec.md`), '# pre-existing\n');

    const mdPath = await prepareUserSpecInput({
      projectRoot: tmp,
      specPath: undefined,
      flags: { 'spec-stdin': true, auto: true },
      readStdin: async () => JSON.stringify(validUserSpec),
      log: () => {},
      warn: () => {},
    });

    assert.equal(path.basename(mdPath), `${baseSlug}-1.spec.md`, `expected -1-suffixed slug, got: ${path.basename(mdPath)}`);
    assert.ok(fs.existsSync(path.join(tmp, `${baseSlug}-1.spec.json`)));
  } finally {
    cleanup(tmp);
  }
});

// ── TC7: WARN-ONLY RIDER ────────────────────────────────────────────────────

await test('TC7: warnOnEngineSpecJson on a malformed sibling spec.json warns and does not throw', () => {
  const tmp = mkTmpDir('uspec-cli-warn-');
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
  } finally {
    cleanup(tmp);
  }
});

// ── TC8: PIPELINE CONSUMABILITY ───────────────────────────────────────────

await test('TC8: the written pair is consumable by parseSpecHardChecks and passes _detectUncheckableSpec', async () => {
  const tmp = mkTmpDir('uspec-cli-pipeline-');
  try {
    gitInit(tmp);

    const mdPath = await prepareUserSpecInput({
      projectRoot: tmp,
      specPath: undefined,
      flags: { 'spec-stdin': true, auto: true },
      readStdin: async () => JSON.stringify(validUserSpec),
      log: () => {},
      warn: () => {},
    });
    const jsonPath = mdPath.replace(/\.spec\.md$/, '.spec.json');

    // parseSpecHardChecks: exactly one hardCheck, for the single
    // kind:'command' criterion in validUserSpec.
    const hardChecks = parseSpecHardChecks(jsonPath);
    assert.equal(hardChecks.length, 1, `expected 1 hardCheck, got ${hardChecks.length}: ${JSON.stringify(hardChecks)}`);
    assert.equal(hardChecks[0].command, 'node test/widget.js');
    assert.equal(hardChecks[0].name, 'Widget test passes');

    // _detectUncheckableSpec: a real spec.json sibling exists and is
    // checkable (a verification object is present), so the guard must not
    // throw UncheckableSpecError.
    const logs = [];
    const fakePipeline = {
      _allowIncompleteScope: false,
      onLog: (msg) => logs.push(msg),
      projectRoot: tmp,
    };

    let thrown = null;
    try {
      Pipeline.prototype._detectUncheckableSpec.call(fakePipeline, { prdPath: mdPath });
    } catch (err) {
      thrown = err;
    }
    assert.equal(thrown, null, `expected no throw, got: ${thrown && thrown.message}`);
    assert.ok(!(thrown instanceof UncheckableSpecError), 'expected no UncheckableSpecError to be thrown');
  } finally {
    cleanup(tmp);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
