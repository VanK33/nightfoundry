#!/usr/bin/env node
/**
 * test-candidates-ledger.js — Unit contract test for the candidates ledger
 * (src/orchestrator/core/candidates-ledger.js).
 *
 * Exercises candidatesLedgerPath, hashSignature, and appendCandidate against
 * a temp projectRoot (mkdtemp). Self-contained pass/fail harness and
 * temp-dir cleanup convention mirrored from test/test-warnings-ledger.js.
 *
 * Coverage:
 *   TC1 — appendCandidate writes exactly one JSONL line whose parsed object
 *         has keys {ts, slug, signature, signatureHash, summary, evidence}
 *         with signature = {phase, errorClass, analyzerRecommendation,
 *         taskState} and evidence = {archiveId, stashRef, analyzerSidecar}.
 *   TC2 — hash stability: two entries with identical four signature fields
 *         yield the same signatureHash.
 *   TC3 — any single differing signature field yields a different
 *         signatureHash.
 *   TC4 — content fields summary/slug/evidence/ts differing while the four
 *         signature fields are equal do NOT change signatureHash.
 *   TC5 — nullable signature fields (analyzerRecommendation/taskState null)
 *         and null slug and null evidence pointers land in the line cleanly
 *         as null.
 *   TC6 — best-effort: pre-create archives/candidates.jsonl as a DIRECTORY
 *         so the write fails; appendCandidate must not throw and must
 *         produce exactly one warning via the injected onWarn spy.
 *   TC7 — emitSecondaryFindingCandidates with one 'defer' disposition
 *         writes exactly one JSONL line marked with the
 *         'analysis-secondary-finding' errorClass and taskState 'defer'.
 *   TC8 — emitSecondaryFindingCandidates with one 'not_applicable'
 *         disposition writes exactly one JSONL line with the same source
 *         marker and taskState 'not_applicable'.
 *   TC9 — dispositions valued only 'fix' write zero ledger lines.
 *   TC10 — a mixed batch of defer + fix + not_applicable writes exactly
 *          two lines, one per non-fix finding.
 *   TC11 — with archives/candidates.jsonl pre-created as a DIRECTORY,
 *          emitSecondaryFindingCandidates does not throw and forwards a
 *          warning containing 'Failed to append candidate to
 *          candidates.jsonl' to the injected onWarn spy.
 *
 * Run: node test/test-candidates-ledger.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  candidatesLedgerPath,
  hashSignature,
  appendCandidate,
} from '../src/orchestrator/core/candidates-ledger.js';
import {
  buildSecondaryFindingCandidateEntries,
  emitSecondaryFindingCandidates,
} from '../src/orchestrator/core/pipeline.js';

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

function makeTmpRoot(prefix = 'cc-orch-candidates-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Tolerant raw JSONL read — never throws, skips unparseable lines. */
function readLinesRaw(ledgerFile) {
  if (!fs.existsSync(ledgerFile)) return [];
  const out = [];
  for (const line of fs.readFileSync(ledgerFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    out.push(t);
  }
  return out;
}

async function run() {

await test('TC1: appendCandidate writes exactly one JSONL line with the full top-level and nested shape', async () => {
  const root = makeTmpRoot();
  try {
    appendCandidate(root, {
      slug: 'my-slug',
      signature: {
        phase: 'execute',
        errorClass: 'timeout',
        analyzerRecommendation: 'retry',
        taskState: 'failed',
      },
      summary: 'a summary',
      evidence: {
        archiveId: 'arc-001',
        stashRef: 'stash@{0}',
        analyzerSidecar: 'sidecar.json',
      },
    });

    const ledgerFile = candidatesLedgerPath(root);
    assert.ok(fs.existsSync(ledgerFile), 'candidates.jsonl must be created');

    const lines = readLinesRaw(ledgerFile);
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line; got ${lines.length}`);

    const parsed = JSON.parse(lines[0]);
    assert.deepStrictEqual(
      Object.keys(parsed).sort(),
      ['evidence', 'signature', 'signatureHash', 'slug', 'summary', 'ts'].sort(),
      `top-level keys must match the contract; got ${JSON.stringify(Object.keys(parsed))}`
    );

    assert.deepStrictEqual(
      Object.keys(parsed.signature).sort(),
      ['analyzerRecommendation', 'errorClass', 'phase', 'taskState'].sort(),
      `signature keys must match the contract; got ${JSON.stringify(Object.keys(parsed.signature))}`
    );

    assert.deepStrictEqual(
      Object.keys(parsed.evidence).sort(),
      ['analyzerSidecar', 'archiveId', 'stashRef'].sort(),
      `evidence keys must match the contract; got ${JSON.stringify(Object.keys(parsed.evidence))}`
    );

    assert.strictEqual(parsed.slug, 'my-slug');
    assert.strictEqual(parsed.summary, 'a summary');
    assert.strictEqual(parsed.signature.phase, 'execute');
    assert.strictEqual(parsed.signature.errorClass, 'timeout');
    assert.strictEqual(parsed.signature.analyzerRecommendation, 'retry');
    assert.strictEqual(parsed.signature.taskState, 'failed');
    assert.strictEqual(parsed.evidence.archiveId, 'arc-001');
    assert.strictEqual(parsed.evidence.stashRef, 'stash@{0}');
    assert.strictEqual(parsed.evidence.analyzerSidecar, 'sidecar.json');
    assert.ok(typeof parsed.ts === 'string' && !Number.isNaN(new Date(parsed.ts).getTime()), 'ts must be a parseable timestamp string');
    assert.ok(typeof parsed.signatureHash === 'string' && parsed.signatureHash.length > 0, 'signatureHash must be a non-empty string');
  } finally {
    cleanup(root);
  }
});

await test('TC2: identical four signature fields yield the same signatureHash', async () => {
  const sigA = { phase: 'execute', errorClass: 'timeout', analyzerRecommendation: 'retry', taskState: 'failed' };
  const sigB = { phase: 'execute', errorClass: 'timeout', analyzerRecommendation: 'retry', taskState: 'failed' };
  const hashA = hashSignature(sigA);
  const hashB = hashSignature(sigB);
  assert.strictEqual(hashA, hashB, 'identical four-field signatures must hash identically');
});

await test('TC3: any single differing signature field yields a different signatureHash', async () => {
  const base = { phase: 'execute', errorClass: 'timeout', analyzerRecommendation: 'retry', taskState: 'failed' };
  const baseHash = hashSignature(base);

  const variants = [
    { ...base, phase: 'verify' },
    { ...base, errorClass: 'infra' },
    { ...base, analyzerRecommendation: 'human' },
    { ...base, taskState: 'complete' },
  ];

  for (const variant of variants) {
    const variantHash = hashSignature(variant);
    assert.notStrictEqual(
      variantHash,
      baseHash,
      `a change to a single signature field must change the hash; field diff: ${JSON.stringify(variant)}`
    );
  }
});

await test('TC4: differing summary/slug/evidence/ts with equal signature fields yields identical signatureHash', async () => {
  const root = makeTmpRoot();
  try {
    const signature = { phase: 'execute', errorClass: 'timeout', analyzerRecommendation: 'retry', taskState: 'failed' };

    appendCandidate(root, {
      slug: 'slug-one',
      signature,
      summary: 'summary one',
      evidence: { archiveId: 'arc-one', stashRef: 'stash-one', analyzerSidecar: 'sidecar-one.json' },
    });
    appendCandidate(root, {
      slug: 'slug-two-different',
      signature,
      summary: 'a completely different summary',
      evidence: { archiveId: 'arc-two', stashRef: 'stash-two', analyzerSidecar: 'sidecar-two.json' },
    });

    const ledgerFile = candidatesLedgerPath(root);
    const lines = readLinesRaw(ledgerFile);
    assert.strictEqual(lines.length, 2, `expected two entries; got ${lines.length}`);

    const [first, second] = lines.map((l) => JSON.parse(l));
    assert.notStrictEqual(first.slug, second.slug, 'precondition: slugs differ');
    assert.notStrictEqual(first.summary, second.summary, 'precondition: summaries differ');
    assert.notStrictEqual(JSON.stringify(first.evidence), JSON.stringify(second.evidence), 'precondition: evidence differs');
    // ts values may coincide at millisecond resolution on a fast machine, but
    // the hash contract does not depend on ts regardless — assert the hash
    // equality directly, which is the behavior under test.
    assert.strictEqual(
      first.signatureHash,
      second.signatureHash,
      'signatureHash must be unaffected by differing summary/slug/evidence/ts when the four signature fields are equal'
    );
  } finally {
    cleanup(root);
  }
});

await test('TC5: nullable signature fields, null slug, and null evidence pointers serialize cleanly as null', async () => {
  const root = makeTmpRoot();
  try {
    appendCandidate(root, {
      slug: null,
      signature: {
        phase: 'execute',
        errorClass: 'timeout',
        analyzerRecommendation: null,
        taskState: null,
      },
      summary: 'summary with nulls',
      evidence: {
        archiveId: null,
        stashRef: null,
        analyzerSidecar: null,
      },
    });

    const ledgerFile = candidatesLedgerPath(root);
    const lines = readLinesRaw(ledgerFile);
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line; got ${lines.length}`);

    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.slug, null, 'slug must serialize as null');
    assert.strictEqual(parsed.signature.analyzerRecommendation, null, 'signature.analyzerRecommendation must serialize as null');
    assert.strictEqual(parsed.signature.taskState, null, 'signature.taskState must serialize as null');
    assert.strictEqual(parsed.evidence.archiveId, null, 'evidence.archiveId must serialize as null');
    assert.strictEqual(parsed.evidence.stashRef, null, 'evidence.stashRef must serialize as null');
    assert.strictEqual(parsed.evidence.analyzerSidecar, null, 'evidence.analyzerSidecar must serialize as null');
    // Keys must still be present (not omitted) even though the values are null.
    assert.ok('analyzerRecommendation' in parsed.signature, 'analyzerRecommendation key must be present');
    assert.ok('taskState' in parsed.signature, 'taskState key must be present');
    assert.ok('archiveId' in parsed.evidence, 'archiveId key must be present');
    assert.ok('stashRef' in parsed.evidence, 'stashRef key must be present');
    assert.ok('analyzerSidecar' in parsed.evidence, 'analyzerSidecar key must be present');
  } finally {
    cleanup(root);
  }
});

