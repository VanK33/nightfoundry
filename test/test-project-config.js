/**
 * test-project-config.js — Per-project .cc-orch.json test-command override.
 *
 * Spec: queue/project-config.spec (mission 001-005)
 * Contract under test (src/orchestrator/infra/project-config.js):
 *   - loadProjectConfig(projectRoot) reads <projectRoot>/.cc-orch.json.
 *   - Absent file: silent no-op — config.execution.testCommand/testAllCommand
 *     are left byte-identical to their current values.
 *   - Present file: validated against the recognised shape
 *     { execution: { testCommand?, testAllCommand? } }; only the fields
 *     present are applied onto config.execution.
 *   - Fail-loud on: unparseable JSON, any unknown key (top-level or nested),
 *     a non-string command value, or an empty-string command value — each
 *     throws an Error naming the file path and/or the offending key.
 *   - Idempotent: calling twice with the same root re-applies the same
 *     values with no additional side effect.
 *
 * Entry-point wiring parity pin (case h): the CLI dispatcher (src/cli/index.js)
 * and both trigger entry points (src/triggers/webhook.js, src/triggers/cron.js)
 * must import loadProjectConfig from '../orchestrator/infra/project-config.js'
 * and invoke it at their projectRoot/PROJECT_ROOT resolution point. Verified
 * by reading each source file and asserting the import + call-site text,
 * per the task's explicit instruction (importing and driving all three real
 * entry points would require spinning up an HTTP server / cron scheduler /
 * full CLI dispatch, which is out of scope for this closed-surface test).
 *
 * TC1: (a) file overriding BOTH commands → both applied
 * TC2: (b) file overriding ONLY testCommand → testCommand applied, testAllCommand unchanged
 * TC3: (c) ABSENT file → no mutation, both fields byte-identical before/after
 * TC4: (d) unparseable JSON → throws, message contains the file path
 * TC5: (e) unknown top-level key AND unknown nested key (execution.testcommand) → each throws, naming the key
 * TC6: (f) non-string command AND empty-string command → each throws
 * TC7: (g) idempotence — loading twice does not throw and yields the same values
 * TC8: (h) entry-point wiring parity pin — CLI + both triggers call the loader
 * TC9: config.execution fields are restored to their pre-suite values after every case
 *
 * Every case saves config.execution.testCommand/testAllCommand before running
 * and restores them in a finally block: the loader mutates a config singleton
 * shared with the rest of the suite, so a leaked override would corrupt
 * sibling tests.
 *
 * Run: node test/test-project-config.js
 */

// See scripts/run-tests.js for the rationale: clear the re-entrancy marker
// at module top so this suite runs re-entrancy-neutral regardless of launch
// context (mkdtemp fixture roots here are not live runs).
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import config from '../src/orchestrator/infra/config.js';
import { loadProjectConfig } from '../src/orchestrator/infra/project-config.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failCount++;
    }
  );
}

// ── Harness helpers ──────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/** Creates a fresh temp fixture dir (no .cc-orch.json unless the test adds one). */
function createFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'project-config-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeConfigFile(dir, contents) {
  const filePath = path.join(dir, '.cc-orch.json');
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function writeJsonConfigFile(dir, obj) {
  return writeConfigFile(dir, JSON.stringify(obj));
}

/**
 * Snapshots config.execution.testCommand/testAllCommand, runs fn, and
 * restores both fields to their pre-call values in finally — regardless of
 * whether fn throws. The loader mutates a shared module singleton, so a
 * leaked override would corrupt sibling tests (TC9 pins this discipline).
 */
function withSavedExecutionFields(fn) {
  const savedTestCommand = config.execution.testCommand;
  const savedTestAllCommand = config.execution.testAllCommand;
  try {
    return fn({ testCommand: savedTestCommand, testAllCommand: savedTestAllCommand });
  } finally {
    config.execution.testCommand = savedTestCommand;
    config.execution.testAllCommand = savedTestAllCommand;
  }
}

// Suite-level snapshot, captured before any test runs, so TC9 can pin that
// no case leaks a mutation past its own finally block.
const SUITE_INITIAL_TEST_COMMAND = config.execution.testCommand;
const SUITE_INITIAL_TEST_ALL_COMMAND = config.execution.testAllCommand;

// ── Tests ────────────────────────────────────────────────────────────────────

