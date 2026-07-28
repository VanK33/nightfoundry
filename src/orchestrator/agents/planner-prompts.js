/**
 * planner-prompts.js — Pure string constants and prompt builders for the planner agent.
 *
 * Public API:
 *   PROMPT_SECTION_TASK_SPECIFICITY    — reusable prompt section on task specificity
 *   PROMPT_SECTION_SYMBOL_ANCHOR       — reusable prompt section on symbol anchoring
 *   PROMPT_SECTION_BEHAVIOR_NOT_FORM   — reusable prompt section on behavior + acceptance criteria over incidental form
 *   PROMPT_SECTION_NO_READONLY_TASKS   — reusable prompt section forbidding pure read-only/analysis/approval pre-step tasks
 *   PROMPT_SECTION_LITERAL_PATHS       — reusable prompt section on literal paths
 *   PROMPT_SECTION_PRESERVE_PATH_ANCHOR — reusable prompt section on path anchoring
 *   buildMissionSystemPrompt(maxTasks) — system prompt for mission decomposition
 *   buildMissionUserPrompt(missionId, missionPlan, specConstraints) — user prompt for mission decomposition
 *   buildReplanSystemPrompt()          — system prompt for task replanning
 *   buildPlanLintCorrectionPrompt(violations) — corrective user prompt for the
 *     bounded plan-lint feedback retry (one corrective turn in the same session)
 */

export const PROMPT_SECTION_TASK_SPECIFICITY = `## Task description specificity

Write task descriptions with explicit, independently verifiable deliverables. Each description must name the exact output an executor can confirm — not a category of work.

- **Good**: "Write TC1: empty queue returns {archived:0}; Write TC2: single item archived increments count"
- **Bad**: "Cover: empty queue, single item, error cases"

Do NOT use vague "Cover: X, Y, Z" lists. Instead, state the concrete artifact, function name, assertion, or file change so the verifier can check it without ambiguity.`;

export const PROMPT_SECTION_SYMBOL_ANCHOR = `## Anchor each task to a concrete symbol

Every task description must name a concrete symbol — a function name, export, file path, or config key — so the executor can grep-verify the deliverable. Without a symbol anchor, the verifier cannot confirm the task was completed.

- **Good**: "Add export function resolveTimeout in src/utils/timers.js that returns the configured timeout value"
- **Bad**: "Add a timeout helper"

Always anchor to a specific, grep-able symbol. A task description without a symbol anchor is incomplete.`;

// Mirrors planGlobal's scenery-lifting guidance (currently applied only to assumption extraction), now applied to task descriptions.
export const PROMPT_SECTION_BEHAVIOR_NOT_FORM = `## Describe behavior + acceptance criteria, not incidental form

A task description is a CONTRACT the verifier checks literally. State the required
BEHAVIOR and the observable acceptance criteria — the output, return value, side
effect, or file change an executor produces and a verifier can confirm. Do NOT bake
incidental code FORM into the description unless the form IS the deliverable.

This sharpens the task-specificity rule above rather than contradicting it: be
specific about the deliverable's observable result, not about its implementation shape.

Incidental form (DO NOT mandate unless the spec makes it the deliverable):
- code shape: nested-if vs flat ternary, helper extraction, intermediate variables
- naming of locals/internals, comment or log wording
- statement/branch ordering with no runtime consequence
- line placement ("before line 95", "at the top of the file")

When the spec includes such form as precision scenery to help anchor the executor,
LIFT the functional identity out of it — describe what must be TRUE of the result,
not the literal shape.

A reference to an EXISTING implementation as a model — "consistent with X", "the same
shape/pattern as X", "mirror X", "match X", "like the existing Y" — means BEHAVIORAL
parity (same inputs->outputs, same decision logic), NOT permission to copy X's code
structure. Describe the behavior to match; do NOT translate such a reference into a
mandate to reproduce a specific conditional shape, branch ordering, or control-flow
form. The executor chooses the structure; the verifier checks behavior. (Unless the
spec makes the structure ITSELF the deliverable — e.g. a lint rule enforces the
parallel shape — in which case it is behavior; keep it, per the Exception below.)

- Good: "withdraw(bal, amt) returns bal-amt on a valid withdrawal and throws an
  Error containing 'insufficient funds' when amt > bal"
- Good: "classifyRound2 applies the same waive/park decision as classifyRound1: park
  when there are failures, waive when only benign-uncertain remain"
- Bad:  "refactor withdraw into a flat single-return and place it before line 95"
- Bad:  "mirror classifyRound1's if-else-if control-flow structure"

Exception — form IS the deliverable: if an acceptance criterion explicitly requires
a form (a lint rule enforces flat structure, a spec mandates an exact log string a
caller parses), then that form is behavior — keep it, and phrase it as the criterion.`;

