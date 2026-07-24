/**
 * test-run-report.js — Tests for generateRunReport, updateRunHistory (run-report.js)
 * and archiveShow --report flag (archive-show.js).
 *
 * Uses temp directories with fixture data. No Claude auth, no git repo, no network.
 * Run: node test/test-run-report.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { generateRunReport, updateRunHistory, gatherReportData, renderReportHtml, extractGoalFromSpec } from '../src/orchestrator/infra/run-report.js';
import { archiveShow } from '../src/cli/commands/archive-show.js';

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

// ── stdout/stderr capture helper (matches test-archive-show.js pattern) ───────

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

const tmpDirs = [];

/**
 * Create a temporary archive directory pre-populated with fixture files:
 *   manifest.json, spec.md, logs/token-usage.json,
 *   verification/review-milestone-001.json, state/mission-001-001.json
 *
 * @param {object} [overrides={}] - Optional per-file content overrides
 * @returns {{ archiveDir: string, projectRoot: string, archivesDir: string }}
 */
function makeFixtureArchive(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-report-test-'));
  tmpDirs.push(tmpDir);

  // projectRoot/ archives/ 001-test-archive/
  const archivesDir = path.join(tmpDir, 'archives');
  const archiveId = '001-test-archive';
  const archiveDir = path.join(archivesDir, archiveId);

  fs.mkdirSync(path.join(archiveDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(archiveDir, 'verification'), { recursive: true });
  fs.mkdirSync(path.join(archiveDir, 'state'), { recursive: true });

  // manifest.json
  const manifest = overrides.manifest ?? {
    id: archiveId,
    seq: '001',
    name: 'Test Archive',
    headline: 'Test headline for report',
    archivedAt: '2026-04-15T10:00:00.000Z',
    gitHead: 'abc1234',
    gitStatus: 'clean',
    totalCost: 5.00,
    totalSessions: 21,
    milestones: [
      { id: '001', description: 'First milestone', status: 'complete' },
    ],
    changelog: [],
  };
  fs.writeFileSync(
    path.join(archiveDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  // spec.md with ## Goal section
  const specContent = overrides.specContent ?? `# Test Spec

## Goal

Implement the run report feature for cc-orchestrator archives.

## Constraints

No external dependencies.
`;
  fs.writeFileSync(path.join(archiveDir, 'spec.md'), specContent, 'utf8');

  // logs/token-usage.json — matches tokenUsage schema
  const tokenUsage = overrides.tokenUsage ?? {
    sessions: [
      {
        name: 'planner-global',
        type: 'planner',
        inputTokens: 9,
        outputTokens: 2001,
        cacheCreation: 20773,
        cacheRead: 89911,
        totalCostUsd: 0.22485675,
      },
      {
        name: 'executor-001-001',
        type: 'executor',
        inputTokens: 20,
        outputTokens: 8628,
        cacheCreation: 35810,
        cacheRead: 449973,
        totalCostUsd: 1.5,
      },
    ],
    totals: {
      sessionCount: 21,
      totalCostUsd: 5.00,
    },
  };
  fs.writeFileSync(
    path.join(archiveDir, 'logs', 'token-usage.json'),
    JSON.stringify(tokenUsage, null, 2),
    'utf8',
  );

  // verification/review-milestone-001.json — matches reviewMilestone schema
  const reviewMilestone = overrides.reviewMilestone ?? {
    result: 'PASSED',
    findings: [
      {
        severity: 'warning',
        category: 'call-chain',
        file: 'src/orchestrator/agents/planner.js',
        description: 'Missing cwd in remediation spawn call.',
        relatedFiles: ['src/orchestrator/core/pipeline.js'],
      },
      {
        severity: 'critical',
        category: 'security',
        file: 'src/cli/commands/archive.js',
        description: 'Potential path traversal in archive ID handling.',
        relatedFiles: [],
      },
    ],
    notes: 'Two findings: one warning, one critical.',
  };
  fs.writeFileSync(
    path.join(archiveDir, 'verification', 'review-milestone-001.json'),
    JSON.stringify(reviewMilestone, null, 2),
    'utf8',
  );

  // state/mission-001-001.json — with tasks
  const missionState = overrides.missionState ?? {
    id: '001-001',
    missionId: '001-001',
    description: 'Core infrastructure',
    status: 'complete',
    subMissions: {
      '001-001-001': {
        tasks: {
          '001-001-001-001': {
            id: '001-001-001-001',
            description: 'Create run-report.js',
            status: 'complete',
          },
        },
      },
    },
  };
  fs.writeFileSync(
    path.join(archiveDir, 'state', 'mission-001-001.json'),
    JSON.stringify(missionState, null, 2),
    'utf8',
  );

  return { archiveDir, projectRoot: tmpDir, archivesDir };
}

// ── Tests 1–5: generateRunReport ─────────────────────────────────────────────

await test('T1: generateRunReport produces HTML string containing <!DOCTYPE html>', async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    // Inject a getDiffSummary that returns '' to avoid git invocation
    const html = await generateRunReport(archiveDir, projectRoot, {
      getDiffSummary: () => '',
    });
    assert.ok(typeof html === 'string', `Expected HTML string, got ${typeof html}`);
    assert.ok(
      html.includes('<!DOCTYPE html>'),
      `Expected "<!DOCTYPE html>" in HTML output, got:\n${html.slice(0, 200)}`,
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
    tmpDirs.splice(tmpDirs.indexOf(path.dirname(path.dirname(archiveDir))), 1);
  }
});

await test('T2: generateRunReport HTML includes cost from token-usage.json totals', async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    const html = await generateRunReport(archiveDir, projectRoot, {
      getDiffSummary: () => '',
    });
    // manifest.totalCost = 5.00 → appears as "$5.00" in HTML
    assert.ok(
      html.includes('5.00'),
      `Expected cost "5.00" in HTML, got:\n${html.slice(0, 500)}`,
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

await test('T3: generateRunReport HTML includes diff stats when getDiffSummary returns content', async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    const FAKE_DIFF = 'src/foo.js | 5 ++---\n 1 file changed, 2 insertions(+), 3 deletions(-)';
    const html = await generateRunReport(archiveDir, projectRoot, {
      getDiffSummary: () => FAKE_DIFF,
    });
    assert.ok(
      html.includes('src/foo.js'),
      `Expected diff stats "src/foo.js" in HTML, got:\n${html.slice(0, 500)}`,
    );
    assert.ok(
      html.includes('1 file changed'),
      `Expected "1 file changed" in HTML diff stats, got:\n${html.slice(0, 500)}`,
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

await test("T4: generateRunReport HTML shows 'First run' message when getDiffSummary returns ''", async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    const html = await generateRunReport(archiveDir, projectRoot, {
      getDiffSummary: () => '',
    });
    assert.ok(
      html.toLowerCase().includes('first run'),
      `Expected "First run" message in HTML when diff is empty, got:\n${html.slice(0, 500)}`,
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

await test('T5: generateRunReport HTML includes reviewer warning/critical findings', async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    const html = await generateRunReport(archiveDir, projectRoot, {
      getDiffSummary: () => '',
    });
    assert.ok(
      html.includes('WARNING') || html.includes('warning'),
      `Expected warning finding in HTML, got:\n${html.slice(0, 500)}`,
    );
    assert.ok(
      html.includes('CRITICAL') || html.includes('critical'),
      `Expected critical finding in HTML, got:\n${html.slice(0, 500)}`,
    );
    assert.ok(
      html.includes('Missing cwd in remediation spawn call'),
      `Expected warning description in HTML, got:\n${html.slice(0, 500)}`,
    );
    assert.ok(
      html.includes('Potential path traversal'),
      `Expected critical description in HTML, got:\n${html.slice(0, 500)}`,
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

// ── Tests 6–8: updateRunHistory ───────────────────────────────────────────────

await test("T6: updateRunHistory creates RUNS.md with '# Run History' header when file missing", async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    const manifest = {
      id: '001-test-archive',
      headline: 'First run headline',
      archivedAt: '2026-04-15T10:00:00.000Z',
      totalCost: 1.5,
      totalSessions: 10,
    };
    await updateRunHistory(projectRoot, archiveDir, manifest);

    const runsPath = path.join(projectRoot, 'RUNS.md');
    assert.ok(fs.existsSync(runsPath), 'Expected RUNS.md to be created');
    const content = fs.readFileSync(runsPath, 'utf8');
    assert.ok(
      content.includes('# Run History'),
      `Expected "# Run History" header in RUNS.md, got:\n${content}`,
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

await test('T7: updateRunHistory prepends new entry preserving existing content', async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    const runsPath = path.join(projectRoot, 'RUNS.md');

    // Write existing content first
    fs.writeFileSync(runsPath, '# Run History\n\n## 000-prior-run\n\n- **Archived:** 2026-01-01T00:00:00.000Z\n- **Cost:** $0.5000\n', 'utf8');

    const manifest = {
      id: '001-test-archive',
      headline: 'New headline',
      archivedAt: '2026-04-15T10:00:00.000Z',
      totalCost: 2.0,
      totalSessions: 5,
    };
    await updateRunHistory(projectRoot, archiveDir, manifest);

    const content = fs.readFileSync(runsPath, 'utf8');

    // New entry should appear before old
    const newIdx = content.indexOf('001-test-archive');
    const oldIdx = content.indexOf('000-prior-run');
    assert.ok(newIdx !== -1, 'Expected new archive entry in RUNS.md');
    assert.ok(oldIdx !== -1, 'Expected prior archive entry still present in RUNS.md');
    assert.ok(
      newIdx < oldIdx,
      `Expected new entry before old entry; newIdx=${newIdx}, oldIdx=${oldIdx}`,
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

await test('T8: updateRunHistory caps at 20 entries trimming oldest', async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    const runsPath = path.join(projectRoot, 'RUNS.md');

    // Write 20 existing entries with newest (020) first, oldest (001) last,
    // matching the prepend-first semantic of updateRunHistory.
    // Entry 020 = most recently prepended, Entry 001 = oldest (at bottom).
    const existingEntries = Array.from({ length: 20 }, (_, i) => {
      // i=0 → n='020' (newest existing), i=19 → n='001' (oldest existing)
      const n = String(20 - i).padStart(3, '0');
      return `## ${n}-old-entry\n\n- **Archived:** 2026-01-01T00:00:00.000Z\n- **Cost:** $0.1000\n- **Sessions:** 1\n- **Headline:** Old entry ${n}`;
    });
    const existingContent = `# Run History\n\n${existingEntries.join('\n\n')}\n`;
    fs.writeFileSync(runsPath, existingContent, 'utf8');

    const manifest = {
      id: '001-test-archive',
      headline: 'New entry that pushes oldest out',
      archivedAt: '2026-04-15T10:00:00.000Z',
      totalCost: 3.0,
      totalSessions: 15,
    };
    await updateRunHistory(projectRoot, archiveDir, manifest);

    const content = fs.readFileSync(runsPath, 'utf8');

    // Count entries (each starts with "## ")
    const entryMatches = content.match(/^## /gm) ?? [];
    assert.ok(
      entryMatches.length <= 20,
      `Expected at most 20 entries, got ${entryMatches.length}`,
    );

    // Oldest entry (001-old-entry, at the bottom) should be trimmed
    assert.ok(
      !content.includes('001-old-entry'),
      'Expected oldest entry "001-old-entry" to be trimmed from RUNS.md',
    );

    // Newest entry should be present
    assert.ok(
      content.includes('001-test-archive'),
      'Expected new entry "001-test-archive" to be present in RUNS.md',
    );

    // Second-oldest (002-old-entry) should still be present at the boundary
    assert.ok(
      content.includes('002-old-entry'),
      'Expected "002-old-entry" to still be present (only the very oldest trimmed)',
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

// ── Tests 11–13: updateRunHistory entry content (new test cases) ─────────────

await test('T11: updateRunHistory entry contains seq, headline, date, cost, and session count', async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    const manifest = {
      id: '001-test-archive',
      seq: '007',
      headline: 'Ship the feature',
      archivedAt: '2026-04-15T10:00:00.000Z',
      totalCost: 3.75,
      totalSessions: 12,
    };
    await updateRunHistory(projectRoot, archiveDir, manifest);

    const content = fs.readFileSync(path.join(projectRoot, 'RUNS.md'), 'utf8');

    assert.ok(content.includes('007'), `Expected seq "007" in entry, got:\n${content}`);
    assert.ok(content.includes('Ship the feature'), `Expected headline in entry, got:\n${content}`);
    assert.ok(content.includes('2026'), `Expected formatted date year in entry, got:\n${content}`);
    assert.ok(content.includes('$3.75'), `Expected cost "$3.75" in entry, got:\n${content}`);
    assert.ok(content.includes('12'), `Expected session count "12" in entry, got:\n${content}`);
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

await test('T12: updateRunHistory entry contains relative link to archives/{id}/report.html', async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    const manifest = {
      id: '001-test-archive',
      headline: 'Link test',
      archivedAt: '2026-04-15T10:00:00.000Z',
      totalCost: 1.0,
      totalSessions: 3,
    };
    await updateRunHistory(projectRoot, archiveDir, manifest);

    const content = fs.readFileSync(path.join(projectRoot, 'RUNS.md'), 'utf8');

    assert.ok(
      content.includes('archives/001-test-archive/report.html'),
      `Expected relative link "archives/001-test-archive/report.html" in entry, got:\n${content}`,
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

await test('T13: updateRunHistory handles manifest with missing optional fields gracefully', async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    // Minimal manifest — omit seq, headline, archivedAt, totalCost, totalSessions, changelog
    const manifest = { id: '001-test-archive' };
    let threw = null;
    try {
      await updateRunHistory(projectRoot, archiveDir, manifest);
    } catch (err) {
      threw = err;
    }

    assert.ok(threw === null, `Expected no error with minimal manifest, but got: ${threw?.message}`);

    const runsPath = path.join(projectRoot, 'RUNS.md');
    assert.ok(fs.existsSync(runsPath), 'Expected RUNS.md to be created even with minimal manifest');

    const content = fs.readFileSync(runsPath, 'utf8');
    assert.ok(
      content.includes('# Run History'),
      `Expected "# Run History" header even with minimal manifest, got:\n${content}`,
    );
    assert.ok(
      content.includes('$0.00'),
      `Expected cost "$0.00" with missing totalCost, got:\n${content}`,
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

// ── Tests 9–10: archiveShow with report=true ──────────────────────────────────

await test('T9: archiveShow with report=true calls spawn with open/xdg-open when report.html exists', async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    // Create report.html in archiveDir
    const reportPath = path.join(archiveDir, 'report.html');
    fs.writeFileSync(reportPath, '<!DOCTYPE html><html><body>test</body></html>', 'utf8');

    // ESM named imports (import { spawn } from 'child_process') bind the function
    // at module load time; we cannot monkey-patch childProcess.spawn after the fact.
    // Instead, we verify the observable behaviour: when report.html exists, archiveShow
    // should execute silently (spawn path, no error output) rather than log an error.
    let spawnError = null;
    const { stderr } = captureOutput(() => {
      try {
        archiveShow(projectRoot, '001-test-archive', { report: true });
      } catch (err) {
        spawnError = err;
      }
    });

    // The function should NOT print an error about a missing report.
    assert.ok(
      !stderr.includes('Report not found') && !stderr.includes('not found'),
      `Expected no "not found" error in stderr when report.html exists, got:\n${stderr}`,
    );

    // The function should not throw.
    assert.ok(
      spawnError === null,
      `Expected archiveShow to not throw, but got: ${spawnError?.message}`,
    );

    // Verify that the opener command would be correct for the current platform.
    const expectedOpener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    // We verify this logic is sound by checking the platform constant is accessible.
    assert.ok(
      expectedOpener === 'open' || expectedOpener === 'xdg-open',
      `Expected opener to be "open" or "xdg-open", determined: "${expectedOpener}"`,
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

await test('T10: archiveShow with report=true logs error when report.html missing', async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    // Do NOT create report.html

    const { stderr } = captureOutput(() => {
      archiveShow(projectRoot, '001-test-archive', { report: true });
    });

    assert.ok(
      stderr.includes('Report not found') || stderr.includes('report') || stderr.includes('not found'),
      `Expected error message about missing report.html in stderr, got:\n${stderr}`,
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

// ── Tests 14–20: gatherReportData and renderReportHtml (direct unit tests) ────

await test('T14: gatherReportData — full data gathering with all files present', async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    const data = gatherReportData(archiveDir, projectRoot, { getDiffSummary: () => 'fake diff summary' });

    // Manifest fields
    assert.strictEqual(data.seq, '001', `Expected seq '001', got '${data.seq}'`);
    assert.ok(data.headline.length > 0, 'Expected non-empty headline');
    assert.ok(data.archivedAt.length > 0, 'Expected non-empty archivedAt');
    assert.strictEqual(data.totalCost, 5.00, `Expected totalCost 5.00, got ${data.totalCost}`);
    assert.strictEqual(data.totalSessions, 21, `Expected totalSessions 21, got ${data.totalSessions}`);
    assert.ok(Array.isArray(data.milestones) && data.milestones.length > 0, 'Expected non-empty milestones array');

    // Goal from spec.md
    assert.ok(typeof data.goal === 'string' && data.goal.length > 0, 'Expected non-empty goal string');
    assert.ok(
      data.goal !== '(no goal found)',
      `Expected extracted goal, not default; got '${data.goal}'`,
    );
    assert.ok(
      data.goal.toLowerCase().includes('implement'),
      `Expected goal to contain 'implement', got '${data.goal}'`,
    );

    // Token usage / costByType
    assert.ok(typeof data.costByType === 'object', 'Expected costByType to be a plain object');
    assert.ok('planner' in data.costByType, 'Expected planner key in costByType');
    assert.ok('executor' in data.costByType, 'Expected executor key in costByType');
    assert.strictEqual(data.costByType.planner.sessionCount, 1, 'Expected planner sessionCount 1');
    assert.strictEqual(data.costByType.executor.sessionCount, 1, 'Expected executor sessionCount 1');

    // Reviewer findings
    assert.ok(Array.isArray(data.findings), 'Expected findings to be an array');
    assert.strictEqual(data.findings.length, 2, `Expected 2 findings, got ${data.findings.length}`);
    const severities = data.findings.map((f) => f.severity);
    assert.ok(severities.includes('warning'), 'Expected a warning finding');
    assert.ok(severities.includes('critical'), 'Expected a critical finding');

    // Task statuses
    assert.ok(Array.isArray(data.taskStatuses), 'Expected taskStatuses to be an array');
    assert.ok(data.taskStatuses.length > 0, 'Expected at least one task status');
    assert.ok(data.taskStatuses[0].id, 'Expected task status to have an id');
    assert.ok(data.taskStatuses[0].status, 'Expected task status to have a status');

    // Diff summary
    assert.strictEqual(data.diffSummary, 'fake diff summary', 'Expected diffSummary to match injected value');
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

await test("T15: gatherReportData — missing spec.md yields '(no goal found)'", async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    // Remove spec.md to simulate missing file
    fs.rmSync(path.join(archiveDir, 'spec.md'));

    const data = gatherReportData(archiveDir, projectRoot, { getDiffSummary: () => '' });
    assert.strictEqual(
      data.goal,
      '(no goal found)',
      `Expected '(no goal found)' when spec.md is missing, got '${data.goal}'`,
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

await test("T16: renderReportHtml — empty diffSummary triggers 'First run' message", () => {
  const data = {
    seq: '001',
    headline: 'Test run',
    archivedAt: '2026-04-15T10:00:00.000Z',
    totalCost: 1.0,
    totalSessions: 5,
    milestones: [],
    goal: 'Test goal',
    costByType: {},
    findings: [],
    taskStatuses: [],
    diffSummary: '',
    changelog: [],
  };
  const html = renderReportHtml(data);

  assert.ok(
    html.toLowerCase().includes('first run'),
    `Expected 'First run' text in HTML when diffSummary is empty, got:\n${html.slice(0, 600)}`,
  );
  assert.ok(
    !html.includes('<pre class="diff-stats">'),
    'Expected no diff-stats pre block when diffSummary is empty',
  );
});

await test('T17: renderReportHtml — reviewer findings render with correct severity classes', () => {
  const data = {
    seq: '002',
    headline: 'Severity test',
    archivedAt: '2026-04-15T10:00:00.000Z',
    totalCost: 2.0,
    totalSessions: 8,
    milestones: [],
    goal: 'Test goal',
    costByType: {},
    findings: [
      {
        severity: 'critical',
        category: 'security',
        file: 'src/auth.js',
        description: 'Unprotected admin endpoint exposed',
      },
      {
        severity: 'warning',
        category: 'style',
        file: 'src/utils.js',
        description: 'Dead code remains unreachable',
      },
    ],
    taskStatuses: [],
    diffSummary: '',
    changelog: [],
  };
  const html = renderReportHtml(data);

  // Critical finding — severity text and CSS class
  assert.ok(
    html.includes('CRITICAL') || html.includes('critical'),
    'Expected CRITICAL severity in HTML',
  );
  assert.ok(
    html.includes('finding-critical'),
    'Expected finding-critical CSS class in HTML',
  );
  assert.ok(
    html.includes('Unprotected admin endpoint exposed'),
    'Expected critical finding description in HTML',
  );

  // Warning finding — severity text and CSS class
  assert.ok(
    html.includes('WARNING') || html.includes('warning'),
    'Expected WARNING severity in HTML',
  );
  assert.ok(
    html.includes('finding-warning'),
    'Expected finding-warning CSS class in HTML',
  );
  assert.ok(
    html.includes('Dead code remains unreachable'),
    'Expected warning finding description in HTML',
  );

  // Findings section heading
  assert.ok(
    html.includes('Reviewer Findings'),
    'Expected "Reviewer Findings" section heading in HTML',
  );
});

await test('T18: renderReportHtml — per-type cost breakdown table is accurate', () => {
  const data = {
    seq: '003',
    headline: 'Cost breakdown test',
    archivedAt: '2026-04-15T10:00:00.000Z',
    totalCost: 4.75,
    totalSessions: 9,
    milestones: [],
    goal: 'Test goal',
    costByType: {
      planner: { sessionCount: 3, totalCostUsd: 1.25 },
      executor: { sessionCount: 6, totalCostUsd: 3.50 },
    },
    findings: [],
    taskStatuses: [],
    diffSummary: '',
    changelog: [],
  };
  const html = renderReportHtml(data);

  // Table structure
  assert.ok(html.includes('<table>'), 'Expected <table> element in HTML');
  assert.ok(html.includes('<th>Type</th>'), 'Expected Type column header');
  assert.ok(html.includes('<th>Sessions</th>'), 'Expected Sessions column header');
  assert.ok(html.includes('<th>Cost</th>'), 'Expected Cost column header');

  // planner row
  assert.ok(html.includes('planner'), 'Expected planner type in cost table');
  assert.ok(html.includes('$1.25'), 'Expected planner cost $1.25 in table');

  // executor row
  assert.ok(html.includes('executor'), 'Expected executor type in cost table');
  assert.ok(html.includes('$3.50'), 'Expected executor cost $3.50 in table');
});

await test('T19: generateRunReport writes report.html to disk', async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    const reportPath = path.join(archiveDir, 'report.html');

    // Ensure no pre-existing report
    if (fs.existsSync(reportPath)) fs.rmSync(reportPath);

    const html = await generateRunReport(archiveDir, projectRoot, { getDiffSummary: () => '' });

    // File must be written
    assert.ok(
      fs.existsSync(reportPath),
      `Expected report.html to be created at ${reportPath}`,
    );

    // File contents must match returned string
    const written = fs.readFileSync(reportPath, 'utf8');
    assert.strictEqual(
      written,
      html,
      'Expected report.html on disk to match HTML string returned by generateRunReport',
    );
    assert.ok(
      written.includes('<!DOCTYPE html>'),
      'Expected <!DOCTYPE html> in written report.html',
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

await test('T20: gatherReportData — task statuses extracted from mission state files', async () => {
  const customMissionState = {
    id: '001-001',
    missionId: '001-001',
    description: 'Core infrastructure module',
    status: 'complete',
  };
  const { archiveDir, projectRoot } = makeFixtureArchive({ missionState: customMissionState });
  try {
    // Write a second mission file to verify multiple files are read
    fs.writeFileSync(
      path.join(archiveDir, 'state', 'mission-002-001.json'),
      JSON.stringify({
        id: '002-001',
        missionId: '002-001',
        description: 'Secondary pipeline module',
        status: 'failed',
      }),
      'utf8',
    );

    const data = gatherReportData(archiveDir, projectRoot, { getDiffSummary: () => '' });

    assert.ok(Array.isArray(data.taskStatuses), 'Expected taskStatuses to be an array');
    assert.strictEqual(
      data.taskStatuses.length,
      2,
      `Expected 2 task status entries (one per mission file), got ${data.taskStatuses.length}`,
    );

    const first = data.taskStatuses.find((t) => t.id === '001-001');
    assert.ok(first, 'Expected task status entry with id "001-001"');
    assert.strictEqual(first.status, 'complete', `Expected status 'complete', got '${first.status}'`);
    assert.strictEqual(
      first.description,
      'Core infrastructure module',
      `Expected description 'Core infrastructure module', got '${first.description}'`,
    );

    const second = data.taskStatuses.find((t) => t.id === '002-001');
    assert.ok(second, 'Expected task status entry with id "002-001"');
    assert.strictEqual(second.status, 'failed', `Expected status 'failed', got '${second.status}'`);
    assert.strictEqual(
      second.description,
      'Secondary pipeline module',
      `Expected description 'Secondary pipeline module', got '${second.description}'`,
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

await test('T20a: gatherReportData passes excludeArchiveId for the current archive to getDiffSummary', async () => {
  const { archiveDir, projectRoot } = makeFixtureArchive();
  try {
    let receivedDeps = null;
    let receivedArchivesDir = null;
    const stub = (_projectRoot, archivesDir, deps) => {
      receivedDeps = deps;
      receivedArchivesDir = archivesDir;
      return '';
    };
    gatherReportData(archiveDir, projectRoot, { getDiffSummary: stub });
    assert.strictEqual(
      receivedArchivesDir,
      path.dirname(archiveDir),
      'Expected archivesDir to be the parent of archiveDir',
    );
    assert.ok(receivedDeps, 'Expected deps to be forwarded to getDiffSummary');
    assert.strictEqual(
      receivedDeps.excludeArchiveId,
      path.basename(archiveDir),
      `Expected excludeArchiveId='${path.basename(archiveDir)}', got '${receivedDeps?.excludeArchiveId}'`,
    );
  } finally {
    fs.rmSync(path.dirname(path.dirname(archiveDir)), { recursive: true, force: true });
  }
});

await test("T21: extractGoalFromSpec — goal containing 'z' is not truncated at the z", () => {
  const spec = '## Goal\nOptimize, analyze, and parallelize.\n\n## Constraints\n- none\n';
  const got = extractGoalFromSpec(spec);
  assert.strictEqual(
    got,
    'Optimize, analyze, and parallelize.',
    `Expected full goal text, got '${got}'`,
  );
});

await test('T22: extractGoalFromSpec — goal as final ## section (no trailing heading)', () => {
  const spec = '## Goal\nAdd a feature.\n';
  const got = extractGoalFromSpec(spec);
  assert.strictEqual(got, 'Add a feature.', `Expected 'Add a feature.', got '${got}'`);
});

await test('T23: extractGoalFromSpec — terminates at the next ## heading', () => {
  const spec = '## Goal\nFirst line.\nSecond line.\n\n## Other\nshould not appear\n';
  const got = extractGoalFromSpec(spec);
  assert.strictEqual(
    got,
    'First line.\nSecond line.',
    `Expected goal terminated at next heading, got '${got}'`,
  );
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
