/**
 * brainstormer.js — Pure helpers for the brainstormer agent.
 *
 * The brainstormer turns a user's natural-language feature request into a
 * structured spec (spec.json) plus a companion markdown narrative (spec.md).
 * It can operate in four modes:
 *   • initialize  — first draft from raw user input
 *   • regenerate  — full redo using feedback
 *   • edit        — targeted change using feedback
 *   • append      — add to an existing spec using feedback
 *
 * Public API:
 *   buildBrainstormerPrompt({ mode, userInput, currentSpec, feedback })
 *     → string  (pure, no I/O, no side effects)
 *
 *   extractBrainstormResult(sdkResult, opts?)
 *     → { spec, specMd, digest }  (pure extraction + validation; throws on any
 *       failure of spec/specMd; `digest` is the wrapper's optional
 *       understanding-playback channel — present when the agent emitted one,
 *       undefined otherwise, never throws on its absence)
 */
import config from '../infra/config.js';
import { brainstormSpecSchema, proposeQuestionsSchema, followupQuestionsSchema, extractStructured, validateStructured } from './_schemas.js';

// Schema-required fields (goal, target_files, acceptance_criteria,
// constraints, architecture_notes) are validated by brainstormSpecSchema
// at structured-output extraction time, then persisted wholesale by
// writeBundle() → spec.json. Downstream consumers (planner, human
// reviewer) read the fields from the persisted JSON file — the static
// audit-r2 scanner cannot trace this indirect path.

// Module-level fallback root (captured once at load time)
const projectRoot = process.cwd();

// ─── buildBrainstormerPrompt ─────────────────────────────────────────────────

/**
 * Build the brainstormer's user prompt.
 *
 * Pure function (no I/O, no side effects). Branches on `mode`:
 *   - 'initialize'              → uses userInput
 *   - 'regenerate'|'edit'|'append' → uses currentSpec + feedback
 *
 * @param {object}  params
 * @param {string}  params.mode          - 'initialize' | 'regenerate' | 'edit' | 'append'
 * @param {string}  [params.userInput]   - Raw user prose (initialize mode)
 * @param {object}  [params.currentSpec] - Existing spec object (edit/regenerate/append modes)
 * @param {string}  [params.feedback]    - User feedback driving the change
 * @param {Array<{question: string, answer: string}>} [params.answers] - Clarifying
 *        Q&A collected during the TTY elicitation phase (initialize mode only).
 *        When absent/empty the built prompt is byte-identical to today.
 * @param {boolean} [params.withDigest] - When truthy, append a section instructing
 *        the agent to ALSO emit a `digest` object (scopeOut/assumptions/risks —
 *        the parts not expressible in spec.json) for the TTY understanding-playback
 *        step. When falsy/absent the built prompt is byte-identical to today
 *        (the batch / non-TTY path).
 * @returns {string} The user prompt
 */
