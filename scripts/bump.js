#!/usr/bin/env node
/**
 * bump.js — Semver version bumper.
 *
 * Reads version from package.json, increments the specified component,
 * writes back with 2-space indent + trailing newline, and defensively
 * replaces any hardcoded version strings in src/cli/index.js.
 *
 * Usage:
 *   node scripts/bump.js [major|minor|patch]   (default: patch)
 *   ./scripts/bump.js patch
 *
 * No external deps. Pure fs + path.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --project <path> overrides the target directory (for driver/target split).
// Falls back to the script's own parent directory.
const projectFlagIdx = process.argv.indexOf('--project');
const ROOT = projectFlagIdx !== -1 && process.argv[projectFlagIdx + 1]
  ? path.resolve(process.argv[projectFlagIdx + 1])
  : path.resolve(__dirname, '..');

// --- Arg parsing (strip --project from args) ---
const rawArgs = process.argv.slice(2).filter((a, i, arr) => a !== '--project' && arr[i - 1] !== '--project');
const arg = rawArgs[0] ?? 'patch';
const VALID = ['major', 'minor', 'patch'];

if (!VALID.includes(arg)) {
  process.stderr.write(
    `Usage: bump.js [major|minor|patch]\n` +
    `  major  — increment major, reset minor + patch to 0\n` +
    `  minor  — increment minor, reset patch to 0\n` +
    `  patch  — increment patch (default)\n`
  );
  process.exit(1);
}

// --- Read package.json ---
const pkgPath = path.join(ROOT, 'package.json');
const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(pkgRaw);

const oldVersion = pkg.version;
const semverRe = /^(\d+)\.(\d+)\.(\d+)$/;
const match = semverRe.exec(oldVersion);
if (!match) {
  process.stderr.write(`Error: package.json version "${oldVersion}" is not valid semver (major.minor.patch)\n`);
  process.exit(1);
}

let [, major, minor, patch] = match.map(Number);

if (arg === 'major') {
  major += 1;
  minor = 0;
  patch = 0;
} else if (arg === 'minor') {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}

const newVersion = `${major}.${minor}.${patch}`;

// --- Write package.json ---
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

// --- Defensively scan src/cli/index.js ---
const cliPath = path.join(ROOT, 'src', 'cli', 'index.js');
if (fs.existsSync(cliPath)) {
  let cliSrc = fs.readFileSync(cliPath, 'utf8');
  // Replace hardcoded occurrences of the old version string (outside of nothing — simple regex replace)
  // Escape dots in oldVersion for use in regex
  const escapedOld = oldVersion.replace(/\./g, '\\.');
  const versionRe = new RegExp(escapedOld, 'g');
  const updated = cliSrc.replace(versionRe, newVersion);
  if (updated !== cliSrc) {
    fs.writeFileSync(cliPath, updated, 'utf8');
  }
}

// --- Report ---
process.stdout.write(`Bumped: ${oldVersion} → ${newVersion}\n`);
