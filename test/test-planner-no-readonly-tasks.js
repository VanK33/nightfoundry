/**
 * test-planner-no-readonly-tasks.js — Unit tests for the planner "no read-only tasks"
 * prompt section.
 *
 * The section (PROMPT_SECTION_NO_READONLY_TASKS) is a reusable prompt export in
 * planner-prompts.js that forbids pure read-only/analysis/review/approval pre-step
 * tasks, states that a file-producing task is NOT read-only, and instructs folding
 * analysis into the editing task. It is wired into both buildMissionSystemPrompt and
 * buildReplanSystemPrompt.
 *
 * These tests assert FROM THE SPEC — they do NOT couple to implementation details
 * beyond the public exports/builders. No live SDK calls.
 *
 * Run: node test/test-planner-no-readonly-tasks.js
 */
import assert from 'assert';
import {
  PROMPT_SECTION_NO_READONLY_TASKS,
  buildMissionSystemPrompt,
  buildReplanSystemPrompt,
} from '../src/orchestrator/agents/planner-prompts.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  const run = async () => {
    try {
      await fn();
      console.log(`PASS  ${name}`);
      passCount++;
    } catch (err) {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failCount++;
    }
  };
  return run();
}

// ── TC1: the constant is exported and is a non-empty string ──────────────────

await test('PROMPT_SECTION_NO_READONLY_TASKS is exported as a non-empty string', async () => {
  assert.strictEqual(
    typeof PROMPT_SECTION_NO_READONLY_TASKS,
    'string',
    'PROMPT_SECTION_NO_READONLY_TASKS must be exported as a string from planner-prompts.js',
  );
  assert.ok(
    PROMPT_SECTION_NO_READONLY_TASKS.trim().length > 0,
    'PROMPT_SECTION_NO_READONLY_TASKS must be non-empty',
  );
});

// ── TC2: the section contains the load-bearing phrases from the approved text ──

await test('PROMPT_SECTION_NO_READONLY_TASKS contains the required content', async () => {
  const text = PROMPT_SECTION_NO_READONLY_TASKS;

  // Matches /read-only/i — the section is about "read-only" tasks.
  assert.ok(
    /read-only/i.test(text),
    "section must contain the term 'read-only'",
  );

  // Forbidding language — "Forbidden" or "Do NOT" signals what is disallowed.
  assert.ok(
    /Forbidden|Do NOT/i.test(text),
    "section must contain forbidding language ('Forbidden' or 'Do NOT')",
  );

  // The section must mention analysis/review/approval as forbidden pre-step purposes.
  assert.ok(
    /analy[sz]/i.test(text),
    "section must mention analysis/analyse as a forbidden pre-step purpose",
  );
  assert.ok(
    /review/i.test(text),
    "section must mention review as a forbidden pre-step purpose",
  );
  assert.ok(
    /approv/i.test(text),
    "section must mention approval/approve as a forbidden pre-step purpose",
  );

  // A file-producing task is NOT read-only — stated as "IS a producing task"
  // (the section reads: "A task IS a producing task if it WRITES its output to a file").
  assert.ok(
    /IS a producing task/i.test(text),
    "section must state that a file-producing task IS a producing task (i.e. not read-only)",
  );

  // Instructs folding analysis into the editing task.
  assert.ok(
    /[Ff]old.*analy/i.test(text),
    "section must instruct folding analysis into the editing task",
  );
});

// ── TC3: buildMissionSystemPrompt includes the section exactly once ──────────

await test('buildMissionSystemPrompt includes PROMPT_SECTION_NO_READONLY_TASKS exactly once', async () => {
  const prompt = buildMissionSystemPrompt(7);
  const occurrences = prompt.split(PROMPT_SECTION_NO_READONLY_TASKS).length - 1;
  assert.strictEqual(
    occurrences,
    1,
    `buildMissionSystemPrompt output should contain the no-readonly-tasks section exactly once, found ${occurrences}`,
  );
});

// ── TC4: buildReplanSystemPrompt includes the section exactly once ───────────

await test('buildReplanSystemPrompt includes PROMPT_SECTION_NO_READONLY_TASKS exactly once', async () => {
  const prompt = buildReplanSystemPrompt();
  const occurrences = prompt.split(PROMPT_SECTION_NO_READONLY_TASKS).length - 1;
  assert.strictEqual(
    occurrences,
    1,
    `buildReplanSystemPrompt output should contain the no-readonly-tasks section exactly once, found ${occurrences}`,
  );
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
