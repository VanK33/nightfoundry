#!/usr/bin/env node

/**
 * test-assumption-data.js — Unit tests for src/orchestrator/core/assumption-data.js
 *
 * Imports normalizeUncertains, persistUncertainsToState, extractSpecSection,
 * getSpecTargetFiles, and applySpecEdit DIRECTLY from the module (never via
 * Pipeline), and asserts stateless behavior against temp files/dirs so no
 * module-level state leaks between calls.
 *
 * Run: node test/test-assumption-data.js
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  normalizeUncertains,
  persistUncertainsToState,
  extractSpecSection,
  getSpecTargetFiles,
  applySpecEdit,
} from '../src/orchestrator/core/assumption-data.js';

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

// ── Helpers ───────────────────────────────────────────────────────────────

function writeTempSpec(content) {
  const tmpDir = os.tmpdir();
  const specPath = path.join(tmpDir, `test-assumption-data-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(specPath, content, 'utf8');
  return {
    specPath,
    cleanup: () => { try { fs.unlinkSync(specPath); } catch { /* ignore */ } },
  };
}

function makeTempHarnessDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-assumption-data-harness-'));
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

await test('TC1: normalizeUncertains bare-string assumption -> {text: "foo", specSection: ""}', () => {
  const result = normalizeUncertains([{ assumption: 'foo' }]);
  assert.strictEqual(result.length, 1, 'result should have 1 element');
  assert.deepStrictEqual(result[0], { text: 'foo', specSection: '' });
});

await test('TC2: normalizeUncertains(undefined) returns []', () => {
  const result = normalizeUncertains(undefined);
  assert.ok(Array.isArray(result), 'result should be an array');
  assert.deepStrictEqual(result, []);
});

await test('TC3: persistUncertainsToState against a harnessDir with no state.json neither throws nor creates state.json', () => {
  const { dir, cleanup } = makeTempHarnessDir();
  try {
    const stateJsonPath = path.join(dir, 'state.json');
    assert.strictEqual(fs.existsSync(stateJsonPath), false, 'state.json should not exist before the call');
    assert.doesNotThrow(() => {
      persistUncertainsToState(dir, [{ text: 'foo', specSection: '' }]);
    }, 'should not throw when state.json is absent');
    assert.strictEqual(fs.existsSync(stateJsonPath), false, 'state.json should still not exist after the call (no-op)');
  } finally {
    cleanup();
  }
});

await test('TC4: persistUncertainsToState with an existing state.json replaces state.uncertainAssumptions on disk', () => {
  const { dir, cleanup } = makeTempHarnessDir();
  try {
    const stateJsonPath = path.join(dir, 'state.json');
    const initialState = { foo: 'bar', uncertainAssumptions: [{ text: 'old', specSection: 'x' }] };
    fs.writeFileSync(stateJsonPath, JSON.stringify(initialState, null, 2), 'utf8');

    const newAssumptions = [{ text: 'new-one', specSection: '## Heading' }];
    persistUncertainsToState(dir, newAssumptions);

    const onDisk = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
    assert.deepStrictEqual(onDisk.uncertainAssumptions, newAssumptions);
    assert.strictEqual(onDisk.foo, 'bar', 'other state fields should be preserved (read-modify-write)');
  } finally {
    cleanup();
  }
});

await test('TC5: extractSpecSection exact "## Heading" match returns the trimmed section', () => {
  const { specPath, cleanup } = writeTempSpec(
    '## Goal\nThis is the goal content.\n\n## Other\nOther content.\n'
  );
  try {
    const logCalls = [];
    const onLog = (msg) => logCalls.push(msg);
    const result = extractSpecSection(specPath, 'Goal', onLog);
    assert.ok(result !== null, 'result should not be null');
    assert.strictEqual(result, result.trim(), 'result should be trimmed');
    assert.ok(result.includes('## Goal'), 'result should include the heading');
    assert.ok(result.includes('This is the goal content.'), 'result should include the section body');
    assert.ok(!result.includes('## Other'), 'result should not spill into the next section');
  } finally {
    cleanup();
  }
});

