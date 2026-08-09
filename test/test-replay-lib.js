/**
 * test-replay-lib.js — Unit tests for scripts/replay-lib.js.
 *
 * Builds throwaway archive fixtures under fs.mkdtempSync(os.tmpdir()) from
 * trimmed-recording constants declared in this file. Imports nothing from,
 * and reads nothing under, the repo's archives/ directory.
 *
 * Run: node test/test-replay-lib.js
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readSpecPair,
  reconstructPlansFromArchive,
  readRecordedOutcomes,
  loadSessionRecordings,
  loadArchiveBundle,
  createFakeSessionManager,
  RecordingExhaustedError,
  compareReplay,
} from '../scripts/replay-lib.js';

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

// ---------- Trimmed-recording fixture constants ----------

const SPEC_MD = `# Replay Lib Fixture Spec

## Goal
A trimmed fixture spec used only to exercise replay-lib.js readers.

## Acceptance Criteria
- Task 001-001-001-001 lands a.js
- Task 001-001-001-002 lands b.js
`;

const SPEC_JSON = {
  goal: 'A trimmed fixture spec used only to exercise replay-lib.js readers.',
  target_files: ['a.js', 'b.js'],
  acceptance_criteria: [
    {
      description: 'Task 001-001-001-001 lands a.js',
      verification: {
        kind: 'command',
        command: 'node test/test-a.js',
        targetFile: 'test/test-a.js',
      },
    },
    {
      description: 'Task 001-001-001-002 lands b.js',
      verification: {
        kind: 'command',
        command: 'node test/test-b.js',
        targetFile: 'test/test-b.js',
      },
    },
  ],
  constraints: [],
};

// Tasks are declared OUT of id order (002 before 001) on purpose — TC-L1
// asserts reconstructPlansFromArchive re-sorts them by id.
const MISSION_STATE = {
  id: '001-001',
  missionId: '001-001',
  description: 'Trimmed fixture mission for replay-lib tests',
  status: 'complete',
  subMissions: {
    '001-001-001': {
      id: '001-001-001',
      description: 'Trimmed fixture sub-mission with two complete tasks',
      status: 'complete',
      tasks: {
        '001-001-001-002': {
          id: '001-001-001-002',
          description: 'Second fixture task',
          status: 'complete',
          createdAt: '2026-05-10T10:00:00.000Z',
          startedAt: '2026-05-10T10:06:00.000Z',
          completedAt: '2026-05-10T10:10:00.000Z',
          targetFiles: ['b.js'],
          dependencies: ['001-001-001-001'],
          testCases: ['TC2: b.js is created'],
          tracesScenario: ['S2'],
          patternReferences: [],
          dataSchemas: [],
          verifyFile: null,
          progressFile: null,
          verificationFile: null,
          retryCount: 0,
        },
        '001-001-001-001': {
          id: '001-001-001-001',
          description: 'First fixture task',
          status: 'complete',
          createdAt: '2026-05-10T10:00:00.000Z',
          startedAt: '2026-05-10T10:01:00.000Z',
          completedAt: '2026-05-10T10:05:00.000Z',
          targetFiles: ['a.js'],
          dependencies: [],
          testCases: ['TC1: a.js is created'],
          tracesScenario: ['S1'],
          patternReferences: [],
          dataSchemas: [],
          verifyFile: null,
          progressFile: null,
          verificationFile: null,
          retryCount: 0,
        },
      },
    },
  },
};

const LOG_JSONL_NAME = '2026-05-10T10-00-00-000Z-executor-001-001-001-001.jsonl';
const LOG_JSONL_CONTENT =
  '{"type":"session_start","name":"executor-001-001-001-001","role":"executor"}\n' +
  '{"type":"tool_call","name":"Write","input":{"file_path":"a.js"}}\n' +
  '{"type":"exit","data":{"result":{"structured_output":{"status":"COMPLETED"}}}}\n' +
  '{"type":"session_end","name":"executor-001-001-001-001"}\n';

/**
 * Build JSONL content for a throwaway session-recording fixture file.
 *
 * @param {{ name?: string, structuredOutput?: object, includeExit?: boolean }} [opts]
 * @returns {string}
 */
function makeRecordingContent(opts = {}) {
  const { name = 'executor-001-001-001-001', structuredOutput = { status: 'COMPLETED' }, includeExit = true } = opts;
  let content = `{"type":"session_start","name":"${name}","role":"executor"}\n`;
  content += '{"type":"tool_call","name":"Write","input":{"file_path":"a.js"}}\n';
  if (includeExit) {
    content += JSON.stringify({ type: 'exit', data: { result: { structured_output: structuredOutput } } }) + '\n';
  }
  content += `{"type":"session_end","name":"${name}"}\n`;
  return content;
}

const SESSION_SUMMARY = [
  {
    name: 'executor-001-001-001-001',
    role: 'executor',
    inputTokens: 100,
    outputTokens: 200,
    cacheCreation: 1000,
    cacheRead: 5000,
    totalCost: 0.05,
    toolCalls: 5,
    durationMs: 10000,
    startedAt: '2026-05-10T10:01:00.000Z',
    finishedAt: '2026-05-10T10:05:00.000Z',
  },
];

