/**
 * suggest.js — Levenshtein distance utility and 'Did you mean?' suggestion logic.
 *
 * Provides fuzzy matching for CLI command input so users get helpful
 * corrections when they mistype a command name or pass a legacy --flag.
 *
 * Public API:
 *   levenshtein(a, b) → number
 *     Classic dynamic-programming edit distance between two strings.
 *
 *   suggest(input, commands) → string | null
 *     Returns the closest match from `commands` if distance ≤ 3, else null.
 *
 *   mapFlagToCommand(flag) → string | null
 *     Maps a legacy --flag (e.g. '--status') to its new positional command
 *     equivalent (e.g. 'status'). Returns null for unknown flags.
 *
 *   KNOWN_COMMANDS — array of recognised command strings (re-exported for
 *     use in index.js so both modules stay in sync).
 *
 *   FLAG_TO_COMMAND — plain object mapping legacy flags to commands (also
 *     re-exported for use in index.js).
 */

/** All recognised positional commands. */
export const KNOWN_COMMANDS = [
  'run',
  'resume',
  'status',
  'archive',
  'usage',
  'init',
  'health',
  'review',
  'version',
  'help',
  'dry-run',
  'task',
  'queue',
  'park',
  'brainstorm',
  'ui',
  'dispersion',
];

/** Legacy --flag → positional-command mapping. */
export const FLAG_TO_COMMAND = {
  '--run': 'run',
  '--resume': 'resume',
  '--status': 'status',
  '--archive': 'archive',
  '--usage': 'usage',
  '--init': 'init',
  '--health': 'health',
  '--review': 'review',
  '--version': 'version',
  '--help': 'help',
};

/**
 * Compute the Levenshtein edit distance between two strings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;

  // Allocate a (m+1) × (n+1) matrix using a flat Uint16Array for speed.
  const d = new Uint16Array((m + 1) * (n + 1));
  const idx = (i, j) => i * (n + 1) + j;

  for (let i = 0; i <= m; i++) d[idx(i, 0)] = i;
  for (let j = 0; j <= n; j++) d[idx(0, j)] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[idx(i, j)] = Math.min(
        d[idx(i - 1, j)] + 1,       // deletion
        d[idx(i, j - 1)] + 1,       // insertion
        d[idx(i - 1, j - 1)] + cost // substitution
      );
    }
  }

  return d[idx(m, n)];
}

/**
 * Return the closest match from `commands` if its Levenshtein distance from
 * `input` is ≤ 3, otherwise return null.
 *
 * @param {string} input
 * @param {string[]} commands
 * @returns {string | null}
 */
export function suggest(input, commands) {
  let bestMatch = null;
  let bestDist = Infinity;

  for (const cmd of commands) {
    const dist = levenshtein(input, cmd);
    if (dist < bestDist) {
      bestDist = dist;
      bestMatch = cmd;
    }
  }

  return bestDist <= 3 ? bestMatch : null;
}

/**
 * Map a legacy --flag string to its positional command equivalent.
 *
 * @param {string} flag  e.g. '--status'
 * @returns {string | null}
 */
export function mapFlagToCommand(flag) {
  return FLAG_TO_COMMAND[flag] ?? null;
}
