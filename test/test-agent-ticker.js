#!/usr/bin/env node

/**
 * test-agent-ticker.js — Unit tests for _startAgentTicker / _stopAgentTicker
 * added to Pipeline in task 001-002-001-001.
 *
 * Uses Object.create(Pipeline.prototype) to exercise the new methods
 * without invoking the heavy constructor.
 *
 * Run: node test/test-agent-ticker.js
 */

import assert from 'assert';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';

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

// ── Helpers ───────────────────────────────────────────────────────────────

function makeMockStatusBar({ enabled = true } = {}) {
  const updateCalls = [];
  const agents = new Map();
  return {
    enabled,
    agents,
    updateAgent(name, state) {
      updateCalls.push({ name, state });
      if (state === null || state === undefined) agents.delete(name);
      else agents.set(name, state);
    },
    _updateCalls: updateCalls,
    // No-op stubs for other methods pipeline may call
    updateProgress: () => {},
    updateMilestone: () => {},
    setPhase: () => {},
    hide: () => {},
    show: () => {},
    teardown: () => {},
    destroy: () => {},
    promptWillStart: () => {},
    promptDidEnd: () => {},
  };
}

function makeStub(overrides = {}) {
  const stub = Object.create(Pipeline.prototype);
  stub._agentElapsedInterval = null;
  stub.statusBar = makeMockStatusBar();
  Object.assign(stub, overrides);
  return stub;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ─────────────────────────────────────────────────────────────────

await test('_startAgentTicker arms interval when statusBar.enabled=true', async () => {
  const stub = makeStub({ statusBar: makeMockStatusBar({ enabled: true }) });
  stub._startAgentTicker();
  try {
    assert.notStrictEqual(stub._agentElapsedInterval, null, 'interval should be set');
  } finally {
    stub._stopAgentTicker();
  }
});

await test('_startAgentTicker does NOT arm when statusBar.enabled=false', async () => {
  const stub = makeStub({ statusBar: makeMockStatusBar({ enabled: false }) });
  stub._startAgentTicker();
  assert.strictEqual(stub._agentElapsedInterval, null, 'interval should remain null when disabled');
});

await test('elapsed updates after tick for agent with startedAt', async () => {
  const sb = makeMockStatusBar({ enabled: true });
  const startedAt = Date.now() - 2000; // 2 seconds ago
  sb.agents.set('executor', { role: 'executor', status: 'active', startedAt });

  const stub = makeStub({ statusBar: sb });
  stub._startAgentTicker();

  try {
    // Wait longer than one tick interval (1000ms)
    await sleep(1200);
    const updateForExecutor = sb._updateCalls.find((c) => c.name === 'executor');
    assert.ok(updateForExecutor, 'updateAgent should have been called for executor');
    assert.ok(
      typeof updateForExecutor.state.elapsed === 'number' && updateForExecutor.state.elapsed >= 1,
      `elapsed should be >= 1 second, got: ${updateForExecutor.state?.elapsed}`
    );
  } finally {
    stub._stopAgentTicker();
  }
});

await test('agents without startedAt are skipped', async () => {
  const sb = makeMockStatusBar({ enabled: true });
  // Agent with NO startedAt
  sb.agents.set('planner', { role: 'planner', status: 'active' });

  const stub = makeStub({ statusBar: sb });
  stub._startAgentTicker();

  try {
    await sleep(1200);
    // No updateAgent call should have been made for 'planner'
    const callsForPlanner = sb._updateCalls.filter((c) => c.name === 'planner');
    assert.strictEqual(callsForPlanner.length, 0, 'planner without startedAt should not be ticked');
  } finally {
    stub._stopAgentTicker();
  }
});

await test('_startAgentTicker double-call is idempotent (interval not duplicated)', async () => {
  const stub = makeStub({ statusBar: makeMockStatusBar({ enabled: true }) });

  stub._startAgentTicker();
  const first = stub._agentElapsedInterval;
  stub._startAgentTicker(); // second call — should be a no-op
  const second = stub._agentElapsedInterval;

  stub._stopAgentTicker();

  assert.strictEqual(first, second, 'interval reference should be identical after double-call');
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
