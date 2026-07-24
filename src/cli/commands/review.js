/**
 * review.js — CLI command to display pending staged candidates for human review.
 *
 * Usage:
 *   cc-orch --review              List all pending candidates
 *   cc-orch --review -p <path>    Review candidates in a specific project root
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';
import { listPending, promoteCandidate, declineCandidate, parseFrontmatter } from '../../orchestrator/core/staging.js';

/**
 * Format a date string as a relative time string (e.g. '2h ago', '3d ago').
 *
 * @param {string} isoString  ISO-8601 date string
 * @param {Date}   [now]      Override for 'now' (useful in tests)
 * @returns {string}
 */
export function formatRelativeTime(isoString, now = new Date()) {
  const then = new Date(isoString);
  const diffMs = now - then;

  if (diffMs < 0) return 'just now';

  const diffSecs  = Math.floor(diffMs / 1000);
  const diffMins  = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays  = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffSecs  <  60) return `${diffSecs}s ago`;
  if (diffMins  <  60) return `${diffMins}m ago`;
  if (diffHours <  24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

/**
 * Truncate evidence data to approximately the first 10 lines, appending '…'
 * when lines are omitted.
 *
 * @param {string} data  Raw evidence data string
 * @param {number} [max=10]  Maximum lines to display
 * @returns {string}
 */
export function truncateEvidence(data, max = 10) {
  if (!data || typeof data !== 'string') return '';
  const lines = data.split('\n');
  // Remove a single trailing empty line produced by YAML block scalar
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length <= max) {
    return lines.join('\n');
  }
  return lines.slice(0, max).join('\n') + '\n…';
}

/**
 * Build the display string for a single pending candidate.
 *
 * Format:
 *   [kind] area (staged <relative time> ago)
 *   from <source.taskId>
 *   <truncated evidence.data>
 *   ---
 *   <body>
 *
 * @param {object} candidate  Candidate object from listPending
 * @param {Date}   [now]      Override for 'now' (useful in tests)
 * @returns {string}
 */
export function formatCandidate(candidate, now = new Date()) {
  const relTime = formatRelativeTime(candidate.stagedAt, now);
  const header  = `[${candidate.kind}] ${candidate.area} (staged ${relTime})`;

  const sourceLine = candidate.source && candidate.source.taskId
    ? `from ${candidate.source.taskId}`
    : 'from (unknown)';

  const evidenceDisplay = truncateEvidence(candidate.evidence && candidate.evidence.data || '');

  const lines = [
    header,
    sourceLine,
    evidenceDisplay,
    '---',
    candidate.content || '',
  ];

  return lines.join('\n');
}

/**
 * Prompt the user for a target filename, using defaultName when the user
 * submits an empty response.
 *
 * @param {object} rl           readline.Interface instance
 * @param {string} defaultName  Default filename shown in the prompt
 * @returns {Promise<string>}   Resolves to the chosen filename
 */
export async function promptFilename(rl, defaultName) {
  return new Promise((resolve) => {
    rl.question(`Target filename [${defaultName}]: `, (answer) => {
      const trimmed = (answer || '').trim();
      resolve(trimmed || defaultName);
    });
  });
}

/**
 * Prompt the user for a single keypress decision via readline.
 *
 * Keeps re-prompting on unrecognized input until a valid key is entered or
 * EOF is reached.  Valid keys: a, r, e, d, q.
 *
 * @param {object} rl   readline.Interface instance
 * @param {object} out  Writable stream for output (defaults to process.stdout)
 * @returns {Promise<string>}  Resolves to one of: 'a', 'r', 'e', 'd', 'q'
 */
export async function promptDecision(rl, out = process.stdout) {
  const PROMPT = '[a]ccept / [r]eject / [e]dit / [d]efer / [q]uit ? ';
  const VALID  = new Set(['a', 'r', 'e', 'd', 'q']);

  return new Promise((resolve) => {
    const ask = () => {
      rl.question(PROMPT, (answer) => {
        const key = (answer || '').trim().toLowerCase();
        if (VALID.has(key)) {
          resolve(key);
        } else {
          out.write(`Unrecognized input: "${answer}". Please enter a, r, e, d, or q.\n`);
          ask();
        }
      });
    };
    ask();
  });
}

/**
 * Main review command.  Lists all pending candidates (contracts first, then
 * standards), then enters an interactive prompt loop for each one.
 *
 * Actions:
 *   [a]ccept  — promote the candidate (stub; not yet implemented)
 *   [r]eject  — decline the candidate (stub; not yet implemented)
 *   [e]dit    — open editor for candidate (stub; not yet implemented)
 *   [d]efer   — skip this candidate, leave pending file in place
 *   [q]uit    — stop processing remaining candidates
 *
 * @param {string}  projectRoot   Absolute path to the project root.
 * @param {Date}    [now]         Override for 'now' (useful in tests).
 * @param {object}  [ioOptions]   Optional { rl, out, promoteCandidate, declineCandidate } for dependency injection in tests.
 * @returns {Promise<{ promoted: number, declined: number, deferred: number }>}
 */
