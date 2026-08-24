/**
 * test-phantom-write-readonly-sentinel.js — Deterministic unit test for the
 * phantom-write NO-OP diagnostic sentinel formatter (mission 001-002).
 *
 * Tests the pure formatter `formatZeroDeltaLog(taskId, unchangedFiles)`
 * exported from src/orchestrator/core/pipeline.js. No live agent pipeline
 * is spawned; all assertions are synchronous and deterministic.
 *
 * TC1: Formatter(taskId, unchangedFiles) return string contains the literal token '[zero-delta-task]'
 * TC2: Returned string contains the supplied task id
 * TC3: Returned string contains each supplied unchanged file path
 * TC4: pipeline.js source contains '[zero-delta-task]' exactly once (single-emission guard)
 * TC5: node test/test-phantom-write-readonly-sentinel.js exits 0 deterministically with no agent spawn
 * TC-MANIFEST-3: no undeclared milestone test file exists — this file is a
 *   member of TEST_FILES, and test/test-phantom-probe-byteidentity.js
 *   neither exists on disk nor appears in TEST_FILES
 *
 * TC-PROBE-1: a test-local pure helper `extractRedundancyProbeClause(source)`
 *   locates the prompt-template conditional in src/orchestrator/agents/
 *   verifier.js gated on the literal token `opts.redundancyProbe` and
 *   returns the true-branch / false-branch clause text, asserting that the
 *   non-probe (false) branch contribution carries neither the citation-
 *   request marker text nor the `redundancyCitations` token, that every
 *   occurrence of `redundancyCitations` in verifier.js's prompt template
 *   lies inside the true branch, and that the helper fails loudly (throws a
 *   descriptive error) rather than vacuously passing when the conditional
 *   seam is missing from the supplied source.
 *
 * TC-PROBE-4: asserts the literal context key `redundancyProbe` — not
 *   `phantomWriteProbe` nor any alias — is the flag used on BOTH sides of
 *   the verifier-dispatch seam: verifier.js reads it as
 *   `Boolean(context.redundancyProbe)`, and pipeline.js sets the key
 *   `redundancyProbe: true` on the verifier dispatch context. Also asserts
 *   no alias key form leaks: no `phantomWriteProbe:` object-key form
 *   appears in the verifier dispatch context in pipeline.js, and
 *   verifier.js never reads `context.phantomWriteProbe` (pipeline.js's
 *   local boolean variable named `phantomWriteProbe` is not a context key
 *   and must not trip this assertion).
 *
 * Run: node test/test-phantom-write-readonly-sentinel.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatZeroDeltaLog } from '../src/orchestrator/core/pipeline.js';
import { TEST_FILES } from '../scripts/run-tests.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log(`PASS  ${name}`); passCount++; },
    (err) => {
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
      failCount++;
    }
  );
}

const SAMPLE_TASK_ID = '001-002-003-004';
const SAMPLE_UNCHANGED_FILES = ['src/a.js', 'src/b.js'];

/**
 * extractRedundancyProbeClause(source) — test-local pure helper.
 *
 * Locates the ternary conditional in the supplied source text (expected to
 * be the text of src/orchestrator/agents/verifier.js) that is gated on the
 * literal token `opts.redundancyProbe`, i.e. a construct shaped like:
 *
 *   ${opts.redundancyProbe ? `
 *   ...true-branch text...
 *   ` : ''}
 *
 * and returns { trueClause, falseClause } — the raw text emitted when the
 * flag is true and the raw text emitted when it is false, respectively.
 *
 * Parsing is done with a small hand-rolled scanner (not a JS parser): once
 * the `opts.redundancyProbe ?` anchor and its opening backtick are found,
 * the true-branch content is the literal text up to the next UNESCAPED
 * backtick (a backslash-escaped backtick, `\``, is treated as literal
 * content and does not terminate the branch — this mirrors how the prompt
 * template itself escapes literal backticks it wants rendered in the
 * output). The false branch is parsed the same way if it is a template
 * literal, or as a quoted string otherwise.
 *
 * Throws a descriptive Error (rather than returning a value that could
 * vacuously satisfy an assertion) whenever the conditional seam cannot be
 * located — e.g. because the `opts.redundancyProbe` gate token is absent,
 * there is no following `?`, or a branch is unterminated. This ensures a
 * removed seam fails the test loudly instead of silently passing.
 *
 * @param {string} source - full text of verifier.js (or an equivalent
 *   snippet under test).
 * @returns {{ trueClause: string, falseClause: string }}
 */
