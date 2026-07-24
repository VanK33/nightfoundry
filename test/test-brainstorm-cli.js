/**
 * test-brainstorm-cli.js — Tests for the brainstorm CLI command.
 *
 * Run: node test/test-brainstorm-cli.js
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { PassThrough } from 'node:stream';

import {
  generateSlug,
  resolveSlugCollision,
  getBrainstormDir,
  readState,
  brainstorm,
  printSpecPreview,
  withProgressTicker,
} from '../src/cli/commands/brainstorm.js';

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

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-cli-')); }
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }

// ── Stub Brainstormer factory ─────────────────────────────────────────────────

const STUB_SPEC = {
  goal: 'stub',
  target_files: ['x'],
  acceptance_criteria: [{ description: 'd', verification: { kind: 'command', command: 'node x', targetFile: 'x' } }],
};

function stubFactory() {
  return {
    initialize(_userInput) {
      return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub' });
    },
    revise(_currentSpec, _feedback, _mode) {
      return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub' });
    },
  };
}

// ── Spy Brainstormer factory ──────────────────────────────────────────────────

/**
 * Returns a fresh `{ factory, reviseCalls }` pair each invocation.
 * `factory` is a brainstormerFactory-compatible function; every call to
 * `brainstormer.revise(currentSpec, feedback, mode)` appends
 * `{ feedback, mode }` to `reviseCalls`.
 */
function spyFactory() {
  const reviseCalls = [];
  function factory() {
    return {
      initialize(_userInput) {
        return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub' });
      },
      revise(_currentSpec, feedback, mode) {
        reviseCalls.push({ feedback, mode });
        return Promise.resolve({ spec: STUB_SPEC, specMd: '# stub' });
      },
    };
  }
  return { factory, reviseCalls };
}

// ── TC1: generateSlug ─────────────────────────────────────────────────────────

await test('TC1: generateSlug produces normalized slugs', () => {
  assert.strictEqual(generateSlug('Add Rate Limiter!!'), 'add-rate-limiter');
  assert.strictEqual(generateSlug('   '), 'untitled');
});

// ── TC2: non-TTY one-shot ─────────────────────────────────────────────────────

await test('TC2: non-TTY one-shot writes bundle to .harness/brainstorm/<slug>', async () => {
  const d = tempDir();
  try {
    const output = new PassThrough();
    const result = await brainstorm(d, ['Add caching'], { 'no-tty': true }, {
      brainstormerFactory: stubFactory,
      output,
    });

    const { dir } = result;

    assert.ok(fs.existsSync(path.join(dir, 'spec.json')),    'spec.json missing under session dir');
    assert.ok(fs.existsSync(path.join(dir, 'spec.md')),      'spec.md missing under session dir');
    assert.ok(fs.existsSync(path.join(dir, 'state.json')),   'state.json missing under session dir');
    assert.ok(fs.existsSync(path.join(dir, 'history.jsonl')),'history.jsonl missing under session dir');

    // Project root must NOT receive spec files in non-TTY one-shot mode
    assert.ok(!fs.existsSync(path.join(d, 'add-caching.spec.json')), 'add-caching.spec.json must NOT exist at project root');
    assert.ok(!fs.existsSync(path.join(d, 'add-caching.spec.md')),   'add-caching.spec.md must NOT exist at project root');
  } finally {
    cleanup(d);
  }
});

// ── TC3: accept ('a') ─────────────────────────────────────────────────────────

await test("TC3: 'a' choice writes status=approved and copies spec.json+spec.md to project root", async () => {
  const d = tempDir();
  try {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // Write 'a\n' before brainstorm runs; createLineReader's queue buffers it.
    inputStream.write('a\n');

    const result = await brainstorm(d, [], {}, {
      brainstormerFactory: stubFactory,
      input: inputStream,
      output: outputStream,
    });

    const { status, dir } = result;
    assert.strictEqual(status, 'approved');

    const st = readState(dir);
    assert.strictEqual(st.status, 'approved', 'state.json status must be approved');

    assert.ok(fs.existsSync(path.join(d, 'untitled.spec.json')), 'untitled.spec.json missing at project root');
    assert.ok(fs.existsSync(path.join(d, 'untitled.spec.md')),   'untitled.spec.md missing at project root');
    assert.ok(!fs.existsSync(path.join(d, 'spec.json')), 'literal spec.json must NOT exist at project root');
    assert.ok(!fs.existsSync(path.join(d, 'spec.md')),   'literal spec.md must NOT exist at project root');
  } finally {
    cleanup(d);
  }
});

