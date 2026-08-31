/**
 * test-thin-command.js — T6: the `thin` CLI assembly (orchestration with
 * injected parts), park persistence, and router registration.
 * Run: node test/test-thin-command.js
 */
import assert from 'assert';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { thinCommand, thinSlug, persistThinPark, makeThinGit, makeThinExecutors } from '../src/cli/commands/thin.js';
import { readParkScene } from '../src/orchestrator/core/state.js';

let passCount = 0;
let failCount = 0;
const asyncTests = [];
function test(name, fn) {
  asyncTests.push({ name, fn });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'src', 'cli', 'index.js');

const tmpDirs = [];
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-cmd-'));
  tmpDirs.push(root);
  const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, stdio: 'pipe' });
  git('init -q');
  git('config user.email t@t');
  git('config user.name t');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '*.spec.*\n');
  git('add -A');
  git('commit -qm seed');
  fs.writeFileSync(path.join(root, 'demo.spec.md'), '# spec\n');
  fs.writeFileSync(path.join(root, 'demo.spec.json'), '{"goal":"g","target_files":[],"acceptance_criteria":["c"]}');
  fs.writeFileSync(path.join(root, 'demo.spec.accept.mjs'), "console.log('PASS ok');\nprocess.exit(0);\n");
  return root;
}

function fakeDeps(overrides = {}) {
  const calls = { archive: [], park: [] };
  return {
    calls,
    deps: {
      log: () => {},
      makeExecutors: () => ({
        executeFresh: async () => ({}),
        executeFollowup: async () => ({}),
        close: async () => {},
      }),
      grader: () => ({ green: true, redList: [], failLabels: [], acceptance: { pass: 1, fail: 0, lines: [] }, suite: { skipped: true }, scope: { changed: [], outOfScope: [], whitelisted: [] } }),
      makeGit: () => ({
        headSha: () => 'x',
        capturePatch: () => '',
        snapshotTry: (label) => `refs/thin/demo/${label}-stash`,
        snapshotHead: (label) => `refs/thin/demo/${label}-head`,
        resetToBase: () => {},
      }),
      writeThinArchive: (p) => {
        calls.archive.push(p);
        return { ok: true, archiveDir: '/fake/archives/001-thin-demo' };
      },
      persistThinPark: (root, slug, scene) => {
        calls.park.push({ root, slug, scene });
        return { ok: true };
      },
      ...overrides,
    },
  };
}

test('TC1: preflight refusal exits 3 and prints every refusal line', async () => {
  const root = makeProject();
  fs.rmSync(path.join(root, 'demo.spec.accept.mjs'));
  fs.writeFileSync(path.join(root, 'stray.txt'), 'x\n');
  const lines = [];
  const { deps } = fakeDeps({ log: (l) => lines.push(String(l)) });
  const code = await thinCommand(path.join(root, 'demo.spec.md'), root, deps);
  assert.strictEqual(code, 3);
  const joined = lines.join('\n');
  assert.ok(joined.includes('stray.txt'));
  assert.ok(joined.includes('accept'));
});

test('TC2: delivered path exits 0 and archives with the full parameter set', async () => {
  const root = makeProject();
  const { calls, deps } = fakeDeps();
  const code = await thinCommand(path.join(root, 'demo.spec.md'), root, deps);
  assert.strictEqual(code, 0);
  assert.strictEqual(calls.archive.length, 1);
  const a = calls.archive[0];
  assert.strictEqual(a.slug, 'demo');
  assert.match(a.baseSha, /^[0-9a-f]{40}$/);
  assert.ok(a.loopOutcome.outcome === 'delivered');
  assert.ok(a.mechTimingsMs && typeof a.mechTimingsMs.acceptance === 'number');
  assert.strictEqual(calls.park.length, 0, 'no park persistence on delivery');
});

