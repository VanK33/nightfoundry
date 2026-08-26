#!/usr/bin/env node
/**
 * test-cli-park.js — Track P P1: `cc-orch park list/show/resolve` CLI
 * (spec: p1-park-foundation.spec.md / .json, Scope item 3 / AC7).
 *
 * Written by the INDEPENDENT test author against the spec contract only —
 * before the implementation exists. The CLI is exercised end-to-end through
 * the registered command surface (spawning `node src/cli/index.js park …`
 * with cwd = a temp project root), so these tests are agnostic to the
 * implementer's internal export names and prove registration in
 * src/cli/index.js at the same time. At a pre-feature HEAD every case fails
 * behaviorally ("Unknown command: park", exit 1).
 *
 * Coverage (per spec Scope item 3 / AC7):
 *   TC1  — park list: empty queue → no crash (exit 0)
 *   TC2  — park list: filters to parked + halted-review only; shows slug,
 *          site, question summary
 *   TC3  — park list: scene-less halted-review entry listed with a
 *          placeholder, not a crash
 *   TC4  — park show: full scene + BOTH queue spec paths; no divergence
 *          warning when nothing diverged (control)
 *   TC5  — park show: divergence warning when spec.md mtime is newer than
 *          parkedAt but spec.json is untouched
 *   TC6  — park resolve --requeue (+ --note): status → 'pending', resolution
 *          {action:'requeue', at, note} written; previousResolutions untouched
 *   TC7  — park resolve --waive: status → 'pending', resolution action 'waive'
 *   TC8  — park resolve --reject: status → 'rejected' (terminal)
 *   TC9  — halted-review verbs: --requeue → 'pending'; --reject → 'rejected';
 *          --waive REFUSED with an explanatory error, state unchanged
 *   TC10 — illegal transition: resolving a 'pending'-status entry is refused,
 *          state unchanged
 *   TC11 — scene-less resolve refused (missing AND corrupt park.json): error,
 *          status unchanged, no scene invented
 *   TC12 — divergence warning also fires on resolve --requeue (warn, don't
 *          block: the resolve still completes)
 *   TC13 — GAP TEST: divergence warning against a PIPELINE-PRODUCED park (no
 *          mtime backdating anywhere): the real batchResume parks the entry,
 *          then a real spec.md edit (spec.json untouched) must trigger the
 *          warning on show AND on resolve --requeue; editing BOTH files
 *          produces no warning (control). Discriminates against an
 *          implementation whose park write rewrites both spec files, making
 *          the warning condition structurally unsatisfiable in real use
 *          (TC5/TC12 above backdate mtimes on hand-written scenes and cannot
 *          catch that).
 *   TC14 — GAP TEST (live-dogfood blind spot #3): damaged entry (spec.md
 *          deleted) — list exits 0 with a placeholder line, show degrades
 *          gracefully (no raw ENOENT), resolve refuses with an explanatory
 *          error and leaves state unchanged.
 *   TC15 — halted-analyzer entries (analyzer-closure spec, AC9): list
 *          includes them, resolve accepts --requeue/--reject and refuses
 *          --waive with an explanatory error.
 *   TC-AP1 — (scope-negotiation-protocol spec, AC2) park resolve --approve on
 *          a halted-scope/scope-proposal entry appends every proposedFiles
 *          path to spec.json target_files (deduped against an
 *          already-declared path) and one provenance-annotated bullet per
 *          file to spec.md's scope section, in the same resolve; spec.json's
 *          other top-level keys retain their fixture values
 *   TC-AP2 — park resolve --reject --note '<text>' on a halted-scope entry:
 *          status → 'failed-plan', scene.resolution {action:'reject', note},
 *          and the proposed paths never land in spec.json target_files
 *   TC-AP3 — --requeue/--waive on a scope-proposal scene are both refused
 *          with an explanatory message naming --approve/--reject; status
 *          stays 'halted-scope', scene.resolution stays null
 *   TC-AP4 — --approve refuses a 'parked' (non-halted-scope) entry; park show
 *          renders the proposal (files + reasons + taskIds, proposedBy,
 *          missionId, lintArmsPending); park list shows a halted-scope row
 *   TC-SOT1 — (shared-source-of-truth mission 001-002) park list's
 *          resolvable set is the behavioral image of LIVE_PARK_STATUSES
 *          (imported directly from state.js, not re-declared locally): for
 *          every member a queue entry with a readable scene is created and a
 *          single `park list` run must surface every one of those slugs;
 *          additionally, the halted-scope entry from that set resolves via
 *          --reject to 'failed-plan', while a 'pending'-status entry (not a
 *          LIVE_PARK_STATUSES member) is refused by --requeue, unchanged
 *   TC-FA1 — park show renders a 'run logs archived at:' line naming the
 *          scene's forensicArchiveDir when the scene carries that field
 *   TC-FA2 — park show prints no 'run logs archived at:' line (and still
 *          prints the scene site) when the scene omits forensicArchiveDir
 *
 * Run: node test/test-cli-park.js
 *
 * Fixture discipline: queue entries are written through the production
 * writeQueueEntry; park scenes are written as fixture INPUT with plain fs at
 * the spec-pinned location queue/<slug>/park.json (no new state.js symbols
 * are imported, so this file loads at pre-feature HEAD and fails on
 * behavioral assertions, not module resolution).
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { writeQueueEntry, readQueueEntry, stateToDecomp, LIVE_PARK_STATUSES } from '../src/orchestrator/core/state.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { pendingLintArms } from '../src/orchestrator/gates/plan-scope-lint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../src/cli/index.js');

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

// ── Fixtures ────────────────────────────────────────────────────────────────

const SPEC_MD = `# Test Spec

This is a test spec for the park CLI.

## Goals
- Build something useful
`;

const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

const DAY = 24 * 60 * 60 * 1000;

function makeTmpRoot(prefix = 'cc-orch-cli-park-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function createQueueEntry(root, slug, {
  status = 'parked',
  validatedAt = new Date().toISOString(),
  plan = { milestones: [], assumptions: [] },
  spec = SPEC_MD,
  specJson = SPEC_JSON,
} = {}) {
  writeQueueEntry(root, slug, {
    spec,
    plan,
    validatedAt,
    status,
    specJson,
  });
}

// ── scope-proposal (halted-scope) fixtures — TC-AP1..TC-AP4 ────────────────
// (scope-negotiation-protocol.spec.md Scope item 4 / AC2). Unlike the
// assumption-gate scene above, a scope-proposal scene has no round1/round2/
// appliedSpecEdits/questions — its shape is the one pipeline.js's
// batchResume actually writes at the scope-excursion park site
// (pipeline.js ~:2091): site/kind/parkedAt/proposedFiles/candidatePlan/
// missionId/lintArmsPending/proposedBy, plus the resolve-owned
// previousResolutions/resolution pair every scene carries.

// A spec.md with a real "## Scope" heading — SPEC_MD above only has
// "## Goals", so the writeback's scope-section locator (matching
// `#{1,6} Scope ...`) would fail against it. Existing tests are unaffected:
// this constant is new and only used by the TC-AP* cases below.
const SCOPE_SPEC_MD = `# Test Spec

This is a test spec for the park CLI scope-proposal flow.

## Scope
- existing/declared.js

## Other Section
- irrelevant
`;

function scopeSpecJson(targetFiles = ['existing/declared.js']) {
  return JSON.stringify({
    goal: 'scope proposal fixture goal',
    target_files: targetFiles,
    acceptance_criteria: ['AC fixture'],
    constraints: ['constraint fixture'],
  });
}

function makeScopeProposalScene(overrides = {}) {
  return {
    site: 'plan-scope-lint',
    kind: 'scope-proposal',
    parkedAt: new Date(Date.now() - DAY).toISOString(), // 1 day ago
    proposedFiles: [
      { path: 'existing/declared.js', reason: 'ALREADY-DECLARED-DEDUP-CHECK', taskIds: ['001-001-001-001'] },
      { path: 'src/new/file-one.js', reason: '"src/new/file-one.js" is outside the spec-declared scope set', taskIds: ['001-001-001-002'] },
      { path: 'src/new/file-two.js', reason: '"src/new/file-two.js" is outside the spec-declared scope set', taskIds: ['001-001-001-003'] },
    ],
    candidatePlan: { milestones: [{ id: 'm1', missions: [{ id: '001-001', tasks: [] }] }] },
    missionId: '001-001',
    lintArmsPending: ['uncovered-token', 'structure-caps'],
    proposedBy: 'planner-excursion',
    previousResolutions: [],
    resolution: null,
    ...overrides,
  };
}

// ── Promotion fixtures — TC-PR1..TC-PR4 ─────────────────────────────────────
// (scope-negotiation-protocol.spec.md Scope item 4 / AC2, "Promotion without
// re-planning"). Unlike TC-AP1..TC-AP4 above (which exercise the CLI's
// approve/reject/refuse verbs in isolation against a hand-written scene),
// these cases drive the real batchResume end-to-end from an ALREADY-APPROVED
// scope-proposal entry (status 'pending', scene.resolution.action ===
// 'approve', spec.json/spec.md already carrying the approved paths — the
// post-`park resolve --approve` state) and assert on the PROMOTION leg: the
// preserved candidatePlan is loaded and used directly (the planner is never
// re-invoked), the still-pending lint arms are re-run deterministically
// against the grown declared set, and the batch proceeds into execution with
// zero LLM agent sessions.

const PROMOTION_MISSION_ID = '001-001';
const PROMOTION_SUBMISSION_ID = '001-001-001';

// Stable sha256 content digest — mirrors Pipeline#_candidatePlanDigest
// (pipeline.js ~:2813) exactly, so a fixture's stamped candidatePlanDigest
// matches what batchResume's approved-scope-proposal recognition recomputes
// off the persisted candidatePlan. Not imported from pipeline.js (a private
// instance method) — the formula is trivial and documented at its producing
// site.
function candidatePlanDigest(candidatePlan) {
  return crypto.createHash('sha256').update(JSON.stringify(candidatePlan)).digest('hex');
}

// A minimal, self-consistent mission decomposition: one sub-mission with NO
// tasks. Deliberately task-less so promotion has literally nothing to
// execute (no executor/agent sessions are needed to reach a fully-completed
// batch run), while still exercising every promotion-specific step (skip
// planMission, write mission state, re-run lintArmsPending, proceed to
// milestone completion).
function makePromotedCandidatePlan(overrides = {}) {
  return {
    subMissions: [
      {
        id: PROMOTION_SUBMISSION_ID,
        description: 'Promoted sub-mission (approved scope proposal)',
        tasks: [],
      },
    ],
    ...overrides,
  };
}

// Writes an ALREADY-APPROVED scope-proposal queue entry: status 'pending',
// spec.json/spec.md already carrying `targetFiles` (the post-approve
// writeback state — this file exercises the PROMOTION leg only, so the
// approve writeback itself, already covered by TC-AP1, is folded directly
// into the fixture rather than re-driven through the CLI), and a park.json
// scene whose resolution is 'approve' and whose candidatePlanDigest matches
// the persisted candidatePlan (the "approve what you saw" identity check at
// pipeline.js ~:1674-1709).
function writeApprovedScopeProposalFixture(root, slug, {
  missionId = PROMOTION_MISSION_ID,
  candidatePlan,
  lintArmsPending,
  proposedFiles,
  targetFiles,
} = {}) {
  createQueueEntry(root, slug, {
    status: 'pending',
    spec: SCOPE_SPEC_MD,
    specJson: scopeSpecJson(targetFiles),
    plan: {
      milestones: [{
        id: 'm1',
        description: 'Promotion milestone',
        missions: [{ id: missionId, description: `Mission ${missionId}` }],
      }],
      assumptions: [],
      scopeItems: [],
      scopeMapping: [],
    },
  });

  const scene = {
    site: 'plan-scope-lint',
    kind: 'scope-proposal',
    parkedAt: new Date(Date.now() - DAY).toISOString(),
    proposedFiles,
    candidatePlan,
    missionId,
    lintArmsPending,
    proposedBy: 'planner-excursion',
    previousResolutions: [],
    resolution: {
      action: 'approve',
      at: new Date(Date.now() - DAY / 2).toISOString(),
      note: null,
      consumedAt: null,
    },
    candidatePlanDigest: candidatePlanDigest(candidatePlan),
  };
  writeScene(root, slug, scene);
  return scene;
}

// Drives the real batchResume against `root`'s single queued entry with:
//   - a planMission stub that THROWS on any invocation (so a single call
//     fails the test outright) and counts its own invocations;
//   - every downstream LLM-agent seam (reviewer gate, mission regression,
//     milestone regression) neutralized so a fully-promoted, task-less
//     mission can drain to a completed, archived batch run with ZERO agent
//     sessions — the coverage/hard-check gates are also skipped since this
//     file's fixture spec.json carries no checkable acceptance criteria for
//     them to act on;
//   - onLog captured, so promotion-time log output (e.g. per-lint-arm
//     progress) is inspectable by assertion.
// Returns { pipeline, planMissionCalls, logs, sessionsBefore, sessionsAfter }.
async function runPromotionBatch(root) {
  let planMissionCalls = 0;
  const logs = [];
  const pipeline = new Pipeline(root, {
    skipWorktreeCreation: true,
    noReview: true,
    onLog: (msg) => { logs.push(String(msg)); },
    onConfirm: async () => true,
    archive: async () => 'fake-archive-dir',
  });
  // Coverage/hard-check gates are irrelevant to the promotion contract under
  // test and would otherwise require a fully-checkable spec.json fixture.
  pipeline._skipCoverageGate = true;
  // Mission-level regression (Phase C of _executeMilestoneParallel) and
  // milestone-level regression (the final delivery gate) both spawn a real
  // verifier agent session unconditionally — neutralize both so a
  // task-less promoted mission can drain to completion with zero sessions.
  pipeline._missionRegression = async () => {};
  pipeline.verifier.verifyRegression = async () => ({
    verified: true,
    structured: { result: 'PASSED', checks: [] },
    report: 'stub: verifyRegression neutralized for promotion test',
    reportPath: null,
    isStub: false,
  });
  pipeline.planner.planMission = async () => {
    planMissionCalls++;
    throw new Error(
      'fixture: planMission must never be invoked for an approved, digest-matching scope-proposal promotion'
    );
  };
  const sessionsBefore = pipeline.tokenTracker.getTotalUsage().sessionCount;
  await pipeline.batchResume({});
  const sessionsAfter = pipeline.tokenTracker.getTotalUsage().sessionCount;
  return { pipeline, planMissionCalls, logs, sessionsBefore, sessionsAfter };
}

// Reads back a mission's persisted decomposition (the same stateToDecomp
// inverse resume call sites use) from the harness dir the pipeline last
// pointed at.
function readPromotedMissionDecomp(pipeline, missionId) {
  const stateFile = path.join(pipeline.harnessDir, 'state', `mission-${missionId}.json`);
  if (!fs.existsSync(stateFile)) return null;
  return stateToDecomp(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
}

// Spec-pinned scene shape (Scope item 1).
function makeScene(overrides = {}) {
  return {
    site: 'assumption-gate',
    parkedAt: new Date(Date.now() - DAY).toISOString(), // 1 day ago
    round1: [{
      assumption: { text: 'CLI-QUESTION-ONE', phase: 'pre', specSection: 'Goals' },
      status: 'uncertain',
      evidence: 'could not confirm',
    }],
    round2: null,
    appliedSpecEdits: [],
    questions: ['CLI-QUESTION-ONE'],
    previousResolutions: [],
    resolution: null,
    ...overrides,
  };
}

function writeScene(root, slug, scene) {
  fs.writeFileSync(
    path.join(root, 'queue', slug, 'park.json'),
    JSON.stringify(scene, null, 2)
  );
}

function readScene(root, slug) {
  const p = path.join(root, 'queue', slug, 'park.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function readStatus(root, slug) {
  return fs.readFileSync(path.join(root, 'queue', slug, 'status'), 'utf8').trim();
}

/**
 * Make the on-disk spec files "older than parkedAt" (control state) or set up
 * the spec.md-newer divergence:
 *   - aged(root, slug):     both spec.md + spec.json mtimes ← 2 days ago
 *   - diverged(root, slug): spec.json mtime ← 2 days ago, spec.md mtime ← now
 * (parkedAt in makeScene is 1 day ago, so "now" > parkedAt > "2 days ago".)
 */
