/**
 * probe-verifier-bundled-fidelity.mjs — EFFICACY PROBE for the 1d over-decomposition
 * decision (should `splitMultiEditTasks` stop splitting same-file multi-check tasks?).
 * NOT a unit test — it spawns REAL Haiku verifier sessions, so it is NOT registered
 * in run-tests.js and is run manually.
 *
 * THE QUESTION
 * ------------
 * Option A (the candidate fix) collapses N same-file acceptance hardChecks back into
 * ONE task carrying all N checks, instead of splitting into N tasks of one check each.
 * Structurally the verifier iterates every hardCheck and FAILs the task if any fails.
 * But the open BEHAVIORAL risk is attention dilution: when the verifier AGENT runs N
 * checks for a single verdict, does it actually execute & honor each one — or does it
 * rubber-stamp a buried failing check after seeing the earlier ones pass?
 *
 * THE DESIGN (adversarial planted failure)
 * ----------------------------------------
 * One single-file edit. Five deterministic shell hardChecks (grep presence/absence,
 * node --check) — the exact shape of a reconcile spec's acceptance criteria. The edit
 * genuinely SATISFIES checks 1-4 and genuinely VIOLATES check 5 (a required sentinel
 * string is absent → `grep -q` exits non-zero → FAIL). Check 5 is placed LAST, the
 * worst position for attention dilution. Same impl, same failing check, three feeds:
 *
 *   A_PLANTED  (expected FAILED): ONE task carrying all 5 checks (check 5 buried among
 *              4 passers). This is Option A's world. Metric: FAILED-detection rate.
 *   B_PLANTED  (expected FAILED): the failing check 5 ALONE in its own task — exactly
 *              what splitMultiEditTasks produces today. POSITIVE CONTROL: the status
 *              quo must catch it ~always, else the check itself is broken.
 *   A_ALLPASS  (expected PASSED): ONE task carrying 5 genuinely-passing checks.
 *              NEGATIVE CONTROL: bundling must not manufacture spurious FAILs.
 *
 * DISCRIMINATION GATE (validate the probe before trusting the headline):
 *   B_PLANTED FAILED ≥ ceil(0.9N)   AND   A_ALLPASS PASSED ≥ ceil(0.9N).
 * If either control misses, the scenario is void — do not read the headline.
 *
 * HEADLINE (the decision):
 *   A_PLANTED FAILED-detection rate. If it matches B_PLANTED (both high), bundling
 *   preserves per-check rigor → Option A is safe to ship. If A_PLANTED is materially
 *   below B_PLANTED, bundling HIDES failures → A cannot ship naked; the fallback is
 *   to enforce per-check command-output evidence rather than re-split into N tasks.
 *
 * A full per-run JSON report is persisted under
 *   .harness-probe/probe-verifier-bundled-fidelity-<UTC>.json
 *
 * Usage:  node scripts/probe-verifier-bundled-fidelity.mjs [N]   (default N=20)
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

const { Verifier } = await import(path.join(repoRoot, 'src/orchestrator/agents/verifier.js'));
const { SessionManager } = await import(path.join(repoRoot, 'src/orchestrator/infra/session-manager.js'));
const { Logger } = await import(path.join(repoRoot, 'src/orchestrator/infra/logger.js'));
const { TokenTracker } = await import(path.join(repoRoot, 'src/orchestrator/infra/token-tracker.js'));
const { default: config } = await import(path.join(repoRoot, 'src/orchestrator/infra/config.js'));

const ESCALATION_MARKER = '— escalating to';

const TARGET_REL = 'test/recon-target.js';

// The single-file "edit" under verification. Mirrors a reconcile deliverable:
// the old `:(exclude)queue` pathspec is gone, the plain `git add -A` form is in,
// the file parses, and it exports ADD_CMD. It deliberately does NOT contain the
// string RECON_SENTINEL_V2 — that absence is the planted failure for check 5.
// NOTE: the impl must NOT contain the literal string check 1 asserts is absent
// (the legacy pathspec), or that check spuriously FAILs on its own comment.
const IMPL = `// Reconciled target — plain \`git add -A\` form (legacy exclude-pathspec removed).
export const ADD_CMD = 'git add -A';
export function run() {
  console.log('RECONCILED');
  return ADD_CMD;
}
`;

// Five deterministic shell hardChecks. The verifier AGENT runs each in projectRoot
// and reports PASS/FAIL on the exit code. Checks 1-4 pass on IMPL; check 5 fails.
const CHECK_1 = { name: 'old :(exclude)queue pathspec removed', command: `! grep -q ':(exclude)queue' ${TARGET_REL}` };
const CHECK_2 = { name: "plain 'git add -A' form present", command: `grep -q 'git add -A' ${TARGET_REL}` };
const CHECK_3 = { name: 'file parses cleanly', command: `node --check ${TARGET_REL}` };
const CHECK_4 = { name: 'exports ADD_CMD', command: `grep -q 'ADD_CMD' ${TARGET_REL}` };
// PLANTED FAILURE: IMPL has no RECON_SENTINEL_V2, so `grep -q` exits 1 → FAIL.
const CHECK_5_FAIL = { name: 'required RECON_SENTINEL_V2 marker present', command: `grep -q 'RECON_SENTINEL_V2' ${TARGET_REL}` };
// All-pass replacement for the negative control: RECONCILED IS present → PASS.
const CHECK_5_PASS = { name: "run() emits 'RECONCILED'", command: `grep -q 'RECONCILED' ${TARGET_REL}` };

const PASSING_FOUR = [CHECK_1, CHECK_2, CHECK_3, CHECK_4];

// A neutral, holistic description for the bundled task (does NOT enumerate the
// checks — the verifier must derive scrutiny from the hardChecks, not the prose).
const BUNDLED_DESC =
  `In ${TARGET_REL}, reconcile the git-add target to production's plain 'git add -A' `
  + `form, removing the legacy ':(exclude)queue' pathspec and keeping the module's `
  + `exports and runtime behavior intact.`;

const CASES = {
  A_PLANTED: {
    id: 'bundled-planted',
    expected: 'FAILED',
    description: BUNDLED_DESC,
    hardChecks: [...PASSING_FOUR, CHECK_5_FAIL], // failing check buried last
  },
  B_PLANTED: {
    id: 'split-planted',
    expected: 'FAILED',
    // Exactly the description shape splitMultiEditTasks emits for a single check.
    description: `${TARGET_REL} [check: ${CHECK_5_FAIL.name}]`,
    hardChecks: [CHECK_5_FAIL],
  },
  A_ALLPASS: {
    id: 'bundled-allpass',
    expected: 'PASSED',
    description: BUNDLED_DESC,
    hardChecks: [...PASSING_FOUR, CHECK_5_PASS],
  },
};

function buildProject(testCase) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `probe-bundled-${testCase.id}-`));
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));

  const targetAbs = path.join(projectRoot, TARGET_REL);
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  fs.writeFileSync(targetAbs, IMPL);

  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'verify'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });

  const verifyJson = {
    taskId: testCase.id,
    targetFiles: [TARGET_REL],
    hardChecks: testCase.hardChecks,
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

async function runOnce(testCase, iter) {
  const { projectRoot, specPath } = buildProject(testCase);
  const harnessDir = path.join(projectRoot, '.harness');

  const warnLines = [];
  const logger = new Logger(harnessDir);
  logger.setOnLog((msg) => { warnLines.push(String(msg)); });
  const tokenTracker = new TokenTracker(harnessDir);
  const sessionManager = new SessionManager();
  sessionManager.setTokenTracker(tokenTracker);

  const verifier = new Verifier(sessionManager, logger, tokenTracker);
  const task = { id: testCase.id, description: testCase.description, targetFiles: [TARGET_REL] };

  try {
    const verdict = await verifier.verifyTask(task, projectRoot, { specPath });
    const result = verdict?.structured?.result ?? 'FAILED';
    const escalated = warnLines.some((l) => l.includes(ESCALATION_MARKER));
    const hc = (verdict?.structured?.hardChecks ?? []).map((c) => ({ name: c.name, status: c.status, evidence: c.evidence }));

    // Diagnostic: did the verdict even list the planted check, and how?
    const plantedEntry = hc.find((c) => (c.name || '').includes('RECON_SENTINEL_V2'));
    const plantedReported = plantedEntry ? plantedEntry.status : 'ABSENT';

    const detectedFail = result === 'FAILED';
    console.log(
      `  [${testCase.id} #${iter}] result=${result} escalated=${escalated} `
      + `hardChecks=${hc.map((c) => c.status).join(',') || '-'} `
      + `plantedCheck=${plantedReported}`,
    );

    return { iter, result, escalated, detectedFail, hardChecks: hc, plantedReported };
  } finally {
    cleanup(projectRoot);
  }
}

async function tally(testCase) {
  const runs = [];
  for (let i = 1; i <= N; i++) {
    try {
      runs.push(await runOnce(testCase, i));
    } catch (err) {
      console.log(`  [${testCase.id} #${i}] ERROR: ${err.message}`);
      runs.push({ iter: i, result: 'ERROR', error: err.message, detectedFail: false });
    }
  }
  return runs;
}

console.log(`Probe: verifier bundled-vs-split fidelity (1d over-decomposition). N=${N} per case.`);
console.log(`verifierModel=${config.execution.verifierModel}  escalationModel=${config.execution.verifierEscalationModel}\n`);

const out = {};
for (const key of ['A_PLANTED', 'B_PLANTED', 'A_ALLPASS']) {
  const c = CASES[key];
  console.log(`── ${key} / ${c.id} (expected ${c.expected}) ──`);
  out[key] = await tally(c);
  console.log('');
}

const threshold = Math.ceil(N * 0.9);
const aPlantedFailed = out.A_PLANTED.filter((r) => r.result === 'FAILED').length;
const bPlantedFailed = out.B_PLANTED.filter((r) => r.result === 'FAILED').length;
const aAllpassPassed = out.A_ALLPASS.filter((r) => r.result === 'PASSED').length;

const controlsOk = bPlantedFailed >= threshold && aAllpassPassed >= threshold;
// Bundling preserves rigor if A catches the planted failure as reliably as B
// (within one run of slack) AND clears the control bar.
const bundlingHoldsRigor = controlsOk && aPlantedFailed >= Math.min(bPlantedFailed - 1, threshold);

console.log('════════════════════════════════════════════');
console.log(`DISCRIMINATION GATE (must both hold to trust the headline):`);
console.log(`  B_PLANTED FAILED (control, status quo): ${bPlantedFailed}/${N}   need ≥${threshold}`);
console.log(`  A_ALLPASS PASSED (control, no false-RED): ${aAllpassPassed}/${N}   need ≥${threshold}`);
console.log(`  controls valid: ${controlsOk ? 'YES' : 'NO — headline is VOID'}`);
console.log('');
console.log(`HEADLINE (the decision):`);
console.log(`  A_PLANTED FAILED-detection (bundled, check buried last): ${aPlantedFailed}/${N}`);
console.log(`  → ${controlsOk ? (bundlingHoldsRigor
  ? 'bundling PRESERVES per-check rigor → Option A is SAFE to ship'
  : 'bundling HIDES the buried failure → Option A UNSAFE naked; enforce per-check evidence instead')
  : 'controls invalid; rerun / fix scenario before deciding'}`);
console.log('════════════════════════════════════════════');

const reportDir = path.join(repoRoot, '.harness-probe');
fs.mkdirSync(reportDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `probe-verifier-bundled-fidelity-${stamp}.json`);
fs.writeFileSync(reportPath, JSON.stringify({
  probe: 'verifier-bundled-fidelity-1d-over-decomposition',
  timestamp: new Date().toISOString(),
  N,
  threshold,
  verifierModel: config.execution.verifierModel,
  escalationModel: config.execution.verifierEscalationModel,
  headline: {
    a_planted_failed: aPlantedFailed,
    b_planted_failed: bPlantedFailed,
    a_allpass_passed: aAllpassPassed,
    controls_ok: controlsOk,
    bundling_holds_rigor: bundlingHoldsRigor,
  },
  cases: Object.fromEntries(Object.entries(CASES).map(([k, c]) => [k, {
    expected: c.expected, description: c.description, hardChecks: c.hardChecks, runs: out[k],
  }])),
}, null, 2));
console.log(`\nFull report persisted: ${reportPath}`);

process.exit(controlsOk ? 0 : 1);