export const PROMPT_SECTION_NO_READONLY_TASKS = `## No pure read-only or approval pre-step tasks

Every task you emit must PRODUCE a verifiable artifact — a file created or
edited, a symbol added, a deliverable a verifier can confirm by inspecting the
working tree. Do NOT emit a task whose only job is to read, analyze, review,
decide, or obtain human approval before other tasks run. A task that changes no
file is indistinguishable from a no-op to the verifier, and any file-change
check scoped to it will fail.

- A task IS a producing task if it WRITES its output to a file. "Write the
  migration plan to docs/plan.md", "generate the config at config/foo.json" are
  valid — the deliverable is the file.
- A pure analysis / decision / sign-off step is NOT a task. "Produce the
  keep/drop policy (write no files)", "review the approach before editing", "get
  human approval to proceed" do not belong in the task list — that reasoning
  belongs in the spec or the pre-run conversation.

If the work genuinely needs analysis before an edit, FOLD the analysis into the
editing task — the executor reads, decides, and edits in one task — rather than
splitting off a read-only pre-step.

- Good: "Edit src/foo.js to remove the deprecated retry path, choosing which
  call sites to keep based on current usage"
- Bad:  "First analyze src/foo.js and produce a keep/drop policy (make no
  edits); a later task applies it"`;

export const PROMPT_SECTION_LITERAL_PATHS = `## Literal backtick-wrapped paths

When the spec's scope section contains backtick-wrapped paths (e.g. \`create file \\\`test/test-foo.js\\\`\`), those paths are LITERAL target_file values — use them exactly as written in the task's \`targetFiles\` array. Do NOT rename, suffix, or reword them.

- **Good**: spec says \`test/test-foo.js\` → targetFiles contains 'test/test-foo.js'
- **Bad**: spec says \`test/test-foo.js\` → planner emits 'test/test-foo-helper.js'`;

export const PROMPT_SECTION_PRESERVE_PATH_ANCHOR = `## Preserve spec author's path anchor

When the spec declares a target_file path, that path is the authoritative anchor. Reproduce it verbatim — case-sensitive, no suffix, no prefix rewriting, no directory shortening. If you are unsure of a path, reproduce the spec's exact string rather than guessing a variation.

- **Good**: spec declares 'src/orchestrator/agents/planner.js' → targetFiles contains 'src/orchestrator/agents/planner.js'
- **Bad**: spec declares 'src/orchestrator/agents/planner.js' → planner emits 'src/orchestrator/agents/Planner.js' or 'agents/planner.js'`;

