/**
 * infra-hint.js — Computes a resumability-hint string for infrastructure
 * errors encountered by the CLI. Performs no process.exit and no error
 * classification; it only computes the hint string based on batch mode and
 * whether an active (resumable) run exists.
 *
 * Public API:
 *   infraErrorHint({ batch, projectRoot }) → string, resumability hint
 */

import { resolveActiveHarnessDir } from '../orchestrator/core/run-context.js';

/**
 * Returns a resumability-hint string for an infrastructure error.
 *
 * - When `batch` is truthy, points at `cc-orch resume --batch`.
 * - When `batch` is falsy and an active run exists (resolveActiveHarnessDir
 *   returns non-null), returns the bare-resume guidance naming
 *   `cc-orch resume`.
 * - When `batch` is falsy and no active run exists (resolveActiveHarnessDir
 *   returns null), returns a message that does not name bare
 *   `cc-orch resume`.
 *
 * @param {{ batch: boolean, projectRoot: string }} params
 * @returns {string}
 */
export function infraErrorHint({ batch, projectRoot }) {
  if (batch) {
    return 'Infrastructure error (API down/rate limited). State saved. Run `cc-orch resume --batch` when ready.';
  }

  if (resolveActiveHarnessDir(projectRoot) !== null) {
    return 'Infrastructure error (API down/rate limited). State saved. Run `cc-orch resume` when ready.';
  }

  return 'Infrastructure error (API down/rate limited). No active run to resume.';
}
