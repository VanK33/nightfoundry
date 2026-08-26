#!/usr/bin/env node
/**
 * test-verifier-foreign-pending.js — Self-contained coverage for
 * buildForeignPendingFiles(harnessDir, ownMissionId) exported from
 * '../src/orchestrator/gates/regression.js'.
 *
 * Cases:
 *   H1 — own mission's targetFiles excluded, foreign pending mission's
 *        targetFiles included.
 *   H2 — foreign terminal missions ('complete', 'invalidated') contribute
 *        nothing; own mission's own targetFiles are also absent.
 *   H3 — foreign non-terminal mission's targetFiles are subtracted
 *        path-level against the own mission's targetFiles.
 *   H4 — missing state.json and malformed state.json JSON both yield an
 *        empty array without throwing.
 *   D1 — options built with denyForeignPendingBash: true and
 *        foreignPendingFiles: ['src/b.js'] deny 'cat src/b.js' with a
 *        message pointing at the sanctioned Read/Grep inspection path.
 *   D2 — the same foreignPendingFiles list without the opt-in flag does
 *        not deny 'cat src/b.js'.
 *   D3 — the flag plus foreignPendingFiles: ['src/b.js'] does not deny an
 *        unlisted path ('cat src/unlisted.js').
 *   D4 — the flagged options also deny the './'-prefixed reference form
 *        ('grep -n foo ./src/b.js').
 *
 * Spawn-plumbing group (mission 001-003 thread): drives the REAL
 * Verifier.verifyTask / verifyRegression from
 * '../src/orchestrator/agents/verifier.js' with a stubbed
 * sessionManager.spawn that captures its options object, mirroring the
 * fixture in test-p1-prompt-hardening.js.
 *
 *   P1 — a non-empty context.foreignPendingFiles list produces captured
 *        spawn options with denyForeignPendingBash === true and
 *        foreignPendingFiles deep-equal to that list.
 *   P2 — no context.foreignPendingFiles list produces captured spawn
 *        options carrying no non-empty foreignPendingFiles array (so no
 *        deny is possible).
 *   P3 — verifyRegression's captured spawn options carry no non-empty
 *        foreignPendingFiles array either.
 *
 * Prompt-block group (mission 001-004 thread): drives the REAL
 * Verifier.verifyTask with a stubbed sessionManager.spawn that captures the
 * *prompt string itself* (not just the spawn options), asserting on the
 * FOREIGN-PENDING-FILES block's presence/absence and on the two pinned
 * back_reference_check phrases from test-p1-prompt-hardening.js.
 *
 *   PB1 — a non-empty context.foreignPendingFiles list produces a captured
 *         prompt containing every listed path.
 *   PB2 — no context.foreignPendingFiles list produces a captured prompt
 *         containing neither the FOREIGN-PENDING-FILES block's identifying
 *         text nor any listed path.
 *   PB3 — both the PB1 and PB2 prompts contain the pinned phrases
 *         'back_reference_check is REQUIRED' and 'Honest non-consultation is
 *         allowed; omitting the field is not.' byte-identically.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';

import { buildForeignPendingFiles } from '../src/orchestrator/gates/regression.js';
import { SessionManager } from '../src/orchestrator/infra/session-manager.js';
import { Verifier } from '../src/orchestrator/agents/verifier.js';

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    passCount++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failCount++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err && err.message ? err.message : err}`);
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-foreign-pending-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeState(harnessDir, state) {
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state), 'utf8');
}

await test('H1: foreign pending mission targetFiles are included', async () => {
  const dir = tempDir();
  try {
    writeState(dir, {
      milestones: {
        '001': {
          missions: {
            '001-001': { status: 'running', targetFiles: ['src/a.js'] },
            '001-002': { status: 'pending', targetFiles: ['src/b.js'] },
          },
        },
      },
    });

    const result = buildForeignPendingFiles(dir, '001-001');
    assert.ok(Array.isArray(result), 'result should be an array');
    assert.ok(result.includes('src/b.js'), 'expected src/b.js to be included');
  } finally {
    cleanup(dir);
  }
});

await test('H2: terminal foreign missions and own mission files are excluded', async () => {
  const dir = tempDir();
  try {
    writeState(dir, {
      milestones: {
        '001': {
          missions: {
            '001-001': { status: 'running', targetFiles: ['src/a.js'] },
            '001-002': { status: 'complete', targetFiles: ['src/b.js'] },
            '001-003': { status: 'invalidated', targetFiles: ['src/c.js'] },
          },
        },
      },
    });

    const result = buildForeignPendingFiles(dir, '001-001');
    assert.ok(Array.isArray(result), 'result should be an array');
    assert.ok(!result.includes('src/b.js'), 'complete mission files must be excluded');
    assert.ok(!result.includes('src/c.js'), 'invalidated mission files must be excluded');
    assert.ok(!result.includes('src/a.js'), 'own mission files must be excluded');
  } finally {
    cleanup(dir);
  }
});

await test('H3: overlapping foreign/own files are subtracted path-level', async () => {
  const dir = tempDir();
  try {
    writeState(dir, {
      milestones: {
        '001': {
          missions: {
            '001-001': { status: 'running', targetFiles: ['src/a.js'] },
            '001-002': { status: 'running', targetFiles: ['src/a.js', 'src/c.js'] },
          },
        },
      },
    });

    const result = buildForeignPendingFiles(dir, '001-001');
    assert.ok(Array.isArray(result), 'result should be an array');
    assert.ok(result.includes('src/c.js'), 'expected src/c.js to be included');
    assert.ok(!result.includes('src/a.js'), 'expected src/a.js (also own) to be excluded');
  } finally {
    cleanup(dir);
  }
});

await test('H4: missing or malformed state.json yields empty array without throwing', async () => {
  const missingDir = tempDir();
  const malformedDir = tempDir();
  try {
    // missingDir intentionally has no state.json written.
    const resultMissing = buildForeignPendingFiles(missingDir, '001-001');
    assert.ok(Array.isArray(resultMissing), 'result should be an array (missing state.json)');
    assert.strictEqual(resultMissing.length, 0, 'expected empty array for missing state.json');

    fs.writeFileSync(path.join(malformedDir, 'state.json'), '{ not valid json', 'utf8');
    const resultMalformed = buildForeignPendingFiles(malformedDir, '001-001');
    assert.ok(Array.isArray(resultMalformed), 'result should be an array (malformed state.json)');
    assert.strictEqual(resultMalformed.length, 0, 'expected empty array for malformed state.json');
  } finally {
    cleanup(missingDir);
    cleanup(malformedDir);
  }
});

await test('D1: denyForeignPendingBash denies a listed foreign-pending path with a Read/Grep-pointing message', () => {
  const sm = new SessionManager();
  const options = sm._buildSdkOptions({
    denyForeignPendingBash: true,
    foreignPendingFiles: ['src/b.js'],
  });
  const denied = options.canUseTool('Bash', { command: 'cat src/b.js' });
  assert.strictEqual(denied?.behavior, 'deny', 'expected DENY for cat src/b.js');
  assert.ok(/Read/.test(denied.message), `Deny message must mention Read; got: ${denied.message}`);
  assert.ok(/Grep/.test(denied.message), `Deny message must mention Grep; got: ${denied.message}`);
});

await test('D2: without denyForeignPendingBash, the same foreignPendingFiles list does not deny', () => {
  const sm = new SessionManager();
  const options = sm._buildSdkOptions({
    foreignPendingFiles: ['src/b.js'],
  });
  const result = options.canUseTool('Bash', { command: 'cat src/b.js' });
  assert.notStrictEqual(result?.behavior, 'deny', 'expected non-deny without the opt-in flag');
});

await test('D3: an unlisted path is not denied even when the flag is set', () => {
  const sm = new SessionManager();
  const options = sm._buildSdkOptions({
    denyForeignPendingBash: true,
    foreignPendingFiles: ['src/b.js'],
  });
  const result = options.canUseTool('Bash', { command: 'cat src/unlisted.js' });
  assert.notStrictEqual(result?.behavior, 'deny', 'expected non-deny for an unlisted path');
});

await test("D4: the './'-prefixed reference form of a listed path is also denied", () => {
  const sm = new SessionManager();
  const options = sm._buildSdkOptions({
    denyForeignPendingBash: true,
    foreignPendingFiles: ['src/b.js'],
  });
  const denied = options.canUseTool('Bash', { command: 'grep -n foo ./src/b.js' });
  assert.strictEqual(denied?.behavior, 'deny', "expected DENY for './'-prefixed src/b.js");
});

// ── Spawn-plumbing group fixtures (mirrors test-p1-prompt-hardening.js) ─────

const noop = () => {};

function makeLogger() {
  return {
    createSessionLog: () => ({ logPath: '/tmp/test-verifier-foreign-pending.log', close: noop }),
    attachToSession: noop,
    warn: noop,
    writeSessionSummary: async () => {},
    getSessionSummary: () => '',
  };
}

function makeTokenTracker() {
  return { recordSession: async () => {} };
}

const passedVerdict = {
  result: 'PASSED',
  hardChecks: [],
  taskScopeChecks: [],
  back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
};

/**
 * Mock sessionManager whose spawn() captures the options object and returns
 * a thenable exposing .handle synchronously AND resolving to { handle, result }
 * (mirrors test-p1-prompt-hardening.js's makeSessionManager).
 */