function ageSpecFiles(root, slug, { divergeMd = false } = {}) {
  const old = new Date(Date.now() - 2 * DAY);
  const dir = path.join(root, 'queue', slug);
  fs.utimesSync(path.join(dir, 'spec.json'), old, old);
  if (divergeMd) {
    const now = new Date();
    fs.utimesSync(path.join(dir, 'spec.md'), now, now);
  } else {
    fs.utimesSync(path.join(dir, 'spec.md'), old, old);
  }
}

/**
 * Run `cc-orch <args>` end-to-end with cwd = root (projectRoot defaults to
 * cwd in src/cli/index.js). Returns { status, stdout, stderr, out }.
 */
function runCli(root, args) {
  const res = spawnSync('node', [CLI_PATH, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    out: `${res.stdout || ''}\n${res.stderr || ''}`,
  };
}

// The spec calls it a "divergence warning" (spec.md edited after parking,
// spec.json untouched). The exact wording is the implementer's; this family
// of terms is asserted PRESENT in the diverged case and ABSENT in the
// control case, so the check is self-consistent whatever the phrasing.
const DIVERGENCE_RE = /diverg|newer|out[\s-]of[\s-](date|sync)|stale|mismatch|edited after|modified after/i;

// An error must be non-silent: non-zero exit or stderr output.
function assertNonSilentFailure(res, label) {
  assert.ok(
    res.status !== 0 || res.stderr.trim().length > 0,
    `${label}: the refusal must be observable (non-zero exit or stderr message); got exit ${res.status} with empty stderr`
  );
}

// ── TC1: park list on an empty queue — no crash ─────────────────────────────

await test('TC1: park list on an empty queue exits 0 without crashing', async () => {
  const root = makeTmpRoot();
  try {
    const res = runCli(root, ['park', 'list']);
    assert.strictEqual(res.status, 0,
      `park list must exit 0 on an empty queue (got exit ${res.status}; output: ${res.out.trim().slice(0, 200)})`);
  } finally {
    cleanup(root);
  }
});

// ── TC2: park list filters parked + halted-review; slug/site/questions ──────

await test('TC2: park list shows only parked + halted-review entries with slug, site, and question summary', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'plain-pending', { status: 'pending', validatedAt: '2026-06-01T00:00:00.000Z' });
    createQueueEntry(root, 'parked-entry', { status: 'parked', validatedAt: '2026-06-02T00:00:00.000Z' });
    writeScene(root, 'parked-entry', makeScene());
    createQueueEntry(root, 'halted-entry', { status: 'halted-review', validatedAt: '2026-06-03T00:00:00.000Z' });
    writeScene(root, 'halted-entry', makeScene({
      site: 'review-gate',
      round1: [],
      questions: ['HALT-QUESTION-X'],
    }));
    createQueueEntry(root, 'failed-entry', { status: 'failed-validation', validatedAt: '2026-06-04T00:00:00.000Z' });

    const res = runCli(root, ['park', 'list']);
    assert.strictEqual(res.status, 0, `park list must exit 0 (got ${res.status}; output: ${res.out.trim().slice(0, 200)})`);

    assert.ok(res.stdout.includes('parked-entry'), 'list must include the parked entry slug');
    assert.ok(res.stdout.includes('halted-entry'), 'list must include the halted-review entry slug');
    assert.ok(!res.stdout.includes('plain-pending'), 'list must NOT include pending entries');
    assert.ok(!res.stdout.includes('failed-entry'), 'list must NOT include failed-validation entries');

    assert.ok(res.stdout.includes('assumption-gate'), "list must show the scene's site for the parked entry");
    assert.ok(res.stdout.includes('review-gate'), "list must show the scene's site for the halted-review entry");
    assert.ok(res.stdout.includes('CLI-QUESTION-ONE'), 'list must show a question summary for the parked entry');
    assert.ok(res.stdout.includes('HALT-QUESTION-X'), 'list must show a question summary for the halted-review entry');
  } finally {
    cleanup(root);
  }
});

