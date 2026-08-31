/**
 * test-thin-preflight.js — Unit tests for the thin-loop preflight module
 * (M1 blueprint v3 §范围-in item 1/5): strict clean-tree check, envelope
 * clamp, input discovery, base sha capture.
 * Run: node test/test-thin-preflight.js
 */
import assert from 'assert';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assertCleanTreeStrict,
  checkEnvelope,
  discoverInputs,
  preflight,
  THIN_CLAMP,
} from '../src/orchestrator/core/thin-preflight.js';

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

// -- fixtures ---------------------------------------------------------------

const tmpDirs = [];

/** Fresh temp dir with an initialized git repo and one committed file. */
function makeGitProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-preflight-'));
  tmpDirs.push(root);
  const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, stdio: 'pipe' });
  git('init -q');
  git('config user.email t@t');
  git('config user.name t');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
  // Mirror real projects: ephemeral spec inputs are gitignored, so the
  // strict clean check (porcelain) does not see them.
  fs.writeFileSync(path.join(root, '.gitignore'), '*.spec.*\n');
  git('add -A');
  git('commit -qm seed');
  return root;
}

/**
 * Write a spec pair + accept file into `root`. Overridable knobs for the
 * clamp tests.
 */
function writeSpecInputs(root, {
  name = 'demo.spec',
  targetFiles = ['a.js', 'b.js'],
  criteria = ['c1', 'c2'],
  mdLines = 40,
  withJson = true,
  withAccept = true,
} = {}) {
  const mdPath = path.join(root, `${name}.md`);
  fs.writeFileSync(mdPath, Array.from({ length: mdLines }, (_, i) => `line ${i}`).join('\n') + '\n');
  if (withJson) {
    fs.writeFileSync(
      path.join(root, `${name}.json`),
      JSON.stringify({ goal: 'g', target_files: targetFiles, acceptance_criteria: criteria })
    );
  }
  if (withAccept) {
    fs.writeFileSync(path.join(root, `${name}.accept.mjs`), 'process.exit(0);\n');
  }
  return mdPath;
}

function cleanupTempProjects() {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// -- assertCleanTreeStrict --------------------------------------------------

test('TC1: pristine repo passes the strict clean check', () => {
  const root = makeGitProject();
  const r = assertCleanTreeStrict(root);
  assert.strictEqual(r.clean, true);
  assert.deepStrictEqual(r.entries, []);
});

test('TC2: tracked modification fails the strict clean check with the file listed', () => {
  const root = makeGitProject();
  fs.appendFileSync(path.join(root, 'seed.txt'), 'dirty\n');
  const r = assertCleanTreeStrict(root);
  assert.strictEqual(r.clean, false);
  assert.ok(r.entries.some((e) => e.includes('seed.txt')));
});

test('TC3: untracked file ALONE fails the strict clean check (blueprint: 净 includes zero untracked)', () => {
  const root = makeGitProject();
  fs.writeFileSync(path.join(root, 'stray.txt'), 'x\n');
  const r = assertCleanTreeStrict(root);
  assert.strictEqual(r.clean, false);
  assert.ok(r.entries.some((e) => e.includes('stray.txt')));
});

// -- checkEnvelope ----------------------------------------------------------

function envelopeFor(root, knobs) {
  const mdPath = writeSpecInputs(root, knobs);
  const jsonPath = mdPath.replace(/\.md$/, '.json');
  return checkEnvelope(jsonPath, mdPath);
}

test('TC4: spec at the exact clamp boundary (tf=21, ac=11, 299 lines) is allowed', () => {
  const root = makeGitProject();
  const r = envelopeFor(root, {
    targetFiles: Array.from({ length: 21 }, (_, i) => `f${i}.js`),
    criteria: Array.from({ length: 11 }, (_, i) => `c${i}`),
    mdLines: 299,
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.reasons));
});

test('TC5: target_files > 21 is refused with a splitting hint', () => {
  const root = makeGitProject();
  const r = envelopeFor(root, { targetFiles: Array.from({ length: 22 }, (_, i) => `f${i}.js`) });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.join(' ').includes('target_files'));
});

test('TC6: acceptance criteria > 11 is refused', () => {
  const root = makeGitProject();
  const r = envelopeFor(root, { criteria: Array.from({ length: 12 }, (_, i) => `c${i}`) });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.join(' ').includes('criteria'));
});

