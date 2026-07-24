/**
 * baseline.js — Pre-spend baseline gate (engine hole 18).
 *
 * Before any token is spent, prove the configured test commands actually RUN
 * and the project's baseline is green. Runs the smoke command
 * (config.execution.testCommand, default `npm test`) FIRST, then the full
 * suite (config.execution.testAllCommand, default `npm run test:all`),
 * short-circuiting on the first failure — a red smoke never triggers the
 * (far more expensive) full suite.
 *
 * Uses the UNMODIFIED runners from ./regression.js (runTestCommand,
 * runFullTestSuite) — this module does not alter their behaviour, timeouts,
 * or maxBuffer, it only sequences and interprets their results.
 *
 * Sanctioned no-tests skip (mirrors archive.js runFinalTestGate's dichotomy,
 * reimplemented locally — archive.js is not imported or edited): a command is
 * skipped LOUDLY, and its command string recorded in the returned `skipped`
 * array, only when it is the shipped DEFAULT for its slot AND the target's
 * package.json lacks the matching script ('test' for the smoke slot,
 * 'test:all' for the full slot). Any explicitly configured (non-default)
 * command is NEVER skipped — it always runs, script or no script. This is
 * the ONLY skip path: there is no CLI flag, env var, or config key that
 * bypasses the gate.
 *
 * Identical-command dedup: when config.execution.testCommand and
 * config.execution.testAllCommand are the exact same string, the command is
 * run (or skipped) exactly once for the smoke slot — the full slot is never
 * separately evaluated or re-run.
 *
 * Never throws across its boundary: the whole run is wrapped in try/catch
 * and always returns a result object.
 *
 * @param {string} projectRoot
 * @returns {{ ok: true, skipped: string[] }
 *         | { ok: false, command: string, exitCode: number, outputTail: string, message: string }}
 */
import fs from 'fs';
import path from 'path';
import { runTestCommand, runFullTestSuite } from './regression.js';
import config from '../infra/config.js';

// The shipped defaults of config.execution.testCommand / testAllCommand
// (must match infra/config.js). Declared locally per the archive.js-mirrored
// dichotomy — this module does not import archive.js's constant.
const DEFAULT_TEST_COMMAND = 'npm test';
const DEFAULT_TEST_ALL_COMMAND = 'npm run test:all';

/**
 * Returns true iff projectRoot/package.json is readable, valid JSON, and has
 * a non-empty scripts[scriptName] entry. Fails soft (false) on any error —
 * an unreadable/absent/malformed package.json is "no script", not a crash.
 *
 * @param {string} projectRoot
 * @param {string} scriptName
 * @returns {boolean}
 */
function hasPackageScript(projectRoot, scriptName) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    return !!(pkg.scripts && pkg.scripts[scriptName]);
  } catch {
    return false; // no readable package.json — nothing to gate on
  }
}

/**
 * Builds the { ok: false, ... } result for a failing (non-zero or timed-out)
 * command run. exitCode === -1 gets a distinct TIMEOUT message (the suite
 * did not finish — not a failing test); any other non-zero exit gets the
 * standard failure message naming the command, exit code, cwd, output tail,
 * and the two honest causes: the tests genuinely fail, or the configured
 * command is wrong/unrunnable in this environment.
 *
 * @param {string} command
 * @param {{ exitCode: number, output: string }} result
 * @param {string} projectRoot
 * @returns {{ ok: false, command: string, exitCode: number, outputTail: string, message: string }}
 */
function buildFailureResult(command, result, projectRoot) {
  const outputTail = (result.output || '').slice(-2000);
  const exitCode = result.exitCode;

  if (exitCode === -1) {
    return {
      ok: false,
      command,
      exitCode,
      outputTail,
      message:
        `Baseline gate TIMED OUT: \`${command}\` did not complete before the timeout ` +
        `(cwd: ${projectRoot}). The suite did not finish running — this is NOT a failing test. ` +
        `Refusing to spend before the baseline is proven green. Re-run when the machine is quiet.\n` +
        `--- tail of test output ---\n${outputTail}`,
    };
  }

  return {
    ok: false,
    command,
    exitCode,
    outputTail,
    message:
      `Baseline gate failed: \`${command}\` exited ${exitCode} (cwd: ${projectRoot}). ` +
      `Refusing to spend before the baseline is proven green. Two honest causes: either the tests ` +
      `genuinely fail, or the configured command is wrong/unrunnable in this environment — launch ` +
      `cc-orch from the environment where the command works (e.g. the activated venv), or fix the ` +
      `command in .cc-orch.json.\n` +
      `--- tail of test output ---\n${outputTail}`,
  };
}

/**
 * Runs the pre-spend baseline gate for projectRoot. See module doc for the
 * full contract.
 *
 * @param {string} projectRoot
 * @returns {{ ok: true, skipped: string[] }
 *         | { ok: false, command: string, exitCode: number, outputTail: string, message: string }}
 */
export function runBaselineGate(projectRoot) {
  try {
    const skipped = [];

    const smokeCommand = config.execution.testCommand;
    const fullCommand = config.execution.testAllCommand;
    const identical = smokeCommand === fullCommand;

    // --- Smoke slot (config.execution.testCommand, default `npm test`) ---
    const smokeSkip = smokeCommand === DEFAULT_TEST_COMMAND && !hasPackageScript(projectRoot, 'test');
    if (smokeSkip) {
      console.log(`[baseline] No \`test\` script in target — skipping baseline gate for \`${smokeCommand}\`.`);
      skipped.push(smokeCommand);
    } else {
      console.log(`[baseline] Baseline gate: running \`${smokeCommand}\`...`);
      const smokeResult = runTestCommand(projectRoot);
      if (smokeResult.exitCode !== 0) {
        return buildFailureResult(smokeCommand, smokeResult, projectRoot);
      }
      console.log(`[baseline] Baseline gate: \`${smokeCommand}\` passed.`);
    }

    // Identical-command dedup: the full slot is the exact same command as
    // the smoke slot already just decided (run-and-passed, or skipped) —
    // never re-evaluate or re-run it.
    if (identical) {
      return { ok: true, skipped };
    }

    // --- Full slot (config.execution.testAllCommand, default `npm run test:all`) ---
    const fullSkip = fullCommand === DEFAULT_TEST_ALL_COMMAND && !hasPackageScript(projectRoot, 'test:all');
    if (fullSkip) {
      console.log(`[baseline] No \`test:all\` script in target — skipping baseline gate for \`${fullCommand}\`.`);
      skipped.push(fullCommand);
    } else {
      console.log(`[baseline] Baseline gate: running \`${fullCommand}\`...`);
      const fullResult = runFullTestSuite(projectRoot);
      if (fullResult.exitCode !== 0) {
        return buildFailureResult(fullCommand, fullResult, projectRoot);
      }
      console.log(`[baseline] Baseline gate: \`${fullCommand}\` passed.`);
    }

    return { ok: true, skipped };
  } catch (err) {
    // Never throw across the boundary — an unexpected crash inside the gate
    // itself (not the commands it runs) still yields a result object.
    return {
      ok: false,
      command: undefined,
      exitCode: undefined,
      outputTail: '',
      message: `Baseline gate crashed unexpectedly: ${err && err.message ? err.message : String(err)}`,
    };
  }
}
