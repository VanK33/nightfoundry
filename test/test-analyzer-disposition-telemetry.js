#!/usr/bin/env node
/**
 * test-analyzer-disposition-telemetry.js — Analyzer disposition telemetry.
 *
 * Written by the INDEPENDENT test author against the pinned contract only —
 * before the implementation exists. At a pre-feature HEAD these cases fail
 * behaviorally (no archives/analyzer-dispositions.jsonl is ever written by
 * parkResolve).
 *
 * SPEC (behavior under test): at `park resolve` time, the human's disposition
 * on an analyzer-human (or review-gate) park must be recorded durably and
 * mine-able so analyzer-human accuracy can later be measured. RAW signals
 * ONLY — no false/true-human label is computed now.
 *
 * PINNED CONTRACT:
 *  1. The halted-analyzer park scene (and halted-review) carries explicit
 *     `recommendation` + `eventId` fields (analyzer recommendation + analysis
 *     eventId).
 *  2. parkResolve, when resolving a park whose scene has an analyzer signal
 *     (recommendation || eventId), appends ONE JSON line to
 *     <projectRoot>/archives/analyzer-dispositions.jsonl:
 *       { slug, eventId, recommendation, action, resolvedAt, note }
 *     with action ∈ 'requeue'|'waive'|'reject'. The line is appended AFTER the
 *     scene.resolution write + status flip (so a FAILED resolve does not log).
 *     A park with NO analyzer signal (e.g. an assumption-gate 'parked' scene)
 *     appends NOTHING.
 *
 * Coverage:
 *   (a) --waive / --reject on an analyzer-human park each append exactly one
 *       line with the right {slug, eventId, recommendation, action, resolvedAt}.
 *   (b) --requeue (no conflict) appends a line with action:'requeue'.
 *   (c) A FAILED requeue (reattach conflict) appends NOTHING and the entry
 *       stays parked.
 *   (d) Resolving a park with NO analyzer signal appends NOTHING.
 *   (e) The recorded line carries RAW signals only — NO computed
 *       false-human/true-human/label field.
 *   (f) Multiple resolves accumulate (append-only): two analyzer-human parks
 *       resolved → two lines.
 *
 * Run: node test/test-analyzer-disposition-telemetry.js
 *
 * Fixture discipline: queue entries are written through the production
 * writeQueueEntry; park scenes are written as fixture INPUT with plain fs at
 * the spec-pinned location queue/<slug>/park.json (no new state.js symbols are
 * imported, so this file loads at pre-feature HEAD and fails on behavioral
 * assertions, not module resolution). The reattach-conflict case (c) uses a
 * real temp git repo and the production createParkSnapshot, mirroring
 * test-park-requeue-reattach.js.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { writeQueueEntry } from '../src/orchestrator/core/state.js';
import { createParkSnapshot } from '../src/orchestrator/core/park-snapshot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../src/cli/index.js');

const DISPOSITIONS_REL = path.join('archives', 'analyzer-dispositions.jsonl');

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const SPEC_MD = `# Test Spec

This is a test spec for analyzer disposition telemetry.

## Goals
- Build something useful
`;
const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

const DAY = 24 * 60 * 60 * 1000;

function makeTmpRoot(prefix = 'cc-orch-disposition-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// A real temp git repo (needed only for the reattach-conflict case).
function makeGitRoot(prefix = 'cc-orch-disposition-git-') {
  const root = makeTmpRoot(prefix);
  git(root, 'init');
  git(root, 'config user.email "test@example.com"');
  git(root, 'config user.name "Test User"');
  fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nline two\nline three\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'queue/\narchives/\n.harness/\n');
  git(root, 'add -A');
  git(root, 'commit -m init');
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function createQueueEntry(root, slug, {
  status = 'halted-analyzer',
  validatedAt = new Date().toISOString(),
} = {}) {
  writeQueueEntry(root, slug, {
    spec: SPEC_MD,
    plan: { milestones: [], assumptions: [] },
    validatedAt,
    status,
    specJson: SPEC_JSON,
  });
}

/**
 * An analyzer-human park scene: carries the analyzer signal fields
 * (recommendation + eventId) per contract item 1.
 */
