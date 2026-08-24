/**
 * project-config.js — Optional per-project override loader for nightfoundry.
 *
 * Pure JS. Dual-reads an optional per-project override file and, when
 * present, applies a narrow set of overrides onto the config singleton
 * exported by ./config.js. This is the cheapest step toward running
 * cc-orch against a real external project whose test commands aren't
 * named `npm test` / `npm run test:all` (see execution.testCommand /
 * execution.testAllCommand docs in config.js).
 *
 * File resolution (dual-read):
 *   - `<projectRoot>/.nightfoundry.json` is preferred. When present, it is
 *     the file that is read, parsed, validated, and applied.
 *   - When `.nightfoundry.json` is absent but `<projectRoot>/.cc-orch.json`
 *     exists, that legacy file is read, parsed, validated, and applied
 *     with results identical to before this file was introduced.
 *   - When BOTH files exist, `.nightfoundry.json` wins: it is the file
 *     read, parsed, validated, and applied, and a single non-fatal
 *     warning is emitted via console.warn naming the shadowed
 *     `<projectRoot>/.cc-orch.json` path. loadProjectConfig still returns
 *     normally in this case.
 *   - When NEITHER file exists, loadProjectConfig is a silent no-op and
 *     emits no warning.
 *   - Every thrown Error names the absolute path of whichever file was
 *     actually read/resolved above — a malformed `.nightfoundry.json`
 *     never falls back to `.cc-orch.json`.
 *
 * Behavior:
 *   - Absent file(s): silent no-op. config.execution.testCommand,
 *     testAllCommand, config.budgets.runCeilingUsd, and
 *     config.scope.coupledFiles are left byte-identical to their current
 *     values.
 *   - Present file: parsed as JSON and validated against the recognised
 *     shape { execution: { testCommand?, testAllCommand? },
 *     budgets: { runCeilingUsd? },
 *     scope: { coupledFiles?: Array<{ when, alsoTarget }> } }. Only
 *     config.execution.testCommand, config.execution.testAllCommand,
 *     config.budgets.runCeilingUsd, and config.scope.coupledFiles are ever
 *     mutated; an omitted key (or an omitted section) keeps its current
 *     value. A runCeilingUsd of literal null disables the run spend gate;
 *     any other accepted value must be a positive finite number. Each
 *     coupledFiles rule must be a plain object with exactly a `when`
 *     (non-empty string) and an `alsoTarget` (non-empty array of
 *     non-empty strings).
 *   - Fail-loud: any unparseable JSON, unknown key (top-level or nested),
 *     non-string command value, empty-string command value, invalid
 *     runCeilingUsd value (anything other than a positive finite number
 *     or literal null), or invalid coupledFiles rule shape (non-array
 *     coupledFiles, a non-object rule element, an unknown key inside a
 *     rule, a missing/empty/non-string `when`, or a missing/non-array/
 *     empty/non-string-entry `alsoTarget`) throws an Error naming both
 *     the file path and the offending key. The entire recognised shape —
 *     execution AND budgets AND scope — is validated BEFORE any field is
 *     mutated — there is no partial-apply and no silent skip.
 *   - Idempotent: calling loadProjectConfig(projectRoot) twice with the
 *     same projectRoot re-reads the same file and re-applies the same
 *     values, producing the same result with no additional side effect.
 *
 * This module imports the config singleton from ./config.js and mutates
 * only the runtime fields described above; it does not restructure or
 * otherwise modify config.js.
 *
 * Public API:
 *   loadProjectConfig(projectRoot): void
 */
import fs from 'fs';
import path from 'path';
import config from './config.js';

const TOP_LEVEL_KEYS = new Set(['execution', 'budgets', 'scope', 'architect']);
const EXECUTION_KEYS = new Set(['testCommand', 'testAllCommand']);
const BUDGETS_KEYS = new Set(['runCeilingUsd']);
const SCOPE_KEYS = new Set(['coupledFiles']);
const COUPLED_FILE_RULE_KEYS = new Set(['when', 'alsoTarget']);
const ARCHITECT_KEYS = new Set(['bundleMaxBytes']);

/**
 * Returns true when value is a plain object (not null, not an array).
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Load and apply the optional per-project override file, if present.
 * @param {string} projectRoot
 * @returns {void}
 */
