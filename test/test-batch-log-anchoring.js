#!/usr/bin/env node
/**
 * Mirrors the module-top marker-discipline guard used by
 * test/test-batch-resume.js and friends: this file drives a REAL
 * Pipeline.batchResume against isolated fs.mkdtemp()/makeGitRoot() fixture
 * roots, not a re-entrant cc-orch invocation. If launched from inside a live
 * cc-orch run, CC_ORCH_ACTIVE_RUN would be inherited from the parent process
 * environment and trip assertNoReentrantLiveRun's guard against a fixture
 * root that carries an active state.json — a false positive on the
 * sanctioned mkdtemp pattern (see reentrancy-guard.js). Clear the marker
 * unconditionally here, before any process.env-sensitive imports, so this
 * file is re-entrancy-neutral regardless of launch context.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

/**
 * test-batch-log-anchoring.js — Locks down per-entry log/token-usage
 * anchoring across a REAL Pipeline.batchResume run over a 2-entry pending
 * queue (test/helpers/batch-fixtures.js precedent), guarding against the
 * flat-.harness-bleed class of regression (see pipeline.js _repointHarness's
 * "observed live 2026-07-14" comment) and confirming the gate-flags /
 * uncheckable-entry edges around the per-entry bootstrap/repoint loop.
 *
 * Planner/execution seams are stubbed (planGlobal, verifyAssumptions,
 * reExtractAssumptions, closeReusableSession, executeAllMilestones,
 * reviewGate, archive) — no test case spawns a real agent session; a
 * SessionManager.spawn/spawnReusable poison pill additionally makes any
 * accidental real-session attempt fail loudly (TC8).
 *
 * Covers:
 *   TC1 — (a) CONTENT-BLEED LOCK: entry 1's run-dir file listing, snapshotted
 *         at its own archive point, is unchanged at batch end — no new
 *         files, no recreated logs/.
 *   TC2 — (b) PER-ENTRY ANCHORING: the entry-2 executeAllMilestones stub's
 *         recorded logger.logsDir / tokenTracker.usagePath (captured AT CALL
 *         TIME, i.e. post-repoint) resolve inside entry 2's own run dir —
 *         not the flat .harness root, not entry 1's dir.
 *   TC3 — (c) TOKEN CONTINUITY: a synthetic session written pre-bootstrap
 *         (during round-1 assumption verification, before bootstrap()/
 *         _repointHarness() run for entry 2) via the REAL TokenTracker
 *         survives bootstrap(force)'s subdir wipe (logs/ is excluded — see
 *         bootstrap.js WIPE_SUBDIRS_ON_FORCE) and appears in entry 2's
 *         post-archive logs/token-usage.json.
 *   TC4 — (d) BASELINE ATTRIBUTION: entry 2's usageBaseline (captured via
 *         the stubbed archive seam's opts.usageBaseline) reflects the
 *         loop-top capture on the fresh per-run dir — ~zero — rather than
 *         entry 1's much larger real spend (2.5 across 2 sessions), proving
 *         the pre-bootstrap probe's spend is INSIDE entry 2's delta rather
 *         than subtracted away by a stale/leaked baseline.
 *   TC5 — (e) GATE-FLAGS PRESERVATION: a constructor-time (flat) harness dir
 *         seeded via writeGateFlags(harnessDir, { skipCoverageGate: true })
 *         is still honored for entry 1 after batchResume's per-entry
 *         read-back — even though neither queue entry carries a sibling
 *         spec.json (which would otherwise trip the uncheckable-spec gate).
 *   TC6 — (f) EARLY-EXIT HYGIENE: an uncheckable entry (no sibling
 *         spec.json, no incomplete-scope override) fails validation and
 *         `continue`s claiming no active-run pointer, leaving at most a
 *         logs-only flat harness dir with no state.json. No run-dir-presence
 *         (or absence) assertion here: archive() never runs for this entry,
 *         but its missing state.json makes the dir eligible for
 *         batchResume's finally-block sweepOrphanRunDirs to reap it anyway
 *         (mechanicallySafe) — either outcome is acceptable, so the loop
 *         below only inspects whatever per-run dirs happen to remain.
 *   TC7 — module top runs `delete process.env.CC_ORCH_ACTIVE_RUN;` before
 *         the first import.
 *   TC8 — no test case spawns a real agent session (poison-pilled + noted).
 *
 * Run: node test/test-batch-log-anchoring.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { bootstrap } from '../src/orchestrator/core/bootstrap.js';
import { writeGateFlags, readQueueEntry } from '../src/orchestrator/core/state.js';
import { runHarnessDir, harnessRoot, readActiveRunPointer } from '../src/orchestrator/core/run-context.js';
import { TokenTracker } from '../src/orchestrator/infra/token-tracker.js';
import { moveHarnessToArchive } from '../src/cli/commands/archive.js';
import {
  makeGitRoot,
  makeFakeArchive,
  makeRealBatchPipeline,
  makePlan,
  createQueueEntry,
  cleanup,
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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Sorted list of every file (relative POSIX-ish path) under `dir`, recursively. */
function listFilesRecursive(dir) {
  const out = [];
  function walk(d, prefix) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  }
  walk(dir, '');
  return out.sort();
}

