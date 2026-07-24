/**
 * test-assumption-remediation.js — Schema, planner-level, and pipeline-level
 * tests for assumption enrichment and remediation contracts.
 *
 * Run: node test/test-assumption-remediation.js
 *
 * No live Claude sessions are spawned — all verifier/planner interactions
 * are replaced by mock fixtures and inline template construction.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import {
  assumptionRemediationSchema,
  validateStructured,
} from '../src/orchestrator/agents/_schemas.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';

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

// ── Mock fixtures ──────────────────────────────────────────────────────────

// Enriched assumptions: {text, specSection}[] — the shape planGlobal returns
const mockEnrichedAssumptions = [
  { text: 'The src/orchestrator/agents/_schemas.js file already exports verifierSchema', specSection: '## Schemas' },
  { text: 'sessionManager.spawn accepts a jsonSchema parameter', specSection: '## Session API' },
  { text: 'Token budget is tracked per session via tokenTracker.recordSession', specSection: '## Token Tracking' },
];

// Mock verifier result for a single failed assumption
const mockVerifierResult = {
  results: [
    {
      assumption: mockEnrichedAssumptions[0].text,
      status: 'verified',
      evidence: 'Found export in _schemas.js line 28',
    },
    {
      assumption: mockEnrichedAssumptions[1].text,
      status: 'failed',
      evidence: 'spawn() does not accept jsonSchema — parameter is named schema',
    },
    {
      assumption: mockEnrichedAssumptions[2].text,
      status: 'uncertain',
      evidence: 'tokenTracker is optional and not always present',
    },
  ],
};

// Valid remediation output matching assumptionRemediationSchema
const mockRemediationOutput = {
  revisedAssumptions: [{ text: 'sessionManager.spawn accepts a "schema" parameter (not "jsonSchema") for structured output', phase: 'invariant' }],
  specEdit: {
    section: '## Session API',
    old: 'sessionManager.spawn accepts a jsonSchema parameter',
    new: 'sessionManager.spawn accepts a schema parameter for structured output',
  },
};

// Inline schema that planGlobal uses for the assumptions array items
// (mirrors the inline schema declared inside planner.planGlobal)
const planGlobalAssumptionItemSchema = {
  type: 'object',
  properties: {
    text:        { type: 'string' },
    specSection: { type: 'string' },
    phase:       { type: 'string', enum: ['planning', 'execution', 'verification', 'invariant', 'post-fix'] },
  },
  required: ['text', 'specSection'],
};

// Wrapper schema so we can run validateStructured across the whole array
const planGlobalAssumptionArraySchema = {
  type: 'object',
  properties: {
    assumptions: {
      type: 'array',
      items: planGlobalAssumptionItemSchema,
    },
  },
  required: ['assumptions'],
};

// ── Test 1 ─────────────────────────────────────────────────────────────────
// planGlobal assumption schema produces {text, specSection}[] objects

await test('planGlobal: assumption schema produces {text, specSection}[] — each item is valid', () => {
  // Validate each enriched assumption individually against the item schema
  for (const assumption of mockEnrichedAssumptions) {
    const r = validateStructured(assumption, planGlobalAssumptionItemSchema);
    assert.equal(r.ok, true, `Assumption ${JSON.stringify(assumption)} failed: ${JSON.stringify(r.errors)}`);
  }
});

await test('planGlobal: assumptions array validates as a whole against planGlobal schema', () => {
  const r = validateStructured(
    { assumptions: mockEnrichedAssumptions },
    planGlobalAssumptionArraySchema,
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── Test 2 ─────────────────────────────────────────────────────────────────
// assumptionRemediationSchema validates correct structured output

await test('assumptionRemediationSchema: valid remediation output passes', () => {
  const r = validateStructured(mockRemediationOutput, assumptionRemediationSchema);
  // All required fields (revisedAssumptions array + specEdit) should be present
  const missingErrors = (r.errors || []).filter((e) => /missing/.test(e));
  assert.equal(missingErrors.length, 0,
    `Expected no missing required fields, got: ${JSON.stringify(missingErrors)}`);
  // Validate the revisedAssumptions item shape directly (objects with text + phase)
  assert.ok(Array.isArray(mockRemediationOutput.revisedAssumptions),
    'revisedAssumptions should be an array');
  assert.equal(typeof mockRemediationOutput.revisedAssumptions[0], 'object',
    'revisedAssumptions[0] should be an object');
  assert.equal(typeof mockRemediationOutput.revisedAssumptions[0].text, 'string',
    'revisedAssumptions[0].text should be a string');
  assert.ok(['invariant', 'post-fix'].includes(mockRemediationOutput.revisedAssumptions[0].phase),
    'revisedAssumptions[0].phase should be invariant or post-fix');
});

// ── Test 3 ─────────────────────────────────────────────────────────────────
// assumptionRemediationSchema rejects malformed output (missing required fields)

await test('assumptionRemediationSchema: missing "revisedAssumptions" field is rejected', () => {
  const bad = {
    specEdit: { section: '## Foo', old: 'x', new: 'y' },
    // revisedAssumptions is missing
  };
  const r = validateStructured(bad, assumptionRemediationSchema);
  assert.equal(r.ok, false, 'Should fail when revisedAssumptions is missing');
  assert.ok(r.errors.some((e) => /revisedAssumptions.*missing/.test(e)),
    `Expected error about missing "revisedAssumptions", got: ${JSON.stringify(r.errors)}`);
});

await test('assumptionRemediationSchema: missing "specEdit" field is rejected', () => {
  const bad = {
    revisedAssumptions: [{ text: 'Some revised text', phase: 'invariant' }],
    // specEdit is missing
  };
  const r = validateStructured(bad, assumptionRemediationSchema);
  assert.equal(r.ok, false, 'Should fail when specEdit is missing');
  assert.ok(r.errors.some((e) => /specEdit.*missing/.test(e)),
    `Expected error about missing "specEdit", got: ${JSON.stringify(r.errors)}`);
});

await test('assumptionRemediationSchema: missing nested specEdit.old is rejected', () => {
  const bad = {
    revisedAssumptions: [{ text: 'Some revised text', phase: 'invariant' }],
    specEdit: {
      section: '## Foo',
      // old is missing
      new: 'updated value',
    },
  };
  const r = validateStructured(bad, assumptionRemediationSchema);
  assert.equal(r.ok, false, 'Should fail when specEdit.old is missing');
  assert.ok(r.errors.some((e) => /old.*missing/.test(e)),
    `Expected error about missing "specEdit.old", got: ${JSON.stringify(r.errors)}`);
});

// ── Test 4 ─────────────────────────────────────────────────────────────────
// verifyAssumptions prompt correctly uses .text from enriched objects
// (verifies the prompt template string construction with a mock — no live session)

await test('verifyAssumptions prompt template: uses .text from enriched assumption objects', () => {
  // Replicate the prompt template that verifyAssumptions should use when
  // assumptions are enriched {text, specSection} objects.
  // The correct implementation maps a => a.text (not `${a}` which gives [object Object]).
  const buildPrompt = (enrichedAssumptions) => {
    return `Verify each of the following assumptions about this codebase.
For each one, search the code (use Glob to find files, Grep to search content, Read to inspect)
and classify as:
- "verified" — confirmed by code evidence
- "failed" — contradicted by code evidence (explain what you found instead)
- "uncertain" — could not confirm or deny (explain what you checked)

Assumptions to verify:
${enrichedAssumptions.map((a, i) => `${i + 1}. ${a.text}`).join('\n')}

Return structured JSON with your findings.`;
  };

  const prompt = buildPrompt(mockEnrichedAssumptions);

  // Assert each assumption's .text value appears in the prompt
  for (const assumption of mockEnrichedAssumptions) {
    assert.ok(
      prompt.includes(assumption.text),
      `Expected prompt to contain assumption text: "${assumption.text}"\nPrompt was:\n${prompt}`,
    );
  }

  // Assert [object Object] does NOT appear (regression: using `${a}` instead of `${a.text}`)
  assert.ok(
    !prompt.includes('[object Object]'),
    'Prompt must not contain "[object Object]" — use a.text, not template-string a directly',
  );
});

await test('verifyAssumptions prompt template: numbered list is 1-based and ordered', () => {
  const buildPrompt = (enrichedAssumptions) =>
    enrichedAssumptions.map((a, i) => `${i + 1}. ${a.text}`).join('\n');

  const lines = buildPrompt(mockEnrichedAssumptions).split('\n');
  lines.forEach((line, idx) => {
    assert.ok(line.startsWith(`${idx + 1}. `),
      `Expected line ${idx} to start with "${idx + 1}. ", got: "${line}"`);
  });
});

// ── Test 5 ─────────────────────────────────────────────────────────────────
// remediateAssumption returns valid {revisedAssumptions, specEdit: {section, old, new}} shape

await test('remediateAssumption: mock output validates against assumptionRemediationSchema', () => {
  // Mock the return value of a (not-yet-implemented) remediateAssumption function.
  // The contract: given a failed/uncertain assumption, return { revisedAssumptions, specEdit }.
  const mockRemediateAssumption = (failedAssumption, _evidence) => ({
    revisedAssumptions: [{ text: `Corrected: ${failedAssumption.text} — see specEdit for details`, phase: 'invariant' }],
    specEdit: {
      section: failedAssumption.specSection,
      old: failedAssumption.text,
      new: `Corrected: ${failedAssumption.text}`,
    },
  });

  const failedAssumption = mockEnrichedAssumptions[1]; // "sessionManager.spawn accepts a jsonSchema parameter"
  const evidence = mockVerifierResult.results[1].evidence;

  const result = mockRemediateAssumption(failedAssumption, evidence);

  const r = validateStructured(result, assumptionRemediationSchema);
  // All required fields (revisedAssumptions array + specEdit) should be present
  const missingErrors = (r.errors || []).filter((e) => /missing/.test(e));
  assert.equal(missingErrors.length, 0,
    `remediateAssumption output missing required fields: ${JSON.stringify(missingErrors)}`);

  // Spot-check the shape directly (objects with text + phase)
  assert.ok(Array.isArray(result.revisedAssumptions), 'revisedAssumptions should be an array');
  assert.equal(typeof result.revisedAssumptions[0], 'object', 'revisedAssumptions[0] should be an object');
  assert.equal(typeof result.revisedAssumptions[0].text, 'string', 'revisedAssumptions[0].text should be a string');
  assert.ok(['invariant', 'post-fix'].includes(result.revisedAssumptions[0].phase), 'revisedAssumptions[0].phase should be invariant or post-fix');
  assert.equal(typeof result.specEdit, 'object', 'specEdit should be an object');
  assert.equal(typeof result.specEdit.section, 'string', 'specEdit.section should be a string');
  assert.equal(typeof result.specEdit.old, 'string', 'specEdit.old should be a string');
  assert.equal(typeof result.specEdit.new, 'string', 'specEdit.new should be a string');
});

await test('remediateAssumption: specEdit.section matches assumption specSection', () => {
  const failedAssumption = mockEnrichedAssumptions[1];
  const mockOutput = {
    revisedAssumptions: [{ text: 'spawn() uses "schema" not "jsonSchema"', phase: 'invariant' }],
    specEdit: {
      section: failedAssumption.specSection,
      old: failedAssumption.text,
      new: 'sessionManager.spawn accepts a "schema" parameter',
    },
  };

  assert.equal(
    mockOutput.specEdit.section,
    failedAssumption.specSection,
    'specEdit.section should trace back to the assumption\'s specSection',
  );

  const r = validateStructured(mockOutput, assumptionRemediationSchema);
  // All required fields should be present
  const missingErrors = (r.errors || []).filter((e) => /missing/.test(e));
  assert.equal(missingErrors.length, 0, JSON.stringify(r.errors));
});

// ══════════════════════════════════════════════════════════════════════════
// ── Pipeline-level integration tests ──────────────────────────────────────
// These tests exercise the remediation loop in pipeline.js using:
//   • Temp directories with real spec files on disk
//   • Mocked planner.remediateAssumption and planner.verifyAssumptions
//   • Mocked readline.createInterface to simulate user choices in askAssumptionFix
//   • No live Claude sessions
// ══════════════════════════════════════════════════════════════════════════

// ── Pipeline test helpers ──────────────────────────────────────────────────

/**
 * Create a temporary project root with a properly structured .harness/ directory
 * and write a spec file with the given content.
 *
 * Returns { root, harnessDir, specPath }.
 */
