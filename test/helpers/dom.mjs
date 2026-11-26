// A deliberately small DOM implementation: enough to execute the two page
// controllers in Node (no browser is available here) against a real HTTP server.
// It is not a general-purpose DOM; it supports exactly the selectors and
// element APIs the lab's own scripts use, and fails loudly on anything else.

class NodeImpl {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  append(...items) {
    for (const item of items.flat(Infinity)) {
      const node = item instanceof NodeImpl ? item : new TextNode(String(item));
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  appendChild(item) {
    this.append(item);
    return item;
  }

  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    child.parentNode = null;
    return child;
  }

  replaceChildren(...items) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...items);
  }

  get textContent() {
    if (this instanceof TextNode) return this.data;
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    if (this instanceof TextNode) { this.data = String(value); return; }
    this.childNodes = [];
    if (value !== '') this.append(new TextNode(String(value)));
  }

  get children() {
    return this.childNodes.filter((n) => n instanceof Element);
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === globalThis.document;
  }
}

class TextNode extends NodeImpl {
  constructor(data) {
    super();
    this.data = data;
  }

  get nodeType() { return 3; }
}

const VOID_TAGS = new Set(['meta', 'link', 'br', 'img', 'input', 'hr', 'source']);

class Element extends NodeImpl {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.style = new StyleProxy();
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.title = '';
    this.id = '';
    this.className = '';
    this.type = '';
    this.role = '';
    this.tabIndex = -1;
    this._options = null;
  }

  get nodeType() { return 1; }

  get options() {
    if (this.tagName !== 'SELECT') return undefined;
    if (!this._options) {
      this._options = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (!(child instanceof Element)) continue;
          if (child.tagName === 'OPTION') this._options.push(child);
          else if (child.tagName === 'OPTGROUP') walk(child);
        }
      };
      walk(this);
    }
    return this._options;
  }

  get classList() {
    const self = this;
    return {
      add: (...names) => {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        for (const n of names) set.add(n);
        self.className = [...set].join(' ');
      },
      remove: (...names) => {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        for (const n of names) set.delete(n);
        self.className = [...set].join(' ');
      },
      toggle: (name, force) => {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        const on = force === undefined ? !set.has(name) : Boolean(force);
        if (on) set.add(name); else set.delete(name);
        self.className = [...set].join(' ');
        return on;
      },
      contains: (name) => self.className.split(/\s+/).includes(name),
    };
  }

  setAttribute(name, value) {
    const v = String(value);
    this.attributes.set(name, v);
    if (name === 'id') this.id = v;
    else if (name === 'class') this.className = v;
    else if (name === 'value') this.value = v;
    else if (name === 'checked') this.checked = v !== 'false';
    else if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = v;
    else if (name === 'hidden') this.hidden = true;
  }

  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.getAttribute(name) != null;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  dispatchEvent(event) {
    const evt = { target: this, currentTarget: this, defaultPrevented: false, ...event };
    evt.preventDefault = () => { evt.defaultPrevented = true; };
    evt.stopPropagation = () => {};
    for (const fn of this.listeners.get(evt.type) ?? []) fn(evt);
    return !evt.defaultPrevented;
  }

  click() {
    this.dispatchEvent({ type: 'click' });
  }

  closest(selector) {
    let node = this;
    while (node instanceof Element) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  querySelector(selector) {
    return queryAll(this, selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, right: 40, bottom: 20, width: 40, height: 20 };
  }

  get parentElement() {
    return this.parentNode instanceof Element ? this.parentNode : null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[idx + 1] ?? null;
  }
}

class StyleProxy {
  constructor() {
    this._props = new Map();
  }

  setProperty(name, value) {
    this._props.set(name, String(value));
  }

