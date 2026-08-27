/**
 * test-stability-contract.js — Contract tests for index.js public surface stability.
 *
 * Asserts that the named exports of index.js exactly match the expected set,
 * that HarnessShell is absent, that package.json exports are pinned, and that
 * every schema/helper from _schemas.js is re-exported. TC6-TC11 additionally
 * pin the docs/STABILITY-CONTRACT.md "Pro integration surface" section —
 * the v0 bundle schema shape, the memory/ lifecycle guarantee, the
 * bundle-filename derivation rule, the fail-open whole-bundle rejection
 * contract, and the existing Pro-facing data outlets — alongside the
 * index.js/package.json surface pins in TC1-TC5. TC15 additionally pins the
 * Archive layout's `manifest.json` shape by invoking the exported
 * `buildManifest` from src/cli/commands/archive.js directly on a synthetic
 * minimal input — the produced key set (with and without `haltInfo`) and the
 * CONDITIONAL, failed-archive-only `haltReason`/`haltTaskId` fields.
 *
 * Run: node test/test-stability-contract.js
 */
import assert from 'assert';
import os from 'os';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { writeMissionState } from '../src/orchestrator/core/state.js';
import { buildManifest } from '../src/cli/commands/archive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    failCount++;
  }
}

const EXPECTED = [
  'Pipeline',
  'SessionManager',
  'SessionHandle',
  'Logger',
  'TokenTracker',
  'config',
  'Planner',
  'Executor',
  'Verifier',
  'Analyzer',
  'Reviewer',
  'Summarizer',
  'Brainstormer',
  'verifierSchema',
  'analyzerSchema',
  'executorSchema',
  'summarizerSchema',
  'reviewerSchema',
  'assumptionRemediationSchema',
  'reviewRemediationSchema',
  'taskReplanSchema',
  'brainstormSpecSchema',
  'extractStructured',
  'validateStructured',
];

const SCHEMA_HELPER_NAMES = [
  'verifierSchema',
  'analyzerSchema',
  'executorSchema',
  'summarizerSchema',
  'reviewerSchema',
  'assumptionRemediationSchema',
  'reviewRemediationSchema',
  'taskReplanSchema',
  'brainstormSpecSchema',
  'extractStructured',
  'validateStructured',
];

// ── TC1: index.js exports exactly the expected set ────────────────────────

const mod = await import('../index.js');

test('TC1 index.js exports exactly the expected set', () => {
  const actual = Object.keys(mod).sort();
  const expected = [...EXPECTED].sort();
  assert.deepStrictEqual(actual, expected);
});

// ── TC2: HarnessShell is absent from index.js exports ────────────────────

test('TC2 HarnessShell is absent from index.js exports', () => {
  assert.ok(!('HarnessShell' in mod));
});

// ── TC3: package.json exports field is exactly { '.': './index.js' } ──────

test("TC3 package.json exports field is exactly { '.': './index.js' }", () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
  assert.ok(pkg.exports !== null && typeof pkg.exports === 'object', 'pkg.exports must be an object');
  assert.strictEqual(pkg.exports['.'], './index.js');
  assert.strictEqual(Object.keys(pkg.exports).length, 1);
});

// ── TC4: every schema/helper from _schemas.js is re-exported by index.js ──

test('TC4 every schema/helper from _schemas.js is re-exported by index.js', () => {
  for (const name of SCHEMA_HELPER_NAMES) {
    assert.ok(name in mod, name);
  }
});

// ── TC5: test is self-contained (no top-level exports) ────────────────────

test('TC5 test is self-contained', () => {
  const src = readFileSync(__filename, 'utf8');
  assert.ok(!/^export /m.test(src), 'test file must not contain top-level export statements');
});

const STABILITY_DOC = readFileSync(resolve(__dirname, '../docs/STABILITY-CONTRACT.md'), 'utf8');

