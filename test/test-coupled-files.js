#!/usr/bin/env node
/**
 * test-coupled-files.js — Unit tests for coupled-files.js (matchesGlob,
 * expandCoupledTargets) plus its integration with the .cc-orch.json
 * scope.coupledFiles override path (loadProjectConfig) and the two
 * production "reader surfaces" that feed a task's declared target files
 * into expandCoupledTargets: the memoized getSpecTargetFiles() getter and
 * the direct parseSpecTargetFiles() reader.
 *
 * Hermetic: no live Claude session is opened, no network call is made, and
 * no real .harness orchestrator run is executed — every fixture below is a
 * plain fs.mkdtemp scratch directory whose state.json / spec.json /
 * .cc-orch.json files are read directly by the pure functions under test.
 *
 * Run: node test/test-coupled-files.js
 */

// See scripts/run-tests.js for the rationale: clear the re-entrancy marker
// at module top so this suite runs re-entrancy-neutral regardless of launch
// context (mkdtemp fixture roots here are not live runs).
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { matchesGlob, expandCoupledTargets } from '../src/orchestrator/core/coupled-files.js';
import { loadProjectConfig } from '../src/orchestrator/infra/project-config.js';
import config from '../src/orchestrator/infra/config.js';
import { getSpecTargetFiles } from '../src/orchestrator/core/assumption-data.js';
import { parseSpecTargetFiles } from '../src/orchestrator/agents/planner.js';
import { Pipeline, applySpecHardChecks } from '../src/orchestrator/core/pipeline.js';
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

// ── Fixture helpers ─────────────────────────────────────────────────────────

function makeTmpRoot(prefix = 'cc-orch-coupled-files-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function writeCcOrchJson(root, obj) {
  fs.writeFileSync(path.join(root, '.cc-orch.json'), JSON.stringify(obj), 'utf8');
}

/** Reset the config singleton's scope.coupledFiles before/after a case so
 * earlier cases in this same process never leak into a later one. */
function resetConfigScope() {
  config.scope.coupledFiles = [];
}

function assertThrowsNamingFileAndKey(fn, filePath, keyFragment) {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, `expected loadProjectConfig to throw for key fragment "${keyFragment}"`);
  assert.ok(
    thrown.message.includes(filePath),
    `error message should name the file path "${filePath}", got: ${thrown.message}`
  );
  assert.ok(
    thrown.message.includes(keyFragment),
    `error message should name the offending key "${keyFragment}", got: ${thrown.message}`
  );
}

// ── matchesGlob ──────────────────────────────────────────────────────────────

test('TC1: `*` matches any run of characters within a single path segment only', () => {
  assert.strictEqual(matchesGlob('src/foo.js', 'src/*.js'), true);
  assert.strictEqual(matchesGlob('src/sub/foo.js', 'src/*.js'), false,
    'a single `*` must never cross a `/` segment boundary');
});

test('TC2: `**` matches any run of characters across segment boundaries', () => {
  assert.strictEqual(matchesGlob('src/a/b/c.js', 'src/**.js'), true,
    '`**` must be able to cross multiple `/` boundaries');
  assert.strictEqual(matchesGlob('src/a.js', 'src/**.js'), true,
    '`**` must also match zero crossed boundaries (a single segment)');
  assert.strictEqual(matchesGlob('src/a/b/c.js', 'src/*.js'), false,
    'sanity: the segment-bounded `*` variant must still refuse to cross `/`');
});

test('TC3: a literal `.` in the pattern is not treated as "match any character"', () => {
  assert.strictEqual(matchesGlob('src/foo.js', 'src/foo.js'), true);
  assert.strictEqual(matchesGlob('src/fooxjs', 'src/foo.js'), false,
    'a literal "." must not behave like the regex "any character" wildcard');
});

test('TC4: a literal `+` in the pattern is not treated as a regex quantifier', () => {
  assert.strictEqual(matchesGlob('src/a+b.js', 'src/a+b.js'), true);
  assert.strictEqual(matchesGlob('src/aab.js', 'src/a+b.js'), false,
    'a literal "+" must not behave like the regex "one or more of preceding" quantifier');
});

test('TC5: matching is anchored to the full path — no partial/substring match', () => {
  assert.strictEqual(matchesGlob('foo.js', 'foo.js'), true);
  assert.strictEqual(matchesGlob('src/foo.js', 'foo.js'), false,
    'an unanchored substring match must be rejected — the pattern must cover the whole path');
  assert.strictEqual(matchesGlob('src/foo.js.bak', 'src/foo.js'), false,
    'a pattern must not match a path that merely starts with it');
});

test('TC6: invalid (non-string / empty / null / undefined / number) input returns false', () => {
  assert.strictEqual(matchesGlob('', 'src/*.js'), false);
  assert.strictEqual(matchesGlob('src/foo.js', ''), false);
  assert.strictEqual(matchesGlob(null, 'src/*.js'), false);
  assert.strictEqual(matchesGlob(undefined, 'src/*.js'), false);
  assert.strictEqual(matchesGlob(42, 'src/*.js'), false);
  assert.strictEqual(matchesGlob('src/foo.js', null), false);
  assert.strictEqual(matchesGlob('src/foo.js', undefined), false);
  assert.strictEqual(matchesGlob('src/foo.js', 7), false);
});

