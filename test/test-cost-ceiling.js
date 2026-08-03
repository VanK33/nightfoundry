/**
 * test-cost-ceiling.js — Unit tests for the per-run cumulative cost ceiling
 * gate on SessionManager.spawn()'s dispatch path.
 *
 * Covers:
 *   TC1: spend strictly over config.budgets.runCeilingUsd causes
 *        spawn() to throw CostCeilingExceededError, instanceof
 *        InfrastructureError, category 'cost-ceiling', retryable false,
 *        and the injected _queryFn is never called.
 *   TC2: spend exactly equal to the ceiling is likewise refused (the
 *        >= boundary).
 *   TC3: spend under the ceiling dispatches normally — the injected
 *        _queryFn IS called.
 *   TC4: .cc-orch.json budgets.runCeilingUsd loader validation — a
 *        positive finite number applies onto config.budgets.runCeilingUsd,
 *        literal null disables (applies null), and an invalid value or an
 *        unknown key inside budgets rejects fail-loud naming file + key.
 *        (Backs acceptance criterion 2 — the .cc-orch.json override path.)
 *
 * Hermeticity: every SessionManager under test has its _queryFn
 * replaced with a local async-generator fake that yields a result
 * event before any dispatch, so the real Agent SDK is never reached.
 * The loader cases use fs.mkdtemp fixture roots, never a live project.
 *
 * Run: node test/test-cost-ceiling.js
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager, InfrastructureError, CostCeilingExceededError } from '../src/orchestrator/infra/session-manager.js';
import { loadProjectConfig } from '../src/orchestrator/infra/project-config.js';
import config from '../src/orchestrator/infra/config.js';

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

/**
 * makeFakeTracker(totalCostUsd) — returns a minimal fake TokenTracker whose
 * getTotalUsage() reports the given cumulative spend. This is the only
 * field the cost-ceiling gate reads.
 */
function makeFakeTracker(totalCostUsd) {
  return {
    getTotalUsage() {
      return { totalCostUsd };
    },
  };
}

/**
 * Build a SessionManager whose _queryFn is a hermetic fake async generator
 * that yields a single result event before any dispatch, so the real SDK
 * is never reached. Also tracks whether the fake was ever called.
 */
function makeSessionManagerWithFakeQuery() {
  const sm = new SessionManager();
  const callTracker = { called: false };
  sm._queryFn = async function* fakeQuery(_options) {
    callTracker.called = true;
    yield {
      type: 'result',
      is_error: false,
      result: 'ok',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  };
  return { sm, callTracker };
}

// --- TC1: over-ceiling spend → spawn() throws CostCeilingExceededError ---
await test("TC1: over-ceiling spend causes spawn() to throw CostCeilingExceededError, instanceof InfrastructureError, category 'cost-ceiling', retryable false, _queryFn not called", async () => {
  const originalCeiling = config.budgets.runCeilingUsd;
  try {
    config.budgets.runCeilingUsd = 10;
    const { sm, callTracker } = makeSessionManagerWithFakeQuery();
    sm.setTokenTracker(makeFakeTracker(11)); // strictly over the 10 ceiling

    let thrownErr = null;
    try {
      await sm.spawn({ prompt: 'test prompt', name: 'tc1-cost-ceiling-test' });
    } catch (err) {
      thrownErr = err;
    }

    assert.ok(thrownErr !== null, 'Expected spawn() to reject, but it resolved');
    assert.ok(
      thrownErr instanceof CostCeilingExceededError,
      `Expected CostCeilingExceededError, got ${thrownErr?.constructor?.name}: ${thrownErr?.message}`
    );
    assert.ok(
      thrownErr instanceof InfrastructureError,
      'Expected CostCeilingExceededError to be instanceof InfrastructureError'
    );
    assert.strictEqual(thrownErr.category, 'cost-ceiling', `Expected category 'cost-ceiling', got '${thrownErr.category}'`);
    assert.strictEqual(thrownErr.retryable, false, `Expected retryable === false, got ${thrownErr.retryable}`);
    assert.strictEqual(callTracker.called, false, 'Expected _queryFn to never be called, but it was called');
  } finally {
    config.budgets.runCeilingUsd = originalCeiling;
  }
});

// --- TC2: spend === ceiling → refused (>= boundary) ---
await test('TC2: spend exactly equal to the ceiling is refused (>= boundary)', async () => {
  const originalCeiling = config.budgets.runCeilingUsd;
  try {
    config.budgets.runCeilingUsd = 10;
    const { sm, callTracker } = makeSessionManagerWithFakeQuery();
    sm.setTokenTracker(makeFakeTracker(10)); // exactly equal to the ceiling

    let thrownErr = null;
    try {
      await sm.spawn({ prompt: 'test prompt', name: 'tc2-cost-ceiling-test' });
    } catch (err) {
      thrownErr = err;
    }

    assert.ok(thrownErr !== null, 'Expected spawn() to reject, but it resolved');
    assert.ok(
      thrownErr instanceof CostCeilingExceededError,
      `Expected CostCeilingExceededError, got ${thrownErr?.constructor?.name}: ${thrownErr?.message}`
    );
    assert.ok(
      thrownErr instanceof InfrastructureError,
      'Expected CostCeilingExceededError to be instanceof InfrastructureError'
    );
    assert.strictEqual(thrownErr.category, 'cost-ceiling', `Expected category 'cost-ceiling', got '${thrownErr.category}'`);
    assert.strictEqual(thrownErr.retryable, false, `Expected retryable === false, got ${thrownErr.retryable}`);
    assert.strictEqual(callTracker.called, false, 'Expected _queryFn to never be called, but it was called');
  } finally {
    config.budgets.runCeilingUsd = originalCeiling;
  }
});

// --- TC3: spend < ceiling → dispatch proceeds, injected _queryFn called ---
await test('TC3: spend under the ceiling dispatches — injected _queryFn is called', async () => {
  const originalCeiling = config.budgets.runCeilingUsd;
  try {
    config.budgets.runCeilingUsd = 10;
    const { sm, callTracker } = makeSessionManagerWithFakeQuery();
    sm.setTokenTracker(makeFakeTracker(5)); // strictly under the ceiling

    let thrownErr = null;
    try {
      await sm.spawn({ prompt: 'test prompt', name: 'tc3-cost-ceiling-test' });
    } catch (err) {
      thrownErr = err;
    }

    assert.strictEqual(thrownErr, null, `Expected spawn() to resolve, but it threw: ${thrownErr?.message}`);
    assert.strictEqual(callTracker.called, true, 'Expected _queryFn to be called, but it was not');
  } finally {
    config.budgets.runCeilingUsd = originalCeiling;
  }
});

// --- TC4: .cc-orch.json loader validation for budgets.runCeilingUsd ---

/** Fresh temp fixture dir; caller writes .cc-orch.json into it. */
function makeFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cost-ceiling-config-'));
}
function writeConfig(dir, contents) {
  fs.writeFileSync(path.join(dir, '.cc-orch.json'), contents);
}

