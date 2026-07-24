/**
 * path-utils.js — Utility helpers for resolving file paths within a project.
 *
 * Public API:
 *   normalizeTargetFile(projectRoot, file)  → string (absolute path)
 */

import path from 'path';

/**
 * Resolves a target file path against the project root, returning an absolute path.
 *
 * If `file` is already absolute, it is returned as-is (path.resolve behaviour).
 * Relative paths (including those with `../` segments) are resolved relative to
 * `projectRoot`.
 *
 * @param {string} projectRoot - The absolute path to the project root directory.
 * @param {string} file        - A relative or absolute file path to normalise.
 * @returns {string} The resolved absolute file path.
 */
export function normalizeTargetFile(projectRoot, file) {
  return path.resolve(projectRoot, file);
}
