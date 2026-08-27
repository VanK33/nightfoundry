/**
 * test-readonly-deletion-guard.js — Pins the opt-in `denyFileRemovalBash`
 * spawn-level guard (session-manager.js, `FILE_REMOVAL_BASH_PATTERNS`) that
 * blocks read-only judging roles (verifier, reviewer, analyzer) from
 * shelling out to any file-deletion primitive, PLUS the snapshot/audit
 * round-trip (read-only-audit.js, `captureTrackedSnapshot` /
 * `auditTrackedDeletions`) that detects and restores tracked files which
 * vanished from disk during a session despite the spawn-level guard above.
 *
 * The pattern list is a CLOSED set (see the doc comment above
 * `FILE_REMOVAL_BASH_PATTERNS` in src/orchestrator/infra/session-manager.js):
 *   - `rm`                                      — shell removal command
 *   - `fs.rm` / `fs.promises.rm`                 — recursive/force remover
 *   - `fs.rmSync` / `fs.promises.rmSync`         — recursive/force remover (sync)
 *   - `fs.rmdir` / `fs.promises.rmdir`           — directory remover
 *   - `fs.rmdirSync` / `fs.promises.rmdirSync`   — directory remover (sync)
 *   - `fs.unlink` / `fs.promises.unlink`         — file remover
 *   - `fs.unlinkSync` / `fs.promises.unlinkSync` — file remover (sync)
 *   - `rimraf`                                   — recursive-delete npm package
 *   - `shutil.rmtree`                            — Python recursive tree deleter
 *   - `os.remove`                                — Python os-module file deleter
 *   - `os.unlink`                                — Python os-module symlink deleter
 *   - `os.rmdir`                                 — Python os-module directory deleter
 *
 * TC1: every fixture above is DENIED (behavior 'deny', message matching
 *      /removal is not available/i) when `_buildSdkOptions` is built WITH
 *      `denyFileRemovalBash: true`.
 * TC2: the same fixtures are NOT denied when the flag is omitted.
 * TC3: benign commands (directory listing, a content search whose pattern
 *      text embeds a removal-looking stem inside a longer identifier, and
 *      the whole-suite npm script invocation) stay NOT denied under the flag.
 * TC4: a tracked file removed from disk between capture and audit is
 *      restored to its committed HEAD content.
 * TC5: nothing removed between capture and audit — restored/reportOnly are
 *      both empty.
 * TC6: the vanished path is declared in a non-terminal mission's
 *      targetFiles — reported (reportOnly), never restored.
 * TC7: capture + audit against a non-git tmp root is a no-op and never
 *      throws.
 * TC8: auditTrackedDeletions given an `ok: false` snapshot is a no-op and
 *      never invokes the caller's callback.
 * TC9: a throwing onLog callback, and a non-function onLog value, never
 *      propagate out of auditTrackedDeletions.
 * TC10-TC12: role-wiring order — verifier (TC10), reviewer (TC11), and
 *      analyzer (TC12) are each driven with a stubbed sessionManager whose
 *      spawn() pushes a 'spawn' marker onto a shared ordered events array,
 *      while node:test's `mock.module()` intercepts read-only-audit.js's
 *      captureTrackedSnapshot / auditTrackedDeletions entry points so THEY
 *      push their own 'capture' / 'audit' markers. Each case asserts exactly
 *      one capture marker (ordered before the FIRST spawn marker) and
 *      exactly one audit marker (ordered after the LAST spawn marker) — so a
 *      role that spawns twice (verifier escalation, reviewer retry) still
 *      captures once before the first spawn and audits once after the last —
 *      plus that a message emitted through the callback the role supplies to
 *      the audit reaches that role's logger.warn spy.
 * TC13: the shared audit-handling path (analyzer.js's `analyzeFailure`,
 *      whose read-only-audit wiring already computes a per-session-unique
 *      `${opts.taskId}:${eventId}` identifier) is driven with a stubbed
 *      read-only-audit report that is NON-EMPTY and carries both a restored
 *      path and a report-only path — exactly one new warnings-ledger entry
 *      is appended under the tmp project root, and reading it back yields
 *      text naming the role, the task identifier, and both paths.
 * TC14: two incidents in one session (differing task identifiers) each
 *      append a distinct ledger entry — the ledger's content-hash dedup,
 *      which would otherwise collapse identical-looking incidents, is
 *      defeated by the per-incident-unique identifier, so reading the
 *      ledger back yields 2 entries.
 * TC15: an EMPTY audit report (nothing deleted/restored/report-only/failed)
 *      appends no entry — the ledger's entry count read back after the call
 *      equals the count read back before it.
 *
 * Run: node test/test-readonly-deletion-guard.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { mock } from 'node:test';
import { SessionManager } from '../src/orchestrator/infra/session-manager.js';
import { captureTrackedSnapshot, auditTrackedDeletions } from '../src/orchestrator/infra/read-only-audit.js';
import { readLedger } from '../src/orchestrator/core/warnings-ledger.js';

// TC10-TC12 (below) need node:test's `mock.module()` to intercept the
// read-only-audit.js entry points imported by verifier.js / reviewer.js /
// analyzer.js — a Node-native ESM interception mechanism gated behind the
// --experimental-test-module-mocks CLI flag. This file's documented entry
// point (`node test/test-readonly-deletion-guard.js`, also how
// scripts/run-tests.js's runner invokes it) carries no such flag, so —
// self-relaunch EXACTLY ONCE with the flag added, inheriting stdio and
// mirroring the child's exit code. TC1-TC9 above run unmodified either way;
// this only widens which flags the ONE node invocation that actually runs
// the suite carries.
if (!process.execArgv.includes('--experimental-test-module-mocks') && !process.env.CC_ORCH_RODG_RELAUNCHED) {
  const relaunch = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', fileURLToPath(import.meta.url)],
    { stdio: 'inherit', env: { ...process.env, CC_ORCH_RODG_RELAUNCHED: '1' } }
  );
  process.exit(relaunch.status === null || relaunch.status === undefined ? 1 : relaunch.status);
}

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

// ── Fixtures — one (or more) command per family of the closed pattern list ─
const REMOVAL_FIXTURES = [
  // shell removal command (bare/single-file forms only — `-r`/`-rf`/glob
  // forms are already caught by the always-on global dangerous-pattern
  // guard regardless of this flag, so they wouldn't distinguish TC1 from
  // TC2; see the denyFileRemovalBash doc comment in session-manager.js).
  'rm notes.txt',
  'cd tmp && rm file',
  // node fs — single-file / recursive removal, bare + fs.promises, incl. sync
  'node -e "fs.rm(\'dist\', {recursive:true}, cb)"',
  'node -e "fs.promises.rm(\'dist\', {recursive:true})"',
  'node -e "fs.rmSync(\'dist\', {recursive:true})"',
  'node -e "fs.promises.rmSync(\'dist\')"',
  'node -e "fs.rmdir(\'empty-dir\', cb)"',
  'node -e "fs.promises.rmdir(\'empty-dir\')"',
  'node -e "fs.rmdirSync(\'empty-dir\')"',
  'node -e "fs.promises.rmdirSync(\'empty-dir\')"',
  'node -e "fs.unlink(\'stray.txt\', cb)"',
  'node -e "fs.promises.unlink(\'stray.txt\')"',
  'node -e "fs.unlinkSync(\'stray.txt\')"',
  'node -e "fs.promises.unlinkSync(\'stray.txt\')"',
  // standalone recursive-delete npm CLI
  'rimraf dist',
  'npx rimraf ./coverage',
  // python tree/file/dir removal helpers
  'python3 -c "import shutil; shutil.rmtree(\'build\')"',
  'python3 -c "import os; os.remove(\'stray.txt\')"',
  'python3 -c "import os; os.unlink(\'stray.txt\')"',
  'python3 -c "import os; os.rmdir(\'empty-dir\')"',
];

// ── TC1: every fixture is DENIED with the flag set ─────────────────────────
await test('TC1: denyFileRemovalBash denies every closed-list removal fixture', () => {
  const sm = new SessionManager();
  const withFlag = sm._buildSdkOptions({ denyFileRemovalBash: true });
  for (const cmd of REMOVAL_FIXTURES) {
    const result = withFlag.canUseTool('Bash', { command: cmd });
    assert.strictEqual(result?.behavior, 'deny', `Expected DENY with flag for: ${cmd}`);
    assert.ok(
      /removal is not available/i.test(result.message),
      `Expected deny message to match /removal is not available/i for: ${cmd}; got: ${result.message}`,
    );
  }
});

// ── TC2: the same fixtures are NOT denied without the flag ────────────────
await test('TC2: without denyFileRemovalBash, the same fixtures are not denied', () => {
  const sm = new SessionManager();
  const withoutFlag = sm._buildSdkOptions({});
  for (const cmd of REMOVAL_FIXTURES) {
    const result = withoutFlag.canUseTool('Bash', { command: cmd });
    assert.notStrictEqual(result?.behavior, 'deny', `Expected non-deny without flag for: ${cmd}`);
  }
});

// ── TC3: benign commands stay allowed under the flag ───────────────────────
await test('TC3: benign commands (listing, embedded-stem search, whole-suite npm) are not denied under the flag', () => {
  const sm = new SessionManager();
  const withFlag = sm._buildSdkOptions({ denyFileRemovalBash: true });
  const benign = [
    // plain directory listing
    'ls -la src/',
    // content search whose pattern text embeds a removal-looking two-letter
    // stem ("rm") inside a longer word/filename — must never match \brm\b
    // (or any of the fs./os./shutil.-qualified variants).
    'grep -rn "confirm" src/form/x.js',
    // whole-suite npm script invocation
    'npm test',
  ];
  for (const cmd of benign) {
    const result = withFlag.canUseTool('Bash', { command: cmd });
    assert.notStrictEqual(result?.behavior, 'deny', `Expected non-deny under flag for benign command: ${cmd}`);
  }
});

// ── Fixtures/helpers for the snapshot/audit round-trip (TC4-TC9) ──────────
function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Scratch git repo idiom shared with test-git-safety-precheck.js: mkdtemp +
// execSync git init, plus a local commit identity (a bare `git init` sandbox
// has no global user.name/user.email guaranteed, and `git commit` fails
// without one).
function initScratchGitRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function commitTrackedFile(dir, relPath, content) {
  const filePath = path.join(dir, relPath);
  fs.writeFileSync(filePath, content);
  execSync(`git add ${relPath}`, { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "add tracked file"', { cwd: dir, stdio: 'pipe' });
  return filePath;
}

// TC4: a tracked file removed from disk between capture and audit is
// restored to its committed HEAD content, and named in the report's
// restored list by its repo-relative path.
await test('TC4: tracked file removed between capture and audit is restored to committed HEAD content', () => {
  const dir = initScratchGitRepo('readonly-audit-tc4-');
  try {
    const committedContent = 'committed content\n';
    const filePath = commitTrackedFile(dir, 'tracked.txt', committedContent);

    const snapshot = captureTrackedSnapshot(dir);
    assert.strictEqual(snapshot.ok, true, `expected ok:true, got: ${JSON.stringify(snapshot)}`);

    fs.rmSync(filePath);
    assert.strictEqual(fs.existsSync(filePath), false, 'fixture setup: file should be gone before the audit');

    const report = auditTrackedDeletions(dir, snapshot, {});
    assert.ok(
      report.restored.some((r) => r.path === 'tracked.txt'),
      `expected restored to include tracked.txt, got: ${JSON.stringify(report.restored)}`
    );
    assert.strictEqual(
      fs.readFileSync(filePath, 'utf8'),
      committedContent,
      'restored file content should match committed HEAD bytes'
    );
  } finally {
    cleanupDir(dir);
  }
});

// TC5: nothing removed between capture and audit — restored and reportOnly
// are both empty.
await test('TC5: no file removed between capture and audit leaves restored and reportOnly empty', () => {
  const dir = initScratchGitRepo('readonly-audit-tc5-');
  try {
    commitTrackedFile(dir, 'tracked.txt', 'content\n');

    const snapshot = captureTrackedSnapshot(dir);
    assert.strictEqual(snapshot.ok, true, `expected ok:true, got: ${JSON.stringify(snapshot)}`);

    const report = auditTrackedDeletions(dir, snapshot, {});
    assert.strictEqual(report.restored.length, 0, `expected empty restored, got: ${JSON.stringify(report.restored)}`);
    assert.strictEqual(report.reportOnly.length, 0, `expected empty reportOnly, got: ${JSON.stringify(report.reportOnly)}`);
  } finally {
    cleanupDir(dir);
  }
});

// TC6: the vanished path is declared in a non-terminal mission's
// targetFiles (read from <harnessDir>/state/mission-<id>.json) — it is
// reported only, never restored back to disk.
await test('TC6: vanished path declared in a non-terminal mission targetFiles is report-only, not restored', () => {
  const dir = initScratchGitRepo('readonly-audit-tc6-');
  try {
    const filePath = commitTrackedFile(dir, 'tracked.txt', 'content\n');

    const snapshot = captureTrackedSnapshot(dir);
    assert.strictEqual(snapshot.ok, true, `expected ok:true, got: ${JSON.stringify(snapshot)}`);

    fs.rmSync(filePath);

    const harnessDir = path.join(dir, '.harness');
    const stateDir = path.join(harnessDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(harnessDir, 'state.json'),
      JSON.stringify({
        milestones: {
          '001': {
            missions: {
              '001-001': { id: '001-001', description: 'mission', status: 'pending' },
            },
          },
        },
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(stateDir, 'mission-001-001.json'),
      JSON.stringify({
        id: '001-001',
        missionId: '001-001',
        description: 'mission',
        status: 'pending',
        subMissions: {
          'sm-001': {
            id: 'sm-001',
            description: 'sub-mission',
            status: 'pending',
            tasks: {
              'task-001': {
                id: 'task-001',
                description: 'task',
                status: 'pending',
                targetFiles: ['tracked.txt'],
                dependencies: [],
                testCases: [],
              },
            },
          },
        },
      }),
      'utf8'
    );

    const report = auditTrackedDeletions(dir, snapshot, {});
    assert.ok(
      report.reportOnly.includes('tracked.txt'),
      `expected reportOnly to include tracked.txt, got: ${JSON.stringify(report.reportOnly)}`
    );
    assert.strictEqual(fs.existsSync(filePath), false, 'file must remain absent — reportOnly paths are never restored');
  } finally {
    cleanupDir(dir);
  }
});

// TC7: capture + audit against a non-git tmp root is a no-op — an empty
// report is returned and nothing throws.
await test('TC7: capture and audit on a non-git tmp root returns an empty no-op report and never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readonly-audit-tc7-'));
  try {
    const snapshot = captureTrackedSnapshot(dir);
    assert.strictEqual(snapshot.ok, false, `expected ok:false for a non-git root, got: ${JSON.stringify(snapshot)}`);

    let report;
    assert.doesNotThrow(() => {
      report = auditTrackedDeletions(dir, snapshot, {});
    });
    assert.strictEqual(report.deleted.length, 0);
    assert.strictEqual(report.restored.length, 0);
    assert.strictEqual(report.reportOnly.length, 0);
    assert.strictEqual(report.failed.length, 0);
  } finally {
    cleanupDir(dir);
  }
});

// TC8: a snapshot whose `ok` is false is treated as nothing-to-audit — the
// empty no-op report is returned and the caller's callback is never invoked.
await test('TC8: snapshot ok:false returns the empty no-op report without invoking the callback', () => {
  let counter = 0;
  const onLog = () => {
    counter++;
  };

  const report = auditTrackedDeletions('/does/not/matter', { ok: false, reason: 'anything' }, { onLog });

  assert.strictEqual(report.deleted.length, 0);
  assert.strictEqual(report.restored.length, 0);
  assert.strictEqual(report.reportOnly.length, 0);
  assert.strictEqual(report.failed.length, 0);
  assert.strictEqual(counter, 0, `expected callback to never be invoked, got counter=${counter}`);
});

// TC9: a throwing onLog callback, and a non-function onLog value, each
// leave auditTrackedDeletions returning its report normally — never
// propagating the callback's own failure (or its shape mismatch) as a
// thrown exception. An unresolvable projectRoot deterministically drives the
// module's first fail-soft notify() call so each callback shape is actually
// exercised.
await test('TC9: a throwing callback and a non-function callback value both leave auditTrackedDeletions returning normally', () => {
  const bogusRoot = path.join(os.tmpdir(), `readonly-audit-tc9-missing-${process.pid}-${Date.now()}`);
  const snapshot = { ok: true, tracked: new Set(['whatever.txt']), modified: new Set() };

  const throwingOnLog = () => {
    throw new Error('callback boom');
  };
  let report1;
  assert.doesNotThrow(() => {
    report1 = auditTrackedDeletions(bogusRoot, snapshot, { onLog: throwingOnLog });
  });
  assert.ok(
    Array.isArray(report1.failed) && report1.failed.length > 0,
    `expected a failed entry from the unresolvable projectRoot, got: ${JSON.stringify(report1)}`
  );

  let report2;
  assert.doesNotThrow(() => {
    report2 = auditTrackedDeletions(bogusRoot, snapshot, { onLog: 'not-a-function' });
  });
  assert.ok(
    Array.isArray(report2.failed) && report2.failed.length > 0,
    `expected a failed entry from the unresolvable projectRoot, got: ${JSON.stringify(report2)}`
  );
});

// ── Helpers for TC10-TC12 — role capture/spawn/audit ordering ─────────────
//
// Each case drives the REAL role class (Verifier / Reviewer / Analyzer) with
// a stubbed sessionManager whose spawn() pushes a 'spawn' marker onto one
// shared `events` array, while mock.module() intercepts read-only-audit.js
// so its captureTrackedSnapshot / auditTrackedDeletions push their own
// 'capture' / 'audit' markers onto that SAME array — proving the actual
// call order the role code drives, not merely a value it returns.

/** A schema-valid PASSED verifier verdict (verifierSchema). */
function validVerifierOutput() {
  return {
    result: 'PASSED',
    hardChecks: [{ name: 'check', status: 'PASS', evidence: 'ok' }],
    taskScopeChecks: [{ description: 'scope', status: 'PASS', evidence: 'ok' }],
    standardsChecks: [],
    back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
    notes: '',
  };
}