test('TC7: spec body >= 300 lines is refused (the axis that catches the mega monolith)', () => {
  const root = makeGitProject();
  const r = envelopeFor(root, { mdLines: 300 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.join(' ').includes('lines'));
});

test('TC8: NF_THIN_CLAMP_BYPASS=1 lets an over-clamp spec through and says so', () => {
  const root = makeGitProject();
  const prev = process.env.NF_THIN_CLAMP_BYPASS;
  process.env.NF_THIN_CLAMP_BYPASS = '1';
  try {
    const r = envelopeFor(root, { mdLines: 400 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.bypassed, true);
    assert.ok(r.reasons.length > 0, 'bypassed clamp reasons stay on record (落袋自证)');
  } finally {
    if (prev === undefined) delete process.env.NF_THIN_CLAMP_BYPASS;
    else process.env.NF_THIN_CLAMP_BYPASS = prev;
  }
});

test('TC9: clamp thresholds are exported constants (Phase 1.5 re-pins them in ONE place)', () => {
  assert.strictEqual(THIN_CLAMP.maxTargetFiles, 21);
  assert.strictEqual(THIN_CLAMP.maxCriteria, 11);
  assert.strictEqual(THIN_CLAMP.maxSpecLines, 299);
});

// -- discoverInputs ---------------------------------------------------------

test('TC10: discovers the spec json sibling and the accept file', () => {
  const root = makeGitProject();
  const mdPath = writeSpecInputs(root);
  const r = discoverInputs(mdPath);
  assert.strictEqual(r.ok, true);
  assert.ok(r.specJson.endsWith('demo.spec.json'));
  assert.ok(r.acceptPath.endsWith('demo.spec.accept.mjs'));
});

test('TC11: missing accept file refuses (M1 requires the external exam)', () => {
  const root = makeGitProject();
  const mdPath = writeSpecInputs(root, { withAccept: false });
  const r = discoverInputs(mdPath);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.join(' ').includes('accept'));
});

test('TC12: missing spec.json refuses', () => {
  const root = makeGitProject();
  const mdPath = writeSpecInputs(root, { withJson: false });
  const r = discoverInputs(mdPath);
  assert.strictEqual(r.ok, false);
});

// -- preflight (combined) ---------------------------------------------------

test('TC13: combined preflight on a clean in-envelope project returns ok with a 40-char base sha', () => {
  const root = makeGitProject();
  const mdPath = writeSpecInputs(root);
  const r = preflight(mdPath, root);
  assert.strictEqual(r.ok, true, JSON.stringify(r.refusals));
  assert.match(r.baseSha, /^[0-9a-f]{40}$/);
  assert.ok(r.inputs.acceptPath);
});

test('TC14: combined preflight aggregates every refusal reason (dirty tree + over-clamp + no accept)', () => {
  const root = makeGitProject();
  const mdPath = writeSpecInputs(root, { mdLines: 400, withAccept: false });
  fs.writeFileSync(path.join(root, 'stray.txt'), 'x\n');
  const r = preflight(mdPath, root);
  assert.strictEqual(r.ok, false);
  const joined = r.refusals.join(' ');
  assert.ok(joined.includes('stray.txt'), 'lists the dirty entry');
  assert.ok(joined.includes('lines'), 'lists the clamp reason');
  assert.ok(joined.includes('accept'), 'lists the missing exam');
});


// -- review-driven additions (T1 三镜头审查补测) ------------------------------

test('TC15: discoverInputs never borrows another spec\'s accept file', () => {
  const root = makeGitProject();
  const mdPath = writeSpecInputs(root, { withAccept: false });
  fs.writeFileSync(path.join(root, 'other.spec.accept.mjs'), 'process.exit(0);\n');
  const r = discoverInputs(mdPath);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.acceptPath, undefined);
});

test('TC16: corrupt (present but unparseable) spec.json refuses and is NEVER bypassed', () => {
  const root = makeGitProject();
  const mdPath = writeSpecInputs(root);
  fs.writeFileSync(mdPath.replace(/\.md$/, '.json'), '{not json');
  const r = checkEnvelope(mdPath.replace(/\.md$/, '.json'), mdPath, { bypass: true });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.join(' ').includes('unreadable'));
});