function makeSpawnCapture({ readFiles = [], sdkResult }) {
  const spawnSpy = { calls: [] };
  const handle = { _readFiles: readFiles, _toolCallCount: 0, systemPromptTokens: 0 };
  const thenable = Object.assign(Promise.resolve({ handle, result: sdkResult }), { handle });
  const sessionManager = {
    spawn: (spawnOpts) => {
      spawnSpy.calls.push(spawnOpts);
      return thenable;
    },
  };
  return { sessionManager, spawnSpy };
}

function setupVerifyFixture(prefix) {
  const projectRoot = tempDir();
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'verify'), { recursive: true });

  const specPath = path.join(projectRoot, 'spec.md');
  fs.writeFileSync(specPath, '# Spec\n');

  const task = { id: `${prefix}-task`, description: 'test', targetFiles: [] };
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${task.id}.json`),
    JSON.stringify({ hardChecks: [], testCases: [] }, null, 2),
  );

  return { projectRoot, specPath, task };
}

function assertNoNonEmptyForeignPendingFiles(spawnOpts, label) {
  const fpf = spawnOpts.foreignPendingFiles;
  const isNonEmptyArray = Array.isArray(fpf) && fpf.length > 0;
  assert.strictEqual(
    isNonEmptyArray,
    false,
    `${label}: expected no non-empty foreignPendingFiles array, got: ${JSON.stringify(fpf)}`,
  );
  assert.notStrictEqual(
    spawnOpts.denyForeignPendingBash,
    true,
    `${label}: expected denyForeignPendingBash not to be true, got: ${spawnOpts.denyForeignPendingBash}`,
  );
}

await test('P1: non-empty context.foreignPendingFiles → captured spawn options carry denyForeignPendingBash === true and a deep-equal foreignPendingFiles list', async () => {
  const { projectRoot, specPath, task } = setupVerifyFixture('p1-fpf');
  try {
    const foreignPendingFiles = ['src/b.js', 'src/c.js'];
    const { sessionManager, spawnSpy } = makeSpawnCapture({
      readFiles: [specPath],
      sdkResult: { structured_output: { ...passedVerdict } },
    });

    const verifier = new Verifier(sessionManager, makeLogger(), makeTokenTracker());
    await verifier.verifyTask(task, projectRoot, { specPath, foreignPendingFiles });

    assert.strictEqual(spawnSpy.calls.length, 1, 'spawn must be called exactly once');
    const spawnOpts = spawnSpy.calls[0];
    assert.strictEqual(
      spawnOpts.denyForeignPendingBash,
      true,
      `expected denyForeignPendingBash === true, got: ${spawnOpts.denyForeignPendingBash}`,
    );
    assert.deepStrictEqual(
      spawnOpts.foreignPendingFiles,
      foreignPendingFiles,
      `expected foreignPendingFiles deep-equal to ${JSON.stringify(foreignPendingFiles)}, got: ${JSON.stringify(spawnOpts.foreignPendingFiles)}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('P2: no context.foreignPendingFiles → captured spawn options carry no non-empty foreignPendingFiles array', async () => {
  const { projectRoot, specPath, task } = setupVerifyFixture('p2-fpf');
  try {
    const { sessionManager, spawnSpy } = makeSpawnCapture({
      readFiles: [specPath],
      sdkResult: { structured_output: { ...passedVerdict } },
    });

    const verifier = new Verifier(sessionManager, makeLogger(), makeTokenTracker());
    await verifier.verifyTask(task, projectRoot, { specPath });

    assert.strictEqual(spawnSpy.calls.length, 1, 'spawn must be called exactly once');
    assertNoNonEmptyForeignPendingFiles(spawnSpy.calls[0], 'P2');
  } finally {
    cleanup(projectRoot);
  }
});

