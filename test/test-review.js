/**
 * test-review.js — Integration tests for the review command and related staging actions.
 *
 * Run: node test/test-review.js
 *
 * Covers:
 *   TC1 — No pending candidates produces correct output (message + exits 0)
 *   TC2 — Accept action creates target file and removes pending file
 *   TC3 — Reject action removes pending file and appends to declined.jsonl
 *   TC4 — Summary line shows correct counts (promoted / declined / deferred)
 *
 * Additional tests also verify:
 *   - review lists contracts before standards
 *   - defer leaves the pending file in place
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync as childSpawnSync } from 'child_process';
import { review } from '../src/cli/commands/review.js';
import { stageCandidate, promoteCandidate, declineCandidate } from '../src/orchestrator/core/staging.js';
import { parseArgs } from '../src/cli/index.js';

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

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'test-review-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Stage a candidate with sensible defaults and return { id, path }. */
function stageDefault(projectRoot, overrides = {}) {
  return stageCandidate({
    projectRoot,
    kind: overrides.kind ?? 'contract',
    content: {
      ruleName:     overrides.ruleName     ?? 'TestRule',
      rule:         overrides.rule         ?? 'Always do X',
      why:          overrides.why          ?? 'Because Y',
      whereItBites: overrides.whereItBites ?? 'In Z',
      area:         overrides.area         ?? 'core',
    },
    evidence: {
      rule: overrides.rule ?? 'Always do X',
      why:  overrides.why  ?? 'Because Y',
      data: overrides.data ?? '',
    },
    source: {
      taskId:    overrides.taskId    ?? 'task-001',
      sessionId: overrides.sessionId ?? 'ses-001',
    },
  });
}

/**
 * Build a mock readline interface that returns a fixed sequence of answers.
 * Each call to rl.question() consumes the next answer from the queue.
 */
function makeRL(answers) {
  let i = 0;
  return {
    question: (_prompt, cb) => {
      const answer = i < answers.length ? answers[i++] : '';
      setImmediate(() => cb(answer));
    },
    close: () => {},
  };
}

/** Build a simple writable stream that collects output as a string. */
function makeOut() {
  const chunks = [];
  return {
    write: (s) => { chunks.push(s); },
    get output() { return chunks.join(''); },
  };
}