test('TC17: NF_THIN_CLAMP_BYPASS other than exactly "1" does not bypass', () => {
  const root = makeGitProject();
  const prev = process.env.NF_THIN_CLAMP_BYPASS;
  process.env.NF_THIN_CLAMP_BYPASS = '0';
  try {
    const r = envelopeFor(root, { mdLines: 400 });
    assert.strictEqual(r.ok, false);
    assert.notStrictEqual(r.bypassed, true);
  } finally {
    if (prev === undefined) delete process.env.NF_THIN_CLAMP_BYPASS;
    else process.env.NF_THIN_CLAMP_BYPASS = prev;
  }
});

test('TC18: missing spec.md refuses with its own reason', () => {
  const root = makeGitProject();
  const mdPath = writeSpecInputs(root);
  fs.rmSync(mdPath);
  const r = discoverInputs(mdPath);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.join(' ').includes('spec md not found'));
});

test('TC19: repo with no commits (unborn HEAD) refuses instead of crashing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-preflight-unborn-'));
  tmpDirs.push(root);
  execSync('git init -q', { cwd: root });
  fs.writeFileSync(path.join(root, '.gitignore'), '*.spec.*\n');
  execSync('git config user.email t@t && git config user.name t && git add -A && git commit -qm x', { cwd: root, shell: '/bin/bash' });
  // now strip history: use a fresh unborn repo instead
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-preflight-unborn2-'));
  tmpDirs.push(root2);
  execSync('git init -q', { cwd: root2 });
  const mdPath = writeSpecInputs(root2);
  const r = preflight(mdPath, root2);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.baseSha, undefined);
  assert.ok(r.refusals.join(' ').match(/no HEAD|no commits/));
});

test('TC20: multiple accept files resolve deterministically to the lexicographic first, with a warning', () => {
  const root = makeGitProject();
  const mdPath = writeSpecInputs(root);
  fs.writeFileSync(path.join(root, 'demo.spec.accept.sh'), 'exit 0\n');
  const r = discoverInputs(mdPath);
  assert.strictEqual(r.ok, true);
  assert.ok(r.acceptPath.endsWith('.accept.mjs'), 'mjs sorts before sh');
  assert.ok(r.warnings.length === 1 && r.warnings[0].includes('multiple'));
});

test('TC21: a non-git projectRoot yields a refusal, never an exception', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-preflight-nogit-'));
  tmpDirs.push(root);
  const mdPath = writeSpecInputs(root);
  const r = preflight(mdPath, root);
  assert.strictEqual(r.ok, false);
  assert.ok(r.refusals.join(' ').includes('not a git repository'));
});

test('TC22: spec.json that parses to null or a non-object refuses consistently (no crash, no silent pass)', () => {
  const root = makeGitProject();
  for (const body of ['null', '123', '"hi"', '[]', 'true']) {
    const mdPath = writeSpecInputs(root, { name: `n${body.length}${body[0] === '"' ? 's' : body[0]}.spec` });
    fs.writeFileSync(mdPath.replace(/\.md$/, '.json'), body);
    const r = checkEnvelope(mdPath.replace(/\.md$/, '.json'), mdPath);
    assert.strictEqual(r.ok, false, `body ${body} must refuse`);
    assert.ok(r.reasons.join(' ').includes('not an object'), `body ${body} reason`);
  }
});

test('TC23: a directory matching the accept prefix is not a valid exam', () => {
  const root = makeGitProject();
  const mdPath = writeSpecInputs(root, { withAccept: false });
  fs.mkdirSync(path.join(root, 'demo.spec.accept.d'));
  const r = discoverInputs(mdPath);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.acceptPath, undefined);
});

test('TC24: per-call bypass seam works without touching process.env', () => {
  const root = makeGitProject();
  const mdPath = writeSpecInputs(root, { mdLines: 400 });
  const jsonPath = mdPath.replace(/\.md$/, '.json');
  assert.strictEqual(checkEnvelope(jsonPath, mdPath).ok, false, 'no bypass by default');
  const r = checkEnvelope(jsonPath, mdPath, { bypass: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.bypassed, true);
});

cleanupTempProjects();
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
