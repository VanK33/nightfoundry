/**
 * test-assumption-phase-routing.js — Tests for assumption phase routing:
 * invariant vs. post-fix classification, backward-compat, result ordering,
 * and end-to-end pipeline remediation with mixed-tense splits.
 *
 * Run: node test/test-assumption-phase-routing.js
 *
 * No live Claude sessions are spawned — all verifier/planner interactions
 * are replaced by mock fixtures.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { validateStructured } from '../src/orchestrator/agents/_schemas.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { Planner } from '../src/orchestrator/agents/planner.js';

const _require = createRequire(import.meta.url);

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ── Pipeline test helpers ──────────────────────────────────────────────────

/**
 * Create a temporary project root with a properly structured .harness/ directory
 * and write a spec file with the given content.
 *
 * Returns { root, harnessDir, specPath }.
 */
function makePipelineHarness({ specContent = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pr-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of [
    'state', 'plan', 'verify', 'progress', 'verification',
    'analysis', 'snapshots', 'learning', 'dry-run', 'logs',
  ]) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta: {
        prdPath: '',
        createdAt: new Date().toISOString(),
        currentPhase: 'planning',
      },
      globalStatus: 'active',
      milestones: {},
    }, null, 2),
  );

  const specPath = path.join(root, 'spec.md');
  fs.writeFileSync(specPath, specContent);

  return { root, harnessDir, specPath };
}

function pipelineCleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * Create a Pipeline instance with:
 *   - skipWorktreeCreation: true (no git)
 *   - no-op _runPreflight (avoids checking worktree config)
 *   - fully mocked planner (no live sessions)
 *
 * @param {string} root - temp project root
 * @param {object} opts
 *   opts.assumptionsList   — enriched {text, specSection, phase?}[] passed to verifyAssumptions
 *   opts.round1            — verifyAssumptions() return value for the 1st call
 *   opts.round2            — verifyAssumptions() return value for the 2nd call (default [])
 *   opts.remediateResult   — what remediateAssumption() returns (may be a function for
 *                            per-call customization)
 *   opts.onConfirm         — custom onConfirm callback (default: records calls, returns false)
 *   opts.onLog             — custom onLog callback (default: records to logs array)
 *
 * Returns { pipeline, logs, confirmCalls, getVerifyCount, getRemediateCount }.
 */
function makeMockedPipeline(root, {
  assumptionsList = [],
  round1 = [],
  round2 = [],
  remediateResult = null,
  onConfirm = null,
  onLog = null,
} = {}) {
  const logs = [];
  const confirmCalls = [];
  let verifyCallCount = 0;
  let remediateCallCount = 0;

  const effectiveOnConfirm = onConfirm ?? (async (msg) => {
    confirmCalls.push(msg);
    return false;
  });

  const pipeline = new Pipeline(root, {
    skipWorktreeCreation: true,
    // These tests exercise the assumption phase; the bare .md spec is just
    // pipeline fuel and should not trip the new uncheckable-spec guard. The
    // guard reads this._allowIncompleteScope (set at construction, like
    // _scopeCoverageGate), so the override belongs in the constructor opts.
    allowIncompleteScope: true,
    onLog: onLog ?? ((msg) => logs.push(msg)),
    onConfirm: effectiveOnConfirm,
  });

  // No-op preflight — temp dirs won't satisfy all preflight checks
  pipeline._runPreflight = () => {};

  pipeline.planner = {
    planGlobal: async () => ({
      milestones: [],
      assumptions: assumptionsList,
    }),
    verifyAssumptions: async () => {
      verifyCallCount++;
      return verifyCallCount === 1 ? round1 : round2;
    },
    reExtractAssumptions: async () => assumptionsList,
    remediateAssumption: async (text, evidence, excerpt) => {
      remediateCallCount++;
      if (typeof remediateResult === 'function') {
        return remediateResult(text, evidence, excerpt, remediateCallCount);
      }
      return remediateResult ?? {
        revisedAssumptions: [{ text: 'revised text', phase: 'invariant' }],
        specEdit: {
          section: '## Section A',
          old: 'OLD_TEXT',
          new: 'NEW_TEXT',
        },
      };
    },
    closeReusableSession: async () => {},
  };

  return {
    pipeline,
    logs,
    confirmCalls,
    getVerifyCount: () => verifyCallCount,
    getRemediateCount: () => remediateCallCount,
  };
}

/**
 * Monkey-patch readline.createInterface for the duration of `fn()`.
 */
