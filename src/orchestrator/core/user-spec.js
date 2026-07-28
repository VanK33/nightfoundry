/**
 * Deterministic classifier for user-supplied "how do I verify this" evidence
 * strings into one of the three acceptance-criterion verification shapes
 * used by the brainstormer (see `brainstormSpecSchema.acceptance_criteria[].verification`
 * in `src/orchestrator/agents/_schemas.js`):
 *
 *   - { kind: 'command',    command, targetFile }
 *   - { kind: 'file-check', targetFile }
 *   - { kind: 'manual',     manualSteps }
 *
 * Pure: no fs, network, LLM calls, Date, or Math.random. Given the same
 * evidence + targetFiles inputs, always returns the same result.
 */

/** Runner tokens recognized as the start of a command-shaped evidence string. */
const COMMAND_RUNNERS = ['node', 'npm', 'npx', 'bash', 'sh', 'python', 'python3', 'pytest'];

/** Verbs that, if present, indicate prose rather than a bare path. */
const PROSE_VERB_RE = /\b(run|verify|check|open|render|renders|ensure|confirm|click|navigate|see|look)\b/i;

/**
 * Heuristic: does `s` look like a bare file path (no runner, no prose verb)?
 * A string is path-like when it contains a '/' or a dotted file extension,
 * has no internal whitespace before any extension-bearing token that would
 * indicate a sentence, and is not command-shaped.
 *
 * @param {string} s
 * @returns {boolean}
 */
export function isPathLike(s) {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;
  if (isCommandShaped(trimmed)) return false;
  if (PROSE_VERB_RE.test(trimmed)) return false;
  // Whitespace generally indicates prose, not a bare path — but allow none.
  if (/\s/.test(trimmed)) return false;

  const hasSlash = trimmed.includes('/');
  const hasDottedExtension = /\.[A-Za-z0-9]{1,10}$/.test(trimmed);
  return hasSlash || hasDottedExtension;
}

/**
 * Heuristic: does `s` look like a shell command (starts with a known runner
 * token OR is a '&&'-chained compound command, and contains at least one
 * file-token argument)?
 *
 * @param {string} s
 * @returns {boolean}
 */
export function isCommandShaped(s) {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;

  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0];
  // Command shape: a known runner prefix OR a compound '&&' chain (e.g. the
  // grep-registration idiom). The '&&' alternative is part of the shipped
  // classification contract; without it compound commands silently degrade
  // to manual.
  if (!COMMAND_RUNNERS.includes(firstToken) && !trimmed.includes('&&')) return false;

  // Must contain at least one argument that looks like a file token
  // (contains '/' or a dotted extension).
  return tokens.slice(1).some((tok) => /[/.]/.test(tok) && /\.[A-Za-z0-9]{1,10}$/.test(tok));
}

/**
 * Extract the first file-token argument from a command-shaped evidence
 * string (i.e. the argument that made `isCommandShaped` true).
 *
 * @param {string} command
 * @returns {string|null}
 */
function extractFileToken(command) {
  const tokens = command.trim().split(/\s+/).slice(1);
  for (const tok of tokens) {
    if (/[/.]/.test(tok) && /\.[A-Za-z0-9]{1,10}$/.test(tok)) return tok;
  }
  return null;
}

const FALLBACK_MANUAL_STEPS = 'Manual verification.';

/**
 * Classify a user-supplied evidence string into a verification object.
 *
 * @param {string} evidence
 * @param {string[]} targetFiles
 * @returns {{ kind: 'command', command: string, targetFile: string }
 *         | { kind: 'file-check', targetFile: string }
 *         | { kind: 'manual', manualSteps: string }}
 */