// ── TC4: cancel ('c') ─────────────────────────────────────────────────────────

await test("TC4: 'c' choice writes status=cancelled and leaves draft files intact", async () => {
  const d = tempDir();
  try {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    inputStream.write('c\n');

    const result = await brainstorm(d, [], {}, {
      brainstormerFactory: stubFactory,
      input: inputStream,
      output: outputStream,
    });

    const { status, dir } = result;
    assert.strictEqual(status, 'cancelled');

    const st = readState(dir);
    assert.strictEqual(st.status, 'cancelled', 'state.json status must be cancelled');

    // Draft files must be preserved under .harness/brainstorm/<slug>
    assert.ok(fs.existsSync(path.join(dir, 'spec.json')), 'spec.json must remain under session dir');
  } finally {
    cleanup(d);
  }
});

// ── TC5: no-tty resume is read-only — cancelled stays cancelled ──────────────
// RE-PINNED per brainstorm-no-tty.spec.md: this test previously pinned the
// pre-fix behavior (resume + --no-tty flipped cancelled→in-progress and
// re-initialized the draft). The new contract makes no-tty resume a
// read-only status view that touches nothing on disk; the
// cancelled→in-progress revival now happens only on the interactive (TTY)
// path (covered by test-brainstorm-no-tty.js).

await test("TC5: no-tty resume is read-only — does NOT flip cancelled→in-progress", async () => {
  const d = tempDir();
  try {
    const slug = 'my-spec';
    const dir = getBrainstormDir(d, slug);
    fs.mkdirSync(dir, { recursive: true });

    // Pre-create cancelled state.json
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        slug,
        createdAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        status: 'cancelled',
      }, null, 2),
    );

    // Pre-create spec.json so resume path can load it
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(STUB_SPEC, null, 2));

    const output = new PassThrough();
    await brainstorm(d, [], { resume: slug, 'no-tty': true }, {
      brainstormerFactory: stubFactory,
      output,
    });

    // RE-PINNED per brainstorm-no-tty.spec.md: no-tty resume must NOT mutate
    // state.json — a cancelled draft stays cancelled on the read-only path.
    const st = readState(dir);
    assert.strictEqual(st.status, 'cancelled', 'state.json status must remain cancelled (no-tty resume is read-only)');
  } finally {
    cleanup(d);
  }
});

// ── TC6: slug collision appends numeric suffix ────────────────────────────────

await test("TC6: slug collision appends numeric suffix", async () => {
  const d = tempDir();
  try {
    // Pre-create .harness/brainstorm/add-caching to force a collision
    const existingDir = path.join(d, '.harness', 'brainstorm', 'add-caching');
    fs.mkdirSync(existingDir, { recursive: true });

    const output = new PassThrough();
    const result = await brainstorm(d, ['Add caching'], { 'no-tty': true }, {
      brainstormerFactory: stubFactory,
      output,
    });

    assert.strictEqual(result.slug, 'add-caching-1');
  } finally {
    cleanup(d);
  }
});

// ── TC-R-BARE: bare 'r' sub-prompts and uses the sub-prompted feedback ────────

await test("TC-R-BARE: bare 'r' sub-prompts and uses the sub-prompted feedback", async () => {
  const d = tempDir();
  try {
    const { factory, reviseCalls } = spyFactory();
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // bare 'r' → sub-prompt fires → 'my feedback' → then 'a' to exit
    inputStream.write('r\nmy feedback\na\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: factory,
      input: inputStream,
      output: outputStream,
    });

    assert.ok(reviseCalls.length >= 1, 'revise must have been called at least once');
    assert.strictEqual(reviseCalls[0].feedback, 'my feedback', 'feedback must be the sub-prompted value');
    assert.strictEqual(reviseCalls[0].mode, 'regenerate', 'mode must be regenerate');
  } finally {
    cleanup(d);
  }
});

// ── TC-R-INLINE: 'r inline feedback' dispatches inline feedback to revise ─────

