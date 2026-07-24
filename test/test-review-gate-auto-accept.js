#!/usr/bin/env node

/**
 * test-review-gate-auto-accept.js — Tests for the BATCH review-gate auto-accept
 * branch (spec: queue/w5-review-gate-auto-accept.spec/spec.md).
 *
 * Contract under test:
 *   - reviewer.js exports isCleanPass(structured) → boolean:
 *       true iff structured?.result === 'PASSED' AND no finding has
 *       severity === 'critical'; tolerant of missing/non-array findings.
 *   - pipeline.js _reviewGate(opts): when opts.autoAccept is set, read each
 *       milestone's .harness/verification/review-milestone-<msId>.json sidecar
 *       (milestone ids from persisted state). If EVERY sidecar is a clean pass,
 *       log "[review-gate] auto-accept: ..." and return WITHOUT invoking onMenu.
 *       Any missing/corrupt/non-PASSED/critical-bearing sidecar → log a
 *       declining reason and fall through to the existing menu. With
 *       autoAccept absent → byte-identical to today (menu reached).
 *
 * Test cases (AC = acceptance criterion in spec.md §"Acceptance criteria"):
 *   AC1a  — autoAccept:true + all sidecars clean PASS → onMenu NOT called,
 *           auto-accept line logged.
 *   AC1b  — SAME fixtures, option ABSENT → onMenu IS called (single-run/
 *           byte-identical: the option is the only thing that changes behavior).
 *   AC2a  — autoAccept:true, one milestone sidecar MISSING → onMenu called,
 *           declining reason logged.
 *   AC2b  — autoAccept:true, one sidecar CORRUPT (unparseable) → onMenu
 *           called, declining reason logged.
 *   AC2c  — autoAccept:true, one sidecar result FAILED → onMenu called,
 *           declining reason logged.
 *   AC2d  — autoAccept:true, one sidecar PASSED but carries a
 *           critical-severity finding → onMenu called, declining reason logged.
 *   AC3   — isCleanPass is exported from reviewer.js and is the SAME predicate
 *           the reviewer's own pass computation uses (extractReviewVerdict.passed
 *           agrees with isCleanPass on the same structured input); optionally
 *           pipeline.js imports it rather than defining a local copy.
 *   UNIT  — direct unit block on isCleanPass: PASSED+no-critical → true;
 *           PASSED+critical → false; FAILED → false;
 *           PASSED+missing/non-array findings → true (tolerant).
 *
 * Run: node test/test-review-gate-auto-accept.js
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';
import { writeGlobalPlan } from '../src/orchestrator/core/state.js';
import {
  isCleanPass,
  extractReviewVerdict,
} from '../src/orchestrator/agents/reviewer.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => {
          console.log(`  [PASS] ${name}`);
          passed++;
        },
        (err) => {
          console.log(`  [FAIL] ${name}`);
          console.log(`         ${err.message}`);
          if (err.stack) console.log(`         ${err.stack.split('\n').slice(1, 3).join('\n         ')}`);
          failed++;
        }
      );
    }
    console.log(`  [PASS] ${name}`);
    passed++;
    return Promise.resolve();
  } catch (err) {
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${err.message}`);
    if (err.stack) console.log(`         ${err.stack.split('\n').slice(1, 3).join('\n         ')}`);
    failed++;
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary harness directory and a Pipeline instance.
 *
 * Mirrors makeTmpHarness() in test-review-gate.js: a NON-git tmp dir (so the
 * `git diff --stat HEAD` inside _reviewGate falls back gracefully) with a
 * .harness/logs subtree and an onLog-capturing Pipeline.  This variant goes
 * one step further: it runs the SAME staging writers the pipeline uses
 * (bootstrap + writeGlobalPlan) so state.json carries real milestone ids that
 * the auto-accept branch can resolve.
 *
 * @param {object}   opts                  forwarded to the Pipeline constructor
 * @param {string[]} opts.milestoneIds     milestone ids to stage in state.json
 *                                          (default ['001'])
 * @returns {{ tmpDir, harnessDir, pipeline, logs, milestoneIds, verificationDir }}
 */
function makeStagedHarness(opts = {}) {
  const { milestoneIds = ['001'], ...pipelineOpts } = opts;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-auto-accept-'));
  const harnessDir = path.join(tmpDir, '.harness');

  // Stage state.json + milestone records via the SAME writers the pipeline
  // uses, so milestone-id resolution is exercised exactly as production does.
  bootstrap(tmpDir);
  const plan = {
    milestones: milestoneIds.map((id) => ({
      id,
      description: `milestone ${id}`,
      missions: [
        { id: `${id}-001`, description: `mission ${id}-001` },
      ],
    })),
  };
  writeGlobalPlan(harnessDir, plan);

  // _reviewGate writes diagnostics under .harness/logs in some paths; keep it.
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  const verificationDir = path.join(harnessDir, 'verification');
  fs.mkdirSync(verificationDir, { recursive: true });

  const logs = [];
  const pipeline = new Pipeline(tmpDir, {
    onLog: (msg) => logs.push(msg),
    ...pipelineOpts,
  });

  return { tmpDir, harnessDir, pipeline, logs, milestoneIds, verificationDir };
}