// ── expandCoupledTargets ─────────────────────────────────────────────────────

test('TC7: expandCoupledTargets is identity (new array, same content) when coupledRules is undefined or []', () => {
  const input = ['a.js', 'b.js'];

  const resultUndefined = expandCoupledTargets(input, undefined);
  assert.deepStrictEqual(resultUndefined, input);
  assert.notStrictEqual(resultUndefined, input, 'must return a new array, not the same reference');

  const resultEmpty = expandCoupledTargets(input, []);
  assert.deepStrictEqual(resultEmpty, input);
  assert.notStrictEqual(resultEmpty, input);
});

test('TC8: expandCoupledTargets returns targetFiles unchanged when no rule matches', () => {
  const input = ['a.js', 'b.js'];
  const rules = [{ when: 'zzz/*.js', alsoTarget: ['never-added.js'] }];
  const result = expandCoupledTargets(input, rules);
  assert.deepStrictEqual(result, input);
});

test('TC9: expandCoupledTargets unions a matching rule\'s alsoTarget paths into the result', () => {
  const result = expandCoupledTargets(
    ['test/test-foo.js'],
    [{ when: 'test/test-*.js', alsoTarget: ['scripts/run-tests.js'] }]
  );
  assert.deepStrictEqual(result, ['test/test-foo.js', 'scripts/run-tests.js']);
});

test('TC10: expandCoupledTargets dedupes alsoTarget paths already present (from targetFiles or an earlier rule)', () => {
  const result = expandCoupledTargets(
    ['a.js', 'b.js'],
    [{ when: 'a.js', alsoTarget: ['b.js', 'c.js'] }]
  );
  assert.deepStrictEqual(result, ['a.js', 'b.js', 'c.js'],
    'b.js was already present in targetFiles and must not be duplicated');

  const resultAcrossRules = expandCoupledTargets(
    ['a.js'],
    [
      { when: 'a.js', alsoTarget: ['x.js'] },
      { when: 'a.js', alsoTarget: ['x.js', 'y.js'] },
    ]
  );
  assert.deepStrictEqual(resultAcrossRules, ['a.js', 'x.js', 'y.js'],
    'x.js was already added by the first rule and must not be duplicated by the second');
});

test('TC11: expandCoupledTargets preserves order — originals first, then each matching rule\'s alsoTarget in rule order', () => {
  const result = expandCoupledTargets(
    ['b.js', 'a.js'],
    [
      { when: 'a.js', alsoTarget: ['c.js'] },
      { when: 'b.js', alsoTarget: ['d.js'] },
    ]
  );
  assert.deepStrictEqual(result, ['b.js', 'a.js', 'c.js', 'd.js'],
    'originals must keep their given order, and rules append in rule-array order, not match order');
});

test('TC12: expandCoupledTargets never mutates targetFiles or coupledRules', () => {
  const targetFiles = ['a.js'];
  const rules = [{ when: 'a.js', alsoTarget: ['b.js'] }];
  const targetFilesSnapshot = JSON.parse(JSON.stringify(targetFiles));
  const rulesSnapshot = JSON.parse(JSON.stringify(rules));

  expandCoupledTargets(targetFiles, rules);

  assert.deepStrictEqual(targetFiles, targetFilesSnapshot, 'targetFiles must not be mutated');
  assert.deepStrictEqual(rules, rulesSnapshot, 'coupledRules must not be mutated');
});

test('TC13: expandCoupledTargets tolerates malformed rules — skips them without throwing', () => {
  const rules = [
    null,
    42,
    'not-an-object',
    {},                                             // missing when + alsoTarget
    { when: 123, alsoTarget: ['x.js'] },             // when not a string
    { when: '', alsoTarget: ['x.js'] },              // empty when
    { when: 'a.js', alsoTarget: 'not-an-array' },    // alsoTarget not an array
    { when: 'a.js', alsoTarget: [123, '', 'valid.js'] }, // mixed valid/invalid entries
  ];

  let result;
  assert.doesNotThrow(() => {
    result = expandCoupledTargets(['a.js'], rules);
  });
  assert.deepStrictEqual(result, ['a.js', 'valid.js'],
    'only the well-formed rule\'s valid alsoTarget entries should be appended');
});

test('TC14: expandCoupledTargets returns [] when targetFiles is not an array', () => {
  assert.deepStrictEqual(expandCoupledTargets(null, [{ when: 'a', alsoTarget: ['b'] }]), []);
  assert.deepStrictEqual(expandCoupledTargets(undefined, []), []);
  assert.deepStrictEqual(expandCoupledTargets('not-array', []), []);
});

// ── expandCoupledTargets (area b): behavior cases for the real export ──────

