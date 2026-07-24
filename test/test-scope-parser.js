/**
 * test-scope-parser.js — Unit tests for scope-parser.js.
 *
 * No Claude auth, no SDK. Pure string parsing assertions.
 * Run: node test/test-scope-parser.js
 */
import assert from 'assert';
import { extractScopeItems, extractRejectedPhrases } from '../src/orchestrator/core/scope-parser.js';

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passCount++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failCount++;
  }
}

// ---------- TC1: numbered sub-sections under Scope heading ----------

test('TC1: numbered sub-sections under ## Scope — in heading yield correct label and source', () => {
  const spec = `
# My Feature

## Scope — in

### 1. Foo
### 2. Bar baz

## Other Section
`;
  const items = extractScopeItems(spec);
  assert.deepEqual(items, [
    { id: 's1', label: 'Foo', source: 'numbered-subsection' },
    { id: 's2', label: 'Bar baz', source: 'numbered-subsection' },
  ]);
});

// ---------- TC2: named-bug bullets ----------

test('TC2: named-bug bullets yield label with full bug description', () => {
  const spec = `
# My Feature

Some intro text.

- **Bug 42 — memory leak**
- **Bug 7 — off-by-one in pagination**
`;
  const items = extractScopeItems(spec);
  assert.deepEqual(items, [
    { id: 's1', label: 'Bug 42 — memory leak', source: 'named-bug' },
    { id: 's2', label: 'Bug 7 — off-by-one in pagination', source: 'named-bug' },
  ]);
});

// ---------- TC3: HTML comment markers ----------

test('TC3: HTML comment markers yield label from comment content', () => {
  const spec = `
# My Feature

<!-- scope-item: fast-path -->
Some text here.
<!-- scope-item: slow-path fallback -->
`;
  const items = extractScopeItems(spec);
  assert.deepEqual(items, [
    { id: 's1', label: 'fast-path', source: 'comment-marker' },
    { id: 's2', label: 'slow-path fallback', source: 'comment-marker' },
  ]);
});

// ---------- TC4: mixed sources in one spec ----------

test('TC4: mixed sources in one spec returns items from all three extraction paths', () => {
  const spec = `
# My Feature

<!-- scope-item: fast-path -->

## Scope — in

### 1. Auth flow

## Bugs

- **Bug 42 — memory leak**
`;
  const items = extractScopeItems(spec);
  const sources = items.map((i) => i.source);
  assert.ok(sources.includes('comment-marker'), 'should include comment-marker');
  assert.ok(sources.includes('numbered-subsection'), 'should include numbered-subsection');
  assert.ok(sources.includes('named-bug'), 'should include named-bug');

  const labels = items.map((i) => i.label);
  assert.ok(labels.includes('fast-path'), 'should include fast-path label');
  assert.ok(labels.includes('Auth flow'), 'should include Auth flow label');
  assert.ok(labels.includes('Bug 42 — memory leak'), 'should include bug label');
});

// ---------- TC5: deduplication ----------

test('TC5: duplicate labels are deduplicated preserving first-seen order', () => {
  const spec = `
<!-- scope-item: fast-path -->

## Scope — in

### 1. fast-path

## Bugs

- **Bug 42 — memory leak**
<!-- scope-item: fast-path -->
`;
  const items = extractScopeItems(spec);
  // 'fast-path' appears as comment-marker first, then as numbered-subsection, then comment-marker again.
  // Only the first occurrence should remain.
  const fastPathItems = items.filter((i) => i.label === 'fast-path');
  assert.equal(fastPathItems.length, 1, 'fast-path should appear exactly once');
  assert.equal(fastPathItems[0].source, 'comment-marker', 'first-seen source should be comment-marker');

  // The bug label should still be present
  const bugItems = items.filter((i) => i.label === 'Bug 42 — memory leak');
  assert.equal(bugItems.length, 1);

  // fast-path should come before bug (first-seen order)
  const fastPathIdx = items.findIndex((i) => i.label === 'fast-path');
  const bugIdx = items.findIndex((i) => i.label === 'Bug 42 — memory leak');
  assert.ok(fastPathIdx < bugIdx, 'fast-path should appear before the bug entry');
});

// ---------- TC6: empty/null/undefined input returns [] ----------