export function classifyEvidence(evidence, targetFiles) {
  const files = Array.isArray(targetFiles) ? targetFiles : [];

  if (typeof evidence !== 'string' || evidence.trim().length === 0) {
    return { kind: 'manual', manualSteps: FALLBACK_MANUAL_STEPS };
  }

  const trimmed = evidence.trim();

  if (isCommandShaped(trimmed)) {
    const token = extractFileToken(trimmed);
    if (token !== null && files.some((entry) => entry === token)) {
      return { kind: 'command', command: evidence, targetFile: token };
    }
    return { kind: 'manual', manualSteps: evidence };
  }

  if (isPathLike(trimmed)) {
    return { kind: 'file-check', targetFile: trimmed };
  }

  return { kind: 'manual', manualSteps: evidence };
}

// ── User-spec markdown rendering ────────────────────────────────────────
//
// Pure, deterministic renderer for user-authored spec objects (see
// `userSpecSchema` in `src/orchestrator/agents/_schemas.js`). Produces the
// same numbered-bold scope-in dialect that `extractScopeItems` in
// `scope-parser.js` parses back out (`N. **<label>**`), so a rendered
// spec.md round-trips through the scope-item extraction pipeline.

/**
 * Render the title section: a top-level heading from userSpec.goal, falling
 * back to specJson.goal when userSpec.goal is absent/blank. Omitted
 * entirely (returns '') when neither source has a usable goal string.
 *
 * @param {object} spec
 * @param {object} specJson
 * @returns {string}
 */
function renderTitleSection(spec, specJson) {
  const ownGoal = typeof spec.goal === 'string' ? spec.goal.trim() : '';
  if (ownGoal.length > 0) return `# ${ownGoal}`;
  const fallbackGoal = typeof specJson.goal === 'string' ? specJson.goal.trim() : '';
  if (fallbackGoal.length > 0) return `# ${fallbackGoal}`;
  return '';
}

/**
 * Render the '## Scope — in' section. Each entry is rendered in the
 * numbered-bold dialect:
 *
 *   N. **<label>** — <behavior>
 *   <!-- scope-item: <marker> -->
 *      - <file>
 *
 * `— <behavior>` is omitted when the entry has no behavior string, and the
 * file bullets are omitted when the entry has no files array.
 *
 * Every entry additionally emits an HTML `<!-- scope-item: ... -->` comment
 * marker — the `comment-marker` pattern `extractScopeItems` (scope-parser.js)
 * already recognises — so the rendered markdown round-trips losslessly
 * through `extractScopeItems` even when two or more entries share an
 * identical label (which `extractScopeItems` would otherwise collapse via
 * its dedupe-by-label step). The marker text is unique per *entry*:
 *
 *   - the first occurrence of a given label emits a marker carrying the
 *     bare label, which harmlessly collapses (during extractScopeItems'
 *     dedupe) with that same entry's `N. **label**` numbered-bold line — so
 *     the entry still contributes exactly one item, with its `source` still
 *     'numbered-bold-item' (the bold line is emitted, and therefore parsed,
 *     first).
 *   - each repeat occurrence of a label emits a marker with a deterministic
 *     disambiguating suffix (` (dup N)`, where N is the 1-based occurrence
 *     count for that label within this scope_in array), so it survives the
 *     dedupe-by-label step as its own distinct item.
 *
 * @param {Array<{label?: string, behavior?: string, files?: string[]}>} scopeIn
 * @returns {string}
 */
