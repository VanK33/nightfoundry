/**
 * plan-structure-lint.js — Plan-time structural lint for the
 * planner-constraint defect family ("ONE milestone ONE mission",
 * "one dedicated task per named deliverable", tree-purity check shapes).
 *
 * Pure JS. Mirrors the pure, defensive-normalization style of
 * plan-scope-lint.js in this directory. No fs, no session calls;
 * `extractPathTokens` is used in PURE MODE (invoked with no `projectRoot`
 * argument) throughout this module. plan-scope-lint.js is left entirely
 * unmodified — its private helpers stay private; the path-equivalence
 * wrapper below is re-derived locally per the normative definition rather
 * than imported.
 *
 * Public API:
 *   PlanLintError — structured lint error (ruleId + violations[]) thrown
 *     by every rejection leg in this module and plan-scope-lint.js.
 *     Messages stay byte-identical to the previous plain-Error text.
 *   lintPlanStructure(globalPlan, specPlanStructure, opts) → void
 *     THROWS a PlanLintError prefixed `[plan-structure-lint]` when:
 *       L1/L2 — `specPlanStructure` is a plain object carrying integer
 *         `max_missions` / `max_milestones` AND the plan's total mission
 *         count / milestone count exceeds it. Absent or malformed
 *         `specPlanStructure` (not a plain object, or non-integer fields)
 *         skips L1/L2 entirely — no throw.
 *       L3 (unconditional) — two DIFFERENT missions in the SAME milestone
 *         declare path-equivalent `targetFiles` (exemption:
 *         `scripts/run-tests.js`). Cross-milestone duplication is legal
 *         and not checked here.
 *     Returns undefined ("pass") otherwise.
 *   lintTaskCheckShapes(plan, opts) → void
 *     THROWS a PlanLintError prefixed `[plan-structure-lint]` when a task's
 *     `testCases[]` string entry matches a tree-purity check shape (T1 or
 *     T2, see below) with no applicable exemption. Returns undefined
 *     ("pass") otherwise.
 *   warnCrossMissionDuplicates(plan, siblingTaskTargetsByMission, opts) → Array
 *     NEVER throws. Returns an array of plain warning objects
 *     ({ severity: 'warning', category: 'cross-mission-duplicate',
 *     description }) for every emitted task targetFile (excluding
 *     `scripts/run-tests.js`) that is path-equivalent to a same-milestone
 *     sibling mission's already-planned task targetFile.
 *
 * Traversal (normative, mirrors planner.js's `_warnIfRejectedBehavior`
 * ~:1378-1392): the task-level functions (`lintTaskCheckShapes`,
 * `warnCrossMissionDuplicates`) iterate `plan.subMissions[].tasks[]`,
 * `plan.replacementTasks[]`, `plan.newTasks[]`. `lintPlanStructure`
 * operates one level up, over `globalPlan.milestones[].missions[]`
 * (canonical planGlobal schema) or `globalPlan.missions[]` (flattened
 * test fixtures, treated as a single implicit milestone).
 *
 * Tree-purity check shapes (`lintTaskCheckShapes`):
 *   Exemption 1 — behavioral marker (checked FIRST, whole testCase
 *     exempt): an arrow (`→`/`->`) or a behavioral verb
 *     (return(s)/throw(s)/call(s)/emit(s)/assert(s)/pass(es)/green/
 *     print(s)/log(s)/exit(s)/resolve(s)/reject(s)) anywhere in the raw
 *     testCase text. Disclosed KNOWN-ESCAPE: a marker-co-occurring
 *     tree-purity shape (e.g. "…must pass UNMODIFIED", exempted via
 *     'pass') escapes detection by construction — CHECK-SHAPE rule (this
 *     module) is the interim defense; measured ~80 across the archive
 *     corpus.
 *   Exemption 2 — backtick literals ONLY: tree-state/modification
 *     phrases found strictly inside backtick-delimited literal spans are
 *     exempt. Backtick spans are maximal left-to-right pairs
 *     (`` /`[^`]*`/g ``); an unpaired ("stray") backtick opens NO span
 *     (fail-closed). Quote characters (`"`, emphasis `*`/`_`, etc.) never
 *     open an exemption span. Disclosed KNOWN-ESCAPE: backticks placed
 *     around the bare predicate word alone exempt that occurrence by
 *     construction (measured 0/2,689 archive testCases do this).
 *   T1 (non-exempt) — a modification-status predicate
 *     (unchanged/unmodified/untouched/not-(be)-modified|changed|edited|
 *     touched) with NO content word (bytes/content/structure/behavior/
 *     signature/semantics/API) within the two whitespace-tokens
 *     immediately preceding it, co-occurring with ≥1 `extractPathTokens`
 *     (pure mode) token carrying a dot-extension (`/\.[a-z0-9]{1,5}$/i`)
 *     that is NOT path-equivalent to any of the task's own `targetFiles`.
 *   T2 (non-exempt) — literal tree-state shapes, checked regardless of
 *     targetFile membership ("even in-target"): only-X-
 *     modified|edited|changed|touched; "no test file(s)"; "no other/new/
 *     additional file(s)" or "no file(s) other than|besides|except"; bare
 *     git-status/git-diff/working-tree + clean|dirty|empty assertions.
 */
