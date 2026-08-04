#!/usr/bin/env node
/**
 * test-eval-token-extraction.js — Tests for the -e/--eval payload excision
 * in extractPathTokens (spec: the 2026-07-27 incident where a `node -e
 * "<inline JS>"` acceptance command's payload contained path-like strings
 * that were misread as path tokens).
 *
 * Coverage (numbered after the spec's acceptance criteria):
 *   TC1 — the verbatim 2026-07-27 incident command: a `node -e "<inline
 *         JS>"` acceptance command whose payload contains path-like
 *         strings yields NO token originating from the payload
 *   TC2 — 'node -e "..." && node test/x.js' deep-equals ['test/x.js']
 *         (the real trailing operand survives excision of the eval flag)
 *   TC3 — table: --eval (long-flag, space-separated), --eval=<payload>
 *         (equals form), '-e' single-quoted payload, and '-e' bare
 *         unquoted single-word payload all drop their payload while the
 *         trailing real path operand test/b.js is still returned
 *   TC4 — "sed -e 's|old|new|' src/x.js" deep-equals ['src/x.js'], pinning
 *         the blanket command-agnostic rule (excision applies regardless
 *         of the leading command, node/sed/grep alike)
 *   TC5 — isMilestoneOnlyCheck({ name, command }, specTargetFiles) returns
 *         true for an eval-only command (all path-like strings live
 *         inside the -e payload, so after excision there are zero path
 *         tokens)
 *   TC6 — two representative non-eval commands tokenize to the same
 *         result as before the change: 'npm test -- test/test-a.js' and a
 *         quoted grep command referencing src/orchestrator/core/pipeline.js
 *   TC7 — lint-level integration: a spec-shaped fixture (a globalPlan whose
 *         mission declares a targetFile, matching specTargetFiles, and a
 *         specAcceptanceCriteria entry whose kind='command' verification
 *         embeds the 2026-07-27 incident's inline JS in a -e payload
 *         alongside a reference to the declared file) does NOT throw when
 *         passed to lintGlobalPlanScope — the eval payload is excised and
 *         the real trailing path token is covered by the mission's
 *         targetFiles.
 *
 * Run: node test/test-eval-token-extraction.js
 *
 * No live Claude sessions are spawned — all agent interactions are stubbed;
 * this file only imports the pure extractPathTokens/isMilestoneOnlyCheck
 * functions from planner.js and the pure lintGlobalPlanScope function from
 * plan-scope-lint.js, asserting on their return values / non-throwing
 * behavior. No real SDK access occurs anywhere in this file.
 */

import assert from 'assert';
import { extractPathTokens, isMilestoneOnlyCheck } from '../src/orchestrator/agents/planner.js';
import { lintGlobalPlanScope } from '../src/orchestrator/gates/plan-scope-lint.js';

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

// The verbatim 2026-07-27 incident command: a `node -e "<inline JS>"`
// acceptance command whose payload contains path-like strings
// ('./src/orchestrator/agents/planner.js').
const INCIDENT_COMMAND =
  'node -e "import(\'./src/orchestrator/agents/planner.js\').then(m => m.run())"';

// ── TC1 ──────────────────────────────────────────────────────────────────

await test('TC1: the verbatim 2026-07-27 incident command yields no token from the -e payload', () => {
  const tokens = extractPathTokens(INCIDENT_COMMAND);
  assert.deepStrictEqual(
    tokens,
    [],
    `extractPathTokens(INCIDENT_COMMAND) expected [] (no token from the -e payload), got ${JSON.stringify(tokens)}`,
  );
  // Extra hygiene: no returned token may reference the payload's path string.
  assert.ok(
    !tokens.some((t) => t.includes('orchestrator/agents/planner.js')),
    'no returned token may originate from the -e payload',
  );
});

// ── TC2 ──────────────────────────────────────────────────────────────────

await test("TC2: 'node -e \"...\" && node test/x.js' deep-equals ['test/x.js']", () => {
  const cmd = 'node -e "..." && node test/x.js';
  assert.deepStrictEqual(extractPathTokens(cmd), ['test/x.js']);
});

