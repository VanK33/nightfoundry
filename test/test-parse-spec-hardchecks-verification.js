/**
 * test-parse-spec-hardchecks-verification.js — Tests that parseSpecHardChecks
 * reads the structured `verification.command` (kind=command) off each
 * acceptance_criteria item, instead of the old free-string `evidence`.
 *
 * Contract:
 *   - kind=command   → emits { name: description, command: verification.command }
 *   - kind=manual    → no hardCheck (reviewer/human)
 *   - kind=file-check → no hardCheck (P-GATE concern, out of this spec)
 *
 * No Claude auth, no SDK. Writes a temp spec.json and reads it back.
 *
 * Run: node test/test-parse-spec-hardchecks-verification.js
 */
import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSpecHardChecks } from '../src/orchestrator/agents/planner.js';

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

function withSpec(spec, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardcheck-verif-'));
  try {
    const p = path.join(dir, 'spec.json');
    fs.writeFileSync(p, JSON.stringify(spec, null, 2));
    return fn(p);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── TC1: command kind → one hardCheck reading verification.command ──────────

await test('TC1: command kind yields a hardCheck with verification.command', () => {
  const spec = {
    goal: 'g',
    target_files: ['test/foo.js'],
    acceptance_criteria: [
      { description: 'foo works', verification: { kind: 'command', command: 'node test/foo.js', targetFile: 'test/foo.js' } },
    ],
  };
  withSpec(spec, (p) => {
    const checks = parseSpecHardChecks(p);
    assert.equal(checks.length, 1, `expected 1 hardCheck, got ${checks.length}`);
    assert.equal(checks[0].name, 'foo works');
    assert.equal(checks[0].command, 'node test/foo.js');
  });
});

// ── TC2: manual kind → no hardCheck ─────────────────────────────────────────

await test('TC2: manual kind yields no hardCheck', () => {
  const spec = {
    goal: 'g',
    target_files: ['src/foo.js'],
    acceptance_criteria: [
      { description: 'UI looks right', verification: { kind: 'manual', manualSteps: 'Open and confirm.' } },
    ],
  };
  withSpec(spec, (p) => {
    const checks = parseSpecHardChecks(p);
    assert.equal(checks.length, 0, `expected 0 hardChecks, got ${checks.length}`);
  });
});

// ── TC3: file-check kind → no hardCheck ─────────────────────────────────────

await test('TC3: file-check kind yields no hardCheck', () => {
  const spec = {
    goal: 'g',
    target_files: ['src/foo.js'],
    acceptance_criteria: [
      { description: 'file present', verification: { kind: 'file-check', targetFile: 'src/foo.js' } },
    ],
  };
  withSpec(spec, (p) => {
    const checks = parseSpecHardChecks(p);
    assert.equal(checks.length, 0, `expected 0 hardChecks, got ${checks.length}`);
  });
});

// ── TC4: mixed kinds → only command kinds produce hardChecks ────────────────

await test('TC4: mixed kinds → only command kinds become hardChecks', () => {
  const spec = {
    goal: 'g',
    target_files: ['test/a.js', 'test/b.js', 'src/c.js'],
    acceptance_criteria: [
      { description: 'a works', verification: { kind: 'command', command: 'node test/a.js', targetFile: 'test/a.js' } },
      { description: 'b looks right', verification: { kind: 'manual', manualSteps: 'Eyeball it.' } },
      { description: 'c exists', verification: { kind: 'file-check', targetFile: 'src/c.js' } },
      { description: 'b works', verification: { kind: 'command', command: 'node test/b.js', targetFile: 'test/b.js' } },
    ],
  };
  withSpec(spec, (p) => {
    const checks = parseSpecHardChecks(p);
    assert.equal(checks.length, 2, `expected 2 hardChecks, got ${checks.length}`);
    const names = checks.map((c) => c.name).sort();
    assert.deepStrictEqual(names, ['a works', 'b works']);
    const commands = checks.map((c) => c.command).sort();
    assert.deepStrictEqual(commands, ['node test/a.js', 'node test/b.js']);
  });
});

// ── TC5: no acceptance_criteria → empty ─────────────────────────────────────

await test('TC5: missing acceptance_criteria → empty hardChecks', () => {
  const spec = { goal: 'g', target_files: ['src/foo.js'] };
  withSpec(spec, (p) => {
    const checks = parseSpecHardChecks(p);
    assert.equal(checks.length, 0, `expected 0 hardChecks, got ${checks.length}`);
  });
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
