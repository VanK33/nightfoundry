/**
 * coupled-files.js — Glob-style matching of project-root-relative file paths.
 *
 * Public API:
 *   matchesGlob(filePath, pattern)  → boolean
 *   expandCoupledTargets(targetFiles, coupledRules)  → string[]
 */

/**
 * Escapes all regular-expression metacharacters in `str` so it can be used
 * literally inside a `RegExp` source string.
 *
 * @param {string} str - The raw string to escape.
 * @returns {string} The escaped string, safe for literal inclusion in a RegExp.
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Determines whether a project-root-relative, forward-slash-delimited file
 * path matches a glob-style pattern.
 *
 * The pattern language supports exactly two metaconstructs:
 *   - `*`  matches any run of characters WITHIN one path segment (never crosses `/`).
 *   - `**` matches any run of characters ACROSS segments (may cross `/`).
 * Every other character — including `.`, `?`, `+`, `(`, `)`, `[`, `]`, `{`, `}`,
 * `^`, `$`, `|`, and `\` — is treated literally. The match is anchored to the
 * full path (implicit `^...$`).
 *
 * @param {string} filePath - The project-root-relative, forward-slash path to test.
 * @param {string} pattern  - The glob-style pattern to match against.
 * @returns {boolean} True when `filePath` matches `pattern`; false otherwise
 *   (including when either argument is not a non-empty string).
 */
export function matchesGlob(filePath, pattern) {
  if (typeof filePath !== 'string' || filePath === '') return false;
  if (typeof pattern !== 'string' || pattern === '') return false;

  const escaped = escapeRegExp(pattern);
  const withPlaceholders = escaped
    .replace(/\\\*\\\*/g, '\u0000DOUBLESTAR\u0000')
    .replace(/\\\*/g, '\u0000STAR\u0000');
  const regexSource = withPlaceholders
    .replace(/\u0000DOUBLESTAR\u0000/g, '[\\s\\S]*')
    .replace(/\u0000STAR\u0000/g, '[^/]*');

  const regex = new RegExp(`^${regexSource}$`);
  return regex.test(filePath);
}

/**
 * Expands a list of target files with the `alsoTarget` paths of any coupled
 * rule whose `when` glob pattern matches at least one of the given target
 * files.
 *
 * The original `targetFiles` entries are always included first, in their
 * original order. Then, for every rule in `coupledRules` (in order) whose
 * `when` pattern matches at least one entry of `targetFiles`, each path in
 * that rule's `alsoTarget` array is appended — skipping any path already
 * present in the result (whether from the original `targetFiles` or from an
 * earlier rule). Malformed rules (missing/invalid `when` or `alsoTarget`)
 * are skipped without throwing.
 *
 * This function is pure: it never mutates `targetFiles`, `coupledRules`, or
 * any rule object/array, and always returns a new array.
 *
 * @param {string[]} targetFiles - The project-root-relative paths to expand.
 * @param {Array<{when: string, alsoTarget: string[]}>} [coupledRules] - The
 *   coupling rules to apply.
 * @returns {string[]} A new array containing `targetFiles` followed by the
 *   deduplicated `alsoTarget` paths of every matching rule. Returns `[]`
 *   when `targetFiles` is not an array.
 */
export function expandCoupledTargets(targetFiles, coupledRules) {
  if (!Array.isArray(targetFiles)) return [];

  const result = [...targetFiles];
  const seen = new Set(targetFiles);

  if (!Array.isArray(coupledRules)) return result;

  for (const rule of coupledRules) {
    if (rule === null || typeof rule !== 'object') continue;
    const { when, alsoTarget } = rule;
    if (typeof when !== 'string' || when === '') continue;
    if (!Array.isArray(alsoTarget)) continue;

    const matched = targetFiles.some((file) => matchesGlob(file, when));
    if (!matched) continue;

    for (const path of alsoTarget) {
      if (typeof path !== 'string' || path === '') continue;
      if (seen.has(path)) continue;
      seen.add(path);
      result.push(path);
    }
  }

  return result;
}