export function buildBrainstormerPrompt({ mode, userInput, currentSpec, feedback, answers, correction, withDigest }) {
  // ── Schema field reference ────────────────────────────────────────────────
  const schemaReference = `## Spec JSON Schema

The structured response MUST include both a validated \`spec\` object and a separately authored markdown \`specMd\` string.

### spec object — required fields

| Field                | Type              | Required | Description |
|----------------------|-------------------|----------|-------------|
| \`goal\`             | string            | yes      | One-sentence statement of what the feature achieves and why. |
| \`target_files\`     | string[]          | yes      | Files (or directory patterns) the implementation will touch. Mix literal paths and directory patterns — e.g. \`"src/foo.js"\` (literal) alongside \`"test/"\` (directory pattern that covers all files under test/). |
| \`acceptance_criteria\` | {description, verification}[] | yes | Observable, verifiable outcomes. Each item has a \`description\` (what to check) and a REQUIRED structured \`verification\` object (how to confirm it passed). See "verification kinds" below. |
| \`constraints\`      | string[]          | no       | **Rules** the implementation must obey — hard boundaries, not suggestions. Example: "Must not import fs in browser-side modules." |
| \`architecture_notes\` | string          | no       | **Suggestions** about approach — directional guidance the implementor may adapt. Example: "Consider using a Map for O(1) lookups." |

### constraints vs architecture_notes — key distinction

- \`constraints\` = **rules** (non-negotiable). The implementation will be rejected if it violates these.
- \`architecture_notes\` = **suggestions** (advisory). The implementor may deviate if they have a good reason.

### verification kinds — every acceptance criterion MUST carry one

Each \`acceptance_criteria\` item REQUIRES a structured \`verification\` object that says how the criterion is confirmed. Pick exactly one \`kind\`:

| \`kind\`       | Required sub-fields            | Use when |
|--------------|--------------------------------|----------|
| \`command\`    | \`command\` + \`targetFile\`       | A shell command deterministically proves the criterion (e.g. a test file the orchestrator can run). PREFER this. |
| \`file-check\` | \`targetFile\`                   | The criterion is satisfied by a file existing / being present. Use when there is no runnable command but a concrete file anchors the outcome. |
| \`manual\`     | \`manualSteps\`                  | Escape hatch — ONLY for UI / pure-subjective outcomes a machine cannot check. Use last; prefer \`command\` or \`file-check\` whenever possible. |

Rules:
- Gather each criterion's \`verification\` (and its \`targetFile\`) at ask-time — do not leave it implicit.
- For \`command\` and \`file-check\`, \`targetFile\` MUST be one of the spec's \`target_files\`.
- \`command\` is a runnable shell command (e.g. \`node test/foo.js\`); \`targetFile\` is the file that command exercises.
- \`manual\` is an escape hatch: reach for it only when no deterministic command or file-check applies (UI rendering, pure-subjective judgement). Default to \`command\`/\`file-check\` first.

### verification examples

\`\`\`json
{ "description": "foo() returns true on valid input", "verification": { "kind": "command", "command": "node test/foo.js", "targetFile": "test/foo.js" } }
\`\`\`
\`\`\`json
{ "description": "the migration file is created", "verification": { "kind": "file-check", "targetFile": "migrations/001_init.sql" } }
\`\`\`
\`\`\`json
{ "description": "the dashboard banner renders correctly", "verification": { "kind": "manual", "manualSteps": "Open /dashboard and confirm the banner shows the new copy." } }
\`\`\`

### target_files examples

Good — mixes literal and pattern:
\`\`\`json
["src/orchestrator/agents/brainstormer.js", "test/"]
\`\`\`

Also valid — all literal:
\`\`\`json
["src/lib/parser.js", "src/lib/parser.test.js"]
\`\`\`

### What belongs in specMd (NOT in spec.json values)

Rationale prose, background context, tradeoff discussions, and design history belong in \`specMd\` (the markdown companion). Do NOT embed prose explanations inside the JSON values of \`spec\`. Each spec.json value should be a concise, machine-readable string — not a paragraph.

Example of what NOT to do:
\`\`\`json
{
  "goal": "Add caching layer (we discussed this because the API was too slow and we want to reduce latency by memoizing repeated calls which were observed to account for 40% of total request time in profiling)"
}
\`\`\`

Correct approach — keep spec.json values terse; put rationale in specMd:
\`\`\`json
{
  "goal": "Add a memoization cache to reduce redundant API calls."
}
\`\`\`
\`\`\`markdown
## Background
Profiling showed repeated calls account for ~40% of total request time...
\`\`\`
`;

  // ── Worked example ────────────────────────────────────────────────────────
  const workedExample = `## Worked example

**User request (prose):**
> "I want to add a rate limiter to the HTTP client so we don't hammer the external API."

**Resulting spec.json:**
\`\`\`json
{
  "goal": "Add a configurable rate limiter to the HTTP client that caps outbound requests per second.",
  "target_files": ["src/http/client.js", "src/http/rate-limiter.js", "test/"],
  "acceptance_criteria": [
    {
      "description": "HTTP client enforces the configured requests-per-second cap",
      "verification": { "kind": "command", "command": "node test/rate-limiter.test.js", "targetFile": "src/http/rate-limiter.js" }
    },
    {
      "description": "Rate limiter is configurable via constructor options",
      "verification": { "kind": "command", "command": "node test/rate-limiter-config.test.js", "targetFile": "src/http/rate-limiter.js" }
    }
  ],
  "constraints": [
    "Must not add any runtime npm dependencies — implement using setTimeout/Promise only.",
    "Must be backwards compatible: omitting rps option disables rate limiting."
  ],
  "architecture_notes": "Consider a token-bucket algorithm for burst tolerance. A simple sliding-window counter is also acceptable."
}
\`\`\`

**Resulting specMd (excerpt):**
\`\`\`markdown
# Rate Limiter — Spec

## Background
Our external API vendor enforces a 5 req/s limit. Without client-side throttling, bursts were causing 429 errors that propagated as user-visible failures...

## Design discussion
Token bucket vs sliding window: token bucket handles bursts better, but sliding window is simpler to implement correctly under Node.js's single-threaded event loop...
\`\`\`
`;

  // ── Response instructions ────────────────────────────────────────────────
  const responseInstructions = `## Response format

Return a structured JSON object with exactly two top-level keys:

\`\`\`json
{
  "spec": { /* the spec object matching the schema above */ },
  "specMd": "# Feature Title\\n\\n## Background\\n..."
}
\`\`\`

- \`spec\` must satisfy all required fields (goal, target_files, acceptance_criteria).
- \`specMd\` must be separately authored markdown — not a serialization of \`spec\`. It should provide narrative context, rationale, and design discussion that would not fit cleanly inside the JSON values.
- Do NOT put rationale prose inside spec.json values — keep them terse and machine-readable.
`;

  // ── Digest channel section (TTY understanding-playback only) ──────────────
  // Strictly additive: omitted entirely (empty string) when withDigest is
  // falsy/absent, so the batch / non-TTY prompt stays byte-identical to today.
  // The digest carries ONLY the parts not expressible in spec.json — scope-out,
  // assumptions, risks — so a one-page read-back can be rendered for the user to
  // confirm before accepting. It does NOT alter the two-key spec/specMd contract.
  const digestSection = withDigest
    ? `## Understanding digest (additional output)

In ADDITION to \`spec\` and \`specMd\`, you MUST emit a third top-level key \`digest\` capturing the parts of your understanding that do NOT fit the frozen spec.json fields, so the user can confirm your read-back before accepting. This is REQUIRED, not optional — do NOT omit it, and do NOT leave all three lists empty when the spec plainly has boundaries, load-bearing assumptions, or risks (almost every non-trivial spec does):

\`\`\`json
{
  "digest": {
    "scopeOut": ["things deliberately NOT covered by this spec"],
    "assumptions": ["assumptions you made that, if wrong, would change the spec"],
    "risks": ["risks / sharp edges the implementor should watch for"]
  }
}
\`\`\`

- \`scopeOut\` — boundaries: what a reader might expect but this spec intentionally excludes.
- \`assumptions\` — the load-bearing guesses behind your draft (each a short string).
- \`risks\` — where this could go wrong or surprise the implementor (each a short string).
- These are the parts NOT expressible in spec.json — do NOT duplicate goal / target_files / acceptance_criteria here.
- Keep each entry a concise string. The \`digest\` key is for the user's read-back only; it is never fed to the planner.
`
    : '';

  // ── Mode-specific input section ──────────────────────────────────────────
  let modeSection;

  if (mode === 'initialize') {
    // When clarifying answers were collected during the TTY elicitation phase,
    // weave them in as an additional section. When absent/empty the section is
    // omitted entirely so the batch / non-TTY draft prompt stays byte-identical.
    const hasAnswers = Array.isArray(answers) && answers.length > 0;
    // Empty case MUST leave modeSection byte-identical to the original (no
    // answers section, single trailing newline after the user input).
    const answersSection = hasAnswers
      ? `
### Clarifying answers

The user answered the following clarifying questions about this request. Use these answers to resolve ambiguity and shape the spec — they are authoritative over any default assumption.

${answers.map((a, i) => `${i + 1}. Q: ${a.question}\n   A: ${a.answer}`).join('\n')}
`
      : '';

    // A re-framing correction from the TTY escape hatch (reject / partially-
    // correct) is authoritative over the raw input. Omitted entirely when
    // absent so the batch / non-TTY draft prompt stays byte-identical.
    const hasCorrection = typeof correction === 'string' && correction.trim().length > 0;
    const correctionSection = hasCorrection
      ? `
### Clarified intent

The user reviewed an initial framing of this request and corrected/clarified their intent as follows. Treat this as authoritative over the raw input above:

${correction}
`
      : '';

    modeSection = `## Mode: initialize

Generate a first-draft spec from the user's raw input below.

### User input
${userInput || '(no input provided)'}
${correctionSection}${answersSection}`;
    // (answersSection is '' in the no-answers case → the template above is
    //  byte-identical to the original initialize prompt.)
  } else {
    // regenerate | edit | append
    const modeDescriptions = {
      regenerate: 'Discard the current spec entirely and produce a fresh spec that incorporates the feedback.',
      edit:       'Modify the current spec in a targeted way as directed by the feedback. Preserve fields not mentioned.',
      append:     'Add to the current spec (new acceptance criteria, additional target files, etc.) as directed by the feedback.',
    };

    const modeDescription = modeDescriptions[mode] || `Apply the feedback to the spec (mode: ${mode}).`;

    modeSection = `## Mode: ${mode}

${modeDescription}

### Current spec
\`\`\`json
${JSON.stringify(currentSpec || {}, null, 2)}
\`\`\`

### Feedback
${feedback || '(no feedback provided)'}
`;
  }

  // The legacy parts join exactly as before; digestSection is appended only when
  // withDigest is truthy (it is '' otherwise), so the joined prompt is
  // byte-identical to the legacy (no-digest) path. Spreading a conditional array
  // keeps the intentional blank-line element (index 1) untouched.
  const parts = [
    `You are a brainstormer agent. Your job is to turn a user's feature request into a structured spec (spec.json) and a companion markdown narrative (spec.md).`,
    '',
    modeSection,
    schemaReference,
    workedExample,
    responseInstructions,
    ...(digestSection ? [digestSection] : []),
  ];
  return parts.join('\n');
}

