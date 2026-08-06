/**
 * regression-verdict-filter.js — fail-closed downgrade of a regression
 * verifier's FAILED verdict when every reported finding is attributable to
 * pending (not-yet-completed) scope rather than to work this batch actually
 * touched.
 *
 * A regression verifier runs against the FULL working tree, so a FAILED
 * verdict may be caused entirely by files that are still pending (not yet
 * executed in this batch) rather than by a regression the completed work
 * introduced. This gate identifies that narrow, provably-safe case and lets
 * the caller downgrade the verdict — but only when EVERY finding's file is
 * both pending-scoped AND in a file-state that proves the completed work
 * did not touch it (never existed anywhere, or pre-existing and untouched),
 * AND every FAIL-status hard/task-scope check textually references at least
 * one such file.
 *
 * Fail-closed is absolute: any ambiguity, missing data, or git/fs error
 * yields `{ downgrade: false }`. This module MUST NEVER throw.
 *
 * Public API:
 *   shouldDowngradeRegressionFail({ structured, pendingTargetFiles, projectRoot, completedAffectedFiles })
 *     → { downgrade: boolean, reason: string, downgradedFindings: object[] }
 *   stripTreePurityChecks(structured)
 *     → { structured: object, strippedChecks: object[] }
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isTreePurityShapeText } from './plan-structure-lint.js';

/** Run git with argv (no shell — paths never reach a shell). */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Whether `cwd` is inside a usable git working tree. This is checked UPFRONT
 * (distinct from the per-file `git cat-file -e HEAD:F` probe, whose non-zero
 * exit is a meaningful positive signal within a real repo) so that a
 * non-git projectRoot — where every git invocation fails for the wrong
 * reason — cannot be misread as "file absent from HEAD" and fails closed
 * instead.
 */
