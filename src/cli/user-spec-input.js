/**
 * cli/user-spec-input.js — Loading/validation helpers for the `.uspec.json`
 * CLI entry point (structured user-spec input, as an alternative to
 * hand-written markdown/spec.json).
 *
 * Exports:
 *   isUserSpecInvocation(specPath, flags) → boolean
 *   loadUserSpec({ specPath, flags, readStdin }) → Promise<object>
 *   validateUserSpecFailClosed(userSpec) → object (throws on invalid)
 *   warnOnEngineSpecJson(mdPath, projectRoot, { warn }) → void (never throws)
 *   renderProjectionPreview(projection) → string
 *   resolveUserSpecSlug(projectRoot, goal) → string
 *   writeUserSpecBundle(projectRoot, slug, { specJson, specMd }) → { mdPath, jsonPath }
 *   prepareUserSpecInput({ projectRoot, specPath, flags, readStdin, log, warn }) → Promise<string>
 */
import fs from 'fs';
import path from 'path';
import { validateStructured, userSpecSchema, brainstormSpecSchema } from '../orchestrator/agents/_schemas.js';
import { deriveSpecJsonPath } from '../orchestrator/core/spec-paths.js';
import { projectUserSpec } from '../orchestrator/core/user-spec.js';
import { generateSlug } from './commands/brainstorm.js';

/**
 * Determine whether the current invocation is a user-spec (.uspec.json)
 * invocation, either via a `.uspec.json` positional path or the
 * `--spec-stdin` flag.
 *
 * @param {string|undefined} specPath
 * @param {object} flags
 * @returns {boolean}
 */
export function isUserSpecInvocation(specPath, flags) {
  const f = flags || {};
  if (f['spec-stdin']) return true;
  return typeof specPath === 'string' && specPath.endsWith('.uspec.json');
}

/**
 * Load and parse a user spec, either from a `.uspec.json` file on disk or
 * from stdin (when `--spec-stdin` is passed). Enforces mutual exclusion
 * between the two input modes, and requires `--auto`/`-a` when reading
 * from stdin (since an interactive prompt cannot coexist with a stdin
 * pipe).
 *
 * @param {{specPath?: string, flags?: object, readStdin: () => Promise<string>}} opts
 * @returns {Promise<object>} the parsed userSpec object
 */
export async function loadUserSpec({ specPath, flags, readStdin }) {
  const f = flags || {};
  const isUspecPositional = typeof specPath === 'string' && specPath.endsWith('.uspec.json');
  const isStdin = !!f['spec-stdin'];

  if (isUspecPositional && isStdin) {
    throw new Error(
      `Cannot use both a .uspec.json file ("${specPath}") and --spec-stdin: these are mutually exclusive input modes. Pass either a .uspec.json positional argument OR --spec-stdin, not both.`
    );
  }

  if (isStdin) {
    const autoMode = !!(f.auto || f.a);
    if (!autoMode) {
      throw new Error(
        'Cannot use --spec-stdin without --auto (or -a): reading a spec from stdin requires unattended (auto) mode, since interactive prompts cannot coexist with a stdin pipe. Re-run with --auto.'
      );
    }
    const raw = await readStdin();
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse JSON from stdin (--spec-stdin): ${err.message}`);
    }
  }

  const raw = fs.readFileSync(specPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON from "${specPath}": ${err.message}`);
  }
}

/**
 * Validate a parsed userSpec against userSpecSchema, fail-closed: any
 * invalid field throws with a readable, per-field message list attached
 * as `.errors`. Never falls back silently.
 *
 * @param {object} userSpec
 * @returns {object} the userSpec, unchanged, on success
 */
export function validateUserSpecFailClosed(userSpec) {
  const { ok, errors } = validateStructured(userSpec, userSpecSchema);
  if (!ok) {
    const err = new Error(`Invalid user spec: ${errors.join('; ')}`);
    err.errors = errors;
    throw err;
  }
  return userSpec;
}

/**
 * CLI-only warn-only rider: if a hand-written sibling spec.json exists
 * next to `mdPath`, validate it against the engine spec schema
 * (brainstormSpecSchema — hand-written spec.json files are engine specs,
 * not user-input specs) and emit a warning for each issue found. Never
 * throws — this is purely advisory and must not add a new engine-level
 * throw path. A missing or valid spec.json produces no warning.
 *
 * @param {string} mdPath - path to the spec/PRD markdown file
 * @param {string} projectRoot - absolute path to the project root
 * @param {{warn: (msg: string) => void}} opts
 * @returns {void}
 */
export function warnOnEngineSpecJson(mdPath, projectRoot, { warn }) {
  try {
    const specJsonPath = deriveSpecJsonPath(mdPath, projectRoot);
    if (!fs.existsSync(specJsonPath)) return;
    let specJson;
    try {
      specJson = JSON.parse(fs.readFileSync(specJsonPath, 'utf8'));
    } catch {
      // Not JSON, or unreadable — nothing to validate; fail-soft.
      return;
    }
    const { ok, errors } = validateStructured(specJson, brainstormSpecSchema);
    if (!ok) {
      for (const issue of errors) {
        warn(`hand-written spec.json may be malformed (${specJsonPath}): ${issue}`);
      }
    }
  } catch {
    // Never throw — this rider is warn-only.
  }
}

