/**
 * regression.js — Regression verification at mission and milestone levels.
 *
 * Mission-level: autonomous. On failure → analyze → plan fixes → execute → re-verify.
 * Milestone-level: user gate. On failure → write report, escalate.
 *
 * Public API:
 *   verifyMission({ missionId, missionPlan, verifier, projectRoot, onLog })
 *     → { passed: boolean, report: string }
 *
 *   verifyMilestone({ milestoneId, milestoneDesc, specPath, verifier, projectRoot, onLog })
 *     → { passed: boolean, report: string }
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import config from '../infra/config.js';
import { writeVerifyJson, readState } from '../core/state.js';
import { withRunMarkerEnv } from '../core/run-marker.js';

const RUN_NPM_TEST_TIMEOUT_MS = 120_000;

/**
 * Spawns the configured smoke-test command (config.execution.testCommand,
 * default `npm test`) in the given projectRoot.
 * Returns { exitCode: number, output: string, signal: string|null }.
 * exitCode 0 on success, non-zero on failure, -1 on timeout or when the
 * child was terminated by any signal. `signal` carries the signal name
 * (e.g. 'SIGKILL') when the child was killed by a signal, else null.
 */
export function runTestCommand(projectRoot) {
  let exitCode = 0;
  let output = '';
  let signal = null;

  try {
    const stdout = execSync(config.execution.testCommand, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: RUN_NPM_TEST_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: withRunMarkerEnv(),
    });
    output = stdout || '';
  } catch (err) {
    const stdout = (err.stdout || '').toString();
    const stderr = (err.stderr || '').toString();
    const captured = [stdout, stderr].filter(Boolean).join('\n');

    if (err.signal) {
      exitCode = -1;
      signal = err.signal;
      output = [`Process killed by ${err.signal}`, captured].filter(Boolean).join('\n');
    } else if (err.code === 'ETIMEDOUT') {
      exitCode = -1;
      output = captured;
    } else {
      exitCode = err.status != null ? err.status : 1;
      output = captured;
    }
  }

  return { exitCode, output, signal };
}

// The full suite (config.execution.testAllCommand, default `npm run
// test:all`) is far larger than the per-milestone smoke test
// (config.execution.testCommand, default `npm test`), so it gets a much
// longer timeout. Used only by the archive final-test gate, which runs once
// per spec at archive time — not in the per-milestone regression loop.
// 30 min, matching MILESTONE_ONLY_CHECK_TIMEOUT_MS: this gate fires right
// after a batch while the machine is still loaded — the suite has been
// SIGTERM-killed at a 10-min budget there despite passing in ~3 min quiet.
const RUN_TEST_ALL_TIMEOUT_MS = 1_800_000;

// Matches runMilestoneOnlyChecks' ceiling (gates/hard-checks.js): the two tail
// full-suite runs must capture output under identical rules. Node's 1 MiB
// default was the live hazard — this repo's own suite stdout measured 404 KiB
// at 346 tests and grows with every spec, and an overflow arrives as
// SIGTERM/ENOBUFS, i.e. wearing a timeout's clothes.
const RUN_TEST_ALL_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Spawns the configured full-suite command (config.execution.testAllCommand,
 * default `npm run test:all`) in the given projectRoot.
 * Returns { exitCode: number, output: string, signal: string|null }.
 * exitCode 0 on success, non-zero on failure, -1 on timeout or when the
 * child was terminated by any signal. `signal` carries the signal name
 * (e.g. 'SIGKILL') when the child was killed by a signal, else null — a
 * maxBuffer overflow (which also arrives wearing SIGTERM) is NOT treated as
 * a signal-kill and always reports signal: null.
 *
 * This is the archive-time final gate's runner: the per-milestone regression
 * uses runTestCommand (a fast smoke test), but a spec must not be archived
 * unless its WHOLE suite passes.
 */
