/**
 * bootstrap.js — Pure-JS .harness/ initialization.
 *
 * Replaces bootstrap-harness.sh + init-harness.sh from the original
 * harness-orchestrator skill. Creates the directory tree, writes an
 * empty state.json, stamps createdWithVersion from cc-orch's package.json.
 *
 * What it does NOT do (deliberately):
 *   - No .claude/rules/harness-recovery.md (cc-orch is not a skill)
 *   - No standards-core.md deployment (reviewer rules are future work)
 *   - No preflight — that's a separate module, called by pipeline.js
 *   - No learning baseline — deferred until learning is implemented
 *
 * Public API:
 *   bootstrap(projectRoot, opts = {})
 *     opts.prdPath : optional spec path, stored in state.json.projectMeta
 *     opts.force   : overwrite existing .harness/ (default false)
 *     returns: { harnessDir, stateJsonPath, alreadyExisted }
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertNoReentrantLiveRun } from './reentrancy-guard.js';
import { runHarnessDir, harnessRoot } from './run-context.js';
import { ensureGitExcludes } from './git-excludes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Legacy-surface: this flat (no-runId) SUBDIRS list backs the flat bootstrap()
// branch below, retained for backward compatibility with callers that don't
// pass opts.runId. Per-run callers use PER_RUN_SUBDIRS / SHARED_SUBDIRS
// instead (see bootstrapRun).
export const SUBDIRS = [
  'state',
  'plan',
  'verify',
  'progress',
  'verification',
  'analysis',
  'snapshots',
  'learning',
  'dry-run',
  'logs',
  'brainstorm',
];

// Per-run subdirs: recreated/wiped per run under the per-run harness dir
// (see run-context.js:runHarnessDir). Union with SHARED_SUBDIRS equals
// SUBDIRS above.
export const PER_RUN_SUBDIRS = [
  'state',
  'plan',
  'verify',
  'progress',
  'verification',
  'analysis',
  'snapshots',
  'logs',
];

// Shared subdirs: persist across runs under the flat harness root
// (see run-context.js:harnessRoot). Union with PER_RUN_SUBDIRS equals
// SUBDIRS above.
export const SHARED_SUBDIRS = ['learning', 'dry-run', 'brainstorm'];

// Subdirs cleared when bootstrap is invoked with `force: true` on an existing
// harness — i.e., the batch-loop path between queue entries
// (pipeline.js:batchResume calls bootstrap(force:true) after each entry to
// recycle harness state for the next spec).
//
// Defect #7 (2026-04-26 investigation): prior behavior wrote a fresh state.json
// but left these subdirs intact. The next spec's _executeAllMilestones found
// stale `state/mission-*.json` and short-circuited decomposition via
// `isMissionAlreadyStarted`, producing a state where milestone description
// matched spec B but mission task lists matched spec A. snapshots/ collisions
// on deterministic taskIds (001-001-001-001 across specs) could also cause
// silent restoration of spec A's baseline files into spec B's working tree
// during retry. Both fixed by wiping the 7 subdirs below before recreate.
//
// Excluded from the wipe:
//   - learning/  (user-curated cross-run baseline; cc-orch never writes here)
//   - dry-run/   (separate code path, owns its own lifecycle)
const WIPE_SUBDIRS_ON_FORCE = [
  'state',
  'plan',
  'verify',
  'progress',
  'verification',
  'analysis',
  'snapshots',
];

/**
 * Read nightfoundry's own version from package.json.
 * Used to stamp `createdWithVersion` in state.json for upgrade checks.
 */
