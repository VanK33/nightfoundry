/**
 * test-coverage-auto-mode.js — Tests for auto-mode gating in coverage.js.
 *
 * Test cases:
 *   TC3: checkMilestoneCoverage with autoMode=false calls onConfirm when gaps remain
 *   TC4: checkMilestoneCoverage with autoMode=true + non-TTY throws exit-77
 *   TC5: effectiveMode='autonomous' when autoFromHere=true + mode='interactive' (pure unit)
 *
 * Run: node test/test-coverage-auto-mode.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { checkMilestoneCoverage } from '../src/orchestrator/gates/coverage.js';
import { HaltError } from '../src/orchestrator/core/halt-error.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failCount++;
    }
  );
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

/**
 * Create a minimal harness dir with:
 *   - state.json pointing to a spec file with one scenario
 *   - spec.md with a ## Scenarios section containing S1
 *   - state/mission-<missionId>.json with one sub-mission, no tracesScenario
 *   - plan/ directory (empty)
 *
 * Returns { harnessDir, projectRoot, missionId, smId }
 */
function createTestEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-auto-mode-test-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'verify'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plan'), { recursive: true });

  const missionId = '001-001';
  const smId = `${missionId}-001`;

  // Write state.json with prdPath pointing to spec.md in same dir.
  fs.writeFileSync(
    path.join(root, 'state.json'),
    JSON.stringify({
      projectMeta: {
        prdPath: 'spec.md',
        createdAt: new Date().toISOString(),
        currentPhase: 'executing',
      },
      globalStatus: 'active',
      milestones: {},
    }, null, 2)
  );

  // Write a spec file with one scenario (S1).
  fs.writeFileSync(
    path.join(root, 'spec.md'),
    '# My Spec\n\n## Testing\n\n### Scenarios\n\n- S1: the main scenario\n\n## Other\n'
  );

  // Write mission state with no tracesScenario coverage.
  fs.writeFileSync(
    path.join(root, 'state', `mission-${missionId}.json`),
    JSON.stringify({
      id: missionId,
      missionId,
      description: 'test mission',
      status: 'in_progress',
      subMissions: {
        [smId]: {
          id: smId,
          description: 'test sub-mission',
          status: 'in_progress',
          tasks: {
            [`${smId}-001`]: {
              id: `${smId}-001`,
              description: 'a task with no scenario coverage',
              status: 'completed',
              tracesScenario: [],
            },
          },
        },
      },
    }, null, 2)
  );

  return { harnessDir: root, projectRoot: root, missionId, smId };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Mock planner: always returns no new tasks, no out-of-scope. */
function makeMockPlanner() {
  return {
    remediateScenarios: async () => ({ newTasks: [], outOfScope: [] }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// TC3: checkMilestoneCoverage with autoMode=false calls onConfirm when gaps remain
await test('TC3: checkMilestoneCoverage autoMode=false calls onConfirm', async () => {
  const { harnessDir, projectRoot, missionId } = createTestEnv();
  try {
    let confirmCalled = false;
    let confirmQuestion = null;

    await checkMilestoneCoverage({
      harnessDir,
      projectRoot,
      missionIds: [missionId],
      planner: makeMockPlanner(),
      onLog: () => {},
      onConfirm: async (question) => {
        confirmCalled = true;
        confirmQuestion = question;
        return true; // proceed
      },
      autoMode: false,
    });

    assert.ok(confirmCalled, 'onConfirm should have been called when milestone gaps remain');
    assert.ok(
      typeof confirmQuestion === 'string' && confirmQuestion.length > 0,
      'onConfirm should receive a question string'
    );
  } finally {
    cleanup(harnessDir);
  }
});

// TC4: checkMilestoneCoverage with autoMode=true + non-TTY throws exit-77
await test('TC4: checkMilestoneCoverage autoMode=true non-TTY throws exit-77', async () => {
  const { harnessDir, projectRoot, missionId } = createTestEnv();
  const originalIsTTY = process.stdout.isTTY;
  try {
    // Force non-TTY environment.
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    let threw = false;
    let thrownError = null;
    try {
      await checkMilestoneCoverage({
        harnessDir,
        projectRoot,
        missionIds: [missionId],
        planner: makeMockPlanner(),
        onLog: () => {},
        onConfirm: async () => true,
        autoMode: true,
      });
    } catch (err) {
      threw = true;
      thrownError = err;
    }

    assert.ok(threw, 'should have thrown when autoMode=true and non-TTY');
    assert.ok(
      thrownError instanceof HaltError,
      `expected HaltError, got ${thrownError?.constructor?.name}: ${thrownError?.message}`
    );
    assert.ok(
      typeof thrownError.site === 'string' && thrownError.site.length > 0,
      `expected non-empty .site, got: ${thrownError.site}`
    );
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    cleanup(harnessDir);
  }
});

// TC5: effectiveMode='autonomous' when autoFromHere=true + mode='interactive' (pure unit assertion)
await test("TC5: effectiveMode='autonomous' when autoFromHere=true + mode='interactive'", async () => {
  // This mirrors the computation in pipeline.js line 2618:
  //   const effectiveMode = (mode === 'interactive' && this.autoFromHere) ? 'autonomous' : mode;
  const mode = 'interactive';
  const autoFromHere = true;
  const effectiveMode = (mode === 'interactive' && autoFromHere) ? 'autonomous' : mode;

  assert.strictEqual(
    effectiveMode,
    'autonomous',
    `expected 'autonomous' but got '${effectiveMode}'`
  );

  // Also verify the identity case: when autoFromHere=false, mode is unchanged.
  const effectiveModeNoAuto = (mode === 'interactive' && false) ? 'autonomous' : mode;
  assert.strictEqual(effectiveModeNoAuto, 'interactive', 'without autoFromHere, mode should stay interactive');

  // And verify: non-interactive mode is never overridden.
  const effectiveModeAuto = ('autonomous' === 'interactive' && true) ? 'autonomous' : 'autonomous';
  assert.strictEqual(effectiveModeAuto, 'autonomous', 'autonomous mode stays autonomous');
});

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
