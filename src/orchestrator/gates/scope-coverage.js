/**
 * scope-coverage.js — Scope item coverage check (mapping-based).
 *
 * Pure JS. Verifies that every extracted scope item is claimed by at least one
 * VALID mission, using an explicit planner-authored `scopeItemId -> missionIds`
 * mapping carried on the plan object. This replaces the prior after-the-fact
 * lexical matcher (substring + distinctive-keyword guessing) that produced
 * false positives on symmetric/parallel scope sections. The gate's job is
 * unchanged (防漏: every scope item claimed by >=1 mission); only the source of
 * truth moves from a re-derived lexical guess to a declaration the gate trusts
 * structurally. ID-based shape mirrors the scenario-coverage gate in
 * coverage.js (ID set vs annotations).
 *
 * Public API:
 *   checkScopeCoverageByMapping(scopeItems, scopeMapping, validMissionIds)
 *     → { covered: { id, label }[], uncovered: string[] (labels) }
 *
 * Context-only exemption: a scope item whose `contextOnly` property is
 * strictly `true` is treated as covered-by-declaration. Such items are never
 * pushed to `uncovered` — regardless of whether they are unmapped, mapped
 * with an empty `missionIds` array, or mapped to a dangling/invalid mission
 * id — and are always reported in `covered` as `{ id, label }`. Mapping a
 * context-only item to valid missions is not an error either; it is still
 * simply covered, with no additional output field. Items without
 * `contextOnly: true` are unaffected and keep the strict ALL-valid decision
 * described below.
 */

/**
 * Check whether each scope item is covered by the planner-declared mapping.
 *
 * A scope item is COVERED iff there is a mapping entry whose
 * `scopeItemId === item.id`, whose `missionIds` is a non-empty array, and
 * EVERY id in `missionIds` is a member of `validMissionIds`. Strict "ALL
 * valid": a single dangling/invalid missionId makes that item UNCOVERED
 * (dangling-ref -> not covered; closes the referential-integrity gap JSON
 * schema cannot enforce). Mis-assignment to a wrong-but-existing mission is an
 * accepted residual (防漏 not 防错配).
 *
 * Exception: a scope item whose `contextOnly` property is strictly `true` is
 * exempt from the above and is ALWAYS covered-by-declaration, regardless of
 * mapping state (unmapped, empty missionIds, or dangling missionIds). It is
 * reported in `covered` and never in `uncovered`.
 *
 * Never throws.
 *
 * @param {Array<{ id: string, label: string, source: string, contextOnly?: boolean }>} scopeItems
 * @param {Array<{ scopeItemId: string, missionIds: string[] }>} scopeMapping
 *   May be undefined or [].
 * @param {Set<string>|string[]} validMissionIds
 *   The plan's mission ids; normalised internally to a Set.
 * @returns {{ covered: Array<{ id: string, label: string }>, uncovered: string[] }}
 *   covered: covered items (used only for a count log).
 *   uncovered: the LABELS of uncovered items.
 */
export function checkScopeCoverageByMapping(scopeItems, scopeMapping, validMissionIds) {
  const items = Array.isArray(scopeItems) ? scopeItems : [];
  const mapping = Array.isArray(scopeMapping) ? scopeMapping : [];
  const validSet = validMissionIds instanceof Set
    ? validMissionIds
    : new Set(Array.isArray(validMissionIds) ? validMissionIds : []);

  // Index mapping entries by scopeItemId for O(1) lookup. On duplicate
  // scopeItemId entries, first-seen wins (deterministic; the gate trusts the
  // declaration but does not need to merge).
  const byScopeItemId = new Map();
  for (const entry of mapping) {
    if (!entry || typeof entry.scopeItemId !== 'string') continue;
    if (!byScopeItemId.has(entry.scopeItemId)) {
      byScopeItemId.set(entry.scopeItemId, entry);
    }
  }

  const covered = [];
  const uncovered = [];

  for (const item of items) {
    if (item.contextOnly === true) {
      covered.push({ id: item.id, label: item.label });
      continue;
    }

    const entry = byScopeItemId.get(item.id);
    const missionIds = entry && Array.isArray(entry.missionIds) ? entry.missionIds : null;
    const isCovered =
      missionIds !== null &&
      missionIds.length > 0 &&
      missionIds.every((mid) => validSet.has(mid));

    if (isCovered) {
      covered.push({ id: item.id, label: item.label });
    } else {
      uncovered.push(item.label);
    }
  }

  return { covered, uncovered };
}
