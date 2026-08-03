/**
 * project-config.js — Optional per-project override loader for nightfoundry.
 *
 * Pure JS. Reads an optional `<projectRoot>/.cc-orch.json` file and, when
 * present, applies a narrow set of overrides onto the config singleton
 * exported by ./config.js. This is the cheapest step toward running
 * cc-orch against a real external project whose test commands aren't
 * named `npm test` / `npm run test:all` (see execution.testCommand /
 * execution.testAllCommand docs in config.js).
 *
 * Behavior:
 *   - Absent file: silent no-op. config.execution.testCommand,
 *     testAllCommand, and config.budgets.runCeilingUsd are left
 *     byte-identical to their current values.
 *   - Present file: parsed as JSON and validated against the recognised
 *     shape { execution: { testCommand?, testAllCommand? },
 *     budgets: { runCeilingUsd? } }. Only config.execution.testCommand,
 *     config.execution.testAllCommand, and config.budgets.runCeilingUsd
 *     are ever mutated; an omitted key (or an omitted section) keeps its
 *     current value. A runCeilingUsd of literal null disables the run
 *     spend gate; any other accepted value must be a positive finite
 *     number.
 *   - Fail-loud: any unparseable JSON, unknown key (top-level or nested),
 *     non-string command value, empty-string command value, or invalid
 *     runCeilingUsd value (anything other than a positive finite number
 *     or literal null) throws an Error naming both the file path and the
 *     offending key. The entire recognised shape — execution AND
 *     budgets — is validated BEFORE any field is mutated — there is no
 *     partial-apply and no silent skip.
 *   - Idempotent: calling loadProjectConfig(projectRoot) twice with the
 *     same projectRoot re-reads the same file and re-applies the same
 *     values, producing the same result with no additional side effect.
 *
 * This module imports the config singleton from ./config.js and mutates
 * only the three runtime fields described above; it does not restructure
 * or otherwise modify config.js.
 *
 * Public API:
 *   loadProjectConfig(projectRoot): void
 */
import fs from 'fs';
import path from 'path';
import config from './config.js';

const TOP_LEVEL_KEYS = new Set(['execution', 'budgets']);
const EXECUTION_KEYS = new Set(['testCommand', 'testAllCommand']);
const BUDGETS_KEYS = new Set(['runCeilingUsd']);

/**
 * Load and apply the optional per-project override file, if present.
 * @param {string} projectRoot
 * @returns {void}
 */
export function loadProjectConfig(projectRoot) {
  const filePath = path.join(projectRoot, '.cc-orch.json');

  if (!fs.existsSync(filePath)) {
    return;
  }

  const raw = fs.readFileSync(filePath, 'utf8');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${filePath}: could not parse file`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Invalid config in ${filePath}: top-level value must be an object`
    );
  }

  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new Error(`Unknown key "${key}" in ${filePath}`);
    }
  }

  /** @type {{ testCommand?: string, testAllCommand?: string, runCeilingUsd?: number | null }} */
  const validated = {};

  if (Object.prototype.hasOwnProperty.call(parsed, 'execution')) {
    const execution = parsed.execution;

    if (
      execution === null ||
      typeof execution !== 'object' ||
      Array.isArray(execution)
    ) {
      throw new Error(
        `Invalid config in ${filePath}: "execution" must be an object`
      );
    }

    for (const key of Object.keys(execution)) {
      if (!EXECUTION_KEYS.has(key)) {
        throw new Error(`Unknown key "execution.${key}" in ${filePath}`);
      }
    }

    for (const key of EXECUTION_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(execution, key)) {
        continue;
      }
      const value = execution[key];
      if (typeof value !== 'string') {
        throw new Error(
          `Invalid value for "execution.${key}" in ${filePath}: must be a non-empty string`
        );
      }
      if (value === '') {
        throw new Error(
          `Invalid value for "execution.${key}" in ${filePath}: must be a non-empty string`
        );
      }
      validated[key] = value;
    }
  }

  if (Object.prototype.hasOwnProperty.call(parsed, 'budgets')) {
    const budgets = parsed.budgets;

    if (
      budgets === null ||
      typeof budgets !== 'object' ||
      Array.isArray(budgets)
    ) {
      throw new Error(
        `Invalid config in ${filePath}: "budgets" must be an object`
      );
    }

    for (const key of Object.keys(budgets)) {
      if (!BUDGETS_KEYS.has(key)) {
        throw new Error(`Unknown key "budgets.${key}" in ${filePath}`);
      }
    }

    if (Object.prototype.hasOwnProperty.call(budgets, 'runCeilingUsd')) {
      const value = budgets.runCeilingUsd;
      const isValidNumber =
        typeof value === 'number' && Number.isFinite(value) && value > 0;
      if (value !== null && !isValidNumber) {
        throw new Error(
          `Invalid value for "budgets.runCeilingUsd" in ${filePath}: must be a positive finite number or null`
        );
      }
      validated.runCeilingUsd = value;
    }
  }

  // Entire recognised shape has been validated — apply now. Only these
  // three fields are ever mutated on the config singleton.
  if (Object.prototype.hasOwnProperty.call(validated, 'testCommand')) {
    config.execution.testCommand = validated.testCommand;
  }
  if (Object.prototype.hasOwnProperty.call(validated, 'testAllCommand')) {
    config.execution.testAllCommand = validated.testAllCommand;
  }
  if (Object.prototype.hasOwnProperty.call(validated, 'runCeilingUsd')) {
    config.budgets.runCeilingUsd = validated.runCeilingUsd;
  }
}
