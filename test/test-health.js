/**
 * test-health.js — Unit tests for src/cli/commands/health.js
 *
 * Run: node test/test-health.js
 */
import assert from 'assert';
import { health } from '../src/cli/commands/health.js';

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

// ---------- stdout capture helper ----------

function captureStdout(fn) {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log.bind(console);

  process.stdout.write = (chunk, ...args) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => {
    chunks.push(args.join(' ') + '\n');
  };

  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }

  return chunks.join('');
}

// ---------- Tests ----------

// TC1: health() output is valid JSON
test('TC1: health() output is valid JSON', () => {
  const out = captureStdout(() => health());
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    throw new Error(`Expected valid JSON, got parse error: ${e.message}\nOutput: ${out}`);
  }
  assert.ok(parsed !== null && typeof parsed === 'object', 'Expected parsed JSON to be an object');
});

// TC2: Parsed JSON has keys status, version, pid, nodeVersion, uptimeMs
test('TC2: Parsed JSON has keys status, version, pid, nodeVersion, uptimeMs', () => {
  const out = captureStdout(() => health());
  const parsed = JSON.parse(out);
  const required = ['status', 'version', 'pid', 'nodeVersion', 'uptimeMs'];
  for (const field of required) {
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, field), `Expected field "${field}" in JSON output`);
  }
});

// TC3: status field equals 'ok'
test("TC3: status field equals 'ok'", () => {
  const out = captureStdout(() => health());
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.status, 'ok', `Expected status to be 'ok', got '${parsed.status}'`);
});

// TC4: pid equals process.pid
test('TC4: pid equals process.pid', () => {
  const out = captureStdout(() => health());
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.pid, process.pid, `Expected pid to be ${process.pid}, got ${parsed.pid}`);
});

// TC5: nodeVersion equals process.version
test('TC5: nodeVersion equals process.version', () => {
  const out = captureStdout(() => health());
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.nodeVersion, process.version, `Expected nodeVersion to be '${process.version}', got '${parsed.nodeVersion}'`);
});

// TC6: uptimeMs is a non-negative number
test('TC6: uptimeMs is a non-negative number', () => {
  const out = captureStdout(() => health());
  const parsed = JSON.parse(out);
  assert.ok(typeof parsed.uptimeMs === 'number', `Expected uptimeMs to be a number, got ${typeof parsed.uptimeMs}`);
  assert.ok(parsed.uptimeMs >= 0, `Expected uptimeMs to be >= 0, got ${parsed.uptimeMs}`);
});

// TC7: version is a non-empty string
test('TC7: version is a non-empty string', () => {
  const out = captureStdout(() => health());
  const parsed = JSON.parse(out);
  assert.ok(typeof parsed.version === 'string', `Expected version to be a string, got ${typeof parsed.version}`);
  assert.ok(parsed.version.length > 0, `Expected version to be a non-empty string, got '${parsed.version}'`);
});

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
