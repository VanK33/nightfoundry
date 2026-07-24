/**
 * test-scope-coverage-gate.js — Integration tests for Pipeline._scopeCoverageGate.
 *
 * Drives the REAL Pipeline.prototype._scopeCoverageGate against a duck-typed
 * `fakeThis`. Under the scope-mapping-gate spec the gate reads scopeItems +
 * scopeMapping FROM THE PLAN OBJECT (CONTRACT-4) — it no longer re-extracts
 * from spec markdown and no longer reads state.json. The plan object carries
 * the extracted scope-item set (with ids s1/s2/…) and the planner-authored
 * scopeMapping; the gate verifies every item is mapped to >=1 valid mission.
 *
 * TC1: all scope items covered — no throw, "all 3 item(s) covered" success log
 * TC2: scopeMapping omits an id (allow=false) → throws IncompleteScopeError
 *       with non-empty uncoveredLabels
 * TC3: same omission with allow=true → warn log, no throw
 * TC4: goal-only (plan.scopeItems = []) → skip log, no throw
 *
 * (The old TC5 "missing spec file returns without error" is gone: the gate no
 *  longer reads the spec file, so the premise no longer exists.)
 *
 * Run: node test/test-scope-coverage-gate.js
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// ── Helper: create a minimal tmp harness directory ────────────────────

function createTmpHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-scope-gate-'));
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
 * Build a minimal Pipeline-like object (duck-typing) and return it along
 * with a logs array so callers can inspect emitted messages.
 *
 * We call _scopeCoverageGate via Pipeline.prototype so we test the REAL
 * gate implementation without spinning up the full Pipeline constructor.
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

// Grab the gate function from Pipeline prototype (avoids full constructor cost)
const scopeCoverageGate = Pipeline.prototype._scopeCoverageGate;

// ── Plan fixtures (scopeItems + scopeMapping carried ON the plan object) ──────
//
// Three scope items s1/s2/s3 and three missions 001-001 / 001-002 / 001-003.
// validMissionIds is derived BY THE GATE from the plan's mission ids — the
// fixtures only need to carry the right scopeMapping.

/** Plan whose scopeMapping covers all three scope items with real mission ids. */
function planAllCovered() {
  return {
    milestones: [
      {
        id: '001',
        description: 'Milestone 1',
        missions: [
          { id: '001-001', description: 'Implement Auth module for users' },
          { id: '001-002', description: 'Build Cache layer for performance' },
          { id: '001-003', description: 'Add Logging service integration' },
        ],
      },
    ],
    scopeItems: [
      { id: 's1', label: 'Auth module', source: 'numbered-subsection' },
      { id: 's2', label: 'Cache layer', source: 'numbered-subsection' },
      { id: 's3', label: 'Logging service', source: 'numbered-subsection' },
    ],
    scopeMapping: [
      { scopeItemId: 's1', missionIds: ['001-001'] },
      { scopeItemId: 's2', missionIds: ['001-002'] },
      { scopeItemId: 's3', missionIds: ['001-003'] },
    ],
  };
}

/**
 * Plan whose scopeMapping omits s2 entirely and maps s3 to an EMPTY missionIds
 * — both s2 (Cache layer) and s3 (Logging service) are therefore uncovered.
 */
function planPartialCovered() {
  return {
    milestones: [
      {
        id: '001',
        description: 'Milestone 1',
        missions: [
          { id: '001-001', description: 'Implement Auth module for users' },
        ],
      },
    ],
    scopeItems: [
      { id: 's1', label: 'Auth module', source: 'numbered-subsection' },
      { id: 's2', label: 'Cache layer', source: 'numbered-subsection' },
      { id: 's3', label: 'Logging service', source: 'numbered-subsection' },
    ],
    scopeMapping: [
      { scopeItemId: 's1', missionIds: ['001-001'] },
      // s2 omitted entirely
      { scopeItemId: 's3', missionIds: [] }, // present but empty → uncovered
    ],
  };
}

