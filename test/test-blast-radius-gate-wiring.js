/**
 * test-blast-radius-gate-wiring.js — Integration tests for the advisory
 * blast-radius block wired into the END of Pipeline._scopeCoverageGate.
 *
 * Drives the REAL Pipeline.prototype._scopeCoverageGate against a duck-typed
 * `fakeThis`, following the tmp-harness / logs-array / _allowIncompleteScope
 * pattern established by test-scope-coverage-gate.js. The fakeThis additionally
 * carries `_normalizePath` (reused verbatim from Pipeline.prototype — it does
 * not touch `this`) and a `_getSpecTargetFiles` stub, both of which are only
 * consulted by the blast-radius END block once the scope-mapping check above
 * it has already passed (or is not-applicable).
 *
 * The blast-radius block reads `changed_symbols` off the spec.json sidecar
 * living at <projectRoot>/spec.json (readState(harnessDir) throws ENOENT in
 * these tests since no state.json is ever written, so prdPath stays
 * undefined and deriveSpecJsonPath falls back to <projectRoot>/spec.json —
 * see pipeline.js _scopeCoverageGate).
 *
 * TC1: not-applicable — spec.json has no/empty changed_symbols → no
 *      blast-radius log, no ledger entry, stash stays [].
 * TC2: uncovered-triple — a changed symbol has a textual consumer outside
 *      the declared target_files → one loud onLog warning, exactly one
 *      warnings-ledger entry, and the stash is populated with the uncovered
 *      file(s).
 * TC3: fully-covered-silent — every textual consumer is inside the declared
 *      target_files → no warning, no ledger entry, stash stays [].
 * TC4: stash-reset — a pre-populated stash is unconditionally overwritten to
 *      [] at the top of the next gate invocation, even for a not-applicable
 *      input.
 *
 * Run: node test/test-blast-radius-gate-wiring.js
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { readLedger } from '../src/orchestrator/core/warnings-ledger.js';

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

// ── Helper: create a minimal tmp harness directory ────────────────────

function createTmpHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-blast-gate-'));
  const harnessDir = path.join(tmpDir, '.harness');
  fs.mkdirSync(path.join(harnessDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'plan'), { recursive: true });
  fs.mkdirSync(path.join(harnessDir, 'logs'), { recursive: true });
  return { tmpDir, harnessDir };
}

function cleanup(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * Build a minimal Pipeline-like object (duck-typing) and return it along
 * with a logs array so callers can inspect emitted messages.
 *
 * We call _scopeCoverageGate via Pipeline.prototype so we test the REAL
 * gate implementation without spinning up the full Pipeline constructor.
 *
 * `_normalizePath` is reused verbatim from Pipeline.prototype (it is a pure
 * function of its argument and never touches `this`). `_getSpecTargetFiles`
 * is a stub the caller configures per-test since it is only reached by the
 * blast-radius END block.
 */
function makeFakePipeline(harnessDir, { specTargetFiles = [] } = {}) {
  const logs = [];
  const fakeThis = {
    harnessDir,
    projectRoot: path.dirname(harnessDir),
    _allowIncompleteScope: false,
    onLog: (msg) => logs.push(msg),
    _normalizePath: Pipeline.prototype._normalizePath,
    _getSpecTargetFiles: () => specTargetFiles,
    _uncoveredConsumers: [],
  };
  return { fakeThis, logs };
}

// Grab the gate function from Pipeline prototype (avoids full constructor cost)
const scopeCoverageGate = Pipeline.prototype._scopeCoverageGate;

/**
 * A plan whose single scope item is fully covered by scopeMapping against a
 * real mission id — this lets every test case reach the blast-radius END
 * block (which only runs once the scope-mapping check above it has already
 * passed / logged "all N covered").
 */
function planFullyCovered() {
  return {
    milestones: [
      {
        id: '001',
        description: 'Milestone 1',
        missions: [
          { id: '001-001', description: 'Implement a feature' },
        ],
      },
    ],
    scopeItems: [
      { id: 's1', label: 'A feature', source: 'numbered-subsection' },
    ],
    scopeMapping: [
      { scopeItemId: 's1', missionIds: ['001-001'] },
    ],
  };
}

const SYMBOL = 'zzzBlastRadiusProbeSymbol';

function writeSpecJson(tmpDir, changedSymbols) {
  fs.writeFileSync(
    path.join(tmpDir, 'spec.json'),
    JSON.stringify({ changed_symbols: changedSymbols }),
    'utf8'
  );
}

function writeSourceFile(tmpDir, relPath, content) {
  const absPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
}

function blastRadiusLogs(logs) {
  return logs.filter((msg) => msg.includes('Blast-radius warning'));
}