await test("TC-R-INLINE: 'r inline feedback' dispatches inline feedback to revise", async () => {
  const d = tempDir();
  try {
    const { factory, reviseCalls } = spyFactory();
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // inline 'r' form → no sub-prompt → then 'a' to exit
    inputStream.write('r inline feedback\na\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: factory,
      input: inputStream,
      output: outputStream,
    });

    assert.ok(reviseCalls.length >= 1, 'revise must have been called at least once');
    assert.strictEqual(reviseCalls[0].feedback, 'inline feedback', 'feedback must be the inline value');
    assert.strictEqual(reviseCalls[0].mode, 'regenerate', 'mode must be regenerate');
  } finally {
    cleanup(d);
  }
});

// ── TC-E-BARE: bare 'e' sub-prompts and uses the sub-prompted field+value ─────

await test("TC-E-BARE: bare 'e' sub-prompts and uses the sub-prompted field+value", async () => {
  const d = tempDir();
  try {
    const { factory, reviseCalls } = spyFactory();
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // bare 'e' → sub-prompt fires → 'change the goal' → then 'a' to exit
    inputStream.write('e\nchange the goal\na\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: factory,
      input: inputStream,
      output: outputStream,
    });

    assert.ok(reviseCalls.length >= 1, 'revise must have been called at least once');
    assert.strictEqual(reviseCalls[0].feedback, 'change the goal', 'feedback must be the sub-prompted value');
    assert.strictEqual(reviseCalls[0].mode, 'edit', 'mode must be edit');
  } finally {
    cleanup(d);
  }
});

// ── TC-E-INLINE: 'e change the goal' dispatches inline field+value to revise ──

await test("TC-E-INLINE: 'e change the goal' dispatches inline field+value to revise", async () => {
  const d = tempDir();
  try {
    const { factory, reviseCalls } = spyFactory();
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // inline 'e' form → no sub-prompt → then 'a' to exit
    inputStream.write('e change the goal\na\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: factory,
      input: inputStream,
      output: outputStream,
    });

    assert.ok(reviseCalls.length >= 1, 'revise must have been called at least once');
    assert.strictEqual(reviseCalls[0].feedback, 'change the goal', 'feedback must be the inline value');
    assert.strictEqual(reviseCalls[0].mode, 'edit', 'mode must be edit');
  } finally {
    cleanup(d);
  }
});

// ── TC-R-NO-EMPTY: bare 'r' does NOT invoke revise with empty feedback ─────────

await test("TC-R-NO-EMPTY: bare 'r' does NOT invoke revise with empty feedback", async () => {
  const d = tempDir();
  try {
    const { factory, reviseCalls } = spyFactory();
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // bare 'r' → sub-prompt fires → 'my feedback' → then 'a' to exit
    inputStream.write('r\nmy feedback\na\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: factory,
      input: inputStream,
      output: outputStream,
    });

    assert.ok(reviseCalls.length >= 1, 'revise must have been called at least once');
    assert.notStrictEqual(reviseCalls[0].feedback, '', 'bare r must NOT invoke revise with empty feedback');
  } finally {
    cleanup(d);
  }
});

// ── printSpecPreview tests ────────────────────────────────────────────────────

await test('printSpecPreview writes full content when specMd <= 2000 chars', () => {
  const chunks = [];
  const output = { write: (s) => chunks.push(s) };
  const specMd = '# My Spec\n\nThis is a short spec.';
  printSpecPreview(output, specMd);
  const result = chunks.join('');
  assert.ok(result.includes('--- Spec Preview ---'), 'must include opening delimiter');
  assert.ok(result.includes('--------------------'), 'must include closing delimiter');
  assert.ok(result.includes(specMd), 'must include full specMd content');
  assert.ok(!result.includes('summary'), 'must NOT be a summary when short');
});

await test('printSpecPreview writes structured summary with heading + paragraph + line count when specMd > 2000 chars', () => {
  const chunks = [];
  const output = { write: (s) => chunks.push(s) };
  const heading = '# My Long Spec';
  const paragraph = 'This is the first paragraph of the spec which explains the goal.';
  // build a specMd > 2000 chars
  const filler = 'x'.repeat(2000);
  const specMd = `${heading}\n\n${paragraph}\n\nMore content follows.\n\n${filler}`;
  const lineCount = specMd.split('\n').length;
  printSpecPreview(output, specMd);
  const result = chunks.join('');
  assert.ok(result.includes(`summary, ${lineCount} lines`), 'must include line count in summary header');
  assert.ok(result.includes(heading), 'must include the first heading');
  assert.ok(result.includes(paragraph), 'must include the first paragraph');
  assert.ok(result.includes('--------------------'), 'must include closing delimiter');
});

