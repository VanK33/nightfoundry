#!/usr/bin/env node

/**
 * test-review-gate-auto-align.js — Tests for the --auto review-gate
 * auto-alignment behavior.
 *
 * TARGET BEHAVIOR (NOT the current HEAD behavior):
 *
 *   1. Under --auto (pipeline.autoFromHere === true), after milestones complete
 *      and the reviewer has run, the review gate AUTO-ACCEPTS (returns normally;
 *      archive proceeds) IF AND ONLY IF every milestone's review sidecar exists,
 *      parses, and is a clean pass (result === 'PASSED' AND zero findings of
 *      severity 'critical').
 *
 *   2. Under --auto, if ANY milestone sidecar is missing, unparseable, not
 *      'PASSED', or has >=1 critical finding — OR there are zero milestones —
 *      the gate does NOT auto-accept; it reaches the menu, and _gateMenu raises
 *      a HaltError under --auto (the run parks; nothing accepted/archived).
 *      Fail-closed.
 *
 *   3. WITHOUT --auto (autoFromHere false), the gate presents the human menu
 *      (onMenu invoked) regardless of sidecar state — unchanged.
 *
 *   4. --no-review is deprecated: still accepted (no unknown-flag error), prints
 *      a deprecation notice, but no longer skips the gate — the gate runs anyway.
 *      (The internal skipReview/noReview options are separate and still skip;
 *      this test only asserts that the CLI --no-review flag no longer forces a
 *      skip.)
 *
 * Discrimination at HEAD: items 1, 2, and 4 are NOT implemented at the HEAD this
 * file is written against. _reviewGate has no auto-accept branch (it always
 * drives the menu), and run.js maps --no-review onto opts.noReview (a skip). So
 * the new-behavior assertions below SHOULD FAIL here — that failure proves the
 * tests exercise the change. Item 3 is unchanged and should PASS at HEAD.
 *
 * Observability note: the target renames the internal auto-accept option from
 * `batchAutoAccept` to `autoAccept`. These tests set pipeline.autoFromHere=true
 * and pass `autoAccept: true` to _reviewGate — the same wiring the public
 * run/resume entry points use ({ autoAccept: this.autoFromHere }). We assert the
 * OBSERVABLE outcome (auto-accept-on-clean vs HaltError-on-dirty), not the
 * internal option name beyond the call site itself.
 *
 * Run: node test/test-review-gate-auto-align.js
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { HaltError } from '../src/orchestrator/core/halt-error.js';
import { run } from '../src/cli/commands/run.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${err.message}`);
    if (err.stack) console.log(`         ${err.stack.split('\n').slice(1, 3).join('\n         ')}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Create a temp project root with a .harness directory and a state.json whose
 * `milestones` map contains the supplied milestone ids. Each milestone is a
 * minimal object — the auto-accept predicate only enumerates milestone ids and
 * reads their per-milestone review sidecar from disk.
 *
 * @param {string[]} milestoneIds
 * @returns {{ projectRoot: string, harnessDir: string }}
 */
function makeHarness(milestoneIds = ['001']) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-rg-auto-'));
  const harnessDir = path.join(projectRoot, '.harness');
  for (const sub of ['logs', 'verification', 'state']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const milestones = {};
  for (const id of milestoneIds) {
    milestones[id] = {
      id,
      description: `milestone ${id}`,
      status: 'complete',
    };
  }

  const state = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones,
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  return { projectRoot, harnessDir };
}

/**
 * Write a per-milestone review sidecar to
 * .harness/verification/review-milestone-<id>.json with the supplied structured
 * content.
 */
function writeSidecar(harnessDir, milestoneId, structured) {
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `review-milestone-${milestoneId}.json`),
    JSON.stringify(structured, null, 2)
  );
}

/** A clean-pass sidecar: PASSED, no critical findings. */
function cleanPassSidecar(extraFindings = []) {
  return { result: 'PASSED', findings: extraFindings, notes: '' };
}

function cleanup(dir) {
  try {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * Build a Pipeline whose onMenu records whether it was reached. Used to detect
 * the "fell through to the human menu" path vs the auto-accept path.
 *
 * The returned `menu` object exposes `.called` (boolean). The onMenu closure
 * returns 'a' (accept) so that, if the gate ever delegates to it, the gate
 * resolves rather than hanging.
 */
function makePipeline(projectRoot, extraOpts = {}) {
  const logs = [];
  const menu = { called: false };
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    onMenu: async () => {
      menu.called = true;
      return 'a';
    },
    ...extraOpts,
  });
  return { pipeline, logs, menu };
}

