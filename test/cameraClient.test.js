'use strict';
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { buildCameraClientJs } = require('../vendor/demo-suite/lib/cameraClient.js');

// A deliberately tiny DOM: enough for the shadow-piercing query and the
// display-only redaction helpers. Selectors are '.class', 'tag', or '#id'.
class Text {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; }
  get textContent() { return this.nodeValue; }
}
class El {
  constructor(tag, opts) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.id = (opts && opts.id) || '';
    this.className = (opts && opts.cls) || '';
    this.childNodes = [];
    this.shadowRoot = null;
    this.value = (opts && opts.value) || '';
    this.placeholder = '';
  }
  add(...nodes) { this.childNodes.push(...nodes); return this; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  matches(sel) {
    if (sel[0] === '.') return this.className.split(/\s+/).includes(sel.slice(1));
    if (sel[0] === '#') return this.id === sel.slice(1);
    return this.tagName === sel.toUpperCase();
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => node.childNodes.forEach((c) => { if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); } });
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
class Root extends El {
  constructor() { super('#root'); this.nodeType = 11; }
}

function page() {
  const host = new El('c-app');
  host.shadowRoot = new Root().add(
    new El('article', { cls: 'card' }).add(new Text('Globex [Fictional] · Pat Real')),
    new El('article', { cls: 'card' }).add(new Text('Acme [Fictional] · Pat Real')),
    new El('input', { value: 'Pat Real (8)' }),
  );
  const cap = new El('div', { id: '__demoCap' }).add(new Text('Pat Real in a caption'));
  const html = new El('html').add(new El('body').add(new Text('Signed in as Pat Real'), host), cap);
  const document = {
    documentElement: html,
    querySelector: (sel) => html.querySelector(sel),
    querySelectorAll: (sel) => html.querySelectorAll(sel),
  };
  const ctx = { document, window: null };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(buildCameraClientJs({ pageSelector: 'c-app' }), ctx);
  return { ctx, host, cap };
}

test('__q pierces shadow roots segment by segment', () => {
  const { ctx } = page();
  const el = vm.runInContext('__q("c-app >>> .card")', ctx);
  assert.match(el.textContent, /^Globex/);
});

test('__q with text pins the last segment to a known record', () => {
  const { ctx } = page();
  const el = vm.runInContext('__q("c-app >>> .card", "Acme [Fictional]")', ctx);
  assert.match(el.textContent, /^Acme/);
});

test('__q returns null instead of throwing when any segment is missing', () => {
  const { ctx } = page();
  assert.strictEqual(vm.runInContext('__q("c-missing >>> .card")', ctx), null);
  assert.strictEqual(vm.runInContext('__q("c-app >>> .nope")', ctx), null);
  assert.strictEqual(vm.runInContext('__q("c-app >>> .card", "Initech")', ctx), null);
});

test('__redact rewrites text and input values inside shadow roots, and the audit reaches zero', () => {
  const { ctx, host } = page();
  const changed = vm.runInContext('__redact([["Pat Real", "Alex Rowan [Fictional]"]])', ctx);
  assert.strictEqual(changed, 4);
  assert.match(host.shadowRoot.childNodes[0].textContent, /Alex Rowan \[Fictional\]$/);
  assert.strictEqual(host.shadowRoot.childNodes[2].value, 'Alex Rowan [Fictional] (8)');
  assert.strictEqual(vm.runInContext('__redactAudit()', ctx), 0);
});

test('__redact() with no argument re-applies the stored pairs after a re-render', () => {
  const { ctx, host } = page();
  vm.runInContext('__redact([["Pat Real", "Alex Rowan [Fictional]"]])', ctx);
  host.shadowRoot.childNodes[1].childNodes[0].nodeValue = 'Acme [Fictional] · Pat Real';
  assert.strictEqual(vm.runInContext('__redactAudit()', ctx), 1);
  assert.strictEqual(vm.runInContext('__redact()', ctx), 1);
  assert.strictEqual(vm.runInContext('__redactAudit()', ctx), 0);
});

test('__redact leaves the demo overlays alone and is a no-op with no pairs', () => {
  const { ctx, cap } = page();
  assert.strictEqual(vm.runInContext('__redact()', ctx), 0);
  vm.runInContext('__redact([["Pat Real", "X"]])', ctx);
  assert.strictEqual(cap.textContent, 'Pat Real in a caption');
});