const TOKEN_USAGE = {
  totals: {
    totalCostUsd: 0.05,
    sessionCount: 1,
    inputTokens: 100,
    outputTokens: 200,
    cacheCreation: 1000,
    cacheRead: 5000,
  },
  sessions: [
    {
      name: 'executor-001-001-001-001',
      type: 'executor',
      timestamp: '2026-05-10T10:01:00.000Z',
      inputTokens: 100,
      outputTokens: 200,
      cacheCreation: 1000,
      cacheRead: 5000,
      totalCostUsd: 0.05,
    },
  ],
};

const REVIEW_MILESTONE_001 = {
  result: 'PASSED',
  findings: [
    {
      severity: 'warning',
      category: 'functional',
      file: 'a.js',
      description: 'trimmed fixture finding',
      relatedFiles: [],
    },
  ],
  notes: 'ok',
  scopeCompliance: {
    verdict: 'within_scope',
    evidence: 'trimmed fixture evidence',
  },
};

const TASK_REGRESSION_001_001 = {
  result: 'PASSED',
  notes: 'trimmed fixture regression result',
};

/**
 * Build a throwaway archive fixture under a fresh mkdtemp directory from the
 * trimmed-recording constants above.
 *
 * @param {{ includeSpecJson?: boolean, specMd?: string, specJson?: object,
 *   missionState?: object, logFiles?: Array<{ name: string, content: string }> }} [overrides]
 * @returns {string} archiveDir
 */
function makeArchiveFixture(overrides = {}) {
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-lib-'));

  fs.writeFileSync(path.join(archiveDir, 'spec.md'), overrides.specMd ?? SPEC_MD);
  if (overrides.includeSpecJson !== false) {
    fs.writeFileSync(
      path.join(archiveDir, 'spec.json'),
      JSON.stringify(overrides.specJson ?? SPEC_JSON, null, 2)
    );
  }

  const stateDir = path.join(archiveDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'mission-001-001.json'),
    JSON.stringify(overrides.missionState ?? MISSION_STATE, null, 2)
  );

  const logsDir = path.join(archiveDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logFiles = overrides.logFiles ?? [{ name: LOG_JSONL_NAME, content: LOG_JSONL_CONTENT }];
  for (const { name, content } of logFiles) {
    fs.writeFileSync(path.join(logsDir, name), content);
  }
  fs.writeFileSync(
    path.join(logsDir, 'session-summary.json'),
    JSON.stringify(SESSION_SUMMARY, null, 2)
  );
  fs.writeFileSync(path.join(logsDir, 'token-usage.json'), JSON.stringify(TOKEN_USAGE, null, 2));

  const verificationDir = path.join(archiveDir, 'verification');
  fs.mkdirSync(verificationDir, { recursive: true });
  fs.writeFileSync(
    path.join(verificationDir, 'review-milestone-001.json'),
    JSON.stringify(REVIEW_MILESTONE_001, null, 2)
  );
  fs.writeFileSync(
    path.join(verificationDir, 'task-regression-001-001.json'),
    JSON.stringify(TASK_REGRESSION_001_001, null, 2)
  );

  return archiveDir;
}

// ---------- TC-L1: reconstructPlansFromArchive ----------
await test('TC-L1 reconstructPlansFromArchive returns tasks ordered by id with array fields preserved', () => {
  const archiveDir = makeArchiveFixture();
  try {
    const plans = reconstructPlansFromArchive(archiveDir);

    assert.ok(plans instanceof Map, 'Expected reconstructPlansFromArchive to return a Map');
    assert.ok(plans.has('001-001'), `Expected plans to have key '001-001', got: ${[...plans.keys()].join(', ')}`);

    const decomp = plans.get('001-001');
    assert.ok(Array.isArray(decomp.subMissions), 'Expected decomp.subMissions to be an array');
    assert.strictEqual(decomp.subMissions.length, 1, `Expected 1 sub-mission, got ${decomp.subMissions.length}`);

    const tasks = decomp.subMissions[0].tasks;
    assert.ok(Array.isArray(tasks), 'Expected tasks to be an array');
    assert.strictEqual(tasks.length, 2, `Expected 2 tasks, got ${tasks.length}`);

    // Ordered by id despite being declared out-of-order in the fixture.
    assert.strictEqual(tasks[0].id, '001-001-001-001', `Expected first task id='001-001-001-001', got '${tasks[0].id}'`);
    assert.strictEqual(tasks[1].id, '001-001-001-002', `Expected second task id='001-001-001-002', got '${tasks[1].id}'`);

    // Array fields preserved verbatim.
    assert.deepStrictEqual(tasks[0].targetFiles, ['a.js']);
    assert.deepStrictEqual(tasks[0].dependencies, []);
    assert.deepStrictEqual(tasks[0].testCases, ['TC1: a.js is created']);
    assert.deepStrictEqual(tasks[0].tracesScenario, ['S1']);

    assert.deepStrictEqual(tasks[1].targetFiles, ['b.js']);
    assert.deepStrictEqual(tasks[1].dependencies, ['001-001-001-001']);
    assert.deepStrictEqual(tasks[1].testCases, ['TC2: b.js is created']);
    assert.deepStrictEqual(tasks[1].tracesScenario, ['S2']);
  } finally {
    fs.rmSync(archiveDir, { recursive: true });
  }
});