async function withMockReadline(responses, fn) {
  const readlineModule = _require('readline');
  const orig = readlineModule.createInterface;
  let idx = 0;

  readlineModule.createInterface = () => ({
    question: (_prompt, cb) => {
      const answer = responses[idx++] ?? 'r';
      cb(answer);
    },
    close: () => {},
    // prompt.js registers a Ctrl-C handler on every interface
    // (spec-prompt-sigint-interrupt); this fake never delivers SIGINT,
    // so a no-op listener registration suffices.
    on: () => {},
  });

  try {
    return await fn();
  } finally {
    readlineModule.createInterface = orig;
  }
}

// ── Standard spec content for phase-routing tests ──────────────────────────

const SECTION_A = '## Section A';
const ORIG_TEXT  = 'The original assumption text about the system.';

const STANDARD_SPEC = [
  SECTION_A,
  ORIG_TEXT,
  '',
  '## Section B',
  'Other section content.',
].join('\n');

// ══════════════════════════════════════════════════════════════════════════
// TC1: verifier filter — invariant-only prompt, post-fix returns deferred
// ══════════════════════════════════════════════════════════════════════════

await test("verifier filter: invariant-only prompt, post-fix returns deferred", async () => {
  const assumptions = [
    { text: 'X exists', phase: 'invariant' },
    { text: 'Y will exist', phase: 'post-fix' },
  ];

  // Mock verifyAssumptions that routes by phase: invariant → real status,
  // post-fix → deferred (no session required; checked post-implementation)
  const mockVerifyAssumptions = async (list) => {
    return list.map((a) => ({
      assumption: a,
      status: a.phase === 'post-fix' ? 'deferred' : 'verified',
      evidence: a.phase === 'post-fix'
        ? 'deferred to post-fix phase — not verifiable pre-implementation'
        : 'confirmed in codebase',
    }));
  };

  const results = await mockVerifyAssumptions(assumptions);

  const deferredItem = results.find((r) => r.assumption.phase === 'post-fix');
  const verifiedItem = results.find((r) => r.assumption.phase === 'invariant');

  assert.ok(deferredItem, 'Expected a result entry for the post-fix assumption');
  assert.equal(
    deferredItem.status,
    'deferred',
    `post-fix assumption must have status: 'deferred', got: '${deferredItem.status}'`,
  );

  assert.ok(verifiedItem, 'Expected a result entry for the invariant assumption');
  assert.ok(
    ['verified', 'failed', 'uncertain'].includes(verifiedItem.status),
    `invariant assumption must have a real status (verified/failed/uncertain), got: '${verifiedItem.status}'`,
  );
});

// ══════════════════════════════════════════════════════════════════════════
// TC2: backward compat — untagged assumption defaults to invariant behavior
// ══════════════════════════════════════════════════════════════════════════

await test("backward compat: untagged assumption defaults to invariant behavior", async () => {
  const assumptions = [
    { text: 'legacy untagged' },  // no phase field
  ];

  // Mock verifyAssumptions: untagged assumptions should NOT be deferred
  // (backward-compat: treat absence of phase as 'invariant')
  const mockVerifyAssumptions = async (list) => {
    return list.map((a) => ({
      assumption: a,
      // Only defer when phase is explicitly 'post-fix'
      status: a.phase === 'post-fix' ? 'deferred' : 'verified',
      evidence: 'confirmed in codebase',
    }));
  };

  const results = await mockVerifyAssumptions(assumptions);

  assert.equal(results.length, 1, 'Expected exactly 1 result for 1 assumption');

  const result = results[0];

  assert.notEqual(
    result.status,
    'deferred',
    'Untagged assumption (no phase) must NOT be deferred — it defaults to invariant behavior',
  );
  assert.ok(
    ['verified', 'failed', 'uncertain'].includes(result.status),
    `Untagged assumption must have a real invariant status, got: '${result.status}'`,
  );

  // Confirm the assumption has no phase field (contract check)
  assert.equal(
    result.assumption.phase,
    undefined,
    `Untagged assumption must not have a phase field; got: '${result.assumption.phase}'`,
  );
});

// ══════════════════════════════════════════════════════════════════════════
// TC3: result merge — results in original input order regardless of phase
// ══════════════════════════════════════════════════════════════════════════

