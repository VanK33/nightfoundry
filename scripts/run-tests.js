#!/usr/bin/env node
/**
 * run-tests.js — Runs all tests independently (no fail-fast), aggregates
 * results, and exits non-zero if any test failed.
 *
 * Usage:
 *   node scripts/run-tests.js
 *   CC_ORCH_TEST_JOBS=1 node scripts/run-tests.js   # force serial (debugging)
 *
 * Test files run CONCURRENTLY through a worker pool (default
 * min(8, cores - 2), override via CC_ORCH_TEST_JOBS ≥ 1). Every test file
 * is a self-contained node process against its own mkdtemp fixture root —
 * the suite holds no cross-file shared state (audited: no fixed ports, no
 * shared write paths, no repo-root mutation), so file-level concurrency is
 * safe and the verdict stays exit-code-per-child.
 *
 * Hang backstop: a child that never exits (e.g. a runtime wedged in its own
 * shutdown) is SIGKILLed after CHILD_HANG_TIMEOUT_MS and retried ONCE,
 * serially, after the pool drains. Assertion failures are never retried.
 *
 * Summary is printed at the end showing PASS/FAIL per test and total counts,
 * in manifest order regardless of completion order.
 * Exit code 0 if all tests passed, 1 if any failed.
 */

import { spawn } from 'child_process';
import os from 'os';

// The test suite is NOT a re-entrant cc-orch invocation: its cases spawn
// cc-orch subprocesses against isolated fs.mkdtemp fixture roots, not the live
// run's project root. But when the suite is launched from inside a run (the
// spec-criteria drain / archive test gate run it with `env: withRunMarkerEnv()`),
// CC_ORCH_ACTIVE_RUN is inherited by every test child and their cc-orch
// grandchildren — tripping assertNoReentrantLiveRun on any fixture root that
// carries an active state.json (false positive on the sanctioned mkdtemp
// pattern). Clear the marker here so the whole suite runs re-entrancy-neutral
// regardless of launch context; tests that exercise the guard itself
// (test/test-active-run-marker.js TC1-TC4) set the marker explicitly in the
// child env/process.env they construct for each case, so this parent-level
// clear — which runs once, before any test file is spawned — does not
// clobber the marker under test.
delete process.env.CC_ORCH_ACTIVE_RUN;

// All test file paths (mirroring test:all in package.json), in order.
// Entries are plain strings only (test-manifest-integrity.js TC4 forbids
// the retired { npm: true, ... } shape from reappearing).
export const TEST_FILES = [
  'test/test-usage-json.js',
  'test/test-usage-detailed.js',
  'test/test-usage-all.js',
  'test/test-mutex.js',
  'test/test-cache-efficiency.js',
  'test/test-config-contract.js',
  'test/test-ui-config-contract.js',
  'test/test-health.js',
  'test/test-per-turn-tracking.js',
  'test/test-read-then-write.js',
  'test/test-run-cost-display.js',
  'test/test-session-manager-guard.js',
  'test/test-pretooluse-guard-hook.js',
  'test/test-session-manager-instrumentation.js',
  'test/test-session-manager-unit.js',
  'test/test-token-tracker.js',
  'test/test-usage-analyzer.js',
  'test/test-usage-compare.js',
  'test/test-usage-intelligence.js',
  'test/test-usage-since.js',
  'test/test-write-verify-json.js',
  'test/test-read-task-status-guard.js',
  'test/test-project-config.js',
  'test/test-audit-r2.js',
  'test/test-build-file-to-mission-map.js',
  'test/test-incremental-usage.js',
  'test/test-session-inflight-reconcile.js',
  'test/test-state.js',
  'test/test-queue-cli.js',
  'test/test-queue-state.js',
  'test/test-queue-retry.js',
  'test/test-session-manager-classify-wiring.js',
  'test/test-session-manager-infrastructure-error.js',
  'test/test-session.js',
  'test/test-cross-archive-analyzer.js',
  'test/test-usage-all-cli.js',
  'test/test-allow-incomplete-scope-flag.js',
  'test/test-r2-defect-coverage.js',
  'test/test-usage-coverage.js',
  'test/test-classify-result.js',
  'test/test-session-wall-clock.js',
  'test/test-percall-wallclock.js',
  'test/test-park-diff-preservation.js',
  'test/test-park-snapshot-scene.js',
  'test/test-park-requeue-reattach.js',
  'test/test-park-snapshot-cleanup.js',
  'test/test-auto-waive-scene.js',
  'test/test-analyzer-disposition-telemetry.js',
  'test/test-audit-r2-map-serialize.js',
  'test/test-thin-acceptance.js',
  'test/test-thin-archive.js',
  'test/test-thin-command.js',
  'test/test-thin-loop.js',
  'test/test-thin-preflight.js',
  'test/test-thin-session-sources.js',
  'test/test-run-context.js',
  'test/test-resolve-harness-fileref.js',
  'test/test-harness-file-ref.js',
  'test/test-write-json-atomic.js',
  'test/test-cost-ceiling.js',
  'test/test-parallel-runner.js',
];

