/**
 * park-snapshot.js — gc-safe git-stash snapshot primitive for park preservation.
 *
 * When a batch execution-time gate halt routes an entry to a RESOLVABLE park
 * (review-gate reject / analyzer human / regression human-halt), the verified
 * work-in-progress diff must be preserved rather than discarded by the
 * failure-path `git reset --hard` — so a human can inspect it and a later
 * `park resolve --requeue` re-attaches it instead of forcing a full
 * re-validation + re-execution from scratch.
 *
 * The preservation primitive is a git stash COMMIT object (captures tracked
 * modifications AND untracked new files), anchored by a ref under refs/park/
 * so it survives `git gc` (a bare stash drop leaves only a dangling object the
 * reflog will eventually let gc collect). The working tree is left CLEAN after
 * a snapshot, exactly like the reset it replaces.
 *
 * NOTE: this is distinct from snapshots.js, which is task-level target-file
 * fs.copyFileSync backup/restore — NOT a git object. This module's primitive is
 * a whole-tree WIP capture via git.
 *
 * Public API:
 *   createParkSnapshot(slug, cwd, refPrefix?)  → { stashRef, stashSha, baseSha } | null
 *   showParkSnapshot(stashRefOrSha, cwd)       → string (preserved diff text)
 *   reattachParkSnapshot(stashRef, cwd)        → void (throws on conflict/failure)
 *   cleanupParkSnapshot(slug, cwd, refPrefix?) → void (idempotent ref drop)
 *   listSnapshotRefs(cwd, refPrefix)           → string[] (full ref names under prefix; [] on git error)
 */
import { execFileSync } from 'child_process';

/** Run git with argv (no shell — slug/sha never reach a shell). */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** The anchoring ref for a slug's preserved snapshot, under the given prefix. */
function parkRef(slug, refPrefix = 'refs/park/') {
  return `${refPrefix}${slug}`;
}

/**
 * Capture the working-tree WIP (tracked modifications AND untracked new files)
 * into a gc-safe git stash object, pin it under <refPrefix><slug>, and leave the
 * working tree CLEAN.
 *
 * `git stash push -u` both creates the stash commit and resets the tree — but
 * it records the stash only in the reflog (refs/stash), which gc can prune. We
 * resolve the resulting stash commit SHA, pin it via `git update-ref` so the
 * object is reachable from a real ref, then `git stash drop` to remove the
 * reflog entry (the object survives via the pinned ref).
 *
 * @param {string} slug - queue entry slug (names the ref)
 * @param {string} cwd  - project root
 * @param {string} [refPrefix='refs/park/'] - ref namespace for the anchoring ref
 * @returns {{ stashRef: string, stashSha: string, baseSha: string } | null}
 *   null when the tree is already clean (nothing to preserve; caller skips
 *   scene snapshot fields).
 */
export function createParkSnapshot(slug, cwd, refPrefix = 'refs/park/') {
  // HEAD at snapshot time — the base the 3-way reattach later patches against.
  const baseSha = git(['rev-parse', 'HEAD'], cwd).trim();

  // Nothing to preserve → no snapshot. `git stash push` on a clean tree exits
  // 0 with "No local changes to save" and creates nothing, but probing first
  // keeps the null contract explicit and avoids a needless stash entry.
  const porcelain = git(['status', '--porcelain'], cwd).trim();
  if (porcelain.length === 0) return null;

  // Captures tracked + untracked, resets the tree to HEAD (clean).
  git(['stash', 'push', '-u', '-m', `park/${slug}`], cwd);

  // Resolve the just-created stash commit SHA from the stash reflog top.
  const stashSha = git(['rev-parse', 'stash@{0}'], cwd).trim();

  // Pin it gc-safe under <refPrefix><slug>, then drop the reflog entry — the
  // object stays reachable via the pinned ref.
  const stashRef = parkRef(slug, refPrefix);
  git(['update-ref', stashRef, stashSha], cwd);
  git(['stash', 'drop', 'stash@{0}'], cwd);

  return { stashRef, stashSha, baseSha };
}

