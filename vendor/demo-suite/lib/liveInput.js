'use strict';
/**
 * liveInput.js — real input for live-app takes: keystrokes and mouse events
 * through Chrome's own input pipeline, a visible cursor that glides to its
 * target, and subjects found by their on-screen label in ANY frame.
 * NODE-ONLY.
 *
 * ===========================================================================
 * WHY REAL INPUT
 * ===========================================================================
 * rec.type() sets an input's value by script, and rec.click() calls
 * element.click(). Staged pages accept both. Salesforce does not reliably:
 * the App Launcher search and Setup's Quick Find filter on key events, and
 * Lightning menus open on real pointer sequences. CDP's Input domain
 * (`Input.dispatchKeyEvent`, `Input.dispatchMouseEvent`) goes through the
 * browser's hit testing and focus routing, so a keystroke reaches the
 * focused field even inside a cross-site Setup iframe, and a click lands on
 * whatever a person's click would.
 *
 * Mouse coordinates are TOP-frame viewport px. A subject inside an iframe is
 * measured in its own frame and mapped up with frames.js.
 */
const { toTopRect } = require('./frames.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cubic ease-in-out, the same curve the camera and spotlight use. */
function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * How long the cursor takes to travel `dist` px: quick for a short hop,
 * never a slow drift across the screen. Film ms.
 */
function glideMsFor(dist) {
  return Math.round(Math.min(900, Math.max(380, 300 + dist * 0.4)));
}

/** CDP key-event fields for one printable character. */
function keyFor(ch) {
  const SHIFTED = { '!': ['Digit1', 49], '@': ['Digit2', 50], '#': ['Digit3', 51], $: ['Digit4', 52], '%': ['Digit5', 53],
    '^': ['Digit6', 54], '&': ['Digit7', 55], '*': ['Digit8', 56], '(': ['Digit9', 57], ')': ['Digit0', 48],
    _: ['Minus', 189], '+': ['Equal', 187], '?': ['Slash', 191], ':': ['Semicolon', 186], '"': ['Quote', 222] };
  const PLAIN = { ' ': ['Space', 32], '/': ['Slash', 191], '-': ['Minus', 189], '.': ['Period', 190], ',': ['Comma', 188],
    "'": ['Quote', 222], ';': ['Semicolon', 186], '=': ['Equal', 187] };
  if (/^[a-z]$/.test(ch)) return { key: ch, code: 'Key' + ch.toUpperCase(), keyCode: ch.toUpperCase().charCodeAt(0), shift: false };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: 'Key' + ch, keyCode: ch.charCodeAt(0), shift: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: 'Digit' + ch, keyCode: ch.charCodeAt(0), shift: false };
  if (PLAIN[ch]) return { key: ch, code: PLAIN[ch][0], keyCode: PLAIN[ch][1], shift: false };
  if (SHIFTED[ch]) return { key: ch, code: SHIFTED[ch][0], keyCode: SHIFTED[ch][1], shift: true };
  return null;   // anything else goes through Input.insertText
}

/** CDP key-event fields for a named key. */
function namedKey(name) {
  const K = {
    Enter: ['Enter', 13, '\r'], Escape: ['Escape', 27, ''], Tab: ['Tab', 9, ''], Backspace: ['Backspace', 8, ''],
    ArrowDown: ['ArrowDown', 40, ''], ArrowUp: ['ArrowUp', 38, ''], ArrowLeft: ['ArrowLeft', 37, ''], ArrowRight: ['ArrowRight', 39, ''],
  };
  const k = K[name];
  if (!k) throw new Error('unknown key: ' + name);
  return { key: name, code: k[0], keyCode: k[1], text: k[2] };
}

/** The keyDown/keyUp pair for one character (or null: use insertText). */
function keyEventsFor(ch) {
  const k = keyFor(ch);
  if (!k) return null;
  const modifiers = k.shift ? 8 : 0;
  return [
    { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, text: ch, unmodifiedText: ch, modifiers: modifiers },
    { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: modifiers },
  ];
}

/**
 * The JS expression (evaluated inside a frame that has the kit) that yields
 * a subject's element. Subjects:
 *   {text: 'Manage Assignments', selector?, within?, exact?, nth?}
 *                                                  - by visible label
 *   {q: 'host >>> .sel', text?}                            - shadow path
 *   {expr: 'any JS expression yielding an element'}
 * Any of them takes `frame`: 'auto' (default: top, then child frames),
 * 'top', 'child', or {title: 'Permission Sets'} (the owning iframe's title),
 * and `pad` (ring padding in px, a number or [t,r,b,l]) for spot().
 */
