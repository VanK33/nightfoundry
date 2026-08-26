/**
 * snapshots.js — Deterministic file backup/restore for task rollback.
 *
 * Before-snapshot: captured before executor starts (baseline).
 * After-snapshot: captured after verification passes (verified-good state).
 * Last-failed-snapshot: captured when a task fails, preserving the last attempted state.
 * Pure fs.copyFileSync — no AI, no git.
 *
 * Public API:
 *   snapshotFiles(harnessDir, projectRoot, taskId, phase, files) — fresh capture:
 *     wipes (rm -rf) and recreates the phase dir before copying, so the result
 *     contains exactly the listed files that currently exist on disk (stale
 *     entries from a prior capture are gone); if `files` is empty or none
 *     exist, the phase dir is left present but empty rather than absent.
 *   restoreSnapshot(harnessDir, projectRoot, taskId, phase, overrides?) → number of files restored
 *   cleanupSnapshots(harnessDir, milestoneId) → number of snapshots removed
 *   readAffectedFiles(harnessDir, taskId) → string[]
 *   assertChangesLanded(harnessDir, projectRoot, taskId, files) → { ok, allUnchanged, unchanged, bothMissing }
 */
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';

export function snapshotFiles(harnessDir, projectRoot, taskId, phase, files) {
  const phaseDir = path.join(harnessDir, 'snapshots', taskId, phase);
  fs.rmSync(phaseDir, { recursive: true, force: true });
  fs.mkdirSync(phaseDir, { recursive: true });

  for (const file of files) {
    const src = path.join(projectRoot, file);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(phaseDir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

export function restoreSnapshot(harnessDir, projectRoot, taskId, phase, overrides) {
  const snapshotDir = path.join(harnessDir, 'snapshots', taskId, phase);
  if (!fs.existsSync(snapshotDir)) return 0;

  const files = walkDir(snapshotDir);
  for (const relPath of files) {
    const src = overrides && overrides[relPath] ? overrides[relPath] : path.join(snapshotDir, relPath);
    const dest = path.join(projectRoot, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return files.length;
}

export function cleanupSnapshots(harnessDir, milestoneId) {
  const snapshotsDir = path.join(harnessDir, 'snapshots');
  if (!fs.existsSync(snapshotsDir)) return 0;

  let cleaned = 0;
  for (const entry of fs.readdirSync(snapshotsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(milestoneId + '-')) {
      fs.rmSync(path.join(snapshotsDir, entry.name), { recursive: true, force: true });
      cleaned++;
    }
  }
  return cleaned;
}

export function readAffectedFiles(harnessDir, taskId) {
  // Source of truth: structured JSON sidecar from the executor.
  const jsonPath = path.join(harnessDir, 'progress', `task-${taskId}.json`);
  if (!fs.existsSync(jsonPath)) return [];

  try {
    const progress = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (Array.isArray(progress.affectedFiles)) {
      return progress.affectedFiles
        .map((f) => (typeof f === 'string' ? f : f?.path))
        .filter(Boolean);
    }
  } catch {
    // Malformed sidecar — return empty rather than throwing. The
    // upstream audit will flag the corrupted progress file.
  }
  return [];
}

// Self-attestation guard: the executor reports {status, affectedFiles}
// from its structured JSON output, not from observing actual disk writes.
// A silent failure path exists where _guardToolUse denies an Edit, the
// model recovers, and emits status:'COMPLETED' with a plausible
// affectedFiles list — but no bytes changed. This helper compares each
// declared file's SHA-256 against the before/ snapshot. Empty file list
// is vacuously ok (caller skips the check). Both-missing counts as
// unchanged (the executor's claim of writing the file is unsubstantiated).
export function assertChangesLanded(harnessDir, projectRoot, taskId, files) {
  if (!files || files.length === 0) return { ok: true, unchanged: [], bothMissing: [], allUnchanged: false };
  const snapshotDir = path.join(harnessDir, 'snapshots', taskId, 'before');
  const unchanged = [];
  const bothMissing = [];
  for (const file of files) {
    const beforeHash = _fileHash(path.join(snapshotDir, file));
    const currentHash = _fileHash(path.join(projectRoot, file));
    if (beforeHash === currentHash) unchanged.push(file);
    // both-missing: absent from the before-snapshot AND absent from disk
    // (_fileHash returns null for a non-existent path) → never produced.
    if (beforeHash === null && currentHash === null) bothMissing.push(file);
  }
  // allUnchanged: ZERO byte delta across every checked file — the actual
  // lying-executor signature (Defect #17). Distinct from !ok (ANY file
  // unchanged): a task with a real delta on its main file and an untouched
  // declared sibling (e.g. a co-declared test manifest) is a partial
  // deliverable for `ok` purposes but NOT a phantom write. The phantom-write
  // probe keys on this field, not on ok.
  return { ok: unchanged.length === 0, unchanged, bothMissing, allUnchanged: unchanged.length === files.length };
}

function _fileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function walkDir(dir, prefix = '') {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      results.push(...walkDir(path.join(dir, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}
