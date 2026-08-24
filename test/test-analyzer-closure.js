#!/usr/bin/env node
/**
 * test-analyzer-closure.js — Analyzer closure: de-amnesia + consumed
 * recommendations + repeat escalation
 * (spec: analyzer-closure.spec.md / analyzer-closure.spec.json).
 *
 * Written by the INDEPENDENT test author against the spec contract only —
 * before the implementation exists. At a pre-feature HEAD the behavioral
 * cases (TC1b, TC1c, TC2b, TC3a, TC5a, TC5b, TC6a, TC7a, and TC1a's new
 * status value) MUST fail because today no history file exists at all, the
 * task circuit-breaker site conflates retry/human into one identical throw,
 * and the milestone-regression loop blindly burns its fixed-count budget.
 * The guard cases (TC2a, TC3b-part, TC6b, TC6c, TC7b, TC8a, TC8b) pin
 * today's behavior and must keep passing after the feature lands.
 *
 * Coverage (numbered after the spec's acceptance criteria):
 *   TC1a (AC-)  — VALID_QUEUE_STATUSES includes 'halted-analyzer'
 *                 (existing statuses preserved)
 *   TC1b (AC1)  — RED BASELINE: two analyses of the same task → 2-entry
 *                 top-level-array analysis/history-<canonicalId>.json with
 *                 {eventId, ts, failureType, recommendation, affectedTaskIds,
 *                 rootCause, outcome:null}; BOTH per-event gate-failure files
 *                 remain; a -rp-1 replacement appends to the SAME canonical
 *                 history file; pseudo-ids pass through unchanged; no entry
 *                 matches detectHaltInfo's halt patterns
 *   TC1c (AC1)  — detectHaltInfo's result is unchanged by the presence of a
 *                 populated history file (real-produced AND an adversarial
 *                 fixture file whose nested text carries scan words); a
 *                 control halt-pattern file proves the scan is live
 *   TC2a (AC2)  — GUARD: with no history, at an unchanged site / default
 *                 allowedRecommendations, the analyzer prompt + systemPrompt
 *                 are byte-identical to today's, and the session jsonSchema
 *                 recommendation enum is exactly ['retry','re_plan','human']
 *   TC2b (AC2)  — with history present, the round-2 prompt contains the
 *                 prior round's recommendation/outcome (incl. the pipeline-
 *                 back-filled 'escalated…' outcome), the prior eventId
 *                 (provenance), the one-line rootCause, and the do-not-repeat
 *                 rule; round-1 prompt carries no injection
 *   TC3a (AC3)  — the task circuit-breaker site passes
 *                 allowedRecommendations ['re_plan','human']: session schema
 *                 enum excludes 'retry', prompt omits the retry rule line and
 *                 notes the exhausted retry budget
 *   TC3b (AC3)  — unchanged site (milestone regression) keeps all three
 *                 verbs in schema + prompt (asserted inside TC7b)
 *   TC4  (AC4)  — isRepeatVerdict pure-fn matrix: same/diff recommendation ×
 *                 same/diff id set × order-insensitivity × set semantics
 *   TC5a (AC5)  — second identical 'human' verdict at the task site →
 *                 CircuitBreakerError with escalatedByRepeat === true, loud
 *                 log, 'Circuit breaker:' prefix kept; first round never
 *                 escalates-by-repeat; history keeps the model's verdicts
 *   TC5b (AC5)  — repeat escalation fires regardless of the current
 *                 recommendation: re_plan consumed once (REAL
 *                 scheduler.replaceTask; history outcome 'replaced with
 *                 [ids]'), the identical re_plan verdict on the replacement
 *                 task escalates instead of re-consuming (replanTask not
 *                 called again); history keeps the ORIGINAL 're_plan'
 *                 recommendation with escalation only in outcome
 *   TC6a (AC5)  — batch: repeat-escalated human verdict → status
 *                 'halted-analyzer' + minimal scene (site 'analyzer-human',
 *                 questions carrying rootCause/evidence + eventId pointer)
 *                 through the REAL forensic-archive chain (TC5d fixture
 *                 construction — git root, real pending milestone, NO archive
 *                 injection); prior park history survives
 *                 (read-existing-then-append); revert unchanged; the entry
 *                 ends the pass complete and resolvable; the batch continues
 *                 to the next entry
 *   TC6b (AC6)  — GUARD: batch CircuitBreakerError with a non-human
 *                 (re_plan-fallthrough) recommendation keeps today's
 *                 failed-execution (no park scene, spec files preserved)
 *   TC6c (AC6)  — GUARD: single-run human keeps today's throw with the
 *                 'Circuit breaker:' prefix (no repeat-escalation marker on
 *                 a first round)
 *   TC7a (AC7)  — milestone-regression loop: two consecutive identical
 *                 analyses break to the existing regression-failed gate
 *                 before the fixed cap (2 analyzer sessions, 1 remediation
 *                 pass, gate reached)
 *   TC7b (AC7)  — GUARD: distinct consecutive analyses let the loop run to
 *                 the cap (3 sessions, 3 remediation passes, gate reached);
 *                 also asserts the unchanged-site schema/prompt keep all
 *                 three verbs (TC3b)
 *   TC8a (AC8)  — GUARD: corrupt history file blocks nothing — the analysis
 *                 runs and the prompt injection no-ops (prompt byte-identical
 *                 to the pinned baseline)
 *   TC8b (AC8)  — GUARD: corrupt history file → the repeat comparator
 *                 no-ops at the task site (throw keeps its prefix, no
 *                 escalatedByRepeat)
 *
 * Run: node test/test-analyzer-closure.js
 *
 * Discipline (spec Constraints) — seams stubbed, per case:
 *   - The analyzer's LLM session is ALWAYS the real Analyzer class with a
 *     fake sessionManager whose spawn() returns crafted structured verdicts
 *     (the spec's "analyzeFailure's session returning crafted verdicts").
 *     The real analyzeFailure / extractAnalysis / history-persistence code
 *     paths run un-stubbed in every case.
 *   - TC1b/TC1c/TC2a/TC8a: session seam only (direct analyzeFailure calls).
 *   - TC2b/TC3a/TC5a/TC6c/TC8b: session seam + Pipeline._dispatchAnalyzer is
 *     the real method; pipeline.planner.replanTask is a planner seam stub
 *     where a re_plan verdict needs it.
 *   - TC5b: session seam + planner.replanTask seam; scheduler.replaceTask is
 *     the REAL implementation operating on a populated in-memory DAG
 *     (_tasksById/_pending/_runningFiles set directly, the established
 *     pattern from test-scheduler-replace-task.js).
 *   - TC6a/TC6b: session seam + executor-trigger seam (_executeAllMilestones
 *     replaced by a stub that drives the real _dispatchAnalyzer) + planner
 *     seams (verifyAssumptions / remediateAssumption / reExtractAssumptions /
 *     replanTask) + _reviewGate no-op. batchResume, the park layer
 *     (_parkEntry / writeParkScene / updateQueueEntryStatus), and the
 *     forensic archive chain are REAL (no `archive` injection).
 *   - TC7a/TC7b: session seam + verifier-trigger seam (verifier.verifyTask
 *     mock failing the regression check) + planner seam
 *     (remediateRegressionFailure) + executor seam (_executeAndVerifyTask
 *     no-op). The remediation loop itself is the real _executeMilestone code.
 *   - NEVER stubbed anywhere: isRepeatVerdict, the history persistence, the
 *     park layer, batchResume, the forensic archive in the halted-analyzer
 *     case.
 *
 * New-symbol handling: CircuitBreakerError and isRepeatVerdict are resolved
 * via dynamic import at runtime so this file loads and the behavioral cases
 * fail for behavioral reasons at a pre-feature HEAD (TC4 is the only
 * new-symbol-only case — it fails with an explicit "not exported" message).
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { Analyzer } from '../src/orchestrator/agents/analyzer.js';
import { writeQueueEntry, readQueueEntry, VALID_QUEUE_STATUSES } from '../src/orchestrator/core/state.js';
import { canonicalTaskId } from '../src/orchestrator/core/scheduler.js';
import { detectHaltInfo } from '../src/cli/commands/archive.js';
import { activeHarnessDir } from '../src/orchestrator/core/run-context.js';

// This suite's fixtures build active pipeline roots (Pipeline construction
// resolves this.harnessDir via activeHarnessDir(projectRoot)). If the suite
// is launched from inside a live run, CC_ORCH_ACTIVE_RUN would be inherited
// here and every accessor call below would resolve into that unrelated
// pointer directory instead of each fixture's own flat .harness root —
// clear it so this file's fixtures are re-entrancy-neutral regardless of
// launch context (mirrors scripts/run-tests.js).
delete process.env.CC_ORCH_ACTIVE_RUN;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ── New-symbol resolvers (dynamic — file must load at pre-feature HEAD) ─────

async function loadCircuitBreakerError() {
  try {
    const mod = await import('../src/orchestrator/core/circuit-breaker-error.js');
    return mod.CircuitBreakerError ?? null;
  } catch {
    return null;
  }
}

/**
 * The spec allows isRepeatVerdict to live "in analyzer.js or a small core
 * module" — probe analyzer.js first, then scan core/ and agents/ for any
 * module that mentions the symbol and exports it.
 */
