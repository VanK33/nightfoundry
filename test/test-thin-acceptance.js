/**
 * test-thin-acceptance.js — Unit tests for the thin-loop acceptance runner
 * (M1 blueprint v3 §范围-in item 2): exam contract, suite runner, scope
 * diff with the benign-additions whitelist, and the combined result shape.
 * Run: node test/test-thin-acceptance.js
 */
import assert from 'assert';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assembleGrade,
  parseExamOutput,
  runAcceptance,
  runSuite,
  scopeDiff,
  runAll,
} from '../src/orchestrator/core/thin-acceptance.js';

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

const tmpDirs = [];
function tmp(prefix = 'thin-accept-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function makeGitProject() {
  const root = tmp();
  const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, stdio: 'pipe' });
  git('init -q');
  git('config user.email t@t');
  git('config user.name t');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '*.spec.*\n');
  git('add -A');
  git('commit -qm seed');
  return root;
}
const headSha = (root) => execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();

/** Fake runner seam: returns a canned {status, stdout, stderr}. */
const fakeRunner = (result) => {
  const calls = [];
  const run = (cmd, opts) => {
    calls.push({ cmd, opts });
    const r = typeof result === 'function' ? result(cmd) : result;
    return r;
  };
  return { run, calls };
};

// -- parseExamOutput --------------------------------------------------------

test('TC1: parses PASS/FAIL lines into per-assert records and counts', () => {
  const r = parseExamOutput('PASS a works\nnoise line\nFAIL b broke\nPASS c ok\n');
  assert.strictEqual(r.pass, 2);
  assert.strictEqual(r.fail, 1);
  assert.deepStrictEqual(r.lines[1], { status: 'FAIL', label: 'b broke' });
});

test('TC2: exam output with no PASS/FAIL lines yields zero counts (not a crash)', () => {
  const r = parseExamOutput('completely silent\n');
  assert.strictEqual(r.pass, 0);
  assert.strictEqual(r.fail, 0);
});

// -- runAcceptance ----------------------------------------------------------

test('TC3: green exam (exit 0) -> ok:true with parsed lines', () => {
  const { run } = fakeRunner({ status: 0, stdout: 'PASS one\nPASS two\n', stderr: '' });
  const r = runAcceptance('/x/demo.spec.accept.mjs', '/proj', { run });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.pass, 2);
  assert.strictEqual(r.fail, 0);
});

test('TC4: red exam (exit 1) -> ok:false and the FAIL labels are surfaced', () => {
  const { run } = fakeRunner({ status: 1, stdout: 'PASS one\nFAIL two broke\n', stderr: '' });
  const r = runAcceptance('/x/demo.spec.accept.mjs', '/proj', { run });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.failLabels, ['two broke']);
});

test('TC5: exit 0 but FAIL lines present -> ok:false (never trust exit code over the lines)', () => {
  const { run } = fakeRunner({ status: 0, stdout: 'FAIL sneaky\n', stderr: '' });
  const r = runAcceptance('/x/demo.spec.accept.mjs', '/proj', { run });
  assert.strictEqual(r.ok, false);
});

test('TC6: unrunnable exam is an explicit error, never a silent green', () => {
  const { run } = fakeRunner(() => {
    throw new Error('spawn ENOENT');
  });
  const r = runAcceptance('/x/demo.spec.accept.xyz', '/proj', { run });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error && r.error.includes('ENOENT'));
});

test('TC7: interpreter dispatch by extension (mjs->node, py->python, sh->bash)', () => {
  const seen = [];
  const { run } = fakeRunner((cmd) => {
    seen.push(cmd);
    return { status: 0, stdout: '', stderr: '' };
  });
  runAcceptance('/x/a.accept.mjs', '/proj', { run });
  runAcceptance('/x/a.accept.py', '/proj', { run });
  runAcceptance('/x/a.accept.sh', '/proj', { run });
  assert.ok(seen[0][0].includes('node'));
  assert.ok(seen[1][0].includes('python'));
  assert.ok(seen[2][0].includes('bash'));
});

