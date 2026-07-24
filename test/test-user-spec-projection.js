/**
 * test-user-spec-projection.js — Pure projection contract tests for the
 * additive user-spec layer: classifyEvidence's classification matrix,
 * projectUserSpec's two-source target_files union/dedup, its warnings
 * (zero-checkable / empty-target_files), the md-render round-trip through
 * the real extractScopeItems, and the by-construction invariant that every
 * legal userSpec's projected specJson validates against brainstormSpecSchema.
 *
 * No Claude auth, no SDK, no fs/network — pure function tests.
 *
 * Run: node test/test-user-spec-projection.js
 */
import assert from 'assert';
import { classifyEvidence, projectUserSpec } from '../src/orchestrator/core/user-spec.js';
import { extractScopeItems } from '../src/orchestrator/core/scope-parser.js';
import { brainstormSpecSchema, validateStructured } from '../src/orchestrator/agents/_schemas.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    passCount++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failCount++;
    console.log(`  FAIL - ${name}`);
    console.log(err && err.stack ? err.stack : err);
  }
}

// ── (1) CLASSIFICATION MATRIX ────────────────────────────────────────────

test('classifyEvidence: path-like input → kind "file-check"', () => {
  const result = classifyEvidence('src/foo.js', []);
  assert.strictEqual(result.kind, 'file-check');
  assert.strictEqual(result.targetFile, 'src/foo.js');
});

test('classifyEvidence: command-shaped input whose file token is in targetFiles → kind "command" with targetFile', () => {
  const result = classifyEvidence('node test/foo.js', ['test/foo.js']);
  assert.strictEqual(result.kind, 'command');
  assert.strictEqual(result.command, 'node test/foo.js');
  assert.strictEqual(result.targetFile, 'test/foo.js');
});

test('classifyEvidence: command-shaped input whose token is NOT in targetFiles → kind "manual" with command preserved in manualSteps', () => {
  const result = classifyEvidence('node test/other.js', ['test/foo.js']);
  assert.strictEqual(result.kind, 'manual');
  assert.strictEqual(result.manualSteps, 'node test/other.js');
});

test('classifyEvidence: prose → kind "manual"', () => {
  const result = classifyEvidence('Please verify this manually in the browser', []);
  assert.strictEqual(result.kind, 'manual');
  assert.strictEqual(result.manualSteps, 'Please verify this manually in the browser');
});

test('classifyEvidence: empty evidence → kind "manual"', () => {
  const result = classifyEvidence('', []);
  assert.strictEqual(result.kind, 'manual');
  assert.strictEqual(typeof result.manualSteps, 'string');
  assert.ok(result.manualSteps.length > 0);
});

test('classifyEvidence: whitespace-only evidence → kind "manual"', () => {
  const result = classifyEvidence('   ', ['test/foo.js']);
  assert.strictEqual(result.kind, 'manual');
});

// ── (2) TWO-SOURCE UNION/DEDUP ────────────────────────────────────────────

test('projectUserSpec: target_files === dedup(scope_in files then PASS-1 path-like evidence), with an overlapping dup collapsed', () => {
  const userSpec = {
    goal: 'Add shared helper',
    scope_in: [
      { label: 'Add helper', files: ['src/a.js', 'src/shared.js'] },
    ],
    success_criteria: [
      // Overlaps with a scope_in file — should collapse to a single entry.
      { description: 'Shared file updated', evidence: 'src/shared.js' },
      // New path-like evidence not already in scope_in files.
      { description: 'New file created', evidence: 'src/c.js' },
      // Non-path-like evidence must not contribute to target_files.
      { description: 'Reviewed', evidence: 'Please review this by hand' },
    ],
  };

  const { specJson } = projectUserSpec(userSpec);

  assert.deepStrictEqual(specJson.target_files, ['src/a.js', 'src/shared.js', 'src/c.js']);
  const seen = new Set(specJson.target_files);
  assert.strictEqual(seen.size, specJson.target_files.length, 'target_files must contain no duplicates');
});

// ── (3) ZERO-CHECKABLE WARNING ────────────────────────────────────────────

test('projectUserSpec: userSpec whose every criterion classifies manual yields a zero-checkable-criteria warning', () => {
  const userSpec = {
    goal: 'Document behavior',
    scope_in: [
      { label: 'Document it', files: ['src/a.js'] },
    ],
    success_criteria: [
      { description: 'Reviewed manually', evidence: 'Please check this manually and confirm' },
      { description: 'Docs updated', evidence: 'Review the docs by hand for accuracy' },
    ],
  };

  const { specJson, warnings } = projectUserSpec(userSpec);

  // Isolate the zero-checkable warning from the empty-target_files warning.
  assert.ok(specJson.target_files.length > 0, 'target_files must be non-empty for this fixture');
  assert.ok(
    specJson.acceptance_criteria.every((ac) => ac.verification.kind === 'manual'),
    `expected every acceptance_criteria entry to be manual, got: ${JSON.stringify(specJson.acceptance_criteria)}`
  );
  assert.ok(
    warnings.some((w) => /checkable/i.test(w)),
    `expected a zero-checkable-criteria warning, got: ${JSON.stringify(warnings)}`
  );
});

