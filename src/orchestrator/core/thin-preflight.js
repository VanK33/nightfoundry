/**
 * thin-preflight.js — Preflight checks for the v0.3 thin loop
 * (`nightfoundry thin <spec.md>`), per the approved M1 blueprint v3.
 *
 * Three refusal gates, all $0 and deterministic:
 *
 *   1. STRICT clean tree — `git status --porcelain` must be EMPTY. Unlike
 *      the v0.2 guard, untracked files also refuse: the thin loop's
 *      fresh-redo step runs `git clean -fd`, which is only safe when every
 *      untracked file is provably a try artifact — i.e. when the tree
 *      started with zero untracked files. (Gitignored files — the normal
 *      home of ephemeral spec inputs — are invisible to porcelain AND to
 *      `git clean -fd` without -x, so the invariant holds for them too.)
 *   2. Envelope clamp — specs beyond the measured single-session envelope
 *      are refused with a splitting hint. Thresholds live in THIN_CLAMP
 *      (one place; Phase 1.5 re-pins them). The bypass (per-call option,
 *      or NF_THIN_CLAMP_BYPASS=1 for the gate harness) lifts ONLY the
 *      three clamp thresholds — input-integrity errors (unreadable or
 *      non-object spec files) are never bypassed.
 *   3. Input discovery — the spec pair (.md + .json) and the external
 *      acceptance FILE `<spec>.accept.*` must exist (the M1 loop consumes
 *      a provided exam; the generator is Milestone 2).
 *
 *  Every gate degrades to a refusal, never an exception: preflight()
 *  aggregates ALL refusal reasons (no fail-fast) so the operator sees the
 *  full list at once. Pure functions over injected/executed git; no model
 *  calls, no writes.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Envelope clamp thresholds (inclusive maxima). A spec is refused when
 * target_files > maxTargetFiles OR acceptance criteria > maxCriteria OR
 * spec.md line count > maxSpecLines. Values come from the Phase 1
 * envelope calibration: every real archived spec at tf<=21 / ac<=11 sat
 * inside the bare single-session envelope, while the known failure point
 * (the 404-line merged monolith) is caught by the line axis.
 */
export const THIN_CLAMP = Object.freeze({
  maxTargetFiles: 21,
  maxCriteria: 11,
  maxSpecLines: 299,
});

/**
 * Strict clean-tree check: any `git status --porcelain` output (tracked
 * modifications AND untracked files) fails the check. A directory that is
 * not a git repository is reported as dirty with an explanatory entry —
 * never an exception.
 *
 * @param {string} projectRoot
 * @param {object} [deps] - { execSync? } injection seam for tests.
 * @returns {{clean: boolean, entries: string[]}} entries = porcelain lines
 *   (verbatim, trimmed) when dirty; [] when clean.
 */
export function assertCleanTreeStrict(projectRoot, deps = {}) {
  const _execSync = deps.execSync ?? execSync;
  let out;
  try {
    out = _execSync('git status --porcelain', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return {
      clean: false,
      entries: [`<git status failed: ${projectRoot} is not a git repository or git is unavailable>`],
    };
  }
  const entries = String(out)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
  return { clean: entries.length === 0, entries };
}

/**
 * Envelope clamp. Reads the spec pair and refuses over-envelope specs.
 *
 * Result contract:
 *   - `errors`  — input-integrity problems (unreadable / non-object spec
 *                 json, unreadable spec md). NEVER bypassed.
 *   - `reasons` — errors + clamp refusals, for display and archiving.
 *   - `bypassed: true` — clamp refusals existed but the bypass lifted
 *                 them; `reasons` still carries them (落袋自证 depends on
 *                 the record surviving the bypass).
 *
 * @param {string} specJsonPath
 * @param {string} specMdPath
 * @param {object} [opts] - { bypass?: boolean } per-call seam; defaults to
 *   process.env.NF_THIN_CLAMP_BYPASS === '1' (gate harness only).
 * @returns {{ok: boolean, bypassed?: boolean, reasons: string[], errors: string[]}}
 */
export function checkEnvelope(specJsonPath, specMdPath, opts = {}) {
  const errors = [];
  const clampReasons = [];

  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(specJsonPath, 'utf8'));
  } catch {
    errors.push(`spec json unreadable: ${specJsonPath}`);
  }
  if (spec !== undefined && (spec === null || typeof spec !== 'object' || Array.isArray(spec))) {
    errors.push(`spec json is not an object: ${specJsonPath}`);
    spec = undefined;
  }
  const tf = spec && Array.isArray(spec.target_files) ? spec.target_files.length : 0;
  const ac = spec && Array.isArray(spec.acceptance_criteria) ? spec.acceptance_criteria.length : 0;

  let lines = 0;
  try {
    lines = fs
      .readFileSync(specMdPath, 'utf8')
      .split('\n')
      .filter((l, i, a) => i < a.length - 1 || l !== '').length;
  } catch {
    errors.push(`spec md unreadable: ${specMdPath}`);
  }

  if (tf > THIN_CLAMP.maxTargetFiles) {
    clampReasons.push(
      `target_files ${tf} > ${THIN_CLAMP.maxTargetFiles} — beyond the measured single-session envelope; split the spec into sequential in-envelope chunks`
    );
  }
  if (ac > THIN_CLAMP.maxCriteria) {
    clampReasons.push(
      `acceptance criteria ${ac} > ${THIN_CLAMP.maxCriteria} — beyond the measured envelope; split the spec`
    );
  }
  if (lines > THIN_CLAMP.maxSpecLines) {
    clampReasons.push(
      `spec body ${lines} lines >= ${THIN_CLAMP.maxSpecLines + 1} — the axis that catches merged monoliths; split the spec`
    );
  }

  const bypass = opts.bypass ?? process.env.NF_THIN_CLAMP_BYPASS === '1';
  const reasons = [...errors, ...clampReasons];

  if (errors.length > 0) {
    // Input-integrity failures are never bypassed.
    return { ok: false, reasons, errors };
  }
  if (clampReasons.length > 0 && bypass) {
    return { ok: true, bypassed: true, reasons, errors };
  }
  return { ok: clampReasons.length === 0, reasons, errors };
}

