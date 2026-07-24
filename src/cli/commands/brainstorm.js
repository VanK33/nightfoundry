/**
 * brainstorm.js — CLI command and utilities for the Brainstorm workflow.
 *
 * Public API (full 11-export surface — implemented across multiple tasks):
 *
 *   // Task 001-003-001-001 (this file, pure helpers):
 *     generateSlug(prose)
 *     resolveSlugCollision(brainstormRoot, baseSlug)
 *     hashSpec(spec)
 *     getBrainstormDir(projectRoot, slug)
 *
 *   // Task 001-003-001-002 (spec I/O):
 *     loadSpec(specPath)
 *     saveSpec(dir, spec)
 *     loadResult(dir)
 *
 *   // Task 001-003-001-003 (session wiring):
 *     runBrainstormer(spec, opts)
 *     saveBrainstormResult(dir, result)
 *
 *   // Task 001-003-001-004 (CLI entry-point):
 *     brainstorm(projectRoot, opts)
 *     brainstormStatus(projectRoot)
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
import config from '../../orchestrator/infra/config.js';
import { Brainstormer, resolveMaxQuestions, resolveRoundCeiling, rankAndCap } from '../../orchestrator/agents/brainstormer.js';
import { harnessRoot } from '../../orchestrator/core/run-context.js';

/**
 * Wrap an async function with a progress ticker that prints elapsed-time
 * markers to `output`.
 *
 * Behaviour:
 *   1. Immediately prints `[<label>] thinking...`
 *   2. Arms a setInterval (every 5 s) that prints `[<label>] thinking... <N>s`
 *   3. Awaits `asyncFn()`
 *   4. In a finally block: calls clearInterval + prints `[<label>] done in <N>s`
 *   5. Returns the resolved value of asyncFn (re-throws on rejection)
 *
 * clearInterval is called on every exit path (success, throw, and SIGINT via
 * the registered SIGINT handler that clears before re-raising).
 *
 * @param {NodeJS.WritableStream} output
 * @param {string}                label
 * @param {() => Promise<*>}      asyncFn
 * @returns {Promise<*>}
 */
export async function withProgressTicker(output, label, asyncFn) {
  const startTime = Date.now();
  output.write(`[${label}] thinking...\n`);

  let timerId = null;

  // SIGINT handler so clearInterval is called even when the user presses Ctrl-C
  const onSigint = () => {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
    process.removeListener('SIGINT', onSigint);
    process.kill(process.pid, 'SIGINT');
  };
  process.on('SIGINT', onSigint);

  timerId = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    output.write(`[${label}] thinking... ${elapsed}s\n`);
  }, 5000);

  try {
    const result = await asyncFn();
    return result;
  } finally {
    clearInterval(timerId);
    timerId = null;
    process.removeListener('SIGINT', onSigint);
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    output.write(`[${label}] done in ${elapsed}s\n`);
  }
}

/**
 * Convert arbitrary prose into a URL/filesystem-safe slug.
 *
 * Rules:
 *   - Lowercase and trim
 *   - Replace any run of non-[a-z0-9] characters with a single '-'
 *   - Strip leading/trailing '-'
 *   - Truncate at hyphen-segment (word) boundaries: at most 50 characters
 *     AND at most 6 segments, never leaving a trailing '-'. A single
 *     segment longer than 50 chars is hard-sliced to 50 (no boundary to cut at).
 *   - Empty or whitespace-only input returns 'untitled'
 *
 * @param {string} prose
 * @returns {string}
 */
export function parseActionInput(raw) {
  const trimmed = (raw || '').trim();
  const spaceIdx = trimmed.search(/\s/);
  if (spaceIdx === -1) {
    return { key: trimmed.toLowerCase(), inlineArg: '' };
  }
  const key = trimmed.slice(0, spaceIdx).toLowerCase();
  const inlineArg = trimmed.slice(spaceIdx).trimStart();
  return { key, inlineArg };
}

export function generateSlug(prose) {
  if (!prose || !prose.trim()) return 'untitled';

  let slug = prose
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) return 'untitled';

  // Truncate at hyphen-segment (word) boundaries: keep whole segments while
  // the joined slug stays within 50 chars, capped at 6 segments.
  const segments = slug.split('-');
  const kept = [];
  for (const segment of segments) {
    if (kept.length >= 6) break;
    const candidate = kept.length === 0 ? segment : `${kept.join('-')}-${segment}`;
    if (candidate.length > 50) break;
    kept.push(segment);
  }
  // Degenerate case: the first segment alone exceeds 50 chars — no word
  // boundary exists within the cap, so hard-slice it (cannot leave a dash).
  slug = kept.length > 0 ? kept.join('-') : segments[0].slice(0, 50);

  return slug || 'untitled';
}

/**
 * Resolve slug collisions by probing the filesystem.
 *
 * If `<brainstormRoot>/<baseSlug>` does not exist, returns `baseSlug`.
 * Otherwise probes `<baseSlug>-1`, `<baseSlug>-2`, … and returns the
 * first non-existing suffix.
 *
 * @param {string} brainstormRoot  Absolute path to the brainstorm directory
 * @param {string} baseSlug
 * @returns {string}
 */
export function resolveSlugCollision(brainstormRoot, baseSlug) {
  if (!fs.existsSync(path.join(brainstormRoot, baseSlug))) {
    return baseSlug;
  }

  let counter = 1;
  while (fs.existsSync(path.join(brainstormRoot, `${baseSlug}-${counter}`))) {
    counter++;
  }

  return `${baseSlug}-${counter}`;
}

/**
 * Produce a deterministic content hash of a spec object.
 *
 * Keys are sorted recursively before serialisation so that two objects
 * with identical content but different key insertion order hash identically.
 *
 * @param {object} spec
 * @returns {string}  e.g. 'sha256:a3f1b2c4d5e6f708'
 */
export function hashSpec(spec) {
  const sorted = sortedKeys(spec);
  const json = JSON.stringify(sorted);
  const hex = crypto.createHash('sha256').update(json).digest('hex');
  return `sha256:${hex.slice(0, 16)}`;
}

/**
 * Recursively sort object keys alphabetically for deterministic serialisation.
 * Arrays and primitives are returned as-is (array elements are recursed).
 *
 * @param {*} value
 * @returns {*}
 */