// ---------- TC-L2: readSpecPair ----------
await test('TC-L2 readSpecPair returns { md, json } from the fixture and json===null when spec.json is absent', () => {
  const archiveDir = makeArchiveFixture();
  try {
    const { md, json } = readSpecPair(archiveDir);
    assert.strictEqual(md, SPEC_MD, 'Expected md to equal the fixture spec.md text verbatim');
    assert.deepStrictEqual(json, SPEC_JSON, 'Expected json to deeply equal the fixture spec.json contents');
  } finally {
    fs.rmSync(archiveDir, { recursive: true });
  }

  const noSpecJsonDir = makeArchiveFixture({ includeSpecJson: false });
  try {
    const { md, json } = readSpecPair(noSpecJsonDir);
    assert.strictEqual(md, SPEC_MD, 'Expected md to still be readable without spec.json');
    assert.strictEqual(json, null, `Expected json===null when spec.json is absent, got ${JSON.stringify(json)}`);
  } finally {
    fs.rmSync(noSpecJsonDir, { recursive: true });
  }
});

// ---------- TC-L3: readRecordedOutcomes ----------
await test('TC-L3 readRecordedOutcomes returns taskStatuses, review and regression conclusions from the fixture', () => {
  const archiveDir = makeArchiveFixture();
  try {
    const { taskStatuses, review, regression } = readRecordedOutcomes(archiveDir);

    assert.ok(taskStatuses instanceof Map, 'Expected taskStatuses to be a Map');
    assert.strictEqual(
      taskStatuses.get('001-001-001-001'),
      'complete',
      `Expected 001-001-001-001 status='complete', got '${taskStatuses.get('001-001-001-001')}'`
    );
    assert.strictEqual(
      taskStatuses.get('001-001-001-002'),
      'complete',
      `Expected 001-001-001-002 status='complete', got '${taskStatuses.get('001-001-001-002')}'`
    );

    assert.ok(review instanceof Map, 'Expected review to be a Map');
    assert.ok(review.has('001'), `Expected review to have key '001', got: ${[...review.keys()].join(', ')}`);
    assert.strictEqual(review.get('001').result, 'PASSED', `Expected review['001'].result='PASSED', got '${review.get('001').result}'`);
    assert.deepStrictEqual(
      review.get('001').findings,
      REVIEW_MILESTONE_001.findings,
      'Expected review findings to match the fixture review-milestone-001.json findings'
    );

    assert.ok(regression instanceof Map, 'Expected regression to be a Map');
    assert.ok(regression.has('001-001'), `Expected regression to have key '001-001', got: ${[...regression.keys()].join(', ')}`);
    assert.strictEqual(
      regression.get('001-001'),
      'PASSED',
      `Expected regression['001-001']='PASSED', got '${regression.get('001-001')}'`
    );
  } finally {
    fs.rmSync(archiveDir, { recursive: true });
  }
});

// ---------- TC-R1: loadSessionRecordings — distinct executor task ids ----------
await test('TC-R1 loadSessionRecordings returns distinct identity keys for different executor task ids', () => {
  const logFiles = [
    {
      name: '2026-05-10T10-00-00-000Z-executor-001-001-001-001.jsonl',
      content: makeRecordingContent({ name: 'executor-001-001-001-001', structuredOutput: { status: 'COMPLETED', task: '001-001-001-001' } }),
    },
    {
      name: '2026-05-10T10-02-00-000Z-executor-001-001-001-002.jsonl',
      content: makeRecordingContent({ name: 'executor-001-001-001-002', structuredOutput: { status: 'COMPLETED', task: '001-001-001-002' } }),
    },
  ];
  const archiveDir = makeArchiveFixture({ logFiles });
  try {
    const recordings = loadSessionRecordings(archiveDir);

    assert.ok(recordings instanceof Map, 'Expected loadSessionRecordings to return a Map');
    assert.strictEqual(recordings.size, 2, `Expected 2 identity keys, got ${recordings.size}: ${[...recordings.keys()].join(', ')}`);
    assert.ok(
      recordings.has('executor:001-001-001-001'),
      `Expected key 'executor:001-001-001-001', got: ${[...recordings.keys()].join(', ')}`
    );
    assert.ok(
      recordings.has('executor:001-001-001-002'),
      `Expected key 'executor:001-001-001-002', got: ${[...recordings.keys()].join(', ')}`
    );

    const first = recordings.get('executor:001-001-001-001');
    const second = recordings.get('executor:001-001-001-002');
    assert.strictEqual(first.length, 1, `Expected 1 recording under executor:001-001-001-001, got ${first.length}`);
    assert.strictEqual(second.length, 1, `Expected 1 recording under executor:001-001-001-002, got ${second.length}`);
    assert.strictEqual(first[0].exit.result.structured_output.task, '001-001-001-001');
    assert.strictEqual(second[0].exit.result.structured_output.task, '001-001-001-002');
  } finally {
    fs.rmSync(archiveDir, { recursive: true });
  }
});

