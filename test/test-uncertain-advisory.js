#!/usr/bin/env node
/**
 * test-uncertain-advisory.js — uncertain-advisory-no-park spec
 * (spec: uncertain-advisory-no-park.spec.md / .json).
 *
 * Written by the INDEPENDENT test author against the SPEC CONTRACT only —
 * NOT by reading the new uncertain-handling implementation. The assertions
 * are pinned to the shared observable contracts the spec fixes:
 *
 *   - A genuine `uncertain` assumption verdict (zero `failed`) NO LONGER
 *     parks/gates/stops the run. Each uncertain is RECORDED and the run
 *     CONTINUES. `failed` still blocks (unchanged); `post-fix`/`deferred`
 *     still defer (unchanged); `halted-review`/`halted-analyzer` park
 *     unchanged.
 *   - The warnings ledger (archives/warnings.jsonl, read via
 *     `readLedger(projectRoot)`) gains one entry per uncertain with
 *     `category === 'assumption-uncertain'`, `description === <the
 *     assumption's text>`, and a `specSection` field.
 *   - The archive manifest gains a field named exactly `uncertainAssumptions`,
 *     an array of objects each with at least `text` and `specSection`.
 *   - The review gate, on the human-present path (onMenu registered, not a
 *     skip/auto-accept path), prints this run's uncertain assumption texts
 *     before its menu. Unattended (auto-accept / no human) does NOT block.
 *
 * Discipline (mirrors test-park-foundation.js): only the trigger seams are
 * stubbed — planner.verifyAssumptions / remediateAssumption /
 * reExtractAssumptions (LLM seams), the execution + review-gate seams (so
 * execution proceeds without real work), and the archive seam where noted.
 * The real batchResume / archive / warnings-ledger code paths are exercised.
 * Park scenes used as FIXTURE INPUT are written with plain fs.
 *
 * Because the implementation is being written in PARALLEL, behavioral cases
 * (TC1, TC3, TC4, TC5) are expected to FAIL at a pre-feature HEAD (today an
 * uncertain either auto-waives or parks, and the ledger/manifest/review-gate
 * surfacing does not yet exist). TC2 pins the UNCHANGED `failed`/`post-fix`
 * contract and must stay green.
 *
 * Run: node test/test-uncertain-advisory.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { writeQueueEntry, readQueueEntry, listQueue } from '../src/orchestrator/core/state.js';
import { readLedger, resolveEntries } from '../src/orchestrator/core/warnings-ledger.js';
import { buildManifest } from '../src/cli/commands/archive.js';

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

// ── Fixture data ───────────────────────────────────────────────────────────

// Scope-item-free markdown (no '## Scope — in', no scope markers) so the
// _scopeCoverageGate skips — mirrors test-park-foundation.js. The '## Goals'
// section + ORIGINAL-CLAUSE anchor exist for the remediation path.
const SPEC_MD = `# Test Spec

This is a test spec for the uncertain-advisory paths.

## Goals
- Build something useful around ORIGINAL-CLAUSE here
`;

// Parseable sibling json so the uncheckable-spec gate passes.
const SPEC_JSON = JSON.stringify({ goal: 'g', target_files: [], acceptance_criteria: [] });

// A deliberately NON-benign uncertain assumption text + section. At the
// pre-feature HEAD a non-benign uncertain parks (or, if benign, auto-waives);
// under the new contract it is recorded to the ledger and the run continues.
const UNCERTAIN_TEXT = 'The orchestrator persists per-run uncertainty advisories durably';
const UNCERTAIN_SECTION = 'Goals';

function makePlan(assumptions = []) {
  return { milestones: [], assumptions, scopeItems: [], scopeMapping: [] };
}

function makeTmpRoot(prefix = 'cc-orch-uncertain-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Git fixture (mirrors test-park-foundation.js makeGitRoot) for paths that
// drive the real archive / review-gate git reads.
function makeTmpGitRoot(prefix = 'cc-orch-uncertain-git-') {
  const root = makeTmpRoot(prefix);
  execSync('git init', { cwd: root, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed content\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'queue/\narchives/\nfake-archives/\n.harness/\n');
  execSync('git add -A', { cwd: root, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: root, stdio: 'pipe' });
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function createQueueEntry(root, slug, {
  spec = SPEC_MD,
  plan = makePlan(),
  validatedAt = new Date().toISOString(),
  status = 'pending',
  specJson = SPEC_JSON,
} = {}) {
  writeQueueEntry(root, slug, { spec, plan, validatedAt, status, specJson });
}

function parkSceneExists(root, slug) {
  return fs.existsSync(path.join(root, 'queue', slug, 'park.json'));
}

function autoWaiveSceneExists(root, slug) {
  // The auto-waive scene rotates auto-waive.json / auto-waive-NNN.json under
  // queue/<slug>/. Any such file means the entry was auto-waived (the OLD
  // behavior); the new contract records to the ledger instead.
  const dir = path.join(root, 'queue', slug);
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((f) => /^auto-waive(-\d+)?\.json$/.test(f));
}

// ── Helper: batch pipeline with stubbed agent seams + injected archive ──────
// Mirrors test-park-foundation.js makeBatchPipeline. Only trigger seams are
// stubbed; batchResume itself is the real code path.
//
// verifyResponder(text, assumptionObj, callIndex) → status string.
function makeBatchPipeline(root, opts = {}) {
  const logs = [];
  const menuCalls = [];      // array of { question, options, opts }
  const archiveCalls = [];
  const verifyCalls = [];    // array of arrays of assumption texts per call
  const reExtractCalls = [];
  const remediateCalls = [];
  const executeCaptures = [];
  let executeCallCount = 0;
  let reviewCallCount = 0;

  const archiveStub = opts.archive || (async (_projectRoot, slug, archiveOpts) => {
    archiveCalls.push({ slug, opts: archiveOpts });
    const dir = path.join(root, 'fake-archives', String(archiveCalls.length));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });

  const pipelineOpts = {
    skipWorktreeCreation: true,
    onLog: (msg) => logs.push(msg),
    onConfirm: async () => true,
    archive: archiveStub,
  };
  if (opts.onMenu) {
    pipelineOpts.onMenu = async (question, options, menuOpts) => {
      menuCalls.push({ question, options, opts: menuOpts });
      return opts.onMenu(question, options, menuOpts);
    };
  }
  const pipeline = new Pipeline(root, pipelineOpts);

  const verifyResponder = opts.verifyResponder || (() => 'verified');
  pipeline.planner.verifyAssumptions = async (assumptions) => {
    const texts = (assumptions || []).map((a) => a?.text ?? a);
    verifyCalls.push(texts);
    return (assumptions || []).map((a) => ({
      assumption: a,
      status: verifyResponder(a?.text ?? a, a, verifyCalls.length),
      evidence: `stubbed evidence for "${a?.text ?? a}"`,
    }));
  };

  pipeline.planner.remediateAssumption = async (assumptionText) => {
    remediateCalls.push(assumptionText);
    if (opts.onRemediate) return opts.onRemediate(assumptionText);
    return { specEdit: { old: '', new: '' }, revisedAssumptions: [] };
  };

  pipeline.planner.reExtractAssumptions = async (specPath, projectRoot) => {
    reExtractCalls.push({ specPath, projectRoot });
    if (opts.onReExtract) return opts.onReExtract(specPath, projectRoot);
    return [];
  };

  pipeline.planner.closeReusableSession = async () => {};

  pipeline._executeAllMilestones = async (plan) => {
    executeCallCount++;
    if (opts.onExecute) return opts.onExecute(plan, executeCallCount, executeCaptures);
  };

  // Default: stub the review gate to a no-op (proceed). When opts.onReview is
  // provided we delegate; when opts.realReviewGate is set, the REAL
  // _reviewGate runs (human-present surfacing case).
  if (!opts.realReviewGate) {
    pipeline._reviewGate = async (reviewOpts) => {
      reviewCallCount++;
      if (opts.onReview) return opts.onReview(reviewOpts, reviewCallCount);
    };
  }

  return {
    pipeline,
    logs,
    menuCalls,
    archiveCalls,
    verifyCalls,
    reExtractCalls,
    remediateCalls,
    executeCaptures,
    getExecuteCount: () => executeCallCount,
    getReviewCount: () => reviewCallCount,
  };
}

// Find ledger entries recorded for an uncertain assumption (the shared
// observable contract: category === 'assumption-uncertain').
function uncertainLedgerEntries(root) {
  return readLedger(root).filter((e) => e.category === 'assumption-uncertain');
}

// ── TC1 (AC1): uncertain (zero failed) does NOT park — continues + ledger ────

await test('TC1 (AC1): genuine uncertain (zero failed) does NOT park — run continues, ledger records it, no park/auto-waive scene', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'advisory-a', {
      plan: makePlan([{ text: UNCERTAIN_TEXT, phase: 'pre', specSection: UNCERTAIN_SECTION }]),
      validatedAt: '2026-06-01T00:00:00.000Z',
    });

    const h = makeBatchPipeline(root, {
      verifyResponder: (text) => (text === UNCERTAIN_TEXT ? 'uncertain' : 'verified'),
    });

    const result = await h.pipeline.batchResume({});

    // The run CONTINUES: the entry reaches execution and is archived+removed,
    // instead of parking. (At the broken baseline it parks or auto-waives.)
    assert.strictEqual(h.getExecuteCount(), 1,
      `the uncertain entry must reach execution — uncertain no longer gates the run (got ${h.getExecuteCount()} execution(s))`);
    assert.ok(!fs.existsSync(path.join(root, 'queue', 'advisory-a')),
      "entry 'advisory-a' should be removed after its successful run (the run continued past the uncertain)");
    assert.strictEqual(result.archived, 1, `expected archived:1, got ${JSON.stringify(result)}`);

    // No park scene, no auto-waive scene — uncertain is recorded, not gated.
    assert.ok(!parkSceneExists(root, 'advisory-a'),
      'no park.json may be written for a genuine uncertain under the new contract');
    assert.ok(!autoWaiveSceneExists(root, 'advisory-a'),
      'no auto-waive scene file may be written — uncertain is recorded to the ledger, not auto-waived');

    // Verification ran exactly once (round 1 only — no remediation, no round 2).
    assert.strictEqual(h.verifyCalls.length, 1,
      `verifyAssumptions must run once (round 1 only) (got ${h.verifyCalls.length})`);
    assert.strictEqual(h.remediateCalls.length, 0,
      `remediateAssumption must NOT run for an uncertain-only round 1 (got ${h.remediateCalls.length})`);

    // The warnings ledger gained an assumption-uncertain entry for this text.
    const ledger = uncertainLedgerEntries(root);
    assert.ok(ledger.length >= 1,
      `the warnings ledger must gain an 'assumption-uncertain' entry for the uncertain (got ${ledger.length})`);
    const match = ledger.find((e) => e.description === UNCERTAIN_TEXT);
    assert.ok(match,
      `a ledger entry must have description === the uncertain assumption text (entries: ${JSON.stringify(ledger.map((e) => e.description))})`);
    assert.strictEqual(match.category, 'assumption-uncertain',
      `the entry category must be 'assumption-uncertain' (got '${match.category}')`);
    assert.strictEqual(match.specSection, UNCERTAIN_SECTION,
      `the entry must carry a specSection field equal to the assumption's section (got ${JSON.stringify(match.specSection)})`);
  } finally {
    cleanup(root);
  }
});

// ── TC1b (AC1): ALL-uncertain run still does NOT park (no backstop) ─────────

await test('TC1b (AC1): an ALL-uncertain run still does NOT park — there is no all-uncertain backstop', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'advisory-all', {
      plan: makePlan([
        { text: `${UNCERTAIN_TEXT} (one)`, phase: 'pre', specSection: UNCERTAIN_SECTION },
        { text: `${UNCERTAIN_TEXT} (two)`, phase: 'pre', specSection: UNCERTAIN_SECTION },
      ]),
    });

    const h = makeBatchPipeline(root, { verifyResponder: () => 'uncertain' });
    const result = await h.pipeline.batchResume({});

    assert.ok(!parkSceneExists(root, 'advisory-all'),
      'an all-uncertain run must NOT park — no backstop even when every assumption is uncertain');
    assert.strictEqual(h.getExecuteCount(), 1,
      `the all-uncertain entry must still reach execution (got ${h.getExecuteCount()})`);
    assert.strictEqual(result.archived, 1, `expected archived:1, got ${JSON.stringify(result)}`);

    // Both uncertains recorded.
    const ledger = uncertainLedgerEntries(root);
    assert.strictEqual(ledger.length, 2,
      `both uncertains must be recorded to the ledger (got ${ledger.length}: ${JSON.stringify(ledger.map((e) => e.description))})`);
  } finally {
    cleanup(root);
  }
});

// ── TC2 (AC2): failed still blocks; post-fix still defers (UNCHANGED) ────────
// Guard family: pins the contract the spec leaves UNTOUCHED.

await test('TC2a (AC2): a failed assumption (no applicable spec edit) still parks/blocks — it must NOT silently continue', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'failed-a', {
      plan: makePlan([{ text: 'FAILED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }]),
    });

    const h = makeBatchPipeline(root, {
      // Fails in round 1 AND stays failed in round 2 → needs-a-human park.
      verifyResponder: (text) => {
        if (text === 'FAILED-ASSUMPTION') return 'failed';
        if (text === 'REVISED-ASSUMPTION') return 'failed';
        return 'verified';
      },
      onRemediate: () => ({
        specEdit: { old: 'ORIGINAL-CLAUSE', new: 'REMEDIATED-CLAUSE', section: 'Goals' },
        revisedAssumptions: [{ text: 'REVISED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }],
      }),
      onReExtract: () => [{ text: 'REVISED-ASSUMPTION', phase: 'pre', specSection: 'Goals' }],
    });

    await h.pipeline.batchResume({});

    const entry = readQueueEntry(root, 'failed-a');
    assert.ok(entry, "entry 'failed-a' must still exist in the queue");
    // The failed assumption must NOT silently continue. Under the unchanged
    // contract a still-failed assumption after remediation parks the entry.
    assert.strictEqual(entry.status, 'parked',
      `a still-failed assumption must block (park), not silently continue, got '${entry.status}'`);
    assert.ok(parkSceneExists(root, 'failed-a'),
      'a still-failed assumption must produce a park scene (the failed path is unchanged)');
    assert.strictEqual(h.getExecuteCount(), 0,
      'a blocked (failed) entry must never reach execution');

    // The failed assumption must NOT be recorded as an uncertain advisory.
    const ledger = uncertainLedgerEntries(root);
    assert.ok(!ledger.some((e) => e.description === 'FAILED-ASSUMPTION'),
      `a failed assumption must NOT be recorded as an uncertain advisory (ledger: ${JSON.stringify(ledger.map((e) => e.description))})`);
  } finally {
    cleanup(root);
  }
});

await test('TC2b (AC2): a post-fix/deferred assumption still defers — it is NOT recorded as an uncertain advisory and does not block', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'postfix-a', {
      plan: makePlan([{ text: 'POSTFIX-ASSUMPTION', phase: 'post-fix', specSection: 'Goals' }]),
    });

    const h = makeBatchPipeline(root, {
      // A post-fix assumption verdict defers (it is checked after the fix, not
      // at the pre-execution gate). Verifier reports 'deferred'.
      verifyResponder: () => 'deferred',
    });

    const result = await h.pipeline.batchResume({});

    // Defer does not park and does not block — the entry proceeds.
    assert.ok(!parkSceneExists(root, 'postfix-a'),
      'a deferred (post-fix) assumption must NOT park');
    assert.strictEqual(h.getExecuteCount(), 1,
      `a deferred (post-fix) assumption must let the run proceed (got ${h.getExecuteCount()} execution(s))`);
    assert.strictEqual(result.archived, 1, `expected archived:1, got ${JSON.stringify(result)}`);

    // It must NOT be recorded as an uncertain advisory (only `uncertain`
    // verdicts go to the assumption-uncertain ledger).
    const ledger = uncertainLedgerEntries(root);
    assert.ok(!ledger.some((e) => e.description === 'POSTFIX-ASSUMPTION'),
      `a post-fix/deferred assumption must NOT be recorded as an uncertain advisory (ledger: ${JSON.stringify(ledger.map((e) => e.description))})`);
  } finally {
    cleanup(root);
  }
});

// ── TC3 (AC3): review gate (human present) surfaces this run's uncertains ───

await test("TC3 (AC3): review gate on the human-present path surfaces this run's uncertain assumption text; the unattended path does NOT block", async () => {
  const root = makeTmpGitRoot();
  try {
    createQueueEntry(root, 'review-advisory', {
      plan: makePlan([{ text: UNCERTAIN_TEXT, phase: 'pre', specSection: UNCERTAIN_SECTION }]),
    });

    // Human-present path: onMenu IS registered, and it accepts ('a'). The REAL
    // _reviewGate runs (realReviewGate:true). batchResume calls it with
    // autoAccept:true, but with no clean review sidecars it fail-closes
    // and falls through to the human menu — the human-present surfacing path.
    const h = makeBatchPipeline(root, {
      verifyResponder: (text) => (text === UNCERTAIN_TEXT ? 'uncertain' : 'verified'),
      realReviewGate: true,
      onMenu: async () => 'a', // accept at the review menu
    });

    const result = await h.pipeline.batchResume({});

    // The run continued (uncertain does not gate), reached the review gate,
    // and the gate surfaced the uncertain text. The surfacing may land in the
    // logged gate output OR in the menu-context passed to onMenu — accept
    // either, per the contract ("captured onLog / the menu-context text").
    const loggedBlob = h.logs.join('\n');
    const menuBlob = JSON.stringify(h.menuCalls);
    const surfaced = loggedBlob.includes(UNCERTAIN_TEXT) || menuBlob.includes(UNCERTAIN_TEXT);
    assert.ok(h.menuCalls.length >= 1,
      'the human-present review menu must be reached (onMenu registered, auto-accept fails closed without sidecars)');
    assert.ok(surfaced,
      `the review gate must surface this run's uncertain assumption text before its menu ` +
      `(searched onLog + menu-context for ${JSON.stringify(UNCERTAIN_TEXT)}). ` +
      `logs: ${loggedBlob.slice(0, 400)}`);

    // Accepting → the run archives (it was not blocked by the surfacing).
    assert.strictEqual(result.archived, 1, `expected archived:1, got ${JSON.stringify(result)}`);
  } finally {
    cleanup(root);
  }
});

await test('TC3b (AC3): the unattended path (no onMenu / auto-accept) is NOT blocked by an uncertain — it proceeds to archive', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'review-unattended', {
      plan: makePlan([{ text: UNCERTAIN_TEXT, phase: 'pre', specSection: UNCERTAIN_SECTION }]),
    });

    // No onMenu registered, review gate stubbed no-op → fully unattended.
    const h = makeBatchPipeline(root, {
      verifyResponder: (text) => (text === UNCERTAIN_TEXT ? 'uncertain' : 'verified'),
    });

    const result = await h.pipeline.batchResume({});

    // Unattended: no human prompt, no block — the run proceeds and archives.
    assert.strictEqual(h.getExecuteCount(), 1,
      'the unattended run must proceed past the uncertain to execution');
    assert.strictEqual(result.archived, 1,
      `the unattended run must archive (the surfacing carries via ledger + archive, not a block); got ${JSON.stringify(result)}`);

    // The uncertain is still recorded durably for later (ledger).
    assert.ok(uncertainLedgerEntries(root).some((e) => e.description === UNCERTAIN_TEXT),
      'the unattended run must still record the uncertain to the ledger for later surfacing');
  } finally {
    cleanup(root);
  }
});

// ── TC4 (AC4): archive manifest records this run's uncertains ───────────────
// Integration-shaped: drives the FULL record→persist→archive chain. The
// injected `_archive` calls the REAL archive() (so the real buildManifest
// runs and a real manifest.json is written), stubbing ONLY the summarizer
// LLM seam. The manifest is read back off disk.

await test("TC4 (AC4): the real archive manifest records this run's uncertains in an 'uncertainAssumptions' array (text + specSection)", async () => {
  const root = makeTmpGitRoot();
  try {
    createQueueEntry(root, 'manifest-advisory', {
      plan: {
        milestones: [{ id: '001', description: 'Advisory milestone', missions: [{ id: '001-001', description: 'Mission one' }] }],
        assumptions: [{ text: UNCERTAIN_TEXT, phase: 'pre', specSection: UNCERTAIN_SECTION }],
        scopeItems: [],
        scopeMapping: [],
      },
    });

    const { archive: realArchive } = await import('../src/cli/commands/archive.js');

    const h = makeBatchPipeline(root, {
      verifyResponder: (text) => (text === UNCERTAIN_TEXT ? 'uncertain' : 'verified'),
      // Drive the REAL archive() through an injected wrapper: stub only the
      // summarizer (LLM) seam. The temp repo has no package.json named
      // cc-orchestrator, so the version-bump + final-test-gate paths are inert.
      archive: async (projectRoot, slug, flags) => realArchive(projectRoot, slug, flags, {
        summarize: async () => ({ headline: 'advisory run', bugs: [], summary: '', changelog: [] }),
      }),
    });

    const result = await h.pipeline.batchResume({});
    assert.strictEqual(result.archived, 1,
      `the run must archive through the real archive() (got ${JSON.stringify(result)})`);

    // Locate the real archive dir + its manifest.json.
    const archivesDir = path.join(root, 'archives');
    const archiveEntries = fs.existsSync(archivesDir)
      ? fs.readdirSync(archivesDir).filter((d) => /^\d{3}-/.test(d))
      : [];
    assert.strictEqual(archiveEntries.length, 1,
      `exactly one archive dir must be produced (got ${JSON.stringify(archiveEntries)})`);
    const manifestPath = path.join(archivesDir, archiveEntries[0], 'manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'the archive must contain manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    // The shared observable contract: a field named exactly
    // 'uncertainAssumptions', an array of {text, specSection, ...} objects.
    assert.ok(Array.isArray(manifest.uncertainAssumptions),
      `manifest must carry an 'uncertainAssumptions' array (got ${JSON.stringify(manifest.uncertainAssumptions)})`);
    const recorded = manifest.uncertainAssumptions.find((u) => u && u.text === UNCERTAIN_TEXT);
    assert.ok(recorded,
      `manifest.uncertainAssumptions must contain this run's uncertain (by text) ` +
      `(got ${JSON.stringify(manifest.uncertainAssumptions)})`);
    assert.strictEqual(recorded.specSection, UNCERTAIN_SECTION,
      `the manifest uncertain entry must carry specSection (got ${JSON.stringify(recorded.specSection)})`);
  } finally {
    cleanup(root);
  }
});

// ── TC5 (AC5): ledger producer; consumer side unaffected ────────────────────
// Asserts via the driven pipeline (an end-to-end append), then confirms the
// consumer side still works: readLedger returns it AND resolveEntries on its
// id still functions (the consumer contract is untouched).

await test('TC5 (AC5): the producer appends an assumption-uncertain entry (text + specSection + category); the consumer side (readLedger / resolveEntries) is unaffected', async () => {
  const root = makeTmpRoot();
  try {
    createQueueEntry(root, 'producer-advisory', {
      plan: makePlan([{ text: UNCERTAIN_TEXT, phase: 'pre', specSection: UNCERTAIN_SECTION }]),
    });

    const h = makeBatchPipeline(root, {
      verifyResponder: (text) => (text === UNCERTAIN_TEXT ? 'uncertain' : 'verified'),
    });
    await h.pipeline.batchResume({});

    // Producer: an assumption-uncertain entry with the contract fields.
    const entries = uncertainLedgerEntries(root);
    assert.ok(entries.length >= 1,
      `the producer must append an assumption-uncertain entry (got ${entries.length})`);
    const entry = entries.find((e) => e.description === UNCERTAIN_TEXT);
    assert.ok(entry, `the appended entry must carry the assumption text as description`);
    assert.strictEqual(entry.category, 'assumption-uncertain',
      `category must be 'assumption-uncertain' (got '${entry.category}')`);
    assert.strictEqual(entry.specSection, UNCERTAIN_SECTION,
      `the entry must carry a specSection field (got ${JSON.stringify(entry.specSection)})`);
    // The reused ledger entry shape: a stable string id is what the consumer
    // CLI (list/show/resolve) keys on.
    assert.ok(typeof entry.id === 'string' && entry.id.length > 0,
      `the appended entry must have a string id (got ${JSON.stringify(entry.id)})`);

    // Consumer side unaffected: a subsequent readLedger returns it, and the
    // existing resolveEntries verb still operates on it without error.
    const reread = readLedger(root).find((e) => e.id === entry.id);
    assert.ok(reread, 'a subsequent readLedger must return the appended entry');

    const updated = resolveEntries(root, [entry.id], { status: 'waived', note: 'reviewed advisory' });
    assert.strictEqual(updated.length, 1, 'resolveEntries must update exactly the named entry');
    assert.strictEqual(updated[0].status, 'waived',
      `resolveEntries must transition the assumption-uncertain entry to 'waived' (got '${updated[0].status}')`);
    const afterResolve = readLedger(root).find((e) => e.id === entry.id);
    assert.strictEqual(afterResolve.status, 'waived',
      'the resolved status must persist (consumer contract intact)');
  } finally {
    cleanup(root);
  }
});

// ── TC6 (AC5): other park sites unaffected (smoke) ──────────────────────────
// Not a re-test of halted-review/halted-analyzer (the full suite covers those)
// — just a guard that an UNRELATED forensic-archive path still parks/labels as
// before when a generic execution failure occurs. listQueue stays readable.

await test('TC6 (AC5): a generic execution failure still labels failed-execution (unrelated park/forensic sites unaffected)', async () => {
  const root = makeTmpGitRoot();
  try {
    createQueueEntry(root, 'unrelated-fail', {
      plan: {
        milestones: [{ id: '001', description: 'Fail milestone', missions: [{ id: '001-001', description: 'Mission one' }] }],
        assumptions: [],
        scopeItems: [],
        scopeMapping: [],
      },
    });

    const logs = [];
    // No archive injection — the real forensic chain runs (mirrors
    // test-park-foundation TC5e). Execution throws a generic error.
    const pipeline = new Pipeline(root, {
      skipWorktreeCreation: true,
      onLog: (msg) => logs.push(msg),
      onConfirm: async () => true,
    });
    pipeline.planner.verifyAssumptions = async () => [];
    pipeline.planner.remediateAssumption = async () => ({ specEdit: { old: '', new: '' }, revisedAssumptions: [] });
    pipeline.planner.reExtractAssumptions = async () => [];
    pipeline.planner.closeReusableSession = async () => {};
    pipeline._executeAllMilestones = async () => {
      throw new Error('milestone execution exploded (generic, non-HaltError)');
    };
    pipeline._reviewGate = async () => {};

    const result = await pipeline.batchResume({});

    const statusOnDisk = fs.readFileSync(path.join(root, 'queue', 'unrelated-fail', 'status'), 'utf8').trim();
    assert.strictEqual(statusOnDisk, 'failed-execution',
      `a generic execution failure must still be 'failed-execution', got '${statusOnDisk}'`);
    assert.ok(!parkSceneExists(root, 'unrelated-fail'),
      'no park.json may be written for a plain execution failure');
    assert.strictEqual(result.failed, 1, `expected failed:1, got ${JSON.stringify(result)}`);

    const listed = listQueue(root);
    assert.strictEqual(listed.length, 1, `listQueue must still read the queue (got ${listed.length})`);
    assert.strictEqual(listed[0].status, 'failed-execution',
      `listQueue must report failed-execution, got '${listed[0].status}'`);
  } finally {
    cleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