/**
 * Sidecar shape = exactly what reviewer.js's extractReviewVerdict() persists:
 * `JSON.stringify(structured, null, 2)`, where `structured` is the reviewer's
 * verdict object { result, findings, notes, ... }.  These constructors build
 * the four shapes the gate must distinguish.
 */
function cleanPassStructured(warningCount = 0) {
  const findings = [];
  for (let i = 0; i < warningCount; i++) {
    findings.push({
      severity: 'warning',
      category: 'integration',
      tier: 'composition',
      disposition: 'pending',
      file: `src/file-${i}.js`,
      description: `non-critical advisory ${i}`,
      relatedFiles: [],
    });
  }
  return {
    result: 'PASSED',
    findings,
    notes: 'clean composition review',
    scopeCompliance: { verdict: 'within_scope', evidence: '', exceededFiles: [] },
  };
}

function failedStructured() {
  return {
    result: 'FAILED',
    findings: [
      {
        severity: 'warning',
        category: 'functional',
        tier: 'behavioral',
        disposition: 'pending',
        file: 'src/broken.js',
        description: 'composed behavior diverges from spec intent',
        relatedFiles: [],
      },
    ],
    notes: 'reviewer marked FAILED',
    scopeCompliance: { verdict: 'within_scope', evidence: '', exceededFiles: [] },
  };
}

function passedWithCriticalStructured() {
  return {
    result: 'PASSED',
    findings: [
      {
        severity: 'critical',
        category: 'call-chain',
        tier: 'composition',
        disposition: 'pending',
        file: 'src/contract.js',
        description: 'caller/callee signature mismatch across boundary',
        relatedFiles: [],
      },
    ],
    notes: 'PASSED string but a critical finding is present — must NOT auto-accept',
    scopeCompliance: { verdict: 'within_scope', evidence: '', exceededFiles: [] },
  };
}

function sidecarPathFor(harnessDir, msId) {
  return path.join(harnessDir, 'verification', `review-milestone-${msId}.json`);
}

function writeSidecar(harnessDir, msId, structured) {
  fs.writeFileSync(
    sidecarPathFor(harnessDir, msId),
    JSON.stringify(structured, null, 2)
  );
}

function writeCorruptSidecar(harnessDir, msId) {
  fs.writeFileSync(sidecarPathFor(harnessDir, msId), '{ this is not: valid json ]]]');
}

/** A spy onMenu: records whether it was invoked, returns 'a' (accept). */
function makeMenuSpy() {
  const state = { called: false, callCount: 0 };
  const fn = async () => {
    state.called = true;
    state.callCount++;
    return 'a';
  };
  return { fn, state };
}

