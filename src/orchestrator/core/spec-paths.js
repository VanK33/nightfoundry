import path from 'path';

/**
 * Derive the spec.json path for a given prdPath.
 *
 * If prdPath is a `.md` file, the sibling `.json` is used; otherwise the
 * project-root `spec.json` is used. Factored out of applySpecHardChecks so the
 * derivation has a single source shared with _detectUncheckableSpec.
 *
 * @param {string} prdPath - resolved spec/PRD path (may be falsy)
 * @param {string} projectRoot - absolute path to project root
 * @returns {string} absolute-or-relative spec.json path
 */
export function deriveSpecJsonPath(prdPath, projectRoot) {
  return (prdPath && prdPath.endsWith('.md'))
    ? prdPath.replace(/\.md$/, '.json')
    : path.join(projectRoot, 'spec.json');
}
