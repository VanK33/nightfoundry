/**
 * test-dispersion-cli.js — Unit tests for src/cli/commands/dispersion.js
 *
 * Tests listArchivesWithFingerprints, readArchiveFingerprint,
 * summarizeFingerprintLine, formatFingerprintDetail, and dispersion.
 *
 * No Claude auth, no SDK. Pure fs + temp dirs.
 * Run: node test/test-dispersion-cli.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import {
  listArchivesWithFingerprints,
  readArchiveFingerprint,
  summarizeFingerprintLine,
  formatFingerprintDetail,
  dispersion,
  compareFingerprints,
} from '../src/cli/commands/dispersion.js';

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

// ── stdout/stderr capture helper ──────────────────────────────────────────────

function captureOutput(fn) {
  const outChunks = [];
  const errChunks = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);

  process.stdout.write = (chunk, ...args) => {
    outChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk, ...args) => {
    errChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  console.log = (...args) => {
    outChunks.push(args.join(' ') + '\n');
  };
  console.error = (...args) => {
    errChunks.push(args.join(' ') + '\n');
  };

  try {
    fn();
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
  }

  return {
    stdout: outChunks.join(''),
    stderr: errChunks.join(''),
  };
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

/**
 * Create an archive directory with a dispersion-fingerprint.json file.
 *
 * @param {string} tmpDir
 * @param {string} archiveId
 * @param {object} fingerprint
 */
function makeArchiveWithFingerprint(tmpDir, archiveId, fingerprint) {
  const archiveDir = path.join(tmpDir, 'archives', archiveId);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(
    path.join(archiveDir, 'dispersion-fingerprint.json'),
    JSON.stringify(fingerprint, null, 2),
    'utf8'
  );
}

/**
 * Return a minimal valid fingerprint object matching the dispersion schema.
 *
 * @returns {object}
 */
function makeSampleFingerprint() {
  return {
    fingerprintVersion: 1,
    runId: 'run-test-001',
    specSlug: 'test-spec',
    specHash: 'abc123def456',
    planStructure: {
      milestoneCount: 1,
      missionCount: 1,
      taskCount: 2,
      missionsByMilestone: [1],
      tasksByMission: [2],
      decompositionStyle: {
        tasksPerMissionMin: 2,
        tasksPerMissionMax: 2,
        tasksPerMissionMean: 2.0,
        tasksPerMissionCV: 0.0,
        classification: 'grouped',
      },
      targetFilesOverlap: {
        missionsWithSharedTargets: 0,
        uniqueFilesTouched: 1,
        filesAcrossAllMissions: 1,
      },
    },
    taskDescriptions: [
      {
        taskId: '001-001-001',
        targetFiles: ['src/foo.js'],
        descriptionHash: 'deadbeef00000000',
        hardCheckCount: 1,
        hardCheckHashes: ['cafebabe00000000'],
      },
    ],
    verifierVerdicts: [
      {
        taskId: '001-001-001',
        result: 'PASSED',
        backReferenceDeviationCount: 0,
      },
    ],
    reviewerFindings: [],
    warnings: [],
  };
}

// ── TC1: listArchivesWithFingerprints — no archives/ dir returns [] ───────────