test('TC3: parked path exits 2, persists the park scene with the snapshot ref and archive pointer', async () => {
  const root = makeProject();
  const red = { green: false, redList: ['acceptance FAIL: x'], failLabels: ['x'], acceptance: { pass: 0, fail: 1, lines: [] }, suite: { skipped: true }, scope: { changed: [], outOfScope: [], whitelisted: [] } };
  const { calls, deps } = fakeDeps({ grader: () => red });
  const code = await thinCommand(path.join(root, 'demo.spec.md'), root, deps);
  assert.strictEqual(code, 2);
  assert.strictEqual(calls.park.length, 1);
  const scene = calls.park[0].scene;
  assert.strictEqual(scene.kind, 'thin');
  assert.strictEqual(scene.stashRef, 'refs/thin/demo/try1-stash');
  assert.strictEqual(scene.headRef, 'refs/thin/demo/try1-head', 'a moved HEAD must leave its ref in the scene');
  assert.ok(scene.reason.length > 0);
  assert.ok(scene.archiveDir);
});

test('TC4: persistThinPark writes a tolerant queue entry the park machinery can read back', async () => {
  const root = makeProject();
  const r = persistThinPark(root, 'demo', { kind: 'thin', reason: 'why', parkedAt: 'now' });
  assert.ok(r.ok);
  assert.strictEqual(fs.readFileSync(path.join(root, 'queue', 'demo', 'status'), 'utf8'), 'parked');
  const scene = readParkScene(root, 'demo');
  assert.strictEqual(scene.kind, 'thin');
  assert.strictEqual(scene.reason, 'why');
});

test('TC5: executor sessions are closed even when the loop parks on infra', async () => {
  const root = makeProject();
  let closed = false;
  const { deps } = fakeDeps({
    makeExecutors: () => ({
      executeFresh: async () => { throw new Error('boom'); },
      executeFollowup: async () => ({}),
      close: async () => { closed = true; },
    }),
  });
  const code = await thinCommand(path.join(root, 'demo.spec.md'), root, deps);
  assert.strictEqual(code, 2);
  assert.strictEqual(closed, true);
});

test('TC6: thinSlug strips the .spec.md suffix chain', async () => {
  assert.strictEqual(thinSlug('/x/research-fuel.spec.md'), 'research-fuel');
  assert.strictEqual(thinSlug('plain.md'), 'plain');
});

