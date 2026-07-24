/**
 * test-whole-suite-guard.js — Independent behavior tests for the whole-suite
 * Bash guard feature.
 *
 * Covers four specs (authored from behavior spec, not from implementation):
 *   A — bashCommandRunsWholeSuite(command, cfg) pure predicate
 *   B — session-level denyWholeSuiteBash canUseTool guard
 *   C — reviewer prompt carries the whole-suite rule + denyWholeSuiteBash spawn flag
 *   D — verifier warn message carries the spec-injection status marker
 *
 * Run: node test/test-whole-suite-guard.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

import { bashCommandRunsWholeSuite } from '../src/orchestrator/core/whole-suite-bash.js';
import { SessionManager } from '../src/orchestrator/infra/session-manager.js';
import { Reviewer } from '../src/orchestrator/agents/reviewer.js';

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

// ════════════════════════════════════════════════════════════════════════════
// Spec A — bashCommandRunsWholeSuite(command, cfg)
// ════════════════════════════════════════════════════════════════════════════

const npmCfg = { execution: { testCommand: 'npm test', testAllCommand: 'npm run test:all' } };

// ── Must-true cases ──────────────────────────────────────────────────────────

await test('A: bare `npm test` → true', () => {
  assert.strictEqual(bashCommandRunsWholeSuite('npm test', npmCfg), true);
});

await test('A: bare `npm run test:all` → true', () => {
  assert.strictEqual(bashCommandRunsWholeSuite('npm run test:all', npmCfg), true);
});

await test('A: `cd /x && npm run test:all` → true (chained segment matches)', () => {
  assert.strictEqual(bashCommandRunsWholeSuite('cd /x && npm run test:all', npmCfg), true);
});

await test('A: `npm test 2>&1` → true (stderr redirection stripped)', () => {
  assert.strictEqual(bashCommandRunsWholeSuite('npm test 2>&1', npmCfg), true);
});

await test('A: `npm run test:all > /tmp/out.txt` → true (stdout redirection stripped)', () => {
  assert.strictEqual(bashCommandRunsWholeSuite('npm run test:all > /tmp/out.txt', npmCfg), true);
});

await test('A: `echo hi; npm test` → true (semicolon-chained segment matches)', () => {
  assert.strictEqual(bashCommandRunsWholeSuite('echo hi; npm test', npmCfg), true);
});

await test('A: `npm test &` → true (trailing background operator stripped)', () => {
  assert.strictEqual(bashCommandRunsWholeSuite('npm test &', npmCfg), true);
});

// ── Must-false cases ─────────────────────────────────────────────────────────

await test('A: `grep "npm test" file.js` → false (command is grep, not the suite)', () => {
  assert.strictEqual(bashCommandRunsWholeSuite('grep "npm test" file.js', npmCfg), false);
});

await test("A: `echo 'npm run test:all'` → false (segment is echo with an argument)", () => {
  assert.strictEqual(bashCommandRunsWholeSuite("echo 'npm run test:all'", npmCfg), false);
});

await test('A: `npm test -- --grep x` → false (flag-decorated, not bare match)', () => {
  assert.strictEqual(bashCommandRunsWholeSuite('npm test -- --grep x', npmCfg), false);
});

await test('A: `node test/test-foo.js` → false (single-file run)', () => {
  assert.strictEqual(bashCommandRunsWholeSuite('node test/test-foo.js', npmCfg), false);
});

await test('A: empty string → false', () => {
  assert.strictEqual(bashCommandRunsWholeSuite('', npmCfg), false);
});

await test('A: non-string command → false', () => {
  assert.strictEqual(bashCommandRunsWholeSuite(null, npmCfg), false);
  assert.strictEqual(bashCommandRunsWholeSuite(undefined, npmCfg), false);
  assert.strictEqual(bashCommandRunsWholeSuite(42, npmCfg), false);
  assert.strictEqual(bashCommandRunsWholeSuite({ command: 'npm test' }, npmCfg), false);
});

await test('A: cfg without execution → false (no commands to match)', () => {
  assert.strictEqual(bashCommandRunsWholeSuite('npm test', {}), false);
  assert.strictEqual(bashCommandRunsWholeSuite('npm test', null), false);
});

await test('A: cfg with empty testCommand and testAllCommand → always false', () => {
  const emptyCfg = { execution: { testCommand: '', testAllCommand: '' } };
  assert.strictEqual(bashCommandRunsWholeSuite('npm test', emptyCfg), false);
  assert.strictEqual(bashCommandRunsWholeSuite('npm run test:all', emptyCfg), false);
  // An empty segment (e.g. bare `&`) must not accidentally equal an empty command.
  assert.strictEqual(bashCommandRunsWholeSuite('', emptyCfg), false);
});

// ── Config-driven (a different project's commands) ───────────────────────────

await test('A: config-driven — pytest/make project matches `cd api && pytest 2>&1`', () => {
  const pyCfg = { execution: { testCommand: 'pytest', testAllCommand: 'make test-all' } };
  assert.strictEqual(bashCommandRunsWholeSuite('cd api && pytest 2>&1', pyCfg), true);
  assert.strictEqual(bashCommandRunsWholeSuite('make test-all', pyCfg), true);
});

await test('A: config-driven — pytest project does NOT match `pytest tests/unit.py`', () => {
  const pyCfg = { execution: { testCommand: 'pytest', testAllCommand: 'make test-all' } };
  assert.strictEqual(bashCommandRunsWholeSuite('pytest tests/unit.py', pyCfg), false);
  // And npm commands must NOT match under a pytest config (not npm-hardcoded).
  assert.strictEqual(bashCommandRunsWholeSuite('npm test', pyCfg), false);
});

// ════════════════════════════════════════════════════════════════════════════
// Spec B — session-level denyWholeSuiteBash canUseTool guard
// ════════════════════════════════════════════════════════════════════════════

const sm = new SessionManager();

/** Obtain the canUseTool callback for the given spawn options. */
function canUseToolFor(options) {
  const sdkOpts = sm._buildSdkOptions(options, new Set());
  assert.ok(typeof sdkOpts.canUseTool === 'function', 'canUseTool should be a function');
  return sdkOpts.canUseTool;
}