test('TC8: real execution integration — a real node exam runs from the PROJECT ROOT cwd', () => {
  const root = makeGitProject();
  const exam = path.join(root, 'demo.spec.accept.mjs');
  fs.writeFileSync(
    exam,
    "import fs from 'fs';\nconsole.log(fs.existsSync('seed.txt') ? 'PASS cwd-is-project-root' : 'FAIL cwd-is-project-root');\nprocess.exit(fs.existsSync('seed.txt') ? 0 : 1);\n"
  );
  const r = runAcceptance(exam, root);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.lines[0].label, 'cwd-is-project-root');
});

// -- runSuite ---------------------------------------------------------------

test('TC9: suite runner reports exit-code green/red and keeps the output tail', () => {
  const { run } = fakeRunner({ status: 0, stdout: 'lots\nof\noutput\n42 passed\n', stderr: '' });
  const g = runSuite('/proj', 'run-my-tests', { run });
  assert.strictEqual(g.ok, true);
  assert.ok(g.tail.includes('42 passed'));
  const { run: run2 } = fakeRunner({ status: 2, stdout: '1 failed\n', stderr: '' });
  const b = runSuite('/proj', 'run-my-tests', { run: run2 });
  assert.strictEqual(b.ok, false);
});

test('TC10: missing testAllCommand is an explicit skip, not a green', () => {
  const r = runSuite('/proj', undefined, { run: () => ({ status: 0, stdout: '', stderr: '' }) });
  assert.strictEqual(r.skipped, true);
  assert.notStrictEqual(r.ok, true);
});

// -- scopeDiff --------------------------------------------------------------

test('TC11: modified in-target file is in changed, not out-of-scope', () => {
  const root = makeGitProject();
  const base = headSha(root);
  fs.appendFileSync(path.join(root, 'seed.txt'), 'x\n');
  const r = scopeDiff(root, base, ['seed.txt']);
  assert.deepStrictEqual(r.changed, ['seed.txt']);
  assert.deepStrictEqual(r.outOfScope, []);
});

test('TC12: modified NON-target file is out-of-scope (whitelist covers only additions)', () => {
  const root = makeGitProject();
  fs.writeFileSync(path.join(root, 'notes.md'), 'v1\n');
  execSync('git add -A && git commit -qm add-notes', { cwd: root, shell: '/bin/bash' });
  const base = headSha(root);
  fs.appendFileSync(path.join(root, 'notes.md'), 'v2\n');
  const r = scopeDiff(root, base, ['seed.txt']);
  assert.deepStrictEqual(r.outOfScope, ['notes.md'], 'modifying an existing .md is NOT whitelisted');
});

test('TC13: newly added test file and new .md are whitelisted, other additions are out-of-scope', () => {
  const root = makeGitProject();
  const base = headSha(root);
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test/test-new-thing.js'), '// t\n');
  fs.writeFileSync(path.join(root, 'DESIGN.md'), 'doc\n');
  fs.writeFileSync(path.join(root, 'rogue.js'), '// r\n');
  const r = scopeDiff(root, base, ['seed.txt']);
  assert.ok(r.whitelisted.includes('test/test-new-thing.js'));
  assert.ok(r.whitelisted.includes('DESIGN.md'));
  assert.deepStrictEqual(r.outOfScope, ['rogue.js']);
});

test('TC14: untracked additions are seen without being staged', () => {
  const root = makeGitProject();
  const base = headSha(root);
  fs.writeFileSync(path.join(root, 'stray.js'), 'x\n');
  const r = scopeDiff(root, base, []);
  assert.ok(r.changed.includes('stray.js'));
  assert.ok(r.outOfScope.includes('stray.js'));
});

// -- runAll -----------------------------------------------------------------