// ── TC3: park list — scene-less entry shown with a placeholder, not a crash ──

await test('TC3: park list shows a scene-less halted-review entry with a placeholder instead of crashing', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'sceneless-halt', { status: 'halted-review' });
    // Deliberately NO park.json.

    const res = runCli(root, ['park', 'list']);
    assert.strictEqual(res.status, 0,
      `park list must not crash on a scene-less entry (got exit ${res.status}; output: ${res.out.trim().slice(0, 200)})`);
    assert.ok(res.stdout.includes('sceneless-halt'),
      'the scene-less entry must still be listed (with a placeholder, per readParkScene → null handling)');
  } finally {
    cleanup(root);
  }
});

// ── TC4: park show — full scene + both spec paths; no spurious warning ───────

await test('TC4: park show prints the full scene plus both queue spec paths; no divergence warning in the control case', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'show-entry', { status: 'parked' });
    writeScene(root, 'show-entry', makeScene({
      previousResolutions: [{ action: 'requeue', at: '2026-05-01T00:00:00.000Z', note: 'earlier', consumedAt: null }],
    }));
    ageSpecFiles(root, 'show-entry'); // both spec files older than parkedAt → no divergence

    const res = runCli(root, ['park', 'show', 'show-entry']);
    assert.strictEqual(res.status, 0, `park show must exit 0 (got ${res.status}; output: ${res.out.trim().slice(0, 200)})`);

    assert.ok(res.stdout.includes('assumption-gate'), 'show must print the scene site');
    assert.ok(res.stdout.includes('CLI-QUESTION-ONE'), 'show must print the scene questions');
    assert.ok(res.stdout.includes('spec.md'), 'show must print the queue spec.md path');
    assert.ok(res.stdout.includes('spec.json'), 'show must print the queue spec.json path');
    assert.ok(!DIVERGENCE_RE.test(res.out),
      `no divergence warning may fire when neither spec file changed after parking (output matched ${DIVERGENCE_RE}: ${res.out.trim().slice(0, 300)})`);
  } finally {
    cleanup(root);
  }
});

// ── TC5: park show — divergence warning (spec.md newer, spec.json untouched) ──

await test('TC5: park show warns when spec.md mtime is newer than parkedAt but spec.json is untouched', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'diverged-entry', { status: 'parked' });
    writeScene(root, 'diverged-entry', makeScene());
    ageSpecFiles(root, 'diverged-entry', { divergeMd: true }); // spec.md ← now, spec.json ← old

    const res = runCli(root, ['park', 'show', 'diverged-entry']);
    assert.strictEqual(res.status, 0, `park show must still exit 0 (warn, not fail) (got ${res.status})`);
    assert.ok(DIVERGENCE_RE.test(res.out),
      `expected a spec.md/spec.json divergence warning (matching ${DIVERGENCE_RE}); output: ${res.out.trim().slice(0, 300)}`);
  } finally {
    cleanup(root);
  }
});

// ── TC6: park resolve --requeue with --note ─────────────────────────────────

await test("TC6: park resolve --requeue → status 'pending'; resolution {action:'requeue', at, note} written; previousResolutions untouched", async () => {
  const root = makeTmpRoot();
  try {
    const priorChain = [{ action: 'waive', at: '2026-05-01T00:00:00.000Z', note: 'old', consumedAt: '2026-05-02T00:00:00.000Z' }];
    createQueueEntry(root, 'resolve-rq', { status: 'parked' });
    writeScene(root, 'resolve-rq', makeScene({ previousResolutions: priorChain }));
    ageSpecFiles(root, 'resolve-rq'); // no divergence noise

    const res = runCli(root, ['park', 'resolve', 'resolve-rq', '--requeue', '--note', 'spec fixed by hand']);
    assert.strictEqual(res.status, 0, `resolve --requeue must succeed (got exit ${res.status}; output: ${res.out.trim().slice(0, 300)})`);

    assert.strictEqual(readStatus(root, 'resolve-rq'), 'pending',
      "resolve --requeue must transition the entry to 'pending'");

    const scene = readScene(root, 'resolve-rq');
    assert.ok(scene && scene.resolution, 'the resolution must be written into the scene');
    assert.strictEqual(scene.resolution.action, 'requeue',
      `resolution.action expected 'requeue', got '${scene.resolution.action}'`);
    assert.ok(scene.resolution.at && !Number.isNaN(new Date(scene.resolution.at).getTime()),
      `resolution.at must be a parseable timestamp (got ${JSON.stringify(scene.resolution.at)})`);
    assert.strictEqual(scene.resolution.note, 'spec fixed by hand',
      `--note must be persisted into resolution.note (got ${JSON.stringify(scene.resolution.note)})`);
    assert.deepStrictEqual(scene.previousResolutions, priorChain,
      'resolve must NEVER touch previousResolutions (pipeline-owned field)');

    // The entry stays in the queue for the next batch run.
    assert.ok(readQueueEntry(root, 'resolve-rq'), 'the requeued entry must remain in the queue');
  } finally {
    cleanup(root);
  }
});

// ── TC7: park resolve --waive ────────────────────────────────────────────────

await test("TC7: park resolve --waive on a parked entry → status 'pending', resolution action 'waive'", async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'resolve-wv', { status: 'parked' });
    writeScene(root, 'resolve-wv', makeScene());
    ageSpecFiles(root, 'resolve-wv');

    const res = runCli(root, ['park', 'resolve', 'resolve-wv', '--waive']);
    assert.strictEqual(res.status, 0, `resolve --waive must succeed on a parked entry (got exit ${res.status}; output: ${res.out.trim().slice(0, 300)})`);

    assert.strictEqual(readStatus(root, 'resolve-wv'), 'pending',
      "resolve --waive must transition the entry to 'pending'");
    const scene = readScene(root, 'resolve-wv');
    assert.ok(scene && scene.resolution, 'the waive resolution must be written into the scene');
    assert.strictEqual(scene.resolution.action, 'waive',
      `resolution.action expected 'waive', got '${scene.resolution.action}'`);
    assert.ok(!scene.resolution.consumedAt,
      `a freshly written waive must be unconsumed — consumedAt is set by the pipeline, not the CLI (got ${JSON.stringify(scene.resolution.consumedAt)})`);
  } finally {
    cleanup(root);
  }
});

// ── TC8: park resolve --reject ───────────────────────────────────────────────

await test("TC8: park resolve --reject on a parked entry → status 'rejected' (terminal)", async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'resolve-rj', { status: 'parked' });
    writeScene(root, 'resolve-rj', makeScene());
    ageSpecFiles(root, 'resolve-rj');

    const res = runCli(root, ['park', 'resolve', 'resolve-rj', '--reject']);
    assert.strictEqual(res.status, 0, `resolve --reject must succeed on a parked entry (got exit ${res.status}; output: ${res.out.trim().slice(0, 300)})`);

    assert.strictEqual(readStatus(root, 'resolve-rj'), 'rejected',
      "resolve --reject must transition the entry to 'rejected'");
    const scene = readScene(root, 'resolve-rj');
    assert.ok(scene && scene.resolution, 'the reject resolution must be written into the scene');
    assert.ok(/^reject/.test(scene.resolution.action),
      `resolution.action expected the reject verb, got '${scene.resolution.action}'`);
    // Terminal: the entry stays on disk (no garbage collection in P1).
    assert.ok(fs.existsSync(path.join(root, 'queue', 'resolve-rj')),
      'the rejected entry directory must remain on disk');
  } finally {
    cleanup(root);
  }
});

// ── TC9: halted-review verb restrictions ────────────────────────────────────

