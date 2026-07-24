/**
 * test-regression-remediation-unknown-scope.js — Unit tests for the conditional
 * scope clause in Planner.remediateRegressionFailure's systemPrompt.
 *
 * Background: when the pipeline's regression report is markdown, it synthesizes
 * findings [{ file: 'unknown', description }]. The systemPrompt scope clause is
 * conditional on whether any finding carries a usable (non-'unknown') file:
 *
 *   - No usable files (unknown-only or empty findings): the hard-scope clause
 *     ("ONLY to the flagged files") is REPLACED by an instruction to
 *     (i) identify the correct files from the findings text, and
 *     (ii) scope changes to files this milestone's tasks declared —
 *     optionally followed by opts.milestoneTargetFiles when provided as an array.
 *   - Usable files present (real filenames, or mixed real + unknown): the
 *     hard-scope clause is present and unchanged; no replacement instruction.
 *
 * No live Claude sessions are spawned — sessionManager.spawn is replaced by a
 * mock fixture following the test-regression-remediation-planner.js pattern.
 *
 * Run: node test/test-regression-remediation-unknown-scope.js
 */
import assert from 'assert';
import { Planner } from '../src/orchestrator/agents/planner.js';

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

// Fixture return value that sessionManager.spawn resolves with — minimal
// valid structured output the planner can parse.
const fixtureResult = {
  structured_output: {
    newTasks: [
      {
        id: '001-002-003-001',
        subMissionId: '001-002-003',
        description: 'Fix the regression flagged by the report',
        targetFiles: ['src/orchestrator/agents/executor.js'],
      },
    ],
  },
};

// Unknown-only findings — what the pipeline synthesizes from a markdown
// regression report.
const unknownOnlyFindings = [
  {
    severity: 'critical',
    category: 'regression',
    file: 'unknown',
    description: 'Regression suite reported failures; see report text for details',
  },
];

// Real-filename findings — the normal structured-report path.
const realFileFindings = [
  {
    severity: 'critical',
    category: 'regression',
    file: 'src/real.js',
    description: 'Real module regressed: exported guard no longer applied',
  },
];

// Mixed findings — one usable file plus one synthesized 'unknown' entry.
const mixedFindings = [
  {
    severity: 'critical',
    category: 'regression',
    file: 'src/real.js',
    description: 'Real module regressed: exported guard no longer applied',
  },
  {
    severity: 'critical',
    category: 'regression',
    file: 'unknown',
    description: 'Additional markdown-derived failure with no file attribution',
  },
];

// Spec-pinned phrases
const HARD_SCOPE_TEXT = 'ONLY to the flagged files';
const HARD_SCOPE_CLAUSE = 'Scope your analysis ONLY to the flagged files and their listed related files: ';
const REPLACEMENT_PART_1 = /identify the correct files from the findings text/i;
const REPLACEMENT_PART_2 = /files this milestone's tasks declared/i;

// ── Mock builders ──────────────────────────────────────────────────────────

/**
 * Build a mock logger that satisfies Planner's internal usage:
 *   logger.createSessionLog(name) → { close() }
 *   logger.attachToSession(handle, log, meta) → void
 */
function makeMockLogger() {
  return {
    createSessionLog: (_name) => ({ close: () => {} }),
    attachToSession: () => {},
    warn: () => {},
  };
}

/**
 * Build a mock sessionManager whose spawn() records the call options,
 * returns a thenable with a `.handle` property (as Planner expects), and
 * resolves to { handle, result } where result carries the fixture.
 *
 * Returns { mockSessionManager, getSpawnCalls }.
 */
function makeMockSessionManager(resultFixture = fixtureResult) {
  const spawnCalls = [];

  const mockSessionManager = {
    spawn(opts) {
      spawnCalls.push(opts);
      const mockHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
      const p = Promise.resolve({ handle: mockHandle, result: resultFixture });
      // Planner accesses spawnPromise.handle before awaiting
      p.handle = mockHandle;
      return p;
    },
  };

  return {
    mockSessionManager,
    getSpawnCalls: () => spawnCalls,
  };
}