await test('TC1: (a) .cc-orch.json overriding BOTH commands → both applied', () => {
  withSavedExecutionFields(() => {
    const fixture = createFixtureDir();
    try {
      writeJsonConfigFile(fixture, {
        execution: {
          testCommand: 'echo tc1-test-command',
          testAllCommand: 'echo tc1-test-all-command',
        },
      });
      loadProjectConfig(fixture);
      assert.strictEqual(
        config.execution.testCommand,
        'echo tc1-test-command',
        'testCommand must be overridden by the fixture file'
      );
      assert.strictEqual(
        config.execution.testAllCommand,
        'echo tc1-test-all-command',
        'testAllCommand must be overridden by the fixture file'
      );
    } finally {
      cleanup(fixture);
    }
  });
});

await test('TC2: (b) overriding ONLY testCommand → applied; testAllCommand unchanged', () => {
  withSavedExecutionFields((before) => {
    const fixture = createFixtureDir();
    try {
      writeJsonConfigFile(fixture, {
        execution: {
          testCommand: 'echo tc2-test-command-only',
        },
      });
      loadProjectConfig(fixture);
      assert.strictEqual(
        config.execution.testCommand,
        'echo tc2-test-command-only',
        'testCommand must be overridden by the fixture file'
      );
      assert.strictEqual(
        config.execution.testAllCommand,
        before.testAllCommand,
        'testAllCommand must remain at its prior value when omitted from the fixture file'
      );
    } finally {
      cleanup(fixture);
    }
  });
});

await test('TC3: (c) ABSENT .cc-orch.json → no mutation, values byte-identical before/after', () => {
  withSavedExecutionFields((before) => {
    const fixture = createFixtureDir();
    try {
      assert.ok(
        !fs.existsSync(path.join(fixture, '.cc-orch.json')),
        'fixture precondition: .cc-orch.json must be absent'
      );
      loadProjectConfig(fixture);
      assert.strictEqual(
        config.execution.testCommand,
        before.testCommand,
        'testCommand must be byte-identical to its pre-load value when no file is present'
      );
      assert.strictEqual(
        config.execution.testAllCommand,
        before.testAllCommand,
        'testAllCommand must be byte-identical to its pre-load value when no file is present'
      );
    } finally {
      cleanup(fixture);
    }
  });
});