await test('TC6: extractSpecSection with unmatched sectionName returns null and onLog captured a "[extractSpecSection] Warning:" message', () => {
  const { specPath, cleanup } = writeTempSpec(
    '## Introduction\nSome intro text.\n\n## Background\nBackground info.\n'
  );
  try {
    const logCalls = [];
    const onLog = (msg) => logCalls.push(msg);
    const result = extractSpecSection(specPath, 'NonExistentSection', onLog);
    assert.strictEqual(result, null, 'result should be null on miss');
    const warningMsg = logCalls.find((msg) => msg.includes('[extractSpecSection] Warning:'));
    assert.ok(warningMsg !== undefined, 'onLog should have been called with a "[extractSpecSection] Warning:" message');
  } finally {
    cleanup();
  }
});

await test('TC7: applySpecEdit with a non-existent spec path returns false and onLog captured "spec file not found"', () => {
  const fakeSpecPath = path.join(os.tmpdir(), 'does-not-exist-ever-assumption-data-applyedit-12345.md');
  const logCalls = [];
  const onLog = (msg) => logCalls.push(msg);
  const result = applySpecEdit(fakeSpecPath, 'old', 'new', {}, onLog);
  assert.strictEqual(result, false, 'result should be false');
  const warningMsg = logCalls.find((msg) => msg.includes('spec file not found'));
  assert.ok(warningMsg !== undefined, 'onLog should have been called with the spec-file-not-found warning');
});

await test('TC8: applySpecEdit with oldText not present in the file returns false and onLog captured "old string not found"', () => {
  const { specPath, cleanup } = writeTempSpec('Some content that does not contain the target string.\n');
  try {
    const logCalls = [];
    const onLog = (msg) => logCalls.push(msg);
    const result = applySpecEdit(specPath, 'this text is not in the file', 'replacement', {}, onLog);
    assert.strictEqual(result, false, 'result should be false');
    const warningMsg = logCalls.find((msg) => msg.includes('old string not found'));
    assert.ok(warningMsg !== undefined, 'onLog should have been called with the old-string-not-found warning');
    const contentAfter = fs.readFileSync(specPath, 'utf8');
    assert.strictEqual(contentAfter, 'Some content that does not contain the target string.\n', 'file should be unchanged');
  } finally {
    cleanup();
  }
});

await test('TC9: applySpecEdit successful replacement returns true, updates the file, and onLog captured "[specEdit]"', () => {
  const { specPath, cleanup } = writeTempSpec('Header\nold text here\nFooter\n');
  try {
    const logCalls = [];
    const onLog = (msg) => logCalls.push(msg);
    const result = applySpecEdit(
      specPath,
      'old text here',
      'new text here',
      { subsystem: 'test-subsystem', section: 'Header', summary: 'replaced text' },
      onLog
    );
    assert.strictEqual(result, true, 'result should be true');
    const contentAfter = fs.readFileSync(specPath, 'utf8');
    assert.strictEqual(contentAfter, 'Header\nnew text here\nFooter\n');
    const msg = logCalls.find((m) => m.includes('[specEdit]'));
    assert.ok(msg !== undefined, 'onLog should have received a "[specEdit]" message');
  } finally {
    cleanup();
  }
});

await test('TC10: getSpecTargetFiles second call with the same cache holder returns identical array without re-reading state.json', () => {
  const { dir, cleanup } = makeTempHarnessDir();
  try {
    // Memoization requires a spec-anchored read (truthy prdPath) — a prd-less
    // read is deliberately NOT cached (engine hole 12b), so this fixture
    // anchors state.json to a real spec file.
    const specPath = path.join(dir, 'spec.md');
    fs.writeFileSync(specPath, '## Declared target files\n- `src/x.js`\n', 'utf8');
    const stateJsonPath = path.join(dir, 'state.json');
    fs.writeFileSync(stateJsonPath, JSON.stringify({ projectMeta: { prdPath: specPath } }, null, 2), 'utf8');

    const cache = {};
    const first = getSpecTargetFiles(dir, process.cwd(), cache);

    // Corrupt state.json on disk — if the second call re-read state this
    // would throw/behave differently, but memoization must short-circuit
    // before any file access happens.
    fs.writeFileSync(stateJsonPath, 'not valid json at all {{{', 'utf8');

    let second;
    assert.doesNotThrow(() => {
      second = getSpecTargetFiles(dir, process.cwd(), cache);
    }, 'second call must not re-read the (now-corrupt) state.json');

    assert.strictEqual(second, first, 'second call should return the exact same array reference (memoized)');
    assert.deepStrictEqual(second, first);
  } finally {
    cleanup();
  }
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