/**
 * Invoke remediateRegressionFailure with the given findings (and optional
 * opts) and return the single captured spawn call's options
 * ({ prompt, systemPrompt, ... }).
 */
async function captureSpawn(findings, opts) {
  const { mockSessionManager, getSpawnCalls } = makeMockSessionManager();
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  if (opts === undefined) {
    await planner.remediateRegressionFailure('001-002', findings, '/tmp/project');
  } else {
    await planner.remediateRegressionFailure('001-002', findings, '/tmp/project', opts);
  }

  const calls = getSpawnCalls();
  assert.equal(calls.length, 1, `Expected 1 spawn call, got ${calls.length}`);
  return calls[0];
}

/** Assert the replacement-instruction branch is active in a systemPrompt. */
function assertReplacementBranch(systemPrompt) {
  assert.ok(typeof systemPrompt === 'string' && systemPrompt.length > 0,
    'systemPrompt should be a non-empty string');

  assert.ok(!systemPrompt.includes(HARD_SCOPE_TEXT),
    `systemPrompt must NOT contain the hard-scope text "${HARD_SCOPE_TEXT}".\nsystemPrompt:\n${systemPrompt}`);
  assert.ok(!systemPrompt.includes(HARD_SCOPE_CLAUSE + 'unknown'),
    `systemPrompt must not scope to the literal filename "unknown".\nsystemPrompt:\n${systemPrompt}`);

  assert.ok(REPLACEMENT_PART_1.test(systemPrompt),
    `systemPrompt should instruct to identify the correct files from the findings text.\nsystemPrompt:\n${systemPrompt}`);
  assert.ok(REPLACEMENT_PART_2.test(systemPrompt),
    `systemPrompt should scope changes to files this milestone's tasks declared.\nsystemPrompt:\n${systemPrompt}`);
}

// ── TC1: unknown-only findings switch to the replacement instruction ────────

await test('TC1: unknown-only findings — hard-scope clause replaced by identify-and-declared-files instruction', async () => {
  const { systemPrompt } = await captureSpawn(unknownOnlyFindings);
  assertReplacementBranch(systemPrompt);
});

// ── TC2: empty findings take the same replacement branch, no throw ──────────

await test('TC2: empty findings — same replacement branch as unknown-only, no throw', async () => {
  let spawnOpts;
  try {
    spawnOpts = await captureSpawn([]);
  } catch (err) {
    assert.fail(`remediateRegressionFailure threw with empty findings: ${err.message}`);
  }
  assertReplacementBranch(spawnOpts.systemPrompt);
});

// ── TC3: opts.milestoneTargetFiles appends the declared-files list ──────────

await test('TC3: opts.milestoneTargetFiles — replacement instruction followed by the declared-files list', async () => {
  const { systemPrompt } = await captureSpawn(unknownOnlyFindings, {
    specTargetFiles: [],
    milestoneTargetFiles: ['src/a.js', 'src/b.js'],
  });

  assertReplacementBranch(systemPrompt);

  const instructionIdx = systemPrompt.search(REPLACEMENT_PART_2);
  assert.ok(instructionIdx !== -1, 'replacement instruction should be present');

  for (const file of ['src/a.js', 'src/b.js']) {
    const fileIdx = systemPrompt.indexOf(file);
    assert.ok(fileIdx !== -1,
      `systemPrompt should list declared file "${file}".\nsystemPrompt:\n${systemPrompt}`);
    assert.ok(fileIdx > instructionIdx,
      `Declared file "${file}" should follow the replacement instruction (instructionIdx=${instructionIdx}, fileIdx=${fileIdx}).\nsystemPrompt:\n${systemPrompt}`);
  }
});

// ── TC4: no milestoneTargetFiles (absent or non-array) → no trailing list ───

