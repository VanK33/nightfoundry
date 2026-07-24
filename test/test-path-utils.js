/**
 * test-path-utils.js — Unit tests for path-utils.js.
 *
 * No Claude auth, no SDK. Pure path resolution assertions.
 * Run: node test/test-path-utils.js
 */
import assert from 'assert';
import { normalizeTargetFile } from '../src/orchestrator/core/path-utils.js';

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

// ---------- TC1: relative path resolves to projectRoot + file ----------

test('TC1: relative path resolves to projectRoot + file', () => {
  const result = normalizeTargetFile('/project', 'src/foo.js');
  assert.strictEqual(result, '/project/src/foo.js');
});

// ---------- TC2: absolute path passes through unchanged ----------

test('TC2: absolute path passes through unchanged', () => {
  const result = normalizeTargetFile('/project', '/absolute/bar.js');
  assert.strictEqual(result, '/absolute/bar.js');
});

// ---------- TC3: ../ segments resolve correctly ----------

test('TC3: ../ segments resolve correctly', () => {
  const result = normalizeTargetFile('/project/sub', '../sibling/baz.js');
  assert.strictEqual(result, '/project/sibling/baz.js');
});

// ---------- TC4: ./ prefix resolves correctly ----------

test('TC4: ./ prefix resolves correctly', () => {
  const result = normalizeTargetFile('/project', './rel/qux.js');
  assert.strictEqual(result, '/project/rel/qux.js');
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
