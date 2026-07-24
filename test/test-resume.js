/**
 * test-resume.js — Unit tests for the CLI-level unresumable-state early-exit guard
 * in src/cli/commands/resume.js.
 *
 * Tests:
 *   TC1 — All tests pass when run via node test/test-resume.js
 *   TC2 — Unresumable state (active+planning+empty milestones) → process.exit(76)
 *          + error message to stderr
 *   TC3 — Healthy state (executing+non-empty milestones) → guard does not fire
 *   TC4 — Error message contains 'cc-orch run' recovery hint
 *
 * Approach:
 *   - Temp directories with mock .harness/state.json fixtures
 *   - process.exit is mocked (save original, replace with sentinel-throw, restore in finally)
 *   - captureOutput (async) captures stderr to assert message content
 *   - For the healthy-state test, Pipeline.prototype.resume is stubbed to avoid
 *     needing real Claude sessions
 *
 * Run: node test/test-resume.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resume } from '../src/cli/commands/resume.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { IncompleteScopeError } from '../src/orchestrator/core/incomplete-scope-error.js';

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

// ── captureOutput (async) ─────────────────────────────────────────────────────
// Mirrors the pattern in test-archive-show.js but awaits async fn and returns
// thrownError so callers can distinguish sentinel vs real exceptions.

async function captureOutput(fn) {
  const outChunks = [];
  const errChunks = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);

  process.stdout.write = (chunk) => {
    outChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk) => {
    errChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => outChunks.push(args.join(' ') + '\n');
  console.error = (...args) => errChunks.push(args.join(' ') + '\n');

  let thrownError = null;
  try { await fn(); }
  catch (err) { thrownError = err; }
  finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
  }
  return { stdout: outChunks.join(''), stderr: errChunks.join(''), thrownError };
}

// ── TC2 + TC4: Unresumable state → exit(76), stderr contains 'cc-orch run' ───
//
// Note: the guard check in resume.js is inside a try/catch (to handle missing
// state.json). When we mock process.exit to throw a sentinel, that sentinel is
// caught by the same try/catch and execution continues. We therefore capture ALL
// exit-code calls in an array and assert that 76 appears among them.

await test('TC2+TC4: unresumable state (active+planning+empty milestones) exits with code 76 and stderr contains cc-orch run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-test-'));
  try {
    // Create .harness/state.json with the exact unresumable-state shape
    const harnessDir = path.join(root, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    fs.writeFileSync(
      path.join(harnessDir, 'state.json'),
      JSON.stringify({
        globalStatus: 'active',
        projectMeta: { currentPhase: 'planning' },
        milestones: {},
      }),
    );

    // Collect every exit-code call in order (there may be more than one because
    // the sentinel thrown by exit(76) is caught by resume.js's inner try/catch
    // for missing-state, then execution falls through to Pipeline which eventually
    // calls exit(1) on preflight failure).
    const capturedExitCodes = [];
    const sentinel = new Error('__SENTINEL_EXIT__');
    const origExit = process.exit;
    process.exit = (code) => {
      capturedExitCodes.push(code);
      throw sentinel;
    };

    let stderr = '';
    try {
      ({ stderr } = await captureOutput(async () => {
        await resume(root, { auto: true });
      }));
    } finally {
      process.exit = origExit;
    }

    // TC2: process.exit must have been called with code 76 at some point
    assert.ok(
      capturedExitCodes.includes(76),
      `Expected process.exit(76) to be called. Got exit codes: [${capturedExitCodes.join(', ')}]`,
    );

    // TC4: stderr must contain 'cc-orch run' recovery hint
    assert.ok(
      stderr.includes('cc-orch run'),
      `Expected stderr to contain 'cc-orch run'. Got:\n${stderr}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── TC3: Healthy state → guard does not fire ──────────────────────────────────

await test('TC3: healthy state (executing+non-empty milestones) guard does not fire (exit 76 not called)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-test-'));
  try {
    // Create .harness/state.json with a healthy (resumable) state
    const harnessDir = path.join(root, '.harness');
    fs.mkdirSync(harnessDir, { recursive: true });
    fs.writeFileSync(
      path.join(harnessDir, 'state.json'),
      JSON.stringify({
        globalStatus: 'active',
        projectMeta: { currentPhase: 'executing' },
        milestones: {
          '001': {
            description: 'Test milestone',
            status: 'in_progress',
            missions: {},
          },
        },
      }),
    );

    const capturedExitCodes = [];
    const sentinel = new Error('__SENTINEL_EXIT__');
    const origExit = process.exit;
    process.exit = (code) => {
      capturedExitCodes.push(code);
      throw sentinel;
    };

    // Stub Pipeline.prototype.resume to avoid needing real Claude sessions.
    // ESM module instances are shared, so stubbing the prototype here affects
    // the Pipeline instance created inside resume().
    const origPipelineResume = Pipeline.prototype.resume;
    Pipeline.prototype.resume = async function stubResume() {
      return { runStartSessionCount: 0 };
    };

    try {
      await captureOutput(async () => {
        await resume(root, { auto: true });
      });
    } finally {
      process.exit = origExit;
      Pipeline.prototype.resume = origPipelineResume;
    }

    // TC3: The guard must NOT have fired — exit(76) must not have been called
    assert.ok(
      !capturedExitCodes.includes(76),
      `Expected the unresumable-state guard NOT to fire, but process.exit(76) was called`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Scope-coverage gate on the resume() entry path (R2, crit ②).
//
// These tests exercise Pipeline.resume() directly (not via the CLI resume()
// wrapper, which stubs the whole method) so the REAL resume() body runs and we
// can observe the scope-coverage gate's throw / skip / pass behavior.
//
// We build a .harness/state.json whose state.projectMeta carries the extracted
// scopeItems (with ids s1/s2/s3) + the planner's scopeMapping (CONTRACT-2 /
// CONTRACT-5); resume() rehydrates them onto the rebuilt globalPlan before the
// gate runs. A scopeMapping that covers / omits an id is what makes the gate
// pass / throw — the spec.md is no longer re-extracted (the gate reads the plan
// object). To isolate the GATE, every resume() step AFTER the gate (milestone
// execution, review gate, cost summary, archive) is stubbed to a no-op on the
// instance, along with the preflight + agent-ticker side effects that run
// before the gate. The gate itself (Pipeline.prototype._scopeCoverageGate) is
// NOT stubbed — it runs for real against the rehydrated globalPlan.
// ─────────────────────────────────────────────────────────────────────────────

// A spec markdown with a `## Scope — in` section declaring 3 numbered items.
// Mirrors the fixture shape in test-scope-coverage-gate.js.
const RESUME_SPEC_WITH_SCOPE = `
# Resume Feature

## Scope — in

### 1. Auth module
### 2. Cache layer
### 3. Logging service

## Implementation

Some details here.
`;

/**
 * Write a .harness/state.json fixture under a fresh tmp dir.
 *
 * Under the scope-mapping-gate spec the gate reads scopeItems + scopeMapping
 * from the plan object that resume() rehydrates from state.projectMeta
 * (CONTRACT-2 / CONTRACT-5). So the persisted scope-item set and the planner's
 * mapping are written under state.projectMeta — NOT re-derived from the spec.md.
 * The key is written only when provided (callers seed it for the gate-firing
 * cases); when absent, resume() takes the LEGACY path.
 *
 * @param {string} root            project root tmp dir
 * @param {string} specPath        absolute path to the spec .md (becomes prdPath)
 * @param {object[]} missions      array of { id, description } mission objects
 *                                  (stored under milestone '001' as an object
 *                                  keyed by mission id, mirroring writeGlobalPlan)
 * @param {object} [scope]         optional { scopeItems, scopeMapping } seeded
 *                                  into state.projectMeta for the mapping gate
 */
