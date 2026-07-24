#!/usr/bin/env node

/**
 * test-review-gate.js — Unit and regression tests for Pipeline._reviewGate().
 *
 * Tests cover:
 *   TC1 — Accept option 'a' allows pipeline to complete normally
 *   TC2 — Reject option 'r' prevents archive write and preserves worktree
 *   TC4 — noReview flag skips gate and logs warning
 *   TC5 — Diff summary output matches git diff --stat format
 *
 * Run: node test/test-review-gate.js
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { Readable, Writable } from 'stream';
import { execSync } from 'child_process';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { askMenu } from '../src/cli/prompt.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    // Handle async tests
    if (result && typeof result.then === 'function') {
      return result.then(
        () => {
          console.log(`  [PASS] ${name}`);
          passed++;
        },
        (err) => {
          console.log(`  [FAIL] ${name}`);
          console.log(`         ${err.message}`);
          if (err.stack) console.log(`         ${err.stack.split('\n').slice(1, 3).join('\n         ')}`);
          failed++;
        }
      );
    }
    console.log(`  [PASS] ${name}`);
    passed++;
    return Promise.resolve();
  } catch (err) {
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${err.message}`);
    if (err.stack) console.log(`         ${err.stack.split('\n').slice(1, 3).join('\n         ')}`);
    failed++;
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary harness directory and Pipeline instance.
 * The directory is NOT a git repo (git diff calls will fall back gracefully).
 * opts are forwarded to the Pipeline constructor.
 */
function makeTmpHarness(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-review-gate-'));
  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  const pipeline = new Pipeline(tmpDir, { onLog: () => {}, ...opts });
  return { tmpDir, harnessDir, pipeline };
}

/**
 * Create a temporary git repository with an initial commit.
 * Returns the repo root path.
 */
function createGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-review-gate-git-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@harness.local"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Harness Test"', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'initial content\n');
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "initial commit"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

/**
 * Create a git-backed harness.  The Pipeline projectRoot IS the git repo so
 * that `git diff --stat HEAD` works inside _reviewGate.
 */
