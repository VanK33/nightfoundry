/**
 * test-thin-loop.js — Unit tests for the thin-loop red-loop state machine
 * (M1 blueprint v3 §范围-in item 3). Everything injected: executors,
 * grader, git. The git-order pins are the point — the blueprint hard-codes
 * snapshot-before-rollback and these tests make the wrong order impossible
 * to reintroduce silently.
 * Run: node test/test-thin-loop.js
 */
import assert from 'assert';
import { runRedLoop, suspectedAcceptanceDefects } from '../src/orchestrator/core/thin-loop.js';

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
async function drive(p) {
  return await runRedLoop(p);
}

const asyncTests = [];
function testAsync(name, fn) {
  asyncTests.push({ name, fn });
}

/** Grade sequencer: returns canned grades in order. */
function grades(...seq) {
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)];
}
const green = { green: true, redList: [], failLabels: [] };
const red = (labels) => ({ green: false, redList: labels.map((l) => `acceptance FAIL: ${l}`), failLabels: labels });

/** Recording fakes. */
function makeFakes({ gradeSeq, headMoves = false } = {}) {
  const calls = [];
  const fakes = {
    executeFresh: async ({ attempt }) => { calls.push(`fresh:${attempt}`); return { attempt }; },
    executeFollowup: async ({ redList }) => { calls.push('followup'); return { redList }; },
    grade: () => { calls.push('grade'); return gradeSeq(); },
    git: {
      headSha: () => (headMoves ? 'moved-sha' : 'base-sha'),
      snapshotTry: (label) => { calls.push(`snapshot:${label}`); return `refs/thin/demo/${label}`; },
      snapshotHead: (label) => { calls.push(`snapshotHead:${label}`); return `refs/thin/demo/${label}-head`; },
      capturePatch: () => { calls.push('capturePatch'); return 'diff --git ...'; },
      resetToBase: () => { calls.push('resetToBase'); },
    },
    record: (t) => { calls.push(`record:${t.from}->${t.to}`); },
  };
  return { calls, fakes };
}

function baseParams(fakes) {
  return {
    slug: 'demo',
    projectRoot: '/proj',
    baseSha: 'base-sha',
    ...fakes,
  };
}

// -- suspectedAcceptanceDefects (pure) --------------------------------------

test('TC1: a label failing in ALL rounds is a suspected acceptance defect', () => {
  const s = suspectedAcceptanceDefects([['a', 'b'], ['a'], ['a', 'c']]);
  assert.deepStrictEqual(s, ['a']);
});

test('TC2: a label missing from any round is NOT suspected (it moved, so the exam can pass)', () => {
  assert.deepStrictEqual(suspectedAcceptanceDefects([['a'], [], ['a']]), []);
  assert.deepStrictEqual(suspectedAcceptanceDefects([['a'], ['a']]), [], 'fewer than three rounds -> never suspected');
});

// -- state machine (async) --------------------------------------------------

testAsync('TC3: green on try1 -> delivered with a single fresh execution and no git surgery', async () => {
  const { calls, fakes } = makeFakes({ gradeSeq: grades(green) });
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'delivered');
  assert.strictEqual(r.tries.length, 1);
  assert.ok(!calls.includes('resetToBase') && !calls.some((c) => c.startsWith('snapshot:')));
});

testAsync('TC4: red try1, green after in-place fix -> delivered in two tries, still no git surgery', async () => {
  const { calls, fakes } = makeFakes({ gradeSeq: grades(red(['x']), green) });
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'delivered');
  assert.strictEqual(r.tries.length, 2);
  assert.ok(calls.includes('followup'));
  assert.ok(!calls.includes('resetToBase'));
});

testAsync('TC5: the in-place fix receives the red list verbatim', async () => {
  let seen;
  const { fakes } = makeFakes({ gradeSeq: grades(red(['broken thing']), green) });
  fakes.executeFollowup = async ({ redList }) => { seen = redList; return {}; };
  await drive(baseParams(fakes));
  assert.ok(seen.some((l) => l.includes('broken thing')));
});