/** A schema-valid PASSED reviewer verdict (reviewerSchema). */
function validReviewerOutput() {
  return { result: 'PASSED', findings: [] };
}

/** A schema-valid analyzer verdict (analyzerSchema). */
function validAnalyzerOutput() {
  return {
    recommendation: 'human',
    rootCause: 'fixture root cause',
    failureType: 'verification',
    affectedTasks: [],
  };
}

/**
 * Mock sessionManager whose spawn() pushes a 'spawn' marker onto `events`,
 * then resolves with the next entry of `outputs` as the SDK's
 * structured_output (an `undefined` entry omits structured_output entirely,
 * driving each role's own stub / no-structured-output retry-or-escalate
 * path). Mirrors makeMockSetup in test-verifier-escalation.js /
 * test-reviewer-stub-disposition.js: the returned value is a thenable that
 * also exposes `.handle` synchronously, since callers read `spawnPromise
 * .handle` for attachToSession before awaiting.
 */
function makeSpawnStub(events, outputs) {
  const calls = [];
  return {
    calls,
    spawn(opts) {
      const idx = calls.length;
      calls.push(opts);
      events.push({ type: 'spawn' });
      const handle = { _readFiles: new Set(), _toolCallCount: idx + 1, systemPromptTokens: 0 };
      const out = outputs[idx];
      const sdkResult = out !== undefined ? { structured_output: out } : {};
      const spawnResult = { handle, result: sdkResult };
      const thenable = Object.assign(Promise.resolve(spawnResult), { handle });
      return thenable;
    },
  };
}