await test('TC6: an unwritable (directory) ledger path never throws and emits exactly one onWarn line', async () => {
  const root = makeTmpRoot();
  try {
    const ledgerFile = candidatesLedgerPath(root);
    // Sabotage the write target: a DIRECTORY at the ledger path makes any
    // append/write throw (EISDIR).
    fs.mkdirSync(ledgerFile, { recursive: true });

    const warnings = [];
    const onWarn = (message) => warnings.push(message);

    let threw = null;
    try {
      appendCandidate(root, {
        slug: 'doomed-slug',
        signature: { phase: 'execute', errorClass: 'timeout', analyzerRecommendation: 'retry', taskState: 'failed' },
        summary: 'this write must fail softly',
        evidence: { archiveId: null, stashRef: null, analyzerSidecar: null },
      }, { onWarn });
    } catch (e) {
      threw = e;
    }

    assert.strictEqual(threw, null, `appendCandidate must never throw on a write failure; threw: ${threw && threw.message}`);
    assert.strictEqual(warnings.length, 1, `expected exactly one onWarn call; got ${warnings.length}`);
    assert.ok(typeof warnings[0] === 'string' && warnings[0].length > 0, 'the warning message must be a non-empty string');
  } finally {
    cleanup(root);
  }
});

await test('TC7: emitSecondaryFindingCandidates with a single "defer" disposition writes exactly one marked JSONL line', async () => {
  const root = makeTmpRoot();
  try {
    emitSecondaryFindingCandidates(root, {
      secondaryFindings: [{ id: 'F1', summary: 's1' }],
      findingDispositions: [{ findingId: 'F1', disposition: 'defer', note: 'n' }],
    });

    const ledgerFile = candidatesLedgerPath(root);
    const lines = readLinesRaw(ledgerFile);
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line; got ${lines.length}`);

    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.signature.errorClass, 'analysis-secondary-finding');
    assert.strictEqual(parsed.slug, 'F1');
    assert.strictEqual(parsed.signature.taskState, 'defer');
    assert.ok(typeof parsed.summary === 'string' && parsed.summary.includes('s1'), `summary must contain 's1'; got ${parsed.summary}`);
    assert.ok(typeof parsed.summary === 'string' && parsed.summary.includes('n'), `summary must contain 'n'; got ${parsed.summary}`);
  } finally {
    cleanup(root);
  }
});

await test('TC8: emitSecondaryFindingCandidates with a single "not_applicable" disposition writes exactly one marked JSONL line', async () => {
  const root = makeTmpRoot();
  try {
    emitSecondaryFindingCandidates(root, {
      secondaryFindings: [{ id: 'F2', summary: 's2' }],
      findingDispositions: [{ findingId: 'F2', disposition: 'not_applicable', note: 'm' }],
    });

    const ledgerFile = candidatesLedgerPath(root);
    const lines = readLinesRaw(ledgerFile);
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line; got ${lines.length}`);

    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.signature.errorClass, 'analysis-secondary-finding');
    assert.strictEqual(parsed.slug, 'F2');
    assert.strictEqual(parsed.signature.taskState, 'not_applicable');
  } finally {
    cleanup(root);
  }
});

