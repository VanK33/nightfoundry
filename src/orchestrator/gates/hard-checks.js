/**
 * hard-checks.js — Execute hardChecks from verify.json and write a report.
 *
 * Replaces run-verify.sh from the original harness-orchestrator skill.
 * Pure JS, no AI.
 *
 * Reads .harness/verify/task-{id}.json, runs each hardCheck command in
 * projectRoot via execSync with a per-check timeout, writes a markdown
 * summary to .harness/verification/task-{id}-hard.md, and returns a
 * structured result.
 *
 * Does NOT mutate state — the caller (pipeline.js via the verifier flow)
 * decides what to do with the pass/fail result.
 *
 * Public API:
 *   runHardChecks(harnessDir, taskId, projectRoot)
 *     → { passed, results: [{name, passed, exitCode, timedOut, output}], reportPath }
 *   runMilestoneOnlyChecks(checks, projectRoot, {onLog, specTargetFiles})
 *     → { passed, failures: [{name, command, exitCode, outputTail}] }
 *   runFileCheckCriteria(fileChecks, projectRoot)
 *     → { passed, failures: [{name, targetFile}] }
 *
 * verify.json hardCheck schema:
 *   { name: string, command: string, expectExitCode?: number, timeout?: number }
 *   - expectExitCode defaults to 0
 *   - timeout is in seconds, defaults to 30
 *
 * Safety note: hardCheck commands are executed via a shell (execSync with
 * string input). This is intentional — hardChecks commonly need pipes,
 * redirects, and compound commands. The verify.json is authored by the
 * planner agent under cc-orch's tool scope, not by untrusted users at
 * runtime, so shell interpretation is consistent with the rest of the
 * orchestration layer.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isMilestoneOnlyCheck } from '../agents/planner.js';
import { withRunMarkerEnv } from '../core/run-marker.js';

export const HARD_CHECK_DEFAULT_TIMEOUT_MS = 30_000;
// 30 min: the drain typically runs right after a batch while the machine is
// still loaded — the full suite (333 tests, ~3 min quiet) has twice exceeded
// a 10-min budget in that window (exitCode=-1 SIGTERM, not a test failure).
export const MILESTONE_ONLY_CHECK_TIMEOUT_MS = 1_800_000;
const DEFAULT_EXPECT_EXIT_CODE = 0;
const OUTPUT_TRUNCATE_CHARS = 2000;

function truncate(str, max = OUTPUT_TRUNCATE_CHARS) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n... (truncated, ${str.length - max} more chars)`;
}

function runOne(check, projectRoot) {
  const expectExitCode = check.expectExitCode ?? DEFAULT_EXPECT_EXIT_CODE;
  const timeoutMs = check.timeout != null ? check.timeout * 1000 : HARD_CHECK_DEFAULT_TIMEOUT_MS;

  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  let timedOut = false;

  try {
    stdout = execSync(check.command, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: withRunMarkerEnv(),
    });
  } catch (err) {
    exitCode = err.status != null ? err.status : -1;
    stdout = (err.stdout || '').toString();
    stderr = (err.stderr || '').toString();
    // execSync sets err.signal to 'SIGTERM' on timeout.
    if (err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
      timedOut = true;
    }
  }

  const passed = !timedOut && exitCode === expectExitCode;
  const output = [
    stdout && `--- stdout ---\n${truncate(stdout)}`,
    stderr && `--- stderr ---\n${truncate(stderr)}`,
  ].filter(Boolean).join('\n');

  return {
    name: check.name || check.command,
    command: check.command,
    expectExitCode,
    exitCode,
    passed,
    timedOut,
    output,
  };
}

function formatReport(taskId, results) {
  const passedCount = results.filter((r) => r.passed).length;
  const totalCount = results.length;
  const overallPassed = passedCount === totalCount;

  const lines = [
    `# Hard Verification Report — Task ${taskId}`,
    ``,
    `**Result:** ${overallPassed ? 'PASSED' : 'FAILED'}`,
    `**Checks:** ${passedCount}/${totalCount} passed`,
    `**Timestamp:** ${new Date().toISOString()}`,
    ``,
    `## Checks`,
    ``,
  ];

  if (results.length === 0) {
    lines.push(`_No hard checks defined for this task._`);
  }

  for (const r of results) {
    const status = r.passed ? 'PASS' : (r.timedOut ? 'TIMEOUT' : 'FAIL');
    lines.push(`### [${status}] ${r.name}`);
    lines.push(``);
    lines.push(`- **Command:** \`${r.command}\``);
    lines.push(`- **Expected exit code:** ${r.expectExitCode}`);
    lines.push(`- **Actual exit code:** ${r.exitCode}`);
    if (r.timedOut) {
      lines.push(`- **Timed out:** yes`);
    }
    if (r.output) {
      lines.push(``);
      lines.push('```');
      lines.push(r.output);
      lines.push('```');
    }
    lines.push(``);
  }

  return lines.join('\n');
}

export async function runHardChecks(harnessDir, taskId, projectRoot) {
  const verifyPath = path.join(harnessDir, 'verify', `task-${taskId}.json`);
  if (!fs.existsSync(verifyPath)) {
    throw new Error(`verify.json not found for task ${taskId}: ${verifyPath}`);
  }

  let verify;
  try {
    verify = JSON.parse(fs.readFileSync(verifyPath, 'utf8'));
  } catch (err) {
    throw new Error(`verify.json for task ${taskId} is not valid JSON: ${err.message}`);
  }

  const checks = Array.isArray(verify.hardChecks) ? verify.hardChecks : [];
  const results = checks.map((check) => runOne(check, projectRoot));

  // Write the report regardless of pass/fail.
  const verificationDir = path.join(harnessDir, 'verification');
  fs.mkdirSync(verificationDir, { recursive: true });
  const reportPath = path.join(verificationDir, `task-${taskId}-hard.md`);
  fs.writeFileSync(reportPath, formatReport(taskId, results));

  const passed = results.length > 0 && results.every((r) => r.passed);
  // Edge case: if there are zero checks, we return passed=true (nothing to fail).
  // The original run-verify.sh had the same semantic.
  const finalPassed = results.length === 0 ? true : passed;

  return { passed: finalPassed, results, reportPath };
}

/**
 * Runs milestone-only spec hard checks (zero path tokens, or — when
 * `specTargetFiles` is supplied — no path token matching any spec-declared
 * target_file; see isMilestoneOnlyCheck in planner.js) sequentially in
 * projectRoot.
 *
 * Pure execution helper for the pipeline's last-milestone spec-criteria
 * drain: filters `checks` through isMilestoneOnlyCheck (forwarding
 * `specTargetFiles` so the defensive re-filter classifies exactly like the
 * caller and cannot drop a path-bearing milestone-only check), runs each via
 * execSync (cwd = projectRoot, 600 000 ms per-check timeout — same ceiling
 * class as the archive full-suite gate), captures output, and never throws.
 * A per-check progress line is emitted via onLog BEFORE each execution
 * (long-op visibility). Non-zero exit / timeout → a recorded failure; the
 * caller decides whether failures are fatal.
 *
 * @param {{name: string, command: string}[]} checks - Parsed spec hard checks (any mix; non-milestone-only entries are filtered out)
 * @param {string} projectRoot - cwd for each command
 * @param {{onLog?: (msg: string) => void, specTargetFiles?: string[]}} [opts] -
 *   `specTargetFiles`: the spec's declared target_files, forwarded to
 *   isMilestoneOnlyCheck; omit for legacy zero-token-only classification
 * @returns {{passed: boolean, failures: {name: string, command: string, exitCode: number, outputTail: string}[]}}
 */