test('__spotGlide eases the ring from its current box to the new subject at full strength', () => {
  const style = {};
  const ring = { id: '__demoSpot', style };
  const rects = { a: { left: 100, top: 300, right: 300, bottom: 400 }, b: { left: 700, top: 500, right: 1100, bottom: 700 } };
  const mk = (k) => ({ getBoundingClientRect: () => rects[k] });
  const ctx = {
    document: {
      getElementById: (id) => (id === '__demoSpot' ? ring : null),
      querySelector: () => null,
      documentElement: { appendChild() {}, style: {} },
    },
    innerWidth: 1920, innerHeight: 1080,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(buildCameraClientJs({ captionHeight: 140 }), ctx);
  ctx.A = mk('a'); ctx.B = mk('b');
  vm.runInContext('__spot(A, 1)', ctx);
  const start = { left: style.left, top: style.top };
  vm.runInContext('__spotGlide(B, 0)', ctx);
  assert.strictEqual(style.left, start.left, 't=0 keeps the old box');
  vm.runInContext('__spotGlide(B, 0.5)', ctx);
  const mid = parseFloat(style.left);
  assert.ok(mid > parseFloat(start.left) && mid < 688, 'midpoint lies between the two boxes');
  vm.runInContext('__spotGlide(B, 1)', ctx);
  assert.strictEqual(style.left, '688px', 'ends on the new subject (12px pad)');
  assert.match(style.boxShadow, /rgba\(4,8,14,0\.600\)/, 'dim stays at full strength while gliding');
  assert.strictEqual(ctx.__spotSel, ctx.B, 'the new subject becomes the live spotlight');
});

// ---------------------------------------------------------------------------
// Live-take overlays: a rect-based spotlight (for subjects measured inside an
// iframe), the visible cursor, and the band over the app's global header.
const { El: TinyEl, contextFor } = require('./fixtures/tinyDom.js');

function overlayPage(config) {
  const html = new TinyEl('html', { box: [0, 0, 1920, 1080] }).add(new TinyEl('body', { box: [0, 0, 1920, 1080] }));
  const ctx = contextFor(html, buildCameraClientJs(config));
  return { ctx, html };
}

test('__spotRect rings a rect given in viewport px, clamped by the band and margin', () => {
  const { ctx, html } = overlayPage({ captionHeight: 0, margin: 8 });
  vm.runInContext('__spotRect(300, 700, 460, 730, 1)', ctx);
  const ring = html.querySelector('#__demoSpot');
  assert.deepStrictEqual([ring.style.left, ring.style.top, ring.style.width, ring.style.height], ['288px', '688px', '184px', '54px']);
  assert.match(ring.style.boxShadow, /rgba\(4,8,14,0\.600\)/);
  vm.runInContext('__band("Set up Revenue Execution", 98)', ctx);
  vm.runInContext('__spotRect(20, 90, 60, 130, 1)', ctx);
  assert.strictEqual(ring.style.top, '102px', 'the ring never runs under the band (98 + margin/2)');
});

test('captionHeight and margin of 0 are honored, not replaced by the defaults', () => {
  const { ctx } = overlayPage({ captionHeight: 0, margin: 0 });
  assert.strictEqual(vm.runInContext('window.__CAP', ctx), 0);
  assert.strictEqual(vm.runInContext('window.__M', ctx), 0);
});

test('__band covers the header, registers a cover rect, and re-measures each call', () => {
  const { ctx, html } = overlayPage({ captionHeight: 0, margin: 8 });
  const header = new TinyEl('div', { id: 'oneHeader', box: [0, 0, 1920, 98] });
  html.childNodes[0].add(header);
  assert.strictEqual(vm.runInContext('__band("Set up Revenue Execution", "#oneHeader")', ctx), 98);
  const band = html.querySelector('#__demoBand');
  assert.strictEqual(band.textContent, 'Set up Revenue Execution');
  assert.match(band.style.cssText, /pointer-events:none/, 'real clicks pass through');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(vm.runInContext('window.__covers', ctx))), [{ l: 0, t: 0, r: 1920, b: 98 }]);
  header.box = [0, 0, 1920, 50];
  vm.runInContext('__band(null, "#oneHeader")', ctx);
  assert.strictEqual(band.style.height, '50px');
  assert.strictEqual(band.textContent, 'Set up Revenue Execution', 'null text keeps the title');
});

test('__cursor puts the arrow tip on the point, dips on press, and never takes pointer events', () => {
  const { ctx, html } = overlayPage({ captionHeight: 0, margin: 8 });
  vm.runInContext('__cursor(400, 300, 0)', ctx);
  const c = html.querySelector('#__demoCursor');
  assert.match(c.style.cssText, /pointer-events:none/);
  assert.strictEqual(c.style.transform, 'translate(397px,297px) scale(1.000)', 'tip offset of 3px');
  vm.runInContext('__cursor(400, 300, 1)', ctx);
  assert.strictEqual(c.style.transform, 'translate(397px,297px) scale(0.860)');
  assert.strictEqual(html.querySelector('#__demoCursorRing').style.opacity, '0.900');
  vm.runInContext('__cursorHide()', ctx);
  assert.strictEqual(c.style.display, 'none');
});
