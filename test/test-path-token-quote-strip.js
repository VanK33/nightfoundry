#!/usr/bin/env node
/**
 * test-path-token-quote-strip.js — Tests for the path-token shell-punctuation
 * strip + the three batchResume log riders (spec: path-token-quote-strip).
 *
 * Coverage (numbered after the spec's acceptance criteria):
 *   TC1 — extractPathTokens token hygiene table: the proving-run repro
 *         (double-quoted grep command), single-quote / backtick / paren /
 *         bracket / angle-bracket variants, trailing semicolon/comma,
 *         repeated-until-stable nesting, plain commands unchanged, non-path
 *         quoted tokens excluded, empty-after-strip tokens dropped
 *   TC2 — end-to-end scoping: a check whose command embeds the path in
 *         double quotes scopes onto the task carrying that targetFile via
 *         scopeSpecHardChecks and is NOT an orphan per
 *         findOrphanedSpecHardChecks
 *   TC3 — F-A: a batchResume execution failure logs the slug and
 *         err.message (before the forensic archive runs); entry is
 *         failed-execution
 *   TC4 — F-C: the batch summary line reads 'Batch complete. N archived,
 *         M failed.' with no '-validation' suffix
 *   TC5 — F-B skip: archives/ gitignored → 'Park commit skipped' is logged
 *         and NO 'Park commit failed' git error appears
 *   TC6 — F-B proceed: archives/ NOT gitignored → no skip log; the park
 *         commit is attempted (it either lands as a commit or logs the
 *         existing best-effort 'Park commit failed ... — continuing with
 *         revert.' line)
 *
 * Run: node test/test-path-token-quote-strip.js
 *
 * No live Claude sessions are spawned — all agent interactions are stubbed.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import {
  extractPathTokens,
  scopeSpecHardChecks,
  findOrphanedSpecHardChecks,
} from '../src/orchestrator/agents/planner.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeQueueEntry, readQueueEntry } from '../src/orchestrator/core/state.js';

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

// ── TC1: extractPathTokens token hygiene table ─────────────────────────────

await test('TC1: extractPathTokens strips shell punctuation from token ends (proving-run repro + variants)', () => {
  const table = [
    // The Wave-1 proving-run repro: double-quoted grep command. At the broken
    // baseline the trailing '"' survives and the token matches no targetFile.
    {
      cmd: 'bash -c "! grep -n X src/orchestrator/core/pipeline.js"',
      expected: ['src/orchestrator/core/pipeline.js'],
    },
    // Single-quote variant.
    {
      cmd: "sh -c '! grep -q Y test/test-a.js'",
      expected: ['test/test-a.js'],
    },
    // Paren + trailing-semicolon variant.
    {
      cmd: '(cat src/x.js);',
      expected: ['src/x.js'],
    },
    // Plain command — unchanged.
    {
      cmd: 'node test/test-x.js',
      expected: ['test/test-x.js'],
    },
    // No path tokens at all.
    {
      cmd: 'echo hello',
      expected: [],
    },
    // Trailing comma and trailing semicolon on separate tokens.
    {
      cmd: 'cat src/a.js, src/b.js;',
      expected: ['src/a.js', 'src/b.js'],
    },
    // Non-path quoted token: cleaned token is 'hello' (no '/', no known
    // extension) → still excluded.
    {
      cmd: 'echo "hello"',
      expected: [],
    },
    // Backtick variant.
    {
      cmd: 'echo `node test/test-b.js`',
      expected: ['test/test-b.js'],
    },
    // Brace and bracket variants.
    {
      cmd: 'lint {src/y.js} [test/test-c.js]',
      expected: ['src/y.js', 'test/test-c.js'],
    },
    // Angle-bracket variant.
    {
      cmd: 'cat <src/in.js>',
      expected: ['src/in.js'],
    },
    // Repeatedly-until-stable: nested punctuation ("(...)" + trailing ';')
    // must be fully peeled from both ends.
    {
      cmd: 'cat ("src/nested.js");',
      expected: ['src/nested.js'],
    },
    // Empty-after-strip tokens are dropped (the '";;"' token strips to '').
    {
      cmd: 'grep ";;" src/z.js',
      expected: ['src/z.js'],
    },
  ];

  for (const { cmd, expected } of table) {
    const actual = extractPathTokens(cmd);
    assert.deepStrictEqual(
      actual,
      expected,
      `extractPathTokens(${JSON.stringify(cmd)}) expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }

  // Degenerate inputs keep their existing behavior.
  assert.deepStrictEqual(extractPathTokens(''), [], 'empty string → []');
});

// ── TC2: end-to-end scoping — quoted-path check is scoped, not orphaned ────

await test('TC2: a double-quoted-path check scopes onto the matching task and is not an orphan', () => {
  const checks = [
    { name: 'c1', command: 'bash -c "! grep -n Z src/orchestrator/core/pipeline.js"' },
  ];
  const tasks = [
    { id: 't1', targetFiles: ['src/orchestrator/core/pipeline.js'] },
  ];

  const scoped = scopeSpecHardChecks(checks, tasks);

  const t1Checks = scoped.get('t1');
  assert.ok(Array.isArray(t1Checks), "scopeSpecHardChecks must return a Map with an entry for 't1'");
  assert.strictEqual(
    t1Checks.length,
    1,
    `the quoted-command check must scope onto t1 (got ${t1Checks.length} checks)`,
  );
  assert.strictEqual(t1Checks[0].command, checks[0].command,
    'the scoped check must carry the original command string');

  const orphans = findOrphanedSpecHardChecks(checks, scoped);
  assert.strictEqual(
    orphans.length,
    0,
    `the quoted-command check must NOT be reported as an orphan (got ${orphans.length}: ${JSON.stringify(orphans.map((o) => o.name))})`,
  );
});

// ── Batch fixtures (TC3–TC6) ───────────────────────────────────────────────

// Deliberately scope-item-free markdown (no '## Scope — in', no **Bug N**
// bullets, no scope-item markers, no backticked paths) so _scopeCoverageGate
// skips — mirrors test/test-batch-failure-crash-safety.js.
const SPEC_MD = `# Test Spec

This is a test spec for the path-token-quote-strip batch riders.

## Goals
- Build something useful
`;

// Parseable sibling json so the uncheckable-spec gate passes.
const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

const GITIGNORE_ARCHIVES_IGNORED = 'queue/\narchives/\nfake-archives/\n.harness/\n';
const GITIGNORE_ARCHIVES_TRACKED = 'queue/\nfake-archives/\n.harness/\n';

function makeTmpRoot(prefix = 'cc-orch-quote-strip-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Git fixture: init + identity + tracked seed file + a committed .gitignore
// whose content is parameterized (TC5 needs archives/ ignored; TC6 needs it
// NOT ignored).
function makeGitRoot(gitignoreContent) {
  const root = makeTmpRoot();
  execSync('git init', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed content\n');
  fs.writeFileSync(path.join(root, '.gitignore'), gitignoreContent);
  execSync('git add -A', { cwd: root, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: root, stdio: 'pipe' });
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Run a one-entry batch whose _executeAllMilestones throws a sentinel error
// and whose forensic archive produces nothing (throws). Mirrors the
// makeBatchPipeline idiom from test/test-batch-failure-crash-safety.js.
// Returns the run's evidence: result, logs, the re-read queue entry, whether
// the F-A failure log was already present when the forensic archive ran, and
// the fixture's git log.
async function runFailingBatch({ slug, gitignore }) {
  const root = makeGitRoot(gitignore);
  try {
    writeQueueEntry(root, slug, {
      spec: SPEC_MD,
      // Fresh-run shape: goal-only plan carries scopeItems:[]/scopeMapping:[]
      // (present-and-empty → gate skips). Absent → legacy fail-close.
      plan: { milestones: [], assumptions: [], scopeItems: [], scopeMapping: [] },
      validatedAt: new Date().toISOString(),
      status: 'pending',
      specJson: SPEC_JSON,
    });

    const logs = [];
    let forensicSawFailureLog = null;

    const archiveStub = async (_projectRoot, _slug, archiveOpts) => {
      if (archiveOpts && archiveOpts['include-failed']) {
        // F-A ordering evidence: the failure log must fire BEFORE the
        // forensic archive runs.
        forensicSawFailureLog = logs.some((l) => l.includes('execution failed: W1F2-SENTINEL'));
        throw new Error('forensic archive produced nothing');
      }
      const dir = path.join(root, 'fake-archives', '1');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };

    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: (msg) => logs.push(msg),
      onConfirm: async () => true,
      archive: archiveStub,
    });

    pipeline.planner.verifyAssumptions = async () => [];
    pipeline.planner.closeReusableSession = async () => {};
    pipeline._executeAllMilestones = async () => {
      throw new Error('W1F2-SENTINEL');
    };
    pipeline._reviewGate = async () => {};

    const result = await pipeline.batchResume({});

    const entry = readQueueEntry(root, slug);
    let gitLog = '';
    try {
      gitLog = execSync('git log --format=%s', { cwd: root, encoding: 'utf8' });
    } catch { /* leave empty */ }

    return { result, logs, entry, forensicSawFailureLog, gitLog };
  } finally {
    cleanup(root);
  }
}