await test('TC4: (d) unparseable JSON → throws, message contains the file path', () => {
  withSavedExecutionFields(() => {
    const fixture = createFixtureDir();
    try {
      const filePath = writeConfigFile(fixture, '{ this is not valid JSON');
      assert.throws(
        () => loadProjectConfig(fixture),
        (err) => {
          assert.ok(err instanceof Error, 'must throw an Error');
          assert.ok(
            err.message.includes(filePath),
            `error message must contain the file path (${filePath}), got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      cleanup(fixture);
    }
  });
});

await test('TC5a: (e) unknown TOP-LEVEL key → throws naming the key', () => {
  withSavedExecutionFields(() => {
    const fixture = createFixtureDir();
    try {
      writeJsonConfigFile(fixture, { unknownTopLevelKey: 'x' });
      assert.throws(
        () => loadProjectConfig(fixture),
        (err) => {
          assert.ok(
            err.message.includes('unknownTopLevelKey'),
            `error message must name the offending key, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      cleanup(fixture);
    }
  });
});

await test('TC5b: (e) unknown NESTED key execution.testcommand → throws naming the key', () => {
  withSavedExecutionFields(() => {
    const fixture = createFixtureDir();
    try {
      writeJsonConfigFile(fixture, { execution: { testcommand: 'x' } });
      assert.throws(
        () => loadProjectConfig(fixture),
        (err) => {
          assert.ok(
            err.message.includes('testcommand'),
            `error message must name the offending nested key, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      cleanup(fixture);
    }
  });
});

await test('TC6a: (f) non-string command value → throws', () => {
  withSavedExecutionFields(() => {
    const fixture = createFixtureDir();
    try {
      writeJsonConfigFile(fixture, { execution: { testCommand: 12345 } });
      assert.throws(
        () => loadProjectConfig(fixture),
        (err) => {
          assert.ok(
            err.message.includes('testCommand'),
            `error message must name the offending key, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      cleanup(fixture);
    }
  });
});

await test('TC6b: (f) empty-string command value → throws', () => {
  withSavedExecutionFields(() => {
    const fixture = createFixtureDir();
    try {
      writeJsonConfigFile(fixture, { execution: { testAllCommand: '' } });
      assert.throws(
        () => loadProjectConfig(fixture),
        (err) => {
          assert.ok(
            err.message.includes('testAllCommand'),
            `error message must name the offending key, got: ${err.message}`
          );
          return true;
        }
      );
    } finally {
      cleanup(fixture);
    }
  });
});

await test('TC7: (g) idempotence — loading twice does not throw and matches single-load result', () => {
  withSavedExecutionFields(() => {
    const fixture = createFixtureDir();
    try {
      writeJsonConfigFile(fixture, {
        execution: {
          testCommand: 'echo tc7-idempotent-command',
          testAllCommand: 'echo tc7-idempotent-command-all',
        },
      });

      loadProjectConfig(fixture);
      const afterFirstLoad = {
        testCommand: config.execution.testCommand,
        testAllCommand: config.execution.testAllCommand,
      };

      assert.doesNotThrow(() => loadProjectConfig(fixture), 'second load with the same root must not throw');

      assert.strictEqual(
        config.execution.testCommand,
        afterFirstLoad.testCommand,
        'testCommand after the second load must match the result of the first load'
      );
      assert.strictEqual(
        config.execution.testAllCommand,
        afterFirstLoad.testAllCommand,
        'testAllCommand after the second load must match the result of the first load'
      );
    } finally {
      cleanup(fixture);
    }
  });
});

await test('TC8: (h) entry-point wiring parity pin — CLI + both triggers call loadProjectConfig', () => {
  const IMPORT_SNIPPET = "from '../orchestrator/infra/project-config.js'";

  // CLI dispatcher: src/cli/index.js
  {
    const cliPath = path.join(REPO_ROOT, 'src', 'cli', 'index.js');
    const source = fs.readFileSync(cliPath, 'utf8');
    assert.ok(
      source.includes('loadProjectConfig') && source.includes(IMPORT_SNIPPET),
      'src/cli/index.js must import loadProjectConfig from ../orchestrator/infra/project-config.js'
    );
    const resolutionIdx = source.indexOf('flags.project || flags.p || process.cwd()');
    const callIdx = source.indexOf('loadProjectConfig(projectRoot)');
    assert.ok(resolutionIdx !== -1, 'src/cli/index.js must resolve projectRoot via flags.project || flags.p || process.cwd()');
    assert.ok(callIdx !== -1, 'src/cli/index.js must call loadProjectConfig(projectRoot)');
    assert.ok(
      callIdx > resolutionIdx,
      'src/cli/index.js must call loadProjectConfig(projectRoot) at (after) the projectRoot resolution point'
    );
  }

  // Webhook trigger: src/triggers/webhook.js
  {
    const webhookPath = path.join(REPO_ROOT, 'src', 'triggers', 'webhook.js');
    const source = fs.readFileSync(webhookPath, 'utf8');
    assert.ok(
      source.includes('loadProjectConfig') && source.includes(IMPORT_SNIPPET),
      'src/triggers/webhook.js must import loadProjectConfig from ../orchestrator/infra/project-config.js'
    );
    const resolutionIdx = source.indexOf('export function buildWebhookApp({ projectRoot');
    const callIdx = source.indexOf('loadProjectConfig(projectRoot)');
    assert.ok(resolutionIdx !== -1, 'src/triggers/webhook.js must define buildWebhookApp({ projectRoot, ... })');
    assert.ok(callIdx !== -1, 'src/triggers/webhook.js must call loadProjectConfig(projectRoot)');
    assert.ok(
      callIdx > resolutionIdx,
      'src/triggers/webhook.js must call loadProjectConfig(projectRoot) at (after) its projectRoot entry point'
    );
  }

  // Cron trigger: src/triggers/cron.js
  {
    const cronPath = path.join(REPO_ROOT, 'src', 'triggers', 'cron.js');
    const source = fs.readFileSync(cronPath, 'utf8');
    assert.ok(
      source.includes('loadProjectConfig') && source.includes(IMPORT_SNIPPET),
      'src/triggers/cron.js must import loadProjectConfig from ../orchestrator/infra/project-config.js'
    );
    const resolutionIdx = source.indexOf("const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();");
    const callIdx = source.indexOf('loadProjectConfig(PROJECT_ROOT)');
    assert.ok(resolutionIdx !== -1, 'src/triggers/cron.js must resolve PROJECT_ROOT via process.env.PROJECT_ROOT || process.cwd()');
    assert.ok(callIdx !== -1, 'src/triggers/cron.js must call loadProjectConfig(PROJECT_ROOT)');
    assert.ok(
      callIdx > resolutionIdx,
      'src/triggers/cron.js must call loadProjectConfig(PROJECT_ROOT) at (after) its PROJECT_ROOT resolution point'
    );
  }
});

await test('TC9: config.execution fields are restored to their pre-suite values after every case', () => {
  assert.strictEqual(
    config.execution.testCommand,
    SUITE_INITIAL_TEST_COMMAND,
    'config.execution.testCommand must equal its pre-suite value — no case may leak an override'
  );
  assert.strictEqual(
    config.execution.testAllCommand,
    SUITE_INITIAL_TEST_ALL_COMMAND,
    'config.execution.testAllCommand must equal its pre-suite value — no case may leak an override'
  );
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