test('TC-b1: a matching rule appends its alsoTarget paths after the original entries, preserving original order', () => {
  const result = expandCoupledTargets(
    ['x.js', 'y.js'],
    [{ when: 'x.js', alsoTarget: ['z.js', 'w.js'] }]
  );
  assert.deepStrictEqual(result, ['x.js', 'y.js', 'z.js', 'w.js'],
    'originals must stay in their original order, followed by the matching rule\'s alsoTarget entries in array order');
});

test('TC-b2: a rule matched by two different input entries, and an alsoTarget already present in the input, each yield no duplicate in the result', () => {
  const result = expandCoupledTargets(
    ['test/a.js', 'test/b.js'],
    [{ when: 'test/*.js', alsoTarget: ['test/a.js', 'shared.js'] }]
  );
  assert.deepStrictEqual(result, ['test/a.js', 'test/b.js', 'shared.js'],
    'the rule\'s when matches both test/a.js and test/b.js, but its alsoTarget entries must still be unioned in only once; ' +
    'test/a.js is already present in the input and must not be duplicated');
});

test('TC-b3: the input array and rule objects deep-equal a pre-call snapshot after the call, and the result is not the same array reference as the input', () => {
  const input = ['a.js', 'b.js'];
  const rules = [{ when: 'a.js', alsoTarget: ['c.js'] }];
  const inputSnapshot = JSON.parse(JSON.stringify(input));
  const rulesSnapshot = JSON.parse(JSON.stringify(rules));

  const result = expandCoupledTargets(input, rules);

  assert.deepStrictEqual(input, inputSnapshot, 'the input array must not be mutated by the call');
  assert.deepStrictEqual(rules, rulesSnapshot, 'the rule objects must not be mutated by the call');
  assert.notStrictEqual(result, input, 'the returned array must be a different reference than the input');
});

test('TC-b4: a rule whose `when` matches no input entry returns a list whose content equals the input', () => {
  const input = ['a.js', 'b.js'];
  const result = expandCoupledTargets(input, [{ when: 'nomatch/*.js', alsoTarget: ['never-added.js'] }]);
  assert.deepStrictEqual(result, input);
});

test('TC-b5: an empty rules array and an absent/undefined rules argument each return a list whose content equals the input (identity)', () => {
  const input = ['a.js', 'b.js'];

  const resultEmpty = expandCoupledTargets(input, []);
  assert.deepStrictEqual(resultEmpty, input);

  const resultUndefined = expandCoupledTargets(input);
  assert.deepStrictEqual(resultUndefined, input);
});

// ── .cc-orch.json scope.coupledFiles → config.scope.coupledFiles ───────────

test('TC15: loadProjectConfig applies a valid scope.coupledFiles rule onto config.scope.coupledFiles', () => {
  const root = makeTmpRoot();
  try {
    resetConfigScope();
    const rule = { when: 'test/test-*.js', alsoTarget: ['scripts/run-tests.js'] };
    writeCcOrchJson(root, { scope: { coupledFiles: [rule] } });

    loadProjectConfig(root);

    assert.deepStrictEqual(config.scope.coupledFiles, [rule]);
  } finally {
    cleanup(root);
    resetConfigScope();
  }
});

test('TC16: loadProjectConfig leaves config.scope.coupledFiles as [] when .cc-orch.json has no scope section', () => {
  const root = makeTmpRoot();
  try {
    resetConfigScope();
    writeCcOrchJson(root, {});

    loadProjectConfig(root);

    assert.deepStrictEqual(config.scope.coupledFiles, []);
  } finally {
    cleanup(root);
    resetConfigScope();
  }
});

test('TC17: loadProjectConfig fail-loud — invalid scope.coupledFiles shapes throw, naming the file path and offending key', () => {
  const root = makeTmpRoot();
  const filePath = path.join(root, '.cc-orch.json');
  try {
    resetConfigScope();

    const cases = [
      { config: { scope: { coupledFiles: 'not-an-array' } }, key: 'scope.coupledFiles' },
      { config: { scope: { coupledFiles: [42] } }, key: 'scope.coupledFiles[0]' },
      { config: { scope: { coupledFiles: [{ when: 'a.js', alsoTarget: ['b.js'], extra: true }] } }, key: 'scope.coupledFiles[0].extra' },
      { config: { scope: { coupledFiles: [{ alsoTarget: ['b.js'] }] } }, key: 'scope.coupledFiles[0].when' },
      { config: { scope: { coupledFiles: [{ when: '', alsoTarget: ['b.js'] }] } }, key: 'scope.coupledFiles[0].when' },
      { config: { scope: { coupledFiles: [{ when: 'a.js' }] } }, key: 'scope.coupledFiles[0].alsoTarget' },
      { config: { scope: { coupledFiles: [{ when: 'a.js', alsoTarget: [] }] } }, key: 'scope.coupledFiles[0].alsoTarget' },
      { config: { scope: { coupledFiles: [{ when: 'a.js', alsoTarget: [42] }] } }, key: 'scope.coupledFiles[0].alsoTarget[0]' },
    ];

    for (const { config: badConfig, key } of cases) {
      writeCcOrchJson(root, badConfig);
      assertThrowsNamingFileAndKey(() => loadProjectConfig(root), filePath, key);
    }
  } finally {
    cleanup(root);
    resetConfigScope();
  }
});