function renderScopeInSection(scopeIn) {
  const items = Array.isArray(scopeIn) ? scopeIn : [];
  const lines = ['## Scope — in', ''];
  const labelOccurrences = new Map();
  items.forEach((item, idx) => {
    const entry = item && typeof item === 'object' ? item : {};
    const label = typeof entry.label === 'string' ? entry.label : '';
    const behavior = typeof entry.behavior === 'string' && entry.behavior.trim().length > 0
      ? entry.behavior
      : '';
    lines.push(
      behavior
        ? `${idx + 1}. **${label}** — ${behavior}`
        : `${idx + 1}. **${label}**`,
    );
    const occurrence = (labelOccurrences.get(label) || 0) + 1;
    labelOccurrences.set(label, occurrence);
    const marker = occurrence === 1 ? label : `${label} (dup ${occurrence})`;
    lines.push(`<!-- scope-item: ${marker} -->`);
    const files = Array.isArray(entry.files) ? entry.files : [];
    for (const file of files) {
      lines.push(`   - ${file}`);
    }
    lines.push('');
  });
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Render the '## Scope — out' section as a bullet list. Returns '' when
 * scopeOut is absent/empty, so the caller omits the section entirely.
 *
 * @param {string[]} scopeOut
 * @returns {string}
 */
function renderScopeOutSection(scopeOut) {
  const items = Array.isArray(scopeOut) ? scopeOut : [];
  if (items.length === 0) return '';
  const lines = ['## Scope — out', ''];
  for (const entry of items) {
    lines.push(`- ${entry}`);
  }
  return lines.join('\n');
}

/**
 * Render the '## User-declared assumptions' section: a bullet per
 * userSpec.assumptions entry, followed by any userSpec.architecture_notes
 * prose.
 *
 * @param {string[]} assumptions
 * @param {string} architectureNotes
 * @returns {string}
 */
function renderAssumptionsSection(assumptions, architectureNotes) {
  const items = Array.isArray(assumptions) ? assumptions : [];
  const lines = ['## User-declared assumptions', ''];
  for (const entry of items) {
    lines.push(`- ${entry}`);
  }
  const notes = typeof architectureNotes === 'string' ? architectureNotes.trim() : '';
  if (notes.length > 0) {
    if (items.length > 0) lines.push('');
    lines.push(notes);
  }
  return lines.join('\n');
}

/**
 * Render a user-authored spec object into deterministic markdown.
 *
 * Pure: no fs, network, LLM calls, Date, or Math.random. Given the same
 * userSpec (+ optional specJson) input, always returns a byte-identical
 * string.
 *
 * Sections (in order):
 *   1. Title — a top-level heading from userSpec.goal (see
 *      renderTitleSection).
 *   2. '## Scope — in' — always rendered (see renderScopeInSection).
 *   3. '## Scope — out' — rendered only when userSpec.scope_out is a
 *      non-empty array (see renderScopeOutSection).
 *   4. '## User-declared assumptions' — always rendered, listing each
 *      userSpec.assumptions entry alongside any userSpec.architecture_notes
 *      prose (see renderAssumptionsSection).
 *
 * @param {object} userSpec
 * @param {object} [specJson]
 * @returns {string}
 */
export function renderUserSpecMd(userSpec, specJson) {
  const spec = userSpec && typeof userSpec === 'object' ? userSpec : {};
  const sj = specJson && typeof specJson === 'object' ? specJson : {};

  const sections = [];

  const titleSection = renderTitleSection(spec, sj);
  if (titleSection.length > 0) sections.push(titleSection);

  sections.push(renderScopeInSection(spec.scope_in));

  const scopeOutSection = renderScopeOutSection(spec.scope_out);
  if (scopeOutSection.length > 0) sections.push(scopeOutSection);

  sections.push(renderAssumptionsSection(spec.assumptions, spec.architecture_notes));

  return `${sections.join('\n\n')}\n`;
}

// ── User-spec projection ────────────────────────────────────────────────
//
// Projects a user-authored spec object (see `userSpecSchema` in
// `src/orchestrator/agents/_schemas.js`) into the flat
// { goal, target_files, acceptance_criteria, constraints, architecture_notes }
// shape consumed downstream (mirroring `brainstormSpecSchema`), plus the
// rendered markdown and any warnings surfaced during projection.

/**
 * Rewrite a scope_out entry as a negatively-phrased constraint string.
 *
 * @param {string} entry
 * @returns {string}
 */
function rewriteScopeOutAsConstraint(entry) {
  const text = typeof entry === 'string' ? entry : String(entry);
  return `Do not: ${text}`;
}

/**
 * Append `value` to `arr` iff it is not already present (order-preserving
 * dedup helper for the two-source target_files union).
 *
 * @param {string[]} arr
 * @param {string} value
 */
function pushIfAbsent(arr, value) {
  if (!arr.includes(value)) arr.push(value);
}

/**
 * Project a user-authored spec into the flat spec.json shape, its rendered
 * markdown, and a list of warnings, via an explicit two-pass evaluation:
 *
 *   PASS 1: walk userSpec.success_criteria and collect the path-like
 *     evidence strings (per `isPathLike`). These, appended after the
 *     flattened userSpec.scope_in[].files, form the deduped,
 *     order-preserving union that becomes target_files. No other source
 *     contributes to target_files.
 *
 *   PASS 2: for each success_criteria item, classify its evidence against
 *     the final target_files (via `classifyEvidence`) to build an
 *     { description, verification } acceptance_criteria entry. When a
 *     command-shaped evidence string is downgraded to kind 'manual' (i.e.
 *     it had no matching target file), a warning is pushed noting the
 *     unmatched command.
 *
 * constraints = userSpec.constraints followed by each userSpec.scope_out
 * entry rewritten as a negatively-phrased constraint string.
 *
 * Two additional warnings are always checked for and pushed when true:
 *   - zero checkable criteria: no acceptance_criteria entry has
 *     verification.kind 'command' or 'file-check'.
 *   - empty target_files: the two-source union produced no entries.
 *
 * Pure: no fs, network, LLM calls, Date, or Math.random. Given the same
 * userSpec input, always returns the same { specJson, specMd, warnings }.
 *
 * @param {object} userSpec
 * @returns {{ specJson: object, specMd: string, warnings: string[] }}
 */
export function projectUserSpec(userSpec) {
  const spec = userSpec && typeof userSpec === 'object' ? userSpec : {};
  const warnings = [];

  // ── PASS 1: collect target_files from exactly two sources ──────────────
  const scopeIn = Array.isArray(spec.scope_in) ? spec.scope_in : [];
  const successCriteria = Array.isArray(spec.success_criteria) ? spec.success_criteria : [];

  const targetFiles = [];
  for (const item of scopeIn) {
    const files = item && Array.isArray(item.files) ? item.files : [];
    for (const file of files) pushIfAbsent(targetFiles, file);
  }
  for (const item of successCriteria) {
    const evidence = item && typeof item === 'object' ? item.evidence : undefined;
    if (typeof evidence === 'string' && isPathLike(evidence.trim())) {
      pushIfAbsent(targetFiles, evidence.trim());
    }
  }

  // ── PASS 2: project each success_criteria item into acceptance_criteria ─
  const acceptanceCriteria = successCriteria.map((item) => {
    const entry = item && typeof item === 'object' ? item : {};
    const evidence = entry.evidence;
    const verification = classifyEvidence(evidence, targetFiles);

    if (
      verification.kind === 'manual' &&
      typeof evidence === 'string' &&
      isCommandShaped(evidence.trim())
    ) {
      warnings.push(`Command-shaped evidence "${evidence.trim()}" did not match any target file and was downgraded to manual verification.`);
    }

    return { description: entry.description, verification };
  });

  // ── constraints: user constraints + negatively-phrased scope_out ───────
  const userConstraints = Array.isArray(spec.constraints) ? spec.constraints : [];
  const scopeOut = Array.isArray(spec.scope_out) ? spec.scope_out : [];
  const constraints = [
    ...userConstraints,
    ...scopeOut.map(rewriteScopeOutAsConstraint),
  ];

  const specJson = {
    goal: spec.goal,
    target_files: targetFiles,
    acceptance_criteria: acceptanceCriteria,
    constraints,
    architecture_notes: spec.architecture_notes,
  };

  const specMd = renderUserSpecMd(spec, specJson);

  // ── mandated warnings ────────────────────────────────────────────────
  const hasCheckableCriterion = acceptanceCriteria.some(
    (ac) => ac.verification.kind === 'command' || ac.verification.kind === 'file-check',
  );
  if (!hasCheckableCriterion) {
    warnings.push('No checkable acceptance criteria: every success criterion resolved to manual verification.');
  }
  if (targetFiles.length === 0) {
    warnings.push('target_files is empty: no scope_in files and no path-like success-criteria evidence were found.');
  }

  return { specJson, specMd, warnings };
}