// ---------- TC-R2: loadSessionRecordings — ascending timestamp order within a key ----------
await test('TC-R2 loadSessionRecordings returns same-key recordings ascending by filename timestamp', () => {
  // Filenames are declared here (and thus written to disk) out of
  // chronological order on purpose — seq values name the intended
  // chronological order so the assertions below can verify the returned
  // array is re-sorted ascending by filename timestamp regardless of
  // fixture write/read order.
  const logFiles = [
    {
      name: '2026-05-10T10-05-00-000Z-executor-001-001-001-003.jsonl',
      content: makeRecordingContent({ name: 'executor-001-001-001-003', structuredOutput: { seq: 3 } }),
    },
    {
      name: '2026-05-10T10-01-00-000Z-executor-001-001-001-003.jsonl',
      content: makeRecordingContent({ name: 'executor-001-001-001-003', structuredOutput: { seq: 1 } }),
    },
    {
      name: '2026-05-10T10-03-00-000Z-executor-001-001-001-003.jsonl',
      content: makeRecordingContent({ name: 'executor-001-001-001-003', structuredOutput: { seq: 2 } }),
    },
  ];
  const archiveDir = makeArchiveFixture({ logFiles });
  try {
    const recordings = loadSessionRecordings(archiveDir);
    const recs = recordings.get('executor:001-001-001-003');

    assert.ok(recs, `Expected key 'executor:001-001-001-003', got: ${[...recordings.keys()].join(', ')}`);
    assert.strictEqual(recs.length, 3, `Expected 3 recordings, got ${recs.length}`);

    assert.strictEqual(recs[0].exit.result.structured_output.seq, 1, `Expected recs[0].seq=1, got ${recs[0].exit.result.structured_output.seq}`);
    assert.strictEqual(recs[1].exit.result.structured_output.seq, 2, `Expected recs[1].seq=2, got ${recs[1].exit.result.structured_output.seq}`);
    assert.strictEqual(recs[2].exit.result.structured_output.seq, 3, `Expected recs[2].seq=3, got ${recs[2].exit.result.structured_output.seq}`);

    assert.ok(recs[0].timestamp < recs[1].timestamp, 'Expected recs[0].timestamp < recs[1].timestamp');
    assert.ok(recs[1].timestamp < recs[2].timestamp, 'Expected recs[1].timestamp < recs[2].timestamp');
  } finally {
    fs.rmSync(archiveDir, { recursive: true });
  }
});

// ---------- TC-R3: loadSessionRecordings — non-.jsonl logs are excluded ----------
await test('TC-R3 loadSessionRecordings does not load session-summary.json or token-usage.json as recordings', () => {
  const archiveDir = makeArchiveFixture();
  try {
    assert.ok(fs.existsSync(path.join(archiveDir, 'logs', 'session-summary.json')), 'Fixture sanity: logs/session-summary.json exists');
    assert.ok(fs.existsSync(path.join(archiveDir, 'logs', 'token-usage.json')), 'Fixture sanity: logs/token-usage.json exists');

    const recordings = loadSessionRecordings(archiveDir);
    assert.strictEqual(recordings.size, 1, `Expected exactly the 1 .jsonl recording's identity key, got ${recordings.size}`);

    for (const recs of recordings.values()) {
      for (const rec of recs) {
        assert.ok(
          !rec.file.endsWith('session-summary.json') && !rec.file.endsWith('token-usage.json'),
          `Expected no recording sourced from session-summary.json/token-usage.json, got file: ${rec.file}`
        );
      }
    }
  } finally {
    fs.rmSync(archiveDir, { recursive: true });
  }
});

// ---------- TC-R4: loadSessionRecordings — missing exit structured_output throws ----------
await test('TC-R4 loadSessionRecordings throws MissingExitStructuredOutputError naming the offending recording file', () => {
  const badName = '2026-05-10T10-00-00-000Z-executor-001-001-001-004.jsonl';
  const logFiles = [
    { name: badName, content: makeRecordingContent({ name: 'executor-001-001-001-004', includeExit: false }) },
  ];
  const archiveDir = makeArchiveFixture({ logFiles });
  try {
    assert.throws(
      () => loadSessionRecordings(archiveDir),
      (err) => {
        assert.strictEqual(err.name, 'MissingExitStructuredOutputError', `Expected err.name='MissingExitStructuredOutputError', got '${err.name}'`);
        assert.ok(
          err.message.includes(badName),
          `Expected err.message to name the offending recording file '${badName}', got: ${err.message}`
        );
        return true;
      }
    );
  } finally {
    fs.rmSync(archiveDir, { recursive: true });
  }
});

