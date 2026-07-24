/**
 * test-import-graph.js — Unit tests for import-graph builder.
 * Run: node test/test-import-graph.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildImportGraph, formatGraphForPrompt } from '../src/orchestrator/core/import-graph.js';

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

test('buildImportGraph: finds nodes and edges in cc-orch itself', () => {
  const graph = buildImportGraph('.');
  assert.ok(graph.nodes.length >= 15, `expected >=15 nodes, got ${graph.nodes.length}`);
  assert.ok(graph.edges.length >= 30, `expected >=30 edges, got ${graph.edges.length}`);
  assert.ok(graph.nodes.includes('src/orchestrator/core/pipeline.js'));
  assert.ok(graph.nodes.includes('src/orchestrator/agents/verifier.js'));
});

test('buildImportGraph: pipeline.js imports agents, core, gates, infra', () => {
  const graph = buildImportGraph('.');
  const pipelineEdges = graph.edges.filter((e) => e.from === 'src/orchestrator/core/pipeline.js');
  const targets = pipelineEdges.map((e) => e.to);
  assert.ok(targets.includes('src/orchestrator/agents/executor.js'), 'pipeline → executor');
  assert.ok(targets.includes('src/orchestrator/core/state-machine.js'), 'pipeline → state-machine');
  assert.ok(targets.includes('src/orchestrator/gates/audit.js'), 'pipeline → audit');
});

test('buildImportGraph: skips package imports (not relative)', () => {
  const graph = buildImportGraph('.');
  // No edges should point to 'fs', 'path', 'express', etc.
  const packageEdges = graph.edges.filter((e) => !e.to.startsWith('src/'));
  assert.strictEqual(packageEdges.length, 0, `found non-src edges: ${JSON.stringify(packageEdges.slice(0, 3))}`);
});

test('buildImportGraph: empty srcDir returns empty graph', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-graph-empty-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    const graph = buildImportGraph(dir);
    assert.strictEqual(graph.nodes.length, 0);
    assert.strictEqual(graph.edges.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildImportGraph: missing srcDir returns empty graph', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-graph-nosrc-'));
  try {
    const graph = buildImportGraph(dir);
    assert.strictEqual(graph.nodes.length, 0);
    assert.strictEqual(graph.edges.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildImportGraph: resolves relative imports with .js extension', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-graph-resolve-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), "import { x } from './b.js';\n");
    fs.writeFileSync(path.join(dir, 'src', 'b.js'), "export const x = 1;\n");
    const graph = buildImportGraph(dir);
    assert.strictEqual(graph.nodes.length, 2);
    assert.strictEqual(graph.edges.length, 1);
    assert.strictEqual(graph.edges[0].from, 'src/a.js');
    assert.strictEqual(graph.edges[0].to, 'src/b.js');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('formatGraphForPrompt: produces readable text', () => {
  const graph = buildImportGraph('.');
  const text = formatGraphForPrompt(graph);
  assert.ok(text.includes('src/orchestrator/core/pipeline.js'), 'should include pipeline');
  assert.ok(text.includes('→'), 'should use arrow notation');
  assert.ok(text.length > 200, 'should be substantial for a real codebase');
});

test('formatGraphForPrompt: empty graph returns placeholder', () => {
  const text = formatGraphForPrompt({ nodes: [], edges: [] });
  assert.ok(/no internal import/i.test(text));
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