// ── TC3: F-A — execution failure logs slug + err.message ──────────────────

await test("TC3: F-A — batchResume logs \"Entry '<slug>' execution failed: <err.message>\" before the forensic archive; entry failed-execution", async () => {
  const { result, logs, entry, forensicSawFailureLog } = await runFailingBatch({
    slug: 'fa-entry',
    gitignore: GITIGNORE_ARCHIVES_IGNORED,
  });

  assert.ok(
    logs.some((l) => l.includes("Entry 'fa-entry' execution failed: W1F2-SENTINEL")),
    `the batch log must contain "Entry 'fa-entry' execution failed: W1F2-SENTINEL" — got logs:\n${logs.join('\n')}`,
  );
  assert.strictEqual(forensicSawFailureLog, true,
    'the F-A failure log must fire BEFORE the forensic archive runs (the archive stub saw no such log)');

  assert.ok(entry, "entry 'fa-entry' must still exist in the queue");
  assert.strictEqual(entry.status, 'failed-execution',
    `entry 'fa-entry' expected status 'failed-execution', got '${entry.status}'`);
  assert.strictEqual(result.failed, 1, `expected failed:1, got ${result.failed}`);
  assert.strictEqual(result.archived, 0, `expected archived:0, got ${result.archived}`);
});

// ── TC4: F-C — summary line says 'failed', not 'failed-validation' ─────────