// ─── extractBrainstormResult ─────────────────────────────────────────────────

/**
 * Extract and validate the brainstormer's structured output.
 *
 * Pure extraction + validation — no filesystem writes.
 *
 * Throws a structured Error (err.code = 'BRAINSTORM_VALIDATION_FAILED') on:
 *   (i)   extractStructured returns null
 *   (ii)  parsed object missing `spec` or `specMd`
 *   (iii) validateStructured(parsed.spec, brainstormSpecSchema) returns ok:false
 *   (iv)  a verification object violates its per-kind contract — kind=command
 *         missing command/targetFile, kind=file-check missing targetFile,
 *         kind=manual missing manualSteps, or a command/file-check targetFile
 *         not in spec.target_files. (Imperative; the schema only checks the
 *         flat part — verification required + kind enum.)
 *
 * NO silent fallback. NO stub default. Every failure path throws.
 *
 * The optional `digest` wrapper key (scopeOut/assumptions/risks — the
 * TTY understanding-playback channel) is returned verbatim when present and
 * `undefined` when absent. Its absence NEVER throws; only spec/specMd validation
 * and the verification contract gate the result.
 *
 * @param {object|null|undefined} sdkResult - Raw SDK result object
 * @param {object} [opts]
 * @param {function} [opts.warn] - Warning callback (default console.warn)
 * @returns {{ spec: object, specMd: string, digest: object|undefined }}
 */
export function extractBrainstormResult(sdkResult, opts = {}) {
  const warn = opts.warn ?? console.warn;

  // Step 1: extract structured_output
  const parsed = extractStructured(sdkResult, { warn });

  if (parsed === null) {
    const err = new Error('Brainstormer returned no structured output');
    err.code = 'BRAINSTORM_VALIDATION_FAILED';
    err.errors = ['extractStructured returned null — no structured_output in SDK result'];
    err.received = null;
    throw err;
  }

  // Step 2: check required top-level keys
  const missingKeys = [];
  if (!('spec' in parsed)) missingKeys.push('missing top-level key: spec');
  if (!('specMd' in parsed)) missingKeys.push('missing top-level key: specMd');

  if (missingKeys.length > 0) {
    const err = new Error('Brainstormer structured output missing required keys');
    err.code = 'BRAINSTORM_VALIDATION_FAILED';
    err.errors = missingKeys;
    err.received = parsed;
    throw err;
  }

  // Step 3: validate spec against brainstormSpecSchema
  const validation = validateStructured(parsed.spec, brainstormSpecSchema);

  if (!validation.ok) {
    const err = new Error('Brainstormer spec failed schema validation');
    err.code = 'BRAINSTORM_VALIDATION_FAILED';
    err.errors = validation.errors;
    err.received = parsed;
    throw err;
  }

  // Step 4: imperative per-kind verification enforcement.
  //
  // The schema (Step 3) only covers the FLAT part — verification required +
  // kind ∈ enum. validateStructured has no oneOf/anyOf/conditional, so the
  // per-kind required sub-fields and the `targetFile ∈ target_files`
  // constraint are enforced here by hand:
  //   - kind=command   ⇒ command + targetFile required; targetFile ∈ target_files
  //   - kind=file-check ⇒ targetFile required; targetFile ∈ target_files
  //   - kind=manual    ⇒ manualSteps required (escape hatch; no targetFile)
  const targetFiles = Array.isArray(parsed.spec.target_files) ? parsed.spec.target_files : [];
  const verificationErrors = [];
  const criteria = Array.isArray(parsed.spec.acceptance_criteria) ? parsed.spec.acceptance_criteria : [];

  // target_files legitimately mixes literal paths and directory patterns
  // (trailing-slash entries like "test/"). A targetFile is "in" target_files
  // when it equals a literal entry OR falls under a trailing-slash directory
  // entry. This trailing-slash = directory-prefix convention matches
  // checkScopeComplexity. (Deliberately NOT the reverse-suffix matcher in
  // scopeSpecHardChecks — that is a known-unsound residual the spec forbids.)
  const inTargetFiles = (tf) =>
    targetFiles.some((entry) => entry === tf || (entry.endsWith('/') && tf.startsWith(entry)));

  criteria.forEach((item, i) => {
    const v = item && item.verification;
    const at = `acceptance_criteria[${i}].verification`;
    if (!v || typeof v !== 'object') return; // schema (Step 3) already flagged this
    const kind = v.kind;

    if (kind === 'command') {
      if (typeof v.command !== 'string' || v.command.length === 0) {
        verificationErrors.push(`${at}: kind=command requires a non-empty command`);
      }
      if (typeof v.targetFile !== 'string' || v.targetFile.length === 0) {
        verificationErrors.push(`${at}: kind=command requires a targetFile`);
      } else if (!inTargetFiles(v.targetFile)) {
        verificationErrors.push(`${at}: targetFile "${v.targetFile}" is not in target_files`);
      }
    } else if (kind === 'file-check') {
      if (typeof v.targetFile !== 'string' || v.targetFile.length === 0) {
        verificationErrors.push(`${at}: kind=file-check requires a targetFile`);
      } else if (!inTargetFiles(v.targetFile)) {
        verificationErrors.push(`${at}: targetFile "${v.targetFile}" is not in target_files`);
      }
    } else if (kind === 'manual') {
      if (typeof v.manualSteps !== 'string' || v.manualSteps.length === 0) {
        verificationErrors.push(`${at}: kind=manual requires manualSteps`);
      }
    }
  });

  if (verificationErrors.length > 0) {
    const err = new Error('Brainstormer spec failed verification contract');
    err.code = 'BRAINSTORM_VALIDATION_FAILED';
    err.errors = verificationErrors;
    err.received = parsed;
    throw err;
  }

  // The digest channel (scopeOut/assumptions/risks) is OPTIONAL — present only
  // on the TTY withDigest path, absent on the batch path. Absent → undefined,
  // never an error. When present, NORMALIZE its three list fields to arrays so
  // downstream render + assumptionCount telemetry are safe against a malformed
  // agent payload (e.g. assumptions returned as a string). The digest is
  // advisory, not gating — coerce + warn rather than throw.
  let digest;
  if (parsed.digest !== undefined) {
    digest = normalizeDigest(parsed.digest, warn);
  }

  return { spec: parsed.spec, specMd: parsed.specMd, digest };
}

