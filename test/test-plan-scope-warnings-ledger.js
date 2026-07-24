#!/usr/bin/env node
/**
 * test-plan-scope-warnings-ledger.js — proves that scopeMapping-consistency
 * advisory warnings (surfaced by the planner's checkScopeMappingConsistency
 * check and recorded via Pipeline#_recordScopeMappingWarnings) persist
 * through the shared cross-run ledger (archives/warnings.jsonl).
 *
 * No live SDK sessions: the pipeline helper is driven directly on a
 * duck-typed instance (a plain object carrying only the `projectRoot` and
 * `onLog` fields the method actually reads), with the planner's
 * `scopeWarnings` return value stubbed inline as plain finding objects.
 *
 * Coverage:
 *   TC1 — a recorded warning round-trips through appendWarnings/readLedger
 *         with category 'plan-scope', severity 'warning', the milestone id
 *         stamped, and the description carried.
 *   TC2 — an empty/absent scopeWarnings set writes nothing (no ledger file
 *         is created at all).
 *   TC3 — re-recording the same warning while its entry is still open is
 *         deduped by content hash (no second W-id is assigned).
 *   TC4 — a ledger write failure (warnings.jsonl pre-created as a
 *         directory) does not throw and the caller continues.
 *
 * Run: node test/test-plan-scope-warnings-ledger.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { Planner } from '../src/orchestrator/agents/planner.js';
import { readLedger } from '../src/orchestrator/core/warnings-ledger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

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

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-plan-scope-warnings-'));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

function ledgerPathOf(root) {
  return path.join(root, 'archives', 'warnings.jsonl');
}

/**
 * Build a duck-typed "pipeline" — a plain object carrying only the fields
 * `_recordScopeMappingWarnings` actually reads (`projectRoot`, `onLog`) — and
 * invoke the real prototype method against it. This exercises the exact
 * production record-point logic without constructing a full Pipeline (which
 * would spin up sessions, loggers, agents, etc.).
 */
function callRecordScopeMappingWarnings(root, missionId, scopeWarnings) {
  const logs = [];
  const duck = {
    projectRoot: root,
    onLog: (msg) => logs.push(msg),
  };
  Pipeline.prototype._recordScopeMappingWarnings.call(duck, missionId, scopeWarnings);
  return { logs };
}