test('TC18: loadProjectConfig fail-loud — invalid "scope" section shape and unknown scope keys throw, naming file+key', () => {
  const root = makeTmpRoot();
  const filePath = path.join(root, '.cc-orch.json');
  try {
    resetConfigScope();

    writeCcOrchJson(root, { scope: 'not-an-object' });
    assertThrowsNamingFileAndKey(() => loadProjectConfig(root), filePath, '"scope"');

    writeCcOrchJson(root, { scope: { unknownKey: true } });
    assertThrowsNamingFileAndKey(() => loadProjectConfig(root), filePath, 'scope.unknownKey');
  } finally {
    cleanup(root);
    resetConfigScope();
  }
});

// ── Reader surfaces: memoized getter vs. parseSpecTargetFiles-fed path ─────

test('TC19: both reader surfaces (memoized getSpecTargetFiles getter, and parseSpecTargetFiles) feed expandCoupledTargets to the same expanded set', () => {
  const root = makeTmpRoot();
  try {
    resetConfigScope();

    const rule = { when: 'src/orchestrator/core/*.js', alsoTarget: ['test/test-coupled-files.js'] };
    writeCcOrchJson(root, { scope: { coupledFiles: [rule] } });
    loadProjectConfig(root);
    assert.deepStrictEqual(config.scope.coupledFiles, [rule]);

    // Shared spec.json fixture: declares one target file that matches the rule's `when`.
    const specJsonPath = path.join(root, 'spec.json');
    fs.writeFileSync(
      specJsonPath,
      JSON.stringify({ goal: 'fixture', target_files: ['src/orchestrator/core/coupled-files.js'] }),
      'utf8'
    );

    // Reader surface A — the memoized getSpecTargetFiles() getter, anchored via
    // .harness/state.json's projectMeta.prdPath (absolute, so deriveSpecJsonPath
    // resolves the sibling spec.json without any cwd dependence).
    const harnessDir = path.join(root, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    const absoluteMdPath = path.join(root, 'spec.md');
    fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify({ projectMeta: { prdPath: absoluteMdPath } }), 'utf8');

    const cache = {};
    const targetsA = getSpecTargetFiles(harnessDir, root, cache);
    assert.deepStrictEqual(targetsA, ['src/orchestrator/core/coupled-files.js']);
    assert.notStrictEqual(cache.value, undefined, 'an anchored read must be memoized onto the cache holder');
    const expandedA = expandCoupledTargets(targetsA, config.scope.coupledFiles);

    // Reader surface B — parseSpecTargetFiles(), a direct spec.json path reader.
    const targetsB = parseSpecTargetFiles(specJsonPath);
    assert.deepStrictEqual(targetsB, ['src/orchestrator/core/coupled-files.js']);
    const expandedB = expandCoupledTargets(targetsB, config.scope.coupledFiles);

    // Both reader surfaces must feed expandCoupledTargets to the SAME expanded set.
    assert.deepStrictEqual(expandedA, ['src/orchestrator/core/coupled-files.js', 'test/test-coupled-files.js']);
    assert.deepStrictEqual(expandedB, expandedA);
  } finally {
    cleanup(root);
    resetConfigScope();
  }
});

// ── Pipeline wiring: Pipeline._getSpecTargetFiles() applies config.scope.coupledFiles ──

test('TC20: Pipeline._getSpecTargetFiles() returns the declared list unexpanded when coupledFiles is empty, and declared+coupled when a matching rule is injected onto the config singleton', () => {
  const root = makeTmpRoot('cc-orch-coupled-pipeline-');
  try {
    resetConfigScope();

    const declaredTargetFiles = ['src/a.js', 'src/b.js'];
    const specMdPath = path.join(root, 'spec.md');
    const specJsonPath = path.join(root, 'spec.json');
    fs.writeFileSync(specMdPath, '# Spec\n', 'utf8');
    fs.writeFileSync(specJsonPath, JSON.stringify({ goal: 'fixture', target_files: declaredTargetFiles }), 'utf8');

    bootstrap(root, { prdPath: specMdPath });

    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: () => {},
      onConfirm: async () => true,
    });

    // Phase 1: coupledFiles is empty/absent — declared list returned unexpanded.
    assert.deepStrictEqual(
      pipeline._getSpecTargetFiles(),
      declaredTargetFiles,
      `expected _getSpecTargetFiles() to deep-equal the raw declared target_files ${JSON.stringify(declaredTargetFiles)} but got ${JSON.stringify(pipeline._getSpecTargetFiles())}`
    );

    // Phase 2: inject a matching rule onto the config singleton.
    const rule = { when: 'src/*.js', alsoTarget: ['test/coupled-fixture.js'] };
    config.scope.coupledFiles = [rule];

    assert.deepStrictEqual(
      pipeline._getSpecTargetFiles(),
      [...declaredTargetFiles, 'test/coupled-fixture.js'],
      'expected the coupled path to be appended after the declared entries, in original order'
    );
  } finally {
    cleanup(root);
    resetConfigScope();
  }
});

