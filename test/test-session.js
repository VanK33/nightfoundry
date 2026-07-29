#!/usr/bin/env node

/**
 * Test: SessionManager — spawn a claude session via Agent SDK.
 * Requires: claude CLI installed and authenticated.
 * Opt-in: skipped unless CC_ORCH_REAL_SDK=1 is set (real Agent SDK session).
 */

import { SessionManager } from '../src/orchestrator/infra/session-manager.js';

async function main() {
  if (process.env.CC_ORCH_REAL_SDK !== '1') {
    console.log('  [SKIP] test-session.js requires a real Agent SDK session; set CC_ORCH_REAL_SDK=1 to run it.');
    process.exit(0);
  }

  const sm = new SessionManager();
  let passed = 0;
  let failed = 0;

  function assert(label, condition) {
    if (condition) {
      console.log(`  [PASS] ${label}`);
      passed++;
    } else {
      console.log(`  [FAIL] ${label}`);
      failed++;
    }
  }

  console.log('=== SessionManager Tests (Agent SDK) ===\n');

  // Test 1: Spawn a simple session
  console.log('Test 1: Spawn "say hello" session');
  try {
    const events = [];
    const spawnPromise = sm.spawn({
      name: 'test-hello',
      prompt: 'Say exactly "hello world" and nothing else.',
      tools: [],
    });

    spawnPromise.handle.on('message', (evt) => events.push(evt));

    const { handle, result } = await spawnPromise;

    assert('handle exists', !!handle);
    assert('handle has name', handle.name === 'test-hello');
    assert('handle is finished', handle.finished === true);
    assert('result exists', !!result);
    assert('events received', events.length > 0);
    assert('startedAt is ISO string', /^\d{4}-\d{2}-\d{2}/.test(handle.startedAt));
  } catch (err) {
    console.log(`  [FAIL] Session spawn threw: ${err.message}`);
    failed++;
  }

  // Test 2: Active sessions tracking
  console.log('\nTest 2: Active sessions');
  assert('no active sessions after completion', sm.active().length === 0);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
