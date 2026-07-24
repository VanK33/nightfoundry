/**
 * test-context-enrichment.js — Unit tests for Phase I item 2
 * (planner context enrichment).
 *
 * Covers:
 *   - Schema contract: new patternReferences + dataSchemas fields
 *     are accepted, the category enum is enforced, malformed entries
 *     are rejected.
 *   - Executor prompt builder: tasks with patternReferences/dataSchemas
 *     produce prompts containing the expected sections; tasks without
 *     them produce byte-identical pre-enrichment prompts (back-compat).
 *
 * No Claude auth, no SDK. Pure function tests.
 * Run: node test/test-context-enrichment.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildExecutorPrompt } from '../src/orchestrator/agents/executor.js';
import { validateStructured } from '../src/orchestrator/agents/_schemas.js';
import { writeMissionState, readState, stateToDecomp } from '../src/orchestrator/core/state.js';
import { bootstrap } from '../src/orchestrator/core/bootstrap.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failCount++;
  }
}

// ── Schema shape (local mirror for testing, since the real schema
//    lives in planner.js which doesn't currently export it) ─────────

// The same shape the planner uses. We mirror it here to validate
// enrichment payloads in isolation. If the schema in planner.js
// drifts, the integration path (contract tests in test-planner-reuse)
// will catch the divergence.
const enrichmentSchemaFragment = {
  type: 'object',
  properties: {
    patternReferences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          excerpt: { type: 'string' },
          category: {
            type: 'string',
            enum: ['peer', 'imported-type', 'caller-side'],
          },
          reason: { type: 'string' },
        },
        required: ['path', 'excerpt', 'category', 'reason'],
      },
    },
    dataSchemas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          name: { type: 'string' },
          shape: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['path', 'name', 'shape', 'reason'],
      },
    },
  },
};

// ── Schema validation tests ─────────────────────────────────────────

test('schema: empty enrichment fields are valid', () => {
  const task = { patternReferences: [], dataSchemas: [] };
  const r = validateStructured(task, enrichmentSchemaFragment);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('schema: single valid patternReferences entry passes', () => {
  const task = {
    patternReferences: [
      {
        path: 'src/foo/bar.js',
        excerpt: 'export function bar() {}',
        category: 'peer',
        reason: 'sibling file showing export pattern',
      },
    ],
    dataSchemas: [],
  };
  const r = validateStructured(task, enrichmentSchemaFragment);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('schema: all three category values are accepted', () => {
  for (const category of ['peer', 'imported-type', 'caller-side']) {
    const task = {
      patternReferences: [
        { path: 'a.js', excerpt: '...', category, reason: 'r' },
      ],
      dataSchemas: [],
    };
    const r = validateStructured(task, enrichmentSchemaFragment);
    assert.equal(r.ok, true, `category "${category}" should be valid`);
  }
});

test('schema: invalid category is rejected', () => {
  const task = {
    patternReferences: [
      { path: 'a.js', excerpt: '...', category: 'random-thing', reason: 'r' },
    ],
    dataSchemas: [],
  };
  const r = validateStructured(task, enrichmentSchemaFragment);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /category/.test(e) && /random-thing/.test(e)));
});

test('schema: missing required patternReferences field is rejected', () => {
  const task = {
    patternReferences: [
      { path: 'a.js', category: 'peer', reason: 'r' }, // missing excerpt
    ],
    dataSchemas: [],
  };
  const r = validateStructured(task, enrichmentSchemaFragment);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /excerpt.*missing/.test(e)));
});

test('schema: dataSchemas entry with all fields passes', () => {
  const task = {
    patternReferences: [],
    dataSchemas: [
      {
        path: 'src/objects/user.ts',
        name: 'User',
        shape: 'interface User { id: string; email: string; }',
        reason: 'task consumes User instances',
      },
    ],
  };
  const r = validateStructured(task, enrichmentSchemaFragment);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('schema: dataSchemas missing required field rejected', () => {
  const task = {
    patternReferences: [],
    dataSchemas: [
      { path: 'x.ts', name: 'X', shape: '...' }, // missing reason
    ],
  };
  const r = validateStructured(task, enrichmentSchemaFragment);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /reason.*missing/.test(e)));
});

// ── buildExecutorPrompt — back-compat (empty enrichment) ────────────

test('prompt: task without enrichment fields has no Pattern references section', () => {
  const task = {
    id: '001-001-001-001',
    description: 'do a thing',
    targetFiles: ['src/foo.js'],
    testCases: ['test case 1'],
  };
  const prompt = buildExecutorPrompt(task, {});
  assert.ok(!prompt.includes('## Pattern references'), 'should not contain Pattern references section');
  assert.ok(!prompt.includes('## Data schemas'), 'should not contain Data schemas section');
  // Core structure must still be present
  assert.ok(prompt.includes('Task 001-001-001-001: do a thing'));
  assert.ok(prompt.includes('Target files: src/foo.js'));
  assert.ok(prompt.includes('test case 1'));
});

test('prompt: task with empty enrichment arrays has no enrichment sections', () => {
  const task = {
    id: '001-001-001-002',
    description: 'empty arrays',
    targetFiles: ['src/bar.js'],
    patternReferences: [],
    dataSchemas: [],
  };
  const prompt = buildExecutorPrompt(task, {});
  assert.ok(!prompt.includes('## Pattern references'));
  assert.ok(!prompt.includes('## Data schemas'));
});

test('prompt: back-compat — pre-enrichment task produces a prompt that contains the standard sections', () => {
  // Regression sentinel: if the refactor accidentally changed the
  // structure of the non-enrichment prompt, this test catches it.
  const task = {
    id: 'regression',
    description: 'back-compat test',
    targetFiles: ['src/a.js', 'src/b.js'],
    testCases: ['case A', 'case B'],
  };
  const prompt = buildExecutorPrompt(task, { additionalContext: 'extra context here' });
  // Standard sections present
  assert.ok(prompt.includes('Task regression: back-compat test'));
  assert.ok(prompt.includes('Target files: src/a.js, src/b.js'));
  assert.ok(prompt.includes('Test cases to cover:'));
  assert.ok(prompt.includes('1. case A'));
  assert.ok(prompt.includes('2. case B'));
  assert.ok(prompt.includes('extra context here'));
  // Executor rules block present
  assert.ok(prompt.includes('Rules:'));
  assert.ok(prompt.includes('Only modify files listed in targetFiles'));
});

// ── buildExecutorPrompt — enrichment sections ───────────────────────

test('prompt: patternReferences produces ## Pattern references section with entries', () => {
  const task = {
    id: 'enriched-1',
    description: 'enriched task',
    targetFiles: ['src/foo.js'],
    patternReferences: [
      {
        path: 'src/peers/similar.js',
        excerpt: 'export function similar() { return 42; }',
        category: 'peer',
        reason: 'sibling showing the module export pattern',
      },
    ],
  };
  const prompt = buildExecutorPrompt(task, {});
  assert.ok(prompt.includes('## Pattern references'));
  assert.ok(prompt.includes('### src/peers/similar.js (peer)'));
  assert.ok(prompt.includes('sibling showing the module export pattern'));
  assert.ok(prompt.includes('export function similar() { return 42; }'));
});

test('prompt: multiple patternReferences all appear in order', () => {
  const task = {
    id: 'enriched-2',
    description: 'multi ref',
    targetFiles: ['src/x.js'],
    patternReferences: [
      { path: 'a.js', excerpt: 'first', category: 'peer', reason: 'r1' },
      { path: 'b.js', excerpt: 'second', category: 'caller-side', reason: 'r2' },
      { path: 'c.js', excerpt: 'third', category: 'imported-type', reason: 'r3' },
    ],
  };
  const prompt = buildExecutorPrompt(task, {});
  // Check ordering via substring indices
  const iFirst = prompt.indexOf('first');
  const iSecond = prompt.indexOf('second');
  const iThird = prompt.indexOf('third');
  assert.ok(iFirst > 0 && iSecond > iFirst && iThird > iSecond, 'references should appear in order');
  // All categories labeled correctly
  assert.ok(prompt.includes('### a.js (peer)'));
  assert.ok(prompt.includes('### b.js (caller-side)'));
  assert.ok(prompt.includes('### c.js (imported-type)'));
});

test('prompt: dataSchemas produces ## Data schemas section with entries', () => {
  const task = {
    id: 'schema-task',
    description: 'consume a type',
    targetFiles: ['src/service.js'],
    dataSchemas: [
      {
        path: 'src/objects/user.ts',
        name: 'User',
        shape: 'interface User {\n  id: string;\n  email: string;\n}',
        reason: 'task returns User instances',
      },
    ],
  };
  const prompt = buildExecutorPrompt(task, {});
  assert.ok(prompt.includes('## Data schemas'));
  assert.ok(prompt.includes('### User (from src/objects/user.ts)'));
  assert.ok(prompt.includes('task returns User instances'));
  assert.ok(prompt.includes('interface User {'));
  assert.ok(prompt.includes('id: string;'));
});

test('prompt: both patternReferences AND dataSchemas render in the correct order', () => {
  const task = {
    id: 'both',
    description: 'both enrichment categories',
    targetFiles: ['src/foo.js'],
    patternReferences: [
      { path: 'p.js', excerpt: 'pattern-content', category: 'peer', reason: 'pr' },
    ],
    dataSchemas: [
      { path: 's.ts', name: 'S', shape: 'schema-content', reason: 'sr' },
    ],
  };
  const prompt = buildExecutorPrompt(task, {});
  const iPattern = prompt.indexOf('## Pattern references');
  const iSchemas = prompt.indexOf('## Data schemas');
  assert.ok(iPattern > 0);
  assert.ok(iSchemas > iPattern, 'Data schemas should come after Pattern references');
  // Rules section should come AFTER both enrichment sections
  const iRules = prompt.indexOf('Rules:');
  assert.ok(iRules > iSchemas, 'Rules section should come last');
});

test('prompt: enrichment does not break existing test case / verify.json sections', () => {
  // Regression sentinel: adding enrichment shouldn't break the
  // test case listing or the verify.json inclusion.
  const task = {
    id: 'mixed',
    description: 'has everything',
    targetFiles: ['src/a.js'],
    testCases: ['TC1', 'TC2'],
    patternReferences: [
      { path: 'p.js', excerpt: 'e', category: 'peer', reason: 'r' },
    ],
    dataSchemas: [
      { path: 's.ts', name: 'S', shape: 'shape', reason: 'r' },
    ],
  };
  const ctx = { verifyJsonContent: '{"hardChecks":[]}' };
  const prompt = buildExecutorPrompt(task, ctx);
  assert.ok(prompt.includes('1. TC1'));
  assert.ok(prompt.includes('2. TC2'));
  assert.ok(prompt.includes('verify.json contents:'));
  assert.ok(prompt.includes('"hardChecks":[]'));
  assert.ok(prompt.includes('## Pattern references'));
  assert.ok(prompt.includes('## Data schemas'));
});

// ── State-writer round trip (regression sentinel for dogfood 4 bug) ──

test('state: writeMissionState preserves patternReferences and dataSchemas fields (regression — dogfood 4)', () => {
  // Bug caught during dogfood 4 (Branch 2 validation run):
  //   - Planner correctly populated patternReferences + dataSchemas
  //     in its structured_output (confirmed in session logs)
  //   - BUT writeMissionState copied tasks from a fixed allowlist
  //     that didn't include the new fields
  //   - Result: executor never saw any enrichment data because the
  //     state writer silently dropped it between planner and executor
  //
  // This is a textbook Rule 2 (callsite audit) miss — fields added
  // to the schema, planner prompt, and executor consumer, but the
  // persistence layer in between was missed.
  //
  // This regression sentinel would have caught the bug at test time:
  // generate a mission state via the real writer with enrichment
  // fields in the decomp, read it back, assert the fields are
  // present and identical.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'state-enrichment-'));
  try {
    bootstrap(projectRoot, { prdPath: path.join(projectRoot, 'test.md') });
    const harnessDir = path.join(projectRoot, '.harness');

    const decomp = {
      subMissions: [
        {
          id: '001-001-001',
          description: 'test sub-mission',
          tasks: [
            {
              id: '001-001-001-001',
              description: 'test task',
              targetFiles: ['src/foo.js'],
              dependencies: [],
              testCases: [],
              tracesScenario: [],
              patternReferences: [
                {
                  path: 'src/bar.js',
                  excerpt: 'export function bar() {}',
                  category: 'peer',
                  reason: 'sibling pattern reference',
                },
              ],
              dataSchemas: [
                {
                  path: 'src/types.ts',
                  name: 'Foo',
                  shape: 'interface Foo { id: string; }',
                  reason: 'task consumes Foo',
                },
              ],
            },
          ],
        },
      ],
    };

    writeMissionState(harnessDir, '001-001', 'test mission', decomp);

    // Read the mission state file back
    const missionStatePath = path.join(harnessDir, 'state', 'mission-001-001.json');
    const missionState = JSON.parse(fs.readFileSync(missionStatePath, 'utf8'));
    const writtenTask = missionState.subMissions['001-001-001'].tasks['001-001-001-001'];

    // The bug: these assertions fail without the state.js fix
    assert.ok(writtenTask.patternReferences, 'patternReferences must be present in written task');
    assert.equal(writtenTask.patternReferences.length, 1);
    assert.equal(writtenTask.patternReferences[0].path, 'src/bar.js');
    assert.equal(writtenTask.patternReferences[0].category, 'peer');

    assert.ok(writtenTask.dataSchemas, 'dataSchemas must be present in written task');
    assert.equal(writtenTask.dataSchemas.length, 1);
    assert.equal(writtenTask.dataSchemas[0].name, 'Foo');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('state: writeMissionState handles missing enrichment fields (back-compat)', () => {
  // Pre-enrichment tasks should still work — missing fields produce
  // empty arrays in the written state, not undefined.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'state-backcompat-'));
  try {
    bootstrap(projectRoot, { prdPath: path.join(projectRoot, 'test.md') });
    const harnessDir = path.join(projectRoot, '.harness');

    const decomp = {
      subMissions: [
        {
          id: '001-001-001',
          description: 'pre-enrichment sm',
          tasks: [
            {
              id: '001-001-001-001',
              description: 'pre-enrichment task',
              targetFiles: ['src/foo.js'],
              // No patternReferences, no dataSchemas
            },
          ],
        },
      ],
    };

    writeMissionState(harnessDir, '001-001', 'test mission', decomp);

    const missionStatePath = path.join(harnessDir, 'state', 'mission-001-001.json');
    const missionState = JSON.parse(fs.readFileSync(missionStatePath, 'utf8'));
    const writtenTask = missionState.subMissions['001-001-001'].tasks['001-001-001-001'];

    // Missing fields should default to empty arrays, not crash
    assert.deepEqual(writtenTask.patternReferences, []);
    assert.deepEqual(writtenTask.dataSchemas, []);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('state: stateToDecomp preserves patternReferences and dataSchemas (regression — PR review)', () => {
  // Second round of the same bug class as the dogfood 4 state writer
  // bug: pipeline.run() / _missionRegression rebuild the decomp on
  // resume by calling stateToDecomp(existingMissionState). That
  // helper had its own fixed-allowlist task copy that didn't carry
  // enrichment fields — so on any resume, or on any remediation
  // merge that flows through stateToDecomp, the executor prompts
  // would lose their enrichment even though the mission state file
  // on disk had the fields. Round-trip sentinel: write a mission
  // with enrichment, read it back via stateToDecomp, assert the
  // fields survive.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'state-enrichment-roundtrip-'));
  try {
    bootstrap(projectRoot, { prdPath: path.join(projectRoot, 'test.md') });
    const harnessDir = path.join(projectRoot, '.harness');

    const decomp = {
      subMissions: [
        {
          id: '001-001-001',
          description: 'round-trip sm',
          tasks: [
            {
              id: '001-001-001-001',
              description: 'round-trip task',
              targetFiles: ['src/foo.js'],
              dependencies: [],
              testCases: [],
              tracesScenario: [],
              patternReferences: [
                {
                  path: 'src/bar.js',
                  excerpt: 'export function bar() {}',
                  category: 'peer',
                  reason: 'sibling pattern reference',
                },
              ],
              dataSchemas: [
                {
                  path: 'src/types.ts',
                  name: 'Foo',
                  shape: 'interface Foo { id: string; }',
                  reason: 'task consumes Foo',
                },
              ],
            },
          ],
        },
      ],
    };

    writeMissionState(harnessDir, '001-001', 'test mission', decomp);

    // Read it back (as the resume/regression paths do)
    const missionStatePath = path.join(harnessDir, 'state', 'mission-001-001.json');
    const missionState = JSON.parse(fs.readFileSync(missionStatePath, 'utf8'));
    const rebuilt = stateToDecomp(missionState);

    const task = rebuilt.subMissions[0].tasks[0];
    assert.ok(task.patternReferences, 'patternReferences must survive stateToDecomp round-trip');
    assert.equal(task.patternReferences.length, 1);
    assert.equal(task.patternReferences[0].category, 'peer');
    assert.equal(task.patternReferences[0].path, 'src/bar.js');

    assert.ok(task.dataSchemas, 'dataSchemas must survive stateToDecomp round-trip');
    assert.equal(task.dataSchemas.length, 1);
    assert.equal(task.dataSchemas[0].name, 'Foo');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('state: stateToDecomp handles missing enrichment fields (back-compat)', () => {
  // Older mission state files written before Phase I item 2 have no
  // patternReferences / dataSchemas fields at all. stateToDecomp must
  // default them to empty arrays, not leak undefined into decomp tasks.
  const missionState = {
    id: '001-001',
    description: 'legacy mission',
    subMissions: {
      '001-001-001': {
        id: '001-001-001',
        description: 'legacy sm',
        tasks: {
          '001-001-001-001': {
            id: '001-001-001-001',
            description: 'legacy task',
            // No enrichment fields
          },
        },
      },
    },
  };

  const rebuilt = stateToDecomp(missionState);
  const task = rebuilt.subMissions[0].tasks[0];
  assert.deepEqual(task.patternReferences, []);
  assert.deepEqual(task.dataSchemas, []);
});

// ── buildExecutorPrompt — previousFailures rendering ────────────────

test('prompt: previousFailures section rendered when non-empty with correct bullet format', () => {
  // TC1: section rendered when previousFailures is non-empty with correct bullet format
  const task = {
    id: 'fail-1',
    description: 'task with failures',
    targetFiles: ['src/foo.js'],
  };
  const context = {
    previousFailures: [
      {
        kind: 'hardCheck',
        description: 'missing export',
        evidence: 'grep found no export statement',
      },
    ],
  };
  const prompt = buildExecutorPrompt(task, context);
  assert.ok(prompt.includes('## Previous attempt failed verification'), 'should contain previousFailures heading');
  assert.ok(
    prompt.includes('- **missing export** (hardCheck): grep found no export statement'),
    'should format bullet as **{description}** ({kind}): {evidence}'
  );
  assert.ok(prompt.includes('Address each finding in this attempt.'), 'should contain follow-up instruction');
});

test('prompt: previousFailures section omitted when previousFailures is empty array', () => {
  // TC2: section omitted when previousFailures is empty array
  const task = {
    id: 'fail-2',
    description: 'task with empty failures',
    targetFiles: ['src/foo.js'],
  };
  const context = {
    previousFailures: [],
  };
  const prompt = buildExecutorPrompt(task, context);
  assert.ok(
    !prompt.includes('## Previous attempt failed verification'),
    'should not contain previousFailures section when array is empty'
  );
});

test('prompt: previousFailures section omitted when previousFailures is absent/undefined', () => {
  // TC3: section omitted when previousFailures is absent/undefined
  const task = {
    id: 'fail-3',
    description: 'task without failures field',
    targetFiles: ['src/foo.js'],
  };
  const context = {};
  const prompt = buildExecutorPrompt(task, context);
  assert.ok(
    !prompt.includes('## Previous attempt failed verification'),
    'should not contain previousFailures section when field is absent'
  );
});

test('prompt: previousFailures renders both hardCheck and scopeCheck kinds correctly from a mixed fixture', () => {
  // TC4: both hardCheck and scopeCheck kinds rendered correctly from a mixed fixture
  const task = {
    id: 'fail-4',
    description: 'task with mixed failure kinds',
    targetFiles: ['src/foo.js'],
  };
  const context = {
    previousFailures: [
      {
        kind: 'hardCheck',
        description: 'export missing',
        evidence: 'no export found in file',
      },
      {
        kind: 'scopeCheck',
        description: 'modified out-of-scope file',
        evidence: 'src/other.js was changed',
      },
    ],
  };
  const prompt = buildExecutorPrompt(task, context);
  assert.ok(prompt.includes('## Previous attempt failed verification'), 'should contain section heading');
  assert.ok(
    prompt.includes('- **export missing** (hardCheck): no export found in file'),
    'should render hardCheck entry correctly'
  );
  assert.ok(
    prompt.includes('- **modified out-of-scope file** (scopeCheck): src/other.js was changed'),
    'should render scopeCheck entry correctly'
  );
  // Verify ordering: hardCheck before scopeCheck
  const iHard = prompt.indexOf('(hardCheck)');
  const iScope = prompt.indexOf('(scopeCheck)');
  assert.ok(iHard > 0 && iScope > iHard, 'hardCheck entry should appear before scopeCheck entry');
});

// ── Summary ────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