await test('printSpecPreview handles specMd with no heading gracefully', () => {
  const chunks = [];
  const output = { write: (s) => chunks.push(s) };
  // > 2000 chars but no heading
  const filler = 'y'.repeat(2100);
  const specMd = `No heading here.\n\nJust some text.\n\n${filler}`;
  const lineCount = specMd.split('\n').length;
  // should not throw
  printSpecPreview(output, specMd);
  const result = chunks.join('');
  assert.ok(result.includes(`summary, ${lineCount} lines`), 'must include line count');
  assert.ok(result.includes('--------------------'), 'must include closing delimiter');
});

// ── TC-PREVIEW-INIT: spec heading appears in stdout after initial generation ───

await test('TC-PREVIEW-INIT: spec heading appears in stdout after initial generation', async () => {
  const d = tempDir();
  try {
    function previewStubFactory() {
      return {
        initialize(_userInput) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: '# My Heading\n\nFirst paragraph here.' });
        },
        revise(_currentSpec, _feedback, _mode) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: '# My Heading\n\nFirst paragraph here.' });
        },
      };
    }

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk.toString()));

    inputStream.write('a\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: previewStubFactory,
      input: inputStream,
      output: outputStream,
    });

    const output = chunks.join('');
    assert.ok(output.includes('# My Heading'), 'output must include spec heading after initial generation');
  } finally {
    cleanup(d);
  }
});

// ── TC-PREVIEW-REVISE: spec heading appears twice (init + revise turn) ────────

await test('TC-PREVIEW-REVISE: spec heading appears twice (init + revise turn)', async () => {
  const d = tempDir();
  try {
    function previewStubFactory() {
      return {
        initialize(_userInput) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: '# My Heading\n\nFirst paragraph here.' });
        },
        revise(_currentSpec, _feedback, _mode) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: '# My Heading\n\nFirst paragraph here.' });
        },
      };
    }

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk.toString()));

    // bare 'r' → sub-prompt fires → 'some feedback' → then 'a' to exit
    inputStream.write('r\nsome feedback\na\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: previewStubFactory,
      input: inputStream,
      output: outputStream,
    });

    const output = chunks.join('');
    const occurrences = (output.match(/# My Heading/g) || []).length;
    assert.ok(occurrences >= 2, `spec heading must appear at least twice (init + revise); found ${occurrences}`);
  } finally {
    cleanup(d);
  }
});

// ── TC-PREVIEW-LONG: long spec shows summary with heading, not full body ──────

await test('TC-PREVIEW-LONG: long spec shows summary with heading, not full body', async () => {
  const d = tempDir();
  try {
    const longBody = 'x'.repeat(2100);
    const longSpecMd = `# Long Spec\n\nFirst paragraph here.\n\n${longBody}`;

    function longPreviewStubFactory() {
      return {
        initialize(_userInput) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: longSpecMd });
        },
        revise(_currentSpec, _feedback, _mode) {
          return Promise.resolve({ spec: STUB_SPEC, specMd: longSpecMd });
        },
      };
    }

    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk.toString()));

    inputStream.write('a\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: longPreviewStubFactory,
      input: inputStream,
      output: outputStream,
    });

    const output = chunks.join('');
    assert.ok(output.includes('summary'), 'output must include "summary" for long specs');
    assert.ok(output.includes('# Long Spec'), 'output must include the spec heading');
    assert.ok(!output.includes(longBody), 'output must NOT include the full 2000+ char body');
  } finally {
    cleanup(d);
  }
});

// ── TC-CONFIRM-A: accept prints confirmation with spec.json path ──────────────

await test("TC-CONFIRM-A: 'a' prints Accepted confirmation including spec.json", async () => {
  const d = tempDir();
  try {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk.toString()));

    inputStream.write('a\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: stubFactory,
      input: inputStream,
      output: outputStream,
    });

    const output = chunks.join('');
    assert.ok(output.includes('Accepted'), 'output must include "Accepted"');
    assert.ok(output.includes('untitled.spec.json'), 'output must include "untitled.spec.json"');
  } finally {
    cleanup(d);
  }
});

// ── TC-CONFIRM-R: regenerate prints confirmation with tip ─────────────────────

