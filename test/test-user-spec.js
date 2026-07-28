/**
 * test-user-spec.js — Self-contained contract tests for the user-spec
 * classifier, projection, and markdown renderer in
 * `src/orchestrator/core/user-spec.js`.
 *
 * No Claude auth, no SDK. Pure function calls + Node assert.
 *
 * Run: node test/test-user-spec.js
 */
import assert from 'assert';
import {
  classifyEvidence,
  projectUserSpec,
  isPathLike,
  isCommandShaped,
  renderUserSpecMd,
} from '../src/orchestrator/core/user-spec.js';
import { extractScopeItems } from '../src/orchestrator/core/scope-parser.js';

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

// ── TC1: classifyEvidence path-like → file-check ────────────────────────

await test('TC1: classifyEvidence("src/foo.js", []) → file-check', () => {
  assert.equal(isPathLike('src/foo.js'), true);
  const result = classifyEvidence('src/foo.js', []);
  assert.deepEqual(result, { kind: 'file-check', targetFile: 'src/foo.js' });
});

// ── TC2: classifyEvidence command-shaped matching target → command ──────

await test('TC2: classifyEvidence("node test/foo.js", ["test/foo.js"]) → command', () => {
  assert.equal(isCommandShaped('node test/foo.js'), true);
  const result = classifyEvidence('node test/foo.js', ['test/foo.js']);
  assert.deepEqual(result, {
    kind: 'command',
    command: 'node test/foo.js',
    targetFile: 'test/foo.js',
  });
});

// ── TC3: classifyEvidence command-shaped non-matching → manual downgrade ─

await test('TC3: classifyEvidence("node test/foo.js", []) → manual, preserves command', () => {
  const result = classifyEvidence('node test/foo.js', []);
  assert.equal(result.kind, 'manual');
  assert.equal(result.manualSteps, 'node test/foo.js');
});

// ── TC4: classifyEvidence prose/empty → manual ──────────────────────────

await test('TC4: classifyEvidence prose/empty → manual', () => {
  const prose = classifyEvidence('Open the browser and verify the page renders', []);
  assert.equal(prose.kind, 'manual');
  assert.equal(prose.manualSteps, 'Open the browser and verify the page renders');

  const empty = classifyEvidence('', []);
  assert.equal(empty.kind, 'manual');
  assert.equal(empty.manualSteps, 'Manual verification.');

  const whitespace = classifyEvidence('   ', []);
  assert.equal(whitespace.kind, 'manual');
  assert.equal(whitespace.manualSteps, 'Manual verification.');
});

// ── Fixture for TC5, TC6, TC9, TC10 ──────────────────────────────────────

const fixtureMain = {
  goal: 'Test goal for user-spec projection',
  scope_in: [
    { label: 'A', behavior: 'does A things', files: ['src/a.js', 'src/b.js'] },
    { label: 'B', behavior: 'does B things', files: ['src/b.js', 'src/c.js'] },
  ],
  scope_out: ['touch src/z.js'],
  success_criteria: [
    { description: 'd1', evidence: 'src/d.js' },
    { description: 'd2', evidence: 'src/a.js' },
    { description: 'd3', evidence: 'node src/a.js' },
  ],
  constraints: ['Follow the style guide'],
  assumptions: ['Node 18+ is available'],
  architecture_notes: 'Some architecture notes.',
};

// ── TC5: target_files is the deduped two-source union, order preserved ──