function makeAnalyzerScene(overrides = {}) {
  return {
    site: 'analyzer-human',
    parkedAt: new Date(Date.now() - DAY).toISOString(),
    round1: [],
    round2: null,
    appliedSpecEdits: [],
    questions: ['ANALYZER-QUESTION-X (see .harness/analysis/gate-failure-001.json)'],
    previousResolutions: [],
    resolution: null,
    recommendation: 'human',
    eventId: 'gate-failure-001-001-001-001-123',
    ...overrides,
  };
}

/**
 * An assumption-gate park scene with NO analyzer signal (no recommendation,
 * no eventId) — resolving this must append nothing (contract item 2, last
 * sentence).
 */
function makeAssumptionScene(overrides = {}) {
  return {
    site: 'assumption-gate',
    parkedAt: new Date(Date.now() - DAY).toISOString(),
    round1: [{
      assumption: { text: 'AN-ASSUMPTION', phase: 'pre', specSection: 'Goals' },
      status: 'uncertain',
      evidence: 'could not confirm',
    }],
    round2: null,
    appliedSpecEdits: [],
    questions: ['AN-ASSUMPTION'],
    previousResolutions: [],
    resolution: null,
    // Deliberately NO recommendation / eventId.
    ...overrides,
  };
}

function writeScene(root, slug, scene) {
  fs.writeFileSync(
    path.join(root, 'queue', slug, 'park.json'),
    JSON.stringify(scene, null, 2)
  );
}

function readStatus(root, slug) {
  return fs.readFileSync(path.join(root, 'queue', slug, 'status'), 'utf8').trim();
}

// Make the on-disk spec files older than parkedAt so the divergence warning
// never fires (keeps stdout clean; irrelevant to telemetry but avoids noise).
function ageSpecFiles(root, slug) {
  const old = new Date(Date.now() - 2 * DAY);
  const dir = path.join(root, 'queue', slug);
  fs.utimesSync(path.join(dir, 'spec.json'), old, old);
  fs.utimesSync(path.join(dir, 'spec.md'), old, old);
}

function dispositionsPath(root) {
  return path.join(root, DISPOSITIONS_REL);
}

/** Read every disposition line as a parsed object (empty if the file is absent). */
function readDispositions(root) {
  const p = dispositionsPath(root);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

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

// Any key whose name suggests a computed real/false-human verdict. The
// contract forbids baking the label now — only RAW signals are recorded.
const LABEL_KEY_RE = /(false|true)[\s_-]?human|is[\s_-]?(false|true)|label|verdict|classification|accurate|accuracy|correct/i;

function assertNoComputedLabel(line, label) {
  for (const key of Object.keys(line)) {
    assert.ok(!LABEL_KEY_RE.test(key),
      `${label}: the recorded line must carry RAW signals only — found a forbidden computed-label key '${key}' (line: ${JSON.stringify(line)})`);
  }
}

// ── (a) --waive and --reject on an analyzer-human park each log one line ─────

await test("(a) resolve --reject on an analyzer-human park appends one disposition line {slug, eventId, recommendation, action:'reject', resolvedAt, note}", async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'an-reject', { status: 'halted-analyzer' });
    writeScene(root, 'an-reject', makeAnalyzerScene());
    ageSpecFiles(root, 'an-reject');

    const res = runCli(root, ['park', 'resolve', 'an-reject', '--reject', '--note', 'analyzer was right']);
    assert.strictEqual(res.status, 0,
      `resolve --reject must succeed on a halted-analyzer park (got exit ${res.status}; output: ${res.out.trim().slice(0, 300)})`);

    const lines = readDispositions(root);
    assert.strictEqual(lines.length, 1,
      `exactly one disposition line must be appended for an analyzer-human resolve (got ${lines.length}; file: ${JSON.stringify(lines)})`);
    const line = lines[0];
    assert.strictEqual(line.slug, 'an-reject', `disposition.slug expected 'an-reject', got ${JSON.stringify(line.slug)}`);
    assert.strictEqual(line.eventId, 'gate-failure-001-001-001-001-123',
      `disposition.eventId must carry the scene's analysis eventId (got ${JSON.stringify(line.eventId)})`);
    assert.strictEqual(line.recommendation, 'human',
      `disposition.recommendation must carry the scene's analyzer recommendation (got ${JSON.stringify(line.recommendation)})`);
    assert.strictEqual(line.action, 'reject',
      `disposition.action expected 'reject', got ${JSON.stringify(line.action)}`);
    assert.ok(line.resolvedAt && !Number.isNaN(new Date(line.resolvedAt).getTime()),
      `disposition.resolvedAt must be a parseable timestamp (got ${JSON.stringify(line.resolvedAt)})`);
    assert.strictEqual(line.note, 'analyzer was right',
      `disposition.note must carry --note (got ${JSON.stringify(line.note)})`);
  } finally {
    cleanup(root);
  }
});

