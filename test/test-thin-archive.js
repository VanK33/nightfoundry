/**
 * test-thin-archive.js — T5: the thin loop's archive writer (落袋) and its
 * self-audit reconstruction (M1 blueprint v3 §范围-in item 4 and the gate
 * table's 落袋自证 row).
 * Run: node test/test-thin-archive.js
 */
import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeThinArchive, rebuildGateNumbers } from '../src/orchestrator/core/thin-archive.js';

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
function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-archive-'));
  tmpDirs.push(root);
  fs.mkdirSync(path.join(root, 'archives'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo.spec.md'), '# spec\n');
  fs.writeFileSync(path.join(root, 'demo.spec.json'), '{"goal":"g","target_files":[]}');
  fs.writeFileSync(path.join(root, 'demo.spec.accept.mjs'), 'process.exit(0);\n');
  return root;
}

function outcomeFixture(overrides = {}) {
  return {
    outcome: 'delivered',
    parkReason: undefined,
    transitions: [{ from: 'try1', to: 'inplace-fix', reason: 'red', residualReds: 2 }],
    suspectedAcceptanceDefects: [],
    recordErrors: [],
    tries: [
      {
        kind: 'fresh',
        grade: {
          green: false,
          redList: ['acceptance FAIL: x'],
          failLabels: ['x'],
          acceptance: { pass: 3, fail: 1, lines: [{ status: 'FAIL', label: 'x' }] },
          suite: { ok: true, exitCode: 0 },
          scope: { changed: ['a.js'], outOfScope: [], whitelisted: [] },
        },
      },
      {
        kind: 'inplace-fix',
        grade: {
          green: true,
          redList: [],
          failLabels: [],
          acceptance: { pass: 4, fail: 0, lines: [] },
          suite: { ok: true, exitCode: 0 },
          scope: { changed: ['a.js'], outOfScope: [], whitelisted: [] },
        },
      },
    ],
    ...overrides,
  };
}

function paramsFor(root, overrides = {}) {
  return {
    projectRoot: root,
    slug: 'demo',
    specMdPath: path.join(root, 'demo.spec.md'),
    specJsonPath: path.join(root, 'demo.spec.json'),
    acceptPath: path.join(root, 'demo.spec.accept.mjs'),
    baseSha: 'a'.repeat(40),
    modelId: 'claude-test-1',
    loopOutcome: outcomeFixture(),
    tryStats: [
      { costUsd: 1.25, durationMs: 60000, turns: 12 },
      { costUsd: 0.5, durationMs: 30000, turns: 4 },
    ],
    mechTimingsMs: { acceptance: 400, suite: 5200, orchestration: 150 },
    finalDiffStat: ' a.js | 2 +-\n 1 file changed',
    ...overrides,
  };
}

// -- writeThinArchive -------------------------------------------------------

test('TC1: writes a sequenced thin archive dir with the input snapshots and their sha256 manifest', () => {
  const root = makeProject();
  const r = writeThinArchive(paramsFor(root));
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(path.basename(r.archiveDir), /^\d{3}-thin-demo$/);
  for (const f of ['demo.spec.md', 'demo.spec.json', 'demo.spec.accept.mjs', 'MANIFEST.sha256', 'record.json']) {
    assert.ok(fs.existsSync(path.join(r.archiveDir, f)), `missing ${f}`);
  }
  const manifest = fs.readFileSync(path.join(r.archiveDir, 'MANIFEST.sha256'), 'utf8');
  for (const f of ['demo.spec.md', 'demo.spec.json', 'demo.spec.accept.mjs']) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');
    assert.ok(manifest.includes(sha), `${f} sha256 recorded`);
    assert.strictEqual(
      fs.readFileSync(path.join(r.archiveDir, f), 'utf8'),
      fs.readFileSync(path.join(root, f), 'utf8'),
      `${f} snapshot content identical`
    );
  }
});

test('TC2: record.json carries every blueprint-pinned field', () => {
  const root = makeProject();
  const r = writeThinArchive(paramsFor(root));
  const rec = JSON.parse(fs.readFileSync(path.join(r.archiveDir, 'record.json'), 'utf8'));
  assert.strictEqual(rec.schema, 'thin-v1');
  assert.strictEqual(rec.baseSha, 'a'.repeat(40));
  assert.strictEqual(rec.modelId, 'claude-test-1');
  assert.strictEqual(rec.outcome, 'delivered');
  assert.strictEqual(rec.tries.length, 2);
  assert.deepStrictEqual(rec.tries[0].stats, { costUsd: 1.25, durationMs: 60000, turns: 12 });
  assert.ok(rec.tries[0].grade.acceptance.lines, 'per-assert acceptance results survive (the v2 lesson)');
  assert.deepStrictEqual(rec.mechTimingsMs, { acceptance: 400, suite: 5200, orchestration: 150 });
  assert.ok(Array.isArray(rec.transitions) && rec.transitions.length === 1);
  assert.strictEqual(rec.transitions[0].residualReds, 2, 'transition payload survives verbatim');
  assert.strictEqual(rec.finalDiffStat.includes('a.js'), true);
});

