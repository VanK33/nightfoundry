/**
 * test-ui-config-contract.js — Contract tests for the config.ui block.
 *
 * Asserts the notification webhook default is off (empty string) and the
 * siderail polling interval default and floor are correct.
 *
 * Run: node test/test-ui-config-contract.js
 */
import assert from 'assert';
import config from '../src/orchestrator/infra/config.js';

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

test("TC1: config.ui.notifyWebhookUrl === '' (notifications off by default)", () => {
  assert.strictEqual(config.ui.notifyWebhookUrl, '');
});

test('TC2: config.ui.siderailPollMs === 3000 (default)', () => {
  assert.strictEqual(config.ui.siderailPollMs, 3000);
});

test('TC3: config.ui.siderailPollMs >= 2000 (floor enforced)', () => {
  assert.ok(
    config.ui.siderailPollMs >= 2000,
    `siderailPollMs (${config.ui.siderailPollMs}) must be >= 2000`
  );
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
