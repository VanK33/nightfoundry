#!/usr/bin/env node
/**
 * Mirrors the module-top marker-discipline guard used by
 * test/helpers/make-run.js / test/test-bootstrap-run-scoped.js: this file
 * bootstraps and drives the REAL Pipeline.batchResume against isolated
 * fs.mkdtemp()/makeGitRoot() fixture roots, not a re-entrant cc-orch
 * invocation. Clear the marker unconditionally here, before any
 * process.env-sensitive imports, so this file is re-entrancy-neutral
 * regardless of launch context.
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

/**
 * test-batch-git-excludes-bare.js — Proves the batch-resume flow's clean-tree
 * guard is suppressed by the untracked .git/info/exclude mechanism ALONE
 * (ensureGitExcludes), even when the committed .gitignore is empty (a "bare"
 * fixture carrying none of the cc-orch patterns).
 *
 * CASE 1 (suppression through the real batch flow): a bare fixture
 * (makeGitRoot({ gitignore: '' })) with representative on-disk cc-orch
 * artifacts (.harness/, queue/, spec-foo.md, a.spec.md, a.spec.json,
 * a.uspec.json) plus a pending queue entry. Running the real
 * pipeline.batchResume({}) must PROCEED (archived:1) because
 * ensureGitExcludes fires before the porcelain read and roots the six
 * cc-orch patterns into .git/info/exclude, suppressing all of the above from
 * `git status --porcelain` — the batch never sees a dirty tree.
 *
 * CASE 2 (genuine dirt still refused): the same bare fixture shape, but with
 * a genuine non-cc-orch untracked file (user-file.txt). ensureGitExcludes has
 * no knowledge of this file, so porcelain stays non-empty and batchResume
 * refuses with the friendly 'working tree is not clean' message, leaving the
 * pending queue entry untouched.
 *
 * Run: node test/test-batch-git-excludes-bare.js
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import assert from 'assert';
import { readQueueEntry } from '../src/orchestrator/core/state.js';
import {
  makeGitRoot,
  cleanup,
  porcelain,
  makeFakeArchive,
  makePlan,
  createQueueEntry,
  makeRealBatchPipeline,
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

// ── shared helpers (mirrors test-git-excludes.js) ──────────────────────────

const MARKER = '# cc-orch artifacts (auto-managed)';

function excludePathFor(dir) {
  const out = execSync('git rev-parse --git-path info/exclude', {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  return path.isAbsolute(out) ? out : path.resolve(dir, out);
}

function hasLine(content, line) {
  return content.split('\n').some((l) => l.trim() === line);
}

/** Write representative on-disk cc-orch artifacts (queue/ already exists via createQueueEntry). */
function writeCcOrchArtifacts(root) {
  fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(root, '.harness', 'x'), 'a\n');
  fs.writeFileSync(path.join(root, 'spec-foo.md'), 'a\n');
  fs.writeFileSync(path.join(root, 'a.spec.md'), 'a\n');
  fs.writeFileSync(path.join(root, 'a.spec.json'), 'a\n');
  fs.writeFileSync(path.join(root, 'a.uspec.json'), 'a\n');
}

// ── CASE 1 ──────────────────────────────────────────────────────────────────
// bare fixture (gitignore: '') with cc-orch artifacts + a pending entry →
// batchResume proceeds (archived:1) because ensureGitExcludes suppresses the
// artifacts from porcelain.

await test('CASE 1: bare fixture — cc-orch artifacts suppressed, batch proceeds and archives', async () => {
  const root = makeGitRoot({ prefix: 'cc-batch-bare-', gitignore: '' });
  try {
    // Precondition: the committed .gitignore body is empty ...
    const gitignoreBody = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.strictEqual(gitignoreBody, '', 'CASE 1 precondition: committed .gitignore body must be empty');

    // ... and .git/info/exclude carries no cc-orch MARKER yet (suppression
    // can only originate from ensureGitExcludes during the batchResume run).
    const excludePath = excludePathFor(root);
    let preContent = '';
    try { preContent = fs.readFileSync(excludePath, 'utf8'); } catch { /* file may not exist yet */ }
    assert.ok(!hasLine(preContent, MARKER),
      'CASE 1 precondition: .git/info/exclude must not already carry the cc-orch MARKER');

    createQueueEntry(root, 'pending-spec', { plan: makePlan() });
    writeCcOrchArtifacts(root);

    const { pipeline, logs } = makeRealBatchPipeline(root, {
      archive: makeFakeArchive(),
      executeAllMilestones: async () => {
        // A tracked deliverable so the spec-boundary commit has content to land.
        fs.writeFileSync(path.join(root, 'deliverable.txt'), 'shipped\n');
      },
    });

    const result = await pipeline.batchResume({});

    assert.strictEqual(result.archived, 1,
      `CASE 1: batch should have PROCEEDED (archived:1), got archived:${result.archived}`);

    // The exclude mechanism fired: MARKER + rooted '.harness/' and 'queue/'.
    const content = fs.readFileSync(excludePath, 'utf8');
    assert.ok(hasLine(content, MARKER), 'CASE 1: .git/info/exclude should now carry the MARKER');
    assert.ok(hasLine(content, '/.harness/'),
      "CASE 1: .git/info/exclude should carry the rooted '/.harness/' pattern");
    assert.ok(hasLine(content, '/queue/'),
      "CASE 1: .git/info/exclude should carry the rooted '/queue/' pattern");

    // The batch did NOT log the dirty-tree refusal.
    assert.ok(!logs.some((l) => l.includes('working tree is not clean')),
      `CASE 1: must not refuse with "working tree is not clean". Logs:\n${logs.join('\n')}`);

    // Final tree is clean, deliverable committed, queue entry dequeued.
    assert.strictEqual(porcelain(root), '',
      `CASE 1: tree must be clean after the batch run. Got:\n${porcelain(root)}`);
    assert.ok(fs.existsSync(path.join(root, 'deliverable.txt')),
      'CASE 1: committed deliverable should remain on disk');
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'pending-spec')),
      'CASE 1: queue entry should be removed after successful archive');
  } finally {
    cleanup(root);
  }
});

// ── CASE 2 ──────────────────────────────────────────────────────────────────
// bare fixture with genuine non-cc-orch untracked dirt → batch still refuses.

await test('CASE 2: bare fixture — genuine user dirt still refused', async () => {
  const root = makeGitRoot({ prefix: 'cc-batch-bare-', gitignore: '' });
  try {
    createQueueEntry(root, 'pending-spec', { plan: makePlan() });

    // Genuine, non-cc-orch untracked file — no exclude pattern will ever match it.
    fs.writeFileSync(path.join(root, 'user-file.txt'), 'dirty\n');

    const logs = [];
    const { pipeline } = makeRealBatchPipeline(root, {
      archive: async () => { throw new Error('CASE 2: archive should not be called'); },
      executeAllMilestones: async () => { throw new Error('CASE 2: execution should not run'); },
      onLog: (msg) => logs.push(msg),
    });

    const result = await pipeline.batchResume({});

    assert.strictEqual(result.archived, 0,
      `CASE 2: expected archived:0, got archived:${result.archived}`);
    assert.ok(logs.some((l) => l.includes('working tree is not clean')),
      `CASE 2: expected log with "working tree is not clean". Logs:\n${logs.join('\n')}`);

    const entry = readQueueEntry(root, 'pending-spec');
    assert.ok(entry !== null, 'CASE 2: queue entry should still exist');
    assert.strictEqual(entry.status, 'pending', `CASE 2: entry status unchanged, got '${entry.status}'`);
  } finally {
    cleanup(root);
  }
});

console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
