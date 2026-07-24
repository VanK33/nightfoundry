/**
 * test-cli-usage-run-dir.js — Unit tests proving the end-of-run usage summary
 * (printUsage, invoked from the `run` and `task` CLI commands) reads the
 * PER-RUN harness dir (.harness/<runId>/logs/token-usage.json) rather than
 * the flat harness root (.harness/logs/token-usage.json), when an active-run
 * pointer is present.
 *
 * Approach (mirrors test-auto-cli-plumbing.js's ESM prototype-stub harness):
 *   - Seed an active-run pointer via claimActiveRun(projectRoot, {...})
 *   - Seed a per-run logs/token-usage.json under runHarnessDir(projectRoot, runId)
 *     with a distinct fixture session (so its totals are unmistakable)
 *   - Seed a DIFFERENT flat-root logs/token-usage.json under .harness/logs
 *     with a distinct fixture session (so its totals are unmistakable and
 *     never expected to appear in printUsage's summary output)
 *   - Stub Pipeline.prototype.run to skip the real pipeline body and return a
 *     truthy result — this drives run.js/task.js into their post-run
 *     printUsage(pipeline.projectRoot, { runStartSessionCount }) call
 *   - Capture console.log/console.warn/process.stdout.write output and
 *     assert the per-run fixture's totals appear, while the flat-root
 *     fixture's totals do not
 *
 * Tests:
 *   TC1 — run() usage print resolves per-run token-usage.json via
 *         projectRoot and prints its totals
 *   TC2 — task() usage print resolves per-run token-usage.json via
 *         projectRoot and prints its totals
 *
 * Run: node test/test-cli-usage-run-dir.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { run } from '../src/cli/commands/run.js';
import { task } from '../src/cli/commands/task.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { claimActiveRun, runHarnessDir } from '../src/orchestrator/core/run-context.js';

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

/**
 * Capture console.log/console.warn/process.stdout.write output produced
 * while `fn` (which may be async) runs. Restores all stubs in a finally.
 */
async function captureOutput(fn) {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);

  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => {
    chunks.push(args.join(' ') + '\n');
  };
  console.warn = (...args) => {
    chunks.push(args.join(' ') + '\n');
  };

  try {
    await fn();
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
    console.warn = origWarn;
  }

  return chunks.join('');
}

/**
 * Writes a minimal-but-well-formed logs/token-usage.json file under `dir`
 * with a single session record whose numeric fields are the given, easily
 * distinguishable, unique fixture values.
 */
function seedTokenUsage(dir, { name, inputTokens, outputTokens, totalCostUsd }) {
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const session = {
    name,
    type: 'executor',
    timestamp: new Date().toISOString(),
    inputTokens,
    outputTokens,
    cacheCreation: 0,
    cacheRead: 0,
    totalCostUsd,
  };
  const totals = {
    sessionCount: 1,
    inputTokens,
    outputTokens,
    cacheCreation: 0,
    cacheRead: 0,
    totalCostUsd,
    systemPromptTokens: 0,
    toolCallCount: 0,
  };
  fs.writeFileSync(
    path.join(logsDir, 'token-usage.json'),
    JSON.stringify({ sessions: [session], totals, updatedAt: new Date().toISOString() }, null, 2),
  );
}

// Distinct fixtures: the per-run values must never be confused with the
// flat-root values in the printed output.
const PER_RUN_FIXTURE = { name: 'per-run-session', inputTokens: 1111, outputTokens: 2222, totalCostUsd: 3.33 };
const FLAT_ROOT_FIXTURE = { name: 'flat-root-session', inputTokens: 9999, outputTokens: 8888, totalCostUsd: 7.77 };

/**
 * Seeds a project root with:
 *   - an active-run pointer claimed for `runId`
 *   - runHarnessDir(root, runId)/state.json (so resolveActiveHarnessDir validates)
 *   - runHarnessDir(root, runId)/logs/token-usage.json with PER_RUN_FIXTURE
 *   - .harness/logs/token-usage.json (flat root) with FLAT_ROOT_FIXTURE
 */
