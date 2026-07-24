/**
 * test-remediation-related-files.js — Unit tests for relatedFiles handling in
 * Planner.remediateReviewFindings and Planner.remediateRegressionFailure.
 *
 * Pins (symmetrically, for BOTH remediation twins):
 *   1. Flagged-files union: systemPrompt lists the deduplicated union of every
 *      finding's `file` plus every finding's `relatedFiles` entries.
 *   2. Non-array tolerance: missing / null / non-array relatedFiles neither
 *      throws nor pollutes the flagged-files list.
 *   3. User-prompt "Related files" line: emitted only for findings that carry
 *      a non-empty relatedFiles array.
 *   4. Scope wording: hard-scope clause reads
 *      "the flagged files and their listed related files".
 *
 * No live Claude sessions are spawned — sessionManager.spawn is replaced by a
 * mock fixture following the test-review-remediation-planner.js pattern.
 *
 * Run: node test/test-remediation-related-files.js
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
// valid structured output both remediation methods can parse.
const fixtureResult = {
  structured_output: {
    newTasks: [
      {
        id: '001-002-003-001',
        subMissionId: '001-002-003',
        description: 'Fix the flagged issue',
        targetFiles: ['src/widgets/alpha.js'],
      },
    ],
  },
};

// Findings fixture with relatedFiles overlap:
//   union = alpha.js + beta.js + gamma.js (beta.js appears as both a
//   finding file and a related file → must be deduplicated).
const findingsWithRelated = [
  {
    severity: 'critical',
    category: 'functional',
    file: 'src/widgets/alpha.js',
    description: 'Alpha widget drops the config argument on retry',
    relatedFiles: ['src/widgets/beta.js', 'src/widgets/gamma.js'],
  },
  {
    severity: 'critical',
    category: 'functional',
    file: 'src/widgets/beta.js',
    description: 'Beta widget mutates shared state during render',
  },
];

// Findings with malformed / absent relatedFiles: must not throw, and the
// string value must not leak into any prompt.
const findingsMalformed = [
  {
    severity: 'major',
    category: 'functional',
    file: 'src/widgets/delta.js',
    description: 'Delta widget ignores abort signal',
    relatedFiles: null,
  },
  {
    severity: 'major',
    category: 'functional',
    file: 'src/widgets/epsilon.js',
    description: 'Epsilon widget swallows errors silently',
    relatedFiles: 'src/widgets/zeta.js', // non-array — must be ignored
  },
  {
    severity: 'major',
    category: 'functional',
    file: 'src/widgets/theta.js',
    description: 'Theta widget leaks event listeners',
    // relatedFiles absent
  },
];

// Findings with no relatedFiles anywhere — the user prompt must contain no
// "Related files" text at all.
const findingsNoRelated = [
  {
    severity: 'critical',
    category: 'functional',
    file: 'src/widgets/iota.js',
    description: 'Iota widget double-fires the completion callback',
  },
  {
    severity: 'critical',
    category: 'integration',
    file: 'src/widgets/kappa.js',
    description: 'Kappa widget breaks the pipeline contract',
  },
];

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

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/**
 * Invoke the named remediation method with the given findings and return the
 * single captured spawn call's options ({ prompt, systemPrompt, ... }).
 */
async function captureSpawn(methodName, findings) {
  const { mockSessionManager, getSpawnCalls } = makeMockSessionManager();
  const planner = new Planner(mockSessionManager, makeMockLogger(), null);

  await planner[methodName]('001-002', findings, '/tmp/project');

  const calls = getSpawnCalls();
  assert.equal(calls.length, 1, `Expected 1 spawn call, got ${calls.length}`);
  return calls[0];
}

// ── Twin-symmetric test suites ─────────────────────────────────────────────

const METHODS = ['remediateReviewFindings', 'remediateRegressionFailure'];