/**
 * Coerce a digest payload's scopeOut/assumptions/risks fields to arrays.
 *
 * The digest is advisory (it only drives the user's read-back render and the
 * assumptionCount telemetry), so a malformed field is warned + coerced to []
 * rather than thrown on. A non-object digest is itself coerced to an empty
 * digest. Returns a new normalized object — does not mutate the input.
 *
 * @param {*} digest
 * @param {function} warn
 * @returns {{ scopeOut: string[], assumptions: string[], risks: string[] }}
 */
function normalizeDigest(digest, warn) {
  if (!digest || typeof digest !== 'object' || Array.isArray(digest)) {
    warn('Brainstormer digest is not an object — coercing to an empty digest');
    return { scopeOut: [], assumptions: [], risks: [] };
  }
  const coerceField = (name) => {
    const value = digest[name];
    if (Array.isArray(value)) return value;
    if (value !== undefined) {
      warn(`Brainstormer digest.${name} is not an array — coercing to []`);
    }
    return [];
  };
  return {
    ...digest,
    scopeOut: coerceField('scopeOut'),
    assumptions: coerceField('assumptions'),
    risks: coerceField('risks'),
  };
}

// ─── extractProposeQuestionsResult ───────────────────────────────────────────

/**
 * Extract and validate the brainstormer's propose-questions structured output.
 *
 * Pure extraction + validation — mirrors extractBrainstormResult's no-silent-
 * fallback style. Throws a structured Error (err.code =
 * 'BRAINSTORM_VALIDATION_FAILED') when extractStructured returns null or the
 * parsed object fails proposeQuestionsSchema.
 *
 * Returns the validated object verbatim:
 *   { restatement: { paraphrase, evidence[], unknowns[] },
 *     questions: [{ id, question, premise, category, importance }],
 *     assessedComplexity }
 *
 * @param {object|null|undefined} sdkResult - Raw SDK result object
 * @param {object} [opts]
 * @param {function} [opts.warn] - Warning callback (default console.warn)
 * @returns {{ restatement: object, questions: object[], assessedComplexity: string }}
 */
export function extractProposeQuestionsResult(sdkResult, opts = {}) {
  const warn = opts.warn ?? console.warn;

  const parsed = extractStructured(sdkResult, { warn });

  if (parsed === null) {
    const err = new Error('Brainstormer returned no structured output (propose-questions)');
    err.code = 'BRAINSTORM_VALIDATION_FAILED';
    err.errors = ['extractStructured returned null — no structured_output in SDK result'];
    err.received = null;
    throw err;
  }

  const validation = validateStructured(parsed, proposeQuestionsSchema);
  if (!validation.ok) {
    const err = new Error('Brainstormer propose-questions output failed schema validation');
    err.code = 'BRAINSTORM_VALIDATION_FAILED';
    err.errors = validation.errors;
    err.received = parsed;
    throw err;
  }

  return {
    restatement: parsed.restatement,
    questions: parsed.questions,
    assessedComplexity: parsed.assessedComplexity,
  };
}

// ─── extractFollowupsResult ──────────────────────────────────────────────────

/**
 * Extract and validate the brainstormer's propose-followups structured output.
 *
 * Pure extraction + validation — mirrors extractProposeQuestionsResult's
 * no-silent-fallback style. Throws a structured Error (err.code =
 * 'BRAINSTORM_VALIDATION_FAILED') when extractStructured returns null or the
 * parsed object fails followupQuestionsSchema. The CLI's graceful-degrade catch
 * (NOT this extractor) is what decides to fall through to drafting on failure.
 *
 * Returns the validated object verbatim:
 *   { done, integrationNote, questions: [{ id, question, premise, category, importance }] }
 *
 * NOTE: validateStructured has no boolean branch, so `done` is not type-checked
 * here — the multi-round LOOP must compare `done === true` strictly rather than
 * trust the validator.
 *
 * @param {object|null|undefined} sdkResult - Raw SDK result object
 * @param {object} [opts]
 * @param {function} [opts.warn] - Warning callback (default console.warn)
 * @returns {{ done: boolean, integrationNote: string, questions: object[] }}
 */
export function extractFollowupsResult(sdkResult, opts = {}) {
  const warn = opts.warn ?? console.warn;

  const parsed = extractStructured(sdkResult, { warn });

  if (parsed === null) {
    const err = new Error('Brainstormer returned no structured output (propose-followups)');
    err.code = 'BRAINSTORM_VALIDATION_FAILED';
    err.errors = ['extractStructured returned null — no structured_output in SDK result'];
    err.received = null;
    throw err;
  }

  const validation = validateStructured(parsed, followupQuestionsSchema);
  if (!validation.ok) {
    const err = new Error('Brainstormer propose-followups output failed schema validation');
    err.code = 'BRAINSTORM_VALIDATION_FAILED';
    err.errors = validation.errors;
    err.received = parsed;
    throw err;
  }

  return {
    done: parsed.done,
    integrationNote: parsed.integrationNote,
    questions: parsed.questions,
  };
}

// ─── checkScopeComplexity ────────────────────────────────────────────────────

/**
 * Analyse a spec object for signs that it covers too much scope.
 *
 * Returns null when no heuristic fires, or a human-readable string describing
 * which heuristics fired when one or more trigger.
 *
 * Heuristics:
 *   (1) spec.acceptance_criteria.length > 5
 *   (2) distinct non-directory target_files > 8
 *   (3) distinct top-level directories in target_files >= 4
 *   (4) spec.goal matches /\b(and|plus|also|additionally)\b/i
 *
 * @param {object} spec - A brainstorm spec object
 * @returns {string|null}
 */
export function checkScopeComplexity(spec) {
  const triggers = [];

  // (1) Too many acceptance criteria
  if (Array.isArray(spec.acceptance_criteria) && spec.acceptance_criteria.length > 5) {
    triggers.push(
      `acceptance_criteria count (${spec.acceptance_criteria.length}) exceeds 5`
    );
  }

  if (Array.isArray(spec.target_files)) {
    // (2) Too many distinct non-directory target files
    const nonDirFiles = spec.target_files.filter((f) => !String(f).endsWith('/'));
    const distinctFileCount = new Set(nonDirFiles).size;
    if (distinctFileCount > 8) {
      triggers.push(`distinct target_files (non-directory) count (${distinctFileCount}) exceeds 8`);
    }

    // (3) Too many distinct top-level directories / path prefixes
    const topLevelComponents = new Set(
      spec.target_files.map((f) => {
        const normalized = String(f).replace(/\/$/, '');
        const slash = normalized.indexOf('/');
        return slash === -1 ? normalized : normalized.slice(0, slash);
      })
    );
    if (topLevelComponents.size >= 4) {
      triggers.push(
        `distinct top-level directories (${topLevelComponents.size}) reaches 4 or more`
      );
    }
  }

  // (4) Multi-verb goal suggests multiple concerns
  if (typeof spec.goal === 'string' && /\b(and|plus|also|additionally)\b/i.test(spec.goal)) {
    triggers.push('goal contains conjunction suggesting multiple concerns');
  }

  if (triggers.length === 0) return null;

  return `Spec may be too broad. Triggers: ${triggers.join('; ')}.`;
}

