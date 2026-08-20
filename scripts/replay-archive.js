#!/usr/bin/env node
/**
 * replay-archive.js — Replays a single archived harness session (or probes a
 * corpus of archives) from recorded logs, without ever writing back into the
 * archive or corpus directories it reads from.
 *
 * Modes:
 *   node scripts/replay-archive.js <archiveDir>        # replay a single archive
 *   node scripts/replay-archive.js --probe <corpusDir> # probe every archive in a corpus dir
 *   node scripts/replay-archive.js                     # (no args) prints usage
 *
 * All work performed by this script happens read-only against the
 * caller-supplied `archiveDir` / `corpusDir` — the only paths this module
 * ever opens for writing are scratch directories it creates itself via
 * `fs.mkdtemp`. No argument-supplied path is ever opened for writing.
 *
 * Exit codes:
 *   0 — replay/probe completed
 *   1 — usage error (missing/unrecognized arguments); usage text is printed
 *       to stderr before exiting
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';

import {
  createFakeSessionManager,
  loadArchiveBundle,
  loadSessionRecordings,
  readRecordedOutcomes,
  readRecordedTerminalState,
  compareReplay,
  classifyDivergence,
  classifyDivergences,
  summarizeClassification,
  MissingExitStructuredOutputError,
  RecordingExhaustedError,
} from './replay-lib.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';

export const USAGE = [
  'Usage:',
  '  node scripts/replay-archive.js <archiveDir>          # replay a single archive',
  '  node scripts/replay-archive.js --probe <corpusDir>   # probe every archive in a corpus dir',
  '  node scripts/replay-archive.js --golden [manifest]   # replay the golden corpus manifest',
].join('\n');

// This script's own directory and the repo root it lives under (one level
// up from scripts/) — used to resolve the default golden manifest path and
// to resolve each golden manifest entry's `dir` repo-relatively, regardless
// of the caller's current working directory.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_GOLDEN_MANIFEST_PATH = path.join(SCRIPT_DIR, 'replay-golden.json');

/**
 * Parses CLI arguments into a mode descriptor.
 *
 * @param {string[]} argv - arguments (excluding node/script path, i.e. process.argv.slice(2))
 * @returns {{mode:'replay', archiveDir:string}|{mode:'probe', corpusDir:string}|{mode:'golden', manifestPath:string|null}|{mode:'usage', error?:string}}
 */
export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { mode: 'usage', error: 'No arguments provided.' };
  }

  if (argv[0] === '--probe') {
    const corpusDir = argv[1];
    if (!corpusDir) {
      return { mode: 'usage', error: '--probe requires a corpus directory argument.' };
    }
    if (argv.length > 2) {
      return { mode: 'usage', error: `Unrecognized extra arguments: ${argv.slice(2).join(' ')}` };
    }
    return { mode: 'probe', corpusDir };
  }

  if (argv[0] === '--golden') {
    if (argv.length > 2) {
      return { mode: 'usage', error: `Unrecognized extra arguments: ${argv.slice(2).join(' ')}` };
    }
    return { mode: 'golden', manifestPath: argv.length === 2 ? argv[1] : null };
  }

  if (argv.length === 1 && !argv[0].startsWith('--')) {
    return { mode: 'replay', archiveDir: argv[0] };
  }

  return { mode: 'usage', error: `Unrecognized arguments: ${argv.join(' ')}` };
}

/**
 * Reads and parses the golden corpus manifest JSON, defaulting to
 * `scripts/replay-golden.json` (resolved relative to THIS script's own
 * directory, not the caller's cwd) when `manifestPath` is null/falsy — the
 * explicit-path form exists so hermetic tests can point this at a temp
 * manifest fixture instead of the real committed one.
 *
 * Never catches: a missing file or malformed JSON propagates as a loud
 * `fs.readFileSync`/`JSON.parse` throw, consistent with this module's
 * "loud failure over silent corruption" philosophy for ground-truth data.
 *
 * @param {string|null} manifestPath - explicit manifest path, or null to use the default
 * @returns {object} the parsed manifest JSON
 */
