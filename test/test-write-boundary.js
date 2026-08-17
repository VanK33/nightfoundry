/**
 * test-write-boundary.js — Pins the project-root write-boundary contract
 * for `_guardToolUse` + the pipeline's targetFile-parent pre-create +
 * the executor progress-sidecar absolutePath field.
 *
 * Invariants (I1-I5), derived from
 *   scratchpad/design-write-boundary.md:
 *
 *   I1: a Write/Edit whose resolved path is outside the session root
 *       is DENIED — including the incident shape (targetFiles
 *       ['auto/__init__.py'], file_path
 *       '/…/other-project/auto/__init__.py' that suffix-matches) AND
 *       the no-targetFiles-out-of-root case.
 *
 *   I2: in-root writes still work — a declared targetFile is accepted
 *       whether the tool call passes a relative form ('auto/x.py'),
 *       a './'-prefixed form ('./auto/x.py'), or an absolute-in-root
 *       form ('<root>/auto/x.py'). Read-before-write denial (existing
 *       file not yet Read) is byte-unchanged. Bash dangerous-pattern
 *       denial is byte-unchanged.
 *
 *   I3: the `includes` loophole is closed — an in-root Write whose
 *       path merely CONTAINS a targetFile substring but resolve-equals
 *       none (tf 'auto/x.py', path '<root>/backup/auto/x.py.bak') is
 *       DENIED.
 *
 *   I4: before the executor spawns, every in-root targetFile's parent
 *       directory exists on disk. Pinned at the `_executeAndVerifyTask`
 *       level with a stubbed executor that asserts the dir exists at
 *       invocation time.
 *
 *   I5: the progress sidecar carries `absolutePath` for every
 *       affectedFiles entry; an out-of-root claim carries
 *       `outOfRoot: true` + emits a warning log; `path` stays
 *       byte-identical to the claim; in-root entries carry no
 *       `outOfRoot` key.
 *
 * Run: node test/test-write-boundary.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { SessionManager } from '../src/orchestrator/infra/session-manager.js';
import { extractProgress } from '../src/orchestrator/agents/executor.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeMissionState } from '../src/orchestrator/core/state.js';

// ── existsSync stub (used only by I2 read-before-write byte-unchanged) ───
const require = createRequire(import.meta.url);
const fsModule = require('fs');
const _originalExistsSync = fsModule.existsSync;
function mockExistsSync(result) { fsModule.existsSync = () => result; }
function restoreExistsSync() { fsModule.existsSync = _originalExistsSync; }

// ── Test harness ────────────────────────────────────────────────────────
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

// ── Fixture helpers ─────────────────────────────────────────────────────
function makeTmpRoot(prefix = 'write-boundary-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeOtherFixture() {
  // A parallel tmp dir standing in for "an unrelated project on the user's
  // disk" — same `auto/__init__.py` shape as the real incident.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'other-fixture-')));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────
// I1 — out-of-root Write/Edit is DENIED
// ─────────────────────────────────────────────────────────────────────────

// I1a — INCIDENT SHAPE. Session cwd is a project root; targetFiles is
// exactly the incident's `['auto/__init__.py']`; the tool call's file_path
// suffix-matches (auto/__init__.py) but resolves inside an unrelated
// project. Old contract accepted it via `endsWith('auto/__init__.py')`;
// new contract must DENY on the boundary check (D1).
await test('I1a: incident shape — out-of-root Write that suffix-matches targetFiles is DENIED', () => {
  const sessionRoot = makeTmpRoot();
  const other = makeOtherFixture();
  try {
    const sm = new SessionManager();
    const sdkOpts = sm._buildSdkOptions(
      { cwd: sessionRoot, targetFiles: ['auto/__init__.py'] },
      new Set(),
    );
    const outOfRootPath = path.join(other, 'auto', '__init__.py');
    // Sanity: this is the incident-shape suffix trap.
    assert.ok(outOfRootPath.endsWith('auto/__init__.py'), 'fixture must suffix-match the tf');

    const result = sdkOpts.canUseTool('Write', { file_path: outOfRootPath });
    assert.strictEqual(
      result?.behavior,
      'deny',
      `Expected DENY (out-of-root Write must be blocked even when the path suffix-matches a declared targetFile); got ${JSON.stringify(result)}`,
    );
    assert.ok(
      typeof result.message === 'string' && result.message.length > 0,
      'Deny must carry an actionable message naming the resolved path and project root',
    );
  } finally {
    cleanup(sessionRoot);
    cleanup(other);
  }
});

// I1b — the no-targetFiles case. An unscoped session (targetFiles empty
// or absent) may still write ANYWHERE INSIDE the project but NOWHERE
// outside. Old contract skipped the guard entirely when targetFiles was
// empty; new contract enforces D1 regardless.
await test('I1b: no-targetFiles session — out-of-root Write is DENIED', () => {
  const sessionRoot = makeTmpRoot();
  const other = makeOtherFixture();
  try {
    const sm = new SessionManager();
    const sdkOpts = sm._buildSdkOptions(
      { cwd: sessionRoot /* targetFiles omitted */ },
      new Set(),
    );
    const outOfRootPath = path.join(other, 'stray.js');
    const result = sdkOpts.canUseTool('Write', { file_path: outOfRootPath });
    assert.strictEqual(
      result?.behavior,
      'deny',
      `Expected DENY (unscoped session must still be bounded to its cwd); got ${JSON.stringify(result)}`,
    );
    assert.ok(
      typeof result.message === 'string' && result.message.length > 0,
      'Deny must carry an actionable message',
    );
  } finally {
    cleanup(sessionRoot);
    cleanup(other);
  }
});

