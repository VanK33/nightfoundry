/**
 * test-planner-constraints-injection.js — Unit tests for deterministic
 * spec-constraints injection into both planner prompts.
 *
 * Contract under test:
 *   1. buildMissionUserPrompt(missionId, missionPlan, specConstraints) — optional
 *      third param. A non-empty string-array produces a `## Spec constraints
 *      (binding)` block (one `- ` bullet per constraint) positioned after the
 *      mission-plan section and before the final "Explore the codebase first"
 *      line. Empty / absent / all-non-string entries → BYTE-IDENTICAL to the
 *      two-argument call.
 *   2. planner.planMission(...) forwards context.specConstraints into the user
 *      prompt sent to the reusable session's turn.
 *   3. planner.planGlobal(...) puts the block in the USER prompt only; the
 *      SYSTEM prompt never carries the header or constraint texts.
 *   4. Pipeline wires specConstraints from _getSpecConstraints() into its
 *      planGlobal invocations (thin source-level wiring check).
 *
 * No live SDK calls are made — fake sessionManagers intercept the prompts
 * before they would reach the network. The stub idiom mirrors
 * test/test-planner-prompt.js.
 *
 * Run: node test/test-planner-constraints-injection.js
 */
delete process.env.CC_ORCH_ACTIVE_RUN;

import assert from 'assert';
import { Planner } from '../src/orchestrator/agents/planner.js';
import { buildMissionUserPrompt } from '../src/orchestrator/agents/planner-prompts.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  const run = async () => {
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
  };
  return run();
}

// Production-real constraint shapes: plain strings exactly as spec.json
// `constraints` arrays carry them.
const CONSTRAINTS = [
  'Do NOT modify: run-context.js, make-run.js, or any file under src/orchestrator/core/harness/',
  'Test surface is CLOSED and binding: only test/test-planner-constraints-injection.js may be added; do not touch or rewrite any other test file',
];

const BLOCK_HEADER = '## Spec constraints (binding)';
const EXPLORE_LINE = 'Explore the codebase first';
const MISSION_PLAN_HEADER = 'Mission plan:';

function makeFakeLogger() {
  return {
    createSessionLog: () => ({
      logPath: '/tmp/fake-planner-constraints.jsonl',
      write: () => {},
      close: () => {},
    }),
    attachToSession: () => {},
    getSessionSummary: () => ({}),
    writeSessionSummary: async () => {},
  };
}

/**
 * Fake session manager for the planMission reusable path: spawnReusable()
 * returns a session whose sendPrompt() captures the user (turn) prompt passed
 * to it into `capturedTurnPrompts`, then resolves with a canned result whose
 * shape satisfies the planMission post-extraction validators (same shape used
 * by test-planner-prompt.js).
 */
