/**
 * test-registration.js — Gate: verify every test/test-*.js file is registered
 * in scripts/run-tests.js (TEST_FILES) or carries an explicit opt-out annotation.
 *
 * Public API:
 *   checkTestRegistration(candidateFiles, harnessDir, projectRoot)
 *     → { passed: boolean, violations: string[] }
 *
 * Logic:
 *   1. Filter candidateFiles to basenames matching test/test-*.js
 *   2. Import TEST_FILES from scripts/run-tests.js, filtering out non-string entries
 *   3. For each candidate not found in TEST_FILES, read its first 30 lines and
 *      check for 'R2-OK: not-in-test-all' annotation — if found, skip it
 *   4. Return { passed, violations } where violations lists unregistered files
 *      without the annotation and passed === violations.length === 0
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { normalizeTargetFile } from '../core/path-utils.js';

/**
 * @param {string[]} candidateFiles - Absolute or relative file paths to check
 * @param {string} harnessDir - Path to harness directory (unused, kept for API consistency)
 * @param {string} projectRoot - Root of the project (used to resolve scripts/run-tests.js)
 * @returns {{ passed: boolean, violations: string[] }}
 */
export async function checkTestRegistration(candidateFiles, harnessDir, projectRoot) {
  // 1. Filter candidateFiles to those matching test/test-*.js basenames
  const testFilePattern = /^test-[^/\\]+\.js$/;
  const candidates = candidateFiles.filter(f => {
    const base = path.basename(f);
    // Must be in a "test" directory segment and match test-*.js
    const normalised = f.replace(/\\/g, '/');
    return testFilePattern.test(base) && normalised.includes('test/');
  });

  // 2. Import TEST_FILES from scripts/run-tests.js, filtering out non-string entries
  //
  // NOT APPLICABLE when the manifest does not exist: the TEST_FILES manifest
  // is cc-orch's own registration convention, not a universal one. An external
  // project without scripts/run-tests.js does not use this mechanism, so every
  // test/test-*.js it writes would otherwise be a deterministic false-RED
  // (verifier PASS overridden to failed on every retry, straight into the
  // circuit breaker — observed live on a fixture project). Absence of the
  // manifest means the gate has nothing to enforce; a manifest that EXISTS but
  // fails to import stays fail-closed below (a cc-orch-convention project with
  // a broken manifest should not silently pass).
  const runTestsPath = path.join(projectRoot, 'scripts', 'run-tests.js');
  if (!fs.existsSync(runTestsPath)) {
    return { passed: true, violations: [], notApplicable: true };
  }

  let registeredFiles = [];
  try {
    // Cache-busting dynamic import: the ESM loader caches modules by URL, so
    // within one pipeline process every gate call after the first would receive a
    // STALE TEST_FILES — hiding registrations appended by later tasks in the same
    // run and failing every test-creating task except the first (circuit-breaker
    // loop). The ?t= query forces a fresh evaluation each call. run-tests.js is
    // side-effect-free to import (its execution is guarded behind an isMain check).
    const mod = await import(`${pathToFileURL(runTestsPath).href}?t=${Date.now()}`);
    const raw = mod.TEST_FILES ?? [];
    registeredFiles = raw.filter(entry => typeof entry === 'string');
  } catch (err) {
    // If we cannot load TEST_FILES, treat all candidates as unregistered
    registeredFiles = [];
  }

  // Normalise registered paths to the harness-wide absolute canonical form
  // (normalizeTargetFile = path.resolve against projectRoot) so the comparison
  // is independent of how each path was spelled (relative / absolute / nested).
  const registeredSet = new Set(registeredFiles.map(f => normalizeTargetFile(projectRoot, f)));

  const violations = [];

  for (const candidateFile of candidates) {
    // Resolve the candidate to the same absolute canonical form as the
    // registered set, so the comparison is spelling-independent: a relative,
    // an absolute, or a nested-directory path all normalise to one key.
    // (Was: slice at the first 'test/test-' occurrence — that truncated the
    // directory prefix, so any test outside top-level test/ could never match
    // its full-path TEST_FILES entry even when correctly registered. See A1.)
    const absPath = normalizeTargetFile(projectRoot, candidateFile);

    if (registeredSet.has(absPath)) {
      // Already registered — no violation
      continue;
    }

    // 3. Not registered — check for opt-out annotation in first 30 lines
    let hasAnnotation = false;
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      const lines = content.split('\n').slice(0, 30);
      hasAnnotation = lines.some(line => /R2-OK:\s*not-in-test-all/i.test(line));
    } catch (_) {
      // Cannot read the file — treat as no annotation
      hasAnnotation = false;
    }

    if (!hasAnnotation) {
      // Report the project-relative path for readability; comparison above uses
      // the absolute canonical, this is just the human-facing violation label.
      violations.push(path.relative(projectRoot, absPath));
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}
