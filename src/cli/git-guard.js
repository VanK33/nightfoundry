/**
 * git-guard.js — Guard helper that verifies a clean git working tree.
 *
 * Walks upward from a given projectRoot looking for a .git/ directory,
 * then inspects the working tree status via `git status --porcelain`.
 *
 * Public API:
 *   MAX_UPWARD_WALK           number  — max directory levels to search upward
 *   gitGuard(projectRoot, opts?) → Promise<{ ok, gitRoot?, reason?, message? }>
 *     opts.noGitRequired  boolean — if true, missing .git/ returns { ok: true, gitRoot: null }
 *     opts.allowDirty     boolean — if true, dirty tree returns { ok: true, gitRoot }
 */
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { ensureGitExcludes } from '../orchestrator/core/git-excludes.js';

export const MAX_UPWARD_WALK = 5;

/**
 * Walk upward from startDir up to maxLevels looking for a .git/ directory.
 * Returns the directory containing .git/, or null if not found.
 *
 * @param {string} startDir
 * @param {number} maxLevels
 * @returns {string|null}
 */
function findGitRoot(startDir, maxLevels) {
  let current = startDir;
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = path.join(current, '.git');
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        return current;
      }
    } catch {
      // .git not found at this level — keep walking
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root
      break;
    }
    current = parent;
  }
  return null;
}

/**
 * Guard that ensures the project lives inside a clean git repository.
 *
 * @param {string} projectRoot  — starting directory for upward .git/ search
 * @param {{ noGitRequired?: boolean, allowDirty?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, gitRoot?: string|null, reason?: string, message?: string }>}
 */
export async function gitGuard(projectRoot, opts = {}) {
  const gitRoot = findGitRoot(projectRoot, MAX_UPWARD_WALK);

  if (!gitRoot) {
    if (opts.noGitRequired) {
      return { ok: true, gitRoot: null };
    }
    return {
      ok: false,
      reason: 'no-git',
      message: `No .git/ directory found within ${MAX_UPWARD_WALK} levels above "${projectRoot}".`,
    };
  }

  ensureGitExcludes(projectRoot);

  // Check for dirty working tree
  let porcelain = '';
  try {
    porcelain = execSync('git status --porcelain', { stdio: ['pipe', 'pipe', 'pipe'],
      cwd: gitRoot,
      encoding: 'utf8',
    }).trim();
  } catch (err) {
    return {
      ok: false,
      reason: 'no-git',
      message: `Failed to run git status in "${gitRoot}": ${err.message}`,
    };
  }

  if (porcelain.length > 0) {
    if (opts.allowDirty) {
      return { ok: true, gitRoot };
    }
    return {
      ok: false,
      reason: 'dirty-tree',
      message: `Working tree in "${gitRoot}" has uncommitted changes.`,
    };
  }

  return { ok: true, gitRoot };
}