/** Inert logger fake whose warn() records every message it receives. */
function makeLoggerSpy() {
  const warnCalls = [];
  return {
    warnCalls,
    createSessionLog: (name) => ({
      logPath: path.join(os.tmpdir(), `rodg-${name}-${process.pid}-${Date.now()}.log`),
      close() {},
    }),
    attachToSession: () => {},
    warn: (msg) => { warnCalls.push(msg); },
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
  };
}

/**
 * read-only-audit.js replacement namedExports for mock.module():
 * captureTrackedSnapshot pushes a 'capture' marker; auditTrackedDeletions
 * pushes an 'audit' marker AND — mirroring the real module's contract —
 * invokes the caller-supplied `opts.onLog` with `warnMessage`, so the role's
 * own `(msg) => this.logger.warn(msg)` closure is exercised exactly like
 * production.
 */
function makeReadOnlyAuditMocks(events, warnMessage) {
  return {
    captureTrackedSnapshot: () => {
      events.push({ type: 'capture' });
      return { ok: true, tracked: new Set(), modified: new Set() };
    },
    auditTrackedDeletions: (projectRoot, snapshot, opts = {}) => {
      events.push({ type: 'audit' });
      if (opts && typeof opts.onLog === 'function') opts.onLog(warnMessage);
      return { deleted: [], restored: [], reportOnly: [], failed: [] };
    },
  };
}