function makeFakeReusableSessionManager(capturedTurnPrompts) {
  const fakeHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
  const fakeResult = {
    structured_output: { subMissions: [], milestones: [] },
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    total_cost_usd: 0,
  };
  return {
    spawn(opts) {
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
    spawnReusable(opts) {
      return {
        handle: fakeHandle,
        turnCount: 0,
        sendPrompt: async (prompt) => {
          capturedTurnPrompts.push(prompt);
          return fakeResult;
        },
      };
    },
  };
}

/**
 * Fake session manager for the planGlobal path: spawn() captures BOTH the
 * system prompt (into capturedSystem) and the user prompt (into capturedUser),
 * then resolves with a canned REAL response shape (milestones → missions with
 * id/description/targetFiles) so post-extraction validators pass.
 */
function makeFakeGlobalSessionManager(capturedSystem, capturedUser) {
  const fakeHandle = { systemPromptTokens: 0, _toolCallCount: 0 };
  const fakeResult = {
    structured_output: {
      milestones: [
        {
          id: '001',
          description: 'Deliver the feature',
          missions: [
            {
              id: '001-001',
              description: 'Implement the module',
              targetFiles: ['src/foo.js'],
            },
          ],
        },
      ],
      assumptions: [],
    },
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    total_cost_usd: 0,
  };
  return {
    spawn(opts) {
      capturedSystem.push(opts.systemPrompt);
      capturedUser.push(opts.prompt);
      const p = Promise.resolve({ handle: fakeHandle, result: fakeResult });
      p.handle = fakeHandle;
      return p;
    },
    spawnReusable(opts) {
      capturedSystem.push(opts.systemPrompt);
      let turnCount = 0;
      return {
        handle: fakeHandle,
        get turnCount() { return turnCount; },
        sendPrompt: async (prompt) => {
          capturedUser.push(prompt);
          turnCount++;
          return fakeResult;
        },
        close: async () => {},
      };
    },
  };
}

// ── TC1: buildMissionUserPrompt with constraints → block present + ordering ──

await test('TC1: buildMissionUserPrompt with two constraints emits the block, both bullets, positioned after mission plan and before the Explore line', async () => {
  const prompt = buildMissionUserPrompt('001-001', 'The mission plan text', CONSTRAINTS);

  assert.ok(
    prompt.includes(BLOCK_HEADER),
    `prompt should contain the block header '${BLOCK_HEADER}'\nPrompt:\n${prompt}`,
  );
  for (const c of CONSTRAINTS) {
    assert.ok(
      prompt.includes(`- ${c}`),
      `prompt should list constraint as a '- ' bullet: '${c}'\nPrompt:\n${prompt}`,
    );
  }

  const missionPlanIdx = prompt.indexOf(MISSION_PLAN_HEADER);
  const blockIdx = prompt.indexOf(BLOCK_HEADER);
  const exploreIdx = prompt.indexOf(EXPLORE_LINE);

  assert.ok(missionPlanIdx !== -1, `prompt should contain the mission-plan section '${MISSION_PLAN_HEADER}'`);
  assert.ok(exploreIdx !== -1, `prompt should contain the final line '${EXPLORE_LINE}'`);
  assert.ok(
    missionPlanIdx < blockIdx,
    `block should appear AFTER the mission-plan section (missionPlanIdx=${missionPlanIdx}, blockIdx=${blockIdx})`,
  );
  assert.ok(
    blockIdx < exploreIdx,
    `block should appear BEFORE the '${EXPLORE_LINE}' line (blockIdx=${blockIdx}, exploreIdx=${exploreIdx})`,
  );
});

// ── TC2: buildMissionUserPrompt absent/empty/all-non-string → byte-identical ──

await test('TC2: buildMissionUserPrompt with empty / undefined / all-non-string third arg is byte-identical to the two-argument call', async () => {
  const twoArg = buildMissionUserPrompt('001-001', 'The mission plan text');

  const emptyArray = buildMissionUserPrompt('001-001', 'The mission plan text', []);
  const explicitUndefined = buildMissionUserPrompt('001-001', 'The mission plan text', undefined);
  const allNonString = buildMissionUserPrompt('001-001', 'The mission plan text', [123, null, {}, false]);

  assert.strictEqual(emptyArray, twoArg, 'empty-array third arg must be byte-identical to the two-arg call');
  assert.strictEqual(explicitUndefined, twoArg, 'undefined third arg must be byte-identical to the two-arg call');
  assert.strictEqual(allNonString, twoArg, 'all-non-string third arg must be byte-identical to the two-arg call');

  // The two-arg baseline must genuinely lack the block (guards against a
  // tautology where the block is always present).
  assert.ok(
    !twoArg.includes(BLOCK_HEADER),
    `two-argument output should NOT contain the block header '${BLOCK_HEADER}'`,
  );
});

// ── TC2b: buildMissionUserPrompt mixed array → strings kept, non-strings dropped ──

await test('TC2b: buildMissionUserPrompt with a mixed [string, non-string, string] array renders both strings as bullets and drops the non-string', async () => {
  const mixed = buildMissionUserPrompt('001-001', 'The mission plan text', [CONSTRAINTS[0], 123, CONSTRAINTS[1]]);

  assert.ok(
    mixed.includes(BLOCK_HEADER),
    `mixed-array prompt should still contain the block header '${BLOCK_HEADER}' (it has string entries)\nPrompt:\n${mixed}`,
  );
  assert.ok(
    mixed.includes(`- ${CONSTRAINTS[0]}`),
    `mixed-array prompt should render the first string as a bullet: '${CONSTRAINTS[0]}'`,
  );
  assert.ok(
    mixed.includes(`- ${CONSTRAINTS[1]}`),
    `mixed-array prompt should render the second string as a bullet: '${CONSTRAINTS[1]}'`,
  );
  assert.ok(
    !mixed.includes('- 123'),
    `mixed-array prompt should NOT render the non-string entry (123) as a bullet\nPrompt:\n${mixed}`,
  );
});

// ── TC3: planMission forwards context.specConstraints into the turn prompt ──

await test('TC3: planMission with context.specConstraints injects the block + constraint texts into the reusable turn prompt', async () => {
  const capturedTurnPrompts = [];
  const planner = new Planner(
    makeFakeReusableSessionManager(capturedTurnPrompts),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner.planMission('001-001', '/fake/root', {
    missionPlan: 'The mission plan text',
    specConstraints: CONSTRAINTS,
  });

  assert.equal(capturedTurnPrompts.length, 1, 'sendPrompt() should have been called exactly once');
  const turnPrompt = capturedTurnPrompts[0];

  assert.ok(
    turnPrompt.includes(BLOCK_HEADER),
    `turn prompt should contain the block header '${BLOCK_HEADER}'\nPrompt:\n${turnPrompt}`,
  );
  for (const c of CONSTRAINTS) {
    assert.ok(
      turnPrompt.includes(c),
      `turn prompt should contain the constraint text: '${c}'\nPrompt:\n${turnPrompt}`,
    );
  }
});

// ── TC4: planMission without specConstraints → header absent ──

await test('TC4: planMission without context.specConstraints omits the block header from the turn prompt', async () => {
  const capturedTurnPrompts = [];
  const planner = new Planner(
    makeFakeReusableSessionManager(capturedTurnPrompts),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner.planMission('001-001', '/fake/root', {
    missionPlan: 'The mission plan text',
  });

  assert.equal(capturedTurnPrompts.length, 1, 'sendPrompt() should have been called exactly once');
  const turnPrompt = capturedTurnPrompts[0];

  assert.ok(
    !turnPrompt.includes(BLOCK_HEADER),
    `turn prompt should NOT contain the block header '${BLOCK_HEADER}' when no constraints are supplied\nPrompt:\n${turnPrompt}`,
  );
});

// ── TC5: planGlobal → block in USER prompt only, never in SYSTEM prompt ──

await test('TC5: planGlobal with opts.specConstraints puts the block in the USER prompt and NOT in the SYSTEM prompt', async () => {
  const capturedSystem = [];
  const capturedUser = [];
  const planner = new Planner(
    makeFakeGlobalSessionManager(capturedSystem, capturedUser),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );

  await planner.planGlobal('test goal', '/fake/root', { specConstraints: CONSTRAINTS });

  assert.equal(capturedUser.length, 1, 'spawn() should have been called exactly once (user prompt)');
  assert.equal(capturedSystem.length, 1, 'spawn() should have been called exactly once (system prompt)');
  const userPrompt = capturedUser[0];
  const systemPrompt = capturedSystem[0];

  assert.ok(
    userPrompt.includes(BLOCK_HEADER),
    `USER prompt should contain the block header '${BLOCK_HEADER}'\nPrompt:\n${userPrompt}`,
  );
  for (const c of CONSTRAINTS) {
    // Each constraint must render as a "- " bullet line (not merely appear
    // somewhere in the prompt).
    assert.ok(
      userPrompt.includes(`- ${c}`),
      `USER prompt should render constraint as a '- ' bullet: '${c}'\nPrompt:\n${userPrompt}`,
    );
  }

  assert.ok(
    !systemPrompt.includes(BLOCK_HEADER),
    `SYSTEM prompt should NOT contain the block header '${BLOCK_HEADER}'`,
  );
  for (const c of CONSTRAINTS) {
    assert.ok(
      !systemPrompt.includes(c),
      `SYSTEM prompt should NOT contain the constraint text: '${c}'`,
    );
  }
});

// ── TC6: planGlobal without specConstraints → user prompt lacks header ──

await test('TC6: planGlobal without opts.specConstraints omits the block header, and its user prompt is byte-identical to the empty-array call', async () => {
  const absentUser = [];
  const absentPlanner = new Planner(
    makeFakeGlobalSessionManager([], absentUser),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );
  await absentPlanner.planGlobal('test goal', '/fake/root');

  const emptyUser = [];
  const emptyPlanner = new Planner(
    makeFakeGlobalSessionManager([], emptyUser),
    makeFakeLogger(),
    { recordSession: async () => {} },
  );
  await emptyPlanner.planGlobal('test goal', '/fake/root', { specConstraints: [] });

  assert.equal(absentUser.length, 1, 'spawn() should have been called exactly once (absent)');
  assert.equal(emptyUser.length, 1, 'spawn() should have been called exactly once (empty array)');

  assert.ok(
    !absentUser[0].includes(BLOCK_HEADER),
    `USER prompt should NOT contain the block header '${BLOCK_HEADER}' when no constraints are supplied\nPrompt:\n${absentUser[0]}`,
  );
  // Absent vs empty-array must be indistinguishable at the byte level — the
  // same byte-identity guarantee TC2 enforces on the mission side.
  assert.strictEqual(
    absentUser[0],
    emptyUser[0],
    'planGlobal user prompt with specConstraints absent must be byte-identical to the specConstraints: [] call',
  );
});

// ── TC7: Pipeline wires _getSpecConstraints() into its planGlobal calls ──

await test('TC7: pipeline wires specConstraints: this._getSpecConstraints() at BOTH planGlobal call-sites (>=3 total occurrences)', async () => {
  const fs = await import('fs');
  const url = await import('url');
  const pathMod = await import('path');
  const __dirname = pathMod.dirname(url.fileURLToPath(import.meta.url));
  const pipelineSrc = fs.readFileSync(
    pathMod.resolve(__dirname, '../src/orchestrator/core/pipeline.js'),
    'utf8',
  );

  // Occurrence count is the load-bearing signal, not mere presence:
  //   - 1 occurrence is PRE-EXISTING wiring on the planMission remediation
  //     call-site (survives at HEAD, so presence alone protects nothing).
  //   - This delivery adds the constraint arg to the TWO planGlobal
  //     invocations (the fresh-run path and the resume path).
  // Requiring >= 3 fails against unmodified HEAD (which has exactly 1) and so
  // genuinely depends on the delivery under test.
  const occurrences = pipelineSrc.match(/specConstraints:\s*this\._getSpecConstraints\(\)/g) || [];
  assert.ok(
    occurrences.length >= 3,
    `pipeline.js must pass 'specConstraints: this._getSpecConstraints()' at both planGlobal call-sites ` +
    `plus the pre-existing planMission site (>= 3 occurrences); found ${occurrences.length}`,
  );
});

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
