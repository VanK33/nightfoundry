/**
 * replay-lib.js — Read-only archive readers for replay/reconstruction tooling.
 *
 * Every function here only reads from disk (readFileSync/readdirSync/
 * existsSync/statSync) — nothing in this module ever mutates an archive.
 *
 * Public API:
 *   readSpecPair(archiveDir) → { md, json }
 *   reconstructPlansFromArchive(archiveDir) → Map<missionId, decomp>
 *   readRecordedOutcomes(archiveDir) → { taskStatuses, verdicts, review, regression }
 *   readRecordedTerminalState(archiveDir) → { halted, haltReason }
 *   parseRecordingIdentity(filename) → { timestamp, role, scopeId, key }
 *   loadSessionRecordings(archiveDir) → Map<key, recording[]>
 *   loadArchiveBundle(archiveDir) → { archiveId, archiveDir, spec, plans, recordings, outcomes }
 *   MissingExitStructuredOutputError — thrown by loadSessionRecordings
 *   createFakeSessionManager(bundle) → SessionManager-shaped { spawn, spawnReusable }
 *   RecordingExhaustedError — thrown by the fake SessionManager
 *   normalizeForComparison(value) → value with non-whitelisted fields stripped
 *   compareReplay(replayed, groundTruth) → divergence report (empty array = match)
 *   classifyDivergence(entry) → 'known-excluded-fs' | 'unexplained'
 *   classifyDivergences(report) → report entries with an added `classification` field
 *   summarizeClassification(report) → { total, unexplained, knownExcludedFs }
 *   isHardReplayError(err) → true for RecordingExhaustedError/MissingExitStructuredOutputError
 *   compareTerminalOutcome(recorded, replayed, archiveId) → divergence entry|null (coarse v0 terminal-outcome comparison)
 */
import fs from 'fs';
import path from 'path';

/**
 * Read the spec.md / spec.json pair from an archive directory.
 *
 * @param {string} archiveDir
 * @returns {{ md: string|null, json: object|null }}
 */
export function readSpecPair(archiveDir) {
  const mdPath = path.join(archiveDir, 'spec.md');
  const jsonPath = path.join(archiveDir, 'spec.json');

  const md = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : null;
  const json = fs.existsSync(jsonPath) ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null;

  return { md, json };
}

/**
 * Convert a parsed mission-state object into the planner-shaped decomposition
 * `{ subMissions: [...] }`. Behavioral parity with stateToDecomp in
 * src/orchestrator/core/state.js — same input, same output — sub-missions and
 * tasks are ordered by id, and array fields default to [] when absent.
 *
 * @param {object} missionState - parsed state/mission-<id>.json contents
 * @returns {{ subMissions: Array }}
 */
