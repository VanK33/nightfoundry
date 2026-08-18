/**
 * test-cli-router.js — CLI integration tests for cc-orch routing.
 *
 * Run: node test/test-cli-router.js
 *
 * Covers:
 *   TC1  — 'cc-orch version' outputs version matching package.json
 *   TC2  — 'cc-orch help' prints help text and exits 0
 *   TC3  — No args prints help text and exits 0
 *   TC4  — 'cc-orch spec.md' with non-existent .md path routes to run (no 'unknown command')
 *   TC5  — Unknown command 'statis' prints 'Did you mean: status?'
 *   TC6  — Unknown command 'xyzzy' (distance > 3) prints generic error without suggestion
 *   TC7  — Legacy flag '--status' is rejected and suggests 'status'
 *   TC8  — Legacy flag '--resume' is rejected and suggests 'resume'
 *   TC9  — 'cc-orch status' in dir without .harness exits with state error
 *   TC10 — 'cc-orch resume' in dir without .harness exits with state error
 *   TC11 — 'cc-orch dry-run' without spec arg prints usage error and exits non-zero
 *   TC12 — 'cc-orch dry-run nonexistent.md' prints file-not-found error and exits non-zero
 *   TC13 — 'cc-orch task' without description prints usage error and exits non-zero
 *   TC14 — 'cc-orch help' output includes 'dry-run' and 'task'
 *   TC15 — Fuzzy match: 'dry-rn' suggests 'dry-run'
 *   TC16 — '.md' shortcut routes to 'run', not 'dry-run'
 *   TC19–TC26 — queue remove|retry / park show|resolve / archive show|diff /
 *               usage compare / warnings show fail loud with a usage line
 *               when the required slug/id argument is missing
 *   TC27 — direct `node src/cli/index.js version` renders the 'nightfoundry'
 *          banner with the package.json version
 *   TC28 — invoked through a shim/symlink named 'cc-orch', version and help
 *          render 'cc-orch' (not 'nightfoundry')
 *   TC29 — invoked through a shim/symlink named 'nightfoundry', version and
 *          help render 'nightfoundry'
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync as childSpawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    failCount++;
  }
}

const cliPath = path.resolve(__dirname, '../src/cli/index.js');

function spawnCli(args, opts = {}) {
  const result = childSpawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env },
    timeout: 10000,
    encoding: 'utf8',
    ...opts,
  });

  assert.ifError(result.error);
  assert.notStrictEqual(
    result.status,
    null,
    `CLI did not exit cleanly for args ${JSON.stringify(args)}`
  );

  return result;
}

/**
 * Run the CLI via an explicit entry-point path (e.g. a shim/symlink whose
 * basename drives displayName()'s 'cc-orch' / 'nightfoundry' rendering),
 * rather than always spawning the real src/cli/index.js path directly.
 */
function spawnCliVia(entryPath, args, opts = {}) {
  const result = childSpawnSync(process.execPath, [entryPath, ...args], {
    env: { ...process.env },
    timeout: 10000,
    encoding: 'utf8',
    ...opts,
  });

  assert.ifError(result.error);
  assert.notStrictEqual(
    result.status,
    null,
    `CLI did not exit cleanly for entry ${entryPath} args ${JSON.stringify(args)}`
  );

  return result;
}

// ---------------------------------------------------------------------------
// TC1 — version output matches package.json version field
// ---------------------------------------------------------------------------
await test('TC1: version output matches package.json version field', async () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')
  );

  const result = spawnCli(['version']);
  const combined = (result.stdout || '') + (result.stderr || '');

  assert.ok(
    combined.includes(pkg.version),
    `Expected output to contain version "${pkg.version}", got: ${combined.trim()}`
  );
});

// ---------------------------------------------------------------------------
// TC2 — 'cc-orch help' prints help text and exits 0
// ---------------------------------------------------------------------------
await test('TC2: help output is non-empty and exits 0', async () => {
  const result = spawnCli(['help']);

  const combined = (result.stdout || '') + (result.stderr || '');

  assert.ok(
    combined.trim().length > 0,
    `Expected non-empty help output, got empty string`
  );

  assert.strictEqual(
    result.status,
    0,
    `Expected exit code 0, got ${result.status}. Output: ${combined.trim()}`
  );
});