// Per-child captured-output ceiling, matching the old spawnSync maxBuffer:
// a child that exceeds it is killed and marked FAIL.
const CHILD_OUTPUT_CAP = 64 * 1024 * 1024;

// Hang backstop: a child that has not exited after this long is presumed
// wedged — SIGKILLed (a runtime stuck in shutdown cannot service a normal
// signal) and flagged `hung` so runAll can give it ONE serial retry. The
// slowest legitimate file is ~1 min; 5 min is contention headroom, not a
// target. Observed trigger: Node v25.7.0's exit-path deadlock
// (uv_thread_join waiting on a V8 worker parked in a GC barrier) — the
// test's cases all pass, the PROCESS never exits. That is a runtime
// symptom, not a failing test, which is why hangs (and only hangs — never
// assertion failures) earn a retry.
const CHILD_HANG_TIMEOUT_MS = 300_000;

/**
 * Run a single entry and resolve { label, passed, hung }.
 *
 * Children get PIPED stdio, never the parent's terminal. With
 * `stdio: 'inherit'` from an interactive terminal, every test child saw a
 * real TTY, so TTY-gated code paths (interactive prompts, the status bar's
 * ANSI renderer, readline terminal mode) activated inside tests written for
 * scripted stdio — ~30 files failed when the suite ran on a TTY yet passed
 * when piped (`npm run test:all 2>&1 | ...`). The suite's verdict must not
 * depend on how it was invoked: pipe always, then forward the captured
 * output once the child exits — the whole capture in one write, so under
 * concurrency the transcript interleaves at FILE granularity, never
 * mid-line. `[RUN]` is still logged before the spawn (long-op visibility).
 *
 * @param {string} entry
 * @param {{hangTimeoutMs?: number}} [opts]
 * @returns {Promise<{label: string, passed: boolean, hung: boolean}>}
 */
function runEntry(entry, { hangTimeoutMs = CHILD_HANG_TIMEOUT_MS } = {}) {
  const label = entry;
  console.log(`[RUN] ${label}`);
  return new Promise((resolve) => {
    const child = spawn('node', [entry], { stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let overflowed = false;
    const collect = (chunks) => (chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > CHILD_OUTPUT_CAP) {
        if (!overflowed) {
          overflowed = true;
          child.kill('SIGTERM');
        }
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdoutChunks));
    child.stderr.on('data', collect(stderrChunks));

    let settled = false;
    let hangTimer = null;
    const settle = (passed, note, hung = false) => {
      if (settled) return;
      settled = true;
      if (hangTimer) clearTimeout(hangTimer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (note) process.stderr.write(`[runner] ${label}: ${note}\n`);
      resolve({ label, passed, hung });
    };

    // Settle directly on timeout instead of waiting for 'close': a wedged
    // runtime may never close its stdio, and a grandchild holding inherited
    // pipe fds would keep 'close' from firing even after the SIGKILL.
    hangTimer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(false, `no exit after ${Math.round(hangTimeoutMs / 1000)}s — SIGKILLed, flagged as hung`, true);
    }, hangTimeoutMs);

    child.on('error', (err) => settle(false, `spawn error: ${err.message}`));
    child.on('close', (code) => settle(
      code === 0 && !overflowed,
      overflowed ? 'output exceeded the 64 MiB cap — child killed, marked FAIL' : null
    ));
  });
}