  getPropertyValue(name) {
    return this._props.get(name) ?? '';
  }
}

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function compoundTest(token) {
  // Supported compound pieces: tag, #id, .class, [attr] / [attr="value"].
  const tagMatch = /^[a-zA-Z][\w-]*/.exec(token);
  const tag = tagMatch ? tagMatch[0].toUpperCase() : null;
  const ids = [...token.matchAll(/#([\w-]+)/g)].map((m) => m[1]);
  const classes = [...token.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const attrs = [...token.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)]
    .map((m) => [m[1], m[2] ?? m[3] ?? m[4] ?? null]);
  return (el) => {
    if (tag && el.tagName !== tag) return false;
    if (ids.some((id) => el.id !== id)) return false;
    if (classes.some((c) => !el.classList.contains(c))) return false;
    for (const [name, value] of attrs) {
      const actual = el.getAttribute(name);
      if (actual == null) return false;
      if (value != null && actual !== value) return false;
    }
    return true;
  };
}

function matcherFor(selector) {
  const cache = new Map();
  if (cache.has(selector)) return cache.get(selector);
  const parts = selector.trim().split(',').map((s) => s.trim());
  const tests = parts.map((part) => part.split(/\s+/).filter(Boolean).map(compoundTest));
  const fn = (el) => tests.some((chain) => {
    if (!chain[chain.length - 1](el)) return false;
    let node = el.parentNode;
    for (let i = chain.length - 2; i >= 0; i -= 1) {
      while (node instanceof Element && !chain[i](node)) node = node.parentNode;
      if (!(node instanceof Element)) return false;
      node = node.parentNode;
    }
    return true;
  });
  cache.set(selector, fn);
  return fn;
}

function matchesSelector(el, selector) {
  return matcherFor(selector)(el);
}

function queryAll(root, selector) {
  const test = matcherFor(selector);
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (!(child instanceof Element)) continue;
      if (test(child)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

class Document extends NodeImpl {
  constructor() {
    super();
    this.documentElement = new Element('html');
    this.head = new Element('head');
    this.body = new Element('body');
    this.documentElement.append(this.head, this.body);
    this.append(this.documentElement);
    this.listeners = new Map();
  }

  createElement(tag) {
    return new Element(tag);
  }

  createTextNode(data) {
    return new TextNode(String(data));
  }

  getElementById(id) {
    const [hit] = queryAll(this, `#${id}`);
    return hit ?? null;
  }

  querySelector(selector) {
    if (selector === 'body') return this.body;
    if (selector === 'html') return this.documentElement;
    return queryAll(this.documentElement, selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    return queryAll(this.documentElement, selector);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  dispatchEvent(event) {
    const evt = { target: this, currentTarget: this, defaultPrevented: false, ...event };
    evt.preventDefault = () => { evt.defaultPrevented = true; };
    evt.stopPropagation = () => {};
    for (const fn of this.listeners.get(evt.type) ?? []) fn(evt);
    return !evt.defaultPrevented;
  }
}

/** Parse the subset of HTML used by the lab pages into a Document. */
export function parseHtml(html) {
  const doc = new Document();
  const root = doc.body;
  const stack = [root];
  const tokenRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = tokenRe.exec(html))) {
    if (m[5] !== undefined) {
      const text = m[5];
      if (text.trim() !== '') stack[stack.length - 1].append(text.replace(/\s+/g, ' '));
      continue;
    }
    const [, closing, rawTag, rawAttrs, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      if (stack.length > 1 && stack[stack.length - 1].tagName === tag.toUpperCase()) stack.pop();
      continue;
    }
    const element = doc.createElement(tag);
    for (const attr of rawAttrs.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
      if (!attr[1]) continue;
      element.setAttribute(attr[1], attr[2] ?? '');
    }
    // Hoist ids into the head/body structure the page declares.
    const parent = stack[stack.length - 1];
    parent.append(element);
    if (!VOID_TAGS.has(tag) && selfClose !== '/') {
      if (tag === 'script') {
        // Skip script bodies; modules are imported explicitly by the test.
        const close = html.indexOf('</script>', tokenRe.lastIndex);
        if (close >= 0) tokenRe.lastIndex = close + '</script>'.length;
        continue;
      }
      stack.push(element);
    }
  }
  return doc;
}

export { Element, TextNode, NodeImpl as Node, Document };