await test('TC4a: budgets.runCeilingUsd = positive number → applied onto config', async () => {
  const original = config.budgets.runCeilingUsd;
  const fixture = makeFixture();
  try {
    writeConfig(fixture, JSON.stringify({ budgets: { runCeilingUsd: 123 } }));
    loadProjectConfig(fixture);
    assert.strictEqual(config.budgets.runCeilingUsd, 123, 'positive number should apply onto config.budgets.runCeilingUsd');
  } finally {
    config.budgets.runCeilingUsd = original;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

await test('TC4b: budgets.runCeilingUsd = null → disables (applies null)', async () => {
  const original = config.budgets.runCeilingUsd;
  const fixture = makeFixture();
  try {
    writeConfig(fixture, JSON.stringify({ budgets: { runCeilingUsd: null } }));
    loadProjectConfig(fixture);
    assert.strictEqual(config.budgets.runCeilingUsd, null, 'literal null should disable the ceiling');
  } finally {
    config.budgets.runCeilingUsd = original;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

await test('TC4c: invalid budgets.runCeilingUsd (0 / negative / string) rejects fail-loud naming file + key; config unmutated', async () => {
  const original = config.budgets.runCeilingUsd;
  for (const bad of [0, -5, 'lots', true]) {
    const fixture = makeFixture();
    try {
      writeConfig(fixture, JSON.stringify({ budgets: { runCeilingUsd: bad } }));
      assert.throws(
        () => loadProjectConfig(fixture),
        (err) => err instanceof Error
          && err.message.includes(path.join(fixture, '.cc-orch.json'))
          && /runCeilingUsd/.test(err.message),
        `value ${JSON.stringify(bad)} should reject naming the file and the key`
      );
      assert.strictEqual(config.budgets.runCeilingUsd, original, 'config must be unmutated after a rejected load');
    } finally {
      config.budgets.runCeilingUsd = original;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }
});

await test('TC4d: unknown key inside budgets rejects fail-loud naming file + key', async () => {
  const original = config.budgets.runCeilingUsd;
  const fixture = makeFixture();
  try {
    writeConfig(fixture, JSON.stringify({ budgets: { bogusKey: 5 } }));
    assert.throws(
      () => loadProjectConfig(fixture),
      (err) => err instanceof Error
        && err.message.includes(path.join(fixture, '.cc-orch.json'))
        && /bogusKey/.test(err.message),
      'an unknown key inside budgets should reject naming the file and the key'
    );
  } finally {
    config.budgets.runCeilingUsd = original;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// --- Summary ---
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