await test("TC4: F-C — final summary line is 'Batch complete. N archived, M failed.' (no -validation suffix)", async () => {
  const { logs } = await runFailingBatch({
    slug: 'fc-entry',
    gitignore: GITIGNORE_ARCHIVES_IGNORED,
  });

  assert.ok(logs.length > 0, 'the batch run must produce logs');
  const lastLog = logs[logs.length - 1];

  assert.ok(
    /Batch complete\. \d+ archived, \d+ failed\.$/.test(lastLog),
    `the final log line must match /Batch complete\\. \\d+ archived, \\d+ failed\\.$/ — got: "${lastLog}"`,
  );
  assert.ok(
    !lastLog.includes('failed-validation.'),
    `the final summary must not carry the '-validation' suffix — got: "${lastLog}"`,
  );
  assert.ok(
    lastLog.includes('0 archived, 1 failed.'),
    `the summary counts must be truthful (0 archived, 1 failed) — got: "${lastLog}"`,
  );
});

// ── TC5: F-B skip — archives/ gitignored → park commit skipped ─────────────

await test("TC5: F-B — archives/ gitignored → 'Park commit skipped' logged, no 'Park commit failed' git error", async () => {
  const { logs, entry } = await runFailingBatch({
    slug: 'fb-skip',
    gitignore: GITIGNORE_ARCHIVES_IGNORED,
  });

  assert.ok(
    logs.some((l) => l.includes("Park commit skipped for 'fb-skip': archives/ is gitignored")),
    `the batch log must contain "Park commit skipped for 'fb-skip': archives/ is gitignored" — got logs:\n${logs.join('\n')}`,
  );
  assert.ok(
    !logs.some((l) => l.includes('Park commit failed')),
    `no 'Park commit failed' error may appear when the park commit is skipped — got logs:\n${logs.join('\n')}`,
  );

  assert.ok(entry, "entry 'fb-skip' must still exist in the queue");
  assert.strictEqual(entry.status, 'failed-execution',
    `entry 'fb-skip' expected status 'failed-execution', got '${entry.status}'`);
});

// ── TC6: F-B proceed — archives/ NOT gitignored → park commit attempted ────

await test("TC6: F-B — archives/ NOT gitignored → no skip log; the park commit is attempted as before", async () => {
  const { result, logs, entry, gitLog } = await runFailingBatch({
    slug: 'fb-proceed',
    gitignore: GITIGNORE_ARCHIVES_TRACKED,
  });

  assert.ok(
    !logs.some((l) => l.includes('Park commit skipped')),
    `'Park commit skipped' must NOT appear when archives/ is not gitignored — got logs:\n${logs.join('\n')}`,
  );

  // The attempt happened: either the park commit landed in the fixture's
  // history, or (here, where the forensic archive produced nothing) a
  // best-effort log fired.
  // re-pin: w4-batch-failure-input-boundary Fix #1(b) split the single old
  // "Park commit failed ..." message into a benign empty-archive case
  // ("No park-commit changes ... continuing with revert") and a real-failure
  // case ("Park commit failed ..."). This fixture's forensic archive produces
  // nothing → the benign branch fires. Accept either log as proof the park
  // commit was attempted (the git add/commit still ran).
  const parkAttemptLogged = logs.some((l) =>
    (l.includes("Park commit failed for 'fb-proceed'") ||
      l.includes("No park-commit changes for 'fb-proceed'")) &&
    l.includes('continuing with revert'));
  const parkCommitted = gitLog.includes('Park failed spec fb-proceed');
  assert.ok(
    parkAttemptLogged || parkCommitted,
    `the park commit must be attempted: expected either the best-effort 'Park commit failed ... — continuing with revert.' log or a 'Park failed spec fb-proceed' commit — got git log:\n${gitLog}\nlogs:\n${logs.join('\n')}`,
  );

  assert.ok(entry, "entry 'fb-proceed' must still exist in the queue");
  assert.strictEqual(entry.status, 'failed-execution',
    `entry 'fb-proceed' expected status 'failed-execution', got '${entry.status}'`);
  assert.strictEqual(result.failed, 1, `expected failed:1, got ${result.failed}`);
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
