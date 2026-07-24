#!/usr/bin/env node
/**
 * audit-r2.js — Mechanizes ARCHITECTURE.md Rule 2 (callsite audit on convention
 * rename or addition).
 *
 * Three R2 violations (#11, #12, #13) shipped between v0.1.27 and v0.1.32 with
 * R2 enforced only by human discipline. This script catches the structural
 * shape of those bugs at audit time.
 *
 * Four phases:
 *
 *   Phase 1 — Pair invariants. Statically check that "if function A is called,
 *   function B must also be called." Coarse (file-level) for MVP. Each invariant
 *   has an optional `// R2-OK: <reason>` annotation to suppress a known-safe
 *   violation (e.g., when B is called upstream in a different file).
 *
 *   Phase 2 — Schema-required-field coverage. For each top-level schema in
 *   _schemas.js, list `required` fields and grep src/ for readers. Required
 *   fields with zero readers (outside _schemas.js) are flagged. Catches the
 *   class of bug where a schema gains a field but no consumer reads it.
 *
 *   Phase 3 — Test wiring. Every test/test-*.js file must be referenced in
 *   package.json's `test:all` chain (or annotated with `// R2-OK: not-in-test-all`
 *   in the file's first 30 lines).
 *
 *   Phase 4 — Defect coverage. Reads CHANGELOG.md and extracts all unique
 *   `Defect #N` mentions. Checks that each defect number is either covered by
 *   a PAIR_INVARIANTS description or marked exempt via `<!-- r2-exempt: reason -->`
 *   in CHANGELOG.md. In standard mode, uncovered defects emit console.warn (exit
 *   2). In --strict mode, uncovered defects emit console.error and trigger exit 1.
 *
 * Output:
 *   ARCHITECTURE-GRAPH.json (gitignored) — machine-readable manifest of
 *   writers, schemas, pair invariants, violations, and defect coverage. Designed
 *   as the seed of the future architecture-memory base (see Phase IV architect
 *   agent in ARCHITECTURE.md Rule 8).
 *
 * Exit codes:
 *   0 — clean
 *   1 — at least one pair-invariant or test-wiring violation (hard), or
 *       uncovered defects in --strict mode (hard)
 *   2 — schema-coverage warnings only (soft, advisory), or uncovered defects
 *       in standard mode (soft, advisory)
 *
 * Usage:
 *   node scripts/audit-r2.js               # writes manifest, exits non-zero on violations
 *   node scripts/audit-r2.js --warn-only   # always exits 0, manifest still written
 *   node scripts/audit-r2.js --strict      # uncovered defects become hard violations (exit 1)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const SRC_DIR = path.join(ROOT, 'src');
const SCHEMAS_FILE = path.join(SRC_DIR, 'orchestrator/agents/_schemas.js');
const OUTPUT = path.join(ROOT, 'ARCHITECTURE-GRAPH.json');

const CHANGELOG_FILE = path.join(ROOT, 'CHANGELOG.md');

const ARGS = new Set(process.argv.slice(2));
const WARN_ONLY = ARGS.has('--warn-only');
const STRICT = ARGS.has('--strict');

// ── Pair invariants ─────────────────────────────────────────────────────────
//
// Each invariant defines a trigger and a required pair. If a file matches the
// trigger but not the pair AND has no `R2-OK` annotation within 5 lines of the
// trigger match, that's a violation.

const PAIR_INVARIANTS = [
  {
    name: 'verifyTask requires writeVerifyJson',
    description:
      'Every file that calls verifier.verifyTask must also call writeVerifyJson ' +
      'in the same file (so the verify.json sidecar exists when the verifier ' +
      'reads it). If the writeVerifyJson is invoked upstream in a different ' +
      'file, annotate the call site with `// R2-OK: <reason>`. ' +
      'Also closes Defect #13: regression.js previously called verifyTask ' +
      'without writeVerifyJson, causing false-FAIL on missing verify.json.',
    triggerRegex: /verifier\.verifyTask\s*\(/,
    requiresRegex: /writeVerifyJson\s*\(/,
  },
  {
    name: 'restoreSnapshot(before) requires _captureLastFailed',
    description:
      'Every file that restores a before-snapshot on failure must first capture ' +
      'the last-failed diagnostic state via _captureLastFailed() in the same file. ' +
      'Closes Defect #2: without capturing the last-failed state before restoring ' +
      'the before-snapshot, diagnostic information about the failure is lost ' +
      'permanently when the snapshot overwrites the working directory.',
    triggerRegex: /restoreSnapshot\s*\([^)]*['"]before['"]\s*\)/,
    requiresRegex: /_captureLastFailed\s*\(/,
  },
  {
    name: 'archived-log requires archive() call',
    description:
      'Every file that logs "archived successfully" must also call archive() ' +
      'in the same file. Closes Defect #15: batchResume() and resume() in ' +
      'pipeline.js previously logged success without invoking archive(), so ' +
      'queue entries got removed but no archives/{seq}/ directory ever ' +
      'persisted to disk. The log line was a lie.',
    triggerRegex: /archived\s+successfully/,
    requiresRegex: /\bawait\s+archive\s*\(/,
  },
  {
    name: 're-dispatch log requires previousFailures',
    description:
      'Every file that logs "Re-dispatching" (the retry path in pipeline.js) ' +
      'must also reference previousFailures in the same file, so that prior ' +
      'failure context is forwarded to the re-dispatched task. Without it the ' +
      'executor receives no history of what went wrong and is likely to repeat ' +
      'the same mistake.',
    triggerRegex: /Re-dispatching/,
    requiresRegex: /previousFailures/,
  },
];

// ── File walker ─────────────────────────────────────────────────────────────

function walkJsFiles(dir, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(full, results);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

function relPath(absolute) {
  return path.relative(ROOT, absolute);
}

// ── Phase 1: pair invariants ────────────────────────────────────────────────

function checkPairInvariants(files) {
  const violations = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (const inv of PAIR_INVARIANTS) {
      // For each line that matches the trigger:
      for (let i = 0; i < lines.length; i++) {
        if (!inv.triggerRegex.test(lines[i])) continue;

        // Check if the requires regex matches anywhere in the same file:
        const hasPair = inv.requiresRegex.test(content);
        if (hasPair) continue;

        // Check for R2-OK annotation within 5 lines before/after.
        // Prefix-agnostic to mirror the test-wiring check (line ~313): accepts
        // line-comment (// R2-OK: ...) and JSDoc-style ( * R2-OK: ...).
        const start = Math.max(0, i - 5);
        const end = Math.min(lines.length - 1, i + 5);
        let annotated = false;
        for (let j = start; j <= end; j++) {
          if (/R2-OK:/i.test(lines[j])) {
            annotated = true;
            break;
          }
        }
        if (annotated) continue;

        violations.push({
          invariant: inv.name,
          file: relPath(file),
          line: i + 1,
          context: lines[i].trim(),
          remediation:
            'Add `writeVerifyJson(harnessDir, task)` before the call, OR add ' +
            '`// R2-OK: <reason>` annotation if the pair is satisfied upstream.',
        });
      }
    }
  }
  return violations;
}

// ── Phase 2: schema-required-field coverage ─────────────────────────────────
//
// Parse `_schemas.js` for top-level schema declarations. Extract their
// `required: [...]` arrays. For each required field, grep all .js files in
// src/ for readers (excluding _schemas.js itself). Field is "covered" if any
// other file mentions it as a string literal, member access, or destructure.

function extractSchemas(content) {
  const schemas = [];
  // Pattern: export const fooSchema = { ... required: [...] };
  // Most cc-orch schemas wrap their meaningful contract in items.required
  // (e.g., reviewRemediationSchema's newTasks.items.required holds the
  // load-bearing fields). So we walk the schema body and union ALL
  // `required: [...]` arrays we encounter at any depth. The union is
  // intentionally coarse — a field is "covered" if any reader anywhere
  // mentions it. For finer per-path coverage, future iterations can
  // surface depth/path metadata.
  const declRegex = /export\s+const\s+(\w*[Ss]chema)\s*=\s*\{/g;
  let match;
  while ((match = declRegex.exec(content)) !== null) {
    const name = match[1];
    const startIdx = match.index;
    const openIdx = content.indexOf('{', startIdx);
    if (openIdx === -1) continue;

    // Walk forward, tracking depth. Collect EVERY `required: [...]` we
    // encounter inside this schema literal (depths 1, 2, 3...).
    let depth = 0;
    const fieldSet = new Set();
    let end = -1;
    for (let i = openIdx; i < content.length; i++) {
      const ch = content[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      } else if (depth >= 1 && ch === 'r' &&
                 content.slice(i, i + 8) === 'required') {
        const m = /^required\s*:\s*\[([^\]]*)\]/.exec(content.slice(i));
        if (m) {
          for (const f of m[1].split(',')) {
            const cleaned = f.trim().replace(/^['"]|['"]$/g, '');
            if (cleaned) fieldSet.add(cleaned);
          }
          i += m[0].length - 1;
        }
      }
    }
    if (end === -1) continue;
    if (fieldSet.size === 0) continue;

    const beforeStart = content.slice(0, startIdx);
    const line = beforeStart.split('\n').length;

    schemas.push({ name, line, requiredFields: [...fieldSet] });
  }
  return schemas;
}

function findReaders(field, files, exclude) {
  const readers = [];
  // A field is "read" if it appears as one of:
  //   .field             (member access)
  //   ['field']          (bracket access, single-quoted)
  //   ["field"]          (bracket access, double-quoted)
  //   { field }          (destructure)
  //   { field:          (destructure with rename)
  //   field:             (object literal — possible re-emit, also counts)
  // The test is intentionally loose; the goal is "no false negatives, some
  // false positives ok." False positives surface as "field appears used,
  // verify by hand."
  const escaped = field.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const patterns = [
    new RegExp(`\\.${escaped}\\b`),
    new RegExp(`\\[\\s*['"]${escaped}['"]\\s*\\]`),
    new RegExp(`\\b${escaped}\\s*[:,}]`),
  ];
  for (const file of files) {
    if (exclude.has(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    if (patterns.some((p) => p.test(content))) {
      readers.push(relPath(file));
    }
  }
  return readers;
}

function checkSchemaCoverage(files) {
  if (!fs.existsSync(SCHEMAS_FILE)) return { schemas: [], warnings: [] };
  const content = fs.readFileSync(SCHEMAS_FILE, 'utf8');
  const schemas = extractSchemas(content);
  const exclude = new Set([SCHEMAS_FILE]);

  const result = [];
  const warnings = [];
  for (const sch of schemas) {
    const fieldCoverage = sch.requiredFields.map((field) => ({
      field,
      readers: findReaders(field, files, exclude),
    }));
    result.push({
      name: sch.name,
      file: relPath(SCHEMAS_FILE),
      line: sch.line,
      requiredFields: sch.requiredFields,
      fieldCoverage,
    });
    for (const fc of fieldCoverage) {
      if (fc.readers.length === 0) {
        warnings.push({
          schema: sch.name,
          field: fc.field,
          message:
            `Required field '${fc.field}' on schema '${sch.name}' has zero ` +
            `readers in src/ (besides _schemas.js itself). Either add a ` +
            `consumer that reads this field, mark the field as not required, ` +
            `or document the indirect read path.`,
        });
      }
    }
  }
  return { schemas: result, warnings };
}

// ── Phase 3: test wiring ────────────────────────────────────────────────────
//
// Every test/test-*.js file must be referenced in scripts/run-tests.js
// TEST_FILES (or annotated with `// R2-OK: not-in-test-all` in the file's
// first 30 lines). Surfaced 2026-04-27 after cc-orch's #12 self-host wrote
// 2 new test files but didn't auto-wire them. The R2 enforcer would catch
// that class of spec-template gap automatically.
//
// Annotation suppresses the violation when the exclusion is intentional
// (e.g., long-running integration tests run via a separate npm script).

/**
 * Parse scripts/run-tests.js and return a Set of test file basenames
 * extracted from the TEST_FILES array (string entries only; object entries
 * like `{ npm: true, args: [...] }` are ignored).
 *
 * @param {string} rootDir
 * @returns {Set<string>}
 */
