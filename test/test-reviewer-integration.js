/**
 * test-reviewer-integration.js — Integration tests for the Reviewer class,
 * covering the spawn → extractReviewVerdict → sidecar → tokenTracker chain.
 *
 * No live SDK. Uses mock objects to verify that:
 *  1. PASSED structured output → result.passed === true, sidecar written
 *  2. FAILED structured output with critical finding → result.passed === false
 *  3. Sidecar is written to .harness/verification/review-milestone-{id}.json
 *  4. Sidecar content matches structured_output
 *  5. tokenTracker.recordSession called with type 'reviewer'
 *  6. sessionManager.spawn called with jsonSchema: reviewerSchema
 *  7. sessionManager.spawn called with tools: config.tools.reviewer
 *  8. sessionManager.spawn called with model: config.execution.reviewerModel
 *
 * Run: node test/test-reviewer-integration.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

import { Reviewer, extractReviewVerdict } from '../src/orchestrator/agents/reviewer.js';
import { reviewerSchema } from '../src/orchestrator/agents/_schemas.js';
import config from '../src/orchestrator/infra/config.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// ── Fixture helpers ─────────────────────────────────────────────────────────

function createHarness() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-integration-'));
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'progress'), { recursive: true });
  return { projectRoot, harnessDir };
}

function cleanup(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

// Canned SDK result fixtures

const cannedPassed = {
  structured_output: {
    result: 'PASSED',
    findings: [],
    notes: 'No issues found.',
  },
};

const cannedFailed = {
  structured_output: {
    result: 'FAILED',
    findings: [
      {
        severity: 'critical',
        category: 'call-chain',
        file: 'src/foo.js',
        description: 'Missing await on async call causes silent data loss.',
        relatedFiles: [],
      },
    ],
    notes: 'Critical issues detected.',
  },
};

// ── Mock factories ──────────────────────────────────────────────────────────

const noop = () => {};

function makeSessionManager(cannedSdkResult) {
  const calls = [];
  const handle = { systemPromptTokens: 0, _toolCallCount: 0 };

  const sessionManager = {
    calls,
    spawn(opts) {
      calls.push(opts);
      const resolvedResult = { handle, result: cannedSdkResult };
      const spawnPromise = Promise.resolve(resolvedResult);
      // Attach handle synchronously so logger.attachToSession can access it
      // before the promise resolves (mirrors the real spawn() shape).
      spawnPromise.handle = handle;
      return spawnPromise;
    },
  };

  return sessionManager;
}

function makeLogger() {
  return {
    createSessionLog: () => ({ logPath: '/tmp/fake.log', close: noop }),
    attachToSession: noop,
    getSessionSummary: () => ({}),
    writeSessionSummary: noop,
  };
}

function makeTokenTracker() {
  const calls = [];
  return {
    calls,
    recordSession(...args) {
      calls.push(args);
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

// TC1 + TC3 + TC4 + TC5 + TC6 + TC7 + TC8: PASSED fixture
await test('TC1: PASSED fixture → result.passed === true', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const sessionManager = makeSessionManager(cannedPassed);
    const logger = makeLogger();
    const tokenTracker = makeTokenTracker();

    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
    const result = await reviewer.reviewMilestone(
      'ms-001',
      ['src/foo.js'],
      ['Task t1: test'],
      'importGraph data',
      projectRoot,
      harnessDir
    );

    // TC1: result.passed is true
    assert.strictEqual(result.passed, true, 'expected result.passed === true for PASSED fixture');
  } finally {
    cleanup(projectRoot);
  }
});

// TC2: FAILED fixture → result.passed === false
await test('TC2: FAILED fixture with critical finding → result.passed === false', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const sessionManager = makeSessionManager(cannedFailed);
    const logger = makeLogger();
    const tokenTracker = makeTokenTracker();

    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
    const result = await reviewer.reviewMilestone(
      'ms-001',
      ['src/foo.js'],
      ['Task t1: test'],
      'importGraph data',
      projectRoot,
      harnessDir
    );

    // TC2: result.passed is false
    assert.strictEqual(result.passed, false, 'expected result.passed === false for FAILED fixture');

    // Also assert findings array is present and non-empty
    assert.ok(Array.isArray(result.findings), 'findings should be an array');
    assert.ok(result.findings.length > 0, 'findings should be non-empty for FAILED fixture');
  } finally {
    cleanup(projectRoot);
  }
});

// TC3: Sidecar exists
await test('TC3: sidecar written to .harness/verification/review-milestone-ms-001.json', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const sessionManager = makeSessionManager(cannedPassed);
    const logger = makeLogger();
    const tokenTracker = makeTokenTracker();

    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
    await reviewer.reviewMilestone(
      'ms-001',
      ['src/foo.js'],
      ['Task t1: test'],
      'importGraph data',
      projectRoot,
      harnessDir
    );

    const sidecarPath = path.join(harnessDir, 'verification', 'review-milestone-ms-001.json');
    assert.ok(fs.existsSync(sidecarPath), `expected sidecar at ${sidecarPath}`);
  } finally {
    cleanup(projectRoot);
  }
});

// TC4: Sidecar content matches structured_output
await test('TC4: sidecar JSON content matches structured_output', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const sessionManager = makeSessionManager(cannedPassed);
    const logger = makeLogger();
    const tokenTracker = makeTokenTracker();

    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
    await reviewer.reviewMilestone(
      'ms-001',
      ['src/foo.js'],
      ['Task t1: test'],
      'importGraph data',
      projectRoot,
      harnessDir
    );

    const sidecarPath = path.join(harnessDir, 'verification', 'review-milestone-ms-001.json');
    const written = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    assert.strictEqual(written.result, 'PASSED', 'sidecar result should be PASSED');
    assert.deepStrictEqual(written.findings, [], 'sidecar findings should match fixture');
    assert.strictEqual(written.notes, 'No issues found.', 'sidecar notes should match fixture');
  } finally {
    cleanup(projectRoot);
  }
});

// TC5: tokenTracker.recordSession called with type 'reviewer'
await test('TC5: tokenTracker.recordSession called with type \'reviewer\'', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const sessionManager = makeSessionManager(cannedPassed);
    const logger = makeLogger();
    const tokenTracker = makeTokenTracker();

    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
    await reviewer.reviewMilestone(
      'ms-001',
      ['src/foo.js'],
      ['Task t1: test'],
      'importGraph data',
      projectRoot,
      harnessDir
    );

    assert.ok(tokenTracker.calls.length > 0, 'recordSession should have been called');
    const [name, type] = tokenTracker.calls[0];
    assert.ok(
      typeof name === 'string' && name.toLowerCase().includes('reviewer'),
      `expected name to contain 'reviewer', got: ${name}`
    );
    assert.strictEqual(type, 'reviewer', `expected type 'reviewer', got: ${type}`);
  } finally {
    cleanup(projectRoot);
  }
});

// TC6: sessionManager.spawn called with jsonSchema: reviewerSchema
await test('TC6: sessionManager.spawn called with jsonSchema matching reviewerSchema', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const sessionManager = makeSessionManager(cannedPassed);
    const logger = makeLogger();
    const tokenTracker = makeTokenTracker();

    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
    await reviewer.reviewMilestone(
      'ms-001',
      ['src/foo.js'],
      ['Task t1: test'],
      'importGraph data',
      projectRoot,
      harnessDir
    );

    assert.ok(sessionManager.calls.length > 0, 'spawn should have been called');
    const spawnOpts = sessionManager.calls[0];
    assert.deepStrictEqual(
      spawnOpts.jsonSchema,
      reviewerSchema,
      'spawn should be called with jsonSchema === reviewerSchema'
    );
  } finally {
    cleanup(projectRoot);
  }
});

// TC7: sessionManager.spawn called with tools: config.tools.reviewer
await test('TC7: sessionManager.spawn called with tools: config.tools.reviewer', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const sessionManager = makeSessionManager(cannedPassed);
    const logger = makeLogger();
    const tokenTracker = makeTokenTracker();

    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
    await reviewer.reviewMilestone(
      'ms-001',
      ['src/foo.js'],
      ['Task t1: test'],
      'importGraph data',
      projectRoot,
      harnessDir
    );

    assert.ok(sessionManager.calls.length > 0, 'spawn should have been called');
    const spawnOpts = sessionManager.calls[0];
    assert.deepStrictEqual(
      spawnOpts.tools,
      config.tools.reviewer,
      'spawn should be called with tools === config.tools.reviewer'
    );
  } finally {
    cleanup(projectRoot);
  }
});

// TC8: sessionManager.spawn called with model: config.execution.reviewerModel
await test('TC8: sessionManager.spawn called with model: config.execution.reviewerModel', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const sessionManager = makeSessionManager(cannedPassed);
    const logger = makeLogger();
    const tokenTracker = makeTokenTracker();

    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
    await reviewer.reviewMilestone(
      'ms-001',
      ['src/foo.js'],
      ['Task t1: test'],
      'importGraph data',
      projectRoot,
      harnessDir
    );

    assert.ok(sessionManager.calls.length > 0, 'spawn should have been called');
    const spawnOpts = sessionManager.calls[0];
    assert.strictEqual(
      spawnOpts.model,
      config.execution.reviewerModel,
      `spawn should be called with model '${config.execution.reviewerModel}'`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── Scope context tests (TC9–TC12) ──────────────────────────────────────────

// TC9: reviewMilestone with scopeContext → prompt contains ## Scope review, spec goal, exceeded file, scopeCompliance shape
await test('TC9: prompt contains ## Scope review, specGoal, exceededFile, and scopeCompliance shape', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const sessionManager = makeSessionManager(cannedPassed);
    const logger = makeLogger();
    const tokenTracker = makeTokenTracker();

    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
    await reviewer.reviewMilestone(
      'ms-scope',
      ['src/a.js'],
      ['Task t1: add rate limiting'],
      'importGraph data',
      projectRoot,
      harnessDir,
      { specGoal: 'Add rate limiting', specScopeFiles: ['src/a.js'], exceededFiles: ['src/b.js'] }
    );

    assert.ok(sessionManager.calls.length > 0, 'spawn should have been called');
    const prompt = sessionManager.calls[0].prompt;
    assert.ok(prompt.includes('## Scope review'), 'prompt should contain ## Scope review');
    assert.ok(prompt.includes('Add rate limiting'), 'prompt should contain spec goal text');
    assert.ok(prompt.includes('src/b.js'), 'prompt should contain exceeded file src/b.js');
    assert.ok(prompt.includes('scopeCompliance'), 'prompt should contain scopeCompliance JSON shape');
  } finally {
    cleanup(projectRoot);
  }
});

// TC10: reviewMilestone with 6-arg signature (no scopeContext) → prompt does NOT contain ## Scope review
await test('TC10: prompt does NOT contain ## Scope review when called with default 6-arg signature', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const sessionManager = makeSessionManager(cannedPassed);
    const logger = makeLogger();
    const tokenTracker = makeTokenTracker();

    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
    await reviewer.reviewMilestone(
      'ms-noscope',
      ['src/foo.js'],
      ['Task t1: test'],
      'importGraph data',
      projectRoot,
      harnessDir
    );

    assert.ok(sessionManager.calls.length > 0, 'spawn should have been called');
    const prompt = sessionManager.calls[0].prompt;
    assert.ok(!prompt.includes('## Scope review'), 'prompt should NOT contain ## Scope review for 6-arg call');
  } finally {
    cleanup(projectRoot);
  }
});

// TC11: reviewMilestone with scopeContext = {} → prompt does NOT contain ## Scope review
await test('TC11: prompt does NOT contain ## Scope review when scopeContext = {}', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const sessionManager = makeSessionManager(cannedPassed);
    const logger = makeLogger();
    const tokenTracker = makeTokenTracker();

    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
    await reviewer.reviewMilestone(
      'ms-emptyscope',
      ['src/foo.js'],
      ['Task t1: test'],
      'importGraph data',
      projectRoot,
      harnessDir,
      {}
    );

    assert.ok(sessionManager.calls.length > 0, 'spawn should have been called');
    const prompt = sessionManager.calls[0].prompt;
    assert.ok(!prompt.includes('## Scope review'), 'prompt should NOT contain ## Scope review for empty scopeContext');
  } finally {
    cleanup(projectRoot);
  }
});

// TC12: extractReviewVerdict returns passed: true when result === 'PASSED', no critical findings,
//       AND scopeCompliance.verdict === 'exceeded_scope' (advisory-only — scope verdict does NOT flip passed)
await test('TC12: extractReviewVerdict returns passed: true with exceeded_scope verdict (advisory-only)', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const cannedPassedWithScopeExceeded = {
      structured_output: {
        result: 'PASSED',
        findings: [],
        notes: 'No integration issues.',
        scopeCompliance: {
          verdict: 'exceeded_scope',
          evidence: 'src/b.js was modified but not declared in targetFiles',
          exceededFiles: ['src/b.js'],
        },
      },
    };

    const verdict = extractReviewVerdict(cannedPassedWithScopeExceeded, 'ms-tc12', harnessDir);
    assert.strictEqual(verdict.passed, true, 'expected passed === true even when scopeCompliance.verdict === exceeded_scope');
  } finally {
    cleanup(projectRoot);
  }
});

// TC13: reviewer prompt body contains the eight known composition-leak patterns
//        AND new rule clauses (disposition='pending' in Rules block, notes→findings parity)
await test('TC13: prompt contains leak-pattern checklist + Rules-block clauses for disposition + notes/findings parity', async () => {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const sessionManager = makeSessionManager(cannedPassed);
    const logger = makeLogger();
    const tokenTracker = makeTokenTracker();
    const reviewer = new Reviewer(sessionManager, logger, tokenTracker);
    await reviewer.reviewMilestone(
      'ms-tc13', ['src/foo.js'], ['Task t1: test'], 'importGraph data',
      projectRoot, harnessDir
    );

    assert.strictEqual(sessionManager.calls.length, 1, 'expected exactly one spawn call');
    const prompt = sessionManager.calls[0].prompt;
    assert.ok(typeof prompt === 'string' && prompt.length > 0, 'prompt must be a non-empty string');

    // Leak-pattern checklist: all 8 named patterns must appear in the prompt
    const patterns = [
      'schema-consumer drift',
      'cross-file type contract',
      'inner required missing',
      'prompt-schema bidirectional consistency',
      'enum-mapping coverage',
      'behavioral rule enforceability',
      'file-written',         // archive-allowlist coupling line
      'test isolation',
    ];
    for (const p of patterns) {
      assert.ok(prompt.includes(p), `prompt must mention leak pattern: ${p}`);
    }

    // Rules block must contain BOTH the disposition='pending' rule (G) and notes→findings parity (H)
    const rulesIdx = prompt.indexOf('Rules:');
    assert.ok(rulesIdx >= 0, 'prompt must have a Rules: block');
    const rulesBlock = prompt.slice(rulesIdx);
    assert.ok(/disposition.*pending/i.test(rulesBlock),
      "Rules block must contain a clause requiring disposition='pending' on emit");
    assert.ok(/notes.*findings|findings.*notes/i.test(rulesBlock),
      'Rules block must contain a clause naming both notes and findings (parity rule)');

    // 'cosmetic' tier independence clause (F): prompt explicitly states tier is independent of category
    assert.ok(/INDEPENDENTLY|independent.*category|not a 1:1/i.test(prompt),
      'prompt must state that tier is applied independently of category (cosmetic-tier independence)');

    // dispositionReason positive-population clause (E): prompt must explain WHEN it is populated
    assert.ok(/dispositionReason/.test(prompt) && /rationale|when disposition/i.test(prompt),
      'prompt must explain when dispositionReason is populated (positive-population guidance)');
  } finally {
    cleanup(projectRoot);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
