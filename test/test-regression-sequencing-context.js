/**
 * test-regression-sequencing-context.js — Tests for the pending-deliverables
 * sequencing context threaded through the regression gates (mission +
 * milestone) via buildPendingDeliverablesBlock (src/orchestrator/gates/
 * regression.js), and for the two amended clauses in the verifier's
 * task-prompt template (src/orchestrator/agents/verifier.js).
 *
 * No Claude auth, no live sessions. Uses a mock sessionManager/logger/
 * tokenTracker whose `spawn` returns a thenable resolving to
 * { handle, result }, and captures the spawn options (including the task
 * `.prompt`) via spawnSpy — same idiom as test-verifier-spec-read-audit.js.
 *
 * All harness state used by these tests is produced by the REAL
 * writeGlobalPlan/writeMissionState (src/orchestrator/core/state.js) on an
 * fs.mkdtemp harness dir seeded with a minimal initial state.json — no
 * hand-seeded persisted fields.
 *
 * Run: node test/test-regression-sequencing-context.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

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

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'regression-sequencing-'));
}
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

/**
 * Build a mock setup. Returns { sessionManager, logger, tokenTracker, spawnSpy }.
 *
 * The returned `spawnSpy` captures the options object passed to
 * sessionManager.spawn(...) (including `opts.prompt` — the TASK-prompt, NOT
 * the systemPrompt), so callers can assert on the verifier prompt that
 * verifyMission/verifyMilestone (via Verifier#verifyRegression) built.
 */
function makeMockSetup({ readFiles = [], structuredOutput }) {
  const spawnSpy = { calls: [] };

  const handle = {
    _readFiles: readFiles,
    _toolCallCount: 0,
    systemPromptTokens: 0,
  };

  const sdkResult = structuredOutput !== undefined
    ? { structured_output: structuredOutput }
    : {};

  const spawnResult = { handle, result: sdkResult };

  // The thenable must expose .handle synchronously (for attachToSession call)
  // AND resolve to { handle, result } when awaited.
  const thenable = Object.assign(Promise.resolve(spawnResult), { handle });

  const sessionManager = {
    spawn: (spawnOpts) => {
      spawnSpy.calls.push(spawnOpts);
      return thenable;
    },
  };

  const logger = {
    createSessionLog: () => ({ logPath: '/tmp/test-regression-sequencing.log', close: () => {} }),
    attachToSession: () => {},
    warn: () => {},
    writeSessionSummary: async () => {},
    getSessionSummary: () => '',
  };

  const tokenTracker = { recordSession: async () => {} };

  return { sessionManager, logger, tokenTracker, spawnSpy };
}

/** A PASSED regressionVerifierSchema-shaped structured_output. */
function passedStructuredOutput() {
  return {
    result: 'PASSED',
    hardChecks: [],
    taskScopeChecks: [],
    back_reference_check: { spec_consulted: false, plan_consulted: false, deviations: [] },
  };
}

/**
 * Seed a minimal initial state.json under harnessDir — the ONLY hand-seeded
 * state — so writeGlobalPlan's readState(harnessDir) precondition is met.
 * Everything else (milestones, missions, targetFiles, mission state files)
 * is produced by the real writeGlobalPlan/writeMissionState.
 */
function seedInitialState(harnessDir, { prdPath }) {
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta: { currentPhase: 'planning', prdPath },
      milestones: {},
    }, null, 2),
  );
}

/**
 * Byte-identical reconstruction of the mission-level regression purpose
 * template from src/orchestrator/gates/regression.js verifyMission, WITHOUT
 * the pendingDeliverablesBlock suffix — i.e. the pre-change construction.
 * Copied verbatim (minus the trailing ${pendingDeliverablesBlock}) so the
 * inert-safety test can pin exact byte equality.
 */
function expectedLegacyMissionPurpose(missionId, missionPlan, taskSummaries) {
  return `Verify that mission ${missionId} is fully implemented as described.

Mission plan:
${missionPlan}

Completed tasks (${taskSummaries.length}):
${taskSummaries.map((s, i) => `--- Task ${i + 1} ---\n${s}`).join('\n\n')}

Check:
1. Run any existing tests (npm test, pytest, etc.) to confirm nothing is broken
2. Verify the mission's described functionality actually works end-to-end
3. Check for integration issues between tasks (shared files, API contracts, imports)
4. Report PASS if the mission goal is met, FAIL with specifics if not`;
}