/** Force process.stdin.isTTY to a known value; returns a restore fn. */
function forceStdinTTY(value) {
  const orig = process.stdin.isTTY;
  try {
    Object.defineProperty(process.stdin, 'isTTY', { value, writable: true, configurable: true });
  } catch {
    process.stdin.isTTY = value;
  }
  return () => {
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: orig, writable: true, configurable: true });
    } catch {
      process.stdin.isTTY = orig;
    }
  };
}

// ===========================================================================
// Item 1 — Under --auto, auto-accept IFF every milestone sidecar is a clean pass
// ===========================================================================

console.log('\n=== Item 1: --auto auto-accepts on all-clean sidecars ===');

await test('1a: single milestone, clean PASSED sidecar → auto-accept (no throw, onMenu NOT reached)', async () => {
  const { projectRoot, harnessDir } = makeHarness(['001']);
  const { pipeline, menu } = makePipeline(projectRoot);
  pipeline.autoFromHere = true;
  writeSidecar(harnessDir, '001', cleanPassSidecar());
  // Force non-TTY so that, at HEAD (no auto-accept branch), reaching the menu
  // throws a deterministic HaltError — making the discrimination crisp. Under
  // the target, auto-accept returns BEFORE the menu, so there is no throw.
  const restore = forceStdinTTY(false);

  try {
    let threw = null;
    try {
      await pipeline._reviewGate({ autoAccept: true });
    } catch (err) {
      threw = err;
    }
    assert.strictEqual(threw, null, `Expected auto-accept to resolve without throwing on a clean sidecar; threw: ${threw && threw.message}`);
    assert.strictEqual(menu.called, false, 'onMenu must NOT be reached on the auto-accept (clean) path');
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('1b: multiple milestones, all clean PASSED → auto-accept (no throw, onMenu NOT reached)', async () => {
  const { projectRoot, harnessDir } = makeHarness(['001', '002', '003']);
  const { pipeline, menu } = makePipeline(projectRoot);
  pipeline.autoFromHere = true;
  writeSidecar(harnessDir, '001', cleanPassSidecar());
  writeSidecar(harnessDir, '002', cleanPassSidecar());
  writeSidecar(harnessDir, '003', cleanPassSidecar());
  const restore = forceStdinTTY(false);

  try {
    let threw = null;
    try {
      await pipeline._reviewGate({ autoAccept: true });
    } catch (err) {
      threw = err;
    }
    assert.strictEqual(threw, null, `Expected auto-accept to resolve without throwing when all milestones are clean; threw: ${threw && threw.message}`);
    assert.strictEqual(menu.called, false, 'onMenu must NOT be reached when all milestones are clean');
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('1c: clean PASSED with warning-only findings (no criticals) → auto-accept', async () => {
  const { projectRoot, harnessDir } = makeHarness(['001']);
  const { pipeline, menu } = makePipeline(projectRoot);
  pipeline.autoFromHere = true;
  writeSidecar(harnessDir, '001', cleanPassSidecar([
    { severity: 'warning', file: 'src/foo.js', description: 'minor warning' },
    { severity: 'info', file: 'src/bar.js', description: 'informational note' },
  ]));
  const restore = forceStdinTTY(false);

  try {
    let threw = null;
    try {
      await pipeline._reviewGate({ autoAccept: true });
    } catch (err) {
      threw = err;
    }
    assert.strictEqual(threw, null, `Expected auto-accept to resolve without throwing — warnings/info do not block; threw: ${threw && threw.message}`);
    assert.strictEqual(
      menu.called,
      false,
      'onMenu must NOT be reached — warnings/info do not block auto-accept'
    );
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

// ===========================================================================
// Item 2 — Under --auto, fail-closed: any non-clean condition → HaltError
// ===========================================================================
//
// When auto-accept declines, the gate falls through to the menu, and _gateMenu
// under autoFromHere=true + non-TTY raises a HaltError at site 'review-gate'.
// We force a non-TTY stdin so the halt is deterministic.

console.log('\n=== Item 2: --auto fails closed (HaltError) on any non-clean condition ===');

await test('2a: sidecar MISSING → HaltError at review-gate (no auto-accept)', async () => {
  const { projectRoot } = makeHarness(['001']);
  const { pipeline } = makePipeline(projectRoot);
  pipeline.autoFromHere = true;
  // Intentionally write NO sidecar.
  const restore = forceStdinTTY(false);

  try {
    let caught = null;
    try {
      await pipeline._reviewGate({ autoAccept: true });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'Expected a throw when a milestone sidecar is missing under --auto');
    assert.ok(caught instanceof HaltError, `Expected HaltError, got ${caught?.constructor?.name}: ${caught?.message}`);
    assert.strictEqual(caught.site, 'review-gate', `Expected halt site 'review-gate', got '${caught.site}'`);
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('2b: sidecar UNPARSEABLE → HaltError at review-gate', async () => {
  const { projectRoot, harnessDir } = makeHarness(['001']);
  const { pipeline } = makePipeline(projectRoot);
  pipeline.autoFromHere = true;
  fs.writeFileSync(
    path.join(harnessDir, 'verification', 'review-milestone-001.json'),
    '{ this is not valid json'
  );
  const restore = forceStdinTTY(false);

  try {
    let caught = null;
    try {
      await pipeline._reviewGate({ autoAccept: true });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'Expected a throw when a milestone sidecar is unparseable under --auto');
    assert.ok(caught instanceof HaltError, `Expected HaltError, got ${caught?.constructor?.name}: ${caught?.message}`);
    assert.strictEqual(caught.site, 'review-gate', `Expected halt site 'review-gate', got '${caught.site}'`);
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('2c: sidecar result NOT PASSED (FAILED) → HaltError at review-gate', async () => {
  const { projectRoot, harnessDir } = makeHarness(['001']);
  const { pipeline } = makePipeline(projectRoot);
  pipeline.autoFromHere = true;
  writeSidecar(harnessDir, '001', { result: 'FAILED', findings: [], notes: '' });
  const restore = forceStdinTTY(false);

  try {
    let caught = null;
    try {
      await pipeline._reviewGate({ autoAccept: true });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'Expected a throw when a milestone result is not PASSED under --auto');
    assert.ok(caught instanceof HaltError, `Expected HaltError, got ${caught?.constructor?.name}: ${caught?.message}`);
    assert.strictEqual(caught.site, 'review-gate', `Expected halt site 'review-gate', got '${caught.site}'`);
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('2d: PASSED but with a critical finding → HaltError at review-gate', async () => {
  const { projectRoot, harnessDir } = makeHarness(['001']);
  const { pipeline } = makePipeline(projectRoot);
  pipeline.autoFromHere = true;
  writeSidecar(harnessDir, '001', {
    result: 'PASSED',
    findings: [{ severity: 'critical', file: 'src/foo.js', description: 'critical issue slipped through' }],
    notes: '',
  });
  const restore = forceStdinTTY(false);

  try {
    let caught = null;
    try {
      await pipeline._reviewGate({ autoAccept: true });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'Expected a throw when a PASSED sidecar carries a critical finding under --auto');
    assert.ok(caught instanceof HaltError, `Expected HaltError, got ${caught?.constructor?.name}: ${caught?.message}`);
    assert.strictEqual(caught.site, 'review-gate', `Expected halt site 'review-gate', got '${caught.site}'`);
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('2e: ZERO milestones → HaltError at review-gate (cannot auto-accept an empty run)', async () => {
  const { projectRoot } = makeHarness([]); // no milestones
  const { pipeline } = makePipeline(projectRoot);
  pipeline.autoFromHere = true;
  const restore = forceStdinTTY(false);

  try {
    let caught = null;
    try {
      await pipeline._reviewGate({ autoAccept: true });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'Expected a throw when there are zero milestones under --auto');
    assert.ok(caught instanceof HaltError, `Expected HaltError, got ${caught?.constructor?.name}: ${caught?.message}`);
    assert.strictEqual(caught.site, 'review-gate', `Expected halt site 'review-gate', got '${caught.site}'`);
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

await test('2f: mixed — one clean, one missing → HaltError (gate is all-or-nothing)', async () => {
  const { projectRoot, harnessDir } = makeHarness(['001', '002']);
  const { pipeline } = makePipeline(projectRoot);
  pipeline.autoFromHere = true;
  writeSidecar(harnessDir, '001', cleanPassSidecar());
  // milestone 002 has NO sidecar
  const restore = forceStdinTTY(false);

  try {
    let caught = null;
    try {
      await pipeline._reviewGate({ autoAccept: true });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'Expected a throw when any single milestone is non-clean under --auto');
    assert.ok(caught instanceof HaltError, `Expected HaltError, got ${caught?.constructor?.name}: ${caught?.message}`);
    assert.strictEqual(caught.site, 'review-gate', `Expected halt site 'review-gate', got '${caught.site}'`);
  } finally {
    restore();
    cleanup(projectRoot);
  }
});

// ===========================================================================
// Item 3 — WITHOUT --auto, the human menu is always presented (UNCHANGED)
// ===========================================================================

console.log('\n=== Item 3: non-auto always presents the human menu (unchanged) ===');

await test('3a: autoFromHere=false, clean sidecar → onMenu IS reached (no auto-accept without --auto)', async () => {
  const { projectRoot, harnessDir } = makeHarness(['001']);
  const { pipeline, menu } = makePipeline(projectRoot);
  pipeline.autoFromHere = false;
  writeSidecar(harnessDir, '001', cleanPassSidecar());

  try {
    // No autoAccept flag — gate must present the human menu even though the
    // sidecar is a clean pass. onMenu returns 'a', so the gate resolves.
    await pipeline._reviewGate({});
    assert.strictEqual(menu.called, true, 'onMenu MUST be reached when not under --auto, even with a clean sidecar');
  } finally {
    cleanup(projectRoot);
  }
});

await test('3b: autoFromHere=false, dirty sidecar → onMenu IS reached (menu, not halt)', async () => {
  const { projectRoot, harnessDir } = makeHarness(['001']);
  const { pipeline, menu } = makePipeline(projectRoot);
  pipeline.autoFromHere = false;
  writeSidecar(harnessDir, '001', {
    result: 'FAILED',
    findings: [{ severity: 'critical', file: 'src/foo.js', description: 'x' }],
    notes: '',
  });

  try {
    await pipeline._reviewGate({});
    assert.strictEqual(menu.called, true, 'onMenu MUST be reached in non-auto mode regardless of sidecar state');
  } finally {
    cleanup(projectRoot);
  }
});

// ===========================================================================
// Item 4 — --no-review is deprecated: accepted, warns, no longer skips the gate
// ===========================================================================
//
// Driven through the public CLI run() entry point (run.js). We stub
// Pipeline.prototype.run to capture the constructed instance's state and stop
// execution before any real work. The constructor consumes opts.noReview into
// this.noReview, so we read this.noReview off the live instance.
//
// TARGET: run.js no longer maps --no-review onto opts.noReview, so the gate is
// NOT skipped (this.noReview === false). HEAD maps it (this.noReview === true).

console.log('\n=== Item 4: --no-review deprecated — accepted, warns, but no longer skips ===');

await test('4a: run() with --no-review → constructed pipeline does NOT skip the gate (this.noReview === false)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-rg-noreview-'));
  const specPath = path.join(tmpDir, 'spec.md');
  fs.writeFileSync(specPath, '# Test Spec\n');

  let observedNoReview = null;
  let observedSkipReview = null;
  let runCalled = false;

  const origRun = Pipeline.prototype.run;
  Pipeline.prototype.run = async function stubRun() {
    runCalled = true;
    // `this` is the live pipeline instance created inside run.js's createPipeline.
    observedNoReview = this.noReview;
    observedSkipReview = this.skipReview;
    return null; // falsy → skips result-dependent rendering in run.js
  };

  const origExit = process.exit;
  process.exit = (code) => { throw new Error(`process.exit called with code ${code}`); };

  try {
    await run(tmpDir, specPath, { auto: true, 'no-review': true });

    assert.strictEqual(runCalled, true, 'pipeline.run should have been invoked by the CLI run() command');
    assert.strictEqual(
      observedNoReview,
      false,
      'Deprecated --no-review must NOT set this.noReview (gate must still run). ' +
        `Got this.noReview=${JSON.stringify(observedNoReview)}`
    );
    // The internal skipReview option is separate and was not requested here.
    assert.notStrictEqual(
      observedSkipReview,
      true,
      'CLI --no-review must not flip the separate internal skipReview option to true'
    );
  } finally {
    Pipeline.prototype.run = origRun;
    process.exit = origExit;
    cleanup(tmpDir);
  }
});

await test('4b: run() with --no-review is still accepted (no unknown-flag error / no nonzero exit)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-rg-noreview-ok-'));
  const specPath = path.join(tmpDir, 'spec.md');
  fs.writeFileSync(specPath, '# Test Spec\n');

  const origRun = Pipeline.prototype.run;
  Pipeline.prototype.run = async function stubRun() { return null; };

  let exitCode = null;
  const origExit = process.exit;
  process.exit = (code) => { exitCode = code; throw new Error(`process.exit:${code}`); };

  try {
    let threw = false;
    try {
      await run(tmpDir, specPath, { auto: true, 'no-review': true });
    } catch (e) {
      // The only acceptable "throw" is our own process.exit shim being hit; the
      // deprecated flag itself must not produce a nonzero exit.
      threw = true;
    }
    assert.strictEqual(threw, false, '--no-review should not raise / force a nonzero exit; it is still accepted');
    assert.strictEqual(exitCode, null, `Expected no process.exit; got exit code ${exitCode}`);
  } finally {
    Pipeline.prototype.run = origRun;
    process.exit = origExit;
    cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
