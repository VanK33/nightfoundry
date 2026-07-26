#!/usr/bin/env node
/**
 * Mirrors the module-top marker-discipline guard used by
 * test/test-batch-resume.js / test/test-verifier-callsite-plumbing.js: this
 * file instantiates real Pipeline objects against isolated fs.mkdtemp()
 * fixture roots, not a re-entrant cc-orch invocation. If launched from
 * inside a live cc-orch run, CC_ORCH_ACTIVE_RUN would be inherited from the
 * parent process environment and could trip assertNoReentrantLiveRun's
 * guard against a fixture root. Clear the marker unconditionally here,
 * before any process.env-sensitive imports, so this file is re-entrancy-
 * neutral regardless of launch context.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

/**
 * test-restore-sibling-supersede.js — Sibling-supersede restore-override tests
 * plus snapshot-evidence tests for the analyzer prompt.
 *
 * Drives the REAL exported restoreSnapshot (src/orchestrator/core/snapshots.js)
 * and the REAL Pipeline._computeRestoreOverrides / _computeSnapshotEvidenceTable
 * helpers (src/orchestrator/core/pipeline.js), instantiating/borrowing the
 * Pipeline exactly as test-snapshots-integration.js does. For the evidence
 * cases (i)/(j) the analyzer prompt is captured via a stubbed
 * sessionManager.spawn seam (test-batch-failure-input-boundary.js makeAnalyzer
 * precedent) around the real _dispatchAnalyzer/analyzeFailure path.
 *
 * Cases:
 *   (a) ARCHETYPE — tasks A and C share file F, C complete with after/F;
 *       restoring A's before with computed overrides leaves F at C's after
 *       content, not A's before content.
 *   (b) REVAL SHAPE — restoring T's own after where a later-completedAt
 *       complete sibling's after wins.
 *   (c) T itself latest — T's own after copy used, no override entry.
 *   (d) a file NOT shared with any sibling reverts to the requesting task's
 *       phase copy exactly as today.
 *   (e) an 'invalidated' sibling with a newer completedAt is IGNORED.
 *   (f) empty/absent overrides restore identical bytes and the same count.
 *   (g) fail-soft — corrupt mission-state JSON and a missing sibling
 *       after-file each yield no override; _computeRestoreOverrides never
 *       throws.
 *   (h) tie-break — two complete siblings with identical completedAt: the
 *       winner is determined by task-id ordering, asserted deterministically.
 *   (i) EVIDENCE — an intact completed task yields an 'intact' row, an
 *       overwritten one yields 'overwritten-after-completion', and the
 *       captured analyzer prompt contains the engine-computed evidence block
 *       and the consumption rule text.
 *   (j) EVIDENCE fail-soft — no completed tasks with after/ snapshots yields
 *       NO evidence block, and the captured prompt is byte-identical to a
 *       prompt captured with today's (pre-feature) inputs.
 *
 * Run: node test/test-restore-sibling-supersede.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { restoreSnapshot } from '../src/orchestrator/core/snapshots.js';
import { Analyzer } from '../src/orchestrator/agents/analyzer.js';

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// ── Fixture helpers ─────────────────────────────────────────────────────────

function makeTmpRoot(prefix = 'cc-orch-rss-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Builds a real .harness/state/mission-<id>.json + .harness/state.json tree
 * (mirrors createPipelineHarness in test-snapshots-integration.js), generalised
 * to hold an arbitrary number of sibling tasks in one sub-mission.
 *
 * @param {{milestoneId?:string, missionId?:string, subMissionId?:string,
 *   tasks: Array<{id:string, status?:string, completedAt?:string|null,
 *   targetFiles?:string[]}>}} opts
 */
