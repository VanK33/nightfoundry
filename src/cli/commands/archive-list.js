import fs from 'fs';
import path from 'path';

export function archiveList(projectRoot, options = {}) {
  const { json = false } = options;
  const archivesDir = path.join(projectRoot, 'archives');

  if (!fs.existsSync(archivesDir)) {
    console.log('No archives found.');
    return;
  }

  let entries;
  try {
    entries = fs.readdirSync(archivesDir);
  } catch {
    console.log('No archives found.');
    return;
  }

  const manifests = [];
  for (const entry of entries) {
    const manifestPath = path.join(archivesDir, entry, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      manifests.push(manifest);
    } catch {
      console.warn(`Warning: skipping corrupt manifest at ${manifestPath}`);
    }
  }

  if (manifests.length === 0) {
    console.log('No archives found.');
    return;
  }

  // Sort reverse-chronologically by archivedAt
  manifests.sort((a, b) => {
    const da = a.archivedAt ? new Date(a.archivedAt).getTime() : 0;
    const db = b.archivedAt ? new Date(b.archivedAt).getTime() : 0;
    return db - da;
  });

  if (json) {
    console.log(JSON.stringify(manifests, null, 2));
    return;
  }

  // Print formatted table — truncate long IDs
  const ID_WIDTH = 22;
  const truncId = (id) => {
    if (!id) return '';
    return id.length > ID_WIDTH ? id.slice(0, ID_WIDTH - 1) + '…' : id;
  };

  const header =
    'ID'.padEnd(ID_WIDTH) +
    'Date'.padEnd(22) +
    'Cost'.padStart(10) +
    'Sess'.padStart(6) +
    '  ' +
    'Headline';
  console.log(header);
  console.log('-'.repeat(ID_WIDTH + 22 + 10 + 6 + 2 + 30));

  for (const m of manifests) {
    const id = truncId(m.id ?? '').padEnd(ID_WIDTH);
    const date = (m.archivedAt ? m.archivedAt.slice(0, 19).replace('T', ' ') : '').padEnd(22);
    const cost = `$${(m.totalCost ?? 0).toFixed(2)}`.padStart(10);
    const sessions = String(m.totalSessions ?? 0).padStart(6);
    const headline = (m.headline ?? '').slice(0, 50);
    console.log(`${id}${date}${cost}${sessions}  ${headline}`);
  }
}
