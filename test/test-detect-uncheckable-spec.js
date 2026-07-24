/**
 * test-detect-uncheckable-spec.js — Integration tests for
 * Pipeline._detectUncheckableSpec, the fail-closed guard that hard-throws
 * (respecting _allowIncompleteScope) when a run's resolved spec is a bare
 * `.md` with no sibling `spec.json`.
 *
 * Derived from planner-json-sot.spec AC3/AC4. The gate is exercised directly
 * by duck-typing a minimal Pipeline-like object and invoking
 * _detectUncheckableSpec on Pipeline.prototype (same approach as
 * test-scope-coverage-gate.js), so we test the REAL guard without spinning up
 * the full Pipeline constructor.
 *
 * Cases:
 *   TC1:  bare .md exists, no sibling .json, _allowIncompleteScope=false → throws UncheckableSpecError
 *   TC2:  valid sibling .json exists → no throw
 *   TC2b: sibling .json exists but is CORRUPT (invalid JSON), allow=false → throws UncheckableSpecError
 *   TC2c: sibling .json exists but is EMPTY, allow=false → throws UncheckableSpecError
 *   TC2d: ASYMMETRY — corrupt .json + _allowIncompleteScope=TRUE → STILL throws
 *         (malformed json is not exempted by the flag, unlike the missing-json case)
 *   TC3:  no .json but _allowIncompleteScope=true → no throw (warns instead)
 *   TC4:  prdPath is a .json → no throw (out of scope)
 *   TC5:  prdPath falsy/absent (no state fallback) → no throw (out of scope)
 *   TC6:  prdPath points to a non-existent .md → no throw (out of scope)
 *   TC7:  prdPath resolved from state.projectMeta.prdPath when opts.prdPath absent → throws
 *   TC8:  guard skipped in small-task mode — driven through a REAL pipeline.run()
 *         (a bare .md with no sibling json in small-task mode must NOT throw, proving
 *          the guard sits inside the `if (!_skipCoverageGate)` block; a regression that
 *          moves it out of that block turns this test red)
 *
 * W2-F4 dialect-check cases (sibling spec.json parses fine, but its
 * acceptance_criteria use the legacy evidence-string dialect with no
 * verification objects — every spec-level deterministic gate would silently
 * no-op, so the guard must fail closed):
 *   TC9:  legacy dialect (non-empty acceptance_criteria, ZERO items with a
 *         verification that is a non-null object), allow=false → throws UncheckableSpecError
 *   TC10: legacy dialect + allowIncompleteScope=true → no throw, warning emitted
 *         through onLog mentioning the spec path
 *   TC11: mixed dialect (≥1 criterion has a verification object, others legacy)
 *         → no throw, no dialect warning
 *   TC12: all-manual (every criterion has verification {kind:'manual'}) → no throw
 *   TC13: acceptance_criteria empty array OR key absent → no throw (unchanged)
 *   TC14: legacy-dialect error identity — instanceof/name pin for downstream
 *         batch handling, and the message differs from the bare-md message
 *         (points at the verification-object contract instead)
 *   (malformed-json + flag → still throws is already pinned by TC2d)
 *
 * Run: node test/test-detect-uncheckable-spec.js
 */
// Verified compatible with w4-gate-predicate-fidelity (isCheckableCriterion replaces lax verification-object check).

import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { UncheckableSpecError } from '../src/orchestrator/core/uncheckable-spec-error.js';

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

// ── Helper: create a minimal tmp harness directory ────────────────────

function createTmpHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-uncheckable-'));
  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'plan'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  return { tmpDir, harnessDir };
}

function cleanup(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * Build a minimal Pipeline-like object (duck-typing) and return it along with
 * a logs array so callers can inspect emitted messages. We call
 * _detectUncheckableSpec via Pipeline.prototype so we exercise the REAL guard.
 */
function makeFakePipeline(harnessDir, { allowIncompleteScope = false } = {}) {
  const logs = [];
  const fakeThis = {
    harnessDir,
    projectRoot: path.dirname(harnessDir),
    _allowIncompleteScope: allowIncompleteScope,
    onLog: (msg) => logs.push(msg),
  };
  return { fakeThis, logs };
}

/** Write a state.json carrying projectMeta.prdPath into the harness dir. */
function writeStateWithPrdPath(harnessDir, prdPath) {
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({
      projectMeta: {
        prdPath,
        createdAt: new Date().toISOString(),
        currentPhase: 'planning',
      },
      globalStatus: 'active',
      milestones: {},
    }, null, 2),
  );
}