function isGitWorkingTree(cwd) {
  try {
    return git(['rev-parse', '--is-inside-work-tree'], cwd).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Whether git HEAD has a blob at path F (i.e. F exists in the HEAD commit).
 * Returns false on any git error (not a repo, git unavailable, etc.) — the
 * caller treats that as "cannot prove never-existed" and fails closed.
 */
function existsInHead(file, cwd) {
  try {
    git(['cat-file', '-e', `HEAD:${file}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether F differs from HEAD in the working tree (tracked modification).
 * Returns true (treated as "dirty"/unsafe) on any git error, so ambiguity
 * fails closed toward NOT downgrading.
 */
function isDirtyVsHead(file, cwd) {
  try {
    git(['diff', 'HEAD', '--quiet', '--', file], cwd);
    return false;
  } catch {
    return true;
  }
}

/**
 * Whether `check` is a FAIL-status check whose joined text matches a
 * tree-purity shape (via `isTreePurityShapeText`). The joined text is
 * `name` + `evidence` for `arrayName === 'hardChecks'`, and `description` +
 * `evidence` for `arrayName === 'taskScopeChecks'` / `'standardsChecks'`.
 * Missing or non-string fields contribute an empty string rather than
 * throwing. Deliberate difference from the plan lint: the
 * behavioral-marker blanket exemption is NOT applied here, so a shape
 * match after backtick stripping is sufficient. Returns false for any
 * other input (null/non-object check, non-FAIL status, no shape match, or
 * any unexpected error). Never throws. No fs access, no process spawn, no
 * session/LLM call.
 *
 * @param {object|null|undefined} check
 * @param {string} arrayName - 'hardChecks' | 'taskScopeChecks' | 'standardsChecks'
 * @returns {boolean}
 */
function _isPurityFailCheck(check, arrayName) {
  try {
    if (!check || typeof check !== 'object') return false;
    if (check.status !== 'FAIL') return false;

    const first = arrayName === 'hardChecks'
      ? check.name
      : check.description;
    const evidence = check.evidence;

    const firstText = typeof first === 'string' ? first : '';
    const evidenceText = typeof evidence === 'string' ? evidence : '';
    const joined = `${firstText} ${evidenceText}`;

    return isTreePurityShapeText(joined);
  } catch {
    return false;
  }
}

/**
 * Decide whether a FAILED regression verdict should be downgraded because
 * every finding is attributable to pending (untouched) scope.
 *
 * @param {object} params
 * @param {object|null|undefined} params.structured - the regression
 *   verifier's structured_output (regressionVerifierSchema shape).
 * @param {string[]} params.pendingTargetFiles - target files not yet
 *   completed in this batch.
 * @param {string} params.projectRoot - git working tree root.
 * @param {string[]} params.completedAffectedFiles - files already reported
 *   as affected by completed executor tasks in this batch.
 * @returns {{ downgrade: boolean, reason: string, downgradedFindings: object[] }}
 */
export function shouldDowngradeRegressionFail({
  structured,
  pendingTargetFiles,
  projectRoot,
  completedAffectedFiles,
} = {}) {
  try {
    // (a) structured present, FAILED-style verdict, non-empty findings,
    // every finding has a string `file`.
    if (!structured || typeof structured !== 'object') {
      return { downgrade: false, reason: 'No structured verdict present.', downgradedFindings: [] };
    }
    if (structured.result !== 'FAILED') {
      return { downgrade: false, reason: 'Verdict is not FAILED.', downgradedFindings: [] };
    }
    const findings = Array.isArray(structured.findings) ? structured.findings : [];
    if (findings.length === 0) {
      return { downgrade: false, reason: 'No findings to attribute to pending scope.', downgradedFindings: [] };
    }
    for (const f of findings) {
      if (!f || typeof f.file !== 'string' || f.file.length === 0) {
        return { downgrade: false, reason: 'A finding is missing a string `file` field.', downgradedFindings: [] };
      }
    }

    const pending = Array.isArray(pendingTargetFiles) ? pendingTargetFiles : [];
    if (pending.length === 0) {
      return { downgrade: false, reason: 'No pending target files to attribute findings to.', downgradedFindings: [] };
    }
    const pendingSet = new Set(pending);

    const completed = Array.isArray(completedAffectedFiles) ? completedAffectedFiles : [];
    const completedSet = new Set(completed);

    if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
      return { downgrade: false, reason: 'No project root provided.', downgradedFindings: [] };
    }
    if (!isGitWorkingTree(projectRoot)) {
      return { downgrade: false, reason: 'projectRoot is not a git working tree.', downgradedFindings: [] };
    }

    // (b) every finding's file is pending-scoped.
    for (const f of findings) {
      if (!pendingSet.has(f.file)) {
        return {
          downgrade: false,
          reason: `Finding file "${f.file}" is not in pendingTargetFiles.`,
          downgradedFindings: [],
        };
      }
    }

    // (c) every finding's file satisfies the two-arm file-state predicate.
    for (const f of findings) {
      const file = f.file;

      let onDisk;
      try {
        onDisk = fs.existsSync(path.join(projectRoot, file));
      } catch {
        return { downgrade: false, reason: `Unable to check filesystem state for "${file}".`, downgradedFindings: [] };
      }

      const inHead = existsInHead(file, projectRoot);
      const neverExisted = !onDisk && !inHead;

      if (neverExisted) continue;

      // Pre-existing-and-untouched arm requires F to exist in HEAD.
      if (!inHead) {
        // On disk but not in HEAD and not "never existed" — ambiguous
        // (e.g. untracked new file). Fail closed.
        return {
          downgrade: false,
          reason: `File "${file}" is untracked/new and not provably untouched.`,
          downgradedFindings: [],
        };
      }

      const dirty = isDirtyVsHead(file, projectRoot);
      const untouchedInBatch = !completedSet.has(file);

      if (dirty || !untouchedInBatch) {
        return {
          downgrade: false,
          reason: `File "${file}" is modified relative to HEAD or was completed in this batch.`,
          downgradedFindings: [],
        };
      }
    }

    // (d) FAIL-check coverage: every FAIL-status hardCheck/taskScopeCheck
    // must textually contain (substring) at least one downgraded finding's
    // file path.
    const findingFiles = findings.map((f) => f.file);
    const hardChecks = Array.isArray(structured.hardChecks) ? structured.hardChecks : [];
    const taskScopeChecks = Array.isArray(structured.taskScopeChecks) ? structured.taskScopeChecks : [];
    const allChecks = [...hardChecks, ...taskScopeChecks];

    for (const check of allChecks) {
      if (!check || check.status !== 'FAIL') continue;
      const haystack = `${check.name || ''} ${check.description || ''} ${check.evidence || ''}`;
      const covered = findingFiles.some((file) => haystack.includes(file));
      if (!covered) {
        return {
          downgrade: false,
          reason: 'A FAIL-status check does not reference any downgraded finding\'s file path.',
          downgradedFindings: [],
        };
      }
    }

    return {
      downgrade: true,
      reason: 'All findings are attributable to pending, untouched scope and every FAIL check references a downgraded file.',
      downgradedFindings: findings,
    };
  } catch {
    // Never throw — any unexpected error fails closed.
    return { downgrade: false, reason: 'Unexpected error evaluating regression verdict downgrade.', downgradedFindings: [] };
  }
}

/**
 * Strip tree-purity-shaped FAIL checks out of a regression verdict, and
 * flip a FAILED verdict to PASSED when doing so removes every remaining
 * FAIL-status check.
 *
 * Walks `hardChecks`, `taskScopeChecks` and `standardsChecks` (in that
 * order) and removes every entry for which `_isPurityFailCheck` returns
 * true, recording each removal — in encounter order — as
 * `{ array: 'hardChecks' | 'taskScopeChecks' | 'standardsChecks', check }`
 * where `check` is the original check object as it appeared in the
 * verdict. `structured.result` becomes `'PASSED'` only when ALL of the
 * following hold: the input `result` was `'FAILED'`, at least one check
 * was stripped, and no `status === 'FAIL'` entry remains across the three
 * arrays afterward; otherwise `result` is carried through unchanged (in
 * particular, a FAILED verdict from which nothing was stripped comes back
 * unchanged with an empty `strippedChecks`). `findings` and every other
 * top-level property are carried through as-is. The input object (and its
 * check arrays) are never mutated.
 *
 * A `null`/`undefined`/non-object input (including arrays and primitives)
 * is returned unchanged, paired with an empty `strippedChecks`. This
 * function is pure and deterministic: no fs access, no process spawn, no
 * session/LLM call, and it never throws.
 *
 * @param {object|null|undefined} structured - a regression verifier's
 *   structured_output (regressionVerifierSchema shape).
 * @returns {{ structured: object, strippedChecks: Array<{ array: string, check: object }> }}
 */
export function stripTreePurityChecks(structured) {
  try {
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
      return { structured, strippedChecks: [] };
    }

    const strippedChecks = [];
    const next = { ...structured };
    const arrayNames = ['hardChecks', 'taskScopeChecks', 'standardsChecks'];

    for (const arrayName of arrayNames) {
      const original = structured[arrayName];
      if (!Array.isArray(original)) continue;

      const kept = [];
      for (const check of original) {
        if (_isPurityFailCheck(check, arrayName)) {
          strippedChecks.push({ array: arrayName, check });
        } else {
          kept.push(check);
        }
      }
      next[arrayName] = kept;
    }

    const anyFailRemains = arrayNames.some(
      (arrayName) => Array.isArray(next[arrayName]) && next[arrayName].some((c) => c && c.status === 'FAIL'),
    );

    if (structured.result === 'FAILED' && strippedChecks.length > 0 && !anyFailRemains) {
      next.result = 'PASSED';
    }

    return { structured: next, strippedChecks };
  } catch {
    return { structured, strippedChecks: [] };
  }
}
