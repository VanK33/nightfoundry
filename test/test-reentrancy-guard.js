/**
 * test-reentrancy-guard.js — Unit tests for reentrancy-guard.js, its
 * interplay with run-marker.js, bootstrap()/Pipeline.run() (the two
 * production call sites), and the spawn seams that propagate
 * CC_ORCH_ACTIVE_RUN into child processes (SessionManager._buildSdkOptions
 * and runHardChecks).
 *
 * No Claude auth, no SDK. Uses temp directories (fs.mkdtempSync) + a local
 * test()/pass-fail harness like the other test files in this repo.
 *
 * The guard is pointer-keyed: assertNoReentrantLiveRun only ever consults
 * resolveActiveHarnessDir(projectRoot) (the active-run pointer file plus the
 * per-run harness dir it points at). A flat .harness/state.json with no
 * active-run pointer is never consulted, regardless of its globalStatus.
 *
 * TC1: unset marker (key absent from env) + active state.json → no throw
 * TC2: empty-string marker + active state.json → no throw
 * TC3: non-empty marker + an active-run pointer resolving to a per-run
 *      harness dir whose state.json has globalStatus 'active' → throws
 *      ReentrantRunError
 * TC4: non-empty marker + no .harness at all → no throw
 * TC5: non-empty marker + globalStatus 'complete' (flat state.json, no
 *      active-run pointer) → no throw
 * TC6: bootstrap() with a non-empty marker against a fixture root whose
 *      active-run pointer resolves to a per-run harness dir with an active
 *      state.json → throws ReentrantRunError, and that state.json is
 *      byte-identical before/after (no .harness mutation)
 * TC7: Pipeline.run() (the run() seam) with a non-empty marker against a
 *      fixture root whose active-run pointer resolves to a per-run harness
 *      dir with an active state.json → throws ReentrantRunError, without
 *      mutating state.json
 * TC8: Pipeline.resume() with a non-empty marker against a fixture root
 *      whose active-run pointer resolves to a per-run harness dir with an
 *      active state.json → throws ReentrantRunError, without mutating
 *      state.json
 * TC9: Pipeline.dryRunValidate() with a non-empty marker against a fixture
 *      root whose active-run pointer resolves to a per-run harness dir with
 *      an active state.json → throws ReentrantRunError, without mutating
 *      state.json or spawning any sessions/queue entries
 * TC10: Pipeline.resume() with no marker (empty string) + no .harness at
 *       all → the guard no-ops and control passes through to the existing
 *       init check, which throws 'No .harness/state.json found' (NOT a
 *       ReentrantRunError)
 * TC11: active state.json + empty-string marker, and active state.json +
 *       key-absent env, both via assertNoReentrantLiveRun's { env } opts →
 *       no throw, state.json bytes unchanged — pins the shared no-op
 *       predicate that both resume() and dryRunValidate() invoke
 * TC12: non-empty marker + an active-run pointer resolving to a per-run
 *       harness dir whose state.json has globalStatus 'complete' → no
 *       throw (the completed-unarchived case), state.json bytes unchanged
 * TC13: non-empty marker + a flat .harness/state.json with globalStatus
 *       'active' but NO active-run pointer → no throw — proves the guard
 *       keys off the active-run pointer, not the flat state.json file
 *
 * TC6/TC7 exercise production call sites that read process.env directly
 * (bootstrap()/Pipeline.run() do not accept an env override), so those two
 * cases temporarily set process.env[CC_ORCH_ACTIVE_RUN] and restore the
 * original value (or delete the key) in a finally block, so the suite never
 * leaks a marker into the real environment for other tests/processes.
 *
 * Run: node test/test-reentrancy-guard.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';

import {
  assertNoReentrantLiveRun,
  ReentrantRunError,
} from '../src/orchestrator/core/reentrancy-guard.js';
import { CC_ORCH_ACTIVE_RUN, getRunMarker } from '../src/orchestrator/core/run-marker.js';
import { generateRunId, claimActiveRun, runHarnessDir } from '../src/orchestrator/core/run-context.js';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { SessionManager } from '../src/orchestrator/infra/session-manager.js';
import { runHardChecks } from '../src/orchestrator/gates/hard-checks.js';

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

// ---------- Fixture helpers ----------

function createTempRoot(prefix = 'reentrancy-guard-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeState(root, globalStatus) {
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  const state = {
    projectMeta: {
      prdPath: 'PRD.md',
      createdAt: new Date().toISOString(),
      createdWithVersion: 'test',
      currentPhase: 'planning',
    },
    globalStatus,
    milestones: {},
  };
  const stateFile = path.join(harnessDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return stateFile;
}

function writeActiveState(root) {
  return writeState(root, 'active');
}

/**
 * Writes a per-run harness dir under root's .harness (via runHarnessDir())
 * containing a state.json with the given globalStatus, AND claims the
 * active-run pointer (via claimActiveRun()) so that resolveActiveHarnessDir()
 * — the seam assertNoReentrantLiveRun keys off — resolves to that run dir.
 *
 * Returns the per-run state.json path, so callers can do the usual
 * byte-identical-before/after assertions.
 */
