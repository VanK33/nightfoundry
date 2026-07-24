/**
 * test-whole-suite-command-defer.js — Tests for deferring whole-suite / test-all
 * commands to the final gate.
 *
 * Behavior under test (NOT yet implemented at this HEAD — these assertions are
 * EXPECTED to fail here, which is what proves the tests exercise the change):
 *
 *   1. A NEW exported helper `isWholeSuiteCommand(command, config)` from
 *      src/orchestrator/agents/planner.js returns true iff `command` (trimmed)
 *      equals config.execution.testAllCommand OR config.execution.testCommand;
 *      false otherwise (incl. null/undefined command/config). Config-sourced,
 *      not hardcoded.
 *
 *   2. `buildVerifierSpecContext` (src/orchestrator/core/spec-text.js) excludes
 *      acceptance criteria whose verification.command is a whole-suite command
 *      from the relevantCriteria it returns. The current (HEAD) signature is
 *      buildVerifierSpecContext(harnessDir, task, criteria); it filters criteria
 *      to those whose verification.command matches one of the task's hardCheck
 *      commands. The new behavior additionally drops whole-suite commands.
 *
 *   3. (verifier-prompt contains a deferral instruction) — SKIPPED. See the note
 *      at the bottom of this file for the rationale.
 *
 * No Claude auth, no live sessions. Guarded dynamic imports so a MISSING export
 * or a MISSING module is reported as a normal FAIL rather than aborting the file
 * before later assertions run.
 *
 * Run: node test/test-whole-suite-command-defer.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

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

// ── Guarded dynamic-import helpers ───────────────────────────────────────────
// Resolve the symbol-under-test inside each test body so a missing module or a
// missing export surfaces as a FAIL (asserted symbol absence) and does NOT crash
// the whole file at load time.

async function loadIsWholeSuiteCommand() {
  const mod = await import('../src/orchestrator/agents/planner.js');
  assert.strictEqual(
    typeof mod.isWholeSuiteCommand,
    'function',
    'expected a named export `isWholeSuiteCommand` (function) from src/orchestrator/agents/planner.js',
  );
  return mod.isWholeSuiteCommand;
}

async function loadBuildVerifierSpecContext() {
  let mod;
  try {
    mod = await import('../src/orchestrator/core/spec-text.js');
  } catch (err) {
    assert.fail(
      'could not import src/orchestrator/core/spec-text.js: ' + err.message,
    );
  }
  assert.strictEqual(
    typeof mod.buildVerifierSpecContext,
    'function',
    'expected a named export `buildVerifierSpecContext` (function) from src/orchestrator/core/spec-text.js',
  );
  return mod.buildVerifierSpecContext;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whole-suite-defer-'));
}
function cleanup(d) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// Fake configs (do NOT depend on the real config singleton — the helper takes
// config as an explicit second argument).
const DEFAULT_CONFIG = {
  execution: { testAllCommand: 'npm run test:all', testCommand: 'npm test' },
};
const CUSTOM_CONFIG = {
  execution: { testAllCommand: 'make test-all', testCommand: 'make test' },
};

// Whole-suite command string used in the item-2 spec set. Matches the default
// config's testAllCommand; the implementation is expected to source the
// whole-suite command set from config (default config carries these values).
const WHOLE_SUITE_COMMAND = 'npm run test:all';
const NORMAL_COMMAND = 'node test/test-foo.js';

// ── Item 1: isWholeSuiteCommand(command, config) ─────────────────────────────

await test('isWholeSuiteCommand: default config — testAllCommand → true', async () => {
  const isWholeSuiteCommand = await loadIsWholeSuiteCommand();
  assert.strictEqual(
    isWholeSuiteCommand('npm run test:all', DEFAULT_CONFIG),
    true,
    "'npm run test:all' should be recognized as a whole-suite command",
  );
});

await test('isWholeSuiteCommand: default config — testCommand → true', async () => {
  const isWholeSuiteCommand = await loadIsWholeSuiteCommand();
  assert.strictEqual(
    isWholeSuiteCommand('npm test', DEFAULT_CONFIG),
    true,
    "'npm test' should be recognized as a whole-suite command",
  );
});

await test('isWholeSuiteCommand: default config — task-local command → false', async () => {
  const isWholeSuiteCommand = await loadIsWholeSuiteCommand();
  assert.strictEqual(
    isWholeSuiteCommand('node test/test-foo.js', DEFAULT_CONFIG),
    false,
    "'node test/test-foo.js' is a task-local command, not whole-suite",
  );
});

await test('isWholeSuiteCommand: default config — surrounding whitespace is trimmed → true', async () => {
  const isWholeSuiteCommand = await loadIsWholeSuiteCommand();
  assert.strictEqual(
    isWholeSuiteCommand('  npm run test:all  ', DEFAULT_CONFIG),
    true,
    "'  npm run test:all  ' (whitespace-padded) should still match after trimming",
  );
});

await test('isWholeSuiteCommand: undefined command → false', async () => {
  const isWholeSuiteCommand = await loadIsWholeSuiteCommand();
  assert.strictEqual(
    isWholeSuiteCommand(undefined, DEFAULT_CONFIG),
    false,
    'undefined command should be false',
  );
});

await test('isWholeSuiteCommand: null command → false', async () => {
  const isWholeSuiteCommand = await loadIsWholeSuiteCommand();
  assert.strictEqual(
    isWholeSuiteCommand(null, DEFAULT_CONFIG),
    false,
    'null command should be false',
  );
});

await test('isWholeSuiteCommand: null config → false (no crash)', async () => {
  const isWholeSuiteCommand = await loadIsWholeSuiteCommand();
  assert.strictEqual(
    isWholeSuiteCommand('npm run test:all', null),
    false,
    'null config should yield false rather than throwing',
  );
});

await test('isWholeSuiteCommand: undefined config → false (no crash)', async () => {
  const isWholeSuiteCommand = await loadIsWholeSuiteCommand();
  assert.strictEqual(
    isWholeSuiteCommand('npm run test:all', undefined),
    false,
    'undefined config should yield false rather than throwing',
  );
});

await test('isWholeSuiteCommand: config-sourced — custom config recognizes its own commands', async () => {
  const isWholeSuiteCommand = await loadIsWholeSuiteCommand();
  assert.strictEqual(
    isWholeSuiteCommand('make test-all', CUSTOM_CONFIG),
    true,
    "with CUSTOM_CONFIG, 'make test-all' (its testAllCommand) should be true",
  );
});

await test('isWholeSuiteCommand: config-sourced — custom config rejects default command (not hardcoded)', async () => {
  const isWholeSuiteCommand = await loadIsWholeSuiteCommand();
  assert.strictEqual(
    isWholeSuiteCommand('npm run test:all', CUSTOM_CONFIG),
    false,
    "with CUSTOM_CONFIG, 'npm run test:all' must NOT match — proves the helper reads config, not a hardcoded constant",
  );
});

// ── Item 2: buildVerifierSpecContext excludes whole-suite criteria ───────────
//
// buildVerifierSpecContext(harnessDir, task, criteria) filters `criteria` to
// those whose verification.command is one of the task's hardCheck commands.
//
// To make this a real discrimination of the NEW behavior, the task's hardChecks
// include BOTH the normal command AND the whole-suite command — so at HEAD both
// matching criteria pass the command-membership filter and BOTH land in
// relevantCriteria. The new behavior must additionally drop the whole-suite one.
//
// A whole-suite criterion is included in BOTH at HEAD only because the task lists
// it as a hardCheck; the new filter must remove it regardless.

await test('buildVerifierSpecContext: includes the task-local criterion', async () => {
  const buildVerifierSpecContext = await loadBuildVerifierSpecContext();
  const dir = tempDir();
  try {
    const task = {
      id: 'm1-001-001-001',
      description: 'write test-foo',
      hardChecks: [
        { command: NORMAL_COMMAND },
        { command: WHOLE_SUITE_COMMAND },
      ],
    };
    const criteria = [
      {
        description: 'task-local: test-foo passes',
        verification: { command: NORMAL_COMMAND },
      },
      {
        description: 'cross-cutting: whole suite passes',
        verification: { command: WHOLE_SUITE_COMMAND },
      },
    ];

    const config = { execution: { testAllCommand: WHOLE_SUITE_COMMAND, testCommand: 'npm test' } };
    const { relevantCriteria } = buildVerifierSpecContext(dir, task, criteria, config);
    const cmds = (relevantCriteria || []).map((c) => c.verification && c.verification.command);
    assert.ok(
      cmds.includes(NORMAL_COMMAND),
      `relevantCriteria should include the task-local criterion (${NORMAL_COMMAND}); got commands: ${JSON.stringify(cmds)}`,
    );
  } finally {
    cleanup(dir);
  }
});

await test('buildVerifierSpecContext: excludes the whole-suite criterion', async () => {
  const buildVerifierSpecContext = await loadBuildVerifierSpecContext();
  const dir = tempDir();
  try {
    const task = {
      id: 'm1-001-001-001',
      description: 'write test-foo',
      hardChecks: [
        { command: NORMAL_COMMAND },
        { command: WHOLE_SUITE_COMMAND },
      ],
    };
    const criteria = [
      {
        description: 'task-local: test-foo passes',
        verification: { command: NORMAL_COMMAND },
      },
      {
        description: 'cross-cutting: whole suite passes',
        verification: { command: WHOLE_SUITE_COMMAND },
      },
    ];

    const config = { execution: { testAllCommand: WHOLE_SUITE_COMMAND, testCommand: 'npm test' } };
    const { relevantCriteria } = buildVerifierSpecContext(dir, task, criteria, config);
    const cmds = (relevantCriteria || []).map((c) => c.verification && c.verification.command);
    assert.ok(
      !cmds.includes(WHOLE_SUITE_COMMAND),
      `relevantCriteria should EXCLUDE the whole-suite criterion (${WHOLE_SUITE_COMMAND}) — it is deferred to the final gate; got commands: ${JSON.stringify(cmds)}`,
    );
  } finally {
    cleanup(dir);
  }
});

// ── Item 3 (verifier-prompt deferral instruction): SKIPPED ───────────────────
//
// The behavior spec marks item 3 as "lighter, optional" and explicitly allows
// skipping it if a string-contains check on the constructed prompt would be too
// brittle. It is too brittle here:
//
//   - At this HEAD the verifier prompt is assembled INLINE inside the
//     Verifier.verifyTask method (src/orchestrator/agents/verifier.js), not via a
//     standalone exported prompt builder. Exercising it requires constructing a
//     full Verifier with a mock sessionManager/logger/tokenTracker (as in
//     test-verifier-spec-read-audit.js), an on-disk verify.json + spec file, and
//     reaching into spawnSpy.calls[0].prompt.
//   - The exact wording AND location of the new "defer whole-suite/test-all
//     commands to the final gate" instruction is unspecified by the behavior
//     spec, so any literal substring assertion would be a guess that could be
//     correct-behavior-but-wrong-string (a false negative) or trivially-true.
//
// Rather than encode a brittle guess, this item is intentionally omitted. Items
// 1 and 2 above are the load-bearing discriminators for the change.

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
