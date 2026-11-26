// End-to-end: execute the real page controllers in a minimal DOM, talking to
// the real HTTP server. Verifies the workbench renders a query and that a
// drilldown link from a rendered row actually produces a working drill page.
//
// Skipped when the dataset or the server is unavailable; the test starts the
// server itself on an ephemeral port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseHtml, Node } from './helpers/dom.mjs';
import { DB_PATH } from '../server/db.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const hasData = existsSync(DB_PATH);
// Captured before the DOM stub replaces globalThis.fetch, or the wrapper below
// would resolve to itself.
const realFetch = globalThis.fetch.bind(globalThis);

let server;
let base;

test.before(async () => {
  if (!hasData) return;
  const port = 5300 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 10_000);
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
    server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
});

test.after(() => {
  server?.kill();
});

/** Install the browser globals the page scripts expect. */
function installDom(html, { search = '' } = {}) {
  const document = parseHtml(html);
  const storage = new Map();
  const location = {
    search,
    pathname: '/',
    origin: base,
    href: `${base}/${search}`,
  };
  const win = {
    location,
    document,
    history: { replaceState: (_s, _t, url) => { if (url) location.href = url; } },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    navigator: { clipboard: { writeText: async () => {} } },
    InnerHeight: 800,
    innerWidth: 1440,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    prompt: () => {},
    setTimeout,
    clearTimeout,
    fetch: (path, options) => realFetch(path.startsWith('http') ? path : `${base}${path}`, options),
  };
  win.window = win;
  win.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  const globals = {
    document,
    window: win,
    location,
    history: win.history,
    localStorage: win.localStorage,
    matchMedia: win.matchMedia,
    navigator: win.navigator,
    CustomEvent: win.CustomEvent,
    fetch: win.fetch,
    Node,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return { document, win, location };
}

// Page controllers are stateful singletons; each test needs a fresh evaluation.
let moduleSeq = 0;
function importModule(path) {
  moduleSeq += 1;
  return import(`${new URL(path, import.meta.url).href}?case=${moduleSeq}`);
}

/** Wait until `predicate()` is true, or fail after `timeoutMs`. */
async function until(predicate, timeoutMs = 20_000, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function findButton(root, text) {
  return [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text) ?? null;
}

function textOf(root, selector) {
  const node = root.querySelector(selector);
  assert.ok(node, `missing ${selector}`);
  return node.textContent;
}

test('workbench renders a complete result for a DST edge case', { skip: !hasData }, async () => {
  const html = await readFile(`${ROOT}public/index.html`, 'utf8');
  const { document } = installDom(html, {
    search: '?zone=America/Havana&expr=local_date(ts)%20%3D%20DATE%20%272026-03-08%27&verify=1&fullscan=1',
  });

  await importModule('../public/main.js');
  await until(() => document.querySelectorAll('#rows-body tr').length > 0, 25_000, 'rows to render');

  // KPI tiles.
  const tiles = [...document.querySelectorAll('.kpi')].map((k) => k.textContent);
  assert.ok(tiles.some((t) => t.includes('扫描分区')), 'missing scan-partition tile');

  // Partition map: one cell per UTC day, exactly the selected ones highlighted.
  const cells = document.querySelectorAll('#map .cell').filter((c) => c.dataset.day);
  assert.equal(cells.length, 365);
  const selected = cells.filter((c) => c.classList.contains('selected'));
  assert.equal(selected.length, 2, 'Havana 03-08 spans two UTC partitions');
  assert.ok(cells.some((c) => c.classList.contains('unusual')), 'DST days should be flagged');

  // Interval card shows the local labelling and the 23h width.
  const hint = textOf(document, '#interval-hint');
  assert.match(hint, /23h/);
  assert.match(textOf(document, '#intervals'), /2026-03-08 01:00/);

  // Verification panel: all checks pass.
  assert.match(textOf(document, '#verify-body'), /所有核对通过/);

  // Rows carry a working drilldown link.
  const drillLink = document.querySelector('#rows-body a');
  assert.ok(drillLink, 'no drill link rendered');
  assert.match(drillLink.getAttribute('href'), /^\/drill\.html\?/);

  // The diagnostics explain the naive-mode gap.
  assert.match(textOf(document, '#diagnostics'), /朴素实现/);

  return drillLink.getAttribute('href');
});

test('a rendered drill link produces a working drilldown page', { skip: !hasData }, async () => {
  const html = await readFile(`${ROOT}public/drill.html`, 'utf8');
  const search = '?day=2026-03-09&zone=America/Havana&policy=earlier&mode=zoned'
    + '&expr=local_date(ts)%20%3D%20DATE%20%272026-03-08%27';
  const { document, location } = installDom(html, { search });

  await importModule('../public/drill.js');
  await until(() => document.querySelectorAll('#anatomy .anatomy-card').length === 3, 20_000, 'anatomy cards');

  assert.match(textOf(document, '#day-title'), /2026-03-09/);
  // The three-day anatomy window includes the 23h Havana day.
  const cards = document.querySelectorAll('#anatomy .anatomy-card').map((c) => c.textContent);
  assert.ok(cards.some((c) => c.includes('23h')), 'expected a 23h local day in the window');
  assert.ok(cards.some((c) => c.includes('无午夜')), 'expected the skipped-midnight badge');

  // Selection panel: this partition holds only the tail of the local day.
  const selection = textOf(document, '#selection');
  assert.match(selection, /部分选中/);
  assert.match(selection, /16\.7%/);

  // Three-way reconciliation agrees.
  assert.match(textOf(document, '#reconciliation'), /逐项一致/);
  const agrees = document.querySelectorAll('.rec-table td.agree');
  assert.equal(agrees.length, 4, 'four metrics must agree');

  // Hour charts: UTC always 24 bars; local view marks the missing hour.
  const [utcChart, localChart] = document.querySelectorAll('.hour-chart');
  assert.equal(utcChart.children.length, 24);
  assert.ok(localChart.children.length >= 24);

  // Navigation updates the URL and stays on the same zone.
  document.querySelector('#next-day').click();
  await until(() => location.href.includes('day=2026-03-10'), 20_000, 'day navigation');
});

test('invalid expressions surface a positioned error, not a crash', { skip: !hasData }, async () => {
  const html = await readFile(`${ROOT}public/index.html`, 'utf8');
  const { document } = installDom(html, {
    search: '?zone=UTC&expr=local_date(ts)%20%3D%20DATE%20%272026-02-30%27',
  });
  await importModule('../public/main.js');
  await until(() => document.querySelector('#expr-error').classList.contains('on'), 15_000, 'error banner');
  assert.match(textOf(document, '#expr-error'), /Invalid day/);
  assert.match(textOf(document, '#expr-status'), /执行失败/);
  assert.equal(document.querySelectorAll('#rows-body tr').length, 0);
});

test('the drill page rejects days outside dataset coverage', { skip: !hasData }, async () => {
  const html = await readFile(`${ROOT}public/drill.html`, 'utf8');
  const { document } = installDom(html, { search: '?day=2025-06-01&zone=UTC' });
  await importModule('../public/drill.js');
  await until(() => textOf(document, '#partition-facts').includes('No partition'), 15_000, 'error state');
  assert.ok(findButton(document, '←') !== null);
});
