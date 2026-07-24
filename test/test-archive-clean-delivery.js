/**
 * test-archive-clean-delivery.js — Fix 2: a non-clean run must NOT bump /
 * CHANGELOG / RUNS, plus the review-gate reject marker.
 *
 * Contract (Fix 2):
 *   - archive.js exports `isCleanDelivery(state)`: true iff NOT rejected,
 *     every milestone terminal (complete|invalidated), and ≥1 complete.
 *   - archive() gates the three release-tracking writes (version bump,
 *     CHANGELOG, RUNS/run-history) on isCleanDelivery(state). The archive
 *     RECORD (dir + manifest) is still written for non-clean runs.
 *   - pipeline.js _reviewGate reject branch persists globalStatus='rejected'
 *     into state.json BEFORE throwing, so a later `cc-orch archive` sees a
 *     non-clean delivery even though every milestone is `complete` on disk.
 *
 * Release-gating is asserted via CHANGELOG.md presence/absence at projectRoot.
 * CHANGELOG is gated by cleanDelivery and is INDEPENDENT of isOwnProject, so a
 * clean non-cc-orch synthetic project still writes CHANGELOG.md (even an empty
 * changelog writes "Maintenance release …"). We never drive the real bump.js.
 *
 * Run: node test/test-archive-clean-delivery.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { archive, isCleanDelivery } from '../src/cli/commands/archive.js';

const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');

// ── Test harness ─────────────────────────────────────────────────────────────

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

const tmpDirs = [];
function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
}

// ── Temp project helper ───────────────────────────────────────────────────────

/**
 * Create a temp project with a .harness/state.json carrying the given
 * milestones array and (optional) globalStatus. The project has NO
 * package.json named nightfoundry/cc-orchestrator, so isOwnProject is false and bump.js is
 * never driven — CHANGELOG remains the (isOwnProject-independent) signal.
 *
 * @param {Array<{id:string,description:string,status:string}>} milestones
 * @param {object} [extra]  extra top-level state fields (e.g. globalStatus)
 * @returns {string} projectRoot
 */
function makeProjectWithState(milestones, extra = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-clean-delivery-'));
  tmpDirs.push(tmpDir);

  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  const specRelPath = 'spec.md';
  fs.writeFileSync(
    path.join(tmpDir, specRelPath),
    '# Test Spec\n\nClean-delivery gating test.',
    'utf8'
  );

  const state = {
    name: 'Test Project',
    spec: specRelPath,
    startedAt: '2026-01-01T00:00:00.000Z',
    milestones,
    projectMeta: { currentPhase: 'complete' },
    ...extra,
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

  // Harness artifacts so moveHarnessToArchive has entries to move.
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'logs', 'test.log'), 'sample log', 'utf8');
  fs.mkdirSync(path.join(harnessDir, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'snapshots', 'snap.json'), '{}', 'utf8');
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'state', 'mission-001-001.json'), '{}', 'utf8');

  return tmpDir;
}

// ── Mock dependencies ─────────────────────────────────────────────────────────

const mockGetGitInfo = () => ({ gitHead: 'abc1234567890abcdef', gitStatus: 'clean' });

const mockSummarize = async () => ({
  headline: 'Clean-delivery test run',
  bugs: [],
  summary: 'Run completed.',
  changelog: [
    { type: 'feature', description: 'Added a clean-delivery feature' },
  ],
});

// ── (a) isCleanDelivery unit table ────────────────────────────────────────────

await test('Fix2-a: isCleanDelivery unit table', () => {
  // all-complete (array) → true
  assert.strictEqual(
    isCleanDelivery({ milestones: [{ status: 'complete' }, { status: 'complete' }] }),
    true,
    'all-complete should be a clean delivery'
  );

  // all-complete (object-keyed) → true (Object.values handles both shapes)
  assert.strictEqual(
    isCleanDelivery({ milestones: { '001': { status: 'complete' }, '002': { status: 'complete' } } }),
    true,
    'all-complete (object-keyed) should be a clean delivery'
  );

  // one in_progress → false
  assert.strictEqual(
    isCleanDelivery({ milestones: [{ status: 'complete' }, { status: 'in_progress' }] }),
    false,
    'a non-terminal (in_progress) milestone should not be a clean delivery'
  );

  // one pending → false
  assert.strictEqual(
    isCleanDelivery({ milestones: [{ status: 'complete' }, { status: 'pending' }] }),
    false,
    'a non-terminal (pending) milestone should not be a clean delivery'
  );

  // all-invalidated (zero complete) → false
  assert.strictEqual(
    isCleanDelivery({ milestones: [{ status: 'invalidated' }, { status: 'invalidated' }] }),
    false,
    'an all-invalidated run (zero complete) should not be a clean delivery'
  );

  // empty milestones → false
  assert.strictEqual(
    isCleanDelivery({ milestones: [] }),
    false,
    'empty milestones should not be a clean delivery'
  );
  assert.strictEqual(
    isCleanDelivery({ milestones: {} }),
    false,
    'empty (object-keyed) milestones should not be a clean delivery'
  );

  // globalStatus='rejected' + all complete → false
  assert.strictEqual(
    isCleanDelivery({ globalStatus: 'rejected', milestones: [{ status: 'complete' }, { status: 'complete' }] }),
    false,
    'a rejected run should not be a clean delivery even if every milestone is complete'
  );

  // mixed complete+invalidated (≥1 complete) → true
  assert.strictEqual(
    isCleanDelivery({ milestones: [{ status: 'complete' }, { status: 'invalidated' }] }),
    true,
    'mixed complete+invalidated with ≥1 complete should be a clean delivery'
  );
});

