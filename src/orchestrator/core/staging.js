/**
 * staging.js — Utilities for staging task content before execution.
 *
 * Public API:
 *   contentHash(content)    → 16-character hex string (SHA-256 of "rule|why")
 *   writeFrontmatter(fm)    → YAML string wrapped in --- delimiters
 *   stageCandidate(opts)    → { id, path } — writes a .pending candidate file
 *
 * Internal helpers:
 *   generateTimestampedId() → filename-safe ID: <iso-timestamp-without-colons>-<6-char-hex>
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { harnessRoot } from './run-context.js';

/**
 * Generates a filename-safe timestamped ID of the form:
 *   <iso-timestamp-without-colons>-<6-char-random-hex>
 * e.g. `2026-04-06T14-22-33-abc123`
 *
 * The timestamp portion is derived from `new Date().toISOString()` with
 * colons replaced by hyphens and milliseconds/timezone stripped so only
 * the seconds-precision portion is retained.
 *
 * @returns {string}
 */
export function generateTimestampedId() {
  // e.g. "2026-04-06T14:22:33.000Z" → take first 19 chars → "2026-04-06T14:22:33"
  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const hex = crypto.randomBytes(3).toString('hex'); // 3 bytes → 6 hex chars
  return `${ts}-${hex}`;
}

/**
 * Returns a 16-character hex string derived from the SHA-256 hash of
 * `${content.rule}|${content.why}`.
 *
 * @param {{ rule: string, why: string }} content
 * @returns {string} 16-character lowercase hex string
 */
