/**
 * test-archive.js — Integration tests for archive() in archive.js.
 *
 * Uses mocked summarizer and git dependencies to test the full archive flow
 * without Claude auth or an actual git repo.
 * Run: node test/test-archive.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { execSync as testExecSync } from 'child_process';
import { archive, computeSeq, computeSlug, validateArchivable, getRecentCommits, validateChangelogSources, getDiffSummary, moveHarnessToArchive, copySpecToArchive, buildManifest, detectHaltInfo } from '../src/cli/commands/archive.js';

// ── Test harness ─────────────────────────────────────────────────────────────

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

// ── Temp project helpers ──────────────────────────────────────────────────────

const tmpDirs = [];

/**
 * Create a temporary project directory with a .harness/state.json
 * populated with sample milestones, a spec file, and a set of harness
 * artifacts (logs/, snapshots/, state/) so the move step has something to move.
 *
 * @returns {string} Absolute path to the project root temp dir
 */
function makeTmpProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-integration-'));
  tmpDirs.push(tmpDir);

  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  // Create the spec file referenced by state.json
  const specRelPath = 'spec.md';
  fs.writeFileSync(
    path.join(tmpDir, specRelPath),
    '# Test Spec\n\nSample spec content for integration test.',
    'utf8'
  );

  // Populate state.json with sample milestones (all complete so no prompt needed)
  const state = {
    name: 'Test Project',
    spec: specRelPath,
    startedAt: '2026-01-01T00:00:00.000Z',
    milestones: [
      { id: '001', description: 'First milestone', status: 'complete' },
      { id: '002', description: 'Second milestone', status: 'complete' },
    ],
    projectMeta: {
      currentPhase: 'complete',
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(state, null, 2),
    'utf8'
  );

  // Create harness artifacts so moveHarnessToArchive has real entries to move
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'logs', 'test.log'), 'sample log output', 'utf8');

  fs.mkdirSync(path.join(harnessDir, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'snapshots', 'snap.json'), '{}', 'utf8');

  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'state', 'mission-001-001.json'), '{}', 'utf8');

  return tmpDir;
}

/**
 * Remove all temp directories created by makeTmpProject.
 */
function cleanup() {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tmpDirs.length = 0;
}

// ── Mock dependencies ─────────────────────────────────────────────────────────

const mockSummarize = async () => ({
  headline: 'All milestones complete',
  bugs: [],
  summary: 'Test run completed successfully.',
});

const mockGetGitInfo = () => ({
  gitHead: 'abc1234567890abcdef',
  gitStatus: 'clean',
});

// ── Integration tests ─────────────────────────────────────────────────────────

// TC1: archive creates archives/{seq}-{slug}/ directory
await test('TC1: archive creates archives/{seq}-{slug}/ directory', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'test-project', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDir, 'archive() should return the archive directory path');
  assert.ok(fs.existsSync(archiveDir), `Archive directory should exist at: ${archiveDir}`);

  // Must be under archives/
  const expectedArchivesDir = path.join(projectRoot, 'archives');
  assert.ok(
    archiveDir.startsWith(expectedArchivesDir),
    `Archive dir should be under archives/, got: ${archiveDir}`
  );

  // Dir name must match {3-digit-seq}-{slug} pattern
  const dirName = path.basename(archiveDir);
  assert.ok(
    /^\d{3}-.+$/.test(dirName),
    `Archive dir name should match {seq}-{slug} pattern, got: ${dirName}`
  );
});

// TC2: archive dir contains manifest.json
await test('TC2: archive dir contains manifest.json', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'my-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  const manifestPath = path.join(archiveDir, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json should exist in archive dir');

  // Verify it's valid JSON with expected fields
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(manifest.id, 'manifest.json should have an id field');
  assert.ok(typeof manifest.archivedAt === 'string', 'manifest.json should have archivedAt');
});

// TC3: archive dir does NOT contain .gitignore (writeGitignore is no longer called)
await test('TC3: archive dir does NOT contain .gitignore', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'my-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  const gitignorePath = path.join(archiveDir, '.gitignore');
  assert.ok(!fs.existsSync(gitignorePath), '.gitignore should NOT exist in archive dir (writeGitignore no longer called)');
});

// TC4: moved artifacts (state.json, state/, logs/, snapshots/) exist inside archive dir
await test('TC4: moved artifacts (state.json, state/, logs/, snapshots/) exist inside archive dir', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'my-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(
    fs.existsSync(path.join(archiveDir, 'state.json')),
    'state.json should be moved into archive dir'
  );
  assert.ok(
    fs.existsSync(path.join(archiveDir, 'state')),
    'state/ directory should be moved into archive dir'
  );
  assert.ok(
    fs.existsSync(path.join(archiveDir, 'logs')),
    'logs/ directory should be moved into archive dir'
  );
  assert.ok(
    fs.existsSync(path.join(archiveDir, 'snapshots')),
    'snapshots/ directory should be moved into archive dir'
  );
});

// TC5: manifest.json has all 17 required fields
await test('TC5: manifest.json has all 17 required fields', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'my-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  const manifestPath = path.join(archiveDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const requiredFields = [
    'id', 'name', 'seq', 'spec', 'specSnapshot', 'startedAt',
    'archivedAt', 'gitHead', 'gitStatus', 'models', 'milestones',
    'totalCost', 'totalSessions', 'headline', 'bugs', 'summary',
  ];

  for (const field of requiredFields) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(manifest, field),
      `manifest.json should have field: ${field}`
    );
  }
});

// TC6: manifest.id matches '{seq}-{slug}' format
await test('TC6: manifest.id matches \'{seq}-{slug}\' format', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'my-project', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  const manifestPath = path.join(archiveDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // id should be like '001-my-project'
  assert.ok(typeof manifest.id === 'string', 'manifest.id should be a string');
  const idPattern = /^\d{3}-.+$/;
  assert.ok(
    idPattern.test(manifest.id),
    `manifest.id should match {seq}-{slug} pattern, got: ${manifest.id}`
  );

  // seq part of the id should match manifest.seq
  const [seqPart, ...slugParts] = manifest.id.split('-');
  assert.strictEqual(seqPart, manifest.seq, 'seq prefix in id should match manifest.seq');
  assert.ok(slugParts.length > 0, 'slug part should be non-empty');
});

// TC7: manifest.specSnapshot contains spec file content
await test('TC7: manifest.specSnapshot contains spec file content', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'my-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  const manifestPath = path.join(archiveDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // The spec file was written with this content in makeTmpProject()
  const expectedSpecContent = '# Test Spec\n\nSample spec content for integration test.';

  assert.strictEqual(
    manifest.specSnapshot,
    expectedSpecContent,
    'manifest.specSnapshot should contain the actual spec file content'
  );
});

// TC8: manifest.milestones matches state milestones
await test('TC8: manifest.milestones matches state milestones', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'my-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  const manifestPath = path.join(archiveDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // The milestones defined in makeTmpProject()
  const expectedMilestones = [
    { id: '001', description: 'First milestone', status: 'complete' },
    { id: '002', description: 'Second milestone', status: 'complete' },
  ];

  assert.ok(Array.isArray(manifest.milestones), 'manifest.milestones should be an array');
  assert.strictEqual(
    manifest.milestones.length,
    expectedMilestones.length,
    `manifest.milestones should have ${expectedMilestones.length} entries`
  );

  for (let i = 0; i < expectedMilestones.length; i++) {
    assert.strictEqual(
      manifest.milestones[i].id,
      expectedMilestones[i].id,
      `milestones[${i}].id should match`
    );
    assert.strictEqual(
      manifest.milestones[i].description,
      expectedMilestones[i].description,
      `milestones[${i}].description should match`
    );
    assert.strictEqual(
      manifest.milestones[i].status,
      expectedMilestones[i].status,
      `milestones[${i}].status should match`
    );
  }
});

// TC9: manifest.headline/bugs/summary come from mock summarizer
await test('TC9: manifest.headline/bugs/summary come from mock summarizer', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'my-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  const manifestPath = path.join(archiveDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // mockSummarize returns: { headline: 'All milestones complete', bugs: [], summary: 'Test run completed successfully.' }
  assert.strictEqual(
    manifest.headline,
    'All milestones complete',
    'manifest.headline should match mock summarizer output'
  );
  assert.deepStrictEqual(
    manifest.bugs,
    [],
    'manifest.bugs should match mock summarizer output'
  );
  assert.strictEqual(
    manifest.summary,
    'Test run completed successfully.',
    'manifest.summary should match mock summarizer output'
  );
});

