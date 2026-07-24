#!/usr/bin/env node
/**
 * test-gitignore-stanza-and-compound-evidence.js — fast-follow behavior:
 *
 * Spec B — classifyEvidence(evidence, targetFiles) (src/orchestrator/core/user-spec.js)
 *   NEW: a compound command chained with '&&' is command-shaped even when its
 *   first token is NOT a known runner. Cases:
 *     CB1 — compound grep with a targetFiles match → kind 'command', targetFile.
 *     CB2 — same compound, no match in targetFiles → kind 'manual' (command kept).
 *     CB3 — single non-runner grep (no '&&') → NOT command-shaped → manual.
 *     CB4 — runner-prefixed simple command with match → command (control).
 *     CB5 — prose with '&&' but no file token → manual (file-token gate holds).
 *     CB6 — end-to-end via projectUserSpec: compound grep evidence + scope_in
 *           file → acceptance_criteria[0].verification.kind === 'command'.
 *
 * No Claude auth, no SDK, no network. Spec B is pure function calls.
 *
 * Run: node test/test-gitignore-stanza-and-compound-evidence.js
 */
import { classifyEvidence, projectUserSpec } from '../src/orchestrator/core/user-spec.js';

let passCount = 0;
let failCount = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passCount++;
  } else {
    console.log(`  [FAIL] ${label}`);
    failCount++;
  }
}

// ── Spec B: classifyEvidence compound-command shape ───────────────────────────

function specB() {
  console.log('\n=== Spec B: classifyEvidence compound-command shape ===\n');

  const COMPOUND = 'grep -q "a" scripts/run-tests.js && grep -q "b" scripts/run-tests.js';
  const SINGLE = 'grep -q "a" scripts/run-tests.js';

  // CB1 — compound grep with a targetFiles match → command + targetFile.
  console.log('CB1: compound grep, target matches → kind "command" with targetFile\n');
  {
    const result = classifyEvidence(COMPOUND, ['scripts/run-tests.js']);
    assert('CB1a: kind === "command"', result.kind === 'command');
    assert('CB1b: targetFile === "scripts/run-tests.js"', result.targetFile === 'scripts/run-tests.js');
  }

  // CB2 — same compound, no match → manual with command preserved.
  console.log('\nCB2: compound grep, no target match → kind "manual", command preserved\n');
  {
    const result = classifyEvidence(COMPOUND, ['scripts/other.js']);
    assert('CB2a: kind === "manual"', result.kind === 'manual');
    assert('CB2b: manualSteps preserves the compound command', result.manualSteps === COMPOUND);
  }

  // CB3 — single non-runner grep (no '&&') → NOT command-shaped → manual.
  console.log('\nCB3: single non-runner grep (no "&&") → NOT command-shaped → manual\n');
  {
    const result = classifyEvidence(SINGLE, ['scripts/run-tests.js']);
    assert('CB3a: kind === "manual" (boundary pin: single non-runner not command-shaped)',
      result.kind === 'manual');
  }

  // CB4 — runner-prefixed simple command with match → command (control).
  console.log('\nCB4: runner-prefixed simple command with match → kind "command" (control)\n');
  {
    const result = classifyEvidence('node test/test-x.js', ['test/test-x.js']);
    assert('CB4a: kind === "command"', result.kind === 'command');
    assert('CB4b: targetFile === "test/test-x.js"', result.targetFile === 'test/test-x.js');
  }

  // CB5 — prose with '&&' but no file token → manual (file-token gate holds).
  console.log('\nCB5: prose with "&&" but no file token → manual (file-token requirement gates)\n');
  {
    const result = classifyEvidence('fast && correct', []);
    assert('CB5a: kind === "manual"', result.kind === 'manual');
  }

  // CB6 — end-to-end via projectUserSpec: compound grep evidence + scope_in file
  //       → acceptance_criteria[0].verification.kind === 'command'.
  console.log('\nCB6: projectUserSpec end-to-end — compound grep evidence projects to a command verification\n');
  {
    const userSpec = {
      goal: 'Register the new test in the runner',
      scope_in: [
        { label: 'Register test', files: ['scripts/run-tests.js'] },
      ],
      success_criteria: [
        { description: 'Runner references the new test', evidence: COMPOUND },
      ],
    };
    const { specJson } = projectUserSpec(userSpec);
    assert('CB6a: acceptance_criteria is non-empty',
      Array.isArray(specJson.acceptance_criteria) && specJson.acceptance_criteria.length > 0);
    const first = specJson.acceptance_criteria[0];
    assert('CB6b: acceptance_criteria[0].verification.kind === "command"',
      first && first.verification && first.verification.kind === 'command');
  }
}

// ── Run ────────────────────────────────────────────────────────────────────────

specB();

console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
