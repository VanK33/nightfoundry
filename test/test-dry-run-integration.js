#!/usr/bin/env node
/**
 * test-dry-run-integration.js — Integration tests for dryRunValidate behavior.
 *
 * Run: node test/test-dry-run-integration.js
 *
 * Covers:
 *   TC1 — dryRunValidate creates queue/{slug}/ with all expected files
 *   TC2 — dryRunValidate does not call planMission or writeGlobalPlan
 *   TC3 — uncertain assumptions are advisory (recorded, not gated); the
 *         stop comes from the SECOND gate — the approval gate the user rejects
 *   TC4 — CLI dry-run routes to dryRunValidate
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { readLedger } from '../src/orchestrator/core/warnings-ledger.js';

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
    failCount++;
  }
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');
const { bootstrap } = await import('../src/orchestrator/core/bootstrap.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: create a temp dir and a mocked Pipeline ready for dryRunValidate
// ---------------------------------------------------------------------------

function makeDryRunValidatePipeline(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-dry-validate-int-'));
  fs.mkdirSync(tmpDir, { recursive: true });

  // Bootstrap so dryRunValidate skips the bootstrap branch
  bootstrap(tmpDir, {});

  // Write a fake spec file
  const specPath = path.join(tmpDir, 'spec.md');
  fs.writeFileSync(specPath, '# Test Spec\n\nBuild something awesome.');

  // Sibling spec.json fixture — the uncheckable-spec gate fails closed on a
  // bare .md, so the .md spec fixture needs a parseable sibling json.
  fs.writeFileSync(
    path.join(tmpDir, 'spec.json'),
    JSON.stringify({
      goal: 'Build something awesome.',
      target_files: ['src/foo.js'],
      acceptance_criteria: [{ description: 'it works', verification: { kind: 'manual' } }],
    }),
  );

  const logs = [];
  const pipeline = new Pipeline(tmpDir, {
    onLog: (msg) => logs.push(msg),
    onConfirm: opts.onConfirm ?? (async () => true),
  });

  // No-op preflight so we don't need a full harness config on disk
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
    throw new Error(`planMission must never be called in dryRunValidate (called with: ${miId})`);
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

// ---------------------------------------------------------------------------
// TC1 — dryRunValidate creates queue/{slug}/ with all expected files
// ---------------------------------------------------------------------------

await test('TC1: dryRunValidate creates queue/{slug}/ with all expected files', async () => {
  const { tmpDir, specPath, pipeline } = makeDryRunValidatePipeline();

  try {
    await pipeline.dryRunValidate('Build a sample app', { prdPath: specPath });
  } finally {
    // assertions run regardless
  }

  // Slug derived from 'spec.md' → 'spec'
  const slug = 'spec';
  const queueDir = path.join(tmpDir, 'queue', slug);

  assert.ok(
    fs.existsSync(queueDir),
    `Expected queue/${slug}/ to exist at ${queueDir}`
  );

  const files = ['spec.md', 'plan.json', 'validated-at.json', 'status'];
  for (const f of files) {
    assert.ok(
      fs.existsSync(path.join(queueDir, f)),
      `Expected queue/${slug}/${f} to exist`
    );
  }

  // spec.md — contains spec content
  const specContent = fs.readFileSync(path.join(queueDir, 'spec.md'), 'utf8');
  assert.ok(
    specContent.includes('Build something'),
    `Expected spec.md to include spec content, got: ${specContent.slice(0, 100)}`
  );

  // plan.json — valid JSON with milestones array
  const plan = JSON.parse(fs.readFileSync(path.join(queueDir, 'plan.json'), 'utf8'));
  assert.ok(
    Array.isArray(plan.milestones),
    'Expected plan.json to have a milestones array'
  );
  assert.strictEqual(
    plan.milestones.length,
    2,
    `Expected 2 milestones in plan.json, got ${plan.milestones.length}`
  );

  // validated-at.json — flat ISO string after the migration that decoupled
  // assumptionResults into a sibling file.
  const validatedAt = JSON.parse(fs.readFileSync(path.join(queueDir, 'validated-at.json'), 'utf8'));
  assert.ok(
    typeof validatedAt === 'string' && validatedAt.length > 0,
    `Expected validated-at.json to be a non-empty ISO string, got: ${JSON.stringify(validatedAt)}`
  );

  // status — contains 'pending'
  const status = fs.readFileSync(path.join(queueDir, 'status'), 'utf8');
  assert.strictEqual(
    status,
    'pending',
    `Expected status file to contain 'pending', got: ${status}`
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// TC2 — dryRunValidate does not call planMission or writeGlobalPlan
// ---------------------------------------------------------------------------

await test('TC2: dryRunValidate does not call planMission or writeGlobalPlan', async () => {
  const {
    tmpDir,
    specPath,
    pipeline,
    getPlanMissionCallCount,
    getPlanGlobalCallCount,
  } = makeDryRunValidatePipeline();

  await pipeline.dryRunValidate('Build a sample app', { prdPath: specPath });

  // planGlobal must be called exactly once
  assert.strictEqual(
    getPlanGlobalCallCount(),
    1,
    `Expected planGlobal to be called once, got ${getPlanGlobalCallCount()}`
  );

  // planMission must never be called
  assert.strictEqual(
    getPlanMissionCallCount(),
    0,
    `Expected planMission to never be called, got ${getPlanMissionCallCount()}`
  );

  // writeGlobalPlan writes .harness/global-plan.json — must NOT exist
  const globalPlanPath = path.join(tmpDir, '.harness', 'global-plan.json');
  assert.ok(
    !fs.existsSync(globalPlanPath),
    `Expected .harness/global-plan.json NOT to exist (writeGlobalPlan was called unexpectedly)`
  );

  // Queue entry IS written (approval was accepted — confirming correct flow)
  const queueDir = path.join(tmpDir, 'queue', 'spec');
  assert.ok(
    fs.existsSync(queueDir),
    'Expected queue/spec/ to be created when approval is given'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// TC3 — uncertain is advisory (recorded, not gated); the stop comes from the
//       approval gate the user rejects
//
// Under the advisory-no-park contract a genuine `uncertain` verdict no longer
// gates: _remediateAssumptions records it to archives/warnings.jsonl and
// returns passed:true, so dryRunValidate proceeds to the SECOND gate — the
// queue-spec approval gate — which onConfirm:false rejects ("Plan rejected"),
// so no queue entry is written. The uncertain assumption is still observable,
// now as a ledger entry rather than a halt.
// ---------------------------------------------------------------------------

await test('TC3: uncertain assumption is advisory (recorded to the warnings ledger, not gated); the rejection at the approval gate is what stops the run', async () => {
  // Plan with an uncertain assumption; onConfirm always false → the uncertain
  // is recorded and continues, then the approval gate rejects.
  const UNCERTAIN_TEXT = 'Node.js >= 18 is installed';
  const UNCERTAIN_SECTION = 'Requirements';
  const {
    tmpDir,
    specPath,
    pipeline,
    getVerifyAssumptionsCallCount,
    getPlanMissionCallCount,
  } = makeDryRunValidatePipeline({
    globalPlan: cannedGlobalPlanWithAssumptions,
    assumptionResults: [
      {
        assumption: { text: UNCERTAIN_TEXT, specSection: UNCERTAIN_SECTION },
        status: 'uncertain',
        evidence: 'Could not determine installed version',
      },
    ],
    onConfirm: async () => false,
  });

  await pipeline.dryRunValidate('Build a sample app', { prdPath: specPath });

  // verifyAssumptions must have been called (plan has assumptions)
  assert.strictEqual(
    getVerifyAssumptionsCallCount(),
    1,
    `Expected verifyAssumptions to be called once, got ${getVerifyAssumptionsCallCount()}`
  );

  // planMission must never be called
  assert.strictEqual(
    getPlanMissionCallCount(),
    0,
    `Expected planMission to never be called, got ${getPlanMissionCallCount()}`
  );

  // No queue entry created — the approval gate (not the uncertain) rejected.
  const queueDir = path.join(tmpDir, 'queue', 'spec');
  assert.ok(
    !fs.existsSync(queueDir),
    `Expected queue/spec/ NOT to exist (the approval gate rejected the plan), but it was found at ${queueDir}`
  );

  // The uncertain was RECORDED to the warnings ledger (advisory, not gated):
  // archives/warnings.jsonl must exist and carry one assumption-uncertain
  // entry whose description is the assumption text.
  const ledgerFile = path.join(tmpDir, 'archives', 'warnings.jsonl');
  assert.ok(
    fs.existsSync(ledgerFile),
    `Expected archives/warnings.jsonl to exist — the uncertain assumption must be recorded to the advisory ledger (was not found at ${ledgerFile})`
  );
  const ledger = readLedger(tmpDir);
  const uncertainEntries = ledger.filter((e) => e.category === 'assumption-uncertain');
  assert.ok(
    uncertainEntries.length >= 1,
    `Expected at least one 'assumption-uncertain' ledger entry, got ${uncertainEntries.length} (ledger: ${JSON.stringify(ledger.map((e) => e.category))})`
  );
  const match = uncertainEntries.find((e) => e.description === UNCERTAIN_TEXT);
  assert.ok(
    match,
    `Expected a ledger entry with description === the uncertain assumption text (entries: ${JSON.stringify(uncertainEntries.map((e) => e.description))})`
  );

  // The ledger file is the ONLY thing written outside .harness/ (besides the
  // fixtures): no queue dir, no global plan, no stray pipeline output. This
  // proves the run stopped at the approval gate, recording nothing more than
  // the advisory.
  function collectNonHarnessFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(tmpDir, full);
      // bootstrap() ensures artifacts are ignored via an untracked
      // .git/info/exclude entry — it writes no tracked root .gitignore, so a
      // stray .gitignore here would be unexpected pipeline output.
      // spec.json is a fixture placed by makeDryRunValidatePipeline (sibling json
      // for the uncheckable-spec gate), not a pipeline-written file.
      // archives/warnings.jsonl is the advisory ledger the uncertain is
      // recorded to — EXPECTED under the advisory-no-park contract and
      // asserted positively above.
      if (
        rel.startsWith('.harness') ||
        rel === 'spec.md' ||
        rel === 'spec.json' ||
        rel === path.join('archives', 'warnings.jsonl')
      ) continue;
      if (entry.isDirectory()) {
        results.push(...collectNonHarnessFiles(full));
      } else {
        results.push(full);
      }
    }
    return results;
  }

  const unexpected = collectNonHarnessFiles(tmpDir);
  assert.deepStrictEqual(
    unexpected,
    [],
    `Expected nothing written outside .harness/ except the advisory ledger (and fixtures), found:\n  ${unexpected.join('\n  ')}`
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// TC4 — CLI dry-run routes to dryRunValidate
// ---------------------------------------------------------------------------

await test("TC4a: CLI index.js contains 'dry-run' case routing to dryRun handler", async () => {
  const cliPath = path.resolve(__dirname, '../src/cli/index.js');
  const cliSource = fs.readFileSync(cliPath, 'utf8');

  assert.ok(
    cliSource.includes("case 'dry-run'"),
    "Expected CLI index.js to contain \"case 'dry-run'\" routing entry"
  );

  assert.ok(
    cliSource.includes('dryRun'),
    "Expected CLI index.js to reference the dryRun handler"
  );
});

await test("TC4b: dry-run.js command calls pipeline.dryRunValidate (not pipeline.run)", async () => {
  const dryRunPath = path.resolve(__dirname, '../src/cli/commands/dry-run.js');
  const dryRunSource = fs.readFileSync(dryRunPath, 'utf8');

  assert.ok(
    dryRunSource.includes('dryRunValidate'),
    "Expected dry-run.js to call pipeline.dryRunValidate"
  );

  assert.ok(
    !dryRunSource.includes('pipeline.run('),
    "Expected dry-run.js NOT to call pipeline.run() — it should use dryRunValidate"
  );
});

await test("TC4c: dry-run.js exports dryRun function and is imported by CLI index.js", async () => {
  const cliPath = path.resolve(__dirname, '../src/cli/index.js');
  const dryRunPath = path.resolve(__dirname, '../src/cli/commands/dry-run.js');
  const cliSource = fs.readFileSync(cliPath, 'utf8');
  const dryRunSource = fs.readFileSync(dryRunPath, 'utf8');

  assert.ok(
    dryRunSource.includes('export async function dryRun') ||
      dryRunSource.includes('export function dryRun'),
    "Expected dry-run.js to export a dryRun function"
  );

  assert.ok(
    cliSource.includes("from './commands/dry-run.js'"),
    "Expected CLI index.js to import from './commands/dry-run.js'"
  );
});

await test("TC4d: suggest.js KNOWN_COMMANDS includes 'dry-run'", async () => {
  const suggestPath = path.resolve(__dirname, '../src/cli/suggest.js');
  const suggestSource = fs.readFileSync(suggestPath, 'utf8');

  assert.ok(
    suggestSource.includes('dry-run'),
    "Expected suggest.js KNOWN_COMMANDS to include 'dry-run'"
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
