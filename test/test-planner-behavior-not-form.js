/**
 * test-planner-behavior-not-form.js — Unit tests for the planner "behavior not form"
 * prompt section (failed-121 planner-side fix).
 *
 * The fix adds a new reusable prompt section, PROMPT_SECTION_BEHAVIOR_NOT_FORM, to
 * planner-prompts.js, and wires it into both buildMissionSystemPrompt(maxTasks) and
 * buildReplanSystemPrompt(). The section guides the planner to describe required
 * BEHAVIOR + acceptance criteria in task descriptions, not incidental code FORM,
 * unless the form IS the deliverable.
 *
 * These tests assert FROM THE SPEC (the approved section text) — they do NOT couple
 * to implementation details beyond the public exports/builders. No live SDK calls.
 *
 * Run: node test/test-planner-behavior-not-form.js
 */
import assert from 'assert';
import {
  PROMPT_SECTION_BEHAVIOR_NOT_FORM,
  PROMPT_SECTION_TASK_SPECIFICITY,
  PROMPT_SECTION_SYMBOL_ANCHOR,
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

await test('PROMPT_SECTION_BEHAVIOR_NOT_FORM is exported as a non-empty string', async () => {
  assert.strictEqual(
    typeof PROMPT_SECTION_BEHAVIOR_NOT_FORM,
    'string',
    'PROMPT_SECTION_BEHAVIOR_NOT_FORM must be exported as a string from planner-prompts.js',
  );
  assert.ok(
    PROMPT_SECTION_BEHAVIOR_NOT_FORM.trim().length > 0,
    'PROMPT_SECTION_BEHAVIOR_NOT_FORM must be non-empty',
  );
});

// ── TC2: the section contains the load-bearing phrases from the approved text ──

await test('PROMPT_SECTION_BEHAVIOR_NOT_FORM contains the load-bearing phrases', async () => {
  const text = PROMPT_SECTION_BEHAVIOR_NOT_FORM;

  // The approved heading.
  assert.ok(
    /##\s*Describe behavior \+ acceptance criteria, not incidental form/.test(text),
    "section must contain the heading 'Describe behavior + acceptance criteria, not incidental form'",
  );

  // The "incidental form" concept (the thing the planner must NOT bake in).
  assert.ok(
    /incidental\s+.*form/i.test(text),
    "section must reference 'incidental ... form'",
  );

  // The exception clause: form IS the deliverable.
  assert.ok(
    /IS the deliverable/i.test(text),
    "section must contain the 'IS the deliverable' exception language",
  );
  assert.ok(
    /Exception/i.test(text),
    "section must contain the 'Exception' clause label",
  );

  // Behavior + acceptance-criteria language (the positive instruction).
  assert.ok(
    /behavior/i.test(text),
    "section must use 'behavior' language",
  );
  assert.ok(
    /acceptance criteria/i.test(text),
    "section must use 'acceptance criteria' language",
  );

  // The contract framing — the description is a CONTRACT the verifier checks literally.
  assert.ok(
    /contract/i.test(text),
    "section must frame the task description as a 'contract'",
  );

  // Concrete incidental-form examples named in the approved text.
  assert.ok(
    /line placement|before line/i.test(text),
    "section must cite line-placement as an example of incidental form",
  );
  assert.ok(
    /log wording|log string|comment or log/i.test(text),
    "section must cite log/comment wording as an example of incidental form",
  );

  // The "lift the functional identity out" framing.
  assert.ok(
    /LIFT|functional identity/i.test(text),
    "section must instruct lifting the functional identity out of precision scenery",
  );
});

// ── TC3: buildMissionSystemPrompt includes the section exactly once ──────────

await test('buildMissionSystemPrompt includes PROMPT_SECTION_BEHAVIOR_NOT_FORM exactly once', async () => {
  const prompt = buildMissionSystemPrompt(7);
  const occurrences = prompt.split(PROMPT_SECTION_BEHAVIOR_NOT_FORM).length - 1;
  assert.strictEqual(
    occurrences,
    1,
    `buildMissionSystemPrompt output should contain the behavior-not-form section exactly once, found ${occurrences}`,
  );
});

// ── TC4: buildReplanSystemPrompt includes the section exactly once ───────────

await test('buildReplanSystemPrompt includes PROMPT_SECTION_BEHAVIOR_NOT_FORM exactly once', async () => {
  const prompt = buildReplanSystemPrompt();
  const occurrences = prompt.split(PROMPT_SECTION_BEHAVIOR_NOT_FORM).length - 1;
  assert.strictEqual(
    occurrences,
    1,
    `buildReplanSystemPrompt output should contain the behavior-not-form section exactly once, found ${occurrences}`,
  );
});

// ── TC5: the heading appears exactly once in each builder's output ───────────
// Guards against the section being concatenated twice via a different code path.

await test('behavior-not-form heading appears exactly once in each builder output', async () => {
  const heading = '## Describe behavior + acceptance criteria, not incidental form';
  const missionPrompt = buildMissionSystemPrompt(7);
  const replanPrompt = buildReplanSystemPrompt();

  const missionCount = missionPrompt.split(heading).length - 1;
  const replanCount = replanPrompt.split(heading).length - 1;

  assert.strictEqual(missionCount, 1, `heading should appear once in mission prompt, found ${missionCount}`);
  assert.strictEqual(replanCount, 1, `heading should appear once in replan prompt, found ${replanCount}`);
});

// ── TC6 (discrimination support): the section is a DISTINCT constant ──────────
// This does NOT itself detect a wiring removal — TC3/TC4/TC5/TC7 do that. TC6 is
// what makes those substring-based wiring checks MEANINGFUL: if the new section's
// text were a substring of a pre-existing sibling section (or vice versa), a builder
// could contain the heading without explicitly interpolating the new constant, so
// TC3-5/TC7 could pass spuriously after a real wiring removal. Asserting mutual
// non-containment closes that loophole.

await test('discrimination: behavior-not-form section is distinct from sibling section constants', async () => {
  assert.ok(
    !PROMPT_SECTION_TASK_SPECIFICITY.includes(PROMPT_SECTION_BEHAVIOR_NOT_FORM),
    'PROMPT_SECTION_TASK_SPECIFICITY must not already contain the behavior-not-form section',
  );
  assert.ok(
    !PROMPT_SECTION_SYMBOL_ANCHOR.includes(PROMPT_SECTION_BEHAVIOR_NOT_FORM),
    'PROMPT_SECTION_SYMBOL_ANCHOR must not already contain the behavior-not-form section',
  );

  // And the sibling constants are not a substring of the new section either — it is
  // genuinely new text, not a rename of an existing section.
  assert.ok(
    !PROMPT_SECTION_BEHAVIOR_NOT_FORM.includes(PROMPT_SECTION_TASK_SPECIFICITY),
    'behavior-not-form section must be new text, not a wrapper around TASK_SPECIFICITY',
  );
});

// ── TC7 (discrimination): removing the wiring would be detectable ─────────────
// Reconstruct what each builder would look like WITHOUT interpolating the new
// section, and assert that reconstruction does NOT contain the section heading —
// i.e. the heading's presence in the real builder output is solely due to the
// explicit wiring, so a wiring removal flips TC3/TC4/TC5 to failure.

await test('discrimination: heading is absent from a builder body stripped of the section', async () => {
  const heading = '## Describe behavior + acceptance criteria, not incidental form';
  const stripped = buildMissionSystemPrompt(7).split(PROMPT_SECTION_BEHAVIOR_NOT_FORM).join('');
  assert.ok(
    !stripped.includes(heading),
    'after removing the behavior-not-form section, the mission prompt should not still contain the heading '
    + '(if it does, the heading text leaked into another section and the wiring tests would be unreliable)',
  );
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