// I1c — Edit form, same shape (the guard is on both Edit and Write).
await test('I1c: incident shape — Edit outside root is DENIED (same guard covers Edit)', () => {
  const sessionRoot = makeTmpRoot();
  const other = makeOtherFixture();
  try {
    const sm = new SessionManager();
    const sdkOpts = sm._buildSdkOptions(
      { cwd: sessionRoot, targetFiles: ['auto/__init__.py'] },
      new Set([path.join(other, 'auto', '__init__.py')]), // pretend it was Read
    );
    const outOfRootPath = path.join(other, 'auto', '__init__.py');
    const result = sdkOpts.canUseTool('Edit', { file_path: outOfRootPath });
    assert.strictEqual(
      result?.behavior,
      'deny',
      `Expected DENY (Edit outside root blocked regardless of read-tracking); got ${JSON.stringify(result)}`,
    );
  } finally {
    cleanup(sessionRoot);
    cleanup(other);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// I2 — in-root writes still work; existing safety byte-unchanged
// ─────────────────────────────────────────────────────────────────────────

// I2a — relative form ('auto/x.py'). Under the new contract, the closure
// normalizes it to abs against cwd (as HEAD already does), then D2
// requires exact resolved equality with a targetFile — ALLOW.
await test('I2a: in-root Write with relative form ("auto/x.py") is ALLOWED', () => {
  const sessionRoot = makeTmpRoot();
  try {
    const sm = new SessionManager();
    const sdkOpts = sm._buildSdkOptions(
      { cwd: sessionRoot, targetFiles: ['auto/x.py'] },
      new Set(),
    );
    // Simulate SDK invoking Write with a relative path — the closure at
    // canUseTool resolves it against sessionCwd before dispatching to
    // _guardToolUse.
    const result = sdkOpts.canUseTool('Write', { file_path: 'auto/x.py' });
    assert.strictEqual(
      result?.behavior,
      'allow',
      `Expected ALLOW (relative-form in-root Write matches declared targetFile after resolve); got ${JSON.stringify(result)}`,
    );
  } finally {
    cleanup(sessionRoot);
  }
});

// I2b — './'-prefixed form.
await test('I2b: in-root Write with "./"-prefixed form ("./auto/x.py") is ALLOWED', () => {
  const sessionRoot = makeTmpRoot();
  try {
    const sm = new SessionManager();
    const sdkOpts = sm._buildSdkOptions(
      { cwd: sessionRoot, targetFiles: ['auto/x.py'] },
      new Set(),
    );
    const result = sdkOpts.canUseTool('Write', { file_path: './auto/x.py' });
    assert.strictEqual(
      result?.behavior,
      'allow',
      `Expected ALLOW ("./"-prefix normalizes to same abs as the declared targetFile); got ${JSON.stringify(result)}`,
    );
  } finally {
    cleanup(sessionRoot);
  }
});

// I2c — absolute in-root form.
await test('I2c: in-root Write with absolute in-root form is ALLOWED', () => {
  const sessionRoot = makeTmpRoot();
  try {
    const sm = new SessionManager();
    const sdkOpts = sm._buildSdkOptions(
      { cwd: sessionRoot, targetFiles: ['auto/x.py'] },
      new Set(),
    );
    const abs = path.join(sessionRoot, 'auto', 'x.py');
    const result = sdkOpts.canUseTool('Write', { file_path: abs });
    assert.strictEqual(
      result?.behavior,
      'allow',
      `Expected ALLOW (absolute in-root path resolve-equals declared tf); got ${JSON.stringify(result)}`,
    );
  } finally {
    cleanup(sessionRoot);
  }
});

// I2d — read-before-write denial is BYTE-UNCHANGED. Existing on-disk file,
// no prior Read → DENY with the "not been Read" message. This is orthogonal
// to the boundary — path is in-root, matches a declared tf.
await test('I2d: read-before-write denial byte-unchanged (existing in-root file not yet Read → DENY "not been Read")', () => {
  const sessionRoot = makeTmpRoot();
  try {
    fs.mkdirSync(path.join(sessionRoot, 'src'), { recursive: true });
    const filePath = path.join(sessionRoot, 'src', 'foo.js');
    fs.writeFileSync(filePath, 'existing');

    const sm = new SessionManager();
    const sdkOpts = sm._buildSdkOptions(
      { cwd: sessionRoot, targetFiles: ['src/foo.js'] },
      new Set(), // NOT read yet
    );
    const result = sdkOpts.canUseTool('Edit', { file_path: filePath });
    assert.strictEqual(result?.behavior, 'deny', `Expected DENY for existing-unread file; got ${JSON.stringify(result)}`);
    assert.ok(
      /not been Read/i.test(result.message),
      `Deny message must retain the existing "not been Read" wording (byte-unchanged); got: ${result.message}`,
    );
  } finally {
    cleanup(sessionRoot);
  }
});

// I2e — Bash dangerous-pattern denial byte-unchanged.
await test('I2e: Bash dangerous-pattern denial byte-unchanged (git commit blocked)', () => {
  const sm = new SessionManager();
  const result = sm._guardToolUse('Bash', { command: 'git commit -m "x"' }, undefined);
  assert.strictEqual(result?.behavior, 'deny', 'Expected DENY on dangerous Bash pattern');
  assert.ok(
    /Dangerous Bash command blocked/.test(result.message),
    `Deny message must retain the existing wording (byte-unchanged); got: ${result.message}`,
  );
});

// I2f — bare `git restore <path>` / `git checkout <path>` are denied. The
// original pattern required a literal `--` after the verb, so the bare form
// slipped through — a read-only verifier used exactly that to destructively
// revert uncommitted deliverables (cross-session report, 2026-08-17).
await test('I2f: bare git restore/checkout forms are denied (no `--` required)', () => {
  const sm = new SessionManager();
  const denied = [
    'git restore src/foo.js',
    'git restore .',
    'git checkout src/foo.js',
    'git checkout -b feature-x',
    'git checkout -- src/foo.js',
    'git restore --staged src/foo.js',
  ];
  for (const cmd of denied) {
    const result = sm._guardToolUse('Bash', { command: cmd }, undefined);
    assert.strictEqual(result?.behavior, 'deny', `Expected DENY for: ${cmd}`);
  }
});

// I2g — read-only git commands stay allowed: the widened pattern must not
// catch inspection commands a verifier legitimately needs.
await test('I2g: read-only git commands remain allowed after the pattern widening', () => {
  const sm = new SessionManager();
  const allowed = [
    'git status',
    'git diff HEAD',
    'git show HEAD:src/foo.js',
    'git log --oneline -5',
    'git stash list',
    'git rev-parse HEAD',
  ];
  for (const cmd of allowed) {
    const result = sm._guardToolUse('Bash', { command: cmd }, undefined);
    assert.notStrictEqual(result?.behavior, 'deny', `Expected ALLOW for: ${cmd}; got ${JSON.stringify(result)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// I3 — the `includes` loophole is CLOSED
// ─────────────────────────────────────────────────────────────────────────

// tf = 'auto/x.py'; path = '<root>/backup/auto/x.py.bak' — the string
// contains 'auto/x.py' as a substring (includes-match), yet resolves to
// a DIFFERENT file. Old contract accepted this; new contract requires
// exact resolved equality → DENY.
await test('I3: in-root path that CONTAINS a targetFile substring but resolve-equals none is DENIED (includes-loophole closed)', () => {
  const sessionRoot = makeTmpRoot();
  try {
    const sm = new SessionManager();
    const sdkOpts = sm._buildSdkOptions(
      { cwd: sessionRoot, targetFiles: ['auto/x.py'] },
      new Set(),
    );
    const trapPath = path.join(sessionRoot, 'backup', 'auto', 'x.py.bak');
    // Sanity: old-contract substring trap.
    assert.ok(trapPath.includes('auto/x.py'), 'fixture must include the tf substring');
    const abs = path.resolve(sessionRoot, 'auto', 'x.py');
    assert.notStrictEqual(trapPath, abs, 'fixture must NOT resolve-equal the tf');

    const result = sdkOpts.canUseTool('Write', { file_path: trapPath });
    assert.strictEqual(
      result?.behavior,
      'deny',
      `Expected DENY (includes-substring loophole is closed by exact-resolved-equality D2); got ${JSON.stringify(result)}`,
    );
    assert.ok(
      /not in targetFiles/.test(result.message),
      `Deny message for D2 rejection should keep the existing "not in targetFiles" shape; got: ${result.message}`,
    );
  } finally {
    cleanup(sessionRoot);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// I4 — target parent dirs pre-created before executor spawn
// ─────────────────────────────────────────────────────────────────────────

// Mimics the phantom-write-guard test-file's pattern (see
// test-phantom-write-guard.js:createPipelineEnv/makePipelineWithFakes):
// build a minimal .harness scaffold, stub executor.executeTask with a
// function that asserts the parent dir of every declared in-root
// targetFile EXISTS AT INVOCATION TIME, then drive
// pipeline._executeAndVerifyTask. If pre-create is missing, the stub
// captures a failure via `dirCheckError`.

function createPipelineEnv(taskId = '001-001-001-001', targetFiles = ['nested/deep/auto/__init__.py']) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'i4-pipeline-')));
  const harnessDir = path.join(root, '.harness');
  for (const sub of ['state', 'verify', 'verification', 'progress', 'analysis', 'snapshots', 'plan', 'logs']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(harnessDir, 'logs', 'token-usage.json'),
    JSON.stringify({ sessions: [], totals: {} }));

  const parts = taskId.split('-');
  const missionId = `${parts[0]}-${parts[1]}`;
  const subMissionId = `${parts[0]}-${parts[1]}-${parts[2]}`;
  const milestoneId = parts[0];

  const state = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId, description: 'test milestone', status: 'pending',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: {
          [missionId]: {
            id: missionId, description: 'test mission', status: 'pending',
            stateFile: `.harness/state/mission-${missionId}.json`,
            planFile: `.harness/plan/mission-${missionId}.md`,
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  writeMissionState(harnessDir, missionId, 'test mission', {
    subMissions: [{
      id: subMissionId, description: 'test sm',
      tasks: [{ id: taskId, description: 'i4 task', targetFiles, dependencies: [], testCases: [] }],
    }],
  });
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles, hardChecks: [], testCases: [] }),
  );

  return { root, harnessDir, taskId, missionId, subMissionId };
}

await test('I4: every in-root targetFile parent dir exists at executor.executeTask invocation time', async () => {
  const targetFiles = ['nested/deep/auto/__init__.py', 'other/module/foo.py'];
  const env = createPipelineEnv('001-001-001-001', targetFiles);
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    // Precondition: the parent dirs must NOT already exist — pipeline
    // must be the party that creates them.
    for (const tf of targetFiles) {
      const parent = path.dirname(path.resolve(env.root, tf));
      assert.ok(!fs.existsSync(parent),
        `precondition: parent dir ${parent} must not exist before pipeline runs`);
    }

    const pipeline = new Pipeline(env.root, {
      onLog: () => {},
      onConfirm: async () => true,
      statusBar: false,
    });

    // Stub executor: capture whether every declared in-root parent dir
    // exists at the moment executeTask is invoked (i.e. AFTER pre-create,
    // BEFORE any executor-side write). Simulate a successful write of one
    // target so the phantom-write guard doesn't reroute the task later.
    let dirCheckError = null;
    pipeline.executor = {
      executeTask: async (task) => {
        for (const tf of task.targetFiles || []) {
          const parent = path.dirname(path.resolve(env.root, tf));
          if (!fs.existsSync(parent)) {
            dirCheckError = new Error(`parent dir missing at executeTask invocation: ${parent} (targetFile: ${tf})`);
          }
        }
        // Emit progress sidecar + actually create every declared target so
        // the phantom-write disambiguation probe doesn't fire on unclaimed
        // both-missing files.
        for (const tf of task.targetFiles) {
          fs.writeFileSync(path.resolve(env.root, tf), 'created by stub\n');
        }
        const sidecar = {
          taskId: task.id,
          status: 'COMPLETED',
          summary: 'i4 stub',
          affectedFiles: task.targetFiles.map((p) => ({ path: p, reason: 'created' })),
          testsSummary: '',
        };
        fs.writeFileSync(
          path.join(env.harnessDir, 'progress', `task-${task.id}.json`),
          JSON.stringify(sidecar),
        );
        return {
          status: 'COMPLETED',
          progressContent: JSON.stringify(sidecar),
          structured: sidecar,
          affectedFiles: sidecar.affectedFiles,
        };
      },
    };
    pipeline.verifier = {
      verifyTask: async (task) => {
        fs.writeFileSync(
          path.join(env.harnessDir, 'verification', `task-${task.id}.json`),
          JSON.stringify({ taskId: task.id, verified: true, report: 'ok' }),
        );
        return { verified: true, report: 'ok' };
      },
    };
    pipeline.analyzer = { analyzeFailure: async () => ({ eventId: 'i4', recommendation: 'human', affectedTasks: [] }) };

    await pipeline._executeAndVerifyTask(env.missionId, env.subMissionId, {
      id: env.taskId,
      description: 'i4 task',
      targetFiles,
      dependencies: [],
    });

    if (dirCheckError) throw dirCheckError;
  } finally {
    console.warn = origWarn;
    cleanup(env.root);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// I5 — progress sidecar carries absolutePath + outOfRoot + warning
// ─────────────────────────────────────────────────────────────────────────

// Construct a fake SDK result with two affectedFiles entries:
//   (a) an in-root RELATIVE claim → sidecar entry should carry
//       `absolutePath = <root>/src/foo.js`, NO `outOfRoot` key, and
//       `path` byte-identical to the claim ('src/foo.js').
//   (b) an ABSOLUTE out-of-root claim → sidecar entry should carry
//       `absolutePath` byte-identical to the claim, `outOfRoot: true`,
//       and the extraction should emit at least one warn log line
//       naming the out-of-root path(s).
//
// The design says: "thread [projectRoot] into extractProgress if not
// already available." Since extractProgress's opts is the only structured
// extensibility point on its signature today, this test passes projectRoot
// via `opts.projectRoot`. If the implementation chose a different threading
// (e.g. a new positional arg), these tests will fail with a clear message
// naming the expected sidecar contract, and the impl author can add
// `opts.projectRoot` support at negligible cost.

await test('I5: progress sidecar — absolutePath added, in-root has no outOfRoot key, byte-identical path', () => {
  const projectRoot = makeTmpRoot();
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'progress'), { recursive: true });
  try {
    const sdkResult = {
      structured_output: {
        status: 'COMPLETED',
        summary: 'i5 stub',
        affectedFiles: [
          { path: 'src/foo.js', reason: 'in-root relative' },
        ],
        testsSummary: '',
      },
    };
    extractProgress(sdkResult, '001-001-001-001', harnessDir, {
      projectRoot,
      warn: () => {},
    });

    const sidecar = JSON.parse(
      fs.readFileSync(path.join(harnessDir, 'progress', 'task-001-001-001-001.json'), 'utf8'),
    );
    assert.strictEqual(sidecar.affectedFiles.length, 1, 'one entry');
    const entry = sidecar.affectedFiles[0];
    assert.strictEqual(entry.path, 'src/foo.js',
      `Expected in-root claim path to be byte-identical ('src/foo.js'); got '${entry.path}'`);
    assert.strictEqual(entry.absolutePath, path.resolve(projectRoot, 'src/foo.js'),
      `Expected absolutePath resolved against projectRoot; got '${entry.absolutePath}'`);
    assert.ok(!('outOfRoot' in entry),
      `In-root entries must NOT carry an outOfRoot key; got: ${JSON.stringify(entry)}`);
  } finally {
    cleanup(projectRoot);
  }
});

await test('I5: progress sidecar — out-of-root claim carries outOfRoot: true, absolutePath byte-identical, warning emitted', () => {
  const projectRoot = makeTmpRoot();
  const otherRoot = makeOtherFixture();
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'progress'), { recursive: true });

  const warnCalls = [];
  try {
    const outOfRootClaim = path.join(otherRoot, 'stray', 'bar.js');
    const sdkResult = {
      structured_output: {
        status: 'COMPLETED',
        summary: 'i5 stub — out-of-root claim',
        affectedFiles: [
          { path: outOfRootClaim, reason: 'absolute out-of-root claim' },
        ],
        testsSummary: '',
      },
    };
    extractProgress(sdkResult, '001-001-001-002', harnessDir, {
      projectRoot,
      warn: (msg) => warnCalls.push(String(msg)),
    });

    const sidecar = JSON.parse(
      fs.readFileSync(path.join(harnessDir, 'progress', 'task-001-001-001-002.json'), 'utf8'),
    );
    assert.strictEqual(sidecar.affectedFiles.length, 1, 'one entry');
    const entry = sidecar.affectedFiles[0];
    assert.strictEqual(entry.path, outOfRootClaim,
      `Expected out-of-root claim path to be byte-identical to the model's narrative; got '${entry.path}'`);
    assert.strictEqual(entry.absolutePath, outOfRootClaim,
      `Expected absolutePath === already-absolute claim (path.resolve is a no-op on absolute paths); got '${entry.absolutePath}'`);
    assert.strictEqual(entry.outOfRoot, true,
      `Expected outOfRoot === true for a claim outside projectRoot; got ${JSON.stringify(entry.outOfRoot)}`);

    assert.ok(
      warnCalls.some((m) => m.includes(outOfRootClaim) || /out.of.root/i.test(m)),
      `Expected at least one warn log naming the out-of-root path or matching /out.of.root/i; got: ${JSON.stringify(warnCalls)}`,
    );
  } finally {
    cleanup(projectRoot);
    cleanup(otherRoot);
  }
});

await test('I5: progress sidecar — mixed entries; in-root has no outOfRoot, out-of-root has outOfRoot:true, path byte-identical for both', () => {
  const projectRoot = makeTmpRoot();
  const otherRoot = makeOtherFixture();
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'progress'), { recursive: true });
  try {
    const outClaim = path.join(otherRoot, 'auto', '__init__.py');
    const sdkResult = {
      structured_output: {
        status: 'COMPLETED',
        summary: 'mixed',
        affectedFiles: [
          { path: 'src/foo.js', reason: 'relative in-root' },
          { path: outClaim, reason: 'absolute out-of-root' },
        ],
        testsSummary: '',
      },
    };
    extractProgress(sdkResult, '001-001-001-003', harnessDir, {
      projectRoot,
      warn: () => {},
    });

    const sidecar = JSON.parse(
      fs.readFileSync(path.join(harnessDir, 'progress', 'task-001-001-001-003.json'), 'utf8'),
    );
    assert.strictEqual(sidecar.affectedFiles.length, 2, 'two entries');

    const inRoot = sidecar.affectedFiles[0];
    assert.strictEqual(inRoot.path, 'src/foo.js', 'in-root path byte-identical');
    assert.strictEqual(inRoot.absolutePath, path.resolve(projectRoot, 'src/foo.js'));
    assert.ok(!('outOfRoot' in inRoot),
      `in-root entry must not carry outOfRoot; got: ${JSON.stringify(inRoot)}`);

    const outOfRoot = sidecar.affectedFiles[1];
    assert.strictEqual(outOfRoot.path, outClaim, 'out-of-root path byte-identical');
    assert.strictEqual(outOfRoot.absolutePath, outClaim);
    assert.strictEqual(outOfRoot.outOfRoot, true);
  } finally {
    cleanup(projectRoot);
    cleanup(otherRoot);
  }
});

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