await test('P3: verifyRegression captured spawn options carry no non-empty foreignPendingFiles array', async () => {
  const { projectRoot, specPath, task } = setupVerifyFixture('p3-fpf');
  try {
    const { sessionManager, spawnSpy } = makeSpawnCapture({
      readFiles: [specPath],
      sdkResult: {
        structured_output: { ...passedVerdict, findings: [] },
      },
    });

    const verifier = new Verifier(sessionManager, makeLogger(), makeTokenTracker());
    await verifier.verifyRegression(task, projectRoot, { specPath });

    assert.strictEqual(spawnSpy.calls.length, 1, 'spawn must be called exactly once');
    assertNoNonEmptyForeignPendingFiles(spawnSpy.calls[0], 'P3');
  } finally {
    cleanup(projectRoot);
  }
});

// ── Prompt-block group fixtures (mission 001-004 thread) ────────────────────

// Pinned phrases (byte-identical to test-p1-prompt-hardening.js's constants
// of the same names — the wording verify.js's prompt template carries).
const VERIFIER_REQUIRED_PHRASE = 'back_reference_check is REQUIRED';
const VERIFIER_HONEST_PHRASE = 'Honest non-consultation is allowed; omitting the field is not.';

// The FOREIGN-PENDING-FILES block's identifying header text (see
// foreignPendingFilesBlock in src/orchestrator/agents/verifier.js).
const FOREIGN_PENDING_BLOCK_TEXT = 'FOREIGN-PENDING-FILES:';