/**
 * Run every entry through a worker pool of at most `jobs` concurrent
 * children. Dispatch follows manifest order; whichever worker frees up
 * takes the next entry. Results land at their manifest index, so the
 * returned array (and the summary printed from it) is in manifest order
 * regardless of completion order. No fail-fast.
 *
 * After the pool drains, entries flagged `hung` (killed by the hang
 * backstop — the process never exited) get ONE serial retry each, and the
 * retry's verdict replaces the hang. Assertion failures (a child that
 * exited non-zero) are never retried — a hang is a runtime symptom, a
 * non-zero exit is a red test.
 *
 * @param {string[]} entries
 * @param {{jobs?: number, hangTimeoutMs?: number}} [opts]
 * @returns {Promise<{label: string, passed: boolean, hung: boolean, retriedAfterHang?: boolean}[]>}
 */
export async function runAll(entries, { jobs = 1, hangTimeoutMs = CHILD_HANG_TIMEOUT_MS } = {}) {
  const workerCount = Math.max(1, Math.min(jobs, entries.length || 1));
  const results = new Array(entries.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex++;
      results[index] = await runEntry(entries[index], { hangTimeoutMs });
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));

  for (let i = 0; i < results.length; i++) {
    if (results[i] && results[i].hung) {
      console.log(`[runner] ${entries[i]}: hung in the pool — one serial retry (a hang is a runtime symptom, not a failing test)`);
      const retry = await runEntry(entries[i], { hangTimeoutMs });
      results[i] = { ...retry, retriedAfterHang: true };
    }
  }
  return results;
}

/**
 * Worker-pool width: CC_ORCH_TEST_JOBS (≥ 1; 1 forces the old serial
 * behaviour) or min(8, cores - 2) — capped low enough to leave headroom
 * for whatever loaded the machine (the drain typically fires right after
 * a batch).
 *
 * @returns {number}
 */
export function defaultJobs() {
  const fromEnv = Number(process.env.CC_ORCH_TEST_JOBS);
  if (Number.isInteger(fromEnv) && fromEnv >= 1) return fromEnv;
  return Math.min(8, Math.max(1, os.availableParallelism() - 2));
}

// Only run when executed directly (not when imported as a module).
// In ESM, we check if this file is the entry point.
const isMain = process.argv[1] && process.argv[1].endsWith('run-tests.js');

if (isMain) {
  // Force the hermetic test environment for every spawned test child.
  // These statements live inside the isMain block (not at module top level)
  // because this module is dynamically imported purely for its TEST_FILES
  // export (see the checkTestRegistration gate / test/test-test-registration-
  // gate.js) — mutating process.env at module scope would leak into that
  // importer's environment. A future real-SDK lane runs
  // `node test/test-session.js` directly (outside this runner), which is
  // exactly why the runner clears the CC_ORCH_REAL_SDK opt-in here: the
  // runner's own children must always run hermetically, while the direct
  // real-SDK lane invocation bypasses this file entirely and keeps its own
  // env intact.
  process.env.CC_ORCH_TEST = '1';
  delete process.env.CC_ORCH_REAL_SDK;

  const jobs = defaultJobs();
  console.log(`[runner] ${TEST_FILES.length} files, ${jobs} concurrent`);
  const results = await runAll(TEST_FILES, { jobs });

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));

  let passCount = 0;
  let failCount = 0;

  for (const { label, passed, retriedAfterHang } of results) {
    const status = passed ? 'PASS' : 'FAIL';
    const note = retriedAfterHang
      ? (passed ? ' (passed on serial retry after hang)' : ' (failed serial retry after hang)')
      : '';
    console.log(`  [${status}] ${label}${note}`);
    if (passed) passCount++;
    else failCount++;
  }

  console.log('='.repeat(60));
  console.log(`Total: ${results.length} | Passed: ${passCount} | Failed: ${failCount}`);
  console.log('='.repeat(60) + '\n');

  process.exit(failCount > 0 ? 1 : 0);
}
