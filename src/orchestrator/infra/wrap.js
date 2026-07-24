/**
 * Terminal-width detection and greedy word-wrap helper.
 * No external deps; no top-level side effects.
 */

/**
 * Returns the terminal width for the given stream, or fallback if unavailable.
 *
 * @param {object}  [opts]
 * @param {object}  [opts.stream=process.stdout]
 * @param {number}  [opts.fallback=100]
 * @returns {number}
 */
export function getTerminalWidth({ stream = process.stdout, fallback = 100 } = {}) {
  return Number.isInteger(stream?.columns) && stream.columns > 0
    ? stream.columns
    : fallback;
}

/**
 * Greedy word-wrap a string to fit within the computed column budget.
 *
 * Effective width = (opts.width ?? getTerminalWidth(...)) - (opts.margin ?? 2) * 2
 *
 * Multi-line input: each `\n`-separated row is wrapped independently; results
 * are rejoined with `\n`.
 *
 * Continuation rows are prefixed with `opts.hangingIndent` (a string of spaces
 * equal to the visual column where the first non-prefix character starts) so
 * the wrapped text hangs under that character.
 *
 * When `opts.railPrefix` is supplied (e.g. `'│ '`), every continuation row
 * becomes `railPrefix + hangingIndent + chunk` so the box rail is preserved.
 *
 * Single words longer than the effective width are emitted on their own line
 * uncut.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number}  [opts.width]           - explicit wrap column count
 * @param {object}  [opts.stream]          - stream for auto-detecting width
 * @param {number}  [opts.fallbackWidth]   - fallback passed to getTerminalWidth
 * @param {number}  [opts.margin=2]        - side margins subtracted on each side
 * @param {string}  [opts.hangingIndent='']- spaces to prefix continuation rows
 * @param {string}  [opts.railPrefix='']   - rail prefix for continuation rows
 * @returns {string}
 */
export function wrapLine(text, opts = {}) {
  const margin = opts.margin ?? 2;
  const effectiveWidth =
    (opts.width ?? getTerminalWidth({ stream: opts.stream, fallback: opts.fallbackWidth })) -
    margin * 2;

  const hangingIndent = opts.hangingIndent ?? '';
  const railPrefix = opts.railPrefix ?? '';

  /**
   * Wrap a single (no-newline) row.
   * @param {string} row
   * @returns {string}
   */
  function wrapRow(row) {
    if (row.length <= effectiveWidth) return row;
    const words = row.split(/\s+/);
    const lines = [];
    let current = '';

    for (const word of words) {
      if (!word) continue; // skip empty tokens from leading/trailing spaces
      const candidate = current ? `${current} ${word}` : word;
      if (current && candidate.length > effectiveWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);

    if (lines.length === 0) return row; // preserve empty rows

    // First line is emitted as-is; continuation lines get prefix.
    return lines
      .map((chunk, i) => {
        if (i === 0) return chunk;
        return railPrefix + hangingIndent + chunk;
      })
      .join('\n');
  }

  return text
    .split('\n')
    .map(row => wrapRow(row))
    .join('\n');
}
