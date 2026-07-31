/**
 * test-headline-cap.js — Unit + source-text tests for headline capping.
 *
 * The summarizer's `headline` is used VERBATIM by pipeline.js as the
 * delivery commit title. capHeadline() is the deterministic guard that
 * keeps it commit-title-shaped no matter what the model produced. This
 * file locks down both the helper's behavior and the fact that every
 * headline-producing path in summarizer.js routes through it, plus the
 * prompt-side style discipline.
 *
 * Run: node test/test-headline-cap.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { capHeadline } from '../src/orchestrator/agents/summarizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const summarizerPath = path.join(__dirname, '..', 'src', 'orchestrator', 'agents', 'summarizer.js');
const summarizerSrc = fs.readFileSync(summarizerPath, 'utf8');

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

// ── Unit: capHeadline ───────────────────────────────────────────────────

test('multi-line input keeps only the first line', () => {
  const out = capHeadline('Add retry verb\nand more details\nthird line');
  assert.equal(out, 'Add retry verb');
});

test('carriage-return newline also splits on the first line', () => {
  const out = capHeadline('First line here\r\nsecond line');
  assert.equal(out, 'First line here');
});

test('short input is returned unchanged (whitespace collapsed + trimmed)', () => {
  assert.equal(capHeadline('Add queue retry verb'), 'Add queue retry verb');
  assert.equal(capHeadline('  Add   queue  retry   verb  '), 'Add queue retry verb');
});

test('over-72 input is cut at a word boundary at or before 72 chars', () => {
  const input =
    'Delivered milestone 001 with observability improvements across the runner and queue';
  const out = capHeadline(input);
  assert.ok(out.length <= 72, `expected <= 72, got ${out.length}: "${out}"`);
  // must not split a word: the cut point in the original is whitespace
  assert.ok(
    input.startsWith(out),
    `capped output should be a prefix of the (whitespace-collapsed) input: "${out}"`
  );
  assert.ok(input[out.length] === ' ', 'cut should land on a word boundary (space follows)');
});

test('boundary before char 40 forces a hard cut at 72', () => {
  // The only space in the first 72 chars sits at index 30, then a long
  // unbroken word runs past 72. The last space at/before 72 lands before
  // index 40, so the cut hard-cuts at 72 rather than word-boundary.
  const input = `${'x'.repeat(30)} ${'y'.repeat(60)}`;
  const out = capHeadline(input);
  assert.equal(out.length, 72, `expected hard cut to length 72, got ${out.length}`);
});

test('trailing punctuation left by the cut is stripped, no ellipsis', () => {
  const input =
    'Refactor the scheduler, the queue, the runner, and the reviewer gates, plus more';
  const out = capHeadline(input);
  assert.ok(out.length <= 72, `expected <= 72, got ${out.length}`);
  assert.ok(!/[.,;:]$/.test(out), `expected no trailing punctuation, got "${out}"`);
  assert.ok(!out.includes('...'), 'expected no ellipsis');
});

test('empty and nullish inputs become empty string', () => {
  assert.equal(capHeadline(''), '');
  assert.equal(capHeadline(undefined), '');
  assert.equal(capHeadline(null), '');
});

test('non-string input is coerced then capped', () => {
  assert.equal(capHeadline(12345), '12345');
});

// ── Source-text: summarizer applies capHeadline on both paths ────────────

test('summarizer applies capHeadline on the structured-extraction path', () => {
  assert.ok(
    /headline:\s*capHeadline\(structured\.headline\)/.test(summarizerSrc),
    'expected structured path to wrap structured.headline in capHeadline()'
  );
});

test('summarizer applies capHeadline on the stub path', () => {
  assert.ok(
    /headline:\s*capHeadline\(stub\.headline\)/.test(summarizerSrc),
    'expected stub path to wrap stub.headline in capHeadline()'
  );
});

// ── Source-text: prompt carries commit-title style rules ─────────────────

test('summarizer prompt instructs commit-title headline discipline', () => {
  assert.ok(
    summarizerSrc.includes('used VERBATIM as a git commit title'),
    'expected prompt to state the headline is used verbatim as a git commit title'
  );
  assert.ok(
    /NO test counts/.test(summarizerSrc) && /NO "N\/N tasks passed"/.test(summarizerSrc),
    'expected prompt to forbid test counts and "N/N tasks passed"'
  );
  assert.ok(
    /no trailing period/.test(summarizerSrc),
    'expected prompt to forbid a trailing period'
  );
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