function missionStateToDecomp(missionState) {
  const subMissions = [];
  for (const [, sm] of Object.entries(missionState.subMissions || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const tasks = [];
    for (const [, task] of Object.entries(sm.tasks || {}).sort(([a], [b]) => a.localeCompare(b))) {
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
    subMissions.push({ id: sm.id, description: sm.description, tasks });
  }
  return { subMissions };
}

/**
 * Reconstruct planner-shaped decompositions for every mission recorded under
 * <archiveDir>/state/mission-*.json.
 *
 * @param {string} archiveDir
 * @returns {Map<string, { subMissions: Array }>} missionId → decomp
 */
export function reconstructPlansFromArchive(archiveDir) {
  const plans = new Map();
  const stateDir = path.join(archiveDir, 'state');
  if (!fs.existsSync(stateDir)) return plans;

  const missionFiles = fs.readdirSync(stateDir)
    .filter((f) => /^mission-.*\.json$/.test(f))
    .sort();

  for (const file of missionFiles) {
    const filePath = path.join(stateDir, file);
    const missionState = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const missionId = missionState.id || missionState.missionId || file.replace(/^mission-/, '').replace(/\.json$/, '');
    plans.set(missionId, missionStateToDecomp(missionState));
  }

  return plans;
}

/**
 * Read the recorded outcomes (task statuses, verifier/reviewer/regression
 * verdicts) persisted in an archive.
 *
 * @param {string} archiveDir
 * @returns {{
 *   taskStatuses: Map<string, string>,
 *   verdicts: Map<string, *>,
 *   review: Map<string, { result: *, findings: Array }>,
 *   regression: Map<string, *>,
 * }}
 */
export function readRecordedOutcomes(archiveDir) {
  const taskStatuses = new Map();
  const verdicts = new Map();
  const review = new Map();
  const regression = new Map();

  // ── taskStatuses: state/mission-*.json ─────────────────────────────────
  const stateDir = path.join(archiveDir, 'state');
  if (fs.existsSync(stateDir)) {
    const missionFiles = fs.readdirSync(stateDir)
      .filter((f) => /^mission-.*\.json$/.test(f))
      .sort();
    for (const file of missionFiles) {
      const missionState = JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8'));
      for (const [, sm] of Object.entries(missionState.subMissions || {})) {
        for (const [, task] of Object.entries(sm.tasks || {})) {
          taskStatuses.set(task.id, task.status);
        }
      }
    }
  }

  // ── verdicts / review / regression: verification/*.json ────────────────
  const verificationDir = path.join(archiveDir, 'verification');
  if (fs.existsSync(verificationDir)) {
    const entries = fs.readdirSync(verificationDir).sort();

    for (const file of entries) {
      const filePath = path.join(verificationDir, file);

      if (/^review-milestone-.*\.json$/.test(file)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const match = file.match(/^review-milestone-(.+)\.json$/);
        const milestoneId = match ? match[1] : file;
        review.set(milestoneId, {
          result: data.result,
          findings: data.findings || [],
        });
        continue;
      }

      if (/^task-regression-.*\.json$/.test(file)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const match = file.match(/^task-regression-(.+)\.json$/);
        const scopeId = match ? match[1] : file;
        regression.set(scopeId, data.result);
        continue;
      }

      if (/^task-.*\.json$/.test(file)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const basename = file.replace(/\.json$/, '');
        verdicts.set(basename, data.result);
      }
    }
  }

  return { taskStatuses, verdicts, review, regression };
}

/**
 * Read the RECORDED terminal state of an archive from
 * <archiveDir>/manifest.json. When the manifest exists, parses, and has a
 * `haltReason` key, the run is recorded halted and that value is returned.
 * When the manifest exists and parses but has no `haltReason` key, the run
 * is recorded clean. When manifest.json is absent, unreadable, or not valid
 * JSON, this also resolves to the clean shape — this function never throws.
 *
 * @param {string} archiveDir
 * @returns {{ halted: boolean, haltReason: string|null }}
 */
export function readRecordedTerminalState(archiveDir) {
  const manifestPath = path.join(archiveDir, 'manifest.json');
  try {
    if (!fs.existsSync(manifestPath)) {
      return { halted: false, haltReason: null };
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest && Object.prototype.hasOwnProperty.call(manifest, 'haltReason')) {
      return { halted: true, haltReason: manifest.haltReason };
    }
    return { halted: false, haltReason: null };
  } catch {
    return { halted: false, haltReason: null };
  }
}

/**
 * Error thrown by loadSessionRecordings when a discovered recording has no
 * exit-event structured_output — a session recording is only replayable if
 * the harness captured what it ultimately returned, so this is a loud,
 * named failure rather than a silent skip or a hang.
 */
export class MissingExitStructuredOutputError extends Error {
  /**
   * @param {string} recordingFile - path of the offending recording file
   */
  constructor(recordingFile) {
    super(`Recording has no exit-event structured_output: ${recordingFile}`);
    this.name = 'MissingExitStructuredOutputError';
    this.recordingFile = recordingFile;
  }
}

// Matches logger.js's `${timestamp}-${name}.jsonl` filenames, e.g.
// "2026-04-26T12-22-44-280Z-executor-001-001-001-001.jsonl" or
// "2026-04-26T13-06-10-532Z-summarizer.jsonl". Group 1 is the ISO-ish
// timestamp (colons/dots already replaced with dashes), group 2 is the
// role (up to the next dash), group 3 — optional — is everything after,
// the task/scope id.
const RECORDING_FILENAME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-([^-]+)(?:-(.+))?\.jsonl$/;

/**
 * Parse a session-recording log basename into its identity.
 *
 * @param {string} filename - basename (or path) of a `logs/*.jsonl` file
 * @returns {{ timestamp: string, role: string, scopeId: string|null, key: string }}
 */
export function parseRecordingIdentity(filename) {
  const base = path.basename(filename);
  const match = base.match(RECORDING_FILENAME_RE);
  if (!match) {
    throw new Error(`Cannot parse recording identity from filename: ${filename}`);
  }
  const [, timestamp, role, scopeId = null] = match;
  const key = scopeId === null || scopeId === undefined ? role : `${role}:${scopeId}`;
  return { timestamp, role, scopeId: scopeId ?? null, key };
}

/**
 * Discover and parse every session recording under <archiveDir>/logs/*.jsonl
 * (the glob naturally skips logs/session-summary.json and
 * logs/token-usage.json, which are not .jsonl files).
 *
 * Each recording's events are parsed from JSONL, and its exit-event
 * structured_output is required — a recording missing it raises
 * MissingExitStructuredOutputError naming the offending file rather than
 * being silently skipped.
 *
 * @param {string} archiveDir
 * @returns {Map<string, Array<{
 *   timestamp: string, role: string, scopeId: string|null, key: string,
 *   file: string, events: Array, exit: object,
 * }>>} identity key → recordings, sorted ascending by filename timestamp
 */
export function loadSessionRecordings(archiveDir) {
  const recordings = new Map();
  const logsDir = path.join(archiveDir, 'logs');
  if (!fs.existsSync(logsDir)) return recordings;

  const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.jsonl'));

  const parsed = [];
  for (const file of files) {
    const filePath = path.join(logsDir, file);
    const identity = parseRecordingIdentity(file);

    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    const events = lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    let exitEvent = null;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'exit') { exitEvent = events[i]; break; }
    }
    const structuredOutput = exitEvent?.data?.result?.structured_output;
    if (!exitEvent || structuredOutput === undefined || structuredOutput === null) {
      throw new MissingExitStructuredOutputError(filePath);
    }

    parsed.push({
      ...identity,
      file: filePath,
      events,
      exit: exitEvent.data,
    });
  }

  // Sort ascending by filename timestamp (fixed-width ISO-ish strings sort
  // lexicographically the same as chronologically) so a retry arc replays
  // in recording order, independent of readdirSync's directory read order.
  parsed.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  for (const rec of parsed) {
    if (!recordings.has(rec.key)) recordings.set(rec.key, []);
    recordings.get(rec.key).push(rec);
  }

  return recordings;
}