test('TC3: sequence numbers continue after existing archives', () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, 'archives', '041-old-run'), { recursive: true });
  const r = writeThinArchive(paramsFor(root));
  assert.strictEqual(path.basename(r.archiveDir), '042-thin-demo');
});

test('TC4: a parked outcome archives just as completely, with parkReason and suspects', () => {
  const root = makeProject();
  const r = writeThinArchive(
    paramsFor(root, {
      loopOutcome: outcomeFixture({
        outcome: 'parked',
        parkReason: 'still red; suspected acceptance defects: x',
        suspectedAcceptanceDefects: ['x'],
      }),
    })
  );
  const rec = JSON.parse(fs.readFileSync(path.join(r.archiveDir, 'record.json'), 'utf8'));
  assert.strictEqual(rec.outcome, 'parked');
  assert.ok(rec.parkReason.includes('suspected'));
  assert.deepStrictEqual(rec.suspectedAcceptanceDefects, ['x']);
});

test('TC5: writer never throws — an unwritable archives root reports ok:false with the reason', () => {
  const root = makeProject();
  const blocker = path.join(root, 'blocker-file');
  fs.writeFileSync(blocker, 'x');
  const r = writeThinArchive(paramsFor(root, { projectRoot: path.join(blocker, 'sub') }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error && r.error.length > 0);
});

test('TC6: tries/stats length mismatch is tolerated and recorded, not fatal', () => {
  const root = makeProject();
  const r = writeThinArchive(paramsFor(root, { tryStats: [{ costUsd: 1, durationMs: 1000, turns: 1 }] }));
  assert.ok(r.ok);
  const rec = JSON.parse(fs.readFileSync(path.join(r.archiveDir, 'record.json'), 'utf8'));
  assert.strictEqual(rec.tries.length, 2);
  assert.strictEqual(rec.tries[1].stats, null);
});

// -- rebuildGateNumbers (落袋自证) ------------------------------------------

test('TC7: the gate columns can be rebuilt from the archive alone', () => {
  const root = makeProject();
  const r = writeThinArchive(paramsFor(root));
  const g = rebuildGateNumbers(r.archiveDir);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.outcome, 'delivered');
  assert.strictEqual(g.finalAcceptancePass, 4);
  assert.strictEqual(g.finalAcceptanceFail, 0);
  assert.strictEqual(g.firstTryGreen, false, 'first-try pass rate column');
  assert.strictEqual(g.tries, 2);
  assert.strictEqual(g.totalCostUsd, 1.75);
  assert.strictEqual(g.sessionWallMs, 90000);
  assert.strictEqual(g.totalWallMs, 95750, 'gate premium row = sessions PLUS mechanical steps');
  assert.deepStrictEqual(g.mechTimingsMs, { acceptance: 400, suite: 5200, orchestration: 150 });
});

test('TC8: reconstruction fails loudly when a required field is missing (self-audit is real)', () => {
  const root = makeProject();
  const r = writeThinArchive(paramsFor(root));
  const recPath = path.join(r.archiveDir, 'record.json');
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  delete rec.tries[0].stats;
  fs.writeFileSync(recPath, JSON.stringify(rec));
  const g = rebuildGateNumbers(r.archiveDir);
  assert.strictEqual(g.ok, false);
  assert.ok(g.missing.length > 0);
});

test('TC9: reconstruction of a parked archive reports the park columns', () => {
  const root = makeProject();
  const r = writeThinArchive(
    paramsFor(root, { loopOutcome: outcomeFixture({ outcome: 'parked', parkReason: 'nope' }) })
  );
  const g = rebuildGateNumbers(r.archiveDir);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.outcome, 'parked');
  assert.strictEqual(g.parkReason, 'nope');
});


test('TC10: a malformed acceptance (non-numeric pass/fail) fails the self-audit loudly', () => {
  const root = makeProject();
  const r = writeThinArchive(paramsFor(root));
  const recPath = path.join(r.archiveDir, 'record.json');
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  rec.tries[1].grade.acceptance = { lines: [] };
  fs.writeFileSync(recPath, JSON.stringify(rec));
  const g = rebuildGateNumbers(r.archiveDir);
  assert.strictEqual(g.ok, false);
  assert.ok(g.missing.some((m) => m.includes('numeric')));
});