export function loadProjectConfig(projectRoot) {
  const nightfoundryPath = path.join(projectRoot, '.nightfoundry.json');
  const legacyPath = path.join(projectRoot, '.cc-orch.json');

  const nightfoundryExists = fs.existsSync(nightfoundryPath);
  const legacyExists = fs.existsSync(legacyPath);

  if (!nightfoundryExists && !legacyExists) {
    return;
  }

  const filePath = nightfoundryExists ? nightfoundryPath : legacyPath;

  if (nightfoundryExists && legacyExists) {
    console.warn(
      `Both .nightfoundry.json and ${legacyPath} were found; ${legacyPath} is shadowed and will be ignored in favor of ${nightfoundryPath}`
    );
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

  /** @type {{ testCommand?: string, testAllCommand?: string, runCeilingUsd?: number | null, coupledFiles?: Array<{ when: string, alsoTarget: string[] }> }} */
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

  if (Object.prototype.hasOwnProperty.call(parsed, 'scope')) {
    const scope = parsed.scope;

    if (!isPlainObject(scope)) {
      throw new Error(
        `Invalid config in ${filePath}: "scope" must be an object`
      );
    }

    for (const key of Object.keys(scope)) {
      if (!SCOPE_KEYS.has(key)) {
        throw new Error(`Unknown key "scope.${key}" in ${filePath}`);
      }
    }

    if (Object.prototype.hasOwnProperty.call(scope, 'coupledFiles')) {
      const coupledFiles = scope.coupledFiles;

      if (!Array.isArray(coupledFiles)) {
        throw new Error(
          `Invalid config in ${filePath}: "scope.coupledFiles" must be an array`
        );
      }

      const validatedRules = [];

      coupledFiles.forEach((rule, index) => {
        if (!isPlainObject(rule)) {
          throw new Error(
            `Invalid config in ${filePath}: "scope.coupledFiles[${index}]" must be an object`
          );
        }

        for (const key of Object.keys(rule)) {
          if (!COUPLED_FILE_RULE_KEYS.has(key)) {
            throw new Error(
              `Unknown key "scope.coupledFiles[${index}].${key}" in ${filePath}`
            );
          }
        }

        const when = rule.when;
        if (typeof when !== 'string' || when === '') {
          throw new Error(
            `Invalid value for "scope.coupledFiles[${index}].when" in ${filePath}: must be a non-empty string`
          );
        }

        const alsoTarget = rule.alsoTarget;
        if (!Array.isArray(alsoTarget) || alsoTarget.length === 0) {
          throw new Error(
            `Invalid value for "scope.coupledFiles[${index}].alsoTarget" in ${filePath}: must be a non-empty array`
          );
        }

        alsoTarget.forEach((entry, entryIndex) => {
          if (typeof entry !== 'string' || entry === '') {
            throw new Error(
              `Invalid value for "scope.coupledFiles[${index}].alsoTarget[${entryIndex}]" in ${filePath}: must be a non-empty string`
            );
          }
        });

        validatedRules.push({ when, alsoTarget });
      });

      validated.coupledFiles = validatedRules;
    }
  }

  if (Object.prototype.hasOwnProperty.call(parsed, 'architect')) {
    const architect = parsed.architect;

    if (!isPlainObject(architect)) {
      throw new Error(
        `Invalid config in ${filePath}: "architect" must be an object`
      );
    }

    for (const key of Object.keys(architect)) {
      if (!ARCHITECT_KEYS.has(key)) {
        throw new Error(`Unknown key "architect.${key}" in ${filePath}`);
      }
    }

    if (Object.prototype.hasOwnProperty.call(architect, 'bundleMaxBytes')) {
      const value = architect.bundleMaxBytes;
      const isValidNumber =
        typeof value === 'number' && Number.isFinite(value) && value > 0;
      if (!isValidNumber) {
        throw new Error(
          `Invalid value for "architect.bundleMaxBytes" in ${filePath}: must be a positive finite number`
        );
      }
      validated.bundleMaxBytes = value;
    }
  }

  // Entire recognised shape has been validated — apply now. Only these
  // fields are ever mutated on the config singleton.
  if (Object.prototype.hasOwnProperty.call(validated, 'testCommand')) {
    config.execution.testCommand = validated.testCommand;
  }
  if (Object.prototype.hasOwnProperty.call(validated, 'testAllCommand')) {
    config.execution.testAllCommand = validated.testAllCommand;
  }
  if (Object.prototype.hasOwnProperty.call(validated, 'runCeilingUsd')) {
    config.budgets.runCeilingUsd = validated.runCeilingUsd;
  }
  if (Object.prototype.hasOwnProperty.call(validated, 'coupledFiles')) {
    config.scope.coupledFiles = validated.coupledFiles;
  }
  if (Object.prototype.hasOwnProperty.call(validated, 'bundleMaxBytes')) {
    config.architect.bundleMaxBytes = validated.bundleMaxBytes;
  }
}