testAsync('TC6: fresh-redo order is EXACTLY capturePatch -> snapshot -> reset -> fresh (the blueprint hard rule)', async () => {
  const { calls, fakes } = makeFakes({ gradeSeq: grades(red(['x']), red(['x']), green) });
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'delivered');
  const patchIdx = calls.indexOf('capturePatch');
  const snapIdx = calls.findIndex((c) => c === 'snapshot:try1');
  const resetIdx = calls.indexOf('resetToBase');
  const fresh2Idx = calls.indexOf('fresh:2');
  assert.ok(patchIdx >= 0 && snapIdx >= 0 && resetIdx >= 0 && fresh2Idx >= 0, JSON.stringify(calls));
  assert.ok(patchIdx < snapIdx, 'blueprint order: ① capture patch ② snapshot');
  assert.ok(patchIdx < resetIdx, 'patch archived before any rollback');
  assert.ok(snapIdx < resetIdx, 'snapshot ref exists before any rollback');
  assert.ok(resetIdx < fresh2Idx, 'rollback completes before the new session starts');
});

testAsync('TC7: still red after fresh-redo -> parked, with the full transition trail recorded', async () => {
  const transitions = [];
  const { fakes } = makeFakes({ gradeSeq: grades(red(['x']), red(['x']), red(['x'])) });
  fakes.record = (t) => transitions.push(t);
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'parked');
  const path = transitions.map((t) => `${t.from}->${t.to}`);
  assert.deepStrictEqual(path, ['try1->inplace-fix', 'inplace-fix->fresh-redo', 'fresh-redo->parked']);
  for (const t of transitions) {
    assert.ok(typeof t.reason === 'string' && t.reason.length > 0);
    assert.ok(typeof t.residualReds === 'number');
  }
  assert.deepStrictEqual(transitions.map((t) => t.residualReds), [1, 1, 1], 'residualReds = red count after the attempt that triggered the transition');
  assert.strictEqual(transitions[1].snapshotRef, 'refs/thin/demo/try1', 'fresh-redo transition carries the snapshot ref');
});

testAsync('TC8: the mechanical suspected-defect channel fires only when the same label survives all three rounds', async () => {
  const { fakes } = makeFakes({ gradeSeq: grades(red(['a', 'b']), red(['a']), red(['a', 'c'])) });
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'parked');
  assert.deepStrictEqual(r.suspectedAcceptanceDefects, ['a']);
});

testAsync('TC9: no suspected-defect marking when labels churn between rounds', async () => {
  const { fakes } = makeFakes({ gradeSeq: grades(red(['a']), red(['b']), red(['c'])) });
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'parked');
  assert.deepStrictEqual(r.suspectedAcceptanceDefects, []);
});

testAsync('TC10: an executor that moved HEAD gets a head snapshot BEFORE the base reset', async () => {
  const { calls, fakes } = makeFakes({ gradeSeq: grades(red(['x']), red(['x']), green), headMoves: true });
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'delivered');
  const headSnapIdx = calls.indexOf('snapshotHead:try1');
  const resetIdx = calls.indexOf('resetToBase');
  assert.ok(headSnapIdx >= 0, 'moved HEAD is preserved in a ref');
  assert.ok(headSnapIdx < resetIdx, 'head ref exists before the reset');
  const freshRedo = r.transitions.find((t) => t.to === 'fresh-redo');
  assert.strictEqual(freshRedo.headRef, 'refs/thin/demo/try1-head');
  assert.ok(freshRedo.patchBytes > 0, 'patch size recorded');
});

testAsync('TC11: an executor exception parks with an infra reason instead of crashing the loop', async () => {
  const { fakes } = makeFakes({ gradeSeq: grades(green) });
  fakes.executeFresh = async () => { throw new Error('SDK exploded'); };
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'parked');
  assert.ok(r.parkReason.includes('SDK exploded'));
});