import path from 'path';
import { extractPathTokens, resolveSpecPathAnchor } from '../agents/planner.js';

/**
 * PlanLintError — structured lint rejection carrying a rule id and the
 * full list of violations of that rule found in the plan.
 *
 * The thrown `message` remains the FIRST violation's text, byte-identical
 * to the plain-Error message thrown before this class existed, so
 * message-prefix consumers and existing tests are unaffected. Consumers
 * classify by the PRESENCE of `err.ruleId` (duck-typing), never
 * instanceof — this class is defined here and imported by
 * plan-scope-lint.js purely to share the constructor shape.
 *
 * `violations[]` elements carry `{ ruleId, taskId, offending }` where
 * `taskId` is null when not applicable and `offending` is the violating
 * testCase/target text verbatim.
 */
export class PlanLintError extends Error {
  /**
   * @param {string} message - First violation's message text (byte-identical to the legacy plain-Error message).
   * @param {string} ruleId - The violated rule id (e.g. 'T1', 'T2', 'scope-excursion').
   * @param {Array<{ ruleId: string, taskId: (string|null), offending: string }>} violations
   */
  constructor(message, ruleId, violations) {
    super(message);
    this.name = 'PlanLintError';
    this.ruleId = ruleId;
    this.violations = Array.isArray(violations) ? violations : [];
  }
}

/**
 * Path-equivalence wrapper — re-derived locally (normative definition;
 * plan-scope-lint.js's own `_pathsEquivalent` stays private and is NOT
 * imported). Two paths are equivalent when they are the exact same
 * string, OR `resolveSpecPathAnchor` (invoked with a null projectRoot)
 * finds one as a case/suffix candidate of the other, OR `projectRoot` is
 * provided and both paths `path.resolve` to the same absolute file.
 * Never throws.
 *
 * @param {string} pathA
 * @param {string} pathB
 * @param {string|null} projectRoot
 * @returns {boolean}
 */
function _pathsEquivalent(pathA, pathB, projectRoot) {
  if (pathA === pathB) return true;
  const candidateSet = new Set([pathB]);
  const candidateLowerMap = new Map([[pathB.toLowerCase(), pathB]]);
  if (resolveSpecPathAnchor(pathA, candidateSet, candidateLowerMap, null) !== null) return true;
  if (typeof projectRoot === 'string' && projectRoot.length > 0) {
    if (path.resolve(projectRoot, pathA) === path.resolve(projectRoot, pathB)) return true;
  }
  return false;
}

/**
 * Strict same-file test: exact string equality OR, when projectRoot is
 * provided, both paths `path.resolve` to the same absolute file. Unlike
 * `_pathsEquivalent`, this does NOT use suffix/case matching — that matches
 * `pkg/__init__.py` against `tests/pkg/__init__.py` (a suffix), which are
 * DIFFERENT files under a standard package layout and must not be treated
 * as duplicates. Used by the cross-mission duplicate checks (L3 throw and
 * the WARN observer), where "the same file declared twice" must mean the
 * same file, not merely a shared path suffix. Never throws.
 *
 * @param {string} pathA
 * @param {string} pathB
 * @param {string|null} projectRoot
 * @returns {boolean}
 */
