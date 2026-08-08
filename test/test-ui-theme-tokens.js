/**
 * test-ui-theme-tokens.js — Structural source-scan for the dark design-token
 * contract (demo-grade-ui spec, acceptance criterion 1).
 *
 * Contract:
 *   - src/ui/public/tokens.css exists and defines the full token set.
 *   - The three on-camera pages (index.html, archives.html,
 *     archive-detail.html) include tokens.css in their <head>.
 *   - No page-level stylesheet (kanban.css), page HTML, or page JS file
 *     (kanban.js, archives.js, archive-detail.js) carries hex/rgb color
 *     literals of its own — tokens.css is the only home of color literals,
 *     including the --shadow token's rgba value.
 *
 * Style mirrors the repo's other static-scan tests (e.g.
 * test-suite-hermeticity.js Criterion 5).
 *
 * Run: node test/test-ui-theme-tokens.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = (f) => path.resolve(__dirname, '../src/ui/public', f);

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

const PAGES_HTML = ['index.html', 'archives.html', 'archive-detail.html'];
const PAGE_CSS = ['kanban.css'];
const PAGE_JS = ['kanban.js', 'archives.js', 'archive-detail.js'];

const REQUIRED_TOKENS = [
  '--bg', '--surface', '--surface-2', '--border',
  '--text', '--text-2', '--text-3',
  '--accent', '--accent-hover',
  '--ok', '--fail', '--warn', '--info',
  '--shadow', '--font-ui', '--font-mono',
];

// Hex color literal: #RGB / #RGBA / #RRGGBB / #RRGGBBAA as a standalone
// token (not a longer identifier like an element id).
const HEX_COLOR_RE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])/g;
const RGB_FN_RE = /\brgba?\(/g;

test('tokens.css exists and defines the full token set', () => {
  const src = fs.readFileSync(pub('tokens.css'), 'utf8');
  for (const token of REQUIRED_TOKENS) {
    assert.ok(
      new RegExp(`${token}\\s*:`).test(src),
      `tokens.css must define ${token}`
    );
  }
});

for (const page of PAGES_HTML) {
  test(`${page} includes tokens.css in its <head>`, () => {
    const src = fs.readFileSync(pub(page), 'utf8');
    const head = src.slice(0, src.indexOf('</head>'));
    assert.ok(
      /<link[^>]+href="[^"]*tokens\.css"/.test(head),
      `${page} must link tokens.css in <head>`
    );
  });
}

for (const file of [...PAGES_HTML, ...PAGE_CSS, ...PAGE_JS]) {
  test(`${file} carries no color literals of its own`, () => {
    const src = fs.readFileSync(pub(file), 'utf8');
    const hex = src.match(HEX_COLOR_RE) || [];
    assert.deepStrictEqual(
      hex, [],
      `${file} must not contain hex color literals (found: ${hex.join(', ')}) — use var(--token) from tokens.css`
    );
    const rgb = src.match(RGB_FN_RE) || [];
    assert.deepStrictEqual(
      rgb, [],
      `${file} must not contain rgb()/rgba() literals — the only rgba lives in tokens.css (--shadow)`
    );
  });
}

test('tokens.css is the only home of the shadow rgba literal', () => {
  const src = fs.readFileSync(pub('tokens.css'), 'utf8');
  assert.ok(
    /--shadow\s*:[^;]*rgba?\(/.test(src),
    'tokens.css must define --shadow with its rgba value'
  );
});

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount > 0 ? 1 : 0);
