#!/usr/bin/env node

/**
 * test-task-reset.js — Unit tests for:
 *   - snapshotFiles (src/orchestrator/core/snapshots.js)
 *   - the `reset` command (src/cli/commands/reset.js)
 *
 * Hermetic: builds fixtures under fs.mkdtemp roots and calls the modules
 * under test directly, in-process. Never imports or reaches the real SDK,
 * a session, or the network — only node builtins plus local project
 * modules (snapshots.js, reset.js, scheduler.js's canonicalTaskId).
 *
 * No external test framework. Run: node test/test-task-reset.js
 *
 * Covers:
 *   TC1 — snapshotFiles: capture [A, B] then re-capture with only [A] listed
 *         -> the phase dir afterward contains exactly A (B evicted)
 *   TC2 — snapshotFiles: a file listed but absent on disk at capture time is
 *         absent from the phase dir afterward, and the capture call does
 *         not throw
 *   TC3 — reset: against a fixture harness dir, flips the target task to
 *         status 'pending'/retryCount 0 in its state/mission-*.json,
 *         removes the canonical scheduler.replanAttempts entry from
 *         <harnessDir>/state.json, deletes
 *         analysis/history-<canonicalId>.json, and deletes
 *         snapshots/<taskId>/
 *   TC4 — reset: resetting a '-rp-NNN' replacement id clears the CANONICAL
 *         replanAttempts entry (keyed without the -rp suffix)
 *   TC5 — reset: an unknown task id produces a non-zero exit status and
 *         mutates nothing (fixture tree identical before and after)
 *   TC6 — reset: a second identical reset run on the same valid id exits 0
 *         and its captured stdout reports the already-absent items as
 *         not-found
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { snapshotFiles } from '../src/orchestrator/core/snapshots.js';
import { reset } from '../src/cli/commands/reset.js';
import { canonicalTaskId } from '../src/orchestrator/core/scheduler.js';

function main() {
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

  /**
   * Capture console.log/console.error output from a callback, restoring
   * the original functions afterward (even if fn throws).
   * @param {Function} fn
   * @returns {{ stdout: string[], stderr: string[] }}
   */
  function captureOutput(fn) {
    const stdout = [];
    const stderr = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => stdout.push(args.map(String).join(' '));
    console.error = (...args) => stderr.push(args.map(String).join(' '));
    try {
      fn();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    return { stdout, stderr };
  }

  /**
   * Recursively snapshots every regular file under `root` as a
   * { relPath: content } map (relPath relative to root, POSIX-joined via
   * path.relative). Returns {} when root does not exist.
   * @param {string} root
   * @returns {Record<string,string>}
   */
  function snapshotTree(root) {
    const out = {};
    function walk(dir) {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile()) {
          out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
        }
      }
    }
    walk(root);
    return out;
  }

  function canonJson(obj) {
    const sorted = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return JSON.stringify(sorted);
  }

  console.log('=== test-task-reset Tests ===\n');

  // ── TC1: snapshotFiles — capture [A, B] then re-capture [A] -> B evicted ──
  console.log('TC1: snapshotFiles — capture [A, B] then re-capture [A] -> B evicted');
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-task-reset-tc1-'));
    const projectRoot = path.join(tmpRoot, 'project');
    const harnessDir = path.join(tmpRoot, 'harness');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(harnessDir, { recursive: true });

    fs.writeFileSync(path.join(projectRoot, 'a.txt'), 'A content', 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'b.txt'), 'B content', 'utf8');

    const taskId = 'snap-task-1';
    const phase = 'before';
    const phaseDir = path.join(harnessDir, 'snapshots', taskId, phase);

    snapshotFiles(harnessDir, projectRoot, taskId, phase, ['a.txt', 'b.txt']);
    const afterFirstCapture = fs.readdirSync(phaseDir).sort();
    assert(
      'TC1: first capture contains both a.txt and b.txt',
      JSON.stringify(afterFirstCapture) === JSON.stringify(['a.txt', 'b.txt'])
    );

    snapshotFiles(harnessDir, projectRoot, taskId, phase, ['a.txt']);
    const afterSecondCapture = fs.readdirSync(phaseDir).sort();
    assert(
      'TC1: re-capture with only [a.txt] listed contains exactly a.txt',
      JSON.stringify(afterSecondCapture) === JSON.stringify(['a.txt'])
    );
    assert(
      'TC1: b.txt was evicted from the phase dir after re-capture',
      !fs.existsSync(path.join(phaseDir, 'b.txt'))
    );

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // ── TC2: snapshotFiles — a listed-but-missing file is absent afterward ────
  console.log('\nTC2: snapshotFiles — listed-but-missing-on-disk file is absent afterward');
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-task-reset-tc2-'));
    const projectRoot = path.join(tmpRoot, 'project');
    const harnessDir = path.join(tmpRoot, 'harness');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(harnessDir, { recursive: true });

    fs.writeFileSync(path.join(projectRoot, 'c.txt'), 'C content', 'utf8');
    // 'missing.txt' is intentionally never created on disk.

    const taskId = 'snap-task-2';
    const phase = 'before';
    const phaseDir = path.join(harnessDir, 'snapshots', taskId, phase);

    let threw = false;
    try {
      snapshotFiles(harnessDir, projectRoot, taskId, phase, ['c.txt', 'missing.txt']);
    } catch {
      threw = true;
    }
    assert('TC2: capture call does not throw on a missing listed file', !threw);
    assert('TC2: c.txt (present on disk) is captured', fs.existsSync(path.join(phaseDir, 'c.txt')));
    assert(
      'TC2: missing.txt (absent on disk) is absent from the phase dir afterward',
      !fs.existsSync(path.join(phaseDir, 'missing.txt'))
    );

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // ── TC3: reset — mission state, replanAttempts, history, snapshots all clear ──
  console.log('\nTC3: reset — mission state/replanAttempts/history/snapshots all clear');
  let tc3TaskId;
  let tc3ProjectRoot;
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-task-reset-tc3-'));
    const harnessDir = path.join(tmpRoot, '.harness');
    const stateDir = path.join(harnessDir, 'state');
    const analysisDir = path.join(harnessDir, 'analysis');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(analysisDir, { recursive: true });

    const taskId = 'task-alpha-001';
    const canonicalId = canonicalTaskId(taskId); // no -rp suffix: same as taskId

    fs.writeFileSync(
      path.join(stateDir, 'mission-m1.json'),
      JSON.stringify({
        subMissions: {
          sm1: {
            tasks: {
              [taskId]: {
                id: taskId,
                description: 'do a thing',
                status: 'failed',
                retryCount: 2,
                targetFiles: [],
              },
            },
          },
        },
      }, null, 2),
      'utf8'
    );

    fs.writeFileSync(
      path.join(harnessDir, 'state.json'),
      JSON.stringify({ scheduler: { replanAttempts: { [canonicalId]: 1 } } }, null, 2),
      'utf8'
    );

    const historyPath = path.join(analysisDir, `history-${canonicalId}.json`);
    fs.writeFileSync(historyPath, JSON.stringify({ some: 'history' }), 'utf8');

    const snapshotTaskDir = path.join(harnessDir, 'snapshots', taskId);
    fs.mkdirSync(path.join(snapshotTaskDir, 'before'), { recursive: true });
    fs.mkdirSync(path.join(snapshotTaskDir, 'after'), { recursive: true });
    fs.writeFileSync(path.join(snapshotTaskDir, 'before', 'f.txt'), 'before content', 'utf8');
    fs.writeFileSync(path.join(snapshotTaskDir, 'after', 'f.txt'), 'after content', 'utf8');

    process.exitCode = 0;
    captureOutput(() => reset(tmpRoot, taskId));

    const missionAfter = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'mission-m1.json'), 'utf8')
    );
    const taskAfter = missionAfter.subMissions.sm1.tasks[taskId];
    assert('TC3: task status flipped to pending', taskAfter.status === 'pending');
    assert('TC3: task retryCount reset to 0', taskAfter.retryCount === 0);

    const stateJsonAfter = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    assert(
      'TC3: canonical replanAttempts entry removed from state.json',
      !Object.prototype.hasOwnProperty.call(stateJsonAfter.scheduler.replanAttempts, canonicalId)
    );

    assert('TC3: analysis history file deleted', !fs.existsSync(historyPath));
    assert('TC3: snapshots/<taskId>/ deleted', !fs.existsSync(snapshotTaskDir));

    // Keep this fixture root around for TC6 (re-run reset on the same id).
    tc3TaskId = taskId;
    tc3ProjectRoot = tmpRoot;
  }

  // ── TC4: reset — a '-rp-NNN' replacement id clears the CANONICAL replanAttempts entry ──
  console.log("\nTC4: reset — '-rp-NNN' replacement id clears the CANONICAL replanAttempts entry");
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-task-reset-tc4-'));
    const harnessDir = path.join(tmpRoot, '.harness');
    const stateDir = path.join(harnessDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const baseId = 'task-beta-002';
    const replacementId = `${baseId}-rp-001`;
    const canonicalId = canonicalTaskId(replacementId);
    assert('TC4 setup: canonicalTaskId strips the -rp suffix', canonicalId === baseId);

    fs.writeFileSync(
      path.join(stateDir, 'mission-m1.json'),
      JSON.stringify({
        subMissions: {
          sm1: {
            tasks: {
              [replacementId]: {
                id: replacementId,
                description: 'replacement task',
                status: 'failed',
                retryCount: 1,
                targetFiles: [],
              },
            },
          },
        },
      }, null, 2),
      'utf8'
    );

    fs.writeFileSync(
      path.join(harnessDir, 'state.json'),
      JSON.stringify({ scheduler: { replanAttempts: { [canonicalId]: 3 } } }, null, 2),
      'utf8'
    );

    process.exitCode = 0;
    captureOutput(() => reset(tmpRoot, replacementId));

    const stateJsonAfter = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    assert(
      'TC4: replanAttempts entry keyed by the CANONICAL id (suffix stripped) was removed',
      !Object.prototype.hasOwnProperty.call(stateJsonAfter.scheduler.replanAttempts, canonicalId)
    );

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // ── TC5: reset — unknown task id exits non-zero and mutates nothing ──────
  console.log('\nTC5: reset — unknown task id exits non-zero and mutates nothing');
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-task-reset-tc5-'));
    const harnessDir = path.join(tmpRoot, '.harness');
    const stateDir = path.join(harnessDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    fs.writeFileSync(
      path.join(stateDir, 'mission-m1.json'),
      JSON.stringify({
        subMissions: {
          sm1: {
            tasks: {
              'other-task-1': {
                id: 'other-task-1',
                description: 'unrelated task',
                status: 'pending',
                retryCount: 0,
                targetFiles: [],
              },
            },
          },
        },
      }, null, 2),
      'utf8'
    );

    const before = snapshotTree(tmpRoot);

    process.exitCode = 0;
    const { stderr } = captureOutput(() => reset(tmpRoot, 'does-not-exist-id'));

    assert('TC5: exit status is non-zero', process.exitCode === 1);
    assert(
      'TC5: refusal message mentions the unknown id',
      stderr.join('\n').includes('does-not-exist-id')
    );

    const after = snapshotTree(tmpRoot);
    assert('TC5: fixture tree unchanged before vs after', canonJson(before) === canonJson(after));

    process.exitCode = 0;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // ── TC6: reset — a second identical run exits 0 and reports not-found items ──
  console.log('\nTC6: reset — second identical run exits 0 and reports not-found items');
  {
    // Reuses the TC3 fixture root: that task is now 'pending'/retryCount 0,
    // and its replanAttempts/history/snapshots items were already deleted.
    process.exitCode = 0;
    const { stdout } = captureOutput(() => reset(tc3ProjectRoot, tc3TaskId));

    assert('TC6: second run leaves exit status at 0', process.exitCode === 0);

    const allOutput = stdout.join('\n').toLowerCase();
    assert(
      'TC6: stdout reports the replanAttempts item as not found',
      allOutput.includes('replanattempts') && allOutput.includes('not found')
    );
    assert(
      'TC6: stdout reports the analysis history item as not found',
      allOutput.includes('history') && allOutput.includes('not found')
    );
    assert(
      'TC6: stdout reports the snapshots item as not found',
      allOutput.includes('snapshots') && allOutput.includes('not found')
    );

    fs.rmSync(tc3ProjectRoot, { recursive: true, force: true });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  // reset() sets process.exitCode = 1 on its refusal paths (TC5) as a side
  // effect of the real CLI behavior under test. That is correct CLI
  // behavior but must not leak into this suite's own pass/fail exit code —
  // reset it here based on the suite's actual assertion tally.
  process.exitCode = 0;

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