// ── Structural: pipeline.js/planner.js expandCoupledTargets call-site counts ──

test('TC21: pipeline.js source contains exactly four `expandCoupledTargets(` call sites', () => {
  const pipelinePath = new URL('../src/orchestrator/core/pipeline.js', import.meta.url).pathname;
  const pipelineSource = fs.readFileSync(pipelinePath, 'utf8');
  const matches = pipelineSource.match(/expandCoupledTargets\(/g) || [];
  assert.strictEqual(matches.length, 4,
    `expected exactly 4 \`expandCoupledTargets(\` call sites in pipeline.js but found ${matches.length}`);
});

test('TC22: planner.js source contains zero `expandCoupledTargets` occurrences', () => {
  const plannerPath = new URL('../src/orchestrator/agents/planner.js', import.meta.url).pathname;
  const plannerSource = fs.readFileSync(plannerPath, 'utf8');
  const matches = plannerSource.match(/expandCoupledTargets/g) || [];
  assert.strictEqual(matches.length, 0,
    `expected zero \`expandCoupledTargets\` occurrences in planner.js but found ${matches.length}`);
});

// ── (c) .cc-orch.json scope.coupledFiles — fail-loud loader validation ─────
// Mirrors the loader-validation idiom in test/test-project-config.js: an
// fs.mkdtempSync fixture dir (never the repo root), a JSON writer, a
// singleton snapshot/restore wrapper, and assert.throws with a predicate
// that pins both the fixture file path and the offending key in the error
// message. The loader mutates config.scope.coupledFiles — a shared module
// singleton — so every case below snapshots it before running and restores
// it in a finally block, regardless of whether the case's body throws. This
// keeps a case's override from leaking into any sibling case, including the
// pre-existing TC15–TC22 cases above.

function createFixtureDirC() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coupled-files-loader-'));
}

function writeJsonConfigFileC(dir, obj) {
  const filePath = path.join(dir, '.cc-orch.json');
  fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');
  return filePath;
}

/**
 * Snapshots config.scope.coupledFiles, runs fn, and restores it in finally
 * — regardless of whether fn throws. The loader mutates a shared module
 * singleton, so a leaked override would corrupt sibling (c) cases (and the
 * pre-existing TC15–TC22 cases above), which TC-c7 pins.
 */
function withSavedCoupledFiles(fn) {
  const saved = config.scope.coupledFiles;
  try {
    return fn(saved);
  } finally {
    config.scope.coupledFiles = saved;
  }
}

function assertThrowsNamingFileAndKeyC(fn, filePath, keyFragment) {
  assert.throws(() => fn(), (err) => {
    assert.ok(err instanceof Error, 'must throw an Error');
    assert.ok(
      err.message.includes(filePath),
      `error message must contain the fixture file path (${filePath}), got: ${err.message}`
    );
    assert.ok(
      err.message.includes(keyFragment),
      `error message must name the offending key "${keyFragment}", got: ${err.message}`
    );
    return true;
  });
}

// Suite-level snapshot for area (c), captured before any (c) case runs, so
// TC-c7 can pin that no (c) case leaks a mutation past its own finally block.
const AREA_C_INITIAL_COUPLED_FILES = config.scope.coupledFiles;

test('TC-c1: a fixture with a valid coupledFiles rule array leaves config.scope.coupledFiles deep-equal to that array after loadProjectConfig', () => {
  withSavedCoupledFiles(() => {
    const fixture = createFixtureDirC();
    try {
      const rules = [{ when: 'src/*.js', alsoTarget: ['test/test-foo.js'] }];
      writeJsonConfigFileC(fixture, { scope: { coupledFiles: rules } });

      loadProjectConfig(fixture);

      assert.deepStrictEqual(config.scope.coupledFiles, rules);
    } finally {
      cleanup(fixture);
    }
  });
});

test('TC-c2: a fixture with no `scope` section leaves config.scope.coupledFiles as the shipped empty array', () => {
  withSavedCoupledFiles(() => {
    const fixture = createFixtureDirC();
    try {
      writeJsonConfigFileC(fixture, {});

      loadProjectConfig(fixture);

      assert.deepStrictEqual(config.scope.coupledFiles, []);
    } finally {
      cleanup(fixture);
    }
  });
});

test('TC-c3: an unknown key inside `scope` throws with a message containing the fixture path and the offending key name', () => {
  withSavedCoupledFiles(() => {
    const fixture = createFixtureDirC();
    try {
      const filePath = writeJsonConfigFileC(fixture, { scope: { unknownScopeKey: true } });

      assertThrowsNamingFileAndKeyC(() => loadProjectConfig(fixture), filePath, 'scope.unknownScopeKey');
    } finally {
      cleanup(fixture);
    }
  });
});

test('TC-c4: an unknown key inside a rule object throws with a message containing the fixture path and the offending key name', () => {
  withSavedCoupledFiles(() => {
    const fixture = createFixtureDirC();
    try {
      const filePath = writeJsonConfigFileC(fixture, {
        scope: { coupledFiles: [{ when: 'a.js', alsoTarget: ['b.js'], unknownRuleKey: 1 }] },
      });

      assertThrowsNamingFileAndKeyC(() => loadProjectConfig(fixture), filePath, 'scope.coupledFiles[0].unknownRuleKey');
    } finally {
      cleanup(fixture);
    }
  });
});