/**
 * Discover the spec's sibling json and its external acceptance file.
 * The acceptance contract (blueprint v3): `<spec base>.accept.*`, a
 * regular executable FILE, exit 0 = green, stdout lines `PASS <label>` /
 * `FAIL <label>`. Directories that happen to match the prefix are ignored.
 * Multiple matches resolve deterministically to the lexicographically
 * first, with a warning recorded (the blueprint assumes a single exam).
 *
 * @param {string} specMdPath
 * @returns {{ok: boolean, specMd: string, specJson?: string, acceptPath?: string,
 *            reasons: string[], warnings: string[]}}
 */
export function discoverInputs(specMdPath) {
  const reasons = [];
  const warnings = [];
  const specMd = path.resolve(specMdPath);
  const base = specMd.replace(/\.md$/, '');
  const specJson = `${base}.json`;
  if (!fs.existsSync(specMd)) reasons.push(`spec md not found: ${specMd}`);
  if (!fs.existsSync(specJson)) reasons.push(`spec json not found: ${specJson}`);

  let acceptPath;
  const dir = path.dirname(specMd);
  const prefix = `${path.basename(base)}.accept.`;
  try {
    const hits = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => path.join(dir, f))
      .filter((p) => {
        try {
          return fs.statSync(p).isFile();
        } catch {
          return false;
        }
      })
      .sort();
    if (hits.length > 0) {
      acceptPath = hits[0];
      if (hits.length > 1) {
        warnings.push(
          `multiple acceptance files match ${prefix}* — using ${path.basename(acceptPath)} (lexicographically first); the blueprint assumes a single exam`
        );
      }
    }
  } catch {
    /* dir unreadable falls through to the refusal below */
  }
  if (!acceptPath) {
    reasons.push(
      `acceptance file not found: ${prefix}* — the M1 thin loop requires an externally provided exam (generator lands in M2)`
    );
  }

  return { ok: reasons.length === 0, specMd, specJson, acceptPath, reasons, warnings };
}

/**
 * Combined preflight: runs all three gates, aggregates EVERY refusal
 * (never fail-fast — the operator sees the full list at once), and
 * captures the base sha the red loop's fresh-redo will reset to.
 *
 * @param {string} specMdPath
 * @param {string} projectRoot
 * @param {object} [deps] - { execSync?, bypass? }
 * @returns {{ok: boolean, baseSha?: string, inputs?: object,
 *            envelope?: object, warnings: string[], refusals: string[]}}
 */
export function preflight(specMdPath, projectRoot, deps = {}) {
  const _execSync = deps.execSync ?? execSync;
  const refusals = [];
  const warnings = [];

  const tree = assertCleanTreeStrict(projectRoot, deps);
  if (!tree.clean) {
    refusals.push(
      `working tree not strictly clean (thin requires zero modifications AND zero untracked):\n  ${tree.entries.join('\n  ')}`
    );
  }

  const inputs = discoverInputs(specMdPath);
  if (!inputs.ok) refusals.push(...inputs.reasons);
  warnings.push(...inputs.warnings);

  let envelope = { ok: false, skipped: true, reasons: [], errors: [] };
  if (inputs.specJson && fs.existsSync(inputs.specJson) && fs.existsSync(inputs.specMd)) {
    envelope = checkEnvelope(inputs.specJson, inputs.specMd, deps);
    if (!envelope.ok) refusals.push(...envelope.reasons);
    else if (envelope.bypassed) warnings.push(...envelope.reasons.map((r) => `clamp bypassed: ${r}`));
  }

  let baseSha;
  try {
    baseSha = String(
      _execSync('git rev-parse HEAD', {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(baseSha)) {
      baseSha = undefined;
      refusals.push(`cannot resolve HEAD (no commits yet?): ${projectRoot}`);
    }
  } catch {
    refusals.push(`not a git repository (or no HEAD): ${projectRoot}`);
  }

  // DRY hand-off to the runner (T2): expose the spec's target_files so the
  // CLI does not have to re-parse spec.json.
  let targetFiles = [];
  try {
    const spec = JSON.parse(fs.readFileSync(inputs.specJson, 'utf8'));
    if (spec && Array.isArray(spec.target_files)) targetFiles = spec.target_files;
  } catch {
    /* refusals already carry the unreadable-spec reason */
  }

  return { ok: refusals.length === 0, baseSha, inputs, targetFiles, envelope, warnings, refusals };
}