await test('(a) a REFUSED --waive on an analyzer-human park appends NO disposition line (only a successful resolve logs)', async () => {
  // The contract names --waive as a logged action, but the park CLI verb matrix
  // refuses --waive on halted-analyzer / halted-review (there is no assumption
  // uncertainty to accept). A refused resolve writes no resolution and flips no
  // status, so — like the failed-requeue case (c) — it must log nothing. This
  // asserts the disposition log tracks ONLY resolves that actually happened.
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'an-waive-refused', { status: 'halted-analyzer' });
    writeScene(root, 'an-waive-refused', makeAnalyzerScene());
    ageSpecFiles(root, 'an-waive-refused');

    const res = runCli(root, ['park', 'resolve', 'an-waive-refused', '--waive']);
    assert.ok(res.status !== 0 || res.stderr.trim().length > 0,
      `--waive on a halted-analyzer park must be refused loudly (got exit ${res.status} with empty stderr)`);
    assert.strictEqual(readStatus(root, 'an-waive-refused'), 'halted-analyzer',
      'a refused --waive must leave the status unchanged');

    const lines = readDispositions(root);
    assert.strictEqual(lines.length, 0,
      `a refused --waive must NOT append a disposition line (got ${lines.length}: ${JSON.stringify(lines)})`);
  } finally {
    cleanup(root);
  }
});

await test("(a) resolve on a review-gate (halted-review) analyzer park also appends a disposition line", async () => {
  // The contract names BOTH halted-analyzer and review-gate (halted-review) as
  // signal-carrying scenes. A halted-review scene that carries a recommendation
  // + eventId must log too. --waive is refused for halted-review, so use a
  // terminal --reject.
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'rev-reject', { status: 'halted-review' });
    writeScene(root, 'rev-reject', makeAnalyzerScene({
      site: 'review-gate',
      recommendation: 'human',
      eventId: 'reviewer-ms-3-987',
    }));
    ageSpecFiles(root, 'rev-reject');

    const res = runCli(root, ['park', 'resolve', 'rev-reject', '--reject']);
    assert.strictEqual(res.status, 0,
      `resolve --reject must succeed on a halted-review park (got exit ${res.status}; output: ${res.out.trim().slice(0, 300)})`);

    const lines = readDispositions(root);
    assert.strictEqual(lines.length, 1,
      `a signal-carrying halted-review resolve must append one disposition line (got ${lines.length})`);
    assert.strictEqual(lines[0].eventId, 'reviewer-ms-3-987',
      `disposition.eventId must carry the review-gate analysis eventId (got ${JSON.stringify(lines[0].eventId)})`);
    assert.strictEqual(lines[0].action, 'reject');
  } finally {
    cleanup(root);
  }
});

// ── (b) --requeue (no conflict) logs action:'requeue' ───────────────────────

