import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { readState } from '../../orchestrator/core/state.js';
import { PER_RUN_SUBDIRS, SHARED_SUBDIRS } from '../../orchestrator/core/bootstrap.js';
import { Summarizer } from '../../orchestrator/agents/summarizer.js';
import { SessionManager } from '../../orchestrator/infra/session-manager.js';
import { Logger } from '../../orchestrator/infra/logger.js';
import { TokenTracker } from '../../orchestrator/infra/token-tracker.js';
import { askYesNo } from '../prompt.js';
import { generateRunReport, updateRunHistory } from '../../orchestrator/infra/run-report.js';
import { writeFingerprint } from '../../orchestrator/core/dispersion-fingerprint.js';
import { runFullTestSuite } from '../../orchestrator/gates/regression.js';
import config from '../../orchestrator/infra/config.js';
import { deriveSpecJsonPath } from '../../orchestrator/core/spec-paths.js';
import { activeHarnessDir, clearActiveRunPointer, harnessRoot } from '../../orchestrator/core/run-context.js';

// cc-orch's own root — scripts like bump.js and export-ccusage.js live here,
// NOT in the target project.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CC_ORCH_ROOT = path.resolve(__dirname, '..', '..', '..');

// The shipped default of config.execution.testAllCommand (must match
// infra/config.js). The final test gate compares the live config value
// against it to detect an operator override — see the gate comment below.
const DEFAULT_TEST_ALL_COMMAND = 'npm run test:all';

/**
 * Thrown by the archive final test gate when the full test suite
 * (config.execution.testAllCommand, default `npm run test:all`) fails on a
 * successful archive. A distinct type so batchResume can route it to a
 * truthful `failed-test-gate` status (revert + re-queue, no misleading
 * forensic archive) rather than the generic execution-failure path.
 */
export class TestGateError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'TestGateError';
    this.timedOut = !!options.timedOut;
  }
}

/**
 * Final test gate: run the full suite for `projectRoot`; throw TestGateError on failure.
 * No-op when flags['include-failed'] or flags['skip-test-gate'] is set, or when the
 * target has no runnable test:all (default command AND no package.json `test:all` script).
 * Behaviour is byte-identical to the block archive() previously ran inline.
 *
 * @param {string} projectRoot
 * @param {object} [flags={}]  - CLI flags (include-failed, skip-test-gate)
 * @param {object} [deps={}]   - { runFullTestSuite? } injection seam
 * @throws {TestGateError}
 */
export function runFinalTestGate(projectRoot, flags = {}, deps = {}) {
  const _runFullTestSuite = deps.runFullTestSuite ?? runFullTestSuite;
  if (flags['include-failed'] || flags['skip-test-gate']) return;
  const isDefaultCommand = config.execution.testAllCommand === DEFAULT_TEST_ALL_COMMAND;
  let hasTestAll = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    hasTestAll = !!(pkg.scripts && pkg.scripts['test:all']);
  } catch { /* no readable package.json — nothing to gate on */ }
  if (!isDefaultCommand || hasTestAll) {
    console.log(`[archive] Final test gate: running \`${config.execution.testAllCommand}\`...`);
    const testResult = _runFullTestSuite(projectRoot);
    if (testResult.exitCode === -1) {
      throw new TestGateError(
        `Final test gate TIMED OUT: \`${config.execution.testAllCommand}\` did not complete before ` +
        `the timeout (the suite timed out — this is not a failing test). ` +
        `Refusing to archive a spec whose test suite did not finish running. ` +
        `Re-run when the machine is quiet, or pass --skip-test-gate to override.\n` +
        `--- tail of test output ---\n${(testResult.output || '').slice(-2000)}`,
        { timedOut: true }
      );
    } else if (testResult.exitCode !== 0) {
      throw new TestGateError(
        `Final test gate failed: \`${config.execution.testAllCommand}\` exited ${testResult.exitCode}. ` +
        `Refusing to archive a spec whose test suite does not pass. ` +
        `Fix the tests and re-run, or pass --skip-test-gate to override.\n` +
        `--- tail of test output ---\n${(testResult.output || '').slice(-2000)}`
      );
    }
    console.log('[archive] Final test gate passed.');
  } else {
    console.log('[archive] No `test:all` script in target — skipping final test gate.');
  }
}

/**
 * Capture git metadata for the project.
 * Runs 'git rev-parse HEAD' and 'git status --porcelain' in projectRoot.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @returns {{ gitHead: string, gitStatus: 'clean'|'dirty'|'unknown' }}
 */
export function getGitInfo(projectRoot) {
  try {
    const gitHead = execSync('git rev-parse HEAD', { stdio: ['pipe', 'pipe', 'pipe'], cwd: projectRoot, encoding: 'utf8' }).trim();
    const porcelain = execSync('git status --porcelain', { stdio: ['pipe', 'pipe', 'pipe'], cwd: projectRoot, encoding: 'utf8' }).trim();
    const gitStatus = porcelain.length > 0 ? 'dirty' : 'clean';
    return { gitHead, gitStatus };
  } catch {
    return { gitHead: 'unknown', gitStatus: 'unknown' };
  }
}

/**
 * Read token usage data from .harness/logs/token-usage.json.
 * Returns { totalCost: 0, totalSessions: 0 } if the file is missing or unreadable.
 *
 * @param {string} harnessDir - Absolute path to the .harness directory
 * @returns {{ totalCost: number, totalSessions: number }}
 */
export function getUsageData(harnessDir) {
  const usagePath = path.join(harnessDir, 'logs', 'token-usage.json');
  try {
    const raw = fs.readFileSync(usagePath, 'utf8');
    const data = JSON.parse(raw);
    // TokenTracker.save() writes { sessions: [...], totals: {...}, updatedAt }.
    // The totals object has keys from getTotalUsage(): sessionCount, totalCostUsd,
    // inputTokens, outputTokens, cacheCreation, cacheRead.
    return {
      totalCost: data.totals?.totalCostUsd ?? 0,
      totalSessions: data.totals?.sessionCount ?? 0,
    };
  } catch {
    return { totalCost: 0, totalSessions: 0 };
  }
}

/**
 * Copy a spec file into the archive directory and optionally remove the original.
 *
 * @param {string} specPath - Path to the spec file (absolute or relative to projectRoot)
 * @param {string} projectRoot - Absolute path to the project root
 * @param {string} archiveDir - Absolute path to the archive directory
 * @param {boolean} preserveMode - If true, keep the original spec file; otherwise remove it
 * @returns {void}
 */