async function run() {

await test('TC1: recorded warning round-trips with category plan-scope, severity warning, milestone, description', async () => {
  const root = makeTmpRoot();
  try {
    const missionId = '001-002';
    // Stub the planner's checkScopeMappingConsistency return shape — the
    // pipeline only reads `.description` off each entry.
    const scopeWarnings = [
      { description: 'scope item "checkout flow" has no mapped task' },
    ];

    callRecordScopeMappingWarnings(root, missionId, scopeWarnings);

    assert.ok(fs.existsSync(ledgerPathOf(root)), 'archives/warnings.jsonl must be created');

    const entries = await readLedger(root);
    assert.strictEqual(entries.length, 1, `expected exactly 1 entry; got ${entries.length}`);

    const [entry] = entries;
    assert.strictEqual(entry.category, 'plan-scope', `category must be 'plan-scope'; got ${entry.category}`);
    assert.strictEqual(entry.severity, 'warning', `severity must be 'warning'; got ${entry.severity}`);
    assert.strictEqual(entry.status, 'open', `entry must start open; got ${entry.status}`);
    assert.ok(
      String(entry.milestone).includes(missionId),
      `the milestone id must be stamped; got ${JSON.stringify(entry.milestone)}`
    );
    assert.strictEqual(
      entry.description,
      'scope item "checkout flow" has no mapped task',
      'the description must be carried verbatim'
    );
  } finally {
    cleanup(root);
  }
});

await test('TC2: empty scopeWarnings writes no ledger file', async () => {
  const root = makeTmpRoot();
  try {
    // Empty array.
    callRecordScopeMappingWarnings(root, '001', []);
    assert.ok(!fs.existsSync(ledgerPathOf(root)), 'an empty scopeWarnings set must not create the ledger file');
    assert.ok(!fs.existsSync(path.join(root, 'archives')), 'archives/ must not be created either');

    // Absent (undefined) — same contract.
    callRecordScopeMappingWarnings(root, '001', undefined);
    assert.ok(!fs.existsSync(ledgerPathOf(root)), 'an absent scopeWarnings set must not create the ledger file');
  } finally {
    cleanup(root);
  }
});

await test('TC3: re-recording the same open warning is deduped (no new W-id)', async () => {
  const root = makeTmpRoot();
  try {
    const missionId = '001-002';
    const scopeWarnings = [
      { description: 'scope item "refund flow" has no mapped task' },
    ];

    callRecordScopeMappingWarnings(root, missionId, scopeWarnings);
    let entries = await readLedger(root);
    assert.strictEqual(entries.length, 1, 'first recording must append exactly 1 entry');
    assert.strictEqual(entries[0].id, 'W-001');
    assert.strictEqual(entries[0].status, 'open', 'the entry must remain open for the dedup to apply');

    // Re-record the identical warning while the prior entry is still open.
    callRecordScopeMappingWarnings(root, missionId, [{ ...scopeWarnings[0] }]);

    entries = await readLedger(root);
    assert.strictEqual(
      entries.length,
      1,
      `re-recording the same open warning must not duplicate; got ${entries.length} entries`
    );
    assert.strictEqual(entries[0].id, 'W-001', 'no second W-id may be assigned');
  } finally {
    cleanup(root);
  }
});

await test('TC-attach: _surfaceScopeMappingWarnings ATTACHES plan.scopeWarnings (planner side, not just a log)', async () => {
  // F2 regression pin — the previous implementation only logged the
  // advisory warnings; `plan.scopeWarnings` was never set, so the
  // pipeline's `_recordScopeMappingWarnings(mid, plan.scopeWarnings)`
  // readers found nothing to persist and the ledger silently stayed
  // empty. Drive the real planner method against a plain plan object
  // (no SessionManager needed) and prove the field is now attached.
  const planner = new Planner(
    { spawn: () => { throw new Error('unused'); } },
    { warn: () => {} },
    null,
  );
  const plan = { subMissions: [] };
  const warnings = [
    { severity: 'warning', category: 'scope-mapping-consistency', description: 'first advisory' },
    { severity: 'warning', category: 'scope-mapping-consistency', description: 'second advisory' },
  ];
  planner._surfaceScopeMappingWarnings(plan, warnings, 'test-callerLabel');

  assert.ok(
    Array.isArray(plan.scopeWarnings),
    'expected plan.scopeWarnings to be an array after _surfaceScopeMappingWarnings',
  );
  assert.strictEqual(plan.scopeWarnings.length, 2, `expected 2 scope warnings; got ${plan.scopeWarnings.length}`);
  assert.deepStrictEqual(
    plan.scopeWarnings.map((w) => w.description),
    ['first advisory', 'second advisory'],
    'expected the advisory descriptions to be attached verbatim',
  );

  // An empty warnings array must NOT create the field — the pipeline
  // reader early-returns on empty, and the "no field" absence is the
  // signal that means "no advisories this turn".
  const cleanPlan = { subMissions: [] };
  planner._surfaceScopeMappingWarnings(cleanPlan, [], 'test-callerLabel');
  assert.strictEqual(
    cleanPlan.scopeWarnings,
    undefined,
    'expected plan.scopeWarnings to remain unset when there are no advisories',
  );
});

await test('TC4: a ledger write failure is fail-soft (no throw, caller continues)', async () => {
  const root = makeTmpRoot();
  try {
    // Sabotage the write target: a DIRECTORY at the ledger path makes any
    // append/write throw (EISDIR).
    fs.mkdirSync(ledgerPathOf(root), { recursive: true });

    const missionId = '001';
    const scopeWarnings = [
      { description: 'scope item "loyalty program" has no mapped task' },
    ];

    let threw = null;
    let { logs } = { logs: [] };
    try {
      ({ logs } = callRecordScopeMappingWarnings(root, missionId, scopeWarnings));
    } catch (err) {
      threw = err;
    }

    assert.strictEqual(threw, null, `a ledger write failure must never throw; got: ${threw && threw.message}`);
    assert.ok(
      logs.some((l) => /warn/i.test(l)),
      `the failure must be logged (fail-soft, not silent); got logs: ${JSON.stringify(logs)}`
    );

    // The caller continues: a subsequent, unrelated recording call on a
    // healthy root still works after the failed one.
    const healthyRoot = makeTmpRoot();
    try {
      callRecordScopeMappingWarnings(healthyRoot, '002', [{ description: 'unrelated follow-up warning' }]);
      const entries = await readLedger(healthyRoot);
      assert.strictEqual(entries.length, 1, 'execution must continue normally after a fail-soft ledger error elsewhere');
    } finally {
      cleanup(healthyRoot);
    }
  } finally {
    cleanup(root);
  }
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
