/**
 * test-brainstormer-prompt-verification.js — Tests that buildBrainstormerPrompt
 * teaches the three `verification` kinds and steers command/file-check over
 * manual.
 *
 * The prompt is the place the brainstormer agent learns the verification
 * contract at ask-time. It must:
 *   - name all three kinds: command, file-check, manual
 *   - explain each kind's required sub-fields (command/targetFile, targetFile,
 *     manualSteps)
 *   - steer command/file-check first; manual is an escape hatch
 *     (UI / pure-subjective only)
 *
 * No Claude auth, no SDK. Pure string assertions on the prompt.
 *
 * Run: node test/test-brainstormer-prompt-verification.js
 */
import assert from 'assert';
import { buildBrainstormerPrompt } from '../src/orchestrator/agents/brainstormer.js';

let passCount = 0;
let failCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

const prompt = buildBrainstormerPrompt({ mode: 'initialize', userInput: 'Add a foo subcommand' });

// ── TC1: prompt names all three verification kinds ──────────────────────────

await test('TC1: prompt teaches the three verification kinds (command, file-check, manual)', () => {
  assert.ok(prompt.includes('verification'), 'prompt must mention "verification"');
  assert.ok(prompt.includes('command'), 'prompt must mention the "command" kind');
  assert.ok(prompt.includes('file-check'), 'prompt must mention the "file-check" kind');
  assert.ok(prompt.includes('manual'), 'prompt must mention the "manual" kind');
});

// ── TC2: prompt explains each kind's required sub-fields ─────────────────────

await test('TC2: prompt explains required sub-fields per kind', () => {
  assert.ok(prompt.includes('targetFile'), 'prompt must mention targetFile');
  assert.ok(prompt.includes('manualSteps'), 'prompt must mention manualSteps');
  assert.ok(
    prompt.includes('target_files'),
    'prompt must instruct that command/file-check targetFile must be one of target_files'
  );
});

// ── TC3: prompt steers command/file-check over manual ───────────────────────

await test('TC3: prompt steers command/file-check over manual (escape hatch)', () => {
  // manual is described as an escape hatch / last resort relative to the
  // deterministic command/file-check kinds.
  assert.ok(
    /escape hatch|last resort|only when|prefer|favou?r/i.test(prompt),
    'prompt must steer toward command/file-check (escape-hatch / prefer language)'
  );
});

// ── TC4: the OLD optional free-string evidence contract is gone ─────────────

await test('TC4: prompt no longer documents the old optional `evidence` free-string', () => {
  // The acceptance_criteria item shape should now anchor on verification,
  // not on an `evidence` free string.
  assert.ok(
    !/\bevidence\b/i.test(prompt),
    'prompt must not reference the retired free-string `evidence` field'
  );
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
