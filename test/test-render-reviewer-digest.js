/**
 * test-render-reviewer-digest.js — Unit tests for Pipeline._renderReviewerDigest()
 *
 * Covers:
 *   TC1 — FAILED result with critical findings → boxed digest
 *   TC2 — PASSED result with warning findings → boxed digest with warnings header
 *   TC3 — Clean PASS (no findings) → single line
 *   TC4 — Finding descriptions > 80 chars are truncated with '…'
 *   TC5 — FAILED path in _executeMilestone calls _renderReviewerDigest (not inline logs)
 *   TC6 — PASSED path with warnings calls _renderReviewerDigest (not inline logs)
 *   TC7 — Post-remediation pass calls _renderReviewerDigest with reReviewResult
 *
 * Run: node test/test-render-reviewer-digest.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { seedPassedSidecars } from './helpers/seed-passed-sidecars.js';

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

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a minimal Pipeline instance with a captured log array.
 * We only need onLog — no real execution.
 */
function makePipelineWithLogs() {
  // We need a minimal projectRoot for Pipeline constructor.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rrd-test-'));
  const harnessDir = path.join(projectRoot, '.harness');
  fs.mkdirSync(harnessDir, { recursive: true });

  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
  });

  const cleanup = () => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return { pipeline, logs, cleanup };
}

/**
 * Create a full integration harness for _executeMilestone tests.
 */