for (const methodName of METHODS) {
  // ── TC1: flagged-files union is deduplicated across file + relatedFiles ──

  await test(`${methodName} — TC1: systemPrompt flagged-files list is deduplicated union of file + relatedFiles`, async () => {
    const { systemPrompt } = await captureSpawn(methodName, findingsWithRelated);

    assert.ok(typeof systemPrompt === 'string' && systemPrompt.length > 0,
      'systemPrompt should be a non-empty string');

    for (const expected of ['src/widgets/alpha.js', 'src/widgets/beta.js', 'src/widgets/gamma.js']) {
      const n = countOccurrences(systemPrompt, expected);
      assert.equal(n, 1,
        `systemPrompt should contain "${expected}" exactly once (dedup), got ${n}.\nsystemPrompt:\n${systemPrompt}`);
    }
  });

  // ── TC2: missing / null / non-array relatedFiles tolerated, no pollution ──

  await test(`${methodName} — TC2: missing/null/non-array relatedFiles do not throw and do not pollute the list`, async () => {
    let spawnOpts;
    try {
      spawnOpts = await captureSpawn(methodName, findingsMalformed);
    } catch (err) {
      assert.fail(`${methodName} threw on malformed relatedFiles: ${err.message}`);
    }

    const { systemPrompt, prompt } = spawnOpts;

    // Every finding's `file` is present exactly once
    for (const expected of ['src/widgets/delta.js', 'src/widgets/epsilon.js', 'src/widgets/theta.js']) {
      const n = countOccurrences(systemPrompt, expected);
      assert.equal(n, 1,
        `systemPrompt should contain "${expected}" exactly once, got ${n}.\nsystemPrompt:\n${systemPrompt}`);
    }

    // The non-array string value must not leak into either prompt
    assert.ok(!systemPrompt.includes('zeta'),
      `systemPrompt must not contain the non-array relatedFiles string value.\nsystemPrompt:\n${systemPrompt}`);
    assert.ok(!prompt.includes('zeta'),
      `user prompt must not contain the non-array relatedFiles string value.\nPrompt:\n${prompt}`);
  });

  // ── TC3: user prompt carries a Related-files line only for findings that have them ──

  await test(`${methodName} — TC3: user prompt lists related files alongside the finding that has them`, async () => {
    const { prompt } = await captureSpawn(methodName, findingsWithRelated);

    assert.ok(typeof prompt === 'string' && prompt.length > 0,
      'prompt should be a non-empty string');

    // Finding 1 has relatedFiles [beta, gamma] → a line listing both
    assert.ok(
      /Related files:.*src\/widgets\/beta\.js.*src\/widgets\/gamma\.js/.test(prompt),
      `Prompt should contain a "Related files:" line listing beta.js and gamma.js.\nPrompt:\n${prompt}`,
    );

    // The related-files line appears after that finding's File line
    const fileIdx = prompt.indexOf('src/widgets/alpha.js');
    const relatedIdx = prompt.search(/Related files:/);
    assert.ok(fileIdx !== -1, 'Prompt should mention the finding file src/widgets/alpha.js');
    assert.ok(relatedIdx > fileIdx,
      `"Related files:" line should appear after the finding's File line (fileIdx=${fileIdx}, relatedIdx=${relatedIdx}).\nPrompt:\n${prompt}`);

    // Only one finding carries relatedFiles → exactly one Related-files line
    const n = countOccurrences(prompt, 'Related files');
    assert.equal(n, 1,
      `Exactly one finding has relatedFiles, so "Related files" should appear exactly once, got ${n}.\nPrompt:\n${prompt}`);
  });

  // ── TC4: no Related-files text when no finding has relatedFiles ──────────

  await test(`${methodName} — TC4: prompt contains no "Related files" text when no finding carries relatedFiles`, async () => {
    const { prompt } = await captureSpawn(methodName, findingsNoRelated);

    assert.ok(!/related files/i.test(prompt),
      `Prompt must contain no "Related files" text when zero findings have relatedFiles.\nPrompt:\n${prompt}`);

    // Malformed (null / string / absent) relatedFiles also emit no such line
    const { prompt: malformedPrompt } = await captureSpawn(methodName, findingsMalformed);
    assert.ok(!/related files/i.test(malformedPrompt),
      `Prompt must contain no "Related files" text when relatedFiles are malformed/absent.\nPrompt:\n${malformedPrompt}`);
  });

  // ── TC5: hard-scope clause wording covers listed related files ───────────

  await test(`${methodName} — TC5: systemPrompt hard-scope clause reads "the flagged files and their listed related files"`, async () => {
    const { systemPrompt } = await captureSpawn(methodName, findingsWithRelated);

    assert.ok(
      systemPrompt.includes('the flagged files and their listed related files'),
      `systemPrompt should contain the phrase "the flagged files and their listed related files".\nsystemPrompt:\n${systemPrompt}`,
    );
  });
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