function writeResumeState(root, specPath, missions, scope = {}) {
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  const missionsObj = {};
  for (const m of missions) {
    missionsObj[m.id] = { id: m.id, description: m.description, status: 'pending' };
  }
  const projectMeta = { currentPhase: 'executing', prdPath: specPath };
  if (scope.scopeItems !== undefined) projectMeta.scopeItems = scope.scopeItems;
  if (scope.scopeMapping !== undefined) projectMeta.scopeMapping = scope.scopeMapping;
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      globalStatus: 'active',
      projectMeta,
      milestones: {
        '001': {
          id: '001',
          description: 'Milestone 1',
          status: 'in_progress',
          missions: missionsObj,
        },
      },
    }, null, 2),
  );
  return harnessDir;
}

// Three scope items s1/s2/s3 mirroring extractScopeItems output (CONTRACT-6).
const RESUME_SCOPE_ITEMS = [
  { id: 's1', label: 'Auth module', source: 'numbered-subsection' },
  { id: 's2', label: 'Cache layer', source: 'numbered-subsection' },
  { id: 's3', label: 'Logging service', source: 'numbered-subsection' },
];

/**
 * Stub every resume() side effect EXCEPT the scope-coverage gate, so the gate's
 * throw/skip/pass is the only behavior under test. Returns a restore() fn.
 *
 * Stubs the instance methods that run before/after the gate (preflight, agent
 * ticker, milestone execution, review gate, cost summary, archive) and the
 * teardown hooks (planner session close, statusBar destroy). The gate
 * (_scopeCoverageGate) is intentionally left REAL.
 */