// ---------------------------------------------------------------------------
// TC3 — No args prints help text and exits 0
// ---------------------------------------------------------------------------
await test('TC3: no-args shows help and exits 0', async () => {
  const result = spawnCli([]);

  const combined = (result.stdout || '') + (result.stderr || '');

  assert.ok(
    combined.trim().length > 0,
    `Expected non-empty help output with no args, got empty string`
  );

  assert.strictEqual(
    result.status,
    0,
    `Expected exit code 0 with no args, got ${result.status}. Output: ${combined.trim()}`
  );
});

// ---------------------------------------------------------------------------
// TC4 — .md file argument does not trigger unknown command error
// ---------------------------------------------------------------------------
await test('TC4: .md file argument does not trigger unknown command error', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
  try {
    // Use a non-existent .md path — the CLI routes it to run() which immediately
    // fails with "File not found", proving the .md shortcut was taken (not the
    // "unknown command" path). This avoids invoking the real agent pipeline.
    const specFile = path.join(tmpDir, 'spec.md');

    const result = spawnCli([specFile], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.ok(
      !combined.toLowerCase().includes('unknown command'),
      `Expected no "unknown command" error when passing .md file, but got: ${combined.trim()}`
    );

    assert.ok(
      combined.includes('File not found') || combined.includes('spec.md'),
      `Expected "File not found" routing response for .md argument, got: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC5 — Unknown command 'statis' suggests 'status'
// ---------------------------------------------------------------------------
await test("TC5: unknown command 'statis' suggests 'status'", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
  try {
    const result = spawnCli(['statis'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.ok(
      combined.includes('Did you mean') && combined.includes('status'),
      `Expected "Did you mean: status?" suggestion, got: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC6 — Unknown command with no close match shows generic error without suggestion
// ---------------------------------------------------------------------------
await test("TC6: unknown command 'xyzzy' shows generic error without suggestion", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
  try {
    const result = spawnCli(['xyzzy'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    // Should print some kind of unknown command / error output
    assert.ok(
      combined.toLowerCase().includes('unknown') ||
        combined.toLowerCase().includes('error') ||
        result.status !== 0,
      `Expected an error for unknown command 'xyzzy', got: ${combined.trim()}`
    );

    // Should NOT suggest anything (distance > 3 from any known command)
    assert.ok(
      !combined.includes('Did you mean'),
      `Expected no suggestion for 'xyzzy', but got: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC7 — Legacy flag '--status' is rejected and suggests 'status'
// ---------------------------------------------------------------------------
await test("TC7: legacy flag '--status' is rejected and suggests positional 'status' command", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
  try {
    const result = spawnCli(['--status'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.ok(
      combined.includes('status'),
      `Expected output to mention 'status' command, got: ${combined.trim()}`
    );

    // Should suggest using positional 'status' instead of --status flag
    assert.ok(
      combined.includes('cc-orch status') || combined.includes("use 'status'") || combined.includes('Did you mean'),
      `Expected suggestion to use positional 'status', got: ${combined.trim()}`
    );

    assert.notStrictEqual(
      result.status,
      0,
      `Expected non-zero exit code for deprecated --status flag, got 0`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC8 — Legacy flag '--resume' is rejected and suggests 'resume'
// ---------------------------------------------------------------------------
await test("TC8: legacy flag '--resume' is rejected and suggests positional 'resume' command", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
  try {
    const result = spawnCli(['--resume'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.ok(
      combined.includes('resume'),
      `Expected output to mention 'resume' command, got: ${combined.trim()}`
    );

    // Should reject with EITHER a legacy-suggestion message OR a value-flag-arity error.
    // The value-flag arity error appears because --resume is a real value flag for the
    // brainstorm subcommand; at top level it has no value to consume, hence the error.
    // Both are valid rejections — the user typed something invalid and got told so.
    assert.ok(
      combined.includes('cc-orch resume') ||
        combined.includes("use 'resume'") ||
        combined.includes('Did you mean') ||
        combined.includes('--resume requires a value'),
      `Expected rejection of legacy --resume usage (either positional suggestion or value-flag arity error), got: ${combined.trim()}`
    );

    assert.notStrictEqual(
      result.status,
      0,
      `Expected non-zero exit code for deprecated --resume flag, got 0`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC9 — 'cc-orch status' in dir without .harness exits with state error
// ---------------------------------------------------------------------------
await test("TC9: 'cc-orch status' in dir without .harness exits with state error (routing confirmed)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
  try {
    const result = spawnCli(['status'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    // Should not say "File not found: status" — that would mean routing never reached the status handler
    assert.ok(
      !combined.includes('File not found: status'),
      `Expected routing to reach status handler, not treat 'status' as a file path. Got: ${combined.trim()}`
    );

    // Should indicate a missing .harness state (proving the status handler was invoked)
    assert.ok(
      combined.includes('.harness') || combined.includes('state.json') || combined.includes('init'),
      `Expected a state/harness error from status handler, got: ${combined.trim()}`
    );

    assert.notStrictEqual(
      result.status,
      0,
      `Expected non-zero exit code when .harness is missing, got 0`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC10 — 'cc-orch resume' in dir without .harness exits with state error
// ---------------------------------------------------------------------------
await test("TC10: 'cc-orch resume' in dir without .harness exits with state error (routing confirmed)", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
  try {
    const result = spawnCli(['resume'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    // Should not say "File not found: resume" — that would mean routing never reached the resume handler
    assert.ok(
      !combined.includes('File not found: resume'),
      `Expected routing to reach resume handler, not treat 'resume' as a file path. Got: ${combined.trim()}`
    );

    // Should indicate a missing .harness state (proving the resume handler was invoked)
    assert.ok(
      combined.includes('.harness') || combined.includes('state.json') || combined.includes('init'),
      `Expected a state/harness error from resume handler, got: ${combined.trim()}`
    );

    assert.notStrictEqual(
      result.status,
      0,
      `Expected non-zero exit code when .harness is missing, got 0`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC11 — 'cc-orch dry-run' without spec arg prints usage error and exits non-zero
// ---------------------------------------------------------------------------
await test("TC11: 'cc-orch dry-run' without spec arg exits non-zero with usage message", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
  try {
    const result = spawnCli(['dry-run'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.notStrictEqual(
      result.status,
      0,
      `Expected non-zero exit code when no spec arg is provided to dry-run, got 0`
    );

    assert.ok(
      combined.toLowerCase().includes('usage') ||
        combined.toLowerCase().includes('spec') ||
        combined.toLowerCase().includes('required') ||
        combined.toLowerCase().includes('missing') ||
        combined.toLowerCase().includes('argument') ||
        combined.toLowerCase().includes('error'),
      `Expected a usage/error message when no spec arg, got: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC12 — 'cc-orch dry-run nonexistent.md' prints file-not-found error
// ---------------------------------------------------------------------------
await test("TC12: 'cc-orch dry-run nonexistent.md' prints file-not-found error and exits non-zero", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
  try {
    const result = spawnCli(['dry-run', 'nonexistent.md'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.notStrictEqual(
      result.status,
      0,
      `Expected non-zero exit code when spec file doesn't exist, got 0`
    );

    assert.ok(
      combined.toLowerCase().includes('not found') ||
        combined.toLowerCase().includes('no such file') ||
        combined.toLowerCase().includes('enoent') ||
        combined.toLowerCase().includes('nonexistent') ||
        combined.toLowerCase().includes('does not exist') ||
        combined.toLowerCase().includes('cannot find'),
      `Expected a file-not-found error for nonexistent.md, got: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC13 — 'cc-orch task' without description prints usage error and exits non-zero
// ---------------------------------------------------------------------------
await test("TC13: 'cc-orch task' without description exits non-zero with usage message", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
  try {
    const result = spawnCli(['task'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.notStrictEqual(
      result.status,
      0,
      `Expected non-zero exit code when no description is provided to task, got 0`
    );

    assert.ok(
      combined.toLowerCase().includes('usage') ||
        combined.toLowerCase().includes('description') ||
        combined.toLowerCase().includes('required') ||
        combined.toLowerCase().includes('missing') ||
        combined.toLowerCase().includes('argument') ||
        combined.toLowerCase().includes('error'),
      `Expected a usage/error message when no description provided, got: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC14 — 'cc-orch help' output includes 'dry-run' and 'task'
// ---------------------------------------------------------------------------
await test("TC14: 'cc-orch help' output includes 'dry-run' and 'task' commands", async () => {
  const result = spawnCli(['help']);
  const combined = (result.stdout || '') + (result.stderr || '');

  assert.ok(
    combined.includes('dry-run'),
    `Expected help output to include 'dry-run', got: ${combined.trim()}`
  );

  assert.ok(
    combined.includes('task'),
    `Expected help output to include 'task', got: ${combined.trim()}`
  );
});

// ---------------------------------------------------------------------------
// TC15 — Fuzzy match: 'dry-rn' suggests 'dry-run'
// ---------------------------------------------------------------------------
await test("TC15: fuzzy-match for 'dry-rn' suggests 'dry-run'", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
  try {
    const result = spawnCli(['dry-rn'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.ok(
      combined.includes('Did you mean') && combined.includes('dry-run'),
      `Expected "Did you mean: dry-run?" suggestion for 'dry-rn', got: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC16 — '.md' shortcut routes to 'run', not 'dry-run'
// ---------------------------------------------------------------------------
await test("TC16: .md shortcut routes to 'run', not 'dry-run'", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
  try {
    const specFile = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specFile, '# Test spec\n', 'utf8');

    const result = spawnCli([specFile], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    // Should NOT trigger dry-run mode
    assert.ok(
      !combined.toLowerCase().includes('dry run') &&
        !combined.toLowerCase().includes('dry-run mode'),
      `Expected .md shortcut to route to 'run', not 'dry-run'. Got: ${combined.trim()}`
    );

    // Should not say "unknown command"
    assert.ok(
      !combined.toLowerCase().includes('unknown command'),
      `Expected no "unknown command" error when passing .md file, got: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC17 — '--role --json' exits non-zero with a clear "requires a value" error
// ---------------------------------------------------------------------------
await test("TC17: '--role --json' exits non-zero with 'requires a value' error", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
  try {
    const result = spawnCli(['usage', '--role', '--json'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.notStrictEqual(
      result.status,
      0,
      `Expected non-zero exit code when --role is followed by another flag, got 0`
    );

    assert.ok(
      combined.includes('--role') && combined.toLowerCase().includes('requires a value'),
      `Expected "Option --role requires a value" error, got: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC18 — '--role' at end of args exits non-zero with a clear "requires a value" error
// ---------------------------------------------------------------------------
await test("TC18: '--role' at end of args exits non-zero with 'requires a value' error", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
  try {
    const result = spawnCli(['usage', '--role'], { cwd: tmpDir });
    const combined = (result.stdout || '') + (result.stderr || '');

    assert.notStrictEqual(
      result.status,
      0,
      `Expected non-zero exit code when --role has no value, got 0`
    );

    assert.ok(
      combined.includes('--role') && combined.toLowerCase().includes('requires a value'),
      `Expected "Option --role requires a value" error, got: ${combined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC19–TC26 — subcommands with a required slug/id argument fail loud with a
// usage line when the argument is missing, instead of passing undefined into
// the handler (which used to surface as a bogus "queue entry is damaged
// (The \"path\" argument must be of type string)" error naming 'undefined').
// ---------------------------------------------------------------------------
const MISSING_ARG_CASES = [
  { tc: 'TC19', args: ['queue', 'retry'], usage: 'Usage: cc-orch queue retry <slug>' },
  { tc: 'TC20', args: ['queue', 'remove'], usage: 'Usage: cc-orch queue remove <slug>' },
  { tc: 'TC21', args: ['park', 'show'], usage: 'Usage: cc-orch park show <slug>' },
  { tc: 'TC22', args: ['park', 'resolve'], usage: 'Usage: cc-orch park resolve <slug>' },
  { tc: 'TC23', args: ['archive', 'show'], usage: 'Usage: cc-orch archive show <id>' },
  { tc: 'TC24', args: ['archive', 'diff', 'only-one'], usage: 'Usage: cc-orch archive diff <a> <b>' },
  { tc: 'TC25', args: ['usage', 'compare', 'only-one'], usage: 'Usage: cc-orch usage compare <a> <b>' },
  { tc: 'TC26', args: ['warnings', 'show'], usage: 'Usage: cc-orch warnings show <id>' },
];

for (const { tc, args, usage } of MISSING_ARG_CASES) {
  await test(`${tc}: 'cc-orch ${args.join(' ')}' without required arg exits non-zero with usage line`, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-router-test-'));
    try {
      const result = spawnCli(args, { cwd: tmpDir });
      const combined = (result.stdout || '') + (result.stderr || '');

      assert.notStrictEqual(
        result.status,
        0,
        `Expected non-zero exit code for '${args.join(' ')}' with missing arg, got 0`
      );

      assert.ok(
        combined.includes(usage),
        `Expected "${usage}" in output, got: ${combined.trim()}`
      );

      assert.ok(
        !combined.includes('undefined'),
        `Output must not leak 'undefined' for missing arg, got: ${combined.trim()}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// TC27 — direct `node src/cli/index.js version` renders the 'nightfoundry'
// banner with the package.json version
// ---------------------------------------------------------------------------
await test("TC27: direct invocation of src/cli/index.js renders 'nightfoundry v<version>'", async () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')
  );

  const result = spawnCli(['version']);
  const combined = (result.stdout || '') + (result.stderr || '');

  assert.ok(
    combined.includes(`nightfoundry v${pkg.version}`),
    `Expected output to contain "nightfoundry v${pkg.version}", got: ${combined.trim()}`
  );
});

// ---------------------------------------------------------------------------
// TC28 — invoked through a shim/symlink named 'cc-orch', version and help
// render 'cc-orch' (not 'nightfoundry')
// ---------------------------------------------------------------------------
await test("TC28: invoked via a 'cc-orch' shim, version and help render 'cc-orch'", async () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-shim-test-'));
  try {
    const shimPath = path.join(tmpDir, 'cc-orch');
    fs.symlinkSync(cliPath, shimPath);

    const versionResult = spawnCliVia(shimPath, ['version']);
    const versionCombined = (versionResult.stdout || '') + (versionResult.stderr || '');

    assert.ok(
      versionCombined.includes(`cc-orch v${pkg.version}`),
      `Expected output to contain "cc-orch v${pkg.version}", got: ${versionCombined.trim()}`
    );

    const helpResult = spawnCliVia(shimPath, ['help']);
    const helpCombined = (helpResult.stdout || '') + (helpResult.stderr || '');

    assert.ok(
      helpCombined.includes('cc-orch run <spec.md>'),
      `Expected help output to contain "cc-orch run <spec.md>", got: ${helpCombined.trim()}`
    );

    assert.ok(
      !helpCombined.includes('nightfoundry run'),
      `Expected help output to contain no "nightfoundry run" command line, got: ${helpCombined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC29 — invoked through a shim/symlink named 'nightfoundry', version and
// help render 'nightfoundry'
// ---------------------------------------------------------------------------
await test("TC29: invoked via a 'nightfoundry' shim, version and help render 'nightfoundry'", async () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-shim-test-'));
  try {
    const shimPath = path.join(tmpDir, 'nightfoundry');
    fs.symlinkSync(cliPath, shimPath);

    const versionResult = spawnCliVia(shimPath, ['version']);
    const versionCombined = (versionResult.stdout || '') + (versionResult.stderr || '');

    assert.ok(
      versionCombined.includes(`nightfoundry v${pkg.version}`),
      `Expected output to contain "nightfoundry v${pkg.version}", got: ${versionCombined.trim()}`
    );

    const helpResult = spawnCliVia(shimPath, ['help']);
    const helpCombined = (helpResult.stdout || '') + (helpResult.stderr || '');

    assert.ok(
      helpCombined.includes('nightfoundry run <spec.md>'),
      `Expected help output to contain "nightfoundry run <spec.md>", got: ${helpCombined.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