/**
 * Drive the REAL verifyTask with a stubbed spawn and return the captured
 * prompt string.
 */
async function capturePromptFor(prefix, context) {
  const { projectRoot, specPath, task } = setupVerifyFixture(prefix);
  try {
    const { sessionManager, spawnSpy } = makeSpawnCapture({
      readFiles: [specPath],
      sdkResult: { structured_output: { ...passedVerdict } },
    });

    const verifier = new Verifier(sessionManager, makeLogger(), makeTokenTracker());
    await verifier.verifyTask(task, projectRoot, { specPath, ...context });

    assert.strictEqual(spawnSpy.calls.length, 1, 'spawn must be called exactly once');
    const prompt = spawnSpy.calls[0].prompt;
    assert.strictEqual(typeof prompt, 'string', 'spawn was called with a string prompt');
    return prompt;
  } finally {
    cleanup(projectRoot);
  }
}

await test('PB1: non-empty context.foreignPendingFiles → captured prompt contains every listed path', async () => {
  const foreignPendingFiles = ['src/pb-a.js', 'src/pb-b.js'];
  const prompt = await capturePromptFor('pb1-fpf', { foreignPendingFiles });

  for (const f of foreignPendingFiles) {
    assert.ok(
      prompt.includes(f),
      `verifier prompt must contain the foreign-pending path "${f}"`,
    );
  }
});

await test('PB2: no context.foreignPendingFiles → captured prompt contains no foreign-pending block text and no listed path', async () => {
  const wouldBeForeignPendingFiles = ['src/pb-a.js', 'src/pb-b.js'];
  const prompt = await capturePromptFor('pb2-fpf', {});

  assert.ok(
    !prompt.includes(FOREIGN_PENDING_BLOCK_TEXT),
    `verifier prompt must NOT contain "${FOREIGN_PENDING_BLOCK_TEXT}" when no foreign-pending list is given`,
  );
  for (const f of wouldBeForeignPendingFiles) {
    assert.ok(
      !prompt.includes(f),
      `verifier prompt must NOT contain "${f}" when no foreign-pending list is given`,
    );
  }
});

await test('PB3: both the non-empty-list and empty-list prompts carry the pinned back_reference_check phrases byte-identically', async () => {
  const nonEmptyPrompt = await capturePromptFor('pb3-nonempty-fpf', { foreignPendingFiles: ['src/pb-c.js'] });
  const emptyPrompt = await capturePromptFor('pb3-empty-fpf', {});

  for (const [label, prompt] of [['non-empty-list prompt', nonEmptyPrompt], ['empty-list prompt', emptyPrompt]]) {
    assert.ok(
      prompt.includes(VERIFIER_REQUIRED_PHRASE),
      `${label} must contain "${VERIFIER_REQUIRED_PHRASE}"`,
    );
    assert.ok(
      prompt.includes(VERIFIER_HONEST_PHRASE),
      `${label} must contain "${VERIFIER_HONEST_PHRASE}"`,
    );
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
