#!/usr/bin/env node

/**
 * Unit tests: previousFailures wiring for retry evidence.
 *
 * Tests the logic that builds `previousFailures` from the verification sidecar
 * on task retries (mirrored from _executeAndVerifyTask in pipeline.js lines 2074-2094).
 *
 * Pattern: tmpDir setup, assert helper, no SDK spawning.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Extracted helper (mirrors pipeline.js _executeAndVerifyTask logic) ──────

/**
 * Given a parsed verification sidecar (or null if missing/malformed) and a
 * retryCount, return the object that mirrors what pipeline.js produces:
 *   { execContext, warned }
 * where execContext is the partial executor context object and warned is true
 * when the sidecar was null so callers can assert the warning path.
 */
function buildRetryContext(retryCount, sidecar, logWarning) {
  const execContext = {};

  if (retryCount > 0) {
    let previousFailures;

    if (sidecar === null) {
      logWarning('verification sidecar missing or malformed on retry — proceeding with empty previousFailures');
      previousFailures = [];
    } else {
      const hc = sidecar.hardChecks || [];
      const sc = sidecar.taskScopeChecks || [];
      previousFailures = [
        ...hc
          .filter((c) => c.status === 'FAIL')
          .map((c) => ({ kind: 'hardCheck', description: c.description, evidence: c.evidence })),
        ...sc
          .filter((c) => c.status === 'FAIL')
          .map((c) => ({ kind: 'scopeCheck', description: c.description, evidence: c.evidence })),
      ];
    }

    execContext.previousFailures = previousFailures;
  }

  return execContext;
}

// ── Thin wrapper that uses a real Pipeline._parseVerificationSidecar ─────────

