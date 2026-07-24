/**
 * test-executor-contract.js — Round-trip tests for executor structured contract.
 *
 * Run: node test/test-executor-contract.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import {
  executorSchema,
  validateStructured,
} from '../src/orchestrator/agents/_schemas.js';

let passCount = 0;
let failCount = 0;

// Phase I items 4+5 dogfood 5 finding: this file previously used a
// sync `test` helper with async test bodies. Async assertion failures
// became unhandled promise rejections and the helper reported PASS
// regardless. Converting to async-aware.
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

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'executor-contract-')); }
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

const fixtureCompleted = {
  structured_output: {
    status: 'COMPLETED',
    summary: 'Added --version flag and wired it into the CLI parser',
    affectedFiles: [
      { path: 'src/cli/commands/run.js', reason: 'added flag handling' },
      { path: 'src/cli/index.js', reason: 'registered flag' },
    ],
    testsSummary: 'Added test/test-cli-version.js — 3 new cases, all pass',
  },
};

const fixtureBlocked = {
  structured_output: {
    status: 'BLOCKED',
    summary: 'Could not proceed — target file references a module that does not exist',
    affectedFiles: [],
    testsSummary: '',
    blockReason: 'src/cli/flag-parser.js does not exist; task assumed it did',
  },
};

const fixtureNoStructured = { result: 'wrote the file, trust me bro' };

const fixtureMalformed = {
  structured_output: {
    status: 'PARTIAL', // not in enum
    summary: 'x',
    affectedFiles: [],
  },
};

// ── Schema validation ───────────────────────────────────────────────────

await test('validateStructured: COMPLETED fixture is valid', () => {
  const r = validateStructured(fixtureCompleted.structured_output, executorSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

await test('validateStructured: BLOCKED fixture is valid', () => {
  const r = validateStructured(fixtureBlocked.structured_output, executorSchema);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

await test('validateStructured: invalid status enum rejected', () => {
  const r = validateStructured(fixtureMalformed.structured_output, executorSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /status.*PARTIAL/.test(e)));
});

await test('validateStructured: affectedFiles item missing required field', () => {
  const bad = {
    status: 'COMPLETED',
    summary: 'x',
    affectedFiles: [{ path: 'foo.js' }], // missing reason
  };
  const r = validateStructured(bad, executorSchema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /affectedFiles\[0\]\.reason.*missing/.test(e)));
});

// ── executor.extractProgress integration ───────────────────────────────

await test('executor.extractProgress: COMPLETED fixture surfaces affectedFiles', async () => {
  const { extractProgress } = await import('../src/orchestrator/agents/executor.js');
  const dir = tempDir();
  try {
    const out = extractProgress(fixtureCompleted, 'task-abc', dir);
    assert.equal(out.status, 'COMPLETED');
    assert.deepEqual(
      out.affectedFiles.map((f) => f.path),
      ['src/cli/commands/run.js', 'src/cli/index.js']
    );
    const sidecar = path.join(dir, 'progress', 'task-task-abc.json');
    assert.ok(fs.existsSync(sidecar));
  } finally { cleanup(dir); }
});

await test('executor.extractProgress: BLOCKED fixture → status BLOCKED', async () => {
  const { extractProgress } = await import('../src/orchestrator/agents/executor.js');
  const dir = tempDir();
  try {
    const out = extractProgress(fixtureBlocked, 'task-xyz', dir);
    assert.equal(out.status, 'BLOCKED');
    assert.equal(out.structured.blockReason, 'src/cli/flag-parser.js does not exist; task assumed it did');
  } finally { cleanup(dir); }
});

await test('executor.extractProgress: no structured_output → default BLOCKED', async () => {
  const { extractProgress } = await import('../src/orchestrator/agents/executor.js');
  const dir = tempDir();
  try {
    const out = extractProgress(fixtureNoStructured, 'task-noout', dir);
    assert.equal(out.status, 'BLOCKED', 'safe default');
    // Verify the stub sidecar was written with the expected shape.
    const sidecar = path.join(dir, 'progress', 'task-task-noout.json');
    assert.ok(fs.existsSync(sidecar), 'sidecar should be written even on missing structured_output');
    const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    assert.equal(parsed.status, 'BLOCKED');
    assert.equal(parsed.blockReason, 'No structured_output from SDK');
  } finally {
    cleanup(dir);
  }
});

await test('executor.extractProgress: no structured_output does NOT log [DEPRECATED]', async () => {
  // Positive regression test: dogfood 5 removed the [DEPRECATED] warning
  // from extractProgress when structured_output is missing. This asserts
  // the warning is genuinely gone — Rule 3 sentinel to prevent the
  // deprecation block from being accidentally reintroduced.
  const { extractProgress } = await import('../src/orchestrator/agents/executor.js');
  const dir = tempDir();
  const logs = [];
  const warn = console.warn;
  console.warn = (...args) => logs.push(args.join(' '));
  try {
    extractProgress(fixtureNoStructured, 'task-noout', dir);
    assert.ok(!logs.some((l) => /DEPRECATED/.test(l)),
      '[DEPRECATED] warning should not appear — deprecation path was removed');
  } finally {
    console.warn = warn;
    cleanup(dir);
  }
});

// ── extractProgress opts.warn forwarding ───────────────────────────────

await test('executor.extractProgress: opts.warn spy is called when _capturedStructuredOutput fallback fires', async () => {
  const { extractProgress } = await import('../src/orchestrator/agents/executor.js');
  const dir = tempDir();
  const warnCalls = [];
  const warnSpy = (msg) => warnCalls.push(msg);
  // Fixture: no structured_output but _capturedStructuredOutput present (Bug B fallback)
  const fixture = {
    _capturedStructuredOutput: {
      status: 'COMPLETED',
      summary: 'fallback path',
      affectedFiles: [],
      testsSummary: '',
    },
  };
  try {
    extractProgress(fixture, 'task-warnspy', dir, { warn: warnSpy });
    assert.ok(warnCalls.length >= 1, 'warn spy should have been called at least once');
    assert.ok(typeof warnCalls[0] === 'string', 'warn spy argument should be a string');
  } finally { cleanup(dir); }
});

// ── snapshots.readAffectedFiles integration (JSON sidecar path) ────────

await test('snapshots.readAffectedFiles: reads JSON sidecar when present', async () => {
  const { readAffectedFiles } = await import('../src/orchestrator/core/snapshots.js');
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, 'progress'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'progress', 'task-xyz.json'),
      JSON.stringify({
        status: 'COMPLETED',
        summary: 's',
        affectedFiles: [
          { path: 'a.js', reason: 'x' },
          { path: 'b.js', reason: 'y' },
        ],
      })
    );
    const files = readAffectedFiles(dir, 'xyz');
    assert.deepEqual(files, ['a.js', 'b.js']);
  } finally { cleanup(dir); }
});

await test('snapshots.readAffectedFiles: missing sidecar returns empty array', async () => {
  const { readAffectedFiles } = await import('../src/orchestrator/core/snapshots.js');
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, 'progress'), { recursive: true });
    const files = readAffectedFiles(dir, 'nothing');
    assert.deepEqual(files, []);
  } finally { cleanup(dir); }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
