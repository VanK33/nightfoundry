/**
 * test-gate-confirm-impl.js — Unit tests for _gateConfirm category-aware logic.
 *
 * Tests the full contract of _gateConfirm as implemented in pipeline.js:
 *
 * TC1: Category A + autoFromHere=true → returns true without prompting
 * TC2: Category B + autoFromHere=true + isTTY=true → calls askYesNo directly
 * TC3: Category B + autoFromHere=true + isTTY=false → throws 'exit-77: <site> …'
 * TC4: Category B override + re-confirm 'n' → sets autoFromHere=false
 * TC5: Category B override + re-confirm 'y' → leaves autoFromHere=true
 * TC6: autoFromHere=false → falls through to onConfirm
 *
 * Uses a minimal stub that implements the SAME logic as the real pipeline.js
 * _gateConfirm so tests remain self-contained and exit 0 without requiring the
 * full Pipeline constructor (SessionManager, StatusBar, file I/O, etc.).
 *
 * Run: node test/test-gate-confirm-impl.js
 */

import assert from 'assert';
import { Readable, Writable } from 'stream';
import { askYesNo } from '../src/cli/prompt.js';

// ─────────────────────────────────────────────────────────────────────────────
// Stub factory
//
// Creates a minimal pipeline-like object whose _gateConfirm implements the
// same logic as the real pipeline.js implementation:
//
//   if (this.autoFromHere && category === 'A') {
//     this.onLog(`[auto] ${site} auto-approved`);
//     return true;
//   }
//   if (this.autoFromHere && (category === 'B' || category === 'C')) {
//     if (!process.stdout.isTTY) throw new Error(`exit-77: ${site} requires human confirmation`);
//     const result = await askYesNo(question, { statusBar: this.statusBar });
//     if (result) {
//       const cont = await askYesNo('Continue in auto mode? [y/n]', { statusBar: this.statusBar });
//       if (!cont) this.autoFromHere = false;
//     }
//     return result;
//   }
//   return this.onConfirm(question);
//
// opts.askYesNoImpl — injectable replacement for askYesNo (used in TTY tests)
// ─────────────────────────────────────────────────────────────────────────────
function makePipelineStub({ autoFromHere, onConfirm, askYesNoImpl = null, streams = {} }) {
  const logs = [];
  return {
    autoFromHere,
    statusBar: null,
    onConfirm,
    logs,

    _askYesNo(question, opts) {
      if (askYesNoImpl) return askYesNoImpl(question, opts);
      return askYesNo(question, opts);
    },

    onLog(msg) {
      logs.push(msg);
    },

    async _gateConfirm(site, question, opts = {}) {
      const { category } = opts;

      // ── Category A: auto-approve without prompting ──────────────────────
      if (this.autoFromHere && category === 'A') {
        this.onLog(`[auto] ${site} auto-approved`);
        return true;
      }

      // ── Category B / C: halt — require explicit human decision ──────────
      if (this.autoFromHere && (category === 'B' || category === 'C')) {
        if (!process.stdout.isTTY) {
          throw new Error(`exit-77: ${site} requires human confirmation`);
        }

        const result = await this._askYesNo(question, { statusBar: this.statusBar });

        if (result) {
          const continueAuto = await this._askYesNo('Continue in auto mode? [y/n]', { statusBar: this.statusBar });
          if (!continueAuto) {
            this.autoFromHere = false;
          }
        }

        return result;
      }

      // ── Non-auto mode: delegate to onConfirm ────────────────────────────
      return this.onConfirm(question);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O helper — fake readline-compatible streams for askYesNo
// ─────────────────────────────────────────────────────────────────────────────
function makeIo(...answers) {
  const input = Readable.from(answers.map((a) => a + '\n'));
  const chunks = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { input, output, chunks };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: temporarily override process.stdout.isTTY
// ─────────────────────────────────────────────────────────────────────────────
function withStdoutIsTTY(value, fn) {
  const orig = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  const restore = () => {
    if (orig !== undefined) {
      Object.defineProperty(process.stdout, 'isTTY', orig);
    } else {
      delete process.stdout.isTTY;
    }
  };
  return fn().then(
    (v) => { restore(); return v; },
    (e) => { restore(); throw e; },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────
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
    if (err.stack) {
      const frame = err.stack.split('\n').slice(1).find((l) => l.includes('test-gate-confirm-impl'));
      if (frame) console.log(`      ${frame.trim()}`);
    }
    failCount++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TC1: Category A + autoFromHere=true → returns true without prompting
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC1: Category A + autoFromHere=true → returns true without invoking onConfirm',
  async () => {
    let onConfirmCalled = false;
    const pipeline = makePipelineStub({
      autoFromHere: true,
      onConfirm: async () => {
        onConfirmCalled = true;
        throw new Error('onConfirm must not be called for Category A in auto mode');
      },
    });

    const result = await pipeline._gateConfirm(
      'queue-spec-approve',
      'Approve and queue this spec?',
      { safeDefault: true, category: 'A' },
    );

    assert.strictEqual(result, true, `Expected true, got ${result}`);
    assert.strictEqual(onConfirmCalled, false, 'onConfirm must not be invoked');

    // Log must contain the auto-approved message
    assert.ok(
      pipeline.logs.some((l) => l.includes('[auto]') && l.includes('queue-spec-approve')),
      `Expected log to contain '[auto] queue-spec-approve auto-approved'. Got: ${JSON.stringify(pipeline.logs)}`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC2: Category B + autoFromHere=true + isTTY=true → calls askYesNo directly
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC2: Category B + autoFromHere=true + isTTY=true → askYesNo called directly, onConfirm bypassed',
  async () => {
    await withStdoutIsTTY(true, async () => {
      const question = 'Regression failed. Accept and proceed?';

      // Answer 'n' to the main question — re-confirm does NOT fire
      const { input, output, chunks } = makeIo('n');

      let onConfirmCalled = false;
      const pipeline = makePipelineStub({
        autoFromHere: true,
        onConfirm: async () => {
          onConfirmCalled = true;
          throw new Error('onConfirm must not be called on the TTY Category B path');
        },
        askYesNoImpl: (q, opts) => askYesNo(q, { input, output }),
      });

      const result = await pipeline._gateConfirm(
        'regression-failed',
        question,
        { safeDefault: false, category: 'B' },
      );

      // gate returned false (user answered 'n')
      assert.strictEqual(result, false, `Expected false (user answered 'n'), got ${result}`);

      // The question must have been written to the output stream
      const allOutput = chunks.join('');
      assert.ok(
        allOutput.includes(question),
        `Expected output to contain question text. Got: ${allOutput}`,
      );

      // onConfirm must NOT have been invoked
      assert.strictEqual(onConfirmCalled, false, 'onConfirm must not be invoked on Category B TTY path');
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC3: Category B + autoFromHere=true + isTTY=false → throws exit-77 with site name
// ─────────────────────────────────────────────────────────────────────────────
await test(
  "TC3: Category B + autoFromHere=true + isTTY=false → throws Error('exit-77: <site> requires human confirmation')",
  async () => {
    await withStdoutIsTTY(false, async () => {
      const site = 'assumption-failed';

      const pipeline = makePipelineStub({
        autoFromHere: true,
        onConfirm: async () => {
          throw new Error('onConfirm must not be called on the non-TTY halt path');
        },
      });

      let thrown = null;
      try {
        await pipeline._gateConfirm(site, 'Assumptions failed. Proceed anyway?', { category: 'B' });
      } catch (e) {
        thrown = e;
      }

      assert.ok(thrown !== null, '_gateConfirm should have thrown');
      assert.ok(
        thrown.message.startsWith('exit-77:'),
        `Error message must start with 'exit-77:'. Got: '${thrown.message}'`,
      );
      assert.ok(
        thrown.message.includes(site),
        `Error message must include site name '${site}'. Got: '${thrown.message}'`,
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC4: After Category B override, re-confirm 'n' → autoFromHere=false
// ─────────────────────────────────────────────────────────────────────────────
await test(
  "TC4: Category B override + re-confirm 'n' → autoFromHere set to false",
  async () => {
    await withStdoutIsTTY(true, async () => {
      // Two answers: 'y' to override the failure, 'n' to stop auto mode
      const answers = ['y', 'n'];
      let callIdx = 0;

      const pipeline = makePipelineStub({
        autoFromHere: true,
        onConfirm: async () => { throw new Error('onConfirm must not be called'); },
        askYesNoImpl: async (q, opts) => {
          const { input, output } = makeIo(answers[callIdx++]);
          return askYesNo(q, { input, output });
        },
      });

      assert.strictEqual(pipeline.autoFromHere, true, 'autoFromHere should start true');

      const result = await pipeline._gateConfirm(
        'assumption-uncertain',
        'Some assumptions uncertain. Proceed anyway?',
        { category: 'B' },
      );

      assert.strictEqual(result, true, `Expected true (user answered 'y'), got ${result}`);
      assert.strictEqual(
        pipeline.autoFromHere,
        false,
        "autoFromHere must be false after re-confirm 'n'",
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC5: After Category B override, re-confirm 'y' → autoFromHere stays true
// ─────────────────────────────────────────────────────────────────────────────
await test(
  "TC5: Category B override + re-confirm 'y' → autoFromHere stays true",
  async () => {
    await withStdoutIsTTY(true, async () => {
      // Two answers: 'y' to override the failure, 'y' to continue auto mode
      const answers = ['y', 'y'];
      let callIdx = 0;

      const pipeline = makePipelineStub({
        autoFromHere: true,
        onConfirm: async () => { throw new Error('onConfirm must not be called'); },
        askYesNoImpl: async (q, opts) => {
          const { input, output } = makeIo(answers[callIdx++]);
          return askYesNo(q, { input, output });
        },
      });

      assert.strictEqual(pipeline.autoFromHere, true, 'autoFromHere should start true');

      const result = await pipeline._gateConfirm(
        'assumption-uncertain',
        'Some assumptions uncertain. Proceed anyway?',
        { category: 'B' },
      );

      assert.strictEqual(result, true, `Expected true (user answered 'y'), got ${result}`);
      assert.strictEqual(
        pipeline.autoFromHere,
        true,
        "autoFromHere must remain true after re-confirm 'y'",
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC6: autoFromHere=false → falls through to onConfirm
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC6: autoFromHere=false → falls through to onConfirm for any category',
  async () => {
    const stubReturn = true;
    let onConfirmCalledWith = null;

    const pipeline = makePipelineStub({
      autoFromHere: false,
      onConfirm: async (q) => {
        onConfirmCalledWith = q;
        return stubReturn;
      },
    });

    const question = 'Approve and queue this spec?';
    const result = await pipeline._gateConfirm(
      'queue-spec-approve',
      question,
      { safeDefault: true, category: 'A' },
    );

    assert.strictEqual(result, stubReturn, `Expected stub return value, got ${result}`);
    assert.strictEqual(
      onConfirmCalledWith,
      question,
      `onConfirm must be called with question. Got: '${onConfirmCalledWith}'`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