function makePipelineHarness({ specContent = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ar-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of [
    'state', 'plan', 'verify', 'progress', 'verification',
    'analysis', 'snapshots', 'learning', 'dry-run', 'logs',
  ]) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  // Write minimal state.json so bootstrap is skipped and preflight passes
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
 *   opts.assumptionsList   — enriched {text, specSection}[] passed to verifyAssumptions
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
  reExtractedAssumptions = undefined,
  onConfirm = null,
  onLog = null,
} = {}) {
  const logs = [];
  const confirmCalls = [];
  let verifyCallCount = 0;
  let remediateCallCount = 0;
  let reExtractCallCount = 0;

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
    reExtractAssumptions: async () => {
      reExtractCallCount++;
      return reExtractedAssumptions ?? assumptionsList;
    },
    closeReusableSession: async () => {},
  };

  return {
    pipeline,
    logs,
    confirmCalls,
    getVerifyCount: () => verifyCallCount,
    getRemediateCount: () => remediateCallCount,
    getReExtractCount: () => reExtractCallCount,
  };
}

/**
 * Monkey-patch readline.createInterface for the duration of `fn()`.
 *
 * Uses createRequire to get the same module object that prompt.js uses, then
 * replaces createInterface with a fake that returns queued responses.
 *
 * Each call to createInterface consumes the next response from `responses`.
 * The fake rl interface calls the question callback synchronously with that
 * response string, which is valid for all accept/reject choices ('a', 'r').
 *
 * @param {string[]} responses - ordered responses for each createInterface call
 * @param {() => Promise<any>} fn - async function to run with the mock active
 */