function cleanup(dir) {
  try {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch { /* ignore cleanup errors */ }
}

// The success line is "[review-gate] auto-accept: N/N ..." (colon); the
// fail-closed decline line is "[review-gate] auto-accept declined ...". The
// colon disambiguates so the "auto-accept fired" probe never matches a decline.
const AUTO_ACCEPT_LOG = '[review-gate] auto-accept:';

// ===========================================================================
// AC1 — auto-accept fires only with the option; absent option reaches the menu
// ===========================================================================

console.log('\n=== AC1: clean PASS set auto-accepts WITH the option, reaches menu WITHOUT it ===');

await test('AC1a: autoAccept:true + all sidecars clean PASS → onMenu NOT called, auto-accept logged', async () => {
  const ids = ['001', '002'];
  const { tmpDir, harnessDir, pipeline, logs } = makeStagedHarness({ milestoneIds: ids });
  try {
    writeSidecar(harnessDir, '001', cleanPassStructured(2)); // 2 warnings → ledger
    writeSidecar(harnessDir, '002', cleanPassStructured(0));

    const spy = makeMenuSpy();
    pipeline.onMenu = spy.fn;

    await pipeline._reviewGate({ autoAccept: true });

    assert.strictEqual(
      spy.state.called,
      false,
      `onMenu must NOT be invoked when every sidecar is a clean PASS; ` +
      `callCount=${spy.state.callCount}. Logs:\n${logs.join('\n')}`
    );
    assert.ok(
      logs.some((l) => l.includes(AUTO_ACCEPT_LOG)),
      `Expected an "${AUTO_ACCEPT_LOG}" log line; got:\n${logs.join('\n')}`
    );
  } finally {
    cleanup(tmpDir);
  }
});

await test('AC1b: SAME fixtures, option ABSENT → onMenu IS called (byte-identical single-run behavior)', async () => {
  const ids = ['001', '002'];
  const { tmpDir, harnessDir, pipeline, logs } = makeStagedHarness({ milestoneIds: ids });
  try {
    // Identical clean-PASS fixtures as AC1a.
    writeSidecar(harnessDir, '001', cleanPassStructured(2));
    writeSidecar(harnessDir, '002', cleanPassStructured(0));

    const spy = makeMenuSpy();
    pipeline.onMenu = spy.fn;

    // No autoAccept → must reach the menu exactly like today.
    await pipeline._reviewGate({});

    assert.strictEqual(
      spy.state.called,
      true,
      `Without autoAccept the menu MUST be reached even on clean sidecars ` +
      `(proves the option is the only behavioral switch). Logs:\n${logs.join('\n')}`
    );
    assert.ok(
      !logs.some((l) => l.includes(AUTO_ACCEPT_LOG)),
      `Auto-accept must NOT fire without the option; logs:\n${logs.join('\n')}`
    );
  } finally {
    cleanup(tmpDir);
  }
});

// ===========================================================================
// AC2 — four fail-closed shapes each reach the menu AND log a declining reason
// ===========================================================================

console.log('\n=== AC2: fail-closed shapes fall through to the menu with a declining reason ===');

/**
 * Shared body for the four AC2 fail-closed cases.  Stages two milestones where
 * 001 is a clean PASS and 002 is dirtied by `dirty()`.  With autoAccept
 * set, the gate must DECLINE (onMenu called) and log a reason.  Non-vacuous:
 * if auto-accept wrongly fired on the non-clean sidecar, onMenu.called would be
 * false and the assertion fails.
 */
async function runFailClosedCase(label, dirty) {
  const ids = ['001', '002'];
  const { tmpDir, harnessDir, pipeline, logs } = makeStagedHarness({ milestoneIds: ids });
  try {
    writeSidecar(harnessDir, '001', cleanPassStructured(0));
    dirty(harnessDir, '002');

    const spy = makeMenuSpy();
    pipeline.onMenu = spy.fn;

    await pipeline._reviewGate({ autoAccept: true });

    assert.strictEqual(
      spy.state.called,
      true,
      `${label}: a non-clean sidecar MUST fall through to the menu ` +
      `(auto-accept must NOT fire). Logs:\n${logs.join('\n')}`
    );
    // The auto-accept line must NOT be present — declining means no auto-accept.
    assert.ok(
      !logs.some((l) => l.includes(AUTO_ACCEPT_LOG)),
      `${label}: auto-accept line must be ABSENT when declining; logs:\n${logs.join('\n')}`
    );
    // A declining reason must be logged.  The spec leaves the exact wording to
    // the implementation ("log WHY auto-accept declined"); we assert a
    // review-gate-tagged line that is NOT the bare accept/skip/diff chrome and
    // that references the offending milestone or a decline keyword.
    const declineLine = logs.find((l) =>
      l.includes('[review-gate]') &&
      !l.includes('Changes accepted.') &&
      !l.includes('Skipping review gate') &&
      !l.includes('No onMenu callback') &&
      (/declin|fall|auto-accept|002|missing|corrupt|FAILED|critical/i.test(l))
    );
    assert.ok(
      declineLine,
      `${label}: expected a [review-gate] declining-reason log line; got:\n${logs.join('\n')}`
    );
  } finally {
    cleanup(tmpDir);
  }
}

await test('AC2a: a milestone sidecar MISSING → menu reached, declining reason logged', async () => {
  // dirty = leave 002's sidecar unwritten (missing).
  await runFailClosedCase('AC2a missing sidecar', (_harnessDir, _msId) => {
    /* intentionally do not write the 002 sidecar */
  });
});

await test('AC2b: a CORRUPT/unparseable sidecar → menu reached, declining reason logged', async () => {
  await runFailClosedCase('AC2b corrupt sidecar', (harnessDir, msId) => {
    writeCorruptSidecar(harnessDir, msId);
  });
});

await test('AC2c: a sidecar with result FAILED → menu reached, declining reason logged', async () => {
  await runFailClosedCase('AC2c FAILED result', (harnessDir, msId) => {
    writeSidecar(harnessDir, msId, failedStructured());
  });
});

await test('AC2d: a sidecar PASSED but carrying a critical finding → menu reached, declining reason logged', async () => {
  await runFailClosedCase('AC2d PASSED-with-critical', (harnessDir, msId) => {
    writeSidecar(harnessDir, msId, passedWithCriticalStructured());
  });
});

// ===========================================================================
// AC3 — isCleanPass is exported and single-sourced with the reviewer's verdict
// ===========================================================================

console.log('\n=== AC3: isCleanPass exported + single-sourced (reviewer verdict agrees) ===');

await test('AC3: isCleanPass is exported from reviewer.js as a function', () => {
  assert.strictEqual(
    typeof isCleanPass,
    'function',
    'reviewer.js must export isCleanPass as a function'
  );
});

await test('AC3: extractReviewVerdict.passed agrees with isCleanPass on the same structured input', () => {
  // Drive the reviewer's own pass computation through extractReviewVerdict and
  // confirm its `passed` matches isCleanPass(structured) for every shape — this
  // is the functional proof the two are single-sourced (cannot drift).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-auto-accept-verdict-'));
  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  try {
    const cases = [
      ['clean PASS', cleanPassStructured(0)],
      ['PASS + warnings', cleanPassStructured(3)],
      ['FAILED', failedStructured()],
      ['PASSED + critical', passedWithCriticalStructured()],
    ];
    cases.forEach(([name, structured], i) => {
      // extractReviewVerdict reads structured via extractStructured(sdkResult).
      // The reviewer schema delivers it as the SDK result's structured_output;
      // pass a result object carrying that field so the real extraction path runs.
      const sdkResult = { structured_output: structured };
      const verdict = extractReviewVerdict(sdkResult, `ms-${i}`, harnessDir, { warn: () => {} });
      const expected = isCleanPass(structured);
      assert.strictEqual(
        verdict.passed,
        expected,
        `${name}: reviewer verdict.passed (${verdict.passed}) must equal ` +
        `isCleanPass(structured) (${expected}) — proves single-sourced predicate`
      );
    });
  } finally {
    cleanup(tmpDir);
  }
});

await test('AC3 (optional): pipeline.js imports isCleanPass from reviewer.js rather than defining a local copy', () => {
  // Best-effort static check: the pipeline must consume the shared predicate.
  // Non-fatal style guard — if the implementation re-exports/aliases it under a
  // different binding this can be relaxed, but the default contract is a direct
  // import of isCleanPass from the reviewer module.
  const pipelineSrc = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'orchestrator', 'core', 'pipeline.js'),
    'utf8'
  );
  const importsIt = /isCleanPass/.test(pipelineSrc) &&
    /from\s+['"].*reviewer\.js['"]/.test(pipelineSrc);
  // Also ensure it does NOT define its own `function isCleanPass` (a local copy
  // would defeat single-sourcing).
  const definesLocal = /function\s+isCleanPass\s*\(/.test(pipelineSrc) ||
    /const\s+isCleanPass\s*=/.test(pipelineSrc);
  assert.ok(
    importsIt,
    'pipeline.js should reference isCleanPass and import from the reviewer module ' +
    '(single-sourced predicate). If intentionally re-bound, relax this optional check.'
  );
  assert.ok(
    !definesLocal,
    'pipeline.js must NOT define a local isCleanPass — that would let the gate ' +
    'predicate drift from the reviewer\'s pass computation.'
  );
});

// ===========================================================================
// UNIT — direct unit block on isCleanPass
// ===========================================================================

console.log('\n=== UNIT: isCleanPass predicate truth table ===');

await test('UNIT: PASSED + no critical finding → true', () => {
  assert.strictEqual(isCleanPass(cleanPassStructured(0)), true);
  assert.strictEqual(isCleanPass(cleanPassStructured(3)), true, 'warnings/info are non-critical → still clean');
});

await test('UNIT: PASSED + a critical finding → false', () => {
  assert.strictEqual(isCleanPass(passedWithCriticalStructured()), false);
});

await test('UNIT: result FAILED → false', () => {
  assert.strictEqual(isCleanPass(failedStructured()), false);
  // FAILED with zero findings is still not a clean PASS.
  assert.strictEqual(isCleanPass({ result: 'FAILED', findings: [] }), false);
});

await test('UNIT: PASSED + missing findings → true (tolerant)', () => {
  assert.strictEqual(isCleanPass({ result: 'PASSED' }), true);
});

await test('UNIT: PASSED + non-array findings → true (tolerant, treated as no findings)', () => {
  assert.strictEqual(isCleanPass({ result: 'PASSED', findings: null }), true);
  assert.strictEqual(isCleanPass({ result: 'PASSED', findings: undefined }), true);
  assert.strictEqual(
    isCleanPass({ result: 'PASSED', findings: 'not-an-array' }),
    true,
    'a non-array findings value must not throw and is treated as no findings'
  );
});

await test('UNIT: missing/non-object input → false (not a clean pass)', () => {
  assert.strictEqual(isCleanPass(undefined), false);
  assert.strictEqual(isCleanPass(null), false);
  assert.strictEqual(isCleanPass({}), false, 'no result field → not PASSED → false');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
