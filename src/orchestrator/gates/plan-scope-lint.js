/**
 * plan-scope-lint.js — Plan-vs-spec declared-scope lint.
 *
 * Pure JS. Mirrors the pure, defensive-normalization style of
 * scope-coverage.js in this directory. Compares the paths a plan's tasks
 * actually target against a "declared set" derived from the spec (its
 * authoritative `target_files` plus every path token embedded in a
 * `kind=command` acceptance criterion's verification command) and the
 * per-check coverage of each acceptance command whose path tokens
 * scope it onto an emitted task, and flags:
 *
 *   - a task targets a path NOT in the declared set (a HARD scope
 *     excursion — the plan is doing work the spec never declared), and
 *   - a task carries a scoped acceptance command whose path tokens
 *     name a file no emitted task actually targets (HARD per-check
 *     coverage — 2d-iii renaming class caught at plan time), and
 *   - at planGlobal, an acceptance command whose path tokens map into
 *     no mission's declared targetFiles (HARD pure-omission — the 165
 *     class that per-mission checks cannot see across their siblings).
 *
 * Path comparison reuses the planner's existing `resolveSpecPathAnchor`
 * case/suffix candidate detection (no new path regex is introduced) plus a
 * `projectRoot`-resolved absolute-path equivalence fallback, so a path that
 * differs from a declared path only by case, by a directory-prefix suffix
 * relationship, or by being resolvable to the same absolute file under
 * `opts.projectRoot`, is NOT treated as a violation.
 *
 * Public API:
 *   buildDeclaredSet(specTargetFiles, specAcceptanceCriteria) → Set<string>
 *     Declared-path set: specTargetFiles ∪ path tokens extracted (via the
 *     planner's extractPathTokens) from every checkable, kind='command'
 *     acceptance criterion's verification.command. Never throws.
 *   lintPlanScope(plan, declaredSet, opts) → void
 *     THROWS on a hard excursion (task's targetFile outside the declared
 *     set) OR on a per-scoped-check coverage miss (a token in an
 *     acceptance command that `scopeSpecHardChecks` assigned to some
 *     emitted task is not equivalent to ANY emitted targetFile in this
 *     plan). Pure omission — an acceptance command that maps to no
 *     emitted task at ALL — is invisible at this per-mission emit site
 *     by design; that is `lintGlobalPlanScope`'s job.
 *   lintGlobalPlanScope(globalPlan, specTargetFiles, specAcceptanceCriteria, opts) → void
 *     THROWS at planGlobal time when a non-milestone-only acceptance
 *     command's path tokens are covered by NO mission's declared
 *     `targetFiles` across the plan — the pure-omission class that
 *     per-mission lintPlanScope cannot see. Empty missions/ACs no-op.
 *   checkScopeMappingConsistency(plan, scopeMapping, opts) → Array<{severity, category, description}>
 *     Advisory check over the planner-authored scopeItemId → missionIds
 *     mapping (malformed entries, duplicate scopeItemId entries, and
 *     missionId references that don't resolve to a subMission in `plan`),
 *     plus (when `opts.scopeItems` and `opts.currentMissionId` are
 *     provided) a spec-driven file-vs-mission consistency advisory:
 *     an emitted task whose targetFiles include a path a scope item's
 *     text names for a mapping-DIFFERENT mission produces a warning.
 *     Returns plain warning objects and NEVER throws.
 */
import path from 'path';
import {
  extractPathTokens,
  resolveSpecPathAnchor,
  isCheckableCriterion,
  scopeSpecHardChecks,
  isMilestoneOnlyCheck,
} from '../agents/planner.js';
import { PlanLintError } from './plan-structure-lint.js';