export function copySpecToArchive(specPath, projectRoot, archiveDir, preserveMode) {
  if (!specPath) return;
  try {
    const resolvedSpec = path.isAbsolute(specPath)
      ? specPath
      : path.join(projectRoot, specPath);
    // Derive both artifact sources by extension. spec.json is the json-SOT
    // sibling of a .md/legacy source, or the resolved path itself for a .json.
    let mdSrc;
    let jsonSrc;
    if (resolvedSpec.endsWith('.md')) {
      mdSrc = resolvedSpec;
      jsonSrc = deriveSpecJsonPath(resolvedSpec, projectRoot);
    } else if (resolvedSpec.endsWith('.json')) {
      jsonSrc = resolvedSpec;
      mdSrc = resolvedSpec.replace(/\.json$/, '.md');
    } else {
      // No/other extension (legacy) — preserve today's behavior: dest is spec.md.
      mdSrc = resolvedSpec;
      jsonSrc = deriveSpecJsonPath(resolvedSpec, projectRoot);
    }

    if (fs.existsSync(mdSrc)) {
      fs.copyFileSync(mdSrc, path.join(archiveDir, 'spec.md'));
      console.log(`[archive] Copied spec to archive: ${path.basename(mdSrc)}`);
      if (!preserveMode) {
        try {
          fs.unlinkSync(mdSrc);
          console.log(`[archive] Removed spec from project root: ${path.basename(mdSrc)}`);
        } catch { /* non-critical */ }
      } else {
        console.log(`[archive] Preserved spec at project root: ${path.basename(mdSrc)}`);
      }
    }

    if (fs.existsSync(jsonSrc)) {
      fs.copyFileSync(jsonSrc, path.join(archiveDir, 'spec.json'));
      console.log(`[archive] Copied spec to archive: ${path.basename(jsonSrc)}`);
      if (!preserveMode) {
        try {
          fs.unlinkSync(jsonSrc);
          console.log(`[archive] Removed spec from project root: ${path.basename(jsonSrc)}`);
        } catch { /* non-critical */ }
      } else {
        console.log(`[archive] Preserved spec at project root: ${path.basename(jsonSrc)}`);
      }
    }
  } catch {
    // Non-critical — skip silently.
  }
}

/**
 * Compute a URL-safe slug with 4-tier fallback:
 *   1. Explicit name (CLI positional arg or queue-slug carrier — preserves
 *      caller intent and queue→archive-dir traceability for batch runs)
 *   2. Milestone description (first ~5 significant words, slugified)
 *   3. Spec filename (basename without extension)
 *   4. Generic 'dogfood-{seq}'
 *
 * @param {string|null|undefined} name - Explicit override (CLI positional arg or queue slug)
 * @param {string|null|undefined} milestoneDescription - First milestone's description
 * @param {string} specPath - Path to the spec file (used as fallback)
 * @param {string|number} seq - Sequence number (used as last-resort fallback)
 * @returns {string} slug - max 40 chars, lowercase, hyphen-separated
 */
export function computeSlug(name, milestoneDescription, specPath, seq) {
  let source;
  if (name && String(name).trim()) {
    source = String(name).trim();
  } else if (milestoneDescription && milestoneDescription.trim()) {
    // Take first ~5 significant words to keep directory names short
    source = milestoneDescription.trim().split(/\s+/).slice(0, 5).join(' ');
  } else {
    const base = path.basename(specPath || '', path.extname(specPath || ''));
    if (base) {
      source = base;
    } else {
      return `dogfood-${seq}`;
    }
  }
  return source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // replace non-alphanum runs with hyphen
    .replace(/^-+|-+$/g, '')       // trim leading/trailing hyphens
    .slice(0, 40);
}

/**
 * Compute the next sequential archive number by inspecting existing archive dirs.
 * Parses the leading 3-digit prefix from each dir name and returns max+1.
 * Returns '001' if the archives directory is empty or doesn't exist.
 *
 * @param {string} archivesDir - Path to archives/
 * @returns {string} zero-padded 3-digit sequence number
 */
export function computeSeq(archivesDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(archivesDir);
  } catch {
    // directory doesn't exist or can't be read — start at 1
  }

  let max = 0;
  for (const entry of entries) {
    const match = entry.match(/^(?:failed-)?(\d{3})/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }

  return String(max + 1).padStart(3, '0');
}

/**
 * Validate whether a harness run is archivable.
 * A run is archivable when all milestones have status 'complete' or 'invalidated'.
 *
 * @param {string} harnessDir - Path to the .harness directory
 * @param {boolean} autoMode  - When true, log a warning and continue instead of blocking
 * @returns {{ ok: boolean, message?: string }}
 */
export function validateArchivable(harnessDir, autoMode) {
  const state = readState(harnessDir);
  // state.milestones is an object keyed by ID, not an array — normalize here.
  const milestones = Object.values(state.milestones ?? {});

  const TERMINAL = new Set(['complete', 'invalidated']);
  const allDone = milestones.length === 0 || milestones.every(m => TERMINAL.has(m.status));

  if (allDone) {
    return { ok: true };
  }

  if (autoMode) {
    console.warn('[archive] Warning: not all milestones are complete or invalidated. Archiving anyway (auto mode).');
    return { ok: true };
  }

  return {
    ok: false,
    message: 'Not all milestones are complete or invalidated. Archive anyway? (y/N) ',
  };
}

/**
 * A run is a "clean delivery" (eligible for version bump + CHANGELOG + RUNS) iff it was
 * NOT rejected at the review gate, every milestone is terminal (complete|invalidated),
 * and at least one milestone actually completed. A rejected, incomplete (non-terminal),
 * or all-invalidated run is archived as a forensic record but does not bump/release.
 * @param {object} state - harness state (from readState)
 * @returns {boolean}
 */
export function isCleanDelivery(state) {
  if (state?.globalStatus === 'rejected') return false;
  const milestones = Object.values(state?.milestones ?? {});
  if (milestones.length === 0) return false;
  const TERMINAL = new Set(['complete', 'invalidated']);
  const allTerminal = milestones.every(m => TERMINAL.has(m.status));
  const anyComplete = milestones.some(m => m.status === 'complete');
  return allTerminal && anyComplete;
}