const BUNDLE_SCHEMA_FIELDS = [
  'schemaVersion',
  'generatedBy',
  'baseCommit',
  'entries',
  'id',
  'kind',
  'text',
  'evidence',
  'file',
  'symbol',
  'lastScannedCommit',
];

// ── TC6: 'Pro integration surface' section heading is documented ──────────

test("TC6 'Pro integration surface' section heading is documented", () => {
  assert.ok(STABILITY_DOC.includes('Pro integration surface'), "STABILITY-CONTRACT.md must contain the 'Pro integration surface' heading");
});

// ── TC7: every v0 bundle schema field is pinned in the doc ────────────────

test('TC7 every v0 bundle schema field is pinned in the doc', () => {
  for (const field of BUNDLE_SCHEMA_FIELDS) {
    assert.ok(STABILITY_DOC.includes(field), `STABILITY-CONTRACT.md must pin bundle schema field: ${field}`);
  }
});

// ── TC8: memory/ lifecycle guarantee is documented ────────────────────────

test('TC8 memory/ lifecycle guarantee is documented', () => {
  assert.ok(STABILITY_DOC.includes('memory/'), "STABILITY-CONTRACT.md must contain the literal token 'memory/'");
  assert.ok(/survives every core cleanup operation/.test(STABILITY_DOC), 'STABILITY-CONTRACT.md must document that memory/ survives cleanup');
});

// ── TC9: bundle filename-derivation rule is pinned verbatim in the doc ────

test('TC9 bundle filename-derivation rule is pinned verbatim in the doc', () => {
  assert.ok(STABILITY_DOC.includes('spec.json'), "STABILITY-CONTRACT.md must contain the literal token 'spec.json'");
  assert.ok(STABILITY_DOC.includes('bundle.json'), "STABILITY-CONTRACT.md must contain the literal token 'bundle.json'");
  assert.ok(
    STABILITY_DOC.includes('`<slug>.spec.json` yields `<slug>.bundle.json`'),
    "STABILITY-CONTRACT.md must pin the project-root example: '<slug>.spec.json' yields '<slug>.bundle.json'"
  );
  assert.ok(
    STABILITY_DOC.includes("queue entry's fixed-name `spec.json` yields `bundle.json`"),
    "STABILITY-CONTRACT.md must pin the queue-entry fixed-name case: 'spec.json' yields 'bundle.json'"
  );
});

// ── TC10: fail-open whole-bundle rejection contract is documented ─────────

test('TC10 fail-open whole-bundle rejection contract is documented', () => {
  assert.ok(
    STABILITY_DOC.includes('a malformed, schema-invalid, or oversized bundle is rejected whole'),
    'STABILITY-CONTRACT.md must document that a malformed, schema-invalid, or oversized bundle is rejected whole'
  );
  assert.ok(
    STABILITY_DOC.includes('it is never truncated'),
    'STABILITY-CONTRACT.md must document that a rejected bundle is never truncated'
  );
  assert.ok(
    STABILITY_DOC.includes(
      "Rejection emits a `console.warn` on the run's console output, and the run continues on the no-bundle path"
    ),
    "STABILITY-CONTRACT.md must document that rejection emits a console.warn on the run's console output and the run continues on the no-bundle path"
  );
  assert.ok(
    STABILITY_DOC.includes('When no bundle file exists, prompts are byte-identical to pre-change output'),
    'STABILITY-CONTRACT.md must document that when no bundle file exists, prompts are byte-identical to pre-change output'
  );
});

// ── TC11: existing Pro-facing data outlets are enumerated in the doc ──────

const PRO_FACING_DATA_OUTLETS = [
  '.harness/logs/',
  '.harness/logs/token-usage.json',
  'archives/<id>/manifest.json',
  'archives/candidates.jsonl',
  'archives/warnings.jsonl',
];