/**
 * Asserts the shared ordering contract: exactly one 'capture' marker, exactly
 * one 'audit' marker, the capture marker precedes the FIRST spawn marker, and
 * the audit marker follows the LAST spawn marker — true even when the role
 * spawned more than once (verifier escalation / reviewer retry).
 */
function assertCaptureAuditSpawnOrdering(events, label) {
  const idxOfAll = (type) => events.reduce((acc, e, i) => {
    if (e.type === type) acc.push(i);
    return acc;
  }, []);
  const captureIdxs = idxOfAll('capture');
  const auditIdxs = idxOfAll('audit');
  const spawnIdxs = idxOfAll('spawn');

  assert.strictEqual(
    captureIdxs.length, 1,
    `${label}: expected exactly one capture marker, got ${captureIdxs.length} — events: ${JSON.stringify(events)}`
  );
  assert.strictEqual(
    auditIdxs.length, 1,
    `${label}: expected exactly one audit marker, got ${auditIdxs.length} — events: ${JSON.stringify(events)}`
  );
  assert.ok(
    spawnIdxs.length >= 1,
    `${label}: expected at least one spawn marker, got ${spawnIdxs.length} — events: ${JSON.stringify(events)}`
  );

  assert.ok(
    captureIdxs[0] < spawnIdxs[0],
    `${label}: capture marker (index ${captureIdxs[0]}) must precede the first spawn marker (index ${spawnIdxs[0]}) — events: ${JSON.stringify(events)}`
  );
  assert.ok(
    auditIdxs[0] > spawnIdxs[spawnIdxs.length - 1],
    `${label}: audit marker (index ${auditIdxs[0]}) must follow the last spawn marker (index ${spawnIdxs[spawnIdxs.length - 1]}) — events: ${JSON.stringify(events)}`
  );
}

