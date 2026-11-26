// Shared helpers: DOM building, formatting, tooltip, theme toggle.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Create an element. Text is always inserted as textContent (never HTML). */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'on') for (const [ev, fn] of Object.entries(value)) node.addEventListener(ev, fn);
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') throw new Error('Refusing innerHTML');
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

const nf = new Intl.NumberFormat('en-US');
const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
export const fmtInt = (n) => (n == null ? '—' : nf.format(n));
export const fmtNum = (n) => (n == null ? '—' : nf2.format(n));
export const fmtPct = (n, digits = 1) => (n == null ? '—' : `${(n * 100).toFixed(digits)}%`);

export function fmtBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function fmtMs(ms) {
  if (ms == null) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** ISO with microseconds from epoch µs, as a compact UTC label. */
export function fmtUtcFromUs(us) {
  if (us == null) return '—';
  const sec = Math.floor(us / 1e6);
  const frac = us - sec * 1e6;
  const d = new Date(sec * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    + (frac ? `.${pad(frac, 6)}` : '') + 'Z';
}

export function fmtUtcShort(us) {
  if (us == null) return '—';
  const d = new Date(Math.floor(us / 1e6) * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
}

export function fmtHours(h) {
  if (h == null) return '—';
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}h`;
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- tooltip ----------
let tipEl = null;
export function tip() {
  if (!tipEl) {
    tipEl = el('div', { class: 'tip', role: 'status', 'aria-live': 'polite' });
    document.body.append(tipEl);
  }
  return tipEl;
}

export function showTip(anchorRect, title, rows) {
  const node = tip();
  clear(node);
  if (title) node.append(el('div', { class: 't-title', text: title }));
  for (const [k, v] of rows) {
    node.append(el('div', { class: 't-row' }, el('span', { text: k }), el('b', { text: v })));
  }
  node.classList.add('on');
  const pad = 12;
  const { width, height } = node.getBoundingClientRect();
  let x = anchorRect.left + anchorRect.width / 2 - width / 2;
  let y = anchorRect.top - height - 8;
  if (y < 8) y = anchorRect.bottom + 8;
  x = Math.max(8, Math.min(window.innerWidth - width - 8, x));
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
}

export function hideTip() {
  if (tipEl) tipEl.classList.remove('on');
}

export function bindTip(target, titleFn, rowsFn) {
  const show = () => {
    const rect = target.getBoundingClientRect();
    showTip(rect, titleFn(), rowsFn());
  };
  target.addEventListener('pointerenter', show);
  target.addEventListener('pointermove', show);
  target.addEventListener('pointerleave', hideTip);
  target.addEventListener('focus', show);
  target.addEventListener('blur', hideTip);
}

// ---------- theme ----------
export function initTheme(toggleButton) {
  const stored = localStorage.getItem('zsl-theme');
  if (stored === 'dark' || stored === 'light') document.documentElement.dataset.theme = stored;
  const update = () => {
    const isDark = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    toggleButton.textContent = isDark ? '浅色' : '深色';
    toggleButton.setAttribute('aria-label', isDark ? '切换到浅色主题' : '切换到深色主题');
  };
  toggleButton.addEventListener('click', () => {
    const isDark = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('zsl-theme', next);
    update();
    window.dispatchEvent(new CustomEvent('zsl-theme-change', { detail: { theme: next } }));
  });
  update();
}

export async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
  if (!res.ok) {
    const err = new Error(body.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.kind = body.kind;
    err.position = body.position;
    throw err;
  }
  return body;
}

export function levelBadge(level) {
  const label = level === 'ok' ? 'OK' : level === 'warn' ? 'WARN' : 'ERR';
  return el('span', { class: `lvl ${level}`, text: label });
}

export function storeGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

export function storeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore quota */ }
}