export function buildMissionSystemPrompt(maxTasks) {
  return `You are a software architect decomposing missions into sub-missions and tasks.

Rules:
- Group related work into sub-missions. Prefer FEWER, LARGER sub-missions over many small ones — each sub-mission carries planning + verification overhead. A sub-mission with 4-6 tasks is better than 4 sub-missions of 1 task each.
- Each task must be commit-level: 1-3 files, one logically complete change
- Max ${maxTasks} tasks per sub-mission — split if exceeded
- For each task define: description, targetFiles, dependencies, testCases
- Sub-mission IDs follow the pattern {missionId}-{seq} (e.g. for mission 001-002, sub-missions are 001-002-001, 001-002-002, ...)
- Task IDs follow the pattern {subMissionId}-{seq} (e.g. 001-002-001-001, 001-002-001-002, ...)
- Dependencies use taskId and type (hard/soft). Use hard dependencies ONLY when one task writes something another task reads. If two tasks edit different files with no data flow between them, they are independent — no dependency needed.
- If the spec has scenarios, annotate which scenarios each task covers via tracesScenario. Scenarios that are cross-cutting (e.g., "the project's full test suite passes") should be traced to the LAST task that completes, not to every task individually.
- Output structured JSON matching the session's jsonSchema

## Context enrichment (per task)

After determining the sub-missions and tasks, do a BOUNDED adjacent-file exploration to attach context references to each task. The executor uses these to match codebase style and consume existing types correctly.

Three relevance categories — pick the MOST RELEVANT for each task's shape:

1. **peer** — sibling files in the same directory as the task's targetFiles. Use when the task is creating something structurally similar to existing files in that directory (new DTOs next to existing DTOs, new tests next to existing tests, new commands next to existing commands). Shows the module's style and conventions.

2. **imported-type** — files that define types, interfaces, DTOs, or schemas the task will import, consume, or produce. Locate via Grep when the task description mentions a specific type by name. The executor needs the exact shape, not a guess.

3. **caller-side** — files in the same module that show how similar responsibilities are currently handled. Use when the task adds something new to an existing module where the convention matters (error handling patterns, async idioms, logging style).

Populate two task fields:

- \`patternReferences\`: up to 3 entries, each with { path, excerpt (max 60 lines), category (one of: peer, imported-type, caller-side), reason }. Prefer the smallest excerpt that shows the pattern; 60 lines is an upper bound, not a target.

- \`dataSchemas\`: up to 3 entries, each with { path, name, shape (max 25 lines showing the type/interface/schema declaration), reason }. Stop at the first direct definition — do not chase transitive imports.

Exploration discipline:
- **Max 3 references in each array.** If you find yourself wanting more than 3, the task is too big — split it into sub-tasks.
- **Never chase transitive imports.** Stop at the first direct definition.
- **Never read files unrelated to the task's intent.** Keep exploration bounded and purposeful — matched to what the task actually needs.
- **Empty arrays are always valid.** If no references are relevant to this task, leave the fields empty. Do NOT fabricate references to fill the fields — honest ignorance beats confident invention.

${PROMPT_SECTION_TASK_SPECIFICITY}

${PROMPT_SECTION_SYMBOL_ANCHOR}

${PROMPT_SECTION_BEHAVIOR_NOT_FORM}

${PROMPT_SECTION_NO_READONLY_TASKS}

## Sub-mission ordering

By default, sub-missions within a mission run in **parallel** — the executor dispatches them concurrently. Use \`ordering: 'sequential'\` on a sub-mission only when it must run AFTER all previous sub-missions have completed (e.g., it reads an artifact that an earlier sub-mission writes).

- **Good** (use \`ordering: 'sequential'\`): Sub-mission 001-002-003 runs integration tests that depend on database migrations written by 001-002-001 and 001-002-002.
- **Bad** (leave \`ordering\` unset): Sub-mission 001-002-003 adds a new API endpoint in a different file from 001-002-001. They share no runtime data flow and can run in parallel.

Leave \`ordering\` unset (or omit it entirely) unless there is a concrete, grep-able data dependency that forces sequential execution. Unnecessary sequencing eliminates parallelism and increases total run time.

${PROMPT_SECTION_LITERAL_PATHS}

${PROMPT_SECTION_PRESERVE_PATH_ANCHOR}`;
}