function readCcOrchVersion() {
  // Walk up from src/orchestrator/core/ to project root (3 levels).
  const pkgPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function bootstrap(projectRoot, opts = {}) {
  assertNoReentrantLiveRun(projectRoot);

  const { prdPath = '', force = false, runId = '' } = opts;

  if (prdPath && !path.isAbsolute(prdPath)) {
    throw new Error('opts.prdPath must be an absolute path');
  }

  if (!fs.existsSync(projectRoot)) {
    throw new Error(`Project root does not exist: ${projectRoot}`);
  }

  if (typeof runId === 'string' && runId.length > 0) {
    return bootstrapRun(projectRoot, runId, { prdPath, force });
  }

  // Legacy-surface: this flat (no-runId) branch is the pre-per-run-harness
  // layout, retained for backward compatibility for callers that don't pass
  // opts.runId. New callers should prefer opts.runId (see bootstrapRun).
  const harnessDir = harnessRoot(projectRoot);
  const stateJsonPath = path.join(harnessDir, 'state.json');
  const alreadyExisted = fs.existsSync(stateJsonPath);

  if (alreadyExisted && !force) {
    throw new Error(
      `.harness/state.json already exists at ${stateJsonPath}. ` +
      `Pass { force: true } to overwrite.`
    );
  }

  // Defect #7 fix: when force=true on an existing harness, wipe the 7
  // stateful subdirs before recreating. Without this, batch-loop iteration
  // leaves stale mission state files that short-circuit the next spec's
  // decomposition via isMissionAlreadyStarted. See WIPE_SUBDIRS_ON_FORCE
  // comment above for the full mechanism.
  if (alreadyExisted && force) {
    for (const sub of WIPE_SUBDIRS_ON_FORCE) {
      fs.rmSync(path.join(harnessDir, sub), { recursive: true, force: true });
    }
  }

  // Create directory tree.
  fs.mkdirSync(harnessDir, { recursive: true });
  for (const sub of SUBDIRS) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  // Write initial state.json.
  const state = {
    projectMeta: {
      prdPath,
      createdAt: new Date().toISOString(),
      createdWithVersion: readCcOrchVersion(),
      currentPhase: 'planning',
    },
    globalStatus: 'active',
    milestones: {},
  };
  fs.writeFileSync(stateJsonPath, JSON.stringify(state, null, 2));

  ensureGitExcludes(projectRoot);

  return { harnessDir, stateJsonPath, alreadyExisted };
}

/**
 * Create (or confirm) the shared, cross-run harness skeleton: harnessRoot,
 * each SHARED_SUBDIRS entry beneath it, and the .gitignore stanza. Guard-free
 * by design — no assertNoReentrantLiveRun, no existence/force checks — since
 * SHARED_SUBDIRS persist across runs and this is safe to call unconditionally
 * on every run. Called by bootstrapRun; may also be called directly by
 * callers that only need the shared skeleton without a per-run harness dir.
 *
 * @param {string} projectRoot
 */
export function ensureSharedSkeleton(projectRoot) {
  const sharedRoot = harnessRoot(projectRoot);
  fs.mkdirSync(sharedRoot, { recursive: true });
  for (const sub of SHARED_SUBDIRS) {
    fs.mkdirSync(path.join(sharedRoot, sub), { recursive: true });
  }

  ensureGitExcludes(projectRoot);
}

/**
 * Per-run bootstrap: mirrors bootstrap()'s already-exists / force-wipe /
 * directory-creation / state.json-write / return-shape behavior, but scoped
 * to a per-run harness dir (.harness/{runId}/) for stateful subdirs while
 * sharing SHARED_SUBDIRS (learning/dry-run/brainstorm) at the flat harness
 * root across runs. Called by bootstrap() when opts.runId is a non-empty
 * string; the no-runId path above is left untouched.
 *
 * @param {string} projectRoot
 * @param {string} runId
 * @param {{ prdPath: string, force: boolean }} opts
 */
function bootstrapRun(projectRoot, runId, { prdPath, force }) {
  const runDir = runHarnessDir(projectRoot, runId);
  const stateJsonPath = path.join(runDir, 'state.json');
  const alreadyExisted = fs.existsSync(stateJsonPath);

  if (alreadyExisted && !force) {
    throw new Error(
      `.harness/state.json already exists at ${stateJsonPath}. ` +
      `Pass { force: true } to overwrite.`
    );
  }

  // Defect #7 fix, scoped to the run dir: wipe the 7 stateful subdirs
  // within this run's directory only, preserving its logs/. See
  // WIPE_SUBDIRS_ON_FORCE comment above for the full mechanism.
  if (alreadyExisted && force) {
    for (const sub of WIPE_SUBDIRS_ON_FORCE) {
      fs.rmSync(path.join(runDir, sub), { recursive: true, force: true });
    }
  }

  // Shared subdirs persist across runs at the flat harness root, plus the
  // .gitignore stanza.
  ensureSharedSkeleton(projectRoot);

  // Per-run subdirs live inside the run dir only.
  fs.mkdirSync(runDir, { recursive: true });
  for (const sub of PER_RUN_SUBDIRS) {
    fs.mkdirSync(path.join(runDir, sub), { recursive: true });
  }

  // Write initial state.json inside the run dir.
  const state = {
    projectMeta: {
      prdPath,
      createdAt: new Date().toISOString(),
      createdWithVersion: readCcOrchVersion(),
      currentPhase: 'planning',
    },
    globalStatus: 'active',
    milestones: {},
  };
  fs.writeFileSync(stateJsonPath, JSON.stringify(state, null, 2));

  return { harnessDir: runDir, stateJsonPath, alreadyExisted };
}