function createIntegrationHarness({ milestoneId = '001', missionId = '001-001' } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rrd-integ-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const taskId = `${missionId}-001-001`;
  const subMissionId = `${missionId}-001`;

  fs.writeFileSync(
    path.join(harnessDir, 'progress', `task-${taskId}.json`),
    JSON.stringify({ taskId, status: 'COMPLETE', affectedFiles: [{ path: 'src/foo.js' }], summary: 'done', testsSummary: '' })
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-${taskId}.json`),
    JSON.stringify({ taskId, verified: true, report: 'ok', result: 'PASSED', hardChecks: [], taskScopeChecks: [], notes: null })
  );
  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: ['src/foo.js'], hardChecks: [], testCases: [] })
  );

  const srcDir = path.join(projectRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'foo.js'), '// src/foo.js\n');

  const missionState = {
    id: missionId, missionId, description: `mission ${missionId}`, status: 'complete',
    subMissions: {
      [subMissionId]: {
        id: subMissionId, description: 'sub', status: 'complete',
        tasks: {
          [taskId]: {
            id: taskId, description: `task ${taskId}`, status: 'complete',
            createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            targetFiles: ['src/foo.js'], dependencies: [], testCases: [],
            tracesScenario: [], patternReferences: [], dataSchemas: [],
            verifyFile: `.harness/verify/task-${taskId}.json`,
            progressFile: `.harness/progress/task-${taskId}.json`,
            verificationFile: `.harness/verification/task-${taskId}.json`,
            retryCount: 0,
          },
        },
      },
    },
  };

  fs.writeFileSync(path.join(harnessDir, 'state', `mission-${missionId}.json`), JSON.stringify(missionState, null, 2));

  // Production reality: every complete leaf task carries a PASSED verification
  // sidecar so the Phase-5 audit does not throw. This fixture already wrote a
  // PASSED sidecar above; the helper is idempotent (skips existing sidecars).
  seedPassedSidecars(harnessDir, missionState);

  const globalState = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId, description: `milestone ${milestoneId}`, status: 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: {
          [missionId]: {
            id: missionId, description: `mission ${missionId}`, status: 'complete',
            stateFile: `.harness/state/mission-${missionId}.json`,
            planFile: `.harness/plan/mission-${missionId}.md`,
          },
        },
      },
    },
  };

  fs.writeFileSync(path.join(harnessDir, 'state.json'), JSON.stringify(globalState, null, 2));

  return { projectRoot, harnessDir, milestoneId, missionId, taskId };
}

function installIntegMocks(pipeline, { reviewerResult }) {
  pipeline.executor = { executeTask: async (task) => ({ status: 'COMPLETE', affectedFiles: task.targetFiles || [] }) };
  pipeline.verifier = {
    verifyTask: async () => ({ verified: true, report: 'mock', structured: { verified: true } }),
  };
  // verifyRegression: the regression gates now call the dedicated method;
  // the mock reuses the same implementation (same id-sniff branches apply).
  pipeline.verifier.verifyRegression = pipeline.verifier.verifyTask;
  pipeline.analyzer = {
    analyzeFailure: async () => ({ eventId: 'e', recommendation: 'human', affectedTasks: [] }),
  };
  pipeline.reviewer = { reviewMilestone: async () => reviewerResult };
  pipeline._collectMilestoneContext = () => ({ modifiedFiles: [], taskDescriptions: [], importGraph: '' });
  // Missions are pre-completed in the harness, so no-op the scheduler
  // executor; control reaches the reviewer gate / _renderReviewerDigest directly.
  pipeline._executeMilestoneParallel = async () => {};
}

// ── TC1: FAILED result → boxed digest ────────────────────────────────

await test('TC1: FAILED result with critical findings → boxed digest', async () => {
  const { pipeline, logs, cleanup } = makePipelineWithLogs();
  try {
    const reviewResult = {
      passed: false,
      findings: [
        { severity: 'critical', file: 'src/foo.js', description: 'missing export' },
        { severity: 'warning',  file: 'src/bar.js', description: 'unused variable' },
      ],
    };

    pipeline._renderReviewerDigest('001', reviewResult);

    const all = logs.join('\n');
    assert.ok(all.includes('┌─ Reviewer FAILED — milestone 001'), `Expected FAILED header. Got:\n${all}`);
    assert.ok(all.includes('│  [critical] src/foo.js: missing export'), `Expected critical finding line. Got:\n${all}`);
    assert.ok(all.includes('│  [warning] src/bar.js: unused variable'), `Expected warning finding line. Got:\n${all}`);
    assert.ok(all.includes('└─ 2 finding(s)'), `Expected footer with 2 finding(s). Got:\n${all}`);
    // Must NOT emit the clean-pass line
    assert.ok(!all.includes('Reviewer passed for milestone'), `Must not emit pass line on FAILED. Got:\n${all}`);
  } finally {
    cleanup();
  }
});

// ── TC2: PASSED with warnings → boxed digest ─────────────────────────

await test('TC2: PASSED result with warning findings → boxed digest with warnings header', async () => {
  const { pipeline, logs, cleanup } = makePipelineWithLogs();
  try {
    const reviewResult = {
      passed: true,
      findings: [
        { severity: 'warning', file: 'src/baz.js', description: 'consider refactor' },
      ],
    };

    pipeline._renderReviewerDigest('002', reviewResult);

    const all = logs.join('\n');
    assert.ok(all.includes('┌─ Reviewer PASSED with findings — milestone 002'), `Expected PASSED-with-findings header. Got:\n${all}`);
    assert.ok(all.includes('│  [warning] src/baz.js: consider refactor'), `Expected warning line. Got:\n${all}`);
    assert.ok(all.includes('└─ 1 finding(s)'), `Expected footer with 1 finding(s). Got:\n${all}`);
    // Must NOT emit the single-line pass
    assert.ok(!all.includes('Reviewer passed for milestone 002.'), `Must not emit plain pass line when there are warnings. Got:\n${all}`);
  } finally {
    cleanup();
  }
});

// ── TC3: Clean PASS → single line ────────────────────────────────────

await test('TC3: Clean PASS (no findings) → single line', async () => {
  const { pipeline, logs, cleanup } = makePipelineWithLogs();
  try {
    const reviewResult = { passed: true, findings: [] };
    pipeline._renderReviewerDigest('003', reviewResult);

    const all = logs.join('\n');
    assert.ok(all.includes('Reviewer passed for milestone 003.'), `Expected single-line pass. Got:\n${all}`);
    assert.ok(!all.includes('┌─'), `Must not emit box for clean pass. Got:\n${all}`);
  } finally {
    cleanup();
  }
});

await test('TC3b: Clean PASS with undefined findings → single line', async () => {
  const { pipeline, logs, cleanup } = makePipelineWithLogs();
  try {
    const reviewResult = { passed: true };
    pipeline._renderReviewerDigest('004', reviewResult);

    const all = logs.join('\n');
    assert.ok(all.includes('Reviewer passed for milestone 004.'), `Expected single-line pass. Got:\n${all}`);
    assert.ok(!all.includes('┌─'), `Must not emit box for clean pass. Got:\n${all}`);
  } finally {
    cleanup();
  }
});

// ── TC4: Truncation ───────────────────────────────────────────────────

await test('TC4: Finding descriptions longer than ~80 chars are truncated with "…"', async () => {
  const { pipeline, logs, cleanup } = makePipelineWithLogs();
  try {
    const longDesc = 'A'.repeat(100); // 100 chars — exceeds the 80-char limit
    const reviewResult = {
      passed: false,
      findings: [{ severity: 'critical', file: 'src/long.js', description: longDesc }],
    };

    pipeline._renderReviewerDigest('005', reviewResult);

    const all = logs.join('\n');
    assert.ok(all.includes('…'), `Expected truncation ellipsis "…". Got:\n${all}`);
    // The line should NOT contain the full 100-char string
    assert.ok(!all.includes(longDesc), `Expected description to be truncated, but full string found. Got:\n${all}`);
    // The truncated slice (first 80 chars) should be present
    assert.ok(all.includes('A'.repeat(80) + '…'), `Expected 80 "A"s followed by "…". Got:\n${all}`);
  } finally {
    cleanup();
  }
});

// ── TC5: FAILED path in _executeMilestone uses _renderReviewerDigest ─

await test('TC5: FAILED path in _executeMilestone calls _renderReviewerDigest (box header in logs)', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
  });

  try {
    const criticalFinding = {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/foo.js',
      description: 'critical issue found',
      relatedFiles: [],
    };

    installIntegMocks(pipeline, {
      reviewerResult: {
        passed: false,
        findings: [criticalFinding],
        structured: { result: 'FAILED', findings: [criticalFinding], notes: '' },
        reportPath: '',
      },
    });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    try {
      await pipeline._executeMilestone(milestoneId, msState);
    } catch { /* expected — analyzer returns human */ }

    const all = logs.join('\n');
    // Must see the boxed FAILED header (not the old inline format)
    assert.ok(
      all.includes(`┌─ Reviewer FAILED — milestone ${milestoneId}`),
      `Expected boxed FAILED header in logs. Got:\n${all}`
    );
    assert.ok(
      all.includes('│  [critical] src/foo.js: critical issue found'),
      `Expected boxed finding line in logs. Got:\n${all}`
    );
    // Must NOT see the old inline format
    assert.ok(
      !all.includes('  Reviewer FAILED for milestone'),
      `Old inline format must not appear. Got:\n${all}`
    );
  } finally {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── TC6: PASSED+warnings path uses _renderReviewerDigest ─────────────

await test('TC6: PASSED path with warnings calls _renderReviewerDigest (box header in logs)', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
  });

  try {
    const warningFinding = {
      severity: 'warning',
      category: 'integration',
      file: 'src/bar.js',
      description: 'minor issue here',
      relatedFiles: [],
    };

    installIntegMocks(pipeline, {
      reviewerResult: {
        passed: true,
        findings: [warningFinding],
        structured: { result: 'PASSED', findings: [warningFinding], notes: '' },
        reportPath: '',
      },
    });

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    await pipeline._executeMilestone(milestoneId, msState);

    const all = logs.join('\n');
    assert.ok(
      all.includes(`┌─ Reviewer PASSED with findings — milestone ${milestoneId}`),
      `Expected boxed PASSED+findings header in logs. Got:\n${all}`
    );
    assert.ok(
      all.includes('│  [warning] src/bar.js: minor issue here'),
      `Expected boxed warning line in logs. Got:\n${all}`
    );
    // Must NOT see old inline format
    assert.ok(
      !all.includes('    [warning]'),
      `Old inline warning format must not appear. Got:\n${all}`
    );
  } finally {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── TC7: Post-remediation pass calls _renderReviewerDigest ───────────

await test('TC7: Post-remediation pass calls _renderReviewerDigest with reReviewResult', async () => {
  const { projectRoot, harnessDir, milestoneId, missionId, taskId } = createIntegrationHarness();
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
  });

  try {
    const criticalFinding = {
      severity: 'critical',
      category: 'call-chain',
      file: 'src/foo.js',
      description: 'needs fix',
      relatedFiles: [],
    };

    const failedResult = {
      passed: false,
      findings: [criticalFinding],
      structured: { result: 'FAILED', findings: [criticalFinding], notes: '' },
      reportPath: '',
    };

    const passedResult = {
      passed: true,
      findings: [],
      structured: { result: 'PASSED', findings: [], notes: '' },
      reportPath: '',
    };

    installIntegMocks(pipeline, { reviewerResult: failedResult });

    // Override analyzer to return 'retry'
    pipeline.analyzer = {
      analyzeFailure: async () => ({ eventId: 'e', recommendation: 'retry', affectedTasks: [] }),
    };

    let reviewCallCount = 0;
    pipeline.reviewer = {
      reviewMilestone: async () => {
        reviewCallCount++;
        return reviewCallCount === 1 ? failedResult : passedResult;
      },
    };

    const subMissionId = `${missionId}-001`;
    pipeline.planner = {
      remediateReviewFindings: async () => ({
        newTasks: [{ id: taskId, subMissionId, description: 'fix it', targetFiles: [] }],
      }),
    };

    // _executeMilestone now asserts no non-terminal tasks before advancing
    // (commit 0466cf0); mark the merged remediation task terminal so the
    // milestone can advance to the post-remediation re-review.
    pipeline._executeAndVerifyTask = async (mId, smId, task) => {
      const statePath = path.join(harnessDir, 'state', `mission-${mId}.json`);
      const mState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const t = mState.subMissions[smId]?.tasks?.[task.id];
      if (t) {
        t.status = 'complete';
        fs.writeFileSync(statePath, JSON.stringify(mState, null, 2));
        // A real _executeAndVerifyTask runs the verifier, which writes a PASSED
        // sidecar before the task reaches 'complete'. Seed one for the merged
        // remediation fix task so the Phase-5 audit does not throw on it.
        seedPassedSidecars(harnessDir, mState);
      }
    };

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    const msState = globalState.milestones[milestoneId];

    await pipeline._executeMilestone(milestoneId, msState);

    const all = logs.join('\n');
    // The post-remediation pass via _renderReviewerDigest(msId, reReviewResult)
    // reReviewResult.passed===true, findings=[] → single-line pass
    const passLineCount = (all.match(/Reviewer passed for milestone/g) || []).length;
    assert.ok(
      passLineCount >= 1,
      `Expected "Reviewer passed for milestone" to appear at least once (post-remediation). Got:\n${all}`
    );
    // Also verify the remediation path was taken (two reviewer calls)
    assert.strictEqual(reviewCallCount, 2, `Expected reviewer called twice (fail then re-review); got ${reviewCallCount}`);
  } finally {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── TC-digest-scope-1: exceeded_scope → boxed WARN ───────────────────

await test('TC-digest-scope-1: exceeded_scope with evidence and exceededFiles → boxed Scope WARN', async () => {
  const { pipeline, logs, cleanup } = makePipelineWithLogs();
  try {
    const reviewResult = {
      passed: false,
      findings: [],
      structured: {
        scopeCompliance: {
          verdict: 'exceeded_scope',
          evidence: 'modified files outside spec',
          exceededFiles: ['src/rogue.js'],
        },
      },
    };

    pipeline._renderReviewerDigest('010', reviewResult);

    const all = logs.join('\n');
    assert.ok(all.includes('┌─ Scope WARN'), `Expected '┌─ Scope WARN'. Got:\n${all}`);
    assert.ok(all.includes('modified files outside spec'), `Expected evidence text. Got:\n${all}`);
    assert.ok(all.includes('exceeded: src/rogue.js'), `Expected 'exceeded: src/rogue.js'. Got:\n${all}`);
    assert.ok(all.includes('└─ end scope'), `Expected '└─ end scope'. Got:\n${all}`);
  } finally {
    cleanup();
  }
});

// ── TC-digest-scope-2: insufficient_scope → single-line INFO ─────────

await test('TC-digest-scope-2: insufficient_scope with evidence → single-line [scope-info]', async () => {
  const { pipeline, logs, cleanup } = makePipelineWithLogs();
  try {
    const reviewResult = {
      passed: false,
      findings: [],
      structured: {
        scopeCompliance: {
          verdict: 'insufficient_scope',
          evidence: 'goal not met',
        },
      },
    };

    pipeline._renderReviewerDigest('011', reviewResult);

    const all = logs.join('\n');
    assert.ok(all.includes('[scope-info]'), `Expected '[scope-info]'. Got:\n${all}`);
    assert.ok(all.includes('goal not met'), `Expected 'goal not met'. Got:\n${all}`);
  } finally {
    cleanup();
  }
});

// ── TC-digest-scope-3: within_scope → renders nothing ────────────────

await test('TC-digest-scope-3: within_scope → no scope output rendered', async () => {
  const { pipeline, logs, cleanup } = makePipelineWithLogs();
  try {
    const reviewResult = {
      passed: true,
      findings: [],
      structured: {
        scopeCompliance: {
          verdict: 'within_scope',
          evidence: 'all good',
        },
      },
    };

    pipeline._renderReviewerDigest('012', reviewResult);

    const all = logs.join('\n');
    assert.ok(!all.includes('Scope WARN'), `Must not emit 'Scope WARN' for within_scope. Got:\n${all}`);
    assert.ok(!all.includes('[scope-info]'), `Must not emit '[scope-info]' for within_scope. Got:\n${all}`);
  } finally {
    cleanup();
  }
});

// ── TC-digest-scope-4: scopeCompliance undefined (legacy) → nothing ──

await test('TC-digest-scope-4: scopeCompliance undefined (legacy) → no scope output rendered', async () => {
  const { pipeline, logs, cleanup } = makePipelineWithLogs();
  try {
    const reviewResult = {
      passed: true,
      findings: [],
      // no `structured` field at all — legacy result
    };

    pipeline._renderReviewerDigest('013', reviewResult);

    const all = logs.join('\n');
    assert.ok(!all.includes('Scope WARN'), `Must not emit 'Scope WARN' for undefined scopeCompliance. Got:\n${all}`);
    assert.ok(!all.includes('[scope-info]'), `Must not emit '[scope-info]' for undefined scopeCompliance. Got:\n${all}`);
  } finally {
    cleanup();
  }
});

// ── TC-digest-scope-5: scope block fires regardless of passed value ───

await test('TC-digest-scope-5: exceeded_scope fires when passed === true (independent of compositional verdict)', async () => {
  const { pipeline, logs, cleanup } = makePipelineWithLogs();
  try {
    const reviewResult = {
      passed: true,   // compositional verdict is PASS
      findings: [],
      structured: {
        scopeCompliance: {
          verdict: 'exceeded_scope',
          evidence: 'scope crept anyway',
          exceededFiles: ['src/extra.js'],
        },
      },
    };

    pipeline._renderReviewerDigest('014', reviewResult);

    const all = logs.join('\n');
    assert.ok(all.includes('┌─ Scope WARN'), `Expected '┌─ Scope WARN' even when passed===true. Got:\n${all}`);
    assert.ok(all.includes('scope crept anyway'), `Expected evidence text. Got:\n${all}`);
    assert.ok(all.includes('exceeded: src/extra.js'), `Expected exceeded file. Got:\n${all}`);
    assert.ok(all.includes('└─ end scope'), `Expected '└─ end scope'. Got:\n${all}`);
  } finally {
    cleanup();
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