// ── (b) non-clean (one pending milestone) → record written, NO CHANGELOG ──────

await test('Fix2-b: non-clean run (one pending) archives a record but writes NO CHANGELOG', async () => {
  const projectRoot = makeProjectWithState([
    { id: '001', description: 'Done milestone', status: 'complete' },
    { id: '002', description: 'Still pending', status: 'pending' },
  ]);
  const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
  assert.ok(!fs.existsSync(changelogPath), 'precondition: no CHANGELOG.md before archive()');

  const archiveDir = await archive(projectRoot, 'nonclean-pending', { auto: true, 'skip-test-gate': true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDir, 'archive() should still return an archive dir (forensic record)');
  assert.ok(fs.existsSync(archiveDir), `archive record dir should exist: ${archiveDir}`);
  assert.ok(
    !fs.existsSync(changelogPath),
    'CHANGELOG.md must NOT be written for a non-clean delivery (one pending milestone)'
  );
});

// ── (c) clean all-complete → CHANGELOG IS written (gate does not over-block) ──

await test('Fix2-c: clean all-complete run writes CHANGELOG.md', async () => {
  const projectRoot = makeProjectWithState([
    { id: '001', description: 'First milestone', status: 'complete' },
    { id: '002', description: 'Second milestone', status: 'complete' },
  ]);
  const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
  assert.ok(!fs.existsSync(changelogPath), 'precondition: no CHANGELOG.md before archive()');

  const archiveDir = await archive(projectRoot, 'clean-complete', { auto: true, 'skip-test-gate': true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDir, 'archive() should return an archive dir');
  assert.ok(
    fs.existsSync(changelogPath),
    'CHANGELOG.md MUST be written for a clean all-complete delivery (gate must not over-block)'
  );
  const content = fs.readFileSync(changelogPath, 'utf8');
  assert.ok(
    content.includes('Clean-delivery test run'),
    `CHANGELOG.md should include the summarizer headline, got:\n${content.slice(0, 200)}`
  );
});

// ── (d) all-complete but globalStatus='rejected' → record kept, NO CHANGELOG ──

await test('Fix2-d: all-complete + globalStatus=rejected writes NO CHANGELOG (reject marker respected)', async () => {
  const projectRoot = makeProjectWithState(
    [
      { id: '001', description: 'First milestone', status: 'complete' },
      { id: '002', description: 'Second milestone', status: 'complete' },
    ],
    { globalStatus: 'rejected' }
  );
  const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
  assert.ok(!fs.existsSync(changelogPath), 'precondition: no CHANGELOG.md before archive()');

  const archiveDir = await archive(projectRoot, 'rejected-complete', { auto: true, 'skip-test-gate': true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDir, 'archive() should still return an archive dir (forensic record)');
  assert.ok(fs.existsSync(archiveDir), `archive record dir should exist: ${archiveDir}`);
  assert.ok(
    !fs.existsSync(changelogPath),
    'CHANGELOG.md must NOT be written when globalStatus=rejected (reject marker respected)'
  );
});

// ── (e) reject marker: _reviewGate reject persists globalStatus=rejected ──────

await test('Fix2-e: _reviewGate reject persists globalStatus=rejected and throws status=rejected', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-reject-marker-'));
  tmpDirs.push(tmpDir);
  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });

  // Every milestone is `complete` on disk at this point (as in production at the
  // review gate); globalStatus starts NON-rejected so the assertion discriminates.
  const stateJsonPath = path.join(harnessDir, 'state.json');
  const initialState = {
    globalStatus: 'active',
    projectMeta: { currentPhase: 'complete' },
    milestones: {
      '001': { id: '001', description: 'm1', status: 'complete' },
      '002': { id: '002', description: 'm2', status: 'complete' },
    },
  };
  fs.writeFileSync(stateJsonPath, JSON.stringify(initialState, null, 2), 'utf8');

  const pipeline = new Pipeline(tmpDir, { onLog: () => {} });
  pipeline.onMenu = async () => 'r';  // reject

  let caught = null;
  try {
    await pipeline._reviewGate({});
  } catch (err) {
    caught = err;
  }

  // The thrown error is unchanged (status='rejected', message unchanged).
  assert.ok(caught, 'Expected _reviewGate to throw when reject is chosen');
  assert.strictEqual(caught.status, 'rejected', `thrown error should have status='rejected', got: ${caught.status}`);
  assert.ok(
    caught.message.includes('rejected at review gate'),
    `thrown error message should be unchanged, got: ${caught.message}`
  );

  // The marker must be persisted on disk.
  const onDisk = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
  assert.strictEqual(
    onDisk.globalStatus, 'rejected',
    `state.json on disk should now have globalStatus='rejected', got: ${onDisk.globalStatus}`
  );
});

// ── Teardown & report ─────────────────────────────────────────────────────────

cleanup();

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