// ─── applySplitRecommendation ────────────────────────────────────────────────

/**
 * Return a new { spec, specMd } with the scope-complexity warning attached.
 *
 * Pure function — does not mutate its inputs.
 *
 * @param {{ spec: object, specMd: string }} bundle
 * @param {string} warning - The warning string returned by checkScopeComplexity
 * @returns {{ spec: object, specMd: string }}
 */
export function applySplitRecommendation({ spec, specMd }, warning) {
  const patchedSpec = { ...spec, warning };
  const patchedSpecMd = specMd + '\n\n## Splitting recommendation\n\n' + warning;
  return { spec: patchedSpec, specMd: patchedSpecMd };
}

// ─── Brainstormer class ──────────────────────────────────────────────────────

const BRAINSTORMER_SYSTEM_PROMPT = `You are a Harness Brainstormer. Your ONLY job is to turn a user's feature request into a structured spec and companion markdown narrative.

Rules:
- Read the codebase as needed to understand context before drafting the spec
- Return a structured JSON object with exactly two top-level keys: spec and specMd
- spec must satisfy all required fields (goal, target_files, acceptance_criteria)
- specMd must be separately authored markdown providing narrative context, rationale, and design discussion
- Do NOT write any files — the orchestrator persists your structured output
- Do NOT update state.json — the orchestrator handles that
- Do NOT run verification — the orchestrator dispatches a verifier separately
- Do NOT write to stdout — the CLI loop is owned by the orchestrator, not by you`;

const BRAINSTORM_JSON_SCHEMA = {
  type: 'object',
  properties: {
    spec: brainstormSpecSchema,
    specMd: { type: 'string' },
  },
  required: ['spec', 'specMd'],
};

// Digest-including variant of the wrapper schema, used ONLY on the TTY
// withDigest path. Strictly additive: the same two required keys plus an
// OPTIONAL `digest` object carrying the understanding-playback channel
// (scopeOut/assumptions/risks). brainstormSpecSchema is untouched — the digest
// rides the WRAPPER only and never reaches spec.json or the planner. Derived
// from BRAINSTORM_JSON_SCHEMA (spread the base + its properties) so a future
// edit to the base wrapper can't drift this variant; `digest` is NOT added to
// `required`, keeping it optional.
const BRAINSTORM_JSON_SCHEMA_WITH_DIGEST = {
  ...BRAINSTORM_JSON_SCHEMA,
  properties: {
    ...BRAINSTORM_JSON_SCHEMA.properties,
    digest: {
      type: 'object',
      properties: {
        scopeOut: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'string' } },
      },
      // Required so the agent cannot silently omit the understanding-playback
      // channel under the weight of the spec/specMd contract (observed: a real
      // run produced a rich spec but an absent digest → playback rendered
      // "(none captured)" for the parts the playback exists to surface).
      required: ['scopeOut', 'assumptions', 'risks'],
    },
  },
  // digest is REQUIRED on the withDigest (TTY) path — the model must emit the
  // read-back content, not skip it. (extractBrainstormResult still tolerates an
  // absent digest, so the batch path that uses BRAINSTORM_JSON_SCHEMA is
  // unaffected.)
  required: [...BRAINSTORM_JSON_SCHEMA.required, 'digest'],
};

// System prompt for the pre-draft frame-first elicitation path. Deliberately
// carries NO question-count literal — the cap is a per-call style value woven
// into the user prompt by buildProposeQuestionsPrompt, never welded here.
const PROPOSE_QUESTIONS_SYSTEM_PROMPT = `You are a Harness Brainstormer in its frame-first elicitation phase. You do NOT draft a spec yet. Your job is to (1) restate the user's request in your OWN words and (2) propose importance-ranked clarifying questions that, once answered, would let a downstream spec be written without guessing.

Rules:
- Read the codebase as needed (Read/Glob/Grep) to ground your understanding before restating.
- Restatement MUST be a paraphrase in your own words — do NOT echo the user's input verbatim.
- Cite concrete repo evidence (file references) for any claim you make about existing code; put these in restatement.evidence.
- Explicitly enumerate what you could NOT determine or had to guess in restatement.unknowns. Be honest — an empty unknowns list claims total certainty.
- Each question carries the premise (the assumption motivating it), a category, and an importance score (higher = more decision-critical). Categories: ambiguity, boundary, non-goal, failure-scenario, inconsistency-challenge.
- Self-scale the number of questions to the request: a trivial, unambiguous request warrants few or ZERO questions; a large or ambiguous one warrants more. Do not pad with low-value questions to fill a quota.
- Report your honest assessedComplexity (trivial | small | medium | large) judged from the prose and the repo.
- Do NOT write any files, do NOT draft a spec, do NOT write to stdout — return only structured output.`;

const PROPOSE_QUESTIONS_JSON_SCHEMA = proposeQuestionsSchema;

// System prompt for the adaptive multi-round follow-up elicitation path (the
// rounds AFTER round 1). Single-purpose: it judges whether the prior answers
// opened NEW decision-critical questions, NOT re-drafting the whole framing.
// Deliberately carries NO round-count or verbosity literal — both are per-call
// style values woven into the user prompt by buildProposeFollowupsPrompt.
const PROPOSE_FOLLOWUPS_SYSTEM_PROMPT = `You are a Harness Brainstormer in its follow-up elicitation phase. You have already restated the user's request and asked at least one round of clarifying questions, and the user has answered them. You do NOT draft a spec yet. Your job is to judge whether those answers opened NEW decision-critical questions and, if so, propose the next round.

Rules:
- Read the codebase as needed (Read/Glob/Grep) to ground your judgement in the actual repo.
- Weigh the prior answers: only ask a NEW question when an answer revealed a fresh ambiguity, boundary, non-goal, failure-scenario, or inconsistency that a spec still could not be written around. Do NOT re-ask anything already answered, and do NOT pad to fill a quota.
- Set done=true when the accumulated answers are sufficient to draft a spec without guessing; in that case return an EMPTY questions list.
- When not done, return importance-ranked questions (higher = more decision-critical), each carrying the premise (the assumption motivating it) and a category. Categories: ambiguity, boundary, non-goal, failure-scenario, inconsistency-challenge.
- ALWAYS return integrationNote: a one-line restatement, in your own words, of your UPDATED understanding given the prior answers. It is informational only — the user corrects it via the next round's answers, not by confirming/rejecting it.
- Do NOT write any files, do NOT draft a spec, do NOT write to stdout — return only structured output.`;