// ── TC3 ──────────────────────────────────────────────────────────────────

await test('TC3: --eval, --eval=, single-quoted, and bare payload forms drop the payload and keep test/b.js', () => {
  const table = [
    // --eval long-flag, space-separated, double-quoted payload.
    { cmd: 'node --eval "..." test/b.js', expected: ['test/b.js'] },
    // --eval=<payload> equals form, double-quoted payload.
    { cmd: 'node --eval="..." test/b.js', expected: ['test/b.js'] },
    // -e single-quoted payload.
    { cmd: "node -e '...' test/b.js", expected: ['test/b.js'] },
    // -e bare unquoted single-word payload.
    { cmd: 'node -e payload test/b.js', expected: ['test/b.js'] },
  ];

  for (const { cmd, expected } of table) {
    const actual = extractPathTokens(cmd);
    assert.deepStrictEqual(
      actual,
      expected,
      `extractPathTokens(${JSON.stringify(cmd)}) expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
});

// ── TC4 ──────────────────────────────────────────────────────────────────

await test("TC4: \"sed -e 's|old|new|' src/x.js\" deep-equals ['src/x.js'] (blanket command-agnostic rule)", () => {
  const cmd = "sed -e 's|old|new|' src/x.js";
  assert.deepStrictEqual(extractPathTokens(cmd), ['src/x.js']);
});

// ── TC5 ──────────────────────────────────────────────────────────────────

await test('TC5: isMilestoneOnlyCheck returns true for an eval-only command (all path-like strings inside the -e payload)', () => {
  const check = { name: 'incident repro', command: INCIDENT_COMMAND };
  const specTargetFiles = ['src/orchestrator/agents/planner.js'];
  const result = isMilestoneOnlyCheck(check, specTargetFiles);
  assert.strictEqual(
    result,
    true,
    `isMilestoneOnlyCheck must classify the eval-only command as milestone-only, got ${result}`,
  );
});

// ── TC6 ──────────────────────────────────────────────────────────────────

await test('TC6: representative non-eval commands tokenize unchanged', () => {
  assert.deepStrictEqual(
    extractPathTokens('npm test -- test/test-a.js'),
    ['test/test-a.js'],
  );
  assert.deepStrictEqual(
    extractPathTokens('bash -c "! grep -n X src/orchestrator/core/pipeline.js"'),
    ['src/orchestrator/core/pipeline.js'],
  );
});

// ── TC7 ──────────────────────────────────────────────────────────────────

await test('TC7: lintGlobalPlanScope does not throw for a spec-shaped fixture whose eval-embedding acceptance command references a declared mission targetFile', () => {
  const declaredFile = 'test/test-eval-token-extraction.js';

  // A spec-shaped fixture: a globalPlan whose mission declares the
  // referenced file in targetFiles.
  const globalPlan = {
    missions: [
      {
        id: 'mission-1',
        targetFiles: [declaredFile],
      },
    ],
  };

  const specTargetFiles = [declaredFile];

  // The acceptance command embeds the incident's inline JS in a -e
  // payload alongside a reference to the declared file, mirroring TC2's
  // 'node -e "..." && node test/x.js' pattern — the -e payload is excised
  // and the trailing real path operand is the token that must be covered.
  const specAcceptanceCriteria = [
    {
      description: 'Eval-embedding acceptance command is covered by mission targetFiles',
      verification: {
        kind: 'command',
        command: `${INCIDENT_COMMAND} && node ${declaredFile}`,
      },
    },
  ];

  // Sanity: the fixture criterion is checkable via kind === 'command' so
  // lintGlobalPlanScope treats it as checkable at all.
  assert.strictEqual(specAcceptanceCriteria[0].verification.kind, 'command');

  assert.doesNotThrow(() => {
    lintGlobalPlanScope(globalPlan, specTargetFiles, specAcceptanceCriteria);
  }, 'lintGlobalPlanScope must not throw when the eval-embedding command\'s real path token is covered by the mission\'s declared targetFiles');
});

// ── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