// ─────────────────────────────────────────────────────────────────────────────
// TC1: not-applicable — spec.json has no/empty changed_symbols
// ─────────────────────────────────────────────────────────────────────────────
await test('TC1: not-applicable (no/empty changed_symbols) — no warning, no ledger entry, stash []', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();

  try {
    const { fakeThis, logs } = makeFakePipeline(harnessDir, { specTargetFiles: [] });

    // Case A: no spec.json written at all.
    await scopeCoverageGate.call(fakeThis, planFullyCovered(), {});
    assert.strictEqual(blastRadiusLogs(logs).length, 0, 'expected no blast-radius log when spec.json is absent');
    assert.deepStrictEqual(readLedger(tmpDir), [], 'expected no ledger entries when spec.json is absent');
    assert.deepStrictEqual(fakeThis._uncoveredConsumers, [], 'expected stash [] when spec.json is absent');

    // Case B: spec.json present but changed_symbols is an empty array.
    writeSpecJson(tmpDir, []);
    await scopeCoverageGate.call(fakeThis, planFullyCovered(), {});
    assert.strictEqual(blastRadiusLogs(logs).length, 0, 'expected no blast-radius log when changed_symbols is []');
    assert.deepStrictEqual(readLedger(tmpDir), [], 'expected no ledger entries when changed_symbols is []');
    assert.deepStrictEqual(fakeThis._uncoveredConsumers, [], 'expected stash [] when changed_symbols is []');
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC2: uncovered-triple — a consumer falls outside the declared target_files
// ─────────────────────────────────────────────────────────────────────────────
await test('TC2: uncovered consumer outside target_files — one warning, one ledger entry, populated stash', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();

  try {
    writeSpecJson(tmpDir, [SYMBOL]);
    writeSourceFile(tmpDir, 'src/covered.js', `export const ${SYMBOL} = 1;\n`);
    writeSourceFile(tmpDir, 'src/uncovered.js', `export const ${SYMBOL} = 2;\n`);

    const { fakeThis, logs } = makeFakePipeline(harnessDir, { specTargetFiles: ['src/covered.js'] });

    await scopeCoverageGate.call(fakeThis, planFullyCovered(), {});

    const warnLogs = blastRadiusLogs(logs);
    assert.strictEqual(warnLogs.length, 1, `expected exactly one blast-radius warning log, got:\n${logs.join('\n')}`);
    assert.ok(warnLogs[0].includes('src/uncovered.js'), `expected warning log to mention src/uncovered.js, got: ${warnLogs[0]}`);
    assert.ok(!warnLogs[0].includes('src/covered.js'), `expected warning log NOT to mention src/covered.js, got: ${warnLogs[0]}`);

    const ledgerEntries = readLedger(tmpDir);
    assert.strictEqual(ledgerEntries.length, 1, `expected exactly one ledger entry, got: ${JSON.stringify(ledgerEntries)}`);
    assert.strictEqual(ledgerEntries[0].category, 'blast-radius');
    assert.strictEqual(ledgerEntries[0].severity, 'warning');
    assert.ok(ledgerEntries[0].description.includes('src/uncovered.js'));

    assert.deepStrictEqual(fakeThis._uncoveredConsumers, ['src/uncovered.js']);
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC3: fully-covered-silent — every consumer is inside the declared target_files
// ─────────────────────────────────────────────────────────────────────────────
await test('TC3: fully-covered consumers — no warning, no ledger entry, stash []', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();

  try {
    writeSpecJson(tmpDir, [SYMBOL]);
    writeSourceFile(tmpDir, 'src/covered.js', `export const ${SYMBOL} = 1;\n`);
    writeSourceFile(tmpDir, 'src/uncovered.js', `export const ${SYMBOL} = 2;\n`);

    const { fakeThis, logs } = makeFakePipeline(harnessDir, {
      specTargetFiles: ['src/covered.js', 'src/uncovered.js'],
    });

    await scopeCoverageGate.call(fakeThis, planFullyCovered(), {});

    assert.strictEqual(blastRadiusLogs(logs).length, 0, `expected no blast-radius warning log, got:\n${logs.join('\n')}`);
    assert.deepStrictEqual(readLedger(tmpDir), [], 'expected no ledger entries when fully covered');
    assert.deepStrictEqual(fakeThis._uncoveredConsumers, [], 'expected stash [] when fully covered');
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TC4: stash-reset — pre-populated stash is overwritten to [] on re-entry
// ─────────────────────────────────────────────────────────────────────────────
await test('TC4: pre-populated stash is reset to [] at the top of the next invocation', async () => {
  const { tmpDir, harnessDir } = createTmpHarness();

  try {
    const { fakeThis, logs } = makeFakePipeline(harnessDir, { specTargetFiles: [] });
    fakeThis._uncoveredConsumers = ['stale/leftover-from-a-prior-run.js'];

    // Not-applicable input: no spec.json written at all.
    await scopeCoverageGate.call(fakeThis, planFullyCovered(), {});

    assert.deepStrictEqual(
      fakeThis._uncoveredConsumers,
      [],
      'expected the stale stash to be reset to [] even for a not-applicable invocation'
    );
    assert.strictEqual(blastRadiusLogs(logs).length, 0);
    assert.deepStrictEqual(readLedger(tmpDir), []);
  } finally {
    cleanup(tmpDir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
