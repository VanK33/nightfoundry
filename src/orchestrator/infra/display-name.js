/**
 * display-name.js — Resolve the CLI display name from how the process was
 * invoked (the basename of process.argv[1]).
 *
 * Lives in the infra layer so BOTH the CLI layer (usage/help/version, hints)
 * and core-layer user-facing messages (pipeline refusals, breaker hints, the
 * status-bar banner) can render the invoked name without a core→CLI import.
 *
 * Legacy invocations via the `cc-orch` alias keep seeing `cc-orch` in every
 * message; everything else (including library/test contexts) renders the
 * primary brand `nightfoundry`.
 *
 * @param {string} [argv1=process.argv[1]]
 * @returns {'cc-orch' | 'nightfoundry'}
 */
import path from 'path';

export function displayName(argv1 = process.argv[1]) {
  return path.basename(argv1 || '') === 'cc-orch' ? 'cc-orch' : 'nightfoundry';
}