function extractRedundancyProbeClause(source) {
  if (typeof source !== 'string') {
    throw new Error('extractRedundancyProbeClause: expected a string source');
  }

  const gateToken = 'opts.redundancyProbe';
  if (source.indexOf(gateToken) === -1) {
    throw new Error(
      `extractRedundancyProbeClause: gate token '${gateToken}' not found in supplied source — the opts.redundancyProbe conditional seam is missing`
    );
  }

  // Anchor specifically on the TERNARY usage of the gate token — i.e.
  // `opts.redundancyProbe` immediately followed (modulo whitespace) by the
  // ternary '?'. This deliberately skips prose occurrences of the same
  // token (e.g. a doc-comment line describing `opts.redundancyProbe` as a
  // parameter) which are not themselves a conditional.
  const ternaryGateRe = /opts\.redundancyProbe\s*\?/;
  const gateMatch = ternaryGateRe.exec(source);
  if (!gateMatch) {
    throw new Error(
      `extractRedundancyProbeClause: found gate token '${gateToken}' but no ternary '?' immediately after it — not a conditional`
    );
  }
  const qIdx = gateMatch.index + gateMatch[0].length - 1;

  const trueStart = source.indexOf('`', qIdx);
  if (trueStart === -1) {
    throw new Error(
      `extractRedundancyProbeClause: no template-literal true-branch found after '${gateToken} ?'`
    );
  }

  // Scans a template literal starting at `str[openIdx]` (which must be a
  // backtick). Returns { content, endIdx } where endIdx is the index of the
  // closing (unescaped) backtick, or null if unterminated. Escaped
  // backticks (\`) are kept in `content` verbatim and do not close the
  // literal — they represent a literal backtick character intended for the
  // rendered prompt text (see verifier.js's \`redundancyCitations\` etc.).
  function parseTemplateLiteral(str, openIdx) {
    let i = openIdx + 1;
    let content = '';
    while (i < str.length) {
      if (str[i] === '\\' && i + 1 < str.length) {
        content += str[i] + str[i + 1];
        i += 2;
        continue;
      }
      if (str[i] === '`') {
        return { content, endIdx: i };
      }
      content += str[i];
      i++;
    }
    return null;
  }

  const trueParsed = parseTemplateLiteral(source, trueStart);
  if (!trueParsed) {
    throw new Error('extractRedundancyProbeClause: unterminated template-literal true-branch');
  }
  const trueClause = trueParsed.content;

  const colonIdx = source.indexOf(':', trueParsed.endIdx + 1);
  if (colonIdx === -1) {
    throw new Error("extractRedundancyProbeClause: no ':' found after true-branch — malformed ternary");
  }

  let j = colonIdx + 1;
  while (j < source.length && /\s/.test(source[j])) j++;

  let falseClause;
  if (source[j] === '`') {
    const falseParsed = parseTemplateLiteral(source, j);
    if (!falseParsed) {
      throw new Error('extractRedundancyProbeClause: unterminated template-literal false-branch');
    }
    falseClause = falseParsed.content;
  } else if (source[j] === "'" || source[j] === '"') {
    const quote = source[j];
    let k = j + 1;
    let content = '';
    let terminated = false;
    while (k < source.length) {
      if (source[k] === '\\' && k + 1 < source.length) {
        content += source[k] + source[k + 1];
        k += 2;
        continue;
      }
      if (source[k] === quote) { terminated = true; break; }
      content += source[k];
      k++;
    }
    if (!terminated) {
      throw new Error('extractRedundancyProbeClause: unterminated quoted-string false-branch');
    }
    falseClause = content;
  } else {
    throw new Error(
      `extractRedundancyProbeClause: unrecognized false-branch syntax at position ${j}`
    );
  }

  return { trueClause, falseClause };
}

await test('TC1: formatter return string contains the literal token [zero-delta-task]', async () => {
  const result = formatZeroDeltaLog(SAMPLE_TASK_ID, SAMPLE_UNCHANGED_FILES);
  assert.ok(
    result.includes('[zero-delta-task]'),
    `Expected result to contain '[zero-delta-task]', got: ${result}`
  );
});