testAsync('TC12: per-try results (grade + executor result) are all carried in the outcome for archiving', async () => {
  const { fakes } = makeFakes({ gradeSeq: grades(red(['x']), red(['y']), green) });
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.tries.length, 3);
  assert.deepStrictEqual(r.tries.map((t) => t.kind), ['fresh', 'inplace-fix', 'fresh-redo']);
  assert.ok(r.tries.every((t) => t.grade));
});


testAsync('TC13: a throwing grader parks as infra instead of crashing (never-throws contract)', async () => {
  const { fakes } = makeFakes({ gradeSeq: grades(green) });
  fakes.grade = () => { throw new Error('git blew up'); };
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'parked');
  assert.ok(r.parkReason.includes('grading failed') && r.parkReason.includes('git blew up'));
});

testAsync('TC14: git surgery failing BEFORE the reset parks with work-still-in-tree wording', async () => {
  const { fakes } = makeFakes({ gradeSeq: grades(red(['x']), red(['x'])) });
  fakes.git.snapshotTry = () => { throw new Error('ref write denied'); };
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'parked');
  assert.ok(r.parkReason.includes('before any rollback'), r.parkReason);
});

testAsync('TC15: resetToBase failing parks with work-preserved-in-ref wording (snapshot already exists)', async () => {
  const { fakes } = makeFakes({ gradeSeq: grades(red(['x']), red(['x'])) });
  fakes.git.resetToBase = () => { throw new Error('reset failed'); };
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'parked');
  assert.ok(r.parkReason.includes('after the snapshot'), r.parkReason);
});

testAsync('TC16: a throwing record callback never kills the loop and is surfaced on the outcome', async () => {
  const { fakes } = makeFakes({ gradeSeq: grades(red(['x']), green) });
  fakes.record = () => { throw new Error('disk full'); };
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'delivered');
  assert.ok(r.recordErrors.length >= 1 && r.recordErrors[0].includes('disk full'));
});

testAsync('TC17: a red grade missing redList/failLabels does not crash the loop', async () => {
  const { fakes } = makeFakes({ gradeSeq: grades({ green: false }, green) });
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'delivered');
  assert.strictEqual(r.tries.length, 2);
});


testAsync('TC18: an inplace-fix executor exception parks with the inplace-fix->parked transition', async () => {
  const { fakes } = makeFakes({ gradeSeq: grades(red(['x'])) });
  fakes.executeFollowup = async () => { throw new Error('continue blew up'); };
  const transitions = [];
  fakes.record = (t) => transitions.push(t);
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'parked');
  assert.ok(r.parkReason.includes('continue blew up'));
  assert.strictEqual(transitions[transitions.length - 1].from, 'inplace-fix');
  assert.strictEqual(transitions[transitions.length - 1].to, 'parked');
});

testAsync('TC19: a fresh-redo (attempt 2) executor exception parks with the fresh-redo->parked transition', async () => {
  const { fakes } = makeFakes({ gradeSeq: grades(red(['x']), red(['x'])) });
  fakes.executeFresh = async ({ attempt }) => {
    if (attempt === 2) throw new Error('second wind died');
    return { attempt };
  };
  const transitions = [];
  fakes.record = (t) => transitions.push(t);
  const r = await drive(baseParams(fakes));
  assert.strictEqual(r.outcome, 'parked');
  assert.ok(r.parkReason.includes('second wind died'));
  assert.strictEqual(transitions[transitions.length - 1].from, 'fresh-redo');
});

testAsync('TC20: the full-sequence parkReason carries the suspected-defect labels', async () => {
  const { fakes } = makeFakes({ gradeSeq: grades(red(['a', 'b']), red(['a']), red(['a'])) });
  const r = await drive(baseParams(fakes));
  assert.ok(r.parkReason.includes('suspected acceptance defects'));
  assert.ok(r.parkReason.includes('a'));
});

test('TC21: multi-label suspected defects come back sorted', () => {
  const s = suspectedAcceptanceDefects([['c', 'a', 'b'], ['a', 'b', 'c'], ['b', 'c', 'a']]);
  assert.deepStrictEqual(s, ['a', 'b', 'c']);
});

// -- runner -----------------------------------------------------------------

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
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
};
runAll();
