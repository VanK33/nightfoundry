#!/usr/bin/env node
/**
 * test-warnings-ledger.js — Reviewer-warning ledger + triage CLI + batch
 * brainstorm bridge (spec: warnings-ledger.spec.md / .json, Tier C item 10).
 *
 * Written by the INDEPENDENT test author against the spec contract only —
 * concurrently with (and without reading) the implementation. At the pre-fix
 * HEAD (ce322f6) the behavioral cases MUST fail:
 *   - ledger-module cases (TC-L*) fail because
 *     src/orchestrator/core/warnings-ledger.js does not exist (dynamic import
 *     per-case, so the rest of the suite still runs);
 *   - pipeline record-point cases (TC-P1, TC-P2, TC-P4) fail because no
 *     archives/warnings.jsonl is written today;
 *   - CLI cases (TC-C*) fail because `cc-orch warnings …` is an unknown
 *     command (exercised end-to-end by spawning src/cli/index.js, so they are
 *     agnostic to the implementer's internal export names and prove the
 *     index.js wiring at the same time);
 *   - bridge cases (TC-B*) fail because src/cli/commands/warnings.js does not
 *     exist.
 * TC-P3 (fail-soft) is a guard case: it pins that a ledger write failure can
 * never fail the run, and is expected green at both HEADs.
 *
 * Coverage (numbered after the spec's acceptance criteria):
 *   TC-L1  (AC1) — appendWarnings creates archives/ + warnings.jsonl, assigns
 *                  W-001/W-002, status open, createdAt + hash stamped,
 *                  fields round-trip; readLedger agrees with the raw file
 *   TC-L2  (AC1) — sequential ids continue across calls (W-003 next)
 *   TC-L3  (AC2) — same-content re-append vs an OPEN entry is deduped
 *   TC-L4  (AC2) — same-content re-append vs a DEFERRED entry is deduped
 *   TC-L5  (AC2) — after waive/done the same content MAY re-append (fresh id)
 *   TC-L6  (AC4) — readLedger on a missing file → []
 *   TC-L7  (AC4) — a corrupt JSONL line is skipped, good lines survive
 *   TC-L8  (AC5) — resolveEntries multi-id: status + resolvedAt + note
 *                  stamped; unrelated entries untouched
 *   TC-L9  (AC5) — resolveEntries unknown id throws naming it; atomic — the
 *                  known id in the same batch is NOT updated
 *   TC-L10 (AC1) — the content-hash helper is exported and deterministic
 *   TC-P1  (AC1/AC7) — PASSED review with critical+warning+info reaching the
 *                  digest records ONLY warning+info (open, sequential ids)
 *                  and the milestone still completes
 *   TC-P2  (AC2/AC7) — re-driving the same review appends nothing
 *   TC-P3  (AC3) — warnings.jsonl pre-created as a DIRECTORY: the ledger
 *                  write fails but the milestone execution still completes
 *   TC-P4  (AC7/AC2) — remediation flow: first review FAILED (critical+Wa),
 *                  re-review PASSED (Wa+Wb+info) → Wa/Wb/info each recorded
 *                  exactly once, critical never (single-sourced record point
 *                  covers the re-review digest call sites; cross-site dedup)
 *   TC-C1  (AC4) — list with no ledger → honest empty message, exit 0
 *   TC-C2  (AC4) — list default shows open+deferred (id, severity, file,
 *                  truncated description, status); waived/done excluded
 *   TC-C3  (AC4) — list --all includes waived/done
 *   TC-C4  (AC4) — show <id> prints the full entry (full description, note)
 *   TC-C5  (AC4) — show unknown id → non-silent failure naming it
 *   TC-C6  (AC5) — resolve multi-id --waive --note updates the named entries,
 *                  stamps resolvedAt, leaves others untouched
 *   TC-C7  (AC5) — resolve with zero verb flags refused, ledger unchanged
 *   TC-C8  (AC5) — resolve with two verb flags refused, ledger unchanged
 *   TC-C9  (AC5) — resolve unknown id refused naming it, ledger unchanged
 *   TC-B1  (AC6) — brainstorm bridge: injected deps.brainstorm called once
 *                  with a prose goal containing each entry's file +
 *                  description + severity (numbered list), no-tty flag passed
 *                  through; brainstormSlug stamped, status unchanged
 *   TC-B2  (AC6) — unknown id errors BEFORE the seam is invoked
 *   TC-B3  (AC6) — already-done id errors BEFORE the seam is invoked
 *
 * Run: node test/test-warnings-ledger.js
 *
 * Discipline (spec Constraints): only trigger conditions are stubbed — fake
 * reviewResult objects driven through the REAL _executeMilestone reviewer
 * gate (the record path), plain-fs ledger fixtures at the spec-pinned
 * location archives/warnings.jsonl, and an injected deps.brainstorm spy. The
 * ledger module is never stubbed in its own tests.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { seedPassedSidecars } from './helpers/seed-passed-sidecars.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../src/cli/index.js');

// Dynamic-import URLs so a missing module fails the individual case, not the
// whole file, at the pre-fix HEAD.
const LEDGER_MOD_URL = new URL('../src/orchestrator/core/warnings-ledger.js', import.meta.url).href;
const WARNINGS_CMD_URL = new URL('../src/cli/commands/warnings.js', import.meta.url).href;

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

// ── Generic fixture helpers ─────────────────────────────────────────────────

function makeTmpRoot(prefix = 'cc-orch-warnings-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function ledgerPath(root) {
  return path.join(root, 'archives', 'warnings.jsonl');
}

/** Tolerant raw JSONL read — never throws, skips unparseable lines. */
function readLedgerRaw(root) {
  const p = ledgerPath(root);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip */ }
  }
  return out;
}

/**
 * Hand-written ledger FIXTURE (spec-pinned JSONL shape, one entry per line:
 * {id, hash, createdAt, milestone, severity, category, file, description,
 * status, note?, resolvedAt?, brainstormSlug?}). Fixture input only — the
 * dedup/id machinery is always exercised through the real module.
 */
function writeLedgerFixture(root, entries) {
  const dir = path.join(root, 'archives');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    ledgerPath(root),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  );
}

const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

