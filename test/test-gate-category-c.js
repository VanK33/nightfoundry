/**
 * test-gate-category-c.js — Unit tests for _gateMenu Category C free-text logic.
 *
 * Category C gates represent free-text menu prompts (options=null/[]) where the
 * user must type an arbitrary string (e.g. a filename).  Under auto mode
 * (autoFromHere=true):
 *   - TTY:     MUST call askMenu in free-text mode (options=null) and return the
 *              user-typed string, verified via input/output stub streams.
 *   - non-TTY: MUST throw HaltError with .site and .reason set from call args,
 *              because free-text input cannot be safely auto-defaulted.
 *
 * When autoFromHere=false the gate MUST delegate to this.onMenu unchanged.
 *
 * Uses a real Pipeline instance (same pattern as test-gate-category-b.js).
 *
 * TC1: autoFromHere=true, isTTY=true, category 'C' — _gateMenu calls askMenu in
 *       free-text mode and returns the user-typed string (verified via
 *       input/output stub streams).
 *
 * TC2: autoFromHere=true, isTTY=false, category 'C' — _gateMenu throws
 *       HaltError(site='review-gate-file-diff', reason matches the spec text).
 *
 * TC3: autoFromHere=false — delegates to this.onMenu unchanged.
 *
 * Run: node test/test-gate-category-c.js
 */