/**
 * Compose the full read-only replay bundle for an archive: spec pair,
 * planner-shaped plan reconstruction, session recordings grouped by
 * identity key, and recorded ground-truth outcomes.
 *
 * @param {string} archiveDir
 * @returns {{
 *   archiveId: string, archiveDir: string,
 *   spec: { md: string|null, json: object|null },
 *   plans: Map<string, { subMissions: Array }>,
 *   recordings: Map<string, Array>,
 *   outcomes: { taskStatuses: Map, verdicts: Map, review: Map, regression: Map },
 * }}
 */
export function loadArchiveBundle(archiveDir) {
  const spec = readSpecPair(archiveDir);
  const plans = reconstructPlansFromArchive(archiveDir);
  const recordings = loadSessionRecordings(archiveDir);
  const outcomes = readRecordedOutcomes(archiveDir);

  return {
    archiveId: path.basename(archiveDir),
    archiveDir,
    spec,
    plans,
    recordings,
    outcomes,
  };
}

/**
 * Error thrown by the fake SessionManager (see createFakeSessionManager)
 * when an identity key has no unconsumed recording left — either because
 * every recording for that key has already been popped, or because the
 * key never appeared in bundle.recordings at all. Loud and named rather
 * than a silent hang or an undefined result, mirroring
 * MissingExitStructuredOutputError's failure philosophy.
 */
export class RecordingExhaustedError extends Error {
  /**
   * @param {string} identityKey - the (role) or (role:scopeId) key that ran out
   */
  constructor(identityKey) {
    super(`No unconsumed recording left for identity key '${identityKey}'`);
    this.name = 'RecordingExhaustedError';
    this.identityKey = identityKey;
  }
}

// A syntactically valid-but-arbitrary timestamp prefix, used only so
// deriveIdentityKey can hand a synthetic filename to parseRecordingIdentity
// and reuse its exact role/scopeId split — the derivation MUST stay
// byte-for-byte identical to how real recording filenames are parsed, or a
// spawn's identity key could silently diverge from its recording's key.
const SYNTHETIC_TIMESTAMP = '2000-01-01T00-00-00-000Z';

/**
 * Derive the (role, task/scope id) identity key for a spawn/spawnReusable
 * options object — the same key shape loadSessionRecordings groups
 * recordings by. Real callers always set options.name to the exact string
 * passed to logger.createSessionLog (e.g. 'executor-001-001-001-001',
 * 'planner-remediate-001-001', 'summarizer'), which is in turn the exact
 * basename logger.js writes recording files under — so parsing options.name
 * with parseRecordingIdentity's own regex (via a synthetic filename)
 * guarantees the derived key matches the recording's key whenever they
 * refer to the same real session.
 *
 * @param {{ name?: string, agent?: string }} options
 * @returns {string} identity key — role, or role:scopeId
 */
function deriveIdentityKey(options = {}) {
  const name = options.name || options.agent || 'unnamed';
  return parseRecordingIdentity(`${SYNTHETIC_TIMESTAMP}-${name}.jsonl`).key;
}

