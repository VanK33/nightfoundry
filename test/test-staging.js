#!/usr/bin/env node

/**
 * test-staging.js — Tests for contentHash and stageCandidate utilities.
 *
 * No external test framework.  Run: node test/test-staging.js
 *
 * Covers:
 *   Scenario 7 — contentHash determinism: same input → same 16-char hex output
 *   Scenario 1 — stageCandidate creates .pending file with correct frontmatter,
 *                body, and parent directories, for both 'contract' and 'standard'
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { contentHash, stageCandidate, parseFrontmatter, writeFrontmatter, listPending, promoteCandidate, resolveTargetPath, declineCandidate, isDeclined } from '../src/orchestrator/core/staging.js';

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

  console.log('=== Staging Utility Tests ===\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-staging-'));

  // ── Test 1: contentHash determinism ──────────────────────────────────────
  console.log('Test 1: contentHash determinism (scenario 7)');
  const input = { rule: 'Always validate input', why: 'Prevents injection attacks' };
  const hash1 = contentHash(input);
  const hash2 = contentHash(input);
  assert('same input produces same hash (call 1 === call 2)', hash1 === hash2);

  // Different inputs must produce different hashes
  const hashA = contentHash({ rule: 'rule A', why: 'why A' });
  const hashB = contentHash({ rule: 'rule B', why: 'why B' });
  assert('different inputs produce different hashes', hashA !== hashB);

  // ── Test 2: contentHash output format ────────────────────────────────────
  console.log('\nTest 2: contentHash output format');
  assert('hash is a string', typeof hash1 === 'string');
  assert('hash is exactly 16 characters', hash1.length === 16);
  assert('hash is lowercase hex', /^[0-9a-f]{16}$/.test(hash1));

  // ── Test 3: stageCandidate — contract kind, creates parent dirs ──────────
  console.log('\nTest 3: stageCandidate creates parent dirs when missing (scenario 1 — contract)');
  const pendingDirContract = path.join(tmpDir, 'docs', 'contracts', '.pending');
  assert('contracts .pending dir does not exist before call', !fs.existsSync(pendingDirContract));

  const contractResult = stageCandidate({
    projectRoot: tmpDir,
    kind: 'contract',
    content: {
      ruleName: 'No direct DB access from UI',
      rule: 'All DB queries must go through the service layer',
      why: 'Keeps business logic centralised',
      whereItBites: 'When adding a quick feature shortcut',
      area: 'architecture',
    },
    evidence: {
      rule: 'All DB queries must go through the service layer',
      why: 'Keeps business logic centralised',
      data: 'Observed in PR #42',
    },
    source: { taskId: 'task-001', sessionId: 'session-abc' },
  });

  assert('contracts .pending dir created by stageCandidate', fs.existsSync(pendingDirContract));
  assert('result has non-empty id', typeof contractResult.id === 'string' && contractResult.id.length > 0);
  assert('result has path string', typeof contractResult.path === 'string');
  assert('file exists at returned path', fs.existsSync(contractResult.path));

  // ── Test 4: stageCandidate — correct YAML frontmatter fields ─────────────
  console.log('\nTest 4: stageCandidate writes file with correct YAML frontmatter');
  const contractContent = fs.readFileSync(contractResult.path, 'utf8');

  assert('file starts with ---', contractContent.startsWith('---\n'));
  // The ID starts with a digit so the YAML serializer may quote it; check both forms
  assert(
    'frontmatter contains id field matching result.id',
    contractContent.includes(`id: ${contractResult.id}`) ||
      contractContent.includes(`id: "${contractResult.id}"`)
  );
  assert('frontmatter contains kind: contract', contractContent.includes('kind: contract'));
  assert('frontmatter contains area: architecture', contractContent.includes('area: architecture'));
  assert('frontmatter contains stagedAt field', /stagedAt: \S/.test(contractContent));
  assert('frontmatter contains source.taskId: task-001', contractContent.includes('taskId: task-001'));
  assert('frontmatter contains source.sessionId: session-abc', contractContent.includes('sessionId: session-abc'));
  assert('frontmatter contains evidence.rule', contractContent.includes('rule: All DB queries'));
  assert('frontmatter contains evidence.why', contractContent.includes('why: Keeps business logic'));

  // ── Test 5: stageCandidate — correct markdown body structure ─────────────
  console.log('\nTest 5: stageCandidate writes file with correct markdown body structure');
  assert('body contains ## ruleName heading', contractContent.includes('## No direct DB access from UI'));
  assert('body contains Rule: line', contractContent.includes('Rule: All DB queries must go through the service layer'));
  assert('body contains Why: line', contractContent.includes('Why: Keeps business logic centralised'));
  assert('body contains Where it bites: line', contractContent.includes('Where it bites: When adding a quick feature shortcut'));

  // ── Test 6: stageCandidate — standard kind ───────────────────────────────
  console.log('\nTest 6: stageCandidate with kind=\'standard\' (scenario 1 — standard)');
  const pendingDirStandard = path.join(tmpDir, 'docs', 'standards', '.pending');
  assert('standards .pending dir does not exist before call', !fs.existsSync(pendingDirStandard));

  const standardResult = stageCandidate({
    projectRoot: tmpDir,
    kind: 'standard',
    content: {
      ruleName: 'Use semantic versioning',
      rule: 'All packages must follow semver',
      why: 'Enables predictable dependency management',
      whereItBites: 'During release tagging',
      area: 'versioning',
    },
    evidence: {
      rule: 'All packages must follow semver',
      why: 'Enables predictable dependency management',
      data: '',
    },
    source: { taskId: null, sessionId: null },
  });

  assert('standards .pending dir created by stageCandidate', fs.existsSync(pendingDirStandard));
  assert('standard file exists at returned path', fs.existsSync(standardResult.path));

  const standardContent = fs.readFileSync(standardResult.path, 'utf8');
  assert('standard file has kind: standard', standardContent.includes('kind: standard'));
  assert('standard file has ## ruleName heading', standardContent.includes('## Use semantic versioning'));
  assert('standard file has Rule: line', standardContent.includes('Rule: All packages must follow semver'));
  assert('standard file has Why: line', standardContent.includes('Why: Enables predictable dependency management'));
  assert('standard file source.taskId is null', standardContent.includes('taskId: null'));
  assert('standard file source.sessionId is null', standardContent.includes('sessionId: null'));

  // ── Test 7: parseFrontmatter — TC1 well-formed file ─────────────────────
  console.log('\nTest 7: parseFrontmatter correctly parses a well-formed pending file (TC1)');
  const wellFormedFm = {
    id:       '2026-04-07T10-00-00-abcdef',
    kind:     'contract',
    area:     'architecture',
    stagedAt: '2026-04-07T10:00:00.000Z',
    source:   { taskId: 'task-001', sessionId: 'sess-abc' },
    evidence: { rule: 'Use service layer', why: 'Keeps logic central', data: 'observed in PR' },
  };
  const wellFormedContent = writeFrontmatter(wellFormedFm) + '\n## Title\n\nBody text.\n';
  const parsed1 = parseFrontmatter(wellFormedContent);
  assert('TC1: parseFrontmatter returns non-null for well-formed file', parsed1 !== null);
  assert('TC1: id matches', parsed1 !== null && parsed1.id === wellFormedFm.id);
  assert('TC1: kind matches', parsed1 !== null && parsed1.kind === wellFormedFm.kind);
  assert('TC1: area matches', parsed1 !== null && parsed1.area === wellFormedFm.area);
  assert('TC1: stagedAt matches', parsed1 !== null && parsed1.stagedAt === wellFormedFm.stagedAt);
  assert('TC1: source.taskId matches', parsed1 !== null && parsed1.source.taskId === wellFormedFm.source.taskId);
  assert('TC1: source.sessionId matches', parsed1 !== null && parsed1.source.sessionId === wellFormedFm.source.sessionId);
  assert('TC1: evidence.rule matches', parsed1 !== null && parsed1.evidence.rule === wellFormedFm.evidence.rule);
  assert('TC1: evidence.why matches', parsed1 !== null && parsed1.evidence.why === wellFormedFm.evidence.why);
  assert('TC1: evidence.data matches', parsed1 !== null && parsed1.evidence.data === wellFormedFm.evidence.data);
  assert('TC1: body is returned', parsed1 !== null && typeof parsed1.body === 'string' && parsed1.body.includes('## Title'));

  // ── Test 8: parseFrontmatter — TC2 missing opening --- ───────────────────
  console.log('\nTest 8: parseFrontmatter returns null for file missing opening --- (TC2)');
  const missingOpening = 'id: some-id\nkind: contract\n---\nbody\n';
  assert('TC2: returns null when opening --- is absent', parseFrontmatter(missingOpening) === null);

  // ── Test 9: parseFrontmatter — TC3 missing closing --- ───────────────────
  console.log('\nTest 9: parseFrontmatter returns null for file missing closing --- (TC3)');
  const missingClosing = '---\nid: some-id\nkind: contract\narea: \nstagedAt: 2026-04-07T10:00:00Z\nsource:\n  taskId: t\n  sessionId: s\nevidence:\n  rule: r\n  why: w\n  data: d\n';
  assert('TC3: returns null when closing --- is absent', parseFrontmatter(missingClosing) === null);

  // ── Test 10: parseFrontmatter — TC4 quoted YAML scalars ──────────────────
  console.log('\nTest 10: parseFrontmatter handles quoted YAML scalars (TC4)');
  // writeFrontmatter quotes ids that start with a digit
  const digitIdFm = {
    id:       '1abc-2026-04-07T10-00-00-abcdef',
    kind:     'standard',
    area:     'testing',
    stagedAt: '2026-04-07T10:00:00.000Z',
    source:   { taskId: 'task-001', sessionId: 'sess-xyz' },
    evidence: { rule: 'Write tests', why: 'Prevents regressions', data: '' },
  };
  const digitIdContent = writeFrontmatter(digitIdFm) + '\nbody\n';
  assert('TC4 setup: id is quoted in file', digitIdContent.includes(`id: "${digitIdFm.id}"`));
  const parsed4 = parseFrontmatter(digitIdContent);
  assert('TC4: parseFrontmatter returns non-null for quoted id', parsed4 !== null);
  assert('TC4: quoted id unquoted correctly', parsed4 !== null && parsed4.id === digitIdFm.id);

  // ── Test 11: parseFrontmatter — TC5 block scalar | for evidence.data ─────
  console.log('\nTest 11: parseFrontmatter handles block scalar | for evidence.data (TC5)');
  const multilineData = 'line one\nline two\nline three\n';
  const blockFm = {
    id:       'abc-2026-04-07T10-00-00-ffffff',
    kind:     'contract',
    area:     'backend',
    stagedAt: '2026-04-07T10:00:00.000Z',
    source:   { taskId: 'task-002', sessionId: 'sess-block' },
    evidence: { rule: 'No raw SQL', why: 'Prevents injection', data: multilineData },
  };
  const blockContent = writeFrontmatter(blockFm) + '\nbody\n';
  assert('TC5 setup: block scalar | present in file', blockContent.includes('  data: |'));
  const parsed5 = parseFrontmatter(blockContent);
  assert('TC5: parseFrontmatter returns non-null for block scalar', parsed5 !== null);
  assert('TC5: evidence.data matches multiline original', parsed5 !== null && parsed5.evidence.data === multilineData);

  // ── Test 12: parseFrontmatter — TC6 empty file ───────────────────────────
  console.log('\nTest 12: parseFrontmatter returns null for completely empty file (TC6)');
  assert('TC6: returns null for empty string', parseFrontmatter('') === null);
  assert('TC6: returns null for whitespace-only string', parseFrontmatter('   \n  \n') === null);

  // ── Test 13: listPending — TC1 returns empty array when .pending/ missing ──
  console.log('\nTest 13: listPending returns empty array when .pending/ directory does not exist (TC1)');
  const noDir = path.join(tmpDir, 'no-such-dir');
  const listResult1 = listPending(noDir, 'contract');
  assert('TC1: returns an array', Array.isArray(listResult1));
  assert('TC1: array is empty', listResult1.length === 0);

  // ── Test 14: listPending — TC5 .pending/ with no .md files ──────────────
  console.log('\nTest 14: listPending returns empty array when .pending/ has no .md files (TC5)');
  const emptyPendingDir = path.join(tmpDir, 'docs', 'empties', '.pending');
  fs.mkdirSync(emptyPendingDir, { recursive: true });
  fs.writeFileSync(path.join(emptyPendingDir, 'notes.txt'), 'some text', 'utf8');
  const listResult5 = listPending(tmpDir, 'empty');
  assert('TC5: returns an array', Array.isArray(listResult5));
  assert('TC5: array is empty when only non-.md files present', listResult5.length === 0);

  // ── Test 15: listPending — TC2 sorted by stagedAt ascending ─────────────
  console.log('\nTest 15: listPending returns candidates sorted by stagedAt ascending (TC2)');
  const sortPendingDir = path.join(tmpDir, 'docs', 'sorttests', '.pending');
  fs.mkdirSync(sortPendingDir, { recursive: true });

  const makeFm = (id, stagedAt) => ({
    id,
    kind: 'sorttest',
    area: 'test',
    stagedAt,
    source: { taskId: 'task-sort', sessionId: 'sess-sort' },
    evidence: { rule: 'r', why: 'w', data: 'd' },
  });

  const fm_newer = makeFm('newer-id', '2026-04-07T12:00:00.000Z');
  const fm_oldest = makeFm('oldest-id', '2026-04-06T08:00:00.000Z');
  const fm_middle = makeFm('middle-id', '2026-04-07T00:00:00.000Z');

  for (const [fname, fm] of [
    ['newer.md', fm_newer],
    ['oldest.md', fm_oldest],
    ['middle.md', fm_middle],
  ]) {
    const body = writeFrontmatter(fm) + '\n## Body\n\nContent.\n';
    fs.writeFileSync(path.join(sortPendingDir, fname), body, 'utf8');
  }

  const listResult2 = listPending(tmpDir, 'sorttest');
  assert('TC2: returns 3 entries', listResult2.length === 3);
  assert('TC2: first entry is oldest', listResult2[0].id === 'oldest-id');
  assert('TC2: second entry is middle', listResult2[1].id === 'middle-id');
  assert('TC2: third entry is newest', listResult2[2].id === 'newer-id');

  // ── Test 16: listPending — TC3 skips malformed files, warns stderr ────────
  console.log('\nTest 16: listPending skips malformed files and emits stderr warning (TC3)');
  const warnPendingDir = path.join(tmpDir, 'docs', 'warnkinds', '.pending');
  fs.mkdirSync(warnPendingDir, { recursive: true });

  // Good file
  const goodFm = makeFm('good-id', '2026-04-07T10:00:00.000Z');
  goodFm.kind = 'warnkind';
  fs.writeFileSync(
    path.join(warnPendingDir, 'good.md'),
    writeFrontmatter(goodFm) + '\n## Good\n',
    'utf8'
  );

  // Malformed file — no frontmatter at all
  fs.writeFileSync(
    path.join(warnPendingDir, 'malformed.md'),
    'This file has no frontmatter at all.\n',
    'utf8'
  );

  // Capture stderr to verify warning
  const stderrChunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrChunks.push(String(chunk));
    return origWrite(chunk, ...args);
  };

  const listResult3 = listPending(tmpDir, 'warnkind');

  process.stderr.write = origWrite; // restore

  assert('TC3: only good file in results', listResult3.length === 1);
  assert('TC3: good entry id matches', listResult3[0].id === 'good-id');
  const stderrOutput = stderrChunks.join('');
  assert('TC3: stderr warning mentions malformed.md', stderrOutput.includes('malformed.md'));

  // ── Test 17: listPending — TC4 correct shape of each entry ───────────────
  console.log('\nTest 17: listPending returns correct shape for each entry (TC4)');
  const shapePendingDir = path.join(tmpDir, 'docs', 'shapekinds', '.pending');
  fs.mkdirSync(shapePendingDir, { recursive: true });

  const shapeFm = {
    id: 'shape-id-abc',
    kind: 'shapekind',
    area: 'api',
    stagedAt: '2026-04-07T09:00:00.000Z',
    source: { taskId: 'task-shape', sessionId: 'sess-shape' },
    evidence: { rule: 'Always version APIs', why: 'Backward compat', data: 'see PR #99' },
  };
  const shapeBody = '## Shape Test\n\nRule: Always version APIs\n';
  fs.writeFileSync(
    path.join(shapePendingDir, 'shape.md'),
    writeFrontmatter(shapeFm) + '\n' + shapeBody,
    'utf8'
  );

  const listResult4 = listPending(tmpDir, 'shapekind');
  assert('TC4: returns one entry', listResult4.length === 1);
  const entry = listResult4[0];
  assert('TC4: entry has id', entry.id === 'shape-id-abc');
  assert('TC4: entry has path (string)', typeof entry.path === 'string' && entry.path.endsWith('shape.md'));
  assert('TC4: entry has kind', entry.kind === 'shapekind');
  assert('TC4: entry has area', entry.area === 'api');
  assert('TC4: entry has stagedAt', entry.stagedAt === '2026-04-07T09:00:00.000Z');
  assert('TC4: entry has content (markdown body)', typeof entry.content === 'string' && entry.content.includes('## Shape Test'));
  assert('TC4: entry.evidence has rule', entry.evidence.rule === 'Always version APIs');
  assert('TC4: entry.evidence has why', entry.evidence.why === 'Backward compat');
  assert('TC4: entry.evidence has data', entry.evidence.data === 'see PR #99');
  assert('TC4: entry.source has taskId', entry.source.taskId === 'task-shape');
  assert('TC4: entry.source has sessionId', entry.source.sessionId === 'sess-shape');

  // ── Test 18: promoteCandidate — TC1 creates new target file with H1 header ─
  console.log('\nTest 18: promoteCandidate creates new target file with H1 + body when file does not exist (TC1)');
  {
    const promoteTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-promote-'));
    try {
      // Set up a .pending file
      const promFm = {
        id: 'prom-id-tc1',
        kind: 'contract',
        area: 'backend',
        stagedAt: '2026-04-07T10:00:00.000Z',
        source: { taskId: 'task-prom', sessionId: 'sess-prom' },
        evidence: { rule: 'No raw SQL', why: 'Prevent injection', data: 'seen in PR #1' },
      };
      const promBody = '## No Raw SQL\n\nRule: No raw SQL\n';
      const pendingDir = path.join(promoteTmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const pendingFile = path.join(pendingDir, 'prom-id-tc1.md');
      fs.writeFileSync(pendingFile, writeFrontmatter(promFm) + '\n' + promBody, 'utf8');

      const targetPath = path.join(promoteTmp, 'docs', 'contracts', 'backend.md');
      assert('TC1 setup: target file does not exist yet', !fs.existsSync(targetPath));

      promoteCandidate({ projectRoot: promoteTmp, kind: 'contract', candidateId: 'prom-id-tc1' });

      assert('TC1: target file was created', fs.existsSync(targetPath));
      const content = fs.readFileSync(targetPath, 'utf8');
      assert('TC1: target file starts with H1 header', content.startsWith('# Contracts — backend'));
      assert('TC1: target file contains appended body', content.includes('## No Raw SQL'));
    } finally {
      fs.rmSync(promoteTmp, { recursive: true, force: true });
    }
  }

  // ── Test 19: promoteCandidate — TC2 appends body to existing file ──────────
  console.log('\nTest 19: promoteCandidate appends body to existing file without duplicating H1 (TC2)');
  {
    const promoteTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-promote-'));
    try {
      const targetDir = path.join(promoteTmp, 'docs', 'contracts');
      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, 'api.md');
      // Pre-create the target file with existing content
      fs.writeFileSync(targetPath, '# Contracts — api\n\n## Existing Rule\n\nSome content.\n', 'utf8');

      // Set up pending file
      const promFm = {
        id: 'prom-id-tc2',
        kind: 'contract',
        area: 'api',
        stagedAt: '2026-04-07T10:00:00.000Z',
        source: { taskId: 'task-prom2', sessionId: 'sess-prom2' },
        evidence: { rule: 'Version APIs', why: 'Backward compat', data: '' },
      };
      const promBody = '## Version APIs\n\nRule: Version APIs\n';
      const pendingDir = path.join(promoteTmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const pendingFile = path.join(pendingDir, 'prom-id-tc2.md');
      fs.writeFileSync(pendingFile, writeFrontmatter(promFm) + '\n' + promBody, 'utf8');

      promoteCandidate({ projectRoot: promoteTmp, kind: 'contract', candidateId: 'prom-id-tc2' });

      const content = fs.readFileSync(targetPath, 'utf8');
      const h1Count = (content.match(/^# Contracts — api/gm) || []).length;
      assert('TC2: H1 header appears exactly once (not duplicated)', h1Count === 1);
      assert('TC2: original content is preserved', content.includes('## Existing Rule'));
      assert('TC2: new body was appended', content.includes('## Version APIs'));
    } finally {
      fs.rmSync(promoteTmp, { recursive: true, force: true });
    }
  }

  // ── Test 20: promoteCandidate — TC3 removes the .pending source file ───────
  console.log('\nTest 20: promoteCandidate removes the .pending source file after promotion (TC3)');
  {
    const promoteTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-promote-'));
    try {
      const promFm = {
        id: 'prom-id-tc3',
        kind: 'standard',
        area: 'testing',
        stagedAt: '2026-04-07T10:00:00.000Z',
        source: { taskId: null, sessionId: null },
        evidence: { rule: 'Write tests', why: 'Prevent regressions', data: '' },
      };
      const promBody = '## Write Tests\n\nRule: Write tests\n';
      const pendingDir = path.join(promoteTmp, 'docs', 'standards', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const pendingFile = path.join(pendingDir, 'prom-id-tc3.md');
      fs.writeFileSync(pendingFile, writeFrontmatter(promFm) + '\n' + promBody, 'utf8');

      assert('TC3 setup: pending file exists before promotion', fs.existsSync(pendingFile));

      promoteCandidate({ projectRoot: promoteTmp, kind: 'standard', candidateId: 'prom-id-tc3' });

      assert('TC3: .pending file is removed after promotion', !fs.existsSync(pendingFile));
    } finally {
      fs.rmSync(promoteTmp, { recursive: true, force: true });
    }
  }

  // ── Test 21: promoteCandidate — TC4 returns { targetPath, candidateId } ────
  console.log('\nTest 21: promoteCandidate returns { targetPath, candidateId } with correct values (TC4)');
  {
    const promoteTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-promote-'));
    try {
      const promFm = {
        id: 'prom-id-tc4',
        kind: 'contract',
        area: 'data',
        stagedAt: '2026-04-07T10:00:00.000Z',
        source: { taskId: 'task-tc4', sessionId: 'sess-tc4' },
        evidence: { rule: 'Validate input', why: 'Security', data: '' },
      };
      const promBody = '## Validate Input\n\nRule: Validate input\n';
      const pendingDir = path.join(promoteTmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const pendingFile = path.join(pendingDir, 'prom-id-tc4.md');
      fs.writeFileSync(pendingFile, writeFrontmatter(promFm) + '\n' + promBody, 'utf8');

      const result = promoteCandidate({ projectRoot: promoteTmp, kind: 'contract', candidateId: 'prom-id-tc4' });

      assert('TC4: result has targetPath property', typeof result.targetPath === 'string');
      assert('TC4: result has candidateId property', result.candidateId === 'prom-id-tc4');
      const expectedTargetPath = path.join(promoteTmp, 'docs', 'contracts', 'data.md');
      assert('TC4: targetPath points to docs/<kind>s/<area>.md', result.targetPath === expectedTargetPath);
    } finally {
      fs.rmSync(promoteTmp, { recursive: true, force: true });
    }
  }

  // ── Test 22: resolveTargetPath — TC1 returns docs/contracts/<area>.md ──────
  console.log('\nTest 22: resolveTargetPath returns docs/contracts/<area>.md for kind=contract (TC1)');
  {
    const rtpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-rtp-'));
    try {
      const fm = { kind: 'contract', area: 'backend' };
      const result = resolveTargetPath(rtpTmp, fm);
      const expected = path.join(rtpTmp, 'docs', 'contracts', 'backend.md');
      assert('TC1: resolveTargetPath returns docs/contracts/<area>.md', result === expected);
    } finally {
      fs.rmSync(rtpTmp, { recursive: true, force: true });
    }
  }

  // ── Test 23: resolveTargetPath — TC2 returns docs/standards/<area>.md ──────
  console.log('\nTest 23: resolveTargetPath returns docs/standards/<area>.md for kind=standard (TC2)');
  {
    const rtpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-rtp-'));
    try {
      const fm = { kind: 'standard', area: 'versioning' };
      const result = resolveTargetPath(rtpTmp, fm);
      const expected = path.join(rtpTmp, 'docs', 'standards', 'versioning.md');
      assert('TC2: resolveTargetPath returns docs/standards/<area>.md', result === expected);
    } finally {
      fs.rmSync(rtpTmp, { recursive: true, force: true });
    }
  }

  // ── Test 24: resolveTargetPath — TC3 falls back to 'general.md' ────────────
  console.log('\nTest 24: resolveTargetPath falls back to general.md when area is empty (TC3)');
  {
    const rtpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-rtp-'));
    try {
      const fmEmpty = { kind: 'contract', area: '' };
      const resultEmpty = resolveTargetPath(rtpTmp, fmEmpty);
      const expectedEmpty = path.join(rtpTmp, 'docs', 'contracts', 'general.md');
      assert('TC3: empty area falls back to general.md', resultEmpty === expectedEmpty);

      const fmNull = { kind: 'contract', area: null };
      const resultNull = resolveTargetPath(rtpTmp, fmNull);
      assert('TC3: null area falls back to general.md', resultNull === expectedEmpty);

      const fmMissing = { kind: 'contract' };
      const resultMissing = resolveTargetPath(rtpTmp, fmMissing);
      assert('TC3: missing area falls back to general.md', resultMissing === expectedEmpty);
    } finally {
      fs.rmSync(rtpTmp, { recursive: true, force: true });
    }
  }

  // ── Test 25: resolveTargetPath — TC4 creates parent directory if missing ───
  console.log('\nTest 25: resolveTargetPath creates parent directory if missing (TC4)');
  {
    const rtpTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-rtp-'));
    try {
      const fm = { kind: 'contract', area: 'api' };
      const parentDir = path.join(rtpTmp, 'docs', 'contracts');
      assert('TC4 setup: parent dir does not exist before call', !fs.existsSync(parentDir));
      resolveTargetPath(rtpTmp, fm);
      assert('TC4: parent directory was created', fs.existsSync(parentDir));
    } finally {
      fs.rmSync(rtpTmp, { recursive: true, force: true });
    }
  }

  // ── Test 26: promoteCandidate idempotency — TC1 / TC2 / TC3 ─────────────
  // Scenario A: second call is a no-op because the pending file was already
  // removed by the first promotion.
  console.log('\nTest 26: promoteCandidate idempotency — no duplicate when called twice (TC1/TC2/TC3 scenario A)');
  {
    const promoteTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-idem-'));
    try {
      const idemFm = {
        id: 'idem-id-a',
        kind: 'contract',
        area: 'idem',
        stagedAt: '2026-04-07T10:00:00.000Z',
        source: { taskId: 'task-idem', sessionId: 'sess-idem' },
        evidence: { rule: 'No duplicates', why: 'Correctness', data: '' },
      };
      const idemBody = '## No Duplicates\n\nRule: No duplicates\n\nWhy: Correctness\n\nWhere it bites: Always\n';
      const pendingDir = path.join(promoteTmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const pendingFile = path.join(pendingDir, 'idem-id-a.md');
      fs.writeFileSync(pendingFile, writeFrontmatter(idemFm) + '\n' + idemBody, 'utf8');

      // First promotion
      const result1 = promoteCandidate({ projectRoot: promoteTmp, kind: 'contract', candidateId: 'idem-id-a' });
      assert('TC1/A: first promotion returns targetPath', typeof result1.targetPath === 'string');

      // TC2: pending file removed after first promotion
      assert('TC2/A: pending file removed after first promotion', !fs.existsSync(pendingFile));

      // Second promotion — pending file already gone, should be a no-op (not throw)
      let secondCallError = null;
      let result2;
      try {
        result2 = promoteCandidate({ projectRoot: promoteTmp, kind: 'contract', candidateId: 'idem-id-a' });
      } catch (err) {
        secondCallError = err;
      }
      assert('TC1/A: second promoteCandidate call does not throw', secondCallError === null);

      // TC2: pending file still absent (or was already gone — either way, no error)
      assert('TC2/A: pending file still absent after second call', !fs.existsSync(pendingFile));

      // TC3: target file has exactly one copy of the body heading
      const targetContent = fs.readFileSync(result1.targetPath, 'utf8');
      const headingCount = (targetContent.match(/## No Duplicates/g) || []).length;
      assert('TC3/A: target file has exactly one copy of the candidate heading', headingCount === 1);

      // TC1: idempotency marker appears exactly once
      const markerCount = (targetContent.match(/<!-- candidate:idem-id-a -->/g) || []).length;
      assert('TC1/A: idempotency marker appears exactly once in target', markerCount === 1);
    } finally {
      fs.rmSync(promoteTmp, { recursive: true, force: true });
    }
  }

  // ── Test 27: promoteCandidate idempotency — TC1 / TC2 / TC3 ─────────────
  // Scenario B: pending file is re-created after first promotion (simulating a
  // re-queue scenario).  The marker in the target file should prevent duplication.
  console.log('\nTest 27: promoteCandidate idempotency — marker prevents duplicate when pending re-created (TC1/TC2/TC3 scenario B)');
  {
    const promoteTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-idem-b-'));
    try {
      const idemFm = {
        id: 'idem-id-b',
        kind: 'contract',
        area: 'idem',
        stagedAt: '2026-04-07T10:00:00.000Z',
        source: { taskId: 'task-idem-b', sessionId: 'sess-idem-b' },
        evidence: { rule: 'No duplicates B', why: 'Correctness', data: '' },
      };
      const idemBody = '## No Duplicates B\n\nRule: No duplicates B\n\nWhy: Correctness\n\nWhere it bites: On re-queue\n';
      const pendingDir = path.join(promoteTmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const pendingFile = path.join(pendingDir, 'idem-id-b.md');

      // Write the pending file and promote once
      fs.writeFileSync(pendingFile, writeFrontmatter(idemFm) + '\n' + idemBody, 'utf8');
      const result1 = promoteCandidate({ projectRoot: promoteTmp, kind: 'contract', candidateId: 'idem-id-b' });

      // Re-create the same pending file (simulate a re-queue)
      fs.writeFileSync(pendingFile, writeFrontmatter(idemFm) + '\n' + idemBody, 'utf8');
      assert('TC2/B setup: pending file re-created', fs.existsSync(pendingFile));

      // Second promotion — marker should prevent appending a second copy
      promoteCandidate({ projectRoot: promoteTmp, kind: 'contract', candidateId: 'idem-id-b' });

      // TC2: pending file removed by second promotion
      assert('TC2/B: pending file removed after second promotion', !fs.existsSync(pendingFile));

      // TC3: target has exactly one copy of the candidate heading
      const targetContent = fs.readFileSync(result1.targetPath, 'utf8');
      const headingCount = (targetContent.match(/## No Duplicates B/g) || []).length;
      assert('TC3/B: target file has exactly one copy of the candidate heading', headingCount === 1);

      // TC1: marker appears exactly once
      const markerCount = (targetContent.match(/<!-- candidate:idem-id-b -->/g) || []).length;
      assert('TC1/B: idempotency marker appears exactly once in target', markerCount === 1);
    } finally {
      fs.rmSync(promoteTmp, { recursive: true, force: true });
    }
  }

  // ── Test 28: append spacing TC1 — file with no trailing newline ─────────
  console.log('\nTest 28: promoteCandidate spacing TC1 — file ending with no newline produces blank-line separator');
  {
    const promoteTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-spacing-'));
    try {
      const targetDir = path.join(promoteTmp, 'docs', 'contracts');
      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, 'spacing.md');
      // Write a file with NO trailing newline
      fs.writeFileSync(targetPath, '# Contracts — spacing\n\n## Existing Rule\n\nSome content.', 'utf8');

      const spacingFm = {
        id: 'spacing-tc1',
        kind: 'contract',
        area: 'spacing',
        stagedAt: '2026-04-07T11:00:00.000Z',
        source: { taskId: null, sessionId: null },
        evidence: { rule: 'TC1 Rule', why: 'TC1 Why', data: '' },
      };
      const spacingBody = '## TC1 Section\n\nContent.\n';
      const pendingDir = path.join(promoteTmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.writeFileSync(
        path.join(pendingDir, 'spacing-tc1.md'),
        writeFrontmatter(spacingFm) + '\n' + spacingBody,
        'utf8'
      );

      promoteCandidate({ projectRoot: promoteTmp, kind: 'contract', candidateId: 'spacing-tc1' });

      const content = fs.readFileSync(targetPath, 'utf8');
      // There must be a blank line (two consecutive newlines) before the marker
      assert('TC1: blank line separator exists before appended section', content.includes('\n\n<!-- candidate:spacing-tc1 -->'));
      assert('TC1: existing content preserved', content.includes('## Existing Rule'));
      assert('TC1: new section appended', content.includes('## TC1 Section'));
    } finally {
      fs.rmSync(promoteTmp, { recursive: true, force: true });
    }
  }

  // ── Test 29: append spacing TC2 — file with multiple trailing newlines ───
  console.log('\nTest 29: promoteCandidate spacing TC2 — multiple trailing newlines normalise to single blank-line separator');
  {
    const promoteTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-spacing-'));
    try {
      const targetDir = path.join(promoteTmp, 'docs', 'contracts');
      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, 'spacing.md');
      // Write a file with THREE trailing newlines
      fs.writeFileSync(targetPath, '# Contracts — spacing\n\n## Existing Rule\n\nSome content.\n\n\n', 'utf8');

      const spacingFm = {
        id: 'spacing-tc2',
        kind: 'contract',
        area: 'spacing',
        stagedAt: '2026-04-07T11:00:00.000Z',
        source: { taskId: null, sessionId: null },
        evidence: { rule: 'TC2 Rule', why: 'TC2 Why', data: '' },
      };
      const spacingBody = '## TC2 Section\n\nContent.\n';
      const pendingDir = path.join(promoteTmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.writeFileSync(
        path.join(pendingDir, 'spacing-tc2.md'),
        writeFrontmatter(spacingFm) + '\n' + spacingBody,
        'utf8'
      );

      promoteCandidate({ projectRoot: promoteTmp, kind: 'contract', candidateId: 'spacing-tc2' });

      const content = fs.readFileSync(targetPath, 'utf8');
      // Must NOT have more than two consecutive newlines before the marker
      assert('TC2: no more than one blank line before appended section', !content.includes('\n\n\n<!-- candidate:spacing-tc2 -->'));
      assert('TC2: exactly one blank line before appended section', content.includes('\n\n<!-- candidate:spacing-tc2 -->'));
      assert('TC2: new section appended', content.includes('## TC2 Section'));
    } finally {
      fs.rmSync(promoteTmp, { recursive: true, force: true });
    }
  }

  // ── Test 30: append spacing TC3 — final file ends with exactly one newline
  console.log('\nTest 30: promoteCandidate spacing TC3 — final file always ends with exactly one trailing newline');
  {
    const promoteTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-spacing-'));
    try {
      const targetDir = path.join(promoteTmp, 'docs', 'contracts');
      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, 'spacing.md');
      fs.writeFileSync(targetPath, '# Contracts — spacing\n\n## Existing Rule\n\nContent.\n', 'utf8');

      const spacingFm = {
        id: 'spacing-tc3',
        kind: 'contract',
        area: 'spacing',
        stagedAt: '2026-04-07T11:00:00.000Z',
        source: { taskId: null, sessionId: null },
        evidence: { rule: 'TC3 Rule', why: 'TC3 Why', data: '' },
      };
      // Body that ends with multiple newlines — should be normalised
      const spacingBody = '## TC3 Section\n\nContent.\n\n\n';
      const pendingDir = path.join(promoteTmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.writeFileSync(
        path.join(pendingDir, 'spacing-tc3.md'),
        writeFrontmatter(spacingFm) + '\n' + spacingBody,
        'utf8'
      );

      promoteCandidate({ projectRoot: promoteTmp, kind: 'contract', candidateId: 'spacing-tc3' });

      const content = fs.readFileSync(targetPath, 'utf8');
      assert('TC3: file ends with exactly one trailing newline', content.endsWith('\n') && !content.endsWith('\n\n'));
    } finally {
      fs.rmSync(promoteTmp, { recursive: true, force: true });
    }
  }

  // ── Test 31: append spacing TC4 — multiple promotions produce well-separated sections
  console.log('\nTest 31: promoteCandidate spacing TC4 — multiple promotions produce well-separated sections');
  {
    const promoteTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-spacing-'));
    try {
      const pendingDir = path.join(promoteTmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });

      const makePending = (id, section) => {
        const fm = {
          id,
          kind: 'contract',
          area: 'multi',
          stagedAt: `2026-04-07T${section}:00:00.000Z`,
          source: { taskId: null, sessionId: null },
          evidence: { rule: `Rule ${section}`, why: `Why ${section}`, data: '' },
        };
        const body = `## Section ${section}\n\nContent for section ${section}.\n`;
        fs.writeFileSync(
          path.join(pendingDir, `${id}.md`),
          writeFrontmatter(fm) + '\n' + body,
          'utf8'
        );
      };

      makePending('multi-tc4-a', '10');
      makePending('multi-tc4-b', '11');
      makePending('multi-tc4-c', '12');

      promoteCandidate({ projectRoot: promoteTmp, kind: 'contract', candidateId: 'multi-tc4-a' });
      promoteCandidate({ projectRoot: promoteTmp, kind: 'contract', candidateId: 'multi-tc4-b' });
      promoteCandidate({ projectRoot: promoteTmp, kind: 'contract', candidateId: 'multi-tc4-c' });

      const targetPath = path.join(promoteTmp, 'docs', 'contracts', 'multi.md');
      const content = fs.readFileSync(targetPath, 'utf8');

      assert('TC4: all three sections present', content.includes('## Section 10') && content.includes('## Section 11') && content.includes('## Section 12'));
      assert('TC4: blank line before section A marker', content.includes('\n\n<!-- candidate:multi-tc4-a -->'));
      assert('TC4: blank line before section B marker', content.includes('\n\n<!-- candidate:multi-tc4-b -->'));
      assert('TC4: blank line before section C marker', content.includes('\n\n<!-- candidate:multi-tc4-c -->'));
      // No triple newlines anywhere (no excess blank lines)
      assert('TC4: no triple consecutive newlines', !content.includes('\n\n\n'));
      assert('TC4: file ends with exactly one trailing newline', content.endsWith('\n') && !content.endsWith('\n\n'));
    } finally {
      fs.rmSync(promoteTmp, { recursive: true, force: true });
    }
  }

  // ── Test 32: declineCandidate — TC1 removes the pending file ─────────────
  console.log('\nTest 32: declineCandidate removes the pending file from docs/<kind>s/.pending/ (TC1)');
  {
    const declineTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-decline-'));
    try {
      const pendingDir = path.join(declineTmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const fm = {
        id: 'decline-tc1',
        kind: 'contract',
        area: 'api',
        stagedAt: '2026-04-07T10:00:00.000Z',
        source: { taskId: 'task-001', sessionId: 'sess-001' },
        evidence: { rule: 'Never expose secrets', why: 'Security', data: 'see audit' },
      };
      const pendingFile = path.join(pendingDir, 'decline-tc1.md');
      fs.writeFileSync(pendingFile, writeFrontmatter(fm) + '\n## Never expose secrets\n', 'utf8');
      assert('TC1 setup: pending file exists', fs.existsSync(pendingFile));

      declineCandidate({ projectRoot: declineTmp, kind: 'contract', candidateId: 'decline-tc1', reason: 'Not relevant' });

      assert('TC1: pending file has been removed', !fs.existsSync(pendingFile));
    } finally {
      fs.rmSync(declineTmp, { recursive: true, force: true });
    }
  }

  // ── Test 33: declineCandidate — TC2 lazily creates .harness/staging/ ─────
  console.log('\nTest 33: declineCandidate creates .harness/staging/ lazily if it does not exist (TC2)');
  {
    const declineTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-decline-'));
    try {
      const pendingDir = path.join(declineTmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const fm = {
        id: 'decline-tc2',
        kind: 'contract',
        area: 'api',
        stagedAt: '2026-04-07T10:00:00.000Z',
        source: { taskId: 'task-002', sessionId: 'sess-002' },
        evidence: { rule: 'Log all errors', why: 'Observability', data: 'see logs' },
      };
      const pendingFile = path.join(pendingDir, 'decline-tc2.md');
      fs.writeFileSync(pendingFile, writeFrontmatter(fm) + '\n## Log all errors\n', 'utf8');

      const stagingDir = path.join(declineTmp, '.harness', 'staging');
      assert('TC2 setup: .harness/staging does not exist yet', !fs.existsSync(stagingDir));

      declineCandidate({ projectRoot: declineTmp, kind: 'contract', candidateId: 'decline-tc2', reason: 'Duplicate' });

      assert('TC2: .harness/staging/ was created', fs.existsSync(stagingDir));
    } finally {
      fs.rmSync(declineTmp, { recursive: true, force: true });
    }
  }

  // ── Test 34: declineCandidate — TC3 appends valid JSON record with correct fields
  console.log('\nTest 34: declineCandidate appends a valid JSON record to declined.jsonl with correct fields (TC3)');
  {
    const declineTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-decline-'));
    try {
      const pendingDir = path.join(declineTmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const fm = {
        id: 'decline-tc3',
        kind: 'contract',
        area: 'security',
        stagedAt: '2026-04-07T10:00:00.000Z',
        source: { taskId: 'task-003', sessionId: 'sess-003' },
        evidence: { rule: 'Validate inputs', why: 'Prevent injection', data: 'see PR #7' },
      };
      const pendingFile = path.join(pendingDir, 'decline-tc3.md');
      fs.writeFileSync(pendingFile, writeFrontmatter(fm) + '\n## Validate inputs\n', 'utf8');

      const { declinedPath } = declineCandidate({ projectRoot: declineTmp, kind: 'contract', candidateId: 'decline-tc3', reason: 'Out of scope' });

      assert('TC3: declinedPath points to declined.jsonl', declinedPath.endsWith('declined.jsonl'));
      assert('TC3: declined.jsonl was created', fs.existsSync(declinedPath));

      const lines = fs.readFileSync(declinedPath, 'utf8').trim().split('\n');
      assert('TC3: exactly one line in declined.jsonl', lines.length === 1);

      const record = JSON.parse(lines[0]);
      assert('TC3: record.id matches candidateId', record.id === 'decline-tc3');
      assert('TC3: record.kind is correct', record.kind === 'contract');
      assert('TC3: record.area is correct', record.area === 'security');
      assert('TC3: record.reason is correct', record.reason === 'Out of scope');
      assert('TC3: record.declinedAt is an ISO string', typeof record.declinedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(record.declinedAt));
      assert('TC3: record.source.taskId is correct', record.source.taskId === 'task-003');
      assert('TC3: record.source.sessionId is correct', record.source.sessionId === 'sess-003');
      assert('TC3: record.contentHash is a 16-char hex string', typeof record.contentHash === 'string' && /^[0-9a-f]{16}$/.test(record.contentHash));
      // Verify contentHash matches what contentHash() would produce
      const expectedHash = contentHash({ rule: 'Validate inputs', why: 'Prevent injection' });
      assert('TC3: record.contentHash value is correct', record.contentHash === expectedHash);
    } finally {
      fs.rmSync(declineTmp, { recursive: true, force: true });
    }
  }

  // ── Test 35: declineCandidate — TC4 idempotent (second call does not throw)
  console.log('\nTest 35: declineCandidate is idempotent — calling twice for same candidateId does not throw (TC4)');
  {
    const declineTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-decline-'));
    try {
      const pendingDir = path.join(declineTmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const fm = {
        id: 'decline-tc4',
        kind: 'contract',
        area: 'auth',
        stagedAt: '2026-04-07T10:00:00.000Z',
        source: { taskId: 'task-004', sessionId: 'sess-004' },
        evidence: { rule: 'Use HTTPS', why: 'Encryption', data: '' },
      };
      const pendingFile = path.join(pendingDir, 'decline-tc4.md');
      fs.writeFileSync(pendingFile, writeFrontmatter(fm) + '\n## Use HTTPS\n', 'utf8');

      // First call — normal decline
      declineCandidate({ projectRoot: declineTmp, kind: 'contract', candidateId: 'decline-tc4', reason: 'Already done' });
      assert('TC4: pending file removed after first call', !fs.existsSync(pendingFile));

      // Second call — file already gone, must not throw
      let threw = false;
      try {
        declineCandidate({ projectRoot: declineTmp, kind: 'contract', candidateId: 'decline-tc4', reason: 'Already done' });
      } catch (e) {
        threw = true;
      }
      assert('TC4: second call does not throw', !threw);
    } finally {
      fs.rmSync(declineTmp, { recursive: true, force: true });
    }
  }

  // ── Test 36: declineCandidate — TC5 multiple declines append multiple lines
  console.log('\nTest 36: multiple declines append multiple lines to declined.jsonl (TC5)');
  {
    const declineTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-decline-'));
    try {
      const pendingDir = path.join(declineTmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });

      const makePendingFile = (id, rule, why) => {
        const fm = {
          id,
          kind: 'contract',
          area: 'general',
          stagedAt: '2026-04-07T10:00:00.000Z',
          source: { taskId: `task-${id}`, sessionId: `sess-${id}` },
          evidence: { rule, why, data: '' },
        };
        fs.writeFileSync(
          path.join(pendingDir, `${id}.md`),
          writeFrontmatter(fm) + `\n## ${rule}\n`,
          'utf8'
        );
      };

      makePendingFile('decline-tc5-a', 'Rule Alpha', 'Why Alpha');
      makePendingFile('decline-tc5-b', 'Rule Beta', 'Why Beta');
      makePendingFile('decline-tc5-c', 'Rule Gamma', 'Why Gamma');

      declineCandidate({ projectRoot: declineTmp, kind: 'contract', candidateId: 'decline-tc5-a', reason: 'Too vague' });
      declineCandidate({ projectRoot: declineTmp, kind: 'contract', candidateId: 'decline-tc5-b', reason: 'Duplicate' });
      declineCandidate({ projectRoot: declineTmp, kind: 'contract', candidateId: 'decline-tc5-c', reason: 'Out of scope' });

      const declinedPath = path.join(declineTmp, '.harness', 'staging', 'declined.jsonl');
      const raw = fs.readFileSync(declinedPath, 'utf8');
      const lines = raw.trim().split('\n').filter(l => l.trim() !== '');
      assert('TC5: declined.jsonl has exactly 3 lines', lines.length === 3);

      const ids = lines.map(l => JSON.parse(l).id);
      assert('TC5: first record id is decline-tc5-a', ids[0] === 'decline-tc5-a');
      assert('TC5: second record id is decline-tc5-b', ids[1] === 'decline-tc5-b');
      assert('TC5: third record id is decline-tc5-c', ids[2] === 'decline-tc5-c');

      // Each line must be valid standalone JSON
      let allValid = true;
      for (const line of lines) {
        try { JSON.parse(line); } catch { allValid = false; }
      }
      assert('TC5: each line is valid JSON', allValid);
    } finally {
      fs.rmSync(declineTmp, { recursive: true, force: true });
    }
  }

  // ── isDeclined tests ─────────────────────────────────────────────────────
  console.log('\nTest: isDeclined');
  {
    const idTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-isdeclined-'));
    try {
      const source = { phase: 'phase-A', taskId: 'task-001' };
      const hash = 'abc123def456abcd';

      // TC1: returns false when declined.jsonl does not exist
      const result1 = isDeclined({ projectRoot: idTmp, source, contentHash: hash });
      assert('TC1: isDeclined returns false when declined.jsonl does not exist', result1 === false);

      // Set up declined.jsonl with a matching record
      const stagingDir = path.join(idTmp, '.harness', 'staging');
      fs.mkdirSync(stagingDir, { recursive: true });
      const declinedPath = path.join(stagingDir, 'declined.jsonl');

      const matchingRecord = JSON.stringify({
        id: 'some-id',
        source: { phase: 'phase-A', taskId: 'task-001' },
        contentHash: 'abc123def456abcd',
      });
      fs.writeFileSync(declinedPath, matchingRecord + '\n', 'utf8');

      // TC2: returns true when a matching source.phase + source.taskId + contentHash exists
      const result2 = isDeclined({ projectRoot: idTmp, source, contentHash: hash });
      assert('TC2: isDeclined returns true when matching record exists', result2 === true);

      // TC3: returns false when source.phase matches but contentHash differs
      const result3 = isDeclined({ projectRoot: idTmp, source, contentHash: 'different-hash-xxx' });
      assert('TC3: isDeclined returns false when contentHash differs', result3 === false);

      // TC4: returns false when contentHash matches but source.taskId differs
      const differentSource = { phase: 'phase-A', taskId: 'task-999' };
      const result4 = isDeclined({ projectRoot: idTmp, source: differentSource, contentHash: hash });
      assert('TC4: isDeclined returns false when source.taskId differs', result4 === false);

      // TC5: gracefully skips malformed lines
      const mixedContent =
        'not-valid-json\n' +
        '{"broken": }\n' +
        JSON.stringify({ id: 'x', source: { phase: 'phase-A', taskId: 'task-001' }, contentHash: 'abc123def456abcd' }) + '\n';
      fs.writeFileSync(declinedPath, mixedContent, 'utf8');

      let noThrow = true;
      let result5 = false;
      try {
        result5 = isDeclined({ projectRoot: idTmp, source, contentHash: hash });
      } catch {
        noThrow = false;
      }
      assert('TC5: isDeclined does not throw on malformed lines', noThrow);
      assert('TC5: isDeclined still finds valid matching record after malformed lines', result5 === true);

    } finally {
      fs.rmSync(idTmp, { recursive: true, force: true });
    }
  }

  // ── Tests 37a-37d: isDeclined — full integration using stageCandidate + declineCandidate ──
  //
  // TC1: isDeclined returns true for previously declined candidate
  // TC2: isDeclined returns false for non-existent declined.jsonl
  // TC3: isDeclined returns false for mismatched contentHash or taskId
  // TC4: isDeclined handles malformed lines gracefully
  console.log('\nTest 37a–37d: isDeclined integration tests (TC1 / TC2 / TC3 / TC4)');
  {
    const isDeclinedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-isdeclined-int-'));
    try {
      // TC2: isDeclined returns false when declined.jsonl does not exist yet
      const evidenceRule = 'Never store plaintext passwords';
      const evidenceWhy = 'Security: credential exposure';
      const expectedContentHash = contentHash({ rule: evidenceRule, why: evidenceWhy });
      const tc2Result = isDeclined({
        projectRoot: isDeclinedTmp,
        source: { taskId: 'task-isdeclined-001' },
        contentHash: expectedContentHash,
      });
      assert('TC2: isDeclined returns false when declined.jsonl does not exist', tc2Result === false);

      // Stage a candidate so declineCandidate() has something to work with
      const staged = stageCandidate({
        projectRoot: isDeclinedTmp,
        kind: 'contract',
        content: {
          ruleName: 'Never store plaintext passwords',
          rule: evidenceRule,
          why: evidenceWhy,
          whereItBites: 'During user registration',
          area: 'security',
        },
        evidence: {
          rule: evidenceRule,
          why: evidenceWhy,
          data: 'Found in onboarding service',
        },
        source: { taskId: 'task-isdeclined-001', sessionId: 'sess-isdeclined-001' },
      });

      assert('TC1 setup: staged candidate file exists', fs.existsSync(staged.path));

      // Decline the candidate — this writes to declined.jsonl
      declineCandidate({
        projectRoot: isDeclinedTmp,
        kind: 'contract',
        candidateId: staged.id,
        reason: 'Already enforced by framework',
      });

      // TC1: isDeclined returns true for matching source + contentHash
      const tc1Result = isDeclined({
        projectRoot: isDeclinedTmp,
        source: { taskId: 'task-isdeclined-001' },
        contentHash: expectedContentHash,
      });
      assert('TC1: isDeclined returns true for previously declined candidate (matching source+contentHash)', tc1Result === true);

      // TC3a: isDeclined returns false when contentHash does not match
      const tc3aResult = isDeclined({
        projectRoot: isDeclinedTmp,
        source: { taskId: 'task-isdeclined-001' },
        contentHash: 'deadbeef00000000',
      });
      assert('TC3: isDeclined returns false when contentHash does not match', tc3aResult === false);

      // TC3b: isDeclined returns false when taskId does not match
      const tc3bResult = isDeclined({
        projectRoot: isDeclinedTmp,
        source: { taskId: 'task-isdeclined-WRONG' },
        contentHash: expectedContentHash,
      });
      assert('TC3: isDeclined returns false when taskId does not match', tc3bResult === false);

      // TC4: isDeclined handles malformed lines gracefully (no throw, still finds valid match)
      const declinedFilePath = path.join(isDeclinedTmp, '.harness', 'staging', 'declined.jsonl');
      const existingContent = fs.readFileSync(declinedFilePath, 'utf8');
      // Prepend malformed lines
      const malformedContent =
        'not-valid-json\n' +
        '{"broken": }\n' +
        existingContent;
      fs.writeFileSync(declinedFilePath, malformedContent, 'utf8');

      let tc4NoThrow = true;
      let tc4Result = false;
      try {
        tc4Result = isDeclined({
          projectRoot: isDeclinedTmp,
          source: { taskId: 'task-isdeclined-001' },
          contentHash: expectedContentHash,
        });
      } catch {
        tc4NoThrow = false;
      }
      assert('TC4: isDeclined does not throw when declined.jsonl has malformed lines', tc4NoThrow);
      assert('TC4: isDeclined still returns true after skipping malformed lines', tc4Result === true);

    } finally {
      fs.rmSync(isDeclinedTmp, { recursive: true, force: true });
    }
  }

  // ── Test 37: declineCandidate — TC1 removes pending file and appends to declined.jsonl ──
  // Uses stageCandidate() to create the candidate, then declineCandidate() to decline it.
  console.log('\nTest 37: declineCandidate removes pending file and appends to declined.jsonl (TC1)');
  {
    const declineTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-decline-tc1-'));
    try {
      // Stage a candidate via stageCandidate()
      const staged = stageCandidate({
        projectRoot: declineTmp,
        kind: 'contract',
        content: {
          ruleName: 'No hardcoded credentials',
          rule: 'Never hardcode secrets in source code',
          why: 'Prevents credential leaks',
          whereItBites: 'During quick prototyping',
          area: 'security',
        },
        evidence: {
          rule: 'Never hardcode secrets in source code',
          why: 'Prevents credential leaks',
          data: 'Found in PR #55',
        },
        source: { taskId: 'task-tc1', sessionId: 'sess-tc1' },
      });

      assert('TC1 setup: staged candidate file exists', fs.existsSync(staged.path));

      // Decline the staged candidate
      const { declinedPath } = declineCandidate({
        projectRoot: declineTmp,
        kind: 'contract',
        candidateId: staged.id,
        reason: 'Policy already covered elsewhere',
      });

      // Verify pending file was removed
      assert('TC1: pending file has been removed after decline', !fs.existsSync(staged.path));

      // Verify declined.jsonl was created
      const stagingDir = path.join(declineTmp, '.harness', 'staging');
      assert('TC1: .harness/staging/ directory exists', fs.existsSync(stagingDir));
      assert('TC1: declined.jsonl exists', fs.existsSync(declinedPath));
      assert('TC1: declinedPath ends with declined.jsonl', declinedPath.endsWith('declined.jsonl'));

      // Verify the appended JSON record has the correct shape
      const raw = fs.readFileSync(declinedPath, 'utf8').trim();
      const lines = raw.split('\n').filter(l => l.trim() !== '');
      assert('TC1: exactly one line appended to declined.jsonl', lines.length === 1);

      const record = JSON.parse(lines[0]);
      assert('TC1: record.id matches staged candidate id', record.id === staged.id);
      assert('TC1: record.kind is correct', record.kind === 'contract');
      assert('TC1: record.area is correct', record.area === 'security');
      assert('TC1: record.reason is correct', record.reason === 'Policy already covered elsewhere');
      assert('TC1: record.declinedAt is present and is an ISO string', typeof record.declinedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(record.declinedAt));
      assert('TC1: record.source is an object', record.source !== null && typeof record.source === 'object');
      assert('TC1: record.source.taskId is correct', record.source.taskId === 'task-tc1');
      assert('TC1: record.source.sessionId is correct', record.source.sessionId === 'sess-tc1');
      assert('TC1: record.contentHash is a 16-char hex string', typeof record.contentHash === 'string' && /^[0-9a-f]{16}$/.test(record.contentHash));
      // Verify contentHash value matches what contentHash() would produce for this evidence
      const expectedHash = contentHash({ rule: 'Never hardcode secrets in source code', why: 'Prevents credential leaks' });
      assert('TC1: record.contentHash value is correct', record.contentHash === expectedHash);
    } finally {
      fs.rmSync(declineTmp, { recursive: true, force: true });
    }
  }

  // ── Test 38: declineCandidate — TC2 idempotent for already-removed candidate ──
  // Second call (after the pending file is gone) must not throw.
  console.log('\nTest 38: declineCandidate is idempotent for already-removed candidate (TC2)');
  {
    const declineTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-decline-tc2-'));
    try {
      // Stage a candidate via stageCandidate()
      const staged = stageCandidate({
        projectRoot: declineTmp,
        kind: 'standard',
        content: {
          ruleName: 'Use environment variables for config',
          rule: 'All configuration must use environment variables',
          why: 'Enables 12-factor app compliance',
          whereItBites: 'When shipping to multiple environments',
          area: 'configuration',
        },
        evidence: {
          rule: 'All configuration must use environment variables',
          why: 'Enables 12-factor app compliance',
          data: '',
        },
        source: { taskId: 'task-tc2', sessionId: 'sess-tc2' },
      });

      assert('TC2 setup: staged candidate file exists', fs.existsSync(staged.path));

      // First call — normal decline
      declineCandidate({
        projectRoot: declineTmp,
        kind: 'standard',
        candidateId: staged.id,
        reason: 'Out of scope for this sprint',
      });
      assert('TC2: pending file removed after first call', !fs.existsSync(staged.path));

      // Second call — pending file is already gone, must NOT throw
      let threw = false;
      let secondResult;
      try {
        secondResult = declineCandidate({
          projectRoot: declineTmp,
          kind: 'standard',
          candidateId: staged.id,
          reason: 'Out of scope for this sprint',
        });
      } catch (e) {
        threw = true;
      }
      assert('TC2: second declineCandidate call does not throw', !threw);
      assert('TC2: second call still returns an object with declinedPath', secondResult !== undefined && typeof secondResult.declinedPath === 'string');
      assert('TC2: pending file remains absent after second call', !fs.existsSync(staged.path));
    } finally {
      fs.rmSync(declineTmp, { recursive: true, force: true });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // stageCandidate TC1–TC6 — dedicated labelled block
  // ══════════════════════════════════════════════════════════════════════════

  // ── stageCandidate TC1: creates docs/contracts/.pending/ when it does not exist ──
  console.log('\nstageCandidate TC1: creates docs/contracts/.pending/ directory when it does not exist');
  {
    const scTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-sc-tc1-'));
    try {
      const pendingDir = path.join(scTmp, 'docs', 'contracts', '.pending');
      assert('TC1 pre: docs/contracts/.pending/ does not exist before call', !fs.existsSync(pendingDir));

      stageCandidate({
        projectRoot: scTmp,
        kind: 'contract',
        content: { ruleName: 'TestRule', rule: 'Do X', why: 'Because Y', whereItBites: 'In Z', area: 'core' },
        evidence: { rule: 'Do X', why: 'Because Y', data: '' },
        source: { taskId: 'task-sc-tc1', sessionId: 'ses-sc-tc1' },
      });

      assert('TC1: docs/contracts/.pending/ was created', fs.existsSync(pendingDir));
      assert('TC1: docs/contracts/.pending/ is a directory', fs.statSync(pendingDir).isDirectory());
    } finally {
      fs.rmSync(scTmp, { recursive: true, force: true });
    }
  }

  // ── stageCandidate TC2: creates docs/standards/.pending/ for kind='standard' ──
  console.log('\nstageCandidate TC2: creates docs/standards/.pending/ directory for kind=standard');
  {
    const scTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-sc-tc2-'));
    try {
      const pendingDir = path.join(scTmp, 'docs', 'standards', '.pending');
      assert('TC2 pre: docs/standards/.pending/ does not exist before call', !fs.existsSync(pendingDir));

      stageCandidate({
        projectRoot: scTmp,
        kind: 'standard',
        content: { ruleName: 'StdRule', rule: 'Do A', why: 'Because B', whereItBites: 'In C', area: 'api' },
        evidence: { rule: 'Do A', why: 'Because B', data: '' },
        source: { taskId: 'task-sc-tc2', sessionId: null },
      });

      assert('TC2: docs/standards/.pending/ was created', fs.existsSync(pendingDir));
      assert('TC2: docs/standards/.pending/ is a directory', fs.statSync(pendingDir).isDirectory());
    } finally {
      fs.rmSync(scTmp, { recursive: true, force: true });
    }
  }

  // ── stageCandidate TC3: written file starts with --- and contains all required frontmatter fields ──
  console.log('\nstageCandidate TC3: written file starts with --- and contains all required YAML frontmatter fields');
  {
    const scTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-sc-tc3-'));
    try {
      const { path: filePath } = stageCandidate({
        projectRoot: scTmp,
        kind: 'contract',
        content: { ruleName: 'FMRule', rule: 'Do FM', why: 'Because FM', whereItBites: 'In FM', area: 'staging' },
        evidence: { rule: 'Do FM', why: 'Because FM', data: 'some evidence' },
        source: { taskId: 'task-sc-tc3', sessionId: 'ses-sc-tc3' },
      });

      const fileContent = fs.readFileSync(filePath, 'utf8');

      assert('TC3: file starts with ---', fileContent.startsWith('---\n'));
      assert('TC3: frontmatter contains id field', /^id:/m.test(fileContent));
      assert('TC3: frontmatter contains kind field', /^kind:/m.test(fileContent));
      assert('TC3: frontmatter contains area field', /^area:/m.test(fileContent));
      assert('TC3: frontmatter contains stagedAt field', /^stagedAt:/m.test(fileContent));
      assert('TC3: frontmatter contains source field', /^source:/m.test(fileContent));
      assert('TC3: frontmatter contains evidence field', /^evidence:/m.test(fileContent));
      assert('TC3: frontmatter contains source.taskId', /^ {2}taskId:/m.test(fileContent));
      assert('TC3: frontmatter contains source.sessionId', /^ {2}sessionId:/m.test(fileContent));
      assert('TC3: frontmatter contains evidence.rule', /^ {2}rule:/m.test(fileContent));
      assert('TC3: frontmatter contains evidence.why', /^ {2}why:/m.test(fileContent));
      assert('TC3: frontmatter contains evidence.data', /^ {2}data:/m.test(fileContent));
    } finally {
      fs.rmSync(scTmp, { recursive: true, force: true });
    }
  }

  // ── stageCandidate TC4: written file body contains ## ruleName, Rule:, Why:, Where it bites: ──
  console.log('\nstageCandidate TC4: written file body contains ## ruleName, Rule:, Why:, Where it bites: sections');
  {
    const scTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-sc-tc4-'));
    try {
      const ruleName = 'MySpecialRule';
      const rule = 'Always validate inputs';
      const why = 'Prevents injection attacks';
      const whereItBites = 'At API boundaries';

      const { path: filePath } = stageCandidate({
        projectRoot: scTmp,
        kind: 'contract',
        content: { ruleName, rule, why, whereItBites, area: 'security' },
        evidence: { rule, why, data: '' },
        source: { taskId: null, sessionId: null },
      });

      const fileContent = fs.readFileSync(filePath, 'utf8');

      assert(`TC4: body contains ## ${ruleName}`, fileContent.includes(`## ${ruleName}`));
      assert(`TC4: body contains Rule: ${rule}`, fileContent.includes(`Rule: ${rule}`));
      assert(`TC4: body contains Why: ${why}`, fileContent.includes(`Why: ${why}`));
      assert(`TC4: body contains Where it bites: ${whereItBites}`, fileContent.includes(`Where it bites: ${whereItBites}`));
    } finally {
      fs.rmSync(scTmp, { recursive: true, force: true });
    }
  }

  // ── stageCandidate TC5: returns {id, path} where file exists at path ──
  console.log('\nstageCandidate TC5: returns {id, path} and file exists at path');
  {
    const scTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-sc-tc5-'));
    try {
      const result = stageCandidate({
        projectRoot: scTmp,
        kind: 'contract',
        content: { ruleName: 'ReturnRule', rule: 'Return R', why: 'Return W', whereItBites: 'Return B', area: 'test' },
        evidence: { rule: 'Return R', why: 'Return W', data: '' },
        source: { taskId: 'task-sc-tc5', sessionId: 'ses-sc-tc5' },
      });

      assert('TC5: result is an object', typeof result === 'object' && result !== null);
      assert('TC5: result has id property', 'id' in result);
      assert('TC5: result has path property', 'path' in result);
      assert('TC5: id is a non-empty string', typeof result.id === 'string' && result.id.length > 0);
      assert('TC5: path is a non-empty string', typeof result.path === 'string' && result.path.length > 0);
      assert('TC5: file exists at returned path', fs.existsSync(result.path));
      assert('TC5: path ends with <id>.md', result.path.endsWith(`${result.id}.md`));
    } finally {
      fs.rmSync(scTmp, { recursive: true, force: true });
    }
  }

  // ── stageCandidate TC6: two calls produce two files with different IDs ──
  console.log('\nstageCandidate TC6: two stageCandidate calls produce two files with different IDs');
  {
    const scTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-sc-tc6-'));
    try {
      const opts = {
        projectRoot: scTmp,
        kind: 'contract',
        content: { ruleName: 'DualRule', rule: 'Do both', why: 'Dual why', whereItBites: 'Dual where', area: 'dual' },
        evidence: { rule: 'Do both', why: 'Dual why', data: '' },
        source: { taskId: 'task-sc-tc6', sessionId: 'ses-sc-tc6' },
      };

      const result1 = stageCandidate(opts);
      const result2 = stageCandidate(opts);

      assert('TC6: two calls produce different IDs', result1.id !== result2.id);
      assert('TC6: two calls produce different paths', result1.path !== result2.path);
      assert('TC6: first file exists on disk', fs.existsSync(result1.path));
      assert('TC6: second file exists on disk', fs.existsSync(result2.path));

      const pendingDir = path.join(scTmp, 'docs', 'contracts', '.pending');
      const files = fs.readdirSync(pendingDir);
      assert('TC6: exactly two files in pending dir', files.length === 2);
    } finally {
      fs.rmSync(scTmp, { recursive: true, force: true });
    }
  }

  // ── TC1: Double-promotion — second call is no-op when pending file already removed ──
  console.log('\nTC1: Double-promotion — second call is no-op when pending file already removed');
  {
    const tc1Tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-dp-tc1-'));
    try {
      const fm = {
        id: 'dp-tc1-id',
        kind: 'contract',
        area: 'noop',
        stagedAt: '2026-04-07T10:00:00.000Z',
        source: { taskId: 'task-dp-tc1', sessionId: 'sess-dp-tc1' },
        evidence: { rule: 'No-op rule', why: 'Idempotency', data: '' },
      };
      const body = '## No-op Rule\n\nRule: No-op rule\n\nWhy: Idempotency\n';
      const pendingDir = path.join(tc1Tmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const pendingFile = path.join(pendingDir, 'dp-tc1-id.md');
      fs.writeFileSync(pendingFile, writeFrontmatter(fm) + '\n' + body, 'utf8');

      // First promotion removes the pending file
      const result1 = promoteCandidate({ projectRoot: tc1Tmp, kind: 'contract', candidateId: 'dp-tc1-id' });
      assert('TC1: first promotion succeeds and returns targetPath', typeof result1.targetPath === 'string');
      assert('TC1: pending file is removed after first promotion', !fs.existsSync(pendingFile));

      // Second promotion — pending file already gone, must be a no-op (must not throw)
      let secondThrew = null;
      let result2;
      try {
        result2 = promoteCandidate({ projectRoot: tc1Tmp, kind: 'contract', candidateId: 'dp-tc1-id' });
      } catch (err) {
        secondThrew = err;
      }
      assert('TC1: second promoteCandidate call does not throw when pending file is missing', secondThrew === null);

      // Target file must still contain exactly one copy of the heading
      const targetContent = fs.readFileSync(result1.targetPath, 'utf8');
      const headingCount = (targetContent.match(/## No-op Rule/g) || []).length;
      assert('TC1: target file heading appears exactly once after two calls', headingCount === 1);
    } finally {
      fs.rmSync(tc1Tmp, { recursive: true, force: true });
    }
  }

  // ── TC2: Double-promotion — marker prevents duplicate when pending file re-created ──
  console.log('\nTC2: Double-promotion — marker prevents duplicate when pending file re-created');
  {
    const tc2Tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-dp-tc2-'));
    try {
      const fm = {
        id: 'dp-tc2-id',
        kind: 'contract',
        area: 'marker',
        stagedAt: '2026-04-07T10:00:00.000Z',
        source: { taskId: 'task-dp-tc2', sessionId: 'sess-dp-tc2' },
        evidence: { rule: 'Marker rule', why: 'Prevent duplicate', data: '' },
      };
      const body = '## Marker Rule\n\nRule: Marker rule\n\nWhy: Prevent duplicate\n';
      const pendingDir = path.join(tc2Tmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const pendingFile = path.join(pendingDir, 'dp-tc2-id.md');

      // Write and promote once
      fs.writeFileSync(pendingFile, writeFrontmatter(fm) + '\n' + body, 'utf8');
      const result1 = promoteCandidate({ projectRoot: tc2Tmp, kind: 'contract', candidateId: 'dp-tc2-id' });
      assert('TC2: first promotion removes pending file', !fs.existsSync(pendingFile));

      // Re-create the same pending file (simulate re-queue / re-staging of same candidate)
      fs.writeFileSync(pendingFile, writeFrontmatter(fm) + '\n' + body, 'utf8');
      assert('TC2: pending file re-created before second promotion', fs.existsSync(pendingFile));

      // Second promotion — idempotency marker in target file should prevent duplication
      promoteCandidate({ projectRoot: tc2Tmp, kind: 'contract', candidateId: 'dp-tc2-id' });

      // Pending file removed again
      assert('TC2: pending file removed after second promotion', !fs.existsSync(pendingFile));

      // Target file must have exactly one copy of the heading
      const targetContent = fs.readFileSync(result1.targetPath, 'utf8');
      const headingCount = (targetContent.match(/## Marker Rule/g) || []).length;
      assert('TC2: marker prevents duplicate — heading appears exactly once after re-created pending', headingCount === 1);

      // Idempotency marker must be present
      assert('TC2: idempotency marker present in target file', targetContent.includes('<!-- candidate:dp-tc2-id -->'));
    } finally {
      fs.rmSync(tc2Tmp, { recursive: true, force: true });
    }
  }

  // ── TC3: Multiple promotions produce well-separated sections with no triple newlines ──
  console.log('\nTC3: Multiple promotions produce well-separated sections with no triple newlines');
  {
    const tc3Tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-dp-tc3-'));
    try {
      const pendingDir = path.join(tc3Tmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });

      const makeCandidate = (id, hour) => {
        const fm = {
          id,
          kind: 'contract',
          area: 'wellsep',
          stagedAt: `2026-04-07T${hour}:00:00.000Z`,
          source: { taskId: null, sessionId: null },
          evidence: { rule: `Rule ${hour}`, why: `Why ${hour}`, data: '' },
        };
        const body = `## Section ${hour}\n\nContent for section ${hour}.\n`;
        fs.writeFileSync(
          path.join(pendingDir, `${id}.md`),
          writeFrontmatter(fm) + '\n' + body,
          'utf8'
        );
      };

      makeCandidate('tc3-cand-a', '10');
      makeCandidate('tc3-cand-b', '11');
      makeCandidate('tc3-cand-c', '12');

      promoteCandidate({ projectRoot: tc3Tmp, kind: 'contract', candidateId: 'tc3-cand-a' });
      promoteCandidate({ projectRoot: tc3Tmp, kind: 'contract', candidateId: 'tc3-cand-b' });
      promoteCandidate({ projectRoot: tc3Tmp, kind: 'contract', candidateId: 'tc3-cand-c' });

      const targetPath = path.join(tc3Tmp, 'docs', 'contracts', 'wellsep.md');
      const content = fs.readFileSync(targetPath, 'utf8');

      assert('TC3: all three promoted sections present in target', content.includes('## Section 10') && content.includes('## Section 11') && content.includes('## Section 12'));
      assert('TC3: no triple consecutive newlines anywhere in file', !content.includes('\n\n\n'));
      assert('TC3: sections are separated by blank lines (double newline before each marker)', content.includes('\n\n<!-- candidate:tc3-cand-b -->') && content.includes('\n\n<!-- candidate:tc3-cand-c -->'));
      assert('TC3: file ends with exactly one trailing newline', content.endsWith('\n') && !content.endsWith('\n\n'));
    } finally {
      fs.rmSync(tc3Tmp, { recursive: true, force: true });
    }
  }

  // ── TC4: Idempotency marker appears exactly once in target file ───────────
  console.log('\nTC4: Idempotency marker appears exactly once in target file');
  {
    const tc4Tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-dp-tc4-'));
    try {
      const fm = {
        id: 'tc4-marker-id',
        kind: 'contract',
        area: 'oncemarker',
        stagedAt: '2026-04-07T10:00:00.000Z',
        source: { taskId: 'task-tc4-marker', sessionId: 'sess-tc4-marker' },
        evidence: { rule: 'Marker once rule', why: 'Exactly once', data: '' },
      };
      const body = '## Marker Once Rule\n\nRule: Marker once rule\n';
      const pendingDir = path.join(tc4Tmp, 'docs', 'contracts', '.pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const pendingFile = path.join(pendingDir, 'tc4-marker-id.md');

      // First promotion
      fs.writeFileSync(pendingFile, writeFrontmatter(fm) + '\n' + body, 'utf8');
      const result = promoteCandidate({ projectRoot: tc4Tmp, kind: 'contract', candidateId: 'tc4-marker-id' });

      const contentAfterFirst = fs.readFileSync(result.targetPath, 'utf8');
      const markerAfterFirst = (contentAfterFirst.match(/<!-- candidate:tc4-marker-id -->/g) || []).length;
      assert('TC4: idempotency marker appears exactly once after first promotion', markerAfterFirst === 1);

      // Re-create and promote again (same ID)
      fs.writeFileSync(pendingFile, writeFrontmatter(fm) + '\n' + body, 'utf8');
      promoteCandidate({ projectRoot: tc4Tmp, kind: 'contract', candidateId: 'tc4-marker-id' });

      const contentAfterSecond = fs.readFileSync(result.targetPath, 'utf8');
      const markerAfterSecond = (contentAfterSecond.match(/<!-- candidate:tc4-marker-id -->/g) || []).length;
      assert('TC4: idempotency marker still appears exactly once after second promotion (no duplicate marker)', markerAfterSecond === 1);

      // Also verify no heading duplication
      const headingCount = (contentAfterSecond.match(/## Marker Once Rule/g) || []).length;
      assert('TC4: heading also appears exactly once (no content duplication)', headingCount === 1);
    } finally {
      fs.rmSync(tc4Tmp, { recursive: true, force: true });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // isDeclined TC1–TC6 — dedicated labelled block (task 002-001-005-002)
  // TC1: returns false when declined.jsonl does not exist
  // TC2: returns true when matching source.phase + source.taskId + contentHash record exists
  // TC3: returns false when contentHash differs
  // TC4: returns false when source.taskId differs
  // TC5: gracefully skips malformed JSON lines without throwing
  // TC6: Integration — stageCandidate → declineCandidate → isDeclined returns true
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\nisDeclined TC1–TC6');
  {
    const isDeclinedBlockTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-isdeclined-block-'));
    try {
      const stagingDir = path.join(isDeclinedBlockTmp, '.harness', 'staging');
      const declinedFilePath = path.join(stagingDir, 'declined.jsonl');

      const testSource = { phase: 'plan', taskId: 'task-isDeclined-001' };
      const testHash = contentHash({ rule: 'No raw SQL', why: 'Prevents injection' });

      // TC1: isDeclined returns false when declined.jsonl does not exist
      assert(
        'TC1: isDeclined returns false when declined.jsonl does not exist',
        isDeclined({ projectRoot: isDeclinedBlockTmp, source: testSource, contentHash: testHash }) === false
      );

      // Set up a matching record directly
      fs.mkdirSync(stagingDir, { recursive: true });
      const matchRecord = JSON.stringify({
        id: 'block-id-001',
        source: { phase: 'plan', taskId: 'task-isDeclined-001', sessionId: null },
        contentHash: testHash,
      });
      fs.writeFileSync(declinedFilePath, matchRecord + '\n', 'utf8');

      // TC2: isDeclined returns true when matching source.phase + source.taskId + contentHash record exists
      assert(
        'TC2: isDeclined returns true when matching source.phase + source.taskId + contentHash record exists',
        isDeclined({ projectRoot: isDeclinedBlockTmp, source: testSource, contentHash: testHash }) === true
      );

      // TC3: isDeclined returns false when contentHash differs
      assert(
        'TC3: isDeclined returns false when contentHash differs',
        isDeclined({ projectRoot: isDeclinedBlockTmp, source: testSource, contentHash: 'deadbeef00000000' }) === false
      );

      // TC4: isDeclined returns false when source.taskId differs
      assert(
        'TC4: isDeclined returns false when source.taskId differs',
        isDeclined({ projectRoot: isDeclinedBlockTmp, source: { phase: 'plan', taskId: 'task-DIFFERENT' }, contentHash: testHash }) === false
      );

      // TC5: gracefully skips malformed JSON lines without throwing
      const malformedLines =
        'not-valid-json\n' +
        '{"broken": }\n' +
        matchRecord + '\n';
      fs.writeFileSync(declinedFilePath, malformedLines, 'utf8');

      let tc5Threw = false;
      let tc5Result = false;
      try {
        tc5Result = isDeclined({ projectRoot: isDeclinedBlockTmp, source: testSource, contentHash: testHash });
      } catch {
        tc5Threw = true;
      }
      assert('TC5: isDeclined gracefully skips malformed JSON lines without throwing', !tc5Threw);
      assert('TC5: isDeclined still finds matching record after skipping malformed lines', tc5Result === true);

    } finally {
      fs.rmSync(isDeclinedBlockTmp, { recursive: true, force: true });
    }
  }

  // TC6: Integration — stageCandidate → declineCandidate → isDeclined returns true
  console.log('\nisDeclined TC6: Integration — stageCandidate → declineCandidate → isDeclined returns true');
  {
    const tc6Tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-isdeclined-tc6-'));
    try {
      const evidenceRule = 'Always use parameterised queries';
      const evidenceWhy = 'Prevents SQL injection attacks';
      const expectedHash = contentHash({ rule: evidenceRule, why: evidenceWhy });

      // Stage a candidate
      const staged = stageCandidate({
        projectRoot: tc6Tmp,
        kind: 'contract',
        content: {
          ruleName: 'Always use parameterised queries',
          rule: evidenceRule,
          why: evidenceWhy,
          whereItBites: 'When building dynamic queries',
          area: 'security',
        },
        evidence: {
          rule: evidenceRule,
          why: evidenceWhy,
          data: 'Observed in data-access layer',
        },
        source: { taskId: 'task-tc6-integration', sessionId: 'sess-tc6-integration' },
      });

      assert('TC6 setup: staged candidate file exists', fs.existsSync(staged.path));

      // Confirm isDeclined returns false before declining
      const beforeDecline = isDeclined({
        projectRoot: tc6Tmp,
        source: { taskId: 'task-tc6-integration' },
        contentHash: expectedHash,
      });
      assert('TC6: isDeclined returns false before declineCandidate is called', beforeDecline === false);

      // Decline the candidate
      declineCandidate({
        projectRoot: tc6Tmp,
        kind: 'contract',
        candidateId: staged.id,
        reason: 'Already enforced by ORM',
      });

      assert('TC6: pending file removed after declineCandidate', !fs.existsSync(staged.path));

      // TC6: isDeclined returns true after stageCandidate → declineCandidate flow
      const afterDecline = isDeclined({
        projectRoot: tc6Tmp,
        source: { taskId: 'task-tc6-integration' },
        contentHash: expectedHash,
      });
      assert('TC6: Integration — stageCandidate → declineCandidate → isDeclined returns true', afterDecline === true);

    } finally {
      fs.rmSync(tc6Tmp, { recursive: true, force: true });
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\nCleaned up: ${tmpDir}`);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