/**
 * Builds the declared-path set from the spec's authoritative target_files
 * plus path tokens embedded in checkable, kind='command' acceptance
 * criteria verification commands. Acceptance criteria with kind='manual' or
 * kind='file-check' (no `command`) contribute nothing here.
 *
 * Never throws: non-array/undefined inputs are treated as empty.
 *
 * @param {string[]} specTargetFiles - The spec's authoritative target_files.
 * @param {Array<object>} specAcceptanceCriteria - The spec's acceptance_criteria entries.
 * @returns {Set<string>}
 */
export function buildDeclaredSet(specTargetFiles, specAcceptanceCriteria) {
  const declared = new Set();

  const targetFiles = Array.isArray(specTargetFiles) ? specTargetFiles : [];
  for (const f of targetFiles) {
    if (typeof f === 'string' && f.length > 0) declared.add(f);
  }

  const criteria = Array.isArray(specAcceptanceCriteria) ? specAcceptanceCriteria : [];
  for (const item of criteria) {
    if (!isCheckableCriterion(item)) continue;
    const v = item.verification;
    if (v.kind !== 'command') continue;
    for (const token of extractPathTokens(v.command)) {
      declared.add(token);
    }
  }

  return declared;
}

/**
 * Pairwise path equivalence used by both directions of lintPlanScope.
 * Two paths are equivalent when:
 *   - they are identical strings, or
 *   - the planner's resolveSpecPathAnchor case/suffix candidate detection
 *     finds `pathB` as a candidate for `pathA` (case-insensitive exact
 *     match, or a directory-prefix suffix relationship in either
 *     direction) — resolveSpecPathAnchor is deliberately invoked with a
 *     null projectRoot here so its own projectRoot-driven "already same
 *     file, no violation" collapse-to-null never masks a genuine
 *     candidate match, or
 *   - `opts.projectRoot` is provided and both paths resolve (via
 *     `path.resolve(projectRoot, p)`) to the same absolute file.
 *
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
 * Whether `candidate` is within the declared set, exactly or via
 * `_pathsEquivalent` against any member of `declaredSet`.
 *
 * @param {string} candidate
 * @param {Set<string>} declaredSet
 * @param {string|null} projectRoot
 * @returns {boolean}
 */
function _isDeclaredEquivalent(candidate, declaredSet, projectRoot) {
  if (declaredSet.has(candidate)) return true;
  for (const declaredPath of declaredSet) {
    if (_pathsEquivalent(candidate, declaredPath, projectRoot)) return true;
  }
  return false;
}

/**
 * Collects all task arrays from the three known plan shapes:
 * subMissions[].tasks, replacementTasks, newTasks. Mirrors the collection
 * logic in planner.js's `_validatePathAnchorPreservation`.
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

const _SHELL_CONNECTOR_TOKENS = new Set(['&&', '||', ';', '|']);
const _ASSIGNMENT_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Gathers the set of CLEANED path tokens that are exempt from the
 * per-scoped-check coverage requirement in lintPlanScope's coverage loop:
 *   - argv[0] of the whole command, and argv[0] of each segment following
 *     a standalone shell-connector token (&&, ||, ;, |) — in both cases
 *     skipping any leading assignment tokens (VAR=value) when locating
 *     argv[0]; and
 *   - every assignment token (VAR=value) found anywhere in the command.
 *
 * Each raw candidate token is cleaned via the planner's shared
 * `extractPathTokens`, which returns [] for non-path-like runners (grep,
 * node, npm) and for URLs/directories, so only genuinely path-like
 * runners/config-values end up exempt. Consults no filesystem state beyond
 * what `extractPathTokens` itself already does. Never throws.
 *
 * @param {string} command
 * @param {string|null} [projectRoot]
 * @returns {Set<string>}
 */
