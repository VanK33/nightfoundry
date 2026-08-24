/**
 * test-memory-lifecycle.js — Tests that bootstrap(projectRoot, { force: true })
 * never touches project-root memory/ while still performing its force-wipe of
 * the .harness/ stateful subdirs.
 *
 * TC1: bootstrap(projectRoot,{force:true}) on an existing harness leaves
 *      memory/ present and its per-file SHA-256 map identical to the pre-call
 *      snapshot.
 * TC2 (guard, folded into TC1): .harness/state/mission-001-001.json is
 *      removed by the same call, proving the force-wipe branch executed —
 *      so TC1 cannot pass vacuously.
 * TC4: memory/ survives bootstrap(force:true) → clean(force:true) →
 *      archive() run back-to-back against a single fixture project, checked
 *      against ONE baseline snapshot taken before step 1 so drift is
 *      attributed to the exact step that caused it. archive() is driven
 *      through injected deps.summarize/deps.getGitInfo stubs — no network,
 *      LLM call, or git subprocess.
 *
 * Run: node test/test-memory-lifecycle.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import crypto from 'crypto';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';
import { clean } from '../src/cli/commands/clean.js';
import { archive } from '../src/cli/commands/archive.js';

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

// ── Helper (a): recursive memory/ walk + SHA-256 snapshot ─────────────────────

/**
 * Recursively walk `<projectRoot>/memory`, returning a plain object mapping
 * each file's forward-slash relative path to the SHA-256 hex digest of its
 * bytes. Returns null when the directory is absent.
 *
 * @param {string} projectRoot
 * @returns {Object<string,string>|null}
 */
function snapshotMemory(projectRoot) {
  const memoryDir = path.join(projectRoot, 'memory');
  if (!fs.existsSync(memoryDir)) {
    return null;
  }

  const snapshot = {};
  const walk = (dir, base) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, base);
      } else {
        const relPath = path.relative(base, full).split(path.sep).join('/');
        const content = fs.readFileSync(full);
        snapshot[relPath] = crypto.createHash('sha256').update(content).digest('hex');
      }
    }
  };
  walk(memoryDir, memoryDir);

  return snapshot;
}

// ── Helper (b): tmp project with memory/ + a pre-existing valid harness ───────

const tmpDirs = [];

/**
 * Create an os.tmpdir() project root containing memory/notes.md,
 * memory/sub/deep.txt and memory/.keep with fixed known contents, plus a
 * .harness/ holding a valid state.json and a non-empty
 * state/mission-001-001.json and snapshots/snap.json, so the force-wipe
 * branch in bootstrap() has real work to do. Registers the dir for cleanup.
 *
 * @returns {string} Absolute path to the project root temp dir
 */
function makeTmpProjectWithMemory() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lifecycle-'));
  tmpDirs.push(tmpDir);

  // memory/ fixture — fixed known contents.
  const memoryDir = path.join(tmpDir, 'memory');
  fs.mkdirSync(path.join(memoryDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'notes.md'), '# Notes\n\nSome memory content.\n', 'utf8');
  fs.writeFileSync(path.join(memoryDir, 'sub', 'deep.txt'), 'deep memory content\n', 'utf8');
  fs.writeFileSync(path.join(memoryDir, '.keep'), '', 'utf8');

  // .harness/ fixture — a valid, already-bootstrapped harness.
  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  const state = {
    projectMeta: {
      prdPath: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdWithVersion: 'test',
      currentPhase: 'planning',
    },
    globalStatus: 'active',
    milestones: {},
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(harnessDir, 'state', 'mission-001-001.json'),
    JSON.stringify({ id: 'mission-001-001', status: 'in-progress' }, null, 2),
    'utf8'
  );

  fs.mkdirSync(path.join(harnessDir, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'snapshots', 'snap.json'), '{}', 'utf8');

  return tmpDir;
}

// ── Helper (c): minimal archivable .harness/ + spec.md ─────────────────────────

/**
 * Recreate a minimal `.harness/` (just state.json, no per-run subdirs) whose
 * single milestone is already in an archivable terminal status
 * ('complete'), plus a project-root spec.md that state.spec points at — just
 * enough for archive() to run its full flow (validateArchivable,
 * buildManifest, moveHarnessToArchive, reinit) without needing any prior
 * mission/plan/verify artifacts. Overwrites/creates `.harness/` and
 * `spec.md` under projectRoot; does not touch memory/.
 *
 * @param {string} projectRoot - Absolute path to the project root
 */