// ---------- TC-R5: loadArchiveBundle — composed bundle fields ----------
await test('TC-R5 loadArchiveBundle returns archiveId, spec, plans, recordings and outcomes', () => {
  const archiveDir = makeArchiveFixture();
  try {
    const bundle = loadArchiveBundle(archiveDir);

    assert.strictEqual(bundle.archiveId, path.basename(archiveDir), `Expected archiveId='${path.basename(archiveDir)}', got '${bundle.archiveId}'`);
    assert.strictEqual(bundle.archiveDir, archiveDir);

    assert.ok(bundle.spec && typeof bundle.spec === 'object', 'Expected bundle.spec to be an object');
    assert.strictEqual(bundle.spec.md, SPEC_MD, 'Expected bundle.spec.md to equal the fixture spec.md text');
    assert.deepStrictEqual(bundle.spec.json, SPEC_JSON, 'Expected bundle.spec.json to deeply equal the fixture spec.json contents');

    assert.ok(bundle.plans instanceof Map, 'Expected bundle.plans to be a Map');
    assert.ok(bundle.plans.has('001-001'), `Expected bundle.plans to have key '001-001', got: ${[...bundle.plans.keys()].join(', ')}`);

    assert.ok(bundle.recordings instanceof Map, 'Expected bundle.recordings to be a Map');
    assert.ok(
      bundle.recordings.has('executor:001-001-001-001'),
      `Expected bundle.recordings to have key 'executor:001-001-001-001', got: ${[...bundle.recordings.keys()].join(', ')}`
    );

    assert.ok(bundle.outcomes && typeof bundle.outcomes === 'object', 'Expected bundle.outcomes to be an object');
    assert.ok(bundle.outcomes.taskStatuses instanceof Map, 'Expected bundle.outcomes.taskStatuses to be a Map');
    assert.ok(bundle.outcomes.review instanceof Map, 'Expected bundle.outcomes.review to be a Map');
    assert.ok(bundle.outcomes.regression instanceof Map, 'Expected bundle.outcomes.regression to be a Map');
  } finally {
    fs.rmSync(archiveDir, { recursive: true });
  }
});

// ---------- Fake-session-manager fixture helpers ----------
// createFakeSessionManager only requires an object shaped like a
// loadArchiveBundle() result — { recordings: Map<key, recording[]>,
// plans: Map<missionId, decomp> } — so these tests build that shape by
// hand rather than round-tripping through JSONL/archive fixture files.

/**
 * Build a throwaway "recording" entry shaped like loadSessionRecordings'
 * output (only the `exit.result` field createFakeSessionManager reads is
 * populated with realistic-looking extra fields, so tests can assert the
 * FULL envelope — not a trimmed subset — is what spawn() resolves with).
 *
 * @param {object} resultOverrides - merged onto a base result envelope
 * @returns {{ exit: { result: object } }}
 */
function makeFakeRecording(resultOverrides = {}) {
  return {
    exit: {
      result: {
        structured_output: { status: 'COMPLETED' },
        usage: { input_tokens: 10, output_tokens: 20 },
        total_cost_usd: 0.01,
        ...resultOverrides,
      },
    },
  };
}

// ---------- TC-F1: createFakeSessionManager.spawn — same-key ordering + full envelope ----------
await test('TC-F1 spawn pops same-key recordings first-then-second in order, returning the full recorded envelope', async () => {
  const REC1_RESULT = makeFakeRecording({ marker: 'rec1-full-envelope' }).exit.result;
  const REC2_RESULT = makeFakeRecording({ marker: 'rec2-full-envelope' }).exit.result;
  const bundle = {
    recordings: new Map([
      ['executor:001', [{ exit: { result: REC1_RESULT } }, { exit: { result: REC2_RESULT } }]],
    ]),
    plans: new Map(),
  };

  const sessionManager = createFakeSessionManager(bundle);

  const first = await sessionManager.spawn({ name: 'executor-001' });
  assert.strictEqual(first.result, REC1_RESULT, 'Expected first spawn() to resolve with the FIRST recorded envelope (same object, not a trimmed copy)');
  assert.strictEqual(first.handle.result, REC1_RESULT, 'Expected handle.result to also be the first full recorded envelope');
  assert.deepStrictEqual(first.result, { structured_output: { status: 'COMPLETED' }, usage: { input_tokens: 10, output_tokens: 20 }, total_cost_usd: 0.01, marker: 'rec1-full-envelope' }, 'Expected the full envelope (usage/cost/structured_output/marker), not a trimmed subset');

  const second = await sessionManager.spawn({ name: 'executor-001' });
  assert.strictEqual(second.result, REC2_RESULT, 'Expected second spawn() for the same key to resolve with the SECOND recorded envelope');
  assert.notStrictEqual(second.result, first.result, 'Expected the second spawn to NOT re-resolve the first envelope');
});

