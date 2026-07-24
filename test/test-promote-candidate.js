/**
 * test-promote-candidate.js — Unit tests for promoteCandidate() in staging.js.
 *
 * Run: node test/test-promote-candidate.js
 *
 * Covers:
 *   TC1 — New file creation: file has H1 header and candidate body
 *   TC2 — Append to existing: no duplicate H1 header, body appended
 *   TC3 — Pending file removed after promotion
 *   TC4 — Double-promotion: no duplicate content
 *   TC5 — Multiple candidates promoted to same file: proper blank-line spacing
 *   TC6 — Error on missing/malformed pending file: throws or returns error indicator
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { stageCandidate, promoteCandidate } from '../src/orchestrator/core/staging.js';

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

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'promote-candidate-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Stage a candidate with sensible defaults and return { id, path }. */
function stageDefault(projectRoot, overrides = {}) {
  return stageCandidate({
    projectRoot,
    kind: overrides.kind ?? 'contract',
    content: {
      ruleName: overrides.ruleName ?? 'TestRule',
      rule:     overrides.rule     ?? 'Always do X',
      why:      overrides.why      ?? 'Because Y',
      whereItBites: overrides.whereItBites ?? 'In Z',
      area:     overrides.area     ?? 'core',
    },
    evidence: {
      rule: overrides.rule ?? 'Always do X',
      why:  overrides.why  ?? 'Because Y',
      data: overrides.data ?? '',
    },
    source: {
      taskId:    overrides.taskId    ?? 'task-001',
      sessionId: overrides.sessionId ?? 'ses-001',
    },
  });
}