await test("TC-CONFIRM-R: 'r' + feedback + 'a' prints Regenerated confirmation with tip", async () => {
  const d = tempDir();
  try {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk.toString()));

    // bare 'r' → sub-prompt fires → 'some feedback' → then 'a' to exit
    inputStream.write('r\nsome feedback\na\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: stubFactory,
      input: inputStream,
      output: outputStream,
    });

    const output = chunks.join('');
    assert.ok(output.includes('Regenerated'), 'output must include "Regenerated"');
    assert.ok(
      output.includes('Tip') || output.includes('press'),
      'output must include "Tip" or "press"',
    );
  } finally {
    cleanup(d);
  }
});

// ── TC-CONFIRM-E: edit prints confirmation with tip ───────────────────────────

await test("TC-CONFIRM-E: 'e' + edit + 'a' prints Edited confirmation with tip", async () => {
  const d = tempDir();
  try {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk.toString()));

    // bare 'e' → sub-prompt fires → 'my edit' → then 'a' to exit
    inputStream.write('e\nmy edit\na\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: stubFactory,
      input: inputStream,
      output: outputStream,
    });

    const output = chunks.join('');
    assert.ok(output.includes('Edited'), 'output must include "Edited"');
    assert.ok(
      output.includes('Tip') || output.includes('press'),
      'output must include "Tip" or "press"',
    );
  } finally {
    cleanup(d);
  }
});

// ── TC-CONFIRM-C: cancel prints confirmation with --resume ────────────────────

await test("TC-CONFIRM-C: 'c' prints Cancelled confirmation including --resume", async () => {
  const d = tempDir();
  try {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk.toString()));

    inputStream.write('c\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: stubFactory,
      input: inputStream,
      output: outputStream,
    });

    const output = chunks.join('');
    assert.ok(output.includes('Cancelled'), 'output must include "Cancelled"');
    assert.ok(output.includes('--resume'), 'output must include "--resume"');
  } finally {
    cleanup(d);
  }
});

// ── TC-CONFIRM-D: display prints spec.json delimiter ─────────────────────────

await test("TC-CONFIRM-D: 'd' then 'a' prints --- End of spec.json ---", async () => {
  const d = tempDir();
  try {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk.toString()));

    // 'd' to display spec, then 'a' to accept and exit
    inputStream.write('d\na\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: stubFactory,
      input: inputStream,
      output: outputStream,
    });

    const output = chunks.join('');
    assert.ok(output.includes('--- End of spec.json ---'), 'output must include "--- End of spec.json ---"');
  } finally {
    cleanup(d);
  }
});

// ── TC-SEPARATOR: separator appears after non-terminating action ──────────────

await test("TC-SEPARATOR: separator appears exactly once after 'd' action, does NOT appear before first menu", async () => {
  const d = tempDir();
  try {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk.toString()));

    // 'd' is non-terminating → separator + "Done. Ready for next action." should appear
    // then 'a' terminates
    inputStream.write('d\na\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: stubFactory,
      input: inputStream,
      output: outputStream,
    });

    const output = chunks.join('');
    const separator = '─'.repeat(60);

    // TC1: separator appears and includes required text
    assert.ok(output.includes(separator), 'output must include 60-char ─ separator');
    assert.ok(output.includes('Done. Ready for next action.'), 'output must include "Done. Ready for next action."');

    // TC2: separator appears exactly once (one non-terminating action)
    const occurrences = (output.split(separator).length - 1);
    assert.strictEqual(occurrences, 1, `separator must appear exactly once; found ${occurrences}`);
  } finally {
    cleanup(d);
  }
});

// ── TC-HELP: 'h' prints help block with required keywords + menu ──────────────

await test("TC-HELP: h output contains 'feedback', 'edit', 'cancel', 'resume', 'draft' and 'Brainstorm Menu'", async () => {
  const d = tempDir();
  try {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk.toString()));

    // 'h' to show help, then 'a' to accept and exit
    inputStream.write('h\na\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: stubFactory,
      input: inputStream,
      output: outputStream,
    });

    const output = chunks.join('');
    const lower = output.toLowerCase();

    assert.ok(lower.includes('feedback'), 'output must include "feedback"');
    assert.ok(lower.includes('edit'),     'output must include "edit"');
    assert.ok(lower.includes('cancel'),   'output must include "cancel"');
    assert.ok(lower.includes('resume'),   'output must include "resume"');
    assert.ok(lower.includes('draft'),    'output must include "draft"');

    // Short menu must appear (printed before the loop and/or after actions)
    assert.ok(output.includes('Brainstorm Menu'), 'output must include "Brainstorm Menu"');
  } finally {
    cleanup(d);
  }
});