// TC10: manifest.archivedAt is valid ISO timestamp
await test('TC10: manifest.archivedAt is valid ISO timestamp', async () => {
  const projectRoot = makeTmpProject();

  const before = new Date().toISOString();
  const archiveDir = await archive(projectRoot, 'my-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });
  const after = new Date().toISOString();

  const manifestPath = path.join(archiveDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.ok(typeof manifest.archivedAt === 'string', 'manifest.archivedAt should be a string');

  const parsed = new Date(manifest.archivedAt);
  assert.ok(!isNaN(parsed.getTime()), `manifest.archivedAt should be a valid date, got: ${manifest.archivedAt}`);

  // archivedAt must be a full ISO 8601 string (contains 'T' and 'Z' or offset)
  assert.ok(
    manifest.archivedAt.includes('T'),
    `manifest.archivedAt should be ISO 8601 format, got: ${manifest.archivedAt}`
  );

  // archivedAt should be between before and after (within a reasonable test window)
  assert.ok(
    manifest.archivedAt >= before && manifest.archivedAt <= after,
    `manifest.archivedAt (${manifest.archivedAt}) should be between ${before} and ${after}`
  );
});

// TC11: first archive gets seq '001'
await test('TC11: first archive gets seq \'001\'', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'seq-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDir, 'archive() should return the archive directory path');
  const dirName = path.basename(archiveDir);
  assert.ok(
    dirName.startsWith('001-'),
    `First archive dir name should start with '001-', got: ${dirName}`
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.seq, '001', `manifest.seq should be '001', got: ${manifest.seq}`);
});

// TC12: second archive after re-bootstrap gets seq '002'
await test('TC12: second archive after re-bootstrap gets seq \'002\'', async () => {
  const projectRoot = makeTmpProject();

  // First archive — consumes seq '001', then bootstrap() re-initializes .harness
  await archive(projectRoot, 'seq-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  // After archive(), reinit only creates directories (no state.json).
  // Simulate the next cc-orch run calling bootstrap by writing state.json manually.
  const harnessDir2 = path.join(projectRoot, '.harness');
  const stateJson2 = path.join(harnessDir2, 'state.json');
  const freshState = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'planning' },
    globalStatus: 'active',
    milestones: [],
  };
  fs.writeFileSync(stateJson2, JSON.stringify(freshState, null, 2), 'utf8');

  // Archive again — archives dir now has one entry, so seq should be '002'
  const archiveDir2 = await archive(projectRoot, 'seq-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDir2, 'second archive() should return the archive directory path');
  const dirName = path.basename(archiveDir2);
  assert.ok(
    dirName.startsWith('002-'),
    `Second archive dir name should start with '002-', got: ${dirName}`
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(archiveDir2, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.seq, '002', `manifest.seq should be '002', got: ${manifest.seq}`);
});

// TC13: seq skips gaps (if 001 and 003 exist, next is 004)
await test('TC13: seq skips gaps (if 001 and 003 exist, next is 004)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-seq-gaps-'));
  tmpDirs.push(tmpDir);

  // Create '001-alpha' and '003-gamma' — gap at 002
  fs.mkdirSync(path.join(tmpDir, '001-alpha'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '003-gamma'), { recursive: true });

  const seq = computeSeq(tmpDir);
  assert.strictEqual(seq, '004', `computeSeq should return '004' when max is 003, got: ${seq}`);
});

// ── Slug normalisation tests (TC14–TC18) ──────────────────────────────────────

// Slug normalization tests use the explicit-name precedence-1 path:
//   computeSlug(name, milestoneDescription, specPath, seq)
await test("TC14: 'My Cool Project' → 'my-cool-project'", () => {
  const slug = computeSlug('My Cool Project', null, 'spec.md', '001');
  assert.strictEqual(slug, 'my-cool-project',
    `Expected 'my-cool-project', got: '${slug}'`);
});

// TC15: leading/trailing whitespace and special characters are stripped
await test("TC15: '  !!Special@@Chars  ' → 'special-chars'", () => {
  const slug = computeSlug('  !!Special@@Chars  ', null, 'spec.md', '001');
  assert.strictEqual(slug, 'special-chars',
    `Expected 'special-chars', got: '${slug}'`);
});

// TC16: names longer than 40 chars are truncated to exactly 40 chars
await test('TC16: very long name is truncated to 40 chars', () => {
  const longName = 'abcdefghijklmnopqrstuvwxyz-0123456789-extra-chars';
  const slug = computeSlug(longName, null, 'spec.md', '001');
  assert.ok(
    slug.length <= 40,
    `Slug length should be ≤ 40, got ${slug.length}: '${slug}'`
  );
  assert.strictEqual(slug.length, 40,
    `Slug should be exactly 40 chars when name is long enough, got ${slug.length}: '${slug}'`);
});

// TC17: null or empty milestoneDescription (and no name) falls back to the spec filename
await test('TC17: null/empty milestoneDescription falls back to spec filename slug', () => {
  const slugNull = computeSlug(null, null, 'my-spec-file.md', '001');
  assert.strictEqual(slugNull, 'my-spec-file',
    `null milestoneDescription: expected 'my-spec-file', got: '${slugNull}'`);

  const slugEmpty = computeSlug(null, '', 'my-spec-file.md', '001');
  assert.strictEqual(slugEmpty, 'my-spec-file',
    `empty milestoneDescription: expected 'my-spec-file', got: '${slugEmpty}'`);

  const slugWhitespace = computeSlug(null, '   ', 'my-spec-file.md', '001');
  assert.strictEqual(slugWhitespace, 'my-spec-file',
    `whitespace-only milestoneDescription: expected 'my-spec-file', got: '${slugWhitespace}'`);
});

// TC18: explicit name passed to archive() drives the slug (precedence-1)
await test('TC18: explicit name arg is honored as the slug source', () => {
  const expectedSlug = computeSlug('queue-slug-carrier', 'First milestone', 'spec.md', '001');
  assert.strictEqual(expectedSlug, 'queue-slug-carrier',
    `Pre-check: expected slug 'queue-slug-carrier', got '${expectedSlug}'`);

  return (async () => {
    const projectRoot = makeTmpProject();

    const archiveDir = await archive(projectRoot, 'queue-slug-carrier', { auto: true }, {
      summarize: mockSummarize,
      getGitInfo: mockGetGitInfo,
    });

    const dirName = path.basename(archiveDir);
    assert.ok(
      dirName.endsWith(`-${expectedSlug}`),
      `Archive dir name should end with '-${expectedSlug}', got: '${dirName}'`
    );

    const manifest = JSON.parse(fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8'));
    assert.ok(
      manifest.id.endsWith(`-${expectedSlug}`),
      `manifest.id should end with '-${expectedSlug}', got: '${manifest.id}'`
    );
  })();
});

// ── New slug / seq / collision tests (TC-new-1 – TC-new-5) ───────────────────

// TC-new-1: computeSlug with milestone description produces ~5 word slug
await test('TC-new-1: computeSlug with milestone description produces ~5 word slug', () => {
  const slug = computeSlug(
    null,
    'Implement user authentication with JWT tokens and refresh logic',
    'spec.md',
    '001'
  );
  // First 5 words slugified: "implement-user-authentication-with-jwt"
  assert.strictEqual(slug, 'implement-user-authentication-with-jwt',
    `Expected 5-word milestone slug, got: '${slug}'`);
});

// TC-new-2: computeSlug with null milestone + spec path produces spec filename slug
await test('TC-new-2: computeSlug with null milestone + spec path produces spec filename slug', () => {
  const slug = computeSlug(null, null, 'my-project-spec.md', '001');
  assert.strictEqual(slug, 'my-project-spec',
    `Expected spec filename slug 'my-project-spec', got: '${slug}'`);
});

// TC-new-3: computeSlug with all empty + seq '005' produces 'dogfood-005'
await test("TC-new-3: computeSlug with all empty + seq '005' produces 'dogfood-005'", () => {
  const slug = computeSlug(null, null, '', '005');
  assert.strictEqual(slug, 'dogfood-005',
    `Expected 'dogfood-005' when both milestoneDescription and specPath are empty, got: '${slug}'`);
});

// TC-name-precedence: name beats milestone description (regression for queue→archive traceability)
await test('TC-name-precedence: explicit name takes precedence over milestone description', () => {
  const slug = computeSlug('queue-foo', 'Implement foo bar baz', 'spec.md', '001');
  assert.strictEqual(slug, 'queue-foo',
    `Expected 'queue-foo' (name precedence), got: '${slug}'`);
});

// TC-new-4: archive() throws when target dir already exists (collision guard)
await test('TC-new-4: archive() throws when target dir already exists (collision guard)', async () => {
  const projectRoot = makeTmpProject();
  const archivesDir = path.join(projectRoot, 'archives');

  // Strategy: inject deps.summarize to pre-create the archive dir as a side-effect
  // AFTER archive() has already called computeSeq (seq locked in its closure) but
  // BEFORE the collision check at step 10. This accurately simulates a real race/collision.
  //
  // archives/ is empty when archive() starts → computeSeq returns '001'.
  // Inside mock summarize, we independently compute seq='001', slug='first-milestone',
  // and pre-create 'archives/001-first-milestone'. When archive() then checks for
  // existence of that path, it finds it and throws.
  const collidingSummarize = async (_dataPackage) => {
    const collidingSeq = computeSeq(archivesDir); // archives still empty at this point → '001'
    // Mirror archive()'s slug computation: name precedence-1 then milestone description.
    const collidingSlug = computeSlug('collision-test', 'First milestone', 'spec.md', collidingSeq);
    const collidingDir = path.join(archivesDir, `${collidingSeq}-${collidingSlug}`);
    fs.mkdirSync(collidingDir, { recursive: true });
    return { headline: 'collision test', bugs: [], summary: 'collision summary' };
  };

  let threw = false;
  let errMsg = '';
  try {
    await archive(projectRoot, 'collision-test', { auto: true }, {
      summarize: collidingSummarize,
      getGitInfo: mockGetGitInfo,
    });
  } catch (err) {
    threw = true;
    errMsg = err.message;
  }

  assert.ok(threw, 'archive() should throw when the target archive directory already exists');
  assert.ok(
    errMsg.includes('already exists'),
    `Error message should contain 'already exists', got: '${errMsg}'`
  );
});

// TC-new-5: computeSeq is monotonic — gaps (001, 003) → returns 004 not 002
await test("TC-new-5: computeSeq is monotonic — gaps (001, 003) → returns 004 not 002", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-seq-monotonic-'));
  tmpDirs.push(tmpDir);

  fs.mkdirSync(path.join(tmpDir, '001-alpha'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '003-gamma'), { recursive: true });

  const seq = computeSeq(tmpDir);

  // Must return '004' (max+1), NOT '002' (gap-filling would be wrong)
  assert.strictEqual(seq, '004',
    `computeSeq should return '004' (max+1), not gap-fill. Got: '${seq}'`);
  assert.notStrictEqual(seq, '002',
    'computeSeq MUST NOT fill gaps — it must be monotonically max+1');
});

