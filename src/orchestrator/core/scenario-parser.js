/**
 * scenario-parser.js — Pure-JS extraction of scenario IDs from spec markdown
 * and from mission state task annotations.
 *
 * Replaces the sed-based parsing in check-scenario-coverage.sh from the
 * original harness-orchestrator skill.
 *
 * A spec file's scenarios live under a heading like `### Scenarios` (any
 * depth H2-H4, typically nested under `## Testing`). Each scenario is a
 * bullet line with an ID like `S1`, `S2`, `SC-1`. The section ends at
 * the next heading of any level.
 *
 * Examples tolerated:
 *   - S1: User can log in
 *   - **S1**: User can log in
 *   - S1 (no description after ID)
 *   * S1: alternate bullet style
 *   - SC-1: hyphenated ID
 *
 * Public API:
 *   extractScenariosFromSpec(specMarkdown)     → string[]
 *   extractCoveredScenarios(missionState)      → Set<string>
 *   diffCoverage(specIds, coveredIds)          → { covered, uncovered }
 */

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const SCENARIOS_HEADING_RE = /^scenarios?$/i;
// Match bullet lines with a scenario ID. Tolerates - or *, optional ** bold,
// ID pattern S\d+ or SC[-_]?\d+ (case-sensitive on the S/SC prefix).
const SCENARIO_BULLET_RE = /^\s*[-*]\s+\**(S(?:C[-_]?)?\d+)\**/;

/**
 * Extract scenario IDs from the spec markdown's Scenarios section.
 *
 * Returns [] if no Scenarios heading is found — the original skill
 * treated "no Scenarios section" as "coverage check not applicable"
 * and we preserve that semantic.
 */
export function extractScenariosFromSpec(specMarkdown) {
  if (typeof specMarkdown !== 'string' || specMarkdown.length === 0) {
    return [];
  }

  const lines = specMarkdown.split('\n');
  let inScenarios = false;
  const ids = [];

  for (const line of lines) {
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const headingText = headingMatch[2];
      if (SCENARIOS_HEADING_RE.test(headingText)) {
        inScenarios = true;
        continue;
      }
      // Any other heading ends the Scenarios section.
      if (inScenarios) {
        inScenarios = false;
      }
      continue;
    }

    if (!inScenarios) continue;

    const bulletMatch = line.match(SCENARIO_BULLET_RE);
    if (bulletMatch) {
      ids.push(bulletMatch[1]);
    }
  }

  // Dedupe while preserving order.
  const seen = new Set();
  const unique = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  return unique;
}

/**
 * Collect the union of tracesScenario across all tasks in a mission state.
 * Missing or non-array tracesScenario fields are treated as empty.
 */
export function extractCoveredScenarios(missionState) {
  const covered = new Set();
  if (!missionState || !missionState.subMissions) return covered;

  for (const subMission of Object.values(missionState.subMissions)) {
    if (!subMission || !subMission.tasks) continue;
    for (const task of Object.values(subMission.tasks)) {
      if (!Array.isArray(task.tracesScenario)) continue;
      for (const id of task.tracesScenario) {
        if (typeof id === 'string' && id.length > 0) {
          covered.add(id);
        }
      }
    }
  }
  return covered;
}

/**
 * Diff spec scenario IDs against the set of covered IDs.
 * Returns covered/uncovered arrays in the original spec order.
 */
export function diffCoverage(specIds, coveredIds) {
  const covered = [];
  const uncovered = [];
  const coveredSet = coveredIds instanceof Set ? coveredIds : new Set(coveredIds);
  for (const id of specIds) {
    if (coveredSet.has(id)) {
      covered.push(id);
    } else {
      uncovered.push(id);
    }
  }
  return { covered, uncovered };
}
