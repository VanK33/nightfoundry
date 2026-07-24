/**
 * CircuitBreakerError — thrown by Pipeline._dispatchAnalyzer when a task's
 * retry budget is exhausted and the analyzer's verdict cannot be consumed
 * (human escalation, re_plan fallthrough, repeat-verdict escalation, or
 * analyzer failure).
 *
 * The message ALWAYS keeps the 'Circuit breaker:' prefix — existing catches
 * (and archive.js detectHaltInfo) match on that string. The typed fields let
 * batchResume route without re-parsing the message:
 *   .taskId            — the failed task's id
 *   .recommendation    — the analyzer's ORIGINAL recommendation ('re_plan' |
 *                        'human' | null when the analyzer itself failed)
 *   .eventId           — analysis sidecar id (.harness/analysis/<eventId>.json),
 *                        null when no analysis was produced
 *   .escalatedByRepeat — true when the repeat detector escalated a repeated
 *                        verdict to human regardless of .recommendation
 *
 * Lives in its own leaf module (same pattern as halt-error.js) so pipeline.js
 * and CLI callers can share it without import cycles.
 */
export class CircuitBreakerError extends Error {
  constructor(message, { taskId, recommendation = null, eventId = null, escalatedByRepeat = false } = {}) {
    super(message);
    this.name = 'CircuitBreakerError';
    this.taskId = taskId;
    this.recommendation = recommendation;
    this.eventId = eventId;
    this.escalatedByRepeat = escalatedByRepeat;
  }
}