function _exemptCommandTokens(command, projectRoot) {
  const exempt = new Set();
  if (typeof command !== 'string' || command.length === 0) return exempt;

  const rawTokens = command.split(/\s+/).filter((t) => t.length > 0);
  const candidateRawTokens = new Set();

  // Every assignment token anywhere in the command.
  for (const t of rawTokens) {
    if (_ASSIGNMENT_TOKEN_RE.test(t)) candidateRawTokens.add(t);
  }

  // argv[0] of the whole command, and of each segment following a
  // standalone shell-connector token — skipping leading assignment tokens.
  let segmentStart = 0;
  for (let i = 0; i <= rawTokens.length; i++) {
    const atBoundary = i === rawTokens.length || _SHELL_CONNECTOR_TOKENS.has(rawTokens[i]);
    if (!atBoundary) continue;
    let j = segmentStart;
    while (j < i && _ASSIGNMENT_TOKEN_RE.test(rawTokens[j])) j++;
    if (j < i) candidateRawTokens.add(rawTokens[j]);
    segmentStart = i + 1;
  }

  for (const raw of candidateRawTokens) {
    for (const cleaned of extractPathTokens(raw, projectRoot)) {
      exempt.add(cleaned);
    }
  }

  return exempt;
}

/**
 * Lints a plan's task targetFiles against a declared-path set. This is the
 * HARD check: it throws (rather than returning a result) on either
 * violation direction so the caller halts the plan.
 *
 *   (a) Hard excursion: a task's targetFile is not in `declaredSet` and is
 *       not equivalent (case/suffix/projectRoot-resolved) to any member of
 *       it. Throws naming the offending task id and path.
 *   (b) Per-scoped-check coverage: an acceptance command that
 *       `scopeSpecHardChecks` assigned to some emitted task has a path
 *       token equivalent to NO emitted task's targetFile across the whole
 *       plan. Throws naming the command and the uncovered token.
 *
 * PURE-OMISSION IS DELIBERATELY INVISIBLE HERE. A command whose tokens
 * map to no emitted task at all (the 165 class: no task anywhere targets
 * the AC path) has no scoping edge into this per-mission plan, so it
 * cannot fire at a per-emit site without cross-mission blindness. Its
 * home is `lintGlobalPlanScope`, which sees mission-level targetFiles.
 *
 * @param {object} plan - Planner output (subMissions / replacementTasks / newTasks).
 * @param {Set<string>|string[]} declaredSet - Declared-path set, e.g. from buildDeclaredSet.
 * @param {{ projectRoot?: string, specTargetFiles?: string[], specAcceptanceCriteria?: object[] }} [opts]
 * @throws {Error} On either violation direction.
 */