export function contentHash(content) {
  const input = `${content.rule}|${content.why}`;
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Serialize a scalar value for YAML output.
 * - null/undefined → 'null'
 * - strings that need quoting (contain `: `, `#`, leading/trailing spaces,
 *   or start with a YAML indicator character) are double-quoted.
 * - all other strings are emitted bare.
 *
 * @param {*} v
 * @returns {string}
 */
function yamlScalar(v) {
  if (v == null) return 'null';
  const s = String(v);
  // Characters/patterns that require quoting in plain YAML scalars
  const needsQuoting =
    s === '' ||
    /^[ \t]|[ \t]$/.test(s) ||           // leading or trailing whitespace
    /^[>|{}\[\]"'&*!%@`#,]/.test(s) ||   // starts with special indicator
    /: /.test(s) ||                        // contains ': ' (mapping indicator)
    s === 'null' || s === 'true' || s === 'false' || // reserved words
    /^\d/.test(s);                         // starts with a digit (may be number)
  if (needsQuoting) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/**
 * Serialize the fixed-shape frontmatter object into a YAML string wrapped in
 * `---` delimiters.  Multiline `evidence.data` values are emitted using YAML
 * block scalar (`|`) syntax so that newlines are preserved exactly.
 *
 * Shape of `fm`:
 * ```
 * {
 *   id:       string,
 *   kind:     string,
 *   area:     string,
 *   stagedAt: string,   // ISO-8601
 *   source: {
 *     taskId:    string | null | undefined,
 *     sessionId: string | null | undefined,
 *   },
 *   evidence: {
 *     rule: string,
 *     why:  string,
 *     data: string,     // may contain newlines
 *   },
 * }
 * ```
 *
 * @param {object} fm
 * @returns {string}
 */
export function writeFrontmatter(fm) {
  const lines = [];

  lines.push('---');
  lines.push(`id: ${yamlScalar(fm.id)}`);
  lines.push(`kind: ${yamlScalar(fm.kind)}`);
  lines.push(`area: ${yamlScalar(fm.area)}`);
  lines.push(`stagedAt: ${yamlScalar(fm.stagedAt)}`);

  lines.push('source:');
  lines.push(`  taskId: ${yamlScalar(fm.source.taskId)}`);
  lines.push(`  sessionId: ${yamlScalar(fm.source.sessionId)}`);

  lines.push('evidence:');
  lines.push(`  rule: ${yamlScalar(fm.evidence.rule)}`);
  lines.push(`  why: ${yamlScalar(fm.evidence.why)}`);

  const data = fm.evidence.data;
  if (typeof data === 'string' && data.includes('\n')) {
    // YAML literal block scalar — each line is indented by 4 spaces under
    // the `evidence:` mapping (2 spaces for nesting + 2 spaces indent).
    lines.push('  data: |');
    // Split, preserving trailing empty lines via -1 limit; strip only a
    // single trailing newline that block scalar itself appends on parse.
    const dataLines = data.endsWith('\n') ? data.slice(0, -1).split('\n') : data.split('\n');
    for (const dl of dataLines) {
      lines.push(`    ${dl}`);
    }
  } else {
    lines.push(`  data: ${yamlScalar(data)}`);
  }

  lines.push('---');
  return lines.join('\n') + '\n';
}

/**
 * Unquote/unescape a raw YAML scalar token.
 *   - "null" → null
 *   - double-quoted string → unescaped inner value
 *   - everything else → raw string as-is
 *
 * @param {string} s  trimmed token after the `: ` separator
 * @returns {string|null}
 */
function parseYamlScalar(s) {
  if (s === 'null') return null;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    // Remove enclosing quotes and unescape \" and \\
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    // Single-quoted: '' is the only escape sequence
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/**
 * Parse a pending candidate file (frontmatter + markdown body) into a
 * structured object.
 *
 * Handles:
 *   - Bare and quoted scalar values
 *   - Nested `source.*` and `evidence.*` keys
 *   - YAML block scalar `|` for `evidence.data`
 *
 * Returns **null** on malformed input:
 *   - Empty / whitespace-only input
 *   - Missing opening `---` delimiter
 *   - Missing closing `---` delimiter
 *   - Any required field is absent
 *
 * @param {string} fileContent  full text of the .pending file
 * @returns {{ id, kind, area, stagedAt, source: { taskId, sessionId },
 *             evidence: { rule, why, data }, body: string } | null}
 */
export function parseFrontmatter(fileContent) {
  // Reject empty / whitespace-only input
  if (!fileContent || typeof fileContent !== 'string' || fileContent.trim() === '') return null;

  // Opening delimiter must be the very first line
  if (!fileContent.startsWith('---')) return null;
  const firstNl = fileContent.indexOf('\n');
  if (firstNl === -1) return null;
  if (fileContent.slice(0, firstNl).trimEnd() !== '---') return null;

  // Find the closing --- (exact match on its own line)
  const afterOpening = fileContent.slice(firstNl + 1);
  const closingMatch = afterOpening.match(/^---[ \t]*$/m);
  if (!closingMatch) return null;

  const closingIdx = closingMatch.index;
  const yamlBlock = afterOpening.slice(0, closingIdx);

  // Everything after the closing --- (skip the newline immediately after it)
  const afterClosing = afterOpening.slice(closingIdx + closingMatch[0].length);
  const body = afterClosing.startsWith('\n') ? afterClosing.slice(1) : afterClosing;

  // ── Line-by-line YAML parser ────────────────────────────────────────────
  const result = {
    id:       undefined,
    kind:     undefined,
    area:     undefined,
    stagedAt: undefined,
    source:   { taskId: undefined, sessionId: undefined },
    evidence: { rule: undefined, why: undefined, data: undefined },
  };

  const lines = yamlBlock.split('\n');
  let i = 0;
  let section = null; // 'source' | 'evidence' | null

  while (i < lines.length) {
    const line = lines[i];

    // Trailing empty line (from the trailing \n before ---)
    if (line === '') { i++; continue; }

    // Top-level key: starts with a letter at column 0
    if (/^[A-Za-z]/.test(line)) {
      const colon = line.indexOf(':');
      if (colon === -1) { i++; continue; }

      const key      = line.slice(0, colon).trim();
      const valueStr = line.slice(colon + 1).trim();

      if (valueStr === '') {
        // Mapping header — subsequent indented lines belong to this section
        if (key === 'source' || key === 'evidence') section = key;
        else section = null;
        i++;
        continue;
      }

      // Scalar top-level key — reset section
      section = null;
      switch (key) {
        case 'id':       result.id       = parseYamlScalar(valueStr); break;
        case 'kind':     result.kind     = parseYamlScalar(valueStr); break;
        case 'area':     result.area     = parseYamlScalar(valueStr); break;
        case 'stagedAt': result.stagedAt = parseYamlScalar(valueStr); break;
      }
      i++;
      continue;
    }

    // Nested key: exactly 2 spaces of indentation
    if (/^ {2}[A-Za-z]/.test(line)) {
      const colon = line.indexOf(':');
      if (colon === -1) { i++; continue; }

      const key      = line.slice(0, colon).trim();
      const valueStr = line.slice(colon + 1).trim();

      if (section === 'source') {
        if (key === 'taskId')    result.source.taskId    = parseYamlScalar(valueStr);
        if (key === 'sessionId') result.source.sessionId = parseYamlScalar(valueStr);
        i++;
        continue;
      }

      if (section === 'evidence') {
        if (key === 'rule') { result.evidence.rule = parseYamlScalar(valueStr); i++; continue; }
        if (key === 'why')  { result.evidence.why  = parseYamlScalar(valueStr); i++; continue; }
        if (key === 'data') {
          if (valueStr === '|') {
            // Collect 4-space-indented block scalar lines
            i++;
            const dataLines = [];
            while (i < lines.length) {
              const dl = lines[i];
              if (dl.startsWith('    ')) {
                dataLines.push(dl.slice(4));
                i++;
              } else if (dl === '') {
                // Blank line — could be within block or trailing newline at end
                if (i === lines.length - 1) break; // trailing newline → stop
                dataLines.push('');
                i++;
              } else {
                // Non-indented non-blank line → end of block scalar
                break;
              }
            }
            // YAML literal block scalar `|` always appends a final newline
            result.evidence.data = dataLines.join('\n') + '\n';
            continue;
          }
          // Scalar data value
          result.evidence.data = parseYamlScalar(valueStr);
          i++;
          continue;
        }
        i++;
        continue;
      }

      i++;
      continue;
    }

    i++;
  }

  // Validate all required fields are present
  const SENTINEL = undefined;
  if (
    result.id       === SENTINEL ||
    result.kind     === SENTINEL ||
    result.area     === SENTINEL ||
    result.stagedAt === SENTINEL ||
    result.source.taskId    === SENTINEL ||
    result.source.sessionId === SENTINEL ||
    result.evidence.rule    === SENTINEL ||
    result.evidence.why     === SENTINEL ||
    result.evidence.data    === SENTINEL
  ) {
    return null;
  }

  return {
    id:       result.id,
    kind:     result.kind,
    area:     result.area,
    stagedAt: result.stagedAt,
    source:   { taskId: result.source.taskId, sessionId: result.source.sessionId },
    evidence: { rule: result.evidence.rule, why: result.evidence.why, data: result.evidence.data },
    body,
  };
}

/**
 * Compute the target document path for a candidate based on its parsed frontmatter.
 *
 * Returns `docs/<kind>s/<area>.md` relative to `projectRoot`, where:
 *   - `kind` is pluralised by appending `'s'` (e.g. `'contract'` → `'contracts'`)
 *   - `area` from the frontmatter is used as the file slug; falls back to `'general'`
 *     when `area` is absent or empty.
 *
 * As a side-effect, the parent directory is created (recursively) if it does not
 * already exist.
 *
 * @param {string} projectRoot  Absolute path to the project root.
 * @param {{ kind: string, area: string }} fm  Parsed frontmatter (at minimum `kind` and `area`).
 * @returns {string}  Absolute path to the target document.
 */
export function resolveTargetPath(projectRoot, fm) {
  const area = (fm.area && fm.area.trim()) ? fm.area.trim() : 'general';
  const targetPath = path.join(projectRoot, 'docs', `${fm.kind}s`, `${area}.md`);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  return targetPath;
}

/**
 * List all valid pending candidates from `docs/<kind>s/.pending/`.
 *
 * Reads every `.md` file in the directory, parses its frontmatter, and
 * collects well-formed entries.  Malformed files (parse failure or missing
 * `stagedAt`) produce a stderr warning and are silently skipped.
 *
 * @param {string} projectRoot  Absolute path to the project root.
 * @param {string} kind         Document kind, e.g. `'contract'` or `'standard'`.
 * @returns {{
 *   id:       string,
 *   path:     string,
 *   kind:     string,
 *   area:     string,
 *   stagedAt: string,
 *   content:  string,
 *   evidence: { rule: string, why: string, data: string },
 *   source:   { taskId: string|null, sessionId: string|null },
 * }[]}
 */
export function listPending(projectRoot, kind) {
  const pendingDir = path.join(projectRoot, 'docs', `${kind}s`, '.pending');

  // Return empty array if the directory doesn't exist
  if (!fs.existsSync(pendingDir)) return [];

  let entries;
  try {
    entries = fs.readdirSync(pendingDir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter(f => f.endsWith('.md'));
  const results = [];

  for (const filename of mdFiles) {
    const filePath = path.join(pendingDir, filename);
    let fileContent;
    try {
      fileContent = fs.readFileSync(filePath, 'utf8');
    } catch {
      process.stderr.write(`[staging] WARNING: could not read file "${filename}", skipping\n`);
      continue;
    }

    const parsed = parseFrontmatter(fileContent);

    if (parsed === null || !parsed.stagedAt) {
      process.stderr.write(`[staging] WARNING: malformed or missing stagedAt in "${filename}", skipping\n`);
      continue;
    }

    results.push({
      id:       parsed.id,
      path:     filePath,
      kind:     parsed.kind,
      area:     parsed.area,
      stagedAt: parsed.stagedAt,
      content:  parsed.body,
      evidence: parsed.evidence,
      source:   parsed.source,
    });
  }

  // Sort ascending by stagedAt (oldest first)
  results.sort((a, b) => (a.stagedAt < b.stagedAt ? -1 : a.stagedAt > b.stagedAt ? 1 : 0));

  return results;
}

/**
 * Promote a pending candidate into its final target document.
 *
 * Reads the `.pending` file, extracts the markdown body via `parseFrontmatter`,
 * appends it to `docs/<kind>s/<area>.md` (or a `targetFile` override), and
 * then removes the source `.pending` file.
 *
 * If the target file does not yet exist it is created with a markdown H1
 * header of the form `# <Kind>s — <area>` before the body is appended.
 *
 * Accepts either the minimal `{ projectRoot, kind, candidateId }` form or the
 * full candidate object returned by `listPending` (which carries `id`, `path`,
 * `area`, etc.).  When both `candidateId` and `id` are present `candidateId`
 * takes precedence.
 *
 * @param {{
 *   projectRoot:   string,
 *   kind:          string,
 *   candidateId?:  string,
 *   id?:           string,
 *   path?:         string,
 *   area?:         string,
 *   targetFile?:   string,
 * }} opts
 * @returns {{ targetPath: string, candidateId: string }}
 */
export function promoteCandidate({
  projectRoot,
  kind,
  candidateId,
  id,
  path: pendingFilePath,
  area: areaHint,
  targetFile,
}) {
  // Resolve the candidate ID — accept either spelling
  const resolvedId = candidateId ?? id;
  if (!resolvedId) {
    throw new Error('[staging] promoteCandidate: candidateId (or id) is required');
  }

  // Locate the .pending file
  const resolvedPendingPath =
    pendingFilePath ||
    path.join(projectRoot, 'docs', `${kind}s`, '.pending', `${resolvedId}.md`);

  // Idempotency guard — if the pending file has already been removed (e.g. by a
  // previous successful promotion) treat the call as a no-op and return gracefully.
  if (!fs.existsSync(resolvedPendingPath)) {
    return { targetPath: null, candidateId: resolvedId };
  }

  // Read and parse
  const fileContent = fs.readFileSync(resolvedPendingPath, 'utf8');
  const parsed = parseFrontmatter(fileContent);
  if (!parsed) {
    throw new Error(
      `[staging] promoteCandidate: failed to parse frontmatter in "${resolvedPendingPath}"`
    );
  }

  const finalBody = parsed.body;
  const area = areaHint || parsed.area;

  // Determine the target file path
  const resolvedTargetPath = targetFile
    ? path.resolve(projectRoot, targetFile)
    : path.join(projectRoot, 'docs', `${kind}s`, `${area}.md`);

  // Ensure target directory exists
  fs.mkdirSync(path.dirname(resolvedTargetPath), { recursive: true });

  // Idempotency marker used to detect whether this candidate has already been
  // appended to the target document.
  const marker = `<!-- candidate:${resolvedId} -->`;

  // Check whether the candidate is already present in the target file.
  // If so, skip the append step and only remove the pending file.
  const alreadyPromoted =
    fs.existsSync(resolvedTargetPath) &&
    fs.readFileSync(resolvedTargetPath, 'utf8').includes(marker);

  if (!alreadyPromoted) {
    // Create with H1 header when the file is new
    if (!fs.existsSync(resolvedTargetPath)) {
      const kindTitle = kind.charAt(0).toUpperCase() + kind.slice(1);
      const header = `# ${kindTitle}s — ${area}\n`;
      fs.writeFileSync(resolvedTargetPath, header, 'utf8');
    }

    // Read existing content and normalise trailing whitespace:
    //   (1) strip all trailing newlines from existing content → add exactly one
    //   (2) add one blank line separator
    //   (3) append marker + normalised body (exactly one trailing newline)
    const existingRaw = fs.readFileSync(resolvedTargetPath, 'utf8');
    const existingNormalised = existingRaw.replace(/\n+$/, '') + '\n';
    const bodyNormalised = finalBody.replace(/\n+$/, '') + '\n';
    const newContent = existingNormalised + '\n' + marker + '\n' + bodyNormalised;
    fs.writeFileSync(resolvedTargetPath, newContent, 'utf8');
  }

  // Remove the .pending source file
  fs.unlinkSync(resolvedPendingPath);

  return { targetPath: resolvedTargetPath, candidateId: resolvedId };
}

/**
 * Decline a pending candidate by recording it in `.harness/staging/declined.jsonl`
 * and removing the `.pending` file.
 *
 * Behaviour:
 *   - Reads `docs/<kind>s/.pending/<candidateId>.md` and parses its frontmatter.
 *   - Lazily creates `.harness/staging/` if it does not exist.
 *   - Appends one JSON record (no trailing comma) to `declined.jsonl`.
 *   - Removes the `.pending` file.
 *   - Idempotent: if the pending file is already gone the function returns
 *     gracefully without throwing.
 *
 * @param {{
 *   projectRoot:  string,
 *   kind:         string,
 *   candidateId:  string,
 *   reason:       string,
 * }} opts
 * @returns {{ declinedPath: string }}
 */
export function declineCandidate({ projectRoot, kind, candidateId, reason }) {
  const pendingFilePath = path.join(projectRoot, 'docs', `${kind}s`, '.pending', `${candidateId}.md`);

  // Idempotency guard — nothing to do if the file is already gone
  if (!fs.existsSync(pendingFilePath)) {
    const stagingDir = path.join(harnessRoot(projectRoot), 'staging');
    const declinedPath = path.join(stagingDir, 'declined.jsonl');
    return { declinedPath };
  }

  // Read and parse the pending file
  const fileContent = fs.readFileSync(pendingFilePath, 'utf8');
  const parsed = parseFrontmatter(fileContent);
  if (!parsed) {
    throw new Error(
      `[staging] declineCandidate: failed to parse frontmatter in "${pendingFilePath}"`
    );
  }

  // Lazily create .harness/staging/
  const stagingDir = path.join(harnessRoot(projectRoot), 'staging');
  fs.mkdirSync(stagingDir, { recursive: true });

  const declinedPath = path.join(stagingDir, 'declined.jsonl');

  // Build the declined record
  const record = {
    id:          parsed.id,
    kind:        parsed.kind,
    area:        parsed.area,
    reason,
    declinedAt:  new Date().toISOString(),
    source:      { taskId: parsed.source.taskId, sessionId: parsed.source.sessionId },
    contentHash: contentHash({ rule: parsed.evidence.rule, why: parsed.evidence.why }),
  };

  // Append to declined.jsonl (one JSON object per line, newline-delimited)
  fs.appendFileSync(declinedPath, JSON.stringify(record) + '\n', 'utf8');

  // Remove the .pending source file
  fs.unlinkSync(pendingFilePath);

  return { declinedPath };
}

/**
 * Check whether a given source + contentHash combination has been declined.
 *
 * Reads `.harness/staging/declined.jsonl` line-by-line and returns `true` if
 * any record matches all three of:
 *   - `record.source.phase  === source.phase`
 *   - `record.source.taskId === source.taskId`
 *   - `record.contentHash   === contentHash`
 *
 * Returns `false` when:
 *   - `declined.jsonl` does not exist
 *   - no matching record is found
 *
 * Malformed/unparseable lines are silently skipped.
 *
 * @param {{
 *   projectRoot:  string,
 *   source:       { phase: string, taskId: string },
 *   contentHash:  string,
 * }} opts
 * @returns {boolean}
 */
export function isDeclined({ projectRoot, source, contentHash: hash }) {
  const declinedPath = path.join(harnessRoot(projectRoot), 'staging', 'declined.jsonl');

  if (!fs.existsSync(declinedPath)) return false;

  let raw;
  try {
    raw = fs.readFileSync(declinedPath, 'utf8');
  } catch {
    return false;
  }

  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      // Malformed line — skip gracefully
      continue;
    }

    if (
      record &&
      record.source &&
      record.source.phase === source.phase &&
      record.source.taskId === source.taskId &&
      record.contentHash === hash
    ) {
      return true;
    }
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stage a candidate document into `docs/<kind>s/.pending/`.
 *
 * @param {{
 *   projectRoot: string,
 *   kind:        string,
 *   content:     { ruleName: string, rule: string, why: string, whereItBites: string, area?: string },
 *   evidence:    { rule: string, why: string, data?: string },
 *   source:      { taskId?: string|null, sessionId?: string|null },
 * }} opts
 * @returns {{ id: string, path: string }}
 */
export function stageCandidate({ projectRoot, kind, content, evidence, source }) {
  // Build the .pending directory path: docs/<kind>s/.pending/
  const pendingDir = path.join(projectRoot, 'docs', `${kind}s`, '.pending');
  fs.mkdirSync(pendingDir, { recursive: true });

  const id = generateTimestampedId();

  const fm = {
    id,
    kind,
    area: content.area || '',
    stagedAt: new Date().toISOString(),
    source: {
      taskId: source.taskId ?? null,
      sessionId: source.sessionId ?? null,
    },
    evidence: {
      rule: evidence.rule,
      why: evidence.why,
      data: evidence.data ?? '',
    },
  };

  const frontmatter = writeFrontmatter(fm);

  const body = [
    `## ${content.ruleName}`,
    '',
    `Rule: ${content.rule}`,
    '',
    `Why: ${content.why}`,
    '',
    `Where it bites: ${content.whereItBites}`,
    '',
  ].join('\n');

  const fileContent = frontmatter + '\n' + body;

  const filePath = path.join(pendingDir, `${id}.md`);
  fs.writeFileSync(filePath, fileContent, 'utf8');

  return { id, path: filePath };
}