test('TC1: listArchivesWithFingerprints with no archives/ dir returns []', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc1-'));
  try {
    const result = listArchivesWithFingerprints(tmpDir);
    assert.ok(Array.isArray(result), 'Expected an array');
    assert.strictEqual(result.length, 0, `Expected empty array, got length ${result.length}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC2: listArchivesWithFingerprints — one archive with fingerprint ──────────

test('TC2: listArchivesWithFingerprints with one archive having fingerprint returns array of length 1 with matching archiveId', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc2-'));
  try {
    makeArchiveWithFingerprint(tmpDir, 'archive-001', makeSampleFingerprint());
    const result = listArchivesWithFingerprints(tmpDir);
    assert.ok(Array.isArray(result), 'Expected an array');
    assert.strictEqual(result.length, 1, `Expected length 1, got ${result.length}`);
    assert.strictEqual(result[0].archiveId, 'archive-001', `Expected archiveId 'archive-001', got '${result[0].archiveId}'`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC3: listArchivesWithFingerprints — skips archives without fingerprint ────

test('TC3: listArchivesWithFingerprints skips archives that lack dispersion-fingerprint.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc3-'));
  try {
    // Archive with fingerprint
    makeArchiveWithFingerprint(tmpDir, 'archive-with-fp', makeSampleFingerprint());
    // Archive without fingerprint
    const noFpDir = path.join(tmpDir, 'archives', 'archive-no-fp');
    fs.mkdirSync(noFpDir, { recursive: true });

    const result = listArchivesWithFingerprints(tmpDir);
    assert.ok(Array.isArray(result), 'Expected an array');
    assert.strictEqual(result.length, 1, `Expected length 1 (only archive with fingerprint), got ${result.length}`);
    assert.strictEqual(result[0].archiveId, 'archive-with-fp', 'Expected archiveId to be the one with fingerprint');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC4: readArchiveFingerprint — valid archive returns fingerprint data ──────

test('TC4: readArchiveFingerprint on valid archive returns object with fingerprint data (not {ok:false})', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc4-'));
  try {
    const fp = makeSampleFingerprint();
    makeArchiveWithFingerprint(tmpDir, 'archive-ok', fp);
    const result = readArchiveFingerprint(tmpDir, 'archive-ok');
    assert.ok(result.ok !== false, 'Expected result not to be {ok:false}');
    assert.ok(result.fingerprint, 'Expected result to contain fingerprint data');
    assert.strictEqual(result.fingerprint.fingerprintVersion, fp.fingerprintVersion, 'Expected fingerprint version to match');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC5: readArchiveFingerprint — non-existent archive ───────────────────────

test("TC5: readArchiveFingerprint on non-existent archive returns {ok: false, reason: 'no_archive'}", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc5-'));
  try {
    // Create archives dir but no archive inside
    fs.mkdirSync(path.join(tmpDir, 'archives'), { recursive: true });
    const result = readArchiveFingerprint(tmpDir, 'nonexistent-archive');
    assert.strictEqual(result.ok, false, 'Expected ok to be false');
    assert.strictEqual(result.reason, 'no_archive', `Expected reason 'no_archive', got '${result.reason}'`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC6: readArchiveFingerprint — archive dir exists but no fingerprint ───────

test("TC6: readArchiveFingerprint on archive without dispersion-fingerprint.json returns {ok: false, reason: 'no_fingerprint'}", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc6-'));
  try {
    // Create archive dir but no fingerprint file
    const archiveDir = path.join(tmpDir, 'archives', 'archive-no-fp');
    fs.mkdirSync(archiveDir, { recursive: true });
    const result = readArchiveFingerprint(tmpDir, 'archive-no-fp');
    assert.strictEqual(result.ok, false, 'Expected ok to be false');
    assert.strictEqual(result.reason, 'no_fingerprint', `Expected reason 'no_fingerprint', got '${result.reason}'`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC7: readArchiveFingerprint — malformed JSON ──────────────────────────────

test("TC7: readArchiveFingerprint on archive with invalid JSON returns {ok: false, reason: 'malformed'}", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc7-'));
  try {
    const archiveDir = path.join(tmpDir, 'archives', 'archive-bad-json');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, 'dispersion-fingerprint.json'),
      '{ invalid json <<<',
      'utf8'
    );
    const result = readArchiveFingerprint(tmpDir, 'archive-bad-json');
    assert.strictEqual(result.ok, false, 'Expected ok to be false');
    assert.strictEqual(result.reason, 'malformed', `Expected reason 'malformed', got '${result.reason}'`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC8: dispersion list mode with --json flag ────────────────────────────────

test('TC8: dispersion list mode with --json outputs JSON with archives array', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc8-'));
  try {
    makeArchiveWithFingerprint(tmpDir, 'archive-a', makeSampleFingerprint());
    makeArchiveWithFingerprint(tmpDir, 'archive-b', makeSampleFingerprint());

    const { stdout } = captureOutput(() => dispersion(tmpDir, { json: true }));

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      throw new Error(`Expected valid JSON output but got parse error: ${e.message}\nOutput: ${stdout}`);
    }

    assert.ok(parsed !== null && typeof parsed === 'object', 'Expected parsed output to be an object');
    assert.ok(Array.isArray(parsed.archives), `Expected parsed output to have an 'archives' array, got: ${JSON.stringify(parsed)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC9: dispersion show mode with --json flag ────────────────────────────────

test('TC9: dispersion show mode with --json outputs JSON with derived key', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc9-'));
  try {
    makeArchiveWithFingerprint(tmpDir, 'archive-show', makeSampleFingerprint());

    const { stdout } = captureOutput(() =>
      dispersion(tmpDir, { json: true, archiveId: 'archive-show' })
    );

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      throw new Error(`Expected valid JSON output but got parse error: ${e.message}\nOutput: ${stdout}`);
    }

    assert.ok(parsed !== null && typeof parsed === 'object', 'Expected parsed output to be an object');
    assert.ok('derived' in parsed, `Expected parsed output to have a 'derived' key, got keys: ${Object.keys(parsed).join(', ')}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC10: legacy array-form — list mode with {json:true} in flags ─────────────

test('TC10: dispersion(root, [], {json:true}, {}) list-mode outputs JSON with archives array', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc10-'));
  try {
    makeArchiveWithFingerprint(tmpDir, 'archive-legacy-list', makeSampleFingerprint());

    // Legacy call form: dispersion(projectRoot, positional, flags, legacyOpts)
    const { stdout } = captureOutput(() => dispersion(tmpDir, [], { json: true }, {}));

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      throw new Error(`Expected valid JSON output but got parse error: ${e.message}\nOutput: ${stdout}`);
    }

    assert.ok(parsed !== null && typeof parsed === 'object', 'Expected parsed output to be an object');
    assert.ok(
      Array.isArray(parsed.archives),
      `Expected parsed output to have an 'archives' array, got: ${JSON.stringify(parsed)}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC11: legacy array-form — show mode with {json:true} in flags ─────────────

test('TC11: dispersion(root, [archiveId], {json:true}, {}) show-mode outputs JSON with derived key', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc11-'));
  try {
    makeArchiveWithFingerprint(tmpDir, 'archive-legacy-show', makeSampleFingerprint());

    // Legacy call form: dispersion(projectRoot, [archiveId], flags, legacyOpts)
    const { stdout } = captureOutput(() =>
      dispersion(tmpDir, ['archive-legacy-show'], { json: true }, {})
    );

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      throw new Error(`Expected valid JSON output but got parse error: ${e.message}\nOutput: ${stdout}`);
    }

    assert.ok(parsed !== null && typeof parsed === 'object', 'Expected parsed output to be an object');
    assert.ok(
      'derived' in parsed,
      `Expected parsed output to have a 'derived' key, got keys: ${Object.keys(parsed).join(', ')}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC12: compareFingerprints returns structured diff with specHashMatch, diffs for identical fingerprints ──

test('TC12: compareFingerprints returns structured diff with specHashMatch, diffs for identical fingerprints', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc12-'));
  try {
    const fp = makeSampleFingerprint();
    makeArchiveWithFingerprint(tmpDir, 'archive-tc12-a', fp);
    makeArchiveWithFingerprint(tmpDir, 'archive-tc12-b', fp);

    const result = compareFingerprints(tmpDir, 'archive-tc12-a', 'archive-tc12-b');

    assert.ok(result !== null, 'Expected compareFingerprints to return a non-null result');
    assert.strictEqual(result.specHashMatch, true, `Expected specHashMatch===true for identical fingerprints, got ${result.specHashMatch}`);
    assert.ok(result.diffs, 'Expected result to have a diffs property');

    const numericDiffKeys = ['milestoneCount', 'missionCount', 'taskCount', 'verifierPass', 'verifierFail', 'reviewerFindingCount'];
    for (const key of numericDiffKeys) {
      assert.ok(key in result.diffs, `Expected diffs to have key '${key}'`);
      assert.strictEqual(result.diffs[key].delta, 0, `Expected diffs.${key}.delta===0 for identical fingerprints, got ${result.diffs[key].delta}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC13: compareFingerprints with differing specHash returns specHashMatch===false ──

test('TC13: compareFingerprints with differing specHash returns specHashMatch===false', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc13-'));
  try {
    const fpA = makeSampleFingerprint();
    const fpB = makeSampleFingerprint();
    fpA.specHash = 'aaaa1111aaaa1111';
    fpB.specHash = 'bbbb2222bbbb2222';

    makeArchiveWithFingerprint(tmpDir, 'archive-tc13-a', fpA);
    makeArchiveWithFingerprint(tmpDir, 'archive-tc13-b', fpB);

    const result = compareFingerprints(tmpDir, 'archive-tc13-a', 'archive-tc13-b');

    assert.ok(result !== null, 'Expected compareFingerprints to return a non-null result');
    assert.strictEqual(result.specHashMatch, false, `Expected specHashMatch===false for differing specHash values, got ${result.specHashMatch}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC14: compareFingerprints structured diff reports correct field deltas ────

test('TC14: compareFingerprints structured diff reports correct field deltas', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc14-'));
  try {
    const fpA = makeSampleFingerprint();
    // fpA has planStructure: milestoneCount:1, missionCount:1, taskCount:2
    // fpA has verifierVerdicts: 1 PASSED

    const fpB = makeSampleFingerprint();
    fpB.planStructure = {
      ...fpB.planStructure,
      milestoneCount: 2,
      missionCount: 3,
      taskCount: 5,
    };
    fpB.verifierVerdicts = [
      { taskId: '001-001-001', result: 'PASSED', backReferenceDeviationCount: 0 },
      { taskId: '001-001-002', result: 'PASSED', backReferenceDeviationCount: 0 },
      { taskId: '001-001-003', result: 'FAILED', backReferenceDeviationCount: 1 },
    ];

    makeArchiveWithFingerprint(tmpDir, 'archive-tc14-a', fpA);
    makeArchiveWithFingerprint(tmpDir, 'archive-tc14-b', fpB);

    const result = compareFingerprints(tmpDir, 'archive-tc14-a', 'archive-tc14-b');

    assert.ok(result !== null, 'Expected compareFingerprints to return a non-null result');
    assert.ok(result.diffs, 'Expected result to have a diffs property');

    // milestoneCount: a=1, b=2 → delta=+1
    assert.strictEqual(result.diffs.milestoneCount.delta, 1, `Expected milestoneCount delta===1, got ${result.diffs.milestoneCount.delta}`);
    // missionCount: a=1, b=3 → delta=+2
    assert.strictEqual(result.diffs.missionCount.delta, 2, `Expected missionCount delta===2, got ${result.diffs.missionCount.delta}`);
    // taskCount: a=2, b=5 → delta=+3
    assert.strictEqual(result.diffs.taskCount.delta, 3, `Expected taskCount delta===3, got ${result.diffs.taskCount.delta}`);
    // verifierPass: a=1, b=2 → delta=+1
    assert.strictEqual(result.diffs.verifierPass.delta, 1, `Expected verifierPass delta===1, got ${result.diffs.verifierPass.delta}`);
    // verifierFail: a=0, b=1 → delta=+1
    assert.strictEqual(result.diffs.verifierFail.delta, 1, `Expected verifierFail delta===1, got ${result.diffs.verifierFail.delta}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC15: summarizeFingerprintLine counts PASSED/FAILED correctly ─────────────

test("TC15: summarizeFingerprintLine counts PASSED/FAILED correctly", () => {
  const fp = makeSampleFingerprint();
  fp.verifierVerdicts = [
    { taskId: '001-001-001', result: 'PASSED', backReferenceDeviationCount: 0 },
    { taskId: '001-001-002', result: 'PASSED', backReferenceDeviationCount: 0 },
    { taskId: '001-001-003', result: 'FAILED', backReferenceDeviationCount: 1 },
  ];

  const line = summarizeFingerprintLine('archive-tc15', fp);

  assert.ok(typeof line === 'string', 'Expected summarizeFingerprintLine to return a string');
  assert.ok(
    line.includes('pass:2'),
    `Expected output to contain 'pass:2', got: ${line}`
  );
  assert.ok(
    line.includes('fail:1'),
    `Expected output to contain 'fail:1', got: ${line}`
  );
});

// ── TC16: compareFingerprints with both specHash null returns specHashMatch===null ──

test('TC16: compareFingerprints with both specHash null returns specHashMatch===null and diffs.specHash.match===null', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc16-'));
  try {
    const fpA = makeSampleFingerprint();
    const fpB = makeSampleFingerprint();
    delete fpA.specHash;
    delete fpB.specHash;

    makeArchiveWithFingerprint(tmpDir, 'archive-tc16-a', fpA);
    makeArchiveWithFingerprint(tmpDir, 'archive-tc16-b', fpB);

    const result = compareFingerprints(tmpDir, 'archive-tc16-a', 'archive-tc16-b');

    assert.ok(result !== null, 'Expected compareFingerprints to return a non-null result');
    assert.strictEqual(result.specHashMatch, null, `Expected specHashMatch===null when both specHash are null, got ${result.specHashMatch}`);
    assert.ok(result.diffs && result.diffs.specHash, 'Expected result.diffs.specHash to exist');
    assert.strictEqual(result.diffs.specHash.match, null, `Expected diffs.specHash.match===null when both specHash are null, got ${result.diffs.specHash.match}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC17: compareFingerprints with one null specHash returns specHashMatch===null ──

test('TC17: compareFingerprints with one null specHash and one non-null returns specHashMatch===null', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc17-'));
  try {
    const fpA = makeSampleFingerprint();
    const fpB = makeSampleFingerprint();
    delete fpA.specHash;
    fpB.specHash = 'abc123';

    makeArchiveWithFingerprint(tmpDir, 'archive-tc17-a', fpA);
    makeArchiveWithFingerprint(tmpDir, 'archive-tc17-b', fpB);

    const result = compareFingerprints(tmpDir, 'archive-tc17-a', 'archive-tc17-b');

    assert.ok(result !== null, 'Expected compareFingerprints to return a non-null result');
    assert.strictEqual(result.specHashMatch, null, `Expected specHashMatch===null when one specHash is null, got ${result.specHashMatch}`);
    assert.ok(result.diffs && result.diffs.specHash, 'Expected result.diffs.specHash to exist');
    assert.strictEqual(result.diffs.specHash.match, null, `Expected diffs.specHash.match===null when one specHash is null, got ${result.diffs.specHash.match}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC18: compareFingerprints with both non-null equal specHash returns specHashMatch===true ──

test('TC18: compareFingerprints with both non-null equal specHash returns specHashMatch===true', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc18-'));
  try {
    const fpA = makeSampleFingerprint();
    const fpB = makeSampleFingerprint();
    fpA.specHash = 'samehash';
    fpB.specHash = 'samehash';

    makeArchiveWithFingerprint(tmpDir, 'archive-tc18-a', fpA);
    makeArchiveWithFingerprint(tmpDir, 'archive-tc18-b', fpB);

    const result = compareFingerprints(tmpDir, 'archive-tc18-a', 'archive-tc18-b');

    assert.ok(result !== null, 'Expected compareFingerprints to return a non-null result');
    assert.strictEqual(result.specHashMatch, true, `Expected specHashMatch===true for equal non-null specHash values, got ${result.specHashMatch}`);
    assert.ok(result.diffs && result.diffs.specHash, 'Expected result.diffs.specHash to exist');
    assert.strictEqual(result.diffs.specHash.match, true, `Expected diffs.specHash.match===true for equal non-null specHash values, got ${result.diffs.specHash.match}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── TC19: compareFingerprints with both non-null different specHash returns specHashMatch===false ──

test('TC19: compareFingerprints with both non-null different specHash returns specHashMatch===false', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispersion-cli-tc19-'));
  try {
    const fpA = makeSampleFingerprint();
    const fpB = makeSampleFingerprint();
    fpA.specHash = 'aaa';
    fpB.specHash = 'bbb';

    makeArchiveWithFingerprint(tmpDir, 'archive-tc19-a', fpA);
    makeArchiveWithFingerprint(tmpDir, 'archive-tc19-b', fpB);

    const result = compareFingerprints(tmpDir, 'archive-tc19-a', 'archive-tc19-b');

    assert.ok(result !== null, 'Expected compareFingerprints to return a non-null result');
    assert.strictEqual(result.specHashMatch, false, `Expected specHashMatch===false for different non-null specHash values, got ${result.specHashMatch}`);
    assert.ok(result.diffs && result.diffs.specHash, 'Expected result.diffs.specHash to exist');
    assert.strictEqual(result.diffs.specHash.match, false, `Expected diffs.specHash.match===false for different non-null specHash values, got ${result.diffs.specHash.match}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