test('TC6: empty/null/undefined input returns []', () => {
  assert.deepEqual(extractScopeItems(''), []);
  assert.deepEqual(extractScopeItems(null), []);
  assert.deepEqual(extractScopeItems(undefined), []);
});

// ---------- TC7: no scope section returns [] ----------

test('TC7: spec with no scope section returns []', () => {
  const spec = `
# My Feature

## Implementation

Some details here.

## Testing

- A
- B
`;
  assert.deepEqual(extractScopeItems(spec), []);
});

// ---------- TC8: numbered sub-section parsing stops at next ## heading ----------

test('TC8: numbered sub-section parsing stops at next ## heading', () => {
  const spec = `
## Scope — in

### 1. Foo
### 2. Bar

## Other Section

### 3. Should not be captured
`;
  const items = extractScopeItems(spec);
  assert.deepEqual(items, [
    { id: 's1', label: 'Foo', source: 'numbered-subsection' },
    { id: 's2', label: 'Bar', source: 'numbered-subsection' },
  ]);
  const labels = items.map((i) => i.label);
  assert.ok(!labels.includes('Should not be captured'), 'items after ## heading should not be captured');
});

// ──────────────────────────────────────────────────────────────────────────
// extractRejectedPhrases now takes a string[] (spec.json.constraints[]).
// A constraint is "rejected" iff it matches the negative-marker regex,
// case-insensitive: \b(do ?not|don'?t|never|must not|cannot|avoid)\b.
// Positive constraints are excluded. Output shape is unchanged:
//   Array<{ phrase: string, tokens: Set<string> }>
// Phrase = constraint with rationale stripped at the first em-dash/period;
// tokens = lowercase, /\W+/-split, STOPWORDS removed; keep only if >=2 tokens.
// ──────────────────────────────────────────────────────────────────────────

// ---------- TC-REJ-1: empty / non-array / non-string input returns [] ----------

test('TC-REJ-1: extractRejectedPhrases returns [] for [], null, undefined, and non-string entries', () => {
  assert.deepEqual(extractRejectedPhrases([]), []);
  assert.deepEqual(extractRejectedPhrases(null), []);
  assert.deepEqual(extractRejectedPhrases(undefined), []);
  // Array containing only non-string entries → no rejected phrases.
  assert.deepEqual(extractRejectedPhrases([42, null, undefined, {}, ['x']]), []);
});

// ---------- TC-REJ-2: a negative-marker constraint is extracted + tokenized ----------

test('TC-REJ-2: a "Do not ..." constraint is extracted with the unchanged {phrase, tokens:Set} shape', () => {
  const results = extractRejectedPhrases(['Do not modify scopeSpecHardChecks']);
  assert.equal(results.length, 1, 'one negative-marker constraint should yield one entry');
  assert.ok(results[0].tokens instanceof Set, 'tokens should be a Set');
  // Distinctive content tokens must be present (lowercased).
  assert.ok(results[0].tokens.has('modify'), "tokens should contain 'modify'");
  assert.ok(results[0].tokens.has('scopespechardchecks'), "tokens should contain 'scopespechardchecks'");
});

// ---------- TC-REJ-3: a positive constraint is EXCLUDED ----------

test('TC-REJ-3: a positive constraint (no negative marker) is excluded', () => {
  // "Use pure functions" has no do-not / never / avoid marker → not rejected.
  assert.deepEqual(extractRejectedPhrases(['Use pure functions']), []);

  // Mixed: only the negative one survives.
  const mixed = extractRejectedPhrases([
    'Use pure functions',
    'Prefer composition over inheritance',
    'Never call the legacy parser directly',
  ]);
  assert.equal(mixed.length, 1, 'only the negative-marker constraint should survive');
  assert.ok(mixed[0].tokens.has('legacy'), "surviving entry should be the 'legacy parser' one");
  assert.ok(mixed[0].tokens.has('parser'), "surviving entry should be the 'legacy parser' one");
});

// ---------- TC-REJ-4: negative-marker variants all match (case-insensitive) ----------

