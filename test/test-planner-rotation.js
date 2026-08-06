#!/usr/bin/env node
/**
 * test-planner-rotation.js — Unit tests for the reusable planner session's
 * mission-boundary rotation logic (K trigger, forceNew trigger, warn/alarm
 * tiers, prior-mission digest injection, fresh-run parity, the ledger drain
 * pipeline.js performs on drainRotationEvents(), and the non-cumulative
 * session-size metric).
 *
 * All planner interactions are stubbed — no live SDK. See test-planner-reuse.js
 * for the sibling suite covering ReusableSession/PromptStream mechanics; this
 * file does not import from it.
 *
 * Run: node test/test-planner-rotation.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Planner } from '../src/orchestrator/agents/planner.js';
import { buildMissionUserPrompt } from '../src/orchestrator/agents/planner-prompts.js';
import config from '../src/orchestrator/infra/config.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';

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

// ── Fake collaborators ──────────────────────────────────────────────────────

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function makeFakeLogger() {
  return {
    createSessionLog: (name) => ({ logPath: `/tmp/${name}.jsonl`, write: () => {}, close: () => {} }),
    attachToSession: () => {},
    writeSessionSummary: () => {},
    warn: () => {},
  };
}

/**
 * A fake session manager whose spawnReusable() records every options object
 * it was called with (so tests can assert on the `name` argument), and
 * whose spawned sessions pull their sendPrompt() usage from a SHARED, FIFO
 * queue on the manager. Since every planMission call in these tests results
 * in exactly one sendPrompt (no plan-lint retries — the fake plans are
 * always empty/valid), the queue order matches the planMission call order
 * one-to-one regardless of which session (pre- or post-rotation) services
 * the call. Entries left unset default to ZERO_USAGE (no rotation signal).
 */
function makeFakeSessionManager() {
  const sessions = [];
  const spawnOptions = [];
  const usageQueue = [];

  function spawnReusable(options) {
    spawnOptions.push(options);
    const session = {
      name: options.name,
      turnCount: 0,
      closed: false,
      prompts: [],
      handle: { systemPromptTokens: 0, _toolCallCount: 0 },
      async sendPrompt(prompt) {
        // Real ReusableSession increments turnCount synchronously at call
        // entry (see test-planner-reuse.js's "turnCount increments per
        // send" case) — mirror that here.
        session.turnCount += 1;
        session.prompts.push(prompt);
        const usage = usageQueue.length > 0 ? usageQueue.shift() : ZERO_USAGE;
        return {
          type: 'result',
          structured_output: { subMissions: [] },
          usage,
          total_cost_usd: 0.01,
        };
      },
      async close() {
        session.closed = true;
      },
    };
    sessions.push(session);
    return session;
  }

  return { sessions, spawnOptions, usageQueue, spawnReusable };
}

function makeFakeTokenTracker() {
  const recorded = [];
  return {
    recorded,
    recordSession: async (name, role, result, meta) => {
      recorded.push({ name, role, meta });
    },
    shouldWarn: (t) => t >= config.tokens.warn,
    shouldForceNewSession: (t) => t >= config.tokens.forceNew,
    shouldAlarm: (t) => t >= config.tokens.alarm,
  };
}

