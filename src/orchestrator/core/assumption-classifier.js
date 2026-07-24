/**
 * Benign-uncertain classifier for the batch assumption gate.
 *
 * A small whitelist of recurring inspector tool-limit shapes. When an
 * uncertain verdict's evidence text matches one of these categories, the
 * uncertainty is mechanical (the inspector hit a tool boundary) rather than a
 * real open question — the batch assumption gate may auto-waive it instead of
 * parking for a human.
 *
 * Pure data + one pure function. No I/O, no Pipeline coupling.
 *
 * IMPORTANT — pattern breadth: every pattern MUST be specific enough that it
 * does NOT match the synthetic evidence used by existing park tests
 * (`stub`, `stubbed evidence for "..."`). NEVER add a bare word fragment such
 * as /stub/i, /evidence/i, or /branch/i — only concrete multi-word
 * inspector-limit phrases. Categories are data, extensible without code change.
 */

/**
 * @typedef {{ key: string, label: string, patterns: RegExp[] }} BenignCategory
 */

/** @type {BenignCategory[]} */
export const BENIGN_CATEGORIES = [
  {
    key: 'inspector-cannot-execute',
    label: 'Inspector cannot execute code/tests',
    patterns: [
      /cannot execute/i,
      /cannot be executed/i,
      /runtime verification is not possible/i,
      /cannot run the test suite/i,
    ],
  },
  {
    key: 'inspector-cannot-access-git-history',
    label: 'Inspector cannot access git history',
    patterns: [
      /git history is not accessible/i,
      /commit history is not accessible/i,
      /commit hash not searchable/i,
      /no reference to commit [0-9a-f]{6,} found/i,
      /cannot verify what .* looked like before/i,
    ],
  },
  {
    key: 'cross-spec-or-planning-claim',
    label: 'Cross-spec or planning/meta claim',
    patterns: [
      /process\/meta claim/i,
      /organizational/i,
      /cannot be confirmed or denied purely from code/i,
      /spec intent/i,
      /forward-looking claim about a spec/i,
    ],
  },
  {
    key: 'inspector-cannot-trace-full-path',
    label: 'Inspector did not trace the full path',
    patterns: [
      /did not trace the full/i,
      /could not trace/i,
      /have not inspected/i,
      /would need to inspect/i,
    ],
  },
];

/**
 * Classify an uncertain verdict's evidence against the benign whitelist.
 *
 * Reads `verdict.evidence` (a string). Returns the FIRST category (in
 * BENIGN_CATEGORIES order) whose any pattern tests the evidence, as
 * `{ key, label }`. Returns null when evidence is missing/empty/non-string,
 * or when no category matches (the signal to park).
 *
 * Pure: does NOT inspect `verdict.status` — status gating (uncertain-only,
 * never failed) is the caller's responsibility.
 *
 * @param {{ evidence?: * }} verdict
 * @returns {{ key: string, label: string } | null}
 */
export function classifyBenignUncertain(verdict) {
  const evidence = verdict?.evidence;
  if (typeof evidence !== 'string' || evidence.length === 0) return null;

  for (const category of BENIGN_CATEGORIES) {
    for (const pattern of category.patterns) {
      if (pattern.test(evidence)) {
        return { key: category.key, label: category.label };
      }
    }
  }
  return null;
}
