/**
 * probe-planner-overspecify.mjs — EFFICACY PROBE for the planner behavior-not-form
 * fix (failed-121, PLANNER side). NOT a unit test — it spawns REAL planner sessions
 * (Opus, with Read/Glob/Grep tools, exploring a temp project) plus REAL one-shot
 * judge sessions, so it is NOT registered in run-tests.js and is run manually.
 *
 * ── What this probes ─────────────────────────────────────────────────────────
 * The verifier was FAILing functionally-correct, test-passing work on cosmetic /
 * structural scope-check deviations (nested-vs-flat code, log wording, statement
 * ordering, line placement). A verifier-PROMPT fix has a ceiling. The root is
 * UPSTREAM and — per a forensic read of the real failed-121 archive — the dominant
 * shape is PLANNER-INVENTED form: the spec stated ONLY behavior, and the planner
 * ADDED incidental code-form constraints into task.description on its own (e.g. the
 * spec said nothing about conditional structure, yet the planner mandated a "flat
 * if-else-if" refactor; the spec said nothing about test ordering, yet the planner
 * mandated "place before line 95"). The fix guides the planner to describe required
 * BEHAVIOR + acceptance criteria, not incidental form, unless the form IS the
 * deliverable.
 *
 * This probe drives the REAL planner end-to-end and asks: given a behavior-ONLY
 * mission over a codebase that invites structural opinions, do the generated
 * task.description strings stay behavior-only, or does the planner INVENT form?
 *
 *   Case INVENTED (the real failed-121 mode; expected: descriptions BEHAVIOR-only):
 *     Reproduces the real trigger — the spec asked round-2 to be handled "the same
 *     shape as round-1" (a BEHAVIORAL reference), and the planner over-interpreted it
 *     into an explicit conditional-STRUCTURE mandate. The source ships an existing
 *     classifyRound1 with a concrete if-else-if shape; the missionPlan states the
 *     behavior rules and asks round-2 to be handled CONSISTENTLY with round-1 (same
 *     decision logic), with NO explicit shape/naming/ordering/log/line directive. A
 *     tempted planner mandates "mirror classifyRound1's structure" (invented form); a
 *     clean planner keeps "consistency" behavioral. PASS = the generated task
 *     descriptions describe the BEHAVIOR and do NOT invent any incidental form.
 *
 *   Case DELIVERABLE (control — expected: descriptions PRESERVE the form):
 *     The missionPlan makes a form genuinely CONTRACTUAL: a log line whose text is
 *     EXACTLY 'retry: round 2', which a monitoring dashboard greps for, so the exact
 *     wording is a hard requirement. PASS = the generated task descriptions KEEP the
 *     exact-string requirement. This guards against OVER-correction: the prompt must
 *     not strip a form that IS the deliverable.
 *
 * ── Headline metric ──────────────────────────────────────────────────────────
 * We report PLANNER-DIRECT numbers only (the prompt's true effect on the planner).
 * There is no escalation path in planMission, so every emitted description counts
 * directly. Each generated description is bucketed by an LLM-judge:
 *   - INVENTED:     judge → { overspecified: boolean }. A BEHAVIOR-only description
 *                   (overspecified === false) is a win.
 *   - DELIVERABLE:  judge → { formPreserved: boolean }. A PRESERVED description
 *                   (formPreserved === true) is a win.
 *
 * Success criterion (printed): INVENTED clean-rate >= 80%  AND
 *                              DELIVERABLE form-preserved-rate >= 80%.
 *
 * The rate is a TRUE per-description pass rate: wins / SUCCESSFULLY-JUDGED (wins +
 * losses). A single planMission run emits one-to-many task descriptions (each judged
 * independently); the denominator excludes judge/run errors so a transient judge SDK
 * error cannot deflate the rate into a false-negative FAIL. Zero successful judgments
 * = FAIL (no evidence is not a pass). The judge runs on an INDEPENDENT model (NOT the
 * planner's), so the verdict is not self-graded. N is the number of planner RUNS per
 * case; we print wins/judged + the percentage, with emitted/error counts alongside.
 *
 * A full report (every raw description + every judge verdict) is persisted under
 *   .harness-probe/probe-planner-overspecify-<UTC>.json
 * so a keyword cross-check (e.g. grep the descriptions for "flat", "if-else-if",
 * "before line", "retry: round 2") is independently reproducible later.
 *
 * Usage:  node scripts/probe-planner-overspecify.mjs [N]   (default N=20)
 *
 * Do NOT run casually — real-LLM cost (Opus planner + judge per run). Jeff runs it.
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
// plannerModel (Opus); grading its output with the same model would be self-grading and
// could bias the efficacy verdict toward "clean". We grade with a different model so the
// PASS/FAIL is an independent signal. (verifierEscalationModel is the strongest non-Opus
// model already configured; falls back to verifierModel.) The sharp discrimination the
// probe shows — 0% clean with no fix vs ~100% with the fix, same judge — is the real
// guard against rubber-stamping; an independent judge closes the residual concern.
const JUDGE_MODEL = config.execution.verifierEscalationModel || config.execution.verifierModel;

// ── Case fixtures ────────────────────────────────────────────────────────────
//
// Each case builds a temp project the planner can explore (a REAL small source
// file it can anchor to) and a missionPlan STRING carrying the requirement. The
// distinguishing property is whether ANY form in the resulting description was
// planner-INVENTED (the mission stated only behavior) or genuinely CONTRACTUAL
// (the mission made an exact form part of the deliverable).

// CASE INVENTED — faithful to the real failed-121 mode (planner-invented form).
// Reproduces the real trigger: the spec asked for round-2 to be handled "the same
// shape as round-1" (a BEHAVIORAL/logic reference), and the planner over-interpreted
// that into an explicit conditional-STRUCTURE mandate ("the refactored conditional
// structure should be if-else-if ..."). Here the source ships an existing
// classifyRound1 with a concrete flat if-else-if shape, and the mission asks round-2
// to be handled CONSISTENTLY with round-1 — meaning the same waive/park DECISION
// LOGIC, NOT a copy of round-1's code structure. A tempted planner mandates "mirror
// classifyRound1's structure" (invented form); a clean planner states the behavior
// rules and keeps "consistency" behavioral.
const INVENTED = {
  id: 'invented',
  sourceRel: 'src/round.js',
  // classifyRound1 = the anchor with a concrete structure the planner is tempted to
  // mirror. classifyRound2 = the target (nested, with a real behavior gap: it always
  // parks unresolved items; the mission adds the waive path).
  sourceContent:
`// Round-1 handler — ALREADY implemented. The mission asks round-2 to be handled
// consistently with how this handles round-1.
export function classifyRound1(failed, uncertain, allBenign) {
  if (failed.length > 0) {
    return 'park';
  } else if (uncertain.length > 0) {
    return allBenign ? 'waive' : 'park';
  }
  return 'complete';
}

// Round-2 handler — the mission updates this. Currently always parks unresolved items.
export function classifyRound2(failed, uncertain, allBenign) {
  if (failed.length > 0 || uncertain.length > 0) {
    if (failed.length === 0) {
      return 'park';
    } else {
      return 'park';
    }
  }
  return 'complete';
}
`,
  specTargetFiles: ['src/round.js'],
  // BEHAVIOR + a "be consistent with round-1" hook (the real trigger). NO explicit
  // shape/naming/ordering/log/line directive — "consistent" refers to decision logic.
  // Canonical hook = "consistent with round-1" (faithful to the real failed-121
  // spec's "same shape as round-1"). This is the hook with the clean matched
  // before/after on identical conditions: no-fix 0% clean → original fix 25% (N=20,
  // FAIL) → strengthened fix 100% (N=20, PASS). A separate generalization run with a
  // PARAPHRASED hook ("follows the same approach as round-1" / "aligned with how
  // round-1 is handled" — wording NOT present in the prompt fix's examples) also
  // PASSed (INVENTED 10/10), confirming the fix generalizes the principle rather than
  // keyword-matching. Both reports are under .harness-probe/.
  missionPlan:
    "In src/round.js, update classifyRound2(failed, uncertain, allBenign) so it "
    + "handles round 2 consistently with how classifyRound1 already handles round 1: "
    + "(1) if failed.length > 0, return 'park' (failed items always park, regardless of "
    + "the uncertain items); (2) if failed.length === 0 AND uncertain.length > 0 AND "
    + "allBenign is true, return 'waive'; (3) if failed.length === 0 AND "
    + "uncertain.length > 0 AND allBenign is false, return 'park'; (4) if there are no "
    + "failed and no uncertain items, return 'complete'. Keep it consistent with the "
    + "round-1 handler. The existing test suite must still pass.",
  behavioralRequirement:
    "classifyRound2(failed, uncertain, allBenign) must return: 'park' when "
    + "failed.length > 0; 'waive' when failed.length === 0 && uncertain.length > 0 && "
    + "allBenign === true; 'park' when failed.length === 0 && uncertain.length > 0 && "
    + "allBenign === false; 'complete' when there are no failed and no uncertain items. "
    + "It should be BEHAVIORALLY consistent with classifyRound1 (same waive/park "
    + "decision logic).",
  incidentalForm:
    "The mission specifies the four return-value rules and that round-2 be handled "
    + "CONSISTENTLY with round-1 — meaning the same waive/park DECISION LOGIC, NOT a "
    + "copy of round-1's code structure. If the description mandates a specific "
    + "conditional SHAPE (e.g. 'use the same if-else-if structure as classifyRound1', "
    + "'flat', 'not nested', 'single return'), a specific branch/statement ORDERING "
    + "with no behavioral effect, a specific local VARIABLE NAME, an exact LOG / message "
    + "string, or a line / placement position (e.g. 'before line N', 'at the top'), that "
    + "is planner-INVENTED incidental form the mission did not require.",
  contractualForm: '(none — the mission states only behavior + behavioral consistency; no code form is part of the deliverable)',
  judgeKind: 'invented', // judge returns { overspecified, evidence }
  expected: 'descriptions describe BEHAVIOR only — no planner-invented form',
};

// CASE DELIVERABLE — the form IS the deliverable. The exact log string is grepped by
// a downstream monitor, so it is a hard requirement. A correctly-behaving planner KEEPS
// the exact string. This guards against the fix OVER-correcting (stripping real
// contractual form as if it were incidental).
const DELIVERABLE = {
  id: 'deliverable',
  sourceRel: 'src/retry.js',
  sourceContent:
`// Existing retry module. attemptWithRetry runs an operation and logs each round.
export async function attemptWithRetry(op, maxRounds) {
  for (let round = 1; round <= maxRounds; round++) {
    try {
      return await op();
    } catch (err) {
      // (logging added by the mission)
    }
  }
  throw new Error('all retries exhausted');
}
`,
  specTargetFiles: ['src/retry.js'],
  missionPlan:
    "In src/retry.js, when attemptWithRetry begins its second attempt it must emit a "
    + "log line whose text is EXACTLY 'retry: round 2'. The monitoring dashboard greps "
    + "for this exact string, so the wording is a hard requirement — it must not be "
    + "paraphrased, reordered, or reworded.",
  behavioralRequirement:
    "On the second retry attempt, the code must emit a log line whose text is exactly "
    + "the string 'retry: round 2'.",
  incidentalForm: '(none — the exact string is contractual, not incidental)',
  contractualForm:
    "the EXACT log string 'retry: round 2' is part of the deliverable because a "
    + "downstream monitor greps for it verbatim; preserving the exact wording IS the "
    + "behavior the task must guarantee.",
  judgeKind: 'deliverable', // judge returns { formPreserved, evidence }
  expected: 'descriptions PRESERVE the contractual form',
};

const CASES = [INVENTED, DELIVERABLE];

// ── Judge schemas (forced structured output via jsonSchema) ───────────────────
const inventedJudgeSchema = {
  type: 'object',
  properties: {
    overspecified: { type: 'boolean' },
    evidence: { type: 'string' },
  },
  required: ['overspecified', 'evidence'],
};

const deliverableJudgeSchema = {
  type: 'object',
  properties: {
    formPreserved: { type: 'boolean' },
    evidence: { type: 'string' },
  },
  required: ['formPreserved', 'evidence'],
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

// ── Extract structured output from an SDK result (mirrors planner._extractJson primary path) ──
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
// against the case's stated requirement.
async function judgeDescription(sessionManager, logger, tokenTracker, testCase, description) {
  const schema = testCase.judgeKind === 'invented' ? inventedJudgeSchema : deliverableJudgeSchema;

  const systemPrompt =
    'You are a strict reviewer auditing a single generated TASK DESCRIPTION for whether '
    + 'it correctly separates required BEHAVIOR from incidental code FORM. Judge ONLY the '
    + 'description text you are given against the stated requirement. Output structured JSON '
    + 'matching the session jsonSchema. Be literal and evidence-based.';

  let prompt;
  if (testCase.judgeKind === 'invented') {
    prompt =
`A planner generated the TASK DESCRIPTION below for a code change.

TRUE behavioral requirement (the only real deliverable):
${testCase.behavioralRequirement}

PLANNER-INVENTED incidental form (the mission did NOT ask for any of this):
${testCase.incidentalForm}

TASK DESCRIPTION to judge:
"""
${description}
"""

Set "overspecified" = true if the description MANDATES any incidental code form the
behavioral requirement does not require — e.g. it requires a specific conditional
SHAPE ("flat", "if-else-if", "not nested", "single return", a ternary), a specific
branch/statement ORDERING, a specific local VARIABLE NAME, an exact LOG/message
string, or a line/placement position ("before line N", "at the top"). Set
"overspecified" = false if the description states the BEHAVIOR (which inputs map to
which return value) WITHOUT mandating such form. Naming the function classifyRound2,
naming the file src/round.js, or describing the input->output mapping is NOT
overspecification — that is behavior. Saying round-2 should be BEHAVIORALLY consistent
with round-1 (same waive/park decision) is NOT overspecification; but mandating that
round-2 COPY round-1's CODE STRUCTURE (a specific conditional shape such as if-else-if)
IS. Put the deciding phrase(s) from the description in "evidence".`;
  } else {
    prompt =
`A planner generated the TASK DESCRIPTION below for a change.

TRUE behavioral requirement (the deliverable):
${testCase.behavioralRequirement}

CONTRACTUAL form (this form IS part of the deliverable and MUST be preserved):
${testCase.contractualForm}

TASK DESCRIPTION to judge:
"""
${description}
"""

Set "formPreserved" = true if the description KEEPS the exact-string requirement —
i.e. it requires the log text to be exactly 'retry: round 2' (the literal string must
appear as a hard requirement, not paraphrased away). Set "formPreserved" = false if the
description drops, paraphrases, weakens, or genericizes the exact-string requirement
(e.g. "log the retry round" without the verbatim string). Put the deciding phrase(s)
from the description in "evidence".`;
  }

  const log = logger.createSessionLog(`probe-judge-${testCase.id}`);
  try {
    const spawnPromise = sessionManager.spawn({
      name: `probe-judge-${testCase.id}`,
      prompt,
      systemPrompt,
      model: JUDGE_MODEL,
      tools: [],
      jsonSchema: schema,
      maxBudget: config.budgets.planner,
    });
    logger.attachToSession(spawnPromise.handle, log, { role: 'judge', phase: 'probe' });
    const { handle, result } = await spawnPromise;
    await tokenTracker?.recordSession(`probe-judge-${testCase.id}`, 'planner', result, {
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
      const verdict = await judgeDescription(sessionManager, logger, tokenTracker, testCase, d.description);
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

// ── Drive a case N times, bucketing each generated description ─────────────────
async function tally(testCase) {
  const runs = [];
  // Per-description buckets across all runs.
  let totalDescriptions = 0;
  let wins = 0;       // INVENTED: clean (overspecified=false). DELIVERABLE: formPreserved=true.
  let losses = 0;     // the opposite
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
      let win;
      if (testCase.judgeKind === 'invented') {
        win = v.overspecified === false;
      } else {
        win = v.formPreserved === true;
      }
      if (win) wins++; else losses++;
      const verdictLabel = testCase.judgeKind === 'invented'
        ? `overspecified=${v.overspecified}`
        : `formPreserved=${v.formPreserved}`;
      console.log(
        `  [${testCase.id} #${i}] task ${d.taskId}: ${win ? 'WIN ' : 'LOSS'}  ${verdictLabel}  `
        + `evidence="${String(v.evidence ?? '').slice(0, 120)}"`,
      );
    }

    runs.push(run);
  }

  return {
    runs,
    counts: {
      totalDescriptions,
      wins,
      losses,
      judgeErrors,
      runErrors,
      runsWithNoDescription,
    },
  };
}

// ── Drive both cases ─────────────────────────────────────────────────────────
console.log(`Probe: planner over-specification (failed-121 planner fix). N=${N} planner runs per case.`);
console.log(`plannerModel=${config.execution.plannerModel}  judgeModel=${JUDGE_MODEL} (independent)\n`);

const results = {};
for (const c of CASES) {
  console.log(`── Case ${c.id} (expected: ${c.expected}) ──`);
  results[c.id] = await tally(c);
  console.log('');
}

// ── Summary + persistence ────────────────────────────────────────────────────
// Gate on a TRUE per-description pass RATE (>= 0.8). The denominator is the number of
// SUCCESSFULLY-JUDGED descriptions (wins + losses) — NOT totalDescriptions, because a
// transient judge SDK error must not count as a loss: it would deflate the rate and
// manufacture a false-negative efficacy verdict even when every actually-judged
// description was clean. judgeErrors/runErrors are reported separately, and a run with
// zero successful judgments is a FAIL (no evidence is not a pass). (Pre-fix it gated on
// wins/totalDescriptions, which folded judge errors into the denominator.)
const RATE = 0.8;

const invented = results[INVENTED.id].counts;
const deliverable = results[DELIVERABLE.id].counts;

const inventedClean = invented.wins;
const deliverablePreserved = deliverable.wins;

// Successfully-judged = wins + losses (judge/run errors excluded from the denominator).
const inventedJudged = invented.wins + invented.losses;
const deliverableJudged = deliverable.wins + deliverable.losses;

const inventedRate = inventedJudged > 0 ? inventedClean / inventedJudged : 0;
const deliverableRate = deliverableJudged > 0 ? deliverablePreserved / deliverableJudged : 0;

const inventedOk = inventedJudged > 0 && inventedRate >= RATE;
const deliverableOk = deliverableJudged > 0 && deliverableRate >= RATE;
const success = inventedOk && deliverableOk;

const pct = (r) => `${(r * 100).toFixed(1)}%`;

console.log('════════════════════════════════════════════');
console.log(
  `INVENTED     behavior-only (no invented form): ${inventedClean}/${inventedJudged} judged  (${pct(inventedRate)})   `
  + `(losses: ${invented.losses}, judgeErrors: ${invented.judgeErrors}, runErrors: ${invented.runErrors}, emitted: ${invented.totalDescriptions})`,
);
console.log(
  `DELIVERABLE  form preserved                  : ${deliverablePreserved}/${deliverableJudged} judged  (${pct(deliverableRate)})   `
  + `(losses: ${deliverable.losses}, judgeErrors: ${deliverable.judgeErrors}, runErrors: ${deliverable.runErrors}, emitted: ${deliverable.totalDescriptions})`,
);
console.log('');
console.log(`Headline = PLANNER-DIRECT (no escalation path in planMission).`);
console.log(`Success criterion: INVENTED clean-rate >=${pct(RATE)}  AND  DELIVERABLE form-preserved-rate >=${pct(RATE)}  (per SUCCESSFULLY-JUDGED description; zero judged = FAIL)`);
console.log(`Result: ${success ? 'PASS' : 'FAIL'}`);
if (invented.judgeErrors > 0 || deliverable.judgeErrors > 0) {
  console.log(`NOTE: ${invented.judgeErrors + deliverable.judgeErrors} judge error(s) excluded from the rate denominator — inspect the persisted report if the judged count is low.`);
}
console.log('════════════════════════════════════════════');

const reportDir = path.join(repoRoot, '.harness-probe');
fs.mkdirSync(reportDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `probe-planner-overspecify-${stamp}.json`);
const report = {
  probe: 'planner-overspecify-failed-121',
  timestamp: new Date().toISOString(),
  N,
  passRate: RATE,
  plannerModel: config.execution.plannerModel,
  judgeModel: JUDGE_MODEL,
  successCriterion: 'INVENTED clean-rate >= 0.8 AND DELIVERABLE form-preserved-rate >= 0.8 (per SUCCESSFULLY-JUDGED description = wins+losses; zero judged = FAIL)',
  headline: {
    invented_clean: inventedClean,
    invented_judged: inventedJudged,
    invented_total_descriptions: invented.totalDescriptions,
    invented_judge_errors: invented.judgeErrors,
    invented_clean_rate: inventedRate,
    deliverable_form_preserved: deliverablePreserved,
    deliverable_judged: deliverableJudged,
    deliverable_total_descriptions: deliverable.totalDescriptions,
    deliverable_judge_errors: deliverable.judgeErrors,
    deliverable_form_preserved_rate: deliverableRate,
    success,
  },
  cases: {
    [INVENTED.id]: {
      expected: INVENTED.expected,
      missionPlan: INVENTED.missionPlan,
      behavioralRequirement: INVENTED.behavioralRequirement,
      incidentalForm: INVENTED.incidentalForm,
      contractualForm: INVENTED.contractualForm,
      specTargetFiles: INVENTED.specTargetFiles,
      counts: results[INVENTED.id].counts,
      runs: results[INVENTED.id].runs,
    },
    [DELIVERABLE.id]: {
      expected: DELIVERABLE.expected,
      missionPlan: DELIVERABLE.missionPlan,
      behavioralRequirement: DELIVERABLE.behavioralRequirement,
      incidentalForm: DELIVERABLE.incidentalForm,
      contractualForm: DELIVERABLE.contractualForm,
      specTargetFiles: DELIVERABLE.specTargetFiles,
      counts: results[DELIVERABLE.id].counts,
      runs: results[DELIVERABLE.id].runs,
    },
  },
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nFull report persisted: ${reportPath}`);

process.exit(success ? 0 : 1);
