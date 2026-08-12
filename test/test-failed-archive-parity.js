/**
 * test-failed-archive-parity.js — Verifies that generateRunReport() succeeds
 * against a synthetic "failed archive" fixture: a manifest carrying
 * haltReason/haltTaskId and none of the clean-run summary fields (headline,
 * changelog, milestones, totalCost), plus minimal state/ and logs/ dirs and
 * no verification/ dir. Mirrors the fixture-archive + PASS/FAIL harness
 * pattern from test/test-run-report.js.
 *
 * Uses temp directories with fixture data. No Claude auth, no git repo, no
 * network.
 * Run: node test/test-failed-archive-parity.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { generateRunReport } from '../src/orchestrator/infra/run-report.js';

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

// ── Fixture helpers ───────────────────────────────────────────────────────────

const tmpDirs = [];

function cleanup() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
}

/**
 * Create a temporary archive directory shaped like a failed run: manifest.json
 * carries haltReason/haltTaskId and omits the clean-run summary fields
 * (headline, changelog, milestones, totalCost). Only a minimal
 * state/mission-001-001.json and logs/token-usage.json are populated; no
 * verification/ dir is created.
 *
 * @param {object} [overrides={}] - Optional per-file content overrides
 * @returns {{ archiveDir: string, projectRoot: string, archivesDir: string, tmpDir: string }}
 */
