/**
 * test-cli-unknown-flag.js — Unit tests for parseArgs' flag-hygiene behavior:
 * unknown long/short flags (including inside combined short groups) are
 * rejected at parse time with an error naming the offending token, while
 * every currently-legitimate flag (long, short, combined short, and
 * value-taking) still parses successfully.
 *
 * Tests parseArgs directly from src/cli/index.js — no CLI subprocess spawn.
 * Run: node test/test-cli-unknown-flag.js
 */
import assert from 'assert';
import { parseArgs } from '../src/cli/index.js';

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

// Value-taking long flags: parseArgs always consumes their next arg as a
// value (mirrors VALUE_LONG_FLAGS in src/cli/index.js).
const VALUE_LONG_FLAGS = ['role', 'task', 'project', 'last', 'since', 'resume', 'port', 'note'];

// Derived whitelist of every long flag the CLI is expected to recognise
// (mirrors KNOWN_LONG_FLAGS in src/cli/index.js): (1) long keys read
// directly off `flags` in main()/commands, (2) VALUE_LONG_FLAGS above,
// (3) the dynamic per-command lookup tables (RESOLVE_ACTIONS in
// commands/park.js, RESOLVE_VERBS in commands/warnings.js), and (4) the
// legacy FLAG_TO_COMMAND keys in suggest.js (without their leading dashes).
const KNOWN_LONG_FLAGS = [
  // (1) long keys read directly off `flags` in main()/commands
  'project',
  'json',
  'all',
  'batch',
  'resume',
  'role',
  'task',
  'last',
  'since',
  'detailed',
  'report',
  'auto',
  'preserve',
  'force',
  'runs',
  'note',
  'port',
  'allow-dirty',
  'no-git-required',
  'allow-incomplete-scope',
  'spec-stdin',
  'include-failed',
  'skip-test-gate',
  'no-review',
  'no-tty',
  // (2) VALUE_LONG_FLAGS
  ...VALUE_LONG_FLAGS,
  // (3) dynamic-table members from park.js (RESOLVE_ACTIONS) and warnings.js (RESOLVE_VERBS)
  'requeue',
  'waive',
  'reject',
  'defer',
  'done',
  // (4) legacy FLAG_TO_COMMAND keys from suggest.js, without leading dashes
  'run',
  'status',
  'archive',
  'usage',
  'init',
  'health',
  'review',
  'version',
  'help',
];

// TC1: an unknown long flag (typo of --allow-incomplete-scope) throws, and
// the thrown message names the offending token.
test('TC1: parseArgs(["run","spec.md","--alow-incomplete-scope"]) throws naming the token', () => {
  assert.throws(
    () => parseArgs(['run', 'spec.md', '--alow-incomplete-scope']),
    (err) => err.message.includes('--alow-incomplete-scope')
  );
});

// TC2: an unknown short flag throws, and the thrown message names it.
test('TC2: parseArgs(["-z"]) throws naming "-z"', () => {
  assert.throws(
    () => parseArgs(['-z']),
    (err) => err.message.includes('-z')
  );
});

// TC3: an unknown character inside a combined short group throws, and the
// thrown message names the whole group token.
test('TC3: parseArgs(["-rz"]) throws naming "-rz" (unknown char in combined group)', () => {
  assert.throws(
    () => parseArgs(['-rz']),
    (err) => err.message.includes('-rz')
  );
});

// TC4: every long flag in the derived whitelist parses without throwing and
// lands in flags — value-taking flags land their supplied value, all others
// land `true`.
test('TC4: every whitelisted long flag parses without throwing and lands in flags', () => {
  for (const key of KNOWN_LONG_FLAGS) {
    if (VALUE_LONG_FLAGS.includes(key)) {
      const { flags } = parseArgs([`--${key}`, 'val']);
      assert.strictEqual(flags[key], 'val', `--${key} should land its value`);
    } else {
      const { flags } = parseArgs([`--${key}`]);
      assert.strictEqual(flags[key], true, `--${key} should land true`);
    }
  }
});

// TC5: short flags and combined short groups parse correctly, including the
// value-taking -p short flag when it is last in the group.
test('TC5: parseArgs(["-ra"]) yields r=true,a=true; parseArgs(["-rap","/tmp"]) yields p="/tmp"', () => {
  const ra = parseArgs(['-ra']);
  assert.strictEqual(ra.flags.r, true);
  assert.strictEqual(ra.flags.a, true);

  const rap = parseArgs(['-rap', '/tmp']);
  assert.strictEqual(rap.flags.r, true);
  assert.strictEqual(rap.flags.a, true);
  assert.strictEqual(rap.flags.p, '/tmp');
});

// TC6: value-taking long flags parse their supplied values.
test('TC6: value-taking long flags parse their values', () => {
  const cases = [
    [['--role', 'executor'], 'role', 'executor'],
    [['--project', '/tmp'], 'project', '/tmp'],
    [['--last', '3'], 'last', '3'],
    [['--since', '2026-01-01'], 'since', '2026-01-01'],
    [['--port', '3939'], 'port', '3939'],
    [['--note', 'text'], 'note', 'text'],
    [['--task', '001-001-001'], 'task', '001-001-001'],
    [['--resume', 'slug'], 'resume', 'slug'],
  ];
  for (const [args, key, expected] of cases) {
    const { flags } = parseArgs(args);
    assert.strictEqual(flags[key], expected, `${args.join(' ')} should set flags.${key} = ${expected}`);
  }
});

// TC7: dynamically-read table flags (park RESOLVE_ACTIONS, warnings
// RESOLVE_VERBS) each parse to true.
test('TC7: --requeue, --waive, --reject, --defer, --done each parse to true', () => {
  for (const key of ['requeue', 'waive', 'reject', 'defer', 'done']) {
    const { flags } = parseArgs([`--${key}`]);
    assert.strictEqual(flags[key], true, `--${key} should parse to true`);
  }
});

// TC8: legacy command flags (suggest.js FLAG_TO_COMMAND) each parse to true
// so main()'s 'Did you mean' routing stays reachable.
test('TC8: --review, --status, --archive, --usage, --version, --help each parse to true', () => {
  for (const key of ['review', 'status', 'archive', 'usage', 'version', 'help']) {
    const { flags } = parseArgs([`--${key}`]);
    assert.strictEqual(flags[key], true, `--${key} should parse to true`);
  }
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
