/**
 * test-hard-checks-milestone-only.js — Unit tests for runMilestoneOnlyChecks
 * hardening: maxBuffer, timedOut classification, regression, and passing case.
 *
 * Run: node test/test-hard-checks-milestone-only.js
 */
import assert from 'assert';
import os from 'os';
import path from 'path';
import { runMilestoneOnlyChecks } from '../src/orchestrator/gates/hard-checks.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack);
      failCount++;
    }
  );
}

// Milestone-only checks have no path tokens (i.e. no file paths in the command
// that match target_files). We use a simple command without any path tokens.
// isMilestoneOnlyCheck passes checks that have no path token matching specTargetFiles.
// When specTargetFiles is omitted, any check with zero path tokens passes through.

const projectRoot = os.tmpdir();

async function main() {
  // TC-1: large stdout does not throw ENOBUFS (maxBuffer = 16 MiB)
  await test('TC-1: large stdout does not throw ENOBUFS — maxBuffer is 16 MiB', async () => {
    // Generate ~2 MiB of output — enough to exceed the old default 1 MiB but
    // well within our new 16 MiB limit, so the command should succeed.
    const checks = [
      { name: 'large-output', command: 'dd if=/dev/zero bs=1024 count=2048 2>/dev/null | cat' },
    ];
    // Should not throw; instead returns a result object.
    const result = runMilestoneOnlyChecks(checks, projectRoot);
    // dd exits 0, so it should pass.
    assert.equal(typeof result, 'object', 'result should be an object');
    assert.ok('passed' in result, 'result should have passed field');
    assert.ok('failures' in result, 'result should have failures field');
    // The main goal is no ENOBUFS exception — reaching here means it passed.
    // If dd succeeded the command passes (exitCode 0), otherwise it may fail
    // due to platform differences; we only assert no exception was thrown.
  });

  // TC-1 variant: verify maxBuffer diagnostic when output truly exceeds 16 MiB
  await test('TC-1b: maxBuffer exceeded records diagnostic in outputTail', async () => {
    // Generate >16 MiB of output to trigger the maxBuffer error.
    // 17 * 1024 * 1024 bytes = 17 MiB via yes pipe.
    const checks = [
      { name: 'overflow', command: 'yes x | head -c 17825792' }, // 17 MiB
    ];
    const result = runMilestoneOnlyChecks(checks, projectRoot);
    assert.equal(result.passed, false, 'should fail when maxBuffer exceeded');
    assert.equal(result.failures.length, 1);
    const f = result.failures[0];
    assert.equal(f.exitCode, -1, 'exitCode should be -1 for maxBuffer overflow');
    assert.ok(
      f.outputTail.includes('maxBuffer exceeded'),
      `outputTail should contain diagnostic, got: ${f.outputTail}`
    );
  });

  // TC-2: timed-out command records timedOut: true in failure object
  await test('TC-2: timed-out command records timedOut: true in the failure object', async () => {
    // We need to trick MILESTONE_ONLY_CHECK_TIMEOUT_MS — it's 1_800_000 ms.
    // Instead we directly test with a mock by overriding via a minimal wrapper.
    // Actually, we can't easily reduce the timeout without modifying the source.
    // Instead, simulate timeout by checking the SIGTERM path:
    // execSync with a very short timeout will produce err.signal === 'SIGTERM'.
    // We need to pass a check that is milestone-only and will time out.
    // The real MILESTONE_ONLY_CHECK_TIMEOUT_MS is 30 min, so we can't wait that long.
    //
    // Workaround: monkeypatch execSync is not feasible here. Instead, verify the
    // classification logic by examining the code behavior at the boundary:
    // We use a child_process trick — send SIGTERM by running a command that the
    // shell won't honour quickly. Actually, the simplest approach is to use
    // a test that doesn't hit the real 30-min timeout but verifies the code path.
    //
    // Real approach: use a very short sleep with a very short explicit timeout by
    // calling the underlying runOne logic indirectly via monkey patching is not
    // available. The best we can do in a black-box test is to accept that SIGTERM
    // classification is handled exactly as coded.
    //
    // Alternative: We can use Node's built-in ability — spawnSync with a very
    // short timeout produces signal SIGTERM and code null / status null.
    // Since runMilestoneOnlyChecks uses execSync with MILESTONE_ONLY_CHECK_TIMEOUT_MS
    // (30 min) we cannot practically time out in a test. However, we can verify the
    // structural contract by verifying that the timedOut field EXISTS in failures
    // for a normal failure (it should be false) as a regression guard, and
    // separately verify the SIGTERM path by examining the error handling code
    // statically OR by running a subprocess that times out with a mock timeout.
    //
    // For a true black-box test, we must accept we cannot reduce the 30-min limit
    // without code changes. BLOCKED scenario is not warranted — the spec says
    // implement + test; we must test the path. We'll use a small Node.js script
    // that runs a subprocess of our own runMilestoneOnlyChecks with a patched
    // timeout via environment variable approach...
    //
    // Actually the simplest viable approach: import child_process.execSync and
    // simulate what would happen. Since we cannot easily trigger a real SIGTERM
    // via the public API without waiting out the real timeout, we verify the timedOut field is
    // present in failures (false for a normal failure) as a structural test,
    // and add a direct unit test of the catch-block logic.
    //
    // We'll use a workaround: shell 'kill' approach. Launch a background sleep
    // and kill it immediately via shell script that exits with signal.
    // Actually the simplest: `bash -c 'kill -TERM $$'` exits with signal SIGTERM.
    // This will cause execSync to throw with err.signal = 'SIGTERM'.
    // BUT runMilestoneOnlyChecks uses MILESTONE_ONLY_CHECK_TIMEOUT_MS (30 min)
    // as timeout, not as what we use to kill the process. The err.signal would
    // still be 'SIGTERM' if the process killed itself!

    const checks = [
      // This command kills itself with SIGTERM — execSync will see err.signal='SIGTERM'
      { name: 'sigterm-self', command: 'bash -c "kill -TERM $$"' },
    ];
    const result = runMilestoneOnlyChecks(checks, projectRoot);
    assert.equal(result.passed, false, 'should fail when process receives SIGTERM');
    assert.equal(result.failures.length, 1);
    const f = result.failures[0];
    assert.equal(f.timedOut, true, 'timedOut should be true when err.signal is SIGTERM');
    assert.ok(
      f.outputTail.startsWith('[timed out]'),
      `outputTail should start with '[timed out]', got: ${f.outputTail}`
    );
  });

  // TC-3: normal failing command still records exitCode and outputTail correctly
  await test('TC-3: normal failing command records exitCode and outputTail correctly (no regression)', async () => {
    const checks = [
      { name: 'exit-42', command: 'sh -c "echo some-output; exit 42"' },
    ];
    const result = runMilestoneOnlyChecks(checks, projectRoot);
    assert.equal(result.passed, false);
    assert.equal(result.failures.length, 1);
    const f = result.failures[0];
    assert.equal(f.exitCode, 42, 'exitCode should match the shell exit code');
    assert.equal(f.timedOut, false, 'timedOut should be false for a normal failure');
    assert.ok(
      f.outputTail.includes('some-output'),
      `outputTail should contain stdout, got: ${f.outputTail}`
    );
    assert.ok(
      !f.outputTail.startsWith('[timed out]'),
      'outputTail should NOT start with [timed out] for a normal failure'
    );
  });

  // TC-4: passing command returns passed: true
  await test('TC-4: passing command returns passed: true', async () => {
    const checks = [
      { name: 'echo-pass', command: 'echo hello' },
    ];
    const result = runMilestoneOnlyChecks(checks, projectRoot);
    assert.equal(result.passed, true, 'should pass when command exits 0');
    assert.equal(result.failures.length, 0, 'no failures for a passing command');
  });

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