export function lintPlanScope(plan, declaredSet, opts = {}) {
  const declared = declaredSet instanceof Set
    ? declaredSet
    : new Set(Array.isArray(declaredSet) ? declaredSet : []);
  const projectRoot = typeof opts?.projectRoot === 'string' && opts.projectRoot.length > 0
    ? opts.projectRoot
    : null;
  const specTargetFiles = Array.isArray(opts?.specTargetFiles) ? opts.specTargetFiles : [];
  const specAcceptanceCriteria = Array.isArray(opts?.specAcceptanceCriteria) ? opts.specAcceptanceCriteria : [];

  const taskArrays = _collectTaskArrays(plan);
  const allEmitted = [];
  const flatTasks = [];

  // (a) Every task targetFile must fall within (or be equivalent to) the
  // declared set — no hard excursions. Collect-all: the excursion pass
  // COMPLETES (in today's scan order — do not reorder) gathering every
  // excursion before throwing; the thrown message is the first
  // violation's text, byte-identical to before. The coverage pass below
  // is only reached when no excursion exists, exactly as before.
  const excursionViolations = [];
  let firstExcursionMessage = null;
  for (const tasks of taskArrays) {
    for (const task of tasks) {
      if (!task) continue;
      flatTasks.push(task);
      if (!Array.isArray(task.targetFiles)) continue;
      const taskId = typeof task.id === 'string' && task.id.length > 0 ? task.id : null;
      for (const emitted of task.targetFiles) {
        if (typeof emitted !== 'string' || emitted.length === 0) continue;
        allEmitted.push(emitted);
        if (!_isDeclaredEquivalent(emitted, declared, projectRoot)) {
          excursionViolations.push({ ruleId: 'scope-excursion', taskId, offending: emitted });
          if (firstExcursionMessage === null) {
            firstExcursionMessage =
              `[plan-scope-lint] scope excursion: task "${task.id || '?'}" targets "${emitted}" ` +
              'which is outside the spec-declared scope set';
          }
        }
      }
    }
  }
  if (excursionViolations.length > 0) {
    throw new PlanLintError(firstExcursionMessage, 'scope-excursion', excursionViolations);
  }

  // (b) Per-scoped-check coverage: for every acceptance command
  // scopeSpecHardChecks assigns to some emitted task, EVERY path token
  // in that command must be covered by some emitted targetFile in this
  // plan. Multi-token checks catch the 2d-iii class (one token overlaps
  // → scoped; another token is unmet → throw).
  if (flatTasks.length > 0 && specAcceptanceCriteria.length > 0) {
    const checkableChecks = [];
    for (const item of specAcceptanceCriteria) {
      if (!isCheckableCriterion(item)) continue;
      const v = item.verification;
      if (v.kind !== 'command') continue;
      checkableChecks.push({ name: item.description, command: v.command });
    }
    if (checkableChecks.length > 0) {
      // Collect-all: gather every uncovered token (in today's scan order)
      // before throwing; the thrown message is the first violation's text.
      const coverageViolations = [];
      let firstCoverageMessage = null;
      const scopedMap = scopeSpecHardChecks(checkableChecks, flatTasks, specTargetFiles, projectRoot);
      for (const task of flatTasks) {
        const assigned = scopedMap.get(task.id);
        if (!Array.isArray(assigned) || assigned.length === 0) continue;
        const taskId = typeof task.id === 'string' && task.id.length > 0 ? task.id : null;
        for (const check of assigned) {
          const tokens = extractPathTokens(check.command, projectRoot);
          const exemptTokens = _exemptCommandTokens(check.command, projectRoot);
          for (const token of tokens) {
            if (exemptTokens.has(token)) continue;
            const covered = allEmitted.some(
              (emitted) => emitted === token || _pathsEquivalent(emitted, token, projectRoot),
            );
            if (!covered) {
              coverageViolations.push({ ruleId: 'uncovered-token', taskId, offending: token });
              if (firstCoverageMessage === null) {
                firstCoverageMessage =
                  `[plan-scope-lint] scoped acceptance command "${check.command}" references ` +
                  `"${token}" not covered by any task's targetFiles`;
              }
            }
          }
        }
      }
      if (coverageViolations.length > 0) {
        throw new PlanLintError(firstCoverageMessage, 'uncovered-token', coverageViolations);
      }
    }
  }
}

/**
 * planGlobal-time pure-omission catcher. Collects the union of every
 * mission's declared `targetFiles` across a globalPlan and, for each
 * non-milestone-only acceptance command, requires ≥1 of its path tokens
 * to be equivalent to a member of that union. Missionless-milestones,
 * missing targetFiles, and milestone-only commands are silently
 * tolerated.
 *
 * Accepts either `globalPlan.milestones[].missions[]` (canonical
 * planGlobal schema) or `globalPlan.missions[]` (flattened test
 * fixtures). Empty missions / empty ACs no-op.
 *
 * @param {object} globalPlan
 * @param {string[]} specTargetFiles
 * @param {Array<object>} specAcceptanceCriteria
 * @param {{ projectRoot?: string }} [opts]
 * @throws {Error} When a non-milestone-only command's path tokens are
 *   covered by no mission's targetFiles at all.
 */