test('TC11 existing Pro-facing data outlets are enumerated in the doc', () => {
  for (const outlet of PRO_FACING_DATA_OUTLETS) {
    assert.ok(STABILITY_DOC.includes(outlet), `STABILITY-CONTRACT.md must pin Pro-facing data outlet: ${outlet}`);
  }
  assert.ok(
    STABILITY_DOC.includes('Injected-entry telemetry is append-only log data under'),
    'STABILITY-CONTRACT.md must document that injected-entry telemetry is append-only log data'
  );
  assert.ok(
    STABILITY_DOC.includes('never enters resume-affecting state files'),
    'STABILITY-CONTRACT.md must document that injected-entry telemetry never enters resume-affecting state files'
  );
});

// ── TC12: 'Archive layout' contract/internal directory-inventory split ────

const CONTRACT_ARTIFACTS = [
  'manifest.json',
  'spec.md',
  'spec.json',
  'state/mission-*.json',
  'verification/',
  'analysis/',
  'invalidations.jsonl',
  'history-',
];

const INTERNAL_ARTIFACTS = [
  'report.html',
  'dispersion-fingerprint.json',
  'snapshots/',
  'progress/',
  'verify/',
  'plan/',
];

test("TC12 'Archive layout' contract/internal directory-inventory split is documented and disjoint", () => {
  assert.ok(STABILITY_DOC.includes('Archive layout'), "STABILITY-CONTRACT.md must contain the 'Archive layout' heading token");
  for (const artifact of CONTRACT_ARTIFACTS) {
    assert.ok(STABILITY_DOC.includes(artifact), `STABILITY-CONTRACT.md must pin contract artifact: ${artifact}`);
  }
  for (const artifact of INTERNAL_ARTIFACTS) {
    assert.ok(STABILITY_DOC.includes(artifact), `STABILITY-CONTRACT.md must pin internal artifact: ${artifact}`);
  }
  assert.ok(
    STABILITY_DOC.includes('may change or vanish in any release without notice'),
    "STABILITY-CONTRACT.md must document that internal artifacts may change or vanish in any release without notice"
  );
  const overlap = CONTRACT_ARTIFACTS.filter((artifact) => INTERNAL_ARTIFACTS.includes(artifact));
  assert.deepStrictEqual(overlap, [], 'CONTRACT_ARTIFACTS and INTERNAL_ARTIFACTS must share no member');
});

// ── TC13: doc-pinned key lists are bound to the exported schema property sets ──

const REGRESSION_MILESTONE_KEYS = ['milestoneId', 'passed', 'softPass', 'isStub', 'findings'];
const MILESTONE_SUMMARY_KEYS = ['milestoneId', 'summary', 'tasks', 'timestamp'];

test('TC13 every verifierSchema/analyzerSchema/reviewerSchema property is pinned in the doc', () => {
  const { verifierSchema, analyzerSchema, reviewerSchema } = mod;

  for (const key of Object.keys(verifierSchema.properties)) {
    assert.ok(STABILITY_DOC.includes(key), `STABILITY-CONTRACT.md must pin verifierSchema property: ${key}`);
  }
  for (const key of Object.keys(analyzerSchema.properties)) {
    assert.ok(STABILITY_DOC.includes(key), `STABILITY-CONTRACT.md must pin analyzerSchema property: ${key}`);
  }
  for (const key of Object.keys(reviewerSchema.properties)) {
    assert.ok(STABILITY_DOC.includes(key), `STABILITY-CONTRACT.md must pin reviewerSchema property: ${key}`);
  }

  assert.ok(
    !Object.keys(verifierSchema.properties).includes('specReadAudit'),
    'specReadAudit must NOT be a verifierSchema property'
  );
  assert.ok(
    STABILITY_DOC.includes('specReadAudit'),
    "STABILITY-CONTRACT.md must document specReadAudit as a sidecar-only field"
  );
  assert.ok(
    /specReadAudit.{0,40}NOT a schema property/s.test(STABILITY_DOC) ||
      /NOT a schema property.{0,40}specReadAudit/s.test(STABILITY_DOC),
    'STABILITY-CONTRACT.md must document specReadAudit as NOT a schema property (sidecar-only)'
  );

  for (const key of REGRESSION_MILESTONE_KEYS) {
    assert.ok(STABILITY_DOC.includes(key), `STABILITY-CONTRACT.md must pin regression-milestone key: ${key}`);
  }
  for (const key of MILESTONE_SUMMARY_KEYS) {
    assert.ok(STABILITY_DOC.includes(key), `STABILITY-CONTRACT.md must pin milestone-summary key: ${key}`);
  }
});

