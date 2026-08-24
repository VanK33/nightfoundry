/**
 * test-git-excludes.js — Unit tests for git-excludes.js and the git-guard
 * integration that fires it.
 *
 * No Claude auth, no SDK, no network. Pure fs + temp directories + real git
 * repos (fs.mkdtempSync fixture roots, `git init`'d in-fixture — never the
 * repo's own .git). os.tmpdir() is symlinked on macOS (/tmp -> /private/tmp),
 * so every fixture root is realpathed immediately after mkdtemp, and any
 * path later compared against a realpathed value (e.g. a subdir built
 * beneath a fixture root) is realpathed again at the point of comparison.
 *
 * Acceptance cases:
 *   (a) fresh repo, projectRoot === gitRoot → marker + six rooted patterns
 *       written to .git/info/exclude; the archives/ directory is never
 *       blanket-excluded, only the two cross-run ledger files under it.
 *   (b) idempotence — a second ensureGitExcludes call leaves the exclude
 *       file byte-identical.
 *   (c) line-wise upgrade — pre-seed the marker + a subset of patterns;
 *       only the missing lines get inserted, immediately after the marker,
 *       with no duplication.
 *   (d) projectRoot a subdir of gitRoot → every pattern carries the
 *       realpathed '/rel/' prefix.
 *   (e) non-git root → no-op: returns false, no throw, no exclude file.
 *   (f) production-shaped firing — real .harness/, queue/, spec-*.md,
 *       *.spec.md, *.spec.json, *.uspec.json AND archives/ plus a control
 *       untracked file → `git status --porcelain` shows EXACTLY archives/
 *       and the control file.
 *   (g) guard order — gitGuard returns ok:true when only cc-orch dirt is
 *       present (ensureGitExcludes fires before the porcelain read), but
 *       still refuses (ok:false, reason 'dirty-tree') on genuine user dirt.
 *   (h) pre-existing unrelated info/exclude lines preserved verbatim.
 *   (i) subdir guard resolution — projectRoot is a genuine subdirectory of
 *       gitRoot; gitGuard's own findGitRoot/ensureGitExcludes(projectRoot)
 *       resolution (not a direct ensureGitExcludes call) suppresses cc-orch
 *       dirt created inside the subdir (ok:true) but still refuses genuine
 *       user dirt inside the subdir (ok:false, reason 'dirty-tree').
 *   (j) bundle pattern — '/*.bundle.json' is written under the marker at the
 *       git toplevel, carries the realpathed '/rel/' prefix when projectRoot
 *       is a subdirectory (and the un-rooted form is then absent), and a
 *       second ensureGitExcludes call is idempotent (byte-identical file,
 *       pattern appears exactly once).
 *
 * Run: node test/test-git-excludes.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, execSync } from 'child_process';
import { ensureGitExcludes } from '../src/orchestrator/core/git-excludes.js';
import { gitGuard } from '../src/cli/git-guard.js';

let passCount = 0;
let failCount = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passCount++;
  } else {
    console.log(`  [FAIL] ${label}`);
    failCount++;
  }
}

// ── git + fixture helpers (mirrors test-clean-orphan-ref-no-harness.js) ────

/** Run git with argv (no shell) in cwd; throws on non-zero exit. */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** A plain (non-git) fixture root, realpathed immediately (see header note). */
function makeTmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-excludes-')));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** A temp dir initialised as a git repo with one commit (HEAD resolvable). */
function makeGitRoot() {
  const root = makeTmpRoot();
  git(['init', '-q'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'CC Test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git(['add', 'README.md'], root);
  git(['commit', '-q', '-m', 'init'], root);
  return root;
}

/** Whole-line membership: is `line` present as its own line in `content`? */
function hasLine(content, line) {
  return content.split('\n').some((l) => l.trim() === line);
}

/** Count how many times `line` appears as a whole (trimmed) line. */
function countLine(content, line) {
  return content.split('\n').filter((l) => l.trim() === line).length;
}

const MARKER = '# cc-orch artifacts (auto-managed)';

function sixPatterns(prefix) {
  return [
    `${prefix}/.harness/`,
    `${prefix}/queue/`,
    `${prefix}/spec-*.md`,
    `${prefix}/*.spec.md`,
    `${prefix}/*.spec.json`,
    `${prefix}/*.bundle.json`,
    `${prefix}/*.uspec.json`,
    `${prefix}/archives/candidates.jsonl`,
    `${prefix}/archives/warnings.jsonl`,
  ];
}

function excludePathFor(dir) {
  const out = execSync('git rev-parse --git-path info/exclude', {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  return path.isAbsolute(out) ? out : path.resolve(dir, out);
}

// ── AC(a) + AC(b): fresh repo, projectRoot === gitRoot; idempotence ────────

function acA_and_acB() {
  console.log('\n=== AC(a) + AC(b): fresh projectRoot === gitRoot; idempotence ===\n');
  const root = makeGitRoot();
  try {
    const result = ensureGitExcludes(root);
    assert('AC(a): ensureGitExcludes returns true', result === true);

    const excludePath = excludePathFor(root);
    assert('AC(a): info/exclude file exists', fs.existsSync(excludePath));

    const content = fs.readFileSync(excludePath, 'utf8');
    assert('AC(a): marker line present', hasLine(content, MARKER));

    const patterns = sixPatterns('');
    for (const p of patterns) {
      assert(`AC(a): rooted pattern present — ${p}`, hasLine(content, p));
    }
    // The archives/ DIRECTORY must never be blanket-excluded (forensic
    // archives stay committable); only the two cross-run ledger FILES under
    // it are excluded. sixPatterns() already asserts those two are present.
    assert('AC(a): archives/ directory itself is NOT excluded (only the ledger files are)',
      !content.split('\n').some((l) => {
        const t = l.trim();
        return t === 'archives/' || t === '/archives/' || t.endsWith('/archives/');
      }));

    // AC(b): a second call is idempotent — byte-identical file.
    const result2 = ensureGitExcludes(root);
    assert('AC(b): second call also returns true', result2 === true);
    const content2 = fs.readFileSync(excludePath, 'utf8');
    assert('AC(b): content is byte-identical after second call', content2 === content);
    assert('AC(b): marker appears exactly once after second call',
      countLine(content2, MARKER) === 1);
    for (const p of patterns) {
      assert(`AC(b): pattern appears exactly once after second call — ${p}`,
        countLine(content2, p) === 1);
    }
  } catch (err) {
    assert(`AC(a)/AC(b): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// ── AC(c): line-wise upgrade — only missing lines inserted after marker ───

function acC_lineWiseUpgrade() {
  console.log('\n=== AC(c): line-wise upgrade (pre-seeded subset) ===\n');
  const root = makeGitRoot();
  try {
    const excludePath = excludePathFor(root);
    const patterns = sixPatterns('');
    // Pre-seed the marker plus a subset (first three patterns); the other
    // three (index 3..5) are missing and must be the only lines inserted.
    const subset = patterns.slice(0, 3);
    const missingExpected = patterns.slice(3);
    const preSeeded = [MARKER, ...subset, ''].join('\n');
    fs.writeFileSync(excludePath, preSeeded, 'utf8');

    const result = ensureGitExcludes(root);
    assert('AC(c): ensureGitExcludes returns true', result === true);

    const content = fs.readFileSync(excludePath, 'utf8');
    assert('AC(c): marker present exactly once', countLine(content, MARKER) === 1);
    for (const p of patterns) {
      assert(`AC(c): pattern present exactly once — ${p}`, countLine(content, p) === 1);
    }
    for (const p of subset) {
      assert(`AC(c): pre-existing subset pattern preserved — ${p}`, hasLine(content, p));
    }

    // The missing lines were inserted immediately after the marker line, in
    // their canonical order, with nothing extra interleaved.
    const lines = content.split('\n');
    const markerIdx = lines.findIndex((l) => l.trim() === MARKER);
    const linesAfterMarker = lines
      .slice(markerIdx + 1, markerIdx + 1 + missingExpected.length)
      .map((l) => l.trim());
    assert('AC(c): missing lines inserted immediately after the marker, in order, no duplication',
      JSON.stringify(linesAfterMarker) === JSON.stringify(missingExpected));
  } catch (err) {
    assert(`AC(c): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// ── AC(d): projectRoot is a subdir of gitRoot → realpathed '/rel/' prefix ──

function acD_subdirPrefix() {
  console.log('\n=== AC(d): projectRoot is a subdir of gitRoot (rel prefix) ===\n');
  const gitRoot = makeGitRoot();
  try {
    const realGitRoot = fs.realpathSync(gitRoot);
    const subRel = path.join('nested', 'project');
    const subdir = path.join(realGitRoot, subRel);
    fs.mkdirSync(subdir, { recursive: true });
    const realSubdir = fs.realpathSync(subdir);

    const result = ensureGitExcludes(realSubdir);
    assert('AC(d): ensureGitExcludes returns true', result === true);

    const excludePath = excludePathFor(realGitRoot);
    const content = fs.readFileSync(excludePath, 'utf8');
    const rel = path.relative(realGitRoot, realSubdir).split(path.sep).join('/');
    const prefix = '/' + rel;

    assert('AC(d): marker present', hasLine(content, MARKER));
    for (const p of sixPatterns(prefix)) {
      assert(`AC(d): rooted pattern (with rel prefix) present — ${p}`, hasLine(content, p));
    }
    // The un-rooted (gitRoot-level) patterns must NOT appear.
    for (const p of sixPatterns('')) {
      assert(`AC(d): un-rooted pattern absent — ${p}`, !hasLine(content, p));
    }
  } catch (err) {
    assert(`AC(d): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(gitRoot);
  }
}

// ── AC(e): non-git root → no-op, no throw, returns false, no exclude file ──

function acE_nonGitRoot() {
  console.log('\n=== AC(e): non-git root (no-op) ===\n');
  const root = makeTmpRoot(); // NOT a git repo — no `git init`.
  try {
    let result;
    let threw = false;
    try {
      result = ensureGitExcludes(root);
    } catch {
      threw = true;
    }
    assert('AC(e): does not throw', threw === false);
    assert('AC(e): returns false', result === false);
    assert('AC(e): no .git directory created', !fs.existsSync(path.join(root, '.git')));

    const entries = fs.readdirSync(root);
    assert('AC(e): fixture directory left empty (no exclude file created)', entries.length === 0);
  } finally {
    cleanup(root);
  }
}

// ── AC(f): production-shaped firing ────────────────────────────────────────

function acF_productionShapedFiring() {
  console.log('\n=== AC(f): production-shaped firing — status shows only archives/ + control ===\n');
  const root = makeGitRoot();
  try {
    const result = ensureGitExcludes(root);
    assert('AC(f): ensureGitExcludes returns true', result === true);

    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(root, '.harness', 'x'), 'a\n');
    fs.mkdirSync(path.join(root, 'queue'), { recursive: true });
    fs.writeFileSync(path.join(root, 'queue', 'z'), 'a\n');
    fs.writeFileSync(path.join(root, 'spec-foo.md'), 'a\n');
    fs.writeFileSync(path.join(root, 'a.spec.md'), 'a\n');
    fs.writeFileSync(path.join(root, 'a.spec.json'), 'a\n');
    fs.writeFileSync(path.join(root, 'a.bundle.json'), 'a\n');
    fs.writeFileSync(path.join(root, 'a.uspec.json'), 'a\n');
    fs.mkdirSync(path.join(root, 'archives'), { recursive: true });
    fs.writeFileSync(path.join(root, 'archives', 'y'), 'a\n');
    fs.writeFileSync(path.join(root, 'control-dirt.txt'), 'a\n');

    const porcelain = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .sort();

    assert('AC(f): exactly two porcelain lines (archives/ + control file)',
      porcelain.length === 2);
    assert('AC(f): archives/ is shown as untracked (still visible)',
      porcelain.some((l) => l.trim() === '?? archives/'));
    assert('AC(f): control-dirt.txt is shown as untracked',
      porcelain.some((l) => l.trim() === '?? control-dirt.txt'));
    assert('AC(f): .harness/ is suppressed (not in porcelain output)',
      !porcelain.some((l) => l.includes('.harness')));
    assert('AC(f): queue/ is suppressed (not in porcelain output)',
      !porcelain.some((l) => l.includes('queue')));
    assert('AC(f): spec-foo.md is suppressed (not in porcelain output)',
      !porcelain.some((l) => l.includes('spec-foo.md')));
    assert('AC(f): a.spec.md is suppressed (not in porcelain output)',
      !porcelain.some((l) => l.includes('a.spec.md')));
    assert('AC(f): a.spec.json is suppressed (not in porcelain output)',
      !porcelain.some((l) => l.includes('a.spec.json')));
    assert('AC(f): a.bundle.json is suppressed (not in porcelain output)',
      !porcelain.some((l) => l.includes('a.bundle.json')));
    assert('AC(f): a.uspec.json is suppressed (not in porcelain output)',
      !porcelain.some((l) => l.includes('a.uspec.json')));
  } catch (err) {
    assert(`AC(f): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// ── AC(g): guard order — cc-orch dirt passes, genuine user dirt refused ────

async function acG_guardOrder() {
  console.log('\n=== AC(g): guard order — cc-orch dirt passes, user dirt refused ===\n');

  // Case 1: only cc-orch dirt present — gitGuard must fire ensureGitExcludes
  // BEFORE reading porcelain status, so this dirt gets suppressed and ok
  // comes back true.
  {
    const root = makeGitRoot();
    try {
      fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
      fs.writeFileSync(path.join(root, '.harness', 'x'), 'a\n');
      fs.mkdirSync(path.join(root, 'queue'), { recursive: true });
      fs.writeFileSync(path.join(root, 'queue', 'z'), 'a\n');
      fs.writeFileSync(path.join(root, 'spec-foo.md'), 'a\n');

      const result = await gitGuard(root);
      assert('AC(g): gitGuard returns ok:true with only cc-orch dirt present',
        result.ok === true);
    } catch (err) {
      assert(`AC(g) case 1: unexpected exception — ${err && err.message}`, false);
    } finally {
      cleanup(root);
    }
  }

  // Case 2: genuine user dirt (a real file the excludes have no knowledge
  // of) — gitGuard must still refuse.
  {
    const root = makeGitRoot();
    try {
      fs.writeFileSync(path.join(root, 'user-file.txt'), 'dirty\n');

      const result = await gitGuard(root);
      assert('AC(g): gitGuard returns ok:false with genuine user dirt', result.ok === false);
      assert('AC(g): reason is "dirty-tree"', result.reason === 'dirty-tree');
    } catch (err) {
      assert(`AC(g) case 2: unexpected exception — ${err && err.message}`, false);
    } finally {
      cleanup(root);
    }
  }
}

// ── AC(i): subdir guard resolution — gitGuard's own findGitRoot/ensureGitExcludes(projectRoot) ──

async function acI_subdirGuardResolution() {
  console.log('\n=== AC(i): subdir guard resolution — cc-orch dirt suppressed, user dirt refused ===\n');

  // Sub-case 1: only cc-orch dirt present INSIDE the subdir — gitGuard walks
  // up to gitRoot, calls ensureGitExcludes(subdir) which roots the patterns
  // at the realpathed '/nested/project/' prefix, so this dirt is suppressed
  // when porcelain is read from gitRoot and ok comes back true.
  {
    const gitRoot = makeGitRoot();
    try {
      const realGitRoot = fs.realpathSync(gitRoot);
      const subRel = path.join('nested', 'project');
      const subdir = path.join(realGitRoot, subRel);
      fs.mkdirSync(subdir, { recursive: true });
      const realSubdir = fs.realpathSync(subdir);

      fs.mkdirSync(path.join(realSubdir, '.harness'), { recursive: true });
      fs.writeFileSync(path.join(realSubdir, '.harness', 'x'), 'a\n');
      fs.mkdirSync(path.join(realSubdir, 'queue'), { recursive: true });
      fs.writeFileSync(path.join(realSubdir, 'queue', 'z'), 'a\n');
      fs.writeFileSync(path.join(realSubdir, 'spec-foo.md'), 'a\n');

      const result = await gitGuard(realSubdir);
      assert('AC(i): gitGuard returns ok:true with only cc-orch dirt inside the subdir',
        result.ok === true);
    } catch (err) {
      assert(`AC(i) sub-case 1: unexpected exception — ${err && err.message}`, false);
    } finally {
      cleanup(gitRoot);
    }
  }

  // Sub-case 2: genuine user dirt INSIDE the subdir — gitGuard must still
  // refuse, since the excludes have no knowledge of this file.
  {
    const gitRoot = makeGitRoot();
    try {
      const realGitRoot = fs.realpathSync(gitRoot);
      const subRel = path.join('nested', 'project');
      const subdir = path.join(realGitRoot, subRel);
      fs.mkdirSync(subdir, { recursive: true });
      const realSubdir = fs.realpathSync(subdir);

      fs.writeFileSync(path.join(realSubdir, 'user-file.txt'), 'dirty\n');

      const result = await gitGuard(realSubdir);
      assert('AC(i): gitGuard returns ok:false with genuine user dirt inside the subdir',
        result.ok === false);
      assert('AC(i): reason is "dirty-tree"', result.reason === 'dirty-tree');
    } catch (err) {
      assert(`AC(i) sub-case 2: unexpected exception — ${err && err.message}`, false);
    } finally {
      cleanup(gitRoot);
    }
  }
}

// ── AC(h): unrelated pre-existing lines preserved verbatim ─────────────────

function acH_unrelatedLinesPreserved() {
  console.log('\n=== AC(h): unrelated pre-existing info/exclude lines preserved ===\n');
  const root = makeGitRoot();
  try {
    const excludePath = excludePathFor(root);
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const preExisting = '*.log\nnode_modules/\n# a custom comment\n';
    fs.writeFileSync(excludePath, preExisting, 'utf8');

    const result = ensureGitExcludes(root);
    assert('AC(h): ensureGitExcludes returns true', result === true);

    const content = fs.readFileSync(excludePath, 'utf8');
    assert('AC(h): "*.log" preserved verbatim', hasLine(content, '*.log'));
    assert('AC(h): "node_modules/" preserved verbatim', hasLine(content, 'node_modules/'));
    assert('AC(h): "# a custom comment" preserved verbatim', hasLine(content, '# a custom comment'));
    assert('AC(h): marker also present', hasLine(content, MARKER));
    for (const p of sixPatterns('')) {
      assert(`AC(h): pattern also present — ${p}`, hasLine(content, p));
    }
  } catch (err) {
    assert(`AC(h): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }
}

// ── AC(j): bundle pattern — rooted, rel-prefixed, and idempotent ──────────

function acJ_bundlePattern() {
  console.log('\n=== AC(j): bundle pattern (/*.bundle.json) ===\n');

  // Toplevel case: marker + '/*.bundle.json' after it; second call is
  // idempotent (byte-identical, pattern appears exactly once).
  const root = makeGitRoot();
  try {
    const result = ensureGitExcludes(root);
    assert('AC(j): ensureGitExcludes returns true', result === true);

    const excludePath = excludePathFor(root);
    const content = fs.readFileSync(excludePath, 'utf8');

    assert('AC(j): "/*.bundle.json" present as a whole line', hasLine(content, '/*.bundle.json'));

    const lines = content.split('\n');
    const markerIdx = lines.findIndex((l) => l.trim() === MARKER);
    const bundleIdx = lines.findIndex((l) => l.trim() === '/*.bundle.json');
    assert('AC(j): marker line found', markerIdx !== -1);
    assert('AC(j): "/*.bundle.json" appears after the marker line', bundleIdx > markerIdx);

    const result2 = ensureGitExcludes(root);
    assert('AC(j): second ensureGitExcludes call returns true', result2 === true);
    const content2 = fs.readFileSync(excludePath, 'utf8');
    assert('AC(j): second call leaves file byte-identical', content2 === content);
    assert('AC(j): "/*.bundle.json" appears exactly once after second call',
      countLine(content2, '/*.bundle.json') === 1);
  } catch (err) {
    assert(`AC(j) (toplevel): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(root);
  }

  // Subdir case (fresh fixture, so the toplevel-rooted pattern was never
  // written): ensureGitExcludes(subdir) → rel-prefixed '/<rel>/*.bundle.json'
  // present, un-rooted '/*.bundle.json' absent.
  const gitRoot2 = makeGitRoot();
  try {
    const realGitRoot2 = fs.realpathSync(gitRoot2);
    const subRel2 = path.join('nested', 'project');
    const subdir2 = path.join(realGitRoot2, subRel2);
    fs.mkdirSync(subdir2, { recursive: true });
    const realSubdir2 = fs.realpathSync(subdir2);

    const result3 = ensureGitExcludes(realSubdir2);
    assert('AC(j): ensureGitExcludes (subdir) returns true', result3 === true);

    const excludePath2 = excludePathFor(realGitRoot2);
    const content3 = fs.readFileSync(excludePath2, 'utf8');
    const rel2 = path.relative(realGitRoot2, realSubdir2).split(path.sep).join('/');
    const rootedBundle2 = `/${rel2}/*.bundle.json`;

    assert('AC(j): rel-prefixed "/<rel>/*.bundle.json" present (subdir)',
      hasLine(content3, rootedBundle2));
    assert('AC(j): un-rooted "/*.bundle.json" absent (subdir)',
      !hasLine(content3, '/*.bundle.json'));
  } catch (err) {
    assert(`AC(j) (subdir): unexpected exception — ${err && err.message}`, false);
  } finally {
    cleanup(gitRoot2);
  }
}

// ── main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== git-excludes.js + git-guard.js Tests ===\n');

  // Module-top ordering: `delete process.env.CC_ORCH_ACTIVE_RUN;` runs
  // before any import in this file (see line 1, above every import
  // statement); by the time main() runs, the marker must be unset.
  assert('module-top: CC_ORCH_ACTIVE_RUN cleared before imports ran',
    process.env.CC_ORCH_ACTIVE_RUN === undefined);

  acA_and_acB();
  acC_lineWiseUpgrade();
  acD_subdirPrefix();
  acE_nonGitRoot();
  acF_productionShapedFiring();
  await acG_guardOrder();
  await acI_subdirGuardResolution();
  acH_unrelatedLinesPreserved();
  acJ_bundlePattern();

  console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