function fixtureEntry(id, {
  status = 'open',
  severity = 'warning',
  category = 'integration',
  file = 'src/fixture.js',
  description = `description for ${id}`,
  milestone = '001',
  createdAt = THREE_DAYS_AGO,
  hash = `fixture-hash-${id}`,
  note,
  resolvedAt,
  brainstormSlug,
} = {}) {
  const entry = { id, hash, createdAt, milestone, severity, category, file, description, status };
  if (note !== undefined) entry.note = note;
  if (resolvedAt !== undefined) entry.resolvedAt = resolvedAt;
  if (brainstormSlug !== undefined) entry.brainstormSlug = brainstormSlug;
  return entry;
}

function assertValidTimestamp(value, label) {
  assert.ok(value, `${label} must be set (got ${JSON.stringify(value)})`);
  assert.ok(
    !Number.isNaN(new Date(value).getTime()),
    `${label} must be a parseable timestamp (got ${JSON.stringify(value)})`
  );
}

// Capture console + process.exitCode around direct command-function calls
// (park-convention commands report errors via console.error + exitCode, not
// throws — the bridge cases accept either).
function captureConsole() {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExitCode = process.exitCode;
  console.log = (...a) => logs.push(a.map(String).join(' '));
  console.error = (...a) => errs.push(a.map(String).join(' '));
  return {
    logs,
    errs,
    restore() {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = origExitCode ?? 0;
    },
  };
}

// ── Pipeline integration fixture (mirrors test-pipeline-reviewer-gate.js) ──