// TC19: archive dir does NOT contain .gitignore (writeGitignore is no longer called)
await test('TC19: archive dir does NOT contain .gitignore (no writeGitignore call)', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'gitignore-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  const gitignorePath = path.join(archiveDir, '.gitignore');
  assert.ok(
    !fs.existsSync(gitignorePath),
    '.gitignore should NOT exist in archive dir (writeGitignore is no longer called)'
  );
});

// TC20: after archive, .harness/ subdirs exist but .harness/state.json does NOT exist (reinit no longer writes state.json)
await test('TC20: after archive, .harness/state/ exists but .harness/state.json does NOT exist', async () => {
  const projectRoot = makeTmpProject();

  await archive(projectRoot, 'fresh-state-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  const harnessDir = path.join(projectRoot, '.harness');

  // state.json should NOT exist — reinit no longer writes state.json
  const stateJsonPath = path.join(harnessDir, 'state.json');
  assert.ok(
    !fs.existsSync(stateJsonPath),
    '.harness/state.json should NOT exist after archive (reinit no longer writes state.json)'
  );

  // .harness/ itself should still exist (was not removed)
  assert.ok(
    fs.existsSync(harnessDir),
    '.harness/ directory should still exist after archive'
  );

  // Post-flip reinit contract: only the SHARED skeleton is recreated at the
  // root; per-run subdirs (state/, plan/, ...) live inside the next run's
  // .harness/run-{id}/ and must NOT reappear at the root.
  for (const shared of ['learning', 'dry-run', 'brainstorm']) {
    assert.ok(
      fs.existsSync(path.join(harnessDir, shared)),
      `.harness/${shared}/ (shared) should exist after archive reinit`
    );
  }
  const stateDirPath = path.join(harnessDir, 'state');
  assert.ok(
    !fs.existsSync(stateDirPath),
    '.harness/state/ (per-run) should NOT be recreated at the root by the post-archive reinit'
  );
});

// TC21: old state.json is present inside the archive directory
await test('TC21: old state.json is present inside the archive directory', async () => {
  const projectRoot = makeTmpProject();

  // Record the content of the original state.json before archiving
  const originalStatePath = path.join(projectRoot, '.harness', 'state.json');
  const originalStateContent = fs.readFileSync(originalStatePath, 'utf8');
  const originalState = JSON.parse(originalStateContent);

  const archiveDir = await archive(projectRoot, 'old-state-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  // Old state.json must have been moved into the archive directory
  const archivedStatePath = path.join(archiveDir, 'state.json');
  assert.ok(
    fs.existsSync(archivedStatePath),
    `old state.json should be present inside archive directory at: ${archivedStatePath}`
  );

  // Verify it's the original state (not the fresh bootstrap one)
  const archivedState = JSON.parse(fs.readFileSync(archivedStatePath, 'utf8'));
  assert.deepStrictEqual(
    archivedState.milestones,
    originalState.milestones,
    'archived state.json milestones should match the original state milestones'
  );
});

// ── Incomplete-run helpers ────────────────────────────────────────────────────

/**
 * Create a temporary project with milestones that are 'in-progress'
 * (i.e. not all are terminal). This is used to test the confirmation-prompt
 * behaviour when trying to archive an unfinished run.
 *
 * @returns {string} Absolute path to the project root temp dir
 */
function makeTmpProjectIncomplete() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-incomplete-'));
  tmpDirs.push(tmpDir);

  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  const specRelPath = 'spec.md';
  fs.writeFileSync(
    path.join(tmpDir, specRelPath),
    '# Test Spec\n\nIncomplete run spec.',
    'utf8'
  );

  // One milestone is 'complete', one is 'in-progress' → not archivable without prompt
  const state = {
    name: 'Incomplete Project',
    spec: specRelPath,
    startedAt: '2026-01-01T00:00:00.000Z',
    milestones: [
      { id: '001', description: 'Done milestone', status: 'complete' },
      { id: '002', description: 'Work in progress', status: 'in-progress' },
    ],
    projectMeta: {
      currentPhase: 'active',
    },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(state, null, 2),
    'utf8'
  );

  // Minimal artifacts so archive can proceed
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'logs', 'test.log'), 'log data', 'utf8');

  return tmpDir;
}

// ── TC22: validateArchivable returns ok:false for in-progress milestones ──────

await test('TC22: validateArchivable returns ok:false when milestones are in-progress', () => {
  const projectRoot = makeTmpProjectIncomplete();
  const harnessDir = path.join(projectRoot, '.harness');

  const result = validateArchivable(harnessDir, /* autoMode= */ false);

  assert.strictEqual(result.ok, false, 'validateArchivable should return ok:false for in-progress milestones');
  assert.ok(
    typeof result.message === 'string' && result.message.length > 0,
    'validateArchivable should include a non-empty prompt message when ok:false'
  );
});

// ── TC23: archive with promptYesNo→false aborts, no archive dir created ───────

await test('TC23: archive with promptYesNo→false aborts, no archive dir created', async () => {
  const projectRoot = makeTmpProjectIncomplete();

  let promptCalled = false;
  const abortingPrompt = async (_msg) => {
    promptCalled = true;
    return false; // user says No
  };

  const result = await archive(projectRoot, 'incomplete-abort', {}, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
    promptYesNo: abortingPrompt,
  });

  assert.ok(promptCalled, 'promptYesNo should have been called when milestones are incomplete');
  assert.strictEqual(result, undefined, 'archive() should return undefined when aborted');

  const archivesDir = path.join(projectRoot, 'archives');
  const archiveDirExists =
    fs.existsSync(archivesDir) &&
    fs.readdirSync(archivesDir).length > 0;

  assert.ok(
    !archiveDirExists,
    'No archive directory should be created when the user declines the prompt'
  );
});

// ── TC24: archive with promptYesNo→true proceeds, archive dir created ─────────

await test('TC24: archive with promptYesNo→true proceeds, archive dir created', async () => {
  const projectRoot = makeTmpProjectIncomplete();

  const proceedingPrompt = async (_msg) => true; // user says Yes

  const archiveDir = await archive(projectRoot, 'incomplete-proceed', {}, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
    promptYesNo: proceedingPrompt,
  });

  assert.ok(archiveDir, 'archive() should return the archive directory path when user confirms');
  assert.ok(
    fs.existsSync(archiveDir),
    `Archive directory should exist when user confirms: ${archiveDir}`
  );
});

// ── TC25: archive with --auto flag skips prompt entirely ──────────────────────

await test('TC25: archive with --auto flag skips prompt, archives despite incomplete milestones', async () => {
  const projectRoot = makeTmpProjectIncomplete();

  let promptCalled = false;
  const sentinelPrompt = async (_msg) => {
    promptCalled = true;
    return false;
  };

  // Passing { auto: true } — the prompt should never be called
  const archiveDir = await archive(projectRoot, 'incomplete-auto', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
    promptYesNo: sentinelPrompt,
  });

  assert.ok(!promptCalled, 'promptYesNo should NOT be called when --auto flag is set');
  assert.ok(archiveDir, 'archive() should return the archive directory path in auto mode');
  assert.ok(
    fs.existsSync(archiveDir),
    `Archive directory should exist in auto mode: ${archiveDir}`
  );
});

// ── TC25b: Category A / Category B audit for archive prompts ─────────────────
//
// Under the auto-mode prompt-category contract:
//   Category A — safe to auto-approve; auto mode skips the prompt and proceeds.
//   Category B — destructive/irreversible; auto mode must throw exit-77 (not silently proceed).
//
// archive.js has exactly ONE prompt site:
//   validateArchivable() → calls _promptYesNo() when milestones are not all
//   complete/invalidated.  In auto mode (flags.auto === true), validateArchivable
//   returns { ok: true } immediately — the prompt is bypassed, archiving continues.
//   This is Category A behaviour (safe to auto-approve — archive is non-destructive:
//   it moves artefacts and writes a manifest, all reversible by moving files back).
//
// Conclusion: archive has NO Category B gates. TC25 is clean; there is no exit-77
// risk for the archive command under auto mode.  No TC25b assertion is needed.

// ── TC26a: empty directories in .harness/ are not moved to archive dir ────────