function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortedKeys(value[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Return the canonical brainstorm session directory for a given slug.
 *
 * Pure path construction — no filesystem access.
 *
 * @param {string} projectRoot  Absolute project root
 * @param {string} slug
 * @returns {string}
 */
export function getBrainstormDir(projectRoot, slug) {
  return path.join(harnessRoot(projectRoot), 'brainstorm', slug);
}

/**
 * Write spec.json and spec.md into `dir`.
 * `dir` must already exist (created by the caller).
 *
 * @param {string} dir      Absolute path to the brainstorm session directory
 * @param {object} spec     Spec object — serialised as pretty JSON
 * @param {string} specMd   Markdown string written verbatim
 */
export function writeBundle(dir, spec, specMd) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  fs.writeFileSync(path.join(dir, 'spec.md'), specMd);
}

/**
 * Keep the digest.json sidecar in sync with the CURRENT spec.
 *
 * The digest is a per-spec, transient sidecar: it is NEVER copied to the project
 * root and NEVER fed to the planner (Phase III boundary). A draft/revise turn
 * either produces a digest (TTY withDigest path) or none, and the sidecar must
 * reflect the latest turn — never a stale digest describing a superseded spec.
 *
 *   - digest present  → write it.
 *   - digest absent (null/undefined) → remove an existing digest.json, if any,
 *     so no stale sidecar survives.
 *
 * @param {string} dir                      Absolute path to the brainstorm session directory
 * @param {object|null|undefined} digest    The { scopeOut, assumptions, risks } digest, or none
 */
export function syncDigest(dir, digest) {
  fs.mkdirSync(dir, { recursive: true });
  const digestPath = path.join(dir, 'digest.json');
  if (digest !== undefined && digest !== null) {
    fs.writeFileSync(digestPath, JSON.stringify(digest, null, 2));
  } else if (fs.existsSync(digestPath)) {
    fs.rmSync(digestPath);
  }
}

/**
 * Read and parse the digest.json sidecar from the brainstorm session directory.
 *
 * @param {string} dir  Absolute path to the brainstorm session directory
 * @returns {object|undefined}  The parsed digest, or undefined when absent/unreadable.
 */
export function readDigest(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'digest.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Append one JSONL entry to `<dir>/history.jsonl`.
 *
 * The caller is responsible for supplying all fields; this helper is
 * intentionally stateless so tests can call it deterministically.
 *
 * Telemetry fields (questionCount, answerCount, roundCount, questionsPerRound,
 * assumptionCount, complexityTier) are optional and recorded by the brainstorm()
 * caller on the TTY path for later correlation with downstream noise; the helper
 * persists whatever entry it is given verbatim. questionCount / answerCount are
 * cross-round totals; roundCount is the total rounds run INCLUDING round 1;
 * questionsPerRound is the per-round question counts (index 0 = round 1).
 *
 * @param {string} dir
 * @param {{ turn: number, ts: string, mode: 'initialize'|'regenerate'|'edit'|'append', input: string, specHash: string, questionCount?: number, answerCount?: number, roundCount?: number, questionsPerRound?: number[], assumptionCount?: number, complexityTier?: string }} entry
 */
export function appendHistory(dir, entry) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'history.jsonl'), JSON.stringify(entry) + '\n');
}

/**
 * Read and parse `<dir>/state.json`.
 *
 * @param {string} dir
 * @returns {object|null}  Parsed state object, or null if the file does not exist.
 * @throws {SyntaxError}  If the file exists but contains malformed JSON.
 */
export function readState(dir) {
  const stateFile = path.join(dir, 'state.json');
  if (!fs.existsSync(stateFile)) {
    return null;
  }
  const raw = fs.readFileSync(stateFile, 'utf8');
  return JSON.parse(raw);
}

/**
 * Write `state` to `<dir>/state.json`.
 *
 * @param {string} dir
 * @param {{ slug: string, createdAt: string, lastUpdatedAt: string, status: 'in-progress'|'approved'|'cancelled' }} state
 */
export function writeState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

/**
 * Copy spec.json and spec.md from the brainstorm session directory to the
 * project root.  Throws with a clear message if either source file is missing.
 *
 * @param {string} projectRoot  Destination directory (the project root)
 * @param {string} dir          Source brainstorm session directory
 * @param {string} slug         Brainstorm session slug used to name output files
 */
export function copyApprovedToProjectRoot(projectRoot, dir, slug) {
  const srcJson = path.join(dir, 'spec.json');
  const srcMd   = path.join(dir, 'spec.md');

  if (!fs.existsSync(srcJson)) {
    throw new Error(`copyApprovedToProjectRoot: source file not found: ${srcJson}`);
  }
  if (!fs.existsSync(srcMd)) {
    throw new Error(`copyApprovedToProjectRoot: source file not found: ${srcMd}`);
  }

  fs.copyFileSync(srcJson, path.join(projectRoot, `${slug}.spec.json`));
  fs.copyFileSync(srcMd,   path.join(projectRoot, `${slug}.spec.md`));
}

/**
 * Thin factory that instantiates a Brainstormer with the given dependencies.
 * Exists so CLI entry functions (and tests) can inject a stub via
 * `opts.brainstormerFactory`.
 *
 * @param {{ sessionManager, logger, tokenTracker }} deps
 * @returns {Brainstormer}
 */
export function buildBrainstormer({ sessionManager, logger, tokenTracker }) {
  return new Brainstormer(sessionManager, logger, tokenTracker);
}

/**
 * Print the interactive menu to the output stream.
 *
 * @param {NodeJS.WritableStream} output
 */
function printMenu(output) {
  output.write(
    [
      '',
      '┌─ Brainstorm Menu ─────────────────────────────────┐',
      '│  a = accept   r = regenerate   e = edit           │',
      '│  c = cancel   d = diff/view    h = help           │',
      '└───────────────────────────────────────────────────┘',
      '',
    ].join('\n'),
  );
}

/**
 * Print an expanded help block explaining all interactive commands.
 * Ends by calling printMenu(output) so the short menu still appears after.
 * @param {NodeJS.WritableStream} output
 * @param {string} slug - The current brainstorm session slug
 */
