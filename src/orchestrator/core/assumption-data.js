import fs from 'fs';
import path from 'path';
import { readState, writeJsonAtomic } from './state.js';
import { readSpecTargetFiles } from './spec-text.js';

/**
 * Normalise verify-result `uncertain` objects to the compact {text, specSection}
 * shape used by the this-run source of truth (state.uncertainAssumptions) and
 * the archive manifest. A verify-result's `assumption` is either a
 * {text, specSection} object or a bare string.
 *
 * @param {Array<{ assumption?: ({text?: string, specSection?: string}|string) }>} uncertains
 * @returns {Array<{ text: string, specSection: string }>}
 */
export function normalizeUncertains(uncertains) {
  return (uncertains ?? []).map((a) => ({
    text: a.assumption?.text ?? a.assumption ?? '',
    specSection: a.assumption?.specSection ?? '',
  }));
}

/**
 * Write the compact this-run uncertain list into state.uncertainAssumptions
 * via read-modify-write (so an intervening whole-state write does not leave
 * two divergent lists). Best-effort: silently skips when state.json is absent.
 *
 * @param {string} harnessDir - path to the .harness directory
 * @param {Array<{ text: string, specSection: string }>} normalized
 */
export function persistUncertainsToState(harnessDir, normalized) {
  const stateJsonPath = path.join(harnessDir, 'state.json');
  if (!fs.existsSync(stateJsonPath)) return;
  try {
    const state = readState(harnessDir);
    state.uncertainAssumptions = normalized;
    writeJsonAtomic(stateJsonPath, state);
  } catch { /* best-effort — surfacing still carried by the ledger */ }
}

/**
 * Read the spec file at specPath, split on ## headings, and return the
 * full text of the section whose heading matches sectionName.
 * Returns null if the file does not exist or the section is not found.
 *
 * @param {string} specPath     Absolute or relative path to the spec file.
 * @param {string} sectionName  The heading to look for, e.g. "## Session API".
 * @param {function} onLog      logging callback
 * @returns {string|null}
 */