async function loadIsRepeatVerdict() {
  const candidates = [path.resolve(__dirname, '../src/orchestrator/agents/analyzer.js')];
  for (const dir of ['../src/orchestrator/core', '../src/orchestrator/agents']) {
    const abs = path.resolve(__dirname, dir);
    let names = [];
    try {
      names = fs.readdirSync(abs).filter((f) => f.endsWith('.js'));
    } catch {
      continue;
    }
    for (const f of names) {
      try {
        if (fs.readFileSync(path.join(abs, f), 'utf8').includes('isRepeatVerdict')) {
          candidates.push(path.join(abs, f));
        }
      } catch { /* skip unreadable */ }
    }
  }
  for (const c of candidates) {
    try {
      const mod = await import(pathToFileURL(c).href);
      if (typeof mod.isRepeatVerdict === 'function') return mod.isRepeatVerdict;
    } catch { /* skip non-importable */ }
  }
  return null;
}

// ── Fixture helpers ─────────────────────────────────────────────────────────

function makeTmpRoot(prefix = 'cc-orch-anlz-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** A schema-valid structured analyzer verdict (affectedTaskIds → objects). */
function verdict({
  recommendation = 'human',
  rootCause = 'fixture root cause',
  failureType = 'verification',
  affectedTaskIds = [],
  evidence = 'fixture evidence',
  notes = '',
} = {}) {
  return {
    recommendation,
    rootCause,
    failureType,
    affectedTasks: affectedTaskIds.map((taskId) => ({
      taskId,
      reason: 'shares files with the failed task',
      action: 'needs_revalidation',
    })),
    evidence,
    notes,
  };
}

/**
 * Real Analyzer with ONLY the LLM-session seam stubbed: sessionManager.spawn
 * records the spawn opts (prompt / systemPrompt / jsonSchema) and resolves to
 * a crafted structured verdict. Logger/tokenTracker are inert infrastructure
 * fakes (analyzer.js only logs through them).
 */
function makeAnalyzerHarness(verdictForCall) {
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
    createSessionLog: () => ({ logPath: path.join(os.tmpdir(), 'analyzer-closure-fake.log'), close() {} }),
    attachToSession() {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
    warn() {},
  };
  return { analyzer: new Analyzer(sessionManager, logger, null), spawnCalls };
}

// Post-run reads: resolve through the accessor so a no-pointer fixture
// still reads its own flat .harness root while a pointer fixture (an
// active run) reads the actual per-run dir the code under test wrote to.
const historyPath = (projectRoot, canonicalId) =>
  path.join(activeHarnessDir(projectRoot), 'analysis', `history-${canonicalId}.json`);

function readHistory(projectRoot, canonicalId) {
  const p = historyPath(projectRoot, canonicalId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return 'UNPARSEABLE';
  }
}

function listAnalysisFiles(projectRoot) {
  const dir = path.join(activeHarnessDir(projectRoot), 'analysis');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

// Date.now() collision guard between consecutive analyses (eventId embeds it).
const tick = () => new Promise((r) => setTimeout(r, 10));

/**
 * PINNED CURRENT-STATE BASELINE — the analyzer user prompt exactly as
 * analyzer.js builds it today (template copied verbatim at authoring time;
 * the spec contracts that a no-history call at default allowedRecommendations
 * stays byte-identical to this).
 */
function expectedBaselinePrompt({ taskId, eventId, failureType, retryCount, taskDescription, projectRoot, sidecarPath = null }) {
  // Mirrors analyzer.js's own `const harnessDir = activeHarnessDir(projectRoot)`
  // — the accessor keeps no-pointer fixtures resolving to the flat root
  // while still tracking a pointer fixture's real per-run dir.
  const harnessDir = activeHarnessDir(projectRoot);
  const progressJsonFile = path.join(harnessDir, 'progress', `task-${taskId}.json`);
  const verificationJsonFile = path.join(harnessDir, 'verification', `task-${taskId}.json`);
  const stateJsonPath = path.join(harnessDir, 'state.json');
  const parts = taskId.split('-');
  const missionId = `${parts[0]}-${parts[1]}`;
  const missionStateFile = path.join(harnessDir, 'state', `mission-${missionId}.json`);
  const candidateFiles = [progressJsonFile, verificationJsonFile, missionStateFile];
  if (sidecarPath) candidateFiles.push(sidecarPath);
  const existingFiles = candidateFiles.filter((f) => fs.existsSync(f));

  return `Analyze gate failure for task ${taskId}.

Event ID: ${eventId}
Failure type: ${failureType} (after ${retryCount + 1} attempts)
Task description: ${taskDescription}

Files to read and analyze:
- State: ${stateJsonPath}
- Mission state: ${missionStateFile}
${existingFiles.map((f) => `- ${path.basename(f)}: ${f}`).join('\n')}

Steps:
1. Read the JSON sidecars to identify root cause
2. Read mission state to find completed tasks with overlapping affectedFiles/targetFiles
3. Assess which completed tasks are safe to keep vs. need revalidation
4. Recommend one of: retry / re_plan / human

Return your analysis as the session's structured output matching the session's attached JSON schema exactly. Allowed recommendation values for THIS analysis: "retry" | "re_plan" | "human".

Rules:
- retry: if the failure looks transient (flaky test, network blip)
- re_plan: if the task is fundamentally wrong and needs re-decomposition
- human: if the spec is ambiguous, the failure pattern is novel, or you are not confident
- Only list affected tasks that actually share files with the failed task
- Mark tasks that touched the same files as 'needs_revalidation'; unrelated completed tasks as 'safe_to_keep' (or omit)
- Enumerate every material observation beyond the primary root cause as its own secondaryFindings entry — do not bury it in prose
- Do NOT write any files — the orchestrator persists your structured output`;
}

const EXPECTED_BASELINE_SYSTEM_PROMPT = `You are a Harness Analyzer. Your ONLY job is to analyze gate failures and return a structured impact analysis.

Rules:
- Read all relevant files before analyzing — never assume
- Identify root cause from JSON sidecars
- Check file overlap between failed task and completed tasks
- Be specific about which tasks are affected and why
- Return your analysis as a structured JSON object matching the session's jsonSchema
- Do NOT write analysis files — the orchestrator persists the structured output
- Do NOT write or modify business code
- Do NOT update state.json
- The working tree holds the run's in-flight work: HEAD predates it by design, so absence from git history is NEVER evidence that work was not done — judge from the files themselves`;

const RETRY_RULE_LINE = '- retry: if the failure looks transient (flaky test, network blip)';

/**
 * Minimal pipeline harness: temp project root + .harness with one mission
 * state file registering the given tasks (test-circuit-breaker-replan.js
 * pattern). Returns { projectRoot, harnessDir }.
 */
function createPipelineHarness({
  tasks = [{ id: '001-001-001-001', status: 'in_progress' }],
  missionId = '001-001',
} = {}) {
  const projectRoot = makeTmpRoot('cc-orch-anlz-pipe-');
  const harnessDir = path.join(projectRoot, '.harness');
  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  const subMissionId = `${missionId}-001`;
  const taskMap = {};
  for (const t of tasks) {
    taskMap[t.id] = {
      id: t.id,
      description: t.description || 'fixture task',
      status: t.status || 'in_progress',
      retryCount: 0,
      targetFiles: t.targetFiles || ['src/foo.js'],
      dependencies: t.dependencies || [],
    };
  }
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify({
      id: missionId,
      missionId,
      description: 'fixture mission',
      status: 'in_progress',
      subMissions: { [subMissionId]: { id: subMissionId, status: 'in_progress', tasks: taskMap } },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
      globalStatus: 'active',
      milestones: {
        '001': {
          id: '001', description: 'fixture milestone', status: 'in_progress',
          missions: { [missionId]: { id: missionId, description: 'fixture mission', status: 'in_progress', stateFile: `.harness/state/mission-${missionId}.json` } },
        },
      },
    }, null, 2)
  );
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'foo.js'), '// foo\n');
  return { projectRoot, harnessDir, missionId, subMissionId };
}

/**
 * Pipeline whose analyzer is the REAL Analyzer with only the session seam
 * stubbed; planner.replanTask is a recordable seam.
 */
function makeDispatchPipeline(projectRoot, verdictForCall, opts = {}) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    statusBar: false,
    skipWorktreeCreation: true,
  });
  const { analyzer, spawnCalls } = makeAnalyzerHarness(verdictForCall);
  pipeline.analyzer = analyzer;
  const replanCalls = [];
  pipeline.planner.replanTask = async (failedTask, report, missionContext) => {
    replanCalls.push({ failedTask, report, missionContext });
    if (opts.replanResult) return opts.replanResult(replanCalls.length);
    return { replacementTasks: [] };
  };
  pipeline.planner.closeReusableSession = async () => {};
  return { pipeline, logs, spawnCalls, replanCalls };
}

const taskFixture = (id = '001-001-001-001') => ({
  id,
  missionId: '001-001',
  description: 'fixture task',
  targetFiles: ['src/foo.js'],
});

async function dispatchCatch(pipeline, task, failureType = 'verification', retryCount = 3) {
  try {
    await pipeline._dispatchAnalyzer(task, failureType, retryCount);
    return null;
  } catch (err) {
    return err;
  }
}

// ── Batch fixtures (TC5d construction from test/test-park-foundation.js) ───

const SPEC_MD = `# Test Spec

This is a test spec for the analyzer-closure batch paths.

## Goals
- Build something useful around ORIGINAL-CLAUSE here
`;

const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

function makeGitRoot(prefix = 'cc-orch-anlz-git-') {
  const root = makeTmpRoot(prefix);
  execSync('git init', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed content\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'queue/\narchives/\n.harness/\n');
  execSync('git add -A', { cwd: root, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: root, stdio: 'pipe' });
  return root;
}