async function main() {
  let passed = 0;
  let failed = 0;

  function assert(label, condition) {
    if (condition) {
      console.log(`  [PASS] ${label}`);
      passed++;
    } else {
      console.log(`  [FAIL] ${label}`);
      failed++;
    }
  }

  console.log('=== Pipeline Retry Evidence Tests ===\n');

  // ── Import Pipeline so we can use its _parseVerificationSidecar ──────────
  const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');

  /** Create a minimal temp harness + Pipeline instance. */
  function makeTmpHarness() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-retry-'));
    const hDir = path.join(root, '.harness');
    fs.mkdirSync(path.join(hDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(hDir, 'verification'), { recursive: true });
    const pipeline = new Pipeline(root, { onLog: () => {} });
    return { root, hDir, pipeline };
  }

  /** Write a verification sidecar file for a task. */
  function writeSidecar(hDir, taskId, content) {
    const sidecarPath = path.join(hDir, 'verification', `task-${taskId}.json`);
    fs.writeFileSync(sidecarPath, JSON.stringify(content, null, 2));
  }

  // ────────────────────────────────────────────────────────────────────────
  // TC1 + TC4: retryCount > 0, sidecar with mixed PASS/FAIL entries in both
  //            hardChecks and taskScopeChecks → only FAILs, correct kinds
  // ────────────────────────────────────────────────────────────────────────
  console.log('TC1 + TC4: mixed PASS/FAIL sidecar on retry');
  {
    const { root, hDir, pipeline } = makeTmpHarness();
    const taskId = '001-002-001-002';

    const sidecarContent = {
      result: 'FAIL',
      hardChecks: [
        { status: 'PASS', description: 'file exists',       evidence: 'ok' },
        { status: 'FAIL', description: 'lint passes',        evidence: 'ESLint error on line 5' },
        { status: 'FAIL', description: 'no syntax errors',   evidence: 'Unexpected token' },
      ],
      taskScopeChecks: [
        { status: 'PASS', description: 'TC1 passes',         evidence: 'assertion ok' },
        { status: 'FAIL', description: 'TC2 passes',         evidence: 'expected 42 got 0' },
      ],
    };
    writeSidecar(hDir, taskId, sidecarContent);

    const sidecar = pipeline._parseVerificationSidecar(taskId);
    const warnings = [];
    const ctx = buildRetryContext(1, sidecar, (msg) => warnings.push(msg));

    // TC1 assertions
    assert('TC1: previousFailures is an array', Array.isArray(ctx.previousFailures));
    assert('TC1: only FAIL entries included (3 hc + 1 sc = 4 but 2 hc fail + 1 sc fail = 3)', ctx.previousFailures.length === 3);
    assert('TC1: no PASS entries leaked', ctx.previousFailures.every((f) => f.kind === 'hardCheck' || f.kind === 'scopeCheck'));
    assert('TC1: descriptions preserved', ctx.previousFailures.some((f) => f.description === 'lint passes'));
    assert('TC1: evidence preserved', ctx.previousFailures.some((f) => f.evidence === 'ESLint error on line 5'));

    // TC4 assertions — both kinds present
    const hardCheckEntries = ctx.previousFailures.filter((f) => f.kind === 'hardCheck');
    const scopeCheckEntries = ctx.previousFailures.filter((f) => f.kind === 'scopeCheck');
    assert('TC4: hardCheck kind present', hardCheckEntries.length > 0);
    assert('TC4: scopeCheck kind present', scopeCheckEntries.length > 0);
    assert('TC4: hardCheck count = 2 failed hardChecks', hardCheckEntries.length === 2);
    assert('TC4: scopeCheck count = 1 failed scopeCheck', scopeCheckEntries.length === 1);
    assert('TC4: hardCheck description correct', hardCheckEntries[0].description === 'lint passes');
    assert('TC4: scopeCheck description correct', scopeCheckEntries[0].description === 'TC2 passes');
    assert('TC4: scopeCheck evidence correct', scopeCheckEntries[0].evidence === 'expected 42 got 0');

    assert('TC1+TC4: no spurious warning', warnings.length === 0);

    fs.rmSync(root, { recursive: true, force: true });
  }

  // ────────────────────────────────────────────────────────────────────────
  // TC2: retryCount === 0 → execContext has no previousFailures key
  // ────────────────────────────────────────────────────────────────────────
  console.log('\nTC2: retryCount === 0 → no previousFailures key');
  {
    const { root, hDir, pipeline } = makeTmpHarness();
    const taskId = '001-002-001-002';

    // Write a sidecar — should be ignored when retryCount === 0
    writeSidecar(hDir, taskId, {
      result: 'FAIL',
      hardChecks: [{ status: 'FAIL', description: 'something', evidence: 'evidence' }],
      taskScopeChecks: [],
    });

    const sidecar = pipeline._parseVerificationSidecar(taskId);
    const warnings = [];
    const ctx = buildRetryContext(0, sidecar, (msg) => warnings.push(msg));

    assert('TC2: previousFailures key absent', !('previousFailures' in ctx));
    assert('TC2: execContext is empty object', Object.keys(ctx).length === 0);
    assert('TC2: no warning emitted', warnings.length === 0);

    fs.rmSync(root, { recursive: true, force: true });
  }

  // ────────────────────────────────────────────────────────────────────────
  // TC3: missing sidecar → _parseVerificationSidecar returns null → warning
  //      logged, previousFailures defaults to empty array
  // ────────────────────────────────────────────────────────────────────────
  console.log('\nTC3: missing sidecar → warning + empty previousFailures');
  {
    const { root, hDir, pipeline } = makeTmpHarness();
    const taskId = '001-002-001-002';
    // deliberately do NOT write any sidecar file

    const sidecar = pipeline._parseVerificationSidecar(taskId);

    assert('TC3: _parseVerificationSidecar returns null for missing file', sidecar === null);

    const warnings = [];
    const ctx = buildRetryContext(1, sidecar, (msg) => warnings.push(msg));

    assert('TC3: previousFailures key present', 'previousFailures' in ctx);
    assert('TC3: previousFailures is empty array', Array.isArray(ctx.previousFailures) && ctx.previousFailures.length === 0);
    assert('TC3: warning was logged', warnings.length === 1);
    assert('TC3: warning mentions empty previousFailures', warnings[0].includes('empty previousFailures'));

    fs.rmSync(root, { recursive: true, force: true });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Additional edge: sidecar exists but has no FAIL entries → empty array
  // ────────────────────────────────────────────────────────────────────────
  console.log('\nEdge: all-PASS sidecar on retry → empty previousFailures');
  {
    const { root, hDir, pipeline } = makeTmpHarness();
    const taskId = '001-002-001-002';

    writeSidecar(hDir, taskId, {
      result: 'PASS',
      hardChecks: [
        { status: 'PASS', description: 'file exists', evidence: 'ok' },
      ],
      taskScopeChecks: [
        { status: 'PASS', description: 'TC1 passes', evidence: 'ok' },
      ],
    });

    const sidecar = pipeline._parseVerificationSidecar(taskId);
    const warnings = [];
    const ctx = buildRetryContext(1, sidecar, (msg) => warnings.push(msg));

    assert('Edge: previousFailures present', 'previousFailures' in ctx);
    assert('Edge: previousFailures empty (all PASS)', ctx.previousFailures.length === 0);
    assert('Edge: no warning for valid sidecar', warnings.length === 0);

    fs.rmSync(root, { recursive: true, force: true });
  }

  // ────────────────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
