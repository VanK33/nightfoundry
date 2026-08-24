import { displayName } from '../orchestrator/infra/display-name.js';

/**
 * Pure transition-detection logic for the side-rail notification watcher.
 *
 * Given two consecutive /api/siderail snapshots (`prev`, `curr`), computes
 * which of the three watched edges fired between them:
 *   - pendingDecision: falsy -> truthy
 *   - error: falsy -> truthy
 *   - complete: active === true -> active === false
 *
 * This is edge-triggered (not level-triggered): it is the sole dedup
 * mechanism, so a flag that is already true stays silent on subsequent
 * ticks, and ordinary progress-count changes never produce a transition.
 *
 * No I/O is performed here; the caller (server watcher) is responsible for
 * fetching snapshots and posting the resulting messages to a webhook.
 *
 * @param {object|null|undefined} prev - previous siderail snapshot, or
 *   null/undefined for the baseline (first) snapshot.
 * @param {object} curr - current siderail snapshot. Expected fields:
 *   active, progress, pendingDecision, error, timing, current.
 * @returns {Array<{ type: string, message: string }>} transition descriptors
 */
export function detectTransitions(prev, curr) {
  // No baseline to compare against yet -> never a transition.
  if (prev === null || prev === undefined) {
    return [];
  }

  const transitions = [];

  // pendingDecision: false/falsy -> true/truthy
  if (!prev.pendingDecision && curr.pendingDecision) {
    transitions.push({
      type: 'pendingDecision',
      message: buildLineageMessage('Decision needed', curr) + NEXT_STEP_HINTS.pendingDecision,
    });
  }

  // error: false/falsy -> true/truthy
  if (!prev.error && curr.error) {
    transitions.push({
      type: 'error',
      message: buildLineageMessage('Run hit an error', curr) + NEXT_STEP_HINTS.error,
    });
  }

  // complete: active true -> active false (a run that ended/was archived)
  if (prev.active === true && curr.active === false) {
    transitions.push({
      type: 'complete',
      message: buildLineageMessage('Run complete / archived', curr) + NEXT_STEP_HINTS.complete,
    });
  }

  return transitions;
}

// What the recipient should DO next, appended to each notification so the
// phone message is actionable, not just informational. Commands must stay
// generic (the snapshot does not carry a slug on every path).
const NEXT_STEP_HINTS = {
  pendingDecision: ` — act: \`${displayName()} park list\` (or answer the prompt in the run terminal)`,
  error: ` — inspect: \`${displayName()} status\`, then \`${displayName()} archive list\` for a forensic archive`,
  complete: ` — review: \`${displayName()} archive list\``,
};

/**
 * Builds a short human-readable message, optionally appending the current
 * task's lineage (mission/milestone description) when present.
 *
 * @param {string} base - base message text.
 * @param {object} curr - current snapshot, may carry a `current` lineage.
 * @returns {string}
 */
function buildLineageMessage(base, curr) {
  const lineage = describeLineage(curr && curr.current);
  return lineage ? `${base}: ${lineage}` : base;
}

/**
 * @param {object|null|undefined} current - the snapshot's `current` field.
 * @returns {string|null}
 */
function describeLineage(current) {
  if (!current) return null;
  const parts = [
    current.description,
    current.missionDescription,
    current.milestoneDescription,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : null;
}

/**
 * Default `postWebhook` implementation: POSTs a JSON body `{ message }` to
 * `webhookUrl` using the global `fetch`. Fail-soft: any thrown error (e.g.
 * network failure) or non-2xx response is caught/detected and logged via
 * `log`, never thrown or rejected to the caller.
 *
 * @param {string} webhookUrl
 * @param {string} message
 * @param {{ log?: (...args: any[]) => void }} [opts]
 * @returns {Promise<void>}
 */
export async function defaultPostWebhook(webhookUrl, message, opts = {}) {
  const log = opts.log || (() => {});
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!res || !res.ok) {
      const status = res && res.status;
      log(`notify: webhook POST to ${webhookUrl} failed with status ${status}`);
    }
  } catch (err) {
    log(`notify: webhook POST to ${webhookUrl} failed: ${err && err.message}`);
  }
}

/**
 * Starts a poll loop that watches for siderail transitions and posts a
 * webhook message for each one detected.
 *
 * Fail-soft: if `getSnapshot()` throws/rejects, the tick is skipped and
 * `prev` is left untouched so the next successful snapshot still diffs
 * correctly against the last known-good snapshot. If `postWebhook` throws/
 * rejects for a given transition, the error is caught and logged, and the
 * remaining transitions (and subsequent ticks) still proceed.
 *
 * @param {object} params
 * @param {() => Promise<object>} params.getSnapshot - fetches the current
 *   siderail snapshot.
 * @param {string} params.webhookUrl - target URL for webhook posts.
 * @param {number} params.intervalMs - poll interval in milliseconds.
 * @param {(webhookUrl: string, message: string) => Promise<void>} [params.postWebhook] -
 *   injectable webhook poster; defaults to `defaultPostWebhook`.
 * @param {(...args: any[]) => void} [params.log] - injectable logger;
 *   defaults to a no-op.
 * @returns {{ stop: () => void }}
 */
export function startNotifyWatcher({
  getSnapshot,
  webhookUrl,
  intervalMs,
  postWebhook,
  log,
}) {
  const doLog = log || (() => {});
  const doPostWebhook =
    postWebhook || ((url, message) => defaultPostWebhook(url, message, { log: doLog }));

  let prev = null;

  const tick = async () => {
    let snapshot;
    try {
      snapshot = await getSnapshot();
    } catch (err) {
      doLog(`notify: getSnapshot failed: ${err && err.message}`);
      return;
    }

    const transitions = detectTransitions(prev, snapshot);
    for (const transition of transitions) {
      try {
        await doPostWebhook(webhookUrl, transition.message);
      } catch (err) {
        doLog(`notify: postWebhook failed: ${err && err.message}`);
      }
    }

    prev = snapshot;
  };

  const timer = setInterval(tick, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

export default detectTransitions;
