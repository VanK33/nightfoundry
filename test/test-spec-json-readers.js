/**
 * test-spec-json-readers.js — Unit tests for the pipeline spec.json readers
 * _getSpecAcceptanceCriteria() and _getSpecGoal().
 *
 * Both mirror _getSpecConstraints(): they resolve prdPath from
 * .harness/state.json (projectMeta.prdPath), derive the sibling spec.json via
 * deriveSpecJsonPath, JSON.parse it (try/catch), and return the requested field
 * — fail-soft to [] / '' when the json is absent, empty/missing the field, or
 * unparseable. Results are cached on the instance.
 *
 * No Claude auth, no SDK — constructs a Pipeline over a temp project root with
 * a hand-written state.json + spec.json and calls the readers directly.
 *
 * Run: node test/test-spec-json-readers.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
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

// ── Fixture helpers ───────────────────────────────────────────────────────

/**
 * Create a temp project root with a .harness dir and a state.json whose
 * projectMeta.prdPath points at a sibling `.md` spec inside the project root.
 *
 * The spec.json (sibling of the .md) is written iff `specJsonContent` is a
 * string (write it verbatim — lets us inject malformed JSON) or an object
 * (JSON.stringify it). When `specJsonContent === undefined`, NO spec.json is
 * written — exercising the absent-json fail-soft path.
 *
 * Returns { projectRoot, harnessDir, specMdPath, specJsonPath }.
 */
function createReaderHarness(specJsonContent) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-json-readers-'));
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  const specMdPath = path.join(projectRoot, 'my-spec.md');
  const specJsonPath = path.join(projectRoot, 'my-spec.json');

  // The .md itself need not have meaningful content — the readers are json-only.
  fs.writeFileSync(specMdPath, '# Spec\n\nSome prose.\n');

  if (specJsonContent !== undefined) {
    const body = typeof specJsonContent === 'string'
      ? specJsonContent
      : JSON.stringify(specJsonContent, null, 2);
    fs.writeFileSync(specJsonPath, body);
  }

  const globalState = {
    projectMeta: {
      prdPath: specMdPath, // absolute .md → deriveSpecJsonPath swaps to my-spec.json
      createdAt: new Date().toISOString(),
      currentPhase: 'executing',
    },
    globalStatus: 'active',
    milestones: {},
  };
  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  return { projectRoot, harnessDir, specMdPath, specJsonPath };
}

function makePipeline(projectRoot) {
  return new Pipeline(projectRoot, { onLog: () => {}, onConfirm: async () => true });
}