/** Goal-only plan: scopeItems present and EMPTY (key present, value []). */
function planGoalOnly() {
  return {
    milestones: [
      {
        id: '001',
        description: 'Milestone 1',
        missions: [
          { id: '001-001', description: 'Some mission' },
        ],
      },
    ],
    scopeItems: [],
    scopeMapping: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TC1: all scope items covered — no throw, success log mentions "all 3 covered"
// ─────────────────────────────────────────────────────────────────────────────
await test('TC1: all scope items covered via mapping — no throw, success log emitted', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();

  try {
    const { fakeThis, logs } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let threw = false;
    try {
      await scopeCoverageGate.call(fakeThis, planAllCovered(), { prdPath: path.join(tmpDir, 'spec.md') });
    } catch (err) {
      threw = true;
      throw new Error(`Expected no throw, but got: ${err.message}`);
    }
    if (threw) throw new Error('Gate threw unexpectedly when all scope items are covered');

    // Should emit a success log containing "all" and "covered".
    const successLog = logs.find((msg) => msg.includes('all') && msg.includes('covered'));
    if (!successLog) {
      throw new Error(
        `Expected a success log containing "all" and "covered".\nLogs received:\n${logs.join('\n') || '(none)'}`
      );
    }

    // Log should mention the count of scope items (3).
    if (!successLog.includes('3')) {
      throw new Error(
        `Expected success log to mention the item count (3).\nActual log: "${successLog}"`
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC2: scopeMapping omits an id (allow=false) → throws IncompleteScopeError
// ─────────────────────────────────────────────────────────────────────────────
await test('TC2: scopeMapping omitting an id (allow=false) throws IncompleteScopeError with non-empty uncoveredLabels', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();

  try {
    const { fakeThis } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let thrownErr = null;
    try {
      await scopeCoverageGate.call(fakeThis, planPartialCovered(), { prdPath: path.join(tmpDir, 'spec.md') });
    } catch (err) {
      thrownErr = err;
    }

    if (!thrownErr) {
      throw new Error('Expected IncompleteScopeError to be thrown, but no error was thrown');
    }
    if (!(thrownErr instanceof IncompleteScopeError)) {
      throw new Error(
        `Expected IncompleteScopeError, got: ${thrownErr.constructor.name}: ${thrownErr.message}`
      );
    }

    // uncoveredLabels must be a non-empty array of LABELS (CONTRACT-1).
    const { uncoveredLabels } = thrownErr;
    if (!Array.isArray(uncoveredLabels) || uncoveredLabels.length === 0) {
      throw new Error(
        `Expected non-empty uncoveredLabels, got: ${JSON.stringify(uncoveredLabels)}`
      );
    }
    // The uncovered items are the omitted/empty-mapped ones: Cache layer / Logging service.
    const hasCacheOrLogging = uncoveredLabels.some(
      (l) => l.toLowerCase().includes('cache') || l.toLowerCase().includes('logging')
    );
    if (!hasCacheOrLogging) {
      throw new Error(
        `Expected uncoveredLabels to mention Cache or Logging.\nGot: ${JSON.stringify(uncoveredLabels)}`
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC3: same omission with allow=true → warn log, no throw
// ─────────────────────────────────────────────────────────────────────────────
await test('TC3: scopeMapping omitting an id (allow=true) emits a warning, no throw', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();

  try {
    const { fakeThis, logs } = makeFakePipeline(harnessDir, { allowIncompleteScope: true });

    let threw = false;
    try {
      await scopeCoverageGate.call(fakeThis, planPartialCovered(), { prdPath: path.join(tmpDir, 'spec.md') });
    } catch (_err) {
      threw = true;
    }
    if (threw) {
      throw new Error('Expected no throw when allowIncompleteScope=true, but gate threw');
    }

    // Should emit a warning log containing "Scope coverage warning".
    const warningLog = logs.find((msg) => msg.includes('Scope coverage warning'));
    if (!warningLog) {
      throw new Error(
        `Expected a warning log containing "Scope coverage warning".\nLogs received:\n${logs.join('\n') || '(none)'}`
      );
    }
    // Warning should mention at least one uncovered label (Cache / Logging).
    const hasCacheRef = warningLog.toLowerCase().includes('cache');
    const hasLoggingRef = warningLog.toLowerCase().includes('logging');
    if (!hasCacheRef && !hasLoggingRef) {
      throw new Error(
        `Expected warning log to mention uncovered labels (Cache or Logging).\nActual log: "${warningLog}"`
      );
    }
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC4: goal-only (plan.scopeItems = []) → skip log, no throw
//
// Present-and-empty scopeItems is the GOAL-ONLY tri-state (CONTRACT-4): the
// gate SKIPS — it must NOT fail-closed (that path is reserved for an ABSENT key).
// ─────────────────────────────────────────────────────────────────────────────
await test('TC4: goal-only plan (scopeItems = []) emits skip log, no throw', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();

  try {
    const { fakeThis, logs } = makeFakePipeline(harnessDir, { allowIncompleteScope: false });

    let threw = false;
    try {
      await scopeCoverageGate.call(fakeThis, planGoalOnly(), { prdPath: path.join(tmpDir, 'spec.md') });
    } catch (_err) {
      threw = true;
    }
    if (threw) {
      throw new Error('Expected no throw when plan.scopeItems is present-and-empty (goal-only), but gate threw');
    }

    // Should emit a "no scope items, skipping" log.
    const skipLog = logs.find((msg) => msg.includes('no scope items') || msg.includes('skipping'));
    if (!skipLog) {
      throw new Error(
        `Expected a "no scope items, skipping" log.\nLogs received:\n${logs.join('\n') || '(none)'}`
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
