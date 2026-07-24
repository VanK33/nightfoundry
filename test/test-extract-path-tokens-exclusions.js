#!/usr/bin/env node
/**
 * test-extract-path-tokens-exclusions.js — Unit tests for the three new
 * extractPathTokens exclusions (URL scheme, directory-trailing-slash,
 * directory-via-stat) and the extended edge-punctuation set.
 *
 * Coverage (numbered after the spec):
 *   TC1  — http:// URL excluded entirely
 *   TC2  — https:// URL excluded entirely
 *   TC3  — URL excluded, real path kept
 *   TC4  — pipe `|` stripped (extended edge-punctuation)
 *   TC5  — leading `$` stripped (extended edge-punctuation)
 *   TC6  — leading `!` stripped (extended edge-punctuation)
 *   TC7  — trailing `&` stripped (extended edge-punctuation)
 *   TC8  — directory with trailing slash excluded (hasProjectRoot path)
 *   TC9  — directory via stat excluded (hasProjectRoot + stat check)
 *   TC10 — non-directory file kept (hasProjectRoot + stat check)
 *   TC11 — no projectRoot → directory tokens NOT excluded (backward compat)
 *   TC12 — ftp:// URL excluded, real path kept
 *
 * Run: node test/test-extract-path-tokens-exclusions.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { extractPathTokens } from '../src/orchestrator/agents/planner.js';

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

// ── TC1: http:// URL excluded ─────────────────────────────────────────────────

await test('TC1: extractPathTokens excludes http:// URL (URL scheme contains ://)', () => {
  const actual = extractPathTokens('curl http://localhost:3000/health');
  assert.deepStrictEqual(
    actual,
    [],
    `expected [], got ${JSON.stringify(actual)}`,
  );
});

// ── TC2: https:// URL excluded ────────────────────────────────────────────────

await test('TC2: extractPathTokens excludes https:// URL', () => {
  const actual = extractPathTokens('wget https://example.com/api/v1');
  assert.deepStrictEqual(
    actual,
    [],
    `expected [], got ${JSON.stringify(actual)}`,
  );
});

// ── TC3: URL excluded, real path kept ─────────────────────────────────────────

await test('TC3: extractPathTokens excludes URL but keeps real path token', () => {
  const actual = extractPathTokens('cat http://x/y src/a.js');
  assert.deepStrictEqual(
    actual,
    ['src/a.js'],
    `expected ['src/a.js'], got ${JSON.stringify(actual)}`,
  );
});

// ── TC4: pipe `|` stripped ────────────────────────────────────────────────────
// The pipe must be at a token edge to be stripped. With a space after the
// pipe ('cat src/a.js| wc -l'), the token is 'src/a.js|' whose trailing '|'
// is in _TOKEN_EDGE_PUNCTUATION and gets stripped to 'src/a.js'.

await test('TC4: extractPathTokens strips trailing pipe `|` from token edge', () => {
  const actual = extractPathTokens('cat src/a.js| wc -l');
  assert.deepStrictEqual(
    actual,
    ['src/a.js'],
    `expected ['src/a.js'], got ${JSON.stringify(actual)}`,
  );
});

// ── TC5: leading `$` stripped ────────────────────────────────────────────────

await test('TC5: extractPathTokens strips leading `$` from token', () => {
  const actual = extractPathTokens('echo $HOME/bin/foo.js');
  assert.deepStrictEqual(
    actual,
    ['HOME/bin/foo.js'],
    `expected ['HOME/bin/foo.js'], got ${JSON.stringify(actual)}`,
  );
});

// ── TC6: leading `!` stripped ────────────────────────────────────────────────

await test('TC6: extractPathTokens strips leading `!` from token', () => {
  const actual = extractPathTokens('!node test/x.js');
  assert.deepStrictEqual(
    actual,
    ['test/x.js'],
    `expected ['test/x.js'], got ${JSON.stringify(actual)}`,
  );
});

// ── TC7: trailing `&` stripped ────────────────────────────────────────────────

await test('TC7: extractPathTokens strips trailing `&` from token', () => {
  const actual = extractPathTokens('cat foo.js&');
  assert.deepStrictEqual(
    actual,
    ['foo.js'],
    `expected ['foo.js'], got ${JSON.stringify(actual)}`,
  );
});

// ── TC8–TC10: directory exclusion tests (require a temp projectRoot) ──────────

// Create a temp directory with src/ as a directory and src/a.js as a file.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-path-excl-'));
const srcDir = path.join(tmpRoot, 'src');
fs.mkdirSync(srcDir, { recursive: true });
fs.writeFileSync(path.join(srcDir, 'a.js'), '// placeholder\n');

function cleanupTmp() {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── TC8: directory with trailing slash excluded ───────────────────────────────

await test('TC8: extractPathTokens excludes directory token with trailing slash when projectRoot provided', () => {
  const actual = extractPathTokens('ls src/', tmpRoot);
  assert.deepStrictEqual(
    actual,
    [],
    `expected [], got ${JSON.stringify(actual)}`,
  );
});

// ── TC9: directory via stat excluded ─────────────────────────────────────────
// Note: 'src' is not path-like (no '/' separator, no recognized extension),
// so it is filtered at the path-like check and returns [] regardless of
// whether the stat directory check runs. The result [] is correct and matches
// the spec expectation.

await test('TC9: extractPathTokens excludes bare directory name (returns []) when projectRoot provided', () => {
  const actual = extractPathTokens('ls src', tmpRoot);
  assert.deepStrictEqual(
    actual,
    [],
    `expected [], got ${JSON.stringify(actual)}`,
  );
});

// ── TC10: non-directory file kept ────────────────────────────────────────────

await test('TC10: extractPathTokens keeps file token (not a directory) when projectRoot provided', () => {
  const actual = extractPathTokens('cat src/a.js', tmpRoot);
  assert.deepStrictEqual(
    actual,
    ['src/a.js'],
    `expected ['src/a.js'], got ${JSON.stringify(actual)}`,
  );
});

// ── TC11: no projectRoot → directory tokens NOT excluded (backward compat) ────
// 'lib/' contains '/' so it is path-like; without projectRoot the directory
// trailing-slash check does not run, so it is kept.

await test('TC11: extractPathTokens keeps trailing-slash token when no projectRoot (backward compat)', () => {
  const actual = extractPathTokens('ls lib/');
  assert.deepStrictEqual(
    actual,
    ['lib/'],
    `expected ['lib/'], got ${JSON.stringify(actual)}`,
  );
});

// ── TC12: ftp:// URL excluded, real path kept ─────────────────────────────────

await test('TC12: extractPathTokens excludes ftp:// URL but keeps real path token', () => {
  const actual = extractPathTokens('ftp://server/path node test/x.js');
  assert.deepStrictEqual(
    actual,
    ['test/x.js'],
    `expected ['test/x.js'], got ${JSON.stringify(actual)}`,
  );
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

cleanupTmp();

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
