/**
 * state.js — Harness state read/write helpers.
 *
 * Handles state.json, mission state files, verify.json, and plan files.
 * Pure JS — no AI.
 *
 * Public API:
 *   writeJsonAtomic(filePath, data)
 *   readState(harnessDir) → parsed state.json object
 *   writeGateFlags(harnessDir, { allowIncompleteScope?, skipCoverageGate? })
 *   readGateFlags(harnessDir) → { allowIncompleteScope, skipCoverageGate }
 *   isUnresumableState(state) → boolean
 *   isMissionAlreadyStarted(missionState) → boolean
 *   readTaskStatus(harnessDir, taskId)
 *   stateToDecomp(missionState) → { subMissions: [...] }
 *   writeGlobalPlan(harnessDir, plan)
 *   writeMissionState(harnessDir, missionId, description, decomp)
 *   isTestTask(task) → boolean
 *   resolveHarnessFileRef(harnessDir, ref) → string
 *   writeVerifyJson(harnessDir, task)
 *   VALID_QUEUE_STATUSES
 *   writeQueueEntry(projectRoot, slug, { spec, plan, validatedAt, status, assumptionResults?, specJson? })
 *   readQueueEntry(projectRoot, slug) → { slug, spec, plan, validatedAt, status, assumptionResults, specJson } | null
 *   updateQueueEntryStatus(projectRoot, slug, status)
 *   writeParkScene(projectRoot, slug, scene)
 *   writeAutoWaiveScene(projectRoot, slug, scene) → path written
 *   readParkScene(projectRoot, slug) → scene | null
 *   listQueue(projectRoot) → Array<{ slug, spec, plan, validatedAt, status, assumptionResults, specJson }>
 *   removeQueueEntry(projectRoot, slug)
 *   assertNoStubVerifierSidecar(harnessDir, taskId)
 *   buildFileToMissionMap(harnessDir, changedFiles?) → Map<filePath, missionId>
 */
import fs from 'fs';
import path from 'path';

/**
 * Atomically write JSON to filePath using a pid-qualified temp file,
 * fdatasync for durability, and a rename for atomicity.
 *
 * Pattern: write → fdatasync → rename
 * The pid-qualified tmp name avoids collisions between concurrent processes.
 *
 * @param {string} filePath - destination file path
 * @param {*} data - value to serialize as pretty-printed JSON
 */