function writeActivePointerRun(root, globalStatus = 'active') {
  const runId = generateRunId('reentrancy-guard-test');
  const claimed = claimActiveRun(root, { runId, slug: 'reentrancy-guard-test', kind: 'test' });
  assert.ok(claimed, 'fixture precondition: claimActiveRun must succeed against a fresh root');

  const runDir = runHarnessDir(root, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const state = {
    projectMeta: {
      prdPath: 'PRD.md',
      createdAt: new Date().toISOString(),
      createdWithVersion: 'test',
      currentPhase: 'planning',
    },
    globalStatus,
    milestones: {},
  };
  const stateFile = path.join(runDir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return stateFile;
}

function createHardCheckEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reentrancy-hardchecks-test-'));
  const harnessDir = path.join(root, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'verify'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'verification'), { recursive: true });
  return { projectRoot: root, harnessDir };
}

function writeVerify(harnessDir, taskId, hardChecks) {
  const verify = { taskId, hardChecks, testCases: [], targetFiles: [] };
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify(verify, null, 2)
  );
}

/**
 * Temporarily sets process.env[CC_ORCH_ACTIVE_RUN] = value, runs fn (sync or
 * async), and restores the original value (or deletes the key if it was
 * originally absent) in a finally block — so the real environment is never
 * left polluted, even if fn throws.
 */
async function withProcessEnvMarker(value, fn) {
  const hadKey = Object.prototype.hasOwnProperty.call(process.env, CC_ORCH_ACTIVE_RUN);
  const original = process.env[CC_ORCH_ACTIVE_RUN];
  process.env[CC_ORCH_ACTIVE_RUN] = value;
  try {
    return await fn();
  } finally {
    if (hadKey) {
      process.env[CC_ORCH_ACTIVE_RUN] = original;
    } else {
      delete process.env[CC_ORCH_ACTIVE_RUN];
    }
  }
}

// ---------- Tests ----------