await test("TC9: halted-review accepts --requeue and --reject, but REFUSES --waive with an explanatory error", async () => {
  const root = makeTmpRoot();
  try {
    const minimalScene = () => makeScene({
      site: 'review-gate',
      round1: [],
      questions: ['Review-gate decision needed.'],
    });

    // --waive must be refused, state unchanged.
    createQueueEntry(root, 'halt-wv', { status: 'halted-review' });
    writeScene(root, 'halt-wv', minimalScene());
    const resWaive = runCli(root, ['park', 'resolve', 'halt-wv', '--waive']);
    assertNonSilentFailure(resWaive, 'resolve --waive on halted-review');
    assert.ok(/waive/i.test(resWaive.out),
      `the refusal must explain the --waive restriction (output: ${resWaive.out.trim().slice(0, 300)})`);
    assert.strictEqual(readStatus(root, 'halt-wv'), 'halted-review',
      'a refused --waive must leave the status unchanged');
    const waiveScene = readScene(root, 'halt-wv');
    assert.strictEqual(waiveScene.resolution, null,
      'a refused --waive must not write a resolution into the scene');

    // --requeue is legal: halted-review → pending (full re-validation + re-execution).
    createQueueEntry(root, 'halt-rq', { status: 'halted-review' });
    writeScene(root, 'halt-rq', minimalScene());
    fs.utimesSync(path.join(root, 'queue', 'halt-rq', 'spec.md'), new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));
    fs.utimesSync(path.join(root, 'queue', 'halt-rq', 'spec.json'), new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));
    const resRq = runCli(root, ['park', 'resolve', 'halt-rq', '--requeue']);
    assert.strictEqual(resRq.status, 0,
      `resolve --requeue must succeed on halted-review (got exit ${resRq.status}; output: ${resRq.out.trim().slice(0, 300)})`);
    assert.strictEqual(readStatus(root, 'halt-rq'), 'pending',
      "halted-review --requeue must transition to 'pending'");

    // --reject is legal: halted-review → rejected.
    createQueueEntry(root, 'halt-rj', { status: 'halted-review' });
    writeScene(root, 'halt-rj', minimalScene());
    const resRj = runCli(root, ['park', 'resolve', 'halt-rj', '--reject']);
    assert.strictEqual(resRj.status, 0,
      `resolve --reject must succeed on halted-review (got exit ${resRj.status}; output: ${resRj.out.trim().slice(0, 300)})`);
    assert.strictEqual(readStatus(root, 'halt-rj'), 'rejected',
      "halted-review --reject must transition to 'rejected'");
  } finally {
    cleanup(root);
  }
});

// ── TC10: illegal transition for any other status ────────────────────────────

await test('TC10: resolving an entry whose status is neither parked nor halted-review is an illegal-transition error', async () => {
  const root = makeTmpRoot();
  try {
    // A pending entry WITH a scene (crash-window shape) — still not resolvable.
    createQueueEntry(root, 'pending-entry', { status: 'pending' });
    writeScene(root, 'pending-entry', makeScene());

    const res = runCli(root, ['park', 'resolve', 'pending-entry', '--requeue']);
    assertNonSilentFailure(res, 'resolve on a pending entry');
    assert.strictEqual(readStatus(root, 'pending-entry'), 'pending',
      'an illegal transition must leave the status unchanged');
    const scene = readScene(root, 'pending-entry');
    assert.strictEqual(scene.resolution, null,
      'an illegal transition must not write a resolution into the scene');
  } finally {
    cleanup(root);
  }
});

// ── TC11: scene-less resolve refused (missing AND corrupt park.json) ─────────

await test('TC11: resolve refuses a target with no readable scene (missing or corrupt park.json) instead of inventing one', async () => {
  const root = makeTmpRoot();
  try {
    // Missing park.json.
    createQueueEntry(root, 'no-scene', { status: 'parked' });
    const resMissing = runCli(root, ['park', 'resolve', 'no-scene', '--requeue']);
    assertNonSilentFailure(resMissing, 'resolve with missing park.json');
    assert.strictEqual(readStatus(root, 'no-scene'), 'parked',
      'a refused scene-less resolve must leave the status unchanged');
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'no-scene', 'park.json')),
      'the CLI must not invent a park.json for a scene-less target');

    // Corrupt park.json (readParkScene → null too).
    createQueueEntry(root, 'corrupt-scene', { status: 'parked' });
    fs.writeFileSync(path.join(root, 'queue', 'corrupt-scene', 'park.json'), 'not json {{{');
    const resCorrupt = runCli(root, ['park', 'resolve', 'corrupt-scene', '--requeue']);
    assertNonSilentFailure(resCorrupt, 'resolve with corrupt park.json');
    assert.strictEqual(readStatus(root, 'corrupt-scene'), 'parked',
      'a refused corrupt-scene resolve must leave the status unchanged');
    assert.strictEqual(fs.readFileSync(path.join(root, 'queue', 'corrupt-scene', 'park.json'), 'utf8'), 'not json {{{',
      'the corrupt park.json must be left as-is (no invented overwrite)');
  } finally {
    cleanup(root);
  }
});

// ── TC12: divergence warning on resolve --requeue (warn, don't block) ───────

await test("TC12: resolve --requeue fires the spec.md/spec.json divergence warning but still completes (warn, don't block)", async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'rq-diverged', { status: 'parked' });
    writeScene(root, 'rq-diverged', makeScene());
    ageSpecFiles(root, 'rq-diverged', { divergeMd: true }); // spec.md newer than parkedAt, spec.json untouched

    const res = runCli(root, ['park', 'resolve', 'rq-diverged', '--requeue']);

    assert.ok(DIVERGENCE_RE.test(res.out),
      `resolve --requeue must warn about the spec.md/spec.json divergence (matching ${DIVERGENCE_RE}); output: ${res.out.trim().slice(0, 300)}`);

    // Warn, don't block: the resolve still goes through.
    assert.strictEqual(res.status, 0,
      `the divergence warning must not block the resolve (got exit ${res.status})`);
    assert.strictEqual(readStatus(root, 'rq-diverged'), 'pending',
      "the diverged --requeue must still transition to 'pending'");
    const scene = readScene(root, 'rq-diverged');
    assert.ok(scene && scene.resolution && scene.resolution.action === 'requeue',
      'the requeue resolution must still be written despite the warning');
  } finally {
    cleanup(root);
  }
});

// ── TC13: divergence warning against a PIPELINE-PRODUCED park (no backdating) ──
// GAP TEST (adversarial-review round). The load-bearing divergence evidence:
// the park is produced by the REAL batchResume (only planner.verifyAssumptions
// stubbed to 'uncertain'), the human edit is a REAL file write strictly after
// parkedAt (wall-clock sleep, no fs.utimesSync), and spec.json is genuinely
// untouched after parking. Against an implementation whose park flow rewrites
// both spec files at park time, spec.json's mtime lands at/after parkedAt and
// the warning can never fire in real use — this case fails there and passes
// once status flips are status-only writes.

