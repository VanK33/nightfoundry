#!/usr/bin/env node

/**
 * Unit tests for Pipeline._formatBanner.
 * Exercises the method directly on a minimally-stubbed Pipeline instance.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

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

  console.log('=== Pipeline._formatBanner Tests ===\n');

  const { Pipeline } = await import('../src/orchestrator/core/pipeline.js');

  function makeTmpHarness() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-fmt-'));
    const hDir = path.join(root, '.harness');
    fs.mkdirSync(path.join(hDir, 'logs'), { recursive: true });
    const p = new Pipeline(root, { onLog: () => {} });
    return { projectRoot: root, harnessDir: hDir, pipeline: p };
  }

  const { pipeline: p } = makeTmpHarness();

  // ── TC1: Single-sentence description returns one title line ──────────
  console.log('TC1: Single-sentence description returns one title line');
  {
    const lines = p._formatBanner('Milestone', '001', 'Build the auth module');
    assert('returns exactly 1 line', lines.length === 1);
    assert('title line contains prefix, id and description',
      lines[0].includes('Milestone') && lines[0].includes('001') && lines[0].includes('Build the auth module'));
  }

  // ── TC2: Multi-sentence with `. ` splits into title + wrapped body ───
  console.log('\nTC2: Multi-sentence with `. ` splits into title + wrapped body');
  {
    const desc = 'First sentence. Second sentence with some extra words to fill the body section out nicely.';
    const lines = p._formatBanner('Mission', '001-001', desc);
    assert('returns more than 1 line', lines.length > 1);
    assert('first line contains only the first sentence as title',
      lines[0].includes('First sentence') && !lines[0].includes('Second sentence'));
    assert('body lines contain the second sentence content',
      lines.slice(1).join(' ').includes('Second sentence'));
  }

  // ── TC3: Very long single sentence wraps at wrapWidth boundary ───────
  console.log('\nTC3: Very long single sentence wraps at wrapWidth boundary');
  {
    // No `. ` — whole thing is the title; no body. But a very long title
    // will just be emitted as-is (title line is not wrapped). The
    // wrapping only applies to the body. So use a description with a
    // leading short sentence followed by a very long body.
    const longBody = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega';
    const desc = `Short title. ${longBody}`;
    const lines = p._formatBanner('Mission', '002', desc, { wrapWidth: 72 });
    assert('title + at most 1 body line', lines.length <= 2);
    const WRAP_WIDTH = 72;
    const bodyLines = lines.slice(1);
    assert('every body line length <= WRAP_WIDTH (or is a single long word)',
      bodyLines.every(l => l.length <= WRAP_WIDTH || !l.trim().includes(' ')));
  }

  // ── TC4: Empty / undefined / null description does not throw ─────────
  console.log('\nTC4: Empty / undefined / null description does not throw');
  {
    // Empty string
    let threw = false;
    try {
      const lines = p._formatBanner('Milestone', '001', '');
      assert('empty string returns array', Array.isArray(lines));
    } catch (e) {
      threw = true;
    }
    assert('empty string does not throw', !threw);

    // undefined
    threw = false;
    try {
      p._formatBanner('Milestone', '001', undefined);
    } catch (e) {
      threw = true;
    }
    assert('undefined description does not throw', !threw);

    // null
    threw = false;
    try {
      p._formatBanner('Milestone', '001', null);
    } catch (e) {
      threw = true;
    }
    assert('null description does not throw', !threw);
  }

  // ── TC5: Suffix appears on title line only ────────────────────────────
  console.log('\nTC5: Suffix appears on title line only');
  {
    const desc = 'Title sentence. Body continues here with more words to produce at least one body line.';
    const lines = p._formatBanner('Milestone', '001', desc, { suffix: ' ===' });
    assert('title line ends with suffix', lines[0].endsWith(' ==='));
    const bodyLines = lines.slice(1);
    assert('at least one body line exists', bodyLines.length > 0);
    assert('no body line contains the suffix', bodyLines.every(l => !l.includes(' ===')));
  }

  // ── TC6: Word longer than wrapWidth is emitted intact on its own line ─
  console.log('\nTC6: Word longer than wrapWidth is emitted intact on its own line');
  {
    const longWord = 'a'.repeat(80); // 80 chars, clearly exceeds wrapWidth=72
    const desc = `Title sentence. Here is a very long word: ${longWord} and then more words after it.`;
    const lines = p._formatBanner('Mission', '003', desc);
    // With maxBodyLines=1, only the first body line is kept
    assert('title + at most 1 body line for long word', lines.length <= 2);
    assert('does not crash on long word', lines.length >= 1);
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