function makeArchivableHarness(projectRoot) {
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  fs.writeFileSync(
    path.join(projectRoot, 'spec.md'),
    '# TC4 archivable spec\n\nGoal: exercise the full bootstrap→clean→archive sequence.\n',
    'utf8'
  );

  const state = {
    projectMeta: {
      prdPath: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdWithVersion: 'test',
      currentPhase: 'planning',
    },
    globalStatus: 'active',
    spec: 'spec.md',
    milestones: {
      'm1': {
        id: 'm1',
        description: 'TC4 archivable milestone',
        status: 'complete',
        missions: {},
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

// ── Helper (d): cleanup ────────────────────────────────────────────────────────

/**
 * Remove every registered temp dir.
 */
function cleanupTmpDirs() {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tmpDirs.length = 0;
}

// ── TC1: force-wipe bootstrap leaves project-root memory/ unchanged ───────────

await test('TC1: bootstrap(force) leaves project-root memory/ unchanged', async () => {
  const projectRoot = makeTmpProjectWithMemory();

  const beforeSnapshot = snapshotMemory(projectRoot);
  assert.ok(beforeSnapshot, 'pre-call snapshotMemory() should find memory/ and return a map');

  const result = bootstrap(projectRoot, { force: true });

  assert.strictEqual(
    result.alreadyExisted,
    true,
    'bootstrap() should report alreadyExisted:true, confirming it exercised the existing-harness force-wipe branch'
  );

  // memory/ must still exist at the project root.
  assert.ok(
    fs.existsSync(path.join(projectRoot, 'memory')),
    'memory/ should still exist at the project root after bootstrap(force:true)'
  );

  // Its per-file SHA-256 map must be byte-identical to the pre-call snapshot.
  const afterSnapshot = snapshotMemory(projectRoot);
  assert.deepStrictEqual(
    afterSnapshot,
    beforeSnapshot,
    'memory/ contents (per-file SHA-256 map) must be unchanged by bootstrap(force:true)'
  );

  // Guard (TC2): prove the force-wipe branch actually executed, so TC1 above
  // cannot pass vacuously (e.g. because bootstrap silently no-op'd).
  assert.ok(
    !fs.existsSync(path.join(projectRoot, '.harness', 'state', 'mission-001-001.json')),
    '.harness/state/mission-001-001.json should have been removed by the force-wipe branch'
  );
});

// ── TC4: memory/ survives the full bootstrap→clean→archive sequence ───────────

await test('TC4: memory/ survives the full bootstrap→clean→archive sequence', async () => {
  const projectRoot = makeTmpProjectWithMemory();

  const baseline = snapshotMemory(projectRoot);
  assert.ok(baseline, 'baseline snapshotMemory() should find memory/ and return a map');

  // Step 1: bootstrap(force:true) — force-wipes the existing harness.
  bootstrap(projectRoot, { force: true });

  assert.ok(
    fs.existsSync(path.join(projectRoot, 'memory')),
    'memory/ should still exist after step 1 (bootstrap(force:true))'
  );
  assert.deepStrictEqual(
    snapshotMemory(projectRoot),
    baseline,
    'memory/ must be unchanged after step 1 (bootstrap(force:true))'
  );

  // Step 2: clean(force:true) — removes .harness/ (no active milestones after
  // the fresh bootstrap above, so this takes the simple-removal branch).
  await clean(projectRoot, { force: true });

  assert.ok(
    fs.existsSync(path.join(projectRoot, 'memory')),
    'memory/ should still exist after step 2 (clean(force:true))'
  );
  assert.deepStrictEqual(
    snapshotMemory(projectRoot),
    baseline,
    'memory/ must be unchanged after step 2 (clean(force:true))'
  );

  // Step 3: recreate a minimal archivable .harness/, then archive() it —
  // hermetic via injected summarize/getGitInfo stubs (no network, no LLM
  // call, no git subprocess).
  makeArchivableHarness(projectRoot);
  await archive(
    projectRoot,
    'tc4-lifecycle-run',
    { 'skip-test-gate': true },
    {
      summarize: async () => ({
        headline: 'TC4 test headline',
        bugs: [],
        summary: 'TC4 test summary',
        changelog: [],
      }),
      getGitInfo: () => ({ gitHead: 'deadbeefcafefeed', gitStatus: 'clean' }),
    }
  );

  assert.ok(
    fs.existsSync(path.join(projectRoot, 'memory')),
    'memory/ should still exist after step 3 (archive())'
  );
  assert.deepStrictEqual(
    snapshotMemory(projectRoot),
    baseline,
    'memory/ must be unchanged after step 3 (archive())'
  );
});

// ── Cleanup + Summary ─────────────────────────────────────────────────────────

cleanupTmpDirs();

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