test('TC-REJ-4: do not / don\'t / never / must not / cannot / avoid all trigger extraction', () => {
  const markers = [
    'Do not touch legacy parser',
    "Don't mutate shared state",
    'Never bypass the coverage gate',
    'Must not delete archive entries',
    'Cannot rename exported symbols',
    'Avoid global mutable singletons',
    // case-insensitivity
    'DO NOT modify frozen schema',
  ];
  const results = extractRejectedPhrases(markers);
  assert.equal(
    results.length,
    markers.length,
    `Every negative-marker constraint should be extracted. Got ${results.length} of ${markers.length}: ` +
    JSON.stringify(results.map((r) => r.phrase)),
  );
});

// ---------- TC-REJ-5: rationale after em-dash / period is stripped ----------

test('TC-REJ-5: trailing rationale after the first em-dash or period is stripped from phrase + tokens', () => {
  const emDash = extractRejectedPhrases(['Do not modify legacy parser — rationale here']);
  assert.equal(emDash.length, 1);
  assert.ok(emDash[0].tokens.has('modify') && emDash[0].tokens.has('legacy') && emDash[0].tokens.has('parser'),
    'core tokens must be present');
  assert.ok(!emDash[0].tokens.has('rationale'),
    "em-dash: post-rationale token 'rationale' must be excluded");
  assert.ok(!emDash[0].phrase.includes('rationale'),
    'em-dash: phrase must not include the rationale text');

  const period = extractRejectedPhrases(['Do not modify legacy parser. And more text after period']);
  assert.equal(period.length, 1);
  assert.ok(!period[0].tokens.has('more') && !period[0].tokens.has('period'),
    'period: post-period tokens must be excluded');
  assert.ok(!period[0].phrase.includes('period'),
    'period: phrase must not include the post-period text');
});

// ---------- TC-REJ-6: drops negative constraints with < 2 distinctive tokens ----------

test('TC-REJ-6: STOPWORDS are filtered and negative constraints with < 2 distinctive tokens are dropped', () => {
  // The negative marker itself is stripped before tokenisation, so it does NOT
  // count toward the >=2-tokens rule — only the behaviour words after the
  // marker are tokenised.
  const results = extractRejectedPhrases([
    'Cannot the of in',         // 'cannot' stripped, rest are stopwords → 0 tokens → dropped
    'Avoid the globals',        // 'avoid' stripped, 'the' is a stopword → only {globals} → <2 → dropped
    'Avoid the mutable globals', // 'avoid' stripped, 'the' stopword → {mutable, globals} → 2 tokens → kept
  ]);
  // Only the >=2-token entry survives.
  assert.equal(results.length, 1,
    `only the entry with >=2 distinctive tokens should survive, got: ${JSON.stringify(results.map((r) => r.phrase))}`);
  assert.ok(results[0].tokens.has('mutable') && results[0].tokens.has('globals'),
    "surviving entry should be the 'Avoid the mutable globals' one");
  // STOPWORD 'the' must be filtered out of tokens.
  assert.ok(!results[0].tokens.has('the'), "stopword 'the' must be filtered from tokens");
  // The negative marker 'avoid' must NOT appear in tokens (it is stripped).
  assert.ok(!results[0].tokens.has('avoid'), "negative marker 'avoid' must be stripped from tokens");
  assert.ok(results[0].tokens.size === 2, `expected exactly 2 tokens, got: ${JSON.stringify([...results[0].tokens])}`);
});

// ---------- TC-REJ-7: negative marker words are stripped from phrase + tokens ----------

