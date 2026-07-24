#!/usr/bin/env node
/**
 * export-ccusage.js — Export cc-orch token usage to ccusage-compatible JSONL.
 *
 * Reads .harness/logs/token-usage.json (or an archive's token-usage.json)
 * and writes a JSONL file to ~/.claude/projects/ so that ccusage
 * (github.com/ryoppippi/ccusage) picks up cc-orch sessions alongside
 * interactive Claude Code usage.
 *
 * Usage:
 *   node scripts/export-ccusage.js                     # export current .harness/ (uses cwd)
 *   node scripts/export-ccusage.js --project /path     # export from a specific project
 *   node scripts/export-ccusage.js --archive 007-...   # export a specific archive
 *   node scripts/export-ccusage.js --all               # export all archives
 *
 * Output: ~/.claude/projects/{project-dir-slug}/cc-orch-{source}.jsonl
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import config from '../src/orchestrator/infra/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CC_ORCH_ROOT = path.resolve(__dirname, '..');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(CC_ORCH_ROOT, 'package.json'), 'utf8')).version;

// Project root: --project flag > cwd. NOT cc-orch's own directory.
const projectFlagIdx = process.argv.indexOf('--project');
const PROJECT_ROOT = projectFlagIdx !== -1 && process.argv[projectFlagIdx + 1]
  ? path.resolve(process.argv[projectFlagIdx + 1])
  : process.cwd();

// ── Model ID mapping ────────────────────────────────────────────────
// config.execution.*Model are already full API model IDs. ccusage matches
// pricing by model name; it prefers the dated form for haiku, while
// opus/sonnet use the bare alias form unchanged. Only the overrides below
// rewrite a config ID into ccusage's preferred form.
const CCUSAGE_MODEL_OVERRIDES = {
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

// Role → full model ID, derived from config.execution so exports stay in sync.
const ROLE_MODEL = {
  planner: config.execution.plannerModel,
  executor: config.execution.executorModel,
  verifier: config.execution.verifierModel,
  analyzer: config.execution.analyzerModel,
  summarizer: config.execution.summarizerModel,
};

function roleToModelId(role) {
  const modelId = ROLE_MODEL[role] || config.execution.executorModel;
  return CCUSAGE_MODEL_OVERRIDES[modelId] || modelId;
}

// ── Project slug for ccusage output path ────────────────────────────
// ccusage reads from ~/.claude/projects/{slug}/*.jsonl
// Claude Code uses the absolute path with slashes replaced by dashes.
function projectSlug(projectRoot) {
  return projectRoot.replace(/\//g, '-');
}

// ── Convert one cc-orch session entry to ccusage JSONL line ─────────
function sessionToJsonl(session, sourceId) {
  const model = roleToModelId(session.type);
  const ts = session.timestamp || new Date().toISOString();
  const uid = `cc-orch-${sourceId}-${session.name}-${ts}`;
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    uuid: uid,
    timestamp: ts,
    sessionId: `cc-orch-${sourceId}`,
    requestId: uid,
    cwd: PROJECT_ROOT,
    version: PKG_VERSION,
    message: {
      model,
      id: uid,
      type: 'message',
      role: 'assistant',
      content: [],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: session.inputTokens || 0,
        output_tokens: session.outputTokens || 0,
        cache_creation_input_tokens: session.cacheCreation || 0,
        cache_read_input_tokens: session.cacheRead || 0,
      },
    },
  });
}

// ── Load sessions from a token-usage.json path ──────────────────────
function loadSessions(usagePath) {
  if (!fs.existsSync(usagePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(usagePath, 'utf8'));
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch {
    return [];
  }
}

// ── Write JSONL to ccusage directory ────────────────────────────────
function writeJsonl(sessions, sourceId) {
  if (sessions.length === 0) {
    console.log(`  No sessions to export for ${sourceId}`);
    return;
  }

  const slug = projectSlug(PROJECT_ROOT);
  const ccuDir = path.join(os.homedir(), '.claude', 'projects', slug);
  fs.mkdirSync(ccuDir, { recursive: true });

  const outPath = path.join(ccuDir, `cc-orch-${sourceId}.jsonl`);
  const lines = sessions.map((s) => sessionToJsonl(s, sourceId)).join('\n') + '\n';
  fs.writeFileSync(outPath, lines, 'utf8');
  console.log(`  Exported ${sessions.length} sessions → ${outPath}`);
}

// ── Main ────────────────────────────────────────────────────────────
// Strip --project <path> from args before parsing other flags.
const rawArgs = process.argv.slice(2);
const args = rawArgs.filter((a, i) => a !== '--project' && rawArgs[i - 1] !== '--project');
const archiveFlag = args.indexOf('--archive');
const allFlag = args.includes('--all');

if (allFlag) {
  // Export all archives
  const archivesDir = path.join(PROJECT_ROOT, 'archives');
  if (!fs.existsSync(archivesDir)) {
    console.log('No archives found.');
    process.exit(0);
  }
  const entries = fs.readdirSync(archivesDir).filter(e => !e.startsWith('.')).sort();
  for (const entry of entries) {
    const usagePath = path.join(archivesDir, entry, 'logs', 'token-usage.json');
    const sessions = loadSessions(usagePath);
    writeJsonl(sessions, entry);
  }
  console.log(`\nExported ${entries.length} archive(s).`);
} else if (archiveFlag !== -1) {
  // Export a specific archive
  const archiveId = args[archiveFlag + 1];
  if (!archiveId) {
    console.error('Usage: export-ccusage.js --archive <archive-id>');
    process.exit(1);
  }
  const usagePath = path.join(PROJECT_ROOT, 'archives', archiveId, 'logs', 'token-usage.json');
  const sessions = loadSessions(usagePath);
  writeJsonl(sessions, archiveId);
} else {
  // Export current .harness/
  const usagePath = path.join(PROJECT_ROOT, '.harness', 'logs', 'token-usage.json');
  const sessions = loadSessions(usagePath);
  writeJsonl(sessions, 'current');
}