await test('TC13: pipeline-produced park — real spec.md edit (spec.json untouched) triggers the divergence warning on show and resolve --requeue; editing both is silent', async () => {
  const root = makeTmpRoot();
  try {
    // Two pending entries with a failing assumption each. PARK TRIGGER:
    // an uncertain no longer parks, so to drive a genuine pipeline-produced
    // park the assumption must still-fail after a remediation round
    // (failed-after-remediation / TC3a pattern). The SUBJECT (the spec.md/
    // spec.json divergence warning against a pipeline-written scene) is
    // unchanged.
    for (const [slug, ts] of [['pipe-diverged', '2026-06-01T00:00:00.000Z'], ['pipe-control', '2026-06-02T00:00:00.000Z']]) {
      createQueueEntry(root, slug, {
        status: 'pending',
        validatedAt: ts,
        plan: { milestones: [], assumptions: [{ text: 'FAILED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }] },
      });
    }

    // Drive the REAL batchResume; stub only the trigger seams (round-1 fails →
    // remediation → round-2 still fails → both entries park before execution).
    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: () => {},
      onConfirm: async () => true,
      archive: async () => {
        throw new Error('fixture: archive must not run — entries park before execution');
      },
    });
    pipeline.planner.verifyAssumptions = async (assumptions) =>
      (assumptions || []).map((a) => {
        const text = a?.text ?? a;
        const status = (text === 'FAILED-ASSUMPTION' || text === 'REVISED-ASSUMPTION') ? 'failed' : 'verified';
        return { assumption: a, status, evidence: 'stub' };
      });
    pipeline.planner.remediateAssumption = async () => ({
      specEdit: { old: 'Build something useful', new: 'Build something REMEDIATED', section: 'Goals' },
      revisedAssumptions: [{ text: 'REVISED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }],
    });
    pipeline.planner.reExtractAssumptions = async () => [{ text: 'REVISED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }];
    pipeline.planner.closeReusableSession = async () => {};
    pipeline._executeAllMilestones = async () => {
      throw new Error('fixture: a parked entry must never reach execution');
    };
    pipeline._reviewGate = async () => {};

    await pipeline.batchResume({});

    for (const slug of ['pipe-diverged', 'pipe-control']) {
      assert.strictEqual(readStatus(root, slug), 'parked',
        `fixture: '${slug}' must be parked by the real batch run`);
      assert.ok(readScene(root, slug), `fixture: '${slug}' must have a pipeline-written park.json`);
    }

    // Real wall-clock gap so the human edit's mtime is strictly newer than
    // parkedAt (and than anything the park flow wrote). NO backdating.
    await new Promise((r) => setTimeout(r, 1100));

    // Diverged entry: a human edits ONLY spec.md after parking.
    fs.appendFileSync(path.join(root, 'queue', 'pipe-diverged', 'spec.md'),
      '\n<!-- human edit after park -->\n');

    // Control entry: BOTH files edited after parking (md first, then json) —
    // spec.json is not "untouched", so no warning may fire.
    fs.appendFileSync(path.join(root, 'queue', 'pipe-control', 'spec.md'),
      '\n<!-- human edit after park -->\n');
    fs.appendFileSync(path.join(root, 'queue', 'pipe-control', 'spec.json'), '\n');

    // show on the diverged entry → warning.
    const resShowDiverged = runCli(root, ['park', 'show', 'pipe-diverged']);
    assert.strictEqual(resShowDiverged.status, 0,
      `park show must exit 0 (got ${resShowDiverged.status}; output: ${resShowDiverged.out.trim().slice(0, 200)})`);
    assert.ok(DIVERGENCE_RE.test(resShowDiverged.out),
      `park show must warn for a pipeline-produced park whose spec.md was really edited after parking while spec.json stayed untouched (matching ${DIVERGENCE_RE}); ` +
      `if the park flow rewrote spec.json at park time, this condition is structurally unsatisfiable — output: ${resShowDiverged.out.trim().slice(0, 300)}`);

    // show on the control entry → no warning.
    const resShowControl = runCli(root, ['park', 'show', 'pipe-control']);
    assert.strictEqual(resShowControl.status, 0,
      `park show must exit 0 on the control entry (got ${resShowControl.status})`);
    assert.ok(!DIVERGENCE_RE.test(resShowControl.out),
      `no divergence warning may fire when BOTH spec files were edited after parking (output matched ${DIVERGENCE_RE}: ${resShowControl.out.trim().slice(0, 300)})`);

    // resolve --requeue on the diverged entry → warning, but not blocked.
    const resResolve = runCli(root, ['park', 'resolve', 'pipe-diverged', '--requeue']);
    assert.ok(DIVERGENCE_RE.test(resResolve.out),
      `resolve --requeue must fire the same divergence warning for the pipeline-produced park (matching ${DIVERGENCE_RE}); output: ${resResolve.out.trim().slice(0, 300)}`);
    assert.strictEqual(resResolve.status, 0,
      `the divergence warning must not block the resolve (got exit ${resResolve.status})`);
    assert.strictEqual(readStatus(root, 'pipe-diverged'), 'pending',
      "the diverged --requeue must still transition to 'pending'");
    const resolvedScene = readScene(root, 'pipe-diverged');
    assert.ok(resolvedScene && resolvedScene.resolution && resolvedScene.resolution.action === 'requeue',
      'the requeue resolution must still be written despite the warning');
  } finally {
    cleanup(root);
  }
});

// ── TC14: damaged-entry tolerance (spec.md deleted) ─────────────────────────
// GAP TEST (live-dogfood blind spot #3, CLI side). A forensic archive gutted
// a halted-review entry live (queue spec.md/spec.json moved away); park list
// and park show then crashed outright on the readQueueEntry ENOENT. The CLI
// must tolerate damaged entries: list renders a warning placeholder instead
// of dying, show degrades gracefully (no raw ENOENT), resolve refuses with
// an explanatory error instead of operating on a half-entry.

// Damage must be EXPLAINED, never a bare errno. "No raw ENOENT" means the
// pre-fix failure mode (an unexplained `ENOENT: no such file...` crash) is
// gone — quoting the underlying errno INSIDE an explanatory damage warning
// is legitimate diagnostics, not a raw leak.
const DAMAGE_EXPLAINED_RE = /damag|missing|incomplete|unreadable|corrupt/i;

function assertNoRawEnoent(res, label) {
  if (/ENOENT/.test(res.out)) {
    assert.ok(DAMAGE_EXPLAINED_RE.test(res.out),
      `${label}: ENOENT may only appear inside an explanatory damage warning, never as a bare unexplained error (output: ${res.out.trim().slice(0, 300)})`);
  }
}

await test('TC14: damaged entry (spec.md deleted) — list still renders all entries with a placeholder, show degrades gracefully, resolve refuses', async () => {
  const root = makeTmpRoot();
  try {
    // One healthy parked entry + one damaged halted-review entry.
    createQueueEntry(root, 'healthy-parked', { status: 'parked', validatedAt: '2026-06-01T00:00:00.000Z' });
    writeScene(root, 'healthy-parked', makeScene());
    createQueueEntry(root, 'damaged-halt', { status: 'halted-review', validatedAt: '2026-06-02T00:00:00.000Z' });
    writeScene(root, 'damaged-halt', makeScene({
      site: 'review-gate',
      round1: [],
      questions: ['HALT-QUESTION-X'],
    }));
    // The damage: queue spec.md gone (what the live forensic archive did).
    fs.unlinkSync(path.join(root, 'queue', 'damaged-halt', 'spec.md'));

    // list: exits 0, renders the healthy entry AND a placeholder/warning line
    // for the damaged one — it must not die on the damaged entry. (Pre-fix:
    // readQueueEntry's ENOENT killed the whole command, exit 1, nothing
    // rendered.)
    const resList = runCli(root, ['park', 'list']);
    assert.strictEqual(resList.status, 0,
      `park list must not crash on a damaged entry (got exit ${resList.status}; output: ${resList.out.trim().slice(0, 300)})`);
    assert.ok(resList.stdout.includes('healthy-parked'),
      'park list must still render the healthy entry');
    assert.ok(resList.stdout.includes('damaged-halt'),
      'park list must render the damaged entry as a placeholder/warning line, not drop or die on it');
    assert.ok(DAMAGE_EXPLAINED_RE.test(resList.out),
      `park list must mark the damaged entry with explanatory wording (matching ${DAMAGE_EXPLAINED_RE}); output: ${resList.out.trim().slice(0, 300)}`);
    assertNoRawEnoent(resList, 'park list');

    // show: degrades gracefully — serves what it can (the scene is intact),
    // flags the damage with an explanation, no crash.
    const resShow = runCli(root, ['park', 'show', 'damaged-halt']);
    assert.strictEqual(resShow.status, 0,
      `park show must degrade gracefully on a damaged entry (got exit ${resShow.status}; output: ${resShow.out.trim().slice(0, 300)})`);
    assert.ok(resShow.stdout.includes('review-gate'),
      'park show must still render the readable scene data (site) for a damaged entry');
    assert.ok(resShow.stdout.includes('HALT-QUESTION-X'),
      'park show must still render the readable scene data (questions) for a damaged entry');
    assert.ok(DAMAGE_EXPLAINED_RE.test(resShow.out),
      `park show must explain the degradation (matching ${DAMAGE_EXPLAINED_RE}); output: ${resShow.out.trim().slice(0, 300)}`);
    assertNoRawEnoent(resShow, 'park show');

    // resolve: refused with an explanatory error — never operates on a
    // half-entry. State unchanged.
    const resResolve = runCli(root, ['park', 'resolve', 'damaged-halt', '--requeue']);
    assertNonSilentFailure(resResolve, 'resolve on a damaged entry');
    assert.ok(DAMAGE_EXPLAINED_RE.test(resResolve.out),
      `the resolve refusal must explain the damage, not surface a bare errno (matching ${DAMAGE_EXPLAINED_RE}); output: ${resResolve.out.trim().slice(0, 300)}`);
    assertNoRawEnoent(resResolve, 'park resolve');
    assert.strictEqual(readStatus(root, 'damaged-halt'), 'halted-review',
      'a refused resolve on a damaged entry must leave the status unchanged');
    const scene = readScene(root, 'damaged-halt');
    assert.ok(scene && scene.resolution === null,
      'a refused resolve on a damaged entry must not write a resolution into the scene');
  } finally {
    cleanup(root);
  }
});

// ── TC15: halted-analyzer entries (analyzer-closure spec, AC9) ──────────────
// Extension written by the INDEPENDENT test author against
// analyzer-closure.spec.md / .json (Scope item 4 / AC9), before the
// implementation exists. At a pre-feature HEAD this fails behaviorally:
// 'halted-analyzer' is not in the park list filter and resolve refuses it as
// an illegal transition. Verb matrix mirrors halted-review: --requeue and
// --reject are legal, --waive is refused with an explanatory error.
// Fixture discipline unchanged: entries via the production writeQueueEntry
// (status is the new 'halted-analyzer' string — writeQueueEntry does not
// validate status values, so this file still loads and runs at HEAD);
// scenes are plain-fs fixture INPUT at the spec-pinned location.

await test("TC15: park list includes halted-analyzer entries; resolve accepts --requeue/--reject and refuses --waive with an explanatory error", async () => {
  const root = makeTmpRoot();
  try {
    const analyzerScene = () => makeScene({
      site: 'analyzer-human',
      round1: [],
      questions: ['ANALYZER-QUESTION-X (see .harness/analysis/gate-failure-001-001-001-001-123.json)'],
    });

    // list: the halted-analyzer entry must appear with slug, status, site,
    // and question summary (alongside an existing parked entry).
    createQueueEntry(root, 'plain-parked', { status: 'parked', validatedAt: '2026-06-01T00:00:00.000Z' });
    writeScene(root, 'plain-parked', makeScene());
    createQueueEntry(root, 'halt-an-list', { status: 'halted-analyzer', validatedAt: '2026-06-02T00:00:00.000Z' });
    writeScene(root, 'halt-an-list', analyzerScene());

    const resList = runCli(root, ['park', 'list']);
    assert.strictEqual(resList.status, 0,
      `park list must exit 0 (got ${resList.status}; output: ${resList.out.trim().slice(0, 200)})`);
    assert.ok(resList.stdout.includes('halt-an-list'),
      "park list must include halted-analyzer entries — at the pre-feature HEAD the filter only admits parked/halted-review");
    assert.ok(resList.stdout.includes('halted-analyzer'),
      'park list must show the halted-analyzer status');
    assert.ok(resList.stdout.includes('analyzer-human'),
      "park list must show the scene's 'analyzer-human' site");
    assert.ok(resList.stdout.includes('ANALYZER-QUESTION-X'),
      'park list must show the question summary for the halted-analyzer entry');
    assert.ok(resList.stdout.includes('plain-parked'),
      'existing parked entries must remain listed (additive filter change)');

    // --waive must be refused with an explanatory error, state unchanged.
    createQueueEntry(root, 'halt-an-wv', { status: 'halted-analyzer' });
    writeScene(root, 'halt-an-wv', analyzerScene());
    const resWaive = runCli(root, ['park', 'resolve', 'halt-an-wv', '--waive']);
    assertNonSilentFailure(resWaive, 'resolve --waive on halted-analyzer');
    assert.ok(/waive/i.test(resWaive.out),
      `the refusal must explain the --waive restriction (mirroring halted-review: there is no assumption uncertainty to accept); output: ${resWaive.out.trim().slice(0, 300)}`);
    assert.strictEqual(readStatus(root, 'halt-an-wv'), 'halted-analyzer',
      'a refused --waive must leave the status unchanged');
    const waiveScene = readScene(root, 'halt-an-wv');
    assert.strictEqual(waiveScene.resolution, null,
      'a refused --waive must not write a resolution into the scene');

    // --requeue is legal: halted-analyzer → pending (full re-validation +
    // re-execution on the next batch pass).
    createQueueEntry(root, 'halt-an-rq', { status: 'halted-analyzer' });
    writeScene(root, 'halt-an-rq', analyzerScene());
    ageSpecFiles(root, 'halt-an-rq'); // no divergence noise
    const resRq = runCli(root, ['park', 'resolve', 'halt-an-rq', '--requeue', '--note', 'analyzer escalation reviewed']);
    assert.strictEqual(resRq.status, 0,
      `resolve --requeue must succeed on halted-analyzer (got exit ${resRq.status}; output: ${resRq.out.trim().slice(0, 300)})`);
    assert.strictEqual(readStatus(root, 'halt-an-rq'), 'pending',
      "halted-analyzer --requeue must transition to 'pending'");
    const rqScene = readScene(root, 'halt-an-rq');
    assert.ok(rqScene && rqScene.resolution && rqScene.resolution.action === 'requeue',
      `the requeue resolution must be written into the scene (got ${JSON.stringify(rqScene && rqScene.resolution)})`);
    assert.strictEqual(rqScene.resolution.note, 'analyzer escalation reviewed',
      '--note must be persisted into resolution.note');

    // --reject is legal: halted-analyzer → rejected (terminal).
    createQueueEntry(root, 'halt-an-rj', { status: 'halted-analyzer' });
    writeScene(root, 'halt-an-rj', analyzerScene());
    const resRj = runCli(root, ['park', 'resolve', 'halt-an-rj', '--reject']);
    assert.strictEqual(resRj.status, 0,
      `resolve --reject must succeed on halted-analyzer (got exit ${resRj.status}; output: ${resRj.out.trim().slice(0, 300)})`);
    assert.strictEqual(readStatus(root, 'halt-an-rj'), 'rejected',
      "halted-analyzer --reject must transition to 'rejected'");
    assert.ok(fs.existsSync(path.join(root, 'queue', 'halt-an-rj')),
      'the rejected entry directory must remain on disk (terminal close, no GC)');
  } finally {
    cleanup(root);
  }
});

// ── TC-AP1: park resolve --approve — spec.json + spec.md writeback ─────────
// (scope-negotiation-protocol.spec.md Scope item 4 / AC2). Written by the
// INDEPENDENT test author against the spec contract. proposedFiles carries
// one already-declared path (dedup check) plus two new paths.

await test('TC-AP1: park resolve --approve appends proposedFiles to spec.json target_files (deduped) and one provenance bullet per file to spec.md scope section', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'scope-approve', {
      status: 'halted-scope',
      spec: SCOPE_SPEC_MD,
      specJson: scopeSpecJson(['existing/declared.js']),
    });
    const scene = makeScopeProposalScene();
    writeScene(root, 'scope-approve', scene);

    const res = runCli(root, ['park', 'resolve', 'scope-approve', '--approve']);
    assert.strictEqual(res.status, 0,
      `resolve --approve must succeed on a halted-scope entry (got exit ${res.status}; output: ${res.out.trim().slice(0, 300)})`);

    const specJsonPath = path.join(root, 'queue', 'scope-approve', 'spec.json');
    const specJson = JSON.parse(fs.readFileSync(specJsonPath, 'utf8'));

    // Every proposedFiles path present, and the already-declared path is not
    // duplicated (3 distinct paths in, 3 distinct paths out — not 4).
    assert.deepStrictEqual(
      [...specJson.target_files].sort(),
      ['existing/declared.js', 'src/new/file-one.js', 'src/new/file-two.js'].sort(),
      `target_files must contain every proposed path with no duplicate for the already-declared one (got ${JSON.stringify(specJson.target_files)})`
    );
    assert.strictEqual(
      specJson.target_files.filter((p) => p === 'existing/declared.js').length,
      1,
      'the already-declared path must appear exactly once in target_files, never duplicated'
    );

    // Every other top-level spec.json key retains its fixture value.
    assert.strictEqual(specJson.goal, 'scope proposal fixture goal',
      "spec.json's 'goal' key must retain its fixture value");
    assert.deepStrictEqual(specJson.acceptance_criteria, ['AC fixture'],
      "spec.json's 'acceptance_criteria' key must retain its fixture value");
    assert.deepStrictEqual(specJson.constraints, ['constraint fixture'],
      "spec.json's 'constraints' key must retain its fixture value");

    // One provenance-annotated bullet per proposedFiles entry (all 3,
    // including the already-declared one — the spec.md bullet is per
    // proposed file, independent of the spec.json dedup) in the scope
    // section of spec.md.
    const specMd = fs.readFileSync(path.join(root, 'queue', 'scope-approve', 'spec.md'), 'utf8');
    for (const f of scene.proposedFiles) {
      const bulletRe = new RegExp(
        `^- ${f.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*approved via scope proposal`,
        'm'
      );
      assert.ok(bulletRe.test(specMd),
        `spec.md must contain a provenance-annotated bullet for '${f.path}' in the scope section (spec.md:\n${specMd})`);
    }
    const bulletCount = (specMd.match(/approved via scope proposal/g) || []).length;
    assert.strictEqual(bulletCount, scene.proposedFiles.length,
      `spec.md must gain exactly one provenance bullet per proposedFiles entry (got ${bulletCount} bullets for ${scene.proposedFiles.length} proposed files)`);
  } finally {
    cleanup(root);
  }
});

// ── TC-AP2: park resolve --reject --note on a halted-scope entry ───────────

await test("TC-AP2: park resolve --reject --note on a halted-scope entry → status 'failed-plan', note recorded, proposed paths never land in target_files", async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'scope-reject', {
      status: 'halted-scope',
      spec: SCOPE_SPEC_MD,
      specJson: scopeSpecJson(['existing/declared.js']),
    });
    const scene = makeScopeProposalScene();
    writeScene(root, 'scope-reject', scene);

    const res = runCli(root, ['park', 'resolve', 'scope-reject', '--reject', '--note', 'the proposed files are out of scope']);
    assert.strictEqual(res.status, 0,
      `resolve --reject must succeed on a halted-scope entry (got exit ${res.status}; output: ${res.out.trim().slice(0, 300)})`);

    assert.strictEqual(readStatus(root, 'scope-reject'), 'failed-plan',
      "resolve --reject on a halted-scope entry must transition status to 'failed-plan'");

    const resolvedScene = readScene(root, 'scope-reject');
    assert.ok(resolvedScene && resolvedScene.resolution,
      'the reject resolution must be written into the scene');
    assert.strictEqual(resolvedScene.resolution.action, 'reject',
      `resolution.action expected 'reject', got '${resolvedScene.resolution.action}'`);
    assert.strictEqual(resolvedScene.resolution.note, 'the proposed files are out of scope',
      `--note must be persisted into resolution.note (got ${JSON.stringify(resolvedScene.resolution.note)})`);

    // The proposed paths must never land in spec.json target_files on reject.
    const specJson = JSON.parse(fs.readFileSync(path.join(root, 'queue', 'scope-reject', 'spec.json'), 'utf8'));
    assert.deepStrictEqual(specJson.target_files, ['existing/declared.js'],
      `a rejected scope proposal must leave target_files exactly as the fixture declared it (got ${JSON.stringify(specJson.target_files)})`);
    assert.ok(!specJson.target_files.includes('src/new/file-one.js') && !specJson.target_files.includes('src/new/file-two.js'),
      'the proposed (unapproved) paths must not appear in target_files after a reject');
  } finally {
    cleanup(root);
  }
});