function subjectExpr(s) {
  if (typeof s === 'string') return '(' + s + ')';
  if (s.expr) return '(' + s.expr + ')';
  if (s.q) return '__q(' + JSON.stringify(s.q) + (s.text === undefined ? '' : ',' + JSON.stringify(s.text)) + ')';
  if (s.text !== undefined) {
    const o = {};
    if (s.selector) o.selector = s.selector;
    if (s.exact === false) o.exact = false;
    if (s.nth) o.nth = s.nth;
    if (s.within) o.within = s.within;
    return '__findText(' + JSON.stringify(s.text) + ',' + JSON.stringify(o) + ')';
  }
  throw new Error('subject needs text, q, or expr');
}

/** A short, non-identifying description of a subject for errors and traces. */
function describeSubject(s) {
  if (typeof s === 'string') return s.slice(0, 80);
  const where = s.frame && s.frame !== 'auto' ? ' in ' + (typeof s.frame === 'string' ? s.frame : 'frame "' + (s.frame.title || '') + '"') : '';
  if (s.text !== undefined && !s.q) return '"' + s.text + '"' + where;
  if (s.q) return s.q + (s.text ? ' "' + s.text + '"' : '') + where;
  return String(s.expr).slice(0, 80) + where;
}

/**
 * Builds the live primitives over a recorder's internals.
 * @param {object} k - {client, frames, run, frame (shoot one film frame of
 *   ms), motion, stepsFor, opts, dry}
 */