export function printHelp(output, slug) {
  output.write(
    [
      '',
      '┌─ Brainstorm Help ──────────────────────────────────────────────────────┐',
      '│                                                                        │',
      '│  r  — Regenerate spec with feedback                                   │',
      '│       • bare `r`  → sub-prompts you for feedback before regenerating  │',
      '│       • `r <feedback>`  → sends inline feedback immediately           │',
      '│                                                                        │',
      '│  e  — Edit a specific field inline                                    │',
      '│       Syntax: e <field> <new value>                                   │',
      '│       Editable fields include: goal, scope, constraints, tasks, etc.  │',
      '│       Example: e goal improve caching performance                     │',
      '│                                                                        │',
      '│  a  — Accept the current spec                                         │',
      '│       Writes <slug>.spec.json and <slug>.spec.md to the project root. │',
      '│       Use this when the spec is ready for execution.                  │',
      '│                                                                        │',
      '│  c  — Cancel this brainstorm session                                  │',
      '│       Draft files are kept — nothing is deleted.                      │',
      '│       You can resume later using the --resume flag.                   │',
      '│                                                                        │',
      `│  Resume: cc-orch brainstorm --resume ${slug.padEnd(34)}│`,
      `│  Draft location: ~/.cc-orch/brainstorm/${slug.padEnd(32)}│`,
      '│                                                                        │',
      '└────────────────────────────────────────────────────────────────────────┘',
      '',
    ].join('\n'),
  );
  printMenu(output);
}

/**
 * Print a turn separator line to signal the end of a turn.
 * @param {NodeJS.WritableStream} output
 */
function printTurnSeparator(output) {
  output.write(`\n${'─'.repeat(60)}\nDone. Ready for next action.\n`);
}

/**
 * Print a preview of the spec markdown to the output stream.
 * When specMd is <= 2000 chars, writes the full content wrapped in delimiters.
 * When specMd is > 2000 chars, writes a structured summary with the first
 * heading, first non-empty paragraph, and total line count.
 *
 * @param {NodeJS.WritableStream} output
 * @param {string} specMd
 */