// ── TC-AP3: --requeue/--waive refused on a scope-proposal scene ────────────

await test("TC-AP3: --requeue and --waive on a scope-proposal scene are both refused with an explanatory message naming --approve/--reject; status stays 'halted-scope', resolution stays null", async () => {
  const root = makeTmpRoot();
  try {
    for (const verb of ['requeue', 'waive']) {
      const slug = `scope-${verb}`;
      createQueueEntry(root, slug, {
        status: 'halted-scope',
        spec: SCOPE_SPEC_MD,
        specJson: scopeSpecJson(['existing/declared.js']),
      });
      writeScene(root, slug, makeScopeProposalScene());

      const res = runCli(root, ['park', 'resolve', slug, `--${verb}`]);
      assertNonSilentFailure(res, `resolve --${verb} on a scope-proposal scene`);
      assert.ok(/--approve/.test(res.out) && /--reject/.test(res.out),
        `the refusal for --${verb} must explain that only --approve/--reject apply to a scope proposal (output: ${res.out.trim().slice(0, 300)})`);

      assert.strictEqual(readStatus(root, slug), 'halted-scope',
        `a refused --${verb} must leave the status unchanged`);
      const scene = readScene(root, slug);
      assert.strictEqual(scene.resolution, null,
        `a refused --${verb} must not write a resolution into the scene`);
    }
  } finally {
    cleanup(root);
  }
});

// ── TC-AP4: --approve refused on 'parked'; show/list render the proposal ───