export function extractSpecSection(specPath, sectionName, onLog) {
  if (!specPath || !fs.existsSync(specPath)) return null;

  const content = fs.readFileSync(specPath, 'utf8');
  // Split on any markdown heading (##, ###, ####) so nested sections are found.
  const sections = content.split(/(?=^#{2,4} )/m);

  // Normalize: strip leading # and whitespace for comparison.
  const strip = (s) => s.replace(/^#+\s*/, '').trim().toLowerCase();
  const target = strip(sectionName);

  // Pass 1: exact match (after stripping # prefix)
  for (const section of sections) {
    const firstLine = section.split('\n')[0];
    if (strip(firstLine) === target) {
      return section.trim();
    }
  }

  // Pass 2: substring match — target appears within the heading
  for (const section of sections) {
    const heading = strip(section.split('\n')[0]);
    if (heading.includes(target) || target.includes(heading)) {
      return section.trim();
    }
  }

  // Pass 3: word overlap — find the heading with most words in common
  const targetWords = new Set(target.split(/\s+/));
  let bestMatch = null;
  let bestOverlap = 0;
  for (const section of sections) {
    const heading = strip(section.split('\n')[0]);
    const headingWords = heading.split(/\s+/);
    const overlap = headingWords.filter(w => targetWords.has(w)).length;
    if (overlap > bestOverlap && overlap >= 2) {
      bestOverlap = overlap;
      bestMatch = section.trim();
    }
  }

  if (bestMatch) return bestMatch;

  // Pass 4: bullet-bold pattern — split on /^- \*\*(.+?):\*\*/ and run
  // exact/substring/overlap matching against extracted heading text.
  const bulletSections = content.split(/(?=^- \*\*[^*]+:\*\*)/m);
  const stripBullet = (s) => {
    const m = s.match(/^- \*\*(.+?):\*\*/);
    return m ? m[1].trim().toLowerCase() : null;
  };

  // Pass 4a: exact match
  for (const section of bulletSections) {
    const heading = stripBullet(section);
    if (heading === target) {
      return section.trim();
    }
  }

  // Pass 4b: substring match
  for (const section of bulletSections) {
    const heading = stripBullet(section);
    if (heading && (heading.includes(target) || target.includes(heading))) {
      return section.trim();
    }
  }

  // Pass 4c: word overlap
  let bestBulletMatch = null;
  let bestBulletOverlap = 0;
  for (const section of bulletSections) {
    const heading = stripBullet(section);
    if (!heading) continue;
    const headingWords = heading.split(/\s+/);
    const overlap = headingWords.filter(w => targetWords.has(w)).length;
    if (overlap > bestBulletOverlap && overlap >= 2) {
      bestBulletOverlap = overlap;
      bestBulletMatch = section.trim();
    }
  }

  if (bestBulletMatch) return bestBulletMatch;

  // Pass 5: numbered-bold pattern — the scope-parser / userSpec-renderer
  // dialect (`N. **Label** — behavior` under `## Scope — in`). A numbered
  // item's section runs until the NEXT numbered item or the next heading,
  // whichever comes first. Deliberately LAST in precedence: it is only
  // reached when both older families failed, which is exactly the
  // uspec-projected-spec case this family exists for.
  const numberedSections = content
    .split(/(?=^\d+\. \*\*|^#{2,4} )/m)
    .filter((s) => /^\d+\. \*\*/.test(s));
  const stripNumbered = (s) => {
    const m = s.match(/^\d+\. \*\*(.+?)\*\*/);
    return m ? m[1].trim().toLowerCase() : null;
  };

  // Pass 5a: exact match
  for (const section of numberedSections) {
    if (stripNumbered(section) === target) {
      return section.trim();
    }
  }

  // Pass 5b: substring match
  for (const section of numberedSections) {
    const heading = stripNumbered(section);
    if (heading && (heading.includes(target) || target.includes(heading))) {
      return section.trim();
    }
  }

  // Pass 5c: word overlap
  let bestNumberedMatch = null;
  let bestNumberedOverlap = 0;
  for (const section of numberedSections) {
    const heading = stripNumbered(section);
    if (!heading) continue;
    const headingWords = heading.split(/\s+/);
    const overlap = headingWords.filter(w => targetWords.has(w)).length;
    if (overlap > bestNumberedOverlap && overlap >= 2) {
      bestNumberedOverlap = overlap;
      bestNumberedMatch = section.trim();
    }
  }

  if (bestNumberedMatch) return bestNumberedMatch;

  // All passes failed — emit a grep-able warning and return null.
  onLog(`[extractSpecSection] Warning: section "${sectionName}" not found in "${specPath}" after trying all three pattern families ('## heading', '- **Heading:**', and 'N. **Label**').`);
  return null;
}

/**
 * Read the spec file and extract backtick-wrapped file paths, or fall back
 * to spec.json target_files if available. The result is memoized on the
 * passed-in `cache` holder object (as `cache.value`) ONLY when the state read
 * yielded a truthy prdPath — i.e. the read was anchored to an actual spec.
 * Without a prdPath the result is computed and returned but NOT cached, so a
 * later call made once the state carries a spec path is not served a stale
 * spec-less read. readState's throw on a missing state.json still propagates.
 *
 * @param {string} harnessDir - path to the .harness directory
 * @param {string} projectRoot - absolute path to project root
 * @param {{ value?: string[] }} cache - memoization holder shared across calls
 * @returns {string[]} Array of target file paths (may be empty).
 */
export function getSpecTargetFiles(harnessDir, projectRoot, cache) {
  if (cache.value !== undefined) return cache.value;
  const state = readState(harnessDir);
  const prdPath = state.projectMeta?.prdPath;
  const result = readSpecTargetFiles(prdPath, projectRoot);
  if (prdPath) cache.value = result;
  return result;
}

/**
 * Apply a text replacement to a spec file, logging outcome via onLog.
 *
 * @param {string} specPath - path to the spec file
 * @param {string} oldText - text to find and replace
 * @param {string} newText - replacement text
 * @param {{ subsystem?: string, section?: string, summary?: string }} options
 * @param {function} onLog - logging callback
 * @returns {boolean} true if the edit was applied, false otherwise
 */
export function applySpecEdit(specPath, oldText, newText, options = {}, onLog) {
  const {
    subsystem = 'unknown',
    section = '(none)',
    summary = 'spec updated',
  } = options;

  if (!specPath || !fs.existsSync(specPath)) {
    onLog(`  [WARN] _applySpecEdit: spec file not found at "${specPath}"`);
    return false;
  }

  const content = fs.readFileSync(specPath, 'utf8');

  if (!content.includes(oldText)) {
    onLog(`  [WARN] _applySpecEdit: old string not found in spec — no replacement made.`);
    return false;
  }

  const updated = content.replace(oldText, newText);
  fs.writeFileSync(specPath, updated, 'utf8');
  onLog(`  [specEdit] [${subsystem}] section="${section}" — ${summary}`);
  return true;
}