await test('TC9: dispositions valued only "fix" write zero ledger lines', async () => {
  const root = makeTmpRoot();
  try {
    emitSecondaryFindingCandidates(root, {
      secondaryFindings: [{ id: 'F3', summary: 's3' }, { id: 'F4', summary: 's4' }],
      findingDispositions: [
        { findingId: 'F3', disposition: 'fix' },
        { findingId: 'F4', disposition: 'fix' },
      ],
    });

    const ledgerFile = candidatesLedgerPath(root);
    const lines = readLinesRaw(ledgerFile);
    assert.strictEqual(lines.length, 0, `expected zero JSONL lines for fix-only dispositions; got ${lines.length}`);
  } finally {
    cleanup(root);
  }
});

await test('TC10: a mixed batch of defer + fix + not_applicable writes exactly two lines for the non-fix findings', async () => {
  const root = makeTmpRoot();
  try {
    emitSecondaryFindingCandidates(root, {
      secondaryFindings: [
        { id: 'F5', summary: 's5' },
        { id: 'F6', summary: 's6' },
        { id: 'F7', summary: 's7' },
      ],
      findingDispositions: [
        { findingId: 'F5', disposition: 'defer' },
        { findingId: 'F6', disposition: 'fix' },
        { findingId: 'F7', disposition: 'not_applicable' },
      ],
    });

    const ledgerFile = candidatesLedgerPath(root);
    const lines = readLinesRaw(ledgerFile);
    assert.strictEqual(lines.length, 2, `expected exactly two JSONL lines; got ${lines.length}`);

    const slugs = lines.map((l) => JSON.parse(l).slug).sort();
    assert.deepStrictEqual(slugs, ['F5', 'F7'], `expected the two non-fix finding ids; got ${JSON.stringify(slugs)}`);
  } finally {
    cleanup(root);
  }
});

await test('TC11: emitSecondaryFindingCandidates never throws on an unwritable ledger path and forwards a descriptive warning', async () => {
  const root = makeTmpRoot();
  try {
    const ledgerFile = candidatesLedgerPath(root);
    fs.mkdirSync(ledgerFile, { recursive: true });

    const warnings = [];
    const onWarn = (message) => warnings.push(message);

    let threw = null;
    try {
      emitSecondaryFindingCandidates(root, {
        secondaryFindings: [{ id: 'F8', summary: 's8' }],
        findingDispositions: [{ findingId: 'F8', disposition: 'defer', note: 'doomed' }],
      }, { onWarn });
    } catch (e) {
      threw = e;
    }

    assert.strictEqual(threw, null, `emitSecondaryFindingCandidates must never throw on a write failure; threw: ${threw && threw.message}`);
    assert.ok(
      warnings.some((w) => typeof w === 'string' && w.includes('Failed to append candidate to candidates.jsonl')),
      `expected an onWarn message containing 'Failed to append candidate to candidates.jsonl'; got ${JSON.stringify(warnings)}`
    );
  } finally {
    cleanup(root);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
