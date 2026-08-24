/**
 * test-invalidation-forensics.js — Tests for `invalidatedAt` timestamp
 * stamping on task invalidation, distinct from `completedAt`.
 *
 * Section A:
 * TC1: transitionTask 'pending' → 'invalidated' stamps entry.invalidatedAt
 *      (present, Date.parse-able) and leaves entry.completedAt undefined.
 * TC2: transitionTask to 'complete' (capturing completedAt), then to
 *      'invalidated' — entry.completedAt remains strictly (===) equal to
 *      the captured value, while entry.invalidatedAt is present and not
 *      older than completedAt.
 * TC3: transitionTask to 'invalidated' from other legal prior statuses
 *      ('failed', 'blocked') stamps invalidatedAt in each case.
 *
 * Section B:
 * TC4: appendInvalidationRecord, called once against a fresh temp harness,
 *      creates <harnessDir>/analysis/invalidations.jsonl containing exactly
 *      one non-empty line, whose JSON.parse yields an object carrying
 *      `ts`, `taskId`, `reason`, `site` and `detail` with the values passed
 *      in (ts parseable by Date.parse).
 * TC5: two successive appendInvalidationRecord calls yield exactly two
 *      non-empty lines, each independently JSON.parse-able, with JSONL
 *      discipline holding (no embedded newlines, no pretty-printing, file
 *      ends with a single trailing newline).
 *
 * Section C:
 * TC6: appendInvalidationRecord fails soft when the append path is
 *      unwritable (analysis/ replaced by a regular file) — it returns
 *      without throwing, and the injected onLog collector receives at
 *      least one message identifying the failed invalidation-record
 *      append.
 * TC7: with that same failing append path in place, a real
 *      transitionTask(harnessDir, taskId, 'invalidated', ...) proceeds
 *      unchanged: the persisted task entry has status 'invalidated', a
 *      stamped invalidatedAt, and its invalidationReason still persisted.
 * TC8: consumer tolerance for a missing completedAt — a mission-state
 *      fixture containing an invalidated task with no completedAt does
 *      not make Pipeline._computeRestoreOverrides throw.
 *
 * Run: node test/test-invalidation-forensics.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { transitionTask } from '../src/orchestrator/core/state-machine.js';
import { appendInvalidationRecord } from '../src/orchestrator/core/state.js';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';

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

// ── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Create a temp project root with a `.harness` dir containing the structures
 * that transitionTask expects. Mirrors test-invalidation-reason.js.
 *
 * preStatus: { [taskId]: status } — seeds the task's initial status in the
 *   mission state JSON, instead of the default 'pending'.
 */
function createEnv(tasks, { preStatus = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-forensics-test-'));
  const harnessDir = path.join(root, '.harness');
  for (const sub of [
    'state',
    'verify',
    'verification',
    'progress',
    'analysis',
    'snapshots',
    'plan',
    'logs',
  ]) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(harnessDir, 'logs', 'token-usage.json'),
    JSON.stringify({ sessions: [], totals: {} })
  );

  const prdPath = path.join(root, 'spec.md');
  fs.writeFileSync(prdPath, '# spec');

  const byMission = new Map();
  for (const task of tasks) {
    if (!byMission.has(task.missionId)) byMission.set(task.missionId, []);
    byMission.get(task.missionId).push(task);
  }

  const milestones = { '001': { id: '001', status: 'in_progress', missions: {} } };

  for (const [missionId, missionTasks] of byMission.entries()) {
    milestones['001'].missions[missionId] = {
      id: missionId,
      status: 'in_progress',
      stateFile: `.harness/state/mission-${missionId}.json`,
    };
    const bySubMission = new Map();
    for (const t of missionTasks) {
      if (!bySubMission.has(t.subMissionId)) bySubMission.set(t.subMissionId, []);
      bySubMission.get(t.subMissionId).push(t);
    }
    const subMissions = {};
    for (const [smId, smTasks] of bySubMission.entries()) {
      const taskMap = {};
      for (const t of smTasks) {
        const entry = {
          id: t.id,
          description: t.description || 'test',
          status: preStatus[t.id] || 'pending',
          retryCount: 0,
        };
        taskMap[t.id] = entry;
      }
      subMissions[smId] = { id: smId, status: 'in_progress', tasks: taskMap };
    }
    fs.writeFileSync(
      path.join(harnessDir, 'state', `mission-${missionId}.json`),
      JSON.stringify(
        {
          id: missionId,
          missionId,
          description: 'test mission',
          status: 'in_progress',
          subMissions,
        },
        null,
        2
      )
    );
  }

  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(
      {
        projectMeta: {
          prdPath,
          createdAt: new Date().toISOString(),
          currentPhase: 'executing',
        },
        globalStatus: 'active',
        milestones,
      },
      null,
      2
    )
  );

  return { root, harnessDir };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/** Read mission state JSON for a task and return the task entry. */