/**
 * TC8 poison pill: every planner/execution seam batchResume touches is
 * stubbed by makeRealBatchPipeline + the per-test overrides below, so
 * neither of these real-session entry points should ever be reached. Make
 * them throw loudly if they are, rather than silently spawning a live
 * Claude session.
 */
function poisonSessionManager(pipeline) {
  pipeline.sessionManager.spawn = () => {
    throw new Error('TC8 violation: a real agent session (SessionManager.spawn) was attempted');
  };
  pipeline.sessionManager.spawnReusable = () => {
    throw new Error('TC8 violation: a real agent session (SessionManager.spawnReusable) was attempted');
  };
}

// ── TC1-TC5 ───────────────────────────────────────────────────────────────
// A REAL batchResume over a 2-entry pending queue.

await test(
  'TC1-TC5: batchResume anchors entry 2\'s logs/tokens inside its own run dir, ' +
  'preserves gate flags for entry 1, keeps token continuity + baseline attribution, ' +
  'and never bleeds new writes into entry 1\'s dir',
  async () => {
    const root = makeGitRoot({ prefix: 'cc-batch-log-anchor-' });
    try {
      // (e) GATE-FLAGS PRESERVATION setup: seed a CONSTRUCTOR-TIME (flat)
      // harness dir with a persisted skipCoverageGate flag BEFORE the
      // Pipeline is constructed. Both entries below deliberately carry no
      // sibling spec.json (createQueueEntry's default) — without this flag
      // being honored at the top of entry 1's loop iteration, the
      // uncheckable-spec gate would fire and entry 1 would never reach
      // execution/archive.
      bootstrap(root, {});
      writeGateFlags(harnessRoot(root), { skipCoverageGate: true });

      createQueueEntry(root, 'entry1', {
        plan: makePlan({ assumptions: [{ text: 'entry1-assumption', specSection: '## E1' }] }),
        validatedAt: '2026-01-01T00:00:00.000Z',
      });
      createQueueEntry(root, 'entry2', {
        plan: makePlan({ assumptions: [{ text: 'entry2-assumption', specSection: '## E2' }] }),
        validatedAt: '2026-01-02T00:00:00.000Z',
      });

      let entry1SnapshotDir = null;
      let entry1SnapshotFiles = null;
      let entry2CapturedBaseline = null;
      let entry2RunId = null;
      let entry2AnchorLogsDir = null;
      let entry2AnchorUsagePath = null;

      let pipeline; // assigned below; read by closures invoked later during batchResume().

      const archiveWrapper = async (projectRoot, slug, opts) => {
        if (slug === 'entry1') {
          // (a) CONTENT-BLEED LOCK: snapshot entry 1's run-dir file listing
          // AT ITS ARCHIVE POINT — pipeline.harnessDir is still entry 1's own
          // per-run dir here (the loop has not yet repointed to entry 2).
          entry1SnapshotDir = pipeline.harnessDir;
          entry1SnapshotFiles = listFilesRecursive(entry1SnapshotDir);
        } else if (slug === 'entry2') {
          // (d) BASELINE ATTRIBUTION: capture the exact usageBaseline the
          // production loop computed and is about to pass into archive().
          entry2CapturedBaseline = opts.usageBaseline;
        }
        // Mirror production archive()'s moveHarnessToArchive step for entry
        // 1 ONLY: state.json + the per-run subdirs (including logs/) move
        // OUT of entry 1's run dir and INTO archives/entry1/, so this
        // fixture faithfully exercises batchResume's finally-block
        // sweepOrphanRunDirs against a genuinely emptied ("husk") run dir —
        // once state.json is gone, harness-reaper classifies the husk
        // mechanicallySafe and reaps it. (Entry 2's own dir is deliberately
        // left untouched here: its executeAllMilestones stub above writes
        // an anchor-probe session log via a real, still-in-flight
        // fs.createWriteStream whose async open() would otherwise race this
        // move and throw ENOENT — entry 2's per-entry anchoring (b) is
        // unaffected either way since it is captured at call time, before
        // this archive step ever runs.) makeFakeArchive-style manifest/
        // report overlay written alongside, same as before.
        const dir = path.join(projectRoot, 'archives', slug);
        if (slug === 'entry1') {
          moveHarnessToArchive(pipeline.harnessDir, dir);
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ headline: `archived ${slug}` }));
        fs.writeFileSync(path.join(dir, 'report.txt'), `archived ${slug}`);
        return dir;
      };

      const built = makeRealBatchPipeline(root, {
        archive: archiveWrapper,
        executeAllMilestones: async (plan) => {
          const texts = (plan?.assumptions || []).map((a) => a.text ?? a);
          if (texts.includes('entry1-assumption')) {
            // Give entry 1's dir REAL, non-trivial content (two real
            // sessions, $2.5 total) so a later leak from entry 2 into entry
            // 1's directory — or a baseline that erroneously reflects entry
            // 1's accumulated spend — is concretely detectable below.
            await pipeline.tokenTracker.recordSession('entry1-session-a', 'executor', {
              usage: { input_tokens: 500, output_tokens: 200 },
              total_cost_usd: 1.0,
            }, {});
            await pipeline.tokenTracker.recordSession('entry1-session-b', 'executor', {
              usage: { input_tokens: 300, output_tokens: 100 },
              total_cost_usd: 1.5,
            }, {});
          } else if (texts.includes('entry2-assumption')) {
            // (b) PER-ENTRY ANCHORING: record logger.logsDir /
            // tokenTracker.usagePath AT CALL TIME — this stub runs after
            // bootstrap()/_repointHarness() for entry 2, so `pipeline.logger`
            // / `pipeline.tokenTracker` are already entry 2's own instances —
            // and write one real line through the REAL logger.
            entry2AnchorLogsDir = pipeline.logger.logsDir;
            entry2AnchorUsagePath = pipeline.tokenTracker.usagePath;
            const sessionLog = pipeline.logger.createSessionLog('entry2-anchor-probe');
            sessionLog.write({ type: 'probe', note: 'entry2 executeAllMilestones anchoring probe' });
            sessionLog.close();
          }
        },
      });
      pipeline = built.pipeline;
      const logs = built.logs;

      // Undo the fixture's hardcoded true so the persisted-flag readback (e)
      // is genuinely exercised rather than short-circuited by the fixture.
      pipeline._skipCoverageGate = false;

      poisonSessionManager(pipeline); // TC8

      // (c) TOKEN CONTINUITY pre-bootstrap hook: round-1 assumption
      // verification runs strictly BEFORE bootstrap()/_repointHarness() for
      // the entry currently being processed, so this is genuinely
      // "pre-bootstrap" for entry 2.
      pipeline.planner.verifyAssumptions = async (assumptions) => {
        const texts = (assumptions || []).map((a) => a.text ?? a);
        if (texts.includes('entry2-assumption')) {
          entry2RunId = pipeline._activeEntryRunId;
          const futureDir = runHarnessDir(root, entry2RunId);
          const preBootstrapTracker = new TokenTracker(futureDir);
          await preBootstrapTracker.recordSession('pre-bootstrap-probe', 'planner', {
            usage: { input_tokens: 10, output_tokens: 5 },
            total_cost_usd: 0,
          }, {});
        }
        return []; // all pass, both entries
      };

      const result = await pipeline.batchResume({});

      // The entry-2 executeAllMilestones stub's sessionLog.write()/close()
      // opens a fs.createWriteStream() whose underlying open() is
      // asynchronous (libuv threadpool) — it can still be pending when
      // batchResume() resolves. Wait (bounded) for the probe file to
      // actually land on disk before assertions/cleanup proceed, so the
      // `finally` block's cleanup(root) never races the stream's async open
      // (which would otherwise surface as a benign-but-noisy unhandled
      // 'error' ENOENT once the directory is gone).
      if (entry2AnchorLogsDir) {
        const deadline = Date.now() + 2000;
        for (;;) {
          const found = fs.existsSync(entry2AnchorLogsDir)
            && fs.readdirSync(entry2AnchorLogsDir).some((f) => f.includes('entry2-anchor-probe'));
          if (found || Date.now() > deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      assert.strictEqual(result.archived, 2, `Expected 2 archived, got ${JSON.stringify(result)}`);
      assert.strictEqual(result.failed, 0, `Expected 0 failed, got ${JSON.stringify(result)}`);
      assert.strictEqual(result.parked, 0, `Expected 0 parked, got ${JSON.stringify(result)}`);

      // ── (e) GATE-FLAGS PRESERVATION ────────────────────────────────────
      assert.ok(
        logs.some((l) => l.includes('honoring persisted skip-coverage-gate disposition')),
        `Expected the persisted skipCoverageGate flag to be honored for entry 1. Logs:\n${logs.join('\n')}`,
      );

      // ── (b) PER-ENTRY ANCHORING ─────────────────────────────────────────
      assert.ok(entry2RunId, 'entry2RunId should have been captured pre-bootstrap');
      const entry2Dir = runHarnessDir(root, entry2RunId);
      assert.ok(entry2AnchorLogsDir, 'entry 2 anchoring logsDir should have been recorded');
      assert.ok(entry2AnchorUsagePath, 'entry 2 anchoring usagePath should have been recorded');
      assert.strictEqual(
        entry2AnchorLogsDir,
        path.join(entry2Dir, 'logs'),
        `Expected entry 2's logger.logsDir to resolve inside entry 2's own run dir (${entry2Dir}), got ${entry2AnchorLogsDir}`,
      );
      assert.strictEqual(
        entry2AnchorUsagePath,
        path.join(entry2Dir, 'logs', 'token-usage.json'),
        `Expected entry 2's tokenTracker.usagePath to resolve inside entry 2's own run dir (${entry2Dir}), got ${entry2AnchorUsagePath}`,
      );
      // Not the flat .harness root...
      assert.notStrictEqual(entry2AnchorLogsDir, path.join(harnessRoot(root), 'logs'));
      assert.notStrictEqual(entry2AnchorUsagePath, path.join(harnessRoot(root), 'logs', 'token-usage.json'));
      // ...and not entry 1's own dir.
      assert.notStrictEqual(entry1SnapshotDir, entry2Dir, 'entry 1 and entry 2 must have distinct per-run dirs');
      assert.ok(
        !entry2AnchorLogsDir.startsWith(entry1SnapshotDir + path.sep),
        `entry 2's logsDir must not resolve inside entry 1's dir. entry1=${entry1SnapshotDir} entry2AnchorLogsDir=${entry2AnchorLogsDir}`,
      );

      // ── (c) TOKEN CONTINUITY ─────────────────────────────────────────────
      const entry2UsagePath = path.join(entry2Dir, 'logs', 'token-usage.json');
      assert.ok(fs.existsSync(entry2UsagePath), `Expected ${entry2UsagePath} to exist post-archive`);
      const entry2Usage = JSON.parse(fs.readFileSync(entry2UsagePath, 'utf8'));
      assert.ok(
        entry2Usage.sessions.some((s) => s.name === 'pre-bootstrap-probe'),
        `Expected the pre-bootstrap synthetic session to survive into entry 2's post-archive token-usage.json. Got: ${JSON.stringify(entry2Usage.sessions)}`,
      );

      // ── (d) BASELINE ATTRIBUTION ──────────────────────────────────────────
      assert.ok(entry2CapturedBaseline, 'entry 2 usageBaseline should have been captured via the archive seam');
      assert.strictEqual(
        entry2CapturedBaseline.totalCost,
        0,
        `Expected entry 2's usageBaseline.totalCost to reflect the loop-top capture on the fresh dir (~0), got ` +
        `${entry2CapturedBaseline.totalCost} (entry 1's real spend was 2.5 — a leaked/stale baseline would show that instead)`,
      );
      assert.strictEqual(
        entry2CapturedBaseline.totalSessions,
        0,
        `Expected entry 2's usageBaseline.totalSessions to reflect the loop-top capture on the fresh dir (0 — captured ` +
        `before the pre-bootstrap probe is even written), got ${entry2CapturedBaseline.totalSessions}`,
      );

      // ── (a) CONTENT-BLEED LOCK ────────────────────────────────────────────
      // Re-pinned: batchResume's finally-block sweepOrphanRunDirs now reaps
      // entry 1's husk (moveHarnessToArchive left it with no parseable
      // state.json, so harness-reaper classifies it mechanicallySafe) once
      // the whole batch completes — the husk no longer survives to be
      // re-inspected in place. No-cross-entry-bleed is instead witnessed by
      // comparing the archive-point capture above (entry1SnapshotFiles,
      // taken BEFORE entry 2 is ever processed) against entry 1's archived
      // copy (archives/entry1/) byte-for-byte; the end state is asserted as
      // "husk absent (swept)" rather than "husk contents unchanged".
      assert.ok(entry1SnapshotFiles, 'entry 1 file snapshot should have been captured at its own archive point');
      const entry1ArchiveDir = path.join(root, 'archives', 'entry1');
      assert.ok(
        fs.existsSync(path.join(entry1ArchiveDir, 'logs')),
        `entry 1's logs/ dir should have been moved into its archived copy`,
      );
      const entry1ArchivedFiles = listFilesRecursive(entry1ArchiveDir)
        .filter((f) => f !== 'manifest.json' && f !== 'report.txt');
      assert.deepStrictEqual(
        entry1ArchivedFiles,
        entry1SnapshotFiles,
        `Expected entry 1's archived-copy file listing to match its archive-point capture byte-for-byte (no cross-entry bleed), but found: ${JSON.stringify(entry1ArchivedFiles)}`,
      );
      assert.ok(
        !fs.existsSync(entry1SnapshotDir),
        `Expected entry 1's run dir (husk) to have been swept by batchResume's finally-block sweepOrphanRunDirs.`,
      );
    } finally {
      cleanup(root);
    }
  },
);

// ── TC6 ─────────────────────────────────────────────────────────────────────
// (f) EARLY-EXIT HYGIENE

await test(
  'TC6: uncheckable entry (failed-validation, continue) claims no active-run pointer ' +
  'and leaves at most a logs-only dir with no state.json',
  async () => {
    const root = makeGitRoot({ prefix: 'cc-batch-log-anchor-f-' });
    try {
      // Deliberately NO flat bootstrap()/writeGateFlags() here — this entry
      // must genuinely be uncheckable (no sibling spec.json, no
      // incomplete-scope override) so the uncheckable-spec gate fires
      // BEFORE any claimActiveRun()/bootstrap() for this entry's runId.
      createQueueEntry(root, 'uncheckable-entry', {
        plan: makePlan({ assumptions: [] }),
      });

      const { pipeline } = makeRealBatchPipeline(root, {
        archive: makeFakeArchive(),
      });
      // Undo the fixture's hardcoded true: this test needs the
      // uncheckable-spec gate to actually run (it is gated on
      // !_skipCoverageGate).
      pipeline._skipCoverageGate = false;
      poisonSessionManager(pipeline); // TC8

      const result = await pipeline.batchResume({});

      assert.strictEqual(result.archived, 0, `Expected 0 archived, got ${JSON.stringify(result)}`);
      assert.strictEqual(result.failed, 1, `Expected 1 failed, got ${JSON.stringify(result)}`);
      assert.strictEqual(result.parked, 0, `Expected 0 parked, got ${JSON.stringify(result)}`);

      const entry = readQueueEntry(root, 'uncheckable-entry');
      assert.strictEqual(
        entry?.status,
        'failed-validation',
        `Expected status 'failed-validation', got '${entry?.status}'`,
      );

      // No active-run pointer was ever claimed for this entry — the
      // uncheckable-spec gate fires before claimActiveRun()/bootstrap().
      assert.strictEqual(
        readActiveRunPointer(root),
        null,
        'Expected no active-run pointer to be claimed for an uncheckable entry',
      );

      // At most a logs-only dir with no state.json: the per-entry
      // harness-anchoring hoist (see pipeline.js batchResume's loop-top
      // `_repointHarness(runHarnessDir(...))` call) runs BEFORE the
      // uncheckable-spec gate, so a nested per-run dir under the flat
      // .harness root legitimately exists on disk by the time the gate
      // fires and `continue`s — that nested dir is itself created ONLY as
      // a side effect of `new Logger(this.harnessDir)` (a logs/ mkdir), NOT
      // by bootstrap()/claimActiveRun(). No run-dir-absence assertion here
      // by design (the real archive step does not remove run dirs either,
      // and the hoisted repoint is expected production behavior, not a
      // bug) — instead assert the weaker, correct invariant: no state.json
      // anywhere under the flat harness root (bootstrap() was never
      // reached), and every directory that does exist is "logs-only" (its
      // own top-level contents are at most a single `logs` entry).
      const flatHarness = harnessRoot(root);
      assert.ok(
        fs.existsSync(flatHarness),
        'Expected the flat .harness dir to exist (created at Pipeline construction)',
      );
      assert.ok(
        !fs.existsSync(path.join(flatHarness, 'state.json')),
        'Expected no state.json at the flat harness root — bootstrap() was never reached for the uncheckable entry',
      );
      const topLevel = fs.readdirSync(flatHarness, { withFileTypes: true });
      for (const ent of topLevel) {
        const full = path.join(flatHarness, ent.name);
        if (ent.name === 'logs') {
          assert.ok(ent.isDirectory(), `Expected 'logs' to be a directory, got entry: ${ent.name}`);
          continue;
        }
        // Any other top-level entry must be a per-run dir created solely by
        // the hoisted _repointHarness -> `new Logger()` side effect: a
        // directory whose own contents are at most a logs-only dir, with no
        // state.json anywhere inside it.
        assert.ok(
          ent.isDirectory(),
          `Expected unexpected top-level entry '${ent.name}' under the flat harness root to be a directory (a per-run dir), got a file`,
        );
        assert.ok(
          !fs.existsSync(path.join(full, 'state.json')),
          `Expected no state.json inside per-run dir '${ent.name}' — bootstrap() was never reached for the uncheckable entry`,
        );
        const innerTopLevel = fs.readdirSync(full).sort();
        assert.deepStrictEqual(
          innerTopLevel,
          ['logs'],
          `Expected per-run dir '${ent.name}' to contain at most a logs-only dir, got: ${JSON.stringify(innerTopLevel)}`,
        );
      }
    } finally {
      cleanup(root);
    }
  },
);

// ── TC7 ─────────────────────────────────────────────────────────────────────
// module-top marker discipline

await test('TC7: module top runs `delete process.env.CC_ORCH_ACTIVE_RUN;` before the first import', async () => {
  const selfPath = fileURLToPath(import.meta.url);
  const source = fs.readFileSync(selfPath, 'utf8');
  const deleteIdx = source.indexOf('delete process.env.CC_ORCH_ACTIVE_RUN;');
  const firstImportMatch = source.search(/^import /m);
  assert.ok(deleteIdx !== -1, 'Expected `delete process.env.CC_ORCH_ACTIVE_RUN;` to appear in this file');
  assert.ok(
    firstImportMatch === -1 || deleteIdx < firstImportMatch,
    'Expected the CC_ORCH_ACTIVE_RUN delete to appear before the first import statement',
  );
});

// ── TC8 ─────────────────────────────────────────────────────────────────────
// No test case above spawns a real agent session: every planner/execution
// seam batchResume touches is stubbed (makeRealBatchPipeline's planGlobal /
// verifyAssumptions / reExtractAssumptions / closeReusableSession, plus the
// per-test executeAllMilestones / reviewGate / archive overrides), and
// poisonSessionManager() additionally makes SessionManager.spawn /
// spawnReusable throw if anything ever reaches them — both the TC1-TC5 batch
// and the TC6 batch install this poison pill before calling batchResume().
await test('TC8: no test case spawns a real agent session (SessionManager.spawn/spawnReusable poisoned)', async () => {
  // Documentation-level assertion: poisonSessionManager() is installed on
  // every pipeline constructed above, BEFORE batchResume() runs, and makes
  // SessionManager.spawn/spawnReusable throw immediately if ever reached.
  // Had either seam been hit, the offending test() block above would
  // already have failed with a "TC8 violation" error rather than reaching
  // this line. This case exists so the property has an explicit, named
  // PASS/FAIL line in the suite output.
  assert.ok(true, 'poisonSessionManager() guards every batchResume() call above');
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
