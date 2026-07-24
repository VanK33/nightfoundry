/**
 * test-bootstrap.js — Unit tests for bootstrap.js.
 *
 * No Claude auth, no SDK. Pure fs + temp directories.
 * Run: node test/test-bootstrap.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { execSync } from 'child_process';
import {
  bootstrap,
  SUBDIRS,
  PER_RUN_SUBDIRS,
  SHARED_SUBDIRS,
} from '../src/orchestrator/core/bootstrap.js';
import { Logger } from '../src/orchestrator/infra/logger.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

function assertThrows(fn, pattern, msg) {
  let thrown;
  try { fn(); } catch (e) { thrown = e; }
  if (!thrown) throw new Error(msg || 'Expected function to throw');
  if (pattern && !pattern.test(thrown.message)) {
    throw new Error(`${msg || 'Throw pattern mismatch'}. Got: ${thrown.message}`);
  }
}

function createProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-test-'));
}

function createGitProjectRoot() {
  const root = createProjectRoot();
  execSync('git init', { cwd: root, stdio: 'ignore' });
  return root;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const EXPECTED_SUBDIRS = [
  'state', 'plan', 'verify', 'progress', 'verification',
  'analysis', 'snapshots', 'learning', 'logs',
];

// ---------- Happy path ----------

test('bootstrap: creates .harness/ and all expected subdirectories', () => {
  const root = createProjectRoot();
  try {
    const { harnessDir } = bootstrap(root);
    assert.ok(fs.existsSync(harnessDir), '.harness/ should exist');
    for (const sub of EXPECTED_SUBDIRS) {
      assert.ok(
        fs.existsSync(path.join(harnessDir, sub)),
        `.harness/${sub}/ should exist`
      );
    }
  } finally { cleanup(root); }
});

test('bootstrap: writes valid state.json with correct structure', () => {
  const root = createProjectRoot();
  try {
    const { stateJsonPath } = bootstrap(root);
    assert.ok(fs.existsSync(stateJsonPath), 'state.json should exist');

    const state = JSON.parse(fs.readFileSync(stateJsonPath, 'utf8'));
    assert.ok(state.projectMeta, 'projectMeta should exist');
    assert.equal(state.projectMeta.prdPath, '', 'default prdPath is empty string');
    assert.ok(state.projectMeta.createdAt, 'createdAt should be set');
    assert.ok(state.projectMeta.createdWithVersion, 'createdWithVersion should be set');
    assert.equal(state.projectMeta.currentPhase, 'planning');
    assert.equal(state.globalStatus, 'active');
    assert.deepEqual(state.milestones, {});
  } finally { cleanup(root); }
});

test('bootstrap: stores prdPath in projectMeta when provided', () => {
  const root = createProjectRoot();
  try {
    const absPrdPath = path.join(root, 'spec.md');
    bootstrap(root, { prdPath: absPrdPath });
    const state = JSON.parse(fs.readFileSync(path.join(root, '.harness', 'state.json'), 'utf8'));
    assert.equal(state.projectMeta.prdPath, absPrdPath);
  } finally { cleanup(root); }
});

test('bootstrap: createdWithVersion matches cc-orch package version', () => {
  const root = createProjectRoot();
  try {
    bootstrap(root);
    const state = JSON.parse(fs.readFileSync(path.join(root, '.harness', 'state.json'), 'utf8'));
    // Version should be a semver-like string or 'unknown' (graceful fallback).
    assert.ok(
      /^\d+\.\d+\.\d+/.test(state.projectMeta.createdWithVersion) ||
      state.projectMeta.createdWithVersion === 'unknown',
      `unexpected version: ${state.projectMeta.createdWithVersion}`
    );
  } finally { cleanup(root); }
});

test('bootstrap: createdAt is a valid ISO timestamp', () => {
  const root = createProjectRoot();
  try {
    bootstrap(root);
    const state = JSON.parse(fs.readFileSync(path.join(root, '.harness', 'state.json'), 'utf8'));
    assert.ok(!isNaN(Date.parse(state.projectMeta.createdAt)), 'createdAt should parse as a date');
  } finally { cleanup(root); }
});

test('bootstrap: returns alreadyExisted=false on fresh project', () => {
  const root = createProjectRoot();
  try {
    const result = bootstrap(root);
    assert.equal(result.alreadyExisted, false);
  } finally { cleanup(root); }
});

// ---------- Idempotency + force ----------

test('bootstrap: running twice without force throws', () => {
  const root = createProjectRoot();
  try {
    bootstrap(root);
    assertThrows(
      () => bootstrap(root),
      /already exists/
    );
  } finally { cleanup(root); }
});

test('bootstrap: force=true overwrites existing state.json', () => {
  const root = createProjectRoot();
  try {
    const firstPrdPath = path.join(root, 'first.md');
    const secondPrdPath = path.join(root, 'second.md');
    bootstrap(root, { prdPath: firstPrdPath });
    const result = bootstrap(root, { prdPath: secondPrdPath, force: true });
    assert.equal(result.alreadyExisted, true, 'should report that state existed');

    const state = JSON.parse(fs.readFileSync(path.join(root, '.harness', 'state.json'), 'utf8'));
    assert.equal(state.projectMeta.prdPath, secondPrdPath, 'should reflect new prdPath');
  } finally { cleanup(root); }
});

test('bootstrap: force=true wipes stateful subdirs (defect #7 fix)', () => {
  // Defect #7 (2026-04-26 investigation): when batchResume calls
  // bootstrap(force:true) between queue entries to recycle harness state
  // for the next spec, prior behavior preserved subdir contents — leaving
  // stale `state/mission-*.json` that short-circuited the next spec's
  // decomposition via isMissionAlreadyStarted, and stale `snapshots/{taskId}/`
  // that could silently restore prior spec's baseline files into the new
  // spec's working tree during retry (deterministic taskId collisions:
  // 001-001-001-001 across specs).
  //
  // Wipe set: state, plan, verify, progress, verification, analysis, snapshots.
  // Preserved: learning/ (user-curated cross-run baseline), dry-run/
  // (separate code path).
  const root = createProjectRoot();
  try {
    bootstrap(root);
    const harness = path.join(root, '.harness');

    // Pre-seed each stateful subdir with content from a "prior spec".
    fs.writeFileSync(path.join(harness, 'state', 'mission-001-001.json'), '{"missionId":"001-001"}');
    fs.writeFileSync(path.join(harness, 'plan', 'milestone-001.md'), 'spec A plan');
    fs.writeFileSync(path.join(harness, 'verify', 'task-001-001-001-001.json'), '{}');
    fs.writeFileSync(path.join(harness, 'progress', 'task-001-001-001-001.json'), '{}');
    fs.writeFileSync(path.join(harness, 'verification', 'task-001-001-001-001.json'), '{}');
    fs.writeFileSync(path.join(harness, 'analysis', 'gate-failure-x.json'), '{}');
    // snapshots/ carries the latent retry-corruption risk specifically.
    fs.mkdirSync(path.join(harness, 'snapshots', '001-001-001-001', 'before'), { recursive: true });
    fs.writeFileSync(path.join(harness, 'snapshots', '001-001-001-001', 'before', 'foo.txt'), 'spec A baseline');
    // Preserved: learning/ (user-curated) and dry-run/ (separate lifecycle).
    fs.writeFileSync(path.join(harness, 'learning', 'patterns.md'), 'user-curated patterns');
    fs.writeFileSync(path.join(harness, 'dry-run', 'foo.json'), '{}');

    bootstrap(root, { force: true });

    // The 7 stateful subdirs are wiped.
    for (const sub of ['state', 'plan', 'verify', 'progress', 'verification', 'analysis', 'snapshots']) {
      const dir = path.join(harness, sub);
      assert.ok(fs.existsSync(dir), `${sub}/ should be re-created (empty)`);
      assert.equal(
        fs.readdirSync(dir).length,
        0,
        `${sub}/ should be empty after force=true bootstrap, got: ${JSON.stringify(fs.readdirSync(dir))}`,
      );
    }

    // learning/ and dry-run/ are preserved (user/system content untouched).
    assert.ok(fs.existsSync(path.join(harness, 'learning', 'patterns.md')), 'learning/ content should survive');
    assert.equal(fs.readFileSync(path.join(harness, 'learning', 'patterns.md'), 'utf8'), 'user-curated patterns');
    assert.ok(fs.existsSync(path.join(harness, 'dry-run', 'foo.json')), 'dry-run/ content should survive');
  } finally { cleanup(root); }
});

test('bootstrap: force=true on fresh harness (no prior state) does NOT wipe — only force-on-existing wipes', () => {
  // Edge case: bootstrap(force:true) on a directory where state.json doesn't
  // exist yet (alreadyExisted === false) should NOT trigger the wipe path.
  // (No realistic caller does this today, but defensive: the wipe gate is
  // `alreadyExisted && force`, not `force` alone.)
  const root = createProjectRoot();
  try {
    // Manually create a populated subdir BEFORE first bootstrap (no state.json).
    const harness = path.join(root, '.harness');
    fs.mkdirSync(path.join(harness, 'plan'), { recursive: true });
    fs.writeFileSync(path.join(harness, 'plan', 'pre-bootstrap.md'), 'pre-existing');

    bootstrap(root, { force: true }); // alreadyExisted === false here
    assert.ok(
      fs.existsSync(path.join(harness, 'plan', 'pre-bootstrap.md')),
      'pre-existing content survives when alreadyExisted is false',
    );
  } finally { cleanup(root); }
});

// ---------- runId (run-scoped layout) ----------

test('bootstrap runId: writes state.json inside run dir and creates PER_RUN_SUBDIRS there', () => {
  const root = createProjectRoot();
  try {
    const runId = 'run-tc1';
    const { harnessDir, stateJsonPath } = bootstrap(root, { runId });
    const runDir = path.join(root, '.harness', runId);

    assert.equal(harnessDir, runDir);
    assert.equal(stateJsonPath, path.join(runDir, 'state.json'));
    assert.ok(fs.existsSync(stateJsonPath), 'run dir state.json should exist');

    for (const sub of PER_RUN_SUBDIRS) {
      assert.ok(
        fs.existsSync(path.join(runDir, sub)),
        `.harness/${runId}/${sub}/ should exist`
      );
    }
  } finally { cleanup(root); }
});

test('bootstrap runId: creates SHARED_SUBDIRS at harnessRoot, not inside run dir', () => {
  const root = createProjectRoot();
  try {
    const runId = 'run-tc2';
    bootstrap(root, { runId });
    const harness = path.join(root, '.harness');
    const runDir = path.join(harness, runId);

    for (const sub of SHARED_SUBDIRS) {
      assert.ok(
        fs.existsSync(path.join(harness, sub)),
        `.harness/${sub}/ (shared) should exist at harness root`
      );
      assert.ok(
        !fs.existsSync(path.join(runDir, sub)),
        `.harness/${runId}/${sub}/ (shared) should NOT exist inside the run dir`
      );
    }
  } finally { cleanup(root); }
});

test('bootstrap runId: creates no flat .harness/state.json and no per-run subdirs at harness root', () => {
  const root = createProjectRoot();
  try {
    const runId = 'run-tc3';
    bootstrap(root, { runId });
    const harness = path.join(root, '.harness');

    assert.ok(
      !fs.existsSync(path.join(harness, 'state.json')),
      'flat .harness/state.json should NOT exist when runId is used'
    );
    assert.ok(
      !fs.existsSync(path.join(harness, 'state')),
      '.harness/state (per-run subdir) should NOT exist at harness root when runId is used'
    );
  } finally { cleanup(root); }
});

test('bootstrap runId: second call without force throws /already exists/ naming run dir state.json', () => {
  const root = createProjectRoot();
  try {
    const runId = 'run-tc4';
    bootstrap(root, { runId });
    const runStateJsonPath = path.join(root, '.harness', runId, 'state.json');
    let thrown;
    try {
      bootstrap(root, { runId });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown, 'second bootstrap(root,{runId}) without force should throw');
    assert.ok(/already exists/.test(thrown.message), `expected /already exists/, got: ${thrown.message}`);
    assert.ok(
      thrown.message.includes(runStateJsonPath),
      `expected message to include run dir state.json path ${runStateJsonPath}, got: ${thrown.message}`
    );
  } finally { cleanup(root); }
});

test('bootstrap runId: force=true wipes the 7 WIPE subdirs inside run dir but preserves that run dir logs/', () => {
  const root = createProjectRoot();
  try {
    const runId = 'run-tc5';
    bootstrap(root, { runId });
    const runDir = path.join(root, '.harness', runId);

    const WIPE_SUBDIRS = ['state', 'plan', 'verify', 'progress', 'verification', 'analysis', 'snapshots'];
    for (const sub of WIPE_SUBDIRS) {
      fs.writeFileSync(path.join(runDir, sub, 'seed.txt'), `seed ${sub}`);
    }
    fs.writeFileSync(path.join(runDir, 'logs', 'seed.txt'), 'seed logs');

    bootstrap(root, { runId, force: true });

    for (const sub of WIPE_SUBDIRS) {
      const dir = path.join(runDir, sub);
      assert.ok(fs.existsSync(dir), `${runId}/${sub}/ should be re-created (empty)`);
      assert.equal(
        fs.readdirSync(dir).length,
        0,
        `${runId}/${sub}/ should be empty after force=true bootstrap, got: ${JSON.stringify(fs.readdirSync(dir))}`
      );
    }

    assert.ok(fs.existsSync(path.join(runDir, 'logs', 'seed.txt')), `${runId}/logs/ content should survive`);
    assert.equal(fs.readFileSync(path.join(runDir, 'logs', 'seed.txt'), 'utf8'), 'seed logs');
  } finally { cleanup(root); }
});

test('bootstrap runId: PER_RUN_SUBDIRS and SHARED_SUBDIRS union equals SUBDIRS', () => {
  const union = Array.from(new Set([...PER_RUN_SUBDIRS, ...SHARED_SUBDIRS])).sort();
  const expected = [...SUBDIRS].sort();
  assert.deepEqual(union, expected);
});

test('bootstrap no-runId path unchanged: flat layout still produced', () => {
  const root = createProjectRoot();
  try {
    const { harnessDir, stateJsonPath } = bootstrap(root);
    assert.equal(harnessDir, path.join(root, '.harness'));
    assert.equal(stateJsonPath, path.join(root, '.harness', 'state.json'));
    assert.ok(fs.existsSync(stateJsonPath), 'flat state.json should exist');
    for (const sub of EXPECTED_SUBDIRS) {
      assert.ok(
        fs.existsSync(path.join(harnessDir, sub)),
        `.harness/${sub}/ should exist`
      );
    }
  } finally { cleanup(root); }
});

// ---------- Error cases ----------

test('bootstrap: non-existent project root throws', () => {
  assertThrows(
    () => bootstrap('/nonexistent/path/that/should/not/exist'),
    /does not exist/
  );
});

test('bootstrap: throws if prdPath is relative', () => {
  const root = createProjectRoot();
  try {
    assertThrows(
      () => bootstrap(root, { prdPath: 'relative.md' }),
      /absolute/
    );
  } finally { cleanup(root); }
});

// ---------- Defect #19 regression — logger recovers when logsDir is removed ----------

test('Logger.createSessionLog: recreates logsDir if removed after construction (Defect #19)', () => {
  const root = createProjectRoot();
  try {
    const { harnessDir } = bootstrap(root);
    const logger = new Logger(harnessDir);
    const logsDir = path.join(harnessDir, 'logs');

    // Simulate archive's step-10 reinit gap: logsDir disappears between
    // Logger construction and createSessionLog call (cf. archive.js:777-783
    // before the SUBDIRS fix included 'logs').
    fs.rmSync(logsDir, { recursive: true, force: true });
    assert.ok(!fs.existsSync(logsDir), 'precondition: logsDir removed');

    // Without the mkdir guard, this throws ENOENT (defect #19 reproducer).
    const log = logger.createSessionLog('test-recovery');
    assert.ok(fs.existsSync(logsDir), 'logsDir recreated by createSessionLog');
    log.write({ type: 'test', data: 'ok' });
    log.close();
  } finally { cleanup(root); }
});

// ---------- git excludes (bootstrap) ----------

test('bootstrap: does not create a tracked .gitignore', () => {
  const root = createGitProjectRoot();
  try {
    bootstrap(root);
    assert.ok(!fs.existsSync(path.join(root, '.gitignore')), '.gitignore should not be created');
  } finally { cleanup(root); }
});

test('bootstrap: leaves a pre-existing .gitignore byte-unchanged', () => {
  const root = createGitProjectRoot();
  try {
    const gitignorePath = path.join(root, '.gitignore');
    const sentinel = 'node_modules/\n# sentinel line, untouched\n';
    fs.writeFileSync(gitignorePath, sentinel);
    bootstrap(root);
    const after = fs.readFileSync(gitignorePath);
    assert.ok(Buffer.from(sentinel).equals(after), '.gitignore bytes should be unchanged after bootstrap()');
  } finally { cleanup(root); }
});

test('bootstrap: populates .git/info/exclude on a git fixture', () => {
  const root = createGitProjectRoot();
  try {
    bootstrap(root);
    const excludePath = path.join(root, '.git', 'info', 'exclude');
    assert.ok(fs.existsSync(excludePath), '.git/info/exclude should exist');
    const content = fs.readFileSync(excludePath, 'utf8');
    assert.ok(content.includes('/.harness/'), 'should contain rooted /.harness/ pattern');
    // The archives/ DIRECTORY is never blanket-excluded (forensic archives
    // stay committable), but the two cross-run ledger FILES under it are.
    assert.ok(
      !content.split('\n').some((l) => l.trim() === '/archives/' || l.trim() === 'archives/'),
      'should not blanket-exclude the archives/ directory',
    );
    assert.ok(content.includes('/archives/candidates.jsonl'), 'should exclude the candidates ledger file');
    assert.ok(content.includes('/archives/warnings.jsonl'), 'should exclude the warnings ledger file');
  } finally { cleanup(root); }
});

test('bootstrap: excludes are a silent no-op on a non-git fixture', () => {
  const root = createProjectRoot();
  try {
    assert.doesNotThrow(() => bootstrap(root));
    assert.ok(!fs.existsSync(path.join(root, '.gitignore')), '.gitignore should not be created on non-git fixture');
  } finally { cleanup(root); }
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