function readTaskFromMissionState(harnessDir, taskId) {
  const missionId = taskId.split('-').slice(0, 2).join('-');
  const subMissionId = taskId.split('-').slice(0, 3).join('-');
  const data = JSON.parse(
    fs.readFileSync(
      path.join(harnessDir, 'state', `mission-${missionId}.json`),
      'utf8'
    )
  );
  return data.subMissions?.[subMissionId]?.tasks?.[taskId];
}

/**
 * Build a bare Pipeline for calling internal helpers directly, mirroring
 * test-invalidation-reason.js.
 */
function makeDrainPipeline(projectRoot) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    statusBar: false,
  });
  return { pipeline, logs };
}

/**
 * Remove the process signal listeners the Pipeline constructor registers.
 */
function teardownPipeline(pipeline) {
  const handlers = pipeline._signalHandlers || {};
  if (handlers.SIGINT) process.removeListener('SIGINT', handlers.SIGINT);
  if (handlers.SIGTERM) process.removeListener('SIGTERM', handlers.SIGTERM);
  if (handlers.exit) process.removeListener('exit', handlers.exit);
  if (handlers.uncaughtException)
    process.removeListener('uncaughtException', handlers.uncaughtException);
}

/**
 * Replace <harnessDir>/analysis (a directory, created by createEnv) with a
 * regular file so any subsequent fs.mkdirSync(analysisDir, {recursive:true})
 * or fs.appendFileSync into it fails — simulating an unwritable append path
 * for the invalidation-forensics append site.
 */