await test('TC26a: empty directory in .harness/ (e.g. analysis/) is not moved to archive dir', async () => {
  const projectRoot = makeTmpProject();

  // Add an empty 'analysis/' directory inside .harness/
  const emptyAnalysisDir = path.join(projectRoot, '.harness', 'analysis');
  fs.mkdirSync(emptyAnalysisDir, { recursive: true });

  const archiveDir = await archive(projectRoot, 'empty-dir-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  // The empty analysis/ dir should NOT be present in the archive directory
  const archivedAnalysisDir = path.join(archiveDir, 'analysis');
  assert.ok(
    !fs.existsSync(archivedAnalysisDir),
    'empty analysis/ directory should NOT be moved into archive dir'
  );
});

// ── Gate helpers (TC26–TC28) ──────────────────────────────────────────────────

// Import Pipeline so we can test _checkOverwriteProtection directly
const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');

/**
 * Create a minimal temp harness directory for gate tests.
 * Pushes the root into tmpDirs so the shared cleanup() handles removal.
 *
 * @param {object|null} stateContent  Parsed state to write as state.json, or
 *                                    null to leave state.json absent.
 * @param {boolean} [createHarness=true]  Whether to create the .harness/ dir.
 * @returns {{ projectRoot: string, harnessDir: string, pipeline: Pipeline }}
 */
function makeTmpHarness(stateContent, createHarness = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-gate-'));
  tmpDirs.push(root);
  const hDir = path.join(root, '.harness');
  if (createHarness) {
    // Logger needs a logs/ subdir; recursive mkdir covers hDir itself too
    fs.mkdirSync(path.join(hDir, 'logs'), { recursive: true });
    if (stateContent !== null) {
      fs.writeFileSync(
        path.join(hDir, 'state.json'),
        JSON.stringify(stateContent, null, 2),
        'utf8'
      );
    }
  }
  const p = new Pipeline(root, { onLog: () => {} });
  return { projectRoot: root, harnessDir: hDir, pipeline: p };
}

// TC26: gate blocks when state.json has globalStatus=active and all milestones complete/invalidated
await test(
  'TC26: gate blocks when all milestones are complete/invalidated (globalStatus=active)',
  () => {
    const state = {
      globalStatus: 'active',
      milestones: {
        '001': { status: 'complete' },
        '002': { status: 'invalidated' },
      },
    };
    const { pipeline, harnessDir } = makeTmpHarness(state);

    let threw = false;
    let errMsg = '';
    try {
      pipeline._checkOverwriteProtection(harnessDir);
    } catch (err) {
      threw = true;
      errMsg = err.message;
    }

    assert.ok(threw, 'Expected _checkOverwriteProtection to throw for completed run');
    assert.ok(
      errMsg.includes('cc-orch archive'),
      `Error message should mention 'cc-orch archive', got: ${errMsg}`
    );
  }
);

// TC27: gate allows in-progress state (one milestone pending)
await test(
  'TC27: gate allows in-progress state (one milestone pending)',
  () => {
    const state = {
      globalStatus: 'active',
      milestones: {
        '001': { status: 'complete' },
        '002': { status: 'pending' },
      },
    };
    const { pipeline, harnessDir } = makeTmpHarness(state);

    assert.doesNotThrow(
      () => pipeline._checkOverwriteProtection(harnessDir),
      'Expected _checkOverwriteProtection NOT to throw when a milestone is still pending'
    );
  }
);

// TC28: gate allows fresh project with no .harness/ directory
await test(
  'TC28: gate allows fresh project with no .harness/ directory',
  () => {
    // Pass createHarness=false so no .harness/ dir or state.json is created
    const { pipeline, harnessDir } = makeTmpHarness(null, false);

    assert.doesNotThrow(
      () => pipeline._checkOverwriteProtection(harnessDir),
      'Expected _checkOverwriteProtection NOT to throw when .harness/ does not exist'
    );
  }
);

// TC29: gate blocks before archive, then allows after archive() reinitializes fresh state
await test(
  'TC29: gate blocks before archive, then allows after archive() reinitializes fresh state',
  async () => {
    // Create a project with all milestones complete — same format as makeTmpProject()
    // (array milestones work for both _checkOverwriteProtection and validateArchivable)
    const projectRoot = makeTmpProject();
    const harnessDir = path.join(projectRoot, '.harness');

    // Step 1: Confirm the gate BLOCKS before archive
    const pipelineBefore = new Pipeline(projectRoot, { onLog: () => {} });
    let threw = false;
    let errMsg = '';
    try {
      pipelineBefore._checkOverwriteProtection(harnessDir);
    } catch (err) {
      threw = true;
      errMsg = err.message;
    }

    assert.ok(threw, 'Expected _checkOverwriteProtection to throw before archiving (all milestones complete)');
    assert.ok(
      errMsg.includes('cc-orch archive'),
      `Error message should mention 'cc-orch archive', got: ${errMsg}`
    );

    // Step 2: Run archive() with mock deps — { auto: true } so it skips the prompt
    const archiveDir = await archive(projectRoot, 'gate-unblock-test', { auto: true }, {
      summarize: mockSummarize,
      getGitInfo: mockGetGitInfo,
    });

    assert.ok(archiveDir, 'archive() should return the archive directory path');
    assert.ok(fs.existsSync(archiveDir), `Archive directory should exist: ${archiveDir}`);

    // Step 3: Confirm the gate ALLOWS on the fresh post-archive state
    const pipelineAfter = new Pipeline(projectRoot, { onLog: () => {} });
    assert.doesNotThrow(
      () => pipelineAfter._checkOverwriteProtection(harnessDir),
      'Expected _checkOverwriteProtection NOT to throw after archive() reinitializes fresh state'
    );
  }
);

// ── getRecentCommits helper tests ─────────────────────────────────────────────

/**
 * Create a minimal git repo with two commits.
 * Returns { gitDir, sha1 } where sha1 is the SHA after the first commit,
 * or null if git setup fails (e.g. git not installed in CI).
 */
function makeTestGitRepo() {
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-git-repo-'));
  tmpDirs.push(gitDir);
  try {
    testExecSync('git init', { cwd: gitDir, stdio: 'pipe' });
    testExecSync('git config user.email "test@test.com"', { cwd: gitDir, stdio: 'pipe' });
    testExecSync('git config user.name "Test"', { cwd: gitDir, stdio: 'pipe' });
    testExecSync('git commit --allow-empty -m "first commit"', { cwd: gitDir, stdio: 'pipe' });
    const sha1 = testExecSync('git rev-parse HEAD', { cwd: gitDir, encoding: 'utf8', stdio: 'pipe' }).trim();
    testExecSync('git commit --allow-empty -m "second commit"', { cwd: gitDir, stdio: 'pipe' });
    return { gitDir, sha1 };
  } catch {
    return null;
  }
}

// TC1 (getRecentCommits): with prior archive uses git log <sha>..HEAD
await test('TC1 (getRecentCommits): with prior archive uses git log <sha>..HEAD', () => {
  const repo = makeTestGitRepo();
  if (!repo) {
    console.log('      [skipped: git not available for repo setup]');
    return;
  }
  const { gitDir, sha1 } = repo;

  // Create a fake archives/ dir with a manifest.json containing sha1 as gitHead
  const archivesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-archives-'));
  tmpDirs.push(archivesDir);
  const archiveEntry = path.join(archivesDir, '001-prior');
  fs.mkdirSync(archiveEntry, { recursive: true });
  fs.writeFileSync(
    path.join(archiveEntry, 'manifest.json'),
    JSON.stringify({ gitHead: sha1 }),
    'utf8'
  );

  const result = getRecentCommits(gitDir, archivesDir);

  // Range-scoped log: should include "second commit" (after sha1) but NOT "first commit"
  assert.ok(
    result.includes('second commit'),
    `Expected range-scoped log to include "second commit", got: "${result}"`
  );
  assert.ok(
    !result.includes('first commit'),
    `Range-scoped log should NOT include "first commit" (it is before sha1), got: "${result}"`
  );
});

// TC2 (getRecentCommits): with no archives dir uses git log --oneline -50
await test('TC2 (getRecentCommits): with no archives dir uses git log --oneline -50', () => {
  const repo = makeTestGitRepo();
  if (!repo) {
    console.log('      [skipped: git not available for repo setup]');
    return;
  }
  const { gitDir } = repo;

  // Non-existent archives directory → no prior gitHead → full log fallback
  const archivesDir = path.join(os.tmpdir(), `nonexistent-archives-${Date.now()}`);

  const result = getRecentCommits(gitDir, archivesDir);

  // Full log should include both commits
  assert.ok(
    result.includes('second commit'),
    `Expected full log to include "second commit", got: "${result}"`
  );
  assert.ok(
    result.includes('first commit'),
    `Expected full log to include "first commit", got: "${result}"`
  );
});

// TC3 (getRecentCommits): with prior archive missing gitHead uses fallback
await test('TC3 (getRecentCommits): with prior archive missing gitHead uses fallback', () => {
  const repo = makeTestGitRepo();
  if (!repo) {
    console.log('      [skipped: git not available for repo setup]');
    return;
  }
  const { gitDir } = repo;

  // Create archives/ dir with manifest.json where gitHead is 'unknown' → triggers fallback
  const archivesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-archives-unknown-'));
  tmpDirs.push(archivesDir);
  const archiveEntry = path.join(archivesDir, '001-prior');
  fs.mkdirSync(archiveEntry, { recursive: true });
  fs.writeFileSync(
    path.join(archiveEntry, 'manifest.json'),
    JSON.stringify({ gitHead: 'unknown' }),
    'utf8'
  );

  const result = getRecentCommits(gitDir, archivesDir);

  // Should fall back to full log and include BOTH commits
  assert.ok(
    result.includes('first commit'),
    `Expected fallback full log to include "first commit", got: "${result}"`
  );
  assert.ok(
    result.includes('second commit'),
    `Expected fallback full log to include "second commit", got: "${result}"`
  );
});

// TC4 (getRecentCommits): gracefully handles git command failure
await test('TC4 (getRecentCommits): gracefully handles git command failure', () => {
  // A non-git temp directory will cause execSync('git log ...') to throw
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-nongit-'));
  tmpDirs.push(nonGitDir);
  const archivesDir = path.join(os.tmpdir(), `nonexistent-archives-${Date.now()}`);

  const result = getRecentCommits(nonGitDir, archivesDir);

  assert.strictEqual(
    result,
    '(git log unavailable)',
    `Expected fallback string on git failure, got: "${result}"`
  );
});

// TC5 (archive): accepts deps.getDiffSummary override and passes result to summarizer data package
// Note: archive.js now uses getDiffSummary instead of getRecentCommits in the data package.
await test('TC5 (archive): accepts deps.getDiffSummary override and passes result to summarizer data package', async () => {
  const projectRoot = makeTmpProject();
  const fakeDiffSummary = ' src/foo.js | 5 ++---\n 1 file changed, 3 insertions(+), 2 deletions(-)';

  let capturedDataPackage = null;

  const archiveDir = await archive(projectRoot, 'getdiffsummary-override-test', { auto: true }, {
    getGitInfo: mockGetGitInfo,
    getDiffSummary: (_projectRoot, _archivesDir, _deps) => fakeDiffSummary,
    summarize: async (dataPackage) => {
      capturedDataPackage = dataPackage;
      return {
        headline: 'TC5 Test Headline',
        bugs: [],
        summary: 'TC5 test summary.',
      };
    },
  });

  assert.ok(archiveDir, 'archive() should return the archive directory path');
  assert.ok(
    capturedDataPackage !== null,
    'summarize should have been called with a data package'
  );
  assert.strictEqual(
    capturedDataPackage.diffSummary,
    fakeDiffSummary,
    `dataPackage.diffSummary should equal the injected fake diff summary string, got: "${capturedDataPackage?.diffSummary}"`
  );
});

// ── validateChangelogSources unit tests ───────────────────────────────────────

const sampleDiffSummary = [
  ' src/cli/commands/archive.js | 25 ++++++++',
  ' src/orchestrator/core/pipeline.js | 10 +++--',
  ' 2 files changed, 35 insertions(+), 2 deletions(-)',
].join('\n');

// TC-vcs-1: validateChangelogSources accepts diff-file items whose file IS in diffSummary
await test('TC-vcs-1: validateChangelogSources accepts diff-file items when file is in diffSummary', () => {
  const changelog = [
    { source: 'diff-file', file: 'src/cli/commands/archive.js', description: 'Added archive logic', type: 'feature' },
    { source: 'diff-file', file: 'src/orchestrator/core/pipeline.js', description: 'Pipeline fix', type: 'fix' },
  ];
  const { valid, invalid } = validateChangelogSources(changelog, sampleDiffSummary);

  assert.strictEqual(valid.length, 2, `Expected 2 valid items, got ${valid.length}`);
  assert.strictEqual(invalid.length, 0, `Expected 0 invalid items, got ${invalid.length}`);
  assert.ok(
    valid.some(i => i.file === 'src/cli/commands/archive.js'),
    'Expected archive.js item to be valid'
  );
});

// TC-vcs-2: validateChangelogSources rejects diff-file items whose file is NOT in diffSummary
await test('TC-vcs-2: validateChangelogSources rejects diff-file items when file is NOT in diffSummary', () => {
  const changelog = [
    { source: 'diff-file', file: 'src/nonexistent/file.js', description: 'Ghost change', type: 'feature' },
    { source: 'diff-file', file: 'src/cli/commands/archive.js', description: 'Real change', type: 'fix' },
  ];
  const { valid, invalid } = validateChangelogSources(changelog, sampleDiffSummary);

  assert.strictEqual(invalid.length, 1, `Expected 1 invalid item, got ${invalid.length}`);
  assert.strictEqual(invalid[0].file, 'src/nonexistent/file.js', 'Expected ghost change to be invalid');
  assert.strictEqual(valid.length, 1, `Expected 1 valid item, got ${valid.length}`);
  assert.strictEqual(valid[0].file, 'src/cli/commands/archive.js', 'Expected real change to be valid');
});

// TC-vcs-3: validateChangelogSources passes through non-diff-file sources unchanged
await test('TC-vcs-3: validateChangelogSources passes through items with non-diff-file sources unchanged', () => {
  const changelog = [
    { source: 'manual', description: 'Manual entry', type: 'feature' },
    { source: 'commit', description: 'Commit-based entry', type: 'fix' },
    { description: 'No source field at all', type: 'breaking' },
  ];
  const { valid, invalid } = validateChangelogSources(changelog, sampleDiffSummary);

  assert.strictEqual(valid.length, 3, `Expected all 3 items to be valid, got ${valid.length}`);
  assert.strictEqual(invalid.length, 0, `Expected 0 invalid items, got ${invalid.length}`);
});

// TC-vcs-4: archive() retries summarizer once when diff-file validation fails
await test('TC-vcs-4: archive() retries summarizer once when diff-file validation fails', async () => {
  const projectRoot = makeTmpProject();
  let callCount = 0;

  const vcsDiffSummary = ' src/real/file.js | 5 ++---\n 1 file changed, 5 insertions(+), 2 deletions(-)';

  const retryTrackingSummarize = async (_dataPackage) => {
    callCount++;
    if (callCount === 1) {
      // First call: return a changelog item referencing a file NOT in the diff
      return {
        headline: 'Test',
        bugs: [],
        summary: 'Test summary.',
        changelog: [
          { source: 'diff-file', file: 'src/fake/ghost.js', description: 'Ghost', type: 'feature' },
          { source: 'diff-file', file: 'src/real/file.js', description: 'Real', type: 'fix' },
        ],
      };
    }
    // Second call (retry): return only valid items
    return {
      headline: 'Retry',
      bugs: [],
      summary: 'Retry summary.',
      changelog: [
        { source: 'diff-file', file: 'src/real/file.js', description: 'Real', type: 'fix' },
      ],
    };
  };

  const archiveDir = await archive(projectRoot, 'retry-test', { auto: true }, {
    summarize: retryTrackingSummarize,
    getGitInfo: mockGetGitInfo,
    getDiffSummary: () => vcsDiffSummary,
  });

  assert.strictEqual(callCount, 2, `Summarizer should be called exactly twice (initial + retry), got ${callCount}`);
  assert.ok(archiveDir, 'archive() should return archive dir path after retry');

  // Verify manifest contains only valid changelog items
  const manifest4 = JSON.parse(fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8'));
  assert.ok(
    manifest4.changelog.every(i => i.file !== 'src/fake/ghost.js'),
    'manifest.changelog should not contain the ghost/invalid file entry'
  );
});

// TC-vcs-5: archive() strips invalid items and continues after retry also fails
await test('TC-vcs-5: archive() strips invalid items and continues after retry also fails', async () => {
  const projectRoot = makeTmpProject();
  let callCount = 0;

  const vcsDiffSummary2 = ' src/real/file.js | 5 ++---\n 1 file changed, 5 insertions(+), 2 deletions(-)';

  const persistentlyInvalidSummarize = async (_dataPackage) => {
    callCount++;
    // Both calls return an invalid diff-file item that won't pass validation
    return {
      headline: `Call ${callCount}`,
      bugs: [],
      summary: `Summary ${callCount}.`,
      changelog: [
        { source: 'diff-file', file: 'src/fake/ghost.js', description: 'Ghost', type: 'feature' },
        { source: 'diff-file', file: 'src/real/file.js', description: 'Real', type: 'fix' },
        { source: 'manual', description: 'Manual entry', type: 'fix' },
      ],
    };
  };

  const archiveDir = await archive(projectRoot, 'strip-after-retry-test', { auto: true }, {
    summarize: persistentlyInvalidSummarize,
    getGitInfo: mockGetGitInfo,
    getDiffSummary: () => vcsDiffSummary2,
  });

  assert.strictEqual(callCount, 2, `Summarizer should be called exactly twice, got ${callCount}`);
  assert.ok(archiveDir, 'archive() should complete and return archive dir even when retry also fails');

  // Manifest should have invalid item stripped; valid ones should remain
  const manifest5 = JSON.parse(fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8'));
  assert.ok(
    manifest5.changelog.every(i => i.file !== 'src/fake/ghost.js'),
    'manifest.changelog should not contain the ghost file entry after stripping'
  );
  const validItems5 = manifest5.changelog.filter(i => i.file === 'src/real/file.js' || i.source === 'manual');
  assert.ok(validItems5.length > 0, 'manifest.changelog should retain valid items after stripping');
});

await test('TC-diff-exclude: getDiffSummary skips excludeArchiveId when picking the prior manifest', async () => {
  // Build a temp archives/ with two manifests:
  //   001-old: gitHead='oldsha'   (the real prior)
  //   002-new: gitHead='HEAD'     (the just-created archive — must be excluded)
  // Without the exclusion, the function picks 002 (highest seq) and produces
  // an empty diff. With the exclusion, it must pick 001 and pass 'oldsha'.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-diff-exclude-'));
  tmpDirs.push(tmpDir);
  const archivesDir = path.join(tmpDir, 'archives');
  fs.mkdirSync(path.join(archivesDir, '001-old'), { recursive: true });
  fs.writeFileSync(
    path.join(archivesDir, '001-old', 'manifest.json'),
    JSON.stringify({ gitHead: 'oldsha' }),
    'utf8',
  );
  fs.mkdirSync(path.join(archivesDir, '002-new'), { recursive: true });
  fs.writeFileSync(
    path.join(archivesDir, '002-new', 'manifest.json'),
    JSON.stringify({ gitHead: 'HEAD' }),
    'utf8',
  );

  // Stub git via a shim project root; we only assert *which* SHA gets used by
  // observing the thrown command — easier path: monkeypatch execSync via a
  // tiny wrapper. Instead, capture priorGitHead by spying through a controlled
  // projectRoot where `git diff --stat oldsha..HEAD` will fail predictably and
  // `git diff --stat HEAD..HEAD` returns ''. We assert the function returns
  // '' when excluding, because the chosen SHA is invalid in this tmp dir.
  // The discriminator is whether the function would short-circuit (no prior
  // archive) vs attempt a git invocation. With the exclusion working, it
  // attempts oldsha..HEAD against tmpDir (no git repo) → catches → returns ''.
  // Without the exclusion working, it would attempt HEAD..HEAD → also '' or
  // catch. Both branches yield ''. So the cleanest assertion is to verify the
  // chosen entry directly via a probe call: temporarily replace one manifest
  // and re-read.
  //
  // Stronger approach: verify by assertion on chosen path through a probe —
  // make the OLD manifest 'unknown' so it's filtered out, leaving only NEW.
  // With excludeArchiveId='002-new', the function should find no prior gitHead
  // and return '' without ever invoking git.
  fs.writeFileSync(
    path.join(archivesDir, '001-old', 'manifest.json'),
    JSON.stringify({ gitHead: 'unknown' }),
    'utf8',
  );

  // With NO exclusion, the function picks 002-new (gitHead 'HEAD') and tries
  // git — in a non-git dir this returns ''. Indistinguishable, so we go a
  // different route: assert via a positive case where only the EXCLUSION
  // changes the outcome. Restore old to a valid sha and make new gitHead also
  // valid; then verify the excluded version uses the priorGitHead from old by
  // shelling git in a real tmp git repo.
  fs.writeFileSync(
    path.join(archivesDir, '001-old', 'manifest.json'),
    JSON.stringify({ gitHead: 'oldsha' }),
    'utf8',
  );

  // Initialize a real tmp git repo so `git diff --stat <ref>..HEAD` is a
  // legitimate command we can observe via stderr.
  testExecSync('git init --quiet', { cwd: tmpDir });
  testExecSync('git config user.email t@t', { cwd: tmpDir });
  testExecSync('git config user.name t', { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a\n', 'utf8');
  testExecSync('git add . && git commit --quiet -m a', { cwd: tmpDir });
  const oldSha = testExecSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b\n', 'utf8');
  testExecSync('git add . && git commit --quiet -m b', { cwd: tmpDir });
  const newSha = testExecSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim();

  // Update manifests with real shas: 001-old → oldSha, 002-new → newSha (HEAD).
  fs.writeFileSync(
    path.join(archivesDir, '001-old', 'manifest.json'),
    JSON.stringify({ gitHead: oldSha }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(archivesDir, '002-new', 'manifest.json'),
    JSON.stringify({ gitHead: newSha }),
    'utf8',
  );

  // Without exclusion: picks 002-new → diffs newSha..HEAD → '' (no commits between).
  const withoutExclusion = getDiffSummary(tmpDir, archivesDir);
  assert.strictEqual(
    withoutExclusion,
    '',
    `Without exclusion, expected empty diff (HEAD..HEAD), got: ${withoutExclusion}`,
  );

  // With exclusion: picks 001-old → diffs oldSha..HEAD → should mention b.txt.
  const withExclusion = getDiffSummary(tmpDir, archivesDir, { excludeArchiveId: '002-new' });
  assert.ok(
    withExclusion.includes('b.txt'),
    `With exclusion, expected diff to include 'b.txt', got: ${withExclusion}`,
  );
});

// ── computeSeq with failed-prefix directories (TC-seq-failed-1 – TC-seq-failed-3) ──

// TC-seq-failed-1: only 'failed-002-bar' → computeSeq returns '003'
await test("TC-seq-failed-1: only 'failed-002-bar' → computeSeq returns '003'", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-seq-failed1-'));
  tmpDirs.push(tmpDir);

  fs.mkdirSync(path.join(tmpDir, 'failed-002-bar'), { recursive: true });

  const seq = computeSeq(tmpDir);
  assert.strictEqual(seq, '003', `computeSeq should return '003' when only 'failed-002-bar' exists, got: ${seq}`);
});

// TC-seq-failed-2: mixed '001-alpha' and 'failed-003-beta' → computeSeq returns '004'
await test("TC-seq-failed-2: mixed '001-alpha' + 'failed-003-beta' → computeSeq returns '004'", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-seq-failed2-'));
  tmpDirs.push(tmpDir);

  fs.mkdirSync(path.join(tmpDir, '001-alpha'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'failed-003-beta'), { recursive: true });

  const seq = computeSeq(tmpDir);
  assert.strictEqual(seq, '004', `computeSeq should return '004' when max seq is 003 (from failed-003-beta), got: ${seq}`);
});

// TC-seq-failed-3: 'failed-005-x' and '003-y' → computeSeq returns '006' (failed prefix has higher seq)
await test("TC-seq-failed-3: 'failed-005-x' + '003-y' → computeSeq returns '006'", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-seq-failed3-'));
  tmpDirs.push(tmpDir);

  fs.mkdirSync(path.join(tmpDir, 'failed-005-x'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '003-y'), { recursive: true });

  const seq = computeSeq(tmpDir);
  assert.strictEqual(seq, '006', `computeSeq should return '006' when failed-005-x has the highest seq (005), got: ${seq}`);
});

// ── moveHarnessToArchive / copySpecToArchive / buildManifest unit tests ───────

// TC-moveHarness-subdirs: per-run subdirs are moved; SHARED subdirs
// (brainstorm/ etc.) stay at the harness root and never enter an archive.
await test('TC-moveHarness-subdirs: per-run verify/ is moved, shared brainstorm/ stays', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-move-subdirs-'));
  tmpDirs.push(tmpDir);

  const harnessDir = path.join(tmpDir, 'harness');
  const archiveDir = path.join(tmpDir, 'archive');
  fs.mkdirSync(harnessDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  // A per-run dir with a file (must move) and a shared dir with a file
  // (must stay).
  const verifyDir = path.join(harnessDir, 'verify');
  fs.mkdirSync(verifyDir, { recursive: true });
  fs.writeFileSync(path.join(verifyDir, 'task-x.json'), '{}', 'utf8');
  const brainstormDir = path.join(harnessDir, 'brainstorm');
  fs.mkdirSync(brainstormDir, { recursive: true });
  fs.writeFileSync(path.join(brainstormDir, 'ideas.md'), '# Ideas', 'utf8');

  moveHarnessToArchive(harnessDir, archiveDir);

  assert.ok(
    fs.existsSync(path.join(archiveDir, 'verify', 'task-x.json')),
    'per-run verify/ should be moved into archive dir'
  );
  assert.ok(
    !fs.existsSync(path.join(archiveDir, 'brainstorm')),
    'shared brainstorm/ should NOT be moved into archive dir'
  );
  assert.ok(
    fs.existsSync(path.join(brainstormDir, 'ideas.md')),
    'shared brainstorm/ should remain at the harness root after move'
  );
});

// TC-copySpec-missing: copySpecToArchive returns silently when spec file doesn't exist
await test('TC-copySpec-missing: no error when spec file does not exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-copyspec-missing-'));
  tmpDirs.push(tmpDir);

  const archiveDir = path.join(tmpDir, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });

  const nonExistentSpec = path.join(tmpDir, 'does-not-exist.md');

  // Should complete without throwing
  assert.doesNotThrow(
    () => copySpecToArchive(nonExistentSpec, tmpDir, archiveDir, false),
    'copySpecToArchive should not throw when spec file does not exist'
  );

  // No spec.md should have been created in archiveDir
  assert.ok(
    !fs.existsSync(path.join(archiveDir, 'spec.md')),
    'spec.md should NOT be written when the source spec file does not exist'
  );
});

