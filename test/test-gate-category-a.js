/**
 * test-gate-category-a.js — Unit tests for _gateConfirm Category A bypass logic.
 *
 * Category A gates (e.g. 'queue-spec-approve', 'mission-approve-*') MUST
 * auto-resolve to opts.safeDefault when pipeline.autoFromHere === true,
 * WITHOUT invoking this.onConfirm.  When autoFromHere === false the gate
 * MUST delegate to this.onConfirm exactly as before.
 *
 * Uses a real Pipeline instance (bootstrapped temp dir) to verify the contract.
 *
 * TC1: autoFromHere=true + safeDefault:true  → returns true,  onConfirm never invoked
 * TC2: autoFromHere=true + safeDefault:false → returns false, onConfirm never invoked
 * TC3: autoFromHere=false                    → delegates to onConfirm, resolves stub value
 * TC4: consecutive Cat-A calls both auto-resolve without state corruption
 *
 * Run: node test/test-gate-category-a.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');
const { bootstrap } = await import('../src/orchestrator/core/bootstrap.js');

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

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline factory
//
// Creates a real Pipeline instance backed by a bootstrapped temp directory.
// onConfirm on the instance is overridden directly so tests can control and
// track calls without the constructor wrapper.
// ─────────────────────────────────────────────────────────────────────────────
function makePipeline({ onConfirm } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gate-cat-a-'));
  bootstrap(tmpDir, {});

  const pipeline = new Pipeline(tmpDir, {
    onLog: () => {},
    onConfirm: async () => false,
  });

  // Override the wrapped onConfirm directly when the test needs to control it.
  if (onConfirm !== undefined) {
    pipeline.onConfirm = onConfirm;
  }

  return {
    pipeline,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TC1: autoFromHere=true, safeDefault:true → returns true without calling onConfirm
// ─────────────────────────────────────────────────────────────────────────────
await test(
  "TC1: autoFromHere=true + safeDefault:true → returns true, onConfirm not invoked",
  async () => {
    let onConfirmInvoked = false;

    const { pipeline, cleanup } = makePipeline({
      onConfirm: async () => {
        onConfirmInvoked = true;
        throw new Error('onConfirm must not be called in auto mode for Category A');
      },
    });

    try {
      pipeline.autoFromHere = true;

      const result = await pipeline._gateConfirm(
        'queue-spec-approve',
        'Approve and queue this spec?',
        { safeDefault: true, category: 'A' },
      );

      assert.strictEqual(result, true,
        `Expected true (safeDefault), got ${result}`);
      assert.strictEqual(onConfirmInvoked, false,
        'onConfirm must not be invoked when autoFromHere=true (Category A)');
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC2: autoFromHere=true, safeDefault:false → returns false without calling onConfirm
// ─────────────────────────────────────────────────────────────────────────────
await test(
  "TC2: autoFromHere=true + safeDefault:false → returns false, onConfirm not invoked",
  async () => {
    let onConfirmInvoked = false;

    const { pipeline, cleanup } = makePipeline({
      onConfirm: async () => {
        onConfirmInvoked = true;
        throw new Error('onConfirm must not be called in auto mode for Category A');
      },
    });

    try {
      pipeline.autoFromHere = true;

      const result = await pipeline._gateConfirm(
        'queue-spec-approve',
        'Approve and queue this spec?',
        { safeDefault: false, category: 'A' },
      );

      assert.strictEqual(result, false,
        `Expected false (safeDefault), got ${result}`);
      assert.strictEqual(onConfirmInvoked, false,
        'onConfirm must not be invoked when autoFromHere=true (Category A)');
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC3: autoFromHere=false → delegates to onConfirm, resolves with stub's value
//      (Category A bypass is auto-mode only)
// ─────────────────────────────────────────────────────────────────────────────
await test(
  "TC3: autoFromHere=false → delegates to onConfirm, resolves with stub value",
  async () => {
    const stubReturnValue = true;
    let onConfirmInvoked = false;

    const { pipeline, cleanup } = makePipeline({
      onConfirm: async (_question) => {
        onConfirmInvoked = true;
        return stubReturnValue;
      },
    });

    try {
      pipeline.autoFromHere = false;

      const result = await pipeline._gateConfirm(
        'queue-spec-approve',
        'Approve and queue this spec?',
        { safeDefault: true, category: 'A' },
      );

      assert.strictEqual(result, stubReturnValue,
        `Expected stub return value (${stubReturnValue}), got ${result}`);
      assert.strictEqual(onConfirmInvoked, true,
        'onConfirm must be invoked when autoFromHere=false (interactive mode)');
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC4: consecutive Cat-A calls both auto-resolve without state corruption
//      After the first auto-resolve, the pipeline must not carry any state
//      that would prevent the second call from also auto-resolving.
// ─────────────────────────────────────────────────────────────────────────────
await test(
  "TC4: consecutive Cat-A calls both auto-resolve without state corruption",
  async () => {
    let onConfirmInvoked = false;

    const { pipeline, cleanup } = makePipeline({
      onConfirm: async () => {
        onConfirmInvoked = true;
        throw new Error('onConfirm must not be called in auto mode for Category A');
      },
    });

    try {
      pipeline.autoFromHere = true;

      // First call
      const result1 = await pipeline._gateConfirm(
        'queue-spec-approve',
        'Approve and queue this spec?',
        { safeDefault: true, category: 'A' },
      );

      assert.strictEqual(result1, true,
        `First call: expected true (safeDefault), got ${result1}`);
      assert.strictEqual(onConfirmInvoked, false,
        'onConfirm must not be invoked on the first Cat-A call');

      // Second consecutive call — must also auto-resolve
      const result2 = await pipeline._gateConfirm(
        'mission-approve-scheduler',
        'Proceed with mission 001-001?',
        { safeDefault: true, category: 'A' },
      );

      assert.strictEqual(result2, true,
        `Second call: expected true (safeDefault), got ${result2}`);
      assert.strictEqual(onConfirmInvoked, false,
        'onConfirm must not be invoked on the second Cat-A call (no state corruption)');
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