export async function review(projectRoot, now = new Date(), ioOptions = {}) {
  const contracts = listPending(projectRoot, 'contract');
  const standards = listPending(projectRoot, 'standard');

  if (contracts.length === 0 && standards.length === 0) {
    console.log('No pending candidates.');
    return { promoted: 0, declined: 0, deferred: 0 };
  }

  const all = [...contracts, ...standards];

  // Allow callers (tests) to supply a pre-built readline interface and output stream.
  const out = ioOptions.out || process.stdout;
  const rl  = ioOptions.rl  || readline.createInterface({
    input:  process.stdin,
    output: out,
  });
  // Allow callers (tests) to inject a custom promoteCandidate implementation.
  const promote = ioOptions.promoteCandidate || promoteCandidate;
  // Allow callers (tests) to inject a custom declineCandidate implementation.
  const decline = ioOptions.declineCandidate || declineCandidate;

  let promoted = 0;
  let declined = 0;
  let deferred = 0;

  let quit = false;

  try {
    for (const candidate of all) {
      if (quit) break;
      out.write('\n' + formatCandidate(candidate, now) + '\n\n');

      let moveOn = false;
      while (!moveOn && !quit) {
        const decision = await promptDecision(rl, out);

        if (decision === 'q') {
          out.write('Quitting review.\n');
          quit = true;
          break;
        }

        if (decision === 'd') {
          out.write(`Deferred: ${candidate.id}\n`);
          deferred += 1;
          moveOn = true;
          continue;
        }

        if (decision === 'a') {
          const defaultFilename = `${candidate.area}.md`;
          const targetFile = await promptFilename(rl, defaultFilename);
          try {
            const { targetPath } = promote({
              projectRoot,
              kind: candidate.kind,
              candidateId: candidate.id,
              targetFile,
            });
            out.write(`Accepted: written to ${targetPath}\n`);
            promoted += 1;
            moveOn = true;
          } catch (err) {
            out.write(`Accept failed: ${err.message}\n`);
            // Leave the pending file in place and re-prompt this candidate.
          }
          continue;
        }

        if (decision === 'r') {
          const reason = await new Promise((resolve) => {
            rl.question('Rejection reason (optional): ', (answer) => {
              resolve((answer || '').trim());
            });
          });
          try {
            decline({
              projectRoot,
              kind: candidate.kind,
              candidateId: candidate.id,
              reason,
            });
            out.write(`Declined: ${candidate.id}\n`);
            declined += 1;
            moveOn = true;
          } catch (err) {
            out.write(`Decline failed: ${err.message}\n`);
            // Leave the pending file in place and re-prompt this candidate.
          }
          continue;
        }

        if (decision === 'e') {
          const editor = process.env.EDITOR || 'vi';
          const spawnSyncFn = ioOptions.spawnSync || spawnSync;
          const readFileFn  = ioOptions.readFileSync || fs.readFileSync;

          let result;
          try {
            result = spawnSyncFn(editor, [candidate.path], { stdio: 'inherit' });
          } catch (err) {
            out.write(`[edit] Failed to launch editor "${editor}": ${err.message}\n`);
            // Re-prompt without crashing
            continue;
          }

          if (result && result.error) {
            out.write(`[edit] Failed to launch editor "${editor}": ${result.error.message}\n`);
            // Re-prompt without crashing
            continue;
          }

          if (result && result.status !== 0) {
            out.write(`[edit] Editor exited with non-zero status ${result.status}\n`);
            // Re-prompt without crashing
            continue;
          }

          // Editor exited cleanly — re-read and re-parse the file
          let updatedContent;
          try {
            updatedContent = readFileFn(candidate.path, 'utf8');
          } catch (err) {
            out.write(`[edit] Could not re-read file after edit: ${err.message}\n`);
            continue;
          }

          const parsed = parseFrontmatter(updatedContent);
          if (parsed) {
            // Update the candidate fields in-place so the re-display reflects changes
            candidate.kind     = parsed.kind;
            candidate.area     = parsed.area;
            candidate.stagedAt = parsed.stagedAt;
            candidate.content  = parsed.body;
            candidate.evidence = parsed.evidence;
            candidate.source   = parsed.source;
          }

          // Re-display updated candidate info and loop back to re-prompt
          out.write('\n' + formatCandidate(candidate, now) + '\n\n');
          continue;
        }
      }
    }
  } finally {
    // Only close the rl interface if we created it ourselves.
    if (!ioOptions.rl) {
      rl.close();
    }
  }

  out.write(`Promoted ${promoted}, declined ${declined}, deferred ${deferred}.\n`);
  return { promoted, declined, deferred };
}