async function main() {
  // Outer safety net: save/restore any process.env[CC_ORCH_ACTIVE_RUN] in case
  // an assertion failure inside withProcessEnvMarker's fn skips its own
  // restoration path (defense in depth — withProcessEnvMarker already
  // restores in its own finally).
  const originalMarkerEnv = Object.prototype.hasOwnProperty.call(process.env, CC_ORCH_ACTIVE_RUN)
    ? process.env[CC_ORCH_ACTIVE_RUN]
    : undefined;
  const hadOriginalMarkerEnv = Object.prototype.hasOwnProperty.call(process.env, CC_ORCH_ACTIVE_RUN);

  try {
    // --- TC1: unset marker (key absent) + active state.json → no throw ---
    await test('TC1: unset marker + active state.json → no throw', () => {
      const root = createTempRoot();
      try {
        const stateFile = writeActiveState(root);
        const before = fs.readFileSync(stateFile);

        const envWithoutMarker = { ...process.env };
        delete envWithoutMarker[CC_ORCH_ACTIVE_RUN];

        assert.doesNotThrow(() => {
          assertNoReentrantLiveRun(root, { env: envWithoutMarker });
        });

        const after = fs.readFileSync(stateFile);
        assert.ok(before.equals(after), 'state.json bytes must be unchanged (unset marker case)');
      } finally {
        cleanup(root);
      }
    });

    // --- TC2: empty-string marker + active state.json → no throw ---
    await test('TC2: empty-string marker + active state.json → no throw', () => {
      const root = createTempRoot();
      try {
        const stateFile = writeActiveState(root);
        const before = fs.readFileSync(stateFile);

        assert.doesNotThrow(() => {
          assertNoReentrantLiveRun(root, { env: { [CC_ORCH_ACTIVE_RUN]: '' } });
        });

        const after = fs.readFileSync(stateFile);
        assert.ok(before.equals(after), 'state.json bytes must be unchanged (empty-string marker case)');
      } finally {
        cleanup(root);
      }
    });

    // --- TC3: non-empty marker + an active-run pointer resolving to a
    //     per-run harness dir whose state.json is 'active' → throws
    //     ReentrantRunError ---
    await test("TC3: non-empty marker + pointer resolving to an active run dir → throws ReentrantRunError, state.json untouched", () => {
      const root = createTempRoot();
      try {
        const stateFile = writeActivePointerRun(root);
        const before = fs.readFileSync(stateFile);

        let thrown;
        try {
          assertNoReentrantLiveRun(root, { env: { [CC_ORCH_ACTIVE_RUN]: 'live-1' } });
        } catch (err) {
          thrown = err;
        }

        assert.ok(thrown, 'Expected assertNoReentrantLiveRun to throw');
        assert.ok(thrown instanceof ReentrantRunError, `Expected ReentrantRunError, got ${thrown && thrown.constructor && thrown.constructor.name}`);

        const after = fs.readFileSync(stateFile);
        assert.ok(before.equals(after), 'state.json bytes must be unchanged after the guard throws');
      } finally {
        cleanup(root);
      }
    });

    // --- TC4: non-empty marker + no .harness at all → no throw ---
    await test('TC4: non-empty marker + no .harness → no throw', () => {
      const root = createTempRoot();
      try {
        assert.ok(!fs.existsSync(path.join(root, '.harness')), 'fixture precondition: no .harness dir');
        assert.doesNotThrow(() => {
          assertNoReentrantLiveRun(root, { env: { [CC_ORCH_ACTIVE_RUN]: 'live-1' } });
        });
      } finally {
        cleanup(root);
      }
    });

    // --- TC5: non-empty marker + globalStatus 'complete' → no throw ---
    await test("TC5: non-empty marker + globalStatus 'complete' → no throw", () => {
      const root = createTempRoot();
      try {
        const stateFile = writeState(root, 'complete');
        const before = fs.readFileSync(stateFile);

        assert.doesNotThrow(() => {
          assertNoReentrantLiveRun(root, { env: { [CC_ORCH_ACTIVE_RUN]: 'live-1' } });
        });

        const after = fs.readFileSync(stateFile);
        assert.ok(before.equals(after), "state.json bytes must be unchanged (globalStatus 'complete' case)");
      } finally {
        cleanup(root);
      }
    });

    // --- TC6: bootstrap() with a non-empty marker against a fixture root
    //     whose active-run pointer resolves to a per-run harness dir with an
    //     active state.json → throws ReentrantRunError, leaving that
    //     state.json byte-identical (no .harness mutation at all) ---
    await test('TC6: bootstrap() refuses under a non-empty marker + pointer resolving to an active run dir, leaves it unchanged', async () => {
      const root = createTempRoot('reentrancy-guard-bootstrap-');
      try {
        const stateFile = writeActivePointerRun(root);
        const before = fs.readFileSync(stateFile);
        const harnessEntriesBefore = fs.readdirSync(path.join(root, '.harness')).sort();

        await withProcessEnvMarker('live-bootstrap-1', () => {
          let thrown;
          try {
            bootstrap(root, {});
          } catch (err) {
            thrown = err;
          }
          assert.ok(thrown, 'Expected bootstrap() to throw');
          assert.ok(
            thrown instanceof ReentrantRunError,
            `Expected ReentrantRunError, got ${thrown && thrown.constructor && thrown.constructor.name}`
          );
        });

        const after = fs.readFileSync(stateFile);
        assert.ok(before.equals(after), 'state.json bytes must be unchanged after bootstrap() refuses');

        const harnessEntriesAfter = fs.readdirSync(path.join(root, '.harness')).sort();
        assert.deepStrictEqual(
          harnessEntriesAfter,
          harnessEntriesBefore,
          '.harness directory contents must be unchanged after bootstrap() refuses'
        );
      } finally {
        cleanup(root);
      }
    });

    // --- TC7: Pipeline.run() with a non-empty marker against a fixture root
    //     whose active-run pointer resolves to a per-run harness dir with an
    //     active state.json → throws ReentrantRunError, without mutating
    //     state.json ---
    await test('TC7: Pipeline.run() refuses under a non-empty marker + pointer resolving to an active run dir, without mutating it', async () => {
      const root = createTempRoot('reentrancy-guard-pipeline-');
      try {
        const stateFile = writeActivePointerRun(root);
        const before = fs.readFileSync(stateFile);

        const pipeline = new Pipeline(root, { onLog: () => {}, onConfirm: async () => true, statusBar: false });

        await withProcessEnvMarker('live-pipeline-1', async () => {
          let thrown;
          try {
            await pipeline.run('some goal');
          } catch (err) {
            thrown = err;
          }
          assert.ok(thrown, 'Expected Pipeline.run() to throw');
          assert.ok(
            thrown instanceof ReentrantRunError,
            `Expected ReentrantRunError, got ${thrown && thrown.constructor && thrown.constructor.name}`
          );
        });

        const after = fs.readFileSync(stateFile);
        assert.ok(before.equals(after), 'state.json bytes must be unchanged after Pipeline.run() refuses');
      } finally {
        cleanup(root);
      }
    });

    // --- TC8: Pipeline.resume() with a non-empty marker against a fixture
    //     root whose active-run pointer resolves to a per-run harness dir
    //     with an active state.json → throws ReentrantRunError, without
    //     mutating state.json ---
    await test('TC8: Pipeline.resume() refuses under a non-empty marker + pointer resolving to an active run dir, without mutating it', async () => {
      const root = createTempRoot('reentrancy-guard-pipeline-resume-');
      try {
        const stateFile = writeActivePointerRun(root);
        const before = fs.readFileSync(stateFile);

        const pipeline = new Pipeline(root, { onLog: () => {}, onConfirm: async () => true, statusBar: false });

        await withProcessEnvMarker('live-resume-1', async () => {
          let thrown;
          try {
            await pipeline.resume();
          } catch (err) {
            thrown = err;
          }
          assert.ok(thrown, 'Expected Pipeline.resume() to throw');
          assert.ok(
            thrown instanceof ReentrantRunError,
            `Expected ReentrantRunError, got ${thrown && thrown.constructor && thrown.constructor.name}`
          );
        });

        const after = fs.readFileSync(stateFile);
        assert.ok(before.equals(after), 'state.json bytes must be unchanged after Pipeline.resume() refuses');
      } finally {
        cleanup(root);
      }
    });

    // --- TC9: Pipeline.dryRunValidate() with a non-empty marker against a
    //     fixture root whose active-run pointer resolves to a per-run
    //     harness dir with an active state.json → throws ReentrantRunError,
    //     without mutating state.json or spawning any sessions/queue entries ---
    await test('TC9: Pipeline.dryRunValidate() refuses under a non-empty marker + pointer resolving to an active run dir, spawning no sessions and writing no queue entry', async () => {
      const root = createTempRoot('reentrancy-guard-pipeline-dryrun-');
      try {
        const stateFile = writeActivePointerRun(root);
        const before = fs.readFileSync(stateFile);

        const pipeline = new Pipeline(root, { onLog: () => {}, onConfirm: async () => true, statusBar: false });

        await withProcessEnvMarker('live-dryrun-1', async () => {
          let thrown;
          try {
            await pipeline.dryRunValidate('some goal');
          } catch (err) {
            thrown = err;
          }
          assert.ok(thrown, 'Expected Pipeline.dryRunValidate() to throw');
          assert.ok(
            thrown instanceof ReentrantRunError,
            `Expected ReentrantRunError, got ${thrown && thrown.constructor && thrown.constructor.name}`
          );
        });

        const after = fs.readFileSync(stateFile);
        assert.ok(before.equals(after), 'state.json bytes must be unchanged after Pipeline.dryRunValidate() refuses');
        assert.ok(
          !fs.existsSync(path.join(root, '.harness', 'queue')),
          'No .harness/queue directory should be created after Pipeline.dryRunValidate() refuses'
        );
      } finally {
        cleanup(root);
      }
    });

    // --- TC10: Pipeline.resume() with no marker + no .harness passes the
    //     guard → throws the init error, not ReentrantRunError ---
    await test("TC10: Pipeline.resume() with no marker + no .harness passes the guard → throws the init error, not ReentrantRunError", async () => {
      const root = createTempRoot('reentrancy-guard-pipeline-resume-empty-');
      try {
        assert.ok(!fs.existsSync(path.join(root, '.harness')), 'fixture precondition: no .harness dir');

        const pipeline = new Pipeline(root, { onLog: () => {}, onConfirm: async () => true, statusBar: false });

        await withProcessEnvMarker('', async () => {
          let thrown;
          try {
            await pipeline.resume();
          } catch (err) {
            thrown = err;
          }
          assert.ok(thrown, 'Expected Pipeline.resume() to throw');
          assert.ok(
            !(thrown instanceof ReentrantRunError),
            `Expected NOT a ReentrantRunError, got ${thrown && thrown.constructor && thrown.constructor.name}`
          );
          assert.ok(
            thrown.message.includes('No .harness/state.json found'),
            `Expected init error message, got: ${thrown.message}`
          );
        });
      } finally {
        cleanup(root);
      }
    });

    // --- TC11: empty and absent markers leave an active state.json
    //     byte-identical at the guard seam ---
    await test('TC11: empty and absent markers leave an active state.json byte-identical at the guard seam', () => {
      const root = createTempRoot();
      try {
        const stateFile = writeActiveState(root);
        const before = fs.readFileSync(stateFile);

        assert.doesNotThrow(() => {
          assertNoReentrantLiveRun(root, { env: { [CC_ORCH_ACTIVE_RUN]: '' } });
        });
        const afterEmpty = fs.readFileSync(stateFile);
        assert.ok(before.equals(afterEmpty), 'state.json bytes must be unchanged (empty-string marker case)');

        const envWithoutMarker = { ...process.env };
        delete envWithoutMarker[CC_ORCH_ACTIVE_RUN];
        assert.doesNotThrow(() => {
          assertNoReentrantLiveRun(root, { env: envWithoutMarker });
        });
        const afterAbsent = fs.readFileSync(stateFile);
        assert.ok(before.equals(afterAbsent), 'state.json bytes must be unchanged (key-absent marker case)');
      } finally {
        cleanup(root);
      }
    });

    // --- TC12: non-empty marker + an active-run pointer resolving to a
    //     per-run harness dir whose state.json globalStatus is 'complete'
    //     → no throw (the completed-unarchived case), state.json bytes
    //     unchanged ---
    await test("TC12: non-empty marker + pointer resolving to a completed run dir → no throw (completed-unarchived)", () => {
      const root = createTempRoot();
      try {
        const stateFile = writeActivePointerRun(root, 'complete');
        const before = fs.readFileSync(stateFile);

        assert.doesNotThrow(() => {
          assertNoReentrantLiveRun(root, { env: { [CC_ORCH_ACTIVE_RUN]: 'live-1' } });
        });

        const after = fs.readFileSync(stateFile);
        assert.ok(
          before.equals(after),
          "state.json bytes must be unchanged (completed-unarchived pointer case)"
        );
      } finally {
        cleanup(root);
      }
    });

    // --- TC13: non-empty marker + a flat .harness/state.json with
    //     globalStatus 'active' but NO active-run pointer → no throw —
    //     proves the guard keys off the active-run pointer, not the flat
    //     state.json file ---
    await test("TC13: non-empty marker + flat active state.json with no active-run pointer → no throw (pointer-keyed, not flat-file-keyed)", () => {
      const root = createTempRoot();
      try {
        const stateFile = writeActiveState(root);
        assert.ok(
          !fs.existsSync(path.join(root, '.harness', 'active-run')),
          'fixture precondition: no active-run pointer file'
        );
        const before = fs.readFileSync(stateFile);

        assert.doesNotThrow(() => {
          assertNoReentrantLiveRun(root, { env: { [CC_ORCH_ACTIVE_RUN]: 'live-1' } });
        });

        const after = fs.readFileSync(stateFile);
        assert.ok(
          before.equals(after),
          'state.json bytes must be unchanged (flat active state.json, no pointer, case)'
        );
      } finally {
        cleanup(root);
      }
    });

    // --- Spawn-seam coverage: engine-spawned children carry CC_ORCH_ACTIVE_RUN ---

    // new SessionManager()._buildSdkOptions({}) env carries the marker
    // while preserving an existing process.env entry.
    await test('Spawn seam: _buildSdkOptions().env[CC_ORCH_ACTIVE_RUN] === getRunMarker(), parent env preserved', () => {
      const sentinelKey = '__CC_ORCH_TEST_SENTINEL__';
      const sentinelValue = 'sentinel-value-' + Date.now();
      process.env[sentinelKey] = sentinelValue;
      try {
        const sm = new SessionManager();
        const opts = sm._buildSdkOptions({});
        assert.ok(opts.env, 'Expected _buildSdkOptions() to return an env object');
        assert.strictEqual(
          opts.env[CC_ORCH_ACTIVE_RUN],
          getRunMarker(),
          `Expected env[${CC_ORCH_ACTIVE_RUN}] to equal getRunMarker()`
        );
        assert.ok(
          typeof opts.env[CC_ORCH_ACTIVE_RUN] === 'string' && opts.env[CC_ORCH_ACTIVE_RUN].length > 0,
          'Expected non-empty marker value'
        );
        assert.strictEqual(
          opts.env[sentinelKey],
          sentinelValue,
          'Expected existing process.env entry to be preserved in the built env'
        );
      } finally {
        delete process.env[sentinelKey];
      }
    });

    // runHardChecks child inherits the marker via the hard-check spawn seam.
    await test('Spawn seam: runHardChecks child output contains getRunMarker() (hard-check spawn seam carries the marker)', async () => {
      const { projectRoot, harnessDir } = createHardCheckEnv();
      try {
        writeVerify(harnessDir, '001-003-001-001', [
          {
            name: 'echo run marker',
            command: `node -e "process.stdout.write(process.env.CC_ORCH_ACTIVE_RUN||'')"`,
          },
        ]);
        const result = await runHardChecks(harnessDir, '001-003-001-001', projectRoot);
        assert.equal(result.results.length, 1);
        const marker = getRunMarker();
        assert.ok(
          result.results[0].output.includes(marker),
          `Expected captured output to include getRunMarker() (${marker}), got: ${result.results[0].output}`
        );
      } finally {
        cleanup(projectRoot);
      }
    });
  } finally {
    if (hadOriginalMarkerEnv) {
      process.env[CC_ORCH_ACTIVE_RUN] = originalMarkerEnv;
    } else {
      delete process.env[CC_ORCH_ACTIVE_RUN];
    }
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
