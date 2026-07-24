import fs from 'fs';
import path from 'path';
import { deriveSpecJsonPath } from './spec-paths.js';
import { isWholeSuiteCommand } from '../agents/planner.js';

/**
 * Read target files from a spec.
 *
 * Contract (json-first / md-fallback / fail-soft):
 *   1. Derive the spec JSON path via deriveSpecJsonPath.
 *   2. If the JSON file exists, parse it and return `target_files` if it is a
 *      non-empty array.
 *   3. On any JSON error or if target_files is absent/empty, fall back to
 *      reading prdPath as markdown (resolved against projectRoot when relative),
 *      extracting backtick-wrapped paths via /`([^`]+\.[a-zA-Z][^`]*)`/g, and
 *      deduplicating with Set.
 *   4. Return [] on any failure.
 *
 * @param {string} prdPath    - path to the spec/PRD file (.md or absolute)
 * @param {string} projectRoot - absolute path to the project root
 * @returns {string[]} deduplicated list of target file paths
 */
export function readSpecTargetFiles(prdPath, projectRoot) {
  // w4-batch-failure-input-boundary Fix #4: restore the pre-extraction
  // `if (prdPath)` guard the f9e4507 "pure move" dropped. With a falsy prdPath
  // (reachable — bootstrap defaults prdPath=''), deriveSpecJsonPath falls back to
  // <projectRoot>/spec.json and would inject an unrelated root spec.json. The old
  // in-pipeline reader returned empty in this state; restore that exactly.
  if (!prdPath) return [];
  try {
    // Step 1: try spec JSON
    const specJsonPath = deriveSpecJsonPath(prdPath, projectRoot);
    if (fs.existsSync(specJsonPath)) {
      try {
        const specJson = JSON.parse(fs.readFileSync(specJsonPath, 'utf8'));
        if (Array.isArray(specJson.target_files) && specJson.target_files.length > 0) {
          return specJson.target_files;
        }
      } catch {
        // Fall through to markdown extraction
      }
    }

    // Step 2: fall back to markdown extraction
    if (prdPath) {
      const absolutePrdPath = path.isAbsolute(prdPath)
        ? prdPath
        : path.join(projectRoot, prdPath);
      if (fs.existsSync(absolutePrdPath)) {
        try {
          const content = fs.readFileSync(absolutePrdPath, 'utf8');
          const lines = content.split('\n');
          const headerIdx = lines.findIndex((l) => l === '## Declared target files' || l.startsWith('## Declared target files'));
          if (headerIdx === -1) return [];
          const afterHeader = lines.slice(headerIdx + 1);
          const nextHeaderIdx = afterHeader.findIndex((l) => /^##\s/.test(l));
          const sectionLines = nextHeaderIdx === -1 ? afterHeader : afterHeader.slice(0, nextHeaderIdx);
          const section = sectionLines.join('\n');
          const matches = section.match(/`([^`]+\.[a-zA-Z][^`]*)`/g) || [];
          const files = matches
            .map((m) => m.slice(1, -1).trim())
            .filter((f) => f.includes('/') || f.includes('.'));
          return [...new Set(files)];
        } catch {
          // Fall through
        }
      }
    }
  } catch {
    // Fall through
  }
  return [];
}

/**
 * Read constraints from a spec JSON file.
 *
 * Contract (json-only / fail-soft):
 *   1. Derive the spec JSON path via deriveSpecJsonPath.
 *   2. If the JSON file exists, parse it and return `constraints` if it is a
 *      non-empty array.
 *   3. Return [] on any failure or if constraints is absent/empty.
 *
 * @param {string} prdPath     - path to the spec/PRD file (.md or absolute)
 * @param {string} projectRoot - absolute path to the project root
 * @returns {string[]} list of constraint strings
 */
export function readSpecConstraints(prdPath, projectRoot) {
  // w4-batch-failure-input-boundary Fix #4: falsy prdPath → empty default,
  // never deriving the <projectRoot>/spec.json fallback (pre-extraction contract).
  if (!prdPath) return [];
  try {
    const specJsonPath = deriveSpecJsonPath(prdPath, projectRoot);
    if (fs.existsSync(specJsonPath)) {
      try {
        const specJson = JSON.parse(fs.readFileSync(specJsonPath, 'utf8'));
        if (Array.isArray(specJson.constraints) && specJson.constraints.length > 0) {
          return specJson.constraints;
        }
      } catch {
        // Fall through
      }
    }
  } catch {
    // Fall through
  }
  return [];
}

/**
 * Read acceptance criteria from a spec JSON file.
 *
 * Contract (json-only / fail-soft):
 *   1. Derive the spec JSON path via deriveSpecJsonPath.
 *   2. If the JSON file exists, parse it and return `acceptance_criteria` if it
 *      is a non-empty array.
 *   3. Return [] on any failure or if acceptance_criteria is absent/empty.
 *
 * @param {string} prdPath     - path to the spec/PRD file (.md or absolute)
 * @param {string} projectRoot - absolute path to the project root
 * @returns {string[]} list of acceptance criteria strings
 */
export function readSpecAcceptanceCriteria(prdPath, projectRoot) {
  // w4-batch-failure-input-boundary Fix #4: falsy prdPath → empty default,
  // never deriving the <projectRoot>/spec.json fallback (pre-extraction contract).
  if (!prdPath) return [];
  try {
    const specJsonPath = deriveSpecJsonPath(prdPath, projectRoot);
    if (fs.existsSync(specJsonPath)) {
      try {
        const specJson = JSON.parse(fs.readFileSync(specJsonPath, 'utf8'));
        if (Array.isArray(specJson.acceptance_criteria) && specJson.acceptance_criteria.length > 0) {
          return specJson.acceptance_criteria;
        }
      } catch {
        // Fall through
      }
    }
  } catch {
    // Fall through
  }
  return [];
}

/**
 * Read the goal string from a spec JSON file.
 *
 * Contract (json-only / fail-soft):
 *   1. Derive the spec JSON path via deriveSpecJsonPath.
 *   2. If the JSON file exists, parse it and return `goal` if it is a string.
 *   3. Return '' on any failure or if goal is absent/not a string.
 *
 * @param {string} prdPath     - path to the spec/PRD file (.md or absolute)
 * @param {string} projectRoot - absolute path to the project root
 * @returns {string} the goal string, or '' if unavailable
 */
export function readSpecGoal(prdPath, projectRoot) {
  // w4-batch-failure-input-boundary Fix #4: falsy prdPath → empty default,
  // never deriving the <projectRoot>/spec.json fallback (pre-extraction contract).
  if (!prdPath) return '';
  try {
    const specJsonPath = deriveSpecJsonPath(prdPath, projectRoot);
    if (fs.existsSync(specJsonPath)) {
      try {
        const specJson = JSON.parse(fs.readFileSync(specJsonPath, 'utf8'));
        if (typeof specJson.goal === 'string') {
          return specJson.goal;
        }
      } catch {
        // Fall through
      }
    }
  } catch {
    // Fall through
  }
  return '';
}

/**
 * Read the plan_structure section from a spec JSON file.
 *
 * Contract (json-only / fail-soft):
 *   1. Derive the spec JSON path via deriveSpecJsonPath.
 *   2. If the JSON file exists, parse it and return `plan_structure` if present.
 *   3. Return {} on any failure or if plan_structure is absent.
 *
 * @param {string} prdPath     - path to the spec/PRD file (.md or absolute)
 * @param {string} projectRoot - absolute path to the project root
 * @returns {object} the plan_structure section, or {} if unavailable
 */
export function readSpecPlanStructure(prdPath, projectRoot) {
  if (!prdPath) return {};
  try {
    const specJsonPath = deriveSpecJsonPath(prdPath, projectRoot);
    if (fs.existsSync(specJsonPath)) {
      try {
        const specJson = JSON.parse(fs.readFileSync(specJsonPath, 'utf8'));
        if (specJson.plan_structure !== undefined) {
          return specJson.plan_structure;
        }
      } catch {
        // Fall through
      }
    }
  } catch {
    // Fall through
  }
  return {};
}

/**
 * Build the verifier spec context for a given task.
 *
 * Computes the subset of acceptance criteria relevant to a specific task by:
 *   1. Reading the verify sidecar at harnessDir/verify/task-{task.id}.json for
 *      its hardChecks (disk SoT — scheduler-rehydrated tasks carry no in-memory
 *      hardChecks).
 *   2. Unioning sidecar hardChecks with task.hardChecks (in-memory fallback).
 *   3. Filtering criteria to only those whose verification.command matches one
 *      of the unioned hardCheck commands.
 *
 * Fail-soft: a missing or corrupt sidecar falls back to in-memory task.hardChecks
 * only.
 *
 * Whole-suite test commands (the configured testCommand / testAllCommand, per
 * `isWholeSuiteCommand`) are excluded from relevantCriteria: they are run once
 * by the final integration / regression gates after the whole run completes, so
 * injecting them as per-task criteria would make the verifier self-run them and
 * fail early tasks whose sibling missions have not executed yet.
 *
 * @param {string}   harnessDir - path to the .harness directory
 * @param {object}   task       - the task being verified (may carry hardChecks[])
 * @param {object[]} criteria   - acceptance_criteria array from the spec
 * @param {object}   [config]   - orchestrator config (for whole-suite command recognition)
 * @returns {{ relevantCriteria: object[] }}
 */
export function buildVerifierSpecContext(harnessDir, task, criteria, config) {
  let sidecarChecks = [];
  try {
    const sidecarPath = path.join(harnessDir, 'verify', `task-${task.id}.json`);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    if (Array.isArray(sidecar.hardChecks)) sidecarChecks = sidecar.hardChecks;
  } catch {
    // Missing or corrupt sidecar — fall back to in-memory task.hardChecks only
  }
  const taskHardCheckCommands = new Set(
    [...(task.hardChecks || []), ...sidecarChecks]
      .map((h) => h && h.command)
      .filter((c) => typeof c === 'string'),
  );
  // NOTE: this whole-suite exclusion is a non-load-bearing token optimization —
  // it keeps the verifier prompt from inviting the AI to self-run the full
  // suite. Real enforcement of "a whole-suite FAIL must not fail a per-task
  // verdict" lives in the verdict override (extractVerdict in
  // agents/verifier.js) plus the final test gate (runFinalTestGate); this only
  // trims the input prompt.
  const relevantCriteria = (criteria || []).filter(
    (c) =>
      c.verification &&
      taskHardCheckCommands.has(c.verification.command) &&
      !isWholeSuiteCommand(c.verification.command, config),
  );
  return { relevantCriteria };
}
