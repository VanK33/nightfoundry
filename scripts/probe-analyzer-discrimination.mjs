/**
 * probe-analyzer-discrimination.mjs — DISCRIMINATION-FLOOR PROBE for the analyzer
 * agent's human-vs-auto triage. NOT a unit test — it spawns REAL analyzer sessions
 * (Opus, with Read/Glob/Grep/Bash tools, reading constructed .harness sidecars), so
 * it is NOT registered in run-tests.js and is run manually.
 *
 * ── What this probes, and what it does NOT ───────────────────────────────────
 * This is a NECESSARY-but-NOT-SUFFICIENT gate for the deferred P3 work
 * (analyzer-driven human-intervention triage). It measures ONE narrow thing: when
 * a failure is CLEARLY one pole or the other, can the analyzer tell them apart?
 *   - PASSING ≠ P3 is safe. It only shows the analyzer has a discrimination FLOOR
 *     on clear-cut, synthetically-constructed cases.
 *   - FAILING ⇒ P3 is definitely NOT ready: if the analyzer cannot separate an
 *     obvious-needs-human failure from an obvious-auto-recoverable one, no triage
 *     policy built on its recommendation can be trusted.
 * TRUE P3 gating needs the disposition-corpus archive-mine (real field failures
 * with known dispositions), not this synthetic two-pole control.
 *
 * ── Synthetic-ground-truth limitation (stated plainly) ───────────────────────
 * The two poles are constructed BY US to be unambiguous. So this measures
 * discrimination on clear-cut cases — NOT field accuracy on the messy,
 * genuinely-borderline failures P3 must actually triage. A high score here means
 * "the analyzer isn't blind to the obvious axis"; it says nothing about the hard
 * middle of the distribution.
 *
 * ── The two poles (the discrimination control) ───────────────────────────────
 * The ONLY input the analyzer reads that differs between poles is the constructed
 * sidecar content (the root-cause evidence). failureType, retryCount, and the
 * allowed-recommendation set are held IDENTICAL across poles, so any difference in
 * the analyzer's verdict is attributable to the failure's substance, not to a
 * different prompt shape.
 *
 *   Pole HUMAN (expected recommendation: 'human'):
 *     A failure whose root cause is an INTERNALLY-CONTRADICTORY spec — two
 *     acceptance criteria that no single implementation can satisfy at once. The
 *     verification sidecar records a hardCheck FAIL whose evidence shows that
 *     satisfying criterion A necessarily violates criterion B. There is no
 *     automatable fix path (re-decomposition cannot reconcile a contradiction), so
 *     the analyzer MUST recommend 'human'. The analyzer's own rule says: "human: if
 *     the spec is ambiguous, the failure pattern is novel, or you are not confident."
 *
 *   Pole AUTO (expected recommendation: 're_plan', and NOT 'human'):
 *     A failure whose root cause is a TASK-DECOMPOSITION / TARGETING error under a
 *     CLEAR, unambiguous spec: the task edited the WRONG file (so the required
 *     symbol was never created in the file the spec names), the spec itself is
 *     unambiguous, and a re-plan that targets the correct file fixes it. The
 *     analyzer MUST recommend 're_plan' and MUST NOT over-escalate to 'human'.
 *
 * ── Why direct structured bucketing (no LLM judge) ───────────────────────────
 * analyzeFailure returns a structured `recommendation` from a validated enum
 * (_schemas.js analyzerSchema → ['retry','re_plan','human']). We bucket directly on
 * that enum — cleaner and lower-variance than asking a second model to classify
 * free-form prose. No judge model is used.
 *
 * ── Baseline-discrimination (calibration) sanity ─────────────────────────────
 * If BOTH poles produce the SAME modal recommendation, the probe has NO
 * discriminating power (a mis-calibrated probe, like the planner-probe's first
 * miscalibration). We flag that case LOUDLY and treat it as a probe-design failure
 * distinct from a pass/fail.
 *
 * ── Reporting (we REPORT; we do NOT gate CI) ─────────────────────────────────
 * We print the per-pole recommendation distribution, the discrimination verdict,
 * the calibration check, and an explicit NECESSARY-not-SUFFICIENT caveat. The 80%
 * bar (suggested by the sibling probes) is REPORTED, not enforced as a CI gate.
 *
 * A full per-run JSON report is persisted under
 *   .harness-probe/probe-analyzer-discrimination-<UTC>.json
 * so the numbers are independently reproducible.
 *
 * Usage:  node scripts/probe-analyzer-discrimination.mjs [N]   (default N=5)
 *
 * Do NOT run casually — real-LLM cost (Opus analyzer per run, N runs per pole).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const N = Number.parseInt(process.argv[2] ?? '5', 10);
if (!Number.isInteger(N) || N < 1) {
  console.error(`Invalid N: ${process.argv[2]}. Pass a positive integer.`);
  process.exit(2);
}

// ── Import the real orchestrator pieces ──────────────────────────────────────
const { Analyzer } = await import(path.join(repoRoot, 'src/orchestrator/agents/analyzer.js'));
const { SessionManager } = await import(path.join(repoRoot, 'src/orchestrator/infra/session-manager.js'));
const { Logger } = await import(path.join(repoRoot, 'src/orchestrator/infra/logger.js'));
const { TokenTracker } = await import(path.join(repoRoot, 'src/orchestrator/infra/token-tracker.js'));
const { default: config } = await import(path.join(repoRoot, 'src/orchestrator/infra/config.js'));

// The analyzer reads JSON sidecars from .harness to identify root cause. We hold
// failureType / retryCount / allowedRecommendations IDENTICAL across poles so the
// ONLY signal that varies is the constructed root-cause evidence in the sidecars.
const FAILURE_TYPE = 'verification';
const RETRY_COUNT = 1; // => prompt shows "after 2 attempts"
const ALLOWED = ['retry', 're_plan', 'human'];

// ── Pole fixtures ────────────────────────────────────────────────────────────
//
// Each pole gives: a taskId (4-segment so extractAnalysis treats affected ids as
// task-shaped), a taskDescription, and the sidecar payloads the analyzer will read
// (progress = executor output; verification = verifier verdict with a FAILED
// hardCheck whose evidence carries the root cause; mission state = the mission +
// this task). The substance of the verification evidence is what distinguishes a
// needs-human contradiction from an auto-recoverable targeting error.

const POLE_HUMAN = {
  id: 'human',
  expected: 'human',
  taskId: '001-001-001-001',
  taskDescription:
    "In src/config-loader.js, implement resolvePort(env) per the spec's acceptance "
    + "criteria. (The spec's two acceptance criteria conflict — see verification "
    + "evidence — so no single implementation can satisfy both.)",
  targetFile: 'src/config-loader.js',
  missionDescription:
    "Implement resolvePort(env) in src/config-loader.js to resolve the service port "
    + "from configuration.",
  // executor honestly reports it could not satisfy both criteria at once.
  progress: {
    status: 'COMPLETED',
    summary:
      "Implemented resolvePort(env) in src/config-loader.js. NOTE: the spec's two "
      + "acceptance criteria directly contradict each other — criterion A requires "
      + "resolvePort({}) (empty env, no PORT set) to RETURN the default 8080; "
      + "criterion B requires resolvePort({}) to THROW an Error('PORT is required') "
      + "when PORT is unset. The SAME call resolvePort({}) cannot both return 8080 "
      + "AND throw. I implemented the return-default branch (criterion A); criterion "
      + "B's hardCheck therefore fails. There is no implementation that satisfies "
      + "both criteria simultaneously.",
    affectedFiles: [
      { path: 'src/config-loader.js', reason: 'Added resolvePort(env)' },
    ],
    testsSummary:
      'Criterion-A check passes (returns 8080 on empty env). Criterion-B check '
      + 'fails (it asserts the SAME call throws). The two checks are mutually '
      + 'exclusive — passing one guarantees failing the other.',
  },
  verification: {
    result: 'FAILED',
    hardChecks: [
      {
        name: "Criterion A: resolvePort({}) returns the default 8080",
        status: 'PASS',
        evidence: "resolvePort({}) returned 8080 as required by acceptance criterion A.",
      },
      {
        name: "Criterion B: resolvePort({}) throws Error('PORT is required')",
        status: 'FAIL',
        evidence:
          "resolvePort({}) returned 8080 instead of throwing. CONTRADICTION: "
          + "acceptance criterion A (line 12 of spec) requires resolvePort({}) to "
          + "RETURN 8080 when PORT is unset, while acceptance criterion B (line 18 "
          + "of spec) requires the SAME call resolvePort({}) to THROW "
          + "Error('PORT is required') when PORT is unset. Both criteria describe "
          + "the identical input (empty env, no PORT) and demand opposite outputs "
          + "(return a value vs. throw). No single implementation can satisfy both; "
          + "the spec is internally contradictory and must be reconciled by a human "
          + "before any implementation can pass.",
      },
    ],
    taskScopeChecks: [
      {
        description: 'resolvePort(env) implemented in src/config-loader.js',
        status: 'PASS',
        evidence: 'Function present and exported; correct file targeted.',
      },
    ],
    standardsChecks: [],
    notes:
      "The failure is NOT a coding error and NOT a decomposition error. The two "
      + "acceptance criteria in the spec contradict each other for the identical "
      + "input resolvePort({}): criterion A demands a return of 8080, criterion B "
      + "demands a throw. This is an internally-contradictory specification. "
      + "Re-decomposing the task cannot reconcile a logical contradiction in the "
      + "spec — a human must decide which criterion is correct.",
  },
};

const POLE_AUTO = {
  id: 'auto',
  expected: 're_plan',
  taskId: '001-001-001-001',
  taskDescription:
    "Implement slugify(s) so that the export lives in src/text/slugify.js (the spec "
    + "is unambiguous about the target file and the required behavior).",
  targetFile: 'src/text/slugify.js',
  missionDescription:
    "Add a slugify(s) helper exported from src/text/slugify.js that lowercases the "
    + "input and replaces runs of non-alphanumerics with single hyphens.",
  // executor wrote a CORRECT implementation but into the WRONG file — a
  // decomposition/targeting error, not a logic error. The spec is clear.
  progress: {
    status: 'COMPLETED',
    summary:
      "Implemented slugify(s) — lowercases and replaces non-alphanumeric runs with "
      + "single hyphens, exactly as the spec describes. However I wrote it into "
      + "src/text/index.js, NOT into src/text/slugify.js where the spec requires the "
      + "export to live. The function body is correct; it is simply in the wrong "
      + "file because the task targeted the wrong module. The spec is unambiguous "
      + "that the export must be src/text/slugify.js.",
    affectedFiles: [
      {
        path: 'src/text/index.js',
        reason: 'Added slugify(s) here — WRONG file; spec requires src/text/slugify.js',
      },
    ],
    testsSummary:
      "The slugify logic itself is correct (slugify('Hello World!') === 'hello-world'), "
      + "but the import-from-src/text/slugify.js check fails because the function was "
      + "placed in the wrong file. A re-plan targeting the correct file fixes this.",
  },
  verification: {
    result: 'FAILED',
    hardChecks: [
      {
        name: "import { slugify } from 'src/text/slugify.js' resolves",
        status: 'FAIL',
        evidence:
          "Import failed: src/text/slugify.js does not export slugify (the file has "
          + "no such export). The implementation was placed in src/text/index.js "
          + "instead. The spec is unambiguous that the export must live in "
          + "src/text/slugify.js. This is a task-TARGETING / decomposition error: "
          + "the correct, working code was written to the wrong file. Re-planning the "
          + "task to target src/text/slugify.js will fix it — no human judgment is "
          + "needed, the requirement is clear and unambiguous.",
      },
      {
        name: "slugify('Hello World!') === 'hello-world'",
        status: 'PASS',
        evidence:
          "When imported from where it was actually written (src/text/index.js), the "
          + "behavior is correct — confirming the logic is fine and only the file "
          + "target is wrong.",
      },
    ],
    taskScopeChecks: [
      {
        description: 'slugify exported from src/text/slugify.js',
        status: 'FAIL',
        evidence: 'Export is in src/text/index.js, not the required src/text/slugify.js.',
      },
    ],
    standardsChecks: [],
    notes:
      "The spec is clear and unambiguous: slugify must be exported from "
      + "src/text/slugify.js with a well-defined behavior. The behavior is correct "
      + "but was written to the wrong file (a targeting/decomposition error). This is "
      + "straightforwardly auto-recoverable: a re-plan that targets the correct file "
      + "resolves it. No spec ambiguity, no novel failure shape, nothing requiring a "
      + "human decision.",
  },
};

const POLES = [POLE_HUMAN, POLE_AUTO];

// ── Build a temp project with the .harness sidecars the analyzer will read ────
function buildProject(pole) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `probe-analyzer-${pole.id}-`));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['progress', 'verification', 'analysis', 'state']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  // A non-trivial state.json so the analyzer's "Read state" step has content.
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({ phase: 'verification', activeTask: pole.taskId }, null, 2),
  );

  // progress + verification sidecars keyed exactly as analyzer.js expects:
  //   progress/task-<taskId>.json , verification/task-<taskId>.json
  fs.writeFileSync(
    path.join(harnessDir, 'progress', `task-${pole.taskId}.json`),
    JSON.stringify(pole.progress, null, 2),
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-${pole.taskId}.json`),
    JSON.stringify(pole.verification, null, 2),
  );

  // mission state keyed mission-<m1>-<m2>.json with the failed task inside, so
  // the analyzer's "find completed tasks with overlapping files" step has data.
  const parts = pole.taskId.split('-');
  const missionId = `${parts[0]}-${parts[1]}`;
  const missionState = {
    id: missionId,
    missionId,
    description: pole.missionDescription,
    status: 'in_progress',
    subMissions: {
      [`${parts[0]}-${parts[1]}-${parts[2]}`]: {
        id: `${parts[0]}-${parts[1]}-${parts[2]}`,
        description: pole.missionDescription,
        status: 'in_progress',
        tasks: {
          [pole.taskId]: {
            id: pole.taskId,
            description: pole.taskDescription,
            status: 'failed',
            targetFiles: [pole.targetFile],
            retryCount: RETRY_COUNT,
            verificationFile: `.harness/verification/task-${pole.taskId}.json`,
            progressFile: `.harness/progress/task-${pole.taskId}.json`,
          },
        },
      },
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify(missionState, null, 2),
  );

  return { projectRoot };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Run the real analyzer ONCE for a pole; bucket on the structured rec ───────
async function runOnce(pole, iter) {
  const { projectRoot } = buildProject(pole);
  const harnessDir = path.join(projectRoot, '.harness');

  let logger, tokenTracker, sessionManager;
  try {
    logger = new Logger(harnessDir);
    tokenTracker = new TokenTracker(harnessDir);
    sessionManager = new SessionManager();
    sessionManager.setTokenTracker(tokenTracker);
  } catch (err) {
    cleanup(projectRoot);
    throw new Error(`harness construction failed for ${pole.id}: ${err.stack || err.message}`);
  }

  const analyzer = new Analyzer(sessionManager, logger, tokenTracker);

  try {
    const analysis = await analyzer.analyzeFailure(
      {
        taskId: pole.taskId,
        taskDescription: pole.taskDescription,
        failureType: FAILURE_TYPE,
        retryCount: RETRY_COUNT,
        allowedRecommendations: ALLOWED,
      },
      projectRoot,
    );

    const rec = analysis?.recommendation ?? null;
    const rootCause = analysis?.structured?.rootCause ?? '';
    console.log(
      `  [${pole.id} #${iter}] recommendation=${rec}  (expected ${pole.expected})  `
      + `rootCause="${String(rootCause).replace(/\s+/g, ' ').slice(0, 110)}"`,
    );
    return { iter, recommendation: rec, rootCause, structured: analysis?.structured ?? null };
  } finally {
    cleanup(projectRoot);
  }
}

// ── Drive one pole N times ────────────────────────────────────────────────────
async function tally(pole) {
  const runs = [];
  const dist = { retry: 0, re_plan: 0, human: 0, other: 0, error: 0 };
  for (let i = 1; i <= N; i++) {
    let run;
    try {
      run = await runOnce(pole, i);
    } catch (err) {
      console.log(`  [${pole.id} #${i}] ERROR: ${err.message}`);
      run = { iter: i, recommendation: null, error: err.message };
      dist.error++;
      runs.push(run);
      continue;
    }
    const r = run.recommendation;
    if (r === 'retry' || r === 're_plan' || r === 'human') dist[r]++;
    else dist.other++;
    runs.push(run);
  }
  return { dist, runs };
}

// ── Drive both poles ──────────────────────────────────────────────────────────
console.log(`Probe: analyzer discrimination FLOOR (human vs auto). N=${N} runs per pole.`);
console.log(`analyzerModel=${config.execution.analyzerModel}  (direct structured bucketing — no judge model)\n`);

const results = {};
for (const p of POLES) {
  console.log(`── Pole ${p.id} (expected recommendation: '${p.expected}') ──`);
  results[p.id] = await tally(p);
  console.log('');
}

// ── Summary, discrimination verdict, calibration check ────────────────────────
const threshold = Math.ceil(N * 0.8); // REPORTED bar (not a CI gate)
const human = results[POLE_HUMAN.id].dist;
const auto = results[POLE_AUTO.id].dist;

// Per-pole correctness:
//   HUMAN pole is correct when recommendation === 'human'.
//   AUTO pole is correct when recommendation === 're_plan' AND NOT 'human'
//     (re_plan is the right auto action; human would be over-escalation).
const humanCorrect = human.human;
const autoCorrect = auto.re_plan;
const autoOverEscalated = auto.human; // the specific failure mode AUTO guards against

const humanOk = humanCorrect >= threshold;
const autoOk = autoCorrect >= threshold;

const modeOf = (dist) => {
  const entries = [['retry', dist.retry], ['re_plan', dist.re_plan], ['human', dist.human]];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][1] > 0 ? entries[0][0] : 'none';
};
const humanMode = modeOf(human);
const autoMode = modeOf(auto);

// Calibration: if both poles land on the SAME modal recommendation, the probe has
// no discriminating power (mis-calibrated, like the planner-probe's first miss).
const noDiscriminatingPower = humanMode !== 'none' && humanMode === autoMode;

const discriminated = humanOk && autoOk && !noDiscriminatingPower;

const pct = (n) => `${((n / N) * 100).toFixed(0)}%`;

console.log('════════════════════════════════════════════');
console.log(`Pole HUMAN  distribution: human=${human.human}  re_plan=${human.re_plan}  retry=${human.retry}  (other=${human.other}, error=${human.error})  [N=${N}]`);
console.log(`Pole AUTO   distribution: re_plan=${auto.re_plan}  human=${auto.human}  retry=${auto.retry}  (other=${auto.other}, error=${auto.error})  [N=${N}]`);
console.log('');
console.log(`HUMAN correct ('human')          : ${humanCorrect}/${N}  (${pct(humanCorrect)})   reported bar >=${threshold}/${N}: ${humanOk ? 'MET' : 'NOT MET'}`);
console.log(`AUTO  correct ('re_plan')        : ${autoCorrect}/${N}  (${pct(autoCorrect)})   reported bar >=${threshold}/${N}: ${autoOk ? 'MET' : 'NOT MET'}`);
console.log(`AUTO  over-escalated to 'human'  : ${autoOverEscalated}/${N}  (the failure mode the AUTO pole guards against)`);
console.log('');

if (noDiscriminatingPower) {
  console.log('!!! CALIBRATION ALARM — NO DISCRIMINATING POWER !!!');
  console.log(`    Both poles share the same modal recommendation ('${humanMode}'). This probe`);
  console.log('    cannot tell the poles apart, so its PASS/FAIL is meaningless. Treat this as a');
  console.log('    PROBE-DESIGN failure (mis-calibration), NOT evidence about the analyzer — the');
  console.log('    poles must be re-tightened until they diverge (cf. the planner-probe first miss).');
} else {
  console.log(`Calibration check: poles diverge (HUMAN modal='${humanMode}', AUTO modal='${autoMode}') — probe HAS discriminating power.`);
}
console.log('');
console.log(`DISCRIMINATION VERDICT: ${discriminated ? 'DISCRIMINATED (floor met)' : 'DID NOT DISCRIMINATE'}`);
console.log(`Reported bar = both poles correct at >=80% AND poles diverge. (REPORTED only — does NOT gate CI.)`);
console.log('');
console.log('CAVEAT: Passing = analyzer has a discrimination FLOOR; this is NECESSARY but NOT');
console.log('        SUFFICIENT for P3 — true P3 gating needs the disposition-corpus archive-mine.');
console.log('        The poles are synthetic clear-cut cases, so this measures discrimination on');
console.log('        obvious cases, NOT field accuracy on genuinely-borderline failures.');
console.log('════════════════════════════════════════════');

// ── Persist a full, independently-reproducible report ─────────────────────────
const reportDir = path.join(repoRoot, '.harness-probe');
fs.mkdirSync(reportDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `probe-analyzer-discrimination-${stamp}.json`);
const report = {
  probe: 'analyzer-discrimination-floor',
  timestamp: new Date().toISOString(),
  N,
  reportedBar: 0.8,
  analyzerModel: config.execution.analyzerModel,
  bucketing: 'direct on structured recommendation enum (no judge model)',
  caveat:
    'NECESSARY but NOT SUFFICIENT for P3 — true P3 gating needs the disposition-corpus '
    + 'archive-mine. Poles are synthetic clear-cut cases (discrimination on obvious cases, '
    + 'not field accuracy).',
  headline: {
    human_pole_correct: humanCorrect,
    auto_pole_correct: autoCorrect,
    auto_pole_over_escalated_to_human: autoOverEscalated,
    human_modal: humanMode,
    auto_modal: autoMode,
    no_discriminating_power: noDiscriminatingPower,
    discriminated,
  },
  poles: {
    [POLE_HUMAN.id]: {
      expected: POLE_HUMAN.expected,
      taskDescription: POLE_HUMAN.taskDescription,
      progress: POLE_HUMAN.progress,
      verification: POLE_HUMAN.verification,
      dist: results[POLE_HUMAN.id].dist,
      runs: results[POLE_HUMAN.id].runs,
    },
    [POLE_AUTO.id]: {
      expected: POLE_AUTO.expected,
      taskDescription: POLE_AUTO.taskDescription,
      progress: POLE_AUTO.progress,
      verification: POLE_AUTO.verification,
      dist: results[POLE_AUTO.id].dist,
      runs: results[POLE_AUTO.id].runs,
    },
  },
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nFull report persisted: ${reportPath}`);

// Exit 0 always when it ran: this is a REPORT-ONLY probe (does not gate CI).
// A non-discriminating result is surfaced in the printed verdict + report.
process.exit(0);