export function runFullTestSuite(projectRoot) {
  let exitCode = 0;
  let output = '';
  let signal = null;

  try {
    const stdout = execSync(config.execution.testAllCommand, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: RUN_TEST_ALL_TIMEOUT_MS,
      maxBuffer: RUN_TEST_ALL_MAX_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: withRunMarkerEnv(),
    });
    output = stdout || '';
  } catch (err) {
    const stdout = (err.stdout || '').toString();
    const stderr = (err.stderr || '').toString();
    const captured = [stdout, stderr].filter(Boolean).join('\n');
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || err.code === 'ENOBUFS' || err.message.includes('maxBuffer')) {
      // An overflow is NOT a timeout: Node kills the child with SIGTERM on
      // maxBuffer, so this branch MUST precede the signal test below or the
      // overflow would ride the -1/timedOut/infra leg and leave the entry
      // pending forever on a suite that may well be green. It is also NOT a
      // signal-kill for reporting purposes: signal stays null even though
      // the child was in fact SIGTERM'd, since the cause here is the buffer
      // ceiling, not an external kill.
      //
      // REPLACE the captured output rather than prefixing it: what we captured
      // is a truncated fragment with no verdict in it, and the consumer
      // (archive.js's TestGateError) keeps only `output.slice(-2000)` — a
      // marker prepended to megabytes of fragment is sliced off and never
      // reaches the human. A short, self-contained replacement survives that
      // slice intact, and the discarded fragment is worthless anyway.
      exitCode = 1;
      output = `maxBuffer exceeded (stdout > ${RUN_TEST_ALL_MAX_BUFFER / (1024 * 1024)} MiB) — the command produced more output than the harness can capture. The output was discarded, so the suite's pass/fail state is UNKNOWN: this is NOT a test failure. Use a quieter reporter, or raise the ceiling.`;
    } else if (err.signal) {
      exitCode = -1;
      signal = err.signal;
      output = [`Process killed by ${err.signal}`, captured].filter(Boolean).join('\n');
    } else if (err.code === 'ETIMEDOUT') {
      exitCode = -1;
      output = captured;
    } else {
      exitCode = err.status != null ? err.status : 1;
      output = captured;
    }
  }

  return { exitCode, output, signal };
}

/**
 * Returns true iff the verifier's structured verdict is PASSED:
 * `result?.structured?.result === 'PASSED'` and nothing else.
 *
 * No substring search, no reading result.report. Why: `report` is always
 * `JSON.stringify(structured, null, 2)` (verifier.js extractVerdict, all
 * return paths) and `structured` is always present (valid verdict,
 * schema-validation failure, and the no-output stub), so a substring
 * fallback can only create false greens — a FAILED verdict whose evidence
 * text mentions 'PASSED' would flip the soft-pass — and can never add a
 * true positive.
 */
export function structuredVerdictPassed(result) {
  return result?.structured?.result === 'PASSED';
}

/**
 * Missions whose status is one of these are considered terminal-complete and
 * are excluded from the pending-deliverables block.
 */
const TERMINAL = new Set(['complete', 'invalidated']);

/**
 * Builds a text block listing the targetFiles of missions that have not yet
 * reached a terminal status (excludes 'complete' and 'invalidated'), so
 * regression verifiers don't flag the absence of not-yet-implemented
 * deliverables as a failure.
 *
 * Fail-soft in both directions: if state.json is unreadable/absent, or no
 * pending missions exist, or none of them carry a non-empty persisted
 * targetFiles array, returns '' (so callers can append it to a purpose
 * string with no observable effect). Never throws.
 *
 * @param {string} harnessDir
 * @param {{ excludeMissionId?: string }} [opts]
 * @returns {string}
 */
export function buildPendingDeliverablesBlock(harnessDir, opts = {}) {
  const { excludeMissionId } = opts || {};

  let state;
  try {
    state = readState(harnessDir);
  } catch {
    return '';
  }

  if (!state || typeof state.milestones !== 'object' || state.milestones === null) return '';

  const pending = [];
  for (const ms of Object.values(state.milestones)) {
    if (!ms || typeof ms.missions !== 'object' || ms.missions === null) continue;
    for (const [miId, mi] of Object.entries(ms.missions)) {
      if (!mi) continue;
      if (TERMINAL.has(mi.status)) continue;
      if (excludeMissionId && miId === excludeMissionId) continue;
      const targetFiles = Array.isArray(mi.targetFiles) ? mi.targetFiles : [];
      if (targetFiles.length === 0) continue;
      pending.push({ id: miId, targetFiles });
    }
  }

  if (pending.length === 0) return '';

  const lines = pending.map((m) => `- Mission ${m.id}: ${m.targetFiles.join(', ')}`);

  return `\n\nPending deliverables (missions not yet run):
The following files are deliverables of missions that have NOT yet run. Their absence is EXPECTED and is NOT grounds for failure:
${lines.join('\n')}`;
}

/**
 * Mission-level regression: does the codebase satisfy what the mission described?
 * Spawns a verifier session with broad scope (mission plan + all task summaries).
 */