function breakAnalysisDir(harnessDir) {
  const analysisDir = path.join(harnessDir, 'analysis');
  fs.rmSync(analysisDir, { recursive: true, force: true });
  fs.writeFileSync(analysisDir, 'not a directory');
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function run() {
  // ── Section A ────────────────────────────────────────────────────────────

  // ── TC1: invalidate directly from pending ───────────────────────────────
  await test(
    "TC1 transitionTask 'pending' → 'invalidated' stamps invalidatedAt and leaves completedAt undefined",
    async () => {
      const task = {
        id: '001-003-001-001',
        missionId: '001-003',
        subMissionId: '001-003-001',
        description: 'task for TC1',
      };
      const env = createEnv([task]);
      try {
        await transitionTask(env.harnessDir, task.id, 'invalidated');
        const entry = readTaskFromMissionState(env.harnessDir, task.id);
        assert.ok(entry, 'task entry must exist in mission state');
        assert.strictEqual(entry.status, 'invalidated', 'task status must be invalidated');
        assert.ok(
          entry.invalidatedAt,
          `entry.invalidatedAt must be present, got: ${JSON.stringify(entry.invalidatedAt)}`
        );
        assert.ok(
          !Number.isNaN(Date.parse(entry.invalidatedAt)),
          `entry.invalidatedAt must be Date.parse-able, got: ${entry.invalidatedAt}`
        );
        assert.strictEqual(
          entry.completedAt,
          undefined,
          `entry.completedAt must be undefined, got: ${JSON.stringify(entry.completedAt)}`
        );
      } finally {
        cleanup(env.root);
      }
    }
  );

  // ── TC2: complete then invalidate ────────────────────────────────────────
  await test(
    "TC2 complete then invalidate → completedAt stays identical, invalidatedAt present and not older than completedAt",
    async () => {
      const task = {
        id: '001-003-001-002',
        missionId: '001-003',
        subMissionId: '001-003-001',
        description: 'task for TC2',
      };
      // Seed status directly at 'verified' so a single legal transition
      // ('verified' → 'complete') reaches 'complete' without needing the
      // verification-sidecar-gated 'awaiting_verification' → 'verified' hop.
      const env = createEnv([task], { preStatus: { [task.id]: 'verified' } });
      try {
        await transitionTask(env.harnessDir, task.id, 'complete');
        const afterComplete = readTaskFromMissionState(env.harnessDir, task.id);
        assert.strictEqual(afterComplete.status, 'complete', 'task status must be complete');
        const capturedCompletedAt = afterComplete.completedAt;
        assert.ok(
          capturedCompletedAt,
          `entry.completedAt must be present after complete, got: ${JSON.stringify(capturedCompletedAt)}`
        );

        // Small delay so invalidatedAt is guaranteed to be a later or equal
        // timestamp with meaningfully different clock ticks in most envs.
        await new Promise((resolve) => setTimeout(resolve, 5));

        await transitionTask(env.harnessDir, task.id, 'invalidated');
        const afterInvalidate = readTaskFromMissionState(env.harnessDir, task.id);
        assert.strictEqual(
          afterInvalidate.status,
          'invalidated',
          'task status must be invalidated'
        );
        assert.strictEqual(
          afterInvalidate.completedAt,
          capturedCompletedAt,
          `entry.completedAt must remain strictly equal to the captured value, ` +
            `expected: ${JSON.stringify(capturedCompletedAt)}, got: ${JSON.stringify(afterInvalidate.completedAt)}`
        );
        assert.ok(
          afterInvalidate.invalidatedAt,
          `entry.invalidatedAt must be present, got: ${JSON.stringify(afterInvalidate.invalidatedAt)}`
        );
        assert.ok(
          Date.parse(afterInvalidate.invalidatedAt) >= Date.parse(capturedCompletedAt),
          `entry.invalidatedAt (${afterInvalidate.invalidatedAt}) must not be older than ` +
            `completedAt (${capturedCompletedAt})`
        );
      } finally {
        cleanup(env.root);
      }
    }
  );

  // ── TC3: invalidate from other legal prior statuses ─────────────────────
  for (const priorStatus of ['failed', 'blocked']) {
    await test(
      `TC3 transitionTask '${priorStatus}' → 'invalidated' stamps invalidatedAt`,
      async () => {
        const task = {
          id: '001-003-001-003',
          missionId: '001-003',
          subMissionId: '001-003-001',
          description: `task for TC3 (${priorStatus})`,
        };
        const env = createEnv([task], { preStatus: { [task.id]: priorStatus } });
        try {
          await transitionTask(env.harnessDir, task.id, 'invalidated');
          const entry = readTaskFromMissionState(env.harnessDir, task.id);
          assert.ok(entry, 'task entry must exist in mission state');
          assert.strictEqual(entry.status, 'invalidated', 'task status must be invalidated');
          assert.ok(
            entry.invalidatedAt,
            `entry.invalidatedAt must be present for prior status '${priorStatus}', got: ${JSON.stringify(entry.invalidatedAt)}`
          );
          assert.ok(
            !Number.isNaN(Date.parse(entry.invalidatedAt)),
            `entry.invalidatedAt must be Date.parse-able for prior status '${priorStatus}', got: ${entry.invalidatedAt}`
          );
        } finally {
          cleanup(env.root);
        }
      }
    );
  }

  // ── Section B ────────────────────────────────────────────────────────────

  // ── TC4: first append creates invalidations.jsonl with exactly 1 line ───
  await test(
    'TC4 appendInvalidationRecord creates analysis/invalidations.jsonl with exactly 1 line carrying ts/taskId/reason/site/detail',
    async () => {
      const env = createEnv([]);
      try {
        const record = {
          taskId: '001-003-001-004',
          reason: 'spec-drift',
          site: 'orchestrator.reconcile',
          detail: { note: 'TC4 detail' },
        };
        appendInvalidationRecord(env.harnessDir, record);

        const filePath = path.join(env.harnessDir, 'analysis', 'invalidations.jsonl');
        assert.ok(fs.existsSync(filePath), 'analysis/invalidations.jsonl must be created');

        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.split('\n').filter((l) => l.length > 0);
        assert.strictEqual(lines.length, 1, `expected exactly 1 non-empty line, got: ${lines.length}`);

        const parsed = JSON.parse(lines[0]);
        assert.strictEqual(parsed.taskId, record.taskId, 'taskId must match');
        assert.strictEqual(parsed.reason, record.reason, 'reason must match');
        assert.strictEqual(parsed.site, record.site, 'site must match');
        assert.deepStrictEqual(parsed.detail, record.detail, 'detail must match');
        assert.ok(parsed.ts, `ts must be present, got: ${JSON.stringify(parsed.ts)}`);
        assert.ok(
          !Number.isNaN(Date.parse(parsed.ts)),
          `ts must be Date.parse-able, got: ${parsed.ts}`
        );
      } finally {
        cleanup(env.root);
      }
    }
  );

  // ── TC5: two appends → exactly 2 non-empty lines, JSONL discipline ──────
  await test(
    'TC5 two appendInvalidationRecord calls yield exactly 2 non-empty, independently parse-able lines with JSONL discipline',
    async () => {
      const env = createEnv([]);
      try {
        appendInvalidationRecord(env.harnessDir, {
          taskId: '001-003-001-005',
          reason: 'first-reason',
          site: 'orchestrator.first',
          detail: { seq: 1 },
        });
        appendInvalidationRecord(env.harnessDir, {
          taskId: '001-003-001-005',
          reason: 'second-reason',
          site: 'orchestrator.second',
          detail: { seq: 2 },
        });

        const filePath = path.join(env.harnessDir, 'analysis', 'invalidations.jsonl');
        const raw = fs.readFileSync(filePath, 'utf8');

        assert.ok(raw.endsWith('\n'), 'file content must end with a trailing newline');
        assert.ok(
          !raw.endsWith('\n\n'),
          'file content must end with a single trailing newline, not multiple'
        );

        const lines = raw.split('\n').filter((l) => l.length > 0);
        assert.strictEqual(lines.length, 2, `expected exactly 2 non-empty lines, got: ${lines.length}`);

        const parsedLines = lines.map((line, idx) => {
          assert.ok(
            !/^\s/.test(line),
            `line ${idx} must not start with whitespace (no pretty-printing), got: ${JSON.stringify(line)}`
          );
          return JSON.parse(line);
        });

        assert.strictEqual(parsedLines[0].reason, 'first-reason');
        assert.strictEqual(parsedLines[1].reason, 'second-reason');
        assert.strictEqual(parsedLines[0].site, 'orchestrator.first');
        assert.strictEqual(parsedLines[1].site, 'orchestrator.second');
      } finally {
        cleanup(env.root);
      }
    }
  );

  // ── Section C ────────────────────────────────────────────────────────────

  // ── TC6: injected append failure → fail-soft + onLog warning ────────────
  await test(
    'TC6 appendInvalidationRecord fails soft on an unwritable append path and reports it via onLog',
    async () => {
      const env = createEnv([]);
      try {
        breakAnalysisDir(env.harnessDir);

        const logs = [];
        let thrown = null;
        try {
          appendInvalidationRecord(
            env.harnessDir,
            {
              taskId: '001-003-001-006',
              reason: 'test-reason',
              site: 'orchestrator.tc6',
              detail: { note: 'TC6 detail' },
            },
            { onLog: (msg) => logs.push(msg) }
          );
        } catch (err) {
          thrown = err;
        }

        assert.strictEqual(
          thrown,
          null,
          `appendInvalidationRecord must not throw even when the append path is unwritable, got: ${thrown}`
        );
        assert.ok(
          logs.some((l) => /invalidation/i.test(l) && /append/i.test(l)),
          `expected onLog to receive a message identifying the failed invalidation-record append, got logs:\n${logs.join('\n')}`
        );
      } finally {
        cleanup(env.root);
      }
    }
  );

  // ── TC7: invalidation transition proceeds unchanged despite the append failing ──
  await test(
    "TC7 transitionTask to 'invalidated' proceeds unchanged while the invalidation-record append path is broken",
    async () => {
      const task = {
        id: '001-003-001-007',
        missionId: '001-003',
        subMissionId: '001-003-001',
        description: 'task for TC7',
      };
      const env = createEnv([task]);
      try {
        breakAnalysisDir(env.harnessDir);

        await transitionTask(env.harnessDir, task.id, 'invalidated', {
          invalidationReason: 'replaced',
        });

        const entry = readTaskFromMissionState(env.harnessDir, task.id);
        assert.ok(entry, 'task entry must exist in mission state');
        assert.strictEqual(entry.status, 'invalidated', 'task status must be invalidated');
        assert.ok(
          entry.invalidatedAt,
          `entry.invalidatedAt must be present, got: ${JSON.stringify(entry.invalidatedAt)}`
        );
        assert.ok(
          !Number.isNaN(Date.parse(entry.invalidatedAt)),
          `entry.invalidatedAt must be Date.parse-able, got: ${entry.invalidatedAt}`
        );
        assert.strictEqual(
          entry.invalidationReason,
          'replaced',
          `entry.invalidationReason must still be persisted, got: ${JSON.stringify(entry.invalidationReason)}`
        );
      } finally {
        cleanup(env.root);
      }
    }
  );

  // ── TC8: _computeRestoreOverrides tolerates an invalidated task with no completedAt ──
  await test(
    'TC8 Pipeline._computeRestoreOverrides tolerates an invalidated task lacking completedAt without throwing',
    async () => {
      const task = {
        id: '001-003-001-008',
        missionId: '001-003',
        subMissionId: '001-003-001',
        description: 'task for TC8',
      };
      // Seed the task directly as 'invalidated' with no completedAt field.
      const env = createEnv([task], { preStatus: { [task.id]: 'invalidated' } });
      const { pipeline } = makeDrainPipeline(env.root);
      try {
        // Populate this task's own 'after' snapshot dir so
        // _computeRestoreOverrides doesn't early-return on an empty walk —
        // this exercises the candidate-selection loop that must tolerate a
        // missing completedAt on the (self, invalidated) candidate.
        const snapshotDir = path.join(env.harnessDir, 'snapshots', task.id, 'after');
        fs.mkdirSync(snapshotDir, { recursive: true });
        fs.writeFileSync(path.join(snapshotDir, 'file.txt'), 'snapshot content');

        let result;
        let thrown = null;
        try {
          result = pipeline._computeRestoreOverrides(task, 'after');
        } catch (err) {
          thrown = err;
        }

        assert.strictEqual(
          thrown,
          null,
          `_computeRestoreOverrides must not throw for an invalidated task lacking completedAt, got: ${thrown}`
        );
        assert.ok(
          result && typeof result === 'object',
          `_computeRestoreOverrides must return an object, got: ${JSON.stringify(result)}`
        );
      } finally {
        teardownPipeline(pipeline);
        cleanup(env.root);
      }
    }
  );

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

run();
