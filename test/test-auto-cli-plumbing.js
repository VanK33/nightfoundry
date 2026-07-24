/**
 * test-auto-cli-plumbing.js — Unit tests verifying that CLI commands pass
 * flags.auto through opts.auto to pipeline methods.
 *
 * Tests:
 *   TC1 (spec TC5) — dry-run.js dryRun() with flags.auto=true →
 *                    pipeline.dryRunValidate receives opts.auto===true
 *   TC2 (spec TC6) — run.js run() with flags.auto=true →
 *                    pipeline.run receives opts.auto===true
 *
 * Approach:
 *   - Import the CLI functions directly (dryRun, run)
 *   - Import Pipeline from the shared ESM module (same binding used inside the CLI)
 *   - Stub Pipeline.prototype methods before calling CLI functions — ESM module
 *     caching means the prototype stub applies to instances created inside dryRun/run
 *   - Capture the opts argument and assert opts.auto === true
 *   - Restore all stubs in finally blocks
 *
 * Run: node test/test-auto-cli-plumbing.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

import { dryRun } from '../src/cli/commands/dry-run.js';
import { run } from '../src/cli/commands/run.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ---------------------------------------------------------------------------
// TC1 (spec TC5): dryRun() passes opts.auto===true to pipeline.dryRunValidate
// ---------------------------------------------------------------------------

await test('TC1 (TC5): dryRun() with flags.auto=true → pipeline.dryRunValidate receives opts.auto===true', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-auto-plumbing-'));
  const capturedArgs = [];

  // Stub Pipeline.prototype.dryRunValidate to capture opts and resolve immediately.
  // ESM module caching: the same Pipeline class is used by dry-run.js's createPipeline,
  // so this stub applies to the instance created inside dryRun().
  const origDryRunValidate = Pipeline.prototype.dryRunValidate;
  Pipeline.prototype.dryRunValidate = async function stubDryRunValidate(goal, opts) {
    capturedArgs.push({ goal, opts });
  };

  // Stub process.exit to prevent the process from exiting on unexpected errors.
  const origExit = process.exit;
  process.exit = (code) => {
    throw new Error(`process.exit called with code ${code}`);
  };

  try {
    // Create a real spec file (dry-run.js checks fs.existsSync before creating pipeline)
    const specPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specPath, '# Test Spec\n');

    await dryRun(tmpDir, specPath, { auto: true });

    assert.strictEqual(
      capturedArgs.length,
      1,
      `Expected dryRunValidate to be called exactly once, got ${capturedArgs.length} call(s)`,
    );

    const opts = capturedArgs[0].opts;
    assert.ok(
      opts !== null && typeof opts === 'object',
      `Expected opts to be an object, got ${JSON.stringify(opts)}`,
    );
    assert.strictEqual(
      opts.auto,
      true,
      `Expected opts.auto === true, got ${JSON.stringify(opts.auto)}`,
    );
  } finally {
    Pipeline.prototype.dryRunValidate = origDryRunValidate;
    process.exit = origExit;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC2 (spec TC6): run() passes opts.auto===true to pipeline.run
// ---------------------------------------------------------------------------

await test('TC2 (TC6): run() with flags.auto=true → pipeline.run receives opts.auto===true', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-auto-plumbing-'));
  const capturedArgs = [];

  // Stub Pipeline.prototype.run to capture opts and return null (falsy result skips
  // renderRunCostSummary/printUsage calls that would need a real pipeline state).
  // ESM module caching: the same Pipeline class is used by run.js's createPipeline,
  // so this stub applies to the instance created inside run().
  const origRun = Pipeline.prototype.run;
  Pipeline.prototype.run = async function stubRun(goal, opts) {
    capturedArgs.push({ goal, opts });
    return null; // falsy → skips result-dependent rendering in run.js
  };

  // Stub process.exit to prevent the process from exiting on unexpected errors.
  const origExit = process.exit;
  process.exit = (code) => {
    throw new Error(`process.exit called with code ${code}`);
  };

  try {
    // Create a real spec file (run.js checks fs.existsSync before creating pipeline)
    const specPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specPath, '# Test Spec\n');

    // With flags.auto=true, run.js skips the interactive ".harness/ not found" prompt
    // and proceeds to create the pipeline and call pipeline.run.
    await run(tmpDir, specPath, { auto: true });

    assert.strictEqual(
      capturedArgs.length,
      1,
      `Expected pipeline.run to be called exactly once, got ${capturedArgs.length} call(s)`,
    );

    const opts = capturedArgs[0].opts;
    assert.ok(
      opts !== null && typeof opts === 'object',
      `Expected opts to be an object, got ${JSON.stringify(opts)}`,
    );
    assert.strictEqual(
      opts.auto,
      true,
      `Expected opts.auto === true, got ${JSON.stringify(opts.auto)}`,
    );
  } finally {
    Pipeline.prototype.run = origRun;
    process.exit = origExit;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
