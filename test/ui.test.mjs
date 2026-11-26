// Static contract checks between the HTML pages and their controller scripts.
//
// There is no browser in this environment, so instead of a live DOM we assert
// that every element id the scripts query actually exists in the page they run
// on, that each page loads its stylesheet and module, and that no script uses
// innerHTML (the DOM helper refuses it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const PAGES = [
  { html: 'public/index.html', script: 'public/main.js' },
  { html: 'public/drill.html', script: 'public/drill.js' },
];

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function idsIn(html) {
  const ids = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  return ids;
}

/** Resolve `$('#x')` and `document.querySelectorAll('#x …')` targets. */
function selectorIds(js) {
  const found = new Set();
  for (const m of js.matchAll(/\$\(\s*'([^']+)'\s*[,)]/g)) collectRoot(m[1], found);
  for (const m of js.matchAll(/querySelector(?:All)?\(\s*'([^']+)'\s*\)/g)) collectRoot(m[1], found);
  return found;
}

function collectRoot(selector, out) {
  const head = selector.trim().split(/\s+/)[0];
  if (head.startsWith('#')) out.add(head.slice(1).replace(/[^\w-].*$/, ''));
}

for (const page of PAGES) {
  test(`${page.html} has a unique, well-formed id set`, async () => {
    const html = await read(page.html);
    const all = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(all).size, all.length, 'duplicate ids in the page');
    assert.match(html, /<link rel="stylesheet" href="\/app\.css">/);
    assert.match(html, new RegExp(`<script type="module" src="/${page.script.split('/').pop()}"></script>`));
  });

  test(`${page.script} only queries ids that exist in ${page.html}`, async () => {
    const [html, js] = await Promise.all([read(page.html), read(page.script)]);
    const ids = idsIn(html);
    const missing = [...selectorIds(js)].filter((id) => !ids.has(id));
    assert.deepEqual(missing, [], `missing ids: ${missing.join(', ')}`);
  });

  test(`${page.script} never assigns innerHTML`, async () => {
    const js = await read(page.script);
    assert.ok(!/\.innerHTML\s*=/.test(js));
    assert.ok(!/outerHTML\s*=/.test(js));
  });
}

test('the workbench wires every control to a handler', async () => {
  const js = await read('public/main.js');
  for (const id of ['zone', 'policy', 'mode-seg', 'run', 'expr', 'verify', 'fullscan', 'map-view-toggle', 'copy-link']) {
    assert.match(js, new RegExp(`#${id}'`), `no handler for #${id}`);
  }
});

test('drill links carry the query context', async () => {
  const js = await read('public/main.js');
  const m = js.match(/function dayHref\(dayKey\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'dayHref not found');
  for (const key of ['day', 'zone', 'policy', 'mode', 'expr']) {
    assert.match(m[0], new RegExp(`${key}:`), `drill link omits ${key}`);
  }
});

test('drill page reads the same parameter names the workbench writes', async () => {
  const [main, drill] = await Promise.all([read('public/main.js'), read('public/drill.js')]);
  for (const key of ['day', 'zone', 'policy', 'mode', 'expr']) {
    assert.match(main, new RegExp(`\\b${key}:`), `workbench never sets ${key}`);
    assert.match(drill, new RegExp(`params\\.get\\('${key}'\\)`), `drill never reads ${key}`);
  }
  // The drill page calls the day endpoint with `expression=` (full name).
  assert.match(drill, /q\.set\('expression'/);
});