function _pathsSameFile(pathA, pathB, projectRoot) {
  if (pathA === pathB) return true;
  if (typeof projectRoot === 'string' && projectRoot.length > 0) {
    if (path.resolve(projectRoot, pathA) === path.resolve(projectRoot, pathB)) return true;
  }
  return false;
}

const _RUN_TESTS_EXEMPT_PATH = 'scripts/run-tests.js';

/**
 * Collects all task arrays from the three known plan shapes:
 * subMissions[].tasks, replacementTasks, newTasks. Mirrors planner.js's
 * `_warnIfRejectedBehavior` (~:1378-1392) collection logic.
 *
 * @param {object} plan
 * @returns {Array<Array<object>>}
 */
function _collectTaskArrays(plan) {
  const allTaskArrays = [];
  if (plan && Array.isArray(plan.subMissions)) {
    for (const sm of plan.subMissions) {
      if (sm && Array.isArray(sm.tasks)) allTaskArrays.push(sm.tasks);
    }
  }
  if (plan && Array.isArray(plan.replacementTasks)) allTaskArrays.push(plan.replacementTasks);
  if (plan && Array.isArray(plan.newTasks)) allTaskArrays.push(plan.newTasks);
  return allTaskArrays;
}

/**
 * Returns true iff `value` is a plain object (not null, not an array).
 *
 * @param {*} value
 * @returns {boolean}
 */
function _isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Groups missions by milestone. Accepts either
 * `globalPlan.milestones[].missions[]` (canonical planGlobal schema) or
 * `globalPlan.missions[]` (flattened test fixtures, treated as a single
 * implicit milestone group). Never throws.
 *
 * @param {object} globalPlan
 * @returns {Array<Array<{ id: string, targetFiles: string[] }>>} One inner
 *   array per milestone, each entry a mission's { id, targetFiles }.
 */
function _collectMilestoneMissionGroups(globalPlan) {
  const groups = [];
  const toMissionEntry = (m) => ({
    id: typeof m?.id === 'string' && m.id.length > 0 ? m.id : '?',
    targetFiles: Array.isArray(m?.targetFiles)
      ? m.targetFiles.filter((f) => typeof f === 'string' && f.length > 0)
      : [],
  });

  if (globalPlan && Array.isArray(globalPlan.milestones)) {
    for (const ms of globalPlan.milestones) {
      const missions = [];
      if (ms && Array.isArray(ms.missions)) {
        for (const m of ms.missions) {
          if (m) missions.push(toMissionEntry(m));
        }
      }
      groups.push(missions);
    }
  } else if (globalPlan && Array.isArray(globalPlan.missions)) {
    const missions = [];
    for (const m of globalPlan.missions) {
      if (m) missions.push(toMissionEntry(m));
    }
    groups.push(missions);
  }

  return groups;
}

/**
 * planGlobal-time structural lint: mission/milestone leg counts (L1/L2,
 * conditional on a spec-declared `specPlanStructure`) and same-milestone
 * declared-duplicate `targetFiles` across missions (L3, unconditional).
 *
 * @param {object} globalPlan - Planner planGlobal output (milestones[].missions[] or flattened missions[]).
 * @param {*} specPlanStructure - Spec-declared `{ max_missions, max_milestones }`, or absent/malformed.
 * @param {{ projectRoot?: string }} [opts]
 * @throws {Error} Prefixed `[plan-structure-lint]` on an L1/L2 or L3 violation.
 */
