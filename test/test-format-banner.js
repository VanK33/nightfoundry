#!/usr/bin/env node

/**
 * Unit tests for Pipeline._formatBanner().
 *
 * Instantiates a minimal Pipeline-shaped stub (via Object.create so the
 * constructor — which spins up agents and filesystem helpers — is never
 * called) and exercises the pure-logic helper directly.
 */

import { Pipeline } from '../src/orchestrator/core/pipeline.js';
import { formatBanner } from '../src/orchestrator/core/banner.js';

async function main() {
  let passed = 0;
  let failed = 0;

  function assert(label, condition) {
    if (condition) {
      console.log(`  [PASS] ${label}`);
      passed++;
    } else {
      console.log(`  [FAIL] ${label}`);
      failed++;
    }
  }

  // Create a minimal stub: inherit Pipeline's prototype without invoking
  // the constructor (which needs real agents, filesystems, etc.).
  const pipeline = Object.create(Pipeline.prototype);

  console.log('=== _formatBanner() Unit Tests ===\n');

  // ── TC1: Short description → single line returned ─────────────────────
  console.log('TC1: Short description → single line returned');
  {
    const lines = pipeline._formatBanner('Milestone', '001', 'A brief title');
    assert('returns exactly one line', lines.length === 1);
    assert('line contains prefix, id, and title', lines[0] === 'Milestone 001: A brief title');
  }

  // ── TC2: `. ` split → title + wrapped body ────────────────────────────
  console.log('\nTC2: `. ` split → title + wrapped body');
  {
    const lines = pipeline._formatBanner(
      'Mission', '002',
      'First sentence. This is the body text that follows.'
    );
    assert('first line is the title', lines[0] === 'Mission 002: First sentence');
    assert('second line contains body', lines.length >= 2);
    assert('body line does not contain title text', !lines[1].includes('First sentence'));
    assert('body contains expected text', lines[1].includes('This is the body text'));
  }

  // ── TC3: `\n` split → title + wrapped body ────────────────────────────
  console.log('\nTC3: `\\n` split → title + wrapped body');
  {
    const lines = pipeline._formatBanner(
      'Mission', '003',
      'Title line\nBody content on next line'
    );
    assert('first line is the title', lines[0] === 'Mission 003: Title line');
    assert('at least two lines returned', lines.length >= 2);
    assert('second line contains body content', lines[1].includes('Body content'));
  }

  // ── TC4: Suffix appears on title line only ────────────────────────────
  console.log('\nTC4: Suffix appears on title line only');
  {
    const lines = pipeline._formatBanner(
      'Milestone', '004',
      'My title. Extra body words here.',
      { suffix: ' ===' }
    );
    assert('title line ends with suffix', lines[0].endsWith(' ==='));
    assert('body line does not contain suffix', lines.length < 2 || !lines[1].includes('==='));
  }

  // ── TC5: Indent prepends every line ──────────────────────────────────
  console.log('\nTC5: Indent prepends every line');
  {
    const indent = '    ';
    const lines = pipeline._formatBanner(
      'Mission', '005',
      'Title text. Body content that should also be indented when rendered.',
      { indent }
    );
    assert('at least two lines returned', lines.length >= 2);
    const allIndented = lines.every((l) => l.startsWith(indent));
    assert('every line starts with indent', allIndented);
  }

  // ── TC6: Long body text word-wraps around 72 chars ───────────────────
  console.log('\nTC6: Long body text word-wraps around 72 chars');
  {
    const longBody =
      'Short title. ' +
      'This is a very long body that contains many words and should be ' +
      'wrapped by the greedy word-wrap algorithm so that no single output ' +
      'line exceeds roughly seventy-two characters in total length including ' +
      'any indent prefix that may have been supplied by the caller.';

    // Pass maxBodyLines: 5 explicitly — production default is 1 (per
    // dogfood 9b's "banner body: 1 line max" decision), but this test
    // exists to verify the word-wrap algorithm itself, which only kicks
    // in when maxBodyLines > 1. Override for test scope only.
    const lines = pipeline._formatBanner('Milestone', '006', longBody, { maxBodyLines: 5, wrapWidth: 72 });
    // Title line (index 0) may be longer; body lines should wrap
    const bodyLines = lines.slice(1);
    assert('produces multiple body lines for long text', bodyLines.length > 1);
    const allShort = bodyLines.every((l) => l.length <= 72);
    assert('all body lines are at or under 72 chars', allShort);
  }

  // ── TC7: formatBanner standalone module parity ───────────────────────
  console.log('\nTC7: formatBanner standalone module parity');
  {
    const lines = formatBanner('Milestone', '001', 'A brief title');
    assert('standalone module returns one line for short description', lines.length === 1);
    assert('standalone module output matches pipeline._formatBanner TC1', lines[0] === 'Milestone 001: A brief title');
    const pipelineLines = pipeline._formatBanner('Milestone', '001', 'A brief title');
    assert('standalone formatBanner output deep-equals pipeline._formatBanner output', JSON.stringify(lines) === JSON.stringify(pipelineLines));
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