// TC-copySpec-md-and-json: <x>.md + sibling <x>.json both archived (spec.md + spec.json)
await test('TC-copySpec-md-and-json: md + sibling json both copied into archive dir', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-copyspec-mdjson-'));
  tmpDirs.push(tmpDir);

  const archiveDir = path.join(tmpDir, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });

  // Project root holds both spec.md and sibling spec.json
  const mdContent = '# Spec MD\n\nMarkdown spec content.';
  const jsonContent = JSON.stringify({ goal: 'json sot content', n: 1 }, null, 2);
  const mdSrc = path.join(tmpDir, 'spec.md');
  const jsonSrc = path.join(tmpDir, 'spec.json');
  fs.writeFileSync(mdSrc, mdContent, 'utf8');
  fs.writeFileSync(jsonSrc, jsonContent, 'utf8');

  copySpecToArchive(mdSrc, tmpDir, archiveDir, false);

  // BOTH artifacts must exist in the archive dir with their respective contents
  const archivedMd = path.join(archiveDir, 'spec.md');
  const archivedJson = path.join(archiveDir, 'spec.json');
  assert.ok(fs.existsSync(archivedMd), 'archiveDir/spec.md should exist when md source is present');
  assert.ok(fs.existsSync(archivedJson), 'archiveDir/spec.json should exist when sibling json is present');
  assert.strictEqual(
    fs.readFileSync(archivedMd, 'utf8'),
    mdContent,
    'archived spec.md content should equal the md source content'
  );
  assert.strictEqual(
    fs.readFileSync(archivedJson, 'utf8'),
    jsonContent,
    'archived spec.json content should equal the json source content'
  );
});