export function lintGlobalPlanScope(globalPlan, specTargetFiles, specAcceptanceCriteria, opts = {}) {
  const projectRoot = typeof opts?.projectRoot === 'string' && opts.projectRoot.length > 0
    ? opts.projectRoot
    : null;

  const missionTargetFiles = [];
  const missionFiles = new Set();
  const collectMission = (mission) => {
    if (!mission || !Array.isArray(mission.targetFiles)) return;
    for (const f of mission.targetFiles) {
      if (typeof f === 'string' && f.length > 0) {
        missionFiles.add(f);
        missionTargetFiles.push(f);
      }
    }
  };
  if (globalPlan && Array.isArray(globalPlan.milestones)) {
    for (const ms of globalPlan.milestones) {
      if (ms && Array.isArray(ms.missions)) {
        for (const m of ms.missions) collectMission(m);
      }
    }
  }
  if (globalPlan && Array.isArray(globalPlan.missions)) {
    for (const m of globalPlan.missions) collectMission(m);
  }

  if (missionFiles.size === 0) return;

  const criteria = Array.isArray(specAcceptanceCriteria) ? specAcceptanceCriteria : [];
  const specTargets = Array.isArray(specTargetFiles) ? specTargetFiles : [];
  // Collect-all: gather every uncovered command (in today's scan order)
  // before throwing; the thrown message is the first violation's text.
  const globalViolations = [];
  let firstGlobalMessage = null;
  for (const item of criteria) {
    if (!isCheckableCriterion(item)) continue;
    const v = item.verification;
    if (v.kind !== 'command') continue;
    const check = { name: item.description, command: v.command };
    if (isMilestoneOnlyCheck(check, specTargets, projectRoot)) continue;
    const tokens = extractPathTokens(v.command, projectRoot);
    if (tokens.length === 0) continue;
    const covered = tokens.some((token) =>
      missionTargetFiles.some(
        (mf) => mf === token || _pathsEquivalent(mf, token, projectRoot),
      ),
    );
    if (!covered) {
      globalViolations.push({ ruleId: 'global-uncovered-token', taskId: null, offending: v.command });
      if (firstGlobalMessage === null) {
        firstGlobalMessage =
          `[plan-scope-lint] acceptance command "${v.command}" is not covered by any mission's targetFiles`;
      }
    }
  }
  if (globalViolations.length > 0) {
    throw new PlanLintError(firstGlobalMessage, 'global-uncovered-token', globalViolations);
  }
}

/**
 * Advisory check over the planner-authored scopeItemId → missionIds
 * mapping (existing shape warnings) plus an optional spec-driven
 * file-vs-mission consistency advisory. Flags:
 *   - malformed entries, duplicate scopeItemId entries, and missionId
 *     references that don't resolve to a subMission id declared on `plan`;
 *   - (when `opts.scopeItems` and `opts.currentMissionId` are provided)
 *     any emitted task whose targetFiles include a path a scope item's
 *     text names for a mapping-DIFFERENT mission — a warning.
 *
 * NEVER throws — returns an array of plain warning objects
 * ({ severity, category, description }), mirroring the warnings-ledger
 * entry shape used elsewhere in the codebase (e.g.
 * core/pipeline.js's blast-radius advisory warnings).
 *
 * @param {object} plan - Planner output (subMissions carry valid mission ids).
 * @param {Array<{ scopeItemId: string, missionIds: string[] }>} scopeMapping
 * @param {{ scopeItems?: Array<{ id: string, text?: string, label?: string }>, currentMissionId?: string, projectRoot?: string }} [opts]
 * @returns {Array<{ severity: string, category: string, description: string }>}
 */
