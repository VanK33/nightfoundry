/**
 * config.js — Central configuration for nightfoundry.
 *
 * Pure JS. No external scripts, no canonical-source paths — cc-orch is
 * self-contained. Execution parameters, tool scopes, model assignments,
 * budget limits.
 */
import path from 'path';
import os from 'os';

// --- Model IDs ---
// Full model IDs per tier, pinned for reproducibility. These were previously
// the SDK aliases ('opus'/'sonnet'/'haiku'), resolved by the SDK at call time;
// pinning the full ID makes the exact model each role runs explicit. Edit a
// constant here to repin every role that references it below.
const OPUS = 'claude-opus-5';
const SONNET = 'claude-sonnet-5[1m]';
const HAIKU = 'claude-haiku-4-5';

const config = {
  // Agents directory (future use — reviewer rules, etc.). Kept for now
  // as a convenient anchor for user-level overrides.
  agentsDir: path.join(os.homedir(), '.claude', 'agents'),

  // --- Budget limits (USD) per session ---
  // Calibrated up from initial conservative values after the first dogfood
  // hit the executor cap on a large file (test/test-staging.js, 1600 lines).
  // The bottleneck is cache-read tokens scaling with file size, not output.
  //
  /** @type {Record<string, number>}
   * budgets.summarizer (0.50): The summarizer is a lightweight read-only agent
   * whose sole job is to produce a concise progress digest at the end of each
   * session. It never writes files or executes side-effecting commands, so its
   * token usage is small and predictable — half a dollar is a generous ceiling.
   */
  budgets: {
    planner: 6.0,
    executor: 2.0,
    verifier: 1.25, // bumped from 0.75; absorbs spec + plan cache-read tokens introduced by verifier context expansion
    analyzer: 2.0,
    summarizer: 0.50,
    /**
     * budgets.reviewer (4.0): The reviewer reads the full milestone diff
     * across many files — target files, test files, schema files, spec docs,
     * and retros — to validate holistic correctness rather than per-task
     * acceptance criteria. A large milestone can touch 20+ files; 4 USD
     * is a generous ceiling that accommodates the cache-read scaling of
     * a full cross-file analysis without constraining the model mid-review.
     */
    reviewer: 4.0,
    brainstormer: 6.0,
    /**
     * runCeilingUsd (50): a runaway fuse for the whole-run spend, not a
     * target. Historical single-spec runs measure $10-30 total; 50 gives
     * roughly 2x headroom above that observed range before the gate trips.
     * Set to a literal `null` to disable the gate entirely.
     */
    runCeilingUsd: 50,
  },

  // --- Tool sets per role ---
  /** @type {Record<string, string[]>}
   * tools.summarizer: EMPTY. The summarizer receives all data inline in
   * its prompt (pre-digested by archive.js in JS) and produces only
   * structured output. No filesystem exploration, no Bash. This was
   * not always the case — dogfood 3 shipped a version with tools that
   * caused the agent to spend 2 minutes spelunking 97 log files for
   * work that should take <15 seconds. See retro/RETRO-dogfood-3.md.
   */
  tools: {
    planner: ['Read', 'Glob', 'Grep'],
    executor: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
    verifier: ['Read', 'Glob', 'Grep', 'Bash'],
    /**
     * tools.reviewer: Read-only plus Bash — identical to verifier's tool
     * set. The reviewer must be able to read files, search the codebase,
     * and run shell commands (e.g., git diff, grep across history) to
     * gather evidence, but it must NOT modify files. Edit and Write are
     * intentionally omitted to preserve the reviewer's role as a pure
     * observer: its verdict should be based on what was produced, not on
     * any corrections it makes in the process.
     *
     * Originating incident: dogfood 10's trust-layer ship (commit 70130ba)
     * accumulated 17 integration bugs that per-task verification could not
     * catch. Reviewer agent added in commit 16f259d (dogfood 12) as a
     * per-milestone adversary.
     */
    reviewer: ['Read', 'Glob', 'Grep', 'Bash'],
    summarizer: [],
  },

  // --- Token thresholds ---
  tokens: {
    warn: 150_000,
    forceNew: 180_000,
  },

  // --- Cost summary alert thresholds ---
  alerts: {
    maxToolCallsPerSession: 30,
    minCacheEfficiency: 1.5,
  },

  // --- Retry / circuit breaker ---
  maxRetries: 3,

  // --- Execution defaults ---
  /** @type {Record<string, string>}
   * execution.summarizerModel ('haiku'): The summarizer runs on the cheapest
   * available model. Its output is a short structured digest — low complexity,
   * low token count. Using haiku keeps summarizer cost negligible and ensures
   * it never becomes the bottleneck in a pipeline that already spent budget on
   * planner (opus) and executor/verifier (sonnet).
   */
  execution: {
    plannerModel: OPUS,
    executorModel: SONNET,
    /**
     * verifierModel ('haiku'): Flipped from Sonnet to Haiku based on
     * dogfood 5 cost analysis. Verifier sessions accounted for 18%
     * of dogfood 5's total cost ($0.96 of $5.43) across 14 sessions.
     * Haiku 4.5 ($1/$5 per MT) is 3x cheaper than Sonnet ($3/$15).
     * Expected savings: ~$0.64 per dogfood. Quality hypothesis:
     * verifier is a structured-output binary-verdict task (PASSED /
     * FAILED + evidence) that doesn't require Sonnet's reasoning
     * depth. Revert to 'sonnet' if verifier false-negative rate
     * increases in the next 2-3 dogfoods.
     */
    verifierModel: HAIKU,
    /**
     * verifierEscalationModel ('sonnet'): when the Haiku verifier emits a
     * schema-invalid verdict (a small-model formatting failure), the verifier
     * re-runs once on this stronger model before the fail-close stands.
     */
    verifierEscalationModel: SONNET,
    analyzerModel: OPUS,
    brainstormerModel: OPUS,
    /**
     * reviewerModel ('sonnet'): The reviewer reads a milestone diff and emits
     * structured findings — work structurally closer to executor's surface
     * (diff read + cross-file composition check) than to planner/analyzer's.
     * Reviewer prompt was significantly strengthened 2026-05-26 with an
     * 8-pattern composition-leak checklist (commit dcc12a8), raising the floor
     * of any-model performance. Sonnet's cost advantage over opus should make
     * the swap net-positive; opus remains the rollback target if dogfood
     * evidence shows finding-quality regression (criterion: critical findings
     * missed or warning-tier findings drift toward false positives).
     *
     * Originally opus pre-2026-05-26: opus was chosen for multi-file call-chain
     * reasoning depth; that depth requirement is now partially absorbed by the
     * leak-pattern checklist (the prompt itself enumerates known patterns to
     * grep for) rather than depending on raw model reasoning.
     */
    reviewerModel: SONNET,
    summarizerModel: HAIKU,
    maxTasksPerSubMission: 7,

    /**
     * maxConcurrentSessions (default 5): upper bound on parallel SDK
     * sessions active at once across all agent types when the
     * scheduler is enabled. Set to 1 to serialize execution inside
     * the scheduler.
     *
     * Aggregate per-minute spend ceiling under parallelism is roughly
     * `maxConcurrentSessions × max(budgets.*)`. Tune both knobs
     * together when sizing budget for a parallel dogfood.
     *
     * See docs/design/phase-1-parallel-execution.md.
     */
    maxConcurrentSessions: 5,

    /**
     * maxSessionWallClockMs (default 2 700 000 ms = 45 minutes): hard
     * wall-clock ceiling applied to every SDK session regardless of agent
     * type. Acts as a safety net against runaway sessions that consume
     * budget indefinitely — e.g. an executor that loops on a tool call,
     * a verifier that never emits structured output, or any agent whose
     * prompt causes it to spin without making progress. When the ceiling
     * is reached the session is forcibly terminated and the task is marked
     * as failed so the scheduler can apply normal retry / circuit-breaker
     * logic. 45 minutes was chosen to be well above the observed P99
     * session duration in dogfoods (under 20 minutes for the largest
     * executor sessions) while still bounding worst-case cost exposure.
     */
    maxSessionWallClockMs: 2700000,

    /**
     * testCommand ('npm test') / testAllCommand ('npm run test:all'): the
     * shell commands the two regression-gate runners spawn in the target
     * project's root. `testCommand` is the per-milestone smoke test run by
     * runTestCommand (gates/regression.js, soft-pass cross-check on verifier
     * disagreement); `testAllCommand` is the full suite run by
     * runFullTestSuite (the archive final test gate, once per spec).
     *
     * Why configurable: any non-npm project — or an npm project whose
     * scripts aren't named exactly `test` / `test:all` — would otherwise get
     * a dead or throwing gate. These keys are the cheapest step toward
     * running cc-orch on a real external project. Defaults are byte-identical
     * to the previously hard-coded commands, so an unconfigured project's
     * behavior does not change.
     *
     * Override path: no CLI flag, config file, or env var — like
     * maxConcurrentSessions, override via the driver checkout's
     * `LOCAL PATCH (driver):` edits to this file.
     */
    testCommand: 'npm test',
    testAllCommand: 'npm run test:all',
  },

  // --- Small-task mode limits ---
  /**
   * smallTask: reduced pipeline limits applied when small-task mode is active.
   *
   * maxMilestones (1): a small task should fit within a single milestone —
   * a single cohesive unit of work with a clear acceptance criterion.
   *
   * maxMissions (2): at most two missions per milestone keeps the plan
   * tight and avoids the planner over-decomposing a simple job.
   *
   * maxTasksPerMission (5): caps the number of executor tasks per mission
   * so the total task count stays in single digits and fits comfortably
   * within one executor session's budget.
   */
  smallTask: {
    maxMilestones: 1,
    maxMissions: 2,
    maxTasksPerMission: 5,
  },

  // --- Elicitation (brainstormer frame-first) defaults ---
  /**
   * elicitation: defaults for the TTY-only frame-first elicitation phase.
   *
   * maxQuestions (5): hard ceiling on the number of clarifying questions the
   * brainstormer asks before drafting a spec. The agent self-scales the count
   * (emitting fewer for trivial requests); this is the upper bound applied to
   * the importance-ranked list after the fact. Sourced here as a config default
   * so the value is not welded into the agent's core prompt — it flows through
   * a style object passed into proposeQuestions.
   *
   * digestVerbosity ('normal'): controls the brevity of the one-page
   * understanding-playback digest rendered on the TTY authoring path
   * (renderDigest). 'normal' shows the full per-criterion verification detail;
   * 'terse' omits/truncates it. Sourced here (alongside maxQuestions, same
   * style object) so the verbosity is not welded into the core prompt or render
   * code — it flows through the style seam.
   *
   * maxRounds (2): master cap on the adaptive multi-round follow-up loop (the
   * rounds AFTER round 1). The per-complexity policy map
   * {trivial:0, small:0, medium:1, large:2} is the fixed internal ceiling;
   * maxRounds is the user-facing throttle: effectiveCeiling =
   * maxRounds === 0 ? 0 : min(map[assessedComplexity], maxRounds). The default 2
   * lets the complexity map operate fully; 0 disables the follow-up loop (TTY
   * stays single-round frame-first, batch / non-TTY one-shot stays byte-
   * identical). Sourced here so no round-count literal is welded into the agent's
   * core prompt — it flows through the style seam.
   *
   * questionVerbosity ('normal'): controls the phrasing brevity of the
   * clarifying questions (and the follow-up integration note). 'normal' phrases
   * clearly and completely; 'terse' shortens. Mirrors digestVerbosity; threaded
   * as a data value into buildProposeQuestionsPrompt and the follow-up prompt
   * builder so it is not welded into the core prompt text.
   */
  elicitation: {
    maxQuestions: 5,
    digestVerbosity: 'normal',
    maxRounds: 2,
    questionVerbosity: 'normal',
  },

  // --- Session defaults ---
  sessionDefaults: {
    dangerouslySkipPermissions: true,
  },

  /**
   * ui: knobs for the (optional) UI-facing notification / polling layer.
   *
   * notifyWebhookUrl (''): destination URL for outbound notifications.
   * Empty string means notifications are off — no webhook is configured.
   *
   * siderailPollMs (3000): polling interval, in milliseconds, for the
   * siderail UI. Floored at 2000ms via Math.max so the resolved value can
   * never be configured below the minimum, protecting against overly
   * aggressive polling.
   */
  ui: {
    notifyWebhookUrl: '',
    siderailPollMs: Math.max(2000, 3000),
  },

  /**
   * Resolve the .harness dir for a given project root.
   */
  harnessDir(projectRoot) {
    return path.join(projectRoot, '.harness');
  },
};

export default config;