export function printSpecPreview(output, specMd) {
  if (specMd.length <= 2000) {
    output.write('\n--- Spec Preview ---\n');
    output.write(specMd);
    output.write('\n--------------------\n');
  } else {
    const lines = specMd.split('\n');
    const totalLines = lines.length;

    // Find first markdown heading
    const headingIndex = lines.findIndex((l) => /^#+\s/.test(l));
    const heading = headingIndex !== -1 ? lines[headingIndex] : '';

    // Find first non-empty paragraph after the heading
    let paragraph = '';
    const searchFrom = headingIndex !== -1 ? headingIndex + 1 : 0;
    let paragraphLines = [];
    let inParagraph = false;
    for (let i = searchFrom; i < lines.length; i++) {
      const line = lines[i];
      if (!inParagraph) {
        if (line.trim() !== '') {
          inParagraph = true;
          paragraphLines.push(line);
        }
      } else {
        if (line.trim() === '') {
          break;
        }
        paragraphLines.push(line);
      }
    }
    paragraph = paragraphLines.join('\n');

    output.write(`\n--- Spec Preview (summary, ${totalLines} lines) ---\n`);
    if (heading) output.write(heading + '\n');
    if (paragraph) output.write(paragraph + '\n');
    output.write('...\n');
    output.write('--------------------\n');
  }
}

/**
 * Render a one-page understanding-playback digest as a string.
 *
 * Pure function (no I/O). The spec-derived sections (GOAL, SCOPE — IN, each
 * ACCEPTANCE CRITERION + how it is verified) come from `spec`; the digest-only
 * sections (SCOPE — OUT, ASSUMPTIONS, RISKS) come from the `digest` channel.
 * Verbosity is tuned by `style.digestVerbosity` ('terse' | 'normal') — never a
 * hardcoded literal — falling back to config.elicitation.digestVerbosity.
 *
 * Degrades gracefully when `digest` is null/undefined: the spec-derived sections
 * still render and the digest-only sections show "(none captured)".
 *
 * Layout:
 *   GOAL              — spec.goal
 *   SCOPE — IN        — spec.target_files + each acceptance_criteria description
 *   SCOPE — OUT       — digest.scopeOut
 *   ACCEPTANCE CRITERIA — each description paired with its verification
 *                       (kind + command/targetFile/manualSteps); 'terse' omits
 *                       the per-criterion verification detail
 *   ASSUMPTIONS       — digest.assumptions
 *   RISKS             — digest.risks
 *
 * @param {object} spec   The brainstorm spec object
 * @param {object|null|undefined} digest  { scopeOut, assumptions, risks }
 * @param {{ style?: { digestVerbosity?: 'terse'|'normal' } }} [opts]
 * @returns {string} The rendered one-page digest
 */
export function renderDigest(spec, digest, opts = {}) {
  const style = opts.style ?? config.elicitation;
  const verbosity = style?.digestVerbosity ?? config.elicitation.digestVerbosity;
  const terse = verbosity === 'terse';

  const goal = spec?.goal ?? '(no goal)';
  const targetFiles = Array.isArray(spec?.target_files) ? spec.target_files : [];
  const criteria = Array.isArray(spec?.acceptance_criteria) ? spec.acceptance_criteria : [];
  const scopeOut = Array.isArray(digest?.scopeOut) ? digest.scopeOut : [];
  const assumptions = Array.isArray(digest?.assumptions) ? digest.assumptions : [];
  const risks = Array.isArray(digest?.risks) ? digest.risks : [];

  const lines = [];
  lines.push('=== Understanding Digest ===');
  lines.push('');

  // GOAL
  lines.push('GOAL');
  lines.push(`  ${goal}`);
  // 'terse' omits the inter-section blank-line separators (see RISKS below).
  if (!terse) lines.push('');

  // SCOPE — IN: target files + each acceptance criterion description
  lines.push('SCOPE — IN');
  if (targetFiles.length === 0 && criteria.length === 0) {
    lines.push('  (none captured)');
  } else {
    for (const tf of targetFiles) lines.push(`  • ${tf}`);
    for (const c of criteria) lines.push(`  • ${c?.description ?? '(no description)'}`);
  }
  if (!terse) lines.push('');

  // SCOPE — OUT: digest-only
  lines.push('SCOPE — OUT');
  if (scopeOut.length === 0) {
    lines.push('  (none captured)');
  } else {
    for (const s of scopeOut) lines.push(`  • ${s}`);
  }
  if (!terse) lines.push('');

  // ACCEPTANCE CRITERIA: each description paired with how it is verified
  lines.push('ACCEPTANCE CRITERIA');
  if (criteria.length === 0) {
    lines.push('  (none captured)');
  } else {
    criteria.forEach((c, i) => {
      lines.push(`  ${i + 1}. ${c?.description ?? '(no description)'}`);
      // 'terse' omits the per-criterion verification detail.
      if (!terse) {
        const v = c?.verification;
        lines.push(`     verified: ${formatVerification(v)}`);
      }
    });
  }
  if (!terse) lines.push('');

  // ASSUMPTIONS: digest-only
  lines.push('ASSUMPTIONS');
  if (assumptions.length === 0) {
    lines.push('  (none captured)');
  } else {
    for (const a of assumptions) lines.push(`  • ${a}`);
  }
  if (!terse) lines.push('');

  // RISKS: digest-only
  lines.push('RISKS');
  if (risks.length === 0) {
    lines.push('  (none captured)');
  } else {
    for (const r of risks) lines.push(`  • ${r}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Format a single acceptance-criterion verification object into a one-line
 * human-readable string (kind + the kind-specific fields).
 *
 * @param {object|null|undefined} v
 * @returns {string}
 */
function formatVerification(v) {
  if (!v || typeof v !== 'object' || !v.kind) return '(no verification)';
  if (v.kind === 'command') {
    return `command — ${v.command ?? '(no command)'} (target: ${v.targetFile ?? 'n/a'})`;
  }
  if (v.kind === 'file-check') {
    return `file-check — ${v.targetFile ?? '(no targetFile)'}`;
  }
  if (v.kind === 'manual') {
    return `manual — ${v.manualSteps ?? '(no steps)'}`;
  }
  return v.kind;
}

/**
 * Print the explicit no-tty outcome block: draft directory, status,
 * criteria/target-file counts, spec.md path, and the next-step instruction
 * (`cc-orch brainstorm --resume <slug>` for interactive review/approve).
 *
 * Counts fall back to 0 when the spec is absent or malformed.
 *
 * @param {NodeJS.WritableStream} output
 * @param {{ dir: string, slug: string, status: string, spec: object|null }} info
 */
function printNoTtyOutcome(output, { dir, slug, status, spec }) {
  const criteriaCount = Array.isArray(spec?.acceptance_criteria) ? spec.acceptance_criteria.length : 0;
  const targetCount = Array.isArray(spec?.target_files) ? spec.target_files.length : 0;
  output.write(
    [
      '',
      'Brainstorm draft:',
      `  Draft dir: ${dir}`,
      `  Status:    ${status}`,
      `  Contents:  ${criteriaCount} acceptance criteria, ${targetCount} target file(s)`,
      `  Spec file: ${path.join(dir, 'spec.md')}`,
      '',
      `Next: cc-orch brainstorm --resume ${slug}   (interactive review & approve)`,
      '',
    ].join('\n'),
  );
}

/**
 * Create a line reader that buffers incoming lines so that sequential
 * `ask()` calls work correctly even when all input arrives at once (e.g.
 * in tests that push 'a\nb\nc\n' to a PassThrough stream before any
 * question is registered).
 *
 * Readline fires 'line' events immediately as data arrives. Without a
 * queue, lines that arrive before the next `rl.question()` call is
 * registered are silently dropped. This wrapper buffers them instead.
 *
 * @param {NodeJS.ReadableStream} inputStream
 * @param {NodeJS.WritableStream} outputStream
 * @returns {{ ask(question: string): Promise<string>, close(): void }}
 */
function createLineReader(inputStream, outputStream) {
  const rl = readline.createInterface({ input: inputStream, output: outputStream });
  const lineQueue = [];      // lines that arrived before ask() was called
  const resolveQueue = [];   // pending ask() promises waiting for a line

  rl.on('line', (raw) => {
    const line = (raw || '').trim();
    if (resolveQueue.length > 0) {
      resolveQueue.shift()(line);
    } else {
      lineQueue.push(line);
    }
  });

  return {
    ask(question) {
      outputStream.write(question);
      return new Promise((resolve) => {
        if (lineQueue.length > 0) {
          resolve(lineQueue.shift());
        } else {
          resolveQueue.push(resolve);
        }
      });
    },
    close() {
      rl.close();
    },
  };
}

/**
 * Render the agent's intent restatement (paraphrase + repo evidence +
 * enumerated unknowns) to the output stream, followed by the confirm /
 * reject-and-restate / partially-correct affordance legend.
 *
 * @param {NodeJS.WritableStream} output
 * @param {{paraphrase: string, evidence: string[], unknowns: string[]}} restatement
 */
export function renderRestatement(output, restatement) {
  const evidence = Array.isArray(restatement?.evidence) ? restatement.evidence : [];
  const unknowns = Array.isArray(restatement?.unknowns) ? restatement.unknowns : [];

  output.write('\n--- Understanding ---\n');
  output.write(`${restatement?.paraphrase ?? '(no paraphrase)'}\n`);

  output.write('\nRepo evidence:\n');
  if (evidence.length === 0) {
    output.write('  (none cited)\n');
  } else {
    for (const e of evidence) output.write(`  • ${e}\n`);
  }

  output.write('\nCould not determine / had to guess:\n');
  if (unknowns.length === 0) {
    output.write('  (none flagged)\n');
  } else {
    for (const u of unknowns) output.write(`  • ${u}\n`);
  }

  output.write(
    [
      '',
      'Is this understanding correct?',
      '  y = yes, proceed to questions',
      '  n = no, let me restate what I actually want',
      '  p = partially — let me correct some details',
      '',
    ].join('\n'),
  );
}

/**
 * Run the TTY-only frame-first elicitation phase.
 *
 * Flow:
 *   1. proposeQuestions(userInput, { style }) → restatement + ranked questions
 *   2. render the restatement; prompt confirm (y) / reject-and-restate (n) /
 *      partially-correct (p). `n` and `p` collect a correction, re-run
 *      proposeQuestions with the correction folded in, and re-present — the
 *      escape hatch that can reject the whole framing. `y` confirms the frame.
 *   3. ask each ranked question ONE AT A TIME, showing its premise, collecting
 *      answers.
 *
 * Returns the collected answers and the accumulated framing correction (if any)
 * so the caller can weave both into the draft while keeping the user's verbatim
 * request for history. On an explicit reject with no restatement, returns no
 * answers and no correction (the rejected frame is not imposed on the draft).
 *
 * Injected input/output (via `reader` + `output`) keep this unit-testable; the
 * proposeQuestions call is wrapped in withProgressTicker for parity with the
 * rest of the CLI.
 *
 * @param {object} params
 * @param {{ proposeQuestions: Function }} params.brainstormer
 * @param {string} params.userInput
 * @param {{maxQuestions: number}} params.style
 * @param {{ ask(q: string): Promise<string> }} params.reader
 * @param {NodeJS.WritableStream} params.output
 * @returns {Promise<{ answers: Array<{question: string, answer: string}>, correction: string|undefined, assessedComplexity: string|undefined, questionCount: number, roundCount: number, questionsPerRound: number[] }>}
 */
/**
 * Ask a ranked question list one at a time, each shown with its premise, pushing
 * { question, answer } onto the shared flat `answers` array. Shared by round 1
 * and every follow-up round so the question-display format stays identical across
 * rounds (a render tweak lives in one place).
 *
 * @param {Array<{question: string, premise?: string}>} questions
 * @param {{ ask: (q: string) => Promise<string> }} reader
 * @param {NodeJS.WritableStream} output
 * @param {Array<{question: string, answer: string}>} answers - mutated in place
 */
async function askQuestions(questions, reader, output, answers) {
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    output.write(`\nQuestion ${i + 1} of ${questions.length}\n`);
    if (q.premise) output.write(`  (premise: ${q.premise})\n`);
    output.write(`${q.question}\n`);
    const answer = await reader.ask('> ');
    answers.push({ question: q.question, answer });
  }
}

export async function runElicitation({ brainstormer, userInput, style, reader, output }) {
  // Corrections from the reject / partially-correct escape hatch flow through
  // the dedicated `correction` channel into proposeQuestions — NOT concatenated
  // into userInput — so the agent treats them as an authoritative re-framing
  // (not extra scope) and the persisted history keeps the user's verbatim ask.
  // The accumulated correction is returned so the draft reflects the re-framing.
  let correction;          // undefined until the user corrects/rejects
  let framingRejected = false;
  let result;

  // Frame loop: re-run proposeQuestions until the user confirms the framing.
  while (true) {
    result = await withProgressTicker(output, 'brainstormer', () =>
      brainstormer.proposeQuestions(userInput, { style, correction }),
    );

    // Guard a malformed/empty result (e.g. a non-conforming stub) with the same
    // structured error production's extractor raises, instead of a raw TypeError
    // dereferencing result.restatement / result.questions below.
    if (!result || typeof result !== 'object' || !result.restatement) {
      const err = new Error('proposeQuestions returned no usable restatement');
      err.code = 'BRAINSTORM_VALIDATION_FAILED';
      throw err;
    }

    renderRestatement(output, result.restatement);

    const choice = (await reader.ask('Choice: ')).trim().toLowerCase();

    if (choice === 'n') {
      // Reject-and-restate: a fresh restatement REPLACES any accumulated
      // correction (the user is re-framing from scratch).
      const restated = await reader.ask('Restate what you actually want: ');
      if (restated && restated.trim()) {
        correction = restated.trim();
        continue;
      }
      // Blank restatement after an explicit reject: do NOT proceed with the
      // rejected frame. Skip the question phase entirely — the draft falls back
      // to the raw request and the user can refine via the menu. This honors
      // "reject the framing entirely".
      framingRejected = true;
      break;
    }
    if (choice === 'p') {
      // Partially-correct: ACCUMULATE onto any prior correction.
      const partial = await reader.ask('What should I correct? ');
      if (partial && partial.trim()) {
        correction = correction ? `${correction}\n${partial.trim()}` : partial.trim();
        continue;
      }
      // Blank partial-correction: the frame is mostly right — keep it.
      break;
    }
    // Any other input (including 'y') confirms the current framing.
    break;
  }

  // On an explicit reject with no restatement, skip elicitation: no questions
  // asked, no answers, no correction — the draft uses the raw request. The
  // assessedComplexity from the (rejected) framing turn is still surfaced for
  // telemetry.
  if (framingRejected) {
    // The frame was rejected entirely — no question round was confirmed, the
    // draft falls back to the raw request. roundCount 0 / questionsPerRound []
    // reflect that no question round ran (the complexity line below is NOT
    // surfaced because the framing was never confirmed).
    return {
      answers: [],
      correction: undefined,
      assessedComplexity: result?.assessedComplexity,
      questionCount: 0,
      roundCount: 0,
      questionsPerRound: [],
    };
  }

  // Apply the importance-DESC ordering + cap defensively: proposeQuestions
  // already ranks+caps its own output, but re-applying here keeps rendering
  // correct when driven by a stub that returns an unsorted, over-cap list. The
  // disclosure below still reads result.omittedCount (the method's single
  // capping home), not this defensive re-cap.
  const cap = resolveMaxQuestions(style);
  const { ranked: questions } = rankAndCap(result.questions, cap);

  const complexity = result.assessedComplexity;

  // ── Trivial / zero-question fast-path ────────────────────────────────────
  // A zero-question round 1 surfaces an informational complexity line and goes
  // STRAIGHT to drafting — no questions asked, and the follow-up loop is skipped
  // entirely (framing was already confirmed in the frame loop above, so we do
  // NOT re-ask for it). roundCount 1 / questionsPerRound [0] still record that
  // round 1 ran (with zero questions).
  if (questions.length === 0) {
    output.write(`Assessed complexity: ${complexity} — no clarifying questions needed; drafting.\n`);
    return {
      answers: [],
      correction,
      assessedComplexity: complexity,
      questionCount: 0,
      roundCount: 1,
      questionsPerRound: [0],
    };
  }

  // Surface the round-1 assessedComplexity once, after framing confirmation and
  // before the first question.
  output.write(`Assessed complexity: ${complexity}\n`);

  // Round-1 cap disclosure: render from proposeQuestions' omittedCount (the
  // single capping home), never by re-capping here. > 0 means the ranked list
  // was truncated to the per-round cap.
  if (typeof result.omittedCount === 'number' && result.omittedCount > 0) {
    output.write(`asked top ${questions.length}; ${result.omittedCount} omitted\n`);
  }

  // Ask each ranked question one at a time, showing its premise. All rounds
  // accumulate into this one flat answers array.
  const answers = [];
  await askQuestions(questions, reader, output, answers);

  // questionsPerRound[0] = round 1's asked count; subsequent entries appended by
  // the follow-up loop below.
  const questionsPerRound = [questions.length];

  // ── Adaptive multi-round follow-up loop ──────────────────────────────────
  // After round 1, repeatedly ask the agent to judge whether the prior answers
  // opened NEW decision-critical questions, up to the complexity-scaled ceiling
  // (derived from the round-1 complexity and LOCKED here, not re-derived per
  // round). Capability guard: only loop when the brainstormer exposes
  // proposeFollowups — keeps legacy stubs (proposeQuestions-only) on their prior
  // single-round behavior. The loop terminates on the FIRST of: done === true
  // (STRICT — validateStructured has no boolean branch), zero new questions, or
  // the ceiling. A follow-up failure gracefully degrades: stop the loop and
  // draft from the Q&A collected so far (round 1 already threw hard).
  const effectiveCeiling = resolveRoundCeiling(complexity, style);
  if (typeof brainstormer.proposeFollowups === 'function') {
    for (let round = 1; round <= effectiveCeiling; round++) {
      let followup;
      try {
        followup = await withProgressTicker(output, 'brainstormer', () =>
          brainstormer.proposeFollowups(userInput, result.restatement, answers, { style }),
        );
      } catch (err) {
        // Graceful degradation: stop the loop and keep the Q&A collected so far.
        // Surface the abort rather than silently swallowing it — a genuine defect
        // (not just the intended validation/budget degrade) must stay visible,
        // per the project's no-silent-fallback discipline.
        output.write(`\n(Follow-up elicitation stopped early: ${err?.message ?? err}. Drafting from the answers collected so far.)\n`);
        break;
      }

      if (!followup || typeof followup !== 'object') break;

      // STRICT done check: a truthy check would mis-terminate on a non-boolean
      // done (e.g. the string "false"). A done === true returned ALONGSIDE
      // questions short-circuits WITHOUT asking them.
      if (followup.done === true) break;

      const { ranked: fq } = rankAndCap(followup.questions, cap);
      if (fq.length === 0) break;

      // Per-round header + one-line integration restatement (informational; NO
      // confirm/reject affordance — the user corrects via this round's answers).
      output.write(`\nFollow-up round ${round} of up to ${effectiveCeiling}\n`);
      output.write(`${followup.integrationNote ?? ''}\n`);

      // Per-round cap disclosure from this round's omittedCount.
      if (typeof followup.omittedCount === 'number' && followup.omittedCount > 0) {
        output.write(`asked top ${fq.length}; ${followup.omittedCount} omitted\n`);
      }

      await askQuestions(fq, reader, output, answers);
      questionsPerRound.push(fq.length);
    }
  }

  // questionCount / answerCount are now cross-round TOTALS. roundCount is the
  // total rounds actually run INCLUDING round 1 (= questionsPerRound.length).
  return {
    answers,
    correction,
    assessedComplexity: complexity,
    questionCount: answers.length,
    roundCount: questionsPerRound.length,
    questionsPerRound,
  };
}

/**
 * CLI entry-point for the brainstorm command.
 *
 * Non-TTY (`--no-tty` or non-TTY output):
 *   - NEW: one-shot initialize, writes the bundle, prints an explicit
 *     outcome block (draft dir, status, counts, --resume instruction).
 *   - RESUME: read-only status view — never calls initialize/revise and
 *     writes nothing to disk (a cancelled draft stays cancelled).
 * Resuming a slug with no state.json throws in BOTH modes (no fabrication);
 * the cancelled→in-progress revival happens only on the interactive path.
 *
 * @param {string}   projectRoot  Absolute project root
 * @param {string[]} args         Positional args ([prose] for new, [] for resume)
 * @param {object}   flags        Parsed flags (flags.resume, flags['no-tty'])
 * @param {object}   [opts]       Injectable seams for testing
 * @param {function} [opts.brainstormerFactory]  Factory overriding buildBrainstormer
 * @param {object}   [opts.sessionManager]
 * @param {object}   [opts.logger]
 * @param {object}   [opts.tokenTracker]
 * @param {NodeJS.ReadableStream}  [opts.input]   Defaults to process.stdin
 * @param {NodeJS.WritableStream}  [opts.output]  Defaults to process.stdout
 * @returns {Promise<{ slug: string, status: string, dir: string }>}
 */
export async function brainstorm(projectRoot, args, flags, opts = {}) {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  const brainstormRoot = path.join(harnessRoot(projectRoot), 'brainstorm');
  let slug, dir;

  if (flags.resume) {
    // ── RESUME path ──────────────────────────────────────────────────────────
    slug = flags.resume;
    dir = path.join(brainstormRoot, slug);
    // Nonexistent-draft guard (both tty and no-tty modes): resuming a slug
    // with no state.json must error honestly instead of fabricating a new
    // spec via initialize(undefined). Slug listing is fail-soft.
    if (!fs.existsSync(path.join(dir, 'state.json'))) {
      let available = [];
      try {
        available = fs
          .readdirSync(brainstormRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        // fail-soft: brainstorm root missing or unreadable — omit the listing
      }
      const hint = available.length > 0 ? ` Available drafts: ${available.join(', ')}` : '';
      throw new Error(`No brainstorm draft found for slug "${slug}".${hint}`);
    }
  } else {
    // ── NEW path ──────────────────────────────────────────────────────────────
    const baseSlug = generateSlug(args[0]);
    slug = resolveSlugCollision(brainstormRoot, baseSlug);
    dir = path.join(brainstormRoot, slug);
    const now = new Date().toISOString();
    fs.mkdirSync(dir, { recursive: true });
    writeState(dir, {
      slug,
      createdAt: now,
      lastUpdatedAt: now,
      status: 'in-progress',
    });
  }

  // ── Build Brainstormer ────────────────────────────────────────────────────
  const factory = opts.brainstormerFactory ?? buildBrainstormer;
  const brainstormer = factory({
    sessionManager: opts.sessionManager,
    logger: opts.logger,
    tokenTracker: opts.tokenTracker,
  });

  // ── TTY detection ─────────────────────────────────────────────────────────
  const isTty = (opts.output ?? process.stdout).isTTY === true && !flags['no-tty'];

  // ── Count existing history turns (for resume continuity) ─────────────────
  let turn = 0;
  try {
    const historyContent = fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8');
    turn = historyContent
      .trim()
      .split('\n')
      .filter((l) => l.trim()).length;
  } catch {
    turn = 0;
  }

  // ── Load existing spec for RESUME, if present ────────────────────────────
  let currentSpec = null;
  let currentSpecMd = null;
  if (flags.resume) {
    try {
      const specRaw = fs.readFileSync(path.join(dir, 'spec.json'), 'utf8');
      currentSpec = JSON.parse(specRaw);
    } catch {
      currentSpec = null;
    }
    try {
      currentSpecMd = fs.readFileSync(path.join(dir, 'spec.md'), 'utf8');
    } catch {
      currentSpecMd = null;
    }
  }

  // ── Non-TTY one-shot fallback ─────────────────────────────────────────────
  if (!isTty) {
    if (flags.resume) {
      // Read-only status view: never calls initialize or revise, touches
      // nothing on disk (including NOT reviving a cancelled draft — that
      // revival happens only on the interactive path).
      const state = readState(dir);
      const status = state?.status ?? 'unknown';
      if (currentSpecMd !== null) {
        printSpecPreview(output, currentSpecMd);
      }
      printNoTtyOutcome(output, { dir, slug, status, spec: currentSpec });
      return { slug, status, dir };
    }

    const { spec, specMd } = await withProgressTicker(output, 'brainstormer', () => brainstormer.initialize(args[0]));
    writeBundle(dir, spec, specMd);
    turn += 1;
    appendHistory(dir, {
      turn,
      ts: new Date().toISOString(),
      mode: 'initialize',
      input: args[0] || '',
      specHash: hashSpec(spec),
      // Telemetry parity with the TTY history schema: the non-TTY path runs no
      // elicitation and no digest, so the question/round counts are zero / empty
      // and assumption/complexity are null. roundCount/questionsPerRound are
      // included (as 0 / []) so every initialize entry carries the same fields a
      // consumer reads — non-TTY genuinely ran zero rounds.
      questionCount: 0,
      answerCount: 0,
      roundCount: 0,
      questionsPerRound: [],
      assumptionCount: null,
      complexityTier: null,
    });
    printNoTtyOutcome(output, { dir, slug, status: 'in-progress', spec });
    return { slug, status: 'in-progress', dir };
  }

  // ── TTY resume: revive a cancelled draft (interactive path only) ──────────
  if (flags.resume) {
    const state = readState(dir);
    if (state && state.status === 'cancelled') {
      writeState(dir, {
        ...state,
        status: 'in-progress',
        lastUpdatedAt: new Date().toISOString(),
      });
    }
  }

  // ── Interactive loop reader ───────────────────────────────────────────────
  // createLineReader buffers arriving lines so that sequential ask() calls
  // work correctly even when all test input arrives at once. Created before the
  // elicitation phase so both that phase and the menu loop share one reader.
  const reader = createLineReader(input, output);
  // The reader is created before the elicitation phase, so a throw in
  // proposeQuestions / initialize would leak the readline interface (a
  // regression vs. the old post-initialize placement). Wrap everything that
  // uses the reader in try/finally so it is always closed. finalStatus is
  // hoisted so the post-finally return can read it.
  let finalStatus = 'in-progress';
  try {

  // ── TTY-only frame-first elicitation (NEW draft path) ─────────────────────
  // Fires ONLY on the interactive new-draft path (isTty && !resume &&
  // currentSpec === null), and only when the brainstormer exposes
  // proposeQuestions — a capability guard that keeps legacy injected stubs
  // (which implement only initialize/revise) on their existing behavior. The
  // !flags.resume clause honors the spec's "resume path does not trigger the
  // question phase" even when a resumed draft has state.json but no spec.json.
  let elicitedAnswers;
  let elicitedCorrection;
  let elicitedComplexity;
  let elicitedQuestionCount;
  let elicitedRoundCount;
  let elicitedQuestionsPerRound;
  if (!flags.resume && currentSpec === null && typeof brainstormer.proposeQuestions === 'function') {
    const style = opts.style ?? config.elicitation;
    const { answers, correction, assessedComplexity, questionCount, roundCount, questionsPerRound } = await runElicitation({
      brainstormer,
      userInput: args[0],
      style,
      reader,
      output,
    });
    elicitedAnswers = answers;
    elicitedCorrection = correction;
    elicitedComplexity = assessedComplexity;
    elicitedQuestionCount = questionCount;
    elicitedRoundCount = roundCount;
    elicitedQuestionsPerRound = questionsPerRound;
  }

  // ── TTY: ensure we have an initial spec ───────────────────────────────────
  if (currentSpec === null) {
    // Draft from the verbatim request plus the elicited answers / framing
    // correction; history records the verbatim request (args[0]), not the
    // synthetic re-framing prose. withDigest: true opts into the digest channel
    // for the TTY understanding-playback step.
    const style = opts.style ?? config.elicitation;
    const { spec, specMd, digest } = await withProgressTicker(output, 'brainstormer', () =>
      brainstormer.initialize(args[0], { answers: elicitedAnswers, correction: elicitedCorrection, withDigest: true }),
    );
    currentSpec = spec;
    currentSpecMd = specMd;
    writeBundle(dir, spec, specMd);
    // Keep the transient digest sidecar (never copied to root / fed to the
    // planner) in sync with this draft — write when produced, remove otherwise.
    syncDigest(dir, digest);
    turn += 1;
    appendHistory(dir, {
      turn,
      ts: new Date().toISOString(),
      mode: 'initialize',
      input: args[0] || '',
      specHash: hashSpec(spec),
      // Elicitation telemetry for downstream-noise correlation. questionCount /
      // answerCount are cross-round TOTALS; roundCount is the total rounds run
      // INCLUDING round 1; questionsPerRound[0] = round 1's count.
      questionCount: elicitedQuestionCount ?? 0,
      answerCount: Array.isArray(elicitedAnswers) ? elicitedAnswers.length : 0,
      roundCount: elicitedRoundCount ?? 0,
      questionsPerRound: elicitedQuestionsPerRound ?? [],
      assumptionCount: digest ? (digest.assumptions?.length ?? 0) : null,
      complexityTier: elicitedComplexity,
    });
    // Render the one-page understanding-playback digest for confirmation.
    output.write(renderDigest(spec, digest, { style }));
  }

  // ── Resume: re-show the persisted digest before the menu ──────────────────
  // On the TTY resume path the initialize block above is skipped (currentSpec
  // was loaded from disk, not drafted this turn), so the digest read-back is
  // never re-rendered. Read the persisted digest.json and render it so a
  // resuming user sees the read-back before they can accept. When digest.json
  // is absent, render with undefined — spec-derived sections still show and the
  // digest-only sections show "(none captured)".
  if (flags.resume && currentSpec !== null) {
    const style = opts.style ?? config.elicitation;
    const persistedDigest = readDigest(dir);
    output.write(renderDigest(currentSpec, persistedDigest, { style }));
  }

  // ── Interactive loop ──────────────────────────────────────────────────────

  if (currentSpecMd !== null) {
    printSpecPreview(output, currentSpecMd);
  }
  printMenu(output);

  let looping = true;

  while (looping) {
    const { key, inlineArg } = parseActionInput(await reader.ask('Choice: '));

    if (key === 'a') {
      // Accept
      const st = readState(dir);
      writeState(dir, { ...st, status: 'approved', lastUpdatedAt: new Date().toISOString() });
      copyApprovedToProjectRoot(projectRoot, dir, slug);
      output.write(`\n✓ Accepted — spec written to:\n  ${path.join(projectRoot, `${slug}.spec.json`)}\n  ${path.join(projectRoot, `${slug}.spec.md`)}\nNext: run \`cc-orch run\` to execute.\n`);
      finalStatus = 'approved';
      looping = false;
    } else if (key === 'r') {
      // Regenerate — inline form: `r fix the goal`; bare form: sub-prompt
      const feedback = inlineArg || (await reader.ask('Feedback for regeneration: '));
      const style = opts.style ?? config.elicitation;
      const { spec, specMd, digest } = await withProgressTicker(output, 'brainstormer', () => brainstormer.revise(currentSpec, feedback, 'regenerate', { withDigest: true }));
      currentSpec = spec;
      currentSpecMd = specMd;
      writeBundle(dir, spec, specMd);
      syncDigest(dir, digest);
      turn += 1;
      appendHistory(dir, {
        turn,
        ts: new Date().toISOString(),
        mode: 'regenerate',
        input: feedback,
        specHash: hashSpec(spec),
        // Revise-turn telemetry: assumptions from this turn's digest; no
        // questions/answers are asked on a revise turn. assumptionCount is null
        // when no digest was produced (absent ≠ an empty digest's 0).
        questionCount: 0,
        answerCount: 0,
        assumptionCount: digest ? (digest.assumptions?.length ?? 0) : null,
      });
      output.write(`\n✓ Regenerated (turn ${turn}) — feedback: "${feedback || '(none)'}"\n  Artifacts: ${dir}\n  Tip: press \`d\` to view current spec.\n`);
      printSpecPreview(output, currentSpecMd);
      output.write(renderDigest(spec, digest, { style }));
      printTurnSeparator(output);
      printMenu(output);
    } else if (key === 'e') {
      // Edit — inline form: `e goal should be caching`; bare form: sub-prompt
      const feedback = inlineArg || (await reader.ask('Enter feedback: '));
      const style = opts.style ?? config.elicitation;
      const { spec, specMd, digest } = await withProgressTicker(output, 'brainstormer', () => brainstormer.revise(currentSpec, feedback, 'edit', { withDigest: true }));
      currentSpec = spec;
      currentSpecMd = specMd;
      writeBundle(dir, spec, specMd);
      syncDigest(dir, digest);
      turn += 1;
      appendHistory(dir, {
        turn,
        ts: new Date().toISOString(),
        mode: 'edit',
        input: feedback,
        specHash: hashSpec(spec),
        questionCount: 0,
        answerCount: 0,
        assumptionCount: digest ? (digest.assumptions?.length ?? 0) : null,
      });
      output.write(`\n✓ Edited (turn ${turn}) — feedback: "${feedback}"\n  Artifacts: ${dir}\n  Tip: press \`d\` to view current spec.\n`);
      printSpecPreview(output, currentSpecMd);
      output.write(renderDigest(spec, digest, { style }));
      printTurnSeparator(output);
      printMenu(output);
    } else if (key === 'c') {
      // Cancel
      const st = readState(dir);
      writeState(dir, { ...st, status: 'cancelled', lastUpdatedAt: new Date().toISOString() });
      output.write(`\n✓ Cancelled — draft preserved at:\n  ${dir}\nResume later: cc-orch brainstorm --resume ${slug}\n`);
      finalStatus = 'cancelled';
      looping = false;
    } else if (key === 'd') {
      // Diff / view current spec
      output.write('\n--- Current spec.json ---\n');
      output.write(JSON.stringify(currentSpec, null, 2));
      output.write('\n--- End of spec.json ---\n');
      printTurnSeparator(output);
      printMenu(output);
    } else if (key === 'h') {
      printTurnSeparator(output);
      printHelp(output, slug);
    } else {
      output.write(`Unknown command "${key}". Press h for help.\n`);
      printTurnSeparator(output);
      printMenu(output);
    }
  }

  } finally {
    reader.close();
  }
  return { slug, status: finalStatus, dir };
}