await test("(b) resolve --requeue (no conflict) appends a disposition line with action:'requeue'", async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'an-requeue', { status: 'halted-analyzer' });
    writeScene(root, 'an-requeue', makeAnalyzerScene());
    ageSpecFiles(root, 'an-requeue');

    const res = runCli(root, ['park', 'resolve', 'an-requeue', '--requeue']);
    assert.strictEqual(res.status, 0,
      `resolve --requeue must succeed (got exit ${res.status}; output: ${res.out.trim().slice(0, 300)})`);
    assert.strictEqual(readStatus(root, 'an-requeue'), 'pending',
      "the requeued analyzer park must transition to 'pending'");

    const lines = readDispositions(root);
    assert.strictEqual(lines.length, 1,
      `a --requeue on an analyzer park must append one disposition line (got ${lines.length})`);
    assert.strictEqual(lines[0].action, 'requeue',
      `disposition.action expected 'requeue', got ${JSON.stringify(lines[0].action)}`);
    assert.strictEqual(lines[0].slug, 'an-requeue');
    assert.strictEqual(lines[0].eventId, 'gate-failure-001-001-001-001-123');
    assert.strictEqual(lines[0].recommendation, 'human');
  } finally {
    cleanup(root);
  }
});

// ── (c) a FAILED requeue (reattach conflict) logs NOTHING ───────────────────
// Reuse the P2 conflict setup: a preserved snapshot whose 3-way re-application
// conflicts with a divergent working-tree edit on the SAME line. parkResolve
// aborts (entry stays parked) BEFORE the scene/status write, so per the
// contract the disposition line — appended AFTER the status flip — never runs.

await test('(c) a FAILED requeue (reattach conflict) appends NO disposition line and the entry stays parked', async () => {
  const root = makeGitRoot();
  try {
    createQueueEntry(root, 'an-conflict', { status: 'halted-analyzer' });
    fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nWIP-LINE-TWO\nline three\n');
    const snap = createParkSnapshot('an-conflict', root);
    assert.strictEqual(git(root, 'status --porcelain').trim(), '', 'fixture: clean tree after snapshot');

    // Attach the snapshot refs to an analyzer-human scene so the resolve both
    // reattaches AND carries an analyzer signal (the very combination that
    // would log if the resolve succeeded).
    writeScene(root, 'an-conflict', makeAnalyzerScene({
      site: 'review-gate',
      stashRef: snap.stashRef,
      stashSha: snap.stashSha,
      baseSha: snap.baseSha,
      recommendation: 'human',
      eventId: 'gate-failure-conflict-555',
    }));

    // Conflicting working-tree change on the same line → 3-way apply fails.
    fs.writeFileSync(path.join(root, 'seed.txt'), 'line one\nDIVERGENT-LINE-TWO\nline three\n');

    const res = runCli(root, ['park', 'resolve', 'an-conflict', '--requeue']);
    // Loud failure: non-zero exit or stderr.
    assert.ok(res.status !== 0 || res.stderr.trim().length > 0,
      `a conflicting requeue must fail loudly (got exit ${res.status} with empty stderr)`);

    // The entry must NOT advance.
    assert.strictEqual(readStatus(root, 'an-conflict'), 'halted-analyzer',
      "a conflicting requeue must leave the entry at its pre-resolve status");

    // And crucially: NO disposition line was logged for the aborted resolve.
    const lines = readDispositions(root);
    assert.strictEqual(lines.length, 0,
      `a FAILED resolve must NOT append a disposition line (the line is appended AFTER the status flip); got ${lines.length}: ${JSON.stringify(lines)}`);
  } finally {
    cleanup(root);
  }
});

// ── (d) a park with NO analyzer signal logs NOTHING ─────────────────────────

