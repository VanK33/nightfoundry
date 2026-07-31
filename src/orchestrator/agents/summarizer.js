/**
 * summarizer.js — Produces a structured summary of a pipeline run.
 *
 * The summarizer runs at archive time. Its job is narrow: take a
 * pre-digested data package (prepared by the caller in JS), synthesize
 * it into {headline, bugs, summary}, and return the result. It does
 * NOT explore the filesystem or spelunk through log files — all
 * relevant data is pre-computed and passed inline in the prompt.
 *
 * Rationale: dogfood 3 shipped a version that told the agent to
 * "read .harness/logs/*.jsonl to understand what happened." Haiku
 * took that literally and made 31 tool calls spelunking through 97
 * log files (including its own live session log), taking 2 minutes
 * for work that should complete in <15 seconds. The fix is to
 * pre-compute the data on the JS side and have the agent synthesize
 * only — no tool exploration.
 *
 * The summarizer is return-only. It does NOT write files. The caller
 * (archive.js) is responsible for persisting the result wherever it
 * makes sense (the manifest.json already captures headline/bugs/summary,
 * so there is no separate sidecar).
 *
 * Public API:
 *   extractSummary(sdkResult)  // pure, unit-testable
 *     → { headline, bugs, summary, structured }
 *
 *   Summarizer.summarizeRun(dataPackage)
 *     → Promise<{ headline, bugs, summary, structured }>
 *
 *   where `dataPackage` is prepared by the caller and has shape:
 *     {
 *       projectRoot:          string,
 *       stateJson:            object,                         // current state.json contents
 *       diffSummary:          string,                         // files changed in this archive's diff
 *       verificationSidecars: string,                         // verification sidecar output for this run
 *       specContent:          string,                         // first ~3000 chars of the spec
 *       milestoneList:        [{id, description, status}],    // from Object.values(state.milestones)
 *       completedTasks:       [{id, description}],           // completed tasks from this run
 *       totalCost:            number,
 *       totalSessions:        number,
 *     }
 */
import config from '../infra/config.js';
import { summarizerSchema, extractStructured, validateStructured } from './_schemas.js';

/**
 * Cap a headline into a git-commit-title shape. Pure, no I/O.
 *
 * The headline is consumed VERBATIM by pipeline.js as the delivery commit
 * title, so it must be constrained deterministically regardless of what the
 * model produced. This is the structural half of the "deterministic gates
 * over prompt guidance" pairing (the prompt also asks for a commit-title
 * style headline, but the model is not trusted to obey it).
 *
 * Rules:
 * - coerce to string, keep the FIRST line only, collapse whitespace runs to
 *   single spaces, trim;
 * - if longer than 72 chars, cut at the last word boundary at or before 72;
 *   if that boundary lands before char 40, hard-cut at 72 instead; no
 *   ellipsis; strip any trailing punctuation/whitespace left by the cut;
 * - empty/nullish input → '' (callers fall back to the slug).
 */
export function capHeadline(s) {
  if (s == null) return '';
  let text = String(s);
  const nl = text.search(/[\r\n]/);
  if (nl !== -1) text = text.slice(0, nl);
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= 72) return text;

  const lastSpace = text.slice(0, 72).lastIndexOf(' ');
  const cut = lastSpace >= 40 ? text.slice(0, lastSpace) : text.slice(0, 72);
  return cut.replace(/[\p{P}\s]+$/u, '');
}

/**
 * Extract a summary from an SDK result. Pure function, no I/O.
 *
 * Return shape:
 *   { headline, bugs, summary, structured }
 *
 * On validation failure: conservative defaults (empty headline/bugs/summary).
 * On missing structured_output: stub with '[archived without AI summary]'.
 */
export function extractSummary(sdkResult, opts = {}) {
  const warn = opts.warn ?? console.warn;
  const structured = extractStructured(sdkResult, { warn });

  if (structured) {
    const validation = validateStructured(structured, summarizerSchema);
    if (!validation.ok) {
      warn(
        `[summarizer] structured_output validation failed — ${validation.errors.join('; ')}`
      );
      return {
        headline: '',
        bugs: [],
        summary: '',
        changelog: [],
        structured,
      };
    }

    // Post-parse citation validation: filter changelog items whose taskIds
    // reference unknown task IDs (only when completedTaskIds is provided and non-empty).
    const completedTaskIds = opts.completedTaskIds;
    let changelog = structured.changelog;
    let droppedChangelogCount = 0;

    if (Array.isArray(completedTaskIds) && completedTaskIds.length > 0) {
      const validIdSet = new Set(completedTaskIds);
      const kept = [];
      const dropped = [];

      for (const item of changelog) {
        const taskIds = item.taskIds ?? [];
        if (taskIds.every((id) => validIdSet.has(id))) {
          kept.push(item);
        } else {
          dropped.push(item);
        }
      }

      if (dropped.length > 0) {
        warn(`[summarizer] citation validation dropped ${dropped.length} changelog item(s) with unknown taskIds`);
      }

      changelog = kept;
      droppedChangelogCount = dropped.length;
    }

    return {
      headline: capHeadline(structured.headline),
      bugs: structured.bugs,
      summary: structured.summary,
      changelog,
      droppedChangelogCount,
      structured,
    };
  }

  const stub = {
    headline: '[archived without AI summary]',
    bugs: [],
    summary: '',
    changelog: [],
  };

  return {
    headline: capHeadline(stub.headline),
    bugs: [],
    summary: '',
    changelog: [],
    structured: stub,
  };
}

