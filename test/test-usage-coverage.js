import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KNOWN_COMMANDS } from '../src/cli/suggest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Extract USAGE block from src/cli/index.js
const cliSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'cli', 'index.js'),
  'utf8'
);

// Extract content between const USAGE = ` ... `
const usageMatch = cliSource.match(/const USAGE\s*=\s*`([\s\S]*?)`\s*;/);
assert.ok(usageMatch, 'Could not extract USAGE block from src/cli/index.js');
const USAGE = usageMatch[1];

// ---------- TC1: KNOWN_COMMANDS entries appear in USAGE ----------

test('TC1 KNOWN_COMMANDS entries appear in USAGE', () => {
  const skip = new Set(['version', 'help']);
  for (const cmd of KNOWN_COMMANDS) {
    if (skip.has(cmd)) continue;
    assert.ok(
      USAGE.includes('cc-orch ' + cmd),
      `Missing command in USAGE: 'cc-orch ${cmd}'`
    );
  }
});

// ---------- TC2: REQUIRED_SUBCOMMANDS appear in USAGE ----------

const REQUIRED_SUBCOMMANDS = [
  'archive list',
  'archive show',
  'archive diff',
  'usage compare',
  'queue list',
  'queue remove',
  'dispersion compare',
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