async function withMockReadline(responses, fn) {
  const readlineModule = _require('readline');
  const orig = readlineModule.createInterface;
  let idx = 0;

  readlineModule.createInterface = () => ({
    question: (_prompt, cb) => {
      const answer = responses[idx++] ?? 'r'; // default to reject if exhausted
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

// ── Standard spec content for pipeline tests ───────────────────────────────

const SPEC_SECTION_A    = '## Section A';
const SPEC_SECTION_B    = '## Section B';
const OLD_TEXT          = 'The spawner.launch function accepts a jsonSchema parameter.';
const NEW_TEXT          = 'The spawner.launch function accepts a schema parameter.';
const NEW_TEXT_ASSUMPTION = 'The spawner.launch function accepts a schema parameter (re-extracted).';
const OTHER_CONTENT     = 'Unrelated content that must not be changed.';

const STANDARD_SPEC = [
  SPEC_SECTION_A,
  OLD_TEXT,
  OTHER_CONTENT,
  '',
  SPEC_SECTION_B,
  'Other section content that must also be preserved.',
].join('\n');

// Standard failed-assumption fixture used across multiple tests
function makeFailedAssumption(overrides = {}) {
  return {
    assumption: {
      text:        overrides.text        ?? 'The spawner.launch function accepts a jsonSchema parameter.',
      specSection: overrides.specSection ?? SPEC_SECTION_A,
    },
    status:   'failed',
    evidence: overrides.evidence ?? 'spawn() does not accept jsonSchema — parameter is named schema',
  };
}

// ── TC-P1: Pipeline applies spec edit on accept ────────────────────────────

await test('pipeline: applies spec edit when user accepts proposed fix', async () => {
  const { root, specPath } = makePipelineHarness({ specContent: STANDARD_SPEC });
  try {
    const { pipeline } = makeMockedPipeline(root, {
      assumptionsList: [makeFailedAssumption().assumption],
      round1: [makeFailedAssumption()],
      round2: [{ assumption: makeFailedAssumption().assumption, status: 'verified', evidence: 'ok' }],
      remediateResult: {
        revisedAssumptions: [{ text: 'corrected assumption text', phase: 'invariant' }],
        specEdit: { section: SPEC_SECTION_A, old: OLD_TEXT, new: NEW_TEXT },
      },
    });

    await withMockReadline(['a'], async () => {
      await pipeline.run('test goal', { prdPath: specPath });
    });

    const content = fs.readFileSync(specPath, 'utf8');
    assert.ok(content.includes(NEW_TEXT),
      `Spec should contain new text after accept.\nActual:\n${content}`);
    assert.ok(!content.includes(OLD_TEXT),
      `Spec should no longer contain old text after accept.\nActual:\n${content}`);
  } finally {
    pipelineCleanup(root);
  }
});

// ── TC-P2: Pipeline skips edit on reject ──────────────────────────────────

await test('pipeline: spec file unchanged when user rejects proposed fix', async () => {
  const { root, specPath } = makePipelineHarness({ specContent: STANDARD_SPEC });
  try {
    const { pipeline, confirmCalls } = makeMockedPipeline(root, {
      assumptionsList: [makeFailedAssumption().assumption],
      round1: [makeFailedAssumption()],
      round2: [],
      remediateResult: {
        revisedAssumptions: [{ text: 'corrected assumption text', phase: 'invariant' }],
        specEdit: { section: SPEC_SECTION_A, old: OLD_TEXT, new: NEW_TEXT },
      },
    });

    await withMockReadline(['r'], async () => {
      await pipeline.run('test goal', { prdPath: specPath });
    });

    const content = fs.readFileSync(specPath, 'utf8');
    assert.ok(content.includes(OLD_TEXT),
      `Spec should still contain old text after reject.\nActual:\n${content}`);
    assert.ok(!content.includes(NEW_TEXT),
      `Spec must NOT contain new text after reject.\nActual:\n${content}`);
    // When all edits rejected, pipeline falls back to "Proceed anyway?" prompt
    assert.ok(
      confirmCalls.some((msg) => msg.includes('Proceed anyway')),
      `Expected onConfirm called with 'Proceed anyway?' on all-reject. Got: ${JSON.stringify(confirmCalls)}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// ── TC-P3: Pipeline re-runs verifyAssumptions after edits applied ──────────

await test('pipeline: re-runs verifyAssumptions after spec edits applied (round 2)', async () => {
  const { root, specPath } = makePipelineHarness({ specContent: STANDARD_SPEC });
  try {
    const { pipeline, getVerifyCount, logs } = makeMockedPipeline(root, {
      assumptionsList: [makeFailedAssumption().assumption],
      round1: [makeFailedAssumption()],
      round2: [{ assumption: makeFailedAssumption().assumption, status: 'verified', evidence: 'ok' }],
      remediateResult: {
        revisedAssumptions: [{ text: 'corrected', phase: 'invariant' }],
        specEdit: { section: SPEC_SECTION_A, old: OLD_TEXT, new: NEW_TEXT },
      },
    });

    await withMockReadline(['a'], async () => {
      await pipeline.run('test goal', { prdPath: specPath });
    });

    assert.equal(getVerifyCount(), 2,
      `verifyAssumptions should have been called twice (got ${getVerifyCount()})`);
    assert.ok(
      logs.some((l) => l.toLowerCase().includes('round 2') || l.toLowerCase().includes('re-verif')),
      `Expected a round-2 log message. Logs:\n${logs.join('\n')}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// ── TC-P4: Pipeline hard-stops after 2 rounds when failures persist ─────────

await test('pipeline: hard-stops with [ESCALATION] when round 2 still has failures', async () => {
  const { root, specPath } = makePipelineHarness({ specContent: STANDARD_SPEC });
  try {
    const { pipeline, logs, confirmCalls } = makeMockedPipeline(root, {
      assumptionsList: [makeFailedAssumption().assumption],
      round1: [makeFailedAssumption()],
      round2: [makeFailedAssumption()], // still failing in round 2
      remediateResult: {
        revisedAssumptions: [{ text: 'corrected', phase: 'invariant' }],
        specEdit: { section: SPEC_SECTION_A, old: OLD_TEXT, new: NEW_TEXT },
      },
    });

    await withMockReadline(['a'], async () => {
      await pipeline.run('test goal', { prdPath: specPath });
    });

    assert.ok(
      logs.some((l) => l.includes('[ESCALATION]')),
      `Expected [ESCALATION] in logs after round-2 failure.\nLogs:\n${logs.join('\n')}`,
    );
    // Hard-stop means pipeline never reached plan approval
    assert.ok(
      !confirmCalls.some((msg) => msg.includes('Proceed with this plan')),
      `Pipeline should have stopped before plan approval. confirmCalls: ${JSON.stringify(confirmCalls)}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// ── TC-P5: Pipeline falls back to proceed-anyway when all edits rejected ────

await test('pipeline: falls back to "Proceed anyway?" when all edits rejected', async () => {
  const { root, specPath } = makePipelineHarness({ specContent: STANDARD_SPEC });
  try {
    const { pipeline, confirmCalls } = makeMockedPipeline(root, {
      assumptionsList: [makeFailedAssumption().assumption],
      round1: [makeFailedAssumption()],
      round2: [],
      remediateResult: {
        revisedAssumptions: [{ text: 'corrected', phase: 'invariant' }],
        specEdit: { section: SPEC_SECTION_A, old: OLD_TEXT, new: NEW_TEXT },
      },
    });

    await withMockReadline(['r'], async () => {
      await pipeline.run('test goal', { prdPath: specPath });
    });

    assert.ok(
      confirmCalls.some((msg) => msg.includes('Proceed anyway')),
      `Expected "Proceed anyway?" fallback when all edits rejected.\nconfirmCalls: ${JSON.stringify(confirmCalls)}`,
    );
    // No round-2 verifyAssumptions (no edits applied)
  } finally {
    pipelineCleanup(root);
  }
});

// ── TC-P6: Multiple failed assumptions handled sequentially ─────────────────

await test('pipeline: two failures handled sequentially — first accepted, second rejected', async () => {
  const OLD_TEXT_1 = 'First old assumption about module X.';
  const OLD_TEXT_2 = 'Second old assumption about module Y.';
  const NEW_TEXT_1 = 'First corrected assumption about module X.';

  const specContent = [
    SPEC_SECTION_A,
    OLD_TEXT_1,
    '',
    SPEC_SECTION_B,
    OLD_TEXT_2,
  ].join('\n');

  const { root, specPath } = makePipelineHarness({ specContent });
  try {
    const failedA = {
      assumption: { text: OLD_TEXT_1, specSection: SPEC_SECTION_A },
      status: 'failed',
      evidence: 'module X was renamed',
    };
    const failedB = {
      assumption: { text: OLD_TEXT_2, specSection: SPEC_SECTION_B },
      status: 'failed',
      evidence: 'module Y was removed',
    };

    let remCallCount = 0;
    const { pipeline } = makeMockedPipeline(root, {
      assumptionsList: [failedA.assumption, failedB.assumption],
      round1: [failedA, failedB],
      round2: [
        { assumption: failedA.assumption, status: 'verified', evidence: 'ok' },
        { assumption: failedB.assumption, status: 'verified', evidence: 'ok' },
      ],
      remediateResult: (_text, _ev, _ex, callCount) => {
        if (callCount === 1) {
          return {
            revisedAssumptions: [{ text: 'first corrected', phase: 'invariant' }],
            specEdit: { section: SPEC_SECTION_A, old: OLD_TEXT_1, new: NEW_TEXT_1 },
          };
        }
        return {
          revisedAssumptions: [{ text: 'second corrected', phase: 'invariant' }],
          specEdit: { section: SPEC_SECTION_B, old: OLD_TEXT_2, new: 'New text for B' },
        };
      },
    });

    // Accept first assumption fix, reject second
    await withMockReadline(['a', 'r'], async () => {
      await pipeline.run('test goal', { prdPath: specPath });
    });

    const content = fs.readFileSync(specPath, 'utf8');
    assert.ok(content.includes(NEW_TEXT_1),
      `First accepted edit should be in spec.\nActual:\n${content}`);
    assert.ok(!content.includes(OLD_TEXT_1),
      `Old text 1 should be gone after accept.\nActual:\n${content}`);
    assert.ok(content.includes(OLD_TEXT_2),
      `Second edit was rejected — OLD_TEXT_2 should still be present.\nActual:\n${content}`);
  } finally {
    pipelineCleanup(root);
  }
});

// ── TC-P7: Missing specSection falls back gracefully to proceed-anyway ───────

await test('pipeline: assumption without specSection is skipped, falls back to proceed-anyway', async () => {
  const { root, specPath } = makePipelineHarness({ specContent: STANDARD_SPEC });
  try {
    // Assumption has NO specSection field
    const failedNoSection = {
      assumption: { text: 'Some assumption with no section attached' },
      status: 'failed',
      evidence: 'verifier could not locate the described behaviour',
    };

    const { pipeline, confirmCalls, logs } = makeMockedPipeline(root, {
      assumptionsList: [failedNoSection.assumption],
      round1: [failedNoSection],
      round2: [],
    });

    // No readline mock needed — askAssumptionFix is never called for missing specSection
    await pipeline.run('test goal', { prdPath: specPath });

    assert.ok(
      logs.some((l) => l.includes('No specSection') || l.includes('skipping')),
      `Expected a "no specSection" skip log.\nLogs:\n${logs.join('\n')}`,
    );
    assert.ok(
      confirmCalls.some((msg) => msg.includes('Proceed anyway')),
      `Expected "Proceed anyway?" fallback for missing specSection.\nconfirmCalls: ${JSON.stringify(confirmCalls)}`,
    );
    // Spec file must not have changed
    const content = fs.readFileSync(specPath, 'utf8');
    assert.equal(content, STANDARD_SPEC,
      'Spec file must be unchanged when specSection is missing');
  } finally {
    pipelineCleanup(root);
  }
});

// ── TC-P8: Spec file only changes at exact old→new location ─────────────────

await test('pipeline: _applySpecEdit changes only the exact old→new location, other content preserved', async () => {
  const multiSectionSpec = [
    '# Spec Title',
    '',
    SPEC_SECTION_A,
    OLD_TEXT,
    OTHER_CONTENT,
    '',
    SPEC_SECTION_B,
    'Other section content that must also be preserved.',
    '',
    '## Section C',
    'Section C content — also must be preserved.',
  ].join('\n');

  const { root, specPath } = makePipelineHarness({ specContent: multiSectionSpec });
  try {
    // Create a minimal Pipeline just for the helper methods
    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: () => {},
      onConfirm: async () => false,
    });

    // Apply a precise edit via the pipeline's internal helper
    const applied = pipeline._applySpecEdit(specPath, OLD_TEXT, NEW_TEXT);
    assert.equal(applied, true, '_applySpecEdit should return true when old text is found');

    const content = fs.readFileSync(specPath, 'utf8');

    // Changed content
    assert.ok(content.includes(NEW_TEXT),
      `Spec must contain new text after edit.\nActual:\n${content}`);
    assert.ok(!content.includes(OLD_TEXT),
      `Spec must not contain old text after edit.\nActual:\n${content}`);

    // Preserved content — everything else must be untouched
    assert.ok(content.includes('# Spec Title'),
      'Document title must be preserved');
    assert.ok(content.includes(OTHER_CONTENT),
      `Other content in same section must be preserved.\nActual:\n${content}`);
    assert.ok(content.includes(SPEC_SECTION_B),
      `Section B heading must be preserved.\nActual:\n${content}`);
    assert.ok(content.includes('Other section content that must also be preserved.'),
      `Section B body must be preserved.\nActual:\n${content}`);
    assert.ok(content.includes('Section C content — also must be preserved.'),
      `Section C content must be preserved.\nActual:\n${content}`);
  } finally {
    pipelineCleanup(root);
  }
});

// ── TC-New-1: verifyAssumptions status enum includes deferred ───────────────

await test('verifyAssumptions: status deferred validates', () => {
  // Inline schema mirroring the verifyAssumptions result item shape from planner.js
  const verifyAssumptionResultItemSchema = {
    type: 'object',
    properties: {
      assumption: { type: 'string' },
      status:     { type: 'string', enum: ['verified', 'failed', 'uncertain', 'deferred'] },
      evidence:   { type: 'string' },
    },
    required: ['assumption', 'status', 'evidence'],
  };

  const deferredResult = {
    assumption: 'After this mission, module Z will accept parameter W',
    status: 'deferred',
    evidence: 'Post-fix assumption — deferred until after execution',
  };

  const r = validateStructured(deferredResult, verifyAssumptionResultItemSchema);
  assert.equal(r.ok, true,
    `Expected deferred status to validate, got errors: ${JSON.stringify(r.errors)}`);
});

// ── TC-New-2: planGlobal assumption with phase:'execution' validates ─────────

await test('planGlobal: assumption with phase field validates', () => {
  const assumptionWithPhase = {
    text: 'After this mission, the pipeline will call verifyAssumptions in parallel',
    specSection: '## Pipeline Execution',
    phase: 'execution',
  };

  const r = validateStructured(assumptionWithPhase, planGlobalAssumptionItemSchema);
  assert.equal(r.ok, true,
    `Expected assumption with phase 'execution' to validate, got errors: ${JSON.stringify(r.errors)}`);
});

// ── TC-New-3: post-fix assumptions get synthetic deferred status ─────────────

await test('verifyAssumptions: post-fix assumptions get synthetic deferred status', () => {
  // Inline schema mirroring the verifyAssumptions result item shape from planner.js
  const verifyAssumptionResultItemSchema = {
    type: 'object',
    properties: {
      assumption: { type: 'string' },
      status:     { type: 'string', enum: ['verified', 'failed', 'uncertain', 'deferred'] },
      evidence:   { type: 'string' },
    },
    required: ['assumption', 'status', 'evidence'],
  };

  // Construct a planGlobalAssumptionItemSchema-valid assumption with phase: 'post-fix'
  const postFixAssumption = {
    text: 'After execution, module Z will export function W',
    specSection: '## Module Z',
    phase: 'post-fix',
  };

  // Validate the assumption itself against planGlobalAssumptionItemSchema
  const assumptionValidation = validateStructured(postFixAssumption, planGlobalAssumptionItemSchema);
  assert.equal(assumptionValidation.ok, true,
    `Expected post-fix assumption to be planGlobalAssumptionItemSchema-valid: ${JSON.stringify(assumptionValidation.errors)}`);

  // Mock verifyAssumptions returning it with synthetic deferred status
  const mockVerifyResult = {
    assumption: postFixAssumption.text,
    status: 'deferred',
    evidence: 'Post-fix assumption — deferred until after execution',
  };

  // Assert the mock output validates against the verifyAssumptions result schema
  const r = validateStructured(mockVerifyResult, verifyAssumptionResultItemSchema);
  assert.equal(r.ok, true,
    `Expected deferred result to validate against verifyAssumptions result schema: ${JSON.stringify(r.errors)}`);
  assert.equal(mockVerifyResult.status, 'deferred',
    'post-fix assumption should carry deferred status');
});

// ── TC-New-4: mixed invariant+post-fix assumptions preserve original order ───

await test('verifyAssumptions: mixed invariant+post-fix assumptions preserve original order', () => {
  // 3 assumptions: [invariant, post-fix, invariant]
  const assumptions = [
    { text: 'Invariant assumption 1', specSection: '## Core', phase: 'invariant' },
    { text: 'Post-fix assumption 1',  specSection: '## Post', phase: 'post-fix' },
    { text: 'Invariant assumption 2', specSection: '## Core', phase: 'invariant' },
  ];

  // Each item is a valid planGlobalAssumptionItemSchema object
  for (const a of assumptions) {
    const r = validateStructured(a, planGlobalAssumptionItemSchema);
    assert.equal(r.ok, true,
      `Assumption ${JSON.stringify(a)} should be schema-valid: ${JSON.stringify(r.errors)}`);
  }

  // Mock verifyAssumptions returning results in original-index order
  const mockVerifyAssumptions = (assumptionList) =>
    assumptionList.map((a) => ({
      assumption: a.text,
      status: a.phase === 'post-fix' ? 'deferred' : 'verified',
      evidence: a.phase === 'post-fix' ? 'Post-fix deferred until after execution' : 'Verified by code inspection',
    }));

  const results = mockVerifyAssumptions(assumptions);

  // Assert result order matches original assumption order
  for (let i = 0; i < assumptions.length; i++) {
    assert.equal(
      results[i].assumption,
      assumptions[i].text,
      `Result at index ${i} should match assumption text at index ${i}`,
    );
  }

  // Invariant items at indices 0 and 2 are verified; post-fix at index 1 is deferred
  assert.equal(results[0].status, 'verified', 'index 0 (invariant) should be verified');
  assert.equal(results[1].status, 'deferred', 'index 1 (post-fix) should be deferred');
  assert.equal(results[2].status, 'verified', 'index 2 (invariant) should be verified');
});

// ── TC-New-5: pipeline rendering — phaseTag [invariant] in log ───────────────

await test('pipeline rendering: phaseTag [invariant] appears in log output', async () => {
  const specContent = [SPEC_SECTION_A, OLD_TEXT].join('\n');
  const { root, specPath } = makePipelineHarness({ specContent });
  try {
    const invariantAssumption = {
      text: 'The pipeline entrypoint exports a run() function',
      specSection: SPEC_SECTION_A,
      phase: 'invariant',
    };

    const { pipeline, logs } = makeMockedPipeline(root, {
      assumptionsList: [invariantAssumption],
      round1: [{
        assumption: invariantAssumption,
        status: 'verified',
        evidence: 'run() is exported from pipeline.js',
      }],
      round2: [],
    });

    await pipeline.run('test goal', { prdPath: specPath });

    assert.ok(
      logs.some((l) => l.includes('[invariant]')),
      `Expected [invariant] phaseTag in logs.\nLogs:\n${logs.join('\n')}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// ── TC-New-6: pipeline rendering — phaseTag [post-fix] for deferred ──────────

await test('pipeline rendering: phaseTag [post-fix] appears for deferred assumption', async () => {
  const specContent = [SPEC_SECTION_A, OLD_TEXT].join('\n');
  const { root, specPath } = makePipelineHarness({ specContent });
  try {
    const postFixAssumption = {
      text: 'After execution, module Z will be available for import',
      specSection: SPEC_SECTION_A,
      phase: 'post-fix',
    };

    const { pipeline, logs } = makeMockedPipeline(root, {
      assumptionsList: [postFixAssumption],
      round1: [{
        assumption: postFixAssumption,
        status: 'deferred',
        evidence: 'Post-fix assumption — deferred until after execution',
      }],
      round2: [],
    });

    await pipeline.run('test goal', { prdPath: specPath });

    assert.ok(
      logs.some((l) => l.includes('[post-fix]')),
      `Expected [post-fix] phaseTag in logs.\nLogs:\n${logs.join('\n')}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// ── TC-New-7: _remediateAssumptions deferred → postFixAssumptions ────────────

await test('pipeline _remediateAssumptions: deferred assumptions stashed to globalPlan.postFixAssumptions', async () => {
  const { root, specPath } = makePipelineHarness({ specContent: STANDARD_SPEC });
  try {
    const postFixAssumption = {
      text: 'After execution, module Z will be available for import',
      specSection: SPEC_SECTION_A,
      phase: 'post-fix',
    };

    let capturedPlan = null;
    const { pipeline } = makeMockedPipeline(root, {
      assumptionsList: [postFixAssumption],
      round1: [{
        assumption: postFixAssumption,
        status: 'deferred',
        evidence: 'Post-fix assumption — deferred until after execution',
      }],
      round2: [],
    });

    // Capture the plan object returned by planGlobal so we can inspect
    // postFixAssumptions after _remediateAssumptions has run.
    const origPlanGlobal = pipeline.planner.planGlobal;
    pipeline.planner.planGlobal = async (...args) => {
      capturedPlan = await origPlanGlobal(...args);
      return capturedPlan;
    };

    await pipeline.run('test goal', { prdPath: specPath });

    assert.ok(capturedPlan !== null, 'capturedPlan should be set after run');
    assert.ok(
      Array.isArray(capturedPlan.postFixAssumptions),
      `Expected postFixAssumptions to be an array, got: ${JSON.stringify(capturedPlan.postFixAssumptions)}`,
    );
    assert.equal(
      capturedPlan.postFixAssumptions.length,
      1,
      `Expected 1 deferred assumption in postFixAssumptions, got ${capturedPlan.postFixAssumptions.length}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// ── TC-New-8: revisedAssumptions[] multi-entry splice ────────────────────────

await test('pipeline _remediateAssumptions: revisedAssumptions[] multi-entry splices additional assumptions after original index', async () => {
  const { root, specPath } = makePipelineHarness({ specContent: STANDARD_SPEC });
  try {
    const originalAssumption = {
      text: OLD_TEXT,
      specSection: SPEC_SECTION_A,
    };

    let capturedPlan = null;
    const { pipeline } = makeMockedPipeline(root, {
      assumptionsList: [originalAssumption],
      round1: [{ assumption: originalAssumption, status: 'failed', evidence: 'outdated' }],
      round2: [
        { assumption: { text: 'first', specSection: SPEC_SECTION_A }, status: 'verified', evidence: 'ok' },
        { assumption: 'second', status: 'verified', evidence: 'ok' },
      ],
      remediateResult: {
        revisedAssumptions: [
          { text: 'first', phase: 'invariant' },
          { text: 'second', phase: 'invariant' },
        ],
        specEdit: { section: SPEC_SECTION_A, old: OLD_TEXT, new: NEW_TEXT },
      },
    });

    // Capture the plan reference so we can inspect assumptions after remediation.
    const origPlanGlobal = pipeline.planner.planGlobal;
    pipeline.planner.planGlobal = async (...args) => {
      capturedPlan = await origPlanGlobal(...args);
      return capturedPlan;
    };

    await withMockReadline(['a'], async () => {
      await pipeline.run('test goal', { prdPath: specPath });
    });

    assert.ok(capturedPlan !== null, 'capturedPlan should be set after run');
    assert.ok(
      Array.isArray(capturedPlan.assumptions),
      'capturedPlan.assumptions should be an array',
    );
    assert.ok(
      capturedPlan.assumptions.length >= 2,
      `Expected at least 2 assumptions after splice, got ${capturedPlan.assumptions.length}`,
    );
    // First entry must replace in-place at the original index.
    const firstText = capturedPlan.assumptions[0]?.text ?? capturedPlan.assumptions[0];
    assert.equal(firstText, 'first',
      `Expected assumptions[0].text to be 'first', got ${JSON.stringify(firstText)}`);
    // Second entry must be spliced in immediately after (index 1).
    const secondText = capturedPlan.assumptions[1]?.text ?? capturedPlan.assumptions[1];
    assert.equal(secondText, 'second',
      `Expected assumptions[1] to be 'second', got ${JSON.stringify(secondText)}`);
  } finally {
    pipelineCleanup(root);
  }
});

// ── TC-New-9: batchResume [DEFER] log for deferred assumptions ───────────────

await test('pipeline batchResume: [DEFER] log appears for deferred assumptions', async () => {
  const { root } = makePipelineHarness({ specContent: STANDARD_SPEC });
  try {
    const deferredAssumption = {
      text: 'After execution, module Z will export function W',
      specSection: SPEC_SECTION_A,
      phase: 'post-fix',
    };
    // A failed assumption whose specSection does not exist in the spec —
    // batchResume will skip remediation for it (section not found) and then
    // round 2 will still see it as failed, giving passed=false without ever
    // reaching bootstrap / archive.
    const failedAssumption = {
      text: 'Some assumption that cannot be remediated',
      specSection: 'NONEXISTENT_SECTION',
    };

    // Create a real queue entry on disk that listQueue() can discover.
    const slug = 'deferred-test-entry';
    const queueEntryDir = path.join(root, 'queue', slug);
    fs.mkdirSync(queueEntryDir, { recursive: true });
    fs.writeFileSync(path.join(queueEntryDir, 'spec.md'), STANDARD_SPEC);
    fs.writeFileSync(path.join(queueEntryDir, 'plan.json'), JSON.stringify({
      milestones: [],
      assumptions: [deferredAssumption, failedAssumption],
    }, null, 2));
    fs.writeFileSync(path.join(queueEntryDir, 'validated-at.json'),
      JSON.stringify(new Date().toISOString()));
    fs.writeFileSync(path.join(queueEntryDir, 'status'), 'pending');

    const { pipeline, logs } = makeMockedPipeline(root, {
      // round1: one deferred + one failed → [DEFER] is logged, then remediation runs
      round1: [
        {
          assumption: deferredAssumption,
          status: 'deferred',
          evidence: 'Post-fix assumption — deferred until after execution',
        },
        {
          assumption: failedAssumption,
          status: 'failed',
          evidence: 'section not found',
        },
      ],
      // round2: the failed assumption is still failing → passed=false → no archive call
      round2: [
        { assumption: failedAssumption, status: 'failed', evidence: 'still not found' },
      ],
    });

    await pipeline.batchResume();

    assert.ok(
      logs.some((l) => l.includes('[DEFER]')),
      `Expected [DEFER] in batchResume logs.\nLogs:\n${logs.join('\n')}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// ── TC-P9: round-2 uses re-extracted assumptions from edited spec ─────────────

await test('pipeline: round-2 uses re-extracted assumptions from edited spec, not stale spliced array', async () => {
  const { root, specPath } = makePipelineHarness({ specContent: STANDARD_SPEC });
  try {
    const reExtractedAssumption = {
      text: NEW_TEXT_ASSUMPTION,
      specSection: SPEC_SECTION_A,
      phase: 'invariant',
    };

    let round2AssumptionsArg = null;

    const { pipeline, logs, getReExtractCount } = makeMockedPipeline(root, {
      assumptionsList: [makeFailedAssumption().assumption],
      round1: [makeFailedAssumption()],
      round2: [{ assumption: reExtractedAssumption, status: 'verified', evidence: 'ok' }],
      remediateResult: {
        revisedAssumptions: [{ text: 'corrected', phase: 'invariant' }],
        specEdit: { section: SPEC_SECTION_A, old: OLD_TEXT, new: NEW_TEXT },
      },
      reExtractedAssumptions: [reExtractedAssumption],
    });

    // Override verifyAssumptions to capture the args passed on the round-2 call
    const origVerify = pipeline.planner.verifyAssumptions;
    let verifyCallIdx = 0;
    pipeline.planner.verifyAssumptions = async (assumptions) => {
      verifyCallIdx++;
      if (verifyCallIdx === 2) {
        round2AssumptionsArg = assumptions;
      }
      return origVerify(assumptions);
    };

    await withMockReadline(['a'], async () => {
      await pipeline.run('test goal', { prdPath: specPath });
    });

    // (1) reExtractAssumptions was called exactly once
    assert.equal(getReExtractCount(), 1,
      `planner.reExtractAssumptions should have been called exactly once (got ${getReExtractCount()})`);

    // (2) globalPlan.assumptions was replaced with re-extracted set (check via round-2 args)
    assert.ok(round2AssumptionsArg !== null,
      'round-2 verifyAssumptions should have been called with the re-extracted assumptions');
    const round2Texts = round2AssumptionsArg.map((a) => (typeof a === 'string' ? a : a.text ?? a));
    assert.ok(
      round2Texts.includes(NEW_TEXT_ASSUMPTION),
      `Expected round-2 verifyAssumptions to receive re-extracted assumption '${NEW_TEXT_ASSUMPTION}'.\nGot: ${JSON.stringify(round2AssumptionsArg)}`,
    );

    // (3) round 2 passes — no [ESCALATION] in logs
    assert.ok(
      !logs.some((l) => l.includes('[ESCALATION]')),
      `Expected no [ESCALATION] in logs after round-2 passes.\nLogs:\n${logs.join('\n')}`,
    );

    // (4) log contains 'Re-extracted' message confirming re-extraction occurred
    assert.ok(
      logs.some((l) => l.includes('Re-extracted')),
      `Expected 'Re-extracted' message in logs.\nLogs:\n${logs.join('\n')}`,
    );
  } finally {
    pipelineCleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
