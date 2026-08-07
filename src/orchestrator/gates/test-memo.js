/**
 * test-memo.js — Tree-hash memo for the two tail full-suite runs.
 *
 * A successful run/resume executes the full test suite twice back to back
 * with an unchanged working tree: once in the spec-criteria drain (when the
 * spec declares config.execution.testAllCommand as a milestone-only hard
 * check) and once in the archive/run final test gate. The suite is ~6 min
 * wall and grows with every spec, so the second run is pure repeated work.
 *
 * This module lets whichever runner goes first record a GREEN result keyed
 * on a working-tree content hash; the second runner reuses it only when the
 * tree content is byte-identical and the memo is fresh. Any tree change
 * (including remediation edits between the two runs) changes the hash and
 * forces a real re-run — deterministic and honest. Red, timed-out, and
 * maxBuffer-overflow results are never recorded.
 *
 * Public API:
 *   computeTreeHash(projectRoot)                     → string | null
 *   readGreenMemo(projectRoot, {treeHash, command, maxAgeMs}) → object | null
 *   recordGreenMemo(projectRoot, {treeHash, command})          → void
 *   testAllMemoPath(projectRoot)                     → string
 *
 * The memo lives at .harness/test-all-memo.json — the cross-run harness
 * root, NOT a per-run dir (archive() teardown moves per-run logs, and the
 * final gate can run in a later process than the drain). `.harness/` is
 * gitignored, so writing the memo never invalidates its own tree hash.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { writeJsonAtomic } from '../core/state.js';
import { harnessRoot } from '../core/run-context.js';

const MEMO_FILENAME = 'test-all-memo.json';

/**
 * Path of the memo file under the given project's flat harness root.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function testAllMemoPath(projectRoot) {
  return path.join(harnessRoot(projectRoot), MEMO_FILENAME);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * sha256 of a file's bytes, or a fixed marker when the file is missing or
 * unreadable (e.g. a `D ` porcelain entry) — the porcelain line itself
 * already encodes the deletion, the marker just keeps the digest total.
 */
function fileHashSafe(filePath) {
  try {
    return sha256(fs.readFileSync(filePath));
  } catch {
    return 'absent';
  }
}

/**
 * Content hash of the working tree: sha256 over `git rev-parse HEAD` plus
 * every `git status --porcelain -uall` entry paired with the sha256 of that
 * file's current content. `-uall` lists untracked files individually even
 * inside new directories. Gitignored paths (`.harness/`, node_modules) are
 * excluded by construction.
 *
 * Returns null — memo unusable, callers must run the suite for real — when
 * git is unavailable, projectRoot is not a git work tree, or the porcelain
 * output contains a quoted path (exotic filename; content-hashing it
 * reliably is not worth the risk of a false memo hit).
 *
 * @param {string} projectRoot
 * @returns {string | null}
 */
export function computeTreeHash(projectRoot) {
  let head = '';
  let porcelain = '';
  try {
    const gitOpts = { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };
    head = execSync('git rev-parse HEAD', gitOpts).trim();
    porcelain = execSync('git status --porcelain -uall', gitOpts);
  } catch {
    return null;
  }

  const lines = porcelain.split('\n').filter((l) => l.length > 0).sort();
  const hash = crypto.createHash('sha256');
  hash.update(head + '\n');
  for (const line of lines) {
    // Porcelain v1: `XY <path>` (rename entries carry `<old> -> <new>`; the
    // current on-disk path is the `-> ` side). Git quotes exotic paths.
    let relPath = line.slice(3);
    const arrowIdx = relPath.indexOf(' -> ');
    if (arrowIdx !== -1) relPath = relPath.slice(arrowIdx + 4);
    if (relPath.startsWith('"')) return null;
    hash.update(`${line}\0${fileHashSafe(path.join(projectRoot, relPath))}\n`);
  }
  return hash.digest('hex');
}

/**
 * Read the memo and return it only when it matches the given tree hash and
 * suite command and is younger than maxAgeMs. A missing, unreadable, or
 * corrupt memo file is a miss (null), never a throw.
 *
 * @param {string} projectRoot
 * @param {{treeHash: string, command: string, maxAgeMs: number}} key
 * @returns {{treeHash: string, command: string, timestamp: number, recordedAtIso?: string} | null}
 */
export function readGreenMemo(projectRoot, { treeHash, command, maxAgeMs }) {
  let memo;
  try {
    memo = JSON.parse(fs.readFileSync(testAllMemoPath(projectRoot), 'utf8'));
  } catch {
    return null;
  }
  if (!memo || typeof memo !== 'object') return null;
  if (memo.treeHash !== treeHash || memo.command !== command) return null;
  if (typeof memo.timestamp !== 'number') return null;
  const age = Date.now() - memo.timestamp;
  if (age < 0 || age > maxAgeMs) return null;
  return memo;
}

/**
 * Record a green full-suite result for the given tree hash + command.
 * Callers must only invoke this after an exitCode-0 suite run whose tree
 * hash is unchanged from before the run. Creates `.harness/` if absent;
 * write is atomic (writeJsonAtomic), so concurrent writers race benignly.
 *
 * @param {string} projectRoot
 * @param {{treeHash: string, command: string}} key
 */
export function recordGreenMemo(projectRoot, { treeHash, command }) {
  const memoPath = testAllMemoPath(projectRoot);
  fs.mkdirSync(path.dirname(memoPath), { recursive: true });
  writeJsonAtomic(memoPath, {
    treeHash,
    command,
    timestamp: Date.now(),
    recordedAtIso: new Date().toISOString(),
  });
}