test("TC-c5: `when` values of '' and of a non-string each throw naming 'when' and the fixture path", () => {
  withSavedCoupledFiles(() => {
    const fixture = createFixtureDirC();
    try {
      let filePath = writeJsonConfigFileC(fixture, {
        scope: { coupledFiles: [{ when: '', alsoTarget: ['b.js'] }] },
      });
      assertThrowsNamingFileAndKeyC(() => loadProjectConfig(fixture), filePath, 'scope.coupledFiles[0].when');

      filePath = writeJsonConfigFileC(fixture, {
        scope: { coupledFiles: [{ when: 42, alsoTarget: ['b.js'] }] },
      });
      assertThrowsNamingFileAndKeyC(() => loadProjectConfig(fixture), filePath, 'scope.coupledFiles[0].when');
    } finally {
      cleanup(fixture);
    }
  });
});

test("TC-c6: `alsoTarget` values of [] and of a non-array each throw naming 'alsoTarget' and the fixture path; a non-string alsoTarget entry also throws naming the fixture path", () => {
  withSavedCoupledFiles(() => {
    const fixture = createFixtureDirC();
    try {
      let filePath = writeJsonConfigFileC(fixture, {
        scope: { coupledFiles: [{ when: 'a.js', alsoTarget: [] }] },
      });
      assertThrowsNamingFileAndKeyC(() => loadProjectConfig(fixture), filePath, 'scope.coupledFiles[0].alsoTarget');

      filePath = writeJsonConfigFileC(fixture, {
        scope: { coupledFiles: [{ when: 'a.js', alsoTarget: 'not-an-array' }] },
      });
      assertThrowsNamingFileAndKeyC(() => loadProjectConfig(fixture), filePath, 'scope.coupledFiles[0].alsoTarget');

      filePath = writeJsonConfigFileC(fixture, {
        scope: { coupledFiles: [{ when: 'a.js', alsoTarget: [42] }] },
      });
      assertThrowsNamingFileAndKeyC(() => loadProjectConfig(fixture), filePath, 'scope.coupledFiles[0].alsoTarget[0]');
    } finally {
      cleanup(fixture);
    }
  });
});

test('TC-c7: config.scope.coupledFiles holds its pre-suite value after every (c) case completes', () => {
  assert.deepStrictEqual(
    config.scope.coupledFiles,
    AREA_C_INITIAL_COUPLED_FILES,
    'config.scope.coupledFiles must equal its pre-area(c) value — no (c) case may leak an override past its finally block'
  );
});

test('TC-c8: every (c) case uses an fs.mkdtempSync fixture dir and removes it in a finally block', () => {
  const selfPath = new URL(import.meta.url).pathname;
  const source = fs.readFileSync(selfPath, 'utf8');
  // Start after the (c) helper function definitions — whose own try/finally
  // (inside withSavedCoupledFiles) would otherwise be double-counted — and
  // scan only the TC-c1..TC-c6 test bodies themselves.
  const sectionMarker = 'const AREA_C_INITIAL_COUPLED_FILES = config.scope.coupledFiles;';
  const sectionStart = source.indexOf(sectionMarker);
  assert.ok(sectionStart !== -1, 'area (c) suite-level snapshot marker must be present in this file');
  // Bound the section to TC-c1..TC-c7 (the fixture-using cases); TC-c8 (this
  // very test) is excluded from its own self-scan.
  const sectionEnd = source.indexOf("test('TC-c8:", sectionStart);
  assert.ok(sectionEnd !== -1, 'TC-c8 marker must be present to bound the self-scan');
  const section = source.slice(sectionStart, sectionEnd);

  const fixtureCreateCount = (section.match(/= createFixtureDirC\(\);/g) || []).length;
  const cleanupCount = (section.match(/cleanup\(fixture\)/g) || []).length;
  const finallyCount = (section.match(/\}\s*finally\s*\{/g) || []).length;

  assert.strictEqual(fixtureCreateCount, 6, 'expected 6 fixture dirs created, one per TC-c1..TC-c6');
  assert.strictEqual(cleanupCount, fixtureCreateCount, 'every fixture dir created must be removed via cleanup(fixture)');
  assert.strictEqual(finallyCount, fixtureCreateCount, 'every fixture-using case must remove its fixture inside a finally block');
});

// ── (d) choke-point integration — real production read paths ───────────────
// Drives the REAL production surfaces end to end against an fs.mkdtempSync
// project root: Pipeline#_getSpecTargetFiles() (the memoized getter) and the
// applySpecHardChecks export (a parseSpecTargetFiles-fed surface), with
// config.scope.coupledFiles set on the config singleton. No glob-matching or
// list-union logic is re-implemented here — every expansion is performed by
// the imported production functions themselves.

