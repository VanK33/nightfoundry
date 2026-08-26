/**
 * scope-parser.js — Pure-JS extraction of scope items from spec markdown.
 *
 * Recognises four patterns:
 *
 *  1. Numbered sub-sections under a '## Scope — in' heading, e.g.
 *       ### 1. Foo bar
 *     → { label: 'Foo bar', source: 'numbered-subsection' }
 *
 *  2. Named-bug bullets matching **Bug X — description**, e.g.
 *       - **Bug 7 — off-by-one in pagination**
 *     → { label: 'Bug 7 — off-by-one in pagination', source: 'named-bug' }
 *
 *  3. HTML comment markers anywhere in the document, e.g.
 *       <!-- scope-item: My label -->
 *     → { label: 'My label', source: 'comment-marker' }
 *
 *  4. Numbered bold items inside a '## Scope — in' section, e.g.
 *       1. **Foo bar**
 *     → { label: 'Foo bar', source: 'numbered-bold-item' }
 *
 *     If the bold label starts with a leading `[context]` marker (case-
 *     insensitive) followed by at least one whitespace character, the marker
 *     and that whitespace are stripped from the label and the item carries
 *     an additional `contextOnly: true` field, e.g.
 *       1. **[context] Docs refresh**
 *     → { label: 'Docs refresh', source: 'numbered-bold-item', contextOnly: true }
 *     A marker with no following whitespace (e.g. `[context]foo`) or a label
 *     that merely contains the word "context" (e.g. `contextual foo`) is NOT
 *     recognised as the marker; the label is left unstripped and no
 *     `contextOnly` field is added. This marker is only recognised on
 *     numbered-bold-item labels — not on numbered-subsection, named-bug, or
 *     comment-marker items.
 *
 * Deduplicates by label (case-sensitive), preserving first-seen order.
 * Returns [] when no scope items are found.
 *
 * Public API:
 *   extractScopeItems(specMarkdown)      → Array<{ id: string, label: string, source: string, contextOnly?: boolean }>
 *   extractRejectedPhrases(constraints)  → Array<{ phrase: string, tokens: Set<string> }>
 *   STOPWORDS                            → Set<string> (consumed by extractRejectedPhrases)
 */

/** Stopwords to discard when tokenising rejected phrases. */
export const STOPWORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'of', 'for', 'and', 'or',
  'to', 'is', 'it', 'with', 'by', 'at', 'from', 'as',
]);

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
// Matches "## Scope — in" (with or without em-dash variants and optional trailing text)
const SCOPE_IN_HEADING_RE = /^scope\s*[—\-–]\s*in\b/i;
// Matches "### N. Label" — a numbered H3 (or deeper) sub-section
const NUMBERED_SUBSECTION_RE = /^#{3,}\s+\d+\.\s+(.+?)\s*$/;
// Matches **Bug X — description** (anywhere on the line, tolerates list bullets)
const NAMED_BUG_RE = /\*\*(Bug\s+\S.*?)\*\*/;
// Matches <!-- scope-item: label -->
const COMMENT_MARKER_RE = /<!--\s*scope-item:\s*(.+?)\s*-->/g;
// Matches "1. **Bold text**" — a numbered list item whose label is entirely bold
const NUMBERED_BOLD_ITEM_RE = /^\s*\d+\.\s+\*\*(.+?)\*\*/;
// Matches a leading "[context] " marker (case-insensitive) at the start of a
// numbered-bold-item label — requires at least one whitespace char after the
// marker to be recognised. Capturing group holds the remainder of the label.
const CONTEXT_MARKER_RE = /^\[context\]\s+(.+)$/i;

/**
 * Extract scope items from spec markdown.
 *
 * @param {string} specMarkdown
 * @returns {Array<{ id: string, label: string, source: string, contextOnly?: boolean }>}
 */