// ---------- TC-F2: createFakeSessionManager.spawn — interleaved cross-key cursors ----------
await test('TC-F2 interleaved spawns across two identity keys each advance only their own key\'s cursor', async () => {
  const A1 = makeFakeRecording({ key: 'A', seq: 1 }).exit.result;
  const A2 = makeFakeRecording({ key: 'A', seq: 2 }).exit.result;
  const B1 = makeFakeRecording({ key: 'B', seq: 1 }).exit.result;
  const B2 = makeFakeRecording({ key: 'B', seq: 2 }).exit.result;
  const bundle = {
    recordings: new Map([
      ['executor:aaa', [{ exit: { result: A1 } }, { exit: { result: A2 } }]],
      ['executor:bbb', [{ exit: { result: B1 } }, { exit: { result: B2 } }]],
    ]),
    plans: new Map(),
  };

  const sessionManager = createFakeSessionManager(bundle);

  // Interleave: A, B, A — B is never spawned a second time in this test,
  // so a shared/global queue implementation would misroute the third
  // (second-A) spawn onto B's list or skip A2 entirely.
  const firstA = await sessionManager.spawn({ name: 'executor-aaa' });
  const firstB = await sessionManager.spawn({ name: 'executor-bbb' });
  const secondA = await sessionManager.spawn({ name: 'executor-aaa' });

  assert.strictEqual(firstA.result, A1, `Expected first spawn on key A to resolve to A1, got: ${JSON.stringify(firstA.result)}`);
  assert.strictEqual(firstB.result, B1, `Expected first spawn on key B to resolve to B1, got: ${JSON.stringify(firstB.result)}`);
  assert.strictEqual(secondA.result, A2, `Expected second spawn on key A to resolve to A2 (independent of key B's cursor), got: ${JSON.stringify(secondA.result)}`);
});

// ---------- TC-F3: createFakeSessionManager.spawn — exhausted key rejects ----------
await test('TC-F3 spawn for an exhausted identity key rejects with RecordingExhaustedError naming the key', async () => {
  const ONLY_RESULT = makeFakeRecording({ marker: 'only-recording' }).exit.result;
  const bundle = {
    recordings: new Map([
      ['executor:solo', [{ exit: { result: ONLY_RESULT } }]],
    ]),
    plans: new Map(),
  };

  const sessionManager = createFakeSessionManager(bundle);

  const first = await sessionManager.spawn({ name: 'executor-solo' });
  assert.strictEqual(first.result, ONLY_RESULT, 'Fixture sanity: the first spawn should still succeed');

  await assert.rejects(
    () => sessionManager.spawn({ name: 'executor-solo' }),
    (err) => {
      assert.ok(err instanceof RecordingExhaustedError, `Expected err to be a RecordingExhaustedError, got: ${err}`);
      assert.strictEqual(err.name, 'RecordingExhaustedError', `Expected err.name='RecordingExhaustedError', got '${err.name}'`);
      assert.ok(
        err.message.includes('executor:solo'),
        `Expected err.message to name the identity key 'executor:solo', got: ${err.message}`
      );
      return true;
    }
  );
});

// ---------- TC-F4: createFakeSessionManager.spawnReusable — plan sourced from archived ground truth ----------
await test('TC-F4 spawnReusable plan output comes from the bundle\'s archived plan, not the recording\'s exit-event structured_output', async () => {
  const ARCHIVED_PLAN = { subMissions: [{ id: '001-001-001', description: 'Archived ground-truth plan', tasks: [] }] };
  const RECORDING_LAST_TURN_OUTPUT = { subMissions: [{ id: '999-999-999', description: 'WRONG — this is the recording\'s last-turn structured_output, must NOT be used', tasks: [] }] };

  const bundle = {
    // A reusable planner session's recording captures only the LAST turn's
    // structured_output — deliberately made to differ from the archived
    // plan so a test failure here would mean spawnReusable wrongly sourced
    // from the recording instead of bundle.plans.
    recordings: new Map([
      ['planner', [{ exit: { result: { structured_output: RECORDING_LAST_TURN_OUTPUT } } }]],
    ]),
    plans: new Map([['001-001', ARCHIVED_PLAN]]),
  };

  const sessionManager = createFakeSessionManager(bundle);
  const reusable = sessionManager.spawnReusable({ name: 'planner' });
  const turnResult = await reusable.sendPrompt('plan the mission');

  assert.deepStrictEqual(turnResult.structured_output, ARCHIVED_PLAN, 'Expected the plan output to equal the archived plan ground truth');
  assert.notDeepStrictEqual(turnResult.structured_output, RECORDING_LAST_TURN_OUTPUT, 'Expected the plan output to NOT equal the recording\'s exit-event last-turn structured_output');
});

// ---------- TC-F5: spawnReusable — planner-global never consumes a mission decomp ----------
await test('TC-F5 spawnReusable planner-global is exhausted immediately and leaves the per-mission plan cursor untouched', async () => {
  const MISSION_PLAN = { subMissions: [{ id: '001-001-001', description: 'The one archived mission decomp', tasks: [] }] };
  const bundle = { recordings: new Map(), plans: new Map([['001-001', MISSION_PLAN]]) };

  const sessionManager = createFakeSessionManager(bundle);

  // planGlobal's own session needs a milestone-shaped plan, which
  // bundle.plans never holds — it must fail loudly rather than silently
  // stealing the first mission's decomp.
  const globalSession = sessionManager.spawnReusable({ name: 'planner-global' });
  await assert.rejects(
    () => globalSession.sendPrompt('decompose the spec into milestones'),
    (err) => err instanceof RecordingExhaustedError && err.identityKey === 'planner:global',
    'Expected planner-global to raise RecordingExhaustedError for its own identity key'
  );

  // The per-mission session must still receive the untouched decomp.
  const missionSession = sessionManager.spawnReusable({ name: 'planner-reusable' });
  const turnResult = await missionSession.sendPrompt('plan mission 001-001');
  assert.deepStrictEqual(
    turnResult.structured_output, MISSION_PLAN,
    'Expected the per-mission session to still receive the archived decomp planner-global must not have consumed'
  );
});

