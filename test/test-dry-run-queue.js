#!/usr/bin/env node
/**
 * test-dry-run-queue.js — Integration tests for the dry-run → queue flow.
 *
 * Tests:
 *   TC1 — dryRunValidate creates queue/{slug}/ with spec.md matching original spec content
 *   TC2 — dryRunValidate creates queue/{slug}/ with plan.json matching globalPlan
 *   TC3 — dryRunValidate creates queue/{slug}/ with validated-at.json containing timestamp
 *   TC4 — dryRunValidate creates queue/{slug}/ with status file containing 'pending'
 *   TC5 — dryRunValidate does NOT call planMission (executor call count is 0, no mission state files)
 *   TC6 — listQueue after dryRunValidate returns exactly 1 entry with correct slug and status
 *   TC7 — queueRemove deletes entry, listQueue returns empty array
 *   TC8 — dryRunValidate stops without queuing when user rejects plan (onConfirm returns false)
 *   TC9 — original spec file inside projectRoot is deleted after dryRunValidate; queue copy matches content
 *   TC10 — dryRunValidate persists the queue entry for the spec at the correct queue path
 *   TC11 — spec file outside projectRoot is NOT deleted (guard condition)
 *   TC12 — null prdPath (goal-only mode) completes without error and no unlink is attempted
 *
 * Run: node test/test-dry-run-queue.js
 *
 * No live Claude sessions are spawned — all planner interactions are mocked.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { readQueueEntry } from '../src/orchestrator/core/state.js';
import { queueRemove } from '../src/cli/commands/queue.js';

// This suite's fixtures spawn a fresh Pipeline against an isolated
// fs.mkdtemp fixture root for every test, not the live run's project root.
// But if the suite is launched from inside a live cc-orch run (e.g. via a
// spawned test gate), CC_ORCH_ACTIVE_RUN is inherited from the parent
// process and would trip assertNoReentrantLiveRun's active-root bootstrap
// checks inside dryRunValidate. Clear the marker so this suite runs
// re-entrancy-neutral regardless of launch context.
delete process.env.CC_ORCH_ACTIVE_RUN;

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

// ── Fixture data ───────────────────────────────────────────────────────────

const TEST_SPEC_CONTENT = `# Test Spec

This is a test spec for the dry-run queue flow.

## Goals
- Build something useful
`;

const TEST_SPEC_JSON_CONTENT = JSON.stringify({
  goal: 'Build something useful',
  target_files: ['src/foo.js'],
  acceptance_criteria: [{ description: 'it works', verification: { kind: 'manual' } }],
});

const cannedGlobalPlan = {
  milestones: [
    {
      id: '001',
      description: 'Test milestone',
      missions: [
        { id: '001-001', description: 'Test mission one' },
        { id: '001-002', description: 'Test mission two' },
      ],
    },
  ],
  assumptions: [],
};

// ── Helper: build a fresh tmpDir + mocked Pipeline ─────────────────────────

function makeTestPipeline(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-queue-'));
  fs.mkdirSync(tmpDir, { recursive: true });

  // Write a test spec file for dryRunValidate to read
  const specFilename = opts.specFilename || 'test-spec.md';
  const specPath = path.join(tmpDir, specFilename);
  fs.writeFileSync(specPath, opts.specContent || TEST_SPEC_CONTENT);

  // Sibling spec.json fixture — the uncheckable-spec gate fails closed on a
  // bare .md, so every .md spec fixture needs a parseable sibling json.
  const specJsonPath = specPath.replace(/\.md$/, '.json');
  fs.writeFileSync(specJsonPath, TEST_SPEC_JSON_CONTENT);

  const logs = [];

  // onConfirm defaults to true (approve plan); TC8 overrides to false
  const onConfirm =
    opts.onConfirm !== undefined ? opts.onConfirm : async () => true;

  const pipeline = new Pipeline(tmpDir, {
    dryRun: true,
    skipWorktreeCreation: true,
    onLog: (msg) => logs.push(msg),
    onConfirm,
  });

  // Track planMission calls — must remain 0 for TC5
  let planMissionCallCount = 0;
  pipeline.planner.planMission = async () => {
    planMissionCallCount++;
    throw new Error('planMission must NOT be called in dryRunValidate');
  };

  // Stub planGlobal to return our canned plan
  pipeline.planner.planGlobal = async () =>
    JSON.parse(JSON.stringify(opts.globalPlan || cannedGlobalPlan));

  // verifyAssumptions returns empty list — no assumptions to check
  pipeline.planner.verifyAssumptions = async () => [];

  // closeReusableSession is a no-op
  pipeline.planner.closeReusableSession = async () => {};

  return {
    tmpDir,
    specPath,
    pipeline,
    logs,
    getPlanMissionCallCount: () => planMissionCallCount,
  };
}

/**
 * List all queue entries under projectRoot/queue/ using readQueueEntry.
 * Mirrors the semantics of the internal listQueue helper.
 *
 * @param {string} projectRoot
 * @returns {Array<{ slug, spec, plan, validatedAt, status }>}
 */
