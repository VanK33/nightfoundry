/**
 * test-brainstorm-spec-contract.js — Round-trip contract tests for the
 * brainstormSpecSchema structured output contract.
 *
 * No Claude auth, no SDK. Feeds fixture objects through validateStructured
 * and asserts the correct ok/errors shape is returned.
 *
 * Run: node test/test-brainstorm-spec-contract.js
 */
import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  brainstormSpecSchema,
  validateStructured,
} from '../src/orchestrator/agents/_schemas.js';
import { generateSlug, resolveSlugCollision, hashSpec } from '../src/cli/commands/brainstorm.js';
import {
  checkScopeComplexity,
  applySplitRecommendation,
} from '../src/orchestrator/agents/brainstormer.js';

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

const fixtureValid5 = {
  goal: 'Implement a contract test for the brainstorm spec schema',
  target_files: ['test/test-brainstorm-spec-contract.js'],
  acceptance_criteria: [
    { description: 'All 6 test cases pass', verification: { kind: 'command', command: 'node test/test-brainstorm-spec-contract.js', targetFile: 'test/test-brainstorm-spec-contract.js' } },
    { description: 'File exits with code 0', verification: { kind: 'command', command: 'node test/test-brainstorm-spec-contract.js', targetFile: 'test/test-brainstorm-spec-contract.js' } },
  ],
  constraints: ['No external dependencies', 'Use only Node assert'],
  architecture_notes: 'Mirror the structure of test-verifier-contract.js',
};

const fixtureMinimal = {
  goal: 'Minimal valid fixture with only required fields',
  target_files: ['src/foo.js'],
  acceptance_criteria: [{ description: 'The function returns true', verification: { kind: 'command', command: 'node test/foo.js', targetFile: 'src/foo.js' } }],
};

const fixtureMissingGoal = {
  target_files: ['src/foo.js'],
  acceptance_criteria: [{ description: 'Something works', verification: { kind: 'command', command: 'node test/foo.js', targetFile: 'src/foo.js' } }],
};

const fixtureTargetFilesWrongType = {
  goal: 'Target files is a string instead of array',
  target_files: 'src/foo.js',
  acceptance_criteria: [{ description: 'It should pass', verification: { kind: 'command', command: 'node test/foo.js', targetFile: 'src/foo.js' } }],
};

const fixtureAcceptanceCriteriaWrongItemType = {
  goal: 'Acceptance criteria items are numbers',
  target_files: ['src/foo.js'],
  acceptance_criteria: [42, 99],
};

const fixtureExtraKeys = {
  goal: 'Extra keys should be tolerated',
  target_files: ['src/foo.js'],
  acceptance_criteria: [{ description: 'Extra keys are allowed', verification: { kind: 'command', command: 'node test/foo.js', targetFile: 'src/foo.js' } }],
  scope_in: ['Only foo.js'],
  scope_out: ['Do not touch bar.js'],
  assumptions: ['Node 18+ is available'],
};

// ── TC1: valid 5-field fixture passes ───────────────────────────────────

