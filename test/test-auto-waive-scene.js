#!/usr/bin/env node
/**
 * test-auto-waive-scene.js — Standalone unit tests for writeAutoWaiveScene
 * imported directly from ../src/orchestrator/core/state.js (no pipeline).
 *
 * TC1: first writeAutoWaiveScene returns a path whose basename is auto-waive.json
 *      and the file exists.
 * TC2: second call on the same slug returns basename auto-waive-001.json;
 *      third returns auto-waive-002.json (append-by-rename rotation).
 * TC3: read all three files back and assert each retains its own distinct
 *      payload (e.g. a per-call marker field n=1/2/3) — no overwrite.
 * TC4: calling on a slug whose queue dir does not pre-exist creates it
 *      (mkdir -p) and still writes auto-waive.json.
 * TC5: a full scene {site:'assumption-gate', autoWaivedAt, round1:[...],
 *      round2:null, appliedSpecEdits:[...], categorization:[{assumptionText,
 *      category,label}]} round-trips byte-equivalently via JSON parse.
 *
 * Run: node test/test-auto-waive-scene.js
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeAutoWaiveScene, writeQueueEntry } from '../src/orchestrator/core/state.js';

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
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failCount++;
  }
}

function readJsonRaw(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-orch-auto-waive-scene-'));

try {
  // ── TC1: first write → basename auto-waive.json, file exists ─────────────

  test('TC1: first writeAutoWaiveScene returns auto-waive.json and file exists', () => {
    // Pre-create the queue dir (mirrors the typical production shape where
    // writeQueueEntry creates it first).
    const slug = 'tc1-slug';
    const queueDir = path.join(root, 'queue', slug);
    fs.mkdirSync(queueDir, { recursive: true });

    const p1 = writeAutoWaiveScene(root, slug, { site: 'assumption-gate', n: 1 });

    assert.strictEqual(
      path.basename(p1),
      'auto-waive.json',
      `expected basename 'auto-waive.json', got '${path.basename(p1)}'`,
    );
    assert.ok(fs.existsSync(p1), `file must exist at ${p1}`);
  });

  // ── TC2: rotation — second → -001, third → -002 ──────────────────────────

  test('TC2: second call rotates to auto-waive-001.json; third to auto-waive-002.json', () => {
    const slug = 'tc2-slug';
    const queueDir = path.join(root, 'queue', slug);
    fs.mkdirSync(queueDir, { recursive: true });

    const baseScene = {
      site: 'assumption-gate',
      autoWaivedAt: '2026-06-14T00:00:00.000Z',
      round1: [],
      round2: null,
      appliedSpecEdits: [],
      categorization: [],
    };

    const p1 = writeAutoWaiveScene(root, slug, { ...baseScene, n: 1 });
    assert.strictEqual(path.basename(p1), 'auto-waive.json',
      `first write must land at auto-waive.json (got '${path.basename(p1)}')`);

    const p2 = writeAutoWaiveScene(root, slug, { ...baseScene, n: 2 });
    assert.strictEqual(path.basename(p2), 'auto-waive-001.json',
      `second write must rotate to auto-waive-001.json (got '${path.basename(p2)}')`);

    const p3 = writeAutoWaiveScene(root, slug, { ...baseScene, n: 3 });
    assert.strictEqual(path.basename(p3), 'auto-waive-002.json',
      `third write must rotate to auto-waive-002.json (got '${path.basename(p3)}')`);
  });

  // ── TC3: no overwrite — all three persist with distinct payloads ──────────

  test('TC3: all three rotated files retain their own distinct payload (n=1/2/3, no overwrite)', () => {
    const slug = 'tc3-slug';
    const queueDir = path.join(root, 'queue', slug);
    fs.mkdirSync(queueDir, { recursive: true });

    const baseScene = {
      site: 'assumption-gate',
      autoWaivedAt: '2026-06-14T00:00:00.000Z',
      round1: [],
      round2: null,
      appliedSpecEdits: [],
      categorization: [],
    };

    const p1 = writeAutoWaiveScene(root, slug, { ...baseScene, n: 1 });
    const p2 = writeAutoWaiveScene(root, slug, { ...baseScene, n: 2 });
    const p3 = writeAutoWaiveScene(root, slug, { ...baseScene, n: 3 });

    assert.strictEqual(readJsonRaw(p1).n, 1,
      'auto-waive.json must retain the first payload (n=1), not be overwritten');
    assert.strictEqual(readJsonRaw(p2).n, 2,
      'auto-waive-001.json must retain the second payload (n=2)');
    assert.strictEqual(readJsonRaw(p3).n, 3,
      'auto-waive-002.json must retain the third payload (n=3)');
  });

  // ── TC4: missing queue dir is created (mkdir -p) ─────────────────────────

  test('TC4: calling on a slug whose queue dir does not pre-exist creates it and writes auto-waive.json', () => {
    const slug = 'tc4-no-pre-existing-dir';
    const queueDir = path.join(root, 'queue', slug);

    // Confirm the directory does NOT exist yet.
    assert.ok(!fs.existsSync(queueDir),
      `queue dir must not exist before the call (${queueDir})`);

    const p = writeAutoWaiveScene(root, slug, { site: 'assumption-gate', n: 42 });

    assert.ok(fs.existsSync(queueDir),
      `writeAutoWaiveScene must create the queue dir (${queueDir})`);
    assert.strictEqual(path.basename(p), 'auto-waive.json',
      `when no prior file exists, basename must be 'auto-waive.json' (got '${path.basename(p)}')`);
    assert.ok(fs.existsSync(p), `auto-waive.json must exist at ${p}`);
  });

  // ── TC5: full scene round-trips byte-equivalently via JSON.parse ──────────

  test('TC5: full scene round-trips byte-equivalently via JSON.parse', () => {
    const slug = 'tc5-roundtrip';
    const queueDir = path.join(root, 'queue', slug);
    fs.mkdirSync(queueDir, { recursive: true });

    const fullScene = {
      site: 'assumption-gate',
      autoWaivedAt: '2026-06-14T12:34:56.789Z',
      round1: [
        { assumption: { text: 'A1', phase: 'pre', specSection: 'Goals' }, status: 'uncertain', evidence: 'Cannot execute.' },
        { assumption: { text: 'A2', phase: 'pre', specSection: 'Goals' }, status: 'verified', evidence: 'Confirmed.' },
      ],
      round2: null,
      appliedSpecEdits: [
        { old: 'old-clause', new: 'new-clause', section: 'Goals' },
      ],
      categorization: [
        { assumptionText: 'A1', category: 'inspector-cannot-execute', label: 'Inspector cannot execute' },
      ],
    };

    const p = writeAutoWaiveScene(root, slug, fullScene);
    const parsed = readJsonRaw(p);

    assert.strictEqual(parsed.site, fullScene.site,
      `site must round-trip (got '${parsed.site}')`);
    assert.strictEqual(parsed.autoWaivedAt, fullScene.autoWaivedAt,
      `autoWaivedAt must round-trip (got '${parsed.autoWaivedAt}')`);
    assert.ok(Array.isArray(parsed.round1) && parsed.round1.length === 2,
      `round1 must round-trip with 2 entries (got ${JSON.stringify(parsed.round1)})`);
    assert.strictEqual(parsed.round1[0].assumption.text, 'A1',
      'round1[0].assumption.text must round-trip');
    assert.strictEqual(parsed.round1[0].status, 'uncertain',
      'round1[0].status must round-trip');
    assert.strictEqual(parsed.round2, null,
      `round2 must round-trip as null (got '${parsed.round2}')`);
    assert.ok(Array.isArray(parsed.appliedSpecEdits) && parsed.appliedSpecEdits.length === 1,
      'appliedSpecEdits must round-trip with 1 entry');
    assert.strictEqual(parsed.appliedSpecEdits[0].old, 'old-clause',
      'appliedSpecEdits[0].old must round-trip');
    assert.ok(Array.isArray(parsed.categorization) && parsed.categorization.length === 1,
      'categorization must round-trip with 1 entry');
    assert.strictEqual(parsed.categorization[0].assumptionText, 'A1',
      'categorization[0].assumptionText must round-trip');
    assert.strictEqual(parsed.categorization[0].category, 'inspector-cannot-execute',
      'categorization[0].category must round-trip');
    assert.strictEqual(parsed.categorization[0].label, 'Inspector cannot execute',
      'categorization[0].label must round-trip');

    // Byte-equivalent check: re-serialise and compare.
    const raw = fs.readFileSync(p, 'utf8');
    const reparsed = JSON.parse(raw);
    assert.deepStrictEqual(reparsed, fullScene,
      'the full scene must be byte-equivalently recoverable via JSON.parse(readFileSync(...))');
  });

} finally {
  // Cleanup tmp root.
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passCount + failCount} tests: ${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