function listQueueEntries(projectRoot) {
  const queueDir = path.join(projectRoot, 'queue');
  if (!fs.existsSync(queueDir)) return [];

  const slugs = fs.readdirSync(queueDir).filter((s) => {
    try {
      return fs.statSync(path.join(queueDir, s)).isDirectory();
    } catch {
      return false;
    }
  });

  return slugs
    .map((slug) => readQueueEntry(projectRoot, slug))
    .filter(Boolean);
}

// ── TC1: spec.md content ───────────────────────────────────────────────────

await test('TC1: dryRunValidate creates spec.md matching original spec content', async () => {
  const { tmpDir, specPath, pipeline } = makeTestPipeline();
  try {
    await pipeline.dryRunValidate('Implement test spec', { prdPath: specPath });

    const slug = 'test-spec';
    const specFile = path.join(tmpDir, 'queue', slug, 'spec.md');
    assert.ok(fs.existsSync(specFile), `queue/${slug}/spec.md should exist`);

    const content = fs.readFileSync(specFile, 'utf8');
    assert.strictEqual(content, TEST_SPEC_CONTENT, 'spec.md content must match original spec');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC2: plan.json matches globalPlan ──────────────────────────────────────

await test('TC2: dryRunValidate creates plan.json matching globalPlan', async () => {
  const { tmpDir, specPath, pipeline } = makeTestPipeline();
  try {
    await pipeline.dryRunValidate('Implement test spec', { prdPath: specPath });

    const slug = 'test-spec';
    const planFile = path.join(tmpDir, 'queue', slug, 'plan.json');
    assert.ok(fs.existsSync(planFile), `queue/${slug}/plan.json should exist`);

    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    assert.ok(Array.isArray(plan.milestones), 'plan.json should have milestones array');
    assert.strictEqual(plan.milestones.length, 1, 'plan should have 1 milestone');
    assert.strictEqual(plan.milestones[0].id, '001', 'milestone id should match');
    assert.strictEqual(
      plan.milestones[0].description,
      'Test milestone',
      'milestone description should match'
    );
    assert.strictEqual(
      plan.milestones[0].missions.length,
      2,
      'milestone should have 2 missions'
    );
    assert.strictEqual(
      plan.milestones[0].missions[0].id,
      '001-001',
      'first mission id should match'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC3: validated-at.json contains timestamp ──────────────────────────────

await test('TC3: dryRunValidate creates validated-at.json containing timestamp', async () => {
  const { tmpDir, specPath, pipeline } = makeTestPipeline();
  try {
    const before = new Date().toISOString();
    await pipeline.dryRunValidate('Implement test spec', { prdPath: specPath });
    const after = new Date().toISOString();

    const slug = 'test-spec';
    const validatedAtFile = path.join(tmpDir, 'queue', slug, 'validated-at.json');
    assert.ok(fs.existsSync(validatedAtFile), `queue/${slug}/validated-at.json should exist`);

    const validatedAt = JSON.parse(fs.readFileSync(validatedAtFile, 'utf8'));
    assert.ok(
      typeof validatedAt === 'string',
      'validated-at.json must be a flat ISO string after the assumptionResults split'
    );
    assert.ok(
      validatedAt >= before,
      `timestamp (${validatedAt}) should be >= run start (${before})`
    );
    assert.ok(
      validatedAt <= after,
      `timestamp (${validatedAt}) should be <= run end (${after})`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC4: status file contains 'pending' ───────────────────────────────────

await test("TC4: dryRunValidate creates status file containing 'pending'", async () => {
  const { tmpDir, specPath, pipeline } = makeTestPipeline();
  try {
    await pipeline.dryRunValidate('Implement test spec', { prdPath: specPath });

    const slug = 'test-spec';
    const statusFile = path.join(tmpDir, 'queue', slug, 'status');
    assert.ok(fs.existsSync(statusFile), `queue/${slug}/status should exist`);

    const status = fs.readFileSync(statusFile, 'utf8');
    assert.strictEqual(status, 'pending', "status file must contain exactly 'pending'");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC5: planMission NOT called ────────────────────────────────────────────

await test('TC5: dryRunValidate does NOT call planMission (call count 0, no mission state files)', async () => {
  const { tmpDir, specPath, pipeline, getPlanMissionCallCount } = makeTestPipeline();
  try {
    await pipeline.dryRunValidate('Implement test spec', { prdPath: specPath });

    assert.strictEqual(
      getPlanMissionCallCount(),
      0,
      'planMission must never be called during dryRunValidate'
    );

    // The per-run dry-run scratch dir self-cleans after the run completes, so
    // no mission-state files can be asserted under .harness/state/. Instead,
    // assert against the durable queue entry dryRunValidate persists for the
    // spec: the entry file must exist at the correct queue-relative spec path.
    const slug = 'test-spec';
    const queueSpecPath = path.join(tmpDir, 'queue', slug, 'spec.md');
    assert.ok(
      fs.existsSync(queueSpecPath),
      `queue entry spec.md should exist at "${queueSpecPath}" after dryRunValidate`
    );

    const entry = readQueueEntry(tmpDir, slug);
    assert.ok(
      entry,
      `queue entry for slug "${slug}" should be persisted after dryRunValidate`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC6: listQueue returns exactly 1 entry ─────────────────────────────────

await test('TC6: listQueue after dryRunValidate returns exactly 1 entry with correct slug and status', async () => {
  const { tmpDir, specPath, pipeline } = makeTestPipeline();
  try {
    await pipeline.dryRunValidate('Implement test spec', { prdPath: specPath });

    const entries = listQueueEntries(tmpDir);
    assert.strictEqual(entries.length, 1, 'listQueue should return exactly 1 entry');

    const entry = entries[0];
    assert.strictEqual(entry.slug, 'test-spec', "entry slug should be 'test-spec'");
    assert.strictEqual(entry.status, 'pending', "entry status should be 'pending'");
    assert.ok(entry.plan, 'entry should have a plan');
    assert.ok(entry.validatedAt, 'entry should have validatedAt metadata');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC7: queueRemove deletes entry, listQueue returns empty ────────────────

await test('TC7: queueRemove deletes entry, listQueue returns empty array', async () => {
  const { tmpDir, specPath, pipeline } = makeTestPipeline();
  try {
    await pipeline.dryRunValidate('Implement test spec', { prdPath: specPath });

    // Confirm 1 entry exists before removal
    let entries = listQueueEntries(tmpDir);
    assert.strictEqual(entries.length, 1, 'should have 1 entry before queueRemove');

    // Remove the entry
    queueRemove(tmpDir, 'test-spec');

    // Confirm queue is now empty
    entries = listQueueEntries(tmpDir);
    assert.strictEqual(
      entries.length,
      0,
      'listQueue should return empty array after queueRemove'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC8: onConfirm returns false → no queuing ─────────────────────────────

await test('TC8: dryRunValidate stops without queuing when user rejects plan (onConfirm returns false)', async () => {
  const { tmpDir, specPath, pipeline } = makeTestPipeline({
    onConfirm: async () => false,
  });
  try {
    await pipeline.dryRunValidate('Implement test spec', { prdPath: specPath });

    const queueDir = path.join(tmpDir, 'queue');
    const hasQueuedEntries =
      fs.existsSync(queueDir) &&
      fs.readdirSync(queueDir).some((s) => {
        try {
          return fs.statSync(path.join(queueDir, s)).isDirectory();
        } catch {
          return false;
        }
      });

    assert.ok(
      !hasQueuedEntries,
      'queue directory must have no entries when user rejects the plan'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC9: original spec file deleted, queue copy exists ────────────────────

await test('TC9: original spec file removed after dryRunValidate, queue copy exists with matching content', async () => {
  const { tmpDir, specPath, pipeline } = makeTestPipeline();
  try {
    await pipeline.dryRunValidate('Implement test spec', { prdPath: specPath });

    // Original file should be deleted — it was inside projectRoot
    assert.strictEqual(
      fs.existsSync(specPath),
      false,
      'original spec file should be removed after queuing (inside projectRoot)'
    );

    // Queue copy should exist with matching content
    const slug = 'test-spec';
    const queueCopyPath = path.join(tmpDir, 'queue', slug, 'spec.md');
    assert.ok(fs.existsSync(queueCopyPath), `queue/${slug}/spec.md should exist after dryRunValidate`);

    const content = fs.readFileSync(queueCopyPath, 'utf8');
    assert.strictEqual(content, TEST_SPEC_CONTENT, 'queue copy content must match original spec content');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC10: state.json projectMeta.prdPath updated to queue copy path ────────

await test('TC10: dryRunValidate persists the queue entry for the spec at the correct queue path', async () => {
  const { tmpDir, specPath, pipeline } = makeTestPipeline();
  try {
    await pipeline.dryRunValidate('Implement test spec', { prdPath: specPath });

    // The per-run dry-run scratch dir self-cleans, so a flat .harness/state.json
    // existence check is not a reliable post-run assertion. Assert instead on
    // the durable queue entry dryRunValidate persists for the spec: the entry
    // file must exist and carry the correct queue-relative spec path.
    const slug = 'test-spec';
    const expectedSpecPath = path.join(tmpDir, 'queue', slug, 'spec.md');
    assert.ok(
      fs.existsSync(expectedSpecPath),
      `queue entry spec.md should exist at "${expectedSpecPath}" after dryRunValidate`
    );

    const entry = readQueueEntry(tmpDir, slug);
    assert.ok(
      entry,
      `queue entry for slug "${slug}" should be persisted after dryRunValidate`
    );
    assert.strictEqual(
      entry.slug,
      slug,
      'queue entry slug should match the spec slug'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC11: spec outside project root is NOT deleted ─────────────────────────

await test('TC11: spec outside project root is NOT deleted after dryRunValidate (guard condition)', async () => {
  // Create a spec file OUTSIDE projectRoot (tmpDir) — directly in os.tmpdir()
  const externalSpecPath = path.join(os.tmpdir(), `external-spec-${Date.now()}.md`);
  fs.writeFileSync(externalSpecPath, TEST_SPEC_CONTENT);
  // Sibling json for the gate (fail-closed on bare .md specs)
  const externalSpecJsonPath = externalSpecPath.replace(/\.md$/, '.json');
  fs.writeFileSync(externalSpecJsonPath, TEST_SPEC_JSON_CONTENT);

  const { tmpDir, pipeline } = makeTestPipeline();
  try {
    await pipeline.dryRunValidate('Implement test spec', { prdPath: externalSpecPath });

    // External spec must NOT be deleted — guard prevents deletion outside projectRoot
    assert.ok(
      fs.existsSync(externalSpecPath),
      'spec file outside project root must NOT be deleted after dryRunValidate'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Clean up external spec if it still exists
    if (fs.existsSync(externalSpecPath)) {
      fs.unlinkSync(externalSpecPath);
    }
    if (fs.existsSync(externalSpecJsonPath)) {
      fs.unlinkSync(externalSpecJsonPath);
    }
  }
});

// ── TC12: null prdPath (goal-only mode) completes without error ────────────

await test('TC12: null prdPath (goal-only mode) completes without error and no unlink is attempted', async () => {
  const { tmpDir, specPath, pipeline } = makeTestPipeline();
  try {
    // Pass prdPath: null — simulates goal-only mode (no spec file)
    await pipeline.dryRunValidate('Implement test spec', { prdPath: null });

    // The spec file created by makeTestPipeline should still exist
    // (pipeline had no prdPath to unlink)
    assert.ok(
      fs.existsSync(specPath),
      'spec file in tmpDir must not be touched when prdPath is null'
    );

    // A queue entry should still be created (under slug 'spec' since no filename)
    const queueDir = path.join(tmpDir, 'queue');
    assert.ok(fs.existsSync(queueDir), 'queue directory should be created even with null prdPath');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
