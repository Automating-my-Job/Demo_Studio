'use strict';
// A deliberately tiny DOM for the live kit: elements with boxes, attributes,
// shadow roots, and a vm context with the kit (or the full camera client)
// installed. Selectors: '.class', 'tag', '#id', '[attr=value]'.
const vm = require('node:vm');

class Text {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parentNode = null; }
  get textContent() { return this.nodeValue; }
}

class El {
  constructor(tag, opts) {
    const o = opts || {};
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.id = o.id || '';
    this.className = o.cls || '';
    this.childNodes = [];
    this.shadowRoot = null;
    this.parentNode = null;
    this.value = o.value || '';
    this.placeholder = o.placeholder || '';
    this.type = o.type || '';
    this.attrs = Object.assign({}, o.attrs || {});
    this.box = o.box || null;          // [left, top, width, height]; null = 0x0
    this.hidden = !!o.hidden;          // checkVisibility() === false
    this.clicks = 0;
    this.style = {};
    this.overflow = o.overflow || 'visible';
    this.position = o.position || 'static';
    this.textTransform = o.textTransform || 'none';
  }
  appendChild(n) { this.add(n); return n; }
  setAttribute(name, v) { this.attrs[name] = String(v); }
  add(...nodes) { nodes.forEach((n) => { n.parentNode = this; this.childNodes.push(n); }); return this; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.childNodes = []; this.add(new Text(String(v))); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  matches(sel) {
    if (sel[0] === '.') return this.className.split(/\s+/).includes(sel.slice(1));
    if (sel[0] === '#') return this.id === sel.slice(1);
    const m = /^\[([\w-]+)=["']?([^"'\]]*)["']?\]$/.exec(sel);
    if (m) return this.getAttribute(m[1]) === m[2];
    return this.tagName === sel.toUpperCase();
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => node.childNodes.forEach((c) => { if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); } });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() {
    const [l, t, w, h] = this.box || [0, 0, 0, 0];
    return { left: l, top: t, width: w, height: h, right: l + w, bottom: t + h };
  }
  checkVisibility() { return !this.hidden; }
  click() { this.clicks++; }
}

class Root extends El {
  constructor() { super('#root'); this.nodeType = 11; }
  attachTo(host) { host.shadowRoot = this; this.host = host; return this; }
}

/**
 * A vm context whose document is `html` (an El), with `install` (a JS
 * string such as buildLiveKitJs()) evaluated in it.
 */
function contextFor(html, install, extra) {
  const document = {
    documentElement: html,
    querySelector: (sel) => html.querySelector(sel),
    querySelectorAll: (sel) => html.querySelectorAll(sel),
    getElementById: (id) => html.querySelectorAll('#' + id)[0] || null,
    createElement: (tag) => new El(tag),
    createElementNS: (ns, tag) => new El(tag),
    elementFromPoint: (extra && extra.elementFromPoint) || null,
  };
  const getComputedStyle = (el) => ({ overflowX: el.overflow || 'visible', overflowY: el.overflow || 'visible', position: el.position || 'static', textTransform: el.textTransform || 'none' });
  const ctx = Object.assign({ document, innerWidth: 1920, innerHeight: 1080, getComputedStyle }, extra || {});
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(install, ctx);
  return ctx;
}

module.exports = { Text, El, Root, contextFor };