function loadRegisteredBasenames(rootDir) {
  const runTestsPath = path.join(rootDir, 'scripts', 'run-tests.js');
  if (!fs.existsSync(runTestsPath)) return new Set();
  const content = fs.readFileSync(runTestsPath, 'utf8');

  // Locate the TEST_FILES array in the source text.
  const startMatch = /\bTEST_FILES\s*=\s*\[/.exec(content);
  if (!startMatch) return new Set();

  // Walk forward from the opening '[' to find the matching closing ']'.
  const arrayStart = startMatch.index + startMatch[0].length - 1;
  let depth = 0;
  let arrayEnd = -1;
  for (let i = arrayStart; i < content.length; i++) {
    if (content[i] === '[') depth++;
    else if (content[i] === ']') {
      depth--;
      if (depth === 0) { arrayEnd = i; break; }
    }
  }

  const arrayBody = arrayEnd === -1
    ? content.slice(arrayStart)
    : content.slice(arrayStart, arrayEnd + 1);

  // Extract string literals that look like test file paths (test/…js).
  // Object entries such as { npm: true, args: ['run', '…'] } are filtered
  // out because their string values don't start with 'test/' and end with
  // '.js'.
  const basenames = new Set();
  const strRegex = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = strRegex.exec(arrayBody)) !== null) {
    if (m[1].startsWith('test/') && m[1].endsWith('.js')) {
      basenames.add(path.basename(m[1]));
    }
  }
  return basenames;
}

