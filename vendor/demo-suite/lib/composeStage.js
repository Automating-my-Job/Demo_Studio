'use strict';
/**
 * composeStage.js — writes the compose stage: one self-contained page that
 * draws any instant of a plan (composePlan.js) as a pure function of time.
 * compose.js seeks it frame by frame (window.__render(ms)) and screenshots
 * each frame, so the film is deterministic and re-renders identically.
 *
 * Design (AGENTS.md §2, "Google-like"): a neutral canvas, the app in a
 * rounded window, a camera that pushes in on what is named, a soft ring
 * instead of a dimmed page, a dark pointer that arcs and ripples, short
 * kinetic titles in Google Sans Flex (OFL 1.1, bundled in assets/fonts),
 * and one hook and end-card design for every video. Brand tokens follow
 * revenue.opsgs.com and can be overridden per timeline.
 */
const fs = require('fs');
const path = require('path');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts', 'google-sans-flex');

const BRAND = {
  text: '#1d1d1f', text2: '#424245', text3: '#6e6e73', accent: '#0071e3',
  canvas: '#f5f5f7', canvasLight: '#ffffff', canvasDeep: '#e8e8ed',
  shadow: '0 24px 48px rgba(0,0,0,.10), 0 2px 6px rgba(0,0,0,.05)',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fileUrl = (p) => 'file://' + encodeURI(path.resolve(p));

/** The in-page renderer. Runs in the stage page only; P is the plan, C composePlan's exports. */
function stageMain(P, C) {
  const L = P.layout;
  const $ = (id) => document.getElementById(id);
  const scene = $('scene'), win = $('win'), ring = $('ring'), cursor = $('cursor'), ripple = $('ripple');
  const imgs = {};
  document.querySelectorAll('#win img').forEach((im) => { imgs[im.dataset.key] = im; });
  const titles = Array.from(document.querySelectorAll('.pill'));
  const hookWords = Array.from(document.querySelectorAll('#hook .w'));
  const endLines = Array.from(document.querySelectorAll('#end .line'));
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const ease = C.EASE;

  window.__render = function (t) {
    // Camera.
    const cam = C.sample(P.camera, t, P.cam0, C.MIX.cam);
    scene.style.transform = 'translate(' + (L.anchor.x - cam.cx * cam.s).toFixed(3) + 'px,' + (L.anchor.y - cam.cy * cam.s).toFixed(3) + 'px) scale(' + cam.s.toFixed(5) + ')';

    // The window: rises in, settles out.
    const wa = C.sample(P.windowAlpha, t, 0, C.MIX.num);
    win.style.opacity = wa.toFixed(4);
    win.style.transform = 'translateY(' + ((1 - wa) * 46).toFixed(2) + 'px) scale(' + (0.955 + 0.045 * wa).toFixed(4) + ')';

    // Stills: the current one fades in over the one before.
    let cur = null, prev = null, mix = 1;
    for (let i = 0; i < P.still.length; i++) {
      if (P.still[i].t > t) break;
      prev = cur; cur = P.still[i];
    }
    cur = cur || P.still[0];
    if (cur.fade && prev) mix = ease.standard(clamp01((t - cur.t) / cur.fade));
    Object.keys(imgs).forEach((k) => {
      const im = imgs[k];
      const on = k === cur.key ? mix : (prev && k === prev.key && mix < 1 ? 1 : 0);
      im.style.opacity = on.toFixed(4);
      im.style.zIndex = k === cur.key ? 2 : 1;
    });

    // Ring: a soft accent outline and a light veil, kept a constant size on screen.
    const rg = C.sample(P.ring, t, P.ring0, C.MIX.ring);
    const px = (v) => (v * L.k).toFixed(2) + 'px';
    const pad = 7 / cam.s;
    ring.style.display = rg.a > 0.004 ? 'block' : 'none';
    ring.style.left = (rg.rect[0] * L.k - pad).toFixed(2) + 'px';
    ring.style.top = (rg.rect[1] * L.k - pad).toFixed(2) + 'px';
    ring.style.width = ((rg.rect[2] - rg.rect[0]) * L.k + 2 * pad).toFixed(2) + 'px';
    ring.style.height = ((rg.rect[3] - rg.rect[1]) * L.k + 2 * pad).toFixed(2) + 'px';
    ring.style.borderRadius = (10 / cam.s).toFixed(2) + 'px';
    ring.style.boxShadow = '0 0 0 ' + (2.5 / cam.s).toFixed(3) + 'px rgba(0,113,227,' + (0.95 * rg.a).toFixed(3) + '),' +
      '0 0 0 ' + (8 / cam.s).toFixed(3) + 'px rgba(0,113,227,' + (0.14 * rg.a).toFixed(3) + '),' +
      '0 0 0 9999px rgba(29,29,31,' + (0.10 * rg.a).toFixed(3) + ')';
    void px;

    // Cursor and click ripple, in screen px (constant size under any zoom).
    const ca = C.sample(P.cursorAlpha, t, 0, C.MIX.num);
    const cp = C.toScreen(C.sample(P.cursor, t, P.cursor0, C.MIX.arc), cam, L);
    let press = 0, rip = null;
    P.presses.forEach((p) => {
      if (t >= p && t < p + 140) press = Math.sin(Math.PI * (t - p) / 140);
      if (t >= p && t < p + 520) rip = (t - p) / 520;
    });
    cursor.style.display = ca > 0.004 ? 'block' : 'none';
    cursor.style.opacity = ca.toFixed(3);
    cursor.style.transform = 'translate(' + (cp[0] - 4).toFixed(2) + 'px,' + (cp[1] - 3).toFixed(2) + 'px) scale(' + (1 - 0.12 * press).toFixed(3) + ')';
    if (rip !== null && ca > 0.004) {
      const e = ease.decel(rip), r = 8 + 30 * e;
      ripple.style.display = 'block';
      ripple.style.width = ripple.style.height = (2 * r).toFixed(2) + 'px';
      ripple.style.transform = 'translate(' + (cp[0] - r).toFixed(2) + 'px,' + (cp[1] - r).toFixed(2) + 'px)';
      ripple.style.opacity = (0.38 * (1 - rip)).toFixed(3);
    } else ripple.style.display = 'none';

    // Titles: words rise in one after another, then the pill fades.
    titles.forEach((el, i) => {
      const ti = P.titles[i];
      const inT = t - ti.t0, out = clamp01((t - ti.t1) / 220);
      if (inT < 0 || out >= 1) { el.style.display = 'none'; return; }
      el.style.display = 'flex';
      el.style.opacity = (clamp01(inT / 260) * (1 - ease.accel(out))).toFixed(3);
      el.querySelectorAll('.w').forEach((w, j) => {
        const u = ease.decel(clamp01((inT - 70 * j) / 420));
        w.style.opacity = u.toFixed(3);
        w.style.transform = 'translateY(' + ((1 - u) * 14).toFixed(2) + 'px)';
      });
    });

    // The hook: each word as it is spoken; it lifts away when the app arrives.
    if (P.hook) {
      const out = clamp01((t - P.hook.t1) / 420);
      const hk = $('hook');
      hk.style.display = out >= 1 ? 'none' : 'flex';
      hk.style.opacity = (1 - ease.accel(out)).toFixed(3);
      hk.style.transform = 'translateY(' + (-36 * ease.accel(out)).toFixed(2) + 'px)';
      const lk = $('lockup');
      if (lk) lk.style.opacity = ease.decel(clamp01(t / 500)).toFixed(3);
      hookWords.forEach((w, j) => {
        const u = ease.decel(clamp01((t - P.hook.words[j].t) / 380));
        w.style.opacity = u.toFixed(3);
        w.style.transform = 'translateY(' + ((1 - u) * 22).toFixed(2) + 'px)';
      });
    }

    // The end card: the same lockup and call to action on every video.
    if (P.end) {
      const ec = $('end');
      const inT = t - P.end.t0;
      ec.style.display = inT < 0 ? 'none' : 'flex';
      endLines.forEach((el, j) => {
        const u = ease.decel(clamp01((inT - 150 - 120 * j) / 600));
        el.style.opacity = u.toFixed(3);
        el.style.transform = 'translateY(' + ((1 - u) * 18).toFixed(2) + 'px)';
      });
    }
    return true;
  };

  // Hidden text never asks for its font: load it explicitly before frame 0.
  window.__ready = Promise.all([document.fonts.load('600 40px "GSF"'), document.fonts.load('400 40px "GSF"')].concat(Object.keys(imgs).map((k) => imgs[k].decode())))
    .then(() => document.fonts.check('600 40px "GSF"'));
}

/**
 * The stage page for a plan. stills: {key: absolute PNG path}. Returns HTML.
 */
function buildStageHtml(P, stills, brand) {
  const B = Object.assign({}, BRAND, brand || {});
  const L = P.layout;
  const font = fileUrl(path.join(FONT_DIR, 'GoogleSansFlex.ttf'));
  const css = [
    '@font-face{font-family:"GSF";src:url("' + font + '") format("truetype");font-weight:100 1000;font-stretch:25% 151%;}',
    '*{box-sizing:border-box;margin:0;padding:0}',
    'html,body{width:' + P.W + 'px;height:' + P.H + 'px;overflow:hidden;background:' + B.canvas + ';}',
    'body{font-family:"GSF",sans-serif;color:' + B.text + ';-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;}',
    '#bg{position:absolute;inset:0;background:radial-gradient(' + Math.round(P.W * 0.75) + 'px ' + Math.round(P.H * 0.8) + 'px at 50% 30%,' + B.canvasLight + ' 0%,' + B.canvas + ' 62%,' + B.canvasDeep + ' 100%);}',
    '#scene{position:absolute;left:0;top:0;width:' + P.W + 'px;height:' + P.H + 'px;transform-origin:0 0;}',
    '#win{position:absolute;left:' + L.win.x + 'px;top:' + L.win.y + 'px;width:' + L.win.w + 'px;height:' + L.win.h + 'px;' +
      'border-radius:18px;overflow:hidden;background:#fff;box-shadow:' + B.shadow + ',0 0 0 1px rgba(0,0,0,.06);opacity:0;}',
    '#win img{position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;}',
    '#ring{position:absolute;display:none;z-index:5;pointer-events:none;}',
    '.pill{position:absolute;left:0;right:0;bottom:' + L.pillBottom + 'px;display:none;justify-content:center;z-index:20;}',
    '.pill span.box{display:inline-flex;gap:.28em;padding:.42em .95em;border-radius:999px;background:rgba(255,255,255,.94);' +
      'box-shadow:0 10px 30px rgba(0,0,0,.10),0 0 0 1px rgba(0,0,0,.05);font-weight:600;font-size:' + L.titlePx + 'px;line-height:1.15;letter-spacing:-.01em;}',
    '.w{display:inline-block;}',
    '#hook{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:28px;z-index:10;text-align:center;padding:0 7%;}',
    '#hook .q{font-weight:650;font-size:' + L.hookPx + 'px;line-height:1.08;letter-spacing:-.025em;display:flex;flex-wrap:wrap;justify-content:center;gap:0 .26em;}',
    '#lockup{font-weight:600;font-size:' + Math.round(L.hookPx * 0.34) + 'px;color:' + B.accent + ';letter-spacing:.01em;}',
    '#end{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:' + Math.round(P.H * 0.028) + 'px;z-index:30;text-align:center;padding:0 6%;}',
    '#end .lockup{font-weight:700;font-size:' + Math.round(L.hookPx * 0.8) + 'px;letter-spacing:-.025em;}',
    '#end .by{font-weight:500;color:' + B.text3 + ';}',
    '#end .sub{font-weight:400;font-size:' + Math.round(L.titlePx * 0.82) + 'px;color:' + B.text2 + ';}',
    '#end .cta{font-weight:600;font-size:' + Math.round(L.titlePx * 0.9) + 'px;color:#fff;background:' + B.accent + ';padding:.5em 1.15em;border-radius:999px;margin-top:' + Math.round(P.H * 0.012) + 'px;}',
    '#end .url{font-weight:500;font-size:' + Math.round(L.titlePx * 0.86) + 'px;color:' + B.text + ';}',
    '#cursor{position:absolute;left:0;top:0;width:34px;height:42px;z-index:40;display:none;transform-origin:4px 3px;filter:drop-shadow(0 3px 5px rgba(0,0,0,.28));}',
    '#ripple{position:absolute;left:0;top:0;border-radius:50%;background:' + B.accent + ';z-index:39;display:none;}',
  ].join('\n');

  const stillTags = Object.keys(stills).map((k) => '<img data-key="' + esc(k) + '" src="' + fileUrl(stills[k]) + '" alt="">').join('');
  const pills = P.titles.map((ti) => '<div class="pill"><span class="box">' +
    String(ti.text).split(/\s+/).filter(Boolean).map((w) => '<span class="w">' + esc(w) + '</span>').join('') + '</span></div>').join('');
  const hook = P.hook ? '<div id="hook">' + (P.hook.lockup ? '<div id="lockup">' + esc(P.hook.lockup) + '</div>' : '') +
    '<div class="q">' + P.hook.words.map((w) => '<span class="w">' + esc(w.w) + '</span>').join('') + '</div></div>' : '';
  const end = P.end ? '<div id="end">' + P.end.lines.map((l) => {
    const cls = l.style || 'sub';
    if (cls === 'lockup' && l.by) return '<div class="line lockup">' + esc(l.text) + ' <span class="by">' + esc(l.by) + '</span></div>';
    return '<div class="line ' + esc(cls) + '">' + esc(l.text) + '</div>';
  }).join('') + '</div>' : '';
  // A soft dark arrow with a white rim: visible on light UI, never a system cursor.
  const cursorSvg = '<svg id="cursor" viewBox="0 0 34 42" width="34" height="42"><path d="M4 3 L4 33 L11.5 25.5 L17 38 L22.5 35.6 L17 23.5 L27.5 23.5 Z" ' +
    'fill="' + B.text + '" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/></svg>';

  const planSrc = fs.readFileSync(path.join(__dirname, 'composePlan.js'), 'utf8');
  return '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body>' +
    '<div id="bg"></div><div id="scene"><div id="win">' + stillTags + '<div id="ring"></div></div></div>' +
    hook + pills + end + '<div id="ripple"></div>' + cursorSvg +
    '<script>var module={exports:{}};\n' + planSrc + '\nvar __C=module.exports;</script>' +
    '<script>(' + stageMain.toString() + ')(' + JSON.stringify(P) + ',__C);</script>' +
    '</body></html>';
}

module.exports = { buildStageHtml, BRAND, FONT_DIR };
