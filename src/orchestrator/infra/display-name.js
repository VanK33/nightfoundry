/**
 * display-name.js — The CLI display name.
 *
 * Lives in the infra layer so BOTH the CLI layer (usage/help/version, hints)
 * and core-layer user-facing messages can render the brand without a
 * core→CLI import. The legacy `cc-orch` alias was removed in v0.3; the name
 * is now constant, and the function survives as the single seam every
 * consumer already imports.
 *
 * @returns {'nightfoundry'}
 */
export function displayName() {
  return 'nightfoundry';
}
