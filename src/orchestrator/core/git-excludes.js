/**
 * git-excludes.js — Ensure cc-orch artifact patterns exist in a git
 * repository's local (untracked) `.git/info/exclude` file, rooted to the
 * project's location within the repo.
 *
 * Unlike bootstrap.js's ensureGitignoreStanza (which writes a *tracked*
 * .gitignore stanza that ships with the project), this module writes to the
 * repo-local, never-committed info/exclude file — appropriate for artifacts
 * that are specific to running cc-orch against a given checkout rather than
 * something every clone of the repo should ignore.
 *
 * Public API:
 *   ensureGitExcludes(projectRoot) -> boolean
 *     Fail-soft: any failure (non-git root, git unavailable, unwritable
 *     .git/, realpath failure) returns false and never throws, mutating
 *     nothing on the way to that false.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const MARKER = '# cc-orch artifacts (auto-managed)';

// The rooted patterns to ensure, given a prefix ('' when projectRoot IS
// the git toplevel, or '/'+rel when projectRoot is a subdirectory of it).
// Every pattern is rooted (leading slash) so it only matches at the
// project's own location within the repo, never anywhere else in the tree.
// The archives/ DIRECTORY is intentionally never excluded — forensic
// archives are meant to be committable (the park-commit stages them). But
// the three cross-run ledger FILES under it (candidates.jsonl,
// warnings.jsonl, usage-ledger.jsonl) are written on failure legs and
// deliberately survive the revert's `git clean -e archives`; without
// excluding them, an un-ignored ledger file reads as an untracked change
// and would trip the next run's clean-tree guard. Excluding the files (not
// the dir) keeps forensic archives trackable while ensuring forensic
// park-commits never sweep the ledgers up.
// The *.bundle.json file (sibling of *.spec.json) is an ephemeral run input
// — like the spec.json it accompanies, it is generated/consumed for a single
// run and excluded at the project's own location rather than tracked.
function patternLines(prefix) {
  return [
    `${prefix}/.harness/`,
    `${prefix}/queue/`,
    `${prefix}/spec-*.md`,
    `${prefix}/*.spec.md`,
    `${prefix}/*.spec.json`,
    `${prefix}/*.bundle.json`,
    `${prefix}/*.uspec.json`,
    `${prefix}/archives/candidates.jsonl`,
    `${prefix}/archives/warnings.jsonl`,
    `${prefix}/archives/usage-ledger.jsonl`,
  ];
}

/**
 * Idempotently ensure cc-orch's artifact patterns exist in the repo-local
 * .git/info/exclude for the given projectRoot, rooted to projectRoot's
 * location within the git repo.
 *
 * @param {string} projectRoot - Absolute (or relative) path to the project
 *   root. Realpath-normalized first, before any other work.
 * @returns {boolean} true when the patterns are ensured; false (fail-soft,
 *   never throws) on any failure — non-git root, git unavailable, unwritable
 *   .git/, or a realpathSync failure. Mutates nothing when returning false.
 */
export function ensureGitExcludes(projectRoot) {
  let realProjectRoot;
  try {
    realProjectRoot = fs.realpathSync(projectRoot);
  } catch {
    return false;
  }

  let gitPathOut;
  let gitToplevelOut;
  try {
    gitPathOut = execSync('git rev-parse --git-path info/exclude', { stdio: ['pipe', 'pipe', 'pipe'],
      cwd: realProjectRoot,
      encoding: 'utf8',
    }).trim();
    gitToplevelOut = execSync('git rev-parse --show-toplevel', { stdio: ['pipe', 'pipe', 'pipe'],
      cwd: realProjectRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return false;
  }

  if (!gitPathOut || !gitToplevelOut) return false;

  // Resolve a relative rev-parse result against the SUBPROCESS cwd
  // (realProjectRoot), never process.cwd().
  const excludePath = path.isAbsolute(gitPathOut)
    ? gitPathOut
    : path.resolve(realProjectRoot, gitPathOut);

  let realGitRoot;
  try {
    realGitRoot = fs.realpathSync(
      path.isAbsolute(gitToplevelOut)
        ? gitToplevelOut
        : path.resolve(realProjectRoot, gitToplevelOut)
    );
  } catch {
    return false;
  }

  const excludeDir = path.dirname(excludePath);
  try {
    fs.mkdirSync(excludeDir, { recursive: true });
  } catch {
    return false;
  }

  // rel = path.relative(realGitRoot, realProjectRoot), posix-separated, both
  // sides realpathed. prefix is '' at the git toplevel, or '/'+rel otherwise.
  const relRaw = path.relative(realGitRoot, realProjectRoot);
  const rel = relRaw.split(path.sep).join('/');
  const prefix = rel ? '/' + rel : '';

  const lines = patternLines(prefix);

  try {
    let existing = '';
    if (fs.existsSync(excludePath)) {
      existing = fs.readFileSync(excludePath, 'utf8');
    }

    if (!existing.includes(MARKER)) {
      const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      const stanza = [MARKER, ...lines, ''].join('\n');
      fs.writeFileSync(excludePath, existing + sep + stanza, 'utf8');
      return true;
    }

    // Marker present — line-wise ensure. Compare whole trimmed lines (a
    // substring check would false-match sibling patterns), preserving any
    // unrelated pre-existing lines verbatim.
    const presentLines = new Set(existing.split('\n').map((l) => l.trim()));
    const missing = lines.filter((l) => !presentLines.has(l));
    if (missing.length === 0) return true;

    const fileLines = existing.split('\n');
    const markerIdx = fileLines.findIndex((l) => l.trim() === MARKER);
    if (markerIdx === -1) {
      // Marker matched as a substring above but not as a whole line — fall
      // back to appending at EOF.
      const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(excludePath, existing + sep + missing.join('\n') + '\n', 'utf8');
      return true;
    }
    fileLines.splice(markerIdx + 1, 0, ...missing);
    fs.writeFileSync(excludePath, fileLines.join('\n'), 'utf8');
    return true;
  } catch {
    return false;
  }
}
