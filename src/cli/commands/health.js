/**
 * health.js — Report runtime health as a JSON object.
 *
 * Pure JS, no shell dispatch. Reads package.json for version and prints
 * a JSON health report with process metadata. Produces 'degraded' status
 * if package.json is missing or unreadable.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Print a JSON health report to stdout.
 */
export function health() {
  const pkgPath = path.resolve(__dirname, '../../../package.json');

  let version = null;
  let status = 'ok';

  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    version = pkg.version ?? null;
  } catch (err) {
    status = 'degraded';
  }

  const report = {
    status,
    version,
    pid: process.pid,
    nodeVersion: process.version,
    uptimeMs: Math.round(process.uptime() * 1000),
  };

  console.log(JSON.stringify(report));
}