/**
 * Assemble the full manifest.json object for an archive.
 *
 * @param {object} state        - Harness state object (from readState)
 * @param {string} seq          - Zero-padded 3-digit sequence number (e.g. '001')
 * @param {string} slug         - URL-safe project slug
 * @param {string} specContent  - Raw text content of the spec file
 * @param {{ head: string, status: string }} gitInfo - Git metadata
 * @param {{ headline: string, bugs: string[], summary: string }} summaryData - Human-readable summary fields
 * @param {{ totalCost: number, totalSessions: number }} usageData - Usage/cost data
 * @param {{ haltReason: string, haltTaskId: string|null }|null|undefined} [haltInfo] - Optional halt
 *   metadata. When provided, `haltReason` (string) and `haltTaskId` (string|null) are added to the
 *   manifest. When falsy, those fields are omitted entirely (existing manifest shape unchanged).
 * @returns {object} manifest - Full manifest.json schema object
 */
export function buildManifest(state, seq, slug, specContent, gitInfo, summaryData, usageData, haltInfo) {
  // models can be enriched by callers; default to empty array
  const models = [];

  const manifest = {
    id: `${seq}-${slug}`,
    name: state.name ?? slug,
    seq,
    spec: state.spec || state.projectMeta?.prdPath || null,
    specSnapshot: specContent,
    startedAt: state.startedAt ?? null,
    archivedAt: new Date().toISOString(),
    gitHead: gitInfo?.head ?? null,
    gitStatus: gitInfo?.status ?? null,
    models,
    // state.milestones is an object keyed by ID — convert to array + pick
    // the fields the manifest schema exposes.
    milestones: Object.values(state.milestones ?? {}).map((m) => ({
      id: m.id,
      description: m.description,
      status: m.status,
    })),
    totalCost: usageData?.totalCost ?? 0,
    totalSessions: usageData?.totalSessions ?? 0,
    headline: summaryData?.headline ?? '',
    bugs: summaryData?.bugs ?? [],
    summary: summaryData?.summary ?? '',
    changelog: summaryData?.changelog ?? [],
    // This run's genuine `uncertain` assumptions (advisory — they no longer
    // park the run). Sourced from the harness state field the assumption gate
    // writes; an empty array when there were none.
    uncertainAssumptions: (state.uncertainAssumptions ?? []).map((u) => ({
      text: u.text,
      specSection: u.specSection ?? '',
    })),
  };

  if (haltInfo) {
    manifest.haltReason = haltInfo.haltReason;
    manifest.haltTaskId = haltInfo.haltTaskId;
  }

  return manifest;
}

/**
 * Move per-run harness artifacts from harnessDir into archiveDir.
 * Moves: state.json, dispersion-fingerprint.json, state/, plan/, verify/,
 *        progress/, verification/, analysis/, snapshots/, logs/
 * Skips entries that don't exist. Never moves the shared learning/, dry-run/,
 * or brainstorm/ subdirs, the active-run pointer, or archives/ — those are
 * outside the per-run entries list and are left untouched.
 *
 * @param {string} harnessDir - Absolute path to the .harness directory
 * @param {string} archiveDir - Absolute path to the destination archive directory
 */
export function moveHarnessToArchive(harnessDir, archiveDir) {
  fs.mkdirSync(archiveDir, { recursive: true });

  const entries = ['state.json', 'dispersion-fingerprint.json', ...PER_RUN_SUBDIRS];

  for (const entry of entries) {
    const src = path.join(harnessDir, entry);
    if (fs.existsSync(src)) {
      // Skip empty directories — don't move them to the archive
      const stat = fs.statSync(src);
      if (stat.isDirectory() && fs.readdirSync(src).length === 0) {
        continue;
      }
      const dest = path.join(archiveDir, entry);
      fs.renameSync(src, dest);
    }
  }
}

/**
 * Write a standard .gitignore to the archive directory that excludes
 * large/volatile subdirectories from being committed.
 *
 * @param {string} archiveDir - Absolute path to the archive directory
 */
export function writeGitignore(archiveDir) {
  // Committed to git (do NOT ignore):
  //   manifest.json  — archive index entry
  //   verification/  — verifier output records
  //   state.json     — final harness state snapshot
  //   state/         — per-task state directory
  //
  // Ignored (large/volatile, excluded from git):
  //   logs/          — runtime log files
  //   snapshots/     — task file snapshots
  //   progress/      — executor progress reports
  //   analysis/      — analyzer intermediate output
  const content = [
    '# cc-orch archive gitignore policy',
    '# Committed: manifest.json, verification/, state.json, state/',
    '# Ignored: large/volatile runtime artifacts',
    'logs/',
    'snapshots/',
    'progress/',
    'analysis/',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(archiveDir, '.gitignore'), content, 'utf8');
}

/**
 * Inspect state.json fields and .harness/analysis/ JSON files to determine
 * haltReason and haltTaskId for a halted run.
 *
 * Priority order:
 *   (a) globalStatus==='complete' + all milestones terminal → return null (completed normally)
 *   (b) Circuit-breaker error in analysis file → 'circuit-breaker'
 *   (c) Regression failure in analysis file → 'regression-failure'
 *   (d) Reviewer-gate failure in analysis file → 'reviewer-stop'
 *   (e) HaltError site field in analysis file → map site string to enum
 *   (f) Fallback → 'unknown'
 *
 * The haltTaskId is extracted from the circuit-breaker message regex or from the
 * analysis file's taskId field, defaulting to null.
 *
 * @param {string} harnessDir - Absolute path to the .harness directory
 * @param {object} state - Harness state object (from readState)
 * @returns {{ haltReason: string, haltTaskId: string|null }|null}
 */
