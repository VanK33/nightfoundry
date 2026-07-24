/**
 * test-gate-category-b.js — Unit tests for _gateConfirm Category B halt logic.
 *
 * Category B gates (e.g. 'assumption-failed', 'regression-failed', 'assumption-uncertain')
 * represent failure-recovery prompts where the user is asked to bulldoze through a failure.
 * Under auto mode (autoFromHere=true):
 *   - non-TTY: MUST throw an exit-77 error — cannot prompt the user
 *   - TTY:     MUST bypass the wrapped onConfirm and call askYesNo directly
 *              so the user is forced to make an explicit real decision.
 *   - After TTY halt-y: MUST re-confirm "Continue in auto mode?"; if user answers 'n',
 *              this.autoFromHere MUST be flipped to false.
 *
 * Uses a real Pipeline instance (same pattern as test-gate-category-a.js).
 *
 * TC1: autoFromHere=true + isTTY=false + category 'B'
 *      → _gateConfirm throws an exit-77 error; site name is in the message.
 *
 * TC2: autoFromHere=true + isTTY=true + category 'B'
 *      → _gateConfirm bypasses the wrapped onConfirm and calls askYesNo directly.
 *
 * TC3: halt-y re-confirm → after TTY 'y' for main question and 'n' for
 *      re-confirm, this.autoFromHere is flipped to false.
 *
 * TC4: top-level exit-77 contract — a spawned child process that defines
 *      HaltError and throws it from main() exits with code 77.
 *
 * TC5: halt-y re-confirm 'y' → autoFromHere stays true; subsequent Cat-A
 *      call auto-resolves to safeDefault without calling onConfirm.
 *
 * Run: node test/test-gate-category-b.js
 */