await test('TC1: valid 5-field fixture → ok:true', () => {
  const r = validateStructured(fixtureValid5, brainstormSpecSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── TC2: minimal fixture with only 3 required fields passes ─────────────

await test('TC2: minimal fixture (3 required fields only) → ok:true', () => {
  const r = validateStructured(fixtureMinimal, brainstormSpecSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── TC3: missing `goal` returns ok:false with error mentioning '$.goal' ──

await test('TC3: missing goal → ok:false with error mentioning $.goal', () => {
  const r = validateStructured(fixtureMissingGoal, brainstormSpecSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.includes('$.goal')),
    `expected an error mentioning '$.goal', got: ${JSON.stringify(r.errors)}`
  );
});

// ── TC4: target_files wrong type (string) returns ok:false ───────────────

await test('TC4: target_files is string instead of array → ok:false', () => {
  const r = validateStructured(fixtureTargetFilesWrongType, brainstormSpecSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /target_files/.test(e) && /expected array/.test(e)),
    `expected error about target_files expecting array, got: ${JSON.stringify(r.errors)}`
  );
});

// ── TC5: acceptance_criteria items of wrong type (number) returns ok:false

await test('TC5: acceptance_criteria items are numbers → ok:false', () => {
  const r = validateStructured(fixtureAcceptanceCriteriaWrongItemType, brainstormSpecSchema);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => /acceptance_criteria/.test(e)),
    `expected error about acceptance_criteria, got: ${JSON.stringify(r.errors)}`
  );
});

// ── TC6: extra keys tolerated AND schema does not define them ────────────

await test('TC6: extra scope_in/scope_out/assumptions keys → ok:true AND not in schema.properties', () => {
  const r = validateStructured(fixtureExtraKeys, brainstormSpecSchema);
  assert.equal(r.ok, true, `expected ok:true for extra keys, got errors: ${JSON.stringify(r.errors)}`);
  assert.ok(
    !('scope_in' in brainstormSpecSchema.properties),
    'brainstormSpecSchema.properties must not contain scope_in'
  );
  assert.ok(
    !('scope_out' in brainstormSpecSchema.properties),
    'brainstormSpecSchema.properties must not contain scope_out'
  );
  assert.ok(
    !('assumptions' in brainstormSpecSchema.properties),
    'brainstormSpecSchema.properties must not contain assumptions'
  );
});

// ── TC7–TC11: generateSlug ───────────────────────────────────────────────

await test('TC7: kebab-case lowercase: generateSlug("Add Foo CLI Subcommand") === "add-foo-cli-subcommand"', () => {
  assert.equal(generateSlug('Add Foo CLI Subcommand'), 'add-foo-cli-subcommand');
});

await test('TC8: collapses runs of non-alphanumerics: generateSlug("foo!!!  bar___baz") === "foo-bar-baz"', () => {
  assert.equal(generateSlug('foo!!!  bar___baz'), 'foo-bar-baz');
});

await test('TC9: truncates to 50 chars and strips trailing dash', () => {
  const input = 'a'.repeat(80);
  const result = generateSlug(input);
  assert.ok(result.length <= 50, `expected length <= 50, got ${result.length}`);
  assert.ok(!result.endsWith('-'), `expected no trailing dash, got: "${result}"`);
});

await test('TC10: empty/whitespace returns "untitled"', () => {
  assert.equal(generateSlug(''), 'untitled');
  assert.equal(generateSlug('   '), 'untitled');
});

await test('TC11: all non-alphanumerics returns "untitled"', () => {
  assert.equal(generateSlug('!!!---???'), 'untitled');
});

// ── TC12–TC14: resolveSlugCollision ─────────────────────────────────────

await test('TC12: empty root returns baseSlug unchanged', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-slug-'));
  try {
    assert.equal(resolveSlugCollision(tmp, 'foo'), 'foo');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await test('TC13: existing baseSlug dir bumps to -1', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-slug-'));
  try {
    fs.mkdirSync(path.join(tmp, 'foo'));
    assert.equal(resolveSlugCollision(tmp, 'foo'), 'foo-1');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await test('TC14: multiple existing collide upward', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-slug-'));
  try {
    fs.mkdirSync(path.join(tmp, 'foo'));
    fs.mkdirSync(path.join(tmp, 'foo-1'));
    fs.mkdirSync(path.join(tmp, 'foo-2'));
    assert.equal(resolveSlugCollision(tmp, 'foo'), 'foo-3');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── TC15–TC19: hashSpec ──────────────────────────────────────────────────

await test('TC15: format prefix: hashSpec({a:1}).startsWith("sha256:") && total length === 7+16', () => {
  const result = hashSpec({ a: 1 });
  assert.ok(result.startsWith('sha256:'), `expected sha256: prefix, got: "${result}"`);
  assert.equal(result.length, 7 + 16, `expected length ${7 + 16}, got ${result.length}`);
});

await test('TC16: determinism: hashSpec({a:1, b:2}) === hashSpec({a:1, b:2})', () => {
  assert.equal(hashSpec({ a: 1, b: 2 }), hashSpec({ a: 1, b: 2 }));
});

await test('TC17: key-order independence: hashSpec({a:1, b:2}) === hashSpec({b:2, a:1})', () => {
  assert.equal(hashSpec({ a: 1, b: 2 }), hashSpec({ b: 2, a: 1 }));
});

await test('TC18: content sensitivity: hashSpec({a:1}) !== hashSpec({a:2})', () => {
  assert.notEqual(hashSpec({ a: 1 }), hashSpec({ a: 2 }));
});

await test('TC19: nested key-order independence: hashSpec({outer:{a:1, b:2}}) === hashSpec({outer:{b:2, a:1}})', () => {
  assert.equal(hashSpec({ outer: { a: 1, b: 2 } }), hashSpec({ outer: { b: 2, a: 1 } }));
});

// ── Fixtures for scope-complexity tests ─────────────────────────────────

const fixtureLargeScope = {
  goal: 'Add caching and rate limiting and retry logic',
  target_files: [
    'src/cache/cache.js',
    'src/cache/index.js',
    'src/rate-limiting/limiter.js',
    'src/retry/retry.js',
    'test/cache.test.js',
    'test/limiter.test.js',
    'test/retry.test.js',
    'docs/api.md',
    'config/defaults.js',
  ],
  acceptance_criteria: [
    { description: 'Cache module stores and retrieves values', verification: { kind: 'command', command: 'node test/cache.test.js', targetFile: 'test/cache.test.js' } },
    { description: 'Rate limiter enforces per-second limits', verification: { kind: 'command', command: 'node test/limiter.test.js', targetFile: 'test/limiter.test.js' } },
    { description: 'Retry logic backs off exponentially', verification: { kind: 'command', command: 'node test/retry.test.js', targetFile: 'test/retry.test.js' } },
    { description: 'All modules are exported from index', verification: { kind: 'file-check', targetFile: 'src/cache/index.js' } },
    { description: 'Unit tests pass for all three modules', verification: { kind: 'command', command: 'node test/cache.test.js', targetFile: 'test/cache.test.js' } },
    { description: 'API docs are updated', verification: { kind: 'manual', manualSteps: 'Review docs/api.md for the new sections.' } },
  ],
};

// ── TC-small: checkScopeComplexity returns null for minimal fixture ───────

await test('TC-small: checkScopeComplexity(fixtureMinimal) returns null', () => {
  const result = checkScopeComplexity(fixtureMinimal);
  assert.strictEqual(result, null, `expected null but got: ${JSON.stringify(result)}`);
});

// ── TC-large: checkScopeComplexity returns non-null string for large scope

await test('TC-large: checkScopeComplexity(fixtureLargeScope) returns non-null string', () => {
  const result = checkScopeComplexity(fixtureLargeScope);
  assert.ok(result !== null, 'expected a non-null warning string');
  assert.equal(typeof result, 'string', `expected string, got: ${typeof result}`);
});

// ── TC-apply: applySplitRecommendation sets warning and appends section ───

await test('TC-apply: applySplitRecommendation sets warning and appends ## Splitting recommendation', () => {
  const patched = applySplitRecommendation({ spec: fixtureLargeScope, specMd: '# Test' }, 'too big');
  assert.equal(patched.spec.warning, 'too big', `expected spec.warning === 'too big', got: ${patched.spec.warning}`);
  assert.ok(
    patched.specMd.includes('## Splitting recommendation'),
    `expected specMd to include '## Splitting recommendation', got: ${patched.specMd}`
  );
});

// ── TC-schema: validateStructured with warning field returns ok:true ──────

await test('TC-schema: validateStructured with warning field present → ok:true', () => {
  const specWithWarning = { ...fixtureMinimal, warning: 'Spec may be too broad.' };
  const r = validateStructured(specWithWarning, brainstormSpecSchema);
  assert.ok(r.ok, `expected ok:true but got errors: ${JSON.stringify(r.errors)}`);
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
