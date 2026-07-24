import assert from 'assert';
import { normalizeTargetFile } from '../src/orchestrator/core/path-utils.js';
import { Scheduler } from '../src/orchestrator/core/scheduler.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// TC1: dot-slash vs bare relative normalize to same path
test('TC1: dot-slash vs bare relative conflict', () => {
  const a = normalizeTargetFile('/proj', './src/a.js');
  const b = normalizeTargetFile('/proj', 'src/a.js');
  assert.strictEqual(a, '/proj/src/a.js');
  assert.strictEqual(b, '/proj/src/a.js');
  assert.strictEqual(a, b);
});

// TC2: relative vs absolute normalize to same path
test('TC2: relative vs absolute conflict', () => {
  const a = normalizeTargetFile('/proj', 'src/b.js');
  const b = normalizeTargetFile('/proj', '/proj/src/b.js');
  assert.strictEqual(a, '/proj/src/b.js');
  assert.strictEqual(b, '/proj/src/b.js');
});

// TC3: distinct files do not false-positive collide
test('TC3: no false positive for distinct files', () => {
  const x = normalizeTargetFile('/proj', 'src/x.js');
  const y = normalizeTargetFile('/proj', 'src/y.js');
  assert.notStrictEqual(x, y);
});

// TC4: three forms of same path all normalize identically
test('TC4: normalizeTargetFile consistency across forms', () => {
  const a = normalizeTargetFile('/proj', 'src/c.js');
  const b = normalizeTargetFile('/proj', './src/c.js');
  const c = normalizeTargetFile('/proj', '/proj/src/c.js');
  assert.strictEqual(a, '/proj/src/c.js');
  assert.strictEqual(b, '/proj/src/c.js');
  assert.strictEqual(c, '/proj/src/c.js');
});

// TC5: Set.has round-trip succeeds across path forms
test('TC5: runningFiles add/has round-trip', () => {
  const set = new Set();
  set.add(normalizeTargetFile('/proj', 'src/d.js'));
  assert.strictEqual(set.has(normalizeTargetFile('/proj', './src/d.js')), true);
});

// TC6: Set.delete removes entry added with different path form
test('TC6: runningFiles delete symmetry', () => {
  const set = new Set();
  set.add(normalizeTargetFile('/proj', './src/e.js'));
  set.delete(normalizeTargetFile('/proj', 'src/e.js'));
  assert.strictEqual(set.size, 0);
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