/**
 * Return the preserved WIP diff as text for inspection (`park show`).
 *
 * `git stash show -p` renders a stash commit's diff including its untracked
 * portion. Accepts either the anchoring ref (refs/park/<slug>) or a raw SHA.
 *
 * @param {string} stashRefOrSha
 * @param {string} cwd
 * @returns {string} the diff text (empty string when there is nothing to show)
 */
export function showParkSnapshot(stashRefOrSha, cwd) {
  // `-u` includes the untracked portion of the stash in the shown diff; `-p`
  // emits patch text. git exits 0 here (unlike `diff --no-index`).
  return git(['stash', 'show', '-p', '-u', stashRefOrSha], cwd);
}

/**
 * Re-apply the preserved snapshot (3-way) onto the CURRENT tree.
 *
 * A 3-way apply (not a plain patch) is used because HEAD may have moved between
 * the halt and the requeue (other batch entries commit deliverables at their
 * spec boundary). On any conflict / non-zero exit, THROW with the git output —
 * the caller must NOT advance the entry as if the work were restored, and must
 * not leave a half-applied tree silently.
 *
 * @param {string} stashRef - the anchoring ref (or SHA) to apply
 * @param {string} cwd
 */
export function reattachParkSnapshot(stashRef, cwd) {
  try {
    git(['stash', 'apply', '--index', stashRef], cwd);
  } catch (errWithIndex) {
    // `--index` fails when the index state can't be restored (e.g. a path is
    // already staged). Retry without it — a plain 3-way apply to the tree is
    // still the desired restore. A second failure is a real conflict.
    try {
      git(['stash', 'apply', stashRef], cwd);
    } catch (err) {
      const out = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`.trim();
      throw new Error(
        `Re-attaching the preserved park snapshot failed — the 3-way apply hit a ` +
        `conflict (HEAD likely moved since the halt). The working tree may now ` +
        `contain conflict markers (<<<<<<<) and unmerged paths; clean it up ` +
        `(e.g. \`git checkout -- <files>\` / \`git reset\`) before retrying. Your ` +
        `preserved work is INTACT and recoverable from the anchoring ref ${stashRef}. ` +
        `git output:\n${out}`
      );
    }
  }
}

/**
 * Drop the anchoring ref so the stash object becomes gc-able. Idempotent: a
 * missing ref is not an error (cleanup may run after a ref was never created,
 * or twice).
 *
 * @param {string} slug
 * @param {string} cwd
 * @param {string} [refPrefix='refs/park/'] - ref namespace for the anchoring ref
 */
export function cleanupParkSnapshot(slug, cwd, refPrefix = 'refs/park/') {
  const ref = parkRef(slug, refPrefix);
  try {
    git(['update-ref', '-d', ref], cwd);
  } catch {
    // Ref already gone (or never created) — gc-safety cleanup is best-effort.
  }
}

/**
 * Enumerate the full ref names anchored under a given prefix.
 *
 * `git for-each-ref --format=%(refname) <refPrefix>` lists every ref in the
 * namespace. Used by the `cc-orch clean` reaper to find orphan interrupt
 * snapshot refs. On any git error (not a repo / git unavailable) returns [].
 *
 * @param {string} cwd - project root
 * @param {string} refPrefix - ref namespace to enumerate (e.g. 'refs/interrupt/')
 * @returns {string[]} full ref names (trimmed, non-empty)
 */
export function listSnapshotRefs(cwd, refPrefix) {
  let output;
  try {
    output = git(['for-each-ref', '--format=%(refname)', refPrefix], cwd);
  } catch {
    // Not a git repo, or git unavailable — nothing to enumerate.
    return [];
  }
  return output.split('\n').map((r) => r.trim()).filter(Boolean);
}