/**
 * Build a fake SessionManager that replays a loaded archive bundle instead
 * of spawning real Claude sessions. Shaped like the real SessionManager
 * (src/orchestrator/infra/session-manager.js) closely enough to stand in
 * for it in replay/reconstruction tooling:
 *
 *   spawn(options)         → Promise<{ handle, result }>
 *   spawnReusable(options) → { sendPrompt(promptText), close(), turnCount }
 *
 * Replay sourcing:
 *   - spawn() derives the (role, task/scope id) identity key from options
 *     and pops the NEXT unconsumed recording for THAT key from
 *     bundle.recordings, resolving with the recording's full recorded
 *     result envelope (rec.exit.result — the actual SDK result object,
 *     complete with usage/cost/structured_output) rather than a
 *     reconstructed subset. Cursors are tracked one per identity key (not
 *     one global queue), so interleaved spawns across concurrent
 *     identities each advance only their own key's cursor — one key's
 *     consumption never misroutes or skips another key's recordings. A
 *     key with no recordings left (exhausted, or never present in the
 *     bundle) throws RecordingExhaustedError naming that key.
 *   - spawnReusable() is, in this codebase, exclusively how the reusable
 *     planner session is spawned (src/orchestrator/agents/planner.js).
 *     Its recording only ever captures ONE exit event holding the LAST
 *     turn's structured_output — replaying that same last-turn plan for
 *     every earlier sendPrompt() call would silently corrupt every
 *     mission but the final one. So spawnReusable's sendPrompt() is
 *     served instead from bundle.plans — the archived planner-shaped
 *     ground-truth decomposition for each mission, reconstructed by
 *     reconstructPlansFromArchive — popped in the Map's (missionId-sorted)
 *     order, one mission per turn, shared across every spawnReusable()
 *     call this fake session manager produces (so a rotated reusable
 *     session picks up exactly where the previous one left off). Turns
 *     beyond the archived mission count throw RecordingExhaustedError.
 *
 * @param {{ recordings: Map<string, Array>, plans: Map<string, object> }} bundle
 *   - a loadArchiveBundle() result (or any object shaped like one)
 * @returns {{ spawn: Function, spawnReusable: Function }}
 */
// Identity keys of the per-mission reusable planner session, whose rotated
// generations ('planner-reusable', 'planner-reusable-2', ... — see
// planner.js's _ensureReusableSession) must SHARE one plan cursor so a
// rotation resumes where the retired session stopped. Every other reusable
// identity — notably 'planner:global', which needs a milestone-shaped plan
// that bundle.plans never holds — gets its own cursor, so it can never
// silently consume a mission decomp meant for the per-mission session.
const PER_MISSION_PLANNER_CURSOR = 'planner:reusable';
// 'planner' (unsuffixed) plus every rotated generation of the per-mission
// session. Deliberately does NOT match 'planner:global'.
const PER_MISSION_PLANNER_KEY_RE = /^planner(:reusable(-\d+)?)?$/;

/**
 * Map a spawnReusable identity key onto the plan cursor it draws from.
 * @param {string} key
 * @returns {string} cursor group key
 */
function planCursorGroup(key) {
  return PER_MISSION_PLANNER_KEY_RE.test(key) ? PER_MISSION_PLANNER_CURSOR : key;
}