export function detectHaltInfo(harnessDir, state) {
  const TERMINAL = new Set(['complete', 'invalidated']);
  const milestones = Object.values(state.milestones ?? {});
  const allTerminal = milestones.length === 0 || milestones.every(m => TERMINAL.has(m.status));

  // (a) Completed normally — not a halted run.
  if (state.globalStatus === 'complete' && allTerminal) {
    return null;
  }

  // Read all analysis JSON files from .harness/analysis/.
  const analysisDir = path.join(harnessDir, 'analysis');
  const analysisFiles = [];
  try {
    const entries = fs.readdirSync(analysisDir).filter(f => f.endsWith('.json')).sort();
    for (const entry of entries) {
      try {
        const raw = fs.readFileSync(path.join(analysisDir, entry), 'utf8');
        analysisFiles.push(JSON.parse(raw));
      } catch {
        // Skip unreadable or invalid JSON files.
      }
    }
  } catch {
    // analysis/ doesn't exist or can't be read — proceed to fallback.
  }

  // Collect the first match for each halt pattern across all analysis files
  // (priority: circuit-breaker > regression > reviewer-stop > halt-error-site).
  let circuitBreaker = null;
  let regressionFailure = null;
  let reviewerStop = null;
  let haltErrorSite = null;

  for (const fileData of analysisFiles) {
    // Collect all string-valued fields from the analysis JSON (flat scan).
    const stringValues = Object.values(fileData).filter(v => typeof v === 'string');
    const taskId = typeof fileData.taskId === 'string' ? fileData.taskId : null;

    for (const s of stringValues) {
      // (b) Circuit-breaker: message starts with 'Circuit breaker:'
      if (!circuitBreaker && s.startsWith('Circuit breaker:')) {
        const match = s.match(/Circuit breaker: task (\S+) failed/);
        const haltTaskId = match ? match[1] : taskId;
        circuitBreaker = { haltReason: 'circuit-breaker', haltTaskId };
      }

      // (c) Regression failure
      if (!regressionFailure && s.toLowerCase().includes('regression failed')) {
        regressionFailure = { haltReason: 'regression-failure', haltTaskId: taskId };
      }

      // (d) Reviewer gate
      if (!reviewerStop && s.toLowerCase().includes('reviewer gate failed')) {
        reviewerStop = { haltReason: 'reviewer-stop', haltTaskId: taskId };
      }
    }

    // (b+) Also detect circuit-breaker via the analysis file's `type` field.
    if (!circuitBreaker && fileData.type === 'circuit-breaker') {
      circuitBreaker = { haltReason: 'circuit-breaker', haltTaskId: taskId };
    }

    // (c+) Also detect regression-failure via the analysis file's `type` field.
    if (!regressionFailure && fileData.type === 'regression-failure') {
      regressionFailure = { haltReason: 'regression-failure', haltTaskId: taskId };
    }

    // (d+) Also detect reviewer-stop via the analysis file's `type` field.
    if (!reviewerStop && fileData.type === 'reviewer-stop') {
      reviewerStop = { haltReason: 'reviewer-stop', haltTaskId: taskId };
    }

    // (e) HaltError site field — site is a string in the analysis file.
    if (!haltErrorSite && typeof fileData.site === 'string') {
      haltErrorSite = { haltReason: fileData.site, haltTaskId: taskId };
    }
  }

  // (c++) Milestone-regression-failure detection from state.json structure.
  // The pipeline's regression-failed gate (pipeline.js _executeMilestone) throws
  // when the user declines to proceed past the milestone regression verifier;
  // this leaves the milestone in `in_progress` while all its missions remain
  // `complete`. No analysis/ file is written for this halt path — the signal
  // lives only in state.json structure plus verification/regression-milestone-*.md.
  // This check fills the detection gap so the manifest gets the correct enum
  // value instead of falling through to `unknown`.
  if (!circuitBreaker && !regressionFailure && !reviewerStop && !haltErrorSite) {
    for (const ms of milestones) {
      if (ms.status === 'in_progress' && ms.missions) {
        const missionList = Object.values(ms.missions);
        const allMissionsComplete = missionList.length > 0 &&
          missionList.every(m => TERMINAL.has(m.status));
        if (allMissionsComplete) {
          regressionFailure = { haltReason: 'regression-failure', haltTaskId: null };
          break;
        }
      }
    }
  }

  // Return in priority order.
  if (circuitBreaker) return circuitBreaker;
  if (regressionFailure) return regressionFailure;
  if (reviewerStop) return reviewerStop;
  if (haltErrorSite) return haltErrorSite;

  // (f) Fallback: run was not completed normally but no specific pattern found.
  return { haltReason: 'unknown', haltTaskId: null };
}

/**
 * Thin wrapper around askYesNo so existing call-sites and the
 * `deps.promptYesNo` injection seam in archiveCommand continue to work.
 * The strict parser (y/yes/n/no, re-prompt on unknown) lives in
 * src/cli/prompt.js — see dogfood 1 bug writeup there for the rationale.
 *
 * @param {string} message - Prompt message to display
 * @returns {Promise<boolean>}
 */
function promptYesNo(message) {
  return askYesNo(message);
}

/**
 * Extract recent git commits relative to the prior archive's gitHead.
 * Scans archives/ for the highest-seq manifest.json to find the prior gitHead.
 * If found, runs `git log --oneline <startSHA>..HEAD`; otherwise falls back to
 * `git log --oneline -50`. Returns '(git log unavailable)' on error.
 *
 * @param {string} projectRoot  - Absolute path to the project root (git cwd)
 * @param {string} archivesDir  - Absolute path to the archives/ directory
 * @param {object} [deps={}]    - Injectable deps (unused here; reserved for callers)
 * @returns {string} One-line git log output or fallback string
 */
