/**
 * prompt.js — Shared yes/no confirmation helper for CLI commands.
 *
 * Pure JS over readline. Centralizes the y/n parsing logic that was
 * previously copy-pasted (with subtly different bugs) across run.js,
 * resume.js, and archive.js.
 *
 * Strict parser with re-prompt:
 *   - 'y' / 'yes' (case-insensitive) → true
 *   - 'n' / 'no'  (case-insensitive) → false
 *   - anything else → re-prompt, up to MAX_RETRIES, then default to false
 *
 * Background: dogfood 1 shipped a bug where `askUser` in run.js used
 * `answer.toLowerCase().startsWith('y')` — which treated any non-'y'
 * input as "no". A user typed 'h' intending "yes" and the pipeline
 * silently skipped a mission. The archive.js variant had the inverse
 * problem (`=== 'y'` rejected the full word 'yes'). This helper is
 * the single enforcement point for both.
 *
 * Ctrl-C (W2-F2 deadlock fix): Node readline in terminal mode with no
 * rl-level 'SIGINT' listener swallows ^C and pauses stdin — the prompt
 * deadlocks and ALL later input (valid or not) never arrives (empirically
 * confirmed via PTY probe, 2026-06-11). Every readline site here registers
 * an rl 'SIGINT' handler that runs the SAME cleanup as the normal path
 * (rl.close + statusBar.promptDidEnd) and rejects the returned promise with
 * UserInterruptError (a HaltError subclass, site 'user-interrupt'). A
 * settled guard keeps the normal-answer path and the SIGINT path mutually
 * exclusive — never two settlements.
 *
 * Public API:
 *   askYesNo(question, opts?) → Promise<boolean>
 *     opts.input      readable stream (default: process.stdin) — for tests
 *     opts.output     writable stream (default: process.stdout) — for tests
 *     opts.maxRetries number (default: 5)
 *     opts.statusBar  StatusBar instance — if provided, promptWillStart() is
 *                     called before readline takes over and promptDidEnd() is
 *                     called after readline closes.
 *     opts.terminal   passed through to readline.createInterface — for tests
 *                     (terminal:true + fake streams makes rl emit 'SIGINT' on
 *                     0x03 without a PTY). Default undefined = readline's own
 *                     TTY detection, i.e. current behavior.
 *     Rejects with UserInterruptError on Ctrl-C.
 *
 *   askMenu(question, options, opts?) → Promise<string>
 *     options  array of { key, label } objects; key is a single character
 *     Returns the matched key string. Defaults to first option after maxRetries.
 *     opts.input      readable stream (default: process.stdin) — for tests
 *     opts.output     writable stream (default: process.stdout) — for tests
 *     opts.maxRetries number (default: 5)
 *     opts.statusBar  StatusBar instance — same lifecycle hooks as askYesNo.
 *     opts.terminal   same test seam as askYesNo.
 *     Rejects with UserInterruptError on Ctrl-C (both fixed-choice and
 *     free-text modes).
 *
 *   askAssumptionFix(assumption, evidence, proposedEdit, opts?) → Promise<{ choice: 'a'|'r'|'e', editedText?: string }>
 *     assumption    string — the failed assumption text
 *     evidence      string — verifier evidence
 *     proposedEdit  { section: string, oldText: string, newText: string }
 *     opts          passed through to underlying askMenu calls
 *     Displays a formatted block and presents an accept/reject/edit menu.
 *     If choice is 'e', prompts for free-text replacement and returns it as editedText.
 */
import readline from 'readline';
import { wrapLine, getTerminalWidth } from '../orchestrator/infra/wrap.js';
import { UserInterruptError } from '../orchestrator/core/halt-error.js';

const YES = new Set(['y', 'yes']);
const NO = new Set(['n', 'no']);
const DEFAULT_MAX_RETRIES = 5;

export function askYesNo(question, opts = {}) {
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const statusBar = opts.statusBar || null;

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, output, terminal: opts.terminal });
    let attempts = 0;
    let settled = false;

    // Centralised cleanup: close readline, notify statusBar, resolve.
    // Transcript-line behavior: readline's natural echo of (question + user input)
    // already lands at scrollBottom (because promptWillStart positioned cursor there),
    // and the trailing \r\n that fires on Enter triggers DECSTBM scroll-up — so the
    // echoed line becomes a permanent log row above the bar without us emitting an
    // explicit onLog. The earlier v0.1.25 attempt to emit onLog(question + rawAnswer)
    // here double-emitted the prompt (visible as two identical "Proceed? (y/n) y"
    // rows per prompt) — removed.
    const done = (value, _rawAnswer = '') => {
      if (settled) return;
      settled = true;
      rl.close();
      if (statusBar) statusBar.promptDidEnd();
      resolve(value);
    };

    // Ctrl-C: same cleanup as the normal path, then reject. Without this
    // listener readline swallows ^C and pauses stdin (deadlock — see file-top
    // comment). The settled guard keeps this mutually exclusive with done().
    rl.on('SIGINT', () => {
      if (settled) return;
      settled = true;
      rl.close();
      if (statusBar) statusBar.promptDidEnd();
      reject(new UserInterruptError());
    });

    const ask = () => {
      rl.question(question, (raw) => {
        const answer = (raw || '').trim().toLowerCase();
        if (YES.has(answer)) {
          return done(true, raw);
        }
        if (NO.has(answer)) {
          return done(false, raw);
        }

        attempts += 1;
        if (attempts >= maxRetries) {
          output.write(`Too many invalid responses; defaulting to "no".\n`);
          return done(false, '<defaulted-no>');
        }

        output.write(`Please answer "y" or "n" (got "${raw}").\n`);
        ask();
      });
    };

    // Position cursor in scroll region before readline takes over.
    if (statusBar) statusBar.promptWillStart();
    ask();
  });
}