/**
 * Check that every test/test-*.js file is registered in
 * scripts/run-tests.js TEST_FILES (or suppressed with an R2-OK annotation).
 *
 * @param {string} rootDir
 * @param {Set<string>} [registeredBasenames]  Optional pre-built set of
 *   test file basenames. When omitted the function reads and parses
 *   scripts/run-tests.js TEST_FILES to build the set automatically.
 * @returns {{ file: string, message: string, remediation: string }[]}
 */
export function checkTestWiring(rootDir, registeredBasenames) {
  const testDir = path.join(rootDir, 'test');
  if (!fs.existsSync(testDir)) return [];

  if (!registeredBasenames) {
    registeredBasenames = loadRegisteredBasenames(rootDir);
  }

  const violations = [];
  for (const entry of fs.readdirSync(testDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith('test-') || !entry.name.endsWith('.js')) continue;

    if (registeredBasenames.has(entry.name)) continue;

    // Check for `R2-OK: not-in-test-all` annotation in first 30 lines.
    // Accepts both line-comment (// R2-OK: ...) and JSDoc-style ( * R2-OK: ...).
    const filePath = path.join(testDir, entry.name);
    const head = fs.readFileSync(filePath, 'utf8').split('\n').slice(0, 30).join('\n');
    if (/R2-OK:\s*not-in-test-all/i.test(head)) continue;

    violations.push({
      file: relPath(filePath),
      message:
        `test file not referenced in scripts/run-tests.js TEST_FILES — runs only ` +
        `via standalone invocation, so failures don't gate CI/regression`,
      remediation:
        `add 'test/${entry.name}' to TEST_FILES in scripts/run-tests.js (preferred), OR add ` +
        `'// R2-OK: not-in-test-all — <reason>' as a comment in the test ` +
        `file's first 30 lines if the exclusion is intentional`,
    });
  }
  return violations;
}

