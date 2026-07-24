/**
 * Regression test for HaltError unification (Phase 1 review follow-up).
 *
 * Asserts that all three auto-mode halt sites throw the structured
 * HaltError class (not a plain Error) and that .site / .reason are
 * populated. Without these, a CLI exit handler that wants to map
 * auto-mode halts to exit code 77 cannot detect them programmatically.
 *
 *   TC1: pipeline._gateConfirm Category B + non-TTY autoFromHere=true
 *   TC2: coverage.checkMilestoneCoverage non-TTY autoMode=true
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { HaltError } from '../src/orchestrator/core/halt-error.js';
import {
  checkMilestoneCoverage,
} from '../src/orchestrator/gates/coverage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    failCount++;
  }
}

/** Run `fn` with `process.stdout.isTTY` forced to `value`. */
async function withStdoutIsTTY(value, fn) {
  const original = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: original,
    });
  }
}

/** Build a Pipeline backed by a tmp project root. */
function makePipeline() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halt-error-unification-'));
  fs.mkdirSync(path.join(tmp, '.harness'), { recursive: true });
  const pipeline = new Pipeline(tmp, {
    onLog: () => {},
    onConfirm: async () => {
      throw new Error('onConfirm must not be invoked on the non-TTY halt path');
    },
  });
  pipeline.autoFromHere = true;
  return {
    pipeline,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

/**
 * Build a fake harness directory whose spec declares S1+S2 scenarios but
 * whose mission state covers only S1 — leaves an uncovered scenario so
 * coverage.checkMilestoneCoverage reaches the proceed-anyway gate (where
 * the auto+non-TTY HaltError throw lives).
 */
function makeCoverageHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halt-error-unification-cov-'));
  const projectRoot = tmp;
  const harnessDir = path.join(tmp, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  const specPath = path.join(tmp, 'spec.md');
  const specBody = [
    '# Test Spec',
    '## Scenarios',
    '- S1: alpha',
    '- S2: beta',
    '',
  ].join('\n');
  fs.writeFileSync(specPath, specBody);

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify({ projectMeta: { prdPath: specPath }, milestones: {} }),
  );

  // mission state: one sub-mission, one task that traces only S1.
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(harnessDir, 'state', 'mission-001-001.json'),
    JSON.stringify({
      id: '001-001',
      subMissions: {
        '001-001-001': {
          tasks: {
            '001-001-001-001': { tracesScenario: ['S1'] },
          },
        },
      },
    }),
  );

  return {
    projectRoot,
    harnessDir,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TC1: pipeline._gateConfirm Category B + non-TTY autoFromHere=true → HaltError
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC1: pipeline._gateConfirm non-TTY auto Cat-B throws HaltError with .site/.reason',
  async () => {
    await withStdoutIsTTY(false, async () => {
      const { pipeline, cleanup } = makePipeline();
      try {
        let thrown = null;
        try {
          await pipeline._gateConfirm('regression-failed', 'Regression failed. Proceed anyway?', {
            safeDefault: false,
            category: 'B',
          });
        } catch (e) {
          thrown = e;
        }
        assert.ok(thrown instanceof HaltError,
          `Expected HaltError, got ${thrown?.constructor?.name}: ${thrown?.message}`);
        assert.strictEqual(thrown.site, 'regression-failed');
        assert.ok(typeof thrown.reason === 'string' && thrown.reason.length > 0,
          'Expected non-empty .reason');
      } finally {
        cleanup();
      }
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TC2: coverage.checkMilestoneCoverage non-TTY autoMode → HaltError
// ─────────────────────────────────────────────────────────────────────────────
await test(
  'TC2: checkMilestoneCoverage non-TTY auto throws HaltError with .site',
  async () => {
    await withStdoutIsTTY(false, async () => {
      // Force a coverage gap by declaring 2 spec scenarios while the mission
      // covers only 1 — the gate fires and reaches the auto+non-TTY throw.
      const harness = makeCoverageHarness();
      try {
        let thrown = null;
        try {
          await checkMilestoneCoverage({
            harnessDir: harness.harnessDir,
            projectRoot: harness.projectRoot,
            missionIds: ['001-001'],
            planner: {
              remediateScenarios: async () => ({ outOfScope: [], newTasks: [] }),
            },
            onLog: () => {},
            onConfirm: async () => {
              throw new Error('onConfirm must not be invoked under autoMode + non-TTY');
            },
            autoMode: true,
          });
        } catch (e) {
          thrown = e;
        }
        assert.ok(thrown instanceof HaltError,
          `Expected HaltError, got ${thrown?.constructor?.name}: ${thrown?.message}`);
        assert.ok(/coverage/i.test(thrown.site),
          `Expected .site to identify coverage check, got: ${thrown.site}`);
      } finally {
        harness.cleanup();
      }
    });
  },
);

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