await test("TC-AP4: --approve is refused for a 'parked' (non-halted-scope) entry; park show renders the proposal; park list shows a halted-scope row", async () => {
  const root = makeTmpRoot();
  try {
    // --approve on an ordinary parked entry (not halted-scope) must be refused.
    createQueueEntry(root, 'plain-parked-ap4', { status: 'parked' });
    writeScene(root, 'plain-parked-ap4', makeScene());
    const resApprove = runCli(root, ['park', 'resolve', 'plain-parked-ap4', '--approve']);
    assertNonSilentFailure(resApprove, '--approve on a parked (non-halted-scope) entry');
    assert.strictEqual(readStatus(root, 'plain-parked-ap4'), 'parked',
      'a refused --approve must leave the status unchanged');
    const plainScene = readScene(root, 'plain-parked-ap4');
    assert.strictEqual(plainScene.resolution, null,
      'a refused --approve must not write a resolution into the scene');

    // park show: proposed files (with reasons + taskIds), proposedBy,
    // missionId, lintArmsPending.
    createQueueEntry(root, 'scope-show', {
      status: 'halted-scope',
      spec: SCOPE_SPEC_MD,
      specJson: scopeSpecJson(['existing/declared.js']),
    });
    const scene = makeScopeProposalScene();
    writeScene(root, 'scope-show', scene);

    const resShow = runCli(root, ['park', 'show', 'scope-show']);
    assert.strictEqual(resShow.status, 0,
      `park show must exit 0 for a halted-scope entry (got ${resShow.status}; output: ${resShow.out.trim().slice(0, 300)})`);
    for (const f of scene.proposedFiles) {
      assert.ok(resShow.stdout.includes(f.path),
        `park show must print proposed file path '${f.path}'`);
      assert.ok(resShow.stdout.includes(f.reason),
        `park show must print the reason for '${f.path}'`);
      for (const taskId of f.taskIds) {
        assert.ok(resShow.stdout.includes(taskId),
          `park show must print taskId '${taskId}' for '${f.path}'`);
      }
    }
    assert.ok(resShow.stdout.includes(scene.proposedBy),
      "park show must print the scene's proposedBy");
    assert.ok(resShow.stdout.includes(scene.missionId),
      "park show must print the scene's missionId");
    for (const arm of scene.lintArmsPending) {
      assert.ok(resShow.stdout.includes(arm),
        `park show must print the pending lint arm '${arm}'`);
    }

    // park list: a halted-scope row for the same entry.
    const resList = runCli(root, ['park', 'list']);
    assert.strictEqual(resList.status, 0,
      `park list must exit 0 (got ${resList.status}; output: ${resList.out.trim().slice(0, 300)})`);
    assert.ok(resList.stdout.includes('scope-show'),
      'park list must include the halted-scope entry slug');
    assert.ok(resList.stdout.includes('halted-scope'),
      "park list must show the 'halted-scope' status for the entry");
  } finally {
    cleanup(root);
  }
});

// ── TC-PR1..TC-PR4: promotion without re-planning (batchResume) ────────────
// (scope-negotiation-protocol.spec.md Scope item 5 / AC2's execution half —
// "promotion never invokes the planner (throwing-stub assertion) and re-runs
// the pending lint arms; a promotion that hits a fresh excursion re-parks
// with a new proposal"). Written by the INDEPENDENT test author against the
// spec contract, before the promotion-consuming implementation exists
// (batchResume's approved-scope-proposal RECOGNITION at pipeline.js ~:1674
// already populates `this._promotedScopePlans`, but nothing yet consumes it
// at the `_planAndApproveMission` planMission call site) — TC-PR1/PR2/PR4
// are expected to fail behaviorally (the throwing planMission stub gets
// invoked for real) until that consuming logic lands. TC-PR3 exercises the
// ALREADY-IMPLEMENTED candidatePlanDigest invalidation leg and is expected
// to pass at every HEAD.

await test('TC-PR1: an approved scope-proposal entry resuming under batchResume promotes without invoking the planner, writing the persisted candidatePlan verbatim as the mission decomposition', async () => {
  const root = makeTmpRoot();
  try {
    const candidatePlan = makePromotedCandidatePlan();
    const proposedFiles = [
      { path: 'src/new/file-one.js', reason: '"src/new/file-one.js" is outside the spec-declared scope set', taskIds: ['001-001-001-001'] },
    ];
    const lintArmsPending = pendingLintArms('scope-excursion');
    writeApprovedScopeProposalFixture(root, 'promo-pr1', {
      candidatePlan,
      lintArmsPending,
      proposedFiles,
      targetFiles: ['existing/declared.js', 'src/new/file-one.js'],
    });

    const { pipeline, planMissionCalls } = await runPromotionBatch(root);

    assert.strictEqual(planMissionCalls, 0,
      `promotion must never invoke planMission for an approved, digest-matching scope proposal (it was invoked ${planMissionCalls} time(s))`);

    const writtenDecomp = readPromotedMissionDecomp(pipeline, PROMOTION_MISSION_ID);
    assert.ok(writtenDecomp,
      `promotion must write a mission decomposition to state/mission-${PROMOTION_MISSION_ID}.json (none found under ${pipeline.harnessDir})`);
    assert.deepStrictEqual(writtenDecomp, candidatePlan,
      `the mission decomposition written to state must deep-equal the scene's candidatePlan (got ${JSON.stringify(writtenDecomp)}, expected ${JSON.stringify(candidatePlan)})`);
  } finally {
    cleanup(root);
  }
});

await test('TC-PR2: promotion re-runs every pending lint arm named in the scene and issues zero agent-session calls', async () => {
  const root = makeTmpRoot();
  try {
    const candidatePlan = makePromotedCandidatePlan();
    const proposedFiles = [
      { path: 'src/new/file-a.js', reason: '"src/new/file-a.js" is outside the spec-declared scope set', taskIds: ['001-001-001-001'] },
      { path: 'src/new/file-b.js', reason: '"src/new/file-b.js" is outside the spec-declared scope set', taskIds: ['001-001-001-002'] },
    ];
    const lintArmsPending = pendingLintArms('scope-excursion');
    assert.ok(lintArmsPending.length > 0, 'fixture sanity: a scope-excursion park must leave ≥1 lint arm pending');
    writeApprovedScopeProposalFixture(root, 'promo-pr2', {
      candidatePlan,
      lintArmsPending,
      proposedFiles,
      targetFiles: ['existing/declared.js', 'src/new/file-a.js', 'src/new/file-b.js'],
    });

    const { planMissionCalls, logs, sessionsBefore, sessionsAfter } = await runPromotionBatch(root);

    assert.strictEqual(planMissionCalls, 0,
      `promotion must never invoke planMission (it was invoked ${planMissionCalls} time(s))`);

    const combinedLog = logs.join('\n');
    for (const armId of lintArmsPending) {
      assert.ok(combinedLog.includes(armId),
        `promotion must re-run pending lint arm '${armId}' — expected its arm id to be observable in the promotion log ` +
        `(log:\n${combinedLog.slice(0, 2000)})`);
    }

    assert.strictEqual(sessionsAfter - sessionsBefore, 0,
      `promotion must issue zero agent-session calls (session count went from ${sessionsBefore} to ${sessionsAfter})`);
  } finally {
    cleanup(root);
  }
});

await test("TC-PR3: mutating the persisted candidatePlan between park and promotion invalidates the approval — status stays 'halted-scope' with a freshly written park.json", async () => {
  const root = makeTmpRoot();
  try {
    const candidatePlan = makePromotedCandidatePlan();
    const proposedFiles = [
      { path: 'src/new/file-one.js', reason: '"src/new/file-one.js" is outside the spec-declared scope set', taskIds: ['001-001-001-001'] },
    ];
    const lintArmsPending = pendingLintArms('scope-excursion');
    writeApprovedScopeProposalFixture(root, 'promo-pr3', {
      candidatePlan,
      lintArmsPending,
      proposedFiles,
      targetFiles: ['existing/declared.js', 'src/new/file-one.js'],
    });

    // Mutate the PERSISTED candidatePlan on disk (simulating a hand-edit
    // after approval) WITHOUT recomputing candidatePlanDigest — the digest
    // stamped at park/approve time now describes a plan that no longer
    // matches what's actually on disk.
    const mutatedScene = readScene(root, 'promo-pr3');
    mutatedScene.candidatePlan = {
      subMissions: [
        { id: PROMOTION_SUBMISSION_ID, description: 'MUTATED after approval', tasks: [] },
      ],
    };
    writeScene(root, 'promo-pr3', mutatedScene);
    const beforeMtime = fs.statSync(path.join(root, 'queue', 'promo-pr3', 'park.json')).mtimeMs;

    const { planMissionCalls } = await runPromotionBatch(root);

    assert.strictEqual(planMissionCalls, 0,
      `an invalidated (digest-mismatched) promotion must never invoke planMission either (it was invoked ${planMissionCalls} time(s))`);

    assert.strictEqual(readStatus(root, 'promo-pr3'), 'halted-scope',
      "a candidatePlan mutated between park and promotion must leave the entry at status 'halted-scope', not promote it");

    const reparkedScene = readScene(root, 'promo-pr3');
    assert.ok(reparkedScene, 'a fresh park.json scene must exist after the invalidated promotion');
    assert.strictEqual(reparkedScene.kind, 'scope-proposal',
      'the re-park must still carry a scope-proposal scene');
    assert.strictEqual(reparkedScene.resolution, null,
      'the freshly re-parked scene must be unresolved (awaiting a fresh human decision)');
    assert.ok(
      Array.isArray(reparkedScene.previousResolutions) &&
      reparkedScene.previousResolutions.some((r) => r && r.action === 'approve'),
      `the prior 'approve' resolution must be preserved in previousResolutions (got ${JSON.stringify(reparkedScene.previousResolutions)})`
    );
    const afterMtime = fs.statSync(path.join(root, 'queue', 'promo-pr3', 'park.json')).mtimeMs;
    assert.ok(afterMtime >= beforeMtime,
      'park.json must be freshly (re-)written by the invalidated promotion, not left untouched');
  } finally {
    cleanup(root);
  }
});

