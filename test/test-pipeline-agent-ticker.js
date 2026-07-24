#!/usr/bin/env node
/**
 * test-pipeline-agent-ticker.js — Unit tests for Pipeline._startAgentTicker().
 *
 * TC1 — _startAgentTicker arms interval when statusBar.enabled=true
 * TC2 — _startAgentTicker does NOT arm when statusBar.enabled=false
 * TC3 — elapsed updates after tick for agent with startedAt
 * TC4 — agents without startedAt are skipped
 * TC5 — _startAgentTicker double-call is idempotent
 *
 * Run: node test/test-pipeline-agent-ticker.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

function createHarness() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-ticker-'));
  const harnessDir = path.join(projectRoot, '.harness');
  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify({
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {},
  }, null, 2));
  return projectRoot;
}

/**
 * Build a Pipeline instance, optionally mocking process.stdout.isTTY so that
 * StatusBar.enabled is set correctly at construction time.
 *
 * @param {object} opts
 * @param {boolean} [opts.mockTTY=false]   Temporarily set process.stdout.isTTY=true.
 * @param {boolean|undefined} [opts.statusBar]  Passed as opts.statusBar to Pipeline.
 * @returns {Pipeline}
 */
function buildPipeline({ mockTTY = false, statusBar } = {}) {
  const projectRoot = createHarness();

  // Temporarily mock isTTY so Pipeline sets statusBarEnabled correctly.
  const origDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  if (mockTTY) {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true, writable: true });
  }

  let pipeline;
  try {
    pipeline = new Pipeline(projectRoot, { statusBar });
  } finally {
    // Restore original isTTY immediately after construction.
    if (mockTTY) {
      if (origDescriptor) {
        Object.defineProperty(process.stdout, 'isTTY', origDescriptor);
      } else {
        delete process.stdout.isTTY;
      }
    }
  }

  // Remove signal handlers registered by the Pipeline constructor to avoid
  // EventEmitter maxListeners warnings when multiple pipelines are created.
  if (pipeline._signalHandlers) {
    process.off('SIGINT',  pipeline._signalHandlers.SIGINT);
    process.off('SIGTERM', pipeline._signalHandlers.SIGTERM);
    process.off('exit',    pipeline._signalHandlers.exit);
    process.removeListener('uncaughtException', pipeline._signalHandlers.uncaughtException);
  }

  // Replace updateAgent with a silent no-op to prevent ANSI writes to stdout
  // and to serve as a spy in tests that need to track calls.
  pipeline.statusBar._updateAgentCalls = [];
  const origUpdateAgent = pipeline.statusBar.updateAgent.bind(pipeline.statusBar);
  pipeline.statusBar.updateAgent = function (name, state) {
    pipeline.statusBar._updateAgentCalls.push({ name, state });
    // Still update the internal agents Map so the ticker logic works correctly.
    if (state == null) {
      pipeline.statusBar.agents.delete(name);
    } else {
      pipeline.statusBar.agents.set(name, state);
    }
    // Do NOT call _scheduleRender / write to stdout in tests.
  };

  return pipeline;
}

function cleanup(pipeline) {
  // Stop intervals and disable the status bar to silence any pending renders.
  if (pipeline._agentElapsedInterval !== null) {
    clearInterval(pipeline._agentElapsedInterval);
    pipeline._agentElapsedInterval = null;
  }
  if (pipeline._msElapsedInterval !== null) {
    clearInterval(pipeline._msElapsedInterval);
    pipeline._msElapsedInterval = null;
  }
  // Mark statusBar inert without writing ANSI teardown sequences.
  pipeline.statusBar.enabled = false;
}

// ── Tests ────────────────────────────────────────────────────────────────────

await test('TC1 _startAgentTicker arms interval when statusBar.enabled=true', async () => {
  const pipeline = buildPipeline({ mockTTY: true, statusBar: true });
  try {
    assert.strictEqual(pipeline.statusBar.enabled, true,
      'Precondition: statusBar.enabled should be true');
    assert.strictEqual(pipeline._agentElapsedInterval, null,
      'Precondition: interval should be null before _startAgentTicker');

    pipeline._startAgentTicker();

    assert.notStrictEqual(pipeline._agentElapsedInterval, null,
      '_agentElapsedInterval should be non-null after _startAgentTicker');
  } finally {
    cleanup(pipeline);
  }
});

await test('TC2 _startAgentTicker does NOT arm when statusBar.enabled=false', async () => {
  // statusBar:false → statusBarEnabled=false regardless of isTTY
  const pipeline = buildPipeline({ mockTTY: false, statusBar: false });
  try {
    assert.strictEqual(pipeline.statusBar.enabled, false,
      'Precondition: statusBar.enabled should be false');

    pipeline._startAgentTicker();

    assert.strictEqual(pipeline._agentElapsedInterval, null,
      '_agentElapsedInterval should remain null when statusBar.enabled=false');
  } finally {
    cleanup(pipeline);
  }
});

await test('TC3 elapsed updates after tick for agent with startedAt', async () => {
  const pipeline = buildPipeline({ mockTTY: true, statusBar: true });
  try {
    // Place an agent with a startedAt 5 seconds in the past so the first tick
    // will compute elapsed >= 5.
    const startedAt = Date.now() - 5000;
    pipeline.statusBar.agents.set('agent-A', { role: 'executor', startedAt });

    pipeline._startAgentTicker();

    // Wait for at least one tick (interval fires every 1000ms).
    await new Promise(resolve => setTimeout(resolve, 1100));

    const calls = pipeline.statusBar._updateAgentCalls.filter(c => c.name === 'agent-A');
    assert.ok(calls.length >= 1,
      `updateAgent should have been called at least once for agent-A; got ${calls.length}`);

    const lastCall = calls[calls.length - 1];
    assert.ok(lastCall.state.elapsed >= 1,
      `elapsed should be >= 1s; got ${lastCall.state.elapsed}`);
  } finally {
    cleanup(pipeline);
  }
});

await test('TC4 agents without startedAt are skipped', async () => {
  const pipeline = buildPipeline({ mockTTY: true, statusBar: true });
  try {
    // Agent with NO startedAt — ticker should skip it.
    pipeline.statusBar.agents.set('agent-B', { role: 'planner' }); // no startedAt

    pipeline._startAgentTicker();

    await new Promise(resolve => setTimeout(resolve, 1100));

    const calls = pipeline.statusBar._updateAgentCalls.filter(c => c.name === 'agent-B');
    assert.strictEqual(calls.length, 0,
      `updateAgent should NOT have been called for agent without startedAt; got ${calls.length}`);
  } finally {
    cleanup(pipeline);
  }
});

await test('TC5 _startAgentTicker double-call is idempotent', async () => {
  const pipeline = buildPipeline({ mockTTY: true, statusBar: true });
  try {
    pipeline._startAgentTicker();
    const firstInterval = pipeline._agentElapsedInterval;

    assert.notStrictEqual(firstInterval, null,
      'Interval should be set after first call');

    pipeline._startAgentTicker(); // second call — should be a no-op
    const secondInterval = pipeline._agentElapsedInterval;

    assert.strictEqual(firstInterval, secondInterval,
      'Second _startAgentTicker call should not replace the interval (same reference)');
  } finally {
    cleanup(pipeline);
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
