/**
 * probe-verifier-strictness.mjs — EFFICACY PROBE for the verifier strictness fix
 * (failed-121). NOT a unit test — it spawns REAL Haiku verifier sessions, so it is
 * NOT registered in run-tests.js and is run manually.
 *
 * The fix (verifier.js prompt, behavior-equivalence based): a taskScopeCheck
 * judges required BEHAVIOR + SCOPE, not the code's incidental FORM. A form
 * deviation (nested vs flat conditional, naming, comment style) is NOT a failure
 * ONLY when the verifier confirms it preserves behavior — a covering hardCheck
 * passes, or the verifier reads the code and confirms equivalence. Crucially the
 * burden is on CONFIRMING equivalence: a behavior-affecting deviation that can't
 * be confirmed safe (ordering with runtime consequence, a required side effect /
 * log / error a caller may depend on) is a FUNCTIONAL concern, NOT cosmetic.
 *
 * This probe constructs realistic single-task verifications in temp dirs and runs
 * the REAL Verifier (real SessionManager + Haiku, real logger, real tokenTracker)
 * against each, N times, bucketing every run into one of three outcomes:
 *
 *   - haikuDirectPass : Haiku itself returned PASSED with NO escalation.
 *   - escalatedPass   : Haiku emitted a schema-invalid / empty verdict, the
 *                       verifier escalated to Sonnet, and the FINAL verdict PASSED.
 *   - fail            : final verdict FAILED.
 *
 * The headline metric for the PROMPT CHANGE's effect is the HAIKU-DIRECT rate —
 * an escalation PASS exercises Sonnet + the escalation feature, NOT Haiku's
 * judgment under the new prompt. We report the two separately, never mixed.
 *
 *   Case CC (cosmetic-correct, EXPECTED PASSED):
 *     The target ACHIEVES the required behavior; its hardCheck FULLY covers that
 *     behavior (a multi-row truth table) and PASSES. The ONLY deviation from the
 *     task's phrasing is incidental code FORM with ZERO runtime consequence
 *     (nested/intermediate-variable shape vs the requested flat single-return,
 *     plus local-variable naming). No log / ordering / side-effect requirement
 *     exists, so nothing the hardCheck fails to bind can carry behavior. A FAIL
 *     here is genuine cosmetic over-strictness. Headline want: high Haiku-direct
 *     PASS rate.
 *
 *   Case OR (over-relaxation control, EXPECTED FAILED):
 *     The task requires BOTH a return value AND a side effect (throw a specific
 *     error on the invalid branch). The hardCheck asserts ONLY the happy-path
 *     return value, so it PASSES even though the impl OMITS the required throw —
 *     a real, hardCheck-UNCOVERED functional defect. The new rule must STILL FAIL
 *     this (a behavior-affecting omission it cannot confirm safe is functional,
 *     not cosmetic). If the verifier PASSES Case OR, that IS the over-relaxation
 *     failure mode we are probing for.
 *
 * Success criterion (printed): CC Haiku-direct PASS ≥ ceil(0.8 N)  AND
 *                              OR FAIL              ≥ ceil(0.8 N).
 *
 * A full per-run JSON report is persisted under
 *   .harness-probe/probe-verifier-strictness-<UTC>.json
 * (path printed) so the numbers are independently reproducible.
 *
 * Usage:  node scripts/probe-verifier-strictness.mjs [N]   (default N=20)
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
const { Verifier } = await import(path.join(repoRoot, 'src/orchestrator/agents/verifier.js'));
const { SessionManager } = await import(path.join(repoRoot, 'src/orchestrator/infra/session-manager.js'));
const { Logger } = await import(path.join(repoRoot, 'src/orchestrator/infra/logger.js'));
const { TokenTracker } = await import(path.join(repoRoot, 'src/orchestrator/infra/token-tracker.js'));
const { default: config } = await import(path.join(repoRoot, 'src/orchestrator/infra/config.js'));

// The substring the verifier emits via logger.warn when it escalates to the
// stronger model (verifier.js: `... — escalating to ${verifierEscalationModel}`).
// Detecting it per-run lets us separate a Haiku-direct verdict from a
// Sonnet-rescued one.
const ESCALATION_MARKER = '— escalating to';

// ── Case fixtures ────────────────────────────────────────────────────────────
//
// Each case is a self-contained ESM module placed at the target path. The
// hardCheck runs `node --input-type=module -e <assert>` from projectRoot and
// exits 0 (PASS) or non-zero (FAIL) on the module's ACTUAL behavior.

// CASE CC — clean cosmetic. Required behavior: classify(n) returns 'lo' for n<10,
// 'hi' otherwise. The TASK asks for a FLAT single-return (ternary) form. The IMPL
// is behavior-identical but written with a nested if/else and an intermediate
// variable named `bucket` — the ONLY deviations are conditional SHAPE and local
// NAME, both with zero runtime consequence. The hardCheck asserts the full truth
// table across the boundary, so a passing hardCheck FULLY covers the behavior and
// the only thing left to object to is form.
const CC = {
  id: 'probe-cc',
  targetRel: 'src/bucket.js',
  description:
    "Implement classify(n) in src/bucket.js. It must return the string 'lo' when "
    + "n is less than 10, and 'hi' when n is greater than or equal to 10. Write it "
    + "as a FLAT single-return statement (a single `return` with a ternary). Do "
    + "NOT use a nested if/else or an intermediate variable.",
  impl:
`// IMPL: behavior-identical to the requested flat ternary, but written with a
// nested if/else and an intermediate variable. The ONLY deviations from the task
// phrasing are conditional SHAPE and local variable NAME — neither has any
// runtime consequence. The behavior (n<10 => 'lo', else 'hi') is exactly right.
export function classify(n) {
  let bucket;
  if (n < 10) {
    bucket = 'lo';
  } else {
    bucket = 'hi';
  }
  return bucket;
}
`,
  // FULL behavior coverage across the boundary — a passing hardCheck leaves only
  // form to object to.
  hardCheckCommand:
    `node --input-type=module -e "import { classify } from './src/bucket.js'; `
    + `import assert from 'assert'; `
    + `assert.strictEqual(classify(0), 'lo'); `
    + `assert.strictEqual(classify(9), 'lo'); `
    + `assert.strictEqual(classify(10), 'hi'); `
    + `assert.strictEqual(classify(11), 'hi'); `
    + `assert.strictEqual(classify(-3), 'lo'); `
    + `console.log('OK');"`,
  hardCheckName: 'classify boundary truth table (n<10 => lo, n>=10 => hi)',
  expected: 'PASSED',
};

// CASE OR — over-relaxation control. Required behavior is TWO-PART: withdraw(bal,
// amt) must (1) return bal-amt for a valid withdrawal AND (2) THROW an Error whose
// message contains 'insufficient funds' when amt > bal. The hardCheck asserts ONLY
// the happy-path return (a valid withdrawal), so it PASSES. The IMPL OMITS the
// required throw — on overdraw it returns a negative number instead of throwing —
// a REAL functional defect the hardCheck never binds. The new rule must STILL FAIL
// this: a required side effect a caller depends on, that the verifier cannot
// confirm is satisfied, is functional, not cosmetic. A PASS here is over-relaxation.
const OR = {
  id: 'probe-or',
  targetRel: 'src/account.js',
  description:
    "Implement withdraw(balance, amount) in src/account.js. On a valid withdrawal "
    + "(amount <= balance) it must return balance - amount. CRITICAL: when amount "
    + "is greater than balance it MUST throw an Error whose message contains "
    + "'insufficient funds' — callers rely on this throw to block overdrafts. It "
    + "must NOT silently return a negative balance.",
  impl:
`// IMPL: BROKEN on the uncovered branch. The happy-path return is correct, but the
// REQUIRED overdraft throw is OMITTED — on amount > balance it silently returns a
// negative number instead of throwing 'insufficient funds'. The hardCheck below
// only exercises the happy path, so this defect is hardCheck-UNCOVERED.
export function withdraw(balance, amount) {
  return balance - amount;
}
`,
  // Happy-path ONLY — deliberately does NOT exercise the overdraft throw, so it
  // PASSES despite the omitted side effect.
  hardCheckCommand:
    `node --input-type=module -e "import { withdraw } from './src/account.js'; `
    + `import assert from 'assert'; `
    + `assert.strictEqual(withdraw(100, 30), 70); `
    + `assert.strictEqual(withdraw(50, 50), 0); `
    + `console.log('OK');"`,
  hardCheckName: 'withdraw happy-path return (balance - amount)',
  expected: 'FAILED',
};

const CASES = [CC, OR];

// ── Per-case temp project construction ───────────────────────────────────────
function buildProject(testCase) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `probe-verifier-${testCase.id}-`));

  // The impl modules use ESM `export`; mark the temp project as ESM so the
  // hardCheck's `node --input-type=module -e "import ..."` can import a bare `.js`
  // target (without this a `.js` defaults to CommonJS and the import throws —
  // which would FAIL a hardCheck on a module-system error, not behavior).
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));

  const targetAbs = path.join(projectRoot, testCase.targetRel);
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.writeFileSync(targetAbs, testCase.impl);

  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'verify'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });

  const verifyJson = {
    taskId: testCase.id,
    targetFiles: [testCase.targetRel],
    hardChecks: [{ name: testCase.hardCheckName, command: testCase.hardCheckCommand }],
    testCases: [],
  };
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${testCase.id}.json`),
    JSON.stringify(verifyJson, null, 2),
  );

  const specPath = path.join(projectRoot, 'spec.md');
  fs.writeFileSync(specPath, `# Spec\n\nGoal: ${testCase.description}\n`);

  return { projectRoot, specPath };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Run one verification, bucketing the outcome ──────────────────────────────
//
// Returns { bucket, result, escalated, taskScopeChecks, hardChecks }.
//   bucket ∈ 'haikuDirectPass' | 'escalatedPass' | 'fail' | 'error'
async function runOnce(testCase, iter) {
  const { projectRoot, specPath } = buildProject(testCase);
  const harnessDir = path.join(projectRoot, '.harness');

  // Capture the verifier's warn stream via the Logger's setOnLog seam. When a
  // callback is registered the Logger stops printing to console.warn itself, so
  // the callback forwards to console.warn to preserve visibility AND records every
  // line — we then scan for the escalation marker to know whether Sonnet rescued.
  const warnLines = [];
  let logger, tokenTracker, sessionManager;
  try {
    logger = new Logger(harnessDir);
    logger.setOnLog((msg) => { warnLines.push(String(msg)); console.warn(msg); });
    tokenTracker = new TokenTracker(harnessDir);
    sessionManager = new SessionManager();
    sessionManager.setTokenTracker(tokenTracker);
  } catch (err) {
    cleanup(projectRoot);
    throw new Error(`harness construction failed for ${testCase.id}: ${err.stack || err.message}`);
  }

  const verifier = new Verifier(sessionManager, logger, tokenTracker);
  const task = {
    id: testCase.id,
    description: testCase.description,
    targetFiles: [testCase.targetRel],
  };

  try {
    const verdict = await verifier.verifyTask(task, projectRoot, { specPath });
    const result = verdict?.structured?.result ?? 'FAILED';
    const escalated = warnLines.some((l) => l.includes(ESCALATION_MARKER));
    const tsc = (verdict?.structured?.taskScopeChecks ?? []).map((c) => ({
      description: c.description, status: c.status, evidence: c.evidence,
    }));
    const hc = (verdict?.structured?.hardChecks ?? []).map((c) => ({
      name: c.name, status: c.status,
    }));

    let bucket;
    if (result === 'PASSED' && !escalated) bucket = 'haikuDirectPass';
    else if (result === 'PASSED' && escalated) bucket = 'escalatedPass';
    else bucket = 'fail';

    console.log(
      `  [${testCase.id} #${iter}] result=${result}  escalated=${escalated}  bucket=${bucket}  `
      + `hardChecks=${hc.map((c) => c.status).join(',') || '-'}  `
      + `taskScopeChecks=${tsc.map((c) => c.status).join(',') || '-'}`,
    );
    for (const c of tsc.filter((c) => c.status === 'FAIL')) {
      console.log(`      FAIL taskScopeCheck: ${c.description} — ${c.evidence}`);
    }

    return { iter, bucket, result, escalated, taskScopeChecks: tsc, hardChecks: hc };
  } finally {
    cleanup(projectRoot);
  }
}

// ── Drive a case N times ─────────────────────────────────────────────────────
async function tally(testCase) {
  const runs = [];
  const counts = { haikuDirectPass: 0, escalatedPass: 0, fail: 0, error: 0 };
  for (let i = 1; i <= N; i++) {
    let run;
    try {
      run = await runOnce(testCase, i);
    } catch (err) {
      console.log(`  [${testCase.id} #${i}] ERROR: ${err.message}`);
      run = { iter: i, bucket: 'error', result: 'ERROR', escalated: false, error: err.message };
    }
    counts[run.bucket] = (counts[run.bucket] ?? 0) + 1;
    runs.push(run);
  }
  return { counts, runs };
}

// ── Drive both cases ─────────────────────────────────────────────────────────
console.log(`Probe: verifier strictness (failed-121 fix). N=${N} per case.`);
console.log(`verifierModel=${config.execution.verifierModel}  escalationModel=${config.execution.verifierEscalationModel}\n`);

const results = {};
for (const c of CASES) {
  console.log(`── Case ${c.id} (expected ${c.expected}) ──`);
  results[c.id] = await tally(c);
  console.log('');
}

// ── Summary + persistence ────────────────────────────────────────────────────
const threshold = Math.ceil(N * 0.8);
const cc = results[CC.id].counts;
const or = results[OR.id].counts;

// Headline: CC's Haiku-DIRECT pass rate is the prompt change's true effect.
const ccHaikuDirect = cc.haikuDirectPass;
const ccWithEscalation = cc.haikuDirectPass + cc.escalatedPass;
const orFail = or.fail;

const ccOk = ccHaikuDirect >= threshold;
const orOk = orFail >= threshold;
const success = ccOk && orOk;

console.log('════════════════════════════════════════════');
console.log(`CC  Haiku-direct PASSED : ${ccHaikuDirect}/${N}   (with-escalation: ${ccWithEscalation}/${N};  fail: ${cc.fail}, error: ${cc.error})`);
console.log(`OR  FAILED (defect caught): ${orFail}/${N}   (haiku-direct pass: ${or.haikuDirectPass}, escalated pass: ${or.escalatedPass}, error: ${or.error})`);
console.log('');
console.log(`Headline metric = CC Haiku-DIRECT pass rate (the prompt's true effect on Haiku).`);
console.log(`Success criterion: CC Haiku-direct PASSED ≥${threshold}/${N}  AND  OR FAILED ≥${threshold}/${N}`);
console.log(`Result: ${success ? 'PASS' : 'FAIL'}`);
console.log('════════════════════════════════════════════');

// Persist a full, independently-reproducible report.
const reportDir = path.join(repoRoot, '.harness-probe');
fs.mkdirSync(reportDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `probe-verifier-strictness-${stamp}.json`);
const report = {
  probe: 'verifier-strictness-failed-121',
  timestamp: new Date().toISOString(),
  N,
  threshold,
  verifierModel: config.execution.verifierModel,
  escalationModel: config.execution.verifierEscalationModel,
  successCriterion: 'CC Haiku-direct PASSED >= ceil(0.8N) AND OR FAILED >= ceil(0.8N)',
  headline: {
    cc_haiku_direct_pass: ccHaikuDirect,
    cc_with_escalation_pass: ccWithEscalation,
    or_failed: orFail,
    success,
  },
  cases: {
    [CC.id]: {
      expected: CC.expected,
      description: CC.description,
      hardCheckName: CC.hardCheckName,
      hardCheckCommand: CC.hardCheckCommand,
      impl: CC.impl,
      counts: results[CC.id].counts,
      runs: results[CC.id].runs,
    },
    [OR.id]: {
      expected: OR.expected,
      description: OR.description,
      hardCheckName: OR.hardCheckName,
      hardCheckCommand: OR.hardCheckCommand,
      impl: OR.impl,
      counts: results[OR.id].counts,
      runs: results[OR.id].runs,
    },
  },
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nFull report persisted: ${reportPath}`);

process.exit(success ? 0 : 1);