export function lintPlanStructure(globalPlan, specPlanStructure, opts = {}) {
  const projectRoot = typeof opts?.projectRoot === 'string' && opts.projectRoot.length > 0
    ? opts.projectRoot
    : null;

  const milestoneGroups = _collectMilestoneMissionGroups(globalPlan);

  // L1/L2 — only enforced when specPlanStructure is a plain object with
  // integer max_missions/max_milestones; absent/malformed → skipped.
  if (_isPlainObject(specPlanStructure)) {
    let missionCount = 0;
    for (const missions of milestoneGroups) missionCount += missions.length;
    const milestoneCount = milestoneGroups.length;

    if (Number.isInteger(specPlanStructure.max_missions) && missionCount > specPlanStructure.max_missions) {
      const message =
        `[plan-structure-lint] mission count ${missionCount} exceeds spec-declared ` +
        `max_missions ${specPlanStructure.max_missions}`;
      // A cap rule has exactly one violation per plan (the single count);
      // there is no per-testCase/target text, so `offending` carries the
      // violation description.
      throw new PlanLintError(message, 'structure-cap-missions', [
        { ruleId: 'structure-cap-missions', taskId: null, offending: message },
      ]);
    }
    if (Number.isInteger(specPlanStructure.max_milestones) && milestoneCount > specPlanStructure.max_milestones) {
      const message =
        `[plan-structure-lint] milestone count ${milestoneCount} exceeds spec-declared ` +
        `max_milestones ${specPlanStructure.max_milestones}`;
      throw new PlanLintError(message, 'structure-cap-milestones', [
        { ruleId: 'structure-cap-milestones', taskId: null, offending: message },
      ]);
    }
  }

  // L3 (unconditional) — two different missions in the SAME milestone
  // declaring path-equivalent targetFiles. scripts/run-tests.js is exempt.
  // Cross-milestone duplication is legal (each milestone group checked
  // independently). Collect-all: the scan gathers EVERY duplicate pair
  // (in today's scan order — do not reorder) before throwing; the thrown
  // message is the first violation's text, byte-identical to before.
  const duplicateViolations = [];
  let firstDuplicateMessage = null;
  for (const missions of milestoneGroups) {
    for (let i = 0; i < missions.length; i++) {
      for (let j = i + 1; j < missions.length; j++) {
        const a = missions[i];
        const b = missions[j];
        for (const pathA of a.targetFiles) {
          if (pathA === _RUN_TESTS_EXEMPT_PATH) continue;
          for (const pathB of b.targetFiles) {
            if (pathB === _RUN_TESTS_EXEMPT_PATH) continue;
            if (_pathsSameFile(pathA, pathB, projectRoot)) {
              duplicateViolations.push({ ruleId: 'declared-duplicate', taskId: null, offending: pathA });
              if (firstDuplicateMessage === null) {
                firstDuplicateMessage =
                  `[plan-structure-lint] declared-duplicate targetFile: mission "${a.id}" and ` +
                  `mission "${b.id}" in the same milestone both declare "${pathA}"`;
              }
            }
          }
        }
      }
    }
  }
  if (duplicateViolations.length > 0) {
    throw new PlanLintError(firstDuplicateMessage, 'declared-duplicate', duplicateViolations);
  }
}

// Arrow markers and behavioral verbs (with common s/es plural forms) that
// exempt a whole testCase from T1/T2 shape checking (Exemption 1).
const _ARROW_MARKER_RE = /→|->/;
const _BEHAVIORAL_MARKER_RE =
  /\b(returns?|throws?|calls?|emits?|asserts?|passes?|green|prints?|logs?|exits?|resolves?|rejects?)\b/i;

/**
 * Exemption 1 — whether `testCase` carries a behavioral marker anywhere
 * in its raw text (checked before backtick-stripping / shape checks).
 *
 * @param {string} testCase
 * @returns {boolean}
 */
function _hasBehavioralMarker(testCase) {
  return _ARROW_MARKER_RE.test(testCase) || _BEHAVIORAL_MARKER_RE.test(testCase);
}

