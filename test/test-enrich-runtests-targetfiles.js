/**
 * test-enrich-runtests-targetfiles.js — Unit tests for
 * planner.enrichTestTaskTargetFiles.
 *
 * Covers the spec's acceptance criteria:
 *   TC-1: test-task gets scripts/run-tests.js injected
 *   TC-2: non-test task is left untouched
 *   TC-3: idempotent — no duplicate entry on repeated calls
 *   TC-4: no-manifest repo is a no-op (tmp dir with no scripts/run-tests.js)
 *   TC-5: multiple subMissions / multiple tasks each handled independently
 *   TC-6: injected path is exactly the literal 'scripts/run-tests.js'
 *   TC-7: serialization precondition — two test-creating tasks share
 *         scripts/run-tests.js so the hasFileConflict set-intersection
 *         (keyed by normalizeTargetFile) reports a conflict.
 *
 * Run: node test/test-enrich-runtests-targetfiles.js
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { enrichTestTaskTargetFiles } from '../src/orchestrator/agents/planner.js';
import { normalizeTargetFile } from '../src/orchestrator/core/path-utils.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  const run = async () => {
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
  };
  return run();
}

// ── Test fixture helpers ─────────────────────────────────────────────────────

// A project root that DOES have scripts/run-tests.js — use the real repo root,
// which contains scripts/run-tests.js (this very test runner).
const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);

function makeTmpRepoWithoutManifest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-no-manifest-'));
  // Intentionally do NOT create scripts/run-tests.js.
  return dir;
}

// ── TC-1: test-task gets scripts/run-tests.js injected ───────────────────────

await test('TC-1: a test-creating task gets scripts/run-tests.js injected', async () => {
  const decomp = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 't-001', targetFiles: ['test/test-foo.js'] },
        ],
      },
    ],
  };

  enrichTestTaskTargetFiles(decomp, repoRoot);

  assert.ok(
    decomp.subMissions[0].tasks[0].targetFiles.includes('scripts/run-tests.js'),
    'test-task should have scripts/run-tests.js injected',
  );
});

// ── TC-2: non-test task is left untouched ────────────────────────────────────

await test('TC-2: a non-test task is NOT touched', async () => {
  const decomp = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 't-001', targetFiles: ['src/orchestrator/core/pipeline.js'] },
        ],
      },
    ],
  };

  enrichTestTaskTargetFiles(decomp, repoRoot);

  assert.ok(
    !decomp.subMissions[0].tasks[0].targetFiles.includes('scripts/run-tests.js'),
    'non-test task should NOT have scripts/run-tests.js injected',
  );
  assert.deepStrictEqual(
    decomp.subMissions[0].tasks[0].targetFiles,
    ['src/orchestrator/core/pipeline.js'],
    'non-test task targetFiles should be unchanged',
  );
});

// ── TC-3: idempotent — no duplicate entry ────────────────────────────────────

await test('TC-3: injection is idempotent (no duplicate on repeated calls)', async () => {
  const decomp = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 't-001', targetFiles: ['test/test-foo.js'] },
        ],
      },
    ],
  };

  enrichTestTaskTargetFiles(decomp, repoRoot);
  enrichTestTaskTargetFiles(decomp, repoRoot);

  const count = decomp.subMissions[0].tasks[0].targetFiles.filter(
    (f) => f === 'scripts/run-tests.js',
  ).length;
  assert.strictEqual(count, 1, 'scripts/run-tests.js should appear exactly once');
});

// ── TC-4: no-manifest repo is a no-op ────────────────────────────────────────

await test('TC-4: no-op when the project has no scripts/run-tests.js', async () => {
  const tmpRoot = makeTmpRepoWithoutManifest();
  try {
    const decomp = {
      subMissions: [
        {
          id: 'sm-001',
          tasks: [
            { id: 't-001', targetFiles: ['test/test-foo.js'] },
          ],
        },
      ],
    };

    enrichTestTaskTargetFiles(decomp, tmpRoot);

    assert.ok(
      !decomp.subMissions[0].tasks[0].targetFiles.includes('scripts/run-tests.js'),
      'no manifest → no injection',
    );
    assert.deepStrictEqual(
      decomp.subMissions[0].tasks[0].targetFiles,
      ['test/test-foo.js'],
      'targetFiles should be untouched when no manifest exists',
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── TC-5: multiple subMissions / tasks each handled independently ────────────

await test('TC-5: multiple subMissions and tasks are handled independently', async () => {
  const decomp = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 't-001', targetFiles: ['test/test-a.js'] },          // test → inject
          { id: 't-002', targetFiles: ['src/foo.js'] },              // non-test → skip
        ],
      },
      {
        id: 'sm-002',
        tasks: [
          { id: 't-003', targetFiles: ['src/bar/__tests__/x.js'] },  // test → inject
          { id: 't-004', targetFiles: ['docs/readme.md'] },          // non-test → skip
        ],
      },
    ],
  };

  enrichTestTaskTargetFiles(decomp, repoRoot);

  const t1 = decomp.subMissions[0].tasks[0];
  const t2 = decomp.subMissions[0].tasks[1];
  const t3 = decomp.subMissions[1].tasks[0];
  const t4 = decomp.subMissions[1].tasks[1];

  assert.ok(t1.targetFiles.includes('scripts/run-tests.js'), 't-001 (test) should be injected');
  assert.ok(!t2.targetFiles.includes('scripts/run-tests.js'), 't-002 (non-test) should be skipped');
  assert.ok(t3.targetFiles.includes('scripts/run-tests.js'), 't-003 (test) should be injected');
  assert.ok(!t4.targetFiles.includes('scripts/run-tests.js'), 't-004 (non-test) should be skipped');
});

// ── TC-6: injected path is exactly the literal 'scripts/run-tests.js' ────────

await test('TC-6: injected path is exactly the literal scripts/run-tests.js', async () => {
  const decomp = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 't-001', targetFiles: ['test/test-foo.js'] },
        ],
      },
    ],
  };

  enrichTestTaskTargetFiles(decomp, repoRoot);

  const injected = decomp.subMissions[0].tasks[0].targetFiles.filter(
    (f) => f.endsWith('run-tests.js'),
  );
  assert.deepStrictEqual(
    injected,
    ['scripts/run-tests.js'],
    'the injected entry must be the literal relative path scripts/run-tests.js',
  );
});

// ── TC-7: serialization precondition — both test-tasks share the manifest ────
//
// hasFileConflict (scheduler.js, private) is a set-intersection keyed by
// normalizeTargetFile(projectRoot, file). We do NOT widen the scheduler API
// to call it directly; instead we assert its conflict precondition faithfully:
// after enrichment, both test-creating tasks declare scripts/run-tests.js, and
// the two declarations normalize to the same conflict key — exactly what makes
// hasFileConflict report a conflict and serialize the tasks.

await test('TC-7: two test-creating tasks share the scripts/run-tests.js conflict key', async () => {
  const decomp = {
    subMissions: [
      {
        id: 'sm-001',
        tasks: [
          { id: 't-001', targetFiles: ['test/test-a.js'] },
          { id: 't-002', targetFiles: ['test/test-b.js'] },
        ],
      },
    ],
  };

  enrichTestTaskTargetFiles(decomp, repoRoot);

  const [taskA, taskB] = decomp.subMissions[0].tasks;

  // Both must declare the shared manifest.
  assert.ok(taskA.targetFiles.includes('scripts/run-tests.js'), 'taskA declares manifest');
  assert.ok(taskB.targetFiles.includes('scripts/run-tests.js'), 'taskB declares manifest');

  // Reproduce the hasFileConflict set-intersection: lock taskA's files, then
  // check taskB's files against that locked set using the same key function.
  const runningFiles = new Set(
    taskA.targetFiles.map((f) => normalizeTargetFile(repoRoot, f)),
  );
  const conflict = taskB.targetFiles.some(
    (f) => runningFiles.has(normalizeTargetFile(repoRoot, f)),
  );

  assert.ok(
    conflict,
    'the two test-creating tasks must conflict on scripts/run-tests.js (they serialize)',
  );
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