export function runMilestoneOnlyChecks(checks, projectRoot, { onLog, specTargetFiles } = {}) {
  const milestoneOnly = (Array.isArray(checks) ? checks : []).filter((c) => isMilestoneOnlyCheck(c, specTargetFiles, projectRoot));
  const failures = [];

  for (const check of milestoneOnly) {
    if (onLog) onLog(`  [spec-criteria drain] running milestone-only check: ${check.name} — \`${check.command}\``);

    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    try {
      stdout = execSync(check.command, {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: MILESTONE_ONLY_CHECK_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: withRunMarkerEnv(),
      });
    } catch (err) {
      exitCode = err.status != null ? err.status : -1;
      stdout = (err.stdout || '').toString();
      stderr = (err.stderr || '').toString();
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || err.code === 'ENOBUFS' || err.message.includes('maxBuffer')) {
        exitCode = -1;
        stderr = 'maxBuffer exceeded (stdout > 16 MiB) — command output was too large\n' + stderr;
      } else if (err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
        timedOut = true;
      }
    }

    if (exitCode !== 0) {
      const output = [
        stdout && `--- stdout ---\n${stdout}`,
        stderr && `--- stderr ---\n${stderr}`,
      ].filter(Boolean).join('\n');
      failures.push({
        name: check.name,
        command: check.command,
        exitCode,
        timedOut,
        outputTail: timedOut ? '[timed out] ' + output.slice(-OUTPUT_TRUNCATE_CHARS) : output.slice(-OUTPUT_TRUNCATE_CHARS),
      });
    }
  }

  return { passed: failures.length === 0, failures };
}

/**
 * Checks file-check criteria (kind=file-check, as parsed by
 * parseSpecFileChecks in planner.js) against the project tree. Existence
 * only — no content/size semantics. Never throws; the caller decides
 * whether failures are fatal.
 *
 * @param {{name: string, targetFile: string}[]} fileChecks
 * @param {string} projectRoot - Resolution base for relative targetFile paths
 * @returns {{passed: boolean, failures: {name: string, targetFile: string}[]}}
 */
export function runFileCheckCriteria(fileChecks, projectRoot) {
  const failures = [];
  for (const check of (Array.isArray(fileChecks) ? fileChecks : [])) {
    if (!fs.existsSync(path.resolve(projectRoot, check.targetFile))) {
      failures.push({ name: check.name, targetFile: check.targetFile });
    }
  }
  return { passed: failures.length === 0, failures };
}
