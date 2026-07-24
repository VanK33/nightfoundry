import { getTerminalWidth } from '../infra/wrap.js';

/**
 * Formats a banner line (and optional wrapped body lines) for a prefixed ID + description.
 *
 * @param {string} prefix       - Label prefix (e.g. 'Milestone', 'Mission').
 * @param {string} id           - Identifier string (e.g. '001').
 * @param {string} description  - Full description; split on first '. ' or '\n'.
 * @param {object} [opts={}]    - Optional config.
 * @param {string} [opts.suffix='']        - Appended to the title line.
 * @param {string} [opts.indent='']        - Prepended to every output line.
 * @param {number} [opts.maxBodyLines=1]   - Maximum number of wrapped body lines.
 * @param {number} [opts.wrapWidth]        - Override effective wrap width.
 * @returns {string[]} Array of formatted lines.
 */
export function formatBanner(prefix, id, description, opts = {}) {
  const { suffix = '', indent = '', maxBodyLines = 1, wrapWidth } = opts;
  const effectiveWidth = wrapWidth ?? (getTerminalWidth({ fallback: 100 }) - 4);
  const desc = description || '';

  const idxDot = desc.indexOf('. ');
  const idxNl  = desc.indexOf('\n');

  let title, body;
  if (idxDot === -1 && idxNl === -1) {
    title = desc;
    body  = '';
  } else {
    const splitAt =
      idxDot === -1 ? idxNl  :
      idxNl  === -1 ? idxDot :
      Math.min(idxDot, idxNl);
    const isNewline = desc[splitAt] === '\n';
    title = desc.slice(0, splitAt);
    body  = desc.slice(splitAt + (isNewline ? 1 : 2));
  }

  const lines = [];
  lines.push(`${indent}${prefix} ${id}: ${title}${suffix}`);

  if (body.trim()) {
    const bodyLines = [];
    const words = body.trim().split(/\s+/);
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && (indent + candidate).length > effectiveWidth) {
        bodyLines.push(indent + current);
        if (bodyLines.length >= maxBodyLines) break;
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current && bodyLines.length < maxBodyLines) bodyLines.push(indent + current);
    lines.push(...bodyLines);
  }

  return lines;
}