await test('(d) resolving an assumption-gate park with no analyzer signal appends NOTHING', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'plain-parked', { status: 'parked' });
    writeScene(root, 'plain-parked', makeAssumptionScene());
    ageSpecFiles(root, 'plain-parked');

    // --waive is legal for a 'parked' assumption-gate entry.
    const res = runCli(root, ['park', 'resolve', 'plain-parked', '--waive']);
    assert.strictEqual(res.status, 0,
      `resolve --waive must succeed on a parked assumption-gate entry (got exit ${res.status}; output: ${res.out.trim().slice(0, 300)})`);
    assert.strictEqual(readStatus(root, 'plain-parked'), 'pending',
      "the waived assumption-gate entry must transition to 'pending' (fixture sanity)");

    assert.ok(!fs.existsSync(dispositionsPath(root)),
      'a resolve of a park with no analyzer signal must NOT create archives/analyzer-dispositions.jsonl');
    const lines = readDispositions(root);
    assert.strictEqual(lines.length, 0,
      `a no-signal resolve must append nothing (got ${lines.length}: ${JSON.stringify(lines)})`);
  } finally {
    cleanup(root);
  }
});

// ── (e) the recorded line carries RAW signals only (no computed label) ──────

await test('(e) the recorded disposition line carries RAW signals only — no computed false-human/true-human/label field', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'an-raw', { status: 'halted-analyzer' });
    writeScene(root, 'an-raw', makeAnalyzerScene());
    ageSpecFiles(root, 'an-raw');

    const res = runCli(root, ['park', 'resolve', 'an-raw', '--requeue']);
    assert.strictEqual(res.status, 0,
      `resolve --requeue must succeed (got exit ${res.status}; output: ${res.out.trim().slice(0, 300)})`);

    const lines = readDispositions(root);
    assert.strictEqual(lines.length, 1, `exactly one line expected (got ${lines.length})`);
    const line = lines[0];

    // The recorded keys must be exactly the RAW-signal set the contract pins.
    assertNoComputedLabel(line, 'disposition line');

    // Positive: the RAW signals the contract DOES require are present.
    for (const key of ['slug', 'eventId', 'recommendation', 'action', 'resolvedAt']) {
      assert.ok(Object.prototype.hasOwnProperty.call(line, key),
        `the disposition line must carry the raw signal '${key}' (line: ${JSON.stringify(line)})`);
    }
  } finally {
    cleanup(root);
  }
});

// ── (f) multiple resolves accumulate (append-only) ──────────────────────────

await test('(f) two analyzer-human parks resolved → two disposition lines accumulate (append-only)', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'an-first', { status: 'halted-analyzer' });
    writeScene(root, 'an-first', makeAnalyzerScene({ eventId: 'gate-failure-first-111' }));
    ageSpecFiles(root, 'an-first');

    createQueueEntry(root, 'an-second', { status: 'halted-analyzer' });
    writeScene(root, 'an-second', makeAnalyzerScene({ eventId: 'gate-failure-second-222' }));
    ageSpecFiles(root, 'an-second');

    const res1 = runCli(root, ['park', 'resolve', 'an-first', '--requeue']);
    assert.strictEqual(res1.status, 0,
      `first resolve must succeed (got exit ${res1.status}; output: ${res1.out.trim().slice(0, 300)})`);
    const res2 = runCli(root, ['park', 'resolve', 'an-second', '--reject']);
    assert.strictEqual(res2.status, 0,
      `second resolve must succeed (got exit ${res2.status}; output: ${res2.out.trim().slice(0, 300)})`);

    const lines = readDispositions(root);
    assert.strictEqual(lines.length, 2,
      `two analyzer-human resolves must accumulate two lines (append-only); got ${lines.length}: ${JSON.stringify(lines)}`);

    // Both entries are recorded, in append order, with their distinct signals.
    assert.strictEqual(lines[0].slug, 'an-first');
    assert.strictEqual(lines[0].eventId, 'gate-failure-first-111');
    assert.strictEqual(lines[0].action, 'requeue');
    assert.strictEqual(lines[1].slug, 'an-second');
    assert.strictEqual(lines[1].eventId, 'gate-failure-second-222');
    assert.strictEqual(lines[1].action, 'reject');
  } finally {
    cleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
