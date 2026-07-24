/**
 * test-archive-gitignore.js — Unit tests for writeGitignore in archive.js.
 *
 * Verifies the .gitignore content written to an archive directory:
 *   - Contains the four expected ignored entries
 *   - Does NOT contain manifest.json or verification/ (committed entries)
 *   - Includes a header comment
 *
 * No Claude auth, no SDK. Pure fs + temp directories.
 * Run: node test/test-archive-gitignore.js
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { writeGitignore } from '../src/cli/commands/archive.js';

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

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Creates a temp dir, calls writeGitignore, reads the resulting .gitignore,
 * passes the content to the callback, then cleans up.
 */
function withGitignore(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-test-'));
  try {
    writeGitignore(tmpDir);
    const gitignorePath = path.join(tmpDir, '.gitignore');
    assert.ok(fs.existsSync(gitignorePath), '.gitignore was not created');
    const content = fs.readFileSync(gitignorePath, 'utf8');
    fn(content);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── TC1: four required ignored entries present ────────────────────────────────

test('writeGitignore creates .gitignore with logs/, snapshots/, progress/, analysis/', () => {
  withGitignore((content) => {
    const lines = content.split('\n');
    assert.ok(lines.includes('logs/'),      'Missing logs/ entry');
    assert.ok(lines.includes('snapshots/'), 'Missing snapshots/ entry');
    assert.ok(lines.includes('progress/'),  'Missing progress/ entry');
    assert.ok(lines.includes('analysis/'),  'Missing analysis/ entry');
  });
});

// ── TC2: manifest.json NOT present ───────────────────────────────────────────

test('writeGitignore .gitignore does NOT contain manifest.json', () => {
  withGitignore((content) => {
    // Only check non-comment lines — the header comment may mention
    // manifest.json as documentation, but a comment line (#...) does
    // not actually ignore anything in gitignore.
    const rules = content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    assert.ok(
      !rules.some((r) => r.includes('manifest.json')),
      'manifest.json should not be in any gitignore rule (it is committed to git)'
    );
  });
});

// ── TC3: verification/ NOT present ───────────────────────────────────────────

test('writeGitignore .gitignore does NOT contain verification/', () => {
  withGitignore((content) => {
    const rules = content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    assert.ok(
      !rules.some((r) => r.includes('verification/')),
      'verification/ should not be in any gitignore rule (it is committed to git)'
    );
  });
});

// ── TC4: header comment present ──────────────────────────────────────────────

test('writeGitignore .gitignore includes header comment', () => {
  withGitignore((content) => {
    const lines = content.split('\n');
    const hasComment = lines.some(line => line.trim().startsWith('#'));
    assert.ok(hasComment, '.gitignore should contain at least one comment line (starting with #)');
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