function seedActiveRunWithDistinctUsage(root, runId, slug, kind) {
  const ok = claimActiveRun(root, { runId, slug, kind });
  assert.ok(ok, 'claimActiveRun should succeed on a fresh project root');

  const runDir = runHarnessDir(root, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ globalStatus: 'active' }));
  seedTokenUsage(runDir, PER_RUN_FIXTURE);

  // Flat harness root — distinct fixture that must NOT surface in printUsage's
  // summary output once the active-run pointer resolves to runDir instead.
  const flatHarnessDir = path.join(root, '.harness');
  fs.mkdirSync(flatHarnessDir, { recursive: true });
  seedTokenUsage(flatHarnessDir, FLAT_ROOT_FIXTURE);
}

function assertPerRunTotalsPrinted(output, label) {
  assert.ok(
    output.includes(`Input tokens: ${PER_RUN_FIXTURE.inputTokens.toLocaleString()}`),
    `${label}: expected per-run input tokens (${PER_RUN_FIXTURE.inputTokens.toLocaleString()}) in output:\n${output}`,
  );
  assert.ok(
    output.includes(`Output tokens: ${PER_RUN_FIXTURE.outputTokens.toLocaleString()}`),
    `${label}: expected per-run output tokens (${PER_RUN_FIXTURE.outputTokens.toLocaleString()}) in output:\n${output}`,
  );
  assert.ok(
    output.includes(`Total cost: $${PER_RUN_FIXTURE.totalCostUsd}`),
    `${label}: expected per-run total cost ($${PER_RUN_FIXTURE.totalCostUsd}) in output:\n${output}`,
  );

  // Prove the flat harness root's fixture is NOT what got summarized.
  assert.ok(
    !output.includes(`Input tokens: ${FLAT_ROOT_FIXTURE.inputTokens.toLocaleString()}`),
    `${label}: flat-root input tokens (${FLAT_ROOT_FIXTURE.inputTokens.toLocaleString()}) leaked into printUsage output:\n${output}`,
  );
  assert.ok(
    !output.includes(`Total cost: $${FLAT_ROOT_FIXTURE.totalCostUsd}`),
    `${label}: flat-root total cost ($${FLAT_ROOT_FIXTURE.totalCostUsd}) leaked into printUsage output:\n${output}`,
  );
}

// ---------------------------------------------------------------------------
// TC1: run() usage print resolves per-run token-usage.json via projectRoot
// ---------------------------------------------------------------------------

await test('TC1: run() usage print resolves per-run token-usage.json via projectRoot and prints its totals', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-usage-run-dir-'));

  const runId = 'run-tc1-usage-fixture';
  seedActiveRunWithDistinctUsage(tmpDir, runId, 'tc1-usage', 'run');

  // Stub Pipeline.prototype.run to skip the real pipeline body entirely and
  // return a truthy result — this is what drives run.js into calling
  // renderRunCostSummary + printUsage(pipeline.projectRoot, {...}).
  const origRun = Pipeline.prototype.run;
  Pipeline.prototype.run = async function stubRun() {
    return { runStartSessionCount: 0 };
  };

  const origExit = process.exit;
  process.exit = (code) => {
    throw new Error(`process.exit called with code ${code}`);
  };

  try {
    const specPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specPath, '# Test Spec\n');

    const output = await captureOutput(async () => {
      await run(tmpDir, specPath, { auto: true });
    });

    assertPerRunTotalsPrinted(output, 'run()');
  } finally {
    Pipeline.prototype.run = origRun;
    process.exit = origExit;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TC2: task() usage print resolves per-run token-usage.json via projectRoot
// ---------------------------------------------------------------------------

await test('TC2: task() usage print resolves per-run token-usage.json via projectRoot and prints its totals', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-usage-run-dir-'));

  const runId = 'run-tc2-usage-fixture';
  seedActiveRunWithDistinctUsage(tmpDir, runId, 'tc2-usage', 'task');

  const origRun = Pipeline.prototype.run;
  Pipeline.prototype.run = async function stubRun() {
    return { runStartSessionCount: 0 };
  };

  const origExit = process.exit;
  process.exit = (code) => {
    throw new Error(`process.exit called with code ${code}`);
  };

  try {
    const output = await captureOutput(async () => {
      await task(tmpDir, 'Do the thing', { auto: true });
    });

    assertPerRunTotalsPrinted(output, 'task()');
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