function createQueueEntry(root, slug, {
  spec = SPEC_MD,
  // Fresh-run shape: a goal-only entry.plan carries scopeItems:[]/scopeMapping:[]
  // (present-and-empty → gate skips). Absent → legacy fail-close before this
  // test's behavior runs.
  plan = { milestones: [], assumptions: [], scopeItems: [], scopeMapping: [] },
  validatedAt = new Date().toISOString(),
  status = 'pending',
  specJson = SPEC_JSON,
} = {}) {
  writeQueueEntry(root, slug, { spec, plan, validatedAt, status, specJson });
}

function readSceneRaw(root, slug) {
  const p = path.join(root, 'queue', slug, 'park.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const MILESTONE_PLAN = {
  milestones: [{ id: '001', description: 'Halt milestone', missions: [{ id: '001-001', description: 'Mission one' }] }],
  assumptions: [],
  // Scope-free fresh run: present-and-empty scope set so the gate skips.
  // Absent → legacy fail-close.
  scopeItems: [],
  scopeMapping: [],
};

// ── Regression-loop fixture (test-pipeline-milestone-regression-remediation pattern) ──

function createRegressionHarness({ milestoneId = '001', missionId = '001-001' } = {}) {
  const projectRoot = makeTmpRoot('cc-orch-anlz-regr-');
  const harnessDir = path.join(projectRoot, '.harness');
  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  const taskId = `${missionId}-001-001`;
  const subMissionId = `${missionId}-001`;
  fs.writeFileSync(
    path.join(harnessDir, 'progress', `task-${taskId}.json`),
    JSON.stringify({ taskId, status: 'COMPLETE', affectedFiles: [{ path: 'src/foo.js' }], summary: 'done', testsSummary: 'ok' })
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-${taskId}.json`),
    JSON.stringify({ taskId, verified: true, report: 'ok', result: 'PASSED', hardChecks: [], taskScopeChecks: [], notes: null })
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: ['src/foo.js'], hardChecks: [], testCases: [] })
  );
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'foo.js'), '// src/foo.js\n');
  const missionState = {
    id: missionId, missionId, description: `mission ${missionId}`, status: 'complete',
    subMissions: {
      [subMissionId]: {
        id: subMissionId, description: 'sub-mission', status: 'complete',
        tasks: {
          [taskId]: {
            id: taskId, description: `task ${taskId}`, status: 'complete',
            createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
            targetFiles: ['src/foo.js'], dependencies: [], testCases: [], tracesScenario: [],
            patternReferences: [], dataSchemas: [],
            verifyFile: `.harness/verify/task-${taskId}.json`,
            progressFile: `.harness/progress/task-${taskId}.json`,
            verificationFile: `.harness/verification/task-${taskId}.json`,
            retryCount: 0,
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), JSON.stringify(missionState, null, 2));
  const globalState = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId, description: `milestone ${milestoneId}`, status: 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: {
          [missionId]: {
            id: missionId, description: `mission ${missionId}`, status: 'complete',
            stateFile: `.harness/state/mission-${missionId}.json`,
            planFile: `.harness/plan/mission-${missionId}.md`,
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));
  return { projectRoot, harnessDir, milestoneId, missionId, taskId, subMissionId };
}

/**
 * Drive the real milestone-regression remediation loop with: a verifier mock
 * that always fails the regression check (trigger seam), a planner mock with
 * remediateRegressionFailure → { newTasks: [] } (planner seam), an inert
 * executor, and the REAL Analyzer (session seam only).
 */
async function runRegressionLoop(verdictForCall) {
  const fixture = createRegressionHarness();
  const logs = [];
  const confirmCalls = [];
  const pipeline = new Pipeline(fixture.projectRoot, {
    noReview: true,
    statusBar: false,
    skipWorktreeCreation: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async (question) => {
      confirmCalls.push(question);
      return true; // accept the regression-failed gate → loop test never throws there
    },
  });

  const plannerCalls = [];
  // Fail ONLY the milestone-regression check (regression-milestone-* ids) —
  // mission-level regression and any other verifier call passes, so control
  // reaches the milestone-regression remediation loop and nothing else
  // (the established makeVerifierMock pattern from
  // test-pipeline-milestone-regression-remediation.js).
  pipeline.verifier = {
    verifyTask: async (task) => {
      if (task.id && task.id.startsWith('regression-milestone-')) {
        return { verified: false, report: 'FAILED: mock regression failure', structured: { verified: false } };
      }
      return { verified: true, report: 'PASSED', structured: { verified: true } };
    },
  };
  // verifyRegression: the regression gates now call the dedicated method;
  // the mock reuses the same implementation (same id-sniff branches apply).
  pipeline.verifier.verifyRegression = pipeline.verifier.verifyTask;
  const { analyzer, spawnCalls } = makeAnalyzerHarness(verdictForCall);
  pipeline.analyzer = analyzer;
  pipeline.planner = {
    remediateRegressionFailure: async (milestoneId, findings, projectRoot) => {
      plannerCalls.push({ milestoneId, findings, projectRoot });
      return { newTasks: [] };
    },
    closeReusableSession: async () => {},
  };
  pipeline.executor = { executeTask: async () => ({ status: 'COMPLETE', affectedFiles: [] }) };
  pipeline._executeAndVerifyTask = async () => {};

  const globalState = JSON.parse(fs.readFileSync(path.join(activeHarnessDir(fixture.projectRoot), 'state.json'), 'utf8'));
  const msState = globalState.milestones[fixture.milestoneId];

  let thrown = null;
  try {
    await pipeline._executeMilestone(fixture.milestoneId, msState);
  } catch (err) {
    thrown = err;
  }
  return { fixture, logs, confirmCalls, spawnCalls, plannerCalls, thrown };
}

// ═════════════════════════════════════════════════════════════════════════
// TC1a — VALID_QUEUE_STATUSES gains 'halted-analyzer'
// ═════════════════════════════════════════════════════════════════════════

await test("TC1a: VALID_QUEUE_STATUSES includes 'halted-analyzer' (existing statuses preserved)", async () => {
  assert.ok(
    VALID_QUEUE_STATUSES.includes('halted-analyzer'),
    `VALID_QUEUE_STATUSES must include 'halted-analyzer' (got [${VALID_QUEUE_STATUSES.join(', ')}])`
  );
  for (const s of ['pending', 'failed-validation', 'failed-execution', 'failed-test-gate', 'parked', 'halted-review', 'rejected']) {
    assert.ok(VALID_QUEUE_STATUSES.includes(s), `existing status '${s}' must remain registered`);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC1b (AC1) — history file form. RED BASELINE: at today's HEAD no history
// file exists at all — its absence is the discriminating failure.
// Seams stubbed: analyzer LLM session only (direct analyzeFailure calls).
// ═════════════════════════════════════════════════════════════════════════

await test('TC1b (AC1): two analyses → 2-entry top-level-array history-<canonicalId>.json; BOTH per-event files remain; -rp-1 inherits the canonical history; pseudo-ids pass through', async () => {
  const root = makeTmpRoot();
  try {
    const TASK_ID = '001-001-001-001';
    const { analyzer } = makeAnalyzerHarness((n) => verdict({
      recommendation: n === 1 ? 'human' : 're_plan',
      rootCause: `round ${n} root cause`,
      failureType: 'verification',
      affectedTaskIds: ['001-001-001-001'],
    }));

    const a1 = await analyzer.analyzeFailure(
      { taskId: TASK_ID, taskDescription: 'fixture task', failureType: 'verification', retryCount: 3 }, root);
    await tick();
    const a2 = await analyzer.analyzeFailure(
      { taskId: TASK_ID, taskDescription: 'fixture task', failureType: 'verification', retryCount: 3 }, root);

    // BOTH per-event files remain, with the current naming.
    const perEvent = listAnalysisFiles(root).filter((f) => f.startsWith(`gate-failure-${TASK_ID}-`));
    assert.strictEqual(perEvent.length, 2,
      `BOTH per-event gate-failure-<taskId>-<ts>.json files must remain (got ${JSON.stringify(perEvent)})`);

    // THE RED BASELINE: the history file must now exist.
    const history = readHistory(root, TASK_ID);
    assert.ok(history !== null,
      `analysis/history-${TASK_ID}.json must exist after two analyses — at today's HEAD no history file exists at all (analysis dir: ${JSON.stringify(listAnalysisFiles(root))})`);
    assert.notStrictEqual(history, 'UNPARSEABLE', 'the history file must be valid JSON');
    assert.ok(Array.isArray(history),
      `the history file must be a TOP-LEVEL JSON ARRAY (the load-bearing structural shield against detectHaltInfo's flat scan); got ${typeof history}`);
    assert.strictEqual(history.length, 2,
      `two analyses of the same task must yield exactly 2 history entries (got ${history.length})`);

    // Entry shape: { eventId, ts, failureType, recommendation, affectedTaskIds, rootCause, outcome }
    const [e1, e2] = history;
    for (const [i, e] of [e1, e2].entries()) {
      for (const field of ['eventId', 'ts', 'failureType', 'recommendation', 'affectedTaskIds', 'rootCause', 'outcome']) {
        assert.ok(field in e, `history entry ${i} must carry '${field}' (got keys ${Object.keys(e).join(', ')})`);
      }
      assert.ok(!Number.isNaN(new Date(e.ts).getTime()), `entry ${i} ts must be a parseable timestamp (got ${JSON.stringify(e.ts)})`);
      assert.ok(Array.isArray(e.affectedTaskIds), `entry ${i} affectedTaskIds must be an array of ids`);
    }
    assert.strictEqual(e1.eventId, a1.eventId, 'entry 1 must carry the first analysis eventId');
    assert.strictEqual(e2.eventId, a2.eventId, 'entry 2 must carry the second analysis eventId');
    assert.strictEqual(e1.recommendation, 'human', "entry 1 must record the model's verdict ('human')");
    assert.strictEqual(e2.recommendation, 're_plan', "entry 2 must record the model's verdict ('re_plan')");
    assert.strictEqual(e1.failureType, 'verification', "entry 1 failureType must be 'verification'");
    assert.deepStrictEqual([...e1.affectedTaskIds].sort(), ['001-001-001-001'],
      'entry affectedTaskIds must carry the verdict ids (ids only)');
    assert.strictEqual(e1.outcome, null,
      'analyzer.js owns the verdict fields and writes outcome: null — only the pipeline back-fills it (direct analyzeFailure leaves null)');

    // detectHaltInfo pattern shields on the entries themselves.
    const flat = JSON.stringify(history);
    for (const e of history) {
      for (const v of Object.values(e)) {
        if (typeof v === 'string') {
          assert.ok(!v.startsWith('Circuit breaker:'),
            `no history entry text may start with 'Circuit breaker:' (got ${JSON.stringify(v)})`);
        }
      }
      assert.notStrictEqual(e.type, 'circuit-breaker', "no history entry may carry type: 'circuit-breaker'");
    }
    assert.ok(!flat.includes('"type":"circuit-breaker"'), 'the history file must never contain a circuit-breaker type field');

    // canonicalTaskId keying: a -rp-1 replacement appends to the SAME file.
    assert.strictEqual(canonicalTaskId(`${TASK_ID}-rp-1`), TASK_ID, 'sanity: canonicalTaskId strips -rp-N');
    await tick();
    await analyzer.analyzeFailure(
      { taskId: `${TASK_ID}-rp-1`, taskDescription: 'replacement task', failureType: 'verification', retryCount: 3 }, root);
    const afterRp = readHistory(root, TASK_ID);
    assert.ok(Array.isArray(afterRp) && afterRp.length === 3,
      `a -rp-1 replacement's analysis must append to the canonical history (expected 3 entries, got ${JSON.stringify(afterRp && afterRp.length)})`);
    assert.ok(!fs.existsSync(historyPath(root, `${TASK_ID}-rp-1`)),
      'no separate history-<id>-rp-1.json may be created — replacements inherit the original history');

    // Pseudo-ids pass through canonicalization unchanged.
    await tick();
    await analyzer.analyzeFailure(
      { taskId: 'regression-ms-007', taskDescription: 'milestone regression', failureType: 'regression', retryCount: 0 }, root);
    const pseudo = readHistory(root, 'regression-ms-007');
    assert.ok(Array.isArray(pseudo) && pseudo.length === 1,
      `pseudo-id 'regression-ms-007' must key its own history file unchanged (got ${JSON.stringify(pseudo)})`);
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC1c (AC1) — detectHaltInfo unchanged by a populated history file.
// Seams stubbed: analyzer LLM session only. detectHaltInfo is the REAL
// function; history files are real-produced plus one adversarial fixture
// (fixture INPUT at the spec-pinned on-disk location, not a stub).
// ═════════════════════════════════════════════════════════════════════════

await test("TC1c (AC1): detectHaltInfo's result is unchanged by the presence of a populated history file (incl. adversarial nested scan-words)", async () => {
  const root = makeTmpRoot();
  try {
    const TASK_ID = '001-001-001-001';
    const { analyzer } = makeAnalyzerHarness(() => verdict({
      recommendation: 'human',
      rootCause: 'benign root cause text',
      failureType: 'verification',
    }));
    await analyzer.analyzeFailure(
      { taskId: TASK_ID, taskDescription: 'fixture', failureType: 'verification', retryCount: 3 }, root);
    await tick();
    await analyzer.analyzeFailure(
      { taskId: TASK_ID, taskDescription: 'fixture', failureType: 'verification', retryCount: 3 }, root);

    const harnessDir = activeHarnessDir(root);
    const state = { globalStatus: 'active', milestones: {} }; // non-terminal run
    const histPath = historyPath(root, TASK_ID);
    assert.ok(fs.existsSync(histPath),
      "precondition: the real-produced history file must exist (at today's HEAD it does not — feature absent)");

    // Baseline: detectHaltInfo WITHOUT any history files in analysis/.
    const aside = `${histPath}.aside`;
    fs.renameSync(histPath, aside);
    const baseline = detectHaltInfo(harnessDir, state);
    fs.renameSync(aside, histPath);

    // (i) The real-produced populated history file changes nothing.
    const withHistory = detectHaltInfo(harnessDir, state);
    assert.deepStrictEqual(withHistory, baseline,
      `detectHaltInfo must be unchanged by the populated history file (baseline ${JSON.stringify(baseline)}, with-history ${JSON.stringify(withHistory)})`);

    // (ii) Adversarial fixture history (top-level array, nested entry text
    // carrying every scan word + the pipeline's escalation outcome wording)
    // still changes nothing — the flat Object.values scan never sees nested
    // entry strings.
    const adversarial = [
      {
        eventId: 'gate-failure-999-001-001-001-1',
        ts: new Date().toISOString(),
        failureType: 'regression',
        recommendation: 'human',
        affectedTaskIds: ['999-001-001-001'],
        rootCause: 'the milestone regression failed badly and the reviewer gate failed too',
        outcome: 'escalated: breaker thrown (rec=human)',
      },
    ];
    const advPath = path.join(harnessDir, 'analysis', 'history-999-001-001-001.json');
    fs.writeFileSync(advPath, JSON.stringify(adversarial, null, 2));
    const withAdversarial = detectHaltInfo(harnessDir, state);
    assert.deepStrictEqual(withAdversarial, baseline,
      `detectHaltInfo must be unchanged by an adversarial history file whose NESTED text carries scan words ('regression failed', 'reviewer gate failed') — the top-level-array shield is load-bearing (baseline ${JSON.stringify(baseline)}, got ${JSON.stringify(withAdversarial)})`);
    fs.unlinkSync(advPath);

    // Control: prove the scan is live (the assertions above are not vacuous):
    // a FLAT analysis file carrying a halt pattern must flip the result.
    const controlPath = path.join(harnessDir, 'analysis', 'zz-control-halt.json');
    fs.writeFileSync(controlPath, JSON.stringify({ type: 'circuit-breaker', taskId: TASK_ID }));
    const withControl = detectHaltInfo(harnessDir, state);
    assert.strictEqual(withControl?.haltReason, 'circuit-breaker',
      `control: a flat type:'circuit-breaker' analysis file must be detected (got ${JSON.stringify(withControl)}) — otherwise this case proves nothing`);
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC2a (AC2) — GUARD: no history → prompt byte-identical to today's at an
// unchanged site / default allowedRecommendations; schema keeps all verbs.
// Seams stubbed: analyzer LLM session only.
// ═════════════════════════════════════════════════════════════════════════

await test('TC2a (AC2): with no history the analyzer prompt is byte-identical to today\'s (default allowedRecommendations); schema enum keeps all three verbs', async () => {
  const root = makeTmpRoot();
  try {
    const { analyzer, spawnCalls } = makeAnalyzerHarness(() => verdict({ recommendation: 'human' }));
    const opts = { taskId: '001-001-001-001', taskDescription: 'Fixture task description', failureType: 'verification', retryCount: 2 };
    const analysis = await analyzer.analyzeFailure(opts, root);

    assert.strictEqual(spawnCalls.length, 1, 'exactly one session must be spawned');
    const call = spawnCalls[0];

    const expected = expectedBaselinePrompt({
      ...opts, eventId: analysis.eventId, projectRoot: root,
    });
    assert.strictEqual(call.prompt, expected,
      'with NO history file the analyzer user prompt must be byte-identical to today\'s prompt at the default allowedRecommendations');
    assert.strictEqual(call.systemPrompt, EXPECTED_BASELINE_SYSTEM_PROMPT,
      'with NO history the system prompt must also be byte-identical to today\'s (unchanged-site behavior is byte-identical)');
    assert.deepStrictEqual(
      call.jsonSchema?.properties?.recommendation?.enum,
      ['retry', 're_plan', 'human'],
      `the default-site session schema enum must keep exactly ['retry','re_plan','human'] (got ${JSON.stringify(call.jsonSchema?.properties?.recommendation?.enum)})`
    );
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC2b (AC2) — history present → prior round's recommendation/outcome are
// injected into the next prompt (with eventId provenance + do-not-repeat
// rule). The outcome is back-filled by the PIPELINE on the breaker throw.
// Seams stubbed: analyzer LLM session; real Pipeline._dispatchAnalyzer.
// Round-2 verdict uses a DIFFERENT affected set so repeat escalation cannot
// confound the injection assertions.
// ═════════════════════════════════════════════════════════════════════════

await test('TC2b (AC2): with history present the round-2 prompt carries the prior recommendation, back-filled outcome, eventId provenance, rootCause line, and the do-not-repeat rule', async () => {
  const { projectRoot } = createPipelineHarness();
  try {
    const { pipeline, spawnCalls } = makeDispatchPipeline(projectRoot, (n) => verdict({
      recommendation: 'human',
      rootCause: n === 1 ? 'ROOT-CAUSE-R1 the fixture exploded' : 'ROOT-CAUSE-R2 different shape',
      failureType: 'verification',
      affectedTaskIds: n === 1 ? [] : ['001-001-001-001'], // different sets → NOT a repeat
    }));

    // Round 1 — human verdict → breaker throw; the pipeline must back-fill
    // the history entry's outcome.
    const err1 = await dispatchCatch(pipeline, taskFixture());
    assert.ok(err1, 'round 1 (human) must throw the circuit breaker');
    assert.ok(err1.message.startsWith('Circuit breaker:'), `round-1 throw must keep the 'Circuit breaker:' prefix (got: ${err1.message})`);

    const hist1 = readHistory(projectRoot, '001-001-001-001');
    assert.ok(Array.isArray(hist1) && hist1.length === 1,
      `after round 1 the history file must hold 1 entry — at today's HEAD no history file exists (got ${JSON.stringify(hist1)})`);
    assert.strictEqual(hist1[0].recommendation, 'human', 'the history entry keeps the model verdict');
    assert.ok(typeof hist1[0].outcome === 'string' && /escalated/.test(hist1[0].outcome),
      `the PIPELINE must back-fill the throw outcome as an 'escalated…' note (got ${JSON.stringify(hist1[0].outcome)})`);
    assert.ok(/human/.test(hist1[0].outcome),
      `the escalation outcome must name the model's original recommendation (got ${JSON.stringify(hist1[0].outcome)})`);
    assert.ok(!hist1[0].outcome.startsWith('Circuit breaker:'),
      "the outcome wording must NOT start with 'Circuit breaker:' (detectHaltInfo pattern)");
    assert.ok(!/regression failed/i.test(hist1[0].outcome),
      "the outcome wording must NOT contain 'regression failed' (detectHaltInfo pattern)");

    // Round-1 prompt must carry NO injection (no history existed yet).
    assert.ok(!/escalated/.test(spawnCalls[0].prompt) && !/repeat/i.test(spawnCalls[0].prompt),
      'the round-1 prompt must carry no history injection');

    // Round 2 — different affected set (no repeat); prompt must carry the
    // injected prior round.
    await tick();
    const err2 = await dispatchCatch(pipeline, taskFixture());
    assert.ok(err2, 'round 2 must still throw (human verdict)');
    assert.notStrictEqual(err2.escalatedByRepeat, true,
      'a verdict with a DIFFERENT affected set is not a repeat — escalatedByRepeat must not be set');

    assert.strictEqual(spawnCalls.length, 2, 'two analyzer sessions must have been spawned');
    const prompt2 = spawnCalls[1].prompt;
    assert.ok(prompt2.includes(hist1[0].eventId),
      `the round-2 prompt must annotate the injected round with its eventId for provenance (missing ${hist1[0].eventId})`);
    assert.ok(prompt2.includes('ROOT-CAUSE-R1'),
      'the round-2 prompt must carry the prior round\'s one-line rootCause');
    assert.ok(/human/.test(prompt2) && /escalated/.test(prompt2),
      'the round-2 prompt must contain the prior round\'s recommendation and outcome');
    assert.ok(/repeat/i.test(prompt2),
      'the round-2 prompt must carry the behavioral rule (same failure shape persists → do not repeat — escalate)');
  } finally {
    cleanup(projectRoot);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC3a (AC3) — task-site narrowing: schema enum excludes 'retry', prompt
// omits the retry rule line and notes the exhausted retry budget.
// Seams stubbed: analyzer LLM session; real Pipeline._dispatchAnalyzer.
// RED at HEAD: today the task site spawns with all three verbs and the
// retry rule line present.
// ═════════════════════════════════════════════════════════════════════════

await test("TC3a (AC3): the task circuit-breaker site narrows to ['re_plan','human'] — schema excludes 'retry', prompt omits the retry rule and notes the exhausted budget", async () => {
  const { projectRoot } = createPipelineHarness();
  try {
    const { pipeline, spawnCalls } = makeDispatchPipeline(projectRoot, () => verdict({ recommendation: 'human' }));
    await dispatchCatch(pipeline, taskFixture(), 'verification', 3);

    assert.strictEqual(spawnCalls.length, 1, 'one analyzer session must be spawned at the task site');
    const call = spawnCalls[0];
    const enumList = call.jsonSchema?.properties?.recommendation?.enum;
    assert.deepStrictEqual(enumList, ['re_plan', 'human'],
      `the task site's session schema recommendation enum must be exactly ['re_plan','human'] — 'retry' is schema-excluded (got ${JSON.stringify(enumList)})`);
    assert.ok(!call.prompt.includes(RETRY_RULE_LINE),
      'the task-site prompt must omit the retry rule line (the retry budget is exhausted at this site)');
    assert.ok(!/^- retry:/m.test(call.prompt),
      'no retry rule line of any wording may render at the task site');
    assert.ok(/budget|exhaust/i.test(call.prompt),
      `the task-site prompt must note that the retry budget is exhausted (prompt: …${call.prompt.slice(-400)})`);
    // The two allowed verbs' rule lines still render.
    assert.ok(/re_plan/.test(call.prompt) && /human/.test(call.prompt),
      'the allowed verbs (re_plan / human) must still be present in the task-site prompt');
  } finally {
    cleanup(projectRoot);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC4 (AC4) — isRepeatVerdict pure-function matrix. New-symbol-only case:
// fails with an explicit "not exported" message at pre-feature HEAD.
// Nothing stubbed (pure function under test).
// Encoded assumption: the comparator reads the recommendation plus the
// affected id set; probe objects carry the ids under BOTH spec names
// (history `affectedTaskIds` and analysis `affectedTasks` as plain id
// arrays) so either reading is exercised identically.
// ═════════════════════════════════════════════════════════════════════════

await test('TC4 (AC4): isRepeatVerdict — order-insensitive id-set equality AND same recommendation; false on any difference', async () => {
  const isRepeatVerdict = await loadIsRepeatVerdict();
  assert.ok(typeof isRepeatVerdict === 'function',
    'isRepeatVerdict must be an exported pure function (analyzer.js or a small core module) — not found at this HEAD (feature absent)');

  const v = (recommendation, ids) => ({
    recommendation,
    affectedTaskIds: [...ids],
    affectedTasks: [...ids],
  });

  // True: exact repeat.
  assert.strictEqual(isRepeatVerdict(v('re_plan', ['001-001-001-001', '001-001-001-002']), v('re_plan', ['001-001-001-001', '001-001-001-002'])), true,
    'same recommendation + same ids (same order) must be a repeat');
  // True: order-insensitive.
  assert.strictEqual(isRepeatVerdict(v('re_plan', ['001-001-001-001', '001-001-001-002']), v('re_plan', ['001-001-001-002', '001-001-001-001'])), true,
    'id ORDER must not matter (order-insensitive set comparison)');
  // True: both empty sets.
  assert.strictEqual(isRepeatVerdict(v('human', []), v('human', [])), true,
    'same recommendation with two empty affected sets is an exact repeat');
  // True: duplicate ids collapse (set semantics, ids only).
  assert.strictEqual(isRepeatVerdict(v('human', ['001-001-001-001', '001-001-001-001', '001-001-001-002']), v('human', ['001-001-001-002', '001-001-001-001'])), true,
    'duplicate ids must collapse — the contract is a SET of ids');

  // False: recommendation differs.
  assert.strictEqual(isRepeatVerdict(v('re_plan', ['001-001-001-001']), v('human', ['001-001-001-001'])), false,
    'a different recommendation is never a repeat, even with identical ids');
  // False: id set differs (subset).
  assert.strictEqual(isRepeatVerdict(v('re_plan', ['001-001-001-001', '001-001-001-002']), v('re_plan', ['001-001-001-001'])), false,
    'a strict subset of ids is not a repeat');
  // False: id set differs (superset).
  assert.strictEqual(isRepeatVerdict(v('re_plan', ['001-001-001-001']), v('re_plan', ['001-001-001-001', '001-001-001-002'])), false,
    'a strict superset of ids is not a repeat');
  // False: disjoint ids.
  assert.strictEqual(isRepeatVerdict(v('human', ['001-001-001-001']), v('human', ['001-001-001-002'])), false,
    'disjoint id sets are not a repeat');
  // False: empty vs non-empty.
  assert.strictEqual(isRepeatVerdict(v('human', []), v('human', ['001-001-001-001'])), false,
    'an empty prior set vs a non-empty current set is not a repeat');
});

// ═════════════════════════════════════════════════════════════════════════
// TC5a (AC5) — repeat escalation at the task site (human verdict twice).
// Seams stubbed: analyzer LLM session; real _dispatchAnalyzer, real history
// persistence, real comparator wiring.
// RED at HEAD: today the second throw is a plain Error with no
// escalatedByRepeat marker.
// ═════════════════════════════════════════════════════════════════════════

await test('TC5a (AC5): a second identical verdict at the task site escalates — CircuitBreakerError with escalatedByRepeat=true, loud log, prefix kept; never on the first round', async () => {
  const { projectRoot } = createPipelineHarness();
  try {
    const { pipeline, logs } = makeDispatchPipeline(projectRoot, () => verdict({
      recommendation: 'human',
      rootCause: 'identical failure shape',
      failureType: 'verification',
      affectedTaskIds: ['001-001-001-001'],
    }));

    // Round 1 — first analysis: the repeat detector must NEVER fire.
    const err1 = await dispatchCatch(pipeline, taskFixture());
    assert.ok(err1, 'round 1 must throw the circuit breaker (human verdict)');
    assert.ok(err1.message.startsWith('Circuit breaker:'), `round-1 message must keep the prefix (got: ${err1.message})`);
    assert.notStrictEqual(err1.escalatedByRepeat, true,
      'the repeat detector fires only from round 2 onward — NEVER on the first analysis');

    // Round 2 — identical verdict (same recommendation, same id set).
    await tick();
    const err2 = await dispatchCatch(pipeline, taskFixture());
    assert.ok(err2, 'round 2 must throw');
    assert.strictEqual(err2.escalatedByRepeat, true,
      `the second identical verdict must escalate by repeat (CircuitBreakerError.escalatedByRepeat === true; got ${JSON.stringify(err2.escalatedByRepeat)} on: ${err2.message})`);
    assert.ok(err2.message.startsWith('Circuit breaker:'),
      `the escalated throw must keep the 'Circuit breaker:' prefix — existing catches match on it (got: ${err2.message})`);
    assert.strictEqual(err2.taskId, '001-001-001-001', 'the error must carry taskId');
    assert.ok(typeof err2.eventId === 'string' && err2.eventId.length > 0, 'the error must carry the eventId');

    const CircuitBreakerError = await loadCircuitBreakerError();
    if (CircuitBreakerError) {
      assert.ok(err2 instanceof CircuitBreakerError,
        'the escalated throw must be a CircuitBreakerError from src/orchestrator/core/circuit-breaker-error.js');
    }

    // Loud log.
    assert.ok(logs.some((l) => /repeat/i.test(l)),
      `the repeat escalation must log loudly (no log line mentions a repeat; logs: ${JSON.stringify(logs.slice(-8))})`);

    // History: 2 entries, both keeping the MODEL's verdicts; escalation only
    // in the outcome.
    const hist = readHistory(projectRoot, '001-001-001-001');
    assert.ok(Array.isArray(hist) && hist.length === 2,
      `history must hold 2 entries after the two rounds (got ${JSON.stringify(hist)})`);
    assert.strictEqual(hist[1].recommendation, 'human',
      "the repeat-escalated round records the model's ORIGINAL recommendation");
    assert.ok(typeof hist[1].outcome === 'string' && /escalated/.test(hist[1].outcome),
      `the escalation is noted only in the outcome (got ${JSON.stringify(hist[1].outcome)})`);
  } finally {
    cleanup(projectRoot);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC5b (AC5) — repeat escalation regardless of the current recommendation:
// a consumed re_plan (REAL scheduler.replaceTask) followed by the identical
// re_plan verdict on the replacement task must escalate instead of
// re-consuming. Also pins the pipeline's 'replaced with [ids]' outcome
// back-fill and the comparator's canonical-id keying across -rp-N.
// Seams stubbed: analyzer LLM session + planner.replanTask (planner seam).
// scheduler.replaceTask is REAL, operating on a directly-populated DAG
// (test-scheduler-replace-task.js pattern).
// RED at HEAD: history absent; the round-2 identical re_plan is consumed
// AGAIN (replanTask called twice, no escalation).
// ═════════════════════════════════════════════════════════════════════════

await test("TC5b (AC5): a repeated re_plan verdict escalates instead of re-consuming — replanTask not called again; history keeps original 're_plan' with 'replaced with [ids]' / 'escalated' outcomes", async () => {
  const { projectRoot } = createPipelineHarness({
    tasks: [{ id: '001-001-001-001', status: 'failed', targetFiles: ['src/foo.js'] }],
  });
  try {
    const { pipeline, replanCalls } = makeDispatchPipeline(projectRoot, () => verdict({
      recommendation: 're_plan',
      rootCause: 'task decomposition is wrong',
      failureType: 'verification',
      affectedTaskIds: ['001-001-001-001'],
    }), {
      replanResult: (n) => ({
        replacementTasks: [{
          id: `001-001-001-001-rp-00${n}`,
          description: 'replacement task',
          targetFiles: ['src/foo.js'],
          dependencies: [],
        }],
      }),
    });

    // Populate the live DAG so the REAL scheduler.replaceTask can operate.
    const schedTask = { id: '001-001-001-001', missionId: '001-001', subMissionId: '001-001-001', targetFiles: ['src/foo.js'], dependencies: [] };
    pipeline.scheduler._tasksById = new Map([[schedTask.id, schedTask]]);
    pipeline.scheduler._pending = new Set([schedTask.id]);
    pipeline.scheduler._runningFiles = new Set();

    // Round 1 — re_plan is CONSUMED (real DAG surgery): no throw.
    const err1 = await dispatchCatch(pipeline, taskFixture());
    assert.strictEqual(err1, null,
      `round 1 re_plan must be consumed without throwing (real replaceTask); got: ${err1 && err1.message}`);
    assert.strictEqual(replanCalls.length, 1, 'planner.replanTask must run once in round 1');

    const hist1 = readHistory(projectRoot, '001-001-001-001');
    assert.ok(Array.isArray(hist1) && hist1.length === 1,
      `round 1 must append a history entry — at today's HEAD no history file exists (got ${JSON.stringify(hist1)})`);
    assert.strictEqual(hist1[0].recommendation, 're_plan', 'entry 1 records the re_plan verdict');
    assert.ok(typeof hist1[0].outcome === 'string' && /replaced with/.test(hist1[0].outcome) && /-rp-001/.test(hist1[0].outcome),
      `the pipeline must back-fill the re_plan success outcome as 'replaced with [ids]' naming the replacement ids (got ${JSON.stringify(hist1[0].outcome)})`);

    // Round 2 — the REPLACEMENT task fails the same way; the model repeats
    // the identical re_plan verdict (same rec, same id set). The repeat
    // detector must escalate REGARDLESS of the current recommendation —
    // no second consumption.
    await tick();
    const err2 = await dispatchCatch(pipeline, taskFixture('001-001-001-001-rp-001'));
    assert.ok(err2,
      'the second identical re_plan verdict must throw (escalate to human) instead of being consumed again');
    assert.strictEqual(err2.escalatedByRepeat, true,
      `the repeat escalation must mark escalatedByRepeat=true regardless of the current recommendation (got ${JSON.stringify(err2.escalatedByRepeat)} on: ${err2.message})`);
    assert.ok(err2.message.startsWith('Circuit breaker:'), `prefix must be kept (got: ${err2.message})`);
    assert.strictEqual(replanCalls.length, 1,
      `the repeated re_plan must NOT be consumed again — planner.replanTask must not run a second time (got ${replanCalls.length} call(s))`);

    // History: keyed by canonicalTaskId — the -rp-001 round lands in the
    // SAME file; the entry keeps the model's ORIGINAL 're_plan'.
    const hist2 = readHistory(projectRoot, '001-001-001-001');
    assert.ok(Array.isArray(hist2) && hist2.length === 2,
      `both rounds must live in the canonical history file (got ${JSON.stringify(hist2 && hist2.length)})`);
    assert.strictEqual(hist2[1].recommendation, 're_plan',
      "the repeat-escalated round records the model's ORIGINAL recommendation ('re_plan'), NOT 'human' — post-requeue comparisons stay model-vs-model");
    assert.ok(typeof hist2[1].outcome === 'string' && /escalated/.test(hist2[1].outcome) && /re_plan/.test(hist2[1].outcome),
      `the escalation lives only in the outcome and names the original recommendation (got ${JSON.stringify(hist2[1].outcome)})`);
  } finally {
    cleanup(projectRoot);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC6a (AC5) — batch: repeat-escalated human → 'halted-analyzer' + minimal
// scene through the REAL forensic-archive chain; entry ends complete and
// resolvable; batch continues.
// Fixture: TC5d construction from test/test-park-foundation.js — git root,
// real pending milestone, NO archive injection.
// Seams stubbed: analyzer LLM session; executor trigger
// (_executeAllMilestones drives the real _dispatchAnalyzer and dirties the
// tree so the revert is observable); planner seams (verifyAssumptions /
// remediateAssumption / reExtractAssumptions); _reviewGate no-op.
// REAL: batchResume, _dispatchAnalyzer, history persistence, repeat
// comparator, park layer, forensic archive.
// RED at HEAD: the breaker is a plain Error → 'failed-execution', no scene.
// ═════════════════════════════════════════════════════════════════════════

await test("TC6a (AC5): batch repeat-escalated human → status 'halted-analyzer' + minimal scene (site 'analyzer-human') through the REAL forensic-archive chain; entry complete; batch continues", async () => {
  const root = makeGitRoot();
  try {
    const priorRequeue = { action: 'requeue', at: '2026-06-08T00:00:00.000Z', note: 'earlier requeue', consumedAt: null };
    const consumedWaive = { action: 'waive', at: '2026-06-09T00:00:00.000Z', note: 'earlier waive', consumedAt: '2026-06-09T01:00:00.000Z' };

    createQueueEntry(root, 'halt-analyzer', {
      plan: MILESTONE_PLAN,
      validatedAt: '2026-06-01T00:00:00.000Z',
    });
    // Pre-existing park history (fixture INPUT at the spec-pinned location):
    // must survive the minimal-scene write via read-existing-then-append.
    fs.writeFileSync(
      path.join(root, 'queue', 'halt-analyzer', 'park.json'),
      JSON.stringify({
        site: 'assumption-gate', parkedAt: '2026-06-09T00:00:00.000Z',
        round1: [], round2: null, appliedSpecEdits: [], questions: ['OLD-QUESTION'],
        previousResolutions: [priorRequeue], resolution: consumedWaive,
      }, null, 2)
    );
    // PARK TRIGGER for the second entry switched to failed-after-remediation
    // (an uncertain no longer parks): 'continue-after' must still reach a
    // legitimate terminal park state to prove it was PROCESSED after the halt.
    // round-1 fails → remediation → round-2 still fails → it parks at the
    // assumption gate, BEFORE execution (so execCount stays 1 and the
    // halted-analyzer entry is the only one to reach _executeAllMilestones).
    // The SUBJECT (the batch CONTINUES past the halted-analyzer halt to the
    // next entry) is unchanged.
    createQueueEntry(root, 'continue-after', {
      plan: { milestones: [], assumptions: [{ text: 'CONTINUE-FAILED', phase: 'pre', specSection: 'Goals' }] },
      validatedAt: '2026-06-02T00:00:00.000Z',
    });

    const logs = [];
    // NO `archive` injection: the real forensic-archive chain must run.
    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      statusBar: false,
      onLog: (msg) => logs.push(msg),
      onConfirm: async () => true,
    });
    const { analyzer } = makeAnalyzerHarness(() => verdict({
      recommendation: 'human',
      rootCause: 'BATCH-ROOT-CAUSE the executor produced nothing',
      failureType: 'verification',
      affectedTaskIds: [],
      evidence: 'BATCH-EVIDENCE verifier sidecar empty twice',
    }));
    pipeline.analyzer = analyzer;
    pipeline.planner.verifyAssumptions = async (assumptions) =>
      (assumptions || []).map((a) => {
        const text = a?.text ?? a;
        const status = (text === 'CONTINUE-FAILED' || text === 'CONTINUE-REVISED') ? 'failed' : 'verified';
        return { assumption: a, status, evidence: 'stub' };
      });
    pipeline.planner.remediateAssumption = async () => ({
      specEdit: { old: 'ORIGINAL-CLAUSE', new: 'REMEDIATED-CLAUSE', section: 'Goals' },
      revisedAssumptions: [{ text: 'CONTINUE-REVISED', phase: 'pre', specSection: 'Goals' }],
    });
    pipeline.planner.reExtractAssumptions = async () => [{ text: 'CONTINUE-REVISED', phase: 'pre', specSection: 'Goals' }];
    pipeline.planner.closeReusableSession = async () => {};
    pipeline._reviewGate = async () => {};

    const TASK = taskFixture(); // 001-001-001-001
    let execCount = 0;
    pipeline._executeAllMilestones = async () => {
      execCount++;
      // Dirty the tracked tree so the (unchanged) revert is observable.
      fs.writeFileSync(path.join(root, 'seed.txt'), 'CONTAMINATED\n');
      // First identical verdict: a normal breaker (swallowed — in the live
      // flow this is the prior round of the same canonical task).
      try {
        await pipeline._dispatchAnalyzer(TASK, 'verification', 3);
      } catch { /* expected first breaker */ }
      await tick();
      // Second identical verdict: must escalate by repeat and propagate.
      await pipeline._dispatchAnalyzer(TASK, 'verification', 3);
      throw new Error('fixture: the second identical verdict must throw out of _dispatchAnalyzer');
    };

    await pipeline.batchResume({});

    // Fixture sanity: the REAL forensic archive ran exactly once (entry 2
    // parks pre-execution and produces no archive).
    const archivesDir = path.join(root, 'archives');
    const failedDirs = fs.existsSync(archivesDir)
      ? fs.readdirSync(archivesDir).filter((d) => d.startsWith('failed-'))
      : [];
    assert.strictEqual(failedDirs.length, 1,
      `fixture: the real forensic archive must run exactly once in the halt path (found ${JSON.stringify(failedDirs)}; archive logs: ${logs.filter((l) => l.toLowerCase().includes('archive')).join(' | ') || '(none)'})`);
    const failedDir = path.join(archivesDir, failedDirs[0]);
    assert.ok(fs.existsSync(path.join(failedDir, 'manifest.json')), 'fixture: the forensic archive must contain manifest.json');
    assert.ok(fs.existsSync(path.join(failedDir, 'spec.md')), 'fixture: the forensic archive must contain its own spec.md copy');
    assert.strictEqual(execCount, 1, 'fixture: only the halt entry may reach execution');

    // THE classification: 'halted-analyzer', not 'failed-execution'.
    const statusOnDisk = fs.readFileSync(path.join(root, 'queue', 'halt-analyzer', 'status'), 'utf8').trim();
    assert.strictEqual(statusOnDisk, 'halted-analyzer',
      `a batch CircuitBreakerError with recommendation human (incl. repeat-escalated) must be labeled 'halted-analyzer' (got '${statusOnDisk}' — at today's HEAD it is conflated into 'failed-execution')`);

    // Minimal scene: site 'analyzer-human', parkedAt, questions carrying
    // rootCause/evidence + the eventId pointer.
    const scene = readSceneRaw(root, 'halt-analyzer');
    assert.ok(scene, 'queue/halt-analyzer/park.json must exist with a parseable scene');
    assert.strictEqual(scene.site, 'analyzer-human',
      `scene.site must be 'analyzer-human' (the park-site discriminator), got '${scene.site}'`);
    assert.ok(scene.parkedAt && !Number.isNaN(new Date(scene.parkedAt).getTime()),
      `scene.parkedAt must be a parseable timestamp (got ${JSON.stringify(scene.parkedAt)})`);
    assert.ok(Array.isArray(scene.questions) && scene.questions.length > 0,
      'scene.questions must be a non-empty array');
    const questionsBlob = JSON.stringify(scene.questions);
    assert.ok(questionsBlob.includes('BATCH-ROOT-CAUSE'), 'scene.questions must carry the analyzer rootCause');
    assert.ok(questionsBlob.includes('BATCH-EVIDENCE'), 'scene.questions must carry the analyzer evidence');
    assert.ok(/gate-failure-001-001-001-001-\d+/.test(questionsBlob),
      `scene.questions must carry the eventId pointer to the analysis (got ${questionsBlob.slice(0, 300)})`);

    // Read-existing-then-append: prior park history survives.
    assert.ok(Array.isArray(scene.previousResolutions) && scene.previousResolutions.length === 2,
      `the prior previousResolutions + consumed waive must survive the halted-analyzer scene write (got ${JSON.stringify(scene.previousResolutions)})`);
    assert.strictEqual(scene.previousResolutions[0].action, 'requeue', 'prior chain preserved first');
    assert.strictEqual(scene.previousResolutions[1].action, 'waive', 'the prior scene resolution must be appended');
    assert.strictEqual(scene.resolution, null, 'the fresh halted-analyzer scene is unresolved');

    // Revert unchanged: tracked file restored, tree clean.
    assert.strictEqual(fs.readFileSync(path.join(root, 'seed.txt'), 'utf8'), 'seed content\n',
      'the working-tree revert must still run on the halted-analyzer path (revert behavior unchanged)');
    const porcelain = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).trim();
    assert.strictEqual(porcelain, '', `working tree must be clean after the halted-analyzer revert (got: ${porcelain})`);

    // The entry ends the pass COMPLETE and resolvable (the forensic archive
    // preserves the queue spec files — preserve is unconditional for batch).
    const entryDir = path.join(root, 'queue', 'halt-analyzer');
    for (const f of ['spec.md', 'spec.json', 'plan.json', 'status', 'park.json']) {
      assert.ok(fs.existsSync(path.join(entryDir, f)),
        `the entry must end the pass complete: queue/halt-analyzer/${f} must be present`);
    }
    const entry = readQueueEntry(root, 'halt-analyzer');
    assert.ok(entry, 'readQueueEntry must succeed on the post-halt entry (resolvable, no ENOENT)');
    assert.strictEqual(entry.status, 'halted-analyzer', 'readQueueEntry must report halted-analyzer');
    assert.strictEqual(entry.spec, SPEC_MD, 'the queue spec.md must round-trip intact');
    assert.strictEqual(entry.specJson, SPEC_JSON, 'the queue spec.json must round-trip intact');

    // Batch continues: the second entry was processed (parked pre-execution
    // via failed-after-remediation at the assumption gate).
    const continueStatus = fs.readFileSync(path.join(root, 'queue', 'continue-after', 'status'), 'utf8').trim();
    assert.strictEqual(continueStatus, 'parked',
      `the batch must continue to the next entry after the halt (entry 'continue-after' expected 'parked', got '${continueStatus}')`);
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC6b (AC6) — GUARD: batch CircuitBreakerError with a non-human
// (re_plan-fallthrough) recommendation keeps today's failed-execution.
// Seams stubbed: analyzer LLM session; executor trigger; planner seams
// (replanTask returns empty → the re_plan branch falls through to the
// breaker throw). REAL: batchResume, forensic archive (no injection),
// park layer (must NOT engage).
// ═════════════════════════════════════════════════════════════════════════

await test("TC6b (AC6): batch CircuitBreakerError with a non-human (re_plan-fallthrough) recommendation keeps today's 'failed-execution' — no park scene", async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'fail-replan', {
      plan: MILESTONE_PLAN,
      validatedAt: '2026-06-01T00:00:00.000Z',
    });

    const logs = [];
    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      statusBar: false,
      onLog: (msg) => logs.push(msg),
      onConfirm: async () => true,
    });
    const { analyzer } = makeAnalyzerHarness(() => verdict({
      recommendation: 're_plan',
      rootCause: 'unfixable decomposition',
      failureType: 'verification',
      affectedTaskIds: [],
    }));
    pipeline.analyzer = analyzer;
    pipeline.planner.verifyAssumptions = async () => [];
    pipeline.planner.remediateAssumption = async () => ({ specEdit: { old: '', new: '' }, revisedAssumptions: [] });
    pipeline.planner.reExtractAssumptions = async () => [];
    pipeline.planner.replanTask = async () => ({ replacementTasks: [] }); // → fall through to the breaker
    pipeline.planner.closeReusableSession = async () => {};
    pipeline._reviewGate = async () => {};
    pipeline._executeAllMilestones = async () => {
      await pipeline._dispatchAnalyzer(taskFixture(), 'verification', 3);
      throw new Error('fixture: the re_plan fallthrough must throw out of _dispatchAnalyzer');
    };

    const result = await pipeline.batchResume({});

    const statusOnDisk = fs.readFileSync(path.join(root, 'queue', 'fail-replan', 'status'), 'utf8').trim();
    assert.strictEqual(statusOnDisk, 'failed-execution',
      `a non-human breaker keeps today's 'failed-execution' handling (got '${statusOnDisk}')`);
    assert.strictEqual(readSceneRaw(root, 'fail-replan'), null,
      'no park.json may be written for a non-human breaker');
    assert.strictEqual(result.failed, 1, `expected failed:1, got ${result.failed}`);

    // Preserve stays unconditional: the failed entry keeps its spec files.
    assert.ok(fs.existsSync(path.join(root, 'queue', 'fail-replan', 'spec.md')),
      'the failed-execution entry must keep spec.md (preserve is unconditional for batch)');
    assert.ok(fs.existsSync(path.join(root, 'queue', 'fail-replan', 'spec.json')),
      'the failed-execution entry must keep spec.json');
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC6c (AC6) — GUARD: single-run human keeps today's throw (prefix kept,
// no repeat marker on a first round).
// Seams stubbed: analyzer LLM session only; real _dispatchAnalyzer.
// ═════════════════════════════════════════════════════════════════════════

await test("TC6c (AC6): single-run human keeps today's throw — 'Circuit breaker:' prefix, no escalatedByRepeat on a first round", async () => {
  const { projectRoot } = createPipelineHarness();
  try {
    const { pipeline } = makeDispatchPipeline(projectRoot, () => verdict({ recommendation: 'human' }));
    const err = await dispatchCatch(pipeline, taskFixture(), 'verification', 1);
    assert.ok(err, 'a human recommendation must throw at the task site');
    assert.ok(err.message.startsWith('Circuit breaker:'),
      `the throw must keep the 'Circuit breaker:' prefix — existing catches match on it (got: ${err.message})`);
    assert.notStrictEqual(err.escalatedByRepeat, true,
      'a first-round human verdict is NOT a repeat escalation');
  } finally {
    cleanup(projectRoot);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC7a (AC7) — milestone-regression loop: two consecutive identical
// analyses break early to the existing regression-failed gate.
// Seams stubbed: analyzer LLM session; verifier trigger (regression always
// fails); planner seam (remediateRegressionFailure → no tasks); executor
// seam (_executeAndVerifyTask no-op). The loop itself is real.
// RED at HEAD: the loop blindly burns all 3 iterations (3 sessions,
// 3 remediation passes).
// ═════════════════════════════════════════════════════════════════════════

await test('TC7a (AC7): two consecutive identical regression analyses break to the regression-failed gate before the fixed cap (2 sessions, 1 remediation pass)', async () => {
  const { fixture, confirmCalls, spawnCalls, plannerCalls, thrown } = await runRegressionLoop(() => verdict({
    recommendation: 'retry',
    rootCause: 'REGRESSION-ROOT same shape every time',
    failureType: 'regression',
    affectedTaskIds: ['001-001-001-001'],
  }));
  try {
    assert.strictEqual(thrown, null,
      `the early break must arrive at the EXISTING regression-failed gate (accepted by the confirm stub), not a new throw (got: ${thrown && thrown.message})`);
    assert.strictEqual(spawnCalls.length, 2,
      `two consecutive identical analyses must stop the loop — exactly 2 analyzer sessions (got ${spawnCalls.length}; at today's HEAD the loop blindly burns all ${3} iterations)`);
    assert.strictEqual(plannerCalls.length, 1,
      `the repeated verdict must break BEFORE another remediation pass — remediateRegressionFailure runs once (got ${plannerCalls.length})`);
    const gateQuestion = confirmCalls.find((q) => /regression/i.test(q));
    assert.ok(gateQuestion,
      `the early break must exit through the existing regression-failed gate (no regression confirm asked; calls: ${JSON.stringify(confirmCalls)})`);
  } finally {
    cleanup(fixture.projectRoot);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC7b (AC7 + AC3 unchanged-site) — GUARD: distinct consecutive analyses
// let the loop run to the cap; the regression site keeps all three verbs.
// Seams stubbed: same set as TC7a.
// ═════════════════════════════════════════════════════════════════════════

await test('TC7b (AC7/AC3): distinct consecutive analyses run the loop to the cap (3 sessions, 3 passes); the unchanged regression site keeps all three verbs', async () => {
  const { fixture, confirmCalls, spawnCalls, plannerCalls, thrown } = await runRegressionLoop((n) => verdict({
    recommendation: 'retry',
    rootCause: `REGRESSION-ROOT variant ${n}`,
    failureType: 'regression',
    affectedTaskIds: [`001-001-001-00${n}`], // a different id set every iteration → never a repeat
  }));
  try {
    assert.strictEqual(thrown, null, `the exhausted loop falls back to the accepted gate (got: ${thrown && thrown.message})`);
    assert.strictEqual(spawnCalls.length, 3,
      `distinct analyses must let the loop continue to the fixed cap — 3 analyzer sessions (got ${spawnCalls.length})`);
    assert.strictEqual(plannerCalls.length, 3,
      `distinct analyses must keep remediating up to the cap (got ${plannerCalls.length})`);
    assert.ok(confirmCalls.some((q) => /regression/i.test(q)),
      'exhaustion still falls back to the regression-failed gate');

    // TC3b: unchanged site — all three verbs stay, byte-level rule lines too.
    const enumList = spawnCalls[0].jsonSchema?.properties?.recommendation?.enum;
    assert.deepStrictEqual(enumList, ['retry', 're_plan', 'human'],
      `the milestone-regression site is NOT narrowed — its schema enum keeps all three verbs (got ${JSON.stringify(enumList)})`);
    assert.ok(spawnCalls[0].prompt.includes(RETRY_RULE_LINE),
      'the unchanged regression site must keep the retry rule line in its prompt');
  } finally {
    cleanup(fixture.projectRoot);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC8a (AC8) — GUARD: corrupt history file blocks nothing — the analysis
// runs and the injection no-ops (prompt byte-identical to the pinned
// baseline). Seams stubbed: analyzer LLM session only.
// ═════════════════════════════════════════════════════════════════════════

await test('TC8a (AC8): a corrupt history file blocks nothing — the analysis runs and the prompt injection no-ops (byte-identical baseline)', async () => {
  const root = makeTmpRoot();
  try {
    const TASK_ID = '001-001-001-001';
    fs.mkdirSync(path.join(activeHarnessDir(root), 'analysis'), { recursive: true });
    fs.writeFileSync(historyPath(root, TASK_ID), 'not json {{{');

    const { analyzer, spawnCalls } = makeAnalyzerHarness(() => verdict({ recommendation: 'human' }));
    const opts = { taskId: TASK_ID, taskDescription: 'Fixture task description', failureType: 'verification', retryCount: 2 };
    const analysis = await analyzer.analyzeFailure(opts, root);

    assert.strictEqual(analysis.recommendation, 'human',
      'the analysis itself must run and return the crafted verdict despite the corrupt history file');
    assert.ok(listAnalysisFiles(root).some((f) => f.startsWith(`gate-failure-${TASK_ID}-`)),
      'the per-event sidecar must still be written');

    const expected = expectedBaselinePrompt({ ...opts, eventId: analysis.eventId, projectRoot: root });
    assert.strictEqual(spawnCalls[0].prompt, expected,
      'a corrupt history file must make the injection a NO-OP — the prompt stays byte-identical to the no-history baseline');
  } finally {
    cleanup(root);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// TC8b (AC8) — GUARD: corrupt history file → the repeat comparator no-ops
// at the task site (the throw keeps its prefix, never escalatedByRepeat).
// Seams stubbed: analyzer LLM session; real _dispatchAnalyzer.
// ═════════════════════════════════════════════════════════════════════════

await test('TC8b (AC8): a corrupt history file makes the repeat comparator no-op — the task-site throw keeps its prefix without escalatedByRepeat', async () => {
  const { projectRoot } = createPipelineHarness();
  try {
    fs.writeFileSync(historyPath(projectRoot, '001-001-001-001'), 'not json {{{');
    const { pipeline } = makeDispatchPipeline(projectRoot, () => verdict({
      recommendation: 'human',
      affectedTaskIds: ['001-001-001-001'],
    }));
    const err = await dispatchCatch(pipeline, taskFixture());
    assert.ok(err, 'the human verdict must still throw the breaker');
    assert.ok(err.message.startsWith('Circuit breaker:'), `prefix kept (got: ${err.message})`);
    assert.notStrictEqual(err.escalatedByRepeat, true,
      'with an unreadable history the comparator must no-op — never a repeat escalation (fail-soft)');
  } finally {
    cleanup(projectRoot);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