export function askMenu(question, options, opts = {}) {
  const statusBar = opts.statusBar || null;

  // Free-text mode: no options, just prompt for a string and return it.
  if (!options || options.length === 0) {
    const input = opts.input || process.stdin;
    const output = opts.output || process.stdout;
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input, output, terminal: opts.terminal });
      let settled = false;
      // Ctrl-C: same cleanup as the normal path, then reject (see askYesNo).
      rl.on('SIGINT', () => {
        if (settled) return;
        settled = true;
        rl.close();
        if (statusBar) statusBar.promptDidEnd();
        reject(new UserInterruptError());
      });
      if (statusBar) statusBar.promptWillStart();
      rl.question(question, (raw) => {
        if (settled) return;
        settled = true;
        rl.close();
        // readline's natural echo + DECSTBM scroll-up already provides the
        // transcript-line behavior; do NOT emit a separate onLog — see askYesNo.
        if (statusBar) statusBar.promptDidEnd();
        resolve((raw || '').trim());
      });
    });
  }

  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  const validKeys = new Set(options.map((o) => o.key));
  const defaultKey = options[0].key;

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, output, terminal: opts.terminal });
    let attempts = 0;
    let settled = false;

    // Centralised cleanup: close readline, notify statusBar, resolve.
    // readline's natural echo + DECSTBM scroll-up already provides transcript-line
    // persistence; do NOT emit a separate onLog — see askYesNo.
    const done = (value, _rawAnswer = '') => {
      if (settled) return;
      settled = true;
      rl.close();
      if (statusBar) statusBar.promptDidEnd();
      resolve(value);
    };

    // Ctrl-C: same cleanup as the normal path, then reject (see askYesNo).
    rl.on('SIGINT', () => {
      if (settled) return;
      settled = true;
      rl.close();
      if (statusBar) statusBar.promptDidEnd();
      reject(new UserInterruptError());
    });

    const ask = () => {
      rl.question(question, (raw) => {
        const answer = (raw || '').trim().toLowerCase();
        if (validKeys.has(answer)) {
          return done(answer, raw);
        }

        attempts += 1;
        if (attempts >= maxRetries) {
          output.write(`Too many invalid responses; defaulting to "${defaultKey}".\n`);
          return done(defaultKey, `<defaulted-${defaultKey}>`);
        }

        const keyList = options.map((o) => `"${o.key}" for ${o.label}`).join(', ');
        output.write(`Invalid choice (got "${raw}"). Please enter one of: ${keyList}.\n`);
        ask();
      });
    };

    // Position cursor in scroll region before readline takes over.
    if (statusBar) statusBar.promptWillStart();
    // Render menu choices before the readline prompt.
    for (const opt of options) {
      output.write(`  ${opt.key} = ${opt.label}\n`);
    }
    ask();
  });
}

/**
 * askAssumptionFix — displays a failed-assumption review block and prompts
 * the user to accept, reject, or edit the proposed remediation.
 *
 * @param {string} assumption     The failed assumption text.
 * @param {string} evidence       Verifier evidence supporting the failure.
 * @param {{ revisedAssumptions: Array<{text: string, phase?: string}>, specEdit: { section: string, oldText: string, newText: string } }} remediation
 * @param {object} [opts]         Passed through to askMenu (input/output/maxRetries).
 * @returns {Promise<{ choice: 'a'|'r'|'e', editIndex?: number, editedText?: string }>}
 */
export async function askAssumptionFix(assumption, evidence, remediation, opts = {}) {
  const output = opts.output || process.stdout;

  const { revisedAssumptions, specEdit } = remediation;
  const { section, oldText, newText } = specEdit;

  const assumptionLines = revisedAssumptions
    .map((a, i) => `│   ${i + 1}. [${a.phase ?? 'invariant'}] ${a.text}`)
    .join('\n');

  const effectiveWidth = getTerminalWidth({ stream: output, fallback: 100 });

  const display = [
    '┌─ Assumption Fix Review ──────────────────────────────────────',
    `│ FAILED ASSUMPTION:`,
    `│   ${assumption}`,
    `│`,
    `│ VERIFIER EVIDENCE:`,
    `│   ${evidence}`,
    `│`,
    `│ REVISED ASSUMPTIONS:`,
    assumptionLines,
    `│`,
    `│ PROPOSED SPEC EDIT — section: ${section}`,
    `│   OLD: ${oldText}`,
    `│   NEW: ${newText}`,
    '└──────────────────────────────────────────────────────────────',
    '',
  ]
    .map((line) => {
      if (typeof line === 'string' && line.startsWith('│') && line.length > effectiveWidth) {
        return wrapLine(line, {
          stream: output,
          railPrefix: '│ ',
          hangingIndent: '   ',
          fallbackWidth: 100,
          margin: 2,
        });
      }
      return line;
    })
    .join('\n');

  output.write(display);

  const editOptions = revisedAssumptions.map((_, i) => ({
    key: `e${i + 1}`,
    label: `edit #${i + 1}`,
  }));

  const MENU_OPTIONS = [
    { key: 'a', label: 'accept all' },
    { key: 'r', label: 'reject all' },
    ...editOptions,
  ];

  const promptStr = `Choose action: `;

  const choice = await askMenu(promptStr, MENU_OPTIONS, opts);

  if (choice.startsWith('e')) {
    const idx = parseInt(choice.slice(1), 10) - 1;
    const editedText = await askMenu(`Enter modified text for assumption #${idx + 1}: `, [], opts);
    return { choice: 'e', editIndex: idx, editedText };
  }

  return { choice };
}