export function loadGoldenManifest(manifestPath) {
  const resolvedPath = manifestPath || DEFAULT_GOLDEN_MANIFEST_PATH;
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Creates a fresh scratch directory under the OS temp dir. This is the only
 * kind of path this module ever opens for writing.
 *
 * @param {string} prefix
 * @returns {string} absolute path to the newly created directory
 */
function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Classifies a single corpus subdirectory (an archive-shaped directory) as
 * replayable or not, entirely read-only. A directory is "replayable" when
 * ALL of the following hold:
 *   - it has a logs/ directory containing at least one *.jsonl recording
 *   - every recording under logs/ carries an exit-event structured_output
 *     (i.e. loadSessionRecordings() does not raise
 *     MissingExitStructuredOutputError — see replay-lib.js)
 *   - it has recorded ground truth to replay against: at least one
 *     state/mission-*.json file, and a non-empty verification/ directory
 *
 * Any failure along the way — a missing directory, an unreadable file, a
 * malformed recording — is caught and reported as "not replayable" with a
 * human-readable reason; this function never throws.
 *
 * @param {string} name - the subdirectory's basename (relative to corpusDir)
 * @param {string} dir - absolute path to the subdirectory
 * @returns {{ name: string, replayable: boolean, reason: string }}
 */
function probeOneArchive(name, dir) {
  const logsDir = path.join(dir, 'logs');
  if (!fs.existsSync(logsDir)) {
    return { name, replayable: false, reason: 'missing logs/ directory' };
  }

  let recordingFiles;
  try {
    recordingFiles = fs.readdirSync(logsDir).filter((f) => f.endsWith('.jsonl'));
  } catch (err) {
    return { name, replayable: false, reason: `unreadable logs/ directory: ${err.message}` };
  }

  if (recordingFiles.length === 0) {
    return { name, replayable: false, reason: 'logs/ directory has no recordings' };
  }

  try {
    loadSessionRecordings(dir);
  } catch (err) {
    if (err instanceof MissingExitStructuredOutputError) {
      return {
        name,
        replayable: false,
        reason: `missing exit-event structured_output: ${path.basename(err.recordingFile)}`,
      };
    }
    return { name, replayable: false, reason: `unreadable recording: ${err.message}` };
  }

  const stateDir = path.join(dir, 'state');
  let missionFiles = [];
  try {
    missionFiles = fs.existsSync(stateDir)
      ? fs.readdirSync(stateDir).filter((f) => /^mission-.*\.json$/.test(f))
      : [];
  } catch (err) {
    return { name, replayable: false, reason: `unreadable state/ directory: ${err.message}` };
  }
  if (missionFiles.length === 0) {
    return { name, replayable: false, reason: 'no ground-truth state/mission-*.json files' };
  }

  const verificationDir = path.join(dir, 'verification');
  let hasVerification = false;
  try {
    hasVerification = fs.existsSync(verificationDir) && fs.readdirSync(verificationDir).length > 0;
  } catch (err) {
    return { name, replayable: false, reason: `unreadable verification/ directory: ${err.message}` };
  }
  if (!hasVerification) {
    return { name, replayable: false, reason: 'missing verification/ ground-truth files' };
  }

  return { name, replayable: true, reason: 'complete recordings and ground truth' };
}

/**
 * Scans every immediate subdirectory of a corpus directory (read-only) and
 * classifies each as replayable or not, based on exit-event
 * structured_output coverage across its logs/*.jsonl recordings and the
 * presence of ground-truth files (state/mission-*.json and verification/).
 *
 * Never throws: a subdirectory whose recordings are unreadable or missing
 * is simply reported as not replayable (see probeOneArchive), and a
 * corpusDir that itself can't be read yields an empty (all-zero) result
 * rather than raising.
 *
 * @param {string} corpusDir
 * @returns {{
 *   total: number,
 *   replayable: number,
 *   rate: number,
 *   entries: Array<{ name: string, replayable: boolean, reason: string }>,
 * }}
 */
export function probeCorpus(corpusDir) {
  let dirNames = [];
  try {
    dirNames = fs.readdirSync(corpusDir)
      .filter((d) => {
        try {
          return fs.statSync(path.join(corpusDir, d)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    dirNames = [];
  }

  const entries = dirNames.map((name) => probeOneArchive(name, path.join(corpusDir, name)));

  const total = entries.length;
  const replayable = entries.filter((e) => e.replayable).length;
  const rate = total > 0 ? replayable / total : 0;

  return { total, replayable, rate, entries };
}

/**
 * Probes every archive found under a corpus directory (read-only) and
 * prints a per-directory verdict line plus a summary rate report. Asserts
 * nothing — a probe run is informational only.
 *
 * @param {string} corpusDir
 */
function runProbe(corpusDir) {
  console.log(`Probing corpus: ${corpusDir}`);

  const { total, replayable, rate, entries } = probeCorpus(corpusDir);

  for (const entry of entries) {
    const verdict = entry.replayable ? 'REPLAYABLE' : 'NOT REPLAYABLE';
    console.log(`  [${verdict}] ${entry.name}: ${entry.reason}`);
  }

  const ratePct = (rate * 100).toFixed(1);
  console.log(`Summary: ${replayable}/${total} replayable (rate=${ratePct}%)`);
}

/**
 * Materializes the spec pair from an already-loaded archive bundle into a
 * throwaway project directory under the OS temp dir. This is the only kind
 * of path this module ever opens for writing.
 *
 * @param {{archiveId:string, spec:{md:string|null, json:object|null}}} bundle
 *   - a bundle as returned by loadArchiveBundle()
 * @returns {{projectRoot:string, specPath:string, cleanup:() => void}}
 */
export function materializeReplayProject(bundle) {
  if (!bundle || !bundle.spec || bundle.spec.md == null) {
    const archiveName = (bundle && (bundle.archiveId || bundle.archiveDir)) || 'unknown archive';
    throw new Error(`materializeReplayProject: archive "${archiveName}" has no spec.md to replay.`);
  }

  const projectRoot = makeScratchDir('replay-project-');
  const specPath = path.join(projectRoot, 'spec.md');

  fs.writeFileSync(specPath, bundle.spec.md);
  if (bundle.spec.json != null) {
    const specJsonPath = path.join(projectRoot, 'spec.json');
    fs.writeFileSync(specJsonPath, JSON.stringify(bundle.spec.json, null, 2));
  }

  const cleanup = () => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  };

  return { projectRoot, specPath, cleanup };
}

/**
 * Builds a command executor shaped for the hardCheck / regression injection
 * seams — `runCommand(command, options)` (gates/hard-checks.js's
 * execCommand) and `execSync(command, options)` (gates/regression.js's
 * `deps.execSync ?? execSync`) both call their dependency with an
 * (command, options) pair and expect a stdout string back on success, or an
 * execSync-shaped throw (an Error carrying `status`/`stdout`/`stderr`) on
 * failure — so one function satisfies both seams.
 *
 * Never shells out: the archive's recorded regression outcomes
 * (`bundle.outcomes.regression`, a scopeId → verdict map read from
 * `verification/task-regression-*.json`) are the archive's only recorded
 * ground truth for "did commands run against this tree pass or fail", so a
 * replay run resolves every command call from that recorded outcome
 * instead of invoking a child process: any recorded 'FAILED' regression
 * verdict makes every subsequent command call in the replay fail (mirroring
 * execSync's throw-on-nonzero-exit contract); with no recorded failure the
 * call resolves as if the command succeeded (empty stdout), matching an
 * archive that only exists because its gates passed (or were skipped).
 *
 * @param {{outcomes:{regression:Map<string,*>}}} bundle - a loadArchiveBundle() result
 * @returns {(command: string, options?: object) => string} runCommand/execSync-shaped function
 */
function buildReplayCommandExecutor(bundle) {
  const regression = bundle?.outcomes?.regression instanceof Map ? bundle.outcomes.regression : new Map();
  return function replayCommandExecutor(command) {
    const failedScope = [...regression.entries()].find(([, result]) => result === 'FAILED');
    if (failedScope) {
      const [scopeId] = failedScope;
      const err = new Error(
        `[replay] Command not executed — archive recorded a FAILED regression verdict for scope '${scopeId}': ${command}`
      );
      err.status = 1;
      err.stdout = '';
      err.stderr = err.message;
      throw err;
    }
    return '';
  };
}

/**
 * Reconstructs the Phase 3a planGlobal()-shaped plan (`{ milestones, ... }`)
 * from an archive's own persisted `state.json`, read directly from
 * `archiveDir` (read-only — this module never writes into archiveDir).
 *
 * Why this exists: planGlobal() is, in the current codebase, its OWN
 * call-local spawnReusable({name:'planner-global', ...}) session — distinct
 * from the per-mission reusable session (named 'planner-reusable', see
 * replay-lib.js's createFakeSessionManager docstring) that bundle.plans
 * (reconstructPlansFromArchive's per-mission decomps) is sourced from and
 * shared across. bundle.plans entries are shaped `{ subMissions: [...] }`
 * (mission-level), never `{ milestones: [...] }` (global-level) — feeding
 * planGlobal's sendPrompt() from that same cursor would both hand it the
 * wrong shape AND silently steal the first mission's decomp turn out from
 * under the per-mission session. So planGlobal's session is served from
 * this dedicated reconstruction instead (see buildGlobalPlanSession below).
 *
 * state.json's top-level `milestones` map (keyed by milestone id, each
 * carrying `missions` keyed by mission id with `id`/`description`/
 * `targetFiles` already persisted) is exactly the archive's own recorded
 * ground truth for what planGlobal returned — extra bookkeeping fields
 * (status/stateFile/planFile) are dropped, not just ignored, so the
 * reconstructed plan carries only the fields planGlobal's schema declares.
 * `projectMeta.scopeMapping` (also persisted verbatim from the original
 * run) is carried through unchanged so `_scopeCoverageGate` reproduces the
 * same zero-uncovered-items verdict the archived run recorded — the gate
 * validates scopeMapping's mission ids against globalPlan.milestones'
 * mission ids, so both must come from the same ground truth or the mapping
 * would falsely appear incomplete. `assumptions` is always `[]`: no
 * archive persists planGlobal's raw assumptions list once the run has
 * moved past Phase 3a, and an empty list keeps the replay from taking the
 * (LLM-shaped) assumption-remediation branch, which nothing in the v0
 * comparison whitelist (see replay-lib.js's compareReplay) depends on.
 *
 * Never throws: a missing/unreadable/malformed state.json, or one with no
 * usable `milestones` map, yields null rather than raising — the caller
 * (buildGlobalPlanSession) turns that into a loud RecordingExhaustedError
 * at sendPrompt() time instead, consistent with this file's/replay-lib's
 * shared "loud failure over silent corruption" philosophy.
 *
 * @param {string} archiveDir
 * @returns {{milestones:Array, assumptions:Array, scopeMapping:Array}|null}
 */
export function reconstructGlobalPlanFromArchive(archiveDir) {
  const statePath = path.join(archiveDir, 'state.json');
  if (!fs.existsSync(statePath)) return null;

  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }

  const milestonesObj = state && typeof state === 'object' ? state.milestones : null;
  if (!milestonesObj || typeof milestonesObj !== 'object' || Array.isArray(milestonesObj)) {
    return null;
  }

  const milestoneIds = Object.keys(milestonesObj).sort();
  if (milestoneIds.length === 0) return null;

  const milestones = milestoneIds.map((msId) => {
    const ms = milestonesObj[msId] || {};
    const missionsObj = ms.missions && typeof ms.missions === 'object' ? ms.missions : {};
    const missions = Object.keys(missionsObj).sort().map((missionId) => {
      const m = missionsObj[missionId] || {};
      return {
        id: m.id || missionId,
        description: m.description || '',
        targetFiles: Array.isArray(m.targetFiles) ? m.targetFiles : [],
      };
    });
    return { id: ms.id || msId, description: ms.description || '', missions };
  });

  const scopeMapping = Array.isArray(state?.projectMeta?.scopeMapping)
    ? state.projectMeta.scopeMapping
    : [];

  return { milestones, assumptions: [], scopeMapping };
}

/**
 * Builds a spawnReusable()-shaped session (matching replay-lib.js's
 * createFakeSessionManager().spawnReusable() contract — `{ handle,
 * turnCount, sendPrompt(promptText), close() }`) that serves EXACTLY the
 * reconstructed global plan (see reconstructGlobalPlanFromArchive) on its
 * first turn, and raises RecordingExhaustedError on any further turn — a
 * plan-lint corrective retry is possible in principle (planner.js's
 * bounded one-extra-turn loop) but this session has no second ground-truth
 * plan to serve, so a second turn is a loud failure rather than silently
 * re-serving (and thereby corrupting) the same plan.
 *
 * @param {{archiveDir:string}} bundle - a loadArchiveBundle() result
 * @returns {{handle:object, turnCount:number, sendPrompt:Function, close:Function}}
 */
function buildGlobalPlanSession(bundle) {
  const globalPlan = reconstructGlobalPlanFromArchive(bundle.archiveDir);
  let turnCount = 0;
  const handle = {
    name: 'planner-global',
    agent: null,
    systemPromptTokens: 0,
    _toolCallCount: 0,
  };
  return {
    handle,
    get turnCount() {
      return turnCount;
    },
    async sendPrompt(_promptText) {
      turnCount += 1;
      if (!globalPlan || turnCount > 1) {
        throw new RecordingExhaustedError('planner:global');
      }
      return { structured_output: globalPlan, usage: {}, total_cost_usd: 0 };
    },
    async close() {
      // No underlying process to tear down — no-op, matching
      // ReusableSession.close()'s Promise-returning signature.
    },
  };
}

/**
 * Reconstructs the per-mission ground-truth decomposition Map that
 * replay-lib.js's reconstructPlansFromArchive would normally produce (same
 * `Map<missionId, {subMissions:[{id,description,tasks:[...]}]}>` shape,
 * same missionId-sorted key order), but filtered down to each mission's
 * INITIAL planning batch only — dropping any task whose `createdAt`
 * postdates that mission's own earliest task `createdAt`.
 *
 * Why this exists: state/mission-*.json persists a mission's FINAL,
 * post-remediation task set. A milestone-review remediation arc (reviewer
 * FAIL → analyzer → planner-review-remediate) appends a brand-new task to
 * an ALREADY-PLANNED mission via a plain spawn() sourced from its own
 * single-turn recording (see buildReplayDeps below) — feeding that same
 * appended task back out of the FIRST planMission() call for that mission
 * (i.e. from replay-lib.js's unfiltered reconstructPlansFromArchive/
 * bundle.plans) would double-serve the task's identity: the initial
 * per-mission decomposition would consume the task — and, worse, steal
 * its dedicated executor/verifier recordings — before the remediation arc
 * ever runs; the pipeline's id-normalize collision handling would then
 * shift the remediation planner's OWN newTask onto a fresh id with no
 * recording left to serve it.
 *
 * Every task belonging to a mission's initial planning batch is persisted
 * with the SAME createdAt timestamp (assigned once, in a batch, when
 * planMission() returns and the pipeline first writes the mission's task
 * set to state); a remediation-appended task is persisted with its own,
 * later, individually-assigned createdAt — so filtering each mission down
 * to the task subset sharing its OWN earliest createdAt recovers exactly
 * the initial decomposition batch and drops any later remediation-
 * appended task, without needing any other signal for *how* a task was
 * added. A mission with no task-level createdAt data at all (or none
 * parseable) is left unfiltered — every task is kept — rather than
 * dropped wholesale.
 *
 * Never throws: a missing state/ directory, or an unreadable/malformed
 * mission-*.json file, is skipped rather than raising.
 *
 * @param {string} archiveDir
 * @returns {Map<string, {subMissions:Array}>} missionId → initial-batch-only decomp
 */
function reconstructInitialPlansFromArchive(archiveDir) {
  const plans = new Map();
  const stateDir = path.join(archiveDir, 'state');
  if (!fs.existsSync(stateDir)) return plans;

  const missionFiles = fs.readdirSync(stateDir)
    .filter((f) => /^mission-.*\.json$/.test(f))
    .sort();

  for (const file of missionFiles) {
    const filePath = path.join(stateDir, file);
    let missionState;
    try {
      missionState = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    const missionId = missionState.id || missionState.missionId || file.replace(/^mission-/, '').replace(/\.json$/, '');

    // The mission's earliest task createdAt across every sub-mission —
    // the timestamp shared by every task in the initial planning batch.
    let earliest = null;
    for (const sm of Object.values(missionState.subMissions || {})) {
      for (const task of Object.values(sm.tasks || {})) {
        if (typeof task.createdAt === 'string' && (earliest === null || task.createdAt < earliest)) {
          earliest = task.createdAt;
        }
      }
    }

    const subMissions = [];
    for (const [, sm] of Object.entries(missionState.subMissions || {}).sort(([a], [b]) => a.localeCompare(b))) {
      const tasks = [];
      for (const [, task] of Object.entries(sm.tasks || {}).sort(([a], [b]) => a.localeCompare(b))) {
        // Drop any task whose createdAt postdates the mission's earliest —
        // a later remediation-appended task. Tasks with no parseable
        // createdAt at all (earliest === null) are always kept.
        if (earliest !== null && task.createdAt !== earliest) continue;
        tasks.push({
          id: task.id,
          description: task.description,
          targetFiles: task.targetFiles || [],
          dependencies: task.dependencies || [],
          testCases: task.testCases || [],
          tracesScenario: task.tracesScenario || [],
          patternReferences: task.patternReferences || [],
          dataSchemas: task.dataSchemas || [],
        });
      }
      if (tasks.length > 0) {
        subMissions.push({ id: sm.id, description: sm.description, tasks });
      }
    }
    plans.set(missionId, { subMissions });
  }

  return plans;
}

/**
 * Adapts replay-lib.js's createFakeSessionManager() output to the exact
 * calling convention the real agents (executor.js/verifier.js/planner.js/
 * etc, via Logger.attachToSession) use against the real SessionManager:
 *   - spawn(options) is called, then `.handle` is read off the RETURNED
 *     PROMISE synchronously (before it settles) so attachToSession(...) can
 *     register listeners on it; only afterwards is the promise awaited for
 *     `{ handle, result }`. The real SessionManager (infra/session-manager.js)
 *     hangs the handle off the promise it returns (`raced.handle = handle`)
 *     for exactly this reason. The fake spawn() is a plain async function
 *     whose returned Promise carries no such property, so this wrapper
 *     builds the EventEmitter-shaped handle up front, hangs it off the
 *     returned promise, and resolves the promise with that SAME handle
 *     object (merged with the fake's recorded handle fields) once the fake
 *     spawn() settles — so pre- and post-await access see one consistent
 *     handle.
 *   - spawnReusable(options)'s returned `.handle` is read synchronously the
 *     same way (planner.js). The fake's handle is a plain object; this
 *     wrapper upgrades it to an EventEmitter so attachToSession's
 *     `handle.on(...)` calls don't throw. No real events are ever emitted
 *     on it — the fake session manager only ever replays final recorded
 *     results, not the granular init/message/result event stream — so
 *     attachToSession's listeners are registered but never fire, which is
 *     harmless (logging is best-effort against replayed data).
 *   - setTokenTracker(...) is added as a no-op: Pipeline's constructor
 *     always calls `sessionManager.setTokenTracker(this.tokenTracker)`, but
 *     the fake manager doesn't track token usage.
 *   - spawnReusable(options) called with name:'planner-global' (Phase 3a's
 *     planGlobal(), a call-local reusable session distinct from the
 *     per-mission reusable session — see planner.js) is diverted BEFORE
 *     ever reaching the fake session manager: fakeSessionManager's
 *     spawnReusable always serves the shared bundle.plans cursor, which
 *     holds per-mission ({subMissions:[...]}) decomps, not the
 *     ({milestones:[...]}) shape planGlobal needs — and consuming from
 *     that shared cursor here would also steal the first mission's turn
 *     out from under the real per-mission session. See
 *     buildGlobalPlanSession/reconstructGlobalPlanFromArchive above for
 *     where that session's plan actually comes from (the archive's own
 *     persisted state.json, read directly — never from bundle.plans).
 *
 * @param {{spawn:Function, spawnReusable:Function}} fakeSessionManager - createFakeSessionManager() result
 * @param {{archiveDir:string}} bundle - a loadArchiveBundle() result, used only to resolve the 'planner-global' diversion above
 * @returns {{spawn:Function, spawnReusable:Function, setTokenTracker:Function}} real-SessionManager-calling-convention-shaped adapter
 */
function adaptFakeSessionManager(fakeSessionManager, bundle) {
  return {
    spawn(options = {}) {
      const handle = new EventEmitter();
      handle.name = options.name || options.agent || 'unnamed';
      handle.agent = options.agent || null;
      handle.finished = false;

      const settled = fakeSessionManager.spawn(options).then(({ handle: fakeHandle, result }) => {
        Object.assign(handle, fakeHandle, { finished: true });
        return { handle, result };
      });
      settled.handle = handle;
      return settled;
    },

    spawnReusable(options = {}) {
      const session = options.name === 'planner-global'
        ? buildGlobalPlanSession(bundle)
        : fakeSessionManager.spawnReusable(options);
      const handle = new EventEmitter();
      Object.assign(handle, session.handle);
      return { ...session, handle };
    },

    // See docstring above: Pipeline's constructor calls this unconditionally.
    setTokenTracker: () => {},
  };
}

/**
 * Builds the Pipeline options object used to replay an archived session:
 * every engine leg that would otherwise spawn a real Claude session, shell
 * out to a real command, touch the real filesystem, or block on a real TTY
 * is swapped for one served from the loaded archive bundle (or a
 * deterministic no-op), so a Pipeline constructed with these deps
 * reproduces the archived run from recorded data alone.
 *
 * @param {object} bundle - a loadArchiveBundle() result (see replay-lib.js)
 * @returns {object} Pipeline constructor opts: sessionManager, hardCheckDeps,
 *   regressionDeps, assertChangesLanded, snapshotFiles, restoreSnapshot,
 *   runFinalTestGate, onConfirm, onMenu, statusBar
 */
export function buildReplayDeps(bundle) {
  const runCommand = buildReplayCommandExecutor(bundle);

  // The reusable per-mission planner session must be served each mission's
  // INITIAL planning batch only — never the FINAL, post-remediation task
  // set replay-lib.js's bundle.plans carries (see
  // reconstructInitialPlansFromArchive's docstring above for why a
  // remediation-appended task must NOT be replayed as part of the
  // mission's first planMission() turn). A shallow-copied bundle (same
  // archiveDir/spec/recordings/outcomes, `.plans` overridden) is handed to
  // createFakeSessionManager instead of `bundle` itself so this filtering
  // stays entirely local to this file — replay-lib.js's own bundle is
  // never mutated.
  const sessionManagerBundle = { ...bundle, plans: reconstructInitialPlansFromArchive(bundle.archiveDir) };

  return {
    // Fake SessionManager: replays each identity key's recorded exit-event
    // structured_output in recorded order instead of spawning a real
    // Claude session. See replay-lib.js's createFakeSessionManager for the
    // full spawn()/spawnReusable() contract, and adaptFakeSessionManager
    // above for why it's wrapped before being handed to Pipeline.
    sessionManager: adaptFakeSessionManager(createFakeSessionManager(sessionManagerBundle), bundle),

    // gates/hard-checks.js's runHardChecks / runMilestoneOnlyChecks injection
    // seam — resolves every command from the archive's recorded outcomes
    // (see buildReplayCommandExecutor) rather than shelling out.
    hardCheckDeps: { runCommand },

    // gates/regression.js's runTestCommand injection seam — same recorded
    // resolution as hardCheckDeps, under the `execSync` key runTestCommand
    // expects (`deps.execSync ?? execSync`).
    regressionDeps: { execSync: runCommand },

    // core/snapshots.js's phantom-write predicate. Pass-through: replay
    // never performs real file snapshots (see snapshotFiles/restoreSnapshot
    // below), so there is nothing to compare — always report "changes
    // landed" and hand the pipeline the same verdict shape the real
    // assertChangesLanded returns (`{ ok, unchanged, bothMissing }`), for it
    // to act on exactly as it would a genuine passing check.
    assertChangesLanded: (_harnessDir, _projectRoot, _taskId, _files) => ({
      ok: true,
      unchanged: [],
      bothMissing: [],
    }),

    // core/snapshots.js's capture/restore seam. Replay never needs
    // before/after file snapshots on disk — no-op implementations that
    // perform no filesystem work, matching snapshotFiles'/restoreSnapshot's
    // signatures.
    snapshotFiles: (_harnessDir, _projectRoot, _taskId, _phase, _files) => {},
    restoreSnapshot: (_harnessDir, _projectRoot, _taskId, _phase, _overrides) => 0,

    // cli/commands/archive.js's final-suite gate seam. An archive only
    // exists because the run it captures reached archival — i.e. its final
    // test gate already passed (or was explicitly skipped) — so replay
    // supplies that same passing result directly and never invokes the
    // real suite (a no-op success mirrors runFinalTestGate's void return
    // on success; it only ever communicates failure by throwing).
    runFinalTestGate: (_projectRoot, _flags) => {},

    // Non-interactive prompts so a replay run never blocks on a TTY:
    // onConfirm always answers affirmatively, onMenu always resolves
    // immediately by picking the first offered option (by convention the
    // proceed/affirmative choice — see pipeline.js's 'Proceed with this
    // plan?' menu, whose first option is { key: 'y', label: 'Yes' }).
    onConfirm: (_question) => true,
    onMenu: (_question, options) => (Array.isArray(options) && options.length > 0 ? options[0].key : null),

    // Disable the interactive dashboard status bar — replay is a
    // non-interactive, scripted run.
    statusBar: false,
  };
}

/**
 * Compares the archive's RECORDED terminal state (readRecordedTerminalState,
 * see replay-lib.js) against the replayed run's own terminal outcome — i.e.
 * whether the wrapped `pipeline.run(...)` call in replayArchive halted with
 * a terminal pipeline exception (e.g. a replayed reviewer hard stop raising
 * CircuitBreakerError) or completed cleanly.
 *
 * Reports a green MATCH (an empty array) when both sides halted, or both
 * sides completed cleanly. Any other combination — recorded clean but the
 * replay threw, or recorded halted but the replay completed cleanly —
 * yields exactly ONE divergence report entry, shaped like a compareReplay()
 * entry so it can be concatenated with a compareReplay() report and run
 * through the SAME classifier/summarizer. That entry's `field` ('terminal')
 * never matches the one known-excluded fs-invalidation shape (field:
 * 'status', expected: 'invalidated', actual: 'complete'), so
 * classifyDivergence always tags it 'unexplained' — this function builds no
 * error-class taxonomy or haltReason-to-exception mapping of its own; only
 * the two sides' halted/clean booleans are ever compared.
 *
 * @param {{halted:boolean, haltReason:string|null}} recordedTerminalState -
 *   readRecordedTerminalState(archiveDir)'s result
 * @param {{halted:boolean}} replayedTerminalOutcome - whether the replayed
 *   pipeline.run() call halted with a terminal exception (true) or
 *   completed cleanly (false)
 * @param {string|null} [archiveId] - stamped onto a divergence entry's
 *   `archive` field, matching compareReplay()'s report entry shape
 * @returns {Array<{archive:string|null, identity:string, field:string,
 *   expected:boolean, actual:boolean}>} empty on match; exactly one entry
 *   otherwise
 */
export function compareTerminalOutcome(recordedTerminalState, replayedTerminalOutcome, archiveId = null) {
  const recordedHalted = !!(recordedTerminalState && recordedTerminalState.halted);
  const replayedHalted = !!(replayedTerminalOutcome && replayedTerminalOutcome.halted);

  if (recordedHalted === replayedHalted) return [];

  return [{
    archive: archiveId,
    identity: 'terminal',
    field: 'terminal',
    expected: recordedHalted,
    actual: replayedHalted,
  }];
}

/**
 * Replays a single archive end-to-end through the REAL Pipeline (with every
 * spawn/shell/filesystem/TTY seam replaced by buildReplayDeps(bundle)) and
 * compares the replayed run's outcomes against the archive's recorded
 * ground truth.
 *
 * The archive bundle is loaded, its spec pair materialized into a throwaway
 * temp project (materializeReplayProject), and a real Pipeline is
 * constructed against that temp project root with buildReplayDeps(bundle)
 * as its options. pipeline.run(goal, { prdPath: specPath }) drives the full
 * orchestration flow purely from recorded data.
 *
 * The `pipeline.run(...)` call itself is wrapped: a terminal pipeline
 * exception (e.g. CircuitBreakerError from a replayed reviewer hard stop)
 * is caught and folded into the replayed run's terminal outcome (`{halted:
 * true}`) instead of propagating out of replayArchive and killing the
 * replay — that outcome is then compared against the archive's own RECORDED
 * terminal state via compareTerminalOutcome (see above). RecordingExhaustedError
 * — and any other replay-infrastructure error — is NOT a terminal pipeline
 * outcome to compare against; it means the replay itself is broken (e.g. an
 * archive whose recordings don't cover the run), so it is re-thrown
 * unchanged and propagates out of replayArchive so the run fails loudly.
 *
 * Once the run settles (cleanly or via a caught terminal exception), the
 * replayed outcomes are read back out of the run's own harness directory
 * (pipeline.harnessDir, which run() repoints to the per-run harness dir)
 * via readRecordedOutcomes, and diffed against the archive's own recorded
 * outcomes via compareReplay. The terminal-outcome comparison's result (zero
 * or one entry) is appended to that same divergence report before
 * classification, so a terminal mismatch is folded into the same
 * unexplained count and summary line as every other divergence.
 *
 * The temp project directory is always removed in a finally block, so a
 * throwing replay (including a re-thrown RecordingExhaustedError) still
 * cleans up before the rejection propagates.
 *
 * Once the combined divergence report is computed, it is run through
 * replay-lib.js's v0 divergence classifier (classifyDivergences /
 * summarizeClassification) so callers get both the raw report (for existing
 * consumers of `divergences`) and the classified breakdown in one place —
 * the only v0 known-excluded shape is the fs-invalidation leg's
 * status:'invalidated'→'complete' mismatch; every other divergence
 * (including a terminal-outcome mismatch) is 'unexplained'.
 *
 * @param {string} archiveDir
 * @returns {Promise<{ archiveId: string, divergences: Array,
 *   classified: Array, unexplainedCount: number, knownExcludedCount: number }>}
 */
export async function replayArchive(archiveDir) {
  const bundle = loadArchiveBundle(archiveDir);
  const { projectRoot, specPath, cleanup } = materializeReplayProject(bundle);

  try {
    const pipeline = new Pipeline(projectRoot, buildReplayDeps(bundle));

    let replayedTerminalOutcome;
    try {
      await pipeline.run(`Implement the spec at ${specPath}`, { prdPath: specPath });
      replayedTerminalOutcome = { halted: false };
    } catch (err) {
      // RecordingExhaustedError (and any other replay-infrastructure error)
      // means the replay itself is broken, not that the replayed pipeline
      // reached a genuine terminal halt — re-throw it unchanged rather than
      // folding it into the terminal comparison below.
      if (err instanceof RecordingExhaustedError) throw err;
      replayedTerminalOutcome = { halted: true };
    }

    const replayedOutcomes = readRecordedOutcomes(pipeline.harnessDir);
    // compareReplay resolves each report entry's `archive` field from the
    // bundle's archiveId; bundle.outcomes is a bare four-Map object that
    // carries none, so pass it explicitly or every divergence line reports
    // its origin as `[null]` — unusable when probing a whole corpus.
    const outcomeDivergences = compareReplay(
      replayedOutcomes,
      { ...bundle.outcomes, archiveId: bundle.archiveId }
    );

    const recordedTerminalState = readRecordedTerminalState(bundle.archiveDir);
    const terminalDivergences = compareTerminalOutcome(
      recordedTerminalState,
      replayedTerminalOutcome,
      bundle.archiveId
    );

    const divergences = [...outcomeDivergences, ...terminalDivergences];

    const classified = classifyDivergences(divergences);
    const { unexplained: unexplainedCount, knownExcludedFs: knownExcludedCount } =
      summarizeClassification(divergences);

    return { archiveId: bundle.archiveId, divergences, classified, unexplainedCount, knownExcludedCount };
  } finally {
    cleanup();
  }
}

/**
 * Formats a single divergence report entry (as produced by compareReplay)
 * into one human-readable line naming the archive, the session/task
 * identity (including the sequence index when the entry carries one), the
 * differing field, the expected vs actual values, and the entry's v0
 * classification tag (replay-lib.js's classifyDivergence): 'unexplained' for
 * everything outside the v0 known-excluded shape, or
 * 'known-excluded(fs-leg)' for the fs-invalidation leg's
 * status:'invalidated'→'complete' mismatch.
 *
 * @param {{archive:string|null, identity:string, sequence?:number,
 *   field:string, expected:*, actual:*}} entry - a compareReplay() report entry
 * @returns {string} a single-line, human-readable rendering of the divergence
 */
export function formatDivergence(entry) {
  const { archive, identity, sequence, field, expected, actual } = entry || {};
  const identityPart = sequence !== undefined ? `${identity} [sequence ${sequence}]` : identity;
  const tag = classifyDivergence(entry) === 'known-excluded-fs' ? 'known-excluded(fs-leg)' : 'unexplained';
  return `[${archive}] ${identityPart}: ${field} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)} [${tag}]`;
}

/**
 * Formats a compareReplay() report's classification breakdown into a single
 * summary line.
 *
 * @param {Array} report - a raw (unclassified) compareReplay() report
 * @returns {string} exactly `N divergence(s): X unexplained, Y known-excluded(fs-leg)`
 */
export function formatSummaryLine(report) {
  const { total, unexplained, knownExcludedFs } = summarizeClassification(report);
  return `${total} divergence(s): ${unexplained} unexplained, ${knownExcludedFs} known-excluded(fs-leg)`;
}

/**
 * Replays every entry in the golden corpus manifest (see loadGoldenManifest)
 * — the pinned baseline archives that must stay green under this engine —
 * printing one per-entry line naming the entry's directory alongside its
 * unexplained and known-excluded divergence counts, followed by a single
 * aggregate summary line across every entry.
 *
 * Each entry's `dir` is resolved repo-relative (relative to THIS script's
 * own repo root, i.e. `path.dirname(scripts/)` — not the caller's cwd), so
 * the manifest's committed dir strings (e.g.
 * `archives/230-brand-surface-rename-spec`) resolve the same way regardless
 * of where `node scripts/replay-archive.js --golden` is invoked from.
 *
 * A manifest entry whose resolved directory does not exist on this machine
 * is a hard, loud error naming the offending entry — a stale manifest is
 * never silently skipped; it fails the whole golden run.
 *
 * @param {string|null} manifestPath - explicit manifest path, or null to use
 *   the default (see loadGoldenManifest)
 * @returns {Promise<{ entryCount: number, unexplainedCount: number,
 *   knownExcludedCount: number }>} aggregate counts across every entry —
 *   `unexplainedCount === 0` is the green condition (a terminal MATCH, i.e.
 *   zero unexplained divergences for an entry, counts as green)
 */
export async function runGolden(manifestPath) {
  const manifest = loadGoldenManifest(manifestPath);
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];

  let totalUnexplained = 0;
  let totalKnownExcluded = 0;

  for (const entry of entries) {
    const entryDir = path.resolve(REPO_ROOT, entry.dir);
    if (!fs.existsSync(entryDir)) {
      throw new Error(`runGolden: golden manifest entry directory does not exist: ${entry.dir}`);
    }

    const { unexplainedCount, knownExcludedCount } = await replayArchive(entryDir);
    totalUnexplained += unexplainedCount;
    totalKnownExcluded += knownExcludedCount;

    console.log(`[${unexplainedCount === 0 ? 'MATCH' : 'DIVERGE'}] ${entry.dir}: ${unexplainedCount} unexplained, ${knownExcludedCount} known-excluded(fs-leg)`);
  }

  console.log(`Golden summary: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ${totalUnexplained} unexplained, ${totalKnownExcluded} known-excluded(fs-leg)`);

  return { entryCount: entries.length, unexplainedCount: totalUnexplained, knownExcludedCount: totalKnownExcluded };
}

export async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.mode === 'usage') {
    if (parsed.error) console.error(parsed.error);
    console.error(USAGE);
    process.exit(1);
    return;
  }

  if (parsed.mode === 'replay') {
    const { divergences, classified, unexplainedCount } = await replayArchive(parsed.archiveDir);
    for (const entry of classified) {
      console.log(formatDivergence(entry));
    }
    // Only print the summary line when there's something to summarize — a
    // clean, zero-divergence replay prints no line matching /divergence/i at
    // all, matching this driver's original no-noise-on-a-clean-run contract.
    if (divergences.length > 0) {
      console.log(formatSummaryLine(divergences));
    }
    process.exit(unexplainedCount === 0 ? 0 : 1);
    return;
  }

  if (parsed.mode === 'probe') {
    runProbe(parsed.corpusDir);
    process.exit(0);
    return;
  }

  if (parsed.mode === 'golden') {
    const { unexplainedCount } = await runGolden(parsed.manifestPath);
    process.exit(unexplainedCount === 0 ? 0 : 1);
    return;
  }
}

// Run if invoked as main (not when imported by tests):
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
