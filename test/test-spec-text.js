/**
 * test-spec-text.js — Unit tests for the five pure functions in spec-text.js.
 *
 * Tests readSpecTargetFiles, readSpecConstraints, readSpecAcceptanceCriteria,
 * readSpecGoal, and buildVerifierSpecContext. Uses temp dirs for fixture files
 * with cleanup.
 *
 * Run: node test/test-spec-text.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  readSpecTargetFiles,
  readSpecConstraints,
  readSpecAcceptanceCriteria,
  readSpecGoal,
  buildVerifierSpecContext,
} from '../src/orchestrator/core/spec-text.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';

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

async function asyncTest(name, fn) {
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

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spec-text-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ── readSpecTargetFiles ────────────────────────────────────────────────────

// TC1: spec.json target_files wins over md backtick paths
test('TC1: readSpecTargetFiles returns json target_files over md backtick paths', () => {
  const tmpDir = makeTmpDir();
  try {
    const specMdPath = path.join(tmpDir, 'spec.md');
    const specJsonPath = path.join(tmpDir, 'spec.json');
    // md has backtick paths that differ from json target_files
    fs.writeFileSync(specMdPath, '# Spec\n\nSee `src/x.js` for details.\n');
    fs.writeFileSync(specJsonPath, JSON.stringify({ target_files: ['src/a.js', 'src/b.js'] }));
    const result = readSpecTargetFiles(specMdPath, tmpDir);
    assert.deepStrictEqual(result, ['src/a.js', 'src/b.js'],
      `expected ['src/a.js','src/b.js'] but got ${JSON.stringify(result)}`);
  } finally {
    cleanup(tmpDir);
  }
});

// TC2: md fallback when no spec.json — section-scoped extraction
// Paths under `## Declared target files` are returned; prose paths outside that
// section are NOT included.
test('TC2: readSpecTargetFiles extracts only paths under ## Declared target files section', () => {
  const tmpDir = makeTmpDir();
  try {
    const specMdPath = path.join(tmpDir, 'spec.md');
    // Prose section (Goal) contains `src/outside-prose.js` — must NOT leak.
    // Architecture section also contains a prose path — must NOT leak.
    // Only paths under `## Declared target files` should be returned.
    fs.writeFileSync(specMdPath, [
      '# Spec',
      '',
      '## Goal',
      '',
      'See `src/outside-prose.js` for the entry point.',
      '',
      '## Architecture',
      '',
      'Relates to `lib/outside-arch.js` as well.',
      '',
      '## Declared target files',
      '',
      '- `src/foo.js`',
      '- `lib/bar.js`',
      '',
      '## Notes',
      '',
      'Some trailing section.',
    ].join('\n'));
    // No spec.json written
    const result = readSpecTargetFiles(specMdPath, tmpDir);
    assert.ok(Array.isArray(result), 'expected an array');
    assert.ok(result.includes('src/foo.js'),
      `expected result to include 'src/foo.js', got ${JSON.stringify(result)}`);
    assert.ok(result.includes('lib/bar.js'),
      `expected result to include 'lib/bar.js', got ${JSON.stringify(result)}`);
    assert.ok(!result.includes('src/outside-prose.js'),
      `prose path 'src/outside-prose.js' must NOT appear in result, got ${JSON.stringify(result)}`);
    assert.ok(!result.includes('lib/outside-arch.js'),
      `prose path 'lib/outside-arch.js' must NOT appear in result, got ${JSON.stringify(result)}`);
  } finally {
    cleanup(tmpDir);
  }
});

// TC2b: spec.md with backtick paths but no `## Declared target files` heading
// and no spec.json → result must be [].
test('TC2b: readSpecTargetFiles returns [] when spec.md has no ## Declared target files section', () => {
  const tmpDir = makeTmpDir();
  try {
    const specMdPath = path.join(tmpDir, 'spec.md');
    // Markdown has backtick paths in prose but no section heading → must return []
    fs.writeFileSync(specMdPath, [
      '# Spec',
      '',
      '## Goal',
      '',
      'This mentions `src/some-file.js` and `lib/other.js` in prose.',
      '',
      '## Details',
      '',
      'Also references `config/settings.json`.',
    ].join('\n'));
    // No spec.json written
    const result = readSpecTargetFiles(specMdPath, tmpDir);
    assert.deepStrictEqual(result, [],
      `expected [] when no ## Declared target files section, got ${JSON.stringify(result)}`);
  } finally {
    cleanup(tmpDir);
  }
});

// TC3: missing files → []
test('TC3: readSpecTargetFiles returns [] on missing files', () => {
  const result = readSpecTargetFiles('/nonexistent/path/spec.md', '/nonexistent/root');
  assert.deepStrictEqual(result, [],
    `expected [] on missing files but got ${JSON.stringify(result)}`);
});

// TC4: corrupt spec.json → fail-soft ([] or md fallback, no throw)
test('TC4: readSpecTargetFiles returns [] on corrupt json (fail-soft, no throw)', () => {
  const tmpDir = makeTmpDir();
  try {
    const specMdPath = path.join(tmpDir, 'spec.md');
    const specJsonPath = path.join(tmpDir, 'spec.json');
    // corrupt json
    fs.writeFileSync(specJsonPath, '{{bad');
    // md with no backtick file paths
    fs.writeFileSync(specMdPath, '# Spec\n\nNo backtick paths here.\n');
    let result;
    assert.doesNotThrow(() => { result = readSpecTargetFiles(specMdPath, tmpDir); },
      'must not throw on corrupt json');
    assert.ok(Array.isArray(result), 'expected an array');
    // With corrupt json, falls back to md; md has no valid paths, so returns []
    // (either [] or the md-extracted list is acceptable per TC4 spec)
    // Just verify it doesn't throw and returns an array
  } finally {
    cleanup(tmpDir);
  }
});

// ── readSpecConstraints ────────────────────────────────────────────────────

// TC5: constraints from spec.json
test('TC5: readSpecConstraints returns constraints from spec.json', () => {
  const tmpDir = makeTmpDir();
  try {
    const specMdPath = path.join(tmpDir, 'spec.md');
    const specJsonPath = path.join(tmpDir, 'spec.json');
    fs.writeFileSync(specMdPath, '# Spec\n');
    fs.writeFileSync(specJsonPath, JSON.stringify({ constraints: ['no-logs', 'pure-functions'] }));
    const result = readSpecConstraints(specMdPath, tmpDir);
    assert.deepStrictEqual(result, ['no-logs', 'pure-functions'],
      `expected ['no-logs','pure-functions'] but got ${JSON.stringify(result)}`);
  } finally {
    cleanup(tmpDir);
  }
});

// TC6: no spec.json → []
test('TC6: readSpecConstraints returns [] on missing spec.json', () => {
  const tmpDir = makeTmpDir();
  try {
    const specMdPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specMdPath, '# Spec\n');
    // No spec.json
    const result = readSpecConstraints(specMdPath, tmpDir);
    assert.deepStrictEqual(result, [],
      `expected [] but got ${JSON.stringify(result)}`);
  } finally {
    cleanup(tmpDir);
  }
});

// ── readSpecAcceptanceCriteria ─────────────────────────────────────────────

// TC7: returns criteria array from spec.json
test('TC7: readSpecAcceptanceCriteria returns criteria array from spec.json', () => {
  const tmpDir = makeTmpDir();
  try {
    const specMdPath = path.join(tmpDir, 'spec.md');
    const specJsonPath = path.join(tmpDir, 'spec.json');
    const sampleCriteria = [
      { description: 'TC', verification: { command: 'node t.js' } },
    ];
    fs.writeFileSync(specMdPath, '# Spec\n');
    fs.writeFileSync(specJsonPath, JSON.stringify({ acceptance_criteria: sampleCriteria }));
    const result = readSpecAcceptanceCriteria(specMdPath, tmpDir);
    assert.deepStrictEqual(result, sampleCriteria,
      `expected criteria array but got ${JSON.stringify(result)}`);
  } finally {
    cleanup(tmpDir);
  }
});

// ── readSpecGoal ───────────────────────────────────────────────────────────

// TC8: returns goal string
test('TC8: readSpecGoal returns goal string from spec.json', () => {
  const tmpDir = makeTmpDir();
  try {
    const specMdPath = path.join(tmpDir, 'spec.md');
    const specJsonPath = path.join(tmpDir, 'spec.json');
    fs.writeFileSync(specMdPath, '# Spec\n');
    fs.writeFileSync(specJsonPath, JSON.stringify({ goal: 'Build X' }));
    const result = readSpecGoal(specMdPath, tmpDir);
    assert.strictEqual(result, 'Build X',
      `expected 'Build X' but got ${JSON.stringify(result)}`);
  } finally {
    cleanup(tmpDir);
  }
});

// TC9: no spec.json → ''
test("TC9: readSpecGoal returns '' on missing spec.json", () => {
  const tmpDir = makeTmpDir();
  try {
    const specMdPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specMdPath, '# Spec\n');
    // No spec.json
    const result = readSpecGoal(specMdPath, tmpDir);
    assert.strictEqual(result, '',
      `expected '' but got ${JSON.stringify(result)}`);
  } finally {
    cleanup(tmpDir);
  }
});

// ── buildVerifierSpecContext ───────────────────────────────────────────────

// TC10: filters criteria to only those matching task hardCheck commands
test('TC10: buildVerifierSpecContext filters criteria by task hardCheck commands', () => {
  const tmpDir = makeTmpDir();
  try {
    const task = { id: 'task1', hardChecks: [{ command: 'node t.js' }] };
    const criteria = [
      { description: 'C1', verification: { command: 'node t.js' } },
      { description: 'C2', verification: { command: 'node other.js' } },
    ];
    // No sidecar file
    const result = buildVerifierSpecContext(tmpDir, task, criteria);
    assert.ok(result && typeof result === 'object', 'expected an object');
    assert.ok(Array.isArray(result.relevantCriteria), 'expected relevantCriteria to be an array');
    assert.strictEqual(result.relevantCriteria.length, 1,
      `expected 1 criterion but got ${result.relevantCriteria.length}`);
    assert.strictEqual(result.relevantCriteria[0].description, 'C1',
      `expected C1 but got ${result.relevantCriteria[0].description}`);
  } finally {
    cleanup(tmpDir);
  }
});

// TC11: unions sidecar hardChecks with in-memory task.hardChecks
test('TC11: buildVerifierSpecContext unions sidecar and in-memory hardChecks', () => {
  const tmpDir = makeTmpDir();
  try {
    // Write sidecar with command 'node sc.js'
    const verifyDir = path.join(tmpDir, 'verify');
    fs.mkdirSync(verifyDir, { recursive: true });
    fs.writeFileSync(
      path.join(verifyDir, 'task-X.json'),
      JSON.stringify({ hardChecks: [{ command: 'node sc.js' }] }),
    );

    const task = { id: 'X', hardChecks: [{ command: 'node t.js' }] };
    const criteria = [
      { description: 'C1', verification: { command: 'node t.js' } },
      { description: 'C2', verification: { command: 'node sc.js' } },
      { description: 'C3', verification: { command: 'node unrelated.js' } },
    ];
    const result = buildVerifierSpecContext(tmpDir, task, criteria);
    assert.ok(Array.isArray(result.relevantCriteria), 'expected relevantCriteria array');
    assert.strictEqual(result.relevantCriteria.length, 2,
      `expected 2 criteria (C1+C2) but got ${result.relevantCriteria.length}: ${JSON.stringify(result.relevantCriteria.map((c) => c.description))}`);
    const descriptions = result.relevantCriteria.map((c) => c.description);
    assert.ok(descriptions.includes('C1'), 'expected C1 in relevantCriteria');
    assert.ok(descriptions.includes('C2'), 'expected C2 in relevantCriteria');
  } finally {
    cleanup(tmpDir);
  }
});

// TC12: no sidecar + task with no hardChecks → empty relevantCriteria
test('TC12: buildVerifierSpecContext returns empty relevantCriteria when no hardChecks', () => {
  const tmpDir = makeTmpDir();
  try {
    const task = { id: 'Y' }; // no hardChecks
    const criteria = [
      { description: 'C1', verification: { command: 'node t.js' } },
    ];
    // No sidecar written
    const result = buildVerifierSpecContext(tmpDir, task, criteria);
    assert.ok(result && typeof result === 'object', 'expected an object');
    assert.deepStrictEqual(result.relevantCriteria, [],
      `expected [] but got ${JSON.stringify(result.relevantCriteria)}`);
  } finally {
    cleanup(tmpDir);
  }
});

// ── Structural assertion: pipeline.js delegates to spec-text.js ───────────

test('structural: pipeline.js imports the five spec-text.js functions as thin delegates', () => {
  const pipelinePath = new URL('../src/orchestrator/core/pipeline.js', import.meta.url).pathname;
  const pipelineSource = fs.readFileSync(pipelinePath, 'utf8');
  const importPattern = /import\s*\{[^}]*\breadSpecTargetFiles\b[^}]*\}\s*from\s*['"]\.\/spec-text\.js['"]/;
  assert.ok(importPattern.test(pipelineSource),
    'pipeline.js must import readSpecTargetFiles from spec-text.js');
  const fiveNames = [
    'readSpecTargetFiles',
    'readSpecConstraints',
    'readSpecAcceptanceCriteria',
    'readSpecGoal',
    'buildVerifierSpecContext',
  ];
  for (const name of fiveNames) {
    assert.ok(
      pipelineSource.includes(name),
      `pipeline.js must reference ${name}`,
    );
  }
  // Verify the parsing bodies live in spec-text.js (not pipeline.js): the direct
  // JSON.parse of the spec json should appear in spec-text.js.
  const specTextPath = new URL('../src/orchestrator/core/spec-text.js', import.meta.url).pathname;
  const specTextSource = fs.readFileSync(specTextPath, 'utf8');
  assert.ok(specTextSource.includes('JSON.parse'),
    'spec-text.js must contain JSON.parse (parsing body lives here)');
  assert.ok(specTextSource.includes('export function readSpecTargetFiles'),
    'spec-text.js must export readSpecTargetFiles');
  assert.ok(specTextSource.includes('export function buildVerifierSpecContext'),
    'spec-text.js must export buildVerifierSpecContext');
});

// ── TC13: _anchorPrdPath cache-reset re-read (W1-F1 end-to-end through delegation layer) ──

// Spec pair fixture factory (mirrors test-prdpath-anchor.js pattern)
function specJsonForTC13(tag, file) {
  return JSON.stringify({
    goal: `GOAL-${tag}`,
    target_files: [file],
    acceptance_criteria: [
      { description: `CRIT-${tag}`, verification: { kind: 'command', command: `node ${file}` } },
    ],
    constraints: [`CON-${tag}`],
  }, null, 2);
}

await asyncTest('TC13: _anchorPrdPath resets caches so Pipeline getters re-read the new spec via spec-text.js delegates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-text-tc13-'));
  try {
    // Write spec pair A
    const specAMd = path.join(root, 'spec-a.md');
    const specAJson = path.join(root, 'spec-a.json');
    fs.writeFileSync(specAMd, '# Spec A\n');
    fs.writeFileSync(specAJson, specJsonForTC13('A', 'src/a.js'));

    // Bootstrap .harness with prdPath=spec-a.md
    bootstrap(root, { prdPath: specAMd });

    // Construct Pipeline
    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: () => {},
      onConfirm: async () => true,
    });

    // Assert getters serve spec A
    assert.strictEqual(pipeline._getSpecGoal(), 'GOAL-A',
      `expected _getSpecGoal() === 'GOAL-A' but got '${pipeline._getSpecGoal()}'`);
    assert.deepStrictEqual(pipeline._getSpecTargetFiles(), ['src/a.js'],
      `expected _getSpecTargetFiles() deep-equals ['src/a.js'] but got ${JSON.stringify(pipeline._getSpecTargetFiles())}`);

    // Write spec pair B
    const specBMd = path.join(root, 'spec-b.md');
    const specBJson = path.join(root, 'spec-b.json');
    fs.writeFileSync(specBMd, '# Spec B\n');
    fs.writeFileSync(specBJson, specJsonForTC13('B', 'src/b.js'));

    // Anchor to spec B — must reset caches
    await pipeline._anchorPrdPath({ prdPath: specBMd });

    // Assert getters now serve spec B (cache was reset, re-reads B)
    assert.strictEqual(pipeline._getSpecGoal(), 'GOAL-B',
      `expected _getSpecGoal() === 'GOAL-B' after _anchorPrdPath but got '${pipeline._getSpecGoal()}' (cache not reset)`);
    assert.deepStrictEqual(pipeline._getSpecTargetFiles(), ['src/b.js'],
      `expected _getSpecTargetFiles() deep-equals ['src/b.js'] after _anchorPrdPath but got ${JSON.stringify(pipeline._getSpecTargetFiles())} (cache not reset)`);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── TC14 & TC15: Structural assertions on pipeline.js five-method region ─────

test('TC14: pipeline.js five-method region (_getSpecTargetFiles through _buildVerifierSpecContext) contains zero JSON.parse calls', () => {
  const pipelinePath = new URL('../src/orchestrator/core/pipeline.js', import.meta.url).pathname;
  const pipelineSource = fs.readFileSync(pipelinePath, 'utf8');
  const lines = pipelineSource.split('\n');

  // Find the _getSpecTargetFiles method definition line index
  const startIdx = lines.findIndex((line) => /^\s+_getSpecTargetFiles\s*\(/.test(line));
  assert.ok(startIdx >= 0, 'could not find _getSpecTargetFiles method definition in pipeline.js');

  // Find the _anchorPrdPath method definition line index
  const endIdx = lines.findIndex((line) => /^\s+_anchorPrdPath\s*\(/.test(line));
  assert.ok(endIdx >= 0, 'could not find _anchorPrdPath method definition in pipeline.js');
  assert.ok(endIdx > startIdx, '_anchorPrdPath must appear after _getSpecTargetFiles');

  // Extract the region from _getSpecTargetFiles up to (not including) _anchorPrdPath
  const region = lines.slice(startIdx, endIdx).join('\n');

  const matches = region.match(/JSON\.parse/g);
  assert.strictEqual(matches, null,
    `expected zero JSON.parse in five-method region but found: ${JSON.stringify(matches)}`);
});

test('TC15: fs.readFileSync for spec reads lives only in spec-text.js, not in pipeline.js five-method region', () => {
  const pipelinePath = new URL('../src/orchestrator/core/pipeline.js', import.meta.url).pathname;
  const specTextPath = new URL('../src/orchestrator/core/spec-text.js', import.meta.url).pathname;

  const pipelineSource = fs.readFileSync(pipelinePath, 'utf8');
  const specTextSource = fs.readFileSync(specTextPath, 'utf8');

  // spec-text.js must contain fs.readFileSync (the reads live there)
  assert.ok(specTextSource.includes('fs.readFileSync'),
    'spec-text.js must contain fs.readFileSync (reads should live here)');

  // Extract the five-method region from pipeline.js
  const lines = pipelineSource.split('\n');
  const startIdx = lines.findIndex((line) => /^\s+_getSpecTargetFiles\s*\(/.test(line));
  assert.ok(startIdx >= 0, 'could not find _getSpecTargetFiles method definition in pipeline.js');
  const endIdx = lines.findIndex((line) => /^\s+_anchorPrdPath\s*\(/.test(line));
  assert.ok(endIdx >= 0, 'could not find _anchorPrdPath method definition in pipeline.js');
  assert.ok(endIdx > startIdx, '_anchorPrdPath must appear after _getSpecTargetFiles');

  const region = lines.slice(startIdx, endIdx).join('\n');

  // The five-method region in pipeline.js must NOT contain fs.readFileSync
  assert.ok(!region.includes('fs.readFileSync'),
    'pipeline.js five-method region must not contain fs.readFileSync (reads were migrated to spec-text.js)');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 (spec: w4-batch-failure-input-boundary) — falsy-prdPath parity cases.
//
// Behavior-restoring (criterion 4): the f9e4507 extraction silently dropped the
// `if (prdPath)` guard the four original pipeline readers had. With a FALSY
// prdPath (reachable — bootstrap defaults prdPath = ''), deriveSpecJsonPath
// falls back to <projectRoot>/spec.json, so the readers now inject an unrelated
// root spec.json's goal/target_files/constraints/acceptance_criteria into
// planner prompts and verifier context. The pre-extraction contract returned
// EMPTY on a falsy prdPath. These parity cases pin that contract for all four
// readers (test '' AND null/undefined) plus buildVerifierSpecContext.
//
// Non-vacuous: each case STAGES a real <projectRoot>/spec.json carrying
// distinctive values. At a pre-fix HEAD the readers read them (the assertions
// fail); after the guard is restored they return their empty defaults (pass).
// The staged root spec.json is asserted to remain present and untouched.
// ═══════════════════════════════════════════════════════════════════════════

// Distinctive root spec.json so a fallback read is unmistakable.
const AC4_ROOT_SPEC = JSON.stringify({
  goal: 'AC4-ROOT-GOAL-must-not-be-read',
  target_files: ['src/ac4-root-leak.js'],
  constraints: ['AC4-ROOT-CONSTRAINT'],
  acceptance_criteria: [{ description: 'AC4-ROOT-CRITERION', verification: { kind: 'command', command: 'node ac4.js' } }],
}, null, 2);

// The set of falsy prdPath values that are reachable in production:
//   '' — bootstrap's default; null/undefined — goal-only / forgotten path.
const AC4_FALSY_PRDPATHS = [
  ['empty-string', ''],
  ['null', null],
  ['undefined', undefined],
];

for (const [label, falsyPrdPath] of AC4_FALSY_PRDPATHS) {
  test(`AC4: all four spec-text readers return empty defaults on a falsy prdPath (${label}) without deriving the <projectRoot>/spec.json fallback`, () => {
    const tmpDir = makeTmpDir();
    try {
      // Stage a real, unrelated project-root spec.json (the fallback target).
      const rootSpecJson = path.join(tmpDir, 'spec.json');
      fs.writeFileSync(rootSpecJson, AC4_ROOT_SPEC);

      // readSpecTargetFiles → [] (not the root spec.json's target_files)
      const tf = readSpecTargetFiles(falsyPrdPath, tmpDir);
      assert.deepStrictEqual(tf, [],
        `readSpecTargetFiles must return [] on a falsy prdPath (${label}); got ${JSON.stringify(tf)} — the root spec.json was read (guard dropped)`);

      // readSpecConstraints → []
      const con = readSpecConstraints(falsyPrdPath, tmpDir);
      assert.deepStrictEqual(con, [],
        `readSpecConstraints must return [] on a falsy prdPath (${label}); got ${JSON.stringify(con)}`);

      // readSpecAcceptanceCriteria → []
      const ac = readSpecAcceptanceCriteria(falsyPrdPath, tmpDir);
      assert.deepStrictEqual(ac, [],
        `readSpecAcceptanceCriteria must return [] on a falsy prdPath (${label}); got ${JSON.stringify(ac)}`);

      // readSpecGoal → ''
      const goal = readSpecGoal(falsyPrdPath, tmpDir);
      assert.strictEqual(goal, '',
        `readSpecGoal must return '' on a falsy prdPath (${label}); got ${JSON.stringify(goal)} — the root spec.json goal leaked in`);

      // The staged project-root spec.json must remain present and unchanged —
      // the readers never read it (and certainly never write/unlink it).
      assert.ok(fs.existsSync(rootSpecJson),
        'the staged project-root spec.json must remain present (the readers must not touch it)');
      assert.strictEqual(fs.readFileSync(rootSpecJson, 'utf8'), AC4_ROOT_SPEC,
        'the staged project-root spec.json content must be unchanged');
    } finally {
      cleanup(tmpDir);
    }
  });
}

// Parity case for buildVerifierSpecContext on the falsy path. Per the spec it
// is OUT OF SCOPE for the prdPath guard (it never calls deriveSpecJsonPath — it
// resolves its spec-context path under the harness dir by task id), so it must
// stay empty/unaffected: with no sidecar and no task hardChecks, an empty
// criteria input yields empty relevantCriteria, and a populated criteria input
// with no matching hardChecks still yields empty — never a root-spec.json leak.
test('AC4: buildVerifierSpecContext stays empty/unaffected on the falsy path (no deriveSpecJsonPath fallback; no project-root spec.json read)', () => {
  const tmpDir = makeTmpDir();
  try {
    // Stage a project-root spec.json — buildVerifierSpecContext must ignore it
    // entirely (it does not consult deriveSpecJsonPath / the project root).
    fs.writeFileSync(path.join(tmpDir, 'spec.json'), AC4_ROOT_SPEC);

    const harnessDir = path.join(tmpDir, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    // (a) Empty criteria + task with no hardChecks → empty relevantCriteria.
    const r1 = buildVerifierSpecContext(harnessDir, { id: 'Z' }, []);
    assert.ok(r1 && typeof r1 === 'object', 'expected an object');
    assert.deepStrictEqual(r1.relevantCriteria, [],
      `buildVerifierSpecContext must return empty relevantCriteria with no hardChecks/criteria (got ${JSON.stringify(r1.relevantCriteria)})`);

    // (b) Populated criteria but no matching hardChecks → still empty; in
    // particular it must NOT have pulled in the root spec.json's criterion.
    const criteria = [
      { description: 'UNRELATED-IN-MEMORY', verification: { kind: 'command', command: 'node unrelated.js' } },
    ];
    const r2 = buildVerifierSpecContext(harnessDir, { id: 'Z' }, criteria);
    assert.deepStrictEqual(r2.relevantCriteria, [],
      `buildVerifierSpecContext must stay empty with no matching hardChecks (got ${JSON.stringify(r2.relevantCriteria)})`);
    assert.ok(!JSON.stringify(r2.relevantCriteria).includes('AC4-ROOT-CRITERION'),
      'buildVerifierSpecContext must never inject the project-root spec.json criterion');

    // The staged project-root spec.json must remain present and unchanged.
    assert.strictEqual(fs.readFileSync(path.join(tmpDir, 'spec.json'), 'utf8'), AC4_ROOT_SPEC,
      'buildVerifierSpecContext must not touch the project-root spec.json');
  } finally {
    cleanup(tmpDir);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