/** Does the deny message reference the final integration gate? */
function isWholeSuiteDeny(result) {
  return result
    && result.behavior === 'deny'
    && typeof result.message === 'string'
    && /integration gate/i.test(result.message);
}

await test('B1: flag true → `npm run test:all` denied, message mentions the final integration gate', async () => {
  const canUseTool = canUseToolFor({ denyWholeSuiteBash: true });
  const result = await canUseTool('Bash', { command: 'npm run test:all' });
  assert.strictEqual(result.behavior, 'deny', 'whole-suite Bash should be denied');
  assert.ok(/integration gate/i.test(result.message),
    `deny message should mention the final integration gate, got: "${result.message}"`);
});

await test('B1: flag true → chained/redirected whole-suite variants also deny', async () => {
  const canUseTool = canUseToolFor({ denyWholeSuiteBash: true });
  for (const cmd of ['cd /x && npm run test:all', 'npm test 2>&1', 'echo hi; npm test', 'npm test &']) {
    const result = await canUseTool('Bash', { command: cmd });
    assert.strictEqual(result.behavior, 'deny', `expected deny for: ${cmd}`);
    assert.ok(isWholeSuiteDeny(result), `expected whole-suite deny message for: ${cmd}`);
  }
});

await test('B2: flag true → a non-suite Bash command is NOT hit by the whole-suite deny', async () => {
  const canUseTool = canUseToolFor({ denyWholeSuiteBash: true });
  const result = await canUseTool('Bash', { command: 'node test/test-foo.js' });
  assert.ok(!isWholeSuiteDeny(result),
    `single-file run must not trigger the whole-suite deny, got: ${JSON.stringify(result)}`);
});

await test('B3: WITHOUT the flag → `npm run test:all` is NOT denied by the whole-suite guard', async () => {
  const canUseTool = canUseToolFor({});  // flag omitted
  const result = await canUseTool('Bash', { command: 'npm run test:all' });
  assert.ok(!isWholeSuiteDeny(result),
    `sanctioned regression-verifier path must stay unaffected, got: ${JSON.stringify(result)}`);
});

await test('B3: flag explicitly false → `npm run test:all` is NOT denied by the whole-suite guard', async () => {
  const canUseTool = canUseToolFor({ denyWholeSuiteBash: false });
  const result = await canUseTool('Bash', { command: 'npm run test:all' });
  assert.ok(!isWholeSuiteDeny(result),
    `flag:false must not deny the suite, got: ${JSON.stringify(result)}`);
});

