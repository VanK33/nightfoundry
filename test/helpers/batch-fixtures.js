/**
 * batch-fixtures.js — shared test fixtures for the batch-resume family.
 *
 * The four batch test files (test-batch-resume, test-batch-interrupt-preserve,
 * test-batch-interrupt-recovery, test-batch-abort-between-entries) each carried
 * near-verbatim copies of these git/queue/pipeline fixtures. This module is the
 * single reconciled home. Where the copies diverged, the helper here supports
 * the UNION via options whose defaults preserve each original caller's behavior:
 *
 *   - makeTmpRoot(prefix)          — prefix is caller-chosen (temp-dir name only,
 *                                    no semantic effect); default 'cc-batch-'.
 *   - makeGitRoot({ prefix, gitignore, seedFiles }) — the .gitignore body and any
 *                                    committed seed files are options. The default
 *                                    gitignore carries the bootstrap marker (so
 *                                    ensureGitignoreStanza is a no-op); callers
 *                                    that need archives/ ignored, a marker-less
 *                                    gitignore, or a tracked seed file pass their
 *                                    own. Always sets commit.gpgsign=false (inert
 *                                    where a caller previously omitted it).
 *   - makeRealBatchPipeline(root, { archive, executeAllMilestones, reviewGate,
 *                                    onLog }) — the execute/review seams default to
 *                                    no-ops (callers that overrode them post-build
 *                                    are unaffected). reExtractAssumptions AND
 *                                    remediateAssumption are stubbed too so the
 *                                    remediation path never spawns a live planner
 *                                    session: the remediateAssumption default
 *                                    THROWS, driving batchResume's catch-skip leg
 *                                    deterministically (extractSpecSection's fuzzy
 *                                    matching can hit slug-derived spec titles, so
 *                                    "section not found" is NOT a reliable shield —
 *                                    TC4/TC7 of test-batch-resume.js reached a real
 *                                    paid Opus session through exactly that gap).
 *                                    Tests that assert the applied-fix path override
 *                                    it per-test (e.g. test-batch-resume.js TC5).
 *
 * File-specific helpers (preserve's milestone-shaped makePlan / specJson
 * createQueueEntry / _executeMilestoneParallel-driving makeBatchPipeline,
 * abort's listInterruptRefs, resume's withGitPushCapture / captureOutput /
 * similarity strings) stay local to their file.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { Pipeline } from '../../src/orchestrator/core/pipeline.js';
import { writeQueueEntry } from '../../src/orchestrator/core/state.js';

/** The default committed .gitignore: harness/queue ignored + the FULL current
 * bootstrap stanza so ensureGitignoreStanza is a no-op (deterministic tree) —
 * the line-wise upgrade appends any missing stanza line, so a fixture carrying
 * an outdated stanza gets its tracked .gitignore dirtied mid-run. archives/ as
 * a directory is NOT ignored, so a spec-boundary commit has the archive to
 * stage; only the cross-run ledger FILES under it are ignored (they are written
 * on failure legs and deliberately survive the revert's `git clean -e archives`,
 * so an un-ignored ledger would read as a dirty tree in a post-revert clean-tree
 * assertion — real projects gitignore all of archives/, so this is invisible
 * there). */
export const DEFAULT_GITIGNORE =
  '.harness/\nqueue/\n# cc-orch ephemeral inputs\nspec-*.md\n*.spec.md\n*.spec.json\n*.uspec.json\n# cc-orch cross-run ledgers (written on failure legs, survive git clean -e archives)\narchives/candidates.jsonl\narchives/warnings.jsonl\n';