function createLive(k) {
  const W = k.width, H = k.height;
  const cursor = {
    x: (k.opts.cursorStart && k.opts.cursorStart[0]) || Math.round(W * 0.62),
    y: (k.opts.cursorStart && k.opts.cursorStart[1]) || Math.round(H * 0.66),
    shown: false,
  };
  let spotRect = null;

  const framesFor = async (frame) => {
    const f = k.frames;
    if (!frame || frame === 'auto') return f.list();
    if (frame === 'top') return f.list().filter((c) => f.isTop(c));
    if (frame === 'child') return f.children();
    if (frame.title) {
      const out = [];
      for (const ctx of f.children()) {
        const t = await f.ownerTitle(ctx).catch(() => '');
        if (t && t.indexOf(frame.title) !== -1) out.push(ctx);
      }
      return out;
    }
    throw new Error('unknown frame matcher');
  };

  /**
   * Finds a subject: {ctx, rect (top px), cx, cy} or null. Only VISIBLE
   * elements count, and a child frame counts only while its iframe renders.
   */
  const resolve = async (subject) => {
    if (subject && typeof subject.x === 'number' && typeof subject.y === 'number' && subject.text === undefined) {
      return { ctx: null, rect: { l: subject.x, t: subject.y, r: subject.x, b: subject.y }, cx: subject.x, cy: subject.y };
    }
    const expr = subjectExpr(subject);
    const probe = '(function(){var el=' + expr + ';if(!el||!__isVisible(el))return null;' +
      'window.__dsSubject=el;return __rectOf(el);})()';
    for (const ctx of await framesFor(typeof subject === 'string' ? 'top' : subject.frame)) {
      let local = null;
      try {
        await k.frames.ensureKit(ctx);
        local = await k.frames.evaluate(ctx, probe);
      } catch (err) { continue; }       // that frame is navigating; try the rest
      if (!local) continue;
      let off;
      try { off = await k.frames.offset(ctx); } catch (err) { continue; }   // frame not rendered
      const rect = toTopRect(local, off);
      if (rect.r < 0 || rect.b < 0 || rect.l > W || rect.t > H) continue;
      return { ctx: ctx, rect: rect, cx: Math.round((rect.l + rect.r) / 2), cy: Math.round((rect.t + rect.b) / 2) };
    }
    return null;
  };

  const need = async (subject, verb) => {
    const hit = await resolve(subject);
    if (!hit) throw new Error(verb + '() subject is not on screen: ' + describeSubject(subject));
    return hit;
  };

  /** True when `expr` is truthy in any matching frame (page state, not an element). */
  const holds = async (subject) => {
    for (const ctx of await framesFor(subject.frame)) {
      try {
        await k.frames.ensureKit(ctx);
        if (await k.frames.evaluate(ctx, '(function(){try{return !!(' + subject.until + ');}catch(e){return false;}})()')) return true;
      } catch (err) { /* navigating */ }
    }
    return false;
  };

  /**
   * Real-time wait (zero film time) for a subject to be on screen, or with
   * {until: 'expr', frame} for any page state to hold in a matching frame.
   */
  const waitForSubject = async (subject, o) => {
    const maxMs = (o && o.maxMs) || 20000;
    const started = Date.now();
    for (;;) {
      const hit = subject.until ? await holds(subject) : await resolve(subject);
      if (hit) return hit;
      if (Date.now() - started > maxMs) {
        throw new Error(((o && o.label) || 'waitFor') + ': ' + (subject.until ? 'until ' + String(subject.until).slice(0, 80) : describeSubject(subject)) + ' not on screen after ' + maxMs + 'ms');
      }
      await sleep((o && o.everyMs) || 200);
    }
  };

  // ---- cursor --------------------------------------------------------------
  const drawCursor = (x, y, press) => '__cursor(' + Math.round(x) + ',' + Math.round(y) + ',' + (press || 0).toFixed(3) + ')';

  const cursorTo = async (subjectOrHit, ms) => {
    const hit = subjectOrHit && subjectOrHit.cx !== undefined ? subjectOrHit : await need(subjectOrHit, 'cursorTo');
    const from = { x: cursor.x, y: cursor.y };
    const to = { x: hit.cx, y: hit.cy };
    const dur = ms || glideMsFor(Math.hypot(to.x - from.x, to.y - from.y));
    cursor.shown = true;
    await k.motion((t) => {
      const e = easeInOut(t);
      return drawCursor(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e, 0);
    }, k.stepsFor(dur), dur);
    cursor.x = to.x; cursor.y = to.y;
    // Real hover too, so menus and tooltips react the way they would.
    await k.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y });
    return hit;
  };

  const mouseClick = async (x, y) => {
    await k.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y });
    await k.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', buttons: 1, clickCount: 1 });
    await k.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', buttons: 0, clickCount: 1 });
  };

  /**
   * Clicks a subject for real. With the cursor on, it glides there first and
   * dips (filmed, ~170 ms); the real click fires after the dip, so a click
   * that navigates never tears down the page mid-animation.
   */
  const clickOn = async (subject, o) => {
    o = o || {};
    let hit = await need(subject, 'click');
    if (k.opts.cursor) {
      hit = await cursorTo(hit, o.glideMs);
      await k.motion((t) => drawCursor(hit.cx, hit.cy, Math.sin(Math.PI * t)), k.stepsFor(170), 170);
    }
    if (o.via === 'dom') {
      await k.frames.evaluate(hit.ctx, '(window.__dsSubject&&window.__dsSubject.click(),true)');
    } else {
      await mouseClick(hit.cx, hit.cy);
    }
    return hit;
  };

  const press = async (name) => {
    const nk = namedKey(name);
    await k.client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: nk.key, code: nk.code, windowsVirtualKeyCode: nk.keyCode, nativeVirtualKeyCode: nk.keyCode, text: nk.text || undefined });
    await k.client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: nk.key, code: nk.code, windowsVirtualKeyCode: nk.keyCode, nativeVirtualKeyCode: nk.keyCode });
  };

  /**
   * Types into a subject with real keystrokes: click to focus (cursor glide
   * when on), then one character per `charMs` of film (default 100 ms,
   * about 10 characters a second), each shot as its own frame so the text
   * visibly appears as typed. `o.clear` empties the field first.
   */
  const typeInto = async (subject, text, o) => {
    o = o || {};
    const hit = await clickOn(subject, { glideMs: o.glideMs });
    if (o.clear) {
      await k.frames.evaluate(hit.ctx, '(function(){var el=document.activeElement;' +
        'while(el&&el.shadowRoot&&el.shadowRoot.activeElement)el=el.shadowRoot.activeElement;' +
        'if(el&&el.select)el.select();return true;})()');
      await press('Backspace');
    }
    const chars = Array.from(String(text));
    const charMs = o.charMs || (o.ms ? o.ms / Math.max(1, chars.length) : 100);
    for (const ch of chars) {
      const evs = keyEventsFor(ch);
      if (evs) { for (const ev of evs) await k.client.send('Input.dispatchKeyEvent', ev); }
      else await k.client.send('Input.insertText', { text: ch });
      // A little real time per key lets the app's own handlers run between
      // characters, as they would for a person typing.
      if (!k.dry) await sleep(o.realMs || 35);
      await k.frame(charMs);
    }
    return hit;
  };

  /**
   * Scrolls a list the way a person does: the cursor glides onto `o.within`
   * (the scrolling list, e.g. a Setup listbox), then real mouse-wheel steps,
   * one filmed frame each, until `target` is visible. Throws if it never
   * shows (wrong list, or the label isn't there).
   */
  // Wheel scrolling is smooth (animated): the list keeps moving after the
  // last step. Film it until the target's box holds still, or a click aimed
  // at it lands rows away.
  const settle = async (target, o) => {
    let last = null;
    for (let i = 0; i < 40; i++) {
      const hit = await resolve(target);
      const key = hit ? [hit.rect.l, hit.rect.t].map(Math.round).join(',') : 'gone';
      if (hit && key === last) return true;
      last = key;
      if (!k.dry) await sleep(60);
      await k.frame((o && o.frameMs) || 70);
    }
    throw new Error('scrollTo(): ' + describeSubject(target) + ' never stopped moving');
  };

  const scrollTo = async (target, o) => {
    o = o || {};
    if (await resolve(target)) return settle(target, o);
    const box = await need(o.within, 'scrollTo');
    if (k.opts.cursor) await cursorTo(box, o.glideMs);
    const step = o.stepPx || 90;
    const maxSteps = o.maxSteps || 60;
    for (let i = 0; i < maxSteps; i++) {
      await k.client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.cx, y: box.cy, deltaX: 0, deltaY: step });
      if (!k.dry) await sleep(30);
      await k.frame(o.frameMs || 70);
      if (await resolve(target)) return settle(target, o);
    }
    throw new Error('scrollTo(): ' + describeSubject(target) + ' never came into view in ' + describeSubject(o.within));
  };

  // ---- spotlight on any frame's subject ------------------------------------
  const rectArgs = (r) => [r.l, r.t, r.r, r.b].map((v) => Math.round(v)).join(',');

  const spotOn = async (subject, ms) => {
    const hit = await need(subject, 'spot');
    spotRect = hit.rect;
    const dur = ms || 360;
    await k.run('window.__spotPad=' + (subject.pad === undefined ? 'null' : JSON.stringify(subject.pad)) + ';true');
    await k.motion((t) => '__spotRect(' + rectArgs(hit.rect) + ',' + t.toFixed(3) + ')', k.stepsFor(dur), dur);
    return hit;
  };

  const spotMoveTo = async (subject, ms) => {
    const hit = await need(subject, 'spotMove');
    spotRect = hit.rect;
    const dur = ms || 420;
    await k.run('window.__spotPad=' + (subject.pad === undefined ? 'null' : JSON.stringify(subject.pad)) + ';true');
    await k.motion((t) => '__spotGlideRect(' + rectArgs(hit.rect) + ',' + t.toFixed(3) + ')', k.stepsFor(dur), dur);
    return hit;
  };

  // ---- wording -------------------------------------------------------------
  const RANK = { visible: 3, covered: 2, hidden: 1, missing: 0 };

  /**
   * Where each label stands across ALL frames: the best status any frame
   * reports. A child frame's "visible" only counts while its iframe renders
   * and the label is not under a top-frame cover (the band).
   */
  const labelCheck = async (labels) => {
    const best = {};
    labels.forEach((l) => { best[l] = { label: l, status: 'missing', frame: null }; });
    let covers = [];
    const top = k.frames.top();
    for (const ctx of k.frames.list()) {
      let res;
      try {
        await k.frames.ensureKit(ctx);
        res = await k.frames.evaluate(ctx, '__labelCheck(' + JSON.stringify(labels) + ')');
        if (ctx === top) covers = (await k.frames.evaluate(ctx, 'window.__covers||[]')) || [];
      } catch (err) { continue; }
      let off = null;
      if (!k.frames.isTop(ctx)) { try { off = await k.frames.offset(ctx); } catch (err) { off = null; } }
      res.forEach((r, i) => {
        let status = r.status;
        if (!k.frames.isTop(ctx) && status === 'visible') {
          if (!off) status = 'hidden';
          else {
            const tr = toTopRect(r.rect, off);
            if (covers.some((c) => tr.t >= c.t && tr.b <= c.b && tr.l >= c.l && tr.r <= c.r)) status = 'covered';
          }
        }
        const label = labels[i];
        if (RANK[status] > RANK[best[label].status]) best[label] = { label: label, status: status, frame: k.frames.isTop(ctx) ? 'top' : 'child' };
      });
    }
    return labels.map((l) => best[l]);
  };

  const visibleTexts = async () => {
    const out = new Set();
    for (const ctx of k.frames.list()) {
      try {
        await k.frames.ensureKit(ctx);
        ((await k.frames.evaluate(ctx, '__visibleTexts(600)')) || []).forEach((t) => out.add(t));
      } catch (err) { /* frame went away */ }
    }
    return Array.from(out);
  };

  /** Redraws the cursor after a top-level navigation replaced the document. */
  const restoreCursor = async () => {
    if (k.opts.cursor && cursor.shown) await k.run(drawCursor(cursor.x, cursor.y, 0));
  };

  return {
    resolve, waitForSubject, cursorTo, clickOn, typeInto, press, scrollTo, spotOn, spotMoveTo,
    labelCheck, visibleTexts, restoreCursor,
    cursorState: () => ({ x: cursor.x, y: cursor.y, shown: cursor.shown }),
    lastSpotRect: () => spotRect,
  };
}

module.exports = {
  createLive: createLive, keyFor: keyFor, keyEventsFor: keyEventsFor, namedKey: namedKey,
  subjectExpr: subjectExpr, describeSubject: describeSubject, glideMsFor: glideMsFor, easeInOut: easeInOut,
};