/**
 * Format a single acceptance-criterion verification object's "what
 * executes/checks" column: the command for kind 'command', the targetFile
 * for kind 'file-check', or the manualSteps for kind 'manual'.
 *
 * @param {object|null|undefined} v
 * @returns {string}
 */
function formatVerificationDetail(v) {
  if (!v || typeof v !== 'object' || !v.kind) return '(no verification)';
  if (v.kind === 'command') return v.command ?? '(no command)';
  if (v.kind === 'file-check') return v.targetFile ?? '(no targetFile)';
  if (v.kind === 'manual') return v.manualSteps ?? '(no steps)';
  return '(unknown verification kind)';
}

/**
 * Render a printable preview table for a user-spec projection: one row per
 * acceptance criterion showing its description, its classified verification
 * kind, and what will execute/check (the command for kind 'command', the
 * targetFile for 'file-check', or the manualSteps for 'manual'). Any
 * `projection.warnings` are appended as trailing lines.
 *
 * Pure function (no I/O).
 *
 * @param {{ specJson: object, specMd?: string, warnings?: string[] }} projection
 *   The { specJson, specMd, warnings } object returned by projectUserSpec.
 * @returns {string}
 */
export function renderProjectionPreview(projection) {
  const p = projection && typeof projection === 'object' ? projection : {};
  const specJson = p.specJson && typeof p.specJson === 'object' ? p.specJson : {};
  const criteria = Array.isArray(specJson.acceptance_criteria) ? specJson.acceptance_criteria : [];
  const warnings = Array.isArray(p.warnings) ? p.warnings : [];

  const lines = [];
  lines.push('=== Projection Preview ===');
  lines.push('');
  lines.push('Description | Verification Kind | What executes/checks');
  lines.push('----------- | ------------------ | ---------------------');

  if (criteria.length === 0) {
    lines.push('(no acceptance criteria)');
  } else {
    for (const c of criteria) {
      const description = c?.description ?? '(no description)';
      const kind = c?.verification?.kind ?? '(no verification)';
      const detail = formatVerificationDetail(c?.verification);
      lines.push(`${description} | ${kind} | ${detail}`);
    }
  }

  if (warnings.length > 0) {
    lines.push('');
    for (const w of warnings) {
      lines.push(`Warning: ${w}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Resolve a filesystem-safe slug for a user-authored spec, resolving
 * collisions against sibling `<slug>.spec.md` / `<slug>.spec.json` files at
 * `projectRoot`.
 *
 * base = generateSlug(goal). If neither `${base}.spec.md` nor
 * `${base}.spec.json` exists at projectRoot, base is returned as-is.
 * Otherwise probes `${base}-1`, `${base}-2`, … and returns the first suffix
 * for which neither sibling exists.
 *
 * @param {string} projectRoot  Absolute project root
 * @param {string} goal
 * @returns {string}
 */
export function resolveUserSpecSlug(projectRoot, goal) {
  const base = generateSlug(goal);

  const exists = (slug) =>
    fs.existsSync(path.join(projectRoot, `${slug}.spec.md`)) ||
    fs.existsSync(path.join(projectRoot, `${slug}.spec.json`));

  if (!exists(base)) return base;

  let counter = 1;
  while (exists(`${base}-${counter}`)) {
    counter++;
  }
  return `${base}-${counter}`;
}

/**
 * Write the projected spec bundle (`${slug}.spec.json` and `${slug}.spec.md`)
 * to `projectRoot`.
 *
 * @param {string} projectRoot  Absolute project root
 * @param {string} slug
 * @param {{ specJson: object, specMd: string }} bundle
 * @returns {{ mdPath: string, jsonPath: string }} absolute paths to the written files
 */
export function writeUserSpecBundle(projectRoot, slug, { specJson, specMd }) {
  const jsonPath = path.join(projectRoot, `${slug}.spec.json`);
  const mdPath = path.join(projectRoot, `${slug}.spec.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(specJson, null, 2));
  fs.writeFileSync(mdPath, specMd);
  return { mdPath, jsonPath };
}

/**
 * Async orchestrator for the `.uspec.json` CLI entry point: loads and
 * validates a user spec, projects it into the flat spec.json + rendered
 * markdown shape, logs a projection preview, derives a collision-free slug,
 * writes the `${slug}.spec.json` / `${slug}.spec.md` bundle to
 * `projectRoot`, and returns the path to the written markdown file.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot  Absolute project root
 * @param {string} [opts.specPath]   Path to a `.uspec.json` file
 * @param {object} [opts.flags]      Parsed CLI flags
 * @param {() => Promise<string>} [opts.readStdin]
 * @param {(msg: string) => void} opts.log
 * @param {(msg: string) => void} opts.warn
 * @returns {Promise<string>} the absolute path to the written `${slug}.spec.md`
 */
export async function prepareUserSpecInput({ projectRoot, specPath, flags, readStdin, log, warn }) {
  const userSpec = await loadUserSpec({ specPath, flags, readStdin });
  validateUserSpecFailClosed(userSpec);
  const projection = projectUserSpec(userSpec);
  log(renderProjectionPreview(projection));
  const slug = resolveUserSpecSlug(projectRoot, userSpec.goal);
  const { mdPath } = writeUserSpecBundle(projectRoot, slug, projection);
  return mdPath;
}