// ---------- TC-F6: spawnReusable — rotated per-mission sessions share one cursor ----------
await test('TC-F6 spawnReusable rotated planner-reusable generations continue the same plan cursor', async () => {
  const PLAN_A = { subMissions: [{ id: '001-001-001', description: 'mission A', tasks: [] }] };
  const PLAN_B = { subMissions: [{ id: '001-002-001', description: 'mission B', tasks: [] }] };
  const bundle = {
    recordings: new Map(),
    plans: new Map([['001-001', PLAN_A], ['001-002', PLAN_B]]),
  };

  const sessionManager = createFakeSessionManager(bundle);

  // A rotation retires 'planner-reusable' and opens 'planner-reusable-2'
  // (planner.js's _ensureReusableSession); the fresh generation must
  // resume at mission B, not replay mission A.
  const gen1 = sessionManager.spawnReusable({ name: 'planner-reusable' });
  const first = await gen1.sendPrompt('plan mission 001-001');
  assert.deepStrictEqual(first.structured_output, PLAN_A, 'Expected the first generation to receive mission A');

  const gen2 = sessionManager.spawnReusable({ name: 'planner-reusable-2' });
  const second = await gen2.sendPrompt('plan mission 001-002');
  assert.deepStrictEqual(second.structured_output, PLAN_B, 'Expected the rotated generation to resume at mission B, not replay mission A');
});

// ---------- compareReplay fixture helper ----------
// Builds a loadArchiveBundle()-shaped-enough object — { archiveId, outcomes:
// { taskStatuses, sessionVerdicts, review, regression } } — for compareReplay
// tests. Deep-cloned via JSON round-trip so mutating one side never leaks
// into the other.
function makeCompareBundle(overrides = {}) {
  const base = {
    archiveId: 'archive-compare-fixture',
    outcomes: {
      taskStatuses: {
        '001-001-001-001': 'complete',
        '001-001-001-002': 'complete',
      },
      sessionVerdicts: {
        'verifier:001-001-001-001': ['PASSED'],
      },
      review: {
        '001': { result: 'PASSED' },
      },
      regression: {
        '001-001': { result: 'PASSED' },
      },
    },
  };
  const merged = JSON.parse(JSON.stringify(base));
  if (overrides.archiveId !== undefined) merged.archiveId = overrides.archiveId;
  if (overrides.taskStatuses !== undefined) merged.outcomes.taskStatuses = overrides.taskStatuses;
  if (overrides.sessionVerdicts !== undefined) merged.outcomes.sessionVerdicts = overrides.sessionVerdicts;
  if (overrides.review !== undefined) merged.outcomes.review = overrides.review;
  if (overrides.regression !== undefined) merged.outcomes.regression = overrides.regression;
  return merged;
}

// ---------- TC-C1: compareReplay — identical outcomes yield an empty report ----------
await test('TC-C1 compareReplay returns a report of length 0 for identical replayed and ground-truth outcomes', () => {
  const groundTruth = makeCompareBundle();
  const replayed = JSON.parse(JSON.stringify(groundTruth));

  const report = compareReplay(replayed, groundTruth);

  assert.ok(Array.isArray(report), 'Expected compareReplay to return an array');
  assert.strictEqual(report.length, 0, `Expected an empty report for identical outcomes, got: ${JSON.stringify(report)}`);
});

// ---------- TC-C2: compareReplay — planted task-status drift ----------
await test('TC-C2 compareReplay reports exactly one entry for a single planted task-status drift', () => {
  const groundTruth = makeCompareBundle({ archiveId: 'archive-tc2' });
  const replayed = makeCompareBundle({
    archiveId: 'archive-tc2',
    taskStatuses: {
      '001-001-001-001': 'complete',
      '001-001-001-002': 'failed', // planted drift: ground truth has 'complete'
    },
  });

  const report = compareReplay(replayed, groundTruth);

  assert.strictEqual(report.length, 1, `Expected exactly 1 report entry, got ${report.length}: ${JSON.stringify(report)}`);
  const [entry] = report;
  assert.strictEqual(entry.archive, 'archive-tc2', `Expected entry.archive='archive-tc2', got '${entry.archive}'`);
  assert.strictEqual(entry.identity, '001-001-001-002', `Expected entry.identity='001-001-001-002' (the drifting task's identity), got '${entry.identity}'`);
  assert.strictEqual(entry.field, 'status', `Expected entry.field='status', got '${entry.field}'`);
  assert.strictEqual(entry.expected, 'complete', `Expected entry.expected='complete', got '${entry.expected}'`);
  assert.strictEqual(entry.actual, 'failed', `Expected entry.actual='failed', got '${entry.actual}'`);
});