// TC-copySpec-md-only: <x>.md with NO sibling json → only spec.md archived (unchanged behaviour)
await test('TC-copySpec-md-only: md-only spec archives spec.md, NOT spec.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-copyspec-mdonly-'));
  tmpDirs.push(tmpDir);

  const archiveDir = path.join(tmpDir, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });

  // Only spec.md exists at project root — no sibling spec.json
  const mdContent = '# MD only\n\nNo json sibling here.';
  const mdSrc = path.join(tmpDir, 'spec.md');
  fs.writeFileSync(mdSrc, mdContent, 'utf8');

  copySpecToArchive(mdSrc, tmpDir, archiveDir, false);

  const archivedMd = path.join(archiveDir, 'spec.md');
  const archivedJson = path.join(archiveDir, 'spec.json');
  assert.ok(fs.existsSync(archivedMd), 'archiveDir/spec.md should exist for md-only spec');
  assert.strictEqual(
    fs.readFileSync(archivedMd, 'utf8'),
    mdContent,
    'archived spec.md content should equal the md source content'
  );
  assert.ok(
    !fs.existsSync(archivedJson),
    'archiveDir/spec.json should NOT exist when there is no sibling json (unchanged behaviour)'
  );
});

// TC-copySpec-json-only: <x>.json spec path with NO sibling md → spec.json archived, NOT mis-copied to spec.md
await test('TC-copySpec-json-only: json-only spec archives spec.json, NOT mis-copied into spec.md', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-copyspec-jsononly-'));
  tmpDirs.push(tmpDir);

  const archiveDir = path.join(tmpDir, 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });

  // Only spec.json exists at project root — no sibling spec.md
  const jsonContent = JSON.stringify({ goal: 'json is the only artifact', sot: true }, null, 2);
  const jsonSrc = path.join(tmpDir, 'spec.json');
  fs.writeFileSync(jsonSrc, jsonContent, 'utf8');

  copySpecToArchive(jsonSrc, tmpDir, archiveDir, false);

  const archivedJson = path.join(archiveDir, 'spec.json');
  const archivedMd = path.join(archiveDir, 'spec.md');

  // spec.json must be archived with the json content
  assert.ok(fs.existsSync(archivedJson), 'archiveDir/spec.json should exist for json-only spec');
  assert.strictEqual(
    fs.readFileSync(archivedJson, 'utf8'),
    jsonContent,
    'archived spec.json content should equal the json source content'
  );

  // Anti-mis-copy: json content must NOT be written into a file named spec.md
  assert.ok(
    !fs.existsSync(archivedMd),
    'archiveDir/spec.md should NOT be created from json content (anti-mis-copy)'
  );
});