export function extractScopeItems(specMarkdown) {
  if (typeof specMarkdown !== 'string' || specMarkdown.length === 0) {
    return [];
  }

  const lines = specMarkdown.split('\n');
  let inScopeIn = false;
  const items = [];

  for (const line of lines) {
    // --- Pattern 3: HTML comment markers (document-wide, no section required) ---
    // Reset lastIndex each time since we reuse the regex with /g flag.
    COMMENT_MARKER_RE.lastIndex = 0;
    let commentMatch;
    while ((commentMatch = COMMENT_MARKER_RE.exec(line)) !== null) {
      items.push({ label: commentMatch[1], source: 'comment-marker' });
    }

    // --- Heading detection ---
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const headingText = headingMatch[2];
      const level = headingMatch[1].length;

      if (SCOPE_IN_HEADING_RE.test(headingText)) {
        inScopeIn = true;
        continue;
      }

      // Pattern 1: Numbered sub-section inside Scope — in (H3+).
      // Must be checked here because heading lines always reach continue before
      // the standalone pattern-1 block below.
      if (inScopeIn && level >= 3) {
        const numberedMatch = line.match(NUMBERED_SUBSECTION_RE);
        if (numberedMatch) {
          items.push({ label: numberedMatch[1], source: 'numbered-subsection' });
        }
        continue;
      }

      // Any H2 or shallower heading ends the Scope — in section.
      if (inScopeIn && level <= 2) {
        inScopeIn = false;
      }
      continue;
    }

    // --- Pattern 2: Named-bug bullets (document-wide) ---
    const bugMatch = line.match(NAMED_BUG_RE);
    if (bugMatch) {
      items.push({ label: bugMatch[1], source: 'named-bug' });
    }

    // --- Pattern 4: Numbered bold items inside Scope — in ---
    if (inScopeIn) {
      const numberedBoldMatch = line.match(NUMBERED_BOLD_ITEM_RE);
      if (numberedBoldMatch) {
        const rawLabel = numberedBoldMatch[1];
        const contextMatch = rawLabel.match(CONTEXT_MARKER_RE);
        if (contextMatch) {
          items.push({ label: contextMatch[1], source: 'numbered-bold-item', contextOnly: true });
        } else {
          items.push({ label: rawLabel, source: 'numbered-bold-item' });
        }
      }
    }
  }

  // Deduplicate by label, preserving first-seen order. Assign a deterministic
  // id (s1, s2, …) reflecting unique first-seen order — authoritative for the
  // run; the gate maps planner-declared scopeItemIds back to these.
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    if (!seen.has(item.label)) {
      seen.add(item.label);
      const rebuilt = { id: `s${unique.length + 1}`, label: item.label, source: item.source };
      if (item.contextOnly) {
        rebuilt.contextOnly = true;
      }
      unique.push(rebuilt);
    }
  }
  return unique;
}

// Negative-marker regex: a constraint string is a rejected phrase iff it
// contains one of these prohibition markers (case-insensitive). The capturing
// group holds everything AFTER the marker — only that suffix becomes the
// phrase, so the marker words themselves never pollute the token set.
const NEGATIVE_MARKER_RE = /\b(?:do ?not|don'?t|never|must not|cannot|avoid)\b\s*(.+)/i;

/**
 * Extract rejected phrases from a spec's `constraints[]` array.
 *
 * For each constraint string, if it contains a negative marker
 * (`do not`/`don't`/`never`/`must not`/`cannot`/`avoid`, case-insensitive) the
 * text AFTER the marker is treated as a rejected phrase (the marker words are
 * excluded so they don't pollute the tokens). The phrase is taken up to the
 * first em-dash (—) or period (rationale after those is discarded), tokenised
 * into lowercase words with stopwords removed, and kept only if it yields at
 * least 2 distinctive tokens. Constraints with no marker — or with nothing
 * after the marker (e.g. a bare "Never") — are skipped.
 *
 * @param {string[]} constraints
 * @returns {Array<{ phrase: string, tokens: Set<string> }>}
 */
export function extractRejectedPhrases(constraints) {
  if (!Array.isArray(constraints) || constraints.length === 0) {
    return [];
  }

  const results = [];

  for (const constraint of constraints) {
    if (typeof constraint !== 'string' || constraint.length === 0) continue;
    const m = constraint.match(NEGATIVE_MARKER_RE);
    if (!m) continue;

    const phrase = m[1].split(/\s*[—.]/)[0].trim();
    const tokens = phrase
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 0 && !STOPWORDS.has(w));

    if (tokens.length >= 2) {
      results.push({ phrase, tokens: new Set(tokens) });
    }
  }

  return results;
}