const PROPOSE_FOLLOWUPS_JSON_SCHEMA = followupQuestionsSchema;

// Fixed per-complexity follow-up-round policy (rounds AFTER round 1). This is
// the LOCKED internal ceiling map; the user-facing throttle is style.maxRounds.
// Lives here (a code constant in the pure helper) — never in prompt text.
const ROUND_CEILING_MAP = { trivial: 0, small: 0, medium: 1, large: 2 };

/**
 * Resolve the question-phrasing verbosity from a style object, falling back to
 * the config default when style / questionVerbosity is absent. Threaded as a
 * data value (like maxQuestions) into both buildProposeQuestionsPrompt and
 * buildProposeFollowupsPrompt — never welded into the core prompt text.
 *
 * @param {{questionVerbosity?: string}} [style]
 * @returns {string}
 */
export function resolveQuestionVerbosity(style) {
  return style && typeof style.questionVerbosity === 'string'
    ? style.questionVerbosity
    : config.elicitation.questionVerbosity;
}

/**
 * Resolve the follow-up-round ceiling from the round-1 assessedComplexity and a
 * style object. Pure function — the one unit-testable home of the round policy.
 *
 * effectiveCeiling = maxRounds === 0 ? 0 : min(map[assessedComplexity], maxRounds)
 *
 * over the fixed map {trivial:0, small:0, medium:1, large:2}. `maxRounds` (the
 * user-facing throttle/disable) falls back to config.elicitation.maxRounds. An
 * unknown / absent complexity maps to 0 (no follow-up rounds).
 *
 * @param {string} assessedComplexity - The round-1 complexity tier
 * @param {{maxRounds?: number}} [style]
 * @returns {number}
 */
export function resolveRoundCeiling(assessedComplexity, style) {
  const maxRounds = style && typeof style.maxRounds === 'number'
    ? style.maxRounds
    : config.elicitation.maxRounds;
  if (maxRounds === 0) return 0;
  const mapped = ROUND_CEILING_MAP[assessedComplexity] ?? 0;
  return Math.min(mapped, maxRounds);
}

/**
 * Build the user prompt for the adaptive follow-up elicitation phase.
 *
 * Pure function (no I/O). The question-count ceiling and the verbosity are
 * injected from the style object as data — never hardcoded as literals in the
 * core prompt text. `priorQA` is the accumulated [{ question, answer }] array;
 * `restatement` is the round-1 restatement object.
 *
 * @param {object} params
 * @param {string} params.userInput
 * @param {{paraphrase?: string}} [params.restatement] - Round-1 restatement
 * @param {Array<{question: string, answer: string}>} [params.priorQA]
 * @param {{maxQuestions?: number, questionVerbosity?: string}} params.style
 * @returns {string}
 */
export function buildProposeFollowupsPrompt({ userInput, restatement, priorQA, style }) {
  const cap = resolveMaxQuestions(style);
  const verbosity = resolveQuestionVerbosity(style);

  const paraphrase = restatement && typeof restatement === 'object'
    ? (restatement.paraphrase ?? '(no paraphrase)')
    : '(no paraphrase)';

  // Carry the round-1 evidence (the repo files already located) so the follow-up
  // agent reads them directly instead of re-running Glob/Grep to rediscover the
  // same files — saves duplicated I/O + token spend on every follow-up round.
  const evidence = restatement && Array.isArray(restatement.evidence) && restatement.evidence.length > 0
    ? restatement.evidence.map((e) => `- ${e}`).join('\n')
    : '(none recorded)';

  const priorQASection = Array.isArray(priorQA) && priorQA.length > 0
    ? priorQA.map((a, i) => `${i + 1}. Q: ${a.question}\n   A: ${a.answer}`).join('\n')
    : '(no prior answers)';

  return [
    `## Follow-up elicitation`,
    '',
    `You previously framed this request and asked clarifying questions. Given the answers below, judge whether NEW decision-critical questions opened. If they did, propose the next round; otherwise report done.`,
    '',
    `### Original request`,
    userInput || '(no input provided)',
    '',
    `### Your prior restatement`,
    paraphrase,
    '',
    `### Repo evidence you already located (read these directly; do not re-search the tree)`,
    evidence,
    '',
    `### Answers so far`,
    priorQASection,
    '',
    `### Constraints on your output`,
    '',
    `- Return at most ${cap} new questions. If no NEW decision-critical question opened, set done=true and return an empty questions list.`,
    `- Order questions by importance (most decision-critical first).`,
    `- ${verbosity === 'terse' ? 'Phrase questions and the integration note as tersely as possible.' : 'Phrase questions and the integration note clearly and completely.'}`,
    `- Ground claims about existing code in repo evidence (file references).`,
    `- integrationNote must be a one-line restatement of your updated understanding (informational only).`,
  ].join('\n');
}

/**
 * Resolve the clarifying-question ceiling from a style object, falling back to
 * the config default when style / maxQuestions is absent. Single source of the
 * cap policy — shared by buildProposeQuestionsPrompt, proposeQuestions, and the
 * CLI runElicitation (avoids the copy-pasted ternary).
 *
 * @param {{maxQuestions?: number}} [style]
 * @returns {number}
 */
export function resolveMaxQuestions(style) {
  return style && typeof style.maxQuestions === 'number'
    ? style.maxQuestions
    : config.elicitation.maxQuestions;
}

/**
 * Rank a question list by importance DESCENDING and truncate to `cap`, reporting
 * how many were dropped. Single home for the rank-then-cap idiom shared by
 * proposeQuestions, proposeFollowups, and the CLI's defensive re-cap, so the
 * ordering + cap semantics can never drift between round 1 and follow-up rounds.
 * `importance` is coerced via Number: validateStructured has no number branch,
 * so a non-numeric importance must not poison the sort with NaN and silently
 * drop the most decision-critical question — the same defensive posture the loop
 * takes with its strict `done === true` check for the missing boolean branch.
 *
 * @param {Array<{importance?: number}>} questions
 * @param {number} cap
 * @returns {{ ranked: Array, omittedCount: number }}
 */
export function rankAndCap(questions, cap) {
  const list = Array.isArray(questions) ? [...questions] : [];
  const ranked = list
    .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0))
    .slice(0, cap);
  return { ranked, omittedCount: Math.max(0, list.length - cap) };
}