function stubResumeSideEffects(pipeline) {
  const noop = () => {};
  const asyncNoop = async () => {};
  pipeline._runPreflight = noop;
  pipeline._startAgentTicker = noop;
  pipeline._stopAgentTicker = noop;
  pipeline._executeMilestone = asyncNoop;
  pipeline._reviewGate = asyncNoop;
  pipeline._emitRunCostSummary = noop;
  pipeline._archive = asyncNoop;
  if (pipeline.planner) pipeline.planner.closeReusableSession = asyncNoop;
  if (pipeline.statusBar) pipeline.statusBar.destroy = noop;
  // restore is a no-op: the Pipeline instance is discarded after each test, so
  // the per-instance overrides above do not leak. (We do NOT touch any prototype.)
  return () => {};
}

// ─────────────────────────────────────────────────────────────────────────────
// TC5: resume() fires the gate — uncovered scope throws IncompleteScopeError
// ─────────────────────────────────────────────────────────────────────────────
await test('TC5: resume() with a persisted scopeMapping that omits an id throws IncompleteScopeError (mapping gate fires, non-vacuous)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-scope-test-'));
  try {
    const specPath = path.join(root, 'spec.md');
    fs.writeFileSync(specPath, RESUME_SPEC_WITH_SCOPE);

    // Seed 3 scope items s1/s2/s3 but a scopeMapping that OMITS s2 and maps s3
    // to a NON-EXISTENT mission (dangling) — both uncovered. scopeItems is
    // PRESENT (non-vacuous: this is the mapping path, NOT the legacy fail-closed
    // path), so the throw is judged against the authoritative persisted set.
    writeResumeState(
      root,
      specPath,
      [{ id: '001-001', description: 'Refactor unrelated database migration helper' }],
      {
        scopeItems: RESUME_SCOPE_ITEMS,
        scopeMapping: [
          { scopeItemId: 's1', missionIds: ['001-001'] },
          // s2 omitted entirely
          { scopeItemId: 's3', missionIds: ['001-999'] }, // dangling → uncovered
        ],
      },
    );

    const pipeline = new Pipeline(root, { onLog: () => {}, statusBar: false });
    const restore = stubResumeSideEffects(pipeline);

    let thrownErr = null;
    try {
      await pipeline.resume();
    } catch (err) {
      thrownErr = err;
    } finally {
      restore();
    }

    if (!thrownErr) {
      throw new Error('Expected resume() to throw IncompleteScopeError, but it resolved');
    }
    if (!(thrownErr instanceof IncompleteScopeError)) {
      throw new Error(
        `Expected IncompleteScopeError, got: ${thrownErr.constructor.name}: ${thrownErr.message}`
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC6: resume() honors _skipCoverageGate — same uncovered spec does NOT throw
// ─────────────────────────────────────────────────────────────────────────────
await test('TC6: resume() with _skipCoverageGate=true does NOT throw on uncovered spec (gate skipped)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-scope-test-'));
  try {
    const specPath = path.join(root, 'spec.md');
    fs.writeFileSync(specPath, RESUME_SPEC_WITH_SCOPE);

    // Same uncovered fixture as TC5.
    writeResumeState(root, specPath, [
      { id: '001-001', description: 'Refactor unrelated database migration helper' },
    ]);

    const pipeline = new Pipeline(root, { onLog: () => {}, statusBar: false });
    pipeline._skipCoverageGate = true;
    const restore = stubResumeSideEffects(pipeline);

    let thrownErr = null;
    try {
      await pipeline.resume();
    } catch (err) {
      thrownErr = err;
    } finally {
      restore();
    }

    // The gate must be skipped → it must NOT reject with IncompleteScopeError.
    if (thrownErr instanceof IncompleteScopeError) {
      throw new Error(
        'Expected the scope-coverage gate to be skipped when _skipCoverageGate=true, ' +
        'but resume() rejected with IncompleteScopeError'
      );
    }
    // Any other rejection would mean a stub gap, not the behavior under test.
    if (thrownErr) {
      throw new Error(`Expected resume() not to throw, but got: ${thrownErr.constructor.name}: ${thrownErr.message}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC7: resume() with fully-covered scope proceeds (no false positive)
// ─────────────────────────────────────────────────────────────────────────────
await test('TC7: resume() with fully-covered spec does NOT throw IncompleteScopeError (no false positive)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-scope-test-'));
  try {
    const specPath = path.join(root, 'spec.md');
    fs.writeFileSync(specPath, RESUME_SPEC_WITH_SCOPE);
    // Sibling spec.json fixture — the uncheckable-spec gate (which fires right
    // after the scope-coverage gate) fails closed on a bare .md.
    fs.writeFileSync(
      path.join(root, 'spec.json'),
      JSON.stringify({
        goal: 'Cover Auth, Cache and Logging',
        target_files: ['src/auth.js'],
        acceptance_criteria: [{ description: 'it works', verification: { kind: 'manual' } }],
      }),
    );

    // Persisted scopeMapping covers all three scope items with the real mission
    // ids 001-001 / 001-002 / 001-003 (every id ∈ the plan's mission set).
    writeResumeState(
      root,
      specPath,
      [
        { id: '001-001', description: 'Implement Auth module for users' },
        { id: '001-002', description: 'Build Cache layer for performance' },
        { id: '001-003', description: 'Add Logging service integration' },
      ],
      {
        scopeItems: RESUME_SCOPE_ITEMS,
        scopeMapping: [
          { scopeItemId: 's1', missionIds: ['001-001'] },
          { scopeItemId: 's2', missionIds: ['001-002'] },
          { scopeItemId: 's3', missionIds: ['001-003'] },
        ],
      },
    );

    const pipeline = new Pipeline(root, { onLog: () => {}, statusBar: false });
    const restore = stubResumeSideEffects(pipeline);

    let thrownErr = null;
    try {
      await pipeline.resume();
    } catch (err) {
      thrownErr = err;
    } finally {
      restore();
    }

    if (thrownErr instanceof IncompleteScopeError) {
      throw new Error(
        `Expected no IncompleteScopeError when all scope items are covered, but got: ${thrownErr.message}`
      );
    }
    if (thrownErr) {
      throw new Error(`Expected resume() not to throw, but got: ${thrownErr.constructor.name}: ${thrownErr.message}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