function makeFailedArchiveFixture(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-archive-parity-test-'));
  tmpDirs.push(tmpDir);

  const archivesDir = path.join(tmpDir, 'archives');
  const archiveId = '001-test-failed-archive';
  const archiveDir = path.join(archivesDir, archiveId);

  fs.mkdirSync(path.join(archiveDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(archiveDir, 'state'), { recursive: true });
  // Deliberately no verification/ dir.

  // manifest.json — failed-archive shape: haltReason/haltTaskId present,
  // no headline/changelog/milestones/totalCost.
  const manifest = overrides.manifest ?? {
    id: archiveId,
    seq: '001',
    name: 'Test Failed Archive',
    archivedAt: '2026-04-15T10:00:00.000Z',
    gitHead: 'abc1234',
    gitStatus: 'dirty',
    haltReason: 'circuit-breaker',
    haltTaskId: '001-002-003',
  };
  fs.writeFileSync(
    path.join(archiveDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  // logs/token-usage.json — minimal
  const tokenUsage = overrides.tokenUsage ?? {
    sessions: [],
    totals: {
      sessionCount: 0,
      totalCostUsd: 0,
    },
  };
  fs.writeFileSync(
    path.join(archiveDir, 'logs', 'token-usage.json'),
    JSON.stringify(tokenUsage, null, 2),
    'utf8',
  );

  // state/mission-001-001.json — minimal
  const missionState = overrides.missionState ?? {
    id: '001-001',
    missionId: '001-001',
    description: 'Core infrastructure',
    status: 'failed',
  };
  fs.writeFileSync(
    path.join(archiveDir, 'state', 'mission-001-001.json'),
    JSON.stringify(missionState, null, 2),
    'utf8',
  );

  return { archiveDir, projectRoot: tmpDir, archivesDir, tmpDir };
}

/**
 * Create a temporary archive directory shaped like a clean run: manifest.json
 * has no haltReason/haltTaskId, and empty headline/changelog/milestones with
 * totalCost 0. No verification/ dir is created.
 *
 * @returns {{ archiveDir: string, projectRoot: string, archivesDir: string, tmpDir: string }}
 */
function makeCleanShapeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-archive-parity-clean-test-'));
  tmpDirs.push(tmpDir);

  const archivesDir = path.join(tmpDir, 'archives');
  const archiveId = '001-test-clean-archive';
  const archiveDir = path.join(archivesDir, archiveId);

  fs.mkdirSync(path.join(archiveDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(archiveDir, 'state'), { recursive: true });
  // Deliberately no verification/ dir.

  const manifest = {
    id: archiveId,
    seq: '002',
    name: 'Test Clean Archive',
    headline: '',
    archivedAt: '2026-04-15T10:00:00.000Z',
    gitHead: 'def5678',
    gitStatus: 'clean',
    totalCost: 0,
    totalSessions: 0,
    milestones: [],
    changelog: [],
  };
  fs.writeFileSync(
    path.join(archiveDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  const tokenUsage = {
    sessions: [],
    totals: { sessionCount: 0, totalCostUsd: 0 },
  };
  fs.writeFileSync(
    path.join(archiveDir, 'logs', 'token-usage.json'),
    JSON.stringify(tokenUsage, null, 2),
    'utf8',
  );

  const missionState = {
    id: '001-001',
    missionId: '001-001',
    description: 'Core infrastructure',
    status: 'complete',
  };
  fs.writeFileSync(
    path.join(archiveDir, 'state', 'mission-001-001.json'),
    JSON.stringify(missionState, null, 2),
    'utf8',
  );

  return { archiveDir, projectRoot: tmpDir, archivesDir, tmpDir };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

await test('TC1: generateRunReport resolves for failed-archive fixture and writes report.html containing "circuit-breaker"', async () => {
  const { archiveDir, projectRoot } = makeFailedArchiveFixture();
  try {
    const html = await generateRunReport(archiveDir, projectRoot, {
      getDiffSummary: () => '',
    });
    assert.ok(typeof html === 'string', `Expected HTML string, got ${typeof html}`);

    const reportPath = path.join(archiveDir, 'report.html');
    assert.ok(fs.existsSync(reportPath), `Expected report.html to exist at ${reportPath}`);

    const written = fs.readFileSync(reportPath, 'utf8');
    assert.ok(
      written.includes('circuit-breaker'),
      `Expected written report.html to contain "circuit-breaker", got:\n${written.slice(0, 800)}`,
    );
  } finally {
    cleanup();
  }
});

await test("TC2: haltReason with HTML special characters is escaped in report.html (no raw '<b>')", async () => {
  const rawHaltReason = 'halt <b>&\'"';
  const { archiveDir, projectRoot } = makeFailedArchiveFixture({
    manifest: {
      id: '001-test-failed-archive',
      seq: '001',
      name: 'Test Failed Archive',
      archivedAt: '2026-04-15T10:00:00.000Z',
      gitHead: 'abc1234',
      gitStatus: 'dirty',
      haltReason: rawHaltReason,
      haltTaskId: '001-002-003',
    },
  });
  try {
    await generateRunReport(archiveDir, projectRoot, {
      getDiffSummary: () => '',
    });

    const reportPath = path.join(archiveDir, 'report.html');
    const written = fs.readFileSync(reportPath, 'utf8');

    // Escaped rendering of "halt <b>&'\"" — & must be escaped first, then <,
    // then quote/apostrophe characters.
    const escaped = 'halt &lt;b&gt;&amp;&#39;&quot;';
    assert.ok(
      written.includes(escaped),
      `Expected escaped haltReason "${escaped}" in report.html, got:\n${written.slice(0, 1000)}`,
    );
    assert.ok(
      !written.includes('<b>'),
      `Expected no raw "<b>" substring in report.html, got:\n${written.slice(0, 1000)}`,
    );
  } finally {
    cleanup();
  }
});

await test('TC3: generateRunReport resolves for clean-shape fixture (no halt fields, empty summary fields) and writes report.html without throwing', async () => {
  const { archiveDir, projectRoot } = makeCleanShapeFixture();
  try {
    let threw = null;
    let html = null;
    try {
      html = await generateRunReport(archiveDir, projectRoot, {
        getDiffSummary: () => '',
      });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw === null, `Expected generateRunReport to not throw, got: ${threw?.message}`);
    assert.ok(typeof html === 'string', `Expected HTML string, got ${typeof html}`);

    const reportPath = path.join(archiveDir, 'report.html');
    assert.ok(fs.existsSync(reportPath), `Expected report.html to exist at ${reportPath}`);

    const written = fs.readFileSync(reportPath, 'utf8');
    assert.ok(
      !written.includes('Halted'),
      `Expected no halt-reason section text ("Halted") in clean-shape report.html, got:\n${written.slice(0, 800)}`,
    );
  } finally {
    cleanup();
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