function buildHarness({
  milestoneId = '001',
  missionId = '001-001',
  subMissionId = '001-001-001',
  tasks = [],
} = {}) {
  const projectRoot = makeTmpRoot();
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const tasksObj = {};
  for (const t of tasks) {
    tasksObj[t.id] = {
      id: t.id,
      description: t.description || `task ${t.id}`,
      status: t.status || 'pending',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: t.completedAt ?? null,
      targetFiles: t.targetFiles || [],
      dependencies: [],
      testCases: [],
      tracesScenario: [],
      patternReferences: [],
      dataSchemas: [],
      verifyFile: `.harness/verify/task-${t.id}.json`,
      progressFile: `.harness/progress/task-${t.id}.json`,
      verificationFile: `.harness/verification/task-${t.id}.json`,
      retryCount: 0,
    };
  }

  const missionState = {
    id: missionId,
    missionId,
    description: `mission ${missionId}`,
    status: 'in_progress',
    subMissions: {
      [subMissionId]: {
        id: subMissionId,
        description: 'test sub-mission',
        status: 'in_progress',
        tasks: tasksObj,
      },
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify(missionState, null, 2)
  );

  const state = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId,
        description: `milestone ${milestoneId}`,
        status: 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: {
          [missionId]: {
            id: missionId,
            description: `mission ${missionId}`,
            status: 'in_progress',
            stateFile: `.harness/state/mission-${missionId}.json`,
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  return { projectRoot, harnessDir, milestoneId, missionId, subMissionId };
}

/** Real Pipeline instance, worktree/review disabled — mirrors
 *  makePipelineNoAuth in test-snapshots-integration.js. */
function makePipeline(projectRoot) {
  return new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: () => {},
    onConfirm: async () => true,
    noReview: true,
    skipReview: true,
  });
}

function writeSnapshotFile(harnessDir, taskId, phase, relPath, content) {
  const dest = path.join(harnessDir, 'snapshots', taskId, phase, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
}

function readMissionStatePath(harnessDir, missionId) {
  return path.join(harnessDir, 'state', `mission-${missionId}.json`);
}

/** Real Analyzer with ONLY the LLM-session seam stubbed (returns a crafted
 *  structured verdict). Mirrors makeAnalyzer in
 *  test-batch-failure-input-boundary.js. */
function makeAnalyzer(verdictForCall) {
  const spawnCalls = [];
  const sessionManager = {
    spawn(opts) {
      spawnCalls.push(opts);
      const structured = verdictForCall(spawnCalls.length, opts);
      const handle = { systemPromptTokens: 0, _toolCallCount: 0 };
      const p = Promise.resolve({ handle, result: { structured_output: structured } });
      p.handle = handle;
      return p;
    },
  };
  const logger = {
    createSessionLog: () => ({ logPath: path.join(os.tmpdir(), 'rss-analyzer-fake.log'), close() {} }),
    attachToSession() {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
    warn() {},
  };
  return { analyzer: new Analyzer(sessionManager, logger, null), spawnCalls };
}

function humanVerdict() {
  return {
    recommendation: 'human',
    rootCause: 'RSS-ROOT-CAUSE evidence test root cause',
    failureType: 'execution',
    affectedTasks: [],
    evidence: 'RSS-EVIDENCE evidence test evidence',
    notes: '',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// (a) ARCHETYPE
// ─────────────────────────────────────────────────────────────────────────

await test(
  "(a) ARCHETYPE: restoring A's before with computed overrides leaves the shared file at C's after content, NOT A's before content",
  async () => {
    const FILE = 'shared.js';
    const A = '001-001-001-001';
    const C = '001-001-001-003';
    const { projectRoot, harnessDir } = buildHarness({
      tasks: [
        { id: A, status: 'pending', targetFiles: [FILE] },
        { id: C, status: 'complete', completedAt: '2026-01-01T00:00:00.000Z', targetFiles: [FILE] },
      ],
    });
    try {
      writeSnapshotFile(harnessDir, A, 'before', FILE, 'A-before-content\n');
      writeSnapshotFile(harnessDir, C, 'after', FILE, 'C-after-content\n');

      const pipeline = makePipeline(projectRoot);
      const overrides = pipeline._computeRestoreOverrides({ id: A }, 'before');
      assert.strictEqual(
        overrides[FILE],
        path.join(harnessDir, 'snapshots', C, 'after', FILE),
        `expected override to point at C's after/ copy, got ${JSON.stringify(overrides)}`
      );

      const restored = restoreSnapshot(harnessDir, projectRoot, A, 'before', overrides);
      assert.strictEqual(restored, 1);

      const content = fs.readFileSync(path.join(projectRoot, FILE), 'utf8');
      assert.strictEqual(content, 'C-after-content\n', `expected C's after content, got "${content}"`);
      assert.notStrictEqual(content, 'A-before-content\n', 'must NOT revert to A\'s stale before content');
    } finally {
      cleanup(projectRoot);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// (b) REVAL SHAPE
// ─────────────────────────────────────────────────────────────────────────

await test(
  "(b) REVAL SHAPE: T's own after-restore where a later-completedAt complete sibling's after wins",
  async () => {
    const FILE = 'shared.js';
    const T = '001-001-001-001';
    const S = '001-001-001-002';
    const { projectRoot, harnessDir } = buildHarness({
      tasks: [
        { id: T, status: 'complete', completedAt: '2026-01-01T00:00:00.000Z', targetFiles: [FILE] },
        { id: S, status: 'complete', completedAt: '2026-01-02T00:00:00.000Z', targetFiles: [FILE] },
      ],
    });
    try {
      writeSnapshotFile(harnessDir, T, 'after', FILE, 'T-after-content\n');
      writeSnapshotFile(harnessDir, S, 'after', FILE, 'S-after-content\n');

      const pipeline = makePipeline(projectRoot);
      const overrides = pipeline._computeRestoreOverrides({ id: T }, 'after');
      assert.strictEqual(
        overrides[FILE],
        path.join(harnessDir, 'snapshots', S, 'after', FILE),
        `expected override to point at S's (later-completedAt) after/ copy, got ${JSON.stringify(overrides)}`
      );

      restoreSnapshot(harnessDir, projectRoot, T, 'after', overrides);
      const content = fs.readFileSync(path.join(projectRoot, FILE), 'utf8');
      assert.strictEqual(content, 'S-after-content\n', `expected S's after content, got "${content}"`);
    } finally {
      cleanup(projectRoot);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// (c) T itself latest
// ─────────────────────────────────────────────────────────────────────────

await test(
  "(c) T itself latest: T's own after copy used, overrides map has no entry for that file",
  async () => {
    const FILE = 'shared.js';
    const T = '001-001-001-001';
    const S = '001-001-001-002';
    const { projectRoot, harnessDir } = buildHarness({
      tasks: [
        { id: T, status: 'complete', completedAt: '2026-01-02T00:00:00.000Z', targetFiles: [FILE] },
        { id: S, status: 'complete', completedAt: '2026-01-01T00:00:00.000Z', targetFiles: [FILE] },
      ],
    });
    try {
      writeSnapshotFile(harnessDir, T, 'after', FILE, 'T-after-content\n');
      writeSnapshotFile(harnessDir, S, 'after', FILE, 'S-after-content\n');

      const pipeline = makePipeline(projectRoot);
      const overrides = pipeline._computeRestoreOverrides({ id: T }, 'after');
      assert.strictEqual(overrides[FILE], undefined, 'no override expected when T itself is the latest');

      restoreSnapshot(harnessDir, projectRoot, T, 'after', overrides);
      const content = fs.readFileSync(path.join(projectRoot, FILE), 'utf8');
      assert.strictEqual(content, 'T-after-content\n');
    } finally {
      cleanup(projectRoot);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// (d) non-shared file reverts to own phase copy
// ─────────────────────────────────────────────────────────────────────────

await test(
  "(d) a file NOT shared with any sibling reverts to the requesting task's phase copy exactly as today",
  async () => {
    const FILE = 'solo.js';
    const T = '001-001-001-001';
    const S = '001-001-001-002';
    const { projectRoot, harnessDir } = buildHarness({
      tasks: [
        { id: T, status: 'pending', targetFiles: [FILE] },
        { id: S, status: 'complete', completedAt: '2026-01-01T00:00:00.000Z', targetFiles: ['other.js'] },
      ],
    });
    try {
      writeSnapshotFile(harnessDir, T, 'before', FILE, 'T-before-content\n');
      // S never touched FILE — no snapshots/S/after/FILE on disk.

      const pipeline = makePipeline(projectRoot);
      const overrides = pipeline._computeRestoreOverrides({ id: T }, 'before');
      assert.strictEqual(overrides[FILE], undefined, 'no override expected for a non-shared file');

      restoreSnapshot(harnessDir, projectRoot, T, 'before', overrides);
      const content = fs.readFileSync(path.join(projectRoot, FILE), 'utf8');
      assert.strictEqual(content, 'T-before-content\n');
    } finally {
      cleanup(projectRoot);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// (e) invalidated sibling with a newer completedAt is IGNORED
// ─────────────────────────────────────────────────────────────────────────

await test(
  "(e) an 'invalidated' sibling with a newer completedAt is IGNORED (no override from it)",
  async () => {
    const FILE = 'shared.js';
    const T = '001-001-001-001';
    const A = '001-001-001-002';
    const B = '001-001-001-003';
    const { projectRoot, harnessDir } = buildHarness({
      tasks: [
        { id: T, status: 'pending', targetFiles: [FILE] },
        { id: A, status: 'complete', completedAt: '2026-01-01T00:00:00.000Z', targetFiles: [FILE] },
        { id: B, status: 'invalidated', completedAt: '2026-01-05T00:00:00.000Z', targetFiles: [FILE] },
      ],
    });
    try {
      writeSnapshotFile(harnessDir, T, 'before', FILE, 'T-before-content\n');
      writeSnapshotFile(harnessDir, A, 'after', FILE, 'A-after-content\n');
      writeSnapshotFile(harnessDir, B, 'after', FILE, 'B-after-content\n');

      const pipeline = makePipeline(projectRoot);
      const overrides = pipeline._computeRestoreOverrides({ id: T }, 'before');
      assert.strictEqual(
        overrides[FILE],
        path.join(harnessDir, 'snapshots', A, 'after', FILE),
        "the invalidated sibling B must NOT win despite its newer completedAt"
      );

      restoreSnapshot(harnessDir, projectRoot, T, 'before', overrides);
      const content = fs.readFileSync(path.join(projectRoot, FILE), 'utf8');
      assert.strictEqual(content, 'A-after-content\n');
    } finally {
      cleanup(projectRoot);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// (f) empty/absent overrides — existing-behavior pin
// ─────────────────────────────────────────────────────────────────────────

await test(
  '(f) empty/absent overrides — restoreSnapshot(h,p,id,phase) and restoreSnapshot(h,p,id,phase,{}) restore identical bytes and the same count',
  async () => {
    const FILE = 'solo.js';
    const T = '001-001-001-001';
    const { projectRoot, harnessDir } = buildHarness({
      tasks: [{ id: T, status: 'pending', targetFiles: [FILE] }],
    });
    const projectRoot2 = makeTmpRoot();
    try {
      writeSnapshotFile(harnessDir, T, 'before', FILE, 'own-before-content\n');

      const countUndefined = restoreSnapshot(harnessDir, projectRoot, T, 'before');
      const countEmpty = restoreSnapshot(harnessDir, projectRoot2, T, 'before', {});

      assert.strictEqual(countUndefined, countEmpty, 'restore counts must match (existing-behavior pin)');
      assert.strictEqual(countUndefined, 1);

      const c1 = fs.readFileSync(path.join(projectRoot, FILE), 'utf8');
      const c2 = fs.readFileSync(path.join(projectRoot2, FILE), 'utf8');
      assert.strictEqual(c1, c2, 'bytes restored via no-overrides and via {} must be identical');
      assert.strictEqual(c1, 'own-before-content\n');
    } finally {
      cleanup(projectRoot);
      cleanup(projectRoot2);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// (g) fail-soft
// ─────────────────────────────────────────────────────────────────────────

await test(
  '(g) fail-soft: corrupt mission-state JSON and a missing sibling after-file each yield no override; _computeRestoreOverrides never throws',
  async () => {
    const FILE = 'shared.js';
    const T = '001-001-001-001';
    const { projectRoot, harnessDir, missionId, subMissionId } = buildHarness({
      tasks: [{ id: T, status: 'pending', targetFiles: [FILE] }],
    });
    try {
      writeSnapshotFile(harnessDir, T, 'before', FILE, 'T-before-content\n');
      const pipeline = makePipeline(projectRoot);
      const missionStatePath = readMissionStatePath(harnessDir, missionId);
      const original = fs.readFileSync(missionStatePath, 'utf8');

      // g1: corrupt/unreadable mission-state JSON.
      fs.writeFileSync(missionStatePath, '{ this is not valid JSON ][');
      let overridesCorrupt;
      assert.doesNotThrow(() => {
        overridesCorrupt = pipeline._computeRestoreOverrides({ id: T }, 'before');
      }, '_computeRestoreOverrides must never throw on a corrupt mission-state file');
      assert.deepStrictEqual(overridesCorrupt, {}, 'a corrupt mission-state file must yield no overrides');

      // Restore valid state, then add a sibling with a completed status but
      // NO on-disk after/ copy of the shared file.
      const missionState = JSON.parse(original);
      const S = '001-001-001-002';
      missionState.subMissions[subMissionId].tasks[S] = {
        id: S,
        description: 'sibling with missing after-file',
        status: 'complete',
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: '2026-01-01T00:00:00.000Z',
        targetFiles: [FILE],
        dependencies: [],
        testCases: [],
        tracesScenario: [],
        patternReferences: [],
        dataSchemas: [],
        verifyFile: `.harness/verify/task-${S}.json`,
        progressFile: `.harness/progress/task-${S}.json`,
        verificationFile: `.harness/verification/task-${S}.json`,
        retryCount: 0,
      };
      fs.writeFileSync(missionStatePath, JSON.stringify(missionState, null, 2));
      // NOTE: deliberately no snapshots/S/after/shared.js on disk.

      let overridesMissingAfter;
      assert.doesNotThrow(() => {
        overridesMissingAfter = pipeline._computeRestoreOverrides({ id: T }, 'before');
      }, '_computeRestoreOverrides must never throw when a sibling after-file is missing');
      assert.deepStrictEqual(overridesMissingAfter, {}, 'a missing sibling after-file must yield no override');
    } finally {
      cleanup(projectRoot);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// (h) tie-break
// ─────────────────────────────────────────────────────────────────────────

await test(
  '(h) tie-break: two complete siblings with identical completedAt resolve deterministically by task-id ordering',
  async () => {
    const FILE = 'shared.js';
    const T = '001-001-001-001';
    const A = '001-001-001-002';
    const B = '001-001-001-003'; // lexicographically greater than A
    const TIE = '2026-01-01T00:00:00.000Z';
    const { projectRoot, harnessDir } = buildHarness({
      tasks: [
        { id: T, status: 'pending', targetFiles: [FILE] },
        { id: A, status: 'complete', completedAt: TIE, targetFiles: [FILE] },
        { id: B, status: 'complete', completedAt: TIE, targetFiles: [FILE] },
      ],
    });
    try {
      writeSnapshotFile(harnessDir, T, 'before', FILE, 'T-before-content\n');
      writeSnapshotFile(harnessDir, A, 'after', FILE, 'A-after-content\n');
      writeSnapshotFile(harnessDir, B, 'after', FILE, 'B-after-content\n');

      const pipeline = makePipeline(projectRoot);
      const overrides = pipeline._computeRestoreOverrides({ id: T }, 'before');
      assert.strictEqual(
        overrides[FILE],
        path.join(harnessDir, 'snapshots', B, 'after', FILE),
        `tie on completedAt must resolve to the lexicographically-greater task id ('${B}' > '${A}'), got ${JSON.stringify(overrides)}`
      );

      restoreSnapshot(harnessDir, projectRoot, T, 'before', overrides);
      const content = fs.readFileSync(path.join(projectRoot, FILE), 'utf8');
      assert.strictEqual(content, 'B-after-content\n');
    } finally {
      cleanup(projectRoot);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// (i) EVIDENCE
// ─────────────────────────────────────────────────────────────────────────

await test(
  "(i) EVIDENCE: an intact completed task yields an 'intact' row, an overwritten one yields 'overwritten-after-completion', and the analyzer prompt carries the engine-computed evidence block + consumption rule",
  async () => {
    const INTACT_FILE = 'intact.js';
    const OVERWRITTEN_FILE = 'overwritten.js';
    const INTACT_TASK = '001-001-001-001';
    const OVERWRITTEN_TASK = '001-001-001-002';
    const FAILED_TASK = '001-001-001-003';
    const { projectRoot, harnessDir, milestoneId, missionId } = buildHarness({
      tasks: [
        { id: INTACT_TASK, status: 'complete', completedAt: '2026-01-01T00:00:00.000Z', targetFiles: [INTACT_FILE] },
        { id: OVERWRITTEN_TASK, status: 'complete', completedAt: '2026-01-02T00:00:00.000Z', targetFiles: [OVERWRITTEN_FILE] },
        { id: FAILED_TASK, status: 'pending', targetFiles: ['failed.js'] },
      ],
    });
    try {
      // Intact: after/ snapshot and working tree agree.
      fs.writeFileSync(path.join(projectRoot, INTACT_FILE), 'intact-content\n');
      writeSnapshotFile(harnessDir, INTACT_TASK, 'after', INTACT_FILE, 'intact-content\n');

      // Overwritten: after/ snapshot no longer matches the working tree.
      fs.writeFileSync(path.join(projectRoot, OVERWRITTEN_FILE), 'CHANGED-content\n');
      writeSnapshotFile(harnessDir, OVERWRITTEN_TASK, 'after', OVERWRITTEN_FILE, 'landed-content\n');

      const pipeline = makePipeline(projectRoot);

      const table = pipeline._computeSnapshotEvidenceTable(milestoneId);
      const byId = Object.fromEntries(table.map((r) => [r.taskId, r.label]));
      assert.strictEqual(byId[INTACT_TASK], 'intact', `expected ${INTACT_TASK} → intact, got ${JSON.stringify(table)}`);
      assert.strictEqual(
        byId[OVERWRITTEN_TASK],
        'overwritten-after-completion',
        `expected ${OVERWRITTEN_TASK} → overwritten-after-completion, got ${JSON.stringify(table)}`
      );

      const { analyzer, spawnCalls } = makeAnalyzer(() => humanVerdict());
      pipeline.analyzer = analyzer;
      pipeline._currentMsId = milestoneId;

      const failedTask = { id: FAILED_TASK, missionId, description: 'failed task', targetFiles: ['failed.js'] };
      try {
        await pipeline._dispatchAnalyzer(failedTask, 'execution', 0);
      } catch {
        // A human verdict falls through to a CircuitBreakerError at the
        // pipeline level — expected and irrelevant to this assertion; only
        // the captured prompt matters here.
      }

      assert.strictEqual(spawnCalls.length, 1, 'the analyzer session must be spawned exactly once');
      const prompt = spawnCalls[0].prompt;
      assert.ok(
        prompt.includes('ENGINE-COMPUTED evidence'),
        `prompt must contain the engine-computed evidence block header, got:\n${prompt}`
      );
      assert.ok(
        prompt.includes(`${INTACT_TASK} → intact`),
        `prompt must contain the intact row for ${INTACT_TASK}, got:\n${prompt}`
      );
      assert.ok(
        prompt.includes(`${OVERWRITTEN_TASK} → overwritten-after-completion`),
        `prompt must contain the overwritten row for ${OVERWRITTEN_TASK}, got:\n${prompt}`
      );
      assert.ok(
        prompt.includes('Rule: before alleging that a completed task falsely claimed completion'),
        `prompt must contain the consumption rule text, got:\n${prompt}`
      );
      assert.ok(
        prompt.includes('never as false completion'),
        `prompt must contain the "never as false completion" consumption clause, got:\n${prompt}`
      );
    } finally {
      cleanup(projectRoot);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// (j) EVIDENCE fail-soft
// ─────────────────────────────────────────────────────────────────────────

await test(
  "(j) EVIDENCE fail-soft: no completed tasks with after/ snapshots yields NO evidence block, and the captured prompt is byte-identical to a prompt captured with today's inputs",
  async () => {
    const FAILED_TASK = '001-001-001-001';
    const { projectRoot, harnessDir, milestoneId, missionId } = buildHarness({
      tasks: [{ id: FAILED_TASK, status: 'pending', targetFiles: ['failed.js'] }],
    });
    const originalNow = Date.now;
    try {
      const { analyzer, spawnCalls } = makeAnalyzer(() => humanVerdict());
      const pipeline = makePipeline(projectRoot);
      pipeline.analyzer = analyzer;
      pipeline._currentMsId = milestoneId;

      const failedTask = { id: FAILED_TASK, missionId, description: 'failed task', targetFiles: ['failed.js'] };

      const FIXED_NOW = 1700000000000;
      Date.now = () => FIXED_NOW;

      // Call 1: through the real _dispatchAnalyzer path, which computes the
      // (empty, since no completed task has an after/ snapshot) evidence table.
      try {
        await pipeline._dispatchAnalyzer(failedTask, 'execution', 0);
      } catch {
        // Expected CircuitBreakerError from the human verdict — irrelevant here.
      }
      assert.strictEqual(spawnCalls.length, 1, 'expected exactly one spawn from call 1');
      const promptWithComputedTable = spawnCalls[0].prompt;

      // Reset the per-task history so the baseline call below starts from the
      // same empty-history condition call 1 started from.
      const historyFile = path.join(harnessDir, 'analysis', `history-${FAILED_TASK}.json`);
      fs.rmSync(historyFile, { force: true });
      spawnCalls.length = 0;

      // Call 2: today's (pre-feature) call shape — no snapshotEvidence key at all.
      await analyzer.analyzeFailure(
        {
          taskId: FAILED_TASK,
          taskDescription: failedTask.description,
          failureType: 'execution',
          retryCount: 0,
          allowedRecommendations: ['re_plan', 'human'],
        },
        projectRoot
      );
      assert.strictEqual(spawnCalls.length, 1, 'expected exactly one spawn from call 2');
      const promptBaseline = spawnCalls[0].prompt;

      assert.ok(
        !promptWithComputedTable.includes('ENGINE-COMPUTED evidence'),
        'no completed after/ snapshots must yield NO evidence block'
      );
      assert.strictEqual(
        promptWithComputedTable,
        promptBaseline,
        "the prompt with an empty computed evidence table must be byte-identical to a prompt from a call site that never passed snapshotEvidence"
      );
    } finally {
      Date.now = originalNow;
      cleanup(projectRoot);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────
// (k) needs_revalidation 'after'-phase caller shape
// ─────────────────────────────────────────────────────────────────────────

await test(
  "(k) NEEDS_REVALIDATION SHAPE: T's own after-restore where T is 'needs_revalidation' with no completedAt floor and an older-completedAt complete sibling's after wins",
  async () => {
    const FILE = 'shared.js';
    const T = '001-001-001-001';
    const S = '001-001-001-002';
    const { projectRoot, harnessDir } = buildHarness({
      tasks: [
        { id: T, status: 'needs_revalidation', completedAt: null, targetFiles: [FILE] },
        { id: S, status: 'complete', completedAt: '2026-01-01T00:00:00.000Z', targetFiles: [FILE] },
      ],
    });
    try {
      writeSnapshotFile(harnessDir, T, 'after', FILE, 'T-after-content\n');
      writeSnapshotFile(harnessDir, S, 'after', FILE, 'S-after-content\n');

      const pipeline = makePipeline(projectRoot);
      const overrides = pipeline._computeRestoreOverrides({ id: T }, 'after');
      assert.strictEqual(
        overrides[FILE],
        path.join(harnessDir, 'snapshots', S, 'after', FILE),
        `expected override to point at S's after/ copy since T has no completedAt floor and is skipped, got ${JSON.stringify(overrides)}`
      );

      restoreSnapshot(harnessDir, projectRoot, T, 'after', overrides);
      const content = fs.readFileSync(path.join(projectRoot, FILE), 'utf8');
      assert.strictEqual(content, 'S-after-content\n', `expected S's after content, got "${content}"`);
    } finally {
      cleanup(projectRoot);
    }
  }
);

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exitCode = failCount > 0 ? 1 : 0;