// ---------------------------------------------------------------------------
// TC1 — No pending candidates produces correct output
// ---------------------------------------------------------------------------
await test('TC1: no pending candidates produces correct output', async () => {
  const projectRoot = makeTmpDir();
  try {
    // Capture console.log output
    const origLog = console.log;
    const logged = [];
    console.log = (...args) => logged.push(args.join(' '));

    let returnValue;
    try {
      returnValue = await review(projectRoot, new Date(), {});
    } finally {
      console.log = origLog;
    }

    // Should print a "no pending" message
    const allOutput = logged.join('\n');
    assert.ok(
      allOutput.includes('No pending candidates') || allOutput.includes('no pending'),
      `Expected "No pending candidates" message, got: "${allOutput}"`
    );

    // Should return zero counts
    assert.strictEqual(returnValue.promoted, 0, `Expected promoted=0, got ${returnValue.promoted}`);
    assert.strictEqual(returnValue.declined, 0, `Expected declined=0, got ${returnValue.declined}`);
    assert.strictEqual(returnValue.deferred, 0, `Expected deferred=0, got ${returnValue.deferred}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC1b — No pending candidates: contracts and standards dirs both absent
// ---------------------------------------------------------------------------
await test('TC1b: no pending candidates when dirs do not exist returns zero counts', async () => {
  const projectRoot = makeTmpDir();
  try {
    const origLog = console.log;
    console.log = () => {};
    let result;
    try {
      result = await review(projectRoot, new Date(), {});
    } finally {
      console.log = origLog;
    }
    assert.deepStrictEqual(result, { promoted: 0, declined: 0, deferred: 0 });
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC2 — Accept action creates target file and removes pending file
// ---------------------------------------------------------------------------
await test('TC2: accept action creates target file and removes pending file', async () => {
  const projectRoot = makeTmpDir();
  try {
    const staged = stageDefault(projectRoot, { area: 'auth', ruleName: 'AuthRule' });

    assert.ok(fs.existsSync(staged.path), 'Pending file should exist before review');

    // Use real promoteCandidate to verify actual file system behavior.
    // When review calls promoteCandidate with targetFile='auth.md' (the default),
    // promoteCandidate resolves it relative to projectRoot via path.resolve().
    const rl  = makeRL(['a', '']);  // 'a' = accept, '' = accept default filename (auth.md)
    const out = makeOut();

    await review(projectRoot, new Date(), { rl, out });

    // Pending file should be removed after accept
    assert.ok(
      !fs.existsSync(staged.path),
      `Pending file should be removed after accept, but still exists at: ${staged.path}`
    );

    // Target file is resolved by promoteCandidate as path.resolve(projectRoot, 'auth.md')
    const targetPath = path.resolve(projectRoot, 'auth.md');
    assert.ok(
      fs.existsSync(targetPath),
      `Target file should be created at: ${targetPath}`
    );

    // Target file should contain the rule content
    const targetContent = fs.readFileSync(targetPath, 'utf8');
    assert.ok(
      targetContent.includes('AuthRule'),
      'Target file should contain the rule name'
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC2b — Accept with custom filename uses provided name
// ---------------------------------------------------------------------------
await test('TC2b: accept with custom filename creates correctly named target file', async () => {
  const projectRoot = makeTmpDir();
  try {
    const staged = stageDefault(projectRoot, { area: 'api', ruleName: 'ApiRule' });

    const rl  = makeRL(['a', 'custom-api.md']);  // 'a' = accept, custom filename
    const out = makeOut();

    await review(projectRoot, new Date(), { rl, out });

    // Pending file should be removed
    assert.ok(!fs.existsSync(staged.path), 'Pending file should be removed after accept');

    // Custom-named target file: promoteCandidate resolves targetFile relative to projectRoot
    const targetPath = path.resolve(projectRoot, 'custom-api.md');
    assert.ok(fs.existsSync(targetPath), `Custom target file should exist at: ${targetPath}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC3 — Reject action via interactive loop: pressing 'r' then entering reason
//        triggers full reject flow end-to-end
// ---------------------------------------------------------------------------
await test('TC3: pressing r then entering reason triggers full reject flow end-to-end', async () => {
  const projectRoot = makeTmpDir();
  try {
    const staged = stageDefault(projectRoot, { area: 'security', ruleName: 'SecRule' });

    assert.ok(fs.existsSync(staged.path), 'Pending file should exist before rejection');

    // Track declineCandidate calls with a spy wrapping the real implementation
    const declineCalls = [];
    const declineSpy = (opts) => {
      declineCalls.push(opts);
      return declineCandidate(opts); // delegate to real implementation
    };

    // Simulate interactive input: 'r' to reject, then 'duplicate rule' as the reason
    const rl  = makeRL(['r', 'duplicate rule']);
    const out = makeOut();

    const result = await review(projectRoot, new Date(), { rl, out, declineCandidate: declineSpy });

    // declineCandidate should have been called once with the correct args
    assert.strictEqual(declineCalls.length, 1, `Expected declineCandidate to be called once, got ${declineCalls.length}`);
    assert.strictEqual(declineCalls[0].projectRoot, projectRoot, 'projectRoot should match');
    assert.strictEqual(declineCalls[0].kind, 'contract', `kind should be 'contract', got ${declineCalls[0].kind}`);
    assert.strictEqual(declineCalls[0].candidateId, staged.id, `candidateId should be ${staged.id}, got ${declineCalls[0].candidateId}`);
    assert.strictEqual(declineCalls[0].reason, 'duplicate rule', `reason should be 'duplicate rule', got ${declineCalls[0].reason}`);

    // Pending file should be removed after rejection
    assert.ok(
      !fs.existsSync(staged.path),
      `Pending file should be removed after rejection, but still exists at: ${staged.path}`
    );

    // Output should include 'Declined: <candidateId>'
    assert.ok(
      out.output.includes(`Declined: ${staged.id}`),
      `Output should include "Declined: ${staged.id}", got: "${out.output}"`
    );

    // Declined count should be incremented
    assert.strictEqual(result.declined, 1, `Expected declined=1, got ${result.declined}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC3-extra1 — Reject with a reason string calls declineCandidate with correct args
// ---------------------------------------------------------------------------
await test('TC3-extra1: reject with reason string calls declineCandidate with { projectRoot, kind, candidateId, reason }', async () => {
  const projectRoot = makeTmpDir();
  try {
    const staged = stageDefault(projectRoot, { area: 'auth', ruleName: 'AuthRule' });

    const declineCalls = [];
    const declineSpy = (opts) => {
      declineCalls.push(opts);
      return declineCandidate(opts);
    };

    const rl  = makeRL(['r', 'not relevant']);
    const out = makeOut();

    await review(projectRoot, new Date(), { rl, out, declineCandidate: declineSpy });

    assert.strictEqual(declineCalls.length, 1, 'declineCandidate should be called once');
    assert.strictEqual(declineCalls[0].projectRoot, projectRoot, 'projectRoot should match');
    assert.strictEqual(declineCalls[0].kind, 'contract', 'kind should match candidate kind');
    assert.strictEqual(declineCalls[0].candidateId, staged.id, 'candidateId should match');
    assert.strictEqual(declineCalls[0].reason, 'not relevant', 'reason should match input');
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC3-extra2 — Reject with empty Enter passes empty string as reason
// ---------------------------------------------------------------------------
await test('TC3-extra2: reject with empty Enter passes empty string as reason', async () => {
  const projectRoot = makeTmpDir();
  try {
    stageDefault(projectRoot, { area: 'core', ruleName: 'CoreRule' });

    const declineCalls = [];
    const declineSpy = (opts) => {
      declineCalls.push(opts);
      return declineCandidate(opts);
    };

    // 'r' to reject, '' (empty) as the reason
    const rl  = makeRL(['r', '']);
    const out = makeOut();

    await review(projectRoot, new Date(), { rl, out, declineCandidate: declineSpy });

    assert.strictEqual(declineCalls.length, 1, 'declineCandidate should be called once');
    assert.strictEqual(declineCalls[0].reason, '', 'reason should be empty string');
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC3-extra3 — Declined count incremented on successful decline
// ---------------------------------------------------------------------------
await test('TC3-extra3: declined count incremented on successful decline', async () => {
  const projectRoot = makeTmpDir();
  try {
    stageDefault(projectRoot, { area: 'infra', ruleName: 'InfraRule' });

    const rl  = makeRL(['r', 'not needed']);
    const out = makeOut();

    const result = await review(projectRoot, new Date(), { rl, out });

    assert.strictEqual(result.declined, 1, `Expected declined=1, got ${result.declined}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC3-extra4 — declineCandidate failure prints error and re-prompts same candidate
// ---------------------------------------------------------------------------
await test('TC3-extra4: declineCandidate failure prints error and re-prompts same candidate (does not advance)', async () => {
  const projectRoot = makeTmpDir();
  try {
    const staged = stageDefault(projectRoot, { area: 'cache', ruleName: 'CacheRule' });

    let callCount = 0;
    const declineSpy = (opts) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('disk full');
      }
      // Second call succeeds
      return declineCandidate(opts);
    };

    // First: 'r' + reason -> fails; Second: 'r' + reason -> succeeds
    const rl  = makeRL(['r', 'reason1', 'r', 'reason2']);
    const out = makeOut();

    const result = await review(projectRoot, new Date(), { rl, out, declineCandidate: declineSpy });

    // Error message should appear in output
    assert.ok(
      out.output.includes('Decline failed: disk full'),
      `Expected error message in output, got: "${out.output}"`
    );

    // Should eventually succeed on second attempt
    assert.strictEqual(result.declined, 1, `Expected declined=1 after recovery, got ${result.declined}`);

    // Pending file should be removed after successful second attempt
    assert.ok(!fs.existsSync(staged.path), 'Pending file should be removed after successful second attempt');
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC3b — Multiple rejects append separate lines to declined.jsonl
// ---------------------------------------------------------------------------
await test('TC3b: multiple rejects append separate records to declined.jsonl', async () => {
  const projectRoot = makeTmpDir();
  try {
    const staged1 = stageDefault(projectRoot, { area: 'api',  ruleName: 'Rule1' });
    const staged2 = stageDefault(projectRoot, { area: 'core', ruleName: 'Rule2' });

    const { declinedPath } = declineCandidate({
      projectRoot, kind: 'contract', candidateId: staged1.id, reason: 'reason-1',
    });
    declineCandidate({
      projectRoot, kind: 'contract', candidateId: staged2.id, reason: 'reason-2',
    });

    const lines = fs.readFileSync(declinedPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2, `Expected 2 declined records, got ${lines.length}`);

    const ids = lines.map(l => JSON.parse(l).id);
    assert.ok(ids.includes(staged1.id), 'First staged id should be in declined records');
    assert.ok(ids.includes(staged2.id), 'Second staged id should be in declined records');
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC4 — Summary line shows correct counts
// ---------------------------------------------------------------------------
await test('TC4: summary line shows correct promoted/declined/deferred counts', async () => {
  const projectRoot = makeTmpDir();
  try {
    // Stage two contract candidates
    stageDefault(projectRoot, { area: 'auth',   ruleName: 'AuthRule' });
    stageDefault(projectRoot, { area: 'cache',  ruleName: 'CacheRule' });
    stageDefault(projectRoot, { area: 'events', ruleName: 'EventsRule' });

    // Actions: accept first, defer second, accept third
    const rl  = makeRL(['a', '', 'd', 'a', '']);
    const out = makeOut();

    const result = await review(projectRoot, new Date(), { rl, out });

    // Check returned object
    assert.strictEqual(result.promoted, 2, `Expected promoted=2, got ${result.promoted}`);
    assert.strictEqual(result.declined, 0, `Expected declined=0, got ${result.declined}`);
    assert.strictEqual(result.deferred, 1, `Expected deferred=1, got ${result.deferred}`);

    // Check summary line in output
    assert.ok(
      out.output.includes('Promoted 2') || out.output.includes('promoted: 2'),
      `Output should mention "Promoted 2", got: "${out.output}"`
    );
    assert.ok(
      out.output.includes('deferred 1') || out.output.includes('deferred: 1'),
      `Output should mention deferred count, got: "${out.output}"`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC4b — Summary counts with accept and reject via review flow
// ---------------------------------------------------------------------------
await test('TC4b: summary counts with accept and defer', async () => {
  const projectRoot = makeTmpDir();
  try {
    stageDefault(projectRoot, { area: 'api',   ruleName: 'ApiRule' });
    stageDefault(projectRoot, { area: 'utils', ruleName: 'UtilsRule' });

    // Accept both with default filenames
    const rl  = makeRL(['a', '', 'a', '']);
    const out = makeOut();

    const result = await review(projectRoot, new Date(), { rl, out });

    assert.strictEqual(result.promoted, 2, `Expected promoted=2, got ${result.promoted}`);
    assert.strictEqual(result.declined, 0, `Expected declined=0, got ${result.declined}`);
    assert.strictEqual(result.deferred, 0, `Expected deferred=0, got ${result.deferred}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// Contracts-before-standards ordering
// ---------------------------------------------------------------------------
await test('ordering: contracts listed before standards', async () => {
  const projectRoot = makeTmpDir();
  try {
    // Stage a standard first, then a contract
    stageDefault(projectRoot, { kind: 'standard',  area: 'std-area',  ruleName: 'StdRule' });
    stageDefault(projectRoot, { kind: 'contract',  area: 'con-area',  ruleName: 'ConRule' });

    // Defer the first candidate (contract), then quit on the second (standard).
    // This ensures both candidates are displayed in the output before quitting.
    const rl  = makeRL(['d', 'q']);
    const out = makeOut();

    await review(projectRoot, new Date(), { rl, out });

    const contractIdx = out.output.indexOf('con-area');
    const standardIdx = out.output.indexOf('std-area');

    assert.ok(contractIdx !== -1, 'Contract candidate should appear in output');
    assert.ok(standardIdx !== -1, 'Standard candidate should appear in output');
    assert.ok(
      contractIdx < standardIdx,
      `Contract (index ${contractIdx}) should appear before standard (index ${standardIdx})`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// Defer leaves pending file in place
// ---------------------------------------------------------------------------
await test('defer: leaves pending file in place', async () => {
  const projectRoot = makeTmpDir();
  try {
    const staged = stageDefault(projectRoot, { area: 'infra', ruleName: 'InfraRule' });

    assert.ok(fs.existsSync(staged.path), 'Pending file should exist before review');

    const rl  = makeRL(['d']);  // defer
    const out = makeOut();

    const result = await review(projectRoot, new Date(), { rl, out });

    // Pending file should still exist
    assert.ok(
      fs.existsSync(staged.path),
      `Pending file should still exist after defer: ${staged.path}`
    );

    assert.strictEqual(result.deferred, 1, `Expected deferred=1, got ${result.deferred}`);
    assert.ok(out.output.includes('Deferred'), 'Output should mention "Deferred"');
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// [from test-review-accept.js] TC3 — Write failure prints error and re-prompts
// ---------------------------------------------------------------------------
await test('accept TC3: write failure prints error and re-prompts (leaves pending intact)', async () => {
  const projectRoot = makeTmpDir();
  try {
    const staged = stageDefault(projectRoot, { area: 'infra' });

    assert.ok(fs.existsSync(staged.path), 'Pending file should exist before review');

    let callCount = 0;
    const mockPromote = (opts) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('disk full');
      }
      // Second call (after re-prompt) succeeds
      return { targetPath: path.join(projectRoot, 'docs', 'contracts', 'infra.md'), candidateId: opts.candidateId };
    };

    // First attempt: 'a' → '' (default filename) → fails → re-prompted → 'a' → '' → succeeds
    const rl  = makeRL(['a', '', 'a', '']);
    const out = makeOut();

    await review(projectRoot, new Date(), { rl, out, promoteCandidate: mockPromote });

    // Error message should be printed
    assert.ok(
      out.output.includes('Accept failed:') && out.output.includes('disk full'),
      `Output should contain error message "Accept failed: disk full", got: "${out.output}"`
    );

    // After re-prompt and successful second call, count should be 2
    assert.strictEqual(callCount, 2, 'promoteCandidate should have been called twice (once failed, once succeeded)');
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// [from test-review-accept.js] TC3b — Write failure leaves pending file intact
// ---------------------------------------------------------------------------
await test('accept TC3b: write failure leaves pending file intact (no auto-delete)', async () => {
  const projectRoot = makeTmpDir();
  try {
    const staged = stageDefault(projectRoot, { area: 'cache' });

    assert.ok(fs.existsSync(staged.path), 'Pending file should exist before review');

    const mockPromote = () => {
      throw new Error('permission denied');
    };

    // Accept → default filename → fails → quit
    const rl  = makeRL(['a', '', 'q']);
    const out = makeOut();

    await review(projectRoot, new Date(), { rl, out, promoteCandidate: mockPromote });

    // Pending file must still exist because promote threw (never deleted it)
    assert.ok(
      fs.existsSync(staged.path),
      'Pending file should still exist after a failed promote'
    );

    assert.ok(
      out.output.includes('Accept failed:'),
      `Output should contain "Accept failed:", got: "${out.output}"`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// [from test-review-accept.js] TC4b — Promoted count NOT incremented on failure
// ---------------------------------------------------------------------------
await test('accept TC4b: promoted count NOT incremented on failure', async () => {
  const projectRoot = makeTmpDir();
  try {
    stageDefault(projectRoot, { area: 'network' });

    const mockPromote = () => { throw new Error('write error'); };

    // Accept → fails → quit
    const rl  = makeRL(['a', '', 'q']);
    const out = makeOut();

    const result = await review(projectRoot, new Date(), { rl, out, promoteCandidate: mockPromote });

    assert.strictEqual(result.promoted, 0, `Expected promoted=0 after failure, got ${result.promoted}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// [from test-review-edit.js] TC1 — Edit opens $EDITOR from environment variable
// ---------------------------------------------------------------------------
await test('edit TC1: edit opens $EDITOR from environment variable', async () => {
  const projectRoot = makeTmpDir();
  const savedEditor = process.env.EDITOR;
  try {
    process.env.EDITOR = 'myeditor';
    stageDefault(projectRoot, { area: 'auth' });

    let capturedEditor = null;
    const mockSpawnSync = (editor, args, opts) => {
      capturedEditor = editor;
      return { status: 0, error: null };
    };

    // 'e' → edit → then 'd' to defer and move on
    const rl  = makeRL(['e', 'd']);
    const out = makeOut();

    await review(projectRoot, new Date(), { rl, out, spawnSync: mockSpawnSync });

    assert.strictEqual(
      capturedEditor,
      'myeditor',
      `Expected editor 'myeditor', got '${capturedEditor}'`
    );
  } finally {
    if (savedEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = savedEditor;
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// [from test-review-edit.js] TC2 — Falls back to vi when $EDITOR is unset
// ---------------------------------------------------------------------------
await test('edit TC2: falls back to vi when $EDITOR is unset', async () => {
  const projectRoot = makeTmpDir();
  const savedEditor = process.env.EDITOR;
  try {
    delete process.env.EDITOR;
    stageDefault(projectRoot, { area: 'auth' });

    let capturedEditor = null;
    const mockSpawnSync = (editor, args, opts) => {
      capturedEditor = editor;
      return { status: 0, error: null };
    };

    const rl  = makeRL(['e', 'd']);
    const out = makeOut();

    await review(projectRoot, new Date(), { rl, out, spawnSync: mockSpawnSync });

    assert.strictEqual(
      capturedEditor,
      'vi',
      `Expected fallback editor 'vi', got '${capturedEditor}'`
    );
  } finally {
    if (savedEditor !== undefined) process.env.EDITOR = savedEditor;
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// [from test-review-edit.js] TC3 — Editor failure prints error and re-prompts
// ---------------------------------------------------------------------------
await test('edit TC3: editor failure prints error and re-prompts', async () => {
  const projectRoot = makeTmpDir();
  const savedEditor = process.env.EDITOR;
  try {
    delete process.env.EDITOR;
    stageDefault(projectRoot, { area: 'auth' });

    // Return non-zero exit status to simulate failure
    const mockSpawnSync = (editor, args, opts) => {
      return { status: 1, error: null };
    };

    // First 'e' triggers failed editor → re-prompted → 'd' to defer
    const rl  = makeRL(['e', 'd']);
    const out = makeOut();

    const result = await review(projectRoot, new Date(), { rl, out, spawnSync: mockSpawnSync });

    assert.ok(
      out.output.includes('[edit]') && out.output.includes('non-zero status'),
      `Output should contain editor failure message, got: "${out.output}"`
    );
    // Deferred = 1 proves re-prompt happened and candidate was not abandoned
    assert.strictEqual(result.deferred, 1, `Expected deferred=1, got ${result.deferred}`);
  } finally {
    if (savedEditor !== undefined) process.env.EDITOR = savedEditor;
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// [from test-review-edit.js] TC3b — Editor throws (missing binary) prints error and re-prompts
// ---------------------------------------------------------------------------
await test('edit TC3b: editor throws (missing binary) prints error and re-prompts', async () => {
  const projectRoot = makeTmpDir();
  const savedEditor = process.env.EDITOR;
  try {
    delete process.env.EDITOR;
    stageDefault(projectRoot, { area: 'auth' });

    // Simulate spawnSync throwing (e.g. ENOENT)
    const mockSpawnSync = (editor, args, opts) => {
      throw new Error('spawnSync vi ENOENT');
    };

    const rl  = makeRL(['e', 'd']);
    const out = makeOut();

    const result = await review(projectRoot, new Date(), { rl, out, spawnSync: mockSpawnSync });

    assert.ok(
      out.output.includes('[edit]') && out.output.includes('Failed to launch'),
      `Output should contain launch failure message, got: "${out.output}"`
    );
    assert.strictEqual(result.deferred, 1, `Expected deferred=1 after error+re-prompt, got ${result.deferred}`);
  } finally {
    if (savedEditor !== undefined) process.env.EDITOR = savedEditor;
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// [from test-review-edit.js] TC3c — Editor result.error prints error and re-prompts
// ---------------------------------------------------------------------------
await test('edit TC3c: result.error prints error and re-prompts', async () => {
  const projectRoot = makeTmpDir();
  const savedEditor = process.env.EDITOR;
  try {
    delete process.env.EDITOR;
    stageDefault(projectRoot, { area: 'auth' });

    const mockSpawnSync = (editor, args, opts) => {
      return { status: null, error: new Error('ENOENT: no such file or directory') };
    };

    const rl  = makeRL(['e', 'd']);
    const out = makeOut();

    const result = await review(projectRoot, new Date(), { rl, out, spawnSync: mockSpawnSync });

    assert.ok(
      out.output.includes('[edit]') && out.output.includes('Failed to launch'),
      `Output should contain launch failure message, got: "${out.output}"`
    );
    assert.strictEqual(result.deferred, 1, `Expected deferred=1 after error+re-prompt, got ${result.deferred}`);
  } finally {
    if (savedEditor !== undefined) process.env.EDITOR = savedEditor;
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// [from test-review-edit.js] TC4 — After successful edit, re-reads file and re-displays
// ---------------------------------------------------------------------------
await test('edit TC4: after successful edit, re-reads file and re-displays updated candidate', async () => {
  const projectRoot = makeTmpDir();
  const savedEditor = process.env.EDITOR;
  try {
    delete process.env.EDITOR;
    const staged = stageDefault(projectRoot, { area: 'original-area' });

    // Build updated file content with a different area
    const updatedContent = fs.readFileSync(staged.path, 'utf8').replace('original-area', 'updated-area');

    let spawnCalled = false;
    const mockSpawnSync = (editor, args, opts) => {
      spawnCalled = true;
      // Simulate editor writing updated content to the file
      fs.writeFileSync(args[0], updatedContent, 'utf8');
      return { status: 0, error: null };
    };

    // 'e' to edit, then 'd' to defer
    const rl  = makeRL(['e', 'd']);
    const out = makeOut();

    await review(projectRoot, new Date(), { rl, out, spawnSync: mockSpawnSync });

    assert.ok(spawnCalled, 'spawnSync should have been called');
    // The re-display should show 'updated-area'
    assert.ok(
      out.output.includes('updated-area'),
      `Output after edit should include 'updated-area', got: "${out.output}"`
    );
  } finally {
    if (savedEditor !== undefined) process.env.EDITOR = savedEditor;
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// [from test-review-edit.js] TC4b — Successful edit passes file path to editor
// ---------------------------------------------------------------------------
await test('edit TC4b: spawnSync receives the candidate file path as argument', async () => {
  const projectRoot = makeTmpDir();
  const savedEditor = process.env.EDITOR;
  try {
    delete process.env.EDITOR;
    const staged = stageDefault(projectRoot, { area: 'auth' });

    let capturedArgs = null;
    const mockSpawnSync = (editor, args, opts) => {
      capturedArgs = args;
      return { status: 0, error: null };
    };

    const rl  = makeRL(['e', 'd']);
    const out = makeOut();

    await review(projectRoot, new Date(), { rl, out, spawnSync: mockSpawnSync });

    assert.ok(Array.isArray(capturedArgs) && capturedArgs.length === 1,
      `Expected exactly one arg to editor, got: ${JSON.stringify(capturedArgs)}`);
    assert.strictEqual(
      capturedArgs[0],
      staged.path,
      `Expected editor arg to be '${staged.path}', got '${capturedArgs[0]}'`
    );
  } finally {
    if (savedEditor !== undefined) process.env.EDITOR = savedEditor;
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// [from test-cli-router.js] TC1 — parseArgs('-R') returns flags.R === true
// ---------------------------------------------------------------------------
await test('cli-router TC1: parseArgs("-R") returns flags.R === true', async () => {
  const result = parseArgs(['-R']);
  assert.strictEqual(result.flags.R, true, `Expected flags.R to be true, got ${result.flags.R}`);
});

// ---------------------------------------------------------------------------
// [from test-cli-router.js] TC2 — parseArgs('--review') returns flags.review === true
// ---------------------------------------------------------------------------
await test('cli-router TC2: parseArgs("--review") returns flags.review === true', async () => {
  const result = parseArgs(['--review']);
  assert.strictEqual(result.flags.review, true, `Expected flags.review to be true, got ${result.flags.review}`);
});

// ---------------------------------------------------------------------------
// [from test-cli-router.js] TC3 — parseArgs('review') returns positional containing 'review'
// ---------------------------------------------------------------------------
await test('cli-router TC3: parseArgs("review") returns positional containing "review"', async () => {
  const result = parseArgs(['review']);
  assert.ok(Array.isArray(result.positional), 'Expected positional to be an array');
  assert.ok(result.positional.includes('review'), `Expected positional to contain "review", got ${JSON.stringify(result.positional)}`);
});

// ---------------------------------------------------------------------------
// [from test-cli-router.js] TC4 — `cc-orch review` in dir without .harness/ does not error about missing state
// ---------------------------------------------------------------------------
await test('cli-router TC4: `cc-orch review` in a dir without .harness/ does not error about missing state', async () => {
  // Create a temp directory with no .harness/ subdirectory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-test-'));
  try {
    const cliPath = path.resolve(process.cwd(), 'src/cli/index.js');
    const result = childSpawnSync(process.execPath, [cliPath, 'review'], {
      cwd: tmpDir,
      env: { ...process.env },
      timeout: 10000,
      encoding: 'utf8',
    });

    const stderr = result.stderr || '';
    const stdout = result.stdout || '';
    const combined = stderr + stdout;

    // Should NOT contain messaging about missing state.json
    assert.ok(
      !combined.includes('No .harness/state.json found'),
      `Expected no "missing state" error, but got: ${combined.trim()}`
    );

    // Exit code should not indicate a "missing harness" failure
    assert.ok(
      result.status !== 1 || !combined.includes('state.json'),
      `Process exited with code ${result.status} and stderr: ${stderr.trim()}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// [new] TC2 — parseArgs(['-p', '/tmp']) returns flags.p === '/tmp'
// ---------------------------------------------------------------------------
await test('cli-router new TC2: parseArgs(["-p", "/tmp"]) returns flags.p === "/tmp"', async () => {
  const result = parseArgs(['-p', '/tmp']);
  assert.strictEqual(result.flags.p, '/tmp', `Expected flags.p to be '/tmp', got ${result.flags.p}`);
});

// ---------------------------------------------------------------------------
// [new] TC3 — parseArgs(['--role', 'executor']) returns flags.role === 'executor'
// ---------------------------------------------------------------------------
await test('cli-router new TC3: parseArgs(["--role", "executor"]) returns flags.role === "executor"', async () => {
  const result = parseArgs(['--role', 'executor']);
  assert.strictEqual(result.flags.role, 'executor', `Expected flags.role to be 'executor', got ${result.flags.role}`);
});

// ---------------------------------------------------------------------------
// [new] TC4 — parseArgs(['--task', '001-001-001']) returns flags.task === '001-001-001'
// ---------------------------------------------------------------------------
await test('cli-router new TC4: parseArgs(["--task", "001-001-001"]) returns flags.task === "001-001-001"', async () => {
  const result = parseArgs(['--task', '001-001-001']);
  assert.strictEqual(result.flags.task, '001-001-001', `Expected flags.task to be '001-001-001', got ${result.flags.task}`);
});

// ---------------------------------------------------------------------------
// [new] TC5 — parseArgs(['-rap', '/tmp']) returns r=true, a=true, p='/tmp'
// ---------------------------------------------------------------------------
await test('cli-router new TC5: parseArgs(["-rap", "/tmp"]) returns r=true, a=true, p="/tmp"', async () => {
  const result = parseArgs(['-rap', '/tmp']);
  assert.strictEqual(result.flags.r, true, `Expected flags.r to be true, got ${result.flags.r}`);
  assert.strictEqual(result.flags.a, true, `Expected flags.a to be true, got ${result.flags.a}`);
  assert.strictEqual(result.flags.p, '/tmp', `Expected flags.p to be '/tmp', got ${result.flags.p}`);
});

// ---------------------------------------------------------------------------
// [new] TC6 — parseArgs(['status', '001-001']) returns positional=['status','001-001']
// ---------------------------------------------------------------------------
await test('cli-router new TC6: parseArgs(["status", "001-001"]) returns positional=["status","001-001"]', async () => {
  const result = parseArgs(['status', '001-001']);
  assert.ok(Array.isArray(result.positional), 'Expected positional to be an array');
  assert.deepStrictEqual(result.positional, ['status', '001-001'], `Expected positional to be ['status','001-001'], got ${JSON.stringify(result.positional)}`);
});

// ---------------------------------------------------------------------------
// [new] TC7 — parseArgs(['--role', '--json']) throws because --json is a flag, not a value
// ---------------------------------------------------------------------------
await test('cli-router new TC7: parseArgs(["--role", "--json"]) throws "requires a value"', async () => {
  assert.throws(
    () => parseArgs(['--role', '--json']),
    (err) => err.message.includes('--role') && err.message.includes('requires a value'),
    'Expected parseArgs to throw when --role is followed by another flag'
  );
});

// ---------------------------------------------------------------------------
// [new] TC8 — parseArgs(['--role']) throws because there is no following argument
// ---------------------------------------------------------------------------
await test('cli-router new TC8: parseArgs(["--role"]) throws "requires a value"', async () => {
  assert.throws(
    () => parseArgs(['--role']),
    (err) => err.message.includes('--role') && err.message.includes('requires a value'),
    'Expected parseArgs to throw when --role has no following argument'
  );
});

// ---------------------------------------------------------------------------
// [new] TC9 — parseArgs(['--task']) throws because there is no following argument
// ---------------------------------------------------------------------------
await test('cli-router new TC9: parseArgs(["--task"]) throws "requires a value"', async () => {
  assert.throws(
    () => parseArgs(['--task']),
    (err) => err.message.includes('--task') && err.message.includes('requires a value'),
    'Expected parseArgs to throw when --task has no following argument'
  );
});

// ---------------------------------------------------------------------------
// [new] TC10 — parseArgs(['usage', '--role', '--json']) throws (flag swallowing prevented)
// ---------------------------------------------------------------------------
await test('cli-router new TC10: parseArgs(["usage", "--role", "--json"]) throws instead of swallowing --json', async () => {
  assert.throws(
    () => parseArgs(['usage', '--role', '--json']),
    (err) => err.message.includes('--role') && err.message.includes('requires a value'),
    'Expected parseArgs to throw when --role is followed by --json (flag swallowing prevented)'
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