export function createFakeSessionManager(bundle) {
  const recordingCursors = new Map(); // identity key → next unconsumed index
  const planEntries = Array.from(bundle?.plans instanceof Map ? bundle.plans.entries() : []);
  const planCursors = new Map(); // plan cursor group → next unconsumed index

  function nextRecording(key) {
    const list = bundle?.recordings instanceof Map ? bundle.recordings.get(key) : undefined;
    const idx = recordingCursors.get(key) || 0;
    if (!list || idx >= list.length) {
      throw new RecordingExhaustedError(key);
    }
    recordingCursors.set(key, idx + 1);
    return list[idx];
  }

  function nextPlan(key) {
    const group = planCursorGroup(key);
    // Only the per-mission planner session draws from bundle.plans; any
    // other reusable identity is exhausted on its first turn rather than
    // consuming a decomp that does not belong to it.
    if (group !== PER_MISSION_PLANNER_CURSOR) {
      throw new RecordingExhaustedError(key);
    }
    const idx = planCursors.get(group) || 0;
    if (idx >= planEntries.length) {
      throw new RecordingExhaustedError(key);
    }
    planCursors.set(group, idx + 1);
    const [, decomp] = planEntries[idx];
    return decomp;
  }

  return {
    /**
     * @param {object} options - spawn options (name, agent, ...)
     * @returns {Promise<{ handle: object, result: object }>}
     */
    async spawn(options = {}) {
      const key = deriveIdentityKey(options);
      const rec = nextRecording(key);
      const handle = {
        name: options.name || options.agent || 'unnamed',
        agent: options.agent || null,
        finished: true,
        result: rec.exit.result,
      };
      return { handle, result: rec.exit.result };
    },

    /**
     * @param {object} options - spawnReusable options (name, agent, ...)
     * @returns {{ handle: object, sendPrompt: Function, close: Function, turnCount: number }}
     */
    spawnReusable(options = {}) {
      const key = deriveIdentityKey(options);
      let turnCount = 0;
      const handle = {
        name: options.name || options.agent || 'unnamed',
        agent: options.agent || null,
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
          const decomp = nextPlan(key);
          return { structured_output: decomp, usage: {}, total_cost_usd: 0 };
        },
        async close() {
          // No underlying process to tear down — no-op, but kept async to
          // match ReusableSession.close()'s Promise-returning signature.
        },
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Replay comparator (v0)
//
// Compares a replayed run's outcomes against an archive's recorded
// ground-truth outcomes, restricted to a small "v0 whitelist" of fields
// that actually matter for determinism: task final status, per-session
// verdict results (paired by sequence within each session identity), and
// review/regression conclusions. Everything else — timestamps, session
// ids, cost/usage, and fs-derived bookkeeping (absolute paths,
// verifyFile/progressFile/verificationFile pointers, durations) — is noise
// for this purpose (non-deterministic or archive-location-dependent) and
// must never produce a report entry.
// ─────────────────────────────────────────────────────────────────────────

// Named timestamp fields (regardless of value) that are always stripped.
const EXCLUDED_TIMESTAMP_KEYS = new Set([
  'createdAt', 'startedAt', 'completedAt', 'ts', 'recordedAt', 'finishedAt',
]);

// Session-id, cost/usage, and fs-derived-bookkeeping fields that are always
// stripped, regardless of value.
const EXCLUDED_NOISE_KEYS = new Set([
  // session ids
  'sessionId', 'session_id',
  // cost / usage
  'cost', 'totalCost', 'total_cost_usd', 'totalCostUsd', 'costUsd', 'usage',
  // fs-derived pointers
  'verifyFile', 'progressFile', 'verificationFile',
  // durations
  'duration', 'durations', 'durationMs', 'elapsedMs',
]);

const EXCLUDED_KEYS = new Set([...EXCLUDED_TIMESTAMP_KEYS, ...EXCLUDED_NOISE_KEYS]);

// Matches JS Date#toISOString() output (and equivalent ISO-8601 timestamps
// with an explicit offset), e.g. "2026-04-26T12:22:44.280Z".
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * @param {*} v
 * @returns {boolean} true when v is a string that looks like an ISO-8601 timestamp
 */
function looksLikeIsoTimestamp(v) {
  return typeof v === 'string' && ISO_8601_RE.test(v);
}

/**
 * @param {*} v
 * @returns {boolean} true when v is a string that looks like an absolute
 *   filesystem path (POSIX `/...` or Windows `C:\...` / `C:/...`)
 */
function looksLikeAbsolutePath(v) {
  return typeof v === 'string' && (/^\//.test(v) || /^[A-Za-z]:[\\/]/.test(v));
}

/**
 * Recursively strip fields excluded from the v0 comparison whitelist from
 * an arbitrary value, returning a normalized structure safe to diff:
 *   - named timestamp keys (createdAt/startedAt/completedAt/ts/recordedAt/
 *     finishedAt) and any field whose VALUE looks like an ISO-8601 timestamp
 *     (regardless of key name)
 *   - session ids (sessionId/session_id)
 *   - cost/usage fields (cost/totalCost/total_cost_usd/totalCostUsd/costUsd/usage)
 *   - fs-derived fields: verifyFile/progressFile/verificationFile pointers,
 *     durations (duration/durations/durationMs/elapsedMs), and any field
 *     whose VALUE looks like an absolute filesystem path
 *
 * `Map` instances are converted to plain objects (key → normalized value) so
 * downstream comparison code can treat Maps and plain objects uniformly.
 * Arrays and plain objects are walked recursively; every other value
 * (string/number/boolean/null/undefined) is returned as-is once it has
 * passed the exclusion checks above.
 *
 * @param {*} value
 * @returns {*} normalized value with excluded fields stripped
 */
export function normalizeForComparison(value) {
  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value.entries()) {
      out[String(k)] = normalizeForComparison(v);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeForComparison(v));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (EXCLUDED_KEYS.has(k)) continue;
      if (looksLikeIsoTimestamp(v)) continue;
      if (looksLikeAbsolutePath(v)) continue;
      out[k] = normalizeForComparison(v);
    }
    return out;
  }
  return value;
}

/**
 * Read a nested path out of an object, returning undefined on any missing
 * intermediate step instead of throwing.
 * @param {*} obj
 * @param {string[]} pathParts
 * @returns {*}
 */
function pick(obj, pathParts) {
  let cur = obj;
  for (const part of pathParts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Extract a `status` value from either a bare string or an object carrying
 * a `.status` field (e.g. a raw mission-state task record).
 * @param {*} x
 * @returns {*}
 */
function extractStatus(x) {
  if (x === null || x === undefined) return undefined;
  if (typeof x === 'string') return x;
  if (typeof x === 'object' && Object.prototype.hasOwnProperty.call(x, 'status')) return x.status;
  return undefined;
}

/**
 * Extract a verdict/review/regression `result` conclusion from any of the
 * shapes this data plausibly arrives in: a bare string, a sidecar-shaped
 * object ({ result, hardChecks, ... }), an SDK structured_output envelope
 * ({ structured_output: { result, ... } }), or a full session-recording
 * entry ({ exit: { result: { structured_output: { result, ... } } } }).
 * @param {*} x
 * @returns {*}
 */
function extractResult(x) {
  if (x === null || x === undefined) return undefined;
  if (typeof x === 'string') return x;
  if (typeof x !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(x, 'result')) return x.result;
  const so = x.structured_output;
  if (so && typeof so === 'object' && Object.prototype.hasOwnProperty.call(so, 'result')) return so.result;
  const nestedSo = x.exit?.result?.structured_output;
  if (nestedSo && typeof nestedSo === 'object' && Object.prototype.hasOwnProperty.call(nestedSo, 'result')) {
    return nestedSo.result;
  }
  return undefined;
}

/**
 * Diff two identity → value maps on a single scalar field extracted via
 * `extractFn`, appending one report entry per differing identity.
 * @param {Array} report
 * @param {string|null} archive
 * @param {object} replayedMap
 * @param {object} groundTruthMap
 * @param {function} extractFn
 * @param {string} field
 */
function compareByIdentity(report, archive, replayedMap, groundTruthMap, extractFn, field) {
  const ids = new Set([...Object.keys(replayedMap || {}), ...Object.keys(groundTruthMap || {})]);
  for (const id of [...ids].sort()) {
    const expected = extractFn(groundTruthMap[id]);
    const actual = extractFn(replayedMap[id]);
    if (expected !== actual) {
      report.push({ archive, identity: id, field, expected, actual });
    }
  }
}

/**
 * Turn a value into a { key → array } sequence map: arrays pass through
 * as-is; any other non-array value is treated as a single-element sequence
 * so identity/sequence comparison logic stays uniform whether or not
 * per-attempt history is available.
 * @param {object} obj
 * @returns {object}
 */
function toSequenceMap(obj) {
  const out = {};
  for (const [key, val] of Object.entries(obj || {})) {
    out[key] = Array.isArray(val) ? val : [val];
  }
  return out;
}

/**
 * Derive, for a normalized replay bundle, a { identityKey → verdict[] }
 * sequence map — one entry per session recording for that identity, in
 * recorded order — so verdicts can be paired by sequence within an
 * identity rather than collapsed to a single "latest" value.
 *
 * Resolution order (first that yields data wins):
 *   1. an explicit `sessionVerdicts` map (outcomes.sessionVerdicts or
 *      top-level sessionVerdicts) — trusted as already-curated per-session
 *      verdict sequences
 *   2. `recordings` (outcomes.recordings or top-level recordings, the
 *      loadSessionRecordings()-shaped identity → recording[] map),
 *      filtered to identities whose role is 'verifier' (the only sessions
 *      that carry a PASSED/FAILED verdict in their structured_output)
 *   3. a flat `verdicts` map (outcomes.verdicts) — one recorded verdict per
 *      identity, treated as a single-element sequence
 *
 * @param {object} normBundle - a normalizeForComparison()'d bundle
 * @returns {object} identityKey → verdict[]
 */
function extractVerdictSequences(normBundle) {
  const explicit = pick(normBundle, ['outcomes', 'sessionVerdicts']) || normBundle?.sessionVerdicts;
  if (explicit && typeof explicit === 'object') {
    return toSequenceMap(explicit);
  }

  const recordings = pick(normBundle, ['outcomes', 'recordings']) || normBundle?.recordings;
  if (recordings && typeof recordings === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(recordings)) {
      if (!Array.isArray(val)) continue;
      const role = key.includes(':') ? key.split(':')[0] : key;
      const isVerifierIdentity = role === 'verifier'
        || val.some((r) => r && typeof r === 'object' && r.role === 'verifier');
      if (isVerifierIdentity) out[key] = val;
    }
    if (Object.keys(out).length > 0) return out;
  }

  const flatVerdicts = pick(normBundle, ['outcomes', 'verdicts']) || normBundle?.verdicts;
  if (flatVerdicts && typeof flatVerdicts === 'object') {
    return toSequenceMap(flatVerdicts);
  }

  return {};
}

/**
 * Diff two identity → sequence[] maps, pairing entries by index (sequence
 * position) within each identity and appending one report entry per
 * differing position.
 * @param {Array} report
 * @param {string|null} archive
 * @param {object} replayedSeqs
 * @param {object} groundTruthSeqs
 * @param {function} extractFn
 * @param {string} field
 */
function compareSequencesByIdentity(report, archive, replayedSeqs, groundTruthSeqs, extractFn, field) {
  const ids = new Set([...Object.keys(replayedSeqs || {}), ...Object.keys(groundTruthSeqs || {})]);
  for (const id of [...ids].sort()) {
    const rSeq = replayedSeqs[id] || [];
    const gSeq = groundTruthSeqs[id] || [];
    const maxLen = Math.max(rSeq.length, gSeq.length);
    for (let i = 0; i < maxLen; i++) {
      const expected = extractFn(gSeq[i]);
      const actual = extractFn(rSeq[i]);
      if (expected !== actual) {
        report.push({ archive, identity: id, sequence: i, field, expected, actual });
      }
    }
  }
}

/**
 * Compare a replayed run's outcomes against an archive's recorded
 * ground-truth outcomes, restricted to the v0 whitelist:
 *   - task final statuses (outcomes.taskStatuses, or a top-level
 *     taskStatuses map) — diffed on the 'status' field
 *   - per-session verdict results, paired by sequence within each session
 *     identity (see extractVerdictSequences) — diffed on the 'result' field
 *   - review conclusions (outcomes.review, or top-level review) — diffed
 *     on the 'result' field
 *   - regression conclusions (outcomes.regression, or top-level
 *     regression) — diffed on the 'result' field
 *
 * Both `replayed` and `groundTruth` are normalized via
 * normalizeForComparison() before any comparison happens, so fields outside
 * the whitelist (timestamps, session ids, cost, fs-derived bookkeeping)
 * never produce a report entry — even if they differ between the two sides.
 *
 * @param {object} replayed - the replayed run's bundle (accepts either a
 *   loadArchiveBundle()-shaped object with an `outcomes` sub-object, or an
 *   equivalent flat object with taskStatuses/verdicts/sessionVerdicts/
 *   recordings/review/regression at the top level)
 * @param {object} groundTruth - the archive's recorded ground-truth bundle,
 *   same shape as `replayed`
 * @returns {Array<{ archive: string|null, identity: string, sequence?: number,
 *   field: string, expected: *, actual: * }>} empty when everything on the
 *   whitelist matches; one entry per differing item otherwise
 */
export function compareReplay(replayed, groundTruth) {
  const report = [];

  const normReplayed = normalizeForComparison(replayed) || {};
  const normGroundTruth = normalizeForComparison(groundTruth) || {};

  const archive = normGroundTruth.archiveId ?? normReplayed.archiveId ?? null;

  // 1. Task final statuses
  const replayedStatuses = pick(normReplayed, ['outcomes', 'taskStatuses']) || normReplayed.taskStatuses || {};
  const groundTruthStatuses = pick(normGroundTruth, ['outcomes', 'taskStatuses']) || normGroundTruth.taskStatuses || {};
  compareByIdentity(report, archive, replayedStatuses, groundTruthStatuses, extractStatus, 'status');

  // 2. Per-session verdict results, paired by sequence within each identity
  const replayedVerdicts = extractVerdictSequences(normReplayed);
  const groundTruthVerdicts = extractVerdictSequences(normGroundTruth);
  compareSequencesByIdentity(report, archive, replayedVerdicts, groundTruthVerdicts, extractResult, 'result');

  // 3. Review conclusions
  const replayedReview = pick(normReplayed, ['outcomes', 'review']) || normReplayed.review || {};
  const groundTruthReview = pick(normGroundTruth, ['outcomes', 'review']) || normGroundTruth.review || {};
  compareByIdentity(report, archive, replayedReview, groundTruthReview, extractResult, 'result');

  // 4. Regression conclusions
  const replayedRegression = pick(normReplayed, ['outcomes', 'regression']) || normReplayed.regression || {};
  const groundTruthRegression = pick(normGroundTruth, ['outcomes', 'regression']) || normGroundTruth.regression || {};
  compareByIdentity(report, archive, replayedRegression, groundTruthRegression, extractResult, 'result');

  return report;
}

// ─────────────────────────────────────────────────────────────────────────
// Divergence classifier (v0)
//
// Classifies each compareReplay() report entry as either a known, benign
// exclusion or an unexplained divergence. The only known exclusion in v0 is
// the "fs leg" shape: a task's recorded ground-truth status of 'invalidated'
// (set by the fs-invalidation leg re-running a task after replay) versus a
// replayed status of 'complete'. No other shape is excluded, and there is no
// configuration/options surface — this is a fixed, single rule.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Classify a single compareReplay() report entry as either the one known,
 * benign exclusion (the fs-invalidation leg's expected↔actual status shape)
 * or unexplained.
 *
 * @param {{ field?: string, expected?: *, actual?: * }} entry
 * @returns {'known-excluded-fs'|'unexplained'}
 */
export function classifyDivergence(entry) {
  if (
    entry
    && entry.field === 'status'
    && entry.expected === 'invalidated'
    && entry.actual === 'complete'
  ) {
    return 'known-excluded-fs';
  }
  return 'unexplained';
}

/**
 * Classify every entry in a compareReplay() report, returning a NEW array
 * of NEW entry objects — each carrying all of the input entry's own fields
 * plus an additive `classification` field. Neither the input array nor any
 * input entry is mutated.
 *
 * @param {Array} report
 * @returns {Array<{ classification: 'known-excluded-fs'|'unexplained' }>}
 */
export function classifyDivergences(report) {
  if (!report) return [];
  return report.map((entry) => ({ ...entry, classification: classifyDivergence(entry) }));
}

/**
 * Summarize a compareReplay() report's classification breakdown.
 *
 * @param {Array} report
 * @returns {{ total: number, unexplained: number, knownExcludedFs: number }}
 */
export function summarizeClassification(report) {
  const entries = report || [];
  const total = entries.length;
  let knownExcludedFs = 0;
  for (const entry of entries) {
    if (classifyDivergence(entry) === 'known-excluded-fs') knownExcludedFs += 1;
  }
  return { total, unexplained: total - knownExcludedFs, knownExcludedFs };
}

// ─────────────────────────────────────────────────────────────────────────
// Terminal-outcome comparator (v0, coarse)
//
// A separate, deliberately coarse comparison of a run's terminal outcome —
// did the run halt, or complete cleanly — against an archive's recorded
// terminal state (see readRecordedTerminalState). This is halted↔halted /
// clean↔clean only: there is no error-class taxonomy and no
// haltReason→exception mapping table in v0.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Determine whether an error is a replay-INFRASTRUCTURE failure (as opposed
 * to a genuine terminal-outcome divergence): a RecordingExhaustedError or a
 * MissingExitStructuredOutputError. These are HARD errors — they indicate
 * the replay tooling itself couldn't reconstruct a session, not that the
 * replayed run's outcome actually diverged from the recorded one — so they
 * are never converted into a comparison result.
 *
 * @param {*} err
 * @returns {boolean} true for RecordingExhaustedError/MissingExitStructuredOutputError, false otherwise (including null/undefined)
 */
export function isHardReplayError(err) {
  return err instanceof RecordingExhaustedError || err instanceof MissingExitStructuredOutputError;
}

/**
 * Compare a run's terminal outcome against an archive's recorded terminal
 * state, coarsely: only whether each side halted or completed cleanly.
 *
 * If `replayed.error` is a hard replay-infrastructure error (see
 * isHardReplayError), it is re-thrown unchanged — it is never converted into
 * a comparison result. Otherwise, when `recorded.halted` and
 * `replayed.halted` agree (both true or both false), returns null (terminal
 * MATCH). When they disagree, returns a single divergence entry shaped like
 * a compareReplay() report entry, with `identity` and `field` both fixed to
 * 'terminal' and `expected`/`actual` set to 'halted' or 'clean'.
 *
 * This comparison is coarse by design: halted↔halted / clean↔clean only —
 * no error-class taxonomy, no haltReason→exception mapping table.
 *
 * @param {{ halted: boolean, haltReason?: string|null }} recorded - a
 *   readRecordedTerminalState()-shaped recorded terminal state
 * @param {{ halted: boolean, error?: * }} replayed - the replayed run's
 *   terminal outcome; `error` is the thrown terminal error, or null/absent
 *   for a clean completion
 * @param {string} [archiveId] - archive identifier to stamp onto the
 *   divergence entry's `archive` field (defaults to null when omitted)
 * @returns {{ archive: string|null, identity: 'terminal', field: 'terminal',
 *   expected: 'halted'|'clean', actual: 'halted'|'clean',
 *   classification: 'unexplained' }|null} null on terminal MATCH, one
 *   divergence entry otherwise
 * @throws {*} the replayed terminal error, unchanged, when it is a hard
 *   replay-infrastructure error (see isHardReplayError)
 */
export function compareTerminalOutcome(recorded, replayed, archiveId) {
  if (isHardReplayError(replayed?.error)) {
    throw replayed.error;
  }

  if (Boolean(recorded?.halted) === Boolean(replayed?.halted)) {
    return null;
  }

  return {
    archive: archiveId ?? null,
    identity: 'terminal',
    field: 'terminal',
    expected: recorded?.halted ? 'halted' : 'clean',
    actual: replayed?.halted ? 'halted' : 'clean',
    classification: 'unexplained',
  };
}