await test('TC2: returned string contains the supplied task id', async () => {
  const result = formatZeroDeltaLog(SAMPLE_TASK_ID, SAMPLE_UNCHANGED_FILES);
  assert.ok(
    result.includes(SAMPLE_TASK_ID),
    `Expected result to contain task id '${SAMPLE_TASK_ID}', got: ${result}`
  );
});

await test('TC3: returned string contains each supplied unchanged file path', async () => {
  const result = formatZeroDeltaLog(SAMPLE_TASK_ID, SAMPLE_UNCHANGED_FILES);
  for (const filePath of SAMPLE_UNCHANGED_FILES) {
    assert.ok(
      result.includes(filePath),
      `Expected result to contain file path '${filePath}', got: ${result}`
    );
  }
});

await test('TC4: pipeline.js source contains [zero-delta-task] exactly once (single-emission guard)', async () => {
  const pipelinePath = path.resolve(__dirname, '../src/orchestrator/core/pipeline.js');
  const source = fs.readFileSync(pipelinePath, 'utf8');
  const token = '[zero-delta-task]';
  const occurrences = source.split(token).length - 1;
  assert.strictEqual(
    occurrences,
    1,
    `Expected '[zero-delta-task]' to appear exactly once in pipeline.js, but found ${occurrences} occurrence(s)`
  );
});

await test('TC-MANIFEST-3: no undeclared milestone test file exists', async () => {
  const sentinelPath = 'test/test-phantom-write-readonly-sentinel.js';
  const phantomProbePath = 'test/test-phantom-probe-byteidentity.js';

  assert.ok(
    TEST_FILES.includes(sentinelPath),
    `Expected TEST_FILES to include '${sentinelPath}', but it is missing`
  );

  const phantomProbeAbsPath = path.resolve(__dirname, '..', phantomProbePath);
  assert.strictEqual(
    fs.existsSync(phantomProbeAbsPath),
    false,
    `Expected '${phantomProbePath}' to not exist on disk, but it does: ${phantomProbeAbsPath}`
  );

  assert.ok(
    !TEST_FILES.includes(phantomProbePath),
    `Expected TEST_FILES to not include '${phantomProbePath}', but it is present`
  );
});

const CITATION_MARKER = 'Redundancy probe (this is a redundancy probe run)';
const CITATION_TOKEN = 'redundancyCitations';

await test("TC-PROBE-1: extractRedundancyProbeClause false-branch does not contain the citation-request marker text", async () => {
  const verifierPath = path.resolve(__dirname, '../src/orchestrator/agents/verifier.js');
  const verifierSource = fs.readFileSync(verifierPath, 'utf8');
  const { falseClause } = extractRedundancyProbeClause(verifierSource);
  assert.ok(
    !falseClause.includes(CITATION_MARKER),
    `Expected the opts.redundancyProbe false-branch to NOT contain '${CITATION_MARKER}', got: ${JSON.stringify(falseClause)}`
  );
});

await test("TC-PROBE-1: extractRedundancyProbeClause false-branch does not contain 'redundancyCitations'", async () => {
  const verifierPath = path.resolve(__dirname, '../src/orchestrator/agents/verifier.js');
  const verifierSource = fs.readFileSync(verifierPath, 'utf8');
  const { falseClause } = extractRedundancyProbeClause(verifierSource);
  assert.ok(
    !falseClause.includes(CITATION_TOKEN),
    `Expected the opts.redundancyProbe false-branch to NOT contain '${CITATION_TOKEN}', got: ${JSON.stringify(falseClause)}`
  );
});