export function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    try {
      fs.fdatasyncSync(fd);
    } catch {
      // fdatasync not available on all platforms; fall back to fsync
      fs.fsyncSync(fd);
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

/**
 * Read and JSON-parse state.json under harnessDir.
 *
 * @param {string} harnessDir - path to the .harness directory
 * @returns {object} the parsed state object
 * @throws {Error} ENOENT if state.json does not exist under harnessDir
 */
export function readState(harnessDir) {
  return JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
}

/**
 * w4-state-resume-persistence Fix #2: persist the two gate dispositions a run
 * legitimately granted (`allowIncompleteScope`, `skipCoverageGate`) into
 * state.json projectMeta.gateFlags so resume()/batchResume can honor them as
 * defaults. Only writes the keys explicitly passed (merge semantics) and only
 * for boolean-true values it must remember — a false/undefined value is left
 * untouched so a later true is not clobbered.
 *
 * Goes through the existing crash-safe writeJsonAtomic pattern; never an
 * ad-hoc JSON edit. No-op (silent) when state.json is absent — the disposition
 * is reconstructed from the live flag on the next run anyway.
 *
 * @param {string} harnessDir
 * @param {{ allowIncompleteScope?: boolean, skipCoverageGate?: boolean }} flags
 */
export function writeGateFlags(harnessDir, flags = {}) {
  const stateJsonPath = path.join(harnessDir, 'state.json');
  if (!fs.existsSync(stateJsonPath)) return;
  const state = readState(harnessDir);
  if (!state.projectMeta) state.projectMeta = {};
  if (!state.projectMeta.gateFlags) state.projectMeta.gateFlags = {};
  if (flags.allowIncompleteScope === true) {
    state.projectMeta.gateFlags.allowIncompleteScope = true;
  }
  if (flags.skipCoverageGate === true) {
    state.projectMeta.gateFlags.skipCoverageGate = true;
  }
  writeJsonAtomic(stateJsonPath, state);
}

/**
 * Read the persisted gate dispositions back as defaults. Returns an object
 * with boolean fields (absent flags default to false). Callers MUST guard the
 * call with an fs.existsSync(state.json) check where state.json may not exist
 * yet (e.g. batchResume before per-entry bootstrap) and treat absence as the
 * all-false default — this helper does an unguarded readState that throws
 * ENOENT on a missing file.
 *
 * @param {string} harnessDir
 * @returns {{ allowIncompleteScope: boolean, skipCoverageGate: boolean }}
 */
export function readGateFlags(harnessDir) {
  const state = readState(harnessDir);
  const gf = state.projectMeta?.gateFlags || {};
  return {
    allowIncompleteScope: gf.allowIncompleteScope === true,
    skipCoverageGate: gf.skipCoverageGate === true,
  };
}

/**
 * Detects runs that crashed during planning before any milestones were created —
 * these cannot be resumed because there is no decomposition to continue from.
 *
 * @param {object} state - parsed state.json
 * @returns {boolean} true iff a run crashed during planning before milestones existed
 */
export function isUnresumableState(state) {
  return (
    state?.globalStatus === 'active' &&
    state?.projectMeta?.currentPhase === 'planning' &&
    state?.milestones !== undefined &&
    Object.keys(state.milestones).length === 0
  );
}

/**
 * True iff a mission state file contains at least one task with
 * status !== 'pending' — i.e. the user previously confirmed this
 * mission and execution has already started. Callers use this to
 * skip the "Proceed with mission X?" prompt on resume, so a
 * mid-run crash recovery doesn't force the user to re-approve
 * every mission that was already in flight.
 *
 * @param {object} missionState - parsed mission state file
 * @returns {boolean} true iff any task status !== 'pending'
 */
export function isMissionAlreadyStarted(missionState) {
  if (!missionState?.subMissions) return false;
  return Object.values(missionState.subMissions).some((sm) =>
    Object.values(sm.tasks || {}).some(
      (task) => task.status && task.status !== 'pending'
    )
  );
}

/**
 * Read a single task's status from its mission state file.
 *
 * Strips an optional trailing `-rp-NNN` replan suffix from taskId before
 * validating, then requires the canonical (suffix-stripped) id to have
 * exactly 4 dash-separated segments — throws otherwise. Reads
 * `harnessDir/state/mission-<missionId>.json` (missionId derived from the
 * first two segments) and looks up the task under its sub-mission (first
 * three segments).
 *
 * @param {string} harnessDir - path to the .harness directory
 * @param {string} taskId - canonical or replan-suffixed task id
 * @returns {string|null} the task's status, or null when the mission state
 *   file does not exist or the task is not found within it
 * @throws {Error} if the canonical taskId does not have 4 segments
 */
export function readTaskStatus(harnessDir, taskId) {
  // Defect #16 fix: strip optional `-rp-NNN` replan suffix before the
  // 4-segment guard. v0.1.31's defensive throw counted dash-separated
  // segments and rejected anything not exactly 4 — correct for catching
  // malformed IDs like "fix-001" but unintentionally rejected the
  // existing replan-suffix convention (dogfood 20, commit 1bc9265:
  // replanned tasks have IDs like "001-001-001-001-rp-001"). Also
  // restored the segment-count-only behavior from v0.1.31 — many test
  // fixtures use non-numeric 4-segment IDs like "001-001-001-cost1";
  // strict 3-digit-per-segment enforcement belongs in schema validation
  // (_schemas.js), not here.
  const canonical = taskId.replace(/(-rp-\d+)+$/, '');
  const parts = canonical.split('-');
  if (parts.length !== 4) {
    throw new Error(
      `readTaskStatus: taskId must have 4 dash-separated segments ` +
      `with an optional -rp-N replan suffix ` +
      `(e.g. "001-001-001-001" or "001-001-001-001-rp-001"), got ${parts.length} segment(s) in canonical "${canonical}" from "${taskId}"`
    );
  }
  const missionId = `${parts[0]}-${parts[1]}`;
  const subMissionId = `${parts[0]}-${parts[1]}-${parts[2]}`;
  const stateFile = path.join(harnessDir, 'state', `mission-${missionId}.json`);
  if (!fs.existsSync(stateFile)) return null;
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return state.subMissions?.[subMissionId]?.tasks?.[taskId]?.status || null;
}

/**
 * Convert a parsed mission state object back into a decomposition shape,
 * the inverse of the sub-mission/task portion of writeMissionState.
 *
 * Sub-missions are sorted by id, and each sub-mission's tasks are sorted by
 * id. Preserves targetFiles/dependencies/testCases/tracesScenario plus the
 * context-enrichment fields (patternReferences, dataSchemas) on each task so
 * planner output survives a resume round trip.
 *
 * @param {object} missionState - parsed mission state file (has subMissions)
 * @returns {{ subMissions: Array<{ id: string, description: string, tasks: Array }> }}
 */
export function stateToDecomp(missionState) {
  const subMissions = [];
  for (const [, sm] of Object.entries(missionState.subMissions).sort(([a], [b]) => a.localeCompare(b))) {
    const tasks = [];
    for (const [, task] of Object.entries(sm.tasks).sort(([a], [b]) => a.localeCompare(b))) {
      tasks.push({
        id: task.id,
        description: task.description,
        targetFiles: task.targetFiles || [],
        dependencies: task.dependencies || [],
        testCases: task.testCases || [],
        tracesScenario: task.tracesScenario || [],
        // Context enrichment fields (Phase I item 2) must survive the
        // round trip through mission state files. Pipeline.run() uses
        // stateToDecomp to rebuild the decomp on resume (pipeline.js)
        // and during mission regression remediation; dropping these
        // fields here would silently strip the planner's enrichment
        // output from executor prompts on any non-first-pass run.
        // Rule 2 (callsite audit): any new task-schema field added in
        // writeMissionState must also be added here.
        patternReferences: task.patternReferences || [],
        dataSchemas: task.dataSchemas || [],
      });
    }
    subMissions.push({ id: sm.id, description: sm.description, tasks });
  }
  return { subMissions };
}

/**
 * Persist a validated global plan into state.json and per-milestone/mission
 * plan files.
 *
 * Side effects (non-obvious):
 *  - Flips `state.projectMeta.currentPhase` to 'executing'.
 *  - Writes `harnessDir/plan/milestone-<id>.md` for each milestone and
 *    `harnessDir/plan/mission-<id>.md` for each mission in the plan.
 *  - Records `state.projectMeta.scopeItems` and `.scopeMapping` from the plan
 *    (scopeItems written unconditionally, even when empty).
 *  - Atomically writes the resulting state object to `harnessDir/state.json`
 *    via writeJsonAtomic (milestones + phase flip + scope fields all land in
 *    the same atomic write).
 *
 * @param {string} harnessDir - path to the .harness directory
 * @param {object} plan - validated plan with milestones[].missions[] and
 *   optional scopeItems/scopeMapping
 */
export function writeGlobalPlan(harnessDir, plan) {
  const state = readState(harnessDir);
  state.projectMeta.currentPhase = 'executing';

  for (const ms of plan.milestones) {
    const missions = {};
    for (const mi of ms.missions) {
      missions[mi.id] = {
        id: mi.id,
        description: mi.description,
        status: 'pending',
        stateFile: `state/mission-${mi.id}.json`,
        planFile: `plan/mission-${mi.id}.md`,
      };
      if (Array.isArray(mi.targetFiles) && mi.targetFiles.length > 0) {
        missions[mi.id].targetFiles = mi.targetFiles;
      }

      const planDir = path.join(harnessDir, 'plan');
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(
        path.join(planDir, `mission-${mi.id}.md`),
        `# Mission ${mi.id}\n\n${mi.description}\n`
      );
    }

    state.milestones[ms.id] = {
      id: ms.id,
      description: ms.description,
      status: 'pending',
      planFile: `plan/milestone-${ms.id}.md`,
      missions,
    };

    const planDir = path.join(harnessDir, 'plan');
    fs.writeFileSync(
      path.join(planDir, `milestone-${ms.id}.md`),
      `# Milestone ${ms.id}\n\n${ms.description}\n\nMissions:\n${ms.missions.map((m) => `- ${m.id}: ${m.description}`).join('\n')}\n`
    );
  }

  // Persist the scope-item set + planner-authored mapping in the SAME atomic
  // write as milestones+phase-flip, so resume() can rehydrate the plan object.
  // Write scopeItems UNCONDITIONALLY (even []) so key-presence — not truthiness
  // — distinguishes goal-only (present []) from legacy (absent) at resume.
  state.projectMeta.scopeItems = plan.scopeItems;
  state.projectMeta.scopeMapping = plan.scopeMapping;

  writeJsonAtomic(path.join(harnessDir, 'state.json'), state);
}

/**
 * Build and persist a fresh mission state file from a decomposition.
 *
 * Builds the { id, missionId, description, status, subMissions } shape (all
 * tasks initialized to status 'pending', with createdAt/startedAt/
 * completedAt, verify/progress/verification file pointers, and retryCount 0)
 * and atomically writes it to `harnessDir/state/mission-<missionId>.json`
 * via writeJsonAtomic.
 *
 * @param {string} harnessDir - path to the .harness directory
 * @param {string} missionId - mission id (e.g. "001-001")
 * @param {string} description - mission description
 * @param {{ subMissions: Array }} decomp - decomposition produced by the
 *   planner (or stateToDecomp)
 */
export function writeMissionState(harnessDir, missionId, description, decomp) {
  const subMissions = {};

  for (const sm of decomp.subMissions) {
    const tasks = {};
    for (const task of sm.tasks) {
      tasks[task.id] = {
        id: task.id,
        description: task.description,
        status: 'pending',
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        targetFiles: task.targetFiles || [],
        dependencies: task.dependencies || [],
        testCases: task.testCases || [],
        tracesScenario: task.tracesScenario || [],
        // Context enrichment (Phase I item 2) — preserve the
        // planner's adjacent-file exploration output so the executor
        // can read it from state. Without copying these fields, the
        // planner's enrichment work is silently dropped on the way
        // from structured_output to mission state. Rule 2
        // (callsite audit) would have caught this earlier.
        patternReferences: task.patternReferences || [],
        dataSchemas: task.dataSchemas || [],
        verifyFile: `verify/task-${task.id}.json`,
        progressFile: `progress/task-${task.id}.json`,
        verificationFile: `verification/task-${task.id}.json`,
        retryCount: 0,
      };
    }

    subMissions[sm.id] = {
      id: sm.id,
      description: sm.description,
      status: 'pending',
      tasks,
    };
  }

  const missionState = {
    id: missionId,
    missionId,
    description,
    // Mission is freshly decomposed — not yet started. The pipeline
    // calls transitionMission to move this to in_progress after
    // writeMissionState, keeping per-mission and global state.json
    // in sync via state-machine.js.
    status: 'pending',
    subMissions,
  };

  const stateDir = path.join(harnessDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  writeJsonAtomic(path.join(stateDir, `mission-${missionId}.json`), missionState);
}

/**
 * True iff any of the task's targetFiles points at a test file — used as
 * the heuristic for "this is a test-writing task" so testCases are only
 * enforced by the verifier when the task actually owns writing tests.
 */
export function isTestTask(task) {
  const files = task.targetFiles || [];
  return files.some((f) =>
    f.startsWith('test/') ||
    f.includes('/test/') ||
    f.includes('/__tests__/') ||
    f.endsWith('.test.js') ||
    f.endsWith('.test.ts') ||
    f.endsWith('.spec.js') ||
    f.endsWith('.spec.ts')
  );
}

/**
 * Resolve a harness-relative file reference to an absolute-ish path rooted
 * at harnessDir. Pure — performs no filesystem I/O and never throws.
 *
 * - Absolute refs (path.isAbsolute(ref)) are returned unchanged.
 * - Refs starting with the legacy `.harness/` prefix have that prefix
 *   stripped before joining with harnessDir.
 * - Any other ref is joined directly with harnessDir.
 *
 * @param {string} harnessDir - path to the .harness directory
 * @param {string} ref - a file reference (absolute, legacy-prefixed, or bare relative)
 * @returns {string} resolved path
 */
export function resolveHarnessFileRef(harnessDir, ref) {
  if (path.isAbsolute(ref)) {
    return ref;
  }
  if (ref.startsWith('.harness/')) {
    return path.join(harnessDir, ref.slice('.harness/'.length));
  }
  return path.join(harnessDir, ref);
}

/**
 * Create harnessDir/verify (if missing) and write verify/task-<taskId>.json
 * for the given task. The written file passes through planner-supplied
 * hardChecks as-is, and only persists testCases (mapped to
 * {id: 'TC#', description}) when isTestTask(task) is true — otherwise
 * testCases is written as an empty array.
 */
export function writeVerifyJson(harnessDir, task) {
  const verifyDir = path.join(harnessDir, 'verify');
  fs.mkdirSync(verifyDir, { recursive: true });

  // testCases are only enforced by the verifier for tasks that write tests
  // (targetFiles contains a test file). Implementation tasks can list
  // testCases at planning time as aspirational coverage, but enforcing them
  // on an implementation task causes the verifier to fail tasks whose code
  // is correct — the tests belong to a separate test-writing task.
  const keepTestCases = isTestTask(task);

  const verify = {
    taskId: task.id,
    targetFiles: task.targetFiles || [],
    hardChecks: Array.isArray(task.hardChecks) ? task.hardChecks : [], // mission 001-001: pass through planner-supplied hardChecks
    testCases: keepTestCases
      ? (task.testCases || []).map((tc, i) => ({ id: `TC${i + 1}`, description: tc }))
      : [],
  };

  fs.writeFileSync(
    path.join(verifyDir, `task-${task.id}.json`),
    JSON.stringify(verify, null, 2)
  );
}

/**
 * The canonical set of queue entry status strings. Any code that reads or
 * writes a queue entry's `status` field should restrict itself to these
 * values.
 */
export const VALID_QUEUE_STATUSES = Object.freeze([
  'pending',
  'failed-validation',
  'failed-execution',
  'failed-test-gate',
  'failed-criteria',
  'parked',
  'halted-review',
  'halted-analyzer',
  'rejected',
]);

/**
 * Write a queue entry for a project slug.
 *
 * Creates queue/{slug}/ directory under projectRoot with files:
 *   spec.md                  — raw spec string
 *   plan.json                — plan object serialised as JSON
 *   validated-at.json        — ISO timestamp string serialised as JSON
 *   assumption-results.json  — optional, written when assumptionResults provided
 *   spec.json                — optional, written verbatim when specJson provided
 *   status                   — plain text, one of VALID_QUEUE_STATUSES
 *
 * `failed-execution` is symmetric to `failed-validation` (it records a
 * post-validation execution failure) and MUST NOT be merged with it — the two
 * statuses represent distinct failure stages in the queue lifecycle.
 *
 * `validatedAt` is stored as a primitive ISO string so it round-trips cleanly
 * through `new Date(s).getTime()` (sort) and `String(s).slice(...)` (CLI display).
 * Per-assumption verification details live in a sibling file.
 *
 * `specJson` is the raw spec.json sibling content (string, written verbatim —
 * never parsed/re-serialised, preserving byte fidelity for the archive chain).
 * When undefined (or null — the readQueueEntry shape for an absent file,
 * passed back through failure-path re-writes), no spec.json is written and
 * any existing spec.json in the entry dir is left untouched (non-destructive).
 *
 * @param {string} projectRoot
 * @param {string} slug
 * @param {{ spec: string, plan: object, validatedAt: string, status: string, assumptionResults?: Array, specJson?: string }} entry
 */
export function writeQueueEntry(projectRoot, slug, { spec, plan, validatedAt, status, assumptionResults, specJson }) {
  const entryDir = path.join(projectRoot, 'queue', slug);
  fs.mkdirSync(entryDir, { recursive: true });
  fs.writeFileSync(path.join(entryDir, 'spec.md'), spec);
  fs.writeFileSync(path.join(entryDir, 'plan.json'), JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(entryDir, 'validated-at.json'), JSON.stringify(validatedAt, null, 2));
  if (assumptionResults !== undefined) {
    fs.writeFileSync(
      path.join(entryDir, 'assumption-results.json'),
      JSON.stringify(assumptionResults, null, 2),
    );
  }
  if (specJson !== undefined && specJson !== null) {
    fs.writeFileSync(path.join(entryDir, 'spec.json'), specJson);
  }
  fs.writeFileSync(path.join(entryDir, 'status'), status);
}

/**
 * Read a queue entry for a project slug.
 *
 * `specJson` is the raw spec.json sibling content: a string when
 * queue/{slug}/spec.json exists, `null` when absent.
 *
 * @param {string} projectRoot
 * @param {string} slug
 * @returns {{ slug: string, spec: string, plan: object, validatedAt: string, status: string, assumptionResults: Array, specJson: string | null } | null}
 */
export function readQueueEntry(projectRoot, slug) {
  const entryDir = path.join(projectRoot, 'queue', slug);
  if (!fs.existsSync(entryDir)) return null;
  const spec = fs.readFileSync(path.join(entryDir, 'spec.md'), 'utf8');
  const plan = JSON.parse(fs.readFileSync(path.join(entryDir, 'plan.json'), 'utf8'));
  const validatedAtRaw = JSON.parse(fs.readFileSync(path.join(entryDir, 'validated-at.json'), 'utf8'));
  // Tolerate the legacy {timestamp, assumptionResults} object shape for entries
  // written before the flatten-to-string migration.
  let validatedAt;
  let assumptionResults = [];
  if (validatedAtRaw && typeof validatedAtRaw === 'object') {
    validatedAt = validatedAtRaw.timestamp ?? '';
    assumptionResults = validatedAtRaw.assumptionResults ?? [];
  } else {
    validatedAt = validatedAtRaw ?? '';
  }
  const assumptionResultsPath = path.join(entryDir, 'assumption-results.json');
  if (fs.existsSync(assumptionResultsPath)) {
    try {
      assumptionResults = JSON.parse(fs.readFileSync(assumptionResultsPath, 'utf8'));
    } catch {
      // leave whatever fallback we already have
    }
  }
  const specJsonPath = path.join(entryDir, 'spec.json');
  const specJson = fs.existsSync(specJsonPath)
    ? fs.readFileSync(specJsonPath, 'utf8')
    : null;
  const status = fs.readFileSync(path.join(entryDir, 'status'), 'utf8').trim();
  return { slug, spec, plan, validatedAt, status, assumptionResults, specJson };
}

/**
 * Update ONLY the status file of an existing queue entry.
 *
 * Status-only by design: status transitions that happen after autonomous
 * remediation may have edited the on-disk queue spec.md (parking, the batch
 * failure paths, park-resolve) must not rewrite spec.md/plan.json/spec.json —
 * a full writeQueueEntry there would clobber the remediated copy with stale
 * in-memory content and stomp the mtimes the park CLI's spec.md/spec.json
 * divergence warning compares against parkedAt.
 *
 * Throws when the entry directory does not exist — a status file without an
 * entry would be an orphan, and callers always operate on a known entry.
 * (No status-value validation, mirroring writeQueueEntry.)
 *
 * @param {string} projectRoot
 * @param {string} slug
 * @param {string} status - one of VALID_QUEUE_STATUSES
 */
export function updateQueueEntryStatus(projectRoot, slug, status) {
  const entryDir = path.join(projectRoot, 'queue', slug);
  if (!fs.existsSync(entryDir)) {
    throw new Error(`updateQueueEntryStatus: queue entry '${slug}' does not exist at ${entryDir}`);
  }
  fs.writeFileSync(path.join(entryDir, 'status'), status);
}

/**
 * Write the park scene for a queue entry to queue/{slug}/park.json.
 *
 * The scene records WHY an entry parked, for a human to inspect via
 * `cc-orch park`:
 *   { site, parkedAt, round1, round2, appliedSpecEdits, questions,
 *     previousResolutions, resolution }
 * `resolution` is null until resolved, then { action, at, note, consumedAt }.
 *
 * P2 park diff preservation: a resolvable-park scene additionally carries
 * { stashRef, stashSha, baseSha } pointing at the gc-safe git stash object that
 * preserves the verified work-in-progress (see park-snapshot.js). These fields
 * are ABSENT when nothing was preserved (the tree was already clean, or the
 * leg does not preserve). They are written verbatim like every other scene
 * field; no special handling here.
 *
 * Atomic (write → fsync → rename): callers depend on park.json being fully
 * on disk BEFORE the entry status flips to 'parked'/'halted-review' — the
 * status file is the commit point.
 *
 * @param {string} projectRoot
 * @param {string} slug
 * @param {object} scene
 */
export function writeParkScene(projectRoot, slug, scene) {
  const entryDir = path.join(projectRoot, 'queue', slug);
  fs.mkdirSync(entryDir, { recursive: true });
  writeJsonAtomic(path.join(entryDir, 'park.json'), scene);
}

/**
 * Write the auto-waive scene for a queue entry to queue/{slug}/auto-waive.json.
 *
 * Mirrors writeParkScene's directory-resolution + atomic-write style. The
 * scene records WHY the batch assumption gate auto-waived (instead of parking),
 * so a future audit can read the per-verdict classification reasoning a human
 * would otherwise have produced.
 *
 * Append-only-by-rename: writes auto-waive.json if it does not exist; otherwise
 * the next free auto-waive-NNN.json (NNN zero-padded, starting 001) so a single
 * slug keeps its full auto-waive history if requeued. Never overwrites an
 * existing record. The caller builds the full scene; this only persists it.
 *
 * @param {string} projectRoot
 * @param {string} slug
 * @param {object} scene
 * @returns {string} absolute path written
 */
export function writeAutoWaiveScene(projectRoot, slug, scene) {
  const entryDir = path.join(projectRoot, 'queue', slug);
  fs.mkdirSync(entryDir, { recursive: true });

  let scenePath = path.join(entryDir, 'auto-waive.json');
  if (fs.existsSync(scenePath)) {
    let n = 1;
    do {
      scenePath = path.join(entryDir, `auto-waive-${String(n).padStart(3, '0')}.json`);
      n++;
    } while (fs.existsSync(scenePath));
  }

  writeJsonAtomic(scenePath, scene);
  return scenePath;
}

/**
 * Read the park scene for a queue entry.
 *
 * Returns null when park.json is missing or unparseable — never throws.
 * A scene-less parked entry is a degraded-but-legal state callers must
 * handle gracefully.
 *
 * @param {string} projectRoot
 * @param {string} slug
 * @returns {object | null}
 */
export function readParkScene(projectRoot, slug) {
  const scenePath = path.join(projectRoot, 'queue', slug, 'park.json');
  let raw;
  try {
    raw = fs.readFileSync(scenePath, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * List all queue entries sorted by creation time (validatedAt) ascending.
 *
 * Reads all subdirectories under queue/, calls readQueueEntry for each,
 * and returns entries sorted by their validatedAt timestamp. Non-directory
 * entries in queue/ are skipped. Returns an empty array when queue/ does
 * not exist.
 *
 * @param {string} projectRoot
 * @returns {Array<{ slug: string, spec: string, plan: object, validatedAt: *, status: string, assumptionResults: Array, specJson: string | null }>}
 */
export function listQueue(projectRoot) {
  const queueDir = path.join(projectRoot, 'queue');
  if (!fs.existsSync(queueDir)) return [];

  const dirNames = fs.readdirSync(queueDir);
  const results = [];

  for (const name of dirNames) {
    const entryPath = path.join(queueDir, name);
    const stat = fs.statSync(entryPath);
    if (!stat.isDirectory()) continue;
    const entry = readQueueEntry(projectRoot, name);
    if (entry) results.push(entry);
  }

  results.sort((a, b) => {
    const tA = new Date(a.validatedAt).getTime();
    const tB = new Date(b.validatedAt).getTime();
    return tA - tB;
  });

  return results;
}

/**
 * Remove a queue entry directory and all its contents.
 *
 * No-op (does not throw) when the slug directory does not exist.
 *
 * @param {string} projectRoot
 * @param {string} slug
 */
export function removeQueueEntry(projectRoot, slug) {
  const entryDir = path.join(projectRoot, 'queue', slug);
  if (!fs.existsSync(entryDir)) return;
  fs.rmSync(entryDir, { recursive: true, force: true });
}

/**
 * Assert that the verifier sidecar for a task is not a stub.
 *
 * Reads `harnessDir/verification/task-{taskId}.json`. Returns silently if the
 * file does not exist or if the parsed JSON does not have `isStub === true`.
 * Throws a descriptive Error if `isStub === true`.
 *
 * @param {string} harnessDir - path to the .harness directory
 * @param {string} taskId - task identifier (e.g. "001-001-001-001")
 * @throws {Error} if the sidecar exists and has isStub === true
 */
export function assertNoStubVerifierSidecar(harnessDir, taskId) {
  const sidecarPath = path.join(harnessDir, 'verification', `task-${taskId}.json`);
  if (!fs.existsSync(sidecarPath)) return;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  } catch {
    return;
  }
  if (parsed?.isStub === true) {
    throw new Error(`Verifier sidecar for task ${taskId} is a stub — real verification has not run yet`);
  }
}

/**
 * Build a reverse map from file path → missionId by reading all
 * mission-*.json state files in harnessDir/state/.
 *
 * For files claimed by multiple missions: uses sort()[0] of the
 * competing missionIds and emits a console.warn.
 *
 * For entries in changedFiles not found in any mission's targetFiles:
 * falls back to sort()[0] of all missionIds encountered and emits a
 * console.warn.
 *
 * @param {string} harnessDir - path to the .harness directory
 * @param {string[]} [changedFiles] - optional list of changed file paths
 * @returns {Map<string, string>} Map from filePath to missionId
 */
export function buildFileToMissionMap(harnessDir, changedFiles) {
  const stateDir = path.join(harnessDir, 'state');
  const fileToMissions = new Map(); // filePath → Set<missionId>
  const allMissionIds = [];

  if (fs.existsSync(stateDir)) {
    const entries = fs.readdirSync(stateDir);
    for (const entry of entries) {
      const match = entry.match(/^mission-(.+)\.json$/);
      if (!match) continue;
      const missionId = match[1];
      allMissionIds.push(missionId);

      const stateFile = path.join(stateDir, entry);
      let state;
      try {
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch {
        continue;
      }

      for (const sm of Object.values(state.subMissions || {})) {
        for (const task of Object.values(sm.tasks || {})) {
          for (const filePath of task.targetFiles || []) {
            if (!fileToMissions.has(filePath)) {
              fileToMissions.set(filePath, new Set());
            }
            fileToMissions.get(filePath).add(missionId);
          }
        }
      }
    }
  }

  const result = new Map();

  // Resolve each file to a single missionId, warning on conflicts.
  for (const [filePath, missionIds] of fileToMissions.entries()) {
    const sorted = [...missionIds].sort();
    if (sorted.length > 1) {
      console.warn(
        `buildFileToMissionMap: file "${filePath}" is claimed by multiple missions [${sorted.join(', ')}]; using "${sorted[0]}"`
      );
    }
    result.set(filePath, sorted[0]);
  }

  // Handle changedFiles entries not found in any mission's targetFiles.
  if (Array.isArray(changedFiles) && changedFiles.length > 0) {
    const sortedAllMissions = [...allMissionIds].sort();
    const fallback = sortedAllMissions[0];
    for (const filePath of changedFiles) {
      if (!result.has(filePath)) {
        console.warn(
          `buildFileToMissionMap: changed file "${filePath}" not found in any mission's targetFiles; falling back to "${fallback}"`
        );
        if (fallback !== undefined) {
          result.set(filePath, fallback);
        }
      }
    }
  }

  return result;
}