function createIntegrationHarness({ milestoneId = '001', missionId = '001-001' } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'warnings-record-'));
  const harnessDir = path.join(projectRoot, '.harness');

  for (const sub of ['state', 'verification', 'progress', 'logs', 'verify', 'snapshots', 'plan', 'analysis']) {
    fs.mkdirSync(path.join(harnessDir, sub), { recursive: true });
  }

  const taskId = `${missionId}-001-001`;
  const subMissionId = `${missionId}-001`;

  fs.writeFileSync(
    path.join(harnessDir, 'progress', `task-${taskId}.json`),
    JSON.stringify({
      taskId,
      status: 'COMPLETE',
      affectedFiles: [{ path: 'src/foo.js' }],
      summary: 'task completed',
      testsSummary: 'all tests passed',
    })
  );

  fs.writeFileSync(
    path.join(harnessDir, 'verification', `task-${taskId}.json`),
    JSON.stringify({
      taskId,
      verified: true,
      report: 'fake verifier report',
      result: 'PASSED',
      hardChecks: [],
      taskScopeChecks: [],
      notes: null,
    })
  );

  fs.writeFileSync(
    path.join(harnessDir, 'verify', `task-${taskId}.json`),
    JSON.stringify({ taskId, targetFiles: ['src/foo.js'], hardChecks: [], testCases: [] })
  );

  const srcDir = path.join(projectRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'foo.js'), '// src/foo.js\n');

  const missionState = {
    id: missionId,
    missionId,
    description: `mission ${missionId}`,
    status: 'complete',
    subMissions: {
      [subMissionId]: {
        id: subMissionId,
        description: 'sub-mission',
        status: 'complete',
        tasks: {
          [taskId]: {
            id: taskId,
            description: `task ${taskId}`,
            status: 'complete',
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            targetFiles: ['src/foo.js'],
            dependencies: [],
            testCases: [],
            tracesScenario: [],
            patternReferences: [],
            dataSchemas: [],
            verifyFile: `.harness/verify/task-${taskId}.json`,
            progressFile: `.harness/progress/task-${taskId}.json`,
            verificationFile: `.harness/verification/task-${taskId}.json`,
            retryCount: 0,
          },
        },
      },
    },
  };

  fs.writeFileSync(
    path.join(harnessDir, 'state', `mission-${missionId}.json`),
    JSON.stringify(missionState, null, 2)
  );

  // Production reality: every complete leaf task carries a PASSED verification
  // sidecar so the Phase-5 audit does not throw. This fixture already wrote a
  // PASSED sidecar above; the helper is idempotent (skips existing sidecars).
  seedPassedSidecars(harnessDir, missionState);

  const globalState = {
    projectMeta: { prdPath: '', createdAt: new Date().toISOString(), currentPhase: 'executing' },
    globalStatus: 'active',
    milestones: {
      [milestoneId]: {
        id: milestoneId,
        description: `milestone ${milestoneId}`,
        status: 'in_progress',
        planFile: `.harness/plan/milestone-${milestoneId}.md`,
        missions: {
          [missionId]: {
            id: missionId,
            description: `mission ${missionId}`,
            status: 'complete',
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

function makePipeline(projectRoot, extraOpts = {}) {
  const logs = [];
  const pipeline = new Pipeline(projectRoot, {
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    ...extraOpts,
  });
  return { pipeline, logs };
}

function installMocks(pipeline, { reviewerResult, analyzerRecommendation = 'human' }) {
  const trace = { verifyMilestoneCalls: 0, analyzeFailureCalls: 0 };

  pipeline.executor = {
    executeTask: async (task) => ({ status: 'COMPLETE', affectedFiles: task.targetFiles || [] }),
  };

  pipeline.verifier = {
    verifyRegression: async (task) => {
      if (task.id && task.id.startsWith('regression-milestone-')) {
        trace.verifyMilestoneCalls++;
      }
      return { verified: true, report: 'mock regression verifier', structured: { verified: true } };
    },
  };

  pipeline.analyzer = {
    analyzeFailure: async () => {
      trace.analyzeFailureCalls++;
      return { eventId: 'mock-event-001', recommendation: analyzerRecommendation, affectedTasks: [] };
    },
  };

  pipeline.reviewer = {
    reviewMilestone: async () => reviewerResult,
  };

  pipeline._collectMilestoneContext = () => ({
    modifiedFiles: [],
    taskDescriptions: [],
    importGraph: '',
  });

  pipeline._executeMilestoneParallel = async () => {};

  return trace;
}

/** Drive one PASSED-with-findings review through the real reviewer gate. */
async function driveReview(projectRoot, harnessDir, milestoneId, findings) {
  const { pipeline } = makePipeline(projectRoot);
  const reviewerResult = {
    passed: true,
    findings,
    structured: { result: 'PASSED', findings, notes: '' },
    reportPath: '',
  };
  const trace = installMocks(pipeline, { reviewerResult });
  const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
  await pipeline._executeMilestone(milestoneId, globalState.milestones[milestoneId]);
  return trace;
}

// ── CLI runner (mirrors test-cli-park.js) ───────────────────────────────────

function runCli(root, args) {
  const res = spawnSync('node', [CLI_PATH, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    out: `${res.stdout || ''}\n${res.stderr || ''}`,
  };
}

function assertNonSilentFailure(res, label) {
  assert.ok(
    res.status !== 0 || res.stderr.trim().length > 0,
    `${label}: the refusal must be observable (non-zero exit or stderr); got exit ${res.status} with empty stderr`
  );
}

// ── Brainstorm-bridge entry resolution (shape-tolerant) ─────────────────────

/**
 * The spec pins the SEAM (deps.brainstorm) and the CLI surface, not the
 * export name. Resolve the bridge function tolerantly: prefer a named export
 * containing 'brainstorm'; fall back to a generic command entry that takes
 * the subcommand in its args array.
 */
async function loadBridgeEntry() {
  const mod = await import(WARNINGS_CMD_URL);
  const candidates = Object.entries(mod).filter(
    ([name, value]) => typeof value === 'function' && /brainstorm/i.test(name)
  );
  if (candidates.length > 0) {
    // Prefer the command entry over pure helpers (e.g. a goal-synthesis
    // function): command-ish names score up, helper-ish names score down,
    // and a (projectRoot, ids, flags, deps) signature outranks (entries).
    const score = ([name, fn]) =>
      (/warnings|bridge|command|cmd/i.test(name) ? 4 : 0) +
      (/synth|goal|prose|render|format/i.test(name) ? -4 : 0) +
      Math.min(fn.length, 4);
    candidates.sort((a, b) => score(b) - score(a));
    const [name, fn] = candidates[0];
    return { kind: 'named', fn, name };
  }
  const generic = mod.default ?? mod.warnings ?? mod.warningsCommand ?? mod.command;
  if (typeof generic === 'function') return { kind: 'generic', fn: generic, name: 'generic entry' };
  throw new Error(
    `src/cli/commands/warnings.js must export the brainstorm bridge ` +
    `(a function whose name contains 'brainstorm', or a generic command entry); ` +
    `exports found: [${Object.keys(mod).join(', ')}]`
  );
}

async function invokeBridge(entry, root, ids, flags, deps) {
  if (entry.kind === 'named') return entry.fn(root, ids, flags, deps);
  return entry.fn(root, ['brainstorm', ...ids], flags, deps);
}

function makeBrainstormSpy(result = { slug: 'fake-slug' }) {
  const calls = [];
  const spy = async (...args) => {
    calls.push(args);
    return result;
  };
  return { spy, calls };
}

/** Collect every string reachable in the spy's call args (prose lives there). */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  return out;
}

/** True when any plain-object arg carries a truthy no-tty flag. */
function sawNoTtyFlag(args) {
  for (const a of args) {
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      if (a['no-tty'] || a.noTty) return true;
    }
  }
  return false;
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function run() {

// ════════════════════════════════════════════════════════════════════════════
// Ledger module (real module, real fs — never stubbed)
// ════════════════════════════════════════════════════════════════════════════

await test('TC-L1 (AC1): appendWarnings creates archives/warnings.jsonl with W-001/W-002, status open, hash + createdAt', async () => {
  const { appendWarnings, readLedger } = await import(LEDGER_MOD_URL);
  const root = makeTmpRoot();
  try {
    assert.ok(!fs.existsSync(path.join(root, 'archives')), 'precondition: archives/ absent');

    await appendWarnings(root, [
      { milestone: '001', severity: 'warning', category: 'integration', file: 'src/a.js', description: 'first warning A' },
      { milestone: '001', severity: 'info', category: 'docs', file: 'src/b.js', description: 'second finding B' },
    ]);

    assert.ok(fs.existsSync(ledgerPath(root)), 'archives/warnings.jsonl must be created (archives/ included)');

    const raw = readLedgerRaw(root);
    assert.strictEqual(raw.length, 2, `expected 2 entries; got ${raw.length}`);
    assert.deepStrictEqual(raw.map((e) => e.id), ['W-001', 'W-002'], 'sequential W-NNN ids');

    for (const e of raw) {
      assert.strictEqual(e.status, 'open', `entry ${e.id} must start open; got ${e.status}`);
      assert.ok(typeof e.hash === 'string' && e.hash.length > 0, `entry ${e.id} must carry a content hash`);
      assertValidTimestamp(e.createdAt, `entry ${e.id} createdAt`);
    }

    const first = raw.find((e) => e.id === 'W-001');
    assert.strictEqual(first.severity, 'warning');
    assert.strictEqual(first.category, 'integration');
    assert.strictEqual(first.file, 'src/a.js');
    assert.strictEqual(first.description, 'first warning A');
    assert.ok(String(first.milestone).includes('001'), `milestone must round-trip; got ${JSON.stringify(first.milestone)}`);

    // Module read path agrees with the raw file.
    const viaModule = await readLedger(root);
    assert.strictEqual(viaModule.length, 2, 'readLedger must return both entries');
    assert.deepStrictEqual(viaModule.map((e) => e.id).sort(), ['W-001', 'W-002']);
  } finally {
    cleanup(root);
  }
});

await test('TC-L2 (AC1): sequential ids continue across appendWarnings calls (next is W-003)', async () => {
  const { appendWarnings } = await import(LEDGER_MOD_URL);
  const root = makeTmpRoot();
  try {
    await appendWarnings(root, [
      { milestone: '001', severity: 'warning', category: 'integration', file: 'src/a.js', description: 'warning one' },
      { milestone: '001', severity: 'info', category: 'docs', file: 'src/b.js', description: 'info two' },
    ]);
    await appendWarnings(root, [
      { milestone: '002', severity: 'warning', category: 'style', file: 'src/c.js', description: 'warning three (new call)' },
    ]);

    const raw = readLedgerRaw(root);
    assert.strictEqual(raw.length, 3, `expected 3 entries after two calls; got ${raw.length}`);
    const third = raw.find((e) => e.description === 'warning three (new call)');
    assert.ok(third, 'third entry must be appended');
    assert.strictEqual(third.id, 'W-003', `ids must continue by scanning existing lines; got ${third.id}`);
  } finally {
    cleanup(root);
  }
});

await test('TC-L3 (AC2): same-content re-append against an OPEN entry is deduped (no duplicate)', async () => {
  const { appendWarnings } = await import(LEDGER_MOD_URL);
  const root = makeTmpRoot();
  const finding = { milestone: '001', severity: 'warning', category: 'integration', file: 'src/dup.js', description: 'duplicate-prone warning' };
  try {
    await appendWarnings(root, [finding]);
    await appendWarnings(root, [{ ...finding }]);

    const raw = readLedgerRaw(root);
    assert.strictEqual(raw.length, 1, `re-appending identical content vs an open entry must not duplicate; got ${raw.length} entries`);
    assert.strictEqual(raw[0].id, 'W-001');
  } finally {
    cleanup(root);
  }
});

await test('TC-L4 (AC2): same-content re-append against a DEFERRED entry is also deduped', async () => {
  const { appendWarnings, resolveEntries } = await import(LEDGER_MOD_URL);
  const root = makeTmpRoot();
  const finding = { milestone: '001', severity: 'warning', category: 'integration', file: 'src/dup.js', description: 'deferred duplicate-prone warning' };
  try {
    await appendWarnings(root, [finding]);
    await resolveEntries(root, ['W-001'], { status: 'deferred' });

    await appendWarnings(root, [{ ...finding }]);

    const raw = readLedgerRaw(root);
    assert.strictEqual(raw.length, 1, `dedup must hold against deferred entries too; got ${raw.length} entries`);
    assert.strictEqual(raw[0].status, 'deferred');
  } finally {
    cleanup(root);
  }
});

await test('TC-L5 (AC2): after the entry is waived (or done), the same content may be re-appended with a fresh id', async () => {
  const { appendWarnings, resolveEntries } = await import(LEDGER_MOD_URL);
  const root = makeTmpRoot();
  const finding = { milestone: '001', severity: 'warning', category: 'integration', file: 'src/dup.js', description: 'recurring warning after waive' };
  try {
    await appendWarnings(root, [finding]);
    await resolveEntries(root, ['W-001'], { status: 'waived' });

    // Dedup is specified "vs open/deferred" — a waived same-hash entry must
    // not block recording the recurrence.
    await appendWarnings(root, [{ ...finding }]);

    const raw = readLedgerRaw(root);
    assert.strictEqual(raw.length, 2, `same content must re-append once the prior entry is waived; got ${raw.length} entries`);
    const fresh = raw.find((e) => e.id !== 'W-001');
    assert.ok(fresh, 'a second entry must exist');
    assert.strictEqual(fresh.id, 'W-002', `fresh sequential id expected; got ${fresh.id}`);
    assert.strictEqual(fresh.status, 'open', 'the recurrence starts open again');
  } finally {
    cleanup(root);
  }
});

await test('TC-L6 (AC4): readLedger on a missing file returns []', async () => {
  const { readLedger } = await import(LEDGER_MOD_URL);
  const root = makeTmpRoot();
  try {
    const entries = await readLedger(root);
    assert.ok(Array.isArray(entries), 'readLedger must return an array');
    assert.strictEqual(entries.length, 0, `expected [] on missing ledger; got ${entries.length} entries`);
  } finally {
    cleanup(root);
  }
});

await test('TC-L7 (AC4): a corrupt JSONL line is skipped — parseable entries survive', async () => {
  const { readLedger } = await import(LEDGER_MOD_URL);
  const root = makeTmpRoot();
  try {
    const good1 = fixtureEntry('W-001', { description: 'good entry one' });
    const good2 = fixtureEntry('W-002', { severity: 'info', description: 'good entry two' });
    fs.mkdirSync(path.join(root, 'archives'), { recursive: true });
    fs.writeFileSync(
      ledgerPath(root),
      `${JSON.stringify(good1)}\n{this is not json at all\n${JSON.stringify(good2)}\n`
    );

    const entries = await readLedger(root);
    assert.strictEqual(entries.length, 2, `corrupt line must be skipped, not fatal; got ${entries.length} entries`);
    assert.deepStrictEqual(entries.map((e) => e.id).sort(), ['W-001', 'W-002']);
  } finally {
    cleanup(root);
  }
});

await test('TC-L8 (AC5): resolveEntries multi-id updates status, stamps resolvedAt, stores note; others untouched', async () => {
  const { appendWarnings, resolveEntries } = await import(LEDGER_MOD_URL);
  const root = makeTmpRoot();
  try {
    await appendWarnings(root, [
      { milestone: '001', severity: 'warning', category: 'integration', file: 'src/a.js', description: 'resolve me A' },
      { milestone: '001', severity: 'info', category: 'docs', file: 'src/b.js', description: 'resolve me B' },
      { milestone: '001', severity: 'warning', category: 'style', file: 'src/c.js', description: 'leave me open C' },
    ]);

    await resolveEntries(root, ['W-001', 'W-002'], { status: 'waived', note: 'cosmetic, accepted' });

    const raw = readLedgerRaw(root);
    assert.strictEqual(raw.length, 3, 'resolve must rewrite, never drop entries');

    for (const id of ['W-001', 'W-002']) {
      const e = raw.find((x) => x.id === id);
      assert.strictEqual(e.status, 'waived', `${id} must be waived; got ${e.status}`);
      assertValidTimestamp(e.resolvedAt, `${id} resolvedAt`);
      assert.strictEqual(e.note, 'cosmetic, accepted', `${id} must carry the note`);
    }

    const untouched = raw.find((x) => x.id === 'W-003');
    assert.strictEqual(untouched.status, 'open', 'unnamed entries must be untouched');
    assert.ok(!untouched.resolvedAt, 'unnamed entries must not be stamped resolvedAt');
  } finally {
    cleanup(root);
  }
});

await test('TC-L9 (AC5): resolveEntries unknown id throws naming it; atomic — the known id in the batch is NOT updated', async () => {
  const { appendWarnings, resolveEntries } = await import(LEDGER_MOD_URL);
  const root = makeTmpRoot();
  try {
    await appendWarnings(root, [
      { milestone: '001', severity: 'warning', category: 'integration', file: 'src/a.js', description: 'survives failed batch' },
    ]);

    let err = null;
    try {
      await resolveEntries(root, ['W-001', 'W-999'], { status: 'done' });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'resolveEntries must error on an unknown id');
    assert.ok(
      String(err.message).includes('W-999'),
      `the error must name the unknown id W-999; got: ${err.message}`
    );

    const w1 = readLedgerRaw(root).find((e) => e.id === 'W-001');
    assert.strictEqual(
      w1.status,
      'open',
      `atomic rewrite: the known id must NOT be partially updated when the batch fails; got status ${w1.status}`
    );
    assert.ok(!w1.resolvedAt, 'atomic rewrite: no resolvedAt may leak from the failed batch');
  } finally {
    cleanup(root);
  }
});

await test('TC-L10 (AC1): the content-hash helper is exported and deterministic', async () => {
  const mod = await import(LEDGER_MOD_URL);
  const hashExports = Object.entries(mod).filter(
    ([name, value]) => typeof value === 'function' && /hash/i.test(name)
  );
  assert.ok(
    hashExports.length >= 1,
    `the spec pins a hash helper export; function exports found: [${Object.keys(mod).join(', ')}]`
  );
  const [, hashFn] = hashExports[0];
  const sample = { milestone: '001', severity: 'warning', category: 'integration', file: 'src/x.js', description: 'hash determinism probe' };
  const a = hashFn({ ...sample });
  const b = hashFn({ ...sample });
  assert.ok(a !== undefined && a !== null && a !== '', 'hash helper must return a value');
  assert.deepStrictEqual(a, b, 'a content hash must be deterministic for identical content');
});

// ════════════════════════════════════════════════════════════════════════════
// Pipeline record point — fake reviewResults through the REAL reviewer gate
// ════════════════════════════════════════════════════════════════════════════

const FINDING_CRITICAL = {
  severity: 'critical',
  category: 'call-chain',
  file: 'src/critical.js',
  description: 'CRITICAL-MARKER must never reach the ledger',
  relatedFiles: [],
};
const FINDING_WARNING = {
  severity: 'warning',
  category: 'integration',
  file: 'src/warned.js',
  description: 'WARNING-MARKER recorded warning',
  relatedFiles: [],
};
const FINDING_INFO = {
  severity: 'info',
  category: 'docs',
  file: 'src/informed.js',
  description: 'INFO-MARKER recorded info',
  relatedFiles: [],
};

await test('TC-P1 (AC1/AC7): PASSED review with critical+warning+info → ledger holds ONLY warning+info (open, W-001/W-002); run completes', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  try {
    const trace = await driveReview(projectRoot, harnessDir, milestoneId, [
      FINDING_CRITICAL, FINDING_WARNING, FINDING_INFO,
    ]);

    assert.strictEqual(trace.verifyMilestoneCalls, 1, 'milestone must still complete (regression ran)');

    assert.ok(
      fs.existsSync(ledgerPath(projectRoot)),
      'archives/warnings.jsonl must appear in the project root after the digest renders (red at pre-fix HEAD)'
    );

    const raw = readLedgerRaw(projectRoot);
    assert.strictEqual(raw.length, 2, `exactly the warning+info findings must be recorded; got ${raw.length} entries`);
    assert.deepStrictEqual(raw.map((e) => e.id).sort(), ['W-001', 'W-002'], 'sequential ids');
    assert.deepStrictEqual(raw.map((e) => e.severity).sort(), ['info', 'warning'], 'one warning + one info');

    for (const e of raw) {
      assert.strictEqual(e.status, 'open', `recorded entries start open; ${e.id} got ${e.status}`);
      assert.notStrictEqual(e.severity, 'critical', 'criticals have their own remediation loop — never recorded');
      assertValidTimestamp(e.createdAt, `${e.id} createdAt`);
      assert.ok(String(e.milestone).includes(milestoneId), `${e.id} must carry the milestone; got ${JSON.stringify(e.milestone)}`);
    }

    const content = fs.readFileSync(ledgerPath(projectRoot), 'utf8');
    assert.ok(content.includes('WARNING-MARKER'), 'warning finding recorded');
    assert.ok(content.includes('INFO-MARKER'), 'info finding recorded');
    assert.ok(!content.includes('CRITICAL-MARKER'), 'critical finding must NOT be recorded');
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC-P2 (AC2/AC7): re-driving the same review (resumed-run re-render) appends nothing', async () => {
  const { projectRoot, harnessDir, milestoneId, missionId } = createIntegrationHarness();
  try {
    const stateJsonPath = path.join(harnessDir, 'state.json');
    const missionStatePath = path.join(harnessDir, 'state', `mission-${missionId}.json`);
    const snapshots = [stateJsonPath, missionStatePath].map((p) => [p, fs.readFileSync(p, 'utf8')]);

    await driveReview(projectRoot, harnessDir, milestoneId, [FINDING_WARNING, FINDING_INFO]);
    assert.strictEqual(readLedgerRaw(projectRoot).length, 2, 'first pass records both findings');

    // Restore harness state and re-drive the identical review — the dedup
    // must absorb the re-render without double-recording.
    for (const [p, content] of snapshots) fs.writeFileSync(p, content);
    await driveReview(projectRoot, harnessDir, milestoneId, [FINDING_WARNING, FINDING_INFO]);

    const raw = readLedgerRaw(projectRoot);
    assert.strictEqual(
      raw.length,
      2,
      `re-recording the same findings must not duplicate (content-hash dedup); got ${raw.length} entries`
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC-P3 (AC3): ledger write failure (warnings.jsonl is a directory) is fail-soft — the milestone still completes', async () => {
  const { projectRoot, harnessDir, milestoneId } = createIntegrationHarness();
  try {
    // Sabotage the write target: a DIRECTORY at the ledger path makes any
    // append/write throw (EISDIR). Recording must log and move on.
    fs.mkdirSync(ledgerPath(projectRoot), { recursive: true });

    const trace = await driveReview(projectRoot, harnessDir, milestoneId, [FINDING_WARNING]);

    assert.strictEqual(
      trace.verifyMilestoneCalls,
      1,
      'a ledger write error must never fail the run — regression must still execute'
    );
  } finally {
    cleanup(projectRoot);
  }
});

await test('TC-P4 (AC7/AC2): remediation re-review path records through the same single-sourced point — Wa/Wb/info once each, no critical', async () => {
  const { projectRoot, harnessDir, milestoneId, missionId, taskId } = createIntegrationHarness();
  const { pipeline } = makePipeline(projectRoot);
  try {
    const wa = { severity: 'warning', category: 'integration', file: 'src/wa.js', description: 'WA-MARKER warning seen by both reviews', relatedFiles: [] };
    const wb = { severity: 'warning', category: 'style', file: 'src/wb.js', description: 'WB-MARKER warning only the re-review raises', relatedFiles: [] };
    const inf = { severity: 'info', category: 'docs', file: 'src/inf.js', description: 'REREVIEW-INFO-MARKER info from the re-review', relatedFiles: [] };

    const failedResult = {
      passed: false,
      findings: [FINDING_CRITICAL, wa],
      structured: { result: 'FAILED', findings: [FINDING_CRITICAL, wa], notes: '' },
      reportPath: '',
    };
    const passedResult = {
      passed: true,
      findings: [wa, wb, inf],
      structured: { result: 'PASSED', findings: [wa, wb, inf], notes: '' },
      reportPath: '',
    };

    installMocks(pipeline, { reviewerResult: failedResult, analyzerRecommendation: 'retry' });

    let reviewCalls = 0;
    pipeline.reviewer = {
      reviewMilestone: async () => {
        reviewCalls++;
        return reviewCalls === 1 ? failedResult : passedResult;
      },
    };

    // Planner returns the existing task so the remediation merge re-pends it
    // (mirrors test-pipeline-reviewer-gate.js TC-retry-1).
    const subMissionId = `${missionId}-001`;
    pipeline.planner = {
      remediateReviewFindings: async () => ({
        newTasks: [{ id: taskId, subMissionId, description: 'fix critical finding', targetFiles: [] }],
      }),
    };

    pipeline._executeAndVerifyTask = async (mId, smId, task) => {
      const stateFile = path.join(harnessDir, 'state', `mission-${mId}.json`);
      const ms = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const t = ms.subMissions[smId]?.tasks[task.id];
      if (t) {
        t.status = 'complete';
        fs.writeFileSync(stateFile, JSON.stringify(ms, null, 2));
        // A real _executeAndVerifyTask runs the verifier, which writes a PASSED
        // sidecar before the task reaches 'complete'. Seed one for the merged
        // remediation fix task so the Phase-5 audit does not throw on it.
        seedPassedSidecars(harnessDir, ms);
      }
    };

    const globalState = JSON.parse(fs.readFileSync(path.join(harnessDir, 'state.json'), 'utf8'));
    await pipeline._executeMilestone(milestoneId, globalState.milestones[milestoneId]);

    assert.strictEqual(reviewCalls, 2, `expected initial review + re-review; got ${reviewCalls}`);

    const raw = readLedgerRaw(projectRoot);
    const count = (marker) => raw.filter((e) => String(e.description).includes(marker)).length;

    assert.strictEqual(count('WA-MARKER'), 1, `Wa flows through both digests but must be recorded exactly once; got ${count('WA-MARKER')}`);
    assert.strictEqual(count('WB-MARKER'), 1, `the re-review digest call site must also record (single-sourced point); got ${count('WB-MARKER')}`);
    assert.strictEqual(count('REREVIEW-INFO-MARKER'), 1, `re-review info must be recorded once; got ${count('REREVIEW-INFO-MARKER')}`);
    assert.strictEqual(count('CRITICAL-MARKER'), 0, 'criticals are never recorded — on any call site');
    assert.strictEqual(raw.length, 3, `exactly Wa+Wb+info expected; got ${raw.length} entries`);
  } finally {
    cleanup(projectRoot);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Triage CLI — end-to-end through src/cli/index.js (export-name agnostic,
// proves the wiring; readable without a TTY by construction of spawnSync)
// ════════════════════════════════════════════════════════════════════════════

// 300-char description: 'list' must truncate it (spec: "truncated
// description"); the head marker must show, the tail marker must not.
const LONG_DESCRIPTION =
  'LIST-HEAD-MARKER reviewer digest rot warning ' + 'x'.repeat(230) + ' LIST-TAIL-MARKER-END';

function writeCliFixture(root) {
  writeLedgerFixture(root, [
    fixtureEntry('W-001', { status: 'open', severity: 'warning', file: 'src/open-one.js', description: LONG_DESCRIPTION }),
    fixtureEntry('W-002', { status: 'deferred', severity: 'info', file: 'src/deferred-two.js', description: 'deferred info entry' }),
    fixtureEntry('W-003', { status: 'waived', severity: 'warning', file: 'src/waived-three.js', description: 'waived warning full text SHOW-FULL-MARKER-END', note: 'why waived note', resolvedAt: THREE_DAYS_AGO }),
    fixtureEntry('W-004', { status: 'done', severity: 'info', file: 'src/done-four.js', description: 'done info entry', resolvedAt: THREE_DAYS_AGO }),
    fixtureEntry('W-005', { status: 'open', severity: 'warning', file: 'src/open-five.js', description: 'second open entry' }),
  ]);
}

await test('TC-C1 (AC4): warnings list with no ledger → honest empty message, exit 0', async () => {
  const root = makeTmpRoot('cc-orch-warnings-cli-');
  try {
    const res = runCli(root, ['warnings', 'list']);
    assert.strictEqual(res.status, 0, `empty/missing ledger must exit 0; got ${res.status}\n${res.out}`);
    assert.ok(
      /no\b|empty|0 /i.test(res.stdout),
      `expected an honest empty message on stdout; got: ${JSON.stringify(res.stdout)}`
    );
  } finally {
    cleanup(root);
  }
});

await test('TC-C2 (AC4): warnings list default → open+deferred with id/severity/file/status, description truncated; waived/done excluded', async () => {
  const root = makeTmpRoot('cc-orch-warnings-cli-');
  try {
    writeCliFixture(root);
    const res = runCli(root, ['warnings', 'list']);
    assert.strictEqual(res.status, 0, `list must exit 0; got ${res.status}\n${res.out}`);

    for (const visible of ['W-001', 'W-002', 'W-005']) {
      assert.ok(res.stdout.includes(visible), `open/deferred entry ${visible} must be listed.\n${res.stdout}`);
    }
    for (const hidden of ['W-003', 'W-004']) {
      assert.ok(!res.stdout.includes(hidden), `${hidden} (waived/done) must be hidden without --all.\n${res.stdout}`);
    }

    // Documented columns: severity, file, status (id asserted above).
    assert.ok(/warning/i.test(res.stdout), 'severity column (warning) expected');
    assert.ok(/info/i.test(res.stdout), 'severity column (info) expected');
    assert.ok(res.stdout.includes('src/open-one.js'), 'file column expected');
    assert.ok(/open/i.test(res.stdout), 'status column (open) expected');
    assert.ok(/deferred/i.test(res.stdout), 'status column (deferred) expected');

    // Truncated description: head shows, the 300-char tail does not.
    assert.ok(res.stdout.includes('LIST-HEAD-MARKER'), 'description head must be shown');
    assert.ok(
      !res.stdout.includes('LIST-TAIL-MARKER-END'),
      'a 300-char description must be truncated in the list view, not dumped whole'
    );
  } finally {
    cleanup(root);
  }
});

await test('TC-C3 (AC4): warnings list --all includes waived and done entries', async () => {
  const root = makeTmpRoot('cc-orch-warnings-cli-');
  try {
    writeCliFixture(root);
    const res = runCli(root, ['warnings', 'list', '--all']);
    assert.strictEqual(res.status, 0, `list --all must exit 0; got ${res.status}\n${res.out}`);
    for (const id of ['W-001', 'W-002', 'W-003', 'W-004', 'W-005']) {
      assert.ok(res.stdout.includes(id), `--all must include ${id}.\n${res.stdout}`);
    }
    assert.ok(/waived/i.test(res.stdout), 'waived status visible under --all');
    assert.ok(/done/i.test(res.stdout), 'done status visible under --all');
  } finally {
    cleanup(root);
  }
});

await test('TC-C4 (AC4): warnings show <id> prints the full entry (untruncated description, status, note)', async () => {
  const root = makeTmpRoot('cc-orch-warnings-cli-');
  try {
    writeCliFixture(root);
    const res = runCli(root, ['warnings', 'show', 'W-003']);
    assert.strictEqual(res.status, 0, `show must exit 0; got ${res.status}\n${res.out}`);
    assert.ok(res.stdout.includes('W-003'), 'show must print the id');
    assert.ok(res.stdout.includes('SHOW-FULL-MARKER-END'), 'show must print the FULL description');
    assert.ok(res.stdout.includes('src/waived-three.js'), 'show must print the file');
    assert.ok(/waived/i.test(res.stdout), 'show must print the status');
    assert.ok(res.stdout.includes('why waived note'), 'show must print the note');
  } finally {
    cleanup(root);
  }
});

await test('TC-C5 (AC4): warnings show on an unknown id fails non-silently, naming it', async () => {
  const root = makeTmpRoot('cc-orch-warnings-cli-');
  try {
    writeCliFixture(root);
    const res = runCli(root, ['warnings', 'show', 'W-404']);
    assertNonSilentFailure(res, 'show unknown id');
    assert.ok(res.out.includes('W-404'), `the error must name the unknown id W-404.\n${res.out}`);
  } finally {
    cleanup(root);
  }
});

await test('TC-C6 (AC5): warnings resolve <id> <id> --waive --note → both updated, resolvedAt stamped, others untouched', async () => {
  const root = makeTmpRoot('cc-orch-warnings-cli-');
  try {
    writeCliFixture(root);
    const res = runCli(root, ['warnings', 'resolve', 'W-001', 'W-005', '--waive', '--note', 'batch waived from CLI']);
    assert.strictEqual(res.status, 0, `multi-id resolve must succeed; got exit ${res.status}\n${res.out}`);

    const raw = readLedgerRaw(root);
    for (const id of ['W-001', 'W-005']) {
      const e = raw.find((x) => x.id === id);
      assert.strictEqual(e.status, 'waived', `${id} must be waived; got ${e.status}`);
      assertValidTimestamp(e.resolvedAt, `${id} resolvedAt`);
      assert.strictEqual(e.note, 'batch waived from CLI', `${id} must carry the note`);
    }
    assert.strictEqual(raw.find((x) => x.id === 'W-002').status, 'deferred', 'W-002 untouched');
    assert.strictEqual(raw.find((x) => x.id === 'W-004').status, 'done', 'W-004 untouched');
    assert.strictEqual(raw.length, 5, 'resolve must never drop entries');
  } finally {
    cleanup(root);
  }
});

await test('TC-C7 (AC5): resolve with ZERO verb flags is refused (mentions the verb flags), ledger unchanged', async () => {
  const root = makeTmpRoot('cc-orch-warnings-cli-');
  try {
    writeCliFixture(root);
    const before = fs.readFileSync(ledgerPath(root), 'utf8');
    const res = runCli(root, ['warnings', 'resolve', 'W-001']);
    assertNonSilentFailure(res, 'resolve with no verb flag');
    assert.ok(
      /--waive|exactly one/i.test(res.out),
      `the refusal must explain the verb-flag requirement; got: ${res.out}`
    );
    assert.strictEqual(fs.readFileSync(ledgerPath(root), 'utf8'), before, 'ledger must be unchanged');
  } finally {
    cleanup(root);
  }
});

await test('TC-C8 (AC5): resolve with TWO verb flags is refused, ledger unchanged', async () => {
  const root = makeTmpRoot('cc-orch-warnings-cli-');
  try {
    writeCliFixture(root);
    const before = fs.readFileSync(ledgerPath(root), 'utf8');
    const res = runCli(root, ['warnings', 'resolve', 'W-001', '--waive', '--done']);
    assertNonSilentFailure(res, 'resolve with two verb flags');
    assert.ok(
      /--waive|exactly one/i.test(res.out),
      `the refusal must explain the exactly-one requirement; got: ${res.out}`
    );
    assert.strictEqual(fs.readFileSync(ledgerPath(root), 'utf8'), before, 'ledger must be unchanged');
  } finally {
    cleanup(root);
  }
});

await test('TC-C9 (AC5): resolve naming an unknown id is refused naming it, ledger unchanged', async () => {
  const root = makeTmpRoot('cc-orch-warnings-cli-');
  try {
    writeCliFixture(root);
    const before = fs.readFileSync(ledgerPath(root), 'utf8');
    const res = runCli(root, ['warnings', 'resolve', 'W-001', 'W-999', '--done']);
    assertNonSilentFailure(res, 'resolve with unknown id');
    assert.ok(res.out.includes('W-999'), `the error must name the unknown id W-999.\n${res.out}`);
    assert.strictEqual(fs.readFileSync(ledgerPath(root), 'utf8'), before, 'ledger must be unchanged (atomic batch)');
  } finally {
    cleanup(root);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Batch brainstorm bridge — injected deps.brainstorm seam
// ════════════════════════════════════════════════════════════════════════════

function writeBridgeFixture(root) {
  writeLedgerFixture(root, [
    fixtureEntry('W-001', { status: 'open', severity: 'warning', file: 'src/alpha.js', description: 'ALPHA-DESC cycle rollback left a stale snapshot' }),
    fixtureEntry('W-002', { status: 'open', severity: 'info', file: 'src/beta.js', description: 'BETA-DESC digest omits the archive id' }),
    fixtureEntry('W-003', { status: 'done', severity: 'warning', file: 'src/gamma.js', description: 'GAMMA-DESC already fixed and closed', resolvedAt: THREE_DAYS_AGO }),
  ]);
}

await test('TC-B1 (AC6): brainstorm bridge calls deps.brainstorm once with prose (file+description+severity per entry, numbered), no-tty passed through; brainstormSlug stamped, status unchanged', async () => {
  const entry = await loadBridgeEntry();
  const root = makeTmpRoot('cc-orch-warnings-bridge-');
  const cap = captureConsole();
  try {
    writeBridgeFixture(root);
    const { spy, calls } = makeBrainstormSpy({ slug: 'fake-slug' });

    await invokeBridge(entry, root, ['W-001', 'W-002'], { 'no-tty': true }, { brainstorm: spy });

    assert.strictEqual(calls.length, 1, `deps.brainstorm must be invoked exactly once (bundled goal); got ${calls.length}`);

    const prose = collectStrings(calls[0]).join('\n');
    for (const marker of ['src/alpha.js', 'ALPHA-DESC', 'src/beta.js', 'BETA-DESC']) {
      assert.ok(prose.includes(marker), `the synthesized prose must contain "${marker}".\nProse args: ${prose}`);
    }
    assert.ok(/warning/i.test(prose), 'the prose must carry each entry severity');
    const numberedItems = prose.match(/(?:^|\n)\s*\(?\d+\s*[.):、-]/g) || [];
    assert.ok(
      numberedItems.length >= 2,
      `the prose goal must be a numbered list (one item per entry); found ${numberedItems.length} numbered items in: ${prose}`
    );

    assert.ok(sawNoTtyFlag(calls[0]), 'the no-tty flag must pass through to the brainstorm seam');

    const raw = readLedgerRaw(root);
    for (const id of ['W-001', 'W-002']) {
      const e = raw.find((x) => x.id === id);
      assert.strictEqual(e.brainstormSlug, 'fake-slug', `${id} must be stamped with the draft slug`);
      assert.strictEqual(e.status, 'open', `${id} status must be UNCHANGED (closing stays manual via resolve --done); got ${e.status}`);
      assert.ok(!e.resolvedAt, `${id} must not be stamped resolvedAt by the bridge`);
    }
    const untouched = raw.find((x) => x.id === 'W-003');
    assert.ok(!untouched.brainstormSlug, 'unselected entries must not be stamped');
  } finally {
    cap.restore();
    cleanup(root);
  }
});

await test('TC-B2 (AC6): unknown id errors BEFORE the brainstorm seam is invoked', async () => {
  const entry = await loadBridgeEntry();
  const root = makeTmpRoot('cc-orch-warnings-bridge-');
  const cap = captureConsole();
  try {
    writeBridgeFixture(root);
    const before = fs.readFileSync(ledgerPath(root), 'utf8');
    const { spy, calls } = makeBrainstormSpy();

    let threw = null;
    try {
      await invokeBridge(entry, root, ['W-001', 'W-998'], { 'no-tty': true }, { brainstorm: spy });
    } catch (e) {
      threw = e;
    }

    assert.strictEqual(calls.length, 0, 'deps.brainstorm must NOT be invoked when any id is unknown');
    const errText = [threw?.message ?? '', ...cap.errs].join('\n');
    assert.ok(
      threw || process.exitCode === 1 || cap.errs.length > 0,
      'the unknown-id refusal must be observable (throw, exit code, or error output)'
    );
    assert.ok(errText.includes('W-998'), `the error must name the unknown id W-998; got: ${errText}`);
    assert.strictEqual(fs.readFileSync(ledgerPath(root), 'utf8'), before, 'no stamping may happen on the error path');
  } finally {
    cap.restore();
    cleanup(root);
  }
});

await test('TC-B3 (AC6): already-done id errors BEFORE the brainstorm seam is invoked', async () => {
  const entry = await loadBridgeEntry();
  const root = makeTmpRoot('cc-orch-warnings-bridge-');
  const cap = captureConsole();
  try {
    writeBridgeFixture(root);
    const before = fs.readFileSync(ledgerPath(root), 'utf8');
    const { spy, calls } = makeBrainstormSpy();

    let threw = null;
    try {
      await invokeBridge(entry, root, ['W-003'], { 'no-tty': true }, { brainstorm: spy });
    } catch (e) {
      threw = e;
    }

    assert.strictEqual(calls.length, 0, 'deps.brainstorm must NOT be invoked for an already-done id');
    const errText = [threw?.message ?? '', ...cap.errs].join('\n');
    assert.ok(
      threw || process.exitCode === 1 || cap.errs.length > 0,
      'the done-id refusal must be observable (throw, exit code, or error output)'
    );
    assert.ok(errText.includes('W-003'), `the error must name the done id W-003; got: ${errText}`);
    assert.strictEqual(fs.readFileSync(ledgerPath(root), 'utf8'), before, 'no stamping may happen on the error path');
  } finally {
    cap.restore();
    cleanup(root);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