export async function verifyMission({ missionId, missionPlan, verifier, projectRoot, harnessDir, onLog }) {
  onLog(`  Running mission regression for ${missionId}...`);

  const missionStateFile = path.join(harnessDir, 'state', `mission-${missionId}.json`);
  if (!fs.existsSync(missionStateFile)) {
    onLog(`  No mission state file — skipping regression.`);
    return { passed: true, report: '' };
  }

  const missionState = JSON.parse(fs.readFileSync(missionStateFile, 'utf8'));

  // Collect all completed task summaries from JSON sidecars.
  const taskSummaries = [];
  for (const [, sm] of Object.entries(missionState.subMissions)) {
    for (const [, task] of Object.entries(sm.tasks)) {
      if (task.status !== 'complete') continue;

      const jsonPath = path.join(harnessDir, 'progress', `task-${task.id}.json`);
      let summary;
      if (fs.existsSync(jsonPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          const files = (parsed.affectedFiles || []).map((f) => f.path).join(', ');
          summary =
            `Task ${task.id}: ${parsed.summary || task.description}\n` +
            `Files: ${files}\n` +
            `Tests: ${parsed.testsSummary || 'n/a'}`;
        } catch {
          summary = `Task ${task.id}: ${task.description}`;
        }
      } else {
        summary = `Task ${task.id}: ${task.description}`;
      }
      taskSummaries.push(summary);
    }
  }

  const task = {
    id: `regression-${missionId}`,
    description: `Mission-level regression check for ${missionId}`,
    targetFiles: [],
    hardChecks: [],
    testCases: [],
  };

  // Defect #13: regression tasks bypass the executor (which writes verify.json
  // for normal tasks). Without a stub, the verifier prompt's "Read the
  // verify.json file" step finds nothing, manufactures a "file exists"
  // hardCheck, and FAILS — even when the actual functional check passes.
  // The stub keeps the verify.json contract uniform across all sidecars.
  writeVerifyJson(harnessDir, task);

  let specPath;
  try {
    specPath = readState(harnessDir)?.projectMeta?.prdPath;
  } catch {
    specPath = undefined;  // state.json may be absent for isolated regression checks
  }

  let pendingDeliverablesBlock;
  try {
    pendingDeliverablesBlock = buildPendingDeliverablesBlock(harnessDir, { excludeMissionId: missionId });
  } catch {
    pendingDeliverablesBlock = '';
  }

  const context = {
    specPath,
    purpose: `Verify that mission ${missionId} is fully implemented as described.

Mission plan:
${missionPlan}

Completed tasks (${taskSummaries.length}):
${taskSummaries.map((s, i) => `--- Task ${i + 1} ---\n${s}`).join('\n\n')}

Check:
1. Run any existing tests (npm test, pytest, etc.) to confirm nothing is broken
2. Verify the mission's described functionality actually works end-to-end
3. Check for integration issues between tasks (shared files, API contracts, imports)
4. Report PASS if the mission goal is met, FAIL with specifics if not${pendingDeliverablesBlock}`,
  };

  const start = Date.now();
  const result = await verifier.verifyRegression(task, projectRoot, context);
  onLog(`  Mission regression completed in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  let passed = false;
  let softPass = false;

  if (result.verified) {
    passed = true;
    onLog(`  Mission ${missionId} regression: PASSED`);
  } else {
    const smokeResult = runTestCommand(projectRoot);
    const textSignal = structuredVerdictPassed(result);

    if (smokeResult.exitCode === 0 && textSignal) {
      // Soft-pass: smoke test passes and text signal says PASS, but verifier disagreed
      passed = true;
      softPass = true;
      onLog(`  [verifier-disagreement] Mission ${missionId} regression: verifier returned verified=false but \`${config.execution.testCommand}\` exit 0 and text signal PASS — treating as PASSED (soft-pass)`);
    } else if (smokeResult.exitCode === 0 && !textSignal) {
      // Smoke test passed but text signal absent — still FAILED
      passed = false;
      onLog(`  Mission ${missionId} regression: FAILED`);
      onLog(`  [diagnostic] \`${config.execution.testCommand}\` exited 0 but verifier text signal absent (structured verdict is not PASSED)`);
    } else {
      // Smoke test non-zero — standard FAIL path
      passed = false;
      onLog(`  Mission ${missionId} regression: FAILED`);
    }
  }

  return { passed, softPass, report: result.report, isStub: result.isStub ?? false, structured: result.structured ?? null };
}

/**
 * Milestone-level regression: does the codebase deliver what the spec/milestone described?
 * Final delivery gate — user decides on failure.
 */