// Maximal left-to-right backtick pairs; an unpaired backtick matches
// nothing here and is left untouched (fail-closed).
const _BACKTICK_SPAN_RE = /`[^`]*`/g;

/**
 * Exemption 2 — strips maximal backtick-paired literal spans, replacing
 * each with a single space so surrounding tokens don't concatenate. A
 * stray (unpaired) backtick opens no span and is left in place.
 *
 * @param {string} testCase
 * @returns {string}
 */
function _stripBacktickSpans(testCase) {
  return testCase.replace(_BACKTICK_SPAN_RE, ' ');
}

const _T1_PREDICATE_RE = /\b(unchanged|unmodified|untouched|not\s+(?:be\s+)?(?:modified|changed|edited|touched))\b/gi;
const _T1_CONTENT_WORD_RE = /\b(bytes|content|structure|behavior|signature|semantics|api)\b/i;
const _T1_EXTENSION_RE = /\.[a-z0-9]{1,5}$/i;

/**
 * T1 — modification-status predicate with no content word in the two
 * preceding whitespace-tokens, co-occurring with a dot-extension path
 * token not equivalent to any of the task's own targetFiles.
 *
 * @param {string} strippedText - testCase text with backtick spans stripped.
 * @param {string[]} ownTargetFiles - The task's own targetFiles.
 * @param {string|null} projectRoot
 * @returns {boolean}
 */
function _hasT1Violation(strippedText, ownTargetFiles, projectRoot) {
  let match;
  let hasQualifyingPredicate = false;
  _T1_PREDICATE_RE.lastIndex = 0;
  while ((match = _T1_PREDICATE_RE.exec(strippedText)) !== null) {
    const preceding = strippedText.slice(0, match.index).trim();
    const precedingTokens = preceding.length > 0 ? preceding.split(/\s+/) : [];
    const lastTwo = precedingTokens.slice(-2).join(' ');
    if (!_T1_CONTENT_WORD_RE.test(lastTwo)) {
      hasQualifyingPredicate = true;
      break;
    }
  }
  if (!hasQualifyingPredicate) return false;

  const tokens = extractPathTokens(strippedText);
  for (const token of tokens) {
    if (!_T1_EXTENSION_RE.test(token)) continue;
    const isOwn = ownTargetFiles.some(
      (tf) => token === tf || _pathsEquivalent(token, tf, projectRoot),
    );
    if (!isOwn) return true;
  }
  return false;
}

const _T2_ONLY_MODIFIED_RE = /\bonly\b[\s\S]{0,80}?\b(modified|edited|changed|touched)\b/i;
const _T2_NO_TEST_FILES_RE = /\bno\s+test\s+files?\b/i;
const _T2_NO_OTHER_FILES_RE = /\bno\s+(other|new|additional)\s+files?\b/i;
const _T2_NO_FILES_EXCEPT_RE = /\bno\s+files?\s+(other than|besides|except)\b/i;
const _T2_GIT_CLEAN_RE = /\b(git\s+status|git\s+diff|working\s+tree)\b[\s\S]{0,60}?\b(clean|dirty|empty)\b/i;

/**
 * T2 — literal tree-state shapes, checked regardless of targetFile
 * membership ("even in-target").
 *
 * @param {string} strippedText - testCase text with backtick spans stripped.
 * @returns {boolean}
 */
function _hasT2Violation(strippedText) {
  return (
    _T2_ONLY_MODIFIED_RE.test(strippedText) ||
    _T2_NO_TEST_FILES_RE.test(strippedText) ||
    _T2_NO_OTHER_FILES_RE.test(strippedText) ||
    _T2_NO_FILES_EXCEPT_RE.test(strippedText) ||
    _T2_GIT_CLEAN_RE.test(strippedText)
  );
}

/**
 * Lints every task's `testCases[]` string entries for tree-purity check
 * shapes (T1/T2), applying the behavioral-marker and backtick-only
 * exemptions first. Tasks with no `testCases` (or a non-array value) are
 * skipped.
 *
 * @param {object} plan - Planner output (subMissions / replacementTasks / newTasks).
 * @param {{ projectRoot?: string }} [opts]
 * @throws {Error} Prefixed `[plan-structure-lint]` on a non-exempt T1/T2 shape.
 */
export function lintTaskCheckShapes(plan, opts = {}) {
  const projectRoot = typeof opts?.projectRoot === 'string' && opts.projectRoot.length > 0
    ? opts.projectRoot
    : null;

  // Collect-all: the first violation encountered in today's scan order
  // (per-testCase T2-before-T1 — do not reorder) fixes the THROWING rule
  // and the thrown message (byte-identical to before); the scan then
  // continues, gathering every further violation OF THAT RULE across the
  // whole plan before throwing.
  let throwRuleId = null;
  let firstMessage = null;
  const violations = [];

  const taskArrays = _collectTaskArrays(plan);
  for (const tasks of taskArrays) {
    for (const task of tasks) {
      if (!task || !Array.isArray(task.testCases)) continue;
      const ownTargetFiles = Array.isArray(task.targetFiles)
        ? task.targetFiles.filter((f) => typeof f === 'string' && f.length > 0)
        : [];
      const taskId = typeof task.id === 'string' && task.id.length > 0 ? task.id : null;

      for (const testCase of task.testCases) {
        if (typeof testCase !== 'string' || testCase.length === 0) continue;

        // Exemption 1 (checked first): behavioral marker exempts the
        // whole testCase.
        if (_hasBehavioralMarker(testCase)) continue;

        // Exemption 2: backtick-delimited literal spans are stripped
        // before shape checks run.
        const strippedText = _stripBacktickSpans(testCase);

        if ((throwRuleId === null || throwRuleId === 'T2') && _hasT2Violation(strippedText)) {
          if (throwRuleId === null) {
            throwRuleId = 'T2';
            firstMessage =
              `[plan-structure-lint] task "${task.id || '?'}" testCase "${testCase}" asserts a ` +
              'literal tree-state shape (T2), which is out of scope for a task-level check';
          }
          violations.push({ ruleId: 'T2', taskId, offending: testCase });
          continue;
        }

        if ((throwRuleId === null || throwRuleId === 'T1')
          && _hasT1Violation(strippedText, ownTargetFiles, projectRoot)) {
          if (throwRuleId === null) {
            throwRuleId = 'T1';
            firstMessage =
              `[plan-structure-lint] task "${task.id || '?'}" testCase "${testCase}" asserts a ` +
              'modification-status predicate (T1) referencing a file outside its own targetFiles';
          }
          violations.push({ ruleId: 'T1', taskId, offending: testCase });
        }
      }
    }
  }

  if (throwRuleId !== null) {
    throw new PlanLintError(firstMessage, throwRuleId, violations);
  }
}

/**
 * WARN-level observer for cross-mission task duplicates: an emitted task
 * targetFile (excluding `scripts/run-tests.js`) that is path-equivalent
 * to an already-planned same-milestone sibling mission's task targetFile
 * produces a warning naming both missions and the path. NEVER throws —
 * any internal failure (malformed plan / malformed sibling map) yields an
 * empty or partial array instead.
 *
 * @param {object} plan - Planner output for the CURRENT mission (subMissions / replacementTasks / newTasks).
 * @param {Object<string, string[]>} siblingTaskTargetsByMission - Map of
 *   sibling missionId (same milestone) → already-planned task targetFiles.
 * @param {{ projectRoot?: string, missionId?: string }} [opts]
 * @returns {Array<{ severity: string, category: string, description: string }>}
 */
export function warnCrossMissionDuplicates(plan, siblingTaskTargetsByMission, opts = {}) {
  const warnings = [];
  try {
    const projectRoot = typeof opts?.projectRoot === 'string' && opts.projectRoot.length > 0
      ? opts.projectRoot
      : null;
    const currentMissionId = typeof opts?.missionId === 'string' && opts.missionId.length > 0
      ? opts.missionId
      : (plan && typeof plan.id === 'string' && plan.id.length > 0 ? plan.id : '?');

    const siblingMap = _isPlainObject(siblingTaskTargetsByMission) ? siblingTaskTargetsByMission : {};

    const taskArrays = _collectTaskArrays(plan);
    for (const tasks of taskArrays) {
      for (const task of tasks) {
        if (!task || !Array.isArray(task.targetFiles)) continue;
        for (const tf of task.targetFiles) {
          if (typeof tf !== 'string' || tf.length === 0) continue;
          if (tf === _RUN_TESTS_EXEMPT_PATH) continue;

          for (const siblingMissionId of Object.keys(siblingMap)) {
            if (siblingMissionId === currentMissionId) continue;
            const siblingTargets = siblingMap[siblingMissionId];
            if (!Array.isArray(siblingTargets)) continue;

            for (const siblingTf of siblingTargets) {
              if (typeof siblingTf !== 'string' || siblingTf.length === 0) continue;
              if (siblingTf === _RUN_TESTS_EXEMPT_PATH) continue;
              if (_pathsSameFile(tf, siblingTf, projectRoot)) {
                warnings.push({
                  severity: 'warning',
                  category: 'cross-mission-duplicate',
                  description:
                    `task "${task.id || '?'}" (mission "${currentMissionId}") targets "${tf}" ` +
                    `which sibling mission "${siblingMissionId}" also targets in the same milestone`,
                });
              }
            }
          }
        }
      }
    }
  } catch (_err) {
    // Advisory observer — never throw.
  }
  return warnings;
}