/**
 * Writes a spec.md/spec.json pair under `root` whose `target_files` is
 * `declaredTargetFiles` and whose `acceptance_criteria` is built from
 * `specCommands` (structured `verification: {kind:'command', command}`
 * entries, mirroring the (c)/hard-checks-pipeline-wiring fixture idiom).
 * Returns the absolute spec.md path (bootstrap's opts.prdPath).
 */
function writeSpecPairD(root, declaredTargetFiles, specCommands = []) {
  const specMdPath = path.join(root, 'spec.md');
  const specJsonPath = path.join(root, 'spec.json');
  fs.writeFileSync(specMdPath, '# Spec\n', 'utf8');
  fs.writeFileSync(specJsonPath, JSON.stringify({
    goal: 'coupled-files (d) fixture',
    target_files: declaredTargetFiles,
    acceptance_criteria: specCommands.map((c) => ({
      description: c.description,
      verification: { kind: 'command', command: c.command },
    })),
  }, null, 2), 'utf8');
  return { specMdPath, specJsonPath };
}

test('TC-d1: with a matching rule configured, pipeline._getSpecTargetFiles() against the mkdtemp fixture returns the declared target_files followed by the rule\'s alsoTarget paths', () => {
  const root = makeTmpRoot('cc-orch-coupled-d1-');
  try {
    resetConfigScope();

    const declaredTargetFiles = ['src/main.js'];
    const { specMdPath } = writeSpecPairD(root, declaredTargetFiles);

    bootstrap(root, { prdPath: specMdPath });

    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: () => {},
      onConfirm: async () => true,
    });

    const rule = { when: 'src/*.js', alsoTarget: ['test/coupled-fixture-d.js'] };
    config.scope.coupledFiles = [rule];

    assert.deepStrictEqual(
      pipeline._getSpecTargetFiles(),
      [...declaredTargetFiles, 'test/coupled-fixture-d.js'],
      `expected _getSpecTargetFiles() to deep-equal the declared target_files followed by the rule's alsoTarget paths, got ${JSON.stringify(pipeline._getSpecTargetFiles())}`
    );
  } finally {
    cleanup(root);
    resetConfigScope();
  }
});

test('TC-d2: with coupledFiles empty, pipeline._getSpecTargetFiles() against the same fixture returns exactly the declared target_files (control)', () => {
  const root = makeTmpRoot('cc-orch-coupled-d2-');
  try {
    resetConfigScope();

    const declaredTargetFiles = ['src/main.js'];
    const { specMdPath } = writeSpecPairD(root, declaredTargetFiles);

    bootstrap(root, { prdPath: specMdPath });

    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: () => {},
      onConfirm: async () => true,
    });

    // coupledFiles left empty — the control.
    assert.deepStrictEqual(
      pipeline._getSpecTargetFiles(),
      declaredTargetFiles,
      `expected _getSpecTargetFiles() to deep-equal the raw declared target_files ${JSON.stringify(declaredTargetFiles)} but got ${JSON.stringify(pipeline._getSpecTargetFiles())}`
    );
  } finally {
    cleanup(root);
    resetConfigScope();
  }
});

test('TC-d3: applySpecHardChecks driven against the fixture with a matching rule configured produces the outcome implied by the expanded declared set (a check naming the coupled path is no longer treated as outside the declared set)', () => {
  const root = makeTmpRoot('cc-orch-coupled-d3-');
  try {
    resetConfigScope();

    const declaredTargetFiles = ['src/main.js'];
    // The check's command names the coupled path (test/coupled-fixture-d.js),
    // NOT any declared target_file directly — only reachable as "inside the
    // declared set" once config.scope.coupledFiles expands it in.
    const specCommands = [{ description: 'coupled check', command: 'node test/coupled-fixture-d.js' }];
    const { specMdPath } = writeSpecPairD(root, declaredTargetFiles, specCommands);

    const { harnessDir } = bootstrap(root, { prdPath: specMdPath });

    const rule = { when: 'src/*.js', alsoTarget: ['test/coupled-fixture-d.js'] };
    config.scope.coupledFiles = [rule];

    const taskId = '001-001-001-001';
    const missionDecomp = {
      subMissions: [{
        id: '001-001-001',
        description: 'coupled (d) sm',
        tasks: [{
          id: taskId,
          description: 'coupled (d) task',
          targetFiles: ['test/coupled-fixture-d.js'],
          dependencies: [],
          testCases: [],
        }],
      }],
    };

    applySpecHardChecks(missionDecomp, root, harnessDir);

    const task = missionDecomp.subMissions[0].tasks.find((t) => t.id === taskId);
    const assignedCommands = (task.hardChecks || []).map((c) => c.command);
    assert.ok(
      assignedCommands.includes('node test/coupled-fixture-d.js'),
      `expected the coupled-path check to be assigned to the task (declared set expanded via the coupled rule); got hardChecks: ${JSON.stringify(assignedCommands)}`
    );
  } finally {
    cleanup(root);
    resetConfigScope();
  }
});