test('TC15: combined result carries all three sections and an overall red flag', () => {
  const root = makeGitProject();
  const base = headSha(root);
  const exam = path.join(root, 'demo.spec.accept.mjs');
  fs.writeFileSync(exam, "console.log('FAIL broken thing');\nprocess.exit(1);\n");
  const r = runAll({
    acceptPath: exam,
    projectRoot: root,
    baseSha: base,
    targetFiles: ['seed.txt'],
    testAllCommand: undefined,
  });
  assert.strictEqual(r.acceptance.ok, false);
  assert.strictEqual(r.suite.skipped, true);
  assert.deepStrictEqual(r.scope.outOfScope, []);
  assert.strictEqual(r.green, false);
  assert.ok(r.redList.some((l) => l.includes('broken thing')), 'red list carries the FAIL label');
});

test('TC16: fully green combined run (real exam, no suite, clean scope) -> green:true, empty red list', () => {
  const root = makeGitProject();
  const base = headSha(root);
  const exam = path.join(root, 'demo.spec.accept.mjs');
  fs.writeFileSync(exam, "console.log('PASS all good');\nprocess.exit(0);\n");
  const r = runAll({
    acceptPath: exam,
    projectRoot: root,
    baseSha: base,
    targetFiles: [],
    testAllCommand: undefined,
  });
  assert.strictEqual(r.green, true, JSON.stringify(r.redList));
  assert.deepStrictEqual(r.redList, []);
});

test('TC17: out-of-scope edits enter the red list', () => {
  const root = makeGitProject();
  const base = headSha(root);
  const exam = path.join(root, 'demo.spec.accept.mjs');
  fs.writeFileSync(exam, "console.log('PASS ok');\nprocess.exit(0);\n");
  fs.writeFileSync(path.join(root, 'rogue.js'), 'x\n');
  const r = runAll({
    acceptPath: exam,
    projectRoot: root,
    baseSha: base,
    targetFiles: [],
    testAllCommand: undefined,
  });
  assert.strictEqual(r.green, false);
  assert.ok(r.redList.some((l) => l.includes('rogue.js')));
});


// -- review-driven additions (T2 三镜头审查补测) ------------------------------

test('TC18: runAll with a RED suite -> green:false and the suite tail enters the red list', () => {
  const root = makeGitProject();
  const base = headSha(root);
  const exam = path.join(root, 'demo.spec.accept.mjs');
  fs.writeFileSync(exam, "console.log('PASS fine');\nprocess.exit(0);\n");
  const run = (cmd, opts) => {
    if (Array.isArray(cmd)) return { status: 0, stdout: 'PASS fine\n', stderr: '' };
    if (typeof cmd === 'string' && cmd.includes('suite-cmd')) return { status: 1, stdout: '3 failed: test_x\n', stderr: '' };
    return { status: 0, stdout: execSync(cmd, { cwd: opts.cwd, encoding: 'utf8' }), stderr: '' };
  };
  const r = runAll({ acceptPath: exam, projectRoot: root, baseSha: base, targetFiles: [], testAllCommand: 'suite-cmd', deps: { run } });
  assert.strictEqual(r.green, false);
  assert.ok(r.redList.some((l) => l.includes('test suite red') && l.includes('test_x')));
});

test('TC19: runAll with a GREEN suite keeps green:true', () => {
  const root = makeGitProject();
  const base = headSha(root);
  const exam = path.join(root, 'demo.spec.accept.mjs');
  fs.writeFileSync(exam, "console.log('PASS fine');\nprocess.exit(0);\n");
  const run = (cmd, opts) => {
    if (Array.isArray(cmd)) return { status: 0, stdout: 'PASS fine\n', stderr: '' };
    if (typeof cmd === 'string' && cmd.includes('suite-cmd')) return { status: 0, stdout: 'all good\n', stderr: '' };
    return { status: 0, stdout: execSync(cmd, { cwd: opts.cwd, encoding: 'utf8' }), stderr: '' };
  };
  const r = runAll({ acceptPath: exam, projectRoot: root, baseSha: base, targetFiles: [], testAllCommand: 'suite-cmd', deps: { run } });
  assert.strictEqual(r.suite.ok, true);
  assert.strictEqual(r.green, true, JSON.stringify(r.redList));
});

