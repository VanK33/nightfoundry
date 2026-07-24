/**
 * test-cross-archive-analyzer.js — Unit tests for cross-archive-analyzer.js.
 *
 * Uses fixture archives at test/fixtures/analyze-overhead/archives/A-001 and A-002.
 *
 * Run: node test/test-cross-archive-analyzer.js
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  enumerateArchives,
  loadArchiveSummary,
  loadArchiveManifestTotal,
  aggregateAcrossArchives,
} from '../src/orchestrator/infra/cross-archive-analyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ---------- Fixtures ----------

const fixturesDir = path.resolve(__dirname, 'fixtures/analyze-overhead');
const archivesDir = path.join(fixturesDir, 'archives');

// Exact expected entries from A-001/logs/session-summary.json (verbatim fixture)
const A001_ENTRIES = [
  {
    name: 'planner-global',
    role: 'planner',
    inputTokens: 100,
    outputTokens: 200,
    cacheCreation: 1000,
    cacheRead: 5000,
    totalCost: 0.05,
    toolCalls: 5,
    durationMs: 10000,
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:00:10.000Z',
  },
  {
    name: 'executor-task-001',
    role: 'executor',
    inputTokens: 150,
    outputTokens: 300,
    cacheCreation: 2000,
    cacheRead: 8000,
    totalCost: 0.10,
    toolCalls: 10,
    durationMs: 20000,
    startedAt: '2026-01-01T10:05:00.000Z',
    finishedAt: '2026-01-01T10:05:20.000Z',
  },
  {
    name: 'executor-task-002',
    role: 'executor',
    inputTokens: 200,
    outputTokens: 400,
    cacheCreation: 3000,
    cacheRead: 10000,
    totalCost: 0.15,
    toolCalls: 15,
    durationMs: 30000,
    startedAt: '2026-01-01T10:10:00.000Z',
    finishedAt: '2026-01-01T10:10:30.000Z',
  },
];

// ---------- TC1: enumerateArchives returns sorted descriptors for A-001 and A-002 ----------
test('TC1 enumerateArchives returns sorted descriptors for A-001 and A-002', () => {
  const archives = enumerateArchives(archivesDir);
  assert.ok(Array.isArray(archives), 'Expected array result from enumerateArchives');

  const ids = archives.map((a) => a.id);
  assert.ok(ids.includes('A-001'), `Expected A-001 in archives, got: ${ids.join(', ')}`);
  assert.ok(ids.includes('A-002'), `Expected A-002 in archives, got: ${ids.join(', ')}`);

  // A-001 must come before A-002 (sorted order)
  const a001idx = ids.indexOf('A-001');
  const a002idx = ids.indexOf('A-002');
  assert.ok(a001idx < a002idx, `Expected A-001 before A-002, indices: ${a001idx} vs ${a002idx}`);

  // Each descriptor must have id and dir set
  const a001 = archives[a001idx];
  const a002 = archives[a002idx];
  assert.strictEqual(a001.id, 'A-001', `Expected id='A-001', got '${a001.id}'`);
  assert.ok(typeof a001.dir === 'string' && a001.dir.length > 0, 'Expected non-empty dir for A-001');
  assert.ok(a001.dir.endsWith(path.sep + 'A-001') || a001.dir.endsWith('/A-001'),
    `Expected dir to end with A-001, got: ${a001.dir}`);

  assert.strictEqual(a002.id, 'A-002', `Expected id='A-002', got '${a002.id}'`);
  assert.ok(typeof a002.dir === 'string' && a002.dir.length > 0, 'Expected non-empty dir for A-002');
  assert.ok(a002.dir.endsWith(path.sep + 'A-002') || a002.dir.endsWith('/A-002'),
    `Expected dir to end with A-002, got: ${a002.dir}`);
});

// ---------- TC2: loadArchiveSummary on A-001 returns 3 entries verbatim ----------
test('TC2 loadArchiveSummary on A-001 returns 3 entries verbatim', () => {
  const a001dir = path.join(archivesDir, 'A-001');
  const entries = loadArchiveSummary({ dir: a001dir });

  assert.ok(Array.isArray(entries), 'Expected array result from loadArchiveSummary');
  assert.strictEqual(entries.length, 3, `Expected 3 entries from A-001, got ${entries.length}`);
  assert.deepStrictEqual(entries, A001_ENTRIES,
    'Expected entries to deeply equal A-001 fixture data verbatim');
});

// ---------- TC3: missing session-summary.json → null + stderr warn ----------
test('TC3 loadArchiveSummary missing session-summary.json returns null and warns stderr', () => {
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return origWrite(chunk, ...rest);
  };

  let result;
  try {
    result = loadArchiveSummary({ dir: '/nonexistent/path/that/does/not/exist' });
  } finally {
    process.stderr.write = origWrite;
  }

  assert.strictEqual(result, null, 'Expected null for missing archive directory');
  assert.ok(
    captured.some((m) => m.includes('session-summary.json') || m.includes('not found')),
    `Expected stderr warning mentioning session-summary.json. Got: ${captured.join('')}`
  );
});

// ---------- TC4: malformed JSON → null + stderr warn ----------
test('TC4 loadArchiveSummary on malformed JSON returns null and warns stderr', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-mal-'));
  const logsDir = path.join(tmpDir, 'logs');
  fs.mkdirSync(logsDir);
  fs.writeFileSync(path.join(logsDir, 'session-summary.json'), '{invalid json{{{{');

  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return origWrite(chunk, ...rest);
  };

  let result;
  try {
    result = loadArchiveSummary({ dir: tmpDir });
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(tmpDir, { recursive: true });
  }

  assert.strictEqual(result, null, 'Expected null for malformed JSON');
  assert.ok(
    captured.some((m) =>
      m.includes('session-summary.json') || m.includes('parse') || m.includes('Failed')
    ),
    `Expected stderr warning about malformed JSON. Got: ${captured.join('')}`
  );
});

// ---------- TC5: aggregateAcrossArchives returns exact key shape with totalSessions ----------
test('TC5 aggregateAcrossArchives returns exact key shape with totalSessions=5', () => {
  const allArchives = enumerateArchives(archivesDir);
  const archives = allArchives.filter((a) => a.id === 'A-001' || a.id === 'A-002');

  const result = aggregateAcrossArchives(archives);

  // Check top-level key shape
  assert.ok('archives' in result, 'Expected "archives" key in result');
  assert.ok('aggregate' in result, 'Expected "aggregate" key in result');

  // Check aggregate key shape
  assert.ok('totalCostUsd' in result.aggregate, 'Expected "totalCostUsd" in aggregate');
  assert.ok('overallCacheRatio' in result.aggregate, 'Expected "overallCacheRatio" in aggregate');
  assert.ok('totalSessions' in result.aggregate, 'Expected "totalSessions" in aggregate');
  assert.ok('byRole' in result.aggregate, 'Expected "byRole" in aggregate');

  // A-001: 3 sessions, A-002: 2 sessions → total = 5
  assert.strictEqual(result.aggregate.totalSessions, 5,
    `Expected totalSessions=5 (3 from A-001 + 2 from A-002), got ${result.aggregate.totalSessions}`);
});

// ---------- TC6: overallCacheRatio = sum(cacheRead)/sum(cacheCreation); null when divisor 0 ----------
test('TC6 overallCacheRatio equals sum(cacheRead)/sum(cacheCreation) and null when cacheCreation=0', () => {
  const allArchives = enumerateArchives(archivesDir);
  const archives = allArchives.filter((a) => a.id === 'A-001' || a.id === 'A-002');

  const result = aggregateAcrossArchives(archives);

  // A-001: cacheCreation=1000+2000+3000=6000, cacheRead=5000+8000+10000=23000
  // A-002: cacheCreation=500+800=1300,        cacheRead=2000+4000=6000
  // total: cacheCreation=7300, cacheRead=29000 → ratio=29000/7300
  const expectedRatio = 29000 / 7300;
  assert.ok(result.aggregate.overallCacheRatio !== null,
    'Expected non-null overallCacheRatio for non-zero cacheCreation');
  assert.ok(
    Math.abs(result.aggregate.overallCacheRatio - expectedRatio) < 0.0001,
    `Expected overallCacheRatio≈${expectedRatio}, got ${result.aggregate.overallCacheRatio}`
  );

  // null case: archive with cacheCreation===0 for all entries
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-zero-'));
  const logsDir = path.join(tmpDir, 'logs');
  fs.mkdirSync(logsDir);
  fs.writeFileSync(
    path.join(logsDir, 'session-summary.json'),
    JSON.stringify([
      {
        name: 'zero-cache',
        role: 'executor',
        inputTokens: 10,
        outputTokens: 20,
        cacheCreation: 0,
        cacheRead: 0,
        totalCost: 0.01,
        toolCalls: 1,
        durationMs: 1000,
        startedAt: '2026-01-01T00:00:00.000Z',
      },
    ])
  );
  try {
    const zeroResult = aggregateAcrossArchives([{ id: 'tmp', date: null, dir: tmpDir }]);
    assert.strictEqual(zeroResult.aggregate.overallCacheRatio, null,
      'Expected null overallCacheRatio when all cacheCreation=0');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------- TC7: role:'executor' filter narrows aggregate.byRole to only 'executor' ----------
test('TC7 role executor filter narrows byRole to only executor', () => {
  const allArchives = enumerateArchives(archivesDir);
  const archives = allArchives.filter((a) => a.id === 'A-001' || a.id === 'A-002');

  const result = aggregateAcrossArchives(archives, { role: 'executor' });

  const roles = Object.keys(result.aggregate.byRole);
  assert.ok(roles.length > 0, 'Expected at least one role in byRole after executor filter');
  assert.ok(roles.every((r) => r === 'executor'),
    `Expected only 'executor' in byRole, got: ${roles.join(', ')}`);
  assert.ok('executor' in result.aggregate.byRole,
    'Expected executor key present in byRole');
});

// ---------- TC8: since:'2026-01-01T10:08:00.000Z' excludes earliest A-001 executor session ----------
test('TC8 since filter excludes earliest A-001 executor session', () => {
  const allArchives = enumerateArchives(archivesDir);
  const a001 = allArchives.filter((a) => a.id === 'A-001');

  // Without filter: A-001 has 2 executor sessions (executor-task-001 @ 10:05, executor-task-002 @ 10:10)
  const before = aggregateAcrossArchives(a001, { role: 'executor' });
  assert.strictEqual(before.aggregate.totalSessions, 2,
    `Expected 2 executor sessions in A-001 before filter, got ${before.aggregate.totalSessions}`);

  // With since='2026-01-01T10:08:00.000Z':
  //   executor-task-001 (startedAt 10:05) < cutoff → EXCLUDED
  //   executor-task-002 (startedAt 10:10) >= cutoff → INCLUDED
  const after = aggregateAcrossArchives(a001, {
    role: 'executor',
    since: '2026-01-01T10:08:00.000Z',
  });
  assert.strictEqual(after.aggregate.totalSessions, 1,
    `Expected 1 executor session after since filter, got ${after.aggregate.totalSessions}`);
  assert.strictEqual(after.aggregate.byRole.executor.sessionCount, 1,
    `Expected executor sessionCount=1, got ${after.aggregate.byRole.executor.sessionCount}`);
});

// ---------- TC9: last:1 keeps only most recent archive descriptor ----------
test('TC9 last:1 keeps only the most recent archive descriptor', () => {
  const allArchives = enumerateArchives(archivesDir);
  const archives = allArchives.filter((a) => a.id === 'A-001' || a.id === 'A-002');

  const result = aggregateAcrossArchives(archives, { last: 1 });

  assert.strictEqual(result.archives.length, 1,
    `Expected 1 archive in result with last:1, got ${result.archives.length}`);
  // Most recent (last in sorted order) is A-002
  assert.strictEqual(result.archives[0].id, 'A-002',
    `Expected A-002 as most recent archive, got '${result.archives[0].id}'`);
});

// ---------- TC10: session entry missing role is skipped + warns stderr ----------
test('TC10 session entry missing role is skipped and warns stderr', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-norole-'));
  const logsDir = path.join(tmpDir, 'logs');
  fs.mkdirSync(logsDir);
  // One valid entry + one missing role
  fs.writeFileSync(
    path.join(logsDir, 'session-summary.json'),
    JSON.stringify([
      {
        name: 'valid-entry',
        role: 'executor',
        inputTokens: 10,
        outputTokens: 20,
        cacheCreation: 100,
        cacheRead: 200,
        totalCost: 0.01,
        toolCalls: 1,
        durationMs: 1000,
        startedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        name: 'no-role-entry',
        inputTokens: 5,
        outputTokens: 10,
        cacheCreation: 50,
        cacheRead: 100,
        totalCost: 0.005,
        toolCalls: 1,
        durationMs: 500,
        startedAt: '2026-01-01T00:01:00.000Z',
      },
    ])
  );

  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return origWrite(chunk, ...rest);
  };

  let result;
  try {
    result = aggregateAcrossArchives([{ id: 'tmp', date: null, dir: tmpDir }]);
  } finally {
    process.stderr.write = origWrite;
    fs.rmSync(tmpDir, { recursive: true });
  }

  // The no-role entry is skipped → only 1 session counted
  assert.strictEqual(result.aggregate.totalSessions, 1,
    `Expected totalSessions=1 (no-role entry skipped), got ${result.aggregate.totalSessions}`);

  // Exactly one stderr warning about the skipped entry
  const warnCount = captured.filter((m) =>
    m.includes('role') || m.includes('Skipping') || m.includes('missing')
  ).length;
  assert.ok(warnCount >= 1,
    `Expected at least 1 stderr warning about missing role, got ${warnCount}. Output: ${captured.join('')}`
  );
});

// ---------- TC11: date derived from earliest startedAt for NNN-slug dirs (A-001 and A-002) ----------
test('TC11 enumerateArchives derives date from earliest startedAt for NNN-slug dirs', () => {
  const archives = enumerateArchives(archivesDir);

  const a001 = archives.find((a) => a.id === 'A-001');
  assert.ok(a001, 'Expected A-001 in enumerated archives');
  assert.strictEqual(a001.date, '2026-01-01',
    `Expected A-001 date='2026-01-01' derived from earliest startedAt, got '${a001.date}'`);

  const a002 = archives.find((a) => a.id === 'A-002');
  assert.ok(a002, 'Expected A-002 in enumerated archives');
  assert.strictEqual(a002.date, '2026-01-02',
    `Expected A-002 date='2026-01-02' derived from earliest startedAt, got '${a002.date}'`);
});

// ---------- TC12: archive dir with no session-summary.json returns date null ----------
test('TC12 enumerateArchives returns date null for archive with no session-summary.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-nodate-'));
  const archiveDir = path.join(tmpDir, 'NO-DATE-ARCHIVE');
  fs.mkdirSync(archiveDir);
  // No logs dir, no session-summary.json

  try {
    const archives = enumerateArchives(tmpDir);
    const desc = archives.find((a) => a.id === 'NO-DATE-ARCHIVE');
    assert.ok(desc, 'Expected NO-DATE-ARCHIVE descriptor');
    assert.strictEqual(desc.date, null,
      `Expected date=null when no session-summary.json and no regex match, got '${desc.date}'`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------- TC13: directory matching regex uses regex date, not session-summary.json ----------
test('TC13 enumerateArchives uses regex date for dirs matching date pattern', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-regexdate-'));
  const archiveDir = path.join(tmpDir, '2026-05-20-foo');
  const logsDir = path.join(archiveDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  // session-summary.json has a different date to verify regex takes precedence
  fs.writeFileSync(
    path.join(logsDir, 'session-summary.json'),
    JSON.stringify([
      {
        name: 'some-session',
        role: 'executor',
        inputTokens: 10,
        outputTokens: 20,
        cacheCreation: 0,
        cacheRead: 0,
        totalCost: 0.01,
        toolCalls: 1,
        durationMs: 1000,
        startedAt: '2025-12-31T23:00:00.000Z',
      },
    ])
  );

  try {
    const archives = enumerateArchives(tmpDir);
    const desc = archives.find((a) => a.id === '2026-05-20-foo');
    assert.ok(desc, 'Expected 2026-05-20-foo archive descriptor');
    assert.strictEqual(desc.date, '2026-05-20',
      `Expected date='2026-05-20' from regex (not from session-summary.json), got '${desc.date}'`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------- TC14: loadArchiveManifestTotal returns numeric totalCost from valid manifest.json ----------
test('TC14 loadArchiveManifestTotal returns numeric totalCost when manifest.json present with numeric totalCost', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-manifest-'));
  fs.writeFileSync(
    path.join(tmpDir, 'manifest.json'),
    JSON.stringify({ id: 'test-archive', totalCost: 4.56, totalSessions: 3 })
  );
  try {
    const result = loadArchiveManifestTotal({ dir: tmpDir, id: 'test-archive' });
    assert.strictEqual(result, 4.56,
      `Expected totalCost=4.56 from manifest.json, got ${result}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------- TC15: loadArchiveManifestTotal returns null when manifest.json missing ----------
test('TC15 loadArchiveManifestTotal returns null when manifest.json missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-nomanifest-'));
  try {
    const result = loadArchiveManifestTotal({ dir: tmpDir, id: 'no-manifest-archive' });
    assert.strictEqual(result, null,
      `Expected null when manifest.json missing, got ${result}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------- TC16: loadArchiveManifestTotal returns null when manifest.json is malformed ----------
test('TC16 loadArchiveManifestTotal returns null when manifest.json is malformed/unparseable', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-badmanifest-'));
  fs.writeFileSync(path.join(tmpDir, 'manifest.json'), '{ invalid json {{{{');
  try {
    const result = loadArchiveManifestTotal({ dir: tmpDir, id: 'malformed-archive' });
    assert.strictEqual(result, null,
      `Expected null when manifest.json is malformed, got ${result}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------- TC17: loadArchiveManifestTotal returns null when totalCost is absent or non-numeric ----------
test('TC17 loadArchiveManifestTotal returns null when totalCost is absent or non-numeric', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-nototal-'));

  // Case 1: totalCost absent
  fs.writeFileSync(
    path.join(tmpDir, 'manifest.json'),
    JSON.stringify({ id: 'no-total-archive', totalSessions: 2 })
  );
  let result = loadArchiveManifestTotal({ dir: tmpDir, id: 'no-total-archive' });
  assert.strictEqual(result, null,
    `Expected null when totalCost is absent, got ${result}`);

  // Case 2: totalCost is a string
  fs.writeFileSync(
    path.join(tmpDir, 'manifest.json'),
    JSON.stringify({ id: 'string-total', totalCost: '4.56', totalSessions: 1 })
  );
  result = loadArchiveManifestTotal({ dir: tmpDir, id: 'string-total' });
  assert.strictEqual(result, null,
    `Expected null when totalCost is a string, got ${result}`);

  // Case 3: totalCost is NaN (non-finite)
  fs.writeFileSync(
    path.join(tmpDir, 'manifest.json'),
    JSON.stringify({ id: 'nan-total', totalCost: null, totalSessions: 1 })
  );
  result = loadArchiveManifestTotal({ dir: tmpDir, id: 'nan-total' });
  assert.strictEqual(result, null,
    `Expected null when totalCost is null, got ${result}`);

  fs.rmSync(tmpDir, { recursive: true });
});

// ---------- TC18: per-archive totalCostUsd equals manifest totalCost when no role/since filter ----------
test('TC18 per-archive totalCostUsd equals manifest totalCost when no role/since filter', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-manifestcost-'));
  const logsDir = path.join(tmpDir, 'logs');
  fs.mkdirSync(logsDir);

  // Session sum would be 0.15, manifest has 9.99
  fs.writeFileSync(
    path.join(logsDir, 'session-summary.json'),
    JSON.stringify([
      {
        name: 'session-a',
        role: 'executor',
        inputTokens: 10,
        outputTokens: 20,
        cacheCreation: 100,
        cacheRead: 200,
        totalCost: 0.05,
        toolCalls: 1,
        durationMs: 1000,
        startedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        name: 'session-b',
        role: 'planner',
        inputTokens: 10,
        outputTokens: 20,
        cacheCreation: 100,
        cacheRead: 200,
        totalCost: 0.10,
        toolCalls: 1,
        durationMs: 1000,
        startedAt: '2026-01-01T01:00:00.000Z',
      },
    ])
  );
  fs.writeFileSync(
    path.join(tmpDir, 'manifest.json'),
    JSON.stringify({ id: 'manifest-cost-archive', totalCost: 9.99, totalSessions: 2 })
  );

  try {
    const result = aggregateAcrossArchives([{ id: 'manifest-cost-archive', date: null, dir: tmpDir }]);
    assert.strictEqual(result.archives.length, 1, 'Expected 1 archive in result');
    assert.strictEqual(result.archives[0].totalCostUsd, 9.99,
      `Expected per-archive totalCostUsd=9.99 from manifest, got ${result.archives[0].totalCostUsd}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------- TC19: per-archive totalCostUsd falls back to session sum when role or since filter active ----------
test('TC19 per-archive totalCostUsd falls back to session sum when role or since filter active', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-filterfall-'));
  const logsDir = path.join(tmpDir, 'logs');
  fs.mkdirSync(logsDir);

  const sessions = [
    {
      name: 'session-a',
      role: 'executor',
      inputTokens: 10,
      outputTokens: 20,
      cacheCreation: 100,
      cacheRead: 200,
      totalCost: 0.05,
      toolCalls: 1,
      durationMs: 1000,
      startedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      name: 'session-b',
      role: 'planner',
      inputTokens: 10,
      outputTokens: 20,
      cacheCreation: 100,
      cacheRead: 200,
      totalCost: 0.10,
      toolCalls: 1,
      durationMs: 1000,
      startedAt: '2026-01-01T01:00:00.000Z',
    },
  ];
  fs.writeFileSync(path.join(logsDir, 'session-summary.json'), JSON.stringify(sessions));
  // Manifest cost: 9.99 — should be ignored when role/since filter is active
  fs.writeFileSync(
    path.join(tmpDir, 'manifest.json'),
    JSON.stringify({ id: 'filter-archive', totalCost: 9.99, totalSessions: 2 })
  );

  try {
    const descriptor = [{ id: 'filter-archive', date: null, dir: tmpDir }];

    // With role filter: only executor session (0.05) is included
    const roleResult = aggregateAcrossArchives(descriptor, { role: 'executor' });
    assert.strictEqual(roleResult.archives.length, 1);
    assert.ok(
      Math.abs(roleResult.archives[0].totalCostUsd - 0.05) < 0.0001,
      `Expected per-archive totalCostUsd≈0.05 with role filter (session sum), got ${roleResult.archives[0].totalCostUsd}`
    );

    // With since filter: only session-b (startedAt 01:00) is included
    const sinceResult = aggregateAcrossArchives(descriptor, { since: '2026-01-01T00:30:00.000Z' });
    assert.strictEqual(sinceResult.archives.length, 1);
    assert.ok(
      Math.abs(sinceResult.archives[0].totalCostUsd - 0.10) < 0.0001,
      `Expected per-archive totalCostUsd≈0.10 with since filter (session sum), got ${sinceResult.archives[0].totalCostUsd}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------- TC20: aggregate.totalCostUsd equals sum of per-archive totalCostUsd values ----------
test('TC20 aggregate.totalCostUsd equals sum of per-archive totalCostUsd values', () => {
  const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-aggsum1-'));
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-aggsum2-'));

  // Archive 1: manifest totalCost=3.00, session sum=0.10
  const logsDir1 = path.join(tmpDir1, 'logs');
  fs.mkdirSync(logsDir1);
  fs.writeFileSync(
    path.join(logsDir1, 'session-summary.json'),
    JSON.stringify([{
      name: 's1', role: 'executor', inputTokens: 1, outputTokens: 1,
      cacheCreation: 0, cacheRead: 0, totalCost: 0.10, toolCalls: 1, durationMs: 100,
      startedAt: '2026-01-01T00:00:00.000Z',
    }])
  );
  fs.writeFileSync(path.join(tmpDir1, 'manifest.json'),
    JSON.stringify({ id: 'arch1', totalCost: 3.00, totalSessions: 1 }));

  // Archive 2: manifest totalCost=7.00, session sum=0.20
  const logsDir2 = path.join(tmpDir2, 'logs');
  fs.mkdirSync(logsDir2);
  fs.writeFileSync(
    path.join(logsDir2, 'session-summary.json'),
    JSON.stringify([{
      name: 's2', role: 'executor', inputTokens: 1, outputTokens: 1,
      cacheCreation: 0, cacheRead: 0, totalCost: 0.20, toolCalls: 1, durationMs: 100,
      startedAt: '2026-01-02T00:00:00.000Z',
    }])
  );
  fs.writeFileSync(path.join(tmpDir2, 'manifest.json'),
    JSON.stringify({ id: 'arch2', totalCost: 7.00, totalSessions: 1 }));

  try {
    const descriptors = [
      { id: 'arch1', date: null, dir: tmpDir1 },
      { id: 'arch2', date: null, dir: tmpDir2 },
    ];
    const result = aggregateAcrossArchives(descriptors);

    // Per-archive totalCostUsd should each use manifest value
    assert.ok(Math.abs(result.archives[0].totalCostUsd - 3.00) < 0.0001,
      `Expected arch1 totalCostUsd=3.00, got ${result.archives[0].totalCostUsd}`);
    assert.ok(Math.abs(result.archives[1].totalCostUsd - 7.00) < 0.0001,
      `Expected arch2 totalCostUsd=7.00, got ${result.archives[1].totalCostUsd}`);

    // aggregate.totalCostUsd = sum of per-archive values = 3.00 + 7.00 = 10.00
    assert.ok(Math.abs(result.aggregate.totalCostUsd - 10.00) < 0.0001,
      `Expected aggregate.totalCostUsd=10.00 (sum of per-archive), got ${result.aggregate.totalCostUsd}`);
  } finally {
    fs.rmSync(tmpDir1, { recursive: true });
    fs.rmSync(tmpDir2, { recursive: true });
  }
});

// ---------- Shared setup for TC21 / TC22 / TC23 / TC24 ----------
// TC21 and TC22 each own their own temp dirs (try/finally pattern).
// TC23 and TC24 share the same two-archive result; dirs are cleaned after TC24.

let _tc2324Result = null;
const _tc2324TmpDirs = [];

function buildTC2324Result() {
  if (_tc2324Result !== null) return _tc2324Result;

  // Archive 1: token-usage sessions sum to 3.00; manifest totalCost = 1.00
  const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-mix1-'));
  _tc2324TmpDirs.push(tmpDir1);
  const logsDir1 = path.join(tmpDir1, 'logs');
  fs.mkdirSync(logsDir1);
  fs.writeFileSync(
    path.join(logsDir1, 'token-usage.json'),
    JSON.stringify({
      totals: { totalCostUsd: 3.00 },
      sessions: [
        {
          name: 'planner-s1',
          type: 'planner',
          timestamp: '2026-03-01T00:00:00.000Z',
          inputTokens: 100,
          outputTokens: 200,
          cacheCreation: 100,
          cacheRead: 500,
          totalCostUsd: 1.50,
        },
        {
          name: 'executor-s1',
          type: 'executor',
          timestamp: '2026-03-01T01:00:00.000Z',
          inputTokens: 100,
          outputTokens: 200,
          cacheCreation: 200,
          cacheRead: 800,
          totalCostUsd: 1.50,
        },
      ],
    })
  );
  fs.writeFileSync(
    path.join(tmpDir1, 'manifest.json'),
    JSON.stringify({ id: 'mix-arch1', totalCost: 1.00, totalSessions: 2 })
  );

  // Archive 2: token-usage sessions sum to 0.30; no manifest.json
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-mix2-'));
  _tc2324TmpDirs.push(tmpDir2);
  const logsDir2 = path.join(tmpDir2, 'logs');
  fs.mkdirSync(logsDir2);
  fs.writeFileSync(
    path.join(logsDir2, 'token-usage.json'),
    JSON.stringify({
      totals: { totalCostUsd: 0.30 },
      sessions: [
        {
          name: 'executor-s2a',
          type: 'executor',
          timestamp: '2026-03-02T00:00:00.000Z',
          inputTokens: 50,
          outputTokens: 100,
          cacheCreation: 50,
          cacheRead: 100,
          totalCostUsd: 0.10,
        },
        {
          name: 'executor-s2b',
          type: 'executor',
          timestamp: '2026-03-02T01:00:00.000Z',
          inputTokens: 50,
          outputTokens: 100,
          cacheCreation: 75,
          cacheRead: 300,
          totalCostUsd: 0.20,
        },
      ],
    })
  );
  // No manifest.json for archive 2

  _tc2324Result = aggregateAcrossArchives([
    { id: 'mix-arch1', date: null, dir: tmpDir1 },
    { id: 'mix-arch2', date: null, dir: tmpDir2 },
  ]);
  return _tc2324Result;
}

// ---------- TC21 (task TC14): manifest precedence — manifest 1.00 overrides token-usage session sum 3.00 ----------
test('TC21 manifest precedence: archives[0].totalCostUsd equals manifest 1.00, not token-usage session sum 3.00', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-manpri-'));
  const logsDir = path.join(tmpDir, 'logs');
  fs.mkdirSync(logsDir);

  // Two token-usage sessions totaling 3.00
  fs.writeFileSync(
    path.join(logsDir, 'token-usage.json'),
    JSON.stringify({
      totals: { totalCostUsd: 3.00 },
      sessions: [
        {
          name: 'planner-a',
          type: 'planner',
          timestamp: '2026-04-01T00:00:00.000Z',
          inputTokens: 100,
          outputTokens: 200,
          cacheCreation: 100,
          cacheRead: 500,
          totalCostUsd: 1.50,
        },
        {
          name: 'executor-a',
          type: 'executor',
          timestamp: '2026-04-01T01:00:00.000Z',
          inputTokens: 100,
          outputTokens: 200,
          cacheCreation: 100,
          cacheRead: 500,
          totalCostUsd: 1.50,
        },
      ],
    })
  );
  // Manifest totalCost = 1.00 (smaller than the 3.00 session sum)
  fs.writeFileSync(
    path.join(tmpDir, 'manifest.json'),
    JSON.stringify({ id: 'manpri-archive', totalCost: 1.00, totalSessions: 2 })
  );

  try {
    const result = aggregateAcrossArchives([{ id: 'manpri-archive', date: null, dir: tmpDir }]);
    assert.strictEqual(result.archives.length, 1, 'Expected 1 archive in result');
    assert.strictEqual(
      result.archives[0].totalCostUsd,
      1.00,
      `Expected archives[0].totalCostUsd=1.00 (manifest value), not 3.00 (session sum); got ${result.archives[0].totalCostUsd}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------- TC22 (task TC15): backward compat — no manifest → totalCostUsd equals session sum 0.30 ----------
test('TC22 backward compat: no manifest.json → archives[0].totalCostUsd equals token-usage session sum 0.30', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-nomnf-'));
  const logsDir = path.join(tmpDir, 'logs');
  fs.mkdirSync(logsDir);

  // Two token-usage sessions totaling 0.30; no manifest.json
  fs.writeFileSync(
    path.join(logsDir, 'token-usage.json'),
    JSON.stringify({
      totals: { totalCostUsd: 0.30 },
      sessions: [
        {
          name: 'executor-b1',
          type: 'executor',
          timestamp: '2026-04-02T00:00:00.000Z',
          inputTokens: 50,
          outputTokens: 100,
          cacheCreation: 50,
          cacheRead: 100,
          totalCostUsd: 0.10,
        },
        {
          name: 'executor-b2',
          type: 'executor',
          timestamp: '2026-04-02T01:00:00.000Z',
          inputTokens: 50,
          outputTokens: 100,
          cacheCreation: 75,
          cacheRead: 200,
          totalCostUsd: 0.20,
        },
      ],
    })
  );
  // No manifest.json

  try {
    const result = aggregateAcrossArchives([{ id: 'nomnf-archive', date: null, dir: tmpDir }]);
    assert.strictEqual(result.archives.length, 1, 'Expected 1 archive in result');
    assert.ok(
      Math.abs(result.archives[0].totalCostUsd - 0.30) < 0.0001,
      `Expected archives[0].totalCostUsd≈0.30 (session sum fallback), got ${result.archives[0].totalCostUsd}`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ---------- TC23 (task TC16): aggregate sum across mix = 1.00 + 0.30 = 1.30, not 3.30 ----------
test('TC23 aggregate mix: result.aggregate.totalCostUsd===1.30 (manifest 1.00 + session-sum 0.30), not 3.30 raw session total', () => {
  const result = buildTC2324Result();
  // Archive 1 uses manifest (1.00), archive 2 uses session sum (0.30) → aggregate = 1.30
  assert.ok(
    Math.abs(result.aggregate.totalCostUsd - 1.30) < 0.0001,
    `Expected aggregate.totalCostUsd≈1.30, got ${result.aggregate.totalCostUsd}`
  );
  // Sanity: individual per-archive values
  const arch1 = result.archives.find((a) => a.id === 'mix-arch1');
  assert.ok(arch1, 'Expected mix-arch1 in archives');
  assert.ok(
    Math.abs(arch1.totalCostUsd - 1.00) < 0.0001,
    `Expected mix-arch1 totalCostUsd≈1.00 (manifest), got ${arch1.totalCostUsd}`
  );
  const arch2 = result.archives.find((a) => a.id === 'mix-arch2');
  assert.ok(arch2, 'Expected mix-arch2 in archives');
  assert.ok(
    Math.abs(arch2.totalCostUsd - 0.30) < 0.0001,
    `Expected mix-arch2 totalCostUsd≈0.30 (session sum fallback), got ${arch2.totalCostUsd}`
  );
});

// ---------- TC24 (task TC17): key presence — byRole populated, overallCacheRatio present ----------
test('TC24 key presence: each archives[i] and aggregate have populated byRole and overallCacheRatio property', () => {
  const result = buildTC2324Result();

  // Check each per-archive entry
  for (const arch of result.archives) {
    assert.ok('byRole' in arch,
      `Expected 'byRole' property on archive ${arch.id}`);
    assert.ok(typeof arch.byRole === 'object' && arch.byRole !== null,
      `Expected byRole to be a non-null object on archive ${arch.id}`);
    const roleKeys = Object.keys(arch.byRole);
    assert.ok(roleKeys.length >= 1,
      `Expected byRole to have >=1 role key on archive ${arch.id}, got: ${roleKeys.join(', ')}`);
    assert.ok('overallCacheRatio' in arch,
      `Expected 'overallCacheRatio' property on archive ${arch.id}`);
    assert.ok(
      arch.overallCacheRatio === null || typeof arch.overallCacheRatio === 'number',
      `Expected overallCacheRatio to be number or null on archive ${arch.id}, got ${typeof arch.overallCacheRatio}`
    );
  }

  // Check aggregate
  assert.ok('byRole' in result.aggregate, "Expected 'byRole' in aggregate");
  assert.ok(typeof result.aggregate.byRole === 'object' && result.aggregate.byRole !== null,
    'Expected aggregate.byRole to be a non-null object');
  const aggRoleKeys = Object.keys(result.aggregate.byRole);
  assert.ok(aggRoleKeys.length >= 1,
    `Expected aggregate.byRole to have >=1 role key, got: ${aggRoleKeys.join(', ')}`);
  assert.ok('overallCacheRatio' in result.aggregate,
    "Expected 'overallCacheRatio' in aggregate");
  assert.ok(
    result.aggregate.overallCacheRatio === null || typeof result.aggregate.overallCacheRatio === 'number',
    `Expected aggregate.overallCacheRatio to be number or null, got ${typeof result.aggregate.overallCacheRatio}`
  );
});

// Cleanup shared TC23/TC24 temp dirs
for (const d of _tc2324TmpDirs) {
  try { fs.rmSync(d, { recursive: true }); } catch (_) {}
}

// ---------- Summary ----------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