// Grab the guard from Pipeline prototype (avoids full constructor cost).
const detectUncheckableSpec = Pipeline.prototype._detectUncheckableSpec;

// ─────────────────────────────────────────────────────────────────────────────
// TC1: bare .md exists, no sibling .json, _allowIncompleteScope=false → throws
// ─────────────────────────────────────────────────────────────────────────────
await test('TC1: bare .md with no sibling .json (allowIncompleteScope=false) throws UncheckableSpecError carrying the spec path', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specPath, '# Bare spec, no sibling json\n');

    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let thrownErr = null;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (err) {
      thrownErr = err;
    }

    if (!thrownErr) {
      throw new Error('Expected UncheckableSpecError to be thrown, but nothing was thrown');
    }

    // Assert by name and by instanceof.
    if (thrownErr.name !== 'UncheckableSpecError') {
      throw new Error(`Expected error.name === 'UncheckableSpecError', got '${thrownErr.name}': ${thrownErr.message}`);
    }
    if (!(thrownErr instanceof UncheckableSpecError)) {
      throw new Error(`Expected instanceof UncheckableSpecError, got: ${thrownErr.constructor.name}`);
    }

    // Must carry the offending spec path somewhere inspectable (a property or the message).
    const carriesPath =
      thrownErr.specPath === specPath ||
      (typeof thrownErr.message === 'string' && thrownErr.message.includes(specPath));
    if (!carriesPath) {
      throw new Error(
        `Expected the error to carry the spec path "${specPath}" (via .specPath or message).\n` +
        `Got: specPath=${JSON.stringify(thrownErr.specPath)}, message="${thrownErr.message}"`,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC2: VALID sibling .json exists → no throw
// ─────────────────────────────────────────────────────────────────────────────
await test('TC2: bare .md WITH a valid sibling .json does not throw', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = path.join(tmpDir, 'spec.md');
    const jsonPath = path.join(tmpDir, 'spec.json');
    fs.writeFileSync(specPath, '# Spec with sibling json\n');
    fs.writeFileSync(jsonPath, JSON.stringify({ goal: 'x', constraints: [] }, null, 2));

    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let threw = false;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (err) {
      threw = true;
      throw new Error(`Expected no throw when a valid sibling .json exists, but got: ${err.message}`);
    }
    if (threw) throw new Error('Guard threw unexpectedly when a valid sibling .json exists');
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC2b: CORRUPT sibling .json (invalid JSON), allow=false → throws UncheckableSpecError
//
// A sibling spec.json that is present but unparseable is "uncheckable" — the
// planner cannot read constraints from it. The guard must hard-throw a clean
// UncheckableSpecError (not a raw SyntaxError) carrying the spec path.
// ─────────────────────────────────────────────────────────────────────────────
await test('TC2b: corrupt sibling .json (invalid JSON), allowIncompleteScope=false → throws UncheckableSpecError', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = path.join(tmpDir, 'spec.md');
    const jsonPath = path.join(tmpDir, 'spec.json');
    fs.writeFileSync(specPath, '# Spec with corrupt sibling json\n');
    fs.writeFileSync(jsonPath, '{bad json,'); // malformed — JSON.parse will throw

    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let thrownErr = null;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (err) {
      thrownErr = err;
    }

    if (!thrownErr) {
      throw new Error('Expected UncheckableSpecError for corrupt sibling .json, but nothing was thrown');
    }
    if (thrownErr.name !== 'UncheckableSpecError') {
      throw new Error(`Expected a clean UncheckableSpecError (not a raw parse error), got '${thrownErr.name}': ${thrownErr.message}`);
    }
    if (!(thrownErr instanceof UncheckableSpecError)) {
      throw new Error(`Expected instanceof UncheckableSpecError, got: ${thrownErr.constructor.name}`);
    }
    // Must carry the offending spec path.
    const carriesPath =
      thrownErr.specPath === specPath ||
      (typeof thrownErr.message === 'string' && thrownErr.message.includes(specPath));
    if (!carriesPath) {
      throw new Error(
        `Expected the error to carry the spec path "${specPath}".\n` +
        `Got: specPath=${JSON.stringify(thrownErr.specPath)}, message="${thrownErr.message}"`,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC2c: EMPTY sibling .json file, allow=false → throws UncheckableSpecError
// ─────────────────────────────────────────────────────────────────────────────
await test('TC2c: empty sibling .json file, allowIncompleteScope=false → throws UncheckableSpecError', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = path.join(tmpDir, 'spec.md');
    const jsonPath = path.join(tmpDir, 'spec.json');
    fs.writeFileSync(specPath, '# Spec with empty sibling json\n');
    fs.writeFileSync(jsonPath, ''); // empty file — not valid JSON

    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let thrownErr = null;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (err) {
      thrownErr = err;
    }

    if (!thrownErr) {
      throw new Error('Expected UncheckableSpecError for empty sibling .json, but nothing was thrown');
    }
    if (thrownErr.name !== 'UncheckableSpecError') {
      throw new Error(`Expected a clean UncheckableSpecError, got '${thrownErr.name}': ${thrownErr.message}`);
    }
    if (!(thrownErr instanceof UncheckableSpecError)) {
      throw new Error(`Expected instanceof UncheckableSpecError, got: ${thrownErr.constructor.name}`);
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC2d: ASYMMETRY — corrupt sibling .json + _allowIncompleteScope=TRUE → STILL throws
//
// This is the load-bearing distinction: a MISSING json is a soft condition the
// --allow-incomplete-scope flag may waive (see TC3). A CORRUPT/empty json is a
// hard condition — the spec author intended to provide a checkable json but it
// is broken — so the flag does NOT exempt it. The guard always throws for
// malformed json, regardless of _allowIncompleteScope.
// ─────────────────────────────────────────────────────────────────────────────
await test('TC2d: ASYMMETRY — corrupt sibling .json STILL throws even when allowIncompleteScope=true', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = path.join(tmpDir, 'spec.md');
    const jsonPath = path.join(tmpDir, 'spec.json');
    fs.writeFileSync(specPath, '# Spec with corrupt sibling json\n');
    fs.writeFileSync(jsonPath, '{bad json,'); // malformed

    // Flag is TRUE — yet malformed json must not be waived.
    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: true });

    let thrownErr = null;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (err) {
      thrownErr = err;
    }

    if (!thrownErr) {
      throw new Error(
        'Expected corrupt sibling .json to STILL throw with allowIncompleteScope=true ' +
        '(malformed json must not be exempted by the flag), but nothing was thrown',
      );
    }
    if (thrownErr.name !== 'UncheckableSpecError') {
      throw new Error(`Expected UncheckableSpecError, got '${thrownErr.name}': ${thrownErr.message}`);
    }
    if (!(thrownErr instanceof UncheckableSpecError)) {
      throw new Error(`Expected instanceof UncheckableSpecError, got: ${thrownErr.constructor.name}`);
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC3: no .json but _allowIncompleteScope=true → no throw (warns instead)
// ─────────────────────────────────────────────────────────────────────────────
await test('TC3: bare .md, no sibling .json, allowIncompleteScope=true → no throw, emits a warning', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specPath, '# Bare spec, no sibling json\n');

    const { fakeThis, logs } = makeFakePipeline(harnessDir, { allowIncompleteScope: true });

    let threw = false;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (_err) {
      threw = true;
    }
    if (threw) {
      throw new Error('Expected no throw when allowIncompleteScope=true, but the guard threw');
    }

    // Mirror _scopeCoverageGate's warn-and-continue behavior: a warning is emitted.
    const warnLog = logs.find((m) => typeof m === 'string' && m.toLowerCase().includes('uncheckable'));
    if (!warnLog) {
      throw new Error(
        `Expected an "uncheckable spec" warning log when allowIncompleteScope=true.\n` +
        `Logs received:\n${logs.join('\n') || '(none)'}`,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC4: prdPath is a .json → no throw (out of scope)
// ─────────────────────────────────────────────────────────────────────────────
await test('TC4: prdPath ending in .json does not throw (out of scope)', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const jsonPath = path.join(tmpDir, 'spec.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ goal: 'x', constraints: [] }, null, 2));

    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let threw = false;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: jsonPath });
    } catch (err) {
      threw = true;
      throw new Error(`Expected no throw when prdPath is a .json, but got: ${err.message}`);
    }
    if (threw) throw new Error('Guard threw unexpectedly when prdPath is a .json');
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC5: prdPath falsy/absent (no state fallback) → no throw (out of scope)
// ─────────────────────────────────────────────────────────────────────────────
await test('TC5: falsy/absent prdPath (and no state prdPath) does not throw', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    // Write a state.json whose projectMeta.prdPath is empty, so the guard's
    // state fallback resolves to a falsy prdPath (the real run path always has
    // a state.json on disk by the time this guard fires).
    writeStateWithPrdPath(harnessDir, '');
    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    // Case (a): empty opts.
    let threw = false;
    try {
      await detectUncheckableSpec.call(fakeThis, {});
    } catch (err) {
      threw = true;
      throw new Error(`Expected no throw with empty opts, but got: ${err.message}`);
    }
    if (threw) throw new Error('Guard threw unexpectedly with empty opts');

    // Case (b): explicit falsy prdPath.
    threw = false;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: '' });
    } catch (err) {
      threw = true;
      throw new Error(`Expected no throw with empty-string prdPath, but got: ${err.message}`);
    }
    if (threw) throw new Error('Guard threw unexpectedly with empty-string prdPath');
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC6: prdPath points to a non-existent .md → no throw (out of scope)
// ─────────────────────────────────────────────────────────────────────────────
await test('TC6: prdPath is a .md that does not exist on disk does not throw', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const missingPath = path.join(tmpDir, 'does-not-exist.md');

    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let threw = false;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: missingPath });
    } catch (err) {
      threw = true;
      throw new Error(`Expected no throw when the .md does not exist, but got: ${err.message}`);
    }
    if (threw) throw new Error('Guard threw unexpectedly when the .md does not exist on disk');
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC7: prdPath resolved from state.projectMeta.prdPath when opts.prdPath absent
// ─────────────────────────────────────────────────────────────────────────────
await test('TC7: resolves prdPath from state.projectMeta.prdPath when opts.prdPath is absent → throws on bare .md', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specPath, '# Bare spec, no sibling json\n');
    writeStateWithPrdPath(harnessDir, specPath);

    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let thrownErr = null;
    try {
      // No prdPath in opts — must fall back to state.projectMeta.prdPath.
      await detectUncheckableSpec.call(fakeThis, {});
    } catch (err) {
      thrownErr = err;
    }

    if (!thrownErr) {
      throw new Error('Expected UncheckableSpecError via state-resolved prdPath, but nothing was thrown');
    }
    if (thrownErr.name !== 'UncheckableSpecError') {
      throw new Error(`Expected error.name === 'UncheckableSpecError', got '${thrownErr.name}': ${thrownErr.message}`);
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC8: small-task mode skips the guard — DRIVEN THROUGH A REAL pipeline.run()
//
// AC4: the guard is hooked inside the `if (!this._skipCoverageGate)` block.
// Rather than inline-replicate that condition (which would false-green if the
// guard were moved out of the block), we drive a real run() in small-task mode
// with a bare .md and NO sibling json. run() sets _skipCoverageGate=true for
// small-task mode, so the guard must be skipped and the run must NOT raise an
// UncheckableSpecError. If a regression moves the guard outside the
// `!_skipCoverageGate` block, this run would throw and the test turns red.
//
// The pipeline is mocked like test/test-small-task.js (no live sessions): the
// planner/executor are stubbed and dry-run stops before execution. We tolerate
// any unrelated downstream error and fail ONLY on UncheckableSpecError.
// ─────────────────────────────────────────────────────────────────────────────
await test('TC8: small-task run with a bare .md (no sibling json) does NOT raise UncheckableSpecError', async () => {
  // A real project root (NOT just a harness dir) — run() bootstraps its own
  // .harness, so we hand it a fresh tmp dir with the bare spec inside.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-uncheckable-st-'));
  try {
    // Bare .md spec with NO sibling spec.json — the exact condition the guard
    // hard-throws on in full-run mode (TC1).
    const specPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specPath, '# Small task: bare .md, no sibling json\n');

    const logs = [];
    const pipeline = new Pipeline(tmpDir, {
      // allow=false so that, if the guard WERE wrongly reached, it would throw
      // (proving the skip is structural, not flag-driven).
      onLog: (msg) => logs.push(msg),
      onConfirm: async () => true,
      onMenu: async (_q, options) => options[0],
      dryRun: true,
    });

    // A plan within small-task caps (1 milestone, 1 mission) so run() does not
    // bail at the cap check before reaching the coverage-gate block.
    const smallPlan = {
      milestones: [
        {
          id: '001',
          description: 'Tiny milestone',
          missions: [{ id: '001-001', description: 'Tiny mission' }],
        },
      ],
    };
    const decomps = {
      '001-001': {
        subMissions: [
          {
            id: '001-001-001',
            description: 'Do the tiny thing',
            tasks: [
              {
                id: '001-001-001-001',
                description: 'Touch the file',
                targetFiles: ['README.md'],
                testCases: [],
                dependencies: [],
              },
            ],
          },
        ],
      },
    };

    // Stub the planner + executor — no live sessions.
    pipeline.planner.planGlobal = async () => JSON.parse(JSON.stringify(smallPlan));
    pipeline.planner.planMission = async (miId) => {
      const d = decomps[miId];
      if (!d) throw new Error(`No canned decomp for mission ${miId}`);
      return JSON.parse(JSON.stringify(d));
    };
    pipeline.planner.verifyAssumptions = async () => [];
    pipeline.planner.closeReusableSession = async () => {};
    pipeline.executor.executeTask = async () => {
      // No-op executor stub; this test only cares whether the uncheckable-spec
      // guard fires, not about execution.
      throw new Error('executeTask stub');
    };

    let uncheckableThrown = null;
    try {
      await pipeline.run(
        `Implement the task described at ${specPath}`,
        { prdPath: specPath, mode: 'small-task', dryRun: true },
      );
    } catch (err) {
      // Fail ONLY if the uncheckable-spec guard fired; tolerate any other
      // unrelated downstream error (e.g. scheduler-stall in the canned fixture).
      if (err instanceof UncheckableSpecError || err?.name === 'UncheckableSpecError') {
        uncheckableThrown = err;
      }
    }

    if (uncheckableThrown) {
      throw new Error(
        'small-task run raised UncheckableSpecError — the guard is no longer skipped in ' +
        'small-task mode. It must live inside the `if (!_skipCoverageGate)` block. ' +
        `Logs:\n${logs.join('\n')}`,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// W2-F4: spec.json DIALECT check — sibling json parses fine but its
// acceptance_criteria carry no verification objects (legacy dialect).
// ═════════════════════════════════════════════════════════════════════════════

/** Write a parseable sibling spec.json with the given acceptance_criteria. */
function writeSpecPair(tmpDir, spec) {
  const specPath = path.join(tmpDir, 'spec.md');
  const jsonPath = path.join(tmpDir, 'spec.json');
  fs.writeFileSync(specPath, '# Spec with sibling json\n');
  fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2));
  return specPath;
}

/** Legacy-dialect fixture: non-empty criteria, ZERO non-null-object verifications. */
function legacySpec() {
  return {
    goal: 'x',
    constraints: [],
    acceptance_criteria: [
      { description: 'thing A works', evidence: 'ran it and looked' },
      { description: 'thing B works', evidence: 'eyeballed the output' },
      // verification present but NOT a non-null object — still legacy per contract.
      { description: 'thing C works', evidence: 'trust me', verification: null },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TC9: legacy dialect, allowIncompleteScope=false → throws UncheckableSpecError
// ─────────────────────────────────────────────────────────────────────────────
await test('TC9: legacy-dialect sibling .json (no verification objects), allowIncompleteScope=false → throws UncheckableSpecError', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = writeSpecPair(tmpDir, legacySpec());
    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let thrownErr = null;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (err) {
      thrownErr = err;
    }

    if (!thrownErr) {
      throw new Error(
        'Expected UncheckableSpecError for a legacy-dialect spec.json ' +
        '(non-empty acceptance_criteria, zero verification objects), but nothing was thrown',
      );
    }
    if (thrownErr.name !== 'UncheckableSpecError') {
      throw new Error(`Expected error.name === 'UncheckableSpecError', got '${thrownErr.name}': ${thrownErr.message}`);
    }
    if (!(thrownErr instanceof UncheckableSpecError)) {
      throw new Error(`Expected instanceof UncheckableSpecError, got: ${thrownErr.constructor.name}`);
    }
    // Must carry the offending spec path somewhere inspectable.
    const carriesPath =
      thrownErr.specPath === specPath ||
      (typeof thrownErr.message === 'string' && thrownErr.message.includes(specPath));
    if (!carriesPath) {
      throw new Error(
        `Expected the error to carry the spec path "${specPath}".\n` +
        `Got: specPath=${JSON.stringify(thrownErr.specPath)}, message="${thrownErr.message}"`,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC10: legacy dialect + allowIncompleteScope=true → no throw, warns via onLog
// ─────────────────────────────────────────────────────────────────────────────
await test('TC10: legacy-dialect sibling .json, allowIncompleteScope=true → no throw, emits a warning mentioning the spec path', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = writeSpecPair(tmpDir, legacySpec());
    const { fakeThis, logs } = makeFakePipeline(harnessDir, { allowIncompleteScope: true });

    let threw = false;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (err) {
      threw = true;
      throw new Error(
        `Expected legacy dialect to be waived by allowIncompleteScope=true, but the guard threw: ${err.message}`,
      );
    }
    if (threw) throw new Error('Guard threw on legacy dialect despite allowIncompleteScope=true');

    // A warning must go through the pipeline's log hook. Stable fragment only —
    // don't pin exact wording.
    const warnLog = logs.find((m) => typeof m === 'string' && m.toLowerCase().includes('uncheckable'));
    if (!warnLog) {
      throw new Error(
        `Expected an "uncheckable spec" warning log for the legacy dialect when allowIncompleteScope=true.\n` +
        `Logs received:\n${logs.join('\n') || '(none)'}`,
      );
    }
    if (!warnLog.includes(specPath)) {
      throw new Error(
        `Expected the warning to mention the spec path "${specPath}".\nWarning: "${warnLog}"`,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC11: MIXED dialect (≥1 verification object, others legacy) → no throw, no warn
// ─────────────────────────────────────────────────────────────────────────────
await test('TC11: mixed-dialect sibling .json (one criterion has a verification object) → no throw, no dialect warning', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = writeSpecPair(tmpDir, {
      goal: 'x',
      constraints: [],
      acceptance_criteria: [
        { description: 'legacy item', evidence: 'eyeballed' },
        {
          description: 'checkable item',
          verification: { kind: 'command', command: 'node -e 1' },
        },
        { description: 'another legacy item', evidence: 'looked at logs' },
      ],
    });
    const { fakeThis, logs } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (err) {
      throw new Error(`Expected no throw for mixed dialect (≥1 verification object), but got: ${err.message}`);
    }

    const dialectWarn = logs.find((m) => typeof m === 'string' && m.toLowerCase().includes('uncheckable'));
    if (dialectWarn) {
      throw new Error(`Expected no dialect warning for mixed dialect, but got: "${dialectWarn}"`);
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC12: all-manual — every criterion has verification {kind:'manual'} → no throw
// (an honest human-verification declaration is checkable-by-contract)
// ─────────────────────────────────────────────────────────────────────────────
await test('TC12: all criteria with verification {kind:"manual"} → no throw', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = writeSpecPair(tmpDir, {
      goal: 'x',
      constraints: [],
      acceptance_criteria: [
        { description: 'human checks A', verification: { kind: 'manual' } },
        { description: 'human checks B', verification: { kind: 'manual' } },
      ],
    });
    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (err) {
      throw new Error(`Expected no throw for all-manual verification objects, but got: ${err.message}`);
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC13: empty acceptance_criteria array OR key absent → no throw (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
await test('TC13: acceptance_criteria empty array or key absent → no throw', async () => {
  // Case (a): explicit empty array.
  {
    const { tmpDir, harnessDir } = createTmpHarness();
    try {
      const specPath = writeSpecPair(tmpDir, { goal: 'x', constraints: [], acceptance_criteria: [] });
      const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });
      try {
        await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
      } catch (err) {
        throw new Error(`Expected no throw for acceptance_criteria: [], but got: ${err.message}`);
      }
    } finally {
      cleanup(tmpDir);
    }
  }
  // Case (b): key absent entirely.
  {
    const { tmpDir, harnessDir } = createTmpHarness();
    try {
      const specPath = writeSpecPair(tmpDir, { goal: 'x', constraints: [] });
      const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });
      try {
        await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
      } catch (err) {
        throw new Error(`Expected no throw when acceptance_criteria key is absent, but got: ${err.message}`);
      }
    } finally {
      cleanup(tmpDir);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC14: legacy-dialect error identity — downstream batch handling keys on
// instanceof/name; the message must differ from the bare-md message and point
// at the verification-object contract instead.
// ─────────────────────────────────────────────────────────────────────────────
await test('TC14: legacy-dialect error is UncheckableSpecError by name+instanceof, with a message distinct from the bare-md case', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    // (1) Capture the bare-md error (no sibling json at all).
    const bareDir = path.join(tmpDir, 'bare');
    fs.mkdirSync(bareDir);
    const barePath = path.join(bareDir, 'spec.md');
    fs.writeFileSync(barePath, '# Bare spec, no sibling json\n');

    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let bareErr = null;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: barePath });
    } catch (err) {
      bareErr = err;
    }
    if (!bareErr) throw new Error('Precondition failed: bare-md case did not throw (TC1 territory)');

    // (2) Capture the legacy-dialect error.
    const legacyDir = path.join(tmpDir, 'legacy');
    fs.mkdirSync(legacyDir);
    const legacyPath = path.join(legacyDir, 'spec.md');
    fs.writeFileSync(legacyPath, '# Spec with legacy-dialect sibling json\n');
    fs.writeFileSync(path.join(legacyDir, 'spec.json'), JSON.stringify(legacySpec(), null, 2));

    let legacyErr = null;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: legacyPath });
    } catch (err) {
      legacyErr = err;
    }

    if (!legacyErr) {
      throw new Error('Expected the legacy-dialect case to throw, but nothing was thrown');
    }
    if (legacyErr.name !== 'UncheckableSpecError') {
      throw new Error(`Expected error.name === 'UncheckableSpecError', got '${legacyErr.name}': ${legacyErr.message}`);
    }
    if (!(legacyErr instanceof UncheckableSpecError)) {
      throw new Error(`Expected instanceof UncheckableSpecError, got: ${legacyErr.constructor.name}`);
    }

    // The two failure modes must NOT share one message template (paths aside).
    const normalize = (msg, p) => msg.split(p).join('<SPEC>');
    if (normalize(legacyErr.message, legacyPath) === normalize(bareErr.message, barePath)) {
      throw new Error(
        'Expected the legacy-dialect message to differ from the bare-md message, ' +
        `but both normalize to: "${normalize(bareErr.message, barePath)}"`,
      );
    }
    // It should point at the verification-object contract (stable fragment).
    if (!legacyErr.message.toLowerCase().includes('verification')) {
      throw new Error(
        `Expected the legacy-dialect message to mention the verification-object contract.\n` +
        `Got: "${legacyErr.message}"`,
      );
    }
    // The contract says the error MAY carry reason='legacy-dialect'; if a reason
    // is present it must be that value (don't require the property itself).
    if (legacyErr.reason !== undefined && legacyErr.reason !== 'legacy-dialect') {
      throw new Error(`Expected reason 'legacy-dialect' when present, got: ${JSON.stringify(legacyErr.reason)}`);
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// TC15-TC19: Strict isCheckableCriterion predicate checks
//
// These cases exercise the stricter predicate now used by _detectUncheckableSpec.
// Previously, any non-null verification *object* was treated as "checkable".
// With the strict predicate, a verification must be a plain (non-array) object
// with a recognised, well-formed kind to count as checkable.
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// TC15: {verification:{}} (empty object) — no kind → not checkable → throws
// ─────────────────────────────────────────────────────────────────────────────
await test('TC15: spec with only {verification:{}} (empty object), allow=false → throws UncheckableSpecError', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = writeSpecPair(tmpDir, {
      goal: 'x',
      constraints: [],
      acceptance_criteria: [
        { description: 'empty verification', verification: {} },
      ],
    });
    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let thrownErr = null;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (err) {
      thrownErr = err;
    }

    if (!thrownErr) {
      throw new Error(
        'Expected UncheckableSpecError for spec with only {verification:{}} ' +
        '(empty object — no kind), but nothing was thrown',
      );
    }
    if (thrownErr.name !== 'UncheckableSpecError') {
      throw new Error(`Expected error.name === 'UncheckableSpecError', got '${thrownErr.name}': ${thrownErr.message}`);
    }
    if (!(thrownErr instanceof UncheckableSpecError)) {
      throw new Error(`Expected instanceof UncheckableSpecError, got: ${thrownErr.constructor.name}`);
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC16: {verification:{kind:'command'}} — kind present but command string absent
//       → not checkable → throws
// ─────────────────────────────────────────────────────────────────────────────
await test('TC16: spec with {verification:{kind:"command"}} (no command string), allow=false → throws UncheckableSpecError', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = writeSpecPair(tmpDir, {
      goal: 'x',
      constraints: [],
      acceptance_criteria: [
        { description: 'command kind but no command', verification: { kind: 'command' } },
      ],
    });
    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let thrownErr = null;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (err) {
      thrownErr = err;
    }

    if (!thrownErr) {
      throw new Error(
        'Expected UncheckableSpecError for {verification:{kind:"command"}} with no command string, ' +
        'but nothing was thrown',
      );
    }
    if (thrownErr.name !== 'UncheckableSpecError') {
      throw new Error(`Expected error.name === 'UncheckableSpecError', got '${thrownErr.name}': ${thrownErr.message}`);
    }
    if (!(thrownErr instanceof UncheckableSpecError)) {
      throw new Error(`Expected instanceof UncheckableSpecError, got: ${thrownErr.constructor.name}`);
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC17: {verification:{kind:'typo'}} — unrecognised kind → not checkable → throws
// ─────────────────────────────────────────────────────────────────────────────
await test('TC17: spec with {verification:{kind:"typo"}} (unrecognised kind), allow=false → throws UncheckableSpecError', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = writeSpecPair(tmpDir, {
      goal: 'x',
      constraints: [],
      acceptance_criteria: [
        { description: 'typo kind', verification: { kind: 'typo' } },
      ],
    });
    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let thrownErr = null;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (err) {
      thrownErr = err;
    }

    if (!thrownErr) {
      throw new Error(
        'Expected UncheckableSpecError for {verification:{kind:"typo"}} (unrecognised kind), ' +
        'but nothing was thrown',
      );
    }
    if (thrownErr.name !== 'UncheckableSpecError') {
      throw new Error(`Expected error.name === 'UncheckableSpecError', got '${thrownErr.name}': ${thrownErr.message}`);
    }
    if (!(thrownErr instanceof UncheckableSpecError)) {
      throw new Error(`Expected instanceof UncheckableSpecError, got: ${thrownErr.constructor.name}`);
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC18: {verification:[1,2]} — array, not a plain object → not checkable → throws
// ─────────────────────────────────────────────────────────────────────────────
await test('TC18: spec with {verification:[1,2]} (array instead of object), allow=false → throws UncheckableSpecError', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = writeSpecPair(tmpDir, {
      goal: 'x',
      constraints: [],
      acceptance_criteria: [
        { description: 'array verification', verification: [1, 2] },
      ],
    });
    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let thrownErr = null;
    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (err) {
      thrownErr = err;
    }

    if (!thrownErr) {
      throw new Error(
        'Expected UncheckableSpecError for {verification:[1,2]} (array — not a plain object), ' +
        'but nothing was thrown',
      );
    }
    if (thrownErr.name !== 'UncheckableSpecError') {
      throw new Error(`Expected error.name === 'UncheckableSpecError', got '${thrownErr.name}': ${thrownErr.message}`);
    }
    if (!(thrownErr instanceof UncheckableSpecError)) {
      throw new Error(`Expected instanceof UncheckableSpecError, got: ${thrownErr.constructor.name}`);
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC19: MIXED — one valid {kind:'command',command:'x'} + one {verification:{}}
//       → ≥1 checkable criterion → no throw
// ─────────────────────────────────────────────────────────────────────────────
await test('TC19: mixed spec — one valid {kind:"command",command:"x"} and one {verification:{}} → no throw (≥1 checkable)', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();
  try {
    const specPath = writeSpecPair(tmpDir, {
      goal: 'x',
      constraints: [],
      acceptance_criteria: [
        {
          description: 'properly checkable criterion',
          verification: { kind: 'command', command: 'x' },
        },
        {
          description: 'empty verification object — not individually checkable',
          verification: {},
        },
      ],
    });
    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    try {
      await detectUncheckableSpec.call(fakeThis, { prdPath: specPath });
    } catch (err) {
      throw new Error(
        'Expected no throw when ≥1 criterion has a valid {kind:"command",command:"x"} ' +
        `verification object (mixed dialect), but got: ${err.message}`,
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