await test('TC5: projectUserSpec target_files is deduped two-source union preserving order', () => {
  const { specJson } = projectUserSpec(fixtureMain);
  assert.deepEqual(specJson.target_files, ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']);
});

// ── TC6: constraints include scope_out rewritten as negative clauses ────

await test('TC6: projectUserSpec constraints include scope_out rewritten as negative clauses', () => {
  const { specJson } = projectUserSpec(fixtureMain);
  assert.ok(
    specJson.constraints.includes('Follow the style guide'),
    `expected user constraint to be preserved, got: ${JSON.stringify(specJson.constraints)}`
  );
  assert.ok(
    specJson.constraints.includes('Do not: touch src/z.js'),
    `expected negatively-phrased scope_out constraint, got: ${JSON.stringify(specJson.constraints)}`
  );
});

// ── TC7: zero-checkable-criteria warning fires when all evidence is prose

await test('TC7: projectUserSpec emits zero-checkable-criteria warning for all-prose evidence', () => {
  const fixtureAllProse = {
    goal: 'All prose evidence',
    scope_in: [{ label: 'A', files: ['src/a.js'] }],
    success_criteria: [
      { description: 'd1', evidence: 'Verify the page renders correctly in the browser' },
      { description: 'd2', evidence: 'Confirm the user can navigate to the settings screen' },
    ],
  };
  const { specJson, warnings } = projectUserSpec(fixtureAllProse);
  assert.ok(
    specJson.acceptance_criteria.every((ac) => ac.verification.kind === 'manual'),
    `expected all acceptance criteria to be manual, got: ${JSON.stringify(specJson.acceptance_criteria)}`
  );
  assert.ok(
    warnings.some((w) => /No checkable acceptance criteria/.test(w)),
    `expected zero-checkable-criteria warning, got: ${JSON.stringify(warnings)}`
  );
});

// ── TC8: empty-target_files warning fires when both sources are empty ───

await test('TC8: projectUserSpec emits empty-target_files warning when both sources are empty', () => {
  const fixtureEmptyTargets = {
    goal: 'No files anywhere',
    scope_in: [],
    success_criteria: [
      { description: 'd1', evidence: 'Run the app manually and check the output' },
    ],
  };
  const { specJson, warnings } = projectUserSpec(fixtureEmptyTargets);
  assert.deepEqual(specJson.target_files, []);
  assert.ok(
    warnings.some((w) => /target_files is empty/.test(w)),
    `expected empty-target_files warning, got: ${JSON.stringify(warnings)}`
  );
});

// ── TC9: specMd contains '## Scope — in' and 'User-declared assumptions' ─

await test("TC9: specMd contains '## Scope — in' heading and 'User-declared assumptions' section", () => {
  const { specJson, specMd } = projectUserSpec(fixtureMain);
  assert.ok(
    specMd.includes('## Scope — in'),
    `expected specMd to include '## Scope — in', got:\n${specMd}`
  );
  assert.ok(
    specMd.includes('User-declared assumptions'),
    `expected specMd to include 'User-declared assumptions', got:\n${specMd}`
  );
  // Cross-check against the standalone renderer, which projectUserSpec
  // delegates to internally.
  const directRender = renderUserSpecMd(fixtureMain, specJson);
  assert.equal(directRender, specMd);
});

// ── TC10: projectUserSpec is deterministic ──────────────────────────────

await test('TC10: projectUserSpec(fixtureMain) is deterministic across two calls', () => {
  const first = projectUserSpec(fixtureMain);
  const second = projectUserSpec(fixtureMain);
  assert.deepEqual(first, second);
});

// ── TC11: duplicate-label scope_in round-trips through extractScopeItems ─

await test('TC11: renderUserSpecMd + extractScopeItems round-trips a duplicate-label scope_in to one item per entry', () => {
  const dupLabelUserSpec = {
    goal: 'Duplicate-label round-trip guard',
    scope_in: [
      { label: 'Dup', behavior: 'first duplicate entry', files: ['src/a.js'] },
      { label: 'Dup', behavior: 'second duplicate entry', files: ['src/b.js'] },
      { label: 'Unique', behavior: 'non-duplicate entry', files: ['src/c.js'] },
    ],
    success_criteria: [
      { description: 'd1', evidence: 'src/a.js' },
    ],
  };

  const specMd = renderUserSpecMd(dupLabelUserSpec);
  const items = extractScopeItems(specMd);
  assert.strictEqual(
    items.length,
    dupLabelUserSpec.scope_in.length,
    `expected one extracted item per scope_in entry (${dupLabelUserSpec.scope_in.length}), got ${items.length}:\n${JSON.stringify(items)}\n\nspecMd:\n${specMd}`
  );
});

// ── TC12: distinct-label scope_in still round-trips (backward-compat) ───

await test('TC12: renderUserSpecMd + extractScopeItems round-trips a distinct-label scope_in to matching count, labels, and ids', () => {
  const distinctLabelUserSpec = {
    goal: 'Distinct-label round-trip backward-compat guard',
    scope_in: [
      { label: 'Alpha', behavior: 'first entry', files: ['src/a.js'] },
      { label: 'Beta', behavior: 'second entry', files: ['src/b.js'] },
      { label: 'Gamma', behavior: 'third entry', files: ['src/c.js'] },
    ],
    success_criteria: [
      { description: 'd1', evidence: 'src/a.js' },
    ],
  };

  const specMd = renderUserSpecMd(distinctLabelUserSpec);
  const items = extractScopeItems(specMd);
  assert.strictEqual(
    items.length,
    distinctLabelUserSpec.scope_in.length,
    `expected one extracted item per scope_in entry (${distinctLabelUserSpec.scope_in.length}), got ${items.length}:\n${JSON.stringify(items)}\n\nspecMd:\n${specMd}`
  );
  assert.deepEqual(
    items.map((item) => item.label),
    distinctLabelUserSpec.scope_in.map((entry) => entry.label)
  );
  assert.deepEqual(
    items.map((item) => item.id),
    ['s1', 's2', 's3']
  );
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