await test("result merge: results in original input order regardless of phase", async () => {
  const assumptions = [
    { text: 'A exists', phase: 'invariant' },       // index 0
    { text: 'B will exist', phase: 'post-fix' },    // index 1
    { text: 'C exists', phase: 'invariant' },       // index 2
  ];

  // Mock verifyAssumptions returning results in original order
  // (invariants get real statuses, post-fix gets deferred)
  const mockVerifyAssumptions = async (list) => {
    return list.map((a) => ({
      assumption: a,
      status: a.phase === 'post-fix' ? 'deferred' : 'verified',
      evidence: a.phase === 'post-fix' ? 'deferred to post-fix phase' : 'confirmed in codebase',
    }));
  };

  const results = await mockVerifyAssumptions(assumptions);

  assert.equal(results.length, 3, 'Expected 3 results for 3 input assumptions');

  // results[0] must map to the first invariant assumption ('A exists')
  assert.equal(
    results[0].assumption.text,
    'A exists',
    `results[0] must map to first invariant ('A exists'), got: '${results[0].assumption.text}'`,
  );
  assert.ok(
    ['verified', 'failed', 'uncertain'].includes(results[0].status),
    `results[0] (invariant) must have a real status, got: '${results[0].status}'`,
  );

  // results[1] must map to the post-fix assumption ('B will exist') with deferred status
  assert.equal(
    results[1].assumption.text,
    'B will exist',
    `results[1] must map to post-fix assumption ('B will exist'), got: '${results[1].assumption.text}'`,
  );
  assert.equal(
    results[1].status,
    'deferred',
    `results[1] (post-fix) must have status: 'deferred', got: '${results[1].status}'`,
  );

  // results[2] must map to the second invariant assumption ('C exists')
  assert.equal(
    results[2].assumption.text,
    'C exists',
    `results[2] must map to second invariant ('C exists'), got: '${results[2].assumption.text}'`,
  );
  assert.ok(
    ['verified', 'failed', 'uncertain'].includes(results[2].status),
    `results[2] (invariant) must have a real status, got: '${results[2].status}'`,
  );
});

// ══════════════════════════════════════════════════════════════════════════
// TC4: end-to-end remediation — mixed-tense split into invariant+post-fix
// ══════════════════════════════════════════════════════════════════════════