// ── (4) EMPTY-FILES WARNING ────────────────────────────────────────────────

test('projectUserSpec: no scope_in files and no path-like evidence yields an empty-target_files warning', () => {
  const userSpec = {
    goal: 'Run a script',
    scope_in: [
      { label: 'Run it' },
    ],
    success_criteria: [
      { description: 'Script runs', evidence: 'npm test' },
    ],
  };

  const { specJson, warnings } = projectUserSpec(userSpec);

  assert.deepStrictEqual(specJson.target_files, []);
  assert.ok(
    warnings.some((w) => /target_files/i.test(w) && /empty/i.test(w)),
    `expected an empty-target_files warning, got: ${JSON.stringify(warnings)}`
  );
});

// ── (5) MD-RENDER ROUND-TRIP ──────────────────────────────────────────────

test('projectUserSpec: specMd fed through the real extractScopeItems yields one scope item per scope_in entry with matching labels', () => {
  const userSpec = {
    goal: 'Refactor pipeline',
    scope_in: [
      { label: 'Split scheduler module', files: ['src/scheduler.js'] },
      { label: 'Extract retry logic', files: ['src/retry.js'] },
      { label: 'Update tests', files: ['test/scheduler.test.js'] },
    ],
    success_criteria: [
      { description: 'Tests pass', evidence: 'node test/scheduler.test.js' },
    ],
  };

  const { specMd } = projectUserSpec(userSpec);
  const scopeItems = extractScopeItems(specMd);

  assert.strictEqual(scopeItems.length, userSpec.scope_in.length);
  const labels = scopeItems.map((item) => item.label);
  const expectedLabels = userSpec.scope_in.map((item) => item.label);
  assert.deepStrictEqual(labels, expectedLabels);
});

// ── (6) BY-CONSTRUCTION INVARIANT ─────────────────────────────────────────

const representativeUserSpecs = [
  {
    name: 'minimal',
    userSpec: {
      goal: 'Fix bug',
      scope_in: [
        { label: 'Fix the thing', files: ['src/thing.js'] },
      ],
      success_criteria: [
        { description: 'It works', evidence: 'src/thing.js' },
      ],
      architecture_notes: '',
    },
  },
  {
    name: 'all-fields',
    userSpec: {
      goal: 'Add caching layer',
      scope_in: [
        { label: 'Add cache module', files: ['src/cache.js'], behavior: 'Stores and retrieves values' },
        { label: 'Wire into pipeline', files: ['src/pipeline.js'] },
      ],
      scope_out: ['touch the database layer'],
      success_criteria: [
        { description: 'Cache tests pass', evidence: 'node test/cache.test.js' },
        { description: 'Docs updated', evidence: 'Review docs manually for accuracy' },
      ],
      constraints: ['No new external dependencies'],
      assumptions: ['Node 18+ is available'],
      architecture_notes: 'Follow the existing module pattern in src/.',
    },
  },
  {
    name: 'unicode-bearing',
    userSpec: {
      goal: 'Añadir soporte de emoji 🎉 al analizador',
      scope_in: [
        { label: 'Soporte de emoji 🎉', files: ['src/analyzer.js'] },
      ],
      success_criteria: [
        { description: 'El analizador reconoce emojis 🎉', evidence: 'src/analyzer.js' },
      ],
      architecture_notes: 'Sigue el patrón existente 🎉.',
    },
  },
  {
    name: 'boundary: single-item scope_in/success_criteria',
    userSpec: {
      goal: 'Investigate flaky test',
      scope_in: [
        { label: 'Investigate' },
      ],
      success_criteria: [
        { description: 'Root cause identified', evidence: 'Investigate manually and write up findings' },
      ],
      architecture_notes: '',
    },
  },
];

for (const { name, userSpec } of representativeUserSpecs) {
  test(`by-construction invariant: validateStructured(projectUserSpec(userSpec).specJson, brainstormSpecSchema).ok === true — ${name}`, () => {
    const { specJson } = projectUserSpec(userSpec);
    const result = validateStructured(specJson, brainstormSpecSchema);
    assert.strictEqual(result.ok, true, `expected ok:true, got errors: ${JSON.stringify(result.errors)}`);
  });
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