// ---------- TC-C3: compareReplay — timestamp/session-id/cost/fs-path-only differences are noise ----------
await test('TC-C3 compareReplay returns a report of length 0 when sides differ only in timestamps, session ids, cost fields and fs-derived path fields', () => {
  const groundTruth = makeCompareBundle({
    archiveId: 'archive-tc3',
    taskStatuses: {
      '001-001-001-001': {
        status: 'complete',
        createdAt: '2026-02-02T00:00:00.000Z',
        startedAt: '2026-02-02T00:01:00.000Z',
        completedAt: '2026-02-02T00:05:00.000Z',
        sessionId: 'sess-gt-1',
        cost: 0.2,
        verifyFile: '/tmp/gt-archive/verify.json',
        progressFile: '/tmp/gt-archive/progress.json',
        verificationFile: '/tmp/gt-archive/verification.json',
      },
    },
    sessionVerdicts: {
      'verifier:001-001-001-001': [
        {
          result: 'PASSED',
          sessionId: 'sess-gt-verifier-1',
          totalCost: 0.02,
          progressFile: '/tmp/gt-archive/verifier-progress.json',
          recordedAt: '2026-02-02T00:06:00.000Z',
        },
      ],
    },
    review: {
      '001': {
        result: 'PASSED',
        sessionId: 'sess-gt-reviewer-1',
        total_cost_usd: 0.03,
        verificationFile: '/tmp/gt-archive/review-verification.json',
        finishedAt: '2026-02-02T00:07:00.000Z',
      },
    },
    regression: {
      '001-001': {
        result: 'PASSED',
        sessionId: 'sess-gt-regression-1',
        costUsd: 0.04,
        verifyFile: '/tmp/gt-archive/regression-verify.json',
        ts: '2026-02-02T00:08:00.000Z',
      },
    },
  });
  const replayed = makeCompareBundle({
    archiveId: 'archive-tc3',
    taskStatuses: {
      '001-001-001-001': {
        status: 'complete',
        createdAt: '2026-03-03T10:00:00.000Z',
        startedAt: '2026-03-03T10:01:00.000Z',
        completedAt: '2026-03-03T10:05:00.000Z',
        sessionId: 'sess-replay-1',
        cost: 0.99,
        verifyFile: '/tmp/replay-archive/verify.json',
        progressFile: '/tmp/replay-archive/progress.json',
        verificationFile: '/tmp/replay-archive/verification.json',
      },
    },
    sessionVerdicts: {
      'verifier:001-001-001-001': [
        {
          result: 'PASSED',
          sessionId: 'sess-replay-verifier-1',
          totalCost: 0.55,
          progressFile: '/tmp/replay-archive/verifier-progress.json',
          recordedAt: '2026-03-03T10:06:00.000Z',
        },
      ],
    },
    review: {
      '001': {
        result: 'PASSED',
        sessionId: 'sess-replay-reviewer-1',
        total_cost_usd: 0.66,
        verificationFile: '/tmp/replay-archive/review-verification.json',
        finishedAt: '2026-03-03T10:07:00.000Z',
      },
    },
    regression: {
      '001-001': {
        result: 'PASSED',
        sessionId: 'sess-replay-regression-1',
        costUsd: 0.77,
        verifyFile: '/tmp/replay-archive/regression-verify.json',
        ts: '2026-03-03T10:08:00.000Z',
      },
    },
  });

  const report = compareReplay(replayed, groundTruth);

  assert.strictEqual(report.length, 0, `Expected an empty report when sides differ only in noise fields, got: ${JSON.stringify(report)}`);
});

// ---------- TC-C4: compareReplay — sequence-paired verdict divergence ----------
await test('TC-C4 compareReplay pairs per-session verdicts by sequence and reports only the divergent position', () => {
  const groundTruth = makeCompareBundle({
    archiveId: 'archive-tc4',
    sessionVerdicts: {
      'verifier:001-001-001-001': ['PASSED', 'PASSED'],
    },
  });
  const replayed = makeCompareBundle({
    archiveId: 'archive-tc4',
    sessionVerdicts: {
      // First verdict matches ground truth; second diverges.
      'verifier:001-001-001-001': ['PASSED', 'FAILED'],
    },
  });

  const report = compareReplay(replayed, groundTruth);

  assert.strictEqual(report.length, 1, `Expected exactly 1 report entry (only the second verdict diverges), got ${report.length}: ${JSON.stringify(report)}`);
  const [entry] = report;
  assert.strictEqual(entry.identity, 'verifier:001-001-001-001', `Expected entry.identity='verifier:001-001-001-001', got '${entry.identity}'`);
  assert.strictEqual(entry.field, 'result', `Expected entry.field='result', got '${entry.field}'`);
  assert.strictEqual(entry.sequence, 1, `Expected the divergence to be reported at sequence position 1 (the second verdict), got ${entry.sequence}`);
  assert.strictEqual(entry.expected, 'PASSED', `Expected entry.expected='PASSED', got '${entry.expected}'`);
  assert.strictEqual(entry.actual, 'FAILED', `Expected entry.actual='FAILED', got '${entry.actual}'`);
});

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
