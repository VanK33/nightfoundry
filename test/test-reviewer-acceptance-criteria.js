/**
 * test-reviewer-acceptance-criteria.js — Tests for the reviewer's
 * acceptance-criteria review section (spec AC2).
 *
 * Drives the real Reviewer.reviewMilestone() with a mock sessionManager whose
 * spawn() captures the constructed prompt (mirrors test-reviewer-integration.js).
 * No live SDK.
 *
 * Coverage (designed from the spec, not from reading the prompt source):
 *   TC1 — acceptanceCriteria non-empty → prompt contains an
 *         'Acceptance Criteria Review' section and every criterion's description.
 *   TC2 — kind=command criteria surface their verification.command as a hint.
 *   TC3 — uncoveredCriteria appears in the structured-output shape when criteria
 *         are present (the reviewer is taught the new optional field).
 *   TC4 — acceptanceCriteria = [] → NO 'Acceptance Criteria Review' section
 *         (fail-soft) and no uncoveredCriteria teaching.
 *   TC5 — scopeContext omits acceptanceCriteria entirely → reviewMilestone
 *         defaults it to [] and runs without throwing; no section emitted.
 *   TC6 — the empty-criteria prompt is byte-identical to the no-criteria-key
 *         prompt (fail-soft: passing [] must not perturb the prompt).
 *
 * Run: node test/test-reviewer-acceptance-criteria.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { Reviewer } from '../src/orchestrator/agents/reviewer.js';

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

// ── Fixture helpers (mirror test-reviewer-integration.js) ──────────────────

function createHarness() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-ac-'));
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'progress'), { recursive: true });
  return { projectRoot, harnessDir };
}

function cleanup(projectRoot) {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

const cannedPassed = {
  structured_output: { result: 'PASSED', findings: [], notes: 'No issues found.' },
};

const noop = () => {};

function makeSessionManager(cannedSdkResult) {
  const calls = [];
  const handle = { systemPromptTokens: 0, _toolCallCount: 0 };
  return {
    calls,
    spawn(opts) {
      calls.push(opts);
      const spawnPromise = Promise.resolve({ handle, result: cannedSdkResult });
      spawnPromise.handle = handle;
      return spawnPromise;
    },
  };
}

function makeLogger() {
  return {
    createSessionLog: () => ({ logPath: '/tmp/fake.log', close: noop }),
    attachToSession: noop,
    getSessionSummary: () => ({}),
    writeSessionSummary: noop,
    warn: noop,
  };
}

function makeTokenTracker() {
  return { recordSession: noop };
}

/**
 * Build a reviewer + capture the prompt produced for the given scopeContext.
 * Returns the prompt string (calls[0].prompt). When scopeContext is undefined,
 * reviewMilestone is invoked with the 6-arg signature (no scopeContext at all).
 */
async function capturePrompt(scopeContext) {
  const { projectRoot, harnessDir } = createHarness();
  try {
    const sessionManager = makeSessionManager(cannedPassed);
    const reviewer = new Reviewer(sessionManager, makeLogger(), makeTokenTracker());
    const args = [
      'ms-ac',
      ['src/foo.js'],
      ['Task t1: implement feature'],
      'importGraph data',
      projectRoot,
      harnessDir,
    ];
    if (scopeContext !== undefined) args.push(scopeContext);
    await reviewer.reviewMilestone(...args);
    assert.ok(sessionManager.calls.length === 1, 'expected exactly one spawn call');
    return sessionManager.calls[0].prompt;
  } finally {
    cleanup(projectRoot);
  }
}

// A representative acceptance_criteria array in the post-(1) item shape.
const criteria = [
  {
    description: 'The login endpoint rejects expired tokens.',
    verification: { kind: 'command', command: 'node test/test-auth.js', targetFile: 'test/test-auth.js' },
  },
  {
    description: 'A README section documents the new flag.',
    verification: { kind: 'file-check', targetFile: 'README.md' },
  },
  {
    description: 'The operator can rotate keys manually.',
    verification: { kind: 'manual', manualSteps: 'Run the rotate command and confirm.' },
  },
];