class Summarizer {
  constructor(sessionManager, logger, tokenTracker) {
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.tokenTracker = tokenTracker;
  }

  /**
   * Summarize a pipeline run from a pre-computed data package.
   *
   * The caller MUST pre-compute the data package (git log, state,
   * spec, etc.) in JS. The summarizer does NOT explore the filesystem.
   */
  async summarizeRun(dataPackage) {
    const {
      projectRoot,
      stateJson,
      diffSummary = '',
      verificationSidecars = '',
      specContent = '',
      milestoneList = [],
      completedTasks = [],
      totalCost = 0,
      totalSessions = 0,
    } = dataPackage;

    // Truncate specContent to keep prompt size bounded.
    const specExcerpt = specContent.length > 3000
      ? specContent.slice(0, 3000) + '\n...(truncated)'
      : specContent;

    const milestoneSummary = milestoneList
      .map((m) => `  - ${m.id} [${m.status}]: ${m.description}`)
      .join('\n') || '  (no milestones)';

    const completedTasksSummary = completedTasks
      .map((t) => `- ${t.id}: ${t.description}`)
      .join('\n') || '(no tasks)';

    const prompt = `Synthesize a summary of this pipeline run from the data below.

## State
globalStatus: ${stateJson?.globalStatus ?? 'unknown'}
totalCost: $${totalCost.toFixed(2)}
totalSessions: ${totalSessions}

## Milestones
${milestoneSummary}

## Completed Tasks
${completedTasksSummary}

## Diff summary (files changed)
${diffSummary || '(no diff)'}

## Verification sidecars
${verificationSidecars || '(none)'}

## Spec excerpt (first 3000 chars)
${specExcerpt || '(no spec)'}

## Your task

Return your summary as the session's structured output matching the session's attached JSON schema exactly (headline, bugs, summary, changelog).

Rules:
- Synthesize ONLY from the data above. Do NOT read additional files.
- Do NOT use Bash, Read, Grep, or Glob tools — everything you need is in this prompt.
- headline: this string is used VERBATIM as a git commit title — write it like one. Describe WHAT changed at an abstract level (e.g. "Add queue retry verb and preserve runner kill signals"). MUST be <= 72 characters. NO test counts, NO "N/N tasks passed", NO verification-result claims ("all tests green", "fully verified"), NO milestone numbering, no trailing period.
- bugs: one entry per distinct bug, brief, or empty array if none
- summary: 2-5 sentences, factual and concise
- changelog: one entry per user-visible change; type must be "feature", "fix", or "breaking"; empty array if no user-visible changes
- Describe what was shipped in THIS archive only. Items in your output must be traceable to the milestone description, the spec, a task description, or a file in this archive's diff. Do not include anything describing prior releases or git operations (reverts, cleanups, merges).
- Each changelog entry MUST include a "source" field whose value is one of the allowed enum values: "mission-desc", "task-desc", "spec", "diff-file", or "manifest-bugs".
- When source is "diff-file", you MUST also include a "file" field whose value is a repo-relative path that appears in the diff summary above. For any other source value, omit the "file" field.
- Every changelog item MUST include a \`taskIds\` array citing one or more task IDs from the Completed Tasks list above. Do NOT invent task IDs.`;

    const systemPrompt = `You are a Harness Summarizer. Your ONLY job is to synthesize a pre-digested data package into a structured summary.

Rules:
- All data you need is provided in the user prompt. Do NOT explore the filesystem.
- Do NOT use Bash, Read, Grep, or Glob tools under any circumstances.
- Return a structured JSON object matching the session's jsonSchema.
- Do NOT write or modify any files.
- Do NOT update state.json or any harness state file.
- Be factual and concise. If something is unclear from the data, say so in the summary.`;

    const log = this.logger.createSessionLog('summarizer');

    try {
      const spawnPromise = this.sessionManager.spawn({
        name: 'summarizer',
        prompt,
        systemPrompt,
        model: config.execution.summarizerModel,
        agent: 'summarizer',
        tools: config.tools.summarizer,
        jsonSchema: summarizerSchema,
        maxBudget: config.budgets.summarizer,
        cwd: projectRoot,
      });

      this.logger.attachToSession(spawnPromise.handle, log, {
        role: 'summarizer',
      });

      const { handle, result: sdkResult } = await spawnPromise;

      const summary = extractSummary(sdkResult, {
        warn: (msg) => this.logger.warn(msg),
        completedTaskIds: completedTasks.map((t) => t.id),
      });

      if ((summary.droppedChangelogCount ?? 0) > 0) {
        this.logger.warn(
          `[summarizer] elapsed — dropped ${summary.droppedChangelogCount} changelog item(s) with unknown taskIds`
        );
      }

      const sessionSummary = this.logger.getSessionSummary(log.logPath);
      await this.logger.writeSessionSummary('summarizer', sessionSummary, {
        role: 'summarizer',
        headline: summary.headline,
      });
      await this.tokenTracker?.recordSession('summarizer', 'summarizer', sdkResult, {
        headline: summary.headline,
        systemPromptTokens: handle.systemPromptTokens,
        toolCallCount: handle._toolCallCount,
      });

      return summary;
    } finally {
      log.close();
    }
  }
}

export { Summarizer };