// ── (a) writeGlobalPlan persists mission targetFiles and readState exposes them

await test('(a) writeGlobalPlan persists mission targetFiles and readState exposes them', async () => {
  const { writeGlobalPlan, readState } = await import('../src/orchestrator/core/state.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    seedInitialState(harnessDir, { prdPath: path.join(projectRoot, 'spec.md') });

    const plan = {
      milestones: [
        {
          id: 'ms1',
          description: 'Milestone 1',
          missions: [
            { id: 'mi1', description: 'Mission 1', targetFiles: ['a.js', 'b.js'] },
          ],
        },
      ],
      scopeItems: [],
      scopeMapping: {},
    };

    writeGlobalPlan(harnessDir, plan);

    const state = readState(harnessDir);
    assert.deepStrictEqual(
      state.milestones.ms1.missions.mi1.targetFiles,
      ['a.js', 'b.js'],
      'targetFiles must round-trip through writeGlobalPlan/readState',
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── (b) plan without targetFiles persists without the field, no throw ─────

await test('(b) plan without targetFiles persists without the field and without throwing', async () => {
  const { writeGlobalPlan, readState } = await import('../src/orchestrator/core/state.js');
  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    seedInitialState(harnessDir, { prdPath: path.join(projectRoot, 'spec.md') });

    const plan = {
      milestones: [
        {
          id: 'ms1',
          description: 'Milestone 1',
          missions: [
            { id: 'mi1', description: 'Mission 1' }, // no targetFiles
          ],
        },
      ],
      scopeItems: [],
      scopeMapping: {},
    };

    assert.doesNotThrow(() => writeGlobalPlan(harnessDir, plan));

    const state = readState(harnessDir);
    assert.ok(
      !('targetFiles' in state.milestones.ms1.missions.mi1),
      `mission entry must not carry a targetFiles key when the plan omitted it, got keys: ${Object.keys(state.milestones.ms1.missions.mi1).join(', ')}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── (c) verifyMission FIRE ─────────────────────────────────────────────────

await test("(c) verifyMission FIRE: prompt names pending sibling mission's files with 'NOT grounds for failure' language, excludes the gated mission", async () => {
  const { writeGlobalPlan, writeMissionState } = await import('../src/orchestrator/core/state.js');
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const { verifyMission } = await import('../src/orchestrator/gates/regression.js');

  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');
    seedInitialState(harnessDir, { prdPath: specPath });

    const plan = {
      milestones: [
        {
          id: 'ms1',
          description: 'Milestone 1',
          missions: [
            { id: 'mi1', description: 'Gated mission' },
            { id: 'mi2', description: 'Sibling mission', targetFiles: ['lib/sibling-a.js', 'lib/sibling-b.js'] },
          ],
        },
      ],
      scopeItems: [],
      scopeMapping: {},
    };

    writeGlobalPlan(harnessDir, plan);
    writeMissionState(harnessDir, 'mi1', 'Gated mission', { subMissions: [] });

    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      structuredOutput: passedStructuredOutput(),
    });
    const verifier = new Verifier(sessionManager, logger, tokenTracker);

    await verifyMission({
      missionId: 'mi1',
      missionPlan: 'Gated mission plan text',
      verifier,
      projectRoot,
      harnessDir,
      onLog: () => {},
    });

    assert.strictEqual(spawnSpy.calls.length, 1, 'spawn must be called exactly once');
    const prompt = spawnSpy.calls[0].prompt;
    assert.strictEqual(typeof prompt, 'string', 'spawn must be called with a string prompt (task-prompt, not systemPrompt)');

    assert.ok(
      prompt.includes('lib/sibling-a.js') && prompt.includes('lib/sibling-b.js'),
      `prompt must name the pending sibling mission's files. Prompt was:\n${prompt}`,
    );
    assert.ok(
      prompt.includes('NOT grounds for failure'),
      `prompt must contain the pending-deliverables 'NOT grounds for failure' language. Prompt was:\n${prompt}`,
    );
    assert.ok(
      !prompt.includes('- Mission mi1:'),
      `prompt must NOT list the gated mission itself in the pending-deliverables block. Prompt was:\n${prompt}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── (d) verifyMission inert-safety ─────────────────────────────────────────

await test('(d) verifyMission inert-safety: no pending missions → block absent, prompt byte-identical to legacy construction', async () => {
  const { writeGlobalPlan, writeMissionState } = await import('../src/orchestrator/core/state.js');
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const { verifyMission } = await import('../src/orchestrator/gates/regression.js');

  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');
    seedInitialState(harnessDir, { prdPath: specPath });

    // Single milestone, single mission — the mission under test is the ONLY
    // mission, so excludeMissionId excludes it and no pending mission remains.
    const plan = {
      milestones: [
        {
          id: 'ms1',
          description: 'Milestone 1',
          missions: [
            { id: 'mi1', description: 'Only mission' },
          ],
        },
      ],
      scopeItems: [],
      scopeMapping: {},
    };

    writeGlobalPlan(harnessDir, plan);
    writeMissionState(harnessDir, 'mi1', 'Only mission', { subMissions: [] });

    const missionPlanText = 'Gated mission plan (inert)';
    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      structuredOutput: passedStructuredOutput(),
    });
    const verifier = new Verifier(sessionManager, logger, tokenTracker);

    await verifyMission({
      missionId: 'mi1',
      missionPlan: missionPlanText,
      verifier,
      projectRoot,
      harnessDir,
      onLog: () => {},
    });

    assert.strictEqual(spawnSpy.calls.length, 1, 'spawn must be called exactly once');
    const prompt = spawnSpy.calls[0].prompt;

    // Block absent: no marker text anywhere in the prompt.
    assert.ok(
      !prompt.includes('Pending deliverables'),
      `prompt must not contain the pending-deliverables block header when no missions are pending. Prompt was:\n${prompt}`,
    );
    assert.ok(
      !prompt.includes('NOT grounds for failure'),
      `prompt must not contain the pending-deliverables phrase when no missions are pending. Prompt was:\n${prompt}`,
    );

    // Byte-identical pin: the exact legacy purpose text (no trailing block)
    // must appear verbatim in the prompt (taskSummaries is empty — no
    // completed tasks were recorded for mi1).
    const expectedPurpose = expectedLegacyMissionPurpose('mi1', missionPlanText, []);
    assert.ok(
      prompt.includes(expectedPurpose),
      `prompt must contain the byte-identical legacy purpose text with no pending-deliverables suffix.\nExpected substring:\n${expectedPurpose}\n\nActual prompt:\n${prompt}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── (e) verifyMilestone fire + absence pins ────────────────────────────────

await test("(e) verifyMilestone FIRE: prompt names a pending sibling milestone's mission files with 'NOT grounds for failure' language", async () => {
  const { writeGlobalPlan } = await import('../src/orchestrator/core/state.js');
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const { verifyMilestone } = await import('../src/orchestrator/gates/regression.js');

  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');
    seedInitialState(harnessDir, { prdPath: specPath });

    const plan = {
      milestones: [
        {
          id: 'ms1',
          description: 'Milestone 1',
          missions: [
            { id: 'mi1', description: 'Mission in gated milestone' },
          ],
        },
        {
          id: 'ms2',
          description: 'Milestone 2 (not yet run)',
          missions: [
            { id: 'mi2', description: 'Future mission', targetFiles: ['lib/future-a.js'] },
          ],
        },
      ],
      scopeItems: [],
      scopeMapping: {},
    };

    writeGlobalPlan(harnessDir, plan);

    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      structuredOutput: passedStructuredOutput(),
    });
    const verifier = new Verifier(sessionManager, logger, tokenTracker);

    await verifyMilestone({
      milestoneId: 'ms1',
      milestoneDesc: 'Milestone 1',
      specPath,
      verifier,
      projectRoot,
      harnessDir,
      onLog: () => {},
    });

    assert.strictEqual(spawnSpy.calls.length, 1, 'spawn must be called exactly once');
    const prompt = spawnSpy.calls[0].prompt;

    assert.ok(
      prompt.includes('lib/future-a.js'),
      `prompt must name the pending milestone's mission file. Prompt was:\n${prompt}`,
    );
    assert.ok(
      prompt.includes('NOT grounds for failure'),
      `prompt must contain the pending-deliverables 'NOT grounds for failure' language. Prompt was:\n${prompt}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('(e) verifyMilestone inert-safety: no pending missions/targetFiles → block absent', async () => {
  const { writeGlobalPlan } = await import('../src/orchestrator/core/state.js');
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const { verifyMilestone } = await import('../src/orchestrator/gates/regression.js');

  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');
    seedInitialState(harnessDir, { prdPath: specPath });

    const plan = {
      milestones: [
        {
          id: 'ms1',
          description: 'Milestone 1',
          missions: [
            { id: 'mi1', description: 'Only mission, no targetFiles' },
          ],
        },
      ],
      scopeItems: [],
      scopeMapping: {},
    };

    writeGlobalPlan(harnessDir, plan);

    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      structuredOutput: passedStructuredOutput(),
    });
    const verifier = new Verifier(sessionManager, logger, tokenTracker);

    await verifyMilestone({
      milestoneId: 'ms1',
      milestoneDesc: 'Milestone 1',
      specPath,
      verifier,
      projectRoot,
      harnessDir,
      onLog: () => {},
    });

    assert.strictEqual(spawnSpy.calls.length, 1, 'spawn must be called exactly once');
    const prompt = spawnSpy.calls[0].prompt;

    assert.ok(
      !prompt.includes('Pending deliverables'),
      `prompt must not contain the pending-deliverables block header when nothing is pending. Prompt was:\n${prompt}`,
    );
    assert.ok(
      !prompt.includes('NOT grounds for failure'),
      `prompt must not contain the pending-deliverables phrase when nothing is pending. Prompt was:\n${prompt}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── (f) task-prompt clauses ─────────────────────────────────────────────────

await test('(f) captured task-prompt contains the amended missing-file clause and the later-deliverables deferral clause', async () => {
  const { writeGlobalPlan, writeMissionState } = await import('../src/orchestrator/core/state.js');
  const { Verifier } = await import('../src/orchestrator/agents/verifier.js');
  const { verifyMission } = await import('../src/orchestrator/gates/regression.js');

  const projectRoot = tempDir();
  try {
    const harnessDir = path.join(projectRoot, '.harness');
    const specPath = path.join(projectRoot, 'spec.md');
    fs.writeFileSync(specPath, '# Spec\n');
    seedInitialState(harnessDir, { prdPath: specPath });

    const plan = {
      milestones: [
        {
          id: 'ms1',
          description: 'Milestone 1',
          missions: [
            { id: 'mi1', description: 'Mission under test' },
          ],
        },
      ],
      scopeItems: [],
      scopeMapping: {},
    };

    writeGlobalPlan(harnessDir, plan);
    writeMissionState(harnessDir, 'mi1', 'Mission under test', { subMissions: [] });

    const { sessionManager, logger, tokenTracker, spawnSpy } = makeMockSetup({
      structuredOutput: passedStructuredOutput(),
    });
    const verifier = new Verifier(sessionManager, logger, tokenTracker);

    await verifyMission({
      missionId: 'mi1',
      missionPlan: 'Mission plan text',
      verifier,
      projectRoot,
      harnessDir,
      onLog: () => {},
    });

    assert.strictEqual(spawnSpy.calls.length, 1, 'spawn must be called exactly once');
    const prompt = spawnSpy.calls[0].prompt;
    assert.strictEqual(typeof prompt, 'string', 'must assert on the captured task-prompt (.prompt), not the systemPrompt');

    // Amended missing-file clause: a REQUIRED missing file's finding SHOULD
    // name its intended path.
    assert.ok(
      prompt.includes('REQUIRED file is MISSING') && prompt.includes("finding SHOULD name that file's intended path"),
      `task-prompt must contain the amended missing-file clause. Prompt was:\n${prompt}`,
    );

    // Later-deliverables deferral clause: criteria targeting pending-
    // deliverables files are not judged at this gate.
    assert.ok(
      prompt.includes('pending-deliverables block') && prompt.includes('must NOT be judged at this gate'),
      `task-prompt must contain the later-deliverables deferral clause. Prompt was:\n${prompt}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exitCode = failCount > 0 ? 1 : 0;
