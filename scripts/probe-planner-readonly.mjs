/**
 * probe-planner-readonly.mjs — EFFICACY PROBE for read-only / analysis / review /
 * approval pre-step task detection. NOT a unit test — it makes REAL LLM calls:
 * real planner sessions (exploring a temp project) and real one-shot judge sessions.
 * It is NOT registered in run-tests.js and must be run MANUALLY.
 *
 * Usage:  node scripts/probe-planner-readonly.mjs [N]   (default N=20)
 *
 * Do NOT run casually — real-LLM cost (Opus planner + judge per run). Run manually.
 *
 * ── What this probes ─────────────────────────────────────────────────────────
 * The fix under test (PROMPT_SECTION_NO_READONLY_TASKS) stops the planner from
 * emitting pure read-only / analysis / review / approval pre-step tasks — tasks
 * with no deliverable (no file, no code change, no artifact) that a verifier cannot
 * check. This probe measures whether the LIVE planner still emits such tasks.
 *
 * ── Why three measurements (the decoupling that makes the number trustworthy) ──
 * A naive probe would drive the planner with a tempting read-only mission and check
 * that it produces read-only tasks "to prove the judge can detect them". That is
 * SELF-DEFEATING: the fix's whole job is to STOP the live planner from emitting
 * read-only tasks, so a discrimination control built on the live planner can never
 * produce the positive it needs. (Observed empirically: the tempting mission was
 * turned into file-PRODUCING tasks, 0 read-only — the control could not discriminate.)
 *
 * So judge-detectability and planner-efficacy are measured SEPARATELY:
 *
 *   1. JUDGE-DISCRIMINATION (no planner): feed the judge a fixed set of KNOWN
 *      read-only / approval descriptions and require it to flag them
 *      (readOnlyPreStep === true). Proves the judge can DETECT read-only tasks —
 *      the precondition for trusting measurement (2). Zero successful judgments = FAIL.
 *
 *   2. LIVE-PLANNER (real planMission, tempting read-only mission): the efficacy
 *      number. Each generated task.description is judged; a WIN is NOT read-only.
 *      The clean rate is the headline; the loss count is exactly how many read-only
 *      tasks the live (fixed) planner still emitted — expected ~0.
 *
 *   3. OVER-CORRECTION (real planMission, file-producing mission): guards the other
 *      direction — the fix must not strip legitimate file-producing tasks. A WIN is
 *      NOT read-only; a high clean rate means no over-correction.
 *
 * ── Headline metric ──────────────────────────────────────────────────────────
 * TRUE per-description pass rate: wins / SUCCESSFULLY-JUDGED (wins + losses).
 * Denominator excludes judge/run errors (a transient SDK error must not manufacture
 * a false-negative FAIL). Zero successful judgments in any measurement = FAIL.
 * Success criterion: JUDGE-DISCRIMINATION detection-rate >= 80%  AND
 *                    LIVE-PLANNER clean-rate              >= 80%  AND
 *                    OVER-CORRECTION clean-rate           >= 80%.
 *
 * A full report (every raw description + every judge verdict + counts) is persisted:
 *   .harness-probe/probe-planner-readonly-<UTC>.json
 *
 * The probe exits 0 on PASS and 1 on FAIL.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const N = Number.parseInt(process.argv[2] ?? '20', 10);
if (!Number.isInteger(N) || N < 1) {
  console.error(`Invalid N: ${process.argv[2]}. Pass a positive integer.`);
  process.exit(2);
}

// ── Import the real orchestrator pieces ──────────────────────────────────────
const { Planner } = await import(path.join(repoRoot, 'src/orchestrator/agents/planner.js'));
const { SessionManager } = await import(path.join(repoRoot, 'src/orchestrator/infra/session-manager.js'));
const { Logger } = await import(path.join(repoRoot, 'src/orchestrator/infra/logger.js'));
const { TokenTracker } = await import(path.join(repoRoot, 'src/orchestrator/infra/token-tracker.js'));
const { default: config } = await import(path.join(repoRoot, 'src/orchestrator/infra/config.js'));

// INDEPENDENT judge model — deliberately NOT the planner's model. The planner runs on
// plannerModel; grading its output with the same model would be self-grading and could
// bias the efficacy verdict. We grade with a different model so the PASS/FAIL is an
// independent signal. (verifierEscalationModel is the strongest non-planner model
// already configured; falls back to verifierModel.)
const JUDGE_MODEL = config.execution.verifierEscalationModel || config.execution.verifierModel;

// ── JUDGE-DISCRIMINATION positives ───────────────────────────────────────────
// KNOWN read-only / analysis / review / approval pre-step descriptions with NO
// deliverable. Fed DIRECTLY to the judge (no planner) to prove the judge detects
// read-only tasks. These are the positives the fix PREVENTS the live planner from
// ever emitting, which is exactly why the discrimination control cannot be built on
// the live planner. A correct judge flags every one as readOnlyPreStep === true.
const READONLY_POSITIVES = [
  'Review src/auth.js to understand the existing token-verification logic before any changes are made. Do not edit any file.',
  'Analyze each function in the authentication module for security vulnerabilities and note the issues found. Make no code changes and write no files.',
  'Produce the keep/drop policy for the deprecated inline comments in your response only — write NO files and do not edit pipeline.js.',
  'Inspect the module structure and obtain human approval before proceeding to the edits.',
  'Read through the existing test files and identify which ones will need updating. Do not modify anything yet.',
];

// ── Case fixtures (planner-driven) ───────────────────────────────────────────
//
// Each case builds a temp project the planner can explore (a REAL small source
// file it can anchor to) plus a missionPlan STRING carrying the requirement.
//
// LIVE-PLANNER — the missionPlan tempts the planner toward a pure read-only /
// analysis / review / approval pre-step task. This is the EFFICACY measurement:
// a correctly-fixed planner refuses to emit read-only tasks even here, so every
// generated description should be NOT read-only (readOnlyPreStep === false). The
// loss count is exactly how many read-only tasks the live planner still emitted.
const LIVE_PLANNER = {
  id: 'live-planner',
  sourceRel: 'src/auth.js',
  sourceContent:
`// Authentication module.
export function hashPassword(password, salt) {
  // TODO: implement proper hashing
  return password + salt;
}

export function verifyToken(token, secret) {
  if (!token) return false;
  return token.split('.')[1] === secret;
}

export function generateSession(userId) {
  return { userId, createdAt: Date.now(), expiresIn: 3600 };
}
`,
  specTargetFiles: ['src/auth.js'],
  // Deliberately frames the work as a pure read-only security audit with no code
  // changes and an approval gate — the strongest temptation toward a read-only
  // pre-step. A fixed planner folds the analysis into a file-producing task instead.
  missionPlan:
    "Perform a security audit of src/auth.js. Review the existing authentication "
    + "module and analyze each function for potential security vulnerabilities. "
    + "Do NOT make any code changes — this is a read-only inspection task. Identify "
    + "and list the security issues found in hashPassword, verifyToken, and "
    + "generateSession. Approval from the security team is needed before any fix "
    + "is applied.",
  expected: 'live (fixed) planner emits NO read-only pre-steps (every description NOT read-only)',
};

// OVER-CORRECTION — the missionPlan asks the planner to produce a written report
// or file. Even though writing a report involves reading, the deliverable IS a
// produced file. The judge must NOT classify these as read-only (readOnlyPreStep
// === false). This guards against over-correction (the fix stripping legitimate
// file-producing tasks).
const OVERCORRECTION = {
  id: 'overcorrection',
  sourceRel: 'src/api.js',
  sourceContent:
`// Public API module.
export function createUser(name, email) {
  return { id: Math.random().toString(36).slice(2), name, email };
}

export function deleteUser(id) {
  return { deleted: true, id };
}

export function listUsers(filter) {
  return [];
}

export function updateUser(id, patch) {
  return { id, ...patch };
}
`,
  specTargetFiles: ['docs/api-report.md'],
  missionPlan:
    "Generate a Markdown report at docs/api-report.md documenting the public API "
    + "surface of src/api.js. The report must include: (1) the function signature for "
    + "each exported function, (2) a one-sentence description of what each function "
    + "does, and (3) the shape of the return value. The file docs/api-report.md must "
    + "be created as a real file on disk — it is the deliverable for this mission.",
  expected: 'descriptions produce a CONCRETE FILE — NOT read-only',
};

// Both planner-driven cases WIN when the description is NOT read-only.
const PLANNER_CASES = [LIVE_PLANNER, OVERCORRECTION];

// ── Judge schema (forced structured output via jsonSchema) ────────────────────
// The judge uses readOnlyPreStep to bucket each description: true = pure
// read-only/analysis/review/approval task (no deliverable), false = task with a
// concrete deliverable (file, code change, produced artifact).
const readonlyJudgeSchema = {
  type: 'object',
  properties: {
    readOnlyPreStep: { type: 'boolean' },
    evidence: { type: 'string' },
  },
  required: ['readOnlyPreStep', 'evidence'],
};

// ── Per-case temp project construction ───────────────────────────────────────
function buildProject(testCase) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `probe-planner-${testCase.id}-`));

  // ESM project so the planner reads a real `.js` source with `export`.
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: `probe-${testCase.id}`, type: 'module' }, null, 2),
  );

  const sourceAbs = path.join(projectRoot, testCase.sourceRel);
  fs.mkdirSync(path.dirname(sourceAbs), { recursive: true });
  fs.writeFileSync(sourceAbs, testCase.sourceContent);

  // The planner's reusable session attaches a log under .harness via the Logger.
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });

  return { projectRoot, harnessDir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Extract structured output from an SDK result ─────────────────────────────
function extractStructured(result) {
  if (result && result.structured_output && typeof result.structured_output === 'object') {
    return result.structured_output;
  }
  if (result && typeof result.result === 'string') {
    try { return JSON.parse(result.result); } catch {}
    const match = result.result.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (match) { try { return JSON.parse(match[1]); } catch {} }
  }
  return null;
}

// ── Spawn a one-shot judge session and return its structured verdict ──────────
//
// Mirrors how verifier.js / planner.js spawn a session and force structured JSON
// via jsonSchema. The judge gets NO tools — it judges a single description string
// against the read-only definition.
async function judgeDescription(sessionManager, logger, tokenTracker, label, description) {
  const systemPrompt =
    'You are a strict reviewer auditing a single generated TASK DESCRIPTION to determine '
    + 'whether the task is a pure read-only / analysis / review / approval pre-step (with no '
    + 'concrete deliverable) or a task that produces a concrete artifact (file, code change, '
    + 'written output). Judge ONLY the description text you are given. Output structured JSON '
    + 'matching the session jsonSchema. Be literal and evidence-based.';

  const prompt =
`A planner generated the TASK DESCRIPTION below.

TASK DESCRIPTION to judge:
"""
${description}
"""

Set "readOnlyPreStep" = true if the task described is a PURE read-only / analysis /
review / inspection / approval task — i.e. it instructs the executor to read, inspect,
analyze, audit, review, or approve code/files WITHOUT producing any concrete deliverable
(no file is written, no code is changed, no artifact is created). Examples: "Review
src/auth.js to understand the structure", "Analyze the existing token verification
logic", "Inspect the authentication module for vulnerabilities", "Read the module and
identify issues". These tasks have no verifiable output.

Set "readOnlyPreStep" = false if the task describes producing a CONCRETE deliverable —
e.g. writing or modifying a source file, creating a report file, generating output that
is written to disk, or changing code. A task that involves reading AS A STEP but whose
primary purpose is to produce a file or code change is NOT a read-only task. Examples:
"Write docs/api-report.md documenting each exported function", "Update src/auth.js to
implement proper password hashing", "Create a Markdown file listing API signatures".

Put the deciding phrase(s) from the description in "evidence".`;

  const log = logger.createSessionLog(`probe-judge-${label}`);
  try {
    const spawnPromise = sessionManager.spawn({
      name: `probe-judge-${label}`,
      prompt,
      systemPrompt,
      model: JUDGE_MODEL,
      tools: [],
      jsonSchema: readonlyJudgeSchema,
      maxBudget: config.budgets.planner,
    });
    logger.attachToSession(spawnPromise.handle, log, { role: 'judge', phase: 'probe' });
    const { handle, result } = await spawnPromise;
    await tokenTracker?.recordSession(`probe-judge-${label}`, 'planner', result, {
      phase: 'probe-judge',
      systemPromptTokens: handle.systemPromptTokens,
      toolCallCount: handle._toolCallCount,
    });
    const verdict = extractStructured(result);
    if (!verdict || typeof verdict !== 'object') {
      return { error: 'judge returned no structured verdict', raw: result?.result ?? null };
    }
    return verdict;
  } finally {
    log.close();
  }
}

// ── JUDGE-DISCRIMINATION: prove the judge detects KNOWN read-only tasks ────────
// Decoupled from the planner. Builds a minimal harness, feeds each hardcoded
// read-only positive to the judge, and counts a WIN when readOnlyPreStep === true.
// This is the precondition for trusting the LIVE-PLANNER clean rate: if the judge
// could not detect read-only tasks, a 0% live-planner read-only rate would be
// meaningless.
async function tallyJudgeDiscrimination() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-judge-disc-'));
  const harnessDir = path.join(tmp, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });

  const logger = new Logger(harnessDir);
  const tokenTracker = new TokenTracker(harnessDir);
  const sessionManager = new SessionManager();
  sessionManager.setTokenTracker(tokenTracker);

  let wins = 0, losses = 0, judgeErrors = 0;
  const judged = [];
  try {
    for (const description of READONLY_POSITIVES) {
      const verdict = await judgeDescription(sessionManager, logger, tokenTracker, 'discrimination', description);
      const v = verdict ?? {};
      judged.push({ description, verdict });
      if (v.error) {
        judgeErrors++;
        console.log(`  [judge-discrimination] JUDGE ERROR — ${v.error}`);
        continue;
      }
      const win = v.readOnlyPreStep === true;
      if (win) wins++; else losses++;
      console.log(
        `  [judge-discrimination] ${win ? 'WIN ' : 'LOSS'}  readOnlyPreStep=${v.readOnlyPreStep}  `
        + `desc="${description.slice(0, 70)}"`,
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return {
    judged,
    counts: {
      totalDescriptions: READONLY_POSITIVES.length,
      wins, losses, judgeErrors, runErrors: 0, runsWithNoDescription: 0,
    },
  };
}

// ── Run the real planner ONCE for a case; return every generated description ───
async function planOnce(testCase, iter) {
  const { projectRoot, harnessDir } = buildProject(testCase);

  let logger, tokenTracker, sessionManager, planner;
  try {
    logger = new Logger(harnessDir);
    tokenTracker = new TokenTracker(harnessDir);
    sessionManager = new SessionManager();
    sessionManager.setTokenTracker(tokenTracker);
    planner = new Planner(sessionManager, logger, tokenTracker);
  } catch (err) {
    cleanup(projectRoot);
    throw new Error(`harness construction failed for ${testCase.id}: ${err.stack || err.message}`);
  }

  try {
    const plan = await planner.planMission('001-001', projectRoot, {
      missionPlan: testCase.missionPlan,
      specTargetFiles: testCase.specTargetFiles,
    });

    const descriptions = [];
    for (const sm of (plan?.subMissions ?? [])) {
      for (const task of (sm?.tasks ?? [])) {
        if (typeof task?.description === 'string' && task.description.trim().length > 0) {
          descriptions.push({ taskId: task.id ?? null, description: task.description });
        }
      }
    }

    // Judge each generated description.
    const judged = [];
    for (const d of descriptions) {
      const verdict = await judgeDescription(sessionManager, logger, tokenTracker, testCase.id, d.description);
      judged.push({ ...d, verdict });
    }

    return { iter, descriptions: judged, error: null };
  } finally {
    // Inputs differ per case and the reusable-session guard throws on
    // projectRoot mismatch — close between cases AND between runs.
    try { await planner.closeReusableSession(); } catch {}
    cleanup(projectRoot);
  }
}

// ── Drive a planner case N times; WIN = description is NOT read-only ────────────
async function tally(testCase) {
  const runs = [];
  let totalDescriptions = 0;
  let wins = 0;        // description is NOT read-only (good)
  let losses = 0;      // description IS read-only (a leak)
  let judgeErrors = 0;
  let runErrors = 0;
  let runsWithNoDescription = 0;

  for (let i = 1; i <= N; i++) {
    let run;
    try {
      run = await planOnce(testCase, i);
    } catch (err) {
      console.log(`  [${testCase.id} #${i}] RUN ERROR: ${err.message}`);
      runErrors++;
      runs.push({ iter: i, descriptions: [], error: err.message });
      continue;
    }

    if (run.descriptions.length === 0) {
      runsWithNoDescription++;
      console.log(`  [${testCase.id} #${i}] (no task descriptions emitted)`);
    }

    for (const d of run.descriptions) {
      totalDescriptions++;
      const v = d.verdict ?? {};
      if (v.error) {
        judgeErrors++;
        console.log(`      [${testCase.id} #${i}] task ${d.taskId}: JUDGE ERROR — ${v.error}`);
        continue;
      }
      const win = v.readOnlyPreStep === false;
      if (win) wins++; else losses++;
      console.log(
        `  [${testCase.id} #${i}] task ${d.taskId}: ${win ? 'WIN ' : 'LOSS'}  `
        + `readOnlyPreStep=${v.readOnlyPreStep}  `
        + `evidence="${String(v.evidence ?? '').slice(0, 120)}"`,
      );
    }

    runs.push(run);
  }

  return {
    runs,
    counts: { totalDescriptions, wins, losses, judgeErrors, runErrors, runsWithNoDescription },
  };
}

// ── Drive all three measurements ──────────────────────────────────────────────
console.log(`Probe: planner read-only pre-step detection. N=${N} planner runs per case.`);
console.log(`plannerModel=${config.execution.plannerModel}  judgeModel=${JUDGE_MODEL} (independent)\n`);

console.log(`── JUDGE-DISCRIMINATION (no planner: ${READONLY_POSITIVES.length} known read-only positives) ──`);
const discrimination = await tallyJudgeDiscrimination();
console.log('');

const results = {};
for (const c of PLANNER_CASES) {
  console.log(`── Case ${c.id} (expected: ${c.expected}) ──`);
  results[c.id] = await tally(c);
  console.log('');
}

// ── Summary + persistence ────────────────────────────────────────────────────
// Gate on a TRUE per-description pass RATE (>= 0.8). The denominator is the number of
// SUCCESSFULLY-JUDGED descriptions (wins + losses) — NOT totalDescriptions, because a
// transient judge SDK error must not count as a loss: it would deflate the rate and
// manufacture a false-negative efficacy verdict. judgeErrors/runErrors are reported
// separately, and zero successful judgments in any measurement is a FAIL.
const RATE = 0.8;

const disc = discrimination.counts;
const live = results[LIVE_PLANNER.id].counts;
const over = results[OVERCORRECTION.id].counts;

const discJudged = disc.wins + disc.losses;
const liveJudged = live.wins + live.losses;
const overJudged = over.wins + over.losses;

const discRate = discJudged > 0 ? disc.wins / discJudged : 0;   // detection rate
const liveRate = liveJudged > 0 ? live.wins / liveJudged : 0;   // clean (not-read-only) rate
const overRate = overJudged > 0 ? over.wins / overJudged : 0;   // clean (not-read-only) rate

const discOk = discJudged > 0 && discRate >= RATE;
const liveOk = liveJudged > 0 && liveRate >= RATE;
const overOk = overJudged > 0 && overRate >= RATE;
const success = discOk && liveOk && overOk;

const pct = (r) => `${(r * 100).toFixed(1)}%`;

console.log('════════════════════════════════════════════');
console.log(
  `JUDGE-DISCRIMINATION read-only detection rate : ${disc.wins}/${discJudged} judged  (${pct(discRate)})   `
  + `(losses: ${disc.losses}, judgeErrors: ${disc.judgeErrors})`,
);
console.log(
  `LIVE-PLANNER         not-read-only clean rate : ${live.wins}/${liveJudged} judged  (${pct(liveRate)})   `
  + `(read-only leaks: ${live.losses}, judgeErrors: ${live.judgeErrors}, runErrors: ${live.runErrors}, emitted: ${live.totalDescriptions})`,
);
console.log(
  `OVER-CORRECTION      not-read-only clean rate : ${over.wins}/${overJudged} judged  (${pct(overRate)})   `
  + `(losses: ${over.losses}, judgeErrors: ${over.judgeErrors}, runErrors: ${over.runErrors}, emitted: ${over.totalDescriptions})`,
);
console.log('');
console.log(`Headline = PLANNER-DIRECT (no escalation path in planMission). LIVE-PLANNER read-only leaks = ${live.losses} (expect 0).`);
console.log(
  `Success criterion: JUDGE-DISCRIMINATION >=${pct(RATE)}  AND  LIVE-PLANNER clean >=${pct(RATE)}  AND  OVER-CORRECTION clean >=${pct(RATE)}  `
  + `(per SUCCESSFULLY-JUDGED description; zero judged in any = FAIL)`,
);
console.log(`Result: ${success ? 'PASS' : 'FAIL'}`);
const totalJudgeErrors = disc.judgeErrors + live.judgeErrors + over.judgeErrors;
if (totalJudgeErrors > 0) {
  console.log(
    `NOTE: ${totalJudgeErrors} judge error(s) excluded from the rate denominators — `
    + `inspect the persisted report if a judged count is low.`,
  );
}
console.log('════════════════════════════════════════════');

const reportDir = path.join(repoRoot, '.harness-probe');
fs.mkdirSync(reportDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `probe-planner-readonly-${stamp}.json`);
const report = {
  probe: 'planner-readonly-pre-step',
  timestamp: new Date().toISOString(),
  N,
  passRate: RATE,
  plannerModel: config.execution.plannerModel,
  judgeModel: JUDGE_MODEL,
  successCriterion:
    'JUDGE-DISCRIMINATION detection-rate >= 0.8 AND LIVE-PLANNER clean-rate >= 0.8 '
    + 'AND OVER-CORRECTION clean-rate >= 0.8 (per SUCCESSFULLY-JUDGED description = '
    + 'wins+losses; zero judged in any = FAIL)',
  headline: {
    judge_discrimination_wins: disc.wins,
    judge_discrimination_judged: discJudged,
    judge_discrimination_detection_rate: discRate,
    live_planner_clean_wins: live.wins,
    live_planner_judged: liveJudged,
    live_planner_read_only_leaks: live.losses,
    live_planner_total_descriptions: live.totalDescriptions,
    live_planner_clean_rate: liveRate,
    overcorrection_clean_wins: over.wins,
    overcorrection_judged: overJudged,
    overcorrection_total_descriptions: over.totalDescriptions,
    overcorrection_clean_rate: overRate,
    success,
  },
  measurements: {
    'judge-discrimination': {
      kind: 'judge-only (no planner)',
      positives: READONLY_POSITIVES,
      counts: discrimination.counts,
      judged: discrimination.judged,
    },
    [LIVE_PLANNER.id]: {
      expected: LIVE_PLANNER.expected,
      missionPlan: LIVE_PLANNER.missionPlan,
      specTargetFiles: LIVE_PLANNER.specTargetFiles,
      counts: results[LIVE_PLANNER.id].counts,
      runs: results[LIVE_PLANNER.id].runs,
    },
    [OVERCORRECTION.id]: {
      expected: OVERCORRECTION.expected,
      missionPlan: OVERCORRECTION.missionPlan,
      specTargetFiles: OVERCORRECTION.specTargetFiles,
      counts: results[OVERCORRECTION.id].counts,
      runs: results[OVERCORRECTION.id].runs,
    },
  },
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nFull report persisted: ${reportPath}`);

process.exit(success ? 0 : 1);
