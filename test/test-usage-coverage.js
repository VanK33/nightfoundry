import assert from 'assert';
import { KNOWN_COMMANDS } from '../src/cli/suggest.js';
import { renderUsage } from '../src/cli/index.js';

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

// Render the templated USAGE text directly, rather than extracting it via
// source regex.
const USAGE = renderUsage('nightfoundry');

// ---------- TC1: KNOWN_COMMANDS entries appear in USAGE ----------

test('TC1 KNOWN_COMMANDS entries appear in USAGE', () => {
  const skip = new Set(['version', 'help']);
  for (const cmd of KNOWN_COMMANDS) {
    if (skip.has(cmd)) continue;
    assert.ok(
      USAGE.includes('nightfoundry ' + cmd),
      `Missing command in USAGE: 'nightfoundry ${cmd}'`
    );
  }
});

// ---------- TC2: REQUIRED_SUBCOMMANDS appear in USAGE ----------

// archive */dispersion compare entries removed with their verbs (v0.2 removal stage 2)
const REQUIRED_SUBCOMMANDS = [
  'usage compare',
  'queue list',
  'queue remove',
  'queue retry',
  'park list',
  'park show',
  'park resolve',
];

test('TC2 REQUIRED_SUBCOMMANDS appear in USAGE', () => {
  for (const sub of REQUIRED_SUBCOMMANDS) {
    assert.ok(
      USAGE.includes(sub),
      `Missing subcommand in USAGE: '${sub}'`
    );
  }
});

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