// TC-buildManifest-halt: haltInfo adds haltReason and haltTaskId to manifest
await test("TC-buildManifest-halt: haltReason='circuit-breaker' and haltTaskId='001-001-001-001' present in manifest", () => {
  const state = {
    name: 'halt-test',
    spec: 'spec.md',
    startedAt: '2026-01-01T00:00:00.000Z',
    milestones: {},
  };
  const haltInfo = { haltReason: 'circuit-breaker', haltTaskId: '001-001-001-001' };
  const summaryData = { headline: 'Halted', bugs: [], summary: 'Run halted.' };
  const gitInfo = { head: 'abc123', status: 'clean' };
  const usageData = { totalCost: 0, totalSessions: 0 };

  const manifest = buildManifest(state, '001', 'halt-test', '# Spec', gitInfo, summaryData, usageData, haltInfo);

  assert.strictEqual(
    manifest.haltReason,
    'circuit-breaker',
    `manifest.haltReason should be 'circuit-breaker', got: ${manifest.haltReason}`
  );
  assert.strictEqual(
    manifest.haltTaskId,
    '001-001-001-001',
    `manifest.haltTaskId should be '001-001-001-001', got: ${manifest.haltTaskId}`
  );
});

// TC-buildManifest-no-halt: without haltInfo, haltReason and haltTaskId keys are absent
await test('TC-buildManifest-no-halt: haltReason and haltTaskId keys absent from manifest', () => {
  const state = {
    name: 'no-halt-test',
    spec: 'spec.md',
    startedAt: '2026-01-01T00:00:00.000Z',
    milestones: {},
  };
  const summaryData = { headline: 'Done', bugs: [], summary: 'Run complete.' };
  const gitInfo = { head: 'def456', status: 'clean' };
  const usageData = { totalCost: 0, totalSessions: 0 };

  // Call without haltInfo (undefined)
  const manifest = buildManifest(state, '001', 'no-halt-test', '# Spec', gitInfo, summaryData, usageData);

  assert.ok(
    !('haltReason' in manifest),
    'manifest should NOT have haltReason key when haltInfo is not provided'
  );
  assert.ok(
    !('haltTaskId' in manifest),
    'manifest should NOT have haltTaskId key when haltInfo is not provided'
  );
});

// ── detectHaltInfo unit tests (TC-halt-*) ─────────────────────────────────────

// TC-halt-complete: globalStatus='complete' + all milestones complete → returns null
await test('TC-halt-complete: completed run returns null', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halt-complete-'));
  tmpDirs.push(tmpDir);
  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  const state = {
    globalStatus: 'complete',
    milestones: {
      '001': { status: 'complete' },
      '002': { status: 'complete' },
    },
  };

  const result = detectHaltInfo(harnessDir, state);
  assert.strictEqual(result, null, 'detectHaltInfo should return null for a completed run');
});

// TC-halt-circuit-breaker: analysis file with circuit-breaker message → {haltReason:'circuit-breaker', haltTaskId:'001-001-001-002'}
await test("TC-halt-circuit-breaker: circuit-breaker analysis → {haltReason:'circuit-breaker', haltTaskId:'001-001-001-002'}", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halt-cb-'));
  tmpDirs.push(tmpDir);
  const harnessDir = path.join(tmpDir, '.harness');
  const analysisDir = path.join(harnessDir, 'analysis');
  fs.mkdirSync(analysisDir, { recursive: true });

  // Write an analysis file whose string value triggers the circuit-breaker pattern
  const analysisFile = {
    taskId: '001-001-001-002',
    message: 'Circuit breaker: task 001-001-001-002 failed verification',
  };
  fs.writeFileSync(
    path.join(analysisDir, 'halt-001-001-001-002.json'),
    JSON.stringify(analysisFile, null, 2),
    'utf8'
  );

  const state = {
    globalStatus: 'active',
    milestones: {
      '001': { status: 'in-progress' },
    },
  };

  const result = detectHaltInfo(harnessDir, state);
  assert.ok(result !== null, 'detectHaltInfo should return a non-null result');
  assert.strictEqual(result.haltReason, 'circuit-breaker', `haltReason should be 'circuit-breaker', got: '${result.haltReason}'`);
  assert.strictEqual(result.haltTaskId, '001-001-001-002', `haltTaskId should be '001-001-001-002', got: '${result.haltTaskId}'`);
});

// TC-halt-reviewer-stop: analysis file with 'reviewer gate failed' → {haltReason:'reviewer-stop', haltTaskId matches reviewer-NNN}
await test("TC-halt-reviewer-stop: reviewer gate analysis → {haltReason:'reviewer-stop'}", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halt-reviewer-'));
  tmpDirs.push(tmpDir);
  const harnessDir = path.join(tmpDir, '.harness');
  const analysisDir = path.join(harnessDir, 'analysis');
  fs.mkdirSync(analysisDir, { recursive: true });

  // Write an analysis file whose string value triggers the reviewer-gate pattern
  const analysisFile = {
    taskId: 'reviewer-001',
    message: 'reviewer gate failed: reviewer NNN rejected the changes',
  };
  fs.writeFileSync(
    path.join(analysisDir, 'reviewer-gate-001.json'),
    JSON.stringify(analysisFile, null, 2),
    'utf8'
  );

  const state = {
    globalStatus: 'active',
    milestones: {
      '001': { status: 'in-progress' },
    },
  };

  const result = detectHaltInfo(harnessDir, state);
  assert.ok(result !== null, 'detectHaltInfo should return a non-null result');
  assert.strictEqual(result.haltReason, 'reviewer-stop', `haltReason should be 'reviewer-stop', got: '${result.haltReason}'`);
  assert.ok(
    typeof result.haltTaskId === 'string' && /reviewer/.test(result.haltTaskId),
    `haltTaskId should match reviewer-NNN pattern, got: '${result.haltTaskId}'`
  );
});

// TC-halt-unknown: incomplete state with no analysis files → {haltReason:'unknown', haltTaskId:null}
await test("TC-halt-unknown: no analysis files → {haltReason:'unknown', haltTaskId:null}", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halt-unknown-'));
  tmpDirs.push(tmpDir);
  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });
  // No analysis/ directory created → no analysis files

  const state = {
    globalStatus: 'active',
    milestones: {
      '001': { status: 'in-progress' },
    },
  };

  const result = detectHaltInfo(harnessDir, state);
  assert.ok(result !== null, 'detectHaltInfo should return a non-null result for incomplete state with no analysis files');
  assert.strictEqual(result.haltReason, 'unknown', `haltReason should be 'unknown', got: '${result.haltReason}'`);
  assert.strictEqual(result.haltTaskId, null, `haltTaskId should be null, got: ${JSON.stringify(result.haltTaskId)}`);
});

// TC-halt-regression: analysis file with 'regression failed' → {haltReason:'regression-failure'}
await test("TC-halt-regression: regression analysis → {haltReason:'regression-failure'}", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halt-regression-'));
  tmpDirs.push(tmpDir);
  const harnessDir = path.join(tmpDir, '.harness');
  const analysisDir = path.join(harnessDir, 'analysis');
  fs.mkdirSync(analysisDir, { recursive: true });

  // Write an analysis file whose string value triggers the regression-failure pattern
  const analysisFile = {
    taskId: '001-001-001-003',
    message: 'Regression failed: test suite failure detected after changes',
  };
  fs.writeFileSync(
    path.join(analysisDir, 'regression-001-001-001-003.json'),
    JSON.stringify(analysisFile, null, 2),
    'utf8'
  );

  const state = {
    globalStatus: 'active',
    milestones: {
      '001': { status: 'in-progress' },
    },
  };

  const result = detectHaltInfo(harnessDir, state);
  assert.ok(result !== null, 'detectHaltInfo should return a non-null result');
  assert.strictEqual(result.haltReason, 'regression-failure', `haltReason should be 'regression-failure', got: '${result.haltReason}'`);
});

// ── --include-failed archive flow helpers ─────────────────────────────────────

/**
 * Create a temporary project directory with a halted-state .harness/state.json.
 * globalStatus is 'halted' and one milestone is 'in-progress' so detectHaltInfo
 * returns non-null (haltReason: 'unknown').
 *
 * @returns {string} Absolute path to the project root temp dir
 */
function makeTmpProjectHalted() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-halted-'));
  tmpDirs.push(tmpDir);

  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  const specRelPath = 'spec.md';
  fs.writeFileSync(
    path.join(tmpDir, specRelPath),
    '# Halted Spec\n\nHalted run spec content.',
    'utf8'
  );

  const state = {
    name: 'Halted Project',
    spec: specRelPath,
    startedAt: '2026-01-01T00:00:00.000Z',
    globalStatus: 'halted',
    milestones: [
      { id: '001', description: 'Done milestone', status: 'complete' },
      { id: '002', description: 'Work in progress', status: 'in-progress' },
    ],
    projectMeta: { currentPhase: 'active' },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(state, null, 2),
    'utf8'
  );

  // Minimal harness artifacts so moveHarnessToArchive has non-empty entries to move
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'logs', 'test.log'), 'log data', 'utf8');

  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'state', 'mission-001.json'), '{}', 'utf8');

  return tmpDir;
}

