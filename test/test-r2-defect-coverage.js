/**
 * test-r2-defect-coverage.js — Tests for checkDefectCoverage in scripts/audit-r2.js.
 *
 * checkDefectCoverage reads a CHANGELOG.md, extracts Defect #N mentions, checks
 * for <!-- r2-exempt: reason --> markers, and cross-references with PAIR_INVARIANTS
 * descriptions to determine which defects are covered, exempt, or uncovered.
 *
 * TC-DC-1: covered defect via PAIR_INVARIANTS match → coveredDefects includes it
 * TC-DC-2: exempt defect via r2-exempt HTML marker → exemptDefects includes it
 * TC-DC-3: uncovered defect → uncoveredDefects includes it
 * TC-DC-4: strict mode: uncoveredDefects non-empty signals non-zero exit
 * TC-DC-5: pure function returns truth regardless of mode flag
 * TC-DC-6: manifest defectCoverage section shape with allDefects/coveredDefects/uncoveredDefects
 * TC-DC-7: r2-exempt marker 1 line after heading with '#N' (no 'Defect' prefix), Defect #N 4+ lines away → exempt (regression gate for Defect #3 false-negative)
 * TC-DC-8: real CHANGELOG.md — Defect #3 must NOT appear in uncoveredDefects
 *
 * // R2-OK: not-in-test-all — wired via test:all in package.json after task completion
 *
 * Run: node test/test-r2-defect-coverage.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  checkDefectCoverage,
  PAIR_INVARIANTS,
  CHANGELOG_FILE,
} from '../scripts/audit-r2.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failCount++;
    }
  );
}

function tempDir(prefix = 'audit-r2-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// ── Defect coverage tests ────────────────────────────────────────────────────

await test('TC-DC-1: covered defect via PAIR_INVARIANTS match → coveredDefects includes it', async () => {
  const root = tempDir();
  try {
    const changelogPath = writeFile(root, 'CHANGELOG.md',
      `## v0.1.32\n- Fixed Defect #15: archive() now called on success path.\n`
    );
    // PAIR_INVARIANTS[1].description contains "Closes Defect #15"
    const result = checkDefectCoverage(changelogPath, PAIR_INVARIANTS);
    assert.ok(result.coveredDefects instanceof Map,
      'coveredDefects should be a Map');
    assert.ok(result.coveredDefects.has(15),
      `coveredDefects should contain 15, got: ${JSON.stringify([...result.coveredDefects.keys()])}`);
    assert.strictEqual(result.uncoveredDefects.length, 0,
      `uncoveredDefects should be empty, got: ${JSON.stringify(result.uncoveredDefects)}`);
  } finally { cleanup(root); }
});

await test('TC-DC-2: exempt defect via r2-exempt HTML marker → exemptDefects includes it', async () => {
  const root = tempDir();
  try {
    const changelogPath = writeFile(root, 'CHANGELOG.md',
      `## v0.2.0\n- Updated Defect #42 label copy.\n<!-- r2-exempt: UI text only -->\n`
    );
    const result = checkDefectCoverage(changelogPath, []);
    assert.ok(result.exemptDefects instanceof Map,
      'exemptDefects should be a Map');
    assert.ok(result.exemptDefects.has(42),
      `exemptDefects should contain 42, got: ${JSON.stringify([...result.exemptDefects.keys()])}`);
    const reason = result.exemptDefects.get(42);
    assert.ok(
      typeof reason === 'string' && reason.includes('UI text only'),
      `reason should contain 'UI text only', got: ${reason}`
    );
    assert.strictEqual(result.uncoveredDefects.length, 0,
      `uncoveredDefects should be empty for exempt defect, got: ${JSON.stringify(result.uncoveredDefects)}`);
  } finally { cleanup(root); }
});

await test('TC-DC-3: uncovered defect → uncoveredDefects includes it', async () => {
  const root = tempDir();
  try {
    const changelogPath = writeFile(root, 'CHANGELOG.md',
      `## v0.3.0\n- Mentions Defect #99 but no invariant covers it.\n`
    );
    const result = checkDefectCoverage(changelogPath, []);
    assert.ok(
      result.uncoveredDefects.includes(99),
      `uncoveredDefects should include 99, got: ${JSON.stringify(result.uncoveredDefects)}`
    );
  } finally { cleanup(root); }
});

await test('TC-DC-4: strict mode: uncoveredDefects non-empty signals non-zero exit', async () => {
  const root = tempDir();
  try {
    const changelogPath = writeFile(root, 'CHANGELOG.md',
      `## v0.3.0\n- Mentions Defect #99 but no invariant covers it.\n`
    );
    const result = checkDefectCoverage(changelogPath, []);
    // The pure function reports truth; exit-code logic lives in main().
    // Strict mode would call process.exit(1) when uncoveredDefects.length > 0.
    assert.ok(
      result.uncoveredDefects.length > 0,
      'uncoveredDefects should be non-empty, signalling a non-zero exit in strict mode'
    );
    assert.ok(
      result.uncoveredDefects.includes(99),
      `uncoveredDefects should include 99, got: ${JSON.stringify(result.uncoveredDefects)}`
    );
  } finally { cleanup(root); }
});

await test('TC-DC-5: pure function returns truth regardless of mode flag', async () => {
  const root = tempDir();
  try {
    const changelogPath = writeFile(root, 'CHANGELOG.md',
      `## v0.3.0\n- Mentions Defect #99 but no invariant covers it.\n`
    );
    // --warn-only is handled by main(); checkDefectCoverage itself is pure.
    // Call it without any mode flag — it should always report the real state.
    const result = checkDefectCoverage(changelogPath, []);
    assert.ok(
      result.uncoveredDefects.includes(99),
      `pure function should report uncovered defect 99 regardless of warn-only flag, ` +
      `got: ${JSON.stringify(result.uncoveredDefects)}`
    );
    // Verify allDefects includes 99 as well
    assert.ok(
      result.allDefects.includes(99),
      `allDefects should include 99, got: ${JSON.stringify(result.allDefects)}`
    );
  } finally { cleanup(root); }
});

await test('TC-DC-6: manifest defectCoverage section shape with allDefects/coveredDefects/uncoveredDefects', async () => {
  const root = tempDir();
  try {
    const changelogPath = writeFile(root, 'CHANGELOG.md',
      `## v0.1.32\n- Fixed Defect #15: archive() now called on success path.\n` +
      `## v0.3.0\n- Mentions Defect #99 but no invariant covers it.\n`
    );
    const result = checkDefectCoverage(changelogPath, PAIR_INVARIANTS);

    // Build a manifest object mirroring ARCHITECTURE-GRAPH.json's defectCoverage section
    const manifest = {
      defectCoverage: {
        allDefects: result.allDefects,
        coveredDefects: [...result.coveredDefects.keys()],
        exemptDefects: [...result.exemptDefects.keys()],
        uncoveredDefects: result.uncoveredDefects,
      },
    };

    const serialized = JSON.stringify(manifest);
    const parsed = JSON.parse(serialized);

    assert.ok('defectCoverage' in parsed,
      'parsed manifest should have defectCoverage key');
    const dc = parsed.defectCoverage;

    assert.ok(Array.isArray(dc.allDefects),
      'allDefects should be an array');
    assert.ok(dc.allDefects.includes(15),
      `allDefects should contain 15, got: ${JSON.stringify(dc.allDefects)}`);
    assert.ok(dc.allDefects.includes(99),
      `allDefects should contain 99, got: ${JSON.stringify(dc.allDefects)}`);

    assert.ok(Array.isArray(dc.coveredDefects),
      'coveredDefects should be an array');
    assert.ok(dc.coveredDefects.includes(15),
      `coveredDefects should contain 15, got: ${JSON.stringify(dc.coveredDefects)}`);

    assert.ok(Array.isArray(dc.uncoveredDefects),
      'uncoveredDefects should be an array');
    assert.ok(dc.uncoveredDefects.includes(99),
      `uncoveredDefects should contain 99, got: ${JSON.stringify(dc.uncoveredDefects)}`);
  } finally { cleanup(root); }
});

await test(
  'TC-DC-7: r2-exempt marker 1 line after heading with \'#N\' (no \'Defect\' prefix), ' +
  'Defect #N 4+ lines away from marker → exempt (regression gate for Defect #3 false-negative)',
  async () => {
    const root = tempDir();
    try {
      // Synthetic CHANGELOG mirroring the Defect #3 regression pattern:
      //   - Section heading mentions '#3' without 'Defect' prefix (so NOT added to allDefectsSet)
      //   - r2-exempt marker is placed exactly 1 line after the heading
      //   - First full 'Defect #3' mention is 4 lines after the marker (outside ±3 window
      //     from the marker, and outside ±3 window from the marker in Pass A)
      //
      // This directly reproduces the false-negative scenario where:
      //   Pass A: Defect #3 at line i=5, looks at [i-3, i+3]=[2,8]; marker is at line 1 → NOT found
      //   Pass B: marker at line j=1, looks at [j-3, j+3]=[-2,4]; Defect #3 at line 5 → NOT found
      //
      // A correct implementation must detect the defect as exempt despite this gap.
      const changelogPath = writeFile(root, 'CHANGELOG.md',
        [
          '## [0.1.27] - 2026-04-26 — #3 scheduler stall message + prompt double-emit',
          '<!-- r2-exempt: UI text framing change; no file-level structural pair pattern -->',
          '',
          '### Bug fixes',
          '- Stall message wording updated for clarity.',
          '- Defect #3 was hand-implemented after cc-orch exhibited a NEW defect class.',
        ].join('\n') + '\n'
      );

      const result = checkDefectCoverage(changelogPath, []);

      assert.ok(
        result.allDefects.includes(3),
        `allDefects should contain 3 (the full 'Defect #3' mention must be detected), ` +
        `got: ${JSON.stringify(result.allDefects)}`
      );

      assert.ok(
        result.exemptDefects.has(3),
        `exemptDefects should contain 3 — the r2-exempt marker placed 1 line after the ` +
        `'#3' heading (without 'Defect' prefix) must exempt Defect #3 even when the first ` +
        `full 'Defect #3' mention is 4+ lines below the marker. ` +
        `Got uncoveredDefects: ${JSON.stringify(result.uncoveredDefects)}, ` +
        `exemptDefects keys: ${JSON.stringify([...result.exemptDefects.keys()])}`
      );

      assert.ok(
        !result.uncoveredDefects.includes(3),
        `Defect #3 must NOT appear in uncoveredDefects (it is r2-exempt), ` +
        `got uncoveredDefects: ${JSON.stringify(result.uncoveredDefects)}`
      );
    } finally { cleanup(root); }
  }
);

await test(
  'TC-DC-8: real CHANGELOG.md — Defect #3 must NOT appear in uncoveredDefects',
  async () => {
    // Run checkDefectCoverage against the actual CHANGELOG.md that ships with this
    // project (same file that `node scripts/audit-r2.js` processes). Defect #3 is
    // documented in the [0.1.27] section under an r2-exempt marker and must not
    // surface as an uncovered defect in any audit run.
    assert.ok(
      fs.existsSync(CHANGELOG_FILE),
      `CHANGELOG_FILE must exist at ${CHANGELOG_FILE}`
    );

    const result = checkDefectCoverage(CHANGELOG_FILE, PAIR_INVARIANTS);

    assert.ok(
      !result.uncoveredDefects.includes(3),
      `Defect #3 must NOT be in uncoveredDefects when auditing the real CHANGELOG.md. ` +
      `Got uncoveredDefects: ${JSON.stringify(result.uncoveredDefects)}. ` +
      `exemptDefects keys: ${JSON.stringify([...result.exemptDefects.keys()])}. ` +
      `coveredDefects keys: ${JSON.stringify([...result.coveredDefects.keys()])}`
    );
  }
);

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
