/**
 * candidates-ledger.js — Append-only cross-run "brainstorm candidate" ledger.
 *
 * When the pipeline recognizes a recurring failure signature worth surfacing
 * for future brainstorming, it appends a fact to archives/candidates.jsonl.
 * One JSONL entry per line:
 *   { ts, slug, signature: { phase, errorClass, analyzerRecommendation,
 *     taskState }, signatureHash, summary, evidence: { archiveId, stashRef,
 *     analyzerSidecar } }
 *
 * This is a pure fact log: no dedup, no counters, no status lifecycle, no
 * LLM calls. Writing is best-effort and fail-soft — a ledger write must
 * never alter caller control flow (mirrors the createParkSnapshot pattern
 * used elsewhere in the pipeline).
 *
 * Pure JS — no AI.
 *
 * Public API:
 *   candidatesLedgerPath(projectRoot)
 *   hashSignature(signature)
 *   appendCandidate(projectRoot, entry, { onWarn })
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/** Absolute path of the candidates ledger file for a project. */
export function candidatesLedgerPath(projectRoot) {
  return path.join(projectRoot, 'archives', 'candidates.jsonl');
}

/**
 * Deterministic content hash over EXACTLY the four signature fields
 * (phase, errorClass, analyzerRecommendation, taskState). No other field
 * (summary, slug, evidence, ts) influences the hash: two signatures whose
 * four fields are equal produce the same hash, and a difference in any one
 * of the four fields produces a different hash.
 *
 * @param {{ phase?: string, errorClass?: string, analyzerRecommendation?: (string|null), taskState?: (string|null) }} signature
 * @returns {string}  hex-encoded sha256 digest
 */
export function hashSignature(signature) {
  const canonical = JSON.stringify([
    signature?.phase ?? null,
    signature?.errorClass ?? null,
    signature?.analyzerRecommendation ?? null,
    signature?.taskState ?? null,
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Append one candidate fact to the ledger. Best-effort: all filesystem work
 * is wrapped in try/catch; on failure exactly one warning is emitted via
 * `onWarn` and the function returns without throwing — the caller's flow is
 * never altered.
 *
 * @param {string} projectRoot
 * @param {{
 *   slug?: (string|null),
 *   signature: { phase?: string, errorClass?: string, analyzerRecommendation?: (string|null), taskState?: (string|null) },
 *   summary?: string,
 *   evidence?: { archiveId?: (string|null), stashRef?: (string|null), analyzerSidecar?: (string|null) },
 * }} entry
 * @param {{ onWarn?: (message: string) => void }} [options]
 * @returns {void}
 */
export function appendCandidate(projectRoot, entry, options = {}) {
  const { onWarn = () => {} } = options;
  try {
    const signature = {
      phase: entry?.signature?.phase ?? null,
      errorClass: entry?.signature?.errorClass ?? null,
      analyzerRecommendation: entry?.signature?.analyzerRecommendation ?? null,
      taskState: entry?.signature?.taskState ?? null,
    };
    const record = {
      ts: new Date().toISOString(),
      slug: entry?.slug ?? null,
      signature,
      signatureHash: hashSignature(signature),
      summary: entry?.summary ?? null,
      evidence: {
        archiveId: entry?.evidence?.archiveId ?? null,
        stashRef: entry?.evidence?.stashRef ?? null,
        analyzerSidecar: entry?.evidence?.analyzerSidecar ?? null,
      },
    };
    fs.mkdirSync(path.join(projectRoot, 'archives'), { recursive: true });
    fs.appendFileSync(candidatesLedgerPath(projectRoot), JSON.stringify(record) + '\n');
  } catch (err) {
    onWarn(`Failed to append candidate to candidates.jsonl: ${err.message}`);
  }
}