const READONLY_AUDIT_SPECIFIER = '../src/orchestrator/infra/read-only-audit.js';

// TC10: verifier — escalation path spawns twice (primary stub + escalation).
await test('TC10: verifier records one capture before the first spawn and one audit after the last spawn (escalation spawns twice); the audit callback message reaches logger.warn', async () => {
  const events = [];
  const warnMessage = `[TC10] audit warn marker ${Date.now()}`;
  const mockCtx = mock.module(READONLY_AUDIT_SPECIFIER, {
    namedExports: makeReadOnlyAuditMocks(events, warnMessage),
  });
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rodg-tc10-'));
  try {
    const { Verifier } = await import('../src/orchestrator/agents/verifier.js');

    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# spec\n');
    fs.mkdirSync(path.join(projectRoot, '.harness'), { recursive: true });

    // First spawn omits structured_output (stub) -> verifyTask escalates;
    // the escalation spawn returns a valid verdict.
    const sessionManager = makeSpawnStub(events, [undefined, validVerifierOutput()]);
    const logger = makeLoggerSpy();
    const tokenTracker = { recordSession: async () => {} };

    const verifier = new Verifier(sessionManager, logger, tokenTracker);
    const task = { id: 'tc10-task', description: 'fixture task', targetFiles: [] };

    await verifier.verifyTask(task, projectRoot, { specPath });

    assert.strictEqual(
      sessionManager.calls.length, 2,
      `TC10: expected verifier to spawn exactly twice (primary + escalation), got ${sessionManager.calls.length}`
    );
    assertCaptureAuditSpawnOrdering(events, 'TC10 (verifier)');
    assert.ok(
      logger.warnCalls.includes(warnMessage),
      `TC10: expected the audit callback message to reach logger.warn, got: ${JSON.stringify(logger.warnCalls)}`
    );
  } finally {
    mockCtx.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// TC11: reviewer — retry-on-stub path spawns twice (primary stub + retry).
await test('TC11: reviewer records one capture before the first spawn and one audit after the last spawn (retry spawns twice); the audit callback message reaches logger.warn', async () => {
  const events = [];
  const warnMessage = `[TC11] audit warn marker ${Date.now()}`;
  const mockCtx = mock.module(READONLY_AUDIT_SPECIFIER, {
    namedExports: makeReadOnlyAuditMocks(events, warnMessage),
  });
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rodg-tc11-'));
  try {
    const { Reviewer } = await import('../src/orchestrator/agents/reviewer.js');
    const harnessDir = path.join(projectRoot, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });

    // First spawn omits structured_output (stub) -> reviewMilestone retries
    // once; the retry spawn returns a valid verdict.
    const sessionManager = makeSpawnStub(events, [undefined, validReviewerOutput()]);
    const logger = makeLoggerSpy();
    const tokenTracker = { recordSession: async () => {} };

    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);

    await reviewer.reviewMilestone('tc11-milestone', ['src/foo.js'], ['fixture task'], '', projectRoot, harnessDir);

    assert.strictEqual(
      sessionManager.calls.length, 2,
      `TC11: expected reviewer to spawn exactly twice (primary + retry), got ${sessionManager.calls.length}`
    );
    assertCaptureAuditSpawnOrdering(events, 'TC11 (reviewer)');
    assert.ok(
      logger.warnCalls.includes(warnMessage),
      `TC11: expected the audit callback message to reach logger.warn, got: ${JSON.stringify(logger.warnCalls)}`
    );
  } finally {
    mockCtx.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// TC12: analyzer — single spawn (no retry/escalation path exists here).
await test('TC12: analyzer records one capture before the (single) spawn and one audit after it; the audit callback message reaches logger.warn', async () => {
  const events = [];
  const warnMessage = `[TC12] audit warn marker ${Date.now()}`;
  const mockCtx = mock.module(READONLY_AUDIT_SPECIFIER, {
    namedExports: makeReadOnlyAuditMocks(events, warnMessage),
  });
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rodg-tc12-'));
  try {
    const { Analyzer } = await import('../src/orchestrator/agents/analyzer.js');

    const sessionManager = makeSpawnStub(events, [validAnalyzerOutput()]);
    const logger = makeLoggerSpy();
    const tokenTracker = { recordSession: async () => {} };

    const analyzer = new Analyzer(sessionManager, logger, tokenTracker);
    const opts = { taskId: '001-001-001-001', taskDescription: 'fixture task', failureType: 'verification', retryCount: 0 };

    await analyzer.analyzeFailure(opts, projectRoot);

    assert.strictEqual(
      sessionManager.calls.length, 1,
      `TC12: expected analyzer to spawn exactly once, got ${sessionManager.calls.length}`
    );
    assertCaptureAuditSpawnOrdering(events, 'TC12 (analyzer)');
    assert.ok(
      logger.warnCalls.includes(warnMessage),
      `TC12: expected the audit callback message to reach logger.warn, got: ${JSON.stringify(logger.warnCalls)}`
    );
  } finally {
    mockCtx.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ── Helpers for TC13-TC15 — warnings-ledger incident wiring ───────────────
//
// Reuses the analyzer.js audit-handling path (its read-only-audit wiring
// already computes the per-session-unique `${opts.taskId}:${eventId}`
// identifier documented at its call site) with a stubbed read-only-audit
// module whose auditTrackedDeletions returns a caller-supplied report
// verbatim, so each case controls exactly what the ledger sees.

/** read-only-audit.js replacement namedExports returning `report` verbatim. */
function makeReadOnlyAuditReportMock(report) {
  return {
    captureTrackedSnapshot: () => ({ ok: true, tracked: new Set(), modified: new Set() }),
    auditTrackedDeletions: () => report,
  };
}

// analyzer.js's static `import { captureTrackedSnapshot, auditTrackedDeletions }
// from '../infra/read-only-audit.js'` binds ONCE, at that module's first load —
// TC12 (above) already triggers that first load under ITS OWN mock. A later
// mock.module() swap for the same specifier does not retroactively change an
// already-linked importer's bound functions (proven: re-importing the bare
// specifier after re-mocking keeps invoking the FIRST mock, never the new
// one). Each TC13/14/15 case below therefore dynamic-imports analyzer.js
// through a distinct cache-busting query string, forcing Node's ESM loader to
// treat it as a fresh module URL — re-linking its static imports against
// whichever read-only-audit.js mock is active AT THAT IMPORT — while TC12's
// own (already-linked) Analyzer reference is left completely undisturbed.
let freshAnalyzerImportCounter = 0;
async function importFreshAnalyzer() {
  freshAnalyzerImportCounter += 1;
  const { Analyzer } = await import(
    `../src/orchestrator/agents/analyzer.js?rodg-fresh-${freshAnalyzerImportCounter}`
  );
  return Analyzer;
}

// TC13: a non-empty audit report (both a restored path and a report-only
// path) appends exactly one warnings-ledger entry naming the role, a
// per-session-unique task identifier, and both paths.
await test("TC13: a non-empty audit report (restored + report-only paths) appends exactly one warnings-ledger entry naming the role, a per-session-unique task/attempt identifier, the restored path, and the report-only path", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rodg-tc13-'));
  const report = {
    deleted: ['restored/path.txt', 'reportonly/path.txt'],
    restored: [{ path: 'restored/path.txt' }],
    reportOnly: ['reportonly/path.txt'],
    failed: [],
  };
  const mockCtx = mock.module(READONLY_AUDIT_SPECIFIER, {
    namedExports: makeReadOnlyAuditReportMock(report),
  });
  try {
    const Analyzer = await importFreshAnalyzer();
    const sessionManager = makeSpawnStub([], [validAnalyzerOutput()]);
    const logger = makeLoggerSpy();
    const tokenTracker = { recordSession: async () => {} };
    const analyzer = new Analyzer(sessionManager, logger, tokenTracker);
    const opts = { taskId: 'tc13-001-001-001-001', taskDescription: 'fixture task', failureType: 'verification', retryCount: 0 };

    const before = readLedger(projectRoot).length;
    await analyzer.analyzeFailure(opts, projectRoot);
    const ledger = readLedger(projectRoot);

    assert.strictEqual(
      ledger.length, before + 1,
      `TC13: expected exactly one new ledger entry, got ${ledger.length - before} (total ${ledger.length}): ${JSON.stringify(ledger)}`
    );
    const entry = ledger[ledger.length - 1];
    assert.ok(/analyzer/i.test(entry.description), `TC13: expected description to name the role 'analyzer', got: ${entry.description}`);
    assert.ok(
      entry.description.includes(opts.taskId),
      `TC13: expected description to include a per-session-unique task/attempt identifier (${opts.taskId}), got: ${entry.description}`
    );
    assert.ok(
      entry.description.includes('restored/path.txt'),
      `TC13: expected description to include the restored path, got: ${entry.description}`
    );
    assert.ok(
      entry.description.includes('reportonly/path.txt'),
      `TC13: expected description to include the report-only path, got: ${entry.description}`
    );
  } finally {
    mockCtx.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// TC14: two incidents in one session with different task/attempt identifiers
// both survive the ledger's content-hash dedup — reading the ledger back
// returns 2 entries.
await test("TC14: two incidents in one session with different task/attempt identifiers both survive the ledger's content-hash dedup — 2 entries", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rodg-tc14-'));
  const report = {
    deleted: ['restored/path.txt', 'reportonly/path.txt'],
    restored: [{ path: 'restored/path.txt' }],
    reportOnly: ['reportonly/path.txt'],
    failed: [],
  };
  const mockCtx = mock.module(READONLY_AUDIT_SPECIFIER, {
    namedExports: makeReadOnlyAuditReportMock(report),
  });
  try {
    const Analyzer = await importFreshAnalyzer();
    const logger = makeLoggerSpy();
    const tokenTracker = { recordSession: async () => {} };

    const before = readLedger(projectRoot).length;

    const sessionManager1 = makeSpawnStub([], [validAnalyzerOutput()]);
    const analyzer1 = new Analyzer(sessionManager1, logger, tokenTracker);
    await analyzer1.analyzeFailure(
      { taskId: 'tc14-a-001-001-001-001', taskDescription: 'fixture task A', failureType: 'verification', retryCount: 0 },
      projectRoot
    );

    const sessionManager2 = makeSpawnStub([], [validAnalyzerOutput()]);
    const analyzer2 = new Analyzer(sessionManager2, logger, tokenTracker);
    await analyzer2.analyzeFailure(
      { taskId: 'tc14-b-001-001-001-002', taskDescription: 'fixture task B', failureType: 'verification', retryCount: 1 },
      projectRoot
    );

    const ledger = readLedger(projectRoot);
    assert.strictEqual(
      ledger.length, before + 2,
      `TC14: expected two new distinct ledger entries, got ${ledger.length - before} (total ${ledger.length}): ${JSON.stringify(ledger)}`
    );
  } finally {
    mockCtx.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// TC15: an empty audit report appends nothing — the ledger entry count read
// back equals the count before the call.
await test('TC15: an empty audit report appends no ledger entry', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rodg-tc15-'));
  const emptyReport = { deleted: [], restored: [], reportOnly: [], failed: [] };
  const mockCtx = mock.module(READONLY_AUDIT_SPECIFIER, {
    namedExports: makeReadOnlyAuditReportMock(emptyReport),
  });
  try {
    const Analyzer = await importFreshAnalyzer();
    const sessionManager = makeSpawnStub([], [validAnalyzerOutput()]);
    const logger = makeLoggerSpy();
    const tokenTracker = { recordSession: async () => {} };
    const analyzer = new Analyzer(sessionManager, logger, tokenTracker);

    const before = readLedger(projectRoot).length;
    await analyzer.analyzeFailure(
      { taskId: 'tc15-001-001-001-001', taskDescription: 'fixture task', failureType: 'verification', retryCount: 0 },
      projectRoot
    );
    const after = readLedger(projectRoot).length;

    assert.strictEqual(after, before, `TC15: expected no new ledger entry from an empty audit report, before=${before} after=${after}`);
  } finally {
    mockCtx.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
