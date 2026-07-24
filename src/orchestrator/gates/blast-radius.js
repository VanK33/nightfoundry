/**
 * blast-radius.js — Symbol-consumer enumeration (textual, over-reporting).
 *
 * Pure JS. No AST parsing, no shell-outs. Given a list of changed symbol
 * names and a project root directory, recursively scans the project's
 * source files (src/, test/, scripts/) from disk and finds every file
 * where a symbol appears as a whole identifier (word-boundary match).
 * This is a deliberately coarse, over-reporting scan — it has no notion
 * of scope, imports, or shadowing, so it will flag files that merely
 * contain the identifier textually, not just files that actually consume
 * the changed definition. Over-reporting is the intended failure mode
 * (防漏 over 防错配): missing a real consumer is worse than flagging a
 * spurious one.
 *
 * Mirrors the pure-JS, defensive-normalization, never-throws style used by
 * scope-coverage.js in this directory, and the fs/path directory-walking
 * idiom used by buildImportGraph in core/import-graph.js: each of the
 * src/, test/, and scripts/ directories under `projectRoot` is resolved
 * and walked recursively; directories that don't exist (or aren't
 * directories) are simply skipped, node_modules is never descended into,
 * and only `.js` files are read.
 *
 * Public API:
 *   enumerateSymbolConsumers(symbols, projectRoot) → Object<string, string[]>
 *     (a plain object keyed by scanned file path, mapping to the
 *     de-duplicated array of changed-symbol names that matched somewhere in
 *     that file's content; files with zero matches are omitted entirely,
 *     and no symbol appears twice in the same file's array)
 *   readChangedSymbols(specJsonPath) → string[]
 *     (reads and JSON.parses the file at `specJsonPath` from disk and
 *     returns its `changed_symbols` string array; never throws)
 */
import fs from 'fs';
import path from 'path';

/**
 * Directories (relative to projectRoot) that are scanned for source files.
 */
const SCAN_DIRS = ['src', 'test', 'scripts'];

/**
 * Escape a string for safe interpolation into a RegExp source.
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Recursively collect absolute paths of `.js` files under `dir`. Skips
 * `node_modules` and hidden directories. Never throws: any error while
 * listing a directory (e.g. a permissions issue) simply yields no files
 * for that directory.
 *
 * @param {string} dir - absolute directory path, assumed to exist.
 * @returns {string[]}
 */
function walkJsFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      results.push(...walkJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Discover and read every `.js` source file under the src/, test/, and
 * scripts/ directories of `projectRoot`. Directories that don't exist are
 * skipped. Unreadable files are skipped rather than throwing.
 *
 * Never throws. Returns `[]` when `projectRoot` is not a non-empty string,
 * or when none of the scan directories exist / contain readable files.
 *
 * @param {string} projectRoot - absolute path to the project root.
 * @returns {Array<{ path: string, content: string }>}
 */
function scanSourceFiles(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return [];

  const files = [];

  for (const scanDir of SCAN_DIRS) {
    let absDir;
    try {
      absDir = path.resolve(projectRoot, scanDir);
    } catch {
      continue;
    }

    let stat;
    try {
      stat = fs.statSync(absDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    for (const absFilePath of walkJsFiles(absDir)) {
      let content;
      try {
        content = fs.readFileSync(absFilePath, 'utf8');
      } catch {
        continue;
      }
      let relPath;
      try {
        relPath = path.relative(projectRoot, absFilePath);
      } catch {
        relPath = absFilePath;
      }
      files.push({ path: relPath, content });
    }
  }

  return files;
}

/**
 * Enumerate, for every source file discovered by recursively scanning the
 * src/, test/, and scripts/ directories under `projectRoot`, which of the
 * given `symbols` occur inside it as a whole identifier (word-boundary
 * match).
 *
 * Word-boundary matching means a symbol like `foo` matches `foo(`, `foo `,
 * `= foo;`, etc., but does NOT match when it is only a substring of a
 * longer identifier, e.g. `foobar` or `barfoo`. This is achieved with a
 * `\b...\b` regex, which is character-class based (word chars: letters,
 * digits, underscore) rather than AST-based, so it deliberately
 * over-reports: it has no awareness of scope, comments, strings, imports,
 * or shadowing. Any textual word-boundary occurrence counts as a consumer.
 *
 * Results are aggregated per file: each scanned file that matches at least
 * one changed symbol appears exactly once in the returned map, keyed by its
 * (project-root-relative) path, with a value that is the de-duplicated
 * array of symbol names that matched somewhere in that file. Files with no
 * matches are omitted entirely, and a given symbol never appears more than
 * once in the same file's array (even if it occurs many times in the file,
 * or is repeated in the input `symbols` list).
 *
 * Never throws. Defensively normalises malformed input to an empty map:
 * a missing/invalid `projectRoot`, empty `symbols`, non-existent scan
 * directories, or unreadable files all yield `{}` rather than throwing.
 *
 * @param {string[]} symbols - Changed symbol names to search for.
 * @param {string} projectRoot - Absolute path to the project root whose
 *   src/, test/, and scripts/ directories are recursively scanned for
 *   `.js` source files.
 * @returns {Object<string, string[]>} A map from file path to the
 *   de-duplicated array of changed-symbol names matched in that file. Only
 *   files with at least one match are present as keys. Returns `{}` when
 *   `symbols` is empty, no source files are found, or no matches are found.
 */
export function enumerateSymbolConsumers(symbols, projectRoot) {
  const symbolList = Array.isArray(symbols) ? symbols : [];
  const fileList = scanSourceFiles(projectRoot);

  const consumersByFile = new Map();

  for (const symbol of symbolList) {
    if (typeof symbol !== 'string' || symbol.length === 0) continue;

    let re;
    try {
      re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    } catch {
      continue;
    }

    for (const file of fileList) {
      if (!file || typeof file.content !== 'string') continue;
      if (re.test(file.content)) {
        let matchedSymbols = consumersByFile.get(file.path);
        if (!matchedSymbols) {
          matchedSymbols = new Set();
          consumersByFile.set(file.path, matchedSymbols);
        }
        matchedSymbols.add(symbol);
      }
    }
  }

  const result = {};
  for (const [filePath, matchedSymbols] of consumersByFile) {
    result[filePath] = Array.from(matchedSymbols);
  }
  return result;
}

/**
 * Lenient reader for a `changed_symbols` payload stored on disk.
 *
 * Reads the file at `specJsonPath`, JSON.parses its contents, and returns
 * the `changed_symbols` string array. Returns `[]` WITHOUT throwing when
 * `specJsonPath` is missing/undefined/null/not a string, when the file does
 * not exist or cannot be read, when its contents are malformed JSON, when
 * the parsed value is not an object, or when `changed_symbols` is absent or
 * not an array.
 *
 * Never throws.
 *
 * @param {string} specJsonPath - Filesystem path to a spec JSON file.
 * @returns {string[]}
 */
export function readChangedSymbols(specJsonPath) {
  if (typeof specJsonPath !== 'string' || specJsonPath.length === 0) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(specJsonPath, 'utf8'));
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }

  return Array.isArray(parsed.changed_symbols) ? parsed.changed_symbols : [];
}
