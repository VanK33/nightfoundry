/**
 * test-blast-radius.js — Unit tests for the symbol-consumer enumerator
 * and changed_symbols reader.
 * Run: node test/test-blast-radius.js
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { enumerateSymbolConsumers, readChangedSymbols } from '../src/orchestrator/gates/blast-radius.js';

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

// -- helpers for building a real temporary project directory ---------------

const tmpDirs = [];

/**
 * Create a fresh temporary project directory with src/, test/, and scripts/
 * subdirectories pre-created. Tracked for cleanup at the end of the run.
 * @returns {string} absolute path to the temp project root
 */
function makeTempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blast-radius-test-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  tmpDirs.push(root);
  return root;
}

/**
 * Write a fixture file at `relPath` (relative to `root`) with `content`.
 * Creates any necessary parent directories.
 * @param {string} root
 * @param {string} relPath
 * @param {string} content
 */
function writeFixture(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function cleanupTempProjects() {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; ignore errors
    }
  }
}

// -- enumerateSymbolConsumers -----------------------------------------------

test('TC1: enumerateSymbolConsumers([], projectRoot) returns an empty map', () => {
  const root = makeTempProject();
  writeFixture(root, 'src/a.js', 'function foo() {}');
  writeFixture(root, 'test/b.js', 'const foo = 1;');

  const result = enumerateSymbolConsumers([], root);
  assert.deepStrictEqual(result, {});
});

test("TC2: 'foo' does not match substring inside 'foobar'/'barfoo' (no consumer)", () => {
  const root = makeTempProject();
  writeFixture(root, 'src/foobar.js', 'function foobar() { return 1; }');
  writeFixture(root, 'scripts/barfoo.js', 'const barfoo = 42;');

  const result = enumerateSymbolConsumers(['foo'], root);
  assert.deepStrictEqual(result, {}, `expected no consumers, got ${JSON.stringify(result)}`);
});

test("TC2: 'foo' matches a whole-identifier occurrence (consumer reported)", () => {
  const root = makeTempProject();
  writeFixture(root, 'src/foobar.js', 'function foobar() { return 1; }');
  writeFixture(root, 'test/uses-foo.js', 'console.log(foo);');

  const result = enumerateSymbolConsumers(['foo'], root);
  const expectedPath = path.join('test', 'uses-foo.js');
  assert.deepStrictEqual(
    Object.keys(result),
    [expectedPath],
    `expected exactly one consumer file, got ${JSON.stringify(result)}`
  );
  assert.deepStrictEqual(result[expectedPath], ['foo']);
});

test('TC2: a file matching multiple symbols lists each matched symbol once (dedup)', () => {
  const root = makeTempProject();
  writeFixture(
    root,
    'src/multi.js',
    'function foo() { return bar(foo, bar); }\nfunction bar() { return foo + bar; }'
  );

  const result = enumerateSymbolConsumers(['foo', 'bar', 'baz'], root);
  const expectedPath = path.join('src', 'multi.js');
  assert.deepStrictEqual(Object.keys(result), [expectedPath]);
  assert.strictEqual(result[expectedPath].length, 2);
  assert.deepStrictEqual(new Set(result[expectedPath]), new Set(['foo', 'bar']));
});

// -- readChangedSymbols ------------------------------------------------------

test('TC3: readChangedSymbols(validSpecFile) returns the changed_symbols array', () => {
  const root = makeTempProject();
  const specPath = path.join(root, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify({ changed_symbols: ['foo', 'bar'] }), 'utf8');

  const result = readChangedSymbols(specPath);
  assert.deepStrictEqual(result, ['foo', 'bar']);
});

test('TC3: readChangedSymbols(nonExistentPath) returns [] without throwing', () => {
  const root = makeTempProject();
  const missingPath = path.join(root, 'does-not-exist.json');

  assert.doesNotThrow(() => {
    const result = readChangedSymbols(missingPath);
    assert.deepStrictEqual(result, []);
  });
});

test('TC3: readChangedSymbols(malformedJsonFile) returns [] without throwing', () => {
  const root = makeTempProject();
  const specPath = path.join(root, 'malformed.json');
  fs.writeFileSync(specPath, '{not valid json', 'utf8');

  assert.doesNotThrow(() => {
    const result = readChangedSymbols(specPath);
    assert.deepStrictEqual(result, []);
  });
});

test('TC3: readChangedSymbols(missingOrNonArrayChangedSymbols) returns [] without throwing', () => {
  const root = makeTempProject();

  const missingFieldPath = path.join(root, 'no-field.json');
  fs.writeFileSync(missingFieldPath, JSON.stringify({ other: 'value' }), 'utf8');
  assert.doesNotThrow(() => {
    const result = readChangedSymbols(missingFieldPath);
    assert.deepStrictEqual(result, []);
  });

  const nonArrayPath = path.join(root, 'non-array.json');
  fs.writeFileSync(nonArrayPath, JSON.stringify({ changed_symbols: 'not-an-array' }), 'utf8');
  assert.doesNotThrow(() => {
    const result = readChangedSymbols(nonArrayPath);
    assert.deepStrictEqual(result, []);
  });
});

cleanupTempProjects();

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