await test("TC-PROBE-1: every occurrence of 'redundancyCitations' in verifier.js's prompt template falls inside the true branch", async () => {
  const verifierPath = path.resolve(__dirname, '../src/orchestrator/agents/verifier.js');
  const verifierSource = fs.readFileSync(verifierPath, 'utf8');
  const { trueClause } = extractRedundancyProbeClause(verifierSource);

  const totalOccurrences = verifierSource.split(CITATION_TOKEN).length - 1;
  const trueClauseOccurrences = trueClause.split(CITATION_TOKEN).length - 1;

  assert.ok(
    totalOccurrences > 0,
    `Expected '${CITATION_TOKEN}' to appear at least once in verifier.js, found ${totalOccurrences}`
  );
  assert.strictEqual(
    trueClauseOccurrences,
    totalOccurrences,
    `Expected all ${totalOccurrences} occurrence(s) of '${CITATION_TOKEN}' in verifier.js to fall inside the opts.redundancyProbe true branch, but only ${trueClauseOccurrences} of them do — a verifier dispatch context WITHOUT redundancyProbe would leak the citation-request clause`
  );
});

await test('TC-PROBE-1: extractRedundancyProbeClause throws a descriptive error when the opts.redundancyProbe conditional is absent', async () => {
  const sourceWithoutSeam = `
    const prompt = \`Verify task \${task.id}.
    ${'${opts.includeFindingsPrompt ? `findings text` : \'\'}'}
    No redundancy probe conditional here at all.\`;
  `;

  let thrown = null;
  let result;
  try {
    result = extractRedundancyProbeClause(sourceWithoutSeam);
  } catch (err) {
    thrown = err;
  }

  assert.ok(
    thrown !== null || result === null,
    'Expected extractRedundancyProbeClause to either throw or return null when the opts.redundancyProbe conditional seam is absent'
  );
  if (thrown !== null) {
    assert.ok(
      thrown instanceof Error && typeof thrown.message === 'string' && thrown.message.length > 0,
      `Expected a descriptive Error, got: ${thrown}`
    );
    assert.ok(
      thrown.message.includes('opts.redundancyProbe'),
      `Expected the error message to reference the missing 'opts.redundancyProbe' gate token, got: ${thrown.message}`
    );
  }
});

await test("TC-PROBE-2: extractRedundancyProbeClause true-branch contains the citation-request marker text", async () => {
  const verifierPath = path.resolve(__dirname, '../src/orchestrator/agents/verifier.js');
  const verifierSource = fs.readFileSync(verifierPath, 'utf8');
  const { trueClause } = extractRedundancyProbeClause(verifierSource);
  assert.ok(
    trueClause.includes(CITATION_MARKER),
    `Expected the opts.redundancyProbe true-branch to contain '${CITATION_MARKER}', got: ${JSON.stringify(trueClause)}`
  );
});

await test("TC-PROBE-2: extractRedundancyProbeClause true-branch contains 'redundancyCitations'", async () => {
  const verifierPath = path.resolve(__dirname, '../src/orchestrator/agents/verifier.js');
  const verifierSource = fs.readFileSync(verifierPath, 'utf8');
  const { trueClause } = extractRedundancyProbeClause(verifierSource);
  assert.ok(
    trueClause.includes(CITATION_TOKEN),
    `Expected the opts.redundancyProbe true-branch to contain '${CITATION_TOKEN}', got: ${JSON.stringify(trueClause)}`
  );
});

await test("TC-PROBE-2: the citation-request marker text appears exactly once in verifier.js (no double-emission)", async () => {
  const verifierPath = path.resolve(__dirname, '../src/orchestrator/agents/verifier.js');
  const verifierSource = fs.readFileSync(verifierPath, 'utf8');
  const occurrences = verifierSource.split(CITATION_MARKER).length - 1;
  assert.strictEqual(
    occurrences,
    1,
    `Expected '${CITATION_MARKER}' to appear exactly once in verifier.js, but found ${occurrences} occurrence(s)`
  );
});

await test("TC-PROBE-3: the false branch of the opts.redundancyProbe conditional strictEquals '' (empty string)", async () => {
  const verifierPath = path.resolve(__dirname, '../src/orchestrator/agents/verifier.js');
  const verifierSource = fs.readFileSync(verifierPath, 'utf8');
  const { falseClause } = extractRedundancyProbeClause(verifierSource);
  assert.strictEqual(
    falseClause,
    '',
    `Expected the opts.redundancyProbe false-branch to strictly equal '' (contributing no whitespace to a non-probe prompt), got: ${JSON.stringify(falseClause)}`
  );
});