await test('TC4: no opts.milestoneTargetFiles — replacement instruction without a trailing file list, no throw', async () => {
  // 4a: opts absent entirely
  const { systemPrompt: noOpts } = await captureSpawn(unknownOnlyFindings);
  assertReplacementBranch(noOpts);
  assert.ok(!noOpts.includes('src/a.js') && !noOpts.includes('src/b.js'),
    `systemPrompt should carry no declared-files list when opts is absent.\nsystemPrompt:\n${noOpts}`);

  // 4b: opts present but milestoneTargetFiles missing
  const { systemPrompt: emptyOpts } = await captureSpawn(unknownOnlyFindings, { specTargetFiles: [] });
  assertReplacementBranch(emptyOpts);
  assert.ok(!emptyOpts.includes('src/a.js') && !emptyOpts.includes('src/b.js'),
    `systemPrompt should carry no declared-files list when milestoneTargetFiles is missing.\nsystemPrompt:\n${emptyOpts}`);

  // 4c: milestoneTargetFiles non-array — must not throw, must not leak
  let nonArrayOpts;
  try {
    nonArrayOpts = await captureSpawn(unknownOnlyFindings, {
      specTargetFiles: [],
      milestoneTargetFiles: 'src/a.js', // non-array — must be ignored
    });
  } catch (err) {
    assert.fail(`remediateRegressionFailure threw on non-array milestoneTargetFiles: ${err.message}`);
  }
  assertReplacementBranch(nonArrayOpts.systemPrompt);
  assert.ok(!nonArrayOpts.systemPrompt.includes('src/a.js'),
    `Non-array milestoneTargetFiles must not leak into the systemPrompt.\nsystemPrompt:\n${nonArrayOpts.systemPrompt}`);
});

// ── TC5: real filenames keep the unchanged hard-scope clause ────────────────

await test('TC5: real filenames — hard-scope clause present and unchanged, no replacement instruction', async () => {
  const { systemPrompt } = await captureSpawn(realFileFindings);

  assert.ok(typeof systemPrompt === 'string' && systemPrompt.length > 0,
    'systemPrompt should be a non-empty string');

  const clauseIdx = systemPrompt.indexOf(HARD_SCOPE_CLAUSE);
  assert.ok(clauseIdx !== -1,
    `systemPrompt should contain the hard-scope clause "${HARD_SCOPE_CLAUSE}".\nsystemPrompt:\n${systemPrompt}`);

  const fileIdx = systemPrompt.indexOf('src/real.js', clauseIdx + HARD_SCOPE_CLAUSE.length);
  assert.ok(fileIdx !== -1,
    `Hard-scope clause should be followed by "src/real.js".\nsystemPrompt:\n${systemPrompt}`);

  assert.ok(!REPLACEMENT_PART_1.test(systemPrompt),
    `systemPrompt must NOT contain the replacement instruction for real-filename findings.\nsystemPrompt:\n${systemPrompt}`);
  assert.ok(!REPLACEMENT_PART_2.test(systemPrompt),
    `systemPrompt must NOT contain the declared-files scoping instruction for real-filename findings.\nsystemPrompt:\n${systemPrompt}`);
});

// ── TC6: mixed real + unknown findings use the hard-scope branch ────────────

await test('TC6: mixed real + unknown findings — hard-scope branch applies, replacement instruction absent', async () => {
  const { systemPrompt } = await captureSpawn(mixedFindings);

  assert.ok(systemPrompt.includes(HARD_SCOPE_CLAUSE),
    `systemPrompt should contain the hard-scope clause when usable files exist.\nsystemPrompt:\n${systemPrompt}`);
  assert.ok(systemPrompt.includes('src/real.js'),
    `systemPrompt should reference the usable file "src/real.js".\nsystemPrompt:\n${systemPrompt}`);

  assert.ok(!REPLACEMENT_PART_1.test(systemPrompt),
    `systemPrompt must NOT contain the replacement instruction when usable files exist.\nsystemPrompt:\n${systemPrompt}`);
  assert.ok(!REPLACEMENT_PART_2.test(systemPrompt),
    `systemPrompt must NOT contain the declared-files scoping instruction when usable files exist.\nsystemPrompt:\n${systemPrompt}`);
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