test('TC20: runAll with an unrunnable exam puts an acceptance error on the red list', () => {
  const root = makeGitProject();
  const base = headSha(root);
  const run = (cmd, opts) => {
    if (Array.isArray(cmd)) throw new Error('spawn ENOENT');
    return { status: 0, stdout: execSync(cmd, { cwd: opts.cwd, encoding: 'utf8' }), stderr: '' };
  };
  const r = runAll({ acceptPath: '/x/gone.accept.mjs', projectRoot: root, baseSha: base, targetFiles: [], testAllCommand: undefined, deps: { run } });
  assert.strictEqual(r.green, false);
  assert.ok(r.redList.some((l) => l.includes('acceptance error')));
});

test('TC21: runSuite whose command throws is an explicit unrunnable error, never green', () => {
  const r = runSuite('/proj', 'boom', { run: () => { throw new Error('spawn EACCES'); } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('unrunnable'));
});

test('TC22: runAcceptance preserves a stderr tail (last lines) for diagnostics', () => {
  const { run } = fakeRunner({ status: 1, stdout: 'FAIL x\n', stderr: Array.from({ length: 20 }, (_, i) => `e${i}`).join('\n') });
  const r = runAcceptance('/x/a.accept.mjs', '/p', { run });
  assert.ok(r.stderrTail.includes('e19') && !r.stderrTail.includes('e5'), 'keeps the LAST lines only');
});

test('TC23: extension without a known interpreter dispatches to the file itself', () => {
  const seen = [];
  const { run } = fakeRunner((cmd) => { seen.push(cmd); return { status: 0, stdout: 'PASS x\n', stderr: '' }; });
  runAcceptance('/x/a.accept.xyz', '/p', { run });
  assert.deepStrictEqual(seen[0], ['/x/a.accept.xyz']);
});

test('TC24: runSuite tail merges stderr and truncates to the last 15 lines', () => {
  const out = Array.from({ length: 20 }, (_, i) => `o${i}`).join('\n');
  const { run } = fakeRunner({ status: 1, stdout: out, stderr: 'the-error-line' });
  const r = runSuite('/p', 'cmd', { run });
  assert.ok(r.tail.includes('the-error-line'));
  assert.ok(!r.tail.includes('o3'), 'older lines truncated');
  assert.ok(r.tail.split('\n').length <= 15);
});

test('TC25: real python and bash exams actually run (interpreter dispatch end to end)', () => {
  const root = makeGitProject();
  const py = path.join(root, 'p.spec.accept.py');
  fs.writeFileSync(py, "print('PASS from-python')\n");
  const rp = runAcceptance(py, root);
  assert.strictEqual(rp.ok, true, JSON.stringify(rp));
  const sh = path.join(root, 's.spec.accept.sh');
  fs.writeFileSync(sh, "echo 'PASS from-bash'\nexit 0\n");
  const rs = runAcceptance(sh, root);
  assert.strictEqual(rs.ok, true, JSON.stringify(rs));
});

test('TC26: zero-assertion floor — exam exiting 0 with no PASS/FAIL lines is an error, not a green', () => {
  const { run } = fakeRunner({ status: 0, stdout: 'did stuff, printed nothing standard\n', stderr: '' });
  const r = runAcceptance('/x/a.accept.mjs', '/p', { run });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('zero-assertion'));
});

test('TC27: modifying an EXISTING test file is out-of-scope (whitelist is additions-only)', () => {
  const root = makeGitProject();
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test/test-old.js'), 'v1\n');
  execSync('git add -A && git commit -qm t', { cwd: root, shell: '/bin/bash' });
  const base = headSha(root);
  fs.appendFileSync(path.join(root, 'test/test-old.js'), 'v2\n');
  const r = scopeDiff(root, base, []);
  assert.deepStrictEqual(r.outOfScope, ['test/test-old.js']);
});