test('TC7: router — `thin` without a spec prints usage and exits 1 (not the preflight code 3)', async () => {
  const r = spawnSync('node', [CLI, 'thin'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.ok((r.stdout + r.stderr).includes('thin <spec.md>'), r.stdout + r.stderr);
});

test('TC8: router — `thin missing.md` prints file-not-found and exits 1 (not the preflight code 3)', async () => {
  const root = makeProject();
  const r = spawnSync('node', [CLI, 'thin', 'missing.md'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.ok((r.stdout + r.stderr).toLowerCase().includes('not found'));
});

test('TC9: router — help output includes thin', async () => {
  const r = spawnSync('node', [CLI, 'help'], { encoding: 'utf8' });
  assert.ok(r.stdout.includes('thin'));
});


test('TC10: a model override reaches both the archive record and the executor factory', async () => {
  const root = makeProject();
  let seenModel;
  const { calls, deps } = fakeDeps();
  const origMake = deps.makeExecutors;
  deps.makeExecutors = (p) => { seenModel = p.model; return origMake(p); };
  deps.modelId = 'claude-opus-5';
  const code = await thinCommand(path.join(root, 'demo.spec.md'), root, deps);
  assert.strictEqual(code, 0);
  assert.strictEqual(seenModel, 'claude-opus-5', 'model must reach the executor factory');
  assert.strictEqual(calls.archive[0].modelId, 'claude-opus-5');
});


test('TC11: router — `thin --model <id>` parses (refusal path still exit 3, not unknown-option)', async () => {
  const root = makeProject();
  fs.rmSync(path.join(root, 'demo.spec.accept.mjs')); // force a preflight refusal
  const r = spawnSync('node', [CLI, 'thin', 'demo.spec.md', '--model', 'claude-opus-5'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(r.status, 3, r.stdout + r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes('Unknown option'), r.stdout + r.stderr);
});


test('TC12: park list and park show survive a thin scene end-to-end', async () => {
  const root = makeProject();
  persistThinPark(root, 'demo', {
    kind: 'thin',
    reason: 'acceptance still red after the full loop',
    suspectedAcceptanceDefects: ['x'],
    stashRef: null, // clean-tree park: no snapshot ref exists, honestly null
    archiveDir: path.join(root, 'archives', '001-thin-demo'),
    parkedAt: '2026-08-31T00:00:00.000Z',
  });
  const list = spawnSync('node', [CLI, 'park', 'list'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(list.status, 0, list.stdout + list.stderr);
  assert.ok(list.stdout.includes('demo'), list.stdout);
  const show = spawnSync('node', [CLI, 'park', 'show', 'demo'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(show.status, 0, show.stdout + show.stderr);
  assert.ok(show.stdout.includes('thin') || show.stdout.includes('acceptance still red'), show.stdout);
});

test('TC13: orchestration time is derived from real elapsed and totalElapsedMs reaches the archive', async () => {
  const root = makeProject();
  let clock = 0;
  const { calls, deps } = fakeDeps();
  deps.now = () => { clock += 1000; return clock; };
  const code = await thinCommand(path.join(root, 'demo.spec.md'), root, deps);
  assert.strictEqual(code, 0);
  const a = calls.archive[0];
  assert.ok(typeof a.totalElapsedMs === 'number' && a.totalElapsedMs > 0, 'measured elapsed must be recorded');
  // no session durations and no grader timings here, so ALL elapsed time is
  // orchestration overhead — the F2 fix: it must not be zero/dropped
  assert.strictEqual(a.mechTimingsMs.orchestration, a.totalElapsedMs);
});


test('TC14: --suite overrides the engine default suite command for the grader', async () => {
  const root = makeProject();
  // real grader path: no deps.grader; stub runSuite observation via a
  // sentinel command that succeeds and echoes
  const { calls, deps } = fakeDeps();
  delete deps.grader;
  deps.suiteCommand = 'true'; // exits 0, counts as a green suite run
  let clock = 0;
  deps.now = () => { clock += 1000; return clock; };
  const code = await thinCommand(path.join(root, 'demo.spec.md'), root, deps);
  assert.strictEqual(code, 0, 'sentinel suite command must be used and pass');
  // the DEFAULT grader ran: acceptance and suite each spanned one fake tick
  const m = calls.archive[0].mechTimingsMs;
  assert.strictEqual(m.acceptance, 1000, 'default grader must accumulate acceptance time');
  assert.strictEqual(m.suite, 1000, 'default grader must accumulate suite time');
  assert.ok(m.orchestration > 0, 'derived orchestration must be non-zero');
});


test('TC15: REAL makeThinGit survives the parked sequence (moved HEAD + dirty tree) without a D/F ref conflict', async () => {
  const root = makeProject();
  const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const baseSha = git('rev-parse HEAD').trim();
  // executor-like activity: one commit (HEAD moves) plus uncommitted work
  fs.writeFileSync(path.join(root, 'seed.txt'), 'committed change\n');
  git('add seed.txt'); git('-c user.email=t@t -c user.name=t commit -qm work');
  fs.writeFileSync(path.join(root, 'wip.txt'), 'uncommitted\n');
  const g = makeThinGit(root, 'demo', baseSha);
  const stashRef = g.snapshotTry('try1');
  assert.strictEqual(stashRef, 'refs/thin/demo/try1-stash', 'stash ref must be NESTED under the slug');
  assert.ok(git(`rev-parse --verify ${stashRef}`).trim(), 'stash ref must actually exist');
  const headRef = g.snapshotHead('try1'); // pre-fix this threw: cannot lock ref
  assert.ok(git(`rev-parse --verify ${headRef}`).trim(), 'head ref must actually exist');
  g.resetToBase();
  assert.strictEqual(git('rev-parse HEAD').trim(), baseSha);
  assert.strictEqual(git('status --porcelain').trim(), '', 'tree must be clean at base');
});

test('TC16: an archive-write failure logs a WARNING and keeps the delivered exit code', async () => {
  const root = makeProject();
  const lines = [];
  const { deps } = fakeDeps({
    log: (l) => lines.push(String(l)),
    writeThinArchive: () => ({ ok: false, error: 'disk full' }),
  });
  const code = await thinCommand(path.join(root, 'demo.spec.md'), root, deps);
  assert.strictEqual(code, 0);
  assert.ok(lines.some((l) => l.includes('WARNING') && l.includes('disk full')), lines.join('\n'));
});

test('TC17: a park-persistence failure logs a WARNING and still exits 2', async () => {
  const root = makeProject();
  const lines = [];
  const red = { green: false, redList: ['acceptance FAIL: x'], failLabels: ['x'], acceptance: { pass: 0, fail: 1, lines: [] }, suite: { skipped: true }, scope: { changed: [], outOfScope: [], whitelisted: [] } };
  const { deps } = fakeDeps({
    log: (l) => lines.push(String(l)),
    grader: () => red,
    persistThinPark: () => ({ ok: false, error: 'queue unwritable' }),
  });
  const code = await thinCommand(path.join(root, 'demo.spec.md'), root, deps);
  assert.strictEqual(code, 2);
  assert.ok(lines.some((l) => l.includes('WARNING') && l.includes('queue unwritable')), lines.join('\n'));
});

test('TC18: real executor edits land in finalDiffStat and onStat pushes land in tryStats', async () => {
  const root = makeProject();
  const { calls, deps } = fakeDeps();
  deps.makeExecutors = ({ onStat }) => ({
    executeFresh: async () => {
      fs.writeFileSync(path.join(root, 'seed.txt'), 'changed by executor\n');
      onStat({ costUsd: 1.25, durationMs: 42, turns: 3 });
      return {};
    },
    executeFollowup: async () => ({}),
    close: async () => {},
  });
  const code = await thinCommand(path.join(root, 'demo.spec.md'), root, deps);
  assert.strictEqual(code, 0);
  const a = calls.archive[0];
  assert.ok(a.finalDiffStat.includes('seed.txt'), `diff stat must show the edit: ${a.finalDiffStat}`);
  assert.strictEqual(a.tryStats.length, 1);
  assert.strictEqual(a.tryStats[0].costUsd, 1.25);
});

test('TC19: preflight warnings are printed on the happy path', async () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, 'demo.spec.accept.py'), 'print("PASS ok")\n');
  const lines = [];
  const { deps } = fakeDeps({ log: (l) => lines.push(String(l)) });
  const code = await thinCommand(path.join(root, 'demo.spec.md'), root, deps);
  assert.strictEqual(code, 0);
  assert.ok(lines.some((l) => l.includes('thin: warning:')), lines.join('\n'));
});

test('TC20: makeThinExecutors — session lifecycle and stat mapping against a fake sessionManager', async () => {
  let closes = 0;
  let spawns = 0;
  const fakeSession = () => ({
    sendPrompt: async () => ({ total_cost_usd: 1.5, duration_ms: 100, num_turns: 3, model: 'claude-test' }),
    close: async () => { closes += 1; },
  });
  const stats = [];
  const ex = makeThinExecutors({
    projectRoot: '/tmp',
    specText: 'S',
    sessionManager: { spawnReusable: () => { spawns += 1; return fakeSession(); } },
    onStat: (s) => stats.push(s),
    model: 'claude-opus-5',
  });
  await assert.rejects(() => ex.executeFollowup({ redList: ['x'] }), /no live session/);
  await ex.executeFresh();
  assert.deepStrictEqual(stats[0], { costUsd: 1.5, durationMs: 100, turns: 3, model: 'claude-test' });
  await ex.executeFresh(); // re-entry must close the previous session first
  assert.strictEqual(closes, 1);
  assert.strictEqual(spawns, 2);
  await ex.close();
  assert.strictEqual(closes, 2);
});

test('TC21: without any model source the archive records the session-default placeholder', async () => {
  const root = makeProject();
  const { calls, deps } = fakeDeps();
  const code = await thinCommand(path.join(root, 'demo.spec.md'), root, deps);
  assert.strictEqual(code, 0);
  assert.strictEqual(calls.archive[0].modelId, 'session-default');
});

const runAll = async () => {
  for (const { name, fn } of asyncTests) {
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
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
};
runAll();
