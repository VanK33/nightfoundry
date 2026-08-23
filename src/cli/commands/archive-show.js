import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

/**
 * Display detailed information about a specific archive.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {string} archiveId   - Exact archive directory name (= archive ID)
 * @param {object} [options={}]
 * @param {boolean} [options.json] - When true, output raw manifest JSON
 * @param {boolean} [options.report] - When true, open report.html in the browser
 */
export function archiveShow(projectRoot, archiveId, options = {}) {
  const { json = false, report = false } = options;
  const archivesDir = path.join(projectRoot, 'archives');

  // Handle missing archives dir gracefully
  if (!fs.existsSync(archivesDir)) {
    console.error(`Archive not found: ${archiveId}`);
    console.error('No archives directory found.');
    return;
  }

  const archiveDir = path.join(archivesDir, archiveId);

  if (!fs.existsSync(archiveDir)) {
    console.error(`Archive not found: ${archiveId}`);

    // List available archive IDs
    let entries = [];
    try {
      entries = fs.readdirSync(archivesDir).filter((e) => {
        return fs.statSync(path.join(archivesDir, e)).isDirectory();
      });
    } catch {
      // ignore read errors
    }

    if (entries.length > 0) {
      console.error('Available archives:');
      for (const entry of entries) {
        console.error(`  ${entry}`);
      }
    } else {
      console.error('No archives available.');
    }
    return;
  }

  // --report: open report.html in the default browser
  if (report) {
    const reportPath = path.join(archiveDir, 'report.html');
    if (!fs.existsSync(reportPath)) {
      console.error(`Report not found: ${reportPath}`);
      return;
    }
    const opener = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    const child = spawn(opener, [reportPath], { detached: true, stdio: 'ignore' });
    // A missing opener binary (common on headless Linux and WSL, where
    // xdg-utils is often absent) makes spawn emit 'error' asynchronously. With
    // no listener that becomes an uncaught 'error' event and kills the process
    // mid-command, so the path is printed instead — the report is already on
    // disk and the user can open it themselves.
    child.on('error', (err) => {
      console.error(`Could not launch ${opener} (${err.code}). Open the report manually: ${reportPath}`);
    });
    child.unref();
    return;
  }

  // Read manifest.json
  const manifestPath = path.join(archiveDir, 'manifest.json');
  let manifest;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read manifest for archive ${archiveId}: ${err.message}`);
    return;
  }

  // --json: output raw manifest JSON
  if (json) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  // Detailed text view
  const lines = [];

  lines.push(`Archive: ${manifest.id}`);
  lines.push(`Archived:   ${manifest.archivedAt}`);
  lines.push(`Git HEAD:   ${manifest.gitHead ?? 'unknown'}`);
  lines.push(`Git status: ${manifest.gitStatus ?? 'unknown'}`);
  lines.push(`Spec:       ${manifest.spec ?? '(none)'}`);

  const costFormatted = `$${(manifest.totalCost ?? 0).toFixed(2)}`;
  lines.push(`Cost:       ${costFormatted}`);
  lines.push(`Sessions:   ${manifest.totalSessions ?? 0}`);

  lines.push('');
  lines.push('Milestones:');
  const milestones = manifest.milestones ?? [];
  if (milestones.length === 0) {
    lines.push('  (none)');
  } else {
    for (const m of milestones) {
      lines.push(`  ${m.id}: ${m.description} (${m.status})`);
    }
  }

  lines.push('');
  lines.push('Summary:');
  lines.push(manifest.summary ?? '');

  lines.push('');
  const bugs = manifest.bugs ?? [];
  if (bugs.length === 0) {
    lines.push('Bugs: none');
  } else {
    lines.push('Bugs:');
    for (const bug of bugs) {
      lines.push(`  - ${bug}`);
    }
  }

  console.log(lines.join('\n'));
}