test('TC28: non-ASCII (中文) target path matches verbatim — no quotePath false-red', () => {
  const root = makeGitProject();
  fs.writeFileSync(path.join(root, '中文文件.txt'), 'v1\n');
  execSync('git add -A && git commit -qm cn', { cwd: root, shell: '/bin/bash' });
  const base = headSha(root);
  fs.appendFileSync(path.join(root, '中文文件.txt'), 'v2\n');
  const r = scopeDiff(root, base, ['中文文件.txt']);
  assert.deepStrictEqual(r.outOfScope, [], JSON.stringify(r));
  assert.ok(r.changed.includes('中文文件.txt'));
});

test('TC29: CRLF exam output parses PASS/FAIL lines with clean labels', () => {
  const r = parseExamOutput('PASS a-ok\r\nFAIL b-bad\r\n');
  assert.strictEqual(r.pass, 1);
  assert.strictEqual(r.fail, 1);
  assert.strictEqual(r.lines[1].label, 'b-bad', 'no trailing CR in the label');
});

test('TC30: a hung exam is killed by the timeout and reported as an explicit error', () => {
  const root = makeGitProject();
  const exam = path.join(root, 'hang.spec.accept.mjs');
  fs.writeFileSync(exam, 'for(;;){}\n');
  const r = runAcceptance(exam, root, { examTimeoutMs: 500 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error && /killed|timed[ _]?out|ETIMEDOUT/i.test(r.error), JSON.stringify(r));
});

test('TC31: a rename surfaces both paths (old visible, new whitelistable)', () => {
  const root = makeGitProject();
  fs.writeFileSync(path.join(root, 'plain.js'), 'x\n');
  execSync('git add -A && git commit -qm p', { cwd: root, shell: '/bin/bash' });
  const base = headSha(root);
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  execSync('git mv plain.js test/test-renamed.js', { cwd: root, shell: '/bin/bash' });
  const r = scopeDiff(root, base, []);
  assert.ok(r.changed.includes('plain.js'), 'old path visible as a change');
  assert.ok(r.whitelisted.includes('test/test-renamed.js'), 'new path enters the additions whitelist');
});

test('TC32: split seams — runAll can take distinct argv and shell runners', () => {
  const root = makeGitProject();
  const base = headSha(root);
  const argvCalls = [];
  const shellCalls = [];
  const r = runAll({
    acceptPath: '/x/a.accept.mjs', projectRoot: root, baseSha: base, targetFiles: [],
    testAllCommand: 'suite-cmd',
    deps: {
      runArgv: (cmd) => { argvCalls.push(cmd); return { status: 0, stdout: 'PASS x\n', stderr: '' }; },
      runShell: (cmd, opts) => {
        shellCalls.push(cmd);
        if (cmd === 'suite-cmd') return { status: 0, stdout: 'ok\n', stderr: '' };
        return { status: 0, stdout: execSync(cmd, { cwd: opts.cwd, encoding: 'utf8' }), stderr: '' };
      },
    },
  });
  assert.strictEqual(r.green, true, JSON.stringify(r.redList));
  assert.ok(Array.isArray(argvCalls[0]), 'exam went through the argv seam');
  assert.ok(shellCalls.includes('suite-cmd'), 'suite went through the shell seam');
});

for (const dir of tmpDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
test('TC33: an exam-level error surfaces as a synthetic exam-error fail label (suspected-defect channel food)', () => {
  const g = assembleGrade({
    acceptance: { ok: false, pass: 0, fail: 0, lines: [], failLabels: [], error: 'exam produced no PASS/FAIL assertions (zero-assertion floor)' },
    suite: { skipped: true },
    scope: { changed: [], outOfScope: [], whitelisted: [] },
  });
  assert.strictEqual(g.green, false);
  assert.ok(g.failLabels.some((l) => l.startsWith('exam-error: ')), JSON.stringify(g.failLabels));
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