await test("TC-PR4: a promotion whose re-run lint arms hit a fresh excursion re-parks at 'halted-scope' with a new scope-proposal scene naming the new offending paths", async () => {
  const root = makeTmpRoot();
  try {
    // The approved set only covers 'src/new/file-one.js' (the ORIGINAL
    // excursion). The candidate plan's task ALSO targets
    // 'src/new/fresh-excursion.js' — a path never approved, so promotion's
    // scope-excursion re-check must catch it as a FRESH excursion beyond
    // the approved set.
    const candidatePlan = {
      subMissions: [
        {
          id: PROMOTION_SUBMISSION_ID,
          description: 'Promoted sub-mission with a fresh excursion',
          tasks: [
            {
              id: `${PROMOTION_SUBMISSION_ID}-001`,
              description: 'Task targeting an unapproved path',
              targetFiles: ['src/new/fresh-excursion.js'],
              dependencies: [],
              testCases: [],
              tracesScenario: [],
              patternReferences: [],
              dataSchemas: [],
            },
          ],
        },
      ],
    };
    const proposedFiles = [
      { path: 'src/new/file-one.js', reason: '"src/new/file-one.js" is outside the spec-declared scope set', taskIds: ['001-001-001-001'] },
    ];
    const lintArmsPending = pendingLintArms('scope-excursion');
    writeApprovedScopeProposalFixture(root, 'promo-pr4', {
      candidatePlan,
      lintArmsPending,
      proposedFiles,
      // Only the ORIGINALLY proposed/approved path is declared —
      // 'fresh-excursion.js' is NOT, so it must surface as a new excursion.
      targetFiles: ['existing/declared.js', 'src/new/file-one.js'],
    });

    const { planMissionCalls } = await runPromotionBatch(root);

    assert.strictEqual(planMissionCalls, 0,
      `promotion must never invoke planMission even when it re-parks on a fresh excursion (it was invoked ${planMissionCalls} time(s))`);

    assert.strictEqual(readStatus(root, 'promo-pr4'), 'halted-scope',
      "a fresh excursion discovered at promotion must leave the entry at status 'halted-scope'");

    const reparkedScene = readScene(root, 'promo-pr4');
    assert.ok(reparkedScene, 'a new park.json scene must exist after the fresh-excursion re-park');
    assert.strictEqual(reparkedScene.kind, 'scope-proposal',
      'the re-park must carry a scope-proposal scene');
    assert.strictEqual(reparkedScene.resolution, null,
      'the freshly re-parked scene must be unresolved');
    assert.ok(
      Array.isArray(reparkedScene.proposedFiles) &&
      reparkedScene.proposedFiles.some((f) => f && f.path === 'src/new/fresh-excursion.js'),
      `the new scope-proposal scene must name the fresh offending path 'src/new/fresh-excursion.js' in proposedFiles (got ${JSON.stringify(reparkedScene.proposedFiles)})`
    );
  } finally {
    cleanup(root);
  }
});

// ── TC-SOT1: park's resolvable set is the behavioral image of LIVE_PARK_STATUSES ──
// (shared-source-of-truth mission 001-002). LIVE_PARK_STATUSES is imported
// DIRECTLY from state.js (not re-declared here), so this case only passes if
// park.js's own resolvable set actually tracks that shared array rather than
// a locally-duplicated list that could silently drift. For every status
// named in LIVE_PARK_STATUSES a queue entry is created with a scene readable
// for that status, and each is asserted individually against a single `park
// list` run — so if park.js's resolvable set omits any member, the failure
// names exactly that status. It additionally drives the halted-scope entry
// from that set end-to-end through `park resolve --reject` (→
// 'failed-plan'), and confirms a 'pending'-status entry — not a
// LIVE_PARK_STATUSES member — is refused by `park resolve --requeue`,
// unchanged.

await test("TC-SOT1: park list surfaces every LIVE_PARK_STATUSES member (named individually); halted-scope resolves via --reject to 'failed-plan'; 'pending' is refused by --requeue", async () => {
  const root = makeTmpRoot();
  try {
    const sceneForStatus = (status) => {
      switch (status) {
        case 'parked':
          return makeScene();
        case 'halted-review':
          return makeScene({ site: 'review-gate', round1: [], questions: ['HALT-QUESTION-X'] });
        case 'halted-analyzer':
          return makeScene({ site: 'analyzer-human', round1: [], questions: ['ANALYZER-QUESTION-X'] });
        case 'halted-scope':
          return makeScopeProposalScene();
        default:
          throw new Error(`TC-SOT1 fixture: no scene builder registered for LIVE_PARK_STATUSES member '${status}'`);
      }
    };

    for (const status of LIVE_PARK_STATUSES) {
      const slug = `sot1-${status}`;
      const isScope = status === 'halted-scope';
      createQueueEntry(root, slug, {
        status,
        spec: isScope ? SCOPE_SPEC_MD : SPEC_MD,
        specJson: isScope ? scopeSpecJson(['existing/declared.js']) : SPEC_JSON,
      });
      writeScene(root, slug, sceneForStatus(status));
    }

    const res = runCli(root, ['park', 'list']);
    assert.strictEqual(res.status, 0,
      `park list must exit 0 across every LIVE_PARK_STATUSES entry (got ${res.status}; output: ${res.out.trim().slice(0, 300)})`);

    for (const status of LIVE_PARK_STATUSES) {
      const slug = `sot1-${status}`;
      assert.ok(res.stdout.includes(slug),
        `park list's resolvable set omits LIVE_PARK_STATUSES member '${status}' — expected slug '${slug}' in output: ${res.stdout.trim().slice(0, 500)}`);
    }

    // The halted-scope entry from the set above is resolvable end-to-end:
    // --reject transitions it to 'failed-plan'.
    const scopeSlug = 'sot1-halted-scope';
    const resReject = runCli(root, ['park', 'resolve', scopeSlug, '--reject']);
    assert.strictEqual(resReject.status, 0,
      `resolve --reject must succeed on the LIVE_PARK_STATUSES halted-scope entry (got exit ${resReject.status}; output: ${resReject.out.trim().slice(0, 300)})`);
    assert.strictEqual(readStatus(root, scopeSlug), 'failed-plan',
      "resolve --reject on the LIVE_PARK_STATUSES halted-scope entry must leave the status file reading 'failed-plan'");

    // A 'pending'-status entry is NOT a LIVE_PARK_STATUSES member and must be
    // refused, state unchanged.
    createQueueEntry(root, 'sot1-pending', { status: 'pending' });
    writeScene(root, 'sot1-pending', makeScene());
    const resPending = runCli(root, ['park', 'resolve', 'sot1-pending', '--requeue']);
    assertNonSilentFailure(resPending, "resolve --requeue on a 'pending'-status entry");
    assert.strictEqual(readStatus(root, 'sot1-pending'), 'pending',
      "an illegal transition on a 'pending'-status entry must leave the status unchanged");
  } finally {
    cleanup(root);
  }
});

// ── TC-FA1/TC-FA2: forensic-archive pointer render on park show ────────────

const FORENSIC_ARCHIVED_RE = /run logs archived at:/;

await test("TC-FA1: park show renders a 'run logs archived at:' line naming the scene's forensicArchiveDir", async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'forensic-entry', { status: 'halted-review' });
    writeScene(root, 'forensic-entry', makeScene({
      site: 'review-gate',
      round1: [],
      questions: ['HALT-QUESTION-X'],
      forensicArchiveDir: 'archives/failed-999-forensic',
    }));

    const res = runCli(root, ['park', 'show', 'forensic-entry']);
    assert.strictEqual(res.status, 0, `park show must exit 0 (got ${res.status}; output: ${res.out.trim().slice(0, 200)})`);

    const archivedLine = res.stdout.split('\n').find((line) => FORENSIC_ARCHIVED_RE.test(line));
    assert.ok(archivedLine,
      `park show must print a line matching /run logs archived at:/ for a scene carrying forensicArchiveDir (output: ${res.stdout.trim().slice(0, 400)})`);
    assert.ok(archivedLine.includes('archives/failed-999-forensic'),
      `the 'run logs archived at:' line must include the scene's forensicArchiveDir (got: ${archivedLine})`);
  } finally {
    cleanup(root);
  }
});

await test("TC-FA2: park show prints no 'run logs archived at:' line (but still prints the scene site) when the scene omits forensicArchiveDir", async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'no-forensic-entry', { status: 'halted-review' });
    const scene = makeScene({
      site: 'review-gate',
      round1: [],
      questions: ['HALT-QUESTION-X'],
    });
    delete scene.forensicArchiveDir; // explicitly ensure the key is absent, not just falsy
    writeScene(root, 'no-forensic-entry', scene);

    const res = runCli(root, ['park', 'show', 'no-forensic-entry']);
    assert.strictEqual(res.status, 0, `park show must exit 0 (got ${res.status}; output: ${res.out.trim().slice(0, 200)})`);

    const archivedLine = res.stdout.split('\n').find((line) => FORENSIC_ARCHIVED_RE.test(line));
    assert.ok(!archivedLine,
      `park show must NOT print a 'run logs archived at:' line for a scene lacking forensicArchiveDir (found: ${JSON.stringify(archivedLine)})`);
    assert.ok(res.stdout.includes('review-gate'), 'show must still print the scene site');
  } finally {
    cleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