export function getRecentCommits(projectRoot, archivesDir, deps = {}) {
  // Find the highest-seq archive and read its gitHead from manifest.json
  let priorGitHead = null;
  try {
    const entries = fs.readdirSync(archivesDir);
    let max = 0;
    let maxEntry = null;
    for (const entry of entries) {
      const match = entry.match(/^(\d{3})/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > max) {
          max = n;
          maxEntry = entry;
        }
      }
    }
    if (maxEntry) {
      const manifestPath = path.join(archivesDir, maxEntry, 'manifest.json');
      const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestRaw);
      if (manifest.gitHead && manifest.gitHead !== 'unknown') {
        priorGitHead = manifest.gitHead;
      }
    }
  } catch {
    // archives/ doesn't exist or manifest unreadable — fall through to full log
  }

  try {
    if (priorGitHead) {
      return execSync(`git log --oneline ${priorGitHead}..HEAD`, { stdio: ['pipe', 'pipe', 'pipe'],
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim();
    } else {
      return execSync('git log --oneline -50', { stdio: ['pipe', 'pipe', 'pipe'],
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim();
    }
  } catch {
    return '(git log unavailable)';
  }
}

/**
 * Compute file-level diff stats scoped to priorGitHead..HEAD using `git diff --stat`.
 * Scans archives/ for the highest-seq manifest.json to find the prior gitHead.
 * If a prior gitHead is found, runs `git diff --stat <priorGitHead>..HEAD`.
 * Returns '' when no prior archive exists or on any error.
 *
 * @param {string} projectRoot  - Absolute path to the project root (git cwd)
 * @param {string} archivesDir  - Absolute path to the archives/ directory
 * @param {object} [deps={}]    - Injectable deps. Supports deps.excludeArchiveId
 *                                to skip an archive whose manifest was just
 *                                written with the current HEAD (run-report path).
 * @returns {string} git diff --stat output (files touched + insertions/deletions) or ''
 */
export function getDiffSummary(projectRoot, archivesDir, deps = {}) {
  const excludeArchiveId = deps.excludeArchiveId ?? null;
  // Find the highest-seq archive and read its gitHead from manifest.json
  let priorGitHead = null;
  try {
    const entries = fs.readdirSync(archivesDir);
    let max = 0;
    let maxEntry = null;
    for (const entry of entries) {
      if (excludeArchiveId && entry === excludeArchiveId) continue;
      const match = entry.match(/^(\d{3})/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > max) {
          max = n;
          maxEntry = entry;
        }
      }
    }
    if (maxEntry) {
      const manifestPath = path.join(archivesDir, maxEntry, 'manifest.json');
      const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestRaw);
      if (manifest.gitHead && manifest.gitHead !== 'unknown') {
        priorGitHead = manifest.gitHead;
      }
    }
  } catch {
    // archives/ doesn't exist or manifest unreadable
  }

  // No prior archive — nothing to diff against
  if (!priorGitHead) {
    return '';
  }

  try {
    return execSync(`git diff --stat ${priorGitHead}..HEAD`, { stdio: ['pipe', 'pipe', 'pipe'],
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Build the pre-computed data package the summarizer consumes.
 * All data is gathered here on the JS side — the summarizer does
 * no file exploration. Excludes git HEAD commit subject/body and raw CHANGELOG text.
 * Includes file-level diff stats (diffSummary) and task-level verification sidecars.
 *
 * @param {object} state        - Harness state object
 * @param {string} projectRoot  - Absolute path to the project root
 * @param {string} specContent  - Raw spec file content
 * @param {object} usageData    - { totalCost, totalSessions }
 * @param {string} archivesDir  - Absolute path to archives/ (for getDiffSummary)
 * @param {object} [deps={}]    - Injectable deps; supports deps.getDiffSummary
 * @returns {object} data package consumed by Summarizer
 */
export function buildSummarizerDataPackage(state, projectRoot, specContent, usageData, archivesDir, deps = {}) {
  const _getDiffSummary = deps.getDiffSummary ?? getDiffSummary;
  const diffSummary = _getDiffSummary(projectRoot, archivesDir, deps);
  const summaryHarnessDir = activeHarnessDir(projectRoot);

  // Read task-level verification JSON files from .harness/verification/ and
  // serialize to a human-readable markdown block for prompt interpolation.
  // Prior bug: we returned a raw {filename: parsedJSON} object that summarizer.js
  // interpolated via template literal, yielding literal "[object Object]" in the
  // prompt. Formatting here keeps summarizer.js purely presentational.
  const sidecarBlocks = [];
  const verificationDir = path.join(summaryHarnessDir, 'verification');
  try {
    const verificationFiles = fs.readdirSync(verificationDir).sort();
    for (const file of verificationFiles) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(verificationDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        sidecarBlocks.push(`### ${file}\n${JSON.stringify(parsed, null, 2)}`);
      } catch {
        // Skip unreadable or invalid JSON files
      }
    }
  } catch {
    // verification/ doesn't exist or can't be read — leave empty
  }
  const verificationSidecars = sidecarBlocks.length > 0
    ? sidecarBlocks.join('\n\n')
    : '';

  const milestoneList = Object.values(state.milestones ?? {}).map((m) => ({
    id: m.id,
    description: m.description,
    status: m.status,
  }));

  // Collect completed tasks from mission state files.
  // Walk state.milestones → missions → read mission-{id}.json → subMissions → tasks.
  const COMPLETED_STATUSES = new Set(['complete', 'done']);
  const completedTasks = [];
  for (const milestone of Object.values(state.milestones ?? {})) {
    for (const mission of Object.values(milestone.missions ?? {})) {
      const missionStateFile = path.join(summaryHarnessDir, 'state', `mission-${mission.id}.json`);
      let missionState = null;
      try {
        const raw = fs.readFileSync(missionStateFile, 'utf8');
        missionState = JSON.parse(raw);
      } catch {
        // Missing or unreadable state file — skip gracefully
        continue;
      }
      for (const subMission of Object.values(missionState.subMissions ?? {})) {
        for (const task of Object.values(subMission.tasks ?? {})) {
          if (COMPLETED_STATUSES.has(task.status)) {
            completedTasks.push({ id: task.id, description: task.description });
          }
        }
      }
    }
  }

  return {
    projectRoot,
    stateJson: state,
    diffSummary,
    specContent,
    milestoneList,
    totalCost: usageData?.totalCost ?? 0,
    totalSessions: usageData?.totalSessions ?? 0,
    verificationSidecars,
    completedTasks,
  };
}

/**
 * Validate changelog items against the diff summary.
 * Items with source: 'diff-file' must reference a file (via item.file) that
 * appears in diffSummary (git diff --stat output). Items with other sources
 * are passed through as valid unconditionally.
 *
 * @param {Array} changelog    - Array of changelog item objects
 * @param {string} diffSummary - git diff --stat output (filenames parsed from it)
 * @returns {{ valid: Array, invalid: Array }}
 */
export function validateChangelogSources(changelog, diffSummary) {
  if (!Array.isArray(changelog)) return { valid: [], invalid: [] };

  // Parse filenames from git diff --stat lines like "  src/foo.js | 5 ++---"
  const diffFiles = new Set();
  for (const line of (diffSummary || '').split('\n')) {
    const match = line.match(/^\s*(.+?)\s+\|/);
    if (match) {
      diffFiles.add(match[1].trim());
    }
  }

  const valid = [];
  const invalid = [];

  for (const item of changelog) {
    if (item.source === 'diff-file') {
      if (item.file && diffFiles.has(item.file)) {
        valid.push(item);
      } else {
        invalid.push(item);
      }
    } else {
      valid.push(item);
    }
  }

  return { valid, invalid };
}

/**
 * Main archive command. Wires together all archive sub-steps:
 *   1. validateArchivable (with readline prompt if needed)
 *   2. computeSeq + computeSlug
 *   3. Create archive dir at archives/{seq}-{slug}/
 *   4. Spawn Summarizer to produce summaryData
 *   5. getGitInfo + getUsageData
 *   6. buildManifest + write manifest.json
 *   7. moveHarnessToArchive
 *   8. writeGitignore
 *   9. bootstrap(projectRoot, { force: true }) to reinitialize
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {string|null|undefined} name - Archive name (used to compute slug)
 * @param {object} flags - CLI flags; flags.auto or flags.a enables auto mode; flags.preserve or flags.P keeps the spec file at the project root after archiving
 * @param {object} [deps={}] - Optional dependency overrides for testing
 * @param {function} [deps.summarize] - Override for summarization; called as summarize(state, projectRoot) -> Promise<summaryData>
 * @param {object} [deps.Logger] - Override for Logger class
 * @param {object} [deps.TokenTracker] - Override for TokenTracker class
 * @param {object} [deps.SessionManager] - Override for SessionManager class
 * @param {function} [deps.promptYesNo] - Override for promptYesNo(message) -> Promise<boolean>
 * @param {function} [deps.getGitInfo] - Override for getGitInfo(projectRoot) -> { gitHead, gitStatus }
 * @param {function} [deps.getDiffSummary] - Override for getDiffSummary(projectRoot, archivesDir, deps) -> string
 */

export async function archive(projectRoot, name, flags = {}, deps = {}) {
  const autoMode = !!(flags.auto || flags.a);
  const harnessDir = activeHarnessDir(projectRoot);
  const archivesDir = path.join(projectRoot, 'archives');

  // Resolve injectable dependencies with real implementations as defaults.
  const _promptYesNo = deps.promptYesNo ?? promptYesNo;
  const _getGitInfo = deps.getGitInfo ?? getGitInfo;
  const LoggerImpl = deps.Logger ?? Logger;
  const TokenTrackerImpl = deps.TokenTracker ?? TokenTracker;
  const SessionManagerImpl = deps.SessionManager ?? SessionManager;
  const _runFullTestSuite = deps.runFullTestSuite ?? runFullTestSuite;

  // ── Final test gate ──────────────────────────────────────────────────────
  // A SUCCESSFUL archive must not persist a spec whose full test suite does not
  // pass. The per-milestone regression only runs the smoke command
  // (config.execution.testCommand, default `npm test`: a single-file smoke
  // test, test/test-pipeline.js), so a broken test the spec itself added
  // sails through to archive. This is exactly how a wall-clock-cap spec was
  // archived with a hanging TC1. Run the whole suite here, once per spec, and
  // refuse to archive on failure. Skipped for forensic (--include-failed)
  // archives — they record a failure, not a release — and overridable with
  // --skip-test-gate. Gate-run condition: when config.execution.testAllCommand
  // is overridden away from its default, the override IS the operator's
  // declaration that the command is runnable in the target, so the gate runs
  // unconditionally; only the default command keeps the package.json
  // `test:all` script check, so an npm project without that script (or a
  // non-npm project without an override) is not blocked.
  try {
    runFinalTestGate(projectRoot, flags, { runFullTestSuite: _runFullTestSuite });
  } catch (err) {
    if (err instanceof TestGateError && err.timedOut) {
      console.error('[archive] full suite TIMED OUT under load (not a test failure) — re-run when quiet');
    }
    throw err;
  }

  // --include-failed branch: archive a halted run for forensic preservation.
  //
  // Policy: failed-archive intentionally does NOT touch CHANGELOG.md, RUNS.md,
  // or package.json version. Failed runs are forensic records, not releases —
  // a "failed" archive in release notes would imply blessing that cc-orch did
  // not verify. Successful-archive remains the only path that updates those
  // release-tracking files. (Design decision logged 2026-05-21 after first
  // self-archive of B-2 raised the question.)
  if (flags['include-failed']) {
    // (a) Read state.
    const failedState = readState(harnessDir);

    // (b) detectHaltInfo — if null, the run completed normally; abort.
    const haltInfo = detectHaltInfo(harnessDir, failedState);
    if (!haltInfo) {
      console.log('[archive] Run completed normally; use cc-orch archive without --include-failed');
      return;
    }

    // (c) Compute seq.
    const failedSeq = computeSeq(archivesDir);

    // (d) Compute slug.
    const failedSpecPath = failedState.spec || failedState.projectMeta?.prdPath || '';
    const failedFirstMilestone = Object.values(failedState.milestones ?? {})[0];
    const failedMilestoneDescription = failedFirstMilestone?.description ?? null;
    const failedSlug = computeSlug(name, failedMilestoneDescription, failedSpecPath, failedSeq);

    // Read spec content for manifest snapshot.
    let failedSpecContent = '';
    try {
      const resolvedSpec = path.isAbsolute(failedSpecPath)
        ? failedSpecPath
        : path.join(projectRoot, failedSpecPath);
      if (failedSpecPath) failedSpecContent = fs.readFileSync(resolvedSpec, 'utf8');
    } catch {
      // Spec file missing — leave empty.
    }

    // (e) Create archive dir named failed-${seq}-${slug}.
    const failedArchiveDirName = `failed-${failedSeq}-${failedSlug}`;
    const failedArchiveDir = path.join(archivesDir, failedArchiveDirName);
    fs.mkdirSync(failedArchiveDir, { recursive: true });
    console.log(`[archive] Created failed archive directory: ${failedArchiveDirName}`);

    // (f) buildManifest with empty summaryData and haltInfo.
    const { gitHead: failedGitHead, gitStatus: failedGitStatus } = _getGitInfo(projectRoot);
    const failedGitInfo = { head: failedGitHead, status: failedGitStatus };
    const failedSummaryData = { headline: '', bugs: [], summary: '' };
    const failedUsageData = getUsageData(harnessDir);
    const failedManifest = buildManifest(
      failedState,
      failedSeq,
      failedSlug,
      failedSpecContent,
      failedGitInfo,
      failedSummaryData,
      failedUsageData,
      haltInfo,
    );

    // (g) Write manifest.json.
    fs.writeFileSync(
      path.join(failedArchiveDir, 'manifest.json'),
      JSON.stringify(failedManifest, null, 2),
      'utf8',
    );
    console.log('[archive] Wrote manifest.json');

    // (h) Copy spec to archive.
    const failedPreserveMode = !!(flags.preserve || flags.P);
    copySpecToArchive(failedSpecPath, projectRoot, failedArchiveDir, failedPreserveMode);

    // (i) Move harness state into archive.
    try { writeFingerprint(harnessDir); } catch { /* advisory — dispersion fingerprint is non-critical */ }
    moveHarnessToArchive(harnessDir, failedArchiveDir);
    console.log('[archive] Moved harness state into archive');
    clearActiveRunPointer(projectRoot);

    // Remove the drained per-run harness dir now that its contents have been
    // moved into the archive. Only fires when harnessDir is a genuine per-run
    // dir (.harness/<runId>/) — never when activeHarnessDir fell back to the
    // flat shared harness root, since that root's shared subdirs (learning/
    // dry-run/brainstorm/staging) must survive. Fail-soft: a missing path or
    // removal error never throws and never fails the forensic archive that
    // has already completed its move.
    if (path.resolve(harnessDir) !== path.resolve(harnessRoot(projectRoot))) {
      try {
        fs.rmSync(harnessDir, { recursive: true, force: true });
        console.log('[archive] Removed drained per-run harness dir');
      } catch {
        /* fail-soft — residue removal is best-effort, not part of the forensic archive contract */
      }
    }

    // (j) Reinit shared subdirs at the flat harness root (not the moved run dir).
    const failedHarnessRoot = harnessRoot(projectRoot);
    fs.mkdirSync(failedHarnessRoot, { recursive: true });
    for (const sub of SHARED_SUBDIRS) {
      fs.mkdirSync(path.join(failedHarnessRoot, sub), { recursive: true });
    }
    console.log('[archive] Reinitialized fresh .harness/ subdirectories');

    // (k) Return archiveDir.
    console.log(`[archive] Failed archive created at: ${failedArchiveDir}`);
    return failedArchiveDir;
  }

  // Step 1: Validate archivable, prompt if needed.
  console.log('[archive] Validating archivable state...');
  const validation = validateArchivable(harnessDir, autoMode);
  if (!validation.ok) {
    const proceed = await _promptYesNo(validation.message);
    if (!proceed) {
      console.log('[archive] Aborted.');
      return;
    }
  }

  // Step 2: Read state + compute seq (slug deferred until after summarizer).
  const seq = computeSeq(archivesDir);
  const state = readState(harnessDir);
  const specPath = state.spec || state.projectMeta?.prdPath || '';

  // Fix 2: gate the three release-tracking writes (version bump, CHANGELOG,
  // run-history) on whether this run is a clean delivery. A rejected,
  // non-terminal, or all-invalidated run is still archived as a forensic
  // record but does not bump/release.
  const cleanDelivery = isCleanDelivery(state);
  if (!cleanDelivery) {
    console.warn(
      '[archive] Run is not a clean delivery (rejected, non-terminal, or no completed ' +
      'milestone) — archiving a forensic record but skipping version bump, CHANGELOG, ' +
      'and run-history.'
    );
  }

  // Read spec content for manifest snapshot + summarizer data package.
  let specContent = '';
  try {
    const resolvedSpec = path.isAbsolute(specPath)
      ? specPath
      : path.join(projectRoot, specPath);
    if (specPath) specContent = fs.readFileSync(resolvedSpec, 'utf8');
  } catch {
    // Spec file missing — leave empty.
  }

  // Pre-compute summarizer data package (git log, state, spec, etc.)
  // BEFORE spawning the agent. The summarizer is synthesis-only (Rule 7).
  const usageData = getUsageData(harnessDir);
  const manifestUsageData = flags.usageBaseline
    ? { totalCost: Math.max(0, usageData.totalCost - flags.usageBaseline.totalCost), totalSessions: Math.max(0, usageData.totalSessions - flags.usageBaseline.totalSessions) }
    : usageData;
  const dataPackage = buildSummarizerDataPackage(state, projectRoot, specContent, usageData, archivesDir, deps);

  // Step 3: Spawn Summarizer BEFORE slug computation so headline can feed
  // into the directory name when `name` is empty (slug fallback chain:
  // name → milestone description → spec filename → dogfood-{seq}).
  console.log('[archive] Spawning summarizer (Haiku, <30s expected)...');
  const summarizerStart = Date.now();
  let summaryData = { headline: '', bugs: [], summary: '' };
  try {
    if (deps.summarize) {
      summaryData = await deps.summarize(dataPackage);
    } else {
      const logger = new LoggerImpl(harnessDir);
      const tokenTracker = new TokenTrackerImpl(harnessDir);
      const sessionManager = new SessionManagerImpl();
      summaryData = await new Summarizer(sessionManager, logger, tokenTracker).summarizeRun(dataPackage);
    }
    const elapsed = ((Date.now() - summarizerStart) / 1000).toFixed(1);
    console.log(`[archive] Summarizer complete (${elapsed}s): ${summaryData.headline || '(no headline)'}`);
  } catch (err) {
    const elapsed = ((Date.now() - summarizerStart) / 1000).toFixed(1);
    console.warn(`[archive] Summarizer failed after ${elapsed}s (continuing): ${err.message}`);
  }

  // Step 3a: Post-check — validate diff-file changelog sources against actual diff.
  // If any items reference files not in the diff, strip them and retry once.
  if (summaryData.changelog && summaryData.changelog.length > 0) {
    const { valid: validItems, invalid: invalidItems } = validateChangelogSources(
      summaryData.changelog,
      dataPackage.diffSummary,
    );
    if (invalidItems.length > 0) {
      console.warn(
        `[archive] ${invalidItems.length} changelog item(s) failed diff-file validation ` +
        `(files not in diff); retrying summarizer once...`,
      );
      const rejectedDesc = invalidItems
        .map(i => i.file ? `"${i.file}"` : `"${i.description}"`)
        .join(', ');
      const retryPackage = {
        ...dataPackage,
        rejectedChangelogItems: invalidItems,
        retryNote:
          `The following changelog items were rejected because their referenced files ` +
          `were not found in the diff: ${rejectedDesc}. ` +
          `Please only include changelog items for files that appear in the diff.`,
      };
      let retrySummaryData = null;
      try {
        if (deps.summarize) {
          retrySummaryData = await deps.summarize(retryPackage);
        } else {
          const logger = new LoggerImpl(harnessDir);
          const tokenTracker = new TokenTrackerImpl(harnessDir);
          const sessionManager = new SessionManagerImpl();
          retrySummaryData = await new Summarizer(sessionManager, logger, tokenTracker).summarizeRun(retryPackage);
        }
        // Validate the retry result; strip any still-invalid items.
        const { valid: retryValid, invalid: retryInvalid } = validateChangelogSources(
          retrySummaryData.changelog || [],
          dataPackage.diffSummary,
        );
        if (retryInvalid.length > 0) {
          console.warn(
            `[archive] Retry also produced ${retryInvalid.length} invalid item(s); ` +
            `stripping and continuing.`,
          );
          retrySummaryData = { ...retrySummaryData, changelog: retryValid };
        }
        summaryData = retrySummaryData;
      } catch (err) {
        console.warn(
          `[archive] Summarizer retry failed (stripping invalid items and continuing): ${err.message}`,
        );
        summaryData = { ...summaryData, changelog: validItems };
      }
    }
  }

  // Step 3b: Bump patch version via bump.js, then write CHANGELOG.md entry.
  // Only bump when the target project is this engine itself (package.json named
  // "nightfoundry", or the legacy "cc-orchestrator"). Driver and target may differ.
  let newVersion = 'unknown';
  let isOwnProject = false;
  try {
    const targetPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    isOwnProject = targetPkg.name === 'nightfoundry' || targetPkg.name === 'cc-orchestrator';
  } catch { /* no package.json or parse error — not cc-orch */ }
  if (isOwnProject && cleanDelivery) {
    try {
      const bumpScript = path.join(CC_ORCH_ROOT, 'scripts', 'bump.js');
      execSync(`node "${bumpScript}" patch --project "${projectRoot}"`, { encoding: 'utf8' });
      const pkgPath = path.join(projectRoot, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      newVersion = pkg.version ?? 'unknown';
    } catch (err) {
      console.warn(`[archive] Version bump failed (continuing): ${err.message}`);
    }
  }

  // Build and prepend CHANGELOG.md entry grouped by type.
  // Fix 2: only a clean delivery writes CHANGELOG (release-tracking write).
  if (cleanDelivery) {
    const changelogItems = summaryData?.changelog ?? [];
    const headline = summaryData?.headline ?? '';
    const dateStr = new Date().toISOString().slice(0, 10);

    const breaking = changelogItems.filter(c => c.type === 'breaking').map(c => `- ${c.description}`);
    const features = changelogItems.filter(c => c.type === 'feature').map(c => `- ${c.description}`);
    const fixes = changelogItems.filter(c => c.type === 'fix').map(c => `- ${c.description}`);

    const sections = [];
    if (breaking.length) sections.push(`### Breaking changes\n${breaking.join('\n')}`);
    if (features.length) sections.push(`### New features\n${features.join('\n')}`);
    if (fixes.length) sections.push(`### Bug fixes\n${fixes.join('\n')}`);

    const body = sections.length > 0
      ? sections.join('\n\n')
      : 'Maintenance release (no notable changes).';
    const changelogEntry = `## [${newVersion}] - ${dateStr} — ${headline}\n\n${body}\n\n`;

    const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
    let existingChangelog = '';
    try {
      existingChangelog = fs.readFileSync(changelogPath, 'utf8');
    } catch {
      // File doesn't exist yet — start fresh.
    }
    fs.writeFileSync(changelogPath, changelogEntry + existingChangelog, 'utf8');
    console.log(`[archive] Updated CHANGELOG.md (version ${newVersion})`);
  }

  // Step 4: Compute slug with 4-tier fallback:
  //   name (CLI arg / queue slug) → milestone description → spec filename → dogfood-{seq}.
  // The `name` precedence is what preserves queue-slug → archive-dir traceability
  // in batchResume and honors `cc-orch archive my-name` from the CLI router.
  const firstMilestone = Object.values(state.milestones ?? {})[0];
  const milestoneDescription = firstMilestone?.description ?? null;
  const slug = computeSlug(name, milestoneDescription, specPath, seq);

  // Step 5: Create archive dir.
  const archiveDirName = `${seq}-${slug}`;
  const archiveDir = path.join(archivesDir, archiveDirName);
  if (fs.existsSync(archiveDir)) {
    throw new Error(`Archive directory already exists: ${archiveDir}`);
  }
  fs.mkdirSync(archiveDir, { recursive: true });
  console.log(`[archive] Created archive directory: ${archiveDirName}`);

  // Cleanup guard: if anything between here and bootstrap() throws or
  // we return early, remove the partial archive dir so it doesn't leak
  // as an empty relic (bug found in dogfood 3).
  let archivedSuccessfully = false;
  const cleanupOnFailure = () => {
    if (!archivedSuccessfully && fs.existsSync(archiveDir)) {
      try {
        fs.rmSync(archiveDir, { recursive: true, force: true });
        console.log(`[archive] Cleaned up partial archive directory.`);
      } catch (err) {
        console.warn(`[archive] Cleanup failed: ${err.message}`);
      }
    }
  };

  try {
    // Step 6: getGitInfo.
    const { gitHead, gitStatus } = _getGitInfo(projectRoot);

    // Step 7: buildManifest + write manifest.json.
    const gitInfo = { head: gitHead, status: gitStatus };
    const manifest = buildManifest(state, seq, slug, specContent, gitInfo, summaryData, manifestUsageData);
    fs.writeFileSync(path.join(archiveDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    console.log('[archive] Wrote manifest.json');

    // Step 7b: Copy spec file into archive for reference.
    copySpecToArchive(specPath, projectRoot, archiveDir, !!(flags.preserve || flags.P));

    // Step 8: moveHarnessToArchive.
    try { writeFingerprint(harnessDir); } catch { /* advisory — dispersion fingerprint is non-critical */ }
    moveHarnessToArchive(harnessDir, archiveDir);
    console.log('[archive] Moved harness state into archive');
    clearActiveRunPointer(projectRoot);

    // Step 9: (writeGitignore removed — no longer called in archive flow)

    // Step 10: Reinit shared subdirs at the flat harness root (not the moved run dir).
    // Does NOT write state.json or call bootstrap().
    const successHarnessRoot = harnessRoot(projectRoot);
    fs.mkdirSync(successHarnessRoot, { recursive: true });
    for (const sub of SHARED_SUBDIRS) {
      fs.mkdirSync(path.join(successHarnessRoot, sub), { recursive: true });
    }
    console.log('[archive] Reinitialized fresh .harness/ subdirectories');

    archivedSuccessfully = true;
    console.log(`[archive] Archive created at: ${archiveDir}`);

    // Step 11a: Generate run report.
    try {
      await generateRunReport(archiveDir, projectRoot);
      console.log('[archive] Generated run report');
    } catch (err) {
      console.warn(`[archive] Run report generation failed (continuing): ${err.message}`);
    }

    // Step 11b: Update run history.
    // Fix 2: only a clean delivery updates run-history (release-tracking write).
    if (cleanDelivery) {
      try {
        await updateRunHistory(projectRoot, archiveDir, manifest);
        console.log('[archive] Updated run history');
      } catch (err) {
        console.warn(`[archive] Run history update failed (continuing): ${err.message}`);
      }
    }

    // Step 11: Export token usage to ccusage-compatible JSONL.
    try {
      const exportScript = path.join(CC_ORCH_ROOT, 'scripts', 'export-ccusage.js');
      if (fs.existsSync(exportScript)) {
        execSync(`node "${exportScript}" --project "${projectRoot}" --archive ${archiveDirName}`, { encoding: 'utf8' });
        console.log('[archive] Exported token usage to ccusage');
      }
    } catch (err) {
      console.warn(`[archive] ccusage export failed (continuing): ${err.message}`);
    }

    return archiveDir;
  } catch (err) {
    cleanupOnFailure();
    throw err;
  }
}