import assert from 'assert';
import { Readable, Writable, PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { askMenu } from '../src/cli/prompt.js';

const { Pipeline, HaltError } = await import('../src/orchestrator/core/pipeline.js');
const { bootstrap } = await import('../src/orchestrator/core/bootstrap.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Prototype verification
// ─────────────────────────────────────────────────────────────────────────────
if (typeof Pipeline.prototype._gateMenu !== 'function') {
  console.error('FATAL: Pipeline.prototype._gateMenu is missing — tests will fail.');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline factory
//
// Creates a real Pipeline instance backed by a bootstrapped temp directory.
// autoFromHere and onMenu are set directly on the instance so tests can control
// them. _streams is set for I/O injection so askMenu reads from/writes to
// in-memory streams rather than the real terminal.
// ─────────────────────────────────────────────────────────────────────────────
function makePipeline({ autoFromHere = false, onMenu = null, streams = {} } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gate-cat-c-'));
  bootstrap(tmpDir, {});

  const pipeline = new Pipeline(tmpDir, {
    onLog: () => {},
    onConfirm: async () => false,
  });

  // Set autoFromHere directly (constructor always starts it as false).
  pipeline.autoFromHere = autoFromHere;

  // Override onMenu directly when the test needs to control it.
  if (onMenu !== null) {
    pipeline.onMenu = onMenu;
  }

  // _streams is used by Pipeline.prototype._gateMenu to inject I/O in tests.
  pipeline._streams = streams;

  // Replace the real StatusBar with a minimal no-op so statusBar.teardown() /
  // promptWillStart() / promptDidEnd() calls succeed without terminal side-effects.
  pipeline.statusBar = {
    teardown: () => {},
    destroy: () => {},
    promptWillStart: () => {},
    promptDidEnd: () => {},
  };

  return {
    pipeline,
    cleanup: () => {
      // Remove the process signal handlers registered by the Pipeline constructor
      // to prevent listener leaks across multiple Pipeline instances in tests.
      const { _signalHandlers: h } = pipeline;
      if (h) {
        process.off('SIGINT', h.SIGINT);
        process.off('SIGTERM', h.SIGTERM);
        process.off('exit', h.exit);
        process.removeListener('uncaughtException', h.uncaughtException);
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a (input, output) pair backed by in-memory streams.
 * answers — strings that will be fed to readline as successive lines
 *           (one per rl.question call; newlines are appended automatically).
 */
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
      const frame = err.stack.split('\n').slice(1).find((l) => l.includes('test-gate-category-c'));
      if (frame) console.log(`      ${frame.trim()}`);
    }
    failCount++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: set process.stdin.isTTY via property descriptor and restore after
// ─────────────────────────────────────────────────────────────────────────────
function withStdinIsTTY(value, fn) {
  const orig = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  const restore = () => {
    if (orig !== undefined) {
      Object.defineProperty(process.stdin, 'isTTY', orig);
    } else {
      delete process.stdin.isTTY;
    }
  };
  return fn().then(
    (v) => { restore(); return v; },
    (e) => { restore(); throw e; },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TC1: autoFromHere=true, isTTY=true, category='C'
//       → _gateMenu calls askMenu in free-text mode, returns user-typed string
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC1: autoFromHere=true + isTTY=true + category=C → askMenu free-text returns user-typed string',
  async () => {
    await withStdinIsTTY(true, async () => {
      const site = 'review-gate-file-diff';
      const question = 'Enter filename for diff (relative to repo root): ';
      const userInput = 'src/orchestrator/core/pipeline.js';

      const { input, output, chunks } = makeIo(userInput);

      let onMenuCalled = false;
      const { pipeline, cleanup } = makePipeline({
        autoFromHere: true,
        onMenu: async () => {
          onMenuCalled = true;
          throw new Error('onMenu must not be called on the TTY Category C path');
        },
        streams: { input, output },
      });

      try {
        const result = await pipeline._gateMenu(
          site,
          question,
          null,
          { reason: 'Free-text filename input cannot be safely auto-defaulted.', category: 'C' },
        );

        // The returned value must be the user-typed string (trimmed).
        assert.strictEqual(
          result,
          userInput,
          `Expected returned string '${userInput}', got '${result}'`,
        );

        // The question must have been written to the output stream.
        const allOutput = chunks.join('');
        assert.ok(
          allOutput.includes(question),
          `Expected output to contain the question text.\nGot: ${allOutput}`,
        );

        // onMenu must NOT have been invoked.
        assert.strictEqual(
          onMenuCalled,
          false,
          'onMenu must not be invoked when autoFromHere=true on a Category C TTY gate',
        );
      } finally {
        cleanup();
      }
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC2: autoFromHere=true, isTTY=false, category='C'
//       → _gateMenu throws HaltError; .site='review-gate-file-diff' and
//         .reason matches the spec text
// ─────────────────────────────────────────────────────────────────────────────
await test(
  "TC2: autoFromHere=true + isTTY=false + category=C → throws HaltError with site='review-gate-file-diff'",
  async () => {
    await withStdinIsTTY(false, async () => {
      const site = 'review-gate-file-diff';
      const specReason = 'Free-text filename input cannot be safely auto-defaulted.';

      const { pipeline, cleanup } = makePipeline({
        autoFromHere: true,
        onMenu: async () => {
          throw new Error('onMenu must not be called on the non-TTY halt path');
        },
      });

      try {
        let thrown = null;
        try {
          await pipeline._gateMenu(
            site,
            'Enter filename for diff (relative to repo root): ',
            null,
            { reason: specReason, category: 'C' },
          );
        } catch (e) {
          thrown = e;
        }

        assert.ok(thrown !== null, '_gateMenu should have thrown an error');
        assert.ok(
          thrown instanceof HaltError,
          `Expected HaltError, got: ${thrown?.constructor?.name} — ${thrown?.message}`,
        );
        assert.strictEqual(
          thrown.site,
          site,
          `Expected .site '${site}', got '${thrown.site}'`,
        );
        assert.strictEqual(
          thrown.reason,
          specReason,
          `Expected .reason to match spec text.\nExpected: '${specReason}'\nGot:      '${thrown.reason}'`,
        );
      } finally {
        cleanup();
      }
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC3: autoFromHere=false → delegates to this.onMenu unchanged
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC3: autoFromHere=false → delegates to this.onMenu unchanged',
  async () => {
    const site = 'review-gate-file-diff';
    const question = 'Enter filename for diff (relative to repo root): ';
    const options = null;
    const opts = { reason: 'Free-text filename input cannot be safely auto-defaulted.', category: 'C' };
    const stubReturn = 'src/index.js';

    let onMenuCalledWith = null;
    const { pipeline, cleanup } = makePipeline({
      autoFromHere: false,
      onMenu: async (q, o, callOpts) => {
        onMenuCalledWith = { q, o, callOpts };
        return stubReturn;
      },
    });

    try {
      const result = await pipeline._gateMenu(site, question, options, opts);

      // Result must be the value returned by onMenu.
      assert.strictEqual(
        result,
        stubReturn,
        `Expected stub return value '${stubReturn}', got '${result}'`,
      );

      // onMenu must have been called with the original question, options, and opts.
      assert.ok(
        onMenuCalledWith !== null,
        'onMenu must be invoked when autoFromHere=false',
      );
      assert.strictEqual(
        onMenuCalledWith.q,
        question,
        `Expected onMenu to receive question '${question}', got '${onMenuCalledWith.q}'`,
      );
      assert.strictEqual(
        onMenuCalledWith.o,
        options,
        `Expected onMenu to receive options ${JSON.stringify(options)}, got ${JSON.stringify(onMenuCalledWith.o)}`,
      );
      assert.deepStrictEqual(
        onMenuCalledWith.callOpts,
        opts,
        `Expected onMenu to receive opts unchanged`,
      );
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