function cleanup(projectRoot) {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// A representative acceptance_criteria array in the post-(1) item shape.
const sampleCriteria = [
  {
    description: 'Reader returns the acceptance_criteria array verbatim.',
    verification: { kind: 'command', command: 'node test/test-spec-json-readers.js', targetFile: 'test/test-spec-json-readers.js' },
  },
  {
    description: 'Goal reader returns the goal string.',
    verification: { kind: 'file-check', targetFile: 'src/orchestrator/core/pipeline.js' },
  },
];

const sampleGoal = 'Feed spec.json.acceptance_criteria and goal into the reviewer.';

// ── _getSpecAcceptanceCriteria ─────────────────────────────────────────────

// TC1 — present acceptance_criteria → returned verbatim
await test('TC1: _getSpecAcceptanceCriteria returns spec.json.acceptance_criteria when present', () => {
  const { projectRoot } = createReaderHarness({
    goal: sampleGoal,
    acceptance_criteria: sampleCriteria,
  });
  try {
    const pipeline = makePipeline(projectRoot);
    const result = pipeline._getSpecAcceptanceCriteria();
    assert.ok(Array.isArray(result), 'expected an array');
    assert.strictEqual(result.length, sampleCriteria.length, `expected ${sampleCriteria.length} criteria, got ${result.length}`);
    assert.deepStrictEqual(result, sampleCriteria, 'expected the acceptance_criteria array verbatim');
  } finally {
    cleanup(projectRoot);
  }
});

// TC2 — spec.json absent → []
await test('TC2: _getSpecAcceptanceCriteria returns [] when spec.json is absent', () => {
  const { projectRoot, specJsonPath } = createReaderHarness(undefined);
  try {
    assert.ok(!fs.existsSync(specJsonPath), 'sanity: spec.json must not exist for this case');
    const pipeline = makePipeline(projectRoot);
    assert.deepStrictEqual(pipeline._getSpecAcceptanceCriteria(), []);
  } finally {
    cleanup(projectRoot);
  }
});

// TC3 — spec.json present but acceptance_criteria empty → []
await test('TC3: _getSpecAcceptanceCriteria returns [] when acceptance_criteria is an empty array', () => {
  const { projectRoot } = createReaderHarness({ goal: sampleGoal, acceptance_criteria: [] });
  try {
    const pipeline = makePipeline(projectRoot);
    assert.deepStrictEqual(pipeline._getSpecAcceptanceCriteria(), []);
  } finally {
    cleanup(projectRoot);
  }
});

// TC4 — spec.json present but acceptance_criteria key missing → []
await test('TC4: _getSpecAcceptanceCriteria returns [] when acceptance_criteria key is missing', () => {
  const { projectRoot } = createReaderHarness({ goal: sampleGoal });
  try {
    const pipeline = makePipeline(projectRoot);
    assert.deepStrictEqual(pipeline._getSpecAcceptanceCriteria(), []);
  } finally {
    cleanup(projectRoot);
  }
});

// TC5 — spec.json corrupt (JSON.parse fails) → [] (fail-soft, no throw)
await test('TC5: _getSpecAcceptanceCriteria returns [] when spec.json is corrupt (parse-fail, no throw)', () => {
  const { projectRoot } = createReaderHarness('{ this is not valid json ]]]');
  try {
    const pipeline = makePipeline(projectRoot);
    let result;
    assert.doesNotThrow(() => { result = pipeline._getSpecAcceptanceCriteria(); }, 'must not throw on corrupt json');
    assert.deepStrictEqual(result, []);
  } finally {
    cleanup(projectRoot);
  }
});

// ── _getSpecGoal ────────────────────────────────────────────────────────────

// TC6 — present goal → returned verbatim
await test('TC6: _getSpecGoal returns spec.json.goal when present', () => {
  const { projectRoot } = createReaderHarness({ goal: sampleGoal, acceptance_criteria: sampleCriteria });
  try {
    const pipeline = makePipeline(projectRoot);
    assert.strictEqual(pipeline._getSpecGoal(), sampleGoal);
  } finally {
    cleanup(projectRoot);
  }
});

// TC7 — spec.json absent → ''
await test("TC7: _getSpecGoal returns '' when spec.json is absent", () => {
  const { projectRoot, specJsonPath } = createReaderHarness(undefined);
  try {
    assert.ok(!fs.existsSync(specJsonPath), 'sanity: spec.json must not exist for this case');
    const pipeline = makePipeline(projectRoot);
    assert.strictEqual(pipeline._getSpecGoal(), '');
  } finally {
    cleanup(projectRoot);
  }
});

// TC8 — spec.json present but goal key missing → ''
await test("TC8: _getSpecGoal returns '' when goal key is missing", () => {
  const { projectRoot } = createReaderHarness({ acceptance_criteria: sampleCriteria });
  try {
    const pipeline = makePipeline(projectRoot);
    assert.strictEqual(pipeline._getSpecGoal(), '');
  } finally {
    cleanup(projectRoot);
  }
});

// TC9 — spec.json present with empty-string goal → '' (and is a string)
await test("TC9: _getSpecGoal returns '' when goal is the empty string", () => {
  const { projectRoot } = createReaderHarness({ goal: '', acceptance_criteria: [] });
  try {
    const pipeline = makePipeline(projectRoot);
    assert.strictEqual(pipeline._getSpecGoal(), '');
  } finally {
    cleanup(projectRoot);
  }
});

// TC10 — spec.json corrupt (JSON.parse fails) → '' (fail-soft, no throw)
await test("TC10: _getSpecGoal returns '' when spec.json is corrupt (parse-fail, no throw)", () => {
  const { projectRoot } = createReaderHarness('}{ not json');
  try {
    const pipeline = makePipeline(projectRoot);
    let result;
    assert.doesNotThrow(() => { result = pipeline._getSpecGoal(); }, 'must not throw on corrupt json');
    assert.strictEqual(result, '');
  } finally {
    cleanup(projectRoot);
  }
});

// ── Caching ─────────────────────────────────────────────────────────────────

// TC11 — readers cache: second call returns the same reference (cached)
await test('TC11: readers cache results on the instance (second call returns same reference)', () => {
  const { projectRoot } = createReaderHarness({ goal: sampleGoal, acceptance_criteria: sampleCriteria });
  try {
    const pipeline = makePipeline(projectRoot);
    const ac1 = pipeline._getSpecAcceptanceCriteria();
    const ac2 = pipeline._getSpecAcceptanceCriteria();
    assert.strictEqual(ac1, ac2, 'expected acceptance_criteria reader to return a cached reference');

    const g1 = pipeline._getSpecGoal();
    const g2 = pipeline._getSpecGoal();
    assert.strictEqual(g1, g2, 'expected goal reader to return a cached value');
  } finally {
    cleanup(projectRoot);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
