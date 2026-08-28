#!/usr/bin/env node
/**
 * test-usage-ledger.js — Unit contract test for the usage ledger
 * (src/orchestrator/core/usage-ledger.js).
 *
 * Exercises appendUsageLedger against a temp projectRoot (mkdtemp).
 * Self-contained pass/fail harness and temp-dir cleanup convention
 * mirrored from test/test-candidates-ledger.js.
 *
 * Coverage:
 *   TC1 — one appendUsageLedger call appends exactly one JSONL line whose
 *         parsed object carries the entry's runId and outcome.
 *   TC2 — two successive appendUsageLedger calls append two lines, one per
 *         call, preserving order.
 *   TC3 — fail-soft: with archives/usage-ledger.jsonl pre-created as a
 *         DIRECTORY so the write cannot succeed, appendUsageLedger returns
 *         without throwing and calls the injected onWarn spy exactly once
 *         with a message naming usage-ledger.jsonl.
 *   TC4 — an entry built for a run whose token-usage.json is
 *         absent/unreadable still appends one line whose parsed `totals`
 *         is null, so the disposition stays countable.
 *   TC5 — appendUsageLedger's return value is undefined and it never
 *         throws for a null/partial entry object.
 *   TC6 — an integration run (Pipeline.batchResume against a scratch git
 *         project root) that reaches the failed-criteria disposition
 *         (SpecCriterionError) appends exactly one usage-ledger line whose
 *         outcome is 'failed-criteria' and whose runId matches the run's
 *         actual _activeEntryRunId.
 *   TC7 — an integration run that reaches the failed-plan disposition
 *         (planner.planMission throw on a clean tree) appends exactly one
 *         usage-ledger line whose outcome is 'failed-plan'.
 *   TC8 — an integration run that reaches the failed-test-gate disposition
 *         (archive() throwing TestGateError) appends exactly one
 *         usage-ledger line whose outcome is 'failed-test-gate'.
 *   TC9 — an integration run that reaches the halted-assumptions
 *         disposition (assumptions still failing after the round-2
 *         re-verify, parked at the assumption-gate) appends exactly one
 *         usage-ledger line whose outcome is 'halted-assumptions'.
 *   TC10 — an integration run that reaches the SCOPE-PROPOSAL DETOUR (a
 *         planMission excursion carrying a candidatePlan) appends exactly
 *         one usage-ledger line whose outcome is 'halted-scope'.
 *   TC11 — a digest-mismatch re-park (an approved scope-proposal scene
 *         whose persisted candidatePlan no longer matches its stamped
 *         candidatePlanDigest) appends exactly one usage-ledger line whose
 *         outcome is 'halted-scope' and whose parsed totals is null
 *         (planMission is never invoked on this leg, so there is no
 *         token-usage.json for the freshly re-parked runId).
 *   TC12 — a failing dry-run (dryRunValidate's `{ queued: false }` leg)
 *         appends exactly one usage-ledger line whose outcome is
 *         'dry-run-failed'; a rejected review-gate plan (_reviewGate's 'r'
 *         choice) appends exactly one usage-ledger line whose outcome is
 *         'rejected'.
 *   TC13 — zero-emission / double-count-free negative: (a) a disposition
 *         that MOVES a runId's logs into an archive directory (a
 *         successful, archived batchResume completion) appends ZERO
 *         ledger lines for that runId; (b) an approved scope-proposal
 *         entry that is later PROMOTED and re-run under a freshly
 *         generated runId leaves the original park's runId represented by
 *         exactly one ledger line, and the promoted run's fresh runId by
 *         zero — no runId is ever represented by more than one line.
 *
 * TC14-TC17 exercise the TokenTracker flush contract
 * (src/orchestrator/infra/token-tracker.js) against a temp harness dir —
 * recordIncrementalUsage/flushInFlight/recordSession's partial-record
 * invariants documented atop that module.
 *   TC14 — after recordIncrementalUsage for an in-flight session, awaiting
 *         flushInFlight(reason) resolves and a freshly constructed
 *         TokenTracker over the same harness dir returns from
 *         getSessions() a record for that session with partial === true
 *         and flushReason equal to the passed reason.
 *   TC15 — awaiting a recordSession call and a flushInFlight call issued
 *         concurrently resolves both without deadlock and yields an
 *         on-disk token-usage.json that parses successfully with no lost
 *         session record (the _writeMutex promise queue serializes them).
 *   TC16 — a recordSession finalize for a name this same tracker instance
 *         flushed as partial leaves exactly one record for that name, no
 *         longer marked partial.
 *   TC17 — a partial record read back from disk by a new TokenTracker
 *         instance is preserved: a later recordSession for the same name
 *         on that new instance still returns the disk-loaded partial
 *         record from getSessions(); multi-turn reusable-session records
 *         bearing meta.reused/turnIdx keep their existing same-name
 *         multi-record behavior (recordSession never collapses distinct
 *         turns for the same session name unless this instance itself
 *
 * TC18-TC22 exercise usageAll's ledger/stale folding contract
 * (src/cli/commands/usage.js) against a scratch projectRoot seeded with
 * real archives, usage-ledger.jsonl lines, and .harness/stale/ run dirs.
 *   TC18 — with includeFailed:true, usageAll's printed JSON result.archives
 *         contains an archive-shaped row for a ledger runId (id derived
 *         from runId, a date, a sessionCount and a byRole map derived from
 *         its sessions) alongside the rows for the real archives.
 *   TC19 — with includeFailed defaulted false, result.archives contains no
 *         row for the ledger runId nor for the stale runId.
 *   TC20 — when the same runId appears in both the ledger and
 *         .harness/stale/, result.archives contains exactly one row for
 *         that runId and its values are the ledger's (ledger wins).
 *   TC21 — a since value later than a ledger row's timestamp omits that
 *         row while retaining rows on/after the boundary; a last:N value
 *         keeps only the N most recent rows including synthesized ones.
 *   TC22 — a role filter with includeFailed:true narrows the synthesized
 *         ledger/stale rows by role exactly as it narrows real archive
 *         rows.
 *         flushed a partial for that name).
 *
 * TC6-TC9 each drive the REAL Pipeline.batchResume against its own scratch
 * git project root (fixtures from test/helpers/batch-fixtures.js — the
 * same seam used by test-plan-time-disposition.js, test-test-gate-disposition.js
 * and test-spec-criterion-disposition.js) rather than calling
 * appendUsageLedger directly, so the emission-site wiring itself (not just
 * the ledger-writer unit in isolation) is under test for these four
 * dispositions. Each case asserts the ledger's runId equals the run's
 * ACTUAL this._activeEntryRunId (captured live via a stub called mid-entry,
 * since generateRunId() is not reproducible/predictable ahead of time) and
 * that the ledger carries exactly one line — proving no double-count.
 *
 * This suite is NOT a re-entrant cc-orch invocation — TC6-TC9's fixture
 * roots are isolated fs.mkdtemp() git repos (via makeGitRoot). But when
 * launched from inside a live cc-orch run, CC_ORCH_ACTIVE_RUN would be
 * inherited from the parent process environment and trip the reentrancy
 * guard on the freshly-bootstrapped active roots those fixtures construct.
 * Clear the marker unconditionally here, mirroring scripts/run-tests.js and
 * test/test-batch-resume.js.
 *
 * Run: node test/test-usage-ledger.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { usageLedgerPath, appendUsageLedger } from '../src/orchestrator/core/usage-ledger.js';
import { usageAll } from '../src/cli/commands/usage.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { readQueueEntry, writeQueueEntry, writeParkScene } from '../src/orchestrator/core/state.js';
import { SpecCriterionError } from '../src/orchestrator/core/spec-criterion-error.js';
import { TestGateError } from '../src/cli/commands/archive.js';
import { lintPlanScope, pendingLintArms } from '../src/orchestrator/gates/plan-scope-lint.js';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';
import { TokenTracker } from '../src/orchestrator/infra/token-tracker.js';
import {
  makeGitRoot,
  createQueueEntry,
  makeRealBatchPipeline,
  makeFakeArchive,
} from './helpers/batch-fixtures.js';

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

function makeTmpRoot(prefix = 'cc-orch-usage-ledger-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Tolerant raw JSONL read — never throws, skips unparseable lines. */
function readLinesRaw(ledgerFile) {
  if (!fs.existsSync(ledgerFile)) return [];
  const out = [];
  for (const line of fs.readFileSync(ledgerFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// TC18-TC22 helpers — usageAll ledger/stale folding contract.
// ---------------------------------------------------------------------------

/** stdout-capture helper mirrored from test/test-usage-all.js. */
function captureStdout(fn) {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log.bind(console);

  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => {
    chunks.push(args.join(' ') + '\n');
  };

  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }

  return chunks.join('');
}

/** Run usageAll in json mode and parse the printed result. */
function usageAllJson(root, options = {}) {
  const out = captureStdout(() => usageAll(root, { ...options, json: true }));
  return JSON.parse(out);
}

/** Stage a real archive at <root>/archives/<id>/logs/token-usage.json. */
function addRealArchive(root, id, sessions) {
  const logsDir = path.join(root, 'archives', id, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const totals = {
    sessionCount: sessions.length,
    totalCostUsd: sessions.reduce((s, e) => s + (e.totalCostUsd || 0), 0),
    cacheCreation: sessions.reduce((s, e) => s + (e.cacheCreation || 0), 0),
    cacheRead: sessions.reduce((s, e) => s + (e.cacheRead || 0), 0),
  };
  fs.writeFileSync(path.join(logsDir, 'token-usage.json'), JSON.stringify({ sessions, totals }, null, 2));
}

/**
 * Append a fully-controlled usage-ledger.jsonl line (bypassing
 * appendUsageLedger's `ts: new Date().toISOString()` stamping so the row's
 * date is deterministic for since/last assertions).
 */
function addLedgerLine(root, entry) {
  fs.mkdirSync(path.join(root, 'archives'), { recursive: true });
  const record = {
    ts: entry.ts,
    runId: entry.runId,
    slug: entry.slug ?? null,
    outcome: entry.outcome ?? 'failed-plan',
    totals: entry.totals ?? null,
    sessions: entry.sessions ?? [],
  };
  fs.appendFileSync(usageLedgerPath(root), JSON.stringify(record) + '\n');
}

/** Stage a stale run dir at <root>/.harness/stale/<runId>/logs/token-usage.json. */
function addStaleRunDir(root, runId, { ts, sessions }) {
  const logsDir = path.join(root, '.harness', 'stale', runId, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const data = { ts, sessions, totals: { sessionCount: sessions.length } };
  fs.writeFileSync(path.join(logsDir, 'token-usage.json'), JSON.stringify(data, null, 2));
}

async function run() {

await test('TC1: appendUsageLedger writes exactly one JSONL line carrying the given runId and outcome', async () => {
  const root = makeTmpRoot();
  try {
    appendUsageLedger(root, {
      runId: 'run-001',
      slug: 'my-slug',
      outcome: 'failed-criteria',
    });

    const ledgerFile = usageLedgerPath(root);
    assert.ok(fs.existsSync(ledgerFile), 'usage-ledger.jsonl must be created');

    const lines = readLinesRaw(ledgerFile);
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line; got ${lines.length}`);

    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.runId, 'run-001');
    assert.strictEqual(parsed.outcome, 'failed-criteria');
  } finally {
    cleanup(root);
  }
});

await test('TC2: two successive appendUsageLedger calls append two lines, one per call, preserving order', async () => {
  const root = makeTmpRoot();
  try {
    appendUsageLedger(root, { runId: 'run-first', slug: 'slug-a', outcome: 'failed-plan' });
    appendUsageLedger(root, { runId: 'run-second', slug: 'slug-b', outcome: 'rejected' });

    const ledgerFile = usageLedgerPath(root);
    const lines = readLinesRaw(ledgerFile);
    assert.strictEqual(lines.length, 2, `expected exactly two JSONL lines; got ${lines.length}`);

    const [first, second] = lines.map((l) => JSON.parse(l));
    assert.strictEqual(first.runId, 'run-first');
    assert.strictEqual(first.outcome, 'failed-plan');
    assert.strictEqual(second.runId, 'run-second');
    assert.strictEqual(second.outcome, 'rejected');
  } finally {
    cleanup(root);
  }
});

await test('TC3: an unwritable (directory) ledger path never throws and emits exactly one onWarn message naming usage-ledger.jsonl', async () => {
  const root = makeTmpRoot();
  try {
    const ledgerFile = usageLedgerPath(root);
    // Sabotage the write target: a DIRECTORY at the ledger path makes any
    // append/write throw (EISDIR).
    fs.mkdirSync(ledgerFile, { recursive: true });

    const warnings = [];
    const onWarn = (message) => warnings.push(message);

    let threw = null;
    try {
      appendUsageLedger(root, {
        runId: 'doomed-run',
        slug: 'doomed-slug',
        outcome: 'dry-run-failed',
      }, { onWarn });
    } catch (e) {
      threw = e;
    }

    assert.strictEqual(threw, null, `appendUsageLedger must never throw on a write failure; threw: ${threw && threw.message}`);
    assert.strictEqual(warnings.length, 1, `expected exactly one onWarn call; got ${warnings.length}`);
    assert.ok(
      typeof warnings[0] === 'string' && warnings[0].includes('usage-ledger.jsonl'),
      `expected the warning message to name usage-ledger.jsonl; got ${JSON.stringify(warnings[0])}`
    );
  } finally {
    cleanup(root);
  }
});

await test('TC4: an entry for a run with no readable token-usage.json appends one line whose parsed totals is null', async () => {
  const root = makeTmpRoot();
  try {
    const harnessDir = path.join(root, 'harness-missing-usage');
    // Deliberately do NOT create harnessDir/logs/token-usage.json — the file
    // is absent, so readRunUsage must fall back to the empty shape.
    fs.mkdirSync(harnessDir, { recursive: true });

    appendUsageLedger(root, {
      runId: 'run-no-usage',
      slug: 'slug-no-usage',
      outcome: 'halted-scope',
      harnessDir,
    });

    const ledgerFile = usageLedgerPath(root);
    const lines = readLinesRaw(ledgerFile);
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line; got ${lines.length}`);

    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.runId, 'run-no-usage');
    assert.strictEqual(parsed.outcome, 'halted-scope');
    assert.strictEqual(parsed.totals, null, 'totals must be null when token-usage.json is absent/unreadable');
  } finally {
    cleanup(root);
  }
});

await test('TC5: appendUsageLedger returns undefined and never throws for a null/partial entry object', async () => {
  const root = makeTmpRoot();
  try {
    let threw = null;
    let result;
    try {
      result = appendUsageLedger(root, null);
    } catch (e) {
      threw = e;
    }
    assert.strictEqual(threw, null, `appendUsageLedger must never throw for a null entry; threw: ${threw && threw.message}`);
    assert.strictEqual(result, undefined, 'appendUsageLedger must return undefined for a null entry');

    threw = null;
    try {
      result = appendUsageLedger(root, { runId: 'partial-run' });
    } catch (e) {
      threw = e;
    }
    assert.strictEqual(threw, null, `appendUsageLedger must never throw for a partial entry; threw: ${threw && threw.message}`);
    assert.strictEqual(result, undefined, 'appendUsageLedger must return undefined for a partial entry');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// TC6-TC9 — integration emission cases: drive Pipeline.batchResume against
// its own scratch git project root to each disposition and inspect the
// resulting usage-ledger.jsonl.
// ---------------------------------------------------------------------------

await test("TC6: a failed-criteria disposition appends exactly one ledger line whose outcome equals 'failed-criteria' and whose runId equals the parked runId", async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-usage-ledger-criteria-' });
  try {
    const slug = 'crit-fail-ledger';
    createQueueEntry(root, slug, {});

    let capturedRunId = null;
    const { pipeline } = makeRealBatchPipeline(root, {
      executeAllMilestones: async () => {
        // Captured mid-entry (after batchResume's per-entry loop stamps
        // this._activeEntryRunId, before the disposition below runs) —
        // this is the ACTUAL runId this run executed under.
        capturedRunId = pipeline._activeEntryRunId;
        throw new SpecCriterionError([{ name: 'README documents setup', targetFile: 'README.md' }]);
      },
    });
    pipeline.planner.verifyAssumptions = async () => [];

    const result = await pipeline.batchResume({ autonomous: true });
    assert.strictEqual(result.failed, 1, `Expected result.failed === 1, got ${result.failed}`);
    assert.ok(capturedRunId, 'expected a runId to have been captured during execution');

    const entry = readQueueEntry(root, slug);
    assert.strictEqual(entry?.status, 'failed-criteria', `Expected status 'failed-criteria', got '${entry?.status}'`);

    const lines = readLinesRaw(usageLedgerPath(root));
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line (no double-count); got ${lines.length}`);

    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.outcome, 'failed-criteria');
    assert.strictEqual(parsed.runId, capturedRunId);
  } finally {
    cleanup(root);
  }
});

await test("TC7: a failed-plan disposition appends exactly one ledger line whose outcome equals 'failed-plan'", async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-usage-ledger-plan-' });
  try {
    const slug = 'plan-fail-ledger';
    const plan = {
      milestones: [
        {
          id: 'ms1',
          description: 'Milestone 1',
          missions: [{ id: 'mi1', description: 'Mission 1' }],
        },
      ],
      assumptions: [],
    };
    createQueueEntry(root, slug, { plan });

    let capturedRunId = null;
    const { pipeline } = makeRealBatchPipeline(root);
    // Restore the REAL _executeAllMilestones (the fixture default is a
    // no-op stub) so the real entry-processing path reaches the
    // tag-and-rethrow plan-phase call site (mirrors
    // test-plan-time-disposition.js case (c)).
    pipeline._executeAllMilestones = Pipeline.prototype._executeAllMilestones;
    pipeline.planner.planMission = async () => {
      capturedRunId = pipeline._activeEntryRunId;
      throw new Error('planMission boom: cannot decompose mission');
    };

    const result = await pipeline.batchResume({ autonomous: true });
    assert.strictEqual(result.failed, 1, `Expected result.failed === 1, got ${result.failed}`);
    assert.ok(capturedRunId, 'expected a runId to have been captured during execution');

    const entry = readQueueEntry(root, slug);
    assert.strictEqual(entry?.status, 'failed-plan', `Expected status 'failed-plan', got '${entry?.status}'`);

    const lines = readLinesRaw(usageLedgerPath(root));
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line (no double-count); got ${lines.length}`);

    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.outcome, 'failed-plan');
    assert.strictEqual(parsed.runId, capturedRunId);
  } finally {
    cleanup(root);
  }
});

await test("TC8: a failed-test-gate disposition appends exactly one ledger line whose outcome equals 'failed-test-gate'", async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-usage-ledger-gate-' });
  try {
    const slug = 'gate-fail-ledger';
    createQueueEntry(root, slug, {});

    let capturedRunId = null;
    const { pipeline } = makeRealBatchPipeline(root, {
      archive: async (_projectRoot, archivedSlug) => {
        assert.strictEqual(archivedSlug, slug, `unexpected archive() call for slug '${archivedSlug}'`);
        throw new TestGateError(
          'Final test gate failed: `npm run test:all` exited 1. ' +
          'Refusing to archive a spec whose test suite does not pass.\n' +
          '--- tail of test output ---\n' +
          '  [FAIL] test/unit/foo.test.js\n' +
          '  Total: 1 failed, 3 passed'
        );
      },
      executeAllMilestones: async () => {
        capturedRunId = pipeline._activeEntryRunId;
      },
    });
    pipeline.planner.verifyAssumptions = async () => [];

    await pipeline.batchResume({ autonomous: true });
    assert.ok(capturedRunId, 'expected a runId to have been captured during execution');

    const entry = readQueueEntry(root, slug);
    assert.strictEqual(entry?.status, 'failed-test-gate', `Expected status 'failed-test-gate', got '${entry?.status}'`);

    const lines = readLinesRaw(usageLedgerPath(root));
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line (no double-count); got ${lines.length}`);

    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.outcome, 'failed-test-gate');
    assert.strictEqual(parsed.runId, capturedRunId);
  } finally {
    cleanup(root);
  }
});

await test("TC9: a halted-assumptions disposition appends exactly one ledger line whose outcome equals 'halted-assumptions'", async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-usage-ledger-assump-' });
  try {
    const slug = 'stale-assumption-ledger';
    // A specSection that does not exist in the default spec content: round-1
    // fails, remediation finds no matching section and skips, and round 2
    // fails identically → parked at the assumption-gate (mirrors
    // test-batch-resume.js TC4).
    const failedAssumption = { text: 'Persistent stale assumption', specSection: '## Stale' };
    const plan = { milestones: [], assumptions: [failedAssumption] };
    createQueueEntry(root, slug, { plan });

    let capturedRunId = null;
    const { pipeline } = makeRealBatchPipeline(root);
    pipeline.planner.verifyAssumptions = async () => {
      capturedRunId = pipeline._activeEntryRunId;
      return [{ assumption: failedAssumption, status: 'failed', evidence: 'Not found in codebase' }];
    };

    const result = await pipeline.batchResume({});
    assert.strictEqual(result.parked, 1, `Expected result.parked === 1, got ${result.parked}`);
    assert.ok(capturedRunId, 'expected a runId to have been captured during execution');

    const entry = readQueueEntry(root, slug);
    assert.strictEqual(entry?.status, 'parked', `Expected status 'parked', got '${entry?.status}'`);

    const lines = readLinesRaw(usageLedgerPath(root));
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line (no double-count); got ${lines.length}`);

    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.outcome, 'halted-assumptions');
    assert.strictEqual(parsed.runId, capturedRunId);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// TC10 — SCOPE-PROPOSAL DETOUR: an excursion-classified planMission failure
// (err.ruleId === 'scope-excursion' && err.candidatePlan) parks the entry as
// a scope-proposal scene and appends exactly one 'halted-scope' ledger line.
// ---------------------------------------------------------------------------

await test("TC10: a scope-proposal detour park appends exactly one ledger line whose outcome equals 'halted-scope'", async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-usage-ledger-scope-' });
  try {
    const slug = 'scope-detour-ledger';
    const plan = {
      milestones: [
        {
          id: 'ms1',
          description: 'Milestone 1',
          missions: [{ id: 'mi1', description: 'Mission 1' }],
        },
      ],
      assumptions: [],
    };
    createQueueEntry(root, slug, { plan });

    let capturedRunId = null;
    const { pipeline } = makeRealBatchPipeline(root);
    // Restore the REAL _executeAllMilestones (the fixture default is a
    // no-op stub) so the real entry-processing path reaches the
    // tag-and-rethrow plan-phase call site and, from there, the
    // SCOPE-PROPOSAL DETOUR (mirrors TC7 above / test-plan-scope-lint.js's
    // TC-SP1).
    pipeline._executeAllMilestones = Pipeline.prototype._executeAllMilestones;
    pipeline.planner.planMission = async () => {
      capturedRunId = pipeline._activeEntryRunId;
      // Run the REAL lintPlanScope against a plan whose one task targets a
      // path outside the declared set, then stamp candidatePlan/proposedBy
      // on the thrown error exactly as agents/planner.js does at its own
      // scope-excursion throw site — the pipeline's detour requires both
      // err.ruleId === 'scope-excursion' AND err.candidatePlan to engage.
      const excursionPlan = {
        subMissions: [
          { id: 'sm-excursion', tasks: [{ id: 'task-rogue', targetFiles: ['src/rogue.js'], dependencies: [] }] },
        ],
      };
      const declaredSet = new Set(['src/allowed.js']);
      try {
        lintPlanScope(excursionPlan, declaredSet);
      } catch (err) {
        err.candidatePlan = excursionPlan;
        err.proposedBy = 'planner-excursion';
        throw err;
      }
      throw new Error('scope-detour-ledger fixture bug: lintPlanScope did not throw for the excursion fixture');
    };

    await pipeline.batchResume({ autonomous: true });
    assert.ok(capturedRunId, 'expected a runId to have been captured during execution');

    const entry = readQueueEntry(root, slug);
    assert.strictEqual(entry?.status, 'halted-scope', `Expected status 'halted-scope', got '${entry?.status}'`);

    const lines = readLinesRaw(usageLedgerPath(root));
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line (no double-count); got ${lines.length}`);

    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.outcome, 'halted-scope');
    assert.strictEqual(parsed.runId, capturedRunId);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// TC11 — digest-mismatch re-park: an approved scope-proposal scene whose
// persisted candidatePlan no longer matches its stamped candidatePlanDigest
// (a hand-edit / corrupted rewrite after approval) is refused promotion and
// re-parked fresh, appending exactly one 'halted-scope' ledger line whose
// totals is null (planMission is never invoked on this leg — there is no
// token-usage.json for the freshly re-parked runId).
// ---------------------------------------------------------------------------

await test("TC11: a digest-mismatch re-park appends exactly one ledger line with outcome 'halted-scope' whose parsed totals is null", async () => {
  const root = makeGitRoot({ prefix: 'cc-orch-usage-ledger-digest-' });
  try {
    const slug = 'digest-mismatch-ledger';
    const plan = {
      milestones: [
        {
          id: 'ms1',
          description: 'Milestone 1',
          missions: [{ id: 'mi1', description: 'Mission 1' }],
        },
      ],
      assumptions: [],
    };
    createQueueEntry(root, slug, { plan, status: 'pending' });

    // The digest is stamped over the ORIGINAL candidatePlan, but the
    // persisted candidatePlan on the scene below has since diverged from it
    // (simulating a hand-edit after the original park/approve) — the
    // "approve what you saw" identity check must therefore fail.
    const originalCandidatePlan = { subMissions: [{ id: 'sm1', description: 'Original', tasks: [] }] };
    const originalDigest = crypto.createHash('sha256').update(JSON.stringify(originalCandidatePlan)).digest('hex');

    writeParkScene(root, slug, {
      site: 'plan-scope-lint',
      kind: 'scope-proposal',
      parkedAt: new Date(Date.now() - 86400000).toISOString(),
      proposedFiles: [
        { path: 'src/new/file-one.js', reason: '"src/new/file-one.js" is outside the spec-declared scope set', taskIds: ['mi1-001'] },
      ],
      candidatePlan: { subMissions: [{ id: 'sm1', description: 'MUTATED after approval', tasks: [] }] },
      missionId: 'mi1',
      lintArmsPending: ['uncovered-token', 'structure-cap', 'task-check-shapes'],
      proposedBy: 'planner-excursion',
      previousResolutions: [],
      resolution: { action: 'approve', at: new Date(Date.now() - 43200000).toISOString(), note: null, consumedAt: null },
      candidatePlanDigest: originalDigest,
    });

    const { pipeline } = makeRealBatchPipeline(root);
    pipeline.planner.planMission = async () => {
      throw new Error('planMission must never be invoked on the digest-mismatch re-park leg');
    };

    await pipeline.batchResume({ autonomous: true });
    // The digest-mismatch leg re-parks and `continue`s before this entry
    // ever reaches planMission, so capture the runId this._activeEntryRunId
    // stamped at the top of this (sole) entry's iteration, read back after
    // batchResume returns.
    const capturedRunId = pipeline._activeEntryRunId;
    assert.ok(capturedRunId, 'expected a runId to have been assigned to this entry');

    const entry = readQueueEntry(root, slug);
    assert.strictEqual(entry?.status, 'halted-scope', `Expected status 'halted-scope', got '${entry?.status}'`);

    const lines = readLinesRaw(usageLedgerPath(root));
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line (no double-count); got ${lines.length}`);

    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.outcome, 'halted-scope');
    assert.strictEqual(parsed.runId, capturedRunId);
    assert.strictEqual(parsed.totals, null, 'totals must be null for the freshly re-parked runId (no token-usage.json)');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// TC12 — a failing dry-run (dryRunValidate's `{ queued: false }` leg)
// appends exactly one 'dry-run-failed' ledger line; a rejected review-gate
// plan (_reviewGate's 'r' choice) appends exactly one 'rejected' ledger
// line.
// ---------------------------------------------------------------------------

await test("TC12: a failing dry-run appends exactly one line with outcome 'dry-run-failed', and a rejected plan appends exactly one line with outcome 'rejected'", async () => {
  // ── Part A: dryRunValidate stops after verifyAssumptions when the user
  // declines to proceed with an uncertain assumption (mirrors
  // test-dry-run.js TC3) — the resulting `{ queued: false }` return appends
  // exactly one 'dry-run-failed' ledger line. ──
  const dryRunRoot = makeTmpRoot('cc-orch-usage-ledger-dryrun-');
  try {
    bootstrap(dryRunRoot, {});
    const specPath = path.join(dryRunRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Test Spec\n\nBuild something.');
    fs.writeFileSync(
      path.join(dryRunRoot, 'spec.json'),
      JSON.stringify({
        goal: 'Build something.',
        target_files: ['src/foo.js'],
        acceptance_criteria: [{ description: 'it works', verification: { kind: 'manual' } }],
      }),
    );

    const pipeline = new Pipeline(dryRunRoot, {
      onLog: () => {},
      onConfirm: async () => false,
    });
    pipeline._runPreflight = () => {};
    pipeline.planner.planGlobal = async () => ({
      milestones: [{ id: '001', description: 'ms', missions: [{ id: '001-001', description: 'mi' }] }],
      assumptions: [{ text: 'Node.js >= 18 is installed', specSection: 'Requirements' }],
    });
    pipeline.planner.planMission = async (miId) => {
      throw new Error(`planMission should never be called in dryRunValidate (called with: ${miId})`);
    };
    pipeline.planner.verifyAssumptions = async () => [
      { assumption: { text: 'Node.js >= 18 is installed', specSection: 'Requirements' }, status: 'uncertain', evidence: 'Could not determine version' },
    ];
    pipeline.planner.closeReusableSession = async () => {};

    const result = await pipeline.dryRunValidate('Build a sample app', { prdPath: specPath });
    assert.strictEqual(result?.queued, false, `expected dryRunValidate to return queued:false; got ${JSON.stringify(result)}`);

    const lines = readLinesRaw(usageLedgerPath(dryRunRoot));
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line for the failing dry-run; got ${lines.length}`);
    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.outcome, 'dry-run-failed');
  } finally {
    cleanup(dryRunRoot);
  }

  // ── Part B: _reviewGate's 'r' (reject) choice throws with status
  // 'rejected' (mirrors test-review-gate.js TC2) — appends exactly one
  // 'rejected' ledger line. ──
  const rejectRoot = makeTmpRoot('cc-orch-usage-ledger-reject-');
  try {
    fs.mkdirSync(path.join(rejectRoot, '.harness', 'logs'), { recursive: true });
    const pipeline = new Pipeline(rejectRoot, { onLog: () => {} });
    pipeline.onMenu = async () => 'r';

    let caughtError = null;
    try {
      await pipeline._reviewGate({});
    } catch (err) {
      caughtError = err;
    }
    assert.ok(caughtError, 'expected _reviewGate to throw when "r" is chosen');
    assert.strictEqual(caughtError.status, 'rejected', `expected caughtError.status 'rejected', got '${caughtError.status}'`);

    const lines = readLinesRaw(usageLedgerPath(rejectRoot));
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line for the rejected plan; got ${lines.length}`);
    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.outcome, 'rejected');
  } finally {
    cleanup(rejectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC13 — zero-emission / double-count-free negative.
//
// Part A: a disposition that MOVES a runId's logs into an archive directory
// (a successful, archived batchResume completion — success carries no
// usage-ledger outcome at all) appends ZERO ledger lines for that runId.
//
// Part B: an approved scope-proposal entry that is later PROMOTED and
// re-run under a freshly generated runId leaves the original park's runId
// represented by exactly one ledger line, and the promoted run's fresh
// runId by zero — no runId is ever represented by more than one line.
// ---------------------------------------------------------------------------

await test('TC13: an archiving disposition appends zero ledger lines for that runId, and a requeue/promotion under a fresh runId leaves at most one line per distinct runId', async () => {
  // ── Part A: a fully successful, archived batchResume completion never
  // touches the usage ledger for its runId. ──
  const archiveRoot = makeGitRoot({ prefix: 'cc-orch-usage-ledger-archive-' });
  try {
    const slug = 'clean-archive-ledger';
    createQueueEntry(archiveRoot, slug, {});

    let capturedRunId = null;
    const { pipeline } = makeRealBatchPipeline(archiveRoot, {
      archive: makeFakeArchive(),
      executeAllMilestones: async () => {
        capturedRunId = pipeline._activeEntryRunId;
      },
    });
    pipeline.planner.verifyAssumptions = async () => [];

    const result = await pipeline.batchResume({});
    assert.strictEqual(result.archived, 1, `Expected result.archived === 1, got ${result.archived}`);
    assert.ok(capturedRunId, 'expected a runId to have been captured during execution');

    const entry = readQueueEntry(archiveRoot, slug);
    assert.strictEqual(entry, null, `Expected the queue entry to be removed after a successful archive, got: ${JSON.stringify(entry)}`);

    const linesForRunId = readLinesRaw(usageLedgerPath(archiveRoot))
      .map((l) => JSON.parse(l))
      .filter((l) => l.runId === capturedRunId);
    assert.strictEqual(linesForRunId.length, 0, `expected zero usage-ledger lines for the archived runId; got ${linesForRunId.length}`);
  } finally {
    cleanup(archiveRoot);
  }

  // ── Part B: an approved scope-proposal entry that is PROMOTED under a
  // fresh runId, whose re-run lint arms hit a FRESH excursion (a candidate
  // task now targets a path never approved), re-parks 'halted-scope' again
  // — mirrors test-cli-park.js's TC-PR4. This drives TWO real dispositions
  // under TWO distinct runIds (the original park, and the fresh re-park)
  // and proves the ledger never double-counts either one: each runId is
  // represented by exactly one line, never two.
  const promoRoot = makeTmpRoot('cc-orch-usage-ledger-promo-');
  try {
    const slug = 'promoted-double-count-ledger';
    const missionId = '001-001';
    const submissionId = '001-001-001';

    writeQueueEntry(promoRoot, slug, {
      spec: '# Test Spec\n\nPromotion double-count-free fixture.\n\n## Scope\n- existing/declared.js\n',
      plan: {
        milestones: [{ id: '001', description: 'Promotion milestone', missions: [{ id: missionId, description: `Mission ${missionId}` }] }],
        assumptions: [],
        scopeItems: [],
        scopeMapping: [],
      },
      validatedAt: new Date().toISOString(),
      status: 'pending',
      specJson: JSON.stringify({
        goal: 'promotion fixture goal',
        // Only the ORIGINALLY proposed/approved path is declared —
        // 'src/new/fresh-excursion.js' is NOT, so it surfaces as a new
        // excursion when promotion re-checks the candidate plan.
        target_files: ['existing/declared.js', 'src/new/file-one.js'],
        acceptance_criteria: ['AC fixture'],
        constraints: ['constraint fixture'],
      }),
    });

    const candidatePlan = {
      subMissions: [
        {
          id: submissionId,
          description: 'Promoted sub-mission with a fresh excursion',
          tasks: [
            {
              id: `${submissionId}-001`,
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
    const candidatePlanDigest = crypto.createHash('sha256').update(JSON.stringify(candidatePlan)).digest('hex');

    writeParkScene(promoRoot, slug, {
      site: 'plan-scope-lint',
      kind: 'scope-proposal',
      parkedAt: new Date(Date.now() - 86400000).toISOString(),
      proposedFiles: [
        { path: 'src/new/file-one.js', reason: '"src/new/file-one.js" is outside the spec-declared scope set', taskIds: ['001-001-001-001'] },
      ],
      candidatePlan,
      missionId,
      lintArmsPending: pendingLintArms('scope-excursion'),
      proposedBy: 'planner-excursion',
      previousResolutions: [],
      resolution: { action: 'approve', at: new Date(Date.now() - 43200000).toISOString(), note: null, consumedAt: null },
      candidatePlanDigest,
    });

    // The original park's disposition already recorded a ledger fact for
    // its own (now-spent) runId — exactly what TC10 above proves happens
    // for real at the SCOPE-PROPOSAL DETOUR. Recorded directly here (rather
    // than re-driving the detour) so this case can focus purely on the
    // promotion leg's double-count-free behavior.
    const priorRunId = 'orig-parked-run-tc13-fixture';
    appendUsageLedger(promoRoot, { runId: priorRunId, slug, outcome: 'halted-scope' });

    const pipeline = new Pipeline(promoRoot, {
      skipWorktreeCreation: true,
      noReview: true,
      onLog: () => {},
      onConfirm: async () => true,
      archive: async () => 'fake-archive-dir',
    });
    pipeline._skipCoverageGate = true;
    pipeline.planner.planMission = async () => {
      throw new Error('planMission must never be invoked for an approved, digest-matching scope-proposal promotion');
    };

    await pipeline.batchResume({});

    const promotedRunId = pipeline._activeEntryRunId;
    assert.ok(promotedRunId, 'expected a fresh runId to have been assigned to the promoted run');
    assert.notStrictEqual(promotedRunId, priorRunId, 'promotion must execute under a FRESH runId, never reusing the parked runId');

    const entry = readQueueEntry(promoRoot, slug);
    assert.strictEqual(entry?.status, 'halted-scope', `expected the fresh excursion to re-park 'halted-scope'; got '${entry?.status}'`);

    const parsedLines = readLinesRaw(usageLedgerPath(promoRoot)).map((l) => JSON.parse(l));
    assert.strictEqual(parsedLines.length, 2, `expected exactly two ledger lines total (one per distinct runId); got ${parsedLines.length}: ${JSON.stringify(parsedLines)}`);
    assert.ok(
      parsedLines.every((l) => l.outcome === 'halted-scope'),
      `expected both ledger lines to carry outcome 'halted-scope'; got ${JSON.stringify(parsedLines.map((l) => l.outcome))}`,
    );

    const runIdCounts = new Map();
    for (const l of parsedLines) {
      runIdCounts.set(l.runId, (runIdCounts.get(l.runId) || 0) + 1);
    }
    assert.strictEqual(runIdCounts.size, 2, `expected exactly two distinct runIds in the ledger; got ${runIdCounts.size}: ${JSON.stringify([...runIdCounts.keys()])}`);
    assert.ok(runIdCounts.has(priorRunId), `expected the original park's runId '${priorRunId}' to appear in the ledger`);
    assert.ok(runIdCounts.has(promotedRunId), `expected the fresh re-parked runId '${promotedRunId}' to appear in the ledger`);
    for (const [rid, count] of runIdCounts) {
      assert.strictEqual(count, 1, `runId '${rid}' must never appear more than once in the ledger (double-count-free); got ${count}`);
    }
  } finally {
    cleanup(promoRoot);
  }
});

// ---------------------------------------------------------------------------
// TC14-TC17 — TokenTracker flush contract (src/orchestrator/infra/token-tracker.js)
// exercised against a temp harness dir.
// ---------------------------------------------------------------------------

function makeHarnessRoot(prefix = 'cc-orch-token-tracker-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

await test('TC14: flushInFlight(reason) resolves and a reloaded TokenTracker\'s getSessions() returns the in-flight session as partial:true with the passed flushReason', async () => {
  const harnessDir = makeHarnessRoot();
  try {
    const tracker = new TokenTracker(harnessDir);
    tracker.recordIncrementalUsage('exec-inflight-1', 'executor', {
      input_tokens: 111,
      output_tokens: 22,
      total_cost_usd: 0.007,
    });

    const flushedCount = await tracker.flushInFlight('shutdown-signal');
    assert.strictEqual(flushedCount, 1, `expected exactly one flushed record; got ${flushedCount}`);

    const reloaded = new TokenTracker(harnessDir);
    const sessions = reloaded.getSessions();
    const record = sessions.find((s) => s.name === 'exec-inflight-1');
    assert.ok(record, 'expected a session record for exec-inflight-1 in the reloaded tracker');
    assert.strictEqual(record.partial, true, `expected partial === true; got ${JSON.stringify(record.partial)}`);
    assert.strictEqual(record.flushReason, 'shutdown-signal', `expected flushReason === 'shutdown-signal'; got ${JSON.stringify(record.flushReason)}`);
    assert.strictEqual(record.inputTokens, 111, `expected inputTokens preserved through flush; got ${record.inputTokens}`);
  } finally {
    cleanup(harnessDir);
  }
});

await test('TC15: a concurrent recordSession + flushInFlight both resolve without deadlock, and the persisted token-usage.json parses with no lost session record', async () => {
  const harnessDir = makeHarnessRoot();
  try {
    const tracker = new TokenTracker(harnessDir);
    // Seed a second, distinct in-flight session so flushInFlight() has
    // something to flush concurrently with the recordSession() finalize
    // below (which targets a different session name entirely).
    tracker.recordIncrementalUsage('exec-concurrent-flush', 'executor', {
      input_tokens: 50,
      output_tokens: 25,
      total_cost_usd: 0.003,
    });

    const recordPromise = tracker.recordSession('exec-concurrent-finalize', 'executor', {
      usage: { input_tokens: 200, output_tokens: 100 },
      total_cost_usd: 0.02,
    });
    const flushPromise = tracker.flushInFlight('concurrent-test');

    const [, flushedCount] = await Promise.all([recordPromise, flushPromise]);
    assert.strictEqual(flushedCount, 1, `expected exactly one flushed record; got ${flushedCount}`);

    const usagePath = path.join(harnessDir, 'logs', 'token-usage.json');
    assert.ok(fs.existsSync(usagePath), 'token-usage.json must exist on disk');
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
    }, 'token-usage.json must parse successfully after concurrent writes');

    const names = parsed.sessions.map((s) => s.name);
    assert.ok(names.includes('exec-concurrent-finalize'), `expected finalized session in parsed sessions; got ${JSON.stringify(names)}`);
    assert.ok(names.includes('exec-concurrent-flush'), `expected flushed session in parsed sessions; got ${JSON.stringify(names)}`);
    assert.strictEqual(parsed.sessions.length, 2, `expected exactly two session records (no lost record); got ${parsed.sessions.length}`);
  } finally {
    cleanup(harnessDir);
  }
});

await test('TC16: a recordSession finalize for a name this instance flushed as partial leaves exactly one record for that name, no longer marked partial', async () => {
  const harnessDir = makeHarnessRoot();
  try {
    const tracker = new TokenTracker(harnessDir);
    tracker.recordIncrementalUsage('exec-finalize-after-flush', 'executor', {
      input_tokens: 75,
      output_tokens: 30,
      total_cost_usd: 0.004,
    });

    await tracker.flushInFlight('mid-run-checkpoint');

    let sessions = tracker.getSessions().filter((s) => s.name === 'exec-finalize-after-flush');
    assert.strictEqual(sessions.length, 1, `expected exactly one partial record post-flush; got ${sessions.length}`);
    assert.strictEqual(sessions[0].partial, true, 'expected the pre-finalize record to be partial');

    await tracker.recordSession('exec-finalize-after-flush', 'executor', {
      usage: { input_tokens: 500, output_tokens: 250 },
      total_cost_usd: 0.05,
    });

    sessions = tracker.getSessions().filter((s) => s.name === 'exec-finalize-after-flush');
    assert.strictEqual(sessions.length, 1, `expected exactly one record for the name after finalize (replaced in place); got ${sessions.length}`);
    assert.notStrictEqual(sessions[0].partial, true, `expected the finalized record to no longer be marked partial; got ${JSON.stringify(sessions[0].partial)}`);
    assert.strictEqual(sessions[0].inputTokens, 500, `expected the finalized record's inputTokens to reflect the recordSession call; got ${sessions[0].inputTokens}`);

    // The on-disk copy must reflect the same single-record replacement.
    const usagePath = path.join(harnessDir, 'logs', 'token-usage.json');
    const parsed = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
    const diskSessions = parsed.sessions.filter((s) => s.name === 'exec-finalize-after-flush');
    assert.strictEqual(diskSessions.length, 1, `expected exactly one on-disk record for the name; got ${diskSessions.length}`);
    assert.notStrictEqual(diskSessions[0].partial, true, 'expected the on-disk record to no longer be marked partial');
  } finally {
    cleanup(harnessDir);
  }
});

await test('TC17: a disk-loaded partial record is preserved across a same-name recordSession on a new instance, and meta.reused/turnIdx multi-turn records keep their same-name multi-record behavior', async () => {
  const harnessDir = makeHarnessRoot();
  try {
    // ── Part A: a partial record written by tracker A is loaded fresh by
    // tracker B (never registered in B's _flushedPartials), so a same-name
    // recordSession on B must NOT replace it in place — both must survive. ──
    const trackerA = new TokenTracker(harnessDir);
    trackerA.recordIncrementalUsage('exec-cross-instance', 'executor', {
      input_tokens: 60,
      output_tokens: 15,
      total_cost_usd: 0.002,
    });
    await trackerA.flushInFlight('process-exit');

    const trackerB = new TokenTracker(harnessDir);
    let bSessions = trackerB.getSessions().filter((s) => s.name === 'exec-cross-instance');
    assert.strictEqual(bSessions.length, 1, `expected the disk-loaded partial record to be visible to trackerB; got ${bSessions.length}`);
    assert.strictEqual(bSessions[0].partial, true, 'expected the disk-loaded record to still be partial');

    await trackerB.recordSession('exec-cross-instance', 'executor', {
      usage: { input_tokens: 999, output_tokens: 444 },
      total_cost_usd: 0.09,
    });

    bSessions = trackerB.getSessions().filter((s) => s.name === 'exec-cross-instance');
    assert.ok(
      bSessions.some((s) => s.partial === true),
      `expected the disk-loaded partial record to be PRESERVED (not overwritten) by trackerB's recordSession; got ${JSON.stringify(bSessions)}`,
    );
    assert.ok(
      bSessions.some((s) => s.partial !== true && s.inputTokens === 999),
      `expected the freshly finalized record to also be present alongside the preserved partial; got ${JSON.stringify(bSessions)}`,
    );

    // ── Part B: multi-turn reusable-session records bearing meta.reused/
    // turnIdx keep their existing same-name multi-record behavior — distinct
    // turns for the same session name are never collapsed by recordSession. ──
    const reuseRoot = makeHarnessRoot('cc-orch-token-tracker-reuse-');
    try {
      const tracker = new TokenTracker(reuseRoot);
      await tracker.recordSession('planner-reused-session', 'planner', {
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.001,
      }, { reused: true, turnIdx: 0 });
      await tracker.recordSession('planner-reused-session', 'planner', {
        usage: { input_tokens: 20, output_tokens: 8 },
        total_cost_usd: 0.002,
      }, { reused: true, turnIdx: 1 });

      const reusedSessions = tracker.getSessions().filter((s) => s.name === 'planner-reused-session');
      assert.strictEqual(reusedSessions.length, 2, `expected two distinct turn records for the reused session name; got ${reusedSessions.length}`);
      const turnIdxValues = reusedSessions.map((s) => s.turnIdx).sort();
      assert.deepStrictEqual(turnIdxValues, [0, 1], `expected turnIdx values [0, 1]; got ${JSON.stringify(turnIdxValues)}`);
      assert.ok(reusedSessions.every((s) => s.meta === undefined && s.reused === true), `expected reused === true spread directly onto each record; got ${JSON.stringify(reusedSessions)}`);
    } finally {
      cleanup(reuseRoot);
    }
  } finally {
    cleanup(harnessDir);
  }
});

// ---------------------------------------------------------------------------
// TC18-TC22 — usageAll ledger/stale folding contract (src/cli/commands/usage.js)
// ---------------------------------------------------------------------------

await test('TC18: usageAll json includeFailed:true folds a ledger runId into result.archives as an archive-shaped row alongside real archives', async () => {
  const root = makeTmpRoot('cc-orch-usage-all-fold-');
  try {
    addRealArchive(root, '2026-01-01-real-archive-a', [
      { name: 'exec-real-1', type: 'executor', inputTokens: 100, outputTokens: 50, cacheCreation: 20, cacheRead: 10, totalCostUsd: 0.02, startedAt: '2026-01-01T10:00:00.000Z' },
    ]);

    const ledgerRunId = 'run-20260115T000000-ledger-abcd';
    addLedgerLine(root, {
      ts: '2026-01-15T00:00:00.000Z',
      runId: ledgerRunId,
      slug: 'ledger-fold-slug',
      outcome: 'failed-plan',
      totals: { sessionCount: 1, totalCostUsd: 0.03, cacheCreation: 40, cacheRead: 20 },
      sessions: [
        { name: 'exec-ledger-1', type: 'executor', inputTokens: 200, outputTokens: 90, cacheCreation: 40, cacheRead: 20, totalCostUsd: 0.03 },
      ],
    });

    const result = usageAllJson(root, { includeFailed: true });

    const ledgerRow = result.archives.find((a) => a.id === ledgerRunId);
    assert.ok(ledgerRow, `expected an archive-shaped row for ledger runId ${ledgerRunId}; got ids: ${JSON.stringify(result.archives.map((a) => a.id))}`);
    assert.strictEqual(ledgerRow.date, '2026-01-15', `expected the ledger row's date to be derived from ts; got ${ledgerRow.date}`);
    assert.strictEqual(ledgerRow.sessionCount, 1, `expected the ledger row's sessionCount to be 1; got ${ledgerRow.sessionCount}`);
    assert.ok(ledgerRow.byRole && ledgerRow.byRole.executor, `expected byRole.executor on the ledger row; got ${JSON.stringify(ledgerRow.byRole)}`);
    assert.strictEqual(ledgerRow.byRole.executor.sessionCount, 1, `expected byRole.executor.sessionCount to be 1; got ${ledgerRow.byRole.executor.sessionCount}`);

    const realRow = result.archives.find((a) => a.id === '2026-01-01-real-archive-a');
    assert.ok(realRow, 'expected the real archive row to still be present, unchanged');
    assert.strictEqual(realRow.sessionCount, 1, `expected the real archive row's sessionCount to be 1; got ${realRow.sessionCount}`);
  } finally {
    cleanup(root);
  }
});

await test('TC19: usageAll json includeFailed defaulted false excludes ledger and stale rows entirely', async () => {
  const root = makeTmpRoot('cc-orch-usage-all-fold-');
  try {
    addRealArchive(root, '2026-01-01-real-archive-b', [
      { name: 'exec-real-2', type: 'executor', inputTokens: 100, outputTokens: 50, cacheCreation: 20, cacheRead: 10, totalCostUsd: 0.02, startedAt: '2026-01-01T10:00:00.000Z' },
    ]);

    const ledgerRunId = 'run-20260116T000000-ledger-defb';
    addLedgerLine(root, {
      ts: '2026-01-16T00:00:00.000Z',
      runId: ledgerRunId,
      sessions: [{ name: 'exec-ledger-2', type: 'executor', inputTokens: 10, outputTokens: 5, cacheCreation: 0, cacheRead: 0, totalCostUsd: 0.001 }],
      totals: { sessionCount: 1, totalCostUsd: 0.001 },
    });

    const staleRunId = 'run-20260117T000000-stale-defc';
    addStaleRunDir(root, staleRunId, {
      ts: '2026-01-17T00:00:00.000Z',
      sessions: [{ name: 'exec-stale-1', type: 'executor', inputTokens: 10, outputTokens: 5, cacheCreation: 0, cacheRead: 0, totalCostUsd: 0.001 }],
    });

    const result = usageAllJson(root, {}); // includeFailed defaults to false

    assert.strictEqual(result.archives.find((a) => a.id === ledgerRunId), undefined, `expected no row for the ledger runId when includeFailed is false; got ids: ${JSON.stringify(result.archives.map((a) => a.id))}`);
    assert.strictEqual(result.archives.find((a) => a.id === staleRunId), undefined, `expected no row for the stale runId when includeFailed is false; got ids: ${JSON.stringify(result.archives.map((a) => a.id))}`);
    assert.ok(result.archives.find((a) => a.id === '2026-01-01-real-archive-b'), 'expected the real archive row to still be present');
  } finally {
    cleanup(root);
  }
});

await test('TC20: a runId present in both the ledger and .harness/stale/ yields exactly one archives row carrying the ledger values', async () => {
  const root = makeTmpRoot('cc-orch-usage-all-fold-');
  try {
    const dupeRunId = 'run-20260118T000000-dupe-abcd';

    addLedgerLine(root, {
      ts: '2026-01-18T00:00:00.000Z',
      runId: dupeRunId,
      sessions: [
        { name: 'exec-ledger-dupe', type: 'executor', inputTokens: 100, outputTokens: 50, cacheCreation: 10, cacheRead: 5, totalCostUsd: 0.05 },
      ],
      totals: { sessionCount: 1, totalCostUsd: 0.05 },
    });

    // A stale run dir for the SAME runId, carrying visibly different
    // (larger) values — the ledger must win, not the stale copy.
    addStaleRunDir(root, dupeRunId, {
      ts: '2026-01-18T00:00:00.000Z',
      sessions: [
        { name: 'exec-stale-dupe-1', type: 'executor', inputTokens: 1, outputTokens: 1, cacheCreation: 0, cacheRead: 0, totalCostUsd: 0.001 },
        { name: 'exec-stale-dupe-2', type: 'executor', inputTokens: 1, outputTokens: 1, cacheCreation: 0, cacheRead: 0, totalCostUsd: 0.001 },
        { name: 'exec-stale-dupe-3', type: 'executor', inputTokens: 1, outputTokens: 1, cacheCreation: 0, cacheRead: 0, totalCostUsd: 0.001 },
      ],
    });

    const result = usageAllJson(root, { includeFailed: true });

    const matches = result.archives.filter((a) => a.id === dupeRunId);
    assert.strictEqual(matches.length, 1, `expected exactly one row for runId ${dupeRunId}; got ${matches.length}`);
    assert.strictEqual(matches[0].sessionCount, 1, `expected the ledger's sessionCount (1) to win over the stale copy's (3); got ${matches[0].sessionCount}`);
    assert.strictEqual(matches[0].totalCostUsd, 0.05, `expected the ledger's totalCostUsd (0.05) to win over the stale copy's; got ${matches[0].totalCostUsd}`);
  } finally {
    cleanup(root);
  }
});

await test('TC21: a since boundary omits an earlier ledger row while retaining rows on/after it, and last:N keeps only the N most recent rows including synthesized ones', async () => {
  const root = makeTmpRoot('cc-orch-usage-all-fold-');
  try {
    addRealArchive(root, '2026-01-01-real-archive-c', [
      { name: 'exec-real-3', type: 'executor', inputTokens: 10, outputTokens: 5, cacheCreation: 0, cacheRead: 0, totalCostUsd: 0.01, startedAt: '2026-01-01T10:00:00.000Z' },
    ]);

    const l1RunId = 'run-20260105T000000-l1-aaaa';
    addLedgerLine(root, {
      ts: '2026-01-05T00:00:00.000Z',
      runId: l1RunId,
      sessions: [{ name: 'exec-l1', type: 'executor', inputTokens: 10, outputTokens: 5, cacheCreation: 0, cacheRead: 0, totalCostUsd: 0.01 }],
      totals: { sessionCount: 1, totalCostUsd: 0.01 },
    });

    const l2RunId = 'run-20260120T000000-l2-bbbb';
    addLedgerLine(root, {
      ts: '2026-01-20T00:00:00.000Z',
      runId: l2RunId,
      sessions: [{ name: 'exec-l2', type: 'executor', inputTokens: 10, outputTokens: 5, cacheCreation: 0, cacheRead: 0, totalCostUsd: 0.02 }],
      totals: { sessionCount: 1, totalCostUsd: 0.02 },
    });

    const staleRunId = 'run-20260125T000000-stale-cccc';
    addStaleRunDir(root, staleRunId, {
      ts: '2026-01-25T00:00:00.000Z',
      sessions: [{ name: 'exec-stale-c', type: 'executor', inputTokens: 10, outputTokens: 5, cacheCreation: 0, cacheRead: 0, totalCostUsd: 0.03 }],
    });

    // Part A: since later than l1's timestamp (2026-01-05) omits l1, while
    // l2 (2026-01-20) and the stale row (2026-01-25), both on/after the
    // boundary, are retained (as is the real archive filter's own behavior,
    // dropping the 2026-01-01 archive — already covered by test-usage-all.js).
    const sinceResult = usageAllJson(root, { includeFailed: true, since: '2026-01-15' });
    const sinceIds = sinceResult.archives.map((a) => a.id);
    assert.ok(!sinceIds.includes(l1RunId), `expected ledger row ${l1RunId} (before the since boundary) to be omitted; got ids: ${JSON.stringify(sinceIds)}`);
    assert.ok(sinceIds.includes(l2RunId), `expected ledger row ${l2RunId} (on/after the since boundary) to be retained; got ids: ${JSON.stringify(sinceIds)}`);
    assert.ok(sinceIds.includes(staleRunId), `expected stale row ${staleRunId} (on/after the since boundary) to be retained; got ids: ${JSON.stringify(sinceIds)}`);

    // Part B: last:2 (no since) keeps only the 2 most recent rows overall,
    // chronologically the l2 ledger row and the stale row — both synthesized.
    const lastResult = usageAllJson(root, { includeFailed: true, last: 2 });
    const lastIds = lastResult.archives.map((a) => a.id);
    assert.strictEqual(lastResult.archives.length, 2, `expected exactly 2 rows with last:2; got ${lastResult.archives.length}: ${JSON.stringify(lastIds)}`);
    assert.ok(lastIds.includes(l2RunId), `expected ${l2RunId} among the 2 most recent rows; got ${JSON.stringify(lastIds)}`);
    assert.ok(lastIds.includes(staleRunId), `expected ${staleRunId} among the 2 most recent rows; got ${JSON.stringify(lastIds)}`);
  } finally {
    cleanup(root);
  }
});

await test('TC22: a role filter with includeFailed:true narrows synthesized ledger/stale rows exactly as it narrows real archive rows', async () => {
  const root = makeTmpRoot('cc-orch-usage-all-fold-');
  try {
    addRealArchive(root, '2026-01-01-real-archive-d', [
      { name: 'exec-real-4', type: 'executor', inputTokens: 100, outputTokens: 50, cacheCreation: 10, cacheRead: 5, totalCostUsd: 0.05, startedAt: '2026-01-01T10:00:00.000Z' },
      { name: 'plan-real-4', type: 'planner', inputTokens: 20, outputTokens: 10, cacheCreation: 2, cacheRead: 1, totalCostUsd: 0.01, startedAt: '2026-01-01T09:00:00.000Z' },
    ]);

    const ledgerRunId = 'run-20260110T000000-role-eeee';
    addLedgerLine(root, {
      ts: '2026-01-10T00:00:00.000Z',
      runId: ledgerRunId,
      sessions: [
        { name: 'exec-ledger-role', type: 'executor', inputTokens: 50, outputTokens: 25, cacheCreation: 5, cacheRead: 2, totalCostUsd: 0.03 },
        { name: 'analyzer-ledger-role', type: 'analyzer', inputTokens: 10, outputTokens: 5, cacheCreation: 0, cacheRead: 0, totalCostUsd: 0.005 },
      ],
      totals: { sessionCount: 2, totalCostUsd: 0.035 },
    });

    const staleRunId = 'run-20260112T000000-role-ffff';
    addStaleRunDir(root, staleRunId, {
      ts: '2026-01-12T00:00:00.000Z',
      sessions: [
        { name: 'verifier-stale-role', type: 'verifier', inputTokens: 5, outputTokens: 2, cacheCreation: 0, cacheRead: 0, totalCostUsd: 0.002 },
      ],
    });

    const result = usageAllJson(root, { includeFailed: true, role: 'executor' });
    const ids = result.archives.map((a) => a.id);

    const realRow = result.archives.find((a) => a.id === '2026-01-01-real-archive-d');
    assert.ok(realRow, 'expected the real archive row to survive the role filter (it has an executor session)');
    assert.deepStrictEqual(Object.keys(realRow.byRole), ['executor'], `expected the real archive row's byRole narrowed to only 'executor'; got ${JSON.stringify(Object.keys(realRow.byRole))}`);

    const ledgerRow = result.archives.find((a) => a.id === ledgerRunId);
    assert.ok(ledgerRow, 'expected the ledger row to survive the role filter (it has an executor session)');
    assert.deepStrictEqual(Object.keys(ledgerRow.byRole), ['executor'], `expected the ledger row's byRole narrowed to only 'executor'; got ${JSON.stringify(Object.keys(ledgerRow.byRole))}`);
    assert.strictEqual(ledgerRow.sessionCount, 1, `expected the ledger row's sessionCount narrowed to the single executor session; got ${ledgerRow.sessionCount}`);

    assert.ok(!ids.includes(staleRunId), `expected the stale row (verifier-only, no executor session) to be dropped by the role filter; got ids: ${JSON.stringify(ids)}`);
  } finally {
    cleanup(root);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