export function checkScopeMappingConsistency(plan, scopeMapping, opts = {}) {
  const warnings = [];
  try {
    const mapping = Array.isArray(scopeMapping) ? scopeMapping : [];

    const validMissionIds = new Set();
    if (plan && Array.isArray(plan.subMissions)) {
      for (const sm of plan.subMissions) {
        if (sm && typeof sm.id === 'string' && sm.id.length > 0) validMissionIds.add(sm.id);
      }
    }

    const seenScopeItemIds = new Set();
    for (const entry of mapping) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        warnings.push({
          severity: 'warning',
          category: 'scope-mapping-consistency',
          description: 'Scope mapping entry is not a valid object.',
        });
        continue;
      }

      if (typeof entry.scopeItemId !== 'string' || entry.scopeItemId.length === 0) {
        warnings.push({
          severity: 'warning',
          category: 'scope-mapping-consistency',
          description: 'Scope mapping entry is missing a valid scopeItemId.',
        });
        continue;
      }

      if (seenScopeItemIds.has(entry.scopeItemId)) {
        warnings.push({
          severity: 'warning',
          category: 'scope-mapping-consistency',
          description: `Duplicate scope mapping entry for scopeItemId "${entry.scopeItemId}".`,
        });
      }
      seenScopeItemIds.add(entry.scopeItemId);

      const missionIds = Array.isArray(entry.missionIds) ? entry.missionIds : null;
      if (!missionIds || missionIds.length === 0) {
        warnings.push({
          severity: 'warning',
          category: 'scope-mapping-consistency',
          description: `Scope mapping entry for scopeItemId "${entry.scopeItemId}" has no missionIds.`,
        });
        continue;
      }

      for (const missionId of missionIds) {
        if (typeof missionId !== 'string' || !validMissionIds.has(missionId)) {
          warnings.push({
            severity: 'warning',
            category: 'scope-mapping-consistency',
            description: `Scope mapping entry for scopeItemId "${entry.scopeItemId}" references ` +
              `unknown missionId "${String(missionId)}".`,
          });
        }
      }
    }

    // File-vs-mission advisory (spec Design point 3): when a scope item's
    // text names a path AND the mapping assigns it to a different mission
    // than the current one, an emitted task in this plan that targets
    // that path is a mission-boundary inconsistency worth surfacing.
    // Skips silently when scopeItems / currentMissionId are absent — those
    // sites deliberately opt out (mapping shape check only).
    const scopeItems = Array.isArray(opts?.scopeItems) ? opts.scopeItems : null;
    const currentMissionId = typeof opts?.currentMissionId === 'string' && opts.currentMissionId.length > 0
      ? opts.currentMissionId
      : null;
    const projectRoot = typeof opts?.projectRoot === 'string' && opts.projectRoot.length > 0
      ? opts.projectRoot
      : null;

    if (scopeItems && currentMissionId) {
      const flatTasks = _collectTaskArrays(plan).flat();
      for (const entry of mapping) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        if (typeof entry.scopeItemId !== 'string' || entry.scopeItemId.length === 0) continue;
        const missionIds = Array.isArray(entry.missionIds) ? entry.missionIds : [];
        if (missionIds.length === 0) continue;
        if (missionIds.includes(currentMissionId)) continue; // same mission → no cross-boundary issue
        const item = scopeItems.find((s) => s && s.id === entry.scopeItemId);
        if (!item) continue;
        const itemText = typeof item.text === 'string' ? item.text
          : typeof item.label === 'string' ? item.label
          : '';
        if (!itemText) continue;
        const paths = extractPathTokens(itemText, projectRoot);
        if (paths.length === 0) continue;
        for (const task of flatTasks) {
          if (!task || !Array.isArray(task.targetFiles)) continue;
          for (const tf of task.targetFiles) {
            if (typeof tf !== 'string' || tf.length === 0) continue;
            const hit = paths.some(
              (p) => p === tf || _pathsEquivalent(p, tf, projectRoot),
            );
            if (hit) {
              warnings.push({
                severity: 'warning',
                category: 'scope-mapping-consistency',
                description:
                  `task "${task.id || '?'}" targets "${tf}" which scopeMapping assigns to ` +
                  `mission(s) ${missionIds.join(', ')} (current: ${currentMissionId})`,
              });
            }
          }
        }
      }
    }
  } catch (_err) {
    // Advisory check — never throw.
  }
  return warnings;
}