function usageSumming(total) {
  return { input_tokens: total, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

// ── TC1: K trigger — 4th planMission call rotates on missionCount ─────────

await test('TC1: 4th planMission on one session closes it and spawns planner-reusable-2', async () => {
  const sessionManager = makeFakeSessionManager();
  const tokenTracker = makeFakeTokenTracker();
  const planner = new Planner(sessionManager, makeFakeLogger(), tokenTracker);

  for (let i = 0; i < config.tokens.rotationMissionCount; i++) {
    await planner.planMission(`001-00${i + 1}`, '/fake/root', { missionPlan: 'plan' });
  }
  assert.equal(sessionManager.sessions.length, 1, 'first 3 missions should share one session');
  assert.equal(sessionManager.sessions[0].closed, false);

  await planner.planMission('001-004', '/fake/root', { missionPlan: 'plan' });

  assert.equal(sessionManager.sessions.length, 2, 'the 4th planMission should have spawned a new session');
  assert.equal(sessionManager.sessions[0].closed, true, 'the prior session must have been closed');
  assert.equal(sessionManager.spawnOptions[1].name, 'planner-reusable-2',
    `expected the 2nd spawn's name to be exactly 'planner-reusable-2', got '${sessionManager.spawnOptions[1].name}'`);
});

// ── TC2: forceNew trigger — context tokens >= 100000 rotate even with missionCount < K ──

await test('TC2: forceNew rotates on context tokens >= 100000 with missionCount below the K threshold', async () => {
  const sessionManager = makeFakeSessionManager();
  const tokenTracker = makeFakeTokenTracker();
  const planner = new Planner(sessionManager, makeFakeLogger(), tokenTracker);

  sessionManager.usageQueue.push(usageSumming(config.tokens.forceNew)); // turn 1: exactly at the forceNew boundary
  await planner.planMission('001-001', '/fake/root', { missionPlan: 'plan' });
  assert.ok(planner._sessionMissionCount < config.tokens.rotationMissionCount,
    'precondition: missionCount must be below the K threshold');

  sessionManager.usageQueue.push(ZERO_USAGE); // turn 2 (post-rotation session)
  await planner.planMission('001-002', '/fake/root', { missionPlan: 'plan' });

  const events = planner.drainRotationEvents();
  const rotated = events.find((e) => e.type === 'rotated');
  assert.ok(rotated, `expected a 'rotated' event, got: ${JSON.stringify(events)}`);
  assert.equal(sessionManager.sessions.length, 2, 'forceNew should have spawned a new session');
});

// ── TC3: warn tier — [80000, 100000) with missionCount < K warns but does NOT rotate ──

await test('TC3: warn tier ([80000,100000)) drains a warn event and spawns no new session', async () => {
  const sessionManager = makeFakeSessionManager();
  const tokenTracker = makeFakeTokenTracker();
  const planner = new Planner(sessionManager, makeFakeLogger(), tokenTracker);

  const warnUsage = config.tokens.warn + 1000;
  assert.ok(warnUsage < config.tokens.forceNew, 'fixture invariant: warn usage must stay below forceNew');
  sessionManager.usageQueue.push(usageSumming(warnUsage));
  await planner.planMission('001-001', '/fake/root', { missionPlan: 'plan' });
  assert.ok(planner._sessionMissionCount < config.tokens.rotationMissionCount,
    'precondition: missionCount must be below the K threshold');

  sessionManager.usageQueue.push(ZERO_USAGE);
  await planner.planMission('001-002', '/fake/root', { missionPlan: 'plan' });

  const events = planner.drainRotationEvents();
  const warn = events.find((e) => e.type === 'warn');
  assert.ok(warn, `expected a 'warn' event, got: ${JSON.stringify(events)}`);
  assert.ok(!events.some((e) => e.type === 'rotated'), 'warn tier alone must not rotate');
  assert.equal(sessionManager.sessions.length, 1, 'no new session should have been spawned');
});

// ── TC4: alarm tier — >= 120000 drains an alarm event ──────────────────────

await test('TC4: alarm tier (>= 120000) drains an alarm event', async () => {
  const sessionManager = makeFakeSessionManager();
  const tokenTracker = makeFakeTokenTracker();
  const planner = new Planner(sessionManager, makeFakeLogger(), tokenTracker);

  sessionManager.usageQueue.push(usageSumming(config.tokens.alarm));
  await planner.planMission('001-001', '/fake/root', { missionPlan: 'plan' });

  sessionManager.usageQueue.push(ZERO_USAGE);
  await planner.planMission('001-002', '/fake/root', { missionPlan: 'plan' });

  const events = planner.drainRotationEvents();
  const alarm = events.find((e) => e.type === 'alarm');
  assert.ok(alarm, `expected an 'alarm' event, got: ${JSON.stringify(events)}`);
});

// ── TC5: digest injection — only the first prompt of a post-rotation session carries it ──

await test('TC5: post-rotation first prompt carries the prior-mission digest block; later prompts do not', async () => {
  const sessionManager = makeFakeSessionManager();
  const tokenTracker = makeFakeTokenTracker();
  const planner = new Planner(sessionManager, makeFakeLogger(), tokenTracker);

  // Fill the first session up to the K-trigger threshold with plain
  // (digest-free) missions, so the NEXT call rotates onto a fresh session.
  for (let i = 0; i < config.tokens.rotationMissionCount; i++) {
    await planner.planMission(`001-00${i + 1}`, '/fake/root', { missionPlan: 'plan' });
  }
  assert.equal(sessionManager.sessions.length, 1, 'precondition: still on the first session');

  const priorMissionDigest =
    'Mission 001-001: implement the widget\n' +
    '  Task 001-001-001-001: build the widget core [target: src/widget-core.js]\n';
  const context = { missionPlan: 'plan for 001-004', priorMissionDigest };

  // This call rotates (missionCount === K) onto a brand-new session; its
  // first turn is where the digest must be injected.
  await planner.planMission('001-004', '/fake/root', context);
  assert.equal(sessionManager.sessions.length, 2, 'this call should have rotated onto a new session');

  // A second call on the SAME (now-used) post-rotation session must not
  // carry the digest header again.
  await planner.planMission('001-005', '/fake/root', context);
  assert.equal(sessionManager.sessions.length, 2, 'no further rotation expected');

  const [firstPrompt, secondPrompt] = sessionManager.sessions[1].prompts;

  assert.match(firstPrompt, /Previously planned missions \(binding context\)/);
  assert.ok(firstPrompt.includes('001-001'), 'first prompt should include the prior mission id');
  assert.ok(firstPrompt.includes('001-001-001-001'), 'first prompt should include the prior task id');
  assert.ok(firstPrompt.includes('src/widget-core.js'), 'first prompt should include the prior targetFile');

  assert.ok(!secondPrompt.includes('Previously planned missions (binding context)'),
    'a prompt sent on an already-used session must NOT carry the digest header');
});

// ── TC6: fresh-run parity — empty digest, byte-identical first prompt, session name ──

await test('TC6: fresh run (empty digest) uses session name planner-reusable and an unmodified first prompt', async () => {
  const sessionManager = makeFakeSessionManager();
  const tokenTracker = makeFakeTokenTracker();
  const planner = new Planner(sessionManager, makeFakeLogger(), tokenTracker);

  const context = { missionPlan: 'plan for 001-001' };
  await planner.planMission('001-001', '/fake/root', context);

  assert.equal(sessionManager.spawnOptions[0].name, 'planner-reusable',
    `expected the first spawn's name to be exactly 'planner-reusable', got '${sessionManager.spawnOptions[0].name}'`);

  const expectedPrompt = buildMissionUserPrompt('001-001', context.missionPlan, context.specConstraints);
  assert.strictEqual(sessionManager.sessions[0].prompts[0], expectedPrompt);
});

// ── TC7: ledger drain — pipeline appends warnings-ledger rows for drained rotation events ──

function createMinimalHarness() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-rotation-'));
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'plan'), { recursive: true });

  const state = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      '001': {
        id: '001',
        description: 'milestone 001',
        status: 'in_progress',
        missions: {
          '001-001': {
            id: '001-001',
            description: 'mission 001-001',
            status: 'pending',
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));
  return { projectRoot, harnessDir };
}

