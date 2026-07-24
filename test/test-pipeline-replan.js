/**
 * test-pipeline-replan.js — Unit tests for the `re_plan` path in Pipeline._dispatchAnalyzer.
 *
 * Tests cover:
 *   TC1. Happy path: analyzer returns re_plan, planner returns tasks, scheduler.replaceTask succeeds → no throw
 *   TC2. Empty replacements: planner returns { replacementTasks: [] } → throws circuit breaker
 *   TC3. Replan cap exceeded: _replanAttempts already at cap → throws circuit breaker
 *   TC4. planner.replanTask throws → falls through to circuit breaker throw
 *   TC5. scheduler.replaceTask throws → falls through to circuit breaker throw
 *   TC6. Non-re_plan recommendation (retry) → existing throw behavior unchanged
 *   TC7. analysis.structured available → verify it is passed to planner.replanTask
 *
 * Run: node test/test-pipeline-replan.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { Scheduler } from '../src/orchestrator/core/scheduler.js';

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

// ── Harness helpers ───────────────────────────────────────────────────────────

/**
 * Create a minimal on-disk harness so Pipeline constructor doesn't crash.
 * Returns { projectRoot, harnessDir }.
 */
function createMinimalHarness() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'replan-unit-'));
  const harnessDir = path.join(projectRoot, '.harness');

  // Directories the Pipeline / Scheduler expect
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'snapshots'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'analysis'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'plan'), { recursive: true });

  // Minimal state.json
  const state = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {},
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(state, null, 2));

  return { projectRoot, harnessDir };
}

/**
 * Build a Pipeline instance with all live agents replaced by no-op mocks.
 * Returns the pipeline plus the harness paths for cleanup.
 */
function makePipeline(projectRoot) {
  const pipeline = new Pipeline(projectRoot, {
    skipWorktreeCreation: true,
    onLog: () => {},
    onConfirm: async () => true,
    noReview: true,
    skipReview: true,
  });
  return pipeline;
}

/**
 * Build a mock Scheduler (duck-typed) that exposes _replanAttempts and a
 * controllable replaceTask. Accepts an optional override for replaceTask.
 */
function makeMockScheduler({ replaceTaskImpl } = {}) {
  const _replanAttempts = new Map();
  return {
    _replanAttempts,
    replaceTask: replaceTaskImpl ?? (async () => {}),
  };
}

/**
 * Build a mock analyzer that resolves with the given analysis object.
 */
function makeMockAnalyzer(analysis) {
  return {
    analyzeFailure: async () => analysis,
  };
}

/**
 * Build a mock planner with a controllable replanTask.
 */
function makeMockPlanner({ replanTaskImpl } = {}) {
  const calls = [];
  return {
    replanTaskCalls: calls,
    replanTask: replanTaskImpl ?? (async (...args) => {
      calls.push(args);
      return { replacementTasks: [] };
    }),
  };
}

// A minimal task object used across all tests
const baseTask = {
  id: '001-001-001-001',
  missionId: '001-001',
  subMissionId: '001-001-001',
  description: 'Test task',
  targetFiles: ['src/a.js'],
};

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ── TC1: Happy path ───────────────────────────────────────────────────────────