export async function verifyMilestone({ milestoneId, milestoneDesc, specPath, verifier, projectRoot, harnessDir, onLog }) {
  onLog(`\n  Running milestone regression for ${milestoneId}...`);

  // Collect mission summaries
  const state = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
  const milestone = state.milestones[milestoneId];
  if (!milestone) {
    onLog(`  Milestone ${milestoneId} not found — skipping.`);
    return { passed: true, report: '' };
  }

  const missionSummaries = [];
  for (const [miId, mi] of Object.entries(milestone.missions)) {
    missionSummaries.push(`Mission ${miId}: ${mi.description} [${mi.status}]`);
  }

  // Read spec if available
  let specContent = '';
  if (specPath && fs.existsSync(path.resolve(projectRoot, specPath))) {
    specContent = fs.readFileSync(path.resolve(projectRoot, specPath), 'utf8');
    if (specContent.length > 3000) specContent = specContent.slice(0, 3000) + '\n...(truncated)';
  }

  const task = {
    id: `regression-milestone-${milestoneId}`,
    description: `Milestone-level regression check for ${milestoneId}`,
    targetFiles: [],
    hardChecks: [],
    testCases: [],
  };

  // Defect #13: same stub-write rationale as verifyMission above.
  writeVerifyJson(harnessDir, task);

  let pendingDeliverablesBlock;
  try {
    pendingDeliverablesBlock = buildPendingDeliverablesBlock(harnessDir);
  } catch {
    pendingDeliverablesBlock = '';
  }

  const context = {
    specPath,
    purpose: `Final delivery verification for milestone ${milestoneId}: "${milestoneDesc}"

${specContent ? `Original spec:\n${specContent}\n` : ''}

Completed missions:
${missionSummaries.join('\n')}

This is the final gate before delivery. Check:
1. Run the full test suite
2. Verify the milestone's described goal is actually achieved
3. Check that the spec requirements (if provided) are met
4. Look for obvious gaps between what was requested and what exists. Do NOT invent deployment, packaging, or git-commit-state acceptance criteria the spec does not state — uncommitted/untracked files are expected at this stage and are not a gap.
5. Report PASS if the milestone goal is met, FAIL with specifics if not${pendingDeliverablesBlock}`,
  };

  const start = Date.now();
  const result = await verifier.verifyRegression(task, projectRoot, context);
  onLog(`  Milestone regression completed in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  let passed = false;
  let softPass = false;

  if (result.verified) {
    passed = true;
  } else {
    const smokeResult = runTestCommand(projectRoot);
    const textSignal = structuredVerdictPassed(result);

    if (smokeResult.exitCode === 0 && textSignal) {
      passed = true;
      softPass = true;
    } else if (smokeResult.exitCode === 0 && !textSignal) {
      passed = false;
    } else {
      passed = false;
    }
  }

  // Determine result header
  let resultHeader;
  if (passed && softPass) {
    resultHeader = 'PASSED (soft-pass, verifier disagreement)';
  } else if (passed) {
    resultHeader = 'PASSED';
  } else {
    resultHeader = 'FAILED';
  }

  // Write regression report
  const reportPath = path.join(harnessDir, 'verification', `regression-milestone-${milestoneId}.md`);
  let reportContent = `# Milestone Regression Report — ${milestoneId}

## Result: ${resultHeader}

## Milestone
${milestoneDesc}

## Missions
${missionSummaries.join('\n')}

## Verifier Report
${result.report}

## Timestamp
${new Date().toISOString()}
`;
  if (result.isStub) reportContent = '⚠️ STUB VERDICT — verifier timed out or returned no structured_output\n\n' + reportContent;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, reportContent);

  // Structured companion for the remediation path: the .md above stays the
  // human/analyzer-facing report; this JSON carries the verifier's
  // attributed findings so pipeline remediation does not have to parse
  // prose (its JSON.parse of the .md always failed, synthesizing a
  // file:'unknown' finding).
  const findings = Array.isArray(result.structured?.findings) ? result.structured.findings : [];
  const findingsPath = path.join(harnessDir, 'verification', `regression-milestone-${milestoneId}.json`);
  fs.writeFileSync(findingsPath, JSON.stringify({
    milestoneId,
    passed,
    softPass,
    isStub: result.isStub ?? false,
    findings,
  }, null, 2));

  if (passed && softPass) {
    onLog(`  Milestone ${milestoneId} regression: PASSED (soft-pass, verifier disagreement)`);
    onLog(`  [verifier-disagreement] \`${config.execution.testCommand}\` exit 0 and text signal PASS override verifier verified=false`);
    onLog(`  Report: ${reportPath}`);
  } else if (passed) {
    onLog(`  Milestone ${milestoneId} regression: PASSED`);
  } else {
    onLog(`  Milestone ${milestoneId} regression: FAILED`);
    onLog(`  Report: ${reportPath}`);
  }

  return { passed, softPass, report: reportContent, reportPath, findingsPath, isStub: result.isStub ?? false, structured: result.structured ?? null };
}