// ---------------------------------------------------------------------------
// TC1 — New file creation: file has H1 header and candidate body
// ---------------------------------------------------------------------------
test('TC1: new file creation — H1 header present and candidate body included', () => {
  const projectRoot = makeTmpDir();
  try {
    const staged = stageDefault(projectRoot, { ruleName: 'NewFileRule', area: 'alpha' });

    const { targetPath } = promoteCandidate({
      projectRoot,
      kind: 'contract',
      id: staged.id,
    });

    assert.ok(fs.existsSync(targetPath), `Target file should exist at ${targetPath}`);

    const content = fs.readFileSync(targetPath, 'utf8');

    // H1 header must be present
    assert.ok(
      /^# Contracts — alpha$/m.test(content),
      'Target file should start with H1 header "# Contracts — alpha"'
    );

    // Body should include the rule name section
    assert.ok(
      content.includes('## NewFileRule'),
      'Target file should contain ## NewFileRule'
    );

    // Body should include rule content
    assert.ok(content.includes('Rule: Always do X'), 'Body should include Rule: line');
    assert.ok(content.includes('Why: Because Y'),    'Body should include Why: line');
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC2 — Append to existing: no duplicate H1 header, body appended
// ---------------------------------------------------------------------------
test('TC2: append to existing — no duplicate H1 header, body appended', () => {
  const projectRoot = makeTmpDir();
  try {
    // First promotion creates the file
    const staged1 = stageDefault(projectRoot, { ruleName: 'FirstRule', area: 'beta' });
    promoteCandidate({ projectRoot, kind: 'contract', id: staged1.id });

    // Second promotion should append, not create a new header
    const staged2 = stageDefault(projectRoot, { ruleName: 'SecondRule', area: 'beta' });
    const { targetPath } = promoteCandidate({ projectRoot, kind: 'contract', id: staged2.id });

    const content = fs.readFileSync(targetPath, 'utf8');

    // H1 header should appear exactly once
    const headerMatches = (content.match(/^# Contracts — beta$/gm) || []).length;
    assert.strictEqual(headerMatches, 1, `H1 header should appear exactly once, got ${headerMatches}`);

    // Both rule bodies should be present
    assert.ok(content.includes('## FirstRule'),  'Content should include ## FirstRule');
    assert.ok(content.includes('## SecondRule'), 'Content should include ## SecondRule');
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC3 — Pending file removed after promotion
// ---------------------------------------------------------------------------
test('TC3: pending file removed after promotion', () => {
  const projectRoot = makeTmpDir();
  try {
    const staged = stageDefault(projectRoot, { ruleName: 'RemoveRule', area: 'gamma' });

    assert.ok(fs.existsSync(staged.path), 'Pending file should exist before promotion');

    promoteCandidate({ projectRoot, kind: 'contract', id: staged.id });

    assert.ok(
      !fs.existsSync(staged.path),
      'Pending file should be removed after promotion'
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC4 — Double-promotion: no duplicate content
// ---------------------------------------------------------------------------
test('TC4: double-promotion — no duplicate content in target file', () => {
  const projectRoot = makeTmpDir();
  try {
    const staged = stageDefault(projectRoot, { ruleName: 'IdempotentRule', area: 'delta' });

    // First promotion
    const { targetPath } = promoteCandidate({ projectRoot, kind: 'contract', id: staged.id });

    const contentAfterFirst = fs.readFileSync(targetPath, 'utf8');
    const firstOccurrences = (contentAfterFirst.match(/## IdempotentRule/g) || []).length;
    assert.strictEqual(firstOccurrences, 1, 'Rule heading should appear once after first promotion');

    // Second promotion (pending file is gone — idempotency guard)
    promoteCandidate({ projectRoot, kind: 'contract', id: staged.id });

    const contentAfterSecond = fs.readFileSync(targetPath, 'utf8');
    const secondOccurrences = (contentAfterSecond.match(/## IdempotentRule/g) || []).length;
    assert.strictEqual(
      secondOccurrences,
      1,
      `Rule heading should still appear exactly once after double-promotion, got ${secondOccurrences}`
    );

    // Marker should also appear exactly once
    const markerCount = (contentAfterSecond.match(new RegExp(`<!-- candidate:${staged.id} -->`, 'g')) || []).length;
    assert.strictEqual(markerCount, 1, `Idempotency marker should appear exactly once, got ${markerCount}`);
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC5 — Multiple candidates promoted to same file: proper blank-line spacing
// ---------------------------------------------------------------------------
test('TC5: multiple candidates promoted to same file — proper blank-line spacing', () => {
  const projectRoot = makeTmpDir();
  try {
    const staged1 = stageDefault(projectRoot, { ruleName: 'SpaceRule1', area: 'epsilon' });
    const staged2 = stageDefault(projectRoot, { ruleName: 'SpaceRule2', area: 'epsilon' });
    const staged3 = stageDefault(projectRoot, { ruleName: 'SpaceRule3', area: 'epsilon' });

    promoteCandidate({ projectRoot, kind: 'contract', id: staged1.id });
    promoteCandidate({ projectRoot, kind: 'contract', id: staged2.id });
    const { targetPath } = promoteCandidate({ projectRoot, kind: 'contract', id: staged3.id });

    const content = fs.readFileSync(targetPath, 'utf8');

    // All three sections should be present
    assert.ok(content.includes('## SpaceRule1'), 'Content should include ## SpaceRule1');
    assert.ok(content.includes('## SpaceRule2'), 'Content should include ## SpaceRule2');
    assert.ok(content.includes('## SpaceRule3'), 'Content should include ## SpaceRule3');

    // Between the marker for candidate N and the body of candidate N+1 there must
    // be at least one blank line (the separator added by promoteCandidate).
    // We verify this by checking that no two section headings are on consecutive lines.
    const lines = content.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].startsWith('## SpaceRule')) {
        // The next non-empty meaningful content after a heading should not be
        // immediately another heading without a blank line between sections.
        // More precisely: between the end of one candidate block and the marker
        // of the next there must be a blank line.
      }
    }

    // Concrete check: no two marker lines or heading lines are adjacent (no blank line between)
    // i.e. the file must not contain "## SpaceRule\n## SpaceRule" pattern.
    assert.ok(
      !/## SpaceRule\d\n## SpaceRule\d/.test(content),
      'Two candidate headings must not be on consecutive lines without a blank line'
    );

    // More robust: verify at least two blank lines exist (one after header, one between candidates)
    const blankLineCount = lines.filter(l => l.trim() === '').length;
    assert.ok(
      blankLineCount >= 2,
      `Expected at least 2 blank lines between sections, got ${blankLineCount}`
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// TC6 — Error on missing/malformed pending file: throws or returns error indicator
// ---------------------------------------------------------------------------
test('TC6: missing pending file — returns error indicator (targetPath: null)', () => {
  const projectRoot = makeTmpDir();
  try {
    // Use an ID that was never staged
    const fakeId = 'nonexistent-candidate-id-999';
    const result = promoteCandidate({
      projectRoot,
      kind: 'contract',
      id: fakeId,
    });

    // Implementation returns { targetPath: null, candidateId } for missing files
    assert.ok(
      result !== null && typeof result === 'object',
      'Should return an object when pending file is missing'
    );
    assert.strictEqual(
      result.targetPath,
      null,
      'targetPath should be null when pending file is missing'
    );
    assert.strictEqual(
      result.candidateId,
      fakeId,
      'candidateId should match the requested ID'
    );
  } finally {
    cleanup(projectRoot);
  }
});

test('TC6b: malformed pending file — throws an error', () => {
  const projectRoot = makeTmpDir();
  try {
    // Manually create a malformed .pending file (no valid frontmatter)
    const pendingDir = path.join(projectRoot, 'docs', 'contracts', '.pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    const malformedId = 'malformed-candidate-id-001';
    const malformedPath = path.join(pendingDir, `${malformedId}.md`);
    fs.writeFileSync(malformedPath, 'this is not valid frontmatter\nno yaml delimiters\n', 'utf8');

    let threw = false;
    try {
      promoteCandidate({
        projectRoot,
        kind: 'contract',
        id: malformedId,
        path: malformedPath,
      });
    } catch (err) {
      threw = true;
      assert.ok(
        err.message.includes('promoteCandidate') || err.message.includes('frontmatter') || err.message.includes('parse'),
        `Error message should mention the failure context, got: "${err.message}"`
      );
    }

    assert.ok(threw, 'promoteCandidate should throw when the pending file is malformed');
  } finally {
    cleanup(projectRoot);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