await test('TC1: analyzer returns re_plan, planner returns tasks, replaceTask succeeds → no throw', async () => {
  const { projectRoot } = createMinimalHarness();
  try {
    const pipeline = makePipeline(projectRoot);

    const replacementTasks = [
      { id: '001-001-001-001-rp-001', description: 'Replacement task', targetFiles: ['src/a.js'], dependencies: [] },
    ];

    pipeline.analyzer = makeMockAnalyzer({
      eventId: 'evt-001',
      recommendation: 're_plan',
      affectedTasks: [],
      structured: null,
    });

    let replaceTaskCalled = false;
    pipeline.scheduler = makeMockScheduler({
      replaceTaskImpl: async () => { replaceTaskCalled = true; },
    });

    const replanCalls = [];
    pipeline.planner = {
      replanTask: async (...args) => {
        replanCalls.push(args);
        return { replacementTasks };
      },
    };

    // Should return without throwing
    await pipeline._dispatchAnalyzer(baseTask, 'execution', 2);

    assert.ok(replaceTaskCalled, 'scheduler.replaceTask should have been called');
    assert.equal(replanCalls.length, 1, 'planner.replanTask should have been called once');
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC2: Empty replacements → circuit breaker ─────────────────────────────────

await test('TC2: planner returns empty replacementTasks → throws circuit breaker', async () => {
  const { projectRoot } = createMinimalHarness();
  try {
    const pipeline = makePipeline(projectRoot);

    pipeline.analyzer = makeMockAnalyzer({
      eventId: 'evt-002',
      recommendation: 're_plan',
      affectedTasks: [],
      structured: null,
    });

    pipeline.scheduler = makeMockScheduler();

    pipeline.planner = {
      replanTask: async () => ({ replacementTasks: [] }),
    };

    let threw = false;
    let errMsg = '';
    try {
      await pipeline._dispatchAnalyzer(baseTask, 'execution', 2);
    } catch (err) {
      threw = true;
      errMsg = err.message;
    }

    assert.ok(threw, 'Should have thrown');
    assert.ok(
      errMsg.startsWith('Circuit breaker:'),
      `Expected circuit breaker error, got: "${errMsg}"`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC3: Replan cap exceeded → circuit breaker ────────────────────────────────

await test('TC3: _replanAttempts already at cap → throws circuit breaker immediately', async () => {
  const { projectRoot } = createMinimalHarness();
  try {
    const pipeline = makePipeline(projectRoot);

    pipeline.analyzer = makeMockAnalyzer({
      eventId: 'evt-003',
      recommendation: 're_plan',
      affectedTasks: [],
      structured: null,
    });

    const mockScheduler = makeMockScheduler();
    // Set attempts to cap so the guard fires
    const cap = Scheduler.MAX_REPLAN_ATTEMPTS;
    mockScheduler._replanAttempts.set(baseTask.id, cap);
    pipeline.scheduler = mockScheduler;

    let replanCalled = false;
    pipeline.planner = {
      replanTask: async () => {
        replanCalled = true;
        return { replacementTasks: [{ id: 'rp-x', description: 'd', targetFiles: [], dependencies: [] }] };
      },
    };

    let threw = false;
    let errMsg = '';
    try {
      await pipeline._dispatchAnalyzer(baseTask, 'execution', 2);
    } catch (err) {
      threw = true;
      errMsg = err.message;
    }

    assert.ok(threw, 'Should have thrown');
    assert.ok(
      errMsg.startsWith('Circuit breaker:'),
      `Expected circuit breaker error, got: "${errMsg}"`,
    );
    assert.ok(!replanCalled, 'planner.replanTask should NOT be called when cap is exceeded');
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC4: planner.replanTask throws → circuit breaker ─────────────────────────

await test('TC4: planner.replanTask throws → falls through to circuit breaker', async () => {
  const { projectRoot } = createMinimalHarness();
  try {
    const pipeline = makePipeline(projectRoot);

    pipeline.analyzer = makeMockAnalyzer({
      eventId: 'evt-004',
      recommendation: 're_plan',
      affectedTasks: [],
      structured: null,
    });

    pipeline.scheduler = makeMockScheduler();

    pipeline.planner = {
      replanTask: async () => {
        throw new Error('planner internal error');
      },
    };

    let threw = false;
    let errMsg = '';
    try {
      await pipeline._dispatchAnalyzer(baseTask, 'execution', 2);
    } catch (err) {
      threw = true;
      errMsg = err.message;
    }

    assert.ok(threw, 'Should have thrown');
    assert.ok(
      errMsg.startsWith('Circuit breaker:'),
      `Expected circuit breaker error, got: "${errMsg}"`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC5: scheduler.replaceTask throws → circuit breaker ──────────────────────

await test('TC5: scheduler.replaceTask throws → falls through to circuit breaker', async () => {
  const { projectRoot } = createMinimalHarness();
  try {
    const pipeline = makePipeline(projectRoot);

    pipeline.analyzer = makeMockAnalyzer({
      eventId: 'evt-005',
      recommendation: 're_plan',
      affectedTasks: [],
      structured: null,
    });

    pipeline.scheduler = makeMockScheduler({
      replaceTaskImpl: async () => {
        throw new Error('scheduler internal error');
      },
    });

    const replacementTasks = [
      { id: '001-001-001-001-rp-001', description: 'Replacement', targetFiles: ['src/a.js'], dependencies: [] },
    ];
    pipeline.planner = {
      replanTask: async () => ({ replacementTasks }),
    };

    let threw = false;
    let errMsg = '';
    try {
      await pipeline._dispatchAnalyzer(baseTask, 'execution', 2);
    } catch (err) {
      threw = true;
      errMsg = err.message;
    }

    assert.ok(threw, 'Should have thrown');
    assert.ok(
      errMsg.startsWith('Circuit breaker:'),
      `Expected circuit breaker error, got: "${errMsg}"`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC6: Non-re_plan recommendation → existing throw behavior ────────────────

await test('TC6: analyzer returns "retry" recommendation → throws circuit breaker (non-re_plan path)', async () => {
  const { projectRoot } = createMinimalHarness();
  try {
    const pipeline = makePipeline(projectRoot);

    pipeline.analyzer = makeMockAnalyzer({
      eventId: 'evt-006',
      recommendation: 'retry',
      affectedTasks: [],
      structured: null,
    });

    pipeline.scheduler = makeMockScheduler();

    let replanCalled = false;
    pipeline.planner = {
      replanTask: async () => {
        replanCalled = true;
        return { replacementTasks: [] };
      },
    };

    let threw = false;
    let errMsg = '';
    try {
      await pipeline._dispatchAnalyzer(baseTask, 'execution', 2);
    } catch (err) {
      threw = true;
      errMsg = err.message;
    }

    assert.ok(threw, 'Should have thrown for non-re_plan recommendation');
    assert.ok(
      errMsg.startsWith('Circuit breaker:'),
      `Expected circuit breaker error, got: "${errMsg}"`,
    );
    assert.ok(!replanCalled, 'planner.replanTask should NOT be called for non-re_plan');
  } finally {
    cleanup(projectRoot);
  }
});

// ── TC7: analysis.structured is passed to planner.replanTask ─────────────────

await test('TC7: analysis.structured (rootCause, evidence) is passed to planner.replanTask', async () => {
  const { projectRoot } = createMinimalHarness();
  try {
    const pipeline = makePipeline(projectRoot);

    const structuredAnalysis = {
      rootCause: 'Missing dependency in module graph',
      evidence: ['test output line 1', 'test output line 2'],
    };

    pipeline.analyzer = makeMockAnalyzer({
      eventId: 'evt-007',
      recommendation: 're_plan',
      affectedTasks: [],
      structured: structuredAnalysis,
    });

    pipeline.scheduler = makeMockScheduler();

    const capturedArgs = [];
    pipeline.planner = {
      replanTask: async (...args) => {
        capturedArgs.push(args);
        const replacementTasks = [
          { id: '001-001-001-001-rp-001', description: 'Replacement', targetFiles: ['src/a.js'], dependencies: [] },
        ];
        return { replacementTasks };
      },
    };

    await pipeline._dispatchAnalyzer(baseTask, 'execution', 2);

    assert.equal(capturedArgs.length, 1, 'planner.replanTask should be called once');
    // Second argument is analysis.structured
    const passedStructured = capturedArgs[0][1];
    assert.deepStrictEqual(
      passedStructured,
      structuredAnalysis,
      `analysis.structured should be passed as second arg to replanTask.\nExpected: ${JSON.stringify(structuredAnalysis)}\nActual: ${JSON.stringify(passedStructured)}`,
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