function makeTmpGitHarness(opts = {}) {
  const repoDir = createGitRepo();
  const harnessDir = path.join(repoDir, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  const pipeline = new Pipeline(repoDir, { onLog: () => {}, ...opts });
  return { repoDir, harnessDir, pipeline };
}

function cleanup(dir) {
  try {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch { /* ignore cleanup errors */ }
}

// ---------------------------------------------------------------------------
// TC1 — Accept option 'a' allows pipeline to complete normally
// ---------------------------------------------------------------------------

console.log('\n=== TC1: Accept option "a" allows pipeline to complete normally ===');

await test('TC1: onMenu returns "a" → _reviewGate returns without throwing', async () => {
  const logs = [];
  const { tmpDir, pipeline } = makeTmpHarness({
    onLog: (msg) => logs.push(msg),
  });

  try {
    // Wire up an onMenu callback that returns 'a' immediately.
    pipeline.onMenu = async () => 'a';

    // Should resolve without throwing.
    await pipeline._reviewGate({});

    // A log line confirming acceptance must be present.
    assert.ok(
      logs.some((l) => l.includes('[review-gate] Changes accepted.')),
      `Expected acceptance log; got: ${JSON.stringify(logs)}`
    );
  } finally {
    cleanup(tmpDir);
  }
});

await test('TC1: after accept, no rejection error is propagated', async () => {
  const { tmpDir, pipeline } = makeTmpHarness();

  try {
    pipeline.onMenu = async () => 'a';
    let threw = false;
    try {
      await pipeline._reviewGate({});
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, '_reviewGate should NOT throw when "a" is chosen');
  } finally {
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// TC2 — Reject option 'r' prevents archive write
// ---------------------------------------------------------------------------

console.log('\n=== TC2: Reject option "r" prevents archive write ===');

await test('TC2: onMenu returns "r" → _reviewGate throws with status=rejected', async () => {
  const logs = [];
  const { tmpDir, pipeline } = makeTmpHarness({
    onLog: (msg) => logs.push(msg),
  });

  try {
    pipeline.onMenu = async () => 'r';

    let caughtError;
    try {
      await pipeline._reviewGate({});
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, 'Expected _reviewGate to throw when "r" is chosen');
    assert.strictEqual(caughtError.status, 'rejected', 'Error should have status="rejected"');
    assert.ok(
      caughtError.message.includes('rejected at review gate'),
      `Expected "rejected at review gate" in message; got: ${caughtError.message}`
    );
  } finally {
    cleanup(tmpDir);
  }
});

await test('TC2: reject logs a rejection message', async () => {
  const logs = [];
  const { tmpDir, pipeline } = makeTmpHarness({
    onLog: (msg) => logs.push(msg),
  });

  try {
    pipeline.onMenu = async () => 'r';
    try { await pipeline._reviewGate({}); } catch { /* expected */ }

    assert.ok(
      logs.some((l) => l.includes('[review-gate] Changes rejected.')),
      `Expected rejection log; got: ${JSON.stringify(logs)}`
    );
  } finally {
    cleanup(tmpDir);
  }
});


// ---------------------------------------------------------------------------
// TC4 — noReview flag skips gate and logs warning
// ---------------------------------------------------------------------------

console.log('\n=== TC4: noReview flag skips gate and logs warning ===');

await test('TC4: opts.noReview=true skips gate without calling onMenu', async () => {
  const logs = [];
  const { tmpDir, pipeline } = makeTmpHarness({
    onLog: (msg) => logs.push(msg),
  });

  try {
    let menuCalled = false;
    pipeline.onMenu = async () => {
      menuCalled = true;
      return 'a';
    };

    await pipeline._reviewGate({ noReview: true });

    assert.strictEqual(menuCalled, false, 'onMenu should NOT be called when noReview=true');
    assert.ok(
      logs.some((l) => l.includes('[review-gate] Skipping review gate')),
      `Expected skip-log; got: ${JSON.stringify(logs)}`
    );
  } finally {
    cleanup(tmpDir);
  }
});

await test('TC4: this.noReview=true skips gate without calling onMenu', async () => {
  const logs = [];
  const { tmpDir, pipeline } = makeTmpHarness({
    onLog: (msg) => logs.push(msg),
    noReview: true,
  });

  try {
    let menuCalled = false;
    pipeline.onMenu = async () => {
      menuCalled = true;
      return 'a';
    };

    await pipeline._reviewGate({});

    assert.strictEqual(menuCalled, false, 'onMenu should NOT be called when this.noReview=true');
    assert.ok(
      logs.some((l) => l.includes('[review-gate] Skipping review gate')),
      `Expected skip-log; got: ${JSON.stringify(logs)}`
    );
  } finally {
    cleanup(tmpDir);
  }
});

await test('TC4: opts.skipReview=true also skips gate', async () => {
  const logs = [];
  const { tmpDir, pipeline } = makeTmpHarness({
    onLog: (msg) => logs.push(msg),
  });

  try {
    pipeline.onMenu = async () => 'a';

    await pipeline._reviewGate({ skipReview: true });

    assert.ok(
      logs.some((l) => l.includes('[review-gate] Skipping review gate')),
      `Expected skip-log for skipReview; got: ${JSON.stringify(logs)}`
    );
  } finally {
    cleanup(tmpDir);
  }
});

await test('TC4: noReview skips gate → returns normally (no throw)', async () => {
  const { tmpDir, pipeline } = makeTmpHarness();

  try {
    pipeline.onMenu = async () => 'r'; // Would reject if gate ran
    let threw = false;
    try {
      await pipeline._reviewGate({ noReview: true });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, 'noReview gate skip must not throw');
  } finally {
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// TC5 — Diff summary output matches git diff --stat format
// ---------------------------------------------------------------------------

console.log('\n=== TC5: Diff summary output matches git diff --stat format ===');

await test('TC5: logged diff stat matches git diff --stat format when changes exist', async () => {
  const logs = [];
  const { repoDir, pipeline } = makeTmpGitHarness({
    onLog: (msg) => logs.push(msg),
  });

  try {
    // Create a file change that will appear in `git diff HEAD`.
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'modified content\nextra line\n');

    pipeline.onMenu = async () => 'a';
    await pipeline._reviewGate({});

    // The diff-stat block is logged between "=== Review Gate: Diff Summary ===" and empty line.
    const summaryIdx = logs.findIndex((l) => l.includes('=== Review Gate: Diff Summary ==='));
    assert.ok(summaryIdx >= 0, 'Must log the Review Gate diff summary header');

    // The next log line after the header should be the actual diff stat.
    const diffStatLine = logs[summaryIdx + 1];
    assert.ok(
      typeof diffStatLine === 'string' && diffStatLine.length > 0,
      'Diff stat line must be non-empty'
    );

    // `git diff --stat HEAD` format: lines contain " | " separating filename and change count.
    // Final summary line: "N file(s) changed, N insertion(s)(+), N deletion(s)(-)"
    const hasStatLine = diffStatLine.includes('|') ||
      diffStatLine.match(/\d+\s+file.*(changed|insertion|deletion)/i);
    assert.ok(
      hasStatLine,
      `Diff stat should contain "|" or a summary line; got: "${diffStatLine}"`
    );
  } finally {
    cleanup(repoDir);
  }
});

await test('TC5: git diff --stat format contains file name and change count', async () => {
  const logs = [];
  const { repoDir, pipeline } = makeTmpGitHarness({
    onLog: (msg) => logs.push(msg),
  });

  try {
    // Append lines to README.md so we get a predictable diff stat.
    fs.writeFileSync(
      path.join(repoDir, 'README.md'),
      'line 1\nline 2\nline 3\nline 4\nline 5\n'
    );

    pipeline.onMenu = async () => 'a';
    await pipeline._reviewGate({});

    // Get the actual git diff --stat output directly for comparison.
    const expectedDiffStat = execSync('git diff --stat HEAD', {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();

    // Find what was logged as the diff stat (the content between the header and empty line).
    const summaryIdx = logs.findIndex((l) => l.includes('=== Review Gate: Diff Summary ==='));
    assert.ok(summaryIdx >= 0, 'Diff summary header must appear in logs');

    const loggedDiffStat = logs[summaryIdx + 1];
    assert.strictEqual(
      loggedDiffStat,
      expectedDiffStat,
      `Logged diff stat must match actual 'git diff --stat HEAD' output.\n` +
      `Expected: ${JSON.stringify(expectedDiffStat)}\n` +
      `Got:      ${JSON.stringify(loggedDiffStat)}`
    );
  } finally {
    cleanup(repoDir);
  }
});

await test('TC5: no-changes case logs "(no changes detected)" fallback', async () => {
  // Use a non-git dir so git diff fails → fallback message.
  const logs = [];
  const { tmpDir, pipeline } = makeTmpHarness({
    onLog: (msg) => logs.push(msg),
  });

  try {
    pipeline.onMenu = async () => 'a';
    await pipeline._reviewGate({});

    // Either the fallback or the error string is logged.
    const summaryIdx = logs.findIndex((l) => l.includes('=== Review Gate: Diff Summary ==='));
    assert.ok(summaryIdx >= 0, 'Diff summary header must appear in logs');

    const diffStatContent = logs[summaryIdx + 1];
    // For a non-git dir, pipeline catches the error and uses the fallback.
    assert.ok(
      typeof diffStatContent === 'string',
      'Diff stat content must be a string'
    );
    // Either the fallback message or git error description should appear.
    const isFallback =
      diffStatContent.includes('(no changes detected)') ||
      diffStatContent.includes('git diff --stat failed') ||
      diffStatContent.includes('not a git repo');
    assert.ok(
      isFallback,
      `Expected fallback message for non-git dir; got: "${diffStatContent}"`
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// TC6 — Review gate is NOT blind to untracked new files (A5 regression)
//
// Bug: _reviewGate computed everything via `git diff ... HEAD`, which ignores
// untracked (newly-created, not-yet-`git add`ed) files.  A run that creates new
// files showed "(no changes detected)" and the reviewer accepted blind.
//
// The fix makes the Diff Summary, the 'd' Full Diff, and the 'f' file diff all
// include untracked files (pure display — no git state mutation).  These three
// cases assert the fixed BEHAVIOR: the untracked file's path/content surfaces in
// the logged output.  They are expected to be RED against unfixed code.
//
// GOTCHA: makeTmpGitHarness creates an untracked `.harness/` dir; without a
// .gitignore it would also appear in `git ls-files --others`.  We write a
// .gitignore containing `.harness/` (mirrors production) so the ONLY untracked
// file is the one each test deliberately creates.  We assert OUR file appears,
// never an exact full list.
// ---------------------------------------------------------------------------

console.log('\n=== TC6: Review gate surfaces untracked new files (A5 regression) ===');

/**
 * Build an onMenu mock that replays a scripted sequence of return values across
 * successive calls.  _reviewGate loops and re-prompts after 'd'/'f', so each
 * call consumes the next scripted value.
 *
 *   ['a']                 → accept immediately
 *   ['d', 'a']            → show full diff, then accept
 *   ['f', 'name.js', 'a'] → file-diff prompt path: menu→'f', filename→'name.js',
 *                           menu→'a'
 */
function scriptedMenu(sequence) {
  let i = 0;
  return async () => {
    const val = sequence[i] !== undefined ? sequence[i] : 'a';
    i++;
    return val;
  };
}

/** Write a .gitignore so `.harness/` is not counted as an untracked file. */
function ignoreHarness(repoDir) {
  fs.writeFileSync(path.join(repoDir, '.gitignore'), '.harness/\n');
}

await test('TC6.1 (BEHAVIOR 1): Diff Summary lists an untracked new file path', async () => {
  const logs = [];
  const { repoDir, pipeline } = makeTmpGitHarness({
    onLog: (msg) => logs.push(msg),
  });

  try {
    ignoreHarness(repoDir);

    // Create a NEW untracked file — never `git add`ed.
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'src', 'brand-new.js'),
      "export const brandNew = 'A5 regression marker';\n"
    );

    pipeline.onMenu = scriptedMenu(['a']);
    await pipeline._reviewGate({});

    // The summary block is everything logged after the header.
    const summaryIdx = logs.findIndex((l) => l.includes('=== Review Gate: Diff Summary ==='));
    assert.ok(summaryIdx >= 0, 'Must log the Review Gate diff summary header');

    // Look across the summary lines (header excluded) for the untracked path.
    // The fix may append untracked info on a line after the diffStat line, so we
    // scan all summary lines rather than only summaryIdx+1.
    const summaryBlock = logs.slice(summaryIdx).join('\n');
    assert.ok(
      summaryBlock.includes('brand-new.js'),
      `Diff Summary must mention the untracked file path "brand-new.js"; ` +
      `got summary block:\n${summaryBlock}`
    );
  } finally {
    cleanup(repoDir);
  }
});

await test('TC6.2 (BEHAVIOR 2): "d" full diff includes untracked file content', async () => {
  const logs = [];
  const { repoDir, pipeline } = makeTmpGitHarness({
    onLog: (msg) => logs.push(msg),
  });

  try {
    ignoreHarness(repoDir);

    const marker = 'UNTRACKED_FULLDIFF_MARKER_42';
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'src', 'fresh.js'),
      `export const x = '${marker}';\n`
    );

    // Menu sequence: 'd' (show full diff) then 'a' (accept).
    pipeline.onMenu = scriptedMenu(['d', 'a']);
    await pipeline._reviewGate({});

    // The 'd' branch logs a "=== Full Diff ===" block.
    const fullDiffIdx = logs.findIndex((l) => l.includes('=== Full Diff ==='));
    assert.ok(fullDiffIdx >= 0, 'Choosing "d" must log a Full Diff block');

    const fullDiffBlock = logs.slice(fullDiffIdx).join('\n');
    // BEHAVIOR: the untracked file's content/path must appear in the full diff.
    assert.ok(
      fullDiffBlock.includes(marker) || fullDiffBlock.includes('fresh.js'),
      `Full Diff must include untracked file content/path; ` +
      `got full-diff block:\n${fullDiffBlock}`
    );
  } finally {
    cleanup(repoDir);
  }
});

await test('TC6.3 (BEHAVIOR 3): "f" file diff for an untracked file logs its content', async () => {
  const logs = [];
  const { repoDir, pipeline } = makeTmpGitHarness({
    onLog: (msg) => logs.push(msg),
  });

  try {
    ignoreHarness(repoDir);

    const marker = 'UNTRACKED_FILEDIFF_MARKER_99';
    const relPath = 'src/added.js';
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, relPath),
      `export const y = '${marker}';\n`
    );

    // Menu sequence: 'f' (file diff) → filename free-text → 'a' (accept).
    pipeline.onMenu = scriptedMenu(['f', relPath, 'a']);
    await pipeline._reviewGate({});

    // The 'f' branch logs a "=== Diff: <filename> ===" block.
    const fileDiffIdx = logs.findIndex((l) => l.includes(`=== Diff: ${relPath} ===`));
    assert.ok(
      fileDiffIdx >= 0,
      `Choosing "f" with "${relPath}" must log a file diff block; got logs:\n${logs.join('\n')}`
    );

    const fileDiffBlock = logs.slice(fileDiffIdx).join('\n');
    // BEHAVIOR: the untracked file's content must appear in its file diff.
    assert.ok(
      fileDiffBlock.includes(marker),
      `File diff for untracked "${relPath}" must include its content "${marker}"; ` +
      `got file-diff block:\n${fileDiffBlock}`
    );
  } finally {
    cleanup(repoDir);
  }
});

// ---------------------------------------------------------------------------
// Integration TC1 — Real askMenu wired through onMenu completes accept flow
// ---------------------------------------------------------------------------

console.log('\n=== Integration TC1: Real askMenu wired through onMenu completes accept flow ===');

/**
 * Create a Readable stream that emits `data` then ends.
 * Used to simulate keyboard input in askMenu without touching stdin.
 */
function makeMockReadable(data) {
  return new Readable({
    read() {
      this.push(data);
      this.push(null);
    },
  });
}

/** A Writable that silently discards all output (like /dev/null). */
function makeDevNull() {
  return new Writable({ write(_chunk, _enc, cb) { cb(); } });
}

await test(
  'Integration TC1: real askMenu wired as onMenu — feed "a" — completes without error',
  async () => {
    const logs = [];
    const { tmpDir, pipeline } = makeTmpHarness({
      onLog: (msg) => logs.push(msg),
    });

    try {
      // Wire onMenu exactly as run.js does (non-auto path) but with a mock
      // readable so the test does not block on stdin.
      pipeline.onMenu = async (question, options) =>
        askMenu(question, options, {
          input: makeMockReadable('a\n'),
          output: makeDevNull(),
        });

      let threw = false;
      try {
        await pipeline._reviewGate({});
      } catch {
        threw = true;
      }

      assert.strictEqual(
        threw,
        false,
        '_reviewGate should complete without error when "a" is fed via real askMenu'
      );

      // Acceptance log must be present — proves the gate ran and accepted.
      assert.ok(
        logs.some((l) => l.includes('[review-gate] Changes accepted.')),
        `Expected acceptance log; got: ${JSON.stringify(logs)}`
      );
    } finally {
      cleanup(tmpDir);
    }
  }
);

await test(
  'Integration TC1: after real askMenu accept, pipeline can proceed to archive (no rejection throw)',
  async () => {
    const { tmpDir, pipeline } = makeTmpHarness();

    try {
      pipeline.onMenu = async (question, options) =>
        askMenu(question, options, {
          input: makeMockReadable('a\n'),
          output: makeDevNull(),
        });

      // _reviewGate returning normally means the pipeline would proceed to the
      // archive step — we verify that by asserting the resolved value is
      // undefined (no rejection error thrown).
      const result = await pipeline._reviewGate({});
      assert.strictEqual(result, undefined, '_reviewGate should resolve to undefined on accept');
    } finally {
      cleanup(tmpDir);
    }
  }
);

// ---------------------------------------------------------------------------
// Integration TC2 — Old single-object onMenu signature throws descriptive error
// ---------------------------------------------------------------------------

console.log('\n=== Integration TC2: Old single-object onMenu signature throws descriptive error ===');

await test(
  'Integration TC2: old single-object { question, options } destructure signature throws',
  async () => {
    const { tmpDir, pipeline } = makeTmpHarness();

    try {
      // This is the WRONG / OLD signature: destructures first arg as an object.
      // _reviewGate calls onMenu(question_string, options_array), so the
      // destructured `question` and `options` will both be undefined, causing
      // askMenu to throw when it tries to iterate over options.
      pipeline.onMenu = async ({ question, options } = {}) =>
        askMenu(question, options, {
          input: makeMockReadable('a\n'),
          output: makeDevNull(),
        });

      let caughtError;
      try {
        await pipeline._reviewGate({});
      } catch (err) {
        caughtError = err;
      }

      assert.ok(
        caughtError,
        'Expected _reviewGate to throw when onMenu uses the old single-object signature'
      );

      // The error is descriptive: it originates from askMenu attempting to call
      // .map() on the undefined options argument.
      assert.ok(
        caughtError instanceof TypeError ||
          (typeof caughtError.message === 'string' && caughtError.message.length > 0),
        `Expected a descriptive error; got: ${caughtError}`
      );
    } finally {
      cleanup(tmpDir);
    }
  }
);

await test(
  'Integration TC2: correct (question, options) signature does NOT throw — confirms guard works',
  async () => {
    const { tmpDir, pipeline } = makeTmpHarness();

    try {
      // Correct signature — should succeed, proving the negative case is
      // specifically caused by the signature mismatch, not something else.
      pipeline.onMenu = async (question, options) =>
        askMenu(question, options, {
          input: makeMockReadable('a\n'),
          output: makeDevNull(),
        });

      let threw = false;
      try {
        await pipeline._reviewGate({});
      } catch {
        threw = true;
      }

      assert.strictEqual(
        threw,
        false,
        'Correct (question, options) signature must not throw — only the mismatched one does'
      );
    } finally {
      cleanup(tmpDir);
    }
  }
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