import assert from 'assert';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');
const { bootstrap } = await import('../src/orchestrator/core/bootstrap.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// HaltError is now a shared leaf module. Imported here so TC1's assertions
// can check `instanceof HaltError` and `.site` / `.reason`, and TC4's spawned
// child script imports the same module.
// ─────────────────────────────────────────────────────────────────────────────
import { HaltError } from '../src/orchestrator/core/halt-error.js';

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline factory
//
// Creates a real Pipeline instance backed by a bootstrapped temp directory.
// onConfirm on the instance is overridden directly so tests can control and
// track calls without the constructor wrapper.
// ─────────────────────────────────────────────────────────────────────────────
function makePipeline({ autoFromHere = false, onConfirm } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gate-cat-b-'));
  bootstrap(tmpDir, {});

  const pipeline = new Pipeline(tmpDir, {
    onLog: () => {},
    onConfirm: async () => false,
  });

  // Override the wrapped onConfirm directly when the test needs to control it.
  if (onConfirm !== undefined) {
    pipeline.onConfirm = onConfirm;
  }

  pipeline.autoFromHere = autoFromHere;

  // Replace the real StatusBar with a minimal no-op so statusBar.teardown() /
  // promptWillStart() / promptDidEnd() calls succeed without terminal side-effects.
  // The real StatusBar targets terminal rendering and is not meaningful in unit tests.
  pipeline.statusBar = {
    teardown: () => {},
    destroy: () => {},
    promptWillStart: () => {},
    promptDidEnd: () => {},
  };

  return {
    pipeline,
    cleanup: () => {
      // Remove the process signal handlers registered by the Pipeline constructor.
      // Without this, each test's Pipeline instance piles up exit/signal listeners
      // that all fire during process shutdown and may interfere with one another.
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
// I/O helper — returns a PassThrough pre-loaded with test answers.
// Each answer gets a trailing '\n' so readline parses it as a complete line.
// ─────────────────────────────────────────────────────────────────────────────
function makeInput(...answers) {
  const stream = new PassThrough();
  answers.forEach((a) => stream.write(a + '\n'));
  stream.end();
  return stream;
}

// ─────────────────────────────────────────────────────────────────────────────
// withStdoutIsTTY: override process.stdout.isTTY for the duration of fn()
// The real _gateConfirm checks process.stdout.isTTY for the TTY guard.
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
// withTTYStdin: set process.stdout.isTTY=true, swap process.stdin to testInput,
// and intercept process.stdout.write to capture output chunks.
//
// The real _gateConfirm TTY path calls:
//   askYesNo(question, { statusBar: this.statusBar })
// askYesNo falls back to process.stdin/stdout when no custom streams are given,
// so swapping process.stdin and intercepting process.stdout.write allows full
// stream injection without modifying _gateConfirm.
//
// fn receives (outputChunks: string[]) — accumulated stdout write chunks.
// All stdio state is restored in the finally block.
// ─────────────────────────────────────────────────────────────────────────────
function withTTYStdin(testInput, fn) {
  // ── 1. Override process.stdout.isTTY to true ─────────────────────────────
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  // ── 2. Swap process.stdin with the test Readable ──────────────────────────
  // Force process.stdin to be initialised so getOwnPropertyDescriptor returns
  // the live property (not a lazy getter on the prototype).
  void process.stdin;
  const origStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', {
    value: testInput,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  // ── 3. Intercept process.stdout.write to capture output ───────────────────
  const outputChunks = [];
  const origWrite = process.stdout.write;
  process.stdout.write = function (chunk, encoding, cb) {
    outputChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return origWrite.call(process.stdout, chunk, encoding, cb);
  };

  const restore = () => {
    // Restore write first so subsequent console output works normally.
    process.stdout.write = origWrite;

    if (origIsTTY !== undefined) {
      Object.defineProperty(process.stdout, 'isTTY', origIsTTY);
    } else {
      delete process.stdout.isTTY;
    }

    if (origStdin !== undefined) {
      Object.defineProperty(process, 'stdin', origStdin);
    } else {
      delete process.stdin;
    }
  };

  return fn(outputChunks).then(
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
      // Print relevant stack frame (first non-internal line)
      const frame = err.stack.split('\n').slice(1).find((l) => l.includes('test-gate-category-b'));
      if (frame) console.log(`      ${frame.trim()}`);
    }
    failCount++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TC1: non-TTY → HaltError thrown; .site and .reason populated
//
// The real _gateConfirm throws HaltError(site, reason) when process.stdout.isTTY
// is falsy under auto mode Cat-B/C. The HaltError class lives in
// src/orchestrator/core/halt-error.js so coverage.js and pipeline.js can both
// throw the same structured class without a circular import.
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC1: autoFromHere=true + isTTY=false + category=B → throws HaltError with site/reason',
  async () => {
    await withStdoutIsTTY(false, async () => {
      const site = 'assumption-failed';
      const question = 'Assumptions failed. Proceed anyway?';

      let onConfirmCalled = false;
      const { pipeline, cleanup } = makePipeline({
        autoFromHere: true,
        onConfirm: async () => {
          onConfirmCalled = true;
          throw new Error('onConfirm must not be called on the non-TTY halt path');
        },
      });

      try {
        let thrown = null;
        try {
          await pipeline._gateConfirm(site, question, { safeDefault: false, category: 'B' });
        } catch (e) {
          thrown = e;
        }

        assert.ok(thrown !== null, '_gateConfirm should have thrown an error');
        assert.ok(
          thrown instanceof HaltError,
          `Expected HaltError, got ${thrown?.constructor?.name}: ${thrown?.message}`,
        );
        assert.strictEqual(
          thrown.site,
          site,
          `Expected .site === '${site}', got: '${thrown.site}'`,
        );
        assert.ok(
          typeof thrown.reason === 'string' && thrown.reason.length > 0,
          `Expected .reason to be a non-empty string, got: ${thrown.reason}`,
        );
        assert.strictEqual(
          onConfirmCalled,
          false,
          'onConfirm must not be invoked on the non-TTY halt path',
        );
      } finally {
        cleanup();
      }
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC2: TTY → askYesNo called directly via process.stdin; onConfirm bypassed
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC2: autoFromHere=true + isTTY=true + category=B → askYesNo called directly, onConfirm bypassed',
  async () => {
    const question = 'Regression failed. Accept and proceed to Phase 5, or stop?';

    // Answer 'n' to the main gate question — askYesNo resolves false and
    // the halt-y re-confirm does NOT fire, so only one answer is needed.
    const testInput = makeInput('n');

    let onConfirmCalled = false;
    const { pipeline, cleanup } = makePipeline({
      autoFromHere: true,
      onConfirm: async () => {
        onConfirmCalled = true;
        throw new Error('onConfirm must not be called on the TTY halt path');
      },
    });

    try {
      let result;
      await withTTYStdin(testInput, async (outputChunks) => {
        result = await pipeline._gateConfirm(
          'regression-failed',
          question,
          { safeDefault: false, category: 'B' },
        );

        // gate returned false (user answered 'n')
        assert.strictEqual(result, false, `Expected false (user answered 'n'), got ${result}`);

        // The question must have been written to the output stream
        const allOutput = outputChunks.join('');
        assert.ok(
          allOutput.includes(question),
          `Expected stdout output to contain the question text.\nGot: ${allOutput}`,
        );
      });

      // The wrapped onConfirm must NOT have been invoked
      assert.strictEqual(
        onConfirmCalled,
        false,
        'onConfirm must not be invoked when autoFromHere=true on a Category B TTY halt',
      );
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC3: halt-y re-confirm 'n' → this.autoFromHere flipped to false
// ─────────────────────────────────────────────────────────────────────────────
await test(
  "TC3: halt-y re-confirm → answering 'n' to re-confirm flips autoFromHere=false",
  async () => {
    const question = 'Some assumptions are uncertain. Proceed anyway?';

    // Two answers:
    //   1. 'y' — override the failure (halt-y)
    //   2. 'n' — decline to continue in auto mode (re-confirm)
    const testInput = makeInput('y', 'n');

    const { pipeline, cleanup } = makePipeline({
      autoFromHere: true,
      onConfirm: async () => {
        throw new Error('onConfirm must not be called on the TTY halt path');
      },
    });

    try {
      // Before the call, autoFromHere is true
      assert.strictEqual(pipeline.autoFromHere, true, 'autoFromHere should start as true');

      let result;
      await withTTYStdin(testInput, async () => {
        result = await pipeline._gateConfirm(
          'assumption-uncertain',
          question,
          { safeDefault: false, category: 'B' },
        );
      });

      // The main gate returned true (user answered 'y' to override the failure)
      assert.strictEqual(result, true, `Expected true (user answered 'y'), got ${result}`);

      // After answering 'n' to the re-confirm, autoFromHere must be false
      assert.strictEqual(
        pipeline.autoFromHere,
        false,
        "autoFromHere must be flipped to false after user answers 'n' to the re-confirm prompt",
      );
    } finally {
      cleanup();
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC4: HaltError propagated out of main() → child process exits with code 77
//
// Spawns a self-contained tiny script that:
//   1. Defines HaltError (same contract as above)
//   2. Has a main() that throws HaltError
//   3. Catches HaltError at the top level and exits with code 77
//
// Verifies that the exit-77 convention holds end-to-end.
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC4: spawned child that rethrows HaltError from main() exits with code 77',
  async () => {
    // Write a tiny self-contained script to a temp file.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gate-cat-b-'));
    const scriptPath = path.join(tmpDir, 'halt-test.mjs');

    const scriptSource = `
// Tiny HaltError contract test — self-contained.
class HaltError extends Error {
  constructor(site, reason) {
    super(
      \`Auto mode encountered halt site (\${site}): \${reason}. \` +
      \`Re-run interactively, or fix the underlying failure.\`
    );
    this.name = 'HaltError';
    this.site = site;
    this.reason = reason;
  }
}

async function main() {
  throw new HaltError('test-site', 'test reason from TC4');
}

main().catch((err) => {
  if (err.name === 'HaltError') {
    // HaltError propagated to top level — exit with the reserved code 77.
    process.exit(77);
  }
  console.error(err.message);
  process.exit(1);
});
`;

    fs.writeFileSync(scriptPath, scriptSource, 'utf8');

    try {
      const exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath], {
          stdio: 'pipe',
        });
        child.on('error', reject);
        child.on('close', (code) => resolve(code));
      });

      assert.strictEqual(
        exitCode,
        77,
        `Expected child process to exit with code 77, got ${exitCode}`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC5: halt-y re-confirm 'y' → autoFromHere stays true; next Cat-A auto-resolves
//
// After the user answers 'y' to both the Category B gate AND the "Continue in
// auto mode?" re-confirm, autoFromHere must remain true.  A subsequent Cat-A
// gate call must then auto-resolve to safeDefault without invoking onConfirm.
// ─────────────────────────────────────────────────────────────────────────────
await test(
  "TC5: halt-y re-confirm 'y' → autoFromHere stays true, next Cat-A auto-resolves",
  async () => {
    const question = 'Assumptions failed. Proceed anyway?';

    // Two answers:
    //   1. 'y' — override the failure (halt-y)
    //   2. 'y' — continue in auto mode (re-confirm)
    const testInput = makeInput('y', 'y');

    let onConfirmCalled = false;
    const { pipeline, cleanup } = makePipeline({
      autoFromHere: true,
      onConfirm: async () => {
        onConfirmCalled = true;
        throw new Error('onConfirm must not be called in auto mode');
      },
    });

    try {
      assert.strictEqual(pipeline.autoFromHere, true, 'autoFromHere should start as true');

      // ── Cat-B TTY call: answers 'y' (override) + 'y' (keep auto) ──────────
      let catBResult;
      await withTTYStdin(testInput, async () => {
        catBResult = await pipeline._gateConfirm(
          'assumption-failed',
          question,
          { safeDefault: false, category: 'B' },
        );
      });

      assert.strictEqual(catBResult, true, `Cat-B: expected true (user answered 'y'), got ${catBResult}`);

      // autoFromHere must still be true — user answered 'y' to re-confirm
      assert.strictEqual(
        pipeline.autoFromHere,
        true,
        "autoFromHere must remain true after user answers 'y' to the re-confirm prompt",
      );

      // ── Cat-A call: no stream needed — must auto-resolve to safeDefault ────
      const catAResult = await pipeline._gateConfirm(
        'queue-spec-approve',
        'Approve and queue this spec?',
        { safeDefault: true, category: 'A' },
      );

      assert.strictEqual(
        catAResult,
        true,
        `Cat-A: expected auto-resolve to safeDefault=true, got ${catAResult}`,
      );
      assert.strictEqual(
        onConfirmCalled,
        false,
        'onConfirm must not be invoked for Cat-A auto-resolve (autoFromHere=true)',
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
