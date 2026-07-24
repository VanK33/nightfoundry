/**
 * test-dispersion-fingerprint.js — Contract tests for the L2 sidecar.
 *
 * Builds temp .harness/ fixtures, calls computeFingerprint /
 * writeFingerprint, asserts the resulting object matches expectation.
 * No SDK auth, no real cc-orch run.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  computeFingerprint,
  writeFingerprint,
} from '../src/orchestrator/core/dispersion-fingerprint.js';

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    passCount++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failCount++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${e.message}`);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  }
}

function mkTmpHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fingerprint-test-'));
  const harness = path.join(dir, '.harness');
  fs.mkdirSync(path.join(harness, 'state'), { recursive: true });
  fs.mkdirSync(path.join(harness, 'verification'), { recursive: true });
  return { root: dir, harness };
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function writeMission(harness, id, tasks, subMissionId) {
  const smId = subMissionId || `${id}-001`;
  writeJson(path.join(harness, 'state', `mission-${id}.json`), {
    id,
    missionId: id,
    description: `mission ${id}`,
    subMissions: {
      [smId]: {
        id: smId,
        description: `sub ${smId}`,
        tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
      },
    },
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

await test('empty .harness/ → safe defaults + warnings populated', () => {
  const { root, harness } = mkTmpHarness();
  const fp = computeFingerprint(harness);
  assert.equal(fp.fingerprintVersion, 1);
  assert.equal(fp.planStructure.milestoneCount, 0);
  assert.equal(fp.planStructure.missionCount, 0);
  assert.equal(fp.planStructure.taskCount, 0);
  assert.ok(Array.isArray(fp.warnings));
  assert.ok(fp.warnings.length > 0, 'expected warnings for empty harness');
  fs.rmSync(root, { recursive: true, force: true });
});

await test('top-level keys present', () => {
  const { root, harness } = mkTmpHarness();
  const fp = computeFingerprint(harness);
  const expected = ['fingerprintVersion', 'runId', 'specSlug', 'specHash',
                    'planStructure', 'taskDescriptions', 'verifierVerdicts',
                    'reviewerFindings', 'warnings'];
  for (const k of expected) {
    assert.ok(k in fp, `missing top-level key: ${k}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

await test('flat classification: 1 mission with 1 task', () => {
  const { root, harness } = mkTmpHarness();
  writeMission(harness, '001-001', [
    { id: '001-001-001-001', description: 'do one thing', targetFiles: ['src/a.js'] },
  ]);
  const fp = computeFingerprint(harness);
  assert.equal(fp.planStructure.decompositionStyle.classification, 'flat');
  fs.rmSync(root, { recursive: true, force: true });
});

await test('mixed classification: one 1-task mission and one 3-task mission', () => {
  const { root, harness } = mkTmpHarness();
  writeMission(harness, '001-001', [
    { id: '001-001-001-001', description: 'one', targetFiles: ['src/a.js'] },
  ]);
  writeMission(harness, '001-002', [
    { id: '001-002-001-001', description: 'a', targetFiles: ['src/b.js'] },
    { id: '001-002-001-002', description: 'b', targetFiles: ['src/b.js'] },
    { id: '001-002-001-003', description: 'c', targetFiles: ['src/b.js'] },
  ]);
  const fp = computeFingerprint(harness);
  assert.equal(fp.planStructure.decompositionStyle.classification, 'mixed');
  assert.equal(fp.planStructure.missionCount, 2);
  assert.equal(fp.planStructure.taskCount, 4);
  fs.rmSync(root, { recursive: true, force: true });
});

await test('grouped classification: all missions have ≥2 tasks', () => {
  const { root, harness } = mkTmpHarness();
  writeMission(harness, '001-001', [
    { id: '001-001-001-001', description: 'a', targetFiles: ['src/a.js'] },
    { id: '001-001-001-002', description: 'b', targetFiles: ['src/a.js'] },
  ]);
  writeMission(harness, '001-002', [
    { id: '001-002-001-001', description: 'c', targetFiles: ['src/b.js'] },
    { id: '001-002-001-002', description: 'd', targetFiles: ['src/b.js'] },
    { id: '001-002-001-003', description: 'e', targetFiles: ['src/b.js'] },
  ]);
  const fp = computeFingerprint(harness);
  assert.equal(fp.planStructure.decompositionStyle.classification, 'grouped');
  fs.rmSync(root, { recursive: true, force: true });
});

await test('targetFilesOverlap: 2 missions sharing one file → missionsWithSharedTargets=1', () => {
  const { root, harness } = mkTmpHarness();
  writeMission(harness, '001-001', [
    { id: '001-001-001-001', description: 'x', targetFiles: ['src/shared.js', 'src/a.js'] },
  ]);
  writeMission(harness, '001-002', [
    { id: '001-002-001-001', description: 'y', targetFiles: ['src/shared.js'] },
  ]);
  const fp = computeFingerprint(harness);
  assert.equal(fp.planStructure.targetFilesOverlap.missionsWithSharedTargets, 1);
  assert.equal(fp.planStructure.targetFilesOverlap.uniqueFilesTouched, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

await test('descriptionHash normalization strips line refs', () => {
  const { root, harness } = mkTmpHarness();
  writeMission(harness, '001-001', [
    { id: '001-001-001-001', description: 'fix bug at line 42 and update (lines 10-12)', targetFiles: ['src/a.js'] },
  ]);
  writeMission(harness, '001-002', [
    { id: '001-002-001-001', description: 'fix bug at  and update ', targetFiles: ['src/b.js'] },
  ]);
  const fp = computeFingerprint(harness);
  const hashA = fp.taskDescriptions.find((t) => t.taskId === '001-001-001-001').descriptionHash;
  const hashB = fp.taskDescriptions.find((t) => t.taskId === '001-002-001-001').descriptionHash;
  assert.equal(hashA, hashB, 'line refs should be stripped before hashing');
  fs.rmSync(root, { recursive: true, force: true });
});

await test('verifierVerdicts: back_reference_check.deviations length → backReferenceDeviationCount', () => {
  const { root, harness } = mkTmpHarness();
  writeJson(path.join(harness, 'verification', 'task-001-001-001-001.json'), {
    result: 'PASSED',
    hardChecks: [],
    taskScopeChecks: [],
    back_reference_check: {
      spec_consulted: true,
      plan_consulted: true,
      deviations: [
        { kind: 'spec_mismatch', description: 'd1', evidence: 'e1' },
        { kind: 'plan_contradiction', description: 'd2', evidence: 'e2' },
        { kind: 'missing_constraint', description: 'd3', evidence: 'e3' },
      ],
    },
  });
  const fp = computeFingerprint(harness);
  assert.equal(fp.verifierVerdicts.length, 1);
  assert.equal(fp.verifierVerdicts[0].backReferenceDeviationCount, 3);
  assert.equal(fp.verifierVerdicts[0].result, 'PASSED');
  fs.rmSync(root, { recursive: true, force: true });
});

await test('reviewerFindings missing → empty + warning recorded', () => {
  const { root, harness } = mkTmpHarness();
  // No review-milestone files at all
  const fp = computeFingerprint(harness);
  assert.deepEqual(fp.reviewerFindings, []);
  assert.ok(fp.warnings.some((w) => /reviewer milestone/.test(w) || /no reviewer/.test(w)),
            `expected reviewer warning, got: ${JSON.stringify(fp.warnings)}`);
  fs.rmSync(root, { recursive: true, force: true });
});

await test('reviewerFindings: shape mapping + descriptionHash bounded', () => {
  const { root, harness } = mkTmpHarness();
  const longDesc = 'x'.repeat(500);
  writeJson(path.join(harness, 'verification', 'review-milestone-001.json'), {
    result: 'PASSED',
    findings: [
      { severity: 'info', category: 'plan-coherence', file: 'src/x.js', description: longDesc },
      { severity: 'warning', category: 'integration', file: 'src/y.js', description: 'short' },
    ],
    notes: 'cross-cutting',
  });
  const fp = computeFingerprint(harness);
  assert.equal(fp.reviewerFindings.length, 2);
  assert.equal(fp.reviewerFindings[0].category, 'plan-coherence');
  assert.equal(fp.reviewerFindings[0].severity, 'info');
  assert.ok(/^[0-9a-f]{64}$/.test(fp.reviewerFindings[0].descriptionHash));
  fs.rmSync(root, { recursive: true, force: true });
});

await test('writeFingerprint: writes valid JSON to harnessDir/dispersion-fingerprint.json', () => {
  const { root, harness } = mkTmpHarness();
  writeMission(harness, '001-001', [
    { id: '001-001-001-001', description: 'one', targetFiles: ['src/a.js'] },
  ]);
  const { path: outPath, fingerprint } = writeFingerprint(harness);
  assert.equal(outPath, path.join(harness, 'dispersion-fingerprint.json'));
  const fromDisk = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(fromDisk.fingerprintVersion, fingerprint.fingerprintVersion);
  assert.equal(fromDisk.planStructure.missionCount, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

// TC12 — hardCheckHashes: renaming a check while keeping its command must NOT change the hash
await test('hardCheckHashes: object hardChecks hash command identity, not name', () => {
  const { root, harness } = mkTmpHarness();
  // Two tasks with identical commands but different check names
  writeMission(harness, '001-001', [
    {
      id: '001-001-001-001',
      description: 'a',
      targetFiles: ['src/a.js'],
      hardChecks: [{ name: 'name-A', command: 'ls src/a.js' }],
    },
  ]);
  writeMission(harness, '001-002', [
    {
      id: '001-002-001-001',
      description: 'b',
      targetFiles: ['src/a.js'],
      hardChecks: [{ name: 'name-B-different', command: 'ls src/a.js' }],
    },
  ]);
  const fp = computeFingerprint(harness);
  const a = fp.taskDescriptions.find((t) => t.taskId === '001-001-001-001');
  const b = fp.taskDescriptions.find((t) => t.taskId === '001-002-001-001');
  assert.equal(a.hardCheckHashes[0], b.hardCheckHashes[0],
    'renaming a hardCheck (same command) must NOT change its hash');
  fs.rmSync(root, { recursive: true, force: true });
});

// TC13 — archive roundtrip: dispersion-fingerprint.json survives moveHarnessToArchive
await test('archive roundtrip: dispersion-fingerprint.json lands in archiveDir after moveHarnessToArchive', async () => {
  const { moveHarnessToArchive } = await import('../src/cli/commands/archive.js');
  const { root, harness } = mkTmpHarness();
  // Write a state.json + a fingerprint at harness root
  fs.writeFileSync(path.join(harness, 'state.json'), JSON.stringify({ projectMeta: {} }));
  fs.writeFileSync(path.join(harness, 'dispersion-fingerprint.json'), JSON.stringify({ fingerprintVersion: 1 }));
  const archiveDir = path.join(root, 'archive-NNN');
  moveHarnessToArchive(harness, archiveDir);
  assert.ok(
    fs.existsSync(path.join(archiveDir, 'dispersion-fingerprint.json')),
    'fingerprint file must be moved into archive directory',
  );
  fs.rmSync(root, { recursive: true, force: true });
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