/** Run git with argv (no shell) in cwd; throws on non-zero exit. */
export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Create a temporary project root directory. `prefix` only names the temp dir. */
export function makeTmpRoot(prefix = 'cc-batch-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A temp dir initialised as a git repo with one commit.
 *
 * @param {object} [opts]
 * @param {string} [opts.prefix='cc-batch-'] — temp-dir name prefix (no semantics).
 * @param {string} [opts.gitignore=DEFAULT_GITIGNORE] — the committed .gitignore body.
 * @param {Object<string,string>|null} [opts.seedFiles=null] — extra files to
 *   write and commit alongside .gitignore (relative path → content), e.g. a
 *   tracked seed the test later modifies.
 */
export function makeGitRoot({ prefix = 'cc-batch-', gitignore = DEFAULT_GITIGNORE, seedFiles = null } = {}) {
  const root = makeTmpRoot(prefix);
  git(['init', '-q'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'CC Test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  fs.writeFileSync(path.join(root, '.gitignore'), gitignore);
  if (seedFiles) {
    for (const [rel, content] of Object.entries(seedFiles)) {
      fs.writeFileSync(path.join(root, rel), content);
    }
  }
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'init'], root);
  return root;
}

/** `git status --porcelain` trimmed — '' means a clean tree. */
export function porcelain(root) {
  return git(['status', '--porcelain'], root).trim();
}

/** Commit subjects newest-first. */
export function gitSubjects(root) {
  return git(['log', '--format=%s'], root).trim().split('\n');
}

/** True when ref resolves to an object. */
export function refExists(root, ref) {
  try {
    git(['rev-parse', '--verify', '--quiet', ref], root);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fake archive() for the constructor's injection seam: writes a real
 * archives/<slug>/ directory (manifest.json carries the headline) and returns
 * its path, so the spec-boundary commit and the forensic park-commit have real
 * files to stage — without running the production Summarizer.
 */
export function makeFakeArchive(headline = 'My headline') {
  return async (projectRoot, slug, _opts) => {
    const dir = path.join(projectRoot, 'archives', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ headline }));
    fs.writeFileSync(path.join(dir, 'report.txt'), `archived ${slug}`);
    return dir;
  };
}

/** Build a minimal plan object (shape returned by planGlobal / stored in queue). */
export function makePlan(overrides = {}) {
  return {
    milestones: overrides.milestones || [],
    assumptions: overrides.assumptions || [],
  };
}

/**
 * Write a queue entry under {root}/queue/{slug}/ with sensible defaults.
 */
export function createQueueEntry(root, slug, {
  spec = `# Spec for ${slug}\n\nDefault spec content.`,
  plan = makePlan(),
  validatedAt = new Date().toISOString(),
  status = 'pending',
} = {}) {
  writeQueueEntry(root, slug, { spec, plan, validatedAt, status });
}

/** Recursively remove a temp root (best-effort). */
export function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Build a Pipeline that runs the REAL batchResume against a live git repo.
 * Planner + execution phases are stubbed (no live Claude sessions); archive()
 * and runFinalTestGate() are injected; the uncheckable-spec + scope-coverage
 * gates are skipped (no live planner to drive them).
 *
 * @returns {{ pipeline: Pipeline, logs: string[] }}
 */
export function makeRealBatchPipeline(root, {
  archive,
  executeAllMilestones = async () => {},
  reviewGate = async () => {},
  onLog = null,
} = {}) {
  const logs = [];
  const pipeline = new Pipeline(root, {
    skipWorktreeCreation: true,
    onLog: onLog ?? ((msg) => logs.push(msg)),
    onConfirm: async () => true,
    archive,
    runFinalTestGate: async () => {},
  });
  pipeline.planner.planGlobal = async () => makePlan();
  pipeline.planner.verifyAssumptions = async () => [];
  pipeline.planner.reExtractAssumptions = async () => [];
  // Hermetic default: throw instead of spawning a real planner session.
  // batchResume catches and logs "remediateAssumption failed — skipping",
  // which is the same skip leg TC4/TC7 always intended to exercise.
  pipeline.planner.remediateAssumption = async () => {
    throw new Error('makeRealBatchPipeline: remediateAssumption not stubbed — hermetic default refuses to spawn a real planner session');
  };
  pipeline.planner.closeReusableSession = async () => {};
  pipeline._executeAllMilestones = executeAllMilestones;
  pipeline._reviewGate = reviewGate;
  pipeline._skipCoverageGate = true;
  return { pipeline, logs };
}