/**
 * Build the user prompt for the propose-questions (frame-first) phase.
 *
 * Pure function (no I/O). The question-count ceiling is injected from
 * `style.maxQuestions` as data — never hardcoded as a literal in the core
 * prompt text. `correction` carries an optional user restatement/correction
 * (the reject-and-restate / partially-correct escape hatch) to re-anchor a
 * re-run.
 *
 * @param {object} params
 * @param {string} params.userInput
 * @param {string} [params.correction] - User's correction to fold into the framing
 * @param {{maxQuestions: number}} params.style
 * @returns {string}
 */
export function buildProposeQuestionsPrompt({ userInput, correction, style }) {
  const cap = resolveMaxQuestions(style);
  const verbosity = resolveQuestionVerbosity(style);

  const correctionSection = correction && correction.trim()
    ? `
### User correction to your framing

The user reviewed an earlier restatement and corrected it as follows. Treat this correction as authoritative and re-anchor your understanding accordingly:

${correction}
`
    : '';

  return [
    `## Frame-first elicitation`,
    '',
    `Restate the request below in your own words, then propose clarifying questions whose answers would remove ambiguity before a spec is drafted.`,
    '',
    `### User request`,
    userInput || '(no input provided)',
    correctionSection,
    `### Constraints on your output`,
    '',
    `- Return at most ${cap} questions. If fewer are genuinely needed, return fewer (a trivial request may warrant zero).`,
    `- Order questions by importance (most decision-critical first).`,
    `- ${verbosity === 'terse' ? 'Phrase each question as tersely as possible.' : 'Phrase each question clearly and completely.'}`,
    `- Ground claims about existing code in repo evidence (file references).`,
  ].join('\n');
}

const VALID_REVISE_MODES = new Set(['regenerate', 'edit', 'append']);

class Brainstormer {
  constructor(sessionManager, logger, tokenTracker) {
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.tokenTracker = tokenTracker;
  }

  /**
   * Frame-first elicitation: restate the user's request in the agent's own
   * words and propose importance-ranked clarifying questions, WITHOUT drafting
   * a spec. Spawns a brainstormer agent (Read/Glob/Grep) with the
   * propose-questions schema, validates the structured output (throws on
   * invalid, mirroring extractBrainstormResult), then sorts questions by
   * importance DESCENDING and truncates to style.maxQuestions.
   *
   * @param {string} userInput
   * @param {object} [opts]
   * @param {{maxQuestions: number}} [opts.style] - Resolved style; defaults to config.elicitation
   * @param {string} [opts.correction] - User correction folded into the framing (re-run escape hatch)
   * @returns {Promise<{ restatement: {paraphrase: string, evidence: string[], unknowns: string[]}, questions: Array<{id: string, question: string, premise: string, category: string, importance: number}>, assessedComplexity: string, omittedCount: number }>}
   */
  /**
   * Shared spawn scaffold for the two elicitation agents (proposeQuestions and
   * proposeFollowups). Both turns are byte-identical except for the prompt,
   * system prompt, schema, mode label, and extractor — so the spawn →
   * attachToSession → record-usage-BEFORE-extract → summary ordering lives here
   * ONCE. The record-before-extract ordering is contract-critical (a failed
   * turn's brainstormer spend must still land in token accounting even when the
   * extractor throws BRAINSTORM_VALIDATION_FAILED); keeping it in one place stops
   * the two callers from drifting out of lockstep.
   *
   * @param {object} params
   * @param {string} params.namePrefix - Session-name prefix (e.g. 'propose')
   * @param {string} params.mode - Role/mode label for logs + token accounting
   * @param {string} params.prompt
   * @param {string} params.systemPrompt
   * @param {object} params.jsonSchema
   * @param {(result: object, opts: {warn: function}) => any} params.extract - Pure extractor (throws on invalid)
   * @returns {Promise<any>} The extractor's validated output
   */
  async _spawnElicitationAgent({ namePrefix, mode, prompt, systemPrompt, jsonSchema, extract }) {
    const name = `brainstormer-${namePrefix}-${Date.now()}`;
    const log = this.logger.createSessionLog(name);
    try {
      const spawnPromise = this.sessionManager.spawn({
        name,
        prompt,
        systemPrompt,
        model: config.execution.brainstormerModel,
        agent: 'brainstormer',
        tools: ['Read', 'Glob', 'Grep'],
        jsonSchema,
        maxBudget: config.budgets.brainstormer,
        cwd: process.cwd() ?? projectRoot,
      });

      this.logger.attachToSession(spawnPromise.handle, log, { role: 'brainstormer', mode });

      const { handle, result } = await spawnPromise;

      // Record usage BEFORE extraction can throw (the extractor throws
      // BRAINSTORM_VALIDATION_FAILED on missing/invalid output), so a failed
      // elicitation turn's brainstormer spend is not dropped from token
      // accounting — same principle as the planner reusable-turn usage fix.
      await this.tokenTracker?.recordSession(name, 'brainstormer', result, {
        mode,
        systemPromptTokens: handle.systemPromptTokens,
        toolCallCount: handle._toolCallCount,
      });

      const extracted = extract(result, { warn: (m) => this.logger.warn(m) });

      const summary = this.logger.getSessionSummary(log.logPath);
      await this.logger.writeSessionSummary(name, summary, { role: 'brainstormer', mode });

      return extracted;
    } finally {
      log.close();
    }
  }

  async proposeQuestions(userInput, opts = {}) {
    const style = opts.style ?? config.elicitation;
    const correction = opts.correction;

    const { restatement, questions, assessedComplexity } = await this._spawnElicitationAgent({
      namePrefix: 'propose',
      mode: 'propose-questions',
      prompt: buildProposeQuestionsPrompt({ userInput, correction, style }),
      systemPrompt: PROPOSE_QUESTIONS_SYSTEM_PROMPT,
      jsonSchema: PROPOSE_QUESTIONS_JSON_SCHEMA,
      extract: extractProposeQuestionsResult,
    });

    // Rank by importance DESC + apply the hard per-call cap (the agent
    // self-scales the count; this truncation is non-negotiable). omittedCount is
    // the single capping home's disclosure signal — how many ranked questions
    // were dropped — so the CLI surfaces "asked top N; M omitted" instead of
    // silently swallowing it.
    const { ranked, omittedCount } = rankAndCap(questions, resolveMaxQuestions(style));

    return { restatement, questions: ranked, assessedComplexity, omittedCount };
  }