test('TC-REJ-7: "do not" / "don\'t" markers are stripped — tokens contain behaviour words only, never do/not', () => {
  // Pins the fix: the rejected phrase is the text AFTER the negative marker,
  // so the marker words (do, not, don't, never, …) never leak into tokens.
  const doNot = extractRejectedPhrases(['Do not modify the legacy parser']);
  assert.equal(doNot.length, 1, 'the "Do not ..." constraint should yield exactly one entry');
  // Behaviour words must be present.
  assert.ok(doNot[0].tokens.has('modify'), "tokens must contain behaviour word 'modify'");
  assert.ok(doNot[0].tokens.has('legacy'), "tokens must contain behaviour word 'legacy'");
  assert.ok(doNot[0].tokens.has('parser'), "tokens must contain behaviour word 'parser'");
  // Marker words must be ABSENT (this is the regression that was fixed).
  assert.ok(!doNot[0].tokens.has('do'), "tokens must NOT contain stripped marker word 'do'");
  assert.ok(!doNot[0].tokens.has('not'), "tokens must NOT contain stripped marker word 'not'");
  // The phrase text itself must not carry the marker prefix.
  assert.ok(!/^do not\b/i.test(doNot[0].phrase),
    `phrase must not start with the marker, got '${doNot[0].phrase}'`);

  // Same for the contraction form "don't".
  const dont = extractRejectedPhrases(["Don't mutate shared state"]);
  assert.equal(dont.length, 1, 'the "Don\'t ..." constraint should yield exactly one entry');
  assert.ok(
    dont[0].tokens.has('mutate') && dont[0].tokens.has('shared') && dont[0].tokens.has('state'),
    `tokens must contain behaviour words mutate/shared/state, got: ${JSON.stringify([...dont[0].tokens])}`,
  );
  assert.ok(!dont[0].tokens.has('do') && !dont[0].tokens.has('don') && !dont[0].tokens.has('t'),
    `marker fragments (do / don / t) must be stripped, got: ${JSON.stringify([...dont[0].tokens])}`);
});

// ---------- TC-NBI-1: numbered bold items under ## Scope — in ----------

test('TC-NBI-1: two N. **label** items under ## Scope — in yield numbered-bold-item entries with ids s1/s2', () => {
  const spec = `
# My Feature

## Scope — in

1. **Alpha**
2. **Beta gamma**

## Other Section
`;
  const items = extractScopeItems(spec);
  assert.deepEqual(items, [
    { id: 's1', label: 'Alpha', source: 'numbered-bold-item' },
    { id: 's2', label: 'Beta gamma', source: 'numbered-bold-item' },
  ]);
});

// ---------- TC-NBI-2: plain numbered item (no bold) under Scope — in ----------

test('TC-NBI-2: plain "1. Alpha" line (no bold) under Scope — in yields no item (items is [])', () => {
  const spec = `
# My Feature

## Scope — in

1. Alpha

## Other Section
`;
  const items = extractScopeItems(spec);
  assert.deepEqual(items, []);
});

// ---------- TC-NBI-3: numbered bold item outside/before Scope — in ----------

test('TC-NBI-3: "1. **Alpha**" placed before any ## Scope — in heading yields no numbered-bold-item', () => {
  const spec = `
# My Feature

1. **Alpha**

## Other Section

Some text here.
`;
  const items = extractScopeItems(spec);
  const numberedBoldItems = items.filter((i) => i.source === 'numbered-bold-item');
  assert.deepEqual(numberedBoldItems, []);
});

// ---------- TC-NBI-4: regression — existing patterns unchanged by new dialect ----------

test('TC-NBI-4: regression — numbered-subsection, named-bug, and comment-marker labels/ids/sources unchanged by numbered-bold-item dialect', () => {
  const spec = `
<!-- scope-item: fast-path -->

## Scope — in

### 1. Auth flow

## Bugs

- **Bug 42 — memory leak**
`;
  const items = extractScopeItems(spec);

  // comment-marker
  const commentItem = items.find((i) => i.source === 'comment-marker');
  assert.ok(commentItem, 'comment-marker item must be present');
  assert.equal(commentItem.label, 'fast-path', 'comment-marker label must be fast-path');

  // numbered-subsection
  const subsectionItem = items.find((i) => i.source === 'numbered-subsection');
  assert.ok(subsectionItem, 'numbered-subsection item must be present');
  assert.equal(subsectionItem.label, 'Auth flow', 'numbered-subsection label must be Auth flow');

  // named-bug
  const bugItem = items.find((i) => i.source === 'named-bug');
  assert.ok(bugItem, 'named-bug item must be present');
  assert.equal(bugItem.label, 'Bug 42 — memory leak', 'named-bug label must match');

  // ids must be s1, s2, s3 in first-seen order
  assert.equal(items[0].id, 's1');
  assert.equal(items[1].id, 's2');
  assert.equal(items[2].id, 's3');

  // no numbered-bold-item present (no "N. **bold**" list items in spec)
  const boldItems = items.filter((i) => i.source === 'numbered-bold-item');
  assert.deepEqual(boldItems, [], 'no numbered-bold-item should be present in regression spec');
});

// ---------- Summary ----------

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