await test("TC-PROBE-3: the false-branch contribution has length 0, so it is not a newline or any whitespace-only string", async () => {
  const verifierPath = path.resolve(__dirname, '../src/orchestrator/agents/verifier.js');
  const verifierSource = fs.readFileSync(verifierPath, 'utf8');
  const { falseClause } = extractRedundancyProbeClause(verifierSource);
  assert.strictEqual(
    falseClause.length,
    0,
    `Expected the opts.redundancyProbe false-branch contribution to have length 0, got length ${falseClause.length}: ${JSON.stringify(falseClause)}`
  );
  assert.notStrictEqual(
    falseClause,
    '\n',
    'Expected the false-branch contribution to not be a bare newline'
  );
  assert.strictEqual(
    /^\s+$/.test(falseClause),
    false,
    `Expected the false-branch contribution to not be a whitespace-only string, got: ${JSON.stringify(falseClause)}`
  );
});

await test("TC-PROBE-4: verifier.js source contains the read site 'Boolean(context.redundancyProbe)'", async () => {
  const verifierPath = path.resolve(__dirname, '../src/orchestrator/agents/verifier.js');
  const verifierSource = fs.readFileSync(verifierPath, 'utf8');
  assert.ok(
    verifierSource.includes('Boolean(context.redundancyProbe)'),
    `Expected verifier.js to contain the read site 'Boolean(context.redundancyProbe)', but it was not found`
  );
});

await test("TC-PROBE-4: pipeline.js source contains the dispatch-context key 'redundancyProbe: true'", async () => {
  const pipelinePath = path.resolve(__dirname, '../src/orchestrator/core/pipeline.js');
  const pipelineSource = fs.readFileSync(pipelinePath, 'utf8');
  assert.ok(
    pipelineSource.includes('redundancyProbe: true'),
    `Expected pipeline.js to contain the dispatch-context key 'redundancyProbe: true', but it was not found`
  );
});

await test("TC-PROBE-4: verifier.js source contains no 'context.phantomWriteProbe' read", async () => {
  const verifierPath = path.resolve(__dirname, '../src/orchestrator/agents/verifier.js');
  const verifierSource = fs.readFileSync(verifierPath, 'utf8');
  assert.ok(
    !verifierSource.includes('context.phantomWriteProbe'),
    `Expected verifier.js to NOT contain 'context.phantomWriteProbe' — the flag must be read only as 'context.redundancyProbe', but the alias read site was found`
  );
});

await test("TC-PROBE-4: pipeline.js verifier dispatch context contains no 'phantomWriteProbe:' key form", async () => {
  const pipelinePath = path.resolve(__dirname, '../src/orchestrator/core/pipeline.js');
  const pipelineSource = fs.readFileSync(pipelinePath, 'utf8');

  // Scope the assertion to the verifier dispatch call site(s) — lines that
  // invoke `this.verifier.verifyTask(` — rather than the whole file, so
  // that pipeline.js's unrelated LOCAL variable named `phantomWriteProbe`
  // (e.g. `let phantomWriteProbe = false;`, `phantomWriteProbe = true;`,
  // `if (phantomWriteProbe) { ... }`) does not trip this assertion. Only
  // an object-KEY form — the literal substring `phantomWriteProbe:` —
  // inside a dispatch call would indicate the alias key is actually being
  // set on the context object passed to verifyTask.
  const dispatchLines = pipelineSource
    .split('\n')
    .filter((line) => line.includes('this.verifier.verifyTask('));

  assert.ok(
    dispatchLines.length > 0,
    'Expected to find at least one verifier dispatch call site (this.verifier.verifyTask(...)) in pipeline.js'
  );

  for (const line of dispatchLines) {
    assert.ok(
      !line.includes('phantomWriteProbe:'),
      `Expected the verifier dispatch context in pipeline.js to NOT contain a 'phantomWriteProbe:' key form, but found it in: ${line}`
    );
  }

  // Also assert no such key form exists anywhere else in pipeline.js
  // (the local variable name `phantomWriteProbe` alone, without a
  // trailing colon forming an object key, is expected and must not fail
  // this check).
  assert.ok(
    !pipelineSource.includes('phantomWriteProbe:'),
    `Expected pipeline.js to NOT contain the object-key form 'phantomWriteProbe:' anywhere — only the local variable name 'phantomWriteProbe' (without a trailing colon) is permitted`
  );
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