/**
 * Create a temporary project directory with a completed-run .harness/state.json.
 * globalStatus is 'complete' and all milestones are terminal so detectHaltInfo
 * returns null (normal completion — not a failed run).
 *
 * @returns {string} Absolute path to the project root temp dir
 */
function makeTmpProjectCompletedRun() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-completed-run-'));
  tmpDirs.push(tmpDir);

  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  const specRelPath = 'spec.md';
  fs.writeFileSync(
    path.join(tmpDir, specRelPath),
    '# Completed Spec\n\nCompleted run spec content.',
    'utf8'
  );

  const state = {
    name: 'Completed Project',
    spec: specRelPath,
    startedAt: '2026-01-01T00:00:00.000Z',
    globalStatus: 'complete',
    milestones: [
      { id: '001', description: 'First milestone', status: 'complete' },
      { id: '002', description: 'Second milestone', status: 'complete' },
    ],
    projectMeta: { currentPhase: 'complete' },
  };
  fs.writeFileSync(
    path.join(harnessDir, 'state.json'),
    JSON.stringify(state, null, 2),
    'utf8'
  );

  return tmpDir;
}

// ── TC-failed-archive-creates-dir ─────────────────────────────────────────────

await test('TC-failed-archive-creates-dir: halted state + --include-failed → failed-001-slug/ exists', async () => {
  const projectRoot = makeTmpProjectHalted();

  const archiveDir = await archive(projectRoot, 'halted-project', { 'include-failed': true }, {
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDir, 'archive() should return the archive directory path');
  assert.ok(fs.existsSync(archiveDir), `Archive directory should exist at: ${archiveDir}`);

  // Must be under archives/
  const expectedArchivesDir = path.join(projectRoot, 'archives');
  assert.ok(
    archiveDir.startsWith(expectedArchivesDir),
    `Archive dir should be under archives/, got: ${archiveDir}`
  );

  // Dir name must start with 'failed-001-'
  const dirName = path.basename(archiveDir);
  assert.ok(
    dirName.startsWith('failed-001-'),
    `Archive dir name should start with 'failed-001-', got: ${dirName}`
  );

  // manifest.json must exist and contain haltReason and haltTaskId
  const manifestPath = path.join(archiveDir, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json should exist in failed archive dir');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(
    'haltReason' in manifest,
    'manifest.json should have haltReason field'
  );
  assert.ok(
    'haltTaskId' in manifest,
    'manifest.json should have haltTaskId field'
  );
});

// ── TC-failed-archive-spec-moved ──────────────────────────────────────────────

await test('TC-failed-archive-spec-moved: spec.md in archive, removed from root', async () => {
  const projectRoot = makeTmpProjectHalted();

  // Verify spec exists at root before archive
  const specPath = path.join(projectRoot, 'spec.md');
  assert.ok(fs.existsSync(specPath), 'spec.md should exist at project root before archive');

  const archiveDir = await archive(projectRoot, 'halted-spec-test', { 'include-failed': true }, {
    getGitInfo: mockGetGitInfo,
  });

  // spec.md should be in the failed archive dir
  assert.ok(
    fs.existsSync(path.join(archiveDir, 'spec.md')),
    'spec.md should be copied into the failed archive directory'
  );

  // spec.md should be removed from project root (no --preserve flag)
  assert.ok(
    !fs.existsSync(specPath),
    'spec.md should be removed from project root after failed archive (no --preserve)'
  );
});

// ── TC-failed-archive-harness-reset ───────────────────────────────────────────

await test('TC-failed-archive-harness-reset: .harness/state.json gone, subdirs empty', async () => {
  const projectRoot = makeTmpProjectHalted();

  await archive(projectRoot, 'halted-reset-test', { 'include-failed': true }, {
    getGitInfo: mockGetGitInfo,
  });

  const harnessDir = path.join(projectRoot, '.harness');

  // state.json should NOT exist after failed archive (was moved into archive, not re-created)
  const stateJsonPath = path.join(harnessDir, 'state.json');
  assert.ok(
    !fs.existsSync(stateJsonPath),
    '.harness/state.json should NOT exist after failed archive'
  );

  // .harness/ itself should still exist
  assert.ok(
    fs.existsSync(harnessDir),
    '.harness/ directory should still exist after failed archive'
  );

  // Post-flip reinit contract (same as TC20): only the SHARED skeleton is
  // recreated at the root after a failed archive; per-run subdirs like
  // state/ must NOT reappear there.
  for (const shared of ['learning', 'dry-run', 'brainstorm']) {
    assert.ok(
      fs.existsSync(path.join(harnessDir, shared)),
      `.harness/${shared}/ (shared) should exist after failed-archive reinit`
    );
  }
  const stateDirPath = path.join(harnessDir, 'state');
  assert.ok(
    !fs.existsSync(stateDirPath),
    '.harness/state/ (per-run) should NOT be recreated at the root by the failed-archive reinit'
  );
});

// ── TC-failed-archive-no-flag ─────────────────────────────────────────────────

await test('TC-failed-archive-no-flag: halted state without --include-failed → validateArchivable prompts', async () => {
  const projectRoot = makeTmpProjectHalted();

  let promptCalled = false;
  const abortingPrompt = async (_msg) => {
    promptCalled = true;
    return false; // user declines
  };

  // No --include-failed flag — goes through normal validateArchivable path
  const result = await archive(projectRoot, 'halted-no-flag', {}, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
    promptYesNo: abortingPrompt,
  });

  // validateArchivable returns ok:false (has in-progress milestone, not auto mode) →
  // triggers prompt; abortingPrompt returns false → archive() returns undefined
  assert.ok(
    promptCalled,
    'promptYesNo should be called when milestones are not all terminal and --include-failed is not set'
  );
  assert.strictEqual(result, undefined, 'archive() should return undefined when user declines the prompt');

  // No archives dir should have been created
  const archivesDir = path.join(projectRoot, 'archives');
  const archiveDirExists =
    fs.existsSync(archivesDir) &&
    fs.readdirSync(archivesDir).length > 0;
  assert.ok(
    !archiveDirExists,
    'No archive directory should be created when user declines the prompt'
  );
});

// ── TC-failed-archive-completed-run ───────────────────────────────────────────

await test('TC-failed-archive-completed-run: completed state + --include-failed → no archive created', async () => {
  const projectRoot = makeTmpProjectCompletedRun();

  const result = await archive(projectRoot, 'completed-run', { 'include-failed': true }, {
    getGitInfo: mockGetGitInfo,
  });

  // detectHaltInfo returns null for globalStatus='complete' + all-terminal milestones → early exit
  assert.strictEqual(
    result,
    undefined,
    'archive() should return undefined for a completed run with --include-failed (early exit)'
  );

  // No archives dir should have been created
  const archivesDir = path.join(projectRoot, 'archives');
  assert.ok(
    !fs.existsSync(archivesDir) || fs.readdirSync(archivesDir).length === 0,
    'No archive directory should be created for a completed run with --include-failed'
  );
});

// ── TC-failed-archive-manifest-shape ─────────────────────────────────────────

await test('TC-failed-archive-manifest-shape: haltReason in failed manifest, absent in success manifest', async () => {
  // --- Failed archive: haltReason and haltTaskId must be present ---
  const haltedRoot = makeTmpProjectHalted();
  const failedArchiveDir = await archive(haltedRoot, 'manifest-shape-halted', { 'include-failed': true }, {
    getGitInfo: mockGetGitInfo,
  });

  const failedManifest = JSON.parse(
    fs.readFileSync(path.join(failedArchiveDir, 'manifest.json'), 'utf8')
  );

  assert.ok(
    'haltReason' in failedManifest,
    'failed archive manifest should have haltReason key'
  );
  assert.ok(
    'haltTaskId' in failedManifest,
    'failed archive manifest should have haltTaskId key'
  );

  // haltReason must be a value from the allowed enum
  const validHaltReasons = ['circuit-breaker', 'regression-failure', 'reviewer-stop', 'unknown'];
  assert.ok(
    validHaltReasons.includes(failedManifest.haltReason),
    `manifest.haltReason should be from the halt enum, got: '${failedManifest.haltReason}'`
  );

  // --- Successful archive: haltReason and haltTaskId must be absent ---
  const completedRoot = makeTmpProject();
  const successArchiveDir = await archive(completedRoot, 'manifest-shape-success', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  const successManifest = JSON.parse(
    fs.readFileSync(path.join(successArchiveDir, 'manifest.json'), 'utf8')
  );

  assert.ok(
    !('haltReason' in successManifest),
    'successful archive manifest should NOT have haltReason key'
  );
  assert.ok(
    !('haltTaskId' in successManifest),
    'successful archive manifest should NOT have haltTaskId key'
  );
});

// TC-fingerprint: archive produces dispersion-fingerprint.json in archive dir
await test('TC-fingerprint: archive produces dispersion-fingerprint.json in archive dir', async () => {
  const projectRoot = makeTmpProject();

  const archiveDir = await archive(projectRoot, 'fp-test', { auto: true }, {
    summarize: mockSummarize,
    getGitInfo: mockGetGitInfo,
  });

  assert.ok(archiveDir, 'archiveDir should be truthy');

  const fingerprintPath = path.join(archiveDir, 'dispersion-fingerprint.json');
  assert.ok(fs.existsSync(fingerprintPath), 'dispersion-fingerprint.json should exist in archive dir');

  const fingerprint = JSON.parse(fs.readFileSync(fingerprintPath, 'utf8'));
  assert.ok('fingerprintVersion' in fingerprint, 'dispersion-fingerprint.json should have a fingerprintVersion property');
});

// ── Cleanup + Summary ─────────────────────────────────────────────────────────

cleanup();

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