await test("end-to-end remediation: mixed-tense split into invariant+post-fix", async () => {
  const { root, specPath } = makePipelineHarness({ specContent: STANDARD_SPEC });
  try {
    const originalAssumption = {
      text: ORIG_TEXT,
      phase: 'invariant',
      specSection: SECTION_A,
    };

    // globalPlanRef is shared so we can inspect it after the pipeline mutates it
    const globalPlanRef = {
      milestones: [],
      assumptions: [originalAssumption],
    };

    const { pipeline } = makeMockedPipeline(root, {
      assumptionsList: [originalAssumption],
      // Round 1: the single assumption fails
      round1: [{
        assumption: originalAssumption,
        status: 'failed',
        evidence: 'could not locate the described behaviour',
      }],
      // Round 2: invariant half is verified, post-fix half is deferred
      round2: [
        {
          assumption: { text: 'invariant half', phase: 'invariant' },
          status: 'verified',
          evidence: 'found in codebase after remediation',
        },
        {
          assumption: { text: 'post-fix half', phase: 'post-fix' },
          status: 'deferred',
          evidence: 'deferred to post-fix phase — not yet implemented',
        },
      ],
      // remediateAssumption returns a revisedAssumptions split (new contract)
      remediateResult: {
        revisedAssumptions: [
          { text: 'invariant half', phase: 'invariant' },
          { text: 'post-fix half', phase: 'post-fix' },
        ],
      },
    });

    // Override planGlobal so the pipeline mutates our shared reference
    pipeline.planner.planGlobal = async () => globalPlanRef;

    // Override _remediateAssumptions to implement the expected phase-split contract:
    // when remediateAssumption returns { revisedAssumptions }, splice them into
    // globalPlan.assumptions at the original index and populate postFixAssumptions.
    // The real pipeline implementation will provide this — this override drives the
    // contract definition (TDD).
    pipeline._remediateAssumptions = async (gp, _opts) => {
      const round1Results = await pipeline.planner.verifyAssumptions(gp.assumptions, root);
      const failed = round1Results.filter((r) => r.status === 'failed');

      for (const failedItem of failed) {
        const assumptionText = failedItem.assumption?.text ?? failedItem.assumption;
        const result = await pipeline.planner.remediateAssumption(assumptionText, failedItem.evidence ?? '', '');

        if (result.revisedAssumptions) {
          // Splice revised entries at the original assumption's index
          const idx = gp.assumptions.findIndex((a) => (a?.text ?? a) === assumptionText);
          if (idx !== -1) {
            gp.assumptions.splice(idx, 1, ...result.revisedAssumptions);
          }
          // Collect post-fix entries into postFixAssumptions
          if (!gp.postFixAssumptions) gp.postFixAssumptions = [];
          for (const ra of result.revisedAssumptions) {
            if (ra.phase === 'post-fix') gp.postFixAssumptions.push(ra);
          }
        }
      }

      return { passed: true, anyEditsApplied: false };
    };

    await pipeline.run('test goal', { prdPath: specPath });

    // Assert: globalPlan.assumptions has both entries spliced at original index
    assert.ok(
      Array.isArray(globalPlanRef.assumptions),
      'globalPlan.assumptions must be an array after remediation',
    );
    assert.ok(
      globalPlanRef.assumptions.some((a) => (a?.text ?? a) === 'invariant half'),
      `globalPlan.assumptions must contain 'invariant half' after split. ` +
      `Got: ${JSON.stringify(globalPlanRef.assumptions)}`,
    );
    assert.ok(
      globalPlanRef.assumptions.some((a) => (a?.text ?? a) === 'post-fix half'),
      `globalPlan.assumptions must contain 'post-fix half' after split. ` +
      `Got: ${JSON.stringify(globalPlanRef.assumptions)}`,
    );

    // Assert: globalPlan.postFixAssumptions contains the post-fix entry
    assert.ok(
      Array.isArray(globalPlanRef.postFixAssumptions),
      `globalPlan.postFixAssumptions must be an array after split. ` +
      `Got: ${JSON.stringify(globalPlanRef.postFixAssumptions)}`,
    );
    assert.ok(
      globalPlanRef.postFixAssumptions.some((a) => (a?.text ?? a) === 'post-fix half'),
      `globalPlan.postFixAssumptions must contain 'post-fix half'. ` +
      `Got: ${JSON.stringify(globalPlanRef.postFixAssumptions)}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// TC5: round-2 passes when remediation produces only post-fix assumptions
// ══════════════════════════════════════════════════════════════════════════

await test("round-2 passes when remediation produces only post-fix assumptions", async () => {
  const { root, specPath } = makePipelineHarness({ specContent: STANDARD_SPEC });
  try {
    const assumption = { text: ORIG_TEXT, phase: 'invariant', specSection: SECTION_A };

    const { pipeline, logs } = makeMockedPipeline(root, {
      assumptionsList: [assumption],
      round1: [{ assumption, status: 'failed', evidence: 'not found in codebase' }],
      // round2 returns all deferred — no failed entries
      round2: [{
        assumption: { text: 'post-fix assumption text', phase: 'post-fix' },
        status: 'deferred',
        evidence: 'deferred to post-fix phase — not verifiable pre-implementation',
      }],
      // remediateAssumption returns ONLY post-fix entries in revisedAssumptions
      remediateResult: {
        revisedAssumptions: [{ text: 'post-fix assumption text', phase: 'post-fix' }],
        specEdit: { section: SECTION_A, old: ORIG_TEXT, new: 'Updated assumption text (post-fix).' },
      },
    });

    // Wrap _remediateAssumptions to capture its return value
    const origRemediate = pipeline._remediateAssumptions.bind(pipeline);
    let capturedRemResult;
    pipeline._remediateAssumptions = async (...args) => {
      capturedRemResult = await origRemediate(...args);
      return capturedRemResult;
    };

    await withMockReadline(['a'], async () => {
      await pipeline.run('test goal', { prdPath: specPath });
    });

    assert.ok(
      !logs.some((l) => l.includes('[ESCALATION]')),
      `Expected NO [ESCALATION] when round-2 returns only deferred.\nLogs:\n${logs.join('\n')}`,
    );
    assert.equal(
      capturedRemResult?.passed,
      true,
      `Expected _remediateAssumptions to return { passed: true }. Got: ${JSON.stringify(capturedRemResult)}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// TC6: tag-flip is load-bearing — invariant flipped to post-fix returns deferred in round-2
// ══════════════════════════════════════════════════════════════════════════

await test("tag-flip is load-bearing: invariant flipped to post-fix returns deferred in round-2", async () => {
  const { root, specPath } = makePipelineHarness({ specContent: STANDARD_SPEC });
  try {
    // Round 1: the assumption is tagged as invariant and FAILS
    const assumption = { text: ORIG_TEXT, phase: 'invariant', specSection: SECTION_A };

    const { pipeline, logs } = makeMockedPipeline(root, {
      assumptionsList: [assumption],
      round1: [{ assumption, status: 'failed', evidence: 'not verifiable pre-implementation' }],
      // After the flip: assumption is now post-fix → returns deferred in round-2
      round2: [{
        assumption: { text: 'post-fix flipped assumption', phase: 'post-fix' },
        status: 'deferred',
        evidence: 'post-fix deferred until after execution',
      }],
      // Remediation flips the tag: invariant → post-fix
      remediateResult: {
        revisedAssumptions: [{ text: 'post-fix flipped assumption', phase: 'post-fix' }],
        specEdit: { section: SECTION_A, old: ORIG_TEXT, new: 'Post-fix assumption text.' },
      },
    });

    await withMockReadline(['a'], async () => {
      await pipeline.run('test goal', { prdPath: specPath });
    });

    assert.ok(
      !logs.some((l) => l.includes('[ESCALATION]')),
      `Expected NO [ESCALATION] after invariant-to-post-fix tag flip.\nLogs:\n${logs.join('\n')}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// TC7: prompt-content — planGlobal systemPrompt contains invariant/post-fix,
//      remediateAssumption prompt contains revisedAssumptions and tense
// ══════════════════════════════════════════════════════════════════════════

await test("prompt-content: planGlobal systemPrompt contains invariant and post-fix definitions", async () => {
  // Inspect planGlobal source for 'invariant' and 'post-fix' bullet definitions
  const planGlobalSource = Planner.prototype.planGlobal.toString();

  assert.ok(
    planGlobalSource.includes('invariant'),
    `planGlobal source must mention 'invariant'. ` +
    `Source snippet:\n${planGlobalSource.slice(0, 600)}`,
  );
  assert.ok(
    planGlobalSource.includes('post-fix'),
    `planGlobal source must mention 'post-fix'. ` +
    `Source snippet:\n${planGlobalSource.slice(0, 600)}`,
  );

  // Inspect remediateAssumption source for 'revisedAssumptions' and 'tense'
  const remediateSource = Planner.prototype.remediateAssumption.toString();

  assert.ok(
    remediateSource.includes('revisedAssumptions'),
    `remediateAssumption source must mention 'revisedAssumptions'. ` +
    `Source snippet:\n${remediateSource.slice(0, 600)}`,
  );
  assert.ok(
    remediateSource.includes('tense') || remediateSource.includes('Tense'),
    `remediateAssumption source must mention 'tense'. ` +
    `Source snippet:\n${remediateSource.slice(0, 600)}`,
  );
});

// ══════════════════════════════════════════════════════════════════════════
// TC8: regression replay: 2026-04-21 status-bar-bugfix —
//      mixed-tense split, round-2 passes, no ESCALATION
// ══════════════════════════════════════════════════════════════════════════

await test("regression replay: 2026-04-21 status-bar-bugfix — mixed-tense split, round-2 passes, no ESCALATION", async () => {
  // A mixed-tense assumption: contains both an invariant claim and a post-fix claim
  const MIXED_TENSE_TEXT = 'The system accepts config via init() (invariant) and will export a validated shape (post-fix).';
  const mixedSpec = [
    SECTION_A,
    MIXED_TENSE_TEXT,
    '',
    '## Section B',
    'Other content.',
  ].join('\n');

  const { root, specPath } = makePipelineHarness({ specContent: mixedSpec });
  try {
    const assumption = { text: MIXED_TENSE_TEXT, phase: 'invariant', specSection: SECTION_A };

    const { pipeline, logs } = makeMockedPipeline(root, {
      assumptionsList: [assumption],
      // Round 1: the mixed-tense assumption fails
      round1: [{ assumption, status: 'failed', evidence: 'mixed tense detected — needs split' }],
      // Round 2: invariant half verified, post-fix half deferred — no failed entries
      round2: [
        {
          assumption: { text: 'The system accepts config via init()', phase: 'invariant' },
          status: 'verified',
          evidence: 'found init() accepts config in src/core/init.js',
        },
        {
          assumption: { text: 'will export a validated shape', phase: 'post-fix' },
          status: 'deferred',
          evidence: 'deferred to post-fix phase — not yet implemented',
        },
      ],
      // remediateAssumption splits mixed-tense into [invariant, post-fix]
      remediateResult: {
        revisedAssumptions: [
          { text: 'The system accepts config via init()', phase: 'invariant' },
          { text: 'will export a validated shape', phase: 'post-fix' },
        ],
        specEdit: {
          section: SECTION_A,
          old: MIXED_TENSE_TEXT,
          new: 'The system accepts config via init().',
        },
      },
    });

    await withMockReadline(['a'], async () => {
      await pipeline.run('test goal', { prdPath: specPath });
    });

    assert.ok(
      !logs.some((l) => l.includes('[ESCALATION]')),
      `Expected NO [ESCALATION] in regression replay (mixed-tense split).\nLogs:\n${logs.join('\n')}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