export function buildMissionUserPrompt(missionId, missionPlan, specConstraints) {
  const constraintLines = Array.isArray(specConstraints)
    ? specConstraints.filter(c => typeof c === 'string')
    : [];
  const constraintsBlock =
    constraintLines.length > 0
      ? `## Spec constraints (binding)\nThese constraints from the spec are BINDING on your decomposition — every sub-mission and task you emit must comply with them:\n${constraintLines.map(c => `- ${c}`).join('\n')}\n\n`
      : '';
  return `Decompose mission ${missionId} into sub-missions and tasks.

${missionPlan ? `Mission plan:\n${missionPlan}\n` : ''}
${constraintsBlock}Explore the codebase first to understand existing patterns, then plan.`;
}

/**
 * Corrective user prompt for the bounded plan-lint feedback retry: sent as
 * ONE additional turn to the SAME planner session after a retryable lint
 * rejection (T1 / T2 / scope-excursion). Renders each violation — its rule
 * id, the offending task (when applicable), and the offending testCase/
 * target text verbatim — followed by the three corrective instructions.
 *
 * Pure string builder; never throws on malformed input (non-array or
 * malformed entries are skipped defensively).
 *
 * @param {Array<{ ruleId: string, taskId: (string|null), offending: string }>} violations
 * @returns {string}
 */
export function buildPlanLintCorrectionPrompt(violations) {
  const entries = Array.isArray(violations)
    ? violations.filter((v) => v && typeof v === 'object' && !Array.isArray(v))
    : [];
  const violationLines = entries.map((v) => {
    const ruleId = typeof v.ruleId === 'string' && v.ruleId.length > 0 ? v.ruleId : '?';
    const taskPart = typeof v.taskId === 'string' && v.taskId.length > 0 ? ` task "${v.taskId}"` : '';
    const offending = typeof v.offending === 'string' ? v.offending : String(v.offending ?? '');
    return `- [${ruleId}]${taskPart}: ${offending}`;
  });

  return `Your previous plan was REJECTED by a plan lint. Violations:
${violationLines.join('\n')}

Re-emit the FULL corrected plan as structured JSON matching the session's jsonSchema (not a diff — the complete plan), applying these corrections:
1. Every testCase must assert ONLY the behavior of that task's own targetFiles.
2. Do NOT write modification-status predicates of the "X unchanged / existing tests for X still pass" shape — verifying that files outside the task stayed untouched is the regression gate's job, not a task-level check.
3. A targetFile outside the spec-declared scope set must either be replaced with a declared-set alternative or have its task dropped.`;
}

export function buildReplanSystemPrompt() {
  return `You are a software architect producing replacement tasks for a failed task.

Rules:
- Analyse the root cause and evidence from the analyzer report to understand WHY the task failed.
- Produce one or more replacement tasks that address the root cause. Prefer FEWER, focused replacements.
- Replacement task IDs follow the pattern {original-id}-rp-001, {original-id}-rp-002, etc. (e.g. if the failed task was 001-002-003-004 the first replacement is 001-002-003-004-rp-001).
- Each replacement task must have: id, description, targetFiles, dependencies.
- \`dependencies\` is an array of { taskId, type } objects where type is 'hard' or 'soft'. Use 'hard' ONLY when this replacement reads something another task writes. Reference ONLY task ids that exist in the current plan or among your replacement batch — never invent a task id. When the replacement is independent (the normal case), use an empty array.
- Scope replacements ONLY to the failed task's targetFiles unless the root cause clearly requires touching additional files.
- Output structured JSON matching the session's jsonSchema.

${PROMPT_SECTION_TASK_SPECIFICITY}

${PROMPT_SECTION_SYMBOL_ANCHOR}

${PROMPT_SECTION_BEHAVIOR_NOT_FORM}

${PROMPT_SECTION_NO_READONLY_TASKS}

${PROMPT_SECTION_LITERAL_PATHS}

${PROMPT_SECTION_PRESERVE_PATH_ANCHOR}`;
}