function makeMissionDecomp() {
  return {
    subMissions: [
      {
        id: '001-001-001',
        description: 'sub-mission',
        tasks: [
          {
            id: '001-001-001-001',
            description: 'planned task',
            targetFiles: ['test/test-x.js'],
            dependencies: [],
            testCases: [],
            tracesScenario: [],
            patternReferences: [],
            dataSchemas: [],
          },
        ],
      },
    ],
  };
}

function teardownPipeline(pipeline) {
  const h = pipeline._signalHandlers || {};
  if (h.SIGINT) process.removeListener('SIGINT', h.SIGINT);
  if (h.SIGTERM) process.removeListener('SIGTERM', h.SIGTERM);
  if (h.exit) process.removeListener('exit', h.exit);
  if (h.uncaughtException) process.removeListener('uncaughtException', h.uncaughtException);
  if (pipeline.statusBar && typeof pipeline.statusBar.destroy === 'function') {
    try { pipeline.statusBar.destroy(); } catch { /* ignore */ }
  }
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

await test('TC7: drainRotationEvents() rows land in archives/warnings.jsonl under category planner-rotation', async () => {
  const { projectRoot, harnessDir } = createMinimalHarness();
  const pipeline = new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    statusBar: false,
    onLog: () => {},
    onConfirm: async () => true,
    noReview: true,
    skipReview: true,
  });
  pipeline._currentMsId = '001';
  pipeline._currentMsState = { missions: { '001-001': { id: '001-001' } } };
  pipeline._msStartTime = Date.now();

  const decomp = makeMissionDecomp();
  pipeline.planner.planMission = async () => JSON.parse(JSON.stringify(decomp));
  pipeline.planner.closeReusableSession = async () => {};

  const rotationEvents = [
    { type: 'rotated', sessionName: 'planner-reusable', missionId: '001-001', contextTokens: 105000, missionCount: 2 },
    { type: 'rotated', sessionName: 'planner-reusable', missionId: '001-001', contextTokens: 110000, missionCount: 2 },
  ];
  pipeline.planner.drainRotationEvents = () => rotationEvents;

  try {
    await pipeline._planAndApproveMission('001-001', { description: 'mission 001-001', status: 'pending' });

    const ledgerPath = path.join(projectRoot, 'archives', 'warnings.jsonl');
    assert.ok(fs.existsSync(ledgerPath), 'archives/warnings.jsonl must have been written');
    const rows = fs.readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .filter((r) => r.category === 'planner-rotation');

    assert.equal(rows.length, 2, `expected 2 planner-rotation rows, got ${rows.length}: ${JSON.stringify(rows)}`);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const ev = rotationEvents[i];
      assert.ok(row.description.includes(String(ev.missionId)), `row ${i} description should include missionId`);
      assert.ok(row.description.includes(String(ev.contextTokens)), `row ${i} description should include contextTokens`);
      assert.ok(row.description.includes(String(ev.missionCount)), `row ${i} description should include missionCount`);
    }
    assert.notEqual(rows[0].hash, rows[1].hash,
      'rows differing only by contextTokens must have distinct hashes');
  } finally {
    teardownPipeline(pipeline);
    cleanup(projectRoot);
  }
});

// ── TC8: non-cumulative metric — 3 turns of 30000 each stay at 30000, not 90000 ──

await test('TC8: session-size metric is the LAST turn usage, not a cumulative sum across turns', async () => {
  const sessionManager = makeFakeSessionManager();
  const tokenTracker = makeFakeTokenTracker();
  const planner = new Planner(sessionManager, makeFakeLogger(), tokenTracker);

  const perTurnUsage = usageSumming(30000);
  sessionManager.usageQueue.push(perTurnUsage, perTurnUsage, perTurnUsage);

  await planner.planMission('001-001', '/fake/root', { missionPlan: 'plan' });
  await planner.planMission('001-002', '/fake/root', { missionPlan: 'plan' });
  await planner.planMission('001-003', '/fake/root', { missionPlan: 'plan' });

  assert.equal(planner._sessionContextTokens, 30000,
    `expected the tracked session size to be 30000 (last turn only), got ${planner._sessionContextTokens}`);
  assert.equal(sessionManager.sessions.length, 1, 'all 3 missions should have stayed on one session (no rotation trigger)');
});

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
