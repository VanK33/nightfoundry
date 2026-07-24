#!/usr/bin/env node

/**
 * Unit test: dryRunValidate behavior.
 *
 * Tests:
 *   TC1 — dryRunValidate creates queue/{slug}/ with all expected files
 *   TC2 — dryRunValidate does not call planMission or writeGlobalPlan
 *   TC3 — dryRunValidate stops after verifyAssumptions when user rejects
 *   TC4 — CLI dry-run routes to dryRunValidate
 *   TC5 — state.projectMeta.prdPath is absolute and equals queue copy path after dryRunValidate
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This suite's fixtures bootstrap a fresh .harness/ root inside an isolated
// fs.mkdtemp fixture dir for every test, not the live run's project root.
// But if the suite is launched from inside a live cc-orch run (e.g. via a
// spawned test gate), CC_ORCH_ACTIVE_RUN is inherited from the parent
// process and would trip assertNoReentrantLiveRun's active-root bootstrap
// checks inside bootstrap()/dryRunValidate(). Clear the marker so this suite
// runs re-entrancy-neutral regardless of launch context.
delete process.env.CC_ORCH_ACTIVE_RUN;

async function main() {
  let passed = 0;
  let failed = 0;

  function assert(label, condition) {
    if (condition) {
      console.log(`  [PASS] ${label}`);
      passed++;
    } else {
      console.log(`  [FAIL] ${label}`);
      failed++;
    }
  }

  console.log('=== Dry-Run Tests ===\n');

  // ─────────────────────────────────────────────────────────────
  // Imports
  // ─────────────────────────────────────────────────────────────

  const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');
  const { bootstrap } = await import('../src/orchestrator/core/bootstrap.js');
  const { activeHarnessDir } = await import('../src/orchestrator/core/run-context.js');
  const { readQueueEntry } = await import('../src/orchestrator/core/state.js');

  // ─────────────────────────────────────────────────────────────
  // Fixture data
  // ─────────────────────────────────────────────────────────────

  const cannedGlobalPlan = {
    milestones: [
      {
        id: '001',
        description: 'Core infrastructure setup',
        missions: [
          { id: '001-001', description: 'Initialize database layer' },
          { id: '001-002', description: 'Set up API routing' },
        ],
      },
      {
        id: '002',
        description: 'Feature implementation',
        missions: [
          { id: '002-001', description: 'Build user authentication' },
        ],
      },
    ],
  };

  const cannedGlobalPlanWithAssumptions = {
    ...cannedGlobalPlan,
    assumptions: [
      { text: 'Node.js >= 18 is installed', specSection: 'Requirements' },
    ],
  };

  // ─────────────────────────────────────────────────────────────
  // Helper: build a temp project dir with initialized harness
  // and a mocked Pipeline ready for dryRunValidate
  // ─────────────────────────────────────────────────────────────

  function makeDryRunValidatePipeline(opts = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-dry-validate-'));
    fs.mkdirSync(tmpDir, { recursive: true });

    // Bootstrap so dryRunValidate skips the bootstrap branch
    bootstrap(tmpDir, {});

    // Write a fake spec file
    const specPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specPath, '# Test Spec\n\nBuild something.');

    // Sibling spec.json fixture — the uncheckable-spec gate fails closed on a
    // bare .md, so the .md spec fixture needs a parseable sibling json.
    fs.writeFileSync(
      path.join(tmpDir, 'spec.json'),
      JSON.stringify({
        goal: 'Build something.',
        target_files: ['src/foo.js'],
        acceptance_criteria: [{ description: 'it works', verification: { kind: 'manual' } }],
      }),
    );

    const logs = [];
    const pipeline = new Pipeline(tmpDir, {
      onLog: (msg) => logs.push(msg),
      onConfirm: opts.onConfirm ?? (async () => true),
    });

    // No-op preflight so we don't need a full harness config
    pipeline._runPreflight = () => {};

    // Track calls
    let planMissionCallCount = 0;
    let planGlobalCallCount = 0;
    let verifyAssumptionsCallCount = 0;

    // Mock planner methods
    pipeline.planner.planGlobal = async () => {
      planGlobalCallCount++;
      return JSON.parse(JSON.stringify(opts.globalPlan || cannedGlobalPlan));
    };

    pipeline.planner.planMission = async (miId) => {
      planMissionCallCount++;
      throw new Error(`planMission should never be called in dryRunValidate (called with: ${miId})`);
    };

    pipeline.planner.verifyAssumptions = async () => {
      verifyAssumptionsCallCount++;
      return opts.assumptionResults || [];
    };

    pipeline.planner.closeReusableSession = async () => {};

    return {
      tmpDir,
      specPath,
      pipeline,
      logs,
      getPlanMissionCallCount: () => planMissionCallCount,
      getPlanGlobalCallCount: () => planGlobalCallCount,
      getVerifyAssumptionsCallCount: () => verifyAssumptionsCallCount,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // TC1: dryRunValidate creates queue/{slug}/ with all expected files
  // ─────────────────────────────────────────────────────────────

  console.log('TC1: dryRunValidate creates queue/{slug}/ with all expected files\n');

  {
    const { tmpDir, specPath, pipeline } = makeDryRunValidatePipeline();

    try {
      await pipeline.dryRunValidate('Build a sample app', { prdPath: specPath });
    } catch (err) {
      console.log(`  [FAIL] Unexpected error during dryRunValidate: ${err.message}`);
      console.log(err.stack);
      failed++;
    }

    // Slug is derived from spec filename without extension: 'spec.md' → 'spec'
    const slug = 'spec';
    const queueDir = path.join(tmpDir, 'queue', slug);

    assert('TC1a: queue/{slug}/ directory exists', fs.existsSync(queueDir));

    if (fs.existsSync(queueDir)) {
      const specFile = path.join(queueDir, 'spec.md');
      const planFile = path.join(queueDir, 'plan.json');
      const validatedAtFile = path.join(queueDir, 'validated-at.json');
      const statusFile = path.join(queueDir, 'status');

      assert('TC1b: queue/{slug}/spec.md exists', fs.existsSync(specFile));
      assert('TC1c: queue/{slug}/plan.json exists', fs.existsSync(planFile));
      assert('TC1d: queue/{slug}/validated-at.json exists', fs.existsSync(validatedAtFile));
      assert('TC1e: queue/{slug}/status exists', fs.existsSync(statusFile));

      if (fs.existsSync(specFile)) {
        const specContent = fs.readFileSync(specFile, 'utf8');
        assert('TC1f: spec.md contains spec content', specContent.includes('Build something'));
      }

      if (fs.existsSync(planFile)) {
        let plan;
        try {
          plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
        } catch {
          assert('TC1g: plan.json is valid JSON', false);
          plan = null;
        }
        if (plan) {
          assert('TC1g: plan.json is valid JSON with milestones', Array.isArray(plan.milestones));
          assert('TC1h: plan.json milestones count matches', plan.milestones.length === 2);
        }
      }

      if (fs.existsSync(validatedAtFile)) {
        let validatedAt;
        try {
          validatedAt = JSON.parse(fs.readFileSync(validatedAtFile, 'utf8'));
        } catch {
          assert('TC1i: validated-at.json is valid JSON', false);
          validatedAt = null;
        }
        if (validatedAt !== null) {
          // validatedAt is now a flat ISO string; assumption results live in
          // assumption-results.json.
          assert('TC1i: validated-at.json is an ISO string', typeof validatedAt === 'string' && validatedAt.length > 0);
        }
      }

      if (fs.existsSync(statusFile)) {
        const status = fs.readFileSync(statusFile, 'utf8');
        assert("TC1j: status file contains 'pending'", status === 'pending');
      }
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ─────────────────────────────────────────────────────────────
  // TC2: dryRunValidate does not call planMission or writeGlobalPlan
  // ─────────────────────────────────────────────────────────────

  console.log('\nTC2: dryRunValidate does not call planMission or writeGlobalPlan\n');

  {
    const { tmpDir, specPath, pipeline, getPlanMissionCallCount, getPlanGlobalCallCount } =
      makeDryRunValidatePipeline();

    try {
      await pipeline.dryRunValidate('Build a sample app', { prdPath: specPath });
    } catch (err) {
      console.log(`  [FAIL] Unexpected error during dryRunValidate: ${err.message}`);
      console.log(err.stack);
      failed++;
    }

    assert('TC2a: planGlobal was called exactly once', getPlanGlobalCallCount() === 1);
    assert('TC2b: planMission was never called', getPlanMissionCallCount() === 0);

    // writeGlobalPlan writes global-plan.json under the resolved per-run
    // harness dir — verify it does NOT exist there (not a hardcoded flat
    // .harness path, which would miss a run repointed into a per-run dir).
    const globalPlanPath = path.join(activeHarnessDir(tmpDir), 'global-plan.json');
    assert('TC2c: global-plan.json was NOT written', !fs.existsSync(globalPlanPath));

    // Confirm queue entry WAS written (approval was accepted)
    const queueDir = path.join(tmpDir, 'queue', 'spec');
    assert('TC2d: queue entry was still created (side-effect check)', fs.existsSync(queueDir));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ─────────────────────────────────────────────────────────────
  // TC3: dryRunValidate stops after verifyAssumptions when user rejects
  // ─────────────────────────────────────────────────────────────

  console.log('\nTC3: dryRunValidate stops after verifyAssumptions when user rejects\n');

  {
    // Plan has uncertain assumptions; onConfirm returns false → pipeline stops
    const { tmpDir, specPath, pipeline, getVerifyAssumptionsCallCount, getPlanMissionCallCount } =
      makeDryRunValidatePipeline({
        globalPlan: cannedGlobalPlanWithAssumptions,
        assumptionResults: [
          { assumption: { text: 'Node.js >= 18 is installed', specSection: 'Requirements' }, status: 'uncertain', evidence: 'Could not determine version' },
        ],
        onConfirm: async () => false,
      });

    try {
      await pipeline.dryRunValidate('Build a sample app', { prdPath: specPath });
    } catch (err) {
      console.log(`  [FAIL] Unexpected error during dryRunValidate: ${err.message}`);
      console.log(err.stack);
      failed++;
    }

    assert('TC3a: verifyAssumptions was called', getVerifyAssumptionsCallCount() === 1);
    assert('TC3b: planMission was never called', getPlanMissionCallCount() === 0);

    // No queue entry should be created since user rejected
    const queueDir = path.join(tmpDir, 'queue', 'spec');
    assert('TC3c: queue/{slug}/ was NOT created (pipeline stopped early)', !fs.existsSync(queueDir));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ─────────────────────────────────────────────────────────────
  // TC4: CLI dry-run routes to dryRunValidate
  // ─────────────────────────────────────────────────────────────

  console.log('\nTC4: CLI dry-run routes to dryRunValidate\n');

  {
    const cliPath = path.resolve(__dirname, '../src/cli/index.js');
    const dryRunPath = path.resolve(__dirname, '../src/cli/commands/dry-run.js');

    const cliSource = fs.readFileSync(cliPath, 'utf8');
    const dryRunSource = fs.readFileSync(dryRunPath, 'utf8');

    assert(
      "TC4a: CLI index.js contains \"case 'dry-run'\" routing entry",
      cliSource.includes("case 'dry-run'")
    );

    assert(
      "TC4b: CLI index.js imports dryRun from commands/dry-run.js",
      cliSource.includes("from './commands/dry-run.js'") || cliSource.includes('dryRun')
    );

    assert(
      "TC4c: dry-run.js exports dryRun function",
      dryRunSource.includes('export async function dryRun') ||
        dryRunSource.includes('export function dryRun')
    );

    assert(
      "TC4d: dry-run.js calls pipeline.dryRunValidate (not pipeline.run)",
      dryRunSource.includes('dryRunValidate') && !dryRunSource.includes('pipeline.run(')
    );

    assert(
      "TC4e: CLI index.js routes dry-run to dryRun handler",
      cliSource.includes("return dryRun(projectRoot") ||
        cliSource.includes('dryRun(projectRoot')
    );
  }

  // ─────────────────────────────────────────────────────────────
  // TC5: state.projectMeta.prdPath is an absolute path pointing to
  //      the queue copy after dryRunValidate
  // ─────────────────────────────────────────────────────────────

  console.log('\nTC5: state.projectMeta.prdPath is absolute and points to queue copy after dryRunValidate\n');

  {
    const { tmpDir, specPath, pipeline } = makeDryRunValidatePipeline();

    // The scratch run dir self-cleans on success, so state.projectMeta.prdPath
    // is unobservable AFTER dryRunValidate returns. The queue-copy re-anchor
    // (§6c) is a direct state.json write followed immediately by the scratch
    // self-clean (§6d) — so the exact moment of deletion is the last
    // observable point. Intercept fs.rmSync to capture the final persisted
    // prdPath just before the scratch dir is removed; the invariant TC5 has
    // always pinned: it must point at the QUEUE COPY, not the caller-supplied
    // original spec path.
    let capturedFinalPrdPath = null;
    const origRmSync = fs.rmSync;
    fs.rmSync = (target, opts) => {
      try {
        const stateP = path.join(String(target), 'state.json');
        if (fs.existsSync(stateP)) {
          const st = JSON.parse(fs.readFileSync(stateP, 'utf8'));
          if (st?.projectMeta?.prdPath !== undefined) {
            capturedFinalPrdPath = st.projectMeta.prdPath;
          }
        }
      } catch { /* capture is best-effort; never break the real cleanup */ }
      return origRmSync(target, opts);
    };

    try {
      await pipeline.dryRunValidate('Build a sample app', { prdPath: specPath });
    } catch (err) {
      console.log(`  [FAIL] Unexpected error during dryRunValidate: ${err.message}`);
      console.log(err.stack);
      failed++;
    } finally {
      fs.rmSync = origRmSync;
    }

    // dryRunValidate self-cleans its per-run scratch harness dir on success
    // (task 001-001-002-002), so no state.json persists at any flat or
    // per-run path — activeHarnessDir(tmpDir) falls back to the flat
    // harnessRoot, which never receives a state.json write. Assert against
    // the durable persisted queue entry instead, mirroring the sibling
    // CT5 fix in test-verifier-callsite-plumbing.js.
    const queueDir = path.join(tmpDir, 'queue');
    let slugs = [];
    try {
      slugs = fs.readdirSync(queueDir).filter((s) => {
        try {
          return fs.statSync(path.join(queueDir, s)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch (err) {
      console.log(`  [FAIL] Could not read queue dir: ${err.message}`);
      failed++;
    }

    assert(
      `TC5-setup: exactly one queue entry subdirectory under "${queueDir}"`,
      slugs.length === 1
    );

    if (slugs.length === 1) {
      const slug = slugs[0];
      const queueSpecPath = path.join(queueDir, slug, 'spec.md');
      assert('TC5-setup: queue/{slug}/spec.md exists', fs.existsSync(queueSpecPath));

      const entry = readQueueEntry(tmpDir, slug);
      assert('TC5-setup: readQueueEntry returns a persisted entry', !!entry);

      assert(
        'TC5a: the final persisted state.projectMeta.prdPath was captured at scratch cleanup and is an absolute path',
        typeof capturedFinalPrdPath === 'string' && path.isAbsolute(capturedFinalPrdPath)
      );
      assert(
        `TC5b: the final persisted prdPath points at the QUEUE COPY (got "${capturedFinalPrdPath}")`,
        capturedFinalPrdPath === queueSpecPath
      );
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
