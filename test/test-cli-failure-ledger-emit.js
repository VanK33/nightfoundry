#!/usr/bin/env node
/**
 * test-cli-failure-ledger-emit.js — Hermetic contract test for
 * emitCliFailureCandidate (src/orchestrator/core/candidates-ledger.js) and
 * for the three CLI command wrappers (dry-run.js, run.js, task.js) that call
 * it on their pipeline-failure exit-1 leg.
 *
 * This suite NEVER imports or reaches the real SDK: it only exercises the
 * pure candidates-ledger helper against fs.mkdtemp fixture roots, and reads
 * the three command source files as plain text (the wrappers construct
 * their own Pipeline and call process.exit, so they are asserted by source
 * inspection rather than executed — mirroring the precedent set by
 * test/test-dry-run.js TC4).
 *
 * Coverage:
 *   TC1 — emitCliFailureCandidate on an fs.mkdtemp projectRoot with a
 *         synthetic multi-line-message error writes exactly one JSONL line
 *         into archives/candidates.jsonl whose signature deep-equals
 *         { phase, errorClass: lintErrorClass(err), analyzerRecommendation:
 *         null, taskState: null }, whose summary is only the first line of
 *         err.message, and whose slug is the spec basename with
 *         '.spec.md' stripped.
 *   TC2 — with archives/candidates.jsonl pre-created as a directory so the
 *         write fails, the helper does not throw and routes exactly one
 *         message to the injected onWarn spy.
 *   TC3 — reading each of src/cli/commands/dry-run.js, run.js and task.js
 *         as text, each source matches an 'emitCliFailureCandidate('
 *         call (open paren, not the bare identifier).
 *   TC4 — in run.js and task.js the source index of that call is greater
 *         than the index of the 'instanceof InfrastructureError' branch.
 *
 * Run: node test/test-cli-failure-ledger-emit.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  candidatesLedgerPath,
  lintErrorClass,
  emitCliFailureCandidate,
} from '../src/orchestrator/core/candidates-ledger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function makeTmpRoot(prefix = 'cc-orch-cli-failure-ledger-') {
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

await test('TC1: emitCliFailureCandidate writes exactly one JSONL line with the pinned signature, first-line summary and stripped slug', async () => {
  const root = makeTmpRoot();
  try {
    const err = new Error('First line of the message\nSecond line with extra diagnostic detail\nThird line');
    const specPath = path.join(root, 'my-feature.spec.md');

    emitCliFailureCandidate(root, { phase: 'run', err, specPath });

    const ledgerFile = candidatesLedgerPath(root);
    assert.ok(fs.existsSync(ledgerFile), 'candidates.jsonl must be created');

    const lines = readLinesRaw(ledgerFile);
    assert.strictEqual(lines.length, 1, `expected exactly one JSONL line; got ${lines.length}`);

    const parsed = JSON.parse(lines[0]);

    assert.deepStrictEqual(
      parsed.signature,
      {
        phase: 'run',
        errorClass: lintErrorClass(err),
        analyzerRecommendation: null,
        taskState: null,
      },
      `signature must deep-equal the pinned shape; got ${JSON.stringify(parsed.signature)}`
    );

    assert.strictEqual(parsed.summary, 'First line of the message',
      `summary must be only the first line of err.message; got ${JSON.stringify(parsed.summary)}`);

    assert.strictEqual(parsed.slug, 'my-feature',
      `slug must be the spec basename with '.spec.md' stripped; got ${JSON.stringify(parsed.slug)}`);
  } finally {
    cleanup(root);
  }
});

await test('TC2: a ledger write failure (directory at the JSONL path) does not throw and routes exactly one message to onWarn', async () => {
  const root = makeTmpRoot();
  try {
    const ledgerFile = candidatesLedgerPath(root);
    // Sabotage the write target: a DIRECTORY at the ledger path makes any
    // append/write throw (EISDIR).
    fs.mkdirSync(ledgerFile, { recursive: true });

    const warnings = [];
    const onWarn = (message) => warnings.push(message);

    const err = new Error('boom');
    const specPath = path.join(root, 'doomed.spec.md');

    let threw = null;
    try {
      emitCliFailureCandidate(root, { phase: 'dry-run', err, specPath, onWarn });
    } catch (e) {
      threw = e;
    }

    assert.strictEqual(threw, null, `emitCliFailureCandidate must never throw on a write failure; threw: ${threw && threw.message}`);
    assert.strictEqual(warnings.length, 1, `expected exactly one onWarn call; got ${warnings.length}`);
    assert.ok(typeof warnings[0] === 'string' && warnings[0].length > 0, 'the warning message must be a non-empty string');
  } finally {
    cleanup(root);
  }
});

await test("TC3: dry-run.js, run.js and task.js each contain an 'emitCliFailureCandidate(' call", async () => {
  const dryRunPath = path.resolve(__dirname, '../src/cli/commands/dry-run.js');
  const runPath = path.resolve(__dirname, '../src/cli/commands/run.js');
  const taskPath = path.resolve(__dirname, '../src/cli/commands/task.js');

  const dryRunSource = fs.readFileSync(dryRunPath, 'utf8');
  const runSource = fs.readFileSync(runPath, 'utf8');
  const taskSource = fs.readFileSync(taskPath, 'utf8');

  assert.ok(dryRunSource.includes('emitCliFailureCandidate('),
    "dry-run.js must call emitCliFailureCandidate(...)");
  assert.ok(runSource.includes('emitCliFailureCandidate('),
    "run.js must call emitCliFailureCandidate(...)");
  assert.ok(taskSource.includes('emitCliFailureCandidate('),
    "task.js must call emitCliFailureCandidate(...)");
});

await test("TC4: in run.js and task.js the emitCliFailureCandidate( call index follows the 'instanceof InfrastructureError' branch index", async () => {
  const runPath = path.resolve(__dirname, '../src/cli/commands/run.js');
  const taskPath = path.resolve(__dirname, '../src/cli/commands/task.js');

  const runSource = fs.readFileSync(runPath, 'utf8');
  const taskSource = fs.readFileSync(taskPath, 'utf8');

  const runInfraIdx = runSource.indexOf('instanceof InfrastructureError');
  const runEmitIdx = runSource.indexOf('emitCliFailureCandidate(');
  assert.ok(runInfraIdx !== -1, "run.js must contain an 'instanceof InfrastructureError' branch");
  assert.ok(runEmitIdx !== -1, "run.js must contain an 'emitCliFailureCandidate(' call");
  assert.ok(runEmitIdx > runInfraIdx,
    `run.js: emitCliFailureCandidate( call (index ${runEmitIdx}) must appear after the InfrastructureError branch (index ${runInfraIdx})`);

  const taskInfraIdx = taskSource.indexOf('instanceof InfrastructureError');
  const taskEmitIdx = taskSource.indexOf('emitCliFailureCandidate(');
  assert.ok(taskInfraIdx !== -1, "task.js must contain an 'instanceof InfrastructureError' branch");
  assert.ok(taskEmitIdx !== -1, "task.js must contain an 'emitCliFailureCandidate(' call");
  assert.ok(taskEmitIdx > taskInfraIdx,
    `task.js: emitCliFailureCandidate( call (index ${taskEmitIdx}) must appear after the InfrastructureError branch (index ${taskInfraIdx})`);
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);

}

run();
