/**
 * test-config-contract.js — Contract tests for summarizer config values.
 *
 * Asserts that the summarizer's budget, tool set, and model assignment
 * are correct, stable, and consistent with the read-only invariant.
 *
 * Run: node test/test-config-contract.js
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import config from '../src/orchestrator/infra/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read summarizer.js source for spawn-contract assertions
const summarizerSrc = readFileSync(
  resolve(__dirname, '../src/orchestrator/agents/summarizer.js'),
  'utf8'
);

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

// ── TC1: summarizer budget ───────────────────────────────────────────────

test('TC1: config.budgets.summarizer === 0.50', () => {
  assert.strictEqual(config.budgets.summarizer, 0.50);
});

// ── TC2: summarizer tools deep-equal ────────────────────────────────────

test("TC2: config.tools.summarizer is empty (synthesis-only, no exploration)", () => {
  // The summarizer receives pre-computed data inline in its prompt and
  // must NOT explore the filesystem. Dogfood 3 shipped with tools
  // ['Read','Glob','Grep','Bash'] which caused a 2-minute spelunking
  // session for work that should take <15 seconds. See RETRO-dogfood-3.md.
  assert.deepStrictEqual(config.tools.summarizer, []);
});

// ── TC3: summarizerModel pinned to the haiku tier ────────────────────────

test("TC3: config.execution.summarizerModel === 'claude-haiku-4-5'", () => {
  assert.strictEqual(config.execution.summarizerModel, 'claude-haiku-4-5');
});

// ── TC4: summarizer tools are a strict subset of verifier tools ──────────

test('TC4: summarizer tools are subset of verifier tools (read-only invariant)', () => {
  const summarizerTools = config.tools.summarizer;
  const verifierTools = config.tools.verifier;
  for (const tool of summarizerTools) {
    assert.ok(
      verifierTools.includes(tool),
      `summarizer tool '${tool}' is not in verifier tools [${verifierTools.join(', ')}]`
    );
  }
});

// ── TC5: summarizer tools do NOT include 'Write' or 'Edit' ───────────────

test("TC5: summarizer tools do NOT include 'Write' or 'Edit'", () => {
  const summarizerTools = config.tools.summarizer;
  assert.ok(
    !summarizerTools.includes('Write'),
    "summarizer tools must not include 'Write'"
  );
  assert.ok(
    !summarizerTools.includes('Edit'),
    "summarizer tools must not include 'Edit'"
  );
});

// ── TC6: summarizer budget <= verifier budget (cheapest agent) ───────────

test('TC6: config.budgets.summarizer <= config.budgets.verifier (cheapest agent)', () => {
  assert.ok(
    config.budgets.summarizer <= config.budgets.verifier,
    `summarizer budget (${config.budgets.summarizer}) must be <= verifier budget (${config.budgets.verifier})`
  );
});

// ── Spawn-contract addendum: summarizer.js source inspection ─────────────
// TC1-TC4 verify that summarizer.js wires config correctly in its spawn call.

test("TC1: summarizer.js imports config from '../infra/config.js'", () => {
  assert.ok(
    summarizerSrc.includes("from '../infra/config.js'"),
    "summarizer.js must import config from '../infra/config.js'"
  );
});

test('TC2: spawn call uses config.execution.summarizerModel for model', () => {
  assert.ok(
    summarizerSrc.includes('config.execution.summarizerModel'),
    "summarizer.js spawn call must reference config.execution.summarizerModel"
  );
});

test('TC3: spawn call uses config.tools.summarizer for tools', () => {
  assert.ok(
    summarizerSrc.includes('config.tools.summarizer'),
    "summarizer.js spawn call must reference config.tools.summarizer"
  );
});

test('TC4: spawn call uses config.budgets.summarizer for maxBudget', () => {
  assert.ok(
    summarizerSrc.includes('config.budgets.summarizer'),
    "summarizer.js spawn call must reference config.budgets.summarizer"
  );
});

// ── TC: reviewerModel pinned to the sonnet tier (2026-05-26 swap from opus) ──

test("config.execution.reviewerModel === 'claude-sonnet-5[1m]'", () => {
  assert.strictEqual(config.execution.reviewerModel, 'claude-sonnet-5[1m]');
});

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
