/**
 * import-graph.js — Static import-graph builder for nightfoundry.
 *
 * Pure JS. No AI, no shell. Scans source files for ES module `import`
 * statements and builds a directed dependency graph. The graph is
 * injected into the planner's context so the planner can decompose
 * work by runtime dependency (call-graph topology) rather than by
 * file-tree proximity (directory grouping).
 *
 * Rationale:
 * dogfood 5 showed the planner grouping by "agent modules" vs "core
 * modules" vs "gate modules", producing 4 milestones when 1 would
 * have been correct. The import graph makes the actual dependency
 * structure explicit so the planner can identify:
 *   - Which files share runtime data contracts (same mission)
 *   - Which files are independent leaves (parallelizable tasks)
 *   - Which files are roots/trunks that fan out (natural barriers)
 *
 * The graph is regenerated from source on every cc-orch run — it is
 * a derived artifact like a build cache, never hand-maintained, never
 * stale. Adding or removing an import in any file is automatically
 * reflected on the next run.
 *
 * Public API:
 *   buildImportGraph(projectRoot, opts?) → { nodes, edges }
 *   formatGraphForPrompt(graph) → string (human-readable for LLM consumption)
 */
import fs from 'fs';
import path from 'path';

/**
 * Regex for ES module static imports. Captures the module specifier.
 * Handles:
 *   import X from './path.js'
 *   import { X } from './path.js'
 *   import { X, Y } from './path.js'
 *   import * as X from './path.js'
 *   import './path.js'
 *
 * Does NOT capture dynamic imports (import('./path')) — those are
 * runtime-only and shouldn't influence planning decomposition.
 */
const IMPORT_RE = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

/**
 * Build the import graph for all .js files under `srcDir`.
 *
 * @param {string} projectRoot - absolute path to the project root
 * @param {object} [opts]
 * @param {string} [opts.srcDir='src'] - directory to scan (relative to projectRoot)
 * @param {string[]} [opts.extensions=['.js']] - file extensions to include
 * @returns {{ nodes: string[], edges: Array<{from: string, to: string}> }}
 */
export function buildImportGraph(projectRoot, opts = {}) {
  const srcDir = opts.srcDir || 'src';
  const extensions = opts.extensions || ['.js'];
  const absSrcDir = path.resolve(projectRoot, srcDir);

  if (!fs.existsSync(absSrcDir)) {
    return { nodes: [], edges: [] };
  }

  const files = walkJsFiles(absSrcDir, extensions);
  const nodesSet = new Set();
  const edges = [];

  for (const absFilePath of files) {
    const relFile = path.relative(projectRoot, absFilePath);
    nodesSet.add(relFile);

    const content = fs.readFileSync(absFilePath, 'utf8');
    let match;
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(content)) !== null) {
      const specifier = match[1];

      // Only resolve relative imports (./... or ../...). Package
      // imports (express, node:fs) are irrelevant for the project's
      // internal call graph.
      if (!specifier.startsWith('.')) continue;

      const resolved = resolveImport(absFilePath, specifier);
      if (!resolved || !fs.existsSync(resolved)) continue;

      const relTarget = path.relative(projectRoot, resolved);
      nodesSet.add(relTarget);
      edges.push({ from: relFile, to: relTarget });
    }
  }

  const nodes = Array.from(nodesSet).sort();
  return { nodes, edges };
}

/**
 * Format the import graph as a human-readable text block suitable for
 * injection into a planner prompt. Groups edges by source file; each
 * source lists its imports with arrows.
 *
 * Example output:
 *   src/orchestrator/core/pipeline.js
 *     → src/orchestrator/agents/executor.js
 *     → src/orchestrator/core/state-machine.js
 *
 * @param {{ nodes: string[], edges: Array<{from: string, to: string}> }} graph
 * @returns {string}
 */
export function formatGraphForPrompt(graph) {
  if (!graph || graph.edges.length === 0) {
    return '(no internal import dependencies found)';
  }

  // Group edges by source file
  const bySource = new Map();
  for (const edge of graph.edges) {
    if (!bySource.has(edge.from)) bySource.set(edge.from, []);
    bySource.get(edge.from).push(edge.to);
  }

  // Sort sources by path depth (deepest first → leaves first, then trunks)
  // so the planner reads leaf modules before the root pipeline.
  const sources = Array.from(bySource.keys()).sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    if (depthA !== depthB) return depthB - depthA;
    return a.localeCompare(b);
  });

  const lines = [];
  for (const src of sources) {
    lines.push(src);
    const targets = bySource.get(src).sort();
    for (const t of targets) {
      lines.push(`  → ${t}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ── Internals ────────────────────────────────────────────────────────

function walkJsFiles(dir, extensions) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules, .harness, hidden dirs
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      results.push(...walkJsFiles(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

function resolveImport(fromFile, specifier) {
  const dir = path.dirname(fromFile);
  let resolved = path.resolve(dir, specifier);

  // If the specifier already has an extension, use it directly
  if (path.extname(resolved)) return resolved;

  // Try adding .js (most common for ESM in Node)
  if (fs.existsSync(resolved + '.js')) return resolved + '.js';

  // Try index.js
  if (fs.existsSync(path.join(resolved, 'index.js'))) {
    return path.join(resolved, 'index.js');
  }

  return null;
}