test('TC11: a mid-write failure leaves NO partial archive dir behind', () => {
  const root = makeProject();
  const r = writeThinArchive(paramsFor(root, { specJsonPath: path.join(root, 'gone.spec.json') }));
  assert.strictEqual(r.ok, false);
  const leftovers = fs.readdirSync(path.join(root, 'archives')).filter((n) => n.includes('thin'));
  assert.deepStrictEqual(leftovers, [], 'no half-written archive committed-able residue');
});

test('TC12: a pre-existing dir at the computed seq advances to the next number instead of failing', () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, 'archives', '001-thin-demo'), { recursive: true });
  const r = writeThinArchive(paramsFor(root));
  assert.ok(r.ok);
  assert.strictEqual(path.basename(r.archiveDir), '002-thin-demo');
});


test('TC13: every required field independently fails the self-audit when broken', () => {
  const breakers = [
    ['outcome', (rec) => { delete rec.outcome; }],
    ['baseSha', (rec) => { delete rec.baseSha; }],
    ['modelId', (rec) => { delete rec.modelId; }],
    ['mechTimingsMs', (rec) => { rec.mechTimingsMs = null; }],
    ['tries', (rec) => { rec.tries = []; }],
    ['grade.acceptance', (rec) => { delete rec.tries[0].grade.acceptance; }],
  ];
  for (const [label, breakIt] of breakers) {
    const root = makeProject();
    const r = writeThinArchive(paramsFor(root));
    const recPath = path.join(r.archiveDir, 'record.json');
    const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
    breakIt(rec);
    fs.writeFileSync(recPath, JSON.stringify(rec));
    const g = rebuildGateNumbers(r.archiveDir);
    assert.strictEqual(g.ok, false, `${label} missing must fail the audit`);
    assert.ok(g.missing.length > 0, `${label}: missing list populated`);
  }
});

test('TC14: cost totals are rounded to cents (0.1 + 0.2 = 0.3, not 0.30000000000000004)', () => {
  const root = makeProject();
  const r = writeThinArchive(paramsFor(root, {
    tryStats: [{ costUsd: 0.1, durationMs: 1, turns: 1 }, { costUsd: 0.2, durationMs: 1, turns: 1 }],
  }));
  const g = rebuildGateNumbers(r.archiveDir);
  assert.strictEqual(g.totalCostUsd, 0.3);
});

test('TC15: recordErrors survive into record.json verbatim', () => {
  const root = makeProject();
  const r = writeThinArchive(paramsFor(root, {
    loopOutcome: outcomeFixture({ recordErrors: ['record failed at a->b: disk full'] }),
  }));
  const rec = JSON.parse(fs.readFileSync(path.join(r.archiveDir, 'record.json'), 'utf8'));
  assert.deepStrictEqual(rec.recordErrors, ['record failed at a->b: disk full']);
});

test('TC16: a first-try green run reports firstTryGreen:true', () => {
  const root = makeProject();
  const one = outcomeFixture();
  one.tries = [{ ...one.tries[1], kind: 'fresh' }];
  one.transitions = [];
  const r = writeThinArchive(paramsFor(root, { loopOutcome: one, tryStats: [{ costUsd: 1, durationMs: 1000, turns: 2 }] }));
  const g = rebuildGateNumbers(r.archiveDir);
  assert.strictEqual(g.firstTryGreen, true);
});


test('TC18: rebuildGateNumbers prefers the measured totalElapsedMs over the additive fallback', () => {
  const root = makeProject();
  const r = writeThinArchive(paramsFor(root, { totalElapsedMs: 99999 }));
  assert.ok(r.ok, r.error);
  const g = rebuildGateNumbers(r.archiveDir);
  assert.ok(g.ok, JSON.stringify(g.missing));
  assert.strictEqual(g.totalWallMs, 99999, 'measured elapsed must win over sessions+mech');
});

test('TC17: a snapshotRef carried on a transition survives into the archive (blueprint forensic field)', () => {
  const root = makeProject();
  const lo = outcomeFixture({
    transitions: [
      { from: 'try1', to: 'inplace-fix', reason: 'red', residualReds: 2 },
      { from: 'inplace-fix', to: 'fresh-redo', reason: 'still red', residualReds: 1, snapshotRef: 'refs/thin/demo/try1' },
    ],
  });
  const r = writeThinArchive(paramsFor(root, { loopOutcome: lo }));
  const rec = JSON.parse(fs.readFileSync(path.join(r.archiveDir, 'record.json'), 'utf8'));
  assert.strictEqual(rec.transitions[1].snapshotRef, 'refs/thin/demo/try1');
});

for (const dir of tmpDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