const SECTION_HEADER = 'Acceptance Criteria Review';

// ── Tests ──────────────────────────────────────────────────────────────────

// TC1 — non-empty criteria → section header + every description appears
await test('TC1: non-empty acceptanceCriteria → prompt has Acceptance Criteria Review section + each description', async () => {
  const prompt = await capturePrompt({ acceptanceCriteria: criteria });

  assert.ok(
    prompt.includes(SECTION_HEADER),
    `prompt should contain an "${SECTION_HEADER}" section`
  );
  for (const c of criteria) {
    assert.ok(
      prompt.includes(c.description),
      `prompt should contain criterion description: "${c.description}"`
    );
  }
});

// TC2 — kind=command criteria surface their verification.command as a hint
await test('TC2: kind=command criteria surface their verification.command in the prompt', async () => {
  const prompt = await capturePrompt({ acceptanceCriteria: criteria });

  const commandCriterion = criteria.find(c => c.verification.kind === 'command');
  assert.ok(commandCriterion, 'sanity: fixture has a kind=command criterion');
  assert.ok(
    prompt.includes(commandCriterion.verification.command),
    `prompt should surface the command verification hint: "${commandCriterion.verification.command}"`
  );
});

// TC3 — uncoveredCriteria field is taught to the reviewer when criteria present
await test('TC3: prompt teaches the optional uncoveredCriteria verdict field when criteria present', async () => {
  const prompt = await capturePrompt({ acceptanceCriteria: criteria });
  assert.ok(
    prompt.includes('uncoveredCriteria'),
    'prompt should teach the uncoveredCriteria verdict field when criteria are present'
  );
});

// TC4 — empty criteria → NO section, NO uncoveredCriteria teaching (fail-soft)
await test('TC4: acceptanceCriteria = [] → prompt has NO Acceptance Criteria Review section (fail-soft)', async () => {
  const prompt = await capturePrompt({ acceptanceCriteria: [] });
  assert.ok(
    !prompt.includes(SECTION_HEADER),
    `prompt should NOT contain "${SECTION_HEADER}" when acceptanceCriteria is empty`
  );
  assert.ok(
    !prompt.includes('uncoveredCriteria'),
    'prompt should NOT teach uncoveredCriteria when acceptanceCriteria is empty (fail-soft)'
  );
});

// TC5 — scopeContext omits acceptanceCriteria → defaults to [] and runs cleanly
await test('TC5: scopeContext without acceptanceCriteria → reviewMilestone defaults to [], runs, no section', async () => {
  // scopeContext present but WITHOUT the acceptanceCriteria key — the destructure
  // default ([]) must apply, no section emitted, and no throw.
  let prompt;
  await assert.doesNotReject(async () => {
    prompt = await capturePrompt({ specGoal: 'do the thing', specScopeFiles: [], exceededFiles: [] });
  }, 'reviewMilestone must not reject when scopeContext omits acceptanceCriteria');

  assert.ok(
    !prompt.includes(SECTION_HEADER),
    `prompt should NOT contain "${SECTION_HEADER}" when acceptanceCriteria key is absent from scopeContext`
  );
});

// TC6 — empty-criteria prompt is byte-identical to the no-criteria-key prompt
await test('TC6: passing acceptanceCriteria=[] yields the same prompt as omitting the key (byte-identical fail-soft)', async () => {
  // Hold every other scopeContext field equal so the ONLY difference under test
  // is acceptanceCriteria=[] vs acceptanceCriteria-absent. Both must be byte-equal.
  const baseCtx = { specGoal: '', specScopeFiles: [], exceededFiles: [] };
  const promptEmpty = await capturePrompt({ ...baseCtx, acceptanceCriteria: [] });
  const promptAbsent = await capturePrompt({ ...baseCtx });

  assert.strictEqual(
    promptEmpty,
    promptAbsent,
    'an empty acceptanceCriteria array must produce a byte-identical prompt to omitting the key'
  );
});

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