await test('B4: flag true + targetFiles → Edit outside targetFiles denies with its OWN message (not whole-suite)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-b4-'));
  try {
    const targetFile = path.join(dir, 'allowed.js');
    const outsideFile = path.join(dir, 'outside.js');
    fs.writeFileSync(targetFile, '// allowed\n');
    fs.writeFileSync(outsideFile, '// outside\n');

    const canUseTool = canUseToolFor({ denyWholeSuiteBash: true, targetFiles: [targetFile] });
    const result = await canUseTool('Edit', { file_path: outsideFile });

    assert.strictEqual(result.behavior, 'deny', 'Edit outside targetFiles should be denied');
    assert.ok(!/integration gate/i.test(result.message),
      `Edit deny must use its own targetFiles message, not the whole-suite gate message, got: "${result.message}"`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Spec C — reviewer prompt carries the whole-suite rule + spawn flag
// ════════════════════════════════════════════════════════════════════════════

const noop = () => {};

function makeReviewerHarness(cannedSdkResult) {
  const calls = [];
  const handle = { systemPromptTokens: 0, _toolCallCount: 0 };
  const sessionManager = {
    calls,
    spawn(opts) {
      calls.push(opts);
      const spawnPromise = Promise.resolve({ handle, result: cannedSdkResult });
      spawnPromise.handle = handle;
      return spawnPromise;
    },
  };
  const logger = {
    createSessionLog: () => ({ logPath: '/tmp/fake.log', close: noop }),
    attachToSession: noop,
    getSessionSummary: () => ({}),
    writeSessionSummary: noop,
  };
  const tokenTracker = { calls: [], recordSession(...a) { this.calls.push(a); } };
  return { sessionManager, logger, tokenTracker };
}

const cannedReviewPassed = {
  structured_output: { result: 'PASSED', findings: [], notes: 'ok' },
};

await test('C1: reviewer prompt forbids running the whole suite and points at the final integration gate', async () => {
  const { projectRoot, harnessDir } = (() => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-reviewer-'));
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
    return { projectRoot, harnessDir };
  })();
  try {
    const { sessionManager, logger, tokenTracker } = makeReviewerHarness(cannedReviewPassed);
    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
    await reviewer.reviewMilestone(
      'ms-ws', ['src/foo.js'], ['Task t1: test'], 'importGraph data', projectRoot, harnessDir
    );

    assert.strictEqual(sessionManager.calls.length, 1, 'expected exactly one spawn call');
    const prompt = sessionManager.calls[0].prompt;
    assert.ok(typeof prompt === 'string' && prompt.length > 0, 'prompt must be a non-empty string');

    // Rule forbids running the project's whole test suite …
    assert.ok(/(whole|full|entire)\s+(test\s+)?suite/i.test(prompt),
      'prompt must reference the whole/full test suite in a forbidding rule');
    // … and states the suite is run by the final integration gate.
    assert.ok(/integration gate/i.test(prompt),
      'prompt must state the suite is run by the final integration gate');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test('C2: reviewer spawn options include denyWholeSuiteBash: true', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-reviewer2-'));
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  try {
    const { sessionManager, logger, tokenTracker } = makeReviewerHarness(cannedReviewPassed);
    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
    await reviewer.reviewMilestone(
      'ms-ws2', ['src/foo.js'], ['Task t1: test'], 'importGraph data', projectRoot, harnessDir
    );

    assert.strictEqual(sessionManager.calls.length, 1, 'expected exactly one spawn call');
    assert.strictEqual(sessionManager.calls[0].denyWholeSuiteBash, true,
      'reviewer spawn options must set denyWholeSuiteBash: true');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Spec D — verifier warn message carries the spec-injection status marker
// ════════════════════════════════════════════════════════════════════════════

function makeVerifierSetup({ readFiles }) {
  const warnSpy = { calls: [] };
  const handle = { _readFiles: readFiles, _toolCallCount: 0, systemPromptTokens: 0 };
  const spawnResult = {
    handle,
    result: {
      structured_output: {
        result: 'PASSED',
        hardChecks: [],
        taskScopeChecks: [],
        back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
      },
    },
  };
  const thenable = Object.assign(Promise.resolve(spawnResult), { handle });
  const sessionManager = { spawn: () => thenable };
  const logger = {
    createSessionLog: () => ({ logPath: '/tmp/test-wsg-verifier.log', close: () => {} }),
    attachToSession: () => {},
    warn: (msg) => { warnSpy.calls.push(msg); },
    writeSessionSummary: async () => {},
    getSessionSummary: () => '',
  };
  const tokenTracker = { recordSession: async () => {} };
  return { sessionManager, logger, tokenTracker, warnSpy };
}

await test('D: spec NOT read + injected (non-empty relevantCriteria) → warn line mentions injection', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-verifier-inj-'));
  try {
    fs.mkdirSync(path.join(projectRoot, '.harness'), { recursive: true });
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const { sessionManager, logger, tokenTracker, warnSpy } = makeVerifierSetup({ readFiles: [] });
    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'd-alpha', description: 'test', targetFiles: [] };

    await verifier.verifyTask(task, projectRoot, {
      specPath,
      specGoal: 'goal',
      relevantCriteria: [
        { description: 'crit', verification: { kind: 'command', command: 'node test/test-z.js' } },
      ],
    });

    const injectedWarn = warnSpy.calls.find((m) => /inject/i.test(m));
    assert.ok(injectedWarn,
      `expected a warn line mentioning injection when spec unread but criteria injected. Warns: ${JSON.stringify(warnSpy.calls)}`);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

await test('D: spec NOT read + NOT injected (empty relevantCriteria) → plain not-read warn without injection marker', async () => {
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsg-verifier-noinj-'));
  try {
    fs.mkdirSync(path.join(projectRoot, '.harness'), { recursive: true });
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');

    const { sessionManager, logger, tokenTracker, warnSpy } = makeVerifierSetup({ readFiles: [] });
    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'd-beta', description: 'test', targetFiles: [] };

    await verifier.verifyTask(task, projectRoot, {
      specPath,
      specGoal: '',
      relevantCriteria: [],  // no injection
    });

    // A not-read warn should still fire, but none of the warns may claim injection.
    assert.ok(warnSpy.calls.length > 0,
      'expected a spec-not-read warn to fire when the spec was not read');
    const injectedWarn = warnSpy.calls.find((m) => /inject/i.test(m));
    assert.ok(!injectedWarn,
      `no warn may claim injection when relevantCriteria was empty. Warns: ${JSON.stringify(warnSpy.calls)}`);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