test('TC-d4: applySpecHardChecks driven against the same fixture with coupledFiles empty produces the unexpanded-set outcome (control)', () => {
  const root = makeTmpRoot('cc-orch-coupled-d4-');
  try {
    resetConfigScope();

    const declaredTargetFiles = ['src/main.js'];
    const specCommands = [{ description: 'coupled check', command: 'node test/coupled-fixture-d.js' }];
    const { specMdPath } = writeSpecPairD(root, declaredTargetFiles, specCommands);

    const { harnessDir } = bootstrap(root, { prdPath: specMdPath });

    // coupledFiles left empty — the control.
    const taskId = '001-001-001-001';
    const missionDecomp = {
      subMissions: [{
        id: '001-001-001',
        description: 'coupled (d) sm',
        tasks: [{
          id: taskId,
          description: 'coupled (d) task',
          targetFiles: ['test/coupled-fixture-d.js'],
          dependencies: [],
          testCases: [],
        }],
      }],
    };

    applySpecHardChecks(missionDecomp, root, harnessDir);

    const task = missionDecomp.subMissions[0].tasks.find((t) => t.id === taskId);
    const assignedCommands = (task.hardChecks || []).map((c) => c.command);
    assert.ok(
      !assignedCommands.includes('node test/coupled-fixture-d.js'),
      `expected the coupled-path check to NOT be assigned (declared set stays unexpanded with coupledFiles empty); got hardChecks: ${JSON.stringify(assignedCommands)}`
    );
  } finally {
    cleanup(root);
    resetConfigScope();
  }
});

test('TC-d5: the (d) cases import Pipeline/applySpecHardChecks/bootstrap from production modules and contain no local glob-matching or list-union logic', () => {
  const selfPath = new URL(import.meta.url).pathname;
  const source = fs.readFileSync(selfPath, 'utf8');

  assert.ok(
    /import\s*\{[^}]*\bPipeline\b[^}]*\bapplySpecHardChecks\b[^}]*\}\s*from\s*['"]\.\.\/src\/orchestrator\/core\/pipeline\.js['"]/.test(source),
    'expected Pipeline and applySpecHardChecks to be imported from ../src/orchestrator/core/pipeline.js'
  );
  assert.ok(
    /import\s*\{\s*bootstrap\s*\}\s*from\s*['"]\.\.\/src\/orchestrator\/core\/bootstrap\.js['"]/.test(source),
    'expected bootstrap to be imported from ../src/orchestrator/core/bootstrap.js'
  );

  const sectionMarker = '// ── (d) choke-point integration — real production read paths';
  const sectionStart = source.indexOf(sectionMarker);
  assert.ok(sectionStart !== -1, 'area (d) section marker must be present in this file');
  const sectionEnd = source.indexOf("test('TC-d5:", sectionStart);
  assert.ok(sectionEnd !== -1, 'TC-d5 marker must be present to bound the self-scan');
  const section = source.slice(sectionStart, sectionEnd);

  // No local re-implementation of glob matching (RegExp construction from a
  // pattern) or list-union logic (Set-based dedup) inside the (d) section —
  // the section must rely exclusively on the imported production functions.
  assert.ok(!/new RegExp/.test(section),
    'the (d) section must not construct a RegExp — glob matching must come only from the imported production coupled-files.js');
  assert.ok(!/new Set\(/.test(section),
    'the (d) section must not build a Set for dedup — list-union must come only from the imported production expandCoupledTargets');
});

test('TC-d6: every (d) case removes its mkdtemp root and restores config.scope.coupledFiles in a finally block', () => {
  const selfPath = new URL(import.meta.url).pathname;
  const source = fs.readFileSync(selfPath, 'utf8');

  const sectionMarker = '// ── (d) choke-point integration — real production read paths';
  const sectionStart = source.indexOf(sectionMarker);
  assert.ok(sectionStart !== -1, 'area (d) section marker must be present in this file');
  const sectionEnd = source.indexOf("test('TC-d6:", sectionStart);
  assert.ok(sectionEnd !== -1, 'TC-d6 marker must be present to bound the self-scan');
  const section = source.slice(sectionStart, sectionEnd);

  const rootCreateCount = (section.match(/= makeTmpRoot\('cc-orch-coupled-d\d-'\);/g) || []).length;
  const cleanupCount = (section.match(/cleanup\(root\)/g) || []).length;
  const resetCount = (section.match(/resetConfigScope\(\);/g) || []).length;
  const finallyCount = (section.match(/\}\s*finally\s*\{/g) || []).length;

  assert.strictEqual(rootCreateCount, 4, 'expected 4 mkdtemp roots created, one per TC-d1..TC-d4');
  assert.strictEqual(cleanupCount, rootCreateCount, 'every mkdtemp root created must be removed via cleanup(root)');
  assert.strictEqual(finallyCount, rootCreateCount, 'every (d) case must remove its root inside a finally block');
  // Each of the 4 cases calls resetConfigScope() twice (once before writing
  // the fixture, once in finally) → 8 total.
  assert.strictEqual(resetCount, rootCreateCount * 2,
    `expected config.scope.coupledFiles reset both before and in finally for each of the ${rootCreateCount} cases`);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
