/**
 * test-enforce-sequential-ordering.js — Unit tests for Planner._enforceSequentialOrdering.
 *
 * Tests:
 *   1. _enforceSequentialOrdering exists as a method on Planner.prototype
 *   2. For a plan with ordering:'sequential' and 3 tasks, tasks[1] gets hard dep on tasks[0],
 *      tasks[2] gets hard dep on tasks[1]
 *   3. Already-existing deps are not duplicated (idempotent)
 *   4. Errors inside _enforceSequentialOrdering are swallowed (try/catch)
 *   6. Call appears after _warnIfVagueDescriptions in _planMissionReusable
 *
 * Run: node test/test-enforce-sequential-ordering.js
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { Planner } from '../src/orchestrator/agents/planner.js';

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

// ── TC-1: method exists on Planner.prototype ─────────────────────────────────

await test('TC-1: _enforceSequentialOrdering exists on Planner.prototype', async () => {
  assert.strictEqual(
    typeof Planner.prototype._enforceSequentialOrdering,
    'function',
    '_enforceSequentialOrdering should be a function on Planner.prototype',
  );
});

// ── TC-2: synthesizes hard-dep chain for sequential sub-missions ─────────────

await test('TC-2: sequential ordering adds hard dep chain for 3-task sub-mission', async () => {
  // Create a Planner instance with minimal fakes (no SDK calls needed)
  const planner = new Planner(
    { spawn: () => {} },
    { warn: () => {}, createSessionLog: () => ({}) },
    {},
  );

  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        ordering: 'sequential',
        tasks: [
          { id: 't-001', description: 'First task', targetFiles: [], dependencies: [] },
          { id: 't-002', description: 'Second task', targetFiles: [], dependencies: [] },
          { id: 't-003', description: 'Third task', targetFiles: [], dependencies: [] },
        ],
      },
    ],
  };

  planner._enforceSequentialOrdering(plan);

  const tasks = plan.subMissions[0].tasks;

  // tasks[0] should have no new deps added (it's the first)
  assert.strictEqual(tasks[0].dependencies.length, 0, 'tasks[0] should have no deps added');

  // tasks[1] should have a hard dep on tasks[0]
  assert.ok(
    tasks[1].dependencies.some((d) => d.taskId === 't-001' && d.type === 'hard'),
    'tasks[1] should have a hard dep on tasks[0] (t-001)',
  );

  // tasks[2] should have a hard dep on tasks[1]
  assert.ok(
    tasks[2].dependencies.some((d) => d.taskId === 't-002' && d.type === 'hard'),
    'tasks[2] should have a hard dep on tasks[1] (t-002)',
  );
});

// ── TC-3: idempotent — existing deps are not duplicated ──────────────────────

await test('TC-3: already-existing hard deps are not duplicated (idempotent)', async () => {
  const planner = new Planner(
    { spawn: () => {} },
    { warn: () => {}, createSessionLog: () => ({}) },
    {},
  );

  const plan = {
    subMissions: [
      {
        id: 'sm-001',
        ordering: 'sequential',
        tasks: [
          { id: 't-001', description: 'First task', targetFiles: [], dependencies: [] },
          {
            id: 't-002',
            description: 'Second task',
            targetFiles: [],
            // Pre-existing hard dep on t-001
            dependencies: [{ taskId: 't-001', type: 'hard' }],
          },
        ],
      },
    ],
  };

  // Call twice to verify idempotence
  planner._enforceSequentialOrdering(plan);
  planner._enforceSequentialOrdering(plan);

  const deps = plan.subMissions[0].tasks[1].dependencies.filter(
    (d) => d.taskId === 't-001' && d.type === 'hard',
  );
  assert.strictEqual(deps.length, 1, 'Should have exactly 1 hard dep on t-001, not duplicated');
});

// ── TC-4: errors inside _enforceSequentialOrdering are swallowed ─────────────

await test('TC-4: errors inside _enforceSequentialOrdering are swallowed silently', async () => {
  const planner = new Planner(
    { spawn: () => {} },
    { warn: () => {}, createSessionLog: () => ({}) },
    {},
  );

  // Pass a plan that will cause an internal error (tasks is not an array,
  // but a getter that throws)
  const evilPlan = {
    subMissions: [
      {
        ordering: 'sequential',
        get tasks() {
          throw new Error('intentional error for test');
        },
      },
    ],
  };

  // Should not throw
  assert.doesNotThrow(() => {
    planner._enforceSequentialOrdering(evilPlan);
  }, 'Errors inside _enforceSequentialOrdering should be swallowed');
});

// ── TC-6: call wired in _planMissionReusable after _warnIfVagueDescriptions ───

await test('TC-6: _enforceSequentialOrdering is called after _warnIfVagueDescriptions in _planMissionReusable', async () => {
  const src = readFileSync(
    new URL('../src/orchestrator/agents/planner.js', import.meta.url),
    'utf8',
  );

  // Find the _planMissionReusable function body
  const reusableMatch = src.match(
    /async _planMissionReusable[\s\S]*?(?=\n  (?:async )?[a-zA-Z_]|\n  \/\*\*)/,
  );
  assert.ok(reusableMatch, '_planMissionReusable method should exist in source');

  const body = reusableMatch[0];

  const warnIdx = body.indexOf('_warnIfVagueDescriptions');
  const enforceIdx = body.indexOf('_enforceSequentialOrdering');

  assert.ok(warnIdx !== -1, '_warnIfVagueDescriptions should appear in _planMissionReusable');
  assert.ok(enforceIdx !== -1, '_enforceSequentialOrdering should appear in _planMissionReusable');
  assert.ok(
    enforceIdx > warnIdx,
    '_enforceSequentialOrdering should appear AFTER _warnIfVagueDescriptions in _planMissionReusable',
  );
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
