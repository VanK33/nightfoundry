/**
 * run-marker.js — Pure module providing a stable identifier for the current
 * orchestrator process, and a helper to stamp that identifier into a child
 * process's environment.
 *
 * Used by a future guard that reads process.env[CC_ORCH_ACTIVE_RUN] to detect
 * whether a spawned process belongs to an active orchestrator run. This
 * module only computes values — it performs no I/O and has no side effects
 * beyond memoizing the identifier in module-local state.
 *
 * Public API:
 *   CC_ORCH_ACTIVE_RUN            — env-var key constant, 'CC_ORCH_ACTIVE_RUN'
 *   getRunMarker()                → string, memoized per process
 *   withRunMarkerEnv(baseEnv)     → new object, baseEnv + marker key set
 */

export const CC_ORCH_ACTIVE_RUN = 'CC_ORCH_ACTIVE_RUN';

let cachedRunMarker;

/**
 * Returns a stable, non-empty string identifier for the current orchestrator
 * process. Memoized so repeated calls within the same process return the
 * identical value.
 *
 * @returns {string}
 */
export function getRunMarker() {
  if (cachedRunMarker === undefined) {
    cachedRunMarker = String(process.pid);
  }
  return cachedRunMarker;
}

/**
 * Returns a NEW object that is a shallow merge of baseEnv with the run
 * marker key set to getRunMarker(). All other entries from baseEnv are
 * preserved unchanged.
 *
 * @param {object} [baseEnv=process.env]
 * @returns {object}
 */
export function withRunMarkerEnv(baseEnv = process.env) {
  return { ...baseEnv, [CC_ORCH_ACTIVE_RUN]: getRunMarker() };
}