// ── Phase 4: defect coverage ────────────────────────────────────────────────
//
// Reads CHANGELOG.md and extracts all unique `Defect #N` mentions. Scans each
// PAIR_INVARIANTS entry's description for `Defect #N` references to build a
// map of covered defect numbers → invariant names. Parses CHANGELOG for
// `<!-- r2-exempt: reason -->` markers near Defect mentions to build a map of
// exempt defect numbers → reasons. Returns a structured coverage report.

function checkDefectCoverage(changelogPath, pairInvariants) {
  const allDefectsSet = new Set();
  const coveredDefects = new Map();
  const exemptDefects = new Map();

  // Read and parse CHANGELOG.md
  if (fs.existsSync(changelogPath)) {
    const changelogContent = fs.readFileSync(changelogPath, 'utf8');
    const lines = changelogContent.split('\n');

    // Extract all unique Defect #N mentions
    const defectRegex = /Defect\s+#(\d+)/g;
    let m;
    while ((m = defectRegex.exec(changelogContent)) !== null) {
      allDefectsSet.add(Number(m[1]));
    }

    // Parse for <!-- r2-exempt: reason --> HTML comment markers near Defect mentions.
    // Pass A (defect-mention-first): for each line with a Defect #N mention, look
    // ±3 lines for an r2-exempt marker.
    const exemptRegex = /<!--\s*r2-exempt:\s*(.+?)\s*-->/i;
    // Section-scoped: an exempt marker exempts every Defect #N mentioned in the
    // same release section (## [version] heading to next ## heading), per spec
    // phrase "directly inside the CHANGELOG entry".
    const sectionHeadingRegex = /^##\s/;
    let sectionStart = 0;
    for (let i = 1; i <= lines.length; i++) {
      const atBoundary = i === lines.length || sectionHeadingRegex.test(lines[i]);
      if (!atBoundary) continue;
      const sectionText = lines.slice(sectionStart, i).join('\n');
      const markerMatch = sectionText.match(exemptRegex);
      if (markerMatch) {
        const reason = markerMatch[1].trim();
        const sectionDefectRegex = /Defect\s+#(\d+)/g;
        let dm;
        while ((dm = sectionDefectRegex.exec(sectionText)) !== null) {
          const defectNum = Number(dm[1]);
          if (!exemptDefects.has(defectNum)) {
            exemptDefects.set(defectNum, reason);
          }
        }
      }
      sectionStart = i;
    }
  }

  // Scan each PAIR_INVARIANTS entry's description for Defect #N references
  for (const inv of pairInvariants) {
    if (!inv.description) continue;
    const descDefectRegex = /Defect\s+#(\d+)/g;
    let dm;
    while ((dm = descDefectRegex.exec(inv.description)) !== null) {
      const defectNum = Number(dm[1]);
      coveredDefects.set(defectNum, inv.name);
    }
  }

  const allDefects = [...allDefectsSet].sort((a, b) => a - b);

  // Uncovered = in allDefects but not in coveredDefects and not in exemptDefects
  const uncoveredDefects = allDefects.filter(
    (n) => !coveredDefects.has(n) && !exemptDefects.has(n),
  );

  return { allDefects, coveredDefects, exemptDefects, uncoveredDefects };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const files = walkJsFiles(SRC_DIR);
  const pairViolations = checkPairInvariants(files);
  const { schemas, warnings: schemaWarnings } = checkSchemaCoverage(files);
  const testWiringViolations = checkTestWiring(ROOT);
  const { allDefects, coveredDefects, exemptDefects, uncoveredDefects } =
    checkDefectCoverage(CHANGELOG_FILE, PAIR_INVARIANTS);

  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceCount: files.length,
    pairInvariants: PAIR_INVARIANTS.map((inv) => ({
      name: inv.name,
      description: inv.description,
      violations: pairViolations.filter((v) => v.invariant === inv.name),
    })),
    schemas,
    schemaCoverageWarnings: schemaWarnings,
    testWiringViolations,
    defectCoverage: { allDefects, coveredDefects: mapToObject(coveredDefects), exemptDefects: mapToObject(exemptDefects), uncoveredDefects },
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(manifest, null, 2));

  console.log(`R2 audit complete. Manifest: ${relPath(OUTPUT)}`);
  console.log(`  Source files scanned: ${files.length}`);
  console.log(`  Schemas analyzed: ${schemas.length}`);
  console.log(`  Pair-invariant violations: ${pairViolations.length}`);
  console.log(`  Schema-coverage warnings: ${schemaWarnings.length}`);
  console.log(`  Test-wiring violations: ${testWiringViolations.length}`);
  console.log(`  Defect coverage: ${coveredDefects.size + exemptDefects.size}/${allDefects.length} (${uncoveredDefects.length} uncovered)`);

  if (pairViolations.length > 0) {
    console.error(`\nPair-invariant violations:`);
    for (const v of pairViolations) {
      console.error(`  ${v.file}:${v.line}  ${v.invariant}`);
      console.error(`    ${v.context}`);
      console.error(`    Remediation: ${v.remediation}`);
    }
  }
  if (schemaWarnings.length > 0) {
    console.error(`\nSchema-coverage warnings:`);
    for (const w of schemaWarnings) {
      console.error(`  ${w.schema}.${w.field}  →  ${w.message}`);
    }
  }
  if (testWiringViolations.length > 0) {
    console.error(`\nTest-wiring violations:`);
    for (const v of testWiringViolations) {
      console.error(`  ${v.file}`);
      console.error(`    ${v.message}`);
      console.error(`    Remediation: ${v.remediation}`);
    }
  }
  if (uncoveredDefects.length > 0) {
    const logFn = STRICT ? console.error : console.warn;
    logFn(`\nUncovered defects (no pair-invariant or exemption):`);
    for (const n of uncoveredDefects) {
      logFn(`  Defect #${n}  — add a PAIR_INVARIANTS entry referencing "Defect #${n}" or add <!-- r2-exempt: reason --> near it in CHANGELOG.md`);
    }
  }

  if (WARN_ONLY) process.exit(0);
  if (pairViolations.length > 0 || testWiringViolations.length > 0) process.exit(1);
  if (STRICT && uncoveredDefects.length > 0) process.exit(1);
  if (schemaWarnings.length > 0 || uncoveredDefects.length > 0) process.exit(2);
  process.exit(0);
}

// Run if invoked as main (not when imported by tests):
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

/**
 * Converts a JS Map to a plain object. Returns {} for non-Map or null input.
 * @param {Map<any,any>} map
 * @returns {Record<string,any>}
 */
export function mapToObject(map) {
  if (!(map instanceof Map)) return {};
  return Object.fromEntries(map);
}

// Exported for tests:
export { checkPairInvariants, checkSchemaCoverage, extractSchemas, walkJsFiles, PAIR_INVARIANTS, CHANGELOG_FILE, checkDefectCoverage };
// checkTestWiring is exported above at its definition.