// ── TC14: writeMissionState output shape pinned against REAL writer output ─

const TASK_RECORD_KEYS = [
  'id',
  'description',
  'status',
  'createdAt',
  'startedAt',
  'completedAt',
  'targetFiles',
  'dependencies',
  'testCases',
  'tracesScenario',
  'patternReferences',
  'dataSchemas',
  'verifyFile',
  'progressFile',
  'verificationFile',
  'retryCount',
];

test('TC14 writeMissionState output shape matches the documented contract', () => {
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'cc-orch-stability-tc14-'));
  try {
    const missionId = '999-999';
    const subMissionId = '999-999-999';
    const taskId = '999-999-999-001';

    const decomp = {
      subMissions: [
        {
          id: subMissionId,
          description: 'synthetic sub-mission',
          tasks: [
            {
              id: taskId,
              description: 'synthetic task',
              targetFiles: ['test/fixture.js'],
              dependencies: [],
              testCases: ['TC1'],
              tracesScenario: [],
              patternReferences: [],
              dataSchemas: [],
            },
          ],
        },
      ],
    };

    writeMissionState(tmpDir, missionId, 'synthetic mission', decomp);

    const missionState = JSON.parse(
      readFileSync(join(tmpDir, 'state', `mission-${missionId}.json`), 'utf8')
    );

    // (a) top-level key set is exactly id, missionId, description, status, subMissions
    assert.deepStrictEqual(
      Object.keys(missionState).sort(),
      ['description', 'id', 'missionId', 'status', 'subMissions'].sort()
    );

    // (b) subMissions is a plain object keyed by sub-mission id, not an Array
    assert.ok(!Array.isArray(missionState.subMissions), 'subMissions must not be an Array');
    assert.ok(
      Object.prototype.hasOwnProperty.call(missionState.subMissions, subMissionId),
      `subMissions must have an own key for sub-mission id ${subMissionId}`
    );

    const subMission = missionState.subMissions[subMissionId];

    // (c) the sub-mission's tasks field is likewise an id-keyed object, not an Array
    assert.ok(!Array.isArray(subMission.tasks), 'subMission.tasks must not be an Array');
    assert.ok(
      Object.prototype.hasOwnProperty.call(subMission.tasks, taskId),
      `subMission.tasks must have an own key for task id ${taskId}`
    );

    const task = subMission.tasks[taskId];

    // (d) the produced task object's key set equals the documented set
    assert.deepStrictEqual(Object.keys(task).sort(), [...TASK_RECORD_KEYS].sort());

    // (e) every produced key is documented in docs/STABILITY-CONTRACT.md
    for (const key of Object.keys(task)) {
      assert.ok(STABILITY_DOC.includes(key), `STABILITY-CONTRACT.md must document task record key: ${key}`);
    }

    // invalidationReason/invalidatedAt: absent from a freshly written pending
    // task, but documented as CONDITIONAL invalidated-task fields.
    assert.ok(
      !Object.keys(task).includes('invalidationReason'),
      'invalidationReason must be absent from a freshly written pending task'
    );
    assert.ok(
      !Object.keys(task).includes('invalidatedAt'),
      'invalidatedAt must be absent from a freshly written pending task'
    );
    assert.ok(
      STABILITY_DOC.includes('invalidationReason'),
      'STABILITY-CONTRACT.md must document invalidationReason as a conditional field'
    );
    assert.ok(
      STABILITY_DOC.includes('invalidatedAt'),
      'STABILITY-CONTRACT.md must document invalidatedAt as a conditional field'
    );
    assert.ok(
      /CONDITIONAL[\s\S]{0,400}invalidationReason/.test(STABILITY_DOC) ||
        /invalidationReason[\s\S]{0,400}CONDITIONAL/.test(STABILITY_DOC),
      'STABILITY-CONTRACT.md must document invalidationReason under a CONDITIONAL task-fields section'
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC15: buildManifest output shape pinned against REAL builder output ───

const MANIFEST_KEYS = [
  'id',
  'name',
  'seq',
  'spec',
  'specSnapshot',
  'startedAt',
  'archivedAt',
  'gitHead',
  'gitStatus',
  'models',
  'milestones',
  'totalCost',
  'totalSessions',
  'headline',
  'bugs',
  'summary',
  'changelog',
  'uncertainAssumptions',
];

test('TC15 buildManifest output shape matches the documented contract', () => {
  const state = {
    name: 'synthetic',
    spec: 'spec.md',
    startedAt: '2026-01-01T00:00:00.000Z',
    milestones: {},
    uncertainAssumptions: [],
  };
  const seq = '999';
  const slug = 'synthetic-slug';
  const specContent = '# synthetic spec';
  const gitInfo = { head: 'deadbeef', status: 'clean' };
  const summaryData = { headline: 'headline', bugs: [], summary: 'summary', changelog: [] };
  const usageData = { totalCost: 0, totalSessions: 0 };

  // (a) Without haltInfo: key set is exactly the 18 documented keys, and
  // haltReason/haltTaskId are ABSENT.
  const manifest = buildManifest(state, seq, slug, specContent, gitInfo, summaryData, usageData);

  assert.deepStrictEqual(Object.keys(manifest).sort(), [...MANIFEST_KEYS].sort());
  assert.ok(!Object.keys(manifest).includes('haltReason'), 'haltReason must be absent without haltInfo');
  assert.ok(!Object.keys(manifest).includes('haltTaskId'), 'haltTaskId must be absent without haltInfo');

  // (b) every produced key is documented in docs/STABILITY-CONTRACT.md
  for (const key of Object.keys(manifest)) {
    assert.ok(STABILITY_DOC.includes(key), `STABILITY-CONTRACT.md must document manifest key: ${key}`);
  }

  // (c) With haltInfo: haltReason and haltTaskId are added (failed-archive conditional).
  const haltInfo = { haltReason: 'circuit-breaker', haltTaskId: '001-001-001-001' };
  const failedManifest = buildManifest(state, seq, slug, specContent, gitInfo, summaryData, usageData, haltInfo);

  assert.deepStrictEqual(
    Object.keys(failedManifest).sort(),
    [...MANIFEST_KEYS, 'haltReason', 'haltTaskId'].sort()
  );
  assert.strictEqual(failedManifest.haltReason, 'circuit-breaker');
  assert.strictEqual(failedManifest.haltTaskId, '001-001-001-001');

  // (d) haltReason/haltTaskId are documented as failed-archive/CONDITIONAL-only.
  assert.ok(
    STABILITY_DOC.includes('haltReason') && STABILITY_DOC.includes('haltTaskId'),
    'STABILITY-CONTRACT.md must document haltReason and haltTaskId'
  );
  assert.ok(
    /CONDITIONAL[\s\S]{0,400}haltReason/.test(STABILITY_DOC) ||
      /haltReason[\s\S]{0,400}CONDITIONAL/.test(STABILITY_DOC),
    'STABILITY-CONTRACT.md must document haltReason under a CONDITIONAL, failed-archive-only section'
  );
  assert.ok(
    /failed\/halted[\s\S]{0,200}haltInfo/.test(STABILITY_DOC) ||
      /haltInfo[\s\S]{0,200}failed\/halted/.test(STABILITY_DOC),
    'STABILITY-CONTRACT.md must document that haltReason/haltTaskId are present only when haltInfo is supplied (failed-archive path)'
  );
});

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount === 0 ? 0 : 1);