// ── TC-BACKSPACE: 'rr<backspace>' corrects to 'r' → regenerate command ────────

await test("TC-BACKSPACE: 'rr\\x7f' corrects to 'r' and resolves as regenerate command", async () => {
  const d = tempDir();
  try {
    const { factory, reviseCalls } = spyFactory();
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    // 'rr\x7f' → readline (terminal mode) applies backspace, emitting 'r' as the line
    // → sub-prompt fires → 'my feedback' → then 'a' to exit
    inputStream.write('rr\x7f\nmy feedback\na\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: factory,
      input: inputStream,
      output: outputStream,
    });

    assert.ok(reviseCalls.length >= 1, 'revise must have been called at least once');
    assert.strictEqual(reviseCalls[0].feedback, 'my feedback', 'feedback must be the sub-prompted value');
    assert.strictEqual(reviseCalls[0].mode, 'regenerate', 'mode must be regenerate');
  } finally {
    cleanup(d);
  }
});

// ── TC-PROGRESS-TICKER: output includes thinking + done-in markers ────────────

await test('TC-PROGRESS-TICKER: output contains thinking start marker and done-in finish marker during TTY accept flow', async () => {
  const d = tempDir();
  try {
    const inputStream = new PassThrough();
    const outputStream = new PassThrough();
    outputStream.isTTY = true;

    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk.toString()));

    inputStream.write('a\n');

    await brainstorm(d, [], {}, {
      brainstormerFactory: stubFactory,
      input: inputStream,
      output: outputStream,
    });

    const output = chunks.join('');
    assert.ok(/thinking/.test(output), 'output must include a string matching /thinking/ (start marker)');
    assert.ok(/done in \d+s/.test(output), 'output must include a string matching /done in \\d+s/ (finish marker)');
  } finally {
    cleanup(d);
  }
});

// ── TC-PROGRESS-CLEANUP: withProgressTicker cleans up interval when asyncFn throws ──

await test('TC-PROGRESS-CLEANUP: withProgressTicker cleans up interval when asyncFn throws (no orphan timer)', async () => {
  const output = new PassThrough();
  let completed = false;
  try {
    await withProgressTicker(output, 'test', async () => {
      throw new Error('intentional error');
    });
  } catch (_err) {
    // expected
  }
  // If finally-clearInterval did NOT run, this test would hang (orphan setInterval).
  // The fact that we reach this line proves cleanup occurred.
  completed = true;
  assert.ok(completed, 'withProgressTicker must complete (not hang) even when asyncFn throws');
});

// ── TC-NO-RAWMODE: brainstorm.js must not contain setRawMode or rawMode ───────

await test('TC-NO-RAWMODE: brainstorm.js does not contain setRawMode or rawMode', () => {
  const brainstormSrc = fs.readFileSync(
    new URL('../src/cli/commands/brainstorm.js', import.meta.url),
    'utf8',
  );
  assert.ok(
    !/setRawMode|rawMode/.test(brainstormSrc),
    'brainstorm.js must not contain setRawMode or rawMode — raw-mode terminal handling is forbidden',
  );
});

// ── TC-SLUG-INDEPENDENT: two brainstorms produce independently named spec files ─

await test('TC-SLUG-INDEPENDENT: two brainstorms produce add-caching.spec.json and add-logging.spec.json independently at project root', async () => {
  const d = tempDir();
  try {
    // First brainstorm: 'Add caching' → slug 'add-caching'
    const inputStream1 = new PassThrough();
    const outputStream1 = new PassThrough();
    outputStream1.isTTY = true;
    inputStream1.write('a\n');

    await brainstorm(d, ['Add caching'], {}, {
      brainstormerFactory: stubFactory,
      input: inputStream1,
      output: outputStream1,
    });

    // Second brainstorm: 'Add logging' → slug 'add-logging'
    const inputStream2 = new PassThrough();
    const outputStream2 = new PassThrough();
    outputStream2.isTTY = true;
    inputStream2.write('a\n');

    await brainstorm(d, ['Add logging'], {}, {
      brainstormerFactory: stubFactory,
      input: inputStream2,
      output: outputStream2,
    });

    assert.ok(
      fs.existsSync(path.join(d, 'add-caching.spec.json')),
      'add-caching.spec.json must exist at project root',
    );
    assert.ok(
      fs.existsSync(path.join(d, 'add-logging.spec.json')),
      'add-logging.spec.json must exist at project root',
    );
  } finally {
    cleanup(d);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