  /**
   * Adaptive follow-up elicitation (the rounds AFTER round 1). Given the
   * original input, the round-1 restatement, and all Q&A collected so far,
   * spawns a brainstormer agent that judges whether the prior answers opened
   * NEW decision-critical questions. Mirrors proposeQuestions'
   * spawn/validate/rank/cap structure (record-usage-before-extract ordering,
   * importance-DESC sort + style.maxQuestions cap, omittedCount disclosure).
   *
   * Returns { done, integrationNote, questions, omittedCount }. The CLI loop
   * compares `done === true` strictly (validateStructured has no boolean
   * branch). On invalid/absent output this throws (mirroring
   * extractProposeQuestionsResult); the CLI's graceful-degrade catch decides to
   * stop the loop and draft from the Q&A so far.
   *
   * @param {string} userInput
   * @param {{paraphrase: string, evidence: string[], unknowns: string[]}} restatement - Round-1 restatement
   * @param {Array<{question: string, answer: string}>} priorQA - Accumulated Q&A so far
   * @param {object} [opts]
   * @param {{maxQuestions?: number, questionVerbosity?: string}} [opts.style] - Resolved style; defaults to config.elicitation
   * @returns {Promise<{ done: boolean, integrationNote: string, questions: Array<{id: string, question: string, premise: string, category: string, importance: number}>, omittedCount: number }>}
   */
  async proposeFollowups(userInput, restatement, priorQA, opts = {}) {
    const style = opts.style ?? config.elicitation;

    const { done, integrationNote, questions } = await this._spawnElicitationAgent({
      namePrefix: 'followups',
      mode: 'propose-followups',
      prompt: buildProposeFollowupsPrompt({ userInput, restatement, priorQA, style }),
      systemPrompt: PROPOSE_FOLLOWUPS_SYSTEM_PROMPT,
      jsonSchema: PROPOSE_FOLLOWUPS_JSON_SCHEMA,
      extract: extractFollowupsResult,
    });

    // Rank + apply the same hard per-round cap as round 1. The cap is per-round
    // (NOT a shared cross-round budget); omittedCount lets the CLI disclose the
    // truncation for this round.
    const { ranked, omittedCount } = rankAndCap(questions, resolveMaxQuestions(style));

    return { done, integrationNote, questions: ranked, omittedCount };
  }

  async initialize(userInput, opts = {}) {
    const { answers, correction, withDigest } = opts;
    const ts = Date.now();
    const name = `brainstormer-init-${ts}`;
    // When opts is absent/empty (no answers, no correction, no withDigest),
    // buildBrainstormerPrompt produces a byte-identical prompt to the legacy
    // single-arg path and the wrapper schema is the legacy two-key schema — the
    // batch / non-TTY behavior is unchanged. withDigest (TTY path only) opts in
    // to the additive digest section + digest-including schema.
    const prompt = buildBrainstormerPrompt({ mode: 'initialize', userInput, answers, correction, withDigest });
    const jsonSchema = withDigest ? BRAINSTORM_JSON_SCHEMA_WITH_DIGEST : BRAINSTORM_JSON_SCHEMA;
    const systemPrompt = BRAINSTORMER_SYSTEM_PROMPT;

    const log = this.logger.createSessionLog(name);
    try {
      const spawnPromise = this.sessionManager.spawn({
        name,
        prompt,
        systemPrompt,
        model: config.execution.brainstormerModel,
        agent: 'brainstormer',
        tools: ['Read', 'Glob', 'Grep'],
        jsonSchema,
        maxBudget: config.budgets.brainstormer,
        cwd: process.cwd() ?? projectRoot,
      });

      this.logger.attachToSession(spawnPromise.handle, log, { role: 'brainstormer', mode: 'initialize' });

      const { handle, result } = await spawnPromise;

      const { spec, specMd, digest } = extractBrainstormResult(result, { warn: (m) => this.logger.warn(m) });

      const summary = this.logger.getSessionSummary(log.logPath);
      await this.logger.writeSessionSummary(name, summary, {
        role: 'brainstormer',
        mode: 'initialize',
      });
      await this.tokenTracker?.recordSession(name, 'brainstormer', result, {
        mode: 'initialize',
        systemPromptTokens: handle.systemPromptTokens,
        toolCallCount: handle._toolCallCount,
      });

      const warning = checkScopeComplexity(spec);
      if (warning) {
        const patched = applySplitRecommendation({ spec, specMd }, warning);
        return { spec: patched.spec, specMd: patched.specMd, digest, sessionMeta: { sessionId: handle.sessionId ?? null, mode: 'initialize' } };
      }

      return { spec, specMd, digest, sessionMeta: { sessionId: handle.sessionId ?? null, mode: 'initialize' } };
    } finally {
      log.close();
    }
  }

  async revise(currentSpec, feedback, mode, opts = {}) {
    if (!VALID_REVISE_MODES.has(mode)) {
      const err = new Error(`Invalid brainstormer mode: ${mode}`);
      err.code = 'BRAINSTORM_INVALID_MODE';
      throw err;
    }

    const { withDigest } = opts;
    const ts = Date.now();
    const name = `brainstormer-${mode}-${ts}`;
    // When called with 3 args (no opts) withDigest is undefined → prompt and
    // wrapper schema are byte-identical to the legacy path. withDigest (TTY
    // path) opts in to the additive digest section + digest-including schema.
    const prompt = buildBrainstormerPrompt({ mode, currentSpec, feedback, withDigest });
    const jsonSchema = withDigest ? BRAINSTORM_JSON_SCHEMA_WITH_DIGEST : BRAINSTORM_JSON_SCHEMA;
    const systemPrompt = BRAINSTORMER_SYSTEM_PROMPT;

    const log = this.logger.createSessionLog(name);
    try {
      const spawnPromise = this.sessionManager.spawn({
        name,
        prompt,
        systemPrompt,
        model: config.execution.brainstormerModel,
        agent: 'brainstormer',
        tools: ['Read', 'Glob', 'Grep'],
        jsonSchema,
        maxBudget: config.budgets.brainstormer,
        cwd: process.cwd() ?? projectRoot,
      });

      this.logger.attachToSession(spawnPromise.handle, log, { role: 'brainstormer', mode });

      const { handle, result } = await spawnPromise;

      const { spec, specMd, digest } = extractBrainstormResult(result, { warn: (m) => this.logger.warn(m) });

      const summary = this.logger.getSessionSummary(log.logPath);
      await this.logger.writeSessionSummary(name, summary, {
        role: 'brainstormer',
        mode,
      });
      await this.tokenTracker?.recordSession(name, 'brainstormer', result, {
        mode,
        systemPromptTokens: handle.systemPromptTokens,
        toolCallCount: handle._toolCallCount,
      });

      const warning = checkScopeComplexity(spec);
      if (warning) {
        const patched = applySplitRecommendation({ spec, specMd }, warning);
        return { spec: patched.spec, specMd: patched.specMd, digest, sessionMeta: { sessionId: handle.sessionId ?? null, mode } };
      }

      return { spec, specMd, digest, sessionMeta: { sessionId: handle.sessionId ?? null, mode } };
    } finally {
      log.close();
    }
  }
}

export { Brainstormer };
